import type { ArchiveIndexRecord, ArchiveProcess } from './types';
import type { Locale } from './site';
import type { Localized } from './proofWalkthroughTypes';
import { acceptedReadingProof } from './proofReadingContext';

type Overview = {
  recordId: string; runId: string; challengeSha: string; proofSha: string;
  title: Localized; setup: Localized; assumptions: Localized[]; notation: Localized[];
  targets: { name: string; meaning: Localized }[]; relationship: Localized;
  outline: { text: Localized; declarations: string[] }[];
};
const t = (zh: string, en: string): Localized => ({ zh, en });
const tree = 'OAI.ThreeState.TreeClauses.';
const seams = 'OAI.IntegralCharacterVarieties.SurfacePresentation.Diagram.';

/** Mathematical reading notes for these exact accepted source versions, not a checked derivation. */
const overviews: Overview[] = [
  {
    recordId: 'openai_three_state_tree_clauses', runId: 'cea8d7e2-84e6-4591-af14-2c9a82d37eef',
    challengeSha: '70eabccad9babe51e425cbdceef6be93c00b12771ea6eb6102296c15a64353f5',
    proofSha: '06189f1bd81a78cf11435926017ecbb07bb62a135d5275b68da0026dc97d2d8a',
    title: t('三状态树广播：阈值以上的重构', 'Three-state tree broadcasting: reconstruction above the threshold'),
    setup: t('根节点在三个状态中均匀取值，子节点按同一对称信道独立传播状态。观察深度 $n$ 的子树信息，证明在分支均值 $m$ 满足 $m\\lambda^2 > 1$ 时，对根状态的后验分布始终保留正的信息量，并收敛到正的极限。这里分别处理固定分支数和 Poisson 分支数。',
      'The root is uniform on three states, and each child independently receives its state through a symmetric channel. From depth-$n$ subtree observations, prove that when the mean offspring number $m$ satisfies $m\\lambda^2 > 1$, the posterior distribution of the root retains a positive amount of information and converges to a positive limit. The two cases have fixed and Poisson offspring counts.'),
    assumptions: [
      t('状态空间为 $\\mathrm{Spin} = \\{0, 1, 2\\}$。实参数 $\\lambda$ 满足 $-1/2 \\le \\lambda \\le 1$；相同状态间的转移权重为 $(1+2\\lambda)/3$，不同状态间为 $(1-\\lambda)/3$。',
        'The state space is $\\mathrm{Spin} = \\{0, 1, 2\\}$. The real parameter satisfies $-1/2 \\le \\lambda \\le 1$. A transition has weight $(1+2\\lambda)/3$ for equal states and $(1-\\lambda)/3$ for different states.'),
      t('各节点的子代数独立且服从同一分布，沿边的信道抽样在给定父状态后独立。固定分支情形每个节点恰有 $b$ 个子节点，$b$ 为自然数；Poisson 情形子代数服从参数 $d \\ge 0$ 的分布，权重为 $\\exp(-d)d^k/k!$。',
        'Offspring counts are independent with a common law, and channel samples are conditionally independent given the parent state. In the regular case each node has exactly $b$ children, for a natural number $b$. In the Poisson case the count has parameter $d \\ge 0$ and weights $\\exp(-d)d^k/k!$.'),
      t('固定分支的结论要求 $b\\lambda^2 > 1$；Poisson 分支的结论要求 $d\\lambda^2 > 1$。观察遵循原题递归模型，包含无序的子树观测；Poisson 情形采用未对存活事件作条件化的原始分布。',
        'The regular conclusion assumes $b\\lambda^2 > 1$; the Poisson conclusion assumes $d\\lambda^2 > 1$. Observations use the recursive model of the statement, with unordered child-subtree observations. The Poisson law is the original law without conditioning on survival.'),
    ],
    notation: [
      t('Observation $0$ 是根状态；Observation $(n+1)$ 是子节点的深度 $n$ 观测组成的多重集合。记 $O_n$ 为此观测，$\\pi_n(i \\mid o)$ 为根状态给定 $O_n = o$ 的后验概率。',
        'Observation $0$ is the root state. Observation $(n+1)$ is the multiset of depth-$n$ observations of the children. Write $O_n$ for this observation and $\\pi_n(i \\mid o)$ for the posterior probability of root state $i$ given $O_n = o$.'),
      t('$A_n = \\mathbb{E}[\\tfrac{1}{2}\\sum_i |\\pi_n(i \\mid O_n) - 1/3|]$，即后验分布与均匀分布的总变差距离的期望。原题中的 Reconstructs 精确定义为存在 $a > 0$ 使 $A_n \\to a$。',
        '$A_n = \\mathbb{E}[\\tfrac{1}{2}\\sum_i |\\pi_n(i \\mid O_n) - 1/3|]$, the expected total variation distance of the posterior from the uniform distribution. Reconstructs means precisely that $A_n \\to a$ for some $a > 0$.'),
    ],
    targets: [
      { name: tree + 'channelWeight_nonneg', meaning: t('允许的 $\\lambda$ 范围内，所有信道权重非负。', 'All channel weights are nonnegative for admissible $\\lambda$.') },
      { name: tree + 'channelWeight_sum', meaning: t('从任一状态出发，三个信道权重之和为 $1$。', 'The three channel weights from each state sum to $1$.') },
      { name: tree + 'Probability.poissonWeight_nonneg', meaning: t('非负参数下，各 Poisson 权重非负。', 'Poisson weights are nonnegative for a nonnegative parameter.') },
      { name: tree + 'Probability.poissonWeight_mass', meaning: t('全部 Poisson 权重之和为 $1$。', 'The Poisson weights sum to $1$.') },
      { name: tree + 'Tree.regular_reconstructs_above_KS', meaning: t('若 $b\\lambda^2 > 1$，则固定 $b$ 分支树上的 $A_n$ 收敛到正数。', 'If $b\\lambda^2 > 1$, then $A_n$ on the regular $b$-ary tree converges to a positive number.') },
      { name: tree + 'Tree.poisson_reconstructs_above_KS', meaning: t('若 $d\\lambda^2 > 1$，则 $\\mathrm{Poisson}(d)$ 分支树上的 $A_n$ 收敛到正数。', 'If $d\\lambda^2 > 1$, then $A_n$ for $\\mathrm{Poisson}(d)$ offspring converges to a positive number.') },
    ],
    relationship: t('前四个目标建立信道和 Poisson 分支的概率分布；最后两个目标分别证明两种树模型的阈值以上充分条件。它们共用计数矩、总变差下界及单调收敛的证明。',
      'The first four targets establish the channel and Poisson probability laws. The last two prove sufficient conditions above the threshold in the two tree models. They share the census-moment argument, total variation lower bound and monotone convergence argument.'),
    outline: [
      { text: t('取信道特征函数 $\\varphi(i) = 1_{\\{i=0\\}} - 1/3$。令 $X_n$ 为深度 $n$ 叶层中状态 $0$ 的数量、$Z_n$ 为叶层总数，使用中心化计数 $S_n = X_n - Z_n/3$。递归传播给出根为 $i$ 时的条件期望 $\\mathbb{E}[S_n \\mid i] = (m\\lambda)^n\\varphi(i)$。',
        'Use the channel eigenfunction $\\varphi(i) = 1_{\\{i=0\\}} - 1/3$. Let $X_n$ count state-0 leaves and $Z_n$ count all leaves at depth $n$, and set $S_n = X_n - Z_n/3$. Recursive propagation gives $\\mathbb{E}[S_n \\mid \\mathrm{root}=i] = (m\\lambda)^n\\varphi(i)$.'), declarations: ['exists_census_pair'] },
      { text: t('利用独立子树推导二阶矩递推。记 $\\beta = \\mathbb{E}[N(N-1)]$；固定分支有 $(m, \\beta) = (b, b(b-1))$，Poisson 分支有 $(m, \\beta) = (d, d^2)$。当 $m\\lambda^2 > 1$ 时可选 $C > 0$，统一控制给定根 $i$ 时的二阶矩 $\\mathbb{E}[S_n^2 \\mid i] \\le C(m\\lambda)^{2n}$。',
        'Independence of child subtrees gives a second-moment recursion. Put $\\beta = \\mathbb{E}[N(N-1)]$. The regular case has $(m, \\beta) = (b, b(b-1))$; the Poisson case has $(m, \\beta) = (d, d^2)$. When $m\\lambda^2 > 1$, choose $C > 0$ so that $\\mathbb{E}[S_n^2 \\mid \\mathrm{root}=i] \\le C(m\\lambda)^{2n}$ uniformly in $n$ and $i$.'), declarations: ['regular_advantage_uniform_lower', 'poisson_advantage_uniform_lower'] },
      { text: t('比较根状态 $0$ 与 $1$ 的观测分布。其计数均值差为 $(m\\lambda)^n$；Cauchy–Schwarz 与二阶矩界给出观测分布总变差距离至少 $1/(4C)$，进而 $A_n \\ge 1/(12C) > 0$。',
        'Compare the observation laws with root states $0$ and $1$. Their census means differ by $(m\\lambda)^n$. Cauchy–Schwarz and the second-moment bound give total variation distance at least $1/(4C)$, and hence $A_n \\ge 1/(12C) > 0$.'), declarations: ['regular_advantage_uniform_lower', 'poisson_advantage_uniform_lower'] },
      { text: t('深一层的观测可由当前观测经随机信道生成，数据处理使 $A_n$ 单调不增。结合统一正下界，单调收敛得到 $A_n \\to a \\ge 1/(12C) > 0$，分别完成最后两个目标。',
        'The next-depth observation is obtained from the current one through a random channel, so data processing makes $A_n$ nonincreasing. Together with the uniform positive lower bound, monotone convergence gives $A_n \\to a \\ge 1/(12C) > 0$, proving both reconstruction targets.'), declarations: ['Tree.regular_reconstructs_above_KS', 'Tree.poisson_reconstructs_above_KS'] },
    ],
  },
  {
    recordId: 'openai_character_varieties_all_seams_support', runId: '1f3bb9c1-c99f-4fad-b656-8010a82c265b',
    challengeSha: 'ebc3129bfb5ef4a47e0de1d89f0f406ef6603df32355bdfbb9ce278627c1a1f1',
    proofSha: '5c0cbc35bd6335ab7c6d8d57bdece22a3065c6fdc7dee871d2577826b50396d3',
    title: t('生成标记图的全部接缝旗标方程', 'Framed-flag equations at every produced marked seam'),
    setup: t('从满足原图关系的域值解出发，沿选定接缝构造一个非分离切割后的标记图。证明所构造的矩阵取值在新图每条接缝的两侧给出同一个带标架旗标：各级旗标子空间一致，相应商层的坐标标识也一致。',
      'Starting from a field-valued solution of the original diagram, construct a marked diagram for a nonseparating cut at a chosen seam. Prove that the constructed matrix values give the same framed flag on both sides of every seam: the flag subspaces and the named quotient coordinates agree.'),
    assumptions: [
      t('给定交换环 $R$、域 $K$ 及 $R$-代数结构 $K$。曲面关联图为 $D : \\mathrm{Diagram}\\ F\\ S\\ V\\ \\mathrm{arity}$，顶点类型 $V$ 有限，选定接缝 $q \\in S$。',
        'Let $R$ be a commutative ring and $K$ a field with an $R$-algebra structure. Let $D : \\mathrm{Diagram}\\ F\\ S\\ V\\ \\mathrm{arity}$ be a surface incidence diagram with finite vertex type $V$, and choose a seam $q \\in S$.'),
      t('$D$ 是 Proper：每个面的秩为正，每条接缝至少有两个子侧。$q$ 的父侧所属面的秩支配所有面的秩：对任意 $f$，有 $\\mathrm{rank}(f) \\le \\mathrm{rank}(\\mathrm{ports.facet}(q, \\mathrm{none}))$。并且 $\\mathrm{genus}(\\mathrm{bandCutParent}(q)) > 0$。',
        'Assume $D$ is Proper: every facet has positive rank and every seam has at least two child sides. The parent facet at $q$ has maximal rank: $\\mathrm{rank}(f) \\le \\mathrm{rank}(\\mathrm{ports.facet}(q, \\mathrm{none}))$ for every $f$. Also assume $\\mathrm{genus}(\\mathrm{bandCutParent}(q)) > 0$.'),
      t('穿孔数据 $P$ 指定每个面的穿孔数及每个穿孔在 $R$ 中的可逆标量。给定原图的 $K$-值解 $x : \\mathrm{Solution}\\ P\\ K$，任取 $\\mathrm{bandCutParent}(q)$ 的边界分量 $b_0$ 及其上的位置 $i_0$。这些数据确定标记图 $C = \\mathrm{producedMarkedDiagram}(\\dots)$ 和生成元矩阵取值 $v = \\mathrm{producedMarkedValues}(\\dots)$。',
        'Puncture data $P$ specify each facet’s puncture count and a prescribed unit of $R$ at each puncture. Give an original $K$-valued solution $x : \\mathrm{Solution}\\ P\\ K$, a boundary component $b_0$ of $\\mathrm{bandCutParent}(q)$, and a position $i_0$ on it. These determine $C = \\mathrm{producedMarkedDiagram}(\\dots)$ and the generator matrix values $v = \\mathrm{producedMarkedValues}(\\dots)$.'),
    ],
    notation: [
      t('在新图 $C$ 的接缝 $s$，把 $\\mathrm{seamLeft}(s)$、$\\mathrm{seamRight}(s)$ 在 $v$ 处求值，得到可逆矩阵及对应线性同构 $e_s$、$f_s$；$a_s$ 为接缝分级。设 $E_{<k} = \\{u : a_s(i) \\ge k \\implies u_i = 0\\}$，$F^e_k = e_s(E_{<k})$。',
        'At seam $s$ of $C$, evaluate $\\mathrm{seamLeft}(s)$ and $\\mathrm{seamRight}(s)$ at $v$ to obtain invertible matrices with linear isomorphisms $e_s$ and $f_s$; $a_s$ is the seam grading. Put $E_{<k} = \\{u : u_i = 0 \\text{ whenever } a_s(i) \\ge k\\}$ and $F^e_k = e_s(E_{<k})$.'),
      t('SameFramedFlag$(a_s, e_s, f_s)$ 要求对每个 $k$，$F^e_k = F^f_k$；且每个 $w \\in F^e_{k+1}$ 在 $e_s^{-1}$ 与 $f_s^{-1}$ 下的坐标，在所有 $a_s(i) = k$ 的位置相同。因此它同时保留旗标子空间和商 $F_{k+1}/F_k$ 的命名坐标。',
        'SameFramedFlag$(a_s, e_s, f_s)$ requires $F^e_k = F^f_k$ for every $k$. For each $w \\in F^e_{k+1}$, the coordinates of $e_s^{-1}(w)$ and $f_s^{-1}(w)$ agree wherever $a_s(i) = k$. This retains both the flag subspaces and the named coordinates on $F_{k+1}/F_k$.'),
    ],
    targets: [{ name: seams + 'producedMarkedValues_allSeams', meaning: t('对新标记图的每条接缝 $s$，证明 SameFramedFlag$(a_s, e_s, f_s)$。', 'Prove SameFramedFlag$(a_s, e_s, f_s)$ at every seam $s$ of the produced marked diagram.') }],
    relationship: t('本题只有一个已验收目标。证明分别处理八类接缝，再用穷尽分类合并成“所有接缝”。这些分类引理共同保证构造值满足全部接缝的带标架旗标方程。',
      'There is one accepted target. Its proof treats eight families of seams and combines them by exhaustive classification. These family lemmas establish that the constructed values satisfy every framed-flag seam equation.'),
    outline: [
      { text: t('从 $x$ 作所需的基点规范变换，构造切割种子、切割带与标记图的生成元取值。用 external_markedAsCutValues 和端口框架恒等式，把两侧矩阵及框架改写到切割模型中。',
        'Apply the required based gauge transformation to $x$ and construct the cut seed, cut band and marked generator values. Use external_markedAsCutValues and the port-frame identities to rewrite both side matrices and frames in the cut model.'), declarations: ['external_markedAsCutValues', 'parent_producedCutPortFrame'] },
      { text: t('其余旧接缝的关系由原解迁移；选定旧接缝使用切割带端点框架关系。原带内部、镜像带内部及正负横向接缝，用各自的端口框架和侧矩阵恒等式逐类验证。',
        'Transport the old solution’s relations at the other old seams. Use the cut band’s endpoint-frame relation at the selected old seam. Verify original internal, mirrored internal, positive transverse and negative transverse seams using their port frames and side-matrix identities.'), declarations: ['external_producedOldSeam_dataV2', 'parent_producedSelectedSeamComplete'] },
      { text: t('分别验证第一短接缝与闭合接缝。闭合处使用首尾框架关系，在共同基变换下传递 SameFramedFlag；相关矩阵表达式含 $T^{-1}J^{-1}PT$。',
        'Verify the first short seam and the closing seam. At the closing seam, use the first/last-frame relation and transport SameFramedFlag through a common change of basis; the matrix expression includes $T^{-1}J^{-1}PT$.'), declarations: ['external_producedFirstShortEquation_shared', 'parent_wrapFlag_algebra', 'parent_producedWrapSeamComplete'] },
      { text: t('external_graftPlus_cases 穷尽八类：其余旧接缝、选定旧接缝、原带内部、镜像带内部、正横向、负横向、第一短接缝、闭合接缝。external_allSeamsFromBranches 合并八个分支，得到对每条接缝成立的最终结论。',
        'external_graftPlus_cases exhausts eight families: other old seams, the selected old seam, original internal seams, mirrored internal seams, positive transverse seams, negative transverse seams, the first short seam and the closing seam. external_allSeamsFromBranches combines the eight branches into the universal conclusion.'), declarations: ['external_graftPlus_cases', 'external_allSeamsFromBranches', 'producedMarkedValues_allSeams'] },
    ],
  },
];

