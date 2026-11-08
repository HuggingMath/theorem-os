import Mathlib

/-!
# Finite weighted sums, variance, and product bounds

Original interfaces for real-valued functions on a `Finset`: weighted Cauchy–Schwarz and
mean-square bounds, expansion and minimization of the centered sum of squares, the pairwise
variance identity, covariance and absolute-deviation bounds, bounded-range variance, and finite
product estimates. The conclusions retain the original sums and products; no new mean or variance
definition must be unfolded before using a theorem.

Sources: these interfaces and their combination proofs were written for TheoremOS. The underlying
finite Cauchy–Schwarz and AM–GM results are from Mathlib's
`Mathlib/Algebra/Order/BigOperators/Ring/Finset.lean` and
`Mathlib/Analysis/MeanInequalities.lean`; exponential bounds use
`Mathlib/Analysis/SpecialFunctions/Exp.lean`. Mathematical background: G. H. Hardy, J. E.
Littlewood and G. Pólya, *Inequalities*, 2nd ed., Cambridge University Press, 1952 (Cauchy–Schwarz
and arithmetic–geometric means); T. Popoviciu, *Sur les équations algébriques ayant toutes leurs
racines réelles*, Mathematica 9 (1935), 129–145 (the bounded-range variance inequality);
R. Bhatia and C. Davis, *A Better Bound on the Variance*, Amer. Math. Monthly 107 (2000), 353–357.
The variance identities below are direct finite-sum algebra. No benchmark-specific facts are used.
-/

namespace TheoremOS.Analysis.FiniteInequalities

open Finset
open scoped BigOperators

variable {ι : Type*}

/-- Cauchy–Schwarz with nonnegative, not necessarily normalized, weights. -/
theorem weighted_cauchy_sq (s : Finset ι) (w x y : ι → ℝ)
    (hw : ∀ i ∈ s, 0 ≤ w i) :
    (∑ i ∈ s, w i * x i * y i) ^ 2 ≤
      (∑ i ∈ s, w i * x i ^ 2) * ∑ i ∈ s, w i * y i ^ 2 := by
  apply sum_sq_le_sum_mul_sum_of_sq_le_mul s
    (fun i hi => mul_nonneg (hw i hi) (sq_nonneg _))
    (fun i hi => mul_nonneg (hw i hi) (sq_nonneg _))
  intro i _
  exact le_of_eq (by ring)

/-- The square of a weighted sum is controlled by its mass times its second moment. -/
theorem weighted_sum_sq_le (s : Finset ι) (w x : ι → ℝ)
    (hw : ∀ i ∈ s, 0 ≤ w i) :
    (∑ i ∈ s, w i * x i) ^ 2 ≤ (∑ i ∈ s, w i) * ∑ i ∈ s, w i * x i ^ 2 := by
  simpa using weighted_cauchy_sq s w (fun _ => 1) x hw

/-- The unweighted sum-of-squares bound in cardinality form, including the empty set. -/
theorem sum_sq_le_card_mul_sum_sq (s : Finset ι) (x : ι → ℝ) :
    (∑ i ∈ s, x i) ^ 2 ≤ (s.card : ℝ) * ∑ i ∈ s, x i ^ 2 := by
  simpa using weighted_sum_sq_le s (fun _ => 1) x (by intros; norm_num)

/-- Weighted absolute first moment versus the weighted second moment. -/
theorem weighted_sum_abs_sq_le (s : Finset ι) (w x : ι → ℝ)
    (hw : ∀ i ∈ s, 0 ≤ w i) :
    (∑ i ∈ s, w i * |x i|) ^ 2 ≤ (∑ i ∈ s, w i) * ∑ i ∈ s, w i * x i ^ 2 := by
  simpa only [sq_abs] using weighted_sum_sq_le s w (fun i => |x i|) hw

/-- An `ℓ¹`–`ℓ²` comparison with no square roots in the statement. -/
theorem sum_abs_sq_le_card_mul_sum_sq (s : Finset ι) (x : ι → ℝ) :
    (∑ i ∈ s, |x i|) ^ 2 ≤ (s.card : ℝ) * ∑ i ∈ s, x i ^ 2 := by
  simpa using weighted_sum_abs_sq_le s (fun _ => 1) x (by intros; norm_num)

