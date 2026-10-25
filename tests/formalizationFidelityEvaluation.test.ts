import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { formalizationEvaluationInputDigest, formalizationEvaluationLeanSource,
  prepareFormalizationEvaluation, readFormalizationEvaluationBundle,
  type FormalizationEvaluationReviewerInput } from '../src/math/formalizationEvaluation';
import { assertFormalizationReferenceResult, type FormalizationReferenceInput,
  type FormalizationReferenceResult } from '../src/math/formalizationReference';
import type { FormalizationFidelity } from '../src/math/formalizationFidelity';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { resolveReviewEnvironment, structuredReviewDigest,
  type ReviewStatementObservation, type ReviewStatementSnapshot,
  type StructuredReviewInput } from '../src/math/formalizationReviewV2';
import { runStructuredFormalizationReview } from '../src/solver/formalizationReviewV2';
import { fixtureStatement, semanticReviewFixture, syntheticElaboration } from './helpers/formalizationFixture';

const forbidden = vi.hoisted(() => ({ model: vi.fn(), lean: vi.fn(), comparison: vi.fn() }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: forbidden.model }));
vi.mock('../src/solver/formalizationElaboration', () => ({ elaborateFormalization: forbidden.lean }));
vi.mock('../src/solver/formalizationReference', () => ({ compareFormalizationReference: forbidden.comparison }));

const roots: string[] = [];
beforeEach(() => {
  for (const adapter of Object.values(forbidden))
    adapter.mockReset().mockImplementation(() => { throw new Error('test_forbids_native_execution'); });
});
afterEach(() => {
  try { for (const adapter of Object.values(forbidden)) expect(adapter).not.toHaveBeenCalled(); }
  finally { for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); }
});
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Exact receipts from real sandboxed Lean 4.33 standard-library comparisons on
// 2026-10-25, without models. The statement observations and role sessions below
// are synthetic; these tests exercise integration, never benchmark accuracy.
const savedReceipts = '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';
function receiptFixture() {
  const bytes = gunzipSync(Buffer.from(savedReceipts, 'base64'));
  expect(mathDigest(bytes)).toBe('173ded80d1b9743ebc049ed5b0812fc5ddc16c43e5ec274f22041c02d02a7f8e');
  return JSON.parse(bytes.toString('utf8')) as { input: FormalizationReferenceInput; positive: FormalizationReferenceResult;
    negativeInput: FormalizationReferenceInput; negative: FormalizationReferenceResult };
}
function comparisons() {
  const saved = receiptFixture(), calls: FormalizationReferenceInput[] = [];
  assertFormalizationReferenceResult(saved.input, saved.positive);
  assertFormalizationReferenceResult(saved.negativeInput, saved.negative);
  const compare: NonNullable<Parameters<typeof runStructuredFormalizationReview>[3]>['compareReference'] =
    async (_directory, current) => {
      // Bind each saved result to its entire original request; never adapt a receipt.
      const negative = current.referenceSource === saved.negativeInput.referenceSource;
      expect(current).toEqual(negative ? saved.negativeInput : saved.input);
      calls.push(current);
      return structuredClone(negative ? saved.negative : saved.positive);
    };
  return { compare, calls, saved };
}

function observation(input: FormalizationEvaluationReviewerInput): ReviewStatementObservation {
  const environment = resolveReviewEnvironment({ sourceToolchain: getLeanTaskEnvironment('standard').toolchain }, 'standard');
  const elaborated = syntheticElaboration(formalizationEvaluationLeanSource(input), 'standard', { detailedContext: true });
  return { schema: 'theorem-os.formalization-review-observation.v2', caseId: input.caseId,
    inputDigest: formalizationEvaluationInputDigest(input), sourceSha256: elaborated.sourceSha256,
    environment, status: 'elaborated', snapshot: elaborated.snapshot,
    snapshotDigest: structuredReviewDigest(elaborated.snapshot), diagnostics: '' };
}
function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-evaluation-'))); roots.push(base);
  const bundleDirectory = path.join(base, 'bundle'), inputFile = path.join(base, 'fixture.jsonl');
  fs.writeFileSync(inputFile, JSON.stringify({ id: 'handwritten-addition', sourceFamily: 'handwritten-addition',
    split: 'test', kind: 'synthetic', label: 'correct', original: fixtureStatement, header: '',
    candidate: 'theorem addition (n : Nat) : n + 0 = n := by sorry\n',
    labelProvenance: 'Handwritten synthetic routing label.' }) + '\n');
  prepareFormalizationEvaluation({ directory: bundleDirectory, inputFile, format: 'normalized',
    provenance: { name: 'Handwritten fidelity integration fixture', kind: 'synthetic-fixture',
      labelProvenance: 'Disposable routing fixture; no model accuracy measurement.',
      sourceToolchain: getLeanTaskEnvironment('standard').toolchain } });
  const prepared = readFormalizationEvaluationBundle(bundleDirectory), input = [...prepared.inputs.values()][0];
  const replayFile = path.join(base, 'replay.json');
  fs.writeFileSync(replayFile, JSON.stringify({ schema: 'theorem-os.formalization-review-replay.v2',
    bundleDigest: prepared.bundleDigest, observations: [observation(input)], roles: [] }));
  return { bundleDirectory, runDirectory: path.join(base, 'run'), input,
    config: { execution: 'replay' as const, protocol: 'v2' as const, environment: 'standard' as const,
      fidelityPolicy: 'task-preserving-v1' as const, replayFile } };
}