type ProofRecord = Pick<ArchiveIndexRecord, 'id' | 'campaign' | 'sources'>;
export function sourceMathematics(record: ProofRecord, process: ArchiveProcess): Overview | undefined {
  const proof = acceptedReadingProof(record, process);
  return proof && overviews.find(item => item.recordId === record.id && item.runId === proof.run.runId
    && item.proofSha === proof.source.sha256
    && record.sources.some(source => source.name === 'Challenge.lean' && source.sha256 === item.challengeSha)
    && item.targets.length === proof.campaign.targets.length
    && item.targets.every((target, index) => target.name === proof.campaign.targets[index]));
}

export function renderSourceMathematics(record: ProofRecord, process: ArchiveProcess, locale: Locale): string {
  const overview = sourceMathematics(record, process);
  if (!overview) return '';
  const html = (value: string) => value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const label = (value: Localized) => html(value[locale]);
  const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
  const file = process.sourceRoute?.files.find(file => file.sha256 === overview.proofSha);
  const targets = file?.declarations.filter(item => record.campaign!.targets.includes(item.name)) ?? [];
  const helpers = file?.declarations.filter(item => !record.campaign!.targets.includes(item.name)) ?? [];
  const jump = (name: string, title: string) => {
    const target = targets.findIndex(item => item.name === name || item.name.endsWith('.' + name));
    const helper = helpers.findIndex(item => item.name === name || item.name.endsWith('.' + name));
    const anchor = target >= 0 ? `proof-source-target-${target + 1}` : helper >= 0 ? `proof-source-helper-${helper + 1}` : '';
    return anchor ? `<button type="button" data-global-scroll="${anchor}">${html(title)} ↗</button>` : `<code>${html(title)}</code>`;
  };
  return `<section class="workflow-section proof-source-mathematics" data-proof-source-mathematics="${html(record.id)}">
    <h4>${label(overview.title)}</h4><p class="workflow-prose" data-proof-math-setup>${label(overview.setup)}</p>
    <details class="proof-reading-intro" data-proof-math-details><summary>${tx('完整假设、目标与证明思路', 'Full assumptions, targets and proof outline')}</summary>
      <h5>${tx('完整假设', 'Full assumptions')}</h5>${overview.assumptions.map(value => `<p class="workflow-prose">${label(value)}</p>`).join('')}
      <h5>${tx('观测与符号', 'Objects and notation')}</h5>${overview.notation.map(value => `<p class="workflow-prose">${label(value)}</p>`).join('')}
      <h5>${tx('目标及其关系', 'Targets and their relationship')}</h5><p class="workflow-prose">${label(overview.relationship)}</p>
      <ol>${overview.targets.map(target => `<li data-proof-math-target="${html(target.name)}"><p class="workflow-prose">${label(target.meaning)}</p>${jump(target.name, target.name.split('.').at(-1)!)}</li>`).join('')}</ol>
      <h5>${tx('核心证明思路', 'Core proof outline')}</h5><ol>${overview.outline.map(step => `<li><p class="workflow-prose">${label(step.text)}</p><div class="proof-walkthrough-links">${step.declarations.map(name => jump(name, name)).join(' ')}</div></li>`).join('')}</ol>
      <p class="process-code-meta">${tx('以上为当前已验收源码的数学说明；逐步 Lean 证明与引用见下方。', 'These notes explain the currently accepted source. The Lean proofs and their references follow below.')}</p>
    </details>
  </section>`;
}
