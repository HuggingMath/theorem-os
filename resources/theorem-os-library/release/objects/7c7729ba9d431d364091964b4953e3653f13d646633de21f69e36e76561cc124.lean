import Submission.Library.TheoremOS.Probability.FiniteProbability

/-!
# Covariance and finite second-moment calculus

An original TheoremOS interface for real random variables on a finite probability space.
It reuses `InformationTheory.IsDistribution`, `Probability.expectation`, and
`Probability.variance`; it introduces only the centred covariance. The main interfaces
cover affine changes of variables, finite sums, pairwise uncorrelated summands,
Cauchy–Schwarz for covariance, second moments of sums, and bounded-variable variance.
Every identity that requires weights of total mass one carries `hp : IsDistribution p`.
The finite-sum expectation identity also works for arbitrary real weights.

Sources and provenance: this module and its finite-probability API were written for
TheoremOS; it is not presented as an imported upstream module. The mathematical facts
are standard: see G. Grimmett and D. Stirzaker, *Probability and Random Processes*,
3rd ed., Oxford University Press, 2001, Chapter 3 (expectation, covariance, and variance),
and the bounded-variable inequality of T. Popoviciu, *Sur les équations algébriques
ayant toutes leurs racines réelles*, Mathematica 9 (1935), 129–145. Proofs use the
existing finite-probability module and Mathlib's finite Cauchy–Schwarz theorem
`Finset.sum_mul_sq_le_sq_mul_sq` from
`Mathlib/Algebra/Order/BigOperators/Ring/Finset.lean`, together with real square roots.

Bridges: `covariance p X Y` is the expectation of
`(X - expectation p X) * (Y - expectation p Y)`. Use `covariance_eq` for the raw mixed
moment `E[XY] - E[X]E[Y]`. `variance_sum_eq_sum_of_covariance_zero` needs pairwise zero
covariance, so it can be applied after proving the relevant mixed moments factor.
`second_moment_sum_le` and `variance_sum_le_card_mul_sum` require no independence.
For a count of events use `covariance_indicator` and `variance_indicator` to turn
the moment calculations into event and intersection probabilities.
-/

namespace TheoremOS.Probability.FiniteMoments

open Finset
open TheoremOS.InformationTheory
open scoped BigOperators

noncomputable section

variable {Ω : Type*} [Fintype Ω] {p : Ω → ℝ}

/-- Covariance under the finite weights `p`, defined by centred variables. -/
def covariance (p X Y : Ω → ℝ) : ℝ :=
  expectation p (fun ω => (X ω - expectation p X) * (Y ω - expectation p Y))

/-- The mean of an affine change of a random variable. -/
theorem expectation_affine (hp : IsDistribution p) (X : Ω → ℝ) (a b : ℝ) :
    expectation p (fun ω => a * X ω + b) = a * expectation p X + b := by
  change expectation p ((fun ω => a * X ω) + (fun _ => b)) = _
  rw [expectation_add, expectation_const_mul, expectation_const hp]

/-- Expectation commutes with a finite sum; normalization of `p` is unnecessary. -/
theorem expectation_sum {ι : Type*} (p : Ω → ℝ) (I : Finset ι) (X : ι → Ω → ℝ) :
    expectation p (fun ω => ∑ i ∈ I, X i ω) = ∑ i ∈ I, expectation p (X i) := by
  unfold expectation
  simp_rw [Finset.mul_sum]
  exact Finset.sum_comm

/-- The mixed-moment formula for covariance. -/
theorem covariance_eq (hp : IsDistribution p) (X Y : Ω → ℝ) :
    covariance p X Y = expectation p (fun ω => X ω * Y ω) -
      expectation p X * expectation p Y := by
  have hfun : (fun ω => (X ω - expectation p X) * (Y ω - expectation p Y)) =
      (fun ω => X ω * Y ω) - (fun ω => expectation p Y * X ω) -
        (fun ω => expectation p X * Y ω) +
          (fun _ => expectation p X * expectation p Y) := by
    funext ω
    simp only [Pi.add_apply, Pi.sub_apply]
    ring
  rw [covariance, hfun, expectation_add, expectation_sub, expectation_sub,
    expectation_const_mul, expectation_const_mul, expectation_const hp]
  ring

theorem covariance_comm (hp : IsDistribution p) (X Y : Ω → ℝ) :
    covariance p X Y = covariance p Y X := by
  simp only [covariance_eq hp, mul_comm]

