import Mathlib

/-!
# Finite differences, summation by parts, and explicit finite sums

Reusable interfaces for natural-number indexed sequences: telescoping with shifted endpoints,
reconstruction from increments, Abel's transformation, geometric and arithmetic sums, power sums,
and affine recurrences. Formulas include the empty range and retain raw `Finset.range` sums.
Polynomial identities are stated over a commutative ring; division is used only in field variants.

Sources: these interfaces and combination proofs were written for TheoremOS. Mathlib provides the
finite-sum algebra in `Mathlib/Algebra/BigOperators/Group/Finset/Basic.lean`,
`Mathlib/Algebra/BigOperators/Intervals.lean`, and `Mathlib/Algebra/BigOperators/Module.lean`.
The formulas are elementary finite algebra: telescope the first or second forward difference,
apply the product difference identity for summation by parts, or induct on the upper endpoint.
No benchmark-specific facts or unproved recurrence assumptions are introduced.
-/

namespace TheoremOS.Algebra.FiniteSums

open Finset
open scoped BigOperators

/-- A finite sum of forward differences is the difference of its endpoints. -/
theorem sum_forward_differences {A : Type*} [AddCommGroup A] (f : ℕ → A) (n : ℕ) :
    (∑ k ∈ range n, (f (k + 1) - f k)) = f n - f 0 := by
  induction n with
  | zero => simp
  | succ n ih => rw [sum_range_succ, ih]; abel

/-- Telescope an interval represented by a shifted range, including intervals of length zero. -/
theorem sum_shifted_differences {A : Type*} [AddCommGroup A] (f : ℕ → A) (m n : ℕ) :
    (∑ k ∈ range n, (f (m + k + 1) - f (m + k))) = f (m + n) - f m := by
  simpa only [Nat.add_zero, Nat.add_assoc] using
    sum_forward_differences (fun k => f (m + k)) n

/-- Recover a sequence value from its initial value and finitely many prescribed increments. -/
theorem reconstruct_of_increments {A : Type*} [AddCommGroup A] (f g : ℕ → A) (n : ℕ)
    (h : ∀ k < n, f (k + 1) = f k + g k) :
    f n = f 0 + ∑ k ∈ range n, g k := by
  have hs : (∑ k ∈ range n, (f (k + 1) - f k)) = ∑ k ∈ range n, g k := by
    apply sum_congr rfl
    intro k hk
    rw [h k (mem_range.mp hk)]
    abel
  rw [sum_forward_differences] at hs
  rw [← hs]
  abel

/-- Move the lower endpoint of a range sum forward by one while keeping both boundary terms. -/
theorem sum_shift_one {A : Type*} [AddCommGroup A] (f : ℕ → A) (n : ℕ) :
    (∑ k ∈ range n, f (k + 1)) = (∑ k ∈ range n, f k) + f n - f 0 := by
  have h := sum_forward_differences f n
  rw [sum_sub_distrib] at h
  calc
    _ = (∑ k ∈ range n, f k) +
        ((∑ k ∈ range n, f (k + 1)) - ∑ k ∈ range n, f k) := by abel
    _ = _ := by rw [h]; abel

/-- Discrete integration by parts with explicit sequence values at both endpoints. -/
theorem sum_product_differences {R : Type*} [CommRing R] (f g : ℕ → R) (n : ℕ) :
    (∑ k ∈ range n, f k * (g (k + 1) - g k)) =
      f n * g n - f 0 * g 0 - ∑ k ∈ range n, (f (k + 1) - f k) * g (k + 1) := by
  induction n with
  | zero => simp
  | succ n ih => simp only [sum_range_succ]; rw [ih]; ring

/-- Abel's transformation in terms of partial sums, without truncated predecessor endpoints. -/
theorem sum_by_parts {R : Type*} [CommRing R] (f g : ℕ → R) (n : ℕ) :
    (∑ k ∈ range n, f k * g k) =
      f n * (∑ k ∈ range n, g k) -
        ∑ k ∈ range n, (f (k + 1) - f k) * (∑ j ∈ range (k + 1), g j) := by
  have h := sum_product_differences f (fun k => ∑ j ∈ range k, g j) n
  simpa only [sum_range_succ, add_sub_cancel_left, sum_range_zero, mul_zero, sub_zero] using h

