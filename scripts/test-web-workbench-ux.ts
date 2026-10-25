#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput } from '../apps/web/shared';
import type { WebCommand, WebInspectedTask, WebMathematicalChange, WebObservation, WebPlanTask } from '../apps/web/collaboration';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { taskVersion } from '../src/solver/tasks';
import { buildTheoremKnowledge } from '../src/solver/theoremKnowledge';
import { refreshHistory, selectHistoryRun } from './web-ui-controls';
import { deferred, freePort, postRun, settled, startBrowser, webScenario, writeScenarioReport,
  type ScenarioHarness, type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-workbench-ux');
await fs.mkdir(output, { recursive: true });
const now = () => new Date().toISOString(), environmentDigest = mathDigest('local workbench usability fixture');
const commit = mathDigest('workbench fixture commit').slice(0, 40);
const longText = Array.from({ length: 100 }, (_, i) => `reading-line-${i}: retain this mathematical reasoning while moving to guidance`).join('\n');
const base: WebPlanTask = { id: 'base', kind: 'lemma', objective: 'Prove the reusable reflexivity premise', dependsOn: [], revision: 0,
  proofPath: 'Submission.lean', theoremName: 'base', type: '∀ (n : Nat), n = n', premises: [longText] };
const original: WebPlanTask = { id: 'original', kind: 'goal', objective: 'Prove the frozen original theorem', dependsOn: ['base'], revision: 0,
  proofPath: 'Submission.lean', theoremName: 'original', type: 'True' };
const baseVersion = taskVersion(base);
const catalog = buildTheoremKnowledge([{ name: 'known_reflexivity', file: 'Knowledge.lean', type: '∀ (n : Nat), n = n',
  typeKind: 'closed-task-type', kind: 'lemma', description: 'Local historical theorem for usability checks', premises: [],
  dependencies: { statement: [], proof: [], tasks: [], coverage: 'recorded' },
  files: { 'Knowledge.lean': 'theorem known_reflexivity (n : Nat) : n = n := by rfl\n' },
  provenance: { kind: 'solver-check', problemId: 'workbench-ux-fixture', source: 'simulated saved proof receipt',
    sourceDigest: mathDigest('known reflexivity source'), sourceCommit: commit, receiptIds: ['knowledge-check'], environmentDigest } }]);
type Control = { observation: WebObservation; emit(): void; finish(): void };
type Harness = ScenarioHarness & { runIds: string[]; effect?: (route: Route) => Promise<boolean> };
const controls = new Map<string, Control>();
const commands: { runId: string; command: WebCommand }[] = [];
const inspected = (task: WebPlanTask): WebInspectedTask => ({ id: task.id, kind: task.kind, objective: task.objective,
  version: taskVersion(task), theorem: task.theoremName, type: task.type, group: 'main', status: 'pending', control: 'active',
  premises: task.premises ?? [], plannedDependencies: task.dependsOn, attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} });
const baseline: WebMathematicalChange = { schema: 'theoremos.obligation-progress.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
  kind: 'baseline', at: 1_700_000_000_000, afterDigest: mathDigest('ux-baseline'), environmentChanged: false,
  obligations: { new: [], closed: [], reopened: [], removed: [], changed: [] }, goalFrontiers: [],
  blockers: { new: [], parked: [], reopened: [], superseded: [], removed: [], changed: [] }, routes: [],
  advisory: { proposed: [], completed: [], reopened: [], removed: [], changed: [] } };
