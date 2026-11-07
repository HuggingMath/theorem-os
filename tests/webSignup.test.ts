import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig, type WebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput, WebSession, WorkerInput, WorkerMessage } from '../apps/web/shared';

const input = (task = 'Prove the theorem'): WebRunInput => ({ providerId: 'openai', apiKey: 'sk-signup-test-never-publish', model: 'gpt-6.1-sol',
  effort: 'xhigh', source: 'theorem example : True := by sorry', task, maxTurns: 2, maxRunSeconds: 30, workers: 1, coordination: 'cooperative' });
class HeldRunner implements WebRunner {
  async readiness() { return { ready: true, message: 'Test worker ready' }; }
  async run(_value: WorkerInput, _send: (message: WorkerMessage) => void, signal: AbortSignal) {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  }
}
type Client = { cookie: string; csrf: string; session: WebSession };

describe('open signup with a per-account allowance', () => {
  let root: string, config: WebConfig, baseUrl: string;
  let service: ReturnType<typeof createWebService>;
  let mail: { to: string; text: string }[];

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-web-signup-'));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
    config = { ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: baseUrl, THEOREMOS_WEB_AUTH: 'email',
      THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_SIGNUP: 'open', THEOREMOS_WEB_ALLOWLIST: 'owner@example.org',
      THEOREMOS_WEB_ADMINS: 'boss@example.org',
      THEOREMOS_WEB_QUOTA_RUNS: '1', THEOREMOS_WEB_QUOTA_FORMALIZATIONS: '2', THEOREMOS_WEB_QUOTA_EXPLANATIONS: '2',
      THEOREMOS_WEB_DATA_ROOT: path.join(root, 'data') }), staticRoot: root };
    mail = [];
    service = createWebService(config, new HeldRunner(), { mailer: async message => { mail.push(message); }, captchaAnswer: () => '12345' });
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
    const body = await response.json() as WebSession;
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: body.csrfToken, session: body };
  }
  async function code(client: Client, email: string) {
    const { id } = await (await request('/api/auth/captcha', client, {})).json();
    return request('/api/auth/code', client, { email, captchaId: id, captcha: '12345' });
  }
  /** Signs in, optionally consenting to the terms, and returns the signed-in client and the code that was mailed. */
  async function login(email: string, consent = true): Promise<Client> {
    const anonymous = await session();
    expect((await code(anonymous, email)).status).toBe(200);
    const sent = mail.at(-1)!.text.match(/\b\d{6}\b/u)![0];
    const verified = await request('/api/auth/verify', anonymous, { email, code: sent, ...(consent ? { terms: true, termsVersion: config.auth!.termsVersion } : {}) });
    expect(verified.status).toBe(200);
    const body = await verified.json();
    return { cookie: verified.headers.get('set-cookie')!.split(';')[0], csrf: body.csrfToken, session: anonymous.session };
  }

  it('admits an address that was never allowlisted and records the terms it agreed to', async () => {
    const visitor = await session();
    expect(visitor.session.signup).toBe('open');
    expect(visitor.session.quota).toBeUndefined();
    const newcomer = await login('stranger@example.org');
    const sessionBody = await (await request('/api/session', newcomer)).json() as WebSession;
    expect(sessionBody.signup).toBe('open');
    expect(sessionBody.account?.email).toBe('stranger@example.org');
    expect(sessionBody.quota).toEqual({ windowHours: 24, windowEndsAt: expect.any(String),
      runs: { used: 0, limit: 1 }, formalizations: { used: 0, limit: 2 }, explanations: { used: 0, limit: 2 } });
    const account = service.auth!.getAccount('stranger@example.org');
    expect(account?.termsVersion).toBe('2026-11-07');
    expect(account?.termsAt).toEqual(expect.any(String));
  });

  it('refuses a code without consent, and signs in again without asking a settled account to agree once more', async () => {
    const anonymous = await session();
    expect((await code(anonymous, 'stranger@example.org')).status).toBe(200);
    const sent = mail.at(-1)!.text.match(/\b\d{6}\b/u)![0];
    const refused = await request('/api/auth/verify', anonymous, { email: 'stranger@example.org', code: sent });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe('请先阅读并同意使用条款与隐私说明。');
    // The code is spent and no account is attached.
    expect((await (await request('/api/session', anonymous)).json() as WebSession).account).toBeUndefined();
    expect(service.auth!.getAccount('stranger@example.org')).toBeUndefined();
    expect((await request('/api/runs', anonymous, input())).status).toBe(401);
    const signedIn = await login('stranger@example.org');
    expect((await request('/api/session', signedIn)).status).toBe(200);
    // The same address signing in again keeps its account.
    const again = await login('stranger@example.org');
    expect((await (await request('/api/session', again)).json() as WebSession).account?.email).toBe('stranger@example.org');
  });

  it('counts a started run, refuses the next one in the window, and gives the allowance back when a submit fails', async () => {
    const client = await login('stranger@example.org');
    const rejected = await request('/api/runs', client, { ...input(), providerId: 'missing' });
    expect(rejected.status).toBe(400);
    expect((await (await request('/api/session', client)).json() as WebSession).quota?.runs.used).toBe(0);
    const first = await request('/api/runs', client, input('First run'));
    expect(first.status).toBe(201);
    const after = (await (await request('/api/session', client)).json() as WebSession).quota!;
    expect(after.runs).toEqual({ used: 1, limit: 1 });
    const second = await request('/api/runs', client, input('Second run'));
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe('已达到每 24 小时 1 次研究的额度。已开始的运行不受影响；额度会在窗口结束后恢复。');
    // The refused request did not spend anything.
    expect((await (await request('/api/session', client)).json() as WebSession).quota?.runs.used).toBe(1);
  });

  it('exempts admin accounts from the allowance', async () => {
    const admin = await login('boss@example.org');
    expect((await (await request('/api/session', admin)).json() as WebSession).quota).toBeUndefined();
    expect((await request('/api/runs', admin, input('Admin run'))).status).toBe(201);
    expect((await request('/api/runs', admin, input('Second admin run'))).status).toBe(201);
  });

  it('keeps the current allowance after the same address deletes and recreates its account', async () => {
    const first = await login('stranger@example.org');
    const originalId = service.auth!.getAccount('stranger@example.org')!.id;
    expect((await request('/api/runs', first, input())).status).toBe(201);
    expect((await request('/api/auth/account', first, { email: 'stranger@example.org' }, 'DELETE')).status).toBe(200);
    expect(service.auth!.getAccount('stranger@example.org')).toBeUndefined();
    const recreated = await login('stranger@example.org');
    expect(service.auth!.getAccount('stranger@example.org')!.id).not.toBe(originalId);
    expect((await (await request('/api/session', recreated)).json() as WebSession).quota?.runs).toEqual({ used: 1, limit: 1 });
    expect((await request('/api/runs', recreated, input('After recreation'))).status).toBe(429);
    expect((await (await request('/api/runs', recreated)).json()).runs).toEqual([]);
  });

  it('requires current terms for old sessions while keeping logout and deletion available', async () => {
    const client = await login('stranger@example.org');
    const accountId = service.auth!.getAccount('stranger@example.org')!.id;
    config.auth!.termsVersion = 'v2';
    const pending = await (await request('/api/session', client)).json() as WebSession;
    expect(pending).toMatchObject({ termsVersion: 'v2', termsRequired: true, account: { email: 'stranger@example.org' } });
    expect((await request('/api/runs', client, input())).status).toBe(428);
    expect((await request('/api/auth/terms', client, { terms: true, termsVersion: '2026-11-07' })).status).toBe(428);
    expect((await request('/api/auth/terms', client, { terms: true, termsVersion: 'v2' })).status).toBe(200);
    expect(service.auth!.getAccount('stranger@example.org')).toMatchObject({ id: accountId, termsVersion: 'v2' });
    expect((await request('/api/runs', client, input())).status).toBe(201);
    config.auth!.termsVersion = 'v3';
    expect((await request('/api/auth/account', client, { email: 'stranger@example.org' }, 'DELETE')).status).toBe(200);
    const other = await login('other@example.org');
    config.auth!.termsVersion = 'v4';
    expect((await request('/api/auth/logout', other, {})).status).toBe(200);
  });

  it('lets an admin suspend and restore an open-signup account, preserving its records', async () => {
    const client = await login('stranger@example.org'), admin = await login('boss@example.org');
    const accountId = service.auth!.getAccount('stranger@example.org')!.id;
    const created = await request('/api/runs', client, input());
    const run = (await created.json()).run;
    expect((await request('/api/admin/accounts', client, { email: 'boss@example.org', suspended: true }, 'PATCH')).status).toBe(403);
    const suspended = await request('/api/admin/accounts', admin, { email: 'stranger@example.org', suspended: true }, 'PATCH');
    expect(suspended.status).toBe(200);
    expect((await suspended.json()).accounts.find((item: { email: string }) => item.email === 'stranger@example.org')).toMatchObject({ suspended: true, allowed: false });
    expect((await request('/api/runs', client)).status).toBe(401);
    expect((await code(await session(), 'stranger@example.org')).status).toBe(403);
    expect((await request('/api/admin/accounts', admin, { email: 'boss@example.org', suspended: true }, 'PATCH')).status).toBe(400);
    expect((await request('/api/admin/accounts', admin, { email: 'stranger@example.org', suspended: false }, 'PATCH')).status).toBe(200);
    const restored = await login('stranger@example.org');
    expect(service.auth!.getAccount('stranger@example.org')!.id).toBe(accountId);
    const saved = (await (await request(`/api/runs/${run.id}`, restored)).json()).run;
    expect(saved.status).toBe('cancelled');
  });

  it('limits anonymous-session creation per visitor while preserving current sessions and other visitors', async () => {
    config.clientIpHeader = 'x-fixture-ip';
    const first = await fetch(`${baseUrl}/api/session`, { headers: { 'X-Fixture-IP': 'one' } });
    const cookie = first.headers.get('set-cookie')!.split(';')[0];
    await first.arrayBuffer();
    const statuses: number[] = [];
    for (let count = 0; count < 40; count++) {
      const response = await fetch(`${baseUrl}/api/session`, { headers: { 'X-Fixture-IP': 'one' } });
      statuses.push(response.status); await response.arrayBuffer();
    }
    expect(statuses).toContain(429);
    expect(statuses).not.toContain(503);
    expect((await fetch(`${baseUrl}/api/session`, { headers: { 'X-Fixture-IP': 'one', Cookie: cookie } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/session`, { headers: { 'X-Fixture-IP': 'two' } })).status).toBe(200);
  });
});
