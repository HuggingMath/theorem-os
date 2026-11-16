Read only the expert section needed for the current mathematical question.

## probability-foundations

**概率论基础 / Probability Foundations Expert** (D071)

Expertise: Measure-theoretic probability, random variables, distributions, expectation, independence and conditioning, including the measurable-space assumptions behind these concepts.

Knowledge: A probability measure is countably additive with total mass one, and a random variable's distribution is its measurable pushforward. Integrable variables have finite absolute expectation; on probability spaces, Lq is contained in Lp for q≥p≥1. Conditional expectation of an integrable variable relative to a sub-sigma-algebra exists and is unique almost everywhere. Joint-law factorization characterizes independence. Standard Borel state spaces support the usual existence results for regular conditional distributions and disintegration.

Distinctions: Almost-everywhere equality is weaker than equality at every outcome. Uncorrelatedness does not imply independence outside special distributional families. An extended nonnegative integral and an integrable signed expectation have different finiteness requirements; conditional expectation is not automatically a pointwise conditional density.

Example: Let X be uniform on {−1,0,1} and let Y=X². Then EX=0, EY=2/3 and E[XY]=E[X³]=0, so the covariance vanishes. Nevertheless X and Y are dependent: P(Y=0)=1/3, whereas P(Y=0|X=0)=1. Even E[X|Y]=0 holds, because given Y=1 the two signs are equally likely, while Y=0 forces X=0. Thus a constant conditional mean tests only one aspect of the conditional law. In the reverse direction, E[Y|X]=X² is nonconstant. Independence would make every bounded function of X have constant conditional expectation given Y, not merely the function X itself.

Connections: Measure theory provides integration and Radon-Nikodym theory. Functional analysis explains conditional expectation as an L2 projection, while statistics and stochastic processes add model families, filtrations and temporal dependence.