type ReviewRole = 'primary' | 'recheck';
type TranslationInput = ReviewStatementSnapshot & { snapshotDigest: string };
function fidelity(input: StructuredReviewInput, source: string): FormalizationFidelity {
  return { policy: 'task-preserving-v1', targets: input.observation.snapshot!.targets.map(target => ({
    targetName: target.name, originalFragment: input.original, sourceClaim: input.original,
    candidateClaim: 'Every natural number n satisfies n + 0 = n.',
    hypothesisScope: 'There are no hypotheses beyond the natural-number domain.',
    quantifierOrder: 'The natural number n is universally quantified.',
    binderIds: target.context.bindings!.binders.map(binder => binder.id),
    conclusionDependencies: target.context.bindings!.conclusionDependencies,
  })), sourceContract: { source, pairs: [{ candidateTarget: 'addition', referenceTarget: 'addition' }] } };
}
function sessions(options: { failedCorrespondence?: ReviewRole; forceRecheck?: boolean } = {}) {
  const seen: { role: ReviewRole | 'backtranslate'; input: StructuredReviewInput | TranslationInput; closed: boolean }[] = [];
  const saved = receiptFixture();
  const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const input = read(path.join(config.workspace, 'INPUT.json')) as StructuredReviewInput | TranslationInput;
    const role = input.schema === 'theorem-os.formalization-snapshot.v1' ? 'backtranslate' : input.role;
    const visit = { role, input, closed: false }; seen.push(visit);
    return { threadId: 'fidelity-evaluation-' + randomUUID(), interrupt: async () => {},
      close: async () => { visit.closed = true; }, run: async (_message, _messageId, workspace, onStarted) => {
        onStarted('fidelity-evaluation-turn-' + randomUUID()); config.onUsage({ totalTokens: 1 });
        let output: unknown;
        if (role === 'backtranslate') {
          const snapshot = input as TranslationInput;
          output = { snapshotDigest: snapshot.snapshotDigest, mathematics: fixtureStatement, assumptions: [], definitions: [],
            targets: snapshot.targets.map(target => ({ name: target.name, mathematics: fixtureStatement })) };
        } else {
          const roleInput = input as StructuredReviewInput, review = semanticReviewFixture(roleInput);
          review.fidelity = fidelity(roleInput, role === options.failedCorrespondence ?
            saved.negativeInput.referenceSource : saved.input.referenceSource);
          if (role === 'primary' && options.forceRecheck) {
            const conclusion = review.correspondences.find(item => item.aspect === 'conclusions')!;
            conclusion.relation = 'equivalent';
            conclusion.forwardArgument = 'Both claims state the same natural-number zero identity.';
            conclusion.reverseArgument = 'Reading that same identity gives the reverse direction.';
          }
          output = review;
        }
        fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), JSON.stringify(output));
        config.completedOutput!.validate(output); return 'submitted';
      } };
  };
  return { open, seen };
}
function caseReceipt(f: ReturnType<typeof fixture>) {
  return path.join(f.runDirectory, 'receipts', f.input.caseId + '.json');
}
function comparisonFile(f: ReturnType<typeof fixture>, role: ReviewRole) {
  return path.join(f.runDirectory, 'fidelity', f.input.caseId, role, 'comparison.json');
}

