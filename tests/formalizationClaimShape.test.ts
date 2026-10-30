/**
 * Behavioural tests for the plan-stage shape lint.
 *
 * The landing point is the plan loop in `src/solver/formalization.ts`: a hit sends
 * the planner a rewriting instruction instead of spending generation tokens on a
 * wording the official checker cannot link. Those four shapes were each decided in
 * the plan during the v4 run and each scored False under the official beq_plus
 * check, so the numbers are recall and false-positive counts on real cases, not
 * hypotheticals.
 *
 * A hit is a prediction about linking, never a verdict on the mathematics. These
 * tests therefore also pin the counterexamples that a broad reading of the same
 * property would wrongly reject.
 */

import { describe, expect, it } from 'vitest';
import { claimShapeAdvice, claimShapeHits, claimShapeRejection,
  formalizationClaimText } from '../src/math/formalizationClaimShape';

const GROUP = 'theorem thm {G : Type*} [Group G] (a b : G) : ';
const CENTER = 'theorem thm {G : Type*} [Group G] {H : Type*} [Group H] : ';
const MODULE = 'theorem thm {K V : Type*} [Field K] [Infinite K] [AddCommGroup V] [Module K V] ';
const IDEAL = 'theorem thm {I : Ideal GaussianInt} (hI : I ≠ ⊥) : ';
const rules = (text: string) => claimShapeHits(text).map(hit => hit.rule);
const planOf = (...conclusions: string[]) =>
  ({ conclusions: conclusions.map(mathematics => ({ mathematics })) });

describe('the four shapes the v4 run got marked wrong, next to a source-faithful wording', () => {
  it('catches grouping parentheses inside a product chain', () => {
    // Official beq_plus: False. The source names the conjugating element itself.
    expect(rules(GROUP + '∃ g : G, b * a = g * (a * b) * g⁻¹')).toEqual(['R1_grouping_in_product_chain']);
    // Official: True. No parentheses, so nothing to unfold differently.
    expect(rules(GROUP + '∃ g : G, b * a = g * a * b * g⁻¹')).toEqual([]);
  });

  it('catches a subobject equality where the source asks for an isomorphism', () => {
    expect(rules(CENTER + 'Subgroup.center (G × H) = (Subgroup.center G).prod (Subgroup.center H)'))
      .toEqual(['R3_derived_operation']);
    expect(rules(CENTER + 'Nonempty (center (G × H) ≃* (center G) × (center H))')).toEqual([]);
  });

  it('catches a finite family encoded as a Finset of subobjects', () => {
    expect(rules('theorem thm {F V : Type*} [Field F] [AddCommGroup V] [Module F V] : '
      + '∃ (s : Finset (Subspace F V)), (∀ p ∈ s, p ≠ ⊤) ∧ (⋃ p ∈ s, (p : Set V)) ≠ ⊤'))
      .toEqual(['R2_finset_of_subobjects']);
    expect(rules(MODULE + '∃ (ι : Type*) (_ : Fintype ι) (γ : ι → Submodule K V), '
      + '(∀ i, γ i ≠ ⊤) ∧ (⋃ i, (γ i : Set V)) ≠ ⊤')).toEqual([]);
  });

  it('catches an existential over the ambient type instead of the subobject', () => {
    expect(rules(IDEAL + '∃ z : ℤ, z ≠ 0 ∧ (z : GaussianInt) ∈ I')).toEqual(['R4_ambient_existential']);
    expect(rules(IDEAL + '∃ (z : I), z ≠ 0 ∧ (z : GaussianInt).im = 0')).toEqual([]);
  });
});

describe('the rules stay silent on wordings the official checker accepts', () => {
  const accepted = [
    GROUP + '∃ g : G, g * a * b * g⁻¹ = b * a',
    GROUP + '∃ g, b * a = g * a * b * g⁻¹',
    CENTER + 'Nonempty (Subgroup.center (G × H) ≃* Subgroup.center G × Subgroup.center H)',
    MODULE + '∃ (ι : Type*) (_ : Fintype ι) (γ : ι → Submodule K V), '
      + '(∀ i, γ i ≠ ⊤) ∧ (⋃ i, (γ i : Set V)) ≠ Set.univ',
  ];
  for (const text of accepted) it('leaves alone ' + text.slice(0, 44) + '…', () => expect(rules(text)).toEqual([]));
});

