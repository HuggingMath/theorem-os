import type { WebExplanationDocument } from '../../apps/web/shared';

export const demoOriginal = '康托–施罗德–伯恩斯坦定理（Cantor–Schröder–Bernstein）：设 A、B 是任意集合（或类型），允许为空，不假设有限或可数。已知单射 f : A → B 与 g : B → A。请显式构造一个函数 h : A → B，并严格证明 h 是双射。不得直接引用康托–施罗德–伯恩斯坦定理或任何等价的现成结论。';

export const demoSource = `import Mathlib
namespace CantorBernsteinDemo
theorem cantor_bernstein {A B : Type*}
    (f : A → B) (g : B → A)
    (hf : Function.Injective f) (hg : Function.Injective g) :
    ∃ h : A → B, Function.Bijective h := by
  sorry
end CantorBernsteinDemo
`;

export const demoTask = '证明要求：定义初始层 A₀ = A \\ g(B)，递归定义 Aₙ₊₁ = g(f(Aₙ))，再令 S = ⋃ₙ Aₙ。在 S 上使用 f，在补集上使用 g 的唯一原像来定义 h。明确证明补集上原像存在、S 在 g ∘ f 下封闭、g(b) ∈ S 时的前驱引理，然后逐一处理单射性的四种分支与满射性的两种分支。所有辅助结论都要给出证明，解释为什么不需要假设 A 或 B 非空，并提供可逐步展开的 Lean 候选代码与数学说明。';

/** Local frontend simulation candidate. This fixture does not compile or accept Lean. */
export const demoProof = `import Mathlib

namespace CantorBernsteinDemo

-- Local frontend simulation candidate; uncompiled and not accepted.
universe u v
variable {A : Type u} {B : Type v}

def stage (f : A → B) (g : B → A) : ℕ → Set A
  | 0 => {a | ¬ ∃ b, g b = a}
  | n + 1 => {a | ∃ x, x ∈ stage f g n ∧ g (f x) = a}

def good (f : A → B) (g : B → A) : Set A :=
  {a | ∃ n, a ∈ stage f g n}

lemma good_of_no_preimage (f : A → B) (g : B → A) {a : A}
    (ha : ¬ ∃ b, g b = a) : a ∈ good f g :=
  ⟨0, ha⟩

lemma forward_good (f : A → B) (g : B → A) {a : A}
    (ha : a ∈ good f g) : g (f a) ∈ good f g := by
  rcases ha with ⟨n, hn⟩
  exact ⟨n + 1, ⟨a, hn, rfl⟩⟩

lemma outside_has_preimage (f : A → B) (g : B → A) {a : A}
    (ha : a ∉ good f g) : ∃ b, g b = a := by
  classical
  by_contra hnone
  exact ha (good_of_no_preimage f g hnone)

lemma good_predecessor (f : A → B) (g : B → A)
    (hg : Function.Injective g) {b : B}
    (hgb : g b ∈ good f g) :
    ∃ a, a ∈ good f g ∧ f a = b := by
  rcases hgb with ⟨n, hn⟩
  cases n with
  | zero =>
      exact False.elim (hn ⟨b, rfl⟩)
  | succ n =>
      rcases hn with ⟨a, ha, hga⟩
      exact ⟨a, ⟨n, ha⟩, hg hga⟩

noncomputable def candidate (f : A → B) (g : B → A) (a : A) : B := by
  classical
  exact if ha : a ∈ good f g then f a
    else Classical.choose (outside_has_preimage f g ha)

lemma candidate_good (f : A → B) (g : B → A) {a : A}
    (ha : a ∈ good f g) : candidate f g a = f a := by
  classical
  simp only [candidate, dif_pos ha]

lemma candidate_bad (f : A → B) (g : B → A) {a : A}
    (ha : a ∉ good f g) : g (candidate f g a) = a := by
  classical
  simpa only [candidate, dif_neg ha] using
    Classical.choose_spec (outside_has_preimage f g ha)

theorem cantor_bernstein (f : A → B) (g : B → A)
    (hf : Function.Injective f) (hg : Function.Injective g) :
    ∃ h : A → B, Function.Bijective h := by
  classical
  refine ⟨candidate f g, ?_, ?_⟩
  · intro a a' heq
    by_cases ha : a ∈ good f g
    · by_cases ha' : a' ∈ good f g
      · apply hf
        calc
          f a = candidate f g a := (candidate_good f g ha).symm
          _ = candidate f g a' := heq
          _ = f a' := candidate_good f g ha'
      · have hleft : g (f a) = a' := by
          calc
            g (f a) = g (candidate f g a) :=
              congrArg g (candidate_good f g ha).symm
            _ = g (candidate f g a') := congrArg g heq
            _ = a' := candidate_bad f g ha'
        exact False.elim (ha' (hleft ▸ forward_good f g ha))
    · by_cases ha' : a' ∈ good f g
      · have hright : g (f a') = a := by
          calc
            g (f a') = g (candidate f g a') :=
              congrArg g (candidate_good f g ha').symm
            _ = g (candidate f g a) := congrArg g heq.symm
            _ = a := candidate_bad f g ha
        exact False.elim (ha (hright ▸ forward_good f g ha'))
      · calc
          a = g (candidate f g a) := (candidate_bad f g ha).symm
          _ = g (candidate f g a') := congrArg g heq
          _ = a' := candidate_bad f g ha'
  · intro b
    by_cases hgb : g b ∈ good f g
    · obtain ⟨a, ha, hfa⟩ := good_predecessor f g hg hgb
      exact ⟨a, (candidate_good f g ha).trans hfa⟩
    · refine ⟨g b, ?_⟩
      apply hg
      exact candidate_bad f g hgb

end CantorBernsteinDemo
`;

