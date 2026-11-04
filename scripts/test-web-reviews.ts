#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { webGuidanceSchema } from '../apps/web/collaborationValidation';
import type { WebRunner } from '../apps/web/runner';
import type { WebResult, WebRunInput } from '../apps/web/shared';
import type { WebInspectedTask, WebObservation, WebPlanTask, WebTaskSource } from '../apps/web/collaboration';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { taskVersion } from '../src/solver/tasks';
import { readBacktranslation } from '../src/solver/statementReview';
import { refreshHistory, selectHistoryRun } from './web-ui-controls';
import { freePort, postRun, readRun, settled, startBrowser, webScenario, writeScenarioReport,
  type ScenarioHarness, type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-reviews');
await fs.mkdir(output, { recursive: true });
const now = () => new Date().toISOString(), environmentDigest = mathDigest('local review browser fixture');
const raw = '<img src=x onerror="globalThis.__reviewXss=1"><script>globalThis.__reviewXss=2</script>';
const longMathematics = ['For every natural number n, n equals itself.',
  ...Array.from({ length: 90 }, (_, index) => `review-reading-line-${index}: inspect the same saved translation`)].join('\n');
type Review = WebObservation['inspection']['statementReviews'][number] & {
  id?: string; snapshotDigest?: string; environmentDigest?: string; commit?: string; premises?: readonly string[];
  dependencies?: { taskId: string; taskDigest: string }[]; workerId?: string; assignmentId?: string;
};
type Control = { observation: WebObservation; emit(): void; result(status: string, complete?: boolean): void; finish(): void };
type Harness = ScenarioHarness & { runIds: string[] };
const controls = new Map<string, Control>();
const key = (record: Review) => JSON.stringify([record.id ?? null, record.taskId, record.version,
  record.snapshotDigest ?? null, record.environmentDigest ?? null, record.commit ?? null]);
const baseTask: WebPlanTask = { id: 'base', kind: 'lemma', objective: 'Current reflexivity contract', dependsOn: ['premise'], revision: 1,
  theoremName: 'base', proofPath: 'Submission.lean', type: '∀ (n : Nat), n = n' };
const oldTask: WebPlanTask = { ...baseTask, objective: 'Historical addition identity contract', revision: 0, type: '∀ (n : Nat), n + 0 = n' };
const premiseTask: WebPlanTask = { id: 'premise', kind: 'lemma', objective: 'Reusable premise', dependsOn: [], revision: 0,
  theoremName: 'premise', proofPath: 'Submission.lean', type: 'True' };
const originalTask: WebPlanTask = { id: 'original', kind: 'goal', objective: 'Prove the frozen original theorem', dependsOn: ['base'], revision: 0,
  theoremName: 'original', proofPath: 'Submission.lean', type: 'True' };
const baseVersion = taskVersion(baseTask), oldVersion = taskVersion(oldTask), premiseVersion = taskVersion(premiseTask);
const statuses = ['pending', 'translating', 'translated', 'reviewing', 'accepted', 'changes_requested', 'superseded'] as const;
const statusLabels = { pending: '等待回译', translating: '独立回译中', translated: '回译完成，等待比较', reviewing: '声明比较中',
  accepted: '审阅接受', changes_requested: '请求修改', superseded: '已被替代' };
const translation = readBacktranslation({ mathematics: `${longMathematics}\n${raw}`, assumptions: [`A natural number n is given ${raw}`],
  definitions: [`Equality is the existing Lean equality ${raw}`], evidenceRefs: ['not-a-proof-receipt', raw, `https://example.invalid/${raw}`] });
const review = (status: string, extra: Partial<Review> = {}): Review => ({ id: `review_${status}`, taskId: 'base', version: baseVersion,
  status, snapshotDigest: mathDigest(`blind-statement-${status}`), environmentDigest,
  commit: mathDigest(`blind-commit-${status}`).slice(0, 40), intendedStatement: `For every natural number n, n equals itself. ${raw}`,
  leanStatement: `theorem base : ∀ (n : Nat), n = n -- ${raw}`, premises: [`Retain all original assumptions ${raw}`],
  dependencies: [{ taskId: 'premise', taskDigest: premiseVersion }], workerId: 'reviewer', assignmentId: `assignment_${status}`,
  translation: structuredClone(translation), summary: `Saved ${status} statement review summary ${raw}`, ...extra });
const main = review('accepted');
const historical = review('superseded', { id: 'review_historical', version: oldVersion, snapshotDigest: mathDigest('historical-blind-statement'),
  intendedStatement: 'For every natural n, adding zero leaves n unchanged.', leanStatement: 'theorem base : ∀ (n : Nat), n + 0 = n',
  summary: 'The old addition identity statement was replaced.' });
const reusable = review('accepted', { id: 'review_original_reuse', taskId: 'original', version: taskVersion(originalTask),
  snapshotDigest: mathDigest('unchanged-frozen-original-statement'), intendedStatement: 'Prove the frozen original theorem', leanStatement: 'theorem original : True',
  summary: 'Accepted the fixed original declaration; later planning revisions may reuse this snapshot.', dependencies: [] });
const legacy: Review = { taskId: 'base', version: baseVersion, status: 'translated', intendedStatement: 'Legacy statement intention',
  leanStatement: 'theorem base : ∀ (n : Nat), n = n', translation: `Legacy loose backtranslation ${raw}`, summary: 'Legacy inspection omitted statement snapshot metadata' };
const unknown = review('changes_requested', { id: 'review_unretained_contract', version: mathDigest('unretained-task-version'),
  dependencies: [{ taskId: 'premise', taskDigest: mathDigest('unretained-premise-version') }] });
const missing = review('pending', { id: 'review_missing_version', version: '' });
const reviews: Review[] = [...statuses.map(status => status === 'accepted' ? main : review(status)), historical, reusable, legacy, unknown, missing];
const candidate: NonNullable<WebObservation['inspection']['review']> = { commit: mathDigest('fixed-candidate-commit').slice(0, 40),
  sourceDigest: mathDigest('fixed-candidate-source'), status: 'accepted', workerId: 'reviewer', assignmentId: 'fixed_candidate_assignment',
  summary: `The saved fixed candidate was reviewed; this is not an S3 result. ${raw}` };

function inspected(task: WebPlanTask): WebInspectedTask {
  return { id: task.id, kind: task.kind, objective: task.objective, group: 'main', status: 'pending', control: 'active', version: taskVersion(task),
    theorem: task.theoremName, type: task.type, premises: task.premises ?? [], plannedDependencies: task.dependsOn,
    attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} };
}
// A full proof source deliberately collides with the blind-statement digest. That does not make it the reviewed statement projection.
const collidingSource: WebTaskSource = { taskId: 'base', taskVersion: baseVersion, commit: main.commit!, sourceDigest: main.snapshotDigest!,
  environmentDigest, file: 'Submission.lean', scope: 'owned-file', source: 'theorem base (n : Nat) : n = n := by rfl\n-- proof source, not the blind statement snapshot\n' };
