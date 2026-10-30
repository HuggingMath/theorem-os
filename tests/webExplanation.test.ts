import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { excerptLines, explanationDocument, explanationMarkdownFilename, verifyExplanationEvidence } from '../apps/web/explanation';
import { explanationKey, WebExplanations } from '../apps/web/explanations';
import { explanationStopReason, startGatewayForwarder } from '../apps/web/explanationWorker';
import { parseExplanationMessage, type WebRunner } from '../apps/web/runner';
import type { WebExplanation, WebRun, WorkerExplanationInput, WorkerExplanationMessage } from '../apps/web/shared';
import { WebStorage, WebStorageError } from '../apps/web/storage';
import { webExplanationEvidence, type FixtureUnit } from './helpers/webExplanationFixture';

// Synthetic one-file proof and preset explanations; no model, provider or container is involved.
const PROOF = ['def double (n : Nat) : Nat := n + n', '',
  'theorem double_eq (n : Nat) : double n = 2 * n := by', '  unfold double', '  omega', '',
  'theorem target_thm (n : Nat) : double n + 0 = 2 * n := by', '  rw [Nat.add_zero]', '  exact double_eq n', ''].join('\n');
const UNITS: FixtureUnit[] = [
  { name: 'double', kind: 'definition', snippet: 'def double (n : Nat) : Nat := n + n' },
  { name: 'double_eq', kind: 'theorem', snippet: 'theorem double_eq (n : Nat) : double n = 2 * n := by\n  unfold double\n  omega',
    uses: ['double'] },
  { name: 'target_thm', kind: 'theorem', uses: ['double', 'double_eq'],
    snippet: 'theorem target_thm (n : Nat) : double n + 0 = 2 * n := by\n  rw [Nat.add_zero]\n  exact double_eq n',
    steps: [['rw [Nat.add_zero]'], ['exact double_eq n']] },
];
const evidence = (options: { proof?: string; maxUnits?: number; language?: 'zh' | 'en' } = {}) =>
  webExplanationEvidence({ proof: options.proof ?? PROOF, target: 'target_thm', units: UNITS, ...options });
const binding = { proof: PROOF, target: 'target_thm', language: 'zh' as const, environment: 'standard' as const };
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const settle = async () => { for (let index = 0; index < 6; index++) await tick(); };

