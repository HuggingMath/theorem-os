#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebInspectedTask, WebObservation, WebPlanTask } from '../apps/web/collaboration';
import type { WebRunInput } from '../apps/web/shared';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { taskVersion } from '../src/solver/tasks';
import { refreshHistory, selectHistoryRun } from './web-ui-controls';
import { freePort, postRun, preferFullCollaboration, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticRoot = path.resolve(process.env.THEOREMOS_WEB_STATIC_ROOT || path.join(root, 'out/web'));
const output = path.resolve(process.env.THEOREMOS_WEB_INTERACTION_OUTPUT || path.join(root, 'out/web-interaction-flow', path.basename(staticRoot)));
const baselineMode = process.env.THEOREMOS_WEB_INTERACTION_BASELINE === '1';
await fs.access(path.join(staticRoot, 'app.js'));
await fs.mkdir(output, { recursive: true });
const taskTotal = 144;
const longObjective = '验证数学证明中的依赖和每个局部前提，保留可复核的推导说明。'.repeat(14);
const tasks: WebPlanTask[] = Array.from({ length: taskTotal }, (_, index) => {
  const number = index + 1, chainIndex = index % 12;
  return { id: 'task-' + String(number).padStart(3, '0'), kind: 'lemma',
    objective: number === 73 ? 'CURVATURE_ANCHOR_0073：' + longObjective : '局部引理 ' + String(number).padStart(3, '0') + '：' + longObjective,
    dependsOn: chainIndex ? ['task-' + String(number - 1).padStart(3, '0')] : [], revision: 0,
    theoremName: 'lemma_' + number, proofPath: 'Submission.lean',
    type: '∀ (x : ℝ), x = x → ' + '保持局部数学条件和上下文以支持人工复核。'.repeat(5) };
});
const goal: WebPlanTask = { id: 'original', kind: 'goal', objective: '证明冻结的原题目标，并整合各条局部路线。',
  dependsOn: Array.from({ length: 12 }, (_, index) => 'task-' + String((index + 1) * 12).padStart(3, '0')),
  revision: 0, theoremName: 'original', proofPath: 'Submission.lean', type: 'True' };
const planTasks = [...tasks, goal];
const routes = [1, 2].map(index => ({ id: 'route-' + index, targetTaskId: 'original',
  prerequisiteTaskIds: ['task-' + String((index - 1) * 12 + 1).padStart(3, '0')],
  closingTaskId: 'task-' + String(index * 12).padStart(3, '0') }));
const environmentDigest = mathDigest('interaction flow fixture; no model or Lean');
const now = () => new Date().toISOString();
const inspected = (task: WebPlanTask, owner?: string): WebInspectedTask => ({ id: task.id, kind: task.kind, objective: task.objective,
  group: 'main', status: 'pending', control: 'active', ...(owner ? { owner } : {}), version: taskVersion(task), theorem: task.theoremName,
  type: task.type, premises: [], plannedDependencies: task.dependsOn, attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} });
function makeObservation(id: string): WebObservation {
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: 'interaction-' + id, stateDigest: mathDigest(id), resultDigest: null };
  const proofRoutes = routes.map(route => ({ ...route, routeId: route.id, remainingPrerequisiteTaskIds: [...route.prerequisiteTaskIds], closingStatus: 'none',
    targetStatus: 'none', ready: false, connection: 'not-established', referenceCoverageMissing: [], parkedBy: [] }));
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: structuredClone(planTasks), proofRoutes: structuredClone(routes) },
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
      problem: { id: 'interaction-flow-fixture', statement: 'Prove the frozen original theorem', formalStatement: 'True', assumptions: [],
        targets: [{ proofPath: 'Submission.lean', theoremName: 'original' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative', buildDigest: mathDigest('interaction fixture build'), environmentDigest },
      turns: 1, planVersion: 'plan-v1', scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 2, working: 1, proofAssignments: 1,
        preparing: 0, stopping: 0, idle: 1, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded',
        droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'theoremos.obligation-snapshot.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
        digest: mathDigest('interaction mathematics'), environmentDigest, obligations: [], goals: [], blockers: [], routes: proofRoutes, advisory: [] },
        recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: planTasks.map(task => task.id) },
      groups: [], tasks: planTasks.map(task => inspected(task, task.id === 'task-073' ? 'researcher' : undefined)),
      workers: [{ id: 'lead', role: 'lead', sessionRole: 'lead', phase: 'waiting', turns: 11, dispatchWait: { status: 'unknown' } },
        { id: 'researcher', role: 'researcher', sessionRole: 'researcher', phase: 'proving', turns: 1, task: 'task-073', dispatchWait: { status: 'unknown' } }],
      statementReviews: [], edits: [] }, history: [], sources: [], checks: [], guidance: [], deliveries: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}
