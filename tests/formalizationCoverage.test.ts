import { describe, expect, it } from 'vitest';
import { assertFormalizationCandidate, formalizationCandidateSchema, formalizationRequestSchema,
  type FormalizationCandidate } from '../src/math/formalization';
import { formalizationTargets } from '../src/math/formalizationSource';
import { candidateFixture } from './helpers/formalizationFixture';

function request(statement: string) {
  return formalizationRequestSchema.parse({ schema: 'theorem-os.formalization-request.v3', problemId: 'coverage',
    statement, statementSha256: 'a'.repeat(64), environment: 'standard', environmentDigest: 'b'.repeat(64),
    execution: 'replay', model: 'fixture', effort: 'none', profile: '/no-provider',
    executable: '/no-model', buildManifestRef: '/no-build', buildDigest: 'c'.repeat(64),
    maxRounds: 2, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0 });
}
function rejection(statement: string, candidate: FormalizationCandidate) {
  try { assertFormalizationCandidate(request(statement), formalizationCandidateSchema.parse(candidate)); }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/^formalization_coverage_invalid: /u);
    expect(message.length).toBeLessThan(6_000);
    return JSON.parse(message.slice('formalization_coverage_invalid: '.length));
  }
  throw new Error('Expected coverage rejection');
}

describe('formalization coverage diagnostics', () => {
  it('locates the observed set-union typo without modifying the candidate or original', () => {
    const original = '定义 f(x) 在 K 上根式可解，当且仅当存在有限域扩张塔\nK=K_0⊆K_1⊆⋯⊆K_m，';
    const statement = '前文😀\n' + original + '\n后文', submitted = original.replace('K_1⊆', 'K_1⊔');
    const candidate = candidateFixture(submitted), before = structuredClone(candidate);
    const detail = rejection(statement, candidate), hint = detail.possibleSourceMatches[0];
    expect(detail).toMatchObject({ field: 'coverage[0].originalText', reason: 'not_exact_source_substring' });
    expect(hint.difference).toEqual({ quoteOffset: submitted.indexOf('⊔'), statementOffset: statement.indexOf('⊆⋯'),
      submitted: '⊔', original: '⊆' });
    expect(statement.slice(hint.statementStart, hint.statementEnd)).toBe(original);
    expect(hint.sourceExcerpt.text).toBe(original);
    expect(hint.quotedExcerpt.text).toBe(submitted);
    expect(candidate).toEqual(before);
    expect(assertFormalizationCandidate(request(statement), candidateFixture(original))).toEqual(formalizationTargets(candidate.source));
  });

  it.each([
    ['middle substitution', 'abcdefghij ⊔ klmnopqrstuv', '⊔', '⊆'],
    ['extra character', 'abcdefghij x⊆ klmnopqrstuv', 'x', ''],
    ['missing character', 'abcdefghij  klmnopqrstuv', '', '⊆'],
    ['first character substitution', '😀bcdefghij ⊆ klmnopqrstuv', '😀', 'a'],
    ['last character substitution', 'abcdefghij ⊆ klmnopqrstu😀', '😀', 'v'],
    ['extra astral character', 'abcdefghij 😀⊆ klmnopqrstuv', '😀', ''],
  ])('provides a real source range for a single Unicode edit: %s', (_name, quoted, removed, added) => {
    const original = 'abcdefghij ⊆ klmnopqrstuv', statement = '😀\n' + original + '\n';
    const detail = rejection(statement, candidateFixture(quoted));
    const hint = detail.possibleSourceMatches.find((item: any) => statement.slice(item.statementStart, item.statementEnd) === original);
    expect(hint).toBeDefined();
    expect(hint.difference).toMatchObject({ submitted: removed, original: added });
    expect(quoted.slice(0, hint.difference.quoteOffset) + added + quoted.slice(hint.difference.quoteOffset + removed.length)).toBe(original);
    expect(hint.difference.statementOffset).toBe(hint.statementStart + hint.difference.quoteOffset);
  });

  it('does not invent a source match for unrelated text', () => {
    const detail = rejection('For every natural number n, prove n + 0 = n.', candidateFixture('An unrelated paragraph about fields.'));
    expect(detail.possibleSourceMatches).toEqual([]);
    expect(detail.instruction).toContain('Copy an exact substring from INPUT.statement');
  });

  it('reports actual repeated source locations without claiming uniqueness', () => {
    const original = 'abcdefghij ⊆ klmnopqrstuv', statement = original + '\n' + original;
    const detail = rejection(statement, candidateFixture(original.replace('⊆', '⊔')));
    expect(detail.possibleSourceMatches.map((item: any) => item.statementStart)).toEqual([0, original.length + 1]);
    for (const hint of detail.possibleSourceMatches) expect(statement.slice(hint.statementStart, hint.statementEnd)).toBe(original);
  });

  it('keeps a long quote diagnostic bounded and shows the difference beyond its prefix', () => {
    const original = 'Unique beginning: ' + 'a'.repeat(15_900) + '⊆' + 'b'.repeat(15_900) + ' unique ending.';
    const statement = 'z'.repeat(200_000) + original, candidate = candidateFixture(original.replace('⊆', '⊔'));
    const detail = rejection(statement, candidate), hint = detail.possibleSourceMatches[0];
    expect(detail.quotedText.truncated).toBe(true);
    expect(hint.difference).toMatchObject({ submitted: '⊔', original: '⊆' });
    expect(hint.sourceExcerpt.text).toContain('⊆');
    expect(hint.quotedExcerpt.text).toContain('⊔');
    expect(original.slice(hint.sourceExcerpt.start, hint.sourceExcerpt.end)).toBe(hint.sourceExcerpt.text);
  });

  it.each([
    ['For every n, prove n + 0 = n.', 'For every n, prove n + 0 = n!'],
    ['For every n, prove n + 0 = n.', 'For  every n, prove n + 0 = n.'],
    ['For every n, prove \\alpha(n) = n.', 'For every n, prove alpha(n) = n.'],
  ])('preserves exact matching for punctuation, spacing and escapes: %s', (statement, quoted) => {
    expect(rejection(statement, candidateFixture(quoted)).reason).toBe('not_exact_source_substring');
  });

  it('identifies an unknown target by field and lists the actual declaration names', () => {
    const candidate = candidateFixture(); candidate.coverage[0].targetNames.push('Addition');
    const detail = rejection(candidate.coverage[0].originalText, candidate);
    expect(detail).toMatchObject({ field: 'coverage[0].targetNames[1]', reason: 'unknown_target',
      submitted: { text: 'Addition' }, validTargets: { total: 1, truncated: false, names: [{ text: 'addition' }] } });
  });

  it('names uncovered theorems while accepting repeated valid entries and target names', () => {
    const candidate = candidateFixture(), statement = candidate.coverage[0].originalText;
    candidate.source += 'theorem second (n : Nat) : n = n := by sorry\n';
    candidate.coverage[0].targetNames.push('addition'); candidate.coverage.push(structuredClone(candidate.coverage[0]));
    expect(rejection(statement, candidate)).toMatchObject({ field: 'coverage', reason: 'uncovered_targets',
      uncoveredTargets: { total: 1, names: [{ text: 'second' }] } });
    candidate.coverage[1].targetNames.push('second');
    expect(assertFormalizationCandidate(request(statement), candidate)).toEqual(formalizationTargets(candidate.source));
  });

  it('bounds many long target names without hiding that the list is incomplete', () => {
    const candidate = candidateFixture(), statement = candidate.coverage[0].originalText;
    for (let i = 0; i < 20; i++) candidate.source += `theorem target_${i}_${'x'.repeat(200)} : True := by sorry\n`;
    candidate.coverage[0].targetNames.push('\u0001'.repeat(32_000));
    const detail = rejection(statement, candidate);
    expect(detail.submitted.truncated).toBe(true);
    expect(detail.validTargets).toMatchObject({ total: 21, truncated: true });
    expect(detail.validTargets.names).toHaveLength(8);
  });
});
