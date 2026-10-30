import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fidelityReferenceInput } from '../src/math/formalizationFidelity';
import { formalizationReferenceFiles, type CurrentFormalizationReferenceResult,
  type FormalizationReferenceInput } from '../src/math/formalizationReference';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { resolveReviewEnvironment, structuredReviewDigest, type StructuredReviewInput } from '../src/math/formalizationSemanticReview';
import { canonicalMathJson, mathDigest, writeMathFrozen } from '../src/math/mathRuntimeIo';
import { checkFormalizationFidelity } from '../src/solver/formalizationFidelity';
import { candidateFixture, fixtureStatement, semanticReviewFixture, syntheticElaboration } from './helpers/formalizationFixture';

function fixture() {
  const snapshot = syntheticElaboration(candidateFixture().source, 'standard', { detailedContext: true }).snapshot;
  const input: StructuredReviewInput = { schema: 'theorem-os.formalization-review-input.v2', role: 'primary',
    caseId: 'case_' + 'a'.repeat(64), baseInputDigest: 'b'.repeat(64), original: fixtureStatement,
    header: '', candidate: snapshot.source, translation: null, fidelityPolicy: 'task-preserving-v1',
    observation: { schema: 'theorem-os.formalization-review-observation.v2', caseId: 'case_' + 'a'.repeat(64),
      inputDigest: 'b'.repeat(64), sourceSha256: snapshot.sourceSha256,
      environment: resolveReviewEnvironment({ sourceToolchain: getLeanTaskEnvironment('standard').toolchain }, 'standard'),
      status: 'elaborated', snapshot, snapshotDigest: structuredReviewDigest(snapshot), diagnostics: '' } };
  const review = semanticReviewFixture(input);
  review.fidelity = { policy: 'task-preserving-v1', targets: [{ targetName: 'addition', originalFragment: input.original,
    sourceClaim: input.original, candidateClaim: input.original, hypothesisScope: 'Only the natural-number domain.',
    quantifierOrder: 'One universally quantified natural number.', binderIds: ['b0'], conclusionDependencies: ['b0'] }],
    sourceContract: { source: snapshot.source, pairs: [{ candidateTarget: 'addition', referenceTarget: 'addition' }] } };
  return { input, review, request: fidelityReferenceInput(snapshot, review.fidelity) };
}

// These disposable receipts represent unavailable checks only. No completed
// comparison or semantic acceptance evidence is fabricated for these tests.
function unavailable(request: FormalizationReferenceInput, reason: string): CurrentFormalizationReferenceResult {
  return { schema: 'theoremos.formalization-reference.v4', authority: 'advisory-lean-process', method: 'cardinality-correspondence-v5',
    status: 'not-established', check: 'unavailable', proofVerified: false, semanticEquivalenceClaimed: false, modelInvoked: false,
    inputDigest: mathDigest(canonicalMathJson(request)), candidateSourceSha256: mathDigest(request.candidateSource),
    referenceSourceSha256: mathDigest(request.referenceSource), environment: request.environment,
    environmentDigest: getLeanTaskEnvironment(request.environment).dependencyDigest,
    limits: { timeoutMs: 0, maxPairs: 16, maxHeartbeats: 100000 }, reason,
    pairs: request.pairs.map(pair => ({ ...pair, candidateToReference: { status: 'not-established', reason },
      referenceToCandidate: { status: 'not-established', reason } })),
    files: Object.entries(formalizationReferenceFiles(request)).map(([file, text]) => ({ file, text, sha256: mathDigest(text) })) };
}