/-- Multiplication by the index transfers a forward difference into an ordinary shifted sum. -/
theorem sum_index_mul_difference {R : Type*} [CommRing R] (f : ℕ → R) (n : ℕ) :
    (∑ k ∈ range n, (k : R) * (f (k + 1) - f k)) =
      (n : R) * f n - ∑ k ∈ range n, f (k + 1) := by
  simpa only [Nat.cast_zero, zero_mul, Nat.cast_add, Nat.cast_one, add_sub_cancel_left,
    one_mul, sub_zero] using sum_product_differences (fun k => (k : R)) f n

/-- Second differences telescope to the difference of the endpoint first differences. -/
theorem sum_second_differences {R : Type*} [CommRing R] (f : ℕ → R) (n : ℕ) :
    (∑ k ∈ range n, (f (k + 2) - 2 * f (k + 1) + f k)) =
      f (n + 1) - f n - f 1 + f 0 := by
  have h := sum_forward_differences (fun k => f (k + 1) - f k) n
  calc
    _ = ∑ k ∈ range n, ((f (k + 1 + 1) - f (k + 1)) - (f (k + 1) - f k)) := by
      apply sum_congr rfl
      intro k _
      rw [show k + 1 + 1 = k + 2 by omega]
      ring
    _ = _ := by rw [h]; simp only [Nat.zero_add]; ring

/-- The polynomial geometric-sum identity, valid even when the ratio is one. -/
theorem geometric_sum_mul_sub {R : Type*} [CommRing R] (r : R) (n : ℕ) :
    (r - 1) * (∑ k ∈ range n, r ^ k) = r ^ n - 1 := by
  induction n with
  | zero => simp
  | succ n ih => rw [sum_range_succ, mul_add, ih, pow_succ]; ring

/-- The finite geometric sum in quotient form for a ratio different from one. -/
theorem geometric_sum {K : Type*} [Field K] (r : K) (n : ℕ) (hr : r ≠ 1) :
    (∑ k ∈ range n, r ^ k) = (r ^ n - 1) / (r - 1) := by
  apply (eq_div_iff (sub_ne_zero.mpr hr)).mpr
  simpa only [mul_comm] using geometric_sum_mul_sub r n

/-- A geometric sum whose first exponent is an arbitrary nonnegative offset. -/
theorem shifted_geometric_sum {K : Type*} [Field K] (r : K) (m n : ℕ) (hr : r ≠ 1) :
    (∑ k ∈ range n, r ^ (m + k)) = r ^ m * (r ^ n - 1) / (r - 1) := by
  simp_rw [pow_add]
  rw [← mul_sum, geometric_sum r n hr]
  ring

/-- A denominator-free formula for a geometric sum weighted by the exponent. -/
theorem weighted_geometric_sum_mul_sq {R : Type*} [CommRing R] (r : R) (n : ℕ) :
    (r - 1) ^ 2 * (∑ k ∈ range n, (k : R) * r ^ k) =
      ((n : R) - 1) * r ^ (n + 1) - (n : R) * r ^ n + r := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [sum_range_succ, mul_add, ih]
    simp only [Nat.cast_add, Nat.cast_one, pow_succ]
    ring

/-- An exponent-weighted geometric sum in quotient form. -/
theorem weighted_geometric_sum {K : Type*} [Field K] (r : K) (n : ℕ) (hr : r ≠ 1) :
    (∑ k ∈ range n, (k : K) * r ^ k) =
      (((n : K) - 1) * r ^ (n + 1) - (n : K) * r ^ n + r) / (r - 1) ^ 2 := by
  apply (eq_div_iff (pow_ne_zero 2 (sub_ne_zero.mpr hr))).mpr
  simpa only [mul_comm] using weighted_geometric_sum_mul_sq r n

/-- Twice an arithmetic sum, expressed as a polynomial identity over any commutative ring. -/
theorem sum_arithmetic_mul_two {R : Type*} [CommRing R] (a d : R) (n : ℕ) :
    2 * (∑ k ∈ range n, (a + (k : R) * d)) =
      (n : R) * (2 * a + ((n : R) - 1) * d) := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [sum_range_succ, mul_add, ih]
    simp only [Nat.cast_add, Nat.cast_one]
    ring

