export const groupCenterProductPrelude = `namespace TheoremOSRepresentation

/-- The center of a product group is canonically isomorphic to the product of its centers. -/
theorem groupCenterProductIff {G : Type u} {H : Type v} [Group G] [Group H] :
    (Subgroup.center (G × H) = (Subgroup.center G).prod (Subgroup.center H)) ↔
      Nonempty (Subgroup.center (G × H) ≃* (Subgroup.center G) × (Subgroup.center H)) := by
  constructor
  · intro h
    rw [h]
    exact ⟨(Subgroup.center G).prodEquiv (Subgroup.center H)⟩
  · intro _
    exact Subgroup.center_prod

end TheoremOSRepresentation
`;
