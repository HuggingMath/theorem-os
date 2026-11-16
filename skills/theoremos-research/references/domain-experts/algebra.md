Read only the profiles relevant to the current assignment; mathematical specialties do not change source permissions, available tools or delivery rules.

## group-theory

**群论 / Group Theory Expert** (D001)

Expertise: Abstract group structure, subgroup lattices, homomorphisms and actions, including finite group theory and the relationship between an abstract group and a chosen presentation.

Knowledge: Normal subgroups admit quotient group structures, and homomorphisms factor through their kernels onto their images. For finite groups, Lagrange's theorem, Sylow theory and the class equation constrain subgroup orders and conjugacy. Orbit-stabilizer relates stabilizers to orbit cardinalities. Solvability concerns derived series, whereas nilpotency concerns central series and imposes a stronger condition.

Distinctions: A subgroup need not be normal, so its coset set need not inherit group multiplication. Faithfulness concerns the kernel of an action, while transitivity concerns its orbits. A presentation records generators and relations, rather than asserting a unique normal form for elements.

Connections: Permutation representations connect actions to combinatorics; linear representations connect groups to modules and algebras. Fundamental groups and covering spaces supply topological interpretations, while field automorphisms give the group structures occurring in Galois theory.

Example: In S₃ acting on {1, 2, 3}, the action is faithful and transitive, but the point stabilizer H = {1, (12)} is not normal: conjugating by (123) gives {1, (23)}. Thus the three cosets G/H do not form a quotient group by coset multiplication. In contrast, A₃ = {1, (123), (132)} is the unique Sylow 3-subgroup and is normal, giving S₃/A₃ ≅ C₂. The three order-two subgroups are the Sylow 2-subgroups, so n₂ = 3 satisfies n₂ ≡ 1 modulo 2 and n₂ divides 3. Transitivity therefore imposes no normality requirement on a stabilizer.

