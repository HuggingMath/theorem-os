import type { WebEnvironment } from './shared';
import { webTaskEnvironment } from './environment';

/** The same complete problems can begin with an original statement or a Lean declaration. */
export type ResearchExample = {
  id: string;
  name: string;
  nameEn: string;
  summary: string;
  summaryEn: string;
  original: string;
  originalEn: string;
  environment: WebEnvironment;
  source: string;
  task: string;
  taskEn: string;
};

const task = '证明原题中的全部定理，保持变量、类型、假设和结论不变。可使用 Mathlib 中已有引理；根据 Lean 编译反馈修复证明，并验收完整原题。';
const taskEn = 'Prove every theorem in the original problem without changing its variables, types, assumptions, or conclusions. Existing Mathlib lemmas may be used. Repair the proof using Lean compiler feedback and verify the complete original problem.';

export const researchExamples: readonly ResearchExample[] = [
  {
    id: 'add-zero', name: '自然数加零', nameEn: 'Adding zero',
    summary: '对任意自然数证明加零不变，只需 Lean 标准库。',
    summaryEn: 'Prove that adding zero leaves every natural number unchanged, using only the Lean standard library.',
    original: '证明：对任意自然数 n，都有 n + 0 = n。',
    originalEn: 'Prove that for every natural number n, n + 0 = n.',
    environment: webTaskEnvironment,
    source: 'theorem add_zero_trial (n : Nat) : n + 0 = n := by sorry\n',
    task: '证明这个自然数加零定理，保持原题声明不变。使用 Lean 标准库，根据 Lean 编译反馈修复证明，并验收完整原题。',
    taskEn: 'Prove this natural-number addition theorem without changing the original statement. Use the Lean standard library, repair the proof using Lean compiler feedback, and verify the complete original problem.',
  },
  {
    id: 'sum-of-squares', name: '平方和公式', nameEn: 'Sum of squares',
    summary: '对任意自然数证明有限平方和公式，结合归纳与代数化简。',
    summaryEn: 'Prove a finite sum formula for every natural number using induction and algebra.',
    original: '设 n 为任意自然数（允许 n = 0）。证明从 0 到 n 的整数平方和满足：\n\n6 × (0² + 1² + ⋯ + n²) = n(n + 1)(2n + 1)。\n\n求和包含两个端点；当 n = 0 时，左侧的和只有 0²。',
    originalEn: 'Let n be any natural number, including zero. Prove the finite sum identity:\n\n6 × (0² + 1² + ⋯ + n²) = n(n + 1)(2n + 1).\n\nThe sum includes both endpoints; for n = 0 it consists only of 0².',
    environment: 'mathlib',
    source: `import Mathlib

namespace SumOfSquares

theorem sum_squares (n : ℕ) :
    6 * (∑ i ∈ Finset.range (n + 1), i ^ 2) = n * (n + 1) * (2 * n + 1) := by
  sorry

end SumOfSquares
`, task, taskEn,
  },
  {
    id: 'cauchy-schwarz', name: '有限维柯西–施瓦茨不等式', nameEn: 'Finite Cauchy–Schwarz inequality',
    summary: '对任意长度的两列实数，比较内积的平方与平方和的乘积。',
    summaryEn: 'Bound the squared inner product of two real sequences by the product of their squared norms.',
    original: '设 n 为任意自然数，a₀, …, aₙ₋₁ 与 b₀, …, bₙ₋₁ 为两列实数，不要求它们非负。证明：\n\n(∑ᵢ₌₀ⁿ⁻¹ aᵢbᵢ)² ≤ (∑ᵢ₌₀ⁿ⁻¹ aᵢ²)(∑ᵢ₌₀ⁿ⁻¹ bᵢ²)。\n\n当 n = 0 时，所有求和均为空和，值为 0。',
    originalEn: 'Let n be any natural number, and let a₀, …, aₙ₋₁ and b₀, …, bₙ₋₁ be two sequences of real numbers. Their terms need not be nonnegative. Prove:\n\n(∑ᵢ₌₀ⁿ⁻¹ aᵢbᵢ)² ≤ (∑ᵢ₌₀ⁿ⁻¹ aᵢ²)(∑ᵢ₌₀ⁿ⁻¹ bᵢ²).\n\nWhen n = 0, all sums are empty and equal to zero.',
    environment: 'mathlib',
    source: `import Mathlib

namespace FiniteCauchySchwarz

theorem inner_product_sq_le (n : ℕ) (a b : Fin n → ℝ) :
    (∑ i, a i * b i) ^ 2 ≤ (∑ i, (a i) ^ 2) * (∑ i, (b i) ^ 2) := by
  sorry

end FiniteCauchySchwarz
`, task, taskEn,
  },
  {
    id: 'primes-unbounded', name: '素数无穷性', nameEn: 'Infinitely many primes',
    summary: '证明任意自然数之上都存在素数，处理存在量词与严格不等式。',
    summaryEn: 'Show that a prime exists beyond every natural number, with an explicit strict bound.',
    original: '证明素数有无穷多个。具体地，对每个自然数 N（包括 0），都存在自然数 p，使得 p 是素数且 p > N。\n\n这里素数指大于 1、正因数只有 1 和自身的自然数。结论必须适用于任意 N，而不只是某个固定上界。',
    originalEn: 'Prove that there are infinitely many primes. More precisely, for every natural number N, including zero, there exists a natural number p such that p is prime and p > N.\n\nA prime is a natural number greater than one whose only positive divisors are one and itself. The conclusion must hold for every N, not just for a fixed bound.',
    environment: 'mathlib',
    source: `import Mathlib

namespace PrimesUnbounded

theorem prime_above (N : ℕ) : ∃ p : ℕ, Nat.Prime p ∧ N < p := by
  sorry

end PrimesUnbounded
`, task, taskEn,
  },
  {
    id: 'schur-cubic', name: '三次舒尔不等式', nameEn: 'Schur’s cubic inequality',
    summary: '对三个非负实数证明对称三次不等式，保留每个非负假设。',
    summaryEn: 'Prove a symmetric cubic inequality for three nonnegative real numbers.',
    original: '设 a、b、c 是任意三个非负实数，即 a ≥ 0、b ≥ 0、c ≥ 0。证明三次舒尔不等式：\n\na³ + b³ + c³ + 3abc ≥ ab(a + b) + bc(b + c) + ca(c + a)。\n\n允许某些变量为 0；不额外假设 a + b + c = 1，也不假设三个变量之间的大小顺序。',
    originalEn: 'Let a, b, and c be arbitrary nonnegative real numbers: a ≥ 0, b ≥ 0, and c ≥ 0. Prove Schur’s cubic inequality:\n\na³ + b³ + c³ + 3abc ≥ ab(a + b) + bc(b + c) + ca(c + a).\n\nZero values are allowed. Do not add a normalization such as a + b + c = 1 or assume an ordering of the variables.',
    environment: 'mathlib',
    source: `import Mathlib

namespace SchurCubic

theorem schur (a b c : ℝ) (ha : 0 ≤ a) (hb : 0 ≤ b) (hc : 0 ≤ c) :
    a * b * (a + b) + b * c * (b + c) + c * a * (c + a) ≤
      a ^ 3 + b ^ 3 + c ^ 3 + 3 * a * b * c := by
  sorry

end SchurCubic
`, task, taskEn,
  },
];
