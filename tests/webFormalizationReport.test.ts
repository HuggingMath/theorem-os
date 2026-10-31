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

  it('places nothing outside the formalized declaration and keeps a fragment that is only the hole unplaced', () => {
    expect(place('by simp')).toEqual([]);
    expect(place(':= by sorry')).toEqual([]);
    expect(formalizationCorrespondences(evidence(['n + 0 = n := by sorry']), PROOF, regions)[0])
      .toMatchObject({ originalStart: 'Prove that for every natural number n, '.length, leanText: 'n + 0 = n := by sorry' });
  });
});
