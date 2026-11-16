Read only the expert section needed for the current mathematical question.

## enumerative-combinatorics

**枚举组合 / Enumerative Combinatorics Expert** (D061)

Expertise: Finite counting, graded combinatorial classes and enumerative sequences, including the effects of labels, automorphisms, weights and size conventions on what is being counted.

Knowledge: Ordinary generating functions encode counts as coefficients; exponential generating functions encode labelled counts divided by factorials and naturally require appropriate coefficient denominators. Products correspond to different convolution laws in these settings. Finite inclusion-exclusion describes unions of overlapping conditions. Burnside's lemma relates orbits of a finite group action to average fixed-point counts. Over a field, rational generating functions correspond to eventual linear recurrences with constant coefficients.

Distinctions: Equal cardinalities do not identify the underlying structures, and weighted counts need not determine ordinary counts. Unlabelled objects are orbits rather than labelled objects with an arbitrary factorial removed. Formal power series have coefficientwise meaning independent of analytic convergence.

Example: Binary colorings of four cyclically arranged positions, identified only under rotation, form six necklaces. The rotations by 0, 1, 2 and 3 positions fix respectively 16, 2, 4 and 2 colorings, so Burnside gives (16+2+4+2)/4=6. Among colorings with exactly two ones, the corresponding fixed counts are 6, 0, 2 and 0, giving two necklaces: adjacent ones and alternating ones. Dividing the six labelled weight-two colorings by four would instead give 3/2. The alternating coloring has a rotational stabilizer of order two, whereas an adjacent pair has trivial stabilizer. Orbit sizes depend on the action, not just the number of positions.

Connections: Combinatorial species organize labelling and substitution; incidence algebras explain inversion formulas. Symmetric functions retain representation data, while analytic combinatorics adds singularity and convergence information to formal enumeration.