const sections: WebExplanationDocument['sections'] = [
  {
    name: 'CantorBernsteinDemo.stage', kind: 'definition', target: false, title: '递归层：从没有 g 原像的点出发',
    statement: '定义 $A_0=A\\setminus g(B)$，以及 $A_{n+1}=g(f(A_n))$。层数 $n$ 是自然数，不意味着集合 $A$ 或 $B$ 可数。',
    lines: { start: 9, end: 11 }, signature: { start: 9, end: 11 }, unexplained: [], statementReviews: [],
    steps: [
      { text: '第零层由所有不存在 $g$ 原像的点组成，写成 $a\\in A_0\\iff\\neg\\exists b,\ g(b)=a$。如果 $g$ 已经满射，这一层可以为空。', uses: [], lines: [{ start: 9, end: 10 }], reviews: [] },
      { text: '下一层是上一层在 $g\\circ f$ 下的像：$a\\in A_{n+1}$ 表示存在 $x\\in A_n$ 且 $g(f(x))=a$。这是对自然数的递归定义，不需要预先选定任何集合元素。', uses: [], lines: [{ start: 11, end: 11 }], reviews: [] },
    ],
  },
  {
    name: 'CantorBernsteinDemo.good', kind: 'definition', target: false, title: '分支集合 S：所有递归层的并',
    statement: '$S=\\bigcup_{n\\in\\mathbb N}A_n$，等价地，$a\\in S\\iff\\exists n,\ a\\in A_n$。',
    lines: { start: 13, end: 14 }, signature: { start: 13, end: 14 }, unexplained: [], statementReviews: [],
    steps: [{ text: '用“存在一个层数”表示可数并。每一层本身可以有任意基数；后续只依赖这个存在量词，不枚举 $A$ 或 $B$ 的元素。', uses: [{ name: 'CantorBernsteinDemo.stage', place: 'step', spans: [] }], lines: [{ start: 13, end: 14 }], reviews: [] }],
  },
  {
    name: 'CantorBernsteinDemo.good_of_no_preimage', kind: 'theorem', target: false, title: '辅助引理：没有原像的点属于 S',
    statement: '如果不存在 $b\\in B$ 使 $g(b)=a$，那么 $a\\in S$。',
    lines: { start: 16, end: 18 }, signature: { start: 16, end: 17 }, unexplained: [], statementReviews: [],
    steps: [{ text: '没有 $g$ 原像恰好说明 $a\\in A_0$，以层数 $0$ 为见证即可得到 $a\\in S$。这一步直接使用递归层和并集的定义。', uses: [{ name: 'CantorBernsteinDemo.good', place: 'declaration', spans: [] }, { name: 'CantorBernsteinDemo.stage', place: 'implicit', spans: [] }], lines: [{ start: 18, end: 18 }], reviews: [] }],
  },
  {
    name: 'CantorBernsteinDemo.forward_good', kind: 'theorem', target: false, title: '辅助引理：S 对 g ∘ f 封闭',
    statement: '若 $a\\in S$，则 $g(f(a))\\in S$。',
    lines: { start: 20, end: 23 }, signature: { start: 20, end: 21 }, unexplained: [], statementReviews: [],
    steps: [
      { text: '从 $a\\in S$ 取出一个层数 $n$，满足 $a\\in A_n$。', uses: [{ name: 'CantorBernsteinDemo.good', place: 'declaration', spans: [] }], lines: [{ start: 22, end: 22 }], reviews: [] },
      { text: '按下一层的定义，取前驱 $a$ 就得到 $g(f(a))\\in A_{n+1}$；再以 $n+1$ 为见证，得到它属于 $S$。', uses: [{ name: 'CantorBernsteinDemo.stage', place: 'implicit', spans: [] }], lines: [{ start: 23, end: 23 }], reviews: [] },
    ],
  },
  {
    name: 'CantorBernsteinDemo.outside_has_preimage', kind: 'theorem', target: false, title: '辅助引理：补集上的原像确实存在',
    statement: '若 $a\\notin S$，则存在 $b\\in B$ 满足 $g(b)=a$。',
    lines: { start: 25, end: 29 }, signature: { start: 25, end: 26 }, unexplained: [], statementReviews: [],
    steps: [
      { text: '使用经典反证法。假设这样的 $b$ 不存在，就可以应用“没有原像的点属于 $S$”这一辅助引理。', uses: [], lines: [{ start: 27, end: 28 }], reviews: [] },
      { text: '得到 $a\\in S$，与假设 $a\\notin S$ 矛盾，所以原像存在。之后若需要唯一性，它由 $g$ 的单射性立即给出：$g(b_1)=a=g(b_2)$ 推出 $b_1=b_2$。', uses: [{ name: 'CantorBernsteinDemo.good_of_no_preimage', place: 'step', spans: [] }], lines: [{ start: 29, end: 29 }], reviews: [] },
    ],
  },
  {
    name: 'CantorBernsteinDemo.good_predecessor', kind: 'theorem', target: false, title: '辅助引理：g(b) 属于 S 时，b 有 S 中的 f 原像',
    statement: '若 $g$ 为单射且 $g(b)\\in S$，则存在 $a\\in S$ 使 $f(a)=b$。',
    lines: { start: 31, end: 41 }, signature: { start: 31, end: 34 }, unexplained: [], statementReviews: [],
    steps: [
      { text: '取层数 $n$ 使 $g(b)\\in A_n$，并区分 $n=0$ 与 $n=k+1$。', uses: [{ name: 'CantorBernsteinDemo.good', place: 'declaration', spans: [] }], lines: [{ start: 35, end: 36 }], reviews: [] },
      { text: '第零层不可能：它的元素没有 $g$ 原像，但这里的 $b$ 本身就是 $g(b)$ 的原像，形成矛盾。', uses: [{ name: 'CantorBernsteinDemo.stage', place: 'implicit', spans: [] }], lines: [{ start: 37, end: 38 }], reviews: [] },
      { text: '若 $n=k+1$，层的定义给出 $a\\in A_k$ 和 $g(f(a))=g(b)$。由 $g$ 单射，得到 $f(a)=b$；又因 $a\\in A_k$，所以 $a\\in S$。', uses: [{ name: 'CantorBernsteinDemo.stage', place: 'implicit', spans: [] }], lines: [{ start: 39, end: 41 }], reviews: [] },
    ],
  },
  {
    name: 'CantorBernsteinDemo.candidate', kind: 'definition', target: false, title: '构造 h：在 S 上向前，在补集上取原像',
    statement: '$h(a)=f(a)$（当 $a\\in S$）；当 $a\\notin S$ 时，令 $h(a)$ 是满足 $g(h(a))=a$ 的原像。',
    lines: { start: 43, end: 46 }, signature: { start: 43, end: 46 }, unexplained: [], statementReviews: [],
    steps: [
      { text: '用经典分情况区分 $a\\in S$ 与 $a\\notin S$。第一种情况直接返回 $f(a)$。', uses: [{ name: 'CantorBernsteinDemo.good', place: 'step', spans: [] }], lines: [{ start: 43, end: 45 }], reviews: [] },
      { text: '第二种情况先由补集原像引理证明存在性，再从这个存在证明中选取原像。这里没有定义一个需要默认值的全域逆函数，因此不需要 $A$ 或 $B$ 非空。即使 $B$ 为空，也不会在没有存在证明时选取其中的元素。', uses: [{ name: 'CantorBernsteinDemo.outside_has_preimage', place: 'step', spans: [] }, { name: 'Classical.choose', place: 'step', spans: [] }], lines: [{ start: 46, end: 46 }], reviews: [] },
    ],
  },
  {
    name: 'CantorBernsteinDemo.candidate_good', kind: 'theorem', target: false, title: '分支等式一：S 上 h 等于 f',
    statement: '若 $a\\in S$，则 $h(a)=f(a)$。',
    lines: { start: 48, end: 51 }, signature: { start: 48, end: 49 }, unexplained: [], statementReviews: [],
    steps: [{ text: '把 $a\\in S$ 代入分段定义，条件分支选择第一项，所以 $h(a)=f(a)$。', uses: [{ name: 'CantorBernsteinDemo.candidate', place: 'step', spans: [] }], lines: [{ start: 50, end: 51 }], reviews: [] }],
  },
  {
    name: 'CantorBernsteinDemo.candidate_bad', kind: 'theorem', target: false, title: '分支等式二：补集上 g(h(a)) 等于 a',
    statement: '若 $a\\notin S$，则 $g(h(a))=a$。',
    lines: { start: 53, end: 57 }, signature: { start: 53, end: 54 }, unexplained: [], statementReviews: [],
    steps: [
      { text: '把 $a\\notin S$ 代入分段定义，函数值变成从存在证明中选择出的原像。', uses: [{ name: 'CantorBernsteinDemo.candidate', place: 'step', spans: [] }], lines: [{ start: 55, end: 56 }], reviews: [] },
      { text: '选择操作的规格说明被选元素满足原存在命题，因此 $g(h(a))=a$。这就是后续证明实际使用的逆像性质，无须另设一个全域逆函数。', uses: [{ name: 'Classical.choose_spec', place: 'step', spans: [] }, { name: 'CantorBernsteinDemo.outside_has_preimage', place: 'step', spans: [] }], lines: [{ start: 56, end: 57 }], reviews: [] },
    ],
  },
  {
    name: 'CantorBernsteinDemo.cantor_bernstein', kind: 'theorem', target: true, title: '康托–施罗德–伯恩斯坦：由两个单射构造双射',
    statement: '对任意可能为空的类型 $A,B$，若 $f:A\\to B$ 与 $g:B\\to A$ 都是单射，则存在双射 $h:A\\to B$。证明不使用有限、可数或非空假设。',
    lines: { start: 59, end: 97 }, signature: { start: 59, end: 61 }, unexplained: [], statementReviews: [],
    steps: [
      { text: '取上面构造的分段函数 $h$。接下来分别证明单射性与满射性；构造已经保证每个分支有定义，因此空类型的情况也包含在内。', uses: [{ name: 'CantorBernsteinDemo.candidate', place: 'step', spans: [] }], lines: [{ start: 62, end: 63 }], reviews: [] },
      { text: '证明单射：任取 $a,a^{\\prime}$ 并假设 $h(a)=h(a^{\\prime})$，按照它们是否属于 $S$ 分成四种情况。这里只使用集合成员关系分类，没有引入任何大小或可数性条件。', uses: [{ name: 'CantorBernsteinDemo.good', place: 'step', spans: [] }], lines: [{ start: 64, end: 66 }, { start: 79, end: 79 }], reviews: [] },
      { text: '情况一，两点都在 $S$ 中。两个函数值分别等于 $f(a)$ 和 $f(a^{\\prime})$；由 $h(a)=h(a^{\\prime})$ 得到 $f(a)=f(a^{\\prime})$，再由 $f$ 单射得到 $a=a^{\\prime}$。', uses: [{ name: 'CantorBernsteinDemo.candidate_good', place: 'step', spans: [] }], lines: [{ start: 67, end: 71 }], reviews: [] },
      { text: '情况二，$a\\in S$ 而 $a^{\\prime}\\notin S$。对相等的函数值应用 $g$，得到 $g(f(a))=a^{\\prime}$。因为 $S$ 对 $g\\circ f$ 封闭，左边在 $S$，于是 $a^{\\prime}\\in S$，矛盾。这排除了两个分支相撞的可能。', uses: [{ name: 'CantorBernsteinDemo.candidate_good', place: 'step', spans: [] }, { name: 'CantorBernsteinDemo.candidate_bad', place: 'step', spans: [] }, { name: 'CantorBernsteinDemo.forward_good', place: 'step', spans: [] }], lines: [{ start: 72, end: 78 }], reviews: [] },
      { text: '情况三，$a\\notin S$ 而 $a^{\\prime}\\in S$。反向使用函数值等式，同样得到 $g(f(a^{\\prime}))=a$；封闭性推出 $a\\in S$，与假设矛盾。候选代码把这个对称分支完整写出。', uses: [{ name: 'CantorBernsteinDemo.candidate_good', place: 'step', spans: [] }, { name: 'CantorBernsteinDemo.candidate_bad', place: 'step', spans: [] }, { name: 'CantorBernsteinDemo.forward_good', place: 'step', spans: [] }], lines: [{ start: 80, end: 86 }], reviews: [] },
      { text: '情况四，两点都不在 $S$ 中。利用补集分支等式，$a=g(h(a))=g(h(a^{\\prime}))=a^{\\prime}$。四种情况均已覆盖，因此 $h$ 是单射。', uses: [{ name: 'CantorBernsteinDemo.candidate_bad', place: 'step', spans: [] }], lines: [{ start: 87, end: 90 }], reviews: [] },
      { text: '证明满射：任取 $b\\in B$，按照 $g(b)$ 是否属于 $S$ 分成两种情况。我们将为每一种情况明确给出 $b$ 在 $h$ 下的原像。', uses: [{ name: 'CantorBernsteinDemo.good', place: 'step', spans: [] }], lines: [{ start: 91, end: 92 }], reviews: [] },
      { text: '若 $g(b)\\in S$，前驱引理给出一个 $a\\in S$，满足 $f(a)=b$。因为 $h$ 在 $S$ 上等于 $f$，便有 $h(a)=b$。前驱引理中排除了第零层，并在正层使用了 $g$ 的单射性。', uses: [{ name: 'CantorBernsteinDemo.good_predecessor', place: 'step', spans: [] }, { name: 'CantorBernsteinDemo.candidate_good', place: 'step', spans: [] }], lines: [{ start: 93, end: 94 }], reviews: [] },
      { text: '若 $g(b)\\notin S$，直接取 $a=g(b)$。补集分支等式给出 $g(h(g(b)))=g(b)$，由 $g$ 单射消去两侧的 $g$，得到 $h(g(b))=b$。', uses: [{ name: 'CantorBernsteinDemo.candidate_bad', place: 'step', spans: [] }], lines: [{ start: 95, end: 97 }], reviews: [] },
      { text: '于是每个 $b$ 都有原像，$h$ 是满射；结合前面证明的单射性，得到所求双射。本地模拟候选中没有调用现成的康托–施罗德–伯恩斯坦结论；这些代码尚未经过 Lean 编译或验收。', uses: [], lines: [{ start: 63, end: 63 }, { start: 91, end: 97 }], reviews: [] },
    ],
  },
];

