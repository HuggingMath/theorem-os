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
import type { WebObservation, WebPlanProposal } from '../apps/web/collaboration';
import type { SolverProblem } from '../src/solver/problem';
import { parseCooperationPlan, taskVersion } from '../src/solver/tasks';
import { researchWorkerCanTask } from '../src/solver/modules/organization';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { closeDialog, refreshHistory, selectHistoryRun } from './web-ui-controls';
import { freePort, postRun, settled, startBrowser, webScenario, writeScenarioReport,
  type ScenarioHarness, type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-plan-structure');
await fs.mkdir(output, { recursive: true });
const now = () => new Date().toISOString(), environmentDigest = mathDigest('local plan structure browser fixture');
const source = 'theorem original_goal : True := by sorry\n';
const problem: SolverProblem = { kind: 'example', workspace: output, projectRelative: '.', baseCommit: mathDigest('fixture-base').slice(0, 40),
  receiptDigest: mathDigest('fixture-problem'), activeProblemPath: path.join(output, 'unused-active-problem.json'),
  ownedFiles: ['Submission.lean', 'Helpers.lean'], trustedFiles: {}, sourceStructure: {},
  declarations: { 'Submission.lean': [{ name: 'original_goal', header: 'original_goal : True' }], 'Helpers.lean': [] },
  targets: [{ proofPath: 'Submission.lean', theoremName: 'original_goal', declarationHash: mathDigest('original_goal : True') }],
  contract: { problemId: 'plan-structure-fixture', informalStatement: 'Prove True', formalStatement: 'True', assumptions: [], knownTraps: [],
    acceptanceCriteria: [], officialVerificationCommand: 'fixture-never-run', statementHash: mathDigest('Prove True'), leanStatementHash: mathDigest('True') } };
const workers = [{ id: 'engineer', role: 'engineer' }, { id: 'researcher', role: 'researcher' },
  { id: 'prover', role: 'prover' }, { id: 'reviewer', role: 'reviewer' }] as const;
const initial = parseCooperationPlan(problem, { tasks: [
  { id: 'base', kind: 'lemma', objective: 'Prove the reusable premise', dependsOn: [], revision: 0, proofPath: 'Helpers.lean', theoremName: 'helper_base', type: 'True' },
  { id: 'closing', kind: 'lemma', objective: 'Close the first route', dependsOn: ['base'], revision: 0, proofPath: 'Helpers.lean', theoremName: 'helper_closing', type: 'True' },
  { id: 'alternative', kind: 'lemma', objective: 'Explore an independent closing argument', dependsOn: [], revision: 0, proofPath: 'Helpers.lean', theoremName: 'helper_alternative', type: 'True' },
  { id: 'note', kind: 'research', objective: 'Investigate the missing mathematical idea', dependsOn: [], revision: 0 },
  { id: 'original', kind: 'goal', objective: 'Prove the frozen original theorem', dependsOn: [], revision: 0, proofPath: 'Submission.lean', theoremName: 'original_goal' },
], proofRoutes: [{ id: 'route_A', targetTaskId: 'original', closingTaskId: 'closing', prerequisiteTaskIds: ['base'] }] });
type Control = { observation: WebObservation; emit(): void; finish(): void };
type Harness = ScenarioHarness & { runIds: string[]; submissions: { runId: string; type: string; body: string }[] };
const controls = new Map<string, Control>();
const checked: { runId: string; type: string; proposal: WebPlanProposal }[] = [];
function observation(id: string): WebObservation {
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `solver-${id}`, stateDigest: mathDigest(id), resultDigest: null };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: structuredClone(initial.tasks), groups: [], proofRoutes: structuredClone(initial.proofRoutes) },
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
      problem: { id: problem.contract.problemId, statement: 'Prove True', formalStatement: 'True', assumptions: [], targets: problem.targets },
      configuration: { model: 'fixture', effort: 'low', workers: workers.length, coordination: 'cooperative', buildDigest: mathDigest('fixture-build'), environmentDigest },
      turns: 1, planVersion: 'plan-v1', scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: workers.length, working: 0,
        proofAssignments: 0, preparing: 0, stopping: 0, idle: workers.length, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded',
        droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'theoremos.obligation-snapshot.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: mathDigest('fixture-mathematics'),
        obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['base', 'closing', 'alternative', 'original'] },
      groups: initial.groups.map(group => ({ group, turns: 0 })), tasks: initial.tasks.map(task => ({ id: task.id, kind: task.kind,
        objective: task.objective, group: task.groupId ?? 'main', status: 'pending', control: task.status ?? 'active', version: taskVersion(task),
        theorem: task.theoremName, type: task.type, premises: task.premises ?? [], plannedDependencies: task.dependsOn, attempts: 0,
        proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })),
      workers: workers.map(worker => ({ ...worker, phase: 'waiting', turns: 0, dispatchWait: { status: 'unknown' } })), statementReviews: [], edits: [] },
    sources: [], checks: [], guidance: [], deliveries: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}
