#!/usr/bin/env bun
// Disposable localhost records and recorded runner only. No model, Lean, mail or production calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchProblemBudget } from '../apps/web/researchBudgetTypes';
import { readingRun } from '../tests/helpers/shareReadingFixture';
import { freePort, startBrowser, waitForRun } from './web-scenario';
import { localeStorageKey } from '../apps/web/i18n';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/continuity-seven/planning');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-budget-save-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let recordedRuns = 0, prohibited = 0, phase = 'setup', failure: unknown, active: Page | undefined;
const errors: string[] = [], external: string[] = [], checks: object[] = [];
const deny = async () => { prohibited++; throw new Error('No models, Lean, mail or production calls allowed'); };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Recorded budget save fixture' }; },
  async run(input, send) {
    recordedRuns++; const record = readingRun(input.id);
    send({ type: 'observation', observation: record.observation! }); send({ type: 'result', result: record.result! });
  },
  check: deny, formalize: deny, explain: deny,
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
    await context.addInitScript(({ language, key }) => localStorage.setItem(key, language), { language, key: localeStorageKey });
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/workspace.html?tab=usage'); await page.locator('[data-workspace-page]').waitFor();
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const session = await http(page, 'GET', '/api/session'), provider = session.providers[0], record = readingRun();
    const first = service.jobs.create(owner, { providerId: provider.id, apiKey: 'sk-disposable-unused', model: 'fixture-model', effort: 'high',
      environment: record.environment, source: record.source.trim(), task: `Budget save continuity ${language}`, maxTurns: 3,
      maxRunSeconds: 180, maxTotalTokens: 50000, workers: 1, coordination: 'independent' }, provider);
    await waitForRun({ page }, first.id, run => run.status === 'completed');
    const budgetUrl = `/api/research/workspace/problem/${first.id}/budget`;
    await http(page, 'PUT', budgetUrl, { requestId: crypto.randomUUID(), expectedRevision: 0, currency: 'CNY', amountLimit: 20, tokenLimit: 500000 });
    await page.goto(`${origin}/problem.html?run=${first.id}&tab=outcomes`); await page.locator('[data-budget-editor] > summary').click();
    const editor = page.locator('[data-budget-editor]'), tokenInput = editor.locator('[data-budget-token-limit]'), amountInput = editor.locator('[data-budget-amount]');
    const currency = editor.locator('select'), save = editor.locator('[data-save-problem-budget]');
    const formValues = async () => ({ tokenLimit: await tokenInput.inputValue(), amount: await amountInput.inputValue(), currency: await currency.inputValue() });
    const readPlan = async () => (await http(page, 'GET', budgetUrl)).item.plan as ResearchProblemBudget;
    const fill = async (tokens: string, amount: string, money: string) => { await tokenInput.fill(tokens); await amountInput.fill(amount); await currency.selectOption(money); };
    const normalSave = async (revision: number) => {
      const saved = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === budgetUrl);
      await save.click(); const response = await saved; assert.equal(response.status(), 200);
      await editor.locator('[data-budget-unsaved]').waitFor({ state: 'detached' });
      await page.waitForFunction(() => !(document.querySelector('[data-save-problem-budget]') as HTMLButtonElement).disabled);
      const plan = await readPlan(); assert.equal(plan.revision, revision);
      return { plan, posted: response.request().postDataJSON() };
    };

    phase = `normal-save-control-${language}`;
    await fill('600000', '30', 'USD'); const normal = await normalSave(2);
    assert.deepEqual(await formValues(), { tokenLimit: '600000', amount: '30', currency: 'USD' });
    assert.equal(normal.plan.tokenLimit, 600000); assert.equal(normal.plan.amountLimit, 30); assert.equal(normal.plan.currency, 'USD');
    checks.push({ id: 'PL1-unchanged-save-control', language, width, saved: normal.plan });

    phase = `new-edits-during-successful-save-${language}`;
    let release!: () => void, finished!: () => void, received!: (value: { posted: any; status: number; plan: ResearchProblemBudget }) => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const responseFinished = new Promise<void>(resolve => { finished = resolve; });
    const serverSaved = new Promise<{ posted: any; status: number; plan: ResearchProblemBudget }>(resolve => { received = resolve; });
    await page.route(`**${budgetUrl}`, async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      const response = await route.fetch(), body = await response.json();
      received({ posted: route.request().postDataJSON(), status: response.status(), plan: body.item.plan });
      await delayed; await route.fulfill({ response }); finished();
    });
    await fill('700000', '40', 'USD'); await save.click(); const firstSubmission = await serverSaved; assert.equal(firstSubmission.status, 200);
    assert.equal(await save.isDisabled(), true); assert.equal(await tokenInput.isEnabled(), true); assert.equal(await amountInput.isEnabled(), true); assert.equal(await currency.isEnabled(), true);
    await fill('900000', '80', 'CNY'); const newer = await formValues();
    release(); await responseFinished; await page.unroute(`**${budgetUrl}`);
    await editor.locator('[data-budget-unsaved]').waitFor();
    await page.waitForFunction(() => !(document.querySelector('[data-save-problem-budget]') as HTMLButtonElement).disabled);
    assert.deepEqual(await formValues(), newer);
    assert.equal(await editor.locator('[data-budget-revision-conflict]').count(), 0, 'Its own successful response does not require conflict review');
    assert.ok(!(await editor.innerText()).includes(language === 'zh' ? '已保存。' : 'Saved.'), 'A newer draft is not labeled saved');
    const savedWhileEditing = await readPlan(); assert.equal(savedWhileEditing.revision, 3); assert.equal(savedWhileEditing.tokenLimit, 700000); assert.equal(savedWhileEditing.currency, 'USD');
    await fit(page); await editor.screenshot({ path: path.join(output, `newer-budget-edits-preserved-${language}.png`) });
    const nextSave = await normalSave(4); assert.equal(nextSave.posted.expectedRevision, 3); assert.equal(nextSave.plan.tokenLimit, 900000);
    assert.equal(nextSave.plan.amountLimit, 80); assert.equal(nextSave.plan.currency, 'CNY'); assert.notEqual(nextSave.posted.requestId, firstSubmission.posted.requestId);
    checks.push({ id: 'PL1-newer-edits-survive-old-success-and-can-save', language, width, firstSubmission, newer, savedWhileEditing, subsequentSave: nextSave });

    phase = `stale-save-409-keeps-edits-${language}`;
    await fill('1000000', '100', 'USD');
    const other = await context.newPage();
    other.on('pageerror', error => errors.push(error.message));
    await other.goto(`${origin}/problem.html?run=${first.id}&tab=outcomes`);
    const remote = (await http(other, 'PUT', budgetUrl, { requestId: crypto.randomUUID(), expectedRevision: 4, currency: 'USD', amountLimit: 50, tokenLimit: 650000 })).item.plan;
    assert.equal(remote.revision, 5);
    let releaseConflict!: () => void, conflictFinished!: () => void, gotConflict!: (value: { status: number; posted: any }) => void;
    const delayedConflict = new Promise<void>(resolve => { releaseConflict = resolve; });
    const conflictResponseFinished = new Promise<void>(resolve => { conflictFinished = resolve; });
    const serverConflict = new Promise<{ status: number; posted: any }>(resolve => { gotConflict = resolve; });
    await page.route(`**${budgetUrl}`, async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      const response = await route.fetch(); gotConflict({ status: response.status(), posted: route.request().postDataJSON() });
      await delayedConflict; await route.fulfill({ response }); conflictFinished();
    });
    await save.click(); const rejected = await serverConflict; assert.equal(rejected.status, 409); assert.equal(rejected.posted.expectedRevision, 4);
    await fill('1200000', '120', 'CNY'); const afterConflictEdit = await formValues();
    releaseConflict(); await conflictResponseFinished; await page.unroute(`**${budgetUrl}`);
    await editor.locator('[data-budget-revision-conflict]').waitFor(); await editor.locator('[role=alert]').waitFor();
    assert.deepEqual(await formValues(), afterConflictEdit); assert.equal(await save.isDisabled(), true);
    assert.match(await editor.locator('[data-budget-latest-plan]').innerText(), /USD 50/u);
    assert.match(await editor.locator('[data-budget-latest-plan]').innerText(), language === 'zh' ? /65 万 Token/u : /650K Token/u);
    await fit(page); await editor.screenshot({ path: path.join(output, `stale-budget-rejected-edits-kept-${language}.png`) });
    await editor.locator('[data-review-budget-revision]').click();
    await editor.locator('[data-budget-revision-conflict]').waitFor({ state: 'detached' });
    assert.deepEqual(await formValues(), afterConflictEdit); assert.equal(await save.isEnabled(), true);
    const reviewedSave = await normalSave(6); assert.equal(reviewedSave.posted.expectedRevision, 5); assert.notEqual(reviewedSave.posted.requestId, rejected.posted.requestId);
    assert.equal(reviewedSave.plan.tokenLimit, 1200000); assert.equal(reviewedSave.plan.amountLimit, 120); assert.equal(reviewedSave.plan.currency, 'CNY');
    await fit(page); await editor.screenshot({ path: path.join(output, `reviewed-budget-edits-saved-${language}.png`) });
    checks.push({ id: 'PL1-409-keeps-newer-edits-and-explicit-review-resaves', language, width, remote, rejected, afterConflictEdit, reviewedSave });
    await other.close(); await context.close();
  }
  assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) {
  failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, recordedRuns, prohibited,
    browserErrors: errors, externalRequests: external, build: JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8')),
    ...(failure ? { error: String(failure) } : {}) }, null, 2) + '\n');
  if (!failure) await fs.rm(path.join(output, 'failure.png'), { force: true });
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Budget save continuity: ${checks.length} workflows passed`);