function observation(id: string): WebObservation {
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `solver-${id}`, stateDigest: mathDigest(id), resultDigest: null };
  const source = 'theorem base (n : Nat) : n = n := by rfl\n';
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1,
    snapshot, evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: structuredClone([base, original]) },
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
      problem: { id: 'workbench-ux-fixture', statement: 'Prove the frozen original theorem', formalStatement: 'True', assumptions: [],
        targets: [{ proofPath: 'Submission.lean', theoremName: 'original' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 3, coordination: 'cooperative', buildDigest: mathDigest('ux-build'), environmentDigest },
      turns: 1, planVersion: 'plan-v1', scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 3, working: 0,
        proofAssignments: 0, preparing: 0, stopping: 0, idle: 3, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded',
        droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'theoremos.obligation-snapshot.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
        digest: baseline.afterDigest, environmentDigest, obligations: [], goals: [], blockers: [], routes: [], advisory: [] },
        recentChanges: [structuredClone(baseline)], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['base', 'original'] },
      groups: [], tasks: [base, original].map(inspected), workers: [
        { id: 'lead', role: 'lead', sessionRole: 'lead', phase: 'waiting', turns: 1, dispatchWait: { status: 'unknown' } },
        { id: 'researcher', role: 'researcher', phase: 'waiting', turns: 1, task: 'base', dispatchWait: { status: 'unknown' } },
        { id: 'engineer', role: 'engineer', phase: 'waiting', turns: 1, dispatchWait: { status: 'unknown' } }],
      statementReviews: Array.from({ length: 18 }, (_, i) => ({ id: `review-${i}`, taskId: 'base', version: baseVersion,
        status: 'accepted', snapshotDigest: mathDigest(`statement-${i}`), environmentDigest, commit,
        intendedStatement: 'For every natural number n, n equals itself.', leanStatement: 'theorem base : ∀ (n : Nat), n = n',
        translation: { mathematics: longText, assumptions: [], definitions: [], evidenceRefs: [] },
        summary: `Retained reflexivity review ${i}` })), edits: [] },
    sources: [{ taskId: 'base', taskVersion: baseVersion, commit, sourceDigest: mathDigest(source), environmentDigest,
      file: 'Submission.lean', scope: 'owned-file', source }],
    checks: [{ id: 'base-check', taskId: 'base', taskVersion: baseVersion, commit, sourceDigest: mathDigest(source), environmentDigest,
      record: { status: 'kernel_verified', passed: true, receiptId: 'base-check', simulated: true } }],
    guidance: [], deliveries: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local workbench usability fixture; no model or Lean' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), finish: resolve, emit() {
        this.observation = { ...this.observation, sequence: this.observation.sequence + 1, observedAt: now() };
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true });
      send({ type: 'catalog', catalog }); control.emit();
    });
  },
  async command(runId, command) {
    commands.push({ runId, command: structuredClone(command) }); const control = controls.get(runId)!;
    if (command.type === 'capture') return { id: 'capture', status: 'captured', observation: structuredClone(control.observation), catalog };
    if (command.type !== 'guidance') throw new Error('Usability fixture does not accept plan changes');
    const guidance = { ...command.guidance, status: 'queued' as const, createdAt: now(), updatedAt: now() };
    control.observation.guidance.push(guidance); control.emit();
    return { id: guidance.id, status: guidance.status, guidance, observation: structuredClone(control.observation) };
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-local-workbench-ux-fixture', model: 'fixture', effort: 'low',
  environment: 'standard', source: 'theorem original : True := by sorry\n', task: 'Inspect mathematical workbench usability',
  maxTurns: 2, maxRunSeconds: 60, workers: 3, coordination: 'cooperative' };
