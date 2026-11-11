import Mathlib.Algebra.Order.Field.Basic
import Mathlib.Data.Real.Basic

namespace TheoremOSE02

theorem zero_boundary (a : ℝ) : ¬ (1 / (a + 0) < 1 / a) := by
  simp

theorem boundary_counterexample :
    0 < (1 : ℝ) ∧ 0 ≤ (0 : ℝ) ∧ ¬ (1 / ((1 : ℝ) + 0) < 1 / (1 : ℝ)) := by
  exact ⟨zero_lt_one, le_rfl, zero_boundary 1⟩

theorem nonnegative_strict_claim_is_false :
    ¬ (∀ (a b : ℝ), 0 < a → 0 ≤ b → 1 / (a + b) < 1 / a) := by
  intro h
  exact zero_boundary 1 (h 1 0 zero_lt_one le_rfl)

end TheoremOSE02
