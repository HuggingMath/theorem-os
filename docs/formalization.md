# Formalizing an informal problem

`theorem-os formalize` turns a natural-language or TeX problem into Lean definitions and theorem targets, checks their elaboration, and asks independent model sessions to review whether they express the original problem. An approved statement becomes a frozen native `lean-task` seed. The proof solver and its independent S3 Lean acceptance run afterwards.

New CLI requests freeze the [whole-task fidelity policy](formalization-fidelity.md): reviewers account for complete hypothesis scope and binder dependencies, and approved source readings must pass a guarded whole-target Lean comparison. The default reviewers run concurrently and are both joined before acceptance or revision. Older requests retain their original policy and scheduling.

New requests and artifacts use v3, with the existing v2 planning workflow and the same structured semantic review used by offline evaluation. A planner first records exact source spans, domains, assumptions, conclusions, library mappings, new definitions and a dependency graph. The host rejects dangling references and dependency cycles, and binds every generated target and local definition to that plan. Unresolved concepts block generation. See [planning contracts](formalization-planning.md). The plan is model-authored; its presence does not certify that every original requirement was discovered.

The author receives the original and plan, then supplies source and explicit coverage notes. Lean checks the erased statements and complete definitions, exporting explicit types and binder dependencies. The backtranslator receives only this actual snapshot. It receives neither the original nor the author's plan or notes. Each semantic reviewer receives the original, candidate, observed snapshot and blind translation, without author explanations, reference answers or other reviewers' results. Every frozen reviewer must approve all six checks: domains, assumptions, conclusions, definitions, quantifier scope and instance coherence. Reviews quote actual source/candidate fragments; equivalent representations require arguments in both directions, ambiguous wording requires supported source readings, and a mismatch requires a complete separation argument. See [the shared semantic review contract](formalization-review-v2.md).

Newly prepared v3 requests explicitly freeze `contextProtocol: "kernel-v2"`. Their snapshots contain raw Lean types, structural kernel expressions, the complete reached local definition closure, and direct fields and parent projections of imported structures actually present in the statement context. These expose implicit instance arguments and local definition bodies independently of the readable rendering. See [kernel statement context](formalization-kernel-context.md). Existing `kernel-v1` requests and requests without this field retain their original query and role instructions; the reader does not inject a default or silently upgrade them.

New planned Mathlib requests can also opt in to frozen declaration retrieval with `--retrieval-workspace DIR --retrieval-corpus FILE`. The host derives queries from the actual plan, interleaves and deduplicates verified library headers, and supplies the result only to generation. See [frozen library hints](formalization-retrieval.md) for preparation, provenance and recovery behavior. Existing requests without retrieval retain their inputs and generator instruction bytes.

Disagreement, unknown or malformed evidence blocks approval. A panel records an established need for revision only when every reviewer requests changes and they share at least one mismatch aspect. Other non-approvals remain unknown. These rules check declared evidence and agreement; they do not certify the model's mathematics.

Coverage must collectively include every full source span cited by every planned conclusion. Supplemental exact excerpts may be shorter than a cited span, provided they map to that conclusion; adding such an excerpt does not invalidate complete coverage. Short excerpts alone never replace the full-span or target checks.

Planner and author instructions state each conclusion at the type the source gives it rather than at a shorter abbreviation a checker cannot relate to it. An unrestricted carrier stays at its own universe instead of being pinned to `Type`; a finiteness condition is a `Fintype` instance with `Fintype.card` rather than a `Nat.card` hypothesis; a natural-number predicate is named `Nat.Prime` rather than the general `Prime`; a family the source only calls finite is a function from a `Fintype` index rather than a `Finset` of its elements; and a sameness of two structures with no common ambient object is `Nonempty` of the structure equivalence rather than an equality of subobjects. These follow the source's own type, not the shortest statement Lean accepts. The motivating measurements are the official ProofNet# BEq+ results: `Fintype.card` with `Nat.Prime` passes where `Nat.card` or `Prime` does not, and a `Fintype`-indexed family passes where a `Finset`-indexed one does. Author instructions also remind the role that its file has only the imports and opens it writes, so names must be qualified rather than relying on a default namespace.

