#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebObservation, WebTaskSource } from '../apps/web/collaboration';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput } from '../apps/web/shared';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { refreshHistory, selectHistoryRun } from './web-ui-controls';
import { deferred, freePort, postRun, settled, startBrowser, webScenario, writeScenarioReport, type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-task-source');
await fs.mkdir(output, { recursive: true });
const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-source-browser-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init', '--quiet'); git('config', 'user.name', 'Source Browser Fixture'); git('config', 'user.email', 'source-fixture@example.invalid');
const environmentDigest = mathDigest('local source browser fixture; no Lean checks');
async function sourceSnapshot(taskId: string, taskVersion: string, file: string, source: string): Promise<WebTaskSource> {
  await fs.writeFile(path.join(repository, file), source);
  git('add', '--', file); git('commit', '--quiet', '-m', `${taskId} ${taskVersion} source sample`);
  return { taskId, taskVersion, file, source, commit: git('rev-parse', 'HEAD'),
    sourceDigest: mathDigest(canonicalMathJson([[file, mathDigest(source)]])), environmentDigest, scope: 'owned-file' };
}
const lines = Array.from({ length: 90 }, (_, index) => `-- retained context ${index}`).join('\n');
const historical = await sourceSnapshot('helper', 'helper-v1', 'Helper.lean', `${lines}\ntheorem helper : True := by\n  sorry\n`);
const currentA = await sourceSnapshot('helper', 'helper-v2', 'Helper.lean', `${lines}\ntheorem helper : True := by\n  exact True.intro\n`);
const currentB = await sourceSnapshot('helper', 'helper-v2', 'Helper.lean', `${lines}\n-- ${'long source comment '.repeat(90)}\ntheorem helper : True := by\n  trivial\n`);
const currentC = await sourceSnapshot('helper', 'helper-v2', 'Helper.lean', `${lines}\n-- another saved commit\ntheorem helper : True := by\n  constructor\n`);
const other = await sourceSnapshot('other', 'other-v1', 'Other.lean', 'theorem other : True := by\n  sorry\n');
const largeBefore = await sourceSnapshot('large', 'large-v1', 'Large.lean', `${'-- large saved source baseline '.repeat(10_000)}\ntheorem large : True := by sorry\n`);
const largeAfter = await sourceSnapshot('large', 'large-v2', 'Large.lean', `${'-- large saved source comparison '.repeat(10_000)}\ntheorem large : True := by sorry\n`);
const savedSources = [currentB, currentA, historical, other, largeAfter, largeBefore];

function observation(id: string): WebObservation {
  const tasks = [currentB, other, largeAfter].map(source => ({ id: source.taskId, kind: source.taskId === 'other' ? 'goal' as const : 'lemma' as const,
    objective: `Inspect saved ${source.taskId} source`, dependsOn: [], revision: 0, theoremName: source.taskId, proofPath: source.file, type: 'True' }));
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `source-${id}`, stateDigest: mathDigest(id), resultDigest: null };
  return {
    schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: new Date().toISOString(), sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'source-plan-v1', tasks, proofRoutes: [] },
    inspection: {
      schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
      problem: { id: 'source-browser-fixture', statement: 'Inspect source history', formalStatement: 'True', assumptions: [], targets: [{ proofPath: other.file, theoremName: 'other' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 1, coordination: 'cooperative', buildDigest: mathDigest('source-fixture'), environmentDigest },
      turns: 0, planVersion: 'source-plan-v1', scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded', droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] },
      tokenBudget: {}, continuation: {}, mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: mathDigest('source-obligations'), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: tasks.map(task => task.id) }, groups: [], workers: [], statementReviews: [], edits: [],
      tasks: tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective, group: 'main', status: 'pending', control: 'active', version: savedSources.find(source => source.taskId === task.id)!.taskVersion,
        theorem: task.theoremName, type: task.type, premises: [], plannedDependencies: [], attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })),
    },
    sources: structuredClone(savedSources), checks: [], guidance: [], coverage: { sources: 'recorded', checks: 'recorded' },
  };
}
type Control = { observation: WebObservation; emit: () => void; finish: () => void };
const controls = new Map<string, Control>();
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local saved-source HTTP fixture; no proof receipts' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), emit() {
        this.observation = { ...this.observation, sequence: this.observation.sequence + 1, observedAt: new Date().toISOString() };
        send({ type: 'observation', observation: structuredClone(this.observation) });
      }, finish: resolve };
      controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true }); control.emit();
    });
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-local-source-fixture', model: 'fixture', effort: 'low', environment: 'standard',
  source: 'theorem other : True := by sorry\n', task: 'Inspect immutable task source snapshots', maxTurns: 1, maxRunSeconds: 60, workers: 1, coordination: 'cooperative' };