type FixtureControl = { observation: WebObservation; emit(): void; finish(): void };
const controls = new Map<string, FixtureControl>();
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local interaction-flow fixture' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: FixtureControl = { observation: makeObservation(input.id), finish: resolve, emit() {
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      controls.set(input.id, control);
      signal.addEventListener('abort', () => resolve(), { once: true });
      control.emit();
    });
  },
  async command() { throw new Error('Interaction-flow fixture does not submit commands'); },
};
type Counts = { childLists: number; added: number; removed: number; addedSubtree: number; removedSubtree: number; textCharactersAdded: number; characterData: number };
type Measurement = { name: string; elapsedIncludingBrowserWaitMs: number; retained: Record<string, boolean>; retainedText: Record<string, boolean>;
  mutations: Record<string, Counts>; focus: { sameNode: boolean; before: string | null; after: string | null };
  selection: { before: { start: number; end: number; value: string }; after: { start: number; end: number; value: string }; windowBefore: string; windowAfter: string };
  scroll: Record<string, { before: { top: number; left: number }; after: { top: number; left: number } }> };
const measures: Measurement[] = [];
const list = '[data-collab-task-list]', search = '[data-collab-task-search]', agentList = '[data-collab-agents]';
const listTask = (id: string) => list + ' [data-collab-task="' + id + '"]';
const errors: string[] = [];
let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
let page: Page | undefined;
let service: ReturnType<typeof createWebService> | undefined;
let scenario = 'initialization';