The default planner, author, backtranslator and two reviewers use five fresh threads with the same model configuration. This does not make their errors statistically independent. The evidence records the actual configured models, fresh thread identities, configuration hashes and the number of distinct configurations. A different configuration is not evidence of a different model family.

Every real formalization role now runs inside a separate Linux bwrap mount, process and network namespace. It sees its current workspace, independently mounted read-only INPUT.json, ROLE.md and OUTPUT.schema.json files, pinned Lean and sealed Mathlib dependencies, and its own clean Codex profile. Host files, reference statements, other roles and old sessions are unavailable. A host-owned Unix relay exposes only stateless Responses requests for the frozen model and effort; provider credentials stay on the host. Isolation failure stops the run. The state retains each isolation receipt and the host path to that role's audit records. No reviewer receives another reviewer's verdict.

This isolated execution currently supports the local Sub2API profile with `deepseek-flash` and `low`, `high` or `max` effort. Preparation can freeze other configurations, but a real run rejects unsupported profiles instead of falling back to shared-host execution. Replay sessions remain local fixtures and do not use this model boundary.

Lean elaboration establishes that the proposed definitions and targets are well formed. It does not establish that they are equivalent to the original problem. The semantic approval has `authority: "model"`; it is distinct from a human review. The generated targets retain proof holes, and the formalization artifact has `proofVerified: false`. Only subsequent proof search and S3 can establish proof acceptance for those frozen targets.

The current source admission supports ordinary imports, namespaces/sections, variables/universes, named definitions/abbreviations/instances, and theorem/lemma declarations. It uses existing Mathlib structures; custom structures, inductive declarations, custom notation and metaprogramming commands are currently rejected with repair feedback. The host removes comments and all theorem proof bodies before compilation and review. Definitions must be complete. Incomplete exported declaration context blocks automatic approval.

The current answer contract supports proof tasks. A plan classifying a question as `decision` or `construction` stops that frozen request, including later resumes. For example, a First Proof question asking whether a map is a quasi-isomorphism needs an explicit answer and proof/counterexample contract; assuming yes or proving `P ∨ ¬P` is insufficient. A planner can still misclassify prose, so reviewers must check the task kind against the original.

## Prepare without calling a model

Build once after the final code changes and retain the printed `buildManifestRef`:

```sh
bun run math build --state-root /tmp/theorem-os-build-state
```

Use that manifest to prepare a new directory outside the source repository:

```sh
bun run math formalize --phase prepare \
  --directory /tmp/theorem-os-formalization-example \
  --problem my_problem \
  --task-file /absolute/path/to/problem.txt \
  --build-manifest /absolute/path/to/manifest.json
```

`prepare` only reads local inputs and freezes `request.json`, plus a copied corpus manifest when retrieval is enabled. It does not compile Lean, contact a provider, or start a model. It preserves the entire problem, including TeX macros. Existing directories and symbolic-link paths are rejected.

The default environment is the runtime's pinned `mathlib` environment. Use `--environment standard` for a problem requiring only Lean's standard library. The model defaults to `deepseek-flash` with `--effort max`. The profile defaults to `CODEX_HOME`, then `~/.config/deepscientist/math-sol-codex`; `--profile DIR` overrides it for this request. The executable defaults to `DEEPSCIENTIST_MATH_CODEX_EXECUTABLE`, then `codex`; `--codex FILE` overrides it. No command edits a global profile or copies credentials.

New requests have no execution limits by default: candidate rounds, planning attempts, total time, model-turn time, Lean-compilation time and token use all default to `0`, meaning unlimited. The optional reference comparison also defaults to no time limit. Every limit accepts a nonnegative safe integer; a positive value explicitly enables that limit. Existing requests retain the positive limits they froze. To choose a bounded run, set limits at preparation time:

```sh
bun run math formalize --phase prepare \
  --directory /tmp/theorem-os-formalization-bounded \
  --problem my_problem --task-file /absolute/path/to/problem.txt \
  --build-manifest /absolute/path/to/manifest.json \
  --max-rounds 3 --max-run-seconds 1800 \
  --max-planning-rounds 2 \
  --max-turn-seconds 180 --max-compile-seconds 180 \
  --max-total-tokens 60000
```

