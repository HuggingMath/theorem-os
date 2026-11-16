Read only the selected expert profile when its geometric knowledge is relevant to the current assignment.

## euclidean-geometry

**欧氏几何 / Euclidean Geometry Expert** (D021)

Expertise: Specialist in the metric and affine structure of finite-dimensional real Euclidean spaces, including distances, angles, orthogonality, circles, spheres and rigid motions.

Knowledge: A positive-definite inner product determines norms, squared distances and orthogonal projections. Gram matrices encode pairwise inner products and are positive semidefinite; their determinant vanishes exactly when the associated finite vector family is linearly dependent. Rigid motions are affine maps with orthogonal linear parts. Three noncollinear points in a Euclidean plane determine a unique circumcircle, while distance and angle relations constrain more general configurations.

Distinctions: Points belong to an affine space, whereas displacements belong to its vector space. Oriented angles carry information absent from ordinary angles. Degenerate configurations can change existence or uniqueness, and positive-definite metric facts differ from statements about indefinite bilinear forms.

Connections: Linear algebra supplies orthogonal decompositions and quadratic forms; affine geometry describes incidence without a metric. Convex geometry uses projections and supporting inequalities, while Riemannian geometry generalizes Euclidean inner products to varying tangent spaces.

Example: In the Euclidean plane, take u=(1,0) and v=(1,t), with t real. Their Gram matrix is [[1,1],[1,1+t²]], so its determinant is t² and the triangle with vertices 0,u,v has area |t|/2. At t=0 the vectors become dependent and the area vanishes; for t≠0 they span the plane. The invertible shear S(x,y)=(x+y,y) preserves their independence, but for t=1 it changes their inner product from 1 to 2 and their angle from π/4 to arccos(2/√5). Thus affine independence survives an arbitrary invertible affine change, while angles and the Gram entries depend on the Euclidean metric.