/-- The covariance of a variable with itself is its variance. -/
theorem covariance_self (hp : IsDistribution p) (X : Ω → ℝ) :
    covariance p X X = variance p X := by
  rw [covariance_eq hp, variance_eq hp]
  ring

theorem covariance_const_left (hp : IsDistribution p) (c : ℝ) (X : Ω → ℝ) :
    covariance p (fun _ => c) X = 0 := by
  rw [covariance_eq hp, expectation_const_mul, expectation_const hp]
  ring

theorem covariance_add_left (hp : IsDistribution p) (X Y Z : Ω → ℝ) :
    covariance p (fun ω => X ω + Y ω) Z = covariance p X Z + covariance p Y Z := by
  simp only [covariance_eq hp, expectation, add_mul, mul_add,
    Finset.sum_add_distrib]
  ring

theorem covariance_const_mul_left (hp : IsDistribution p) (a : ℝ) (X Y : Ω → ℝ) :
    covariance p (fun ω => a * X ω) Y = a * covariance p X Y := by
  rw [covariance_eq hp, covariance_eq hp]
  have hfun : (fun ω => a * X ω * Y ω) = (fun ω => a * (X ω * Y ω)) := by
    funext ω
    ring
  rw [hfun, expectation_const_mul, expectation_const_mul]
  ring

theorem covariance_add_right (hp : IsDistribution p) (X Y Z : Ω → ℝ) :
    covariance p X (fun ω => Y ω + Z ω) = covariance p X Y + covariance p X Z := by
  rw [covariance_comm hp X, covariance_add_left hp,
    covariance_comm hp Y X, covariance_comm hp Z X]

theorem covariance_const_mul_right (hp : IsDistribution p) (a : ℝ) (X Y : Ω → ℝ) :
    covariance p X (fun ω => a * Y ω) = a * covariance p X Y := by
  rw [covariance_comm hp X, covariance_const_mul_left hp, covariance_comm hp Y X]

/-- Independent affine changes scale covariance by the product of their slopes. -/
theorem covariance_affine (hp : IsDistribution p) (X Y : Ω → ℝ) (a b c d : ℝ) :
    covariance p (fun ω => a * X ω + b) (fun ω => c * Y ω + d) =
      a * c * covariance p X Y := by
  unfold covariance
  rw [expectation_affine hp, expectation_affine hp]
  have hfun :
      (fun ω => (a * X ω + b - (a * expectation p X + b)) *
        (c * Y ω + d - (c * expectation p Y + d))) =
      (fun ω => (a * c) *
        ((X ω - expectation p X) * (Y ω - expectation p Y))) := by
    funext ω
    ring
  rw [hfun, expectation_const_mul]

/-- Subtracting the mean from one variable preserves its covariance. -/
theorem covariance_center_left (hp : IsDistribution p) (X Y : Ω → ℝ) :
    covariance p (fun ω => X ω - expectation p X) Y = covariance p X Y := by
  simpa only [one_mul, add_zero, sub_eq_add_neg] using
    covariance_affine hp X Y 1 (-expectation p X) 1 0

theorem covariance_sum_left (hp : IsDistribution p) {ι : Type*}
    (I : Finset ι) (X : ι → Ω → ℝ) (Y : Ω → ℝ) :
    covariance p (fun ω => ∑ i ∈ I, X i ω) Y = ∑ i ∈ I, covariance p (X i) Y := by
  classical
  induction I using Finset.induction_on with
  | empty => simpa only [Finset.sum_empty] using covariance_const_left hp 0 Y
  | @insert i I hi ih =>
    simp only [Finset.sum_insert hi]
    rw [covariance_add_left hp, ih]

theorem covariance_sum_right (hp : IsDistribution p) {ι : Type*}
    (I : Finset ι) (X : Ω → ℝ) (Y : ι → Ω → ℝ) :
    covariance p X (fun ω => ∑ i ∈ I, Y i ω) = ∑ i ∈ I, covariance p X (Y i) := by
  rw [covariance_comm hp X, covariance_sum_left hp]
  exact Finset.sum_congr rfl fun i _ => covariance_comm hp (Y i) X

/-- Variance is invariant under translations and scales quadratically. -/
theorem variance_affine (hp : IsDistribution p) (X : Ω → ℝ) (a b : ℝ) :
    variance p (fun ω => a * X ω + b) = a ^ 2 * variance p X := by
  rw [← covariance_self hp, covariance_affine hp, covariance_self hp]
  ring

