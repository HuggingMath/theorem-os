import type { ProofWalkthrough } from './proofWalkthroughTypes';

const text = (zh: string, en: string) => ({ zh, en });

export const additionalProofWalkthroughs: ProofWalkthrough[] = [
  {
    recordId: 'openai_three_state_tree_clauses',
    runId: 'cea8d7e2-84e6-4591-af14-2c9a82d37eef',
    proofSha256: '06189f1bd81a78cf11435926017ecbb07bb62a135d5275b68da0026dc97d2d8a',
    title: text(
      '利用中心化一二阶矩与全变差下界证明三态树广播的可重构性',
      'Reconstructibility of three-state tree broadcasts via centered moments and total variation',
    ),
    strategy: text(
      '选取零均值的通道特征函数 $\\varphi(i) = \\mathbf{1}_{i=0} - 1/3$，将深度 $n$ 处的叶节点统计转化为带号计数量 $S_n = X_n - Z_n/3$。在 Kesten–Stigum 条件 $m\\lambda^2 > 1$ 下，一阶矩按 $(m\\lambda)^n$ 指数增长，而二阶矩递归满足 $\\mathbb{E}[S_n^2 \\mid \\text{root}=i] \\le C (m\\lambda)^{2n}$。对不同根节点状态 $0$ 与 $1$ 的期望差应用 Cauchy–Schwarz 不等式，得到观测分布的全变差与重构优势的一直正下界 $A_n \\ge 1/(12C)$，最终由单调性与库定理导出正则树与 Poisson 树上的可重构性。',
      'Using the centered channel eigenfunction $\\varphi(i) = \\mathbf{1}_{i=0} - 1/3$, we encode leaf counts at depth $n$ via the signed census $S_n = X_n - Z_n/3$. Above the Kesten–Stigum threshold $m\\lambda^2 > 1$, the first moment grows as $(m\\lambda)^n$ while the second moment satisfies the uniform bound $\\mathbb{E}[S_n^2 \\mid \\text{root}=i] \\le C (m\\lambda)^{2n}$. Applying Cauchy–Schwarz to the mean gap between roots $0$ and $1$ yields a uniform total-variation and advantage lower bound $A_n \\ge 1/(12C)$, which by monotonicity and the library reconstruction bridge establishes reconstructibility for both regular and Poisson Galton–Watson trees.',
    ),
    stages: [
      {
        title: text('建立三态通道、Poisson 后代律与叶节点计数', 'Set up the three-state channel, Poisson law, and leaf census'),
        summary: text(
          '验证通道转移矩阵的随机性与特征函数 $\\varphi$，构造 Poisson 后代概率测度，并将分支树观测律与深度 $n$ 处的计数对 $(X_n, Z_n)$ 对接。',
          'Verify stochasticity and the eigenfunction $\\varphi$ of the channel, construct the Poisson offspring distribution, and connect the broadcast observation law to the depth-$n$ census pair $(X_n, Z_n)$.',
        ),
        stepIds: ['channel-and-eigenfunction', 'poisson-offspring-law', 'broadcast-and-census'],
      },
      {
        title: text('在 Kesten-Stigum 阈值之上推导一阶与二阶矩界', 'Derive first and second moment bounds above Kesten-Stigum'),
        summary: text(
          '沿树深度递归计算 $S_n = X_n - Z_n/3$ 的条件一阶矩 $(m\\lambda)^n \\varphi(i)$ 与条件二阶矩递推式，并在 $m\\lambda^2 > 1$ 时选取一致常数 $C > 0$ 控制增长率。',
          'Propagate the conditional first moment $(m\\lambda)^n \\varphi(i)$ and second-moment recursion of $S_n = X_n - Z_n/3$ across depth, and choose a uniform constant $C > 0$ whenever $m\\lambda^2 > 1$.',
        ),
        stepIds: ['first-moment-propagation', 'second-moment-recursion', 'uniform-second-moment-bound'],
      },
      {
        title: text('从全变差与优势下界完成两类树的可重构性', 'Conclude reconstructibility from total variation and advantage bounds'),
        summary: text(
          '用 Cauchy–Schwarz 不等式将矩估计转化为观测律全变差下界 $\\ge 1/(4C)$ 与重构优势下界 $A_n \\ge 1/(12C)$，再代入正则树与 Poisson 树的一二阶矩即得目标定理。',
          'Convert the moment bounds via Cauchy–Schwarz into a total-variation bound $\\ge 1/(4C)$ and advantage bound $A_n \\ge 1/(12C)$, then specialize to regular and Poisson offspring laws.',
        ),
        stepIds: ['tv-and-advantage-lower-bound', 'monotone-convergence-to-reconstruction'],
      },
    ],
    goal: text(
      '证明对称三态 Potts 通道权重的非负性与归一化性质、Poisson 后代权重的非负性与总质量为 $1$，以及当 $b\\lambda^2 > 1$ 与 $d\\lambda^2 > 1$ 时，$b$-正则树与均值 $d$ 的 Poisson Galton–Watson 树均具有可重构性。',
      'Prove nonnegativity and unit sum for the symmetric three-state Potts channel weights, nonnegativity and unit mass for the Poisson offspring weights, and reconstructibility on $b$-ary regular trees ($b\\lambda^2 > 1$) and mean-$d$ Poisson Galton–Watson trees ($d\\lambda^2 > 1$).',
    ),
    notation: text(
      '状态空间为 $\\mathrm{Spin} = \\{0,1,2\\}$，允许参数 $\\lambda \\in [-1/2, 1]$。通道转移权重为 $W_\\lambda(i,j) = (1+2\\lambda)/3$（若 $i=j$）及 $(1-\\lambda)/3$（若 $i\\ne j$）。对后代律 $\\nu$，令 $m = \\mathbb{E}[N]$ 与 $\\beta = \\mathbb{E}[N(N-1)]$；深度 $n$ 的观测记为 $O_n$，带号计数量记为 $S_n = X_n - Z_n/3$。',
      'The state space is $\\mathrm{Spin} = \\{0,1,2\\}$ with admissible parameter $\\lambda \\in [-1/2, 1]$. The channel weights are $W_\\lambda(i,j) = (1+2\\lambda)/3$ for $i=j$ and $(1-\\lambda)/3$ for $i\\ne j$. For an offspring law $\\nu$, let $m = \\mathbb{E}[N]$ and $\\beta = \\mathbb{E}[N(N-1)]$; depth-$n$ observations are $O_n$ and the signed census is $S_n = X_n - Z_n/3$.',
    ),
    steps: [
      {
        id: 'channel-and-eigenfunction',
        title: text('验证三态通道随机性与中心化特征函数', 'Verify three-state channel stochasticity and centered eigenfunction'),
        given: text(
          '参数 $\\lambda \\in [-1/2, 1]$ 满足 $\\mathrm{Admissible}(\\lambda)$，通道权重定义为 $W_\\lambda(i,j) = (1+2\\lambda)/3$（$i=j$）与 $(1-\\lambda)/3$（$i\\ne j$）。',
          'The parameter $\\lambda \\in [-1/2, 1]$ satisfies $\\mathrm{Admissible}(\\lambda)$, and $W_\\lambda(i,j)$ equals $(1+2\\lambda)/3$ when $i=j$ and $(1-\\lambda)/3$ otherwise.',
        ),
        claim: text(
          '对任意 $i,j \\in \\{0,1,2\\}$ 有 $W_\\lambda(i,j) \\ge 0$ 与 $\\sum_j W_\\lambda(i,j) = 1$，且中心化指示函数 $\\varphi(j) = \\mathbf{1}_{j=0} - 1/3$ 满足 $\\sum_j W_\\lambda(i,j)\\varphi(j) = \\lambda \\varphi(i)$。',
          'For all $i,j \\in \\{0,1,2\\}$, $W_\\lambda(i,j) \\ge 0$ and $\\sum_j W_\\lambda(i,j) = 1$, while $\\varphi(j) = \\mathbf{1}_{j=0} - 1/3$ satisfies $\\sum_j W_\\lambda(i,j)\\varphi(j) = \\lambda \\varphi(i)$.',
        ),
        because: text(
          '在三元有限和上按 $i=0,1,2$ 分情况展开即可直接消去对称项，同时由 $W_\\lambda \\ge 0$ 与行和为 $1$ 构造出合法的 $\\mathrm{PMF}(\\mathrm{Spin})$。',
          'Case analysis on $i \\in \\{0,1,2\\}$ over the three-term sum cancels the off-diagonal terms directly, and nonnegativity plus row-sum $1$ packages $W_\\lambda(i,\\cdot)$ into a $\\mathrm{PMF}(\\mathrm{Spin})$.',
        ),
        dependsOn: [],
        derivation: [
          {
            statement: text(
              '由 $-1/2 \\le \\lambda \\le 1$ 得 $(1+2\\lambda)/3 \\ge 0$ 且 $(1-\\lambda)/3 \\ge 0$，即 $W_\\lambda(i,j) \\ge 0$。',
              'Since $-1/2 \\le \\lambda \\le 1$, both $(1+2\\lambda)/3 \\ge 0$ and $(1-\\lambda)/3 \\ge 0$, so $W_\\lambda(i,j) \\ge 0$.',
            ),
            reason: text(
              '对应引理 `channelWeight_nonneg`，线性不等式直接覆盖对角与非对角两种情形。',
              'By `channelWeight_nonneg`, linear arithmetic resolves both diagonal and off-diagonal branches.',
            ),
          },
          {
            statement: text(
              '对每个 $i \\in \\{0,1,2\\}$ 有 $\\sum_{j=0}^2 W_\\lambda(i,j) = \\frac{1+2\\lambda}{3} + 2\\cdot\\frac{1-\\lambda}{3} = 1$。',
              'For each $i \\in \\{0,1,2\\}$, $\\sum_{j=0}^2 W_\\lambda(i,j) = \\frac{1+2\\lambda}{3} + 2\\cdot\\frac{1-\\lambda}{3} = 1$.',
            ),
            reason: text(
              '对应引理 `channelWeight_sum`，从而可定义概率质量函数 `channel lam hlam i`。',
              'By `channelWeight_sum`, allowing the definition of `channel lam hlam i : PMF Spin`.',
            ),
          },
          {
            statement: text(
              '中心化函数 $\\varphi(j) = \\mathbf{1}_{j=0} - 1/3$ 满足 $\\sum_{j=0}^2 W_\\lambda(i,j)\\varphi(j) = \\lambda \\varphi(i)$。',
              'The centered function $\\varphi(j) = \\mathbf{1}_{j=0} - 1/3$ satisfies $\\sum_{j=0}^2 W_\\lambda(i,j)\\varphi(j) = \\lambda \\varphi(i)$.',
            ),
            reason: text(
              '对应引理 `channelWeight_centred_eigen`：当 $i=0$ 时给出 $\\frac{2}{3}\\lambda$，当 $i\\ne 0$ 时给出 $-\\frac{1}{3}\\lambda$。',
              'By `channelWeight_centred_eigen`, yielding $\\frac{2}{3}\\lambda$ for $i=0$ and $-\\frac{1}{3}\\lambda$ for $i\\ne 0$.',
            ),
          },
        ],
        next: text(
          '接下来固定 Poisson 后代权重与一般广播律下的叶节点计数量。',
          'Next, establish the Poisson offspring distribution and the leaf-census representation of the broadcast law.',
        ),
        evidence: {
          theorems: [
            'OAI.ThreeState.TreeClauses.channelWeight_nonneg',
            'OAI.ThreeState.TreeClauses.channelWeight_sum',
            'OAI.ThreeState.TreeClauses.channelWeight_centred_eigen',
            'OAI.ThreeState.TreeClauses.channel',
          ],
          taskIds: ['initial_goal_1', 'initial_goal_2', 'ts_f_channelWeight_centred_eigen'],
          checkIds: ['check-42399fed06244ce0d2a3'],
          source: { name: 'Submission.lean', line: 19, endLine: 36 },
        },
      },
      {
        id: 'poisson-offspring-law',
        title: text('验证 Poisson 后代权重的非负性与总质量', 'Verify nonnegativity and total mass of Poisson offspring weights'),
        given: text(
          '对任意非负实数参数 $d \\in \\mathbb{R}_{\\ge 0}$ 与自然数 $k \\in \\mathbb{N}$，定义权重 $w_d(k) = e^{-d} d^k / k!$。',
          'For any $d \\in \\mathbb{R}_{\\ge 0}$ and $k \\in \\mathbb{N}$, define the weight $w_d(k) = e^{-d} d^k / k!$.',
        ),
        claim: text(
          '所有权重均满足 $w_d(k) \\ge 0$，且无穷级数满足 $\\sum_{k=0}^\\infty w_d(k) = 1$，从而构成合法的离散概率分布 `poissonPMF d`。',
          'Each weight satisfies $w_d(k) \\ge 0$ and the infinite series satisfies $\\sum_{k=0}^\\infty w_d(k) = 1$, defining a valid distribution `poissonPMF d`.',
        ),
        because: text(
          '指数函数与非负实数的幂次、阶乘皆非负，而标准指数幂级数 $\\sum_{k=0}^\\infty d^k / k! = e^d$ 恰好与前置因子 $e^{-d}$ 相消。',
          'Exponentials, powers of nonnegative reals, and factorials are all nonnegative, and the exponential Taylor series $\\sum_{k=0}^\\infty d^k / k! = e^d$ cancels the prefactor $e^{-d}$.',
        ),
        dependsOn: [],
        derivation: [
          {
            statement: text(
              '对所有 $d \\ge 0$ 与 $k \\in \\mathbb{N}$，有 $\\mathrm{poissonWeight}(d,k) = e^{-d} d^k / k! \\ge 0$。',
              'For all $d \\ge 0$ and $k \\in \\mathbb{N}$, $\\mathrm{poissonWeight}(d,k) = e^{-d} d^k / k! \\ge 0$.',
            ),
            reason: text(
              '对应目标 `Probability.poissonWeight_nonneg`，由指数正性与非负实数的除法封闭性立即得到。',
              'Proved in `Probability.poissonWeight_nonneg` from positivity of $\\exp$ and nonnegativity of $d^k / k!$.',
            ),
          },
          {
            statement: text(
              '无穷和满足 $\\sum_{k \\in \\mathbb{N}} \\mathrm{poissonWeight}(d,k) = 1$。',
              'The infinite sum satisfies $\\sum_{k \\in \\mathbb{N}} \\mathrm{poissonWeight}(d,k) = 1$.',
            ),
            reason: text(
              '对应目标 `Probability.poissonWeight_mass`，由库定理 `TheoremOS.Probability.tsum_poissonWeight` 直接给出，并据此构造 `poissonPMF d`。',
              'Proved in `Probability.poissonWeight_mass` via `TheoremOS.Probability.tsum_poissonWeight`, yielding `poissonPMF d`.',
            ),
          },
        ],
        next: text(
          '这一后代概率律将在最后一步与一致优势下界结合，导出 Poisson 树的可重构性。',
          'This offspring distribution will be combined in the final stage with the uniform advantage lower bound.',
        ),
        evidence: {
          theorems: [
            'OAI.ThreeState.TreeClauses.Probability.poissonWeight_nonneg',
            'OAI.ThreeState.TreeClauses.Probability.poissonWeight_mass',
            'OAI.ThreeState.TreeClauses.poissonPMF',
          ],
          taskIds: ['initial_goal_3', 'initial_goal_4'],
          checkIds: ['check-42399fed06244ce0d2a3'],
          source: { name: 'Submission.lean', line: 122, endLine: 134 },
        },
      },
      {
        id: 'broadcast-and-census',
        title: text('将观测分布对接广播律并构造有限叶计数对', 'Bridge observation laws to broadcast laws and finite leaf censuses'),
        given: text(
          '给定树广播观测族 `observationLaw lam hlam offspring`，在深度 $0$ 处为 `PMF.pure i`，在深度 $\\ell+1$ 处按 `offspring` 抽样分支数并对各子节点独立递归采样。',
          'Given `observationLaw lam hlam offspring`, depth $0$ is `PMF.pure i` and depth $\\ell+1$ draws the branching count from `offspring` and samples i.i.d. child observations.',
        ),
        claim: text(
          '该观测族满足 `IsBroadcastLaw` 递归结构；同时存在一对非负叶计数量 $X, Z : (\\ell:\\mathbb{N}) \\to O_\\ell \\to \\mathbb{N}$，满足递归可加性与多项式上界，使带号计数 $S_\\ell = X_\\ell - Z_\\ell/3$ 具有有限二阶矩。',
          'This family satisfies `IsBroadcastLaw`; moreover, there exist nonnegative leaf-census functionals $X, Z : (\\ell:\\mathbb{N}) \\to O_\\ell \\to \\mathbb{N}$ that add over multiset children and satisfy polynomial size bounds, ensuring finite second moments for $S_\\ell = X_\\ell - Z_\\ell/3$.',
        ),
        because: text(
          '令 $X_\\ell$ 统计深度 $\\ell$ 处处于状态 $0$ 的叶节点总数，$Z_\\ell$ 统计深度 $\\ell$ 处的总叶节点数，则两者对子多重集均为线性可加泛函，且可由深度 $0$ 处的值唯一确定。',
          'Taking $X_\\ell$ to count leaves in state $0$ and $Z_\\ell$ to count total leaves at depth $\\ell$ makes both additive over child multisets, with finite-moment growth controlled by induction on $\\ell$.',
        ),
        dependsOn: ['channel-and-eigenfunction'],
        derivation: [
          {
            statement: text(
              '`observationLaw` 满足 `TheoremOS.Probability.IsBroadcastLaw`，即对任意深度 $\\ell+1$ 可分解为后代分布与独立同分布子观测的绑定。',
              '`observationLaw` satisfies `TheoremOS.Probability.IsBroadcastLaw`, decomposing depth $\\ell+1$ into offspring branching and i.i.d. child subtrees.',
            ),
            reason: text(
              '对应 `isBroadcastLaw_observationLaw`，由此可直接套用库中的广播律乘积和引理。',
              'Established by `isBroadcastLaw_observationLaw`, unlocking the library broadcast-law expectation identities.',
            ),
          },
          {
            statement: text(
              '存在计数对 $(X, Z)$，在深度 $0$ 处有 $X_0(i) = \\mathbf{1}_{i=0}$、$Z_0(i) = 1$，在深度 $\\ell+1$ 处对多重集 $M$ 满足 $X_{\\ell+1}(M) = \\sum_{o \\in M} X_\\ell(o)$ 与 $Z_{\\ell+1}(M) = \\sum_{o \\in M} Z_\\ell(o)$。',
              'There exists a pair $(X, Z)$ with $X_0(i) = \\mathbf{1}_{i=0}$, $Z_0(i) = 1$, and multiset additivity $X_{\\ell+1}(M) = \\sum_{o \\in M} X_\\ell(o)$ and $Z_{\\ell+1}(M) = \\sum_{o \\in M} Z_\\ell(o)$.',
            ),
            reason: text(
              '对应 `exists_census_pair`，因此带号计数量 $S_\\ell = X_\\ell - Z_\\ell/3$ 在深度 $0$ 处恰好等于特征函数 $\\varphi(i)$。',
              'Established by `exists_census_pair`, so $S_\\ell = X_\\ell - Z_\\ell/3$ equals $\\varphi(i)$ at depth $0$.',
            ),
          },
          {
            statement: text(
              '在 `census_finite_le` 下，任意叶计数泛函在深度 $\\ell$ 处的各阶矩均可由后代分布的对应矩有限控制。',
              'Under `census_finite_le`, expectations of leaf-census products at depth $\\ell$ are finite whenever the offspring distribution has finite corresponding moments.',
            ),
            reason: text(
              '由 `census_finite_le` 在 $\\ell$ 上归纳得到，保证后续所有无穷求和的收敛性与可交换性。',
              'Proved by induction on $\\ell$ in `census_finite_le`, justifying all later `tsum` exchanges.',
            ),
          },
        ],
        next: text(
          '有了可加叶计数与特征函数 $\\varphi$，下一步计算 $S_\\ell$ 的条件一阶矩。',
          'With additive leaf counts and $\\varphi$ in place, we next compute the conditional first moment of $S_\\ell$.',
        ),
        evidence: {
          theorems: [
            'OAI.ThreeState.TreeClauses.isBroadcastLaw_observationLaw',
            'OAI.ThreeState.TreeClauses.exists_census_pair',
            'OAI.ThreeState.TreeClauses.census_finite_le',
          ],
          taskIds: ['ts_bridge_isBroadcastLaw_observationLaw', 'ts_census_pair_exists', 'ts_census_finite_le'],
          checkIds: ['check-42399fed06244ce0d2a3'],
          source: { name: 'Submission.lean', line: 81, endLine: 150 },
        },
      },
      {
        id: 'first-moment-propagation',
        title: text('推导状态计数、总叶数与带号计数的一阶矩', 'Propagate conditional first moments of state, total, and signed censuses'),
        given: text(
          '后代分布 `offspring` 具有有限均值 $m = \\mathbb{E}[N]$ 与有限二阶阶乘矩 $\\beta = \\mathbb{E}[N(N-1)]$，且 $\\lambda$ 满足 $\\mathrm{Admissible}(\\lambda)$。',
          'The offspring law `offspring` has mean $m = \\mathbb{E}[N]$ and second factorial moment $\\beta = \\mathbb{E}[N(N-1)]$, with $\\mathrm{Admissible}(\\lambda)$.',
        ),
        claim: text(
          '对任意深度 $\\ell$ 与根节点状态 $i \\in \\{0,1,2\\}$，有 $\\mathbb{E}_i[Z_\\ell] = m^\\ell$、$\\mathbb{E}_i[X_\\ell] = \\frac{1}{3}m^\\ell + (m\\lambda)^\\ell \\varphi(i)$，因而 $\\mathbb{E}_i[S_\\ell] = (m\\lambda)^\\ell \\varphi(i)$。',
          'For every depth $\\ell$ and root state $i \\in \\{0,1,2\\}$, $\\mathbb{E}_i[Z_\\ell] = m^\\ell$ and $\\mathbb{E}_i[X_\\ell] = \\frac{1}{3}m^\\ell + (m\\lambda)^\\ell \\varphi(i)$, hence $\\mathbb{E}_i[S_\\ell] = (m\\lambda)^\\ell \\varphi(i)$.',
        ),
        because: text(
          '按深度 $\\ell$ 归纳：在根节点处分支出期望 $m$ 个子节点，每个子节点先按通道 $W_\\lambda(i,j)$ 转移，再由线性性分别对常数分量 $1/3$ 与特征分量 $\\varphi(j)$ 求和。',
          'By induction on $\\ell$: a root of spin $i$ spawns $m$ expected children, each transitioning via $W_\\lambda(i,j)$; linearity separates the stationary part $1/3$ from the eigenmode $\\varphi(j)$.',
        ),
        dependsOn: ['broadcast-and-census'],
        derivation: [
          {
            statement: text(
              '总叶数期望满足 $\\sum_{o} P_\\ell(i,o) Z_\\ell(o) = \\mathrm{ofReal}(m^\\ell)$。',
              'The total-leaf expectation satisfies $\\sum_{o} P_\\ell(i,o) Z_\\ell(o) = \\mathrm{ofReal}(m^\\ell)$.',
            ),
            reason: text(
              '对应引理 `totalCensus_moment`：每向下一层，所有通道转移权重之和为 $1$，仅剩平均分支数 $m$ 的因子。',
              'By `totalCensus_moment`: row sums of $W_\\lambda$ equal $1$, leaving only a factor of $m$ at each level.',
            ),
          },
          {
            statement: text(
              '状态 $0$ 叶数期望满足 $\\sum_{o} P_\\ell(i,o) X_\\ell(o) = \\mathrm{ofReal}\\bigl(\\frac{1}{3}m^\\ell + (m\\lambda)^\\ell \\varphi(i)\\bigr)$。',
              'The state-$0$ leaf expectation satisfies $\\sum_{o} P_\\ell(i,o) X_\\ell(o) = \\mathrm{ofReal}\\bigl(\\frac{1}{3}m^\\ell + (m\\lambda)^\\ell \\varphi(i)\\bigr)$.',
            ),
            reason: text(
              '对应引理 `stateCensus_moment`：利用 `channelWeight_centred_eigen` 使特征部分每层多乘一个 $\\lambda$。',
              'By `stateCensus_moment`, using `channelWeight_centred_eigen` to multiply the centered mode by $\\lambda$ per level.',
            ),
          },
          {
            statement: text(
              '消去共同的 $\\frac{1}{3}m^\\ell$ 项后，带号计数量在 $\\mathbb{R}$ 上给出 $\\mathbb{E}_i[S_\\ell] = (m\\lambda)^\\ell \\varphi(i)$，从而 $\\mathbb{E}_0[S_\\ell] - \\mathbb{E}_1[S_\\ell] = (m\\lambda)^\\ell$。',
              'Canceling $\\frac{1}{3}m^\\ell$ gives $\\mathbb{E}_i[S_\\ell] = (m\\lambda)^\\ell \\varphi(i)$ in $\\mathbb{R}$, so $\\mathbb{E}_0[S_\\ell] - \\mathbb{E}_1[S_\\ell] = (m\\lambda)^\\ell$.',
            ),
            reason: text(
              '对应引理 `signedCensus_moment_data`，将 `ENNReal` 矩公式转为可直接相减的实数期望恒等式。',
              'By `signedCensus_moment_data`, translating the `ENNReal` moments into real-valued expectations.',
            ),
          },
        ],
        next: text(
          '接下来递归计算 $S_\\ell^2$ 的条件二阶矩，用于后续 Cauchy–Schwarz 方差控制。',
          'Next, we compute the conditional second moment of $S_\\ell$ recursively to control variance in Cauchy–Schwarz.',
        ),
        evidence: {
          theorems: [
            'OAI.ThreeState.TreeClauses.stateCensus_moment',
            'OAI.ThreeState.TreeClauses.totalCensus_moment',
            'OAI.ThreeState.TreeClauses.signedCensus_moment_data',
          ],
          taskIds: ['ts_a1_totalCensus_moment', 'ts_a2_stateCensus_moment', 'ts_a_signedCensus_moment_data'],
          checkIds: ['check-42399fed06244ce0d2a3'],
          source: { name: 'Submission.lean', line: 201, endLine: 486 },
        },
      },
      {
        id: 'second-moment-recursion',
        title: text('建立带号计数的条件二阶矩递推公式', 'Establish the conditional second-moment recursion for the signed census'),
        given: text(
          '在一步后代展开 $S_{\\ell+1}(M) = \\sum_{r=1}^k S_\\ell(o_r)$ 中，给定根节点状态 $i$ 与分支数 $k$，各子树观测 $o_1, \\dots, o_k$ 条件独立同分布。',
          'Under one-step expansion $S_{\\ell+1}(M) = \\sum_{r=1}^k S_\\ell(o_r)$, conditional on root spin $i$ and degree $k$, the child subtrees $o_1, \\dots, o_k$ are i.i.d.',
        ),
        claim: text(
          '定义 $Q_\\ell(i) = \\mathbb{E}_i[S_\\ell^2]$，则对任意 $\\ell \\in \\mathbb{N}$ 与 $i \\in \\{0,1,2\\}$ 满足精确递推 $Q_{\\ell+1}(i) = m \\sum_j W_\\lambda(i,j) Q_\\ell(j) + \\beta \\bigl((m\\lambda)^\\ell \\lambda \\varphi(i)\\bigr)^2$。',
          'Setting $Q_\\ell(i) = \\mathbb{E}_i[S_\\ell^2]$, every $\\ell \\in \\mathbb{N}$ and $i \\in \\{0,1,2\\}$ satisfies $Q_{\\ell+1}(i) = m \\sum_j W_\\lambda(i,j) Q_\\ell(j) + \\beta \\bigl((m\\lambda)^\\ell \\lambda \\varphi(i)\\bigr)^2$.',
        ),
        because: text(
          '将平方展开为 $k$ 个对角项与 $k(k-1)$ 个交叉项：对角项期望贡献 $m \\sum_j W_\\lambda(i,j) Q_\\ell(j)$，交叉项因条件独立分解为两子期望之积 $\\bigl(\\sum_j W_\\lambda(i,j)\\mathbb{E}_j[S_\\ell]\\bigr)^2 = \\bigl(\\lambda(m\\lambda)^\\ell\\varphi(i)\\bigr)^2$ 并乘以 $\\beta = \\mathbb{E}[N(N-1)]$。',
          'Expanding the square yields $k$ diagonal terms contributing $m \\sum_j W_\\lambda(i,j) Q_\\ell(j)$ and $k(k-1)$ off-diagonal terms factoring by conditional independence into $\\beta \\bigl(\\sum_j W_\\lambda(i,j)\\mathbb{E}_j[S_\\ell]\\bigr)^2 = \\beta\\bigl((m\\lambda)^\\ell \\lambda \\varphi(i)\\bigr)^2$.',
        ),
        dependsOn: ['first-moment-propagation'],
        derivation: [
          {
            statement: text(
              '利用展开式 $S_\\ell^2 = X_\\ell^2 - \\frac{2}{3}X_\\ell Z_\\ell + \\frac{1}{9}Z_\\ell^2$ 与库引理 `tsum_mul_census_mul_census`，将步进后的期望拆为对角单子节点期望与交叉双子节点期望。',
              'Using $S_\\ell^2 = X_\\ell^2 - \\frac{2}{3}X_\\ell Z_\\ell + \\frac{1}{9}Z_\\ell^2$ and `tsum_mul_census_mul_census`, split the step-ahead expectation into diagonal and cross-child terms.',
            ),
            reason: text(
              '对应 `signedCensus_second_moment_succ` 中的乘积拆分，对角系数给出 $m$，交叉系数给出 $\\beta$。',
              'Handled inside `signedCensus_second_moment_succ`, producing coefficients $m$ and $\\beta$.',
            ),
          },
          {
            statement: text(
              '交叉项内部因子满足 $\\sum_j W_\\lambda(i,j) \\mathbb{E}_j[S_\\ell] = (m\\lambda)^\\ell \\sum_j W_\\lambda(i,j)\\varphi(j) = (m\\lambda)^\\ell \\lambda \\varphi(i)$。',
              'Each cross-term factor satisfies $\\sum_j W_\\lambda(i,j) \\mathbb{E}_j[S_\\ell] = (m\\lambda)^\\ell \\sum_j W_\\lambda(i,j)\\varphi(j) = (m\\lambda)^\\ell \\lambda \\varphi(i)$.',
            ),
            reason: text(
              '将一阶矩公式 `signedCensus_moment_data` 与特征方程 `channelWeight_centred_eigen` 代入即得。',
              'Follows by substituting `signedCensus_moment_data` and `channelWeight_centred_eigen`.',
            ),
          },
        ],
        next: text(
          '下面在 Kesten–Stigum 条件 $m\\lambda^2 > 1$ 下用常数 $C (m\\lambda)^{2\\ell}$ 一致封住 $Q_\\ell(i)$。',
          'Next, we bound $Q_\\ell(i)$ uniformly by $C(m\\lambda)^{2\\ell}$ whenever $m\\lambda^2 > 1$.',
        ),
        evidence: {
          theorems: ['OAI.ThreeState.TreeClauses.signedCensus_second_moment_succ'],
          taskIds: ['ts_b2_signedCensus_second_moment_succ'],
          checkIds: ['check-42399fed06244ce0d2a3'],
          source: { name: 'Submission.lean', line: 609, endLine: 762 },
        },
      },
      {
        id: 'uniform-second-moment-bound',
        title: text('在 Kesten-Stigum 条件下给出一致二阶矩上界', 'Prove a uniform second-moment bound above the Kesten-Stigum threshold'),
        given: text(
          '已知 $m > 1$、$\\beta \\ge 0$ 且 $m\\lambda^2 > 1$，并有二阶矩递推式 $Q_{\\ell+1}(i) = m\\sum_j W_\\lambda(i,j) Q_\\ell(j) + \\beta \\bigl((m\\lambda)^\\ell\\lambda\\varphi(i)\\bigr)^2$。',
          'Assume $m > 1$, $\\beta \\ge 0$, and $m\\lambda^2 > 1$, together with the recursion $Q_{\\ell+1}(i) = m\\sum_j W_\\lambda(i,j) Q_\\ell(j) + \\beta \\bigl((m\\lambda)^\\ell\\lambda\\varphi(i)\\bigr)^2$.',
        ),
        claim: text(
          '存在仅依赖 $(m,\\beta,\\lambda)$ 的常数 $C \\ge 4/9 > 0$，使得对所有 $\\ell \\in \\mathbb{N}$ 与所有 $i \\in \\{0,1,2\\}$ 都有 $\\mathbb{E}_i[S_\\ell^2] \\le C (m\\lambda)^{2\\ell}$。',
          'There exists a constant $C \\ge 4/9 > 0$ depending only on $(m,\\beta,\\lambda)$ such that $\\mathbb{E}_i[S_\\ell^2] \\le C (m\\lambda)^{2\\ell}$ for all $\\ell \\in \\mathbb{N}$ and $i \\in \\{0,1,2\\}$.',
        ),
        because: text(
          '由于 $m\\lambda^2 > 1$，缩减因子 $r = \\frac{1}{m\\lambda^2} < 1$；又因 $|\\varphi(i)| \\le 2/3$，只需取 $C \\ge \\max\\bigl(\\frac{4}{9}, \\frac{4\\beta}{9m(m\\lambda^2 - 1)}\\bigr)$，归纳步骤的右端即可被 $\\bigl(r C + \\frac{4\\beta}{9m^2\\lambda^2}\\bigr)(m\\lambda)^{2(\\ell+1)} \\le C(m\\lambda)^{2(\\ell+1)}$ 吸收。',
          'Because $m\\lambda^2 > 1$, the contraction factor $r = 1/(m\\lambda^2)$ is strictly less than $1$. Using $|\\varphi(i)| \\le 2/3$, choosing $C \\ge \\max\\bigl(\\frac{4}{9}, \\frac{4\\beta}{9m(m\\lambda^2-1)}\\bigr)$ closes the induction step via $r C + \\frac{4\\beta}{9m^2\\lambda^2} \\le C$.',
        ),
        dependsOn: ['second-moment-recursion'],
        derivation: [
          {
            statement: text(
              '在基例 $\\ell = 0$ 处，$\\mathbb{E}_i[S_0^2] = \\varphi(i)^2 \\le 4/9 \\le C (m\\lambda)^0$。',
              'At $\\ell = 0$, $\\mathbb{E}_i[S_0^2] = \\varphi(i)^2 \\le 4/9 \\le C (m\\lambda)^0$.',
            ),
            reason: text(
              '因为 $\\varphi(0) = 2/3$ 且 $\\varphi(1) = \\varphi(2) = -1/3$，故 $\\varphi(i)^2 \\le 4/9$，由 $C \\ge 4/9$ 自动满足基例。',
              'Since $\\varphi(0) = 2/3$ and $\\varphi(1)=\\varphi(2)=-1/3$, $\\varphi(i)^2 \\le 4/9 \\le C$.',
            ),
          },
          {
            statement: text(
              '若对层 $\\ell$ 有 $Q_\\ell(j) \\le C(m\\lambda)^{2\\ell}$，则 $Q_{\\ell+1}(i) \\le \\Bigl(\\frac{C}{m\\lambda^2} + \\frac{4\\beta}{9m^2\\lambda^2}\\Bigr)(m\\lambda)^{2(\\ell+1)} \\le C(m\\lambda)^{2(\\ell+1)}$。',
              'If $Q_\\ell(j) \\le C(m\\lambda)^{2\\ell}$, then $Q_{\\ell+1}(i) \\le \\Bigl(\\frac{C}{m\\lambda^2} + \\frac{4\\beta}{9m^2\\lambda^2}\\Bigr)(m\\lambda)^{2(\\ell+1)} \\le C(m\\lambda)^{2(\\ell+1)}$.',
            ),
            reason: text(
              '对应 `signedCensus_second_moment_le` 与 `signedCensus_second_moment_le_d2`，其中常数 $C$ 的存在性由 `exists_C_of_KS` 构造。',
              'Proved in `signedCensus_second_moment_le` and `signedCensus_second_moment_le_d2`, using `exists_C_of_KS` to select $C$.',
            ),
          },
        ],
        next: text(
          '现在结合一阶矩间隙与二阶矩一致上界，推导出全变差与重构优势的一致正下界。',
          'We now combine the first-moment gap and the uniform second-moment bound to lower-bound total variation and reconstruction advantage.',
        ),
        evidence: {
          theorems: [
            'OAI.ThreeState.TreeClauses.signedCensus_second_moment_le',
            'OAI.ThreeState.TreeClauses.signedCensus_second_moment_le_d2',
            'OAI.ThreeState.TreeClauses.exists_C_of_KS',
          ],
          taskIds: ['ts_c2_signedCensus_second_moment_le', 'ts_exists_C_of_KS'],
          checkIds: ['check-42399fed06244ce0d2a3'],
          source: { name: 'Submission.lean', line: 763, endLine: 983 },
        },
      },
      {
        id: 'tv-and-advantage-lower-bound',
        title: text('通过 Cauchy-Schwarz 导出全变差与重构优势下界', 'Derive total-variation and advantage lower bounds via Cauchy-Schwarz'),
        given: text(
          '对任意深度 $n$，根节点 $0$ 与 $1$ 的一阶矩之差为 $\\mathbb{E}_0[S_n] - \\mathbb{E}_1[S_n] = (m\\lambda)^n$，且二阶矩满足 $\\mathbb{E}_0[S_n^2], \\mathbb{E}_1[S_n^2] \\le C(m\\lambda)^{2n}$。',
          'At any depth $n$, the mean gap between roots $0$ and $1$ is $\\mathbb{E}_0[S_n] - \\mathbb{E}_1[S_n] = (m\\lambda)^n$, and both second moments satisfy $\\mathbb{E}_0[S_n^2], \\mathbb{E}_1[S_n^2] \\le C(m\\lambda)^{2n}$.',
        ),
        claim: text(
          '观测分布 $P_n(0,\\cdot)$ 与 $P_n(1,\\cdot)$ 的全变差满足 $d_{\\mathrm{TV}}(P_n(0), P_n(1)) \\ge \\frac{1}{4C}$，从而任意深度 $n$ 的重构优势都满足 $A_n \\ge \\frac{1}{12C} > 0$。',
          'The total variation satisfies $d_{\\mathrm{TV}}(P_n(0), P_n(1)) \\ge \\frac{1}{4C}$, and consequently the reconstruction advantage satisfies $A_n \\ge \\frac{1}{12C} > 0$ for all $n$.',
        ),
        because: text(
          '由库引理 `sq_sub_le_pmfTV_mul_centred`，期望差的平方被全变差乘以混合二阶矩之和 $2(\\mathbb{E}_0[S_n^2] + \\mathbb{E}_1[S_n^2]) \\le 4C(m\\lambda)^{2n}$ 控制；消去 $(m\\lambda)^{2n}$ 后得到 $d_{\\mathrm{TV}} \\ge 1/(4C)$，再由状态数 $|\\mathrm{Spin}|=3$ 的引理 `pmfTV_le_card_mul_reconAdvantage` 除以 $3$ 即得 $A_n \\ge 1/(12C)$。',
          'By `sq_sub_le_pmfTV_mul_centred`, the squared mean difference is bounded by $2 d_{\\mathrm{TV}} \\cdot (2\\mathbb{E}_0[S_n^2] + 2\\mathbb{E}_1[S_n^2]) \\le 4C d_{\\mathrm{TV}}(m\\lambda)^{2n}$. Canceling $(m\\lambda)^{2n}$ gives $d_{\\mathrm{TV}} \\ge 1/(4C)$, and dividing by $|\\mathrm{Spin}|=3$ via `pmfTV_le_card_mul_reconAdvantage` gives $A_n \\ge 1/(12C)$.',
        ),
        dependsOn: ['first-moment-propagation', 'uniform-second-moment-bound'],
        derivation: [
          {
            statement: text(
              '$(m\\lambda)^{2n} = (\\mathbb{E}_0[S_n] - \\mathbb{E}_1[S_n])^2 \\le 4C (m\\lambda)^{2n} \\, d_{\\mathrm{TV}}(P_n(0), P_n(1))$。',
              '$(m\\lambda)^{2n} = (\\mathbb{E}_0[S_n] - \\mathbb{E}_1[S_n])^2 \\le 4C (m\\lambda)^{2n} \\, d_{\\mathrm{TV}}(P_n(0), P_n(1))$.',
            ),
            reason: text(
              '对应引理 `pmfTV_observationLaw_lower`，因 $m\\lambda^2 > 1$ 故 $(m\\lambda)^{2n} > 0$ 可消去，直接给出 $d_{\\mathrm{TV}}(P_n(0), P_n(1)) \\ge 1/(4C)$。',
              'Proved in `pmfTV_observationLaw_lower`; since $m\\lambda^2 > 1$, $(m\\lambda)^{2n} > 0$ cancels to yield $d_{\\mathrm{TV}}(P_n(0), P_n(1)) \\ge 1/(4C)$.',
            ),
          },
          {
            statement: text(
              '重构优势满足 $d_{\\mathrm{TV}}(P_n(0), P_n(1)) \\le 3 A_n$，因而对一切 $n$ 有 $A_n \\ge \\frac{1}{12C}$。',
              'The reconstruction advantage satisfies $d_{\\mathrm{TV}}(P_n(0), P_n(1)) \\le 3 A_n$, hence $A_n \\ge \\frac{1}{12C}$ for all $n$.',
            ),
            reason: text(
              '对应引理 `advantage_observationLaw_lower`，利用均匀先验下 $3$-态最优 Bayes 猜测与全变差的标准比较关系。',
              'Proved in `advantage_observationLaw_lower` by comparing $3$-state Bayes advantage under the uniform prior with total variation.',
            ),
          },
        ],
        next: text(
          '最后利用重构优势沿深度的单调性与极限正性，代入正则树和 Poisson 树的一二阶矩参数完成证明。',
          'Finally, combine monotonicity of advantage with the moment parameters of regular and Poisson trees.',
        ),
        evidence: {
          theorems: [
            'OAI.ThreeState.TreeClauses.pmfTV_observationLaw_lower',
            'OAI.ThreeState.TreeClauses.advantage_observationLaw_lower',
          ],
          taskIds: ['ts_d2_pmfTV_observationLaw_lower', 'ts_e2_advantage_observationLaw_lower'],
          checkIds: ['check-42399fed06244ce0d2a3'],
          source: { name: 'Submission.lean', line: 984, endLine: 1159 },
        },
      },
      {
        id: 'monotone-convergence-to-reconstruction',
        title: text('由单调收敛与两类后代矩完成正则与 Poisson 树可重构性', 'Conclude regular and Poisson reconstructibility via monotone convergence'),
        given: text(
          '已有 `reconstructs_of_uniform_advantage`（来自优势序列的单调非增性 $A_{n+1} \\le A_n$ 与有下界收敛到极限 $a > 0$），以及两类后代分布：$b$-正则树 `PMF.pure b`（$b\\lambda^2 > 1$）与均值 $d$ 的 Poisson 树 `poissonPMF d`（$d\\lambda^2 > 1$）。',
          'We have `reconstructs_of_uniform_advantage` (from Markov data-processing monotonicity $A_{n+1} \\le A_n$ and convergence to $a > 0$), together with `PMF.pure b` ($b\\lambda^2 > 1$) and `poissonPMF d` ($d\\lambda^2 > 1$).',
        ),
        claim: text(
          '两类后代律都存在一致优势下界 $\\varepsilon > 0$，从而 `Tree.regular_reconstructs_above_KS` 与 `Tree.poisson_reconstructs_above_KS` 成立。',
          'Both offspring distributions admit a uniform advantage lower bound $\\varepsilon > 0$, proving `Tree.regular_reconstructs_above_KS` and `Tree.poisson_reconstructs_above_KS`.',
        ),
        because: text(
          '对 `PMF.pure b` 计算得 $(m,\\beta) = (b, b(b-1))$，对 `poissonPMF d` 计算得 $(m,\\beta) = (d, d^2)$，均满足 $m > 1$、$\\beta \\ge 0$ 与 Kesten–Stigum 条件；因此各有 $A_n \\ge \\frac{1}{12C} > 0$，再由单调非增序列必收敛至严格正极限即得 `Reconstructs`。',
          'Evaluating $(m,\\beta)$ gives $(b, b(b-1))$ for `PMF.pure b` and $(d, d^2)$ for `poissonPMF d`, both satisfying $m > 1$, $\\beta \\ge 0$, and the Kesten–Stigum condition. Thus $A_n \\ge 1/(12C) > 0$ uniformly, so the monotone nonincreasing sequence $A_n$ converges to a strictly positive limit.',
        ),
        dependsOn: ['poisson-offspring-law', 'tv-and-advantage-lower-bound'],
        derivation: [
          {
            statement: text(
              '对 $b$-正则树，$(m,\\beta) = (b, b(b-1))$ 满足 `pure_mean` 与 `pure_factorial_moment`，从而 `regular_advantage_uniform_lower` 给出 $A_n \\ge \\frac{1}{12C}$。',
              'For `PMF.pure b`, $(m,\\beta) = (b, b(b-1))$ via `pure_mean` and `pure_factorial_moment`, yielding $A_n \\ge \\frac{1}{12C}$ in `regular_advantage_uniform_lower`.',
            ),
            reason: text(
              '由 `b * lam^2 > 1` 与 `lam^2 <= 1` 推出 $b > 1$，并取 $\\varepsilon = 1/(12C) > 0$。',
              'From $b\\lambda^2 > 1$ and $\\lambda^2 \\le 1$ we get $b > 1$, and apply `advantage_observationLaw_lower`.',
            ),
          },
          {
            statement: text(
              '对 Poisson 树，$(m,\\beta) = (d, d^2)$ 满足 `poisson_mean` 与 `poisson_factorial_moment`，从而 `poisson_advantage_uniform_lower` 给出 $A_n \\ge \\frac{1}{12C}$。',
              'For `poissonPMF d`, $(m,\\beta) = (d, d^2)$ via `poisson_mean` and `poisson_factorial_moment`, yielding $A_n \\ge \\frac{1}{12C}$ in `poisson_advantage_uniform_lower`.',
            ),
            reason: text(
              '由 `d * lam^2 > 1` 推出 $d > 1$，且因 $k(k-1)$ 的 Poisson 阶乘矩等于 $d^2 \\ge 0$ 而直接适用一致下界定理。',
              'From $d\\lambda^2 > 1$ we get $d > 1$, and the second factorial moment of Poisson($d$) is $d^2 \\ge 0$.',
            ),
          },
          {
            statement: text(
              '结合 `reconstructs_of_uniform_advantage`，由 $A_{n+1} \\le A_n$ 与 $\\forall n,\\, A_n \\ge \\varepsilon > 0$ 得 $\\lim_{n\\to\\infty} A_n = a > 0$，证毕 `Tree.regular_reconstructs_above_KS` 与 `Tree.poisson_reconstructs_above_KS`。',
              'Via `reconstructs_of_uniform_advantage`, $A_{n+1} \\le A_n$ and $A_n \\ge \\varepsilon > 0$ imply $\\lim_{n\\to\\infty} A_n = a > 0$, concluding `Tree.regular_reconstructs_above_KS` and `Tree.poisson_reconstructs_above_KS`.',
            ),
            reason: text(
              '封装自 Markov 数据处理不等式的单调性与实数列单调收敛定理直接给出最终两个主目标。',
              'Data-processing monotonicity and monotone convergence close both main reconstruction theorems.',
            ),
          },
        ],
        next: text(
          '至此 `Submission.lean` 中六个既定目标全部获证并完成形式化验证。',
          'All six target theorems in `Submission.lean` are now formally proved.',
        ),
        evidence: {
          theorems: [
            'OAI.ThreeState.TreeClauses.pure_mean',
            'OAI.ThreeState.TreeClauses.pure_factorial_moment',
            'OAI.ThreeState.TreeClauses.poisson_mean',
            'OAI.ThreeState.TreeClauses.poisson_factorial_moment',
            'OAI.ThreeState.TreeClauses.regular_advantage_uniform_lower',
            'OAI.ThreeState.TreeClauses.poisson_advantage_uniform_lower',
            'OAI.ThreeState.TreeClauses.reconstructs_of_uniform_advantage',
            'OAI.ThreeState.TreeClauses.Tree.regular_reconstructs_above_KS',
            'OAI.ThreeState.TreeClauses.Tree.poisson_reconstructs_above_KS',
          ],
          taskIds: [
            'initial_goal_5',
            'initial_goal_6',
            'ts_regular_advantage_uniform_lower',
            'ts_poisson_advantage_uniform_lower',
            'ts_reconstructs_of_uniform_advantage',
          ],
          checkIds: ['check-42399fed06244ce0d2a3'],
          source: { name: 'Submission.lean', line: 1207, endLine: 1264 },
        },
      },
    ],
  },
  {
    recordId: 'openai_character_varieties_all_seams_support',
    runId: '1f3bb9c1-c99f-4fad-b656-8010a82c265b',
    proofSha256: '5c0cbc35bd6335ab7c6d8d57bdece22a3065c6fdc7dee871d2577826b50396d3',
    title: text(
      '分八类接缝逐支验证带边标点曲面粘合特征标簇的主干全接缝相容性',
      'Verify full seam compatibility across all eight seam families of grafted marked character varieties',
    ),
    strategy: text(
      '给定剪开图模型上的标记赋值与选定切口，首先将原标记赋值表示为切口模型赋值并固定端口标架，再用全局基变换矩阵构造归一化基点边值。随后把 `graftPlus` 产生的所有接缝穷举划分为八个不相交家族：未选旧接缝、选定切口接缝、原内接缝、镜像内接缝、正/负横截接缝、首段短接缝与闭合环绕接缝（其旗标传递为 $T^{-1} J^{-1} P T$）。逐一验证每类接缝的标架传递方程后，汇总即得 `producedMarkedValues_allSeams`。',
      'Starting from marked values on a cut-band diagram and a chosen cut, we first realize the values as cut-model data with an explicit port frame and normalize side values into a based gauge. We then partition all seams of `graftPlus` into eight exhaustive families: unselected old seams, the selected cut seam, original internal seams, mirror internal seams, positive and negative transverse seams, the first short seam, and the closing wrap seam (governed by the change-of-basis flag transport $T^{-1} J^{-1} P T$). Verifying the flag-transport equation on each branch yields `producedMarkedValues_allSeams`.',
    ),
    stages: [
      {
        title: text('建立切口模型端口标架与基点规范化边值', 'Construct cut-model port frames and based gauge side values'),
        summary: text(
          '证明由 `producedMarkedValues` 产生的赋值来自切口模型的端口标架，并构造基点提升后的归一化边矩阵。',
          'Show that `producedMarkedValues` arises from cut-model port frames and construct the based-gauge normalized side matrices.',
        ),
        stepIds: ['cut-diagram-and-port-frames', 'gauge-rebased-side-values'],
      },
      {
        title: text('验证旧接缝、选定切口接缝与内部/横截接缝', 'Verify old, selected-cut, internal, and transverse seam families'),
        summary: text(
          '在基点规范下分别验证未选旧接缝、选定切口接缝、原内接缝与镜像内接缝（单位边接缝）以及正负横截接缝的旗标与端口转移方程。',
          'Prove the seam equations for unselected old seams, the selected cut seam, original and mirror internal unit-side seams, and positive/negative transverse seams.',
        ),
        stepIds: ['unselected-old-seams', 'selected-cut-seam', 'internal-and-mirror-seams', 'transverse-seams'],
      },
      {
        title: text('验证首段短接缝与闭合环绕接缝并汇总全部分支', 'Verify short and wrap seams and exhaust all eight seam families'),
        summary: text(
          '计算端口处的首段短接缝与经由 $T^{-1} J^{-1} P T$ 传递的闭合环绕接缝，最后通过八分支分类引理完成 `producedMarkedValues_allSeams`。',
          'Prove the shared first short seam and the closing wrap seam governed by $T^{-1} J^{-1} P T$, then assemble all branches into `producedMarkedValues_allSeams`.',
        ),
        stepIds: ['first-short-and-wrap-seams', 'exhaust-all-eight-seam-families'],
      },
    ],
    goal: text(
      '在给定标记曲面演示图 $D$、合法剪开边集 `cuts`、正边标记 `posSide` 及兼容初始赋值条件下，证明粘合图 `graftPlus` 上的 `producedMarkedValues` 满足全部接缝方程 `allSeams`。',
      'Given a marked surface presentation diagram $D$, valid `cuts`, positive side `posSide`, and compatible seed data, prove that `producedMarkedValues` satisfies `allSeams` on the grafted diagram `graftPlus`.',
    ),
    notation: text(
      '切口处端口标架记为 $P$，基点切换矩阵记为 $T$，标准反演/扭转矩阵记为 $J$。规范化边值将非基点边与基点边通过共轭提升相联系；八类接缝覆盖 `graftPlus` 产生的全部 `Seam` 构造子。',
      'Port frames at the cut are denoted $P$, the change-of-basis matrix $T$, and the standard inversion/twist matrix $J$. Rebased side values relate marked sides via conjugation lift, and eight seam families cover every `Seam` constructor of `graftPlus`.',
    ),
    steps: [
      {
        id: 'cut-diagram-and-port-frames',
        title: text('将标记赋值提升为切口模型端口标架', 'Lift marked values to cut-model port frames'),
        given: text(
          '已知初始标记图的边值种子 `producedCutSeed` 满足种子相容条件，切口索引选定为 `posSide`。',
          'We are given the cut seed `producedCutSeed` satisfying seed compatibility at the chosen cut `posSide`.',
        ),
        claim: text(
          '粘合后的标记边值构成切口模型赋值 `markedAsCutValues`，并在端口位置产生满足切口转移方程的端口标架 `parent_producedCutPortFrame`。',
          'The resulting marked values form cut-model values `markedAsCutValues` and yield a compatible cut port frame `parent_producedCutPortFrame`.',
        ),
        because: text(
          '对单步剪开过程展开 `producedMarkedValues` 的定义，其每条边与端口标架直接继承自切口模型构造器，并在端接处自动满足切口接缝约束。',
          'Unfolding `producedMarkedValues` along the cut construction exposes each side value and port frame directly from the cut-model lifts.',
        ),
        dependsOn: [],
        derivation: [
          {
            statement: text(
              '存在切口模型数据使得 `producedMarkedValues` 等于 `external_markedAsCutValues` 给出的切口赋值。',
              '`producedMarkedValues` agrees with the cut-model values of `external_markedAsCutValues`.',
            ),
            reason: text(
              '对应引理 `external_markedAsCutValues` 与 `external_markedAsCutValues_portFrame`。',
              'Established by `external_markedAsCutValues` and `external_markedAsCutValues_portFrame`.',
            ),
          },
          {
            statement: text(
              '端口提升后的标架满足 `parent_markedLiftCutPortFrame`，从而得到目标端口标架方程 `parent_producedCutPortFrame`。',
              'The lifted port frame satisfies `parent_markedLiftCutPortFrame`, giving `parent_producedCutPortFrame`.',
            ),
            reason: text(
              '将切口端点的局部标架代入 `parent_producedCutPortFrame` 即完成端口层面的相容性验证。',
              'Substituting the local cut-endpoint frame into `parent_producedCutPortFrame` establishes port-frame compatibility.',
            ),
          },
        ],
        next: text(
          '基于该切口模型，下一步将边赋值切换至统一的基点规范。',
          'Next, rebase these side values into a unified based gauge.',
        ),
        evidence: {
          theorems: [
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_markedAsCutValues',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_markedAsCutValues_portFrame',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.parent_markedLiftCutPortFrame',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.parent_producedCutPortFrame',
          ],
          taskIds: ['character_original_goal'],
          deliveryIds: ['19ac5dd2-678b-4628-9399-26ac5c1d4282'],
          checkIds: ['check-8c7fa4c63466a7f4bf51'],
          source: { name: 'Submission.lean', line: 516, endLine: 557 },
        },
      },
      {
        id: 'gauge-rebased-side-values',
        title: text('将切口边值转换到基点规范化表示', 'Rebase cut-model side values into a based gauge'),
        given: text(
          '由上一步已得切口模型赋值与端口标架 `parent_producedCutPortFrame`。',
          'We have the cut-model values and port frame from `parent_producedCutPortFrame`.',
        ),
        claim: text(
          '在基点规范下，每条标记边的矩阵值可表示为重标化提升 `parent_markedLiftSide_rebased`，给出标准化边值方程 `parent_producedMarkedSideValue`。',
          'Under the based gauge, each marked side value is given by the rebased lift `parent_markedLiftSide_rebased`, yielding `parent_producedMarkedSideValue`.',
        ),
        because: text(
          '用基点处的共轭规范作用消除多出来的局部基变换因子，使后续旧接缝、选定切口接缝与环绕接缝都能在同一矩阵代数框架下相消。',
          'Conjugating by the based-gauge transition removes redundant local framing factors so old, selected, and wrap seams simplify in one common matrix algebra.',
        ),
        dependsOn: ['cut-diagram-and-port-frames'],
        derivation: [
          {
            statement: text(
              '重标化后的边提升与原始标记提升之间相差固定的基变换共轭，满足 `parent_markedLiftSide_rebased`。',
              'The rebased side lift matches the original marked lift up to the fixed basis change in `parent_markedLiftSide_rebased`.',
            ),
            reason: text(
              '对应引理 `parent_markedLiftSide_rebased`，由局部标架的矩阵结合律直接化简。',
              'Proved in `parent_markedLiftSide_rebased` by matrix associativity.',
            ),
          },
          {
            statement: text(
              '由此得到标准化边值等式 `parent_producedMarkedSideValue`，作为后续三组接缝的共同代数输入。',
              'This yields the normalized side-value formula `parent_producedMarkedSideValue`.',
            ),
            reason: text(
              '对应引理 `parent_producedMarkedSideValue`，统一替换 `producedMarkedValues` 中的边取值。',
              'Proved in `parent_producedMarkedSideValue`, providing a uniform formula for side values.',
            ),
          },
        ],
        next: text(
          '接下来分别验证未选旧接缝与选定切口接缝，并同时处理内部与横截接缝。',
          'We now verify unselected old seams and the selected cut seam alongside the internal and transverse seams.',
        ),
        evidence: {
          theorems: [
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.parent_markedLiftSide_rebased',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.parent_producedMarkedSideValue',
          ],
          taskIds: ['character_original_goal'],
          deliveryIds: ['19ac5dd2-678b-4628-9399-26ac5c1d4282'],
          checkIds: ['check-8c7fa4c63466a7f4bf51'],
          source: { name: 'Submission.lean', line: 567, endLine: 581 },
        },
      },
      {
        id: 'unselected-old-seams',
        title: text('验证未被剪开的旧接缝传递方程', 'Verify flag transport along unselected old seams'),
        given: text(
          '对 `graftPlus` 中未落入当前切口处的旧接缝 $s$，其相邻边值由基点规范边值 `parent_producedMarkedSideValue` 给出。',
          'For an old seam $s$ of `graftPlus` away from the selected cut, its incident side values are given by `parent_producedMarkedSideValue`.',
        ),
        claim: text(
          '父端与子逆端的标架传递分别满足 `external_oldParentTransport` 与 `external_oldChildInverseTransport`，汇总得到旧接缝相容性 `external_producedOldSeam_dataV2`。',
          'Parent and child-inverse transport satisfy `external_oldParentTransport` and `external_oldChildInverseTransport`, yielding old-seam compatibility `external_producedOldSeam_dataV2`.',
        ),
        because: text(
          '旧接缝在剪开过程中保持原始拓扑邻接，基点规范化共轭因子在接缝两侧成对相消，从而还原为种子图的已知旧接缝方程。',
          'Old seams preserve their original adjacency under grafting; the based-gauge conjugation factors cancel pairwise across the seam, reducing to the seed old-seam equation.',
        ),
        dependsOn: ['gauge-rebased-side-values'],
        derivation: [
          {
            statement: text(
              '父端沿旧接缝的传递矩阵满足 `external_oldParentTransport`，而子端逆向传递满足 `external_oldChildInverseTransport`。',
              'Parent transport satisfies `external_oldParentTransport` and child inverse transport satisfies `external_oldChildInverseTransport`.',
            ),
            reason: text(
              '对应引理 `external_oldParentTransport` 与 `external_oldChildInverseTransport`，抵消规范化共轭项。',
              'Established by `external_oldParentTransport` and `external_oldChildInverseTransport`.',
            ),
          },
          {
            statement: text(
              '将两端传递与边值模板 `external_oldSeamFromValues` 组合，即证 `external_producedOldSeam_dataV2`。',
              'Combining both transports with `external_oldSeamFromValues` proves `external_producedOldSeam_dataV2`.',
            ),
            reason: text(
              '对应引理 `external_producedOldSeam_dataV2`，覆盖第一类接缝家族。',
              'Established by `external_producedOldSeam_dataV2`, completing the unselected old-seam family.',
            ),
          },
        ],
        next: text(
          '旧接缝已获证，将继续并入最终的八分支汇总步。',
          'With old seams proved, this branch feeds into the final eight-family classification.',
        ),
        evidence: {
          theorems: [
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_oldSeamFromValues',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_oldParentTransport',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_oldChildInverseTransport',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_producedOldSeam_dataV2',
          ],
          taskIds: ['character_original_goal'],
          deliveryIds: ['19ac5dd2-678b-4628-9399-26ac5c1d4282'],
          checkIds: ['check-8c7fa4c63466a7f4bf51'],
          source: { name: 'Submission.lean', line: 605, endLine: 671 },
        },
      },
      {
        id: 'selected-cut-seam',
        title: text('验证选定切口接缝的带旗标代数与完备性', 'Verify band-flag algebra and completeness on the selected cut seam'),
        given: text(
          '在选定切口 `posSide` 处，切口两侧由基点规范边值与剪开带上的新旗标衔接。',
          'At the selected cut `posSide`, the two sides meet through the based-gauge side values and the new band flag.',
        ),
        claim: text(
          '切口旗标满足矩阵恒等式 `parent_selectedFlag_algebra` 与 `parent_selectedBandFlag`，从而在带边值模板下导出完整的选定切口接缝 `parent_producedSelectedSeamComplete`。',
          'The cut flag satisfies `parent_selectedFlag_algebra` and `parent_selectedBandFlag`, establishing the selected cut seam `parent_producedSelectedSeamComplete`.',
        ),
        because: text(
          '把选定接缝方程改写为 `parent_selectedSeam_fromSides` 的边值乘积形式后，只需验证切口旗标与扭转因子的局部矩阵代数消去。',
          'Rewriting the selected seam via `parent_selectedSeam_fromSides` reduces the seam condition to local matrix cancellation in `parent_selectedFlag_algebra`.',
        ),
        dependsOn: ['gauge-rebased-side-values'],
        derivation: [
          {
            statement: text(
              '利用 `parent_selectedSeam_fromSides` 将选定切口接缝归约为两侧归一化矩阵与切口带旗标的相容关系。',
              'Via `parent_selectedSeam_fromSides`, the selected cut seam reduces to compatibility between normalized side values and the band flag.',
            ),
            reason: text(
              '对应引理 `parent_selectedSeam_fromSides`，分离出纯旗标矩阵部分。',
              'Established by `parent_selectedSeam_fromSides`, isolating the matrix flag identity.',
            ),
          },
          {
            statement: text(
              '局部矩阵计算给出 `parent_selectedFlag_algebra` 与 `parent_selectedBandFlag`，从而推出 `parent_producedSelectedSeamComplete`。',
              'Matrix simplification gives `parent_selectedFlag_algebra` and `parent_selectedBandFlag`, proving `parent_producedSelectedSeamComplete`.',
            ),
            reason: text(
              '对应引理 `parent_producedSelectedSeamComplete`，同时也为后续短接缝与环绕接缝提供切口旗标恒等式。',
              'Proved in `parent_producedSelectedSeamComplete`; the resulting flag identity also supports the short and wrap seams.',
            ),
          },
        ],
        next: text(
          '选定切口接缝完成，将继续支撑短/环绕接缝步与最终八分支汇总。',
          'The selected cut seam is proved and feeds both the short/wrap seams and the final assembly.',
        ),
        evidence: {
          theorems: [
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.parent_selectedSeam_fromSides',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.parent_selectedFlag_algebra',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.parent_selectedBandFlag',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.parent_producedSelectedSeamComplete',
          ],
          taskIds: ['character_original_goal'],
          deliveryIds: ['19ac5dd2-678b-4628-9399-26ac5c1d4282'],
          checkIds: ['check-8c7fa4c63466a7f4bf51'],
          source: { name: 'Submission.lean', line: 974, endLine: 1078 },
        },
      },
      {
        id: 'internal-and-mirror-seams',
        title: text('验证剪开带上的原内接缝与镜像内接缝', 'Verify original and mirror internal seams on the grafted band'),
        given: text(
          '在剪开后插入的梯形带上，内部纵向边与镜像内部纵向边均取单位边赋值的规范形式。',
          'Along the grafted band, both original internal edges and mirror internal edges carry unit-side normalized values.',
        ),
        claim: text(
          '两类内部接缝分别满足 `external_originalInternalSeam` 与 `external_mirrorInternalSeam`，导出 `external_producedOriginalInternalSeam_data` 与 `external_producedMirrorInternalSeam_data`。',
          'Both internal seam families satisfy `external_originalInternalSeam` and `external_mirrorInternalSeam`, yielding `external_producedOriginalInternalSeam_data` and `external_producedMirrorInternalSeam_data`.',
        ),
        because: text(
          '内部接缝的相邻边值均为单位矩阵 $I$ 或局部端口标架的直接像，通过单位边接缝引理 `external_unitSideSeam` 与端点标架引理即可直接消去。',
          'Incident edges on internal band seams carry unit matrices or direct port-frame images, reducing directly via `external_unitSideSeam` and endpoint-frame identities.',
        ),
        dependsOn: ['cut-diagram-and-port-frames'],
        derivation: [
          {
            statement: text(
              '利用 `external_unitSideSeam` 处理单位边上的旗标对齐，证得原内接缝方程 `external_originalInternalSeam` 与 `external_producedOriginalInternalSeam_data`。',
              'Applying `external_unitSideSeam` establishes `external_originalInternalSeam` and `external_producedOriginalInternalSeam_data`.',
            ),
            reason: text(
              '对应引理 `external_producedOriginalInternalSeam_data`，完成第三类接缝家族。',
              'Proved in `external_producedOriginalInternalSeam_data`, completing the third seam family.',
            ),
          },
          {
            statement: text(
              '对镜像带上的对应内部边做对称置换，证得 `external_mirrorInternalSeam` 与 `external_producedMirrorInternalSeam_data`。',
              'Symmetrically on the mirror band, `external_mirrorInternalSeam` yields `external_producedMirrorInternalSeam_data`.',
            ),
            reason: text(
              '对应引理 `external_producedMirrorInternalSeam_data`，完成第四类接缝家族。',
              'Proved in `external_producedMirrorInternalSeam_data`, completing the fourth seam family.',
            ),
          },
        ],
        next: text(
          '原内接缝与镜像内接缝均已证毕，将并入最终八分支汇总。',
          'Both internal seam families are complete and ready for the final eight-family assembly.',
        ),
        evidence: {
          theorems: [
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_unitSideSeam',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_originalInternalSeam',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_producedOriginalInternalSeam_data',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_mirrorInternalSeam',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_producedMirrorInternalSeam_data',
          ],
          taskIds: ['character_original_goal'],
          deliveryIds: ['d4c7394c-eb5a-480a-a0c7-ddb6cd331577'],
          checkIds: ['check-8c7fa4c63466a7f4bf51'],
          source: { name: 'Submission.lean', line: 1285, endLine: 1623 },
        },
      },
      {
        id: 'transverse-seams',
        title: text('验证正负方向横截接缝的旗标相容性', 'Verify positive and negative transverse seam families'),
        given: text(
          '沿粘合带正方向与负方向横跨带面的横截接缝，连接端口标架与带端局部标记边。',
          'Positive and negative transverse seams cross the grafted band, connecting port frames with band-end marked edges.',
        ),
        claim: text(
          '正横截接缝与负横截接缝均满足通用横截接缝判据 `external_transverseSeam`，分别导出 `external_producedTransversePlus_dataSeam` 与 `external_producedTransverseMinus_dataSeam`。',
          'Both orientations satisfy `external_transverseSeam`, yielding `external_producedTransversePlus_dataSeam` and `external_producedTransverseMinus_dataSeam`.',
        ),
        because: text(
          '带面上的横截传递仅依赖端口标架与标准符号定向扭转，将正负两种定向的边值分别代入 `external_transverseSeam` 即消去全部矩阵因子。',
          'Transverse transport depends only on the port frames and orientation twist; instantiating `external_transverseSeam` for each orientation closes both families.',
        ),
        dependsOn: ['cut-diagram-and-port-frames'],
        derivation: [
          {
            statement: text(
              '通用引理 `external_transverseSeam` 将任意横截接缝的旗标等式化归为带端端口标架的相容条件。',
              'The shared lemma `external_transverseSeam` reduces transverse seam equations to port-frame compatibility at band ends.',
            ),
            reason: text(
              '对应引理 `external_transverseSeam`，统一正负两种横截定向。',
              'Proved in `external_transverseSeam`, factoring out the shared matrix algebra.',
            ),
          },
          {
            statement: text(
              '分别代入正、负横截分支的数据，得到 `external_producedTransversePlus_dataSeam` 与 `external_producedTransverseMinus_dataSeam`。',
              'Instantiating the positive and negative branches yields `external_producedTransversePlus_dataSeam` and `external_producedTransverseMinus_dataSeam`.',
            ),
            reason: text(
              '分别完成第五与第六类接缝家族。',
              'Completes the fifth and sixth seam families.',
            ),
          },
        ],
        next: text(
          '正负横截接缝已获证，将并入最终八分支汇总。',
          'Positive and negative transverse seams are proved and feed into the final assembly.',
        ),
        evidence: {
          theorems: [
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_transverseSeam',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_producedTransversePlus_dataSeam',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_producedTransverseMinus_dataSeam',
          ],
          taskIds: ['character_original_goal'],
          deliveryIds: ['d4c7394c-eb5a-480a-a0c7-ddb6cd331577'],
          checkIds: ['check-8c7fa4c63466a7f4bf51'],
          source: { name: 'Submission.lean', line: 1800, endLine: 2008 },
        },
      },
      {
        id: 'first-short-and-wrap-seams',
        title: text('验证首段短接缝与闭合环绕接缝的旗标传递', 'Verify the first short seam and closing wrap seam via flag transport'),
        given: text(
          '已有基点规范化边值、切口端口标架 $P$ 以及选定切口处的带旗标关系。',
          'We have the rebased side values, the cut port frame $P$, and the selected cut band-flag identity.',
        ),
        claim: text(
          '首段短接缝满足 `external_producedFirstShortEquation_shared`，而闭合环绕接缝通过基变换传递矩阵 $T^{-1} J^{-1} P T$ 满足 `parent_producedWrapSeamComplete`。',
          'The first short seam satisfies `external_producedFirstShortEquation_shared`, while the closing wrap seam satisfies `parent_producedWrapSeamComplete` via the flag transport $T^{-1} J^{-1} P T$.',
        ),
        because: text(
          '在首段短接缝处端口标架直接还原出实际旗标；而在闭合环绕接缝处，将边值展开为 `parent_wrapSeam_fromSides` 后，环绕单位旗标 `parent_wrapUnitFlag` 由基变换恒等式 $T^{-1} J^{-1} P T$ 在 `parent_wrapFlag_algebra` 中精确消去。',
          'At the first short seam, port frames recover the actual flag directly via `external_firstActualFlagFromPortFrames_shared`; at the closing wrap seam, `parent_wrapSeam_fromSides` reduces the seam to `parent_wrapUnitFlag` and `parent_wrapFlag_algebra` via $T^{-1} J^{-1} P T$.',
        ),
        dependsOn: ['gauge-rebased-side-values', 'selected-cut-seam'],
        derivation: [
          {
            statement: text(
              '由端口标架导出实际旗标 `external_firstActualFlagFromPortFrames_shared`，进而证明首段短接缝等式 `external_producedFirstShortEquation_shared`。',
              'Port frames yield `external_firstActualFlagFromPortFrames_shared`, proving the first short seam equation `external_producedFirstShortEquation_shared`.',
            ),
            reason: text(
              '对应引理 `external_producedFirstShortEquation_shared`，完成第七类接缝家族。',
              'Proved in `external_producedFirstShortEquation_shared`, completing the seventh seam family.',
            ),
          },
          {
            statement: text(
              '对闭合环绕接缝应用 `parent_wrapSeam_fromSides`，再结合 `parent_wrapFlag_algebra` 中的 $T^{-1} J^{-1} P T$ 共轭传递与 `parent_wrapUnitFlag`，得到 `parent_producedWrapFlag`。',
              'Applying `parent_wrapSeam_fromSides` together with the $T^{-1} J^{-1} P T$ transport in `parent_wrapFlag_algebra` and `parent_wrapUnitFlag` yields `parent_producedWrapFlag`.',
            ),
            reason: text(
              '对应引理 `parent_wrapFlag_algebra`、`parent_wrapUnitFlag` 与 `parent_producedWrapFlag`。',
              'Proved in `parent_wrapFlag_algebra`, `parent_wrapUnitFlag`, and `parent_producedWrapFlag`.',
            ),
          },
          {
            statement: text(
              '综合边值表达与环绕旗标等式，证得闭合环绕接缝的完备性 `parent_producedWrapSeamComplete`。',
              'Combining the side-value expansion and wrap flag identity proves `parent_producedWrapSeamComplete`.',
            ),
            reason: text(
              '对应引理 `parent_producedWrapSeamComplete`，完成第八类也是最后一类接缝家族。',
              'Proved in `parent_producedWrapSeamComplete`, completing the eighth and final seam family.',
            ),
          },
        ],
        next: text(
          '现在八类接缝家族已全部逐一验证，只剩最后一步将它们合并为 `allSeams`。',
          'All eight seam families are now verified; the final step combines them into `allSeams`.',
        ),
        evidence: {
          theorems: [
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_firstActualFlagFromPortFrames_shared',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_producedFirstShortEquation_shared',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.parent_wrapSeam_fromSides',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.parent_wrapFlag_algebra',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.parent_wrapUnitFlag',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.parent_producedWrapFlag',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.parent_producedWrapSeamComplete',
          ],
          taskIds: ['character_original_goal'],
          deliveryIds: ['19ac5dd2-678b-4628-9399-26ac5c1d4282', 'd4c7394c-eb5a-480a-a0c7-ddb6cd331577'],
          checkIds: ['check-8c7fa4c63466a7f4bf51'],
          source: { name: 'Submission.lean', line: 2366, endLine: 3049 },
        },
      },
      {
        id: 'exhaust-all-eight-seam-families',
        title: text('通过八分支穷举完成全接缝主定理', 'Assemble all eight seam families into the main theorem'),
        given: text(
          '已分别证得 `graftPlus` 中未选旧接缝、选定切口接缝、原内接缝、镜像内接缝、正横截接缝、负横截接缝、首段短接缝与闭合环绕接缝共八个接缝家族的相容性。',
          'We have established seam compatibility for all eight families of `graftPlus`: old, selected cut, original internal, mirror internal, positive/negative transverse, first short, and wrap seams.',
        ),
        claim: text(
          '粘合图 `graftPlus` 上的赋值 `producedMarkedValues` 满足全部接缝方程，即主目标 `producedMarkedValues_allSeams` 成立。',
          'The values `producedMarkedValues` satisfy `allSeams` on `graftPlus`, establishing `producedMarkedValues_allSeams`.',
        ),
        because: text(
          '组合分类引理 `external_graftPlus_cases` 证明 `graftPlus` 的每条接缝必落入上述八个构造支之一，再由 `external_allSeamsFromBranches` 将八个分支的局部证明合并为全局 `allSeams`。',
          'By `external_graftPlus_cases`, every seam of `graftPlus` belongs to one of the eight branches, and `external_allSeamsFromBranches` assembles the eight branch proofs into `allSeams`.',
        ),
        dependsOn: [
          'unselected-old-seams',
          'selected-cut-seam',
          'internal-and-mirror-seams',
          'transverse-seams',
          'first-short-and-wrap-seams',
        ],
        derivation: [
          {
            statement: text(
              '由 `external_graftPlus_cases` 得 `graftPlus` 的任意接缝 $s$ 必属于八类接缝构造子之一。',
              'By `external_graftPlus_cases`, every seam $s$ of `graftPlus` falls into one of the eight seam branches.',
            ),
            reason: text(
              '穷举 `graftPlus` 的接缝列表定义，确保没有任何遗漏接缝。',
              'Exhausts the seam-list constructors of `graftPlus` with no missing cases.',
            ),
          },
          {
            statement: text(
              '调用 `external_allSeamsFromBranches` 并传入前五步给出的八个分支定理，直接得到 `producedMarkedValues_allSeams`。',
              'Applying `external_allSeamsFromBranches` to the eight branch theorems proves `producedMarkedValues_allSeams`.',
            ),
            reason: text(
              '对应最终主定理 `OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.producedMarkedValues_allSeams`。',
              'Proves the final theorem `OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.producedMarkedValues_allSeams`.',
            ),
          },
        ],
        next: text(
          '至此全接缝相容性主定理已完成端到端形式化验证。',
          'This completes the formal proof of full seam compatibility.',
        ),
        evidence: {
          theorems: [
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_graftPlus_cases',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.external_allSeamsFromBranches',
            'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.producedMarkedValues_allSeams',
          ],
          taskIds: ['character_original_goal'],
          deliveryIds: ['19ac5dd2-678b-4628-9399-26ac5c1d4282', 'd4c7394c-eb5a-480a-a0c7-ddb6cd331577'],
          checkIds: ['check-8c7fa4c63466a7f4bf51'],
          source: { name: 'Submission.lean', line: 3050, endLine: 3063 },
        },
      },
    ],
  },
];
