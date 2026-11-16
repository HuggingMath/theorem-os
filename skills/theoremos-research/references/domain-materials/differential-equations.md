# Differential equations and dynamics: collected reading

Read the relevant section for subject knowledge. These are original summaries of identified passages, with scoped reading locations. Primary texts retain their own terms; full third-party documents stay outside the Skill. PDF page counts start at the first page of the downloaded file and can differ from printed page numbers.

## ordinary-differential-equations

**常微分方程专家 / Ordinary Differential Equations Expert** (D051)

Reading: [Gerald Teschl — Ordinary Differential Equations and Dynamical Systems — author preliminary version](https://www.mat.univie.ac.at/~gerald/ftp/book-ode/ode.pdf)

Locator: §2.2, Theorem 2.2; printed p. 38, PDF p. 49.

Knowledge: The stated finite-dimensional initial-value theorem has a continuous vector field on an open time-state domain. Local Lipschitz regularity in the state, uniform with respect to time, gives a unique local C¹ solution. The solution interval is part of the conclusion.

Scope: Local finite-dimensional initial-value theory; these passages do not establish global continuation or boundary-value solvability.

### Further reading

Reading: [Gerald Teschl — Ordinary Differential Equations and Dynamical Systems — author preliminary version](https://www.mat.univie.ac.at/~gerald/ftp/book-ode/ode.pdf)

Locator: §2.6, Theorem 2.13, Corollaries 2.15–2.16 and Theorem 2.17; printed pp. 51–53, PDF pp. 62–64.

Knowledge: Local uniqueness gives a unique maximal solution on an open interval. A finite endpoint of that interval forces the time-state graph to leave every compact subset admissible in the vector-field domain; on the full time-state space this gives the finite-time blow-up alternative. For a continuous locally Lipschitz vector field on R × Rⁿ, an at-most-linear state-growth bound, uniform on each bounded time interval, ensures existence for all real times. Smoothness of the vector field by itself does not give that growth bound.

Scope: Finite-dimensional continuation in an open domain and the stated sufficient linear-growth condition; the domain boundary and escape to infinity are distinct obstructions.

## elliptic-equations

**椭圆型方程专家 / Elliptic Equations Expert** (D052)

Reading: [John K. Hunter — Notes on Partial Differential Equations — revised 18 June 2014](https://www.math.ucdavis.edu/~hunter/pdes/pde_notes.pdf)

Locator: §4.7, Theorems 4.20–4.22; printed pp. 103–105, PDF pp. 109–111.

Knowledge: The real Hilbert-space Lax–Milgram statement assumes a bounded coercive bilinear form and a bounded linear functional. Its variational solution satisfies the identity against every test vector. The elliptic form may need a lower-order shift to become coercive; weak solvability and extra regularity remain separate topics.

Scope: Linear second-order uniformly elliptic Dirichlet problems under the stated coefficient and function-space assumptions.

### Further reading

Reading: [John K. Hunter — Notes on Partial Differential Equations — revised 18 June 2014](https://www.math.ucdavis.edu/~hunter/pdes/pde_notes.pdf)

Locator: §§4.11–4.12, equations (4.34)–(4.35), Theorems 4.27–4.31; printed pp. 110–116, PDF pp. 116–122.

Knowledge: For the stated uniformly elliptic divergence-form operator, C¹ coefficients and L² forcing give H² regularity on each subdomain compactly contained in the interior. Cᵏ⁺¹ coefficients and Hᵏ forcing give the corresponding local Hᵏ⁺² gain. Regularity up to the boundary additionally uses a smooth boundary and the homogeneous Dirichlet trace: the H² theorem assumes a bounded C² domain and coefficients C¹ up to its boundary. Interior regularity does not imply the same regularity at a nonsmooth boundary.

Scope: Linear uniformly elliptic divergence-form Sobolev regularity with the cited data and boundary assumptions; no general Schauder or nonlinear elliptic theorem.

## parabolic-equations

**抛物型方程专家 / Parabolic Equations Expert** (D053)

Reading: [John K. Hunter — Notes on Partial Differential Equations — revised 18 June 2014](https://www.math.ucdavis.edu/~hunter/pdes/pde_notes.pdf)

Locator: §§6.2–6.3, Assumption 6.1, Definition 6.2 and Theorem 6.3; printed pp. 178–181, PDF pp. 184–187.

Knowledge: The weak evolution space combines square-integrable H₀¹ spatial values with a square-integrable H⁻¹ time derivative. These conditions admit a continuous L² representative, giving meaning to the initial trace. Existence and the energy estimate depend on the stated coefficients, forcing, initial data and time horizon.

Scope: Linear parabolic initial-boundary-value problems and energy-space meaning; no general nonlinear or all-time decay claim.

### Further reading

Reading: [John K. Hunter — Notes on Partial Differential Equations — revised 18 June 2014](https://www.math.ucdavis.edu/~hunter/pdes/pde_notes.pdf)

Locator: §6.6, equations (6.28)–(6.31), Theorems 6.8–6.9; printed pp. 188–190, PDF pp. 194–196.

Knowledge: On a bounded spatial domain, the homogeneous Dirichlet problem uₜ = Δu − f(u) with L² initial data has the stated unique weak solution on every finite time horizon when f has odd degree 2p−1≥1 and positive leading coefficient. Its energy class includes C([0,T];L²), L²(0,T;H₀¹) and L²ᵖ in space-time. Weak convergence alone does not identify a nonlinear limit f(u); the accompanying compactness statement supplies strong L² subsequences from spatial compactness and suitable time-derivative bounds. The dissipative sign is substantive: opposite-sign reaction terms can produce finite-time blow-up.

Scope: The specific dissipative polynomial reaction-diffusion problem and the stated compactness hypotheses; no arbitrary reaction-growth, regularity or uniform long-time bound.

## hyperbolic-equations

**双曲型方程专家 / Hyperbolic Equations Expert** (D054)

Reading: [John K. Hunter — Notes on Partial Differential Equations — revised 18 June 2014](https://www.math.ucdavis.edu/~hunter/pdes/pde_notes.pdf)

Locator: §§7.1–7.3, energy identity, Assumption 7.1 and Definition 7.2; printed pp. 211–214, PDF pp. 217–220.

Knowledge: The wave equation has a local energy density and spatial flux. The homogeneous Dirichlet setting gives conservation of total energy for the sufficiently regular calculation. A weak solution carries both displacement and velocity initial data; the general spatial operator has symmetry, uniform ellipticity and time-regularity hypotheses.

Scope: Linear wave equations and weak hyperbolic evolution; nonlinear shock entropy selection is outside these passages.

### Further reading

Reading: [David I. Ketcheson, Randall J. LeVeque and Mauricio J. del Razo — Riemann Problems and Jupyter Solutions / Riemann Problems and Their Solutions: Burgers' equation](https://www.clawpack.org/riemann_book/html/Burgers.html)

Locator: Sections “Shock solution,” “Rarefaction solution,” “An unphysical weak solution,” “The entropy condition” and “Convexity.”

Knowledge: For the scalar Burgers flux f(q)=q²/2, a jump between distinct constant states has Rankine–Hugoniot speed (qₗ+qᵣ)/2. That conservation condition alone also admits expansion shocks as weak solutions. The admissible Riemann solution is a compressive shock when qₗ>qᵣ and a rarefaction when qₗ<qᵣ; the entropy condition therefore adds information to the weak equation. The source distinguishes this single-wave strictly convex setting from nonconvex fluxes with composite wave patterns.

Scope: One-dimensional scalar Burgers Riemann data and its entropy distinction; no general entropy existence/uniqueness theorem for systems or several dimensions.

## dynamical-systems

**动力系统专家 / Dynamical Systems Expert** (D055)

Reading: [Gerald Teschl — Ordinary Differential Equations and Dynamical Systems — author preliminary version](https://www.mat.univie.ac.at/~gerald/ftp/book-ode/ode.pdf)

Locator: §§6.5–6.6, definitions and Theorems 6.10, 6.13–6.14; printed pp. 198–202, PDF pp. 209–213.

Knowledge: Lyapunov stability quantifies persistence inside neighborhoods; asymptotic stability also requires local convergence. The linearization statement assumes a C¹ vector field and strictly negative real parts for every Jacobian eigenvalue. Lyapunov and invariance conclusions depend on the stated neighborhood and function hypotheses.

Scope: Local stability for finite-dimensional flows; no global attractor classification or general treatment of chaos.

### Further reading

Reading: [Gerald Teschl — Ordinary Differential Equations and Dynamical Systems — author preliminary version](https://www.mat.univie.ac.at/~gerald/ftp/book-ode/ode.pdf)

Locator: §6.3, Lemmas 6.6–6.8; printed pp. 194–195, PDF pp. 205–206.

Knowledge: A forward orbit contained in a compact subset of the phase domain has a nonempty, compact, connected omega-limit set. Its distance to that set tends to zero, which is a statement about attraction to a set rather than convergence to one equilibrium. Nonempty compact invariant sets contain minimal compact invariant subsets. Without the compact-orbit hypothesis a complete trajectory can have an empty limit set, so completeness and precompactness carry different information.

Scope: Finite-dimensional continuous flows under the stated phase-domain compactness; no uniform basin, global-attractor existence or chaos classification.

## ergodic-theory

**遍历论专家 / Ergodic Theory Expert** (D056)

Reading: [Terence Tao — 254A, Lecture 8: The mean ergodic theorem — 30 January 2008](https://terrytao.wordpress.com/2008/01/30/254a-lecture-8-the-mean-ergodic-theorem/)

Locator: “Hilbert space formulation,” Theorem 2 and Corollary 1.

Reading: [Terence Tao — 254A, Lecture 9: Ergodicity — 4 February 2008](https://terrytao.wordpress.com/2008/02/04/254a-lecture-9-ergodicity/)

Locator: “The pointwise ergodic theorem,” Theorem 2; “Ergodicity,” Theorem 3.

Knowledge: The L² mean theorem describes projection onto invariant functions. The L¹ pointwise theorem identifies the almost-everywhere limit with conditional expectation on the invariant sigma-algebra. In an ergodic system invariant measurable functions are constant almost everywhere, so that limit becomes the space integral.

Scope: The lectures initially assume invertible probability-preserving transformations and a countably generated sigma-algebra. Norm convergence, pointwise convergence and quantitative mixing rates are distinct.

### Further reading

Reading: [Terence Tao — 254A, Lecture 12: Weakly mixing systems — 21 February 2008](https://terrytao.wordpress.com/2008/02/21/254a-lecture-12-weakly-mixing-systems/)

Locator: “Mixing functions,” Definitions 2–3 and Corollary 1; “Mixing systems,” Exercises 9 and 13, Proposition 1 and Corollary 2.

Knowledge: Strong mixing requires decay of correlations; weak mixing requires Cesàro decay of their absolute values, a stronger requirement than cancellation in the ordinary ergodic average. In the lecture’s probability-preserving setting, weak mixing is equivalent to ergodicity of the Cartesian-square system, and to preservation of ergodicity when taking a product with any ergodic system. An irrational circle rotation is ergodic but has nondecaying eigenfunction correlations. For bounded functions and distinct nonzero integer shifts, Proposition 1 gives L² decay of the multiple Cesàro average when at least one function has zero mean.

Scope: Invertible probability-preserving systems and the lecture’s measurable-space conventions; these conclusions give neither a mixing rate nor pointwise convergence of every multiple average.

## bifurcation-theory

**分岔理论专家 / Bifurcation Theory Expert** (D057)

Reading: [Gerald Teschl — Ordinary Differential Equations and Dynamical Systems — author preliminary version](https://www.mat.univie.ac.at/~gerald/ftp/book-ode/ode.pdf)

Locator: §6.5, equations (6.31)–(6.33), printed p. 200 / PDF p. 211; §7.2, printed pp. 219–220 / PDF pp. 230–231.

Knowledge: The scalar families distinguish pitchfork, transcritical and saddle-node behavior by parameter-dependent equilibrium structure. The implicit-function discussion places a degeneracy condition on changes of local equilibrium count. The Liénard-family discussion describes the appearance of an attracting periodic orbit in a planar example.

Scope: Introductory finite-dimensional prototypes; these passages are not a general Hopf theorem or an infinite-dimensional bifurcation theory.

### Further reading

Reading: [Yuri A. Kuznetsov — Andronov-Hopf bifurcation — Scholarpedia 1(10):1858 (2006), revision 90964](http://www.scholarpedia.org/article/Andronov-Hopf_bifurcation)

Locator: “Definition,” “Two-dimensional Case,” conditions (AH.1)–(AH.2), “Multi-dimensional Case” and “First Lyapunov Coefficient.”

Knowledge: The generic local Hopf setting has a smooth one-parameter equilibrium family and a simple eigenvalue pair ±iω₀ with ω₀>0. Its real part crosses zero with nonzero parameter derivative, and the first Lyapunov coefficient is nonzero; in higher dimension all remaining eigenvalues have nonzero real parts. The sign of that coefficient distinguishes the stable supercritical and unstable subcritical cycles on the two-dimensional center manifold. Stability in the full phase space also depends on the transverse stable and unstable directions. An imaginary eigenvalue pair alone does not establish this generic bifurcation.

Scope: Local generic finite-dimensional Hopf behavior and its stated nondegeneracy conditions; the normal-form radius is expressed in transformed coordinates and parameter.

## calculus-of-variations

**变分法专家 / Calculus of Variations Expert** (D058)

Reading: [Daniel Liberzon — Calculus of Variations and Optimal Control Theory — preliminary lecture-note version, 9 August 2011](https://liberzon.csl.illinois.edu/teaching/cvoc.pdf)

Locator: §§2.2–2.3, especially §2.3.1; printed pp. 26–30, PDF pp. 36–40.

Knowledge: The basic fixed-endpoint problem uses C¹ curves and an integral functional. Weak and strong extrema refer to different norms on perturbations. Euler–Lagrange stationarity is a first-order necessary condition in this setting, distinct from second-order or sufficient conditions.

Scope: Classical smooth variational problems; the inspected passages do not supply general Sobolev direct-method or relaxation theory.

### Further reading

Reading: [John K. Hunter and Bruno Nachtergaele — Applied Analysis, Chapter 8: Bounded Linear Operators on a Hilbert Space](https://www.math.ucdavis.edu/~hunter/book/ch8.pdf)

Locator: §8.6, Theorems 8.46 and 8.48–8.50 and the reflexive-Banach extension; printed pp. 209–211, PDF pp. 23–25.

Knowledge: A real-valued weakly lower semicontinuous functional attains its infimum on a nonempty weakly closed bounded subset of a Hilbert space. For convex functionals, norm lower semicontinuity supplies weak lower semicontinuity; norm-closed convex constraints are weakly closed. Coercivity replaces an a priori bounded feasible region by bounding relevant sublevel sets. On a convex feasible set, strict convexity gives uniqueness, while convexity alone does not. The source extends the convex existence statements to reflexive Banach spaces; these existence assumptions are distinct from Euler–Lagrange necessity.

Scope: Abstract convex minimization and weak compactness; no claim that an arbitrary nonconvex Sobolev integrand is weakly lower semicontinuous.

## optimal-control

**最优控制专家 / Optimal Control Expert** (D059)

Reading: [Daniel Liberzon — Calculus of Variations and Optimal Control Theory — preliminary lecture-note version, 9 August 2011](https://liberzon.csl.illinois.edu/teaching/cvoc.pdf)

Locator: §4.1.1, printed pp. 81–82 / PDF pp. 91–92; §5.1.4, printed pp. 132–133 / PDF pp. 142–143.

Knowledge: The stated maximum principle supplies a costate and a nontrivial multiplier, canonical equations and Hamiltonian maximization for its regular autonomous, free-time, fixed-endpoint formulation. These are necessary conditions. A separate HJB verification result assumes a C¹ function, the terminal condition and an admissible control attaining the required minimum to give sufficiency.

Scope: The specific smooth formulations in these preliminary notes; an arbitrary maximum-principle extremal is not asserted to be optimal.

### Further reading

Reading: [Daniel Liberzon — Calculus of Variations and Optimal Control Theory — preliminary notes, 9 August 2011](https://liberzon.csl.illinois.edu/teaching/cvoc.pdf)

Locator: §§5.3.2–5.3.3, equations (5.34)–(5.38); printed pp. 140–142, PDF pp. 150–152.

Reading: [Michael G. Crandall, Hitoshi Ishii and Pierre-Louis Lions — User's Guide to Viscosity Solutions of Second Order Partial Differential Equations — arXiv math/9207212v1 / Bulletin AMS 27 (1992)](https://arxiv.org/pdf/math/9207212)

Locator: §2, Definition 2.2 and Remarks 2.3, PDF pp. 10–11; §3, Theorem 3.3 and conditions (3.10), (3.13)–(3.14), PDF pp. 17–18.

Knowledge: Viscosity subsolutions and supersolutions use smooth functions touching from above and below, so they do not require a classical gradient of the value function. The PDE’s sign convention affects those inequalities. Liberzon explains this meaning for finite-horizon HJB, while leaving a full uniqueness hypothesis list to references. The separate Crandall–Ishii–Lions comparison theorem is for bounded-domain equations with proper F, a uniform positive monotonicity constant in the solution value as in (3.13), and the matrix/modulus compatibility condition (3.14), together with ordered boundary data. Continuity or the label “HJB” alone does not supply those conditions.

Scope: Nonsmooth first-order HJB meaning and a separately specified second-order Dirichlet comparison theorem; they are not a universal value-function verification theorem.

## integral-equations

**积分方程专家 / Integral Equations Expert** (D060)

Reading: [John K. Hunter and Bruno Nachtergaele — Applied Analysis, Chapter 8: Bounded Linear Operators on a Hilbert Space](https://www.math.ucdavis.edu/~hunter/book/ch8.pdf)

Locator: §8.3, Example 8.16 and Theorem 8.18; printed pp. 194–195, PDF pp. 8–9.

Reading: [John K. Hunter — Notes on Partial Differential Equations — revised 18 June 2014](https://www.math.ucdavis.edu/~hunter/pdes/pde_notes.pdf)

Locator: §4.B.2, Theorems 4.46–4.50; printed pp. 123–124, PDF pp. 129–130.

Knowledge: The integral-operator example relates its Hilbert adjoint to the conjugate-transposed kernel. For a closed range, right-hand-side compatibility is governed by the adjoint kernel. Compact perturbations preserve Fredholm index, giving identity plus a compact operator index zero and a corresponding alternative; this is more specific than arbitrary bounded inversion.

Scope: Bounded Hilbert-space operators and Fredholm compatibility. General Volterra kernels, first-kind regularization and all kernel mapping properties are outside this first collection.

### Further reading

Reading: [Gerald Teschl — Ordinary Differential Equations and Dynamical Systems — author preliminary version](https://www.mat.univie.ac.at/~gerald/ftp/book-ode/ode.pdf)

Locator: §5.3, coefficient assumptions (5.45), printed p. 153 / PDF p. 164; §5.4, equations (5.64)–(5.66), Lemmas 5.9–5.10 and Theorem 5.11, printed pp. 158–160 / PDF pp. 169–171.

Knowledge: For the regular finite-interval Sturm–Liouville problem, p is C¹, q and r are continuous, p and r are positive, and the real separated boundary conditions are part of the operator. Away from eigenvalues, its resolvent is an integral operator with a continuous Green kernel and is compact in the weighted L² geometry; for real resolvent parameters it is symmetric. The corresponding eigenvalues are discrete and simple, with normalized eigenfunctions giving the stated weighted-norm expansion. Kernel symmetry, compactness and solvability therefore carry hypotheses beyond merely writing an integral expression.

Scope: Regular Sturm–Liouville Green operators and their separated-boundary spectral statement; no singular-endpoint, arbitrary-kernel or first-kind regularization theorem.

## Source terms and versions

Teschl’s first-page notice forbids editing or reposting the AMS-authorized preprint without written permission. Liberzon permits browsing and downloading his preliminary copy and warns that the published book contains corrections. The inspected Hunter chapters and Tao articles did not establish a general redistribution licence. This collection links the originals and supplies its own summaries; it does not redistribute their full text.

For the further readings, Kuznetsov's Scholarpedia footer states CC BY-NC-SA 3.0. The [Clawpack book README](https://raw.githubusercontent.com/clawpack/riemann_book/master/README.md) and its linked text licence state CC BY-NC-ND 4.0 for notebook text, with a separate BSD 3-Clause licence for code. Crandall–Ishii–Lions credits © 1992 American Mathematical Society on PDF p. 1; a broader redistribution permission was not established here. The notes give independently written mathematical background and links to those sources.
