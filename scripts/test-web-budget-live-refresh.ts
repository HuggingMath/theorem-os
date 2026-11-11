#!/usr/bin/env bun
// Disposable localhost data and recorded runs only. No model, Lean, mail or production calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput, WorkerMessage } from '../apps/web/shared';
import { readingRun } from '../tests/helpers/shareReadingFixture';
import { freePort, startBrowser, waitForRun } from './web-scenario';
import { closeSettings } from './web-ui-controls';
import { localeStorageKey } from '../apps/web/i18n';
import { mathDigest } from '../src/math/mathRuntimeIo';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-gaps/budget');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-budget-refresh-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let phase = 'setup', failure: unknown, active: Page | undefined, recordedRuns = 0, prechecks = 0, prohibited = 0;
const checks: object[] = [], errors: string[] = [], external: string[] = [];
const held = new Map<string, { send(value: WorkerMessage): void; observation: NonNullable<ReturnType<typeof readingRun>['observation']> }>();
const deny = async () => { prohibited++; throw new Error('No real model, Lean, mail or external calls'); };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Recorded budget refresh fixture' }; },
  async run(input, send, signal) {
    recordedRuns++; const record = readingRun(input.id);
    record.observation!.sequence = 1; record.observation!.snapshot.stateDigest = mathDigest(input.id + ':1');
    record.observation!.inspection.usage = { totalTokens: 1200 };
    send({ type: 'progress', event: 'solve_started', message: 'Recorded solve state' });
    send({ type: 'observation', observation: record.observation! });
    if (input.input.model === 'live-budget-model') {
      held.set(input.id, { send, observation: record.observation! });
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    } else send({ type: 'result', result: record.result! });
  },
  async check(input) { prechecks++; return { exitCode: 0, timedOut: false, output: '', checkedTarget: input.candidateTarget?.name }; },
  explain: deny, formalize: deny,
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner, { sample: null, mailer: deny });
const browser = await startBrowser(service.server, port);
async function http(page: Page, method: string, pathname: string, input?: unknown) {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${body.error}`); return body;
  }, { method, pathname, input });
}
const fit = async (page: Page) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page overflow');
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ key, language }) => localStorage.setItem(key, language), { key: localeStorageKey, language });
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(22000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/workspace.html?tab=usage'); await page.locator('[data-workspace-page]').waitFor();
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const session = await http(page, 'GET', '/api/session'), provider = session.providers[0];
    const input: WebRunInput = { providerId: provider.id, apiKey: 'sk-disposable-unused', model: 'first-priced-model', effort: 'high',
      environment: 'standard', source: readingRun().source.trim() + `\n-- first-${language}`, task: 'First model record',
      maxTurns: 3, maxRunSeconds: 180, maxTotalTokens: 50000, workers: 1, coordination: 'independent' };
    const first = service.jobs.create(owner, input, provider); await waitForRun({ page }, first.id, run => run.status === 'completed');
    phase = `stable-price-control-${language}`;
    await page.reload(); await page.locator('[data-workspace-page]').waitFor();
    const rates = page.locator('.research-panel').filter({ has: page.locator('h2', { hasText: language === 'zh' ? '模型单价' : 'Model rates' }) });
    await rates.locator('details > summary').click();
    const model = rates.locator('select').nth(0), currency = rates.locator('select').nth(1), price = rates.locator('input[type=number]');
    await price.fill('7'); await currency.selectOption('USD');
    assert.match(await model.locator('option:checked').innerText(), /first-priced-model/u);
    const initialLedgerRefresh = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/research/workspace/usage');
    await rates.locator('button[type=submit]').click();
    await initialLedgerRefresh;
    await page.waitForFunction(async () => (await (await fetch('/api/research/workspace/rates')).json()).items.some((item: { model: string; perMillion: number }) => item.model === 'first-priced-model' && item.perMillion === 7));
    await page.waitForFunction(() => (document.querySelector('.research-form input[type=number]') as HTMLInputElement | null)?.value === '');
    await price.fill('13'); const stableSelection = await model.inputValue();
    phase = `price-target-kept-through-poll-${language}`;
    const second = service.jobs.create(owner, { ...input, source: input.source + '\n-- second source', model: 'newly-arrived-model', task: 'New model record' }, provider);
    await waitForRun({ page }, second.id, run => run.status === 'completed');
    await model.locator('option', { hasText: 'newly-arrived-model' }).waitFor({ state: 'attached' });
    assert.equal(await model.inputValue(), stableSelection); assert.match(await model.locator('option:checked').innerText(), /first-priced-model/u);
    assert.equal(await price.inputValue(), '13'); assert.equal(await currency.inputValue(), 'USD');
    await fit(page); await rates.screenshot({ path: path.join(output, `rate-target-preserved-${language}.png`) });
    const saving = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/research/workspace/rates');
    await rates.locator('button[type=submit]').click(); const savedResponse = await saving; assert.equal(savedResponse.status(), 200);
    const posted = JSON.parse(savedResponse.request().postData()!);
    assert.equal(posted.model, 'first-priced-model'); assert.equal(posted.providerId, provider.id); assert.equal(posted.perMillion, 13); assert.equal(posted.currency, 'USD');
    const savedRates = (await http(page, 'GET', '/api/research/workspace/rates')).items;
    assert.equal(savedRates.find((item: { model: string }) => item.model === 'first-priced-model').perMillion, 13);
    assert.ok(!savedRates.some((item: { model: string }) => item.model === 'newly-arrived-model'));
    await model.selectOption({ label: `newly-arrived-model · ${provider.id}` }); assert.equal(await price.inputValue(), '');
    checks.push({ id: 'A2-stable-model-identity-and-unsaved-rate', language, width, stableSelection, saved: posted, deliberateSwitchClearsRate: true });

    phase = `live-budget-initial-${language}`;
    const live = service.jobs.create(owner, { ...input, model: 'live-budget-model', source: input.source + '\n-- live budget', task: 'Live budget continuation' }, provider);
    await waitForRun({ page }, live.id, run => run.status === 'running' && Boolean(run.observation));
    await http(page, 'PUT', '/api/research/workspace/rates', { providerId: provider.id, model: 'live-budget-model', perMillion: 1, currency: 'CNY', requestId: crypto.randomUUID() });
    const budgetEndpoint = `/api/research/workspace/problem/${live.id}/budget`;
    await http(page, 'PUT', budgetEndpoint, { requestId: crypto.randomUUID(), expectedRevision: 0, currency: 'CNY', amountLimit: 0.02, tokenLimit: 20000 });
    await page.goto(`${origin}/problem.html?run=${live.id}&tab=outcomes`); await page.locator('[data-budget-next-tokens]').fill('10000');
    await page.locator('[data-prepare-budget-attempt]').click(); await page.locator('[data-budget-attempt-ready=true]').waitFor(); await closeSettings(page);
    const draft = page.locator('#research-budget-draft'); await draft.locator('[data-budget-forecast]').waitFor();
    const initialText = await draft.innerText(), initialUpdatedAt = await draft.locator('[data-budget-updated-at]').getAttribute('datetime');
    assert.match(initialText, /1200 Token/u); assert.match(initialText, /CNY 0\.0012/u); assert.match(initialText, /CNY 0\.0188/u);
    assert.ok(initialUpdatedAt); assert.equal(await draft.locator('[data-budget-exceeded]').count(), 0);
    const timeBounds = await draft.locator('[data-budget-updated-at]').boundingBox(), refreshBounds = await draft.locator('[data-refresh-budget]').boundingBox();
    assert.ok(timeBounds && refreshBounds);
    assert.ok(refreshBounds.x >= timeBounds.x + timeBounds.width + 8 || refreshBounds.y >= timeBounds.y + timeBounds.height,
      'Refresh action is separated from the timestamp, or wraps onto another line');
    const running = held.get(live.id)!, updated = structuredClone(running.observation);
    updated.sequence = 2; updated.snapshot.stateDigest = mathDigest(live.id + ':2'); updated.observedAt = new Date().toISOString(); updated.inspection.usage = { totalTokens: 19000 };
    running.send({ type: 'observation', observation: updated });
    phase = `budget-automatically-updated-${language}`;
    await draft.locator('[data-budget-exceeded]').waitFor();
    const polledText = await draft.innerText(), polledUpdatedAt = await draft.locator('[data-budget-updated-at]').getAttribute('datetime');
    assert.match(polledText, language === 'zh' ? /1\.9 万 Token/u : /19K Token/u); assert.match(polledText, /1000 Token/u);
    assert.match(polledText, /CNY 0\.0190/u); assert.match(polledText, /CNY 0\.0010/u); assert.ok(polledUpdatedAt && polledUpdatedAt > initialUpdatedAt);
    await fit(page); await draft.screenshot({ path: path.join(output, `budget-automatically-updated-${language}.png`) });
    checks.push({ id: 'A6-live-usage-refreshes-totals-balances-and-forecast', language, width, initialText, polledText, initialUpdatedAt, polledUpdatedAt });

    phase = `budget-manual-refresh-${language}`;
    await http(page, 'PUT', budgetEndpoint, { requestId: crypto.randomUUID(), expectedRevision: 1, currency: 'CNY', amountLimit: 0.05, tokenLimit: 50000 });
    await draft.locator('[data-refresh-budget]').click(); await draft.locator('[data-budget-exceeded]').waitFor({ state: 'detached' });
    await draft.locator('[data-research-budget-draft][aria-busy=false]').waitFor();
    const manualText = await draft.innerText(), manualUpdatedAt = await draft.locator('[data-budget-updated-at]').getAttribute('datetime');
    assert.match(manualText, /CNY 0\.0310/u); assert.ok(manualUpdatedAt && manualUpdatedAt > polledUpdatedAt);
    await fit(page); await draft.screenshot({ path: path.join(output, `budget-manually-updated-${language}.png`) });

    phase = `budget-refresh-error-and-recovery-${language}`;
    const budgetRoute = `**${budgetEndpoint}?*`;
    await page.route(budgetRoute, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Recorded temporary budget failure' }) }));
    await draft.locator('[data-refresh-budget]').click(); await draft.getByText('Recorded temporary budget failure', { exact: true }).waitFor();
    assert.match(await draft.innerText(), /CNY 0\.0310/u); assert.equal(await draft.locator('[data-budget-updated-at]').getAttribute('datetime'), manualUpdatedAt);
    assert.equal(await draft.locator('[data-refresh-budget]').isEnabled(), true);
    await page.unroute(budgetRoute); await draft.locator('[data-refresh-budget]').click();
    await draft.getByText('Recorded temporary budget failure', { exact: true }).waitFor({ state: 'detached' });
    await draft.locator('[data-research-budget-draft][aria-busy=false]').waitFor(); assert.match(await draft.innerText(), /CNY 0\.0310/u);
    checks.push({ id: 'A6-manual-refresh-timestamp-error-and-recovery', language, width, manualText, manualUpdatedAt, lastSuccessfulFactsPreservedOn503: true, recovered: true });
    await http(page, 'POST', `/api/runs/${live.id}/cancel`); await context.close();
  }
  assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) {
  failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, recordedRuns, simulatedPrechecks: prechecks,
    prohibited, browserErrors: errors, externalRequests: external, build: JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8')),
    ...(failure ? { error: String(failure) } : {}) }, null, 2) + '\n');
  if (!failure) await fs.rm(path.join(output, 'failure.png'), { force: true });
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Budget live refresh: ${checks.length} workflows passed`);