/-- Mean-square domination for weights of total mass one. -/
theorem weighted_mean_sq_le (s : Finset ι) (w x : ι → ℝ)
    (hw : ∀ i ∈ s, 0 ≤ w i) (hW : ∑ i ∈ s, w i = 1) :
    (∑ i ∈ s, w i * x i) ^ 2 ≤ ∑ i ∈ s, w i * x i ^ 2 := by
  simpa only [hW, one_mul] using weighted_sum_sq_le s w x hw

/-- Mean-square domination with normalization left in the original quotient form. -/
theorem normalized_weighted_mean_sq_le (s : Finset ι) (w x : ι → ℝ)
    (hw : ∀ i ∈ s, 0 ≤ w i) (hW : 0 < ∑ i ∈ s, w i) :
    ((∑ i ∈ s, w i * x i) / (∑ i ∈ s, w i)) ^ 2 ≤
      (∑ i ∈ s, w i * x i ^ 2) / (∑ i ∈ s, w i) := by
  rw [div_pow, div_le_div_iff₀ (pow_pos hW 2) hW]
  have h := weighted_sum_sq_le s w x hw
  nlinarith [mul_le_mul_of_nonneg_right h hW.le]

/-- Expanding the weighted squared distance from any constant. -/
theorem weighted_sum_sq_sub_const (s : Finset ι) (w x : ι → ℝ) (c : ℝ) :
    (∑ i ∈ s, w i * (x i - c) ^ 2) =
      (∑ i ∈ s, w i * x i ^ 2) - 2 * c * (∑ i ∈ s, w i * x i) +
        c ^ 2 * (∑ i ∈ s, w i) := by
  calc
    _ = ∑ i ∈ s, (w i * x i ^ 2 - 2 * c * (w i * x i) + c ^ 2 * w i) := by
      exact sum_congr rfl fun _ _ => by ring
    _ = _ := by rw [sum_add_distrib, sum_sub_distrib, ← mul_sum, ← mul_sum]

/-- Centering at the weighted mean makes the weighted sum zero. -/
theorem weighted_sum_centered_eq_zero (s : Finset ι) (w x : ι → ℝ)
    (hW : (∑ i ∈ s, w i) ≠ 0) :
    (∑ i ∈ s, w i * (x i - (∑ j ∈ s, w j * x j) / (∑ j ∈ s, w j))) = 0 := by
  simp_rw [mul_sub]
  rw [sum_sub_distrib, ← sum_mul]
  field_simp
  ring

/-- The centered second moment as an uncentered second moment minus a squared first moment. -/
theorem weighted_variance_identity (s : Finset ι) (w x : ι → ℝ)
    (hW : (∑ i ∈ s, w i) ≠ 0) :
    (∑ i ∈ s, w i * (x i - (∑ j ∈ s, w j * x j) / (∑ j ∈ s, w j)) ^ 2) =
      (∑ i ∈ s, w i * x i ^ 2) - (∑ i ∈ s, w i * x i) ^ 2 / (∑ i ∈ s, w i) := by
  rw [weighted_sum_sq_sub_const]
  field_simp
  ring

/-- The exact excess squared error incurred by centering away from the weighted mean. -/
theorem weighted_variance_decomposition (s : Finset ι) (w x : ι → ℝ) (c : ℝ)
    (hW : (∑ i ∈ s, w i) ≠ 0) :
    (∑ i ∈ s, w i * (x i - c) ^ 2) =
      (∑ i ∈ s, w i * (x i - (∑ j ∈ s, w j * x j) / (∑ j ∈ s, w j)) ^ 2) +
        (∑ i ∈ s, w i) * ((∑ i ∈ s, w i * x i) / (∑ i ∈ s, w i) - c) ^ 2 := by
  rw [weighted_sum_sq_sub_const, weighted_variance_identity s w x hW]
  field_simp
  ring

/-- The weighted mean minimizes the weighted sum of squared distances. -/
theorem weighted_variance_minimizes (s : Finset ι) (w x : ι → ℝ) (c : ℝ)
    (hw : ∀ i ∈ s, 0 ≤ w i) (hW : (∑ i ∈ s, w i) ≠ 0) :
    (∑ i ∈ s, w i * (x i - (∑ j ∈ s, w j * x j) / (∑ j ∈ s, w j)) ^ 2) ≤
      ∑ i ∈ s, w i * (x i - c) ^ 2 := by
  rw [weighted_variance_decomposition s w x c hW]
  exact le_add_of_nonneg_right (mul_nonneg (sum_nonneg hw) (sq_nonneg _))

