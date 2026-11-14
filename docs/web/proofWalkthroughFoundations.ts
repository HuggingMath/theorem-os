import type { ProofWalkthrough } from './proofWalkthroughTypes';

const text = (zh: string, en: string) => ({ zh, en });

export const foundationProofWalkthroughs: ProofWalkthrough[] = [
  {
    recordId: 'openai_cartier_chart_compactness_support',
    runId: '25c5cc6c-ec05-439c-bb42-7dd1ebeea45f',
    proofSha256: '3f4987016064040ed126b75de0aea0dfa6b2bf74b7dd22dfa1722b7fcc525963',
    title: { zh: '把坐标图回缩识别为已知的紧致赋值族', en: 'Identify chart retractions with a known compact valuation family' },
    strategy: text('严格正的归一化系数把非负权重限制在一个紧盒中；单射坐标展开使每个非零元素的赋值可写为有限个线性权重的最小值。分式上的评价因此逐点连续，紧致参数集的像就是所需回缩族。', 'Positive normalization coefficients confine the nonnegative weights to a compact box. The injective chart expansion expresses each nonzero-element valuation as a finite minimum of linear weights, making fraction evaluations continuous; the image of the compact parameter set is the required retraction family.'),
    stages: [{
      title: text('固定坐标与权重', 'Fix the chart and weights'),
      summary: text('由坐标图假设取得单射展开 $\\theta$，并从归一化等式推出 $w_i\\le 1/a_i$，明确紧致性要使用的参数集。', 'Obtain the injective expansion $\\theta$ from the chart hypotheses and derive $w_i\\le 1/a_i$ from normalization, identifying the parameter set for compactness.'),
      stepIds: ['fix-the-chart-hypotheses'],
    }, {
      title: text('证明赋值族紧致', 'Prove compactness of the valuation family'),
      summary: text('归一化截面是紧集；支撑上的有限最小公式与分式差公式给出逐点评价连续性，因此展开赋值族紧致。', 'The normalized section is compact. A finite-minimum support formula and the difference formula for fractions give pointwise continuity, so the expanded valuation family is compact.'),
      stepIds: ['instantiate-the-compact-family'],
    }, {
      title: text('识别题设回缩族', 'Identify the stated retraction family'),
      summary: text('展开局部回缩、分式延拓与坐标展开的定义，证明两族逐点相同，将一般紧致性结论转回原目标。', 'Unfold the local retraction, fraction extension and chart expansion to identify the two families pointwise and transfer compactness to the target.'),
      stepIds: ['identify-the-retraction'],
    }],
    goal: {
      zh: '在声明中的局部代数、形式 étale 与分式域条件下，对每个严格正的归一化系数 $a$，证明权重集合 $\\{w \\ge 0 : \\sum_i a_i w_i = 1\\}$ 对应的 $K$ 上回缩族在逐点评价拓扑中紧致。',
      en: 'Under the stated local-algebra, formally étale and fraction-field hypotheses, prove that the retractions on $K$ indexed by $\\{w \\ge 0 : \\sum_i a_i w_i = 1\\}$, for strictly positive $a$, form a compact set in the topology of pointwise evaluation.',
    },
    notation: {
      zh: '$\\sigma$ 是有限坐标集；$k$ 是代数闭域；$R$ 是多项式环在原点素理想处的局部化；$A$ 是题设的 Noether 局部整环，$K$ 是其分式域。$\\mathrm{normalizedWeights}\\,a$ 就是 $\\sum_i a_i w_i = 1$ 的非负权重截面。',
      en: '$\\sigma$ is the finite coordinate set; $k$ is algebraically closed; $R$ localizes the polynomial ring at its origin ideal; $A$ is the specified Noetherian local domain and $K$ its fraction field. $\\mathrm{normalizedWeights}\\,a$ is the nonnegative section $\\sum_i a_i w_i = 1$.',
    },
    steps: [
      {
        id: 'fix-the-chart-hypotheses',
        title: { zh: '先固定能使用坐标展开的代数条件', en: 'Fix the hypotheses for the chart expansion' },
        given: {
          zh: '$A$、$R$、$k$、$K$ 满足原声明中的代数塔、局部同态、形式无分歧、有限型与形式 étale 条件；$\\sigma$ 有限，且每个 $a_i > 0$。',
          en: '$A$, $R$, $k$ and $K$ satisfy the declared algebra towers, local-map, formally unramified, essentially finite-type and formally étale conditions; $\\sigma$ is finite and every $a_i > 0$.',
        },
        claim: {
          zh: '要研究的是函数族 $w \\mapsto (x \\mapsto \\mathrm{closedChartFieldRetraction}\\,w\\,x)$，参数取归一化截面 $\\sum_i a_i w_i = 1$，并保留上述坐标图假设。',
          en: 'The family is $w \\mapsto (x \\mapsto \\mathrm{closedChartFieldRetraction}\\,w\\,x)$, restricted to $\\sum_i a_i w_i = 1$; all the chart hypotheses remain part of the assertion.',
        },
        because: {
          zh: '声明把这些条件作为类型类假设，随后同时传给 closedChartExpansion 和它的单射性证明。严格正的 $a$ 是被调用紧致性引理的显式条件。',
          en: 'The declaration supplies these conditions to closedChartExpansion and its injectivity proof. Strict positivity of $a$ is an explicit input of the compactness lemma used below.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("$\\theta:A\\to k\\llbracket\\sigma\\rrbracket$ 是单射。", "$\\theta:A\\to k\\llbracket\\sigma\\rrbracket$ is injective."),
            reason: text("把题设的局部代数和形式 étale 条件代入 closedChartExpansion_injective；后面延拓到 $K$ 时正是用这份单射性排除非零元具有无限赋值。", "Apply closedChartExpansion_injective with the declared local-algebra and formally étale hypotheses. This injectivity makes the valuation finite on nonzero elements before extension to $K$."),
          },
          {
            statement: text("$W_a = \\{w\\in\\mathbb{R}_{\\ge 0}^{\\sigma} : \\sum_i a_i w_i = 1\\}$，且 $0\\le w_i\\le 1/a_i$。", "$W_a = \\{w\\in\\mathbb{R}_{\\ge 0}^{\\sigma} : \\sum_i a_i w_i = 1\\}$, with $0\\le w_i\\le 1/a_i$."),
            reason: text("各项 $a_i w_i$ 都非负，所以每项不超过总和 $1$；再用 $a_i>0$ 除过去。这说明为什么严格正的归一化系数能限制每个权重。", "Every term $a_i w_i$ is nonnegative and therefore at most the sum, one. Divide by $a_i>0$. This explains why strict positivity bounds every coordinate."),
          },
          {
            statement: text("要证明紧致的是 $F(W_a)$，$F(w)(x)=\\mathrm{closedChartFieldRetraction}(w)(x)$。", "The target is compactness of $F(W_a)$, where $F(w)(x)=\\mathrm{closedChartFieldRetraction}(w)(x)$."),
            reason: text("目标里的双函数依次取权重和分式域元素；把它看作函数空间中的映射，下一步就能使用“紧致集的连续像紧致”。", "The two function arguments are a weight and then a fraction-field element. Reading this as a map into a function space prepares the compact-image argument."),
          },
        ],
        next: { zh: '用这个特定坐标展开实例化一般的分式域赋值构造。', en: 'Instantiate the general fraction-field valuation construction with this chart expansion.' },
        evidence: {
          theorems: ['OAI.CartierSections.isCompact_closedChartFieldRetraction_cone'],
          taskIds: ['initial_goal_1'], checkIds: ['check-43388526f3070ac13330'],
          source: { name: 'Submission.lean', line: 15, endLine: 29 },
        },
      },
      {
        id: 'instantiate-the-compact-family',
        title: { zh: '把单射坐标展开代入紧致性引理', en: 'Apply compactness to the injective coordinate expansion' },
        given: {
          zh: '取 $\\theta = \\mathrm{closedChartExpansion} : A \\to_a[k] k\\llbracket\\sigma\\rrbracket$，并使用已导入的 closedChartExpansion_injective。',
          en: 'Take $\\theta = \\mathrm{closedChartExpansion} : A \\to_a[k] k\\llbracket\\sigma\\rrbracket$ and the imported proof closedChartExpansion_injective.',
        },
        claim: {
          zh: '一般引理给出 $\\{x \\mapsto \\mathrm{expandedFractionValuation}\\,\\theta\\,h_\\theta\\,w\\,x : w \\in \\mathrm{normalizedWeights}\\,a\\}$ 紧致。',
          en: 'The general lemma yields compactness of $\\{x \\mapsto \\mathrm{expandedFractionValuation}\\,\\theta\\,h_\\theta\\,w\\,x : w \\in \\mathrm{normalizedWeights}\\,a\\}$.',
        },
        because: {
          zh: '最终证明直接调用 isCompact_expandedFractionValuation_cone，显式提供 $\\theta$、其单射性、$a$ 和 $ha$。该库引理已封装归一化权重截面的紧致性及赋值的逐点评价连续性。',
          en: 'The final proof directly calls isCompact_expandedFractionValuation_cone with $\\theta$, its injectivity proof, $a$ and $ha$. That library lemma supplies compactness of the normalized weight section and continuity of valuation evaluations.',
        },
        dependsOn: ["fix-the-chart-hypotheses"],
        derivation: [
          {
            statement: text("$W_a$ 是有限盒 $\\prod_i [0,1/a_i]$ 中的闭集，因此紧致。", "$W_a$ is a closed subset of the finite box $\\prod_i [0,1/a_i]$, hence compact."),
            reason: text("坐标上界来自前一步；$w\\mapsto\\sum_i a_i w_i$ 连续，所以取值为 $1$ 的截面闭。有限个闭有界区间的乘积紧致，闭子集仍紧致。", "The previous step bounds each coordinate. The continuous map $w\\mapsto\\sum_i a_i w_i$ has a closed level set at one. A finite product of compact intervals is compact, as is its closed subset."),
          },
          {
            statement: text("对非零 $p\\in A$，$v_w(p)=\\min_{d\\in T_p}\\sum_i w_i d_i$，其中 $T_p$ 有限。", "For nonzero $p\\in A$, $v_w(p)=\\min_{d\\in T_p}\\sum_i w_i d_i$ for a finite set $T_p$."),
            reason: text("库证明从 $\\theta(p)$ 的支撑选出有限子集，使每个支撑指数都逐项大于等于其中某个指数。因 $w_i\\ge 0$，剩余指数的权重不可能更小；有限个连续线性权重的最小值仍连续。", "The library selects a finite subset of the support of $\\theta(p)$ such that every support exponent is at least one selected exponent in each coordinate. Nonnegative weights make the remaining weights no smaller; a finite minimum of continuous linear weights is continuous."),
          },
          {
            statement: text("$x=p/q\\ne 0 \\Rightarrow V_w(x)=v_w(p)-v_w(q)$，且两项都有限。", "For $x=p/q\\ne 0$, $V_w(x)=v_w(p)-v_w(q)$, with both values finite."),
            reason: text("$q$ 可取非零，$x\\ne 0$ 又使 $p\\ne 0$；单射 $\\theta$ 使拉回赋值在这两个元素上有限。因此这里相减的是实数。", "Choose $q\\ne 0$; then $x\\ne 0$ implies $p\\ne 0$. Injectivity of $\\theta$ makes the pulled-back values finite, so the subtraction is between real numbers."),
          },
          {
            statement: text("$w\\mapsto V_w(x)$ 对每个 $x\\in K$ 连续；$x=0$ 时恒为 $\\top$。", "For each $x\\in K$, $w\\mapsto V_w(x)$ is continuous; for $x=0$ it is constantly $\\top$."),
            reason: text("非零分式使用前一行的两个连续实函数之差；零分式单独使用常函数。逐点评价拓扑下，各坐标连续就给出整个函数族连续。", "For a nonzero fraction use the difference of two continuous real functions; handle zero as a constant function. Coordinatewise continuity gives continuity in the pointwise topology."),
          },
          {
            statement: text("$W_a$ 紧致 $\\Rightarrow \\{V_w : w\\in W_a\\}$ 紧致。", "Compactness of $W_a$ implies compactness of $\\{V_w : w\\in W_a\\}$."),
            reason: text("被调用的 isCompact_expandedFractionValuation_cone 正是把归一化截面的紧致性与这个连续映射相接，随后对 $\\theta$ 和 $h_\\theta$ 实例化。", "The invoked isCompact_expandedFractionValuation_cone takes the continuous image of the compact normalized section, instantiated at $\\theta$ and $h_\\theta$."),
          },
        ],
        next: { zh: '剩下只需核对一般赋值族与题目中的回缩族是同一构造。', en: 'It remains to identify this general valuation family with the requested retractions.' },
        evidence: {
          theorems: ['OAI.CartierSections.isCompact_expandedFractionValuation_cone', 'OAI.CartierSections.closedChartExpansion_injective'],
          taskIds: ['initial_goal_1'], checkIds: ['check-43388526f3070ac13330'],
          source: { name: 'Submission.lean', line: 25, endLine: 34 },
        },
      },
      {
        id: 'identify-the-retraction',
        title: { zh: '展开三个定义，得到原结论', en: 'Unfold three definitions to obtain the target' },
        given: { zh: '上一步已得到展开赋值在分式域 $K$ 上的紧致函数族。', en: 'The preceding step gives a compact family of expanded valuations on $K$.' },
        claim: {
          zh: '这恰好是 $\\{x \\mapsto \\mathrm{closedChartFieldRetraction}\\,w\\,x : w \\in \\mathrm{normalizedWeights}\\,a\\}$，因此目标中的 IsCompact 成立。',
          en: 'This is exactly $\\{x \\mapsto \\mathrm{closedChartFieldRetraction}\\,w\\,x : w \\in \\mathrm{normalizedWeights}\\,a\\}$, so the required IsCompact statement follows.',
        },
        because: {
          zh: '展开 expandedFractionValuation、closedChartFieldRetraction、closedChartRetraction 后，两边都是将 $\\theta$ 拉回的单项式赋值延拓到分式域。simpa only 通过这三个定义的相等，把上一步的紧致性直接用于目标函数族。',
          en: 'simpa only unfolds expandedFractionValuation, closedChartFieldRetraction and closedChartRetraction. Both sides extend the monomial valuation pulled back along $\\theta$ to the fraction field; the main file proves the target by this identification.',
        },
        dependsOn: ["instantiate-the-compact-family"],
        derivation: [
          {
            statement: text("$\\mathrm{closedChartRetraction}(w)=\\mathrm{expansionValuation}(\\theta,w)$。", "$\\mathrm{closedChartRetraction}(w)=\\mathrm{expansionValuation}(\\theta,w)$."),
            reason: text("展开局部回缩的定义后，就是沿选定坐标展开 $\\theta$ 拉回的单项式赋值；参数 $w$ 没有发生变换。", "Unfolding the local retraction gives the monomial valuation pulled back along $\\theta$, with the same weight $w$."),
          },
          {
            statement: text("$\\mathrm{closedChartFieldRetraction}(w)=\\mathrm{expandedFractionValuation}(\\theta,h_\\theta,w)$。", "$\\mathrm{closedChartFieldRetraction}(w)=\\mathrm{expandedFractionValuation}(\\theta,h_\\theta,w)$."),
            reason: text("两者再用同一个 fractionValuation 将上一行的局部赋值延拓到 $K$。最终的 simpa only 只展开这三个定义。", "Both apply the same fractionValuation construction to extend that local valuation to $K$. The final simpa only unfolds precisely these definitions."),
          },
          {
            statement: text("$F(W_a) = \\{V_w : w\\in W_a\\}$，故 $\\mathrm{IsCompact}(F(W_a))$。", "$F(W_a) = \\{V_w : w\\in W_a\\}$, hence $\\mathrm{IsCompact}(F(W_a))$."),
            reason: text("逐点相等使两组像集相同，因此上一步的紧致集就是原目标中的集合。", "Pointwise equality identifies the image sets, so the compact set from the preceding step is exactly the set in the target."),
          },
        ],
        next: { zh: '完成原声明：紧致性属于这些指定假设下的归一化回缩族。', en: 'This completes compactness for the normalized retraction family under the declared hypotheses.' },
        evidence: {
          theorems: ['OAI.CartierSections.isCompact_closedChartFieldRetraction_cone'],
          taskIds: ['initial_goal_1'], deliveryIds: ['74cdf1e1-3c97-45ad-b3fd-dd0531a0807d'], checkIds: ['check-43388526f3070ac13330'],
          source: { name: 'Submission.lean', line: 25, endLine: 34 },
        },
      },
    ],
  },
  {
    recordId: 'openai_truffet_counterexample',
    runId: 'de7a57e9-becf-4f94-9276-2090ab3f2738',
    proofSha256: '442334bfd22cf81c9582b071cd6b370f2b6969d961418e6b084a25cc87ae4a91',
    title: { zh: '两次被强制的消元仍得到非最优解', en: 'Two forced eliminations still yield a nonoptimal output' },
    strategy: text('把具体 max-plus 系统写成两个普通不等式，核对规则只能依次令 $w_1=w_2$、$w_0=1+w_2$。归一化后输出成本为 $1$，而原约束还允许成本为 $0$ 的点，因此这次合法且终止的执行产生了非最优输出。', 'Write the concrete max-plus system as two ordinary inequalities and show the rules force $w_1=w_2$ followed by $w_0=1+w_2$. The normalized output costs one, while another point satisfying the original constraints costs zero, so this legal terminating execution is nonoptimal.'),
    stages: [{
      title: text('读出合法反例系统', 'Specify the counterexample system'),
      summary: text('从三列系数读出两条约束与目标 $c(w)=w_0$，并核对 crossRowRestriction，确定反例满足题设前提。', 'Read the two constraints and objective $c(w)=w_0$ from the coefficient rows and verify crossRowRestriction, establishing the required hypotheses.'),
      stepIds: ['write-the-concrete-system'],
    }, {
      title: text('跟踪唯一消元路线', 'Follow the forced eliminations'),
      summary: text('第一步代换 $w_1=w_2$，第二步代换 $w_0=1+w_2$；同时更新约束与目标，得到无剩余变量的终止状态。', 'Substitute $w_1=w_2$ and then $w_0=1+w_2$, updating constraints and objective together until no variables remain and the execution stops.'),
      stepIds: ['force-the-first-elimination', 'force-the-second-elimination'],
    }, {
      title: text('比较两个原可行点', 'Compare two originally feasible points'),
      summary: text('代回得到可行输出 $(1,0,0)$，再直接核验 $(0,-1,0)$ 也满足原约束；成本 $0<1$ 完成非最优性反例。', 'Reconstruct the feasible output $(1,0,0)$ and verify that $(0,-1,0)$ also satisfies the original constraints. The comparison $0<1$ proves nonoptimality.'),
      stepIds: ['reconstruct-the-output', 'exhibit-the-better-point'],
    }],
    goal: {
      zh: '给出满足 crossRowRestriction 的具体 max-plus 系统，证明其执行只能依次消去变量 $1$、$0$ 并停止，但重建的可行输出成本为 $1$，另有成本为 $0$ 的可行点。',
      en: 'Exhibit a max-plus system satisfying crossRowRestriction whose forced execution eliminates variables $1$ then $0$ and stops, while its reconstructed feasible output has cost $1$ and another feasible point has cost $0$.',
    },
    notation: {
      zh: '$\\bot$ 表示 $-\\infty$。线性型的“和”用 $\\max$ 计算，系数作用是普通加法。可行点 $w$ 满足每行 $\\mathrm{rhs}(w) \\le \\mathrm{lhs}(w)$。第三坐标 $w_2$ 是归一化坐标；比较的两个点都取 $w_2 = 0$。',
      en: '$\\bot$ denotes $-\\infty$. Forms evaluate by taking a maximum of coefficient-plus-coordinate terms. Feasibility means $\\mathrm{rhs}(w) \\le \\mathrm{lhs}(w)$ in every row. The third coordinate $w_2$ is normalized to zero at both comparison points.',
    },
    steps: [
      {
        id: 'write-the-concrete-system',
        title: { zh: '先把三列系数读成两个不等式', en: 'Translate the coefficient rows into two inequalities' },
        given: { zh: '初始两行及目标函数由 initial 固定。', en: 'initial fixes the two rows and the objective.' },
        claim: {
          zh: '约束为 $w_2 \\le \\max(w_0,w_1)$、$\\max(1+w_1,-2+w_2) \\le w_0$，目标为 $c(w)=w_0$；这个系统还满足题设的 crossRowRestriction。',
          en: 'The constraints are $w_2 \\le \\max(w_0,w_1)$ and $\\max(1+w_1,-2+w_2) \\le w_0$, with objective $c(w)=w_0$. This system also satisfies crossRowRestriction.',
        },
        because: {
          zh: '按 eval 展开，$\\bot$ 项消失，$0$ 系数直接保留坐标。对任意 $\\alpha$，取 $w=(0,0,|\\alpha|+10)$：第一行 $\\mathrm{lhs}=0$、另一行 $\\mathrm{rhs}=|\\alpha|+8$，反向比较的 $\\mathrm{lhs}=0$、$\\mathrm{rhs}=|\\alpha|+10$；$\\alpha \\ge -|\\alpha|$ 使两项严格交叉不等式都成立。',
          en: 'Expanding eval removes the $\\bot$ terms. For any $\\alpha$, choose $w=(0,0,|\\alpha|+10)$. One cross-row comparison has $\\mathrm{lhs}=0$ and $\\mathrm{rhs}=|\\alpha|+8$; the other has $\\mathrm{lhs}=0$ and $\\mathrm{rhs}=|\\alpha|+10$. Since $\\alpha \\ge -|\\alpha|$, both required strict inequalities hold.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("第 $0$ 行：$w_2\\le\\max(w_0,w_1)$；第 $1$ 行：$\\max(1+w_1,-2+w_2)\\le w_0$。", "Row $0$: $w_2\\le\\max(w_0,w_1)$; row $1$: $\\max(1+w_1,-2+w_2)\\le w_0$."),
            reason: text("eval 对每行取“系数加坐标”的最大值；$\\bot+w=\\bot$ 的项不影响最大值，剩下的有限系数直接给出这两式。", "eval takes the maximum of coefficient-plus-coordinate terms. Terms $\\bot+w=\\bot$ disappear from the maximum, leaving the displayed inequalities."),
          },
          {
            statement: text("任取 $\\alpha$，令 $w=(0,0,|\\alpha|+10)$，得 $\\mathrm{lhs}_0=\\mathrm{lhs}_1=0$、$\\mathrm{rhs}_1=|\\alpha|+8$、$\\mathrm{rhs}_0=|\\alpha|+10$。", "For arbitrary $\\alpha$, $w=(0,0,|\\alpha|+10)$ gives $\\mathrm{lhs}_0=\\mathrm{lhs}_1=0$, $\\mathrm{rhs}_1=|\\alpha|+8$ and $\\mathrm{rhs}_0=|\\alpha|+10$."),
            reason: text("第二行 $\\mathrm{rhs}$ 的另一项为 $1$，而 $|\\alpha|+8\\ge 8$；因此最大值确为 $|\\alpha|+8$。", "The other term in $\\mathrm{rhs}_1$ is one, while $|\\alpha|+8\\ge 8$, so its maximum is indeed $|\\alpha|+8$."),
          },
          {
            statement: text("$0<\\alpha+|\\alpha|+8$，且 $0<\\alpha+|\\alpha|+10$。", "$0<\\alpha+|\\alpha|+8$ and $0<\\alpha+|\\alpha|+10$."),
            reason: text("由 $\\alpha\\ge -|\\alpha|$，两个右端分别至少为 $8$ 和 $10$。这核对了两种不同行索引的 crossRowRestriction，目标函数则为 $c(w)=w_0$。", "Since $\\alpha\\ge -|\\alpha|$, the right sides are at least eight and ten. These verify both distinct-row cases of crossRowRestriction; the objective is $c(w)=w_0$."),
          },
        ],
        next: { zh: '在这个合法初始系统上，核对规则允许的第一步是不是唯一的。', en: 'Determine which elimination is eligible in this initial system.' },
        evidence: {
          theorems: ['OAI.TruffetV4Counterexample.crossRowRestriction_initial', 'OAI.TruffetV4Counterexample.crossRow_0_1', 'OAI.TruffetV4Counterexample.crossRow_1_0'],
          taskIds: ['initial_goal_1'], checkIds: ['check-e921c5e179d84067ed74'],
          source: { name: 'Submission.lean', line: 481, endLine: 502 },
        },
      },
      {
        id: 'force-the-first-elimination',
        title: { zh: '唯一允许的第一步令 w₁ = w₂', en: 'The unique first elimination sets w₁ = w₂' },
        given: { zh: '待消元变量为 $\\{0,1\\}$；第三坐标 $w_2$ 是参考列。变量 $1$ 同时有 lower 与 upper 行，是初始系统唯一的 dominating 变量。', en: 'The eliminable variables are $\\{0,1\\}$; $w_2$ is the reference column. Variable $1$ has both a lower row and an upper row and is the only dominating variable initially.' },
        claim: {
          zh: '$\\mathrm{eligible}(\\mathrm{initial},r,j)$ 当且仅当 $(r,j)=(0,1)$。其 lowerForm 求值为 $w_2$；代入后得到 middle：第一行被清理，第二行变成 $1+w_2 \\le w_0$，目标仍为 $w_0$。',
          en: '$\\mathrm{eligible}(\\mathrm{initial},r,j)$ holds exactly for $(r,j)=(0,1)$. Its lowerForm evaluates to $w_2$. Substitution yields middle: the first row is removed, the remaining inequality is $1+w_2 \\le w_0$, and the objective remains $w_0$.',
        },
        because: {
          zh: '只有变量 $1$ 有上界行，而它的 lower 行只有第 $0$ 行，所以 eligible 的 dominating 条件固定了这对索引。将 $w_1=w_2$ 代入，首行成为 $w_2 \\le \\max(w_0,w_2)$，系数逐项被 $\\mathrm{lhs}$ 控制而清理；次行右侧 $\\max(1+w_2,-2+w_2)=1+w_2$。',
          en: 'Only variable $1$ has an upper row, and its only lower row is row $0$, fixing the eligible pair. Substituting $w_1=w_2$ makes the first row $w_2 \\le \\max(w_0,w_2)$, so cleanup removes it. The second right side becomes $\\max(1+w_2,-2+w_2)=1+w_2$.',
        },
        dependsOn: ["write-the-concrete-system"],
        derivation: [
          {
            statement: text("$\\mathrm{eligible}(\\mathrm{initial},r,j) \\iff (r,j)=(0,1)$。", "$\\mathrm{eligible}(\\mathrm{initial},r,j)$ iff $(r,j)=(0,1)$."),
            reason: text("初始状态只有变量 $1$ 有 upper 行；该变量的 lower 行只有第 $0$ 行，因而规则所需的两个条件共同固定 $r$、$j$。", "Only variable $1$ has an upper row initially, and its sole lower row is row $0$. These eligibility conditions fix both indices."),
          },
          {
            statement: text("$\\mathrm{lowerForm}(\\mathrm{initial},0,1)(w)=w_2$，所以代换为 $w_1=w_2$。", "$\\mathrm{lowerForm}(\\mathrm{initial},0,1)(w)=w_2$, so substitute $w_1=w_2$."),
            reason: text("该 lowerForm 只有第三列的系数 $0$ 有限；其余两列为 $\\bot$，求值只剩 $0+w_2$。", "Only the third-column coefficient zero is finite; the other two coefficients are $\\bot$, leaving $0+w_2$."),
          },
          {
            statement: text('“唯一”指算法只允许这次代换；原可行域仍允许 $w_1\\ne w_2$。', 'Uniqueness is about the eligible algorithmic step; the original feasible set still allows $w_1\\ne w_2$.'),
            reason: text('例如后面要核对的 $(0,-1,0)$ 满足原约束，却不满足 $w_1=w_2$。不能把保存的代回等式当作原约束推出的等式。', 'The later point $(0,-1,0)$ satisfies the original constraints but not $w_1=w_2$. The saved reconstruction equality is not an equality implied by the original constraints.'),
          },
          {
            statement: text("$w_2\\le\\max(w_0,w_2)$ 自动成立；$\\max(1+w_2,-2+w_2)=1+w_2$。", "$w_2\\le\\max(w_0,w_2)$ is automatic; $\\max(1+w_2,-2+w_2)=1+w_2$."),
            reason: text("第一行被 cleanup 删除；第二行的两个系数比较为 $1>-2$，所以保留约束 $1+w_2\\le w_0$，得到 middle。", "cleanup removes the first row. In the second row, $1>-2$ leaves the single inequality $1+w_2\\le w_0$, giving middle."),
          },
        ],
        next: { zh: 'middle 只剩变量 $0$；对这个精确后继状态检查下一步。', en: 'The exact successor middle has only variable $0$ remaining; examine its next step.' },
        evidence: {
          theorems: ['OAI.TruffetV4Counterexample.initial_eligible_iff', 'OAI.TruffetV4Counterexample.lowerForm_initial', 'OAI.TruffetV4Counterexample.advance_initial_eq'],
          taskIds: ['initial_goal_1'], checkIds: ['check-e921c5e179d84067ed74'],
          source: { name: 'Submission.lean', line: 259, endLine: 280 },
        },
      },
      {
        id: 'force-the-second-elimination',
        figure: 'truffet-elimination',
        title: { zh: '第二步令 w₀ = 1+w₂ 并终止', en: 'The second elimination sets w₀ = 1+w₂ and terminates' },
        given: { zh: 'middle 只有变量 $0$ 未消去，其唯一 lower 行是第 $1$ 行。', en: 'Only variable $0$ remains in middle, with row $1$ its sole lower row.' },
        claim: {
          zh: '第二步唯一为 $(r,j)=(1,0)$。代入 $w_0=1+w_2$ 后，两行都被清理，目标变成 $1+w_2$；没有剩余变量，finalState 满足 stop。',
          en: 'The unique second step is $(r,j)=(1,0)$. Substituting $w_0=1+w_2$ removes both rows and changes the objective to $1+w_2$. No variable remains and finalState satisfies stop.',
        },
        because: {
          zh: 'lowerForm_middle 的唯一有限系数为第三列的 $1$。代回唯一约束得到 $1+w_2 \\le 1+w_2$，因而 cleanup 清空它；remaining 同时删去 $0$。forced_step_initial 与 forced_step_middle 还逐项核对 wellFormed、bounded、未 stop/switch/failure 和代换目标非空等执行前提。',
          en: 'lowerForm_middle has only the finite third-column coefficient $1$. Substitution makes the remaining constraint $1+w_2 \\le 1+w_2$, so cleanup removes it and remaining deletes $0$. The two forced_step lemmas also verify well-formedness, boundedness, no premature stop/switch/failure and a nonempty substituted objective.',
        },
        dependsOn: ["force-the-first-elimination"],
        derivation: [
          {
            statement: text("middle 的 $\\mathrm{remaining}=\\{0\\}$，唯一 lower 行为 $r=1$。", "middle has $\\mathrm{remaining}=\\{0\\}$, and its only lower row is $r=1$."),
            reason: text("第一步删去变量 $1$；在明确的 middle 系数上检查 lower 条件，只剩第 $1$ 行允许消去变量 $0$。", "The first step removes variable $1$. Checking the explicit middle coefficients leaves row $1$ as the only lower row for variable $0$."),
          },
          {
            statement: text("$\\mathrm{lowerForm}(\\mathrm{middle},1,0)(w)=1+w_2$，所以代换 $w_0=1+w_2$。", "$\\mathrm{lowerForm}(\\mathrm{middle},1,0)(w)=1+w_2$, so substitute $w_0=1+w_2$."),
            reason: text("lowerForm 的第三列系数为 $1$，其余为 $\\bot$；求最大值后只有这一项。", "Its third-column coefficient is one and the others are $\\bot$, so this is the only finite term in the maximum."),
          },
          {
            statement: text("$1+w_2\\le 1+w_2$，$\\mathrm{remaining}=\\emptyset$，$c_{\\mathrm{final}}(w)=1+w_2$。", "$1+w_2\\le 1+w_2$, $\\mathrm{remaining}=\\emptyset$ and $c_{\\mathrm{final}}(w)=1+w_2$."),
            reason: text("剩余约束变成恒等不等式而被清理；目标原为 $w_0$，随同一代换变为 $1+w_2$。两个空行的参考列都满足 $\\bot\\le\\bot$，因此本例的 stop 成立；$\\mathrm{remaining}=\\emptyset$ 则另行核对。", "The remaining inequality is tautological and removed. The original objective $w_0$ becomes $1+w_2$. Both cleared rows satisfy $\\bot\\le\\bot$ in the reference column, establishing stop in this example; $\\mathrm{remaining}=\\emptyset$ is checked separately."),
          },
        ],
        next: { zh: '固定 $w_2=0$，按两个代回等式得到算法的具体输出。', en: 'Set $w_2=0$ and reconstruct the output using the two substitution equations.' },
        evidence: {
          theorems: ['OAI.TruffetV4Counterexample.forced_step_initial', 'OAI.TruffetV4Counterexample.forced_step_middle', 'OAI.TruffetV4Counterexample.stop_final'],
          taskIds: ['initial_goal_1'], checkIds: ['check-e921c5e179d84067ed74'],
          source: { name: 'Submission.lean', line: 529, endLine: 550 },
        },
      },
      {
        id: 'reconstruct-the-output',
        title: { zh: '算法输出可行，成本确为 1', en: 'The reconstructed output is feasible and has cost one' },
        given: { zh: '取 $\\mathrm{output}=(1,0,0)$，即 $w_2=0$、$w_1=w_2$、$w_0=1+w_2$。', en: 'Take $\\mathrm{output}=(1,0,0)$, so $w_2=0$, $w_1=w_2$ and $w_0=1+w_2$.' },
        claim: {
          zh: 'output 满足原系统，并且 $c_{\\mathrm{initial}}(\\mathrm{output})=c_{\\mathrm{final}}(\\mathrm{output})=1$；两个 lowerForm 代回等式也都成立。',
          en: 'output satisfies the original system, and $c_{\\mathrm{initial}}(\\mathrm{output})=c_{\\mathrm{final}}(\\mathrm{output})=1$. Both lowerForm reconstruction equalities also hold.',
        },
        because: {
          zh: '原约束化为 $0 \\le \\max(1,0)=1$ 和 $\\max(1,-2)=1 \\le 1$。第一步 lowerForm 的值为 $0=\\mathrm{output}_1$，第二步为 $1=\\mathrm{output}_0$；原目标是 $w_0$，最终目标是 $1+w_2$，代入都等于 $1$。',
          en: 'The constraints reduce to $0 \\le \\max(1,0)=1$ and $\\max(1,-2)=1 \\le 1$. The two lowerForms evaluate to $0=\\mathrm{output}_1$ and $1=\\mathrm{output}_0$. The initial objective $w_0$ and final objective $1+w_2$ both evaluate to one.',
        },
        dependsOn: ["force-the-first-elimination", "force-the-second-elimination"],
        derivation: [
          {
            statement: text("$w_2=0 \\Rightarrow w_1=w_2=0$，$w_0=1+w_2=1$。", "$w_2=0$ implies $w_1=w_2=0$ and $w_0=1+w_2=1$."),
            reason: text("把归一化值代回两步保存的 lowerForm 等式，就得到 $\\mathrm{output}=(1,0,0)$。", "Substitute the normalization into the two saved lowerForm equalities to obtain $\\mathrm{output}=(1,0,0)$."),
          },
          {
            statement: text("$0\\le\\max(1,0)=1$；$\\max(1+0,-2+0)=1\\le 1$。", "$0\\le\\max(1,0)=1$; $\\max(1+0,-2+0)=1\\le 1$."),
            reason: text("这是 output 在两条原约束中的直接代入，因此检查的是原始可行性。", "These are direct substitutions into both original rows, verifying feasibility for the original system."),
          },
          {
            statement: text("$c_{\\mathrm{initial}}(\\mathrm{output})=w_0=1=c_{\\mathrm{final}}(\\mathrm{output})=1+w_2$。", "$c_{\\mathrm{initial}}(\\mathrm{output})=w_0=1=c_{\\mathrm{final}}(\\mathrm{output})=1+w_2$."),
            reason: text("代换前后的目标在该重建点上一致，但这个等式本身尚未比较任何其他可行点。", "The objectives agree at the reconstructed point. This equality by itself makes no comparison with other feasible points."),
          },
        ],
        next: { zh: '可行并不保证最优；还需在相同原系统中给出严格更优的点。', en: 'To test optimality, compare this with another feasible point of the original system.' },
        evidence: {
          theorems: ['OAI.TruffetV4Counterexample.feasible_initial_output', 'OAI.TruffetV4Counterexample.finite_execution_not_optimal'],
          taskIds: ['initial_goal_1'], checkIds: ['check-e921c5e179d84067ed74'],
          source: { name: 'Submission.lean', line: 545, endLine: 566 },
        },
      },
      {
        id: 'exhibit-the-better-point',
        title: { zh: '另一个可行点把成本降到 0', en: 'Another feasible point lowers the cost to zero' },
        given: { zh: '取 $\\mathrm{better}=(0,-1,0)$，仍满足同一个归一化条件 $w_2=0$。', en: 'Take $\\mathrm{better}=(0,-1,0)$, with the same normalization $w_2=0$.' },
        claim: { zh: 'better 对原系统可行，且 $c_{\\mathrm{initial}}(\\mathrm{better})=0 < 1=c_{\\mathrm{final}}(\\mathrm{output})$，所以这次有限终止执行的输出不是最优解。', en: 'better is feasible for the original system and $c_{\\mathrm{initial}}(\\mathrm{better})=0 < 1=c_{\\mathrm{final}}(\\mathrm{output})$, so this terminating execution returns a nonoptimal output.' },
        because: {
          zh: '代入两条原约束得到 $0 \\le \\max(0,-1)=0$ 和 $\\max(1-1,-2)=0 \\le 0$，目标 $w_0=0$。两个可行点的严格成本差说明算法输出仍可改进，完成反例。',
          en: 'The original constraints become $0 \\le \\max(0,-1)=0$ and $\\max(1-1,-2)=0 \\le 0$, while the objective $w_0$ is zero. The strict comparison between two explicit feasible points proves nonoptimality.',
        },
        dependsOn: ["write-the-concrete-system", "reconstruct-the-output"],
        derivation: [
          {
            statement: text('在 $w_2=0$ 的截面，原约束等价于 $w_0\\ge 0$、$w_1\\le w_0-1$。', 'On the section $w_2=0$, the original constraints are equivalent to $w_0\\ge 0$ and $w_1\\le w_0-1$.'),
            reason: text('第二行给出 $w_0\\ge 1+w_1$ 和 $w_0\\ge -2$。若 $w_0<0$，第一行 $0\\le\\max(w_0,w_1)$ 就要求 $w_1\\ge 0$，进而 $w_0\\ge 1$，矛盾。因此 $w_0\\ge 0$；反向代入则两行都成立。', 'The second row gives $w_0\\ge 1+w_1$ and $w_0\\ge -2$. If $w_0<0$, the first row requires $w_1\\ge 0$, forcing $w_0\\ge 1$, a contradiction. Thus $w_0\\ge 0$. Conversely these two inequalities imply both original rows.'),
          },
          {
            statement: text("$\\mathrm{better}=(0,-1,0)$：$0\\le\\max(0,-1)=0$。", "At $\\mathrm{better}=(0,-1,0)$, $0\\le\\max(0,-1)=0$."),
            reason: text("保留同一个归一化 $w_2=0$，第一条原约束恰好取等号。", "The normalization $w_2=0$ is unchanged, and the first original constraint holds with equality."),
          },
          {
            statement: text("$\\max(1+(-1),-2+0)=\\max(0,-2)=0\\le w_0=0$。", "$\\max(1+(-1),-2+0)=\\max(0,-2)=0\\le w_0=0$."),
            reason: text("第二条原约束也成立；这个点不需要满足算法额外选取的代回等式 $w_1=w_2$。", "The second original constraint also holds. This point need not obey the algorithm’s additional reconstruction choice $w_1=w_2$."),
          },
          {
            statement: text("$c_{\\mathrm{initial}}(\\mathrm{better})=0<1=c_{\\mathrm{initial}}(\\mathrm{output})$。", "$c_{\\mathrm{initial}}(\\mathrm{better})=0<1=c_{\\mathrm{initial}}(\\mathrm{output})$."),
            reason: text("两点都对同一个原系统可行，而目标只读 $w_0$；因此严格成本差已经足以反驳输出最优。", "Both points are feasible for the same original system and the objective reads only $w_0$. Their strict cost gap disproves optimality of the output."),
          },
        ],
        next: { zh: '与唯一消元步骤及 crossRowRestriction 合并，完成目标中的反例合取式。', en: 'Combine the strict cost comparison with the forced steps and crossRowRestriction to complete the counterexample.' },
        evidence: {
          theorems: ['OAI.TruffetV4Counterexample.feasible_initial_better', 'OAI.TruffetV4Counterexample.eval_initial_cost_better', 'OAI.TruffetV4Counterexample.eval_final_cost_output', 'OAI.TruffetV4Counterexample.finite_execution_not_optimal'],
          taskIds: ['initial_goal_1'], checkIds: ['check-e921c5e179d84067ed74'],
          source: { name: 'Submission.lean', line: 380, endLine: 397 },
        },
      },
    ],
  },
  {
    recordId: 'openai_snaky_certificate',
    runId: '6d22ec7c-5c2b-41a4-911d-dcf3f0b7ddf0',
    proofSha256: 'b7dc0b2898b8d4ee8ed4a3b10394429f939ff9e4d73761dcd6968e46a4579751',
    title: { zh: '逐层重建 Snaky 有限证书', en: 'Reconstruct the finite Snaky certificate' },
    strategy: text('先证明所有 child 索引严格向前引用，再按旋转、平移与分叉公式重建 $616$ 行。对重建后的有限集合逐行核验包络、深度和四个指定几何输出，最后与放置项总数合成证书正确性。', 'Verify that every child refers to an earlier row, then reconstruct all $616$ rows by orientation, translation and forking. Check their finite envelopes, heights and four specified geometric outputs, and combine these with the total placement count to establish certificate correctness.'),
    stages: [{
      title: text('按顺序重建证书', 'Reconstruct the certificate in order'),
      summary: text('非空且索引递减的表项保证递归可求值；放置与分叉公式把六个基础行依次扩展为全部行。', 'Nonempty entries with decreasing child indices make the recursion evaluable. Placement and fork formulas extend the six base rows to every later row.'),
      stepIds: ['validate-the-recursion-table', 'reconstruct-the-fork', 'reconstruct-two-children'],
    }, {
      title: text('核验集合与关键局面', 'Check sets and distinguished positions'),
      summary: text('逐行验证所需点、包络和高度界，再读出四个关键行的精确大小与避让区域，提供目标所需的几何证据。', 'Check required cells, envelopes and height bounds row by row, then verify the exact sizes and omitted regions of the four distinguished rows.'),
      stepIds: ['verify-all-row-invariants', 'check-the-distinguished-rows'],
    }, {
      title: text('合成完整核验结果', 'Assemble the complete verification'),
      summary: text('将 $1,837$ 个放置项的计数与索引、四个输出、全部行不变量汇合，完成 certificate_correct 的七项结论。', 'Combine the count of $1,837$ placements with table validity, the four outputs and all-row invariants to obtain the seven conjuncts of certificate_correct.'),
      stepIds: ['assemble-the-certificate'],
    }],
    goal: {
      zh: '核验 $610$ 条递归表项、$1,837$ 个放置项、四个指定局面的精确几何数据，以及全部 $616$ 个局面的集合关系与深度 $\\le 34$。',
      en: 'Verify $610$ recursive table entries, $1,837$ placements, the exact geometry of four specified rows, and the set invariants and depth bound $\\le 34$ for all $616$ rows.',
    },
    notation: {
      zh: '格点是 $\\mathbb{Z}^2$，$o = (0,0)$。每行记为 $(A,H,h)$：$A$ 是所需格点集，$H$ 是包络，$h$ 是递归高度。六个基础行来自 Snaky 的六个格点；表项索引为 $6,\\dots,615$。',
      en: 'Cells lie in $\\mathbb{Z}^2$ and $o = (0,0)$. A row $(A,H,h)$ contains its required cells, envelope and recursive height. Six base rows come from the six cells of Snaky; table entries have indices $6,\\dots,615$.',
    },
    steps: [
      {
        id: 'validate-the-recursion-table',
        title: { zh: '证明每次引用都指向更早的行', en: 'Verify that every reference points to an earlier row' },
        given: { zh: '固定表 table 含按索引排列的 Entry，每项带一个非空的放置列表。', en: 'The fixed table consists of indexed entries, each containing a list of placements.' },
        claim: {
          zh: '$\\mathrm{table.size} = 610$；第 $k$ 项索引为 $k+6$，放置列表非空，而且每个 $\\mathrm{child} < k+6$。',
          en: '$\\mathrm{table.size} = 610$; entry $k$ has index $k+6$, its placement list is nonempty, and every child index is $< k+6$.',
        },
        because: {
          zh: 'table_valid_probe 对有限表逐项执行 decide +kernel，证明定义 TableValid 的三个索引条件。严格递减的 child 索引使后续重建可按行号良基递归。',
          en: 'table_valid_probe checks the finite table with decide +kernel and proves the clauses of TableValid. Strictly decreasing child indices support reconstruction by well-founded recursion on row number.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("$6+\\mathrm{table.size}=6+610=616$。", "$6+\\mathrm{table.size}=6+610=616$."),
            reason: text("前六行是基础图形，其后 $610$ 项依次编号 $6,\\dots,615$；第 $k$ 个表项的声明索引必须等于 $k+6$。", "The first six rows are base shapes. The next $610$ entries are indexed $6,\\dots,615$, and entry $k$ must declare index $k+6$."),
          },
          {
            statement: text("每个 terms 非空，且每个 $t\\in\\mathrm{terms}$ 满足 $t.\\mathrm{child}<k+6$。", "Each terms list is nonempty, with $t.\\mathrm{child}<k+6$ for every term $t$."),
            reason: text("table_valid_probe 在具体有限列表上核对这两个条件；因此 rowAt 引用 child 时总能进入更小的行号。", "table_valid_probe checks both conditions on the concrete lists, so every rowAt child reference moves to a smaller index."),
          },
          {
            statement: text("行 $0,\\dots,5$ 已给定 $\\Rightarrow$ 行 $6,\\dots,615$ 可依次求值。", "Given rows $0,\\dots,5$, rows $6,\\dots,615$ can be evaluated in order."),
            reason: text("例如 $\\mathrm{entry}_6$ 只引用 child $0$，$\\mathrm{entry}_7$ 只引用 child $4$、$6$；没有当前行或未来行参与自己的定义。", "For example $\\mathrm{entry}_6$ refers only to child $0$, and $\\mathrm{entry}_7$ to children $4$ and $6$. No row refers to itself or a later row."),
          },
        ],
        next: { zh: '可以从六个基础局面开始，依次重建所有后继行。', en: 'Reconstruct every later row from the six base rows.' },
        evidence: {
          theorems: ['OAI.SnakyCertificate.table_valid_probe'],
          taskIds: ['initial_goal_1'], checkIds: ['check-b900b20d4968e7ec561d'],
          source: { name: 'Submission.lean', line: 9463, endLine: 9473 },
        },
      },
      {
        id: 'reconstruct-the-fork',
        figure: 'snaky',
        title: { zh: '用旋转、平移与分叉重建行', en: 'Reconstruct rows by placement and forking' },
        given: { zh: '各 child 行已经确定；一个 Term 指定 child、八种方向之一和整数平移。', en: 'Child rows are already known; each term specifies a child, one of eight orientations and an integer translation.' },
        claim: {
          zh: '先对各 child 的 $A$、$H$ 同时作放置，再令新 $A = (\\bigcup A_i \\cup \\bigcap H_i) \\setminus \\{o\\}$，新 $H = \\{o\\} \\cup \\bigcup H_i$，新 $h = 1 + \\max h_i$。',
          en: 'Place each child’s $A$ and $H$, then set $A = (\\bigcup A_i \\cup \\bigcap H_i) \\setminus \\{o\\}$, $H = \\{o\\} \\cup \\bigcup H_i$ and $h = 1 + \\max h_i$.',
        },
        because: {
          zh: '这正是 placeRow、commonH、forkRow 与 rowAt 的定义。先从原六格图形写出基础行 $0$，再把 $\\mathrm{entry}_6$ 的四个字段逐一代入：其 child 是行 $0$、方向为恒等、平移为 $(-4,-1)$，所以能直接列出新 $A$、$H$ 与高度 $2$。me_6 核对这个具体结果，me_615 等后续重建等式再按相同方式使用更早的 child 等式。',
          en: 'These are the definitions of placeRow, commonH, forkRow and rowAt. Start with base row $0$ of the six-cell shape, then substitute the four fields of $\\mathrm{entry}_6$: child $0$, identity orientation and translation $(-4,-1)$. This gives explicit new sets $A$ and $H$ and height $2$. The equality me_6 verifies this result; later reconstructions such as me_615 use earlier child equalities in the same way.',
        },
        dependsOn: ["validate-the-recursion-table"],
        derivation: [
          {
            statement: text("$S=\\{(0,0),(1,0),(2,0),(3,0),(3,1),(4,1)\\}$；$H_0=S$，$A_0=S\\setminus\\{o\\}$，$h_0=1$。", "$S=\\{(0,0),(1,0),(2,0),(3,0),(3,1),(4,1)\\}$; $H_0=S$, $A_0=S\\setminus\\{o\\}$, $h_0=1$."),
            reason: text("原 Snaky 由 $y=0$ 上的四格和 $y=1$ 上向右错开的两格组成。第 $i$ 个基础行把第 $i$ 格平移到 $o$，再从所需集删去 $o$；第 $0$ 格本来就是 $o$，因此行 $0$ 无须平移。", "The original Snaky has four cells on $y=0$ and two cells shifted to the right on $y=1$. Base row $i$ translates its $i$th cell to $o$ and removes $o$ from its required set. Cell $0$ already equals $o$, so row $0$ needs no translation."),
          },
          {
            statement: text("$\\mathrm{Term.shift}=(\\mathrm{xDigit}-4,\\mathrm{yDigit}-4)$，$P(p)=\\mathrm{orient}(\\mathrm{rotation},p)+\\mathrm{shift}$。", "$\\mathrm{Term.shift}=(\\mathrm{xDigit}-4,\\mathrm{yDigit}-4)$, with $P(p)=\\mathrm{orient}(\\mathrm{rotation},p)+\\mathrm{shift}$."),
            reason: text("数字字段先解码成整数平移，再用同一个格点放置 $P$ 作用于 child 的 $A$ 和 $H$；高度保持不变。", "Decode the digit fields as an integer translation, then apply the same placement $P$ to both child sets $A$ and $H$; preserve the height."),
          },
          {
            statement: text("$\\mathrm{entry}_6=\\langle 6,[\\langle 0,0,0,3\\rangle]\\rangle \\Rightarrow \\mathrm{child}=0$，$\\mathrm{rotation}=0$，$\\mathrm{shift}=(0-4,3-4)=(-4,-1)$。", "$\\mathrm{entry}_6=\\langle 6,[\\langle 0,0,0,3\\rangle]\\rangle$ gives $\\mathrm{child}=0$, $\\mathrm{rotation}=0$ and $\\mathrm{shift}=(0-4,3-4)=(-4,-1)$."),
            reason: text("这是第一条递归表项的实际字段。方向 $0$ 不改变坐标，所以本例的放置就是 $P(x,y)=(x-4,y-1)$，可直接作用于已知的基础行 $0$。", "These are the actual fields of the first recursive entry. Orientation $0$ is the identity, so its placement is $P(x,y)=(x-4,y-1)$, applied directly to base row $0$."),
          },
          {
            statement: text("放置后 $H'=\\{(-4,-1),(-3,-1),(-2,-1),(-1,-1),(-1,0),(0,0)\\}$，$A'=H'\\setminus\\{(-4,-1)\\}$，$h'=1$。", "After placement, $H'=\\{(-4,-1),(-3,-1),(-2,-1),(-1,-1),(-1,0),(0,0)\\}$, $A'=H'\\setminus\\{(-4,-1)\\}$, and $h'=1$."),
            reason: text("对 $S$ 的六个坐标分别减去 $(4,1)$，得到完整包络。基础行缺少的所需格是 $o$，平移后缺少的就是 $P(o)=(-4,-1)$；放置本身保持高度。", "Subtract $(4,1)$ from each of the six coordinates of $S$ to obtain the envelope. The cell omitted from the base required set was $o$, so the translated omission is $P(o)=(-4,-1)$. Placement preserves height."),
          },
          {
            statement: text("$A=(\\bigcup_i A_i\\cup\\bigcap_i H_i)\\setminus\\{o\\}$，$H=\\{o\\}\\cup\\bigcup_i H_i$。", "$A=(\\bigcup_i A_i\\cup\\bigcap_i H_i)\\setminus\\{o\\}$, while $H=\\{o\\}\\cup\\bigcup_i H_i$."),
            reason: text("forkRow 把各 child 的所需点以及共同包络点并入 $A$，再删去本轮落点 $o$；$H$ 则保留所有 child 包络和 $o$。", "forkRow combines child requirements with common-envelope cells, then removes the current move $o$ from $A$. Its envelope retains all child envelopes and $o$."),
          },
          {
            statement: text("本例只有一个 child，因此 $A_6=(A'\\cup H')\\setminus\\{o\\}=H'\\setminus\\{o\\}=\\{(-4,-1),(-3,-1),(-2,-1),(-1,-1),(-1,0)\\}$，$H_6=H'$。", "With one child, $A_6=(A'\\cup H')\\setminus\\{o\\}=H'\\setminus\\{o\\}=\\{(-4,-1),(-3,-1),(-2,-1),(-1,-1),(-1,0)\\}$, and $H_6=H'$."),
            reason: text("单个包络的交与并都等于 $H'$，而 $A'\\subseteq H'$，所以所需集先补全 $H'$，再删去父行落点 $o$。又因 $o$ 已在 $H'$ 中，插入 $o$ 不改变包络。", "The intersection and union of a single envelope both equal $H'$, and $A'\\subseteq H'$. Thus the required set first fills $H'$ and then removes the parent move $o$. Since $o$ already belongs to $H'$, inserting it leaves the envelope unchanged."),
          },
          {
            statement: text("$h_6=1+h'=2$；一般地 $h=1+\\max_i h_i$，child 等式代入后得到 $\\mathrm{rowAt}(i)=\\mathrm{mr}_i$。", "Here $h_6=1+h'=2$. In general $h=1+\\max_i h_i$, and substituting child equalities gives $\\mathrm{rowAt}(i)=\\mathrm{mr}_i$."),
            reason: text("先预留父行的一步，再取最深 child；本例的唯一 child 高度为 $1$。me_6 确认上面的两个有限集与高度，后续 $\\mathrm{me}_i$ 也把递归公式化成可逐点核验的数据。", "Reserve one move for the parent, then take the deepest child; this sole child has height $1$. The equality me_6 confirms both displayed sets and the height. Later $\\mathrm{me}_i$ equalities likewise turn the recursion into data that can be checked point by point."),
          },
        ],
        next: { zh: '行 $6$ 只有一个 child。下一步用实际表项 $\\mathrm{entry}_7$ 对照两个 child 的并集、交集和父行。', en: 'Row $6$ has one child. Next, use the actual $\\mathrm{entry}_7$ to compare two children, their unions and intersection, and the parent row.' },
        evidence: {
          theorems: ['OAI.SnakyCertificate.snaky', 'OAI.SnakyCertificate.entry_6', 'OAI.SnakyCertificate.forkRow', 'OAI.SnakyCertificate.me_6', 'OAI.SnakyCertificate.me_615'],
          taskIds: ['initial_goal_1'], checkIds: ['check-b900b20d4968e7ec561d'],
          source: { name: 'Submission.lean', line: 1532, endLine: 1542 },
        },
      },
      {
        id: 'reconstruct-two-children',
        figure: 'snaky-fork',
        title: { zh: '把两个已放置的子行合成父行 7', en: 'Combine two placed children into parent row 7' },
        given: { zh: '行 $4$ 是第 $5$ 个基础行，行 $6$ 已在上一步重建。$\\mathrm{entry}_7$ 的两项分别引用它们，方向均为 $0$。', en: 'Row $4$ is the fifth base row, and row $6$ was reconstructed above. The two terms of $\\mathrm{entry}_7$ refer to them with orientation zero.' },
        claim: { zh: '两个所需集先并成 $6$ 格，共同包络的 $4$ 格已在其中；删去 $o$ 后，$A_7$ 是 $y=-1$ 上的连续五格，$H_7$ 有 $8$ 格，$h_7=3$。', en: 'The required sets unite into six cells, already containing the four common-envelope cells. Removing $o$ leaves five consecutive cells on $y=-1$ in $A_7$; $H_7$ has eight cells and $h_7=3$.' },
        because: { zh: '把 $\\mathrm{entry}_7$ 的数字解码为平移 $(-1,0)$ 与 $(1,0)$，分别作用于基础行 $4$ 和上一步的行 $6$。列出两组有限集后，逐点取并集 $U$ 与共同包络 $C$，得到 $C\\subseteq U$，因此 forkRow 的所需集只需从 $U$ 删除 $o$。包络取两个 $H$ 的并集，高度由较深的 child $6$ 再加一步。me_7 用 me_4、me_6 重写后，核对的正是这些集合与高度。', en: 'Decode the digits of $\\mathrm{entry}_7$ as translations $(-1,0)$ and $(1,0)$, applied to base row $4$ and the preceding row $6$. Taking unions and intersections cell by cell gives the required union $U$ and common envelope $C$ with $C\\subseteq U$, so forkRow only removes $o$ from $U$. Unite the two envelopes and add one to the deeper child’s height. After rewriting with me_4 and me_6, me_7 checks these exact sets and height.' },
        dependsOn: ['reconstruct-the-fork'],
        derivation: [
          { statement: text('$\\mathrm{entry}_7=\\langle 7,[\\langle 4,0,3,4\\rangle,\\langle 6,0,5,4\\rangle]\\rangle \\Rightarrow P_4(x,y)=(x-1,y)$，$P_6(x,y)=(x+1,y)$。', '$\\mathrm{entry}_7=\\langle 7,[\\langle 4,0,3,4\\rangle,\\langle 6,0,5,4\\rangle]\\rangle$ gives $P_4(x,y)=(x-1,y)$ and $P_6(x,y)=(x+1,y)$.'), reason: text('每个数字字段减 $4$，得到 $(3-4,4-4)$ 与 $(5-4,4-4)$；方向 $0$ 保持坐标不变。两个 child 索引 $4$、$6$ 都严格小于 $7$。', 'Subtract four from each digit pair to obtain $(3-4,4-4)$ and $(5-4,4-4)$. Orientation zero preserves coordinates. Both child indices, $4$ and $6$, are below $7$.') },
          { statement: text('$A_4\'=\\{(-4,-1),(-3,-1),(-2,-1),(-1,-1),o\\}$，$H_4\'=A_4\'\\cup\\{(-1,0)\\}$，$h_4\'=1$。', '$A_4\'=\\{(-4,-1),(-3,-1),(-2,-1),(-1,-1),o\\}$, $H_4\'=A_4\'\\cup\\{(-1,0)\\}$, $h_4\'=1$.'), reason: text('基础行 $4$ 先把 $S$ 的格 $(3,1)$ 移到 $o$ 并从所需集删去 $o$，再按本表项向左平移一格。因此新所需集缺少 $(-1,0)$，但已经包含父行落点 $o$。', 'Base row $4$ moves cell $(3,1)$ of $S$ to $o$ and removes $o$ from its required set. The term then translates it one cell left. Its new required set omits $(-1,0)$ but already contains the parent move $o$.') },
          { statement: text('$A_6\'=\\{(-3,-1),(-2,-1),(-1,-1),(0,-1),o\\}$，$H_6\'=A_6\'\\cup\\{(1,0)\\}$，$h_6\'=2$。', '$A_6\'=\\{(-3,-1),(-2,-1),(-1,-1),(0,-1),o\\}$, $H_6\'=A_6\'\\cup\\{(1,0)\\}$, $h_6\'=2$.'), reason: text('将上一步 $A_6$、$H_6$ 的每个 $x$ 坐标加一。原来从 $A_6$ 中删去的 $o$ 移到 $(1,0)$；平移不改变已经核对的高度 $2$。', 'Add one to the $x$ coordinate of each cell of $A_6$ and $H_6$ from the preceding step. The original omitted $o$ moves to $(1,0)$, while translation preserves the verified height two.') },
          { statement: text('$U=A_4\'\\cup A_6\'=\\{(-4,-1),(-3,-1),(-2,-1),(-1,-1),(0,-1),o\\}$；$C=H_4\'\\cap H_6\'=\\{(-3,-1),(-2,-1),(-1,-1),o\\}\\subseteq U$。', '$U=A_4\'\\cup A_6\'=\\{(-4,-1),(-3,-1),(-2,-1),(-1,-1),(0,-1),o\\}$; $C=H_4\'\\cap H_6\'=\\{(-3,-1),(-2,-1),(-1,-1),o\\}\\subseteq U$.'), reason: text('按坐标分别取并集和交集：只有 $H_4\'$ 含 $(-1,0)$，只有 $H_6\'$ 含 $(1,0)$。四个共同包络点都已由至少一个 child 列入所需集，所以并入 $C$ 不会新增所需格。', 'Take the union and intersection by coordinates. Only $H_4\'$ contains $(-1,0)$, and only $H_6\'$ contains $(1,0)$. Every common-envelope cell is already required by a child, so adjoining $C$ adds no new required cell.') },
          { statement: text('$A_7=(U\\cup C)\\setminus\\{o\\}=\\{(-4,-1),(-3,-1),(-2,-1),(-1,-1),(0,-1)\\}$；$H_7=H_4\'\\cup H_6\'$，$|H_7|=8$，$h_7=1+\\max(1,2)=3$。', '$A_7=(U\\cup C)\\setminus\\{o\\}=\\{(-4,-1),(-3,-1),(-2,-1),(-1,-1),(0,-1)\\}$; $H_7=H_4\'\\cup H_6\'$, $|H_7|=8$, $h_7=1+\\max(1,2)=3$.'), reason: text('$C\\subseteq U$ 使所需集公式化为 $U\\setminus\\{o\\}$。$o$ 已在两个包络中，插入它不会扩大并集；$H_7\\setminus A_7$ 是 $\\{(-1,0),o,(1,0)\\}$ 三格，不能再当作单一缺口。', 'Since $C\\subseteq U$, the required set reduces to $U\\setminus\\{o\\}$. Both envelopes already contain $o$, so inserting it does not enlarge their union. $H_7\\setminus A_7$ consists of three cells, $\\{(-1,0),o,(1,0)\\}$, rather than a single gap.') },
          { statement: text('me_7：$\\mathrm{rowAt}\\,7=\\mathrm{mr}_7$，其中 $\\mathrm{mr}_7$ 正是上面列出的 $(A_7,H_7,3)$。', 'me_7: $\\mathrm{rowAt}\\,7=\\mathrm{mr}_7$, where $\\mathrm{mr}_7$ is exactly the displayed $(A_7,H_7,3)$.'), reason: text('源码展开 $\\mathrm{entry}_7$ 的两个放置，再以 me_4、me_6 代入 child 的显式数据，最后对有限集与高度执行内核判定。后续行也沿相同的严格递减索引复用这些等式。', 'The source unfolds the two placements of $\\mathrm{entry}_7$, substitutes explicit child data using me_4 and me_6, then checks the finite sets and height by kernel decision. Later rows reuse such equalities along the same decreasing indices.') },
        ],
        next: { zh: '单 child 与双 child 的重建都化成了明确数据；接下来按同样方式对全部 $616$ 行核对集合关系和高度。', en: 'Both the one-child and two-child reconstructions now give explicit data. Check set relations and heights in the same way for all $616$ rows.' },
        evidence: { theorems: ['OAI.SnakyCertificate.entry_7', 'OAI.SnakyCertificate.mr_7', 'OAI.SnakyCertificate.me_7'], taskIds: ['initial_goal_1'], checkIds: ['check-b900b20d4968e7ec561d'], source: { name: 'Submission.lean', line: 1543, endLine: 1553 } },
      },
      {
        id: 'verify-all-row-invariants',
        title: { zh: '对全部 616 行核验包络与深度', en: 'Check envelopes and depth for all 616 rows' },
        given: { zh: '每个 $\\mathrm{rowAt}\\,i$ 已有对应的显式重建行 $\\mathrm{mr}_i$，$0 \\le i < 616$。', en: 'Each $\\mathrm{rowAt}\\,i$ has an explicit reconstructed row $\\mathrm{mr}_i$, for $0 \\le i < 616$.' },
        claim: {
          zh: '每行均满足 $A_i \\subseteq H_i$、$o \\in H_i$、$o \\notin A_i$ 和 $h_i \\le 34$。',
          en: 'Every row satisfies $A_i \\subseteq H_i$, $o \\in H_i$, $o \\notin A_i$ and $h_i \\le 34$.',
        },
        because: {
          zh: '$\\mathrm{mv}_i$ 对各显式有限集证明这四项条件；memo_allRows 对 $i$ 做 interval_cases，先用 $\\mathrm{me}_i$ 重写，再引用相应 $\\mathrm{mv}_i$，将四项条件推广到表中全部行。',
          en: 'Each $\\mathrm{mv}_i$ proves the four conditions for its explicit finite sets. memo_allRows splits every possible $i$ with interval_cases, rewrites using $\\mathrm{me}_i$ and applies $\\mathrm{mv}_i$, covering all rows.',
        },
        dependsOn: ["reconstruct-the-fork", "reconstruct-two-children"],
        derivation: [
          {
            statement: text("$A_i\\subseteq H_i$：对显式 $\\mathrm{mr}_i$ 的每个所需点检查包络成员关系。", "$A_i\\subseteq H_i$: check envelope membership for every required cell of explicit $\\mathrm{mr}_i$."),
            reason: text("各 $\\mathrm{mv}_i$ 对重建有限集直接判定包含关系；$\\mathrm{me}_i$ 再把这一结论传回递归定义的 $\\mathrm{rowAt}\\,i$。", "Each $\\mathrm{mv}_i$ decides containment on the reconstructed finite sets, and $\\mathrm{me}_i$ transfers the result back to $\\mathrm{rowAt}\\,i$."),
          },
          {
            statement: text("$o\\in H_i$，$o\\notin A_i$，$h_i\\le 34$。", "$o\\in H_i$, $o\\notin A_i$ and $h_i\\le 34$."),
            reason: text("前两项分别检查中心落点位于包络、未预先列入所需点；高度界检查的是同一行记录中的整数高度。", "The first two checks place the current move in the envelope and outside the prior requirements; the height bound checks the integer stored in that same row."),
          },
          {
            statement: text("$\\forall i<616$，上述四项同时成立。", "All four properties hold for every $i<616$."),
            reason: text("memo_allRows 穷尽 $0,\\dots,615$，分别重写为 $\\mathrm{mr}_i$ 并调用 $\\mathrm{mv}_i$，因此这里覆盖六个基础行及全部 $610$ 个表项。", "memo_allRows enumerates $0,\\dots,615$, rewrites to $\\mathrm{mr}_i$ and applies $\\mathrm{mv}_i$. It therefore covers all six base rows and all $610$ table entries."),
          },
        ],
        next: { zh: '再核验目标中特别指定的四行的精确大小、所需点和避让区域。', en: 'Check the exact sizes, required cells and omitted regions of the four distinguished rows.' },
        evidence: {
          theorems: ['OAI.SnakyCertificate.memo_allRows', 'OAI.SnakyCertificate.mv_615'],
          taskIds: ['initial_goal_1'], checkIds: ['check-b900b20d4968e7ec561d'],
          source: { name: 'Submission.lean', line: 11319, endLine: 11340 },
        },
      },
      {
        id: 'check-the-distinguished-rows',
        title: { zh: '读出四个关键局面的精确几何结论', en: 'Read off the four exact geometric outputs' },
        given: { zh: '$\\mathrm{Output}\\,i\\,p\\,s\\,h\\,E$ 表示 $A_i = \\{p\\}$、$|H_i| = s$、高度 $h$，且 $H_i$ 与 $E$ 不相交。', en: '$\\mathrm{Output}\\,i\\,p\\,s\\,h\\,E$ states $A_i = \\{p\\}$, $|H_i| = s$, height $h$, and disjointness of $H_i$ from $E$.' },
        claim: {
          zh: '行 $557$、$595$、$603$ 的所需点均为 $(-1,0)$，(大小, 高度) 分别为 $(118,19)$、$(222,27)$、$(275,27)$；行 $615$ 为 $A = \\{(1,0)\\}$、$|H| = 686$、高度 $34$，且 $(1,-1) \\notin H$。前三行还分别避开目标所列的三个半平面交集或射线。',
          en: 'Rows $557$, $595$ and $603$ require $(-1,0)$, with $(\\mathrm{size},\\mathrm{height}) = (118,19)$, $(222,27)$, $(275,27)$. Row $615$ has $A = \\{(1,0)\\}$, $|H| = 686$, height $34$ and $(1,-1) \\notin H$. The first three rows also avoid the three specified regions.',
        },
        because: {
          zh: '最终证明用 me_557、me_595、me_603、me_615 重写 Output。单点集、基数和高度由有限判定证明；避让条件由 mo_557、mo_595、mo_603、mo_615 转成集合不相交。',
          en: 'The final proof rewrites Output with me_557, me_595, me_603 and me_615. Finite decision proofs establish the singleton, cardinality and height clauses; mo_557, mo_595, mo_603 and mo_615 establish disjointness.',
        },
        dependsOn: ["reconstruct-the-fork"],
        derivation: [
          {
            statement: text("$557:(A,|H|,h)=(\\{(-1,0)\\},118,19)$；$595:(\\{(-1,0)\\},222,27)$。", "$557:(A,|H|,h)=(\\{(-1,0)\\},118,19)$; $595:(\\{(-1,0)\\},222,27)$."),
            reason: text("将两行的 me 等式代入 Output 后，分别核对所需点、有限集基数和高度；避让区域分别为 $x\\le -3$ 且 $y\\le -2$，以及 $x=-2$ 且 $y\\le -2$。", "After rewriting Output with the two me equalities, check the required point, cardinality and height. The omitted regions are $x\\le -3$ with $y\\le -2$, and $x=-2$ with $y\\le -2$, respectively."),
          },
          {
            statement: text("$603:(A,|H|,h)=(\\{(-1,0)\\},275,27)$，且 $H\\cap\\{x\\le -3,y=0\\}=\\emptyset$。", "$603:(A,|H|,h)=(\\{(-1,0)\\},275,27)$, with $H\\cap\\{x\\le -3,y=0\\}=\\emptyset$."),
            reason: text("前面三个数值由显式集合判定；mo_603 对包络中的每一点排除所列射线，形成 Output 的第四项。", "The explicit set decides the three values. mo_603 excludes the specified ray for every envelope cell, supplying the fourth Output clause."),
          },
          {
            statement: text("$615:(A,|H|,h)=(\\{(1,0)\\},686,34)$，且 $(1,-1)\\notin H$。", "$615:(A,|H|,h)=(\\{(1,0)\\},686,34)$, and $(1,-1)\\notin H$."),
            reason: text("目标中最后一个遗漏集只有一个点；集合不相交因此化为 mo_615 证明的这个单点非成员关系。", "The final omitted set is a singleton, so disjointness reduces to the exact nonmembership statement established by mo_615."),
          },
        ],
        next: { zh: '连同总放置项数，将全部核验结果合成目标合取式。', en: 'Combine these outputs with the placement count and all-row invariants.' },
        evidence: {
          theorems: ['OAI.SnakyCertificate.certificate_correct', 'OAI.SnakyCertificate.mo_615'],
          taskIds: ['initial_goal_1'], checkIds: ['check-b900b20d4968e7ec561d'],
          source: { name: 'Submission.lean', line: 12570, endLine: 12591 },
        },
      },
      {
        id: 'assemble-the-certificate',
        title: { zh: '得到有限证书的完整核验定理', en: 'Assemble the complete certificate theorem' },
        given: { zh: '表项有效、四个 Output 已证，AllRows 覆盖全部 $616$ 行。', en: 'The table is valid, the four Output statements hold, and AllRows covers all $616$ rows.' },
        claim: { zh: '$\\mathrm{placementCount} = 1837$，且 certificate_correct 的全部七个合取项同时成立。', en: '$\\mathrm{placementCount} = 1837$ and all seven conjuncts of certificate_correct hold together.' },
        because: {
          zh: 'placementCount 是固定表中各 terms 长度之和，最终 proof 的 decide +kernel 计算并证明该和；refine 将它与 table_valid_probe、四个几何结论和 memo_allRows 组装。',
          en: 'placementCount sums the lengths of the fixed entries’ term lists. decide +kernel proves that sum; refine combines it with table_valid_probe, the four geometric outputs and memo_allRows.',
        },
        dependsOn: ["validate-the-recursion-table", "verify-all-row-invariants", "check-the-distinguished-rows"],
        derivation: [
          {
            statement: text("$\\mathrm{placementCount}=\\sum_{k<610}\\mathrm{length}(\\mathrm{table}[k].\\mathrm{terms})=1837$。", "$\\mathrm{placementCount}=\\sum_{k<610}\\mathrm{length}(\\mathrm{table}[k].\\mathrm{terms})=1837$."),
            reason: text("计数对象是放置项，不是不同格点或不同 child；同一 child 出现于两个放置时按两项计数。", "The count is of placement terms, not distinct cells or child indices. Two placements of the same child count separately."),
          },
          {
            statement: text("$\\mathrm{TableValid} \\land \\mathrm{count}=1837 \\land \\mathrm{Output}_{557} \\land \\mathrm{Output}_{595} \\land \\mathrm{Output}_{603} \\land \\mathrm{Output}_{615} \\land \\mathrm{AllRows}$。", "$\\mathrm{TableValid} \\land \\mathrm{count}=1837 \\land \\mathrm{Output}_{557} \\land \\mathrm{Output}_{595} \\land \\mathrm{Output}_{603} \\land \\mathrm{Output}_{615} \\land \\mathrm{AllRows}$."),
            reason: text("把前面三条支路给出的索引有效性、四个几何输出和全部行不变量，与这次数值求和一起填入目标的七个位置。", "Fill the seven target clauses with index validity, the four geometric outputs, all-row invariants and the evaluated placement count."),
          },
          {
            statement: text("certificate_correct 核验的是固定表和几何递归。", "certificate_correct verifies the fixed table and its geometric recursion."),
            reason: text("这里尚未量化 Breaker 的回复，也未构造 Policy；下一道策略题才用 Threat 和 Winning 为这些已核对的行赋予博弈含义。", "This target does not quantify Breaker replies or construct a Policy. The strategy theorem supplies that interpretation through Threat and Winning."),
          },
        ],
        next: {
          zh: '所得结论是证书数据与几何递归的正确性；把这些行解释为对任意合法对手的必胜策略，还需要策略题中的语义定理。',
          en: 'The result verifies certificate data and geometric recursion. Interpreting these rows as a strategy against every legal opponent requires the semantic argument in the strategy theorem.',
        },
        evidence: {
          theorems: ['OAI.SnakyCertificate.certificate_correct'],
          taskIds: ['initial_goal_1'], deliveryIds: ['a0ec7027-aa14-418d-978b-1391c4fb5c31'], checkIds: ['check-b900b20d4968e7ec561d'],
          source: { name: 'Submission.lean', line: 12570, endLine: 12583 },
        },
      },
    ],
  },
  {
    recordId: 'openai_totient_companion_zero',
    runId: '41f80030-d1b0-4b66-acb6-3f0ddc1f26de',
    proofSha256: '7d3509714928edd3f6b6a634c42d9dbeefd01c17a65d0e152fc09d97e6568a20',
    title: { zh: '没有种子时，计数与权重都逐项归零', en: 'Without a seed, both counts and weights vanish term by term' },
    strategy: text('把不存在种子的假设改写为每个 totient 值的最小原像满足 $\\ell(d)\\le kd$。这个上界一方面与计数所需的严格不等式冲突，另一方面使两个截断商都等于 $1$，因此计数与极限权重分别归零。', 'Rewrite the no-seed hypothesis as $\\ell(d)\\le kd$ for every totient value. This bound contradicts the strict counting condition and makes both truncated quotients equal one, so the count and the limiting weighted quantity vanish in separate branches.'),
    stages: [{
      title: text('取得共同原像上界', 'Obtain the common preimage bound'),
      summary: text('由种子不存在推出 $\\ell(d)\\le kd$，并确认 $d$ 与 $\\ell(d)$ 都为正，为计数比较和后续除法提供条件。', 'Derive $\\ell(d)\\le kd$ from absence of a seed and prove positivity of $d$ and $\\ell(d)$, supplying the conditions for the counting comparison and divisions.'),
      stepIds: ['bound-every-preimage'],
    }, {
      title: text('分别消去计数与权重', 'Eliminate counts and weights separately'),
      summary: text('计数支线得到空集 $N(k,x)=0$；权重支线得到 $0<\\ell(d)/d\\le k$，使 $f_k$ 的两个截断值相消为零。', 'The counting branch gives an empty set and $N(k,x)=0$. The weight branch gives $0<\\ell(d)/d\\le k$, making the two truncated terms in $f_k$ cancel.'),
      stepIds: ['empty-the-counting-set', 'cancel-the-weight'],
    }, {
      title: text('把逐项为零传到极限', 'Pass termwise zero to the limit'),
      summary: text('零权重使每个有限阶段 $\\mathrm{AH}$ 都为零，恒零序列的 limUnder 也为零；与独立的计数结论合并完成原题。', 'Zero weights make every finite-stage $\\mathrm{AH}$ vanish, so its constant-zero sequence has limUnder zero. Combine this with the separate counting result to finish.'),
      stepIds: ['take-the-zero-limit'],
    }],
    goal: {
      zh: '给定正整数 $k$，假设不存在 Euler $\\varphi$ 的正整数像 $d$ 满足 $kd < \\ell(d)$，证明所有 $x > 0$ 都有 $N(k,x) = 0$，且 $0 \\le s < 1$ 时 $A(f_k,s) = 0$。',
      en: 'For a positive integer $k$, assume no totient value $d$ has $kd < \\ell(d)$. Prove $N(k,x) = 0$ for every $x > 0$ and $A(f_k,s) = 0$ for $0 \\le s < 1$.',
    },
    notation: {
      zh: '$\\mathrm{IsTotient}\\,d$ 指 $d = \\varphi(n)$，$n > 0$；$\\ell(d)$ 是这样的最小 $n$。$N(k,x)$ 计数 $1 \\le d \\le \\lfloor x\\rfloor$ 且 $kx < \\ell(d) \\le (k+1)x$ 的 totient 值。$f_k(r) = \\min(1,(k+1)/r) - \\min(1,k/r)$。',
      en: '$\\mathrm{IsTotient}\\,d$ means $d = \\varphi(n)$ for $n > 0$; $\\ell(d)$ is the least such $n$. $N(k,x)$ counts totient values with $1 \\le d \\le \\lfloor x\\rfloor$ and $kx < \\ell(d) \\le (k+1)x$. $f_k(r) = \\min(1,(k+1)/r) - \\min(1,k/r)$.',
    },
    steps: [
      {
        id: 'bound-every-preimage',
        title: { zh: '把不存在种子改写成逐点上界', en: 'Turn absence of a seed into a pointwise bound' },
        given: { zh: '不存在 $d$ 使 $\\mathrm{IsTotient}\\,d$ 且 $kd < \\ell(d)$。', en: 'There is no $d$ with $\\mathrm{IsTotient}\\,d$ and $kd < \\ell(d)$.' },
        claim: { zh: '对每个 totient 值 $d$，$0 < \\ell(d)$、$0 < d$，且 $\\ell(d) \\le kd$。', en: 'For every totient value $d$, both $\\ell(d)$ and $d$ are positive, and $\\ell(d) \\le kd$.' },
        because: {
          zh: '若 $\\ell(d) > kd$，$d$ 本身就是被排除的种子。$\\ell(d)$ 的正性来自 Nat.find 选出的正整数原像；$d$ 的正性来自 $n > 0$ 时 $\\varphi(n) > 0$。',
          en: 'A value with $\\ell(d) > kd$ would itself be the excluded seed. Positivity of $\\ell(d)$ follows from its chosen positive preimage; positivity of $d$ follows from $\\varphi(n) > 0$ for $n > 0$.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("$\\mathrm{IsTotient}(d) \\Rightarrow \\neg(kd<\\ell(d)) \\Rightarrow \\ell(d)\\le kd$。", "$\\mathrm{IsTotient}(d)$ implies $\\neg(kd<\\ell(d))$, hence $\\ell(d)\\le kd$."),
            reason: text("如果严格反向不等式成立，取该 $d$ 就构成 hno 所排除的存在见证；自然数全序于是给出非严格上界。", "A strict reverse inequality would make this $d$ a witness forbidden by hno. Total order on $\\mathbb{N}$ gives the non-strict bound."),
          },
          {
            statement: text("$\\ell(d)=\\mathrm{Nat.find}(hd)>0$。", "$\\ell(d)=\\mathrm{Nat.find}(hd)>0$."),
            reason: text("$hd$ 提供一个正整数原像；Nat.find 的见证仍满足正性，所以最小原像不会是 $0$。", "The witness supplied by $hd$ is a positive preimage, and Nat.find preserves this property; the least preimage cannot be zero."),
          },
          {
            statement: text("$d=\\varphi(n)$，$n>0 \\Rightarrow d>0$。", "$d=\\varphi(n)$ with $n>0$ implies $d>0$."),
            reason: text("由 Nat.totient_pos 取出 $d$ 的正性；后面两次除法分别需要 $\\ell(d)>0$ 和 $d>0$。", "Nat.totient_pos supplies positivity of $d$. The divisions below use the separate positivity facts for $\\ell(d)$ and $d$."),
          },
        ],
        next: { zh: '同一个上界分别排除计数集合中的元素，并使权重的两项相等。', en: 'Use the same bound to empty the counting set and to equalize the two terms of the weight.' },
        evidence: {
          theorems: ['OAI.TotientAsymptotic.companion_zero_case'],
          taskIds: ['initial_goal_1'], checkIds: ['check-3e6964827d75e9dcbe53'],
          source: { name: 'Submission.lean', line: 95, endLine: 106 },
        },
      },
      {
        id: 'empty-the-counting-set',
        title: { zh: '计数条件中的严格不等式不可能成立', en: 'The strict counting inequality is impossible' },
        given: { zh: '$x > 0$；若 $d$ 被 $N(k,x)$ 计数，则 $d \\le \\lfloor x\\rfloor \\le x$ 且 $kx < \\ell(d)$。', en: 'Let $x > 0$. A value counted by $N(k,x)$ satisfies $d \\le \\lfloor x\\rfloor \\le x$ and $kx < \\ell(d)$.' },
        claim: { zh: '$\\ell(d) \\le kd \\le kx$ 与 $kx < \\ell(d)$ 矛盾，所以过滤后的有限集为空，$N(k,x) = 0$。', en: 'The inequalities $\\ell(d) \\le kd \\le kx$ contradict $kx < \\ell(d)$, so the filtered finite set is empty and $N(k,x) = 0$.' },
        because: {
          zh: '$k \\ge 0$，因此把 $d \\le x$ 乘以 $k$ 保持不等号；hbound 给出前一个不等式。证明用 filter_eq_empty_iff 排除每个候选 $d$，然后将空集基数化为 $0$。',
          en: 'Multiplication by $k \\ge 0$ preserves $d \\le x$, while hbound supplies the first inequality. filter_eq_empty_iff excludes each candidate $d$, and the empty set has cardinality zero.',
        },
        dependsOn: ["bound-every-preimage"],
        derivation: [
          {
            statement: text("$d$ 被计数 $\\Rightarrow d\\le\\lfloor x\\rfloor_+\\le x$。", "If $d$ is counted, then $d\\le\\lfloor x\\rfloor_+\\le x$."),
            reason: text("第一项来自候选区间 Icc 的右端点；第二项使用 $x>0$ 时自然数下取整不超过 $x$。", "The first inequality comes from the candidate interval Icc; the second is the natural-floor bound for $x>0$."),
          },
          {
            statement: text("$\\ell(d)\\le kd\\le kx$。", "$\\ell(d)\\le kd\\le kx$."),
            reason: text("种子不存在给出第一步；因为 $k\\ge 0$，把 $d\\le x$ 乘以 $k$ 保持不等号方向。", "Absence of a seed gives the first bound. Since $k\\ge 0$, multiplying $d\\le x$ by $k$ preserves the inequality."),
          },
          {
            statement: text("$kx<\\ell(d)\\le kx$ 不可能，故 $N(k,x)=|\\emptyset|=0$。", "$kx<\\ell(d)\\le kx$ is impossible, so $N(k,x)=|\\emptyset|=0$."),
            reason: text("严格下界恰是过滤条件的另一项；每个候选 $d$ 都被排除后，取空有限集的基数。", "The strict lower bound is another filter condition. Excluding every candidate leaves the empty finite set, whose cardinality is zero."),
          },
        ],
        next: { zh: '另一半结论需要证明定义 $A$ 的每个权重本来就是零。', en: 'For the second conclusion, show that every weight in the definition of $A$ already vanishes.' },
        evidence: {
          theorems: ['OAI.TotientAsymptotic.companion_zero_case'],
          taskIds: ['initial_goal_1'], checkIds: ['check-3e6964827d75e9dcbe53'],
          source: { name: 'Submission.lean', line: 123, endLine: 136 },
        },
      },
      {
        id: 'cancel-the-weight',
        title: { zh: '两个截断商都等于 1', en: 'Both truncated quotients equal one' },
        given: { zh: '$d$ 是 totient 值；令 $r = \\ell(d)/d$，上界和正性给出 $0 < r \\le k$。', en: 'For a totient value $d$, set $r = \\ell(d)/d$. The bounds give $0 < r \\le k$.' },
        claim: { zh: '$k/r \\ge 1$ 且 $(k+1)/r \\ge 1$，故 $f_k(r) = 1 - 1 = 0$。', en: 'Then $k/r \\ge 1$ and $(k+1)/r \\ge 1$, so $f_k(r) = 1 - 1 = 0$.' },
        because: {
          zh: '$d > 0$ 允许把 $\\ell(d) \\le kd$ 除以 $d$；$r > 0$ 允许用 one_le_div 改写两个商的不等式。min_eq_left 随即把两个 $\\min$ 都改写为 $1$。',
          en: 'Since $d > 0$, divide $\\ell(d) \\le kd$ by $d$; since $r > 0$, one_le_div gives the two quotient inequalities. min_eq_left then reduces both minima to one.',
        },
        dependsOn: ["bound-every-preimage"],
        derivation: [
          {
            statement: text("$r=\\ell(d)/d>0$，且 $r\\le k$。", "$r=\\ell(d)/d>0$ and $r\\le k$."),
            reason: text("分子、分母都正；将 $\\ell(d)\\le kd$ 除以正数 $d$ 得到第二式。", "Both numerator and denominator are positive. Divide $\\ell(d)\\le kd$ by positive $d$ to obtain the second inequality."),
          },
          {
            statement: text("$r\\le k\\le k+1 \\Rightarrow k/r\\ge 1$，$(k+1)/r\\ge 1$。", "$r\\le k\\le k+1$ implies $k/r\\ge 1$ and $(k+1)/r\\ge 1$."),
            reason: text("$r>0$ 允许把两条分子下界各除以 $r$；不需要取任何极限。", "Because $r>0$, divide both numerator bounds by $r$. No limiting argument is involved."),
          },
          {
            statement: text("$f_k(r)=\\min(1,(k+1)/r)-\\min(1,k/r)=1-1=0$。", "$f_k(r)=\\min(1,(k+1)/r)-\\min(1,k/r)=1-1=0$."),
            reason: text("上一行使两个截断值都固定在 $1$，因而每个 totient 分支的权重都已精确消失。", "Both truncated values are one by the preceding inequalities, so the weight of each totient branch vanishes exactly."),
          },
        ],
        next: { zh: '$A$ 的有限阶段求和中，每个 totient 分支都含有这个零因子。', en: 'Every totient branch of the finite-stage expression for $A$ contains this zero factor.' },
        evidence: {
          theorems: ['OAI.TotientAsymptotic.companion_zero_case'],
          taskIds: ['initial_goal_1'], checkIds: ['check-3e6964827d75e9dcbe53'],
          source: { name: 'Submission.lean', line: 107, endLine: 121 },
        },
      },
      {
        id: 'take-the-zero-limit',
        title: { zh: '逐项为零的序列，其极限系数也为零', en: 'Take the limit of the identically zero sequence' },
        given: { zh: '$\\mathrm{AH}(H,f_k,s)$ 的外层求和按 $\\mathrm{IsTotient}\\,d$ 分支；$A(f_k,s)$ 定义为 $H \\to \\infty$ 时 $\\mathrm{AH}$ 的 limUnder。', en: 'The outer sum in $\\mathrm{AH}(H,f_k,s)$ branches on $\\mathrm{IsTotient}\\,d$; $A(f_k,s)$ is its limUnder as $H \\to \\infty$.' },
        claim: { zh: '对每个 $H$ 都有 $\\mathrm{AH}(H,f_k,s) = 0$，因此 $A(f_k,s) = 0$。', en: 'For every $H$, $\\mathrm{AH}(H,f_k,s) = 0$; hence $A(f_k,s) = 0$.' },
        because: {
          zh: 'totient 分支含 $f_k(\\ell(d)/d) = 0$，非 totient 分支按定义为 $0$，所以 finsum 的每一项均为零。之后只使用常零序列收敛与 Tendsto.limUnder_eq，无需分析内层见证集合或更新常数。',
          en: 'A totient branch contains $f_k(\\ell(d)/d) = 0$, and a non-totient branch is zero by definition, so every finsum term vanishes. The proof then uses convergence of the constant-zero sequence and Tendsto.limUnder_eq.',
        },
        dependsOn: ["cancel-the-weight"],
        derivation: [
          {
            statement: text("$\\mathrm{IsTotient}(d)$ 时，$f_k(\\ell(d)/d)/d\\times$内层和 $=0$。", "For $\\mathrm{IsTotient}(d)$, $f_k(\\ell(d)/d)/d$ times the inner sum is zero."),
            reason: text("直接使用上一阶段的零权重；内层见证和的值无需另行计算。", "Use the zero weight from the preceding step; the inner witness sum need not be evaluated."),
          },
          {
            statement: text("非 totient 分支按定义为 $0$，所以对每个 $H$，$\\mathrm{AH}(H,f_k,s)=0$。", "Non-totient branches are zero by definition, hence $\\mathrm{AH}(H,f_k,s)=0$ for every $H$."),
            reason: text("两种分支覆盖所有 $d$，外层 finsum 逐项为 $0$；再乘定义中的整体因子仍为 $0$。", "The two cases cover every $d$, making every outer finsum term zero; multiplying by the overall prefactor still gives zero."),
          },
          {
            statement: text("$\\mathrm{AH}(H,f_k,s)\\to 0 \\Rightarrow A(f_k,s)=\\mathrm{limUnder}\\,\\mathrm{AH}=0$。", "$\\mathrm{AH}(H,f_k,s)\\to 0$, so $A(f_k,s)=\\mathrm{limUnder}\\,\\mathrm{AH}=0$."),
            reason: text("这里是恒零序列的已知收敛，用 Tendsto.limUnder_eq 识别其 limUnder；与独立计数支路合并即得两个结论。", "This is convergence of the constant-zero sequence. Tendsto.limUnder_eq identifies its limUnder; combine with the separate counting branch for both conclusions."),
          },
        ],
        next: { zh: '与计数集合为空的结论合并，得到 companion_zero_case 的两部分。', en: 'Combine this with the empty counting set to obtain both parts of companion_zero_case.' },
        evidence: {
          theorems: ['OAI.TotientAsymptotic.companion_zero_case'],
          taskIds: ['initial_goal_1'], deliveryIds: ['1f1eb00c-6472-475d-8ef1-07dd97eac8ba'], checkIds: ['check-3e6964827d75e9dcbe53'],
          source: { name: 'Submission.lean', line: 137, endLine: 149 },
        },
      },
    ],
  },
  {
    recordId: 'openai_snaky_conditional',
    runId: 'e2b78e94-e26d-4b02-a8e5-53375547ef4d',
    proofSha256: 'dc40df160330f9058ff0af4e85adac6ed1be8be0b2d54c7fba5f10f71450eaae',
    title: { zh: '从有限威胁证书推出合法的 35 手策略', en: 'From finite threats to a legal 35-move policy' },
    strategy: text('把每行证书解释为一个威胁：所需格已归 Maker、包络未被 Breaker 占据时即可完成目标。对手一手总会留出一个未受阻的 child，这使递归表与根开局合成为 $35$ 手必胜性，再提取始终选择空格的策略。', 'Interpret each certificate row as a threat that succeeds when Maker owns its required cells and Breaker avoids its envelope. Every reply leaves some child unblocked, so the table and root opening give a $35$-move win from which an always-legal policy can be extracted.'),
    stages: [{
      title: text('赋予基础行与分叉语义', 'Interpret base rows and forks'),
      summary: text('缺一个格子的图形是一手威胁；包络交集条件保证对手回复后仍有可用 child，因此分叉也保持威胁语义。', 'A shape missing one cell is a one-move threat. The envelope-intersection condition leaves a usable child after any reply, so forks preserve threat semantics.'),
      stepIds: ['give-base-rows-a-game-meaning', 'choose-an-unblocked-branch'],
    }, {
      title: text('合成空棋盘必胜性', 'Assemble the empty-board win'),
      summary: text('按递减 child 索引解释全部 $616$ 行，再组合 escape 与 $24$ 个根分支，得到从空棋盘出发的 $35$ 手 Winning。', 'Interpret all $616$ rows using decreasing child indices, then combine escape with the $24$ root branches to obtain Winning in $35$ moves from the empty board.'),
      stepIds: ['interpret-the-whole-table', 'close-the-empty-board-opening'],
    }, {
      title: text('提取策略并核对合法性', 'Extract the policy and check legality'),
      summary: text('将 Winning 见证转成始终选空格的策略，逐手维持合法状态；第 $35$ 手完成 Snaky，并与 Breaker 已下的前 $34$ 子不交。', 'Turn Winning witnesses into a policy that always selects a free cell and maintain legal states at each move. Move $35$ completes Snaky while remaining disjoint from Breaker’s first $34$ cells.'),
      stepIds: ['extract-the-legal-policy'],
    }],
    goal: {
      zh: '构造始终选择空格的 Maker 策略 $\\sigma$；对最后一手之前所有合法的 Breaker 回复，Maker 在第 $35$ 手时包含一个旋转平移后的 Snaky，且先前各局面与落子数满足精确的合法性结论。',
      en: 'Construct a Maker policy $\\sigma$ that always chooses an unoccupied cell. Against every sequence of legal Breaker replies before the final move, Maker has a rotated and translated Snaky after move $35$, with the stated legal-state and cardinality guarantees.',
    },
    notation: {
      zh: '$M$、$B$ 分别是双方占据的有限格点集。$\\mathrm{Winning}(G,n,M,B)$ 表示 Maker 能在接下来的 $n$ 手后达到单调目标 $G$。$\\mathrm{Threat}(G,A,H,n)$ 表示：只要 $A \\subseteq M$ 且 $H \\cap B = \\emptyset$，就有 $\\mathrm{Winning}(G,n,M,B)$。',
      en: '$M$ and $B$ are the two occupied finite sets. $\\mathrm{Winning}(G,n,M,B)$ means Maker can achieve the monotone goal $G$ after $n$ further Maker moves. $\\mathrm{Threat}(G,A,H,n)$ means $A \\subseteq M$ and $H \\cap B = \\emptyset$ imply $\\mathrm{Winning}(G,n,M,B)$.',
    },
    steps: [
      {
        id: 'give-base-rows-a-game-meaning',
        title: { zh: '缺一个格子的 Snaky 是一手威胁', en: 'A Snaky missing one cell is a one-move threat' },
        given: { zh: '$S$ 本身包含一个 Snaky；Maker 已拥有 $S \\setminus \\{p\\}$，Breaker 尚未占据 $S$ 中任何格子。', en: '$S$ contains a Snaky, Maker owns $S \\setminus \\{p\\}$, and Breaker occupies no cell of $S$.' },
        claim: { zh: '$\\mathrm{Threat}(\\mathrm{HasSnaky}, S \\setminus \\{p\\}, S, 1)$ 成立，因而六个基础行都有真正的博弈含义。', en: '$\\mathrm{Threat}(\\mathrm{HasSnaky}, S \\setminus \\{p\\}, S, 1)$ holds, giving all six base rows a game-theoretic meaning.' },
        because: {
          zh: '若 $p$ 已在 $M$ 中，则 $S \\subseteq M$，目标已达成；否则 $p$ 不在 $B$ 中，Maker 可以合法占据 $p$，使 $S \\subseteq M\\cup\\{p\\}$。HasSnaky 对集合扩大单调，所以后续落子不破坏目标。',
          en: 'If $p$ is already in $M$, then $S \\subseteq M$ and the goal holds. Otherwise $p$ is absent from $B$, so Maker can legally claim $p$ and obtain $S \\subseteq M\\cup\\{p\\}$. HasSnaky is preserved when Maker’s set grows.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("$p\\in M \\Rightarrow S\\subseteq M$，因为 $S\\setminus\\{p\\}\\subseteq M$。", "If $p\\in M$, then $S\\subseteq M$ because $S\\setminus\\{p\\}\\subseteq M$."),
            reason: text("S 中等于 $p$ 的点由本分支给出，其余点由威胁的所需点条件给出；此时目标图形已经出现。", "The branch assumption supplies $p$ and the requirement supplies every other cell of $S$, so the target shape is already present."),
          },
          {
            statement: text("$p\\notin M$ 且 $p\\in S \\Rightarrow p\\notin B$，Maker 可落 $p$，随后 $S\\subseteq M\\cup\\{p\\}$。", "If $p\\notin M$ and $p\\in S$, then $p\\notin B$; Maker may claim $p$ and obtain $S\\subseteq M\\cup\\{p\\}$."),
            reason: text("$H=S$ 与 $B$ 不交保证这个缺失格未被对手占据；若 $p$ 根本不在 $S$ 中，$S\\setminus\\{p\\}=S$ 已使目标成立。", "Disjointness of $H=S$ from $B$ makes the missing cell legal. If $p$ is not in $S$ at all, $S\\setminus\\{p\\}=S$ already gives the goal."),
          },
          {
            statement: text("$\\mathrm{HasSnaky}(M')$ 在 $M'$ 扩大时保持，故可得到精确的一手 Winning。", "$\\mathrm{HasSnaky}(M')$ persists when $M'$ grows, giving the required one-move Winning statement."),
            reason: text("目标已出现时可选择新空格补足这一步；目标尚缺 $p$ 时，落 $p$ 后的任意合法回复都不改变 Maker 已拥有的 $S$。", "If the goal already holds, a fresh legal cell pads the move. Otherwise claiming $p$ completes $S$, and any legal reply leaves Maker’s set intact."),
          },
        ],
        next: { zh: '有了基础威胁，需要证明证书的分叉运算也保留这种策略语义。', en: 'Show that the certificate’s fork operation preserves this strategy meaning.' },
        evidence: {
          theorems: ['OAI.SnakyConditional.threat_leaf', 'OAI.SnakyConditional.qbaseRow_threat'],
          taskIds: ['v8_original_goal'], checkIds: ['check-880510ac5378f33c535f'],
          source: { name: 'Submission.lean', line: 232, endLine: 253 },
        },
      },
      {
        id: 'choose-an-unblocked-branch',
        title: { zh: '对手一手不能同时阻断全部分支', en: 'One reply cannot block every branch' },
        given: {
          zh: '每个 child 都是 $\\le n$ 手威胁；各 $A_i \\subseteq A\\cup\\{p\\}$、$H_i \\subseteq H$，且 $p\\in H$、$\\bigcap H_i \\subseteq A\\cup\\{p\\}$。假设 $A\\subseteq M$、$H\\cap B=\\emptyset$。',
          en: 'Each child is a threat of at most $n$ moves, with $A_i \\subseteq A\\cup\\{p\\}$, $H_i \\subseteq H$, $p\\in H$ and $\\bigcap H_i \\subseteq A\\cup\\{p\\}$. Assume $A\\subseteq M$ and $H\\cap B=\\emptyset$.',
        },
        claim: { zh: '这些 child 合成一个 $n+1$ 手威胁。', en: 'The children combine into a threat of $n+1$ moves.' },
        because: {
          zh: '若 $p$ 未在 $M$ 中，先合法落在 $p$。对手的合法回复 $b$ 不属于 $M\\cup\\{p\\}$，所以不属于 $A\\cup\\{p\\}$；由交集条件，至少一个 $H_i$ 不含 $b$。这个 child 的 $A_i$ 已全部被 Maker 占据，$H_i$ 仍与更新后的 $B$ 不交，可执行其策略。若 $p$ 原已在 $M$ 中，直接选一个 child 并用单调性补足时间。',
          en: 'If $p$ is not already in $M$, claim it. A legal reply $b$ lies outside $M\\cup\\{p\\}$, hence outside $A\\cup\\{p\\}$. The intersection condition gives a child with $b\\notin H_i$. Its requirements $A_i$ are now owned and its envelope remains disjoint from Breaker, so its strategy applies. If $p$ was already owned, choose a child immediately and pad the time using monotonicity.',
        },
        dependsOn: ["give-base-rows-a-game-meaning"],
        derivation: [
          {
            statement: text("$p\\notin M \\Rightarrow p\\notin M\\cup B$，可先合法落 $p$。", "If $p\\notin M$, then $p\\notin M\\cup B$, so claiming $p$ is legal."),
            reason: text("$p\\in H$ 而 $H\\cap B=\\emptyset$ 排除 $p\\in B$；落子后所有 $A_i\\subseteq A\\cup\\{p\\}\\subseteq M\\cup\\{p\\}$ 都已被 Maker 满足。", "$p\\in H$ and $H\\cap B=\\emptyset$ exclude $p\\in B$. After the move, $A_i\\subseteq A\\cup\\{p\\}\\subseteq M\\cup\\{p\\}$ satisfies every child requirement."),
          },
          {
            statement: text("合法回复 $b\\notin M\\cup\\{p\\} \\Rightarrow b\\notin A\\cup\\{p\\} \\Rightarrow \\exists i$，$b\\notin H_i$。", "A legal reply $b\\notin M\\cup\\{p\\}$ gives $b\\notin A\\cup\\{p\\}$, hence some $i$ has $b\\notin H_i$."),
            reason: text("若 $b$ 属于所有 $H_i$，交集条件会把它放进 $A\\cup\\{p\\}$，与合法性矛盾。这里选择的 child 可以随对手回复而改变。", "If $b$ belonged to every $H_i$, the intersection condition would place it in $A\\cup\\{p\\}$, contradicting legality. The chosen child may depend on the reply."),
          },
          {
            statement: text("$H_i\\cap(B\\cup\\{b\\})=\\emptyset$，因此该 child 在剩余至多 $n$ 手内完成。", "$H_i\\cap(B\\cup\\{b\\})=\\emptyset$, so the selected child succeeds in at most $n$ further moves."),
            reason: text("原先 $H_i\\subseteq H$ 已排除旧 $B$，上一行又排除新点 $b$；结合已满足的 $A_i$，就能应用 child 的 Threat。", "The inclusion $H_i\\subseteq H$ excludes the old $B$, and the previous line excludes $b$. Together with $A_i$, these are exactly the selected Threat’s hypotheses."),
          },
          {
            statement: text("若 $p\\in M$，直接取任一 child，再把其高度补到 $n+1$。", "If $p\\in M$, choose any child and pad its height to $n+1$."),
            reason: text("此时 $A_i$ 已在 $M$ 中，包络也未受阻；非空 child 列表提供可选分支，目标单调性允许使用 winning_mono_time。", "All $A_i$ are already owned and their envelopes unblocked. The nonempty list supplies a child, and monotonicity permits winning_mono_time."),
          },
        ],
        next: { zh: '因此，有限表中的每一次 fork 都能把已证 child 威胁升级为父威胁。', en: 'Thus each fork in the finite table turns verified child threats into a parent threat.' },
        evidence: {
          theorems: ['OAI.SnakyConditional.threat_fork', 'OAI.SnakyConditional.winning_mono_time'],
          taskIds: ['v8_original_goal'], checkIds: ['check-880510ac5378f33c535f'],
          source: { name: 'Submission.lean', line: 341, endLine: 362 },
        },
      },
      {
        id: 'interpret-the-whole-table',
        title: { zh: '按 child 索引严格递减，把整张表解释为策略', en: 'Interpret the whole table by descending child indices' },
        given: { zh: 'qTableValid 保证每项非空且 $\\mathrm{child} <$ 当前行号；六个基础行已是威胁，旋转平移保持 HasSnaky。', en: 'qTableValid gives nonempty entries with child indices below the current row; base rows are threats, and rotations and translations preserve HasSnaky.' },
        claim: { zh: '对全部 $i<616$，$\\mathrm{Threat}(\\mathrm{qGoal},(\\mathrm{qr}\\,i).A,(\\mathrm{qr}\\,i).H,(\\mathrm{qr}\\,i).\\mathrm{height})$ 成立。', en: 'For every $i<616$, $\\mathrm{Threat}(\\mathrm{qGoal},(\\mathrm{qr}\\,i).A,(\\mathrm{qr}\\,i).H,(\\mathrm{qr}\\,i).\\mathrm{height})$ holds.' },
        because: {
          zh: 'qr_threat 对 $i$ 作强归纳。$i<6$ 时调用基础威胁；否则对每个 child 用 $\\mathrm{child}<i$ 的归纳假设，再以 qplaceRow_threat 旋转平移，最后用 qforkRow_threat 合成父行。目标图形在这些格点双射下保持不变。',
          en: 'qr_threat uses strong induction on $i$. For $i<6$ it applies the base threat. Otherwise it applies the induction hypothesis to each $\\mathrm{child}<i$, transports that threat with qplaceRow_threat, and combines the children with qforkRow_threat. The goal is invariant under these cell bijections.',
        },
        dependsOn: ["give-base-rows-a-game-meaning", "choose-an-unblocked-branch"],
        derivation: [
          {
            statement: text("$i<6$：第 $i$ 行是平移后的 $S\\setminus\\{p\\}$，高度为 $1$。", "For $i<6$, row $i$ is a translated $S\\setminus\\{p\\}$, with height one."),
            reason: text("基础行把 Snaky 的六个可能缺口逐一移到原点；前面的叶威胁因此覆盖所有基础索引。", "The base rows translate each of Snaky’s six possible missing cells to the origin. The leaf-threat argument covers every base index."),
          },
          {
            statement: text("$i\\ge 6$：每项 child $j<i$，先得到 $\\mathrm{Threat}(\\mathrm{qGoal},A_j,H_j,h_j)$。", "For $i\\ge 6$, every child $j<i$ already has $\\mathrm{Threat}(\\mathrm{qGoal},A_j,H_j,h_j)$."),
            reason: text("强归纳允许直接使用所有较小索引的结论；旋转平移是格点双射，连同 HasSnaky 的图形见证一起搬运该威胁。", "Strong induction supplies all smaller indices. Rotate and translate each threat along a cell bijection, transporting its HasSnaky witness as well."),
          },
          {
            statement: text("把已放置 child 代入 fork：父高度 $1+\\max h_j$，得到第 $i$ 行的 Threat。", "Fork the placed children at height $1+\\max h_j$ to obtain the Threat for row $i$."),
            reason: text("fork 的 $A$、$H$ 定义正好保证上一阶段所需的包含与交集条件；因此归纳从六个叶行扩展到全部 $i<616$。", "The fork definitions of $A$ and $H$ supply the required containments and intersection condition. This extends the six leaf cases to every $i<616$."),
          },
        ],
        next: { zh: '已核验的关键行现在可作为开局分支使用，并携带各自的剩余手数上界。', en: 'The verified distinguished rows can now serve as opening branches with their own move bounds.' },
        evidence: {
          theorems: ['OAI.SnakyConditional.qr_threat', 'OAI.SnakyConditional.qplaceRow_threat', 'OAI.SnakyConditional.qforkRow_threat'],
          taskIds: ['v8_original_goal'], checkIds: ['check-880510ac5378f33c535f'],
          source: { name: 'Submission.lean', line: 14473, endLine: 14494 },
        },
      },
      {
        id: 'close-the-empty-board-opening',
        title: { zh: '把开局分支合成空棋盘的 35 手必胜性', en: 'Combine the opening branches into a 35-move win from empty' },
        given: {
          zh: '$12$ 个高度 $\\le 33$ 的分支先组成 $34$ 手的 escape 威胁；平移后它只要求 Maker 已占原点。它与关键行的旋转平移共组成 $24$ 个根分支。',
          en: 'Twelve branches of height $\\le 33$ first form a $34$-move escape threat; after translation it requires only the origin. Together with placements of the distinguished rows, it forms $24$ root branches.',
        },
        claim: { zh: '根分支全部满足 $A_i \\subseteq \\{o\\}$、$\\mathrm{height}_i \\le 34$、$\\bigcap H_i \\subseteq \\{o\\}$，所以 $\\mathrm{Winning}(\\mathrm{qGoal},35,\\emptyset,\\emptyset)$。', en: 'Every root branch has $A_i \\subseteq \\{o\\}$ and $\\mathrm{height}_i \\le 34$, while $\\bigcap H_i \\subseteq \\{o\\}$; hence $\\mathrm{Winning}(\\mathrm{qGoal},35,\\emptyset,\\emptyset)$.' },
        because: {
          zh: 'qroot_A_bound 与 qroot_child_height 核对所需点和高度；qroot_common_bound 逐点排除原点之外的交集格点。Maker 首手占 $o$ 后，对手合法回复不等于 $o$，因此总有一个包络未受阻的根分支。上一步给出的 child 策略再用至多 $34$ 手完成，合计 $35$ 手。',
          en: 'qroot_A_bound and qroot_child_height check requirements and heights; qroot_common_bound excludes every non-origin cell from the common envelope. After Maker claims $o$, any legal reply differs from $o$, leaving some root envelope unblocked. Its child strategy finishes in at most $34$ more moves, giving $35$ in total.',
        },
        dependsOn: ["interpret-the-whole-table", "choose-an-unblocked-branch"],
        derivation: [
          {
            statement: text("$12$ 个 child 的高度 $\\le 33 \\Rightarrow$ escape 的高度为 $34$，所需点为 $\\{(0,-1)\\}$。", "Twelve children of height $\\le 33$ yield an escape threat of height $34$ requiring $\\{(0,-1)\\}$."),
            reason: text("这些 child 的 $A$ 都在 $\\{(0,-1),o\\}$ 内，共同 $H$ 也只可能落在这两个点；在 $o$ 分叉后从所需集删去 $o$。", "The child requirements and common envelope lie in $\\{(0,-1),o\\}$. Forking at $o$ removes $o$ from the parent requirement."),
          },
          {
            statement: text("将 escape 平移 $(0,1)$，其所需点变成 $\\{o\\}$。", "Translate escape by $(0,1)$, turning its required set into $\\{o\\}$."),
            reason: text("$(0,-1)+(0,1)=o$；平移保持威胁和高度，所以它可以和关键行的其他放置一起作为根分支。", "$(0,-1)+(0,1)=o$. Translation preserves the threat and its height, allowing it to join the placed distinguished rows as a root branch."),
          },
          {
            statement: text("$24$ 个根 child：$A_i\\subseteq\\{o\\}$，$h_i\\le 34$，$\\bigcap H_i\\subseteq\\{o\\}$。", "The $24$ root children satisfy $A_i\\subseteq\\{o\\}$, $h_i\\le 34$ and $\\bigcap H_i\\subseteq\\{o\\}$."),
            reason: text("前两项由 qroot_A_bound、qroot_child_height 逐项核对；qroot_common_bound 排除每个原点外的共同包络点。", "qroot_A_bound and qroot_child_height verify the first two clauses; qroot_common_bound excludes all non-origin common-envelope cells."),
          },
          {
            statement: text("Maker 首手取 $o \\Rightarrow$ 任意合法回复后仍有一个 child，故 $1+34=35$。", "Maker opens at $o$; some child survives every legal reply, giving $1+34=35$."),
            reason: text("对手不能回复 $o$，因而不能同时落入全部根包络。分叉定理得到所需点为空的 $35$ 手威胁，在空棋盘上即可直接使用。", "The reply cannot be $o$ and therefore cannot belong to every root envelope. The fork theorem yields a $35$-move threat with no required cells, applicable from the empty board."),
          },
        ],
        next: { zh: '把递归的 Winning 存在性转换为一个对每个局面都有定义的普通策略。', en: 'Convert recursive Winning witnesses into a policy defined on every state.' },
        evidence: {
          theorems: ['OAI.SnakyConditional.qroot_A_bound', 'OAI.SnakyConditional.qroot_child_height', 'OAI.SnakyConditional.qroot_common_bound', 'OAI.SnakyConditional.qempty_winning_35'],
          taskIds: ['v8_original_goal'], checkIds: ['check-880510ac5378f33c535f'],
          source: { name: 'Submission.lean', line: 15194, endLine: 15215 },
        },
      },
      {
        id: 'extract-the-legal-policy',
        title: { zh: '提取策略，并跟踪每一步的合法状态', en: 'Extract the policy and track legal states' },
        given: { zh: '$\\mathrm{Winning}(\\mathrm{HasSnaky},35,\\emptyset,\\emptyset)$ 已证。对手 $\\beta$ 只需在最后一手之前满足 LegalRepliesBeforeFinal。', en: '$\\mathrm{Winning}(\\mathrm{HasSnaky},35,\\emptyset,\\emptyset)$ is established. The opponent $\\beta$ satisfies LegalRepliesBeforeFinal, which requires legality only before the final Maker move.' },
        claim: {
          zh: '存在始终不落入 $M\\cup B$ 的 $\\sigma$；任意这样的 $\\beta$ 都使 Maker 第 $35$ 手后包含 Snaky、恰有 $35$ 子，且与 Breaker 的前 $34$ 子不交。每个 $k<35$ 的中间状态双方不交，Breaker 恰有 $k$ 子。',
          en: 'There is a $\\sigma$ that always avoids $M\\cup B$. For every such $\\beta$, Maker has a Snaky and exactly $35$ cells after move $35$, disjoint from Breaker’s first $34$ cells. At every $k<35$ the two sets are disjoint and Breaker has exactly $k$ cells.',
        },
        because: {
          zh: 'winningPolicy 在有必胜见证时选择其合法落点，否则选一个有限占据集之外的新格。归纳保持第 $k$ 轮后的 $\\mathrm{Winning}(G,35-k,M_k,B_k)$；每次插入新格增加一个基数，并由双方的合法条件保持不交。最终用 ordinary_policy_of_winning 合并这些结论。',
          en: 'winningPolicy chooses a legal move from a winning witness when one exists, otherwise a fresh cell outside the finite occupied sets. Induction preserves $\\mathrm{Winning}(G,35-k,M_k,B_k)$; inserting fresh cells increments cardinalities and legal replies preserve disjointness. ordinary_policy_of_winning combines these facts.',
        },
        dependsOn: ["close-the-empty-board-opening"],
        derivation: [
          {
            statement: text("$\\sigma(n,M,B)$ 取 Winning 的合法首手；若无见证，则取 $M\\cup B$ 外的新格。", "$\\sigma(n,M,B)$ chooses a legal first move from Winning, or a fresh cell outside $M\\cup B$ when no witness exists."),
            reason: text("棋盘 $\\mathbb{Z}^2$ 无限而 $M\\cup B$ 有限，因此后备落点始终存在。这让 $\\sigma$ 在每个输入局面都有定义并始终合法。", "The board $\\mathbb{Z}^2$ is infinite and $M\\cup B$ finite, so the fallback always exists. Thus $\\sigma$ is defined and legal on every input state."),
          },
          {
            statement: text("对 $k<35$，维持 $\\mathrm{Winning}(\\mathrm{HasSnaky},35-k,M_k,B_k)$。", "For $k<35$, maintain $\\mathrm{Winning}(\\mathrm{HasSnaky},35-k,M_k,B_k)$."),
            reason: text("$k=0$ 来自空棋盘结论；对 $k\\le 33$，合法的 $\\beta_k$ 使 winningPolicy_step 把剩余手数减一。每次双方插入新格，同时保持不交。", "The $k=0$ case is the empty-board result. For $k\\le 33$, legal $\\beta_k$ lets winningPolicy_step reduce the remaining moves by one, while fresh insertions preserve disjointness."),
          },
          {
            statement: text("$k=34$ 时剩余 $1$ 手；第 $35$ 个 Maker 落点后，$\\mathrm{HasSnaky}(M_{35})$。", "At $k=34$ one move remains; after Maker’s $35$th move, $\\mathrm{HasSnaky}(M_{35})$ holds."),
            reason: text("一手 Winning 的结论只取决于插入 Maker 落点后的集合。证明选一个辅助合法回复来读取该结论，不要求实际的 $\\beta_{34}$ 合法。", "The one-move Winning conclusion depends only on Maker’s updated set. The proof uses an auxiliary fresh legal reply to read it, without assuming legality of the actual $\\beta_{34}$."),
          },
          {
            statement: text("$|M_{35}|=35$，$M_{35}\\cap B_{34}=\\emptyset$；$k<35$ 时 $|B_k|=k$、$M_k\\cap B_k=\\emptyset$。", "$|M_{35}|=35$ and $M_{35}\\cap B_{34}=\\emptyset$; for $k<35$, $|B_k|=k$ and $M_k\\cap B_k=\\emptyset$."),
            reason: text("Maker 总选新格，故每次基数加一；前 $34$ 次合法回复同理。最后一次 Maker 只需避开已经存在的 $B_{34}$。", "Every Maker move is fresh, increasing its cardinality by one; the first $34$ legal replies do likewise. The final Maker move avoids the already existing $B_{34}$."),
          },
        ],
        next: { zh: '这给出原声明的策略与合法状态结论；最终不交性准确使用 $B_{34}$，而不要求最后一个无关回复 $\\beta_{34}$ 合法。', en: 'This gives the exact strategy and legal-state theorem. Final disjointness uses $B_{34}$, without requiring the irrelevant last reply $\\beta_{34}$ to be legal.' },
        evidence: {
          theorems: ['OAI.SnakyConditional.ordinary_policy_of_winning', 'OAI.SnakyConditional.snaky_winning_strategy_with_legal_states'],
          taskIds: ['v8_original_goal'], deliveryIds: ['dc3722a3-34a0-41e2-af29-390b824fe276'], checkIds: ['check-880510ac5378f33c535f'],
          source: { name: 'Submission.lean', line: 15259, endLine: 15270 },
        },
      },
    ],
  },
  {
    recordId: 'openai_hadamard_cube_fiber',
    runId: '3f2c13eb-fbf3-47d4-bff5-aed2489d23aa',
    proofSha256: 'd818e4c8217e53057b254f92285bb22930f2b47504ed68d7e8def9d2547fa3a1',
    title: { zh: '用两个消失矩隔离一个三次方纤维', en: 'Use two vanishing moments to isolate a cubic fiber' },
    strategy: text('$H$ 与其逐项平方的行正交性分别给出 $\\sum v_k=0$ 和 $\\sum v_k^2=0$。利用 $|v_k|=1$ 构造只保留 $v_k^3=a$ 分支的逐点恒等式，求和后两个矩消失，再约去 $a-b$ 得到纤维和为零。', 'Row orthogonality of $H$ and its entrywise square gives $\\sum v_k=0$ and $\\sum v_k^2=0$. Use $|v_k|=1$ to build a pointwise identity selecting the branch $v_k^3=a$; summing kills both moments, and cancelling $a-b$ gives the zero fiber sum.'),
    stages: [{
      title: text('取得两个消失矩', 'Obtain two vanishing moments'),
      summary: text('先把方阵的列正交转为行正交，再对逐项平方重复论证，得到一阶矩与共轭平方矩都为零。', 'Convert column orthogonality of the square matrix to row orthogonality and repeat for its entrywise square, obtaining zero first and conjugate-square moments.'),
      stepIds: ['derive-the-first-moment', 'derive-the-second-moment'],
    }, {
      title: text('构造纤维筛选恒等式', 'Build the fiber-selecting identity'),
      summary: text('单位模长把 $v^3\\overline{v}^2$ 化为 $v$；分别代入立方为 $a$ 或 $b$，得到只在 $a$ 纤维上保留 $(a-b)v$ 的等式。', 'Unit modulus reduces $v^3\\overline{v}^2$ to $v$. Splitting on cube values $a$ and $b$ gives an identity retaining $(a-b)v$ only on the $a$-fiber.'),
      stepIds: ['reduce-cubes-using-unit-modulus', 'build-the-fiber-indicator'],
    }, {
      title: text('求和并消去非零因子', 'Sum and cancel the nonzero factor'),
      summary: text('将逐点恒等式求和，两个独立的消失矩使右端为零；$a\\ne b$ 允许消去公共因子，得到目标行比值的纤维和。', 'Sum the pointwise identity; the two independent vanishing moments make its right side zero. Since $a\\ne b$, cancel the common factor to obtain the required row-ratio fiber sum.'),
      stepIds: ['sum-and-cancel'],
    }],
    goal: {
      zh: '设 $6\\times 6$ 矩阵 $H$ 和其逐项平方 $H^2$ 都是复 Hadamard 矩阵。取不同两行的比值 $v_k = H_{ik}\\overline{H_{jk}}$，若每个 $v_k^3$ 只可能为两个不同值 $a$、$b$，证明 $\\sum_{v_k^3=a} v_k=0$。',
      en: 'Let $H$ and its entrywise square $H^2$ be $6\\times 6$ complex Hadamard matrices. For distinct rows let $v_k = H_{ik}\\overline{H_{jk}}$. If every $v_k^3$ equals one of two distinct values $a,b$, prove $\\sum_{v_k^3=a} v_k=0$.',
    },
    notation: {
      zh: '$H^*$ 表示共轭转置，$H^2$ 在本题始终指逐项平方。$\\operatorname{cubeFiber}(v,a) = \\{k : v_k^3 = a\\}$。星号 star 在标量上就是复共轭。',
      en: '$H^*$ denotes conjugate transpose; $H^2$ here always means entrywise squaring. $\\operatorname{cubeFiber}(v,a) = \\{k : v_k^3 = a\\}$. Scalar star is complex conjugation.',
    },
    steps: [
      {
        id: 'derive-the-first-moment',
        title: { zh: '先从列正交得到行正交', en: 'Pass from column orthogonality to row orthogonality' },
        given: { zh: 'Hadamard 定义给出 $H^*H = 6I$，且 $i\\ne j$。', en: 'The Hadamard definition gives $H^*H = 6I$, with $i\\ne j$.' },
        claim: { zh: '$HH^* = 6I$，因此 $\\sum_k v_k=0$。', en: 'Then $HH^* = 6I$, and consequently $\\sum_k v_k=0$.' },
        because: {
          zh: '$\\frac{1}{6}H^*$ 是方阵 $H$ 的左逆；mul_eq_one_comm 将它转为右逆，乘回 $6$ 得 $HH^* = 6I$。取该矩阵等式的 $(i,j)$ 元，右侧因 $i\\ne j$ 为 $0$，左侧正是 $\\sum_k H_{ik}\\overline{H_{jk}}$。',
          en: '$\\frac{1}{6}H^*$ is a left inverse of the square matrix $H$. mul_eq_one_comm makes it a right inverse; multiplying by six gives $HH^* = 6I$. Its $(i,j)$ entry is zero on the right because $i\\ne j$ and is $\\sum_k H_{ik}\\overline{H_{jk}}$ on the left.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("$L = \\frac{1}{6}H^* \\Rightarrow LH = \\frac{1}{6}(H^*H) = \\frac{1}{6}\\cdot 6I = I$。", "$L = \\frac{1}{6}H^*$ gives $LH = \\frac{1}{6}(H^*H) = \\frac{1}{6}\\cdot 6I = I$."),
            reason: text("Hadamard 定义提供的是列正交 $H^*H = 6I$；$6$ 在复数域可逆，所以可以构造这个左逆。", "The Hadamard definition supplies column orthogonality $H^*H = 6I$. Six is invertible in $\\mathbb{C}$, giving this left inverse."),
          },
          {
            statement: text("$LH=I \\Rightarrow HL=I \\Rightarrow HH^* = 6I$。", "$LH=I$ implies $HL=I$, hence $HH^* = 6I$."),
            reason: text("$H$ 是方阵；源码用 mul_eq_one_comm 把左逆等式交换为右逆等式，再乘回非零标量 $6$。", "$H$ is square. The source uses mul_eq_one_comm to obtain the right-inverse equality, then multiplies back by the nonzero scalar six."),
          },
          {
            statement: text("$i \\ne j \\Rightarrow (HH^*)_{ij} = \\sum_k H_{ik}\\overline{H_{jk}} = 0$，亦即 $\\sum_k v_k=0$。", "$i\\ne j$ gives $(HH^*)_{ij} = \\sum_k H_{ik}\\overline{H_{jk}} = 0$, namely $\\sum_k v_k=0$."),
            reason: text("取矩阵等式的不同行列位置；右端 $6I$ 的非对角元为 $0$，左端按矩阵乘法展开。", "Take the off-diagonal $(i,j)$ entry. The right side $6I$ is zero there; expanding the left side gives the stated sum."),
          },
        ],
        next: { zh: '对逐项平方矩阵重复这个论证，得到第二个消失矩。', en: 'Repeat the argument for the entrywise square to obtain a second vanishing moment.' },
        evidence: {
          theorems: ['OAI.HadamardSix.rowRatio_cubeFiber_sum_zero'],
          taskIds: ['initial_goal_1'], checkIds: ['check-2569016300b5c39ae71c'],
          source: { name: 'Submission.lean', line: 34, endLine: 49 },
        },
      },
      {
        id: 'derive-the-second-moment',
        title: { zh: '逐项平方的正交性给出 ∑vₖ²=0', en: 'Orthogonality of the square gives ∑vₖ²=0' },
        given: { zh: '逐项平方矩阵同样满足 Hadamard 条件。', en: 'The entrywise square also satisfies the Hadamard conditions.' },
        claim: { zh: '$\\sum_k v_k^2=0$，取共轭还得到 $\\sum_k \\overline{v_k}^2 = 0$。', en: 'We obtain $\\sum_k v_k^2=0$, and conjugation gives $\\sum_k \\overline{v_k}^2 = 0$.' },
        because: {
          zh: '平方矩阵的不同行内积为 $0$，而 $H_{ik}^2\\overline{H_{jk}^2} = (H_{ik}\\overline{H_{jk}})^2 = v_k^2$。复共轭保持有限和、平方及 $0$，所以把等式整体取共轭即可得到后一式。',
          en: 'Distinct rows of the squared matrix have zero inner product, and $H_{ik}^2\\overline{H_{jk}^2} = (H_{ik}\\overline{H_{jk}})^2 = v_k^2$. Conjugation preserves finite sums, squares and zero, yielding the conjugated identity.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("令 $Q_{ik} = H_{ik}^2$。由 $Q^*Q = 6I$ 得 $QQ^* = 6I$。", "Set $Q_{ik} = H_{ik}^2$. From $Q^*Q = 6I$ obtain $QQ^* = 6I$."),
            reason: text("题目对逐项平方矩阵单独给出了 Hadamard 假设；对 $Q$ 使用同样的方阵左右逆论证。", "The entrywise-square matrix has its own Hadamard hypothesis. Apply the same left-to-right inverse argument to $Q$."),
          },
          {
            statement: text("$\\sum_k Q_{ik}\\overline{Q_{jk}} = \\sum_k (H_{ik}\\overline{H_{jk}})^2 = \\sum_k v_k^2 = 0$。", "$\\sum_k Q_{ik}\\overline{Q_{jk}} = \\sum_k (H_{ik}\\overline{H_{jk}})^2 = \\sum_k v_k^2 = 0$."),
            reason: text("$i\\ne j$ 使 $Q$ 的不同行内积为 $0$；复共轭保持平方，普通乘法交换使两个平方并成 $v_k^2$。", "The distinct rows of $Q$ have zero inner product. Conjugation preserves squares, and commutativity combines the squared factors into $v_k^2$."),
          },
          {
            statement: text("取共轭：$\\sum_k \\overline{v_k}^2 = \\overline{\\sum_k v_k^2} = 0$。", "Conjugating gives $\\sum_k \\overline{v_k}^2 = \\overline{\\sum_k v_k^2} = 0$."),
            reason: text("复共轭保持有限和并把 $0$ 映为 $0$；最终求和时需要的是这个共轭平方矩。", "Conjugation preserves finite sums and zero. This conjugate-square moment is the one used in the final sum."),
          },
        ],
        next: { zh: '两个消失矩将用于消掉一个专门构造的纤维指示恒等式的总和。', en: 'These two vanishing sums will cancel the total of a fiber-selecting identity.' },
        evidence: {
          theorems: ['OAI.HadamardSix.rowRatio_cubeFiber_sum_zero'],
          taskIds: ['initial_goal_1'], checkIds: ['check-2569016300b5c39ae71c'],
          source: { name: 'Submission.lean', line: 69, endLine: 87 },
        },
      },
      {
        id: 'reduce-cubes-using-unit-modulus',
        title: { zh: '模长 1 把三次方和共轭平方联系起来', en: 'Unit modulus links cubes with conjugate squares' },
        given: { zh: '$H$ 的每个元素模长为 $1$，故 $|v_k|=1$。', en: 'Every entry of $H$ has modulus one, hence $|v_k|=1$.' },
        claim: { zh: '$v_k\\overline{v_k} = 1$，进而 $v_k^3\\overline{v_k}^2 = v_k$。', en: 'Thus $v_k\\overline{v_k} = 1$ and $v_k^3\\overline{v_k}^2 = v_k$.' },
        because: {
          zh: '$|H_{ik}\\overline{H_{jk}}| = |H_{ik}||H_{jk}| = 1$，复数乘共轭等于模长平方。因此 $v^3\\overline{v}^2 = v(v\\overline{v})^2 = v$。',
          en: '$|H_{ik}\\overline{H_{jk}}| = |H_{ik}||H_{jk}| = 1$, and a complex number times its conjugate is its squared modulus. Hence $v^3\\overline{v}^2 = v(v\\overline{v})^2 = v$.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("$|v_k| = |H_{ik}|\\,|\\overline{H_{jk}}| = 1\\cdot 1 = 1$。", "$|v_k| = |H_{ik}|\\,|\\overline{H_{jk}}| = 1\\cdot 1 = 1$."),
            reason: text("$H$ 的 Unimodular 条件逐项给出模长 $1$，且共轭不改变模长。", "The Unimodular hypothesis gives modulus one entrywise, and conjugation preserves modulus."),
          },
          {
            statement: text("$v_k\\overline{v_k} = |v_k|^2 = 1$。", "$v_k\\overline{v_k} = |v_k|^2 = 1$."),
            reason: text("复数与其共轭的乘积等于模长平方；这一步不需要 $a$、$b$ 的立方取值条件。", "A complex number times its conjugate is its squared modulus. This step does not use the two possible cube values $a,b$."),
          },
          {
            statement: text("$v_k^3\\overline{v_k}^2 = v_k(v_k\\overline{v_k})^2 = v_k$。", "$v_k^3\\overline{v_k}^2 = v_k(v_k\\overline{v_k})^2 = v_k$."),
            reason: text("先按交换结合律重排，再代入上一行的 $1$；这为下一阶段的两个立方分支提供相同的代换式。", "Rearrange by commutativity and associativity, then substitute one from the preceding identity. Both cube-value cases will use this same equality."),
          },
        ],
        next: { zh: '按 $v_k^3=a$ 或 $b$ 分情况，就能把右侧改造成只保留 $a$ 纤维的表达式。', en: 'Split on $v_k^3=a$ or $b$ to form an expression that retains only the $a$-fiber.' },
        evidence: {
          theorems: ['OAI.HadamardSix.rowRatio_cubeFiber_sum_zero'],
          taskIds: ['initial_goal_1'], checkIds: ['check-2569016300b5c39ae71c'],
          source: { name: 'Submission.lean', line: 74, endLine: 95 },
        },
      },
      {
        id: 'build-the-fiber-indicator',
        figure: 'hadamard-fiber',
        title: { zh: '构造逐点恒等式，筛出 a 纤维', en: 'Construct a pointwise identity selecting the a-fiber' },
        given: { zh: '$a\\ne b$，且每个 $v_k^3$ 都等于 $a$ 或 $b$。', en: '$a\\ne b$ and every $v_k^3$ is $a$ or $b$.' },
        claim: { zh: '对每个 $k$，$1_{\\{v_k^3=a\\}}(a-b)v_k = a(v_k-b\\overline{v_k}^2)$。', en: 'For each $k$, $1_{\\{v_k^3=a\\}}(a-b)v_k = a(v_k-b\\overline{v_k}^2)$.' },
        because: {
          zh: '若 $v^3=a$，上一步给出 $a\\overline{v}^2 = v$，右边等于 $av-bv=(a-b)v$。若 $v^3=b$，则 $b\\overline{v}^2 = v$，右边为 $0$；$a\\ne b$ 又保证指示条件为假，左边同为 $0$。',
          en: 'If $v^3=a$, the preceding identity gives $a\\overline{v}^2 = v$, so the right side is $av-bv=(a-b)v$. If $v^3=b$, then $b\\overline{v}^2 = v$ and the right side is zero; $a\\ne b$ makes the indicator false, so the left side is also zero.',
        },
        dependsOn: ["reduce-cubes-using-unit-modulus"],
        derivation: [
          {
            statement: text("若 $v_k^3=a$，则 $a\\overline{v_k}^2 = v_k$。", "If $v_k^3=a$, then $a\\overline{v_k}^2 = v_k$."),
            reason: text("把 $v_k^3=a$ 代入上一阶段的 $v_k^3\\overline{v_k}^2 = v_k$，得到可替换右侧乘积的等式。", "Substitute $v_k^3=a$ into $v_k^3\\overline{v_k}^2 = v_k$ to obtain the needed replacement."),
          },
          {
            statement: text("$a(v_k-b\\overline{v_k}^2) = av_k-b(a\\overline{v_k}^2) = av_k-bv_k = (a-b)v_k$。", "$a(v_k-b\\overline{v_k}^2) = av_k-b(a\\overline{v_k}^2) = av_k-bv_k = (a-b)v_k$."),
            reason: text("在 $a$ 纤维上，用前一行把 $ab\\overline{v_k}^2$ 改写为 $bv_k$；指示函数在此处取 $1$。", "On the $a$-fiber, replace $ab\\overline{v_k}^2$ by $bv_k$ using the preceding equality. The indicator is one in this case."),
          },
          {
            statement: text("若 $v_k^3=b$，则 $a(v_k-b\\overline{v_k}^2) = a(v_k-v_k) = 0$。", "If $v_k^3=b$, then $a(v_k-b\\overline{v_k}^2) = a(v_k-v_k) = 0$."),
            reason: text("同一单位模长等式给出 $b\\overline{v_k}^2 = v_k$；$a\\ne b$ 保证此时不在 $a$ 纤维，所以指示项也为 $0$。", "The unit-modulus equality now gives $b\\overline{v_k}^2 = v_k$. Since $a\\ne b$, this is not the $a$-fiber, and the indicator term is also zero."),
          },
        ],
        next: { zh: '对 $k$ 求和，右边将只剩两个已知为零的矩。', en: 'Sum over $k$; the right side becomes a combination of the two vanishing moments.' },
        evidence: {
          theorems: ['OAI.HadamardSix.rowRatio_cubeFiber_sum_zero'],
          taskIds: ['initial_goal_1'], checkIds: ['check-2569016300b5c39ae71c'],
          source: { name: 'Submission.lean', line: 88, endLine: 103 },
        },
      },
      {
        id: 'sum-and-cancel',
        title: { zh: '求和后消去非零因子 a−b', en: 'Sum and cancel the nonzero factor a−b' },
        given: { zh: '逐点纤维恒等式、$\\sum v_k=0$ 和 $\\sum_k \\overline{v_k}^2 = 0$ 都已成立。', en: 'The pointwise fiber identity and both $\\sum v_k=0$ and $\\sum_k \\overline{v_k}^2 = 0$ are established.' },
        claim: { zh: '$(a-b)\\sum_{v_k^3=a} v_k=0$，因此 $\\sum_{v_k^3=a} H_{ik}\\overline{H_{jk}} = 0$。', en: '$(a-b)\\sum_{v_k^3=a} v_k=0$, hence $\\sum_{v_k^3=a} H_{ik}\\overline{H_{jk}} = 0$.' },
        because: {
          zh: '有限求和把右边变为 $a(\\sum_k v_k-b\\sum_k \\overline{v_k}^2) = 0$；左边按 Finset.sum_filter 改写为纤维上的和。复数域无零因子，且 $a-b\\ne 0$，所以只能是纤维和等于 $0$。',
          en: 'Summation changes the right side into $a(\\sum_k v_k-b\\sum_k \\overline{v_k}^2) = 0$. Finset.sum_filter rewrites the left side as a sum over the fiber. Since $\\mathbb{C}$ has no zero divisors and $a-b\\ne 0$, the fiber sum must vanish.',
        },
        dependsOn: ["derive-the-first-moment", "derive-the-second-moment", "build-the-fiber-indicator"],
        derivation: [
          {
            statement: text("$(a-b)\\sum_{v_k^3=a} v_k = \\sum_k 1_{\\{v_k^3=a\\}}(a-b)v_k$。", "$(a-b)\\sum_{v_k^3=a} v_k = \\sum_k 1_{\\{v_k^3=a\\}}(a-b)v_k$."),
            reason: text("把有限过滤求和改成全指标集上的条件求和，再把公共因子移入；这就是 cubeFiber 与 Finset.sum_filter 的展开。", "Expand cubeFiber using Finset.sum_filter and move the common factor inside, turning the filtered sum into a conditional sum over all indices."),
          },
          {
            statement: text("$\\sum_k a(v_k-b\\overline{v_k}^2) = a\\sum_k v_k-ab\\sum_k\\overline{v_k}^2 = a\\cdot 0-ab\\cdot 0 = 0$。", "$\\sum_k a(v_k-b\\overline{v_k}^2) = a\\sum_k v_k-ab\\sum_k\\overline{v_k}^2 = a\\cdot 0-ab\\cdot 0 = 0$."),
            reason: text("逐项使用前一阶段的恒等式，再分配有限和；两个独立得到的消失矩在这里汇合。", "Apply the pointwise identity, distribute the finite sum, and use the two independently established vanishing moments."),
          },
          {
            statement: text("$a-b\\ne 0 \\Rightarrow \\sum_{v_k^3=a} v_k=0$。", "Since $a-b\\ne 0$, $\\sum_{v_k^3=a} v_k=0$."),
            reason: text("复数域没有零因子，故前一行乘积为 $0$ 时只能消去非零因子 $a-b$；把 $v_k$ 换回行比值就得到原目标。", "The field $\\mathbb{C}$ has no zero divisors, so cancel the nonzero factor $a-b$. Replacing $v_k$ by its row-ratio definition gives the target."),
          },
        ],
        next: { zh: '将一般向量 $v$ 重新代为两行的比值，即得到目标定理。', en: 'Substitute the row-ratio vector for $v$ to obtain the target theorem.' },
        evidence: {
          theorems: ['OAI.HadamardSix.rowRatio_cubeFiber_sum_zero'],
          taskIds: ['initial_goal_1'], deliveryIds: ['3e7eae39-ed4d-476e-8543-2428de0bf26a'], checkIds: ['check-2569016300b5c39ae71c'],
          source: { name: 'Submission.lean', line: 104, endLine: 114 },
        },
      },
    ],
  },
  {
    recordId: 'openai_surface_cone_candidate_support',
    runId: 'cbfa1f3c-2760-4d7e-987a-97b48698fd49',
    proofSha256: 'bc4a1cec74196b46dd726a46dc467c40b8657527dbd235a49a3cf0b5e4355ac9',
    title: { zh: '用三元复幂级数环实现全部环论条件', en: 'Realize the ring properties with three-variable complex power series' },
    strategy: text('选 $R=\\mathbb{C}\\llbracket X_0,X_1,X_2\\rrbracket$，分别计算维数、极大理想进完备性和剩余域。整闭性通过一元幂级数归纳证明：先从统一分母逐个恢复系数，再把分式域中的整元拉回原环，最后汇合这些性质。', 'Choose $R=\\mathbb{C}\\llbracket X_0,X_1,X_2\\rrbracket$ and separately establish its dimension, maximal-ideal completeness and residue field. Prove integral closedness by adjoining one power-series variable at a time: recover coefficients using a common denominator, pull integral fraction-field elements back into the ring, then assemble the properties.'),
    stages: [{
      title: text('计算维数、完备性与剩余域', 'Compute dimension, completeness and residue field'),
      summary: text('每加一个变量维数增加一；常数项映射识别极大理想与剩余域，分别得到三维、极大理想进完备和剩余域为 $\\mathbb{C}$。', 'Each variable adds one to the dimension. The constant-coefficient map identifies the maximal ideal and residue field, giving dimension three, maximal-ideal completeness and residue field $\\mathbb{C}$.'),
      stepIds: ['compute-the-dimension', 'identify-the-completion-ideal', 'identify-the-residue-field'],
    }, {
      title: text('证明一元整闭性保持', 'Preserve integral closedness in one variable'),
      summary: text('统一非零分母使每个系数依次落回 $S$；再借分式域单射把任意整元拉回 $S\\llbracket X\\rrbracket$，证明添一个变量仍整闭。', 'A common nonzero denominator brings each coefficient back to $S$. An injective fraction-field map then pulls every integral element into $S\\llbracket X\\rrbracket$, preserving integral closedness after one variable.'),
      stepIds: ['descend-almost-integral-coefficients', 'prove-power-series-integral-closedness'],
    }, {
      title: text('选定三元环并汇合性质', 'Choose the three-variable ring and assemble its properties'),
      summary: text('从 $\\mathbb{C}$ 起迭代一元整闭性结论，取三元幂级数环为见证，再填入前面独立得到的维数、完备性与剩余域结论。', 'Iterate the one-variable integral-closedness result from $\\mathbb{C}$, choose the three-variable power-series ring as witness, and combine the separate dimension, completeness and residue-field results.'),
      stepIds: ['assemble-the-explicit-witness'],
    }],
    goal: {
      zh: '构造一个 $\\mathbb{C}$-代数 $R$，证明它是 Noether 局部整环、整闭、关于极大理想进完备、Krull 维数为 $3$，并且 $\\mathbb{C}$ 到其剩余域的自然映射是双射。最终见证为 $R=\\mathbb{C}\\llbracket X_0,X_1,X_2\\rrbracket$。',
      en: 'Construct a $\\mathbb{C}$-algebra $R$ that is a Noetherian local domain, integrally closed, complete for its maximal ideal, of Krull dimension $3$, with a bijective natural map from $\\mathbb{C}$ to its residue field. The witness is $R=\\mathbb{C}\\llbracket X_0,X_1,X_2\\rrbracket$.',
    },
    notation: {
      zh: '$S\\llbracket X\\rrbracket$ 表示一元形式幂级数环，$\\mathrm{MvPowerSeries}(\\mathrm{Fin}\\,n,\\mathbb{C})$ 表示 $n$ 元形式幂级数环。$\\mathfrak{m}$ 是极大理想；“几乎整”指存在固定非零分母，使所有幂都落回基环。',
      en: '$S\\llbracket X\\rrbracket$ denotes one-variable formal power series; $\\mathrm{MvPowerSeries}(\\mathrm{Fin}\\,n,\\mathbb{C})$ denotes $n$-variable power series. $\\mathfrak{m}$ is the maximal ideal. An almost-integral element has one fixed nonzero denominator clearing all of its powers.',
    },
    steps: [
      {
        id: 'compute-the-dimension',
        title: { zh: '每增加一个幂级数变量，维数增加1', en: 'Each power-series variable adds one to the dimension' },
        given: { zh: '$S$ 是 Noether 局部环；常数项映射 $S\\llbracket X\\rrbracket\\to S$ 的核为 $(X)$。', en: 'Let $S$ be a Noetherian local ring. The constant-coefficient map $S\\llbracket X\\rrbracket\\to S$ has kernel $(X)$.' },
        claim: { zh: '$\\dim S\\llbracket X\\rrbracket=\\dim S+1$；递归得到 $\\dim \\mathbb{C}\\llbracket X_0,\\dots,X_{n-1}\\rrbracket=n$，特别是三元情形维数为 $3$。', en: '$\\dim S\\llbracket X\\rrbracket=\\dim S+1$. Iteration gives $\\dim \\mathbb{C}\\llbracket X_0,\\dots,X_{n-1}\\rrbracket=n$, and in particular dimension $3$ for three variables.' },
        because: {
          zh: '$X$ 的常数项为 $0$，故不为单位、属于极大理想；$X$ 又不是零因子。非零因子商环的维数定理给出 $\\dim(S\\llbracket X\\rrbracket/(X))+1=\\dim S\\llbracket X\\rrbracket$。商环经常数项映射同构于 $S$，再用 finSuccEquiv 把 $n+1$ 元环视为 $n$ 元环上的一元幂级数环。',
          en: '$X$ has zero constant term, so it is a nonunit in the maximal ideal, and it is a non-zero-divisor. The dimension theorem gives $\\dim(S\\llbracket X\\rrbracket/(X))+1=\\dim S\\llbracket X\\rrbracket$. The constant-coefficient map identifies the quotient with $S$; finSuccEquiv then writes $n+1$ variables as one power-series variable over $n$ variables.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("$S\\llbracket X\\rrbracket/(X)\\cong S$，且 $X\\in\\mathfrak{m}$、$X$ 不是零因子。", "$S\\llbracket X\\rrbracket/(X)\\cong S$, with $X\\in\\mathfrak{m}$ and $X$ a non-zero-divisor."),
            reason: text("常数项映射满射，核为 $(X)$；$X$ 的常数项为 $0$，所以不是单位。乘 $X$ 只是把系数右移，因而不会把非零级数乘成零。", "The surjective constant map has kernel $(X)$. Since $X$ has zero constant term it is a nonunit. Multiplication by $X$ shifts coefficients and cannot annihilate a nonzero series."),
          },
          {
            statement: text("$\\dim S\\llbracket X\\rrbracket=\\dim(S\\llbracket X\\rrbracket/(X))+1=\\dim S+1$。", "$\\dim S\\llbracket X\\rrbracket=\\dim(S\\llbracket X\\rrbracket/(X))+1=\\dim S+1$."),
            reason: text("将 Noether 局部环中的非零因子商环维数定理应用于 $X$，再用上一行的商环同构。", "Apply the dimension theorem for quotienting a Noetherian local ring by a non-zero-divisor, then use the quotient isomorphism."),
          },
          {
            statement: text("$d_0=\\dim\\mathbb{C}=0$，$d_{n+1}=d_n+1 \\Rightarrow d_3=3$。", "$d_0=\\dim\\mathbb{C}=0$ and $d_{n+1}=d_n+1$ imply $d_3=3$."),
            reason: text("finSuccEquiv 把 $n+1$ 元形式幂级数写成 $n$ 元环上的一元形式幂级数，逐次代入前一行。", "finSuccEquiv writes $n+1$-variable formal power series as one-variable series over the $n$-variable ring, allowing repeated application of the preceding formula."),
          },
        ],
        next: { zh: '三维条件已确定；接着把完备性使用的理想识别为真正的极大理想。', en: 'With dimension fixed, identify the ideal governing completeness with the actual maximal ideal.' },
        evidence: {
          theorems: ['OAI.SmallCM.powerseries_dim', 'OAI.SmallCM.mvPowerSeries_dim', 'OAI.SmallCM.mvPowerSeries_three_dim'],
          taskIds: ['initial_goal_1'], checkIds: ['check-73969943b30b55dacdb8'],
          source: { name: 'Submission.lean', line: 13, endLine: 34 },
        },
      },
      {
        id: 'identify-the-completion-ideal',
        title: { zh: '变量生成的理想就是极大理想', en: 'The variables generate the maximal ideal' },
        given: { zh: '有限多个变量、系数域 $k$；幂级数环在变量生成的理想下已有进完备实例。', en: 'There are finitely many variables over a field $k$, and the power-series ring has an adic-completeness instance for the ideal generated by the variables.' },
        claim: { zh: '$\\mathfrak{m}=(X_i : i\\in\\sigma)$，所以幂级数环关于其极大理想进完备；三元复系数环也满足这一性质。', en: 'Its maximal ideal is $\\mathfrak{m}=(X_i : i\\in\\sigma)$, so the ring is complete for its maximal ideal, in particular in the three-variable complex case.' },
        because: {
          zh: '证明把幂级数环与多项式环的原点理想进完备化对应起来：多项式常数项映射满射到域 $k$，核为变量理想，所以该理想极大。其在完备化中的像仍极大；拉回到局部幂级数环后，由极大理想唯一性得到 $\\mathfrak{m}=(X_i)$。随后直接把既有完备性实例沿这个理想等式改写。',
          en: 'The proof identifies power series with the completion of the polynomial ring at its origin ideal. The polynomial constant map is onto $k$ with kernel the variable ideal, so that ideal is maximal. Its image in the completion is maximal; transporting back and using uniqueness in a local ring gives $\\mathfrak{m}=(X_i)$. Rewriting this equality applies the existing completeness instance.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("在 $k[\\sigma]$ 中，$I=(X_i)=\\ker(\\mathrm{constantCoeff})$，且 $k[\\sigma]/I\\cong k$。", "In $k[\\sigma]$, $I=(X_i)=\\ker(\\mathrm{constantCoeff})$, and $k[\\sigma]/I\\cong k$."),
            reason: text("多项式常数项为 $0$ 恰好表示每个单项式都含变量；常数多项式给出满射，所以商环就是系数域。", "A polynomial has zero constant coefficient exactly when its monomials all contain variables. Constants give surjectivity, identifying the quotient with the coefficient field."),
          },
          {
            statement: text("$k$ 是域 $\\Rightarrow I$ 极大；$I$ 在 $I$-进完备化中的像仍极大。", "Since $k$ is a field, $I$ is maximal; its image in the $I$-adic completion remains maximal."),
            reason: text("这里使用有限变量使 $I$ 有限生成，再调用完备化中的极大理想保持定理。", "Finitely many variables make $I$ finitely generated, allowing the maximal-ideal theorem for the completion."),
          },
          {
            statement: text("经 $k\\llbracket\\sigma\\rrbracket\\cong$ 完成环拉回，得到 $\\mathfrak{m}=(X_i)$，故关于 $\\mathfrak{m}$ 进完备。", "Transporting along $k\\llbracket\\sigma\\rrbracket\\cong$ the completion gives $\\mathfrak{m}=(X_i)$, hence $\\mathfrak{m}$-adic completeness."),
            reason: text("拉回的变量理想已经极大；局部环只有一个极大理想。用此等式改写已有的变量理想进完备实例。", "The transported variable ideal is maximal, and the local ring has a unique maximal ideal. Rewrite the existing variable-ideal completeness instance by this equality."),
          },
        ],
        next: { zh: '同一个常数项映射还将给出剩余域恰为系数域。', en: 'The constant-coefficient map also identifies the residue field with the coefficient field.' },
        evidence: {
          theorems: ['OAI.SmallCM.IsLocalRing.maximalIdeal_eq_span_vars', 'OAI.SmallCM.mvPowerSeries_complete', 'OAI.SmallCM.mvPowerSeries_three_complete'],
          taskIds: ['initial_goal_1'], checkIds: ['check-73969943b30b55dacdb8'],
          source: { name: 'Submission.lean', line: 71, endLine: 84 },
        },
      },
      {
        id: 'identify-the-residue-field',
        title: { zh: '每个剩余类都等于一个常数的剩余类', en: 'Every residue class is the class of a constant' },
        given: { zh: '$R=\\mathbb{C}\\llbracket X_0,\\dots,X_{n-1}\\rrbracket$，常数项映射满射到 $\\mathbb{C}$，其核为 $\\mathfrak{m}$。', en: 'Let $R=\\mathbb{C}\\llbracket X_0,\\dots,X_{n-1}\\rrbracket$. The constant-coefficient map is onto $\\mathbb{C}$ and has kernel $\\mathfrak{m}$.' },
        claim: { zh: '自然映射 $\\mathbb{C}\\to R/\\mathfrak{m}$ 是双射。', en: 'The natural map $\\mathbb{C}\\to R/\\mathfrak{m}$ is bijective.' },
        because: {
          zh: '域 $\\mathbb{C}$ 到非零剩余域的环同态单射。对任意剩余类，先选代表元 $f$，再令 $c=f$ 的常数项；$f-C(c)$ 的常数项为 $0$，故属于 $\\mathfrak{m}$，所以 $[f]=[C(c)]$。这证明满射。',
          en: 'A ring map from the field $\\mathbb{C}$ to the nonzero residue field is injective. For surjectivity, represent a residue class by $f$ and let $c$ be its constant coefficient. The difference $f-C(c)$ has zero constant coefficient, lies in $\\mathfrak{m}$, and gives $[f]=[C(c)]$.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("$\\mathrm{constantCoeff}:R\\to\\mathbb{C}$ 满射，且 $\\ker(\\mathrm{constantCoeff})=\\mathfrak{m}$。", "$\\mathrm{constantCoeff}:R\\to\\mathbb{C}$ is surjective and $\\ker(\\mathrm{constantCoeff})=\\mathfrak{m}$."),
            reason: text("每个 $c\\in\\mathbb{C}$ 都由常数级数 $C(c)$ 映到；满射到域的核在局部环中就是唯一极大理想。", "Every $c\\in\\mathbb{C}$ is the image of the constant series $C(c)$. The kernel of this surjection to a field is the unique maximal ideal of the local ring."),
          },
          {
            statement: text("对任意 $f\\in R$，$\\mathrm{constantCoeff}(f-C(f_0))=f_0-f_0=0$。", "For every $f\\in R$, $\\mathrm{constantCoeff}(f-C(f_0))=f_0-f_0=0$."),
            reason: text("因此 $f-C(f_0)\\in\\mathfrak{m}$，任意剩余类 $[f]$ 都等于 $[C(f_0)]$，证明 $\\mathbb{C}\\to R/\\mathfrak{m}$ 满射。", "Thus $f-C(f_0)\\in\\mathfrak{m}$ and every residue class $[f]$ equals $[C(f_0)]$, proving surjectivity of $\\mathbb{C}\\to R/\\mathfrak{m}$."),
          },
          {
            statement: text("$\\mathbb{C}\\to R/\\mathfrak{m}$ 单射且满射，因此双射。", "The map $\\mathbb{C}\\to R/\\mathfrak{m}$ is injective and surjective, hence bijective."),
            reason: text("单射性来自系数域到非零剩余域的保单位环同态；与刚得到的满射性配对。", "A unital ring map from the field $\\mathbb{C}$ to the nonzero residue field is injective. Pair this with the surjectivity just proved."),
          },
        ],
        next: { zh: '还需证明整闭性；关键是把分式域中的整性约束降到每个幂级数系数。', en: 'It remains to establish integral closedness by descending integrality to power-series coefficients.' },
        evidence: {
          theorems: ['OAI.SmallCM.mvPowerSeries_ker_constantCoeff_maximal', 'OAI.SmallCM.mvPowerSeries_residue_bijective'],
          taskIds: ['initial_goal_1'], checkIds: ['check-73969943b30b55dacdb8'],
          source: { name: 'Submission.lean', line: 85, endLine: 102 },
        },
      },
      {
        id: 'descend-almost-integral-coefficients',
        title: { zh: '逐个取出几乎整幂级数的系数', en: 'Recover the coefficients of an almost-integral series' },
        given: { zh: '$S$ 是 Noether 整闭整环，$K=\\mathrm{Frac}(S)$；$f\\in K\\llbracket X\\rrbracket$ 对 $S\\llbracket X\\rrbracket$ 几乎整。', en: 'Let $S$ be a Noetherian integrally closed domain and $K=\\mathrm{Frac}(S)$. Suppose $f\\in K\\llbracket X\\rrbracket$ is almost integral over $S\\llbracket X\\rrbracket$.' },
        claim: { zh: '$f$ 的每个系数都来自 $S$，因此存在 $a\\in S\\llbracket X\\rrbracket$，其自然像等于 $f$。', en: 'Every coefficient of $f$ comes from $S$, so $f$ is the image of some $a\\in S\\llbracket X\\rrbracket$.' },
        because: {
          zh: '设固定非零分母 $b$ 使 $b f^n$ 都在 $S\\llbracket X\\rrbracket$ 中，$m$ 是 $b$ 的最低非零次数。取 $X^m$ 系数，得到 $b_m f_0^n\\in S$，说明 $f_0$ 对 $S$ 几乎整；Noether 性将其变成整元，整闭性给出 $f_0\\in S$。写 $f-f_0=Xg$，消去各幂中的 $X^n$ 得 $g$ 仍几乎整；重复此过程得到全部系数，再由系数相等重建 $a$。',
          en: 'Choose one nonzero denominator $b$ with $b f^n\\in S\\llbracket X\\rrbracket$ for all $n$, and let $m$ be the lowest nonzero degree of $b$. The $X^m$ coefficient gives $b_m f_0^n\\in S$, so $f_0$ is almost integral over $S$. Noetherianity makes it integral and integral closedness gives $f_0\\in S$. Write $f-f_0=Xg$; cancelling $X^n$ shows $g$ is still almost integral. Iterate to recover every coefficient and reconstruct $a$ coefficientwise.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("取 $b\\ne 0$，使每个 $n$ 都有 $b f^n=q_n\\in S\\llbracket X\\rrbracket$；令 $m=\\mathrm{ord}(b)$、$b_m\\ne 0$。", "Choose $b\\ne 0$ with $b f^n=q_n\\in S\\llbracket X\\rrbracket$ for every $n$; put $m=\\mathrm{ord}(b)$, so $b_m\\ne 0$."),
            reason: text("这正是几乎整性的统一分母条件；最低非零系数 $b_m$ 提供一个属于 $S$ 的固定非零分母。", "This is the common-denominator condition for almost integrality. The first nonzero coefficient $b_m$ provides a fixed nonzero denominator in $S$."),
          },
          {
            statement: text("取 $X^m$ 系数：$b_m f_0^n=(q_n)_m\\in S$，故 $f_0\\in S$。", "Taking the $X^m$ coefficient gives $b_m f_0^n=(q_n)_m\\in S$, hence $f_0\\in S$."),
            reason: text("$b$ 在 $m$ 以前的系数全为 $0$，使卷积只剩 $b_m f_0^n$。于是 $f_0$ 对 $S$ 几乎整；Noether 性给出整性，$S$ 整闭再使 $f_0$ 落回 $S$。", "All coefficients of $b$ below $m$ vanish, leaving only $b_m f_0^n$ in the convolution. Thus $f_0$ is almost integral over $S$; Noetherianity makes it integral and integral closedness puts it in $S$."),
          },
          {
            statement: text("写 $f-C(f_0)=Xg$，则 $Xg$ 仍对 $S\\llbracket X\\rrbracket$ 几乎整。", "Write $f-C(f_0)=Xg$; then $Xg$ is still almost integral over $S\\llbracket X\\rrbracket$."),
            reason: text("几乎整元构成子环，减去基环中的常数级数保持几乎整性；常数项为零恰好允许除出一个 $X$。", "Almost-integral elements form a subring, so subtracting a constant series from the base ring preserves the property. Zero constant coefficient allows a factor $X$."),
          },
          {
            statement: text("若 $b(Xg)^n=q_n$，则 $q_n=X^n q_n'$，消去 $X^n$ 得 $b g^n=q_n'\\in S\\llbracket X\\rrbracket$。", "If $b(Xg)^n=q_n$, then $q_n=X^n q_n'$; cancelling $X^n$ gives $b g^n=q_n'\\in S\\llbracket X\\rrbracket$."),
            reason: text("等式使 $q_n$ 在次数 $n$ 以下的系数全为零，所以 $X^n$ 在 $S\\llbracket X\\rrbracket$ 中整除 $q_n$。同一个非零 $b$ 因此也证明 $g$ 几乎整。", "The equality forces all $q_n$ coefficients below degree $n$ to vanish, giving divisibility by $X^n$ within $S\\llbracket X\\rrbracket$. The same nonzero $b$ therefore witnesses almost integrality of $g$."),
          },
          {
            statement: text("反复移位得到 $f_j\\in S$；令 $a=\\sum_j f_j X^j\\in S\\llbracket X\\rrbracket$，则 $a$ 的像等于 $f$。", "Repeated shifts give $f_j\\in S$; the series $a=\\sum_j f_j X^j\\in S\\llbracket X\\rrbracket$ maps to $f$."),
            reason: text("对系数编号归纳，每轮把所需系数移到常数项；最后逐系数相等重建整条形式幂级数。", "Induction on the coefficient index shifts each required coefficient to the constant term. Coefficientwise equality then reconstructs the entire formal series."),
          },
        ],
        next: { zh: '将这个下降结论用于分式域中的任意整元，证明一元幂级数环整闭。', en: 'Apply this descent to an integral element of the fraction field to prove integral closedness in one variable.' },
        evidence: {
          theorems: ['OAI.SmallCM.constantCoeff_almost', 'OAI.SmallCM.almost_div_X', 'OAI.SmallCM.coeff_mem_of_almost', 'OAI.SmallCM.mem_range_of_almost'],
          taskIds: ['initial_goal_1'], checkIds: ['check-73969943b30b55dacdb8'],
          source: { name: 'Submission.lean', line: 103, endLine: 177 },
        },
      },
      {
        id: 'prove-power-series-integral-closedness',
        title: { zh: '把分式域里的整元拉回幂级数环', en: 'Pull integral fraction-field elements back into the ring' },
        given: { zh: '$S$ 满足上一步假设；令 $F=\\mathrm{Frac}(S\\llbracket X\\rrbracket)$、$K=\\mathrm{Frac}(S)$、$B=K\\llbracket X\\rrbracket$、$L=\\mathrm{Frac}(B)$。取 $x\\in F$ 对 $S\\llbracket X\\rrbracket$ 整。', en: 'Under the same hypotheses let $F=\\mathrm{Frac}(S\\llbracket X\\rrbracket)$, $K=\\mathrm{Frac}(S)$, $B=K\\llbracket X\\rrbracket$ and $L=\\mathrm{Frac}(B)$. Let $x\\in F$ be integral over $S\\llbracket X\\rrbracket$.' },
        claim: { zh: '$x$ 已来自 $S\\llbracket X\\rrbracket$；因此 $S\\llbracket X\\rrbracket$ 整闭。', en: 'Then $x$ comes from $S\\llbracket X\\rrbracket$, proving that $S\\llbracket X\\rrbracket$ is integrally closed.' },
        because: {
          zh: '系数嵌入给出单射 $\\varphi:F\\to L$。$\\varphi(x)$ 对 $B$ 整，而域系数幂级数环 $B$ 整闭，故 $\\varphi(x)$ 来自某个 $f\\in B$。$x$ 的整性提供统一分母，把它沿 $\\varphi$ 传递后得 $f$ 对 $S\\llbracket X\\rrbracket$ 几乎整。上一步给出 $f$ 是 $a\\in S\\llbracket X\\rrbracket$ 的像；$\\varphi$ 的单射性于是将相等式拉回为 $x=a$。',
          en: 'Coefficient inclusion induces an injection $\\varphi:F\\to L$. The image $\\varphi(x)$ is integral over $B$; since power series over a field are integrally closed, $\\varphi(x)$ is represented by some $f\\in B$. Integrality of $x$ supplies a common denominator that transports along $\\varphi$, making $f$ almost integral over $S\\llbracket X\\rrbracket$. The previous step gives $f$ as the image of $a\\in S\\llbracket X\\rrbracket$, and injectivity of $\\varphi$ gives $x=a$ in $F$.',
        },
        dependsOn: ["descend-almost-integral-coefficients"],
        derivation: [
          {
            statement: text("系数嵌入诱导单射 $\\varphi:\\mathrm{Frac}(S\\llbracket X\\rrbracket)\\to\\mathrm{Frac}(K\\llbracket X\\rrbracket)$。", "Coefficient inclusion induces an injection $\\varphi:\\mathrm{Frac}(S\\llbracket X\\rrbracket)\\to\\mathrm{Frac}(K\\llbracket X\\rrbracket)$."),
            reason: text("$S\\to K$ 单射，因此级数逐系数映射单射；分式域的延拓仍为单射，可在最后用来拉回等式。", "$S\\to K$ is injective, so the coefficientwise series map is injective. Its fraction-field extension remains injective and will recover the final equality."),
          },
          {
            statement: text("$x$ 对 $S\\llbracket X\\rrbracket$ 整 $\\Rightarrow \\varphi(x)$ 对 $K\\llbracket X\\rrbracket$ 整 $\\Rightarrow \\varphi(x)=f$，$f\\in K\\llbracket X\\rrbracket$。", "If $x$ is integral over $S\\llbracket X\\rrbracket$, then $\\varphi(x)$ is integral over $K\\llbracket X\\rrbracket$ and equals some $f\\in K\\llbracket X\\rrbracket$."),
            reason: text("把 $x$ 的首一多项式关系沿 $\\varphi$ 映过去并扩大系数环；域系数的一元幂级数环整闭，故像已来自该环。", "Map the monic relation along $\\varphi$ and enlarge the coefficient ring. One-variable power series over a field are integrally closed, so the image is represented in that ring."),
          },
          {
            statement: text("$x$ 的统一分母沿 $\\varphi$ 传给 $f \\Rightarrow f$ 几乎整 $\\Rightarrow f$ 来自 $a\\in S\\llbracket X\\rrbracket$。", "Transport the common denominator of $x$ along $\\varphi$: $f$ is almost integral, hence comes from $a\\in S\\llbracket X\\rrbracket$."),
            reason: text("整元具有几乎整性；将相应的每个幂等式映过去，就满足上一阶段的系数下降条件。", "An integral element is almost integral. Mapping its power relations supplies exactly the coefficient-descent hypotheses from the preceding step."),
          },
          {
            statement: text("$\\varphi(x)=\\varphi(a)$ 且 $\\varphi$ 单射 $\\Rightarrow x=a$。", "$\\varphi(x)=\\varphi(a)$ and injectivity of $\\varphi$ imply $x=a$."),
            reason: text("任取的分式域整元都来自原幂级数环，这正是 $S\\llbracket X\\rrbracket$ 整闭的判定条件。", "Every integral element of its fraction field comes from the power-series ring itself, which is precisely the criterion for integral closedness."),
          },
        ],
        next: { zh: '由零变量的系数域开始，重复这个一元结论即可处理三元环。', en: 'Starting with the coefficient field, iterate the one-variable result to obtain three variables.' },
        evidence: {
          theorems: ['OAI.SmallCM.powerSeries_isIntegrallyClosed', 'OAI.SmallCM.mvPowerSeries_fin_integrallyClosed'],
          taskIds: ['initial_goal_1'], checkIds: ['check-73969943b30b55dacdb8'],
          source: { name: 'Submission.lean', line: 190, endLine: 211 },
        },
      },
      {
        id: 'assemble-the-explicit-witness',
        title: { zh: '选定 R=ℂ⟦X₀,X₁,X₂⟧，逐项交付性质', en: 'Choose R=ℂ⟦X₀,X₁,X₂⟧ and assemble its properties' },
        given: { zh: '维数、极大理想进完备性、剩余域双射以及一元整闭性的保持定理均已证明。', en: 'Dimension, maximal-ideal completeness, residue-field bijectivity and preservation of integral closedness under one power-series variable have been proved.' },
        claim: { zh: '$R=\\mathrm{MvPowerSeries}(\\mathrm{Fin}\\,3,\\mathbb{C})$ 满足目标中全部存在量词和三个最终性质。', en: '$R=\\mathrm{MvPowerSeries}(\\mathrm{Fin}\\,3,\\mathbb{C})$ satisfies all the existentially quantified structures and all three final properties.' },
        because: {
          zh: '从整闭的域 $\\mathbb{C}$ 出发，用 finSuccEquiv 和一元整闭性归纳得到三元整闭性。幂级数环已有交换环、Noether、局部环及 $\\mathbb{C}$-代数实例，且由无零因子性得到整环实例。最后分别代入 mvPowerSeries_three_complete、mvPowerSeries_three_dim、mvPowerSeries_residue_bijective 3。',
          en: 'Starting from the integrally closed field $\\mathbb{C}$, induction with finSuccEquiv and the one-variable result gives integral closedness in three variables. Power series supply the commutative-ring, Noetherian, local-ring and $\\mathbb{C}$-algebra instances; absence of zero divisors supplies the domain instance. The final three goals are exactly mvPowerSeries_three_complete, mvPowerSeries_three_dim and mvPowerSeries_residue_bijective 3.',
        },
        dependsOn: ["compute-the-dimension", "identify-the-completion-ideal", "identify-the-residue-field", "prove-power-series-integral-closedness"],
        derivation: [
          {
            statement: text("$R_0=\\mathbb{C}$ 整闭；$R_{n+1}\\cong R_n\\llbracket X\\rrbracket$，所以 $R_3$ 整闭。", "$R_0=\\mathbb{C}$ is integrally closed, and $R_{n+1}\\cong R_n\\llbracket X\\rrbracket$, so $R_3$ is integrally closed."),
            reason: text("对变量数归纳，每次使用上一阶段的一元整闭性结论；有限元幂级数环同构把结果传回 $R_{n+1}$。", "Induct on the number of variables, applying the one-variable result each time and transporting it through the finite-variable series equivalence."),
          },
          {
            statement: text("取 $R=R_3=\\mathrm{MvPowerSeries}(\\mathrm{Fin}\\,3,\\mathbb{C})$。", "Choose $R=R_3=\\mathrm{MvPowerSeries}(\\mathrm{Fin}\\,3,\\mathbb{C})$."),
            reason: text("该环已有交换环、Noether、局部环与 $\\mathbb{C}$-代数结构；系数域的无零因子性给出整环结构，加上上一行的整闭性。", "This ring already has commutative-ring, Noetherian, local-ring and $\\mathbb{C}$-algebra structures. The coefficient field supplies the domain property, and the preceding line supplies integral closedness."),
          },
          {
            statement: text("$R$ 关于 $\\mathfrak{m}$ 进完备，$\\dim R=3$，且 $\\mathbb{C}\\to R/\\mathfrak{m}$ 双射。", "$R$ is $\\mathfrak{m}$-adically complete, $\\dim R=3$, and $\\mathbb{C}\\to R/\\mathfrak{m}$ is bijective."),
            reason: text("分别取前面三个独立支路在 $n=3$ 时的结论，填入存在见证之后的三个合取目标，完成 candidate_ring_properties。", "Specialize the three independent property branches at $n=3$ and fill the three conjuncts following the existential witness, completing candidate_ring_properties."),
          },
        ],
        next: { zh: '这完成 candidate_ring_properties 的显式存在性证明，见证就是上述三元形式幂级数环。', en: 'This completes candidate_ring_properties with the explicit three-variable formal power-series witness.' },
        evidence: {
          theorems: ['OAI.SmallCM.complex_fin_three_integrallyClosed', 'OAI.SmallCM.candidate_ring_properties'],
          taskIds: ['initial_goal_1'], deliveryIds: ['c9b0cc90-85c3-4a66-8d3c-6b0689618e42'], checkIds: ['check-73969943b30b55dacdb8'],
          source: { name: 'Submission.lean', line: 213, endLine: 232 },
        },
      },
    ],
  },
];
