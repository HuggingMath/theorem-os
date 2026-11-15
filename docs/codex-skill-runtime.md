# Skill research mode

This branch introduces an opt-in, single-researcher mode. A native agent harness executes research and tools; a project skill supplies methods. The existing host keeps the frozen problem, source policy, resource accounting, writer shutdown, independent Lean acceptance and persistent artifacts. Existing cooperative and independent runs retain their original configuration and resume checks. The CLI supports Codex, Claude Code and OpenCode through the shared session contract; see [native harness configuration and verified boundaries](harness-portability.md).

## Start and resume

Build the runtime normally with `bun run build --state-root EXTERNAL_BUILD_DIRECTORY`. Use its manifest when preparing a **new** isolated run:

```sh
bun bin/math.ts run --research-mode skill \
  --workspace NEW_PROBLEM_WORKSPACE --task-file TASK_FILE \
  --output NEW_RESULT_FILE --build-manifest BUILD_MANIFEST
```

`--research-mode skill` implies one worker and independent coordination. Explicit incompatible worker, coordination, scheduler, module-plan and plan-approval settings are rejected. All existing time, turn and token budget options apply; their unlimited defaults are preserved. There is no task DAG, fixed research slice, progress-based topic rotation or automatic library tactic application in this mode.

The normal `--resume` command inherits the saved research mode and skill loading choice. It continues the saved native thread when the frozen contract permits. Mode, skill content, loading mode, provider, environment and other frozen identities cannot be changed in place. A different strategy starts a new run and thread from saved artifacts.

The default `--skill-loading native` checks Codex discovery and sends native skill input. `--skill-loading file` explicitly directs Codex to read the same pinned file. An unsupported native operation never silently switches modes. Native discovery and an accepted request do not prove that a particular provider read or followed the skill; that requires separate execution evidence.

## Skill and host responsibilities

`skills/theoremos-research/SKILL.md` contains stable research methods with references loaded as needed. It has no specific problem answers or universal task graph. The full directory, including references, participates in build and run identity. A run gets its own copy under `.agents/skills/theoremos-research`; the host checks its identity before dispatch and after writer shutdown. Only a host-pinned projection is allowed by source ownership. Legacy runs do not gain a new editable directory.

First installation copies into advisory scratch, checks the complete directory identity, freezes its files and atomically moves it into the final location. An interrupted copy leaves no partially installed skill, so a restart can retry. An existing installed projection with changed bytes is still rejected rather than overwritten.

Precise command examples are generated at `.scratch/theoremos-help.md`, using the existing local-help implementation. References route to this help and existing command `--help`; they do not maintain a second tool registry. Research sources, probes and public notes stay in the existing worktree and scratch storage. Internal chain of thought is neither required nor treated as an artifact.

Normal turn completion saves source and notes after confirmed writer shutdown. Native resume, request recovery, compaction handling, leases, cumulative usage and the existing dispatch budget remain shared infrastructure. A missing shutdown confirmation quarantines that workspace before any new writer, freeze or acceptance. Unfinished original proofs do not trigger a full original-target compilation after every research turn. A complete candidate still goes through the original strict check and S3 evaluation of **every** frozen original target.

After the frozen research responsibility has actually been dispatched to a native thread, later turns in the same host process use a compact continuation instead of repeating the full task and statement. Current source/check feedback, declaration feedback and saved-work references remain present; the developer source and acceptance rules are unchanged. The first dispatch, a new responsibility/thread, the first dispatch after native context compaction and the first dispatch after a host restart all retain the full task. Both standalone skill and common-guidance comparison paths use this behavior and the existing context byte accounting.

After confirmed writer shutdown, the host durably records `pendingResearchFreeze` before committing sources. It binds the prior HEAD, owned-source digest, problem receipt and environment. Recovery accepts only those unchanged source bytes at the prior HEAD or its single host checkpoint, then completes freezing and check delivery before admitting another model turn. A crash after the source commit but before creating a pending proof check therefore does not require another model turn. An unconfirmed writer stop still quarantines the workspace.

Complete original candidates also acquire a host-owned `pendingProofCheck` after writer shutdown and source freeze, before helper processing or original-target verification. It binds the commit, owned-source digest, problem receipt and environment. Resume completes any pending helper processing and verifies the frozen original candidate before admitting another model turn, even after the turn/token allowance is exhausted. Verification checkpoints retain their normal retry allowance; unavailable verification or host storage errors retain the candidate. A deterministic mathematical rejection clears this pending check and returns its feedback for correction. Persisted successful acceptance can finish pending cleanup without repeating verification; a changed candidate or environment is rejected.

## Independent declaration artifacts

To preserve a reusable helper before the whole problem is solved, the researcher writes `.scratch/declaration-submission.json`, then stops editing and returns:

```json
{
  "declarations": [
    {
      "file": "Submission.lean",
      "name": "Qualified.helper",
      "type": "COMPLETE_CLOSED_LEAN_TYPE"
    }
  ]
}
```

