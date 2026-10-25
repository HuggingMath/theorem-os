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
import type { WebInspectedTask, WebObservation } from '../apps/web/collaboration';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { captureObligationSnapshot, diffObligationProgress, type GoalObligationFrontier,
  type ObligationProgressReceipt, type ObligationSnapshot } from '../src/solver/obligationProgress';
import { taskVersion, type TaskRecord } from '../src/solver/tasks';
import type { ProofRoute } from '../src/solver/proofRoutes';
import type { RouteBlocker } from '../src/solver/routeControl';
import { integratedProof } from '../tests/helpers/taskProof';
import { refreshHistory, selectHistoryRun } from './web-ui-controls';
import { freePort, postRun, settled, startBrowser, webScenario, writeScenarioReport,
  type ScenarioHarness, type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-mathematical-changes');
await fs.mkdir(output, { recursive: true });
const now = () => new Date().toISOString(), environmentDigest = mathDigest('local mathematical changes fixture');
const changedEnvironment = mathDigest('changed local fixture environment');
const raw = '<img src=x onerror="globalThis.__mathChangeXss=1"><script>globalThis.__mathChangeXss=2</script>';
const retainedLines = Array.from({ length: 90 }, (_, index) => `retained-blocker-line-${index}: ${raw}`).join('\n');
const startAt = 1_700_000_000_000, retainedChangeLimit = 64;
const key = (receipt: ObligationProgressReceipt) => JSON.stringify([receipt.kind, receipt.at, receipt.beforeDigest ?? null, receipt.afterDigest]);
const controls = new Map<string, { observation: WebObservation; emit(): void; append(): ObligationProgressReceipt; finish(): void }>();
type Harness = ScenarioHarness & { runIds: string[] };

function node(id: string, kind: TaskRecord['task']['kind'] = 'lemma', dependsOn: string[] = []): TaskRecord {
  return { task: { id, kind, objective: `${id} original mathematical contract`, dependsOn, revision: 0,
    ...(['lemma', 'goal'].includes(kind) ? { theoremName: id, proofPath: 'Submission.lean', type: 'True' } : {}) },
    status: 'pending', attempts: 0 };
}
function inspected(item: TaskRecord): WebInspectedTask {
  return { id: item.task.id, kind: item.task.kind, objective: item.task.objective, group: item.task.groupId ?? 'main',
    status: item.status, control: item.task.status ?? 'active', version: taskVersion(item.task), theorem: item.task.theoremName,
    type: item.task.type, premises: item.task.premises ?? [], plannedDependencies: item.task.dependsOn, attempts: item.attempts,
    proof: { status: item.integratedCheck ? 'checked' : 'none' }, parkedBy: [], parkedRoutes: {} };
}
const base = node('base'), closing = node('closing', 'lemma', ['base']), alternative = node('alternative');
const original = node('original', 'goal'), note = node('note', 'research'), obsolete = node('obsolete'), oldNote = node('old_note', 'sketch');
const nodes = [base, closing, alternative, original, note, obsolete, oldNote];
const routes: ProofRoute[] = [{ id: 'A', targetTaskId: 'original', closingTaskId: 'closing', prerequisiteTaskIds: ['base'] },
  { id: 'B', targetTaskId: 'original', closingTaskId: 'alternative', prerequisiteTaskIds: [] }];
const blockers: RouteBlocker[] = [];
const capture = (environment = changedEnvironment) => captureObligationSnapshot(nodes, { environmentDigest: environment, proofRoutes: routes, blockers });
const receipts: ObligationProgressReceipt[] = [];
function record(before: ObligationSnapshot | undefined, after: ObligationSnapshot) {
  const receipt = diffObligationProgress(before, after, startAt + receipts.length * 1000);
  assert.ok(receipt, 'the actual runtime diff must observe this fixture transition'); receipts.push(receipt); return receipt;
}

// These are simulated archived proof receipts. The real snapshot/diff code runs; no Lean process does.
integratedProof(base, { accept: false, environmentDigest, receiptId: 'simulated-baseline-proof' });
const baselineSnapshot = capture(environmentDigest), baseline = record(undefined, baselineSnapshot);
assert.equal(baselineSnapshot.obligations.some(item => item.closed), true);
assert.equal(baseline.obligations.closed.length, 0, 'pre-existing recorded checks are not new achievements');
integratedProof(closing, { uses: [base], accept: false, environmentDigest, receiptId: 'simulated-closing-proof' });
const closedSnapshot = capture(environmentDigest), closure = record(baselineSnapshot, closedSnapshot);
assert.deepEqual(closure.obligations.closed.map(change => change.after.taskId), ['closing']);
const historical = nodes.map(inspected);
base.task = { ...base.task, type: 'True ∧ True', revision: 1, objective: 'base revised mathematical contract' };
closing.task = { ...closing.task, type: 'True → True', revision: 1, objective: 'closing revised mathematical contract' };
delete base.integratedCheck; delete closing.integratedCheck; base.status = closing.status = 'pending';
nodes.splice(nodes.indexOf(obsolete), 1); nodes.splice(nodes.indexOf(oldNote), 1);
nodes.push(node('fresh'), node('proposed', 'sketch')); note.status = 'completed'; note.finding = `Advisory mathematical idea ${raw}`;
blockers.push({ id: 'local_obstruction', taskId: alternative.task.id, taskDigest: taskVersion(alternative.task), groupId: 'main', routeId: 'B',
  mechanism: `Inspect the local inference ${raw}`, scope: `Local route B inference ${raw}`, evidenceStatus: 'advisory', evidenceRefs: [raw, retainedLines, 'not-a-check-receipt'],
  reopenOn: [{ kind: 'contract-changed' }, { kind: 'dependency-checked', taskId: 'base' }],
  basis: { contractDigest: mathDigest('blocker-contract'), environmentDigest, dependencies: {} },
  fingerprint: mathDigest('blocker-fingerprint'), count: 1, status: 'open', createdAt: startAt, updatedAt: startAt });
routes.pop();
let currentSnapshot = capture();
const mixed = record(closedSnapshot, currentSnapshot);
assert.equal(mixed.environmentChanged, true); assert.ok(mixed.obligations.reopened.length && mixed.obligations.new.length && mixed.obligations.removed.length);
assert.ok(mixed.goalFrontiers.length && mixed.blockers.new.length && mixed.routes.length && mixed.advisory.completed.length);
blockers[0]!.status = 'parked';
let nextSnapshot = capture(); const parked = record(currentSnapshot, nextSnapshot); currentSnapshot = nextSnapshot;
blockers[0]!.status = 'reopened'; blockers[0]!.reopenedReason = `Review new dependency evidence ${raw}`;
nextSnapshot = capture(); const reopened = record(currentSnapshot, nextSnapshot); currentSnapshot = nextSnapshot;
blockers[0]!.status = 'superseded';
nextSnapshot = capture(); record(currentSnapshot, nextSnapshot); currentSnapshot = nextSnapshot;
blockers.pop();
nextSnapshot = capture(); record(currentSnapshot, nextSnapshot); currentSnapshot = nextSnapshot;

// Explicitly deficient historical identities must remain deficient in the browser.
function rehash(snapshot: ObligationSnapshot) {
  const { digest: _digest, ...body } = snapshot; snapshot.digest = mathDigest(canonicalMathJson(body)); return snapshot;
}
const deficientBefore = structuredClone(currentSnapshot), deficientAfter = structuredClone(currentSnapshot);
deficientBefore.goals[0]!.frontier = [{ taskId: 'base', taskDigest: null }]; delete deficientBefore.goals[0]!.alternatives;
deficientAfter.goals[0]!.frontier = [{ taskId: 'base', taskDigest: null }, { taskId: 'fresh', taskDigest: null },
  { taskId: 'closing', taskDigest: mathDigest('unretained-closing-contract') }];
delete (deficientAfter.goals[0] as Partial<GoalObligationFrontier>).taskDigest; delete deficientAfter.goals[0]!.alternatives;
const deficient = record(rehash(deficientBefore), rehash(deficientAfter));

let noteCounter = 0;
function nextAdvisory(before = currentSnapshot) {
  note.finding = `retained mathematical note ${++noteCounter}`;
  const after = capture(), receipt = diffObligationProgress(before, after, startAt + (receipts.length + noteCounter) * 1000);
  assert.ok(receipt); currentSnapshot = after; return receipt;
}
while (receipts.length < retainedChangeLimit) receipts.push(nextAdvisory());
const initialReceipts = structuredClone(receipts);
const initialSnapshot = structuredClone(currentSnapshot);
const currentTasks = nodes.map(inspected);

function observation(id: string): WebObservation {
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `solver-${id}`, stateDigest: mathDigest(id), resultDigest: null };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: nodes.map(item => structuredClone(item.task)), proofRoutes: structuredClone(routes) },
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
      problem: { id: 'mathematical-changes-fixture', statement: 'Prove the frozen original theorem', formalStatement: 'True', assumptions: [],
        targets: [{ proofPath: 'Submission.lean', theoremName: 'original' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 3, coordination: 'cooperative', buildDigest: mathDigest('mathematical-changes-build'), environmentDigest: changedEnvironment },
      turns: 3, planVersion: 'plan-v1', scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 3, working: 0,
        proofAssignments: 0, preparing: 0, stopping: 0, idle: 3, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded',
        droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: structuredClone(initialSnapshot), recentChanges: structuredClone(initialReceipts), retainedChangeLimit },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 1, openProofTasks: ['base', 'closing', 'alternative', 'original', 'fresh'] },
      groups: [], tasks: structuredClone(currentTasks), workers: [
        { id: 'engineer', role: 'engineer', phase: 'waiting', turns: 1, dispatchWait: { status: 'unknown' } },
        { id: 'researcher', role: 'researcher', phase: 'waiting', turns: 1, dispatchWait: { status: 'unknown' } },
        { id: 'prover', role: 'prover', phase: 'waiting', turns: 1, dispatchWait: { status: 'unknown' } }], statementReviews: [], edits: [] },
    history: structuredClone(historical), sources: [], checks: [], guidance: [], deliveries: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local mathematical change fixture; actual snapshot/diff, no model or Lean' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control = { observation: observation(input.id), finish: resolve, emit() {
        this.observation = { ...this.observation, sequence: this.observation.sequence + 1, observedAt: now() };
        send({ type: 'observation', observation: structuredClone(this.observation) });
      }, append() {
        const mathematics = this.observation.inspection.mathematics, receipt = nextAdvisory(mathematics.snapshot);
        mathematics.snapshot = structuredClone(currentSnapshot); mathematics.recentChanges = [...mathematics.recentChanges, receipt].slice(-retainedChangeLimit);
        this.emit(); return receipt;
      } };
      controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true }); control.emit();
    });
  },
  async command() { throw new Error('Mathematical change inspection must not submit runtime commands'); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-local-mathematical-changes-fixture', model: 'fixture', effort: 'low',
  environment: 'standard', source: 'theorem original : True := by sorry\n', task: 'Inspect mathematical changes and precise historical contracts',
  maxTurns: 2, maxRunSeconds: 60, workers: 3, coordination: 'cooperative' };
