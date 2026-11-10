#!/usr/bin/env bun
// Disposable local identities and recorded runs. No models, Lean or email.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchBudgetView } from '../apps/web/researchBudgetTypes';
import { readingRun } from '../tests/helpers/shareReadingFixture';
import { freePort, startBrowser, waitForRun } from './web-scenario';
import { closeSettings, enterLean } from './web-ui-controls';
import { localeStorageKey } from '../apps/web/i18n';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/post-continuity-20261111/budget');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-budget-post-continuity-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let recordedRuns = 0, prohibited = 0, phase = 'setup', failure: unknown, active: Page | undefined;
const errors: string[] = [], external: string[] = [], checks: object[] = [];
const deny = async () => { prohibited++; throw new Error('No model, compiler or email calls allowed'); };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Recorded budget continuity fixture' }; },
  async run(input, send) {
    recordedRuns++;
    const record = readingRun(input.id);
    send({ type: 'observation', observation: record.observation! });
    send({ type: 'result', result: record.result! });
  },
  check: deny, formalize: deny, explain: deny,
};
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot });
const service = createWebService(config, runner, { sample: null, mailer: deny });
const browser = await startBrowser(service.server, port);
const fit = async (page: Page) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow');
async function budgetRequest(page: Page, runId: string, input?: unknown): Promise<ResearchBudgetView> {
  return page.evaluate(async ({ runId, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(`/api/research/workspace/problem/${runId}/budget`, { method: input === undefined ? 'GET' : 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${body.error}`);
    return body.item;
  }, { runId, input });
}

try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ language, key }) => localStorage.setItem(key, language), { language, key: localeStorageKey });
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/workspace.html?tab=usage`); await page.locator('[data-workspace-page]').waitFor();
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const session = await page.evaluate(async () => (await fetch('/api/session')).json()), provider = session.providers[0];
    const record = readingRun(), source = record.source.trim();
    const input = { providerId: provider.id, apiKey: 'sk-disposable-unused', effort: 'high' as const,
      environment: record.environment, source, task: 'Budget display continuity', maxTurns: 3, maxRunSeconds: 180,
      maxTotalTokens: 50_000, workers: 1, coordination: 'independent' as const };
    const usd = service.jobs.create(owner, { ...input, model: 'usd-history-model' }, provider);
    await waitForRun({ page }, usd.id, run => run.status === 'completed');
    service.research.workspace.saveRate(owner, { requestId: crypto.randomUUID(), providerId: provider.id,
      model: 'usd-history-model', currency: 'USD', perMillion: 100 });
    await budgetRequest(page, usd.id, { requestId: crypto.randomUUID(), expectedRevision: 0,
      currency: 'USD', amountLimit: 20, tokenLimit: 500_000 });

    phase = `single-currency-${language}`;
    await page.goto(`${origin}/problem.html?run=${usd.id}&tab=outcomes`);
    const facts = page.locator('[data-problem-budget-facts]'); await facts.waitFor();
    assert.equal(await facts.locator('[data-budget-spent]').count(), 1);
    assert.match(await facts.locator('[data-budget-spent=USD]').innerText(), /USD 0\.1200/u);
    assert.equal(await facts.locator('[data-budget-currency-scope]').count(), 0);
    checks.push({ id: 'B3-single-currency-control', language, width, text: await facts.innerText() });

    const cny = service.jobs.create(owner, { ...input, model: 'cny-current-model' }, provider);
    await waitForRun({ page }, cny.id, run => run.status === 'completed');
    service.research.workspace.saveRate(owner, { requestId: crypto.randomUUID(), providerId: provider.id,
      model: 'cny-current-model', currency: 'CNY', perMillion: 100 });
    await budgetRequest(page, cny.id, { requestId: crypto.randomUUID(), expectedRevision: 1,
      currency: 'CNY', amountLimit: 20, tokenLimit: 500_000 });
    phase = `mixed-history-${language}`;
    await page.goto(`${origin}/problem.html?run=${cny.id}&tab=outcomes`); await facts.waitFor();
    assert.equal(await facts.locator('[data-budget-spent]').count(), 2);
    assert.match(await facts.locator('[data-budget-spent=CNY]').innerText(), /CNY 0\.1200/u);
    assert.match(await facts.locator('[data-budget-spent=USD]').innerText(), /USD 0\.1200/u);
    assert.match(await facts.locator('[data-budget-currency-scope]').innerText(), language === 'zh' ? /只扣除 CNY/u : /CNY spending only/u);
    assert.match(await facts.innerText(), /CNY 19\.8800/u);
    const api = await budgetRequest(page, cny.id);
    assert.deepEqual(api.spent, { CNY: .12, USD: .12 }); assert.equal(api.remainingAmount, 19.88);
    await fit(page); await facts.screenshot({ path: path.join(output, `mixed-problem-${language}.png`) });
    await page.locator('[data-budget-next-tokens]').fill('100000');
    await page.locator('[data-prepare-budget-attempt]').click();
    await page.locator('[data-budget-attempt-ready=true]').waitFor(); await closeSettings(page);
    const budget = page.locator('#research-budget-draft'), startCost = page.locator('#research-run-cost');
    await budget.locator('[data-budget-forecast]').waitFor();
    assert.equal(await budget.locator('[data-budget-spent]').count(), 2);
    assert.equal(await budget.locator('[data-budget-currency-scope]').count(), 1);
    assert.equal(await startCost.isVisible(), false);
    await fit(page); await budget.screenshot({ path: path.join(output, `mixed-composer-${language}.png`) });
    checks.push({ id: 'B3-mixed-currency-shown-with-balance-scope', language, width, api, text: await budget.innerText() });

    phase = `edited-attempt-${language}`;
    const preparedSource = await page.locator('#source').inputValue(), marker = `REVISED_BUDGET_${language}`;
    const edited = `${preparedSource}\n-- ${marker}\n`;
    await page.locator('#source').fill(edited); await page.locator('#source').blur();
    await startCost.locator('[data-start-cost]').waitFor(); assert.equal(await budget.isVisible(), false);
    await page.locator('#source').fill(preparedSource); await page.locator('#source').blur();
    await budget.locator('[data-budget-forecast]').waitFor(); assert.equal(await startCost.isVisible(), false);
    await page.locator('#source').fill(edited); await page.locator('#source').blur();
    await page.locator('#composer-settings').click();
    await page.locator('#model').fill('edited-model'); await page.locator('#max-tokens').fill('3'); await closeSettings(page);
    await startCost.locator('[data-start-cost]').waitFor();
    await startCost.locator('[data-start-rate] > summary').click();
    await startCost.locator('[data-start-rate-value]').fill('100');
    await startCost.locator('[data-start-rate-currency]').selectOption('USD');
    await startCost.locator('[data-cost-stage=proof]').filter({ hasText: /USD 3\.00/u }).waitFor();
    assert.match(await startCost.locator('[data-cost-stage=proof]').innerText(), /USD 3\.00/u);
    await page.waitForFunction(marker => sessionStorage.getItem('theorem-os.web-draft.v1')?.includes(marker), marker);
    assert.equal(await budget.isVisible(), false);
    await fit(page); await startCost.screenshot({ path: path.join(output, `edited-estimate-${language}.png`) });
    checks.push({ id: 'B2-edit-falls-back-to-working-cost-controls', language, width, sourceIdentityRestoredControl: true,
      amount: await startCost.locator('[data-cost-stage=proof]').innerText(), editedSourcePreserved: (await page.locator('#source').inputValue()) === edited });

    phase = `refresh-attempt-${language}`;
    await page.reload(); await page.waitForFunction(marker => document.querySelector<HTMLTextAreaElement>('#source')?.value.includes(marker), marker);
    await closeSettings(page); await enterLean(page); await startCost.locator('[data-start-cost]').waitFor();
    assert.equal(await page.locator('#source').inputValue(), edited);
    assert.equal(await page.locator('#model').inputValue(), 'edited-model');
    assert.equal(await page.locator('#max-tokens').inputValue(), '3');
    assert.equal(await budget.isVisible(), false);
    checks.push({ id: 'B2-refresh-keeps-edits-and-cost-controls', language, width, source: edited, model: 'edited-model', tokens: '3' });
    await context.close();
  }
  assert.equal(recordedRuns, 4); assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) {
  failure = error;
  if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, recordedRuns,
    prohibited, errors, external, build: JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8')),
    ...(failure ? { error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Budget continuity: ${checks.length} desktop/mobile workflows passed`);
