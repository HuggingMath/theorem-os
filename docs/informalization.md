# Explaining a checked Lean proof

`theorem-os informalize` turns a Lean proof that compiles into a natural-language proof. Each step quotes the Lean text it explains and names the declarations it relies on. Independent auditors check every step against the Lean source before anything is published. The result is `artifact/proof.md` with `artifact/informalization.json`, which binds the Markdown to the frozen proof, the extracted outline, every accepted output and every audit.

The protocol is `lean-proof-informalization-v1`. It combines methods from published work. Step-wise informalization with a premise library follows arXiv 2509.09726, translation in dependency order with already translated dependencies as context follows Herald (arXiv 2410.10878), and per-step `\lean`/`\uses` anchors follow leanblueprint. As in the other TheoremOS roles, the model proposes and deterministic host checks decide what is admissible. The code is in `src/math/informalizationExtraction.ts`, `src/math/informalization.ts`, `src/solver/informalizationExtraction.ts` and `src/solver/informalization.ts`.

## What happens in a run

1. **Freeze.** `prepare` copies the proof file and its project-local import closure into `sources/` with their sha256 digests. It also freezes the target theorem, the optional informal statement, the language, the writer and auditor configurations, batching and limits in `request.json`. It refuses a proof outside `--project-root`, a module under an excluded path segment (`test`, `reference`, `solutions`, `.lake` and the other construction exclusions), a file that uses the Lean module system (it exports no proof bodies to an importing command), repeated auditor ids and an existing directory. The source project is not read again.
2. **Extract.** `run` first compiles the frozen modules in a fresh project of the pinned environment. Only then does it write a host query command, `lean-declaration-outline-v1`, which carries a random nonce in its namespace and result file, so a proof module cannot forge the report. The query reads the elaborated environment, never the source text. A unit is a declaration of the proof modules that has a declaration range and is reachable from the target. Compiler auxiliaries (`proof_n`, `match_n`, equation lemmas) are folded into the unit that uses them, and a `where` declaration belongs to its prefix. For each unit the outline records its kind, range, source slice, pretty-printed signature, the owned declarations its statement and its proof term use, the external constants it uses, and the signatures of those library constants. `collectAxioms` of the target refuses a proof that depends on `sorryAx` (`informalization_proof_incomplete`), and an `axiom` in the proof modules is refused as well. Units are ordered by dependency (Kahn order, ties in source order) and the target comes last. Mutual recursion is released at its earliest member and marked `cyclic`. A module that does not compile stops the run with `informalization_proof_does_not_compile: FILE: first error`.
3. **Batch.** Units are grouped greedily in that order, at most `--max-units-per-batch` declarations (default 12) and `--max-batch-source-bytes` source bytes (default 60000) per batch. The target is in the final batch.
4. **Write.** For each batch, a writer role receives the batch's units (source, signature, dependencies, required citations and citable library names), the accepted statements of earlier declarations they use, the library theorems with signatures, and the proof files under `proof/`. It may compile scratch copies with the installed Lean. It writes one section per declaration: a title, a statement that translates the Lean signature exactly, and proof steps `{text, uses, lean}`. In the final batch it also writes an overview of how the declarations prove the target. The informal problem statement, when given, is shown to the writer only and only for vocabulary. Lean is the authority.
5. **Host checks.** The host rejects an output unless it explains exactly the batch's declarations in order, gives each theorem at least one step, cites in `uses` only declarations the unit's Lean terms actually use (owned dependencies or non-tactic external constants), cites every owned theorem the proof term applies (`mustCite`), quotes in `lean` only verbatim text of that declaration (modulo whitespace), and includes the overview exactly in the final batch. A rejected output is not audited. Its problems become feedback for the next round, and the same check runs inside the writer's turn and steers it once.
6. **Audit.** Each auditor (default 2) gets the Lean units and the explanation. It never sees the informal statement, the writer's feedback or another auditor's audit. Per declaration it judges the statement (`faithful`, `mismatch`, `unclear`), gives one verdict per step (`justified`, `gap`, `invented`, `unclear`) and lists omissions: substantive Lean, quoted verbatim, that no step explains. Declarations of other batches are out of scope even though the auditor can read the whole proof. It also judges the overview. The host checks the audit's structure: one verdict per step, an explanation for every non-approving verdict, verbatim omissions. A malformed audit is retried, and after three attempts the run stops with `informalization_audit_invalid`.
7. **Revise or accept.** A batch is accepted when every auditor approves every statement, step and overview with no omission. Otherwise every finding, attributed to its auditor, goes back to the writer with its previous output. `--max-rounds-per-batch` (default 6, `0` = unlimited) bounds the rounds of each batch. When they run out, the run ends `exhausted` with the last findings in its error.
8. **Publish.** After every batch is accepted, the host renders the Markdown deterministically and writes the artifact. Nothing is published earlier.