Use `--review-config /absolute/path/to/review-config.json` to freeze separate role configurations. The strict JSON document has `planner`, `backtranslator`, and `reviewers`; each role contains `model`, `effort`, `profile` and `executable`, and each reviewer also has a unique `id`. One to five reviewers are supported. The author continues to use `--model`, `--effort`, `--profile` and `--codex`. For example:

```json
{
  "planner": {"model":"MODEL_A","effort":"max","profile":"/absolute/profile-a","executable":"codex"},
  "backtranslator": {"model":"MODEL_B","effort":"high","profile":"/absolute/profile-b","executable":"codex"},
  "reviewers": [
    {"id":"reviewer-a","model":"MODEL_B","effort":"high","profile":"/absolute/profile-b","executable":"codex"},
    {"id":"reviewer-b","model":"MODEL_C","effort":"high","profile":"/absolute/profile-c","executable":"codex"}
  ]
}
```

These are contract-format placeholders; the current isolated runtime only admits the Sub2API configuration described above. Preparation does not validate provider access or invoke any model. During a run and on resume, profile configuration and model catalog hashes are checked for changes, including an absolute `model_catalog_json` pointing outside the profile. Credentials are not copied into artifacts.

If a reference Lean statement has been independently reviewed, supply `--reference-file FILE --reference-pairs FILE --reference-provenance TEXT`. The pairs file is an array such as `[{"candidateTarget":"answer","referenceTarget":"gold"}]`, covering both complete target lists exactly once, at most 16 targets. The full reference source, its hash, target mapping and stated provenance are frozen. `--max-reference-seconds 60` bounds the additional Lean comparison. Every semantic reviewer must still approve, and the reference comparison must establish both directions before an artifact is created.

The current `cardinality-correspondence-v5` method accepts definitional correspondence, bijective binder permutations and fixed proved representation conversions with baseline guards and rigid universe parameters. These cover conjugacy, finite families, the exact six-binder prime-product cardinality template, and a final `Bool.false` proposition coerced to `Prop`. For the cardinality template, prime assumptions establish a nonzero product; the cardinality equality then establishes finiteness before the checked proof constructs a finite enumeration. It does not silently assume finiteness or prove the remaining target. New receipts and reports use schema v4; saved schema-v1, v2 and v3 receipts retain their frozen validators, including unchanged method-v4 receipts.

Failures and timeouts return `not-established`, meaning correspondence is unknown, not a claim of inequivalence. See [reference comparison](formalization-reference.md) for its exact templates and limitations. Reference correspondence does not establish natural-language fidelity or original theorem proof acceptance. A supplied provenance string is not an independently authenticated semantic review.

## Run, inspect and prove

`run` uses the frozen model configuration and budget. It is the phase that calls the configured provider:

```sh
bun run math formalize --phase run --directory /tmp/theorem-os-formalization-bounded
```

The same command resumes a stopped run from its local state. It cannot override the input, environment, role configurations or budget. An exhausted or unsupported-task run requires a new directory and request. Source or build changes invalidate the frozen build identity. Time and token usage accumulate across every role and resume; an unclosed active interval after a crash is charged conservatively through the restart. A finite token allowance stops new role turns after reported consumption reaches it; incomplete usage, including the final review, blocks approval. In-flight consumption may exceed that allowance.

Candidates are selected by first unanimous fidelity approval, before any proof search. The run reports candidate count, first-candidate approval, per-role turns and cumulative observed token usage. It does not select the easiest candidate to prove or present a repaired third candidate as pass at one. A source with an agreed concrete mismatch must change before review can approve it. Unknown decisions, reviewer disagreements and temporary infrastructure failures do not permanently blacklist that source; the next round may gather fresh evidence for unchanged Lean source.