describe('web explanation projection', () => {
  it('places each declaration and step on the proof file lines it explains', () => {
    const { evidence: verified } = verifyExplanationEvidence(roundTrip(evidence()), binding);
    const document = explanationDocument(verified, PROOF);
    expect(document.sections.map(section => [section.name, section.target, section.lines, section.signature])).toEqual([
      ['double', false, { start: 1, end: 1 }, { start: 1, end: 1 }], ['double_eq', false, { start: 3, end: 5 }, { start: 3, end: 3 }],
      ['target_thm', true, { start: 7, end: 9 }, { start: 7, end: 7 }]]);
    expect(document.sections[1]!.steps.map(step => step.lines)).toEqual([[{ start: 3, end: 5 }]]);
    expect(document.sections[2]!.steps.map(step => step.lines)).toEqual([[{ start: 8, end: 8 }], [{ start: 9, end: 9 }]]);
    // The fixture cites double_eq in the first step; it is written in the second step's line.
    expect(document.sections[2]!.steps[0]!.uses).toEqual([{ name: 'double_eq', place: 'declaration', spans: [{ line: 9, start: 8, end: 17 }] }]);
    expect(document.sections.map(section => section.unexplained)).toEqual([[], [], []]);
    expect(document.metrics).toMatchObject({ proofLines: 4, explainedLines: 4, ambiguousExcerpts: 0 });
    expect(document).toMatchObject({ target: 'target_thm', language: 'zh', overview: 'Combine the lemmas.', axioms: ['propext'],
      model: 'deepseek-flash', effort: 'max', auditors: 2, rounds: 1, tokens: 240, mathlibRevision: null });
    expect(JSON.stringify(document)).not.toContain('/preset-only');
  });

  it('maps excerpts whose whitespace differs from the source, merging touching ranges', () => {
    const unit = { source: 'theorem t : True := by\n  first\n    | trivial\n  done', range: { line: 10, column: 0, endLine: 13, endColumn: 6 } };
    expect(excerptLines(unit, ['first | trivial'])).toEqual([{ start: 11, end: 12 }]);
    expect(excerptLines(unit, ['done', 'first'])).toEqual([{ start: 11, end: 11 }, { start: 13, end: 13 }]);
    expect(excerptLines(unit, ['done', 'first   |'])).toEqual([{ start: 11, end: 13 }]);
    expect(excerptLines(unit, ['done', '| trivial', 'first'])).toEqual([{ start: 11, end: 13 }]);
    expect(excerptLines(unit, ['not there'])).toEqual([]);
  });

  it('ties statements to signatures, places repeated tactics in step order, and finds where cited names are written', () => {
    const proof = ['/-- Swap sides (`a := b`). -/', 'theorem helper (a b : Nat)', '    -- not the body := yet', '    (h : a = b) : b = a := by',
      '  exact h.symm', '', 'theorem main_thm (n : Nat) :', '    n = n ∧ ¬ n < n ∧ n + 0 = n := by', '  refine ⟨?_, ?_, ?_⟩',
      '  · omega', '  · exact Nat.lt_irrefl n', '  · omega', ''].join('\n');
    const units: FixtureUnit[] = [
      { name: 'helper', kind: 'theorem', external: ['Eq.symm'], cites: [['Eq.symm']],
        snippet: proof.slice(0, proof.indexOf('\n\n')) },
      { name: 'main_thm', kind: 'theorem', external: ['Nat.lt_irrefl', 'Int.lt_irrefl', 'HAdd.hAdd'],
        snippet: proof.slice(proof.indexOf('theorem main_thm'), -1),
        steps: [['· omega'], ['exact Nat.lt_irrefl n'], ['· omega']],
        cites: [['HAdd.hAdd'], ['Nat.lt_irrefl', 'Int.lt_irrefl'], ['Nat.lt_irrefl']] },
    ];
    const value = webExplanationEvidence({ proof, target: 'main_thm', units });
    const { evidence: verified } = verifyExplanationEvidence(roundTrip(value), { ...binding, proof, target: 'main_thm' });
    const [helper, main] = explanationDocument(verified, proof).sections;
    // The doc comment and the line comment hold `:=`; neither ends the signature.
    expect([helper!.lines, helper!.signature, helper!.unexplained]).toEqual([{ start: 1, end: 5 }, { start: 1, end: 4 }, []]);
    expect(helper!.steps[0]!.uses).toEqual([{ name: 'Eq.symm', place: 'step', spans: [{ line: 5, start: 10, end: 14 }] }]);
    expect([main!.lines, main!.signature, main!.unexplained]).toEqual([{ start: 7, end: 12 }, { start: 7, end: 8 }, [9]]);
    // The second `· omega` follows the step before it; both copies count as ambiguous.
    expect(main!.steps.map(step => step.lines)).toEqual([[{ start: 10, end: 10 }], [{ start: 11, end: 11 }], [{ start: 12, end: 12 }]]);
    // `lt_irrefl` after `Nat.` is not a short form of Int.lt_irrefl.
    expect(main!.steps.map(step => step.uses)).toEqual([[{ name: 'HAdd.hAdd', place: 'implicit', spans: [] }],
      [{ name: 'Nat.lt_irrefl', place: 'step', spans: [{ line: 11, start: 10, end: 23 }] }, { name: 'Int.lt_irrefl', place: 'implicit', spans: [] }],
      [{ name: 'Nat.lt_irrefl', place: 'declaration', spans: [{ line: 11, start: 10, end: 23 }] }]]);
    // Only the first auditor wrote explanations; blank ones are not shown.
    expect([main!.statementReviews, main!.steps.map(step => step.reviews.length)]).toEqual([['The statement matches the signature of main_thm.'], [1, 1, 1]]);
    expect(explanationDocument(verified, proof).metrics).toMatchObject({ proofLines: 5, explainedLines: 4, ambiguousExcerpts: 2 });
  });

  it('shows each step the goals around its outermost quoted tactics, and none without recorded goals', () => {
    const goal = (target: string) => 'n : Nat\n⊢ ' + target;
    const units: FixtureUnit[] = UNITS.map(unit => unit.name !== 'target_thm' ? unit : { ...unit,
      steps: [['rw [Nat.add_zero]'], ['double_eq n']],
      goals: [{ snippet: 'rw [Nat.add_zero]', before: [goal('double n + 0 = 2 * n')], after: [goal('double n = 2 * n')] },
        { snippet: 'Nat.add_zero', before: [goal('double n + 0 = 2 * n')], after: [] },
        { snippet: 'exact double_eq n', before: [goal('double n = 2 * n')], after: [] }] });
    const value = webExplanationEvidence({ proof: PROOF, target: 'target_thm', units });
    expect(value.outline.goalStates).toEqual({ protocol: 'lean-tactic-goals-v1', status: 'complete' });
    const sections = explanationDocument(verifyExplanationEvidence(roundTrip(value), binding).evidence, PROOF).sections;
    // The rewrite rule nests in `rw`; the second step quotes part of `exact` and gets its goals.
    expect(sections[2]!.steps.map(step => step.goals)).toEqual([
      { before: [goal('double n + 0 = 2 * n')], beforeCount: 1, after: [goal('double n = 2 * n')], afterCount: 1, lines: { start: 8, end: 8 } },
      { before: [goal('double n = 2 * n')], beforeCount: 1, after: [], afterCount: 0, lines: { start: 9, end: 9 } }]);
    // double_eq is in the goals' file but has no tactics recorded; old evidence has no goal states at all.
    expect(sections[1]!.steps.every(step => !('goals' in step))).toBe(true);
    const old = explanationDocument(verifyExplanationEvidence(roundTrip(evidence()), binding).evidence, PROOF);
    expect(old.sections.flatMap(section => section.steps).some(step => 'goals' in step)).toBe(false);
  });

  it('sums rounds and reported tokens across batches', () => {
    const document = explanationDocument(verifyExplanationEvidence(roundTrip(evidence({ maxUnits: 1 })), binding).evidence, PROOF);
    expect(document).toMatchObject({ rounds: 3, tokens: 720, overview: 'Combine the lemmas.' });
    expect(document.sections.map(section => section.name)).toEqual(['double', 'double_eq', 'target_thm']);
  });

  it('rejects evidence about another proof, target, language or environment, and altered evidence', () => {
    const mismatch = (value: unknown, change: Partial<typeof binding> = {}) =>
      expect(() => verifyExplanationEvidence(roundTrip(value), { ...binding, ...change })).toThrow('explanation_evidence_mismatch');
    mismatch(evidence({ proof: PROOF + '\n-- edited\n' }));
    mismatch(evidence(), { target: 'double_eq' });
    mismatch(evidence({ language: 'en' }));
    mismatch(evidence(), { environment: 'mathlib' });
    const altered = roundTrip(evidence());
    altered.batches[0]!.writer.sections[0]!.title = 'Something else';
    expect(() => verifyExplanationEvidence(altered, binding)).toThrow('explanation_evidence_invalid');
    expect(() => verifyExplanationEvidence({}, binding)).toThrow('explanation_evidence_invalid');
  });

  it('names downloads from the run and target with filename-safe characters only', () => {
    expect(explanationMarkdownFilename('0123456789ab-cdef', 'Foo.bar_baz', 'zh')).toBe('theoremos-01234567-Foo.bar_baz-zh.md');
    expect(explanationMarkdownFilename('0123456789ab', '«weird name»"\n', 'en')).toBe('theoremos-01234567-weird_name-en.md');
    expect(explanationMarkdownFilename('0123456789ab', '...', 'en')).toBe('theoremos-01234567-theorem-en.md');
  });
});