/-- The variance of a sum, retaining the covariance term. -/
theorem variance_add (hp : IsDistribution p) (X Y : Ω → ℝ) :
    variance p (fun ω => X ω + Y ω) = variance p X + variance p Y + 2 * covariance p X Y := by
  rw [← covariance_self hp, covariance_add_left hp,
    covariance_add_right hp, covariance_add_right hp,
    covariance_self hp, covariance_self hp, covariance_comm hp Y X]
  ring

theorem variance_sub (hp : IsDistribution p) (X Y : Ω → ℝ) :
    variance p (fun ω => X ω - Y ω) = variance p X + variance p Y - 2 * covariance p X Y := by
  have hneg : variance p (fun ω => -Y ω) = variance p Y := by
    simpa using variance_affine hp Y (-1) 0
  have hcov : covariance p X (fun ω => -Y ω) = -covariance p X Y := by
    simpa using covariance_const_mul_right hp (-1) X Y
  simp_rw [sub_eq_add_neg]
  rw [variance_add hp, hneg, hcov]
  ring

/-- A sum's variance is the sum of all entries of its covariance matrix. -/
theorem variance_sum_eq_sum_covariance (hp : IsDistribution p) {ι : Type*}
    (I : Finset ι) (X : ι → Ω → ℝ) :
    variance p (fun ω => ∑ i ∈ I, X i ω) =
      ∑ i ∈ I, ∑ j ∈ I, covariance p (X i) (X j) := by
  rw [← covariance_self hp, covariance_sum_left hp]
  exact Finset.sum_congr rfl fun i _ => covariance_sum_right hp I (X i) X

/-- Pairwise uncorrelated summands have additive variance; independence is unnecessary. -/
theorem variance_sum_eq_sum_of_covariance_zero (hp : IsDistribution p) {ι : Type*}
    (I : Finset ι) (X : ι → Ω → ℝ)
    (hcov : ∀ i ∈ I, ∀ j ∈ I, i ≠ j → covariance p (X i) (X j) = 0) :
    variance p (fun ω => ∑ i ∈ I, X i ω) = ∑ i ∈ I, variance p (X i) := by
  classical
  rw [variance_sum_eq_sum_covariance hp]
  refine Finset.sum_congr rfl fun i hi => ?_
  calc ∑ j ∈ I, covariance p (X i) (X j) = covariance p (X i) (X i) :=
      Finset.sum_eq_single_of_mem i hi fun j hj hji => hcov i hi j hj hji.symm
    _ = variance p (X i) := covariance_self hp (X i)

/-- Cauchy–Schwarz for centred finite random variables. -/
theorem covariance_sq_le (hp : IsDistribution p) (X Y : Ω → ℝ) :
    covariance p X Y ^ 2 ≤ variance p X * variance p Y := by
  have hsqrt : ∀ ω, Real.sqrt (p ω) ^ 2 = p ω := fun ω => Real.sq_sqrt (hp.nonneg ω)
  have hprod : ∀ ω,
      (Real.sqrt (p ω) * (X ω - expectation p X)) *
        (Real.sqrt (p ω) * (Y ω - expectation p Y)) =
      p ω * ((X ω - expectation p X) * (Y ω - expectation p Y)) := fun ω => by
    calc _ = Real.sqrt (p ω) ^ 2 *
        ((X ω - expectation p X) * (Y ω - expectation p Y)) := by ring
      _ = _ := by rw [hsqrt]
  have h := Finset.sum_mul_sq_le_sq_mul_sq Finset.univ
    (fun ω => Real.sqrt (p ω) * (X ω - expectation p X))
    (fun ω => Real.sqrt (p ω) * (Y ω - expectation p Y))
  simp only [hprod, mul_pow, hsqrt] at h
  exact h

theorem abs_covariance_le_sqrt (hp : IsDistribution p) (X Y : Ω → ℝ) :
    |covariance p X Y| ≤ Real.sqrt (variance p X * variance p Y) := by
  exact Real.le_sqrt_of_sq_le (by simpa only [sq_abs] using covariance_sq_le hp X Y)

/-- A useful bound when no sign or independence information about the covariance is known. -/
theorem variance_add_le (hp : IsDistribution p) (X Y : Ω → ℝ) :
    variance p (fun ω => X ω + Y ω) ≤ 2 * (variance p X + variance p Y) := by
  have h := variance_nonneg hp.nonneg (fun ω => X ω - Y ω)
  rw [variance_sub hp] at h
  rw [variance_add hp]
  linarith

