# Formalization planning contract

`src/math/formalizationPlan.ts` records a model-authored inventory before Lean statement generation. The version is `theorem-os.formalization-plan.v1`. All objects are strict Zod objects. Each collection contains at most 256 records, every record has a unique safe ID, and each mathematical record links to one or more original source spans.

`spans` use zero-based UTF-16 offsets with an exclusive end: `statement.slice(start, end) === text`. Preserve whitespace and punctuation. These are JavaScript string offsets, so an astral character such as `🧮` occupies two code units. A span cannot split a surrogate pair. Spans may overlap, but duplicate ranges are rejected. The frozen original can contain up to 256 KiB of valid UTF-8 text; validation never truncates it.

The plan fields are:

- `taskKind`: `prove`, `decision`, or `construction`.
- `spans`: `{ id, start, end, text }`.
- `objects`: `{ id, spanIds, description, leanType }`.
- `assumptions`: `{ id, spanIds, mathematics }`.
- `conclusions`: `{ id, spanIds, mathematics, targetNames, assumptionIds }`.
- `definitions`: `{ id, spanIds, mathematics, implementation, leanNames, dependsOn, justification }`.
- `unresolved`: `{ id, spanIds, description }`.

Every conclusion names at least one target. Several conclusion records may map to the same target, for example when one theorem captures multiple source sentences. `dependsOn` contains definition IDs and must form a DAG. `assumptionIds` contains assumption IDs. References cannot be repeated or dangling. Target names and definition mappings must use the same ordinary qualified Lean names admitted by the existing source inspector. Use canonical names without a `_root_.` prefix.

Run these checks in order:

```ts
assertFormalizationPlan(frozenStatement, plan);
assertFormalizationPlanReady(plan);
assertFormalizationPlanCandidate(plan, candidate.source, candidate.coverage);
```

The first check validates structure and exact source binding, including unresolved plans retained for repair. The readiness check requires `taskKind === 'prove'` and an empty `unresolved` list. Decision and construction tasks remain unsupported until the runtime has an explicit answer contract. A theorem of `P ∨ ¬ P` does not supply the answer to a decision question.

Candidate validation first applies the existing conservative source admission. Every admitted theorem/lemma must map to a conclusion, and every planned target must occur in the source. Every new definition name must resolve to an actual non-target declaration. Conversely, every local `def`, `abbrev`, and named `instance` must be planned as `implementation: 'new'`. Existing definitions represent imported constants and cannot claim local declarations or target theorems.

Coverage retains the existing `{ originalText, targetNames, explanation }` format. Each coverage item must contain an exact conclusion span for each target it names; together the items for each target must contain all its conclusion spans. Larger original paragraphs remain valid. The caller must also perform the existing original-text coverage check against the frozen statement.

Planner prompts should ask the model to:

1. Identify whether the source requests a proof, a yes/no answer, or a construction. Preserve that task kind.
2. Record every domain, quantifier, object, assumption and conclusion explicitly in the relevant prose fields. Keep target names stable across candidate repair.
3. Inventory definitions, distinguish existing library declarations from new local ones, explain reuse, and list definition dependencies.
4. Link each record to exact source excerpts with correct UTF-16 offsets. Prefer focused conclusion excerpts that fit the candidate coverage field.
5. Put missing definitions, ambiguous conventions or uncertain dependencies in `unresolved`, then repair the plan before generating Lean.

These checks establish record integrity and source/declaration binding. They do not establish that the model discovered every relevant definition, dependency, quantifier, or assumption. Lean elaboration and independent semantic comparison remain required. The mathematical prose, claimed imported names and `dependsOn` edges still need review.

An explicitly configured [frozen Mathlib corpus](formalization-retrieval.md) can supply lookup hints after the ready-plan check. Query provenance links existing definition names and object type tokens to these plan IDs. Retrieval does not alter the plan or certify its library choices; only generation receives its assembled hints.
