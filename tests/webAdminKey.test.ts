import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput, WebSession, WorkerInput, WorkerMessage } from '../apps/web/shared';

const heldKey = 'sk-server-held-admin-key-never-publish';
const env = (extra: Record<string, string> = {}) => ({ THEOREMOS_WEB_PUBLIC_URL: 'http://127.0.0.1:8787', THEOREMOS_WEB_AUTH: 'email',
  THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ADMINS: 'admin@example.org', ...extra });

describe('admin keys held by the server', () => {
  it('needs admins, known providers and valid keys, and never names the key in an error', () => {
    expect(readWebConfig(env({ THEOREMOS_WEB_ADMIN_KEYS: JSON.stringify({ sub2api: heldKey }) })).adminKeys).toEqual({ sub2api: heldKey });
    expect(readWebConfig(env()).adminKeys).toBeUndefined();
    const failure = (extra: Record<string, string>) => { try { readWebConfig(extra); return ''; } catch (error) { return (error as Error).message; } };
    expect(failure({ ...env(), THEOREMOS_WEB_ADMINS: '', THEOREMOS_WEB_ADMIN_KEYS: JSON.stringify({ sub2api: heldKey }) })).toMatch(/THEOREMOS_WEB_ADMINS/u);
    expect(failure(env({ THEOREMOS_WEB_ADMIN_KEYS: JSON.stringify({ elsewhere: heldKey }) }))).toMatch(/unknown provider: elsewhere/u);
    expect(failure(env({ THEOREMOS_WEB_ADMIN_KEYS: JSON.stringify({ sub2api: 'short' }) }))).toMatch(/invalid key for sub2api/u);
    expect(failure(env({ THEOREMOS_WEB_ADMIN_KEYS: `{"sub2api": "${heldKey}"` }))).toMatch(/JSON object/u);
    for (const extra of [{ sub2api: `${heldKey} x` }, { openai: heldKey, nowhere: heldKey }])
      expect(failure(env({ THEOREMOS_WEB_ADMIN_KEYS: JSON.stringify(extra) }))).not.toContain(heldKey);
  });
});

class RecordingRunner implements WebRunner {
  keys: string[] = [];
  async readiness() { return { ready: true, message: 'Test worker ready' }; }
  async run(value: WorkerInput, send: (message: WorkerMessage) => void) {
    this.keys.push(value.input.apiKey);
    send({ type: 'result', result: { status: 'evaluated_passed', proof: 'theorem example : True := trivial', report: {} } });
  }
}
type Client = { cookie: string; csrf: string };

describe('submitting with the admin key', () => {
  let root: string, baseUrl: string, runner: RecordingRunner;
  let service: ReturnType<typeof createWebService>;
  let mail: { to: string; text: string }[];
  const input = (providerId: string, apiKey: string): WebRunInput => ({ providerId, apiKey, model: 'deepseek-v4-flash', effort: 'high',
    source: 'theorem example : True := by sorry', task: 'Prove the theorem', maxTurns: 2, maxRunSeconds: 30, workers: 1, coordination: 'cooperative' });

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-web-admin-key-'));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
    const config = { ...readWebConfig({ ...env({ THEOREMOS_WEB_ALLOWLIST: 'bob@example.org', THEOREMOS_WEB_ADMIN_KEYS: JSON.stringify({ sub2api: heldKey }),
      THEOREMOS_WEB_DATA_ROOT: path.join(root, 'data') }), THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: baseUrl }), staticRoot: root };
    runner = new RecordingRunner(); mail = [];
    service = createWebService(config, runner, { mailer: async message => { mail.push(message); }, captchaAnswer: () => '12345' });
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
  });
  afterEach(async () => {
    await service?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function request(route: string, client?: Client, body?: unknown) {
    return fetch(`${baseUrl}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function login(email: string): Promise<Client> {
    const first = await request('/api/session');
    const anonymous = { cookie: first.headers.get('set-cookie')!.split(';')[0], csrf: (await first.json() as WebSession).csrfToken };
    const { id } = await (await request('/api/auth/captcha', anonymous, {})).json();
    expect((await request('/api/auth/code', anonymous, { email, captchaId: id, captcha: '12345' })).status).toBe(200);
    const verified = await request('/api/auth/verify', anonymous, { email, code: mail.at(-1)!.text.match(/\b\d{6}\b/u)![0] });
    return { cookie: verified.headers.get('set-cookie')!.split(';')[0], csrf: (await verified.json()).csrfToken };
  }
  const settle = async () => { for (let attempt = 0; attempt < 20; attempt++) await new Promise<void>(resolve => setImmediate(resolve)); };
  /** Every byte the service wrote to its data directory. */
  const stored = (directory = path.join(root, 'data')): string => fs.readdirSync(directory, { withFileTypes: true }).map(entry =>
    entry.isDirectory() ? stored(path.join(directory, entry.name)) : fs.readFileSync(path.join(directory, entry.name), 'utf8')).join('\n');

  it('tells only the admin which providers the server holds a key for, never the key', async () => {
    const admin = await login('admin@example.org'), bob = await login('bob@example.org');
    const adminSession = await (await request('/api/session', admin)).text();
    expect(JSON.parse(adminSession).account).toEqual({ email: 'admin@example.org', admin: true, serverKeys: ['sub2api'], passwordSet: false, passwordResetAllowed: true });
    expect(adminSession).not.toContain(heldKey);
    expect((await (await request('/api/session', bob)).json() as WebSession).account).toEqual({ email: 'bob@example.org', passwordSet: false, passwordResetAllowed: true });
  });

  it('fills in the held key for an admin who leaves the field empty, and keeps it out of every record', async () => {
    const admin = await login('admin@example.org');
    const created = await request('/api/runs', admin, input('sub2api', ''));
    expect(created.status).toBe(201);
    const { run } = await created.json();
    await settle();
    expect(runner.keys).toEqual([heldKey]);
    const detail = await (await request(`/api/runs/${run.id}`, admin)).text();
    expect(JSON.parse(detail).run.result.status).toBe('evaluated_passed');
    expect(detail).not.toContain(heldKey);
    expect(stored()).not.toContain(heldKey);

    // A key the admin types wins over the held one.
    expect((await request('/api/runs', admin, input('sub2api', 'sk-typed-by-admin-1234'))).status).toBe(201);
    await settle();
    expect(runner.keys.at(-1)).toBe('sk-typed-by-admin-1234');
  });

  it('refuses an empty key from other accounts and for providers without a held key', async () => {
    const admin = await login('admin@example.org'), bob = await login('bob@example.org');
    const refused = await request('/api/runs', bob, input('sub2api', ''));
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe('请填写 API Key。');
    expect((await request('/api/runs', admin, input('openai', ''))).status).toBe(400);
    expect((await request('/api/runs', admin, input('sub2api', 'short'))).status).toBe(400);
    expect(runner.keys).toEqual([]);
  });
});