/-- The double-sum identity underlying pairwise formulas for variance. -/
theorem weighted_pairwise_sq_identity (s : Finset ι) (w x : ι → ℝ) :
    (∑ i ∈ s, ∑ j ∈ s, w i * w j * (x i - x j) ^ 2) =
      2 * (∑ i ∈ s, w i) * (∑ i ∈ s, w i * x i ^ 2) -
        2 * (∑ i ∈ s, w i * x i) ^ 2 := by
  calc
    _ = ∑ i ∈ s, ∑ j ∈ s,
        ((w i * x i ^ 2) * w j - 2 * (w i * x i) * (w j * x j) + w i * (w j * x j ^ 2)) := by
      refine sum_congr rfl fun i _ => sum_congr rfl fun j _ => ?_
      ring
    _ = _ := by
      simp_rw [sum_add_distrib, sum_sub_distrib, ← mul_sum, ← sum_mul]
      ring_nf
      rw [← sum_mul]
      ring

/-- For mass-one weights, variance is one half of the weighted pairwise squared distance. -/
theorem weighted_variance_pairwise (s : Finset ι) (w x : ι → ℝ)
    (hW : ∑ i ∈ s, w i = 1) :
    (∑ i ∈ s, w i * (x i - (∑ j ∈ s, w j * x j)) ^ 2) =
      (∑ i ∈ s, ∑ j ∈ s, w i * w j * (x i - x j) ^ 2) / 2 := by
  rw [weighted_sum_sq_sub_const, weighted_pairwise_sq_identity, hW]
  ring

/-- The squared covariance is at most the product of the two variances, in raw sum form. -/
theorem weighted_covariance_sq_le (s : Finset ι) (w x y : ι → ℝ)
    (hw : ∀ i ∈ s, 0 ≤ w i) (hW : ∑ i ∈ s, w i = 1) :
    ((∑ i ∈ s, w i * x i * y i) -
      (∑ i ∈ s, w i * x i) * (∑ i ∈ s, w i * y i)) ^ 2 ≤
      ((∑ i ∈ s, w i * x i ^ 2) - (∑ i ∈ s, w i * x i) ^ 2) *
        ((∑ i ∈ s, w i * y i ^ 2) - (∑ i ∈ s, w i * y i) ^ 2) := by
  have hW0 : (∑ i ∈ s, w i) ≠ 0 := by rw [hW]; norm_num
  have hx := weighted_variance_identity s w x hW0
  have hy := weighted_variance_identity s w y hW0
  simp only [hW, div_one] at hx hy
  have hxy : (∑ i ∈ s, w i * (x i - ∑ j ∈ s, w j * x j) *
      (y i - ∑ j ∈ s, w j * y j)) =
      (∑ i ∈ s, w i * x i * y i) -
        (∑ i ∈ s, w i * x i) * (∑ i ∈ s, w i * y i) := by
    calc
      _ = ∑ i ∈ s, (w i * x i * y i - (∑ j ∈ s, w j * y j) * (w i * x i) -
          (∑ j ∈ s, w j * x j) * (w i * y i) +
          (∑ j ∈ s, w j * x j) * (∑ j ∈ s, w j * y j) * w i) := by
        exact sum_congr rfl fun _ _ => by ring
      _ = _ := by
        rw [sum_add_distrib, sum_sub_distrib, sum_sub_distrib, ← mul_sum, ← mul_sum, ← mul_sum, hW]
        ring
  simpa only [hxy, hx, hy] using weighted_cauchy_sq s w
    (fun i => x i - ∑ j ∈ s, w j * x j) (fun i => y i - ∑ j ∈ s, w j * y j) hw

/-- Mean absolute deviation is at most the standard deviation, without square roots. -/
theorem weighted_abs_deviation_sq_le_variance (s : Finset ι) (w x : ι → ℝ)
    (hw : ∀ i ∈ s, 0 ≤ w i) (hW : ∑ i ∈ s, w i = 1) :
    (∑ i ∈ s, w i * |x i - ∑ j ∈ s, w j * x j|) ^ 2 ≤
      (∑ i ∈ s, w i * x i ^ 2) - (∑ i ∈ s, w i * x i) ^ 2 := by
  have hW0 : (∑ i ∈ s, w i) ≠ 0 := by rw [hW]; norm_num
  have hv := weighted_variance_identity s w x hW0
  simp only [hW, div_one] at hv
  simpa only [hW, one_mul, hv] using weighted_sum_abs_sq_le s w
    (fun i => x i - ∑ j ∈ s, w j * x j) hw

