import Mathlib

/-!
# Finite convexity with raw sums and unnormalized masses

Project-authored interfaces combine normalization, finite Jensen inequalities,
convex-set and convex-hull membership, affine images, nested averaging, and the
strict equality case. Weights need not already have total mass one. The real
inequalities use ordinary multiplication, sums, and division; the geometric
interfaces work in any real module. No new mathematical structures are introduced.

Sources: Mathlib's `Convex.centerMass_mem`, `Convex.sum_mem`,
`ConvexOn.map_centerMass_le`, `ConcaveOn.le_map_centerMass`,
`ConvexOn.map_add_sum_le`, `StrictConvexOn.map_sum_lt`,
`StrictConvexOn.map_sum_eq_iff_of_nonneg`, `Finset.mem_convexHull'`, and
`Finset.map_affineCombination`. The normalization, missing-mass, iterated, and
pointwise-envelope consequences are derived here. These are project interfaces
for established results, not claims of new mathematics.
See Mathlib/Analysis/Convex/{Combination,Jensen,Hull}.lean and
Mathlib/LinearAlgebra/AffineSpace/Combination.lean.
-/

open scoped BigOperators
open Finset

namespace TheoremOS.Analysis.FiniteConvexity

variable {ι κ E F : Type*}

private theorem normalized_weights_sum (s : Finset ι) (w : ι → ℝ)
    (hW : (∑ i ∈ s, w i) ≠ 0) :
    (∑ i ∈ s, w i / (∑ j ∈ s, w j)) = 1 := by
  rw [← Finset.sum_div, div_self hW]

private theorem normalized_smul_sum [AddCommGroup E] [Module ℝ E]
    (s : Finset ι) (w : ι → ℝ) (x : ι → E) :
    (∑ i ∈ s, (w i / (∑ j ∈ s, w j)) • x i) =
      (∑ j ∈ s, w j)⁻¹ • ∑ i ∈ s, w i • x i := by
  rw [Finset.smul_sum]
  apply Finset.sum_congr rfl
  intro i _
  rw [← mul_smul, div_eq_inv_mul]

private theorem normalized_mul_sum (s : Finset ι) (w y : ι → ℝ) :
    (∑ i ∈ s, (w i / (∑ j ∈ s, w j)) * y i) =
      (∑ i ∈ s, w i * y i) / (∑ j ∈ s, w j) := by
  rw [Finset.sum_div]
  apply Finset.sum_congr rfl
  intro i _
  ring

section Geometry

variable [AddCommGroup E] [Module ℝ E]

/-- A normalized nonnegative finite sum lies in any convex set containing its points. -/
theorem normalized_sum_mem (s : Finset ι) (w : ι → ℝ) (x : ι → E) (C : Set E)
    (hC : Convex ℝ C) (hw : ∀ i ∈ s, 0 ≤ w i) (hW : 0 < ∑ i ∈ s, w i)
    (hx : ∀ i ∈ s, x i ∈ C) :
    (∑ i ∈ s, w i)⁻¹ • (∑ i ∈ s, w i • x i) ∈ C := by
  exact hC.centerMass_mem hw hW hx

/-- A convex set containing zero also contains every subprobability combination. -/
theorem subprobability_sum_mem (s : Finset ι) (w : ι → ℝ) (x : ι → E) (C : Set E)
    (hC : Convex ℝ C) (hzero : (0 : E) ∈ C) (hw : ∀ i ∈ s, 0 ≤ w i)
    (hW : (∑ i ∈ s, w i) ≤ 1) (hx : ∀ i ∈ s, x i ∈ C) :
    (∑ i ∈ s, w i • x i) ∈ C := by
  have h := hC.sum_mem (t := s.insertNone)
    (w := fun i => i.elim (1 - ∑ j ∈ s, w j) w) (z := fun i => i.elim 0 x)
    (Finset.forall_mem_insertNone.mpr ⟨sub_nonneg.mpr hW, hw⟩)
    (by simp) (Finset.forall_mem_insertNone.mpr ⟨hzero, hx⟩)
  simpa using h

/-- The equal-weight average of a nonempty finite family stays in its convex domain. -/
theorem average_mem (s : Finset ι) (x : ι → E) (C : Set E)
    (hs : s.Nonempty) (hC : Convex ℝ C) (hx : ∀ i ∈ s, x i ∈ C) :
    (s.card : ℝ)⁻¹ • (∑ i ∈ s, x i) ∈ C := by
  have hc : (0 : ℝ) < s.card := by exact_mod_cast Finset.card_pos.mpr hs
  simpa using normalized_sum_mem s (fun _ => 1) x C hC (by intros; positivity) (by simpa using hc) hx

