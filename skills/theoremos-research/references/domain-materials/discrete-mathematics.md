# Discrete mathematics: collected reading

Read only the section matching the specialist's current knowledge need.

Locators identify the body passages actually read. PDF pages count from the beginning of the linked PDF; printed pagination can differ. These are references and original summaries, with no third-party full text included. Unless a source-specific reuse note states otherwise, redistribution permission has not been verified.

## enumerative-combinatorics

**枚举组合 (D061)**

Reading: [Richard P. Stanley — Algebraic Combinatorics: Walks, Trees, Tableaux, and More](https://math.mit.edu/~rstan/algcomb/algcomb.pdf).

Locator: Chapter 7, Lemma 7.2 (Burnside's lemma), PDF pp. 86–87.

Knowledge: For a finite set acted on by a finite permutation group, the number of orbits equals the average number of fixed points of a group element. The count therefore depends on the actual action, including its stabilizers, rather than only on the abstract isomorphism class or order of the group.

Scope: Finite orbit enumeration and Burnside's lemma; not a reading of all generating-function or recurrence theory.

### Further reading

Reading: [Richard P. Stanley — Topics in Algebraic Combinatorics, version of 1 February 2013](https://math.mit.edu/~rstan/algcomb/algcomb.pdf).

Locator: §12.7, equation (12.8), Lemmas 12.16–12.17 and Theorem 12.18, PDF pp. 203–205 (printed pp. 246–248).

Knowledge: A complex sequence f(n) is P-recursive when it satisfies Σᵢ₌₀ᵈ Pᵢ(n)f(n+i)=0 for all n≥0, with polynomial coefficients and P_d not identically zero. This is equivalent to finite-dimensionality over C(n) of the span of its shifted germs [f(n+k)], k≥0, where germs identify sequences differing at finitely many indices. P-recursiveness is preserved by finite alterations, complex linear combinations and pointwise products. Zeros of P_d can obstruct solving forward at isolated indices, so division by the leading coefficient is valid only eventually.

Scope: Polynomial-coefficient linear recurrences and the cited closure statements for complex sequences; convolution, analytic convergence and a general generating-function equivalence were not read.

## algebraic-combinatorics

**代数组合 (D062)**

Reading: [Richard P. Stanley — Algebraic Combinatorics: Walks, Trees, Tableaux, and More](https://math.mit.edu/~rstan/algcomb/algcomb.pdf).

Locator: Chapter 8, definition of standard Young tableaux and Theorem 8.1 (hook length formula), PDF pp. 108–110.

Knowledge: A standard Young tableau of partition shape λ uses each integer from 1 to |λ| once, with increasing rows and columns. Such tableaux correspond to saturated chains from the empty partition in Young's lattice. The hook-length formula expresses their number as |λ|! divided by the product of the hook lengths of the diagram's squares.

Scope: Young's lattice, standard tableaux and the stated hook-length formula; the excerpt states that formula without proof and does not cover all symmetric-function theory.

### Further reading

Reading: [Richard P. Stanley — Topics in Algebraic Combinatorics, version of 1 February 2013](https://math.mit.edu/~rstan/algcomb/algcomb.pdf).

Locator: Chapter 8, Appendix 1, Theorem 8.13 and the following Corollary 8.5 identity, PDF pp. 121–122 (printed pp. 145–146).

Knowledge: RSK gives a bijection from permutations of {1,…,n} to ordered pairs (P,Q) of standard Young tableaux with the same partition shape λ⊢n. Thus the pair carries enough information to recover the permutation, whereas either tableau alone generally does not. If f^λ counts standard tableaux of shape λ, that shape accounts for (f^λ)² permutations, and summing over partitions gives Σ_{λ⊢n}(f^λ)²=n!. The common-shape requirement is part of the correspondence.

Scope: The permutation version of RSK and its tableau counting identity; semistandard extensions, symmetric-function identities and longest-subsequence theorems were not read.

## extremal-combinatorics

**极值组合 (D063)**

Reading: [Yufei Zhao — Graph Theory and Additive Combinatorics: Exploring Structure and Randomness](https://yufeizhao.com/gtacbook/gtacbook.pdf).

Locator: §1.2, Construction 1.2.2, Theorem 1.2.4 and Corollary 1.2.6, PDF pp. 30–31.

Knowledge: Among n-vertex graphs excluding K_(r+1), the balanced complete r-partite Turán graph has the maximum number of edges and is the unique extremizer up to isomorphism. Its exact edge count reflects the residue class of n modulo r. The simpler upper bound (1−1/r)n²/2 is attained when the part sizes can all be equal.

Scope: Finite clique-exclusion extremal graphs and exact versus simplified Turán bounds; not general hypergraph extremal theory or a full stability account.

### Further reading

Reading: [Yufei Zhao — Graph Theory and Additive Combinatorics: Exploring Structure and Randomness](https://yufeizhao.com/gtacbook/gtacbook.pdf).

Locator: §1.5, Theorem 1.5.1 and the preceding chromatic-number discussion, PDF p. 43 (printed p. 27).

Knowledge: For a fixed finite simple graph H with at least one edge, let ex(n,H) be the largest edge count of an n-vertex H-free simple graph. Erdős–Stone–Simonovits gives ex(n,H)=(1−1/(χ(H)−1)+o(1))n²/2 as n→∞ with H held fixed. The chromatic number therefore determines the leading edge density. When H is bipartite, this says only ex(n,H)=o(n²), leaving the smaller-order growth undetermined.

Scope: Asymptotic edge density for fixed forbidden graphs; no exact finite-n extremizer, bipartite growth exponent or stability classification is asserted.

## graph-theory

**图论 (D064)**

Reading: [Michel X. Goemans — 18.453: Lecture notes on bipartite matching](https://math.mit.edu/~goemans/18453S17/matching-notes.pdf).

Locator: §1.1, Theorem 1.1 (König); §1.1.1, Theorem 1.5 (Hall), PDF pp. 1–2 and 6.

Knowledge: In a finite bipartite graph, König's theorem equates maximum matching size with minimum vertex-cover size. Hall's condition |N(S)|≥|S| for every subset of one side characterizes the existence of a matching saturating that side. Saturating one side is distinct from a perfect matching unless the two sides have the same size.

Scope: Bipartite matchings, vertex covers and Hall's condition; not a reading of arbitrary-graph matching, graph coloring or all connectivity theorems.

### Further reading

Reading: [Michel X. Goemans — 18.453: Lecture notes on non-bipartite matching, February 21, 2017](https://math.mit.edu/~goemans/18453S17/matching-nonbip-notes.pdf).

Locator: Opening discussion and Theorem 2.1 (Tutte–Berge formula), PDF p. 1.

Knowledge: For a finite undirected graph G, write ν(G) for its maximum matching size and o(G−U) for the number of odd-order connected components after deleting U. Tutte–Berge gives ν(G)=min_{U⊆V} (|V|+|U|−o(G−U))/2. Consequently, a perfect matching exists exactly when o(G−U)≤|U| for every U⊆V. Odd components supply obstructions beyond the bipartite setting: in a triangle the maximum matching has one edge, while a minimum vertex cover has two vertices.

Scope: General-graph matching cardinality and the perfect-matching criterion derived from Tutte–Berge; the blossom algorithm and its complexity were not read.

## hypergraph-theory

**超图理论 (D065)**

Reading: [Yufei Zhao — 18.226 Probabilistic Methods in Combinatorics: Lecture Notes](https://yufeizhao.com/pm/probmethod_notes.pdf).

Locator: §1.3, hypergraph colorability definitions and Theorem 1.3.1, PDF pp. 15–16.

Knowledge: A finite k-uniform hypergraph is a family of k-element vertex subsets. Its proper vertex 2-colorings have no monochromatic edge, a property also called property B. For k≥2, every such hypergraph with fewer than 2^(k−1) edges is 2-colorable; the minimum edge count of a non-2-colorable hypergraph is a separate extremal parameter.

Scope: Uniform hypergraphs, property B and the stated elementary edge threshold; not matching, codegree or design-existence theory.

### Further reading

Reading: [Yufei Zhao — 18.226 Probabilistic Methods in Combinatorics: Lecture Notes](https://yufeizhao.com/pm/probmethod_notes.pdf).

Locator: §4.3, Example 4.3.13 (Shamir’s problem), PDF p. 57.

Knowledge: In the binomial random 3-uniform hypergraph G^(3)(n,p), each triple is included independently. When 3 divides n, a perfect matching consists of n/3 disjoint edges covering every vertex. The cited Johansson–Kahn–Vu result gives an absolute constant C such that p≥C n^(−2) log n yields a perfect matching with probability tending to one as n→∞ through these admissible sizes. The isolated-vertex obstruction has sharp threshold 2 n^(−2) log n; obtaining the correct order and obtaining the sharp threshold are different assertions.

Scope: The stated random 3-uniform model and matching threshold order; the excerpt reports later sharp-threshold work, but its proof and deterministic codegree matching theorems were not read.

## probabilistic-combinatorics

**概率组合 (D066)**

Reading: [Yufei Zhao — 18.226 Probabilistic Methods in Combinatorics: Lecture Notes](https://yufeizhao.com/pm/probmethod_notes.pdf).

Locator: §6.1, dependency discussion and Theorems 6.1.7–6.1.9, PDF pp. 85–86.

Knowledge: The symmetric Lovász local lemma concerns finite families of events with probabilities at most p and a dependency graph of maximum degree d. Under independence from the joint collection of non-neighbor events, e p(d+1)≤1 ensures positive probability that all events are avoided. Its general form allows separate parameters for individual events and their neighborhoods.

Scope: The dependency meaning and symmetric/general local-lemma statements; not a reading of all concentration or random-graph threshold results.

### Further reading

Reading: [Yufei Zhao — 18.226 Probabilistic Methods in Combinatorics: Lecture Notes](https://yufeizhao.com/pm/probmethod_notes.pdf).

Locator: §9.1, Theorems 9.1.1 and 9.1.3, PDF pp. 134–135; §9.2, Theorems 9.2.7–9.2.8, PDF p. 137.

Knowledge: For independent inputs X₁,…,Xₙ and a measurable real function whose value changes by at most cᵢ when only coordinate i changes, the bounded-differences theorem gives each tail of f(X)−Ef(X) at level t the bound exp(−2t²/Σcᵢ²), when the sum is positive. The output need not be a sum of independent variables. Azuma’s theorem instead assumes an integrable martingale with increments bounded in absolute value by cᵢ and gives the one-sided bound exp(−t²/(2Σcᵢ²)). Independence of inputs and the martingale conditional-expectation property are distinct hypotheses.

Scope: Bounded-differences and bounded-increment martingale concentration in the cited finite setting; no unbounded-increment, variance-sensitive or heavy-tail theorem is claimed.

## additive-combinatorics

**加性组合 (D067)**

Reading: [Yufei Zhao — Graph Theory and Additive Combinatorics: Exploring Structure and Randomness](https://yufeizhao.com/gtacbook/gtacbook.pdf).

Locator: §§7.2–7.3, Theorems 7.2.1 and 7.3.1 plus Remark 7.2.3, PDF pp. 256–257.

Knowledge: Ruzsa's triangle inequality compares |A||B−C| with |A−B||A−C| for finite subsets of an abelian group. The logarithmic Ruzsa distance obeys a triangle inequality but is not a metric, since its self-distance need not vanish. Plünnecke's inequality bounds iterated sums and differences in terms of a small-doubling hypothesis, within the stated abelian setting.

Scope: Abstract abelian-group sumset inequalities and small-doubling growth; not prime-number transference, noncommutative growth or a reading of all inverse theorems.

### Further reading

Reading: [Yufei Zhao — Graph Theory and Additive Combinatorics: Exploring Structure and Randomness](https://yufeizhao.com/gtacbook/gtacbook.pdf).

Locator: §7.1, Definition 7.1.7, Theorem 7.1.10 and Remark 7.1.12, PDF pp. 255–256 (printed pp. 239–240).

Knowledge: A d-dimensional generalized arithmetic progression is the image of an affine map from [L₁]×⋯×[L_d] into an abelian group. Its volume is ∏ᵢLᵢ; properness means that map is injective. For a finite nonempty A⊂Z satisfying |A+A|≤K|A|, Freiman’s theorem places A inside a progression of dimension at most d(K) and volume at most f(K)|A|, with bounds depending only on K. The progression can be required to be proper after changing these bounds. Its cardinality equals its volume only in the proper case.

Scope: The stated integer small-doubling structure theorem and properness distinction; no polynomial dependence on K or general-group coset-progression theorem is claimed.

## ramsey-theory

**Ramsey理论 (D068)**

Reading: [Yufei Zhao — Graph Theory and Additive Combinatorics: Exploring Structure and Randomness](https://yufeizhao.com/gtacbook/gtacbook.pdf).

Locator: §0.1, Theorems 0.1.4, 0.1.7 and 0.1.9, PDF pp. 18–19.

Knowledge: For any fixed number of colors and desired clique size, a sufficiently large complete graph contains a monochromatic clique under every edge-coloring. The corresponding finite statement extends to fixed-uniformity hypergraphs. These are universal statements over all colorings, rather than probability claims about random colorings.

Scope: Finite graph and hypergraph Ramsey statements and the multicolor triangle case; not infinitary or canonical Ramsey theory, nor sharp Ramsey-number estimates.

### Further reading

Reading: [Yufei Zhao — Graph Theory and Additive Combinatorics: Exploring Structure and Randomness](https://yufeizhao.com/gtacbook/gtacbook.pdf).

Locator: §0.2, Theorems 0.2.1 and 0.2.4, upper-density definition (0.2) and intervening qualification, PDF pp. 21–22 (printed pp. 5–6).

Knowledge: Every finite coloring of Z contains a monochromatic arithmetic progression of each prescribed finite length. Szemerédi’s theorem gives the density strengthening: if limsup_{N→∞}|A∩[−N,N]|/(2N+1)>0, then A contains arithmetic progressions of every finite length. The progressions have nonzero common difference. Arbitrarily long finite progressions need not form one infinite progression; that distinction is explicit in the source.

Scope: Qualitative arithmetic Ramsey and positive-upper-density statements; no quantitative finite-size bounds or theorem for arbitrary zero-density sets is asserted.

## design-theory

**组合设计 (D069)**

Reading: [Richard P. Stanley — Algebraic Combinatorics: Walks, Trees, Tableaux, and More](https://math.mit.edu/~rstan/algcomb/algcomb.pdf).

Locator: §12.4, BIBD parameter discussion and Theorem 12.4 (nonuniform Fisher inequality), PDF pp. 193–194.

Knowledge: A balanced incomplete block design prescribes a constant block size k, point replication r and pair multiplicity λ. Its incidence parameters satisfy vr=kb and λ(v−1)=r(k−1). The nonuniform Fisher statement in this section bounds the number of distinct subsets by the ground-set size when all pairwise intersections have one fixed positive cardinality λ smaller than that size.

Scope: BIBD incidence relations and the explicitly conditioned nonuniform Fisher inequality; not a full design-existence classification or arbitrary t-design constructions.

### Further reading

Reading: [Peter Keevash — The Existence of Designs, January 15, 2014 manuscript](https://people.maths.ox.ac.uk/keevash/papers/designs.pdf).

Locator: Introduction and §1.1, Definitions 1.1–1.3, Theorem 1.4 and its complete-hypergraph specialization, PDF pp. 1–2. The source uses q for k and r for t.

Knowledge: A t-(n,k,λ) design is a set of k-subsets of an n-point set in which each t-subset occurs in exactly λ blocks. Counting incidences forces binom(k−i,t−i) to divide λ binom(n−i,t−i) for every 0≤i<t. For fixed integers k>t≥2, Keevash’s complete-hypergraph specialization states that, for all sufficiently large n, these conditions with λ=1 are sufficient for a Steiner t-design. Equivalently, its blocks decompose the complete t-uniform hypergraph into complete t-uniform hypergraphs on k vertices.

Scope: Definition and necessary divisibility for general λ, plus asymptotic existence for λ=1; this reading does not give the exceptional finite n, an explicit size threshold, or a classification with varying k and t.

## matroid-theory

**拟阵理论 (D070)**

Reading: [James Oxley — What Is a Matroid?](https://www.math.lsu.edu/~oxley/survey4.pdf).

Locator: §2, axioms (I1)–(I3) and Theorem 2.6 on vector matroids, PDF pp. 2–4.

Knowledge: A finite matroid is a ground set with a nonempty hereditary family of independent subsets satisfying augmentation. Linear independence among labelled columns of a matrix gives a matroid over its coefficient field. Representability is an additional property relative to a field; the abstract independence axioms do not assert a vector realization over every field.

Scope: Finite independence axioms, augmentation and vector matroids; not a reading of the entire survey's excluded-minor or representability classification results.

### Further reading

Reading: [James Oxley — What Is a Matroid?](https://www.math.lsu.edu/~oxley/survey4.pdf).

Locator: §3, Theorem 3.2 and rank discussion, PDF p. 9; Proposition 3.3, Theorem 3.4 and equations (3.5)–(3.7), PDF p. 11.

Knowledge: The bases of a finite matroid are its maximal independent sets, and all have the same cardinality r(M). A nonempty family of subsets is a matroid basis family precisely when, for bases B₁,B₂ and x∈B₁∖B₂, some y∈B₂∖B₁ makes (B₁∖{x})∪{y} a basis. The complements of the bases form the bases of the dual M*, giving r(M*)=|E|−r(M) and (M*)*=M. In a connected graph the cycle-matroid bases are spanning trees; its dual is the bond matroid, defined for graphs without requiring planarity.

Scope: Finite basis exchange, total rank and dual bases/cocircuits; not a full reading of submodular rank functions, matroid intersection or excluded-minor theory.
