import Mathlib

/-!
# Finite root sets and polynomial determination

An original TheoremOS interface for counting roots in a prescribed finite set,
recovering factors from roots, and determining a polynomial from finitely many
values. The interfaces use ordinary evaluations and natural-number degree bounds.
Root counting requires the polynomial to be nonzero. General results work over
an integral domain; existence of arbitrary interpolants is stated over a field.

Sources: these interfaces and their assembly were written for TheoremOS. The
underlying root-counting, factor and degree theorems are from Mathlib's
`Algebra/Polynomial/Roots.lean`, `Algebra/Polynomial/Div.lean`,
`Algebra/Polynomial/BigOperators.lean`, and `Algebra/Polynomial/Derivative.lean`.
The interpolation construction is Mathlib's `Lagrange.interpolate` in
`LinearAlgebra/Lagrange.lean`. The mathematics is standard polynomial algebra:
the factor theorem, the degree bound for distinct roots, and Lagrange
interpolation; see S. Lang, *Algebra*, revised 3rd ed., Springer, 2002, Chapter II.

Bridges: use `card_eval_eq_zero_le_natDegree` to bound zeros among a finite set of
test points, and `eq_of_many_equal_values` when two polynomials have a common
degree bound. `prod_X_sub_C_dvd_iff` and `prod_X_sub_C_dvd_sub_iff` turn vanishing
or agreement on that set into divisibility by its product of linear factors.
If the set contains as many distinct roots as the degree, the factorization,
constant coefficient and root-derivative interfaces use the same hypotheses.
-/

namespace TheoremOS.Algebra.PolynomialRoots

open Polynomial Finset
open scoped BigOperators

noncomputable section

section Domain

variable {R : Type*} [CommRing R] [IsDomain R] [DecidableEq R]

/-- A nonzero polynomial has at most its degree many zeros in any finite set. -/
theorem card_eval_eq_zero_le_natDegree (p : R[X]) (S : Finset R) (hp : p ≠ 0) :
    (S.filter fun x => p.eval x = 0).card ≤ p.natDegree := by
  apply Polynomial.card_le_degree_of_subset_roots
  intro x hx
  exact (Polynomial.mem_roots hp).mpr (Finset.mem_filter.mp hx).2

/-- Two different polynomials agree at at most the larger of their degrees many points. -/
theorem card_eval_eq_eval_le_max_natDegree (p q : R[X]) (S : Finset R) (hpq : p ≠ q) :
    (S.filter fun x => p.eval x = q.eval x).card ≤ max p.natDegree q.natDegree := by
  have hfilter : (S.filter fun x => p.eval x = q.eval x) =
      (S.filter fun x => (p - q).eval x = 0) := by
    ext x
    simp only [Finset.mem_filter, Polynomial.eval_sub, sub_eq_zero]
  rw [hfilter]
  exact (card_eval_eq_zero_le_natDegree (p - q) S (sub_ne_zero.mpr hpq)).trans
    (Polynomial.natDegree_sub_le p q)

/-- All but at most `natDegree p` points of a sample have nonzero evaluation. -/
theorem card_sub_natDegree_le_card_eval_ne_zero (p : R[X]) (S : Finset R) (hp : p ≠ 0) :
    S.card - p.natDegree ≤ (S.filter fun x => p.eval x ≠ 0).card := by
  have hbound := card_eval_eq_zero_le_natDegree p S hp
  have hsplit : (S.filter fun x => p.eval x = 0).card +
      (S.filter fun x => p.eval x ≠ 0).card = S.card := by
    simpa only [ne_eq] using
      (Finset.card_filter_add_card_filter_not (s := S) (fun x => p.eval x = 0))
  omega

/-- A finite sample detects disagreement except at at most the larger degree many points. -/
theorem card_sub_max_natDegree_le_card_eval_ne (p q : R[X]) (S : Finset R) (hpq : p ≠ q) :
    S.card - max p.natDegree q.natDegree ≤ (S.filter fun x => p.eval x ≠ q.eval x).card := by
  have hbound := card_eval_eq_eval_le_max_natDegree p q S hpq
  have hsplit : (S.filter fun x => p.eval x = q.eval x).card +
      (S.filter fun x => p.eval x ≠ q.eval x).card = S.card := by
    simpa only [ne_eq] using
      (Finset.card_filter_add_card_filter_not (s := S) (fun x => p.eval x = q.eval x))
  omega

