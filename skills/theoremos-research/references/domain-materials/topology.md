# Topology: collected reading

Read the relevant section for subject knowledge. These original summaries identify the setting and limits of the cited passages. PDF pages start at the first page of the downloaded file; printed page numbers may differ. Third-party full texts remain outside the Skill, under their own reuse terms.

## general-topology

**一般拓扑专家 / General Topology Expert** (D031)

Reading: [Sidney A. Morris — Topology Without Tears](https://www.topologywithouttears.net/topbook.pdf)

Locator: §1.1, Definitions 1.1.1; printed/PDF p. 25.

Knowledge: A topology on a nonempty set contains the whole set and the empty set and is closed under arbitrary unions and finite intersections. Its members are the open sets, so openness is relative to a chosen topology. The union condition permits infinitely many sets, whereas the intersection condition imposes only finite closure.

Scope: The axioms of a topological space; compactness, separation axioms and metrization need additional passages.

### Further reading

Reading: [Sidney A. Morris — Topology Without Tears](https://www.topologywithouttears.net/topbook.pdf)

Locator: §10.3, Definitions 10.3.27, printed/PDF p. 281; Theorem 10.3.31 and Corollary 10.3.32, printed/PDF p. 285.

Knowledge: Urysohn's metrization theorem makes a regular, second countable Hausdorff space metrizable. The source treats regularity separately from Hausdorffness, so both conditions appear in this statement. For a compact space, metrizability is equivalent to being Hausdorff and second countable. Compactness alone therefore does not supply a compatible metric.

Scope: The stated metrization criterion and its compact-space characterization; no general metrization criterion without second countability is supplied.

## algebraic-topology

**代数拓扑专家 / Algebraic Topology Expert** (D032)

Reading: [Allen Hatcher — Algebraic Topology](https://pi.math.cornell.edu/~hatcher/AT/AT.pdf)

Locator: §1.1, “Paths and Homotopy,” Propositions 1.2–1.3; printed pp. 25–26, PDF pp. 34–35.

Knowledge: The fundamental group at a basepoint consists of loops modulo homotopies that fix their endpoints. Concatenation induces its group multiplication because it respects these homotopy classes. The basepoint is part of the construction, and the endpoint condition is part of the equivalence relation.

Scope: Paths, homotopies and the fundamental-group definition; covering-space classification and homology are outside these pages.

### Further reading

Reading: [Allen Hatcher — Algebraic Topology](https://pi.math.cornell.edu/~hatcher/AT/AT.pdf)

Locator: §1.3, Theorem 1.38 and the following discussion of universal covers; printed pp. 67–68 / PDF pp. 76–77.

Knowledge: For a path-connected, locally path-connected, semilocally simply-connected space X with basepoint x, path-connected based covering spaces over X are classified, up to basepoint-preserving covering isomorphism, by subgroups of π₁(X,x). The assigned subgroup is the image of the covering space’s fundamental group. Forgetting the lifted basepoint changes the classification to conjugacy classes of subgroups. The trivial subgroup gives a simply-connected universal cover, unique up to covering isomorphism. These classifications retain all three hypotheses on X.

Scope: Classical covering-space classification and universal covers under the stated connectivity hypotheses; spaces lacking semilocal simple connectivity and generalized covering theories need separate treatment.

## geometric-topology

**几何拓扑专家 / Geometric Topology Expert** (D033)

Reading: [Allen Hatcher — Notes on Basic 3-Manifold Topology](https://pi.math.cornell.edu/~hatcher/3M/3M.pdf)

Locator: Chapter 1, §1, standing assumptions and Theorem 1.1 (Alexander's theorem); printed p. 1, PDF p. 2.

Knowledge: In the smooth category used in these notes, an embedded two-sphere in R³ bounds an embedded three-ball. A prime three-manifold admits only the trivial connected-sum decomposition with the three-sphere. The chapter's general three-manifolds are connected, orientable and compact, possibly with boundary; these are substantive hypotheses.

Scope: Smooth sphere embeddings and the prime-decomposition setting in dimension three; the statement does not extend here to arbitrary wild topological embeddings or higher dimensions.

### Further reading

Reading: [Allen Hatcher — Notes on Basic 3-Manifold Topology](https://pi.math.cornell.edu/~hatcher/3M/3M.pdf)

Locator: Chapter 3, §1, Theorem 3.1 (Loop Theorem), printed p. 45 / PDF p. 46; Corollaries 3.2–3.3, printed p. 48 / PDF p. 49.

Knowledge: For a three-manifold with boundary, the Loop Theorem turns the existence of a disk map whose boundary is nontrivial in the boundary surface into the existence of an embedded disk with that property. This theorem explicitly allows noncompact and nonorientable manifolds. Dehn’s lemma states that an embedded circle in the boundary which is nullhomotopic in the manifold bounds an embedded disk. For a two-sided embedded surface, failure of injectivity of π₁(S) → π₁(M) similarly gives a disk meeting S precisely in its essential boundary circle.

Scope: The smooth/PL three-manifold setting of the notes, boundary disk embeddings and two-sided surface compression; the Loop Theorem does not specify the same boundary loop as the initial arbitrary disk map, and no higher-dimensional analogue is asserted.

## differential-topology

**微分拓扑专家 / Differential Topology Expert** (D034)

Reading: [Ben Andrews — Lectures on Differential Geometry, Lecture 3: Submanifolds](https://maths-people.anu.edu.au/~andrews/DG/DG_chap3.pdf)

Locator: Definition 3.1.1 and Proposition 3.2.1; printed pp. 17–19, PDF pp. 1–3; Definition 3.3.1, printed p. 21 / PDF p. 5.

Knowledge: An embedded smooth submanifold requires both the subspace-topology condition and injectivity of the parametrization's derivative. Equivalent local descriptions include smooth graphs and zero sets of submersions. Orientability means an atlas can be chosen with positive Jacobian determinant on every coordinate overlap.

Scope: Embedded submanifolds, local regular-level-set descriptions and orientability; Sard's theorem, transversality and cobordism require other readings.

### Further reading

Reading: [Tomasz Mrowka — MIT 18.965 Geometry of Manifolds, Lectures 10 and 11: Sard's Theorem](https://ocw.mit.edu/courses/18-965-geometry-of-manifolds-fall-2004/lecture10_11.pdf)

Locator: §12, Theorem 12.3; printed p. 23 / PDF p. 2.

Reading: [Tomasz Mrowka — MIT 18.965 Geometry of Manifolds, Lecture 20: Parametric Transversality](https://ocw.mit.edu/courses/18-965-geometry-of-manifolds-fall-2004/lecture20.pdf)

Locator: §18, Lemma 18.2 and Theorem 18.3, printed p. 45 / PDF p. 2; the finite-dimensional argument continues on printed p. 46 / PDF p. 3.

Knowledge: A smooth map between finite-dimensional manifolds has a set of critical values of measure zero in target charts. If a smooth family F: P × M → N is a submersion and Z is a smooth submanifold of N, then for almost every parameter p the slice map is transverse to Z, with exceptional parameters measured in charts of P. A transverse inverse image is a smooth submanifold with the same codimension as Z. These are statements about the specified family and hypotheses, rather than about every slice of an arbitrary family.

Scope: Smooth finite-dimensional Sard and parametric transversality; finite differentiability thresholds, boundary variants and Banach/Fredholm extensions are outside this addition.

## homotopy-theory

**同伦论专家 / Homotopy Theory Expert** (D035)

Reading: [Allen Hatcher — Algebraic Topology](https://pi.math.cornell.edu/~hatcher/AT/AT.pdf)

Locator: Chapter 0, “Homotopy and Homotopy Type”; printed p. 3, PDF p. 12.

Knowledge: A homotopy is a jointly continuous family of maps parametrized by the unit interval. A homotopy equivalence has an inverse up to homotopy in both directions, giving a symmetric equivalence relation on spaces. A deformation retraction fixes the retained subspace throughout the homotopy, a stronger requirement than merely having a retraction.

Scope: Homotopy, homotopy equivalence and deformation retraction; higher homotopy groups and obstruction theory are not developed in this passage.

### Further reading

Reading: [Allen Hatcher — Algebraic Topology](https://pi.math.cornell.edu/~hatcher/AT/AT.pdf)

Locator: §4.2, Theorem 4.41 and the paragraph defining Serre fibrations; printed p. 376 / PDF p. 385.

Knowledge: A map with the homotopy lifting property for every disk is a Serre fibration. With chosen basepoints in a fiber F and its image, its relative homotopy sets or groups πₙ(E,F) identify with πₙ(B) for n ≥ 1. If B is path connected, the fiber, total space and base fit into the long exact sequence … → πₙ(F) → πₙ(E) → πₙ(B) → πₙ₋₁(F) → … . The low-degree tail includes pointed sets of components, so it is not uniformly a sequence of abelian groups.

Scope: The lifting hypothesis and homotopy exact sequence; no spectral-sequence computation or obstruction-theory classification is included.

## cohomology-theory

**上同调理论专家 / Cohomology Theory Expert** (D036)

Reading: [Allen Hatcher — Algebraic Topology](https://pi.math.cornell.edu/~hatcher/AT/AT.pdf)

Locator: §3.2, cup-product definition and Lemma 3.6; printed pp. 206–207, PDF pp. 215–216.

Knowledge: Ring-valued singular cochains admit a cup product that adds degrees. The coboundary satisfies a signed product identity, which makes the product well defined on cohomology classes. The induced product is associative and distributive, and a unit in the coefficient ring gives a degree-zero unit in cohomology.

Scope: The singular-cohomology cup product and its basic algebraic structure; no general cohomology operations or spectral sequences are covered.

### Further reading

Reading: [Allen Hatcher — Algebraic Topology](https://pi.math.cornell.edu/~hatcher/AT/AT.pdf)

Locator: §3.1, Theorem 3.2, printed p. 195 / PDF p. 204; naturality and the nonnatural splitting, printed p. 196 / PDF p. 205.

Knowledge: For a chain complex C of free abelian groups and an abelian coefficient group G, the universal coefficient theorem gives a split exact sequence 0 → Ext(Hₙ₋₁(C),G) → Hⁿ(C;G) → Hom(Hₙ(C),G) → 0. The sequence is natural under chain maps, but its splitting is not natural. Thus the previous degree's torsion can contribute to cohomology, and the Hom term alone does not determine the result in general.

Scope: Cohomology of free abelian chain complexes and arbitrary abelian coefficients; a general-ring replacement needs additional algebraic hypotheses.

## fiber-bundles

**纤维丛与特征类专家 / Fiber Bundles and Characteristic Classes Expert** (D037)

Reading: [Allen Hatcher — Vector Bundles & K-Theory](https://pi.math.cornell.edu/~hatcher/VBKT/VB.pdf)

Locator: §1.1, vector-bundle definition and examples; printed p. 6, PDF p. 10.

Knowledge: A real vector bundle is locally a product with Rⁿ through trivializations that are linear on every fiber. This local product requirement does not imply that the whole bundle is a global product, as the Möbius line bundle illustrates. Replacing R by C gives complex vector bundles with complex-linear fiber identifications.

Scope: Vector-bundle definitions, local triviality and basic examples; characteristic-class constructions and general fiber-bundle classification are outside this reading.

### Further reading

Reading: [Allen Hatcher — Vector Bundles & K-Theory](https://pi.math.cornell.edu/~hatcher/VBKT/VB.pdf)

Locator: §3.1, standing paracompact-base assumption and Theorems 3.1–3.2; printed pp. 77–78 / PDF pp. 81–82.

Knowledge: Over the paracompact bases used here, real vector bundles have Stiefel–Whitney classes wᵢ in mod-two cohomological degree i, while complex bundles have integral Chern classes cᵢ in degree 2i. Their total classes are natural under pullback and multiply under direct sum by the Whitney sum formula. Vanishing above the bundle rank and normalization on the canonical line bundle complete the stated unique characterization. These classes retain isomorphism-invariant information about a bundle, without constituting a general classification of all bundles.

Scope: Characteristic-class axioms, coefficients, normalization and sum behavior; no claim that vanishing characteristic classes forces triviality.

## knot-theory

**纽结理论专家 / Knot Theory Expert** (D038)

Reading: [Allen Hatcher — Algebraic Topology](https://pi.math.cornell.edu/~hatcher/AT/AT.pdf)

Locator: §1.2, Example 1.24 (“Torus Knots”), first page; printed p. 47, PDF p. 56.

Knowledge: For relatively prime positive integers m and n, the map z ↦ (zᵐ, zⁿ) embeds the circle in the standard torus in R³. Without coprimality, that parametrization is not injective, so the parameters alone do not define the same kind of embedding. The complement of the resulting knot has a fundamental group, and adjoining the point at infinity leaves that group unchanged in this setting.

Scope: Torus-knot parametrization and the complement-group setting; this excerpt does not cover diagram invariants or general knot classification.

### Further reading

Reading: [Louis H. Kauffman — Knots and State Summations, on the author's UIC page](https://homepages.math.uic.edu/~kauffman/)

Locator: “Knots and State Summations,” from the definition of a smoothing state through the displayed writhe-normalization formula for f[K].

Knowledge: A smoothing state of a link diagram assigns one of two smoothings at every crossing; its bracket contribution combines crossing weights and a factor for the resulting circles. With B = A⁻¹ and d = −A² − A⁻², this bracket is unchanged by Reidemeister II and III moves, while a type I move contributes a factor −A³ or −A⁻³. For an oriented diagram, multiplying by (−A³)⁻ʷ, where w is the signed crossing sum, cancels the type I change and gives an ambient-isotopy invariant. In this page's state-sum convention the single-circle value is d, so an unknot value of one requires an additional normalization.

Scope: The bracket and writhe correction in the author's displayed convention; the unscaled state sum is not identified with a Jones polynomial normalized to one on the unknot, and no complete knot-classification claim is made.

## low-dimensional-topology

**低维拓扑专家 / Low-dimensional Topology Expert** (D039)

Reading: [Allen Hatcher — Notes on Basic 3-Manifold Topology](https://pi.math.cornell.edu/~hatcher/3M/3M.pdf)

Locator: Chapter 1, standing assumptions on printed p. 1 / PDF p. 2; §2, “Existence of Torus Decompositions,” printed p. 10 / PDF p. 11.

Knowledge: A two-sided embedded surface has trivial normal interval bundle. For a two-sided surface without sphere or disk components, incompressibility means each compressing-disk boundary already bounds a disk in the surface. The notes introduce torus decomposition for irreducible compact orientable three-manifolds, retaining the chapter's smooth-category assumptions.

Scope: Incompressible surfaces and the three-manifold torus-decomposition setting; no full uniqueness theorem, geometrization theorem or four-manifold classification is summarized here.

### Further reading

Reading: [Allen Hatcher — Notes on Basic 3-Manifold Topology](https://pi.math.cornell.edu/~hatcher/3M/3M.pdf)

Locator: Chapter 1, Theorem 1.5, printed p. 5 / PDF p. 6; Theorem 1.9 and its minimality qualification, printed p. 14 / PDF p. 15; the smooth-category standing assumptions remain on printed p. 1 / PDF p. 2.

Knowledge: A compact connected orientable smooth three-manifold has a finite prime connected-sum decomposition, unique up to order and insertion or deletion of trivial three-sphere factors. For a compact irreducible orientable three-manifold, a disjoint collection of incompressible tori cuts it into pieces that are atoroidal or Seifert fibered. An inclusion-minimal such torus collection is unique up to isotopy, a stronger conclusion than uniqueness up to a homeomorphism of the ambient manifold. The irreducibility and minimality hypotheses belong to this second result.

Scope: Prime and torus decomposition theorems in the stated smooth orientable setting; atoroidality is not here replaced by a claim of hyperbolicity or a full geometrization theorem.

## topological-groups

**拓扑群专家 / Topological Groups Expert** (D040)

Reading: [Sidney A. Morris — Topology Without Tears](https://www.topologywithouttears.net/topbook.pdf)

Locator: Appendix 5, Definition A5.1.1 and Examples A5.1.2, printed/PDF pp. 513–514; Proposition A5.1.9 and Remark A5.1.10, printed/PDF p. 517.

Knowledge: A topological group has jointly continuous multiplication and continuous inversion. In this source, Hausdorffness is an additional property, and for topological groups the T₁ condition already implies Hausdorffness. This convention matters because other authors include Hausdorffness in the definition itself.

Scope: Topological-group axioms and this separation-property distinction; Haar measure, duality and Lie-group structure theory are not developed in these passages.

### Further reading

Reading: [Sidney A. Morris — Topology Without Tears](https://www.topologywithouttears.net/topbook.pdf)

Locator: Appendix 5, §A5.2, Propositions A5.2.16, A5.2.18 and A5.2.22; printed/PDF pp. 524–526.

Knowledge: If N is a normal subgroup of a topological group G, the quotient topology makes G/N a topological group and the canonical projection is continuous and open. The quotient is Hausdorff exactly when N is closed, and discrete exactly when N is open; Hausdorffness remains a separate property in this author’s group convention. A compact normal subgroup additionally makes the projection a closed map. Thus openness of this group quotient and closedness of the projection have different hypotheses.

Scope: Normal-subgroup quotients, their separation criteria and compact-kernel closedness; Haar measure, duality and Lie-group structure theory remain outside this addition.
