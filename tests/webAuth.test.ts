import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig, type WebConfig } from '../apps/web/config';
import { captchaImage, type WebAccount } from '../apps/web/auth';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput, WebSession, WorkerInput, WorkerMessage } from '../apps/web/shared';

const input = (): WebRunInput => ({ providerId: 'openai', apiKey: 'sk-auth-test-never-publish', model: 'gpt-6.1-sol', effort: 'xhigh',
  source: 'theorem example : True := by sorry', task: 'Prove the theorem', maxTurns: 2,
  maxRunSeconds: 30, workers: 1, coordination: 'cooperative' });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class HeldRunner implements WebRunner {
  calls: { value: WorkerInput; signal: AbortSignal }[] = [];
  /** Tasks that finish at once with an accepted proof instead of waiting for cancellation. */
  passing = new Set<string>();
  async readiness() { return { ready: true, message: 'Test worker ready' }; }
  async run(value: WorkerInput, send: (message: WorkerMessage) => void, signal: AbortSignal) {
    this.calls.push({ value, signal });
    if (this.passing.has(value.input.task)) {
      send({ type: 'result', result: { status: 'evaluated_passed', proof: 'theorem example : True := trivial', report: {} } }); return;
    }
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
    expect(((await (await request('/api/session?runs', visitor)).json()) as WebSession).runs).toBeUndefined();

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

  it('sends a signed-out visitor from the workbench address straight to the login page, keeping a run or conversation link', async () => {
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>workbench</title>');
    const page = (route: string, client?: Client) => fetch(`${baseUrl}${route}`, { redirect: 'manual',
      headers: client ? { Cookie: client.cookie } : {} });
    for (const [route, location] of [['/', '/login.html'], ['/index.html', '/login.html'], ['/?run=0123abcd-ef', '/login.html?run=0123abcd-ef'],
      ['/?run=../x', '/login.html'], ['/?chat=abc', '/login.html'],
      ['/?chat=0123abcd-0123-4abc-8def-0123456789ab', '/login.html?chat=0123abcd-0123-4abc-8def-0123456789ab']]) {
      const response = await page(route);
      expect(response.status, route).toBe(302);
      expect(response.headers.get('location'), route).toBe(location);
      expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
    }
    // A login-page session without an account is still signed out.
    expect((await page('/', await session())).status).toBe(302);
    const alice = await login('alice@example.org');
    const signedIn = await page('/?run=0123abcd-ef', alice);
    expect(signedIn.status).toBe(200);
    expect(await signedIn.text()).toContain('workbench');
    // An address removed from the allowlist is signed out on its next page load too.
    const file = path.join(root, 'data', 'allowlist.txt');
    fs.writeFileSync(file, '# approved\nbob@example.org\n');
    const bob = await login('bob@example.org');
    expect((await page('/', bob)).status).toBe(200);
    fs.writeFileSync(file, '# approved\n');
    expect((await page('/', bob)).status).toBe(302);
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
    expect(refreshed.account).toMatchObject({ email: 'alice@example.org', passwordSet: false, passwordResetAllowed: true });
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

  it('stamps the first submitted and first accepted run on the account, once', async () => {
    const alice = await login('alice@example.org');
    const account = () => service.storage.listRecords(['accounts']).map(file => service.storage.getRecord<WebAccount>(['accounts', file])!)[0]!;
    expect(account()).toEqual({ id: expect.any(String), email: 'alice@example.org', createdAt: expect.any(String) });
    const held = await (await request('/api/runs', alice, input())).json();
    const { firstRunAt } = account();
    expect(Date.parse(firstRunAt!)).toBeGreaterThanOrEqual(Date.parse(account().createdAt));
    expect(account().firstAcceptedAt).toBeUndefined();
    // The held run occupies the only worker slot; cancelling it is not an acceptance.
    await request(`/api/runs/${held.run.id}/cancel`, alice, {});
    await tick();
    expect(account().firstAcceptedAt).toBeUndefined();

    runner.passing.add('Prove it at once');
    const passed = await (await request('/api/runs', alice, { ...input(), task: 'Prove it at once' })).json();
    for (let attempt = 0; attempt < 50 && account().firstAcceptedAt === undefined; attempt++) await tick();
    const { firstAcceptedAt } = account();
    expect(firstAcceptedAt).toEqual(expect.any(String));
    expect((await (await request(`/api/runs/${passed.run.id}`, alice)).json()).run.result.status).toBe('evaluated_passed');

    await request('/api/runs', alice, { ...input(), task: 'Prove it at once' });
    for (let attempt = 0; attempt < 10; attempt++) await tick();
    expect(account()).toMatchObject({ firstRunAt, firstAcceptedAt });
  });

  it('sets a salted password after email verification, logs in with it, and recovers it through email', async () => {
    const first = await login('alice@example.org');
    expect((await request('/api/auth/password', first, { password: 'short' }, 'PATCH')).status).toBe(400);
    const original = 'CorrectHorse2026!', changed = 'AnotherStrong2026!', recovered = 'RecoveredStrong2026!';
    expect((await request('/api/auth/password', first, { password: original }, 'PATCH')).status).toBe(200);
    const credentialFile = service.storage.listRecords(['passwords']);
    expect(credentialFile).toHaveLength(1);
    const credential = service.storage.getRecord<{ algorithm: string; salt: string; digest: string }>(['passwords', credentialFile[0]!])!;
    expect(credential.algorithm).toBe('scrypt');
    expect(credential.salt).toMatch(/^[a-f0-9]{32}$/u);
    expect(credential.digest).toMatch(/^[a-f0-9]{128}$/u);
    expect(JSON.stringify(credential)).not.toContain(original);
    expect((await (await request('/api/session', first)).json() as WebSession).account).toMatchObject({ passwordSet: true, passwordResetAllowed: false });

    await service.close();
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    config.port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    baseUrl = 'http://127.0.0.1:' + config.port;
    config.publicUrl = baseUrl;
    service = createWebService(config, runner, { mailer: async message => { mail.push(message); }, captchaAnswer: () => '12345' });
    await new Promise<void>(resolve => service.server.listen(config.port, '127.0.0.1', resolve));
    const visitor = await session();
    expect((await request('/api/auth/password/login', visitor, { email: 'mallory@example.org', password: original })).status).toBe(401);
    expect((await request('/api/auth/password/login', visitor, { email: 'alice@example.org', password: 'incorrect' })).status).toBe(401);
    const signedIn = await request('/api/auth/password/login', visitor, { email: 'ALICE@example.org', password: original });
    expect(signedIn.status).toBe(200);
    const passwordClient: Client = { cookie: signedIn.headers.get('set-cookie')!.split(';')[0],
      csrf: (await signedIn.json()).csrfToken, session: visitor.session };
    expect(passwordClient.cookie).not.toBe(visitor.cookie);
    expect((await request('/api/runs', visitor)).status).toBe(401);
    expect((await (await request('/api/session', passwordClient)).json() as WebSession).account).toMatchObject({ passwordResetAllowed: false });
    expect((await request('/api/auth/password', passwordClient,
      { currentPassword: 'incorrect', password: changed }, 'PATCH')).status).toBe(403);
    expect((await request('/api/auth/password', passwordClient,
      { currentPassword: original, password: changed }, 'PATCH')).status).toBe(200);
    expect((await request('/api/runs', first)).status).toBe(401);
    expect((await request('/api/auth/password/login', await session(), { email: 'alice@example.org', password: original })).status).toBe(401);

    const verifiedAgain = await login('alice@example.org');
    expect((await request('/api/auth/password', verifiedAgain, { password: recovered }, 'PATCH')).status).toBe(200);
    expect((await request('/api/runs', passwordClient)).status).toBe(401);
    expect((await request('/api/auth/password/login', await session(), { email: 'alice@example.org', password: recovered })).status).toBe(200);
    expect((await request('/api/auth/account', verifiedAgain, { email: 'alice@example.org' }, 'DELETE')).status).toBe(200);
    expect(service.storage.listRecords(['passwords'])).toEqual([]);
  });

  it('limits password guesses without blocking the email-code recovery path', async () => {
    const visitor = await session();
    for (let attempt = 0; attempt < 5; attempt++)
      expect((await request('/api/auth/password/login', visitor,
        { email: 'alice@example.org', password: 'wrong-password' })).status).toBe(401);
    expect((await request('/api/auth/password/login', visitor,
      { email: 'alice@example.org', password: 'wrong-password' })).status).toBe(429);
    expect((await login('alice@example.org')).cookie).toBeTruthy();
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
