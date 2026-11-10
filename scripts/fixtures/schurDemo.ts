import type { WebExplanationDocument } from '../../apps/web/shared';

/** Frontend simulation candidate. This test has not compiled or accepted this Lean source. */
export const schurDemoProof = `import Mathlib

namespace SchurCubic

-- Frontend simulation candidate; not compiled in this test.
def gap (a b c : ℝ) : ℝ :=
  a ^ 3 + b ^ 3 + c ^ 3 + 3 * a * b * c -
    (a * b * (a + b) + b * c * (b + c) + c * a * (c + a))

lemma gap_eq (x y z : ℝ) :
    gap x y z =
      (x - y) ^ 2 * (x + y - z) + z * (x - z) * (y - z) := by
  unfold gap
  ring

lemma schur_sorted (x y z : ℝ) (hz : 0 ≤ z) (hyz : z ≤ y) (hxy : y ≤ x) :
    0 ≤ gap x y z := by
  have hsum : 0 ≤ x + y - z := by linarith
  rw [gap_eq]
  exact add_nonneg
    (mul_nonneg (sq_nonneg (x - y)) hsum)
    (mul_nonneg
      (mul_nonneg hz (sub_nonneg.mpr (le_trans hyz hxy)))
      (sub_nonneg.mpr hyz))

theorem schur (a b c : ℝ) (ha : 0 ≤ a) (hb : 0 ≤ b) (hc : 0 ≤ c) :
    a * b * (a + b) + b * c * (b + c) + c * a * (c + a) ≤
      a ^ 3 + b ^ 3 + c ^ 3 + 3 * a * b * c := by
  rcases le_total a b with hab | hba
  · rcases le_total b c with hbc | hcb
    · have h := schur_sorted c b a ha hab hbc
      dsimp [gap] at h
      nlinarith only [h]
    · rcases le_total a c with hac | hca
      · have h := schur_sorted b c a ha hac hcb
        dsimp [gap] at h
        nlinarith only [h]
      · have h := schur_sorted b a c hc hca hab
        dsimp [gap] at h
        nlinarith only [h]
  · rcases le_total a c with hac | hca
    · have h := schur_sorted c a b hb hba hac
      dsimp [gap] at h
      nlinarith only [h]
    · rcases le_total b c with hbc | hcb
      · have h := schur_sorted a c b hb hbc hca
        dsimp [gap] at h
        nlinarith only [h]
      · have h := schur_sorted a b c hc hcb hba
        dsimp [gap] at h
        nlinarith only [h]

end SchurCubic
`;