const sections = ['overview', 'tasks', 'reviews', 'changes', 'agents', 'deliveries', 'guidance', 'records', 'knowledge'] as const;
type Section = typeof sections[number];
const panel = '#detail-panel', text = '[data-guidance-text]', back = '[data-collab-return]';
const navButton = (id: Section) => `[data-collab-jump="${id}"]`;
const section = (id: Section) => `[data-collab-section="${id}"]`;
const heading = (page: Page, id: Section) => page.locator(section(id)).locator('h2,h3,h4').first();
const focused = (page: Page, selector: string) => page.locator(selector).evaluate(node => document.activeElement === node);
async function create(h: Harness, title = input.task) {
  const run = await postRun(h, { ...input, task: title }); h.runIds.push(run.id);
  await refreshHistory(h.page); await selectHistoryRun(h.page, run.id);
  await h.page.locator('.collab-navigation').waitFor(); await h.page.locator('[data-review-id="review-0"]').waitFor(); return run;
}
async function poll(page: Page) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/runs' && r.request().method() === 'GET');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await response; await settled(page);
}
async function jump(page: Page, id: Section) {
  if (page.viewportSize()!.width <= 850) await page.locator('[data-collab-section-picker]').selectOption(id);
  else await page.locator(navButton(id)).click();
  await settled(page);
}
async function visibleHeading(page: Page, id: Section) {
  const title = await heading(page, id).boundingBox(), navigation = await page.locator('.collab-navigation').boundingBox();
  const viewport = await page.locator(panel).boundingBox();
  assert.ok(title && navigation && viewport, `${id} has a visible heading and navigation`);
  assert.ok(title.y >= navigation.y + navigation.height - 2, `${id} heading is below sticky navigation: ${JSON.stringify({ title, navigation })}`);
  assert.ok(title.y + title.height <= viewport.y + viewport.height + 1, `${id} heading remains inside the workbench viewport`);
  assert.equal(await page.evaluate(() => window.scrollX === 0 && window.scrollY === 0), true, 'navigation must scroll the detail panel, not the document');
}
async function returnTo(page: Page, selector: string) {
  assert.equal(await page.locator(back).isVisible(), true, 'guidance provides a return control');
  await page.locator(back).click(); await settled(page); assert.equal(await focused(page, selector), true, `return restores ${selector} focus`);
}
async function panelPosition(page: Page) { return page.locator(panel).evaluate(node => node.scrollTop); }
async function fit(page: Page, selectors: string[]) {
  const width = page.viewportSize()!.width;
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'workbench fits viewport');
  for (const selector of selectors) {
    const box = await page.locator(selector).boundingBox(); assert.ok(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1,
      `${selector} fits ${width}px: ${JSON.stringify(box)}`);
  }
}
function scenario(name: string, run: (h: Harness) => Promise<void>, width = 1440) {
  return webScenario(browser, suite, name, run, {
    context: { viewport: { width, height: width > 850 ? 1000 : 812 }, reducedMotion: 'reduce' },
    harness: (page, context) => {
      const h: Harness = { page, context, requests: [], runIds: [] };
      h.intercept = async route => await h.effect?.(route) ?? false; return h;
    },
    routes: { local: 'Workbench usability checks must stay on the local HTTP fixture' }, open: true,
    timeout: { label: 'Workbench usability', seconds: 60 },
    verify: (h, elapsedMs) => ({ name, elapsedMs: elapsedMs(), requests: h.requests }),
    cleanup: h => { for (const id of h.runIds) controls.get(id)?.finish(); },
  });
}

