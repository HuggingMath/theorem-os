<!-- README_SYNC: source=2cbe72f0cfde; updated=2026-11-18 -->
<p align="center"><a href="./README.md">简体中文</a> · English</p>

<div align="center">
  <img src="./docs/assets/mark.png" alt="" width="64" height="64">
  <h1>TheoremOS</h1>
  <p><strong>Take a mathematical problem from its original statement to an independently checked Lean proof.</strong></p>
  <p><a href="https://theoremos.top/">Project site</a> · <a href="https://app.theoremos.top/">Workbench</a> · <a href="https://theoremos.top/archive.html">Public proof archive</a></p>
</div>

[![Lean 4 · Mathlib](https://img.shields.io/badge/Lean_4-Mathlib-315cf5.svg)](./docs/web-workbench.md)
[![License: proprietary](https://img.shields.io/badge/license-proprietary-555.svg)](./LICENSE)

![The TheoremOS workbench with problem input, model selection, and budget settings](./docs/assets/workbench-desktop.png)

This repository contains the internal TheoremOS workbench and CLI. Start with natural language, TeX, or Lean. Inspect the generated Lean statement, follow proof candidates and diagnostics, and download the proof and its acceptance report. Researchers can compare retrieval, context, and collaboration strategies against a fixed acceptance check. The [public TheoremOS repository](https://github.com/HuggingMath/TheoremOS) provides the website source, proof archive, and local verification materials. Each repository has its own license.

## Quick start

| What you want to do | Start here | What you need |
| --- | --- | --- |
| Browse examples, replays, and published proofs | [Workbench](https://app.theoremos.top/) · [Public archive](https://theoremos.top/archive.html) | Browser; sign-in requires an approved email |
| Start research on a problem | [Workbench guide](./docs/web-workbench.md) | Approved email and an API key for your model provider |
| Check a prerecorded Lean replay locally | [Getting started example](./examples/getting-started/README.md) | Local Lean; no model key |
| Maintain a deployment or swap a research component | [CLI guide](./docs/usage.md) · [Component example](./examples/components/README.md) | Source access and separate credentials for model runs |

The hosted workbench is an allowlisted beta. The [project site](https://theoremos.top/) has an access request link. Set the model and any budget limits before submitting. Blank limits are not enforced, and the provider bills model requests to your API account. Lean checks the proof of the supplied statement; a researcher should still check that the statement captures the intended problem. You can inspect a compiled statement while a separate semantic review runs.

### Replay a Lean check locally

Run from the repository root on Linux with Git, Bun 1.2+, Node.js 22+, system Python, util-linux, Elan, and Bubblewrap with user namespaces enabled. This standard-library example needs neither Mathlib nor FUSE.

```bash
bun install --frozen-lockfile
elan toolchain install leanprover/lean4:v4.33.0
bun run math doctor --lean-only
export THEOREMOS_CASE="$PWD/../theorem-os-runs/first-replay"
bun run math example replay --dir "$THEOREMOS_CASE"
bun run math inspect --run "$THEOREMOS_CASE/result.json"
```

Choose an unused directory for the replay. The proof candidates are prerecorded; Lean checks them on your machine. The [CLI guide](./docs/usage.md) also covers preparing, checking, and resuming a model run.

### Deploy the workbench

For maintainers and authorized operators. Use Linux with Docker Compose and user namespace support. Mathlib jobs also require `/dev/fuse`.

```bash
git clone https://github.com/HuggingMath/theorem-os.git
cd theorem-os
docker compose -f apps/web/compose.yml build worker web
docker compose -f apps/web/compose.yml up -d web
```

Open <http://127.0.0.1:8787>. The [deployment guide](./docs/web-workbench.md) covers resources, data retention, model providers, and keys. The [release status](./docs/web-release-status.md) records what the workbench has been tested to do. The CLI runs independently of the web app.

## Verification and results

A run freezes the problem statement and its dependencies. Candidates can be checked and revised repeatedly, then submitted to independent acceptance after integration. A status of `evaluated_passed` in `result.json` means the run passed that final check. Local checks, reviewer feedback, and an agent declaring completion are separate records.

| Record | What it supports |
| --- | --- |
| [Earlier Lean-Eval results](./accepted/README.md) · [Submission archive](./submitted/README.md) | Official outcome links, proof provenance, and verification artifacts. Some results predate this system or build on earlier proofs; they do not estimate the current system's success rate from scratch. |
| [Local IMO2026 results](./examples/imo2026/RESULTS.md) · [Comparison runs](./examples/imo2026/COMPARISON.md) | Problem-level Lean acceptance, formal statements, and timing definitions. Budgets, models, and timing rules vary by system. |
| [Local OpenAI math records](./results/openai-math/README.md) | Proofs, comparator evidence, and system acceptance are recorded separately. These are not OpenAI-hosted evaluation results. |

## Five replaceable research components

M1 executes work in isolation, M2 returns Lean evidence, M3 chooses ready tasks, M4 assembles the statement, prior results, and feedback, and M5 assigns research and review roles. The runtime records component versions and checks them when resuming. Research strategies and final acceptance have separate responsibilities. Components are TypeScript source interfaces; there is no stable plugin SDK.

- [Component and handoff contracts](./docs/solver-modules.md) · [TypeScript interfaces](./src/solver/modules/index.ts) · [Independent acceptance](./src/solver/evaluation.ts)
- [Formalizing a statement](./docs/formalization.md) · [Explaining a Lean proof](./docs/informalization.md) · [Theorem index](./docs/theorem-knowledge.md)
- [Project and maintenance documentation](./docs/README.md)

## License and credits

The current internal source is governed by the proprietary [LICENSE](./LICENSE). Earlier AGPL-3.0-only copies retain their original license. DeepScientist-derived files marked Apache-2.0 remain under the [Apache-2.0 terms](./LICENSES/Apache-2.0.txt). See [NOTICE](./NOTICE) for provenance and third-party terms. Thanks to [Lean](https://lean-lang.org/), [Mathlib](https://github.com/leanprover-community/mathlib4), and [Lean-Eval](https://github.com/leanprover/lean-eval) for the tools and evaluation resources.
