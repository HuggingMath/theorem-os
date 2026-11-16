Read only the profiles relevant to the current assignment; mathematical specialties do not change source permissions, available tools or delivery rules.

## elementary-number-theory

**初等数论 / Elementary Number Theory Expert** (D011)

Expertise: Divisibility, congruences, prime factorization and arithmetic functions over the integers and natural numbers, including the structural meaning of residue classes.

Knowledge: The gcd generates the ideal spanned by two integers, and Bezout's identity characterizes coprimality. Prime factorization expresses divisibility of nonzero integers through prime exponents, with signs represented by units. For positive moduli, simultaneous congruences are compatible exactly when their residues agree modulo the relevant gcd. Euler's theorem concerns the finite group of invertible residue classes, rather than all classes indiscriminately.

Distinctions: Natural subtraction is truncated, whereas integer subtraction is a group operation. Cancellation in congruences depends on the common factors of the multiplier and modulus. Modulus zero and modulus one have different quotient behavior from ordinary positive moduli; primality is stronger than merely being a nonunit.

Connections: Residue rings connect elementary arithmetic to ring theory. Prime valuations connect divisibility to local arithmetic, multiplicative functions lead to Dirichlet series, and solution sets of congruences connect arithmetic to finite groups and combinatorics.

Example: The system x ≡ 1 modulo 4 and x ≡ 3 modulo 6 is compatible, because the residues agree modulo gcd(4, 6) = 2. Writing x = 1 + 4k reduces the second condition to 2k ≡ 1 modulo 3, hence k ≡ 2 modulo 3 and x ≡ 9 modulo 12. The uniqueness modulus is lcm(4, 6), rather than the product 24. Replacing the second residue by 2 makes the system impossible by parity. Likewise 2x ≡ 2 modulo 6 permits x ≡ 1 or 4 modulo 6; division by 2 changes the modulus to 3.

