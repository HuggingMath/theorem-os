# Native AgentControl stdio v1

The patched official Codex app-server retains its native collaboration handlers.
Only `THEOREMOS_HOST_AGENT_CONTROL=1` installs this host transport. Children run
in separate host-owned processes and filesystem namespaces. A missing handshake
fails startup; the runtime does not fall back to model dynamic collaboration tools.

## Client endpoints

All methods require the initialized experimental API connection. Requests and
responses below are JSON-RPC payloads, without the outer `id`/`result` envelope.

| Method | Params | Response |
| --- | --- | --- |
| `theoremos/agentControl/capabilities` | `{}` | `{version:1,backend:"theoremos-host",nativeTools:true,isolatedChildBootstrap:true}` |
| `theoremos/agentControl/snapshot` | `{threadId}` | `{sessionId,agent,configSnapshot}` |
| `theoremos/agentControl/start` | `{version:1,bootstrap,thread?:ThreadStartParams,resume?:ThreadResumeParams}` | Normal native start/resume fields, plus `agentControl:{sessionId,agent,configSnapshot}` |
| `theoremos/agentControl/input` | Input below | `{threadId,submissionId,accepted:true,turn:{id,status:"inProgress",items:[]}|null}` |
| `theoremos/agentControl/update` | Update below | `{acceptedSequence}` |

Start requires exactly one of `thread` and `resume`. It creates or resumes an idle
child without a model call or initial task. The host registers usage/completion
observers before sending input. Resume reads the child's persisted history;
it never replays the bootstrap's copied fork history. Its persisted thread,
session and source must match the captured bootstrap. This explicit transport
loads the child in its own process rather than attaching through a locally
loaded parent. Ordinary `thread/resume` retains the upstream parent-owned guard.
Root start/resume retain
normal upstream endpoints, followed by `snapshot` to bind their actual identity.

`agent` is native `{threadId,metadata,status}`. Metadata is
`{agentId,agentPath,agentNickname,agentRole}`. `configSnapshot` is the actual
native effective worker snapshot; hosts forward it opaque in spawn receipts.
It is not a host prediction of worker configuration.

## Bootstrap

Rust exports `NativeChildBootstrap` from the prepared native SpawnRequest. It
captures session/source identity, model/reasoning/service-tier/instruction
settings, user/thread instruction snapshots, native filtered fork history and
provenance, execution policy and managed source requirements, environment
requests, inherited dynamic tools, disabled plugins, and originator. It never
serializes `Config`, auth, provider URLs/settings, or relay capabilities. The
child uses its own destination provider/profile.

The trusted host reserves `bootstrap.threadId`. Only `bootstrap.hostOverrides`
may replace `cwd`, `environments`, `developerInstructions`, `dynamicTools`, or
further restrict `permissionProfile`. It also accepts an explicit
`workspaceRelocation:{from,to}` capability. `from` must equal captured
`bootstrap.config.cwd`, and `to` must equal the destination effective cwd.
The importer removes the captured source workspace write grants, moves workspace
authority to `to`, removes captured ancestor denies obstructing that namespace
binding, retains other denies/network restrictions, then intersects with the
destination profile. The destination's peer/secret denies remain effective.
This is a trusted host action; model spawn arguments cannot supply overrides.
OS namespace/bind isolation remains the host's responsibility.
Applying this computed permission intersection clears the destination's named
active-profile identity under upstream semantics. A child may therefore report
no `activePermissionProfile` ID; `configSnapshot.permissionProfile` carries the
actual effective authority. Ordinary root profile checks are unaffected.

`bootstrap.config.networkPolicy` captures only the official traffic-policy DTO,
including domain/socket rules, never local proxy URLs or credentials. If the
parent had a proxy policy, the destination must provide the same traffic policy.
Missing or different policies fail explicitly; this version does not infer
subset relationships between different wildcard allowlists. The child's local
proxy setup remains destination-owned. Filesystem relocation cannot discard
parent network denials.

The destination ignores its user/project exec-policy files when importing the
captured parent policy. The Lead's policy loader is unchanged, and its captured
user/project rules travel with the snapshot. Official managed-source compatibility
and requirement checks still run. Extra destination system `.rules` files are
rejected by the upstream inherited-policy contract, not silently skipped.
Captured instructions replace parent snapshots while repository instructions are
discovered in the destination worktree. Dynamic tools use upstream normalization
and retain their host execution routes. Native child startup installs root-capability
restrictions and gets the shared session identity from its attached controller.
Cold resume restores the persisted identity; upstream rejects a mismatch with the
attached controller. The ordinary host-root `InheritedSessionId` guard is unchanged.

## Native input

