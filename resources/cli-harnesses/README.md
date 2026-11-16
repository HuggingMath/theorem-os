# Headless CLI profiles

Copy one profile directory into a new dedicated native profile, then use `--harness cli --harness-profile DIR --model MODEL --effort none`. The executable must be installed separately. See the [configuration contract](../../docs/generic-cli.md) for custom commands and wrappers.

| Profile | Version examined | Evidence | Session and accounting |
| --- | --- | --- | --- |
| `generic` | User supplied | Template; adapt args to the executable | One-shot, full context each time, usage unknown |
| `gemini` | Gemini CLI 0.68.0 | Official package executed through `createCliMathSession` and bubblewrap with a fixed loopback provider; start and exact-ID resume passed | Host UUID; headless result stats describe this invocation |
| `qwen` | Qwen Code 0.27.4 | Official package executed through `createCliMathSession` and bubblewrap with a fixed loopback provider; start and exact-ID resume passed | Host UUID; result usage is cumulative across resume |
| `aider` | Aider 0.86.2 | Official PyPI source and configuration validation; native binary execution remains untested | One-shot message file and text; usage unknown |

All presets expose `none` for effort because this profile does not bind a portable reasoning-level control. They preserve the selected model. Extend `efforts` only alongside a real native `{effort}` binding. Native CLI upgrades may change flags or event semantics; freeze the installed executable and start a new run when changing versions/configuration.

For example:

```sh
mkdir -p DEDICATED_PROFILE
cp -R resources/cli-harnesses/gemini/. DEDICATED_PROFILE/
bun bin/math.ts run --harness cli --harness-profile DEDICATED_PROFILE \
  --model YOUR_GEMINI_MODEL --effort none \
  --workspace NEW_WORKSPACE --task-file TASK_FILE \
  --output RESULT_FILE --build-manifest BUILD_MANIFEST
```

Supply credentials using the names in `inheritEnvironment`. Keep them out of profile files and args. HOME defaults to the dedicated profile. Gemini additionally sets `GEMINI_CLI_HOME` to a private home root; the native CLI appends `.gemini`. Qwen sets `QWEN_HOME` to a private settings/session directory. Explicit system settings paths prevent fallback to host system paths; Gemini may ignore these profile files when its privileged settings ownership checks fail. Do not interpret that as those files taking effect.

Gemini and Qwen retain `usage.completeness: "partial"`: the local probes establish event mapping and continuity, not complete accounting for every provider/tool/background combination. With a finite token budget the host stops subsequent dispatches after an incomplete turn. Cached counters are already part of input totals. Gemini headless resume was measured at 40/5 then 40/5 tokens; Qwen at 40/5 then 80/10. Neither preset claims a latest individual request size.

Qwen uses `--bare`, disables advisor/workflow and keeps chat recording for exact resume. The inspected version's bare mode disables managed memory, dream, team sync, automatic Skill loading and structured recall, avoiding additional memory model requests after a result. Bare mode also disables some native context/search features; shell/network access and explicit Skill reads remain available. Neither probe performed paid/external model calls or measured proof-solving performance.

Aider is a file editor and does not provide a general autonomous read/shell tool loop. Its profile explicitly supplies the pinned main Skill via `--read`, and starts each invocation with the full host request. Add the problem's editable files with Aider's native file arguments and create `DIR/state` before use. Read-only reference files and validation commands need explicit native configuration or a suitable wrapper. `--config` and `--env-file` do not disable all Aider default discovery: it still considers config and `.env` files in its private home and git/project roots. Freeze or remove unintended native project settings in a new workspace before starting; do not assume this preset supports unattended Lean research.

These profiles preserve the host's source freezing, trajectories and independent mathematical acceptance. A final native reply or a successful command exit grants no proof acceptance.
