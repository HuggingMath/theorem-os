# Source-aware semantic review

New CLI model runs also freeze `fidelityPolicy: "task-preserving-v2"`. They require complete scope evidence and a host-run guarded correspondence check for approved source readings. Unestablished correspondence cannot become approval through reviewer agreement. See [whole-task fidelity](formalization-fidelity.md); absent policy fields preserve earlier schemas, instructions and judgments.

Generated statements prepared with request v3 use the same schema, evidence validation and reading instructions from `src/math/formalizationSemanticReview.ts`. Generation keeps its existing blind translation and all-reviewer approval policy; evaluation keeps its primary/recheck routing and frozen receipts. Both require the same six aspects, source readings and concrete mismatch evidence. Generation stores full reviewer results in evidence v3 rather than reducing them to four booleans.

New `evaluate-formalization --phase review --execution model` runs use v2. Its `source-readings-v1` evidence revision addresses source ambiguity, version drift, hypothesis scope, actual instance selection and justified equivalent representations. The input source, upstream labels, split membership and original scoring rules remain frozen. Scores measure agreement with those labels; they do not turn disputed labels into mathematical truth or measure generated-statement accuracy.

New CLI model runs explicitly freeze `configuration.contextProtocol: "kernel-v2"` and require the [raw/kernel/local-definition context](formalization-kernel-context.md), including direct fields and parent projections of imported structures actually present in the statement context. Their role instructions describe this additional evidence. Saved `kernel-v1` configurations and v2 configurations without the field retain their previous query and exact instruction bytes, including when resumed with an explicit `--protocol v2`. Existing replay files retain their frozen context; programmatic replay may opt in only when every elaborated observation contains the requested extension.

```sh
bun run math evaluate-formalization --phase review \
  --directory /absolute/path/to/bundle \
  --run-directory /absolute/path/to/new-v2-run \
  --execution model --protocol v2 --environment auto \
  --build-manifest /absolute/path/to/current-build/manifest.json
```

This command invokes the configured model. The runtime adds no time, turn or token cap. The defaults remain `deepseek-flash` / `max`; every role uses a fresh isolated session and the existing host-only credential relay. Fresh sessions using the same model do not establish statistical independence.

The runner performs these steps:

1. Resolve the source Lean toolchain and optional Mathlib revision against runtime-owned pinned environments. `auto` selects `mathlib-4.8` for `leanprover/lean4:v4.8.0`, otherwise current `mathlib`. The frozen context records whether the revision was supplied or inferred from a runtime pin. Unknown toolchains, explicit mismatches and unsupported library revisions cannot become an elaborated observation.
2. Use the existing proof eraser and Lean elaboration module to compile the statement and complete definitions. Export explicit types, imported definitions and top-level binder dependencies, including actual implicit instances. Internal quantifiers remain inside their hypotheses. An unavailable observation produces a saved unknown case with diagnostics, without asking a reviewer to guess using a newer library.
3. Request a structured primary review with six aspects: `domains`, `assumptions`, `conclusions`, `definitions`, `quantifierScope` and `instanceCoherence`.
4. For every proposed rejection, source ambiguity, unresolved review, equivalent representation, scope/instance objection, nested hypothesis quantifier, overlapping structure on one carrier, or omitted definition export, independently backtranslate the actual snapshot and obtain a fresh recheck. The backtranslator sees neither the original problem nor any review. The rechecker sees the original, snapshot and independent translation, but no primary verdict or explanation.
5. Preserve both reviews. Different verdicts produce unknown. Two rejections also need at least one shared mismatch aspect; disjoint reasons produce unknown. Accepted rejections use `resolution: shared-mismatch-aspect`, which does not claim agreement on every argument. The case receipt's `reviewAgreement` records `sharedMismatches` and all `aspectDisagreements`; run results count `aspectDisagreementCases`. Transport failures remain pending and can resume from completed role receipts.

`ROLE.md` includes input navigation and Python examples for reading selected fields in successive pages. Primary and recheck inputs put the snapshot at `observation.snapshot`; backtranslation receives the snapshot itself, with `targets` at the root. In both layouts, each target's type is at `context.type`, and its binder list, conclusion and dependency list are inside `context.bindings`. Reviewers list target names first, then read fields without dumping the full snapshot. Page offsets and total lengths keep a truncated tool response from being mistaken for the complete field; pages do not impose a solving budget.

