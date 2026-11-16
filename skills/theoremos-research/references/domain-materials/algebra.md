# Algebra: collected reading

These are original summaries of passages read for the first collection. Read the identified source for its full statements and conventions. PDF pages count from the first page of the downloaded file and can differ from printed pages. This file retains links and original summaries only. Reuse notes report explicit statements read in the sources; other source licences remain unverified.

## group-theory

**群论 / Group Theory Expert** (D001)

Reading: [J. S. Milne — Group Theory](https://www.jmilne.org/math/CourseNotes/GT.pdf)

Reuse: The front matter (PDF p. 2) states CC BY-NC-SA 4.0 for version 4.0; the declaration explicitly names that version.

Locator: Chapter 1, “Kernels and quotients,” Propositions 1.41–1.43; PDF pp. 20–21.

Knowledge: Normal subgroups are exactly the kernels of group homomorphisms. For a normal subgroup N, multiplication of cosets gives G/N a group structure for which the quotient map is a homomorphism. Any homomorphism from G that kills N factors uniquely through that quotient map.

Scope: Kernels, normal subgroups and quotient universal properties; finite-group classification and Sylow theory are outside these passages.

### Further reading

Reading: [J. S. Milne — Group Theory](https://www.jmilne.org/math/CourseNotes/GT.pdf)

Locator: Chapter 5, finite-group convention and Sylow subgroup definition, PDF p. 77; Theorems 5.2 and 5.6, PDF pp. 78–79; Corollary 5.8, PDF p. 80.

Knowledge: For a finite group G and a prime p, write |G| = p^r m with p not dividing m. A Sylow p-subgroup has order p^r. Such subgroups exist, all are conjugate, and every p-subgroup lies in one. Their number n_p satisfies n_p ≡ 1 modulo p and divides m. A Sylow p-subgroup is normal exactly when it is unique. More generally, every prime power dividing |G| occurs as the order of a subgroup.

Scope: These are finite-group results. The counting constraints restrict possible subgroup structures without classifying all finite groups; infinite-group Sylow variants are outside this reading.

## ring-theory

**环论 / Ring Theory Expert** (D002)

Reading: [Pavel Etingof, Oleg Golberg, Sebastian Hensel, Tiankai Liu, Alex Schwendner, Dmitry Vaintrob and Elena Yudovina — Introduction to Representation Theory](https://math.mit.edu/~etingof/reprbook.pdf)

Locator: §§2.4–2.5, “Ideals” and “Quotients”; printed pp. 15–16, PDF pp. 23–24.

Knowledge: In an associative algebra, a left ideal is stable under multiplication from the left, while a right ideal is stable under multiplication from the right. A two-sided ideal supports quotient multiplication independently of representatives. A left ideal alone gives a quotient left module, which need not carry the quotient algebra multiplication.

Scope: Ideals and quotients for associative algebras over a field; the source is not a treatment of all rings or nonunital conventions.

### Further reading

Reading: [J. S. Milne — A Primer of Commutative Algebra](https://www.jmilne.org/math/xnotes/CA.pdf)

Reuse: PDF p. 1 permits single paper copies for noncommercial personal use. Broader redistribution permission was not established.

Locator: Notations and conventions, PDF p. 2; §2, the coprime-ideal definition and Theorem 2.13, PDF p. 8.

Knowledge: In a commutative ring A with identity, ideals a and b are coprime when a + b = A. For a finite pairwise coprime family a₁, …, aₙ, the canonical map A → ∏ A/aᵢ is surjective and has kernel ∩ aᵢ = ∏ aᵢ. It therefore induces an isomorphism A/(∩ aᵢ) ≅ ∏ A/aᵢ. For arbitrary ideals the product is contained in the intersection, and equality need not hold.

Scope: Finite families of ideals in commutative unital rings, with homomorphisms preserving identity. Infinite products, noncommutative variants and the general compatibility criterion without pairwise coprimality require separate statements.

## field-galois-theory

**域论与伽罗瓦理论 / Field and Galois Theory Expert** (D003)

Reading: [J. S. Milne — Fields and Galois Theory](https://www.jmilne.org/math/CourseNotes/FT.pdf)

Reuse: The front matter (PDF p. 2) states CC BY-NC-SA 4.0 for version 5.0; the declaration explicitly names that version.

Locator: Chapter 3, Definitions 3.6–3.9 and Theorem 3.17; PDF pp. 37, 39.

Knowledge: Separability concerns repeated roots of minimal polynomials, whereas normality requires each minimal polynomial to split over the extension. For a finite normal separable extension E/F, subgroups of its Galois group correspond in reverse order to intermediate fields. Normal subgroups correspond to intermediate extensions normal over F, with their Galois groups given by the corresponding quotient groups.

Scope: Finite Galois correspondence; the cited chapter explicitly includes finiteness in its definition of “Galois,” so no infinite Galois-topology claim is included.

### Further reading

Reading: [J. S. Milne — Fields and Galois Theory](https://www.jmilne.org/math/CourseNotes/FT.pdf)

Locator: Chapter 4, Proposition 4.20 and Corollary 4.21, PDF p. 53; Proposition 4.23, PDF p. 54.

Knowledge: For each prime p and positive integer n, a field of p^n elements exists and is unique up to isomorphism: it is a splitting field of X^(p^n) − X over F_p. Its Galois group over F_p is cyclic of order n, generated by x ↦ x^p. Inside a fixed algebraic closure, F_(p^m) is a subfield of F_(p^n) exactly when m divides n; in that case the relative Galois group is generated by x ↦ x^(p^m). Each divisor m of n gives exactly one subfield of p^m elements.

Scope: Finite fields and finite extensions. Uniqueness up to isomorphism does not specify a canonical isomorphism between separately presented fields; uniqueness as a subfield uses a fixed algebraic closure. Infinite Galois topology remains outside this reading.

## commutative-algebra

**交换代数 / Commutative Algebra Expert** (D004)

Reading: [J. S. Milne — A Primer of Commutative Algebra](https://www.jmilne.org/math/xnotes/CA.pdf)

Reuse: PDF p. 1 permits single paper copies for noncommercial personal use. Broader redistribution permission was not established.

Locator: §3, Theorem 3.7 and Nakayama's Lemma 3.9, PDF p. 11; §5, Proposition 5.1, PDF p. 18.

Knowledge: A finitely generated algebra over a commutative noetherian ring is noetherian. If M is finitely generated and an ideal a lies in every maximal ideal, the equality M = aM forces M = 0. Localization at a multiplicative set S has the universal property that ring maps sending S to units factor uniquely through it; its map from the original ring can have a kernel when S meets zero divisors.

Scope: Noetherianity, the stated finite-generation form of Nakayama's lemma and localization; no dimension or homological-regularity results are asserted here.

### Further reading

Reading: [J. S. Milne — A Primer of Commutative Algebra](https://www.jmilne.org/math/xnotes/CA.pdf)

Locator: §6, integral-dependence definition, PDF p. 25, and Corollary 6.3, PDF p. 26; §7, Corollaries 7.3–7.4, Proposition 7.5 and Theorem 7.6, PDF p. 31. Ring conventions: PDF p. 2.

Knowledge: An element is integral over A when it satisfies a monic polynomial with coefficients in A. An A-algebra is finite as an A-module exactly when it is both of finite type and integral over A. For an integral inclusion A ⊆ B, every prime p of A has a prime of B lying over it. A prime q of B is maximal exactly when q ∩ A is maximal, and comparable primes lying over the same p are equal. Going up extends a chosen prime q over p along an inclusion p ⊆ p′ to a prime q′ containing q over p′.

Scope: Commutative unital rings and integral inclusions. Finite type alone does not imply module finiteness. Going down, flatness and dimension formulas require additional hypotheses or results beyond the statements collected here.

## homological-algebra

**同调代数 / Homological Algebra Expert** (D005)

Reading: [Pavel Etingof et al. — Introduction to Representation Theory](https://math.mit.edu/~etingof/reprbook.pdf)

Locator: §§8.1–8.2, Theorem 8.1.1, Definitions 8.1.2 and 8.2.1–8.2.4; printed pp. 205–208, PDF pp. 213–216.

Knowledge: A projective module is equivalently a direct summand of a free module or a module whose covariant Hom functor is exact. A projective resolution is an exact sequence of projective modules ending in the given module. Tor and Ext measure failures of exactness of tensor and Hom functors, with left and right module positions specified in their definitions.

Scope: Projectivity, resolutions and the initial definitions of Tor and Ext for module categories; derived categories and spectral sequences are outside this reading.

### Further reading

Reading: [Pavel Etingof, Oleg Golberg, Sebastian Hensel, Tiankai Liu, Alex Schwendner, Dmitry Vaintrob and Elena Yudovina — Introduction to Representation Theory](https://math.mit.edu/~etingof/reprbook.pdf)

Locator: §7.8, Problem 7.8.5 and Definition 7.8.6, printed pp. 191–193 / PDF pp. 199–201; §8.2, Problems 8.2.5(iii–v) and 8.2.6, printed pp. 209–210 / PDF pp. 217–218.

Knowledge: A short exact sequence of complexes induces a long exact sequence of cohomology, with connecting maps from degree i of the quotient complex to degree i + 1 of the subcomplex. The comparison maps between projective resolutions induce canonical isomorphisms on Tor and Ext, so these groups do not depend on a chosen resolution. Their degree-zero terms recover tensor product and Hom. For a short exact sequence in the second variable, Ext(M, −) has connecting maps that raise degree, while Tor(M, −) has connecting maps that lower homological degree. Ext(−, N) reverses arrows in the first variable, and its long exact sequence begins with Hom(M₃, N) → Hom(M₂, N) → Hom(M₁, N).

Scope: Module categories over an associative algebra; tensor products require a right module in the first position and a left module in the second, while Ext here uses two left modules. Several assertions are presented as problems in the source. General derived-functor axioms, derived categories and spectral sequences remain outside these passages.

## representation-theory

**表示论 / Representation Theory Expert** (D006)

Reading: [Pavel Etingof et al. — Introduction to Representation Theory](https://math.mit.edu/~etingof/reprbook.pdf)

Locator: §4.1, Theorem 4.1.1 and its invariant-complement statement; printed pp. 61–62, PDF pp. 69–70. The book's default algebraically closed field convention is in §2.2, printed p. 8 / PDF p. 16.

Knowledge: For a finite group G over a field whose characteristic does not divide |G|, finite-dimensional representations are completely reducible. Equivalently, the group algebra is semisimple. Under the source's algebraically closed field convention, the regular representation contains each irreducible with multiplicity equal to its dimension, yielding the sum-of-squares formula for |G|.

Scope: Maschke's theorem and the regular representation; the matrix-block and dimension formulas here retain the algebraically closed field assumption.

### Further reading

Reading: [Pavel Etingof, Oleg Golberg, Sebastian Hensel, Tiankai Liu, Alex Schwendner, Dmitry Vaintrob and Elena Yudovina — Introduction to Representation Theory](https://math.mit.edu/~etingof/reprbook.pdf)

Locator: §5.8, Definition 5.8.1 and Remark 5.8.3, printed p. 108 / PDF p. 116; §5.10, Theorem 5.10.1, printed p. 110 / PDF p. 118.

Knowledge: For finite groups H ≤ G and finite-dimensional complex representations W of H and V of G, the source realizes Ind_H^G W as functions f : G → W satisfying f(hx) = h f(x), with action (g f)(x) = f(xg). Its dimension is [G : H] dim W. Frobenius reciprocity gives the natural isomorphism Hom_G(V, Ind_H^G W) ≅ Hom_H(Res_H^G V, W), relating G-equivariant maps into this induced representation to H-equivariant maps from the restriction.

Scope: Finite groups and finite-dimensional complex representations. The Hom orientation follows Theorem 5.10.1 and its function-space definition; tensor-product and infinite-group formulations need their own definitions and hypotheses.

## lie-algebras

**李代数 / Lie Algebra Expert** (D007)

Reading: [Pavel Etingof et al. — Introduction to Representation Theory](https://math.mit.edu/~etingof/reprbook.pdf)

Locator: §2.9, Definition 2.9.1 and Example 2.9.2; printed pp. 22–23, PDF pp. 30–31.

Knowledge: A Lie algebra has a bilinear alternating bracket satisfying the Jacobi identity. The commutator ab − ba on an associative algebra supplies such a bracket. Derivations satisfying the Leibniz rule form another class of examples, with their bracket given by commutators of linear maps.

Scope: Definitions, commutator algebras and derivations; no characteristic-free version of Ado's theorem or classification theorem is claimed from these examples.

### Further reading

Reading: [Pavel Etingof, Oleg Golberg, Sebastian Hensel, Tiankai Liu, Alex Schwendner, Dmitry Vaintrob and Elena Yudovina — Introduction to Representation Theory](https://math.mit.edu/~etingof/reprbook.pdf)

Locator: §2.14, Definitions 2.14.1–2.14.2; §2.15, Problem 2.15.1(f–k), printed pp. 37–39 / PDF pp. 45–47.

Knowledge: A Lie algebra element x acts on a tensor product by ρV(x) ⊗ Id + Id ⊗ ρW(x), and on the dual by −ρV(x)*. For sl₂ over C, finite-dimensional irreducibles are indexed by nonnegative integral highest weights λ; the representation Vλ has dimension λ + 1, giving one irreducible isomorphism class in each positive dimension. Every finite-dimensional representation is a direct sum of these irreducibles. With relations [H, E] = 2E, [H, F] = −2F and [E, F] = H, the Casimir EF + FE + H²/2 acts on Vλ by the scalar λ(λ + 2)/2.

Scope: The sl₂ classification and complete reducibility here require finite dimension and the explicitly stated ground field C. They occur in a structured problem rather than a separately numbered theorem; arbitrary Lie algebras, positive characteristic and infinite-dimensional representations are not covered by this classification.

## associative-algebras

**结合代数 / Associative Algebra Expert** (D008)

Reading: [Pavel Etingof et al. — Introduction to Representation Theory](https://math.mit.edu/~etingof/reprbook.pdf)

Locator: §3.5, Theorem 3.5.4, Definition 3.5.7 and Proposition 3.5.8; printed pp. 50–51, PDF pp. 58–59. See §2.2, PDF p. 16, for the default field convention.

Knowledge: For a finite-dimensional algebra over an algebraically closed field, the quotient by its radical is a finite direct sum of endomorphism algebras of its irreducible modules. In this setting, vanishing of the radical is equivalent to a decomposition into matrix algebras. It is also equivalent to complete reducibility of every finite-dimensional representation of the algebra.

Scope: Finite-dimensional associative algebras over algebraically closed fields; arbitrary-field division-algebra blocks and infinite-dimensional structure are not covered.

### Further reading

Reading: [Pavel Etingof, Oleg Golberg, Sebastian Hensel, Tiankai Liu, Alex Schwendner, Dmitry Vaintrob and Elena Yudovina — Introduction to Representation Theory](https://math.mit.edu/~etingof/reprbook.pdf)

Locator: §3.2, algebraically closed field convention, printed p. 45 / PDF p. 53; Theorem 3.2.2, printed p. 46 / PDF p. 54.

Knowledge: Let A be an algebra over an algebraically closed field k. If V is a finite-dimensional irreducible A-module, the action map A → End_k(V) is surjective; hence A modulo the kernel of that action is the full endomorphism algebra. For a finite family of pairwise nonisomorphic finite-dimensional irreducible modules Vᵢ, the combined action map A → ⊕ End_k(Vᵢ) is also surjective. Thus independent prescribed endomorphisms on these different irreducibles occur as the actions of one algebra element.

Scope: The modules are finite-dimensional and the field is algebraically closed; A itself need not be finite-dimensional. Surjectivity does not imply that the action is faithful. Arbitrary-field division-endomorphism refinements and infinite-dimensional density statements are outside these passages.

## universal-algebra

**泛代数 / Universal Algebra Expert** (D009)

Reading: [Stanley Burris and H. P. Sankappanavar — A Course in Universal Algebra](https://www.math.uwaterloo.ca/~snburris/htdocs/UALG/univ-algebra2012.pdf)

Locator: Chapter II, §1, Definitions 1.1–1.3, printed p. 23 / PDF p. 37; §5, Definition 5.1, printed p. 35 / PDF p. 49; §9, Definition 9.3, printed p. 61 / PDF p. 75; §11, Theorem 11.9, printed p. 75 / PDF p. 89.

Knowledge: An algebra in this text has a nonempty carrier and operations of a fixed finitary signature. A congruence is an equivalence relation compatible with every basic operation, which makes operations on equivalence classes well defined. Birkhoff's theorem identifies equational classes with varieties, where varieties are nonempty classes closed under subalgebras, homomorphic images and direct products under the text's conventions.

Scope: Finitary signatures, congruences, quotient algebras and the equational-class characterization; infinitary operations require a different setup.

### Further reading

Reading: [Stanley Burris and H. P. Sankappanavar — A Course in Universal Algebra](https://www.math.uwaterloo.ca/~snburris/htdocs/UALG/univ-algebra2012.pdf)

Locator: Chapter II, §5, Definition 5.8 and Theorems 5.9–5.10, printed pp. 40–41 / PDF pp. 54–55; §12, Theorems 12.2–12.3, printed pp. 78–79 / PDF pp. 92–93.

Knowledge: Congruences θ and φ permute when their relational composites commute; this is equivalent to θ ∨ φ = θ ∘ φ. An algebra whose congruences all permute has a modular congruence lattice. Mal'cev's theorem characterizes congruence-permutable varieties by a ternary term p satisfying p(x, x, y) = y and p(x, y, y) = x as identities throughout the variety. The terms xy⁻¹z for groups and x − y + z for rings exhibit this condition. A majority term m satisfying m(x, x, y) = m(x, y, x) = m(y, x, x) = x is sufficient for congruence-distributivity.

Scope: The Mal'cev equivalence is a statement about a variety and one term working throughout it. The cited majority-term theorem supplies a sufficient condition; it does not assert that every congruence-distributive variety has a majority term. Congruence-modularity is weaker than congruence-permutability.

## linear-algebra

**线性代数 / Linear Algebra Expert** (D010)

Reading: [Sheldon Axler — Linear Algebra Done Right, fourth edition](https://linear.axler.net/LADR4e.pdf)

Reuse: PDF p. 1 states CC BY-NC 4.0, with attribution and the source's stated conditions and third-party-material exceptions.

Locator: §5D, “Conditions for Diagonalizability,” Theorem 5.55; printed p. 165, PDF p. 179.

Knowledge: A linear operator on a finite-dimensional vector space is diagonalizable exactly when the space has a basis of eigenvectors. This is equivalent to the space being the direct sum of the eigenspaces for the distinct eigenvalues in the base field. Equivalently, the dimensions of those eigenspaces sum to the dimension of the whole space.

Scope: Finite-dimensional diagonalizability over the chosen base field; no assertion that all operators have enough eigenvalues or that their eigenbases are orthonormal.
### Further reading

Reading: [Sheldon Axler — Linear Algebra Done Right, fourth edition](https://linear.axler.net/LADR4e.pdf)

Locator: Chapter 7 standing assumptions, printed p. 227 / PDF p. 241; Definitions 7.10 and 7.18, printed pp. 233, 235 / PDF pp. 247, 249; §7B, Theorems 7.29 and 7.31, printed pp. 245–246 / PDF pp. 259–260.

Knowledge: For an operator T on a finite-dimensional inner product space, self-adjoint means T = T* and normal means TT* = T*T. Over R, self-adjointness is equivalent to having an orthonormal basis of eigenvectors. Over C, normality is equivalent to having such a basis. Equivalently, the operator has a diagonal matrix in an orthonormal basis under the respective hypothesis. These statements use the chosen inner product through the adjoint and orthogonality.

Scope: Finite-dimensional real or complex inner product spaces. The real theorem requires self-adjointness; real normal operators can lack a real eigenbasis. Infinite-dimensional spectral measures and unbounded operators require different statements.
