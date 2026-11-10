export type InstalledLibraryLabels = {
  zh: { title: string; description: string };
  en: { title: string; description: string };
};

// Display text for the installed modules; release names and identities remain unchanged.
const labels: Record<string, InstalledLibraryLabels> = {
  'TheoremOS.Algebra.FiniteSums': {
    zh: { title: '有限和与差分', description: '望远镜求和、分部求和、等差与等比和，以及仿射递推的闭式和上界。' },
    en: { title: 'Finite sums and differences', description: 'Telescoping sums, summation by parts, arithmetic and geometric sums, and formulas and bounds for affine recurrences.' },
  },
  'TheoremOS.Algebra.PolynomialRoots': {
    zh: { title: '多项式根与插值', description: '根的数量界、由取值确定多项式、线性因子分解与插值的存在唯一性。' },
    en: { title: 'Polynomial roots and interpolation', description: 'Root counts, determination by sampled values, factorization into linear factors, and existence and uniqueness of interpolants.' },
  },
  'TheoremOS.Analysis.AsymptoticModuli': {
    zh: { title: '半范数的渐近模量', description: '有限余维闭子空间上的单侧与平均渐近模量，以及它们的上下界。' },
    en: { title: 'Asymptotic moduli of seminorms', description: 'One-sided and averaged moduli over closed subspaces of finite codimension, with upper and lower bounds.' },
  },
  'TheoremOS.Analysis.Daugavet': {
    zh: { title: 'Daugavet 性质与切片', description: '秩一算子的 Daugavet 范数等式，以及由此推出的单位球切片引理。' },
    en: { title: 'The Daugavet property and slices', description: 'The Daugavet norm equation for rank-one operators and its implication for slices of the unit ball.' },
  },
  'TheoremOS.Analysis.FiniteConvexity': {
    zh: { title: '有限凸组合与 Jensen 不等式', description: '加权平均与凸包、凸凹函数的 Jensen 不等式，以及严格凸情形的等号条件。' },
    en: { title: 'Finite convex combinations and Jensen inequalities', description: 'Weighted averages in convex hulls, Jensen inequalities for convex and concave functions, and strict-convexity equality conditions.' },
  },
  'TheoremOS.Analysis.FiniteInequalities': {
    zh: { title: '有限加权不等式', description: '加权 Cauchy 不等式、方差与协方差恒等式，以及有限乘积和均值的估计。' },
    en: { title: 'Weighted finite inequalities', description: 'Weighted Cauchy inequalities, variance and covariance identities, and estimates for finite products and means.' },
  },
  'TheoremOS.Analysis.LittlewoodPolynomial': {
    zh: { title: 'Littlewood 多项式与自相关', description: '单位圆上的二阶与四阶矩、非周期自相关，以及优值因子与模长偏差的关系。' },
    en: { title: 'Littlewood polynomials and autocorrelation', description: 'Second and fourth moments on the unit circle, aperiodic autocorrelations, and merit-factor bounds on deviations of the modulus.' },
  },
  'TheoremOS.Analysis.MetricDistortion': {
    zh: { title: '度量嵌入的失真', description: '有限度量嵌入的伸缩比与失真界，以及向 ℓ¹、ℓ² 空间传递的 Poincaré 不等式。' },
    en: { title: 'Distortion of metric embeddings', description: 'Expansion, contraction and distortion bounds for finite embeddings, with Poincaré inequalities transferred to ℓ¹ and ℓ² spaces.' },
  },
  'TheoremOS.BooleanCube.Fourier': {
    zh: { title: '布尔立方体上的 Fourier 分析', description: '字符、Fourier 展开、Parseval 恒等式，以及方差和 Fourier 次数。' },
    en: { title: 'Fourier analysis on the Boolean cube', description: 'Characters, Fourier expansion and Parseval identities, together with variance and Fourier degree.' },
  },
  'TheoremOS.BooleanCube.Hypercontractivity': {
    zh: { title: '超收缩与反集中', description: 'Bonami 四阶矩界、Paley–Zygmund 不等式，以及低次数函数的反集中估计。' },
    en: { title: 'Hypercontractivity and anticoncentration', description: 'Bonami fourth-moment bounds, the Paley–Zygmund inequality, and anticoncentration estimates for functions of low degree.' },
  },
  'TheoremOS.BooleanCube.Influence': {
    zh: { title: '布尔函数的坐标影响度', description: '位翻转导数与 Fourier 表达，以及总影响度和次数、方差的关系。' },
    en: { title: 'Coordinate influences of Boolean functions', description: 'Bit-flip derivatives and their Fourier formulas, with relations between total influence, degree and variance.' },
  },
  'TheoremOS.BooleanCube.LevelOne': {
    zh: { title: '一阶 Fourier 权重', description: '单坐标 Fourier 系数及其总量界，以及反单调布尔函数的系数与影响度关系。' },
    en: { title: 'First-level Fourier weight', description: 'Bounds on single-coordinate Fourier coefficients and their sums, with influence identities for antitone Boolean functions.' },
  },
  'TheoremOS.BooleanCube.Polynomial': {
    zh: { title: '布尔立方体上的多项式取值', description: '多元多项式在正负一输入上的取值、奇数支撑，以及 Fourier 次数与总次数的关系。' },
    en: { title: 'Polynomial evaluation on the Boolean cube', description: 'Multivariate polynomials on sign inputs, odd exponent supports, and bounds relating Fourier degree to total degree.' },
  },
  'TheoremOS.BooleanCube.Product': {
    zh: { title: '布尔函数的张量积', description: '独立坐标组上函数乘积的 Fourier 系数、次数与总影响度公式。' },
    en: { title: 'Tensor products of Boolean functions', description: 'Fourier coefficients, degree and total influence of products of functions on separate coordinate sets.' },
  },
  'TheoremOS.BooleanCube.Relabel': {
    zh: { title: '布尔坐标重标记', description: '坐标双射下的 Fourier 系数变换，以及次数、影响度和各类复杂度的不变性。' },
    en: { title: 'Relabeling Boolean coordinates', description: 'Fourier coefficient transformations under coordinate bijections and invariance of degree, influence and sensitivity measures.' },
  },
  'TheoremOS.BooleanCube.Sensitivity': {
    zh: { title: '敏感度与证书复杂度', description: '坐标块翻转、敏感度、块敏感度与证书复杂度的定义和相互界。' },
    en: { title: 'Sensitivity and certificate complexity', description: 'Coordinate-block flips, sensitivity, block sensitivity and certificate complexity, with bounds between these quantities.' },
  },
  'TheoremOS.Combinatorics.BinomialEntropy': {
    zh: { title: '二项系数的熵估计', description: '二项分布项的比较，以及用二元熵估计二项系数和累积二项和。' },
    en: { title: 'Entropy bounds for binomial coefficients', description: 'Comparisons of binomial probability terms and binary-entropy estimates for binomial coefficients and cumulative sums.' },
  },
  'TheoremOS.Combinatorics.EditDistance': {
    zh: { title: '编辑距离与最长公共子序列', description: '插入、删除和替换定义的编辑距离，以及距离性质和最长公共子序列界。' },
    en: { title: 'Edit distance and longest common subsequences', description: 'Edit distance from insertions, deletions and substitutions, its metric properties, and bounds using common subsequences.' },
  },
  'TheoremOS.Combinatorics.FiniteCounting': {
    zh: { title: '有限计数与双重计数', description: '纤维容量、关系度数、覆盖重数和交集大小的计数恒等式与界。' },
    en: { title: 'Finite counting and double counting', description: 'Counting identities and bounds for fibers, relation degrees, covering multiplicities and intersections.' },
  },
  'TheoremOS.Combinatorics.GraphIndependence': {
    zh: { title: '图的独立集与着色', description: '独立数与着色数、最大度和平均度的关系，以及无三角形图的度数界。' },
    en: { title: 'Independent sets and graph coloring', description: 'Relations between independence number, coloring, maximum and average degree, with degree bounds for triangle-free graphs.' },
  },
  'TheoremOS.Combinatorics.PerfectMatching': {
    zh: { title: '完美匹配与匹配多面体', description: '匹配指示向量的凸包、有效的度数与奇割约束，以及给定边际的最大熵分布。' },
    en: { title: 'Perfect matchings and their polytope', description: 'The convex hull of matching indicators, valid degree and odd-cut constraints, and maximum-entropy laws with fixed edge marginals.' },
  },
  'TheoremOS.Combinatorics.Ramsey': {
    zh: { title: '图 Ramsey 数', description: '团与独立集的 Ramsey 性质、对称性和单调性，以及递推与二项系数上界。' },
    en: { title: 'Graph Ramsey numbers', description: 'Clique-or-independent-set Ramsey properties, symmetry and monotonicity, and recursive and binomial upper bounds.' },
  },
  'TheoremOS.Combinatorics.RamseyLower': {
    zh: { title: 'Ramsey 数的概率下界', description: '通过有限图的边集计数排除大团和大独立集，得到对角 Ramsey 数下界。' },
    en: { title: 'Probabilistic lower bounds for Ramsey numbers', description: 'Edge-set counting to obtain graphs without large cliques or independent sets and lower bounds for diagonal Ramsey numbers.' },
  },
  'TheoremOS.Geometry.EuclideanCoordinates': {
    zh: { title: '欧氏空间的坐标公式', description: '范数、内积和距离的坐标表达，二维与三维公式，以及正交变换的不变性。' },
    en: { title: 'Coordinate formulas in Euclidean space', description: 'Coordinate expressions for norms, inner products and distances, including two and three dimensions and orthogonal invariance.' },
  },
  'TheoremOS.Geometry.EuclideanRamsey': {
    zh: { title: '欧氏 Ramsey 构型', description: '有限着色下的单色全等副本，以及维数扩张、等距映射和构型乘积的性质。' },
    en: { title: 'Euclidean Ramsey configurations', description: 'Monochromatic congruent copies under finite colorings, with dimension extension, isometries and products of configurations.' },
  },
  'TheoremOS.Geometry.TranslativeCovering': {
    zh: { title: '平移覆盖与装填', description: '平移覆盖数与装填数、凸体的体积估计，以及立方体和交叉多胞体的极性关系。' },
    en: { title: 'Translative coverings and packings', description: 'Covering and packing numbers, volumetric bounds for convex bodies, and polarity between cubes and cross-polytopes.' },
  },
  'TheoremOS.InformationTheory.Divergence': {
    zh: { title: '相对熵与分布差异', description: '相对熵的数据处理、Pinsker 与 Bretagnolle–Huber 不等式，以及卡方散度和互信息。' },
    en: { title: 'Relative entropy and distribution distances', description: 'Data processing for relative entropy, Pinsker and Bretagnolle–Huber inequalities, chi-squared divergence and mutual information.' },
  },
  'TheoremOS.InformationTheory.Entropy': {
    zh: { title: '有限分布的 Shannon 熵', description: '熵与相对熵的基本界、乘积分布和边际分布，以及映射下的熵变化。' },
    en: { title: 'Shannon entropy of finite distributions', description: 'Basic entropy and relative-entropy bounds, product and marginal distributions, and entropy under pushforward maps.' },
  },
  'TheoremOS.InformationTheory.Shearer': {
    zh: { title: 'Shearer 不等式与投影计数', description: '次模函数和联合熵的 Shearer、Han 不等式，以及 Loomis–Whitney 投影计数界。' },
    en: { title: 'Shearer inequalities and projection counts', description: 'Shearer and Han inequalities for submodular functions and joint entropy, with Loomis–Whitney bounds on projection counts.' },
  },
  'TheoremOS.LinearAlgebra.DensityMatrix': {
    zh: { title: '密度矩阵与量子测量概率', description: '半正定与迹一条件、Kraus 变换、张量积测量概率，以及左右部分迹。' },
    en: { title: 'Density matrices and measurement probabilities', description: 'Positivity and unit-trace conditions, Kraus transformations, tensor-product measurement probabilities, and partial traces.' },
  },
  'TheoremOS.LinearAlgebra.GramMatrix': {
    zh: { title: 'Gram 矩阵与最小二乘', description: 'Gram 矩阵的正定性、核与行列式，以及正规方程和最小二乘解的性质。' },
    en: { title: 'Gram matrices and least squares', description: 'Positivity, kernels and determinants of Gram matrices, with normal equations and properties of least-squares solutions.' },
  },
  'TheoremOS.LinearAlgebra.NumericalRange': {
    zh: { title: '算子的数值域与数值半径', description: '数值域的凸性、有限维紧性与酉不变性，以及数值半径和算子范数的比较。' },
    en: { title: 'Numerical ranges and radii of operators', description: 'Convexity, finite-dimensional compactness and unitary invariance of numerical ranges, with numerical-radius and operator-norm bounds.' },
  },
  'TheoremOS.LinearAlgebra.Pauli': {
    zh: { title: 'Pauli 矩阵与张量积基', description: 'Pauli 矩阵及其张量积的乘法、迹正交性、展开式，以及对易或反对易关系。' },
    en: { title: 'Pauli matrices and tensor-product bases', description: 'Multiplication, trace orthogonality and expansions for Pauli matrices and strings, including commutation and anticommutation.' },
  },
  'TheoremOS.LinearAlgebra.PiTensor': {
    zh: { title: '有限矩阵张量积', description: '多因子矩阵张量积的乘法、迹与正性，以及单位置算子和置换算子。' },
    en: { title: 'Tensor products of finite matrices', description: 'Multiplication, traces and positivity of matrix tensor products, together with single-site and permutation operators.' },
  },
  'TheoremOS.LinearAlgebra.VonNeumannEntropy': {
    zh: { title: 'von Neumann 熵', description: '密度矩阵的谱熵、非负性与维数上界、酉不变性，以及混合后的熵差界。' },
    en: { title: 'Von Neumann entropy', description: 'Spectral entropy of density matrices, positivity and dimension bounds, unitary invariance, and entropy-difference bounds for mixtures.' },
  },
  'TheoremOS.NumberTheory.Congruences': {
    zh: { title: '同余与中国剩余定理', description: '自然数与整数的同余消去、中国剩余解的唯一性，以及幂的周期与指数约化。' },
    en: { title: 'Congruences and the Chinese remainder theorem', description: 'Cancellation in natural and integer congruences, uniqueness of Chinese remainder solutions, and periods and exponent reduction for powers.' },
  },
  'TheoremOS.NumberTheory.Divisibility': {
    zh: { title: '整除与互素', description: '互素因子的乘积与幂的整除消去，以及素数存在性和幂差的整除性质。' },
    en: { title: 'Divisibility and coprimality', description: 'Divisibility and cancellation for coprime products and powers, existence of new primes, and divisibility of differences of powers.' },
  },
  'TheoremOS.Probability.BiasedProduct': {
    zh: { title: '偏置乘积测度', description: '随机子集与布尔配置的乘积权重、Harris 正相关不等式，以及关于偏置参数的导数。' },
    en: { title: 'Biased product measures', description: 'Product weights on random subsets and Boolean configurations, Harris positive correlation, and derivatives with respect to the bias.' },
  },
  'TheoremOS.Probability.Concentration': {
    zh: { title: '乘积测度的集中不等式', description: '指数矩方法、偏置随机子集的 Hoeffding 尾界，以及二元相对熵形式的尾估计。' },
    en: { title: 'Concentration for product measures', description: 'Exponential-moment bounds, Hoeffding tails for biased random subsets, and tail estimates using binary relative entropy.' },
  },
  'TheoremOS.Probability.Coupling': {
    zh: { title: '概率耦合与路径耦合', description: '最大耦合、全变差界和运输代价，以及路径耦合导出的马尔可夫链收敛界。' },
    en: { title: 'Couplings and path coupling', description: 'Maximal couplings, total-variation and transport bounds, and Markov-chain convergence estimates from path coupling.' },
  },
  'TheoremOS.Probability.Dobrushin': {
    zh: { title: 'Dobrushin 收缩系数', description: '转移矩阵的全变差收缩系数、乘积与幂的界，以及平稳分布唯一性和收敛估计。' },
    en: { title: 'Dobrushin contraction coefficients', description: 'Total-variation contraction for transition matrices, bounds for products and powers, and stationary uniqueness and convergence estimates.' },
  },
  'TheoremOS.Probability.FiniteMoments': {
    zh: { title: '有限分布的矩与协方差', description: '期望与协方差的运算、方差分解，以及和、有界变量和指示变量的方差界。' },
    en: { title: 'Moments and covariance of finite distributions', description: 'Expectation and covariance identities, variance decompositions, and bounds for sums, bounded variables and indicators.' },
  },
  'TheoremOS.Probability.FiniteProbability': {
    zh: { title: '有限概率与全变差距离', description: '有限分布的期望、Markov 与 Chebyshev 不等式，以及全变差和随机转移矩阵。' },
    en: { title: 'Finite probability and total variation', description: 'Expectations, Markov and Chebyshev inequalities for finite laws, with total variation and stochastic transition matrices.' },
  },
  'TheoremOS.Probability.GaussianIBP': {
    zh: { title: '高斯积分分部公式', description: '一维与多元高斯分布的积分分部、增长条件下的可积性，以及高斯矩递推。' },
    en: { title: 'Gaussian integration by parts', description: 'Integration by parts for one-dimensional and multivariate Gaussians, integrability under growth bounds, and Gaussian moment recurrences.' },
  },
  'TheoremOS.Probability.LocalLemma': {
    zh: { title: 'Lovász 局部引理', description: '偏依赖条件与对称形式的局部引理，以及乘积空间中由坐标依赖建立的条件。' },
    en: { title: 'The Lovász local lemma', description: 'Lopsided dependency and symmetric local-lemma bounds, with dependency conditions built from coordinates of product spaces.' },
  },
  'TheoremOS.Probability.MixingLowerBound': {
    zh: { title: '马尔可夫链混合下界', description: '由特征函数、瓶颈比和条件分布得到的全变差下界，以及均值与方差区分界。' },
    en: { title: 'Lower bounds on Markov-chain mixing', description: 'Total-variation lower bounds from eigenfunctions, bottlenecks and conditional laws, with mean-and-variance distinguishing bounds.' },
  },
  'TheoremOS.Probability.RandomKSAT': {
    zh: { title: '随机 k-SAT 的计数与概率', description: '子句与满足赋值的计数、可满足公式比例的矩界，以及无限随机子句流。' },
    en: { title: 'Counting and probability for random k-SAT', description: 'Counts of clauses and satisfying assignments, moment bounds on satisfiable formulas, and infinite streams of random clauses.' },
  },
  'TheoremOS.Probability.RandomKSATThreshold': {
    zh: { title: '随机 k-SAT 的一阶矩阈值上界', description: '一阶矩临界密度，以及高于该密度时可满足公式比例与可满足概率趋于零。' },
    en: { title: 'First-moment upper bounds for random k-SAT', description: 'The first-moment density and decay of the satisfiable fraction and probability above that density.' },
  },
  'TheoremOS.Probability.SpectralGap': {
    zh: { title: '谱隙与马尔可夫链收敛', description: 'Dirichlet 型与方差收缩、全变差收敛界，以及通过路径计数估计谱隙。' },
    en: { title: 'Spectral gaps and Markov-chain convergence', description: 'Dirichlet forms, variance contraction and total-variation convergence bounds, with spectral-gap estimates from paths.' },
  },
  'TheoremOS.Probability.SphereLaw': {
    zh: { title: '球面均匀分布与高斯归一化', description: '球面概率测度、内积的二阶矩，以及标准高斯向量归一化后的球面分布。' },
    en: { title: 'Uniform sphere laws and normalized Gaussians', description: 'Sphere probability measures, second moments of inner products, and the sphere law obtained by normalizing a standard Gaussian.' },
  },
  'TheoremOS.Probability.TreeReconstruction': {
    zh: { title: '树上广播与重构优势', description: '树上广播观测、重构优势的单调性、Potts 信道，以及计数统计量的矩恒等式。' },
    en: { title: 'Broadcasting on trees and reconstruction advantage', description: 'Tree broadcast observations, monotonicity of reconstruction advantage, Potts channels, and moment identities for census statistics.' },
  },
  'TheoremOS.RepresentationTheory.GroupFourier': {
    zh: { title: '有限群上的 Fourier 变换', description: '群卷积与表示上的 Fourier 变换、群平均投影，以及酉表示的 Hilbert–Schmidt 估计。' },
    en: { title: 'Fourier transforms on finite groups', description: 'Group convolution and representation-valued Fourier transforms, averaging projections, and Hilbert–Schmidt bounds for unitary representations.' },
  },
  'TheoremOS.RepresentationTheory.Plancherel': {
    zh: { title: '有限群的 Plancherel 与反演', description: '矩阵系数正交性、完备表示族的 Plancherel 恒等式与 Fourier 反演，以及卷积幂的全变差界。' },
    en: { title: 'Plancherel and inversion on finite groups', description: 'Matrix-coefficient orthogonality, Plancherel and Fourier inversion for complete representation families, and total-variation bounds for convolution powers.' },
  },
};

export function installedLibraryLabels(name: string): InstalledLibraryLabels | undefined {
  return Object.hasOwn(labels, name) ? labels[name] : undefined;
}
