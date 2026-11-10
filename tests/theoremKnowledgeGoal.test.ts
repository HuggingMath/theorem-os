import { describe, expect, it } from 'vitest';
import { knowledgeGoalSurfaceShape as shape, splitIffConclusion, splitStatement, withStatementConclusion } from '../src/solver/theoremKnowledgeGoal';

function same(left: string, right: string) {
  const result = shape(left);
  expect(result).toBeDefined();
  expect(shape(right)).toBe(result);
}

describe('conservative theorem knowledge goal surfaces', () => {
  it('normalizes typed forall names, dependent types, and field receivers', () => {
    same('∀ (p : ℕ) [Fact p.Prime] (χ ψ : DirichletCharacter ℂ (p ^ 2)), χ.IsPrimitive → ¬ ψ.IsPrimitive → χ = χ',
      'forall (primeModulus : Nat) [Fact primeModulus.Prime] (firstCharacter secondCharacter : DirichletCharacter Complex (primeModulus ^ 2)), ' +
      'firstCharacter.IsPrimitive -> ¬ secondCharacter.IsPrimitive -> firstCharacter = firstCharacter');
  });

  it('normalizes nested typed sums without losing outer references', () => {
    same('∀ (p : Nat), (∑ t : Fin p, ∑ u : Fin p, F t u p) = 0',
      '∀ (modulus : Nat), (∑ outerIndex : Fin modulus, ∑ innerIndex : Fin modulus, F outerIndex innerIndex modulus) = 0');
  });

  it('keeps a sum variable out of the following parenthesized expression', () => {
    const left = shape('∀ (p : Nat), (∑ i : Fin p, F i) + i');
    expect(left).toBeDefined();
    expect(shape('∀ (n : Nat), (∑ j : Fin n, F j) + j')).not.toBe(left);
    same('∀ (p : Nat), (∑ i : Fin p, F i) + p', '∀ (n : Nat), (∑ j : Fin n, F j) + n');
  });

  it('normalizes typed products while preserving the quantifier kind', () => {
    same('∏ i : Nat, F i', '∏ index : Nat, F index');
    expect(shape('∏ i : Nat, F i')).not.toBe(shape('∑ i : Nat, F i'));
    expect(shape('∀ i : Nat, F i')).not.toBe(shape('∑ i : Nat, F i'));
  });

  it('preserves qualified constants even when their tail is a bound variable name', () => {
    same('∀ (x : Widget), x.value = Library.x', '∀ (item : Widget), item.value = Library.x');
    expect(shape('∀ (x : Widget), x.value = Library.x')).not.toBe(shape('∀ (item : Widget), item.value = Library.item'));
    expect(shape('∀ (x : Widget), _root_.Library.x = x.value')).not.toBe(shape('∀ (x : Widget), Library.x = x.value'));
  });

  it('does not confuse free-variable capture with a renamed binder', () => {
    const original = shape('∀ (x : Nat), Relation x free');
    expect(original).toBeDefined();
    expect(shape('∀ (free : Nat), Relation free free')).not.toBe(original);
  });

  it('preserves dependency links and argument order', () => {
    same('∀ (n : Nat) (x : Fin n), Relation n x', '∀ (size : Nat) (item : Fin size), Relation size item');
    expect(shape('∀ (n : Nat) (x : Fin n), Relation n x'))
      .not.toBe(shape('∀ (size : Nat) (item : Fin fixed), Relation size item'));
    expect(shape('∀ (x y : Nat), Relation x y')).not.toBe(shape('∀ (a b : Nat), Relation b a'));
  });

  it.each([
    ['∀ (x : Nat), P x', '∀ (y : Int), P y'],
    ['∀ (x : Object), P x', '∀ (y : object), P y'],
    ['∀ (x : Nat), ¬ P x', '∀ (y : Nat), P y'],
    ['∀ (x : Nat), F x = 0', '∀ (y : Nat), F y = 1'],
    ['∀ (x : Nat), x.left = x.right', '∀ (y : Nat), y.right = y.left'],
  ])('preserves types, constants and proposition structure: %s', (left, right) => {
    expect(shape(left)).toBeDefined(); expect(shape(right)).toBeDefined();
    expect(shape(right)).not.toBe(shape(left));
  });

  it('masks comments without erasing string-valued constants into a matching shape', () => {
    same('∀ (x : Nat), /- ignore "text" and ∃ y here -/ P x', '∀ (y : Nat), P y');
    expect(shape('∀ (x : Nat), P "left" x')).toBeUndefined();
    expect(shape('∀ (x : Nat), P "right" x')).toBeUndefined();
  });

  it.each([
    '∀ (x : Nat), ∀ (x : Nat), P x',
    '∀ (x x : Nat), P x',
    '∀ (x : Nat) [x : Class], P x',
    '∀ x, P x',
    '∑ x ∈ S, F x',
    '∑ x : Nat, F x = free',
    '∏ x : Nat, F x ≤ free',
    '∀ (x : Nat), ∃ y : Nat, Relation x y',
    '∀ (x : Nat), (fun x => x) x = x',
    '∀ (x : Nat), (x : Nat) → P x',
    '∀ (x : Nat), {x : Nat // P x}',
    '∀ (x : Nat), let x := 0; P x',
    '∀ (x : Nat), if P x then Q x else R x',
    '∀ (x : Nat), P «quoted» x',
    '∀ (x : Nat], P x',
    'x : Nat\n⊢ P x',
    'P x',
  ])('declines unsupported or ambiguous binding syntax: %s', goal => {
    expect(shape(goal)).toBeUndefined();
  });
});

