// Read-only release review harness. All services and credentials are disposable localhost fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { createWebService } from '../../apps/web/server';
import { readWebConfig } from '../../apps/web/config';
import type { WebRunner } from '../../apps/web/runner';
import type { WebPrecheckOutput } from '../../apps/web/precheck';
import type { WebRunInput, WorkerMessage } from '../../apps/web/shared';
import { freePort, ready } from '../../scripts/web-scenario';
import { fillConfig, withSettings, showChat, selectHistoryRun } from '../../scripts/web-ui-controls';

const root = path.resolve(import.meta.dir, '../..');
const output = import.meta.dir;
const checks: object[] = [];
const fixtureKey = 'sk-local-review-fictional-key';
const input = (task: string): WebRunInput => ({ providerId: 'openai', apiKey: fixtureKey, model: 'fixture', effort: 'low',
  environment: 'standard', source: `theorem ${task.replace(/[^a-zA-Z_]/g, '_')} : True := by sorry`,
  task, maxTurns: 2, maxRunSeconds: 60, workers: 1, coordination: 'cooperative' });
const checkOutput: WebPrecheckOutput = { output: JSON.stringify({ severity: 'warning', kind: 'hasSorry',
  pos: { line: 1, column: 0 }, data: "declaration uses 'sorry'" }), exitCode: 0, timedOut: false };
