import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWebConfig, type WebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import { createWebService } from '../apps/web/server';
import type { WebRunInput, WebSession } from '../apps/web/shared';
import { inspectSignals, type Operations } from '../scripts/web-operations';

const input = (): WebRunInput => ({ providerId: 'openai', apiKey: 'sk-operations-fixture', model: 'gpt-6.1-sol',
  effort: 'high', source: 'theorem example : True := by sorry', task: 'Prove the theorem', maxTurns: 2,
  maxRunSeconds: 30, workers: 1, coordination: 'cooperative' });
class HeldRunner implements WebRunner {
  ready = true;
  async readiness() { return { ready: this.ready, message: 'Local fixture worker' }; }
  private hold(signal: AbortSignal) {
    return new Promise<never>((_resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  run: WebRunner['run'] = async (_input, _send, signal) => this.hold(signal);
  formalize: NonNullable<WebRunner['formalize']> = async (_input, _send, signal) => this.hold(signal);
  explain: NonNullable<WebRunner['explain']> = async (_input, _send, signal) => this.hold(signal);
  check: NonNullable<WebRunner['check']> = async (_input, signal) => this.hold(signal);
}
type Client = { cookie: string; csrf: string };

// Disposable account data and local workers only: no SMTP, Docker or provider request.
describe('administrator operations HTTP API', () => {
  let root: string, base: string, port: number, config: WebConfig, runner: HeldRunner;
  let service: ReturnType<typeof createWebService>;
  let mail: { to: string; text: string }[], failMail: boolean;

  async function start() {
    service = createWebService(config, runner, { sample: null, captchaAnswer: () => '12345', mailer: async message => {
      if (failMail) throw new Error('smtp://private-credential@mailer.invalid recipient=' + message.to);
      mail.push(message);
    } });
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
  }
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-operations-api-'));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    base = `http://127.0.0.1:${port}`;
    config = { ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base,
      THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_SIGNUP: 'open',
      THEOREMOS_WEB_ADMINS: 'boss@example.org', THEOREMOS_WEB_CONCURRENCY: '1',
      THEOREMOS_WEB_DATA_ROOT: path.join(root, 'data') }), staticRoot: root, sourceCommit: 'a'.repeat(40) };
    runner = new HeldRunner(); mail = []; failMail = false;
    await start();
  });
  afterEach(async () => { await service?.close(); fs.rmSync(root, { recursive: true, force: true }); });

  function request(route: string, client?: Client, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    // The restart test deliberately replaces the server at the same address; discard its old transport.
    return fetch(base + route, { method, headers: { Connection: 'close', ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function session(): Promise<Client> {
    const response = await request('/api/session'), body = await response.json() as WebSession;
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: body.csrfToken };
  }
  async function code(client: Client, email: string) {
    const { id } = await (await request('/api/auth/captcha', client, {})).json();
    return request('/api/auth/code', client, { email, captchaId: id, captcha: '12345' });
  }
  async function login(email: string): Promise<Client> {
    const client = await session();
    expect((await code(client, email)).status).toBe(200);
    const sent = mail.at(-1)!.text.match(/\b\d{6}\b/u)![0];
    const response = await request('/api/auth/verify', client,
      { email, code: sent, terms: true, termsVersion: config.auth!.termsVersion });
    expect(response.status).toBe(200);
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: (await response.json()).csrfToken };
  }
  async function status(client: Client): Promise<Operations> {
    const response = await request('/api/admin/operations', client);
    expect(response.status).toBe(200);
    return response.json();
  }
  const maintenance = (client: Client, enabled: boolean) => request('/api/admin/maintenance', client, { enabled }, 'PUT');

  it('requires a signed-in administrator and CSRF for maintenance changes', async () => {
    for (const [client, expected] of [[undefined, 401], [await session(), 403]] as const) {
      expect((await request('/api/admin/operations', client)).status).toBe(expected);
      expect((await request('/api/admin/maintenance', client, { enabled: true }, 'PUT')).status).toBe(expected);
    }
    const member = await login('member@example.org');
    expect((await request('/api/admin/operations', member)).status).toBe(403);
    expect((await maintenance(member, true)).status).toBe(403);
    const admin = await login('boss@example.org');
    expect((await maintenance({ ...admin, csrf: '' }, true)).status).toBe(403);
    expect((await request('/api/admin/maintenance', admin, { enabled: 'true' }, 'PUT')).status).toBe(400);
    expect(await status(admin)).toMatchObject({ maintenance: false, ready: true, failures: { smtp: 0 } });
  });

  it('pauses admission and readiness while keeping current work and history available', async () => {
    const admin = await login('boss@example.org');
    const owner = `account:${service.auth!.getAccount('boss@example.org')!.id}`;
    const run = service.jobs.create(owner, input(), config.providers.find(provider => provider.id === 'openai')!);
    expect((await request('/readyz')).status).toBe(200);
    expect((await maintenance(admin, true)).status).toBe(200);
    const ready = await request('/readyz');
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ready: false, maintenance: true, commit: config.sourceCommit });
    expect((await request('/healthz')).status).toBe(200);
    for (const route of ['/api/runs', '/api/formalizations', '/api/precheck'])
      expect((await request(route, admin, {})).status).toBe(503);
    expect((await (await request(`/api/runs/${run.id}`, admin)).json()).run.status).toBe('running');
    expect((await (await request('/api/session', admin)).json()).maintenance).toBe(true);
    expect(await status(admin)).toMatchObject({ maintenance: true, queues: { research: { running: 1, queued: 0 } } });
    expect((await maintenance(admin, false)).status).toBe(200);
    expect((await request('/readyz')).status).toBe(200);
    runner.ready = false;
    expect((await request('/readyz')).status).toBe(503);
    expect(await status(admin)).toMatchObject({ maintenance: false, ready: false });
  });