Reading: [Collected domain materials](../domain-materials/geometry.md#euclidean-geometry).

## projective-geometry

**射影几何 / Projective Geometry Expert** (D022)

Expertise: Specialist in projective spaces over fields, incidence, homogeneous coordinates, projective transformations, duality and the geometry of points and linear subspaces.

Knowledge: Projective points are one-dimensional vector subspaces, so homogeneous coordinates are defined up to nonzero scalar multiplication. Linear subspaces determine projective subspaces, with joins and intersections governed by dimension relations. Projectivities preserve incidence and the cross ratio of ordered collinear configurations. In projective dimension at least two, collineations of projective spaces over fields are induced by semilinear transformations; a field automorphism can therefore affect coordinate invariants.

Distinctions: An affine chart omits a hyperplane rather than covering every projective point. Linear projectivities and semilinear collineations have different scalar behavior. Duality reverses incidence, and conic or quadratic-form statements can depend on characteristic, especially characteristic two.

Connections: Linear algebra describes subspaces and annihilators; algebraic geometry studies projective varieties and homogeneous equations. Affine geometry arises on charts, while field theory governs the automorphisms appearing in semilinear transformations.

Example: In the complex projective plane with coordinates [X:Y:Z], the affine chart Z≠0 identifies [X:Y:Z] with (X/Z,Y/Z). The affine lines y=0 and y=1 have projective closures Y=0 and Y=Z. Solving these homogeneous equations gives Y=Z=0, hence their unique intersection is [1:0:0]. This point lies outside the chosen chart, although it is an ordinary projective point represented by every (a,0,0) with a≠0. The same calculation works over the real numbers. Parallelism in the chart records an intersection on its omitted line; changing the chart changes that affine description while preserving the projective incidence.

Reading: [Collected domain materials](../domain-materials/geometry.md#projective-geometry).

## affine-geometry

**仿射几何 / Affine Geometry Expert** (D023)

Expertise: Specialist in affine spaces, affine subspaces, independence, barycentric coordinates and affine maps, with particular knowledge of structures that do not require a chosen origin or metric.

Knowledge: An affine space is a torsor for a vector space: differences of points are vectors, and vectors translate points. Nonempty affine subspaces correspond, after choosing a point, to translates of linear subspaces. Affine combinations have coefficients summing to one. Over a field, an affine basis of a finite-dimensional affine space gives unique barycentric coordinates; a dimension-d affine basis has d+1 points. Affine maps preserve these normalized combinations.

Distinctions: Affine independence is not linear independence of position vectors relative to an arbitrary origin. Coordinate existence within a span differs from uniqueness. Parallelism is affine information, whereas lengths, perpendicularity and angles require additional structure.

Connections: Linear algebra underlies direction spaces and affine maps. Convex geometry adds nonnegative coefficients over ordered fields, projective geometry supplies a completion by directions, and statistics uses barycenters and affine constraints.

Example: Let p₀=(0,0), p₁=(1,0), p₂=(1,1) and p₃=(0,1). Their center satisfies (p₀+p₂)/2=(p₁+p₃)/2=(1/2,1/2), giving two convex representations on disjoint pairs. Equivalently, the coefficients (1,−1,1,−1) sum to zero and their weighted sum of points is zero. Adding a multiple of this relation to normalized coefficients preserves both the represented point and the coefficient sum. These four points therefore span the plane but do not form an affine basis. Every affine map preserves the relation, including shears that alter lengths and angles. The intersecting diagonals also realize a concrete Radon partition.

Reading: [Collected domain materials](../domain-materials/geometry.md#affine-geometry).

## convex-geometry

**凸几何 / Convex Geometry Expert** (D024)

Expertise: Specialist in convex sets, convex functions, supporting functionals, extreme points, convex hulls and finite-dimensional polytopes, including the role of ambient topology.

Knowledge: Convexity concerns closure under normalized combinations with nonnegative real coefficients. In dimension d, Carathéodory's theorem bounds convex-hull representations by d+1 points. Nonempty compact convex sets in finite-dimensional real spaces are convex hulls of their extreme points. Separation theorems depend on openness, closedness and local convexity assumptions. A nonempty closed convex subset of a Hilbert space has a unique nearest point to each point of the ambient space.

Distinctions: Relative interior is taken inside the affine hull and can be nonempty when ambient interior is empty. Boundedness does not imply compactness in arbitrary normed spaces. Weak separation, strict separation and supporting hyperplanes express different conclusions; extreme and exposed points need not coincide.

Connections: Optimization interprets supporting functionals as dual information. Functional analysis extends convexity to topological vector spaces, while discrete geometry studies polytopal faces, lattice constraints and finite configurations.

Example: Consider K={0}∪{(x,y):x>0,y>0} in R². It is a convex cone but excludes both positive coordinate axes, so it is not closed. With the convention K*={z:z·w≥0 for every w∈K}, its dual is the closed nonnegative quadrant. Nonnegative coordinates plainly suffice; if one coordinate of z is negative, choosing that coordinate of w sufficiently large makes z·w negative. Dualizing the quadrant again gives the same quadrant. Thus (1,0) belongs to K** but not K, and K** equals the closure of K. Convexity alone does not supply the closedness required for exact bipolar recovery.

Reading: [Collected domain materials](../domain-materials/geometry.md#convex-geometry).

## discrete-geometry

**离散几何 / Discrete Geometry Expert** (D025)

Expertise: Specialist in finite geometric configurations, incidence structures, arrangements, convex polytopes, packings and coverings, where metric or affine constraints interact with combinatorial quantities.

Knowledge: Incidence relations connect points, lines, hyperplanes and cells, while arrangement structures record how geometric objects partition space. Polytopes have face lattices and dimension-dependent relations; Euler characteristics distinguish the boundary of a convex polytope from arbitrary cell collections. Packing and covering densities depend on the ambient metric, dimension and allowed objects. General position excludes specified coincidences and changes the attainable incidence or region counts.

Distinctions: A finite point set differs from an indexed family containing repeated points. Counting pairs does not automatically count distinct geometric objects. Shared boundaries, unbounded cells and degenerate intersections alter combinatorial descriptions, and lattice geometry imposes arithmetic restrictions absent from real configurations.

Connections: Combinatorics studies the associated finite relations, topology describes cell-complex invariants, and computational geometry represents configurations algorithmically. Convex analysis and measure theory contribute metric bounds and volume information.

Example: For 0<θ<π, take the planar rhombus with vertices 0, (1,0), (1+cos θ,sin θ) and (cos θ,sin θ), in that cyclic order. Every side has length one, but the diagonal from 0 to (1+cos θ,sin θ) has length √(2+2cos θ), which varies with θ. In particular, θ=π/2 gives √2 whereas θ=π/3 gives √3, so these labeled faces are not isometric despite identical edge lengths. This isolates a condition in Cauchy rigidity: combinatorially equivalent convex three-dimensional polytopes require corresponding faces to be isometric. Equal lengths of the boundary edges alone do not establish that face hypothesis.

Reading: [Collected domain materials](../domain-materials/geometry.md#discrete-geometry).

## differential-geometry

**微分几何 / Differential Geometry Expert** (D026)

Expertise: Specialist in smooth manifolds, tangent and cotangent bundles, smooth maps, vector fields, differential forms and connections, including the relationship between local coordinates and intrinsic structures.

Knowledge: Smooth atlases are linked by compatible transition maps. Differentials act between tangent fibers, while differential forms are alternating covariant tensors. Exterior differentiation satisfies its graded product rule and squares to zero on smooth forms. Lie brackets describe the noncommutativity of vector fields. A connection adds covariant differentiation; its torsion and curvature measure distinct departures from simpler geometric behavior. Stokes' theorem relates exterior differentiation to integration on oriented manifolds with the appropriate boundary or support conditions.

Distinctions: Coordinate components are not intrinsic vectors or tensors. Local expressions define global objects only when their transition laws agree. Differentiability order and the presence of boundary affect available structures; a connection is additional data rather than part of every smooth manifold.

Connections: Topology governs global obstructions, multilinear algebra describes tensors, and analysis supplies differential equations and integration. Riemannian, symplectic and complex geometry add specialized structures to smooth manifolds.

Example: On the half-plane x>0, equip R² with its standard Euclidean connection and choose the smooth frame X=∂x, Y=x∂y. For a smooth function f, X(Yf)−Y(Xf)=∂y f, so [X,Y]=∂y is nonzero. Covariant differentiation nevertheless gives ∇X Y=∂y and ∇Y X=0. Consequently T(X,Y)=∇X Y−∇Y X−[X,Y]=0. The restriction x>0 ensures that X and Y are independent everywhere; the bracket is not a degeneracy artifact. Noncommutativity belongs to these vector fields, whereas torsion belongs to the connection. The bracket term prevents coefficients in a noncoordinate frame from being mistaken for intrinsic torsion.

Reading: [Collected domain materials](../domain-materials/geometry.md#differential-geometry).

## riemannian-geometry

**黎曼几何 / Riemannian Geometry Expert** (D027)

Expertise: Specialist in smooth positive-definite metrics on manifolds, their connections and curvature, geodesics, length, distance and the interaction between local geometry and global completeness.

Knowledge: A smooth Riemannian metric has a unique torsion-free metric-compatible Levi-Civita connection. Geodesics have vanishing covariant acceleration and are locally length minimizing on sufficiently short segments. Curvature appears as a tensor, sectional curvature and its traces, including Ricci and scalar curvature. On connected finite-dimensional Riemannian manifolds, Hopf-Rinow relates metric completeness to geodesic completeness and guarantees minimizing geodesics between points under completeness.

Distinctions: Geodesic existence near initial data does not imply indefinite extension or global minimality. Cut points and conjugate points concern different geometric phenomena. Curvature identities depend on sign and tensor conventions, while pseudo-Riemannian metrics lack the positivity underlying ordinary distance and length comparisons.

Connections: Differential equations describe geodesic evolution, comparison geometry relates curvature bounds to metric behavior, and topology constrains global structures. Geometric analysis studies elliptic operators and evolution equations determined by the metric.

Example: Give the open interval M=(0,1) its Euclidean Riemannian metric. Every two points p,q are joined inside M by γ(s)=(1−s)p+sq, whose length is |p−q| and therefore equals their distance. Nevertheless, the sequence xₙ=1−1/n for n≥2 is Cauchy and has no limit in M. The unit-speed geodesic η(t)=1/2+t has maximal parameter interval (−1/2,1/2), reaching a missing endpoint after finite time. Thus M is both metrically and geodesically incomplete despite having minimizing geodesics between every pair. Hopf–Rinow supplies this minimizing property as a consequence of completeness; that consequence alone is not an equivalent completeness criterion.

Reading: [Collected domain materials](../domain-materials/geometry.md#riemannian-geometry).

## symplectic-geometry

**辛几何 / Symplectic Geometry Expert** (D028)

Expertise: Specialist in symplectic forms, Hamiltonian systems, symplectic maps and isotropic, coisotropic or Lagrangian geometry on smooth real manifolds and their tangent spaces.

Knowledge: A symplectic form is a closed, nondegenerate differential two-form, and its manifold has even dimension. Darboux's theorem identifies its local smooth form with the standard symplectic structure, so curvature is not a local invariant of the symplectic form alone. Nondegeneracy identifies tangent and cotangent spaces through contraction. Hamiltonian vector fields preserve the form wherever their flows exist. In dimension 2n, isotropic subspaces have dimension at most n, and Lagrangian subspaces are maximal isotropic.

Distinctions: Closedness and nondegeneracy are separate requirements. A symplectic vector field need not be globally Hamiltonian; the obstruction involves closed versus exact one-forms. Existence of a local Hamiltonian flow does not imply completeness, and a symplectic form does not specify a unique compatible metric.

Connections: Classical mechanics supplies Hamiltonian dynamics, topology enters through de Rham classes and global obstructions, and Lie theory contributes moment maps. Complex geometry intersects through compatible almost complex and Kähler structures.

Example: On T²=R²/Z², the translation-invariant forms dx,dy descend even though x,y themselves are not global real-valued coordinates. Set ω=dx∧dy and X=∂x. Then ιXω=dy is closed, and X has the complete flow [x,y]↦[x+t,y], which preserves ω. But the integral of dy around the vertical unit loop is one. An exact form dH would have zero integral around that closed loop, so X has no global Hamiltonian under the convention ιXω=dH. Locally H=y works, but it fails to be periodic. The obstruction is global exactness, despite a nonsingular form and globally defined symplectic evolution.

Reading: [Collected domain materials](../domain-materials/geometry.md#symplectic-geometry).

## complex-geometry

**复几何 / Complex Geometry Expert** (D029)

Expertise: Specialist in complex manifolds, holomorphic maps and bundles, Hermitian and Kähler structures, and the local analytic data underlying global complex-geometric objects.

Knowledge: Holomorphic transition maps define complex manifolds, and their derivatives are complex linear. A smooth almost complex structure is integrable precisely when its Nijenhuis tensor vanishes, by the smooth Newlander-Nirenberg theorem. Holomorphic bundles have holomorphic invertible transition functions satisfying cocycle identities. Hermitian metrics determine real fundamental two-forms; the Kähler condition is their closedness. On compact Kähler manifolds, Hodge theory relates de Rham cohomology to a decomposition by complex bidegree. Divisors record codimension-one analytic data with multiplicities.

Distinctions: Real smoothness does not imply holomorphicity, and an almost complex structure need not provide holomorphic coordinates. Topological, smooth and holomorphic triviality of bundles differ. Compactness assumptions behind global cohomological or analytic statements are absent from purely local holomorphic identities.

Connections: Several complex variables describes local analytic behavior, algebraic geometry studies algebraic complex spaces, and differential geometry supplies metrics and connections. Cohomology records obstructions to global holomorphic constructions.

Example: Let E=C/(Z+iZ). The form dz descends because lattice translations have derivative one, and ω=(i/2)dz∧d z̄=dx∧dy descends to a positive closed real (1,1)-form. A fundamental square has compact image equal to E, so this is a compact Kähler manifold. The holomorphic one-form dz is locally the differential of a coordinate, but along the closed horizontal loop s↦[s], 0≤s≤1, its integral is one. It therefore has no global smooth primitive, even a complex-valued one, and represents a nonzero complex de Rham class. Local exactness and global closedness thus leave a genuine period obstruction compatible with Kähler geometry.

Reading: [Collected domain materials](../domain-materials/geometry.md#complex-geometry).

## algebraic-geometry

**代数几何 / Algebraic Geometry Expert** (D030)

Expertise: Specialist in varieties and schemes, their morphisms, coordinate rings, sheaves and local properties, including geometric information retained by localization and gluing.

Knowledge: The affine scheme of a commutative ring has prime ideals as points and a structure sheaf recording local algebra. Ring maps induce morphisms of affine schemes contravariantly. Localization describes distinguished opens, and compatible affine pieces form schemes. Over an algebraically closed field, the Nullstellensatz connects maximal ideals of finitely generated algebras with rational points. Smooth, étale and flat morphisms express different regularity or deformation properties, with finiteness conditions built into the first two.

Distinctions: The underlying topological space does not determine nilpotent structure. Reduced, integral, normal and regular have different local meanings. Closed points need not be rational over an arbitrary field, and geometric properties after base extension can differ from their original-field counterparts.

Connections: Commutative algebra governs local rings, modules and dimension; number theory studies arithmetic schemes. Complex geometry relates algebraic and analytic spaces under additional hypotheses, while category and sheaf theory describe morphisms, descent and global objects.

Example: For a field k, let R=k[ε]/(ε²). Every prime ideal contains ε because ε²=0, and R/(ε)=k, so Spec R has exactly one point. Its underlying topological space is therefore homeomorphic to Spec k. Their structure sheaves differ: ε is a nonzero global section on Spec R with square zero, and R has k-dimension two rather than one. The ideal (ε) also gives a quasicoherent sheaf whose global module has k-dimension one and is annihilated by ε, unlike the free rank-one R-module. The same one-point topology thus supports different functions, nilpotent structure and coherent module data.

Reading: [Collected domain materials](../domain-materials/geometry.md#algebraic-geometry).