const section = '.collab-math-changes', select = '[data-math-category]', taskFilter = '[data-math-task]', query = '[data-math-query]';
const list = '[data-math-list]', detail = '[data-math-detail]', inspector = '[data-collab-inspector]';
const choice = (page: Page, receipt: ObligationProgressReceipt) => page.locator(`${list} [data-math-key=${JSON.stringify(key(receipt))}]`);
async function create(h: Harness) {
  const run = await postRun(h, input); h.runIds.push(run.id); await refreshHistory(h.page); await selectHistoryRun(h.page, run.id);
  await h.page.locator(section).waitFor(); await choice(h.page, mixed).waitFor(); return run;
}
async function choose(page: Page, receipt: ObligationProgressReceipt) {
  await choice(page, receipt).click(); assert.equal(await choice(page, receipt).getAttribute('aria-pressed'), 'true');
}
async function rawReceipt(page: Page) {
  const details = page.locator(`${detail} details`).filter({ has: page.locator('summary').getByText('原始变化记录', { exact: true }) });
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  return details.locator('pre');
}
async function poll(page: Page) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'GET');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await response; await settled(page);
}
async function frame(page: Page, selector: string) {
  await page.locator(selector).evaluate(node => { node.scrollIntoView({ block: 'start' }); window.scrollTo(0, 0); });
  await settled(page);
}
async function fit(page: Page, selectors: string[]) {
  const width = page.viewportSize()!.width;
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'mathematical changes must not widen the document');
  for (const selector of selectors) {
    const box = await page.locator(selector).boundingBox(); assert.ok(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1,
      `${selector} must fit ${width}px: ${JSON.stringify(box)}`);
  }
}
function scenario(name: string, run: (h: Harness) => Promise<void>, width = 1440) {
  return webScenario(browser, suite, name, run, {
    context: { viewport: { width, height: width > 850 ? 1000 : 812 }, reducedMotion: 'reduce', acceptDownloads: true },
    harness: (page, context) => ({ page, context, requests: [], runIds: [] }),
    routes: { local: 'Mathematical changes must remain local' }, open: true, timeout: { label: 'Mathematical changes', seconds: 60 },
    verify: (h, elapsedMs) => {
      assert.equal(h.requests.some(item => item.method !== 'GET' && item.pathname !== '/api/runs'), false, 'inspection must not send runtime commands');
      return { name, elapsedMs: elapsedMs(), requests: h.requests };
    }, cleanup: h => { for (const id of h.runIds) controls.get(id)?.finish(); },
  });
}

