#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput } from '../apps/web/shared';
import type { WebInspectedTask, WebInspectedWorker, WebObservation } from '../apps/web/collaboration';
import { localeStorageKey } from '../apps/web/i18n';
import { collaborationDetailStorageKey } from '../apps/web/client/runAwareness';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { refreshHistory, selectHistoryRun } from './web-ui-controls';
import { freePort, postRun, settled, startBrowser, webScenario, writeScenarioReport, type ScenarioHarness, type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-collaboration-layers');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the collaboration layers check.'); });
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
const raw = '<img src=x onerror="globalThis.__layersXss=1">';
const environmentDigest = mathDigest('collaboration layers fixture');
const task = (id: string, extra: Partial<WebInspectedTask>): WebInspectedTask => ({ id, kind: 'lemma', objective: `Objective ${id}`, group: 'main',
  status: 'pending', control: 'active', version: `${id}-v1`, premises: [], plannedDependencies: [], attempts: 0, proof: { status: 'none' },
  parkedBy: [], parkedRoutes: {}, ...extra });
const worker = (id: string, role: string, status: string, extra: Partial<WebInspectedWorker> = {}): WebInspectedWorker => ({ id, role, phase: 'running', turns: 2,
  scheduling: { status, since: 0 }, dispatchWait: { status: 'unknown' }, ...extra });
function observation(id: string, ended: boolean): WebObservation {
  const tasks = [task('main_goal', { kind: 'goal', theorem: 'Fixture.main', type: 'True', plannedDependencies: ['bridge'] }),
    task('bridge', { theorem: 'Fixture.bridge', type: 'True', status: 'running', owner: 'prover-1', objective: `Close the bridge lemma ${raw}` }),
    task('base', { theorem: 'Fixture.base', type: 'True', status: 'integrated', attempts: 1, proof: { status: 'checked' } })];
  const workers = ended ? [] : [worker('prover-1', 'prover', 'working', { task: 'bridge' }), worker('researcher-1', 'researcher', 'idle'), worker('lead', 'lead', 'idle')];
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `solver-${id}`, stateDigest: mathDigest(id), resultDigest: null };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: new Date().toISOString(), sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, plan: null, sources: [], checks: [], guidance: [],
    coverage: { sources: 'recorded', checks: 'recorded' },
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: ended ? 'finished' : 'cooperative',
      problem: { id: 'collaboration-layers', statement: 'Prove main', formalStatement: 'theorem main : True := by sorry', assumptions: [], targets: [{ proofPath: 'Submission.lean', theoremName: 'Fixture.main' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 3, coordination: 'cooperative', buildDigest: mathDigest('build'), environmentDigest },
      turns: 3, scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: workers.length, working: ended ? 0 : 1, proofAssignments: ended ? 0 : 1,
        preparing: 0, stopping: 0, idle: ended ? 0 : 2, stopped: 0 },
      ...(ended ? {} : { waiting: { reason: `Need a new idea for the bridge ${raw}`, taskIds: ['bridge'], goalIds: ['main_goal'], inputDigest: mathDigest('wait') } }),
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded',
        droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'theoremos.obligation-snapshot.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: mathDigest('obligations'),
        environmentDigest, obligations: [], routes: [], advisory: [],
        goals: [{ taskId: 'main_goal', taskDigest: 'main_goal-v1', closed: false, frontier: [{ taskId: 'bridge', taskDigest: 'bridge-v1' }], missingDependencies: [] }],
        blockers: [] }, recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 1, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['main_goal', 'bridge'] },
      groups: [], tasks, workers, statementReviews: [], edits: [] } };
}
const finishers = new Map<string, () => void>();
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local collaboration layers fixture; no model or Lean' }; },
  async run(input, send, signal) {
    if (input.input.task.includes('stuck')) {
      send({ type: 'observation', observation: observation(input.id, true) });
      send({ type: 'result', result: { status: 'limit_reached', proof: '', report: { status: 'limit_reached', reason: 'math_run_stopped' } } });
      return;
    }
    send({ type: 'observation', observation: observation(input.id, false) });
    await new Promise<void>(resolve => { finishers.set(input.id, resolve); signal.addEventListener('abort', () => resolve(), { once: true }); });
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const input = (task: string): WebRunInput => ({ providerId: 'openai', apiKey: 'sk-local-collaboration-layers-fixture', model: 'fixture', effort: 'low',
  environment: 'standard', source: 'theorem main : True := by sorry', task, maxTurns: 2, maxRunSeconds: 60, workers: 3, coordination: 'cooperative' });
type Harness = ScenarioHarness;
const screenshots: string[] = [];
function scenario(name: string, run: (h: Harness) => Promise<void>, options: { width?: number; locale?: 'zh' | 'en' } = {}) {
  const { width = 1440, locale = 'zh' } = options;
  return webScenario<Harness>(browser, suite, name, run, {
    context: { viewport: { width, height: width > 850 ? 1000 : 812 }, reducedMotion: 'reduce' }, collaborationDetail: 'simple',
    init: context => context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, locale] as const),
    harness: (page, context) => ({ page, context, requests: [] }), routes: { local: 'Collaboration layers must stay local' }, open: true,
    timeout: { label: 'Collaboration layers', seconds: 50 },
    // Running fixtures hold service slots; release them so later scenarios are not queued.
    cleanup: () => { for (const finish of finishers.values()) finish(); finishers.clear(); },
  });
}
const surface = '#detail-panel .collab-surface';
async function open(h: Harness, task: string, tab: 'collaboration' | 'result' = 'collaboration') {
  const run = await postRun(h, input(task));
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await h.page.evaluate(async id => (await (await fetch(`/api/runs/${id}`)).json()).run, run.id);
    if (value.observation && (!task.includes('stuck') || value.status === 'completed')) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await refreshHistory(h.page); await selectHistoryRun(h.page, run.id);
  await h.page.locator(`#detail-tab-${tab}`).click();
  await h.page.locator(`#detail-panel[data-tab="${tab}"]`).waitFor();
  return run;
}
const stored = (page: Page) => page.evaluate(key => localStorage.getItem(key), collaborationDetailStorageKey);
const hidden = (page: Page, selector: string) => page.locator(`${surface} ${selector}`).first().isHidden();
const focused = (page: Page) => page.evaluate(() => { const node = document.activeElement as HTMLElement | null;
  return node?.dataset.collabDetail ?? (node?.hasAttribute('data-inspected-task-heading') ? 'inspected-task' : node?.tagName ?? null); });
