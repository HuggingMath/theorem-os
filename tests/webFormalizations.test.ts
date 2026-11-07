import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig, webDefaults, webLimits, type WebConfig } from '../apps/web/config';
import { WebFormalizations } from '../apps/web/formalizations';
import { webFormalizationLimits, type WebFormalization, type WorkerFormalizationInput, type WorkerFormalizationMessage } from '../apps/web/formalizationTypes';
import type { WebRunner } from '../apps/web/runner';
import { WebKeyVault } from '../apps/web/keyVault';
import { WebStorage } from '../apps/web/storage';
import type { WebRun, WebSession, WorkerInput, WorkerMessage } from '../apps/web/shared';
import { assertFormalizationEvidence, formalizationDigest, formalizationInputDigest, formalizationReviewInput } from '../src/math/formalization';
import { mathDigest } from '../src/math/mathRuntimeIo';

import { semanticReviewFixture } from './helpers/formalizationFixture';
import { webFormalizationStatement as fixtureStatement, webFormalizationEvidence } from './helpers/webFormalizationFixture';

const KEY = 'sk-synthetic-formalization-test';
const body = { original: fixtureStatement, environment: 'standard', effort: 'max', apiKey: KEY };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
type Pending = { input: WorkerFormalizationInput; signal: AbortSignal; send(message: WorkerFormalizationMessage): void; resolve(): void };
class Runner implements WebRunner {
  pending: Pending[] = [];
  inputs: WorkerFormalizationInput[] = [];
  runs: WorkerInput[] = [];
  ready = true;
  async readiness() { return { ready: this.ready, message: 'Disposable test runner' }; }
  run(input: WorkerInput, _send: (message: WorkerMessage) => void, signal: AbortSignal) {
    this.runs.push(input);
    return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
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
    const response = await fetch(base + '/api/session'), value = await response.json() as WebSession;
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: value.csrfToken };
  }
  function request(client: Client, route: string, value?: unknown, method = value === undefined ? 'GET' : 'POST') {
    return fetch(base + route, { method, headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrf,
      ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: value === undefined ? undefined : JSON.stringify(value) });
  }
  async function create(client: Client, solve = false) {
    const response = await request(client, '/api/formalizations', { ...body, ...(solve ? { solve: true } : {}) });
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
    const evidence = service.storage.getRecord<any>(evidencePath); evidence.translation.mathematics = 'Changed after confirmation';
    service.storage.saveRecord(evidencePath, evidence);
    expect((await request(alice, route)).status).toBe(409);
    expect((await request(alice, '/api/runs', runBody(value))).status).toBe(409);
    expect((await request(alice, `/api/runs/${run.id}/cancel`, {})).status).toBe(200); await settle();
    expect((await request(alice, `/api/runs/${run.id}`, undefined, 'DELETE')).status).toBe(200);
    expect((await request(alice, route, undefined, 'DELETE')).status).toBe(200);
  });

  it('automatically creates exactly one proof with verified original evidence and the same in-memory key', async () => {
    const alice = await client(), value = await create(alice, true), pending = runner.pending.at(-1)!;
    expect(value.workflow).toBe('solve'); expect(runner.runs).toHaveLength(0);
    const evidence = webFormalizationEvidence(pending.input);
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    const route = `/api/formalizations/${value.id}`;
    const completed = (await (await request(alice, route)).json()).formalization as WebFormalization;
    expect(completed).toMatchObject({ status: 'confirmed', confirmation: 'automatic', workflow: 'solve' });
    expect(completed.runId).toMatch(/^[a-f0-9-]{36}$/u); expect(completed.researchError).toBeUndefined();
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0].input).toMatchObject({ ...webDefaults, environment: 'standard', apiKey: KEY,
      providerId: 'sub2api', model: 'deepseek-flash', source: evidence.candidate.source, formalizationId: value.id });
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

  it('queues two accounts behind one formalization slot and hands each to its own proof in the separate proof queue', async () => {
    expect(webFormalizationLimits).toMatchObject({ concurrency: 1, queueLimit: 8, perOwner: 1 });
    expect(config.concurrency).toBe(1);
    const alice = await client(), bob = await client();
    const a = await create(alice, true), b = await create(bob, true);
    // One formalization runs at a time; the other waits, and an account cannot start a second one.
    expect(runner.pending.map(item => item.input.id)).toEqual([a.id]);
    expect((await (await request(bob, `/api/formalizations/${b.id}`)).json()).formalization.status).toBe('queued');
    expect((await request(alice, '/api/formalizations', body)).status).toBe(429);
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

  it('reports automatic proof queue rejection without retrying or leaking credentials', async () => {
    const alice = await client(), value = await create(alice, true), pending = runner.pending.at(-1)!;
    config.queueLimit = 0;
    pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) }); pending.resolve(); await settle();
    const route = `/api/formalizations/${value.id}`;
    const completed = (await (await request(alice, route)).json()).formalization as WebFormalization;
    expect(completed).toMatchObject({ status: 'confirmed', confirmation: 'automatic', researchError: 'formalization_research_queue_failed' });
    expect(completed.runId).toBeUndefined(); expect(runner.inputs[0].apiKey).toBe('');
    config.queueLimit = 8;
    await request(alice, route + '/confirm', { evidenceSha256: completed.report!.evidenceSha256 });
    await request(alice, route); await request(alice, '/api/formalizations'); await settle();
    expect(runner.runs).toHaveLength(0);
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

  it('sets no token budget and still accepts evidence generated under the earlier 200,000-token budget', async () => {
    const alice = await client(), current = await create(alice), pending = runner.pending.at(-1)!;
    expect(pending.input.maxTotalTokens).toBe(0);
    pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence({ ...pending.input, maxTotalTokens: 200_000 }) });
    pending.resolve(); await settle();
    expect((await (await request(alice, `/api/formalizations/${current.id}`)).json()).formalization.status).toBe('review');
    const other = await create(alice), next = runner.pending.at(-1)!;
    next.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence({ ...next.input, maxTotalTokens: 150_000 }) });
    next.resolve(); await settle();
    expect((await (await request(alice, `/api/formalizations/${other.id}`)).json()).formalization)
      .toMatchObject({ status: 'error', reason: 'formalization_binding_mismatch' });
  });

  it('rejects otherwise valid evidence that omits the production fidelity review policy', async () => {
    const alice = await client(), value = await create(alice), pending = runner.pending.at(-1)!;
    const evidence = webFormalizationEvidence(pending.input);
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
    pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve(); await settle();
    expect((await (await request(alice, `/api/formalizations/${value.id}`)).json()).formalization)
      .toMatchObject({ status: 'error', reason: 'formalization_binding_mismatch' });
  });

  it('rejects a Lean candidate that cannot fit the research source limit', async () => {
    const alice = await client(), value = await create(alice), pending = runner.pending.at(-1)!;
    const evidence = webFormalizationEvidence(pending.input);
    evidence.candidate.source += '--' + 'a'.repeat(webLimits.maxSourceBytes);
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
