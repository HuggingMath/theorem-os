# Configurable headless CLI harness

Use `--harness cli` for a headless agent executable beyond the built-in Codex, Claude Code and OpenCode adapters. One `cli.json` describes its command, input and output; the host calls the executable directly with an argv array. This is a command adapter, with no shell interpolation, plugin loader or additional agent workflow engine.

The executable must accept a noninteractive request and terminate when its work ends. For autonomous proof research it also needs the ability to read the pinned Skill, edit the owned files and run the supplied Lean commands. An interactive-only terminal application needs its own headless wrapper. The adapter does not give an executable tools it does not have.

## Start a run

Create a dedicated profile directory outside the proof workspace and save this minimal `cli.json` in it:

```json
{
  "schema": "theorem-os.cli-harness.v1",
  "executable": "/absolute/path/to/your-agent",
  "args": ["--model", "{model}"],
  "prompt": "stdin",
  "session": { "mode": "fresh" },
  "output": { "format": "text" },
  "efforts": ["none"]
}
```

Adapt `args` to the actual executable, then use the normal solver command:

```sh
bun bin/math.ts run --harness cli --harness-profile DEDICATED_PROFILE \
  --model YOUR_MODEL --effort none \
  --workspace NEW_WORKSPACE --task-file TASK_FILE \
  --output RESULT_FILE --build-manifest BUILD_MANIFEST
```

`--harness-executable` optionally overrides `executable`. The CLI harness defaults to a solo researcher with file-loaded Skill guidance. Build the standalone runtime with an external `--state-root` and use its build manifest. Web operators can configure the same backend. Sealed formalization and audit roles retain their stronger isolation requirement. See [complete workflows](portable-workflows.md).

## Input and session contract

The prompt combines host instructions, pinned Skill paths and the current task. `prompt: "stdin"` writes it to stdin and closes stdin. `prompt: "file"` writes a private file under `.scratch/cli-prompts` and requires `{promptFile}` in the command. `prompt: "argument"` supplies `{prompt}` as one argv value; OS argument length limits apply. Arguments are never split or evaluated as shell code.

| Session mode | Initial command | Subsequent command | Research context |
| --- | --- | --- | --- |
| `fresh` | `args` | `args` again | Full frozen task every time, with current sources and research notes |
| `generated` | `args` + `startArgs`, with a host UUID in `{sessionId}` | `args` + `resumeArgs`, with the exact saved ID | Native session continuity; full task after a host restart |
| `reported` | `args` + `startArgs`; bind the configured output session ID before publishing the turn | `args` + `resumeArgs`, with the exact saved ID | Native session continuity; full task after a host restart |

Native `resumeArgs` must include `{sessionId}`. A reported session additionally requires `output.sessionId`; a generated session requires `{sessionId}` in `startArgs`. A mismatched reported ID fails the turn. There is no implicit resume of the latest session.

Supported template values are `{model}`, `{effort}`, `{profile}`, `{workspace}`, `{prompt}`, `{promptFile}`, `{sessionId}` and `{turnId}`. They work in args and configured environment values. Every initial and resumed command must bind `{model}`. `efforts` defaults to `["none"]`; include `{effort}` and list actual supported levels to expose reasoning control. Unsupported effort levels fail before dispatch.

## Structured output and usage

`output.format` accepts `text`, `json` or `jsonl`. JSONL requires one JSON value per nonempty line, with logs on stderr. The adapter reads through process exit, then settles usage once. It never adds repeated final frames as separate requests.

Fields use RFC 6901 JSON Pointers, including `~1` for `/` and `~0` for `~`. Optional `when` is one `{ "field": POINTER, "value": PRIMITIVE }` equality or an array of equalities that must all match. There are no evaluated expressions. For example:

```json
{
  "format": "jsonl",
  "sessionId": { "field": "/session/id", "when": { "field": "/kind", "value": "init" } },
  "text": { "field": "/result/text", "when": { "field": "/kind", "value": "final" }, "mode": "replace" },
  "usage": {
    "when": { "field": "/kind", "value": "final" },
    "inputTokens": "/stats/input",
    "outputTokens": "/stats/output",
    "cachedInputTokens": "/stats/cached",
    "scope": "turn",
    "completeness": "partial"
  },
  "failures": [{
    "when": [{ "field": "/kind", "value": "final" }, { "field": "/status", "value": "error" }],
    "reason": "invalid-request"
  }]
}
```

Choose `usage.scope: "turn"` for invocation totals and `"session"` for cumulative totals preserved across native resume. Session totals are unavailable in `fresh` mode. Input tokens must already include cached input; cached and reasoning counters are subsets, not additional tokens. `lastInputTokens`, when provided, must describe the latest individual request, rather than the sum of a multi-request turn.

Usage defaults to `completeness: "partial"`. Set `"complete"` only when the native command accounts for all its requests, including child/background work, in the selected final record. Missing, partial, malformed or zero input/output counters make usage unknown. A finite token budget then blocks further model dispatches; it still permits pending proof checks. These are observed turn limits, with possible in-flight overshoot, rather than provider-request admission.

Configured terminal failure classes are `authentication`, `context`, `rate-limit`, `request` and `invalid-request`. Match terminal events specifically: a recoverable tool error must not fail the whole research turn. A matching terminal failure retains its classification even when the command exits nonzero, so the host applies the corresponding stop or recovery policy. A nonzero exit without a classified failure produces `math_cli_command_failed` and stops automatic retry. Raw stderr and provider error text are not copied into saved diagnostics.

