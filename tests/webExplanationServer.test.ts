import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig, type WebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import { webSampleRunId, type WebExplanationOverview, type WebResult, type WebRun, type WebSession, type WorkerExplanationInput,
  type WorkerExplanationMessage, type WorkerInput, type WorkerMessage } from '../apps/web/shared';
import { webExplanationEvidence } from './helpers/webExplanationFixture';

// Local HTTP fixture with a fake runner: no container, provider or model call.
const KEY = 'sk-explain-http-never-publish';
const SOURCE = 'def double (n : Nat) : Nat := n + n\n\ntheorem target_thm (n : Nat) : double n = 2 * n := by\n  sorry\n';
const PROOF = ['def double (n : Nat) : Nat := n + n', '',
  'theorem double_eq (n : Nat) : double n = n + n := rfl', '',
  'theorem target_thm (n : Nat) : double n = 2 * n := by', '  rw [double_eq]', '  omega', ''].join('\n');
const UNITS = [
  { name: 'double', kind: 'definition' as const, snippet: 'def double (n : Nat) : Nat := n + n' },
  { name: 'double_eq', kind: 'theorem' as const, snippet: 'theorem double_eq (n : Nat) : double n = n + n := rfl', uses: ['double'] },
  { name: 'target_thm', kind: 'theorem' as const, uses: ['double', 'double_eq'],
    snippet: 'theorem target_thm (n : Nat) : double n = 2 * n := by\n  rw [double_eq]\n  omega', steps: [['rw [double_eq]'], ['omega']] },
];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const settle = async () => { for (let index = 0; index < 6; index++) await tick(); };

type Explain = { input: WorkerExplanationInput; signal: AbortSignal; send(message: WorkerExplanationMessage): void; resolve(): void };
class ExplainHttpRunner implements WebRunner {
  runs: { value: WorkerInput; finish(result: WebResult): void }[] = [];
  explains: Explain[] = [];
  private readinessGate?: { entered(): void; released: Promise<void> };
  releaseReadiness?: () => void;
  blockReadiness() {
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { this.releaseReadiness = resolve; });
    this.readinessGate = { entered, released };
    return waiting;
  }
  async readiness() {
    const gate = this.readinessGate; this.readinessGate = undefined;
    if (gate) { gate.entered(); await gate.released; }
    return { ready: true, message: 'Test worker ready' };
  }
  async run(value: WorkerInput, send: (message: WorkerMessage) => void, signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      this.runs.push({ value, finish: result => { send({ type: 'result', result }); resolve(); } });
      signal.addEventListener('abort', () => reject(new Error('Aborted test worker')), { once: true });
    });
  }
  explain(input: WorkerExplanationInput, send: (message: WorkerExplanationMessage) => void, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      this.explains.push({ input: { ...input }, signal, send, resolve });
      signal.addEventListener('abort', () => reject(new Error('explanation_cancelled')), { once: true });
    });
  }
}