```ts
type Input = {
  version: 1;
  threadId: string;
  author: string; // canonical native AgentPath
  input:
    | {kind:"userInput";items:UserInput[]}
    | {kind:"message";message:{kind:"plaintext"|"encrypted";text:string};
       mode:"queueOnly"|"triggerTurn"}
    | {kind:"communication";communication:InterAgentCommunication};
  startOptions?: {
    parentTurnId?:string;rootTurnId?:string;turnTrigger?:string;
    initiatingAgentPath?:string;finalOutputJsonSchema?:unknown;serviceTier?:string;
  };
  contextItems?: ResponseItem[];
  expectedTurnId?:string;
};
```

The transport holds a per-thread operation lock, injects context items, and uses
native turn acceptance. Triggered messages preserve native attribution and return
the real started/steered turn ID. `expectedTurnId` steers only that active turn;
it cannot start an idle replacement. Queue-only input is enqueued without starting
a model turn and returns `turn:null`. The raw communication variant preserves the
official completion formatter and avoids wrapping it as a new plaintext task.
When a trusted native trigger starts an idle recipient, previously accepted
mailbox items precede the trigger in its first model request. Ordinary user-input
turns retain upstream sampling and pending-input behavior.

## Host callbacks

Server request `theoremos/agentControl/request`:

```ts
{version:1,sessionId:string,threadId:string,operationId:string,
 operation:string,payload:unknown}
```

Every operation gets a fresh UUID `operationId`; the host retains it across
uncertain publication/recovery. Every successful callback response is
`{result:unknown}`. Errors are JSON-RPC errors.

| Operation | Payload | `result` |
| --- | --- | --- |
| `attach` | `{threadId,sessionId}` | `{sessionId}` |
| `resolve` | `{caller,parent,source,target}` | `{threadId}` |
| `spawn` | `{caller,source,bootstrap,input,startOptions}` | `{agent,configSnapshot,submissionId}` |
| `send` | `{caller,target,input,startOptions}` | `{threadId,metadata,submissionId}` |
| `ensureChildLoaded` | `{parent,child}` | `{}` |
| `interrupt` | `{caller,target,version}` | `{kind:"loaded",agent,configSnapshot}` or `{kind:"unloaded",metadata}` |
| `list` | `{caller,parent,source,pathPrefix}` | `{agents}` |
| `childPaths` | `{parent}` | `{paths}` |
| `admitTurn` | `{threadId,turnId}` | `{admitted:true}` |
| `releaseTurn` | `{threadId,turnId}` | `{}` |
| `recordUsage` | `{threadId?,turnId?,usage,codexRolloutBudgetUnits}` | `{}` |
| `turnFinished` | `{outcome,parentThreadId?,completionMessage?}` | `{}` |
| `configUpdate` | `{serviceTier}` | `{}` |

`target` is `{kind:"id",threadId}` or `{kind:"reference",reference}`.
Rust canonicalizes references and list prefixes with the official
`AgentPath::resolve`; the host validates registered membership in the same tree.
`source`, status, `TokenUsage`, and communication retain upstream serde shapes.
Rollout budget units travel separately because native TokenUsage skips them in
serde. Native admission is asynchronous before task execution and its official
guard owns `releaseTurn`; root and child turns use the same host authority.
No token/time budget is added by this adapter.

`outcome` contains native `threadId`, `turnId`, `source`, `parentTurnId`,
`initiatingAgentPath`, `status`, and `errorInfo`. `completionMessage` is an
upstream `InterAgentCommunication` object rendered by the official completion
formatter. It is already attributed and queue-only. Ordinary interruptions do
not emit upstream terminal result callbacks; their execution guard still drops.
The native terminal event precedes the callback, so the host must await the
matching completion handoff and guard release before freezing a finished writer.

Spawn retains provisional process ownership until the initial input receipt.
Cancellation before acceptance reaps the provisional child; cancellation after
acceptance does not retract its work. Follow-up input cannot target the root.
Unloaded interrupt observations preserve known identity and never mean completed.
The host routes child resume to its own app-server process, because a foreign
thread cannot be loaded through the parent's local ThreadManager.

## Mailbox/shared updates

```ts
{version:1,sessionId,threadId,sequence,
 mailbox?:Array<{id,author,recipient,
   message?:{kind:"plaintext"|"encrypted",text},
   communication?:InterAgentCommunication}>,
 serviceTier?:string|null,admission?:{allowed:boolean,reason?:string}}
```

A native communication must match the envelope's author/recipient and be
queue-only. The runtime holds the synchronous mailbox and watch subscription.
An acknowledged sequence transfers ownership; repeats never enqueue mail twice.
The host persists accepted/uncertain states and does not label accepted mail read
or replay an uncertain worker task as new work. A sequence covers a complete
validated batch. An update can clear the shared service tier with explicit null.

Native output is research output. Lean verification, proof delivery, source
freezing, adoption, and mathematical acceptance stay in TheoremOS host tools.