/-- Bhatia–Davis form: variance is bounded by the product of the two distances to the endpoints. -/
theorem weighted_variance_le_mul_sub (s : Finset ι) (w x : ι → ℝ) (a b : ℝ)
    (hw : ∀ i ∈ s, 0 ≤ w i) (hW : ∑ i ∈ s, w i = 1)
    (ha : ∀ i ∈ s, a ≤ x i) (hb : ∀ i ∈ s, x i ≤ b) :
    (∑ i ∈ s, w i * x i ^ 2) - (∑ i ∈ s, w i * x i) ^ 2 ≤
      (b - ∑ i ∈ s, w i * x i) * ((∑ i ∈ s, w i * x i) - a) := by
  have h : (∑ i ∈ s, w i * x i ^ 2) ≤
      (a + b) * (∑ i ∈ s, w i * x i) - a * b := by
    calc
      _ ≤ ∑ i ∈ s, ((a + b) * (w i * x i) - a * b * w i) := by
        apply sum_le_sum
        intro i hi
        have hp := mul_nonneg (hw i hi) (mul_nonneg (sub_nonneg.2 (ha i hi)) (sub_nonneg.2 (hb i hi)))
        nlinarith
      _ = _ := by rw [sum_sub_distrib, ← mul_sum, ← mul_sum, hW]; ring
  nlinarith

/-- Popoviciu's range bound for a mass-one nonnegative weighted sum. -/
theorem weighted_variance_le_sq_range_div_four (s : Finset ι) (w x : ι → ℝ) (a b : ℝ)
    (hw : ∀ i ∈ s, 0 ≤ w i) (hW : ∑ i ∈ s, w i = 1)
    (ha : ∀ i ∈ s, a ≤ x i) (hb : ∀ i ∈ s, x i ≤ b) :
    (∑ i ∈ s, w i * x i ^ 2) - (∑ i ∈ s, w i * x i) ^ 2 ≤ (b - a) ^ 2 / 4 := by
  have h := weighted_variance_le_mul_sub s w x a b hw hW ha hb
  nlinarith [sq_nonneg (2 * (∑ i ∈ s, w i * x i) - a - b)]

/-- A bounded nonnegative variable has second moment at most its bound times its first moment. -/
theorem weighted_sum_sq_le_upper_mul_sum (s : Finset ι) (w x : ι → ℝ) (b : ℝ)
    (hw : ∀ i ∈ s, 0 ≤ w i) (hx : ∀ i ∈ s, 0 ≤ x i) (hb : ∀ i ∈ s, x i ≤ b) :
    (∑ i ∈ s, w i * x i ^ 2) ≤ b * ∑ i ∈ s, w i * x i := by
  calc
    _ ≤ ∑ i ∈ s, b * (w i * x i) := by
      apply sum_le_sum
      intro i hi
      have h := mul_le_mul_of_nonneg_left (hb i hi) (mul_nonneg (hw i hi) (hx i hi))
      nlinarith
    _ = _ := by rw [mul_sum]