const sections: WebExplanationDocument['sections'] = [
  {
    name: 'SchurCubic.schur', kind: 'theorem', target: true, title: '三次 Schur 不等式',
    statement: '对任意 $a,b,c\\ge 0$，证明 $a^3+b^3+c^3+3abc\\ge ab(a+b)+bc(b+c)+ca(c+a)$。允许零值，不添加归一化或大小顺序假设。',
    lines: { start: 26, end: 51 }, signature: { start: 26, end: 28 }, unexplained: [], statementReviews: [],
    steps: [
      {
        text: '固定任意三个非负实数。保留全部三个非负假设；不除以变量或变量之和，因此零值边界也在证明范围内。',
        uses: [], lines: [{ start: 26, end: 28 }], reviews: [],
      },
      {
        text: '使用实数的全序性分情况比较变量，覆盖 $a\\le b\\le c$、$a\\le c\\le b$、$c\\le a\\le b$、$b\\le a\\le c$、$b\\le c\\le a$、$c\\le b\\le a$ 六种顺序。相等时分支可以重叠，但没有遗漏。',
        uses: [{ name: 'le_total', place: 'step', spans: [] }],
        lines: [{ start: 29, end: 30 }, { start: 34, end: 34 }, { start: 41, end: 41 }, { start: 45, end: 45 }], reviews: [],
      },
      {
        text: '每个分支把最大、中间、最小的变量分别记作 $x,y,z$，从原假设得到 $x\\ge y\\ge z\\ge0$。例如 $a\\le b\\le c$ 时取 $(x,y,z)=(c,b,a)$；这只是重排，不是对原题增加条件。',
        uses: [{ name: 'SchurCubic.schur_sorted', place: 'step', spans: [] }],
        lines: [{ start: 31, end: 31 }, { start: 35, end: 35 }, { start: 38, end: 38 }, { start: 42, end: 42 }, { start: 46, end: 46 }, { start: 49, end: 49 }], reviews: [],
      },
      {
        text: '排序引理使用恒等分解 $D(x,y,z)=(x-y)^2(x+y-z)+z(x-z)(y-z)$。排序后两项都非负，所以每个分支都有 $D(x,y,z)\\ge0$。展开下面的排序引理可查看每个因子的符号依据。',
        uses: [{ name: 'SchurCubic.schur_sorted', place: 'step', spans: [] }, { name: 'SchurCubic.gap_eq', place: 'declaration', spans: [] }],
        lines: [{ start: 31, end: 31 }, { start: 35, end: 35 }, { start: 38, end: 38 }, { start: 42, end: 42 }, { start: 46, end: 46 }, { start: 49, end: 49 }], reviews: [],
      },
      {
        text: '展开差值 $D$ 的定义。纯立方和、乘积 $abc$ 与三个无序变量对的项都对变量置换不变，因此重排后的差值就是原来的 $D(a,b,c)$。',
        uses: [{ name: 'SchurCubic.gap', place: 'step', spans: [] }],
        lines: [{ start: 32, end: 32 }, { start: 36, end: 36 }, { start: 39, end: 39 }, { start: 43, end: 43 }, { start: 47, end: 47 }, { start: 50, end: 50 }], reviews: [],
      },
      {
        text: '将 $D(a,b,c)\\ge0$ 移项，得到所求不等式。候选代码在各分支中用多项式规范化完成这一步；这里展示的是本地模拟代码，本次没有实际编译或验收。',
        uses: [], lines: [{ start: 33, end: 33 }, { start: 37, end: 37 }, { start: 40, end: 40 }, { start: 44, end: 44 }, { start: 48, end: 48 }, { start: 51, end: 51 }], reviews: [],
      },
    ],
  },
  {
    name: 'SchurCubic.gap', kind: 'definition', target: false, title: '差值 D：把不等式化为非负性',
    statement: '$D(a,b,c)=a^3+b^3+c^3+3abc-ab(a+b)-bc(b+c)-ca(c+a)$。',
    lines: { start: 6, end: 8 }, signature: { start: 6, end: 8 }, unexplained: [], statementReviews: [],
    steps: [{ text: '定义右侧减左侧的差值。原不等式恰好等价于 $D(a,b,c)\\ge0$；此处只是移项，没有使用待证结论。',
      uses: [], lines: [{ start: 6, end: 8 }], reviews: [] }],
  },
  {
    name: 'SchurCubic.gap_eq', kind: 'theorem', target: false, title: '辅助引理：恒等分解',
    statement: '对任意实数 $x,y,z$，有 $D(x,y,z)=(x-y)^2(x+y-z)+z(x-z)(y-z)$。这个恒等式本身不需要非负或排序假设。',
    lines: { start: 10, end: 14 }, signature: { start: 10, end: 12 }, unexplained: [], statementReviews: [],
    steps: [
      { text: '展开 $D$，将混合三次项按变量对分组。', uses: [{ name: 'SchurCubic.gap', place: 'step', spans: [] }], lines: [{ start: 13, end: 13 }], reviews: [] },
      { text: '展开右侧两项并合并同类项，恰好得到 $x^3+y^3+z^3+3xyz-x^2y-xy^2-y^2z-yz^2-z^2x-zx^2$，与差值相同。候选代码用 `ring` 表达这一纯代数核对。',
        uses: [], lines: [{ start: 14, end: 14 }], reviews: [] },
    ],
  },
  {
    name: 'SchurCubic.schur_sorted', kind: 'theorem', target: false, title: '辅助引理：排序后差值非负',
    statement: '若 $x\\ge y\\ge z\\ge0$，则 $D(x,y,z)\\ge0$。',
    lines: { start: 16, end: 24 }, signature: { start: 16, end: 17 }, unexplained: [], statementReviews: [],
    steps: [
      { text: '由排序得到 $x\\ge0$、$x-z\\ge0$、$y-z\\ge0$，以及 $x+y-z=x+(y-z)\\ge0$。',
        uses: [], lines: [{ start: 18, end: 18 }], reviews: [] },
      { text: '应用恒等分解，将差值写成两个乘积之和。', uses: [{ name: 'SchurCubic.gap_eq', place: 'step', spans: [] }], lines: [{ start: 19, end: 19 }], reviews: [] },
      { text: '平方 $(x-y)^2$ 非负，且 $x+y-z\\ge0$，所以第一项 $(x-y)^2(x+y-z)\\ge0$。',
        uses: [{ name: 'sq_nonneg', place: 'step', spans: [] }, { name: 'mul_nonneg', place: 'step', spans: [] }], lines: [{ start: 20, end: 21 }], reviews: [] },
      { text: '第二项的三个因子 $z,x-z,y-z$ 均非负，故 $z(x-z)(y-z)\\ge0$。两个非负数相加，得到 $D(x,y,z)\\ge0$。',
        uses: [{ name: 'mul_nonneg', place: 'step', spans: [] }, { name: 'add_nonneg', place: 'step', spans: [] }], lines: [{ start: 20, end: 24 }], reviews: [] },
    ],
  },
];