Reading: [Collected domain materials](../domain-materials/discrete-mathematics.md#enumerative-combinatorics).

## algebraic-combinatorics

**代数组合 / Algebraic Combinatorics Expert** (D062)

Expertise: Algebraic structures carried by finite combinatorial objects, particularly tableaux, symmetric functions, finite posets and the combinatorics of representations.

Knowledge: Schur functions form an integral basis of symmetric functions, with tableaux describing their monomial expansions and Littlewood-Richardson coefficients describing multiplication. Power sums form a basis over the rationals but do not supply the same integral coordinates. A locally finite poset has an incidence algebra whose zeta function has a Möbius inverse. Characteristic-zero irreducible representations of symmetric groups are indexed by partitions; positive characteristic dividing the group order can destroy semisimplicity.

Distinctions: Monomial positivity is weaker than Schur positivity. A formal expansion does not establish that its indexed family is a basis. Tableau conventions, partition transposition and grading alter the interpretation of coefficients, even when expressions look similar.

Example: For permutations of three letters, the possible RSK shapes are (3), (2,1) and (1,1,1). Their standard-tableau counts are 1, 2 and 1: the hook product for (2,1) is 3, giving 3!/3=2. Ordered pairs of tableaux of a common shape therefore account for 1, 4 and 1 permutations, totaling six. A uniformly chosen permutation has shape (2,1) with probability 2/3, rather than 1/2, which would result from weighting shapes by the single-tableau counts. For that shape there are two insertion tableaux and two recording tableaux; knowing only one leaves two possible partners. This illustrates why tableau multiplicity and permutation multiplicity are different quantities.

Connections: Representation theory explains characters and multiplicities; algebraic geometry supplies Schubert classes and intersection numbers. Poset topology relates Möbius values to Euler characteristics, while enumerative combinatorics supplies the underlying finite classes.

Reading: [Collected domain materials](../domain-materials/discrete-mathematics.md#algebraic-combinatorics).

## extremal-combinatorics

**极值组合 / Extremal Combinatorics Expert** (D063)

Expertise: Maximum or minimum sizes of finite structures subject to forbidden configurations, including density thresholds, supersaturation and the structure of near-extremal objects.

Knowledge: Turán's theorem identifies balanced complete multipartite graphs as extremizers for clique exclusion. For a fixed nonbipartite graph F, the Erdős-Stone-Simonovits theorem determines asymptotic extremal edge density from the chromatic number of F. Bipartite forbidden graphs have zero limiting edge density, but their finer growth rates require additional structure. Supersaturation concerns abundant forbidden copies above an extremal threshold; stability concerns proximity of near-extremizers to extremal configurations.

Distinctions: Induced exclusion also constrains absent edges, unlike ordinary subgraph exclusion. Extremal size, saturation and minimum-degree thresholds are different parameters. Asymptotic equivalence leaves lower-order terms and exceptional sizes unresolved, while stability conclusions depend on a specified notion of distance.

Example: The triangle K₃ and the five-cycle C₅ both have chromatic number three, so their forbidden-subgraph extremal numbers have the same leading term n²/4. Their forbidden classes nevertheless differ: a triangle together with isolated vertices is C₅-free but is not triangle-free. For K₃, Mantel’s exact value is floor(n²/4), attained by a balanced complete bipartite graph; equality of the leading terms does not transfer that exact formula to C₅. By contrast C₄ is bipartite, so Erdős–Stone–Simonovits gives only ex(n,C₄)=o(n²). That statement allows substantial superlinear growth and supplies neither an exact edge count nor a stability description.

Connections: Graph limits describe dense asymptotic phenomena. Hypergraph extremal theory has different threshold behavior; additive combinatorics and discrete geometry supply configuration problems with additional algebraic or geometric constraints.

Reading: [Collected domain materials](../domain-materials/discrete-mathematics.md#extremal-combinatorics).

## graph-theory

**图论 / Graph Theory Expert** (D064)

Expertise: Finite graph structure through connectivity, paths, matchings, colorings and flows, with attention to the consequences of directedness, multiplicity and loops.

Knowledge: Hall's theorem characterizes a matching saturating one side of a finite bipartite graph by neighborhood inequalities. König's theorem equates maximum matching size and minimum vertex-cover size in that setting. For nonadjacent vertices, Menger's theorem equates the maximum number of internally vertex-disjoint paths with the minimum separating vertex set. Finite network flows satisfy max-flow/min-cut duality, with integral optimal flows available for integral capacities.

Distinctions: Walks can repeat vertices, whereas simple paths cannot. Edge connectivity and vertex connectivity have different obstructions. A connected graph can become disconnected after one vertex deletion; bipartite matching identities do not extend unchanged to arbitrary graphs.

Example: The star K₁,₃ has four vertices and no isolated vertex, yet every matching contains at most one edge because all edges share the center. In the Tutte–Berge formula, deleting the center leaves three odd components, so U consisting of the center gives (4+1−3)/2=1. The perfect-matching inequality fails because 3>1. Its bipartition also shows the obstruction through Hall: the three leaves have only one neighbor. A different obstruction separates matching from covering outside the bipartite setting: a triangle has maximum matching size one and minimum vertex-cover size two. Thus parity, coverage, neighborhood expansion and the bipartite min–max identity carry different information.

Connections: Graphic matroids encode forests and cycles. Spectral graph theory connects adjacency or Laplacian operators with expansion, while topological graph theory concerns embeddings and surfaces rather than only abstract incidence.

Reading: [Collected domain materials](../domain-materials/discrete-mathematics.md#graph-theory).

## hypergraph-theory

**超图理论 / Hypergraph Theory Expert** (D065)

Expertise: Families of subsets as higher-order incidence structures, particularly uniform hypergraphs, intersection families, matchings, covers, shadows and codegree conditions.

Knowledge: In an r-uniform hypergraph, each edge has r vertices; t-codegrees count edges containing a specified t-subset. Kruskal-Katona theory relates the size of a uniform family to its lower shadow. The Erdős-Ko-Rado bound applies to intersecting k-subset families on n points when n≥2k. For finite r-uniform hypergraphs with r≥1, matching and cover numbers satisfy ν≤τ≤rν, while fractional matching and fractional covering have equal optima by finite linear programming duality.

Distinctions: Integral and fractional matchings can differ substantially. Degree assumptions do not automatically imply codegree assumptions. Perfect matchings require divisibility and coverage, but those necessary conditions alone are insufficient. Ordered or repeated edges change incidence counts.

Example: On vertices {1,…,6}, consider the 3-uniform hypergraph with edges 123, 145, 246 and 356. Every two edges intersect, so its maximum integral matching has size one; it has no perfect matching although six is divisible by three and no vertex is isolated. Assigning weight 1/2 to every edge gives a fractional matching of value two because every vertex belongs to two edges. No fractional matching can exceed 6/3=2. The vertices {1,6} cover every edge, whereas no single vertex does, so the integral cover number is two. Weights 1/3 on all vertices give a fractional cover of the same value two.

Connections: Simplicial complexes organize downward-closed families; design theory prescribes exact codegrees. Extremal and probabilistic combinatorics describe density and existence phenomena, while optimization studies matching relaxations and integrality gaps.

Reading: [Collected domain materials](../domain-materials/discrete-mathematics.md#hypergraph-theory).

## probabilistic-combinatorics

**概率组合 / Probabilistic Combinatorics Expert** (D066)

Expertise: Probability laws on discrete structures, random graph behavior and probabilistic existence phenomena, including concentration, dependency and threshold effects.

Knowledge: In G(n,p), distinct edges are independent Bernoulli variables; conditioning on the edge count gives a different dependence structure. Moment inequalities relate random counts to existence probabilities. Chernoff bounds concern sums with suitable independence, whereas bounded martingale differences support Azuma-type bounds. The symmetric Lovász local lemma gives positive probability of avoiding bad events when a dependency graph has maximum degree d, event probabilities are at most p, and e p(d+1)≤1.

Distinctions: A dependency graph requires independence from collections of non-neighbor events, not just pairwise independence. Positive expectation and high-probability existence are different strengths. A threshold location, its width and its finite-size behavior are separate properties.

Example: Let X and Y be independent fair bits, and let A={X=0}, B={Y=0} and C={X⊕Y=0}. Each event has probability 1/2, and every pair has intersection probability 1/4, so the events are pairwise independent. However, P(A∩B∩C)=1/4, while P(A)P(B∩C)=1/8: A is not independent of the joint information in B and C. Moreover avoiding A and B forces X=Y=1, which makes C occur, so avoiding all three has probability zero. The empty graph therefore cannot serve as a dependency graph for these events. Pairwise calculations alone omit the collection-independence hypothesis in the Lovász local lemma.

Connections: Random structures interact with extremal graph theory and randomized algorithms. Statistical mechanics supplies correlation and phase-transition concepts; probability theory explains concentration, coupling and the limits of independence assumptions.

Reading: [Collected domain materials](../domain-materials/discrete-mathematics.md#probabilistic-combinatorics).

## additive-combinatorics

**加性组合 / Additive Combinatorics Expert** (D067)

Expertise: Additive structure and growth in groups, especially finite sumsets, representation multiplicities, additive energy, stabilizers and approximate groups.

Knowledge: In an abelian group, additive energy counts collisions a+b=a′+b′ and equals the second moment of sum-representation counts. It relates large multiplicities to small sumsets. Ruzsa inequalities compare sumsets and difference sets of finite nonempty subsets. In finite abelian groups, Kneser's theorem incorporates the stabilizer H of A+B through the bound |A+B|≥|A+H|+|B+H|−|H|. Iterated-growth statements such as Plünnecke inequalities have specific commutativity and small-doubling hypotheses.

Distinctions: Distinct sums and representations of sums are different counts. Subgroup periodicity permits behavior absent in torsion-free settings. Fourier normalization depends on the ambient group and measure; noncommutative approximate groups do not inherit every additive identity.

Example: For A={0,1,2} inside Z, the five sums 0,…,4 have ordered representation counts 1,2,3,2,1. Thus |A+A|=5, the doubling ratio is 5/3, and the additive energy is 1²+2²+3²+2²+1²=19. Cauchy–Schwarz gives |A+A|E(A)≥|A|⁴, here 95≥81. For the full subgroup H=Z/3Z, there are only three sums, each represented three times, giving energy 27 and doubling ratio one. The same number of elements therefore produces different growth and collision counts in different ambient groups. In the subgroup example periodicity is exact; the integer progression instead has boundary losses in its representation counts.

Connections: Harmonic analysis describes convolution and characters; geometric group theory studies growth and approximate symmetries. Arithmetic combinatorics adds integer, prime or congruence structure beyond these abstract group phenomena.

Reading: [Collected domain materials](../domain-materials/discrete-mathematics.md#additive-combinatorics).

## ramsey-theory

**Ramsey理论 / Ramsey Theory Expert** (D068)

Expertise: Unavoidable homogeneous patterns in finite or infinite colorings of subsets, graphs, ordered structures and arithmetic configurations.

Knowledge: Finite Ramsey numbers encode the smallest ambient size forcing a prescribed monochromatic configuration. Infinite Ramsey theory states that finite colorings of fixed-size subsets of a countably infinite set have infinite homogeneous subsets. Van der Waerden's theorem concerns monochromatic arithmetic progressions of arbitrary finite length under a finite coloring of the integers. Hales-Jewett theory concerns combinatorial lines over finite alphabets. These statements have distinct parameter spaces and quantitative bounds.

Distinctions: Infinite existence does not itself specify an effective finite bound. Monochromatic, canonical and induced configurations impose different requirements. Ordered tuples and unordered subsets define different coloring domains, while infinitely many colors can invalidate familiar finite-color conclusions.

Example: Color each nonzero integer n by the parity of floor(log₂|n|), and color zero arbitrarily. Each annulus 2^m≤|n|<2^(m+1) is monochromatic, and its positive part contains 2^m consecutive integers. Both colors therefore contain arbitrarily long finite arithmetic progressions. Yet no one-sided infinite progression a+jd, j≥0, with d≠0 is monochromatic. Eventually its absolute values grow without bound in steps of |d|, so it meets every sufficiently wide annulus, including annuli of both parities. This explicit coloring distinguishes unbounded finite progression length from a single infinite progression. It also explains why the finite-length conclusion of van der Waerden’s theorem cannot simply be replaced by infinite length.

Connections: Logic and compactness connect finite and infinitary formulations. Topological dynamics links recurrence with arithmetic patterns; extremal combinatorics and probabilistic combinatorics describe lower bounds and sparse avoidance phenomena.

Reading: [Collected domain materials](../domain-materials/discrete-mathematics.md#ramsey-theory).

## design-theory

**组合设计 / Design Theory Expert** (D069)

Expertise: Finite incidence systems with prescribed coverage multiplicities, including block designs, packings, difference families and group-developed designs.

Knowledge: A t-(v,k,λ) design has v points and blocks of size k, with every t-subset lying in exactly λ blocks. Incidence counting determines replication numbers and the relation b·binom(k,t)=λ·binom(v,t), yielding divisibility restrictions. Balanced incomplete block designs are the t=2 case. Difference sets in finite groups produce designs when their ordered difference multiplicities satisfy the required parameters. A symmetric design has as many blocks as points.

Distinctions: Parameter divisibility is necessary but not generally sufficient for existence. Repeated blocks and simple block families are different conventions. Symmetry in the number of points and blocks does not mean that an arbitrary incidence matrix is symmetric; packings replace exact coverage with an upper bound.

Example: A Steiner triple system on v points has r=(v−1)/2 blocks through each point and b=v(v−1)/6 blocks in total. Integrality forces v≡1 or 3 modulo 6; for v=5, the nonintegral block count rules out existence. On Z/7Z, the seven translates of {0,1,3} do form a Steiner triple system. The six ordered nonzero differences within this block are ±1, ±2 and ±3, covering every nonzero residue exactly once, so every pair lies in exactly one translate. Here r=3 and b=7. This construction verifies existence at one admissible size; divisibility alone is not a general finite-size existence proof.

Connections: Finite geometry supplies projective and affine examples. Coding theory interprets incidence matrices algebraically; group actions describe automorphisms and orbit structure, while experimental design adds statistical criteria beyond incidence balance.

Reading: [Collected domain materials](../domain-materials/discrete-mathematics.md#design-theory).

## matroid-theory

**拟阵理论 / Matroid Theory Expert** (D070)

Expertise: Finite independence structures abstracting vector dependence, forests and exchange, including rank, circuits, bases, duality, minors and representability.

Knowledge: Hereditary independence and augmentation imply that all bases have equal size. The rank function is monotone and submodular, and circuits are minimal dependent sets. Dual bases are complements of bases in the ground set. Contraction has rank r(M/C)(X)=r(M)(X∪C)−r(M)(C) on elements outside C. The greedy characterization links matroid independence with optimal weighted selection; representability requires a vector configuration over a specified field.

Distinctions: Restriction removes elements without the dependence changes produced by contraction. Loops and parallel elements affect circuits and minors even when simplified pictures hide them. Representability over one field does not imply representability over every characteristic.

Example: Over F₂, the columns a=(1,0), b=(0,1) and c=(1,1) represent U₂,₃: every pair is independent but all three are dependent. Its bases are {a,b}, {a,c} and {b,c}. Their complements are the singleton bases of the dual U₁,₃, where all three elements are parallel and none is a loop. Deleting c leaves U₂,₂, with {a,b} independent. Contracting c instead gives U₁,₂: either remaining singleton is independent, but their pair has rank one. Thus deletion preserves the rank of this remaining pair while contraction changes it, even though both operations leave exactly the same labelled ground set {a,b}.

Connections: Linear algebra supplies representable matroids, while graphs give graphic and cographic matroids. Polyhedral optimization studies base polytopes; algebraic geometry and tropical geometry supply valuated and realizable variants with additional structure.

Reading: [Collected domain materials](../domain-materials/discrete-mathematics.md#matroid-theory).