async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const browser = await chromium.launch({ headless: true });
const contexts: BrowserContext[] = [];
const services: ReturnType<typeof createWebService>[] = [];
async function harness(concurrency: number, queueLimit = 8) {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const mail: { to: string; text: string }[] = [];
  const runs = new Map<string, { signal: AbortSignal; send: (m: WorkerMessage) => void; finish: () => void; fail: () => void }>();
  const compiles = new Map<string, { signal: AbortSignal; finish: () => void }>();
  const runner: WebRunner = {
    async readiness() { return { ready: true, message: 'Local review fixture' }; },
    async run(value, send, signal) {
      await new Promise<void>((resolve, reject) => {
        runs.set(value.id, { signal, send, finish: resolve, fail: () => reject(new Error('Local fixture failure')) });
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
    async check(value, signal) {
      if (!value.source.includes('review_hold')) return checkOutput;
      return new Promise((resolve, reject) => {
        compiles.set(value.source, { signal, finish: () => resolve(checkOutput) });
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
    THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: String(concurrency),
    THEOREMOS_WEB_QUEUE_LIMIT: String(queueLimit), THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:',
    THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org' }), runner,
  { sample: null, mailer: async value => { mail.push(value); }, captchaAnswer: () => '12345' });
  services.push(service);
  await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
  async function login(email = 'alice@example.org', reuse?: BrowserContext) {
    const context = reuse ?? await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 950 } });
    if (!reuse) contexts.push(context);
    if (!reuse) await context.route(/^https?:\/\//, async route => {
      if (new URL(route.request().url()).origin !== origin) throw new Error('Unexpected external browser request');
      await route.continue();
    });
    const request = context.request;
    let session = await (await request.get(origin + '/api/session')).json();
    const headers = () => ({ 'X-CSRF-Token': session.csrfToken, Origin: origin });
    const captcha = await (await request.post(origin + '/api/auth/captcha', { headers: headers(), data: {} })).json();
    const codeResponse = await request.post(origin + '/api/auth/code', { headers: headers(), data: { email, captchaId: captcha.id, captcha: '12345' } });
    assert.equal(codeResponse.status(), 200);
    const code = mail.findLast(item => item.to === email)!.text.match(/\b\d{6}\b/)![0];
    const verified = await request.post(origin + '/api/auth/verify', { headers: headers(), data: { email, code } });
    assert.equal(verified.status(), 200); session = await verified.json();
    return { context, async call(url: string, data?: unknown, extraHeaders = {}) {
      const response = data === undefined ? await request.get(origin + url, { headers: headers() })
        : await request.post(origin + url, { headers: { ...headers(), ...extraHeaders }, data });
      return { status: response.status(), body: await response.json() };
    } };
  }
  return { origin, service, runs, compiles, login };
}
async function form(page: Page, task: string) {
  await showChat(page);
  await withSettings(page, async () => {
    await page.locator('#source').fill(input(task).source);
    await page.locator('#api-key').fill(fixtureKey);
  });
  await page.locator('#task').fill(task);
}
try {
  const h = await harness(2);
  const alice = await h.login(), sameAccount = await h.login(), bob = await h.login('bob@example.org');
  const a = await alice.context.newPage(), b = await sameAccount.context.newPage();
  await a.goto(h.origin); await ready(a); await b.goto(h.origin); await ready(b);
  await withSettings(a, () => a.locator('#source').fill(input('review_hold_A').source));
  await until(() => h.compiles.has(input('review_hold_A').source), 'A compile starts');
  const superseded = a.waitForResponse(r => r.url().endsWith('/api/precheck') && r.status() === 409);
  await withSettings(b, () => b.locator('#source').fill(input('review_hold_B').source));
  await superseded;
  await until(() => h.compiles.has(input('review_hold_B').source), 'B compile starts');
  assert.equal(h.compiles.get(input('review_hold_A').source)!.signal.aborted, true);
  h.compiles.get(input('review_hold_B').source)!.finish();
  await b.locator('#source-check-status').getByText('可编译', { exact: true }).waitFor();
  await withSettings(a, async () => {
    await a.waitForTimeout(1200);
    assert.equal(await a.locator('#recheck-source').isDisabled(), true);
    assert.match(await a.locator('#source-check').innerText(), /正在用 Lean 检查原题/);
    await a.screenshot({ path: path.join(output, 'precheck-stuck.png') });
  });
  checks.push({ name: 'Same account, independent login sessions: B precheck cancels A', result: 'reproduced',
    httpA: 409, aAborted: true, aStillChecking: true, aRecheckDisabled: true, bReady: true });

  await form(a, 'proof_A');
  let posts = 0;
  a.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs') posts++; });
  const submitted = a.waitForResponse(r => r.url().endsWith('/api/runs') && r.request().method() === 'POST');
  await a.evaluate(() => { const form = document.querySelector<HTMLFormElement>('#run-form')!; form.requestSubmit(); form.requestSubmit(); });
  const runA = (await (await submitted).json()).run;
  await a.locator(`[data-run-id="${runA.id}"][aria-pressed="true"]`).waitFor({ state: 'attached' });
  assert.equal(posts, 1);
  await form(b, 'proof_B');
  const submittedB = b.waitForResponse(r => r.url().endsWith('/api/runs') && r.request().method() === 'POST');
  await b.locator('#submit-run').click(); const runB = (await (await submittedB).json()).run;
  await until(() => h.runs.has(runA.id) && h.runs.has(runB.id), 'both workers running');
  assert.equal((await alice.call(`/api/runs/${runA.id}`)).body.run.status, 'running');
  assert.equal((await alice.call(`/api/runs/${runB.id}`)).body.run.status, 'running');
  await a.reload(); await a.locator(`[data-run-id="${runA.id}"][aria-pressed="true"]`).waitFor({ state: 'attached' });
  await selectHistoryRun(a, runB.id); await selectHistoryRun(a, runA.id);
  assert.equal((await sameAccount.call(`/api/runs/${runB.id}/cancel`, {})).body.run.status, 'cancelled');
  await until(() => h.runs.get(runB.id)!.signal.aborted, 'B cancelled');
  assert.equal(h.runs.get(runA.id)!.signal.aborted, false);
  checks.push({ name: 'Two proof runs, double-submit guard, reload selection, switch and cancel B', result: 'passed', postsForDoubleClick: posts,
    simultaneousWorkers: 2, cancelledOnlyB: true });

  const denied: Record<string, number> = {};
  for (const suffix of ['', '/events', '/observation', '/actions', '/trajectory', '/cancel']) {
    const response = await bob.call(`/api/runs/${runA.id}${suffix}`, suffix === '/cancel' ? {} : undefined);
    denied[suffix || '/detail'] = response.status; assert.equal(response.status, 404);
  }
  assert.deepEqual((await bob.call('/api/runs')).body.runs, []);
  checks.push({ name: 'Authenticated second-account reads and cancellation rejected', result: 'passed', statuses: denied });

  await alice.call(`/api/runs/${runA.id}/cancel`, {});
  await form(a, 'lost_response');
  let lostId = '', postCount = 0;
  await a.route('**/api/runs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    postCount++;
    const response = await route.fetch();
    if (postCount === 1) { assert.equal(response.status(), 201); lostId = (await response.json()).run.id; await route.abort('failed'); }
    else await route.fulfill({ response });
  });
  await a.locator('#submit-run').click();
  await a.locator('#form-error').waitFor({ state: 'visible' });
  await until(() => Boolean(lostId), 'accepted lost response');
  await a.locator(`[data-run-id="${lostId}"]`).waitFor({ state: 'attached' });
  await ready(a);
  assert.equal(postCount, 1);
  await a.screenshot({ path: path.join(output, 'lost-response-before-retry.png') });
  const retry = a.waitForResponse(r => r.url().endsWith('/api/runs') && r.request().method() === 'POST');
  await a.locator('#submit-run').click(); const retryId = (await (await retry).json()).run.id;
  assert.notEqual(retryId, lostId);
  await until(() => h.runs.has(lostId) && h.runs.has(retryId), 'duplicate workers');
  checks.push({ name: 'Accepted response lost, GET recovery, then manual unchanged-form retry', result: 'reproduced',
    automaticReplay: false, explicitRetryCreatesSecondRun: true, workerStartsForSameSubmission: 2 });
  await alice.call(`/api/runs/${lostId}/cancel`, {}); await alice.call(`/api/runs/${retryId}/cancel`, {});
  const payload = input('same_idempotency_key');
  const one = await alice.call('/api/runs', payload, { 'Idempotency-Key': 'review-stable-request' });
  const two = await alice.call('/api/runs', payload, { 'Idempotency-Key': 'review-stable-request' });
  assert.equal(one.status, 201); assert.equal(two.status, 201); assert.notEqual(one.body.run.id, two.body.run.id);
  checks.push({ name: 'Repeated POST with identical Idempotency-Key', result: 'reproduced', statuses: [one.status, two.status], distinctRunIds: true });

  const serial = await harness(1, 2), client = await serial.login();
  const first = (await client.call('/api/runs', input('serial_A'))).body.run;
  const second = (await client.call('/api/runs', input('serial_B'))).body.run;
  await until(() => serial.runs.has(first.id), 'serial A starts');
  assert.equal((await client.call(`/api/runs/${second.id}`)).body.run.status, 'queued');
  const page = await client.context.newPage(); await page.goto(serial.origin); await ready(page);
  await form(page, 'queue_full_draft');
  const refused = page.waitForResponse(r => r.url().endsWith('/api/runs') && r.request().method() === 'POST');
  await page.locator('#submit-run').click(); assert.equal((await refused).status(), 429);
  await page.locator('#form-error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#task').inputValue(), 'queue_full_draft');
  assert.equal(await page.locator('#source').inputValue(), input('queue_full_draft').source);
  serial.runs.get(first.id)!.fail();
  await until(() => serial.runs.has(second.id), 'B starts after A failure');
  assert.equal((await client.call(`/api/runs/${first.id}`)).body.run.status, 'error');
  checks.push({ name: 'Concurrency 1, queue cap 2, retained draft on 429, A failure releases B', result: 'passed' });

  await form(page, 'alice_private_draft_fixture');
  await page.locator('#open-account').click();
  await page.locator('#logout').click();
  await page.waitForURL('**/login.html');
  const switched = await serial.login('bob@example.org', client.context);
  await page.goto(serial.origin); await ready(page);
  assert.deepEqual((await switched.call('/api/runs')).body.runs, []);
  assert.equal(await page.locator('#task').inputValue(), 'alice_private_draft_fixture');
  assert.equal(await page.locator('#source').inputValue(), input('alice_private_draft_fixture').source);
  await page.screenshot({ path: path.join(output, 'account-switch-draft.png') });
  checks.push({ name: 'Logout Alice and login Bob in the same tab', result: 'reproduced',
    serverHistoryIsolated: true, aliceDraftRestoredForBob: true, boundary: 'shared browser tab local sessionStorage' });

  await fs.writeFile(path.join(output, 'reproduction-report.json'), JSON.stringify({ baseline: '8261c178ed9f379831606b154c41fbdecca94d57',
    paidModelCalls: false, realLean: false, checkedAt: new Date().toISOString(), checks }, null, 2) + '\n');
  console.log(JSON.stringify(checks, null, 2));
} finally {
  await Promise.all(contexts.map(context => context.close()));
  await Promise.all(services.map(service => service.close()));
  await browser.close();
}
