import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig, webDefaults, webLimits, type WebConfig } from '../apps/web/config';
import { WebFormalizations, verifyWebFormalizationEvidence } from '../apps/web/formalizations';
import { webFormalizationDefaults, webFormalizationLimits, type WebFormalization, type WorkerFormalizationInput, type WorkerFormalizationMessage } from '../apps/web/formalizationTypes';
import type { WebRunner } from '../apps/web/runner';
import { WebKeyVault } from '../apps/web/keyVault';
import { WebStorage } from '../apps/web/storage';
import type { WebRun, WebSession, WorkerInput, WorkerMessage } from '../apps/web/shared';
import { assertFormalizationEvidence, formalizationCompiledCandidate, formalizationCompiledCandidateDigest, formalizationDigest,
  formalizationInputDigest, formalizationReviewInput } from '../src/math/formalization';
import { mailsCompletion } from '../apps/web/completionMail';
import { shareSnapshot } from '../apps/web/share';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { LEAN_STATEMENT_CONTEXT_PROTOCOL } from '../src/math/leanStatementSemantic';

import { semanticReviewFixture, syntheticElaboration } from './helpers/formalizationFixture';
import { webFormalizationStatement as fixtureStatement, webFormalizationEvidence,
  webDirectFormalizationEvidence, webReviewedFormalizationEvidence } from './helpers/webFormalizationFixture';