describe('fidelity comparison cancellation recovery', () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-recovery-'))); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (root: string) => path.join(root, 'comparison.json');

  it('does not start a comparison when the run is already cancelled', async () => {
    const f = fixture(), controller = new AbortController(), compare = vi.fn(); controller.abort();
    await expect(checkFormalizationFidelity(root, f.input, f.review,
      { env: {}, timeoutMs: 0, signal: controller.signal, compareReference: compare })).rejects.toThrow(/aborted/u);
    expect(compare).not.toHaveBeenCalled(); expect(fs.existsSync(file(root))).toBe(false);
  });

  it('does not freeze cancellation during comparison and retries the same request on resume', async () => {
    const f = fixture(), controller = new AbortController();
    const compare = vi.fn(async (_directory: string, request: FormalizationReferenceInput) => {
      expect(request).toEqual(f.request); controller.abort(); return unavailable(request, 'formalization_reference_aborted');
    });
    await expect(checkFormalizationFidelity(root, f.input, f.review,
      { env: {}, timeoutMs: 0, signal: controller.signal, compareReference: compare })).rejects.toThrow(/aborted/u);
    expect(fs.existsSync(file(root))).toBe(false);
    const retried = unavailable(f.request, 'formalization_reference_toolchain_unavailable');
    const retry = vi.fn(async () => retried);
    expect(await checkFormalizationFidelity(root, f.input, f.review,
      { env: {}, timeoutMs: 0, compareReference: retry })).toEqual(retried);
    expect(retry).toHaveBeenCalledOnce(); expect(JSON.parse(fs.readFileSync(file(root), 'utf8'))).toEqual(retried);
  });

  it('rejects an explicit cancelled result even when the adapter did not abort the caller signal', async () => {
    const f = fixture();
    await expect(checkFormalizationFidelity(root, f.input, f.review, { env: {}, timeoutMs: 0,
      compareReference: async () => unavailable(f.request, 'formalization_reference_aborted') }))
      .rejects.toThrow('formalization_fidelity_comparison_interrupted');
    expect(fs.existsSync(file(root))).toBe(false);
  });

  it.each(['formalization_reference_aborted', 'This operation was aborted', 'The operation was aborted',
    'Proof environment lease cancelled.', 'Proof environment preparation cancelled.'])(
    'retries a validated old cancellation receipt (%s) while retaining the failed attempt', async reason => {
      const f = fixture(), cancelled = unavailable(f.request, reason);
      writeMathFrozen(file(root), canonicalMathJson(cancelled));
      const result = unavailable(f.request, 'formalization_reference_compilation_failed');
      const compare = vi.fn(async (_directory: string, request: FormalizationReferenceInput) => {
        expect(request).toEqual(f.request); return result;
      });
      expect(await checkFormalizationFidelity(root, f.input, f.review,
        { env: {}, timeoutMs: 0, compareReference: compare })).toEqual(result);
      expect(compare).toHaveBeenCalledOnce();
      expect(JSON.parse(fs.readFileSync(file(root), 'utf8'))).toEqual(result);
      const archived = fs.readdirSync(root).filter(name => name.startsWith('comparison-interrupted-'));
      expect(archived).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(path.join(root, archived[0]), 'utf8'))).toEqual(cancelled);
    });

  it('keeps restore-only inspection read-only for an old cancellation receipt', async () => {
    const f = fixture(), cancelled = unavailable(f.request, 'formalization_reference_aborted'), compare = vi.fn();
    writeMathFrozen(file(root), canonicalMathJson(cancelled)); const before = fs.readFileSync(file(root));
    await expect(checkFormalizationFidelity(root, f.input, f.review,
      { env: {}, timeoutMs: 0, restoreOnly: true, compareReference: compare })).rejects.toThrow('formalization_fidelity_evidence_missing');
    expect(compare).not.toHaveBeenCalled(); expect(fs.readFileSync(file(root))).toEqual(before);
    expect(fs.readdirSync(root)).toEqual(['comparison.json']);
  });

  it('validates the old receipt identity before treating cancellation as retryable', async () => {
    const f = fixture(), changed = unavailable(f.request, 'formalization_reference_aborted'), compare = vi.fn();
    changed.inputDigest = '0'.repeat(64); writeMathFrozen(file(root), canonicalMathJson(changed));
    await expect(checkFormalizationFidelity(root, f.input, f.review,
      { env: {}, timeoutMs: 0, compareReference: compare })).rejects.toThrow('formalization_reference_evidence_invalid');
    expect(compare).not.toHaveBeenCalled(); expect(fs.readdirSync(root)).toEqual(['comparison.json']);
  });

  it('retains an unavailable check caused by a compiler failure as the same frozen result', async () => {
    const f = fixture(), result = unavailable(f.request, 'formalization_reference_compilation_failed'), compare = vi.fn();
    writeMathFrozen(file(root), canonicalMathJson(result)); const before = fs.readFileSync(file(root));
    expect(await checkFormalizationFidelity(root, f.input, f.review,
      { env: {}, timeoutMs: 0, compareReference: compare })).toEqual(result);
    expect(compare).not.toHaveBeenCalled(); expect(fs.readFileSync(file(root))).toEqual(before);
  });
});