/-- The normalized combination belongs to the hull of the points that actually occur. -/
theorem normalized_sum_mem_convexHull (s : Finset ι) (w : ι → ℝ) (x : ι → E)
    (hw : ∀ i ∈ s, 0 ≤ w i) (hW : 0 < ∑ i ∈ s, w i) :
    (∑ i ∈ s, w i)⁻¹ • (∑ i ∈ s, w i • x i) ∈
      convexHull ℝ (x '' (s : Set ι)) := by
  apply normalized_sum_mem s w x _ (convex_convexHull _ _) hw hW
  intro i hi
  exact subset_convexHull ℝ _ ⟨i, hi, rfl⟩

/-- Finite hull membership can be witnessed by positive total mass instead of mass exactly one. -/
theorem mem_convexHull_iff_exists_positive_weights (s : Finset E) (y : E) :
    y ∈ convexHull ℝ (s : Set E) ↔
      ∃ w : E → ℝ, (∀ x ∈ s, 0 ≤ w x) ∧ 0 < ∑ x ∈ s, w x ∧
        (∑ x ∈ s, w x)⁻¹ • (∑ x ∈ s, w x • x) = y := by
  constructor
  · intro hy
    obtain ⟨w, hw, hW, hsum⟩ := Finset.mem_convexHull'.mp hy
    exact ⟨w, hw, by rw [hW]; positivity, by simpa [hW] using hsum⟩
  · rintro ⟨w, hw, hW, rfl⟩
    exact normalized_sum_mem s w id _ (convex_convexHull _ _) hw hW
      (fun x hx => subset_convexHull ℝ _ hx)

/-- Affine maps commute with normalized raw sums whenever the total mass is nonzero. -/
theorem affine_map_normalized_sum [AddCommGroup F] [Module ℝ F]
    (s : Finset ι) (w : ι → ℝ) (x : ι → E) (f : E →ᵃ[ℝ] F)
    (hW : (∑ i ∈ s, w i) ≠ 0) :
    f ((∑ i ∈ s, w i)⁻¹ • (∑ i ∈ s, w i • x i)) =
      (∑ i ∈ s, w i)⁻¹ • (∑ i ∈ s, w i • f (x i)) := by
  have h := s.map_affineCombination x (fun i => w i / ∑ j ∈ s, w j)
    (normalized_weights_sum s w hW) f
  simpa only [affineCombination_eq_linear_combination _ _ _ (normalized_weights_sum s w hW),
    normalized_smul_sum, Function.comp_apply] using h

/-- The normalized combination of affine images has a preimage in the original convex domain. -/
theorem normalized_sum_mem_affine_image [AddCommGroup F] [Module ℝ F]
    (s : Finset ι) (w : ι → ℝ) (x : ι → E) (C : Set E) (f : E →ᵃ[ℝ] F)
    (hC : Convex ℝ C) (hw : ∀ i ∈ s, 0 ≤ w i) (hW : 0 < ∑ i ∈ s, w i)
    (hx : ∀ i ∈ s, x i ∈ C) :
    (∑ i ∈ s, w i)⁻¹ • (∑ i ∈ s, w i • f (x i)) ∈ f '' C := by
  exact ⟨_, normalized_sum_mem s w x C hC hw hW hx,
    affine_map_normalized_sum s w x f (ne_of_gt hW)⟩

/-- A normalized combination of normalized rows stays in a common convex domain. -/
theorem nested_normalized_sum_mem (s : Finset ι) (t : ι → Finset κ)
    (w : ι → ℝ) (v : ι → κ → ℝ) (x : ι → κ → E) (C : Set E)
    (hC : Convex ℝ C) (hw : ∀ i ∈ s, 0 ≤ w i) (hW : 0 < ∑ i ∈ s, w i)
    (hv : ∀ i ∈ s, ∀ j ∈ t i, 0 ≤ v i j)
    (hV : ∀ i ∈ s, 0 < ∑ j ∈ t i, v i j) (hx : ∀ i ∈ s, ∀ j ∈ t i, x i j ∈ C) :
    (∑ i ∈ s, w i)⁻¹ •
      (∑ i ∈ s, w i • ((∑ j ∈ t i, v i j)⁻¹ • ∑ j ∈ t i, v i j • x i j)) ∈ C := by
  exact normalized_sum_mem s w _ C hC hw hW
    (fun i hi => normalized_sum_mem (t i) (v i) (x i) C hC (hv i hi) (hV i hi) (hx i hi))

