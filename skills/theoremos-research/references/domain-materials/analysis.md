# Analysis: collected reading

Read the relevant section for subject knowledge. These original summaries retain the conditions of the inspected passages. PDF pages start at the first page of the downloaded file; printed page numbers may differ. Third-party full texts remain outside the Skill. Teschl's online edition expressly permits personal online use only; the links below do not grant redistribution rights.

## real-analysis

**实分析专家 / Real Analysis Expert** (D041)

Reading: [Jiří Lebl — Basic Analysis I: Introduction to Real Analysis, Volume I — version 6.3](https://www.jirka.org/ra/realanal.pdf)

Locator: §6.1.2, Definition 6.1.6 and Proposition 6.1.7, printed/PDF p. 229; §6.2.1, Theorem 6.2.2, printed/PDF p. 235.

Knowledge: Uniform convergence uses one convergence index for every point in the domain, whereas pointwise convergence permits that index to depend on the point. Uniform convergence implies pointwise convergence, but the converse fails. A uniform limit of continuous real functions on a subset of R is continuous on that subset.

Scope: Function-sequence convergence and continuity of uniform limits; interchange of derivatives or integrals needs separate hypotheses and readings.

### Further reading

Reading: [Jiří Lebl — Basic Analysis I: Introduction to Real Analysis, Volume I — version 6.3](https://www.jirka.org/ra/realanal.pdf)

Locator: §6.2.3, Theorem 6.2.10 and its unbounded-interval counterexample; printed/PDF pp. 239–240.

Knowledge: Let fn be continuously differentiable real functions on a bounded interval I. If their derivatives converge uniformly to g and fn(c) converges at one point c ∈ I, then fn converges uniformly on I to a continuously differentiable function f with f′ = g. The single-point condition controls the additive constants. Boundedness of I contributes to uniform convergence of the functions: on R, fn(x) = x/n has uniformly convergent derivatives and a convergent value at zero, but its function convergence is only pointwise.

Scope: Differentiation of limits under uniform derivative convergence, continuous differentiability and an anchor value on a bounded interval; arbitrary derivative limits and integration on unbounded domains need other hypotheses.

### Scalar sequences and series

Reading: [Jiří Lebl — Basic Analysis I: Introduction to Real Analysis, Volume I — version 6.3](https://www.jirka.org/ra/realanal.pdf)

Locator: §2.1.1, Theorem 2.1.10, printed/PDF pp. 55–56; §2.3.1, Definition 2.3.1 and Proposition 2.3.2, pp. 73–74; Theorem 2.3.4, pp. 75–76 and Proposition 2.3.5, pp. 76–77; §2.5.4, Propositions 2.5.13 and 2.5.15, pp. 92–93. Read from the locally collected source PDF.

Knowledge: An increasing real sequence bounded above converges to the supremum of its values; the decreasing counterpart converges to its infimum when bounded below. For a bounded real sequence, the supremum of each tail decreases and its infimum increases. Their limits define limsup and liminf, and subsequences converge to each of these two values. The tail extrema themselves need not be terms of the original sequence. For a series of nonnegative terms, its increasing partial sums converge exactly when they are bounded above. Absolute convergence of a real series implies convergence.

Scope: Scalar real sequences and real series with the stated order and boundedness assumptions. Extended-real infinite limits use a different codomain; a total formal-library expression does not remove the hypotheses of an order-limit theorem. These facts describe subject knowledge and do not select a proof method or establish a particular assignment.

## complex-analysis

**复分析专家 / Complex Analysis Expert** (D042)

Reading: [Jiří Lebl — Guide to Cultivating Complex Analysis: Working the Complex Field — version 1.10](https://www.jirka.org/ca/ca.pdf)

Locator: §2.1, Definition 2.1.1, Propositions 2.1.3–2.1.4 and Corollary 2.1.5; printed/PDF pp. 27–28.

Knowledge: Holomorphicity means complex differentiability at every point of an open subset of C. At a point, complex differentiability is equivalent to real differentiability together with the Cauchy–Riemann equations. For C¹ functions, those equations on the open domain characterize holomorphicity; existence of partial derivatives alone is not the hypothesis of this criterion.

Scope: Complex derivatives, real differentiability and the Cauchy–Riemann criterion; residues, conformal mapping and analytic continuation need further passages.

### Further reading

Reading: [Jiří Lebl — Guide to Cultivating Complex Analysis: Working the Complex Field — version 1.10](https://www.jirka.org/ca/ca.pdf)

Locator: §5.4.1, Theorem 5.4.1 (Argument principle) and the explanation of winding numbers and finite contributing sums; printed/PDF pp. 136–137.

Knowledge: For a nonzero meromorphic function f on a plane domain U and a finite piecewise C¹ cycle Γ homologous to zero in U, with no zeros or poles of f on Γ, the integral (1/(2πi))∫Γ f′/f equals the sum of zero orders weighted by winding number minus the corresponding pole sum. Only finitely many nonzero-winding terms contribute. For a positively oriented simple contour whose closed interior lies in U, this becomes the number of interior zeros minus poles, counted with multiplicity. Boundary avoidance and the homology condition belong to the theorem.

Scope: The meromorphic argument principle and its weighted counting convention; contour crossings of zeros or poles, essential singularities and numerical zero-certification error bounds are outside this addition.

## functional-analysis

**泛函分析专家 / Functional Analysis Expert** (D043)

Reading: [Gerald Teschl — Mathematical Methods in Quantum Mechanics: With Applications to Schrödinger Operators — author online edition](https://www.mat.univie.ac.at/~gerald/ftp/book-schroe/schroe.pdf)

Locator: §1.1, printed p. 37 / PDF p. 49; §1.3, Theorem 1.7, printed p. 43 / PDF p. 55.

Knowledge: A Hilbert space is an inner-product space complete in the induced norm. A closed linear subspace has an orthogonal complement that gives a unique direct-sum decomposition of every vector. The corresponding orthogonal projection selects the unique closest vector in that subspace; closedness is essential in the stated theorem.

Scope: Hilbert-space geometry and orthogonal projection; general Banach-space duality and locally convex spaces are outside these passages.

### Further reading

Reading: [Gerald Teschl — Mathematical Methods in Quantum Mechanics: With Applications to Schrödinger Operators — author online edition](https://www.mat.univie.ac.at/~gerald/ftp/book-schroe/schroe.pdf)

Locator: §0.7, Theorems 0.38–0.39 (Baire and Banach–Steinhaus); printed pp. 32–33 / PDF pp. 44–45.

Knowledge: A nonempty complete metric space cannot be a countable union of nowhere dense sets. If X is Banach, Y is normed and a family of bounded linear maps X → Y is bounded at each fixed vector of X, then their operator norms are uniformly bounded. Completeness is imposed on the input space in this theorem; the target need not be complete. The hypothesis quantifies over every input vector, not merely a chosen dense set.

Scope: The Baire theorem and uniform boundedness for Banach-space operators; Hahn–Banach duality, open mapping and locally convex spaces remain separate topics.

## harmonic-analysis

**调和分析专家 / Harmonic Analysis Expert** (D044)

Reading: [Terence Tao — Lecture Notes 1 for 247A](https://www.math.ucla.edu/~tao/247a.1.06f/notes1.pdf)

Locator: §2, “What is harmonic analysis?”, PDF pp. 1–2, especially the dense-domain operator and norm-estimate discussion on p. 2.

Knowledge: Quantitative norm estimates connect the behavior of functions with continuity properties of operators. A bounded linear operator on a dense linear subspace has a unique continuous extension when the target space is Banach. The Hilbert transform is introduced as a principal-value singular integral, so its initial domain and subsequent extension are distinct mathematical objects.

Scope: The norm-estimate viewpoint and the dense-domain extension principle; the introductory discussion does not constitute a proof of singular-integral Lᵖ boundedness or endpoint estimates.

### Further reading

Reading: [Terence Tao — Lecture Notes 1 for 247A](https://www.math.ucla.edu/~tao/247a.1.06f/notes1.pdf)

Locator: §8, weak/restricted-type definitions and the finite-support pairing, PDF pp. 27–28; Theorem 8.5 (Marcinkiewicz interpolation), PDF p. 30, with reciprocal interpolation parameters in (23) on PDF p. 29.

Knowledge: Consider a sublinear operator on finite-support simple functions, with the pairing ∫|Tf||g| finite for such test functions as in this lecture. If it has weak-type (p₀,p₀) and (p₁,p₁) bounds with 1 ≤ p₀ < p₁ < ∞, the diagonal case of Marcinkiewicz interpolation gives a strong-type (p,p) bound for p₀ < p < p₁. Writing 1/p = (1−θ)/p₀ + θ/p₁, the bound has endpoint-size factor A₀¹⁻ᶿA₁ᶿ and an additional constant depending on the exponents. This is an interior-exponent conclusion and does not promote either endpoint to strong type.

Scope: A diagonal special case of the stated Lorentz-space interpolation theorem, on its finite-support test domain; no singular-integral kernel theorem or endpoint strong estimate is asserted.

## measure-integration

**测度与积分专家 / Measure and Integration Expert** (D045)

Reading: [John K. Hunter — Measure Theory](https://www.math.ucdavis.edu/~hunter/measure_theory/measure_notes.pdf)

Locator: §§1.4–1.6, Definitions 1.2–1.9, printed pp. 3–5 / PDF pp. 7–9; §4.5, Theorem 4.22 (Fatou's lemma), printed p. 48 / PDF p. 52.

Knowledge: A measure is nonnegative and countably additive on a sigma-algebra, whereas an outer measure is defined on all subsets and satisfies monotonicity and countable subadditivity; both assign zero to the empty set. A sigma-algebra contains the whole set and is closed under complements and countable unions. For nonnegative measurable functions, Fatou's lemma bounds the integral of the pointwise lower limit by the lower limit of their integrals; pointwise convergence alone does not guarantee equality of integrals.

Scope: Measure-space foundations and this convergence inequality; signed measures, Radon–Nikodym and product-integration results are outside these excerpts.

### Further reading

Reading: [John K. Hunter — Measure Theory](https://www.math.ucdavis.edu/~hunter/measure_theory/measure_notes.pdf)

Locator: §6.8, Definition 6.22, Theorem 6.27 (Lebesgue–Radon–Nikodym) and Example 6.28; printed pp. 74–77 / PDF pp. 78–81.

Knowledge: For two positive σ-finite measures μ and ν on the same measurable space, ν has a unique decomposition into an absolutely continuous part νa and a part νs singular to μ. There is a nonnegative measurable density f, unique μ-almost everywhere, with νa(A) = ∫A f dμ for every measurable A. Absolute continuity means that μ-null sets are νa-null; singularity means that the measures are concentrated on disjoint measurable parts. The source’s counting-measure example shows why σ-finiteness cannot simply be dropped.

Scope: The positive-measure case of Lebesgue decomposition and Radon–Nikodym under σ-finiteness; signed/complex extensions, non-σ-finite generalizations and product integration remain separate topics.

## geometric-measure-theory

**几何测度论专家 / Geometric Measure Theory Expert** (D046)

Reading: [Leon Simon — Introduction to Geometric Measure Theory — 2014 Tsinghua lecture draft](https://web.stanford.edu/class/math285/ts-gmt.pdf)

Locator: Chapter 3, §1, definition (1.1) and Lemma 1.2; printed p. 69, right-hand page of PDF p. 38.

Knowledge: A countably n-rectifiable subset of Euclidean space is covered, apart from a set of zero n-dimensional Hausdorff measure, by countably many Lipschitz images of Rⁿ. Equivalently, it is covered by a Hausdorff-null exceptional set and countably many embedded C¹ n-dimensional submanifolds. The null exceptional set is part of this source's convention.

Scope: Countable rectifiability and the stated equivalent descriptions; currents, varifolds and minimal-surface regularity are not covered by this passage. The two-page PDF layout and encoded mathematical symbols were checked against the rendered page.

### Further reading

Reading: [Leon Simon — Introduction to Geometric Measure Theory — 2014 Tsinghua lecture draft](https://web.stanford.edu/class/math285/ts-gmt.pdf)

Locator: Chapter 4, §1, weight measure (1.1), printed p. 86 / PDF p. 47; §2, first variation (2.2) and stationarity (2.4), printed p. 88 / PDF p. 48; §3, monotonicity and density (3.6), (3.8)–(3.11), printed pp. 90–91 / PDF p. 49. PDF pp. 47 and 49 were additionally read as rendered two-page spreads.

Knowledge: A rectifiable varifold with positive locally integrable multiplicity carries the Radon weight measure μ = θHⁿ restricted to its rectifiable set. Its first variation against a compactly supported C¹ vector field is the integral of the tangential divergence against μ. If it is stationary in an open Euclidean region U, then μ(Bᵣ(x))/rⁿ is nondecreasing in r while the surrounding balls stay in U. Consequently its normalized n-dimensional density exists at every interior point and is upper semicontinuous.

Scope: Stationary rectifiable varifolds in Euclidean space and their weight-density structure; boundary monotonicity, integer-current compactness and general varifold convergence require other results.

## operator-theory

**算子理论专家 / Operator Theory Expert** (D047)

Reading: [Gerald Teschl — Mathematical Methods in Quantum Mechanics: With Applications to Schrödinger Operators — author online edition](https://www.mat.univie.ac.at/~gerald/ftp/book-schroe/schroe.pdf)

Locator: §2.2, equations (2.13)–(2.20), definitions of domain, symmetry, adjoint and self-adjointness; printed pp. 58–59, PDF pp. 70–71.

Knowledge: An unbounded linear operator includes its domain as part of its definition. For a densely defined operator on a complex Hilbert space, symmetry means that it is a restriction of its adjoint, while self-adjointness requires equality with the adjoint, including domains. Equality of formal expressions therefore does not by itself establish self-adjointness.

Scope: Densely defined Hilbert-space operators, adjoints and the symmetry/self-adjointness distinction; no general spectral theorem is summarized here.

### Further reading

Reading: [Gerald Teschl — Mathematical Methods in Quantum Mechanics: With Applications to Schrödinger Operators — author online edition](https://www.mat.univie.ac.at/~gerald/ftp/book-schroe/schroe.pdf)

Locator: §3.1, projection-valued measures and scalar spectral measures, printed pp. 88–89 / PDF pp. 100–101; Theorem 3.7, equation (3.49), and the domain distinction (3.50)–(3.51), printed pp. 96–97 / PDF pp. 108–109.

Knowledge: A self-adjoint operator A on a complex Hilbert space has a unique projection-valued measure PA on R with A = ∫ λ dPA(λ). These projections are countably additive in the strong operator sense. Writing μψ(E) = ⟨ψ,PA(E)ψ⟩, the operator domain consists of vectors with ∫ λ² dμψ finite. The associated form domain instead requires ∫ |λ| dμψ finite and can be larger. Thus a spectral integral for an unbounded operator includes its domain, and its quadratic form need not have the same domain.

Scope: Projection-valued spectral representation and operator/form domains for self-adjoint Hilbert-space operators; arbitrary symmetric or nonnormal operators and spectral-type classification require separate results.

## approximation-theory

**逼近论专家 / Approximation Theory Expert** (D048)

Reading: [Gerald Teschl — Mathematical Methods in Quantum Mechanics: With Applications to Schrödinger Operators — author online edition](https://www.mat.univie.ac.at/~gerald/ftp/book-schroe/schroe.pdf)

Locator: §1.7, Theorems 1.15–1.16 (Stone–Weierstrass); printed pp. 51–52, PDF pp. 63–64.

Knowledge: On a compact Hausdorff space, a real algebra of continuous functions that contains constants and separates points is dense in the uniform norm. For complex-valued functions, the corresponding statement uses a subalgebra closed under complex conjugation. Point separation alone does not replace this conjugation condition, and density gives no quantitative approximation rate.

Scope: Uniform approximation through Stone–Weierstrass; approximation rates, splines and best-approximation theory need other sources.

### Further reading

Reading: [Lloyd N. Trefethen — Approximation Theory and Approximation Practice, Chapter 10: Best Approximation — public chapter source](http://www.chebfun.org/ATAP/chap10.m)

Locator: Theorem 10.1 and its real/complex qualification, in the publicly linked chap10.m mathematical commentary, from the minimax definition through the theorem and proof discussion. The downloaded file was read as plain text.

Knowledge: For a continuous real function f on [−1,1] and an integer n ≥ 0, there is a unique polynomial p* of degree at most n minimizing the uniform error. A real polynomial p of that degree is this minimizer exactly when there are n + 2 ordered points x₀ < … < xₙ₊₁ and a sign σ ∈ {−1,1} with f(xⱼ) − p(xⱼ) = σ(−1)ʲ‖f−p‖∞. The number is at least n + 2; additional extreme points may occur. This real alternation characterization is distinct from the source’s existence/uniqueness statement for complex-valued functions.

Scope: Real minimax polynomial approximation on a compact interval and its equioscillation criterion; complex alternation rules, rational approximation, convergence rates and numerical Remez convergence need further results.

## distributions-sobolev

**广义函数与Sobolev空间专家 / Distributions and Sobolev Spaces Expert** (D049)

Reading: [John K. Hunter — Notes on Partial Differential Equations](https://www.math.ucdavis.edu/~hunter/pdes/pde_notes.pdf)

Locator: §3.1, Definitions 3.1–3.2, printed pp. 47–48 / PDF pp. 53–54; §3.3, Definitions 3.8–3.9, printed p. 51 / PDF p. 57; §3.5, Definition 3.23, printed p. 58 / PDF p. 64.

Knowledge: Distributions are continuous linear functionals on smooth compactly supported test functions with their test-function topology. Weak derivatives of locally integrable functions satisfy the integration-by-parts identity against every such test function and are determined up to almost-everywhere equality. For an open domain and 1 ≤ p ≤ ∞, Wᵏ,ᵖ requires the function and all weak derivatives through order k to lie in Lᵖ; these spaces are Banach, and Hᵏ = Wᵏ,² is Hilbert.

Scope: Distribution, weak-derivative and Sobolev-space foundations; embedding exponents, traces and boundary regularity are outside the inspected passages.

### Further reading

Reading: [John K. Hunter — Notes on Partial Differential Equations](https://www.math.ucdavis.edu/~hunter/pdes/pde_notes.pdf)

Locator: §3.7, Definition 3.25, Theorem 3.31 and Example 3.30, printed pp. 60 and 66–67 / PDF pp. 66 and 72–73; §3.8, Theorem 3.37 and its representative discussion, printed p. 70 / PDF p. 76.

Knowledge: On Rⁿ with n ≥ 2 and 1 ≤ p < n, the Sobolev conjugate is p* = np/(n−p), and W¹,ᵖ embeds continuously into Lq for p ≤ q ≤ p*. For n < p < ∞, each W¹,ᵖ class has a Hölder-continuous representative with exponent 1−n/p, vanishing at infinity, with its Hölder norm controlled by the Sobolev norm. The representative qualification respects equality almost everywhere. The endpoint p = n does not supply an L∞ embedding, as the displayed cutoff example shows.

Scope: First-order whole-space Sobolev and Morrey embeddings with their exponent ranges; embeddings on arbitrary open sets, traces, boundary regularity and the critical endpoint require other hypotheses.

## potential-theory

**位势论专家 / Potential Theory Expert** (D050)

Reading: [John K. Hunter — Notes on Partial Differential Equations](https://www.math.ucdavis.edu/~hunter/pdes/pde_notes.pdf)

Locator: §2.1, Theorems 2.1–2.2; printed pp. 20–21, PDF pp. 26–27.

Knowledge: A C² harmonic function equals its average over a ball and over that ball's boundary sphere whenever the closed ball lies inside the domain. Conversely, a continuous function with this mean-value property is smooth and harmonic in the interior. These are interior regularity statements and do not supply regular boundary behavior.

Scope: Classical harmonic functions and the mean-value characterization; capacities, fine topology and boundary solvability are outside these pages.

### Further reading

Reading: [John K. Hunter — Notes on Partial Differential Equations](https://www.math.ucdavis.edu/~hunter/pdes/pde_notes.pdf)

Locator: §2.3, Theorem 2.15 (strong maximum principle), printed p. 26 / PDF p. 32; §2.3.1, Theorems 2.17–2.18 and their qualifications, printed pp. 27–28 / PDF pp. 33–34.

Knowledge: A real harmonic C² function on a connected open set is constant if it attains a global maximum or minimum in the interior. On a bounded connected open set Ω, a harmonic function in C²(Ω) ∩ C(closure Ω) has its maximum and minimum on the boundary. Consequently fixed Poisson data −Δu = f and boundary values u = g admit at most one classical solution in this class. The boundary continuity and boundedness hypotheses belong to this conclusion; uniqueness alone supplies no existence theorem.

Scope: Classical interior and boundary maximum principles and Dirichlet uniqueness; existence on irregular boundaries, capacities, fine topology and weak-solution extensions require other material.
