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
import type { WebInspectedTask, WebObservation, WebPlanTask, WebProofRoute } from '../apps/web/collaboration';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { taskVersion } from '../src/solver/tasks';
import { refreshHistory, selectHistoryRun } from './web-ui-controls';
import { freePort, postRun, settled, startBrowser, webScenario, writeScenarioReport,
  type ScenarioHarness, type ScenarioSuite, runtimeWrite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-task-browser');
await fs.mkdir(output, { recursive: true });
const environmentDigest = mathDigest('local task-browser fixture; no Lean processes');
const now = () => new Date().toISOString();
const longType = `∀ (𝒇 : ℝ → ℝ) (ε : ℝ), 0 < ε → ${'∃ δ > 0, ∀ x, |x| < δ → |𝒇 x - 𝒇 0| < ε ∧ '.repeat(32)}True`;
const longObjective = `本地目标_a5：紧致性🔎与连续映射𝒇。${'检查每个量词、前提和依赖，保持精确的数学目标与可复核记录。'.repeat(36)}`;
const allTasks: WebPlanTask[] = [
  { id: 'original', kind: 'goal', objective: '本地目标_original：证明固定原题', dependsOn: [], revision: 0,
    proofPath: 'Submission.lean', theoremName: 'original', type: 'True' },
  ...(['a', 'b'] as const).flatMap(route => Array.from({ length: 8 }, (_, i): WebPlanTask => ({
    id: `${route}${i + 1}`, kind: 'lemma', objective: route === 'a' && i === 4 ? longObjective : `本地目标_${route}${i + 1}：路线 ${route.toUpperCase()} 的第 ${i + 1} 步`,
    dependsOn: i ? [`${route}${i}`] : [], revision: route === 'a' && i === 4 ? 1 : 0,
    proofPath: 'Submission.lean', theoremName: `${route}${i + 1}`, type: route === 'a' && i === 4 ? longType : 'True',
    status: i === 3 ? 'paused' : 'active',
  }))),
  ...Array.from({ length: 3 }, (_, i): WebPlanTask => ({ id: `note${i + 1}`, kind: i === 1 ? 'sketch' : 'research',
    objective: `本地目标_note${i + 1}：独立研究笔记`, dependsOn: [], revision: 0 })),
];
const routes: WebProofRoute[] = [
  { id: 'A', targetTaskId: 'original', prerequisiteTaskIds: ['a1'], closingTaskId: 'a8' },
  { id: 'B', targetTaskId: 'original', prerequisiteTaskIds: ['b1'], closingTaskId: 'b8' },
];
// Provider-reported tokens for the running tasks; the rest have none recorded.
const taskUsage: Record<string, Record<string, number>> = {
  a2: { totalTokens: 1_234_567, inputTokens: 1_200_000, cachedInputTokens: 900_000, outputTokens: 34_567 },
  a6: { totalTokens: 300_000, inputTokens: 290_000, outputTokens: 10_000 }, b2: { inputTokens: 48_000, outputTokens: 2_000 }, b6: { totalTokens: 800 },
};
function inspected(task: WebPlanTask): WebInspectedTask {
  const index = /^[ab](\d)$/.exec(task.id)?.[1];
  const state = index && [2, 6].includes(Number(index)) ? 'running' : index && [3, 7].includes(Number(index)) ? 'blocked' : 'pending';
  return { id: task.id, kind: task.kind, objective: task.objective, group: 'main', status: state,
    control: task.status ?? 'active', owner: state === 'running' ? 'researcher' : undefined, version: taskVersion(task),
    theorem: task.theoremName, type: task.type, premises: [], plannedDependencies: task.dependsOn,
    attempts: state === 'pending' ? 0 : 1, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {},
    ...(taskUsage[task.id] ? { usage: taskUsage[task.id] } : {}) };
}
const oldA5: WebPlanTask = { ...allTasks.find(task => task.id === 'a5')!, revision: 0, type: 'True',
  objective: '历史目标_a5：保存的旧声明，与当前连续映射目标不同' };
const oldA5Version = taskVersion(oldA5), currentA5Version = taskVersion(allTasks.find(task => task.id === 'a5')!);
const emptyTask = 'Inspect a run before mathematical tasks are available';
type Control = { observation: WebObservation; emit(): void; finish(): void };
type Harness = ScenarioHarness & { runIds: string[] };
const controls = new Map<string, Control>();
function observation(id: string, empty: boolean): WebObservation {
  const tasks = empty ? [] : structuredClone(allTasks), proofRoutes = empty ? [] : structuredClone(routes);
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `tasks-${id}`, stateDigest: mathDigest(id), resultDigest: null };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks, proofRoutes },
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
      problem: { id: 'task-browser-fixture', statement: 'Prove the frozen original theorem', formalStatement: 'True', assumptions: [],
        targets: [{ proofPath: 'Submission.lean', theoremName: 'original' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative', buildDigest: mathDigest('task-browser-build'), environmentDigest },
      turns: 1, usage: empty ? undefined : { totalTokens: 2_000_000 }, planVersion: 'plan-v1', scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 2, working: 1,
        proofAssignments: 1, preparing: 0, stopping: 0, idle: 1, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded',
        droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'theoremos.obligation-snapshot.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
        digest: mathDigest('task-browser-mathematics'), environmentDigest, obligations: [], goals: [], blockers: [], advisory: [],
        routes: proofRoutes.map(route => ({ routeId: route.id, ...route, remainingPrerequisiteTaskIds: [...route.prerequisiteTaskIds],
          closingStatus: 'none', targetStatus: 'none', ready: false, connection: 'not-established', referenceCoverageMissing: [], parkedBy: [] })) },
        recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: tasks.map(task => task.id) },
      groups: [], tasks: tasks.map(inspected), workers: [
        { id: 'lead', role: 'lead', sessionRole: 'lead', phase: 'waiting', turns: 1, dispatchWait: { status: 'unknown' } },
        { id: 'researcher', role: 'researcher', phase: 'proving', turns: 1, task: 'a2', dispatchWait: { status: 'unknown' } }],
      statementReviews: [], edits: [] },
    history: empty ? [] : [inspected(oldA5)], sources: [], checks: [], guidance: [],
    deliveries: empty ? [] : [{ id: 'old-a5-delivery', producer: 'researcher', taskId: 'a5', taskDigest: oldA5Version,
      kind: 'research', status: 'advisory', statement: 'True', premises: [], dependencies: [], remainingObligations: [],
      summary: 'Retained historical a5 contract for exact-version task browsing', evidenceRefs: [], createdAt: 1_700_000_000_000 }],
    coverage: { sources: 'recorded', checks: 'recorded' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local task-browser HTTP fixture; no model or Lean' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id, input.input.task === emptyTask), finish: resolve, emit() {
        this.observation = { ...this.observation, sequence: this.observation.sequence + 1, observedAt: now() };
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true }); control.emit();
    });
  },
  async command() { throw new Error('Task browsing must not submit runtime commands'); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-local-task-browser-fixture', model: 'fixture', effort: 'low',
  environment: 'standard', source: 'theorem original : True := by sorry\n', task: 'Inspect mathematical task browsing',
  maxTurns: 2, maxRunSeconds: 60, workers: 2, coordination: 'cooperative' };