function validate(proposal: WebPlanProposal) {
  const parsed = parseCooperationPlan(problem, proposal);
  for (const task of parsed.tasks) if (task.ownerId && !workers.some(worker => worker.id === task.ownerId && researchWorkerCanTask(worker, task)))
    throw new Error('math_plan_task_owner_unavailable');
  for (const group of parsed.groups) if (group.engineerId && !workers.some(worker => worker.id === group.engineerId && worker.role === 'engineer'))
    throw new Error('math_plan_group_engineer_unavailable');
  return parsed;
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local structure editor fixture; actual plan parser, no Lean or model' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), finish: resolve, emit() {
        this.observation = { ...this.observation, sequence: this.observation.sequence + 1, observedAt: now() };
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true }); control.emit();
    });
  },
  async command(runId, command) {
    if (command.type !== 'edit' && command.type !== 'edit-preview') throw new Error('Structure editor must only send plan proposals');
    const control = controls.get(runId)!;
    if (command.proposal.baseVersion !== control.observation.plan!.baseVersion) throw new Error('math_edit_version_conflict');
    const parsed = validate(command.proposal); checked.push({ runId, type: command.type, proposal: structuredClone(command.proposal) });
    if (command.type === 'edit-preview') return { id: command.proposal.id, status: 'validated', affectedTaskIds: parsed.tasks.map(task => task.id) };
    control.observation.plan = { ...structuredClone(command.proposal), baseVersion: 'plan-v2' };
    control.observation.inspection.planVersion = 'plan-v2';
    control.observation.inspection.edits.push({ id: command.proposal.id, status: 'applied', baseVersion: command.proposal.baseVersion, planVersion: 'plan-v2',
      affectedTasks: parsed.tasks.map(task => task.id), recheck: { status: 'pending', tasks: [] } }); control.emit();
    return { id: command.proposal.id, status: 'queued', observation: control.observation };
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-local-plan-structure-fixture', model: 'fixture', effort: 'low', environment: 'standard', source,
  task: 'Inspect task, group and alternative route structure editing', maxTurns: 2, maxRunSeconds: 60, workers: 4, coordination: 'cooperative' };