async function begin(name: string, selectors: Record<string, string>) {
  await page!.evaluate(({ name, selectors }) => {
    const roots = ['[data-collab-graph]', '[data-collab-task-list]', '[data-collab-inspector]', '[data-collab-agents]'];
    const mutations = Object.fromEntries(roots.map(root => [root, { childLists: 0, added: 0, removed: 0, addedSubtree: 0, removedSubtree: 0, textCharactersAdded: 0, characterData: 0 }]));
    const observers = roots.map(root => {
      const observer = new MutationObserver(records => {
        const result = mutations[root]!;
        for (const record of records) {
          if (record.type === 'characterData') { result.characterData++; continue; }
          result.childLists++;
          for (const node of Array.from(record.addedNodes)) { result.added++; result.addedSubtree += 1 + (node instanceof Element ? node.querySelectorAll('*').length : 0); result.textCharactersAdded += node.textContent?.length ?? 0; }
          for (const node of Array.from(record.removedNodes)) { result.removed++; result.removedSubtree += 1 + (node instanceof Element ? node.querySelectorAll('*').length : 0); }
        }
      });
      observer.observe(document.querySelector(root)!, { childList: true, subtree: true, characterData: true }); return observer;
    });
    const nodes = Object.fromEntries(Object.entries(selectors).map(([id, selector]) => [id, document.querySelector(selector)]));
    const textNodes = Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, node?.firstChild]));
    const input = document.querySelector<HTMLInputElement>('[data-collab-task-search]')!;
    const scrolls = ['[data-collab-task-list]', '.collab-graph-scroll', '#detail-panel'].map(selector => {
      const node = document.querySelector<HTMLElement>(selector)!; return [selector, { top: node.scrollTop, left: node.scrollLeft }];
    });
    (window as unknown as { __interactionProbe: unknown }).__interactionProbe = { name, selectors, nodes, textNodes, mutations, observers,
      scrolls: Object.fromEntries(scrolls), focus: document.activeElement,
      selection: { start: input.selectionStart, end: input.selectionEnd, value: input.value }, windowSelection: getSelection()?.toString() ?? '', startedAt: performance.now() };
  }, { name, selectors });
}
async function nextPaint() { await page!.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function end(): Promise<Measurement> {
  await nextPaint();
  const result = await page!.evaluate(() => {
    type Probe = { name: string; selectors: Record<string, string>; nodes: Record<string, Element | null>; textNodes: Record<string, Node | null>;
      mutations: Record<string, Counts>; observers: MutationObserver[]; scrolls: Record<string, { top: number; left: number }>;
      focus: Element | null; selection: { start: number; end: number; value: string }; windowSelection: string; startedAt: number };
    const probe = (window as unknown as { __interactionProbe: Probe }).__interactionProbe;
    for (const observer of probe.observers) observer.disconnect();
    const input = document.querySelector<HTMLInputElement>('[data-collab-task-search]')!;
    const label = (element: Element | null) => element?.id || element?.getAttribute('data-collab-task') || element?.getAttribute('data-focus-key') || element?.tagName || null;
    const scroll = Object.fromEntries(Object.keys(probe.scrolls).map(selector => {
      const node = document.querySelector<HTMLElement>(selector)!;
      return [selector, { before: probe.scrolls[selector]!, after: { top: node.scrollTop, left: node.scrollLeft } }];
    }));
    return { name: probe.name, elapsedIncludingBrowserWaitMs: Math.round(performance.now() - probe.startedAt),
      retained: Object.fromEntries(Object.entries(probe.selectors).map(([id, selector]) => [id, probe.nodes[id] !== null && probe.nodes[id] === document.querySelector(selector)])),
      retainedText: Object.fromEntries(Object.entries(probe.selectors).map(([id, selector]) => [id, probe.textNodes[id] !== null && probe.textNodes[id] === document.querySelector(selector)?.firstChild])),
      mutations: probe.mutations, focus: { sameNode: probe.focus === document.activeElement, before: label(probe.focus), after: label(document.activeElement) },
      selection: { before: probe.selection, after: { start: input.selectionStart, end: input.selectionEnd, value: input.value }, windowBefore: probe.windowSelection, windowAfter: getSelection()?.toString() ?? '' }, scroll };
  });
  measures.push(result); console.log(JSON.stringify(result)); return result;
}
async function waitForTaskCount(expected: number) {
  await page!.waitForFunction(expected => document.querySelector('[data-collab-task-count]')?.textContent?.includes('显示 ' + expected + ' /') ?? false, expected);
}
async function displayedAgentTurns(): Promise<string | undefined> {
  return page!.locator(agentList + ' .collab-agent:first-child .collab-facts').evaluate(node => {
    const rows = Array.from(node.querySelectorAll('dt')).map(dt => [dt.textContent?.trim(), dt.nextElementSibling?.textContent?.trim()]);
    return rows.find(([name]) => name === '轮次')?.[1];
  });
}

try {
  const port = await freePort(), origin = 'http://127.0.0.1:' + port;
  service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
    THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_CONCURRENCY: '2' }), runner);
  browser = await startBrowser(service.server, port);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  await preferFullCollaboration(context);
  await context.addInitScript(() => {
    const fetcher = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await fetcher(input, init);
      if (new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : String(input), location.href).pathname !== '/api/session') return response;
      const session = await response.clone().json() as { runtime: { ready: boolean; message: string } };
      session.runtime = { ready: true, message: 'Local interaction-flow fixture' };
      const headers = new Headers(response.headers); headers.delete('content-length');
      return new Response(JSON.stringify(session), { status: response.status, statusText: response.statusText, headers });
    };
  });
  page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  await context.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { errors.push('Unexpected external request: ' + url.origin); await route.abort(); return; }
    await route.continue();
  });
  await page.goto(origin);
  try { await page.locator('#submit-run:enabled').waitFor({ state: 'attached' }); }
  catch (error) { console.error(JSON.stringify(await page.evaluate(() => ({ runtime: document.querySelector('#runtime-note')?.textContent,
    notice: document.querySelector('#global-notice-text')?.textContent, provider: document.querySelector<HTMLSelectElement>('#provider')?.innerHTML,
    disabled: document.querySelector<HTMLButtonElement>('#submit-run')?.disabled })))); throw error; }
  const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-local-interaction-fixture', model: 'fixture', effort: 'low', environment: 'standard',
    source: 'theorem original : True := by sorry\n', task: 'Inspect long mathematical task interactions', maxTurns: 2, maxRunSeconds: 60, workers: 2, coordination: 'cooperative' };
  const run = await postRun({ page }, input, 'Interaction flow');
  const deadline = Date.now() + 10_000;
  while (!controls.has(run.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(controls.has(run.id), 'fixture runner started');
  await refreshHistory(page); await selectHistoryRun(page, run.id, 'collaboration');
  await page.locator('[data-collab-graph] [data-collab-task="task-073"]').waitFor(); await waitForTaskCount(taskTotal + 1);
  await page.locator('[data-collab-task-view="list"]').click();
  await page.locator(listTask('task-073')).waitFor();
  const selected = page.locator(listTask('task-073')); await selected.scrollIntoViewIfNeeded();
  scenario = 'select a mathematical task';
  await begin(scenario, { search, list, graph: '[data-collab-graph]', inspector: '[data-collab-inspector]', selectedTask: listTask('task-073'), stableTask: listTask('task-002') });
  await selected.click();
  await page.getByRole('heading', { name: /task-073/ }).waitFor();
  assert.ok((await page.locator('[data-collab-inspector]').innerText()).includes('CURVATURE_ANCHOR_0073'), 'selection displays the complete task contract');
  const selectionMeasure = await end();
  if (baselineMode) {
    assert.equal(selectionMeasure.retained.stableTask, false, 'baseline replaces unchanged task cards after a selection');
    assert.ok(selectionMeasure.mutations[list]!.removedSubtree >= taskTotal * 2, 'baseline rebuilds the task list after a selection');
  } else assert.equal(selectionMeasure.retained.stableTask, true, 'selection retains an unchanged task card');

  scenario = 'search long task objectives';
  await page.locator(search).fill(''); await waitForTaskCount(taskTotal + 1);
  await begin(scenario, { search, list, graph: '[data-collab-graph]', inspector: '[data-collab-inspector]' });
  await page.locator(search).fill('CURVATURE_ANCHOR_0073'); await waitForTaskCount(1);
  assert.equal(await page.locator(list + ' [data-collab-task]').count(), 1);
  assert.ok((await page.locator(list).innerText()).includes('CURVATURE_ANCHOR_0073'), 'search returns the exact long task objective');
  const searchMeasure = await end();
  assert.equal(searchMeasure.retained.search, true, 'search preserves the input node');
  assert.equal(searchMeasure.focus.sameNode, true, 'search keeps focus in the input');
  assert.equal(searchMeasure.selection.after.value, 'CURVATURE_ANCHOR_0073', 'search contains the requested objective fragment');
  if (baselineMode) assert.ok(searchMeasure.mutations['[data-collab-graph]']!.removedSubtree > 0, 'baseline renders the hidden graph while searching the list');
  else assert.equal(searchMeasure.mutations['[data-collab-graph]']!.removedSubtree, 0, 'list search skips the hidden graph');

  await page.locator(search).fill('保留可复核的推导说明'); await waitForTaskCount(taskTotal);
  await page.locator(list).evaluate(node => { node.scrollTop = 480; });
  await page.locator('.collab-graph-scroll').evaluate(node => { node.scrollLeft = 340; node.scrollTop = 190; });
  await page.locator(search).focus(); await page.locator(search).evaluate(node => (node as HTMLInputElement).setSelectionRange(3, 9));
  const control = controls.get(run.id)!;
  scenario = 'receive an observation with the same sequence';
  const duplicate = structuredClone(control.observation); duplicate.inspection.workers[0]!.turns = 99;
  let duplicateNext = true;
  const observationRoute = async (route: Route) => {
    if (duplicateNext && route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/runs') {
      duplicateNext = false;
      const headers = route.request().headers(); delete headers['if-none-match'];
      const response = await route.fetch({ headers });
      const payload = await response.json() as { runs: Array<Record<string, unknown>> };
      const current = payload.runs.find(item => item.id === run.id);
      if (current) current.observation = duplicate;
      await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(payload) });
    } else await route.continue();
  };
  await begin(scenario, { search, list, graph: '[data-collab-graph]', inspector: '[data-collab-inspector]', selectedTask: listTask('task-073'), stableTask: listTask('task-002'), lead: agentList + ' .collab-agent:first-child' });
  await page.route('**/api/runs', observationRoute);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs');
  const duplicateMeasure = await end();
  const sameSequenceTurns = await displayedAgentTurns();
  await page.unroute('**/api/runs', observationRoute);
  if (baselineMode) assert.notEqual(sameSequenceTurns, '11', 'baseline renders an observation even when its sequence is unchanged');
  else {
    assert.equal(sameSequenceTurns, '11', 'same-sequence observation is ignored');
    assert.equal(duplicateMeasure.retained.stableTask, true, 'same-sequence update retains an unchanged task card');
    assert.equal(duplicateMeasure.focus.sameNode, true, 'same-sequence update preserves focus');
  }

  scenario = 'receive an observation with an increasing sequence';
  await begin(scenario, { search, list, graph: '[data-collab-graph]', inspector: '[data-collab-inspector]', selectedTask: listTask('task-073'), stableTask: listTask('task-002'), lead: agentList + ' .collab-agent:first-child' });
  control.observation.inspection.tasks.find(task => task.id === 'task-073')!.owner = 'lead';
  control.observation.inspection.workers[0]!.turns = 12;
  control.observation.sequence++; control.observation.observedAt = now();
  let increasingNext = true;
  await page.route('**/api/runs', async route => {
    if (increasingNext && route.request().method() === 'GET') {
      increasingNext = false;
      const headers = route.request().headers(); delete headers['if-none-match'];
      const response = await route.fetch({ headers });
      const payload = await response.json() as { runs: Array<Record<string, unknown>> };
      const current = payload.runs.find(item => item.id === run.id);
      if (current) current.observation = structuredClone(control.observation);
      await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(payload) });
    } else await route.continue();
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs');
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-collab-agents] .collab-agent:first-child .collab-facts');
    return node && Array.from(node.querySelectorAll('dt')).some(dt => dt.textContent?.trim() === '轮次' && dt.nextElementSibling?.textContent?.trim() === '12');
  });
  // Owners are named by role on the card.
  assert.ok((await page.locator(listTask('task-073')).innerText()).includes('Lead'), 'increasing observation updates the task owner');
  assert.ok((await page.locator('[data-collab-inspector]').innerText()).includes('lead'), 'inspector reflects the latest task assignment');
  assert.ok((await page.locator(listTask('task-073')).innerText()).includes('CURVATURE_ANCHOR_0073'), 'updated task card retains its exact mathematical objective');
  const increasingMeasure = await end();
  await page.unroute('**/api/runs');
  if (baselineMode) {
    assert.equal(increasingMeasure.retained.stableTask, false, 'baseline rebuilds unchanged task cards for an increasing observation');
    assert.ok(increasingMeasure.mutations[list]!.removedSubtree > 0, 'baseline replaces task descendants during an increasing observation');
  } else {
    assert.equal(increasingMeasure.retained.stableTask, true, 'increasing observation retains an unchanged task card');
    assert.equal(increasingMeasure.retained.selectedTask, true, 'increasing observation retains the updated task card');
    assert.equal(increasingMeasure.retained.lead, true, 'increasing observation retains the agent card');
    assert.equal(increasingMeasure.focus.sameNode, true, 'increasing observation preserves focus');
    assert.deepEqual(increasingMeasure.selection.after, increasingMeasure.selection.before, 'increasing observation preserves text selection');
    assert.deepEqual(increasingMeasure.scroll[list]!.after, increasingMeasure.scroll[list]!.before, 'increasing observation preserves task-list reading position');
    assert.deepEqual(increasingMeasure.scroll['#detail-panel']!.after, increasingMeasure.scroll['#detail-panel']!.before, 'increasing observation preserves the panel reading position');
  }
  assert.deepEqual(errors, [], 'browser has no uncaught errors or external requests');
  const report = { status: baselineMode ? 'baseline-recorded' : 'passed', checkedAt: now(), staticRoot, taskCount: taskTotal + 1,
    averageObjectiveCharacters: Math.round(planTasks.reduce((sum, task) => sum + task.objective.length, 0) / planTasks.length),
    paidModelCalls: false, leanProcesses: 0, sameSequence: { displayedTurns: sameSequenceTurns, staleUpdateIgnored: sameSequenceTurns === '11',
      elapsedIncludingBrowserWaitMs: duplicateMeasure.elapsedIncludingBrowserWaitMs }, measurements: measures,
    finalContent: { selectedTask: 'task-073', searchResult: 'CURVATURE_ANCHOR_0073', increasingSequenceTurns: await displayedAgentTurns(), owner: 'lead' } };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('PASS interaction flow report: ' + path.join(output, 'report.json'));
  await context.close();
} catch (error) {
  const report = { status: 'failed', checkedAt: now(), staticRoot, taskCount: taskTotal + 1, paidModelCalls: false, leanProcesses: 0, scenario,
    error: error instanceof Error ? error.message : String(error), sameSequence: { displayedTurns: await displayedAgentTurns().catch(() => undefined), staleUpdateIgnored: false },
    measurements: measures, errors };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.error('FAIL ' + scenario + ': ' + report.error);
  process.exitCode = 1;
} finally {
  for (const control of controls.values()) control.finish();
  await browser?.close();
  await service?.close();
}