const key = (source: WebTaskSource) => JSON.stringify([source.taskId, source.taskVersion, source.commit, source.sourceDigest, source.environmentDigest, source.file]);
async function create(page: Page) {
  const run = await postRun({ page }, input); await refreshHistory(page); await selectHistoryRun(page, run.id, 'collaboration');
  await page.locator('.collab-surface').waitFor(); return run;
}
async function selectTask(page: Page, id: string) { await page.locator(`[data-collab-task="${id}"]:visible`).first().click(); }
async function openSource(page: Page, source: WebTaskSource) {
  await selectTask(page, source.taskId);
  await page.locator(`[data-collab-source="${source.taskId}"][data-source-version="${source.taskVersion}"]`).filter({ hasText: source.commit.slice(0, 8) }).click();
  await page.locator('[data-task-source-code]').waitFor();
}
async function poll(page: Page) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'GET');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await response; await settled(page);
}
async function connected(page: Page) {
  assert.equal(await page.locator('#global-notice').isVisible(), false, 'source comparisons must not break the workbench connection');
  assert.ok((await page.locator('#connection-status').innerText()).includes('环境就绪'));
}
async function assertIdentity(page: Page, side: 'before' | 'after', source: WebTaskSource) {
  const identity = page.locator(`[data-task-source-side="${side}"]`);
  for (const value of [source.taskId, source.taskVersion, source.commit, source.sourceDigest, source.environmentDigest, source.file]) assert.ok((await identity.innerText()).includes(value), `${side} identity includes ${value}`);
}
async function compare(page: Page, before: WebTaskSource, after: WebTaskSource) {
  await page.locator('[data-task-source-mode="diff"]').click();
  await page.locator('[data-task-source-before]').selectOption(key(before)); await page.locator('[data-task-source-after]').selectOption(key(after));
  await assertIdentity(page, 'before', before); await assertIdentity(page, 'after', after);
}
async function fit(page: Page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'source comparison fits the viewport');
  for (const selector of ['.collab-task-source', '.collab-source-comparison-controls', '.collab-source-identities', '[data-task-source-diff]']) {
    const box = await page.locator(selector).boundingBox(); assert.ok(box && box.x >= -1 && box.x + box.width <= page.viewportSize()!.width + 1, selector);
  }
}

