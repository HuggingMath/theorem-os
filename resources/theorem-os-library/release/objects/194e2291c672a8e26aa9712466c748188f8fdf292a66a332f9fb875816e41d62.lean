import Mathlib

/-!+# Finite products, coprimality and divisibility

Reusable natural-number interfaces for cancelling coprime powers, combining
pairwise coprime divisors, and Euclid's finite-product construction. The statements
use ordinary divisibility and `Finset` products, so callers need no new definitions.

Sources: original interface and proof compositions over Mathlib's
`Data/Nat/GCD/Basic.lean`, `Data/Nat/GCD/BigOperators.lean`,
`Data/Nat/Prime/Basic.lean`, and `Algebra/Ring/GeomSum.lean` at the pinned Mathlib revision.
The underlying arguments are Euclid's lemma and the difference-of-powers identity.
-/

namespace TheoremOS.NumberTheory.Divisibility

open scoped BigOperators

/-- Coprime divisors can be combined into their product. -/
theorem coprime_mul_dvd_iff {a b n : ℕ} (hab : Nat.Coprime a b) :
    a * b ∣ n ↔ a ∣ n ∧ b ∣ n := by
  constructor
  · intro h
    exact ⟨(dvd_mul_right a b).trans h, (dvd_mul_left b a).trans h⟩
  · rintro ⟨ha, hb⟩
    exact hab.mul_dvd_of_dvd_of_dvd ha hb

/-- Coprime prime-power-like factors combine even when the exponents differ. -/
theorem coprime_pow_mul_dvd_iff {a b n : ℕ} (hab : Nat.Coprime a b) (r s : ℕ) :
    a ^ r * b ^ s ∣ n ↔ a ^ r ∣ n ∧ b ^ s ∣ n :=
  coprime_mul_dvd_iff ((hab.pow_left r).pow_right s)

/-- Cancel a power of a factor coprime to the divisor. -/
theorem coprime_cancel_pow_left {a b n : ℕ} (hab : Nat.Coprime a b) (k : ℕ) :
    a ∣ b ^ k * n ↔ a ∣ n :=
  (hab.pow_right k).dvd_mul_left

theorem coprime_cancel_pow_right {a b n : ℕ} (hab : Nat.Coprime a b) (k : ℕ) :
    a ∣ n * b ^ k ↔ a ∣ n :=
  (hab.pow_right k).dvd_mul_right

/-- Cancel a powered factor from divisibility by another coprime power. -/
theorem coprime_pow_cancel_pow_left {a b n : ℕ} (hab : Nat.Coprime a b) (r s : ℕ) :
    a ^ r ∣ b ^ s * n ↔ a ^ r ∣ n :=
  ((hab.pow_left r).pow_right s).dvd_mul_left

/-- Adding a multiple of one number preserves coprimality. -/
theorem coprime_mul_add {a b : ℕ} (hab : Nat.Coprime a b) (k : ℕ) :
    Nat.Coprime a (k * a + b) := by
  simpa [Nat.add_comm] using (Nat.coprime_add_mul_right_right a b k).mpr hab

/-- A number is coprime to one plus any positive power of itself. -/
theorem coprime_pow_add_one (a : ℕ) {k : ℕ} (hk : 0 < k) :
    Nat.Coprime a (a ^ k + 1) := by
  obtain ⟨k, rfl⟩ := Nat.exists_eq_succ_of_ne_zero (Nat.ne_of_gt hk)
  simpa only [pow_succ] using coprime_mul_add (Nat.coprime_one_right a) (a ^ k)

theorem coprime_square_add_one (a : ℕ) : Nat.Coprime a (a ^ 2 + 1) :=
  coprime_pow_add_one a (by decide)

/-- Each factor is coprime to one plus their product. -/
theorem coprime_mul_add_one_left (a b : ℕ) : Nat.Coprime a (a * b + 1) := by
  rw [Nat.mul_comm]
  exact coprime_mul_add (Nat.coprime_one_right a) b

theorem coprime_mul_add_one_right (a b : ℕ) : Nat.Coprime b (a * b + 1) :=
  coprime_mul_add (Nat.coprime_one_right b) a

/-- A common divisor of coprime numbers must be one. -/
theorem eq_one_of_dvd_coprime {d a b : ℕ} (hab : Nat.Coprime a b) (hda : d ∣ a) (hdb : d ∣ b) :
    d = 1 := by
  have h : d ∣ 1 := hab.gcd_eq_one ▸ Nat.dvd_gcd hda hdb
  exact Nat.eq_one_of_dvd_one h

/-- The divisor is retained explicitly, making this useful for Euclid-style contradictions. -/
theorem not_dvd_mul_add_one {a : ℕ} (ha : a ≠ 1) (b : ℕ) : ¬a ∣ a * b + 1 := by
  intro h
  exact ha (eq_one_of_dvd_coprime (coprime_mul_add_one_left a b) (dvd_refl a) h)