end Geometry

section RealJensen

/-- Jensen's inequality for arbitrary positive total mass, using raw real sums and division. -/
theorem normalized_jensen (s : Finset ι) (w x : ι → ℝ) (f : ℝ → ℝ) (C : Set ℝ)
    (hf : ConvexOn ℝ C f) (hw : ∀ i ∈ s, 0 ≤ w i) (hW : 0 < ∑ i ∈ s, w i)
    (hx : ∀ i ∈ s, x i ∈ C) :
    f ((∑ i ∈ s, w i * x i) / (∑ i ∈ s, w i)) ≤
      (∑ i ∈ s, w i * f (x i)) / (∑ i ∈ s, w i) := by
  simpa only [Finset.centerMass, smul_eq_mul, Function.comp_apply, div_eq_inv_mul] using
    hf.map_centerMass_le hw hW hx

/-- Concave Jensen's inequality with the inequality reversed and no mass-one premise. -/
theorem normalized_reverse_jensen (s : Finset ι) (w x : ι → ℝ) (f : ℝ → ℝ) (C : Set ℝ)
    (hf : ConcaveOn ℝ C f) (hw : ∀ i ∈ s, 0 ≤ w i) (hW : 0 < ∑ i ∈ s, w i)
    (hx : ∀ i ∈ s, x i ∈ C) :
    (∑ i ∈ s, w i * f (x i)) / (∑ i ∈ s, w i) ≤
      f ((∑ i ∈ s, w i * x i) / (∑ i ∈ s, w i)) := by
  simpa only [Finset.centerMass, smul_eq_mul, Function.comp_apply, div_eq_inv_mul] using
    hf.le_map_centerMass hw hW hx

/-- Multiplying Jensen by the total mass gives its perspective form. -/
theorem mass_mul_jensen_le (s : Finset ι) (w x : ι → ℝ) (f : ℝ → ℝ) (C : Set ℝ)
    (hf : ConvexOn ℝ C f) (hw : ∀ i ∈ s, 0 ≤ w i) (hW : 0 < ∑ i ∈ s, w i)
    (hx : ∀ i ∈ s, x i ∈ C) :
    (∑ i ∈ s, w i) * f ((∑ i ∈ s, w i * x i) / (∑ i ∈ s, w i)) ≤
      ∑ i ∈ s, w i * f (x i) := by
  simpa only [mul_comm] using (le_div_iff₀ hW).mp (normalized_jensen s w x f C hf hw hW hx)

/-- The concave perspective form is a lower bound for mass times the value at the barycenter. -/
theorem mass_mul_reverse_jensen (s : Finset ι) (w x : ι → ℝ) (f : ℝ → ℝ) (C : Set ℝ)
    (hf : ConcaveOn ℝ C f) (hw : ∀ i ∈ s, 0 ≤ w i) (hW : 0 < ∑ i ∈ s, w i)
    (hx : ∀ i ∈ s, x i ∈ C) :
    (∑ i ∈ s, w i * f (x i)) ≤
      (∑ i ∈ s, w i) * f ((∑ i ∈ s, w i * x i) / (∑ i ∈ s, w i)) := by
  exact (div_le_iff₀ hW).mp (normalized_reverse_jensen s w x f C hf hw hW hx) |>.trans_eq (mul_comm _ _)

/-- Equal weights turn normalized Jensen into the usual arithmetic-mean form. -/
theorem average_jensen_le (s : Finset ι) (x : ι → ℝ) (f : ℝ → ℝ) (C : Set ℝ)
    (hs : s.Nonempty) (hf : ConvexOn ℝ C f) (hx : ∀ i ∈ s, x i ∈ C) :
    f ((∑ i ∈ s, x i) / (s.card : ℝ)) ≤ (∑ i ∈ s, f (x i)) / (s.card : ℝ) := by
  have hc : (0 : ℝ) < s.card := by exact_mod_cast Finset.card_pos.mpr hs
  simpa using normalized_jensen s (fun _ => 1) x f C hf (by intros; positivity) (by simpa using hc) hx