## Configuration and isolation

`environment` maps explicit native environment values, for example `"HOME": "{profile}/home"`. `inheritEnvironment` lists existing process variables needed by that command, for example an API key or endpoint. CLI-only inherited values are excluded from host Lean environment records. Credentials should enter through `inheritEnvironment`, not literal config or argv values. Non-secret inherited values participate in the launch identity; recognized credential names may rotate. Runtime-owned environment names are reserved.

`configurationFiles` lists existing relative files under the profile whose bytes must remain frozen, such as native settings. The host pins these files, `cli.json`, executable path/bytes and non-secret inherited environment before dispatch, source freezing and resume. Session/cache files can grow. Put every native settings file that affects execution in this list and disable undesired native project/global discovery in the native configuration.

Execution requires Linux bubblewrap. The host root is read-only; the proof worktree and dedicated profile are writable. HOME defaults to the dedicated profile, XDG state stays there, temporary files stay in the worktree, protected roots and host socket directories are masked, and research networking remains available. The host waits for confirmed process shutdown before freezing source. A valid completion file may stop the process early; it is a handoff for independent verification, never proof acceptance.

## Sealed formalization and audit roles

Formalization, independent review, explanation and automatic-library planning use the stronger shared sealed sandbox. They can select `--harness cli` with this additional `cli.json` configuration:

```json
{
  "schema": "theorem-os.cli-harness.v1",
  "executable": "/absolute/path/to/headless-agent",
  "args": ["--model", "{model}", "--effort", "{effort}"],
  "prompt": "stdin",
  "output": { "format": "text" },
  "efforts": ["high"],
  "sealedRole": {
    "provider": {
      "wireApi": "chat-completions",
      "baseUrl": "https://models.example.com/v1",
      "apiKeyEnvironment": "PROVIDER_API_KEY"
    },
    "client": {
      "baseUrlEnvironment": "OPENAI_BASE_URL",
      "apiKeyEnvironment": "OPENAI_API_KEY"
    },
    "profileFiles": {
      "native.json": "{\"baseURL\":\"{relayBaseUrl}\",\"apiKey\":\"{relayCapability}\",\"workspace\":\"{workspace}\"}"
    }
  }
}
```

The client environment names must match the native executable's documented configuration. `provider.wireApi` accepts `chat-completions`, `responses` or `anthropic-messages`, with the model/effort fields of that protocol. The endpoint must use HTTPS; HTTP is accepted only on loopback for local gateways/tests. The host loads `provider.apiKeyEnvironment` automatically. That key stays outside the role; the client receives an ephemeral capability and a private loopback endpoint. Direct Internet access and remote-resource/hosted-tool requests are denied.

`profileFiles` generates a role-specific profile by value. Its templates support `{profile}`, `{workspace}`, `{relayBaseUrl}` and `{relayCapability}`. The last two produce the private `/v1` endpoint and disposable capability. `configurationFiles`, host auth files and native session stores are not copied. Omit `profileFiles` when the CLI accepts environment configuration. Match the executable's normal headless flags to the generated profile; for example a CLI that requires `--config` should receive `/profile/native.json` through `args`.

The executable must be a self-contained native ELF, or declare `sealedRole.runtime.interpreter`. For a script use, for example:

```json
{
  "interpreter": "/usr/bin/python3",
  "resources": [
    { "source": "/absolute/path/to/helper.py", "target": "/opt/harness/resources/helper.py" }
  ]
}
```

This object is the value of `sealedRole.runtime`. Each resource is an explicitly selected canonical ordinary file. Targets stay under `/opt/harness/resources/`; resource directories or overrides of system/profile/source roots are rejected. The entrypoint script is projected automatically. Executable/interpreter/resource bytes participate in the frozen identity, and changing them requires a new request. The sandbox also records their digests. No host-root mount or global CLI installation tree is substituted. A packaged CLI can enumerate its required runtime files or supply a self-contained native build.

In sealed roles, `environment` uses explicit constants and the `{model}`, `{effort}`, `{profile}` and `{workspace}` templates. Ambient `inheritEnvironment` values stay on the host. Per-turn prompt/session/turn environment templates require argv/stdin/file equivalents. Runtime-owned environment names and projection of the real provider key are rejected. Output paths are projected to `/workspace`; host validators still reject invalid JSON/proofs, and the host confirms all native writers stopped before source freezing and independent Lean checks. Usage comes from host provider-request receipts even when `output.usage` is absent.

## Presets and verification scope

Example profiles live in `resources/cli-harnesses`. Gemini CLI and Qwen Code presets target the versions recorded there; Aider uses a conservative one-shot profile. Review each preset's native tool and accounting limits before selecting it. The same configuration contract also accepts other headless CLIs or small wrappers without a new TypeScript adapter.

Tests exercise stdin/file/argument input, exact native resume, plain/JSON/JSONL output, cumulative versus turn usage, missing accounting, process shutdown, full-context one-shot recovery and frozen configuration identity. Shared solver tests check correct proofs, incorrect proofs and reusable helpers using the real isolated Lean kernel. Fixed loopback provider responses verify native CLI protocols without external model calls; they do not establish mathematical success rates or an efficiency gain.
