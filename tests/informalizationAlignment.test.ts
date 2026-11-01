import { describe, expect, it } from 'vitest';
import { sectionStepGoals, type InformalizationStepGoals } from '../src/math/informalizationAlignment';
import { sourceRange } from './helpers/informalizationFixture';

// Goal states as the goals query records them. The Gauss sum declaration and its goals are copied from a 2026-10-31 run
// (lines 12-18 of its proof file); the other declarations are handwritten in the same shape.
const GAUSS = ['theorem gauss_sum_double : ∀ n : ℕ, 2 * S n = n * (n + 1) := by', '  intro n', '  induction n with',
  '  | zero => simp [S]', '  | succ k ih =>', '    rw [S_succ, mul_add, ih]', '    ring'].join('\n');
const forall = '⊢ ∀ (n : ℕ), 2 * S n = n * (n + 1)', fixed = 'n : ℕ\n⊢ 2 * S n = n * (n + 1)', zero = 'case zero\n⊢ 2 * S 0 = 0 * (0 + 1)';
const succ = 'case succ\nk : ℕ\nih : 2 * S k = k * (k + 1)\n⊢ 2 * S (k + 1) = (k + 1) * (k + 1 + 1)';
const rewritten = 'case succ\nk : ℕ\nih : 2 * S k = k * (k + 1)\n⊢ k * (k + 1) + 2 * (k + 1) = (k + 1) * (k + 1 + 1)';
const record = (line: number, column: number, endLine: number, endColumn: number, tactic: string, before: string[], after: string[]) =>
  ({ range: { line, column, endLine, endColumn }, tactic, before, beforeCount: before.length, after, afterCount: after.length });
const gauss = (truncated = false) => ({ source: GAUSS, range: { line: 12, column: 0, endLine: 18, endColumn: 8 }, goals: { truncated,
  tactics: [record(13, 2, 13, 9, 'intro n', [forall], [fixed]), record(14, 2, 18, 8, 'induction n with', [fixed], []),
    record(15, 12, 15, 20, 'simp [S]', [zero], []), record(17, 4, 17, 28, 'rw [S_succ, mul_add, ih]', [succ], [rewritten]),
    record(18, 4, 18, 8, 'ring', [rewritten], [])] } });
const GAUSS_STEPS = [['theorem gauss_sum_double : ∀ n : ℕ, 2 * S n = n * (n + 1) := by', '  intro n'], ['  induction n with'],
  ['  | zero => simp [S]'], ['    rw [S_succ, mul_add, ih]'], ['    ring']];

/** A declaration on line 1 with its tactics given as snippets of the source (the first occurrence of each). */
const unit = (source: string, tactics: [string, string[], string[], number?][], truncated = false) => ({ source,
  range: { line: 1, column: 0, endLine: source.split('\n').length, endColumn: source.split('\n').at(-1)!.length },
  goals: { truncated, tactics: tactics.map(([snippet, before, after, beforeCount]) => ({ range: sourceRange(source, snippet),
    tactic: snippet.split('\n')[0]!.trim(), before, beforeCount: beforeCount ?? before.length, after, afterCount: after.length })) } });
const both = (value: Parameters<typeof sectionStepGoals>[0], steps: string[][]) =>
  [true, false].map(blockHeads => sectionStepGoals(value, steps, { blockHeads }));
const goals = (before: string[], after: string[], start: number, end: number, afterCount = after.length): InformalizationStepGoals =>
  ({ before, beforeCount: before.length, after, afterCount, lines: { start, end } });