const map = '.collab-map', list = '[data-collab-task-list]', route = '[data-collab-route]', state = '[data-collab-task-state]';
const query = '[data-collab-task-search]', count = '[data-collab-task-count]', reset = '[data-collab-task-reset]';
const notice = '[data-collab-task-selection]', inspector = '[data-collab-inspector]', back = '[data-collab-back-to-list]';
const panel = '#detail-panel';
const card = (id: string) => `${list} [data-collab-task="${id}"]`;
const graphCard = (id: string) => `[data-collab-graph] [data-collab-task="${id}"]`;
const isFocused = (page: Page, selector: string) => page.locator(selector).evaluate(node => document.activeElement === node);
async function create(h: Harness, title = input.task) {
  const run = await postRun(h, { ...input, task: title }); h.runIds.push(run.id);
  await refreshHistory(h.page); await selectHistoryRun(h.page, run.id, 'collaboration'); await h.page.locator(count).waitFor();
  await tasksSection(h.page); return run;
}
async function tasksSection(page: Page) {
  if (page.viewportSize()!.width <= 850) await page.locator('[data-collab-section-picker]').selectOption('tasks');
  else await page.locator('[data-collab-jump="tasks"]').click();
  await settled(page);
}
async function view(page: Page, mode: 'graph' | 'list') {
  await page.locator(`[data-collab-task-view="${mode}"]`).click(); assert.equal(await page.locator(map).getAttribute('data-task-view'), mode); await settled(page);
}
async function poll(page: Page) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/runs' && r.request().method() === 'GET');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await response; await settled(page);
}
async function expectCards(page: Page, ids: string[]) {
  await page.waitForFunction(({ selector, expected }) => {
    const actual = [...document.querySelectorAll<HTMLElement>(selector)].map(node => node.dataset.collabTask!).sort();
    return JSON.stringify(actual) === JSON.stringify([...expected].sort());
  }, { selector: `${list} [data-collab-task]`, expected: ids });
  assert.deepEqual((await page.locator(`${list} [data-collab-task]`).evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.collabTask!))).sort(), [...ids].sort());
  assert.deepEqual((await page.locator(count).innerText()).match(/(\d+)\s*\/\s*(\d+)/)?.slice(1), [String(ids.length), '20']);
}
async function expectSelected(page: Page, id: string, version?: string) {
  assert.match(await page.locator('[data-inspected-task-heading]').innerText(), new RegExp(`^${id} ·`));
  assert.equal(await page.locator('[data-inspected-task-version]').innerText(), version ?? taskVersion(allTasks.find(task => task.id === id)!));
}
async function visibleInspector(page: Page) {
  assert.equal(await isFocused(page, '[data-inspected-task-heading]'), true, 'list entry reveals and focuses the inspector heading');
  const title = await page.locator('[data-inspected-task-heading]').boundingBox(), navigation = await page.locator('.collab-navigation').boundingBox();
  const viewport = await page.locator(panel).boundingBox(); assert.ok(title && navigation && viewport);
  assert.ok(title.y >= navigation.y + navigation.height - 1, 'inspector title is below sticky navigation');
  assert.ok(title.y + title.height <= viewport.y + viewport.height + 1, 'inspector title is inside the panel viewport');
  if (await page.locator(back).isVisible()) {
    const returnButton = await page.locator(back).boundingBox(); assert.ok(returnButton);
    assert.ok(returnButton.y >= navigation.y + navigation.height - 1, 'the return entry stays visible below sticky navigation without another scroll');
    assert.ok(returnButton.y + returnButton.height <= viewport.y + viewport.height + 1, 'the return entry stays inside the panel viewport');
  }
  assert.equal(await page.evaluate(() => window.scrollY === 0 && window.scrollX === 0), true, 'task inspection must scroll the panel, not the document');
}
async function fit(page: Page) {
  const width = page.viewportSize()!.width; assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  for (const selector of [map, '.collab-map-tools', list, '.collab-inspector', query, state]) {
    const box = await page.locator(selector).boundingBox(); assert.ok(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1,
      `${selector} fits ${width}px: ${JSON.stringify(box)}`);
  }
}
function scenario(name: string, run: (h: Harness) => Promise<void>, width = 1440) {
  return webScenario(browser, suite, name, run, {
    context: { viewport: { width, height: width > 850 ? 1000 : 812 }, reducedMotion: 'reduce' },
    harness: (page, context) => ({ page, context, requests: [], runIds: [] }),
    routes: { local: 'Task browser checks must remain on the local HTTP fixture' }, open: true,
    timeout: { label: 'Task browser', seconds: 60 },
    verify: (h, elapsedMs) => {
      assert.equal(h.requests.some(r => runtimeWrite(r) && r.pathname !== '/api/runs'), false, 'local task browsing does not submit runtime commands');
      return { name, elapsedMs: elapsedMs(), requests: h.requests };
    }, cleanup: h => { for (const id of h.runIds) controls.get(id)?.finish(); },
  });
}