try {
  await scenario('unchanged polling retains reading state and tab changes do not duplicate observation reads', async h => {
    const { page } = h; await create(h); await jump(page, 'guidance');
    await page.locator(text).fill('Keep this draft and focus while synchronizing');
    const before = await panelPosition(page), draftNode = await page.locator(text).elementHandle();
    const unchanged = page.waitForResponse(r => new URL(r.url()).pathname === '/api/runs' && r.request().method() === 'GET');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const response = await unchanged; await settled(page);
    assert.equal(response.status(), 304, 'unchanged state needs no run list or observation body');
    assert.ok(response.request().headers()['if-none-match'], 'poll sends its last accepted representation version');
    assert.equal(await draftNode!.evaluate(node => node === document.querySelector('[data-guidance-text]')), true);
    assert.equal(await focused(page, text), true); assert.equal(await panelPosition(page), before);
    assert.equal(await page.locator(text).inputValue(), 'Keep this draft and focus while synchronizing');
    await page.locator('#detail-tab-source').click(); await page.locator('#detail-tab-collaboration').click(); await poll(page);
    const observationReads = () => h.requests.filter(r => r.method === 'GET' && r.pathname.endsWith('/observation')).length;
    assert.equal(observationReads(), 0, 'embedded observations are the sole automatic observation channel');
    await page.locator('[data-collab-refresh]').click(); await page.locator('[data-collab-refresh]:enabled').waitFor();
    assert.equal(observationReads(), 1, 'explicit observation refresh still reads the backend exactly once');
    await poll(page); assert.equal(observationReads(), 1, 'polling does not duplicate a manual read');
    await draftNode!.dispose();
  });

  await scenario('desktop navigation reaches every section with visible focused headings and a sticky local scroll', async h => {
    const { page } = h; await create(h);
    assert.equal(await page.locator('.collab-navigation').evaluate(node => getComputedStyle(node).position), 'sticky');
    for (const id of [...sections].reverse()) {
      assert.equal(await heading(page, id).getAttribute('tabindex'), '-1'); await jump(page, id); await visibleHeading(page, id);
      assert.equal(await heading(page, id).evaluate(node => document.activeElement === node), true, `${id} heading receives focus`);
      assert.equal(await page.locator(navButton(id)).getAttribute('aria-current'), 'location');
      const nav = await page.locator('.collab-navigation').boundingBox(), viewport = await page.locator(panel).boundingBox();
      assert.ok(nav && viewport && Math.abs(nav.y - viewport.y) <= 28, 'navigation stays at the detail panel top');
    }
    await jump(page, 'reviews'); await page.screenshot({ path: path.join(output, 'desktop.png') });
    assert.equal(h.requests.some(r => r.method !== 'GET' && r.pathname !== '/api/runs'), false);
  });

  await scenario('task and Agent guidance return to their entry and keep separate drafts and return state per run', async h => {
    const { page } = h, runA = await create(h, 'Workbench usability run A');
    await jump(page, 'tasks'); await page.locator('.collab-graph [data-collab-task="base"]').click();
    await page.locator('[data-collab-task-search]').fill('base');
    const sourceButton = '[data-collab-guide-task]'; await page.locator(sourceButton).scrollIntoViewIfNeeded();
    const inspectorTop = await page.locator('.collab-inspector').evaluate(node => { node.scrollTop = 135; return node.scrollTop; });
    const before = await panelPosition(page); await page.locator(sourceButton).click();
    assert.equal(await focused(page, text), true); assert.equal(await page.locator('[data-guidance-kind]').inputValue(), 'task');
    assert.equal(await page.locator('[data-guidance-target]').inputValue(), 'base'); await page.locator(text).fill('Retain run A task guidance');
    controls.get(runA.id)!.emit(); await poll(page); assert.equal(await focused(page, text), true, 'polling does not steal guidance focus');
    await returnTo(page, sourceButton);
    assert.ok(Math.abs(await panelPosition(page) - before) <= 2, 'task return restores outer reading position');
    assert.equal(await page.locator('.collab-inspector').evaluate(node => node.scrollTop), inspectorTop);
    assert.equal(await page.locator('[data-collab-task-search]').inputValue(), 'base');
    assert.equal(await page.locator('.collab-graph [data-collab-task="base"]').getAttribute('aria-pressed'), 'true');
    await jump(page, 'agents'); const workerButton = '[data-collab-guide-worker="researcher"]';
    await page.locator(workerButton).click(); assert.equal(await focused(page, text), true);
    assert.equal(await page.locator('[data-guidance-target]').inputValue(), 'researcher'); assert.equal(await page.locator(text).inputValue(), 'Retain run A task guidance');
    const runB = await create(h, 'Workbench usability run B'); await jump(page, 'guidance');
    assert.equal(await page.locator(text).inputValue(), ''); assert.equal(await page.locator('[data-guidance-kind]').inputValue(), 'lead');
    await page.locator(text).fill('Separate run B draft'); await selectHistoryRun(page, runA.id);
    assert.equal(await page.locator(text).inputValue(), 'Retain run A task guidance'); assert.equal(await page.locator('[data-guidance-target]').inputValue(), 'researcher');
    await returnTo(page, workerButton); await page.locator('[data-collab-nav-guide]').click();
    assert.equal(await focused(page, text), true); assert.equal(await page.locator('[data-guidance-kind]').inputValue(), 'worker');
    assert.equal(await page.locator('[data-guidance-target]').inputValue(), 'researcher'); assert.equal(await page.locator(text).inputValue(), 'Retain run A task guidance');
    await selectHistoryRun(page, runB.id); assert.equal(await page.locator(text).inputValue(), 'Separate run B draft');
  });

  await scenario('review, mathematical change and knowledge references navigate to guidance and return without losing filters or nested reading', async h => {
    const { page } = h, run = await create(h); await jump(page, 'agents'); await page.locator('[data-collab-guide-worker="researcher"]').click();
    await page.locator(text).fill('Existing human guidance'); await jump(page, 'reviews');
    await page.locator('[data-review-task]').selectOption('base'); await page.locator('[data-review-status]').selectOption('accepted');
    await page.locator('[data-review-query]').fill('reflexivity'); await page.locator('[data-review-id="review-5"]').click();
    const reading = '[data-review-detail] [data-review-text-key$="-translation"]';
    const innerTop = await page.locator(reading).evaluate(node => { node.scrollTop = 280; return node.scrollTop; }); assert.ok(innerTop > 0);
    const reference = '[data-review-reference]'; await page.locator(reference).scrollIntoViewIfNeeded(); const before = await panelPosition(page);
    const selected = await page.locator('[data-review-key][aria-pressed="true"]').getAttribute('data-review-key'); await page.locator(reference).click();
    assert.equal(await focused(page, text), true); assert.equal(await page.locator('[data-guidance-target]').inputValue(), 'researcher');
    assert.match(await page.locator(text).inputValue(), /Existing human guidance/); assert.match(await page.locator(text).inputValue(), /review-5/);
    controls.get(run.id)!.emit(); await poll(page); assert.equal(await focused(page, text), true);
    await returnTo(page, reference); assert.ok(Math.abs(await panelPosition(page) - before) <= 2);
    assert.equal(await page.locator(reading).evaluate(node => node.scrollTop), innerTop);
    assert.equal(await page.locator('[data-review-query]').inputValue(), 'reflexivity');
    assert.equal(await page.locator('[data-review-task]').inputValue(), 'base'); assert.equal(await page.locator('[data-review-status]').inputValue(), 'accepted');
    assert.equal(await page.locator('[data-review-key][aria-pressed="true"]').getAttribute('data-review-key'), selected);
    await jump(page, 'changes'); await page.locator('[data-math-category]').selectOption('baseline'); await page.locator('[data-math-query]').fill(baseline.afterDigest.slice(0, 8));
    await page.locator('[data-math-reference]').click(); assert.equal(await focused(page, text), true); assert.match(await page.locator(text).inputValue(), /数学变化记录/);
    await returnTo(page, '[data-math-reference]'); assert.equal(await page.locator('[data-math-category]').inputValue(), 'baseline');
    assert.equal(await page.locator('[data-math-query]').inputValue(), baseline.afterDigest.slice(0, 8));
    await jump(page, 'knowledge'); await page.locator('#knowledge-search').fill('known_reflexivity'); await page.locator('.collab-knowledge-search button').click();
    await page.locator('.collab-knowledge-hit').getByText('known_reflexivity', { exact: true }).click();
    await page.locator('[data-knowledge-reference]').click(); assert.equal(await focused(page, text), true);
    assert.match(await page.locator(text).inputValue(), new RegExp(catalog.entries[0]!.id));
    assert.equal(await page.locator('[data-guidance-kind]').inputValue(), 'worker'); assert.equal(await page.locator('[data-guidance-target]').inputValue(), 'researcher');
    await returnTo(page, '[data-knowledge-reference]'); assert.equal(await page.locator('#knowledge-search').inputValue(), 'known_reflexivity');
    assert.equal(h.requests.some(r => r.method !== 'GET' && r.pathname !== '/api/runs'), false, 'references never submit runtime commands');
  });

  await scenario('delayed source and check reads reveal loading immediately and completion never steals focus, including from a different run', async h => {
    const { page } = h, run = await create(h), control = controls.get(run.id)!;
    // The real server retains the first observation's source. The latest observation no longer inlines it.
    control.observation.sources = []; control.emit(); await poll(page); await jump(page, 'tasks');
    await page.locator('.collab-graph [data-collab-task="base"]').click();
    const sourceSeen = deferred(), sourceRelease = deferred();
    h.effect = async route => {
      if (!new URL(route.request().url()).pathname.endsWith('/tasks/base/source')) return false;
      sourceSeen.resolve(); await sourceRelease.promise; return false;
    };
    try {
      await page.locator('[data-collab-source="base"]').click(); await sourceSeen.promise;
      await page.locator('[data-collab-artifact]').getByText(/正在读取/).waitFor();
      assert.equal(await focused(page, '[data-collab-artifact-heading]'), true); await visibleArtifact(page);
      await page.locator('[data-collab-task-search]').fill('base'); const position = await panelPosition(page);
      sourceRelease.resolve(); await page.locator('[data-task-source-host]').waitFor();
      assert.equal(await focused(page, '[data-collab-task-search]'), true, 'source completion does not take focus from new work');
      assert.equal(await panelPosition(page), position, 'source completion does not jump to the artifact again');
    } finally { sourceRelease.resolve(); }
    const checkSeen = deferred(), checkRelease = deferred(); h.effect = async route => {
      if (!new URL(route.request().url()).pathname.endsWith('/checks/base-check')) return false;
      checkSeen.resolve(); await checkRelease.promise; return false;
    };
    try {
      await page.locator('[data-collab-check="base-check"]').click(); await checkSeen.promise;
      assert.equal(await focused(page, '[data-collab-artifact-heading]'), true); await visibleArtifact(page);
      await page.locator('[data-collab-nav-guide]').click(); await page.locator(text).fill('Keep working while a check arrives');
      checkRelease.resolve(); await page.locator('[data-collab-artifact]').getByText(/kernel_verified/).waitFor();
      assert.equal(await focused(page, text), true); assert.equal(await page.locator(text).inputValue(), 'Keep working while a check arrives');
    } finally { checkRelease.resolve(); }
    const lateSeen = deferred(), lateRelease = deferred(); h.effect = async route => {
      if (!new URL(route.request().url()).pathname.endsWith('/checks/base-check')) return false;
      lateSeen.resolve(); await lateRelease.promise; return false;
    };
    try {
      await jump(page, 'tasks'); await page.locator('[data-collab-check="base-check"]').click(); await lateSeen.promise;
      const other = await create(h, 'Other run during an artifact read'); await jump(page, 'guidance'); await page.locator(text).fill('Other run remains current');
      const position = await panelPosition(page);
      const lateResponse = page.waitForResponse(r => new URL(r.url()).pathname === `/api/runs/${run.id}/checks/base-check`); lateRelease.resolve();
      await lateResponse; await settled(page);
      assert.equal(await focused(page, text), true); assert.equal(await panelPosition(page), position);
      assert.equal(await page.locator(text).inputValue(), 'Other run remains current'); assert.notEqual(other.id, run.id);
      assert.equal(await page.locator('[data-collab-artifact-heading]').count(), 0, 'old run artifact is not mounted in the current run');
    } finally { lateRelease.resolve(); }
  });

  await scenario('refresh and archive expose busy states and preserve success or failure feedback across observations', async h => {
    const { page } = h, run = await create(h), control = controls.get(run.id)!;
    assert.equal(await page.locator('[data-collab-status]').getAttribute('role'), 'status');
    assert.equal(await page.locator('[data-collab-observation]').count(), 1);
    await page.locator('[data-collab-refresh]:enabled').waitFor();
    const seen = deferred(), release = deferred(); let intercepted = 0;
    h.effect = async route => {
      if (!new URL(route.request().url()).pathname.endsWith('/observation')) return false;
      intercepted++; seen.resolve(); await release.promise; return false;
    };
    try {
      await page.locator('[data-collab-refresh]').click(); await seen.promise;
      assert.match(await page.locator('[data-collab-refresh]').innerText(), /刷新中/); assert.equal(await page.locator('[data-collab-refresh]').isDisabled(), true);
      await page.locator('[data-collab-refresh]').evaluate(node => (node as HTMLButtonElement).click()); await settled(page); assert.equal(intercepted, 1);
      release.resolve(); await page.locator('[data-collab-refresh]:enabled').waitFor();
    } finally { release.resolve(); }
    h.effect = undefined; const refreshed = await page.locator('[data-collab-status]').innerText(); assert.match(refreshed, /刷新|更新/);
    control.emit(); await poll(page); assert.equal(await page.locator('[data-collab-status]').innerText(), refreshed);
    h.effect = async route => {
      if (!new URL(route.request().url()).pathname.endsWith('/observation')) return false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture observation unavailable' }) }); return true;
    };
    await page.locator('[data-collab-refresh]').click(); await page.locator('[data-collab-refresh]:enabled').waitFor();
    const failed = await page.locator('[data-collab-status]').innerText(); assert.match(failed, /Fixture observation unavailable|503|失败/);
    h.effect = undefined; control.emit(); await poll(page); assert.equal(await page.locator('[data-collab-status]').innerText(), failed);
    const archiveSeen = deferred(), archiveRelease = deferred(); h.effect = async route => {
      if (route.request().method() !== 'POST' || !new URL(route.request().url()).pathname.endsWith('/archive')) return false;
      archiveSeen.resolve(); await archiveRelease.promise; return false;
    };
    try {
      await page.locator('[data-collab-archive]').click(); await archiveSeen.promise; assert.equal(await page.locator('[data-collab-archive]').isDisabled(), true);
      archiveRelease.resolve(); await page.locator('[data-collab-show-archive]').waitFor();
    } finally { archiveRelease.resolve(); }
    h.effect = undefined; const archived = await page.locator('[data-collab-status]').innerText(); assert.match(archived, /已归档/);
    control.emit(); await poll(page); assert.equal(await page.locator('[data-collab-status]').innerText(), archived);
    const writes = h.requests.filter(r => r.method !== 'GET').length; await page.locator('[data-collab-show-archive]').click(); await settled(page);
    await page.locator('[data-collab-archive-download]').waitFor(); assert.equal(h.requests.filter(r => r.method !== 'GET').length, writes, 'show archive only navigates');
    assert.equal(await page.locator('[data-collab-archive-download]').isVisible(), true);
  });

  await scenario('guidance shows character count, retains the 4000 limit, and explains busy, stale task, offline and ended states', async h => {
    const { page } = h, run = await create(h), control = controls.get(run.id)!; await jump(page, 'guidance');
    const submit = '[data-collab-guidance-form] button[type="submit"]';
    assert.equal((await page.locator('[data-guidance-count]').innerText()).replace(/\s/g, ''), '0/4000');
    await page.locator(text).fill('a'.repeat(4000)); assert.equal((await page.locator('[data-guidance-count]').innerText()).replace(/\s/g, ''), '4000/4000');
    await page.locator(text).press('End'); await page.locator(text).press('z'); assert.equal((await page.locator(text).inputValue()).length, 4000);
    const seen = deferred(), release = deferred(); h.effect = async route => {
      if (route.request().method() !== 'POST' || !new URL(route.request().url()).pathname.endsWith('/guidance')) return false;
      seen.resolve(); await release.promise; return false;
    };
    try {
      await page.locator(submit).click(); await seen.promise; assert.equal(await page.locator(submit).isDisabled(), true);
      assert.match(await page.locator(submit).innerText(), /发送中/); assert.equal(await page.locator(submit).getAttribute('aria-busy'), 'true');
      assert.match(await page.locator('[data-guidance-availability]').innerText(), /处理|提交|稍候/);
      control.emit(); await poll(page); assert.equal((await page.locator(text).inputValue()).length, 4000);
      release.resolve(); await page.locator(`${submit}:enabled`).waitFor(); assert.equal(await page.locator(text).inputValue(), '');
      assert.equal((await page.locator('[data-guidance-count]').innerText()).replace(/\s/g, ''), '0/4000');
    } finally { release.resolve(); }
    h.effect = undefined; assert.equal(commands.filter(c => c.runId === run.id && c.command.type === 'guidance').length, 1);
    await jump(page, 'tasks'); await page.locator('.collab-graph [data-collab-task="base"]').click(); await page.locator('[data-collab-guide-task]').click();
    await page.locator(text).fill('Check the new task version before sending'); control.observation.inspection.tasks.find(t => t.id === 'base')!.version = mathDigest('new base version');
    control.emit(); await poll(page); assert.equal(await page.locator(submit).isDisabled(), true);
    assert.match(await page.locator('[data-guidance-availability]').innerText(), /任务版本.*变化|确认当前任务版本/);
    await page.locator('[data-guidance-confirm-version]').click(); assert.equal(await page.locator(submit).isEnabled(), true);
    try {
      await h.context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await page.waitForFunction(() => document.querySelector('[data-guidance-availability]')?.textContent?.includes('连接恢复'));
      assert.equal(await page.locator(submit).isDisabled(), true); assert.equal(await page.locator(text).inputValue(), 'Check the new task version before sending');
    } finally { await h.context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); }
    await page.locator(`${submit}:enabled`).waitFor(); control.finish(); await poll(page);
    await page.waitForFunction(() => document.querySelector('[data-guidance-availability]')?.textContent?.includes('已结束'));
    assert.equal(await page.locator(submit).isDisabled(), true); assert.equal(await page.locator(text).inputValue(), 'Check the new task version before sending');
  });

  for (const width of [375, 320]) await scenario(`mobile ${width}px uses one compact section picker with reachable headings and guidance return`, async h => {
    const { page } = h; await create(h);
    const picker = page.locator('[data-collab-section-picker]'); assert.equal(await picker.isVisible(), true);
    for (const id of sections) assert.equal(await page.locator(navButton(id)).isVisible(), false, 'desktop section buttons are hidden on mobile');
    const navigation = await page.locator('.collab-navigation').boundingBox(); assert.ok(navigation && navigation.height <= 64, 'mobile navigation occupies a single compact row');
    for (const id of ['knowledge', 'tasks', 'reviews', 'guidance'] as Section[]) {
      await jump(page, id); await visibleHeading(page, id); assert.equal(await picker.inputValue(), id);
      assert.equal(await heading(page, id).evaluate(node => document.activeElement === node), true);
    }
    await jump(page, 'reviews'); await page.locator('[data-review-id="review-0"]').click(); await page.locator('[data-review-reference]').click();
    assert.equal(await focused(page, text), true); await fit(page, ['.collab-navigation', '[data-collab-section-picker]', '.collab-guidance', text]);
    const textBox = await page.locator(text).boundingBox(), viewport = await page.locator(panel).boundingBox();
    assert.ok(textBox && viewport && textBox.y < viewport.y + viewport.height && textBox.y + textBox.height > viewport.y, 'full guidance input is brought into the reading viewport');
    await page.screenshot({ path: path.join(output, `guidance-${width}.png`) });
    await returnTo(page, '[data-review-reference]'); await jump(page, 'tasks');
    await fit(page, ['.collab-navigation', '.collab-layout', '.collab-map-tools', '[data-collab-task-search]']);
    await page.screenshot({ path: path.join(output, `mobile-${width}.png`) });
  }, width);

  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', null, 'local-real-http-workbench-usability', {
    checks: suite.checks, simulatedSavedMathematics: true, leanProcesses: 0,
    screenshots: ['desktop.png', 'mobile-375.png', 'guidance-375.png', 'mobile-320.png', 'guidance-320.png'],
  }, { credential: input.apiKey });
  console.log(`Workbench usability: ${suite.checks.length}/${suite.checks.length} passed`);
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-workbench-usability', {
    checks: suite.checks, simulatedSavedMathematics: true, leanProcesses: 0,
  }, { credential: input.apiKey, failureRequests: true }); throw error;
} finally {
  for (const control of controls.values()) control.finish(); await browser.close(); service.server.close();
}

async function visibleArtifact(page: Page) {
  const title = await page.locator('[data-collab-artifact-heading]').boundingBox(), inspector = await page.locator('.collab-inspector').boundingBox();
  const navigation = await page.locator('.collab-navigation').boundingBox(), viewport = await page.locator(panel).boundingBox();
  assert.ok(title && inspector && navigation && viewport, 'loading artifact has a visible focus heading');
  assert.ok(title.y >= navigation.y + navigation.height - 1 && title.y >= inspector.y - 1, 'artifact loading is not above the sticky navigation or inspector viewport');
  assert.ok(title.y + title.height <= Math.min(inspector.y + inspector.height, viewport.y + viewport.height) + 1, 'artifact loading appears in the reading viewport');
}
