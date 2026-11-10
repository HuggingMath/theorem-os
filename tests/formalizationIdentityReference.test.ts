import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertFormalizationReferenceResult, formalizationIdentityReferenceFiles, formalizationReferenceFiles,
  type FormalizationReferenceInput, type FormalizationReferenceResult } from '../src/math/formalizationReference';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { compareFormalizationReference } from '../src/solver/formalizationReference';

const request = (candidateSource: string, referenceSource = candidateSource,
  names = ['target']): FormalizationReferenceInput => ({ candidateSource, referenceSource,
  environment: 'standard', purpose: 'task-fidelity-v2',
  pairs: names.map(name => ({ candidateTarget: name, referenceTarget: name })) });

describe('separately versioned strict identity program', () => {
  it.each([
    ['standard', 'bc0282b288a5087188ab6f2afcdc9ad0a315701d7c7f5a8187b90354482f42a1'],
    ['mathlib', '46b53047039e05af2ce8d992cd19a7e11df7b603ed3ec7464463530a177c3b0b'],
    ['mathlib-4.8', '6a3079d873db19525c832313f7a4c60de3f4f8ab6c5f087a6aef917b6c6a14a2'],
  ] as const)('preserves frozen correspondence program bytes for %s', (environment, expected) => {
    const input = { ...request('theorem target (n : Nat) : n = n := by sorry\n'), environment };
    expect(mathDigest(formalizationReferenceFiles(input)['ReferenceComparison.lean'])).toBe(expected);
  });

  it('keeps the full source predicates and original small imports while erasing both proof bodies', () => {
    const source = 'import Mathlib.Data.Real.Basic\n'
      + 'theorem target (x y : ℝ) (sum : x + y = 1) (unused : False) : x * y ≤ 1 / 4 := by forbidden_candidate_proof\n';
    const input = { ...request(source, source.replace('forbidden_candidate_proof', 'forbidden_gold_proof')), environment: 'mathlib' as const };
    const files = formalizationIdentityReferenceFiles(input), full = formalizationReferenceFiles(input);
    expect(files['ReferenceCandidate.lean']).toBe(full['ReferenceCandidate.lean']);
    expect(files['ReferenceGold.lean']).toBe(full['ReferenceGold.lean']);
    expect(files['ReferenceCandidate.lean']).toContain('(sum : x + y = 1) (unused : False)');
    expect(files['ReferenceGold.lean']).toContain('import Mathlib.Data.Real.Basic');
    expect(Object.values(files).join('\n')).not.toMatch(/forbidden_\w+_proof|\b(?:sorry|sorryAx|axiom|admit)\b/u);
    expect(files['ReferenceComparison.lean'].split('\n').filter(line => line.startsWith('import ')))
      .toEqual(['import Lean', 'import ReferenceCandidate', 'import ReferenceGold']);
    expect(files['ReferenceComparison.lean']).not.toMatch(/finiteFamily|cardinality|groupCenter|representations|permutations/u);
    expect(() => formalizationIdentityReferenceFiles({ ...input, purpose: 'task-fidelity-v1' })).toThrow('identity_purpose_unsupported');
  });
});