Each role receives its complete instructions in ROLE.md and a JSON Schema derived from its actual host validator in OUTPUT.schema.json. These files are mounted read-only, hashed in the role state and isolation receipt, and rechecked before submission is admitted. The schema documents structure; exact source spans, reference bindings, Lean admission and semantic fidelity remain host checks. Role work uses the installed lean command directly with the configured LEAN_PATH and does not require writing the sealed Lake cache.

The first complete schema-valid OUTPUT.json is an explicit role submission. The host interrupts the turn, waits for confirmation, closes the writer, then rechecks the frozen input and output before accepting it. Such sessions are recorded as `submitted` with `completionReason: "validated-output"`. Partial files, invalid contracts, time checkpoints and transport failures do not count as submissions. Planning-only failures do not increase the candidate count. Operator cancellation saves terminal session records and returns a stopped result.

`inspect` reads saved state and validates any approved artifact without starting or resuming a run. Its JSON contains hashes, limits, target names and review authority; it omits the full original and generated source:

```sh
bun run math formalize --phase inspect --directory /tmp/theorem-os-formalization-bounded
```

An approved run returns the artifact directory, `workspaceRoot`, `receiptFile`, `taskFile`, and `runArguments` for the existing proof solver. The artifact preserves `original.txt`, `Statement.lean` and `evidence.json`; changing the original, source, targets, environment or review breaks its identity checks. Pass the returned `runArguments` to `bun run math run`, adding the desired native proof-search configuration and budget. Formalization approval alone never counts as solving the problem.

Frozen v1/v2 requests and artifacts, and earlier v3 requests without `contextProtocol`, remain readable with their original review protocol and exact evidence digests. They are never silently upgraded. A completed artifact can be restored without opening a model session. Unfinished runs still require their frozen source/build identity. Prepare a new directory and build to use the new context. The First Proof adapter preserves the full structured v3 evidence and optional semantic context, as well as legacy evidence, and attributes its review to the configured reviewers.

## First Proof Batch 3

The prepared request can use an official bundled problem directly:

```sh
bun run math formalize --phase prepare \
  --directory /tmp/theorem-os-first-proof-01-formalization \
  --first-proof-problem first_proof_batch3_01 \
  --build-manifest /absolute/path/to/manifest.json
```

The catalog verifies the pinned official TeX. `--source-root DIR` may select a different local copy of the same pinned snapshot. `--first-proof-problem` is mutually exclusive with `--problem` and `--task-file`. The resulting review remains explicitly attributed to a model; it cannot be presented as human approval. Preparing the ten source statements or passing a tutorial replay does not mean the ten benchmark questions have been formalized, attempted or solved.

## Offline integration replay

```sh
bun run math formalize --phase replay \
  --directory /tmp/theorem-os-formalization-replay \
  --build-manifest /absolute/path/to/manifest.json
```

`replay` uses a preset tutorial candidate and independent simulated sessions with real Lean elaboration. It never invokes a model or provider. It requires a new directory and records `execution: "replay"` and `modelInvoked: false`; the model `run` command refuses such a request. This checks the integration and artifact handoff, not model formalization quality or First Proof performance.

## Calibrate review before benchmark claims

Use [the offline evaluation workflow](formalization-evaluation.md) to prepare blinded labeled examples, preserve source splits, and score recorded judgments. It reports false acceptance among incorrect candidates, incorrect candidates among approvals, false rejection, unknowns, decision coverage and compilation observations separately. ProofNetVerif's upstream labels and toolchain must retain their provenance; local mutation fixtures are useful failure tests but are not independently annotated model results. No model-review accuracy is implied by passing these integration checks.

The design borrows definition/dependency planning from [RLMEval](https://github.com/augustepoiroux/RLMEval), blind backtranslation from [Herald](https://github.com/frenzymath/herald_translator), semantic audit categories from [Beyond Compilation](https://github.com/grenadeComing/beyond-compilation), and bounded reference comparison from [LeanInteract / BEq+](https://github.com/augustepoiroux/LeanInteract/blob/768e18ebcb5c7ec34d308768a785389eeac37798/examples/beq_plus.py). These mechanisms were implemented within the existing runtime; no external model stack or dataset is bundled with the product.
