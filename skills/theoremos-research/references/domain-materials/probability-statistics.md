# Probability and statistics: collected reading

Read only the section matching the specialist's current knowledge need.

Locators identify the body passages actually read. PDF pages count from the beginning of the linked PDF; printed pagination can differ. These are references and original summaries, with no third-party full text included. Unless a source-specific reuse note states otherwise, redistribution permission has not been verified.

## probability-foundations

**概率论基础 (D071)**

Reading: [Rick Durrett — Probability: Theory and Examples, fifth-edition manuscript](https://sites.math.duke.edu/~rtd/PTE/PTE5_011119.pdf).

Locator: §4.1, conditional-expectation definition, Lemma 4.1.1 and uniqueness discussion, PDF pp. 213–215.

Knowledge: For an integrable random variable X and a sub-sigma-algebra F, conditional expectation is an F-measurable random variable whose integrals agree with those of X on every F-measurable event. It is integrable, and its expected absolute value is at most E|X|. Its uniqueness is almost sure, so different versions may disagree on a null set.

Scope: Measure-theoretic conditional expectation, integrability and almost-sure uniqueness; not a reading of the entire probability text or every regular-conditional-distribution hypothesis.

### Further reading

Reading: [Rick Durrett — Probability: Theory and Examples, fifth-edition manuscript, January 11, 2019](https://sites.math.duke.edu/~rtd/PTE/PTE5_011119.pdf).

Locator: §2.5, tail and exchangeable σ-field definitions and Theorems 2.5.3–2.5.4, PDF pp. 89–90 (printed pp. 81–82).

Knowledge: For variables X₁,X₂,…, the tail σ-field is T=⋂ₙσ(Xₙ,Xₙ₊₁,…). Kolmogorov’s law gives P(A)∈{0,1} for every A∈T when the variables are independent; identical distributions are unnecessary. For an iid sequence, Hewitt–Savage applies to the larger σ-field of events invariant under every finite permutation of coordinates. Every tail event is permutation-invariant, while a permutation-invariant event need not be a tail event.

Scope: The independent-sequence tail law and iid permutation-invariance law; exchangeability of the sequence alone is not asserted to imply this zero–one conclusion.

## stochastic-processes

**随机过程 (D072)**

Reading: [Rick Durrett — Probability: Theory and Examples, fifth-edition manuscript](https://sites.math.duke.edu/~rtd/PTE/PTE5_011119.pdf).

Locator: §7.1, Brownian-motion definition and Theorems 7.1.1–7.1.2, PDF pp. 361–362 and 364.

Knowledge: Brownian motion has independent Gaussian increments with variance equal to elapsed time and has almost surely continuous paths. The text distinguishes a law on the cylinder sigma-algebra of all functions from a law on continuous-path space: the set of continuous functions is not measurable in the former construction. Continuity information on dyadic-time paths supplies the additional path-space structure in this account.

Scope: Brownian finite-dimensional laws, sample-path continuity and the distinction between cylinder and continuous-path spaces; not all path-topology tightness or càdlàg-process theory.

### Further reading

Reading: [Rick Durrett — Probability: Theory and Examples, fifth-edition manuscript, January 11, 2019](https://sites.math.duke.edu/~rtd/PTE/PTE5_011119.pdf).

Locator: End of §7.2, filtration convention, PDF p. 373; §7.3, stopping-time definition and Theorem 7.3.9, PDF pp. 374 and 376–377 (printed pp. 365–366 and 368–369).

Knowledge: For standard d-dimensional Brownian motion in the right-continuous Brownian filtration constructed in §7.2, the strong Markov property applies at stopping times. If S is almost surely finite, conditional on F_S the path (B_{S+t})_{t≥0} has Brownian law starting from B_S. Translation invariance then makes (B_{S+t}−B_S)_{t≥0} a standard Brownian motion independent of F_S. Right continuity permits the equivalent stopping-time conditions {S<t}∈F_t and {S≤t}∈F_t.

Scope: Brownian strong Markov behavior at almost surely finite stopping times in the stated filtration; no analogous conclusion at an arbitrary random time or for every Markov process is asserted.

## stochastic-analysis

**随机分析 (D073)**

Reading: [Gregory F. Lawler — Stochastic Calculus: An Introduction with Applications](https://www.math.uchicago.edu/~lawler/finbook.pdf).

Locator: §3.3, Theorem 3.3.1 (Itô's formula I) and accompanying interpretation, PDF pp. 106–107.

Knowledge: For a C² function evaluated along standard Brownian motion, Itô's formula contains both a first-derivative stochastic integral and one half of the time integral of the second derivative. This second-order term distinguishes it from the ordinary deterministic chain rule. In the stated setting, the composed derivative is a continuous adapted process, which belongs to the integral framework developed by the text.

Scope: The one-dimensional Brownian Itô formula and its regularity conditions; not a general semimartingale integral construction or all SDE existence theorems.

Reuse: Title page states © 2014 Gregory F. Lawler, all rights reserved. Link and original summary only; no redistribution licence is claimed.

### Further reading

Reading: [Gregory F. Lawler — Stochastic Calculus: An Introduction with Applications](https://www.math.uchicago.edu/~lawler/finbook.pdf).

Locator: §3.4, equation (3.19), quadratic-variation discussion and Theorem 3.4.2, PDF pp. 114–115; Theorem 3.4.3 (local form), PDF p. 116.

Knowledge: For Xₜ=X₀+∫₀ᵗRₛ ds+∫₀ᵗAₛ dBₛ, the book assumes adapted drift and volatility processes with piecewise-continuous paths in its stochastic-integral framework. Its quadratic variation is ⟨X⟩ₜ=∫₀ᵗAₛ² ds: finite-variation drift contributes no quadratic variation. For f that is C¹ in time and C² in space, Itô’s formula has drift fₜ+Rₜfₓ+(Aₜ²/2)fₓₓ and stochastic coefficient Aₜfₓ, evaluated at (t,Xₜ). The local form restricts the identity to times before the process exits the interval on which this regularity holds.

Scope: One-dimensional continuous Itô processes and the cited local formula; no jump correction, general semimartingale construction or complete SDE existence/uniqueness theory is supplied.

## martingale-theory

**鞅论 (D074)**

Reading: [Rick Durrett — Probability: Theory and Examples, fifth-edition manuscript](https://sites.math.duke.edu/~rtd/PTE/PTE5_011119.pdf).

Locator: §4.2 definition; Theorem 4.4.6; Theorem 4.6.7; §§4.8, Theorems 4.8.1–4.8.4, PDF pp. 225, 245, 255 and 263–264.

Knowledge: A discrete martingale is adapted and integrable, with the stated conditional-expectation equality relative to its filtration. Uniform integrability is equivalent to its almost-sure and L¹ convergence, while bounded Lp moments for finite 1<p<∞ give Lp convergence. Optional stopping at unbounded times has extra hypotheses; the text separates uniformly integrable processes from nonnegative-supermartingale conclusions.

Scope: Discrete-time martingale definitions, these integrability-dependent convergence results and the cited stopping statements; not all continuous-time martingale regularity theory.

### Further reading

Reading: [Gregory F. Lawler — Stochastic Calculus: An Introduction with Applications, revised February 15, 2023](https://www.math.uchicago.edu/~lawler/finbook.pdf).

Locator: §4.1, local martingale definition and Theorem 4.1.1, PDF pp. 133–134 (printed pp. 127–128).

Knowledge: A continuous adapted local martingale becomes a true martingale after stopping at each member of an increasing localizing sequence tending to the endpoint. Zero drift in a stochastic differential does not alone provide the integrability of a true martingale. For a continuous true martingale Z and a stopping time T, the stopped process Z_{t∧T} remains a true martingale. If additionally T<∞ almost surely and sup_t E[Z_{t∧T}²]<∞, then E[Z_T]=E[Z₀]. This L² bound is a sufficient condition in the cited theorem; almost-sure finiteness of T alone does not supply it.

Scope: Continuous local versus true martingales and the stated stopped-L² optional-sampling theorem; no general optional-stopping conclusion for arbitrary local martingales or merely finite stopping times is claimed.

## markov-chains

**马尔可夫链 (D075)**

Reading: [David A. Levin and Yuval Peres; contributions by Elizabeth L. Wilmer — Markov Chains and Mixing Times, second edition](https://pages.uoregon.edu/dlevin/MARKOV/markovmixing.pdf).

Locator: §1.5.4, Corollary 1.17; §4.3, Theorem 4.9, PDF pp. 29 and 68.

Knowledge: A finite irreducible Markov chain has a unique invariant probability distribution. Irreducibility together with aperiodicity gives geometric convergence to that distribution in total variation, uniformly over initial states, with chain-dependent constants. Thus uniqueness of an invariant law and convergence toward it are different statements with different hypotheses.

Scope: Finite chains, invariant-law uniqueness and the stated total-variation convergence theorem; not countably infinite recurrence classification or a reading of all mixing-time bounds.

### Further reading

Reading: [Rick Durrett — Probability: Theory and Examples, fifth-edition manuscript](https://sites.math.duke.edu/~rtd/PTE/PTE5_011119.pdf).

Locator: §5.3, definitions and Theorems 5.3.1–5.3.2, PDF pp. 289–290; §5.5, Theorems 5.5.10–5.5.12 and stationary-measure discussion, PDF pp. 313–315.

Knowledge: For a countable-state discrete-time chain, let Tₓ be the first return to x at a strictly positive time. A state is recurrent when Pₓ(Tₓ<∞)=1 and transient otherwise; recurrence also means the expected number of positive-time visits is infinite. A recurrent state is positive recurrent when EₓTₓ<∞ and null recurrent when that mean is infinite. For an irreducible chain, one positive recurrent state, all states positive recurrent, and existence of a stationary probability distribution are equivalent, with π(x)=1/EₓTₓ. An invariant measure can have infinite total mass, so its existence alone does not imply positive recurrence.

Scope: Countable-state irreducible classification and return-time normalization; this reading does not establish convergence in total variation or remove the aperiodicity conditions of separate convergence theorems.

## random-matrix-theory

**随机矩阵 (D076)**

Reading: [Terence Tao — Topics in Random Matrix Theory](https://terrytao.wordpress.com/wp-content/uploads/2011/02/matrix-book.pdf).

Locator: §2.4, Wigner ensemble/ESD definitions, Remark 2.4.1 and Theorem 2.4.2, PDF pp. 167–169.

Knowledge: The text's Wigner ensemble has centered unit-variance iid off-diagonal entries with Hermitian symmetry and an independent real diagonal with bounded mean and variance. Eigenvalues scaled by n^(−1/2) define an empirical spectral probability measure. For nested minors of the infinite Wigner matrix in Theorem 2.4.2, these measures converge almost surely to the semicircle law; expectation, probability and almost-sure convergence are distinguished notions.

Scope: The stated Wigner bulk law, normalization and modes of empirical-measure convergence; not extreme-eigenvalue universality or every random-matrix ensemble.

### Further reading

Reading: [Terence Tao — Topics in Random Matrix Theory](https://terrytao.wordpress.com/wp-content/uploads/2011/02/matrix-book.pdf).

Locator: §2.3, Theorem 2.3.24 (Strong Bai–Yin theorem, upper bound), PDF p. 163; the different conclusion in Exercise 2.3.14, PDF p. 164 (printed pp. 155–156).

Knowledge: Let ξᵢⱼ, 1≤i≤j, be an infinite iid array of real variables with mean zero, variance one and finite fourth moment, including the diagonal. Set ξⱼᵢ=ξᵢⱼ and form Mₙ=(ξᵢⱼ)₁≤ᵢ,ⱼ≤ₙ as nested principal blocks. The strong Bai–Yin upper-bound theorem gives limsup_{n→∞}||Mₙ||op/√n≤2 almost surely. The entry moments, real symmetry and common nested coupling across n are part of this statement. The theorem quoted here is an upper bound, rather than the full equality asserted under the bounded-entry hypothesis of the following exercise.

Scope: The cited real symmetric iid upper-triangular model and almost-sure norm upper bound; no general finite-fourth-moment equality, differing diagonal law, edge fluctuations or universality theorem is claimed.

## asymptotic-statistics

**渐近统计 (D077)**

Reading: [Zhou Fan / Stanford University — STATS 200, Lecture 14: Consistency and asymptotic normality of the MLE](https://web.stanford.edu/class/stats200/Lecture14.pdf).

Locator: Lecture 14, §14.1, Theorem 14.1 and footnote 1, PDF pp. 1–2.

Knowledge: Consistency refers to convergence of an estimator toward the true parameter in probability, whereas asymptotic normality concerns a scaled error's limiting distribution. In the lecture's regular iid one-parameter MLE setting, Fisher information describes the inverse asymptotic variance. Listed conditions include common support, an interior true parameter and differentiable likelihood, but the lecture explicitly says its hypothesis list is incomplete.

Scope: Introductory regular-MLE asymptotics and Fisher information; not a hypothesis-complete general MLE theorem, uniform inference, or an inference about bias from weak convergence alone.

### Further reading

Reading: [Siva Balakrishnan — 36-705 Intermediate Statistics, Fall 2019, Lecture 8](https://www.stat.cmu.edu/~siva/teaching/705/lec8.pdf).

Locator: §8.1, univariate Delta Method statement and accompanying proof, PDF pp. 1–2.

Knowledge: The univariate delta method assumes √n(Xₙ−µ) converges in distribution to N(0,σ²), with 0<σ²<∞, and g is continuously differentiable with g′(µ)≠0. It concludes √n(g(Xₙ)−g(µ)) converges in distribution to N(0,σ²[g′(µ)]²). The central-limit hypothesis is an input to this theorem; the theorem does not establish it for an arbitrary estimator. Its nonzero-derivative condition identifies the first-order, nondegenerate case, leaving transformations with g′(µ)=0 outside this statement.

Scope: The fully stated univariate first-order delta theorem and its distributional conclusion; the first reading’s missing MLE regularity conditions remain unresolved, and no moment or bias convergence is inferred.


Reading: [Clément Dombry, Sebastian Engelke and Marco Oesting — Asymptotic properties of the maximum likelihood estimator for multivariate extreme value distributions, arXiv v2](https://arxiv.org/pdf/1612.05178v2).

Locator: §3, equation (8) and Definition 3.1, PDF p. 7; score moments, PDF p. 8. §3.2, Theorem 3.4 and equation (9), PDF p. 9. §3.2, paragraph preceding Remark 3.6 and opening of the remark, PDF p. 10.

Knowledge: For iid observations from a density family with a fixed finite-dimensional parameter and an interior true value θ₀, differentiability in quadratic mean requires a first-order L² expansion of the square-root density, with score term (hᵀℓ̇θ₀/2)√fθ₀ and squared remainder o(‖h‖²). The score is centered and has covariance Iθ₀. For a family differentiable in quadratic mean at θ₀, Theorem 3.4, explicitly attributed to van der Vaart’s Theorem 5.39, additionally assumes that Iθ₀ is nonsingular and that |log fθ₂(z)−log fθ₁(z)|≤M(z)‖θ₂−θ₁‖∞ for all θ₁,θ₂ in the parameter set, with measurable M and Eθ₀M²<∞. Any consistent sequence of maximum likelihood estimators then satisfies √n(θ̂ₙ−θ₀)⇒N(0,Iθ₀⁻¹). Consistency is an input to this theorem. The paper separately distinguishes existence of a suitable sequence of local likelihood maxima from assertions about arbitrary global maxima.

Scope: A hypothesis-explicit sufficient MLE normality theorem in the cited fixed-dimensional iid density setting, with consistency assumed. This supplements the introductory Stanford reading without completing that handout’s own hypothesis list. It does not establish consistency or existence for a new model, convergence of moments, growing-dimension asymptotics, boundary-parameter limits or the paper’s model-specific extreme-value conditions.

## mathematical-statistics

**数理统计 (D078)**

Reading: [Zhou Fan / Stanford University — STATS 200, Lecture 6: Simple alternatives and the Neyman-Pearson lemma](https://web.stanford.edu/class/stats200/Lecture06.pdf).

Locator: Lecture 6, §6.1, Theorem 6.1 (Neyman-Pearson lemma), PDF pp. 1–2.

Knowledge: For specified simple null and alternative distributions, test power is the alternative's rejection probability and significance is the null's rejection probability. The stated Neyman-Pearson lemma says that a likelihood-ratio threshold test attaining level α has maximal power among tests of level at most α. Its likelihood ratio is defined as null density divided by alternative density, so rejection corresponds to smaller ratios.

Scope: Simple-versus-simple testing and the stated threshold-test optimality result; not uniformly most-powerful tests for arbitrary composite hypotheses or all estimator risk theory.

### Further reading

Reading: [Carnegie Mellon University, 36-705 course notes (Larry Wasserman course site; PDF has no author byline) — Lecture Notes 10, 36-705](https://www.stat.cmu.edu/~larry/=stat705/Lecture10.pdf); [Carnegie Mellon University, 36-705 course notes (Larry Wasserman course site; PDF has no author byline) — Lecture Notes 11, 36-705](https://www.stat.cmu.edu/~larry/=stat705/Lecture11a.pdf).

Locator: Lecture Notes 10, §3, sufficient-statistic definition and discrete-case qualification, PDF p. 3; Lecture Notes 11, §2, squared-error risk and Rao–Blackwell theorem/proof, PDF pp. 3–4.

Knowledge: In the discrete parametric setting, sufficiency means that the conditional law of the full data given T is independent of θ. For a real estimator θ̂ with E_θ[θ̂²]<∞ for each θ, this makes θ̃(T)=E_θ[θ̂|T] a function that can be chosen without knowing θ. Rao–Blackwell gives E_θ[(θ̃−θ)²]≤E_θ[(θ̂−θ)²]. The tower property preserves the estimator’s expectation, so unbiasedness, when present, is preserved. Unbiasedness is not needed for the risk inequality, and strict improvement is not guaranteed.

Scope: Discrete-model sufficient statistics and squared-error risk comparison for square-integrable estimators; no completeness, UMVU characterization or general continuous conditional-law construction is asserted.

## information-theory

**信息论 (D079)**

Reading: [David J. C. MacKay — Information Theory, Inference, and Learning Algorithms](https://www.inference.org.uk/itprnn/book.pdf).

Locator: Chapter 8, §8.1, equations (8.4), (8.7) and (8.8), PDF pp. 150–151 (printed pp. 138–139).

Knowledge: For the discrete ensembles in this section, conditional entropy is an average of entropies conditioned on individual outcomes. Joint entropy decomposes into a marginal entropy and the remaining conditional entropy. Mutual information is the resulting reduction in entropy, is symmetric in its two variables and is nonnegative.

Scope: Discrete joint/conditional entropy, the entropy chain rule and mutual information; not unrestricted differential entropy or a full channel-coding theorem.

Reuse: PDF states © Cambridge University Press 2003: on-screen viewing permitted, printing not permitted. Link and original summaries only; no Creative Commons licence is claimed.

### Further reading

Reading: [David J. C. MacKay — Information Theory, Inference, and Learning Algorithms, version 7.2, March 28, 2005](https://www.inference.org.uk/itprnn/book.pdf).

Locator: §9.3, channel definition, PDF p. 159; §10.1, theorem part 1 and converse statement; §10.5, converse discussion, PDF pp. 174 and 180–181 (printed pp. 147, 162 and 168–169).

Knowledge: A finite discrete memoryless channel has input/output alphabets and transition probabilities W(y|x), with uses conditionally independent given the inputs. Its capacity is C=max_{P_X}I(X;Y), in bits per use for base-2 logarithms. For every R<C and ε>0, sufficiently long block codes exist with rate at least R and maximal block-error probability below ε. At a fixed rate R>C, the converse precludes vanishing error. These are asymptotic existence and reliability statements; they do not specify an efficient code or decoder.

Scope: The finite discrete-memoryless channel coding theorem and impossibility of arbitrarily reliable communication above capacity; no explicit finite-blocklength rate, efficient construction or strong converse with error tending to one is claimed.

## statistical-learning-theory

**统计学习理论 (D080)**

Reading: [Shai Shalev-Shwartz and Shai Ben-David — Understanding Machine Learning: From Theory to Algorithms](https://www.cs.huji.ac.il/~shais/UnderstandingMachineLearning/understanding-machine-learning-theory-algorithms.pdf).

Locator: §4.2, Corollary 4.6; §6.4, Theorem 6.7, PDF pp. 57 and 72.

Knowledge: For iid samples, a finite hypothesis class and loss bounded in [0,1] admit uniform convergence with a sample bound depending logarithmically on class cardinality and inverse confidence and quadratically on inverse accuracy. For binary hypotheses with 0–1 loss in the book's learning setting, finite VC dimension, uniform convergence and PAC learnability are equivalent properties. These statements distinguish uniform performance over hypotheses from accuracy of one empirical fit.

Scope: Finite-class bounded-loss uniform convergence and the binary VC/PAC equivalence; not all dependent-sample learning, unbounded losses or computational efficiency guarantees.

Reuse: Title page states personal use only, not for distribution, and do not post. This collection links the author's copy and supplies original summaries; it does not repost the book.

### Further reading

Reading: [Shai Shalev-Shwartz and Shai Ben-David — Understanding Machine Learning: From Theory to Algorithms](https://www.cs.huji.ac.il/~shais/UnderstandingMachineLearning/understanding-machine-learning-theory-algorithms.pdf).

Locator: §6.4, Theorem 6.8, PDF pp. 72–73; §6.5.1, Definition 6.9 and Lemma 6.10, PDF pp. 73–74.

Knowledge: For binary hypotheses, the growth function τ_H(m) is the maximum number of distinct labelings induced on an m-point set. A class of VC dimension d shatters some d-point set; for m≤d its growth is 2^m, while Sauer–Shelah–Perles bounds τ_H(m) by Σᵢ₌₀ᵈ binom(m,i), and hence by (em/d)^d in the cited range m>d+1. In the book’s iid binary 0–1 setting, uniform convergence and agnostic PAC sample complexity have order (d+log(1/δ))/ε². The stated realizable PAC upper bound is of order (d log(1/ε)+log(1/δ))/ε, with lower bound of order (d+log(1/δ))/ε. These sample bounds do not assert efficient computation.

Scope: Finite positive VC dimension, combinatorial growth and the source’s quantitative binary PAC statements; no optimal tightening of the realizable logarithm, arbitrary-loss extension or dependent-sample result is claimed.