// Real sandboxed Lean only. No completed diagnostic or comparison is synthesized.
describe.skipIf(process.env.THEOREMOS_TEST_REFERENCE_LEAN !== '1')('strict complete-proposition identity with native Lean', () => {
  let root: string, positive: FormalizationReferenceResult;
  const positiveSource = 'universe u v\ndef bump (n : Nat) := n + 1\n'
    + 'theorem complete (α : Type u) (β : Type v) (R : α → β → Prop) (a : α) (b : β) '
    + '(unused : False) : R a b := by original_candidate_proof_must_not_execute\n'
    + 'theorem quantified (α : Type u) (β : Type v) (R : α → β → Prop) : ∀ a, ∃ b, R a b := by ignored\n'
    + 'theorem localDefinition (n m : Nat) : bump n = m := by ignored\n';
  const positiveInput = request(positiveSource, positiveSource.replace('universe u v', 'universe renamedU renamedV')
    .replaceAll('Type u', 'Type renamedU').replaceAll('Type v', 'Type renamedV')
    .replace('original_candidate_proof_must_not_execute', 'original_gold_proof_must_not_execute'),
  ['complete', 'quantified', 'localDefinition']);
  const compare = async (name: string, input: FormalizationReferenceInput) => {
    const result = await compareFormalizationReference(path.join(root, name), input, { env: process.env, timeoutMs: 60000 });
    expect(result.check, result.reason).toBe('completed');
    expect(result.evidence).toBeDefined();
    expect(() => assertFormalizationReferenceResult(input, JSON.parse(canonicalMathJson(result)))).not.toThrow();
    return result;
  };
  beforeAll(async () => {
    root = process.env.THEOREMOS_TEST_IDENTITY_ROOT ? path.resolve(process.env.THEOREMOS_TEST_IDENTITY_ROOT) :
      fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'strict-identity-native-')));
    if (process.env.THEOREMOS_TEST_IDENTITY_ROOT) fs.mkdirSync(root, { recursive: false, mode: 0o700 });
    positive = await compare('positive', positiveInput);
  }, 65000);
  afterAll(() => { if (root && !process.env.THEOREMOS_TEST_IDENTITY_ROOT) fs.rmSync(root, { recursive: true, force: true }); });

  it('checks both directions for all full predicates with rigid renamed universes and local definitions', () => {
    expect(positive).toMatchObject({ schema: 'theoremos.formalization-reference.v7',
      method: 'definitional-identity-v1', status: 'established', modelInvoked: false,
      proofVerified: false, semanticEquivalenceClaimed: false });
    const report = JSON.parse(positive.evidence!.reportText);
    expect(report.schema).toBe('theoremos.reference-report.v7');
    report.pairs.forEach((pair: any, index: number) => {
      expect(pair).toMatchObject({ definitionallyEqual: true, binderPermutation: false,
        representationCorrespondence: false, transformations: [],
        candidateToReference: { status: 'established', proofDeclaration: `TheoremOSDefinitionalIdentity.candidateToReference${index}` },
        referenceToCandidate: { status: 'established', proofDeclaration: `TheoremOSDefinitionalIdentity.referenceToCandidate${index}` } });
    });
    expect(report.pairs[0].candidateType).toContain('False');
    expect(report.pairs[0].candidateBaseline).toBe(true);
    expect(fs.existsSync(path.join(root, 'positive/correspondence'))).toBe(false);
    expect(positive.files.map(file => file.text).join('\n')).not.toMatch(/original_\w+_proof_must_not_execute|\b(?:sorry|sorryAx|axiom|admit)\b/u);
  });

  it('does not drop unused False, other binders, hypotheses, quantifier scope, definitions, or rigid levels', async () => {
    const targets = [
      ['unusedFalse', '(p q : Prop) (h : p) : q', '(p q : Prop) (h : p) (unused : False) : q'],
      ['unusedBinder', '(p q : Prop) (h : p) : q', '(p q : Prop) (h : p) (unused : Nat) : q'],
      ['hypothesis', '(p q : Prop) (h : p) : q', '(p q : Prop) (h : q) : q'],
      ['quantifiers', '(G : Type) (R : G → G → Prop) : ∀ a, ∃ b, R a b', '(G : Type) (R : G → G → Prop) : ∃ b, ∀ a, R a b'],
      ['scope', '(G : Type) (W : G → G → Nat → Prop) (C : G → G → Prop) (h : ∃ i, ∀ a b, W a b i) : ∀ a b, C a b',
        '(G : Type) (W : G → G → Nat → Prop) (C : G → G → Prop) : ∀ a b i, W a b i → C a b'],
      ['collapsedUniverses', '(α : Type u) (β : Type v) (f g : α → β) : f = g', '(α : Type u) (β : Type u) (f g : α → β) : f = g'],
      ['specializedUniverses', '(α : Type u) (β : Type v) (f g : α → β) : f = g', '(α β : Type) (f g : α → β) : f = g'],
      ['localDefinition', '(n m : Nat) : bump n = m', '(n m : Nat) : bump n = m'],
    ];
    const source = (side: 1 | 2) => 'universe u v\n' + `def bump (n : Nat) := n + ${side}\n`
      + targets.map(target => `theorem ${target[0]} ${target[side]} := by ignored_proof\n`).join('');
    const input = request(source(1), source(2), targets.map(target => target[0]));
    const result = await compare('negative-contracts', input);
    expect(result).toMatchObject({ schema: 'theoremos.formalization-reference.v6', status: 'not-established' });
    expect(result.pairs.every(pair => pair.candidateToReference.status === 'not-established' && pair.referenceToCandidate.status === 'not-established')).toBe(true);
    const fast = JSON.parse(fs.readFileSync(path.join(root, 'negative-contracts/identity/comparison.json'), 'utf8'));
    expect(() => assertFormalizationReferenceResult(input, fast)).not.toThrow();
    expect(fast).toMatchObject({ schema: 'theoremos.formalization-reference.v7', check: 'completed', status: 'not-established' });
    expect(JSON.parse(fast.evidence.reportText).pairs.every((pair: any) => pair.definitionallyEqual === false)).toBe(true);
  }, 65000);

  it('returns the whole frozen v7 correspondence round when only some pairs are strict identities', async () => {
    const candidate = 'universe u v\ntheorem identity (n : Nat) : n = n := by ignored\n'
      + 'theorem permutation (α : Type u) (β : Type v) [Inhabited α] [Inhabited β] (f g : α → β) : f = g := by ignored\n';
    const reference = candidate.replace('(α : Type u) (β : Type v) [Inhabited α] [Inhabited β]',
      '{α : Type u} [Inhabited α] {β : Type v} [Inhabited β]');
    const input = request(candidate, reference, ['identity', 'permutation']);
    const result = await compare('mixed-round', input);
    expect(result).toMatchObject({ schema: 'theoremos.formalization-reference.v6', method: 'cardinality-correspondence-v7', status: 'established' });
    const fast = JSON.parse(fs.readFileSync(path.join(root, 'mixed-round/identity/comparison.json'), 'utf8'));
    expect(fast.pairs.map((pair: any) => pair.candidateToReference.status)).toEqual(['established', 'not-established']);
    const full = JSON.parse(fs.readFileSync(path.join(root, 'mixed-round/correspondence/comparison.json'), 'utf8'));
    expect(result).toEqual(full);
    expect(result.pairs.map(pair => pair.candidateToReference.proofDeclaration))
      .toEqual(['TheoremOSCorrespondence.candidateToReference0', 'TheoremOSCorrespondence.candidateToReference1']);
    expect(JSON.parse(result.evidence!.reportText).pairs[1]).toMatchObject({ definitionallyEqual: false, binderPermutation: true });
  }, 65000);

  it('rejects a matching receipt reused for a changed full hypothesis scope or relabeled method', () => {
    const changed = { ...positiveInput, referenceSource: positiveInput.referenceSource.replace('(unused : False)', '(unused : True)') };
    const reused = { ...positive, inputDigest: mathDigest(canonicalMathJson(changed)),
      referenceSourceSha256: mathDigest(changed.referenceSource) };
    expect(() => assertFormalizationReferenceResult(changed, reused)).toThrow();
    expect(() => assertFormalizationReferenceResult(positiveInput,
      { ...positive, schema: 'theoremos.formalization-reference.v6', method: 'cardinality-correspondence-v7' })).toThrow();
    const badWitness = JSON.parse(canonicalMathJson(positive));
    delete badWitness.pairs[0].referenceToCandidate.proofDeclaration;
    expect(() => assertFormalizationReferenceResult(positiveInput, badWitness)).toThrow();
  });
});
