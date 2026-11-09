#!/usr/bin/env bun
// Statement decisions survive navigation; all jobs and evidence are disposable fixtures, with no model or Lean.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { localeStorageKey } from '../apps/web/i18n';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WorkerFormalizationInput, WorkerFormalizationMessage } from '../apps/web/formalizationTypes';
import { webFormalizationEvidence, webFormalizationStatement } from '../tests/helpers/webFormalizationFixture';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/frontend-round3/workbench');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT || path.join(root, 'out/web');
await fs.mkdir(output, { recursive: true });
await fs.access(path.join(staticRoot, 'app.js'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round3-workbench-'));
type Formalization = { input: WorkerFormalizationInput; send(message: WorkerFormalizationMessage): void; finish(): void };
const pending: Formalization[] = [], runs: string[] = [], finishRuns: (() => void)[] = [];
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local statement decision fixture' }; },
  formalize(input, send, signal) {
    return new Promise<void>(resolve => {
      pending.push({ input, send, finish: resolve });
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  run(input, send, signal) {
    runs.push(input.id);
    send({ type: 'progress', event: 'solve_started', message: 'Local decision fixture' });
    return new Promise<void>(resolve => {
      finishRuns.push(resolve); signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: temporary }), runner);
const checks: object[] = [], errors: string[] = [], external: string[] = [];
let browser: Browser | undefined, active: Page | undefined, current = '';
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) { assert.ok(Date.now() < deadline, current); await new Promise(resolve => setTimeout(resolve, 30)); }
}
async function history(page: Page) {
  if (!await page.locator('#open-draft').isVisible()) await page.locator('#open-history').click();
}
async function closeOutput(page: Page) {
  if (await page.locator('#close-research-output').isVisible()) await page.locator('#close-research-output').click();
}
async function key(page: Page) {
  if (!await page.locator('#formalize-key').isVisible()) await page.locator('#formalize-settings summary').click();
  await page.locator('#formalize-key').fill('sk-round3-disposable-fixture');
  if (await page.locator('#formalize-environment').isEnabled()) await page.locator('#formalize-environment').selectOption('standard');
  await page.locator('#formalize-settings summary').click();
}
async function create(page: Page, original: string, approved: boolean) {
  const before = pending.length;
  await page.locator('#formalize-original').fill(original);
  await key(page);
  await page.locator('#formalize-start:enabled').click();
  await eventually(() => pending.length === before + 1);
  const job = pending.at(-1)!;
  if (approved) job.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(job.input) });
  else job.send({ type: 'result', status: 'error', reason: 'formalization_fixture_failed' });
  job.finish(); await closeOutput(page);
  await page.locator(approved ? '[data-chat-statement-decision]' : '[data-formalization-failure]').waitFor();
  return { id: new URL(page.url()).searchParams.get('chat')!, formalizationId: job.input.id };
}
async function screenshot(page: Page, file: string) {
  await settled(page); await page.screenshot({ path: path.join(output, file) });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  for (const node of await page.locator('[data-chat-awaiting]:visible').all()) {
    const box = await node.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= page.viewportSize()!.width + 1);
  }
}
try {
  browser = await startBrowser(service.server, port);
  for (const [locale, width, height] of [['zh', 1440, 900], ['zh', 390, 844], ['zh', 320, 568], ['en', 390, 844], ['en', 320, 568]] as const) {
    current = `${locale}/${width}`;
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, locale]);
    const page = await context.newPage(); active = page; page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(`${current}: ${error.message}`));
    const requests: { method: string; path: string }[] = [];
    let rejectResearch = true;
    await context.route(/^https?:\/\//u, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.origin); await route.abort(); return; }
      if (url.pathname.startsWith('/api/')) requests.push({ method: request.method(), path: url.pathname });
      if (request.method() === 'POST' && url.pathname.endsWith('/research') && rejectResearch) {
        rejectResearch = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Local research startup failure' }) });
        return;
      }
      await route.continue();
    });
    await page.goto(origin); await page.locator('[data-chat-participation]').waitFor();
    const beforeRuns = runs.length;
    const review = await create(page, webFormalizationStatement, true);
    await page.locator('#topbar-draft').click();
    const failed = await create(page, 'A statement that the local fixture deliberately cannot formalize.', false);
    await page.locator('#topbar-draft').click(); await history(page);
    const reviewRow = page.locator(`[data-chat-row="${review.id}"]`), failedRow = page.locator(`[data-chat-row="${failed.id}"]`);
    const statementLabel = locale === 'zh' ? '等你确认题意' : 'Confirm the statement';
    const researchLabel = locale === 'zh' ? '继续拟定研究计划' : 'Continue to the research plan';
    assert.equal(await reviewRow.locator('[data-chat-awaiting]').innerText(), statementLabel);
    assert.equal(await failedRow.locator('[data-chat-awaiting]').count(), 0);
    assert.equal(await page.locator('[data-chat-row]').first().getAttribute('data-chat-row'), review.id,
      'The older waiting statement precedes the newer failed conversation');
    assert.equal(runs.length, beforeRuns, 'Reading a waiting decision does not start proof');
    await screenshot(page, `waiting-${locale}-${width}.png`);
    await page.locator('[data-chat-search]').fill('deliberately');
    assert.equal(await page.locator('[data-chat-waiting]').count(), 0, 'Search does not show an unrelated waiting group');
    await page.locator('[data-chat-search]').fill('');
    await reviewRow.locator('.chat-history-item').click();
    await page.locator('[data-chat-confirm-statement]').waitFor();
    await key(page); await page.locator('[data-chat-confirm-statement]').click();
    await page.waitForFunction(() => document.querySelector('[data-chat-confirm-statement]')?.textContent?.includes('继续')
      || document.querySelector('[data-chat-confirm-statement]')?.textContent?.includes('Continue'));
    await page.locator('#topbar-draft').click(); await history(page);
    assert.equal(await reviewRow.locator('[data-chat-awaiting]').innerText(), researchLabel,
      'Confirmed statements offer continuation rather than another statement confirmation');
    await screenshot(page, `confirmed-${locale}-${width}.png`);
    await page.reload(); await page.locator('[data-chat-participation]').waitFor(); await history(page);
    assert.equal(await reviewRow.locator('[data-chat-awaiting]').innerText(), researchLabel, 'The server lifecycle survives reload');
    assert.equal(await failedRow.locator('[data-chat-awaiting]').count(), 0);
    await reviewRow.locator('.chat-history-item').click(); await page.locator('[data-chat-confirm-statement]').waitFor();
    await key(page); await page.locator('[data-chat-confirm-statement]').click();
    await eventually(() => runs.length === beforeRuns + 1);
    await page.locator('[data-chat-plan-decision]').waitFor(); await closeOutput(page);
    await page.locator('#topbar-draft').click(); await history(page);
    assert.equal(await reviewRow.locator('[data-chat-awaiting]').count(), 0, 'An attached proof run is not a pending statement decision');
    assert.equal(await page.locator('[data-chat-waiting]').count(), 0);
    assert.equal(requests.filter(item => item.method === 'POST' && item.path.endsWith('/confirm')).length, 1,
      'Reopening a confirmed statement does not confirm it twice');
    assert.equal(requests.filter(item => item.method === 'POST' && item.path.endsWith('/research')).length, 2,
      'Only the explicit attempts start research');
    await screenshot(page, `started-${locale}-${width}.png`);
    checks.push({ locale, width, height, review: review.id, failed: failed.id, requests });
    finishRuns.pop()?.();
    await context.close(); console.log(`PASS ${current}: waiting statement, failure exclusion, confirmed continuation and started cleanup`);
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, paidModelCalls: false, leanProcesses: 0 }, null, 2));
} catch (error) {
  await active?.screenshot({ path: path.join(output, 'regression-failure.png') }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', current, checks, error: String(error), errors,
    external, state: await active?.evaluate(() => ({ history: document.querySelector('#chat-history-list')?.innerHTML })).catch(() => null),
    formalizations: active ? await (await active.request.get(origin + '/api/formalizations')).json().catch(() => null) : null,
    paidModelCalls: false, leanProcesses: 0 }, null, 2));
  throw error;
} finally {
  for (const job of pending) job.finish(); for (const finish of finishRuns) finish();
  await browser?.close(); await service.close(); await fs.rm(temporary, { recursive: true, force: true });
}
