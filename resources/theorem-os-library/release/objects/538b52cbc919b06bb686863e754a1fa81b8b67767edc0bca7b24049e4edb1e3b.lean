import Mathlib

/-!
# Finite counting with capacities and incidences

Project-authored interfaces for finite fibers, heterogeneous capacities, degree
comparisons, finite covers, and membership multiplicities. Statements use ordinary
`Finset.filter`, `Finset.card`, sums, products, and unions; no counting structures
or auxiliary definitions are required of consumers. These are elementary derived
interfaces, not claims of new mathematical results.

Sources: Mathlib's `Finset.card_eq_sum_card_fiberwise`,
`Finset.sum_card_fiberwise_eq_card_filter`, `Finset.exists_subset_card_eq`,
`Finset.card_biUnion_le`, `Finset.card_biUnion`,
`Finset.card_union_add_card_inter`, and finite-sum interchange. The capacity,
composite-map, covering, and multiplicity consequences are proved here from those
facts. See Mathlib/Algebra/BigOperators/Group/Finset/Basic.lean,
Mathlib/Data/Finset/Card.lean, and
Mathlib/Combinatorics/Enumerative/DoubleCounting.lean.
-/

open scoped BigOperators
open Finset

namespace TheoremOS.Combinatorics.FiniteCounting

variable {α β γ : Type*}

section Fibers

variable [DecidableEq β]

/-- A map into finitely many bins obeys the sum of their individual capacities. -/
theorem card_le_sum_fiber_capacity (s : Finset α) (t : Finset β)
    (f : α → β) (capacity : β → ℕ)
    (hf : ∀ a ∈ s, f a ∈ t)
    (hc : ∀ b ∈ t, (s.filter (fun a => f a = b)).card ≤ capacity b) :
    s.card ≤ ∑ b ∈ t, capacity b := by
  calc
    s.card = ∑ b ∈ t, (s.filter (fun a => f a = b)).card :=
      Finset.card_eq_sum_card_fiberwise hf
    _ ≤ ∑ b ∈ t, capacity b := Finset.sum_le_sum hc

/-- Disjoint fibers with individual lower demands require at least their total demand. -/
theorem sum_fiber_demand_le_card (s : Finset α) (t : Finset β)
    (f : α → β) (demand : β → ℕ)
    (hd : ∀ b ∈ t, demand b ≤ (s.filter (fun a => f a = b)).card) :
    (∑ b ∈ t, demand b) ≤ s.card := by
  calc
    (∑ b ∈ t, demand b) ≤ ∑ b ∈ t, (s.filter (fun a => f a = b)).card :=
      Finset.sum_le_sum hd
    _ = (s.filter (fun a => f a ∈ t)).card :=
      Finset.sum_card_fiberwise_eq_card_filter s t f
    _ ≤ s.card := Finset.card_filter_le _ _

/-- A uniform bound on fiber sizes bounds the source by bins times capacity. -/
theorem card_le_card_mul_fiber_bound (s : Finset α) (t : Finset β)
    (f : α → β) (n : ℕ) (hf : ∀ a ∈ s, f a ∈ t)
    (hc : ∀ b ∈ t, (s.filter (fun a => f a = b)).card ≤ n) :
    s.card ≤ t.card * n := by
  simpa using card_le_sum_fiber_capacity s t f (fun _ => n) hf hc

/-- Uniform lower bounds on selected fibers give a lower bound on the source size. -/
theorem card_mul_fiber_lower_le_card (s : Finset α) (t : Finset β)
    (f : α → β) (n : ℕ)
    (hd : ∀ b ∈ t, n ≤ (s.filter (fun a => f a = b)).card) :
    t.card * n ≤ s.card := by
  simpa using sum_fiber_demand_le_card s t f (fun _ => n) hd

/-- Exceeding the total heterogeneous capacity forces an overfull bin. -/
theorem exists_fiber_over_capacity (s : Finset α) (t : Finset β)
    (f : α → β) (capacity : β → ℕ) (hf : ∀ a ∈ s, f a ∈ t)
    (h : (∑ b ∈ t, capacity b) < s.card) :
    ∃ b ∈ t, capacity b < (s.filter (fun a => f a = b)).card := by
  by_contra! hn
  exact (not_le_of_gt h) (card_le_sum_fiber_capacity s t f capacity hf hn)

