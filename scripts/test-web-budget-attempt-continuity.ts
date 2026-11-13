#!/usr/bin/env bun
// Disposable local identities and recorded runs. No model, Lean, email or production calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchBudgetView } from '../apps/web/researchBudgetTypes';
import type { ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { readingRun } from '../tests/helpers/shareReadingFixture';
import { freePort, startBrowser, waitForRun } from './web-scenario';
import { closeSettings, openProblemSection, showArtifacts } from './web-ui-controls';
import { localeStorageKey } from '../apps/web/i18n';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/post-state-20261111/workspace');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-budget-attempt-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let recordedRuns = 0, prechecks = 0, prohibited = 0, phase = 'setup', failure: unknown, active: Page | undefined;
const errors: string[] = [], external: string[] = [], checks: object[] = [];
const deny = async () => { prohibited++; throw new Error('No models, Lean, email or production calls allowed'); };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Recorded budget attempt fixture' }; },
  async run(input, send) {
    recordedRuns++; assert.equal(input.input.budgetOrigin, undefined, 'Private project provenance stays at the host');
    const record = readingRun(input.id); send({ type: 'observation', observation: record.observation! }); send({ type: 'result', result: record.result! });
  },
  async check(input) { prechecks++; return { exitCode: 0, timedOut: false, output: '', checkedTarget: input.candidateTarget?.name }; },
  formalize: deny, explain: deny,
};
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot });
const service = createWebService(config, runner, { sample: null, mailer: deny });
const browser = await startBrowser(service.server, port);
async function http(page: Page, method: string, pathname: string, input?: unknown): Promise<any> {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${body.error}`); return body;
  }, { method, pathname, input });
}
const fit = async (page: Page) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow');
const budgetUrl = (run: string, project?: string) => `/api/research/workspace/problem/${run}/budget${project ? `?project=${project}` : ''}`;

try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ language, key }) => localStorage.setItem(key, language), { language, key: localeStorageKey });
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/workspace.html?tab=usage'); await page.locator('[data-workspace-page]').waitFor();
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const session = await http(page, 'GET', '/api/session'), provider = session.providers[0], record = readingRun();
    const input = { providerId: provider.id, apiKey: 'sk-disposable-unused', model: 'fixture-model', effort: 'high' as const,
      environment: record.environment, source: record.source.trim(), task: 'Project budget continuity', maxTurns: 3,
      maxRunSeconds: 180, maxTotalTokens: 50000, workers: 1, coordination: 'independent' as const };
    const first = service.jobs.create(owner, input, provider); await waitForRun({ page }, first.id, run => run.status === 'completed');
    await http(page, 'PUT', budgetUrl(first.id), { requestId: crypto.randomUUID(), expectedRevision: 0, currency: 'CNY', amountLimit: 20, tokenLimit: 500000 });

    phase = `project-attempt-prepare-${language}`;
    await page.goto(`${origin}/problem.html?run=${first.id}&tab=overview`); await page.locator('[data-project-from-problem] > summary').click();
    await page.locator('[data-project-from-problem] input[type=checkbox]').check();
    const creating = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/problem/${first.id}/project`));
    await page.locator('[data-project-from-problem] button[type=submit]').click(); const project = (await (await creating).json()).item as ResearchProjectDetail;
    await page.waitForFunction(id => new URL(location.href).searchParams.get('project') === id, project.id);
    await openProblemSection(page, 'outcomes'); await page.locator('[data-budget-inherited]').waitFor();
    await page.locator('[data-prepare-budget-attempt]').click(); await page.locator('[data-budget-attempt-ready=true]').waitFor(); await closeSettings(page);
    const draft = page.locator('#research-budget-draft'); await draft.locator('[data-budget-project-scope]').waitFor(); await draft.locator('[data-budget-forecast]').waitFor();
    assert.match(await page.locator('[data-budget-attempt-start]').innerText(), language === 'zh' ? /个人尝试.*关联到项目/u : /personal attempt.*(?:attach|link).*project/iu);
    assert.match(await draft.innerText(), language === 'zh' ? /个人运行.*确认关联/u : /personal run.*confirm attachment/iu);
    await fit(page); await draft.screenshot({ path: path.join(output, `project-attempt-planning-${language}.png`) });

    phase = `project-attempt-submit-${language}`;
    await page.locator('#composer-settings').click(); await page.locator('#api-key').fill('sk-disposable-not-sent'); await closeSettings(page);
    const submitting = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
    await page.locator('#submit-run').click(); const submitted = await submitting; assert.equal(submitted.status(), 201);
    const next = (await submitted.json()).run;
    assert.deepEqual(next.budgetOrigin, { runId: first.id, projectId: project.id }); await waitForRun({ page }, next.id, run => run.status === 'completed');
    await page.locator(`.detail-heading[data-run="${next.id}"]`).waitFor({ state: 'attached' });
    await showArtifacts(page); await page.locator('[data-budget-attempt-origin]').waitFor(); const attachment = page.locator('[data-budget-attempt-origin]');
    await attachment.locator('[data-budget-attach-run]').waitFor(); assert.equal(await attachment.locator('[data-budget-attach-run]').isDisabled(), true);
    assert.equal((await http(page, 'GET', `/api/research/theorems/${project.id}`)).item.runs.length, 1, 'Submission never auto-shares');
    phase = `project-attempt-reload-${language}`;
    await page.reload(); await page.locator(`.detail-heading[data-run="${next.id}"]`).waitFor({ state: 'attached' }); await showArtifacts(page); await attachment.locator('[data-budget-attach-run]').waitFor();
    assert.equal(await attachment.locator('[data-budget-attach-confirm]').isChecked(), false, 'A reload preserves origin without sharing consent');
    await fit(page); await attachment.screenshot({ path: path.join(output, `personal-attempt-awaits-confirmation-${language}.png`) });

    phase = `stale-project-review-${language}`;
    let current = (await http(page, 'GET', `/api/research/theorems/${project.id}`)).item as ResearchProjectDetail;
    const changedProject = (await http(page, 'PATCH', `/api/research/theorems/${project.id}`, { requestId: crypto.randomUUID(), expectedRevision: current.revision, description: 'A concurrent project edit' })).item;
    await attachment.locator('[data-budget-attach-confirm]').check();
    const stale = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/research/theorems/${project.id}/runs`);
    await attachment.locator('[data-budget-attach-run]').click(); assert.equal((await stale).status(), 409);
    await attachment.locator('[role=alert]').waitFor();
    assert.equal((await http(page, 'GET', `/api/research/theorems/${project.id}`)).item.runs.length, 1);
    await attachment.locator('[data-budget-attach-refresh]').click();
    await page.waitForFunction(revision => document.querySelector('[data-budget-attempt-origin]')?.getAttribute('data-budget-project-revision') === String(revision), changedProject.revision);
    assert.equal(await attachment.locator('[data-budget-attach-confirm]').isChecked(), false);
    await attachment.locator('[data-budget-attach-confirm]').check();
    const attaching = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/research/theorems/${project.id}/runs`);
    await attachment.locator('[data-budget-attach-run]').click(); assert.equal((await attaching).status(), 201);
    await page.locator('[data-budget-project-attached=true]').waitFor();
    current = (await http(page, 'GET', `/api/research/theorems/${project.id}`)).item;
    const binding = current.runs.find(item => item.runId === next.id)!;
    assert.equal(binding.statementVersionId, project.currentStatementVersionId); assert.equal(binding.exposure, 'members');
    assert.deepEqual(binding.grants, { guidance: false, edit: false, approve: false, proof: false });
    const totals: ResearchBudgetView = (await http(page, 'GET', budgetUrl(next.id, project.id))).item;
    assert.equal(totals.knownTokens, 2400); assert.equal((await http(page, 'GET', '/api/research/workspace/usage')).knownTokens, 2400);
    await fit(page); await attachment.screenshot({ path: path.join(output, `project-attempt-attached-${language}.png`) });
    checks.push({ id: 'W3-explicit-attachment-restores-project-continuity', language, width, first: first.id, next: next.id, projectId: project.id,
      retainedOrigin: next.budgetOrigin, explicitSharing: binding, knownTokens: totals.knownTokens, sourceVersion: project.currentStatementVersionId, staleProjectRejected: true });

    phase = `budget-conflict-fixture-${language}`;
    const pair = async (marker: string) => {
      const runs = [0, 1].map(index => service.jobs.create(owner, { ...input, source: input.source + `\n-- ${marker}-${index}`, task: `${marker} ${index}` }, provider));
      for (const [index, run] of runs.entries()) {
        await waitForRun({ page }, run.id, item => item.status === 'completed');
        await http(page, 'PUT', budgetUrl(run.id), { requestId: crypto.randomUUID(), expectedRevision: 0, currency: 'CNY', amountLimit: index ? 80 : 20, tokenLimit: index ? 900000 : 500000 });
      }
      return runs;
    };
    const combined = (title: string, runs: typeof first[]) => {
      let project = service.research.projects.create(owner, { requestId: crypto.randomUUID(), title, visibility: 'private' });
      for (const run of runs) {
        project = service.research.projects.addVersion(owner, project.id, { requestId: crypto.randomUUID(), expectedRevision: project.revision,
          statement: run.task, source: run.source, environment: run.environment });
        project = service.research.projects.bindRun(owner, project.id, { requestId: crypto.randomUUID(), expectedRevision: project.revision, runId: run.id, statementVersionId: project.currentStatementVersionId });
      }
      return project;
    };
    const conflictRuns = await pair('Conflict budget'), conflictFirst = conflictRuns[0]!, conflict = combined('Budget source review', conflictRuns);
    await page.goto(`${origin}/problem.html?run=${conflictFirst.id}&project=${conflict.id}&tab=outcomes`); await page.locator('[data-budget-continuity]').waitFor();
    await page.locator('[data-prepare-budget-attempt]').click(); await page.locator('[data-budget-attempt-ready=true]').waitFor(); await closeSettings(page);
    await draft.locator('[data-budget-continuity]').waitFor();
    const conflictFacts = await draft.locator('[data-problem-budget-facts]').innerText();
    assert.ok(!conflictFacts.includes(language === 'zh' ? '未设 Token 预算' : 'No token budget'));
    assert.ok(!conflictFacts.includes(language === 'zh' ? '未设金额预算' : 'No cost budget'));
    assert.equal(await draft.locator('[data-inherit-budget]').count(), 2);
    assert.match(conflictFacts, language === 'zh' ? /待选择项目预算/u : /Choose a project budget first/u);
    await fit(page); await draft.screenshot({ path: path.join(output, `budget-conflict-preserved-${language}.png`) });
    const before: ResearchBudgetView = (await http(page, 'GET', budgetUrl(conflictFirst.id, conflict.id))).item;
    const chosen = before.continuity!.sources.find(source => source.plan.tokenLimit === 500000)!;
    await draft.locator(`[data-inherit-budget="${chosen.key}"]`).click(); await draft.locator('[data-budget-continuity]').waitFor({ state: 'detached' });
    await draft.locator('[data-budget-inherited]').waitFor({ state: 'detached' });
    await draft.locator('[data-budget-forecast]').waitFor();
    const after: ResearchBudgetView = (await http(page, 'GET', budgetUrl(conflictFirst.id, conflict.id))).item;
    assert.equal(after.continuity, undefined); assert.equal(after.plan.tokenLimit, 500000); assert.equal(after.remainingTokens, 497600);
    await fit(page); await draft.screenshot({ path: path.join(output, `budget-conflict-resolved-${language}.png`) });
    checks.push({ id: 'W4-budget-conflict-preserved-and-resolved-in-composer', language, width, projectId: conflict.id, conflictFacts, chosenBudget: after.plan, remainingTokens: after.remainingTokens });

    phase = `budget-separate-choice-${language}`;
    const separateRuns = await pair('Separate budget'), separateFirst = separateRuns[0]!, separate = combined('Separate project plan', separateRuns);
    await page.goto(`${origin}/problem.html?run=${separateFirst.id}&project=${separate.id}&tab=outcomes`); await page.locator('[data-budget-continuity]').waitFor();
    await page.locator('[data-prepare-budget-attempt]').click(); await page.locator('[data-budget-attempt-ready=true]').waitFor(); await closeSettings(page);
    await draft.locator('[data-budget-continuity]').waitFor(); await draft.locator('[data-new-project-budget]').click();
    await draft.locator('[data-budget-continuity]').waitFor({ state: 'detached' }); await draft.locator('[data-budget-forecast]').waitFor();
    assert.match(await draft.locator('[data-problem-budget-facts]').innerText(), language === 'zh' ? /未设 Token 预算/u : /No token budget/u);
    const separateValue = (await http(page, 'GET', budgetUrl(separateFirst.id, separate.id))).item;
    assert.equal(separateValue.continuity, undefined); assert.equal(separateValue.plan.tokenLimit, null);
    checks.push({ id: 'W4-deliberate-separate-budget-remains-available', language, width, projectId: separate.id, plan: separateValue.plan });
    await context.close();
  }
  assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) {
  failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, recordedRuns, prechecks, prohibited, errors, external,
    build: JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8')), ...(failure ? { error: String(failure) } : {}) }, null, 2));
  if (!failure) await fs.rm(path.join(output, 'failure.png'), { force: true });
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Budget attempt continuity: ${checks.length} workflows passed`);
