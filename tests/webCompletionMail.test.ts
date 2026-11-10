import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig, type WebConfig } from '../apps/web/config';
import { completionMail, mailsCompletion, planApprovalMail } from '../apps/web/completionMail';
import { WebJobs } from '../apps/web/jobs';
import type { WebRunner } from '../apps/web/runner';
import type { WebRun, WebRunInput, WebSession, WorkerInput, WorkerMessage } from '../apps/web/shared';

const secretKey = 'sk-completion-test-never-publish';
const secretProof = 'theorem example : True := trivial';
const input = (task: string): WebRunInput => ({ providerId: 'openai', apiKey: secretKey, model: 'gpt-6.1-sol', effort: 'xhigh',
  source: 'theorem example : True := by sorry', task, maxTurns: 2, maxRunSeconds: 30, workers: 1, coordination: 'cooperative' });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * Tasks named `pass` are accepted at once, `fail` ends with a worker error, `plan` asks for the plan approval and then
 * waits like anything else to be cancelled.
 */
class ScriptedRunner implements WebRunner {
  async readiness() { return { ready: true, message: 'Test worker ready' }; }
  async run(value: WorkerInput, send: (message: WorkerMessage) => void, signal: AbortSignal) {
    if (value.input.task === 'pass') { send({ type: 'result', result: { status: 'evaluated_passed', proof: secretProof, report: {} } }); return; }
    if (value.input.task === 'fail') { send({ type: 'error', message: 'Model session failed' }); return; }
    if (value.input.task === 'plan') send({ type: 'progress', event: 'plan_approval_requested', message: '研究计划等待你批准，Agent 暂不开始工作' });
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

  it('says which limit ended a run that reached no acceptance verdict', () => {
    const subject = (patch: Partial<WebRun>) => completionMail(run(patch), 'https://app.theoremos.top').subject;
    const ended = (result: Partial<NonNullable<WebRun['result']>>, patch: Partial<WebRun> = {}) =>
      run({ result: { status: 'incomplete', proof: '', report: {}, ...result } as WebRun['result'], ...patch });
    expect(subject(ended({ status: 'limit_reached' }))).toBe('TheoremOS · 解题时间用完：Infinitely many primes');
    expect(subject(ended({ status: 'limit_reached' }, { failure: { kind: 'budget', reason: 'math_total_token_limit' } }))).toContain('用量到达上限');
    expect(subject(ended({ report: { stopReason: 'math_turn_limit_reached' } }))).toContain('研究轮次用完');
    expect(subject(ended({ report: { stopReason: 'math_research_routes_exhausted' } }))).toContain('研究路线用尽');
    expect(subject(ended({}))).toContain('已结束');
    const text = (value: WebRun) => completionMail(value, 'https://app.theoremos.top').text;
    expect(text(ended({ status: 'limit_reached' }))).toContain('Your research "Infinitely many primes" used up its solve time.');
    const preparation = ended({ status: 'limit_reached' }, { failure: { kind: 'time_limit', reason: 'math_preparation_stopped' } });
    expect(text(preparation)).toContain('解题没有开始');
    expect(text(preparation)).not.toContain('提高解题预算');
    expect(completionMail(preparation, 'https://app.theoremos.top').subject).toContain('证明环境准备超时');
    // The owner was mailed when the plan was ready; the stop mail says the wait is what used the time.
    const unapproved = ended({ status: 'limit_reached' }, { observation: { inspection: { planApproval: { status: 'pending' } } } as unknown as WebRun['observation'] });
    expect(text(unapproved)).toContain('研究计划直到解题时间用完都没有批准');
    expect(text(unapproved)).not.toMatch(/secret_source|Prove it|sk-/u);
  });

  it('describes a direct formalization without claiming independent semantic review in completion mail', () => {
    const formalization: NonNullable<WebRun['formalization']> = { id: 'formalization-id', evidenceSha256: 'a'.repeat(64),
      original: 'private natural-language original', confirmedAt: '2026-10-27T10:00:00.000Z',
      confirmation: 'automatic', reviewMode: 'direct' };
    const mail = completionMail(run({ formalization, result: { status: 'evaluated_passed', proof: secretProof, report: {} } as WebRun['result'] }),
      'https://app.theoremos.top');
    expect(mail.subject).toContain('Lean 陈述已通过验收');
    expect(mail.text).toContain('原题含义及审核结论请查看形式化记录');
    expect(mail.text).toContain('see the formalization record for its meaning and review results');
    expect(mail.text).not.toContain('模型审核通过'); expect(mail.text).not.toContain('model review passed');
  });

  it.each([
    ['automatic', '模型审核通过，未经人工确认', 'model review passed; not confirmed by a person'],
    ['manual', '你已确认 Lean 陈述', 'you confirmed the Lean statement'],
    [undefined, '未记录确认方式', 'confirmation method was not recorded'],
  ] as const)('keeps Lean acceptance separate from %s meaning confirmation in natural-language completion mail', (confirmation, zh, en) => {
    const formalization: NonNullable<WebRun['formalization']> = { id: 'formalization-id', evidenceSha256: 'a'.repeat(64),
      original: 'private natural-language original', confirmedAt: '2026-10-27T10:00:00.000Z', ...(confirmation ? { confirmation } : {}) };
    const mail = completionMail(run({ formalization, result: { status: 'evaluated_passed', proof: secretProof, report: {} } as WebRun['result'] }),
      'https://app.theoremos.top');
    expect(mail.subject).toBe('TheoremOS · Lean 陈述已通过验收：Infinitely many primes');
    expect(mail.text).toContain('冻结的 Lean 陈述通过独立 Lean 验收');
    expect(mail.text).toContain(zh);
    expect(mail.text).toContain(en);
    expect(mail.text).toContain('Lean 验收不能替代对自然语言原意的核对');
    expect(mail.text).toContain('Lean verification does not replace checking the original natural-language meaning');
    expect(mail.text).not.toMatch(/完整原题通过|private natural-language original|secret_source|trivial|sk-/u);
    if (confirmation !== 'automatic') expect(mail.text).not.toContain('模型审核通过');
    const failed = completionMail(run({ formalization, result: { status: 'evaluated_failed', proof: secretProof, report: {} } as WebRun['result'] }),
      'https://app.theoremos.top');
    expect(failed.subject).toContain('Lean 陈述未通过验收');
    expect(failed.text).toContain(zh);
    expect(failed.text).not.toContain('Lean 陈述通过独立 Lean 验收');
  });

  it('asks to approve a plan with a link back, and leaves out the plan, source and key', () => {
    const mail = planApprovalMail(run({ status: 'running', phase: 'plan_approval_requested', finishedAt: undefined }), 'https://app.theoremos.top');
    expect(mail.subject).toBe('TheoremOS · 研究计划等你批准：Infinitely many primes');
    expect(mail.text).toContain('https://app.theoremos.top/?run=0f0e-run');
    expect(mail.text).toContain('计入解题预算');
    expect(mail.text).toContain('Email me when research ends');
    expect(mail.text).not.toMatch(/secret_source|Prove it|sk-/u);
  });

  it('mails runs that end on their own, never stopped or restart-interrupted ones', () => {
    expect(mailsCompletion(run({}))).toBe(true);
    expect(mailsCompletion(run({ status: 'error', phase: 'failed' }))).toBe(true);
    expect(mailsCompletion(run({ status: 'cancelled', phase: 'cancelled' }))).toBe(false);
    expect(mailsCompletion(run({ status: 'error', phase: 'interrupted' }))).toBe(false);
  });
});