const selector = (name: string) => `[data-plan-${name}]`;
const json = (page: Page) => page.locator('#collab-plan-json').inputValue();
const proposal = async (page: Page) => JSON.parse(await json(page)) as WebPlanProposal;
const task = async (page: Page, id?: string) => { const plan = await proposal(page), selected = id ?? await page.locator(selector('task')).inputValue(); return plan.tasks.find(task => task.id === selected)!; };
const field = (page: Page, name: string, value: string) => page.locator(selector(name)).fill(value);
const pick = (page: Page, name: string, value: string) => page.locator(selector(name)).selectOption(value);
async function create(h: Harness) {
  const run = await postRun(h, input); h.runIds.push(run.id); await refreshHistory(h.page); await selectHistoryRun(h.page, run.id);
  await h.page.locator('.collab-surface').waitFor(); await h.page.locator('[data-collab-plan]:enabled').click();
  await h.page.locator('.collab-plan-dialog[open]').waitFor(); await pick(h.page, 'task', 'base');
  await expand(h.page, '前提、证明位置与共享范围'); return run;
}
async function expand(page: Page, title: string) {
  const details = page.locator('.collab-plan-dialog details').filter({ has: page.locator('summary').getByText(title, { exact: true }) });
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
}
const groups = (page: Page) => expand(page, '任务分组与 Engineer');
const routes = (page: Page) => expand(page, 'OR 证明路线');
async function preview(page: Page) { await page.locator(selector('preview')).click(); await page.locator(`${selector('apply')}:enabled`).waitFor(); }
async function add(page: Page, kind: 'lemma' | 'research' | 'sketch') {
  await pick(page, 'new-kind', kind); await page.locator(selector('add')).click();
  const id = await page.locator(selector('task')).inputValue(); assert.match(id, new RegExp(`^human_${kind}_\\d+$`)); return id;
}
async function poll(page: Page) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'GET');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await response; await settled(page);
}
async function fit(page: Page, names: string[]) {
  const width = page.viewportSize()!.width;
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  for (const name of names) {
    const box = await page.locator(selector(name)).boundingBox(); assert.ok(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1,
      `${name} must fit ${width}px: ${JSON.stringify(box)}`);
  }
}
function scenario(name: string, run: (h: Harness) => Promise<void>, width = 1440) {
  return webScenario(browser, suite, name, run, {
    context: { viewport: { width, height: width > 850 ? 1000 : 812 }, reducedMotion: 'reduce' },
    harness: (page, context) => {
      const h: Harness = { page, context, requests: [], runIds: [], submissions: [] };
      h.intercept = async route => { const pathname = new URL(route.request().url()).pathname;
        const edit = /^\/api\/runs\/([^/]+)\/edits(\/preview)?$/.exec(pathname);
        if (edit && route.request().method() === 'POST') h.submissions.push({ runId: edit[1]!, type: edit[2] ? 'preview' : 'apply', body: route.request().postData()! });
        return false; }; return h;
    }, routes: { local: 'Plan structure browser fixture must stay local' }, open: true, timeout: { label: 'Plan structure', seconds: 60 },
    verify: (h, elapsedMs) => ({ name, elapsedMs: elapsedMs(), requests: h.requests, submissions: h.submissions }),
    cleanup: h => { for (const id of h.runIds) controls.get(id)?.finish(); },
  });
}

