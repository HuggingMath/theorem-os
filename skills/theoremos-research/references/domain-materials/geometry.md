# Geometry: collected reading

Read the relevant section for subject knowledge. The summaries below describe the identified passages, rather than prescribing a proof method. PDF pages start at the first page of the downloaded file; printed page numbers may differ. Links and original summaries are provided here; third-party full texts remain outside the Skill, under their own reuse terms.

## euclidean-geometry

**欧氏几何专家 / Euclidean Geometry Expert** (D021)

Reading: [Michael P. Hitchman — Geometry with an Introduction to Cosmic Topology](https://mphitchman.com/geometry/section3-1.html)

Locator: §3.1, Definition 3.1.14, Example 3.1.15 and Theorems 3.1.17–3.1.20.

Knowledge: A Euclidean isometry preserves the distance between every pair of points in the complex plane. The transformation z ↦ az + b preserves distance precisely when |a| = 1. Reflections preserve lines, circles and angle magnitudes, and every planar Euclidean isometry is a composition of at most three reflections.

Scope: Euclidean plane transformations and metric preservation; higher-dimensional geometry and synthetic triangle geometry are outside these passages.

### Further reading

Reading: [Michael P. Hitchman — Geometry with an Introduction to Cosmic Topology](https://mphitchman.com/geometry/section3-2.html)

Locator: §3.2, circle-inversion definition, Example 3.2.1 and Theorem 3.2.6, including its cline-equation discussion.

Knowledge: For a circle with center o and radius r > 0, inversion sends z ≠ o to o + r²/overline(z−o). It fixes the circle and interchanges its inside and outside. A circle through o, with o removed, maps to a line; a circle avoiding o maps to a circle. A line through o maps to itself with o excluded, while a line avoiding o maps to a circle with o excluded. The puncture matters because this section defines inversion on the plane with its center removed.

Scope: Plane circle inversion, its excluded center and the line/circle image cases; angle preservation and Möbius classification require further passages.

## projective-geometry

**射影几何专家 / Projective Geometry Expert** (D022)

Reading: [Jean-Pierre Demailly — Complex Analytic and Differential Geometry](https://www-fourier.univ-grenoble-alpes.fr/~demailly/manuscripts/agbook.pdf)

Locator: Chapter V, §15.A, printed/PDF p. 277, especially the definition of P(V), homogeneous coordinates and O(−1).

Knowledge: For a complex vector space V of dimension n + 1, projective space P(V) identifies nonzero vectors that differ by a nonzero scalar and therefore parametrizes lines through the origin. Homogeneous coordinates become ordinary complex coordinates on the charts where a chosen coordinate is nonzero. The tautological line bundle has the represented line as its fiber over each projective point.

Scope: Complex projective space, its coordinate charts and tautological line bundle; arbitrary-field incidence geometry is not covered.

### Further reading

Reading: [Jean-Pierre Demailly — Complex Analytic and Differential Geometry](https://www-fourier.univ-grenoble-alpes.fr/~demailly/manuscripts/agbook.pdf)

Locator: Chapter II, §4.1, Definition 4.1, printed/PDF p. 91; §8, Chow’s Theorem 8.10 and its context, printed/PDF p. 121.

Knowledge: Chow’s theorem says that an analytic subset of finite-dimensional complex projective space is algebraic: it is the common zero set of finitely many homogeneous complex polynomials. Here an analytic subset is closed in the ambient manifold and is locally the common zero set of finitely many holomorphic functions. Closedness and the complex projective ambient space are part of the result; a local holomorphic equation on an affine chart alone does not establish global projective algebraicity.

Scope: Chow’s algebraicity theorem for closed complex analytic subsets of projective space; arbitrary real projective sets, nonclosed immersed images and scheme-theoretic refinements remain outside this addition.

## affine-geometry

**仿射几何专家 / Affine Geometry Expert** (D023)

Reading: [Stephen Boyd and Lieven Vandenberghe — Convex Optimization](https://web.stanford.edu/~boyd/cvxbook/bv_cvxbook.pdf)

Locator: §§2.1.1–2.1.3; printed pp. 21–23, PDF pp. 35–37.

Knowledge: An affine combination has coefficients whose sum is one, with no sign restriction. A nonempty affine subset of Rⁿ is a translate of a linear subspace; that subspace determines its affine dimension. The affine hull is the smallest affine set containing the given set, and relative interior uses the topology of that hull.

Scope: Finite-dimensional real affine sets, hulls and relative interior; general affine incidence structures are outside this reading.

### Further reading

Reading: [Igor Pak — Lectures on Discrete and Polyhedral Geometry](https://www.math.ucla.edu/~pak/geompol8.pdf)

Locator: §1.1, Theorem 1.4 (Radon) and the affine-dependence equations; printed/PDF pp. 12–13.

Knowledge: For any m ≥ d + 2 indexed points in Rᵈ, Radon’s theorem gives two disjoint nonempty groups of indices whose convex hulls intersect. The points need not be in general position. An affine dependence is a nonzero coefficient vector with coefficient sum zero and weighted point sum zero; the d + 2 threshold reflects the extra coefficient-sum equation alongside the d coordinate equations. Invertible affine maps preserve convex combinations and the resulting hull-intersection statement.

Scope: Finite real point configurations, affine dependence and Radon intersections; no generalization to arbitrary fields or the multiparty Tverberg theorem is included.

## convex-geometry

**凸几何专家 / Convex Geometry Expert** (D024)

Reading: [Stephen Boyd and Lieven Vandenberghe — Convex Optimization](https://web.stanford.edu/~boyd/cvxbook/bv_cvxbook.pdf)

Locator: §2.1.4, printed p. 23 / PDF p. 37; §2.5.1, separating hyperplane statement, printed p. 46 / PDF p. 60.

Knowledge: Convexity requires the segment between any two points of a set to stay in the set. In Rⁿ, two nonempty disjoint convex sets admit a nonzero affine functional that is nonpositive on one and nonnegative on the other. This is a weak separation statement: strict inequalities and a positive gap require additional assumptions.

Scope: Finite-dimensional convexity and the stated separation theorem; the inspected passage states the general theorem and develops only a special case of its proof.

### Further reading

Reading: [Stephen Boyd and Lieven Vandenberghe — Convex Optimization](https://web.stanford.edu/~boyd/cvxbook/bv_cvxbook.pdf)

Locator: §2.6.1, definition (2.19), Example 2.24 and the dual-cone properties; printed pp. 51–53 / PDF pp. 65–67. The general bipolar properties are stated here with verification assigned to Exercise 2.31.

Knowledge: With the source’s nonnegative-pairing convention, the dual of a cone K ⊂ Rⁿ is K* = {y : ⟨x,y⟩ ≥ 0 for every x ∈ K}. It is closed and convex, and taking duals reverses inclusions. The bidual K** is the closure of the convex hull of K, so K** = K when K is closed and convex. For real symmetric matrices with trace pairing, the positive semidefinite cone is self-dual. The chosen pairing and the closure/convexity conditions determine these identities.

Scope: Finite-dimensional dual cones and the stated bipolar identity, plus the proved real positive-semidefinite example; infinite-dimensional dual topologies and general conic optimization duality are separate topics.

## discrete-geometry

**离散几何专家 / Discrete Geometry Expert** (D025)

Reading: [Igor Pak — Lectures on Discrete and Polyhedral Geometry](https://www.math.ucla.edu/~pak/geompol8.pdf)

Locator: §2.1, Theorem 2.1 (Carathéodory), and §2.2, Theorem 2.3 (Sylvester–Gallai); printed/PDF p. 20.

Knowledge: A point in the convex hull of a finite subset of Rᵈ belongs to the convex hull of at most d + 1 of its points. For a finite noncollinear point set in the real plane, the Sylvester–Gallai theorem guarantees a line containing exactly two of its points. These statements concern finite point configurations and retain their dimension and ground-field assumptions.

Scope: Convex hulls and real planar point-line configurations; no comprehensive coverage of rigidity, packings or triangulation theory.

### Further reading

Reading: [Igor Pak — Lectures on Discrete and Polyhedral Geometry](https://www.math.ucla.edu/~pak/geompol8.pdf)

Locator: §26.4, Theorem 26.6 and the explanation of face isometries and convexity; printed/PDF p. 252.

Knowledge: Cauchy’s rigidity theorem states that two combinatorially equivalent convex polytopes in R³ are congruent when corresponding polygonal faces are isometric in a way that respects the chosen combinatorial equivalence. Thus the face shapes together with their incidence determine the convex polytope up to a Euclidean rigid motion. Facewise isometry includes the polygonal geometry, beyond matching a list of edge lengths for untriangulated faces. Convexity is a substantive condition; the accompanying discussion points to nonconvex failures of this local-to-global conclusion.

Scope: Global rigidity of convex three-dimensional polytopes from compatible face isometries; generic bar-framework rigidity, nonconvex polyhedra and packing theory remain separate topics.

## differential-geometry

**微分几何专家 / Differential Geometry Expert** (D026)

Reading: [Ben Andrews — Lectures on Differential Geometry, Lecture 4: Tangent Vectors](https://maths-people.anu.edu.au/~andrews/DG/DG_chap4.pdf)

Locator: §4.1; printed pp. 23–24, PDF pp. 1–2.

Knowledge: Tangent vectors on an abstract smooth manifold can be described through charts, first-order agreement of curves, or derivations on smooth functions. Chart representations transform by the derivative of the coordinate transition. For a submanifold locally given as a regular level set, the tangent space is the kernel of the defining map's derivative.

Scope: Tangent-space foundations and coordinate changes; connections and curvature are not developed in the inspected pages.

### Further reading

Reading: [Ben Andrews — Lectures on Differential Geometry, Lecture 8: Connections](https://maths-people.anu.edu.au/~andrews/DG/DG_chap8.pdf)

Locator: §8.2, Definition 8.2.1, printed p. 72 / PDF p. 2; §8.5, Propositions 8.5.2–8.5.3 and the following discussion, printed pp. 75–76 / PDF pp. 5–6.

Knowledge: A smooth connection differentiates vector fields consistently with the Leibniz rule. Along a piecewise smooth curve it determines a unique family of linear isomorphisms between tangent spaces, characterized by parallel vector fields. Conversely, covariant differentiation along that curve is recovered by transporting vectors to the initial tangent space and differentiating there. Parallel transport depends on the curve, so a connection does not supply a canonical identification of every tangent space with every other one.

Scope: Covariant differentiation and existence, uniqueness and path dependence of parallel transport; curvature and holonomy classification require further results.

## riemannian-geometry

**黎曼几何专家 / Riemannian Geometry Expert** (D027)

Reading: [Ben Andrews — Lectures on Differential Geometry, Lecture 9: Riemannian Metrics](https://maths-people.anu.edu.au/~andrews/DG/DG_chap9.pdf)

Locator: §§9.1–9.4, Definition 9.1.1, Definition 9.3.1 and Proposition 9.3.2; printed pp. 87–89, PDF pp. 1–3.

Knowledge: A Riemannian metric assigns a smoothly varying positive definite inner product to each tangent space. Integrating tangent-vector lengths defines curve length; taking the infimum over connecting curves gives a distance on each connected component, with the manifold topology. An immersion into a Riemannian manifold induces a metric by pulling back the ambient inner products.

Scope: Metrics, induced metrics, length and distance; completeness, curvature and comparison theorems require further reading.

### Further reading

Reading: [Ben Andrews — Lectures on Differential Geometry, Lecture 10: The Levi-Civita Connection](https://maths-people.anu.edu.au/~andrews/DG/DG_chap10.pdf)

Locator: §10.1, printed p. 95 / PDF p. 1; §10.3, Proposition 10.3.1, printed p. 96 / PDF p. 2.

Reading: [Ben Andrews — Lectures on Differential Geometry, Lecture 11: Geodesics and Completeness](https://maths-people.anu.edu.au/~andrews/DG/DG_chap11.pdf)

Locator: §11.5, Theorem 11.5.1 (Hopf–Rinow), printed p. 106 / PDF p. 6.

Knowledge: A smooth Riemannian metric has a unique torsion-free connection compatible with it, the Levi-Civita connection. Compatibility makes parallel transport preserve inner products. For a connected Riemannian manifold, metric completeness is equivalent to extending every geodesic indefinitely and also to the exponential map at one point being defined on the entire tangent space. These equivalent conditions imply that any two points are joined by a distance-minimizing geodesic.

Scope: Levi-Civita uniqueness and the stated Hopf–Rinow equivalences; no curvature comparison or assertion that every geodesic segment is globally minimizing.

## symplectic-geometry

**辛几何专家 / Symplectic Geometry Expert** (D028)

Reading: [Ana Cannas da Silva — Lectures on Symplectic Geometry](https://people.math.ethz.ch/~acannas/Papers/lsg.pdf)

Locator: Introduction, printed p. 1 / PDF p. 9; §1.4, Definition 1.7 and the stated Darboux theorem, printed p. 7 / PDF p. 15.

Knowledge: A symplectic structure is a closed nondegenerate differential two-form. A symplectomorphism is a diffeomorphism that pulls the target form back to the source form. Darboux's theorem gives local coordinates in which the form is the standard sum of paired coordinate differentials, so equal-dimensional symplectic manifolds have the same local model.

Scope: Symplectic structures, symplectomorphisms and the local normal-form statement; no global classification or rigidity claim.

### Further reading

Reading: [Ana Cannas da Silva — Lectures on Symplectic Geometry](https://people.math.ethz.ch/~acannas/Papers/lsg.pdf)

Locator: §22.1, Definition 22.1, printed pp. 133–134 / PDF pp. 141–142; §23.1, Theorem 23.1, and §23.2, regular-value consequences, printed pp. 141–142 / PDF pp. 149–150.

Knowledge: A Hamiltonian action here has an equivariant moment map μ: M → 𝔤* with d⟨μ,X⟩ = ι_{X#}ω for every X ∈ 𝔤. If the acting Lie group G is compact and acts freely on μ⁻¹(0), the Marsden–Weinstein–Meyer theorem makes μ⁻¹(0)/G a smooth manifold, with projection a principal G-bundle. The restricted symplectic form descends to a symplectic form ωred characterized by π*ωred = i*ω. Freeness implies that zero is a regular value; when the level is nonempty, the reduced dimension is dim M − 2 dim G.

Scope: Smooth zero-level reduction for compact Lie groups with a free action and an equivariant moment map; singular reduction, merely locally free actions and general nonzero levels require other results.

## complex-geometry

**复几何专家 / Complex Geometry Expert** (D029)

Reading: [Jean-Pierre Demailly — Complex Analytic and Differential Geometry](https://www-fourier.univ-grenoble-alpes.fr/~demailly/manuscripts/agbook.pdf)

Locator: Chapter VI, §4, Definition 4.1 and Examples 4.4–4.6; printed/PDF pp. 296–297.

Knowledge: A Hermitian metric on a complex manifold determines a positive real differential form of type (1,1). It is Kähler precisely when this associated form is closed. Complex projective space carries the Fubini–Study Kähler metric, and a complex submanifold inherits a Kähler metric by restriction.

Scope: Hermitian and Kähler geometry and these standard examples; no general Hodge decomposition or vanishing theorem is supplied by these pages.

### Further reading

Reading: [Jean-Pierre Demailly — Complex Analytic and Differential Geometry](https://www-fourier.univ-grenoble-alpes.fr/~demailly/manuscripts/agbook.pdf)

Locator: Chapter VI, §8.2, Theorem 8.5 and Lemma 8.6, printed/PDF p. 311; Corollary 8.7 and Proposition 8.9, printed/PDF p. 312.

Knowledge: On a compact Kähler manifold, the identity Δ = 2Δ∂̄ gives a decomposition of complex de Rham cohomology into Dolbeault groups of bidegrees whose sum is the total degree. Complex conjugation exchanges the bidegrees, giving equality of the corresponding Hodge numbers. For a d-closed form of pure bidegree, the ∂∂̄ lemma equates d-exactness, ∂-exactness, ∂̄-exactness and ∂∂̄-exactness. The resulting cohomological decomposition is independent of the chosen Kähler metric, and holomorphic forms on the compact Kähler manifold are d-closed.

Scope: Compact Kähler Hodge decomposition and the stated ∂∂̄ lemma; these conclusions are not asserted for arbitrary compact complex or noncompact Kähler manifolds.

## algebraic-geometry

**代数几何专家 / Algebraic Geometry Expert** (D030)

Reading: [The Stacks Project Authors — Schemes](https://stacks.math.columbia.edu/download/schemes.pdf)

Locator: §5 (tag 01HR), printed/PDF p. 6; §9, Definition 9.1 (tag 01IJ), printed/PDF p. 16.

Knowledge: An affine scheme combines the prime spectrum of a commutative ring with its structure sheaf. The standard open sets D(f) form a basis, and their intersections satisfy D(f) ∩ D(g) = D(fg). A scheme is a locally ringed space locally isomorphic to affine schemes, and scheme morphisms are morphisms of locally ringed spaces.

Scope: The affine-scheme setting and the definition of schemes; properness, smoothness, divisors and intersection theory are outside the inspected sections.

### Further reading

Reading: [The Stacks Project Authors — Schemes](https://stacks.math.columbia.edu/download/schemes.pdf)

Locator: §5, the localized-module construction, printed/PDF p. 7; §7, Lemmas 7.1, 7.4–7.6 (tags 01I7, 01IA–01IC), printed/PDF pp. 11 and 13–14.

Knowledge: For X = Spec(R), an R-module M defines a quasi-coherent sheaf M̃ whose sections on D(f) are M localized at f. The construction M ↦ M̃ and global sections F ↦ Γ(X,F) are quasi-inverse equivalences between R-modules and quasi-coherent OX-modules. In particular, a quasi-coherent sheaf on an affine scheme is determined by its global module of sections, and kernels and cokernels correspond to their module counterparts. The affine hypothesis and quasi-coherence specify the scope of this correspondence.

Scope: Modules and quasi-coherent sheaves on affine schemes over commutative rings; global-sections equivalence for arbitrary schemes, coherent finiteness properties and higher cohomology are outside these passages.
