import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { shareSnapshot } from '../apps/web/share';
import { localeStorageKey } from '../apps/web/i18n';
import { taskDraftStorageKey } from '../apps/web/client/draft';
import { draftRecoveryStorageKey } from '../apps/web/client/draftRecovery';
import { readingRun } from '../tests/helpers/shareReadingFixture';
import { freePort, startBrowser, waitForRun } from './web-scenario';
import { closeSettings } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/continuity-seven/recovery');
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-audit-recovery-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const checks: any[] = [], errors: string[] = [], external: string[] = [];
let phase = 'setup', active: Page | undefined, failure: unknown, recordedRuns = 0, recordedPrechecks = 0, prohibited = 0;
const deny = async () => { prohibited++; throw new Error('No models, real Lean or email permitted'); };
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: data }), {
  async readiness() { return { ready: true, message: 'Disposable audit fixture' }; },
  async run(input: any, send: any) { recordedRuns++; const record = readingRun(input.id);
    send({ type: 'observation', observation: record.observation! }); send({ type: 'result', result: record.result! }); },
  async check(input: any) { recordedPrechecks++; return { exitCode: 0, timedOut: false, output: '', checkedTarget: input.candidateTarget?.name }; },
  formalize: deny, explain: deny,
}, { sample: null, mailer: deny });
const browser = await startBrowser(service.server, port);
const index = JSON.parse(await fs.readFile(path.join(root, 'out/web/classics/data/index.json'), 'utf8'));
const classic = index.records[0];
async function http(page: Page, method: string, pathname: string, input?: unknown) {
  return page.evaluate(async ({ method, pathname, input }: any) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${body.error}`); return body;
  }, { method, pathname, input });
}
async function saved(page: Page) {
  return page.evaluate(({ draftKey, recoveryKey }: any) => ({ draft: JSON.parse(sessionStorage.getItem(draftKey) ?? 'null'),
    recovery: JSON.parse(sessionStorage.getItem(recoveryKey) ?? 'null') }), { draftKey: taskDraftStorageKey, recoveryKey: draftRecoveryStorageKey });
}
async function replaceWithClassic(page: Page, language: string) {
  await closeSettings(page);
  await page.goto(`${origin}/?fromClassic=${classic.id}&lang=${language}`);
  await page.locator('[data-classic-preview] > summary').click();
  await page.locator('[data-classic-confirm]').click();
  await page.locator('[data-classic-ready=true]').waitFor();
  await page.waitForFunction(() => document.body.dataset.entry === 'lean');
  await closeSettings(page);
}
async function submit(page: Page) {
  await closeSettings(page); await page.locator('#composer-settings').click();
  await page.locator('#api-key').fill('sk-disposable-not-sent'); await closeSettings(page);
  const pending = page.waitForResponse((response: any) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
  await page.locator('#submit-run').click(); const response = await pending; assert.equal(response.status(), 201);
  const run = (await response.json()).run; await waitForRun({ page }, run.id, item => item.status === 'completed');
  return run;
}
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ key, language }: any) => localStorage.setItem(key, language), { key: localeStorageKey, language });
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message));
    phase = `${language}-share-control`;
    const run = readingRun(crypto.randomUUID()), snapshot = shareSnapshot(run)!, token = crypto.randomUUID().replaceAll('-', ''), author = 'account:disposable-audit-author';
    service.storage.saveRun(author, run); service.storage.saveShare(author, run.id, { token, createdAt: snapshot.sharedAt, snapshot });
    await page.goto(`${origin}/share.html?lang=${language}#${token}`);
    const reading = (await http(page, 'POST', '/api/research/shared-proofs', { token, requestId: crypto.randomUUID() })).item;
    const preparation = (await http(page, 'POST', `/api/research/shared-proofs/${reading.id}/prepare`, { requestId: crypto.randomUUID(), expectedDigest: reading.digest, confirmed: true })).item;
    await page.goto(`${origin}/?sharedDraft=${preparation.id}&lang=${language}`);
    await page.locator('[data-shared-proof-origin][data-shared-proof-status=available]').waitFor();
    const originalSource = await page.locator('#source').inputValue(), originalTask = await page.locator('#task').inputValue();
    await page.reload(); await page.locator('[data-shared-proof-origin][data-shared-proof-status=available]').waitFor();
    const shareBefore = await saved(page); assert.equal(shareBefore.draft.draft.sharedProofOrigin.readingId, reading.id);
    await closeSettings(page); await page.locator('[data-shared-proof-origin]').screenshot({ path: path.join(output, `${language}-share-before.png`) });
    phase = `${language}-share-classic-undo`;
    await replaceWithClassic(page, language); const shareBackup = await saved(page);
    await page.locator('#restore-draft').click();
    await page.waitForFunction(source => document.querySelector<HTMLTextAreaElement>('#source')?.value === source, originalSource);
    assert.equal(await page.locator('#source').inputValue(), originalSource); assert.equal(await page.locator('#task').inputValue(), originalTask);
    await page.locator('[data-shared-proof-origin][data-shared-proof-status=available]').waitFor();
    await page.waitForFunction(key => JSON.parse(sessionStorage.getItem(key) ?? '{}').draft?.source === document.querySelector<HTMLTextAreaElement>('#source')?.value, taskDraftStorageKey);
    const shareAfter = await saved(page); assert.deepEqual(shareAfter.draft.draft.sharedProofOrigin, shareBefore.draft.draft.sharedProofOrigin);
    assert.deepEqual(shareBackup.recovery.task.draft.sharedProofOrigin, shareBefore.draft.draft.sharedProofOrigin);
    await page.screenshot({ path: path.join(output, `${language}-share-after-undo.png`), fullPage: true });
    await page.reload(); await page.locator('#source').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#source').inputValue(), originalSource); await page.locator('[data-shared-proof-origin][data-shared-proof-status=available]').waitFor();
    checks.push({ id: 'REC1-restores-share-provenance', language, width, normalReloadRetainsSource: true, undoRestoresSourceAndTask: true,
      beforeOrigin: shareBefore.draft.draft.sharedProofOrigin, backupOrigin: shareBackup.recovery?.task?.draft?.sharedProofOrigin ?? null,
      afterOrigin: shareAfter.draft.draft.sharedProofOrigin ?? null, afterReloadOriginCount: await page.locator('[data-shared-proof-origin]').count() });

    phase = `${language}-classic-to-share-source-replacement`;
    await replaceWithClassic(page, language);
    const classicSource = await page.locator('#source').inputValue();
    const anotherPreparation = (await http(page, 'POST', `/api/research/shared-proofs/${reading.id}/prepare`, {
      requestId: crypto.randomUUID(), expectedDigest: reading.digest, confirmed: true })).item;
    await page.goto(`${origin}/?sharedDraft=${anotherPreparation.id}&lang=${language}`);
    await page.locator('[data-shared-proof-origin][data-shared-proof-status=available]').waitFor();
    assert.equal(await page.locator('[data-classic-origin]').count(), 0, 'An unrelated source must not keep the old classic label');
    assert.equal((await saved(page)).draft.draft.classicOrigin, undefined);
    await closeSettings(page); await page.locator('#restore-draft').click();
    await page.waitForFunction(source => document.querySelector<HTMLTextAreaElement>('#source')?.value === source, classicSource);
    await page.locator('[data-classic-ready=true]').waitFor();
    assert.equal(await page.locator('[data-shared-proof-origin]').count(), 0);
    await page.reload(); await page.locator('[data-classic-ready=true]').waitFor();
    assert.equal(await page.locator('#source').inputValue(), classicSource);
    checks.push({ id: 'REC1-source-replacement-is-exclusive-and-undo-restores-classic', language, width,
      unrelatedClassicClearedOnShare: true, originalClassicRecoveredOnUndo: true, survivesReload: true });

    phase = `${language}-budget-control`;
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const session = await http(page, 'GET', '/api/session'), provider = session.providers[0];
    const first = service.jobs.create(owner, { providerId: provider.id, apiKey: 'sk-disposable-unused', model: 'fixture-model', effort: 'high',
      source: run.source.trim(), environment: run.environment, task: 'Undo must retain my whole-problem budget', maxTurns: 3, maxRunSeconds: 180,
      maxTotalTokens: 50000, workers: 1, coordination: 'independent' }, provider);
    await waitForRun({ page }, first.id, item => item.status === 'completed');
    await http(page, 'PUT', `/api/research/workspace/problem/${first.id}/budget`, { requestId: crypto.randomUUID(), expectedRevision: 0, currency: 'CNY', amountLimit: 20, tokenLimit: 500000 });
    let project = service.research.projects.create(owner, { requestId: crypto.randomUUID(), title: 'Undo budget context audit', visibility: 'private' });
    project = service.research.projects.addVersion(owner, project.id, { requestId: crypto.randomUUID(), expectedRevision: project.revision,
      statement: first.task, source: first.source, environment: first.environment });
    project = service.research.projects.bindRun(owner, project.id, { requestId: crypto.randomUUID(), expectedRevision: project.revision,
      runId: first.id, statementVersionId: project.currentStatementVersionId });
    const budgetAddress = `${origin}/?budgetRun=${first.id}&budgetTokens=10000&project=${project.id}&lang=${language}`;
    await page.goto(budgetAddress); await page.locator('[data-budget-attempt-ready=true]').waitFor();
    await closeSettings(page); await page.locator('#research-budget-draft [data-budget-forecast]').waitFor();
    await page.reload(); await page.locator('#research-budget-draft [data-budget-forecast]').waitFor();
    const budgetBefore = await saved(page), budgetSource = await page.locator('#source').inputValue(), budgetTask = await page.locator('#task').inputValue();
    assert.equal(budgetBefore.draft.draft.problemBudget.runId, first.id);
    await closeSettings(page); await page.locator('#research-budget-draft').screenshot({ path: path.join(output, `${language}-budget-before.png`) });
    phase = `${language}-budget-classic-undo`;
    await replaceWithClassic(page, language); const budgetBackup = await saved(page);
    await page.locator('#restore-draft').click();
    await page.waitForFunction(source => document.querySelector<HTMLTextAreaElement>('#source')?.value === source, budgetSource);
    assert.equal(await page.locator('#source').inputValue(), budgetSource); assert.equal(await page.locator('#task').inputValue(), budgetTask);
    await page.locator('#research-budget-draft [data-budget-forecast]').waitFor();
    const budgetAfter = await saved(page); assert.deepEqual(budgetAfter.draft.draft.problemBudget, budgetBefore.draft.draft.problemBudget);
    assert.deepEqual(budgetBackup.recovery.task.draft.problemBudget, budgetBefore.draft.draft.problemBudget);
    await page.screenshot({ path: path.join(output, `${language}-budget-after-undo.png`), fullPage: true });
    await page.reload(); await page.locator('#source').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#source').inputValue(), budgetSource);
    await page.locator('#research-budget-draft [data-budget-forecast]').waitFor();
    const missingOriginRun = await submit(page); assert.deepEqual(missingOriginRun.budgetOrigin, { runId: first.id, projectId: project.id });
    phase = `${language}-budget-normal-submit-control`;
    await page.goto(budgetAddress); await page.locator('[data-budget-attempt-ready=true]').waitFor(); await closeSettings(page);
    await page.locator('#research-budget-draft [data-budget-forecast]').waitFor();
    const normalRun = await submit(page); assert.deepEqual(normalRun.budgetOrigin, { runId: first.id, projectId: project.id });
    checks.push({ id: 'REC1-restores-whole-problem-budget', language, width, normalReloadRetainsBudget: true, undoRestoresSourceAndTask: true,
      beforeBudget: budgetBefore.draft.draft.problemBudget, backupBudget: budgetBackup.recovery?.task?.draft?.problemBudget ?? null,
      afterBudget: budgetAfter.draft.draft.problemBudget ?? null, afterUndoRunBudgetOrigin: missingOriginRun.budgetOrigin ?? null,
      normalRunBudgetOrigin: normalRun.budgetOrigin, maxTotalTokensAfterUndo: missingOriginRun.maxTotalTokens, explicitSourceId: first.id, projectId: project.id });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await context.close(); active = undefined;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0);
} catch (error) {
  failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, errors, external,
    recordedRuns, recordedPrechecks, prohibited, realModelCalls: 0, realLeanCalls: 0, realMailCalls: 0,
    build: JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8')), ...(failure ? { error: String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(data, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Recovery continuity: ${checks.length} passed desktop/mobile cases`);
