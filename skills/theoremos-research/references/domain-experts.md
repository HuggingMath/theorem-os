# Select a mathematical domain expert

Choose a specialist whose mathematical knowledge fits the question. The directory routes to subject-specific concepts, structures, theories, important distinctions and connections with neighboring domains. Read only the relevant profile sections.

Each profile's **Reading** link leads to [collected domain materials](domain-materials.md), with author sources, precise locations and original knowledge notes. These extend the specialist's background while leaving the proof approach to the member.

## Choose and combine

Select expertise from the missing concept and its actual objects, definitions and assumptions. Use the index to locate that knowledge; a broad label such as algebra does not imply that ideals, field extensions or representations will help a particular calculation. A cross-domain question can combine specialties in one member. Put the selected IDs or slugs after `Profiles:` on the first line. If only a work responsibility is needed, choose it without a domain. Give the question, known inputs, intended consumer and useful output on the following lines. The host supplies selected profiles and locators for reading on demand; inspect the loading modes and unresolved selection record. There is no separate domain or role tool parameter.

For example, assign a representation theorist the question whether a specified invariant subspace has an invariant complement, giving the group, field and action. The expert selects the relevant knowledge and decides how to investigate it. Several profiles can fit the same question; use complementary knowledge where it helps and give additional members distinct questions.

Combine domain expertise with a [team work responsibility](team-roles.md): for example, a domain expert may investigate, prove a helper, close the original target, debug Lean or review fixed evidence. Lead retains coordination and adoption authority. Domain selections can change while agentId, workspace and thread persist; a change of specialty does not establish reviewer independence. Coordination and proof-engineering responsibilities have their own selection table.

## Use specialized knowledge

Each profile describes **Expertise**, **Knowledge**, **Distinctions**, an **Example** and **Connections**. Examples give concrete objects, computations or constructions that distinguish nearby concepts or expose a missing hypothesis. They are mathematical background, not proposed solutions to the current assignment. The member chooses its proof method from the actual problem.

Choose the reasoning, construction, search or proof approach from the assigned problem. Knowledge of a theorem includes its setting and assumptions; a named result still needs an actual application to the current objects. Consult definitions and permitted sources when additional subject knowledge is needed.

Work as the selected domain expert for the current assignment and save useful arguments and Lean proofs. The pinned library's actual definitions and declarations determine formal availability. A useful handoff identifies the established result, its assumptions, supporting evidence and remaining gap; unfamiliar material or a missing formal interface remains explicit. The work responsibility and current assignment determine the requested output.

At a subject boundary, identify the actual connection: for example, a representation is a module over a specified group algebra, and a PDE energy form acts on a specified function space. State the map, scalar field, topology or measure needed by that connection when it affects a peer's use of the result. The profiles' examples supply small concrete cases for understanding those distinctions; they do not establish the same conclusion for different objects.

Use [parallel-work.md](parallel-work.md) for messaging, source transfer and formal delivery and [lean.md](lean.md) for exact declarations. All domain experts retain the ability to write Lean in their own permitted workspace. The frozen problem, source ownership, shared allowance and independent host acceptance apply to every specialty. Current team delivery checks theorem/lemma artifacts; new shared definitions, instances, generated files or dependencies require an actually supported host path. A profile does not authorize adding axioms, changing the original goal or installing a tool. A conditional argument, finite experiment or review remains scoped to its actual evidence.

## Questions at subject boundaries

These entries help choose relevant knowledge when the same words occur in different subjects. They do not require additional agents or an order of work.