describe('step goals for a quoted block head', () => {
  it('gives `induction n with` the case goals it leaves, where v1 gave the closed block', () => {
    const [current, v1] = both(gauss(), GAUSS_STEPS);
    expect(current![1]).toEqual(goals([fixed], [zero, succ], 14, 14));
    expect(v1![1]).toEqual(goals([fixed], [], 14, 18));
    // Steps that quote whole tactics are placed as before.
    expect(current!.filter((_, index) => index !== 1)).toEqual(v1!.filter((_, index) => index !== 1));
    expect(current![2]).toEqual(goals([zero], [], 15, 15));
    // An alternative's header quoted with the head is part of the head; the lines run to it.
    expect(sectionStepGoals(gauss(), [['  induction n with', '  | succ k ih =>']])).toEqual([goals([fixed], [zero, succ], 14, 16)]);
  });

  it('gives `have h : P := by` the claim to prove, then the goal with h, and keeps whole quotations as they were', () => {
    const main = 'a : Nat\nh0 : a = 1\n⊢ a + a = 2', withH = 'a : Nat\nh0 : a = 1\nh : a = 1\n⊢ a + a = 2', claim = 'a : Nat\nh0 : a = 1\n⊢ a = 1';
    const value = unit(['theorem t (a : Nat) (h0 : a = 1) : a + a = 2 := by', '  have h : a = 1 := by', '    exact h0', '  omega'].join('\n'),
      [['have h : a = 1 := by\n    exact h0', [main], [withH]], ['exact h0', [claim], []], ['omega', [withH], []]]);
    const [current, v1] = both(value, [['have h : a = 1 := by'], ['exact h0'], ['omega']]);
    expect(current).toEqual([goals([main], [claim, withH], 2, 2), goals([claim], [], 3, 3), goals([withH], [], 4, 4)]);
    expect(v1![0]).toEqual(goals([main], [withH], 2, 3));
    // Quoting the whole `have` or its head with the tactic inside it uses those tactics, under both versions.
    for (const steps of [[['have h : a = 1 := by\n    exact h0']], [['have h : a = 1 := by', 'exact h0']]]) {
      const [whole, old] = both(value, steps);
      expect(whole).toEqual(old);
    }
    expect(both(value, [['have h : a = 1 := by\n    exact h0']])[0]).toEqual([goals([main], [withH], 2, 3)]);
  });

  it('leaves the goal unchanged after `classical`, whose block runs to the end of the proof', () => {
    const main = 'p : Prop\nhp : p\n⊢ p ∧ p', withH = 'p : Prop\nhp : p\nh : p\n⊢ p ∧ p';
    const value = unit(['theorem c (p : Prop) (hp : p) : p ∧ p := by', '  classical', '  have h : p := hp', '  exact ⟨h, h⟩'].join('\n'),
      [['classical\n  have h : p := hp\n  exact ⟨h, h⟩', [main], []], ['have h : p := hp', [main], [withH]], ['exact ⟨h, h⟩', [withH], []]]);
    const [current, v1] = both(value, [['classical']]);
    expect(current).toEqual([goals([main], [main], 2, 2)]);
    expect(v1).toEqual([goals([main], [], 2, 4)]);
  });

  it('lists at most 4 goals in order and stops at a state Lean printed only in part, counting all of them', () => {
    const many = ['⊢ 1', '⊢ 2', '⊢ 3', '⊢ 4'];
    const value = unit(['theorem m : P := by', '  refine ⟨?_, ?_, ?_, ?_, ?_⟩', '  classical', '  all_goals simp'].join('\n'),
      [['refine ⟨?_, ?_, ?_, ?_, ?_⟩', ['⊢ P'], many], ['classical\n  all_goals simp', many, [], 5], ['all_goals simp', many, [], 5]]);
    expect(both(value, [['classical']])[0]).toEqual([{ before: many, beforeCount: 5, after: many, afterCount: 5, lines: { start: 3, end: 3 } }]);
    // Five alternatives, each `| x => rfl` on its own line with `rfl` at columns 9-12.
    const names = ['a', 'b', 'c', 'd', 'e'], caseGoal = (name: string) => `case ${name}\n⊢ ${name} = ${name}`;
    const alternatives = { source: ['theorem k (n : T) : n = n := by', '  induction n with', ...names.map(name => `  | ${name} => rfl`)].join('\n'),
      range: { line: 1, column: 0, endLine: 7, endColumn: 12 }, goals: { truncated: false, tactics: [
        record(2, 2, 7, 12, 'induction n with', ['⊢ n = n'], []),
        ...names.map((name, index) => record(3 + index, 9, 3 + index, 12, 'rfl', [caseGoal(name)], []))] } };
    expect(both(alternatives, [['induction n with']])[0]).toEqual([goals(['⊢ n = n'], names.slice(0, 4).map(caseGoal), 2, 2, 5)]);
  });

  it('keeps the v1 goals when the tactics were truncated or the goals inside the block do not all close', () => {
    expect(sectionStepGoals(gauss(true), GAUSS_STEPS, { blockHeads: true })).toEqual(sectionStepGoals(gauss(), GAUSS_STEPS, { blockHeads: false }));
    const value = unit(['theorem v (a : Nat) : a + 0 = a := by', '  conv_lhs =>', '    rw [Nat.add_zero]'].join('\n'),
      [['conv_lhs =>\n    rw [Nat.add_zero]', ['a : Nat\n⊢ a + 0 = a'], []], ['rw [Nat.add_zero]', ['a : Nat\n| a + 0'], ['a : Nat\n| a']]]);
    const [current, v1] = both(value, [['conv_lhs =>']]);
    expect(current).toEqual(v1);
    expect(current).toEqual([goals(['a : Nat\n⊢ a + 0 = a'], [], 2, 3)]);
  });
});
