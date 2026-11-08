import Mathlib

/-!
# Gram matrices, finite least squares, and isometric columns

Original combination interfaces for the Gram matrix `Bᴴ * B` of a rectangular
real or complex matrix. The formulas retain Mathlib's matrix multiplication,
`mulVec`, `LinearIndependent`, `PosSemidef`, `PosDef`, and raw finite sums.
Least-squares errors are real sums of coordinate squares, avoiding a choice of
matrix norm instance. The real and complex results share the `RCLike` interfaces
except where an ordered sum of squares or real residual is part of the statement.

Sources: these interfaces and combination proofs were written for TheoremOS.
Mathlib supplies conjugate-transpose algebra and kernel identities in
`Mathlib/LinearAlgebra/Matrix/DotProduct.lean`, positivity in
`Mathlib/LinearAlgebra/Matrix/PosDef.lean` and `Mathlib/Analysis/Matrix/PosDef.lean`,
and the column-independence bridge in `Mathlib/LinearAlgebra/Matrix/ToLin.lean`.
The finite Cauchy--Schwarz inequality is from
`Mathlib/Algebra/Order/BigOperators/Ring/Finset.lean`. Mathematical background:
Gram matrices, normal equations and orthogonal projections in S. Axler,
*Linear Algebra Done Right*, 3rd ed., Springer, 2015, Chapters 6--7.
The proofs below use only finite algebra and existing Mathlib results.
-/

namespace TheoremOS.LinearAlgebra.GramMatrix

open Matrix Finset
open scoped BigOperators ComplexOrder

section RealComplex

variable {m n p 𝕜 : Type*} [Fintype m] [Fintype n] [Fintype p] [RCLike 𝕜]

/-- The Gram sesquilinear form is the usual form after applying the rectangular matrix. -/
theorem sesquilinear_pullback (B : Matrix m n 𝕜) (x y : n → 𝕜) :
    star x ⬝ᵥ ((Bᴴ * B) *ᵥ y) = star (B *ᵥ x) ⬝ᵥ (B *ᵥ y) := by
  rw [← mulVec_mulVec, dotProduct_mulVec, vecMul_conjTranspose, star_star]

/-- The real part of the Gram quadratic form is a sum of squared coordinate norms. -/
theorem re_quadratic_eq_sum_norm_sq (B : Matrix m n 𝕜) (x : n → 𝕜) :
    RCLike.re (star x ⬝ᵥ ((Bᴴ * B) *ᵥ x)) = ∑ i, ‖(B *ᵥ x) i‖ ^ 2 := by
  rw [sesquilinear_pullback]
  simp [dotProduct, RCLike.star_def, RCLike.conj_mul, map_sum]

/-- A Gram quadratic form vanishes exactly on the kernel of its generating matrix. -/
theorem quadratic_eq_zero_iff (B : Matrix m n 𝕜) (x : n → 𝕜) :
    star x ⬝ᵥ ((Bᴴ * B) *ᵥ x) = 0 ↔ B *ᵥ x = 0 := by
  rw [sesquilinear_pullback, dotProduct_star_self_eq_zero]

/-- The linear maps of a matrix and of its Gram matrix have the same kernel. -/
theorem ker_mulVecLin (B : Matrix m n 𝕜) :
    LinearMap.ker (Bᴴ * B).mulVecLin = LinearMap.ker B.mulVecLin := by
  ext x
  exact Matrix.conjTranspose_mul_self_mulVec_eq_zero B x

/-- Positive definiteness of a Gram matrix is equivalent to independence of all its columns. -/
theorem posDef_iff_linearIndependent (B : Matrix m n 𝕜) :
    (Bᴴ * B).PosDef ↔ LinearIndependent 𝕜 B.col := by
  classical
  constructor
  · intro h
    apply Matrix.mulVec_injective_iff.mp
    change Function.Injective B.mulVecLin
    apply LinearMap.ker_eq_bot.mp
    rw [← ker_mulVecLin B, LinearMap.ker_eq_bot]
    exact Matrix.mulVec_injective_of_isUnit h.isUnit
  · intro h
    exact Matrix.PosDef.conjTranspose_mul_self B (Matrix.mulVec_injective_iff.mpr h)

omit [Fintype n] in
/-- The diagonal records the squared Euclidean lengths of the individual columns. -/
theorem diagonal_re_eq_sum_norm_sq (B : Matrix m n 𝕜) (j : n) :
    RCLike.re ((Bᴴ * B) j j) = ∑ i, ‖B i j‖ ^ 2 := by
  simp [Matrix.mul_apply, RCLike.star_def, RCLike.conj_mul, map_sum]

/-- The real Gram trace is the sum of the squared norms of all matrix entries. -/
theorem trace_re_eq_sum_norm_sq (B : Matrix m n 𝕜) :
    RCLike.re (Bᴴ * B).trace = ∑ i, ∑ j, ‖B i j‖ ^ 2 := by
  change RCLike.re (∑ j, (Bᴴ * B) j j) = _
  rw [map_sum]
  simp_rw [diagonal_re_eq_sum_norm_sq]
  exact Finset.sum_comm

