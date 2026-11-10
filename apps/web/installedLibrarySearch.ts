// Browser-safe, finite topic vocabulary for the installed mathematical content.
// Declaration names/types still use literal search; unknown words never disappear from a match.
const aliases: Record<string, readonly string[]> = {
  // Finite sums and the affine_recurrence family.
  'TheoremOS.Algebra.FiniteSums': [
    '数列求和', '递推数列求和', '递推求和', '一阶线性递推', '如何求递推数列的和',
    'sequence sums', 'recurrence sums', 'first order linear recurrence',
  ],
  // sum_filter_le_of_subgaussian, Hoeffding tails and Bernoulli relative-entropy tails.
  'TheoremOS.Probability.Concentration': [
    '尾概率', '尾概率估计', '尾概率上界', '尾部概率', '如何估计随机变量的尾概率',
    '切尔诺夫界', '霍夫丁不等式', 'tail probability', 'tail probabilities', 'tail bound', 'tail bounds', 'chernoff bound',
  ],
  'TheoremOS.Algebra.PolynomialRoots': ['拉格朗日插值', 'lagrange interpolation'],
  'TheoremOS.Analysis.FiniteConvexity': ['詹森不等式', '琴生不等式', 'jensen inequality'],
  // weighted_cauchy_sq and prod_le_mean_pow.
  'TheoremOS.Analysis.FiniteInequalities': [
    '柯西不等式', '柯西施瓦茨不等式', '柯西-施瓦茨不等式', '算术几何均值不等式',
    'cauchy schwarz inequality', 'cauchy-schwarz inequality', 'am-gm inequality',
  ],
  // Fiber capacity bounds and existence of a fiber over capacity.
  'TheoremOS.Combinatorics.FiniteCounting': ['鸽巢原理', '抽屉原理', 'pigeonhole principle'],
  'TheoremOS.Combinatorics.EditDistance': ['莱文斯坦距离', '勒文斯坦距离', 'levenshtein distance', 'lcs'],
  'TheoremOS.InformationTheory.Divergence': ['kl散度', 'kl 散度', 'kl divergence', 'kullback leibler divergence', 'kullback-leibler divergence'],
  'TheoremOS.NumberTheory.Congruences': ['crt', 'chinese remainder', '中国剩余'],
  'TheoremOS.Probability.FiniteProbability': ['马尔可夫不等式', '切比雪夫不等式', 'markov inequality', 'chebyshev inequality'],
};