type ExplainCall = { input: WorkerExplanationInput; signal: AbortSignal; send(message: WorkerExplanationMessage): void;
  resolve(): void; reject(error: Error): void };
class ExplainRunner implements WebRunner {
  calls: ExplainCall[] = [];
  async readiness() { return { ready: true, message: 'ready' }; }
  async run() { throw new Error('runs are not used here'); }
  explain(input: WorkerExplanationInput, send: (message: WorkerExplanationMessage) => void, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      // A copy: the manager clears the key from its own input when the job ends.
      this.calls.push({ input: { ...input }, signal, send, resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('explanation_cancelled')), { once: true });
    });
  }
}
const run = (id = '11111111-2222-4333-8444-555555555555'): WebRun => ({ id, title: 'Doubling', status: 'completed',
  phase: 'evaluated_passed', createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z', providerId: 'sub2api',
  model: 'deepseek-flash', effort: 'max', environment: 'standard', source: PROOF, task: 'Prove it', maxTurns: 1, maxRunSeconds: 60,
  workers: 1, coordination: 'cooperative', events: [], result: { status: 'evaluated_passed', proof: PROOF, report: {} } });
const provider = { id: 'sub2api', name: 'Sub2API', baseUrl: 'http://host.docker.internal:8080/v1' };
const request = (target = 'target_thm', language: 'zh' | 'en' = 'zh') =>
  ({ target, language, apiKey: 'sk-explain-test-key', provider, model: 'deepseek-flash', effort: 'max' as const });
