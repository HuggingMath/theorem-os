# Number theory: collected reading

These are original summaries of passages read for the first collection. Read the identified source for its full statements and conventions. PDF pages count from the first page of the downloaded file and can differ from printed pages. This file retains links and original summaries only. Reuse notes report explicit statements read in the sources; other source licences remain unverified.

## elementary-number-theory

**初等数论 / Elementary Number Theory Expert** (D011)

Reading: [William Stein — Elementary Number Theory: Primes, Congruences, and Secrets](https://wstein.org/ent/ent.pdf)

Locator: §2.2, Theorem 2.2.2 and the following examples; printed pp. 29–30, PDF pp. 36–37.

Knowledge: For coprime positive integers m and n, any prescribed residue classes modulo m and modulo n have a simultaneous integer representative. Its residue class is unique modulo mn. Thus the uniqueness concerns a congruence class, while infinitely many integers represent that class.

Scope: The coprime-modulus Chinese remainder theorem; the compatibility criterion for general noncoprime moduli is outside this reading.

### Further reading

Reading: [William Stein — Elementary Number Theory: Primes, Congruences, and Secrets](https://wstein.org/ent/ent.pdf)

Locator: §4.1, Definitions 4.1.1–4.1.2, printed p. 70 / PDF p. 77, and Theorem 4.1.7, printed p. 72 / PDF p. 79; §4.2, Proposition 4.2.1, printed p. 73 / PDF p. 80.

Knowledge: For an odd prime p, the Legendre symbol (a/p) is 0 when p divides a, 1 for a nonzero quadratic residue and −1 for a nonresidue. If p does not divide a, Euler’s criterion says that a is a quadratic residue exactly when a^((p−1)/2) ≡ 1 modulo p. For distinct odd primes p and q, (p/q)(q/p) = (−1)^(((p−1)/2)((q−1)/2)). The supplementary laws give (−1/p) = (−1)^((p−1)/2), while (2/p) is 1 for p ≡ ±1 modulo 8 and −1 for p ≡ ±3 modulo 8.

Scope: Legendre symbols use an odd prime denominator, and reciprocity here requires distinct odd primes. Composite-denominator symbols, higher reciprocity and the computation of actual square roots are outside the cited statements.

## algebraic-number-theory

**代数数论 / Algebraic Number Theory Expert** (D012)

Reading: [J. S. Milne — Algebraic Number Theory](https://www.jmilne.org/math/CourseNotes/ANT.pdf)

Reuse: PDF p. 2 permits single paper copies for noncommercial personal use. Broader redistribution permission was not established.

Locator: Chapter 3, Definition 3.3, Proposition 3.6 and Theorem 3.7; printed pp. 48–49, PDF pp. 50–51.

Knowledge: A Dedekind domain is a noetherian integrally closed domain whose nonzero prime ideals are maximal. Every proper nonzero ideal in such a domain factors uniquely into positive powers of distinct prime ideals. For a noetherian domain, the Dedekind property is also characterized by its localizations at nonzero prime ideals being discrete valuation rings.

Scope: Dedekind domains, local valuation rings and ideal factorization; unique factorization of elements and class-group calculations are separate subjects.

### Further reading

Reading: [J. S. Milne — Algebraic Number Theory](https://www.jmilne.org/math/CourseNotes/ANT.pdf)

Locator: Chapter 4, Theorems 4.3–4.4, printed pp. 70–71 / PDF pp. 72–73; Chapter 5, Theorem 5.1 and the unit-group notation and torsion discussion, printed p. 85 / PDF p. 87.

Knowledge: For a number field K of degree n with s pairs of nonreal embeddings and field discriminant Δ_K, every ideal class has an integral ideal representative of norm at most (n!/n^n)(4/π)^s √|Δ_K|. The ideal class group is finite. If K has r real embeddings and s conjugate pairs of nonreal embeddings, the unit group O_K* is finitely generated of rank r + s − 1; its torsion subgroup is the finite group of roots of unity in K. Finite generation of the unit group permits an infinite free part.

Scope: These global arithmetic finiteness statements concern number fields and their rings of integers, with n = r + 2s. The unit group is O_K*, and the assertions do not apply to the entire multiplicative group K* or to arbitrary Dedekind domains.

## analytic-number-theory

**解析数论 / Analytic Number Theory Expert** (D013)

Reading: [Andrew V. Sutherland — MIT 18.785 Lecture 16: Riemann's zeta function and the prime number theorem, Fall 2021](https://math.mit.edu/classes/18.785/2021fa/LectureNotes16.pdf)

Locator: §16.1, Definition 16.1 and Theorems 16.2–16.3; PDF pp. 1–2.

Knowledge: The Dirichlet series for ζ(s) converges absolutely and locally uniformly when Re(s) > 1. In that half-plane it equals an absolutely convergent Euler product over primes and has no zeros. The stated continuation reaches Re(s) > 0, with a simple pole at s = 1 of residue 1 and no other poles there.

Scope: The defining series, Euler product and first continuation region; the lecture title does not mean that its later prime number theorem argument was included in this reading.

### Further reading

Reading: [Andrew V. Sutherland — MIT 18.785 Lecture 16: Riemann's zeta function and the prime number theorem, Fall 2021](https://math.mit.edu/classes/18.785/2021fa/LectureNotes16.pdf)

Locator: Corollary 16.5 and the prime-counting definition, PDF p. 3; Theorem 16.6 and the Chebyshev function, PDF p. 4; Theorem 16.15 and its following limitation, PDF p. 9.

Knowledge: The meromorphic zeta function has no zeros in Re(s) ≥ 1; at s = 1 it has a pole. If π(x) counts primes at most x, the prime number theorem states that π(x)/(x/log x) tends to 1 as x tends to infinity. This is equivalent to θ(x)/x tending to 1, where θ(x) = ∑_(p≤x) log p. The equivalence concerns asymptotic ratios and supplies neither equality of these functions nor an exact prime count.

Scope: The collected prime number theorem is qualitative and unconditional. The lecture explicitly notes that its argument supplies no error term; explicit bounds, zero-free regions inside Re(s) < 1, arithmetic progressions and Riemann-hypothesis error estimates are outside this addition.

## diophantine-equations

**丢番图方程 / Diophantine Equations Expert** (D014)

Reading: [Bjorn Poonen — Rational Points on Varieties, author prepublication draft](https://math.mit.edu/~poonen/papers/Qpoints.pdf)

Locator: §2.6, Questions 2.6.15–2.6.18 and adjoining definitions; printed p. 52, PDF p. 66.

Knowledge: For a variety over a global field k, the local-global principle is the implication from a point over every completion kᵥ to a k-rational point. Weak approximation asks for density of rational points in the product of the local point spaces with their local topologies. These are properties of particular varieties: local solvability alone is not a universal guarantee of rational solvability.

Scope: Meaning of the local-global principle and approximation properties; no local-global theorem for an unspecified family of equations is asserted.

### Further reading

Reading: [Bjorn Poonen — Rational Points on Varieties, author prepublication draft](https://math.mit.edu/~poonen/papers/Qpoints.pdf)

Locator: §8.2, Propositions 8.2.1–8.2.2, Definitions 8.2.5–8.2.8, Proposition 8.2.9 and Corollary 8.2.11; printed pp. 229–231 / PDF pp. 243–245.

Knowledge: For a variety X over a global field k, a Brauer class A evaluates at each local point xᵥ to a class in Br(kᵥ). At an adelic point these evaluations vanish for almost all places, so the sum of local invariants defines the Brauer–Manin pairing with values in Q/Z. Every rational point is orthogonal to Br(X); hence X(k) lies in the Brauer set X(Aₖ)^Br. A nonempty adelic point set with empty Brauer set is a Brauer–Manin obstruction to the local-global principle. Local Brauer evaluation is locally constant, and the Brauer set is closed and contains the closure of the rational points. When X is proper, a Brauer set strictly smaller than the adelic point set obstructs weak approximation.

Scope: The pairing and obstruction use a global field; the weak-approximation assertion includes properness. Whether a nonempty Brauer set suffices for a rational point is a separate assertion about a specified class of varieties, not a universal consequence of the pairing. The source is an unofficial personal-use draft; this addition retains a link and original summary only.

## arithmetic-geometry

**算术几何 / Arithmetic Geometry Expert** (D015)

Reading: [Bjorn Poonen — Rational Points on Varieties, author prepublication draft](https://math.mit.edu/~poonen/papers/Qpoints.pdf)

Locator: Definition 3.5.68, printed p. 85 / PDF p. 99; §7.2, Corollary 7.2.1, printed p. 206 / PDF p. 220.

Knowledge: The source calls a variety “nice” when it is smooth, projective and geometrically integral. For a nice genus-g curve over a finite field of q elements, the Hasse–Weil bound places its number of rational points within 2g√q of q + 1.

Scope: Geometry assumptions and finite-field point counts for curves; higher-dimensional Weil bounds and rational points over number fields require additional statements.

### Further reading

Reading: [Bjorn Poonen — Rational Points on Varieties, author prepublication draft](https://math.mit.edu/~poonen/papers/Qpoints.pdf)

Locator: Definition 3.5.68, printed p. 85 / PDF p. 99; Theorem 5.7.31, printed p. 145 / PDF p. 159; Theorem 9.5.1 and Remark 9.5.2, printed p. 286 / PDF p. 300.

Knowledge: For an abelian variety A over a global field k, Mordell–Weil states that the abelian group A(k) is finitely generated. This allows positive rank and infinitely many points. For a smooth projective geometrically integral curve X of genus greater than 1 over a number field K, Faltings’s theorem states that X(K) is finite. The two results assert different kinds of finiteness for different geometric objects.

Scope: The Mordell–Weil statement uses a global field, while the Faltings statement here uses a number field and the stated smoothness, projectivity, integrality and genus assumptions. The source gives only a sketch of the former and omits the latter proof. These finiteness statements do not supply a general algorithm listing all rational points.

## p-adic-analysis

**p进分析 / p-adic Analysis Expert** (D016)

Reading: [J. S. Milne — Algebraic Number Theory](https://www.jmilne.org/math/CourseNotes/ANT.pdf)

Reuse: PDF p. 2 permits single paper copies for noncommercial personal use. Broader redistribution permission was not established.

Locator: Chapter 7, “Nonarchimedean absolute values,” printed p. 106 / PDF p. 108; “Completions,” Theorem 7.23 and Remark 7.24, printed pp. 114–115 / PDF pp. 116–117.

Knowledge: A nonarchimedean absolute value satisfies |x + y| ≤ max(|x|, |y|). A valued field has a completion characterized by extension of absolute-value-preserving maps into complete valued fields, and the original field embeds densely in it. In particular, Qₚ is the completion of Q for its p-adic absolute value.

Scope: Ultrametric absolute values, Cauchy completion and the definition of Qₚ; p-adic analytic functions, integration and Hensel lifting are outside these passages.

### Further reading

Reading: [J. S. Milne — Algebraic Number Theory](https://www.jmilne.org/math/CourseNotes/ANT.pdf)

Locator: Chapter 7, “Newton's lemma,” its complete-discrete-valuation-ring setup, Proposition 7.31 and Theorem 7.33; printed pp. 119–121 / PDF pp. 121–123.

Knowledge: Let A be a complete discrete valuation ring with maximal ideal generated by π and residue field k. A simple root of the reduction of f ∈ A[X] has a unique root of f in A reducing to that residue class. For a monic f whose reduction factors as g₀h₀ with monic relatively prime factors in k[X], Hensel's lemma gives unique monic lifts g and h with f = gh and the prescribed reductions. The lifted factors are strictly coprime: their generated ideal is all of A[X]. These statements distinguish root lifting in a fixed residue class from factor lifting with specified residue factors.

Scope: Completeness, the discrete valuation ring assumption and the indicated simplicity or coprimality conditions are part of these statements. Multiple residue roots and noncoprime residue factors are not covered by their uniqueness conclusions; general p-adic integration and analytic function theory remain outside this reading.

## modular-forms

**模形式 / Modular Forms Expert** (D017)

Reading: [J. S. Milne — Modular Functions and Modular Forms](https://www.jmilne.org/math/CourseNotes/MF.pdf)

Reuse: PDF p. 2 permits single paper copies for noncommercial personal use. Broader redistribution permission was not established.

Locator: §4, “Modular functions” and Definition 4.5; PDF pp. 48–49.

Knowledge: In the cited even-weight setup, a modular form for a finite-index subgroup of SL₂(Z) satisfies the weight-2k transformation law and is holomorphic on the upper half-plane and at every cusp. Holomorphy at a cusp is expressed by its local q-expansion, with the cusp width entering the q-coordinate. A cusp form additionally vanishes at the cusps; a transformation law by itself does not impose these analytic conditions.

Scope: Classical even integral weights and cusp conditions; odd weights, characters, Hecke eigenforms and coefficient congruences are outside this reading.

### Further reading

Reading: [J. S. Milne — Modular Functions and Modular Forms](https://www.jmilne.org/math/CourseNotes/MF.pdf)

Locator: §4, Theorem 4.9, Example 4.14 and Proposition 4.16, PDF pp. 51, 53–54; §5, Proposition 5.16, Corollary 5.17, Proposition 5.18, Corollaries 5.19–5.20 and Theorem 5.23, PDF pp. 73–75, 77.

Knowledge: For a fixed weight and a finite-index subgroup of SL₂(Z), the modular-form space is finite-dimensional; the dimension formula depends on the compactified curve's genus, cusp count and elliptic-point data. For the full modular group, the normalized Hecke operators preserve both modular forms and cusp forms, satisfy coprime multiplicativity, and obey the prime-power relation with factor p^(2k − 1) in weight 2k. A nonzero simultaneous eigenform of positive even weight can be normalized to first Fourier coefficient 1; then its nth Hecke eigenvalue equals its nth coefficient. The coefficients satisfy c(m)c(n) = c(mn) for coprime m and n, and c(p)c(pʳ) = c(pʳ⁺¹) + p^(2k − 1)c(pʳ⁻¹) for r ≥ 1. On the cusp-form space these Hecke operators are Hermitian for the Petersson inner product.

Scope: Milne writes Mₖ for weight 2k. The cited Hecke relations and eigenvalue normalization are used at full level and positive even integral weight; the Petersson assertion is on cusp forms. Characters, arbitrary-level bad-prime operators, Sturm bounds and coefficient congruences are outside these passages.

## automorphic-forms

**自守形式 / Automorphic Forms Expert** (D018)

Reading: [Kevin Buzzard — Automorphic forms for GL2 over Q](https://www.ma.imperial.ac.uk/~buzzard/maths/research/notes/automorphic_forms_for_gl2_over_Q.pdf)

Locator: §1, “Automorphic forms: the definitions”; PDF p. 1.

Knowledge: In the GL₂/Q setting, automorphic forms are smooth complex functions on GL₂ of the adèles that are invariant under left translation by GL₂(Q). Their definition also includes finiteness conditions at the finite and archimedean places, a finiteness condition for the center of the enveloping algebra, and a polynomial growth condition. Cuspidality requires vanishing of the integrals of n ↦ f(nx) over N(Q)\N(A) for every adelic x and each rational conjugate N of the upper triangular unipotent subgroup.

Scope: The global GL₂/Q definitions in the author's notes; no general reductive-group spectral decomposition, tensor-product theorem or Langlands transfer is included.

### Further reading

Reading: [Jayce R. Getz and Heekyoung Hahn — An Introduction to Automorphic Representations with a view toward Trace Formulae, author draft of 22 April 2022](https://sites.duke.edu/jgetz/files/2022/04/Graduate_Text.pdf)

Locator: §2.6, equations (2.17)–(2.18), printed pp. 58–59 / PDF pp. 74–75; §§5.6–5.7, restricted tensor products and Theorem 5.7.1 (Flath), printed pp. 131–135 / PDF pp. 147–151; §9.1, Theorem 9.1.1 and Corollary 9.1.2, printed pp. 214–215 / PDF pp. 230–231.

Knowledge: A restricted tensor product is formed from finite tensor products by inserting chosen nonzero local vectors at the remaining places. For a reductive group G over a global field F, Flath's theorem in §5.7 factors every irreducible admissible representation of the finite-adelic convolution algebra into local factors, unique up to isomorphism. Almost all factors have a one-dimensional fixed line for the chosen hyperspecial subgroup, and the restricted product uses vectors from these lines. The global cuspidal L² subspace is closed and decomposes as a Hilbert direct sum of irreducible representations, each of finite multiplicity; compactly supported smooth convolution acts there by trace-class operators. Here the book's quotient is [G] = A_G G(F)\G(A_F), where A_G removes the specified split central direction. For number fields, A_G is the identity component of the real points of the greatest Q-split torus in Res(F/Q) Z_G; the function-field convention is defined separately in (2.17).

Scope: The Flath theorem cited here concerns finite adèles; archimedean representation data require the additional setup of Chapter 6. The discrete direct-sum assertion concerns the cuspidal subspace and does not describe all of L²([G]). Langlands transfers and the complementary Eisenstein spectrum are outside this reading. Source redistribution permission was not established; only a link and original summary are retained.

## transcendence-theory

**超越数论 / Transcendence Theory Expert** (D019)

Reading: [Michel Waldschmidt — Irrationality and transcendence of values of special functions, 25 February 2021](https://webusers.imj-prg.fr/~michel.waldschmidt/articles/pdf/ValuesSpecialFunctions.pdf)

Locator: Slide “Hermite–Lindemann Theorem (1882)”; PDF p. 8.

Knowledge: The Hermite–Lindemann statement says that for a nonzero complex number w, at least one of w and exp(w) is transcendental. Consequently, the exponential of any nonzero algebraic number is transcendental. The restriction w ≠ 0 excludes the algebraic pair 0 and exp(0) = 1.

Scope: The exponential transcendence statement and its immediate consequence; no algebraic-independence or quantitative logarithmic-form estimate is supplied here.

### Further reading

Reading: [Samit Dasgupta — Ranks of matrices of logarithms of algebraic numbers I: the theorems of Baker and Waldschmidt–Masser, arXiv:2303.02037v1](https://arxiv.org/pdf/2303.02037v1)

Reuse: No explicit redistribution licence was verified in these pages. This addition retains a link and an original summary only.

Locator: §1, definition of L and Theorem 1.2, PDF p. 2; §2, chosen complex logarithms and Theorem 2.1, PDF p. 4. The Q̄ notation was checked against images of both original pages because the text extraction drops overbars.

Knowledge: Let L consist of complex numbers x for which exp(x) is algebraic. Baker’s theorem states that a finite family in L that is linearly independent over Q remains linearly independent over Q̄, the field of algebraic numbers. The x values are chosen complex logarithms of nonzero algebraic numbers; the statement does not impose a common principal branch. The exposition states this full theorem, while its proved weaker version assumes that x₁, …, xₙ, 2πi are linearly independent over Q before concluding that x₁, …, xₙ are linearly independent over Q̄.

Scope: Qualitative linear independence of complex logarithms. This addition gives no quantitative lower bound for a linear form, no p-adic version and no algebraic-independence conclusion. The stronger Schanuel statement remains a conjecture in the source; Theorem 1.2 and the weaker theorem proved in §2 are distinguished.

## arithmetic-combinatorics

**算术组合 / Arithmetic Combinatorics Expert** (D020)

Reading: [Ben Green — C3.10 Additive Combinatorics, Oxford 2025](https://people.maths.ox.ac.uk/greenbj/papers/C3.10-Oxford-2025.pdf)

Locator: §1, Theorem 1.1, printed p. 6 / PDF p. 3; §3.5, Definitions 3.10–3.11 and Proposition 3.12, printed p. 15 / PDF p. 12.

Knowledge: The stated Roth bound guarantees a nontrivial three-term arithmetic progression in A ⊆ {1, …, N} when N is sufficiently large and |A| ≥ CN/log log N for an absolute constant C. For a finite nonempty subset A of an abelian group, additive energy counts ordered quadruples satisfying a₁ + a₂ = a₃ + a₄. With the source's normalization ω[A] = E(A)/|A|³ and doubling constant σ[A] = |A + A|/|A|, the inequality σ[A]ω[A] ≥ 1 relates small doubling to large energy.

Scope: Integer three-term progressions and finite additive sets; sparse prime transference, longer progressions and cyclic wraparound identifications are outside this reading.
### Further reading

Reading: [Ben Green — C3.10 Additive Combinatorics, Oxford 2025](https://people.maths.ox.ac.uk/greenbj/papers/C3.10-Oxford-2025.pdf)

Locator: Chapter 3, Lemma 3.2, printed p. 13 / PDF p. 10; Theorem 3.7 and Lemma 3.8, printed p. 14 / PDF p. 11.

Knowledge: Let A and B be finite nonempty subsets of an abelian group with |A + B| ≤ K|A|. Ruzsa’s covering lemma gives a set X with |X| ≤ K such that B ⊆ (A − A) + X. The Plünnecke–Ruzsa inequality bounds |kB − lB| by K^(k+l)|A| for all nonnegative integers k and l, with 0B = {0}. A single small-sumset hypothesis thus controls both a covering number and the cardinalities of iterated sum-difference sets.

Scope: Finite nonempty additive sets in an abelian group, with K ≥ 1 under these assumptions. The stated bound concerns kB − lB; bounds for A + kB and inverse structural classifications need separate statements. Lemma 3.8 provides the corresponding growth bound for a selected subset of A.
