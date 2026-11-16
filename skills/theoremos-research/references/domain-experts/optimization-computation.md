Read only the expert section needed for the current mathematical question.

## convex-optimization

**凸优化 / Convex Optimization Expert** (D081)

Expertise: Convex objectives and feasible sets, including subgradients, conjugacy, separation, optimality conditions and primal-dual relationships in finite-dimensional optimization.

Knowledge: Convexity makes every local minimizer global, while strict convexity gives at most one minimizer on a convex domain. Subgradients describe supporting affine functions; normal cones encode feasible first-order geometry. A feasible KKT point is globally optimal for convex objectives and inequalities with affine equality constraints. Slater-type relative-interior conditions yield strong duality and multiplier existence under the standard properness and finite-value hypotheses. Lower semicontinuity and compact sublevel sets provide common attainment conditions.

Distinctions: A finite infimum need not be attained, and uniqueness does not imply existence. Weak duality needs less regularity than equality of primal and dual values. Strong convexity and gradient Lipschitz continuity are different properties whose constants depend on the chosen norm.

Example: For the convex problem minimizing |x| subject to −x≤u, the optimal value is p*(u)=max(−u,0). At u=0 the feasible point x=1 is strictly feasible, yet p* has left derivative −1 and right derivative zero. The dual function is −λu for 0≤λ≤1 and is −∞ otherwise; consequently every λ in [0,1] is dual optimal at zero. Each supplies the supporting inequality p*(u)≥−λu, and the full subdifferential is [−1,0]. There is no unique sensitivity derivative at the kink despite strong duality and multiplier attainment. Smoothness of the value function is extra information, rather than a consequence of these duality conclusions.

Connections: Convex analysis provides conjugates and monotone operators. Functional analysis supplies separation principles; statistics and machine learning interpret regularizers, while numerical optimization studies convergence to the optima described here.

