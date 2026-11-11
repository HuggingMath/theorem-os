import Mathlib.Algebra.Order.Field.Basic
import Mathlib.Data.Real.Basic

namespace TheoremOSE02

-- Deliberately rejected: a nonnegative b is not a strictly positive b.
theorem reciprocal_strict_nonnegative_attempt (a b : ℝ) (ha : 0 < a) (hb : 0 ≤ b) :
    1 / (a + b) < 1 / a := by
  exact one_div_lt_one_div_of_lt ha (lt_add_of_pos_right a hb)

end TheoremOSE02
