import { describe, expect, it } from 'vitest';
import { researchCandidateScopeReason } from '../apps/web/researchCandidateScope';

const originalSource = 'import Mathlib.Data.Nat.Basic\nnamespace Submission\n' +
  'def marker : Nat := 0\ntheorem odd_sum : True := by sorry\nend Submission\n';
const baselineSource = originalSource.replace('theorem odd_sum', 'lemma helper : True := by sorry\ntheorem odd_sum');
const candidateSource = baselineSource.replace('lemma helper : True := by sorry', 'lemma helper : True := by trivial');
const check = (source = candidateSource, overrides: Partial<Parameters<typeof researchCandidateScopeReason>[0]> = {}) =>
  researchCandidateScopeReason({ originalSource, baselineSource, candidateSource: source, targetName: 'Submission.helper', ...overrides });

describe('human candidate source scope', () => {
  it('allows a completed helper while preserving an unrelated original sorry', () => {
    expect(check()).toBeUndefined();
    expect(check(candidateSource, { targetName: 'helper' })).toBeUndefined();
    expect(check(candidateSource, { targetName: '_root_.Submission.helper' })).toBeUndefined();
  });

  it('freezes the baseline proof even when the original goal has since been completed', () => {
    const baseline = baselineSource.replace('theorem odd_sum : True := by sorry', 'theorem odd_sum : True := by trivial');
    const candidate = baseline.replace('lemma helper : True := by sorry', 'lemma helper : True := by trivial');
    expect(check(candidate, { baselineSource: baseline })).toBeUndefined();
    expect(check(candidate.replace('theorem odd_sum : True := by trivial', 'theorem odd_sum : True := by exact True.intro'),
      { baselineSource: baseline })).toContain('非目标原始声明 Submission.odd_sum');
  });

  it.each([
    ['原始目标证明', 'theorem odd_sum : True := by sorry', 'theorem odd_sum : True := by trivial', '非目标原始声明'],
    ['目标类型', 'lemma helper : True := by trivial', 'lemma helper : False := by trivial', '参数或类型'],
    ['目标参数', 'lemma helper : True := by trivial', 'lemma helper (n : Nat) : True := by trivial', '参数或类型'],
    ['删除声明', 'def marker : Nat := 0\n', '', '改变或删除'],
    ['原有定义', 'def marker : Nat := 0', 'def marker : Nat := 1', '非目标原始声明'],
  ])('rejects changes to %s', (_label, before, after, reason) => {
    expect(check(candidateSource.replace(before, after))).toContain(reason);
  });

  it('allows same-signature proof repairs to solver-created lemmas, but freezes their definitions', () => {
    const extra = 'lemma peer : True := by exact True.intro\ndef generated : Nat := 0\n';
    const baseline = baselineSource.replace('lemma helper', extra + 'lemma helper');
    const candidate = candidateSource.replace('lemma helper', extra + 'lemma helper');
    expect(check(candidate.replace('by exact True.intro', 'by trivial'), { baselineSource: baseline })).toBeUndefined();
    expect(check(candidate.replace('def generated : Nat := 0', 'def generated : Nat := 1'),
      { baselineSource: baseline })).toContain('已有定义 Submission.generated');
    expect(check(candidate.replace('lemma peer : True', 'lemma peer (n : Nat) : True'),
      { baselineSource: baseline })).toContain('参数或类型');
  });

  it('permits a new assigned helper and new complete supporting lemmas', () => {
    const candidate = originalSource.replace('theorem odd_sum', 'lemma support : True := by trivial\n' +
      'lemma helper : True := by exact support\ntheorem odd_sum');
    expect(check(candidate, { baselineSource: originalSource })).toBeUndefined();
  });

  it.each(['sorry', 'admit'])('does not exempt %s in the target or in solver-created siblings', token => {
    expect(check(candidateSource.replace('lemma helper : True := by trivial', `lemma helper : True := by ${token}`))).toContain(token);
    expect(check(candidateSource.replace('lemma helper', `lemma unfinished : True := by ${token}\nlemma helper`))).toContain(token);
    expect(check(candidateSource.replace('odd_sum : True := by sorry', `odd_sum : True := by ${token}`),
      { baselineSource: baselineSource.replace('odd_sum : True := by sorry', `odd_sum : True := by ${token}`) })).toBeUndefined();
  });

  it.each(['axiom evil : False', 'unsafe def evil : Nat := 0', 'run_cmd pure ()', '#eval 1'])('keeps the global trust gate for %s', command => {
    expect(check(candidateSource.replace('lemma helper', command + '\nlemma helper'))).toBeDefined();
  });

  it('does not exempt direct sorryAx even inside an unchanged original proof', () => {
    expect(check(candidateSource.replace('by sorry', 'by exact sorryAx True true'),
      { baselineSource: baselineSource.replace('theorem odd_sum : True := by sorry', 'theorem odd_sum : True := by exact sorryAx True true') }))
      .toContain('sorryAx');
  });

  it.each([
    ['open', 'open Classical\n'],
    ['variables', 'variable (extra : Nat)\n'],
    ['options', 'set_option autoImplicit false\n'],
    ['section', 'section Other\nend Other\n'],
    ['non-Mathlib import', 'import Unapproved\n'],
  ])('rejects changed %s context', (_label, command) => {
    expect(check(candidateSource.replace('namespace Submission', command + 'namespace Submission'))).toContain('上下文');
  });

  it('allows explicit Mathlib imports and inert comments, but preserves existing imports', () => {
    expect(check('import Mathlib.Data.List.Basic\n-- extra context comment\n' + candidateSource)).toBeUndefined();
    expect(check(candidateSource.replace('import Mathlib.Data.Nat.Basic\n', ''))).toContain('上下文');
    expect(check(candidateSource.replace('import Mathlib.Data.Nat.Basic', 'import Mathlib'))).toContain('上下文');
    expect(check(candidateSource.replace('by trivial', 'by\n  -- sorry, admit, axiom and unsafe are inert here\n  trivial'))).toBeUndefined();
  });

  it('preserves exact qualified identities when original leaf names repeat in namespaces', () => {
    const original = 'namespace A\ntheorem target : True := by sorry\nend A\n' +
      'namespace B\ntheorem target : True := by sorry\nend B\n';
    const candidate = original.replace('namespace A\ntheorem target : True := by sorry', 'namespace A\ntheorem target : True := by trivial');
    const input = { originalSource: original, baselineSource: original, candidateSource: candidate, targetName: 'A.target' };
    expect(researchCandidateScopeReason(input)).toBeUndefined();
    expect(researchCandidateScopeReason({ ...input, targetName: 'target' })).toContain('唯一');
    expect(researchCandidateScopeReason({ ...input, candidateSource: candidate.replace('namespace B', 'namespace C') })).toContain('改变或删除');
    expect(researchCandidateScopeReason({ ...input, candidateSource: candidate.replace('end A', 'theorem target : True := by trivial\nend A') })).toContain('重复');
  });

  it('allows helper reordering in one context and rejects moving one across a variable command', () => {
    const original = 'namespace Submission\nvariable (n : Nat)\ntheorem odd_sum : n = n := by sorry\nend Submission\n';
    const baseline = original.replace('namespace Submission\n', 'namespace Submission\nlemma helper : True := by sorry\nlemma peer : True := by trivial\n');
    const candidate = baseline.replace('lemma helper : True := by sorry\nlemma peer : True := by trivial\n',
      'lemma peer : True := by trivial\nlemma helper : True := by trivial\n');
    const input = { originalSource: original, baselineSource: baseline, candidateSource: candidate, targetName: 'Submission.helper' };
    expect(researchCandidateScopeReason(input)).toBeUndefined();
    const moved = candidate.replace('lemma helper : True := by trivial\nvariable (n : Nat)\n', 'variable (n : Nat)\nlemma helper : True := by trivial\n');
    expect(researchCandidateScopeReason({ ...input, candidateSource: moved })).toContain('上下文');
  });
});
