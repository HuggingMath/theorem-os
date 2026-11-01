import { describe, expect, it } from 'vitest';
import { declarationNames, declarationRegions, formalizationCorrespondences } from '../apps/web/formalizationReport';
import type { FormalizationEvidence } from '../src/math/formalization';

// Reviewer correspondences placed in a proof of the formalized statement, as the explanation page's 「原题」 card does.
const ORIGINAL = 'Prove that for every natural number n, n + 0 = n.';
const STATEMENT = 'theorem addition (n : Nat) : n + 0 = n := by sorry\n';
const PROOF = 'theorem helper (n : Nat) : n + 0 = n := by simp\n\ntheorem addition (n : Nat) : n + 0 = n := by\n  simp\n';
const evidence = (fragments: readonly string[]) => ({
  request: { statement: ORIGINAL },
  review: { correspondences: fragments.map(candidateFragment => ({ aspect: 'conclusions', relation: 'direct',
    originalFragment: 'n + 0 = n', candidateFragment, explanation: '' })) },
}) as unknown as FormalizationEvidence;

describe('formalization correspondences in a proof', () => {
  const regions = declarationRegions(PROOF, declarationNames(STATEMENT));
  const place = (fragment: string) => formalizationCorrespondences(evidence([fragment]), PROOF, regions)[0]!.lean;

  it('finds a fragment that ends in the proof hole by the header before it', () => {
    expect(place('theorem addition (n : Nat) : n + 0 = n := by sorry')).toEqual([{ line: 3, start: 0, end: 38 }]);
    expect(place('n + 0 = n :=\n  sorry')).toEqual([{ line: 3, start: 29, end: 38 }]);
    expect(place('n + 0 = n')).toEqual([{ line: 3, start: 29, end: 38 }]);
  });

  it('marks every copy of a fragment written more than once, but none inside a name', () => {
    // 'n' is written three times in addition's header, and once more at the end of `addition`, which is not it.
    expect(place('n')).toEqual([18, 29, 37].map(start => ({ line: 3, start, end: start + 1 })));
    expect(place('Nat')).toEqual([{ line: 3, start: 22, end: 25 }]);
    expect(place('dition')).toEqual([]);
  });

  it('quotes an original fragment written twice where a longer fragment with overlapping Lean is', () => {
    const original = 'Adding zero to a leaves it unchanged, and adding zero to b leaves it unchanged.';
    const source = 'theorem twice (a b : Nat) : a + 0 = a ∧ b + 0 = b := by sorry\n';
    const pairs = (items: readonly [string, string, string][]) => ({ request: { statement: original },
      review: { correspondences: items.map(([aspect, originalFragment, candidateFragment]) => ({ aspect, relation: 'direct',
        originalFragment, candidateFragment, explanation: '' })) } }) as unknown as FormalizationEvidence;
    const quoted = (items: readonly [string, string, string][]) => formalizationCorrespondences(pairs(items), source,
      [{ start: 0, end: source.length }]).map(item => `${item.leanText}@${item.originalStart}`);
    const first = original.indexOf('dding zero'), second = original.indexOf('dding zero', first + 1);
    const conclusion = (letter: string): [string, string, string] => ['conclusions', `dding zero to ${letter} leaves it unchanged`, `${letter} + 0 = ${letter}`];
    const definition: [string, string, string] = ['definitions', 'dding zero', 'b + 0'];
    // a's conclusion is on the same line as `b + 0` but does not overlap it; b's does.
    expect(quoted([conclusion('a'), conclusion('b'), definition]))
      .toEqual([`a + 0 = a@${first}`, `b + 0 = b@${second}`, `b + 0@${second}`]);
    // A fragment around both copies tells them apart no more than none does: the first is quoted.
    expect(quoted([definition])).toEqual([`b + 0@${first}`]);
    const whole: [string, string, string] = ['conclusions', original, 'a + 0 = a ∧ b + 0 = b'];
    expect(quoted([whole, definition])).toEqual(['a + 0 = a ∧ b + 0 = b@0', `b + 0@${first}`]);
    expect(quoted([whole, conclusion('b'), definition])).toEqual(['a + 0 = a ∧ b + 0 = b@0', `b + 0 = b@${second}`, `b + 0@${second}`]);
  });

  it('places nothing outside the formalized declaration and keeps a fragment that is only the hole unplaced', () => {
    expect(place('by simp')).toEqual([]);
    expect(place(':= by sorry')).toEqual([]);
    expect(formalizationCorrespondences(evidence(['n + 0 = n := by sorry']), PROOF, regions)[0])
      .toMatchObject({ originalStart: 'Prove that for every natural number n, '.length, leanText: 'n + 0 = n := by sorry' });
  });
});
