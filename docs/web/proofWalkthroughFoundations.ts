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
      summary: text('由坐标图假设取得单射展开 θ，并从归一化等式推出 wᵢ≤1/aᵢ，明确紧致性要使用的参数集。', 'Obtain the injective expansion θ from the chart hypotheses and derive wᵢ≤1/aᵢ from normalization, identifying the parameter set for compactness.'),
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
      zh: '在声明中的局部代数、形式 étale 与分式域条件下，对每个严格正的归一化系数 a，证明权重集合 {w ≥ 0 : ∑ᵢ aᵢwᵢ = 1} 对应的 K 上回缩族在逐点评价拓扑中紧致。',
      en: 'Under the stated local-algebra, formally étale and fraction-field hypotheses, prove that the retractions on K indexed by {w ≥ 0 : ∑ᵢ aᵢwᵢ = 1}, for strictly positive a, form a compact set in the topology of pointwise evaluation.',
    },
    notation: {
      zh: 'σ 是有限坐标集；k 是代数闭域；R 是多项式环在原点素理想处的局部化；A 是题设的 Noether 局部整环，K 是其分式域。normalizedWeights a 就是 ∑ᵢ aᵢwᵢ = 1 的非负权重截面。',
      en: 'σ is the finite coordinate set; k is algebraically closed; R localizes the polynomial ring at its origin ideal; A is the specified Noetherian local domain and K its fraction field. normalizedWeights a is the nonnegative section ∑ᵢ aᵢwᵢ = 1.',
    },
    steps: [
      {
        id: 'fix-the-chart-hypotheses',
        title: { zh: '先固定能使用坐标展开的代数条件', en: 'Fix the hypotheses for the chart expansion' },
        given: {
          zh: 'A、R、k、K 满足原声明中的代数塔、局部同态、形式无分歧、有限型与形式 étale 条件；σ 有限，且每个 aᵢ > 0。',
          en: 'A, R, k and K satisfy the declared algebra towers, local-map, formally unramified, essentially finite-type and formally étale conditions; σ is finite and every aᵢ > 0.',
        },
        claim: {
          zh: '要研究的是函数族 w ↦ (x ↦ closedChartFieldRetraction w x)，参数取归一化截面 ∑ᵢ aᵢwᵢ = 1，并保留上述坐标图假设。',
          en: 'The family is w ↦ (x ↦ closedChartFieldRetraction w x), restricted to ∑ᵢ aᵢwᵢ = 1; all the chart hypotheses remain part of the assertion.',
        },
        because: {
          zh: '声明把这些条件作为类型类假设，随后同时传给 closedChartExpansion 和它的单射性证明。严格正的 a 是被调用紧致性引理的显式条件。',
          en: 'The declaration supplies these conditions to closedChartExpansion and its injectivity proof. Strict positivity of a is an explicit input of the compactness lemma used below.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("θ:A→k⟦σ⟧ 是单射。", "θ:A→k⟦σ⟧ is injective."),
            reason: text("把题设的局部代数和形式 étale 条件代入 closedChartExpansion_injective；后面延拓到 K 时正是用这份单射性排除非零元具有无限赋值。", "Apply closedChartExpansion_injective with the declared local-algebra and formally étale hypotheses. This injectivity makes the valuation finite on nonzero elements before extension to K."),
          },
          {
            statement: text("Wₐ={w∈ℝ≥0^σ:Σᵢaᵢwᵢ=1}，且 0≤wᵢ≤1/aᵢ。", "Wₐ={w∈ℝ≥0^σ:Σᵢaᵢwᵢ=1}, with 0≤wᵢ≤1/aᵢ."),
            reason: text("各项 aᵢwᵢ 都非负，所以每项不超过总和 1；再用 aᵢ>0 除过去。这说明为什么严格正的归一化系数能限制每个权重。", "Every term aᵢwᵢ is nonnegative and therefore at most the sum, one. Divide by aᵢ>0. This explains why strict positivity bounds every coordinate."),
          },
          {
            statement: text("要证明紧致的是 F(Wₐ)，F(w)(x)=closedChartFieldRetraction(w)(x)。", "The target is compactness of F(Wₐ), where F(w)(x)=closedChartFieldRetraction(w)(x)."),
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
          zh: '取 θ = closedChartExpansion : A →ₐ[k] k⟦σ⟧，并使用已导入的 closedChartExpansion_injective。',
          en: 'Take θ = closedChartExpansion : A →ₐ[k] k⟦σ⟧ and the imported proof closedChartExpansion_injective.',
        },
        claim: {
          zh: '一般引理给出 {x ↦ expandedFractionValuation θ hθ w x : w ∈ normalizedWeights a} 紧致。',
          en: 'The general lemma yields compactness of {x ↦ expandedFractionValuation θ hθ w x : w ∈ normalizedWeights a}.',
        },
        because: {
          zh: '最终证明直接调用 isCompact_expandedFractionValuation_cone，显式提供 θ、其单射性、a 和 ha。该库引理已封装归一化权重截面的紧致性及赋值的逐点评价连续性。',
          en: 'The final proof directly calls isCompact_expandedFractionValuation_cone with θ, its injectivity proof, a and ha. That library lemma supplies compactness of the normalized weight section and continuity of valuation evaluations.',
        },
        dependsOn: ["fix-the-chart-hypotheses"],
        derivation: [
          {
            statement: text("Wₐ 是有限盒 ∏ᵢ[0,1/aᵢ] 中的闭集，因此紧致。", "Wₐ is a closed subset of the finite box ∏ᵢ[0,1/aᵢ], hence compact."),
            reason: text("坐标上界来自前一步；w↦Σᵢaᵢwᵢ 连续，所以取值为 1 的截面闭。有限个闭有界区间的乘积紧致，闭子集仍紧致。", "The previous step bounds each coordinate. The continuous map w↦Σᵢaᵢwᵢ has a closed level set at one. A finite product of compact intervals is compact, as is its closed subset."),
          },
          {
            statement: text("对非零 p∈A，v_w(p)=min_{d∈Tₚ}Σᵢwᵢdᵢ，其中 Tₚ 有限。", "For nonzero p∈A, v_w(p)=min_{d∈Tₚ}Σᵢwᵢdᵢ for a finite set Tₚ."),
            reason: text("库证明从 θ(p) 的支撑选出有限子集，使每个支撑指数都逐项大于等于其中某个指数。因 wᵢ≥0，剩余指数的权重不可能更小；有限个连续线性权重的最小值仍连续。", "The library selects a finite subset of the support of θ(p) such that every support exponent is at least one selected exponent in each coordinate. Nonnegative weights make the remaining weights no smaller; a finite minimum of continuous linear weights is continuous."),
          },
          {
            statement: text("x=p/q≠0 ⇒ V_w(x)=v_w(p)−v_w(q)，且两项都有限。", "For x=p/q≠0, V_w(x)=v_w(p)−v_w(q), with both values finite."),
            reason: text("q 可取非零，x≠0 又使 p≠0；单射 θ 使拉回赋值在这两个元素上有限。因此这里相减的是实数。", "Choose q≠0; then x≠0 implies p≠0. Injectivity of θ makes the pulled-back values finite, so the subtraction is between real numbers."),
          },
          {
            statement: text("w↦V_w(x) 对每个 x∈K 连续；x=0 时恒为 ⊤。", "For each x∈K, w↦V_w(x) is continuous; for x=0 it is constantly ⊤."),
            reason: text("非零分式使用前一行的两个连续实函数之差；零分式单独使用常函数。逐点评价拓扑下，各坐标连续就给出整个函数族连续。", "For a nonzero fraction use the difference of two continuous real functions; handle zero as a constant function. Coordinatewise continuity gives continuity in the pointwise topology."),
          },
          {
            statement: text("Wₐ 紧致 ⇒ {V_w:w∈Wₐ} 紧致。", "Compactness of Wₐ implies compactness of {V_w:w∈Wₐ}."),
            reason: text("被调用的 isCompact_expandedFractionValuation_cone 正是把归一化截面的紧致性与这个连续映射相接，随后对 θ 和 hθ 实例化。", "The invoked isCompact_expandedFractionValuation_cone takes the continuous image of the compact normalized section, instantiated at θ and hθ."),
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
        given: { zh: '上一步已得到展开赋值在分式域 K 上的紧致函数族。', en: 'The preceding step gives a compact family of expanded valuations on K.' },
        claim: {
          zh: '这恰好是 {x ↦ closedChartFieldRetraction w x : w ∈ normalizedWeights a}，因此目标中的 IsCompact 成立。',
          en: 'This is exactly {x ↦ closedChartFieldRetraction w x : w ∈ normalizedWeights a}, so the required IsCompact statement follows.',
        },
        because: {
          zh: '展开 expandedFractionValuation、closedChartFieldRetraction、closedChartRetraction 后，两边都是将 θ 拉回的单项式赋值延拓到分式域。simpa only 通过这三个定义的相等，把上一步的紧致性直接用于目标函数族。',
          en: 'simpa only unfolds expandedFractionValuation, closedChartFieldRetraction and closedChartRetraction. Both sides extend the monomial valuation pulled back along θ to the fraction field; the main file proves the target by this identification.',
        },
        dependsOn: ["instantiate-the-compact-family"],
        derivation: [
          {
            statement: text("closedChartRetraction(w)=expansionValuation(θ,w)。", "closedChartRetraction(w)=expansionValuation(θ,w)."),
            reason: text("展开局部回缩的定义后，就是沿选定坐标展开 θ 拉回的单项式赋值；参数 w 没有发生变换。", "Unfolding the local retraction gives the monomial valuation pulled back along θ, with the same weight w."),
          },
          {
            statement: text("closedChartFieldRetraction(w)=expandedFractionValuation(θ,hθ,w)。", "closedChartFieldRetraction(w)=expandedFractionValuation(θ,hθ,w)."),
            reason: text("两者再用同一个 fractionValuation 将上一行的局部赋值延拓到 K。最终的 simpa only 只展开这三个定义。", "Both apply the same fractionValuation construction to extend that local valuation to K. The final simpa only unfolds precisely these definitions."),
          },
          {
            statement: text("F(Wₐ)={V_w:w∈Wₐ}，故 IsCompact(F(Wₐ))。", "F(Wₐ)={V_w:w∈Wₐ}, hence IsCompact(F(Wₐ))."),
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
    strategy: text('把具体 max-plus 系统写成两个普通不等式，核对规则只能依次令 w₁=w₂、w₀=1+w₂。归一化后输出成本为 1，而原约束还允许成本为 0 的点，因此这次合法且终止的执行产生了非最优输出。', 'Write the concrete max-plus system as two ordinary inequalities and show the rules force w₁=w₂ followed by w₀=1+w₂. The normalized output costs one, while another point satisfying the original constraints costs zero, so this legal terminating execution is nonoptimal.'),
    stages: [{
      title: text('读出合法反例系统', 'Specify the counterexample system'),
      summary: text('从三列系数读出两条约束与目标 c(w)=w₀，并核对 crossRowRestriction，确定反例满足题设前提。', 'Read the two constraints and objective c(w)=w₀ from the coefficient rows and verify crossRowRestriction, establishing the required hypotheses.'),
      stepIds: ['write-the-concrete-system'],
    }, {
      title: text('跟踪唯一消元路线', 'Follow the forced eliminations'),
      summary: text('第一步代换 w₁=w₂，第二步代换 w₀=1+w₂；同时更新约束与目标，得到无剩余变量的终止状态。', 'Substitute w₁=w₂ and then w₀=1+w₂, updating constraints and objective together until no variables remain and the execution stops.'),
      stepIds: ['force-the-first-elimination', 'force-the-second-elimination'],
    }, {
      title: text('比较两个原可行点', 'Compare two originally feasible points'),
      summary: text('代回得到可行输出 (1,0,0)，再直接核验 (0,−1,0) 也满足原约束；成本 0<1 完成非最优性反例。', 'Reconstruct the feasible output (1,0,0) and verify that (0,−1,0) also satisfies the original constraints. The comparison 0<1 proves nonoptimality.'),
      stepIds: ['reconstruct-the-output', 'exhibit-the-better-point'],
    }],
    goal: {
      zh: '给出满足 crossRowRestriction 的具体 max-plus 系统，证明其执行只能依次消去变量 1、0 并停止，但重建的可行输出成本为 1，另有成本为 0 的可行点。',
      en: 'Exhibit a max-plus system satisfying crossRowRestriction whose forced execution eliminates variables 1 then 0 and stops, while its reconstructed feasible output has cost 1 and another feasible point has cost 0.',
    },
    notation: {
      zh: '⊥ 表示 −∞。线性型的“和”用 max 计算，系数作用是普通加法。可行点 w 满足每行 rhs(w) ≤ lhs(w)。第三坐标 w₂ 是归一化坐标；比较的两个点都取 w₂ = 0。',
      en: '⊥ denotes −∞. Forms evaluate by taking a maximum of coefficient-plus-coordinate terms. Feasibility means rhs(w) ≤ lhs(w) in every row. The third coordinate w₂ is normalized to zero at both comparison points.',
    },
    steps: [
      {
        id: 'write-the-concrete-system',
        title: { zh: '先把三列系数读成两个不等式', en: 'Translate the coefficient rows into two inequalities' },
        given: { zh: '初始两行及目标函数由 initial 固定。', en: 'initial fixes the two rows and the objective.' },
        claim: {
          zh: '约束为 w₂ ≤ max(w₀,w₁)、max(1+w₁,−2+w₂) ≤ w₀，目标为 c(w)=w₀；这个系统还满足题设的 crossRowRestriction。',
          en: 'The constraints are w₂ ≤ max(w₀,w₁) and max(1+w₁,−2+w₂) ≤ w₀, with objective c(w)=w₀. This system also satisfies crossRowRestriction.',
        },
        because: {
          zh: '按 eval 展开，⊥ 项消失，0 系数直接保留坐标。对任意 α，取 w=(0,0,|α|+10)：第一行 lhs=0、另一行 rhs=|α|+8，反向比较的 lhs=0、rhs=|α|+10；α ≥ −|α| 使两项严格交叉不等式都成立。',
          en: 'Expanding eval removes the ⊥ terms. For any α, choose w=(0,0,|α|+10). One cross-row comparison has lhs=0 and rhs=|α|+8; the other has lhs=0 and rhs=|α|+10. Since α ≥ −|α|, both required strict inequalities hold.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("第 0 行：w₂≤max(w₀,w₁)；第 1 行：max(1+w₁,−2+w₂)≤w₀。", "Row 0: w₂≤max(w₀,w₁); row 1: max(1+w₁,−2+w₂)≤w₀."),
            reason: text("eval 对每行取“系数加坐标”的最大值；⊥+w=⊥ 的项不影响最大值，剩下的有限系数直接给出这两式。", "eval takes the maximum of coefficient-plus-coordinate terms. Terms ⊥+w=⊥ disappear from the maximum, leaving the displayed inequalities."),
          },
          {
            statement: text("任取 α，令 w=(0,0,|α|+10)，得 lhs₀=lhs₁=0、rhs₁=|α|+8、rhs₀=|α|+10。", "For arbitrary α, w=(0,0,|α|+10) gives lhs₀=lhs₁=0, rhs₁=|α|+8 and rhs₀=|α|+10."),
            reason: text("第二行 rhs 的另一项为 1，而 |α|+8≥8；因此最大值确为 |α|+8。", "The other term in rhs₁ is one, while |α|+8≥8, so its maximum is indeed |α|+8."),
          },
          {
            statement: text("0<α+|α|+8，且 0<α+|α|+10。", "0<α+|α|+8 and 0<α+|α|+10."),
            reason: text("由 α≥−|α|，两个右端分别至少为 8 和 10。这核对了两种不同行索引的 crossRowRestriction，目标函数则为 c(w)=w₀。", "Since α≥−|α|, the right sides are at least eight and ten. These verify both distinct-row cases of crossRowRestriction; the objective is c(w)=w₀."),
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
        given: { zh: '变量 1 同时有 lower 与 upper 行，是初始系统唯一的 dominating 变量。', en: 'Variable 1 has both a lower row and an upper row and is the only dominating variable initially.' },
        claim: {
          zh: 'eligible(initial,r,j) 当且仅当 (r,j)=(0,1)。其 lowerForm 求值为 w₂；代入后得到 middle：第一行被清理，第二行变成 1+w₂ ≤ w₀，目标仍为 w₀。',
          en: 'eligible(initial,r,j) holds exactly for (r,j)=(0,1). Its lowerForm evaluates to w₂. Substitution yields middle: the first row is removed, the remaining inequality is 1+w₂ ≤ w₀, and the objective remains w₀.',
        },
        because: {
          zh: '只有变量 1 有上界行，而它的 lower 行只有第 0 行，所以 eligible 的 dominating 条件固定了这对索引。将 w₁=w₂ 代入，首行成为 w₂ ≤ max(w₀,w₂)，系数逐项被 lhs 控制而清理；次行右侧 max(1+w₂,−2+w₂)=1+w₂。',
          en: 'Only variable 1 has an upper row, and its only lower row is row 0, fixing the eligible pair. Substituting w₁=w₂ makes the first row w₂ ≤ max(w₀,w₂), so cleanup removes it. The second right side becomes max(1+w₂,−2+w₂)=1+w₂.',
        },
        dependsOn: ["write-the-concrete-system"],
        derivation: [
          {
            statement: text("eligible(initial,r,j) ⇔ (r,j)=(0,1)。", "eligible(initial,r,j) iff (r,j)=(0,1)."),
            reason: text("初始状态只有变量 1 有 upper 行；该变量的 lower 行只有第 0 行，因而规则所需的两个条件共同固定 r、j。", "Only variable 1 has an upper row initially, and its sole lower row is row 0. These eligibility conditions fix both indices."),
          },
          {
            statement: text("lowerForm(initial,0,1)(w)=w₂，所以代换为 w₁=w₂。", "lowerForm(initial,0,1)(w)=w₂, so substitute w₁=w₂."),
            reason: text("该 lowerForm 只有第三列的系数 0 有限；其余两列为 ⊥，求值只剩 0+w₂。", "Only the third-column coefficient zero is finite; the other two coefficients are ⊥, leaving 0+w₂."),
          },
          {
            statement: text("w₂≤max(w₀,w₂) 自动成立；max(1+w₂,−2+w₂)=1+w₂。", "w₂≤max(w₀,w₂) is automatic; max(1+w₂,−2+w₂)=1+w₂."),
            reason: text("第一行被 cleanup 删除；第二行的两个系数比较为 1>−2，所以保留约束 1+w₂≤w₀，得到 middle。", "cleanup removes the first row. In the second row, 1>−2 leaves the single inequality 1+w₂≤w₀, giving middle."),
          },
        ],
        next: { zh: 'middle 只剩变量 0；对这个精确后继状态检查下一步。', en: 'The exact successor middle has only variable 0 remaining; examine its next step.' },
        evidence: {
          theorems: ['OAI.TruffetV4Counterexample.initial_eligible_iff', 'OAI.TruffetV4Counterexample.lowerForm_initial', 'OAI.TruffetV4Counterexample.advance_initial_eq'],
          taskIds: ['initial_goal_1'], checkIds: ['check-e921c5e179d84067ed74'],
          source: { name: 'Submission.lean', line: 259, endLine: 280 },
        },
      },
      {
        id: 'force-the-second-elimination',
        title: { zh: '第二步令 w₀ = 1+w₂ 并终止', en: 'The second elimination sets w₀ = 1+w₂ and terminates' },
        given: { zh: 'middle 只有变量 0 未消去，其唯一 lower 行是第 1 行。', en: 'Only variable 0 remains in middle, with row 1 its sole lower row.' },
        claim: {
          zh: '第二步唯一为 (r,j)=(1,0)。代入 w₀=1+w₂ 后，两行都被清理，目标变成 1+w₂；没有剩余变量，finalState 满足 stop。',
          en: 'The unique second step is (r,j)=(1,0). Substituting w₀=1+w₂ removes both rows and changes the objective to 1+w₂. No variable remains and finalState satisfies stop.',
        },
        because: {
          zh: 'lowerForm_middle 的唯一有限系数为第三列的 1。代回唯一约束得到 1+w₂ ≤ 1+w₂，因而 cleanup 清空它；remaining 同时删去 0。forced_step_initial 与 forced_step_middle 还逐项核对 wellFormed、bounded、未 stop/switch/failure 和代换目标非空等执行前提。',
          en: 'lowerForm_middle has only the finite third-column coefficient 1. Substitution makes the remaining constraint 1+w₂ ≤ 1+w₂, so cleanup removes it and remaining deletes 0. The two forced_step lemmas also verify well-formedness, boundedness, no premature stop/switch/failure and a nonempty substituted objective.',
        },
        dependsOn: ["force-the-first-elimination"],
        derivation: [
          {
            statement: text("middle 的 remaining={0}，唯一 lower 行为 r=1。", "middle has remaining={0}, and its only lower row is r=1."),
            reason: text("第一步删去变量 1；在明确的 middle 系数上检查 lower 条件，只剩第 1 行允许消去变量 0。", "The first step removes variable 1. Checking the explicit middle coefficients leaves row 1 as the only lower row for variable 0."),
          },
          {
            statement: text("lowerForm(middle,1,0)(w)=1+w₂，所以代换 w₀=1+w₂。", "lowerForm(middle,1,0)(w)=1+w₂, so substitute w₀=1+w₂."),
            reason: text("lowerForm 的第三列系数为 1，其余为 ⊥；求最大值后只有这一项。", "Its third-column coefficient is one and the others are ⊥, so this is the only finite term in the maximum."),
          },
          {
            statement: text("1+w₂≤1+w₂，remaining=∅，c_final(w)=1+w₂。", "1+w₂≤1+w₂, remaining=∅ and c_final(w)=1+w₂."),
            reason: text("剩余约束变成恒等不等式而被清理；目标原为 w₀，随同一代换变为 1+w₂。没有剩余变量，stop 成立。", "The remaining inequality is tautological and is removed. The original objective w₀ becomes 1+w₂ under the same substitution. With no variables left, stop holds."),
          },
        ],
        next: { zh: '固定 w₂=0，按两个代回等式得到算法的具体输出。', en: 'Set w₂=0 and reconstruct the output using the two substitution equations.' },
        evidence: {
          theorems: ['OAI.TruffetV4Counterexample.forced_step_initial', 'OAI.TruffetV4Counterexample.forced_step_middle', 'OAI.TruffetV4Counterexample.stop_final'],
          taskIds: ['initial_goal_1'], checkIds: ['check-e921c5e179d84067ed74'],
          source: { name: 'Submission.lean', line: 529, endLine: 550 },
        },
      },
      {
        id: 'reconstruct-the-output',
        title: { zh: '算法输出可行，成本确为 1', en: 'The reconstructed output is feasible and has cost one' },
        given: { zh: '取 output=(1,0,0)，即 w₂=0、w₁=w₂、w₀=1+w₂。', en: 'Take output=(1,0,0), so w₂=0, w₁=w₂ and w₀=1+w₂.' },
        claim: {
          zh: 'output 满足原系统，并且 c_initial(output)=c_final(output)=1；两个 lowerForm 代回等式也都成立。',
          en: 'output satisfies the original system, and c_initial(output)=c_final(output)=1. Both lowerForm reconstruction equalities also hold.',
        },
        because: {
          zh: '原约束化为 0 ≤ max(1,0)=1 和 max(1,−2)=1 ≤ 1。第一步 lowerForm 的值为 0=output₁，第二步为 1=output₀；原目标是 w₀，最终目标是 1+w₂，代入都等于 1。',
          en: 'The constraints reduce to 0 ≤ max(1,0)=1 and max(1,−2)=1 ≤ 1. The two lowerForms evaluate to 0=output₁ and 1=output₀. The initial objective w₀ and final objective 1+w₂ both evaluate to one.',
        },
        dependsOn: ["force-the-first-elimination", "force-the-second-elimination"],
        derivation: [
          {
            statement: text("w₂=0 ⇒ w₁=w₂=0，w₀=1+w₂=1。", "w₂=0 implies w₁=w₂=0 and w₀=1+w₂=1."),
            reason: text("把归一化值代回两步保存的 lowerForm 等式，就得到 output=(1,0,0)。", "Substitute the normalization into the two saved lowerForm equalities to obtain output=(1,0,0)."),
          },
          {
            statement: text("0≤max(1,0)=1；max(1+0,−2+0)=1≤1。", "0≤max(1,0)=1; max(1+0,−2+0)=1≤1."),
            reason: text("这是 output 在两条原约束中的直接代入，因此检查的是原始可行性。", "These are direct substitutions into both original rows, verifying feasibility for the original system."),
          },
          {
            statement: text("c_initial(output)=w₀=1=c_final(output)=1+w₂。", "c_initial(output)=w₀=1=c_final(output)=1+w₂."),
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
        given: { zh: '取 better=(0,−1,0)，仍满足同一个归一化条件 w₂=0。', en: 'Take better=(0,−1,0), with the same normalization w₂=0.' },
        claim: { zh: 'better 对原系统可行，且 c_initial(better)=0 < 1=c_final(output)，所以这次有限终止执行的输出不是最优解。', en: 'better is feasible for the original system and c_initial(better)=0 < 1=c_final(output), so this terminating execution returns a nonoptimal output.' },
        because: {
          zh: '代入两条原约束得到 0 ≤ max(0,−1)=0 和 max(1−1,−2)=0 ≤ 0，目标 w₀=0。两个可行点的严格成本差说明算法输出仍可改进，完成反例。',
          en: 'The original constraints become 0 ≤ max(0,−1)=0 and max(1−1,−2)=0 ≤ 0, while the objective w₀ is zero. The strict comparison between two explicit feasible points proves nonoptimality.',
        },
        dependsOn: ["write-the-concrete-system", "reconstruct-the-output"],
        derivation: [
          {
            statement: text("better=(0,−1,0)：0≤max(0,−1)=0。", "At better=(0,−1,0), 0≤max(0,−1)=0."),
            reason: text("保留同一个归一化 w₂=0，第一条原约束恰好取等号。", "The normalization w₂=0 is unchanged, and the first original constraint holds with equality."),
          },
          {
            statement: text("max(1+(−1),−2+0)=max(0,−2)=0≤w₀=0。", "max(1+(−1),−2+0)=max(0,−2)=0≤w₀=0."),
            reason: text("第二条原约束也成立；这个点不需要满足算法额外选取的代回等式 w₁=w₂。", "The second original constraint also holds. This point need not obey the algorithm’s additional reconstruction choice w₁=w₂."),
          },
          {
            statement: text("c_initial(better)=0<1=c_initial(output)。", "c_initial(better)=0<1=c_initial(output)."),
            reason: text("两点都对同一个原系统可行，而目标只读 w₀；因此严格成本差已经足以反驳输出最优。", "Both points are feasible for the same original system and the objective reads only w₀. Their strict cost gap disproves optimality of the output."),
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
    strategy: text('先证明所有 child 索引严格向前引用，再按旋转、平移与分叉公式重建 616 行。对重建后的有限集合逐行核验包络、深度和四个指定几何输出，最后与放置项总数合成证书正确性。', 'Verify that every child refers to an earlier row, then reconstruct all 616 rows by orientation, translation and forking. Check their finite envelopes, heights and four specified geometric outputs, and combine these with the total placement count to establish certificate correctness.'),
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
      summary: text('将 1,837 个放置项的计数与索引、四个输出、全部行不变量汇合，完成 certificate_correct 的七项结论。', 'Combine the count of 1,837 placements with table validity, the four outputs and all-row invariants to obtain the seven conjuncts of certificate_correct.'),
      stepIds: ['assemble-the-certificate'],
    }],
    goal: {
      zh: '核验 610 条递归表项、1,837 个放置项、四个指定局面的精确几何数据，以及全部 616 个局面的集合关系与深度 ≤ 34。',
      en: 'Verify 610 recursive table entries, 1,837 placements, the exact geometry of four specified rows, and the set invariants and depth bound ≤ 34 for all 616 rows.',
    },
    notation: {
      zh: '格点是 ℤ²，o = (0,0)。每行记为 (A,H,h)：A 是所需格点集，H 是包络，h 是递归高度。六个基础行来自 Snaky 的六个格点；表项索引为 6,…,615。',
      en: 'Cells lie in ℤ² and o = (0,0). A row (A,H,h) contains its required cells, envelope and recursive height. Six base rows come from the six cells of Snaky; table entries have indices 6,…,615.',
    },
    steps: [
      {
        id: 'validate-the-recursion-table',
        title: { zh: '证明每次引用都指向更早的行', en: 'Verify that every reference points to an earlier row' },
        given: { zh: '固定表 table 含按索引排列的 Entry，每项带一个非空的放置列表。', en: 'The fixed table consists of indexed entries, each containing a list of placements.' },
        claim: {
          zh: 'table.size = 610；第 k 项索引为 k+6，放置列表非空，而且每个 child < k+6。',
          en: 'table.size = 610; entry k has index k+6, its placement list is nonempty, and every child index is < k+6.',
        },
        because: {
          zh: 'table_valid_probe 对有限表逐项执行 decide +kernel，证明定义 TableValid 的三个索引条件。严格递减的 child 索引使后续重建可按行号良基递归。',
          en: 'table_valid_probe checks the finite table with decide +kernel and proves the clauses of TableValid. Strictly decreasing child indices support reconstruction by well-founded recursion on row number.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("6+table.size=6+610=616。", "6+table.size=6+610=616."),
            reason: text("前六行是基础图形，其后 610 项依次编号 6,…,615；第 k 个表项的声明索引必须等于 k+6。", "The first six rows are base shapes. The next 610 entries are indexed 6,…,615, and entry k must declare index k+6."),
          },
          {
            statement: text("每个 terms 非空，且每个 t∈terms 满足 t.child<k+6。", "Each terms list is nonempty, with t.child<k+6 for every term t."),
            reason: text("table_valid_probe 在具体有限列表上核对这两个条件；因此 rowAt 引用 child 时总能进入更小的行号。", "table_valid_probe checks both conditions on the concrete lists, so every rowAt child reference moves to a smaller index."),
          },
          {
            statement: text("行 0,…,5 已给定 ⇒ 行 6,…,615 可依次求值。", "Given rows 0,…,5, rows 6,…,615 can be evaluated in order."),
            reason: text("例如 entry₆ 只引用 child 0，entry₇ 只引用 child 4、6；没有当前行或未来行参与自己的定义。", "For example entry₆ refers only to child 0, and entry₇ to children 4 and 6. No row refers to itself or a later row."),
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
          zh: '先对各 child 的 A、H 同时作放置，再令新 A = (⋃Aᵢ ∪ ⋂Hᵢ) ∖ {o}，新 H = {o} ∪ ⋃Hᵢ，新 h = 1 + max hᵢ。',
          en: 'Place each child’s A and H, then set A = (⋃Aᵢ ∪ ⋂Hᵢ) ∖ {o}, H = {o} ∪ ⋃Hᵢ and h = 1 + max hᵢ.',
        },
        because: {
          zh: '这正是 placeRow、commonH、forkRow 与 rowAt 的定义。先从原六格图形写出基础行 0，再把 entry₆ 的四个字段逐一代入：其 child 是行 0、方向为恒等、平移为 (−4,−1)，所以能直接列出新 A、H 与高度 2。me_6 核对这个具体结果，me_615 等后续重建等式再按相同方式使用更早的 child 等式。',
          en: 'These are the definitions of placeRow, commonH, forkRow and rowAt. Start with base row 0 of the six-cell shape, then substitute the four fields of entry₆: child 0, identity orientation and translation (−4,−1). This gives explicit new sets A and H and height 2. The equality me_6 verifies this result; later reconstructions such as me_615 use earlier child equalities in the same way.',
        },
        dependsOn: ["validate-the-recursion-table"],
        derivation: [
          {
            statement: text("S={(0,0),(1,0),(2,0),(3,0),(3,1),(4,1)}；H₀=S，A₀=S∖{o}，h₀=1。", "S={(0,0),(1,0),(2,0),(3,0),(3,1),(4,1)}; H₀=S, A₀=S∖{o}, h₀=1."),
            reason: text("原 Snaky 由 y=0 上的四格和 y=1 上向右错开的两格组成。第 i 个基础行把第 i 格平移到 o，再从所需集删去 o；第 0 格本来就是 o，因此行 0 无须平移。", "The original Snaky has four cells on y=0 and two cells shifted to the right on y=1. Base row i translates its ith cell to o and removes o from its required set. Cell 0 already equals o, so row 0 needs no translation."),
          },
          {
            statement: text("Term.shift=(xDigit−4,yDigit−4)，P(p)=orient(rotation,p)+shift。", "Term.shift=(xDigit−4,yDigit−4), with P(p)=orient(rotation,p)+shift."),
            reason: text("数字字段先解码成整数平移，再用同一个格点放置 P 作用于 child 的 A 和 H；高度保持不变。", "Decode the digit fields as an integer translation, then apply the same placement P to both child sets A and H; preserve the height."),
          },
          {
            statement: text("entry₆=⟨6,[⟨0,0,0,3⟩]⟩ ⇒ child=0，rotation=0，shift=(0−4,3−4)=(−4,−1)。", "entry₆=⟨6,[⟨0,0,0,3⟩]⟩ gives child=0, rotation=0 and shift=(0−4,3−4)=(−4,−1)."),
            reason: text("这是第一条递归表项的实际字段。方向 0 不改变坐标，所以本例的放置就是 P(x,y)=(x−4,y−1)，可直接作用于已知的基础行 0。", "These are the actual fields of the first recursive entry. Orientation 0 is the identity, so its placement is P(x,y)=(x−4,y−1), applied directly to base row 0."),
          },
          {
            statement: text("放置后 H′={(-4,-1),(-3,-1),(-2,-1),(-1,-1),(-1,0),(0,0)}，A′=H′∖{(-4,-1)}，h′=1。", "After placement, H′={(-4,-1),(-3,-1),(-2,-1),(-1,-1),(-1,0),(0,0)}, A′=H′∖{(-4,-1)}, and h′=1."),
            reason: text("对 S 的六个坐标分别减去 (4,1)，得到完整包络。基础行缺少的所需格是 o，平移后缺少的就是 P(o)=(-4,-1)；放置本身保持高度。", "Subtract (4,1) from each of the six coordinates of S to obtain the envelope. The cell omitted from the base required set was o, so the translated omission is P(o)=(-4,-1). Placement preserves height."),
          },
          {
            statement: text("A=(⋃ᵢAᵢ∪⋂ᵢHᵢ)∖{o}，H={o}∪⋃ᵢHᵢ。", "A=(⋃ᵢAᵢ∪⋂ᵢHᵢ)∖{o}, while H={o}∪⋃ᵢHᵢ."),
            reason: text("forkRow 把各 child 的所需点以及共同包络点并入 A，再删去本轮落点 o；H 则保留所有 child 包络和 o。", "forkRow combines child requirements with common-envelope cells, then removes the current move o from A. Its envelope retains all child envelopes and o."),
          },
          {
            statement: text("本例只有一个 child，因此 A₆=(A′∪H′)∖{o}=H′∖{o}={(-4,-1),(-3,-1),(-2,-1),(-1,-1),(-1,0)}，H₆=H′。", "With one child, A₆=(A′∪H′)∖{o}=H′∖{o}={(-4,-1),(-3,-1),(-2,-1),(-1,-1),(-1,0)}, and H₆=H′."),
            reason: text("单个包络的交与并都等于 H′，而 A′⊆H′，所以所需集先补全 H′，再删去父行落点 o。又因 o 已在 H′ 中，插入 o 不改变包络。", "The intersection and union of a single envelope both equal H′, and A′⊆H′. Thus the required set first fills H′ and then removes the parent move o. Since o already belongs to H′, inserting it leaves the envelope unchanged."),
          },
          {
            statement: text("h₆=1+h′=2；一般地 h=1+maxᵢhᵢ，child 等式代入后得到 rowAt(i)=mrᵢ。", "Here h₆=1+h′=2. In general h=1+maxᵢhᵢ, and substituting child equalities gives rowAt(i)=mrᵢ."),
            reason: text("先预留父行的一步，再取最深 child；本例的唯一 child 高度为 1。me_6 确认上面的两个有限集与高度，后续 meᵢ 也把递归公式化成可逐点核验的数据。", "Reserve one move for the parent, then take the deepest child; this sole child has height 1. The equality me_6 confirms both displayed sets and the height. Later meᵢ equalities likewise turn the recursion into data that can be checked point by point."),
          },
        ],
        next: { zh: '行 6 只有一个 child。下一步用实际表项 entry₇ 对照两个 child 的并集、交集和父行。', en: 'Row 6 has one child. Next, use the actual entry₇ to compare two children, their unions and intersection, and the parent row.' },
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
        given: { zh: '行 4 是第 5 个基础行，行 6 已在上一步重建。entry₇ 的两项分别引用它们，方向均为 0。', en: 'Row 4 is the fifth base row, and row 6 was reconstructed above. The two terms of entry₇ refer to them with orientation zero.' },
        claim: { zh: '两个所需集先并成 6 格，共同包络的 4 格已在其中；删去 o 后，A₇ 是 y=−1 上的连续五格，H₇ 有 8 格，h₇=3。', en: 'The required sets unite into six cells, already containing the four common-envelope cells. Removing o leaves five consecutive cells on y=−1 in A₇; H₇ has eight cells and h₇=3.' },
        because: { zh: '把 entry₇ 的数字解码为平移 (−1,0) 与 (1,0)，分别作用于基础行 4 和上一步的行 6。列出两组有限集后，逐点取并集 U 与共同包络 C，得到 C⊆U，因此 forkRow 的所需集只需从 U 删除 o。包络取两个 H 的并集，高度由较深的 child 6 再加一步。me_7 用 me_4、me_6 重写后，核对的正是这些集合与高度。', en: 'Decode the digits of entry₇ as translations (−1,0) and (1,0), applied to base row 4 and the preceding row 6. Taking unions and intersections cell by cell gives the required union U and common envelope C with C⊆U, so forkRow only removes o from U. Unite the two envelopes and add one to the deeper child’s height. After rewriting with me_4 and me_6, me_7 checks these exact sets and height.' },
        dependsOn: ['reconstruct-the-fork'],
        derivation: [
          { statement: text('entry₇=⟨7,[⟨4,0,3,4⟩,⟨6,0,5,4⟩]⟩ ⇒ P₄(x,y)=(x−1,y)，P₆(x,y)=(x+1,y)。', 'entry₇=⟨7,[⟨4,0,3,4⟩,⟨6,0,5,4⟩]⟩ gives P₄(x,y)=(x−1,y) and P₆(x,y)=(x+1,y).'), reason: text('每个数字字段减 4，得到 (3−4,4−4) 与 (5−4,4−4)；方向 0 保持坐标不变。两个 child 索引 4、6 都严格小于 7。', 'Subtract four from each digit pair to obtain (3−4,4−4) and (5−4,4−4). Orientation zero preserves coordinates. Both child indices, 4 and 6, are below 7.') },
          { statement: text('A₄′={(-4,-1),(-3,-1),(-2,-1),(-1,-1),o}，H₄′=A₄′∪{(-1,0)}，h₄′=1。', 'A₄′={(-4,-1),(-3,-1),(-2,-1),(-1,-1),o}, H₄′=A₄′∪{(-1,0)}, h₄′=1.'), reason: text('基础行 4 先把 S 的格 (3,1) 移到 o 并从所需集删去 o，再按本表项向左平移一格。因此新所需集缺少 (-1,0)，但已经包含父行落点 o。', 'Base row 4 moves cell (3,1) of S to o and removes o from its required set. The term then translates it one cell left. Its new required set omits (-1,0) but already contains the parent move o.') },
          { statement: text('A₆′={(-3,-1),(-2,-1),(-1,-1),(0,-1),o}，H₆′=A₆′∪{(1,0)}，h₆′=2。', 'A₆′={(-3,-1),(-2,-1),(-1,-1),(0,-1),o}, H₆′=A₆′∪{(1,0)}, h₆′=2.'), reason: text('将上一步 A₆、H₆ 的每个 x 坐标加一。原来从 A₆ 中删去的 o 移到 (1,0)；平移不改变已经核对的高度 2。', 'Add one to the x coordinate of each cell of A₆ and H₆ from the preceding step. The original omitted o moves to (1,0), while translation preserves the verified height two.') },
          { statement: text('U=A₄′∪A₆′={(-4,-1),(-3,-1),(-2,-1),(-1,-1),(0,-1),o}；C=H₄′∩H₆′={(-3,-1),(-2,-1),(-1,-1),o}⊆U。', 'U=A₄′∪A₆′={(-4,-1),(-3,-1),(-2,-1),(-1,-1),(0,-1),o}; C=H₄′∩H₆′={(-3,-1),(-2,-1),(-1,-1),o}⊆U.'), reason: text('按坐标分别取并集和交集：只有 H₄′ 含 (-1,0)，只有 H₆′ 含 (1,0)。四个共同包络点都已由至少一个 child 列入所需集，所以并入 C 不会新增所需格。', 'Take the union and intersection by coordinates. Only H₄′ contains (-1,0), and only H₆′ contains (1,0). Every common-envelope cell is already required by a child, so adjoining C adds no new required cell.') },
          { statement: text('A₇=(U∪C)∖{o}={(-4,-1),(-3,-1),(-2,-1),(-1,-1),(0,-1)}；H₇=H₄′∪H₆′，|H₇|=8，h₇=1+max(1,2)=3。', 'A₇=(U∪C)∖{o}={(-4,-1),(-3,-1),(-2,-1),(-1,-1),(0,-1)}; H₇=H₄′∪H₆′, |H₇|=8, h₇=1+max(1,2)=3.'), reason: text('C⊆U 使所需集公式化为 U∖{o}。o 已在两个包络中，插入它不会扩大并集；H₇∖A₇ 是 {(-1,0),o,(1,0)} 三格，不能再当作单一缺口。', 'Since C⊆U, the required set reduces to U∖{o}. Both envelopes already contain o, so inserting it does not enlarge their union. H₇∖A₇ consists of three cells, {(-1,0),o,(1,0)}, rather than a single gap.') },
          { statement: text('me_7：rowAt 7=mr_7，其中 mr_7 正是上面列出的 (A₇,H₇,3)。', 'me_7: rowAt 7=mr_7, where mr_7 is exactly the displayed (A₇,H₇,3).'), reason: text('源码展开 entry₇ 的两个放置，再以 me_4、me_6 代入 child 的显式数据，最后对有限集与高度执行内核判定。后续行也沿相同的严格递减索引复用这些等式。', 'The source unfolds the two placements of entry₇, substitutes explicit child data using me_4 and me_6, then checks the finite sets and height by kernel decision. Later rows reuse such equalities along the same decreasing indices.') },
        ],
        next: { zh: '单 child 与双 child 的重建都化成了明确数据；接下来按同样方式对全部 616 行核对集合关系和高度。', en: 'Both the one-child and two-child reconstructions now give explicit data. Check set relations and heights in the same way for all 616 rows.' },
        evidence: { theorems: ['OAI.SnakyCertificate.entry_7', 'OAI.SnakyCertificate.mr_7', 'OAI.SnakyCertificate.me_7'], taskIds: ['initial_goal_1'], checkIds: ['check-b900b20d4968e7ec561d'], source: { name: 'Submission.lean', line: 1543, endLine: 1553 } },
      },
      {
        id: 'verify-all-row-invariants',
        title: { zh: '对全部 616 行核验包络与深度', en: 'Check envelopes and depth for all 616 rows' },
        given: { zh: '每个 rowAt i 已有对应的显式重建行 mrᵢ，0 ≤ i < 616。', en: 'Each rowAt i has an explicit reconstructed row mrᵢ, for 0 ≤ i < 616.' },
        claim: {
          zh: '每行均满足 Aᵢ ⊆ Hᵢ、o ∈ Hᵢ、o ∉ Aᵢ 和 hᵢ ≤ 34。',
          en: 'Every row satisfies Aᵢ ⊆ Hᵢ, o ∈ Hᵢ, o ∉ Aᵢ and hᵢ ≤ 34.',
        },
        because: {
          zh: 'mvᵢ 对各显式有限集证明这四项条件；memo_allRows 对 i 做 interval_cases，先用 meᵢ 重写，再引用相应 mvᵢ，将四项条件推广到表中全部行。',
          en: 'Each mvᵢ proves the four conditions for its explicit finite sets. memo_allRows splits every possible i with interval_cases, rewrites using meᵢ and applies mvᵢ, covering all rows.',
        },
        dependsOn: ["reconstruct-the-fork", "reconstruct-two-children"],
        derivation: [
          {
            statement: text("Aᵢ⊆Hᵢ：对显式 mrᵢ 的每个所需点检查包络成员关系。", "Aᵢ⊆Hᵢ: check envelope membership for every required cell of explicit mrᵢ."),
            reason: text("各 mvᵢ 对重建有限集直接判定包含关系；meᵢ 再把这一结论传回递归定义的 rowAt i。", "Each mvᵢ decides containment on the reconstructed finite sets, and meᵢ transfers the result back to rowAt i."),
          },
          {
            statement: text("o∈Hᵢ，o∉Aᵢ，hᵢ≤34。", "o∈Hᵢ, o∉Aᵢ and hᵢ≤34."),
            reason: text("前两项分别检查中心落点位于包络、未预先列入所需点；高度界检查的是同一行记录中的整数高度。", "The first two checks place the current move in the envelope and outside the prior requirements; the height bound checks the integer stored in that same row."),
          },
          {
            statement: text("∀i<616，上述四项同时成立。", "All four properties hold for every i<616."),
            reason: text("memo_allRows 穷尽 0,…,615，分别重写为 mrᵢ 并调用 mvᵢ，因此这里覆盖六个基础行及全部 610 个表项。", "memo_allRows enumerates 0,…,615, rewrites to mrᵢ and applies mvᵢ. It therefore covers all six base rows and all 610 table entries."),
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
        given: { zh: 'Output i p s h E 表示 Aᵢ = {p}、|Hᵢ| = s、高度 h，且 Hᵢ 与 E 不相交。', en: 'Output i p s h E states Aᵢ = {p}, |Hᵢ| = s, height h, and disjointness of Hᵢ from E.' },
        claim: {
          zh: '行 557、595、603 的所需点均为 (−1,0)，(大小,高度) 分别为 (118,19)、(222,27)、(275,27)；行 615 为 A = {(1,0)}、|H| = 686、高度 34，且 (1,−1) ∉ H。前三行还分别避开目标所列的三个半平面交集或射线。',
          en: 'Rows 557, 595 and 603 require (−1,0), with (size,height) = (118,19), (222,27), (275,27). Row 615 has A = {(1,0)}, |H| = 686, height 34 and (1,−1) ∉ H. The first three rows also avoid the three specified regions.',
        },
        because: {
          zh: '最终证明用 me_557、me_595、me_603、me_615 重写 Output。单点集、基数和高度由有限判定证明；避让条件由 mo_557、mo_595、mo_603、mo_615 转成集合不相交。',
          en: 'The final proof rewrites Output with me_557, me_595, me_603 and me_615. Finite decision proofs establish the singleton, cardinality and height clauses; mo_557, mo_595, mo_603 and mo_615 establish disjointness.',
        },
        dependsOn: ["reconstruct-the-fork"],
        derivation: [
          {
            statement: text("557:(A,|H|,h)=({(−1,0)},118,19)；595:({(−1,0)},222,27)。", "557:(A,|H|,h)=({(−1,0)},118,19); 595:({(−1,0)},222,27)."),
            reason: text("将两行的 me 等式代入 Output 后，分别核对所需点、有限集基数和高度；避让区域分别为 x≤−3且y≤−2，以及 x=−2且y≤−2。", "After rewriting Output with the two me equalities, check the required point, cardinality and height. The omitted regions are x≤−3 with y≤−2, and x=−2 with y≤−2, respectively."),
          },
          {
            statement: text("603:(A,|H|,h)=({(−1,0)},275,27)，且 H∩{x≤−3,y=0}=∅。", "603:(A,|H|,h)=({(−1,0)},275,27), with H∩{x≤−3,y=0}=∅."),
            reason: text("前面三个数值由显式集合判定；mo_603 对包络中的每一点排除所列射线，形成 Output 的第四项。", "The explicit set decides the three values. mo_603 excludes the specified ray for every envelope cell, supplying the fourth Output clause."),
          },
          {
            statement: text("615:(A,|H|,h)=({(1,0)},686,34)，且 (1,−1)∉H。", "615:(A,|H|,h)=({(1,0)},686,34), and (1,−1)∉H."),
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
        given: { zh: '表项有效、四个 Output 已证，AllRows 覆盖全部 616 行。', en: 'The table is valid, the four Output statements hold, and AllRows covers all 616 rows.' },
        claim: { zh: 'placementCount = 1837，且 certificate_correct 的全部七个合取项同时成立。', en: 'placementCount = 1837 and all seven conjuncts of certificate_correct hold together.' },
        because: {
          zh: 'placementCount 是固定表中各 terms 长度之和，最终 proof 的 decide +kernel 计算并证明该和；refine 将它与 table_valid_probe、四个几何结论和 memo_allRows 组装。',
          en: 'placementCount sums the lengths of the fixed entries’ term lists. decide +kernel proves that sum; refine combines it with table_valid_probe, the four geometric outputs and memo_allRows.',
        },
        dependsOn: ["validate-the-recursion-table", "verify-all-row-invariants", "check-the-distinguished-rows"],
        derivation: [
          {
            statement: text("placementCount=Σₖ<610 length(table[k].terms)=1837。", "placementCount=Σₖ<610 length(table[k].terms)=1837."),
            reason: text("计数对象是放置项，不是不同格点或不同 child；同一 child 出现于两个放置时按两项计数。", "The count is of placement terms, not distinct cells or child indices. Two placements of the same child count separately."),
          },
          {
            statement: text("TableValid ∧ count=1837 ∧ Output₅₅₇ ∧ Output₅₉₅ ∧ Output₆₀₃ ∧ Output₆₁₅ ∧ AllRows。", "TableValid ∧ count=1837 ∧ Output₅₅₇ ∧ Output₅₉₅ ∧ Output₆₀₃ ∧ Output₆₁₅ ∧ AllRows."),
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
    strategy: text('把不存在种子的假设改写为每个 totient 值的最小原像满足 ℓ(d)≤kd。这个上界一方面与计数所需的严格不等式冲突，另一方面使两个截断商都等于 1，因此计数与极限权重分别归零。', 'Rewrite the no-seed hypothesis as ℓ(d)≤kd for every totient value. This bound contradicts the strict counting condition and makes both truncated quotients equal one, so the count and the limiting weighted quantity vanish in separate branches.'),
    stages: [{
      title: text('取得共同原像上界', 'Obtain the common preimage bound'),
      summary: text('由种子不存在推出 ℓ(d)≤kd，并确认 d 与 ℓ(d) 都为正，为计数比较和后续除法提供条件。', 'Derive ℓ(d)≤kd from absence of a seed and prove positivity of d and ℓ(d), supplying the conditions for the counting comparison and divisions.'),
      stepIds: ['bound-every-preimage'],
    }, {
      title: text('分别消去计数与权重', 'Eliminate counts and weights separately'),
      summary: text('计数支线得到空集 N(k,x)=0；权重支线得到 0<ℓ(d)/d≤k，使 fₖ 的两个截断值相消为零。', 'The counting branch gives an empty set and N(k,x)=0. The weight branch gives 0<ℓ(d)/d≤k, making the two truncated terms in fₖ cancel.'),
      stepIds: ['empty-the-counting-set', 'cancel-the-weight'],
    }, {
      title: text('把逐项为零传到极限', 'Pass termwise zero to the limit'),
      summary: text('零权重使每个有限阶段 AH 都为零，恒零序列的 limUnder 也为零；与独立的计数结论合并完成原题。', 'Zero weights make every finite-stage AH vanish, so its constant-zero sequence has limUnder zero. Combine this with the separate counting result to finish.'),
      stepIds: ['take-the-zero-limit'],
    }],
    goal: {
      zh: '给定正整数 k，假设不存在 Euler φ 的正整数像 d 满足 kd < ℓ(d)，证明所有 x > 0 都有 N(k,x) = 0，且 0 ≤ s < 1 时 A(fₖ,s) = 0。',
      en: 'For a positive integer k, assume no totient value d has kd < ℓ(d). Prove N(k,x) = 0 for every x > 0 and A(fₖ,s) = 0 for 0 ≤ s < 1.',
    },
    notation: {
      zh: 'IsTotient d 指 d = φ(n)，n > 0；ℓ(d) 是这样的最小 n。N(k,x) 计数 1 ≤ d ≤ ⌊x⌋ 且 kx < ℓ(d) ≤ (k+1)x 的 totient 值。fₖ(r) = min(1,(k+1)/r) − min(1,k/r)。',
      en: 'IsTotient d means d = φ(n) for n > 0; ℓ(d) is the least such n. N(k,x) counts totient values with 1 ≤ d ≤ ⌊x⌋ and kx < ℓ(d) ≤ (k+1)x. fₖ(r) = min(1,(k+1)/r) − min(1,k/r).',
    },
    steps: [
      {
        id: 'bound-every-preimage',
        title: { zh: '把不存在种子改写成逐点上界', en: 'Turn absence of a seed into a pointwise bound' },
        given: { zh: '不存在 d 使 IsTotient d 且 kd < ℓ(d)。', en: 'There is no d with IsTotient d and kd < ℓ(d).' },
        claim: { zh: '对每个 totient 值 d，0 < ℓ(d)、0 < d，且 ℓ(d) ≤ kd。', en: 'For every totient value d, both ℓ(d) and d are positive, and ℓ(d) ≤ kd.' },
        because: {
          zh: '若 ℓ(d) > kd，d 本身就是被排除的种子。ℓ(d) 的正性来自 Nat.find 选出的正整数原像；d 的正性来自 n > 0 时 φ(n) > 0。',
          en: 'A value with ℓ(d) > kd would itself be the excluded seed. Positivity of ℓ(d) follows from its chosen positive preimage; positivity of d follows from φ(n) > 0 for n > 0.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("IsTotient(d) ⇒ ¬(kd<ℓ(d)) ⇒ ℓ(d)≤kd。", "IsTotient(d) implies ¬(kd<ℓ(d)), hence ℓ(d)≤kd."),
            reason: text("如果严格反向不等式成立，取该 d 就构成 hno 所排除的存在见证；自然数全序于是给出非严格上界。", "A strict reverse inequality would make this d a witness forbidden by hno. Total order on ℕ gives the non-strict bound."),
          },
          {
            statement: text("ℓ(d)=Nat.find(hd)>0。", "ℓ(d)=Nat.find(hd)>0."),
            reason: text("hd 提供一个正整数原像；Nat.find 的见证仍满足正性，所以最小原像不会是 0。", "The witness supplied by hd is a positive preimage, and Nat.find preserves this property; the least preimage cannot be zero."),
          },
          {
            statement: text("d=φ(n)，n>0 ⇒ d>0。", "d=φ(n) with n>0 implies d>0."),
            reason: text("由 Nat.totient_pos 取出 d 的正性；后面两次除法分别需要 ℓ(d)>0 和 d>0。", "Nat.totient_pos supplies positivity of d. The divisions below use the separate positivity facts for ℓ(d) and d."),
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
        given: { zh: 'x > 0；若 d 被 N(k,x) 计数，则 d ≤ ⌊x⌋ ≤ x 且 kx < ℓ(d)。', en: 'Let x > 0. A value counted by N(k,x) satisfies d ≤ ⌊x⌋ ≤ x and kx < ℓ(d).' },
        claim: { zh: 'ℓ(d) ≤ kd ≤ kx 与 kx < ℓ(d) 矛盾，所以过滤后的有限集为空，N(k,x) = 0。', en: 'The inequalities ℓ(d) ≤ kd ≤ kx contradict kx < ℓ(d), so the filtered finite set is empty and N(k,x) = 0.' },
        because: {
          zh: 'k ≥ 0，因此把 d ≤ x 乘以 k 保持不等号；hbound 给出前一个不等式。证明用 filter_eq_empty_iff 排除每个候选 d，然后将空集基数化为 0。',
          en: 'Multiplication by k ≥ 0 preserves d ≤ x, while hbound supplies the first inequality. filter_eq_empty_iff excludes each candidate d, and the empty set has cardinality zero.',
        },
        dependsOn: ["bound-every-preimage"],
        derivation: [
          {
            statement: text("d 被计数 ⇒ d≤⌊x⌋₊≤x。", "If d is counted, then d≤⌊x⌋₊≤x."),
            reason: text("第一项来自候选区间 Icc 的右端点；第二项使用 x>0 时自然数下取整不超过 x。", "The first inequality comes from the candidate interval Icc; the second is the natural-floor bound for x>0."),
          },
          {
            statement: text("ℓ(d)≤kd≤kx。", "ℓ(d)≤kd≤kx."),
            reason: text("种子不存在给出第一步；因为 k≥0，把 d≤x 乘以 k 保持不等号方向。", "Absence of a seed gives the first bound. Since k≥0, multiplying d≤x by k preserves the inequality."),
          },
          {
            statement: text("kx<ℓ(d)≤kx 不可能，故 N(k,x)=|∅|=0。", "kx<ℓ(d)≤kx is impossible, so N(k,x)=|∅|=0."),
            reason: text("严格下界恰是过滤条件的另一项；每个候选 d 都被排除后，取空有限集的基数。", "The strict lower bound is another filter condition. Excluding every candidate leaves the empty finite set, whose cardinality is zero."),
          },
        ],
        next: { zh: '另一半结论需要证明定义 A 的每个权重本来就是零。', en: 'For the second conclusion, show that every weight in the definition of A already vanishes.' },
        evidence: {
          theorems: ['OAI.TotientAsymptotic.companion_zero_case'],
          taskIds: ['initial_goal_1'], checkIds: ['check-3e6964827d75e9dcbe53'],
          source: { name: 'Submission.lean', line: 123, endLine: 136 },
        },
      },
      {
        id: 'cancel-the-weight',
        title: { zh: '两个截断商都等于 1', en: 'Both truncated quotients equal one' },
        given: { zh: 'd 是 totient 值；令 r = ℓ(d)/d，上界和正性给出 0 < r ≤ k。', en: 'For a totient value d, set r = ℓ(d)/d. The bounds give 0 < r ≤ k.' },
        claim: { zh: 'k/r ≥ 1 且 (k+1)/r ≥ 1，故 fₖ(r) = 1 − 1 = 0。', en: 'Then k/r ≥ 1 and (k+1)/r ≥ 1, so fₖ(r) = 1 − 1 = 0.' },
        because: {
          zh: 'd > 0 允许把 ℓ(d) ≤ kd 除以 d；r > 0 允许用 one_le_div 改写两个商的不等式。min_eq_left 随即把两个 min 都改写为 1。',
          en: 'Since d > 0, divide ℓ(d) ≤ kd by d; since r > 0, one_le_div gives the two quotient inequalities. min_eq_left then reduces both minima to one.',
        },
        dependsOn: ["bound-every-preimage"],
        derivation: [
          {
            statement: text("r=ℓ(d)/d>0，且 r≤k。", "r=ℓ(d)/d>0 and r≤k."),
            reason: text("分子、分母都正；将 ℓ(d)≤kd 除以正数 d 得到第二式。", "Both numerator and denominator are positive. Divide ℓ(d)≤kd by positive d to obtain the second inequality."),
          },
          {
            statement: text("r≤k≤k+1 ⇒ k/r≥1，(k+1)/r≥1。", "r≤k≤k+1 implies k/r≥1 and (k+1)/r≥1."),
            reason: text("r>0 允许把两条分子下界各除以 r；不需要取任何极限。", "Because r>0, divide both numerator bounds by r. No limiting argument is involved."),
          },
          {
            statement: text("fₖ(r)=min(1,(k+1)/r)−min(1,k/r)=1−1=0。", "fₖ(r)=min(1,(k+1)/r)−min(1,k/r)=1−1=0."),
            reason: text("上一行使两个截断值都固定在 1，因而每个 totient 分支的权重都已精确消失。", "Both truncated values are one by the preceding inequalities, so the weight of each totient branch vanishes exactly."),
          },
        ],
        next: { zh: 'A 的有限阶段求和中，每个 totient 分支都含有这个零因子。', en: 'Every totient branch of the finite-stage expression for A contains this zero factor.' },
        evidence: {
          theorems: ['OAI.TotientAsymptotic.companion_zero_case'],
          taskIds: ['initial_goal_1'], checkIds: ['check-3e6964827d75e9dcbe53'],
          source: { name: 'Submission.lean', line: 107, endLine: 121 },
        },
      },
      {
        id: 'take-the-zero-limit',
        title: { zh: '逐项为零的序列，其极限系数也为零', en: 'Take the limit of the identically zero sequence' },
        given: { zh: 'AH(H,fₖ,s) 的外层求和按 IsTotient d 分支；A(fₖ,s) 定义为 H → ∞ 时 AH 的 limUnder。', en: 'The outer sum in AH(H,fₖ,s) branches on IsTotient d; A(fₖ,s) is its limUnder as H → ∞.' },
        claim: { zh: '对每个 H 都有 AH(H,fₖ,s) = 0，因此 A(fₖ,s) = 0。', en: 'For every H, AH(H,fₖ,s) = 0; hence A(fₖ,s) = 0.' },
        because: {
          zh: 'totient 分支含 fₖ(ℓ(d)/d) = 0，非 totient 分支按定义为 0，所以 finsum 的每一项均为零。之后只使用常零序列收敛与 Tendsto.limUnder_eq，无需分析内层见证集合或更新常数。',
          en: 'A totient branch contains fₖ(ℓ(d)/d) = 0, and a non-totient branch is zero by definition, so every finsum term vanishes. The proof then uses convergence of the constant-zero sequence and Tendsto.limUnder_eq.',
        },
        dependsOn: ["cancel-the-weight"],
        derivation: [
          {
            statement: text("IsTotient(d) 时，fₖ(ℓ(d)/d)/d×内层和=0。", "For IsTotient(d), fₖ(ℓ(d)/d)/d times the inner sum is zero."),
            reason: text("直接使用上一阶段的零权重；内层见证和的值无需另行计算。", "Use the zero weight from the preceding step; the inner witness sum need not be evaluated."),
          },
          {
            statement: text("非 totient 分支按定义为 0，所以对每个 H，AH(H,fₖ,s)=0。", "Non-totient branches are zero by definition, hence AH(H,fₖ,s)=0 for every H."),
            reason: text("两种分支覆盖所有 d，外层 finsum 逐项为 0；再乘定义中的整体因子仍为 0。", "The two cases cover every d, making every outer finsum term zero; multiplying by the overall prefactor still gives zero."),
          },
          {
            statement: text("AH(H,fₖ,s)→0 ⇒ A(fₖ,s)=limUnder AH=0。", "AH(H,fₖ,s)→0, so A(fₖ,s)=limUnder AH=0."),
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
    strategy: text('把每行证书解释为一个威胁：所需格已归 Maker、包络未被 Breaker 占据时即可完成目标。对手一手总会留出一个未受阻的 child，这使递归表与根开局合成为 35 手必胜性，再提取始终选择空格的策略。', 'Interpret each certificate row as a threat that succeeds when Maker owns its required cells and Breaker avoids its envelope. Every reply leaves some child unblocked, so the table and root opening give a 35-move win from which an always-legal policy can be extracted.'),
    stages: [{
      title: text('赋予基础行与分叉语义', 'Interpret base rows and forks'),
      summary: text('缺一个格子的图形是一手威胁；包络交集条件保证对手回复后仍有可用 child，因此分叉也保持威胁语义。', 'A shape missing one cell is a one-move threat. The envelope-intersection condition leaves a usable child after any reply, so forks preserve threat semantics.'),
      stepIds: ['give-base-rows-a-game-meaning', 'choose-an-unblocked-branch'],
    }, {
      title: text('合成空棋盘必胜性', 'Assemble the empty-board win'),
      summary: text('按递减 child 索引解释全部 616 行，再组合 escape 与 24 个根分支，得到从空棋盘出发的 35 手 Winning。', 'Interpret all 616 rows using decreasing child indices, then combine escape with the 24 root branches to obtain Winning in 35 moves from the empty board.'),
      stepIds: ['interpret-the-whole-table', 'close-the-empty-board-opening'],
    }, {
      title: text('提取策略并核对合法性', 'Extract the policy and check legality'),
      summary: text('将 Winning 见证转成始终选空格的策略，逐手维持合法状态；第 35 手完成 Snaky，并与 Breaker 已下的前 34 子不交。', 'Turn Winning witnesses into a policy that always selects a free cell and maintain legal states at each move. Move 35 completes Snaky while remaining disjoint from Breaker’s first 34 cells.'),
      stepIds: ['extract-the-legal-policy'],
    }],
    goal: {
      zh: '构造始终选择空格的 Maker 策略 σ；对最后一手之前所有合法的 Breaker 回复，Maker 在第 35 手时包含一个旋转平移后的 Snaky，且先前各局面与落子数满足精确的合法性结论。',
      en: 'Construct a Maker policy σ that always chooses an unoccupied cell. Against every sequence of legal Breaker replies before the final move, Maker has a rotated and translated Snaky after move 35, with the stated legal-state and cardinality guarantees.',
    },
    notation: {
      zh: 'M、B 分别是双方占据的有限格点集。Winning(G,n,M,B) 表示 Maker 能在接下来的 n 手后达到单调目标 G。Threat(G,A,H,n) 表示：只要 A ⊆ M 且 H ∩ B = ∅，就有 Winning(G,n,M,B)。',
      en: 'M and B are the two occupied finite sets. Winning(G,n,M,B) means Maker can achieve the monotone goal G after n further Maker moves. Threat(G,A,H,n) means A ⊆ M and H ∩ B = ∅ imply Winning(G,n,M,B).',
    },
    steps: [
      {
        id: 'give-base-rows-a-game-meaning',
        title: { zh: '缺一个格子的 Snaky 是一手威胁', en: 'A Snaky missing one cell is a one-move threat' },
        given: { zh: 'S 本身包含一个 Snaky；Maker 已拥有 S ∖ {p}，Breaker 尚未占据 S 中任何格子。', en: 'S contains a Snaky, Maker owns S ∖ {p}, and Breaker occupies no cell of S.' },
        claim: { zh: 'Threat(HasSnaky,S ∖ {p},S,1) 成立，因而六个基础行都有真正的博弈含义。', en: 'Threat(HasSnaky,S ∖ {p},S,1) holds, giving all six base rows a game-theoretic meaning.' },
        because: {
          zh: '若 p 已在 M 中，则 S ⊆ M，目标已达成；否则 p 不在 B 中，Maker 可以合法占据 p，使 S ⊆ M∪{p}。HasSnaky 对集合扩大单调，所以后续落子不破坏目标。',
          en: 'If p is already in M, then S ⊆ M and the goal holds. Otherwise p is absent from B, so Maker can legally claim p and obtain S ⊆ M∪{p}. HasSnaky is preserved when Maker’s set grows.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("p∈M ⇒ S⊆M，因为 S∖{p}⊆M。", "If p∈M, then S⊆M because S∖{p}⊆M."),
            reason: text("S 中等于 p 的点由本分支给出，其余点由威胁的所需点条件给出；此时目标图形已经出现。", "The branch assumption supplies p and the requirement supplies every other cell of S, so the target shape is already present."),
          },
          {
            statement: text("p∉M 且 p∈S ⇒ p∉B，Maker 可落 p，随后 S⊆M∪{p}。", "If p∉M and p∈S, then p∉B; Maker may claim p and obtain S⊆M∪{p}."),
            reason: text("H=S 与 B 不交保证这个缺失格未被对手占据；若 p 根本不在 S 中，S∖{p}=S 已使目标成立。", "Disjointness of H=S from B makes the missing cell legal. If p is not in S at all, S∖{p}=S already gives the goal."),
          },
          {
            statement: text("HasSnaky(M′) 在 M′ 扩大时保持，故可得到精确的一手 Winning。", "HasSnaky(M′) persists when M′ grows, giving the required one-move Winning statement."),
            reason: text("目标已出现时可选择新空格补足这一步；目标尚缺 p 时，落 p 后的任意合法回复都不改变 Maker 已拥有的 S。", "If the goal already holds, a fresh legal cell pads the move. Otherwise claiming p completes S, and any legal reply leaves Maker’s set intact."),
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
          zh: '每个 child 都是 ≤n 手威胁；各 Aᵢ ⊆ A∪{p}、Hᵢ ⊆ H，且 p∈H、⋂Hᵢ ⊆ A∪{p}。假设 A⊆M、H∩B=∅。',
          en: 'Each child is a threat of at most n moves, with Aᵢ ⊆ A∪{p}, Hᵢ ⊆ H, p∈H and ⋂Hᵢ ⊆ A∪{p}. Assume A⊆M and H∩B=∅.',
        },
        claim: { zh: '这些 child 合成一个 n+1 手威胁。', en: 'The children combine into a threat of n+1 moves.' },
        because: {
          zh: '若 p 未在 M 中，先合法落在 p。对手的合法回复 b 不属于 M∪{p}，所以不属于 A∪{p}；由交集条件，至少一个 Hᵢ 不含 b。这个 child 的 Aᵢ 已全部被 Maker 占据，Hᵢ 仍与更新后的 B 不交，可执行其策略。若 p 原已在 M 中，直接选一个 child 并用单调性补足时间。',
          en: 'If p is not already in M, claim it. A legal reply b lies outside M∪{p}, hence outside A∪{p}. The intersection condition gives a child with b∉Hᵢ. Its requirements Aᵢ are now owned and its envelope remains disjoint from Breaker, so its strategy applies. If p was already owned, choose a child immediately and pad the time using monotonicity.',
        },
        dependsOn: ["give-base-rows-a-game-meaning"],
        derivation: [
          {
            statement: text("p∉M ⇒ p∉M∪B，可先合法落 p。", "If p∉M, then p∉M∪B, so claiming p is legal."),
            reason: text("p∈H 而 H∩B=∅ 排除 p∈B；落子后所有 Aᵢ⊆A∪{p}⊆M∪{p} 都已被 Maker 满足。", "p∈H and H∩B=∅ exclude p∈B. After the move, Aᵢ⊆A∪{p}⊆M∪{p} satisfies every child requirement."),
          },
          {
            statement: text("合法回复 b∉M∪{p} ⇒ b∉A∪{p} ⇒ ∃i，b∉Hᵢ。", "A legal reply b∉M∪{p} gives b∉A∪{p}, hence some i has b∉Hᵢ."),
            reason: text("若 b 属于所有 Hᵢ，交集条件会把它放进 A∪{p}，与合法性矛盾。这里选择的 child 可以随对手回复而改变。", "If b belonged to every Hᵢ, the intersection condition would place it in A∪{p}, contradicting legality. The chosen child may depend on the reply."),
          },
          {
            statement: text("Hᵢ∩(B∪{b})=∅，因此该 child 在剩余至多 n 手内完成。", "Hᵢ∩(B∪{b})=∅, so the selected child succeeds in at most n further moves."),
            reason: text("原先 Hᵢ⊆H 已排除旧 B，上一行又排除新点 b；结合已满足的 Aᵢ，就能应用 child 的 Threat。", "The inclusion Hᵢ⊆H excludes the old B, and the previous line excludes b. Together with Aᵢ, these are exactly the selected Threat’s hypotheses."),
          },
          {
            statement: text("若 p∈M，直接取任一 child，再把其高度补到 n+1。", "If p∈M, choose any child and pad its height to n+1."),
            reason: text("此时 Aᵢ 已在 M 中，包络也未受阻；非空 child 列表提供可选分支，目标单调性允许使用 winning_mono_time。", "All Aᵢ are already owned and their envelopes unblocked. The nonempty list supplies a child, and monotonicity permits winning_mono_time."),
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
        given: { zh: 'qTableValid 保证每项非空且 child < 当前行号；六个基础行已是威胁，旋转平移保持 HasSnaky。', en: 'qTableValid gives nonempty entries with child indices below the current row; base rows are threats, and rotations and translations preserve HasSnaky.' },
        claim: { zh: '对全部 i<616，Threat(qGoal,(qr i).A,(qr i).H,(qr i).height) 成立。', en: 'For every i<616, Threat(qGoal,(qr i).A,(qr i).H,(qr i).height) holds.' },
        because: {
          zh: 'qr_threat 对 i 作强归纳。i<6 时调用基础威胁；否则对每个 child 用 child<i 的归纳假设，再以 qplaceRow_threat 旋转平移，最后用 qforkRow_threat 合成父行。目标图形在这些格点双射下保持不变。',
          en: 'qr_threat uses strong induction on i. For i<6 it applies the base threat. Otherwise it applies the induction hypothesis to each child<i, transports that threat with qplaceRow_threat, and combines the children with qforkRow_threat. The goal is invariant under these cell bijections.',
        },
        dependsOn: ["give-base-rows-a-game-meaning", "choose-an-unblocked-branch"],
        derivation: [
          {
            statement: text("i<6：第 i 行是平移后的 S∖{p}，高度为 1。", "For i<6, row i is a translated S∖{p}, with height one."),
            reason: text("基础行把 Snaky 的六个可能缺口逐一移到原点；前面的叶威胁因此覆盖所有基础索引。", "The base rows translate each of Snaky’s six possible missing cells to the origin. The leaf-threat argument covers every base index."),
          },
          {
            statement: text("i≥6：每项 child j<i，先得到 Threat(qGoal,Aⱼ,Hⱼ,hⱼ)。", "For i≥6, every child j<i already has Threat(qGoal,Aⱼ,Hⱼ,hⱼ)."),
            reason: text("强归纳允许直接使用所有较小索引的结论；旋转平移是格点双射，连同 HasSnaky 的图形见证一起搬运该威胁。", "Strong induction supplies all smaller indices. Rotate and translate each threat along a cell bijection, transporting its HasSnaky witness as well."),
          },
          {
            statement: text("把已放置 child 代入 fork：父高度 1+max hⱼ，得到第 i 行的 Threat。", "Fork the placed children at height 1+max hⱼ to obtain the Threat for row i."),
            reason: text("fork 的 A、H 定义正好保证上一阶段所需的包含与交集条件；因此归纳从六个叶行扩展到全部 i<616。", "The fork definitions of A and H supply the required containments and intersection condition. This extends the six leaf cases to every i<616."),
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
          zh: '12 个高度 ≤33 的分支先组成 34 手的 escape 威胁；平移后它只要求 Maker 已占原点。它与关键行的旋转平移共组成 24 个根分支。',
          en: 'Twelve branches of height ≤33 first form a 34-move escape threat; after translation it requires only the origin. Together with placements of the distinguished rows, it forms 24 root branches.',
        },
        claim: { zh: '根分支全部满足 Aᵢ ⊆ {o}、heightᵢ ≤34、⋂Hᵢ ⊆ {o}，所以 Winning(qGoal,35,∅,∅)。', en: 'Every root branch has Aᵢ ⊆ {o} and heightᵢ ≤34, while ⋂Hᵢ ⊆ {o}; hence Winning(qGoal,35,∅,∅).' },
        because: {
          zh: 'qroot_A_bound 与 qroot_child_height 核对所需点和高度；qroot_common_bound 逐点排除原点之外的交集格点。Maker 首手占 o 后，对手合法回复不等于 o，因此总有一个包络未受阻的根分支。上一步给出的 child 策略再用至多 34 手完成，合计 35 手。',
          en: 'qroot_A_bound and qroot_child_height check requirements and heights; qroot_common_bound excludes every non-origin cell from the common envelope. After Maker claims o, any legal reply differs from o, leaving some root envelope unblocked. Its child strategy finishes in at most 34 more moves, giving 35 in total.',
        },
        dependsOn: ["interpret-the-whole-table", "choose-an-unblocked-branch"],
        derivation: [
          {
            statement: text("12 个 child 的高度≤33 ⇒ escape 的高度为 34，所需点为 {(0,−1)}。", "Twelve children of height≤33 yield an escape threat of height 34 requiring {(0,−1)}."),
            reason: text("这些 child 的 A 都在 {(0,−1),o} 内，共同 H 也只可能落在这两个点；在 o 分叉后从所需集删去 o。", "The child requirements and common envelope lie in {(0,−1),o}. Forking at o removes o from the parent requirement."),
          },
          {
            statement: text("将 escape 平移 (0,1)，其所需点变成 {o}。", "Translate escape by (0,1), turning its required set into {o}."),
            reason: text("(0,−1)+(0,1)=o；平移保持威胁和高度，所以它可以和关键行的其他放置一起作为根分支。", "(0,−1)+(0,1)=o. Translation preserves the threat and its height, allowing it to join the placed distinguished rows as a root branch."),
          },
          {
            statement: text("24 个根 child：Aᵢ⊆{o}，hᵢ≤34，⋂Hᵢ⊆{o}。", "The 24 root children satisfy Aᵢ⊆{o}, hᵢ≤34 and ⋂Hᵢ⊆{o}."),
            reason: text("前两项由 qroot_A_bound、qroot_child_height 逐项核对；qroot_common_bound 排除每个原点外的共同包络点。", "qroot_A_bound and qroot_child_height verify the first two clauses; qroot_common_bound excludes all non-origin common-envelope cells."),
          },
          {
            statement: text("Maker 首手取 o ⇒ 任意合法回复后仍有一个 child，故 1+34=35。", "Maker opens at o; some child survives every legal reply, giving 1+34=35."),
            reason: text("对手不能回复 o，因而不能同时落入全部根包络。分叉定理得到所需点为空的 35 手威胁，在空棋盘上即可直接使用。", "The reply cannot be o and therefore cannot belong to every root envelope. The fork theorem yields a 35-move threat with no required cells, applicable from the empty board."),
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
        given: { zh: 'Winning(HasSnaky,35,∅,∅) 已证。对手 β 只需在最后一手之前满足 LegalRepliesBeforeFinal。', en: 'Winning(HasSnaky,35,∅,∅) is established. The opponent β satisfies LegalRepliesBeforeFinal, which requires legality only before the final Maker move.' },
        claim: {
          zh: '存在始终不落入 M∪B 的 σ；任意这样的 β 都使 Maker 第35手后包含 Snaky、恰有35子，且与 Breaker 的前34子不交。每个 k<35 的中间状态双方不交，Breaker 恰有 k 子。',
          en: 'There is a σ that always avoids M∪B. For every such β, Maker has a Snaky and exactly 35 cells after move 35, disjoint from Breaker’s first 34 cells. At every k<35 the two sets are disjoint and Breaker has exactly k cells.',
        },
        because: {
          zh: 'winningPolicy 在有必胜见证时选择其合法落点，否则选一个有限占据集之外的新格。归纳保持第 k 轮后的 Winning(G,35−k,Mₖ,Bₖ)；每次插入新格增加一个基数，并由双方的合法条件保持不交。最终用 ordinary_policy_of_winning 合并这些结论。',
          en: 'winningPolicy chooses a legal move from a winning witness when one exists, otherwise a fresh cell outside the finite occupied sets. Induction preserves Winning(G,35−k,Mₖ,Bₖ); inserting fresh cells increments cardinalities and legal replies preserve disjointness. ordinary_policy_of_winning combines these facts.',
        },
        dependsOn: ["close-the-empty-board-opening"],
        derivation: [
          {
            statement: text("σ(n,M,B) 取 Winning 的合法首手；若无见证，则取 M∪B 外的新格。", "σ(n,M,B) chooses a legal first move from Winning, or a fresh cell outside M∪B when no witness exists."),
            reason: text("棋盘 ℤ² 无限而 M∪B 有限，因此后备落点始终存在。这让 σ 在每个输入局面都有定义并始终合法。", "The board ℤ² is infinite and M∪B finite, so the fallback always exists. Thus σ is defined and legal on every input state."),
          },
          {
            statement: text("对 k<35，维持 Winning(HasSnaky,35−k,Mₖ,Bₖ)。", "For k<35, maintain Winning(HasSnaky,35−k,Mₖ,Bₖ)."),
            reason: text("k=0 来自空棋盘结论；对 k≤33，合法的 βₖ 使 winningPolicy_step 把剩余手数减一。每次双方插入新格，同时保持不交。", "The k=0 case is the empty-board result. For k≤33, legal βₖ lets winningPolicy_step reduce the remaining moves by one, while fresh insertions preserve disjointness."),
          },
          {
            statement: text("k=34 时剩余 1 手；第 35 个 Maker 落点后，HasSnaky(M₃₅)。", "At k=34 one move remains; after Maker’s 35th move, HasSnaky(M₃₅) holds."),
            reason: text("一手 Winning 的结论只取决于插入 Maker 落点后的集合。证明选一个辅助合法回复来读取该结论，不要求实际的 β₃₄ 合法。", "The one-move Winning conclusion depends only on Maker’s updated set. The proof uses an auxiliary fresh legal reply to read it, without assuming legality of the actual β₃₄."),
          },
          {
            statement: text("|M₃₅|=35，M₃₅∩B₃₄=∅；k<35 时 |Bₖ|=k、Mₖ∩Bₖ=∅。", "|M₃₅|=35 and M₃₅∩B₃₄=∅; for k<35, |Bₖ|=k and Mₖ∩Bₖ=∅."),
            reason: text("Maker 总选新格，故每次基数加一；前 34 次合法回复同理。最后一次 Maker 只需避开已经存在的 B₃₄。", "Every Maker move is fresh, increasing its cardinality by one; the first 34 legal replies do likewise. The final Maker move avoids the already existing B₃₄."),
          },
        ],
        next: { zh: '这给出原声明的策略与合法状态结论；最终不交性准确使用 B₃₄，而不要求最后一个无关回复 β₃₄ 合法。', en: 'This gives the exact strategy and legal-state theorem. Final disjointness uses B₃₄, without requiring the irrelevant last reply β₃₄ to be legal.' },
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
    strategy: text('H 与其逐项平方的行正交性分别给出 ∑vₖ=0 和 ∑vₖ²=0。利用 |vₖ|=1 构造只保留 vₖ³=a 分支的逐点恒等式，求和后两个矩消失，再约去 a−b 得到纤维和为零。', 'Row orthogonality of H and its entrywise square gives ∑vₖ=0 and ∑vₖ²=0. Use |vₖ|=1 to build a pointwise identity selecting the branch vₖ³=a; summing kills both moments, and cancelling a−b gives the zero fiber sum.'),
    stages: [{
      title: text('取得两个消失矩', 'Obtain two vanishing moments'),
      summary: text('先把方阵的列正交转为行正交，再对逐项平方重复论证，得到一阶矩与共轭平方矩都为零。', 'Convert column orthogonality of the square matrix to row orthogonality and repeat for its entrywise square, obtaining zero first and conjugate-square moments.'),
      stepIds: ['derive-the-first-moment', 'derive-the-second-moment'],
    }, {
      title: text('构造纤维筛选恒等式', 'Build the fiber-selecting identity'),
      summary: text('单位模长把 v³conj(v)² 化为 v；分别代入立方为 a 或 b，得到只在 a 纤维上保留 (a−b)v 的等式。', 'Unit modulus reduces v³conj(v)² to v. Splitting on cube values a and b gives an identity retaining (a−b)v only on the a-fiber.'),
      stepIds: ['reduce-cubes-using-unit-modulus', 'build-the-fiber-indicator'],
    }, {
      title: text('求和并消去非零因子', 'Sum and cancel the nonzero factor'),
      summary: text('将逐点恒等式求和，两个独立的消失矩使右端为零；a≠b 允许消去公共因子，得到目标行比值的纤维和。', 'Sum the pointwise identity; the two independent vanishing moments make its right side zero. Since a≠b, cancel the common factor to obtain the required row-ratio fiber sum.'),
      stepIds: ['sum-and-cancel'],
    }],
    goal: {
      zh: '设 6×6 矩阵 H 和其逐项平方 H² 都是复 Hadamard 矩阵。取不同两行的比值 vₖ=Hᵢₖ·conj(Hⱼₖ)，若每个 vₖ³ 只可能为两个不同值 a、b，证明 ∑_{vₖ³=a}vₖ=0。',
      en: 'Let H and its entrywise square H² be 6×6 complex Hadamard matrices. For distinct rows let vₖ=Hᵢₖ·conj(Hⱼₖ). If every vₖ³ equals one of two distinct values a,b, prove ∑_{vₖ³=a}vₖ=0.',
    },
    notation: {
      zh: 'H* 表示共轭转置，H² 在本题始终指逐项平方。cubeFiber(v,a)={k : vₖ³=a}。星号 star 在标量上就是复共轭。',
      en: 'H* denotes conjugate transpose; H² here always means entrywise squaring. cubeFiber(v,a)={k : vₖ³=a}. Scalar star is complex conjugation.',
    },
    steps: [
      {
        id: 'derive-the-first-moment',
        title: { zh: '先从列正交得到行正交', en: 'Pass from column orthogonality to row orthogonality' },
        given: { zh: 'Hadamard 定义给出 H*H=6I，且 i≠j。', en: 'The Hadamard definition gives H*H=6I, with i≠j.' },
        claim: { zh: 'HH*=6I，因此 ∑ₖvₖ=0。', en: 'Then HH*=6I, and consequently ∑ₖvₖ=0.' },
        because: {
          zh: '(1/6)H* 是方阵 H 的左逆；mul_eq_one_comm 将它转为右逆，乘回 6 得 HH*=6I。取该矩阵等式的 (i,j) 元，右侧因 i≠j 为0，左侧正是 ∑ₖHᵢₖ·conj(Hⱼₖ)。',
          en: '(1/6)H* is a left inverse of the square matrix H. mul_eq_one_comm makes it a right inverse; multiplying by six gives HH*=6I. Its (i,j) entry is zero on the right because i≠j and is ∑ₖHᵢₖ·conj(Hⱼₖ) on the left.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("L=(1/6)H* ⇒ LH=(1/6)(H*H)=(1/6)·6I=I。", "L=(1/6)H* gives LH=(1/6)(H*H)=(1/6)·6I=I."),
            reason: text("Hadamard 定义提供的是列正交 H*H=6I；6 在复数域可逆，所以可以构造这个左逆。", "The Hadamard definition supplies column orthogonality H*H=6I. Six is invertible in ℂ, giving this left inverse."),
          },
          {
            statement: text("LH=I ⇒ HL=I ⇒ HH*=6I。", "LH=I implies HL=I, hence HH*=6I."),
            reason: text("H 是方阵；源码用 mul_eq_one_comm 把左逆等式交换为右逆等式，再乘回非零标量 6。", "H is square. The source uses mul_eq_one_comm to obtain the right-inverse equality, then multiplies back by the nonzero scalar six."),
          },
          {
            statement: text("i≠j ⇒ (HH*)ᵢⱼ=ΣₖHᵢₖconj(Hⱼₖ)=0，亦即 Σₖvₖ=0。", "i≠j gives (HH*)ᵢⱼ=ΣₖHᵢₖconj(Hⱼₖ)=0, namely Σₖvₖ=0."),
            reason: text("取矩阵等式的不同行列位置；右端 6I 的非对角元为 0，左端按矩阵乘法展开。", "Take the off-diagonal (i,j) entry. The right side 6I is zero there; expanding the left side gives the stated sum."),
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
        claim: { zh: '∑ₖvₖ²=0，取共轭还得到 ∑ₖconj(vₖ)²=0。', en: 'We obtain ∑ₖvₖ²=0, and conjugation gives ∑ₖconj(vₖ)²=0.' },
        because: {
          zh: '平方矩阵的不同行内积为0，而 Hᵢₖ²·conj(Hⱼₖ²)=(Hᵢₖ·conj(Hⱼₖ))²=vₖ²。复共轭保持有限和、平方及0，所以把等式整体取共轭即可得到后一式。',
          en: 'Distinct rows of the squared matrix have zero inner product, and Hᵢₖ²·conj(Hⱼₖ²)=(Hᵢₖ·conj(Hⱼₖ))²=vₖ². Conjugation preserves finite sums, squares and zero, yielding the conjugated identity.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("令 Qᵢₖ=Hᵢₖ²。由 Q*Q=6I 得 QQ*=6I。", "Set Qᵢₖ=Hᵢₖ². From Q*Q=6I obtain QQ*=6I."),
            reason: text("题目对逐项平方矩阵单独给出了 Hadamard 假设；对 Q 使用同样的方阵左右逆论证。", "The entrywise-square matrix has its own Hadamard hypothesis. Apply the same left-to-right inverse argument to Q."),
          },
          {
            statement: text("ΣₖQᵢₖconj(Qⱼₖ)=Σₖ(Hᵢₖconj(Hⱼₖ))²=Σₖvₖ²=0。", "ΣₖQᵢₖconj(Qⱼₖ)=Σₖ(Hᵢₖconj(Hⱼₖ))²=Σₖvₖ²=0."),
            reason: text("i≠j 使 Q 的不同行内积为 0；复共轭保持平方，普通乘法交换使两个平方并成 vₖ²。", "The distinct rows of Q have zero inner product. Conjugation preserves squares, and commutativity combines the squared factors into vₖ²."),
          },
          {
            statement: text("取共轭：Σₖconj(vₖ)²=conj(Σₖvₖ²)=0。", "Conjugating gives Σₖconj(vₖ)²=conj(Σₖvₖ²)=0."),
            reason: text("复共轭保持有限和并把 0 映为 0；最终求和时需要的是这个共轭平方矩。", "Conjugation preserves finite sums and zero. This conjugate-square moment is the one used in the final sum."),
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
        given: { zh: 'H 的每个元素模长为1，故 |vₖ|=1。', en: 'Every entry of H has modulus one, hence |vₖ|=1.' },
        claim: { zh: 'vₖconj(vₖ)=1，进而 vₖ³conj(vₖ)²=vₖ。', en: 'Thus vₖconj(vₖ)=1 and vₖ³conj(vₖ)²=vₖ.' },
        because: {
          zh: '|Hᵢₖ·conj(Hⱼₖ)|=|Hᵢₖ||Hⱼₖ|=1，复数乘共轭等于模长平方。因此 v³conj(v)² = v·(vconj(v))² = v。',
          en: '|Hᵢₖ·conj(Hⱼₖ)|=|Hᵢₖ||Hⱼₖ|=1, and a complex number times its conjugate is its squared modulus. Hence v³conj(v)² = v·(vconj(v))² = v.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("|vₖ|=|Hᵢₖ|·|conj(Hⱼₖ)|=1·1=1。", "|vₖ|=|Hᵢₖ|·|conj(Hⱼₖ)|=1·1=1."),
            reason: text("H 的 Unimodular 条件逐项给出模长 1，且共轭不改变模长。", "The Unimodular hypothesis gives modulus one entrywise, and conjugation preserves modulus."),
          },
          {
            statement: text("vₖconj(vₖ)=|vₖ|²=1。", "vₖconj(vₖ)=|vₖ|²=1."),
            reason: text("复数与其共轭的乘积等于模长平方；这一步不需要 a、b 的立方取值条件。", "A complex number times its conjugate is its squared modulus. This step does not use the two possible cube values a,b."),
          },
          {
            statement: text("vₖ³conj(vₖ)²=vₖ(vₖconj(vₖ))²=vₖ。", "vₖ³conj(vₖ)²=vₖ(vₖconj(vₖ))²=vₖ."),
            reason: text("先按交换结合律重排，再代入上一行的 1；这为下一阶段的两个立方分支提供相同的代换式。", "Rearrange by commutativity and associativity, then substitute one from the preceding identity. Both cube-value cases will use this same equality."),
          },
        ],
        next: { zh: '按 vₖ³=a 或 b 分情况，就能把右侧改造成只保留 a 纤维的表达式。', en: 'Split on vₖ³=a or b to form an expression that retains only the a-fiber.' },
        evidence: {
          theorems: ['OAI.HadamardSix.rowRatio_cubeFiber_sum_zero'],
          taskIds: ['initial_goal_1'], checkIds: ['check-2569016300b5c39ae71c'],
          source: { name: 'Submission.lean', line: 74, endLine: 95 },
        },
      },
      {
        id: 'build-the-fiber-indicator',
        title: { zh: '构造逐点恒等式，筛出 a 纤维', en: 'Construct a pointwise identity selecting the a-fiber' },
        given: { zh: 'a≠b，且每个 vₖ³ 都等于 a 或 b。', en: 'a≠b and every vₖ³ is a or b.' },
        claim: { zh: '对每个 k，1_{vₖ³=a}(a−b)vₖ = a(vₖ−b·conj(vₖ)²)。', en: 'For each k, 1_{vₖ³=a}(a−b)vₖ = a(vₖ−b·conj(vₖ)²).' },
        because: {
          zh: '若 v³=a，上一步给出 a·conj(v)²=v，右边等于 av−bv=(a−b)v。若 v³=b，则 b·conj(v)²=v，右边为0；a≠b 又保证指示条件为假，左边同为0。',
          en: 'If v³=a, the preceding identity gives a·conj(v)²=v, so the right side is av−bv=(a−b)v. If v³=b, then b·conj(v)²=v and the right side is zero; a≠b makes the indicator false, so the left side is also zero.',
        },
        dependsOn: ["reduce-cubes-using-unit-modulus"],
        derivation: [
          {
            statement: text("若 vₖ³=a，则 a·conj(vₖ)²=vₖ。", "If vₖ³=a, then a·conj(vₖ)²=vₖ."),
            reason: text("把 vₖ³=a 代入上一阶段的 vₖ³conj(vₖ)²=vₖ，得到可替换右侧乘积的等式。", "Substitute vₖ³=a into vₖ³conj(vₖ)²=vₖ to obtain the needed replacement."),
          },
          {
            statement: text("a(vₖ−b·conj(vₖ)²)=avₖ−bvₖ=(a−b)vₖ。", "a(vₖ−b·conj(vₖ)²)=avₖ−bvₖ=(a−b)vₖ."),
            reason: text("在 a 纤维上，用前一行把 ab·conj(vₖ)² 改写为 bvₖ；指示函数在此处取 1。", "On the a-fiber, replace ab·conj(vₖ)² by bvₖ using the preceding equality. The indicator is one in this case."),
          },
          {
            statement: text("若 vₖ³=b，则 a(vₖ−b·conj(vₖ)²)=a(vₖ−vₖ)=0。", "If vₖ³=b, then a(vₖ−b·conj(vₖ)²)=a(vₖ−vₖ)=0."),
            reason: text("同一单位模长等式给出 b·conj(vₖ)²=vₖ；a≠b 保证此时不在 a 纤维，所以指示项也为 0。", "The unit-modulus equality now gives b·conj(vₖ)²=vₖ. Since a≠b, this is not the a-fiber, and the indicator term is also zero."),
          },
        ],
        next: { zh: '对 k 求和，右边将只剩两个已知为零的矩。', en: 'Sum over k; the right side becomes a combination of the two vanishing moments.' },
        evidence: {
          theorems: ['OAI.HadamardSix.rowRatio_cubeFiber_sum_zero'],
          taskIds: ['initial_goal_1'], checkIds: ['check-2569016300b5c39ae71c'],
          source: { name: 'Submission.lean', line: 88, endLine: 103 },
        },
      },
      {
        id: 'sum-and-cancel',
        title: { zh: '求和后消去非零因子 a−b', en: 'Sum and cancel the nonzero factor a−b' },
        given: { zh: '逐点纤维恒等式、∑vₖ=0 和 ∑conj(vₖ)²=0 都已成立。', en: 'The pointwise fiber identity and both ∑vₖ=0 and ∑conj(vₖ)²=0 are established.' },
        claim: { zh: '(a−b)∑_{vₖ³=a}vₖ=0，因此 ∑_{vₖ³=a}Hᵢₖ·conj(Hⱼₖ)=0。', en: '(a−b)∑_{vₖ³=a}vₖ=0, hence ∑_{vₖ³=a}Hᵢₖ·conj(Hⱼₖ)=0.' },
        because: {
          zh: '有限求和把右边变为 a(∑vₖ−b∑conj(vₖ)²)=0；左边按 Finset.sum_filter 改写为纤维上的和。复数域无零因子，且 a−b≠0，所以只能是纤维和等于0。',
          en: 'Summation changes the right side into a(∑vₖ−b∑conj(vₖ)²)=0. Finset.sum_filter rewrites the left side as a sum over the fiber. Since ℂ has no zero divisors and a−b≠0, the fiber sum must vanish.',
        },
        dependsOn: ["derive-the-first-moment", "derive-the-second-moment", "build-the-fiber-indicator"],
        derivation: [
          {
            statement: text("(a−b)Σ_{vₖ³=a}vₖ=Σₖ1_{vₖ³=a}(a−b)vₖ。", "(a−b)Σ_{vₖ³=a}vₖ=Σₖ1_{vₖ³=a}(a−b)vₖ."),
            reason: text("把有限过滤求和改成全指标集上的条件求和，再把公共因子移入；这就是 cubeFiber 与 Finset.sum_filter 的展开。", "Expand cubeFiber using Finset.sum_filter and move the common factor inside, turning the filtered sum into a conditional sum over all indices."),
          },
          {
            statement: text("右边= a(Σₖvₖ−bΣₖconj(vₖ)²)=a(0−b·0)=0。", "The right side is a(Σₖvₖ−bΣₖconj(vₖ)²)=a(0−b·0)=0."),
            reason: text("逐项使用前一阶段的恒等式，再分配有限和；两个独立得到的消失矩在这里汇合。", "Apply the pointwise identity, distribute the finite sum, and use the two independently established vanishing moments."),
          },
          {
            statement: text("a−b≠0 ⇒ Σ_{vₖ³=a}vₖ=0。", "Since a−b≠0, Σ_{vₖ³=a}vₖ=0."),
            reason: text("复数域没有零因子，故前一行乘积为 0 时只能消去非零因子 a−b；把 vₖ 换回行比值就得到原目标。", "The field ℂ has no zero divisors, so cancel the nonzero factor a−b. Replacing vₖ by its row-ratio definition gives the target."),
          },
        ],
        next: { zh: '将一般向量 v 重新代为两行的比值，即得到目标定理。', en: 'Substitute the row-ratio vector for v to obtain the target theorem.' },
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
    strategy: text('选 R=ℂ⟦X₀,X₁,X₂⟧，分别计算维数、极大理想进完备性和剩余域。整闭性通过一元幂级数归纳证明：先从统一分母逐个恢复系数，再把分式域中的整元拉回原环，最后汇合这些性质。', 'Choose R=ℂ⟦X₀,X₁,X₂⟧ and separately establish its dimension, maximal-ideal completeness and residue field. Prove integral closedness by adjoining one power-series variable at a time: recover coefficients using a common denominator, pull integral fraction-field elements back into the ring, then assemble the properties.'),
    stages: [{
      title: text('计算维数、完备性与剩余域', 'Compute dimension, completeness and residue field'),
      summary: text('每加一个变量维数增加一；常数项映射识别极大理想与剩余域，分别得到三维、极大理想进完备和剩余域为 ℂ。', 'Each variable adds one to the dimension. The constant-coefficient map identifies the maximal ideal and residue field, giving dimension three, maximal-ideal completeness and residue field ℂ.'),
      stepIds: ['compute-the-dimension', 'identify-the-completion-ideal', 'identify-the-residue-field'],
    }, {
      title: text('证明一元整闭性保持', 'Preserve integral closedness in one variable'),
      summary: text('统一非零分母使每个系数依次落回 S；再借分式域单射把任意整元拉回 S⟦X⟧，证明添一个变量仍整闭。', 'A common nonzero denominator brings each coefficient back to S. An injective fraction-field map then pulls every integral element into S⟦X⟧, preserving integral closedness after one variable.'),
      stepIds: ['descend-almost-integral-coefficients', 'prove-power-series-integral-closedness'],
    }, {
      title: text('选定三元环并汇合性质', 'Choose the three-variable ring and assemble its properties'),
      summary: text('从 ℂ 起迭代一元整闭性结论，取三元幂级数环为见证，再填入前面独立得到的维数、完备性与剩余域结论。', 'Iterate the one-variable integral-closedness result from ℂ, choose the three-variable power-series ring as witness, and combine the separate dimension, completeness and residue-field results.'),
      stepIds: ['assemble-the-explicit-witness'],
    }],
    goal: {
      zh: '构造一个 ℂ-代数 R，证明它是 Noether 局部整环、整闭、关于极大理想进完备、Krull 维数为3，并且 ℂ 到其剩余域的自然映射是双射。最终见证为 R=ℂ⟦X₀,X₁,X₂⟧。',
      en: 'Construct a ℂ-algebra R that is a Noetherian local domain, integrally closed, complete for its maximal ideal, of Krull dimension 3, with a bijective natural map from ℂ to its residue field. The witness is R=ℂ⟦X₀,X₁,X₂⟧.',
    },
    notation: {
      zh: 'S⟦X⟧ 表示一元形式幂级数环，MvPowerSeries(Fin n,ℂ) 表示 n 元形式幂级数环。m 是极大理想；“几乎整”指存在固定非零分母，使所有幂都落回基环。',
      en: 'S⟦X⟧ denotes one-variable formal power series; MvPowerSeries(Fin n,ℂ) denotes n-variable power series. m is the maximal ideal. An almost-integral element has one fixed nonzero denominator clearing all of its powers.',
    },
    steps: [
      {
        id: 'compute-the-dimension',
        title: { zh: '每增加一个幂级数变量，维数增加1', en: 'Each power-series variable adds one to the dimension' },
        given: { zh: 'S 是 Noether 局部环；常数项映射 S⟦X⟧→S 的核为 (X)。', en: 'Let S be a Noetherian local ring. The constant-coefficient map S⟦X⟧→S has kernel (X).' },
        claim: { zh: 'dim S⟦X⟧=dim S+1；递归得到 dim ℂ⟦X₀,…,Xₙ₋₁⟧=n，特别是三元情形维数为3。', en: 'dim S⟦X⟧=dim S+1. Iteration gives dim ℂ⟦X₀,…,Xₙ₋₁⟧=n, and in particular dimension 3 for three variables.' },
        because: {
          zh: 'X 的常数项为0，故不为单位、属于极大理想；X 又不是零因子。非零因子商环的维数定理给出 dim(S⟦X⟧/(X))+1=dim S⟦X⟧。商环经常数项映射同构于 S，再用 finSuccEquiv 把 n+1 元环视为 n 元环上的一元幂级数环。',
          en: 'X has zero constant term, so it is a nonunit in the maximal ideal, and it is a non-zero-divisor. The dimension theorem gives dim(S⟦X⟧/(X))+1=dim S⟦X⟧. The constant-coefficient map identifies the quotient with S; finSuccEquiv then writes n+1 variables as one power-series variable over n variables.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("S⟦X⟧/(X)≅S，且 X∈m、X 不是零因子。", "S⟦X⟧/(X)≅S, with X∈m and X a non-zero-divisor."),
            reason: text("常数项映射满射，核为 (X)；X 的常数项为 0，所以不是单位。乘 X 只是把系数右移，因而不会把非零级数乘成零。", "The surjective constant map has kernel (X). Since X has zero constant term it is a nonunit. Multiplication by X shifts coefficients and cannot annihilate a nonzero series."),
          },
          {
            statement: text("dim S⟦X⟧=dim(S⟦X⟧/(X))+1=dim S+1。", "dim S⟦X⟧=dim(S⟦X⟧/(X))+1=dim S+1."),
            reason: text("将 Noether 局部环中的非零因子商环维数定理应用于 X，再用上一行的商环同构。", "Apply the dimension theorem for quotienting a Noetherian local ring by a non-zero-divisor, then use the quotient isomorphism."),
          },
          {
            statement: text("d₀=dimℂ=0，dₙ₊₁=dₙ+1 ⇒ d₃=3。", "d₀=dimℂ=0 and dₙ₊₁=dₙ+1 imply d₃=3."),
            reason: text("finSuccEquiv 把 n+1 元形式幂级数写成 n 元环上的一元形式幂级数，逐次代入前一行。", "finSuccEquiv writes n+1-variable formal power series as one-variable series over the n-variable ring, allowing repeated application of the preceding formula."),
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
        given: { zh: '有限多个变量、系数域 k；幂级数环在变量生成的理想下已有进完备实例。', en: 'There are finitely many variables over a field k, and the power-series ring has an adic-completeness instance for the ideal generated by the variables.' },
        claim: { zh: 'm=(Xᵢ : i∈σ)，所以幂级数环关于其极大理想进完备；三元复系数环也满足这一性质。', en: 'Its maximal ideal is m=(Xᵢ : i∈σ), so the ring is complete for its maximal ideal, in particular in the three-variable complex case.' },
        because: {
          zh: '证明把幂级数环与多项式环的原点理想进完备化对应起来：多项式常数项映射满射到域 k，核为变量理想，所以该理想极大。其在完备化中的像仍极大；拉回到局部幂级数环后，由极大理想唯一性得到 m=(Xᵢ)。随后直接把既有完备性实例沿这个理想等式改写。',
          en: 'The proof identifies power series with the completion of the polynomial ring at its origin ideal. The polynomial constant map is onto k with kernel the variable ideal, so that ideal is maximal. Its image in the completion is maximal; transporting back and using uniqueness in a local ring gives m=(Xᵢ). Rewriting this equality applies the existing completeness instance.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("在 k[σ] 中，I=(Xᵢ)=ker(constantCoeff)，且 k[σ]/I≅k。", "In k[σ], I=(Xᵢ)=ker(constantCoeff), and k[σ]/I≅k."),
            reason: text("多项式常数项为 0 恰好表示每个单项式都含变量；常数多项式给出满射，所以商环就是系数域。", "A polynomial has zero constant coefficient exactly when its monomials all contain variables. Constants give surjectivity, identifying the quotient with the coefficient field."),
          },
          {
            statement: text("k 是域 ⇒ I 极大；I 在 I-进完备化中的像仍极大。", "Since k is a field, I is maximal; its image in the I-adic completion remains maximal."),
            reason: text("这里使用有限变量使 I 有限生成，再调用完备化中的极大理想保持定理。", "Finitely many variables make I finitely generated, allowing the maximal-ideal theorem for the completion."),
          },
          {
            statement: text("经 k⟦σ⟧≅完成环 拉回，得到 m=(Xᵢ)，故关于 m 进完备。", "Transporting along k⟦σ⟧≅the completion gives m=(Xᵢ), hence m-adic completeness."),
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
        given: { zh: 'R=ℂ⟦X₀,…,Xₙ₋₁⟧，常数项映射满射到 ℂ，其核为 m。', en: 'Let R=ℂ⟦X₀,…,Xₙ₋₁⟧. The constant-coefficient map is onto ℂ and has kernel m.' },
        claim: { zh: '自然映射 ℂ→R/m 是双射。', en: 'The natural map ℂ→R/m is bijective.' },
        because: {
          zh: '域 ℂ 到非零剩余域的环同态单射。对任意剩余类，先选代表元 f，再令 c=f 的常数项；f−C(c) 的常数项为0，故属于 m，所以 [f]=[C(c)]。这证明满射。',
          en: 'A ring map from the field ℂ to the nonzero residue field is injective. For surjectivity, represent a residue class by f and let c be its constant coefficient. The difference f−C(c) has zero constant coefficient, lies in m, and gives [f]=[C(c)].',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("constantCoeff:R→ℂ 满射，且 ker(constantCoeff)=m。", "constantCoeff:R→ℂ is surjective and ker(constantCoeff)=m."),
            reason: text("每个 c∈ℂ 都由常数级数 C(c) 映到；满射到域的核在局部环中就是唯一极大理想。", "Every c∈ℂ is the image of the constant series C(c). The kernel of this surjection to a field is the unique maximal ideal of the local ring."),
          },
          {
            statement: text("对任意 f∈R，constantCoeff(f−C(f₀))=f₀−f₀=0。", "For every f∈R, constantCoeff(f−C(f₀))=f₀−f₀=0."),
            reason: text("因此 f−C(f₀)∈m，任意剩余类 [f] 都等于 [C(f₀)]，证明 ℂ→R/m 满射。", "Thus f−C(f₀)∈m and every residue class [f] equals [C(f₀)], proving surjectivity of ℂ→R/m."),
          },
          {
            statement: text("ℂ→R/m 单射且满射，因此双射。", "The map ℂ→R/m is injective and surjective, hence bijective."),
            reason: text("单射性来自系数域到非零剩余域的保单位环同态；与刚得到的满射性配对。", "A unital ring map from the field ℂ to the nonzero residue field is injective. Pair this with the surjectivity just proved."),
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
        given: { zh: 'S 是 Noether 整闭整环，K=Frac(S)；f∈K⟦X⟧ 对 S⟦X⟧ 几乎整。', en: 'Let S be a Noetherian integrally closed domain and K=Frac(S). Suppose f∈K⟦X⟧ is almost integral over S⟦X⟧.' },
        claim: { zh: 'f 的每个系数都来自 S，因此存在 a∈S⟦X⟧，其自然像等于 f。', en: 'Every coefficient of f comes from S, so f is the image of some a∈S⟦X⟧.' },
        because: {
          zh: '设固定非零分母 b 使 b fⁿ 都在 S⟦X⟧ 中，m 是 b 的最低非零次数。取 Xᵐ 系数，得到 bₘ f₀ⁿ∈S，说明 f₀ 对 S 几乎整；Noether 性将其变成整元，整闭性给出 f₀∈S。写 f−f₀=Xg，消去各幂中的 Xⁿ 得 g 仍几乎整；重复此过程得到全部系数，再由系数相等重建 a。',
          en: 'Choose one nonzero denominator b with b fⁿ∈S⟦X⟧ for all n, and let m be the lowest nonzero degree of b. The Xᵐ coefficient gives bₘ f₀ⁿ∈S, so f₀ is almost integral over S. Noetherianity makes it integral and integral closedness gives f₀∈S. Write f−f₀=Xg; cancelling Xⁿ shows g is still almost integral. Iterate to recover every coefficient and reconstruct a coefficientwise.',
        },
        dependsOn: [],
        derivation: [
          {
            statement: text("取 b≠0，使每个 n 都有 b fⁿ=qₙ∈S⟦X⟧；令 m=ord(b)、bₘ≠0。", "Choose b≠0 with b fⁿ=qₙ∈S⟦X⟧ for every n; put m=ord(b), so bₘ≠0."),
            reason: text("这正是几乎整性的统一分母条件；最低非零系数 bₘ 提供一个属于 S 的固定非零分母。", "This is the common-denominator condition for almost integrality. The first nonzero coefficient bₘ provides a fixed nonzero denominator in S."),
          },
          {
            statement: text("取 Xᵐ 系数：bₘ f₀ⁿ=(qₙ)ₘ∈S，故 f₀∈S。", "Taking the Xᵐ coefficient gives bₘ f₀ⁿ=(qₙ)ₘ∈S, hence f₀∈S."),
            reason: text("b 在 m 以前的系数全为 0，使卷积只剩 bₘ f₀ⁿ。于是 f₀ 对 S 几乎整；Noether 性给出整性，S 整闭再使 f₀ 落回 S。", "All coefficients of b below m vanish, leaving only bₘ f₀ⁿ in the convolution. Thus f₀ is almost integral over S; Noetherianity makes it integral and integral closedness puts it in S."),
          },
          {
            statement: text("写 f−C(f₀)=Xg，则 Xg 仍对 S⟦X⟧ 几乎整。", "Write f−C(f₀)=Xg; then Xg is still almost integral over S⟦X⟧."),
            reason: text("几乎整元构成子环，减去基环中的常数级数保持几乎整性；常数项为零恰好允许除出一个 X。", "Almost-integral elements form a subring, so subtracting a constant series from the base ring preserves the property. Zero constant coefficient allows a factor X."),
          },
          {
            statement: text("若 b(Xg)ⁿ=qₙ，则 qₙ=Xⁿq′ₙ，消去 Xⁿ 得 b gⁿ=q′ₙ∈S⟦X⟧。", "If b(Xg)ⁿ=qₙ, then qₙ=Xⁿq′ₙ; cancelling Xⁿ gives b gⁿ=q′ₙ∈S⟦X⟧."),
            reason: text("等式使 qₙ 在次数 n 以下的系数全为零，所以 Xⁿ 在 S⟦X⟧ 中整除 qₙ。同一个非零 b 因此也证明 g 几乎整。", "The equality forces all qₙ coefficients below degree n to vanish, giving divisibility by Xⁿ within S⟦X⟧. The same nonzero b therefore witnesses almost integrality of g."),
          },
          {
            statement: text("反复移位得到 fⱼ∈S；令 a=ΣⱼfⱼXʲ∈S⟦X⟧，则 a 的像等于 f。", "Repeated shifts give fⱼ∈S; the series a=ΣⱼfⱼXʲ∈S⟦X⟧ maps to f."),
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
        given: { zh: 'S 满足上一步假设；令 F=Frac(S⟦X⟧)、K=Frac(S)、B=K⟦X⟧、L=Frac(B)。取 x∈F 对 S⟦X⟧ 整。', en: 'Under the same hypotheses let F=Frac(S⟦X⟧), K=Frac(S), B=K⟦X⟧ and L=Frac(B). Let x∈F be integral over S⟦X⟧.' },
        claim: { zh: 'x 已来自 S⟦X⟧；因此 S⟦X⟧ 整闭。', en: 'Then x comes from S⟦X⟧, proving that S⟦X⟧ is integrally closed.' },
        because: {
          zh: '系数嵌入给出单射 φ:F→L。φ(x) 对 B 整，而域系数幂级数环 B 整闭，故 φ(x) 来自某个 f∈B。x 的整性提供统一分母，把它沿 φ 传递后得 f 对 S⟦X⟧ 几乎整。上一步给出 f 是 a∈S⟦X⟧ 的像；φ 的单射性于是将相等式拉回为 x=a。',
          en: 'Coefficient inclusion induces an injection φ:F→L. The image φ(x) is integral over B; since power series over a field are integrally closed, φ(x) is represented by some f∈B. Integrality of x supplies a common denominator that transports along φ, making f almost integral over S⟦X⟧. The previous step gives f as the image of a∈S⟦X⟧, and injectivity of φ gives x=a in F.',
        },
        dependsOn: ["descend-almost-integral-coefficients"],
        derivation: [
          {
            statement: text("系数嵌入诱导单射 φ:Frac(S⟦X⟧)→Frac(K⟦X⟧)。", "Coefficient inclusion induces an injection φ:Frac(S⟦X⟧)→Frac(K⟦X⟧)."),
            reason: text("S→K 单射，因此级数逐系数映射单射；分式域的延拓仍为单射，可在最后用来拉回等式。", "S→K is injective, so the coefficientwise series map is injective. Its fraction-field extension remains injective and will recover the final equality."),
          },
          {
            statement: text("x 对 S⟦X⟧ 整 ⇒ φ(x) 对 K⟦X⟧ 整 ⇒ φ(x)=f，f∈K⟦X⟧。", "If x is integral over S⟦X⟧, then φ(x) is integral over K⟦X⟧ and equals some f∈K⟦X⟧."),
            reason: text("把 x 的首一多项式关系沿 φ 映过去并扩大系数环；域系数的一元幂级数环整闭，故像已来自该环。", "Map the monic relation along φ and enlarge the coefficient ring. One-variable power series over a field are integrally closed, so the image is represented in that ring."),
          },
          {
            statement: text("x 的统一分母沿 φ 传给 f ⇒ f 几乎整 ⇒ f 来自 a∈S⟦X⟧。", "Transport the common denominator of x along φ: f is almost integral, hence comes from a∈S⟦X⟧."),
            reason: text("整元具有几乎整性；将相应的每个幂等式映过去，就满足上一阶段的系数下降条件。", "An integral element is almost integral. Mapping its power relations supplies exactly the coefficient-descent hypotheses from the preceding step."),
          },
          {
            statement: text("φ(x)=φ(a) 且 φ 单射 ⇒ x=a。", "φ(x)=φ(a) and injectivity of φ imply x=a."),
            reason: text("任取的分式域整元都来自原幂级数环，这正是 S⟦X⟧ 整闭的判定条件。", "Every integral element of its fraction field comes from the power-series ring itself, which is precisely the criterion for integral closedness."),
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
        claim: { zh: 'R=MvPowerSeries(Fin 3,ℂ) 满足目标中全部存在量词和三个最终性质。', en: 'R=MvPowerSeries(Fin 3,ℂ) satisfies all the existentially quantified structures and all three final properties.' },
        because: {
          zh: '从整闭的域 ℂ 出发，用 finSuccEquiv 和一元整闭性归纳得到三元整闭性。幂级数环已有交换环、Noether、局部环及 ℂ-代数实例，且由无零因子性得到整环实例。最后分别代入 mvPowerSeries_three_complete、mvPowerSeries_three_dim、mvPowerSeries_residue_bijective 3。',
          en: 'Starting from the integrally closed field ℂ, induction with finSuccEquiv and the one-variable result gives integral closedness in three variables. Power series supply the commutative-ring, Noetherian, local-ring and ℂ-algebra instances; absence of zero divisors supplies the domain instance. The final three goals are exactly mvPowerSeries_three_complete, mvPowerSeries_three_dim and mvPowerSeries_residue_bijective 3.',
        },
        dependsOn: ["compute-the-dimension", "identify-the-completion-ideal", "identify-the-residue-field", "prove-power-series-integral-closedness"],
        derivation: [
          {
            statement: text("R₀=ℂ 整闭；Rₙ₊₁≅Rₙ⟦X⟧，所以 R₃ 整闭。", "R₀=ℂ is integrally closed, and Rₙ₊₁≅Rₙ⟦X⟧, so R₃ is integrally closed."),
            reason: text("对变量数归纳，每次使用上一阶段的一元整闭性结论；有限元幂级数环同构把结果传回 Rₙ₊₁。", "Induct on the number of variables, applying the one-variable result each time and transporting it through the finite-variable series equivalence."),
          },
          {
            statement: text("取 R=R₃=MvPowerSeries(Fin 3,ℂ)。", "Choose R=R₃=MvPowerSeries(Fin 3,ℂ)."),
            reason: text("该环已有交换环、Noether、局部环与 ℂ-代数结构；系数域的无零因子性给出整环结构，加上上一行的整闭性。", "This ring already has commutative-ring, Noetherian, local-ring and ℂ-algebra structures. The coefficient field supplies the domain property, and the preceding line supplies integral closedness."),
          },
          {
            statement: text("R 关于 m 进完备，dimR=3，且 ℂ→R/m 双射。", "R is m-adically complete, dimR=3, and ℂ→R/m is bijective."),
            reason: text("分别取前面三个独立支路在 n=3 时的结论，填入存在见证之后的三个合取目标，完成 candidate_ring_properties。", "Specialize the three independent property branches at n=3 and fill the three conjuncts following the existential witness, completing candidate_ring_properties."),
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