  it('retains the maintenance switch and administrator session across a restart', async () => {
    const admin = await login('boss@example.org');
    expect((await maintenance(admin, true)).status).toBe(200);
    await service.close(); await start();
    expect((await request('/readyz')).status).toBe(503);
    expect(await status(admin)).toMatchObject({ maintenance: true });
    expect((await maintenance(admin, false)).status).toBe(200);
    await service.close(); await start();
    expect((await request('/readyz')).status).toBe(200);
    expect(await status(admin)).toMatchObject({ maintenance: false });
  });

  it('reports SMTP failures without exposing the transport error or recipient', async () => {
    const admin = await login('boss@example.org'), anonymous = await session();
    failMail = true;
    const failed = await code(anonymous, 'undeliverable@example.org');
    expect(failed.status).toBe(502);
    const failure = await failed.json();
    const operations = await status(admin);
    expect(operations.failures).toEqual({ smtp: 1, lastSmtpFailureAt: expect.any(String) });
    expect(Number.isFinite(Date.parse(operations.failures!.lastSmtpFailureAt!))).toBe(true);
    expect(inspectSignals(operations, { minFreeGiB: 0, maxQueueSeconds: 60 })).toContain('smtp_delivery_failed');
    const serialized = JSON.stringify({ failure, operations });
    for (const secret of ['private-credential', 'mailer.invalid', 'undeliverable@example.org']) expect(serialized).not.toContain(secret);
  });

  it('exposes the oldest waiting work and advances it when queued work is cancelled', async () => {
    const admin = await login('boss@example.org'), provider = config.providers.find(item => item.id === 'openai')!;
    const runs = Array.from({ length: 3 }, (_, index) => service.jobs.create(`fixture:${index}`, input(), provider));
    const formalizations = Array.from({ length: 3 }, (_, index) => service.formalizations.create(`fixture:${index}`,
      { original: 'Prove True', apiKey: 'sk-operations-fixture', environment: 'standard', effort: 'high' }, provider, 'gpt-6.1-sol'));
    const accepted = { ...runs[0], status: 'completed' as const,
      result: { status: 'evaluated_passed', proof: 'theorem example : True := by trivial', report: {} } };
    const explanations = Array.from({ length: 3 }, (_, index) => service.explanations.create(`fixture:${index}`, accepted,
      { target: 'example', language: 'en', apiKey: 'sk-operations-fixture', provider, model: 'gpt-6.1-sol', effort: 'high' }));
    const queued = await status(admin);
    expect(queued.queues).toMatchObject({
      research: { running: 1, queued: 2, oldestQueuedAt: runs[1].createdAt },
      formalization: { running: 1, queued: 2, oldestQueuedAt: formalizations[1].createdAt },
      explanation: { running: 1, queued: 2, oldestQueuedAt: explanations[1].createdAt },
    });
    expect(inspectSignals(queued, { minFreeGiB: 0, maxQueueSeconds: 60, now: Date.now() + 120_000 })).toEqual([
      'research_queue_wait_long', 'formalization_queue_wait_long', 'explanation_queue_wait_long',
    ]);
    for (const index of [1, 2]) {
      service.jobs.cancel(`fixture:${index}`, runs[index].id);
      service.formalizations.cancel(`fixture:${index}`, formalizations[index].id);
      service.explanations.cancel(`fixture:${index}`, accepted.id, 'example', 'en');
      const remaining = await status(admin);
      for (const [name, values] of [['research', runs], ['formalization', formalizations], ['explanation', explanations]] as const)
        expect(remaining.queues[name]).toEqual({ running: 1, queued: 2 - index,
          ...(index === 1 ? { oldestQueuedAt: values[2].createdAt } : {}) });
    }
  });

  it('includes precheck queue age and removes abandoned checks from monitoring', async () => {
    const admin = await login('boss@example.org'), controllers = Array.from({ length: 3 }, () => new AbortController());
    const checks = controllers.map((controller, index) => fetch(base + '/api/precheck', { method: 'POST',
      headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf, 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ environment: 'standard', source: `theorem t${index} : True := by sorry`, checkScope: `scope-${index}` }) }));
    const settled = Promise.allSettled(checks);
    try {
      await expect.poll(async () => (await status(admin)).queues.precheck).toMatchObject({ running: 2, queued: 1, oldestQueuedAt: expect.any(String) });
      expect(inspectSignals(await status(admin), { minFreeGiB: 0, maxQueueSeconds: 60, now: Date.now() + 120_000 })).toContain('precheck_queue_wait_long');
    } finally { controllers.forEach(controller => controller.abort()); await settled; }
    await expect.poll(async () => (await status(admin)).queues.precheck).toEqual({ running: 0, queued: 0 });
  });
});
