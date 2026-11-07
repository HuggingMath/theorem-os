import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWebConfig, type WebConfig } from '../apps/web/config';
import { WebQuota } from '../apps/web/quota';
import type { WebRunner } from '../apps/web/runner';
import { createWebService } from '../apps/web/server';
import type { WebSession } from '../apps/web/shared';

type Client = { cookie: string; csrf: string };
class DeferredRunner implements WebRunner {
  calls = { run: 0, formalize: 0 };
  private gate?: { entered: () => void; released: Promise<void> };
  release?: () => void;

  blockReadiness() {
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { this.release = resolve; });
    this.gate = { entered, released };
    return waiting;
  }
  async readiness() {
    const gate = this.gate;
    this.gate = undefined;
    if (gate) { gate.entered(); await gate.released; }
    return { ready: true, message: 'Local fixture ready' };
  }
  async run() { this.calls.run++; }
  async formalize() { this.calls.formalize++; }
}

const submissions = [
  { route: '/api/formalizations', body: { original: 'For every natural n, n + 0 = n.', environment: 'standard',
    effort: 'max', apiKey: 'sk-local-admission-fixture' } },
  { route: '/api/runs', body: { providerId: 'openai', apiKey: 'sk-local-admission-fixture', model: 'gpt-6.1-sol',
    effort: 'xhigh', source: 'theorem example : True := by sorry', task: 'Prove', maxTurns: 2,
    maxRunSeconds: 30, workers: 1, coordination: 'cooperative' } },
];

describe('admission after asynchronous readiness', () => {
  let config: WebConfig, baseUrl: string, runner: DeferredRunner;
  let service: ReturnType<typeof createWebService>;
  let mail: { to: string; text: string }[];

  beforeEach(async () => {
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
    config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: baseUrl,
      THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'alice@example.org',
      THEOREMOS_WEB_ADMINS: 'boss@example.org' });
    runner = new DeferredRunner(); mail = [];
    service = createWebService(config, runner, { mailer: async message => { mail.push(message); }, captchaAnswer: () => '12345' });
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
  });
  afterEach(async () => {
    runner?.release?.();
    await service?.close();
  });

  function request(route: string, client?: Client, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    return fetch(`${baseUrl}${route}`, { method, headers: { ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function login(email: string): Promise<Client> {
    const response = await request('/api/session');
    const session = await response.json() as WebSession;
    const anonymous = { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: session.csrfToken };
    const { id } = await (await request('/api/auth/captcha', anonymous, {})).json();
    expect((await request('/api/auth/code', anonymous, { email, captchaId: id, captcha: '12345' })).status).toBe(200);
    const code = mail.at(-1)!.text.match(/\b\d{6}\b/u)![0];
    const verified = await request('/api/auth/verify', anonymous, { email, code });
    expect(verified.status).toBe(200);
    const signedIn = await verified.json();
    return { cookie: verified.headers.get('set-cookie')!.split(';')[0]!, csrf: signedIn.csrfToken };
  }

  for (const { route, body } of submissions) {
    it.each(['suspension', 'maintenance'] as const)(`refuses ${route} when %s begins during readiness`, async change => {
      const client = await login('alice@example.org'), admin = await login('boss@example.org');
      const account = service.auth!.getAccount('alice@example.org')!;
      const waiting = runner.blockReadiness();
      const pending = request(route, client, body);
      await waiting;
      const update = change === 'suspension'
        ? await request('/api/admin/accounts', admin, { email: account.email, suspended: true }, 'PATCH')
        : await request('/api/admin/maintenance', admin, { enabled: true }, 'PUT');
      expect(update.status).toBe(200);
      await update.arrayBuffer();
      runner.release!();
      const rejected = await pending;
      expect(rejected.status).toBe(change === 'suspension' ? 401 : 503);
      await rejected.arrayBuffer();
      expect(runner.calls).toEqual({ run: 0, formalize: 0 });
      expect(service.jobs.list(`account:${account.id}`)).toEqual([]);
      expect(service.formalizations.list(`account:${account.id}`)).toEqual([]);
      expect(new WebQuota(service.storage, config.quota).view(account.id)).toMatchObject({
        runs: { used: 0 }, formalizations: { used: 0 }, explanations: { used: 0 },
      });
    });
  }
});
