import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebAdminOverview, WebSession } from '../apps/web/shared';

const runner: WebRunner = { async readiness() { return { ready: true, message: 'Test worker ready' }; }, async run() { /* No run is started here. */ } };
type Client = { cookie: string; csrf: string };

describe('admin accounts manage the allowlist and see beta totals, never other runs', () => {
  let root: string, baseUrl: string, file: string;
  let service: ReturnType<typeof createWebService>;
  let mail: { to: string; text: string }[];

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-web-admin-'));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
    file = path.join(root, 'data', 'allowlist.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# beta testers\nbob@example.org  # from the site form\n');
    const config = { ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: baseUrl, THEOREMOS_WEB_AUTH: 'email',
      THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'carol@example.org', THEOREMOS_WEB_ADMINS: 'Admin@Example.org',
      THEOREMOS_WEB_DATA_ROOT: path.join(root, 'data') }), staticRoot: root };
    mail = [];
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
  async function anonymous(): Promise<Client> {
    const response = await request('/api/session');
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: (await response.json() as WebSession).csrfToken };
  }
  async function login(email: string): Promise<Client> {
    const client = await anonymous();
    const { id } = await (await request('/api/auth/captcha', client, {})).json();
    expect((await request('/api/auth/code', client, { email, captchaId: id, captcha: '12345' })).status).toBe(200);
    const verified = await request('/api/auth/verify', client, { email, code: mail.at(-1)!.text.match(/\b\d{6}\b/u)![0] });
    expect(verified.status).toBe(200);
    return { cookie: verified.headers.get('set-cookie')!.split(';')[0], csrf: (await verified.json()).csrfToken };
  }
  const overview = async (client: Client) => {
    const response = await request('/api/admin/overview', client);
    expect(response.status).toBe(200);
    return await response.json() as WebAdminOverview;
  };
  const session = async (client: Client) => await (await request('/api/session', client)).json() as WebSession;

  it('lets an admin sign in without an allowlist entry and marks only admins in the session', async () => {
    const admin = await login('admin@example.org'), bob = await login('bob@example.org');
    expect((await session(admin)).account).toEqual({ email: 'admin@example.org', admin: true, passwordSet: false, passwordResetAllowed: true });
    expect((await session(bob)).account).toEqual({ email: 'bob@example.org', passwordSet: false, passwordResetAllowed: true });
  });

  it('refuses the admin routes to anonymous sessions and to accounts that are not admins', async () => {
    expect((await request('/api/admin/overview', await anonymous())).status).toBe(403);
    const bob = await login('bob@example.org');
    expect((await request('/api/admin/overview', bob)).status).toBe(403);
    expect((await request('/api/admin/allowlist', bob, { email: 'mallory@example.org' })).status).toBe(403);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('mallory');
  });

  it('lists each address with its source and the accounts with milestones, but no runs', async () => {
    const admin = await login('admin@example.org');
    await login('bob@example.org');
    const view = await overview(admin);
    expect(view.allowlist).toEqual([
      { email: 'admin@example.org', source: 'admin', account: true },
      { email: 'bob@example.org', source: 'file', account: true },
      { email: 'carol@example.org', source: 'config', account: false },
    ]);
    expect(view.accounts.map(account => [account.email, account.admin, account.allowed])).toEqual(expect.arrayContaining([
      ['admin@example.org', true, true], ['bob@example.org', false, true]]));
    expect(view.funnel.map(step => [step.step, step.count])).toEqual([['allowlisted', 3], ['logged_in', 2], ['submitted', 0], ['accepted', 0]]);
    expect(view.editable).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/"(id|runs?|apiKey)"/u);
  });

  it('adds to the allowlist file keeping its comments, and the new address can sign in', async () => {
    const admin = await login('admin@example.org');
    expect((await request('/api/admin/allowlist', admin, { email: 'not an address' })).status).toBe(400);
    expect((await request('/api/admin/allowlist', admin, { email: 'carol@example.org' })).status).toBe(200);
    const added = await request('/api/admin/allowlist', admin, { email: ' Dave@Example.org ' });
    expect(added.status).toBe(200);
    expect((await added.json() as WebAdminOverview).allowlist).toContainEqual({ email: 'dave@example.org', source: 'file', account: false });
    expect(fs.readFileSync(file, 'utf8')).toBe('# beta testers\nbob@example.org  # from the site form\ndave@example.org\n');
    await login('dave@example.org');
    expect(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('removes a file entry and signs that account out at once, but not admin or configured addresses', async () => {
    const admin = await login('admin@example.org'), bob = await login('bob@example.org');
    expect((await request('/api/admin/allowlist', admin, { email: 'admin@example.org' }, 'DELETE')).status).toBe(409);
    expect((await request('/api/admin/allowlist', admin, { email: 'carol@example.org' }, 'DELETE')).status).toBe(409);
    expect((await request('/api/admin/allowlist', admin, { email: 'nobody@example.org' }, 'DELETE')).status).toBe(404);
    const removed = await request('/api/admin/allowlist', admin, { email: 'bob@example.org' }, 'DELETE');
    expect(removed.status).toBe(200);
    const view = await removed.json() as WebAdminOverview;
    expect(view.allowlist.map(entry => entry.email)).not.toContain('bob@example.org');
    expect(view.accounts.find(account => account.email === 'bob@example.org')).toMatchObject({ allowed: false });
    expect(fs.readFileSync(file, 'utf8')).toBe('# beta testers\n');
    expect((await request('/api/runs', bob)).status).toBe(401);
    expect((await request('/api/runs', admin)).status).toBe(200);
  });

  it('needs the CSRF token to change the allowlist', async () => {
    const admin = await login('admin@example.org');
    expect((await request('/api/admin/allowlist', { ...admin, csrf: 'wrong' }, { email: 'eve@example.org' })).status).toBe(403);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('eve');
  });

  it('rejects admins without email login', () => {
    expect(() => readWebConfig({ THEOREMOS_WEB_PUBLIC_URL: 'http://127.0.0.1:8787', THEOREMOS_WEB_ADMINS: 'admin@example.org' }))
      .toThrow(/THEOREMOS_WEB_ADMINS needs email login/u);
  });
});