/-- If the demands exceed all available objects, some selected fiber is deficient. -/
theorem exists_fiber_below_demand (s : Finset α) (t : Finset β)
    (f : α → β) (demand : β → ℕ) (h : s.card < ∑ b ∈ t, demand b) :
    ∃ b ∈ t, (s.filter (fun a => f a = b)).card < demand b := by
  by_contra! hn
  exact (not_le_of_gt h) (sum_fiber_demand_le_card s t f demand hn)

/-- A capacity violation provides an explicit subset of `n + 1` objects with one image. -/
theorem exists_subset_constant_map_of_card_gt (s : Finset α) (t : Finset β)
    (f : α → β) (n : ℕ) (hf : ∀ a ∈ s, f a ∈ t)
    (h : t.card * n < s.card) :
    ∃ u : Finset α, u ⊆ s ∧ u.card = n + 1 ∧
      ∃ b ∈ t, ∀ a ∈ u, f a = b := by
  obtain ⟨b, hb, hnb⟩ := exists_fiber_over_capacity s t f (fun _ => n) hf (by simpa using h)
  obtain ⟨u, hu, hcard⟩ := Finset.exists_subset_card_eq (Nat.succ_le_of_lt hnb)
  refine ⟨u, fun a ha => (Finset.mem_filter.mp (hu ha)).1, hcard, b, hb, ?_⟩
  intro a ha
  exact (Finset.mem_filter.mp (hu ha)).2

end Fibers

/-- Successive finite maps multiply their fiber capacities without assumptions of injectivity. -/
theorem card_le_card_mul_composite_fiber_bounds [DecidableEq β] [DecidableEq γ]
    (s : Finset α) (t : Finset β) (u : Finset γ) (f : α → β) (g : β → γ)
    (m n : ℕ) (hf : ∀ a ∈ s, f a ∈ t) (hg : ∀ b ∈ t, g b ∈ u)
    (hm : ∀ b ∈ t, (s.filter (fun a => f a = b)).card ≤ m)
    (hn : ∀ c ∈ u, (t.filter (fun b => g b = c)).card ≤ n) :
    s.card ≤ u.card * (n * m) := by
  calc
    s.card ≤ t.card * m := card_le_card_mul_fiber_bound s t f m hf hm
    _ ≤ (u.card * n) * m := Nat.mul_le_mul_right m (card_le_card_mul_fiber_bound t u g n hg hn)
    _ = u.card * (n * m) := Nat.mul_assoc _ _ _

section Relations

variable (s : Finset α) (t : Finset β) (r : α → β → Prop) [DecidableRel r]

/-- Count a finite relation by either its row filters or its column filters. -/
theorem sum_card_filter_eq_sum_card_filter :
    (∑ a ∈ s, (t.filter (fun b => r a b)).card) =
      ∑ b ∈ t, (s.filter (fun a => r a b)).card := by
  simp_rw [Finset.card_eq_sum_ones, Finset.sum_filter]
  exact Finset.sum_comm

/-- The number of related pairs in a finite product is the sum of the row sizes. -/
theorem card_relation_eq_sum_degrees :
    ((s ×ˢ t).filter (fun p => r p.1 p.2)).card =
      ∑ a ∈ s, (t.filter (fun b => r a b)).card := by
  simp only [Finset.card_eq_sum_ones, Finset.sum_filter, Finset.sum_product]

/-- Nonuniform lower row demands cannot exceed nonuniform upper column capacities. -/
theorem sum_degree_lower_le_sum_degree_upper (lower : α → ℕ) (upper : β → ℕ)
    (hl : ∀ a ∈ s, lower a ≤ (t.filter (fun b => r a b)).card)
    (hu : ∀ b ∈ t, (s.filter (fun a => r a b)).card ≤ upper b) :
    (∑ a ∈ s, lower a) ≤ ∑ b ∈ t, upper b := by
  calc
    (∑ a ∈ s, lower a) ≤ ∑ a ∈ s, (t.filter (fun b => r a b)).card :=
      Finset.sum_le_sum hl
    _ = ∑ b ∈ t, (s.filter (fun a => r a b)).card :=
      sum_card_filter_eq_sum_card_filter s t r
    _ ≤ ∑ b ∈ t, upper b := Finset.sum_le_sum hu