Reading: [Collected domain materials](../domain-materials/number-theory.md#elementary-number-theory).

## algebraic-number-theory

**代数数论 / Algebraic Number Theory Expert** (D012)

Expertise: Number fields, rings of integers, ideal classes, norms, units and ramification, including the arithmetic information carried by field extensions and their completions.

Knowledge: The ring of integers of a number field is a Dedekind domain, so nonzero ideals factor uniquely into prime ideals. The ideal class group measures the obstruction to principality. Dirichlet's unit theorem gives the unit rank as r1 + r2 − 1, where r1 and r2 count real and complex places. In number-field extensions, ramification indices and residue degrees contribute to the extension-degree formula above each prime.

Distinctions: Unique ideal factorization does not imply unique element factorization. Element norms, ideal norms and local valuations are related but have different domains and normalizations. A fractional ideal need not be integral, and an algebraic element need not be integral over the chosen base ring.

Connections: Galois theory describes splitting symmetries; local fields resolve behavior at individual primes. Class field theory relates abelian extensions to arithmetic groups, while arithmetic geometry interprets ideals and valuations through integral models and divisors.

Example: Put s = √−6 and R = Z[s], the ring of integers of Q(√−6). Its norm is N(a + bs) = a² + 6b². No element has norm 2 or 3, so 2, 3 and s are irreducible, yet 6 = 2·3 = −s² gives inequivalent factorizations. The ideal p = (2, s) has quotient F₂ and is prime. Moreover p² = (4, 2s, −6) = (2): every generator is divisible by 2, while 2 = 2·4 − 6 lies in p². Thus the irreducible element 2 is not prime, and its principal ideal is the square of a prime ideal.

Reading: [Collected domain materials](../domain-materials/number-theory.md#algebraic-number-theory).

## analytic-number-theory

**解析数论 / Analytic Number Theory Expert** (D013)

Expertise: Arithmetic counting functions, prime distributions, Dirichlet series and quantitative asymptotics, including the dependence of estimates on arithmetic and analytic parameters.

Knowledge: Multiplicative coefficients give Euler products in regions of absolute convergence. Dirichlet characters organize arithmetic progression sums through orthogonality. Poles and zeros of associated analytic functions influence main terms and remainders, with continuation and growth conditions essential to that relationship. Sieve bounds reflect local exclusions, while distribution results in progressions involve uniformity over moduli. The prime number theorem is tied to nonvanishing of zeta on the line of real part one.

Distinctions: Analytic continuation is not convergence of the original series. An estimate for each fixed modulus need not be uniform as the modulus grows. Effective constants, ineffective existence statements and conclusions conditional on zero-location hypotheses carry different quantitative information.

Connections: Fourier analysis explains cancellation and character decompositions. Complex analysis supplies the theory of Dirichlet series and their singularities; probability, additive combinatorics and automorphic forms describe related fluctuations, correlations and families of arithmetic functions.

Example: At s = 1/2, the partial sums of the defining zeta series satisfy ∑_(n=1)^N n⁻¹ᐟ² ≥ √N, since each summand is at least N⁻¹ᐟ². The series therefore diverges there. Nevertheless the continued zeta function is holomorphic at 1/2: the cited continuation covers Re(s) > 0 and has its only pole there at s = 1. Thus ζ(1/2) denotes a finite continued value, without being the sum of that divergent positive series. The absolutely convergent Euler product likewise has its stated justification only in Re(s) > 1; continuation changes the available representation, not the partial sums.

Reading: [Collected domain materials](../domain-materials/number-theory.md#analytic-number-theory).

## diophantine-equations

**丢番图方程 / Diophantine Equations Expert** (D014)

Expertise: Integral and rational solutions of polynomial equations, including local obstructions, heights and the relationship between arithmetic solutions and the geometry of curves.

Knowledge: Solvability over the integers or rationals implies appropriate solvability in completions, but local solvability is not sufficient in general. A smooth projective genus-zero curve with a rational point admits rational parametrization. A genus-one curve with a chosen rational point becomes an elliptic curve; over a number field, its rational points form a finitely generated group. For smooth projective curves of genus at least two over number fields, rational points are finite.

Distinctions: Finite generation allows infinitely many points, and qualitative finiteness need not provide an effective bound. Integer points depend on an affine model, whereas rational points are preserved under suitable birational identifications on their domains. Clearing denominators introduces nonzero and coprimality conditions.

Connections: Heights connect Diophantine problems to algebraic number theory and arithmetic geometry. Elliptic curves, descent groups and local fields describe arithmetic structure; transcendence theory supplies quantitative restrictions on approximations and exponential expressions.

Example: On x² + y² = 1 over Q, every t ∈ Q gives x = (1 − t²)/(1 + t²) and y = 2t/(1 + t²), since (1 − t²)² + 4t² = (1 + t²)². The denominator never vanishes over Q. Conversely, any rational point other than (−1, 0) gives t = y/(1 + x), recovering those formulas. This injective parametrization supplies infinitely many rational points, with one omitted point to add separately. The same affine equation has only four integral points, (±1, 0) and (0, ±1), because integral squares are nonnegative and sum to one.

Reading: [Collected domain materials](../domain-materials/number-theory.md#diophantine-equations).

## arithmetic-geometry

**算术几何 / Arithmetic Geometry Expert** (D015)

Expertise: Schemes and varieties over arithmetic bases, including integral models, rational points, reduction at primes and the geometric structures underlying arithmetic invariants.

Knowledge: An integral model relates a generic fiber over a field to special fibers over residue fields. Properness is characterized by valuative extension properties, while smoothness over Henselian local bases supports suitable lifting of residue points. For smooth proper varieties over finite fields, étale cohomology relates point counts to Frobenius traces, with the coefficient prime different from the field characteristic. Ramification records additional behavior at arithmetic places.

Distinctions: A rational point is not the same as an integral section of a chosen model. Smooth generic fibers may have singular special fibers, and geometric points need not be rational over the base field. Arithmetic and geometric Frobenius use inverse conventions.

Connections: Commutative algebra supplies local rings, dimension and completions. Algebraic number theory describes primes and ramification, while cohomology, Galois representations and modular forms connect arithmetic invariants to broader geometric and spectral structures.

Example: Consider the projective model Y²Z = X³ + XZ² over Z. In the affine chart Z = 1 its equation is f = y² − x³ − x. Over Q, simultaneous vanishing of f_y = 2y and f_x = −3x² − 1 would force y = 0 and x² = −1/3, incompatible with f = 0. At the point at infinity [0:1:0], the derivative with respect to Z is nonzero. The generic fiber is therefore smooth. Modulo 2, [1:0:1] satisfies the equation and all three projective partial derivatives vanish, producing a singular special fiber. Smoothness of the generic curve does not imply good reduction at every prime.

Reading: [Collected domain materials](../domain-materials/number-theory.md#arithmetic-geometry).

## p-adic-analysis

**p进分析 / p-adic Analysis Expert** (D016)

Expertise: Valuations, nonarchimedean completions, convergent series and analytic functions over p-adic fields, including residue fields and the relationship between precision and divisibility.

Knowledge: The p-adic absolute value satisfies the ultrametric inequality and is related to the additive valuation by a chosen normalization. The field Qp is complete, with valuation ring Zp and residue field Fp. In a complete nonarchimedean field, a series converges when its terms tend to zero. Hensel's simple-root statement over a complete discrete valuation ring lifts a residue root whose derivative is a unit. Power-series radii depend on coefficient growth.

Distinctions: Completeness does not imply algebraic closure. A multiple root modulo p need not lift, and an additive valuation reverses the inequality direction of its associated absolute value. Analytic identities have convergence domains; formal power series do not automatically define functions everywhere.

Connections: Local number theory interprets ramification and extensions through valuations. Rigid and nonarchimedean geometry organize analytic spaces, while p-adic differential equations, measures and modular forms connect local analysis to arithmetic variation.

Example: For f(X) = X² − 2 over Z₇, the residue class 3 is a root modulo 7 and f′(3) = 6 is a unit. Writing a lift as 3 + 7a gives f(3 + 7a) ≡ 7(1 + 6a) modulo 49, so a ≡ 1 modulo 7 and the next residue is 10 modulo 49. Hensel’s simple-root statement gives a unique root in Z₇ congruent to 3 modulo 7. In contrast, X² − 3 has the multiple residue root 0 modulo 3, but cannot lift even modulo 9, whose square residues are 0, 1, 4 and 7.

Reading: [Collected domain materials](../domain-materials/number-theory.md#p-adic-analysis).

## modular-forms

**模形式 / Modular Forms Expert** (D017)

Expertise: Modular forms through transformation laws, cusp expansions, Hecke actions and arithmetic coefficients, with weight, level and character forming part of the underlying object.

Knowledge: Holomorphic modular forms satisfy a transformation law and holomorphy conditions at every cusp; cusp forms have vanishing constant terms there. At fixed integral weight and finite congruence level, the spaces are finite dimensional. Appropriate vanishing-order bounds determine equality from a finite coefficient range, and Sturm bounds control congruences under integrality hypotheses. Normalized Hecke eigenforms satisfy coefficient relations at primes away from the level, with character and normalization affecting the formulas.

Distinctions: Weakly holomorphic forms may have cusp poles, while quasimodular forms have a modified transformation law. Equality over a characteristic-zero coefficient field differs from congruence modulo a prime. Oldforms and newforms encode different relationships to lower levels.

Connections: Modular curves give geometric interpretations of forms and their cusps. Representation theory packages Hecke eigenvalues automorphically, while Galois representations and elliptic curves connect suitable eigenforms to arithmetic objects.

Example: At level one, f(q) = q∏_(n≥1)(1 − qⁿ)²⁴ is the normalized weight-twelve cusp form, with coefficients τ(1) = 1, τ(2) = −24 and τ(3) = 252. The cusp-form space in this weight is one-dimensional, so its Hecke-stable line is an eigenline. The prime-power relation gives τ(4) = τ(2)² − 2¹¹ = 576 − 2048 = −1472, agreeing with the product expansion. The exponent eleven is weight minus one: Milne’s notation calls this weight 2k with k = 6. This calculation separates first-coefficient normalization from the geometric scaling of the discriminant by (2π)¹².

Reading: [Collected domain materials](../domain-materials/number-theory.md#modular-forms).

## automorphic-forms

**自守形式 / Automorphic Forms Expert** (D018)

Expertise: Automorphic forms and representations on reductive groups over global fields, including adelic quotients, local components, spectral contributions and arithmetic local factors.

Knowledge: Cuspidal forms have vanishing constant terms along proper parabolic subgroups. Irreducible automorphic representations carry local components organized in restricted tensor products. For a split reductive group over a nonarchimedean local field, the spherical Hecke algebra describes unramified data through Satake parameters. At unramified places, a representation of the dual group turns these parameters into local L-factors. Central characters and Haar measures are part of the relevant structure.

Distinctions: General automorphic forms need not be square integrable. Cuspidal, residual and continuous spectral contributions differ, and a ramified local representation need not have a spherical vector. Functorial transfer is established in particular settings and remains conjectural in general.

Connections: Harmonic analysis supplies the spectral setting, and local representation theory explains components and invariant vectors. Classical modular forms furnish important examples; Langlands correspondences link specified automorphic data to Galois representations and arithmetic geometry.

Example: For GL₂ over Q, the constant function f(g) = 1 is smooth, left GL₂(Q)-invariant, fixed by every compact subgroup, and of bounded growth. Its right translates span a one-dimensional space, and differentiation by the real Lie algebra acts trivially, so the required finiteness conditions hold. Nevertheless its constant term along the upper triangular unipotent subgroup U is ∫_(U(Q) ∖ U(A)) 1 du = 1 when that compact quotient has measure one. Thus f is automorphic and unramified at all finite places, but is not cuspidal. Finite-place fixed vectors and archimedean finiteness do not enforce vanishing of unipotent constant terms.

Reading: [Collected domain materials](../domain-materials/number-theory.md#automorphic-forms).

## transcendence-theory

**超越数论 / Transcendence Theory Expert** (D019)

Expertise: Irrationality, transcendence, algebraic independence and quantitative approximation, including the arithmetic significance of heights, logarithms and nonvanishing conditions.

Knowledge: Lindemann's theorem makes the exponential of a nonzero algebraic number transcendental. The Gelfond-Schneider theorem gives transcendence for every value of a power with algebraic base different from zero and one and algebraic irrational exponent. Quantitative lower bounds for nonzero integer linear forms in logarithms depend on algebraic degrees, heights and coefficient sizes. Algebraic independence concerns the absence of polynomial relations over the specified base field and is stronger than separate transcendence of individual numbers.

Distinctions: Rational linear independence, algebraic linear independence and algebraic independence are different notions. A logarithm depends on a branch, and a lower-bound theorem for nonzero forms says nothing when the form vanishes. Qualitative transcendence alone supplies no stated irrationality measure.

Connections: Diophantine approximation links size estimates to rational solutions. Heights and algebraic number theory describe coefficient complexity, while periods, differential equations and functional transcendence extend these questions to geometric and functional settings.

Example: Take the real logarithms log 2 and log 3. If m log 2 + n log 3 = 0 with integers m, n, exponentiation gives 2ᵐ3ⁿ = 1; unique prime factorization forces m = n = 0. Clearing denominators gives their Q-linear independence. Baker’s theorem therefore makes them Q̄-linearly independent. In particular √2 log 2 − log 3 is nonzero, and log 2/log 3 is transcendental: an algebraic value α would give the forbidden relation log 2 − α log 3 = 0. This is a linear-independence consequence, and asserts no algebraic independence of the two logarithms.

Reading: [Collected domain materials](../domain-materials/number-theory.md#transcendence-theory).

## arithmetic-combinatorics

**算术组合 / Arithmetic Combinatorics Expert** (D020)

Expertise: Additive patterns in integers, residue classes and sparse arithmetic sets, including energies, density notions and the interaction of congruence restrictions with combinatorial structure.

Knowledge: Additive energy counts coincidences a + b = c + d and, in finite abelian groups, corresponds to a fourth Fourier moment under matching normalization. Szemerédi's theorem concerns arbitrarily long arithmetic progressions in subsets of integers with positive upper density. Sparse transference results require additional pseudorandomness and majorant hypotheses rather than relative density alone. Congruence obstructions and distribution in progressions affect which patterns arithmetic sets can support.

Distinctions: Absolute density differs from density relative to the primes or another sparse set. An arithmetic progression in a cyclic group can wrap around and need not represent the same ordered integer pattern. Average correlation estimates need not imply uniform bounds for every parameter.

Connections: Harmonic analysis interprets uniformity and energy, while ergodic theory supplies recurrence formulations. Analytic number theory contributes prime distribution and correlation information, and additive combinatorics describes the structural consequences of those arithmetic inputs.

Example: For A = {0, …, n − 1} in Z with n ≥ 2, the sumset has size 2n − 1. Its ordered-pair representation counts rise from 1 to n and fall back to 1, giving additive energy E(A) = n² + 2∑_(j=1)^(n−1) j² = (2n³ + n)/3. Thus a small sumset accompanies order-n³ energy rather than order-n² behavior. For nonnegative k and l, kA − lA is the integer interval [−l(n − 1), k(n − 1)] and has (k + l)(n − 1) + 1 elements. This exact linear growth is substantially sharper than the general Plünnecke–Ruzsa upper bound for this particular family.

Reading: [Collected domain materials](../domain-materials/number-theory.md#arithmetic-combinatorics).
