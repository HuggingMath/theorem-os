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
import type { WebCheckReceipt, WebDelivery, WebInspectedTask, WebObservation, WebTaskSource } from '../apps/web/collaboration';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { refreshHistory, selectHistoryRun } from './web-ui-controls';
import { freePort, postRun, settled, startBrowser, webScenario, writeScenarioReport,
  type ScenarioHarness, type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-research-progress');
await fs.mkdir(output, { recursive: true });
const environmentDigest = mathDigest('offline browser research progress fixture'), now = () => new Date().toISOString();
const raw = '<img src=x onerror="globalThis.__researchXss=1"><script>globalThis.__researchXss=2</script>';
const retainedFinding = Array.from({ length: 90 }, (_, index) => `retained-note-line-${index}: inspect the same immutable delivery`).join('\n');
type Delivery = WebDelivery & { evidence?: { passed: boolean; verification: { status: string; targetCommit: string; results: { receiptId: string }[] } } };
type Control = { observation: WebObservation; emit(): void; finish(): void };
type Harness = ScenarioHarness & { runIds: string[] };
const controls = new Map<string, Control>();

function savedSource(taskId: string, taskVersion: string, label: string, source: string): WebTaskSource {
  return { taskId, taskVersion, commit: mathDigest(`${label}-commit`).slice(0, 40), sourceDigest: mathDigest(source),
    environmentDigest, file: `${taskId}.lean`, source, scope: 'owned-file' };
}
const current = savedSource('base', 'base-v1', 'current', 'theorem base : True := by trivial\n-- current delivery source\n');
const historical = savedSource('base', 'base-v0', 'historical', 'theorem base (n : Nat) : n = n := by rfl\n-- historical delivery source\n');
const other = savedSource('route_b', 'route_b-v1', 'other', 'theorem route_b : True := by trivial\n-- unrelated source\n');
const sourceKey = (source: WebTaskSource) => JSON.stringify([source.taskId, source.taskVersion, source.commit, source.sourceDigest, source.environmentDigest, source.file]);
function check(id: string, source: WebTaskSource): WebCheckReceipt {
  return { id, taskId: source.taskId, taskVersion: source.taskVersion, commit: source.commit,
    sourceDigest: source.sourceDigest, environmentDigest: source.environmentDigest,
    record: { receiptId: id, status: 'kernel_verified', passed: true, fixture: 'simulated receipt; no Lean process' } };
}
const checks = [check('check-current', current), check('check-historical', historical),
  check('unclaimed-check', current), check('foreign-task-check', { ...current, taskId: 'route_b' }),
  check('foreign-version-check', { ...current, taskVersion: 'base-v0' }),
  check('foreign-commit-check', { ...current, commit: mathDigest('foreign-commit').slice(0, 40) }),
  check('foreign-source-check', { ...current, sourceDigest: mathDigest('foreign-source') }),
  check('foreign-environment-check', { ...current, environmentDigest: mathDigest('foreign-environment') })];
const evidence = (source: WebTaskSource, ids: string[]): NonNullable<Delivery['evidence']> => ({ passed: true,
  verification: { status: 'passed', targetCommit: source.commit, results: ids.map(receiptId => ({ receiptId })) } });
const baseDelivery = (id: string, extra: Partial<Delivery> = {}): Delivery => ({ id, producer: 'prover-1', taskId: current.taskId,
  taskDigest: current.taskVersion, kind: 'proof', status: 'verified', statement: 'The reusable premise is True', premises: [],
  dependencies: [], remainingObligations: ['Connect the original consumer'], summary: `Delivery ${id}`,
  evidenceRefs: ['Human-readable evidence note'], createdAt: 1, commit: current.commit, sourceDigest: current.sourceDigest,
  evidence: evidence(current, ['check-current']), ...extra });
const deliveries: Delivery[] = [
  baseDelivery('current-proof', { createdAt: 20, finding: retainedFinding, premises: ['The original assumptions remain frozen'],
    evidence: evidence(current, checks.filter(item => item.id !== 'unclaimed-check' && item.id !== 'check-historical').map(item => item.id)) }),
  baseDelivery('historical-proof', { createdAt: 19, status: 'superseded', taskDigest: historical.taskVersion,
    commit: historical.commit, sourceDigest: historical.sourceDigest, evidence: evidence(historical, ['check-historical']) }),
  baseDelivery('raw-advisory', { createdAt: 18, producer: 'researcher-1', kind: 'research', status: 'advisory',
    statement: `Fermat route note ${raw}`, summary: `Untrusted summary ${raw}`, finding: `Full advisory finding ${raw}`,
    premises: [`Untrusted premise ${raw}`], remainingObligations: [`Untrusted remaining obligation ${raw}`],
    evidenceRefs: ['check-current', `https://example.invalid/${raw}`, raw], evidence: undefined }),
  baseDelivery('no-task-version', { taskDigest: undefined }),
  baseDelivery('no-task-id', { taskId: undefined }),
  baseDelivery('no-commit', { commit: undefined }),
  baseDelivery('no-source-digest', { sourceDigest: undefined }),
  baseDelivery('wrong-task', { taskId: 'route_b' }),
  baseDelivery('wrong-version', { taskDigest: 'base-v999' }),
  baseDelivery('wrong-commit', { commit: mathDigest('absent-commit').slice(0, 40) }),
  baseDelivery('wrong-source-digest', { sourceDigest: mathDigest('absent-source') }),
  baseDelivery('no-check-evidence', { evidence: undefined, evidenceRefs: ['check-current'] }),
  baseDelivery('wrong-check-commit', { evidence: { passed: true,
    verification: { status: 'passed', targetCommit: mathDigest('unrelated-check-commit').slice(0, 40), results: [{ receiptId: 'check-current' }] } } }),
  baseDelivery('unclaimed-checks', { evidence: evidence(current, []) }),
  baseDelivery('statement-review', { producer: 'reviewer', kind: 'statement-review', status: 'accepted' }),
  baseDelivery('backtranslation', { producer: 'reviewer', kind: 'backtranslation', status: 'accepted' }),
  baseDelivery('ordinary-advisory', { kind: 'research', status: 'advisory', summary: 'An ordinary research note without proof materials',
    commit: undefined, sourceDigest: undefined, evidence: undefined }),
];

function observation(id: string): WebObservation {
  const plan: NonNullable<WebObservation['plan']> = { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [
    { id: 'base', kind: 'lemma', objective: 'Current reusable premise contract', dependsOn: [], revision: 1, theoremName: 'base', proofPath: 'base.lean', type: 'True' },
    { id: 'route_a', kind: 'lemma', objective: 'Close the first alternative', dependsOn: ['base'], revision: 1, theoremName: 'route_a', proofPath: 'route_a.lean', type: 'True' },
    { id: 'route_b', kind: 'lemma', objective: 'Close the independent alternative', dependsOn: [], revision: 1, theoremName: 'route_b', proofPath: 'route_b.lean', type: 'True' },
    { id: 'original', kind: 'goal', objective: 'Prove the frozen original theorem', dependsOn: [], revision: 1, theoremName: 'original_goal', proofPath: 'Submission.lean', type: 'True' },
  ], proofRoutes: [{ id: 'A', targetTaskId: 'original', prerequisiteTaskIds: ['base'], closingTaskId: 'route_a' },
    { id: 'B', targetTaskId: 'original', prerequisiteTaskIds: [], closingTaskId: 'route_b' }] };
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `solver-${id}`, stateDigest: mathDigest(id), resultDigest: null };
  const tasks: WebInspectedTask[] = plan.tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective,
    group: 'main', status: task.id === 'base' ? 'completed' : 'pending', control: 'active', owner: task.id === 'base' ? 'prover-1' : undefined,
    version: `${task.id}-v1`, theorem: task.theoremName, type: task.type, premises: [], plannedDependencies: task.dependsOn,
    attempts: task.id === 'base' ? 2 : 0, proof: task.id === 'base' ? { status: 'checked', commit: current.commit,
      sourceDigest: current.sourceDigest, receiptIds: ['check-current'] } : { status: 'none' }, parkedBy: [], parkedRoutes: {} }));
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, plan,
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
      problem: { id: 'research-progress-fixture', statement: 'Prove the original theorem', formalStatement: 'True', assumptions: [], targets: [{ proofPath: 'Submission.lean', theoremName: 'original_goal' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 3, coordination: 'cooperative', buildDigest: mathDigest('research-fixture'), environmentDigest },
      turns: 2, planVersion: plan.baseVersion, scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 3, working: 1, proofAssignments: 1,
        preparing: 0, stopping: 0, idle: 2, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded',
        droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'theoremos.obligation-snapshot.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: mathDigest('research-obligations'), environmentDigest,
        obligations: tasks.map(task => ({ taskId: task.id, taskDigest: task.version, kind: task.kind, groupId: 'main',
          recordedProof: task.proof.status, closed: task.id === 'base', conditions: [], referenceCoverage: 'recorded' })),
        goals: [{ taskId: 'original', taskDigest: 'original-v1', closed: false,
          frontier: [{ taskId: 'route_a', taskDigest: 'route_a-v1' }, { taskId: 'route_b', taskDigest: 'route_b-v1' }],
          missingDependencies: [], routeCombination: 'any', alternatives: [
            { routeId: 'A', frontier: [{ taskId: 'route_a', taskDigest: 'route_a-v1' }], missingDependencies: [], parkedBy: [] },
            { routeId: 'B', frontier: [{ taskId: 'route_b', taskDigest: 'route_b-v1' }], missingDependencies: [], parkedBy: ['local-blocker'] }] }],
        blockers: [{ id: 'local-blocker', taskId: 'route_b', taskDigest: 'route_b-v1', groupId: 'main', routeId: 'B',
          mechanism: 'reference-coverage', scope: 'route', evidenceStatus: 'model-reported', status: 'active',
          evidenceRefs: [raw], reopenOn: [{ description: `Revisit after a new original consumer connection ${raw}` }] }],
        routes: plan.proofRoutes!.map(route => ({ routeId: route.id, ...route,
          remainingPrerequisiteTaskIds: [], closingStatus: 'none', ready: false, targetStatus: 'none', connection: 'not-established',
          referenceCoverageMissing: route.id === 'B' ? ['original'] : [], parkedBy: route.id === 'B' ? ['local-blocker'] : [] })), advisory: [] },
        recentChanges: [], retainedChangeLimit: 64 }, progress: { checkedProofTasks: 1, conditionalProofTasks: 0, completedResearchTasks: 0,
        openProofTasks: ['route_a', 'route_b', 'original'] }, groups: [], tasks,
      workers: [{ id: 'prover-1', role: 'prover', phase: 'proving', task: 'route_a', turns: 2, dispatchWait: { status: 'unknown' } },
        { id: 'researcher-1', role: 'researcher', phase: 'waiting', turns: 1, dispatchWait: { status: 'unknown' } },
        { id: 'reviewer', role: 'reviewer', phase: 'waiting', turns: 1, dispatchWait: { status: 'unknown' } }],
      statementReviews: [], edits: [] },
    history: [{ ...tasks[0]!, version: historical.taskVersion, objective: 'Historical contract before the premise was revised',
      type: '(n : Nat) → n = n', status: 'pending', attempts: 0, proof: { status: 'checked', commit: historical.commit,
        sourceDigest: historical.sourceDigest, receiptIds: ['check-historical'] } }],
    deliveries: structuredClone(deliveries), sources: [current, historical, other,
      { ...current, environmentDigest: mathDigest('foreign-environment'), file: 'foreign-environment.lean' }],
    checks: structuredClone(checks), guidance: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local research progress fixture; no model or Lean' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), finish: resolve, emit() {
        this.observation = { ...this.observation, sequence: this.observation.sequence + 1, observedAt: now() };
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true }); control.emit();
    });
  },
  async command() { throw new Error('Research progress inspection must not submit runtime commands'); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-local-research-progress-fixture', model: 'fixture', effort: 'low',
  environment: 'standard', source: 'theorem original_goal : True := by sorry\n', task: 'Inspect research progress and immutable deliveries',
  maxTurns: 2, maxRunSeconds: 60, workers: 3, coordination: 'cooperative' };