/-- Equal-weight concave Jensen bounds the average of the function values from above. -/
theorem average_reverse_jensen (s : Finset ι) (x : ι → ℝ) (f : ℝ → ℝ) (C : Set ℝ)
    (hs : s.Nonempty) (hf : ConcaveOn ℝ C f) (hx : ∀ i ∈ s, x i ∈ C) :
    (∑ i ∈ s, f (x i)) / (s.card : ℝ) ≤ f ((∑ i ∈ s, x i) / (s.card : ℝ)) := by
  have hc : (0 : ℝ) < s.card := by exact_mod_cast Finset.card_pos.mpr hs
  simpa using normalized_reverse_jensen s (fun _ => 1) x f C hf (by intros; positivity) (by simpa using hc) hx

/-- The missing mass of a subprobability combination contributes exactly its weight at zero. -/
theorem subprobability_jensen_le (s : Finset ι) (w x : ι → ℝ) (f : ℝ → ℝ) (C : Set ℝ)
    (hf : ConvexOn ℝ C f) (hzero : (0 : ℝ) ∈ C) (hw : ∀ i ∈ s, 0 ≤ w i)
    (hW : (∑ i ∈ s, w i) ≤ 1) (hx : ∀ i ∈ s, x i ∈ C) :
    f (∑ i ∈ s, w i * x i) ≤
      (∑ i ∈ s, w i * f (x i)) + (1 - ∑ i ∈ s, w i) * f 0 := by
  simpa only [smul_eq_mul, mul_zero, zero_add, add_comm] using
    hf.map_add_sum_le hw (v := 1 - ∑ i ∈ s, w i) (by ring) hx (sub_nonneg.mpr hW) hzero

/-- Concavity reverses the missing-mass Jensen estimate. -/
theorem subprobability_reverse_jensen (s : Finset ι) (w x : ι → ℝ) (f : ℝ → ℝ) (C : Set ℝ)
    (hf : ConcaveOn ℝ C f) (hzero : (0 : ℝ) ∈ C) (hw : ∀ i ∈ s, 0 ≤ w i)
    (hW : (∑ i ∈ s, w i) ≤ 1) (hx : ∀ i ∈ s, x i ∈ C) :
    (∑ i ∈ s, w i * f (x i)) + (1 - ∑ i ∈ s, w i) * f 0 ≤
      f (∑ i ∈ s, w i * x i) := by
  simpa only [smul_eq_mul, mul_zero, zero_add, add_comm] using
    hf.map_add_sum_le hw (v := 1 - ∑ i ∈ s, w i) (by ring) hx (sub_nonneg.mpr hW) hzero

/-- Pointwise upper envelopes can replace the function values on the Jensen right side. -/
theorem normalized_jensen_of_pointwise_upper (s : Finset ι) (w x upper : ι → ℝ)
    (f : ℝ → ℝ) (C : Set ℝ) (hf : ConvexOn ℝ C f)
    (hw : ∀ i ∈ s, 0 ≤ w i) (hW : 0 < ∑ i ∈ s, w i) (hx : ∀ i ∈ s, x i ∈ C)
    (hu : ∀ i ∈ s, f (x i) ≤ upper i) :
    f ((∑ i ∈ s, w i * x i) / (∑ i ∈ s, w i)) ≤
      (∑ i ∈ s, w i * upper i) / (∑ i ∈ s, w i) := by
  apply (normalized_jensen s w x f C hf hw hW hx).trans
  apply div_le_div_of_nonneg_right _ hW.le
  exact Finset.sum_le_sum (fun i hi => mul_le_mul_of_nonneg_left (hu i hi) (hw i hi))

/-- Iterating normalized finite averages gives a two-level Jensen bound. -/
theorem nested_normalized_jensen (s : Finset ι) (t : ι → Finset κ)
    (w : ι → ℝ) (v x : ι → κ → ℝ) (f : ℝ → ℝ) (C : Set ℝ)
    (hf : ConvexOn ℝ C f) (hw : ∀ i ∈ s, 0 ≤ w i) (hW : 0 < ∑ i ∈ s, w i)
    (hv : ∀ i ∈ s, ∀ j ∈ t i, 0 ≤ v i j) (hV : ∀ i ∈ s, 0 < ∑ j ∈ t i, v i j)
    (hx : ∀ i ∈ s, ∀ j ∈ t i, x i j ∈ C) :
    f ((∑ i ∈ s, w i * ((∑ j ∈ t i, v i j * x i j) / (∑ j ∈ t i, v i j))) /
        (∑ i ∈ s, w i)) ≤
      (∑ i ∈ s, w i * ((∑ j ∈ t i, v i j * f (x i j)) / (∑ j ∈ t i, v i j))) /
        (∑ i ∈ s, w i) := by
  apply normalized_jensen_of_pointwise_upper s w _ _ f C hf hw hW
  · intro i hi
    simpa only [smul_eq_mul, div_eq_inv_mul] using
      normalized_sum_mem (t i) (v i) (x i) C hf.1 (hv i hi) (hV i hi) (hx i hi)
  · intro i hi
    exact normalized_jensen (t i) (v i) (x i) f C hf (hv i hi) (hV i hi) (hx i hi)

