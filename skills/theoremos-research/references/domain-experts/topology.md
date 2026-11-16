Read only the selected expert profile when its topological knowledge is relevant to the current assignment.

## general-topology

**一般拓扑 / General Topology Expert** (D031)

Expertise: Specialist in topological spaces, continuity, convergence, compactness, connectedness, separation axioms and the topologies carried by products, subspaces and quotients.

Knowledge: Open sets and neighborhood systems determine continuity, while nets and filters describe convergence in arbitrary spaces. Compactness is defined by finite subcovers and is preserved by continuous images. Compact subsets of Hausdorff spaces are closed, and continuous bijections from compact spaces to Hausdorff spaces are homeomorphisms. Product and quotient topologies have distinct universal properties. Connectedness concerns separation by open sets, whereas path connectedness involves continuous paths and is stronger in general.

Distinctions: Sequential compactness and compactness are not equivalent for arbitrary spaces. Sequences may fail to determine topology outside suitable countability or sequentiality conditions. A surjective continuous map need not be a quotient map, and a continuous bijection need not have continuous inverse.

Connections: Analysis uses continuity and compactness in function spaces; geometry adds local manifold structure. Order theory describes filters and specialization, while category theory clarifies the universal properties of topological constructions.

Example: The map f:[0,2π)→S¹ given by f(t)=e^{it} is continuous and bijective, using the subspace topology from R on its domain. Set tₙ=2π−1/n. Then f(tₙ)→1=f(0) in the circle, but tₙ does not converge to 0 in [0,2π). For example, the neighborhood [0,1) of 0 contains none of these parameters. Hence f⁻¹ is not continuous at 1. The domain is bounded but not compact, and the circle is Hausdorff. This explicitly exhibits the missing compactness in the compact-to-Hausdorff homeomorphism criterion, while also separating boundedness from compactness even in an elementary subspace of R.