/-- A sample larger than the degree contains a point where a nonzero polynomial does not vanish. -/
theorem exists_eval_ne_zero_of_card_gt (p : R[X]) (S : Finset R) (hp : p ≠ 0)
    (hcard : p.natDegree < S.card) : ∃ x ∈ S, p.eval x ≠ 0 := by
  by_contra h
  have hzero : ∀ x ∈ S, p.eval x = 0 := by
    intro x hx
    by_contra hne
    exact h ⟨x, hx, hne⟩
  exact hp (Polynomial.eq_zero_of_natDegree_lt_card_of_eval_eq_zero' p S hzero hcard)

/-- A sufficiently large sample distinguishes different polynomials. -/
theorem exists_eval_ne_of_card_gt (p q : R[X]) (S : Finset R) (hpq : p ≠ q)
    (hcard : max p.natDegree q.natDegree < S.card) : ∃ x ∈ S, p.eval x ≠ q.eval x := by
  obtain ⟨x, hx, hne⟩ := exists_eval_ne_zero_of_card_gt (p - q) S
    (sub_ne_zero.mpr hpq) ((Polynomial.natDegree_sub_le p q).trans_lt hcard)
  exact ⟨x, hx, by simpa only [Polynomial.eval_sub, sub_ne_zero] using hne⟩

omit [DecidableEq R] in
/-- Vanishing on more than a known degree bound forces the zero polynomial. -/
theorem eq_zero_of_many_roots (p : R[X]) (S : Finset R) {d : ℕ}
    (hdegree : p.natDegree ≤ d) (hcard : d < S.card)
    (heval : ∀ x ∈ S, p.eval x = 0) : p = 0 :=
  Polynomial.eq_zero_of_natDegree_lt_card_of_eval_eq_zero' p S heval
    (hdegree.trans_lt hcard)

omit [DecidableEq R] in
/-- A common natural-number degree bound gives a convenient finite evaluation test for equality. -/
theorem eq_of_many_equal_values (p q : R[X]) (S : Finset R) {d : ℕ}
    (hpdegree : p.natDegree ≤ d) (hqdegree : q.natDegree ≤ d) (hcard : d < S.card)
    (heval : ∀ x ∈ S, p.eval x = q.eval x) : p = q :=
  Polynomial.eq_of_natDegree_lt_card_of_eval_eq' p q S heval
    ((max_le hpdegree hqdegree).trans_lt hcard)

/-- The evaluation test also accepts an injective family of nodes indexed by a finite set. -/
theorem eq_of_many_indexed_values {ι : Type*} (p q : R[X]) (I : Finset ι) (v : ι → R)
    {d : ℕ} (hv : Set.InjOn v I) (hpdegree : p.natDegree ≤ d)
    (hqdegree : q.natDegree ≤ d) (hcard : d < I.card)
    (heval : ∀ i ∈ I, p.eval (v i) = q.eval (v i)) : p = q := by
  apply eq_of_many_equal_values p q (I.image v) hpdegree hqdegree
  · simpa only [Finset.card_image_of_injOn hv] using hcard
  · intro x hx
    obtain ⟨i, hi, rfl⟩ := Finset.mem_image.mp hx
    exact heval i hi

/-- A polynomial vanishes on a finite set exactly when its distinct linear root factors divide it. -/
theorem prod_X_sub_C_dvd_iff (p : R[X]) (S : Finset R) :
    (∏ a ∈ S, (X - C a)) ∣ p ↔ ∀ a ∈ S, p.eval a = 0 := by
  constructor
  · intro hdvd a ha
    have hfactor : X - C a ∣ ∏ b ∈ S, (X - C b) := Finset.dvd_prod_of_mem _ ha
    exact Polynomial.dvd_iff_isRoot.mp (hfactor.trans hdvd)
  · intro heval
    by_cases hp : p = 0
    · simp only [hp, dvd_zero]
    have hroots : S.val ≤ p.roots := Finset.val_le_iff_val_subset.mpr fun a ha =>
      (Polynomial.mem_roots hp).mpr (heval a ha)
    exact (Multiset.prod_X_sub_C_dvd_iff_le_roots hp S.val).mpr hroots

/-- Agreement on a sample is equivalent to divisibility of the difference by its node polynomial. -/
theorem prod_X_sub_C_dvd_sub_iff (p q : R[X]) (S : Finset R) :
    (∏ a ∈ S, (X - C a)) ∣ p - q ↔ ∀ a ∈ S, p.eval a = q.eval a := by
  simp only [prod_X_sub_C_dvd_iff, Polynomial.eval_sub, sub_eq_zero]

/-- Factoring distinct roots gives a nonzero quotient and subtracts exactly their number from degree. -/
theorem exists_quotient_of_roots (p : R[X]) (S : Finset R) (hp : p ≠ 0)
    (heval : ∀ a ∈ S, p.eval a = 0) :
    ∃ q : R[X], q ≠ 0 ∧ p = (∏ a ∈ S, (X - C a)) * q ∧
      q.natDegree + S.card = p.natDegree := by
  obtain ⟨q, hq⟩ := (prod_X_sub_C_dvd_iff p S).mpr heval
  have hq0 : q ≠ 0 := by
    intro hzero
    exact hp (by simpa only [hzero, mul_zero] using hq)
  refine ⟨q, hq0, hq, ?_⟩
  have hprod0 : (∏ a ∈ S, (X - C a) : R[X]) ≠ 0 :=
    Finset.prod_ne_zero_iff.mpr fun a _ => Polynomial.X_sub_C_ne_zero a
  have hdegree := congrArg Polynomial.natDegree hq
  rw [Polynomial.natDegree_mul hprod0 hq0,
    Polynomial.natDegree_finsetProd_X_sub_C_eq_card] at hdegree
  omega

/-- A full set of distinct roots determines every factor, with the leading coefficient as scalar. -/
theorem eq_leadingCoeff_mul_prod_of_roots (p : R[X]) (S : Finset R)
    (hdegree : p.natDegree = S.card) (heval : ∀ a ∈ S, p.eval a = 0) :
    p = C p.leadingCoeff * ∏ a ∈ S, (X - C a) := by
  apply Polynomial.eq_leadingCoeff_mul_of_monic_of_dvd_of_natDegree_le
    (Polynomial.monic_prod_X_sub_C id S) ((prod_X_sub_C_dvd_iff p S).mpr heval)
  simpa only [Polynomial.natDegree_finsetProd_X_sub_C_eq_card] using hdegree.le

/-- A monic polynomial with a full set of distinct roots is their product of linear factors. -/
theorem monic_eq_prod_of_roots (p : R[X]) (S : Finset R) (hp : p.Monic)
    (hdegree : p.natDegree = S.card) (heval : ∀ a ∈ S, p.eval a = 0) :
    p = ∏ a ∈ S, (X - C a) := by
  simpa only [hp.leadingCoeff, map_one, one_mul] using
    eq_leadingCoeff_mul_prod_of_roots p S hdegree heval

/-- The product of a full set of distinct roots determines the constant coefficient. -/
theorem coeff_zero_eq_prod_roots (p : R[X]) (S : Finset R)
    (hdegree : p.natDegree = S.card) (heval : ∀ a ∈ S, p.eval a = 0) :
    p.coeff 0 = p.leadingCoeff * ((-1) ^ S.card * ∏ a ∈ S, a) := by
  have h := congrArg (fun f : R[X] => f.eval 0)
    (eq_leadingCoeff_mul_prod_of_roots p S hdegree heval)
  rw [Polynomial.coeff_zero_eq_eval_zero]
  simp only [Polynomial.eval_mul, Polynomial.eval_C, Polynomial.eval_prod,
    Polynomial.eval_sub, Polynomial.eval_X, zero_sub] at h
  rw [Finset.prod_neg] at h
  exact h

/-- At a root in a full distinct root set, the derivative is the product of all root differences. -/
theorem eval_derivative_at_root (p : R[X]) (S : Finset R)
    (hdegree : p.natDegree = S.card) (heval : ∀ a ∈ S, p.eval a = 0)
    {x : R} (hx : x ∈ S) :
    p.derivative.eval x = p.leadingCoeff * ∏ a ∈ S.erase x, (x - a) := by
  have hfactor := eq_leadingCoeff_mul_prod_of_roots p S hdegree heval
  conv_lhs => rw [hfactor, ← Finset.mul_prod_erase S (fun a => X - C a) hx]
  simp only [Polynomial.derivative_mul,
    Polynomial.derivative_sub, Polynomial.derivative_X, Polynomial.derivative_C,
    sub_zero, one_mul, Polynomial.eval_mul, Polynomial.eval_add,
    Polynomial.eval_sub, Polynomial.eval_X, Polynomial.eval_C,
    Polynomial.eval_prod, sub_self, zero_mul, add_zero, zero_add]

/-- A nonzero polynomial whose full root set is distinct has nonzero derivative at every root. -/
theorem eval_derivative_ne_zero_of_roots (p : R[X]) (S : Finset R) (hp : p ≠ 0)
    (hdegree : p.natDegree = S.card) (heval : ∀ a ∈ S, p.eval a = 0)
    {x : R} (hx : x ∈ S) : p.derivative.eval x ≠ 0 := by
  rw [eval_derivative_at_root p S hdegree heval hx]
  apply mul_ne_zero (Polynomial.leadingCoeff_ne_zero.mpr hp)
  exact Finset.prod_ne_zero_iff.mpr fun a ha =>
    sub_ne_zero.mpr (Finset.mem_erase.mp ha).1.symm

/-- Two monic polynomials sharing a full set of distinct roots are equal. -/
theorem monic_eq_of_same_roots (p q : R[X]) (S : Finset R) (hp : p.Monic) (hq : q.Monic)
    (hpdegree : p.natDegree = S.card) (hqdegree : q.natDegree = S.card)
    (hpeval : ∀ a ∈ S, p.eval a = 0) (hqeval : ∀ a ∈ S, q.eval a = 0) : p = q := by
  rw [monic_eq_prod_of_roots p S hp hpdegree hpeval,
    monic_eq_prod_of_roots q S hq hqdegree hqeval]

end Domain

section Field

variable {K : Type*} [Field K] [DecidableEq K]

/-- A low-degree polynomial matching given data equals the Lagrange interpolant. -/
theorem eq_interpolate_of_natDegree_le (p : K[X]) (S : Finset K) (values : K → K) {d : ℕ}
    (hdegree : p.natDegree ≤ d) (hcard : d < S.card)
    (heval : ∀ a ∈ S, p.eval a = values a) : p = Lagrange.interpolate S id values := by
  apply Lagrange.eq_interpolate_of_eval_eq values Function.injective_id.injOn
  · exact (Polynomial.degree_le_of_natDegree_le hdegree).trans_lt
      (WithBot.coe_lt_coe.mpr hcard)
  · exact heval

/-- Arbitrary data at `d+1` distinct nodes have a unique interpolating polynomial of degree at most `d`. -/
theorem existsUnique_interpolant (S : Finset K) (values : K → K) {d : ℕ}
    (hcard : S.card = d + 1) :
    ∃! p : K[X], p.natDegree ≤ d ∧ ∀ a ∈ S, p.eval a = values a := by
  let p := Lagrange.interpolate S id values
  have hdegree : p.natDegree ≤ d := by
    apply Polynomial.natDegree_le_of_degree_le
    simpa only [hcard, Nat.add_sub_cancel] using
      (Lagrange.degree_interpolate_le values (s := S) Function.injective_id.injOn)
  refine ⟨p, ⟨hdegree, ?_⟩, ?_⟩
  · intro a ha
    exact Lagrange.eval_interpolate_at_node values Function.injective_id.injOn ha
  · intro q hq
    exact eq_interpolate_of_natDegree_le q S values hq.1 (by omega) hq.2

end Field

end

end TheoremOS.Algebra.PolynomialRoots