try {
  await scenario('combined route, status and Unicode filters expose exact counts and distinguish no results from no tasks', async h => {
    const { page } = h; await create(h); await view(page, 'list'); await expectCards(page, allTasks.map(task => task.id));
    await page.locator(route).selectOption('A'); await expectCards(page, ['original', ...Array.from({ length: 8 }, (_, i) => `a${i + 1}`)]);
    await page.locator(state).selectOption('running'); await expectCards(page, ['a2', 'a6']);
    await page.locator(query).fill('本地目标_a6'); await expectCards(page, ['a6']);
    await page.locator(query).fill(''); await page.locator(state).selectOption('blocked'); await expectCards(page, ['a3', 'a7']);
    await page.locator(state).selectOption('paused'); await expectCards(page, ['a4']);
    await page.locator(state).selectOption(''); await page.locator(query).fill('紧致性🔎'); await expectCards(page, ['a5']);
    await page.locator(query).fill('连续映射𝒇'); await expectCards(page, ['a5']);
    await page.locator(query).fill('不存在的数学条件_∅'); await expectCards(page, []);
    const filteredEmpty = await page.locator('[data-collab-task-empty]:visible').innerText(); assert.match(filteredEmpty, /没有.*匹配|无.*结果|没有符合/);
    await page.locator(reset).click(); await expectCards(page, allTasks.map(task => task.id));
    assert.equal(await page.locator(route).inputValue(), ''); assert.equal(await page.locator(state).inputValue(), ''); assert.equal(await page.locator(query).inputValue(), '');
    await create(h, emptyTask); assert.equal(await page.locator(`${list} [data-collab-task]`).count(), 0);
    assert.deepEqual((await page.locator(count).innerText()).match(/(\d+)\s*\/\s*(\d+)/)?.slice(1), ['0', '0']);
    const noTasks = await page.locator('[data-collab-task-empty]:visible').innerText(); assert.notEqual(noTasks, filteredEmpty);
    assert.match(noTasks, /尚无|尚未|没有.*任务|未.*任务/);
  });

  await scenario('graph and list reading, filters, focus and selected contracts survive polling and remain independent between runs', async h => {
    const { page } = h, first = await create(h, 'Task browser run A'); await view(page, 'graph');
    const graphScroll = '.collab-graph-scroll';
    const position = await page.locator(graphScroll).evaluate(node => { node.scrollLeft = 425; node.scrollTop = 90; return [node.scrollLeft, node.scrollTop]; });
    assert.ok(position[0]! > 0, 'fixture graph extends horizontally'); await page.locator(query).focus();
    controls.get(first.id)!.observation.inspection.turns++; controls.get(first.id)!.emit(); await poll(page);
    assert.deepEqual(await page.locator(graphScroll).evaluate(node => [node.scrollLeft, node.scrollTop]), position);
    assert.equal(await isFocused(page, query), true); assert.equal(await page.locator(map).getAttribute('data-task-view'), 'graph');
    await view(page, 'list'); await page.locator(route).selectOption('A'); await page.locator(query).fill('本地目标_');
    const top = await page.locator(list).evaluate(node => { node.scrollTop = 400; return node.scrollTop; }); assert.ok(top > 0, 'fixture list has its own reading position');
    await page.locator(query).focus(); const panelTop = await page.locator(panel).evaluate(node => node.scrollTop);
    const control = controls.get(first.id)!; control.observation.inspection.tasks.find(task => task.id === 'a6')!.owner = 'lead'; control.emit(); await poll(page);
    assert.equal(await page.locator(list).evaluate(node => node.scrollTop), top); assert.equal(await isFocused(page, query), true);
    assert.equal(await page.locator(panel).evaluate(node => node.scrollTop), panelTop);
    await view(page, 'graph'); await view(page, 'list'); assert.equal(await page.locator(list).evaluate(node => node.scrollTop), top, 'view toggle preserves list reading');
    const savedOuter = await page.locator(panel).evaluate(node => node.scrollTop);
    const second = await create(h, 'Task browser run B'); await view(page, 'graph'); await page.locator(route).selectOption('B');
    await page.locator(state).selectOption('blocked'); await page.locator(query).fill('本地目标_b3');
    await selectHistoryRun(page, first.id, 'collaboration'); assert.equal(await page.locator(map).getAttribute('data-task-view'), 'list');
    assert.equal(await page.locator(route).inputValue(), 'A'); assert.equal(await page.locator(state).inputValue(), ''); assert.equal(await page.locator(query).inputValue(), '本地目标_');
    assert.equal(await page.locator(list).evaluate(node => node.scrollTop), top); await expectSelected(page, 'original');
    assert.equal(await page.locator(panel).evaluate(node => node.scrollTop), savedOuter, 'switching runs restores the outer task reading position');
    await selectHistoryRun(page, second.id, 'collaboration'); assert.equal(await page.locator(map).getAttribute('data-task-view'), 'graph');
    assert.equal(await page.locator(route).inputValue(), 'B'); assert.equal(await page.locator(state).inputValue(), 'blocked'); assert.equal(await page.locator(query).inputValue(), '本地目标_b3');
  });

  await scenario('desktop list inspection returns to the entry and both scroll positions while graph clicks retain their location', async h => {
    const { page } = h; await create(h); await view(page, 'list');
    await page.locator(route).selectOption('A'); await page.locator(query).fill('本地目标_');
    await page.locator(card('a5')).scrollIntoViewIfNeeded();
    const listTop = await page.locator(list).evaluate(node => node.scrollTop), panelTop = await page.locator(panel).evaluate(node => node.scrollTop);
    assert.ok(listTop > 0, 'the long list entry is reached through internal scrolling');
    await page.locator(card('a5')).click(); await expectSelected(page, 'a5'); await visibleInspector(page);
    assert.ok((await page.locator(inspector).innerText()).includes(longObjective)); assert.ok((await page.locator(`${inspector} pre`).allTextContents()).includes(longType));
    await page.screenshot({ path: path.join(output, 'desktop-inspector.png') });
    await page.locator(back).click(); await settled(page); assert.equal(await isFocused(page, card('a5')), true);
    assert.equal(await page.locator(list).evaluate(node => node.scrollTop), listTop); assert.equal(await page.locator(panel).evaluate(node => node.scrollTop), panelTop);
    assert.equal(await page.locator(route).inputValue(), 'A'); assert.equal(await page.locator(query).inputValue(), '本地目标_');
    assert.equal(await page.locator(card('a5')).getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: path.join(output, 'desktop.png') });
    await page.locator(reset).click(); await view(page, 'graph'); await page.locator(graphCard('a2')).scrollIntoViewIfNeeded();
    const outer = await page.locator(panel).evaluate(node => node.scrollTop), inner = await page.locator('.collab-graph-scroll').evaluate(node => [node.scrollLeft, node.scrollTop]);
    await page.locator(graphCard('a2')).click(); await expectSelected(page, 'a2'); assert.equal(await isFocused(page, '[data-inspected-task-heading]'), false);
    assert.equal(await page.locator(panel).evaluate(node => node.scrollTop), outer);
    assert.deepEqual(await page.locator('.collab-graph-scroll').evaluate(node => [node.scrollLeft, node.scrollTop]), inner);
  });

  await scenario('filtering out the selected task preserves it and offers explicit show-card and inspect-contract actions', async h => {
    const { page } = h; await create(h); await view(page, 'list'); await page.locator(card('a6')).click(); await expectSelected(page, 'a6');
    await page.locator(back).click(); await page.locator(route).selectOption('B'); await page.locator(state).selectOption('blocked');
    await page.locator(query).fill('本地目标_b3'); await expectCards(page, ['b3']); await expectSelected(page, 'a6');
    assert.match(await page.locator(notice).innerText(), /a6/); assert.match(await page.locator(notice).innerText(), /隐藏|筛选|未.*显示|不在/);
    assert.equal(await page.locator(`${list} [aria-pressed="true"]`).count(), 0);
    await page.locator('[data-collab-task-show-selected]').click(); await settled(page); await expectSelected(page, 'a6');
    assert.equal(await page.locator(route).inputValue(), ''); assert.equal(await page.locator(state).inputValue(), ''); assert.equal(await page.locator(query).inputValue(), '');
    assert.equal(await page.locator(card('a6')).getAttribute('aria-pressed'), 'true'); assert.equal(await isFocused(page, card('a6')), true);
    await page.locator(query).fill('本地目标_b1'); await expectCards(page, ['b1']);
    await page.locator('[data-collab-task-inspect-selected]').click(); await expectSelected(page, 'a6'); await visibleInspector(page);
    assert.equal(await page.locator(query).inputValue(), '本地目标_b1', 'inspect selected keeps the current filters');
  });

  await scenario('a removed route stays selected and marked unavailable until the user resets the filters', async h => {
    const { page } = h, run = await create(h); await view(page, 'list'); await page.locator(route).selectOption('A');
    const control = controls.get(run.id)!; control.observation.plan!.proofRoutes = control.observation.plan!.proofRoutes!.filter(item => item.id !== 'A');
    control.observation.plan!.baseVersion = 'plan-v2'; control.observation.inspection.planVersion = 'plan-v2';
    control.observation.inspection.mathematics.snapshot.routes = control.observation.inspection.mathematics.snapshot.routes.filter(item => item.routeId !== 'A');
    control.emit(); await poll(page); assert.equal(await page.locator(route).inputValue(), 'A');
    assert.match(await page.locator(`${route} option[value="A"]`).innerText(), /已移除|已删除|不.*存在/);
    await expectCards(page, []); await page.locator('[data-collab-task-empty]:visible').waitFor(); await expectSelected(page, 'original');
    await page.locator(reset).click(); await expectCards(page, allTasks.map(task => task.id)); assert.equal(await page.locator(route).inputValue(), '');
  });

  await scenario('historical selection remains an exact retained contract and never offers a current-card replacement', async h => {
    const { page } = h, run = await create(h); await view(page, 'list');
    await page.locator('[data-collab-jump="deliveries"]').click(); await page.locator('[data-delivery-id="old-a5-delivery"]').click();
    await page.locator(`[data-delivery-detail] [data-collab-task="a5"][data-task-version="${oldA5Version}"]`).click();
    await expectSelected(page, 'a5', oldA5Version); await visibleInspector(page); assert.match(await page.locator('[data-task-history-notice]').innerText(), /历史/);
    assert.match(await page.locator(notice).innerText(), /历史/); assert.equal(await page.locator(card('a5')).getAttribute('aria-pressed'), 'false');
    await tasksSection(page); await page.locator(route).selectOption('B'); await page.locator(query).fill('本地目标_b3');
    assert.equal(await page.locator('[data-collab-task-show-selected]').count(), 0, 'a historical selection never navigates to a current-version substitute');
    controls.get(run.id)!.emit(); await poll(page); await expectSelected(page, 'a5', oldA5Version);
    await page.locator('[data-collab-task-inspect-selected]').click(); await visibleInspector(page); await expectSelected(page, 'a5', oldA5Version);
    assert.equal(await page.locator(route).inputValue(), 'B'); assert.equal(await page.locator(query).inputValue(), '本地目标_b3');
    assert.ok((await page.locator(inspector).innerText()).includes(oldA5.objective)); assert.equal((await page.locator(`${inspector} pre`).allTextContents()).includes(longType), false);
    assert.notEqual(oldA5Version, currentA5Version); assert.equal(await page.locator('[data-collab-guide-task]').isDisabled(), true);
  });

  for (const width of [375, 320]) await scenario(`mobile ${width}px forces a fitting list and restores long-task reading after inspector navigation and polling`, async h => {
    const { page } = h, run = await create(h); assert.equal(await page.locator(map).getAttribute('data-task-view'), 'list');
    for (const mode of ['graph', 'list']) assert.equal(await page.locator(`[data-collab-task-view="${mode}"]`).isVisible(), false, 'mobile hides desktop view controls');
    assert.equal(await page.locator('.collab-graph-scroll').isVisible(), false); await expectCards(page, allTasks.map(task => task.id));
    await page.locator(route).selectOption('A'); await page.locator(query).fill('本地目标_'); await page.locator(card('a5')).scrollIntoViewIfNeeded();
    const inner = await page.locator(list).evaluate(node => node.scrollTop), outer = await page.locator(panel).evaluate(node => node.scrollTop); assert.ok(outer > 0);
    await page.locator(card('a5')).click(); await expectSelected(page, 'a5'); await visibleInspector(page); await fit(page);
    assert.ok((await page.locator(`${inspector} pre`).allTextContents()).includes(longType));
    await page.screenshot({ path: path.join(output, `inspector-${width}.png`) });
    controls.get(run.id)!.observation.inspection.tasks.find(task => task.id === 'a5')!.attempts++;
    controls.get(run.id)!.emit(); await poll(page); assert.equal(await isFocused(page, '[data-inspected-task-heading]'), true, 'same-version inspector updates preserve the reader focus');
    await page.locator(back).click(); await settled(page); assert.equal(await isFocused(page, card('a5')), true);
    assert.equal(await page.locator(list).evaluate(node => node.scrollTop), inner); assert.equal(await page.locator(panel).evaluate(node => node.scrollTop), outer);
    assert.equal(await page.locator(route).inputValue(), 'A'); assert.equal(await page.locator(query).inputValue(), '本地目标_');
    assert.equal(await page.locator(card('a5')).getAttribute('aria-pressed'), 'true'); await fit(page);
    await page.screenshot({ path: path.join(output, `mobile-${width}.png`) });
    await page.locator(state).selectOption('running'); await expectCards(page, ['a2', 'a6']);
    await expectSelected(page, 'a5'); assert.match(await page.locator(notice).innerText(), /a5/);
    await page.locator('[data-collab-task-inspect-selected]').click(); await expectSelected(page, 'a5'); await visibleInspector(page);
  }, width);

  await scenario('graph cards show recorded task tokens against the largest task, and the inspector breaks them down', async h => {
    const { page } = h; await create(h); await view(page, 'graph');
    const tokens = (id: string) => page.locator(`${graphCard(id)} .collab-task-tokens`);
    const share = (id: string) => page.locator(`${graphCard(id)} .collab-task-usage>span`).evaluate(node =>
      node.getBoundingClientRect().width / node.parentElement!.getBoundingClientRect().width);
    assert.deepEqual(await Promise.all(['a2', 'a6', 'b2', 'b6'].map(id => tokens(id).innerText())), ['123 万', '30 万', '5 万', '800']);
    assert.ok(Math.abs(await share('a2') - 1) < 0.01, 'the task with the most tokens fills its meter');
    assert.ok(Math.abs(await share('a6') - 300_000 / 1_234_567) < 0.01, 'meters are proportional to the largest task');
    assert.equal(await page.locator(`${graphCard('a1')} .collab-task-tokens, ${graphCard('a1')} .collab-task-usage`).count(), 0, 'no usage is drawn without a record');
    for (const id of ['a2', 'b6']) {
      const [cardBox, labelBox, ownerBox] = await Promise.all([page.locator(graphCard(id)), tokens(id), page.locator(`${graphCard(id)} small`)].map(item => item.boundingBox()));
      assert.ok(cardBox && labelBox && ownerBox && labelBox.x + labelBox.width <= cardBox.x + cardBox.width && labelBox.y + labelBox.height <= cardBox.y + cardBox.height,
        `${id} token count stays inside its card`);
      assert.ok(await page.locator(`${graphCard(id)} small`).evaluate(node => {
        const label = node.parentElement!.querySelector('.collab-task-tokens')!.getBoundingClientRect(), range = document.createRange();
        range.selectNodeContents(node); return range.getBoundingClientRect().right <= label.left;
      }), `${id} owner text ends before the token count`);
    }
    assert.deepEqual(await page.locator('[data-collab-usage-legend]>span').allInnerTexts(), ['Token 色条：相对用量最多的任务', '任务 159 万 / 运行 200 万']);
    await page.locator(graphCard('a2')).click(); await expectSelected(page, 'a2');
    assert.match(await page.locator(inspector).innerText(), /Token 用量\s*123 万 · 输入 120 万（缓存命中 90 万） · 输出 3\.5 万/);
    await page.screenshot({ path: path.join(output, 'desktop-usage.png') });
    await create(h, emptyTask); assert.equal(await page.locator('[data-collab-usage-legend]').isHidden(), true, 'runs without task usage hide the legend');
  });

  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', null, 'local-real-http-task-browser', {
    checks: suite.checks, taskCount: allTasks.length, proofReceipts: 0, leanProcesses: 0,
    screenshots: ['desktop.png', 'desktop-inspector.png', 'desktop-usage.png', 'mobile-375.png', 'inspector-375.png', 'mobile-320.png', 'inspector-320.png'],
  }, { credential: input.apiKey });
  console.log(`Task browser: ${suite.checks.length}/${suite.checks.length} passed`);
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-task-browser', {
    checks: suite.checks, taskCount: allTasks.length, proofReceipts: 0, leanProcesses: 0,
  }, { credential: input.apiKey, failureRequests: true }); throw error;
} finally {
  for (const control of controls.values()) control.finish(); await browser.close(); await service.close();
}