Reading: [Collected domain materials](../domain-materials/topology.md#general-topology).

## algebraic-topology

**代数拓扑 / Algebraic Topology Expert** (D032)

Expertise: Specialist in fundamental groups, covering spaces, homology, induced maps and exact sequences as algebraic invariants of spaces and continuous maps.

Knowledge: Fundamental groups consist of based loops modulo based homotopy; paths between basepoints induce identifications up to appropriate conjugation. Singular homology is functorial and homotopy invariant, with exact sequences relating spaces, subspaces and decompositions. Van Kampen describes a fundamental-group pushout for suitable path-connected open covers and intersections. For connected, locally path-connected and semilocally simply connected spaces, connected coverings are classified by conjugacy classes of subgroups of the fundamental group.

Distinctions: Abstractly isomorphic invariant groups do not identify the map induced by a particular continuous function. Reduced and unreduced homology treat degree zero differently. Coefficients affect torsion information, while basepoint choices affect fundamental-group maps even when the underlying spaces agree.

Connections: Group theory studies monodromy and presentations; homological algebra explains complexes and exactness. Geometric topology supplies spaces and decompositions, while homotopy theory and cohomology retain structures beyond individual homology groups.

Example: For an integer n≥2, the map pₙ:S¹→S¹, z↦zⁿ, is an n-sheeted covering. On a sufficiently short open arc, its n inverse branches lie on disjoint arcs, giving the local covering condition. Both domain and target have fundamental group Z, but composing the generating loop e^{2πit} with pₙ gives e^{2πint}. Thus the induced homomorphism is k↦nk, with image nZ and index n. It is injective but not surjective. The spaces themselves are homeomorphic circles, yet this particular continuous map is not a homotopy equivalence. The subgroup retains information about the covering that the abstract isomorphism type Z alone omits.

Reading: [Collected domain materials](../domain-materials/topology.md#algebraic-topology).

## geometric-topology

**几何拓扑 / Geometric Topology Expert** (D033)

Expertise: Specialist in the geometric structure of manifolds, embeddings, neighborhoods, decompositions, triangulated spaces and the differences between topological, piecewise linear and smooth categories.

Knowledge: Embeddings identify spaces with subspaces carrying the induced topology; compactness of the source and a Hausdorff target make a continuous injection an embedding. Local manifold neighborhoods model Euclidean spaces or half-spaces. Collars describe suitable manifold boundaries, while handles and gluing data encode more global structure. In a combinatorial triangulation, links record local piecewise linear manifold structure. Triangulation and smoothing results depend strongly on dimension and category; they are not automatic for all topological manifolds.

Distinctions: An immersion, a continuous injection and a topological embedding impose different conditions. Homeomorphism, piecewise linear equivalence and diffeomorphism do not define the same classification problem. Local charts alone do not determine global topology or guarantee compatibility of an arbitrary gluing.

Connections: Differential topology supplies smooth embeddings and handles, algebraic topology records global invariants, and combinatorics describes finite complexes. Low-dimensional topology contains dimension-specific classification and decomposition phenomena.

Example: In the solid torus M=D²×S¹, the boundary is T². Its meridian μ(t)=(e^{2πit},1) is not nullhomotopic in the boundary, but it bounds the embedded disk D²×{1} inside M. The longitude λ(t)=(1,e^{2πit}) remains nontrivial in M: projection onto the second factor sends it to a circle loop of winding one. Since M deformation retracts onto {0}×S¹, the boundary inclusion induces Z²→Z, (a,b)↦b, when coordinates are meridian and longitude. Its kernel is generated by the meridian. This concrete compression disk distinguishes intrinsic essentiality of a curve on a surface from incompressibility of that surface in an ambient three-manifold.

Reading: [Collected domain materials](../domain-materials/topology.md#geometric-topology).

## differential-topology

**微分拓扑 / Differential Topology Expert** (D034)

Expertise: Specialist in smooth maps and manifold structure, including regular values, transversality, immersions, submersions, orientations and smooth cobordisms.

Knowledge: Constant-rank theorems describe local normal forms of smooth maps. A regular fiber of a smooth map between manifolds without boundary is a submanifold of the expected codimension, with tangent space the kernel of the differential. Transverse intersections similarly carry induced manifold structures. Sard's theorem gives measure-zero critical values for C^k maps when k exceeds the maximum of source dimension minus target dimension and zero. Proper injective immersions are embeddings.

Distinctions: Local rank conditions do not imply global injectivity or properness. A fiber can be a manifold without its value being regular. Boundaries require modified transversality conditions, and orientations contain compatibility data beyond an unoriented smooth structure.

Connections: Differential geometry adds metrics and connections, singularity theory studies failures of regularity, and algebraic topology supplies degree and characteristic classes. Cobordism connects manifold geometry with homotopy-theoretic classification.

Example: For f:R→R, f(x)=x², the value 0 is critical because df₀=0, although f⁻¹(0)={0} is a smooth zero-dimensional submanifold. Every positive a is regular, with fiber {−√a,√a}; negative values have empty fibers and are regular vacuously. Now consider F(a,x)=x²−a on R². Its derivative in the a-direction is −1, so F is a submersion everywhere. The slices x↦F(a,x) are nevertheless transverse to {0} only when a≠0. The sole exceptional parameter is a=0, a measure-zero set. This separates smoothness of a fiber, regularity of its defining value, and transversality of individual slices within a regular family.

Reading: [Collected domain materials](../domain-materials/topology.md#differential-topology).

## homotopy-theory

**同伦论 / Homotopy Theory Expert** (D035)

Expertise: Specialist in homotopies, homotopy groups, weak equivalences, fibrations, cofibrations and the structural information preserved by homotopy equivalence.

Knowledge: A homotopy is a continuous family of maps; relative and pointed variants retain specified subspaces or basepoints. Fibrations encode homotopy lifting, whereas cofibrations encode homotopy extension. Serre and Hurewicz fibrations impose lifting properties for different classes of parameter spaces. Weak homotopy equivalences induce bijections on path components and isomorphisms on all based homotopy groups. Whitehead's theorem identifies weak equivalences between CW complexes as homotopy equivalences. Cellular structures and obstruction groups organize extension phenomena.

Distinctions: Homotopic maps need not be equal, and weak equivalence is not an unrestricted synonym for homotopy equivalence. A pointed homotopy retains information discarded by an unpointed one. Homology equivalence can be weaker than equivalence of homotopy groups.

Connections: Algebraic topology supplies homotopy invariants, fiber bundles give important fibrations, and higher category theory organizes equivalences and coherence. Spectra describe stabilization phenomena beyond the homotopy theory of individual spaces.

Example: The closed disk D² contracts to its center through H(x,t)=(1−t)x, which fixes the center throughout. It cannot retract onto its boundary circle. Indeed, a retraction r:D²→S¹ with boundary inclusion i would satisfy r∘i=id. Applying the fundamental group at a boundary basepoint would make the identity on π₁(S¹)=Z factor through π₁(D²)=0, which is impossible. The radial contraction does not fix the boundary: for t>0 it moves each boundary point into the interior. Thus contractibility and a strong deformation retraction onto one chosen point coexist with an obstruction to any retraction onto another specified subspace, emphasizing the data retained by relative homotopy.

Reading: [Collected domain materials](../domain-materials/topology.md#homotopy-theory).

## cohomology-theory

**上同调理论 / Cohomology Theory Expert** (D036)

Expertise: Specialist in cohomology groups and operations, cochain complexes, products, exact sequences, coefficient dependence and duality for spaces and manifolds.

Knowledge: Cohomology classes are cocycles modulo coboundaries, and cochain maps induce maps on those quotients. Ordinary cohomology has homotopy, excision and exactness properties together with a dimension axiom. Cup products give a graded-commutative structure for ordinary cohomology with commutative coefficients. On a closed oriented n-manifold, Poincaré duality relates degree-k cohomology to degree-(n−k) homology with the appropriate coefficient orientation. Manifolds with boundary and noncompact manifolds involve relative or compactly supported variants.

Distinctions: A cochain identity is stronger than equality of cohomology classes. Coefficient changes can create or remove torsion information, and connecting maps shift degrees. Generalized cohomology theories need not satisfy the ordinary dimension axiom, while orientability depends on the chosen coefficient system.

Connections: Homological algebra explains derived functors and universal-coefficient phenomena. Differential forms realize de Rham cohomology, characteristic classes inhabit cohomology rings, and homotopy theory describes cohomology operations and generalized theories.

Example: Take the free chain complex C₂=Z, C₁=Z, C₀=Z with d₂ multiplication by 2, d₁=0 and all other groups zero. Then H₁=Z/2 and H₂=0. Dualizing into Z gives the cochain differential δ¹ multiplication by 2, so H¹=0 but H²=Z/2. In particular, H² is nonzero although Hom(H₂,Z)=0: the previous-degree torsion contributes an Ext term. With Z/2 coefficients the multiplication-by-2 differential vanishes, and both H¹ and H² become Z/2. This small complex explicitly separates homology, integral cohomology and a change of coefficients without treating torsion as invisible scalar data.

Reading: [Collected domain materials](../domain-materials/topology.md#cohomology-theory).

## fiber-bundles

**纤维丛与特征类 / Fiber Bundles and Characteristic Classes Expert** (D037)

Expertise: Specialist in fiber bundles, vector and principal bundles, local trivializations, sections, transition functions, pullbacks and characteristic classes.

Knowledge: Local trivializations identify a bundle with a product over each open set, and transition functions satisfy cocycle equations on triple overlaps. Vector bundles have linear transition maps; principal bundles carry a compatible free group action on each fiber. Numerable principal bundles admit classification through homotopy classes of maps to classifying spaces. Characteristic classes are natural under pullback: Chern classes concern complex bundles, Stiefel-Whitney classes real bundles with mod-two coefficients, and Pontryagin classes provide further real-bundle invariants.

Distinctions: Local triviality does not imply a global product decomposition. Topological, smooth and holomorphic triviality are different notions. Vanishing characteristic classes do not generally guarantee triviality, and individual nonvanishing sections encode less than an entire global frame.

Connections: Topology supplies obstruction and classification theory; cohomology stores characteristic classes. Differential geometry adds connections and curvature representatives, while representation theory associates vector bundles to principal bundles through linear group actions.

Example: Present the Möbius line bundle as ([0,1]×R)/((1,v)∼(0,−v)), over the circle obtained by identifying the endpoints. A continuous section is represented on the interval by a continuous function f satisfying f(1)=−f(0). If an endpoint value is zero, the section already vanishes; otherwise the opposite endpoint signs force an interior zero by the intermediate value theorem. Thus no section is everywhere nonzero. A nowhere-zero section of a real line bundle would be a global frame and would trivialize it, so this bundle is nontrivial. Nevertheless it has local product charts and a well-defined fiber metric v², preserved by the sign-changing transition.

Reading: [Collected domain materials](../domain-materials/topology.md#fiber-bundles).

## knot-theory

**纽结理论 / Knot Theory Expert** (D038)

Expertise: Specialist in knots and links as embedded circles in three-dimensional spaces, their diagrams, ambient isotopy, complements, framings and algebraic invariants.

Knowledge: For tame knots in the standard three-sphere or Euclidean three-space, regular diagrams encode overcrossing information, and Reidemeister moves describe ambient isotopy at the diagram level. Knot complements carry fundamental groups together with peripheral information. Alexander and Jones-type invariants distinguish some knot types but are not complete classifications. The Alexander polynomial has a unit ambiguity depending on normalization. A framing is additional normal-bundle data, and diagram writhe changes under a first Reidemeister move.

Distinctions: Knot orientation, ambient orientation, link-component ordering and framing are separate structures. Equal polynomial invariants do not imply isotopy. A group presentation without its geometric identification or peripheral structure retains less information than the full complement description, and wild embeddings fall outside ordinary tame-diagram theory.

Connections: Three-manifold topology studies complements and surgery, group theory describes presentations, and representation theory produces invariants from group actions. Contact and symplectic geometry distinguish more structured classes of knots.

Example: Use the bracket state sum [D]=ΣS[D|S]d^{|S|}, with d=−A²−A⁻², and the convention in which a positive curl increases writhe by one and multiplies the bracket by −A³. A crossing-free unknot U has one state and one circle, hence [U]=d and w(U)=0. Adding that curl gives [U₊]=−A³d and w(U₊)=1. The corrected expression (−A³)^{−w(D)}[D] is therefore d for both diagrams. Writhe correction removes this Reidemeister-I change; a separate normalization by d makes the unknot value one. This distinguishes diagram-dependent writhe, regular-isotopy bracket data, and the chosen normalization of an ambient-isotopy invariant.

Reading: [Collected domain materials](../domain-materials/topology.md#knot-theory).

## low-dimensional-topology

**低维拓扑 / Low-Dimensional Topology Expert** (D039)

Expertise: Specialist in surfaces and three- or four-dimensional manifolds, including decomposition, gluing, intersection forms, surgery descriptions and dimension-specific classification phenomena.

Knowledge: Compact connected surfaces are classified by orientability, genus and boundary data, with Euler characteristic recording only part of that information. Closed connected orientable three-manifolds admit prime decompositions. Irreducible compact orientable three-manifolds with empty or incompressible torus boundary admit JSJ decompositions along essential tori. Closed oriented four-manifolds have a unimodular intersection pairing on second homology modulo torsion. Four-dimensional topological and smooth classifications diverge substantially; the existence of a form or a topological manifold does not imply a compatible smooth realization with the same additional properties.

Distinctions: Attaching maps are part of a gluing, not determined by the pieces alone. Orientation, boundary parameterization and smooth structure can change the classification problem. Algebraic invariants may obstruct equivalence without completely determining a manifold.

Connections: Knot theory supplies surgery and complement descriptions, geometric topology studies handles and embeddings, and algebraic topology computes pairings and homology. Differential geometry and gauge theory constrain smooth four-dimensional structures.

Example: Use the lens-space convention L_{p/q} in which coprime integers p,q with q>0 give π₁(L_{p/q})≅Z/q. Both L_{1/5} and L_{2/5} therefore have fundamental group Z/5 and admit decompositions into two solid tori. They are not diffeomorphic: the unoriented lens-space classification requires p′≡±p^{±1} mod q. For p=1,q=5 the permitted residues are only 1 and 4, so p′=2 is excluded. The difference is carried by the attaching slope on the common boundary torus. Thus the abstract fundamental group and the list of pieces miss information retained by the gluing map, even within this explicitly classified family.

Reading: [Collected domain materials](../domain-materials/topology.md#low-dimensional-topology).

## topological-groups

**拓扑群 / Topological Groups Expert** (D040)

Expertise: Specialist in groups with continuous multiplication and inversion, continuous homomorphisms, subgroup and quotient topology, compactness and local compactness.

Knowledge: Translations in a topological group are homeomorphisms, and neighborhoods of the identity determine its topology. Quotients by normal subgroups inherit group structures and quotient topologies; closedness of the subgroup is essential for Hausdorffness of a quotient of a Hausdorff group. Locally compact Hausdorff groups admit left Haar measure, unique up to positive scale. The modular function records the discrepancy between left and right invariance. Compact groups have normalized Haar probability measure. Pontryagin duality concerns locally compact abelian groups and their continuous characters.

Distinctions: Algebraic isomorphisms need not be topological isomorphisms. Dense subgroups and closed subgroups have different quotient behavior, and local compactness alone does not provide a Lie-group structure. Left invariance does not imply right invariance outside unimodular settings.

Connections: Harmonic analysis studies Haar integration and characters, representation theory studies continuous actions, and geometry supplies Lie groups. Probability uses invariant measures and random walks on groups.

Example: For the additive topological group R, consider the normal subgroup Q and the quotient map q:R→R/Q. If a nonempty subset V of R/Q is open, its preimage U is a nonempty open set of R saturated under rational translation. For any x∈R, density of Q gives a rational r∈x−U, so x=u+r for some u∈U. Saturation yields x∈U; hence U=R and V=R/Q. The quotient is therefore indiscrete and has distinct points that cannot be separated. By contrast, the closed subgroup Z gives the Hausdorff quotient R/Z≅S¹. Existence of a quotient group alone does not control its topological separation.

Reading: [Collected domain materials](../domain-materials/topology.md#topological-groups).
