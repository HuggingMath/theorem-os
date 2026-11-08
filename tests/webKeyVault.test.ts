import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig, type WebConfig } from '../apps/web/config';
import { WebKeyVault } from '../apps/web/keyVault';
import { WebStorage } from '../apps/web/storage';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunRequest, WebSession, WorkerInput, WorkerMessage } from '../apps/web/shared';

const secret = 'a1'.repeat(32), aliceKey = 'sk-alice-saved-key-never-publish-7Q2x';
const env = (extra: Record<string, string> = {}) => ({ THEOREMOS_WEB_PUBLIC_URL: 'http://127.0.0.1:8787', THEOREMOS_WEB_AUTH: 'email',
  THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org', ...extra });

describe('the key vault', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-key-vault-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const sub2api = { id: 'sub2api', baseUrl: 'http://host.docker.internal:8080/v1' };

  it('opens a key only for the account, provider and address it was saved for', () => {
    const storage = new WebStorage(root), vault = new WebKeyVault(Buffer.from(secret, 'hex'), storage);
    vault.save('alice', 'sub2api', sub2api.baseUrl, aliceKey);
    expect(vault.get('alice', 'sub2api', sub2api.baseUrl)).toBe(aliceKey);
    expect(vault.list('alice', [sub2api])).toEqual([{ providerId: 'sub2api', ending: '7Q2x' }]);
    expect(vault.get('bob', 'sub2api', sub2api.baseUrl)).toBeUndefined();
    expect(vault.get('alice', 'sub2api', 'https://elsewhere.example/v1')).toBeUndefined();
    expect(vault.list('alice', [{ ...sub2api, baseUrl: 'https://elsewhere.example/v1' }])).toEqual([]);
    // Alice's sealed record copied over Bob's opens to nothing.
    const file = (account: string) => path.join(root, 'keys', `${crypto.createHash('sha256').update(account).digest('hex')}.json`);
    fs.mkdirSync(path.dirname(file('bob')), { recursive: true });
    fs.copyFileSync(file('alice'), file('bob'));
    expect(vault.get('bob', 'sub2api', sub2api.baseUrl)).toBeUndefined();
    // Another secret opens nothing either.
    expect(new WebKeyVault(crypto.randomBytes(32), storage).get('alice', 'sub2api', sub2api.baseUrl)).toBeUndefined();
    expect(fs.readFileSync(file('alice'), 'utf8')).not.toContain(aliceKey);
    expect(fs.statSync(file('alice')).mode & 0o777).toBe(0o600);
  });

  it('replaces, forgets one provider and forgets the account', () => {
    const vault = new WebKeyVault(Buffer.from(secret, 'hex'), new WebStorage(root)), openai = { id: 'openai', baseUrl: 'https://api.openai.com/v1' };
    vault.save('alice', 'sub2api', sub2api.baseUrl, aliceKey);
    vault.save('alice', 'sub2api', sub2api.baseUrl, 'sk-replacement-0000');
    vault.save('alice', 'openai', openai.baseUrl, 'sk-openai-key-1111');
    expect(vault.list('alice', [sub2api, openai])).toEqual([{ providerId: 'sub2api', ending: '0000' }, { providerId: 'openai', ending: '1111' }]);
    vault.forget('alice', 'sub2api');
    expect(vault.list('alice', [sub2api, openai])).toEqual([{ providerId: 'openai', ending: '1111' }]);
    vault.forgetAccount('alice');
    expect(vault.list('alice', [sub2api, openai])).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'keys'))).toEqual([]);
  });

  it('needs login and 64 hex digits', () => {
    expect(readWebConfig(env({ THEOREMOS_WEB_KEY_SECRET: secret })).keySecret).toEqual(Buffer.from(secret, 'hex'));
    expect(readWebConfig(env()).keySecret).toBeUndefined();
    expect(() => readWebConfig(env({ THEOREMOS_WEB_KEY_SECRET: 'abc' }))).toThrow(/64 hex digits/u);
    expect(() => readWebConfig({ THEOREMOS_WEB_PUBLIC_URL: 'http://127.0.0.1:8787', THEOREMOS_WEB_KEY_SECRET: secret })).toThrow(/AUTH=email/u);
  });
});