/-- A prime divisor of a product cannot divide the product plus one. -/
theorem prime_not_dvd_add_one {p n : ℕ} (hp : Nat.Prime p) (hpn : p ∣ n) : ¬p ∣ n + 1 := by
  obtain ⟨k, rfl⟩ := hpn
  exact not_dvd_mul_add_one hp.ne_one k

section FiniteProducts

variable {ι : Type*}

/-- All pairwise coprime divisors of a number divide it simultaneously as a product. -/
theorem pairwise_coprime_prod_dvd_iff (s : Finset ι) (f : ι → ℕ)
    (hcop : Set.Pairwise (↑s) (fun i j => Nat.Coprime (f i) (f j))) (n : ℕ) :
    (∏ i ∈ s, f i) ∣ n ↔ ∀ i ∈ s, f i ∣ n := by
  classical
  constructor
  · intro h i hi
    exact (Finset.dvd_prod_of_mem f hi).trans h
  · intro h
    induction s using Finset.induction_on with
    | empty => simp
    | @insert a s ha ih =>
      have hacop : Nat.Coprime (f a) (∏ i ∈ s, f i) := by
        apply Nat.Coprime.prod_right
        intro i hi
        exact hcop (by simp) (by simp [hi]) (by intro e; subst i; exact ha hi)
      rw [Finset.prod_insert ha]
      apply hacop.mul_dvd_of_dvd_of_dvd (h a (by simp))
      apply ih
      · intro i hi j hj hij
        exact hcop (by simp [hi]) (by simp [hj]) hij
      · intro i hi
        exact h i (by simp [hi])

/-- Every factor is coprime to one plus the whole finite product. -/
theorem coprime_prod_add_one (s : Finset ι) (f : ι → ℕ) {i : ι} (hi : i ∈ s) :
    Nat.Coprime (f i) ((∏ j ∈ s, f j) + 1) := by
  obtain ⟨k, hk⟩ := Finset.dvd_prod_of_mem f hi
  rw [hk]
  exact coprime_mul_add_one_left (f i) k

/-- A prime dividing a selected factor cannot divide one plus the product. -/
theorem prime_not_dvd_prod_add_one (s : Finset ι) (f : ι → ℕ) {p : ℕ}
    (hp : Nat.Prime p) {i : ι} (hi : i ∈ s) (hpi : p ∣ f i) :
    ¬p ∣ (∏ j ∈ s, f j) + 1 :=
  prime_not_dvd_add_one hp (hpi.trans (Finset.dvd_prod_of_mem f hi))

end FiniteProducts

/-- A finite set of distinct primes contributes its product exactly when each prime divides. -/
theorem primes_prod_dvd_iff (s : Finset ℕ) (hs : ∀ p ∈ s, Nat.Prime p) (n : ℕ) :
    (∏ p ∈ s, p) ∣ n ↔ ∀ p ∈ s, p ∣ n := by
  apply pairwise_coprime_prod_dvd_iff s id
  intro p hp q hq hpq
  exact (Nat.coprime_primes (hs p hp) (hs q hq)).mpr hpq

/-- Euclid's new prime divisor is outside the original finite set. -/
theorem prime_not_mem_of_dvd_prod_add_one (s : Finset ℕ) {p : ℕ} (hp : Nat.Prime p)
    (hpd : p ∣ (∏ q ∈ s, q) + 1) : p ∉ s := by
  intro hps
  exact prime_not_dvd_prod_add_one s id hp hps (dvd_refl p) hpd

/-- A positive finite product plus one has a prime divisor outside its factors. -/
theorem exists_prime_not_mem (s : Finset ℕ) (hs : ∀ n ∈ s, 0 < n) :
    ∃ p : ℕ, Nat.Prime p ∧ p ∉ s ∧ p ∣ (∏ q ∈ s, q) + 1 := by
  have hprod : 0 < ∏ q ∈ s, q := Finset.prod_pos hs
  obtain ⟨p, hp, hpd⟩ := Nat.exists_prime_and_dvd (show (∏ q ∈ s, q) + 1 ≠ 1 by omega)
  exact ⟨p, hp, prime_not_mem_of_dvd_prod_add_one s hp hpd, hpd⟩

/-- Divisibility of exponents yields divisibility of the corresponding geometric differences. -/
theorem pow_sub_one_dvd_of_dvd_exponent (a : ℕ) {m n : ℕ} (hmn : m ∣ n) :
    a ^ m - 1 ∣ a ^ n - 1 := by
  obtain ⟨k, rfl⟩ := hmn
  simpa [pow_mul] using Nat.sub_dvd_pow_sub_pow (a ^ m) 1 k

/-- One plus a positive power has no common prime factor with its base. -/
theorem prime_not_dvd_pow_add_one {p a k : ℕ} (hp : Nat.Prime p) (hpa : p ∣ a)
    (hk : 0 < k) : ¬p ∣ a ^ k + 1 := by
  intro h
  exact hp.ne_one (eq_one_of_dvd_coprime (coprime_pow_add_one a hk) hpa h)

end TheoremOS.NumberTheory.Divisibility