Every review requires `evidenceVersion: source-readings-v1`. Every check needs at least one correspondence with `originalFragment`, `candidateFragment`, `relation`, `explanation`, `forwardArgument`, `reverseArgument`, `sourceReadings` and `mismatchEvidence`. The host checks that quoted fragments occur in the actual original and candidate/type data. Relations are `direct`, `equivalent`, `mismatch` or `unresolved`; the six checks must agree with their evidence. An equivalent relation requires both conversion arguments. Approval requires all faithful checks; rejection requires an actual mismatch; unknown requires an uncertain check.

`sourceReadings: []` explicitly records that the reviewer identified no material ambiguity in that comparison. If the original supports materially different readings, provide at least two distinct entries with `mathematics`, `relation` (`faithful`, `mismatch` or `uncertain`) and an `argument` explaining both the textual basis and the comparison. Each reading concerns the complete claim with its surrounding assumptions. A mathematical correction or presumed reference answer is not textual support. If the readings cannot be resolved or explained, the correspondence remains unresolved.

The host rejects a mismatch if any declared reading is faithful or uncertain, and rejects a direct/equivalent correspondence if any declared reading differs or remains uncertain. Mixed readings therefore cannot silently become approval or rejection. An independent mismatch elsewhere may still justify rejection. These checks validate the declared evidence; they cannot detect an ambiguity that every reviewer misses.

For a mismatch, `mismatchEvidence` must contain `sourceClaim`, `candidateClaim` and `separationArgument`: compare complete obligations under the surrounding assumptions and account for representation conversions. For every other relation this field must be null. A counterexample to the candidate alone does not establish mistranslation: an explicitly false source may have been translated faithfully. Suspected source errors belong in the explanation, without silently repairing the words or altering the label. The host requires this comparison evidence but does not certify that its mathematical argument is true.

Quoted fragments must be contiguous verbatim substrings, including whitespace and newlines after JSON decoding. Ellipses joining separate passages, normalized whitespace and commentary inside a quotation fail validation. The diagnostic identifies each invalid correspondence and field. Model roles receive this contract feedback during their current turn; if a normal completed turn leaves missing or invalid output, the same role thread continues with a correction turn. These corrections have no added turn, time or token cap. Valid unknown reviews are accepted without format resampling. Failed or interrupted sessions remain pending even if an output file exists, and saved replay outputs are validated once without model correction.

Reviewers must compare quantifier dependencies rather than only matching variable names. A group-wide premise and a premise on the current pair have different scope. They also inspect actual structures: an independent `CommRing` used by a subring is not automatically redundant merely because another `Field` argument exists, and a plain function space's product topology does not represent uniform convergence.

Binder order alone does not introduce a dependency: independent universal parameters can be reordered after checking their types and dependencies. This does not permit exchanging universal and existential quantifiers or moving a whole-structure premise onto the current parameters.

Definition and guard differences are assessed within the complete quantified implication and its surrounding assumptions. A counterexample to an isolated subformula may disappear under those assumptions or a trivial boundary case. Equivalent correspondences must give conversions in both directions, state their source reading and assumptions, and cover the relevant boundary cases. Separately proving both full claims or showing only one implication does not certify fidelity; unresolved comparisons remain uncertain.

Valid conversions remain allowed. Examples include reversed equality, replacing a uniquely specified value by its canonical definition, eliminating an independently constructible unused parameter, transporting a subfield along an embedding, or excluding the zero witness using a nonnegativity premise. An extra hypothesis is dispensable only with a valid recovery argument; an unused-looking instance may still affect inferred types.

A domain type change, such as integers to naturals, cannot by itself justify a mismatch. Check whether embeddings, absolute values or other representations preserve the relevant assumptions, operations and conclusion in both directions, including sign and zero boundary cases. The candidate need not contain the transport proof. A valid conversion is allowed; an established semantic difference is a mismatch; an unresolved conversion is uncertain. This does not automatically accept every integer/natural substitution.

Fragment linkage and model-authored conversion arguments help inspect a judgment. They do not certify mathematical equivalence or guarantee a correct semantic verdict. This workflow measures statement review, separately from original theorem proof acceptance.

