noncomputable def KernelCompute.natAll (n : Nat) (f : Nat → Bool) : Bool :=
  Nat.rec (motive := fun _ => Bool) true (fun k ih => Bool.rec false ih (f k)) n

theorem KernelCompute.natAll_succ (n : Nat) (f : Nat → Bool) :
    KernelCompute.natAll (n + 1) f = (f n && KernelCompute.natAll n f) := by
  show Bool.rec false (KernelCompute.natAll n f) (f n) = (f n && KernelCompute.natAll n f)
  cases f n <;> rfl

theorem KernelCompute.natAll_eq_true {n : Nat} {f : Nat → Bool} :
    KernelCompute.natAll n f = true ↔ ∀ i, i < n → f i = true := by
  induction n with
  | zero => exact ⟨fun _ i hi => absurd hi (Nat.not_lt_zero i), fun _ => rfl⟩
  | succ k ih =>
    rw [KernelCompute.natAll_succ, Bool.and_eq_true, ih]
    constructor
    · intro h i hi
      rcases Nat.lt_succ_iff_lt_or_eq.mp hi with hi | hi
      · exact h.2 i hi
      · exact hi ▸ h.1
    · intro h
      exact ⟨h k (Nat.lt_succ_self k), fun i hi => h i (Nat.lt_succ_of_lt hi)⟩

noncomputable def KernelCompute.intIccAll (lo hi : Int) (f : Int → Bool) : Bool :=
  KernelCompute.natAll (Int.toNat (Int.add (Int.sub hi lo) 1)) (fun i => f (Int.add lo (Int.ofNat i)))

theorem KernelCompute.intIccAll_eq_true {lo hi : Int} {f : Int → Bool} :
    KernelCompute.intIccAll lo hi f = true ↔ ∀ x, lo ≤ x → x ≤ hi → f x = true := by
  unfold KernelCompute.intIccAll
  rw [KernelCompute.natAll_eq_true]
  constructor
  · intro h x hlo hhi
    have hlt : (x - lo).toNat < (Int.add (Int.sub hi lo) 1).toNat := by
      show (x - lo).toNat < (hi - lo + 1).toNat
      omega
    have hx : Int.add lo (Int.ofNat (x - lo).toNat) = x := by
      show lo + ((x - lo).toNat : Int) = x
      omega
    exact hx ▸ h _ hlt
  · intro h i hn
    have hi' : (i : Int) < hi - lo + 1 := by
      have : i < (hi - lo + 1).toNat := hn
      omega
    exact h _ (by show lo ≤ lo + (i : Int); omega) (by show lo + (i : Int) ≤ hi; omega)

theorem KernelCompute.icc_split {P : Int → Prop} {lo mid next hi : Int} (hnext : next = mid + 1)
    (left : ∀ x, lo ≤ x → x ≤ mid → P x) (right : ∀ x, next ≤ x → x ≤ hi → P x) :
    ∀ x, lo ≤ x → x ≤ hi → P x := by
  intro x hlo hhi
  by_cases hx : x ≤ mid
  · exact left x hlo hx
  · exact right x (by omega) hhi

noncomputable def KernelCompute.intLe (a b : Int) : Bool :=
  Int.rec (fun _ => true) (fun _ => false) (Int.sub b a)

theorem KernelCompute.intLe_eq_true {a b : Int} : KernelCompute.intLe a b = true ↔ a ≤ b := by
  unfold KernelCompute.intLe
  cases h : Int.sub b a with
  | ofNat n => exact ⟨fun _ => by have : b - a = (n : Int) := h; omega, fun _ => rfl⟩
  | negSucc n =>
    refine ⟨fun hf => Bool.noConfusion hf, fun hab => ?_⟩
    have : b - a = Int.negSucc n := h
    rw [Int.negSucc_eq] at this
    omega

noncomputable def KernelCompute.intLt (a b : Int) : Bool := KernelCompute.intLe (Int.add a 1) b

theorem KernelCompute.intLt_eq_true {a b : Int} : KernelCompute.intLt a b = true ↔ a < b := by
  unfold KernelCompute.intLt
  rw [KernelCompute.intLe_eq_true]
  exact Iff.rfl

noncomputable def KernelCompute.intEq (a b : Int) : Bool :=
  Int.rec (fun n => Nat.beq n 0) (fun _ => false) (Int.sub a b)