/-- Lower row degrees and upper column degrees compare the two side sizes. -/
theorem card_mul_le_card_mul_of_degrees (m n : ℕ)
    (hl : ∀ a ∈ s, m ≤ (t.filter (fun b => r a b)).card)
    (hu : ∀ b ∈ t, (s.filter (fun a => r a b)).card ≤ n) :
    s.card * m ≤ t.card * n := by
  simpa using sum_degree_lower_le_sum_degree_upper s t r (fun _ => m) (fun _ => n) hl hu

/-- Large total lower row demands force at least one column above a given capacity. -/
theorem exists_degree_over_of_degree_lower (lower : α → ℕ) (n : ℕ)
    (hl : ∀ a ∈ s, lower a ≤ (t.filter (fun b => r a b)).card)
    (h : t.card * n < ∑ a ∈ s, lower a) :
    ∃ b ∈ t, n < (s.filter (fun a => r a b)).card := by
  by_contra! hn
  have hle := sum_degree_lower_le_sum_degree_upper s t r lower (fun _ => n) hl hn
  simp only [Finset.sum_const, smul_eq_mul] at hle
  omega

/-- A covering relation with column capacities bounds the number of covered objects. -/
theorem card_le_sum_capacity_of_covering_relation (capacity : β → ℕ)
    (hcover : ∀ a ∈ s, ∃ b ∈ t, r a b)
    (hc : ∀ b ∈ t, (s.filter (fun a => r a b)).card ≤ capacity b) :
    s.card ≤ ∑ b ∈ t, capacity b := by
  have hl : ∀ a ∈ s, 1 ≤ (t.filter (fun b => r a b)).card := by
    intro a ha
    obtain ⟨b, hb, hr⟩ := hcover a ha
    exact Finset.card_pos.mpr ⟨b, Finset.mem_filter.mpr ⟨hb, hr⟩⟩
  simpa using sum_degree_lower_le_sum_degree_upper s t r (fun _ => 1) capacity hl hc

end Relations

section Covers

variable [DecidableEq β]

/-- A finite union obeys the sum of individual set capacities. -/
theorem card_biUnion_le_sum_capacity (s : Finset α) (A : α → Finset β)
    (capacity : α → ℕ) (hc : ∀ a ∈ s, (A a).card ≤ capacity a) :
    (s.biUnion A).card ≤ ∑ a ∈ s, capacity a := by
  exact Finset.card_biUnion_le.trans (Finset.sum_le_sum hc)

/-- Pairwise disjoint sets can jointly meet the sum of their individual lower demands. -/
theorem sum_demand_le_card_biUnion_of_disjoint (s : Finset α) (A : α → Finset β)
    (demand : α → ℕ) (hdisj : (s : Set α).PairwiseDisjoint A)
    (hd : ∀ a ∈ s, demand a ≤ (A a).card) :
    (∑ a ∈ s, demand a) ≤ (s.biUnion A).card := by
  rw [Finset.card_biUnion hdisj]
  exact Finset.sum_le_sum hd

/-- A set covered by a finite family is bounded by the sum of the covering capacities. -/
theorem card_cover_le_sum_capacity (u : Finset β) (s : Finset α) (A : α → Finset β)
    (capacity : α → ℕ) (hcover : ∀ x ∈ u, ∃ a ∈ s, x ∈ A a)
    (hc : ∀ a ∈ s, (A a).card ≤ capacity a) :
    u.card ≤ ∑ a ∈ s, capacity a := by
  calc
    u.card ≤ (s.biUnion A).card :=
      Finset.card_le_card (fun x hx => Finset.mem_biUnion.mpr (hcover x hx))
    _ ≤ ∑ a ∈ s, capacity a := card_biUnion_le_sum_capacity s A capacity hc