const KEY = 'sk-synthetic-formalization-test';
const body = { original: fixtureStatement, environment: 'standard', effort: 'max', apiKey: KEY };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
type Pending = { input: WorkerFormalizationInput; signal: AbortSignal; send(message: WorkerFormalizationMessage): void; resolve(): void };
class Runner implements WebRunner {
  pending: Pending[] = [];
  inputs: WorkerFormalizationInput[] = [];
  runs: WorkerInput[] = [];
  proofs: { input: WorkerInput; signal: AbortSignal; send(message: WorkerMessage): void; resolve(): void }[] = [];
  ready = true;
  async readiness() { return { ready: this.ready, message: 'Disposable test runner' }; }
  run(input: WorkerInput, send: (message: WorkerMessage) => void, signal: AbortSignal) {
    this.runs.push(input);
    return new Promise<void>(resolve => {
      this.proofs.push({ input, send, resolve, signal });
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
  formalize(input: WorkerFormalizationInput, send: (message: WorkerFormalizationMessage) => void, signal: AbortSignal) {
    this.inputs.push(input);
    return new Promise<void>(resolve => {
      this.pending.push({ input: { ...input }, signal, send, resolve });
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
}
type Client = { cookie: string; csrf: string };
describe('online formalization ownership and evidence handoff', () => {
  let root: string, config: WebConfig, runner: Runner, service: ReturnType<typeof createWebService>, base: string;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-formalization-'));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    base = `http://127.0.0.1:${port}`;
    config = { ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base }), staticRoot: root,
      dataRoot: path.join(root, 'data') };
    runner = new Runner(); service = createWebService(config, runner, { sample: null });
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
  });
  afterEach(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function client(): Promise<Client> {
    const response = await fetch(base + '/api/session', { headers: { Connection: 'close' } }), value = await response.json() as WebSession;
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: value.csrfToken };
  }
  function request(client: Client, route: string, value?: unknown, method = value === undefined ? 'GET' : 'POST') {
    // Restarts must not reuse a keep-alive connection from the previous service instance.
    return fetch(base + route, { method, headers: { Connection: 'close', Cookie: client.cookie, 'X-CSRF-Token': client.csrf,
      ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: value === undefined ? undefined : JSON.stringify(value) });
  }
  async function create(client: Client, solve = false, humanReview?: boolean) {
    const response = await request(client, '/api/formalizations', { ...body, ...(solve ? { solve: true } : {}),
      ...(humanReview === undefined ? {} : { humanReview }) });
    expect(response.status).toBe(201);
    await settle();
    return (await response.json() as { formalization: WebFormalization }).formalization;
  }
  async function approve(client: Client) {
    const value = await create(client), pending = runner.pending.at(-1)!, evidence = webFormalizationEvidence(pending.input);
    expect(() => assertFormalizationEvidence(evidence)).not.toThrow();
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    const response = await request(client, `/api/formalizations/${value.id}`);
    expect(response.status).toBe(200);
    const formalization = (await response.json() as { formalization: WebFormalization }).formalization;
    expect(formalization.status).toBe('review'); expect(formalization.report?.evidenceSha256).toBe(formalizationDigest(evidence));
    return formalization;
  }
  function runBody(formalization: WebFormalization) {
    return { providerId: 'sub2api', apiKey: KEY, model: 'deepseek-flash', effort: 'max', environment: formalization.environment,
      source: formalization.report!.statement, task: 'Prove the confirmed statement', maxTurns: 1, maxRunSeconds: 60,
      workers: 1, coordination: 'cooperative', formalizationId: formalization.id };
  }

  it('starts one proof from the compiled snapshot before review finishes and later binds the same candidate', async () => {
    const alice = await client(), bob = await client(), value = await create(alice, true);
    const pending = runner.pending.at(-1)!, evidence = webFormalizationEvidence(pending.input);
    const candidate = formalizationCompiledCandidate(evidence), digest = formalizationCompiledCandidateDigest(candidate);
    pending.send({ type: 'compiled', candidate }); await settle();
    const route = `/api/formalizations/${value.id}`;
    const live = (await (await request(alice, route)).json()).formalization as WebFormalization;
    expect(live).toMatchObject({ status: 'running', compiled: { digest, source: evidence.candidate.source } });
    expect(live.runId).toBeTruthy(); expect(live.report).toBeUndefined(); expect(live.confirmation).toBeUndefined();
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0].compiledFormalization).toEqual(candidate);
    expect(runner.runs[0].formalization).toBeUndefined();
    expect(runner.runs[0].input).toMatchObject({ source: candidate.candidate.source, maxTurns: 0, maxRunSeconds: 0, maxTotalTokens: 0 });
    const run = (await (await request(alice, `/api/runs/${live.runId}`)).json()).run as WebRun;
    expect(run.formalization).toMatchObject({ id: value.id, candidateDigest: digest, confirmation: 'pending' });
    expect(run.formalization?.evidenceSha256).toBeUndefined(); expect(run.formalization?.confirmedAt).toBeUndefined();
    expect((await request(bob, `/api/runs/${live.runId}`)).status).toBe(404);
    pending.send({ type: 'compiled', candidate: structuredClone(candidate) }); await settle();
    expect(runner.runs).toHaveLength(1);
    const frozenTask = runner.runs[0].input.task;
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    const done = (await (await request(alice, route)).json()).formalization as WebFormalization;
    expect(done).toMatchObject({ status: 'confirmed', runId: live.runId, confirmation: 'automatic' });
    const updated = (await (await request(alice, `/api/runs/${live.runId}`)).json()).run as WebRun;
    expect(updated.formalization).toMatchObject({ confirmation: 'automatic', candidateDigest: digest, evidenceSha256: formalizationDigest(evidence) });
    expect(updated.events.some(event => event.type === 'statement_review_updated')).toBe(true);
    expect(runner.runs).toHaveLength(1); expect(runner.runs[0].input.task).toBe(frozenTask);
    expect(runner.runs[0].compiledFormalization).toEqual(candidate); expect(runner.runs[0].formalization).toBeUndefined();
  });

  it('keeps a completed Lean proof usable while meaning is pending and withholds sharing and completion until approval', async () => {
    const alice = await client(); await create(alice, true); const pending = runner.pending.at(-1)!;
    const evidence = webFormalizationEvidence(pending.input), candidate = formalizationCompiledCandidate(evidence);
    pending.send({ type: 'compiled', candidate }); await settle();
    const proof = runner.proofs[0];
    proof.send({ type: 'result', result: { status: 'evaluated_passed',
      proof: 'theorem addition (n : Nat) : n + 1 = 1 + n := by omega\n', report: {} } });
    proof.resolve(); await settle();
    const run = (await (await request(alice, `/api/runs/${proof.input.id}`)).json()).run as WebRun;
    expect(run).toMatchObject({ status: 'completed', result: { status: 'evaluated_passed' }, formalization: { confirmation: 'pending' } });
    expect(run.result?.proof).toContain('by omega');
    expect(shareSnapshot(run)).toBeUndefined(); expect(mailsCompletion(run)).toBe(false);
    const generation = await (await request(alice, `/api/runs/${proof.input.id}/explanations`)).json();
    expect(generation.generation.available).toBe(false);
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    const approved = (await (await request(alice, `/api/runs/${proof.input.id}`)).json()).run as WebRun;
    expect(approved.formalization?.confirmation).toBe('automatic');
    expect(approved.result).toEqual(run.result); expect(mailsCompletion(approved)).toBe(true);
    expect(runner.runs).toHaveLength(1);
  });

  it.each([false, true])('does not begin background proof when solve/manual review requests it: manual=%s', async manual => {
    const alice = await client(), value = await create(alice, manual, manual || undefined), pending = runner.pending.at(-1)!;
    const candidate = formalizationCompiledCandidate(webFormalizationEvidence(pending.input));
    pending.send({ type: 'compiled', candidate }); await settle();
    const live = (await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization as WebFormalization;
    expect(live.compiled?.source).toBe(candidate.candidate.source); expect(live.runId).toBeUndefined();
    expect(runner.runs).toEqual([]);
  });

  it('stops background review and its proof together and ignores late approved messages', async () => {
    const alice = await client(), value = await create(alice, true), pending = runner.pending.at(-1)!;
    const evidence = webFormalizationEvidence(pending.input);
    pending.send({ type: 'compiled', candidate: formalizationCompiledCandidate(evidence) }); await settle();
    const runId = runner.runs[0].id;
    const cancelled = await request(alice, `/api/formalizations/${value.id}/cancel`, {});
    expect((await cancelled.json()).formalization.status).toBe('cancelled');
    expect(pending.signal.aborted).toBe(true); expect(runner.proofs[0].signal.aborted).toBe(true);
    pending.send({ type: 'result', status: 'approved', evidence }); await settle();
    const run = (await (await request(alice, `/api/runs/${runId}`)).json()).run as WebRun;
    expect(run).toMatchObject({ status: 'cancelled', formalization: { confirmation: 'interrupted' } });
    expect(run.formalization?.evidenceSha256).toBeUndefined(); expect(runner.runs).toHaveLength(1);
  });

  it.each(['source', 'snapshot', 'original', 'environment'] as const)('refuses a compiled handoff with changed %s before starting proof', async field => {
    const alice = await client(), value = await create(alice, true), pending = runner.pending.at(-1)!;
    const candidate = formalizationCompiledCandidate(webFormalizationEvidence(pending.input));
    if (field === 'source') candidate.candidate.source += '\n-- changed';
    if (field === 'snapshot') candidate.snapshotDigest = '0'.repeat(64);
    if (field === 'original') candidate.request.statement += ' changed';
    if (field === 'environment') candidate.request.environment = 'mathlib';
    pending.send({ type: 'compiled', candidate }); await settle();
    const ended = (await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization as WebFormalization;
    expect(ended.status).toBe('error'); expect(ended.runId).toBeUndefined();
    expect(runner.runs).toEqual([]); expect(pending.signal.aborted).toBe(true);
  });

  it('marks an interrupted background review after restart without approving or restarting its proof', async () => {
    const alice = await client(), value = await create(alice, true), pending = runner.pending.at(-1)!;
    pending.send({ type: 'compiled', candidate: formalizationCompiledCandidate(webFormalizationEvidence(pending.input)) }); await settle();
    const runId = runner.runs[0].id;
    await service.close();
    // Reproduce the saved state of a crash while the review was still running.
    const ownerDirectory = fs.readdirSync(path.join(config.dataRoot!, 'owners'))[0];
    const recordPath = path.join(config.dataRoot!, 'owners', ownerDirectory, 'formalizations', value.id, 'record.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    record.formalization.status = 'running'; delete record.formalization.finishedAt;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    service = createWebService(config, runner, { sample: null });
    await new Promise<void>(resolve => service.server.listen(config.port, '127.0.0.1', resolve));
    const restored = (await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization as WebFormalization;
    expect(restored).toMatchObject({ status: 'error', reason: 'formalization_interrupted', runId });
    const run = (await (await request(alice, `/api/runs/${runId}`)).json()).run as WebRun;
    expect(run.formalization?.confirmation).toBe('interrupted'); expect(run.formalization?.evidenceSha256).toBeUndefined();
    expect(runner.runs).toHaveLength(1); expect(runner.pending).toHaveLength(1);
  });

  it('cancels a rejected candidate and gives a revised compiled source its own proof identity', async () => {
    const alice = await client(), value = await create(alice, true), pending = runner.pending.at(-1)!;
    const evidence = webFormalizationEvidence(pending.input), first = formalizationCompiledCandidate(evidence);
    pending.send({ type: 'compiled', candidate: first }); await settle();
    pending.send({ type: 'activity', activity: { type: 'step', step: { step: 'revision', stage: 'round', round: 1,
      text: 'formalization_semantic_changes_requested: preserve an omitted condition' } } }); await settle();
    const oldId = runner.runs[0].id;
    expect(runner.proofs[0].signal.aborted).toBe(true);
    const rejected = (await (await request(alice, `/api/runs/${oldId}`)).json()).run as WebRun;
    expect(rejected.formalization?.confirmation).toBe('rejected');
    const source = first.candidate.source.replace('n + 1 = 1 + n', '1 + n = n + 1');
    const elaborated = syntheticElaboration(source, 'standard', { detailedContext: true, semanticContext: true, structureContext: true,
      boundedLibraryContext: first.request.contextProtocol === 'kernel-v3' });
    const candidate = { ...first.candidate, source: elaborated.source };
    const revised = formalizationCompiledCandidate({ ...first, candidate, inputDigest: formalizationInputDigest(first.request, candidate),
      sourceSha256: elaborated.sourceSha256, targets: elaborated.targets, snapshot: elaborated.snapshot,
      snapshotDigest: elaborated.snapshotDigest, compilation: elaborated.compilation as typeof first.compilation, round: 2 });
    expect(formalizationCompiledCandidateDigest(revised)).not.toBe(formalizationCompiledCandidateDigest(first));
    pending.send({ type: 'compiled', candidate: revised }); await settle();
    const live = (await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization as WebFormalization;
    expect(live).toMatchObject({ status: 'running', compiled: { digest: formalizationCompiledCandidateDigest(revised) } });
    expect(live.researchError).toBeUndefined();
    expect(live.runId).not.toBe(oldId);
    const revisedRun = (await (await request(alice, `/api/runs/${live.runId}`)).json()).run as WebRun;
    expect(revisedRun).toMatchObject({ status: 'running', formalization: { confirmation: 'pending' } });
    expect(runner.runs).toHaveLength(2); expect(runner.runs[1].id).not.toBe(oldId);
    expect(live.runId).toBe(runner.runs[1].id); expect(live.compiled?.source).toBe(revised.candidate.source);
    // An old approved result must never bless the new candidate or reuse its proof.
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    const ended = (await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization as WebFormalization;
    expect(ended).toMatchObject({ status: 'error', reason: 'formalization_candidate_changed_after_compilation' });
    expect(runner.proofs[1].signal.aborted).toBe(true);
    expect(runner.runs).toHaveLength(2);
  });

  it.each([undefined, 'max'] as const)('defaults omitted effort to high and preserves explicit effort %s through generation', async effort => {
    const alice = await client();
    const response = await request(alice, '/api/formalizations', { original: fixtureStatement, environment: 'standard', apiKey: KEY,
      ...(effort ? { effort } : {}) });
    expect(response.status).toBe(201); await settle();
    const value = (await response.json()).formalization as WebFormalization, pending = runner.pending.at(-1)!;
    expect(value).toMatchObject({ effort: effort ?? 'high', maxRunSeconds: 0, maxTotalTokens: 0 });
    expect(pending.input).toMatchObject({ effort: effort ?? 'high', maxRunSeconds: 0, maxTotalTokens: 0 });
    pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) }); pending.resolve(); await settle();
    const completed = (await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization as WebFormalization;
    expect(completed).toMatchObject({ status: 'review', effort: effort ?? 'high', report: { effort: effort ?? 'high' } });
  });

  it.each([
    { name: 'omitted defaults', settings: {}, generation: 'high', proof: 'high' },
    { name: 'explicit separate proof effort', settings: { effort: 'high', researchEffort: 'max' }, generation: 'high', proof: 'max' },
    { name: 'explicit high', settings: { effort: 'high' }, generation: 'high', proof: 'high' },
    { name: 'explicit low', settings: { effort: 'low' }, generation: 'low', proof: 'low' },
  ])('keeps $name across both compiled and approved proof handoffs', async ({ settings, generation, proof }) => {
    const alice = await client();
    for (const compiled of [false, true]) {
      const response = await request(alice, '/api/formalizations', { original: fixtureStatement, environment: 'standard', apiKey: KEY,
        solve: true, ...settings });
      expect(response.status).toBe(201); await settle();
      const value = (await response.json()).formalization as WebFormalization, pending = runner.pending.at(-1)!;
      expect(value).toMatchObject({ effort: generation, researchEffort: proof });
      expect(pending.input.effort).toBe(generation); expect(pending.input).not.toHaveProperty('researchEffort');
      const evidence = webFormalizationEvidence(pending.input);
      if (compiled) { pending.send({ type: 'compiled', candidate: formalizationCompiledCandidate(evidence) }); await settle(); }
      pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
      const completed = (await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization as WebFormalization;
      expect(completed).toMatchObject({ status: 'confirmed', effort: generation, researchEffort: proof, report: { effort: generation } });
      const run = runner.runs.at(-1)!;
      expect(run.input).toMatchObject({ effort: proof, maxRunSeconds: 0, maxTotalTokens: 0 });
      expect((run.formalization ?? run.compiledFormalization)?.request.effort).toBe(generation);
      runner.proofs.at(-1)!.resolve(); await settle();
    }
    expect(runner.runs).toHaveLength(2);
  });

  it.each([false, true])('keeps proof effort through restart and research retry (legacy=%s)', async legacy => {
    const alice = await client();
    const response = await request(alice, '/api/formalizations', { ...body, effort: 'high', solve: true,
      ...(legacy ? {} : { researchEffort: 'max' }) });
    expect(response.status).toBe(201); await settle();
    const value = (await response.json()).formalization as WebFormalization, pending = runner.pending.at(-1)!;
    config.queueLimit = 0;
    const evidence = webFormalizationEvidence(pending.input);
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    const recordPath = ['owners', mathDigest(alice.cookie.slice('theoremos_session='.length)), 'formalizations', value.id];
    if (legacy) {
      const stored = service.storage.getRecord<any>([...recordPath, 'record.json']);
      delete stored.formalization.researchEffort;
      service.storage.saveRecord([...recordPath, 'record.json'], stored);
    }
    await service.close(); runner = new Runner(); service = createWebService(config, runner, { sample: null });
    await new Promise<void>(resolve => service.server.listen(config.port, '127.0.0.1', resolve));
    config.queueLimit = 8;
    const resumed = await request(alice, `/api/formalizations/${value.id}/research`, { apiKey: KEY });
    expect(resumed.status).toBe(200); await settle();
    expect(runner.inputs).toHaveLength(0); expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0].input.effort).toBe(legacy ? 'high' : 'max');
    expect(runner.runs[0].formalization).toEqual(evidence);
    const persisted = service.storage.getRecord<any>([...recordPath, 'evidence.json']);
    expect(formalizationDigest(persisted)).toBe(formalizationDigest(evidence));
  });

  it('binds distinct proof effort to new receipts while replaying legacy equal-effort receipts', async () => {
    const alice = await client(), input = { ...body, requestId: 'legacy-effort-receipt' };
    const created = await request(alice, '/api/formalizations', input);
    expect(created.status).toBe(201);
    const value = (await created.json()).formalization as WebFormalization;
    const equivalent = await request(alice, '/api/formalizations', { ...input, researchEffort: 'max' });
    expect(equivalent.status).toBe(200); expect((await equivalent.json()).formalization.id).toBe(value.id);
    expect((await request(alice, '/api/formalizations', { ...input, researchEffort: 'high' })).status).toBe(409);
    const defaults = { ...body, effort: 'high', researchEffort: 'max', requestId: 'separate-effort-receipt' };
    expect((await request(alice, '/api/formalizations', defaults)).status).toBe(201);
    expect((await request(alice, '/api/formalizations', { ...defaults, researchEffort: 'high' })).status).toBe(409);
  });

  it('uses authenticated session and CSRF boundaries, hides other owners and never stores keys', async () => {
    const alice = await client(), bob = await client();
    expect((await fetch(base + '/api/formalizations')).status).toBe(401);
    expect((await request({ ...alice, csrf: '' }, '/api/formalizations', body)).status).toBe(403);
    expect((await request(alice, '/api/formalizations', { ...body, apiKey: '' })).status).toBe(400);
    const overview = await (await request(alice, '/api/formalizations')).json();
    expect(overview.generation).toMatchObject({ available: true, key: 'required', model: 'deepseek-flash' });
    const value = await create(alice), route = `/api/formalizations/${value.id}`;
    expect(runner.pending[0].input.apiKey).toBe(KEY);
    expect((await request(bob, route)).status).toBe(404);
    expect((await request(bob, route + '/cancel', {})).status).toBe(404);
    expect((await request(bob, route + '/confirm', { evidenceSha256: 'a'.repeat(64) })).status).toBe(404);
    const queued = await create(alice);
    expect(queued.queue).toMatchObject({ position: 1, ahead: 0, running: 1 });
    expect((await request(alice, '/api/formalizations', body)).status).toBe(429);
    expect((await request(alice, route, undefined, 'DELETE')).status).toBe(409);
    expect(JSON.stringify(await (await request(alice, '/api/formalizations')).json())).not.toContain(KEY);
    const persisted = fs.readdirSync(config.dataRoot!, { recursive: true }).filter(file => String(file).endsWith('.json'))
      .map(file => fs.readFileSync(path.join(config.dataRoot!, String(file)), 'utf8')).join('\n');
    expect(persisted).not.toContain(KEY);
    const cancel = await request(alice, route + '/cancel', {});
    expect((await cancel.json()).formalization.status).toBe('cancelled');
    expect(runner.pending[0].signal.aborted).toBe(true);
    runner.pending[0].send({ type: 'result', status: 'approved', evidence: {} }); await settle();
    expect((await (await request(alice, route)).json()).formalization.status).toBe('cancelled');
    expect((await request(alice, route, undefined, 'DELETE')).status).toBe(200);
    expect((await request(alice, route)).status).toBe(404);
  });

  it('retains formalization history and accepts new work after a crash before the initial record was published', async () => {
    const alice = await client(), owner = alice.cookie.slice('theoremos_session='.length);
    const orphan = path.join(service.storage.ownerDirectory(owner)!, 'formalizations', 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12));
    fs.mkdirSync(orphan, { recursive: true });
    // saveRecord creates its directory and writes a temporary file before atomically publishing record.json.
    fs.writeFileSync(path.join(orphan, 'record.json.abandoned.tmp'), '{"owner":');
    const restarted = new WebFormalizations(runner, new WebStorage(config.dataRoot!));
    expect(restarted.list(owner)).toEqual([]);
    const response = await request(alice, '/api/formalizations');
    expect(response.status).toBe(200);
    expect((await response.json()).formalizations).toEqual([]);
    const created = await create(alice);
    expect(restarted.list(owner).map(item => item.id)).toEqual([created.id]);
    expect(fs.readFileSync(path.join(orphan, 'record.json.abandoned.tmp'), 'utf8')).toBe('{"owner":');
  });

  it('replays a lost formalization receipt before admission, survives restart, and retains deletion identity', async () => {
    const alice = await client(), bob = await client(), requestId = 'natural-receipt-loss';
    const input = { ...body, requestId, solve: true, humanReview: true };
    const responses = await Promise.all([request(alice, '/api/formalizations', input), request(alice, '/api/formalizations', input)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    const receipts = await Promise.all(responses.map(response => response.json()));
    const value = receipts[0].formalization as WebFormalization;
    expect(receipts[1].formalization.id).toBe(value.id);
    await settle(); expect(runner.inputs).toHaveLength(1);
    expect((await request(alice, '/api/formalizations', { ...input, apiKey: '' })).status).toBe(200);
    expect((await request(alice, '/api/formalizations', { ...input, original: 'Changed statement' })).status).toBe(409);
    expect((await request(bob, `/api/formalizations/${value.id}`)).status).toBe(404);
    const other = await request(bob, '/api/formalizations', input);
    expect(other.status).toBe(201); expect((await other.json()).formalization.id).not.toBe(value.id);
    const pending = runner.pending[0]!;
    pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) });
    pending.resolve(); await settle();
    await service.close();
    runner = new Runner(); service = createWebService(config, runner, { sample: null });
    await new Promise<void>(resolve => service.server.listen(config.port, '127.0.0.1', resolve));
    runner.ready = false;
    const replay = await request(alice, '/api/formalizations', { ...input, apiKey: '' });
    expect(replay.status).toBe(200);
    expect((await replay.json()).formalization).toMatchObject({ id: value.id, status: 'review' });
    expect(runner.inputs).toHaveLength(0);
    expect((await request(alice, `/api/formalizations/${value.id}`, undefined, 'DELETE')).status).toBe(200);
    expect((await request(alice, '/api/formalizations', input)).status).toBe(410);
    const persisted = fs.readdirSync(config.dataRoot!, { recursive: true }).filter(file => String(file).endsWith('.json'))
      .map(file => fs.readFileSync(path.join(config.dataRoot!, String(file)), 'utf8')).join('\n');
    expect(persisted).not.toContain(KEY);
  });

  it('keeps the process view with its owner, pages it and removes it with the record', async () => {
    const alice = await client(), bob = await client();
    const value = await create(alice), route = `/api/formalizations/${value.id}`, pending = runner.pending.at(-1)!;
    const action = { workerId: 'r1-plan-1', itemId: '1:a', phase: 'completed', kind: 'message', status: 'done', text: 'reading the problem' } as const;
    pending.send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'role', workerId: 'r1-plan-1', role: 'plan', slot: 'plan-1', state: 'started' } } });
    pending.send({ type: 'activity', activity: { type: 'action', action } });
    pending.send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'compile', state: 'started', source: 'theorem t : True := by sorry' } } });
    await settle();
    const first = await (await request(alice, route + '/activity')).json();
    expect(first).toMatchObject({ count: 3, dropped: 0 });
    expect(first.activity.map((entry: { sequence: number; type: string }) => `${entry.sequence}:${entry.type}`)).toEqual(['1:step', '2:action', '3:step']);
    expect(first.activity[1]).toMatchObject({ type: 'action', action, sequence: 2 });
    expect(typeof first.activity[1].at).toBe('string');
    expect((await (await request(alice, route + '/activity?after=2')).json()).activity.map((entry: { sequence: number }) => entry.sequence)).toEqual([3]);
    expect((await (await request(alice, route)).json()).formalization.activity).toEqual({ count: 3 });
    expect((await request(alice, route + '/activity?after=-1')).status).toBe(400);
    expect((await request(alice, route + '/activity?after=x')).status).toBe(400);
    expect((await request(bob, route + '/activity')).status).toBe(404);
    expect((await fetch(base + route + '/activity')).status).toBe(401);
    expect((await request(alice, route + '/activity', {})).status).toBe(405);
    await request(alice, route + '/cancel', {});
    // A cancelled worker's late entries are not stored.
    pending.send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'approved' } } }); await settle();
    expect((await (await request(alice, route + '/activity')).json()).count).toBe(3);
    expect((await request(alice, route, undefined, 'DELETE')).status).toBe(200);
    expect((await request(alice, route + '/activity')).status).toBe(404);
    const stored = fs.readdirSync(config.dataRoot!, { recursive: true }).map(String);
    expect(stored.some(file => file.includes(value.id))).toBe(false);
  });

  it('requires explicit current evidence confirmation and preserves it through research creation', async () => {
    const alice = await client(), bob = await client(), value = await approve(alice), route = `/api/formalizations/${value.id}`;
    expect((await request(alice, '/api/runs', runBody(value))).status).toBe(409);
    expect((await request(alice, route + '/confirm', { evidenceSha256: 'a'.repeat(64) })).status).toBe(409);
    const confirmation = await request(alice, route + '/confirm', { evidenceSha256: value.report!.evidenceSha256 });
    expect(confirmation.status).toBe(200); expect((await confirmation.json()).formalization.status).toBe('confirmed');
    expect((await request(bob, '/api/runs', runBody(value))).status).toBe(404);
    expect((await request(alice, '/api/runs', { ...runBody(value), source: value.report!.statement + '\n' })).status).toBe(409);
    expect((await request(alice, '/api/runs', { ...runBody(value), environment: 'mathlib' })).status).toBe(409);
    const created = await request(alice, '/api/runs', runBody(value));
    expect(created.status).toBe(201);
    const run = (await created.json() as { run: WebRun }).run; await settle();
    expect(run.formalization).toMatchObject({ id: value.id, original: fixtureStatement, evidenceSha256: value.report!.evidenceSha256 });
    expect(runner.runs[0].formalization).toMatchObject({ request: { problemId: value.id, statement: fixtureStatement } });
    expect((await request(alice, route, undefined, 'DELETE')).status).toBe(409);
    const recordOwner = alice.cookie.slice('theoremos_session='.length);
    const evidencePath = ['owners', mathDigest(recordOwner), 'formalizations', value.id, 'evidence.json'];
    const evidence = service.storage.getRecord<any>(evidencePath); evidence.candidate.definitionsExplanation = 'Changed after confirmation';
    service.storage.saveRecord(evidencePath, evidence);
    expect((await request(alice, route)).status).toBe(409);
    expect((await request(alice, '/api/runs', runBody(value))).status).toBe(409);
    expect((await request(alice, `/api/runs/${run.id}/cancel`, {})).status).toBe(200); await settle();
    expect((await request(alice, `/api/runs/${run.id}`, undefined, 'DELETE')).status).toBe(200);
    expect((await request(alice, route, undefined, 'DELETE')).status).toBe(200);
  });

  it('requires a solve workflow for human review without accepting formalization work', async () => {
    const alice = await client();
    for (const solve of [undefined, false]) {
      expect((await request(alice, '/api/formalizations', { ...body, humanReview: true, ...(solve === undefined ? {} : { solve }) })).status).toBe(400);
    }
    const provider = config.providers.find(item => item.id === 'sub2api')!;
    expect(() => service.formalizations.create('owner', { ...body, environment: 'standard', effort: 'max', humanReview: true }, provider, 'deepseek-flash'))
      .toThrow('人工审核模式需要启用证明研究');
    await settle(); expect(runner.inputs).toHaveLength(0); expect(runner.runs).toHaveLength(0);
  });

  it.each([undefined, false])('automatically creates exactly one proof with verified evidence when humanReview is %s', async humanReview => {
    const alice = await client(), value = await create(alice, true, humanReview), pending = runner.pending.at(-1)!;
    expect(value.workflow).toBe('solve'); expect(runner.runs).toHaveLength(0);
    expect(value).toMatchObject({ maxRunSeconds: 0, maxTotalTokens: 0, maxRounds: 0, maxPlanningRounds: 0,
      research: { maxRunSeconds: 0, maxTotalTokens: 0, maxTurns: 0 } });
    expect(pending.input).toMatchObject({ maxRunSeconds: 0, maxTotalTokens: 0, maxRounds: 0, maxPlanningRounds: 0 });
    const evidence = webFormalizationEvidence(pending.input);
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    const route = `/api/formalizations/${value.id}`;
    const completed = (await (await request(alice, route)).json()).formalization as WebFormalization;
    expect(completed).toMatchObject({ status: 'confirmed', confirmation: 'automatic', workflow: 'solve' });
    expect(completed.runId).toMatch(/^[a-f0-9-]{36}$/u); expect(completed.researchError).toBeUndefined();
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0].input).toMatchObject({ ...webDefaults, effort: value.researchEffort ?? value.effort, environment: 'standard', apiKey: KEY,
      providerId: 'sub2api', model: 'deepseek-flash', source: evidence.candidate.source, formalizationId: value.id });
    expect(runner.runs[0].input).toMatchObject({ maxRunSeconds: 0, maxTotalTokens: 0, maxTurns: 0 });
    expect(runner.runs[0].formalization).toEqual(evidence);
    expect(runner.inputs[0].apiKey).toBe('');
    const run = (await (await request(alice, `/api/runs/${completed.runId}`)).json()).run;
    expect(run.formalization).toMatchObject({ original: fixtureStatement, confirmation: 'automatic' });
    for (let i = 0; i < 2; i++) {
      await request(alice, route); await request(alice, '/api/formalizations');
      const confirmed = await request(alice, route + '/confirm', { evidenceSha256: completed.report!.evidenceSha256 });
      expect((await confirmed.json()).formalization.confirmation).toBe('automatic');
    }
    expect(runner.runs).toHaveLength(1);
    const persisted = fs.readdirSync(config.dataRoot!, { recursive: true }).filter(file => String(file).endsWith('.json'))
      .map(file => fs.readFileSync(path.join(config.dataRoot!, String(file)), 'utf8')).join('\n');
    expect(persisted).not.toContain(KEY);
    await service.close(); service = createWebService(config, new Runner(), { sample: null });
    await new Promise<void>(resolve => service.server.listen(config.port, '127.0.0.1', resolve));
    expect((await (await request(alice, route)).json()).formalization.runId).toBe(completed.runId);
  });

  it('waits for current statement confirmation and an explicit start before gated two-agent research', async () => {
    expect(webLimits.maxWorkers).toBeGreaterThanOrEqual(2);
    const alice = await client(), research = { maxRunSeconds: 90, maxTurns: 2, maxTotalTokens: 30_000 };
    const response = await request(alice, '/api/formalizations', { ...body, solve: true, humanReview: true,
      providerId: 'openai', model: 'gpt-6.1-sol', maxRunSeconds: 120, maxTotalTokens: 50_000, research });
    expect(response.status).toBe(201); await settle();
    const value = (await response.json()).formalization as WebFormalization, route = `/api/formalizations/${value.id}`;
    const pending = runner.pending.at(-1)!, evidence = webFormalizationEvidence(pending.input);
    expect(value).toMatchObject({ workflow: 'solve', humanReview: true, maxRunSeconds: 120, maxTotalTokens: 50_000, research });
    expect(pending.input).toMatchObject({ provider: { id: 'openai' }, model: 'gpt-6.1-sol', maxRunSeconds: 120, maxTotalTokens: 50_000 });
    expect(pending.input).not.toHaveProperty('humanReview'); expect(pending.input).not.toHaveProperty('solve');
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    const review = (await (await request(alice, route)).json()).formalization as WebFormalization;
    expect(review).toMatchObject({ status: 'review', workflow: 'solve', humanReview: true });
    expect(review.confirmation).toBeUndefined(); expect(review.confirmedAt).toBeUndefined(); expect(review.runId).toBeUndefined();
    expect(runner.runs).toHaveLength(0); expect(runner.inputs[0].apiKey).toBe('');
    expect((await request(alice, route + '/research', { apiKey: KEY })).status).toBe(409);
    expect((await request(alice, route + '/confirm', { evidenceSha256: 'a'.repeat(64) })).status).toBe(409);
    expect((await request(alice, '/api/runs', runBody(review))).status).toBe(409);
    const confirmation = await request(alice, route + '/confirm', { evidenceSha256: review.report!.evidenceSha256 });
    expect(confirmation.status).toBe(200);
    const confirmed = (await confirmation.json()).formalization as WebFormalization;
    expect(confirmed).toMatchObject({ status: 'confirmed', confirmation: 'manual', humanReview: true });
    await settle(); expect(runner.runs).toHaveLength(0);
    const starts = await Promise.all([request(alice, route + '/research', { apiKey: KEY }), request(alice, route + '/research', { apiKey: KEY })]);
    expect(starts.map(start => start.status)).toEqual([200, 200]);
    const started = await Promise.all(starts.map(async start => (await start.json()).formalization as WebFormalization));
    expect(started[0].runId).toBeTruthy(); expect(started[1].runId).toBe(started[0].runId);
    expect((await (await request(alice, route + '/research', {})).json()).formalization.runId).toBe(started[0].runId);
    await settle(); expect(runner.runs).toHaveLength(1); expect(runner.inputs).toHaveLength(1);
    expect(runner.runs[0].input).toMatchObject({ ...research, providerId: 'openai', model: 'gpt-6.1-sol', effort: 'max', apiKey: KEY,
      workers: 2, coordination: 'cooperative', planApproval: true, environment: 'standard', source: evidence.candidate.source, formalizationId: value.id });
    expect(runner.runs[0].formalization).toEqual(evidence);
    const run = (await (await request(alice, `/api/runs/${started[0].runId}`)).json()).run as WebRun;
    expect(run.formalization).toMatchObject({ original: body.original, evidenceSha256: review.report!.evidenceSha256,
      confirmedAt: confirmed.confirmedAt, confirmation: 'manual' });
    const persisted = fs.readdirSync(config.dataRoot!, { recursive: true }).filter(file => String(file).endsWith('.json'))
      .map(file => fs.readFileSync(path.join(config.dataRoot!, String(file)), 'utf8')).join('\n');
    expect(persisted).not.toContain(KEY);
  });

  it('preserves human confirmation waits and gated research budgets through restart and retry', async () => {
    const alice = await client(), research = { maxRunSeconds: 90, maxTurns: 2, maxTotalTokens: 30_000 };
    const created = await request(alice, '/api/formalizations', { ...body, solve: true, humanReview: true,
      providerId: 'openai', model: 'gpt-6.1-sol', maxRunSeconds: 120, maxTotalTokens: 50_000, research });
    expect(created.status).toBe(201); await settle();
    const value = (await created.json()).formalization as WebFormalization, route = `/api/formalizations/${value.id}`;
    const pending = runner.pending.at(-1)!, evidence = webFormalizationEvidence(pending.input), digest = formalizationDigest(evidence);
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    const restart = async () => {
      await service.close(); runner = new Runner(); service = createWebService(config, runner, { sample: null });
      await new Promise<void>(resolve => service.server.listen(config.port, '127.0.0.1', resolve));
    };
    await restart();
    const review = (await (await request(alice, route)).json()).formalization as WebFormalization;
    expect(review).toMatchObject({ status: 'review', effort: 'max', humanReview: true, report: { evidenceSha256: digest } });
    expect((await request(alice, route + '/research', { apiKey: KEY })).status).toBe(409);
    expect((await request(alice, route + '/confirm', { evidenceSha256: digest })).status).toBe(200);
    expect(runner.runs).toHaveLength(0);
    await restart();
    const confirmed = (await (await request(alice, route)).json()).formalization as WebFormalization;
    expect(confirmed).toMatchObject({ status: 'confirmed', effort: 'max', confirmation: 'manual', humanReview: true, research });
    expect(confirmed.researchError).toBeUndefined(); expect(confirmed.runId).toBeUndefined(); expect(runner.runs).toHaveLength(0);
    config.queueLimit = 0;
    expect((await request(alice, route + '/research', { apiKey: KEY })).status).toBe(429);
    expect((await (await request(alice, route)).json()).formalization.researchError).toBe('formalization_research_queue_failed');
    await restart(); config.queueLimit = 8;
    expect((await (await request(alice, route)).json()).formalization).toMatchObject({ humanReview: true, researchError: 'formalization_research_queue_failed' });
    const retryKey = 'sk-synthetic-guided-research-retry';
    const resumed = await request(alice, route + '/research', { apiKey: retryKey });
    expect(resumed.status).toBe(200);
    const restored = (await resumed.json()).formalization as WebFormalization;
    expect(restored.runId).toBeTruthy(); expect(restored.researchError).toBeUndefined();
    expect(restored.report?.evidenceSha256).toBe(digest); expect(restored.confirmedAt).toBe(confirmed.confirmedAt);
    await settle(); expect(runner.inputs).toHaveLength(0); expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0].input).toMatchObject({ ...research, providerId: 'openai', model: 'gpt-6.1-sol', apiKey: retryKey,
      workers: 2, coordination: 'cooperative', planApproval: true, source: evidence.candidate.source, environment: 'standard' });
    expect(runner.runs[0].formalization).toEqual(evidence);
    await restart();
    expect((await (await request(alice, route + '/research', {})).json()).formalization.runId).toBe(restored.runId);
    await settle(); expect(runner.runs).toHaveLength(0); expect(runner.inputs).toHaveLength(0);
    const persisted = fs.readdirSync(config.dataRoot!, { recursive: true }).filter(file => String(file).endsWith('.json'))
      .map(file => fs.readFileSync(path.join(config.dataRoot!, String(file)), 'utf8')).join('\n');
    expect(persisted).not.toContain(KEY); expect(persisted).not.toContain(retryKey);
  });

  it('queues two accounts behind one formalization slot and hands each to its own proof in the separate proof queue', async () => {
    expect(webFormalizationLimits).toMatchObject({ concurrency: 1, queueLimit: 8, perOwner: 2 });
    expect(config.concurrency).toBe(1);
    const alice = await client(), bob = await client();
    const a = await create(alice, true), b = await create(bob, true);
    // One formalization runs at a time; the other waits.
    expect(runner.pending.map(item => item.input.id)).toEqual([a.id]);
    expect((await (await request(bob, `/api/formalizations/${b.id}`)).json()).formalization.queue)
      .toEqual({ position: 1, ahead: 0, running: 1, slots: 1 });
    const approveNext = async (id: string) => {
      const pending = runner.pending.find(item => item.input.id === id)!;
      pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) }); pending.resolve(); await settle();
    };
    await approveNext(a.id);
    // A's proof holds the single proof slot while B's formalization runs in its own slot.
    expect(runner.pending.map(item => item.input.id)).toEqual([a.id, b.id]);
    expect(runner.runs.map(run => run.input.formalizationId)).toEqual([a.id]);
    await approveNext(b.id);
    const done = async (who: Client, id: string) => (await (await request(who, `/api/formalizations/${id}`)).json()).formalization as WebFormalization;
    const [doneA, doneB] = [await done(alice, a.id), await done(bob, b.id)];
    expect(doneA.runId).toBeTruthy(); expect(doneB.runId).toBeTruthy(); expect(doneA.runId).not.toBe(doneB.runId);
    // B's proof waits behind A's; each run names its own formalization and belongs only to its account.
    expect(runner.runs.map(run => run.input.formalizationId)).toEqual([a.id]);
    const runA = (await (await request(alice, `/api/runs/${doneA.runId}`)).json()).run as WebRun;
    const runB = (await (await request(bob, `/api/runs/${doneB.runId}`)).json()).run as WebRun;
    expect(runA.status).toBe('running'); expect(runB.status).toBe('queued');
    expect(runA.formalizationId).toBe(a.id); expect(runB.formalizationId).toBe(b.id);
    expect((await request(alice, `/api/runs/${doneB.runId}`)).status).toBe(404);
    expect((await request(bob, `/api/runs/${doneA.runId}`)).status).toBe(404);
    expect((await request(alice, `/api/runs/${doneA.runId}/cancel`, {})).status).toBe(200); await settle();
    expect(runner.runs.map(run => run.input.formalizationId)).toEqual([a.id, b.id]);
  });

  it('queues the same account, cancels queued work independently, and releases the next task after failure', async () => {
    const alice = await client(), a = await create(alice, true), b = await create(alice, true);
    expect(runner.pending.map(item => item.input.id)).toEqual([a.id]);
    const read = async (id: string) => (await (await request(alice, `/api/formalizations/${id}`)).json()).formalization as WebFormalization;
    expect((await read(b.id)).queue).toEqual({ position: 1, ahead: 0, running: 1, slots: 1 });
    expect((await request(alice, '/api/formalizations', body)).status).toBe(429);
    expect((await request(alice, `/api/formalizations/${b.id}/cancel`, {})).status).toBe(200);
    expect(runner.pending[0].signal.aborted).toBe(false);
    expect((await read(b.id)).queue).toBeUndefined();
    const c = await create(alice, true);
    runner.pending[0].send({ type: 'result', status: 'error', reason: 'formalization_failed' });
    runner.pending[0].resolve(); await settle();
    expect((await read(a.id)).status).toBe('error');
    expect((await read(c.id)).queue).toBeUndefined();
    expect(runner.pending.map(item => item.input.id)).toEqual([a.id, c.id]);
    const pending = runner.pending[1];
    pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) });
    pending.resolve(); await settle();
    expect(runner.runs.map(run => run.input.formalizationId)).toEqual([c.id]);
    expect((await read(c.id)).runId).toBe(runner.runs[0].id);
  });

  it('preserves same-account formalization and proof identities across both independent queues', async () => {
    const alice = await client(), a = await create(alice, true), b = await create(alice, true);
    for (const id of [a.id, b.id]) {
      const pending = runner.pending.find(item => item.input.id === id)!;
      pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) });
      pending.resolve(); await settle();
    }
    const records = await (await request(alice, '/api/formalizations')).json();
    const doneA = records.formalizations.find((item: WebFormalization) => item.id === a.id);
    const doneB = records.formalizations.find((item: WebFormalization) => item.id === b.id);
    expect(doneA.runId).not.toBe(doneB.runId);
    expect(runner.runs.map(run => run.input.formalizationId)).toEqual([a.id]);
    const queued = (await (await request(alice, `/api/runs/${doneB.runId}`)).json()).run;
    expect(queued.status).toBe('queued'); expect(queued.formalizationId).toBe(b.id);
    await request(alice, `/api/runs/${doneA.runId}/cancel`, {}); await settle();
    expect(runner.runs.map(run => run.input.formalizationId)).toEqual([a.id, b.id]);
  });

  it.each([false, true])('retries a queue-rejected proof with its frozen protocol, once, without regenerating (legacy=%s)', async legacy => {
    const alice = await client(), value = await create(alice, true), pending = runner.pending.at(-1)!;
    config.queueLimit = 0;
    pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) }); pending.resolve(); await settle();
    const route = `/api/formalizations/${value.id}`;
    let completed = (await (await request(alice, route)).json()).formalization as WebFormalization;
    if (legacy) {
      const recordPath = ['owners', mathDigest(alice.cookie.slice('theoremos_session='.length)), 'formalizations', value.id];
      const stored = service.storage.getRecord<any>([...recordPath, 'record.json']);
      const evidence = webFormalizationEvidence({ ...pending.input, contextProtocol: 'kernel-v2' });
      delete stored.formalization.contextProtocol;
      stored.evidenceSha256 = formalizationDigest(evidence);
      service.storage.saveRecord([...recordPath, 'evidence.json'], evidence);
      service.storage.saveRecord([...recordPath, 'record.json'], stored);
      completed = (await (await request(alice, route)).json()).formalization as WebFormalization;
    }
    expect(completed).toMatchObject({ status: 'confirmed', confirmation: 'automatic', researchError: 'formalization_research_queue_failed' });
    expect(completed.runId).toBeUndefined(); expect(runner.inputs[0].apiKey).toBe('');
    expect((await request(alice, route + '/research', { apiKey: KEY })).status).toBe(429);
    config.queueLimit = 8;
    await request(alice, route + '/confirm', { evidenceSha256: completed.report!.evidenceSha256 });
    await request(alice, route); await request(alice, '/api/formalizations'); await settle();
    expect(runner.runs).toHaveLength(0);
    const bob = await client();
    expect((await request(bob, route + '/research', { apiKey: KEY })).status).toBe(404);
    const resumed = await request(alice, route + '/research', { apiKey: KEY });
    expect(resumed.status).toBe(200);
    const restored = (await resumed.json()).formalization as WebFormalization;
    expect(restored.runId).toBeTruthy(); expect(restored.researchError).toBeUndefined();
    expect(restored.report?.evidenceSha256).toBe(completed.report?.evidenceSha256);
    expect((await (await request(alice, route + '/research', {})).json()).formalization.runId).toBe(restored.runId);
    await settle(); expect(runner.inputs).toHaveLength(1); expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0].input).toMatchObject(webFormalizationDefaults.research);
    expect(runner.runs[0].formalization?.request.contextProtocol).toBe(legacy ? 'kernel-v2' : LEAN_STATEMENT_CONTEXT_PROTOCOL);
    expect(restored.contextProtocol).toBe(legacy ? undefined : LEAN_STATEMENT_CONTEXT_PROTOCOL);
  });

  it('never starts proof research for cancelled, failed, exhausted or unverified automatic formalizations', async () => {
    const alice = await client();
    for (const outcome of ['cancelled', 'error', 'exhausted', 'invalid'] as const) {
      const value = await create(alice, true), pending = runner.pending.at(-1)!;
      if (outcome === 'cancelled') await request(alice, `/api/formalizations/${value.id}/cancel`, {});
      pending.send(outcome === 'error' || outcome === 'exhausted' ? { type: 'result', status: outcome, reason: 'formalization_failed' }
        : { type: 'result', status: 'approved', evidence: outcome === 'invalid' ? {} : webFormalizationEvidence(pending.input) });
      pending.resolve(); await settle();
      expect(runner.runs).toHaveLength(0); expect(runner.inputs.at(-1)!.apiKey).toBe('');
      expect((await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization.runId).toBeUndefined();
    }
  });

  it('rejects valid evidence bound to another task and unverified worker claims', async () => {
    const alice = await client();
    const one = await create(alice), pending = runner.pending.at(-1)!;
    const foreign = webFormalizationEvidence({ ...pending.input, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
    expect(() => assertFormalizationEvidence(foreign)).not.toThrow();
    pending.send({ type: 'result', status: 'approved', evidence: foreign }); pending.resolve(); await settle();
    expect((await (await request(alice, `/api/formalizations/${one.id}`)).json()).formalization)
      .toMatchObject({ status: 'error', reason: 'formalization_binding_mismatch' });
    const two = await create(alice), next = runner.pending.at(-1)!;
    next.send({ type: 'result', status: 'approved', evidence: { status: 'approved' } }); next.resolve(); await settle();
    expect((await (await request(alice, `/api/formalizations/${two.id}`)).json()).formalization.status).toBe('error');
  });

  it('preserves the coverage reason when evidence validation rejects an original-text mismatch', async () => {
    const alice = await client(), value = await create(alice), pending = runner.pending.at(-1)!;
    const evidence = webFormalizationEvidence(pending.input), privateExcerpt = 'Private unmatched coverage excerpt.';
    evidence.candidate.coverage[0]!.originalText = privateExcerpt;
    evidence.inputDigest = formalizationInputDigest(evidence.request, evidence.candidate);
    expect(() => verifyWebFormalizationEvidence(evidence, value)).toThrow('formalization_coverage_invalid');
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    const response = await request(alice, `/api/formalizations/${value.id}`), result = await response.json();
    expect(response.status).toBe(200);
    expect(result.formalization).toMatchObject({ status: 'error', reason: 'formalization_coverage_invalid' });
    expect(JSON.stringify(result)).not.toContain(privateExcerpt);
    expect(result.formalization.report).toBeUndefined();
    expect(runner.runs).toHaveLength(0);
  });

  it.each([
    ['formalization_coverage_invalid', 'formalization_coverage_invalid'],
    ['formalization_coverage_invalid_extra', 'formalization_failed'],
    ['formalization_binding_mismatch', 'formalization_failed'],
  ])('keeps diagnostic payloads private when a runner throws %s', async (code, reason) => {
    const detail = JSON.stringify({ originalText: 'Private diagnostic excerpt.', token: KEY });
    runner.formalize = async () => { throw new Error(`${code}: ${detail}`); };
    const alice = await client(), value = await create(alice);
    const response = await request(alice, `/api/formalizations/${value.id}`), result = await response.json();
    expect(response.status).toBe(200);
    expect(result.formalization).toMatchObject({ status: 'error', reason });
    for (const hidden of [detail, 'Private diagnostic excerpt.', KEY]) expect(JSON.stringify(result)).not.toContain(hidden);
    expect(runner.runs).toHaveLength(0);
  });

  it('binds new evidence to the chosen token budget while accepting persisted legacy budgets', async () => {
    const alice = await client(), current = await create(alice), pending = runner.pending.at(-1)!;
    expect(pending.input.maxTotalTokens).toBe(webFormalizationDefaults.maxTotalTokens);
    pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) });
    pending.resolve(); await settle();
    expect((await (await request(alice, `/api/formalizations/${current.id}`)).json()).formalization.status).toBe('review');
    const other = await create(alice), next = runner.pending.at(-1)!;
    next.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence({ ...next.input, maxTotalTokens: 150_000 }) });
    next.resolve(); await settle();
    expect((await (await request(alice, `/api/formalizations/${other.id}`)).json()).formalization)
      .toMatchObject({ status: 'error', reason: 'formalization_binding_mismatch' });
    const { maxRunSeconds: _seconds, maxTotalTokens: _tokens, maxRounds: _rounds, maxPlanningRounds: _planning,
      contextProtocol: _protocol, reviewMode: _reviewMode, ...legacy } = current;
    for (const maxTotalTokens of [0, 200_000]) {
      const evidence = webReviewedFormalizationEvidence({ ...pending.input, reviewMode: undefined, maxRunSeconds: 1800, maxTotalTokens, maxRounds: 3,
        maxPlanningRounds: 2, contextProtocol: 'kernel-v2' });
      expect(() => verifyWebFormalizationEvidence(evidence, legacy)).not.toThrow();
      expect(() => verifyWebFormalizationEvidence(evidence, current)).toThrow('formalization_binding_mismatch');
    }
    for (const override of [{ maxRounds: 1 }, { maxRunSeconds: 30 }])
      expect(() => verifyWebFormalizationEvidence(webFormalizationEvidence({ ...pending.input, ...override }), current))
        .toThrow('formalization_binding_mismatch');
    expect(() => verifyWebFormalizationEvidence(webReviewedFormalizationEvidence({ ...pending.input,
      reviewMode: undefined, contextProtocol: 'kernel-v2', maxRunSeconds: 1800, maxTotalTokens: 0,
      maxRounds: 3, maxPlanningRounds: 1 }), legacy)).toThrow('formalization_binding_mismatch');
  });

  it.each([
    {},
    { maxRunSeconds: 0, maxTotalTokens: 0, research: { maxRunSeconds: 0, maxTurns: 0, maxTotalTokens: 0 } },
    { research: { maxTotalTokens: 0 } },
  ])('defaults omitted and partial formalization/research budgets to unlimited: %j', async budgets => {
    const alice = await client();
    const response = await request(alice, '/api/formalizations', { ...body, solve: true, requestId: 'unlimited', ...budgets });
    expect(response.status).toBe(201); await settle();
    const value = (await response.json()).formalization as WebFormalization, pending = runner.pending.at(-1)!;
    const unlimited = { maxRunSeconds: 0, maxTurns: 0, maxTotalTokens: 0 };
    expect(value).toMatchObject({ maxRunSeconds: 0, maxTotalTokens: 0, maxRounds: 0, maxPlanningRounds: 0, research: unlimited });
    expect(pending.input).toMatchObject({ maxRunSeconds: 0, maxTotalTokens: 0, maxRounds: 0, maxPlanningRounds: 0 });
    const replay = await request(alice, '/api/formalizations', { ...body, solve: true, requestId: 'unlimited',
      maxRunSeconds: 0, maxTotalTokens: 0, research: unlimited });
    expect(replay.status).toBe(200); expect((await replay.json()).formalization.id).toBe(value.id);
    pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) }); pending.resolve(); await settle();
    const completed = (await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization;
    expect(completed.status).toBe('confirmed'); expect(completed.runId).toBeTruthy();
    expect(runner.runs[0].input).toMatchObject(unlimited);
  });

  it('freezes the shared context protocol for new records and reads legacy kernel-v2 evidence exactly', async () => {
    const alice = await client(), current = await create(alice), pending = runner.pending.at(-1)!;
    expect(current.contextProtocol).toBe(LEAN_STATEMENT_CONTEXT_PROTOCOL);
    expect(pending.input.contextProtocol).toBe(LEAN_STATEMENT_CONTEXT_PROTOCOL);
    const currentEvidence = webFormalizationEvidence(pending.input);
    expect(() => verifyWebFormalizationEvidence(currentEvidence, current)).not.toThrow();
    const legacyEvidence = webReviewedFormalizationEvidence({ ...pending.input, reviewMode: undefined, contextProtocol: 'kernel-v2' });
    const { contextProtocol: _protocol, reviewMode: _reviewMode, ...legacy } = current;
    expect(() => verifyWebFormalizationEvidence(legacyEvidence, legacy)).not.toThrow();
    expect(() => verifyWebFormalizationEvidence(legacyEvidence, { ...legacy, contextProtocol: 'kernel-v2' })).not.toThrow();
    const mismatched = { ...current, contextProtocol: 'kernel-v1' as const };
    expect(() => verifyWebFormalizationEvidence(currentEvidence, mismatched)).toThrow('formalization_binding_mismatch');
    if (current.contextProtocol !== 'kernel-v2') {
      expect(() => verifyWebFormalizationEvidence(legacyEvidence, current)).toThrow('formalization_binding_mismatch');
      expect(() => verifyWebFormalizationEvidence(currentEvidence, legacy)).toThrow('formalization_binding_mismatch');
    }
    pending.send({ type: 'result', status: 'approved', evidence: currentEvidence }); pending.resolve(); await settle();
    const recordPath = ['owners', mathDigest(alice.cookie.slice('theoremos_session='.length)), 'formalizations', current.id];
    const stored = service.storage.getRecord<any>([...recordPath, 'record.json']);
    stored.formalization = { ...legacy, status: 'review' };
    stored.evidenceSha256 = formalizationDigest(legacyEvidence);
    service.storage.saveRecord([...recordPath, 'evidence.json'], legacyEvidence);
    service.storage.saveRecord([...recordPath, 'record.json'], stored);
    const response = await request(alice, `/api/formalizations/${current.id}`);
    expect(response.status).toBe(200);
    expect((await response.json()).formalization.status).toBe('review');
  });

  it('preserves provider, model and the two submitted budgets through the proof handoff', async () => {
    const alice = await client();
    const generation = (await (await request(alice, '/api/formalizations')).json()).generation;
    expect(generation.defaults).toEqual(webFormalizationDefaults);
    expect(generation.providers).toContainEqual(expect.objectContaining({ id: 'openai', keyUrl: 'https://platform.openai.com/api-keys' }));
    const research = { maxRunSeconds: 90, maxTurns: 2, maxTotalTokens: 30_000 };
    const response = await request(alice, '/api/formalizations', { ...body, solve: true, providerId: 'openai', model: 'gpt-6.1-sol',
      maxRunSeconds: 120, maxTotalTokens: 50_000, research });
    expect(response.status).toBe(201); await settle();
    const value = (await response.json()).formalization as WebFormalization, pending = runner.pending.at(-1)!;
    expect(pending.input).toMatchObject({ model: 'gpt-6.1-sol', provider: { id: 'openai' }, maxRunSeconds: 120, maxTotalTokens: 50_000 });
    pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) }); pending.resolve(); await settle();
    const completed = (await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization;
    expect(completed.runId).toBeTruthy();
    expect(runner.runs[0].input).toMatchObject({ providerId: 'openai', model: 'gpt-6.1-sol', ...research });
    expect((await request(alice, '/api/formalizations', { ...body, maxTotalTokens: 0 })).status).toBe(201);
    expect((await request(alice, '/api/formalizations', { ...body, maxTotalTokens: 9_999 })).status).toBe(400);
    expect((await request(alice, '/api/formalizations', { ...body, providerId: 'sub2api', model: 'other' })).status).toBe(400);
  });

  it('drains accepted formalizations into proofs during maintenance while rejecting new work and keeping reads', async () => {
    const alice = await client(), value = await create(alice, true), pending = runner.pending.at(-1)!;
    service.storage.saveRecord(['operations', 'maintenance.json'], { enabled: true, updatedAt: new Date().toISOString() });
    const ready = await fetch(base + '/readyz');
    expect(ready.status).toBe(503); expect(await ready.json()).toMatchObject({ ready: false, maintenance: true });
    expect((await (await request(alice, '/api/session')).json()).maintenance).toBe(true);
    expect((await request(alice, '/api/formalizations', body)).status).toBe(503);
    pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) }); pending.resolve(); await settle();
    const completed = (await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization;
    expect(completed.runId).toBeTruthy(); expect(runner.runs).toHaveLength(1);
    expect((await request(alice, `/api/runs/${completed.runId}/cancel`, {})).status).toBe(200);
    service.storage.saveRecord(['operations', 'maintenance.json'], { enabled: false, updatedAt: new Date().toISOString() });
    expect((await fetch(base + '/readyz')).status).toBe(200);
  });

  it('keeps the independent fidelity policy mandatory on legacy reviewed records', async () => {
    const alice = await client(), value = await create(alice), pending = runner.pending.at(-1)!;
    const evidence = webReviewedFormalizationEvidence({ ...pending.input, reviewMode: undefined });
    delete evidence.request.fidelityPolicy;
    evidence.requestDigest = formalizationDigest(evidence.request);
    evidence.inputDigest = formalizationInputDigest(evidence.request, evidence.candidate);
    evidence.workflow!.reviews.forEach((record, index) => {
      const input = formalizationReviewInput(evidence.request, evidence.candidate, evidence.snapshot, evidence.translation,
        { reviewerId: record.reviewerId, planDigest: evidence.workflow!.plan.digest });
      record.review = semanticReviewFixture(input); delete record.correspondence;
      evidence.sessions[index + 3].inputDigest = formalizationDigest(input);
      evidence.sessions[index + 3].outputDigest = formalizationDigest(record.review);
    });
    evidence.review = evidence.workflow!.reviews[0].review;
    expect(() => assertFormalizationEvidence(evidence)).not.toThrow();
    expect(() => verifyWebFormalizationEvidence(evidence, { ...value, reviewMode: undefined }))
      .toThrow('formalization_binding_mismatch');
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    expect((await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization)
      .toMatchObject({ status: 'error', reason: 'formalization_binding_mismatch' });
  });

  it('defaults new formalizations to direct compilation and hands the original to proof without semantic review claims', async () => {
    const alice = await client(), value = await create(alice, true), pending = runner.pending.at(-1)!;
    expect(value).toMatchObject({ reviewMode: 'direct', maxRunSeconds: 0, maxTotalTokens: 0, maxRounds: 0 });
    expect(pending.input).toMatchObject({ reviewMode: 'direct', maxRunSeconds: 0, maxTotalTokens: 0 });
    const evidence = webDirectFormalizationEvidence(pending.input);
    expect(() => verifyWebFormalizationEvidence(evidence, value)).not.toThrow();
    for (const field of ['translation', 'review', 'workflow']) expect(evidence).not.toHaveProperty(field);
    expect(evidence.sessions.map(session => session.role)).toEqual(['generate']);
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    const completed = (await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization;
    expect(completed).toMatchObject({ status: 'confirmed', confirmation: 'automatic', reviewMode: 'direct',
      report: { semanticReview: 'not-performed', backtranslation: null, reviews: [], correspondences: [] } });
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0].formalization).toMatchObject({ schema: 'theorem-os.formalization-evidence.v4',
      semanticReview: 'not-performed', request: { statement: fixtureStatement, reviewMode: 'direct' } });
    const run = (await (await request(alice, `/api/runs/${completed.runId}`)).json()).run;
    expect(run.formalization).toMatchObject({ reviewMode: 'direct', original: fixtureStatement, confirmation: 'automatic' });
  });

  it('binds the frozen review mode and refuses reviewed/direct evidence substitution', async () => {
    const alice = await client(), value = await create(alice), pending = runner.pending.at(-1)!;
    const direct = webDirectFormalizationEvidence(pending.input), reviewed = webReviewedFormalizationEvidence(pending.input);
    expect(() => verifyWebFormalizationEvidence(reviewed, value)).toThrow('formalization_binding_mismatch');
    expect(() => verifyWebFormalizationEvidence(direct, { ...value, reviewMode: undefined })).toThrow('formalization_binding_mismatch');
    const invalid = { ...direct, review: reviewed.review };
    pending.send({ type: 'result', status: 'approved', evidence: invalid }); pending.resolve(); await settle();
    expect((await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization.status).toBe('error');
    expect(runner.runs).toHaveLength(0);
  });

  it('rejects a Lean candidate that cannot fit the research source limit', async () => {
    const alice = await client(), value = await create(alice), pending = runner.pending.at(-1)!;
    const evidence = webFormalizationEvidence(pending.input);
    // Exceed the UTF-8 byte limit while staying within the evidence schema's character limit.
    evidence.candidate.source += '--' + 'λ'.repeat(Math.ceil(webLimits.maxSourceBytes / 2));
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    expect((await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization)
      .toMatchObject({ status: 'error', reason: 'formalization_source_too_large' });
  });

  it('reports unavailable runtimes and preserves completed evidence across restart', async () => {
    const alice = await client(); runner.ready = false;
    expect((await (await request(alice, '/api/formalizations')).json()).generation).toMatchObject({ available: false, reason: 'runtime' });
    expect((await request(alice, '/api/formalizations', body)).status).toBe(503); runner.ready = true;
    const completed = await approve(alice), active = await create(alice);
    await service.close();
    service = createWebService(config, new Runner(), { sample: null });
    await new Promise<void>(resolve => service.server.listen(config.port, '127.0.0.1', resolve));
    expect((await (await request(alice, `/api/formalizations/${active.id}`)).json()).formalization)
      .toMatchObject({ status: 'error', reason: 'formalization_interrupted' });
    expect((await (await request(alice, `/api/formalizations/${completed.id}`)).json()).formalization.report.evidenceSha256)
      .toBe(completed.report!.evidenceSha256);
    expect((await request(alice, `/api/formalizations/${completed.id}/confirm`, { evidenceSha256: completed.report!.evidenceSha256 })).status).toBe(200);
  });

  it('uses account-saved then server keys, lets typed keys win, and cancels before account deletion', async () => {
    await service.close();
    const email = 'alice@example.org', savedKey = 'sk-synthetic-saved-key', serverKey = 'sk-synthetic-server-key';
    config = { ...readWebConfig({ THEOREMOS_WEB_PORT: String(config.port), THEOREMOS_WEB_PUBLIC_URL: base,
      THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_ALLOWLIST: email, THEOREMOS_WEB_ADMINS: email,
      THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_KEY_SECRET: 'ab'.repeat(32),
      THEOREMOS_WEB_ADMIN_KEYS: JSON.stringify({ sub2api: serverKey }), THEOREMOS_WEB_DATA_ROOT: config.dataRoot }), staticRoot: root };
    const mail: string[] = [];
    service = createWebService(config, runner, { sample: null, mailer: async message => { mail.push(message.text); }, captchaAnswer: () => '12345' });
    await new Promise<void>(resolve => service.server.listen(config.port, '127.0.0.1', resolve));
    const anonymous = await client();
    expect((await request(anonymous, '/api/formalizations')).status).toBe(401);
    const captcha = await (await request(anonymous, '/api/auth/captcha', {})).json();
    expect((await request(anonymous, '/api/auth/code', { email, captchaId: captcha.id, captcha: '12345' })).status).toBe(200);
    const verified = await request(anonymous, '/api/auth/verify', { email, code: mail.at(-1)!.match(/\b\d{6}\b/u)![0] });
    const alice = { cookie: verified.headers.get('set-cookie')!.split(';')[0], csrf: (await verified.json()).csrfToken };
    const account = service.auth!.getAccount(email)!;
    const vault = new WebKeyVault(config.keySecret!, service.storage), provider = config.providers.find(item => item.id === 'sub2api')!;
    expect((await (await request(alice, '/api/formalizations')).json()).generation.key).toBe('server');
    const start = async (apiKey: string, expected: string) => {
      const response = await request(alice, '/api/formalizations', { ...body, apiKey, solve: true });
      expect(response.status).toBe(201); await settle();
      const value = (await response.json()).formalization;
      expect(runner.pending.at(-1)!.input.apiKey).toBe(expected);
      return value.id as string;
    };
    const first = await start('', serverKey);
    await request(alice, `/api/formalizations/${first}/cancel`, {}); await settle();
    vault.save(account.id, provider.id, provider.baseUrl, savedKey);
    expect((await (await request(alice, '/api/formalizations')).json()).generation.key).toBe('saved');
    const second = await start('', savedKey);
    await request(alice, `/api/formalizations/${second}/cancel`, {}); await settle();
    await start(KEY, KEY);
    const pending = runner.pending.at(-1)!;
    expect((await request(alice, '/api/auth/account', { email }, 'DELETE')).status).toBe(200);
    expect(pending.signal.aborted).toBe(true);
    pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) }); await settle();
    expect(service.formalizations.list(`account:${account.id}`)).toEqual([]);
    expect(vault.list(account.id, config.providers)).toEqual([]);
  });

  it('cancels and removes anonymous jobs when their session expires', async () => {
    const alice = await client(), value = await create(alice, true), pending = runner.pending.at(-1)!;
    config.sessionTtlMs = -1;
    expect((await request(alice, `/api/formalizations/${value.id}`)).status).toBe(401);
    expect(pending.signal.aborted).toBe(true);
    pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) }); await settle();
    expect(runner.runs).toHaveLength(0);
    expect(service.formalizations.list(alice.cookie.slice('theoremos_session='.length))).toEqual([]);
  });

  it('interrupts orphaned queued records on startup and forget prevents late writes', async () => {
    const storage = new WebStorage(), isolated = new Runner(), provider = config.providers.find(item => item.id === 'sub2api')!;
    const jobs = new WebFormalizations(isolated, storage, { ...webFormalizationLimits, concurrency: 0 });
    const value = jobs.create('owner', body as any, provider, 'deepseek-flash');
    // Entries stored after the last saved count are counted again when the record is interrupted.
    for (const sequence of [1, 2]) storage.saveRecord(['owners', mathDigest('owner'), 'formalizations', value.id, 'activity', `${sequence}.json`],
      { type: 'step', step: { round: 1, step: 'approved' }, sequence, at: new Date().toISOString() }, true);
    const recovered = new WebFormalizations(isolated, storage);
    expect(recovered.read('owner', value.id)).toMatchObject({ status: 'error', reason: 'formalization_interrupted', activity: { count: 2 } });
    expect(recovered.activity('owner', value.id, 1).activity.map(entry => entry.sequence)).toEqual([2]);
    await jobs.close(); await recovered.close();
    const active = new WebFormalizations(isolated, storage);
    const running = active.create('delete-owner', body as any, provider, 'deepseek-flash'); await settle();
    active.forget('delete-owner'); storage.deleteOwner('delete-owner');
    isolated.pending.at(-1)!.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(isolated.pending.at(-1)!.input) });
    await settle(); expect(active.list('delete-owner')).toEqual([]);
    expect(() => active.read('delete-owner', running.id)).toThrow('不存在'); await active.close();
  });
});
