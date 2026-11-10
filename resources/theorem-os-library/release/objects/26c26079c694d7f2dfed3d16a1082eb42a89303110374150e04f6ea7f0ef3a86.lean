import Mathlib

/-!
# Congruence cancellation, simultaneous residues, and power periods

An original TheoremOS interface combining `Nat.ModEq` and `Int.ModEq` with
coprimality, finite products of moduli, and the Chinese remainder theorem.
Natural-number solutions are unique below their full period. Integer solutions
are unique in a specified half-open interval, while the unrestricted solution
set is described by an arithmetic progression. Power reduction uses an explicit
period hypothesis; the Euler specialization supplies that hypothesis from
coprimality. No primality or nonzero-modulus premise is silently assumed.

Sources: the interfaces and their assembly were written for TheoremOS. Proofs
reuse Mathlib's `Data/Nat/ModEq.lean`, `Data/Int/ModEq.lean`,
`Data/Nat/ChineseRemainder.lean`, and `RingTheory/Coprime/Basic.lean` and
`RingTheory/Coprime/Lemmas.lean`. The Euler period is
`Nat.ModEq.pow_totient` from `FieldTheory/Finite/Basic.lean`. The mathematics is
standard elementary number theory: Bézout's identity, the Chinese remainder
theorem, and the Fermat–Euler theorem; see G. H. Hardy and E. M. Wright,
*An Introduction to the Theory of Numbers*, 6th ed., Oxford University Press,
2008, Chapters V–VI.

Bridges: affine cancellation accepts a power of a unit coefficient and a common
offset, even when the modulus is itself a power. Finite CRT interfaces accept
`Finset`-indexed residues and pairwise coprime moduli. For non-coprime natural
moduli use `nat_crt_compatible_iff` and the unique representative below the lcm.
For signed residues use `int_crt_existsUnique` or
`int_crt_interval_existsUnique`; the latter makes the interval's starting point
explicit. `int_dvd_pow_sub_pow_of_exponent_modEq` consumes a divisibility period
directly when a problem is stated without congruence notation.
-/

namespace TheoremOS.NumberTheory.Congruences

open scoped BigOperators

noncomputable section

section Naturals

/-- A power of a coefficient coprime to the modulus can be cancelled together with a common offset. -/
theorem nat_affine_pow_cancel_iff {c m : ℕ} (hcop : Nat.Coprime c m)
    (r k a b d : ℕ) :
    Nat.ModEq (m ^ r) (c ^ k * a + d) (c ^ k * b + d) ↔ Nat.ModEq (m ^ r) a b := by
  constructor
  · intro h
    exact (h.add_right_cancel' d).cancel_left_of_coprime
      ((hcop.symm.pow_left r).pow_right k).gcd_eq_one
  · intro h
    exact (h.mul_left (c ^ k)).add_right d

/-- Congruence modulo a product of coprime prime-power-style factors separates into both factors. -/
theorem nat_coprime_pow_product_iff {m n : ℕ} (hcop : Nat.Coprime m n)
    (r s a b : ℕ) :
    Nat.ModEq (m ^ r * n ^ s) a b ↔ Nat.ModEq (m ^ r) a b ∧ Nat.ModEq (n ^ s) a b :=
  (Nat.modEq_and_modEq_iff_modEq_mul ((hcop.pow_left r).pow_right s)).symm

/-- Pairwise coprime congruences combine into a congruence modulo the full finite product. -/
theorem nat_modEq_prod_iff {ι : Type*} (I : Finset ι) (moduli : ι → ℕ)
    (hcop : Set.Pairwise (↑I) (fun i j => Nat.Coprime (moduli i) (moduli j))) (a b : ℕ) :
    Nat.ModEq (∏ i ∈ I, moduli i) a b ↔ ∀ i ∈ I, Nat.ModEq (moduli i) a b := by
  classical
  induction I using Finset.induction_on with
  | empty => simp [Nat.modEq_one]
  | @insert i I hi ih =>
    have hiI : Nat.Coprime (moduli i) (∏ j ∈ I, moduli j) := by
      apply Nat.Coprime.prod_right
      intro j hj
      exact hcop (by simp) (by simp [hj]) (by intro h; subst j; exact hi hj)
    rw [Finset.prod_insert hi, ← Nat.modEq_and_modEq_iff_modEq_mul hiI]
    rw [ih (fun j hj k hk hjk => hcop (by simp [hj]) (by simp [hk]) hjk)]
    simp only [Finset.mem_insert, forall_eq_or_imp]

/-- Solvability for two arbitrary natural moduli is exactly compatibility modulo their gcd. -/
theorem nat_crt_compatible_iff (m n a b : ℕ) :
    (∃ x : ℕ, Nat.ModEq m x a ∧ Nat.ModEq n x b) ↔ Nat.ModEq (Nat.gcd m n) a b := by
  constructor
  · rintro ⟨x, hx, hy⟩
    exact (hx.of_dvd (Nat.gcd_dvd_left m n)).symm.trans
      (hy.of_dvd (Nat.gcd_dvd_right m n))
  · intro h
    exact ⟨Nat.chineseRemainder' h, (Nat.chineseRemainder' h).property⟩

