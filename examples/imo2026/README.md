# Reproduce the public IMO2026 Q1 example

For paired single-agent, independent-parallel and cooperative experiments, see
the [comparison protocol](COMPARISON.md).

For archived GPT-5.6 results on all six questions, complete Lean proofs and
first-party per-question comparisons, see [public results](RESULTS.md).

This example runs the ordinary solver on all five public Q1 targets from
`humanfia/imo2026` at commit `834c01f2ecac89b648759b1c95bc6180b0ede149`.
The adapter copies public statements and project metadata. It starts with
unfinished proofs and does not seed answers from previous runs.

The six archived `results/20261024/Q*/problem.lean` files reproduce
the [AxiomMath formal statements](https://github.com/AxiomMath/IMO2026/tree/c5a6a089d06d3619afe7ff45c5ccab9e2a30d5d2/IMO2026),
via the pinned Humanfia snapshot. They carry the [MIT License, copyright
2026 Axiom Math](./LICENSE.AxiomMath). Retain that license when distributing
these formalizations. The underlying Olympiad problems belong to the
International Mathematical Olympiad. This notice grants no new rights in
the original problem texts.

The case uses `gpt-6.1-sol`, `xhigh`, a Codex native team of up to four members
including Lead, a shared 30-minute solving limit and 20 total turns.
A completed run is accepted only if
all original targets pass host Lean verification after integration. This is a
local evaluation (`official: false`). A demonstration run can remain incomplete
within its budget; the example does not promise a solved task.

## Requirements

Use Linux with Git, Bun 1.2+, Node.js 22+, `/usr/bin/python3`, Elan and Bubblewrap.
Preparing the immutable dependency environment also needs `mksquashfs`,
`squashfuse` (or `snapfuse`), `fusermount3` (or `fusermount`), and permission to
mount FUSE filesystems. `lake exe cache get` downloads the pinned dependencies
and requires network access and enough disk space for Mathlib.

The FUSE reader must support zstd-compressed SquashFS images. Some older
`snapfuse` binaries do not, even when the basic tool check passes. Use a
zstd-capable `squashfuse`/`snapfuse` and complete the actual startup preflight.

Install dependencies with `bun install --frozen-lockfile` from the project root.
Authenticate your existing Codex profile separately. The default profile is
`~/.config/deepscientist/math-sol-codex`; `CODEX_HOME` can select another existing
profile with access to the configured model. Use the
[native team backend](../../scripts/codex-backend/README.md) for this example.

The [environment template](math.env.example) describes tool and cache settings.
Copy it to a local file, replace the paths, and set
`DEEPSCIENTIST_MATH_ENV_FILE` to that file. Keep Lean/Elan on your shell's PATH
for the dependency download step.

Run the complete `import Mathlib` check on a host with enough memory for Lean
and the other processes sharing its account limit. The first Q1 investigation
found a 12 GiB account limit on the login node, despite much more available host
memory. Moving only the toolchain to local disk did not resolve the timeout.
Use a compute allocation when the login node is constrained; a CPU allocation
does not require a GPU. Check the account or job cgroup limit as well as host RAM.

If the pinned toolchain lives on shared storage, copy its `bin` and `lib` trees
to local disk, preserve relative symlinks, and compare every file using SHA-256
before selecting the copy through the environment template. Keep the same
`lean-toolchain`, package versions, imports, and source constraints. Frozen
environment paths must remain available on the selected host when resuming.

## Prepare, check, and run

From the source checkout, use a **new absolute directory outside the checkout**:

```bash
bash examples/imo2026/reproduce.sh prepare /absolute/new/imo-q1-case
bash examples/imo2026/reproduce.sh check /absolute/new/imo-q1-case
```

`prepare` builds and freezes the runtime, checks out the pinned public source,
creates a fresh solver workspace and task file, and downloads Lean dependencies.
It writes `case.json`, `build.json`, and `bootstrap.json` with the exact problem,
build, model, budget and task digest. It does not invoke a model.

`check` prepares the actual runtime and writes `status: prepared`; it does not
invoke a model or prove any target. Since it creates a checkpoint, use `resume`
to start solving afterwards:

```bash
bash examples/imo2026/reproduce.sh resume /absolute/new/imo-q1-case
```

Use `solve` for a fresh model run when skipping `check`. Solve and resume invoke
your configured provider. Progress is emitted as JSON events; the final outcome
is stored in `result.json`. Only `evaluated_passed` records a successful final
evaluation. Timeouts, errors and incomplete outcomes remain visible.

For an existing pinned benchmark checkout, set `MATH_EXAMPLE_REPO` before
`prepare`. With an already prepared compatible cache, set
`MATH_EXAMPLE_SKIP_CACHE=1` and configure its trusted root in your math environment
file. These options reuse local resources; the task and target identities stay
pinned. Preserve the original build and environment to resume a run.
Use the original TheoremOS revision and build for a saved historical case.
To try the native team, prepare a separate case directory.

## Inspect the run

```bash
bun run math inspect --run /absolute/new/imo-q1-case/result.json
bun run math inspect --run /absolute/new/imo-q1-case/result.json \
  --format plan --output /absolute/new/imo-q1-case/plan.json
```

The report separates recorded proof checks, open conditions, review, and final
evaluation. It can inspect a running checkpoint before `result.json` exists.
It reads stored evidence and does not rerun Lean.

The native Lead owns the route and member assignments. Start a separate case
if you want to measure a different configuration.
