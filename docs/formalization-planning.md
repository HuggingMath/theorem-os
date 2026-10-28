# Formalization planning contract

`src/math/formalizationPlan.ts` records a model-authored inventory before Lean statement generation. The version is `theorem-os.formalization-plan.v1`. All objects are strict Zod objects. Each collection contains at most 256 records, every record has a unique safe ID, and each mathematical record links to one or more original source spans.

`spans` use zero-based UTF-16 offsets in the parsed `INPUT.statement` string with an exclusive end: `statement.slice(start, end) === text`. These are not positions in the `INPUT.json` file, escaped JSON text, UTF-8 bytes or Unicode code points. Parse the input, copy the exact excerpt, compute `start = statement.indexOf(text)` (selecting the intended occurrence when repeated), compute `end = start + text.length`, and check the slice before submitting. Preserve whitespace and punctuation. An astral character such as `🧮` occupies two UTF-16 code units. A span cannot split a surrogate pair. Spans may overlap, but duplicate ranges are rejected. The frozen original can contain up to 256 KiB of valid UTF-8 text; validation never truncates it.

The plan fields are:

- `taskKind`: `prove`, `decision`, or `construction`.
- `spans`: `{ id, start, end, text }`.
- `objects`: `{ id, spanIds, description, leanType }`.
- `assumptions`: `{ id, spanIds, mathematics }`.
- `conclusions`: `{ id, spanIds, mathematics, targetNames, assumptionIds }`.
- `definitions`: `{ id, spanIds, mathematics, implementation, leanNames, dependsOn, justification }`.
- `unresolved`: `{ id, spanIds, description }`.

Every conclusion names at least one theorem/lemma to generate; `targetNames` never lists library constants, classes, definitions or dependencies. Several conclusion records may map to the same target, for example when one theorem captures multiple source sentences. `dependsOn` contains definition IDs and must form a DAG. `assumptionIds` contains assumption IDs. References within a record cannot be repeated or dangling. Target names and definition mappings must use the same ordinary qualified Lean names admitted by the existing source inspector. Use canonical names without a `_root_.` prefix.

Run these checks in order:

```ts
assertFormalizationPlan(frozenStatement, plan);
assertFormalizationPlanReady(plan);
assertFormalizationPlanCandidate(plan, candidate.source, candidate.coverage);
```

The first check validates structure and exact source binding, including unresolved plans retained for repair. The readiness check requires `taskKind === 'prove'` and an empty `unresolved` list. Decision and construction tasks remain unsupported until the runtime has an explicit answer contract. A theorem of `P ∨ ¬ P` does not supply the answer to a decision question.

Candidate validation first applies the existing conservative source admission. Every admitted theorem/lemma must map to a conclusion, and every planned target must occur in the source. Every new definition name must resolve to an actual non-target declaration. Conversely, every local `def`, `abbrev`, and named `instance` must be planned as `implementation: 'new'`. Existing definitions represent imported constants and cannot claim local declarations or target theorems. Separate existing-definition records may cite the same imported constant for distinct source meanings; all record IDs, source mappings and dependency edges remain intact. A name belonging to a new definition must be unique across all definition records, including existing mappings.

Coverage retains the existing `{ originalText, targetNames, explanation }` format. Copy every planned conclusion span's `text` verbatim into an item with that conclusion's `targetNames`; this supplies complete coverage without guessing excerpts or retyping punctuation. Only generated theorem/lemma names belong in `targetNames`. Together the items for each target must contain all its full conclusion spans. Larger original paragraphs remain valid. Supplemental exact excerpts may be narrower than a conclusion span, but must map to a conclusion of every named target; separate definition and domain excerpts belong in the assumptions or definition notes. The caller must also perform the existing original-text coverage check against the frozen statement.

Planner prompts should ask the model to:

1. Identify whether the source requests a proof, a yes/no answer, or a construction. Preserve that task kind.
2. Record every domain, quantifier, object, assumption and conclusion explicitly in the relevant prose fields. Keep target names stable across candidate repair.
3. Inventory definitions, distinguish existing library declarations from new local ones, explain reuse, and list definition dependencies.
4. Link each record to exact source excerpts with correct UTF-16 offsets. Prefer focused conclusion excerpts that fit the candidate coverage field.
5. Put missing definitions, ambiguous conventions or uncertain dependencies in `unresolved`, then repair the plan before generating Lean.
6. Plan each conclusion at the type the source gives it, in the most unfolded form that still names the same mathematics. An unrestricted carrier is not pinned to `Type`, a finiteness condition is a `Fintype` instance with `Fintype.card` rather than a `Nat.card` hypothesis, a natural-number predicate is named at its nat-specific constant such as `Nat.Prime`, and a sameness with no common ambient object is `Nonempty` of the structure equivalence. A relation between two given objects is planned as the explicit equation with its own witness rather than as a bundled library relation that hides the quantifier, keeping the source operand order and association and adding no grouping parentheses. Official ProofNet# BEq+ measurements on the reference test cases separate these spellings: `Fintype.card` with `Nat.Prime` passes where `Nat.card` or the general `Prime` does not, a `Fintype`-indexed family passes where a `Finset`-indexed one does, the existential conjugation equation passes in both directions where `IsConj` fails every step, and `Nonempty` of the center product equivalence passes where the subgroup equality fails. An equivalent claim in another association, orientation or behind a library definition is not related by definitional unfolding, so the rule is the source's own form, not the shortest equivalent statement Lean accepts.

These checks establish record integrity and source/declaration binding. They do not establish that the model discovered every relevant definition, dependency, quantifier, or assumption. Lean elaboration and independent semantic comparison remain required. The mathematical prose, claimed imported names and `dependsOn` edges still need review.

An explicitly configured [frozen Mathlib corpus](formalization-retrieval.md) can supply lookup hints after the ready-plan check. Query provenance links existing definition names and object type tokens to these plan IDs. Retrieval does not alter the plan or certify its library choices; only generation receives its assembled hints.