const concepts: Record<string, readonly string[]> = {
  recurrence: ['递推', '递归数列', 'recurrence', 'recurrences', 'recursive sequence'],
  sequence: ['数列', 'sequence', 'sequences'],
  sum: ['求和', '总和', '和', 'summation', 'sums', 'sum'],
  tail: ['尾部概率', '尾概率', '尾部界', '尾界', 'tail probabilities', 'tail probability', 'tail bounds', 'tail bound'],
  independent: ['相互独立', '独立', 'independence', 'independent'],
  chernoff: ['切尔诺夫界', '切诺夫界', 'chernoff bound', 'chernoff'],
  hoeffding: ['霍夫丁不等式', '霍夫丁界', 'hoeffding inequality', 'hoeffding bound', 'hoeffding'],
  interpolation: ['拉格朗日插值', '插值', 'lagrange interpolation', 'interpolation'],
  jensen: ['詹森不等式', '琴生不等式', '詹森', '琴生', 'jensen inequality', 'jensen'],
  cauchy: ['柯西施瓦茨不等式', '柯西-施瓦茨不等式', '柯西不等式', 'cauchy schwarz inequality', 'cauchy-schwarz inequality', 'cauchy schwarz', 'cauchy-schwarz'],
  amgm: ['算术几何均值不等式', '均值不等式', 'am-gm inequality', 'am gm inequality', 'am-gm'],
  pigeonhole: ['鸽巢原理', '抽屉原理', 'pigeonhole principle', 'pigeonhole'],
  editDistance: ['莱文斯坦距离', '勒文斯坦距离', '编辑距离', 'levenshtein distance', 'edit distance'],
  subsequence: ['最长公共子序列', 'longest common subsequence', 'lcs'],
  divergence: ['相对熵', 'kl散度', 'kl 散度', 'kl divergence', 'relative entropy', 'kullback leibler divergence', 'kullback-leibler divergence'],
  congruence: ['中国剩余定理', '中国剩余', 'chinese remainder theorem', 'chinese remainder', 'crt'],
  markov: ['马尔可夫不等式', 'markov inequality'],
  chebyshev: ['切比雪夫不等式', 'chebyshev inequality'],
};
const moduleConcepts: Record<string, readonly string[]> = {
  'TheoremOS.Algebra.FiniteSums': ['recurrence', 'sequence', 'sum'],
  'TheoremOS.Probability.Concentration': ['tail', 'independent', 'chernoff', 'hoeffding'],
  'TheoremOS.BooleanCube.Product': ['independent'],
  'TheoremOS.Algebra.PolynomialRoots': ['interpolation'],
  'TheoremOS.Analysis.FiniteConvexity': ['jensen'],
  'TheoremOS.Analysis.FiniteInequalities': ['cauchy', 'amgm'],
  'TheoremOS.Combinatorics.FiniteCounting': ['pigeonhole'],
  'TheoremOS.Combinatorics.EditDistance': ['editDistance', 'subsequence'],
  'TheoremOS.InformationTheory.Divergence': ['divergence'],
  'TheoremOS.NumberTheory.Congruences': ['congruence'],
  'TheoremOS.Probability.FiniteProbability': ['markov', 'chebyshev'],
};
const words = [
  ...Object.entries(concepts).flatMap(([concept, phrases]) => phrases.map(phrase => ({ phrase, concept }))),
  ...['如何', '怎么', '怎样', '请', '求', '的', '估计', '计算', '随机变量', '上界', '界',
    'how to', 'find', 'compute', 'estimate', 'for', 'of', 'the', 'a', 'an', 'random variables', 'random variable']
    .map(phrase => ({ phrase, concept: '' })),
].sort((left, right) => right.phrase.length - left.phrase.length);
const normalize = (query: string) => query.toLowerCase().trim().replace(/\s+/gu, ' ');
function queryConcepts(query: string) {
  let rest = normalize(query), unknown = false;
  const found = new Set<string>();
  while (rest) {
    rest = rest.replace(/^[\s,，。?？、]+/u, '');
    if (!rest) break;
    const word = words.find(({ phrase }) => rest.startsWith(phrase)
      && (!/[a-z\d]$/u.test(phrase) || !/^[a-z\d_]/u.test(rest.slice(phrase.length))));
    if (word) {
      if (word.concept) found.add(word.concept);
      rest = rest.slice(word.phrase.length);
    } else {
      unknown = true;
      // Retain the failure for matching, but still find related known concepts for suggestions.
      rest = rest.slice(/^[a-z\d_.]+/u.exec(rest)?.[0].length ?? 1);
    }
  }
  return { found: [...found], unknown };
}

/** A recognized topic opens the module overview; it does not identify a particular interface. */
export function matchesInstalledLibraryModuleAlias(name: string, query: string): boolean {
  if (Object.hasOwn(aliases, name) && aliases[name].includes(normalize(query))) return true;
  const { found, unknown } = queryConcepts(query);
  return !unknown && found.length > 0 && Object.hasOwn(moduleConcepts, name)
    && found.every(concept => moduleConcepts[name].includes(concept));
}

const suggestions = [
  { zh: '尾概率 独立', en: 'independent tail bounds', concepts: ['tail', 'independent', 'chernoff', 'hoeffding'] },
  { zh: '递推数列求和', en: 'recurrence sums', concepts: ['recurrence', 'sequence', 'sum'] },
  { zh: '拉格朗日插值', en: 'Lagrange interpolation', concepts: ['interpolation'] },
  { zh: '柯西不等式', en: 'Cauchy-Schwarz inequality', concepts: ['cauchy', 'amgm'] },
  { zh: '最长公共子序列', en: 'longest common subsequence', concepts: ['editDistance', 'subsequence'] },
  { zh: '相对熵', en: 'relative entropy', concepts: ['divergence'] },
];
/** Related supported queries, never generated answers or declarations. */
export function installedLibraryQuerySuggestions(query: string): { zh: string; en: string }[] {
  const { found } = queryConcepts(query);
  return suggestions.map((suggestion, index) => ({ ...suggestion, index,
    score: suggestion.concepts.filter(concept => found.includes(concept)).length }))
    .sort((left, right) => right.score - left.score || left.index - right.index).slice(0, 3)
    .map(({ zh, en }) => ({ zh, en }));
}