The request accepts up to 32 declarations, with optional descriptions and explicit premises. The host confirms writer shutdown, freezes actual bytes, checks the exact declaration and full type in an isolated projection, and preserves source, environment, checked commit, Lean receipts and references. Other original goals can remain unfinished. A helper depending on their unproved bodies or on new axioms cannot acquire unconditional evidence. Ordinary diagnostics remain advisory.

Successful evidence is stored in the host runtime directory's `declarations.json`; feedback goes to `.scratch/declaration-feedback.json`. Invalid submissions and failed proofs receive correctable feedback. Cancellation, resumable verification checkpoints and unavailable environments retain the request and their distinct failure meaning. Resume rechecks the frozen commit and request bytes before any new model admission, even when the model turn or token budget is exhausted. If that candidate also completes the original problem, the host checks all original targets in the same recovery without another model turn. An independent helper does not mark the original problem accepted.

Small archives keep the v1 manifest. When the next write would exceed 4096 records or 32 MiB, the host preserves the records in content-addressed segments and atomically publishes a v2 root in `declarations.json`. Each segment retains both limits and its run/problem/environment identity; the reader verifies its digest, record count and unique record identities. Segment persistence precedes root replacement, so an interrupted append leaves the previous archive readable and can be retried. The writer can migrate an old v1 count overflow that still fits within 32 MiB; an already oversized legacy file or a single oversized record remains an explicit storage error. Historical records in either format still require fresh consumer checks.

After successful host persistence, consumption is marked completed in host-owned state before removing the request. Recovery can finish either side of that removal without repeating completed verification. A missing request is permitted only for that saved completion phase; changed source or an existing request with changed bytes remains an error. The worker-editable feedback file cannot grant completion. Host evidence-storage failures retain the pending request and propagate as infrastructure failures instead of being consumed as mathematical rejections.

Only explicitly classified submission-content errors and deterministic proof failures produce correctable rejection feedback. Host filesystem, Git, source-integrity and verifier-initialization exceptions propagate with the pending request retained; they do not consume the helper or start a mathematical correction turn.

The existing knowledge interface imports this sidecar alongside legacy cooperative records:

```sh
bun bin/math.ts knowledge build --state RESULT.runtime/state.json \
  --output NEW_CATALOG --report NEW_IMPORT_REPORT
```

Catalog records retain their complete source and provenance, are labeled recorded evidence, and require a fresh check in each consumer. `inspect` and the Web observation types understand the new mode without creating fake tasks, routes or Lead progress. Declaration inspection reports recorded evidence, not fresh acceptance. Library extraction without a legacy canonical record continues to require an explicit commit.

## Continue from old research

For a new skill run, `--continuation-source-run OLD_RESULT_OR_STATE` uses the single-researcher importer. It pins the old canonical commit, preserves worker drafts, research notes, old costs, inherited attachments and historical proof snapshots separately, and freshly checks available helpers. It does not inherit old threads, worker assignments, budgets, task states or acceptance flags. Old material remains intact. A failed or conditional historical claim remains advisory.

Initialization can resume from its frozen capture after interruption. It rejects changed destination research or configuration instead of overwriting new work. Live source drafts are captured with explicit stability checks and labeled as separate observations, not as a globally atomic snapshot. This command does not stop or migrate the old run.

## Comparison and rollout status

`compare --skill-baseline native|file --phase prepare ...` replaces the legacy single arm with skill research. Preparation freezes skill identity in the plan and launch files without starting a model. The existing independent and cooperative arms share the planned model, tools, environment and total token allowance. Reports retain all planned attempts and missing usage.

The `--skill-baseline` comparisons remain **system-mode** comparisons: legacy prompts contain additional mathematical guidance, so `commonGuidanceFrozen` and `strategyIsolation` are false. `--common-research-skill native|file` instead pins the same mathematical skill and minimal host contracts in all three arms. This isolates host strategy choices while preserving their actual coordination and delivery protocols. `--dataset lean-task --source-file FILE --task-file FILE` admits a frozen local statement without importing old answers or human-assisted research history. Plans, launches and reports retain the guidance, model, provider, effort, environment, knowledge and total resource identities. One diagnostic problem establishes that the comparison runs; it cannot establish an efficiency advantage.

Comparison preparation and solver startup share resource binding for the retrieval corpus, installed mathematics tools and proof-search backend before computing the environment digest. Changed pinned resource bytes remain an error. The first preregistered three-arm diagnostic exposed the previous missing tools binding: all three observations were rejected for an environment identity mismatch and had already stopped at their dispatch allowance. Their frozen plan and raw report remain unchanged. Observed consumption was 8,733 tokens for skill, 17,583 for independent and 11,285 for cooperative; these are costs of invalid attempts, not accepted comparison results. The repair is checked with disposable startup processes without rerunning the observed paid sample.

