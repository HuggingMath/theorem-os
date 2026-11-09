import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig, type WebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebSession } from '../apps/web/shared';

type Client = { cookie: string; csrf: string };
const pair = (value: string) => value.split(';')[0]!;
const idOf = (cookie: string) => cookie.slice(cookie.indexOf('=') + 1);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
/** Apply real Set-Cookie headers in arrival order, including cookie deletion. */
function applyCookies(jar: Map<string, string>, response: Response) {
  for (const header of response.headers.getSetCookie()) {
    const cookie = pair(header), separator = cookie.indexOf('='), name = cookie.slice(0, separator);
    if (/; Max-Age=0(?:;|$)/u.test(header)) jar.delete(name);
    else jar.set(name, cookie.slice(separator + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

describe('anonymous email bootstrap and signed-in identity cookies', () => {
  let root: string, config: WebConfig, origin: string;
  let service: ReturnType<typeof createWebService>;
  let runner: WebRunner, mail: { to: string; text: string }[];
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-session-cookies-'));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
      THEOREMOS_WEB_DATA_ROOT: root, THEOREMOS_WEB_STATIC_ROOT: root, THEOREMOS_WEB_AUTH: 'email',
      THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org', THEOREMOS_WEB_SESSION_TTL_SECONDS: '60' });
    runner = { async readiness() { return { ready: true, message: 'Disposable session fixture' }; },
      async run() { throw new Error('Session checks must not start runs'); } };
    mail = [];
    service = createWebService(config, runner, { sample: null, captchaAnswer: () => '24680', mailer: async message => { mail.push(message); } });
    await new Promise<void>(resolve => service.server.listen(config.port, '127.0.0.1', resolve));
  });
  afterEach(async () => { vi.restoreAllMocks(); await service?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // A restarted service must not inherit a keep-alive connection from the previous instance.
  const request = (pathname: string, client?: Client, body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(origin + pathname, {
    method, headers: { Connection: 'close', ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function bootstrap(): Promise<Client> {
    const response = await request('/api/session'); expect(response.status).toBe(200);
    const body = await response.json() as WebSession;
    return { cookie: pair(response.headers.getSetCookie()[0]!), csrf: body.csrfToken };
  }
  async function verify(client: Client, email: string) {
    const captcha = await (await request('/api/auth/captcha', client, {})).json();
    expect((await request('/api/auth/code', client, { email, captchaId: captcha.id, captcha: '24680' })).status).toBe(200);
    const code = mail.findLast(item => item.to === email)!.text.match(/\b\d{6}\b/u)![0];
    const response = await request('/api/auth/verify', client, { email, code }); expect(response.status).toBe(200);
    const body = await response.clone().json();
    return { response, client: { cookie: pair(response.headers.getSetCookie()[0]!), csrf: body.csrfToken } as Client };
  }

  it('keeps a newer login when an expired-session bootstrap response arrives last, and binds writes to the winning identity', async () => {
    const alice = (await verify(await bootstrap(), 'alice@example.org')).client;
    const jar = new Map([['theoremos_session', idOf(alice.cookie)]]), reached = deferred(), release = deferred();
    const at = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(at + 60_001);
    vi.spyOn(runner, 'readiness').mockImplementationOnce(async () => { reached.resolve(); await release.promise; return { ready: true, message: 'Delayed expired bootstrap' }; });
    const late = request('/api/session', alice);
    try {
      await reached.promise;
      const bob = await verify(await bootstrap(), 'bob@example.org');
      applyCookies(jar, bob.response);
      const signedInId = jar.get('theoremos_session');
      release.resolve();
      const bootstrapResponse = await late, anonymous = await bootstrapResponse.clone().json() as WebSession;
      expect(anonymous.account).toBeUndefined();
      expect(bootstrapResponse.headers.getSetCookie()).toEqual([expect.stringMatching(/^theoremos_bootstrap=.+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=60$/u)]);
      const cookie = applyCookies(jar, bootstrapResponse);
      expect(jar.get('theoremos_session')).toBe(signedInId);
      const current: Client = { cookie, csrf: bob.client.csrf };
      const read = await request('/api/session', current);
      expect((await read.json()).account.email).toBe('bob@example.org'); expect(read.headers.getSetCookie()).toEqual([]);
      const staleCsrf = await request('/api/auth/account', { ...current, csrf: anonymous.csrfToken }, { completionEmail: false }, 'PATCH');
      expect(staleCsrf.status).toBe(403);
      expect((await request('/api/auth/account', current, { completionEmail: false }, 'PATCH')).status).toBe(200);
      expect(service.auth!.getAccount('bob@example.org')?.completionEmail).toBe(false);
      expect(service.auth!.getAccount('alice@example.org')?.completionEmail).toBeUndefined();
      expect((await request('/api/auth/captcha', alice, {})).status).toBe(401);
    } finally { release.resolve(); clock.mockRestore(); await late; }
  });

  it('accepts legacy anonymous cookies, retains persisted login cookies across restart, and never authenticates through a bootstrap cookie', async () => {
    const anonymous = await bootstrap(); expect(anonymous.cookie).toMatch(/^theoremos_bootstrap=/u);
    const legacy = { ...anonymous, cookie: 'theoremos_session=' + idOf(anonymous.cookie) };
    const oldRead = await request('/api/session', legacy);
    expect((await oldRead.json()).csrfToken).toBe(legacy.csrf); expect(oldRead.headers.getSetCookie()).toEqual([]);
    const alice = await verify(legacy, 'alice@example.org');
    expect(alice.client.cookie).toMatch(/^theoremos_session=/u);
    expect(alice.response.headers.getSetCookie()[1]).toMatch(/^theoremos_bootstrap=;.*Max-Age=0/u);
    const unrelated = await bootstrap();
    await service.close();
    service = createWebService(config, runner, { sample: null });
    await new Promise<void>(resolve => service.server.listen(config.port, '127.0.0.1', resolve));
    for (const cookie of [alice.client.cookie + '; ' + unrelated.cookie, unrelated.cookie + '; ' + alice.client.cookie]) {
      const response = await request('/api/session', { ...alice.client, cookie });
      expect((await response.json()).account.email).toBe('alice@example.org'); expect(response.headers.getSetCookie()).toEqual([]);
    }
    const misplaced = await request('/api/session', { ...alice.client, cookie: 'theoremos_bootstrap=' + idOf(alice.client.cookie) });
    expect((await misplaced.json()).account).toBeUndefined();
    expect((await request('/api/auth/captcha', anonymous, {})).status).toBe(401);
  });

  it('keeps current terms and CSRF requirements with both cookies and clears both at logout before a new bootstrap', async () => {
    const login = await verify(await bootstrap(), 'alice@example.org'), anonymous = await bootstrap();
    const client = { ...login.client, cookie: anonymous.cookie + '; ' + login.client.cookie };
    config.auth!.termsVersion = 'cookie-contract-v2';
    const pending = await (await request('/api/session', client)).json();
    expect(pending).toMatchObject({ account: { email: 'alice@example.org' }, termsRequired: true, csrfToken: client.csrf });
    expect((await request('/api/research/session', client)).status).toBe(428);
    expect((await request('/api/auth/terms', { ...client, csrf: anonymous.csrf }, { terms: true, termsVersion: 'cookie-contract-v2' })).status).toBe(403);
    expect((await request('/api/auth/terms', client, { terms: true, termsVersion: 'cookie-contract-v2' })).status).toBe(200);
    expect((await request('/api/research/session', client)).status).toBe(200);
    const logout = await request('/api/auth/logout', client, {}); expect(logout.status).toBe(200);
    const jar = new Map([['theoremos_session', idOf(login.client.cookie)], ['theoremos_bootstrap', idOf(anonymous.cookie)]]);
    expect(applyCookies(jar, logout)).toBe(''); expect(logout.headers.getSetCookie()).toHaveLength(2);
    expect((await request('/api/runs', login.client)).status).toBe(401);
    const next = await bootstrap(); expect(next.cookie).toMatch(/^theoremos_bootstrap=/u); expect(next.csrf).not.toBe(login.client.csrf);
    expect((await request('/api/auth/captcha', next, {})).status).toBe(200);
  });

  it('leaves auth:none cookie identity, CSRF and anonymous ownership unchanged when a bootstrap cookie is also present', async () => {
    await service.close(); config.auth = undefined;
    service = createWebService(config, runner, { sample: null });
    await new Promise<void>(resolve => service.server.listen(config.port, '127.0.0.1', resolve));
    const anonymous = await bootstrap(); expect(anonymous.cookie).toMatch(/^theoremos_session=/u);
    const client = { ...anonymous, cookie: 'theoremos_bootstrap=unrelated; ' + anonymous.cookie };
    const refreshed = await request('/api/session', client), value = await refreshed.json() as WebSession;
    expect(value.auth).toBe('none'); expect(value.csrfToken).toBe(client.csrf);
    expect(refreshed.headers.getSetCookie()).toEqual([expect.stringContaining(anonymous.cookie + ';')]);
    const created = await request('/api/research/theorems', client, { requestId: crypto.randomUUID(), title: 'Anonymous owned project' });
    expect(created.status).toBe(201);
    const project = (await created.json()).item;
    expect((await (await request('/api/research/theorems/' + project.id, client)).json()).item.permissions.manage).toBe(true);
    expect((await request('/api/research/theorems', { ...client, csrf: 'wrong' }, { requestId: crypto.randomUUID(), title: 'Rejected' })).status).toBe(403);
  });
});