const status = (action: () => unknown) => {
  try { action(); } catch (error) { return error instanceof WebStorageError ? error.status : -1; }
  return 0;
};

describe('web explanation jobs', () => {
  it('queues, runs and stores an approved explanation; the key reaches only the worker input', async () => {
    const storage = new WebStorage(), runner = new ExplainRunner(), jobs = new WebExplanations(runner, storage);
    const created = jobs.create('owner-a', run(), request());
    expect(created).toMatchObject({ status: 'queued', queue: { position: 1, ahead: 0 }, maxRunSeconds: 8 * 60 * 60 });
    expect(JSON.stringify(created)).not.toContain('sk-explain-test-key');
    await settle();
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.input).toMatchObject({ id: created.id, proof: PROOF, target: 'target_thm', language: 'zh',
      environment: 'standard', apiKey: 'sk-explain-test-key', provider, auditors: 2, maxRoundsPerBatch: 6 });
    expect(status(() => jobs.create('owner-a', run(), request()))).toBe(409);
    runner.calls[0]!.send({ type: 'progress', progress: { phase: 'writing', batches: 1, approvedBatches: 0, round: 1, tokens: 10 } });
    expect(jobs.get('owner-a', run().id, 'target_thm', 'zh')).toMatchObject({ status: 'running',
      progress: { phase: 'writing', batches: 1, round: 1, tokens: 10 } });
    expect(jobs.active('owner-a', run().id)).toBe(true);
    runner.calls[0]!.send({ type: 'result', status: 'approved', evidence: roundTrip(evidence()) });
    runner.calls[0]!.resolve();
    await settle();
    const stored = jobs.get('owner-a', run().id, 'target_thm', 'zh')!;
    expect(stored.status).toBe('approved');
    expect(stored.progress).toBeUndefined();
    // The document is projected from the evidence on each read and never stored.
    expect(stored.document).toBeUndefined();
    expect(storage.getExplanation('owner-a', run().id, explanationKey('target_thm', 'zh'))!.document).toBeUndefined();
    expect(jobs.read('owner-a', run(), 'target_thm', 'zh')).toMatchObject({ status: 'approved',
      document: { target: 'target_thm', tokens: 240, metrics: { proofLines: 4, explainedLines: 4 } } });
    expect(jobs.active('owner-a', run().id)).toBe(false);
    expect(storage.getExplanationEvidence('owner-a', run().id, explanationKey('target_thm', 'zh'))).toBeTruthy();
    expect(jobs.list('owner-a', run().id)).toEqual([expect.not.objectContaining({ document: expect.anything() })]);
    expect(JSON.stringify(storage.getExplanation('owner-a', run().id, explanationKey('target_thm', 'zh')))).not.toContain('sk-explain');
    expect(status(() => jobs.create('owner-a', run(), request()))).toBe(409);
    // Evidence that no longer verifies against the run's proof yields no document, only the reason.
    const edited = jobs.read('owner-a', { ...run(), result: { ...run().result!, proof: PROOF + '\n' } }, 'target_thm', 'zh')!;
    expect([edited.status, edited.reason, edited.document]).toEqual(['approved', 'explanation_evidence_mismatch', undefined]);
    const altered = roundTrip(evidence());
    altered.batches[0]!.writer.sections[0]!.title = 'Something else';
    // Stored evidence cannot be overwritten through storage; this stands for a file changed on disk.
    const read = vi.spyOn(storage, 'getExplanationEvidence').mockReturnValue(altered);
    expect(jobs.read('owner-a', run(), 'target_thm', 'zh')).toMatchObject({ status: 'approved', reason: 'explanation_evidence_invalid' });
    read.mockRestore();
    expect(jobs.remove('owner-a', run().id, 'target_thm', 'zh')).toBe('deleted');
    expect(jobs.remove('owner-a', run().id, 'target_thm', 'zh')).toBe('missing');
  });

  it('records the worker reason, and rejects evidence that does not explain this proof', async () => {
    const storage = new WebStorage(), runner = new ExplainRunner(), jobs = new WebExplanations(runner, storage);
    const outcome = async (language: 'zh' | 'en', act: (call: ExplainCall) => void) => {
      jobs.create('owner-a', run(), request('target_thm', language));
      await settle();
      act(runner.calls.at(-1)!);
      await settle();
      const result = jobs.get('owner-a', run().id, 'target_thm', language)!;
      jobs.remove('owner-a', run().id, 'target_thm', language);
      return [result.status, result.reason];
    };
    expect(await outcome('zh', call => { call.send({ type: 'result', status: 'approved', evidence: roundTrip(evidence({ proof: PROOF + '\n' })) }); call.resolve(); }))
      .toEqual(['error', 'explanation_evidence_mismatch']);
    expect(storage.getExplanationEvidence('owner-a', run().id, explanationKey('target_thm', 'zh'))).toBeUndefined();
    expect(await outcome('zh', call => { call.send({ type: 'result', status: 'exhausted', reason: 'informalization_rounds_exhausted' }); call.resolve(); }))
      .toEqual(['exhausted', 'informalization_rounds_exhausted']);
    expect(await outcome('zh', call => call.reject(new Error('explanation_timeout')))).toEqual(['error', 'explanation_timeout']);
    expect(await outcome('zh', call => call.reject(new Error('provider said: sk-explain-test-key')))).toEqual(['error', 'explanation_failed']);
    expect(await outcome('en', call => call.resolve())).toEqual(['error', 'explanation_worker_no_result']);
  });

  it('limits explanations per owner and in total', async () => {
    const runner = new ExplainRunner(), jobs = new WebExplanations(runner, new WebStorage(), { concurrency: 1, queueLimit: 3, perOwner: 2 });
    jobs.create('owner-a', run(), request('target_thm', 'zh'));
    const second = jobs.create('owner-a', run(), request('target_thm', 'en'));
    // Both wait until the queue starts on the next microtask.
    expect(second.queue).toEqual({ position: 2, ahead: 1 });
    expect(status(() => jobs.create('owner-a', run(), request('double_eq', 'zh')))).toBe(429);
    jobs.create('owner-b', run(), request('target_thm', 'zh'));
    expect(status(() => jobs.create('owner-c', run(), request('target_thm', 'zh')))).toBe(429);
    await settle();
    expect(runner.calls).toHaveLength(1);
    await jobs.close();
  });

  it('cancels a running job, and a late worker result changes nothing', async () => {
    const storage = new WebStorage(), runner = new ExplainRunner(), jobs = new WebExplanations(runner, storage);
    jobs.create('owner-a', run(), request());
    await settle();
    const [call] = runner.calls;
    expect(jobs.cancel('owner-a', run().id, 'target_thm', 'zh')).toMatchObject({ status: 'cancelled' });
    expect(call!.signal.aborted).toBe(true);
    call!.send({ type: 'result', status: 'approved', evidence: roundTrip(evidence()) });
    await settle();
    expect(jobs.get('owner-a', run().id, 'target_thm', 'zh')).toMatchObject({ status: 'cancelled' });
    expect(storage.getExplanationEvidence('owner-a', run().id, explanationKey('target_thm', 'zh'))).toBeUndefined();
    // A cancelled attempt can be started again.
    expect(jobs.create('owner-a', run(), request())).toMatchObject({ status: 'queued' });
    await jobs.close();
  });

  it('writes nothing for a forgotten owner, and interrupts unfinished jobs on close and on restart', async () => {
    const storage = new WebStorage(), runner = new ExplainRunner(), jobs = new WebExplanations(runner, storage);
    storage.saveRun('owner-a', run());
    jobs.create('owner-a', run(), request());
    await settle();
    jobs.forget('owner-a'); storage.deleteOwner('owner-a');
    expect(runner.calls[0]!.signal.aborted).toBe(true);
    await settle();
    expect(storage.listExplanations('owner-a', run().id)).toEqual([]);

    storage.saveRun('owner-b', run());
    jobs.create('owner-b', run(), request());
    await settle();
    await jobs.close();
    expect(storage.getExplanation('owner-b', run().id, explanationKey('target_thm', 'zh')))
      .toMatchObject({ status: 'error', reason: 'explanation_interrupted' });
    expect(status(() => jobs.create('owner-b', run(), request('target_thm', 'en')))).toBe(503);

    const stale: WebExplanation = { ...storage.getExplanation('owner-b', run().id, explanationKey('target_thm', 'zh'))!,
      status: 'running', reason: undefined, finishedAt: undefined };
    storage.saveExplanation('owner-b', explanationKey('target_thm', 'zh'), stale);
    new WebExplanations(new ExplainRunner(), storage);
    expect(storage.getExplanation('owner-b', run().id, explanationKey('target_thm', 'zh')))
      .toMatchObject({ status: 'error', reason: 'explanation_interrupted', finishedAt: expect.any(String) });
  });
});

