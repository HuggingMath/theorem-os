import assert from 'node:assert/strict';
import { loadWebSample, type WebSampleFile } from '../apps/web/sample';

/** English user/Agent content for the language audit; server event messages stay Chinese and must be translated. */
export function englishAuthoredSample(): WebSampleFile {
  const sample = loadWebSample();
  assert.ok(sample, 'The language check requires the recorded sample');
  const authored = new Map([
    ['证明两个自然数加法定理，保持原题声明不变。根据 Lean 反馈修复候选，并验收完整原题。',
      'Prove both natural-number addition theorems without changing their statements. Repair the candidate from Lean feedback and check the whole original problem.'],
    ['证明 Tutorial.add_zero：n + 0 按定义就等于 n。', 'Prove Tutorial.add_zero: n + 0 is definitionally equal to n.'],
    ['证明 Tutorial.zero_add：可以直接用 Nat.zero_add。', 'Prove Tutorial.zero_add using Nat.zero_add directly.'],
    ['先证 add_zero：n + 0 按定义就等于 n，可以直接用 rfl。另一个定理先不要动。',
      'Prove add_zero first: n + 0 is definitionally equal to n, so use rfl. Leave the other theorem unchanged for now.'],
    ['请把对这份完整证明的审阅结论交上来。最后是否通过，以独立的 Lean 验收为准。',
      'Submit the review of this complete proof. Independent Lean acceptance determines the final outcome.'],
    ['审阅者看过了两个定理的完整证明，同意提交。最终是否通过，仍以独立的 Lean 验收为准。',
      'The reviewer checked both complete proofs and approved submission. Independent Lean acceptance determines the final outcome.'],
    ['直接证明两个固定目标。', 'Prove both fixed targets directly.'],
    ['两个定理都用标准库里的直接证明；第二个等人修改计划后再开始。',
      'Use direct standard-library proofs for both theorems; start the second after the human plan revision.'],
  ]);
  const english = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let text = value;
      for (const [original, replacement] of authored) text = text.replaceAll(original, replacement);
      return text;
    }
    if (Array.isArray(value)) return value.map(english);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, english(item)]));
    return value;
  };
  return english(sample) as WebSampleFile;
}