describe('closed theorem knowledge statement reading', () => {
  it('keeps an eventually scoped lower bound opaque instead of inventing a forall binder', () => {
    const type = '∀ C : ℝ, 0 < C → ∀ᶠ n : ℕ in Filter.atTop, Even n → ∀ r : ℕ, 0 < r → ' +
      'OAI.PerfectMatchingPSD.HasFactorization n r → (n : ℝ) ^ C < (r : ℝ)';
    expect(splitStatement(type)).toBeUndefined();
    expect(shape(type)).toBeUndefined();
    expect(withStatementConclusion(type, 'Replacement n r')).toBeUndefined();
  });

  it.each([
    '∀ᶠ n in Filter.atTop, P n → Q n',
    '∃ᶠ n in Filter.atTop, P n → Q n',
    '∀ (μ : Measure α), ∀ᵐ x ∂μ, P x → Q x',
    '∀ (s : Set ℕ), (∀ᶠ n in Filter.atTop, n ∈ s) → Result s',
  ])('declines unsupported scoped quantifier notation without deriving local premises: %s', type => {
    expect(splitStatement(type)).toBeUndefined();
    expect(shape(type)).toBeUndefined();
    expect(withStatementConclusion(type, 'Replacement')).toBeUndefined();
  });

  it('retains ordinary forall binders, including names separated from the quantifier', () => {
    expect(splitStatement('∀n : Nat, P n')).toEqual(splitStatement('forall n : Nat, P n'));
    expect(splitStatement('∀ ᶠ : Nat, P ᶠ')).toMatchObject({
      parts: [{ key: 'Nat', binder: true }], conclusion: 'P _b0',
    });
    same('∀ (x : Nat), /- ∀ᶠ and ∀ᵐ -/ P x', '∀ (n : Nat), P n');
  });

  it('reads ASCII forall like its Unicode form, including nested quantifiers and arrow premises', () => {
    const unicode = splitStatement('∀ {n : Nat} (p : Fin n → Prop), ∀ (x : Fin n), p x → Result n x');
    expect(unicode).toBeDefined();
    expect(unicode!.conclusion).toBe('Result _b0 _b2');
    expect(splitStatement('forall {n : Nat} (p : Fin n → Prop), forall (x : Fin n), p x -> Result n x')).toEqual(unicode);
    expect(splitStatement('∀ {n : Nat} (p : Fin n → Prop), forall (x : Fin n), p x → Result n x')).toEqual(unicode);
    expect(splitStatement('A → forall (x : Nat), B x → C x')).toEqual(splitStatement('A → ∀ (x : Nat), B x → C x'));
  });

  it('preserves qualified forall names and names that only start with forall', () => {
    expect(splitStatement('forall (x : Foo.forall), Foo.forall x → Foo.forall_result x')).toEqual(
      splitStatement('∀ (x : Foo.forall), Foo.forall x → Foo.forall_result x'));
    expect(splitStatement('Foo.forall x → P x')).toMatchObject({
      parts: [{ key: 'Foo.forall x', binder: false }], conclusion: 'P x',
    });
    expect(splitStatement('forallResult → Foo.forall')).toMatchObject({
      parts: [{ key: 'forallResult', binder: false }], conclusion: 'Foo.forall',
    });
  });

  it('preserves iff and existential scope when ASCII forall is present', () => {
    expect(splitStatement('forall (n : Nat), A n → B n ↔ C n')).toEqual(splitStatement('∀ (n : Nat), A n → B n ↔ C n'));
    expect(splitStatement('A → forall x, B x ↔ C')).toMatchObject({
      parts: [{ key: 'A' }, { key: '?', binder: true }], conclusion: 'B _b0 ↔ C',
    });
    expect(splitStatement('forall (n : Nat), (exists m, Relation n m) → P n')).toEqual(
      splitStatement('∀ (n : Nat), (exists m, Relation n m) → P n'));
    expect(splitStatement('A → exists x, B x → C')).toMatchObject({
      parts: [{ key: 'A' }], conclusion: 'exists x, B x → C',
    });
  });

  it.each(['forall x', 'forall ⟨a, b⟩ : Nat × Nat, a = b'])('declines unsupported ASCII binding syntax: %s', type => {
    expect(splitStatement(type)).toBeUndefined();
  });
});