describe('explanation worker protocol', () => {
  it('accepts only phase progress, evidence objects and reason codes from the container', () => {
    expect(parseExplanationMessage(JSON.stringify({ type: 'progress', progress: { phase: 'auditing', batches: 2, approvedBatches: 1, round: 2, tokens: 0 } })))
      .toEqual({ type: 'progress', progress: { phase: 'auditing', batches: 2, approvedBatches: 1, round: 2, tokens: 0 } });
    expect(parseExplanationMessage('{"type":"result","status":"approved","evidence":{"schema":"x"}}')).toMatchObject({ status: 'approved' });
    expect(parseExplanationMessage('{"type":"result","status":"error","reason":"informalization_proof_does_not_compile"}'))
      .toMatchObject({ reason: 'informalization_proof_does_not_compile' });
    for (const line of [
      '{"type":"progress","progress":{"phase":"thinking"}}',
      '{"type":"progress","progress":{"phase":"writing","message":"model text"}}',
      '{"type":"result","status":"error","reason":"informalization_proof_does_not_compile: Submission.lean: unknown id"}',
      '{"type":"result","status":"approved","evidence":[]}',
      '{"type":"result","status":"approved","evidence":{},"extra":1}',
      'not json',
    ]) expect(parseExplanationMessage(line)).toBeUndefined();
  });

  it('reduces run errors to reason codes', () => {
    expect(explanationStopReason('exhausted', 'informalization_rounds_exhausted: batch 1/1 (a, b)', false))
      .toEqual({ status: 'exhausted', reason: 'informalization_rounds_exhausted' });
    expect(explanationStopReason('stopped', 'math_total_token_limit', false)).toEqual({ status: 'exhausted', reason: 'explanation_token_limit' });
    expect(explanationStopReason('stopped', 'informalization_time_limit', false)).toEqual({ status: 'exhausted', reason: 'informalization_time_limit' });
    expect(explanationStopReason('stopped', 'This operation was aborted', true)).toEqual({ status: 'exhausted', reason: 'informalization_time_limit' });
    expect(explanationStopReason('stopped', 'informalization_proof_does_not_compile: Submission.lean: error text', false))
      .toEqual({ status: 'error', reason: 'informalization_proof_does_not_compile' });
    expect(explanationStopReason('stopped', 'informalization_role_incomplete:failed:other:model said', false))
      .toEqual({ status: 'error', reason: 'informalization_role_incomplete' });
    expect(explanationStopReason('stopped', 'formalization_sandbox_canary_failed', false))
      .toEqual({ status: 'error', reason: 'explanation_sandbox_canary_failed' });
    expect(explanationStopReason('stopped', 'Unexpected token < in JSON', false)).toEqual({ status: 'error', reason: 'explanation_failed' });
    expect(explanationStopReason('stopped', undefined, false)).toEqual({ status: 'error', reason: 'explanation_failed' });
  });

  it('forwards the fixed relay address to the configured gateway and nothing else', async () => {
    for (const url of ['https://gateway.example/v1', 'http://host.docker.internal:8080/v2', 'http://u:p@host.docker.internal:8080/v1',
      'http://host.docker.internal:8080/v1?x=1']) expect(() => startGatewayForwarder(url)).toThrow('explanation_provider_unsupported');
    await expect(startGatewayForwarder('http://127.0.0.1:8080/v1')).resolves.toBeUndefined();
    const upstream = net.createServer({ allowHalfOpen: true }, socket => {
      let received = '';
      socket.on('data', chunk => { received += chunk; });
      socket.on('end', () => socket.end('pong:' + received));
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as net.AddressInfo).port;
    const forwarder = (await startGatewayForwarder(`http://127.0.0.1:${port}/v1`, { host: '127.0.0.1', port: 0 }))!;
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const client = net.connect({ host: '127.0.0.1', port: (forwarder.address() as net.AddressInfo).port, allowHalfOpen: true }, () => client.end('ping'));
        let text = '';
        client.on('data', chunk => { text += chunk; });
        client.on('end', () => resolve(text));
        client.on('error', reject);
      });
      expect(reply).toBe('pong:ping');
    } finally {
      forwarder.close(); upstream.close();
    }
  });
});