Reading: [Collected domain materials](../domain-materials/optimization-computation.md#convex-optimization).

## nonconvex-optimization

**非凸优化 / Nonconvex Optimization Expert** (D082)

Expertise: Geometry and algorithmic guarantees for smooth or constrained nonconvex objectives, particularly stationarity, curvature, saddle behavior and local versus global optimality.

Knowledge: For a differentiable unconstrained objective, a local minimum is stationary; for twice differentiable objectives, its Hessian is positive semidefinite, while positive definiteness is a sufficient local condition. For an L-smooth lower-bounded objective, fixed-step gradient descent with 0<α<2/L has summable squared gradients and a best-iterate gradient-norm bound of order T^(-1/2). Polyak-Łojasiewicz inequalities can yield global objective convergence without convexity. Constrained stationarity involves feasible directions or normal cones rather than an unrestricted zero gradient.

Distinctions: Stationary points can be minima, maxima or saddles. Objective-value convergence is weaker than convergence of iterates, and local smoothness does not imply a global Lipschitz constant. Approximate first-order stationarity does not exclude negative curvature.

Example: Let F(x)=1+cos x and use the exact gradient g=−sin x with initial value x₁=0. Every update xₖ₊₁=xₖ−αₖgₖ stays at zero, regardless of the positive steps. The objective is bounded below by zero and has a globally 1-Lipschitz gradient; the direction assumptions hold with μ=μ_G=1 and zero variance. For αₖ=1/k, the classical step sums satisfy Σαₖ=∞ and Σαₖ²<∞. The weighted expected squared gradients and their liminf are zero, but F(0)=2 is a strict local maximum, with F″(0)=−1, while F(π)=0. This satisfies the cited stationarity conclusions without guaranteeing escape from a nonminimizing stationary point, local minimality or global objective optimality.

Connections: Differential geometry describes manifold constraints and critical points. Dynamical systems concerns limiting trajectories; variational analysis studies nonsmooth stationarity, while learning theory distinguishes optimization error from statistical risk.

Reading: [Collected domain materials](../domain-materials/optimization-computation.md#nonconvex-optimization).

## integer-optimization

**整数与组合优化 / Integer and Combinatorial Optimization Expert** (D083)

Expertise: Optimization over integral or mixed discrete-continuous feasible sets, including polyhedral relaxations, integrality, valid inequalities and exact objective bounds.

Knowledge: Linear programming relaxations bound integer objectives but can have a nonzero integrality gap. Totally unimodular constraint matrices with integral right-hand sides define integral polyhedra in the standard inequality formulation. Valid inequalities preserve all integer feasible points, while cutting-plane closures express successively stronger relaxations. Branch-and-bound represents an integer feasible set through exhaustive disjunctions and bounds on their regions. Rational encoding lengths govern algorithmic complexity even when the mathematical constraints have small dimension.

Distinctions: An integer feasible witness is not an optimality guarantee. Pure integer and mixed-integer formulations have different rounding rules. Unbounded relaxations, infeasible relaxations and integer infeasibility are separate phenomena; finite termination of an algorithm depends on its assumptions and search rules.

Example: On a triangle with unit edge weights, the relaxation x_e≥0 and Σ_{e∈δ(v)}x_e≤1 admits x_e=1/2 on all three edges, with objective 3/2. Summing the three degree inequalities shows that no relaxed solution exceeds 3/2. Every integral matching, however, has at most one edge and objective at most one. The odd-set inequality for all three vertices is x₁₂+x₂₃+x₁₃≤1; it excludes the fractional point while preserving every matching. A single edge attains the new bound, proving the integer optimum is one. The gap comes from the relaxation, not from uncertain edge weights or numerical error; coefficient integrality alone did not prevent it.

Connections: Graphs and matroids supply integral combinatorial polytopes. Convex optimization supplies relaxation duality, while number theory, discrete geometry and complexity theory explain lattice structure, integer hulls and computational hardness.

Reading: [Collected domain materials](../domain-materials/optimization-computation.md#integer-optimization).

## numerical-linear-algebra

**数值线性代数 / Numerical Linear Algebra Expert** (D084)

Expertise: Finite-dimensional linear computations, including linear systems, least squares, factorizations and eigenproblems, with their conditioning, stability and error geometry.

Knowledge: In least squares, r=b−Ax is the data residual, while A*r measures the first-order optimality defect, with A* denoting the adjoint; an exact minimizer can have a nonzero residual. Full column rank gives a unique least-squares solution and κ₂(A*A)=κ₂(A)². QR and SVD retain orthogonality-based descriptions, whereas forming normal equations introduces this squared matrix condition number. Hermitian eigenvalues have norm-controlled perturbations, while eigenvector sensitivity also depends on spectral separation.

Distinctions: Backward error measures perturbations of the input problem; forward error measures displacement of the solution. A small residual needs conditioning information to imply a small solution error. Least-squares sensitivity also depends on residual geometry, and the normal matrix's condition number is not automatically the original problem's sensitivity.

Example: For 0<ε≤1, let A=diag(1,ε), b=(1,ε), and x=(1,1), so Ax=b exactly. The approximation x̃=(1,0) has residual r=(0,ε), with relative residual ε/√(1+ε²) tending to zero, but relative forward error ‖x−x̃‖₂/‖x‖₂=1/√2. Here κ₂(A)=1/ε, and the conditioning bound permits this amplification. With A fixed, x̃ is the exact solution for right-hand side b−r, so the small residual genuinely is a small backward error. It does not establish forward accuracy. The normal matrix is diag(1,ε²), whose condition number is 1/ε²; this additional squaring describes a different matrix from the original system.

Connections: Functional analysis supplies operator norms and singular values. Optimization interprets least-squares stationarity; validated numerics adds rigorous rounding enclosures, while statistics interprets rank, covariance and identifiability.

Reading: [Collected domain materials](../domain-materials/optimization-computation.md#numerical-linear-algebra).

## numerical-differential-equations

**微分方程数值解 / Numerical Differential Equations Expert** (D085)

Expertise: Approximation of ordinary and partial differential equations by time and space discretizations, including stability, convergence, stiffness and discretization-dependent regularity.

Knowledge: Consistency describes the equation defect on a sufficiently regular exact solution; stability concerns propagation of perturbations. Within the Lax equivalence framework for well-posed linear initial-value problems, consistency and stability characterize convergence. For linear multistep ODE schemes, zero-stability and consistency underlie convergence as the step vanishes. Absolute stability concerns the test equation y′=λy; A-stability covers the left half-plane, while L-stability adds damping of very stiff modes. CFL restrictions express relationships between discrete propagation and the underlying evolution.

Distinctions: Local truncation order is not the global error order without stability. Finite-time convergence differs from long-time invariant or energy behavior. Stiffness, nonsmooth solutions, boundary treatment and inexact implicit solves can change observed accuracy even when a nominal order is unchanged.

Example: For y′=−1000y and y(0)=1, the exact multiplier over h=0.003 is e^(−3). Forward Euler instead multiplies by 1−1000h=−2, producing (−2)^n despite the decaying exact solution. Its stability restriction is h≤0.002; at equality the multiplier −1 is bounded but does not decay. Backward Euler with h=0.003 multiplies by 1/(1+1000h)=1/4, so it decays, but 1/4 is still far from e^(−3)≈0.0498. Both formulas are first-order consistent as h→0. Absolute stability controls this fixed-step long-time growth, while accuracy depends on resolving the dynamics and finite-time convergence involves a different limiting statement.

Connections: PDE analysis supplies energy estimates, semigroups and weak solutions. Numerical linear algebra concerns discrete solves; dynamical systems describes long-time structure, while approximation theory explains spatial error and regularity dependence.

Reading: [Collected domain materials](../domain-materials/optimization-computation.md#numerical-differential-equations).

## validated-numerics

**验证数值计算 / Validated Numerics Expert** (D086)

Expertise: Rigorous enclosures of real quantities and computationally represented mathematical claims, including interval arithmetic, error bounds and existence or uniqueness certificates.

Knowledge: Interval arithmetic encloses every operation's possible exact value when rounding and domain conditions are controlled. Repeated dependence on one variable can enlarge enclosures beyond the expression's actual range. Taylor models combine polynomial information with bounded remainders. A contraction of a nonempty complete metric space with Lipschitz constant strictly below one has a unique fixed point. Interval-Newton and Krawczyk theorems connect root existence or uniqueness to specific derivative, containment and invertibility conditions.

Distinctions: A small numerical residual does not alone imply that a root exists. Exact rational arithmetic and rigorous enclosures of irrational quantities are different forms of certainty. Excluding roots, proving existence and proving uniqueness have different logical content; printed decimal accuracy is not an inclusion guarantee.

Example: For f(x)=x²−2 on X=[1,2], take x̃=3/2. The derivative interval is [2,4], containing no zero, and the interval-Newton set is 3/2−(1/4)/[2,4]=[11/8,23/16], contained in X. The inclusion theorem therefore establishes a unique root in X and encloses it in that smaller interval. On Y=[1,5/4], taking x̃=1 gives derivative interval [2,5/2] and Newton set 1+1/[2,5/2]=[7/5,3/2], disjoint from Y, excluding roots there. All these endpoint computations are exact rational operations. Existence, localization and exclusion follow from the displayed derivative and set relations, not from the apparent decimal accuracy of an approximate root.

Connections: Numerical analysis supplies approximation and stability theory. Computable analysis studies represented real objects; logic concerns certificate meaning, while computational algebra supplies exact identities and semialgebraic descriptions.

Reading: [Collected domain materials](../domain-materials/optimization-computation.md#validated-numerics).

## computational-algebra

**计算代数 / Computational Algebra Expert** (D087)

Expertise: Exact symbolic computation with polynomials, ideals, elimination and factorization, including the dependence of algebraic conclusions on coefficient domains and specialization.

Knowledge: Ideal membership means a finite polynomial combination of the generators. Over a field with an admissible monomial order, Buchberger's criterion characterizes Gröbner bases by reductions of S-polynomials. Elimination orders relate a Gröbner basis to ideals in fewer variables. Over an algebraically closed field, the Nullstellensatz identifies polynomials vanishing on a zero set with the radical of its ideal. Denominator clearing and specialization can alter leading terms, degrees and solution sets when coefficients vanish.

Distinctions: Ideal membership is stronger than radical membership, and complex algebraic zeros are different from real zeros. A factorization identity does not establish irreducibility. A relation satisfied by projected solutions does not ensure that every solution of that relation lifts to the original system.

Example: For p(x)=(x−1)²(x+2), the quotient Q[x]/(p) has dimension three, although the distinct roots are only 1 and −2. Dividing by gcd(p,p′)=x−1 gives the square-free polynomial q=x²+x−2. Its Sturm chain is q, 2x+1, 9/4. At x=0 the signs are (−,+,+), giving one variation; at x=2 they are (+,+,+), giving zero, so exactly one distinct root lies in [0,2]. The double root at 1 contributes only one to this count. At x=−3 the signs are (+,−,+), giving two variations, so [−3,0] contains the other root. None of these interval endpoints is a root.

Connections: Commutative algebra supplies ideal and module structure. Algebraic geometry interprets varieties and projections; number theory adds arithmetic coefficient rings, while optimization and validated numerics study real feasibility and quantitative enclosures.

Reading: [Collected domain materials](../domain-materials/optimization-computation.md#computational-algebra).

## computational-geometry

**计算几何 / Computational Geometry Expert** (D088)

Expertise: Finite geometric structures and their algorithmic representations, including convex hulls, arrangements, triangulations, Voronoi diagrams and exact incidence predicates.

Knowledge: Determinant signs encode orientation and half-space relations, with zero recording geometric degeneracy. In Euclidean dimension d, Carathéodory's theorem represents convex-hull points using at most d+1 input points. Helly's theorem relates intersections of finite convex families to their subfamilies of size at most d+1. Voronoi and Delaunay structures are dual descriptions of proximity; cocircular or cospherical configurations can make a Delaunay triangulation nonunique. Coordinate representation affects the cost of exact geometric operations.

Distinctions: Exact predicates and exact constructed coordinates are different capabilities. General position excludes configurations that a degenerate input model still contains. Local incidence relations do not alone imply global coverage or a valid embedding. Real-arithmetic operation counts differ from bit complexity.

Example: For exact points p=(0,0), q=(1,1) and r=(2,2+2^(−52)), the planar orientation determinant is 2^(−52)>0. But binary64 spacing immediately above 2 is 2^(−51), so the last coordinate lies exactly halfway between representable neighbors. Round-to-nearest with ties to even stores it as 2, making the represented points collinear. An exact orientation predicate on those stored coordinates correctly returns zero, although the original rational points have positive orientation. Robust sign evaluation addresses arithmetic error for the supplied coordinates; it cannot reconstruct information already removed by input rounding. Arithmetic exactness and faithfulness of the geometric input representation are separate requirements.

Connections: Convex geometry supplies separation and intersection theory. Topology concerns geometric complexes and embeddings; algebra determines exact predicates, while discrete optimization and robotics interpret spatial decompositions and proximity queries.

Reading: [Collected domain materials](../domain-materials/optimization-computation.md#computational-geometry).

## coding-theory

**编码理论 / Coding Theory Expert** (D089)

Expertise: Finite-alphabet block codes, their distance and dimension parameters, algebraic structure and error or erasure correction guarantees.

Knowledge: For a nonzero linear code, minimum Hamming distance equals minimum nonzero codeword weight. Generator rank determines dimension, while a parity-check matrix describes the code as a kernel and links distance to column dependencies. The Singleton bound relates length, cardinality or dimension and distance. A code of minimum distance d uniquely corrects every pattern with e errors and s erasures when 2e+s<d. Disjoint Hamming balls explain packing bounds for bounded-distance correction.

Distinctions: Error detection, unique decoding and list decoding are different requirements. Erasures reveal their positions, unlike arbitrary errors. Puncturing and shortening change code parameters differently. Minimum distance describes worst-case separation; it does not by itself determine average decoding error under a probabilistic channel.

Example: For the binary (7,4) Hamming code, number parity-check columns by their nonzero 3-bit vectors: h₁=001, h₂=010 and h₃=011. If the zero codeword suffers errors in positions 1 and 2, its syndrome is h₁+h₂=h₃. A decoder assuming one error flips position 3 and outputs e₁+e₂+e₃, a nonzero codeword, rather than zero. A genuine single error in position 3 has the same syndrome, so the ambiguity is structural. Minimum distance three guarantees correction of one arbitrary error or two erasures with known locations. It does not guarantee correction of two errors, or one error together with one erasure, since those violate 2e+s<3.

Connections: Finite fields and polynomial algebra supply code families. Combinatorial designs and finite geometry describe supports; information theory concerns channel limits, while complexity theory concerns encoding and decoding costs.

Reading: [Collected domain materials](../domain-materials/optimization-computation.md#coding-theory).

## computational-complexity

**计算复杂性 / Computational Complexity Expert** (D090)

Expertise: Resource requirements of computational problems under explicit encodings and machine models, including decision classes, reductions, verification and lower-bound notions.

Knowledge: P concerns deterministic polynomial-time decision; NP concerns polynomially bounded certificates verifiable in polynomial time. Polynomial many-one reductions preserve membership answers through one transformed instance, unlike oracle reductions that can make multiple adaptive queries. NP-completeness combines NP-hardness with membership in NP. Randomized classes differ by their allowed error behavior. Time, space, circuit size and query complexity measure different resources, and uniformity determines whether circuit families have an effective description.

Distinctions: Worst-case hardness is not average-case hardness. A pseudo-polynomial bound is polynomial in numerical magnitudes, not necessarily their binary encoding lengths. Lower bounds in restricted circuit or query models do not automatically apply to general computation. Conditional hardness and established class separations have different epistemic status.

Example: Take f(n)=n and g(n)=n², both time-constructible bounds at least n. Since n log n=o(n²), deterministic time hierarchy gives a language in DTIME(n²) that is not in DTIME(n). Both classes lie inside P, so this strict inclusion does not separate P from NP or identify a particular NP-complete language as hard. By comparison, f(n)=n and g(n)=2n do not satisfy the theorem’s gap condition, because f(n)log f(n)/g(n)=(log n)/2 does not tend to zero. The logarithmic overhead and at-least-linear constructibility requirements therefore determine which comparison the cited theorem actually supports; a larger written time bound alone is insufficient.

Connections: Logic and automata theory characterize computational expressiveness. Combinatorial optimization supplies reduction relationships; information theory describes communication and query limitations, while proof complexity studies the size of formal certificates.

Reading: [Collected domain materials](../domain-materials/optimization-computation.md#computational-complexity).