| Question | Knowledge that distinguishes the settings | Profiles |
| --- | --- | --- |
| Does an invariant subspace have an invariant complement? | The group, scalar characteristic and representation category affect splitting; diagonalizing one operator is a different question. | [D006 representation theory](domain-experts/algebra.md#representation-theory), [D010 linear algebra](domain-experts/algebra.md#linear-algebra) |
| Does algebraic or integral dependence give the claimed geometric conclusion? | Algebraicity over a field, integrality over a ring and finite generation impose different conditions; nilpotents affect the coordinate ring. | [D003 field theory](domain-experts/algebra.md#field-galois-theory), [D004 commutative algebra](domain-experts/algebra.md#commutative-algebra), [D030 algebraic geometry](domain-experts/geometry.md#algebraic-geometry) |
| Do local arithmetic solutions give a rational point? | Real and p-adic solvability supply local information; a rational point requires a global statement. | [D014 Diophantine equations](domain-experts/number-theory.md#diophantine-equations), [D015 arithmetic geometry](domain-experts/number-theory.md#arithmetic-geometry), [D016 p-adic analysis](domain-experts/number-theory.md#p-adic-analysis) |
| Do matching homology groups identify the space? | Homology groups, cohomology rings and homotopy type contain different information. | [D032 algebraic topology](domain-experts/topology.md#algebraic-topology), [D035 homotopy theory](domain-experts/topology.md#homotopy-theory), [D036 cohomology](domain-experts/topology.md#cohomology-theory) |
| Does a positive energy form give a unique solution? | Coercivity depends on the norm and domain; boundary conditions can leave a kernel and a compatibility obstruction. | [D043 functional analysis](domain-experts/analysis.md#functional-analysis), [D052 elliptic equations](domain-experts/differential-equations.md#elliptic-equations), [D060 integral equations](domain-experts/differential-equations.md#integral-equations) |
| Does temporal averaging imply independence or mixing? | Ergodicity, correlation decay, transition invariance and martingale conditioning describe different structures. | [D056 ergodic theory](domain-experts/differential-equations.md#ergodic-theory), [D074 martingales](domain-experts/probability-statistics.md#martingale-theory), [D075 Markov chains](domain-experts/probability-statistics.md#markov-chains) |
| Does convergence of distributions control expectations or extreme eigenvalues? | Uniform integrability controls expectation transfer; an empirical spectral law can miss outliers. | [D071 probability foundations](domain-experts/probability-statistics.md#probability-foundations), [D076 random matrices](domain-experts/probability-statistics.md#random-matrix-theory) |
| Does stationarity or a necessary extremal give an optimizer? | Convexity, feasible-set geometry, horizon and attainment each affect the conclusion. | [D058 variations](domain-experts/differential-equations.md#calculus-of-variations), [D059 control](domain-experts/differential-equations.md#optimal-control), [D081 convex optimization](domain-experts/optimization-computation.md#convex-optimization), [D082 nonconvex optimization](domain-experts/optimization-computation.md#nonconvex-optimization) |
| Does a numerical result establish an exact geometric or algebraic fact? | Error enclosures, exact predicate signs and conditioning concern different guarantees from runtime complexity. | [D084 numerical linear algebra](domain-experts/optimization-computation.md#numerical-linear-algebra), [D086 validated numerics](domain-experts/optimization-computation.md#validated-numerics), [D088 computational geometry](domain-experts/optimization-computation.md#computational-geometry), [D090 complexity](domain-experts/optimization-computation.md#computational-complexity) |
| Is a semantic identity also a derivation or a type-level conversion? | Validity depends on the model class; derivability depends on the calculus; propositional and definitional equality differ. | [D092 mathematical logic](domain-experts/foundations.md#mathematical-logic), [D094 proof theory](domain-experts/foundations.md#proof-theory), [D096 type theory](domain-experts/foundations.md#type-theory), [D100 program semantics](domain-experts/foundations.md#program-semantics) |

## Browse by mathematical subject

### 代数 / Algebra

Groups, rings, fields, modules and algebraic structures.

| ID | 专家 | Domain | Assignment name |
| --- | --- | --- | --- |
| D001 | [群论专家](domain-experts/algebra.md#group-theory) | Group Theory | `group-theory` |
| D002 | [环论专家](domain-experts/algebra.md#ring-theory) | Ring Theory | `ring-theory` |
| D003 | [域论与伽罗瓦理论专家](domain-experts/algebra.md#field-galois-theory) | Field and Galois Theory | `field-galois-theory` |
| D004 | [交换代数专家](domain-experts/algebra.md#commutative-algebra) | Commutative Algebra | `commutative-algebra` |
| D005 | [同调代数专家](domain-experts/algebra.md#homological-algebra) | Homological Algebra | `homological-algebra` |
| D006 | [表示论专家](domain-experts/algebra.md#representation-theory) | Representation Theory | `representation-theory` |
| D007 | [李代数专家](domain-experts/algebra.md#lie-algebras) | Lie Algebras | `lie-algebras` |
| D008 | [结合代数专家](domain-experts/algebra.md#associative-algebras) | Associative Algebras | `associative-algebras` |
| D009 | [泛代数专家](domain-experts/algebra.md#universal-algebra) | Universal Algebra | `universal-algebra` |
| D010 | [线性代数专家](domain-experts/algebra.md#linear-algebra) | Linear Algebra | `linear-algebra` |

### 数论 / Number theory

Integers, primes, Diophantine problems, arithmetic fields and arithmetic geometry.

| ID | 专家 | Domain | Assignment name |
| --- | --- | --- | --- |
| D011 | [初等数论专家](domain-experts/number-theory.md#elementary-number-theory) | Elementary Number Theory | `elementary-number-theory` |
| D012 | [代数数论专家](domain-experts/number-theory.md#algebraic-number-theory) | Algebraic Number Theory | `algebraic-number-theory` |
| D013 | [解析数论专家](domain-experts/number-theory.md#analytic-number-theory) | Analytic Number Theory | `analytic-number-theory` |
| D014 | [丢番图方程专家](domain-experts/number-theory.md#diophantine-equations) | Diophantine Equations | `diophantine-equations` |
| D015 | [算术几何专家](domain-experts/number-theory.md#arithmetic-geometry) | Arithmetic Geometry | `arithmetic-geometry` |
| D016 | [p进分析专家](domain-experts/number-theory.md#p-adic-analysis) | p-adic Analysis | `p-adic-analysis` |
| D017 | [模形式专家](domain-experts/number-theory.md#modular-forms) | Modular Forms | `modular-forms` |
| D018 | [自守形式专家](domain-experts/number-theory.md#automorphic-forms) | Automorphic Forms | `automorphic-forms` |
| D019 | [超越数论专家](domain-experts/number-theory.md#transcendence-theory) | Transcendence Theory | `transcendence-theory` |
| D020 | [算术组合专家](domain-experts/number-theory.md#arithmetic-combinatorics) | Arithmetic Combinatorics | `arithmetic-combinatorics` |

### 几何 / Geometry

Geometric constructions, metric or smooth structure and algebraic varieties.

| ID | 专家 | Domain | Assignment name |
| --- | --- | --- | --- |
| D021 | [欧氏几何专家](domain-experts/geometry.md#euclidean-geometry) | Euclidean Geometry | `euclidean-geometry` |
| D022 | [射影几何专家](domain-experts/geometry.md#projective-geometry) | Projective Geometry | `projective-geometry` |
| D023 | [仿射几何专家](domain-experts/geometry.md#affine-geometry) | Affine Geometry | `affine-geometry` |
| D024 | [凸几何专家](domain-experts/geometry.md#convex-geometry) | Convex Geometry | `convex-geometry` |
| D025 | [离散几何专家](domain-experts/geometry.md#discrete-geometry) | Discrete Geometry | `discrete-geometry` |
| D026 | [微分几何专家](domain-experts/geometry.md#differential-geometry) | Differential Geometry | `differential-geometry` |
| D027 | [黎曼几何专家](domain-experts/geometry.md#riemannian-geometry) | Riemannian Geometry | `riemannian-geometry` |
| D028 | [辛几何专家](domain-experts/geometry.md#symplectic-geometry) | Symplectic Geometry | `symplectic-geometry` |
| D029 | [复几何专家](domain-experts/geometry.md#complex-geometry) | Complex Geometry | `complex-geometry` |
| D030 | [代数几何专家](domain-experts/geometry.md#algebraic-geometry) | Algebraic Geometry | `algebraic-geometry` |

### 拓扑 / Topology

Continuity, spaces, homotopy, cohomology, manifolds, bundles and knots.

| ID | 专家 | Domain | Assignment name |
| --- | --- | --- | --- |
| D031 | [一般拓扑专家](domain-experts/topology.md#general-topology) | General Topology | `general-topology` |
| D032 | [代数拓扑专家](domain-experts/topology.md#algebraic-topology) | Algebraic Topology | `algebraic-topology` |
| D033 | [几何拓扑专家](domain-experts/topology.md#geometric-topology) | Geometric Topology | `geometric-topology` |
| D034 | [微分拓扑专家](domain-experts/topology.md#differential-topology) | Differential Topology | `differential-topology` |
| D035 | [同伦论专家](domain-experts/topology.md#homotopy-theory) | Homotopy Theory | `homotopy-theory` |
| D036 | [上同调理论专家](domain-experts/topology.md#cohomology-theory) | Cohomology Theory | `cohomology-theory` |
| D037 | [纤维丛与特征类专家](domain-experts/topology.md#fiber-bundles) | Fiber Bundles and Characteristic Classes | `fiber-bundles` |
| D038 | [纽结理论专家](domain-experts/topology.md#knot-theory) | Knot Theory | `knot-theory` |
| D039 | [低维拓扑专家](domain-experts/topology.md#low-dimensional-topology) | Low-dimensional Topology | `low-dimensional-topology` |
| D040 | [拓扑群专家](domain-experts/topology.md#topological-groups) | Topological Groups | `topological-groups` |

### 分析 / Analysis

Limits, functions, spaces, integration, operators and estimates.

| ID | 专家 | Domain | Assignment name |
| --- | --- | --- | --- |
| D041 | [实分析专家](domain-experts/analysis.md#real-analysis) | Real Analysis | `real-analysis` |
| D042 | [复分析专家](domain-experts/analysis.md#complex-analysis) | Complex Analysis | `complex-analysis` |
| D043 | [泛函分析专家](domain-experts/analysis.md#functional-analysis) | Functional Analysis | `functional-analysis` |
| D044 | [调和分析专家](domain-experts/analysis.md#harmonic-analysis) | Harmonic Analysis | `harmonic-analysis` |
| D045 | [测度与积分专家](domain-experts/analysis.md#measure-integration) | Measure and Integration | `measure-integration` |
| D046 | [几何测度论专家](domain-experts/analysis.md#geometric-measure-theory) | Geometric Measure Theory | `geometric-measure-theory` |
| D047 | [算子理论专家](domain-experts/analysis.md#operator-theory) | Operator Theory | `operator-theory` |
| D048 | [逼近论专家](domain-experts/analysis.md#approximation-theory) | Approximation Theory | `approximation-theory` |
| D049 | [广义函数与Sobolev空间专家](domain-experts/analysis.md#distributions-sobolev) | Distributions and Sobolev Spaces | `distributions-sobolev` |
| D050 | [位势论专家](domain-experts/analysis.md#potential-theory) | Potential Theory | `potential-theory` |

### 微分方程与动力系统 / Differential equations and dynamics

Evolution, PDE solution concepts, stability, variation and control.

| ID | 专家 | Domain | Assignment name |
| --- | --- | --- | --- |
| D051 | [常微分方程专家](domain-experts/differential-equations.md#ordinary-differential-equations) | Ordinary Differential Equations | `ordinary-differential-equations` |
| D052 | [椭圆型方程专家](domain-experts/differential-equations.md#elliptic-equations) | Elliptic Equations | `elliptic-equations` |
| D053 | [抛物型方程专家](domain-experts/differential-equations.md#parabolic-equations) | Parabolic Equations | `parabolic-equations` |
| D054 | [双曲型方程专家](domain-experts/differential-equations.md#hyperbolic-equations) | Hyperbolic Equations | `hyperbolic-equations` |
| D055 | [动力系统专家](domain-experts/differential-equations.md#dynamical-systems) | Dynamical Systems | `dynamical-systems` |
| D056 | [遍历论专家](domain-experts/differential-equations.md#ergodic-theory) | Ergodic Theory | `ergodic-theory` |
| D057 | [分岔理论专家](domain-experts/differential-equations.md#bifurcation-theory) | Bifurcation Theory | `bifurcation-theory` |
| D058 | [变分法专家](domain-experts/differential-equations.md#calculus-of-variations) | Calculus of Variations | `calculus-of-variations` |
| D059 | [最优控制专家](domain-experts/differential-equations.md#optimal-control) | Optimal Control | `optimal-control` |
| D060 | [积分方程专家](domain-experts/differential-equations.md#integral-equations) | Integral Equations | `integral-equations` |

### 离散数学与组合 / Discrete mathematics and combinatorics

Counting, finite structures, graph phenomena, sums and combinatorial existence.

| ID | 专家 | Domain | Assignment name |
| --- | --- | --- | --- |
| D061 | [枚举组合专家](domain-experts/discrete-mathematics.md#enumerative-combinatorics) | Enumerative Combinatorics | `enumerative-combinatorics` |
| D062 | [代数组合专家](domain-experts/discrete-mathematics.md#algebraic-combinatorics) | Algebraic Combinatorics | `algebraic-combinatorics` |
| D063 | [极值组合专家](domain-experts/discrete-mathematics.md#extremal-combinatorics) | Extremal Combinatorics | `extremal-combinatorics` |
| D064 | [图论专家](domain-experts/discrete-mathematics.md#graph-theory) | Graph Theory | `graph-theory` |
| D065 | [超图理论专家](domain-experts/discrete-mathematics.md#hypergraph-theory) | Hypergraph Theory | `hypergraph-theory` |
| D066 | [概率组合专家](domain-experts/discrete-mathematics.md#probabilistic-combinatorics) | Probabilistic Combinatorics | `probabilistic-combinatorics` |
| D067 | [加性组合专家](domain-experts/discrete-mathematics.md#additive-combinatorics) | Additive Combinatorics | `additive-combinatorics` |
| D068 | [Ramsey理论专家](domain-experts/discrete-mathematics.md#ramsey-theory) | Ramsey Theory | `ramsey-theory` |
| D069 | [组合设计专家](domain-experts/discrete-mathematics.md#design-theory) | Design Theory | `design-theory` |
| D070 | [拟阵理论专家](domain-experts/discrete-mathematics.md#matroid-theory) | Matroid Theory | `matroid-theory` |

### 概率与统计 / Probability and statistics

Random objects, stochastic limits, inference, information and learning bounds.

| ID | 专家 | Domain | Assignment name |
| --- | --- | --- | --- |
| D071 | [概率论基础专家](domain-experts/probability-statistics.md#probability-foundations) | Probability Foundations | `probability-foundations` |
| D072 | [随机过程专家](domain-experts/probability-statistics.md#stochastic-processes) | Stochastic Processes | `stochastic-processes` |
| D073 | [随机分析专家](domain-experts/probability-statistics.md#stochastic-analysis) | Stochastic Analysis | `stochastic-analysis` |
| D074 | [鞅论专家](domain-experts/probability-statistics.md#martingale-theory) | Martingale Theory | `martingale-theory` |
| D075 | [马尔可夫链专家](domain-experts/probability-statistics.md#markov-chains) | Markov Chains | `markov-chains` |
| D076 | [随机矩阵专家](domain-experts/probability-statistics.md#random-matrix-theory) | Random Matrix Theory | `random-matrix-theory` |
| D077 | [渐近统计专家](domain-experts/probability-statistics.md#asymptotic-statistics) | Asymptotic Statistics | `asymptotic-statistics` |
| D078 | [数理统计专家](domain-experts/probability-statistics.md#mathematical-statistics) | Mathematical Statistics | `mathematical-statistics` |
| D079 | [信息论专家](domain-experts/probability-statistics.md#information-theory) | Information Theory | `information-theory` |
| D080 | [统计学习理论专家](domain-experts/probability-statistics.md#statistical-learning-theory) | Statistical Learning Theory | `statistical-learning-theory` |

### 优化与计算数学 / Optimization and computational mathematics

Optimization guarantees, numerical error, exact algorithms, coding and complexity.

| ID | 专家 | Domain | Assignment name |
| --- | --- | --- | --- |
| D081 | [凸优化专家](domain-experts/optimization-computation.md#convex-optimization) | Convex Optimization | `convex-optimization` |
| D082 | [非凸优化专家](domain-experts/optimization-computation.md#nonconvex-optimization) | Nonconvex Optimization | `nonconvex-optimization` |
| D083 | [整数与组合优化专家](domain-experts/optimization-computation.md#integer-optimization) | Integer and Combinatorial Optimization | `integer-optimization` |
| D084 | [数值线性代数专家](domain-experts/optimization-computation.md#numerical-linear-algebra) | Numerical Linear Algebra | `numerical-linear-algebra` |
| D085 | [微分方程数值解专家](domain-experts/optimization-computation.md#numerical-differential-equations) | Numerical Differential Equations | `numerical-differential-equations` |
| D086 | [验证数值计算专家](domain-experts/optimization-computation.md#validated-numerics) | Validated Numerics | `validated-numerics` |
| D087 | [计算代数专家](domain-experts/optimization-computation.md#computational-algebra) | Computational Algebra | `computational-algebra` |
| D088 | [计算几何专家](domain-experts/optimization-computation.md#computational-geometry) | Computational Geometry | `computational-geometry` |
| D089 | [编码理论专家](domain-experts/optimization-computation.md#coding-theory) | Coding Theory | `coding-theory` |
| D090 | [计算复杂性专家](domain-experts/optimization-computation.md#computational-complexity) | Computational Complexity | `computational-complexity` |

### 数学基础与逻辑 / Foundations and logic

Axioms, formal systems, models, types, categories, orders and program meaning.

| ID | 专家 | Domain | Assignment name |
| --- | --- | --- | --- |
| D091 | [集合论专家](domain-experts/foundations.md#set-theory) | Set Theory | `set-theory` |
| D092 | [数理逻辑专家](domain-experts/foundations.md#mathematical-logic) | Mathematical Logic | `mathematical-logic` |
| D093 | [模型论专家](domain-experts/foundations.md#model-theory) | Model Theory | `model-theory` |
| D094 | [证明论专家](domain-experts/foundations.md#proof-theory) | Proof Theory | `proof-theory` |
| D095 | [可计算性理论专家](domain-experts/foundations.md#computability-theory) | Computability Theory | `computability-theory` |
| D096 | [类型论专家](domain-experts/foundations.md#type-theory) | Type Theory | `type-theory` |
| D097 | [范畴论专家](domain-experts/foundations.md#category-theory) | Category Theory | `category-theory` |
| D098 | [高阶范畴论专家](domain-experts/foundations.md#higher-category-theory) | Higher Category Theory | `higher-category-theory` |
| D099 | [序理论专家](domain-experts/foundations.md#order-theory) | Order Theory | `order-theory` |
| D100 | [程序语义与逻辑专家](domain-experts/foundations.md#program-semantics) | Program Semantics and Logic | `program-semantics` |
