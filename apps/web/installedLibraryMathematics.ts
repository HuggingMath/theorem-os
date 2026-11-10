import type { InstalledLibraryEntry } from './installedLibraryTypes';

type Text = { zh: string; en: string };
export type InstalledLibraryMathematics = {
  summary: Text;
  conditions: { label: Text; expression: string; meaning: Text }[];
  conclusion: Text;
  expression: string;
  usage: string;
  context: Text;
};
const text = (zh: string, en: string): Text => ({ zh, en });

// These statements describe the exact named declarations, not whole theorem families.
const explanations: Record<string, Text> = {
  'TheoremOS.Algebra.FiniteSums.sum_forward_differences': text('望远镜求和：前 n 个相邻差之和等于第 n 项减去首项。', 'Telescoping: the first n successive differences sum to the nth term minus the initial term.'),
  'TheoremOS.Algebra.FiniteSums.sum_shifted_differences': text('从给定下标开始的相邻差之和，由区间两端的函数值确定。', 'A sum of successive differences starting at a given index is determined by its endpoint values.'),
  'TheoremOS.Algebra.FiniteSums.geometric_sum': text('公比不等于 1 时，给出前 n 项等比和的闭式。', 'For a ratio other than 1, gives a closed formula for the first n powers.'),
  'TheoremOS.Algebra.FiniteSums.shifted_geometric_sum': text('公比不等于 1 时，从第 m 次幂开始的等比和可提出因子 rᵐ。', 'For a ratio other than 1, a geometric sum starting at the mth power factors by rᵐ.'),
  'TheoremOS.Algebra.FiniteSums.weighted_geometric_sum': text('公比不等于 1 时，计算以项数 k 为权的等比和 ∑ k rᵏ。', 'For a ratio other than 1, evaluates the index-weighted geometric sum ∑ k rᵏ.'),
  'TheoremOS.Algebra.FiniteSums.affine_recurrence': text('将一阶仿射递推展开为初值项与有限等比和。', 'Expands a first-order affine recurrence into its initial-value term and a finite geometric sum.'),
  'TheoremOS.Algebra.FiniteSums.affine_recurrence_closed': text('递推系数 a 不等于 1 时，给出 f(k+1) = a f(k) + b 的闭式。', 'When a differs from 1, gives a closed formula for f(k+1) = a f(k) + b.'),
  'TheoremOS.Algebra.FiniteSums.affine_recurrence_upper_bound': text('递推系数非负时，将逐步递推上界展开为第 n 项的上界。', 'For a nonnegative recurrence coefficient, turns stepwise affine bounds into an upper bound on the nth term.'),
  'TheoremOS.Analysis.FiniteConvexity.normalized_jensen': text('非负权重且总权重为正时，凸函数在加权平均处的值不超过函数值的加权平均。', 'For nonnegative weights with positive total mass, a convex function at the weighted mean is at most the weighted mean of its values.'),
  'TheoremOS.Analysis.FiniteConvexity.normalized_reverse_jensen': text('非负权重且总权重为正时，凹函数在加权平均处的值不小于函数值的加权平均。', 'For nonnegative weights with positive total mass, a concave function at the weighted mean is at least the weighted mean of its values.'),
  'TheoremOS.Analysis.FiniteInequalities.weighted_cauchy_sq': text('非负权重下，加权乘积和的平方不超过两个加权平方和的乘积。', 'With nonnegative weights, the squared weighted product sum is at most the product of the two weighted square sums.'),
  'TheoremOS.Analysis.FiniteInequalities.prod_le_mean_pow': text('非空有限组非负实数的乘积，不超过其算术平均的项数次幂。', 'The product of a nonempty finite family of nonnegative reals is at most its arithmetic mean raised to the number of terms.'),
  'TheoremOS.Combinatorics.FiniteCounting.card_le_sum_fiber_capacity': text('映射落在有限目标集内，且每条纤维受容量约束时，源集合大小不超过总容量。', 'If a map lands in a finite target and each fiber is bounded by its capacity, the source size is at most total capacity.'),
  'TheoremOS.Combinatorics.FiniteCounting.card_le_card_mul_fiber_bound': text('每条纤维至多含 n 个元素时，源集合大小不超过目标集合大小乘 n。', 'If each fiber contains at most n elements, the source size is at most the target size times n.'),
  'TheoremOS.Probability.sum_filter_le_of_subgaussian': text('非负权重满足给定的次高斯指数矩界时，得到非负阈值处的高斯型上尾界。', 'A subgaussian exponential-moment bound for nonnegative weights yields a Gaussian upper-tail bound at nonnegative thresholds.'),
  'TheoremOS.Probability.sum_biasedMass_hoeffding': text('在参数 p 的独立随机子集分布中，对加权中心化指示变量之和给出 Hoeffding 上尾界。', 'Under the independent random-subset law with bias p, gives a Hoeffding upper-tail bound for a weighted sum of centered indicators.'),
  'TheoremOS.Combinatorics.LooplessMultigraph.Matching': text('一个完美匹配由有限边集及“每个顶点恰好关联一条选中边”的证明组成。', 'A perfect matching consists of a finite edge set together with a proof that each vertex meets exactly one selected edge.'),
  'TheoremOS.Probability.expectation': text('按有限权重 p 对 X 加权求和，定义期望。', 'Defines expectation as the finite weighted sum of X under p.'),
  'TheoremOS.Probability.prob': text('将事件 s 内各点的权重相加，定义事件的质量。', 'Defines an event’s mass by summing the weights of its elements.'),
  'TheoremOS.Probability.variance': text('对 X 与其期望之差的平方取加权期望，定义方差。', 'Defines variance as the weighted expectation of the squared deviation from expectation.'),
  'TheoremOS.Probability.tvDist': text('总变差距离是两组权重逐点绝对差之和的一半。', 'Total variation is half the sum of the pointwise absolute differences between the weights.'),
  'TheoremOS.Probability.biasedMass': text('对子集内元素取因子 p，其余元素取 1−p，再相乘；0≤p≤1 时是独立随机子集的质量。', 'Multiplies p for included elements and 1−p for excluded elements; for 0≤p≤1 this is an independent random-subset mass.'),
  'TheoremOS.Probability.biasedWeight': text('对布尔配置的真坐标取因子 p，假坐标取 1−p，再相乘。', 'Multiplies p for true coordinates and 1−p for false coordinates of a Boolean configuration.'),
  'TheoremOS.Probability.klBernoulli': text('以自然对数定义参数 a 相对于 p 的 Bernoulli 相对熵。', 'Defines Bernoulli relative entropy of bias a from bias p, using natural logarithms.'),
  'TheoremOS.InformationTheory.entropy': text('以自然对数计算有限权重的 Shannon 熵 −∑ pᵢ log pᵢ。', 'Computes Shannon entropy of finite weights as −∑ pᵢ log pᵢ, using natural logarithms.'),
  'TheoremOS.InformationTheory.relEntropy': text('计算相对熵 ∑ pᵢ log(pᵢ/qᵢ)，采用 Lean 的实数对数与除法约定。', 'Computes relative entropy ∑ pᵢ log(pᵢ/qᵢ), with Lean’s real logarithm and division conventions.'),
  'TheoremOS.InformationTheory.uniform': text('给有限类型的每个元素分配相同权重 1/|ι|。', 'Assigns the same weight 1/|ι| to every element of a finite type.'),
  'TheoremOS.InformationTheory.marginalLeft': text('固定左坐标并对右坐标求和，得到左边际权重。', 'Fixes the left coordinate and sums over the right coordinate to obtain left marginal weights.'),
  'TheoremOS.InformationTheory.marginalRight': text('固定右坐标并对左坐标求和，得到右边际权重。', 'Fixes the right coordinate and sums over the left coordinate to obtain right marginal weights.'),
  'TheoremOS.InformationTheory.pushforward': text('将映射 f 的同一纤维上的权重相加，得到推前权重。', 'Sums weights over each fiber of f to obtain pushforward weights.'),
  'TheoremOS.InformationTheory.chiSq': text('计算卡方散度 ∑ (p−q)²/q，除法采用 Lean 的实数约定。', 'Computes chi-squared divergence ∑ (p−q)²/q, using Lean’s real division convention.'),
  'TheoremOS.InformationTheory.mutualInfo': text('互信息是联合权重相对于两个边际之积的相对熵。', 'Mutual information is the relative entropy of the joint weights from the product of their marginals.'),
  'TheoremOS.LinearAlgebra.IsDensity': text('密度矩阵的条件是半正定且迹为 1。', 'A density matrix is positive semidefinite and has trace 1.'),
  'TheoremOS.LinearAlgebra.traceRight': text('对右侧矩阵指标的对角项求和，得到右部分迹。', 'Sums the diagonal right indices to obtain the partial trace over the right factor.'),
  'TheoremOS.LinearAlgebra.traceLeft': text('对左侧矩阵指标的对角项求和，得到左部分迹。', 'Sums the diagonal left indices to obtain the partial trace over the left factor.'),
  'TheoremOS.LinearAlgebra.numericalRange': text('数值域由所有单位向量 x 对应的内积 ⟪x,Tx⟫ 组成。', 'The numerical range consists of ⟪x,Tx⟫ over all unit vectors x.'),
  'TheoremOS.LinearAlgebra.numericalRadius': text('数值半径是数值域中复数模长的上确界。', 'The numerical radius is the supremum of the moduli of points in the numerical range.'),
  'TheoremOS.Combinatorics.IsEditStep': text('一次单位代价编辑是在任意位置插入、删除或替换一个元素。', 'A unit-cost edit inserts, deletes or substitutes one element at any position.'),
  'TheoremOS.Combinatorics.editDist': text('编辑距离是连接两个列表的编辑链的最小长度。', 'Edit distance is the least length of an edit chain between two lists.'),
  'TheoremOS.Combinatorics.lcsLength': text('取两个列表的公共子序列长度的最大值。', 'Takes the maximum length of a common subsequence of the two lists.'),
};
// Definition bodies verified against the pinned source; the catalog header alone only gives a result type.
const definitionBodies: Record<string, string> = {
  'TheoremOS.Combinatorics.LooplessMultigraph.Matching': '{M : Finset E // G.IsPerfectMatching M}',
  'TheoremOS.Probability.expectation': 'expectation p X = ∑ ω, p ω * X ω',
  'TheoremOS.Probability.prob': 'prob p s = ∑ ω ∈ s, p ω',
  'TheoremOS.Probability.variance': 'variance p X = expectation p (fun ω => (X ω - expectation p X) ^ 2)',
  'TheoremOS.Probability.tvDist': 'tvDist p q = (1 / 2 : ℝ) * ∑ ω, |p ω - q ω|',
  'TheoremOS.Probability.biasedMass': 'biasedMass p s = ∏ x, if x ∈ s then p else 1 - p',
  'TheoremOS.Probability.biasedWeight': 'biasedWeight p x = ∏ e, if x e = true then p else 1 - p',
  'TheoremOS.Probability.klBernoulli': 'klBernoulli a p = a * log (a / p) + (1 - a) * log ((1 - a) / (1 - p))',
  'TheoremOS.InformationTheory.entropy': 'entropy p = -∑ i, p i * log (p i)',
  'TheoremOS.InformationTheory.relEntropy': 'relEntropy p q = ∑ i, p i * log (p i / q i)',
  'TheoremOS.InformationTheory.uniform': 'uniform ι i = (Fintype.card ι : ℝ)⁻¹',
  'TheoremOS.InformationTheory.marginalLeft': 'marginalLeft r i = ∑ j, r (i, j)',
  'TheoremOS.InformationTheory.marginalRight': 'marginalRight r j = ∑ i, r (i, j)',
  'TheoremOS.InformationTheory.pushforward': 'pushforward f p j = ∑ i with f i = j, p i',
  'TheoremOS.InformationTheory.chiSq': 'chiSq p q = ∑ ω, (p ω - q ω) ^ 2 / q ω',
  'TheoremOS.InformationTheory.mutualInfo': 'mutualInfo r = relEntropy r (fun x => marginalLeft r x.1 * marginalRight r x.2)',
  'TheoremOS.LinearAlgebra.IsDensity': 'IsDensity ρ ↔ ρ.PosSemidef ∧ trace ρ = 1',
  'TheoremOS.LinearAlgebra.traceRight': 'traceRight X i j = ∑ k, X (i, k) (j, k)',
  'TheoremOS.LinearAlgebra.traceLeft': 'traceLeft X i j = ∑ k, X (k, i) (k, j)',
  'TheoremOS.LinearAlgebra.numericalRange': 'numericalRange T = {z | ∃ x, ‖x‖ = 1 ∧ ⟪x, T x⟫_ℂ = z}',
  'TheoremOS.LinearAlgebra.numericalRadius': 'numericalRadius T = sSup ((fun z => ‖z‖) \'\' numericalRange T)',
};