const noXss = (page: Page) => page.evaluate(() => (globalThis as { __layersXss?: number }).__layersXss).then(value => assert.equal(value, undefined));
const expert = ['.collab-inspector', '.collab-map-tools', '.collab-observation-line', '.collab-research-overview', '.collab-reviews', '.collab-agents', '.collab-deliveries', '[data-collab-records]', '.collab-knowledge'];

try {
  await scenario('a first visit keeps navigation and available actions visible while advanced reading stays folded', async h => {
    const { page } = h; await open(h, 'Keep working');
    await page.locator(`${surface} .collab-now-worker`).first().waitFor();
    assert.equal(await page.locator(surface).getAttribute('data-detail'), 'simple');
    const now = await page.locator(`${surface} .collab-now`).innerText();
    for (const value of ['现在在做什么', 'Prover', '研究中', 'bridge →', `Close the bridge lemma ${raw}`, '研究正在等待新的数学输入',
      `Need a new idea for the bridge ${raw}`, '可以在下方提供指导', '另有 2 个 Agent 空闲、准备中或已停止。']) assert.ok(now.includes(value), `now shows ${value}`);
    assert.ok(!now.includes('Researcher'), 'idle Agents are counted, not listed');
    assert.ok(!now.includes('prover-1'), 'working Agents are named by role');
    for (const selector of expert) assert.equal(await hidden(page, selector), true, `${selector} is hidden in the simple layer`);
    for (const selector of ['[data-collab-summary]', '.collab-agent-route', '.collab-graph', '.collab-guidance', '.collab-expand', '[data-collab-refresh]', '.collab-navigation', '[data-collab-plan]', '[data-collab-archive]'])
      assert.equal(await hidden(page, selector), false, `${selector} stays in the simple layer`);
    assert.equal(await page.locator('[data-collab-plan]').isDisabled(), true, 'editing waits for a recorded plan');
    assert.equal(await page.locator('[data-collab-archive]').isDisabled(), false, 'an observed connected run can be archived');
    assert.match(await page.locator('[data-collab-jump="reviews"]').innerText(), /原意与 Lean/);
    assert.equal(await page.locator(`${surface} .collab-detail-toggle [data-collab-detail="simple"]`).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator(`${surface} img`).count(), 0); await noXss(page);
    assert.equal(await stored(page), null, 'looking does not store a choice');
    await settled(page); await page.screenshot({ path: path.join(output, 'simple-1440.png') }); screenshots.push('simple-1440.png');
    await page.locator('#detail-panel').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await settled(page);
    assert.equal(await page.locator('[data-collab-jump="knowledge"]').getAttribute('aria-current'), null, 'hidden knowledge does not become the current section at the bottom of the simple view');
  });

  await scenario('visible navigation opens the saved intent and Lean comparison from the simple layer', async h => {
    const { page } = h; await open(h, 'Keep working');
    await page.locator('[data-collab-jump="reviews"]').click();
    await page.locator(`${surface} .collab-reviews`).waitFor();
    assert.equal(await page.locator(surface).getAttribute('data-detail'), 'full');
    assert.equal(await page.locator('[data-review-heading]').evaluate(node => node === document.activeElement), true);
    assert.match(await page.locator('[data-review-list]').innerText(), /尚无声明审阅记录/);
  });

  await scenario('the toggle switches layers in place and the choice survives a reload', async h => {
    const { page } = h, run = await open(h, 'Keep working');
    const full = page.locator(`${surface} .collab-detail-toggle [data-collab-detail="full"]`);
    await full.click();
    await page.locator(`${surface} .collab-layout`).waitFor();
    assert.equal(await full.getAttribute('aria-pressed'), 'true');
    assert.equal(await focused(page), 'full', 'focus stays on the toggle');
    for (const selector of ['.collab-now', '.collab-expand']) assert.equal(await hidden(page, selector), true, `${selector} leaves the full layer`);
    assert.equal(await stored(page), 'full');
    await page.reload(); await page.locator('#submit-run:enabled').waitFor({ state: 'attached' });
    await selectHistoryRun(page, run.id); await page.locator('#detail-tab-collaboration').click();
    await page.locator(`${surface} .collab-layout`).waitFor();
    assert.equal(await page.locator(surface).getAttribute('data-detail'), 'full');
    await page.locator(`${surface} .collab-detail-toggle [data-collab-detail="simple"]`).click();
    await page.locator(`${surface} .collab-now`).waitFor();
    assert.equal(await focused(page), 'simple'); assert.equal(await stored(page), 'simple');
  });

  await scenario('opening a task from the simple layer switches to full and lands on the task', async h => {
    const { page } = h; await open(h, 'Keep working');
    await page.locator(`${surface} .collab-now`).getByRole('button', { name: '查看任务 bridge' }).click();
    await page.locator('[data-inspected-task-heading]').filter({ hasText: 'bridge' }).waitFor();
    assert.equal(await page.locator(surface).getAttribute('data-detail'), 'full');
    assert.equal(await focused(page), 'inspected-task'); assert.equal(await stored(page), 'full');
  });

  await scenario('the footer link opens the full view at the task map', async h => {
    const { page } = h; await open(h, 'Keep working');
    await page.locator(`${surface} .collab-expand button`).click();
    await page.locator(`${surface} .collab-layout`).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.collab-map') !== null && document.activeElement?.tagName === 'H3'), true, 'focus lands on the task map heading');
  });

  await scenario('an ended result opens its stuck task in the full collaboration view', async h => {
    const { page } = h; await open(h, 'Stop when stuck');
    const ended = page.locator(`${surface} .collab-now-ended`);
    await ended.waitFor({ state: 'attached' });
    // The run stopped on its time budget before any acceptance, so the line says that rather than that acceptance failed.
    assert.ok((await ended.innerText()).includes('研究已结束：解题时间用完，没有得到通过验收的完整证明。'));
    for (const selector of ['.collab-now', '.collab-guidance', '[data-collab-refresh]'])
      assert.equal(await hidden(page, selector), true, `${selector} leaves the simple layer once the run ends`);
    const summary = await page.locator(`${surface} [data-collab-summary]`).innerText();
    assert.ok(summary.includes('参与了这次研究') && !summary.includes('实际工作中') && !summary.includes('S3'), 'an ended run counts who took part, without module codes');
    assert.ok(summary.includes('没有验收结果') && !summary.includes('尚未验收通过'), 'a run that stopped before acceptance promises no verdict to come');
    await page.locator('#detail-tab-result').click();
    // The report is part of 结果; the button opens that tab at the report.
    await page.locator('#detail-panel[data-tab="result"] .report-stuck').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'detail-tab-result');
    await page.locator('#detail-panel .report-stuck').getByRole('button', { name: '在协作中查看' }).first().click();
    await page.locator('[data-inspected-task-heading]').filter({ hasText: 'bridge' }).waitFor();
    assert.equal(await page.locator(surface).getAttribute('data-detail'), 'full');
    assert.equal(await focused(page), 'inspected-task');
  });

  await scenario('an ended run keeps guidance history reachable without enabling another submission', async h => {
    const { page } = h; await open(h, 'Stop when stuck');
    assert.equal(await hidden(page, '.collab-guidance'), true);
    await page.locator('[data-collab-jump="guidance"]').click();
    await page.locator(`${surface} .collab-guidance`).waitFor();
    assert.equal(await page.locator(surface).getAttribute('data-detail'), 'full');
    assert.equal(await page.locator('.collab-guidance button[type="submit"]').isDisabled(), true);
    assert.match(await page.locator('.collab-guidance').innerText(), /运行尚未开始或已结束/);
  });

  await scenario('the simple layer reads in English', async h => {
    const { page } = h; await open(h, 'Keep working');
    await page.locator(`${surface} .collab-now-worker`).first().waitFor();
    const text = await page.locator(surface).innerText();
    for (const value of ['What is happening now', 'Simple', 'Detailed', 'Research is waiting for new mathematical input',
      '2 more Agents are idle, preparing or stopped.', 'Show the full collaboration view']) assert.ok(text.includes(value), `English shows ${value}`);
  }, { locale: 'en' });

  for (const width of [375, 320]) await scenario(`the simple layer fits ${width}px`, async h => {
    const { page } = h; await open(h, 'Keep working');
    await page.locator(`${surface} .collab-now-worker`).first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'the simple layer must not widen the document');
    for (const selector of ['.collab-now', '.collab-now-worker', '.collab-detail-toggle', '.collab-expand', '.collab-navigation']) {
      const box = await page.locator(`${surface} ${selector}`).first().boundingBox();
      assert.ok(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1, `${selector} must fit ${width}px: ${JSON.stringify(box)}`);
    }
    await settled(page); await page.screenshot({ path: path.join(output, `simple-${width}.png`) }); screenshots.push(`simple-${width}.png`);
  }, { width });

  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined, 'local-real-http-collaboration-layers',
    { checks: suite.checks, leanProcesses: 0, screenshots }, { credential: 'sk-local-collaboration-layers-fixture' });
  console.log('Collaboration layers browser checks passed');
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-collaboration-layers',
    { checks: suite.checks, leanProcesses: 0 }, { credential: 'sk-local-collaboration-layers-fixture', failureRequests: true }); throw error;
} finally {
  for (const finish of finishers.values()) finish();
  await browser.close(); await service.close();
}