try {
  await webScenario(browser, suite, 'same-task identities, commit snapshots, polling and delayed source responses', async ({ page }) => {
    const run = await create(page), control = controls.get(run.id)!;
    await openSource(page, currentB); assert.equal(await page.locator('[data-task-source-code]').textContent(), currentB.source);
    await compare(page, historical, currentB); await page.locator('[data-task-source-diff] .diff-added').first().waitFor();
    assert.equal((await page.locator('[data-task-source-before] option').allTextContents()).some(text => text.includes('other-v1') || text.includes('large-v1')), false, 'another task cannot enter the comparison');
    await compare(page, currentA, currentB); assert.notEqual(currentA.commit, currentB.commit); assert.equal(currentA.taskVersion, currentB.taskVersion);
    await page.locator('[data-task-source-fold]').uncheck();
    const scroll = await page.locator('[data-task-source-diff]').evaluate(node => { (node as HTMLElement).scrollTop = 75; (node as HTMLElement).dataset.pollProbe = 'same-comparison'; return (node as HTMLElement).scrollTop; });
    await page.locator('[data-task-source-before]').focus();
    control.observation.sources.push(currentC); control.emit(); await poll(page);
    assert.equal(await page.locator('[data-task-source-mode="diff"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-task-source-before]').inputValue(), key(currentA)); assert.equal(await page.locator('[data-task-source-after]').inputValue(), key(currentB));
    assert.equal(await page.locator('[data-task-source-before]').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('[data-task-source-diff]').getAttribute('data-poll-probe'), 'same-comparison'); assert.equal(await page.locator('[data-task-source-diff]').evaluate(node => node.scrollTop), scroll);
    assert.equal(await page.locator('[data-task-source-fold]').isChecked(), false); await connected(page); await page.locator('[data-task-source-diff]').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'desktop.png') });
    await page.locator('[data-task-source-before]').selectOption(key(currentB)); await page.locator('[data-task-source-status]').getByText('源码内容相同', { exact: true }).waitFor();
    await openSource(page, other); assert.equal(await page.locator('[data-task-source-code]').textContent(), other.source); assert.equal(await page.locator('[data-task-source-mode="diff"]').isDisabled(), true);
    assert.equal(await page.locator('[data-collab-artifact]').getByText(currentB.commit, { exact: true }).count(), 0, 'switching tasks clears the previous source identity');
    await openSource(page, largeAfter); await compare(page, largeBefore, largeAfter); await page.locator('[data-task-source-status]').getByText(/差异过多/).waitFor();
    await page.locator('[data-task-source-mode="source"]').click(); assert.equal(await page.locator('[data-task-source-code]').textContent(), largeAfter.source);
    await page.locator('[data-task-source-after]').selectOption(key(largeBefore)); assert.equal(await page.locator('[data-task-source-code]').textContent(), largeBefore.source);

    control.observation.sources = [other]; control.emit(); await poll(page); await selectTask(page, 'helper');
    const captured = deferred(), release = deferred(), completed = deferred();
    const sourceUrl = `**/api/runs/${run.id}/tasks/helper/source?version=helper-v2`;
    await page.route(sourceUrl, async route => {
      const response = await route.fetch(); assert.equal(response.status(), 200); captured.resolve();
      await release.promise; await route.fulfill({ response }); completed.resolve();
    });
    await page.locator('[data-collab-source="helper"]').click(); await captured.promise;
    await openSource(page, other); release.resolve(); await completed.promise; await settled(page); await page.unroute(sourceUrl);
    assert.equal(await page.locator('[data-task-source-code]').textContent(), other.source, 'a delayed source response cannot replace another task’s source');
    assert.equal(await page.locator('[data-collab-artifact]').getByText(currentB.commit, { exact: true }).count(), 0);
    assert.ok((await page.locator('.collab-metrics').innerText()).includes('尚未验收通过')); assert.equal(control.observation.checks.length, 0, 'source fixtures do not invent proof receipts'); await connected(page);
  }, { context: { viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }, harness: (page, context) => ({ page, context, requests: [] }), routes: { local: 'Source browser fixtures must stay local' }, open: true, timeout: { label: 'Task sources', seconds: 60 } });
  for (const width of [375, 320]) await webScenario(browser, suite, `task source comparison fits ${width}px`, async ({ page }) => {
    await create(page); await openSource(page, currentB); await compare(page, currentA, currentB); await poll(page); await connected(page); await fit(page);
    await page.locator('[data-task-source-diff] .diff-added').first().waitFor(); await page.locator('[data-task-source-diff]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `mobile-${width}.png`) });
  }, { context: { viewport: { width, height: 812 }, reducedMotion: 'reduce' }, harness: (page, context) => ({ page, context, requests: [] }), routes: { local: 'Source browser fixtures must stay local' }, open: true, timeout: { label: 'Mobile task sources', seconds: 30 } });
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined, 'local-real-http-saved-source-fixture', {
    checks: suite.checks, proofReceipts: 0, sourceCommits: savedSources.map(({ taskId, taskVersion, commit, sourceDigest }) => ({ taskId, taskVersion, commit, sourceDigest })), screenshots: ['desktop.png', 'mobile-375.png', 'mobile-320.png'],
  }, { credential: input.apiKey });
  console.log('Task source browser checks passed');
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-saved-source-fixture', { checks: suite.checks, proofReceipts: 0 }); throw error;
} finally {
  for (const control of controls.values()) control.finish(); await browser.close(); await service.close(); await fs.rm(repository, { recursive: true, force: true });
}