const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']', '⦃': '⦄' };
function topLevelColon(value: string): number {
  const stack: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (pairs[character]) stack.push(pairs[character]);
    else if (character === stack.at(-1)) stack.pop();
    else if (character === ':' && !stack.length && value[index + 1] !== '=') return index;
  }
  return -1;
}
function binderGroups(header: string): string[] {
  const groups: string[] = [];
  for (let index = 0; index < header.length; index++) {
    if (!pairs[header[index]]) continue;
    const start = index, stack = [pairs[header[index]]];
    while (stack.length && ++index < header.length) {
      if (pairs[header[index]]) stack.push(pairs[header[index]]);
      else if (header[index] === stack.at(-1)) stack.pop();
    }
    if (!stack.length) groups.push(header.slice(start, index + 1));
  }
  return groups;
}
function typeMeaning(value: string): Text {
  const basic: Record<string, Text> = {
    'ℕ': text('自然数', 'natural number'), 'Nat': text('自然数', 'natural number'),
    'ℤ': text('整数', 'integer'), 'ℚ': text('有理数', 'rational number'),
    'ℝ': text('实数', 'real number'), 'ℂ': text('复数', 'complex number'),
    'Prop': text('命题', 'proposition'), 'Type*': text('类型', 'type'),
  };
  if (basic[value]) return basic[value];
  if (/^Finset\s/u.test(value)) return text('有限集合', 'finite set');
  if (/^Set\s/u.test(value)) return text('集合', 'set');
  if (/^Matrix\s/u.test(value)) return text('矩阵', 'matrix');
  if (/^Polynomial\s/u.test(value)) return text('多项式', 'polynomial');
  if (/^∀/u.test(value)) return text('依赖所列指标的函数', 'dependent function over the indicated indices');
  if (value.includes('≃')) return text('所示类型间的等价', 'equivalence between the displayed types');
  if (/Subrepresentation\b/u.test(value)) return text('表示的不变子空间', 'invariant subspace of a representation');
  if (/SimpleGraph\b/u.test(value)) return text('简单图', 'simple graph');
  if (/LooplessMultigraph\b/u.test(value)) return text('无自环多重图', 'loopless multigraph');
  if (/Measure\b/u.test(value)) return text('测度', 'measure');
  if (/PMF\b/u.test(value)) return text('概率质量函数', 'probability mass function');
  if (value.includes('→')) return text('具有所示定义域和值域的函数', 'function with the displayed domain and codomain');
  return text('具有所示类型的数学对象', 'mathematical object of the displayed type');
}
function hypothesisMeaning(value: string): Text {
  if (/^∀/u.test(value)) return text('对所列全部指标均成立', 'holds for every indicated index');
  if (/^∃/u.test(value)) return text('存在满足此条件的对象', 'an object satisfying this condition exists');
  if (value.includes('≠')) return text('两者不相等', 'the two expressions differ');
  if (value.includes('≤')) return text('满足所示非严格界', 'satisfies the displayed non-strict bound');
  if (value.includes('<')) return text('满足所示严格界', 'satisfies the displayed strict bound');
  if (value.includes('∈')) return text('属于所示集合', 'belongs to the displayed set');
  if (/ConvexOn/u.test(value)) return text('函数在所示集合上凸', 'the function is convex on the displayed set');
  if (/ConcaveOn/u.test(value)) return text('函数在所示集合上凹', 'the function is concave on the displayed set');
  return text('要求此命题成立', 'this proposition is assumed');
}
function condition(group: string) {
  const body = group.slice(1, -1).trim(), colon = topLevelColon(body);
  const names = colon < 0 ? '' : body.slice(0, colon).trim(), expression = colon < 0 ? body : body.slice(colon + 1).trim();
  if (group.startsWith('[')) {
    const structures: Record<string, Text> = {
      AddCommGroup: text('加法交换群结构', 'additive commutative group structure'),
      CommRing: text('交换环结构', 'commutative ring structure'), Field: text('域结构', 'field structure'),
      Fintype: text('有限类型及其枚举', 'finite type with an enumeration'), DecidableEq: text('可判定的相等关系', 'decidable equality'),
    };
    return { label: text('结构条件', 'Structure'), expression,
      meaning: structures[expression.split(/\s/u)[0]] ?? text('所示类型类条件', 'the displayed typeclass condition') };
  }
  const isHypothesis = /^h[^\s]*$/u.test(names) || /^(?:∀|∃|¬|0\s*[<≤]|[A-Za-z\d_]+\s*[<≤=≠])/u.test(expression)
    || /^(?:ConvexOn|ConcaveOn|StrictConvexOn|StrictConcaveOn|Function\.Injective|Function\.Surjective)\b/u.test(expression);
  return { label: isHypothesis ? text(names ? `假设 ${names}` : '假设', names ? `Assumption ${names}` : 'Assumption')
    : text(names ? `参数 ${names}` : '参数', names ? `Input ${names}` : 'Input'), expression,
    meaning: isHypothesis ? hypothesisMeaning(expression) : typeMeaning(expression) };
}
function generalConclusion(entry: InstalledLibraryEntry, expression: string): Text {
  if (entry.kind === 'definition') {
    const meaning = typeMeaning(expression);
    return text(`定义一个${meaning.zh}。`, `Defines a ${meaning.en}.`);
  }
  const stack: string[] = [], relations: string[] = [];
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index];
    if (pairs[character]) stack.push(pairs[character]);
    else if (character === stack.at(-1)) stack.pop();
    else if (!stack.length && '↔→∧∨≤<≠=∈⊆'.includes(character)) relations.push(character);
  }
  if (/^∃/u.test(expression)) return text('存在满足所示性质的对象。', 'An object with the displayed properties exists.');
  if (/^∀/u.test(expression)) return text('所示结论对给定范围内的全部对象成立。', 'The displayed conclusion holds for every object in the indicated range.');
  if (relations.includes('↔')) return text('所示两个命题等价。', 'The two displayed propositions are equivalent.');
  if (relations.includes('→')) return text('由箭头左侧的条件可推出右侧命题。', 'The condition to the left of the arrow implies the proposition to its right.');
  if (relations.includes('∧')) return text('所列数学性质同时成立。', 'The displayed mathematical properties hold together.');
  if (relations.includes('∨')) return text('所列数学性质至少有一个成立。', 'At least one of the displayed mathematical properties holds.');
  if (relations.includes('≤')) return text('在给定条件下，得到以下非严格界。', 'Under the stated conditions, the following non-strict bound holds.');
  if (expression.includes('↪') || expression.includes('≃')) return text('给出所示数学对象之间的映射或等价。', 'Gives the displayed map or equivalence between mathematical objects.');
  if (relations.includes('≠')) return text('在给定条件下，所示两个对象不相等。', 'Under the stated conditions, the two displayed objects differ.');
  if (relations.includes('=')) return text(expression.includes('∑') ? '在给定条件下，所示有限和满足此恒等式。' : '在给定条件下，所示两个表达式相等。',
    expression.includes('∑') ? 'Under the stated conditions, the displayed finite sums satisfy this identity.' : 'Under the stated conditions, the two displayed expressions are equal.');
  if (relations.includes('<')) return text('在给定条件下，得到以下严格界。', 'Under the stated conditions, the following strict bound holds.');
  if (relations.includes('∈')) return text('所示对象属于给定集合。', 'The displayed object belongs to the indicated set.');
  if (relations.includes('⊆')) return text('所示集合之间具有此包含关系。', 'The displayed sets satisfy this inclusion.');
  return text('在给定条件下，以下数学命题成立。', 'Under the stated conditions, the following mathematical proposition holds.');
}

