/* Host-owned conversion for proper finite subobjects represented by a top element. */
export const finiteProperPrelude = `universe finiteProperU

namespace TheoremOSRepresentation

theorem finiteProperFinsetIff {α : Type finiteProperU} [PartialOrder α] [OrderTop α]
    (Q : Finset α → Prop) :
    (∀ s : Finset α, (∀ a ∈ s, a < ⊤) → Q s) ↔
      (∀ s : Finset α, (∀ a ∈ s, a ≠ ⊤) → Q s) := by
  constructor
  · intro h s hs
    apply h s
    intro a ha
    exact lt_top_iff_ne_top.mpr (hs a ha)
  · intro h s hs
    apply h s
    intro a ha
    exact lt_top_iff_ne_top.mp (hs a ha)

end TheoremOSRepresentation
`;
