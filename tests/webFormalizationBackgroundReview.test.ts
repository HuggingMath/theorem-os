import type { WorkerFormalizationAuditInput } from '../apps/web/formalizationAuditTypes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebFormalizations } from '../apps/web/formalizations';
import { WebStorage } from '../apps/web/storage';
import type { WebRunner } from '../apps/web/runner';
import { webFormalizationLimits, type WebFormalizationRequest, type WorkerFormalizationInput, type WorkerFormalizationMessage,
  type WorkerFormalizationAuditMessage } from '../apps/web/formalizationTypes';
import { formalizationDigest, type DirectFormalizationEvidence } from '../src/math/formalization';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { webDirectFormalizationEvidence, webFormalizationStatement } from './helpers/webFormalizationFixture';
import { formalizationAuditFixture } from './helpers/formalizationAuditFixture';
import { formalizationAuditInput } from '../src/math/formalizationAudit';

type Pending<I, M> = { input: I; signal: AbortSignal; send(message: M): void; resolve(): void; reject(error: Error): void };
class Runner implements WebRunner {
  generations: Pending<WorkerFormalizationInput, WorkerFormalizationMessage>[] = [];
  audits: Pending<WorkerFormalizationAuditInput, WorkerFormalizationAuditMessage>[] = [];
  async readiness() { return { ready: true, message: 'synthetic background-review runner' }; }
  async run() {}
  formalize(input: WorkerFormalizationInput, send: (message: WorkerFormalizationMessage) => void, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      this.generations.push({ input: { ...input }, signal, send, resolve, reject });
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
  auditFormalization(input: WorkerFormalizationAuditInput, send: (message: WorkerFormalizationAuditMessage) => void, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      this.audits.push({ input: { ...input }, signal, send, resolve, reject });
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const provider = { id: 'compatible', name: 'Synthetic provider', baseUrl: 'https://models.example.test/v1' };
const request: WebFormalizationRequest = { original: webFormalizationStatement, environment: 'standard', effort: 'max', apiKey: 'synthetic-review-key' };
describe('background semantic review and immediate compiled statement handoff', () => {
  let runner: Runner, storage: WebStorage, service: WebFormalizations;
  const proofs: { evidence: DirectFormalizationEvidence; source: string }[] = [];
  beforeEach(() => {
    runner = new Runner(); storage = new WebStorage(); proofs.length = 0;
    service = new WebFormalizations(runner, storage, webFormalizationLimits, (_owner, _value, evidence) => {
      if (evidence.schema !== 'theorem-os.formalization-evidence.v4') throw new Error('synthetic-direct-required');
      proofs.push({ evidence, source: evidence.candidate.source }); return 'proof-' + proofs.length;
    });
  });
  afterEach(async () => { vi.useRealTimers(); await service.close(); });
  async function compile(owner = 'alice', solve = false, options: {
    request?: Partial<WebFormalizationRequest>; tokens?: number; progressTokens?: number;
  } = {}) {
    const created = service.create(owner, { ...request, solve, ...options.request }, provider, 'synthetic-model'); await settle();
    const pending = runner.generations.at(-1)!, evidence = webDirectFormalizationEvidence(pending.input);
    if (options.tokens !== undefined) evidence.sessions[0].usage = { totalTokens: options.tokens };
    if (options.progressTokens !== undefined) pending.send({ type: 'progress', progress: { phase: 'finishing', tokens: options.progressTokens } });
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    return { id: created.id, evidence, value: service.read(owner, created.id) };
  }

  it('starts proof and makes the compiled source available while review is unresolved, releasing the generation slot', async () => {
    const first = await compile('alice', true), digest = formalizationDigest(first.evidence);
    expect(first.value).toMatchObject({ status: 'confirmed', runId: 'proof-1', backgroundReview: { status: 'running', evidenceSha256: digest } });
    expect(first.value.report).toMatchObject({ statement: first.evidence.candidate.source, semanticReview: 'not-performed',
      backgroundReview: { status: 'running' } });
    expect(proofs).toHaveLength(1); expect(runner.audits).toHaveLength(1);
    expect(runner.audits[0].input).toMatchObject({ operation: 'audit', maxRunSeconds: 0, maxTotalTokens: 0, apiKey: request.apiKey });
    const second = service.create('alice', request, provider, 'synthetic-model'); await settle();
    expect(runner.generations).toHaveLength(2); expect(service.read('alice', second.id).status).toBe('running');
    expect(service.counts()).toMatchObject({ running: 1, queued: 0 });
    const evidenceFile = ['owners', mathDigest('alice'), 'formalizations', first.id, 'evidence.json'];
    expect(formalizationDigest(storage.getRecord(evidenceFile))).toBe(digest);
  });

  it.each(['approved', 'changes_requested', 'unknown'] as const)('saves %s without replacing or withholding the frozen statement', async verdict => {
    const first = await compile('alice', true), audit = runner.audits[0], digest = first.value.report!.evidenceSha256;
    audit.send({ type: 'audit-progress', tokens: 10 });
    audit.send({ type: 'audit-result', result: formalizationAuditFixture(first.evidence, verdict) }); audit.resolve(); await settle();
    const value = service.read('alice', first.id);
    expect(value).toMatchObject({ status: 'confirmed', runId: 'proof-1', backgroundReview: { status: verdict, tokens: 10 } });
    expect(value.report!.statement).toBe(first.evidence.candidate.source);
    expect(value.report!.evidenceSha256).toBe(digest);
    expect(value.report!.backgroundReview!.result!.review.verdict).toBe(verdict);
    expect(proofs).toHaveLength(1);
    expect(service.confirmed('alice', first.id).evidence).toEqual(first.evidence);
    const restored = new WebFormalizations(runner, storage);
    expect(restored.read('alice', first.id).backgroundReview!.status).toBe(verdict);
    expect(() => restored.read('bob', first.id)).toThrow(); await restored.close();
  });

  it('allows confirmation during review, and persists it when the audit completes later', async () => {
    const first = await compile(), digest = first.value.report!.evidenceSha256;
    expect(service.confirm('alice', first.id, digest).status).toBe('confirmed');
    runner.audits[0].send({ type: 'audit-result', result: formalizationAuditFixture(first.evidence) });
    runner.audits[0].resolve(); await settle();
    expect(service.read('alice', first.id)).toMatchObject({ status: 'confirmed', confirmation: 'manual', backgroundReview: { status: 'approved' } });
  });

  it('keeps audit failures separate, and releases the audit slot for another compiled statement', async () => {
    const first = await compile(), second = await compile('bob');
    expect(second.value.backgroundReview!.status).toBe('queued');
    runner.audits[0].reject(new Error('formalization_audit_transport_failed')); await settle();
    expect(service.read('alice', first.id)).toMatchObject({ status: 'review', backgroundReview: { status: 'error' } });
    expect(runner.audits).toHaveLength(2); expect(service.read('bob', second.id).backgroundReview!.status).toBe('running');
    expect(service.confirm('alice', first.id, first.value.report!.evidenceSha256).status).toBe('confirmed');
  });

  it('rejects a review for a different source without changing the compiled artifact', async () => {
    const first = await compile(), result = formalizationAuditFixture(first.evidence);
    result.sourceSha256 = '0'.repeat(64); runner.audits[0].send({ type: 'audit-result', result }); runner.audits[0].resolve(); await settle();
    const read = service.read('alice', first.id);
    expect(read.backgroundReview).toMatchObject({ status: 'error', reason: 'formalization_audit_evidence_mismatch' });
    expect(read.report!.statement).toBe(first.evidence.candidate.source);
    expect(read.backgroundReview).not.toHaveProperty('result');
  });

  it('cancels review and ignores late callbacks while leaving compiled code available', async () => {
    const first = await compile(), audit = runner.audits[0]; service.cancel('alice', first.id);
    expect(audit.signal.aborted).toBe(true);
    audit.send({ type: 'audit-result', result: formalizationAuditFixture(first.evidence) }); await settle();
    expect(service.read('alice', first.id)).toMatchObject({ status: 'review', backgroundReview: { status: 'cancelled' } });
    expect(service.read('alice', first.id).report!.statement).toBe(first.evidence.candidate.source);
  });

  it('stops review on delete and forget, without recreating removed records', async () => {
    const first = await compile(), audit = runner.audits[0]; service.remove('alice', first.id);
    expect(audit.signal.aborted).toBe(true);
    audit.send({ type: 'audit-result', result: formalizationAuditFixture(first.evidence) }); await settle();
    expect(() => service.read('alice', first.id)).toThrow();
    const second = await compile('bob'); service.forget('bob'); storage.deleteOwner('bob'); await settle();
    expect(runner.audits[1].signal.aborted).toBe(true); expect(() => service.read('bob', second.id)).toThrow();
  });

  it('restores an interrupted background review without changing compiled readiness or restarting a model', async () => {
    const first = await compile(); await service.close();
    service = new WebFormalizations(runner, storage);
    expect(service.read('alice', first.id)).toMatchObject({ status: 'review', backgroundReview: { status: 'interrupted' } });
    expect(service.confirm('alice', first.id, first.value.report!.evidenceSha256).status).toBe('confirmed');
    expect(runner.audits).toHaveLength(1);
  });

  it('reports unavailable audit capability without withholding compiled code', async () => {
    (runner as WebRunner).auditFormalization = undefined;
    const first = await compile();
    expect(first.value).toMatchObject({ status: 'review', backgroundReview: { status: 'error', reason: 'formalization_audit_runtime_unavailable' } });
    expect(first.value.report!.statement).toBe(first.evidence.candidate.source);
  });

  it('uses the remaining explicit budget from final generation usage, even when progress is stale', async () => {
    await compile('alice', false, { request: { maxTotalTokens: 10_000 }, tokens: 9_999, progressTokens: 1 });
    expect(runner.audits[0].input).toMatchObject({ maxTotalTokens: 1, maxRunSeconds: 0 });
  });

  it.each([undefined, 10_000])('preserves compiled readiness when finite generation usage is missing or exhausted (%s)', async tokens => {
    const first = await compile('alice', true, { request: { maxTotalTokens: 10_000 }, tokens });
    expect(first.value).toMatchObject({ status: 'confirmed', runId: 'proof-1', backgroundReview: { status: 'error',
      reason: tokens === undefined ? 'formalization_usage_missing' : 'formalization_token_limit' } });
    expect(first.value.report!.statement).toBe(first.evidence.candidate.source); expect(runner.audits).toHaveLength(0);
  });

  it('does not start a queued review after its explicitly configured overall deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-09T02:00:00Z'));
    await compile();
    const second = await compile('bob', true, { request: { maxRunSeconds: 10 } });
    expect(second.value.backgroundReview!.status).toBe('queued');
    vi.setSystemTime(new Date('2026-11-09T02:00:11Z'));
    runner.audits[0].reject(new Error('formalization_audit_transport_failed')); await settle();
    expect(service.read('bob', second.id)).toMatchObject({ status: 'confirmed', runId: 'proof-1',
      backgroundReview: { status: 'error', reason: 'formalization_time_limit' } });
    expect(runner.audits).toHaveLength(1);
  });

  it('rejects a valid audit produced with a different model configuration', async () => {
    const first = await compile(), result = formalizationAuditFixture(first.evidence);
    result.model = 'different-synthetic-model';
    result.session.inputDigest = formalizationDigest(formalizationAuditInput(first.evidence, result));
    runner.audits[0].send({ type: 'audit-result', result }); runner.audits[0].resolve(); await settle();
    expect(service.read('alice', first.id)).toMatchObject({ status: 'review',
      backgroundReview: { status: 'error', reason: 'formalization_audit_binding_mismatch' } });
  });

  it('checks the frozen audit file on restore and leaves the compiled source usable if it changes', async () => {
    const first = await compile(), result = formalizationAuditFixture(first.evidence);
    runner.audits[0].send({ type: 'audit-result', result }); runner.audits[0].resolve(); await settle();
    storage.deleteRecord(['owners', mathDigest('alice'), 'formalizations', first.id, 'audit.json']);
    const value = service.read('alice', first.id);
    expect(value.backgroundReview).toMatchObject({ status: 'error', reason: 'formalization_audit_evidence_changed' });
    expect(value.backgroundReview).not.toHaveProperty('result');
    expect(service.confirm('alice', first.id, first.value.report!.evidenceSha256).report!.statement).toBe(first.evidence.candidate.source);
  });
});