const proofLines = sections.filter((section) => section.kind === 'theorem')
  .reduce((count, section) => count + section.lines.end - section.signature.end, 0);

export const demoExplanation: WebExplanationDocument = {
  schema: 'theorem-os.web-explanation.v1', target: 'CantorBernsteinDemo.cantor_bernstein', language: 'zh',
  toolchain: 'frontend-simulation-uncompiled', mathlibRevision: null,
  overview: '本地前端模拟讲解：从不在 g 像中的点开始逐层构造 S，在 S 上用 f、补集上用 g 的原像，然后证明单射性的四种情况与满射性的两种情况。辅助引理可逐层展开，允许空类型。本次只验证展示与交互；候选 Lean 未编译、未验收，也没有真实模型或审核结果。',
  axioms: [], sections: [...sections].sort((left, right) => left.lines.start - right.lines.start),
  metrics: { declarations: sections.length, steps: sections.reduce((count, section) => count + section.steps.length, 0),
    citations: sections.reduce((count, section) => count + section.steps.reduce((total, step) => total + step.uses.length, 0), 0),
    excerptCoverage: 1, proofLines, explainedLines: proofLines, ambiguousExcerpts: 0 },
  model: 'local-fixture', effort: 'high', auditors: 0, rounds: 0, tokens: null,
};