/-- The Gram trace has positive real part precisely when the rectangular matrix is nonzero. -/
theorem trace_re_pos_iff (B : Matrix m n 𝕜) :
    0 < RCLike.re (Bᴴ * B).trace ↔ B ≠ 0 := by
  rw [trace_re_eq_sum_norm_sq]
  simp only [Finset.sum_pos_iff_of_nonneg (fun _ _ => Finset.sum_nonneg (fun _ _ => sq_nonneg _)),
    Finset.sum_pos_iff_of_nonneg (fun _ _ => sq_nonneg _), Finset.mem_univ, true_and,
    sq_pos_iff, norm_ne_zero_iff]
  constructor
  · rintro ⟨i, j, hij⟩ hB
    exact hij (congrFun (congrFun hB i) j)
  · intro hB
    by_contra h
    push_neg at h
    exact hB (Matrix.ext h)

/-- Nonnegative row weights yield a positive semidefinite weighted Gram matrix. -/
theorem weighted_posSemidef [DecidableEq m] (B : Matrix m n 𝕜) (w : m → 𝕜)
    (hw : ∀ i, 0 ≤ w i) :
    (Bᴴ * Matrix.diagonal w * B).PosSemidef := by
  exact (Matrix.PosSemidef.diagonal hw).conjTranspose_mul_mul_same B

/-- Adding a positive multiple of the identity makes every Gram matrix positive definite. -/
theorem regularized_posDef [DecidableEq n] (B : Matrix m n 𝕜) (c : ℝ) (hc : 0 < c) :
    (Bᴴ * B + c • (1 : Matrix n n 𝕜)).PosDef := by
  exact Matrix.PosDef.posSemidef_add (Matrix.posSemidef_conjTranspose_mul_self B) (Matrix.PosDef.one.smul hc)

omit [Fintype p] in
/-- Pulling a Gram matrix back by another rectangular matrix agrees with composing the matrices. -/
theorem composition (B : Matrix m n 𝕜) (C : Matrix n p 𝕜) :
    (B * C)ᴴ * (B * C) = Cᴴ * (Bᴴ * B) * C := by
  rw [conjTranspose_mul]
  simp only [Matrix.mul_assoc]

omit [Fintype n] in
/-- A left factor with orthonormal columns preserves every Gram matrix. -/
theorem left_isometry_invariance [DecidableEq m] (B : Matrix m n 𝕜) (U : Matrix p m 𝕜)
    (hU : Uᴴ * U = 1) :
    (U * B)ᴴ * (U * B) = Bᴴ * B := by
  rw [composition, hU, Matrix.mul_one]

/-- Orthonormal columns preserve the usual sesquilinear product of arbitrary coefficient vectors. -/
theorem isometry_preserves_dotProduct [DecidableEq n] (B : Matrix m n 𝕜)
    (hB : Bᴴ * B = 1) (x y : n → 𝕜) :
    star (B *ᵥ x) ⬝ᵥ (B *ᵥ y) = star x ⬝ᵥ y := by
  rw [← sesquilinear_pullback, hB, Matrix.one_mulVec]

/-- Orthonormal columns give an injective coefficient-to-vector map. -/
theorem isometry_injective [DecidableEq n] (B : Matrix m n 𝕜) (hB : Bᴴ * B = 1) :
    Function.Injective B.mulVec := by
  intro x y h
  have hx := congrArg (fun z => Bᴴ *ᵥ z) h
  simpa only [mulVec_mulVec, hB, Matrix.one_mulVec] using hx

/-- The product of an isometric column matrix with its adjoint is an idempotent projection. -/
theorem projection_idempotent [DecidableEq n] (B : Matrix m n 𝕜) (hB : Bᴴ * B = 1) :
    (B * Bᴴ) * (B * Bᴴ) = B * Bᴴ := by
  calc
    _ = B * (Bᴴ * B) * Bᴴ := by simp only [Matrix.mul_assoc]
    _ = _ := by rw [hB, Matrix.mul_one]

/-- Strict positivity of the Gram determinant is exactly full column independence. -/
theorem det_pos_iff_linearIndependent [DecidableEq n] (B : Matrix m n 𝕜) :
    0 < (Bᴴ * B).det ↔ LinearIndependent 𝕜 B.col := by
  constructor
  · intro h
    apply (posDef_iff_linearIndependent B).mp
    apply Matrix.PosDef.conjTranspose_mul_self
    have hG : Function.Injective (Bᴴ * B).mulVec :=
      Matrix.mulVec_injective_of_isUnit ((Matrix.isUnit_iff_isUnit_det _).mpr (isUnit_iff_ne_zero.mpr (ne_of_gt h)))
    intro x y heq
    apply hG
    simpa only [← mulVec_mulVec] using congrArg (fun z => Bᴴ *ᵥ z) heq
  · intro h
    exact ((posDef_iff_linearIndependent B).mpr h).det_pos

end RealComplex

section Real

