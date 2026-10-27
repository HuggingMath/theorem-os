import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig, type WebConfig } from '../apps/web/config';
import { completionMail, mailsCompletion } from '../apps/web/completionMail';
import type { WebRunner } from '../apps/web/runner';
import type { WebRun, WebRunInput, WebSession, WorkerInput, WorkerMessage } from '../apps/web/shared';

const secretKey = 'sk-completion-test-never-publish';
const secretProof = 'theorem example : True := trivial';
const input = (task: string): WebRunInput => ({ providerId: 'openai', apiKey: secretKey, model: 'gpt-6.1-sol', effort: 'xhigh',
  source: 'theorem example : True := by sorry', task, maxTurns: 2, maxRunSeconds: 30, workers: 1, coordination: 'cooperative' });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Tasks named `pass` are accepted at once, `fail` ends with a worker error, anything else waits to be cancelled. */
class ScriptedRunner implements WebRunner {
  async readiness() { return { ready: true, message: 'Test worker ready' }; }
  async run(value: WorkerInput, send: (message: WorkerMessage) => void, signal: AbortSignal) {
    if (value.input.task === 'pass') { send({ type: 'result', result: { status: 'evaluated_passed', proof: secretProof, report: {} } }); return; }
    if (value.input.task === 'fail') { send({ type: 'error', message: 'Model session failed' }); return; }
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  }
}
type Client = { cookie: string; csrf: string };

describe('completion mail content', () => {
  const run = (patch: Partial<WebRun>): WebRun => ({ id: '0f0e-run', title: 'Infinitely   many primes', status: 'completed', phase: 'completed',
    createdAt: '2026-10-27T10:00:00.000Z', updatedAt: '2026-10-27T10:42:00.000Z', finishedAt: '2026-10-27T10:42:00.000Z',
    providerId: 'openai', model: 'gpt-6.1-sol', effort: 'xhigh', environment: 'lean', source: 'theorem secret_source : True := by sorry',
    task: 'Prove it', maxTurns: 2, maxRunSeconds: 30, workers: 1, coordination: 'cooperative', events: [], ...patch } as WebRun);

  it('names the outcome, the time taken and a link back, and leaves out source, proof and key', () => {
    const mail = completionMail(run({ result: { status: 'evaluated_passed', proof: secretProof, report: {} } as WebRun['result'] }),
      'https://app.theoremos.top');
    expect(mail.subject).toBe('TheoremOS · 已通过验收：Infinitely many primes');
    expect(mail.text).toContain('https://app.theoremos.top/?run=0f0e-run');
    expect(mail.text).toContain('用时约 42 分钟');
    expect(mail.text).toContain('Email me when research ends');
    expect(mail.text).not.toMatch(/secret_source|trivial|sk-/u);
    expect(completionMail(run({ status: 'error', phase: 'failed' }), 'https://app.theoremos.top').subject).toContain('运行出错');
  });

  it('mails runs that end on their own, never stopped or restart-interrupted ones', () => {
    expect(mailsCompletion(run({}))).toBe(true);
    expect(mailsCompletion(run({ status: 'error', phase: 'failed' }))).toBe(true);
    expect(mailsCompletion(run({ status: 'cancelled', phase: 'cancelled' }))).toBe(false);
    expect(mailsCompletion(run({ status: 'error', phase: 'interrupted' }))).toBe(false);
  });
});

describe('completion mail delivery', () => {
  let root: string, config: WebConfig, baseUrl: string;
  let service: ReturnType<typeof createWebService>;
  let mail: { to: string; subject?: string; text: string }[];

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-web-completion-'));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
    config = { ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: baseUrl, THEOREMOS_WEB_AUTH: 'email',
      THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'alice@example.org', THEOREMOS_WEB_DATA_ROOT: path.join(root, 'data') }),
      staticRoot: root };
    mail = [];
    service = createWebService(config, new ScriptedRunner(), { mailer: async message => { mail.push(message); }, captchaAnswer: () => '12345' });
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
  const completions = () => mail.filter(item => item.subject?.startsWith('TheoremOS · '));
  async function settle(client: Client, id: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { run } = await (await request(`/api/runs/${id}`, client)).json();
      if (['completed', 'cancelled', 'error'].includes(run.status)) break;
      await tick();
    }
    for (let attempt = 0; attempt < 10; attempt++) await tick();
  }

  it('mails the owner when a run is accepted or fails, and not when the owner stops it', async () => {
    const alice = await login('alice@example.org');
    const passed = (await (await request('/api/runs', alice, input('pass'))).json()).run;
    await settle(alice, passed.id);
    expect(completions()).toEqual([expect.objectContaining({ to: 'alice@example.org', subject: expect.stringContaining('已通过验收') })]);
    expect(completions()[0]!.text).toContain(`/?run=${passed.id}`);
    expect(completions()[0]!.text).not.toMatch(/sk-|trivial/u);

    const failed = (await (await request('/api/runs', alice, input('fail'))).json()).run;
    await settle(alice, failed.id);
    expect(completions().at(-1)!.subject).toContain('运行出错');

    const held = (await (await request('/api/runs', alice, input('hold'))).json()).run;
    await tick();
    await request(`/api/runs/${held.id}/cancel`, alice, {});
    await settle(alice, held.id);
    expect(completions()).toHaveLength(2);
  });

  it('stops mailing once the account turns it off, and reports the choice in the session', async () => {
    const alice = await login('alice@example.org');
    expect((await request('/api/auth/account', alice, { completionEmail: 'no' }, 'PATCH')).status).toBe(400);
    expect((await request('/api/auth/account', { ...alice, csrf: 'wrong' }, { completionEmail: false }, 'PATCH')).status).toBe(403);
    expect((await request('/api/auth/account', alice, { completionEmail: false }, 'PATCH')).status).toBe(200);
    expect((await (await request('/api/session', alice)).json() as WebSession).account).toEqual({ email: 'alice@example.org', completionEmail: false });

    const quiet = (await (await request('/api/runs', alice, input('pass'))).json()).run;
    await settle(alice, quiet.id);
    expect(completions()).toEqual([]);

    expect((await request('/api/auth/account', alice, { completionEmail: true }, 'PATCH')).status).toBe(200);
    expect((await (await request('/api/session', alice)).json() as WebSession).account).toEqual({ email: 'alice@example.org' });
    const loud = (await (await request('/api/runs', alice, input('pass'))).json()).run;
    await settle(alice, loud.id);
    expect(completions()).toHaveLength(1);
  });

  it('refuses the preference to anonymous sessions', async () => {
    const first = await request('/api/session');
    const visitor = { cookie: first.headers.get('set-cookie')!.split(';')[0], csrf: (await first.json() as WebSession).csrfToken };
    expect((await request('/api/auth/account', visitor, { completionEmail: false }, 'PATCH')).status).toBe(401);
  });
});