export const demoQuestion = '请用 A = B = ℕ、f(n) = 2n、g(n) = n + 1 演示这个构造。证明每一层与 S 的公式，给出 h(0) 到 h(9) 的两列表格，并说明补集分支的减法为什么有效。';

export const demoAnswer = [
  '【本地模拟回答，未编译、未验收】在 $A=B=\\mathbb N$、$f(n)=2n$、$g(n)=n+1$ 时，两个函数均为单射：$2a=2b$ 推出 $a=b$，$a+1=b+1$ 也推出 $a=b$。下面演示前述构造；这不是本次真实模型运行或 Lean 验收的结果。',
  '由于 $g(\\mathbb N)=\\{1,2,3,\\ldots\\}$，初始层 $A_0=\\{0\\}$。递归映射是 $(g\\circ f)(x)=2x+1$。以 $k$ 表示层数，归纳证明 $A_k=\\{2^k-1\\}$：$k=0$ 时公式给出 $\\{0\\}$；若第 $k$ 层只有 $2^k-1$，下一层只有 $2(2^k-1)+1=2^{k+1}-1$，归纳完成。',
  '因此 $S=\\{2^k-1:k\\in\\mathbb N\\}=\\{0,1,3,7,15,\\ldots\\}$。构造得到 $h(n)=2n$（当 $n\\in S$），而 $h(n)=n-1$（当 $n\\notin S$）。下面表格中的 $n$ 是函数输入，与上面的层数 $k$ 不同。',
  '| n | h(n) |\n| --- | --- |\n| 0 | 0 |\n| 1 | 2 |\n| 2 | 1 |\n| 3 | 6 |\n| 4 | 3 |\n| 5 | 4 |\n| 6 | 5 |\n| 7 | 14 |\n| 8 | 7 |\n| 9 | 8 |',
  '补集分支不会遇到 $n=0$，因为 $0\\in S$。因此在这个分支上 $n\\ge1$，且 $(n-1)+1=n$，所以 $n-1$ 确实是 $g$ 的原像。Lean 自然数上的截断减法与通常的非负整数减法在这里一致，不需要把函数值放到整数中。',
  '还可以直接看出满射性。若目标值 $b$ 满足 $b+1\\in S$，则 $b+1=2^k-1$；因为 $b+1\\ge1$，必有 $k\\ge1$，取 $a=2^{k-1}-1\\in S$，即有 $h(a)=2^k-2=b$。若 $b+1\\notin S$，取 $a=b+1$，补集分支给出 $h(a)=b$。单射性由主证明的四个分支保证；前十个数的表格只是例子，并不是全体自然数上双射性的证明。',
].join('\n\n');