/-- Weighted Engel/Cauchy form with positive denominators and no division of the total sum. -/
theorem weighted_engel_sq (s : Finset ι) (w x d : ι → ℝ)
    (hw : ∀ i ∈ s, 0 ≤ w i) (hd : ∀ i ∈ s, 0 < d i) :
    (∑ i ∈ s, w i * x i) ^ 2 ≤
      (∑ i ∈ s, w i * d i) * ∑ i ∈ s, w i * x i ^ 2 / d i := by
  apply sum_sq_le_sum_mul_sum_of_sq_le_mul s
    (fun i hi => mul_nonneg (hw i hi) (hd i hi).le)
    (fun i hi => div_nonneg (mul_nonneg (hw i hi) (sq_nonneg _)) (hd i hi).le)
  intro i hi
  apply le_of_eq
  field_simp [(hd i hi).ne']

/-- A finite product of `1 + x` is bounded by the exponential of the sum when `x ≥ -1`. -/
theorem prod_one_add_le_exp_sum (s : Finset ι) (x : ι → ℝ)
    (hx : ∀ i ∈ s, -1 ≤ x i) :
    (∏ i ∈ s, (1 + x i)) ≤ Real.exp (∑ i ∈ s, x i) := by
  rw [Real.exp_sum]
  exact prod_le_prod (fun i hi => by linarith [hx i hi])
    (fun i _ => by simpa [add_comm] using Real.add_one_le_exp (x i))

/-- The finite-product version of `1 + a + b ≤ (1 + a)(1 + b)` for nonnegative inputs. -/
theorem one_add_sum_le_prod_one_add (s : Finset ι) (x : ι → ℝ)
    (hx : ∀ i ∈ s, 0 ≤ x i) :
    1 + (∑ i ∈ s, x i) ≤ ∏ i ∈ s, (1 + x i) := by
  classical
  induction s using Finset.induction_on with
  | empty => simp
  | @insert i s hi ih =>
    have hxi := hx i (mem_insert_self i s)
    have hxs : ∀ j ∈ s, 0 ≤ x j := fun j hj => hx j (mem_insert_of_mem hj)
    have hm := mul_le_mul_of_nonneg_left (ih hxs) (by linarith : 0 ≤ 1 + x i)
    rw [sum_insert hi, prod_insert hi]
    nlinarith [mul_nonneg hxi (sum_nonneg hxs)]

/-- A finite union-bound product inequality for inputs in `[0, 1]`. -/
theorem one_sub_sum_le_prod_one_sub (s : Finset ι) (x : ι → ℝ)
    (hx0 : ∀ i ∈ s, 0 ≤ x i) (hx1 : ∀ i ∈ s, x i ≤ 1) :
    1 - (∑ i ∈ s, x i) ≤ ∏ i ∈ s, (1 - x i) := by
  classical
  induction s using Finset.induction_on with
  | empty => simp
  | @insert i s hi ih =>
    have hxi0 := hx0 i (mem_insert_self i s)
    have hxi1 := hx1 i (mem_insert_self i s)
    have hxs0 : ∀ j ∈ s, 0 ≤ x j := fun j hj => hx0 j (mem_insert_of_mem hj)
    have hxs1 : ∀ j ∈ s, x j ≤ 1 := fun j hj => hx1 j (mem_insert_of_mem hj)
    have hm := mul_le_mul_of_nonneg_left (ih hxs0 hxs1) (sub_nonneg.2 hxi1)
    rw [sum_insert hi, prod_insert hi]
    nlinarith [mul_nonneg hxi0 (sum_nonneg hxs0)]

/-- AM–GM without real roots: the product is at most the arithmetic mean raised to cardinality. -/
theorem prod_le_mean_pow (s : Finset ι) (x : ι → ℝ)
    (hs : s.Nonempty) (hx : ∀ i ∈ s, 0 ≤ x i) :
    (∏ i ∈ s, x i) ≤ ((∑ i ∈ s, x i) / (s.card : ℝ)) ^ s.card := by
  have hc : (0 : ℝ) < s.card := Nat.cast_pos.2 (card_pos.2 hs)
  have hp : 0 ≤ ∏ i ∈ s, x i := prod_nonneg hx
  have h := Real.geom_mean_le_arith_mean s (fun _ => 1) x (by intros; norm_num)
    (by simpa using hc) hx
  simp only [Real.rpow_one, sum_const, nsmul_eq_mul, mul_one, one_mul] at h
  have hpow := pow_le_pow_left₀ (Real.rpow_nonneg hp _) h s.card
  rw [← Real.rpow_natCast, ← Real.rpow_mul hp, inv_mul_cancel₀ hc.ne', Real.rpow_one] at hpow
  exact hpow

/-- An upper bound on the sum gives a cardinality-power upper bound on the product. -/
theorem prod_le_pow_of_sum_le (s : Finset ι) (x : ι → ℝ) (b : ℝ)
    (hs : s.Nonempty) (hx : ∀ i ∈ s, 0 ≤ x i) (hsum : (∑ i ∈ s, x i) ≤ s.card * b) :
    (∏ i ∈ s, x i) ≤ b ^ s.card := by
  have hc : (0 : ℝ) < s.card := Nat.cast_pos.2 (card_pos.2 hs)
  have hm : (∑ i ∈ s, x i) / (s.card : ℝ) ≤ b :=
    (div_le_iff₀ hc).2 (by simpa [mul_comm] using hsum)
  exact (prod_le_mean_pow s x hs hx).trans
    (pow_le_pow_left₀ (div_nonneg (sum_nonneg hx) hc.le) hm s.card)

end TheoremOS.Analysis.FiniteInequalities
