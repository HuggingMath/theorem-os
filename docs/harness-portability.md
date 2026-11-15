# Portable research harnesses

The CLI Skill researcher supports Codex, Claude Code, OpenCode and a configurable [headless CLI harness](generic-cli.md). Mathematical methods live in one pinned `skills/theoremos-research` directory. The solver uses `MathAgentSession`, rather than a Codex transport type, for dispatch, native session IDs, activity, usage and confirmed process shutdown. Mathematical acceptance, declaration artifacts, saved sources and independent verification remain host responsibilities.

| Harness | Native transport | Skill loading | Research arrangement | Usage basis |
| --- | --- | --- | --- | --- |
| Codex | app-server over stdio | native or file | Existing single, independent and cooperative modes | Provider requests when the existing relay supplies receipts; otherwise native cumulative thread totals |
| Claude Code | print mode with stream-json | file | One Skill researcher | One final native invocation total, including all API calls inside that invocation |
| OpenCode | native server, session API and SSE | file | One Skill researcher | Deduplicated assistant request totals belonging to the dispatched native message |
| Configured CLI | argv + stdin/file/argument; text, JSON or JSONL | file | One Skill researcher | Explicitly mapped invocation or cumulative session totals; unknown unless complete native coverage is configured |

This increment adds CLI research adapters. The Web launcher, formalization commands and comparison runner still use their existing Codex integrations. Native child delegation remains explicitly unavailable when the required child isolation and accounting contract cannot be enforced. The supported host cooperative engine remains available through Codex.

## Launch

Build with `bun run build --state-root EXTERNAL_BUILD_DIRECTORY`, then supply its manifest. Select the harness separately from the model:

```sh
bun bin/math.ts run --harness claude-code \
  --harness-profile DEDICATED_CLAUDE_DIRECTORY \
  --harness-executable /absolute/path/to/claude \
  --model YOUR_CLAUDE_MODEL --effort high \
  --workspace NEW_WORKSPACE --task-file TASK_FILE \
  --output RESULT_FILE --build-manifest BUILD_MANIFEST

bun bin/math.ts run --harness opencode \
  --harness-profile DEDICATED_OPENCODE_DIRECTORY \
  --harness-executable /absolute/path/to/opencode \
  --model PROVIDER_ID/MODEL_ID --effort high \
  --workspace ANOTHER_NEW_WORKSPACE --task-file TASK_FILE \
  --output ANOTHER_RESULT_FILE --build-manifest BUILD_MANIFEST
```

Both additional harnesses imply `--research-mode skill --skill-loading file --workers 1 --coordination independent`. An explicit conflicting mode, native Skill loading or unsupported delegation is rejected. They require a separately created profile directory and explicit model. OpenCode requires `opencode.json` in that directory, with the selected provider configured and the requested effort present in the native model's variants. Unsupported efforts are rejected. Claude uses its explicit native model/effort flags and API authentication environment.

Only explicit provider definitions enter the OpenCode configuration. Project configuration, plugins, MCP, title models and child agents are disabled for this execution path. Claude disables project settings, hooks, plugins and child tools. The host points both agents to the identical frozen Skill file and generated command help. It does not translate mathematical methods into a separate backend-specific prompt library.

Native credentials enter an execution-only environment overlay and are excluded from host Lean environment records. Standard Anthropic/OpenAI credential names are supported. OpenCode also receives environment variables explicitly referenced by its selected provider's `{env:NAME}` fields; non-secret referenced values participate in the frozen configuration digest. API key rotation does not change that digest. Provider `{file:...}` interpolation and references to runtime-overridden environment variables are explicitly unsupported; use literal configuration or an explicit provider environment reference.

## Resume and isolation

Use the normal `--resume` command with the same workspace, task, output and build manifest. The saved harness, model, profile, executable and Skill loading are inherited. The host pins the executable's canonical path and file digest, native configuration bytes and endpoint environment identity. It checks this binding before dispatch and after writer shutdown, as well as on resume. Mutable native session/cache files may grow. Changing the harness or frozen configuration requires a new run; a native conversation cannot move between harnesses. Historical Codex checkpoints without the new binding retain their existing interpretation. Explicit `--harness-profile` or `--harness-executable` also opts Codex into the new binding; `--codex` remains its compatible executable alias.

Claude Code, OpenCode and the configured CLI harness require Linux and `/usr/bin/bwrap`. The shared process wrapper makes the host root read-only, exposes only the run worktree and dedicated native profile as writable directories, and masks protected roots and host socket directories. It exposes the existing pinned Lean lock file when needed. Research networking remains available. Native tool permission lists supplement this OS isolation. Before freezing or accepting source, the host requires the owned process and descendants to have stopped; unconfirmed shutdown quarantines that writer workspace.

## Accounting and evidence

Native invocation totals are added once per actual host turn, including when the same native conversation is reopened. Codex cumulative thread totals retain their original merge semantics. Both additional CLIs can synthesize zero counters when the provider omits usage. A generation with zero or incomplete input/output counts therefore reports unknown usage. Finite budgets block subsequent dispatches when usage is unknown or the observed allowance is exhausted. These backends provide observed turn limits; they do not expose the existing Codex relay's per-provider-request admission gate.

Validation uses installed Claude Code 2.1.322 and OpenCode 1.19.5 with fixed loopback provider replies, plus disposable native protocol peers. It covers actual Skill reads, shell execution, native session resume, hidden-root denial, missing usage and confirmed shutdown without external model calls. Shared integration tests run each real adapter through the Skill solver and check correct proofs, wrong proofs and reusable helpers with real isolated Lean 4.33.0. These tests establish execution and acceptance behavior; they do not measure mathematical success rate or an efficiency advantage over direct harness use.