const frontier = '[data-research-frontier]', blockers = '[data-research-blockers]', section = '[data-research-deliveries]';
const producer = '[data-delivery-producer]', taskFilter = '[data-delivery-task]', query = '[data-delivery-query]';
const list = '[data-delivery-list]', detail = '[data-delivery-detail]', inspector = '[data-collab-inspector]';
async function create(h: Harness) {
  const run = await postRun(h, input); h.runIds.push(run.id); await refreshHistory(h.page); await selectHistoryRun(h.page, run.id);
  await h.page.locator(frontier).waitFor(); await h.page.locator(`${list} [data-delivery-id="current-proof"]`).waitFor(); return run;
}
async function choose(page: Page, id: string) {
  await page.locator(`${list} [data-delivery-id="${id}"]`).click();
  await page.locator(detail).filter({ hasText: id }).waitFor();
}
const linkedSources = (page: Page) => page.locator(`${detail} [data-collab-source]`).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-source-snapshot')).sort());
const linkedChecks = (page: Page) => page.locator(`${detail} [data-collab-check]`).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-collab-check')).sort());
const listed = (page: Page) => page.locator(`${list} [data-delivery-id]`).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-delivery-id')).sort());
async function poll(page: Page) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'GET');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await response; await settled(page);
}
async function clearFilters(page: Page) { await page.locator(producer).selectOption(''); await page.locator(taskFilter).selectOption(''); await page.locator(query).fill(''); }
async function openDetail(page: Page, container: string, title: string) {
  const item = page.locator(`${container} details`).filter({ has: page.locator('summary').getByText(title, { exact: true }) });
  if (!await item.getAttribute('open').then(value => value !== null)) await item.locator('summary').click();
  return item.locator('pre');
}
async function fit(page: Page, selectors: string[]) {
  const width = page.viewportSize()!.width;
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'research progress must not widen the document');
  for (const selector of selectors) {
    const box = await page.locator(selector).boundingBox(); assert.ok(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1,
      `${selector} must fit ${width}px: ${JSON.stringify(box)}`);
  }
}
function scenario(name: string, run: (h: Harness) => Promise<void>, width = 1440) {
  return webScenario(browser, suite, name, run, {
    context: { viewport: { width, height: width > 850 ? 1000 : 812 }, reducedMotion: 'reduce' },
    harness: (page, context) => ({ page, context, requests: [], runIds: [] }), routes: { local: 'Research inspection must stay local' }, open: true,
    timeout: { label: 'Research progress', seconds: 50 },
    verify: (h, elapsedMs) => { assert.equal(h.requests.some(item => item.method !== 'GET' && item.pathname !== '/api/runs'), false);
      return { name, elapsedMs: elapsedMs(), requests: h.requests }; },
    cleanup: h => { for (const id of h.runIds) controls.get(id)?.finish(); },
  });
}