try {
  await scenario('actual baselines and transitions retain raw mathematical evidence without implying acceptance', async h => {
    const { page } = h; await create(h);
    assert.equal(await page.locator(`${list} [data-math-key]`).count(), retainedChangeLimit);
    assert.match(await page.locator('[data-math-count]').innerText(), /64/);
    assert.match(await page.locator('[data-math-coverage]').innerText(), /64/);
    await choose(page, baseline); assert.deepEqual(JSON.parse((await (await rawReceipt(page)).textContent())!), baseline);
    assert.match(await page.locator(detail).innerText(), /基线/);
    assert.equal(baseline.obligations.closed.length, 0); assert.equal(baseline.obligations.new.length, 0);
    await choose(page, closure); assert.deepEqual(JSON.parse((await (await rawReceipt(page)).textContent())!), closure);
    await choose(page, mixed); assert.deepEqual(JSON.parse((await (await rawReceipt(page)).textContent())!), mixed);
    for (const heading of ['证明义务', '原始目标前沿', '数学阻塞', 'OR 路线', '提示性研究'])
      assert.ok((await page.locator(`${detail} h5,${detail} summary`).allTextContents()).includes(heading), `transition exposes ${heading}`);
    assert.ok((await page.locator('.collab-metrics').innerText()).includes('尚未验收通过'));
    await choose(page, closure); await page.locator(detail).evaluate(node => { node.scrollTop = 0; }); await frame(page, '[data-math-heading]');
    await page.screenshot({ path: path.join(output, 'changes-desktop.png') });
  });

  await scenario('before and after links use exact historical contracts and never fill missing versions', async h => {
    const { page } = h; await create(h); await choose(page, mixed);
    for (const id of ['base', 'closing']) {
      const before = historical.find(task => task.id === id)!, after = currentTasks.find(task => task.id === id)!;
      for (const version of [before.version, after.version]) {
        const link = page.locator(`${detail} [data-collab-task="${id}"][data-task-version="${version}"]`).first();
        assert.ok(await link.count(), `${id} keeps exact ${version}`); await link.click();
        assert.equal(await page.locator('[data-inspected-task-version]').innerText(), version);
        assert.ok((await page.locator(inspector).innerText()).includes(version === before.version ? before.objective : after.objective));
      }
    }
    const removed = historical.find(task => task.id === 'obsolete')!;
    await page.locator(`${detail} [data-collab-task="obsolete"][data-task-version="${removed.version}"]`).first().click();
    assert.equal(await page.locator('[data-inspected-task-version]').innerText(), removed.version);
    assert.ok((await page.locator(inspector).innerText()).includes(removed.objective));
    await page.locator('[data-collab-changes-task]').click(); assert.equal(await page.locator(taskFilter).inputValue(), 'obsolete');
    assert.equal(await page.locator(`${list} [data-math-key]`).count(), 1);
    assert.equal(await page.locator('[data-math-heading]').evaluate(node => node === document.activeElement), true);
    await page.locator('[data-math-clear]').click();
    await choose(page, deficient);
    for (const id of ['base', 'fresh', 'closing']) assert.equal(await page.locator(`${detail} [data-collab-task="${id}"]`).count(), 0,
      `${id} cannot borrow a current contract for missing or unretained history`);
    assert.match(await page.locator(detail).innerText(), /版本未记录/); assert.match(await page.locator(detail).innerText(), /合同未保留/);
    await choose(page, mixed);
    const routeHeading = page.locator(`${detail} h5`).filter({ hasText: /^OR 路线$/ });
    assert.equal(await routeHeading.evaluate(heading => {
      let links = 0;
      for (let sibling = heading.nextElementSibling; sibling && sibling.tagName !== 'H5' && sibling.tagName !== 'DETAILS'; sibling = sibling.nextElementSibling)
        links += sibling.querySelectorAll('[data-collab-task]').length;
      return links;
    }), 0, 'route IDs have no versions and cannot imply exact task links');
  });

  await scenario('filters and polling preserve selected evidence, focus and scroll through a 64-record retention window', async h => {
    const { page } = h, run = await create(h), control = controls.get(run.id)!;
    await page.locator(select).selectOption('baseline'); assert.equal(await page.locator(`${list} [data-math-key]`).count(), 1);
    await page.locator(select).selectOption('environment'); assert.equal(await page.locator(`${list} [data-math-key]`).count(), 1);
    assert.equal(await choice(page, mixed).count(), 1);
    for (const category of ['obligations', 'frontiers', 'routes']) {
      await page.locator(select).selectOption(category); assert.equal(await choice(page, closure).count(), 1);
      assert.equal(await choice(page, initialReceipts.at(-1)!).count(), 0);
    }
    await page.locator(select).selectOption('advisory'); assert.equal(await choice(page, initialReceipts.at(-1)!).count(), 1);
    assert.equal(await choice(page, closure).count(), 0);
    await page.locator(select).selectOption('blockers'); await page.locator(taskFilter).selectOption('alternative');
    await page.locator(query).fill('onerror'); assert.ok(await choice(page, mixed).count()); assert.ok(await choice(page, parked).count());
    assert.ok(await choice(page, reopened).count()); assert.equal(await choice(page, closure).count(), 0);
    await page.locator(query).fill('no-such-mathematical-change'); assert.equal(await page.locator(`${list} [data-math-key]`).count(), 0);
    await page.locator('[data-math-clear]').click();
    for (const selector of [select, taskFilter, query]) assert.equal(await page.locator(selector).inputValue(), '');
    await choose(page, mixed); const reading = await rawReceipt(page);
    const scroll = await reading.evaluate(node => { node.dataset.readingProbe = 'same-math-change'; node.scrollTop = 90; return node.scrollTop; });
    const anchor = await page.locator(list).evaluate(node => {
      node.scrollTop = 450;
      const row = [...node.querySelectorAll<HTMLElement>('[data-math-row]')].find(row => row.getBoundingClientRect().bottom > node.getBoundingClientRect().top);
      if (!row) throw new Error('Expected a visible retained mathematical change');
      row.dataset.readingAnchor = 'stable-math-row'; return row.getBoundingClientRect().top - node.getBoundingClientRect().top;
    });
    await page.locator(query).focus();
    control.append(); await poll(page);
    assert.equal(await choice(page, mixed).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator(query).evaluate(node => node === document.activeElement), true);
    assert.equal(await reading.getAttribute('data-reading-probe'), 'same-math-change'); assert.equal(await reading.evaluate(node => node.scrollTop), scroll);
    const retainedAnchor = await page.locator(list).evaluate(node => node.querySelector('[data-reading-anchor="stable-math-row"]')!.getBoundingClientRect().top - node.getBoundingClientRect().top);
    assert.ok(Math.abs(retainedAnchor - anchor) < 3, `retention keeps the visible row anchored: ${anchor} → ${retainedAnchor}`);
    await choose(page, closure); // The baseline has already left the 64-record window.
    control.append(); await poll(page);
    assert.equal(await choice(page, closure).count(), 0);
    assert.equal(await page.locator(`${list} [data-math-key][aria-pressed="true"]`).count(), 0, 'a removed selection cannot silently become another record');
    assert.equal(await page.locator('[data-math-reference]').isDisabled(), true); assert.equal(await page.locator('[data-math-download]').isDisabled(), true);
    assert.match((await page.locator(`${detail},[data-math-status]`).allTextContents()).join('\n'), /保留|移出|不在|未记录/);
  });

  await scenario('references and downloads preserve recipient, observation and full raw evidence without writes or HTML execution', async h => {
    const { page } = h, run = await create(h), control = controls.get(run.id)!; await choose(page, mixed);
    const originalVersions = control.observation.inspection.tasks.map(task => [task.id, task.version]);
    await page.locator('[data-guidance-kind]').selectOption('worker'); await page.locator('[data-guidance-target]').selectOption('researcher');
    await page.locator('[data-guidance-text]').fill('Keep the existing mathematical instruction.');
    const observationRef = { sequence: control.observation.sequence, stateDigest: control.observation.snapshot.stateDigest, observedAt: control.observation.observedAt };
    await page.locator('[data-math-reference]').click();
    assert.equal(await page.locator('[data-guidance-kind]').inputValue(), 'worker'); assert.equal(await page.locator('[data-guidance-target]').inputValue(), 'researcher');
    const draft = await page.locator('[data-guidance-text]').inputValue(); assert.ok(draft.startsWith('Keep the existing mathematical instruction.'));
    for (const value of [mixed.beforeDigest!, mixed.afterDigest, new Date(mixed.at).toISOString(), String(observationRef.sequence), observationRef.stateDigest])
      assert.ok(draft.includes(value), `guidance reference keeps ${value}`);
    assert.deepEqual(control.observation.inspection.tasks.map(task => [task.id, task.version]), originalVersions);
    const downloadPromise = page.waitForEvent('download'); await page.locator('[data-math-download]').click(); const download = await downloadPromise;
    const file = await download.path(); assert.ok(file); const exported = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(exported.schema, 'theoremos.web-mathematical-change-export.v1'); assert.equal(exported.webRunId, run.id);
    assert.equal(exported.solverRunId, control.observation.solverRunId); assert.deepEqual(exported.observation, observationRef);
    assert.deepEqual(exported.receipt, mixed);
    assert.deepEqual(exported.coverage, { scope: 'current-observation', retainedChangeLimit, retainedRecords: retainedChangeLimit,
      oldestAt: Math.min(...initialReceipts.map(receipt => receipt.at)), newestAt: Math.max(...initialReceipts.map(receipt => receipt.at)) });
    assert.deepEqual(JSON.parse((await (await rawReceipt(page)).textContent())!), mixed);
    assert.equal(await page.locator(`${section} img,${section} script,${section} a[href]`).count(), 0);
    assert.equal(await page.evaluate(() => '__mathChangeXss' in globalThis), false);
    assert.equal(h.requests.some(request => request.method === 'POST' && request.pathname !== '/api/runs'), false);
  });

  for (const width of [375, 320]) await scenario(`mathematical change filters, history and raw evidence fit ${width}px`, async h => {
    const { page } = h; await create(h); await choose(page, mixed);
    await fit(page, [section, select, taskFilter, query, '[data-math-clear]', list, detail, '[data-math-reference]', '[data-math-download]']);
    await page.locator(detail).evaluate(node => { node.scrollTop = 0; }); await frame(page, '[data-math-heading]');
    await page.screenshot({ path: path.join(output, `changes-${width}.png`) });
    const rawRecord = await rawReceipt(page); assert.deepEqual(JSON.parse((await rawRecord.textContent())!), mixed);
    await fit(page, [detail, `${detail} [data-detail-key^="math-raw-"] pre`]);
    await rawRecord.scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, `change-detail-${width}.png`) });
    const historicalVersion = historical.find(task => task.id === 'base')!.version;
    await page.locator(`${detail} [data-collab-task="base"][data-task-version="${historicalVersion}"]`).first().click();
    assert.equal(await page.locator('[data-inspected-task-version]').innerText(), historicalVersion);
    await fit(page, ['.collab-inspector', '[data-inspected-task-version]']);
  }, width);

  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined, 'local-real-http-obligation-progress',
    { checks: suite.checks, snapshot: 'captureObligationSnapshot', diff: 'diffObligationProgress', simulatedProofReceipts: true,
      deficientHistoricalIdentityFixture: true, leanProcesses: 0, retainedRecords: retainedChangeLimit,
      screenshots: ['changes-desktop.png', 'changes-375.png', 'change-detail-375.png', 'changes-320.png', 'change-detail-320.png'] }, { credential: input.apiKey });
  console.log('Mathematical changes browser checks passed');
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-obligation-progress',
    { checks: suite.checks, snapshot: 'captureObligationSnapshot', diff: 'diffObligationProgress', simulatedProofReceipts: true,
      deficientHistoricalIdentityFixture: true, leanProcesses: 0 }, { credential: input.apiKey, failureRequests: true }); throw error;
} finally {
  for (const control of controls.values()) control.finish(); await browser.close(); await service.close();
}