variable {m n : Type*} [Fintype m] [Fintype n]

omit [Fintype n] in
/-- Cauchy--Schwarz for two columns, expressed using only entries of their real Gram matrix. -/
theorem entry_sq_le_diagonal_mul (B : Matrix m n ℝ) (i j : n) :
    ((Bᵀ * B) i j) ^ 2 ≤ (Bᵀ * B) i i * (Bᵀ * B) j j := by
  simpa only [Matrix.mul_apply, Matrix.transpose_apply, ← sq] using
    Finset.sum_mul_sq_le_sq_mul_sq Finset.univ (fun k => B k i) (fun k => B k j)

omit [Fintype n] in
/-- Squared distances between columns are determined by the three corresponding Gram entries. -/
theorem sum_sq_column_sub (B : Matrix m n ℝ) (i j : n) :
    (∑ k, (B k i - B k j) ^ 2) = (Bᵀ * B) i i + (Bᵀ * B) j j - 2 * (Bᵀ * B) i j := by
  simp only [Matrix.mul_apply, Matrix.transpose_apply]
  rw [← Finset.sum_add_distrib, Finset.mul_sum, ← Finset.sum_sub_distrib]
  apply Finset.sum_congr rfl
  intro k _
  ring

/-- The normal equations say exactly that the least-squares residual is orthogonal to every column. -/
theorem normal_equations_iff (B : Matrix m n ℝ) (b : m → ℝ) (x : n → ℝ) :
    (Bᵀ * B) *ᵥ x = Bᵀ *ᵥ b ↔ Bᵀ *ᵥ (B *ᵥ x - b) = 0 := by
  rw [Matrix.mulVec_sub, Matrix.mulVec_mulVec, sub_eq_zero]

/-- At a normal-equation solution, every residual decomposes into orthogonal squared errors. -/
theorem residual_pythagoras (B : Matrix m n ℝ) (b : m → ℝ) (x y : n → ℝ)
    (hx : (Bᵀ * B) *ᵥ x = Bᵀ *ᵥ b) :
    (∑ i, ((B *ᵥ y) i - b i) ^ 2) =
      (∑ i, ((B *ᵥ x) i - b i) ^ 2) + ∑ i, (B *ᵥ (y - x)) i ^ 2 := by
  have hn := (normal_equations_iff B b x).mp hx
  have ho : (B *ᵥ (y - x)) ⬝ᵥ (B *ᵥ x - b) = 0 := by
    rw [dotProduct_comm, Matrix.dotProduct_mulVec, ← Matrix.mulVec_transpose,
      hn, zero_dotProduct]
  simp only [dotProduct, Matrix.mulVec_sub, Pi.sub_apply] at ho
  simp only [Matrix.mulVec_sub, Pi.sub_apply]
  have he : ∀ i, ((B *ᵥ y) i - b i) ^ 2 =
      ((B *ᵥ x) i - b i) ^ 2 + ((B *ᵥ y) i - (B *ᵥ x) i) ^ 2 +
        2 * ((B *ᵥ y) i - (B *ᵥ x) i) * ((B *ᵥ x) i - b i) := by
    intro i
    ring
  simp_rw [he, Finset.sum_add_distrib]
  have ho' : ∑ i, 2 * ((B *ᵥ y) i - (B *ᵥ x) i) * ((B *ᵥ x) i - b i) = 0 := by
    calc
      _ = 2 * ∑ i, ((B *ᵥ y) i - (B *ᵥ x) i) * ((B *ᵥ x) i - b i) := by
        simp only [Finset.mul_sum, mul_assoc]
      _ = 0 := by rw [ho, mul_zero]
  rw [ho', add_zero]

/-- Any solution of the normal equations is a global least-squares minimizer. -/
theorem normal_solution_minimizes (B : Matrix m n ℝ) (b : m → ℝ) (x y : n → ℝ)
    (hx : (Bᵀ * B) *ᵥ x = Bᵀ *ᵥ b) :
    (∑ i, ((B *ᵥ x) i - b i) ^ 2) ≤ ∑ i, ((B *ᵥ y) i - b i) ^ 2 := by
  rw [residual_pythagoras B b x y hx]
  exact le_add_of_nonneg_right (Finset.sum_nonneg fun _ _ => sq_nonneg _)

/-- Independent columns make the normal-equation solution unique. -/
theorem normal_solution_unique (B : Matrix m n ℝ) (b : m → ℝ) (x y : n → ℝ)
    (hB : LinearIndependent ℝ B.col) (hx : (Bᵀ * B) *ᵥ x = Bᵀ *ᵥ b)
    (hy : (Bᵀ * B) *ᵥ y = Bᵀ *ᵥ b) : x = y := by
  classical
  have hp := (posDef_iff_linearIndependent B).mpr hB
  exact Matrix.mulVec_injective_of_isUnit hp.isUnit (by
    simpa only [Matrix.conjTranspose_eq_transpose_of_trivial] using hx.trans hy.symm)

end Real

end TheoremOS.LinearAlgebra.GramMatrix
