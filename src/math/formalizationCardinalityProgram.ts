/* Host-owned generic cardinality and Boolean-false representation theorems. */
export const cardinalityPrelude = `namespace TheoremOSRepresentation

theorem boolFalseIffFalse : ((Bool.false : Bool) : Prop) ↔ False :=
  ⟨fun h => Bool.noConfusion h, False.elim⟩

theorem primeProductNeZero {p q : ℕ} (hp : Nat.Prime p) (hq : Nat.Prime q) :
    p * q ≠ 0 :=
  mul_ne_zero hp.ne_zero hq.ne_zero

/-- Prime-product cardinality supplies the finite instance; Q is arbitrary. -/
theorem finitePrimeProductIff {α : Type u} (Q : ℕ → ℕ → Prop) :
    (∀ [Fintype α] (p q : ℕ),
      Prime p → Prime q → Fintype.card α = p * q → Q p q) ↔
    (∀ (p q : ℕ),
      Nat.Prime p → Nat.Prime q → Nat.card α = p * q → Q p q) := by
  constructor
  · intro h p q hp hq hc
    haveI : Finite α :=
      Nat.finite_of_card_ne_zero (hc.trans_ne (primeProductNeZero hp hq))
    letI : Fintype α := Fintype.ofFinite α
    exact h p q hp.prime hq.prime
      ((Nat.card_eq_fintype_card (α := α)).symm.trans hc)
  · intro h inst p q hp hq hc
    exact h p q hp.nat_prime hq.nat_prime
      ((Nat.card_eq_fintype_card (α := α)).trans hc)

end TheoremOSRepresentation
`;

export const finiteCardinalityPrelude = `namespace TheoremOSRepresentation

/-- A nonzero natural cardinality supplies the finite instance required by Fintype.card. -/
theorem finiteCardinalityIff {α : Type u} {n : ℕ} (hn : n ≠ 0) (Q : Prop) :
    (∀ [Fintype α], Fintype.card α = n → Q) ↔ (Nat.card α = n → Q) := by
  constructor
  · intro h hc
    haveI : Finite α := Nat.finite_of_card_ne_zero (hc.trans_ne hn)
    letI : Fintype α := Fintype.ofFinite α
    exact h ((Nat.card_eq_fintype_card (α := α)).symm.trans hc)
  · intro h inst hc
    exact h ((Nat.card_eq_fintype_card (α := α)).trans hc)

end TheoremOSRepresentation
`;