/** Derives visible mathematics from the frozen declaration header without inventing missing section variables. */
export function installedLibraryMathematics(entry: InstalledLibraryEntry, moduleImport: string): InstalledLibraryMathematics {
  const colon = topLevelColon(entry.type), header = colon < 0 ? entry.type : entry.type.slice(0, colon);
  const matching = entry.name === 'TheoremOS.Combinatorics.LooplessMultigraph.Matching';
  const expression = definitionBodies[entry.name]
    ?? (colon < 0 ? entry.type : entry.type.slice(colon + 1).trim()).replace(/\s+where\s.+$/u, '');
  const conclusion = generalConclusion(entry, expression);
  return { summary: explanations[entry.name] ?? conclusion,
    conditions: matching ? [{ label: text('参数 G', 'Input G'), expression: 'G : LooplessMultigraph V E',
      meaning: text('顶点类型 V、边类型 E 上的无自环多重图', 'a loopless multigraph on vertex type V and edge type E') }]
      : binderGroups(header).map(condition), conclusion, expression,
    usage: `${moduleImport}\n\n#check ${entry.name}\n#check @${entry.name}`,
    context: text('参数与假设沿用所在模块的上下文；#check @ 可展开全部隐式参数。',
      'Parameters and assumptions also follow the module context; #check @ displays all implicit parameters.') };
}