## The document

`proof.md` begins with a notice that the text is model-written and model-audited and that Lean checked only the proof. Then come the main theorem's statement and the overview. Under "Definitions and lemmas", definitions come first, then lemmas in dependency order, numbered in one sequence. Each has its Lean name, its statement and its numbered steps. Each step lists the cited declarations as "Lemma 3 `double_eq`" and the quoted Lean, inline or as a fenced block whose fence is longer than any backtick run inside it. The main theorem's proof comes last, followed by a footer with each source file's sha256, the Lean toolchain, the Mathlib revision and the axioms the target uses. `--language zh` (the default) writes the prose and headings in Chinese, and `--language en` writes them in English. Lean names are never translated.

`informalization.json` has `authority: "model"`, `humanReviewed: false` and `proofCompiledByHost: true`. `assertInformalizationEvidence` re-derives everything from the evidence alone: the outline digest, the batches, every writer check, every audit check and approval, the metrics (declarations, steps, citations and `excerptCoverage`, the share of non-blank source characters quoted by some step), and the Markdown hash. `inspect` runs this check and also compares `proof.md`.

## Commands

Build once after code changes and keep the printed `buildManifestRef`, as for [formalization](formalization.md). Then prepare a directory outside the source repository. This step is offline:

```sh
bun run math informalize --phase prepare \
  --directory /absolute/path/informalize-my-proof \
  --proof-file /absolute/path/project/MyProof.lean --target MyNamespace.main_theorem \
  --build-manifest /absolute/path/to/manifest.json \
  [--project-root /absolute/path/project] [--statement-file problem.txt] [--language zh|en] \
  [--environment mathlib|standard] [--auditors 2] [--max-rounds-per-batch 6]
```

`--project-root` defaults to the proof file's directory; local imports are resolved and frozen from it. Model flags (`--model deepseek-flash`, `--effort max`, `--profile`, `--codex`) and limits (`--max-run-seconds`, `--max-turn-seconds`, `--max-compile-seconds`, `--max-total-tokens`, all `0` = unlimited) work as in `formalize`. The writer and every auditor use the same model configuration in fresh threads, so their errors are not statistically independent.

```sh
bun run math informalize --phase run --directory /absolute/path/informalize-my-proof
bun run math informalize --phase inspect --directory /absolute/path/informalize-my-proof
```

`run` exits with code 2 unless the result is `approved`. The same command resumes a stopped run. The outline, accepted batches and every closed role whose input, instructions, schema and output digests still match are restored; a failed or interrupted role runs again in a fresh workspace. An approved run only re-verifies its artifact. An exhausted run needs a new directory.

## Execution

Roles run in the same isolated sandbox as formalization roles: a bwrap mount, process and network namespace with read-only `INPUT.json`, `ROLE.md` and `OUTPUT.schema.json`, the pinned Lean and Mathlib, and a host relay for the frozen model only. Real runs therefore currently need the local Sub2API profile. Transient provider failures retry only that role, in a fresh thread, with jittered backoff of at most 30 seconds. These retries do not use a revision round. Account, policy and budget errors stop the run. `DEEPSCIENTIST_MATH_MODEL_SLOTS` and `DEEPSCIENTIST_MATH_MODEL_SLOT_DIRECTORY` share host admission control with other runs.

## Limits of the result

Lean establishes that the proof compiles and that the target uses no `sorryAx`. The host establishes that each step quotes real Lean text of its declaration and cites declarations the Lean terms use. It does not establish that a step's prose is mathematically correct, that a statement translation is faithful, or that the explanation is complete. Those are model judgments by auditors that share the writer's model, and the artifact says so. Coverage is reported, not required.

Current limitations:

- Steps follow the source text. The extractor does not record tactic-level goals from the info tree, so the writer reads intermediate goals only by compiling scratch copies.
- The proof must compile in the runtime's pinned toolchain (`leanprover/lean4:v4.33.0`, and for `mathlib` the pinned Mathlib). Module-system files are refused.
- `omega`, `simp` and similar automation leave many library lemmas in proof terms. They are listed as citable but not required.
- There is no workbench view yet, and solved runs do not start an informalization automatically.