describe('statement context for auxiliary retrieval', () => {
  it.each(['forall', '∀'])('preserves original names and implicit and instance brackets after %s', quantifier => {
    const prefix = `${quantifier} {Ω : Type*} [Fintype Ω] [DecidableEq Ω] (P : Matrix Ω Ω ℝ) ` +
      '(hP : P ∈ Matrix.rowStochastic ℝ Ω) (x : Ω), ';
    const replacement = 'TheoremOS.InformationTheory.IsDistribution (P x)';
    expect(withStatementConclusion(prefix + 'TheoremOS.Probability.prob (P x) Finset.univ = 1', replacement))
      .toBe(prefix + replacement);
  });

  it('keeps nested quantifiers and arrow premises with their original local names', () => {
    const prefix = '∀ (n : Nat), P n → forall (x : Fin n), (hx : Q x) → ';
    expect(withStatementConclusion(prefix + 'Original n x', 'Replacement n x')).toBe(prefix + 'Replacement n x');
    expect(withStatementConclusion('A -> B -> Original', 'Replacement')).toBe('A → B → Replacement');
  });

  it('keeps qualified forall identifiers in the original context', () => {
    const prefix = 'forall (x : Foo.forall), Foo.forall x → ';
    expect(withStatementConclusion(prefix + 'Original x', 'Replacement x')).toBe(prefix + 'Replacement x');
  });

  it('replaces a whole scoped conclusion without taking its arrows as local hypotheses', () => {
    expect(withStatementConclusion('forall (x : Nat), A x → B x ↔ C x', 'Replacement x'))
      .toBe('forall (x : Nat), Replacement x');
    expect(withStatementConclusion('A → exists x, B x → C x', 'Replacement')).toBe('A → Replacement');
    expect(withStatementConclusion('Original', 'Replacement')).toBe('Replacement');
  });

  it.each(['forall x', 'forall ⟨a, b⟩ : Nat × Nat, a = b'])('declines an unsupported context: %s', type => {
    expect(withStatementConclusion(type, 'Replacement')).toBeUndefined();
  });
});

describe('top-level iff conclusions for direct library applications', () => {
  it('reads ASCII and parenthesized iff sides without splitting their internal arrows', () => {
    expect(splitIffConclusion(' (( P n → Q n ) <-> (R n)) ')).toEqual(['P n → Q n', 'R n']);
    expect(splitIffConclusion('(∀ x, P x ↔ Q x) ↔ (∃ y, R y)'))
      .toEqual(['∀ x, P x ↔ Q x', '∃ y, R y']);
    expect(splitIffConclusion('P ↔ ∀ x, Q x ↔ R x')).toEqual(['P', '∀ x, Q x ↔ R x']);
  });

  it.each([
    '(P ↔ Q) ∧ R', '∀ x, P x ↔ Q x', 'exists x, P x ↔ Q x', '∑ x, P x ↔ Q x',
    'P ↔ Q ↔ R', 'P ↔', '↔ Q',
  ])('does not turn a nested, scoped or incomplete iff into a direct application: %s', conclusion => {
    expect(splitIffConclusion(conclusion)).toBeUndefined();
  });
});