describe('rules that a broad reading of the same property would break', () => {
  it('does not treat a parenthesis in argument position as a grouping', () => {
    expect(rules('theorem t {G : Type*} [Group G] (a b : G) : orderOf (a * b) = 1')).toEqual([]);
  });

  it('does not treat the associativity law as a wrong grouping', () => {
    // The grouped term sits at the start of the chain, so `*` is only on its right.
    expect(rules('theorem t {G : Type*} [Group G] (a b c : G) : (a * b) * c = a * (b * c)')).toEqual([]);
  });

  it('does not treat a Finset of members as a finite family of subobjects', () => {
    expect(rules('theorem t {α : Type*} (s : Finset α) (h : s.Nonempty) : s.card ≠ 0')).toEqual([]);
  });

  it('does not treat an existential over the subobject as an ambient one', () => {
    expect(rules('theorem t {I : Ideal ℤ} (hI : I ≠ ⊥) : ∃ (z : I), z ≠ 0')).toEqual([]);
  });
});

describe('a hit carries a stable rule id and the fragment a re-planning message can quote', () => {
  it('quotes the offending subexpression', () => {
    const hits = claimShapeHits(GROUP + '∃ g : G, b * a = g * (a * b) * g⁻¹');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.fragment).toBe('(a * b)');
  });

  it('fires at most once per rule, even when the shape repeats', () => {
    expect(rules(GROUP + '∧ b * (a * b) * a = a * (b * a) * b')).toEqual(['R1_grouping_in_product_chain']);
  });

  it('reports every distinct shape in rule order', () => {
    const text = GROUP + '∃ g : G, b * a = g * (a * b) * g⁻¹ ∧ IsConj a b ∧ '
      + '∃ z : ℤ, z ≠ 0 ∧ (z : GaussianInt) ∈ I';
    expect(rules(text)).toEqual(['R1_grouping_in_product_chain', 'R4_ambient_existential', 'R5_bundled_relation']);
  });

  it('does not infer a grouping from a bundled relation', () => {
    // `IsConj (a * b) (b * a)` has `*` only inside each argument, so R1 must stay
    // silent: those two parenthesised groups are arguments, not a chain.
    expect(rules(GROUP + 'IsConj (a * b) (b * a)')).toEqual(['R5_bundled_relation']);
  });

  it('has rewriting advice for every rule it can report', () => {
    for (const rule of ['R1_grouping_in_product_chain', 'R2_finset_of_subobjects', 'R3_derived_operation',
      'R4_ambient_existential', 'R5_bundled_relation']) expect(claimShapeAdvice[rule]!.length).toBeGreaterThan(20);
  });
});

describe('the plan text is the conclusions, joined the way the prototype measured them', () => {
  it('normalizes whitespace and joins conclusions in order', () => {
    expect(formalizationClaimText(planOf('For every  natural\n n, n + 0 = n.', 'And 0 + n = n.')))
      .toBe('For every natural n, n + 0 = n. | And 0 + n = n.');
  });

  it('lints what the planner wrote, not the source statement', () => {
    // An accepted plan produces no rejection, so the loop proceeds to generation.
    expect(claimShapeRejection(planOf('For every natural n, n + 0 = n.'))).toBeUndefined();
  });

  it('names each rule, quotes its fragment and says the mathematics is not judged', () => {
    const rejection = claimShapeRejection(planOf('The source says IsConj (a * b) (b * a).'))!;
    expect(rejection).toContain('formalization_plan_claim_shape');
    expect(rejection).toContain('R5_bundled_relation');
    expect(rejection).toContain('IsConj');
    expect(rejection).toContain('not a claim that the mathematics is wrong');
  });

  it('does not name an infrastructure failure, which would abort the run instead of re-planning', () => {
    // The plan loop re-plans on a plain error but rethrows on a name matching the
    // infrastructure regex; a wrong name here would turn advice into a dead run.
    const rejection = claimShapeRejection(planOf('The source says IsConj a b.'))!;
    expect(rejection).not.toMatch(/formalization_(?:sandbox|relay|profile|build|retrieval|checkpoint|fidelity_comparison_interrupted)/u);
    expect(rejection).not.toMatch(/math_codex_/u);
  });
});
