#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebRun, WebRunInput, WorkerInput } from '../apps/web/shared';
import { fillConfig, selectHistoryRun, showArtifacts, withSettings } from './web-ui-controls';
import { freePort, postRun, readRun, settled, startBrowser, ready } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-ui-smoke');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the long-run check.'); });
await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const credential = `sk-theoremos-long-run-fixture-${crypto.randomUUID()}`;
const finish = new Map<string, () => void>(), inputs: WorkerInput[] = [];
const runner: WebRunner = {
  async readiness() { return { ready: true, message: '本地长任务验证环境' }; },
  async run(input, send, signal) {
    inputs.push(input);
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      finish.set(input.id, () => {
        send({ type: 'result', result: { status: 'incomplete', proof: '', report: { turns: 2, usage: { totalTokens: 200_000 } } } });
        resolve();
      });
    });
  },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const input = (task: string): WebRunInput => ({ providerId: 'openai', apiKey: credential, model: 'deepseek-flash', effort: 'max',
  environment: 'standard', source: 'theorem fixture : True := by\n  sorry\n', task, maxTurns: 5, maxRunSeconds: 300, workers: 1, coordination: 'cooperative' });
const mark = (check: string) => console.log(`PASS ${check}`);
async function until(page: Page, id: string, done: (run: WebRun) => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) { if (done(await readRun({ page }, id))) return; await page.waitForTimeout(50); }
  throw new Error(`Run ${id} did not settle`);
}
const estimate = (page: Page) => withSettings(page, () => page.locator('#budget-estimate').innerText());
// Headless Chromium has no notification service; record what the page would show.
const notificationFixture = () => {
  const shown: { title: string; body: string }[] = [];
  let permission: NotificationPermission = 'default';
  class FixtureNotification { static get permission() { return permission; }
    static async requestPermission() { permission = 'granted'; return permission; }
    onclick: (() => void) | null = null;
    constructor(title: string, options: NotificationOptions) { shown.push({ title, body: options.body ?? '' }); }
    close() {} }
  Object.assign(window, { Notification: FixtureNotification, __notifications: shown });
};
const setHidden = (page: Page, hidden: boolean) => page.evaluate(hidden => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);
let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
try {
  browser = await startBrowser(service.server, port);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(notificationFixture);
  let page = await context.newPage();
  const errors: string[] = [];
  const watch = (target: Page) => {
    target.on('pageerror', error => errors.push(error.message));
    target.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  };
  watch(page);
  await page.goto(origin);
  await ready(page);

  assert.match(await estimate(page), /最多 5 分钟，全部 Agent 合计 5 轮。/u);
  assert.equal(await withSettings(page, () => page.locator('#budget-estimate').getAttribute('title')), '');
  // New drafts start without a source; the token cap is then the first thing submission stops at.
  await fillConfig(page, 'source', 'theorem long_run_fixture : True := by\n  sorry\n');
  await fillConfig(page, 'max-tokens', '0');
  await page.locator('#task').fill('capped');
  await fillConfig(page, 'api-key', credential);
  await page.locator('#submit-run').click();
  await page.locator('#max-tokens-validation:not([hidden])').waitFor();
  assert.match(await page.locator('#max-tokens-validation').innerText(), /留空表示不限/u);
  await page.locator('#max-tokens').fill('50');
  assert.match(await page.locator('#budget-estimate').innerText(), /最多 5 分钟，全部 Agent 合计 5 轮。.*按已报告用量在 50 万 Token 停止/u);
  await page.screenshot({ path: path.join(output, 'long-run-budget-1440.png') });
  await page.locator('#settings-submit').click();
  await page.locator('body[data-view="run"]').waitFor({ state: 'attached' });
  await showArtifacts(page);
  await page.locator('body[data-view="run"] #detail-panel .result-task').waitFor();
  await page.waitForFunction(() => document.title.startsWith('1 项进行中'));
  const capped = inputs.at(-1)!;
  assert.equal(capped.input.maxTotalTokens, 500_000);
  mark('the settings reject an invalid token cap, show the time, turn and token limits, and send the cap to the worker');

  // The new run's result tab offers the notification while it works.
  await page.locator('#detail-panel [data-action="notify"]').click();
  await page.locator('#detail-panel [data-action="notify"][aria-pressed="true"]').waitFor();
  await setHidden(page, true);
  finish.get(capped.id)!();
  await page.waitForFunction(() => document.title.startsWith('(1) 研究已结束'), undefined, { timeout: 25_000 });
  const shown = await page.evaluate(() => (window as unknown as { __notifications: { title: string; body: string }[] }).__notifications);
  assert.equal(shown.length, 1);
  assert.match(shown[0].title, /TheoremOS · 运行结束/u);
  assert.match(shown[0].body, /capped/u);
  await setHidden(page, false);
  // The count goes once the tab is seen again; the tab keeps the open run's name.
  await page.waitForFunction(() => document.title.endsWith(' · TheoremOS') && !/^\(|项进行中/u.test(document.title));
  mark('a run that ends in a hidden tab sends one desktop notification and marks the tab title until the tab is shown');

  assert.match(await withSettings(page, () => page.locator('#budget-estimate').getAttribute('title')) ?? '', /根据最近 1 次 deepseek-flash 运行，预计约 50 万 Token/u);
  mark('the next estimate uses the tokens per turn of the account\'s finished run on the same model');

  const older = await postRun({ page }, input('older')), away = await postRun({ page }, input('away'));
  await until(page, away.id, run => run.status === 'running');
  await page.reload();
  await ready(page);
  await selectHistoryRun(page, older.id);
  await page.reload();
  await ready(page);
  await page.locator(`.run-row.selected[data-run-id="${older.id}"]`).waitFor({ state: 'attached' });
  mark('a reload reopens the run that was open, not the newest one');

  await page.close();
  finish.get(away.id)!();
  page = await context.newPage();
  watch(page);
  await page.goto(origin);
  await page.locator('#toast:not([hidden])').filter({ hasText: '离开期间「away」已结束' }).waitFor();
  await page.locator(`[data-monitor-run-id="${away.id}"]`).waitFor();
  await settled(page);
  await page.screenshot({ path: path.join(output, 'long-run-away-1440.png') });
  mark('reopening the workbench names the run that ended while it was closed and keeps it in the run monitor');
  finish.get(older.id)!();
  assert.deepEqual(errors, []);
  console.log('Long-run checks passed: token cap and estimate, hidden-tab notification and title, resume selection and runs finished while away.');
} finally {
  await browser?.close();
  await service.close();
}
