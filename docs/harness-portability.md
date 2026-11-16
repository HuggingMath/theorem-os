# Portable research harnesses

Research supports Codex, Claude Code, OpenCode and a configurable [headless CLI harness](generic-cli.md). Mathematical methods live in one pinned `skills/theoremos-research` directory and can be selected separately from the backend and host coordination. The solver uses `MathAgentSession` for dispatch, native session IDs, activity, usage and confirmed process shutdown. Mathematical acceptance, declaration artifacts, saved sources and independent verification remain host responsibilities.

| Harness | Native transport | Skill loading | Research arrangement | Usage basis |
| --- | --- | --- | --- | --- |
| Codex | app-server over stdio | native or file | Existing single, independent and cooperative modes | Provider requests when the existing relay supplies receipts; otherwise native cumulative thread totals |
| Claude Code | print mode with stream-json | file | Single, independent and host cooperative | One final native invocation total, including all API calls inside that invocation |
| OpenCode | native server, session API and SSE | file | Single, independent and host cooperative | Deduplicated assistant request totals belonging to the dispatched native message |
| Configured CLI | argv + stdin/file/argument; text, JSON or JSONL | file | Single, independent and host cooperative | Explicitly mapped invocation or cumulative session totals; unknown unless complete native coverage is configured |

CLI research, trusted Web provider configuration, automatic-library proof backends, comparison and batch launches share this selection. Complete role workflows reuse the same dispatch interface and hermetic role sandbox across all four backends. The generic CLI requires an explicit executable/resource projection and role relay mapping; see [complete workflows](portable-workflows.md). Host cooperation preserves Lead, task ownership, fixed Reviewer, integration, recovery and independent acceptance on all four research backends.

Codex Skill single research can additionally select `--skill-delegation read-only --skill-max-agents 2..4`. A native dynamic tool dispatches independent named read-only threads through the host, with one shared request gate and accounting ledger. This is host-mediated native threading; Codex's built-in V1/V2 spawn remains disabled because both inherit the primary writer's permission. Each investigator is archived before returning advisory findings. Parent shutdown confirms that the owned process group stopped before source freeze. Native permission profiles and dynamic tools require the app-server experimental capability, verified against Codex 0.169.0. Unsupported protocols or permission bindings fail explicitly and stop the owned tree.

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

Additional harnesses default to `--research-mode skill --skill-loading file --workers 1 --coordination independent`. Add `--workers 4 --coordination cooperative` for host cooperation, or `--workers 4 --coordination independent` for independent attempts. Explicit legacy methods also work; unsupported native Skill loading or delegation is rejected. They require a separately created profile directory and explicit model. OpenCode requires `opencode.json` in that directory, with the selected provider configured and the requested effort present in the native model's variants. Unsupported efforts are rejected. Claude uses its explicit native model/effort flags and API authentication environment.

Only explicit provider definitions enter the OpenCode configuration. Project configuration, plugins, MCP, title models and child agents are disabled for this execution path. Claude disables project settings, hooks, plugins and child tools. The host points both agents to the identical frozen Skill file and generated command help. It does not translate mathematical methods into a separate backend-specific prompt library.

Native credentials enter an execution-only environment overlay and are excluded from host Lean environment records. Standard Anthropic/OpenAI credential names are supported. OpenCode also receives environment variables explicitly referenced by its selected provider's `{env:NAME}` fields; non-secret referenced values participate in the frozen configuration digest. API key rotation does not change that digest. Provider `{file:...}` interpolation and references to runtime-overridden environment variables are explicitly unsupported; use literal configuration or an explicit provider environment reference.

## Resume and isolation

Use the normal `--resume` command with the same workspace, task, output and build manifest. The saved harness, model, profile, executable and Skill loading are inherited. The host pins the executable's canonical path and file digest, native configuration bytes and endpoint environment identity. It checks this binding before dispatch and after writer shutdown, as well as on resume. Mutable native session/cache files may grow. Changing the harness or frozen configuration requires a new run; a native conversation cannot move between harnesses. Historical Codex checkpoints without the new binding retain their existing interpretation. Explicit `--harness-profile` or `--harness-executable` also opts Codex into the new binding; `--codex` remains its compatible executable alias.

`planMathAgentSession` resolves Skill loading, role isolation, structured delivery and continuation before dispatch. New runs freeze that plan and compare it with the actual adapter plan. A CLI without native resume explicitly uses source-context continuation; a CLI without native schema enforcement uses a validated output file when the workflow supplies a validator. Neither is reported as a native capability. Historical Skill checkpoints without `researchSkillWorkflow: full` retain their original single-researcher workflow.

Claude Code, OpenCode and the configured CLI harness require Linux and `/usr/bin/bwrap`. The shared process wrapper makes the host root read-only, exposes only the run worktree and dedicated native profile as writable directories, and masks protected roots and host socket directories. It exposes the existing pinned Lean lock file when needed. Research networking remains available. Native tool permission lists supplement this OS isolation. Before freezing or accepting source, the host requires the owned process and descendants to have stopped; unconfirmed shutdown quarantines that writer workspace.

## Accounting and evidence

For research-workspace sessions, native invocation totals are added once per actual host turn, including when the same native conversation is reopened. Codex cumulative thread totals retain their original merge semantics. Both additional CLIs can synthesize zero counters when the provider omits usage. A generation with zero or incomplete input/output counts therefore reports unknown usage. Finite budgets block subsequent dispatches when usage is unknown or the observed allowance is exhausted. Research-workspace backends provide observed turn limits. Sealed roles instead use the shared controlled model relay's per-request admission and terminal usage receipts; native totals remain observational and are not charged a second time.

Validation uses installed Claude Code 2.1.322 and OpenCode 1.19.5 with fixed loopback provider replies, plus disposable native protocol peers. It covers actual Skill reads, shell execution, native session resume, hidden-root denial, missing usage and confirmed shutdown without external model calls. Shared integration tests run each real adapter through the Skill solver and check correct proofs, wrong proofs and reusable helpers with real isolated Lean 4.33.0. These tests establish execution and acceptance behavior; they do not measure mathematical success rate or an efficiency advantage over direct harness use.

Complete-cooperation regressions additionally run Claude Code, OpenCode and CLI adapters as real local processes with fixed responses: persist and restore the Lead plan, deliver original targets through an Engineer, obtain an independent Reviewer decision, accept through real Lean, reject an incorrect proof despite native completion, and stop process descendants. No external model is used.

For a portable comparison, prepare with `--harness ID --harness-profile CONFIG_TEMPLATE --harness-executable COMMAND --model MODEL`. Each arm receives only allowlisted frozen configuration in a fresh directory; native sessions and credential stores are not copied. Template and attempt identities are checked before the batch, and observed states must match their planned backend. Non-Codex common-Skill comparisons require file loading. This prepares an experiment; it does not provide measured efficiency results.
