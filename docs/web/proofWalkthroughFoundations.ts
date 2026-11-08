import type { ProofWalkthrough } from './proofWalkthroughTypes';

export const foundationProofWalkthroughs: ProofWalkthrough[] = [
  {
    recordId: 'openai_cartier_chart_compactness_support',
    runId: '25c5cc6c-ec05-439c-bb42-7dd1ebeea45f',
    proofSha256: '3f4987016064040ed126b75de0aea0dfa6b2bf74b7dd22dfa1722b7fcc525963',
    title: { zh: '把坐标图回缩识别为已知的紧致赋值族', en: 'Identify chart retractions with a known compact valuation family' },
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
        next: { zh: '可以从六个基础局面开始，依次重建所有后继行。', en: 'Reconstruct every later row from the six base rows.' },
        evidence: {
          theorems: ['OAI.SnakyCertificate.table_valid_probe'],
          taskIds: ['initial_goal_1'], checkIds: ['check-b900b20d4968e7ec561d'],
          source: { name: 'Submission.lean', line: 9463, endLine: 9473 },
        },
      },
      {
        id: 'reconstruct-the-fork',
        title: { zh: '用旋转、平移与分叉重建行', en: 'Reconstruct rows by placement and forking' },
        given: { zh: '各 child 行已经确定；一个 Term 指定 child、八种方向之一和整数平移。', en: 'Child rows are already known; each term specifies a child, one of eight orientations and an integer translation.' },
        claim: {
          zh: '先对各 child 的 A、H 同时作放置，再令新 A = (⋃Aᵢ ∪ ⋂Hᵢ) ∖ {o}，新 H = {o} ∪ ⋃Hᵢ，新 h = 1 + max hᵢ。',
          en: 'Place each child’s A and H, then set A = (⋃Aᵢ ∪ ⋂Hᵢ) ∖ {o}, H = {o} ∪ ⋃Hᵢ and h = 1 + max hᵢ.',
        },
        because: {
          zh: '这正是 placeRow、commonH、forkRow 与 rowAt 的定义。me_615 等重建等式展开对应表项，再用已证明的 child 等式把递归值改写为显式有限集。',
          en: 'These are the definitions of placeRow, commonH, forkRow and rowAt. Reconstruction equalities such as me_615 unfold the entry and rewrite its children using earlier equalities, yielding explicit finite sets.',
        },
        next: { zh: '把递归定义转为可逐点核验的集合与整数数据。', en: 'Reduce recursive rows to finite sets and integer data that can be checked directly.' },
        evidence: {
          theorems: ['OAI.SnakyCertificate.me_615'],
          taskIds: ['initial_goal_1'], checkIds: ['check-b900b20d4968e7ec561d'],
          source: { name: 'Submission.lean', line: 1356, endLine: 1377 },
        },
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
        next: { zh: '将这个下降结论用于分式域中的任意整元，证明一元幂级数环整闭。', en: 'Apply this descent to an integral element of the fraction field to prove integral closedness in one variable.' },
        evidence: {
          theorems: ['OAI.SmallCM.constantCoeff_almost', 'OAI.SmallCM.almost_div_X', 'OAI.SmallCM.coeff_mem_of_almost', 'OAI.SmallCM.mem_range_of_almost'],
          taskIds: ['initial_goal_1'], checkIds: ['check-73969943b30b55dacdb8'],
          source: { name: 'Submission.lean', line: 154, endLine: 175 },
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
