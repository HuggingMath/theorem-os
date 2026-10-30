import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertFormalizationReferenceResult, type FormalizationReferenceInput,
  type FormalizationReferenceResult } from '../src/math/formalizationReference';
import { canonicalMathJson, mathDigest, writeMathFrozen } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { formalizationTargets } from '../src/math/formalizationSource';
import { assertFormalizationFidelity, fidelityReferenceInput,
  type FormalizationFidelity, type FormalizationFidelitySnapshot } from '../src/math/formalizationFidelity';
import { resolveReviewEnvironment, structuredReviewDigest,
  type StructuredReviewInput } from '../src/math/formalizationSemanticReview';
import { compareFormalizationReference } from '../src/solver/formalizationReference';
import { checkFormalizationFidelity } from '../src/solver/formalizationFidelity';
import { semanticReviewFixture } from './helpers/formalizationFixture';

const identitySource = 'theorem target (n : Nat) : n = n := by sorry\n';
const request = (candidateSource: string, referenceSource = candidateSource): FormalizationReferenceInput => ({
  candidateSource, referenceSource, environment: 'standard', purpose: 'task-fidelity-v1',
  pairs: [{ candidateTarget: 'target', referenceTarget: 'target' }],
});

describe.skipIf(process.env.THEOREMOS_TEST_REFERENCE_LEAN !== '1' ||
  !process.env.THEOREMOS_TEST_FIDELITY_LEAN48_ENV)('task-fidelity reference on pinned Lean 4.8', () => {
  let root: string;
  afterAll(() => {
    if (root && !process.env.THEOREMOS_TEST_FIDELITY_LEAN48_ROOT) fs.rmSync(root, { recursive: true, force: true });
  });

  it('executes the legacy-compatible query and preserves all five complete-contract distinctions', async () => {
    root = process.env.THEOREMOS_TEST_FIDELITY_LEAN48_ROOT ?
      path.resolve(process.env.THEOREMOS_TEST_FIDELITY_LEAN48_ROOT) :
      fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-reference-lean48-')));
    if (process.env.THEOREMOS_TEST_FIDELITY_LEAN48_ROOT) fs.mkdirSync(root, { recursive: false, mode: 0o700 });
    const source = (reference: boolean) => 'universe u v\n'
      + 'theorem identity (n : Nat) : n = n := by sorry\n'
      + (reference ? 'theorem unrelated (n : Nat) : Nat.succ n = Nat.succ n := by sorry\n' :
        'theorem unrelated (n : Nat) : n = n := by sorry\n')
      + (reference ?
        'theorem scope (G : Type) (W : G → G → Nat → Prop) (C : G → G → Prop) : ∀ a b : G, ∀ i : Nat, W a b i → C a b := by sorry\n' :
        'theorem scope (G : Type) (W : G → G → Nat → Prop) (C : G → G → Prop) (h : ∃ i : Nat, ∀ a b : G, W a b i) : ∀ a b : G, C a b := by sorry\n')
      + (reference ?
        'theorem permutation {α : Type u} [Inhabited α] {β : Type v} [Inhabited β] (f g : α → β) : f = g := by sorry\n' :
        'theorem permutation (α : Type u) (β : Type v) [Inhabited α] [Inhabited β] (f g : α → β) : f = g := by sorry\n')
      + (reference ?
        'theorem quantifiers (G : Type) (R : G → G → Prop) : ∃ b : G, ∀ a : G, R a b := by sorry\n' :
        'theorem quantifiers (G : Type) (R : G → G → Prop) : ∀ a : G, ∃ b : G, R a b := by sorry\n');
    const input: FormalizationReferenceInput = { candidateSource: source(false), referenceSource: source(true),
      environment: 'mathlib-4.8', purpose: 'task-fidelity-v1',
      pairs: ['identity', 'unrelated', 'scope', 'permutation', 'quantifiers'].map(name =>
        ({ candidateTarget: name, referenceTarget: name })) };
    writeMathFrozen(path.join(root, 'request.json'), canonicalMathJson(input));
    const result = await compareFormalizationReference(path.join(root, 'comparison'), input, {
      env: { DEEPSCIENTIST_MATH_ENV_FILE: process.env.THEOREMOS_TEST_FIDELITY_LEAN48_ENV },
      timeoutMs: 0, proofEnvironmentCacheRoot: path.join(root, 'proof-cache'),
    });
    // Unavailable compilation cannot masquerade as a successful negative check.
    expect(result.check, result.reason).toBe('completed');
    expect(result.evidence).toBeDefined();
    expect(result.environment).toBe('mathlib-4.8');
    expect(result.limits.timeoutMs).toBe(0);
    expect(result.files.find(file => file.file === 'lean-toolchain')!.text).toBe('leanprover/lean4:v4.8.0\n');
    expect(result).toMatchObject({ modelInvoked: false, proofVerified: false, semanticEquivalenceClaimed: false });
    expect(() => assertFormalizationReferenceResult(input, JSON.parse(canonicalMathJson(result)))).not.toThrow();
    const report = JSON.parse(result.evidence!.reportText);
    for (const pair of result.pairs) {
      const expected = ['identity', 'permutation'].includes(pair.candidateTarget) ? 'established' : 'not-established';
      expect(pair.candidateToReference.status, pair.candidateTarget).toBe(expected);
      expect(pair.referenceToCandidate.status, pair.candidateTarget).toBe(expected);
    }
    const find = (name: string) => report.pairs.find((pair: { candidateTarget: string }) => pair.candidateTarget === name);
    expect(find('identity')).toMatchObject({ definitionallyEqual: true, candidateBaseline: true, referenceBaseline: true });
    expect(find('unrelated')).toMatchObject({ definitionallyEqual: false,
      candidateToReference: { reason: 'baseline-trivial' } });
    expect(find('permutation')).toMatchObject({ definitionallyEqual: false, binderPermutation: true });
    for (const name of ['scope', 'quantifiers']) expect(find(name)).toMatchObject({
      candidateBaseline: false, referenceBaseline: false, definitionallyEqual: false, binderPermutation: false,
      candidateToReference: { reason: 'not-definitionally-equal' },
      referenceToCandidate: { reason: 'not-definitionally-equal' },
    });
  }, 65000);
});