/-- Compatible residues have exactly one natural representative below the lcm of positive moduli. -/
theorem nat_crt_compatible_existsUnique {m n : ℕ} (hm : 0 < m) (hn : 0 < n)
    (a b : ℕ) (hcompat : Nat.ModEq (Nat.gcd m n) a b) :
    ∃! x : ℕ, x < Nat.lcm m n ∧ Nat.ModEq m x a ∧ Nat.ModEq n x b := by
  let x := Nat.chineseRemainder' hcompat
  have hxlt : (x : ℕ) < Nat.lcm m n :=
    Nat.chineseRemainder'_lt_lcm hcompat hm.ne' hn.ne'
  refine ⟨x, ⟨hxlt, x.property⟩, ?_⟩
  intro y hy
  have hxy : Nat.ModEq (Nat.lcm m n) y x :=
    Nat.mod_lcm (hy.2.1.trans x.property.1.symm) (hy.2.2.trans x.property.2.symm)
  exact hxy.eq_of_lt_of_lt hy.1 hxlt

/-- Coprime positive moduli give exactly one natural representative in a full product period. -/
theorem nat_crt_existsUnique {m n : ℕ} (hm : 0 < m) (hn : 0 < n)
    (hcop : Nat.Coprime m n) (a b : ℕ) :
    ∃! x : ℕ, x < m * n ∧ Nat.ModEq m x a ∧ Nat.ModEq n x b := by
  have hcompat : Nat.ModEq (Nat.gcd m n) a b := by
    rw [hcop.gcd_eq_one]
    exact Nat.modEq_one
  simpa only [hcop.lcm_eq_mul] using nat_crt_compatible_existsUnique hm hn a b hcompat

/-- Given one simultaneous solution, all others are exactly its residue class modulo the product. -/
theorem nat_crt_solution_iff {m n x a b : ℕ} (hcop : Nat.Coprime m n)
    (hxm : Nat.ModEq m x a) (hxn : Nat.ModEq n x b) (y : ℕ) :
    (Nat.ModEq m y a ∧ Nat.ModEq n y b) ↔ Nat.ModEq (m * n) y x := by
  rw [← Nat.modEq_and_modEq_iff_modEq_mul hcop]
  exact ⟨fun h => ⟨h.1.trans hxm.symm, h.2.trans hxn.symm⟩,
    fun h => ⟨h.1.trans hxm, h.2.trans hxn⟩⟩