describe('fixed-candidate task fidelity evaluation', () => {
  it('approves a model-approved primary only after its exact Lean correspondence is established', async () => {
    const f = fixture(), agent = sessions(), comparison = comparisons();
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config,
      { openSession: agent.open, compareReference: comparison.compare });
    expect(result).toMatchObject({ status: 'complete', completedCases: 1, attempts: 1, unknownCases: 0,
      recheckedCases: 0, modelInvoked: false, compilationObserved: false });
    expect(agent.seen.map(visit => visit.role)).toEqual(['primary']); expect(agent.seen[0].closed).toBe(true);
    expect((agent.seen[0].input as StructuredReviewInput).fidelityPolicy).toBe('task-preserving-v1');
    expect(comparison.calls).toEqual([comparison.saved.input]);
    const file = comparisonFile(f, 'primary');
    expect(read(file).status).toBe('established'); expect(fs.statSync(file).mode & 0o222).toBe(0);
    expect(read(caseReceipt(f))).toMatchObject({ verdict: 'approved', resolution: 'primary',
      fidelityChecks: { primary: mathDigest(fs.readFileSync(file)) } });
    expect(read(result.decisionsFile).decisions).toEqual([
      { caseId: f.input.caseId, inputDigest: formalizationEvaluationInputDigest(f.input), verdict: 'approved', compileStatus: 'unknown' },
    ]);
  });

  it.each(['primary', 'recheck'] as const)('keeps two approved reviews unknown when %s correspondence is not established', async role => {
    const f = fixture(), agent = sessions({ failedCorrespondence: role, forceRecheck: role === 'recheck' }), comparison = comparisons();
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config,
      { openSession: agent.open, compareReference: comparison.compare });
    expect(result).toMatchObject({ status: 'complete', completedCases: 1, attempts: 3, unknownCases: 1, recheckedCases: 1 });
    expect(agent.seen.map(visit => visit.role)).toEqual(['primary', 'backtranslate', 'recheck']);
    expect(agent.seen.every(visit => visit.closed)).toBe(true); expect(comparison.calls).toHaveLength(2);
    for (const reviewer of ['primary', 'recheck'] as const) {
      const roleReceipt = read(path.join(f.runDirectory, 'role-receipts', f.input.caseId + '-' + reviewer + '.json'));
      expect(read(path.join(f.runDirectory, roleReceipt.attempt.workspace, 'OUTPUT.json')).verdict).toBe('approved');
      expect(read(comparisonFile(f, reviewer)).status).toBe(reviewer === role ? 'not-established' : 'established');
    }
    const receipt = read(caseReceipt(f));
    expect(receipt).toMatchObject({ verdict: 'unknown', resolution: 'fidelity-not-established',
      reviewAgreement: { aspectDisagreements: [], sharedMismatches: [] } });
    expect(Object.keys(receipt.fidelityChecks).sort()).toEqual(['primary', 'recheck']);
    if (role === 'primary') expect(receipt.reasons).toContain('fidelity-correspondence-not-established');
    expect(read(result.decisionsFile).decisions[0].verdict).toBe('unknown');
  });

  it('restores all completed role and comparison evidence without any new session or Lean work', async () => {
    const f = fixture(), agent = sessions({ forceRecheck: true }), comparison = comparisons();
    const first = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config,
      { openSession: agent.open, compareReference: comparison.compare });
    expect(first).toMatchObject({ status: 'complete', completedCases: 1, attempts: 3, unknownCases: 0 });
    const stateBefore = read(path.join(f.runDirectory, 'state.json'));
    const files = [caseReceipt(f), first.decisionsFile, ...(['primary', 'recheck'] as const).map(role => comparisonFile(f, role)),
      ...['primary', 'backtranslate', 'recheck'].map(role => path.join(f.runDirectory, 'role-receipts', f.input.caseId + '-' + role + '.json'))];
    const hashes = files.map(file => mathDigest(fs.readFileSync(file)));
    const noOpen = vi.fn(async () => { throw new Error('resume_must_not_open_session'); });
    const noCompare = vi.fn(async () => { throw new Error('resume_must_not_compare'); });
    const noObserve = vi.fn(async () => { throw new Error('resume_must_not_observe'); });
    const restored = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config,
      { openSession: noOpen, compareReference: noCompare, observeStatement: noObserve });
    expect(restored).toEqual(first);
    expect(noOpen).not.toHaveBeenCalled(); expect(noCompare).not.toHaveBeenCalled(); expect(noObserve).not.toHaveBeenCalled();
    expect(agent.seen).toHaveLength(3); expect(comparison.calls).toHaveLength(2);
    expect(read(path.join(f.runDirectory, 'state.json')).attempts).toEqual(stateBefore.attempts);
    expect(files.map(file => mathDigest(fs.readFileSync(file)))).toEqual(hashes);
  });

  it.each(['primary', 'recheck'] as const)('rejects a completed case missing its %s comparison without restarting work', async role => {
    const f = fixture(), agent = sessions({ forceRecheck: true }), comparison = comparisons();
    const first = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config,
      { openSession: agent.open, compareReference: comparison.compare });
    expect(first.status).toBe('complete'); const decisions = fs.readFileSync(first.decisionsFile, 'utf8');
    fs.rmSync(comparisonFile(f, role));
    const noOpen = vi.fn(async () => { throw new Error('resume_must_not_open_session'); });
    const noCompare = vi.fn(async () => { throw new Error('resume_must_not_compare'); });
    await expect(runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config,
      { openSession: noOpen, compareReference: noCompare })).rejects.toThrow('formalization_fidelity_evidence_missing');
    expect(noOpen).not.toHaveBeenCalled(); expect(noCompare).not.toHaveBeenCalled();
    expect(agent.seen).toHaveLength(3); expect(comparison.calls).toHaveLength(2);
    expect(fs.existsSync(comparisonFile(f, role))).toBe(false);
    expect(fs.readFileSync(first.decisionsFile, 'utf8')).toBe(decisions);
    expect(read(path.join(f.runDirectory, 'state.json')).caseErrors[f.input.caseId]).toBe('formalization_fidelity_evidence_missing');
  });
});