try {
  await scenario('frontier shows alternative routes, local blockers and no S3 acceptance', async h => {
    const { page } = h, run = await create(h), control = controls.get(run.id)!;
    const content = await page.locator(frontier).innerText();
    for (const value of ['original', 'route_a', 'route_b']) assert.ok(content.includes(value), `frontier includes ${value}`);
    assert.match(content, /OR|择一|任选|任一|一条路线/);
    await page.locator(`${blockers} [data-research-blocker="local-blocker"]`).waitFor();
    assert.ok((await page.locator(blockers).innerText()).includes('reference-coverage'));
    const blockerReferences = await openDetail(page, blockers, '原始提示引用');
    assert.deepEqual(JSON.parse((await blockerReferences.textContent())!), [raw]);
    assert.equal(await page.locator(`${blockers} img,${blockers} script`).count(), 0);
    const goal = control.observation.inspection.mathematics.snapshot.goals[0]!;
    goal.alternatives![0]!.frontier.push({ taskId: 'base', taskDigest: null }); control.emit(); await poll(page);
    assert.ok((await page.locator(frontier).innerText()).includes('base · 版本未记录'));
    assert.equal(await page.locator(`${frontier} [data-collab-task="base"]`).count(), 0,
      'missing frontier identity must not link the current same-name task');
    goal.closed = true; goal.frontier = []; goal.alternatives = []; control.emit(); await poll(page);
    assert.match(await page.locator(frontier).innerText(), /闭合|关闭/);
    assert.ok((await page.locator('.collab-metrics').innerText()).includes('尚未验收通过'), 'a closed local frontier does not earn S3 acceptance');
    await page.locator(frontier).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'frontier-desktop.png') });
  });

  await scenario('delivery links require full source identities and explicitly claimed check receipts', async h => {
    const { page } = h, run = await create(h); await choose(page, 'current-proof');
    assert.deepEqual(await linkedSources(page), [sourceKey(current)]);
    assert.deepEqual(await linkedChecks(page), ['check-current']);
    await page.locator(`${detail} [data-collab-source]`).click();
    await page.locator('[data-task-source-code]').waitFor(); assert.equal(await page.locator('[data-task-source-code]').textContent(), current.source);
    for (const value of [current.taskId, current.taskVersion, current.commit, current.sourceDigest, current.environmentDigest])
      assert.ok((await page.locator('[data-task-source-side="after"]').innerText()).includes(value));
    await page.locator(`${detail} [data-collab-check="check-current"]`).click();
    await page.locator('[data-collab-artifact]').filter({ hasText: 'kernel_verified' }).waitFor();
    h.intercept = async route => {
      if (route.request().method() !== 'GET' || new URL(route.request().url()).pathname !== `/api/runs/${run.id}/checks/check-current`) return false;
      const response = await route.fetch(); assert.equal(response.status(), 200);
      const payload = await response.json() as { check: WebCheckReceipt };
      await route.fulfill({ response, json: { check: { ...payload.check, commit: mathDigest('substituted-check-commit').slice(0, 40),
        record: { ...payload.check.record, replacementMarker: 'wrong-identity-replacement-record' } } } }); return true;
    };
    await page.locator(`${detail} [data-collab-check="check-current"]`).click();
    await page.locator('[data-collab-artifact]').getByText('读取结果与所选检查回执身份不同，未展示替代材料。', { exact: true }).waitFor();
    assert.equal((await page.locator('[data-collab-artifact]').textContent())!.includes('wrong-identity-replacement-record'), false);
    assert.equal(await page.locator('[data-collab-artifact] pre').count(), 0);
    h.intercept = undefined;
    await choose(page, 'historical-proof'); assert.deepEqual(await linkedSources(page), [sourceKey(historical)]);
    assert.deepEqual(await linkedChecks(page), ['check-historical']);
    for (const id of ['no-task-version', 'no-task-id', 'no-commit', 'no-source-digest', 'wrong-task', 'wrong-version', 'wrong-commit', 'wrong-source-digest', 'statement-review', 'backtranslation', 'ordinary-advisory']) {
      await choose(page, id); assert.deepEqual(await linkedSources(page), [], `${id} cannot link a Lean source`);
      assert.deepEqual(await linkedChecks(page), [], `${id} cannot link a check receipt`);
    }
    for (const id of ['no-check-evidence', 'wrong-check-commit', 'unclaimed-checks', 'raw-advisory']) {
      await choose(page, id); assert.deepEqual(await linkedSources(page), [sourceKey(current)], `${id} still has an exact source identity`);
      assert.deepEqual(await linkedChecks(page), [], `${id} must not infer check receipts from ordinary evidenceRefs`);
    }
    assert.equal(await page.locator(`${detail} .collab-delivery-text`).textContent(), `Untrusted summary ${raw}`);
    assert.equal(await page.locator(`${detail} > pre`).first().textContent(), `Fermat route note ${raw}`);
    assert.equal(await (await openDetail(page, detail, '完整研究发现')).textContent(), `Full advisory finding ${raw}`);
    assert.deepEqual(JSON.parse((await (await openDetail(page, detail, '前提')).textContent())!), [`Untrusted premise ${raw}`]);
    assert.deepEqual(JSON.parse((await (await openDetail(page, detail, '未完成义务')).textContent())!), [`Untrusted remaining obligation ${raw}`]);
    assert.deepEqual(JSON.parse((await page.locator(`${detail} > pre`).last().textContent())!), ['check-current', `https://example.invalid/${raw}`, raw]);
    assert.equal(await page.locator(`${detail} img,${detail} script,${detail} a[href]`).count(), 0);
    assert.equal(await page.evaluate(() => '__researchXss' in globalThis), false);
  });

  await scenario('delivery filters, worker and task entry points survive polling with reading and focus intact', async h => {
    const { page } = h, run = await create(h), control = controls.get(run.id)!;
    await page.locator(producer).selectOption('researcher-1'); assert.deepEqual(await listed(page), ['raw-advisory']);
    await page.locator(query).fill('Fermat'); assert.deepEqual(await listed(page), ['raw-advisory']);
    await page.locator(taskFilter).selectOption('route_b'); assert.deepEqual(await listed(page), []);
    await clearFilters(page); await page.locator(taskFilter).selectOption('base');
    assert.equal((await listed(page)).includes('wrong-task'), false);
    await clearFilters(page); await page.locator('[data-collab-deliveries-worker="researcher-1"]').click();
    assert.equal(await page.locator(producer).inputValue(), 'researcher-1'); assert.deepEqual(await listed(page), ['raw-advisory']);
    await clearFilters(page); await page.locator('.collab-graph [data-collab-task="base"]').click();
    await page.locator('[data-collab-deliveries-task]').click(); assert.equal(await page.locator(taskFilter).inputValue(), 'base');
    await clearFilters(page); await choose(page, 'current-proof');
    await openDetail(page, detail, '完整研究发现');
    const reading = page.locator(`${detail} pre`).filter({ hasText: 'retained-note-line-80' });
    await reading.waitFor(); const scroll = await reading.evaluate(node => { node.dataset.readingProbe = 'retained-current-delivery'; node.scrollTop = 80; return node.scrollTop; });
    await page.locator(query).focus(); await page.locator(query).evaluate(node => (node as HTMLInputElement).setSelectionRange(0, 0));
    control.observation.deliveries!.push(baseDelivery('new-background-delivery', { createdAt: 99 })); control.emit(); await poll(page);
    assert.equal(await page.locator(`${list} [data-delivery-id="current-proof"]`).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator(query).evaluate(node => node === document.activeElement), true);
    assert.equal(await reading.getAttribute('data-reading-probe'), 'retained-current-delivery');
    assert.equal(await reading.evaluate(node => node.scrollTop), scroll);
    await page.locator(detail).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'deliveries-desktop.png') });
  });

  await scenario('a delivery opens its historical task contract after the task is revised', async h => {
    const { page } = h, run = await create(h), control = controls.get(run.id)!;
    await choose(page, 'historical-proof'); await page.locator(`${detail} [data-collab-task="base"][data-task-version="base-v0"]`).click();
    await page.locator('[data-task-history-notice]').waitFor();
    assert.equal(await page.locator('[data-inspected-task-version]').innerText(), 'base-v0');
    assert.ok((await page.locator(inspector).innerText()).includes('Historical contract before the premise was revised'));
    assert.ok((await page.locator(inspector).textContent())!.includes('(n : Nat) → n = n'));
    const labels = await page.locator(`${inspector} dt`).allTextContents();
    assert.equal(labels.includes('任务状态'), false, 'history projection defaults are not recorded scheduling facts');
    assert.equal(labels.includes('尝试次数'), false, 'history projection attempts=0 must not be displayed as evidence');
    assert.equal(await page.locator('[data-collab-guide-task]').isDisabled(), true);
    await page.locator('[data-task-current]').click(); assert.equal(await page.locator('[data-inspected-task-version]').innerText(), 'base-v1');
    assert.equal(await page.locator('[data-collab-guide-task]').isDisabled(), false);

    await choose(page, 'current-proof'); const old = structuredClone(control.observation.inspection.tasks.find(task => task.id === 'base')!);
    control.observation.history!.push(old);
    const currentTask = control.observation.inspection.tasks.find(task => task.id === 'base')!;
    currentTask.version = 'base-v2'; currentTask.type = 'True ∧ True'; currentTask.objective = 'Revised premise contract';
    control.observation.plan!.baseVersion = 'plan-v2'; control.emit(); await poll(page);
    await page.locator(`${detail} [data-collab-task="base"][data-task-version="base-v1"]`).click();
    await page.locator('[data-task-history-notice]').waitFor(); assert.equal(await page.locator('[data-inspected-task-version]').innerText(), 'base-v1');
    assert.ok((await page.locator(inspector).innerText()).includes('Current reusable premise contract'));
    assert.equal((await page.locator(inspector).innerText()).includes('Revised premise contract'), false);
    assert.equal(await page.locator('[data-collab-guide-task]').isDisabled(), true);
    assert.deepEqual(await linkedSources(page), [sourceKey(current)]);
    await page.locator(`${detail} [data-collab-source]`).click();
    await page.locator('[data-task-source-code]').waitFor(); assert.equal(await page.locator('[data-task-source-code]').textContent(), current.source);
    await page.locator('[data-task-current]').click(); assert.equal(await page.locator('[data-inspected-task-version]').innerText(), 'base-v2');
  });

  for (const width of [375, 320]) await scenario(`research frontier and delivery evidence fit ${width}px`, async h => {
    const { page } = h; await create(h); await choose(page, 'current-proof');
    await fit(page, [frontier, blockers, section, producer, taskFilter, query, list, detail]);
    await page.locator(frontier).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `frontier-${width}.png`) });
    await page.locator(detail).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `deliveries-${width}.png`) });
    await page.locator(`${detail} [data-collab-task="base"][data-task-version="base-v1"]`).click();
    await fit(page, ['.collab-inspector', '[data-inspected-task-version]']);
    assert.equal(await page.locator('[data-inspected-task-version]').innerText(), 'base-v1');
  }, width);

  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined, 'local-real-http-research-progress',
    { checks: suite.checks, simulatedProofReceipts: true, leanProcesses: 0, deliveryCount: deliveries.length,
      screenshots: ['frontier-desktop.png', 'deliveries-desktop.png', 'frontier-375.png', 'deliveries-375.png', 'frontier-320.png', 'deliveries-320.png'] }, { credential: input.apiKey });
  console.log('Research progress browser checks passed');
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-research-progress',
    { checks: suite.checks, simulatedProofReceipts: true, leanProcesses: 0 }, { credential: input.apiKey, failureRequests: true }); throw error;
} finally {
  for (const control of controls.values()) control.finish(); await browser.close(); await service.close();
}