theorem KernelCompute.intEq_eq_true {a b : Int} : KernelCompute.intEq a b = true ↔ a = b := by
  unfold KernelCompute.intEq
  cases h : Int.sub a b with
  | ofNat n =>
    have : a - b = (n : Int) := h
    cases n with
    | zero => exact ⟨fun _ => by omega, fun _ => rfl⟩
    | succ m => exact ⟨fun hf => Bool.noConfusion hf, fun hab => by omega⟩
  | negSucc n =>
    refine ⟨fun hf => Bool.noConfusion hf, fun hab => ?_⟩
    have : a - b = Int.negSucc n := h
    rw [Int.negSucc_eq] at this
    omega

noncomputable def KernelCompute.listAll {α : Type} (f : α → Bool) (l : List α) : Bool :=
  List.rec (motive := fun _ => Bool) true (fun a _ ih => Bool.rec false ih (f a)) l

theorem KernelCompute.listAll_cons {α : Type} (f : α → Bool) (a : α) (l : List α) :
    KernelCompute.listAll f (a :: l) = (f a && KernelCompute.listAll f l) := by
  show Bool.rec false (KernelCompute.listAll f l) (f a) = (f a && KernelCompute.listAll f l)
  cases f a <;> rfl

theorem KernelCompute.listAll_eq_true {α : Type} {f : α → Bool} {l : List α} :
    KernelCompute.listAll f l = true ↔ ∀ a, a ∈ l → f a = true := by
  induction l with
  | nil => exact ⟨fun _ a ha => absurd ha List.not_mem_nil, fun _ => rfl⟩
  | cons b l ih =>
    rw [KernelCompute.listAll_cons, Bool.and_eq_true, ih]
    constructor
    · intro h a ha
      rcases List.mem_cons.mp ha with ha | ha
      · exact ha ▸ h.1
      · exact h.2 a ha
    · intro h
      exact ⟨h b List.mem_cons_self, fun a ha => h a (List.mem_cons_of_mem b ha)⟩

theorem KernelCompute.listAll_append {α : Type} {f : α → Bool} {l₁ l₂ : List α}
    (left : KernelCompute.listAll f l₁ = true) (right : KernelCompute.listAll f l₂ = true) :
    KernelCompute.listAll f (l₁ ++ l₂) = true := by
  rw [KernelCompute.listAll_eq_true] at left right ⊢
  intro a ha
  rcases List.mem_append.mp ha with ha | ha
  · exact left a ha
  · exact right a ha

noncomputable def KernelCompute.listFromTo {α : Type} (f : Int → α → Bool) (l : List α) (start stop : Int) : Bool :=
  @List.rec α (fun _ => Int → Bool) (fun k => KernelCompute.intEq k stop)
    (fun a _ ih k => Bool.rec false (ih (Int.add k 1)) (f k a)) l start

theorem KernelCompute.listFromTo_cons {α : Type} (f : Int → α → Bool) (a : α) (l : List α) (k stop : Int) :
    KernelCompute.listFromTo f (a :: l) k stop = (f k a && KernelCompute.listFromTo f l (k + 1) stop) := by
  show Bool.rec (motive := fun _ => Bool) false (KernelCompute.listFromTo f l (Int.add k 1) stop) (f k a) =
    (f k a && KernelCompute.listFromTo f l (k + 1) stop)
  cases f k a <;> rfl

theorem KernelCompute.listFromTo_exists {α : Type} {f : Int → α → Bool} {l : List α} {k stop : Int}
    (h : KernelCompute.listFromTo f l k stop = true) : ∀ x, k ≤ x → x < stop → ∃ a, f x a = true := by
  induction l generalizing k with
  | nil =>
    intro x h1 h2
    have : k = stop := KernelCompute.intEq_eq_true.mp h
    subst this
    exact absurd (Int.lt_of_le_of_lt h1 h2) (Int.lt_irrefl k)
  | cons b l ih =>
    rw [KernelCompute.listFromTo_cons, Bool.and_eq_true] at h
    intro x h1 h2
    cases Int.decEq x k with
    | isTrue hx => exact ⟨b, hx ▸ h.1⟩
    | isFalse hx => exact ih h.2 x (Int.lt_iff_le_and_ne.mpr ⟨h1, fun e => hx e.symm⟩) h2

theorem KernelCompute.listFromTo_icc {α : Type} {f : Int → α → Bool} {l : List α} {lo hi stop : Int}
    (hstop : stop = hi + 1) (h : KernelCompute.listFromTo f l lo stop = true) :
    ∀ x, lo ≤ x → x ≤ hi → ∃ a, f x a = true :=
  fun x h1 h2 => KernelCompute.listFromTo_exists h x h1 (hstop ▸ Int.lt_add_one_iff.mpr h2)
