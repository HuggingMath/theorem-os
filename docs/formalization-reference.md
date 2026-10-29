# Conservative Lean reference correspondence

`compareFormalizationReference` adds advisory evidence when a reviewed Lean reference statement is available. It checks a complete, explicit mapping of at most 16 candidate/reference theorem targets in a fresh local comparison directory. It never calls a model or downloads dependencies. The environment uses the runtime's pinned standard library or Mathlib and its existing sandboxed Lean diagnostics path.

This implementation borrows the reference comparison and baseline-guard ideas from [BEq+](https://github.com/augustepoiroux/LeanInteract/blob/768e18ebcb5c7ec34d308768a785389eeac37798/examples/beq_plus.py), but implements a narrower check independently. The legacy method `cardinality-correspondence-v5` accepts definitionally identical closed propositions or bijective binder permutations with definitionally identical domains and conclusions, including binder renaming, rigid universe-parameter renaming and reducible definitions. It additionally applies closed, host-owned representation conversions for conjugacy, finite families, the exact prime-product cardinality template below, and the final `Bool.false` proposition; it does not reproduce BEq+'s tactic search. New task-fidelity-v2 requests use `cardinality-correspondence-v6`, which also supports the exact center-of-product equality/isomorphism correspondence, strict proper finite conditions, and a fixed nonzero finite-cardinality value. Target binders must be explicit in the declaration: section `variable`/`include`/`omit` commands are unsupported because Lean generalizes them differently for theorem and definition commands. Unsupported source syntax and transformations outside the fixed rules yield `not-established`. New receipts also expose `check: completed | unsupported | unavailable`, separating an actual unresolved comparison from unsupported input and compiler/dependency/cancellation failures. None means that the statements are inequivalent.

Universe parameters are renamed consistently in first-use order within each closed proposition, and remain universally quantified in the generated proof declarations. They are never specialized to level zero or replaced by solvable metavariables. Two independent universes stay distinct; a candidate ranging over two independent universes does not match a reference restricted to one shared universe. The final Lean kernel checks the polymorphic implication declarations at their full declared universes.

The host first erases every supplied theorem proof. It replaces theorem headers by definitions returning `Prop`, preserves supported complete definitions and scopes, and wraps the candidate and reference in separate modules and namespaces. No source theorem is admitted as an axiom or `sorry`. A trusted query reconstructs each closed universal proposition from its predicate value and checks definitional equality. It also matches all explicit universal binders bijectively using only target-local variables: matched domain types and the final conclusions must be definitionally equal. On this structural path no binder may be dropped or reused. It adds two kernel-checked declarations of the form `oppositeProposition → targetProposition`, whose structural-path proofs consist only of lambda abstraction and application of the opposite proposition to the matched variables. The implication argument is the only additional assumption. The structural path performs no theorem search or premise synthesis, and no path uses a proof obtained from a previously admitted source theorem. If the structural path does not match, the implementation may apply the fixed representation conversions described below; callers never supply rules or tactics.

Before accepting, the query rejects a limited family of independent baseline proofs: conclusions that reduce to `True`, reflexive equalities, conclusions already present as a local proposition assumption, and a local assumption reducing to `False`. This catches the tautological `(p : Prop) (h : p) : p` and explicit false-premise cases. It does not detect every inconsistent or redundant hypothesis. Definitional equality after bijective binder matching provides the additional conservative restriction: two unrelated provable propositions are not accepted merely because both are true. Missing correspondence proofs remain unknown.

The receipt records raw source hashes, exact generated source/configuration text and hashes, the pinned environment digest, the Lean tool identity, complete hashed diagnostic captures and results for both directions. The query emits its result as a Lean JSON diagnostic as well as a local JSON file; receipt validation binds that result to the exact compiled query capture. The validator recomputes source/configuration identities and rejects changed, truncated or duplicate evidence. Synthetic unit fixtures are not native Lean evidence. Native integration tests require `THEOREMOS_TEST_REFERENCE_LEAN=1` and use the actual sandbox path.

`status: "established"` means conservative structural or fixed-rule representation correspondence to the supplied reference. It does not prove that the reference or candidate faithfully expresses the natural-language problem. Semantic model review remains required; a reviewed reference also needs its own provenance. Receipts carry `semanticEquivalenceClaimed: false` and `proofVerified: false`. The comparison directory is temporary advisory evidence and must never be imported by the final native problem or proof workspace. Subsequent proof search still requires independent S3 acceptance of the frozen statement.


## Proved representation conversion

The first representation rule handles `IsConj x y` and the corresponding existential conjugation equation for arbitrary group elements. It admits multiplication reassociation and equation orientation only within the recognized conjugation expression. It does not invoke the theorem that the products `a*b` and `b*a` are conjugate, and cannot replace arbitrary provable goals by `True`. Outer parameters must still match bijectively with rigid universes and preserved dependencies. Two kernel-checked implications relate the original complete propositions.

A proof of an arbitrary `P ↔ Q` is insufficient evidence of statement correspondence: two unrelated true statements can be separately proved. Only the fixed representation templates and their structural matching are allowed here. Cardinality transformations outside the exact prime-product and fixed nonzero-value templates below remain outside these rules. The v2 center-of-product template is described below; it does not generalize to arbitrary ambient subgroup equality versus abstract isomorphism.

The query report records whether representation conversion was used and its trace. The trace is bound to the exact host-generated query and captured Lean report; it is explanatory evidence, not a user-supplied proof or a substitute for native compilation. The receipt retains `proofVerified:false` and `semanticEquivalenceClaimed:false`.

## Receipt versions

The legacy current method is `cardinality-correspondence-v5`, with receipt schema `theoremos.formalization-reference.v4` and report schema `theoremos.reference-report.v4`. New task-fidelity-v2 requests use `cardinality-correspondence-v6`, receipt schema `theoremos.formalization-reference.v5` and report schema `theoremos.reference-report.v5`; this path adds the host-owned proper finite condition, fixed nonzero finite cardinality, and center-product conversions below. Saved schema-v1/method-v2, schema-v2/method-v3 and schema-v3/method-v4 receipts retain their frozen generators and validators. In particular, existing `finite-family-correspondence-v4` and task-fidelity-v1/cardinality-correspondence-v5 receipts keep their original bytes and use their frozen implementation; they are not relabeled or regenerated with current rules. Changing a receipt's schema or method is not a migration.

### Finite-family reindexing

For arbitrary types α and β, object condition P, set-valued map U, and set property Q, the host proves the equivalence between:

- `∀ s : Finset α, (∀ a ∈ s, P a) → Q (⋃ a ∈ s, U a)`
- `∀ (ι : Type v) [Fintype ι] (f : ι → α), (∀ i, P (f i)) → Q (⋃ i, U (f i))`

The fixed theorem uses the image of a finite family in one direction and a `Fin s.card` enumeration lifted with `ULift` in the other. Empty families and repeated objects are covered. The index universe stays independent of the object and set universes; this proved conversion eliminates that quantified index without unifying outer universes. The remaining outer binders and universes still require structural correspondence.

Only an exactly matching quantified suffix is converted. The matcher extracts P, U and Q without proving them, rejects extra dependencies, and checks the full suffix against the fixed theorem. Both original complete proposition implications are kernel checked. The `finite-family-reindex` trace records a `forall-suffix` position, before/after expressions, the preserved outer context, index universe and closed proof terms. The standalone theorem uses a fixed `simp only` list for set membership identities; callers supply no rules or proof programs.

### Prime-product cardinality

For an arbitrary type α and arbitrary property `Q : ℕ → ℕ → Prop`, the host uses the fixed equivalence between:

- `∀ [Fintype α] (p q : ℕ), _root_.Prime p → _root_.Prime q → Fintype.card α = p * q → Q p q`
- `∀ (p q : ℕ), Nat.Prime p → Nat.Prime q → Nat.card α = p * q → Q p q`

The matcher recognizes exactly the six binders on the first side: the `Fintype α` instance, p, q, the two prime assumptions, and the cardinality equality. Q is the entire remaining proposition, so it may contain further implications and depend on p, q and preserved outer parameters. It must not depend on the removed finite instance or assumption proofs. The matcher rejects extra dependencies and checks the complete suffix against the fixed theorem before using it. Outer binders and rigid universes still require structural correspondence.

The conversion uses `Nat.prime_iff` for the two prime predicates. Their nonzero consequences prove `p * q ≠ 0`; together with the given cardinality equality, this proves `Nat.card α ≠ 0` and hence `Finite α`. Only then does the fixed proof construct a `Fintype α` instance and relate the two cardinalities with `Nat.card_eq_fintype_card`. This finite instance is derived inside the checked conversion, not added as an assumption. The nonzero step is necessary because infinite types have `Nat.card α = 0`. There is no general finite-instance synthesis or arbitrary arithmetic search.

The rule has no group assumption and does not use a theorem about groups of order p*q or prove Q. Full original propositions are related by two kernel-checked implications. The trace retains the fixed suffix conversion, its context, expression identities and proof terms. Other binder arrangements, cardinality expressions and prime predicates are supported only when they match this fixed template definitionally; otherwise correspondence remains unknown.

### Proper finite subobjects

The v6 task-fidelity path also recognizes the exact Finset suffix
`∀ s, (∀ a ∈ s, a < ⊤) → Q s` and converts it to
`∀ s, (∀ a ∈ s, a ≠ ⊤) → Q s` with the host-owned Lean theorem
`finiteProperFinsetIff`. The theorem requires only `PartialOrder` and `OrderTop`,
and the matcher rejects conclusions that depend on the premise proof or any
condition other than strictness against top. The resulting trace uses
`finite-proper-condition`; it is then eligible for the existing finite-family
reindexing rule. Non-strict conditions such as `a ≤ ⊤` remain unsupported.

### Fixed nonzero finite cardinality

The v6 task-fidelity path recognizes the suffix
`∀ [Fintype α], Fintype.card α = n → Q` when `n` is a closed natural-number
expression for which the Lean kernel can prove `n ≠ 0`. It converts it to
`Nat.card α = n → Q`. The conversion derives `Finite α` from the nonzero
cardinality before constructing `Fintype.ofFinite α`, and rejects conclusions
that depend on the removed finite instance or cardinality proof. Zero values,
open or unproved nonzero expressions, and instance-dependent conclusions remain
unsupported. The trace uses `finite-cardinality-value` with the
`cardinality-nonzero` side condition.

### Center of a product group

The v2 task-fidelity path recognizes the exact equality
`Subgroup.center (G × H) = (Subgroup.center G).prod (Subgroup.center H)` and relates it to
`Nonempty (Subgroup.center (G × H) ≃* (Subgroup.center G) × (Subgroup.center H))`.
The fixed Lean theorem constructs the multiplicative equivalence from the subgroup equality
using `Subgroup.prodEquiv`; in the reverse direction it uses `Subgroup.center_prod`.
Only this center-product template is accepted, with outer binders preserved. The trace uses
`group-center-product`, records the full conclusion and its closed bidirectional proof, and has
no side conditions. Other subgroup equalities and abstract isomorphisms remain unsupported.

### Boolean false as a proposition

Lean's lowercase `false` can elaborate as `Bool.false` coerced to `Prop`, namely `Bool.false = Bool.true`. A separate fixed theorem relates this proposition to `False`. The host converts only this recognized final leaf and lifts the proof through the preserved universal binders. It does not evaluate arbitrary Boolean conditions or turn arbitrary contradictory propositions into `False`. The usual `¬ P` and `P → False` already match definitionally; this rule handles the distinct Boolean coercion.

These conversions establish representation correspondence only. They do not certify natural-language fidelity, prove the original theorem, or replace semantic reviewer approval and independent S3 proof acceptance. A completed `not-established` comparison remains unknown, not evidence that either statement is wrong.

The programmatic interface is:

```ts
const receipt = await compareFormalizationReference(freshDirectory, {
  candidateSource,
  referenceSource,
  environment: 'standard', // or the pinned 'mathlib'
  pairs: [{ candidateTarget: 'Candidate.answer', referenceTarget: 'Reference.answer' }],
}, { env: process.env, timeoutMs: 60_000 });
```

Both target lists must be covered exactly once. Existing directories, symlink destinations, malformed input and invalid budgets are rejected before the comparison starts. Source or context restrictions produce a saved `not-established` receipt. The returned receipt can be validated without running Lean using `assertFormalizationReferenceResult(input, receipt)`; this checks saved evidence integrity and bindings, not an independent kernel replay.