/-- A real arithmetic progression summed from index zero. -/
theorem sum_arithmetic (a d : ℝ) (n : ℕ) :
    (∑ k ∈ range n, (a + (k : ℝ) * d)) =
      (n : ℝ) * (2 * a + ((n : ℝ) - 1) * d) / 2 := by
  have h := sum_arithmetic_mul_two a d n
  linarith

/-- The sum of the first `n` odd numbers, usable in any commutative ring. -/
theorem sum_odd {R : Type*} [CommRing R] (n : ℕ) :
    (∑ k ∈ range n, (2 * (k : R) + 1)) = (n : R) ^ 2 := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [sum_range_succ, ih]
    simp only [Nat.cast_add, Nat.cast_one]
    ring

/-- The sum-of-squares polynomial identity, with no invertibility requirement on six. -/
theorem sum_squares_mul_six {R : Type*} [CommRing R] (n : ℕ) :
    6 * (∑ k ∈ range n, (k : R) ^ 2) =
      (n : R) * ((n : R) - 1) * (2 * (n : R) - 1) := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [sum_range_succ, mul_add, ih]
    simp only [Nat.cast_add, Nat.cast_one]
    ring

/-- The real sum of squares, including the empty sum. -/
theorem sum_squares (n : ℕ) :
    (∑ k ∈ range n, (k : ℝ) ^ 2) =
      (n : ℝ) * ((n : ℝ) - 1) * (2 * (n : ℝ) - 1) / 6 := by
  have h := sum_squares_mul_six (R := ℝ) n
  linarith

/-- The sum of cubes is the square of the corresponding triangular number. -/
theorem sum_cubes (n : ℕ) :
    (∑ k ∈ range n, (k : ℝ) ^ 3) = ((n : ℝ) * ((n : ℝ) - 1) / 2) ^ 2 := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [sum_range_succ, ih]
    simp only [Nat.cast_add, Nat.cast_one]
    ring

/-- Solve an affine first-order recurrence without dividing by the multiplier minus one. -/
theorem affine_recurrence {R : Type*} [CommRing R] (f : ℕ → R) (a b : R) (n : ℕ)
    (h : ∀ k < n, f (k + 1) = a * f k + b) :
    f n = a ^ n * f 0 + b * (∑ k ∈ range n, a ^ k) := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [h n (Nat.lt_succ_self n), ih (fun k hk => h k (Nat.lt_succ_of_lt hk)), sum_range_succ, pow_succ]
    have hg := geometric_sum_mul_sub a n
    linear_combination b * hg

/-- The closed form of an affine recurrence whose multiplier differs from one. -/
theorem affine_recurrence_closed {K : Type*} [Field K] (f : ℕ → K) (a b : K) (n : ℕ)
    (ha : a ≠ 1) (h : ∀ k < n, f (k + 1) = a * f k + b) :
    f n = a ^ n * f 0 + b * (a ^ n - 1) / (a - 1) := by
  rw [affine_recurrence f a b n h, geometric_sum a n ha]
  ring

/-- A discrete affine upper bound, requiring only the recurrence inequality and nonnegative multiplier. -/
theorem affine_recurrence_upper_bound (f : ℕ → ℝ) (a b : ℝ) (n : ℕ) (ha : 0 ≤ a)
    (h : ∀ k < n, f (k + 1) ≤ a * f k + b) :
    f n ≤ a ^ n * f 0 + b * (∑ k ∈ range n, a ^ k) := by
  induction n with
  | zero => simp
  | succ n ih =>
    have hi := mul_le_mul_of_nonneg_left (ih (fun k hk => h k (Nat.lt_succ_of_lt hk))) ha
    have hs := geometric_sum_mul_sub a n
    calc
      f (n + 1) ≤ a * (a ^ n * f 0 + b * (∑ k ∈ range n, a ^ k)) + b :=
        le_trans (h n (Nat.lt_succ_self n)) (add_le_add hi le_rfl)
      _ = _ := by
        rw [sum_range_succ, pow_succ]
        linear_combination b * hs

end TheoremOS.Algebra.FiniteSums
