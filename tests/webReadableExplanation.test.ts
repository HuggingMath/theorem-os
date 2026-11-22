import { describe, expect, it } from 'vitest';
import type { WebExplanationStep } from '../apps/web/shared';
import { normalizeExplanationNotation, readableExplanationSteps } from '../apps/web/client/readableExplanation';

describe('reading saved proof explanations', () => {
  it('keeps ordinary English near a named condition', () => {
    const steps = ['The trace condition htrace holds for every positive k.', 'The trace condition holds at k = 1, so apply htrace.']
      .map(text => ({ text, lines: [], reviews: [], uses: [] }));
    expect(readableExplanationSteps({ statement: '', steps }, 'en')).toEqual([
      'The trace condition holds for every positive k.',
      'The trace condition holds at k = 1, so apply trace condition.',
    ]);
  });

  it('writes a scalar coefficient as juxtaposition and retains the scope of its operand', () => {
    expect(normalizeExplanationNotation(String.raw`$A^2B-(2:\mathbb C)\bullet(ABA)+BA^2=0$`))
      .toBe('$A^2B-2ABA+BA^2=0$');
    expect(normalizeExplanationNotation('A²B − (2:ℂ)•(ABA) + BA² = 0'))
      .toBe('A²B − 2ABA + BA² = 0');
    expect(normalizeExplanationNotation(String.raw`$(2:\mathbb{R})\bullet(AB)^2+(3:\mathbb R)\bullet(A+B)$`))
      .toBe('$2(AB)^2+3(A+B)$');
    expect(normalizeExplanationNotation('`(2:ℂ) • (A)` 与 $(2:ℕ)•(A)$'))
      .toBe('`(2:ℂ) • (A)` 与 $(2:ℕ)•(A)$');
  });

  it('reuses a stated mathematical condition for a source alias and keeps a mathematical variable', () => {
    const steps: WebExplanationStep[] = [
      '假设 h 说右端为 $0$。',
      '故 htrace 对 $0<k\\le n$ 成立。',
      '把矩阵和迹条件 htrace 代入引理。取函数 $h(t)=t^2$。',
      'Lean 中这一步写成 `exact htrace`，注释为 `/- 假设 h 说 -/`。',
      '由 hdim 与 htrace 得所需结论。',
    ].map(text => ({ text, lines: [], reviews: [], uses: [] }));
    steps[4]!.goals = { before: ['hdim : Module.finrank ℂ V = n\n⊢ f ^ n = 0'], beforeCount: 1, after: [], afterCount: 0, lines: { start: 1, end: 1 } };
    expect(readableExplanationSteps({ statement: '', steps }, 'zh')).toEqual([
      '由题设可知，右端为 $0$。',
      '故 迹条件 对 $0<k\\le n$ 成立。',
      '把矩阵和迹条件 代入引理。取函数 $h(t)=t^2$。',
      'Lean 中这一步写成 `exact htrace`，注释为 `/- 假设 h 说 -/`。',
      '由 维数等式 与 迹条件 得所需结论。',
    ]);
    expect(steps[1]!.text).toBe('故 htrace 对 $0<k\\le n$ 成立。');
  });
});