function observation(id: string): WebObservation {
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `solver-${id}`, stateDigest: mathDigest(id), resultDigest: null };
  const tasks = [premiseTask, baseTask, originalTask].map(task => structuredClone(task));
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks },
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
      problem: { id: 'review-browser-fixture', statement: 'Prove the frozen original theorem', formalStatement: 'True', assumptions: [],
        targets: [{ proofPath: 'Submission.lean', theoremName: 'original' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 3, coordination: 'cooperative', buildDigest: mathDigest('review-build'), environmentDigest },
      turns: 3, planVersion: 'plan-v1', scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 3, working: 0,
        proofAssignments: 0, preparing: 0, stopping: 0, idle: 3, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded',
        droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'theoremos.obligation-snapshot.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
        digest: mathDigest('review-obligations'), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: tasks.map(task => task.id) },
      groups: [], tasks: tasks.map(inspected), workers: [
        { id: 'engineer', role: 'engineer', phase: 'waiting', turns: 1, dispatchWait: { status: 'unknown' } },
        { id: 'researcher', role: 'researcher', phase: 'waiting', turns: 1, dispatchWait: { status: 'unknown' } },
        { id: 'reviewer', role: 'reviewer', phase: 'waiting', turns: 1, dispatchWait: { status: 'unknown' } }],
      statementReviews: structuredClone(reviews), review: structuredClone(candidate), edits: [] },
    history: [inspected(oldTask)], sources: [structuredClone(collidingSource)], checks: [], guidance: [], deliveries: [],
    coverage: { sources: 'recorded', checks: 'recorded' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local saved statement/candidate review fixture; no model or Lean' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), finish: resolve, emit() {
        this.observation = { ...this.observation, sequence: this.observation.sequence + 1, observedAt: now() };
        send({ type: 'observation', observation: structuredClone(this.observation) });
      }, result(status, complete = false) {
        const result: WebResult = { status, proof: input.input.source, report: { fixture: true, simulatedS3Status: true } };
        send({ type: 'result', result }); if (complete) resolve();
      } };
      controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true }); control.emit();
    });
  },
  async command() { throw new Error('Saved review inspection must not submit runtime commands'); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-local-reviews-fixture', model: 'fixture', effort: 'low', environment: 'standard',
  source: 'theorem original : True := by sorry\n', task: 'Inspect blind statement reviews and fixed candidate review',
  maxTurns: 2, maxRunSeconds: 60, workers: 3, coordination: 'cooperative' };