type Client = { cookie: string; csrf: string; session: WebSession };
describe('web proof explanation routes', () => {
  let root: string, config: WebConfig, runner: ExplainHttpRunner, service: ReturnType<typeof createWebService>, baseUrl: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-web-explain-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Local workbench</title>');
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
    config = { ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: baseUrl,
      THEOREMOS_WEB_DATA_ROOT: path.join(root, 'data') }), staticRoot: root };
    runner = new ExplainHttpRunner();
    service = createWebService(config, runner);
    await new Promise<void>((resolve, reject) => { service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolve); });
  });
  afterEach(async () => {
    runner?.releaseReadiness?.();
    await service?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function session(): Promise<Client> {
    const response = await fetch(`${baseUrl}/api/session`);
    const body = await response.json() as WebSession;
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: body.csrfToken, session: body };
  }
  function request(route: string, client: Client, options: { method?: string; body?: unknown } = {}) {
    return fetch(`${baseUrl}${route}`, { method: options.method || (options.body === undefined ? 'GET' : 'POST'),
      headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  }
  async function acceptedRun(client: Client, changes: { providerId?: string; model?: string; status?: string } = {}): Promise<WebRun> {
    const created = await request('/api/runs', client, { body: { providerId: changes.providerId ?? 'sub2api', apiKey: KEY,
      model: changes.model ?? 'deepseek-flash', effort: 'xhigh', environment: 'standard', source: SOURCE, task: 'Prove the target',
      maxTurns: 1, maxRunSeconds: 60, workers: 1, coordination: 'cooperative' } });
    expect(created.status).toBe(201);
    const { run } = await created.json() as { run: WebRun };
    await settle();
    runner.runs.at(-1)!.finish({ status: changes.status ?? 'evaluated_passed', proof: PROOF, report: {} });
    await settle();
    return (await (await request(`/api/runs/${run.id}`, client)).json() as { run: WebRun }).run;
  }
  const query = (target: string, language = 'zh') => `target=${encodeURIComponent(target)}&language=${language}`;

  it('describes, queues, cancels and serves an explanation of an accepted run', async () => {
    const alice = await session(), run = await acceptedRun(alice);
    expect(run).toMatchObject({ status: 'completed', result: { status: 'evaluated_passed' } });
    const base = `/api/runs/${run.id}/explanations`;
    const overview = await (await request(base, alice)).json() as WebExplanationOverview;
    expect(overview).toEqual({ run: { id: run.id, title: run.title, environment: 'standard', providerId: 'sub2api', model: 'deepseek-flash',
      effort: 'xhigh', proof: PROOF }, targets: [{ name: 'target_thm', declarations: 3 }], explanations: [],
    generation: { available: true, model: 'deepseek-flash', effort: 'max', key: 'required', maxRunSeconds: 28_800,
      maxTotalTokens: 40_000_000, reference: { declarations: 14, seconds: 16_200, tokens: 10_750_000 } } });

    expect((await request(base, alice, { body: { target: 'target_thm', language: 'zh' } })).status).toBe(400);
    expect((await request(base, alice, { body: { target: 'double_eq', language: 'zh', apiKey: KEY } })).status).toBe(400);
    expect((await request(base, alice, { body: { target: 'target_thm', language: 'fr', apiKey: KEY } })).status).toBe(400);
    expect((await request(base, alice, { body: { target: 'target_thm', language: 'zh', apiKey: KEY, model: 'x' } })).status).toBe(400);
    const created = await request(base, alice, { body: { target: 'target_thm', language: 'zh', apiKey: KEY } });
    expect(created.status).toBe(201);
    expect(await created.text()).not.toContain(KEY);
    await settle();
    expect(runner.explains).toHaveLength(1);
    expect(runner.explains[0]!.input).toMatchObject({ proof: PROOF, target: 'target_thm', language: 'zh', environment: 'standard',
      model: 'deepseek-flash', effort: 'max', apiKey: KEY, provider: { id: 'sub2api', baseUrl: 'http://host.docker.internal:8080/v1' } });
    expect((await request(base, alice, { body: { target: 'target_thm', language: 'zh', apiKey: KEY } })).status).toBe(409);
    expect((await request(`/api/runs/${run.id}`, alice, { method: 'DELETE' })).status).toBe(409);
    expect((await request(`${base}/item?${query('target_thm')}`, alice, { method: 'DELETE' })).status).toBe(409);

    // Another session sees nothing of this run.
    const bob = await session();
    expect((await request(base, bob)).status).toBe(404);
    expect((await request(`${base}/item?${query('target_thm')}`, bob)).status).toBe(404);

    runner.explains[0]!.send({ type: 'progress', progress: { phase: 'auditing', batches: 1, approvedBatches: 0, round: 1 } });
    const running = await (await request(`${base}/item?${query('target_thm')}`, alice)).json();
    expect(running.explanation).toMatchObject({ status: 'running', progress: { phase: 'auditing', batches: 1 } });
    const cancelled = await request(`${base}/cancel?${query('target_thm')}`, alice, { method: 'POST' });
    expect((await cancelled.json()).explanation).toMatchObject({ status: 'cancelled' });
    expect(runner.explains[0]!.signal.aborted).toBe(true);
    await settle();

    expect((await request(base, alice, { body: { target: 'target_thm', language: 'zh', apiKey: KEY } })).status).toBe(201);
    await settle();
    const call = runner.explains[1]!;
    call.send({ type: 'result', status: 'approved', evidence: JSON.parse(JSON.stringify(webExplanationEvidence({ proof: PROOF, target: 'target_thm', units: UNITS }))) });
    call.resolve();
    await settle();
    const approved = await (await request(`${base}/item?${query('target_thm')}`, alice)).json();
    expect(approved.explanation).toMatchObject({ status: 'approved', document: { target: 'target_thm',
      sections: [{ name: 'double', lines: { start: 1, end: 1 } }, { name: 'double_eq', lines: { start: 3, end: 3 } },
        { name: 'target_thm', target: true, lines: { start: 5, end: 7 }, signature: { start: 5, end: 5 }, unexplained: [], steps: [{ lines: [{ start: 6, end: 6 }] }, { lines: [{ start: 7, end: 7 }] }] }] } });
    const listed = await (await request(base, alice)).json() as WebExplanationOverview;
    expect(listed.explanations).toEqual([expect.objectContaining({ status: 'approved' })]);
    expect(listed.explanations[0]).not.toHaveProperty('document');
    const markdown = await request(`${base}/markdown?${query('target_thm')}`, alice);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(markdown.headers.get('content-disposition')).toBe(`attachment; filename="theoremos-${run.id.slice(0, 8)}-target_thm-zh.md"`);
    expect(await markdown.text()).toContain('target_thm');
    expect((await request(`${base}/markdown?${query('target_thm', 'en')}`, alice)).status).toBe(404);

    expect((await request(`${base}/item?${query('target_thm')}`, alice, { method: 'DELETE' })).status).toBe(200);
    expect((await request(`${base}/item?${query('target_thm')}`, alice)).status).toBe(404);
    expect((await request(`/api/runs/${run.id}`, alice, { method: 'DELETE' })).status).toBe(200);
  });

  it('offers generation only for accepted sub2api deepseek-flash runs, and never for the sample', async () => {
    const alice = await session();
    const generation = async (id: string) => ((await (await request(`/api/runs/${id}/explanations`, alice)).json()) as WebExplanationOverview).generation;
    expect(await generation(webSampleRunId)).toEqual({ available: false, reason: 'sample' });
    const sampleTarget = ((await (await request(`/api/runs/${webSampleRunId}/explanations`, alice)).json()) as WebExplanationOverview).targets[0]!.name;
    expect((await request(`/api/runs/${webSampleRunId}/explanations`, alice,
      { body: { target: sampleTarget, language: 'zh', apiKey: KEY } })).status).toBe(409);
    expect(await generation((await acceptedRun(alice, { providerId: 'openai', model: 'gpt-6.1-sol' })).id)).toEqual({ available: false, reason: 'provider' });
    expect(await generation((await acceptedRun(alice, { model: 'deepseek-pro' })).id)).toEqual({ available: false, reason: 'model' });
    const failed = await acceptedRun(alice, { status: 'evaluated_failed' });
    expect(await generation(failed.id)).toEqual({ available: false, reason: 'not_accepted' });
    expect((await request(`/api/runs/${failed.id}/explanations`, alice, { body: { target: 'target_thm', language: 'zh', apiKey: KEY } })).status).toBe(409);
    expect(runner.explains).toHaveLength(0);
  });

  it('does not recreate a deleted run when explanation readiness returns after deletion', async () => {
    const alice = await session(), run = await acceptedRun(alice);
    const waiting = runner.blockReadiness();
    const pending = request(`/api/runs/${run.id}/explanations`, alice,
      { body: { target: 'target_thm', language: 'zh', apiKey: KEY } });
    await waiting;
    expect((await request(`/api/runs/${run.id}`, alice, { method: 'DELETE' })).status).toBe(200);
    runner.releaseReadiness!();
    const response = await pending;
    expect(response.status).toBe(404);
    await response.arrayBuffer();
    await settle();
    expect(runner.explains).toHaveLength(0);
    expect(service.explanations.counts()).toEqual({ running: 0, queued: 0 });
    expect(service.storage.loadRuns()).toEqual([]);
    expect(fs.readdirSync(path.join(config.dataRoot!, 'owners')).flatMap(owner =>
      fs.readdirSync(path.join(config.dataRoot!, 'owners', owner, 'runs')))).not.toContain(run.id);
  });
});