/-- Positive weights and two distinct points make normalized Jensen strict. -/
theorem strict_normalized_jensen_lt (s : Finset ι) (w x : ι → ℝ) (f : ℝ → ℝ) (C : Set ℝ)
    (hf : StrictConvexOn ℝ C f) (hw : ∀ i ∈ s, 0 < w i) (hW : 0 < ∑ i ∈ s, w i)
    (hx : ∀ i ∈ s, x i ∈ C) (hne : ∃ i ∈ s, ∃ j ∈ s, x i ≠ x j) :
    f ((∑ i ∈ s, w i * x i) / (∑ i ∈ s, w i)) <
      (∑ i ∈ s, w i * f (x i)) / (∑ i ∈ s, w i) := by
  have h := hf.map_sum_lt (w := fun i => w i / ∑ j ∈ s, w j)
    (fun i hi => div_pos (hw i hi) hW) (normalized_weights_sum s w (ne_of_gt hW)) hx hne
  simpa only [smul_eq_mul, normalized_mul_sum] using h

/-- The strict reverse inequality holds for strictly concave functions and nonconstant points. -/
theorem strict_normalized_reverse_jensen (s : Finset ι) (w x : ι → ℝ) (f : ℝ → ℝ) (C : Set ℝ)
    (hf : StrictConcaveOn ℝ C f) (hw : ∀ i ∈ s, 0 < w i) (hW : 0 < ∑ i ∈ s, w i)
    (hx : ∀ i ∈ s, x i ∈ C) (hne : ∃ i ∈ s, ∃ j ∈ s, x i ≠ x j) :
    (∑ i ∈ s, w i * f (x i)) / (∑ i ∈ s, w i) <
      f ((∑ i ∈ s, w i * x i) / (∑ i ∈ s, w i)) := by
  have h := hf.lt_map_sum (w := fun i => w i / ∑ j ∈ s, w j)
    (fun i hi => div_pos (hw i hi) hW) (normalized_weights_sum s w (ne_of_gt hW)) hx hne
  simpa only [smul_eq_mul, normalized_mul_sum] using h

/-- Equality in normalized strict Jensen is exactly constancy on the nonzero-weight support. -/
theorem strict_normalized_jensen_eq_iff (s : Finset ι) (w x : ι → ℝ) (f : ℝ → ℝ) (C : Set ℝ)
    (hf : StrictConvexOn ℝ C f) (hw : ∀ i ∈ s, 0 ≤ w i) (hW : 0 < ∑ i ∈ s, w i)
    (hx : ∀ i ∈ s, x i ∈ C) :
    f ((∑ i ∈ s, w i * x i) / (∑ i ∈ s, w i)) =
        (∑ i ∈ s, w i * f (x i)) / (∑ i ∈ s, w i) ↔
      ∀ i ∈ s, w i ≠ 0 → ∀ j ∈ s, w j ≠ 0 → x i = x j := by
  have h := hf.map_sum_eq_iff_of_nonneg (w := fun i => w i / ∑ j ∈ s, w j)
    (fun i hi => div_nonneg (hw i hi) hW.le) (normalized_weights_sum s w (ne_of_gt hW)) hx
  simpa only [smul_eq_mul, normalized_mul_sum, ne_eq, div_eq_zero_iff,
    (ne_of_gt hW), or_false] using h

/-- A convex function bounded above at finitely many vertices has that bound throughout their hull. -/
theorem convex_upper_bound_on_finite_hull (s : Finset ℝ) (f : ℝ → ℝ) (C : Set ℝ)
    (bound y : ℝ) (hf : ConvexOn ℝ C f) (hs : ∀ x ∈ s, x ∈ C)
    (hb : ∀ x ∈ s, f x ≤ bound) (hy : y ∈ convexHull ℝ (s : Set ℝ)) :
    f y ≤ bound := by
  obtain ⟨x, hx, hxy⟩ := hf.exists_ge_of_mem_convexHull hs hy
  exact hxy.trans (hb x hx)

end RealJensen

end TheoremOS.Analysis.FiniteConvexity