try {
  await scenario('common task contracts and all task kinds are editable without JSON', async h => {
    const { page } = h; await create(h);
    assert.equal(await page.locator(selector('new-kind')).inputValue(), 'lemma');
    assert.equal(await page.locator(selector('task-group')).inputValue(), 'main');
    await field(page, 'objective', 'Prove the explicit reusable bridge'); await field(page, 'proof-path', 'Submission.lean');
    await field(page, 'theorem', 'bridge_from_ui'); await field(page, 'type', '∀ (P : Prop), P → P');
    await field(page, 'premises', 'Keep the original assumptions frozen\nEvery input remains explicit');
    await field(page, 'dependencies', 'alternative'); await pick(page, 'sharing', 'problem');
    await page.locator(selector('conditional')).check(); await pick(page, 'owner', 'prover');
    assert.deepEqual((await task(page)).premises, ['Keep the original assumptions frozen', 'Every input remains explicit']);
    assert.equal((await task(page)).conditional, true); assert.equal((await task(page)).theoremName, 'bridge_from_ui');
    await pick(page, 'status', 'paused'); assert.equal((await task(page)).ownerId, 'prover'); await pick(page, 'status', 'active');
    const lemma = await add(page, 'lemma'); assert.equal((await task(page)).type ?? '', '');
    assert.equal((await page.locator(`${selector('owner')} option`).allTextContents()).some(text => text.includes('prover')), false);
    await field(page, 'objective', 'A new exact mathematical lemma'); await field(page, 'proof-path', 'Helpers.lean');
    await field(page, 'theorem', 'fresh_ui_lemma'); await field(page, 'type', 'True'); await pick(page, 'owner', 'prover');
    assert.equal((await task(page, lemma)).kind, 'lemma');
    await page.locator(selector('conditional')).check(); await pick(page, 'kind', 'research');
    for (const name of ['type', 'theoremName', 'proofPath', 'conditional', 'statementReview'])
      assert.equal((await task(page, lemma))[name as keyof WebPlanProposal['tasks'][number]], undefined, `advisory conversion clears ${name}`);
    assert.equal((await task(page, lemma)).ownerId, 'prover', 'kind changes preserve the owner for host validation');
    await page.locator(selector('preview')).click(); await page.locator(selector('receipt')).getByText(/math_plan_task_owner_unavailable/).waitFor();
    await pick(page, 'owner', 'researcher'); await pick(page, 'kind', 'sketch'); await pick(page, 'kind', 'lemma');
    assert.equal((await task(page, lemma)).type ?? '', ''); await field(page, 'type', 'True');
    const research = await add(page, 'research'); await field(page, 'objective', 'Investigate an uncertain implication');
    await pick(page, 'owner', 'researcher'); const researchTask = await task(page, research);
    assert.equal(researchTask.kind, 'research'); assert.equal(researchTask.theoremName, undefined); assert.equal(researchTask.type, undefined);
    assert.equal((await page.locator(`${selector('owner')} option`).allTextContents()).some(text => text.includes('prover')), false);
    const sketch = await add(page, 'sketch'); await field(page, 'objective', 'Sketch the consumer connection'); assert.equal((await task(page, sketch)).kind, 'sketch');
    await pick(page, 'task', 'original');
    for (const name of ['kind', 'proof-path', 'theorem', 'type', 'remove-task']) assert.equal(await page.locator(selector(name)).isDisabled(), true, `original goal ${name} is fixed`);
    assert.equal((await page.locator(`${selector('owner')} option`).allTextContents()).some(text => text.includes('prover') || text.includes('reviewer')), false);
    await preview(page); validate(await proposal(page));
    assert.equal(await page.locator(selector('advanced')).getAttribute('open'), null, 'ordinary editing does not require opening JSON');
  });

  await scenario('groups retain implicit main, Engineer roles and cross-group sharing contracts', async h => {
    const { page } = h; await create(h); const unchanged = await json(page); await groups(page);
    assert.equal(await page.locator(selector('group')).inputValue(), 'main'); assert.equal(await json(page), unchanged);
    await page.locator(selector('add-group')).click(); const id = await page.locator(selector('group')).inputValue(); assert.match(id, /^human_group_\d+$/);
    assert.ok((await proposal(page)).groups!.some(group => group.id === 'main'));
    await field(page, 'group-objective', 'Explore a separate mathematical route'); await pick(page, 'group-engineer', 'engineer');
    await pick(page, 'group-status', 'paused'); await field(page, 'group-max-turns', '9'); await field(page, 'group-max-concurrent', '2');
    assert.deepEqual(await page.locator(`${selector('group-engineer')} option`).evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value).filter(Boolean)), ['engineer']);
    await pick(page, 'sharing', 'problem');
    await pick(page, 'task', 'closing'); await pick(page, 'task-group', id); await pick(page, 'sharing', 'group'); await page.locator(selector('preview')).click();
    await page.locator(selector('receipt')).getByText(/math_plan_proof_route_input_not_shared/).waitFor();
    await pick(page, 'sharing', 'problem'); await preview(page);
    const group = (await proposal(page)).groups!.find(group => group.id === id)!;
    assert.equal(group.engineerId, 'engineer'); assert.equal(group.status, 'paused'); assert.equal(group.maxTurns, 9); assert.equal(group.maxConcurrent, 2);
    const before = await json(page); await page.locator(selector('remove-group')).click();
    await page.locator(`${selector('receipt')} .collab-error`).waitFor(); assert.equal(await json(page), before, 'a group with members is retained unchanged');
    await pick(page, 'task-group', 'main'); await page.locator(selector('remove-group')).click();
    assert.equal((await proposal(page)).groups!.some(group => group.id === id), false);
    assert.ok((await proposal(page)).groups!.some(group => group.id === 'main')); await preview(page);
    await page.screenshot({ path: path.join(output, 'groups-desktop.png') });
  });

  await scenario('OR route editing uses exact typed inputs and actual plan validation', async h => {
    const { page } = h; await create(h); await routes(page); await page.locator(selector('add-route')).click();
    const id = await page.locator(selector('route')).inputValue(); assert.match(id, /^human_route_\d+$/);
    assert.deepEqual(await page.locator(`${selector('route-target')} option`).evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value).filter(Boolean)), ['original']);
    const closingOptions = await page.locator(`${selector('route-closing')} option`).evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value).filter(Boolean));
    assert.deepEqual(closingOptions.sort(), ['alternative', 'base', 'closing']);
    await pick(page, 'route-closing', 'alternative'); await field(page, 'route-prerequisites', 'base');
    await page.locator(selector('preview')).click(); await page.locator(selector('receipt')).getByText(/math_plan_proof_route_missing_prerequisite/).waitFor();
    await pick(page, 'task', 'alternative'); await field(page, 'dependencies', 'base');
    await field(page, 'route-prerequisites', 'note'); await page.locator(selector('preview')).click();
    await page.locator(selector('receipt')).getByText(/math_plan_invalid_proof_route_input/).waitFor();
    await field(page, 'route-prerequisites', 'base'); await preview(page);
    assert.deepEqual((await proposal(page)).proofRoutes!.find(route => route.id === id), { id, targetTaskId: 'original', closingTaskId: 'alternative', prerequisiteTaskIds: ['base'] });
    await page.screenshot({ path: path.join(output, 'routes-desktop.png') });
    await page.locator(selector('remove-route')).click(); assert.equal(await page.locator(selector('apply')).isDisabled(), true);
    assert.deepEqual((await proposal(page)).proofRoutes!.map(route => route.id), ['route_A']);
    assert.deepEqual((await task(page, 'alternative')).dependsOn, ['base'], 'removing a route does not rewrite task dependencies'); await preview(page);
  });

  await scenario('guarded deletion, frozen original targets and JSON interoperate without draft loss', async h => {
    const { page } = h; await create(h); let before = await json(page);
    await page.locator(selector('remove-task')).click(); await page.locator(`${selector('receipt')} .collab-error`).waitFor();
    assert.equal(await json(page), before, 'referenced task cannot be removed');
    await pick(page, 'task', 'closing'); await field(page, 'dependencies', ''); await pick(page, 'task', 'base'); before = await json(page);
    await page.locator(selector('remove-task')).click(); assert.equal(await json(page), before, 'route reference still retains the task');
    await routes(page); await pick(page, 'route', 'route_A'); await field(page, 'route-prerequisites', '');
    await page.locator(selector('remove-task')).click(); assert.equal((await proposal(page)).tasks.some(task => task.id === 'base'), false);
    await pick(page, 'task', 'closing'); before = await json(page); await page.locator(selector('remove-task')).click();
    assert.equal(await json(page), before, 'closing task remains while its route references it');
    await page.locator(selector('remove-route')).click(); await page.locator(selector('remove-task')).click();
    assert.equal((await proposal(page)).tasks.some(task => task.id === 'closing'), false);
    await expand(page, '高级：完整计划 JSON'); const advanced = page.locator('#collab-plan-json');
    const edited = await proposal(page); edited.tasks.find(task => task.id === 'alternative')!.objective = 'Edited through advanced JSON';
    await advanced.fill(JSON.stringify(edited, null, 2)); await advanced.press('Tab'); await pick(page, 'task', 'alternative');
    assert.equal(await page.locator(selector('objective')).inputValue(), 'Edited through advanced JSON');
    const valid = await json(page); await advanced.fill('{"tasks":'); await advanced.press('Tab');
    assert.equal(await page.locator(selector('add')).isDisabled(), true); assert.equal(await json(page), '{"tasks":', 'structured controls must not overwrite invalid local JSON');
    const submissions = h.submissions.length; assert.equal(await page.locator(selector('preview')).isDisabled(), true);
    assert.equal(h.submissions.length, submissions, 'invalid JSON must not send a request');
    await advanced.fill(valid); await advanced.press('Tab'); const tampered = await proposal(page);
    tampered.tasks.find(task => task.id === 'original')!.theoremName = 'changed_original_goal';
    await advanced.fill(JSON.stringify(tampered, null, 2)); await advanced.press('Tab'); await page.locator(selector('preview')).click();
    await page.locator(selector('receipt')).getByText(/math_plan_changed_original_target/).waitFor(); assert.equal(await page.locator(selector('apply')).isDisabled(), true);
    await advanced.fill(valid); await advanced.press('Tab'); await preview(page);
  });

  await scenario('polling and reopening preserve structure and only the current full preview may be submitted', async h => {
    const { page } = h, run = await create(h), control = controls.get(run.id)!;
    const research = await add(page, 'research'); await field(page, 'objective', 'Retained local research objective'); await preview(page);
    await field(page, 'premises', 'Preserved premise'); assert.equal(await page.locator(selector('apply')).isDisabled(), true); await preview(page);
    await groups(page); await page.locator(selector('add-group')).click(); assert.equal(await page.locator(selector('apply')).isDisabled(), true);
    await field(page, 'group-objective', 'Retained secondary route'); await pick(page, 'group-engineer', 'engineer');
    const group = await page.locator(selector('group')).inputValue(); await pick(page, 'task-group', group); await preview(page);
    await routes(page); await page.locator(selector('add-route')).click(); await pick(page, 'route-closing', 'alternative');
    assert.equal(await page.locator(selector('apply')).isDisabled(), true); await preview(page);
    const retained = await json(page); await page.locator(selector('objective')).focus();
    control.observation.inspection.workers[0]!.turns++; control.emit(); await poll(page);
    assert.equal(await json(page), retained); assert.equal(await page.locator(selector('objective')).evaluate(node => node === document.activeElement), true);
    await closeDialog(page, '.collab-plan-dialog', () => page.locator(selector('close')).click());
    await page.locator('[data-collab-plan]').click(); await pick(page, 'task', research); assert.equal(await json(page), retained);
    await page.locator(selector('apply')).click(); await page.locator(selector('receipt')).getByText(/回执 .* · applied/).waitFor();
    const submitted = h.submissions.filter(item => item.runId === run.id && item.type === 'apply'); assert.equal(submitted.length, 1);
    assert.deepEqual(JSON.parse(submitted[0]!.body), JSON.parse(retained)); validate(JSON.parse(submitted[0]!.body));
    assert.ok(JSON.parse(submitted[0]!.body).groups.some((item: { id: string }) => item.id === group));
    assert.equal(JSON.parse(submitted[0]!.body).proofRoutes.length, 2);
    assert.ok((await page.locator(selector('receipt')).innerText()).includes('不代表证明已重新检查'));
  });

  for (const width of [375, 320]) await scenario(`task, group and route controls fit ${width}px`, async h => {
    const { page } = h; await create(h); await add(page, 'research'); await field(page, 'objective', 'Editable advisory task on a narrow screen');
    await fit(page, ['task', 'kind', 'owner', 'status', 'new-kind', 'objective', 'task-group', 'sharing', 'premises', 'add', 'remove-task', 'preview', 'apply', 'close']);
    await groups(page); await page.locator(selector('add-group')).click(); await field(page, 'group-objective', 'A separately coordinated proof direction');
    await pick(page, 'group-engineer', 'engineer'); await field(page, 'group-max-turns', '8'); await field(page, 'group-max-concurrent', '2');
    await fit(page, ['group', 'group-objective', 'group-engineer', 'group-status', 'group-max-turns', 'group-max-concurrent', 'add-group', 'remove-group']);
    await page.locator(selector('group-objective')).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `groups-${width}.png`) });
    await routes(page); await page.locator(selector('add-route')).click(); await pick(page, 'route-closing', 'alternative');
    await fit(page, ['route', 'route-target', 'route-closing', 'route-prerequisites', 'add-route', 'remove-route']);
    await page.locator(selector('route-prerequisites')).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `routes-${width}.png`) });
    await preview(page); validate(await proposal(page));
    for (const name of ['preview', 'apply', 'close']) { const box = await page.locator(selector(name)).boundingBox();
      assert.ok(box && box.y >= -1 && box.y + box.height <= 813, `${name} remains reachable in the mobile dialog`); }
  }, width);

  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined, 'local-real-http-plan-parser',
    { checks: suite.checks, parser: 'parseCooperationPlan', leanProcesses: 0, validatedCommands: checked.map(item => ({ runId: item.runId, type: item.type })),
      screenshots: ['groups-desktop.png', 'routes-desktop.png', 'groups-375.png', 'routes-375.png', 'groups-320.png', 'routes-320.png'] }, { credential: input.apiKey });
  console.log('Plan structure browser checks passed');
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-plan-parser',
    { checks: suite.checks, parser: 'parseCooperationPlan', leanProcesses: 0 }, { credential: input.apiKey, failureRequests: true }); throw error;
} finally {
  for (const control of controls.values()) control.finish(); await browser.close(); await service.close();
}
