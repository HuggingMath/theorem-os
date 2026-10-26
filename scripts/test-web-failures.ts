#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebResult, WebRun, WebRunInput } from '../apps/web/shared';
import { selectHistoryRun, showChat } from './web-ui-controls';
import { freePort, postRun, readRun, settled, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-ui-smoke');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the failure check.'); });
await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
// The task text picks the fixture outcome; 'hold' waits until cancelled.
const outcomes: Record<string, WebResult | Error> = {
  auth: { status: 'incomplete', proof: '', report: { failure: { kind: 'authentication', reason: 'math_model_authentication_failed' } } },
  time: { status: 'limit_reached', proof: '', report: { failure: { kind: 'time_limit' } } },
  crash: new Error('运行环境已退出，未返回验收结果。'),
};
const runner: WebRunner = {
  async readiness() { return { ready: true, message: '本地失败状态验证环境' }; },
  async run(input, send, signal) {
    const outcome = outcomes[input.input.task];
    if (outcome instanceof Error) throw outcome;
    if (outcome) { send({ type: 'result', result: outcome }); return; }
    await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '1', THEOREMOS_WEB_QUEUE_LIMIT: '3' }), runner);
const input = (task: string): WebRunInput => ({ providerId: 'openai', apiKey: 'sk-theoremos-failure-fixture', model: 'deepseek-flash',
  effort: 'max', environment: 'standard', source: 'theorem fixture : True := by\n  sorry\n', task,
  maxTurns: 4, maxRunSeconds: 120, workers: 2, coordination: 'cooperative' });
const mark = (check: string) => console.log(`PASS ${check}`);
async function settledRun(page: Page, id: string, done: (run: WebRun) => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = await readRun({ page }, id);
    if (done(run)) return run;
    await page.waitForTimeout(50);
  }
  throw new Error(`Run ${id} did not settle`);
}
async function open(page: Page, id: string) {
  await page.reload();
  await page.locator('#submit-run:enabled').waitFor();
  await selectHistoryRun(page, id);
  await showChat(page);
}
const result = (page: Page) => page.locator('#conversation .chat-result');
let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
try {
  browser = await startBrowser(service.server, port);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/status of 429/u.test(message.text())) errors.push(message.text()); });
  await page.goto(origin);
  await page.locator('#submit-run:enabled').waitFor();

  const holding = await postRun({ page }, input('hold'));
  const queued = await postRun({ page }, input('hold'));
  await postRun({ page }, input('hold'));
  await settledRun(page, holding.id, run => run.status === 'running');
  await open(page, queued.id);
  await result(page).filter({ hasText: '前面还有 0 个任务' }).or(result(page).filter({ hasText: '排在第 1 位' })).waitFor();
  assert.match(await result(page).innerText(), /1\/1 个运行位正在使用/u);
  assert.match(await result(page).locator('h3').innerText(), /排队中 · 第 1 位/u);
  await page.screenshot({ path: path.join(output, 'failure-queue-1440.png') });
  const full = await page.evaluate(async body => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body });
    return { status: response.status, error: (await response.json()).error as string };
  }, JSON.stringify(input('hold')));
  assert.equal(full.status, 429);
  assert.match(full.error, /运行队列已满：1 个任务正在运行，2 个在排队。草稿已保留/u);
  mark('a queued run shows its position and slot use, and a full queue says how many runs are ahead');

  for (const run of (await page.evaluate(async () => (await (await fetch('/api/runs')).json()).runs as WebRun[]))) await page.evaluate(async id => {
    const session = await (await fetch('/api/session')).json();
    await fetch(`/api/runs/${id}/cancel`, { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken } });
  }, run.id);

  const auth = await postRun({ page }, input('auth'));
  await settledRun(page, auth.id, run => run.status === 'completed');
  await open(page, auth.id);
  await result(page).locator('h3', { hasText: 'API Key 未通过认证' }).waitFor();
  assert.equal(await page.locator('[data-recovery]').count(), 1);
  assert.equal(await result(page).getAttribute('class'), 'chat-result failed', 'A failure that needs action is not shown as a neutral end');
  await page.screenshot({ path: path.join(output, 'failure-auth-1440.png') });
  await page.locator('[data-recovery="key"]').click();
  await page.locator('#run-settings[open]').waitFor();
  await settled(page);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'api-key');
  assert.equal(await page.locator('#task').inputValue(), 'auth');
  assert.equal(await page.locator('#api-key').inputValue(), '');
  mark('a rejected API key gets its own title and opens the settings at the key field with the task restored');

  const time = await postRun({ page }, input('time'));
  await settledRun(page, time.id, run => run.status === 'completed');
  await open(page, time.id);
  await result(page).locator('h3', { hasText: '已达到解题时间预算' }).waitFor();
  await page.locator('[data-recovery="budget"]').click();
  await page.locator('#run-settings[open]').waitFor();
  await settled(page);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'max-seconds');
  assert.equal(await page.locator('#max-seconds').inputValue(), '120');
  mark('a time-limited run focuses the time budget');

  const crash = await postRun({ page }, input('crash'));
  await settledRun(page, crash.id, run => run.status === 'error');
  await open(page, crash.id);
  await result(page).locator('h3', { hasText: '运行环境出错' }).waitFor();
  assert.doesNotMatch(await result(page).innerText(), /未返回验收结果/u, 'The guide replaces the operator message');
  assert.equal(await page.locator('[data-recovery="retry"]').count(), 1);
  assert.equal(await page.locator('[data-chat-action="reuse"]').count(), 0, 'Retry replaces the duplicate reuse link');
  mark('a runner crash is shown as an environment error with a retry');

  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 760 });
    await open(page, auth.id);
    await result(page).locator('h3', { hasText: 'API Key 未通过认证' }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Failure card overflows at ${width}px`);
    await page.screenshot({ path: path.join(output, `failure-auth-${width}.png`) });
  }
  mark('the failure card fits 375 and 320 pixel screens');
  assert.deepEqual(errors, []);
  console.log('Failure checks passed: queue position, full queue, authentication, time budget, runner crash and narrow layouts.');
} finally {
  await browser?.close();
  await service.close();
}