/-- A finite pairwise coprime family has exactly one simultaneous representative below its product. -/
theorem nat_crt_family_existsUnique {ι : Type*} (I : Finset ι) (moduli residues : ι → ℕ)
    (hpos : ∀ i ∈ I, 0 < moduli i)
    (hcop : Set.Pairwise (↑I) (fun i j => Nat.Coprime (moduli i) (moduli j))) :
    ∃! x : ℕ, x < ∏ i ∈ I, moduli i ∧ ∀ i ∈ I, Nat.ModEq (moduli i) x (residues i) := by
  classical
  let x := Nat.chineseRemainderOfFinset residues moduli I (fun i hi => (hpos i hi).ne') hcop
  have hxlt : (x : ℕ) < ∏ i ∈ I, moduli i :=
    Nat.chineseRemainderOfFinset_lt_prod residues moduli (fun i hi => (hpos i hi).ne') hcop
  refine ⟨x, ⟨hxlt, x.property⟩, ?_⟩
  intro y hy
  have hxy : Nat.ModEq (∏ i ∈ I, moduli i) y x :=
    (nat_modEq_prod_iff I moduli hcop y x).mpr fun i hi =>
      (hy.2 i hi).trans (x.property i hi).symm
  exact hxy.eq_of_lt_of_lt hy.1 hxlt

/-- A known finite CRT solution determines the entire simultaneous congruence class. -/
theorem nat_crt_family_solution_iff {ι : Type*} (I : Finset ι) (moduli residues : ι → ℕ)
    (hcop : Set.Pairwise (↑I) (fun i j => Nat.Coprime (moduli i) (moduli j))) {x : ℕ}
    (hx : ∀ i ∈ I, Nat.ModEq (moduli i) x (residues i)) (y : ℕ) :
    (∀ i ∈ I, Nat.ModEq (moduli i) y (residues i)) ↔
      Nat.ModEq (∏ i ∈ I, moduli i) y x := by
  rw [nat_modEq_prod_iff I moduli hcop]
  exact ⟨fun h i hi => (h i hi).trans (hx i hi).symm,
    fun h i hi => (h i hi).trans (hx i hi)⟩

/-- Simultaneous residues for coprime positive moduli have solutions above every prescribed bound. -/
theorem nat_crt_exists_above {m n : ℕ} (hm : 0 < m) (hn : 0 < n)
    (hcop : Nat.Coprime m n) (a b lower : ℕ) :
    ∃ x : ℕ, lower ≤ x ∧ Nat.ModEq m x a ∧ Nat.ModEq n x b := by
  obtain ⟨x, hx, _⟩ := nat_crt_existsUnique hm hn hcop a b
  have hshift : Nat.ModEq (m * n) (x + m * n * lower) x := by simp [Nat.ModEq]
  refine ⟨x + m * n * lower, ?_, ?_, ?_⟩
  · have hperiod := Nat.mul_pos hm hn
    nlinarith
  · exact (hshift.of_mul_right n).trans hx.2.1
  · exact (hshift.of_mul_left m).trans hx.2.2

/-- Any multiple of a known exponent period can be added to an exponent. -/
theorem nat_pow_add_mul_period {m a t : ℕ} (hperiod : Nat.ModEq m (a ^ t) 1) (k l : ℕ) :
    Nat.ModEq m (a ^ (k + t * l)) (a ^ k) := by
  simpa only [pow_add, pow_mul, one_pow, mul_one] using
    (Nat.ModEq.refl (a ^ k)).mul (hperiod.pow l)

/-- Exponents may be reduced modulo any known power period, including the totalized zero case. -/
theorem nat_pow_mod_period {m a t : ℕ} (hperiod : Nat.ModEq m (a ^ t) 1) (k : ℕ) :
    Nat.ModEq m (a ^ k) (a ^ (k % t)) := by
  have h := nat_pow_add_mul_period hperiod (k % t) (k / t)
  simpa only [Nat.mod_add_div] using h

/-- Congruent exponents give congruent powers whenever the exponent modulus is a known period. -/
theorem nat_pow_congr_of_exponent_modEq {m a t r s : ℕ}
    (hperiod : Nat.ModEq m (a ^ t) 1) (hexp : Nat.ModEq t r s) :
    Nat.ModEq m (a ^ r) (a ^ s) := by
  exact (nat_pow_mod_period hperiod r).trans
    (hexp ▸ (nat_pow_mod_period hperiod s).symm)

/-- Euler's theorem reduces the exponent modulo the totient for a base coprime to its modulus. -/
theorem nat_pow_totient_reduction {a m : ℕ} (hcop : Nat.Coprime a m) (k : ℕ) :
    Nat.ModEq m (a ^ k) (a ^ (k % Nat.totient m)) :=
  nat_pow_mod_period (Nat.ModEq.pow_totient hcop) k

end Naturals

section Integers

/-- Integer affine congruences admit cancellation of coprime power coefficients modulo power moduli. -/
theorem int_affine_pow_cancel_iff {c m : ℤ} (hcop : IsCoprime c m)
    (r k : ℕ) (a b d : ℤ) :
    Int.ModEq (m ^ r) (c ^ k * a + d) (c ^ k * b + d) ↔ Int.ModEq (m ^ r) a b := by
  constructor
  · intro h
    have hmul := h.add_right_cancel' d
    rw [Int.modEq_iff_dvd, ← mul_sub] at hmul
    exact Int.modEq_iff_dvd.mpr (hcop.symm.pow.dvd_of_dvd_mul_left hmul)
  · intro h
    exact (h.mul_left (c ^ k)).add_right d

/-- The integer product criterion also allows signed coprime moduli and arbitrary powers. -/
theorem int_coprime_pow_product_iff {m n : ℤ} (hcop : IsCoprime m n)
    (r s : ℕ) (a b : ℤ) :
    Int.ModEq (m ^ r * n ^ s) a b ↔ Int.ModEq (m ^ r) a b ∧ Int.ModEq (n ^ s) a b :=
  (Int.modEq_and_modEq_iff_modEq_mul (Int.isCoprime_iff_nat_coprime.mp hcop.pow)).symm

/-- A finite family of pairwise coprime signed integer moduli combines by multiplication. -/
theorem int_modEq_prod_iff {ι : Type*} (I : Finset ι) (moduli : ι → ℤ)
    (hcop : Set.Pairwise (↑I) (fun i j => IsCoprime (moduli i) (moduli j))) (a b : ℤ) :
    Int.ModEq (∏ i ∈ I, moduli i) a b ↔ ∀ i ∈ I, Int.ModEq (moduli i) a b := by
  classical
  induction I using Finset.induction_on with
  | empty => simp [Int.modEq_one]
  | @insert i I hi ih =>
    have hiI : IsCoprime (moduli i) (∏ j ∈ I, moduli j) := by
      apply IsCoprime.prod_right
      intro j hj
      exact hcop (by simp) (by simp [hj]) (by intro h; subst j; exact hi hj)
    rw [Finset.prod_insert hi,
      ← Int.modEq_and_modEq_iff_modEq_mul (Int.isCoprime_iff_nat_coprime.mp hiI)]
    rw [ih (fun j hj k hk hjk => hcop (by simp [hj]) (by simp [hk]) hjk)]
    simp only [Finset.mem_insert, forall_eq_or_imp]

/-- Signed residues for coprime positive integer moduli have a unique representative in `[0,m*n)`. -/
theorem int_crt_existsUnique {m n : ℤ} (hm : 0 < m) (hn : 0 < n)
    (hcop : IsCoprime m n) (a b : ℤ) :
    ∃! x : ℤ, 0 ≤ x ∧ x < m * n ∧ Int.ModEq m x a ∧ Int.ModEq n x b := by
  obtain ⟨u, v, huv⟩ := hcop
  let z := a * (v * n) + b * (u * m)
  have hzm : Int.ModEq m z a := by
    apply Int.modEq_iff_dvd.mpr
    refine ⟨u * (a - b), ?_⟩
    calc a - z = a * (u * m + v * n) - z := by rw [huv]; ring
      _ = m * (u * (a - b)) := by dsimp [z]; ring
  have hzn : Int.ModEq n z b := by
    apply Int.modEq_iff_dvd.mpr
    refine ⟨v * (b - a), ?_⟩
    calc b - z = b * (u * m + v * n) - z := by rw [huv]; ring
      _ = n * (v * (b - a)) := by dsimp [z]; ring
  have hpos : 0 < m * n := mul_pos hm hn
  have hx0 : 0 ≤ z % (m * n) := Int.emod_nonneg z hpos.ne'
  have hxlt : z % (m * n) < m * n := Int.emod_lt_of_pos z hpos
  have hxm : Int.ModEq m (z % (m * n)) a :=
    ((Int.mod_modEq z (m * n)).of_dvd (dvd_mul_right m n)).trans hzm
  have hxn : Int.ModEq n (z % (m * n)) b :=
    ((Int.mod_modEq z (m * n)).of_dvd (dvd_mul_left n m)).trans hzn
  refine ⟨z % (m * n), ⟨hx0, hxlt, hxm, hxn⟩, ?_⟩
  intro y hy
  have hxy : Int.ModEq (m * n) y (z % (m * n)) :=
    (Int.modEq_and_modEq_iff_modEq_mul
      (Int.isCoprime_iff_nat_coprime.mp ⟨u, v, huv⟩)).mp
        ⟨hy.2.2.1.trans hxm.symm, hy.2.2.2.trans hxn.symm⟩
  change y % (m * n) = z % (m * n) % (m * n) at hxy
  simpa only [Int.emod_eq_of_lt hy.1 hy.2.1, Int.emod_eq_of_lt hx0 hxlt] using hxy

/-- All integer solutions form one arithmetic progression, with an arbitrary integer parameter. -/
theorem int_crt_progression_iff {m n x a b : ℤ} (hcop : IsCoprime m n)
    (hxm : Int.ModEq m x a) (hxn : Int.ModEq n x b) (y : ℤ) :
    (Int.ModEq m y a ∧ Int.ModEq n y b) ↔ ∃ t : ℤ, y = x + m * n * t := by
  have hclass : (Int.ModEq m y a ∧ Int.ModEq n y b) ↔ Int.ModEq (m * n) x y := by
    rw [← Int.modEq_and_modEq_iff_modEq_mul (Int.isCoprime_iff_nat_coprime.mp hcop)]
    exact ⟨fun h => ⟨hxm.trans h.1.symm, hxn.trans h.2.symm⟩,
      fun h => ⟨h.1.symm.trans hxm, h.2.symm.trans hxn⟩⟩
  rw [hclass, Int.modEq_iff_add_fac]

/-- Every half-open integer interval of one full CRT period contains exactly one solution. -/
theorem int_crt_interval_existsUnique {m n : ℤ} (hm : 0 < m) (hn : 0 < n)
    (hcop : IsCoprime m n) (a b start : ℤ) :
    ∃! x : ℤ, start ≤ x ∧ x < start + m * n ∧ Int.ModEq m x a ∧ Int.ModEq n x b := by
  obtain ⟨z, hz, hunique⟩ := int_crt_existsUnique hm hn hcop (a - start) (b - start)
  refine ⟨start + z, ⟨by omega, by omega, ?_, ?_⟩, ?_⟩
  · convert hz.2.2.1.add_left start using 1; ring
  · convert hz.2.2.2.add_left start using 1; ring
  · intro y hy
    have hy' : 0 ≤ y - start ∧ y - start < m * n ∧
        Int.ModEq m (y - start) (a - start) ∧ Int.ModEq n (y - start) (b - start) :=
      ⟨by omega, by omega, hy.2.2.1.sub_right start, hy.2.2.2.sub_right start⟩
    have h := hunique (y - start) hy'
    omega

/-- Integer powers repeat after any multiple of a known natural exponent period. -/
theorem int_pow_add_mul_period {m a : ℤ} {t : ℕ}
    (hperiod : Int.ModEq m (a ^ t) 1) (k l : ℕ) :
    Int.ModEq m (a ^ (k + t * l)) (a ^ k) := by
  simpa only [pow_add, pow_mul, one_pow, mul_one] using
    (Int.ModEq.refl (a ^ k)).mul (hperiod.pow l)

/-- Exponent congruence controls powers of a signed integer base when a period is known. -/
theorem int_pow_congr_of_exponent_modEq {m a : ℤ} {t r s : ℕ}
    (hperiod : Int.ModEq m (a ^ t) 1) (hexp : Nat.ModEq t r s) :
    Int.ModEq m (a ^ r) (a ^ s) := by
  have hr := int_pow_add_mul_period hperiod (r % t) (r / t)
  have hs := int_pow_add_mul_period hperiod (s % t) (s / t)
  simp only [Nat.mod_add_div] at hr hs
  exact hr.trans (hexp ▸ hs.symm)

/-- A divisibility period and congruent exponents imply divisibility of the difference of powers. -/
theorem int_dvd_pow_sub_pow_of_exponent_modEq {m a : ℤ} {t r s : ℕ}
    (hperiod : m ∣ a ^ t - 1) (hexp : Nat.ModEq t r s) : m ∣ a ^ r - a ^ s := by
  have hcong : Int.ModEq m (a ^ t) 1 :=
    (Int.modEq_iff_dvd.mpr hperiod).symm
  exact Int.modEq_iff_dvd.mp (int_pow_congr_of_exponent_modEq hcong hexp).symm

end Integers

end

end TheoremOS.NumberTheory.Congruences
