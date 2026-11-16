# Optimization and computation: collected reading

Read only the section matching the specialist's current knowledge need.

Locators identify the body passages actually read. PDF pages count from the beginning of the linked PDF; printed pagination can differ. These are references and original summaries, with no third-party full text included. Unless a source-specific reuse note states otherwise, redistribution permission has not been verified.

## convex-optimization

**凸优化 (D081)**

Reading: [Stephen Boyd and Lieven Vandenberghe — Convex Optimization](https://web.stanford.edu/~boyd/cvxbook/bv_cvxbook.pdf).

Locator: §5.2.3, Slater's condition; §5.5.3, KKT conditions for convex problems, PDF pp. 240–241 and 258.

Knowledge: For a convex objective and convex inequalities with affine equalities, Slater's relative-interior strict-feasibility condition gives strong duality, and the dual optimum is attained when the optimal value is finite. For differentiable convex programs, a point and multipliers satisfying all KKT conditions are primal and dual optimal. Constraint qualifications concern necessity and existence of such multipliers, rather than the sufficiency of an already valid KKT pair.

Scope: Finite-dimensional Lagrangian duality, Slater conditions and differentiable convex KKT statements; not arbitrary nonsmooth or infinite-dimensional extensions.

### Further reading

Reading: [Stephen Boyd and Lieven Vandenberghe — Convex Optimization](https://web.stanford.edu/~boyd/cvxbook/bv_cvxbook.pdf).

Locator: §§5.6.1–5.6.3, equations (5.56)–(5.58), PDF pp. 263–266 (printed pp. 249–252).

Knowledge: Perturb fᵢ(x)≤0 and hⱼ(x)=0 to fᵢ(x)≤uᵢ and hⱼ(x)=vⱼ, and write p*(u,v) for the resulting optimal value, allowing +∞ for infeasibility. If the base optimum is finite, strong duality holds and optimal multipliers (λ*,ν*) exist, then p*(u,v)≥p*(0,0)−λ*·u−ν*·v for every perturbation. For a convex program this is a supporting affine lower bound, so (−λ*,−ν*) is a subgradient at the origin. If p* is differentiable there, its gradient equals these negative multipliers; differentiability is an additional hypothesis.

Scope: Finite-dimensional constraint-perturbation values and the stated global lower bound/local derivative identification; no differentiability from Slater alone or symmetric upper sensitivity bound is asserted.

## nonconvex-optimization

**非凸优化 (D082)**

Reading: [Léon Bottou, Frank E. Curtis and Jorge Nocedal — Optimization Methods for Large-Scale Machine Learning, arXiv:1606.04838v1](https://arxiv.org/pdf/1606.04838v1).

Locator: §4.1, Assumptions 4.1 and 4.3; §4.3, Theorem 4.8 and discussion, PDF pp. 23–24 and 31.

Knowledge: The cited nonconvex stochastic-gradient result assumes Lipschitz objective gradients, a lower bound on the explored region, alignment of expected directions with the gradient, and a controlled direction variance. With a suitably bounded fixed step, it bounds the average expected squared gradient norm by a decaying term plus a noise-dependent floor. This is a stationarity statement, distinct from a global objective-gap guarantee.

Scope: The smooth nonconvex stationarity bound under these explicit moment and step assumptions, in the 2016 v1 preprint; not every nonconvex algorithm, saddle escape or global optimality.

### Further reading

Reading: [Léon Bottou, Frank E. Curtis and Jorge Nocedal — Optimization Methods for Large-Scale Machine Learning, arXiv:1606.04838v1](https://arxiv.org/pdf/1606.04838v1).

Locator: §4.1, Assumptions 4.1/4.3 and footnote 4, PDF pp. 22–24; equation (4.17), PDF p. 27; §4.3, Theorems 4.9–4.10 and Corollary 4.12, PDF pp. 32–33.

Knowledge: For SG updates wₖ₊₁=wₖ−αₖgₖ from a fixed initial iterate, assume a C¹ objective with L-Lipschitz gradient and a lower bound on the explored region. Conditional on the past, require constants μ_G≥μ>0 with ∇F(wₖ)·Eₖgₖ≥μ||∇F(wₖ)||², ||Eₖgₖ||≤μ_G||∇F(wₖ)||, and Varₖ(gₖ)≤M+M_V||∇F(wₖ)||² for fixed M,M_V≥0. For positive deterministic steps satisfying Σαₖ=∞ and Σαₖ²<∞, the α-weighted average of E||∇F(wₖ)||² tends to zero, implying liminfₖ E||∇F(wₖ)||²=0. The stronger limit E||∇F(wₖ)||²→0 uses the additional twice-differentiability and Lipschitz-derivative condition for w↦||∇F(w)||² in Corollary 4.12.

Scope: The cited smooth stochastic-gradient stationarity results, with vector variance understood as Eₖ||gₖ||²−||Eₖgₖ||²; no iterate convergence, saddle escape or global-minimum guarantee is asserted.

## integer-optimization

**整数与组合优化 (D083)**

Reading: [Michel X. Goemans — 18.453: Linear Programming and Polyhedral Combinatorics](https://math.mit.edu/~goemans/18453S17/polyhedral.pdf).

Locator: §3.5, Definition 3.12 and Theorem 3.12, PDF pp. 13–14.

Knowledge: A matrix is totally unimodular when every square subdeterminant belongs to {−1,0,1}. For such A and integral b, the polyhedron {x: Ax≤b, x≥0} has integral vertices. The theorem concerns the whole constraint representation and right-hand side; integral coefficients alone do not imply this property.

Scope: Total unimodularity and integrality of the cited linear relaxation; not arbitrary mixed-integer models or a complete cutting-plane and branching theory.

### Further reading

Reading: [Michel X. Goemans — 18.453: Linear Programming and Polyhedral Combinatorics, April 5, 2017](https://math.mit.edu/~goemans/18453S17/polyhedral.pdf).

Locator: §3.6, matching-polytope definition and Theorem 3.15 (Edmonds), PDF pp. 17–18.

Knowledge: For a finite undirected graph G=(V,E), the convex hull of matching incidence vectors is exactly the polytope given by x_e≥0, Σ_{e∈δ(v)}x_e≤1 for every vertex v, and Σ_{e∈E(S)}x_e≤(|S|−1)/2 for every odd-cardinality S⊆V. Here E(S) contains the edges whose two endpoints lie in S. The odd-set constraints remove fractional solutions left by degree constraints in nonbipartite graphs. On a triangle, x_e=1/2 satisfies every degree inequality but violates the S=V inequality.

Scope: The exact finite matching integer-hull description; the exponentially many displayed constraints alone do not constitute a polynomial-time algorithm, and no general integer-cut theory is claimed.

## numerical-linear-algebra

**数值线性代数 (D084)**

Reading: [Tobin A. Driscoll and Richard J. Braun — Fundamentals of Numerical Computation, online Python edition: The normal equations](https://fncbook.com/python/normaleqns/).

Locator: §3.2, Definition 3.2.1, geometric discussion; §3.2.3, Theorem 3.2.4.

Knowledge: Least-squares optimality is expressed by Aᵀ(Ax−b)=0, so a nonzero data residual can still be orthogonal to the column space and minimize its norm. For full-column-rank real matrices in the Euclidean norm, the condition number of AᵀA is the square of that of A. The text distinguishes this amplification in the normal-equation computation from sensitivity of the original least-squares problem, whose residual geometry also matters.

Scope: Real overdetermined least squares, normal-equation geometry and condition-number squaring; not the entire book's eigenproblem, rounding or sparse-matrix theory.

### Further reading

Reading: [Tobin A. Driscoll and Richard J. Braun — Fundamentals of Numerical Computation: Stability](https://fncbook.com/python/stability/) and [Conditioning of linear systems](https://fncbook.com/python/condition-number/), online Python edition.

Locator: §1.4, Observation 1.4.1 and §1.4.2, Definition 1.4.1; §2.8, Theorem 2.8.1 and §2.8.2, equations (2.8.9)–(2.8.11).

Knowledge: Conditioning describes sensitivity of the mathematical problem, whereas stability concerns additional error introduced by an algorithm. Backward error asks which perturbation of the input makes the computed output exact; small backward error can coexist with large forward error in an ill-conditioned problem. For a nonsingular square system Ax=b with b≠0, the exact residual r=b−A x̃ means x̃ solves A x̃=b−r. With A fixed, its relative right-hand-side backward error is ||r||/||b||, and a compatible induced norm gives ||x−x̃||/||x||≤κ(A)||r||/||b||. Backward stability is therefore distinct from a claim of accurate output for every A.

Scope: General backward-error meaning and normwise residual bounds for nonsingular square linear systems with right-hand-side perturbations; no componentwise or simultaneous A,b minimal backward-error formula is claimed, and floating-point residual evaluation is not an exact enclosure.

## numerical-differential-equations

**微分方程数值解 (D085)**

Reading: [Tobin A. Driscoll and Richard J. Braun — Fundamentals of Numerical Computation, online Python edition: Absolute stability](https://fncbook.com/python/absstab-diffusion/).

Locator: §11.3, Definitions 11.3.1–11.3.2 and Examples 11.3.1–11.3.2.

Knowledge: Absolute stability concerns bounded numerical behavior at fixed step size for the scalar equation y′=λy and depends on the dimensionless product ζ=τλ. Forward Euler has stability region |1+ζ|≤1, while backward Euler has region |1−ζ|≥1. This fixed-step long-time property is different from zero-stability in the limit of vanishing step size.

Scope: Linear test-equation absolute stability and the two Euler stability regions; not a general nonlinear PDE convergence theorem or all stiffness and boundary phenomena.

### Further reading

Reading: [Tobin A. Driscoll and Richard J. Braun — Fundamentals of Numerical Computation: Euler’s method](https://fncbook.com/python/euler/) and [Zero-stability of multistep methods](https://fncbook.com/python/zerostability/), online Python edition.

Locator: §6.2.1, Definition 6.2.3; §6.2.2, Theorem 6.2.1 and following finite-interval qualification; §§6.8.1–6.8.2, Theorems 6.8.1–6.8.2.

Knowledge: For a one-step formula uᵢ₊₁=uᵢ+hϕ(tᵢ,uᵢ,h), the book defines local truncation error after dividing the one-step defect by h. Consistency means this normalized defect tends to zero. If it is bounded uniformly by C h^p and |∂ϕ/∂u|≤L uniformly on a fixed time interval, all states and positive step sizes, the cited theorem gives global error O(h^p) from the exact initial value; its constant grows with the interval length. For fixed-step linear multistep methods, zero-stability is characterized by all roots of the first characteristic polynomial lying in the closed unit disk, with unit-modulus roots simple. Dahlquist equivalence ties consistency plus zero-stability to convergence; absolute stability is a separate fixed-step, long-time test-equation property.

Scope: The cited one-step finite-interval error theorem and classical linear multistep root/equivalence statements; no uniform-in-time, variable-step or general PDE convergence guarantee is asserted.

## validated-numerics

**验证数值计算 (D086)**

Reading: [Siegfried M. Rump — Verified Bounds for Singular Values, in Particular for the Spectral Norm of a Matrix and Its Inverse](https://www.tuhh.de/ti3/paper/rump/Ru10a.pdf).

Locator: §3, Theorem 3.1, Corollary 3.2 and rounding discussion/footnote 2, PDF pp. 4–6.

Knowledge: Verified singular-value bounds can incorporate both the off-diagonal defect of an approximate transformed matrix and the nonorthogonality of its approximate factors. Theorem 3.1 requires orthogonality-defect bounds strictly below one and gives enclosures that account for those defects. The paper's interval arithmetic discussion distinguishes approximate floating-point products from enclosures of the exact real product.

Scope: Rigorous matrix singular-value and spectral-norm bounds with rounding control; not a reading of general interval-Newton existence theorems or all validated numerics.

### Further reading

Reading: [Siegfried M. Rump — Verification methods: Rigorous results using floating-point arithmetic](https://www.tuhh.de/ti3/paper/rump/Ru10.pdf), Acta Numerica 19 (2010), 287–449.

Locator: §13, equations (13.1)–(13.5) and Theorems 13.1–13.2, PDF pp. 87–88; Theorem 13.3 and equation (13.8), PDF p. 89. Here Z replaces the centered box denoted X in Theorem 13.3.

Knowledge: For a continuously differentiable map f on a real box X, let J_f(X) be an interval hull enclosing all Jacobians on X. If every matrix in this hull is nonsingular, the interval-Newton set N(x̃,X)={x̃−M^(−1)f(x̃): M∈J_f(X)} with x̃∈X encloses any zero in X. Inclusion N(x̃,X)⊆X establishes existence and uniqueness there, whereas disjointness from X excludes zeros. In the centered Krawczyk formulation, 0∈Z, x̃+Z lies in the domain and S=−Rf(x̃)+(I−R J_f(x̃+Z))Z⊆int(Z) imply nonsingularity of R and of the enclosed Jacobians, and a unique zero in x̃+S. These are rigorous set-inclusion hypotheses, stronger information than a small approximate residual.

Scope: Finite-dimensional real C¹ systems, interval Jacobian hulls and the stated existence/uniqueness/exclusion tests; failed inclusion is inconclusive, and singular roots or infinite-dimensional equations need different results. Rounded evaluations require genuine enclosing interval operations.

## computational-algebra

**计算代数 (D087)**

Reading: [Bernd Sturmfels — Solving Systems of Polynomial Equations](https://math.berkeley.edu/~bernd/cbms.pdf).

Locator: Chapter 2, §2.1, standard monomials and Proposition 2.1, PDF p. 19 (printed p. 13).

Knowledge: For an ideal in Q[x₁,…,xₙ] and a fixed term order, standard monomials are those outside its initial monomial ideal. Their residue classes form a vector-space basis of the quotient. A finite complex zero set corresponds to finitely many standard monomials, whose count includes algebraic multiplicities rather than merely the number of distinct roots.

Scope: Zero-dimensional rational polynomial ideals, initial ideals and quotient bases; not all specialization, real-root certification or arbitrary-coefficient Gröbner theory.

### Further reading

Reading: [Bernd Sturmfels — Solving Systems of Polynomial Equations](https://math.berkeley.edu/~bernd/cbms.pdf).

Locator: §§1.2–1.3, gcd formula (1.4), Sturm sequence and Theorem 1.4, PDF pp. 10–11 (printed pp. 4–5); derivative notation checked in the raw PDF.

Knowledge: For a nonconstant square-free p∈Q[x], the Sturm chain starts with p and p′ and continues by taking negative polynomial remainders until the last nonzero polynomial. Let V(c) count sign changes after zero values are omitted. If a<b are not roots of p, then V(a)−V(b) counts its distinct real roots in [a,b]. Rational coefficients and rational nonroot endpoints give exact signs and hence an exact interval count. Multiplicity is separate: replacing a polynomial by p/gcd(p,p′) preserves its distinct root set and removes repeated factors.

Scope: Exact univariate rational-polynomial real-root counts with nonroot endpoints; no multiplicity count from sign variation, multivariate real-root theorem or certification from floating-point approximations alone is claimed.

## computational-geometry

**计算几何 (D088)**

Reading: [Jeff Erickson — Computational Geometry, Lecture 1: Convex Hulls](https://jeffe.cs.illinois.edu/teaching/compgeom/2008/notes/01-convexhull.pdf).

Locator: Lecture 1, §§1.1–1.2, PDF pp. 1–2; source licence footer, PDF p. 14.

Knowledge: For the finite planar point sets considered here, the convex hull separates extreme boundary vertices from points lying inside their convex envelope. The sign of an orientation determinant distinguishes clockwise and counterclockwise triples, with zero corresponding to collinearity. The lecture explicitly assumes no three collinear points for its algorithmic presentation, so its nondegenerate treatment does not automatically describe every degenerate input.

Scope: Planar convex-hull definitions, orientation and the lecture's general-position convention; not arbitrary-dimensional hulls, all degeneracy handling or full geometric complexity theory.

Reuse: PDF p. 14 states © 2008 Jeff Erickson, Creative Commons Attribution-NonCommercial-ShareAlike 3.0. This collection links the source and supplies an original summary; the PDF is not copied into the repository.

### Further reading

Reading: [Jonathan Richard Shewchuk — Adaptive Precision Floating-Point Arithmetic and Fast Robust Geometric Predicates](https://people.eecs.berkeley.edu/~jrs/papers/robustr.pdf), CMU-CS-96-140R / Discrete & Computational Geometry 18 (1997).

Locator: §2.1, arithmetic assumptions and exponent limitation, PDF pp. 7–8; §4.2, predicate definitions, PDF pp. 40–41; §4.3, adaptive error-bound discussion, PDF pp. 42–44; report reuse notice, PDF p. 4.

Knowledge: Orientation and incircle predicates depend on the exact sign of a determinant; the incircle sign also depends on the orientation of its first three points. Zero is a meaningful collinear or cocircular outcome. Near degeneracy, ordinary floating-point evaluation can report a wrong sign and produce inconsistent combinatorial decisions. The cited adaptive predicates use certified forward-error bounds to accept a sign when it is determined, with floating-point expansions retaining enough information for an exact sign otherwise. The analysis assumes binary arithmetic with exact rounding, and its fast expansion sum uses round-to-even tie breaking. It does not handle arbitrary overflow or underflow.

Scope: Robust orientation/incircle signs for represented floating-point coordinates under the stated arithmetic assumptions; exact signs do not specify all algorithmic choices on degenerate inputs, nor provide arbitrary exact intersection or irrational-coordinate constructions.

Reuse: PDF p. 4 permits duplication and distribution of this report with its copyright notice intact. This collection includes a link and original summary; the author webpage’s public-domain statement concerns the separate C code.

## coding-theory

**编码理论 (D089)**

Reading: [David J. C. MacKay — Information Theory, Inference, and Learning Algorithms](https://www.inference.org.uk/itprnn/book.pdf).

Locator: Chapter 13, §§13.1–13.2, PDF pp. 218–219 (printed pp. 206–207).

Knowledge: Binary Hamming distance counts the coordinates in which two words differ, and minimum code distance is the smallest pairwise codeword distance. It yields a worst-case unique-correction radius floor((d−1)/2). For linear codes, translation by a codeword preserves pairwise distances, allowing nonzero word weights to describe distances from the zero word; the text distinguishes worst-case distance guarantees from performance under a noisy channel.

Scope: Binary block-code distance, linear-code weight distributions and worst-case correction; not every algebraic code family, erasure model or decoder complexity result.

Reuse: PDF states © Cambridge University Press 2003: on-screen viewing permitted, printing not permitted. Link and original summaries only; no Creative Commons licence is claimed.

### Further reading

Reading: [David J. C. MacKay — Information Theory, Inference, and Learning Algorithms, version 7.2, March 28, 2005](https://www.inference.org.uk/itprnn/book.pdf).

Locator: §13.3, perfect-code definition and equation (13.2), PDF p. 220; “The Hamming codes,” PDF p. 222 (printed pp. 208 and 210).

Knowledge: For r≥2, a binary Hamming code has a parity-check matrix H whose columns are exactly the 2^r−1 nonzero vectors of F₂^r. Distinct columns give distinct nonzero syndromes for every single-bit error, allowing unique correction. Because the columns include a coordinate basis, H has rank r, so length N=2^r−1 and dimension K=N−r. Zero or repeated columns are absent, excluding codeword weights one and two; columns u,v,u+v give a weight-three word, so the minimum distance is three. Its radius-one spheres are disjoint and (N+1)2^K=2^N, making the family perfect.

Scope: Binary Hamming codes with r≥2 and exact single-error correction/perfectness; no arbitrary multiple-error correction, capacity-achieving behavior or general algebraic-code family is asserted.

## computational-complexity

**计算复杂性 (D090)**

Reading: [Sanjeev Arora and Boaz Barak — Computational Complexity: A Modern Approach, January 2007 Internet draft](https://theory.cs.princeton.edu/complexity/book.pdf).

Locator: §2.1, Definition 2.1; §2.2, Definition 2.7, PDF pp. 56 and 59 (2007 draft).

Knowledge: NP describes decision languages whose membership has polynomial-length certificates verified by a polynomial-time Turing machine. A polynomial-time many-one reduction maps every input to one target input while preserving membership in both directions. NP-hardness requires such reducibility from every NP language, whereas NP-completeness additionally requires membership in NP.

Scope: Certificate-based NP and polynomial many-one reducibility/hardness/completeness; not established P-versus-NP separation or all circuit, randomized and average-case complexity.

Reuse: Title page says not to reproduce or distribute without the authors' permission. Link and original summary only; no redistribution licence is claimed.

### Further reading

Reading: [Sanjeev Arora and Boaz Barak — Computational Complexity: A Modern Approach, January 2007 Internet draft](https://theory.cs.princeton.edu/complexity/book.pdf).

Locator: §1.2, Remark 1.5 (time-constructible bounds), PDF p. 33; §3.1, time-constructibility definition and Theorem 3.1, PDF p. 82 (2007 draft, printed pp. 17 and 66).

Knowledge: For deterministic Turing-machine time, the hierarchy theorem uses time-constructible bounds f(n),g(n)≥n, following the book’s running-time convention. If f(n)log f(n)=o(g(n)), then DTIME(f)⊊DTIME(g). In §3.1, time constructibility means that on unary input 1^n a Turing machine can write 1^{f(n)} in O(f(n)) time. Additional asymptotic time therefore yields a strict class inclusion when the stated simulation overhead is accommodated. This theorem separates deterministic time bounds and does not establish P≠NP.

Scope: The stated deterministic time hierarchy for at-least-linear constructible bounds and its logarithmic-gap condition; no sublinear-time extension, separation of P from NP, circuit lower bound or unrestricted nonconstructible-time extension is asserted.