// Explicit opt-in, as in the existing native reference suite. These are actual
// sandboxed Lean processes; the stored results are never synthetic proof receipts.
describe.skipIf(process.env.THEOREMOS_TEST_REFERENCE_LEAN !== '1')('task-fidelity reference checks with native Lean', () => {
  let root: string, positive: FormalizationReferenceResult;
  const environment = () => process.env.DEEPSCIENTIST_MATH_ENV_FILE ?
    { DEEPSCIENTIST_MATH_ENV_FILE: process.env.DEEPSCIENTIST_MATH_ENV_FILE } : process.env;
  const compare = async (name: string, input: FormalizationReferenceInput) => {
    const result = await compareFormalizationReference(path.join(root, name), input,
      { env: environment(), timeoutMs: 0 });
    expect(result.check, result.reason).toBe('completed');
    expect(result.evidence).toBeDefined();
    expect(result.limits.timeoutMs).toBe(0);
    expect(() => assertFormalizationReferenceResult(input, JSON.parse(canonicalMathJson(result)))).not.toThrow();
    return result;
  };
  beforeAll(async () => {
    root = process.env.THEOREMOS_TEST_FIDELITY_ROOT ? path.resolve(process.env.THEOREMOS_TEST_FIDELITY_ROOT) :
      fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-reference-native-')));
    if (process.env.THEOREMOS_TEST_FIDELITY_ROOT) fs.mkdirSync(root, { recursive: false, mode: 0o700 });
    positive = await compare('identity-fidelity', request(identitySource));
  }, 65000);
  afterAll(() => {
    if (root && !process.env.THEOREMOS_TEST_FIDELITY_ROOT) fs.rmSync(root, { recursive: true, force: true });
  });

  it('admits complete definitional identity even when both full claims are baseline provable', () => {
    expect(positive.status, positive.reason).toBe('established');
    const report = JSON.parse(positive.evidence!.reportText).pairs[0];
    expect(report).toMatchObject({ candidateBaseline: true, referenceBaseline: true, definitionallyEqual: true,
      candidateToReference: { status: 'established', reason: 'definitional-identity-with-opposite-assumption' },
      referenceToCandidate: { status: 'established', reason: 'definitional-identity-with-opposite-assumption' } });
    expect(positive).toMatchObject({ modelInvoked: false, proofVerified: false, semanticEquivalenceClaimed: false });
    expect(Object.values(positive.files).map(file => file.text).join('\n')).not.toMatch(/\b(?:sorry|sorryAx|admit|axiom)\b/u);
  });

  it('accepts placeholder layout without changing source digests or string-valued definitions', async () => {
    const source = 'namespace Candidate\ndef label : String := "a  b"\n'
      + 'theorem same : label = "a  b" := by sorry\n'
      + 'theorem different : label = "a b" := by sorry\nend Candidate\n';
    const contract = 'namespace SourceContract\r\ndef label : String := "a  b"\r\n'
      + 'theorem same : label = "a  b" := by sorry\r\n\r\n'
      + 'theorem different : label = "a  b" := by\r\n  sorry\r\n\r\nend SourceContract\r\n';
    const snapshot: FormalizationFidelitySnapshot = { source, environment: 'standard',
      targets: formalizationTargets(source).map(target => ({ ...target, context: { bindings: {
        binders: [], conclusion: 'String equality.', conclusionDependencies: [],
      } } })) };
    const original = 'Keep the complete string-valued definitions and both equality claims.';
    const fidelity: FormalizationFidelity = { policy: 'task-preserving-v1',
      targets: snapshot.targets.map(target => ({ targetName: target.name, originalFragment: original,
        sourceClaim: original, candidateClaim: original, hypothesisScope: 'No hypotheses.',
        quantifierOrder: 'No parameters.', binderIds: [], conclusionDependencies: [] })),
      sourceContract: { source: contract, pairs: ['same', 'different'].map(name =>
        ({ candidateTarget: 'Candidate.' + name, referenceTarget: 'SourceContract.' + name })) } };
    const before = canonicalMathJson(fidelity);
    expect(assertFormalizationFidelity({ original, observation: { snapshot } }, 'approved', fidelity)).toEqual(fidelity);
    const input = fidelityReferenceInput(snapshot, fidelity);
    expect(input.referenceSource).toBe(contract);
    const result = await compare('placeholder-layout', input);
    expect(result.referenceSourceSha256).toBe(mathDigest(contract));
    expect(result.pairs[0].candidateToReference.status).toBe('established');
    expect(result.pairs[0].referenceToCandidate.status).toBe('established');
    expect(result.pairs[1].candidateToReference.status).toBe('not-established');
    expect(result.status).toBe('not-established');
    expect(canonicalMathJson(fidelity)).toBe(before);
  }, 65000);

  it('retains the baseline-trivial refusal for an identical legacy request without purpose', async () => {
    const { purpose: _purpose, ...legacy } = request(identitySource);
    const result = await compare('identity-legacy', legacy);
    expect(result.status).toBe('not-established');
    expect(JSON.parse(result.evidence!.reportText).pairs[0]).toMatchObject({ definitionallyEqual: true,
      candidateToReference: { status: 'not-established', reason: 'baseline-trivial' },
      referenceToCandidate: { status: 'not-established', reason: 'baseline-trivial' } });
    expect(() => assertFormalizationReferenceResult(legacy, positive)).toThrow();
  }, 65000);

  it('does not use separate proofs of two different reflexive propositions as task correspondence', async () => {
    const result = await compare('different-provable-claims', request(identitySource,
      'theorem target (n : Nat) : Nat.succ n = Nat.succ n := by proof_must_not_execute\n'));
    expect(result.status).toBe('not-established');
    expect(JSON.parse(result.evidence!.reportText).pairs[0]).toMatchObject({ candidateBaseline: true,
      referenceBaseline: true, definitionallyEqual: false,
      candidateToReference: { status: 'not-established', reason: 'baseline-trivial' },
      referenceToCandidate: { status: 'not-established', reason: 'baseline-trivial' } });
    expect(result.files.map(file => file.text).join('\n')).not.toContain('proof_must_not_execute');
  }, 65000);

  it('keeps a whole-structure existential hypothesis distinct from pair-local hypotheses', async () => {
    // W and C are uninterpreted. Replacing this contract by a familiar theorem
    // cannot make either complete implication available to the comparison prover.
    const global = 'theorem target (G : Type) (W : G → G → Nat → Prop) (C : G → G → Prop)\n'
      + '    (h : ∃ i : Nat, ∀ a b : G, W a b i) : ∀ a b : G, C a b := by sorry\n';
    const local = 'theorem target (G : Type) (W : G → G → Nat → Prop) (C : G → G → Prop)\n'
      + '    : ∀ a b : G, ∀ i : Nat, W a b i → C a b := by sorry\n';
    const result = await compare('global-local-scope', request(global, local));
    expect(result.status).toBe('not-established');
    expect(JSON.parse(result.evidence!.reportText).pairs[0]).toMatchObject({ candidateBaseline: false,
      referenceBaseline: false, definitionallyEqual: false, binderPermutation: false,
      candidateToReference: { status: 'not-established', reason: 'not-definitionally-equal' },
      referenceToCandidate: { status: 'not-established', reason: 'not-definitionally-equal' } });
  }, 65000);

  it('still permits independent type and instance binder permutation', async () => {
    const candidate = 'universe u v\ntheorem target (α : Type u) (β : Type v) [Inhabited α] [Inhabited β] '
      + '(f g : α → β) : f = g := by sorry\n';
    const reference = 'universe a b\ntheorem target {α : Type a} [Inhabited α] {β : Type b} [Inhabited β] '
      + '(f g : α → β) : f = g := by sorry\n';
    const result = await compare('independent-binder-permutation', request(candidate, reference));
    expect(result.status, result.reason).toBe('established');
    expect(JSON.parse(result.evidence!.reportText).pairs[0]).toMatchObject({ definitionallyEqual: false,
      binderPermutation: true, candidateToReference: { status: 'established',
        reason: 'bijective-binder-permutation-with-opposite-assumption' },
      referenceToCandidate: { status: 'established', reason: 'bijective-binder-permutation-with-opposite-assumption' } });
  }, 65000);

  it('does not commute dependent universal and existential quantifiers', async () => {
    const candidate = 'theorem target (G : Type) (R : G → G → Prop) : ∀ a : G, ∃ b : G, R a b := by sorry\n';
    const reference = 'theorem target (G : Type) (R : G → G → Prop) : ∃ b : G, ∀ a : G, R a b := by sorry\n';
    const result = await compare('forall-exists-order', request(candidate, reference));
    expect(result.status).toBe('not-established');
    expect(JSON.parse(result.evidence!.reportText).pairs[0]).toMatchObject({ candidateBaseline: false,
      referenceBaseline: false, definitionallyEqual: false, binderPermutation: false,
      candidateToReference: { status: 'not-established', reason: 'not-definitionally-equal' },
      referenceToCandidate: { status: 'not-established', reason: 'not-definitionally-equal' } });
  }, 65000);

  it('restores the same frozen fidelity comparison without launching another Lean process', async () => {
    // The small telescope is test navigation data. The comparison receipt itself
    // is the real native result produced above, bound to this exact source pair.
    const config = getLeanTaskEnvironment('standard');
    const snapshot = { schema: 'theorem-os.formalization-snapshot.v1' as const,
      source: identitySource, sourceSha256: mathDigest(identitySource), environment: 'standard' as const,
      environmentDigest: config.dependencyDigest, targets: formalizationTargets(identitySource).map(target => ({
        ...target, context: { type: '∀ (n : Nat), n = n', constants: [], omitted: [], bindings: {
          binders: [{ id: 'b0', name: 'n', type: 'Nat', kind: 'explicit' as const, dependencies: [] }],
          conclusion: 'n = n', conclusionDependencies: ['b0'],
        } },
      })) };
    const input: StructuredReviewInput = { schema: 'theorem-os.formalization-review-input.v2', role: 'primary',
      caseId: 'case_' + 'a'.repeat(64), baseInputDigest: 'b'.repeat(64),
      original: 'For every natural number n, n equals n.', header: '', candidate: identitySource,
      observation: { schema: 'theorem-os.formalization-review-observation.v2', caseId: 'case_' + 'a'.repeat(64),
        inputDigest: 'b'.repeat(64), sourceSha256: mathDigest(identitySource),
        environment: resolveReviewEnvironment({ sourceToolchain: config.toolchain }, 'standard'),
        status: 'elaborated', snapshot, snapshotDigest: structuredReviewDigest(snapshot), diagnostics: '' },
      translation: null, fidelityPolicy: 'task-preserving-v1' };
    const review = semanticReviewFixture(input);
    review.fidelity = { policy: 'task-preserving-v1', targets: [{ targetName: 'target',
      originalFragment: input.original, sourceClaim: '∀ n : Nat, n = n', candidateClaim: '∀ n : Nat, n = n',
      hypothesisScope: 'No hypotheses.', quantifierOrder: 'One universal natural number parameter.',
      binderIds: ['b0'], conclusionDependencies: ['b0'] }],
      sourceContract: { source: identitySource, pairs: request(identitySource).pairs } };
    const cache = path.join(root, 'fidelity-restored'); fs.mkdirSync(cache);
    const file = path.join(cache, 'comparison.json'); writeMathFrozen(file, canonicalMathJson(positive));
    const before = fs.readFileSync(file), forbiddenComparison = vi.fn(async () => {
      throw new Error('A frozen matching comparison must not restart Lean.');
    });
    expect(await checkFormalizationFidelity(cache, input, review, { env: {}, timeoutMs: 0,
      restoreOnly: true, compareReference: forbiddenComparison })).toEqual(positive);
    expect(forbiddenComparison).not.toHaveBeenCalled();
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