Reading: [Collected domain materials](../domain-materials/algebra.md#group-theory).

## ring-theory

**环论 / Ring Theory Expert** (D002)

Expertise: Rings, ideals, quotient rings, units and module structures, including the effects of noncommutativity and the presence or absence of a multiplicative identity.

Knowledge: Two-sided ideals define quotient rings, while left or right ideals control the corresponding module structures. For a unital ring, the Jacobson radical is the intersection of maximal right ideals and annihilates every simple right module. A semisimple Artinian ring is a finite product of matrix rings over division rings. Characteristic and zero divisors affect cancellation and polynomial identities.

Distinctions: In a commutative unital ring, maximal ideals have field quotients and prime ideals have integral-domain quotients. Neither primality nor maximality entails principality in general. Being nonzero, being a nonzero divisor and being invertible are different properties of an element; their left and right versions may differ.

Connections: Module theory records how rings act on additive groups. Commutative algebra develops localization and geometric spectra, while representation theory and associative algebra study noncommutative rings through their simple modules and endomorphism rings.

Example: Let R = M₂(k) for a field k, and let I = R E₁₁ be the matrices whose second column is zero. Left multiplication preserves this condition, so I is a left ideal. It is not a right ideal: E₁₁ lies in I, but E₁₁E₁₂ = E₁₂ does not. Consequently R/I is a two-dimensional left R-module, yet multiplication of additive cosets is not well-defined. The representatives E₁₁ and 0 describe the same coset, while their products with E₁₂ describe distinct cosets. The obstruction is sidedness of the ideal, rather than a failure of additive quotient construction.

Reading: [Collected domain materials](../domain-materials/algebra.md#ring-theory).

## field-galois-theory

**域论与伽罗瓦理论 / Field and Galois Theory Expert** (D003)

Expertise: Field extensions, algebraic elements, polynomial splitting, embeddings and automorphism groups, with attention to base fields, extension towers and characteristic.

Knowledge: Minimal polynomials describe algebraic elements, and degrees multiply in finite extension towers with compatible base-field structures. Separability controls distinct conjugates; normality concerns splitting of irreducible polynomials having a root in the extension. For finite Galois extensions, intermediate fields correspond in reverse order to subgroups of the automorphism group. In infinite Galois theory, closed subgroups in the Krull topology are the corresponding objects.

Distinctions: Algebraic extensions need not be finite, separable or normal. In positive characteristic, purely inseparable extensions can have nontrivial degree and no nontrivial base-field automorphisms. An embedding into an algebraic closure is different from an automorphism of the specified extension.

Connections: Polynomial factorization and resolvents connect field theory to explicit algebra. Number fields, finite fields and function fields connect extension theory to arithmetic, while descent and symmetry connect Galois actions to algebraic geometry and representation theory.

Example: The polynomial t² + t + 1 has no root in F₂, so F₂[t]/(t² + t + 1) is a field with four elements. Writing a for the class of t gives a² = a + 1 and a³ = 1. Frobenius fixes 0 and 1 and interchanges a with a + 1, so it has order two and fixed field F₂. Thus Gal(F₄/F₂) ≅ C₂, despite the multiplicative group F₄* having order three. The subfield correspondence contains only F₂ and F₄; the field automorphism group and the group of nonzero field elements are different objects.

Reading: [Collected domain materials](../domain-materials/algebra.md#field-galois-theory).

## commutative-algebra

**交换代数 / Commutative Algebra Expert** (D004)

Expertise: Commutative rings and modules through localization, ideal structure, finite generation, integral dependence and dimension, including the algebra underlying local and global geometry.

Knowledge: Localization makes a multiplicative set invertible and identifies prime ideals disjoint from that set with primes of the localized ring. For finitely generated modules over a local ring, Nakayama's lemma relates generation to the residue field. Integral extensions satisfy lying-over and going-up. Noetherian hypotheses control ascending ideal chains, while Krull dimension records chains of prime ideals.

Distinctions: Reduced rings have no nonzero nilpotents but can still have zero divisors. Algebraicity over a field and integrality over a ring impose different polynomial conditions. Finite generation differs from finite presentation. Equality in one localization need not be equality in the original module.

Connections: Spectra and local rings link these structures to algebraic geometry. Depth and regular sequences link them to homological algebra; Dedekind domains and completions connect them to algebraic number theory and local arithmetic.

Example: For a field k, set R = k[x, y]/(xy). Sending a class f to (f(x, 0), f(0, y)) embeds R into k[x] × k[y], with image the pairs having equal constant terms: the kernel before quotienting is (x) ∩ (y) = (xy). Hence R is reduced, although its nonzero classes x and y multiply to zero. After localizing at the powers of x, the equation xy = 0 forces y = 0, and R[x⁻¹] ≅ k[x, x⁻¹]. Thus reducedness permits zero divisors, and the localization map need not be injective even when the original ring has no nonzero nilpotents.

Reading: [Collected domain materials](../domain-materials/algebra.md#commutative-algebra).

## homological-algebra

**同调代数 / Homological Algebra Expert** (D005)

Expertise: Chain complexes, exact sequences, resolutions and derived constructions in module categories or suitably structured abelian categories, including the maps and functoriality of homology.

Knowledge: Consecutive differentials compose to zero, so boundaries lie in cycles and homology is their quotient. Short exact sequences of complexes induce long exact sequences in homology with connecting morphisms. In categories with enough projectives or injectives, resolutions support left or right derived functors under the appropriate exactness assumptions. Tor measures failures of tensor exactness, while Ext records derived information about Hom.

Distinctions: An isomorphism of complexes, a chain homotopy equivalence and a quasi-isomorphism are different notions. Acyclicity means vanishing homology and does not generally imply contractibility. Tensor products are right exact, with flatness governing preservation of injectivity in short exact sequences.

Connections: Algebraic topology supplies geometric chain complexes; commutative algebra interprets depth and regularity through derived functors. Derived categories organize quasi-isomorphisms, while representation theory uses extensions to describe how modules fit together.

Example: Let R = k[ε]/(ε²) for a field k, and regard k = R/(ε) as an R-module. Multiplication by ε has both kernel and image (ε), so the complex … → R → R → R → k → 0, with every displayed R-to-R map multiplication by ε, is a free resolution. Tensoring with k makes all these differentials zero, giving Torᵢ^R(k, k) ≅ k for every i ≥ 0. In particular k is not flat: tensoring the injection (ε) → R with k gives the zero map k → k. Exactness of the resolution therefore does not survive this tensor functor.

Reading: [Collected domain materials](../domain-materials/algebra.md#homological-algebra).

## representation-theory

**表示论 / Representation Theory Expert** (D006)

Expertise: Linear representations, invariant subspaces, intertwiners, characters and decomposition, including how the scalar field and its characteristic influence the resulting structure.

Knowledge: Representations of a group over a field correspond to modules over its group algebra, and intertwiners are module homomorphisms. For a finite group with order invertible in the field, Maschke's theorem gives complete reducibility. Schur's lemma makes the endomorphism ring of an irreducible representation a division ring; for finite dimensional representations over an algebraically closed field, these endomorphisms are scalar.

Distinctions: Irreducibility differs from complete reducibility and from absolute irreducibility under field extension. For finite groups, ordinary complex characters determine finite dimensional representations up to equivalence, while modular representation theory has different character and extension phenomena. Equivalent representations need not have identical matrices in chosen bases.

Connections: Group algebras link representation theory to associative algebra and module theory. Lie algebras, harmonic analysis and algebraic groups supply related representation categories, while invariant theory concerns the fixed tensors, functions and subspaces associated with actions.

Example: Let k have characteristic p > 0 and let a generator of C_p act on k² by T = I + N, where N(e₂) = e₁ and N(e₁) = 0. Since N² = 0 and p = 0 in k, T^p = I, so this defines a representation. The invariant line ke₁ and its quotient are both trivial representations. Nevertheless there is no invariant complement: a complementary line contains a vector v = ae₁ + be₂ with b ≠ 0, and T(v) − v = be₁ cannot lie in that line. This nonsplit extension explains why Maschke’s invertibility hypothesis matters.

Reading: [Collected domain materials](../domain-materials/algebra.md#representation-theory).

## lie-algebras

**李代数 / Lie Algebra Expert** (D007)

Expertise: Lie brackets, ideals, modules, solvability and nilpotency, including the dependence of structural statements on characteristic, dimension and the base field.

Knowledge: A Lie bracket is bilinear, alternating and satisfies the Jacobi identity. The adjoint action represents the algebra by derivations. Engel's theorem relates nilpotence of adjoint operators to nilpotence of a finite dimensional Lie algebra. Over an algebraically closed field of characteristic zero, Lie's theorem triangularizes finite dimensional representations of solvable Lie algebras. Universal enveloping algebras encode Lie modules as associative modules.

Distinctions: Skew symmetry alone does not imply alternation in characteristic two. Solvability is weaker than nilpotency, and an ideal requires stability under brackets with the entire algebra. A Lie algebra representation does not automatically integrate to a representation of a specified Lie group.

Connections: Commutators connect associative algebras to Lie algebras. Tangent spaces of Lie groups and algebraic groups supply geometric origins; root systems, weights and invariant forms connect semisimple structure to representation theory and geometry.

Example: Over a characteristic-zero field, take h = diag(1, 0) and e = E₁₂ inside M₂(k), with bracket [a, b] = ab − ba. Their span g satisfies [h, e] = e. Its derived series is g, ke, 0, because [ke, ke] = 0, so g is solvable. Its lower central series is g, ke, ke, …, because [g, ke] = ke, so g is not nilpotent. Equivalently ad(h) fixes e and is not a nilpotent operator. The same one-dimensional commutator subspace behaves differently depending on which series is being formed.

Reading: [Collected domain materials](../domain-materials/algebra.md#lie-algebras).

## associative-algebras

**结合代数 / Associative Algebra Expert** (D008)

Expertise: Associative algebras over a base ring or field, their modules, radicals, centers and tensor products, including the structure of finite dimensional algebras.

Knowledge: The base-ring action in an algebra is compatible with multiplication and is central in the usual unital definition. Finite dimensional semisimple algebras decompose into matrix algebras over division rings. For finite dimensional algebras over a field, the Jacobson radical is nilpotent and the quotient is semisimple. Central simple algebras and their tensor products give Brauer classes, whose identity is weaker than isomorphism of representatives.

Distinctions: Simple, semisimple and central simple describe different properties. Left modules, right modules and bimodules have different action data, with opposite algebras governing the switch of side. Morita equivalence identifies module categories but need not identify the algebras themselves.

Connections: Group and enveloping algebras connect these structures to representation theory. Division algebras and Brauer groups connect them to field theory and arithmetic, while Hochschild cohomology describes extensions and deformation phenomena.

Example: Let T be the algebra of upper triangular 2 × 2 matrices over a field k. Its strictly upper triangular ideal J = kE₁₂ satisfies J² = 0, while the diagonal map gives T/J ≅ k × k. The natural module k² has invariant submodule ke₁ and one-dimensional quotient. It does not split: any vector outside ke₁ has nonzero second coordinate, and E₁₂ sends it to a nonzero vector in ke₁, ruling out an invariant complementary line. Thus a semisimple quotient can coexist with a nonsplit module for the original algebra; the off-diagonal action is precisely the data lost in the quotient.

Reading: [Collected domain materials](../domain-materials/algebra.md#associative-algebras).

## universal-algebra

**泛代数 / Universal Algebra Expert** (D009)

Expertise: Algebraic signatures, terms, equations, congruences and free objects, including structural properties shared across classes of algebras rather than tied to one operation system.

Knowledge: A signature specifies operations and their arities; its terms acquire values under variable assignments in an algebra. Congruences are equivalence relations compatible with every operation and determine quotient algebras. Free algebras represent assignments of generators subject to stated equations. For finitary signatures, Birkhoff's theorem characterizes varieties through closure under homomorphic images, subalgebras and products, with the carrier convention fixed.

Distinctions: Syntactic equality of terms differs from an identity holding in a class of algebras. A compatible congruence is stronger than an arbitrary equivalence relation. Nullary operations affect empty carriers, and an arbitrary algebraic-looking class need not be axiomatizable by equations.

Connections: Algebraic theories and monads express these structures categorically. Term rewriting connects equations to computation, while model theory distinguishes equational classes from more general first-order theories and studies their interpretability.

Example: On the additive group Z/3Z, the partition {{0, 1}, {2}} defines an equivalence relation but not a congruence: 0 is equivalent to 1, whereas adding 1 gives 1 and 2, which are inequivalent. By contrast, congruences modulo 2 and modulo 3 on Z permute. For any a and c, the Chinese remainder theorem supplies b with b ≡ a modulo 2 and b ≡ c modulo 3; either relational composite is therefore universal. The group term p(x, y, z) = x − y + z satisfies p(x, x, y) = y and p(x, y, y) = x, connecting this calculation to Mal’cev’s criterion.

Reading: [Collected domain materials](../domain-materials/algebra.md#universal-algebra).

## linear-algebra

**线性代数 / Linear Algebra Expert** (D010)

Expertise: Vector spaces, linear maps, bases, rank, determinants and spectral structure, including the relationship between intrinsic linear objects and their coordinate descriptions.

Knowledge: Kernels and images describe linear equations, and rank-nullity relates their dimensions for finite dimensional domains. Determinants detect invertibility of endomorphisms in finite dimension. A finite dimensional endomorphism is diagonalizable over its field exactly when its minimal polynomial splits into distinct linear factors. Spectral theorems for self-adjoint operators additionally depend on the relevant real or complex inner product structure.

Distinctions: Injectivity and surjectivity coincide for endomorphisms of a finite dimensional space but not in general. Splitting of the characteristic polynomial alone does not imply diagonalizability. A nondegenerate bilinear form need not be positive definite, and a matrix depends on both domain and codomain bases.

Connections: Modules over polynomial rings encode endomorphisms and canonical forms. Representation theory adds compatible group or algebra actions; functional analysis adds topology and boundedness, where finite dimensional equivalences and spectral conclusions require new hypotheses.

Example: The real matrix J = [[1, 1], [0, 1]] has characteristic polynomial (X − 1)², yet ker(J − I) is only the line spanned by e₁. Its minimal polynomial is (X − 1)², so splitting of the characteristic polynomial gives no eigenbasis. A different obstruction occurs for R = [[0, −1], [1, 0]]: R*R = RR* = I, making it normal, but its characteristic polynomial X² + 1 has no real root. Over C, R has eigenvalues i and −i and an orthonormal eigenbasis. The ground field and the adjoint hypothesis control different parts of the spectral conclusion.

Reading: [Collected domain materials](../domain-materials/algebra.md#linear-algebra).