class RecordingRunner implements WebRunner {
  keys: string[] = [];
  inputs: unknown[] = [];
  async readiness() { return { ready: true, message: 'Test worker ready' }; }
  async run(value: WorkerInput, send: (message: WorkerMessage) => void) {
    this.keys.push(value.input.apiKey); this.inputs.push(value.input);
    send({ type: 'result', result: { status: 'evaluated_passed', proof: 'theorem example : True := trivial', report: {} } });
  }
}
type Client = { cookie: string; csrf: string };

describe('saving a key to the account', () => {
  let root: string, baseUrl: string, runner: RecordingRunner;
  let config: WebConfig;
  let service: ReturnType<typeof createWebService>;
  let mail: { to: string; text: string }[];
  const input = (apiKey: string, extra: Partial<WebRunRequest> = {}): WebRunRequest => ({ providerId: 'sub2api', apiKey, model: 'deepseek-v4-flash', effort: 'high',
    source: 'theorem example : True := by sorry', task: 'Prove the theorem', maxTurns: 2, maxRunSeconds: 30, workers: 1, coordination: 'cooperative', ...extra });

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-web-saved-key-'));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
    config = { ...readWebConfig({ ...env({ THEOREMOS_WEB_KEY_SECRET: secret, THEOREMOS_WEB_DATA_ROOT: path.join(root, 'data') }),
      THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: baseUrl }), staticRoot: root };
    runner = new RecordingRunner(); mail = [];
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
  async function login(email: string): Promise<Client> {
    const first = await request('/api/session');
    const anonymous = { cookie: first.headers.get('set-cookie')!.split(';')[0], csrf: (await first.json() as WebSession).csrfToken };
    const { id } = await (await request('/api/auth/captcha', anonymous, {})).json();
    expect((await request('/api/auth/code', anonymous, { email, captchaId: id, captcha: '12345' })).status).toBe(200);
    const verified = await request('/api/auth/verify', anonymous, { email, code: mail.at(-1)!.text.match(/\b\d{6}\b/u)![0] });
    return { cookie: verified.headers.get('set-cookie')!.split(';')[0], csrf: (await verified.json()).csrfToken };
  }
  const settle = async () => { for (let attempt = 0; attempt < 20; attempt++) await new Promise<void>(resolve => setImmediate(resolve)); };
  const account = async (client: Client) => (await (await request('/api/session', client)).json() as WebSession).account;
  /** Every byte the service wrote to its data directory. */
  const stored = (directory = path.join(root, 'data')): string => fs.readdirSync(directory, { withFileTypes: true }).map(entry =>
    entry.isDirectory() ? stored(path.join(directory, entry.name)) : fs.readFileSync(path.join(directory, entry.name), 'utf8')).join('\n');

  it('saves and replaces a provider key without starting research, returns only endings and isolates accounts', async () => {
    const alice = await login('alice@example.org'), bob = await login('bob@example.org');
    const saved = await request('/api/auth/keys/sub2api', alice, { apiKey: aliceKey }, 'PUT');
    expect(saved.status).toBe(200);
    const body = await saved.text();
    expect(JSON.parse(body)).toEqual({ savedKeys: [{ providerId: 'sub2api', ending: '7Q2x' }] });
    expect(body).not.toContain(aliceKey);
    expect(runner.keys).toEqual([]);
    expect(service.jobs.counts()).toMatchObject({ running: 0, queued: 0 });
    expect((await account(bob))?.savedKeys).toBeUndefined();

    const bobKey = 'sk-bob-independent-key-1111';
    const bobSaved = await request('/api/auth/keys/sub2api', bob, { apiKey: bobKey }, 'PUT');
    expect(await bobSaved.json()).toEqual({ savedKeys: [{ providerId: 'sub2api', ending: '1111' }] });
    const replacement = 'sk-alice-replacement-key-9999';
    expect((await request('/api/auth/keys/sub2api', alice, { apiKey: replacement }, 'PUT')).status).toBe(200);
    expect((await account(alice))?.savedKeys).toEqual([{ providerId: 'sub2api', ending: '9999' }]);
    expect((await account(bob))?.savedKeys).toEqual([{ providerId: 'sub2api', ending: '1111' }]);
    const again = await login('alice@example.org');
    const session = await (await request('/api/session', again)).text();
    expect(JSON.parse(session).account.savedKeys).toEqual([{ providerId: 'sub2api', ending: '9999' }]);
    for (const key of [aliceKey, replacement, bobKey]) {
      expect(session).not.toContain(key);
      expect(stored()).not.toContain(key);
    }
    expect(runner.keys).toEqual([]);
    // Only explicit research starts the worker, using each account's own saved key.
    expect((await request('/api/runs', again, input(''))).status).toBe(201);
    expect((await request('/api/runs', bob, input(''))).status).toBe(201);
    await settle();
    expect(runner.keys).toEqual([replacement, bobKey]);
    expect((await request('/api/auth/keys/sub2api', bob, undefined, 'DELETE')).status).toBe(200);
    expect((await account(bob))?.savedKeys).toBeUndefined();
    expect((await account(alice))?.savedKeys).toEqual([{ providerId: 'sub2api', ending: '9999' }]);
  });

  it('requires a current signed-in session, CSRF token, current terms and configured provider to save', async () => {
    const first = await request('/api/session');
    const visitor = { cookie: first.headers.get('set-cookie')!.split(';')[0], csrf: (await first.json() as WebSession).csrfToken };
    expect((await request('/api/auth/keys/sub2api', undefined, { apiKey: aliceKey }, 'PUT')).status).toBe(401);
    expect((await request('/api/auth/keys/sub2api', visitor, { apiKey: aliceKey }, 'PUT')).status).toBe(401);
    const alice = await login('alice@example.org');
    expect((await request('/api/auth/keys/sub2api', { ...alice, csrf: 'wrong' }, { apiKey: aliceKey }, 'PUT')).status).toBe(403);
    expect((await request('/api/auth/keys/unknown', alice, { apiKey: aliceKey }, 'PUT')).status).toBe(400);
    config.auth!.termsVersion = 'updated-terms';
    expect((await request('/api/auth/keys/sub2api', alice, { apiKey: aliceKey }, 'PUT')).status).toBe(428);
    expect((await request('/api/auth/terms', alice, { terms: true, termsVersion: 'updated-terms' })).status).toBe(200);
    expect((await request('/api/auth/keys/sub2api', alice, { apiKey: aliceKey }, 'PUT')).status).toBe(200);
    expect((await request('/api/auth/logout', alice, {})).status).toBe(200);
    expect((await request('/api/auth/keys/sub2api', alice, { apiKey: 'sk-stale-session-0000' }, 'PUT')).status).toBe(401);
    expect(runner.keys).toEqual([]);
  });

  it('accepts only a strict body with a nonempty printable ASCII key of 8 to 4096 characters', async () => {
    const alice = await login('alice@example.org');
    for (const body of [{}, { apiKey: '' }, { apiKey: '1234567' }, { apiKey: 'x'.repeat(4097) }, { apiKey: 'contains space' },
      { apiKey: 'sk-key\nnew-line' }, { apiKey: 'sk-key-中文-0000' }, { apiKey: 12345678 }, { apiKey: aliceKey, accountId: 'bob' }]) {
      const response = await request('/api/auth/keys/sub2api', alice, body, 'PUT');
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(aliceKey);
      expect((await account(alice))?.savedKeys).toBeUndefined();
    }
    for (const apiKey of ['12345678', 'x'.repeat(4096)]) {
      const response = await request('/api/auth/keys/sub2api', alice, { apiKey }, 'PUT');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ savedKeys: [{ providerId: 'sub2api', ending: apiKey.slice(-4) }] });
    }
    expect(runner.keys).toEqual([]);
  });

  it('does not save after logout while the request body is still arriving', async () => {
    const alice = await login('alice@example.org');
    const started = new Promise<void>(resolve => service.server.once('request', () => setImmediate(resolve)));
    const upload = http.request(`${baseUrl}/api/auth/keys/sub2api`, { method: 'PUT', headers: {
      Cookie: alice.cookie, 'X-CSRF-Token': alice.csrf, 'Content-Type': 'application/json',
    } });
    const completed = new Promise<{ status?: number; body: string }>((resolve, reject) => {
      upload.on('error', reject);
      upload.on('response', response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
        response.on('error', reject);
      });
    });
    upload.write('{"apiKey":');
    await started;
    expect((await request('/api/auth/logout', alice, {})).status).toBe(200);
    upload.end(JSON.stringify(aliceKey) + '}');
    const response = await completed;
    expect(response.status).toBe(401);
    expect(response.body).not.toContain(aliceKey);
    expect(stored()).not.toContain(aliceKey);
    const vault = new WebKeyVault(Buffer.from(secret, 'hex'), service.storage);
    const account = service.auth!.getAccount('alice@example.org')!;
    expect(vault.list(account.id, config.providers)).toEqual([]);
    expect(runner.keys).toEqual([]);
  });

  it('does not save keys when the vault is disabled', async () => {
    await service.close();
    delete config.keySecret;
    service = createWebService(config, runner, { mailer: async message => { mail.push(message); }, captchaAnswer: () => '12345' });
    await new Promise<void>(resolve => service.server.listen(config.port, '127.0.0.1', resolve));
    const alice = await login('alice@example.org');
    expect((await request('/api/auth/keys/sub2api', alice, { apiKey: aliceKey }, 'PUT')).status).toBe(404);
    expect((await account(alice))?.keyVault).toBeUndefined();
    expect(stored()).not.toContain(aliceKey);
    expect(runner.keys).toEqual([]);
  });

  it('keeps the key for the account that saved it, shows only its ending and reuses it across logins', async () => {
    const alice = await login('alice@example.org'), bob = await login('bob@example.org');
    expect(await account(alice)).toEqual({ email: 'alice@example.org', keyVault: true, passwordSet: false, passwordResetAllowed: true });
    const created = await request('/api/runs', alice, input(aliceKey, { saveKey: true }));
    expect(created.status).toBe(201);
    const body = await created.text();
    expect(JSON.parse(body).savedKeys).toEqual([{ providerId: 'sub2api', ending: '7Q2x' }]);
    expect(body).not.toContain(aliceKey);
    await settle();
    expect(runner.inputs.at(-1)).not.toHaveProperty('saveKey');

    // A new login on another browser gets the ending only and runs with the saved key.
    const again = await login('alice@example.org'), session = await (await request('/api/session', again)).text();
    expect(JSON.parse(session).account.savedKeys).toEqual([{ providerId: 'sub2api', ending: '7Q2x' }]);
    expect(session).not.toContain(aliceKey);
    expect((await request('/api/runs', again, input(''))).status).toBe(201);
    await settle();
    expect(runner.keys).toEqual([aliceKey, aliceKey]);

    // Bob sees nothing of Alice's and still has to type his own.
    expect(await account(bob)).toEqual({ email: 'bob@example.org', keyVault: true, passwordSet: false, passwordResetAllowed: true });
    const refused = await request('/api/runs', bob, input(''));
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe('请填写 API Key。');
    expect(stored()).not.toContain(aliceKey);
  });

  it('saves only when asked, lets a typed key win and replaces the saved one', async () => {
    const alice = await login('alice@example.org');
    expect((await request('/api/runs', alice, input('sk-not-saved-key-5555'))).status).toBe(201);
    expect((await account(alice))?.savedKeys).toBeUndefined();
    await request('/api/runs', alice, input(aliceKey, { saveKey: true }));
    expect((await request('/api/runs', alice, input('sk-typed-once-6666'))).status).toBe(201);
    await settle();
    expect(runner.keys.at(-1)).toBe('sk-typed-once-6666');
    expect((await account(alice))?.savedKeys).toEqual([{ providerId: 'sub2api', ending: '7Q2x' }]);
    await request('/api/runs', alice, input('sk-replacement-key-8888', { saveKey: true }));
    expect((await account(alice))?.savedKeys).toEqual([{ providerId: 'sub2api', ending: '8888' }]);
  });

  it('deletes a saved key on request and with the account', async () => {
    const alice = await login('alice@example.org');
    await request('/api/runs', alice, input(aliceKey, { saveKey: true }));
    expect((await request('/api/auth/keys/sub2api', { ...alice, csrf: 'wrong' }, undefined, 'DELETE')).status).toBe(403);
    const deleted = await request('/api/auth/keys/sub2api', alice, undefined, 'DELETE');
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ savedKeys: [] });
    expect((await request('/api/runs', alice, input(''))).status).toBe(400);

    await request('/api/runs', alice, input(aliceKey, { saveKey: true }));
    expect(fs.readdirSync(path.join(root, 'data', 'keys'))).toHaveLength(1);
    expect((await request('/api/auth/account', alice, { email: 'alice@example.org' }, 'DELETE')).status).toBe(200);
    expect(fs.readdirSync(path.join(root, 'data', 'keys'))).toEqual([]);
  });
});