export const schurDemoExplanation: WebExplanationDocument = {
  schema: 'theorem-os.web-explanation.v1', target: 'SchurCubic.schur', language: 'zh',
  toolchain: 'frontend-simulation-uncompiled', mathlibRevision: null,
  overview: '本地前端模拟讲解：先定义差值，再证明恒等分解与排序非负引理，最后覆盖六种变量顺序。候选代码未在本次测试中编译或验收；下列数学说明不冒充模型审核结果。',
  axioms: [], sections: [...sections].sort((left, right) => left.lines.start - right.lines.start),
  metrics: { declarations: 4, steps: sections.reduce((n, section) => n + section.steps.length, 0),
    citations: sections.reduce((n, section) => n + section.steps.reduce((count, step) => count + step.uses.length, 0), 0),
    excerptCoverage: 1, proofLines: 32, explainedLines: 32, ambiguousExcerpts: 0 },
  model: 'local-fixture', effort: 'high', auditors: 0, rounds: 0, tokens: null,
};

export const schurEqualityQuestion = '什么时候取得等号？请证明完整的等号条件，并说明只有两个变量相等是否足够。';

export const schurEqualityAnswer = [
  '【本地模拟回答】等号当且仅当三者全相等，或者其中一个变量为 0、另外两个相等。允许全为 0，两个描述在该点重叠。',
  '为证明必要性，利用对称性重排为 $x\\ge y\\ge z\\ge0$。差值为 $D=(x-y)^2(x+y-z)+z(x-z)(y-z)$，两项都非负。若 $D=0$，两项必须分别为 0。',
  '如果 $x>y$，则 $x>0$，而 $x+y-z\\ge x>0$，所以第一项严格为正，与 $D=0$ 矛盾。因此必有 $x=y$。代回第二项得到 $z(x-z)^2=0$，故 $z=0$ 或 $x=z$：前者是两个较大变量相等且第三个为 0，后者是三者全相等。',
  '反过来，三者全相等时两项均为 0；若某变量为 0、其余两个相等，重排后为 $(t,t,0)$，两项也均为 0。因此这些条件既必要又充分。',
  '只有两个变量相等并不够。例如 $(a,b,c)=(1,1,\\tfrac12)$ 的差值为 $\\tfrac12(1-\\tfrac12)^2=\\tfrac18>0$。同样，只有一个变量为 0 也不够，例如 $(2,1,0)$ 的差值为 3。',
  '这一追问讲解是预先准备的模拟内容；本次没有调用真实模型或执行 Lean。',
].join('\n\n');