Reading: [Collected domain materials](../domain-materials/probability-statistics.md#probability-foundations).

## stochastic-processes

**随机过程 / Stochastic Processes Expert** (D072)

Expertise: Families of random variables indexed by time or space, their path regularity, finite-dimensional laws and convergence as random elements of function spaces.

Knowledge: Consistent finite-dimensional laws on standard Borel state spaces admit a process law on the corresponding product sigma-algebra, without automatically giving regular paths. For a real process on an interval, a moment bound E|X_t−X_s|^p≤C|t−s|^(1+β), with p,β>0, supports a modification with Hölder exponents below β/p. Tightness and weak convergence depend on the chosen path topology; continuous-path and càdlàg spaces have different natural topologies.

Distinctions: A modification agrees almost surely at each fixed index; indistinguishability requires agreement at all indices on one probability-one event. Finite-dimensional convergence alone does not imply path-space convergence. Adaptedness, joint measurability and progressive measurability express different relationships between time and information.

Example: Let U be uniform on (0,1), and for 0≤t≤1 define X_t=1{U=t} and Y_t=0. At every fixed t, P(X_t=Y_t)=1; the two processes even have identical finite-dimensional distributions because a finite union of singleton events has probability zero. They are therefore modifications of each other. But for every outcome, X_U=1 while Y_U=0, so they are not indistinguishable. The map (t,U)↦1{t=U} is jointly measurable, yet X has a discontinuous spike in every path and Y has continuous paths. Coordinatewise almost-sure identities and pathwise identities have different quantifiers; neither joint measurability nor finite-dimensional laws remove that distinction.

Connections: Probability foundations supply extension and weak-convergence theory. Martingales describe conditional temporal structure; functional analysis supplies path spaces, and differential equations relate regularity of trajectories to dynamical evolution.

Reading: [Collected domain materials](../domain-materials/probability-statistics.md#stochastic-processes).

## stochastic-analysis

**随机分析 / Stochastic Analysis Expert** (D073)

Expertise: Stochastic integration, semimartingales, diffusion processes and stochastic differential equations, with emphasis on the information and regularity conditions underlying their calculus.

Knowledge: Brownian Itô integration is defined for suitable predictable integrands, with square-integrability giving an isometry and local square-integrability supporting a local integral. Quadratic variation produces the second-order term in Itô's formula for sufficiently smooth functions. Stratonovich integration has a different chain rule and correction relation. Globally Lipschitz coefficients with linear growth give existence and pathwise uniqueness of strong solutions to standard finite-dimensional Brownian SDEs; local hypotheses require separate nonexplosion conditions.

Distinctions: Weak solutions permit the probability space and driving noise to vary, whereas strong solutions are tied to supplied noise. Pathwise uniqueness differs from uniqueness in law. Local martingales need not be true martingales, and stochastic integrals are not ordinary pathwise Riemann integrals.

Example: For standard Brownian motion B with B₀=0 in its natural Brownian filtration (F_t), applying Itô’s formula to f(x)=x² gives B_t²=2∫₀ᵗB_s dB_s+t. The additional t comes from f″=2 and quadratic variation ⟨B⟩_t=t; an ordinary first-derivative chain rule would miss it. The stochastic integral is a true square-integrable martingale on each finite time interval because E∫₀ᵀB_s²ds=T²/2<∞. Consequently M_t=B_t²−t has constant expectation zero. Its martingale property also follows from independent centered Brownian increments: E[B_t²|F_s]=B_s²+(t−s). Thus a nonlinear function of a zero-drift process can acquire drift, while subtracting that compensator restores the martingale identity.

Connections: Martingale theory supplies integration and stopping structure. Diffusion generators connect with partial differential equations, while Feynman-Kac formulas and stochastic control involve additional analytic regularity and integrability assumptions.

Reading: [Collected domain materials](../domain-materials/probability-statistics.md#stochastic-analysis).

## martingale-theory

**鞅论 / Martingale Theory Expert** (D074)

Expertise: Conditional temporal structure relative to filtrations, including martingales, submartingales, supermartingales, stopping times and their integrability and convergence properties.

Knowledge: A martingale is adapted and integrable, with conditional expectation of a later value equal to the current value; submartingales and supermartingales replace equality by opposite inequalities. Optional stopping is valid for bounded discrete stopping times, while unbounded times require additional hypotheses. In discrete time, uniform integrability gives L1 convergence and supports stopping identities at almost-surely finite times. Lp-bounded martingales for finite 1<p<∞ converge in Lp; nonnegative supermartingales converge almost surely.

Distinctions: Almost-sure convergence alone does not imply convergence of expectations. L1 boundedness is weaker than uniform integrability. A stopping time's finiteness does not imply the integrability or closure conditions needed by every stopping theorem; local martingales form a broader class than martingales.

Example: For independent fair coin tosses, let M₀=1 and M_n=2^n if the first n tosses are all heads, otherwise M_n=0. Once zero it stays zero; conditional on survival, the next value doubles with probability 1/2. Hence M is a nonnegative martingale and EM_n=1 for every n. Almost surely a tail eventually occurs, so M_n→0, but E|M_n−0|=1 never tends to zero. For any K, choosing n with 2^n>K gives E[M_n1{M_n>K}]=1, which rules out uniform integrability. The example separates almost-sure convergence and bounded first moments from L¹ convergence and preservation of expectations at the limit.

Connections: Conditional expectation links martingales to functional analysis. Doob decompositions connect predictable drift and fluctuation; stochastic integration, sequential statistics and concentration inequalities rely on different parts of this structure.

Reading: [Collected domain materials](../domain-materials/probability-statistics.md#martingale-theory).

## markov-chains

**马尔可夫链 / Markov Chains Expert** (D075)

Expertise: Discrete-time dynamics specified by transition probabilities, including invariant distributions, communication classes, recurrence, hitting times and quantitative convergence.

Knowledge: A transition matrix preserves probability under a fixed row or column convention. A finite irreducible chain has a unique positive invariant distribution; aperiodicity additionally gives convergence to it from every starting state. For countably infinite irreducible chains, existence of an invariant probability corresponds to positive recurrence, rather than recurrence alone. Detailed balance implies invariance. For finite reversible chains, the transition operator is self-adjoint in the invariant weighted inner product, and its absolute spectral gap controls convergence.

Distinctions: Invariance describes preservation of a law, not attraction toward it. Irreducibility, aperiodicity and reversibility are separate properties. Hitting probabilities, expected hitting times and return-time distributions can have different finiteness behavior.

Example: The two-state chain with transition matrix P=[[0,1],[1,0]] is irreducible and reversible with stationary law π=(1/2,1/2). Starting at state zero, its law alternates between the two point masses, always at total-variation distance 1/2 from π. Its period is two, and its eigenvalues are 1 and −1; uniqueness of π therefore does not imply convergence. The lazy chain Q=(I+P)/2 has both rows equal to π, so it reaches π after one step from either state. Laziness removes the oscillating eigenvalue, replacing −1 by zero, while leaving the invariant law unchanged. This isolates aperiodicity from irreducibility and detailed balance.

Connections: Spectral graph theory interprets random walks through Laplacians and conductance. Potential theory describes hitting problems, while Markov-chain Monte Carlo uses invariant laws but also depends on mixing and computational cost.

Reading: [Collected domain materials](../domain-materials/probability-statistics.md#markov-chains).

## random-matrix-theory

**随机矩阵 / Random Matrix Theory Expert** (D076)

Expertise: Spectral behavior of random matrix ensembles, including empirical eigenvalue laws, extreme eigenvalues, singular values, resolvents and dimension-dependent fluctuations.

Knowledge: Classical normalized Wigner ensembles are symmetric or Hermitian, with centered independent entries above the diagonal and specified variance and tail assumptions. Semicircle laws concern their empirical spectral distributions. Marchenko-Pastur laws describe sample covariance ensembles with independent standardized entries, suitable moment conditions and a convergent dimension ratio. For a Hermitian matrix and nonreal z, the resolvent norm is at most 1/|Im z|. Edge limits and fluctuation laws generally require stronger ensemble assumptions than a bulk limiting law.

Distinctions: Convergence of empirical spectral measures can coexist with a small number of large outliers. Eigenvalue and singular-value questions coincide only in special settings. Convergence in expectation, in probability and almost surely have different content; universality does not mean independence from every normalization or tail condition.

Example: For deterministic Hermitian matrices A_n=diag(n,0,…,0), the empirical eigenvalue measure is μ_n=(1−1/n)δ₀+(1/n)δ_n. For every bounded continuous test function f, |∫f dμ_n−f(0)|≤2‖f‖∞/n, so μ_n converges weakly to δ₀. Nevertheless ‖A_n‖op=n diverges, and the first spectral moment remains one instead of converging to the limit’s zero moment. The single outlier has vanishing mass but controls the operator norm. This is a deterministic counterexample to inferring an edge bound from a bulk weak limit. It is outside the Wigner hypotheses; the cited Bai–Yin theorem supplies only its stated limsup≤2 upper bound for the specified normalized iid symmetric model.

Connections: Probability supplies concentration and limiting distributions. Operator theory explains resolvents, while statistics, free probability and high-dimensional geometry interpret covariance spectra and eigenvector behavior.

Reading: [Collected domain materials](../domain-materials/probability-statistics.md#random-matrix-theory).

## asymptotic-statistics

**渐近统计 / Asymptotic Statistics Expert** (D077)

Expertise: Large-sample behavior of estimators and tests, including asymptotic linearity, likelihood regularity, local alternatives and limiting statistical experiments.

Knowledge: Consistent roots of smooth estimating equations can be asymptotically normal when a local uniform expansion, a nonsingular limiting Jacobian and a suitable central limit theorem hold. Their covariance has the sandwich form A⁻¹BA⁻ᵀ. The delta method transfers distributional limits through differentiable maps; a vanishing derivative can make its first-order limit degenerate. Differentiability in quadratic mean underlies regular local likelihood expansions, while boundaries, moving supports or singular information can change rates and limits.

Distinctions: Pointwise asymptotic normality is weaker than uniform validity over parameters. A remainder small in probability need not be small in expectation. Local asymptotic efficiency is distinct from finite-sample risk optimality, and consistency alone supplies neither a rate nor a limiting law.

Example: For iid N(θ,1) observations with θ∈[−K,K], K>0 and |θ₀|<K, the MLE is the sample mean projected onto that interval. It is consistent because the sample mean has variance 1/n and projection cannot increase its distance from θ₀. The score is z−θ₀ and Fisher information is one. The square-root normal densities are differentiable in L², giving DQM. Also |log fθ₂(z)−log fθ₁(z)|≤(|z|+K)|θ₂−θ₁|, with a square-integrable envelope under the true law. With probability tending to one the projection is inactive, so √n(θ̂_n−θ₀)⇒N(0,1), agreeing with the regular-MLE theorem. Here consistency is separately established, and the interior-truth condition is essential to this argument.

Connections: Probability theory supplies weak convergence and contiguity. Differential geometry describes information matrices, while decision theory and semiparametric statistics interpret influence functions, nuisance directions and efficiency bounds.

Reading: [Collected domain materials](../domain-materials/probability-statistics.md#asymptotic-statistics).

## mathematical-statistics

**数理统计 / Mathematical Statistics Expert** (D078)

Expertise: Finite-sample inference under statistical models, including sufficiency, estimation risk, hypothesis testing, confidence procedures and decision-theoretic comparisons.

Knowledge: In dominated models, the factorization criterion characterizes sufficiency under the usual measurability conditions. Conditional averaging can reduce convex-loss risk when it defines a parameter-independent procedure; completeness together with sufficiency yields uniqueness of unbiased estimators and minimum-variance conclusions under the relevant moment assumptions. The Neyman-Pearson lemma characterizes most-powerful tests for simple hypotheses, allowing randomization at a likelihood-ratio boundary. Confidence coverage and test level quantify over repeated sampling under each stated parameter.

Distinctions: Unbiasedness is not the same as minimum risk, and admissibility is not the same as minimaxity. A posterior probability and frequentist coverage use different probability statements. Composite null hypotheses and nuisance parameters require uniformity absent from a simple-versus-simple testing theorem.

Example: For n≥2 independent Bernoulli(θ) observations, X₁ is an unbiased estimator of θ with squared-error risk θ(1−θ). The sum T=ΣX_i is sufficient, and symmetry gives E[X₁|T]=T/n, whose risk is θ(1−θ)/n. Improvement is strict for 0<θ<1 and vanishes at the endpoints. Conditioning instead on X₂ gives E_θ[X₁|X₂]=θ. Although that random variable has zero risk under each fixed θ, it does not define an available estimator: its value requires the unknown parameter. Sufficiency prevents this dependence when the conditional average is expressed as a statistic. Risk comparison and the existence of one procedure shared across the model are separate requirements.

Connections: Probability foundations define likelihoods and conditional laws. Convexity explains risk comparisons; information theory supplies divergence bounds, while asymptotic statistics studies limiting approximations to these finite-sample objects.

Reading: [Collected domain materials](../domain-materials/probability-statistics.md#mathematical-statistics).

## information-theory

**信息论 / Information Theory Expert** (D079)

Expertise: Entropy, relative entropy, mutual information and channel limits, encompassing both finite-alphabet distributions and measure-theoretic formulations.

Knowledge: Finite-alphabet entropy uses the convention 0 log 0=0. Relative entropy is nonnegative and becomes infinite when the first law assigns mass outside the support of the second. Mutual information is relative entropy between a joint law and the product of its marginals. Data processing holds along a Markov chain. Channel capacity is a supremum of mutual information under the stated input constraints; operational coding interpretations depend on channel assumptions and asymptotic error criteria.

Distinctions: Differential entropy can be negative and changes under coordinate scaling, unlike discrete entropy's basic nonnegativity. Mutual information is invariant under measurable isomorphisms. A single-letter capacity expression does not itself state a finite-blocklength guarantee, and zero-probability events matter to divergence finiteness.

Example: For a binary symmetric channel with crossover probability ε, a Bernoulli(p) input produces output-one probability q=ε+(1−2ε)p. Thus I(X;Y)=H₂(q)−H₂(ε), and the entropy bound H₂(q)≤1 gives capacity C=1−H₂(ε), attained by a uniform input. At ε=1/4, C≈0.188722 bits per use; rates strictly below this admit arbitrarily small maximal block error for sufficiently long codes. The uncoded bit error remains 1/4, so capacity does not describe uncoded reliability. At ε=1/2, output and input are independent and C=0. At ε=1, deterministic bit complementation is invertible and C=1. A high crossover probability is therefore not by itself an information-loss ordering.

Connections: Coding theory studies constructions and decoding; statistics uses information inequalities for testing and estimation. Convex analysis describes variational formulas, and large deviations relates relative entropy to rare-event rates.

Reading: [Collected domain materials](../domain-materials/probability-statistics.md#information-theory).

## statistical-learning-theory

**统计学习理论 / Statistical Learning Theory Expert** (D080)

Expertise: Statistical guarantees for learning from data, including generalization, excess risk, capacity, stability and the effect of sampling assumptions.

Knowledge: For bounded loss and independent identically distributed samples, finite hypothesis classes admit uniform deviations controlled by class size, sample size and confidence. VC dimension characterizes distribution-free learnability of binary classes in standard measurable settings. Rademacher complexity describes richer loss classes, while algorithmic stability depends on the actual learning rule. PAC-Bayesian bounds compare posterior and prior distributions over hypotheses, with sample-independent priors or additional corrections for dependence.

Distinctions: Small training error does not imply small population risk. Approximation, optimization and estimation errors are separate contributions to excess risk. Realizable and agnostic learning have different guarantees; distribution-free sample complexity is distinct from computational tractability, and dependent data do not inherit iid bounds unchanged.

Example: Consider thresholds h_a(x)=1{x≥a} on the real line. On m distinct points x₁<⋯<x_m, only m+1 labelings occur: a string of zeros followed by ones, with the transition at any gap or outside the sample. A single point is shattered, but two ordered points cannot receive labels (1,0), so the VC dimension is one. The parameter a ranges over infinitely many values, yet the growth function is only m+1 rather than 2^m. An infinite-class cardinality bound is therefore uninformative while VC bounds remain applicable under their iid binary-loss assumptions. This combinatorial fact establishes sample-capacity control, independently of any claim about numerical optimization or finite-sample perfect prediction.

Connections: Empirical-process theory supplies uniform convergence. Information theory describes lower bounds and information-dependent guarantees; optimization concerns the learner's numerical output, while statistics provides risk, identifiability and model assumptions.

Reading: [Collected domain materials](../domain-materials/probability-statistics.md#statistical-learning-theory).