const section = '.collab-reviews', taskFilter = '[data-review-task]', statusFilter = '[data-review-status]', query = '[data-review-query]';
const list = '[data-review-list]', detail = '[data-review-detail]', candidateView = '[data-review-candidate]', acceptance = '[data-review-acceptance]';
const choice = (page: Page, record: Review) => page.locator(`${list} [data-review-key=${JSON.stringify(key(record))}]`);
async function create(h: Harness) {
  const run = await postRun(h, input); h.runIds.push(run.id); await refreshHistory(h.page); await selectHistoryRun(h.page, run.id, 'collaboration');
  await h.page.locator(section).waitFor(); await choice(h.page, main).waitFor(); return run;
}
async function choose(page: Page, record: Review) { await choice(page, record).click(); assert.equal(await choice(page, record).getAttribute('aria-pressed'), 'true'); }
async function expand(page: Page, title: string | RegExp, container = detail) {
  const details = page.locator(`${container} details`).filter({ has: page.locator('summary').getByText(title, { exact: typeof title === 'string' }) });
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  return details.locator('pre');
}
async function validateGuidanceDraft(page: Page, control: Control) {
  const kind = await page.locator('[data-guidance-kind]').inputValue(), id = await page.locator('[data-guidance-target]').inputValue();
  const text = await page.locator('[data-guidance-text]').inputValue();
  assert.ok(text.length <= 4000, `reference draft is within the actual guidance limit: ${text.length}`);
  const task = kind === 'task' && control.observation.inspection.tasks.find(task => task.id === id);
  webGuidanceSchema.parse({ id: 'review_guidance_fixture', recipient: { kind, ...(kind === 'lead' ? {} : { id }) },
    ...(task ? { taskRef: { id: task.id, version: task.version } } : {}), text,
    observationRef: { sequence: control.observation.sequence, stateDigest: control.observation.snapshot.stateDigest } });
}
async function poll(page: Page) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'GET');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await response; await settled(page);
}
async function fit(page: Page, selectors: string[]) {
  const width = page.viewportSize()!.width;
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'reviews must not widen the document');
  for (const selector of selectors) {
    const box = await page.locator(selector).boundingBox(); assert.ok(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1,
      `${selector} must fit ${width}px: ${JSON.stringify(box)}`);
  }
}
async function frame(page: Page, selector: string) {
  await page.locator(selector).evaluate(node => { node.scrollIntoView({ block: 'start' }); window.scrollTo(0, 0); }); await settled(page);
}
function scenario(name: string, run: (h: Harness) => Promise<void>, width = 1440) {
  return webScenario(browser, suite, name, run, {
    context: { viewport: { width, height: width > 850 ? 1000 : 812 }, reducedMotion: 'reduce' },
    harness: (page, context) => ({ page, context, requests: [], runIds: [] }),
    routes: { local: 'Saved review browser checks must stay local' }, open: true, timeout: { label: 'Review inspection', seconds: 60 },
    verify: (h, elapsedMs) => {
      assert.equal(h.requests.some(item => item.method !== 'GET' && item.pathname !== '/api/runs'), false, 'review browsing/references must stay read-only');
      return { name, elapsedMs: elapsedMs(), requests: h.requests };
    }, cleanup: h => { for (const id of h.runIds) controls.get(id)?.finish(); },
  });
}