/-- Bias–variance decomposition of the mean squared error about a deterministic centre. -/
theorem expectation_sub_const_sq_eq_variance (hp : IsDistribution p) (X : Ω → ℝ) (c : ℝ) :
    expectation p (fun ω => (X ω - c) ^ 2) = variance p X + (expectation p X - c) ^ 2 := by
  rw [expectation_sub_const_sq hp, variance_eq hp]
  ring

/-- The mean minimizes the second moment about a deterministic centre. -/
theorem variance_le_second_moment_about (hp : IsDistribution p) (X : Ω → ℝ) (c : ℝ) :
    variance p X ≤ expectation p (fun ω => (X ω - c) ^ 2) := by
  rw [expectation_sub_const_sq_eq_variance hp]
  exact le_add_of_nonneg_right (sq_nonneg _)

/-- A second-moment bound for a finite sum, requiring no independence or centering. -/
theorem second_moment_sum_le (hp : IsDistribution p) {ι : Type*}
    (I : Finset ι) (X : ι → Ω → ℝ) :
    expectation p (fun ω => (∑ i ∈ I, X i ω) ^ 2) ≤
      (I.card : ℝ) * ∑ i ∈ I, expectation p (fun ω => X i ω ^ 2) := by
  calc expectation p (fun ω => (∑ i ∈ I, X i ω) ^ 2)
      ≤ expectation p (fun ω => (I.card : ℝ) * ∑ i ∈ I, X i ω ^ 2) :=
        expectation_mono hp.nonneg fun ω => by
          simpa using Finset.sum_mul_sq_le_sq_mul_sq I (fun _ => (1 : ℝ)) (fun i => X i ω)
    _ = (I.card : ℝ) * ∑ i ∈ I, expectation p (fun ω => X i ω ^ 2) := by
      rw [expectation_const_mul, expectation_sum]

/-- A finite sum's variance is at most its number of terms times the sum of their variances. -/
theorem variance_sum_le_card_mul_sum (hp : IsDistribution p) {ι : Type*}
    (I : Finset ι) (X : ι → Ω → ℝ) :
    variance p (fun ω => ∑ i ∈ I, X i ω) ≤
      (I.card : ℝ) * ∑ i ∈ I, variance p (X i) := by
  have h := second_moment_sum_le hp I (fun i ω => X i ω - expectation p (X i))
  simpa only [variance, expectation_sum, Finset.sum_sub_distrib] using h

/-- Popoviciu's inequality for a finite distribution and a variable valued in `[a,b]`. -/
theorem variance_le_of_mem_Icc (hp : IsDistribution p) (X : Ω → ℝ) (a b : ℝ)
    (hX : ∀ ω, X ω ∈ Set.Icc a b) : variance p X ≤ (b - a) ^ 2 / 4 := by
  have hsecond : expectation p (fun ω => X ω ^ 2) ≤
      (a + b) * expectation p X - a * b := by
    calc expectation p (fun ω => X ω ^ 2) ≤
        expectation p (fun ω => (a + b) * X ω - a * b) :=
          expectation_mono hp.nonneg fun ω => by
            have hx := hX ω
            nlinarith [mul_nonneg (sub_nonneg.mpr hx.1) (sub_nonneg.mpr hx.2)]
      _ = (a + b) * expectation p X - a * b := by
        simpa only [sub_eq_add_neg] using expectation_affine hp X (a + b) (-(a * b))
  rw [variance_eq hp]
  nlinarith [sq_nonneg (expectation p X - (a + b) / 2)]

/-- The covariance of two event indicators is the event-intersection excess. -/
theorem covariance_indicator [DecidableEq Ω] (hp : IsDistribution p) (s t : Finset Ω) :
    covariance p (fun ω => if ω ∈ s then 1 else 0) (fun ω => if ω ∈ t then 1 else 0) =
      prob p (s ∩ t) - prob p s * prob p t := by
  rw [covariance_eq hp, ← prob_eq_expectation_indicator p s,
    ← prob_eq_expectation_indicator p t, prob_eq_expectation_indicator p (s ∩ t)]
  congr 1
  congr 1
  funext ω
  by_cases hs : ω ∈ s <;> by_cases ht : ω ∈ t <;> simp [hs, ht]

/-- A Bernoulli indicator has variance `P(A)(1-P(A))`. -/
theorem variance_indicator [DecidableEq Ω] (hp : IsDistribution p) (s : Finset Ω) :
    variance p (fun ω => if ω ∈ s then 1 else 0) = prob p s * (1 - prob p s) := by
  rw [← covariance_self hp, covariance_indicator hp, Finset.inter_self]
  ring

end

end TheoremOS.Probability.FiniteMoments
