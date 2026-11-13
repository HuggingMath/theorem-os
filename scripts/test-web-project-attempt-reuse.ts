#!/usr/bin/env bun
// Disposable localhost identities and recorded runs only. Never calls a model, real Lean or mail.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import { readingRun } from '../tests/helpers/shareReadingFixture';
import { localeStorageKey } from '../apps/web/i18n';
import { closeSettings, showArtifacts } from './web-ui-controls';
import { freePort, startBrowser, waitForRun } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/continuity-seven/project-reuse');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-project-reuse-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let active: Page | undefined, failure: unknown, phase = 'setup', recordedRuns = 0, prechecks = 0, prohibited = 0;
const errors: string[] = [], external: string[] = [], checks: object[] = [];
const deny = async () => { prohibited++; throw new Error('No model, Lean or mail calls permitted'); };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Recorded project reuse fixture' }; },
  async run(input, send) {
    recordedRuns++; assert.equal(input.input.budgetOrigin, undefined);
    const record = readingRun(input.id); send({ type: 'observation', observation: record.observation! }); send({ type: 'result', result: record.result! });
  },
  async check(input) { prechecks++; return { exitCode: 0, timedOut: false, output: '', checkedTarget: input.candidateTarget?.name }; },
  formalize: deny, explain: deny,
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner, { sample: null, mailer: deny });
const browser = await startBrowser(service.server, port);
async function http(page: Page, method: string, pathname: string, input?: unknown): Promise<any> {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${body.error}`); return body;
  }, { method, pathname, input });
}
async function submit(page: Page) {
  await closeSettings(page); await page.locator('#composer-settings').click(); await page.locator('#api-key').fill('sk-disposable-not-sent'); await closeSettings(page);
  const pending = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
  await page.locator('#submit-run').click(); const response = await pending;
  assert.equal(response.status(), 201, await response.text());
  const request = response.request().postDataJSON(); delete request.apiKey;
  const run = (await response.json()).run; await waitForRun({ page }, run.id, item => item.status === 'completed');
  await page.locator(`.detail-heading[data-run="${run.id}"]`).waitFor({ state: 'attached' }); await showArtifacts(page);
  return { request, run };
}
async function reuse(page: Page) {
  await page.locator('[data-action="reuse-run"]').click(); await closeSettings(page);
  await page.locator('#research-budget-draft [data-budget-project-scope]').waitFor();
  await page.locator('#research-budget-draft [data-budget-forecast]').waitFor();
  await page.reload(); await page.locator('#research-budget-draft [data-budget-project-scope]').waitFor();
  await page.locator('#research-budget-draft [data-budget-forecast]').waitFor(); await closeSettings(page);
}
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ key, language }) => localStorage.setItem(key, language), { key: localeStorageKey, language });
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    phase = `project-fixture-${language}`; await page.goto(origin);
    await page.locator('#refresh-runs:enabled').waitFor({ state: 'attached' });
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const provider = (await http(page, 'GET', '/api/session')).providers[0], record = readingRun();
    const first = service.jobs.create(owner, { providerId: provider.id, apiKey: 'sk-disposable-not-sent', model: 'fixture-model', effort: 'high',
      source: record.source.trim(), task: 'Preserve project attempts across reuse', environment: record.environment,
      maxTurns: 3, maxRunSeconds: 180, maxTotalTokens: 50000, workers: 1, coordination: 'independent' }, provider);
    await waitForRun({ page }, first.id, item => item.status === 'completed');
    await http(page, 'PUT', `/api/research/workspace/problem/${first.id}/budget`, { requestId: crypto.randomUUID(), expectedRevision: 0,
      tokenLimit: 500000, amountLimit: 20, currency: 'CNY' });
    let project = service.research.projects.create(owner, { requestId: crypto.randomUUID(), title: 'Project reuse fixture', visibility: 'private' });
    project = service.research.projects.addVersion(owner, project.id, { requestId: crypto.randomUUID(), expectedRevision: project.revision,
      source: first.source, statement: first.task, environment: first.environment });
    project = service.research.projects.bindRun(owner, project.id, { requestId: crypto.randomUUID(), expectedRevision: project.revision,
      runId: first.id, statementVersionId: project.currentStatementVersionId });
    const expectedOrigin = { runId: first.id, projectId: project.id };
    await page.goto(`${origin}/?budgetRun=${first.id}&budgetTokens=150000&project=${project.id}&lang=${language}`);
    await page.locator('[data-budget-attempt-ready=true]').waitFor(); await closeSettings(page);
    const firstAttempt = await submit(page); assert.deepEqual(firstAttempt.request.budgetOrigin, expectedOrigin);
    await page.locator('[data-budget-attach-run]:disabled').waitFor({ state: 'attached' });
    assert.equal((await http(page, 'GET', `/api/research/theorems/${project.id}`)).item.runs.length, 1);

    phase = `unattached-attempt-reuse-${language}`;
    await reuse(page); const unattached = await submit(page);
    assert.deepEqual(unattached.request.budgetOrigin, expectedOrigin); assert.deepEqual(unattached.run.budgetOrigin, expectedOrigin);
    assert.equal(unattached.run.source, firstAttempt.run.source); assert.equal(unattached.run.model, firstAttempt.run.model);
    assert.equal(unattached.run.maxTotalTokens, firstAttempt.run.maxTotalTokens);
    const attachment = page.locator('[data-budget-attempt-origin]'); await attachment.locator('[data-budget-attach-run]:disabled').waitFor({ state: 'attached' });
    assert.equal((await http(page, 'GET', `/api/research/theorems/${project.id}`)).item.runs.length, 1, 'Reuse never auto-shares');
    await attachment.screenshot({ path: path.join(output, `unattached-reuse-origin-${language}.png`) });
    checks.push({ id: 'PL2-unattached-attempt-retains-fixed-project-origin', language, width, requestOrigin: unattached.request.budgetOrigin,
      storedOrigin: unattached.run.budgetOrigin, modelAndTokensPreserved: true, autoShared: false });

    phase = `attached-attempt-reuse-${language}`;
    await attachment.locator('[data-budget-attach-confirm]').check();
    const attaching = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/research/theorems/${project.id}/runs`);
    await attachment.locator('[data-budget-attach-run]').click(); assert.equal((await attaching).status(), 201);
    await page.locator('[data-budget-project-attached=true]').waitFor();
    const attached = (await http(page, 'GET', `/api/research/theorems/${project.id}`)).item;
    assert.equal(attached.runs.length, 2);
    await reuse(page); await page.locator('#research-budget-draft').screenshot({ path: path.join(output, `attached-reuse-planning-${language}.png`) });
    const next = await submit(page); assert.deepEqual(next.request.budgetOrigin, expectedOrigin); assert.deepEqual(next.run.budgetOrigin, expectedOrigin);
    await page.locator('[data-budget-attempt-origin]').waitFor();
    assert.equal((await http(page, 'GET', `/api/research/theorems/${project.id}`)).item.runs.length, 2);
    checks.push({ id: 'PL2-attached-attempt-retains-project-after-reload', language, width, requestOrigin: next.request.budgetOrigin,
      sourceStatementVersion: attached.runs.find((item: { runId: string }) => item.runId === first.id).statementVersionId, autoShared: false });

    phase = `explicit-personal-branch-${language}`;
    await reuse(page); await page.locator('[data-budget-personal-branch]').click();
    await page.locator('[data-budget-project-scope]').waitFor({ state: 'detached' });
    await page.reload(); await page.locator('#source').waitFor({ state: 'attached' }); await closeSettings(page);
    assert.equal(await page.locator('[data-budget-project-scope]').count(), 0);
    const personal = await submit(page); assert.equal(personal.request.budgetOrigin, undefined); assert.equal(personal.run.budgetOrigin, undefined);
    assert.equal(personal.run.source, next.run.source); assert.equal(await page.locator('[data-budget-attempt-origin]').count(), 0);
    assert.equal((await http(page, 'GET', `/api/research/theorems/${project.id}`)).item.runs.length, 2);
    checks.push({ id: 'PL2-explicit-personal-branch-is-retained', language, width, originClearedByUser: true, originalSourcePreserved: true, projectUnchanged: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await context.close(); active = undefined;
  }
  assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) { failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, errors, external,
    recordedRuns, prechecks, prohibited, realModelCalls: 0, realLeanCalls: 0, build: JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8')),
    ...(failure ? { error: String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Project attempt reuse: ${checks.length} flows passed`);
