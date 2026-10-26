import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig, type WebConfig } from '../apps/web/config';
import { captchaImage } from '../apps/web/auth';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput, WebSession, WorkerInput } from '../apps/web/shared';

const input = (): WebRunInput => ({ providerId: 'openai', apiKey: 'sk-auth-test-never-publish', model: 'gpt-6.1-sol', effort: 'xhigh',
  source: 'theorem example : True := by sorry', task: 'Prove the theorem', maxTurns: 2,
  maxRunSeconds: 30, workers: 1, coordination: 'cooperative' });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class HeldRunner implements WebRunner {
  calls: { value: WorkerInput; signal: AbortSignal }[] = [];
  async readiness() { return { ready: true, message: 'Test worker ready' }; }
  async run(value: WorkerInput, _send: unknown, signal: AbortSignal) {
    this.calls.push({ value, signal });
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  }
}
type Client = { cookie: string; csrf: string; session: WebSession };

describe('email login with captcha, allowlist and account-owned records', () => {
  let root: string, config: WebConfig, runner: HeldRunner, baseUrl: string;
  let service: ReturnType<typeof createWebService>;
  let mail: { to: string; text: string }[];

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-web-auth-'));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
    config = { ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: baseUrl, THEOREMOS_WEB_AUTH: 'email',
      THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'Alice@Example.org', THEOREMOS_WEB_DATA_ROOT: path.join(root, 'data') }),
      staticRoot: root };
    runner = new HeldRunner(); mail = [];
    service = createWebService(config, runner, { mailer: async message => { mail.push(message); }, captchaAnswer: () => '12345' });
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
  });
  afterEach(async () => {
    await service?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function request(route: string, client?: Client, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    return fetch(`${baseUrl}${route}`, { method, headers: { ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function session(): Promise<Client> {
    const response = await request('/api/session');
    expect(response.status).toBe(200);
    const body = await response.json() as WebSession;
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: body.csrfToken, session: body };
  }
  async function code(client: Client, email: string, answer = '12345') {
    const { id } = await (await request('/api/auth/captcha', client, {})).json();
    return request('/api/auth/code', client, { email, captchaId: id, captcha: answer });
  }
  async function login(email: string): Promise<Client> {
    const anonymous = await session();
    expect((await code(anonymous, email)).status).toBe(200);
    const sent = mail.at(-1)!.text.match(/\b\d{6}\b/u)![0];
    const verified = await request('/api/auth/verify', anonymous, { email, code: sent });
    expect(verified.status).toBe(200);
    const body = await verified.json();
    const client = { cookie: verified.headers.get('set-cookie')!.split(';')[0], csrf: body.csrfToken, session: anonymous.session };
    expect(client.cookie).not.toBe(anonymous.cookie);
    return client;
  }

  it('requires email login on a public address and keeps loopback previews anonymous', () => {
    expect(() => readWebConfig({ THEOREMOS_WEB_PUBLIC_URL: 'https://workbench.example' })).toThrow(/SMTP/u);
    expect(() => readWebConfig({ THEOREMOS_WEB_PUBLIC_URL: 'https://workbench.example', THEOREMOS_WEB_SMTP_URL: 'log:' })).toThrow(/loopback/u);
    expect(readWebConfig({ THEOREMOS_WEB_PUBLIC_URL: 'https://workbench.example', THEOREMOS_WEB_SMTP_URL: 'smtps://u:p@smtp.example',
      THEOREMOS_WEB_MAIL_FROM: 'TheoremOS <login@example.org>' }).auth?.smtpUrl).toBe('smtps://u:p@smtp.example');
    expect(readWebConfig({ THEOREMOS_WEB_PUBLIC_URL: 'https://workbench.example', THEOREMOS_WEB_AUTH: 'none' }).auth).toBeUndefined();
    expect(readWebConfig({}).auth).toBeUndefined();
  });

  it('blocks work before login, spends each captcha once and only mails allowlisted addresses', async () => {
    const visitor = await session();
    expect(visitor.session.auth).toBe('email');
    expect(visitor.session.account).toBeUndefined();
    const blocked = await request('/api/runs', visitor);
    expect(blocked.status).toBe(401);
    expect((await blocked.json()).error).toBe('请先登录。');
    expect((await request('/api/runs', visitor, input())).status).toBe(401);

    const { id } = await (await request('/api/auth/captcha', visitor, {})).json();
    expect((await request('/api/auth/code', visitor, { email: 'alice@example.org', captchaId: id, captcha: '00000' })).status).toBe(400);
    expect((await request('/api/auth/code', visitor, { email: 'alice@example.org', captchaId: id, captcha: '12345' })).status).toBe(400);
    expect((await request('/api/auth/captcha', undefined, {})).status).toBe(401);

    const stranger = await code(visitor, 'mallory@example.org');
    expect(stranger.status).toBe(403);
    expect((await stranger.json()).error).toMatch(/内测资格/u);
    expect(mail).toHaveLength(0);

    const sent = await code(visitor, ' ALICE@example.org ');
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ email: 'alice@example.org', expiresInSeconds: 600, resendAfterSeconds: 60 });
    expect(mail).toEqual([expect.objectContaining({ to: 'alice@example.org' })]);
    expect((await code(visitor, 'alice@example.org')).status).toBe(429);
    expect(mail).toHaveLength(1);
  });

  it('rotates the session on login, rejects wrong codes and invalidates a code after five misses', async () => {
    const visitor = await session();
    await code(visitor, 'alice@example.org');
    const sent = mail[0]!.text.match(/\b\d{6}\b/u)![0], wrong = sent === '000000' ? '111111' : '000000';
    for (let attempt = 1; attempt < 5; attempt++)
      expect((await (await request('/api/auth/verify', visitor, { email: 'alice@example.org', code: wrong })).json()).error).toBe('验证码不正确。');
    expect((await (await request('/api/auth/verify', visitor, { email: 'alice@example.org', code: wrong })).json()).error).toMatch(/次数过多/u);
    expect((await request('/api/auth/verify', visitor, { email: 'alice@example.org', code: sent })).status).toBe(400);

    const alice = await login('alice@example.org');
    expect((await request('/api/runs', visitor)).status).toBe(401);
    const refreshed = await (await request('/api/session', alice)).json() as WebSession;
    expect(refreshed.account).toEqual({ email: 'alice@example.org' });
    expect(refreshed.csrfToken).toBe(alice.csrf);
    expect(captchaImage('12345')).not.toMatch(/12345|<text/u);
  });

  it('shares records across an account\'s sessions, keeps them after logout and session expiry', async () => {
    const laptop = await login('alice@example.org'), phone = await login('alice@example.org');
    const { run } = await (await request('/api/runs', laptop, input())).json();
    const ids = async (client: Client) => (await (await request('/api/runs', client)).json()).runs.map((item: { id: string }) => item.id);
    expect(await ids(phone)).toEqual([run.id]);
    expect((await request('/api/auth/logout', laptop, {})).status).toBe(200);
    expect((await request('/api/runs', laptop)).status).toBe(401);
    expect(await ids(phone)).toEqual([run.id]);

    config.sessionTtlMs = 60_000;
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
    try {
      expect((await request('/api/runs', phone)).status).toBe(401);
      expect(await ids(await login('alice@example.org'))).toEqual([run.id]);
    } finally { clock.mockRestore(); }
  });

  it('reads the allowlist file on every login and signs out an address once it is removed', async () => {
    const file = path.join(root, 'data', 'allowlist.txt');
    expect((await code(await session(), 'bob@example.org')).status).toBe(403);
    fs.writeFileSync(file, '# approved\nbob@example.org\n');
    const bob = await login('bob@example.org');
    expect((await request('/api/runs', bob)).status).toBe(200);
    fs.writeFileSync(file, '# approved\n');
    expect((await request('/api/runs', bob)).status).toBe(401);
    expect((await (await request('/api/session', bob)).json()).account).toBeUndefined();
  });

  it('deletes an account with its records, cancels its runs and ends every session', async () => {
    const alice = await login('alice@example.org'), other = await login('alice@example.org');
    await request('/api/runs', alice, input());
    await tick();
    expect(runner.calls).toHaveLength(1);
    expect((await request('/api/auth/account', alice, { email: 'someone@example.org' }, 'DELETE')).status).toBe(400);
    expect((await request('/api/auth/account', alice, { email: 'ALICE@example.org' }, 'DELETE')).status).toBe(200);
    await tick();
    expect(runner.calls[0]!.signal.aborted).toBe(true);
    expect(service.storage.listRecords(['owners'])).toEqual([]);
    expect(service.storage.listRecords(['accounts'])).toEqual([]);
    for (const client of [alice, other]) expect((await request('/api/runs', client)).status).toBe(401);
    expect((await (await request('/api/runs', await login('alice@example.org'))).json()).runs).toEqual([]);
  });
});