/-- Count family memberships without requiring a finite ambient index type. -/
theorem sum_card_eq_sum_multiplicity (s : Finset α) (A : α → Finset β) :
    (∑ a ∈ s, (A a).card) =
      ∑ x ∈ s.biUnion A, (s.filter (fun a => x ∈ A a)).card := by
  have hfilter : ∀ a ∈ s, (s.biUnion A).filter (fun x => x ∈ A a) = A a := by
    intro a ha
    ext x
    simp only [Finset.mem_filter]
    exact ⟨fun h => h.2, fun hx => ⟨Finset.mem_biUnion.mpr ⟨a, ha, hx⟩, hx⟩⟩
  calc
    (∑ a ∈ s, (A a).card) =
        ∑ a ∈ s, ((s.biUnion A).filter (fun x => x ∈ A a)).card := by
      apply Finset.sum_congr rfl
      intro a ha
      rw [hfilter a ha]
    _ = ∑ x ∈ s.biUnion A, (s.filter (fun a => x ∈ A a)).card :=
      sum_card_filter_eq_sum_card_filter s (s.biUnion A) (fun a x => x ∈ A a)

/-- An upper bound on membership multiplicity controls the total sizes of a family. -/
theorem sum_card_le_card_biUnion_mul_of_multiplicity (s : Finset α) (A : α → Finset β)
    (n : ℕ) (hm : ∀ x ∈ s.biUnion A, (s.filter (fun a => x ∈ A a)).card ≤ n) :
    (∑ a ∈ s, (A a).card) ≤ (s.biUnion A).card * n := by
  rw [sum_card_eq_sum_multiplicity s A]
  simpa using Finset.sum_le_sum hm

/-- A lower bound on membership multiplicity bounds the covered union by total family size. -/
theorem card_biUnion_mul_le_sum_card_of_multiplicity (s : Finset α) (A : α → Finset β)
    (n : ℕ) (hm : ∀ x ∈ s.biUnion A, n ≤ (s.filter (fun a => x ∈ A a)).card) :
    (s.biUnion A).card * n ≤ ∑ a ∈ s, (A a).card := by
  rw [sum_card_eq_sum_multiplicity s A]
  simpa using Finset.sum_le_sum hm

/-- If total memberships exceed a uniform budget, some covered point is in too many sets. -/
theorem exists_overlapping_member_of_sum_card_gt (s : Finset α) (A : α → Finset β)
    (n : ℕ) (h : (s.biUnion A).card * n < ∑ a ∈ s, (A a).card) :
    ∃ x ∈ s.biUnion A, n < (s.filter (fun a => x ∈ A a)).card := by
  by_contra! hn
  exact (not_le_of_gt h) (sum_card_le_card_biUnion_mul_of_multiplicity s A n hn)

end Covers

section Intersections

variable [DecidableEq α]

/-- Two subsets of one finite universe must account for their overlap in the cardinality sum. -/
theorem card_add_card_le_card_add_card_inter (s t u : Finset α)
    (hs : s ⊆ u) (ht : t ⊆ u) :
    s.card + t.card ≤ u.card + (s ∩ t).card := by
  rw [← Finset.card_union_add_card_inter]
  exact Nat.add_le_add_right (Finset.card_le_card (Finset.union_subset hs ht)) _

/-- Two subsets whose combined sizes exceed their universe have a common member. -/
theorem exists_mem_inter_of_card_add_gt (s t u : Finset α)
    (hs : s ⊆ u) (ht : t ⊆ u) (h : u.card < s.card + t.card) :
    ∃ x ∈ s, x ∈ t := by
  have hle := card_add_card_le_card_add_card_inter s t u hs ht
  have hpos : 0 < (s ∩ t).card := by omega
  obtain ⟨x, hx⟩ := Finset.card_pos.mp hpos
  exact ⟨x, (Finset.mem_inter.mp hx).1, (Finset.mem_inter.mp hx).2⟩

end Intersections

end TheoremOS.Combinatorics.FiniteCounting