try {
  await scenario('intent comparison stays discoverable in simple mode and an unreviewed task never shows another task review', async h => {
    const { page } = h; await create(h);
    await page.locator('.collab-detail-toggle [data-collab-detail="simple"]').click();
    assert.equal(await page.locator(section).isVisible(), false);
    await page.locator('[data-collab-jump="reviews"]').click();
    await page.locator(section).waitFor();
    assert.equal(await page.locator('[data-review-heading]').innerText(), '原意与 Lean');
    await page.locator('.collab-graph [data-collab-task="premise"]').click();
    await page.locator('[data-collab-reviews-task]').click();
    assert.equal(await page.locator(taskFilter).inputValue(), 'premise');
    assert.equal(await page.locator(`${list} [data-review-key]`).count(), 0);
    assert.match(await page.locator(list).innerText(), /任务 premise 尚无已保存的声明审阅/);
    assert.equal(await page.locator(`${detail} .collab-review-comparison`).count(), 0);
    await page.locator('[data-review-clear]').click();
    assert.ok(await page.locator(`${list} [data-review-key]`).count() > 0);
  });

  await scenario('all statement review states retain intent, Lean statement, structured/legacy translations and escaped raw materials', async h => {
    const { page } = h; await create(h);
    assert.equal(await page.locator(`${list} [data-review-key]`).count(), reviews.length);
    const values = await page.locator(`${statusFilter} option`).evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
    for (const state of statuses) {
      assert.ok(values.includes(state)); await page.locator(statusFilter).selectOption(state);
      assert.equal(await page.locator(`${list} [data-review-key]`).count(), reviews.filter(record => record.status === state).length);
      await choose(page, reviews.find(record => record.id === `review_${state}`)!);
      assert.ok((await page.locator(detail).textContent())!.includes(`Saved ${state} statement review summary`));
      assert.ok((await page.locator('[data-review-selected-status]').textContent())!.includes(statusLabels[state]));
      if (['pending', 'translating', 'translated', 'reviewing'].includes(state))
        assert.match(await page.locator('[data-review-selected-status]').innerText(), /尚未接受审阅/);
    }
    await page.locator('[data-review-clear]').click(); await choose(page, main);
    const rawPres = await page.locator(`${detail} pre`).allTextContents();
    assert.ok(rawPres.includes(main.intendedStatement)); assert.ok(rawPres.includes(main.leanStatement)); assert.ok(rawPres.includes(translation.mathematics));
    for (const [title, expected] of [['审阅前提', main.premises], ['回译中的假设', translation.assumptions], ['回译中的定义', translation.definitions], ['回译原始引用', translation.evidenceRefs]] as const)
      assert.deepEqual(JSON.parse((await (await expand(page, title)).textContent())!), expected);
    await choose(page, legacy); assert.ok((await page.locator(`${detail} pre`).allTextContents()).includes(legacy.translation as string));
    await expand(page, '审阅身份');
    assert.match(await page.locator(detail).innerText(), /未记录/);
    assert.equal(await page.locator(`${section} img,${section} script,${section} a[href]`).count(), 0);
    assert.equal(await page.evaluate(() => '__reviewXss' in globalThis), false);
    await choose(page, main); await page.locator(detail).evaluate(node => { node.scrollTop = 0; }); await frame(page, '[data-review-heading]');
    await page.screenshot({ path: path.join(output, 'reviews-desktop.png') });
  });

  await scenario('review task links require exact current/history identities and statement snapshots cannot masquerade as proof sources', async h => {
    const { page } = h; await create(h); await choose(page, historical);
    await page.locator(`${detail} [data-collab-task="base"][data-task-version="${oldVersion}"]`).click();
    assert.equal(await page.locator('[data-inspected-task-version]').innerText(), oldVersion);
    assert.ok((await page.locator('[data-collab-inspector]').innerText()).includes(oldTask.objective));
    await page.locator('[data-collab-reviews-task]').click(); assert.equal(await page.locator(taskFilter).inputValue(), 'base');
    assert.equal(await page.locator('[data-review-heading]').evaluate(node => node === document.activeElement), true);
    await page.locator('[data-review-clear]').click(); await choose(page, main);
    await page.locator(`${detail} [data-collab-task="base"][data-task-version="${baseVersion}"]`).click();
    assert.equal(await page.locator('[data-inspected-task-version]').innerText(), baseVersion);
    await expand(page, '审阅身份');
    assert.equal(await page.locator(`${detail} [data-collab-task="premise"][data-task-version="${premiseVersion}"]`).count(), 1);
    assert.equal(await page.locator(`${detail} [data-collab-source],${detail} [data-collab-check]`).count(), 0,
      'a blind snapshot digest is not a full source identity even if the bytes claimed by another record collide');
    for (const record of [unknown, missing]) {
      await choose(page, record); assert.equal(await page.locator(`${detail} [data-collab-task="base"]`).count(), 0);
      assert.match(await page.locator(detail).innerText(), /未保留|未记录/);
      if (record === unknown) assert.equal(await page.locator(`${detail} [data-collab-task="premise"]`).count(), 0);
    }
    await choose(page, legacy);
    await expand(page, '审阅身份');
    for (const value of [collidingSource.commit, collidingSource.sourceDigest, environmentDigest])
      assert.equal((await page.locator(detail).innerText()).includes(value), false, 'legacy metadata must not be filled from proof sources');
  });

  await scenario('accepted snapshot reuse, filters and polling preserve honest selection and reading without inventing another review', async h => {
    const { page } = h, run = await create(h), control = controls.get(run.id)!;
    await page.locator(taskFilter).selectOption('base'); await page.locator(statusFilter).selectOption('accepted');
    await page.locator(query).fill(main.snapshotDigest!); assert.equal(await page.locator(`${list} [data-review-key]`).count(), 1);
    await page.locator(query).fill('no-such-review-record'); assert.equal(await page.locator(`${list} [data-review-key]`).count(), 0);
    await page.locator('[data-review-clear]').click();
    for (const selector of [taskFilter, statusFilter, query]) assert.equal(await page.locator(selector).inputValue(), '');
    await choose(page, reusable);
    const current = control.observation.inspection.tasks.find(task => task.id === 'original')!;
    control.observation.history!.push(structuredClone(current));
    const changed = { ...originalTask, revision: 1, objective: 'Refined execution plan for the same original declaration' };
    control.observation.plan!.tasks = control.observation.plan!.tasks.map(task => task.id === 'original' ? changed : task);
    current.version = taskVersion(changed); current.objective = changed.objective;
    const reused = control.observation.inspection.statementReviews.find(record => (record as Review).id === reusable.id)! as Review;
    reused.version = current.version; control.emit(); await poll(page);
    assert.equal(await page.locator(`${list} [data-review-key]`).count(), reviews.length);
    assert.equal(await choice(page, reusable).count(), 0); assert.equal(await choice(page, reused).count(), 1);
    assert.equal(await page.locator(`${list} [aria-pressed="true"]`).count(), 0, 'version changes do not substitute another contract under a selected key');
    assert.equal(await page.locator('[data-review-reference]').isDisabled(), true); await choose(page, reused);
    assert.match(await page.locator('[data-review-selected-status]').innerText(), /复用|沿用/); await expand(page, '审阅身份');
    assert.ok((await page.locator(detail).innerText()).includes(reusable.snapshotDigest!));
    await choose(page, main);
    const reading = page.locator(`${detail} pre`).filter({ hasText: 'review-reading-line-80' });
    const scroll = await reading.evaluate(node => { node.dataset.readingProbe = 'retained-review-translation'; node.scrollTop = 80; return node.scrollTop; });
    assert.ok(scroll > 0, 'the long translation must have an actual reading offset to preserve');
    await page.locator(query).focus();
    control.observation.inspection.statementReviews.unshift(review('pending', { id: 'background_review' })); control.emit(); await poll(page);
    assert.equal(await choice(page, main).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator(query).evaluate(node => node === document.activeElement), true);
    assert.equal(await reading.getAttribute('data-reading-probe'), 'retained-review-translation'); assert.equal(await reading.evaluate(node => node.scrollTop), scroll);
    const changing = control.observation.inspection.statementReviews.find(record => key(record) === key(main))!;
    await reading.focus();
    const selectedText = await reading.evaluate(node => {
      const text = node.firstChild!; const start = text.textContent!.indexOf('review-reading-line-80');
      const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + 'review-reading-line-80'.length);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); return selection.toString();
    });
    assert.equal(selectedText, 'review-reading-line-80');
    for (const state of ['translated', 'reviewing', 'translated', 'reviewing', 'accepted']) {
      changing.status = state; control.emit(); await poll(page);
      assert.equal(await choice(page, main).getAttribute('aria-pressed'), 'true');
      assert.equal(await reading.evaluate(node => node.scrollTop), scroll, `${state} preserves unchanged translation reading`);
      assert.equal(await reading.evaluate(node => node === document.activeElement), true, `${state} preserves focus on the same translation`);
      assert.equal(await page.evaluate(() => window.getSelection()?.toString()), selectedText, `${state} preserves the selected translation text`);
    }
    changing.translation = { ...translation, mathematics: `Changed mathematical translation\n${translation.mathematics}` };
    control.emit(); await poll(page);
    assert.equal(await reading.evaluate(node => node.scrollTop), 0, 'changed text does not inherit the old reading position');
    changing.translation = structuredClone(translation); control.emit(); await poll(page);
    await reading.evaluate(node => { node.scrollTop = 110; });
    await choose(page, reviews.find(record => record.id === 'review_reviewing')!);
    assert.equal(await reading.evaluate(node => node.scrollTop), 0, 'another review does not inherit a same-text reading position');
    await choose(page, main);
    control.observation.inspection.statementReviews = control.observation.inspection.statementReviews.filter(record => key(record) !== key(main));
    control.emit(); await poll(page);
    assert.equal(await page.locator(`${list} [aria-pressed="true"]`).count(), 0); assert.equal(await page.locator('[data-review-reference]').isDisabled(), true);
    assert.match(await page.locator(detail).innerText(), /不在|未保留|移除|未提供/);
  });

  await scenario('statement and fixed candidate references preserve existing guidance recipients and exact observation without sending commands', async h => {
    const { page } = h, run = await create(h), control = controls.get(run.id)!; await choose(page, main);
    const originalVersions = control.observation.inspection.tasks.map(task => [task.id, task.version]);
    await page.locator('[data-guidance-kind]').selectOption('worker'); await page.locator('[data-guidance-target]').selectOption('researcher');
    await page.locator('[data-guidance-text]').fill('Keep the existing statement instruction.'); await page.locator('[data-review-reference]').click();
    assert.equal(await page.locator('[data-guidance-kind]').inputValue(), 'worker'); assert.equal(await page.locator('[data-guidance-target]').inputValue(), 'researcher');
    let draft = await page.locator('[data-guidance-text]').inputValue(); assert.ok(draft.startsWith('Keep the existing statement instruction.'));
    for (const value of [run.id, control.observation.solverRunId, main.id!, main.taskId, main.version, main.snapshotDigest!, main.environmentDigest!, main.commit!,
      String(control.observation.sequence), control.observation.snapshot.stateDigest]) assert.ok(draft.includes(value), `statement reference retains ${value}`);
    await validateGuidanceDraft(page, control); assert.match(draft, /节选|excerpt/i);
    assert.equal(draft.includes('review-reading-line-80'), false, 'a statement reference does not append the full long translation');
    await page.locator('[data-guidance-kind]').selectOption('task'); await page.locator('[data-guidance-target]').selectOption('original');
    const retained = draft; await page.locator('[data-review-candidate-reference]').click();
    assert.equal(await page.locator('[data-guidance-kind]').inputValue(), 'task'); assert.equal(await page.locator('[data-guidance-target]').inputValue(), 'original');
    draft = await page.locator('[data-guidance-text]').inputValue(); assert.ok(draft.startsWith(retained));
    for (const value of [run.id, control.observation.solverRunId, candidate.commit, candidate.sourceDigest, String(control.observation.sequence), control.observation.snapshot.stateDigest])
      assert.ok(draft.includes(value), `candidate reference retains ${value}`);
    await validateGuidanceDraft(page, control);
    const fullDraft = 'x'.repeat(3990);
    await page.locator('[data-guidance-text]').fill(fullDraft);
    const contextBefore = await page.locator('[data-guidance-context]').innerText();
    for (const selector of ['[data-review-reference]', '[data-review-candidate-reference]']) {
      await page.locator(selector).click();
      assert.equal(await page.locator('[data-guidance-text]').inputValue(), fullDraft, 'an over-limit reference leaves the full original draft intact');
      assert.equal(await page.locator('[data-guidance-kind]').inputValue(), 'task');
      assert.equal(await page.locator('[data-guidance-target]').inputValue(), 'original');
      assert.equal(await page.locator('[data-guidance-context]').innerText(), contextBefore);
      assert.match(await page.locator('[data-review-status-message]').innerText(), /未加入|过长|超出|4000/);
      await validateGuidanceDraft(page, control);
    }
    assert.deepEqual(control.observation.inspection.tasks.map(task => [task.id, task.version]), originalVersions);
    assert.equal(h.requests.some(request => request.method !== 'GET' && request.pathname !== '/api/runs'), false);
  });

  await scenario('an accepted fixed candidate stays distinct from S3 until the completed run has evaluated_passed', async h => {
    const { page } = h, run = await create(h), control = controls.get(run.id)!;
    await expand(page, '候选身份与分配', candidateView);
    assert.ok((await page.locator(candidateView).innerText()).includes(candidate.commit));
    assert.ok((await page.locator(candidateView).innerText()).includes(candidate.sourceDigest));
    assert.match(await page.locator(candidateView).innerText(), /固定|记录/);
    assert.match(await page.locator('[data-review-candidate-status]').innerText(), /不表示当前源码已验收/);
    assert.ok((await page.locator(`${candidateView} dt`).allTextContents()).includes('执行 Agent'));
    assert.match(await page.locator(acceptance).innerText(), /尚未|未通过|未验收/);
    control.result('evaluated_passed'); await poll(page);
    assert.equal((await readRun(h, run.id)).status, 'running'); assert.match(await page.locator(acceptance).innerText(), /尚未|未通过|未验收/);
    control.result('evaluated_failed', true); await poll(page);
    assert.equal((await readRun(h, run.id)).status, 'completed'); assert.match(await page.locator(acceptance).innerText(), /尚未|未通过|未验收/);
    const passed = await create(h); controls.get(passed.id)!.result('evaluated_passed', true); await poll(page);
    assert.equal((await readRun(h, passed.id)).status, 'completed');
    assert.match(await page.locator(acceptance).innerText(), /验收通过|通过独立/);
    controls.get(passed.id)!.observation.inspection.review = undefined; controls.get(passed.id)!.emit(); await poll(page);
    assert.match(await page.locator(acceptance).innerText(), /验收通过|通过独立/);
    assert.equal(await page.locator('[data-review-candidate-reference]').count(), 0);
  });

  for (const width of [375, 320]) await scenario(`statement review filters, exact contracts and translations fit ${width}px`, async h => {
    const { page } = h; await create(h); await choose(page, main);
    await fit(page, [section, taskFilter, statusFilter, query, '[data-review-clear]', list, detail, candidateView, acceptance,
      '[data-review-reference]', '[data-review-candidate-reference]']);
    await page.locator(detail).evaluate(node => { node.scrollTop = 0; }); await frame(page, '[data-review-heading]');
    await page.screenshot({ path: path.join(output, `reviews-${width}.png`) });
    await frame(page, `${detail} h4`); await page.screenshot({ path: path.join(output, `review-detail-${width}.png`) });
    await page.locator(`${detail} [data-collab-task="base"][data-task-version="${baseVersion}"]`).click();
    assert.equal(await page.locator('[data-inspected-task-version]').innerText(), baseVersion);
    await fit(page, ['.collab-inspector', '[data-inspected-task-version]']);
  }, width);

  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined, 'local-real-http-saved-reviews',
    { checks: suite.checks, translationParser: 'readBacktranslation', guidanceSchema: 'webGuidanceSchema', maxGuidanceCharacters: 4000,
      simulatedReviewAndS3Records: true, leanProcesses: 0,
      screenshots: ['reviews-desktop.png', 'reviews-375.png', 'review-detail-375.png', 'reviews-320.png', 'review-detail-320.png'] }, { credential: input.apiKey });
  console.log('Saved review browser checks passed');
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-saved-reviews',
    { checks: suite.checks, translationParser: 'readBacktranslation', guidanceSchema: 'webGuidanceSchema', maxGuidanceCharacters: 4000,
      simulatedReviewAndS3Records: true, leanProcesses: 0 }, { credential: input.apiKey, failureRequests: true }); throw error;
} finally {
  for (const control of controls.values()) control.finish(); await browser.close(); await service.close();
}