## Source environments

`standard` and current `mathlib` keep their existing configuration digests. `mathlib-4.8` fixes Lean 4.8.0, Mathlib `b5eba595428809e96f3ed113bc7ba776c5f801ac` and its archived dependency manifest. It uses the legacy `.lake/build/lib` directory. Runtime-owned resource files determine dependency URLs and revisions; candidate source cannot select another package.

Lake 4.8 does not support modern package overrides. Its isolated compiler receives a read-only path manifest pointing to the sealed dependencies; the frozen host Git manifest remains intact.

Prepare the corresponding toolchain and trusted cache before a model run. Pass task-local `ELAN_HOME`, `PATH` and `DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS` through the existing runtime environment configuration. These select local dependencies without editing global Codex or ELAN configuration. Dependencies are sealed and mounted read-only by the existing sandbox; a missing toolchain/cache yields an unavailable observation.

The optional provenance field `sourceMathlibRevision` is an exact commit. Without it, the request records `revisionBasis: runtime-pin-for-source-toolchain`. Source version metadata contains no labels, reference declarations, original source IDs, split names or input filenames.

## Evidence and resume

V2 stores `request.json`, `state.json`, `observations/`, `elaboration/`, `roles/`, `role-receipts/`, `receipts/` and scorer-compatible `decisions.json` outside the source tree. Observation and role output hashes bind the final case receipt. Resume revalidates completed roles and reuses them, including an explicit unknown; it never reruns a completed primary review just because a later recheck was interrupted. Final receipt recovery cannot silently launch missing roles.

New attempts also record every turn and frozen `output-feedback/<attemptId>/` artifacts. Each feedback artifact binds the rejected bytes (or a missing-file observation), validation error and correction message to that role input and turn. Active-turn records show the feedback prepared for steering; a turn may finish before delivery. A completed-turn correction's message digest appears on the next turn. Turn usage snapshots are native cumulative thread usage; count the latest attempt usage once instead of adding the snapshots. Resume checks the archived feedback hashes along with the final output. Feedback checks the output contract and supplies no mathematical verdict.

The host observation is compiled from proof-erased source and records its actual source/environment identity. The existing score's `compileStatus` refers to an exact submitted-source observation, so it remains unknown here. V2 reports `statementObservations` separately. No generated theorem proof is accepted by this workflow.

An omitted `--protocol` resumes the protocol named by the frozen request. An explicit protocol/configuration change requires a new run directory. Old v1 runs retain their single-review contract. Prepared v1 bundles and their base input digests remain valid inputs to either protocol.

The CLI entry remains `--protocol v2`; the frozen request now records `structured-semantic-blind-review-v2-evidence-v1`. Output fields are required, not silently defaulted for old outputs. Earlier v2 runs must resume with their original frozen source/build. Use a new directory for this revision; do not rewrite old requests, outputs, receipts, labels or scores.

## Offline replay

`--execution replay --protocol v2` uses saved observations and role outputs and invokes no Lean compiler, model, provider, profile or credential process. Its strict artifact contains:

```json
{
  "schema": "theorem-os.formalization-review-replay.v2",
  "bundleDigest": "<64 hexadecimal characters>",
  "observations": [],
  "roles": []
}
```

Each observation is the exact saved `observations/<caseId>.json`. Each role entry has `caseId`, `role` (`primary`, `backtranslate`, `recheck`) and the exact corresponding `OUTPUT.json` as `output`. Output digests bind the actual role input, including the snapshot and, for recheck, independent translation. Missing observations or outputs remain pending/unknown and are reported in `caseErrors`. Duplicate or foreign identities are rejected. An unavailable observation is a completed unknown and needs no role outputs.

Injected role or observation adapters mark the entire run as preset evidence. The scorer preserves full denominators and labels these results as integration fixtures. Passing replay and protocol tests does not measure model accuracy.

## Measuring changes

Use the inspected failure cases for development regression. Review suspected annotation errors separately without changing the original labels or published baseline. Compare version matching first, structured correspondence second and targeted independent recheck third; report their coverage, unknowns, false acceptance, false rejection and observed calls alongside label agreement. Verify generalization on a frozen, uninspected source-family-disjoint set. Generated-statement fidelity and final Lean proof acceptance need their own measurements.