The existing cooperative engine and readers remain supported. Native child delegation is a separate capability. Codex 0.167.2's V1 spawn handler inherits the parent's active write permission even when the role file requests a read-only profile. A local fixed-response experiment exercised actual spawning and verified this behavior without contacting a model. The public `--skill-delegation read-only` request therefore fails with `math_native_read_only_delegation_unsupported` before creating a native session or admitting a provider request. No writable substitute is selected. The unactivated candidate and native evidence are retained outside the runtime for review.

## Web workflow

New Web proof requests can select skill research and native/file loading. Creation validates one researcher, independent coordination and the absence of a cooperative module plan or plan approval. Saved drafts, requests and actual solver configuration preserve the selection and pinned skill identity. Legacy remains the default. The Docker source stage includes the complete skill directory in both Web and worker images.

The skill view displays the actual researcher and independent declaration source, full type, premises, checked commit, environment and receipt references. Recorded evidence requires a fresh consumer check; it never turns an unfinished original goal into an accepted result. Large declaration collections have an explicit byte allowance and report omitted records. Plan, cooperative guidance and approval actions are unavailable in this mode and are rejected before writing messages. Capture and archive remain supported. All context builders use the host-projected agent tool bundle, including when Docker hides application source.

## Completion and rollout status

| Work | Verified result | Remaining boundary |
| --- | --- | --- |
| Actual skill execution | An isolated real provider read the pinned native/file skill and reference, reproduced their hashes and a fresh tag, resumed each saved thread, and confirmed all four stops. A separate native compaction also completed. | Raw reports retain their captured runtime hashes. Subsequent delegation guard changes are covered by local regressions; the reports are not relabeled as a test of different bytes. |
| Process recovery and context continuity | Ten isolated Linux process-death cases cover preparation, request acknowledgment, tool writes, freeze, pending helper verification, both declaration-consumption windows and complete original candidates before/after independent verification, using actual SIGKILL, flock, adapter processes and durable state. A separate SIGKILL case interrupts first skill projection. Unknown usage blocks replay; pending helpers and original candidates use real Lean. | Protocol peers control model responses; this is not a prolonged paid-provider resilience benchmark. |
| Knowledge consumption | Three real Lean cases exercise a separate consumer searching, reading, adapting and independently checking a saved declaration, including rejection of changed premises and stale evidence. | A measured research-performance gain from transferred knowledge still needs a matched experiment. |
| Fair comparisons | Common mathematical guidance and generic frozen Lean input are implemented with frozen plans, launches and reports. After the resource-binding repair, a fresh prepare and three actual startup-only runs have matching environment identities and zero model turns. The original invalid diagnostic and its actual costs remain recorded separately. | No repaired paid comparison has been run. A single diagnostic does not support an efficiency claim or default selection. |
| Native delegation | Actual local native spawning established V1 child counting and exposed inherited write permissions. Unsupported read-only delegation is rejected before any model call. | Blocked on a backend that enforces a child permission subset; this feature is not enabled. |
| Web workflow | Creation, draft restoration, configuration freezing, declaration display, supported controls and translated desktop/mobile browser flows are covered. A private image derived from an immutable baseline rebuilt the branch's headless runtime and agent tools; native/file startup-only, statement elaboration and pinned skill projection pass. A separate offline probe runs the image's actual Codex 0.162.0 and adapter: native discovery, both actual shell readbacks, bundled tool usage and confirmed stops pass with application source hidden. | The packaged probe binds that immutable image, before the later recovery fixes. Its provider replies are fixed loopback data; actual provider authentication, metered relay behavior and mathematical performance inside the image remain untested. |

The single researcher currently shares `research.ts` with the legacy engine while bypassing cooperative state and strategy scheduling. Extracting a smaller loop is a possible follow-up when coupling creates a concrete maintenance cost; duplicating recovery and accounting is not a completion requirement. Retiring old strategy code remains conditional on comparison results and the absence of supported consumers.

## Verification

Focused tests exercise native skill requests and discovery errors, full-directory identity, CLI opt-in/resume, writer quarantine, declaration delivery, helper import, old-run continuation, inspection and comparison identity. Declaration tests include real isolated Lean verification for successful helpers and rejection of incorrect types, dependence on unproved goals and unapproved axioms. Ordinary regressions use protocol peers and disposable workspaces. Explicit provider acceptance is a separate opt-in script, `scripts/mathematics/validateSkillProvider.ts`, with per-round request/token accounting, missing-usage rejection, estimated in-flight reservation and readback evidence. An observed dispatch allowance is not a hard cap on tokens generated by a request already in flight.

The implementation also runs the affected legacy acceptance, proof-ready, budget, knowledge and continuation regressions and the four-bundle headless build. Full-repository type checking passes after fixing the optional archive asset existence check, observation coverage fixture values and unused declarations in `scripts/test-classic-global-trajectory.ts` and `scripts/test-web-proof-map.ts`. A separate check of the CLI/runtime/mathematics source surface also verifies this branch's headless types.