describe('natural-language final event acceptance wording', () => {
  it.each([
    ['automatic', '仅经模型审核，未经人工确认'],
    ['manual', '已由你确认'],
    [undefined, '未记录确认方式'],
  ] as const)('reports Lean acceptance and %s meaning confirmation in the finished event', async (confirmation, meaning) => {
    const jobs = new WebJobs(new ScriptedRunner(), { concurrency: 1, queueLimit: 8 });
    const provider = { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' };
    try {
      const natural = jobs.create('owner', input('pass'), provider, undefined, undefined, { evidence: {}, provenance: {
        id: 'formalization-id', evidenceSha256: 'a'.repeat(64), original: 'private natural-language original',
        confirmedAt: '2026-10-27T10:00:00.000Z', ...(confirmation ? { confirmation } : {}),
      } });
      const direct = jobs.create('owner', input('pass'), provider);
      for (let attempt = 0; attempt < 10 && direct.status !== 'completed'; attempt++) await tick();
      expect(natural.status).toBe('completed');
      const message = natural.events.find(event => event.type === 'finished')?.message;
      expect(message).toContain('Lean 陈述通过独立 Lean 验收');
      expect(message).toContain(meaning);
      expect(message).toContain('Lean 验收不能替代自然语言原意核对');
      expect(message).not.toMatch(/完整原题通过|private natural-language original|trivial|sk-/u);
      if (confirmation !== 'automatic') expect(message).not.toContain('模型审核');
      expect(direct.events.find(event => event.type === 'finished')?.message).toBe('完整原题通过独立 Lean 验收');
    } finally { await jobs.close(); }
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
    expect((await (await request('/api/session', alice)).json() as WebSession).account).toEqual({ email: 'alice@example.org', completionEmail: false, passwordSet: false, passwordResetAllowed: true });

    const quiet = (await (await request('/api/runs', alice, input('pass'))).json()).run;
    await settle(alice, quiet.id);
    expect(completions()).toEqual([]);

    expect((await request('/api/auth/account', alice, { completionEmail: true }, 'PATCH')).status).toBe(200);
    expect((await (await request('/api/session', alice)).json() as WebSession).account).toEqual({ email: 'alice@example.org', passwordSet: false, passwordResetAllowed: true });
    const loud = (await (await request('/api/runs', alice, input('pass'))).json()).run;
    await settle(alice, loud.id);
    expect(completions()).toHaveLength(1);
  });

  it('mails once when a plan waits for approval, under the same preference, and not again when the run is stopped', async () => {
    const alice = await login('alice@example.org');
    const waiting = (await (await request('/api/runs', alice, input('plan'))).json()).run;
    for (let attempt = 0; completions().length === 0 && attempt < 100; attempt++) await tick();
    expect(completions()).toEqual([expect.objectContaining({ to: 'alice@example.org', subject: expect.stringContaining('研究计划等你批准') })]);
    expect(completions()[0]!.text).toContain(`/?run=${waiting.id}`);
    await request(`/api/runs/${waiting.id}/cancel`, alice, {});
    await settle(alice, waiting.id);
    expect(completions()).toHaveLength(1);

    expect((await request('/api/auth/account', alice, { completionEmail: false }, 'PATCH')).status).toBe(200);
    const quiet = (await (await request('/api/runs', alice, input('plan'))).json()).run;
    for (let attempt = 0; attempt < 20; attempt++) await tick();
    await request(`/api/runs/${quiet.id}/cancel`, alice, {});
    await settle(alice, quiet.id);
    expect(completions()).toHaveLength(1);
  });

  it('refuses the preference to anonymous sessions', async () => {
    const first = await request('/api/session');
    const visitor = { cookie: first.headers.get('set-cookie')!.split(';')[0], csrf: (await first.json() as WebSession).csrfToken };
    expect((await request('/api/auth/account', visitor, { completionEmail: false }, 'PATCH')).status).toBe(401);
  });
});
