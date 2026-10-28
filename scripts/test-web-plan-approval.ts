#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { localeStorageKey } from '../apps/web/i18n';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput, WorkerMessage } from '../apps/web/shared';
import type { WebInspection, WebObservation, WebPlanApproval } from '../apps/web/collaboration';
import { audit } from './web-a11y';
import { closeSettings, openSettings, openTab, refreshHistory, selectHistoryRun } from './web-ui-controls';
import { freePort, postRun, ready, settled, startBrowser } from './web-scenario';

/**
 * 先审计划 against a local runner (no Docker, no model): the option needs task collaboration and two Agents and reaches
 * the worker; a run whose plan waits shows the approval banner with its four actions; an approval of a plan that changed
 * meanwhile is rejected with a readable reason, whether the saved checkpoint or the running solver rejects it; the
 * approval of the current version releases the run; while the Lead revises from a note nothing can be approved.
 * Audited, and laid out at 1440 and 375 px in Chinese and at 1440 px in English.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-plan-approval');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the plan-approval check.'); });
await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const now = () => new Date().toISOString();
const digest = (character: string) => character.repeat(64);
const source = 'theorem add_zero (n : Nat) : n + 0 = n := by\n  sorry\n\ntheorem zero_add (n : Nat) : 0 + n = n := by\n  sorry\n';

/** What the running solver would report: the plan version, its approval record, and whether the Lead revises it. */
type Control = { observation: WebObservation; approval: WebPlanApproval; emit: () => void; finish: () => void;
  /** How the solver answers the next approval it reads; by default it accepts the current version. */
  answer?: (id: string, planVersion: string) => 'approve' | 'reject' };
const controls = new Map<string, Control>();
const started: WebRunInput[] = [];
const approvals: { runId: string; id: string; planVersion: string }[] = [];

function observation(id: string): WebObservation {
  const tasks = [['add_zero', 'n + 0 = n'], ['zero_add', '0 + n = n']] as const;
  const plan = { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: tasks.map(([name, type]) => ({
    id: name, kind: 'goal' as const, objective: `证明 ${name}`, dependsOn: [], revision: 0, theoremName: name, proofPath: 'Submission.lean', type })) };
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `solver-${id}`, stateDigest: digest('a'), resultDigest: null };
  const inspection: WebInspection = { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot,
    evidence: 'recorded-not-replayed', phase: 'cooperative',
    problem: { id: 'plan-approval-fixture', statement: '证明两个自然数加零的等式', formalStatement: source, assumptions: [],
      targets: tasks.map(([name]) => ({ proofPath: 'Submission.lean', theoremName: name })) },
    configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative', buildDigest: digest('b'), environmentDigest: digest('e') },
    turns: 1, planVersion: plan.baseVersion,
    scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 2, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 2, stopped: 0 },
    knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded',
      droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
    mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: digest('c'),
      obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
    progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: tasks.map(([name]) => name) },
    groups: [], tasks: plan.tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective, group: 'main', status: 'pending',
      control: 'active', version: `${task.id}-v1`, theorem: task.theoremName, type: task.type, premises: [], plannedDependencies: [],
      attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })),
    workers: [
      { id: 'lead', role: 'lead', sessionRole: 'lead', phase: 'waiting', turns: 1, scheduling: { status: 'idle', since: 1 }, dispatchWait: { status: 'unknown' } },
      { id: 'engineer', role: 'engineer', sessionRole: 'engineer', phase: 'waiting', turns: 0, scheduling: { status: 'idle', since: 1 },
        dispatchWait: { status: 'recorded', observation: { stage: 'plan-approval' } } }],
    statementReviews: [], edits: [],
    planApproval: { required: true, status: 'pending', planVersion: plan.baseVersion, requestedAt: Date.now(), rejections: [], leadRevising: false } };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, inspection, plan, sources: [], checks: [], guidance: [],
    coverage: { sources: 'recorded', checks: 'recorded' } };
}
/** A new plan version, as after a human edit or a Lead revision; the engineer still waits for approval. */
function revise(control: Control, version: string) {
  control.observation.plan!.baseVersion = version;
  control.observation.inspection.planVersion = control.approval.planVersion = version;
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: '本地计划批准验证环境' }; },
  async run(input, send: (message: WorkerMessage) => void, signal) {
    started.push(input.input);
    await new Promise<void>(resolve => {
      const value = observation(input.id);
      const control: Control = { observation: value, approval: value.inspection.planApproval!, finish: resolve, emit() {
        this.observation = { ...this.observation, sequence: this.observation.sequence + 1, observedAt: now() };
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      controls.set(input.id, control);
      signal.addEventListener('abort', () => resolve(), { once: true });
      send({ type: 'progress', event: 'solve_started', message: '开始研究' });
      control.emit();
    });
  },
  // Like the worker bridge: a version the saved checkpoint no longer shows is rejected at once, anything else is queued
  // for the solver, which records it as the approval or rejects it on its next read.
  async command(runId, command) {
    const control = controls.get(runId)!;
    if (command.type === 'capture') return { id: 'capture', status: 'captured', observation: control.observation };
    if (command.type !== 'plan-approval') throw new Error(`Plan-approval fixture received ${command.type}`);
    const { id, planVersion } = command.approval;
    approvals.push({ runId, id, planVersion });
    if (planVersion !== control.approval.planVersion)
      return { id, status: 'rejected', reason: 'math_plan_approval_version_conflict', planVersion };
    setTimeout(() => {
      const answer = control.answer?.(id, planVersion) ?? 'approve';
      control.answer = undefined;
      if (answer === 'approve') Object.assign(control.approval, { status: 'approved', approvedId: id, approvedVersion: planVersion, approvedAt: Date.now() });
      else control.approval.rejections.push({ id, reason: 'math_plan_approval_version_conflict', planVersion, at: Date.now() });
      control.emit();
    }, 300);
    return { id, status: 'queued', planVersion };
  },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-plan-approval-fixture', model: 'fixture-plan-model', effort: 'low',
  environment: 'standard', source, task: '证明两个加零的等式', maxTurns: 6, maxRunSeconds: 600, workers: 2, coordination: 'cooperative', planApproval: true };
const mark = (check: string) => console.log(`PASS ${check}`);
const banner = (page: Page) => page.locator('[data-run-approval]');
const shot = async (page: Page, name: string) => { await settled(page); await page.screenshot({ path: path.join(output, name) }); };
/** The workbench polls on its own; a visibility change makes it read the runs now. */
async function poll(page: Page) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'GET');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await response; await settled(page);
}
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1
  && [...document.querySelectorAll('[data-run-approval], [data-run-approval] *')].every(node => node.getBoundingClientRect().right <= innerWidth + 1));
let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
const errors: string[] = [];
/** Runs belong to a session; later pages reuse the first page's cookie to see them. */
let session: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;
// Headless Chromium has no notification service; record what the page would show.
const notificationFixture = () => {
  const shown: { title: string; body: string }[] = [];
  let permission: NotificationPermission = 'default';
  class FixtureNotification { static get permission() { return permission; }
    static async requestPermission() { permission = 'granted'; return permission; }
    onclick: (() => void) | null = null;
    constructor(title: string, options: NotificationOptions) { shown.push({ title, body: options.body ?? '' }); }
    close() {} }
  Object.assign(window, { Notification: FixtureNotification, __notifications: shown });
};
const notifications = (page: Page) => page.evaluate(() => (window as unknown as { __notifications: { title: string; body: string }[] }).__notifications);
const setHidden = (page: Page, hidden: boolean) => page.evaluate(hidden => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);
async function open(width: number, locale: 'zh' | 'en' = 'zh', notify = false) {
  const context = await browser!.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', ...(session ? { storageState: session } : {}) });
  if (locale === 'en') await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, locale] as const);
  if (notify) await context.addInitScript(notificationFixture);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(`${width}/${locale}: ${error.message}`));
  await page.goto(origin); await ready(page);
  return { context, page };
}
try {
  browser = await startBrowser(service.server, port);
  const { context, page } = await open(1440);

  // The option is offered only where it means something: task collaboration with at least two Agents.
  await openSettings(page);
  const option = page.locator('#plan-approval');
  assert.equal(await option.isDisabled(), true, 'one Agent has no peers to hold');
  await page.locator('#workers').fill('2');
  assert.equal(await option.isDisabled(), false);
  await option.check();
  await page.locator('input[name="coordination"][value="independent"]').check({ force: true });
  assert.equal(await option.isDisabled(), true, 'independent Agents share no plan');
  assert.equal(await option.isChecked(), true, 'the choice is kept for when it applies again');
  await page.locator('input[name="coordination"][value="cooperative"]').check({ force: true });
  assert.equal(await option.isDisabled(), false);
  await page.locator('.plan-approval-option').scrollIntoViewIfNeeded();
  assert.deepEqual(await audit(page, { scope: '#run-settings' }), [], 'settings with the plan-approval option');
  await shot(page, 'option-1440.png');
  await closeSettings(page);
  mark('先审计划 needs task collaboration and two Agents');

  await page.locator('#task').fill(input.task);
  await page.evaluate(([key, value]) => {
    for (const [id, text] of [['api-key', key], ['source', value]] as const) {
      const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
      field.value = text; field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, [input.apiKey, source] as const);
  const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/runs' && request.method() === 'POST');
  await page.locator('#submit-run:enabled').click();
  const body = JSON.parse((await request).postData() ?? '{}');
  assert.equal(body.planApproval, true, 'the option is submitted');
  await banner(page).waitFor({ timeout: 15_000 });
  assert.equal(started.at(-1)?.planApproval, true, 'the option reaches the worker');
  const first = [...controls.keys()].at(-1)!, control = controls.get(first)!;
  mark('the option reaches the worker');
  // The waiting plan: the banner says what is asked and why nothing runs, and the run reads as waiting everywhere.
  assert.equal(await page.locator('#run-approval-heading').innerText(), '研究计划等你批准');
  assert.match(await banner(page).innerText(), /Lead 把题目拆成了 2 项任务。批准后 Agent 才开始工作[\s\S]*等待批准的时间也计入解题预算/u);
  assert.equal(await page.locator('.detail-statusline [data-status]').innerText(), '等你批准计划');
  assert.match(await page.locator('#detail-panel').innerText(), /Lead 已经拟好研究计划，等你批准后 Agent 才开始工作/u);
  assert.equal(await page.locator(`[data-run-id="${first}"] .badge`).first().innerText(), '等你批准计划');
  assert.equal(await page.locator('[data-run-approval] [data-action="approve-plan"]').isEnabled(), true);
  assert.deepEqual(await audit(page, { scope: '[data-run-approval]' }), [], 'approval banner');
  // Nothing runs yet: the verdict has no spinner, and the goals wait for the plan instead of being proved.
  assert.equal(await page.locator('#result-verdict-heading').innerText(), '证明尚未开始');
  assert.equal(await page.locator('.result-verdict-mark .spinner').count(), 0);
  assert.deepEqual(await page.locator('.result-goals .goal-row').evaluateAll(rows => rows.map(row =>
    [(row as HTMLElement).dataset.goalState, row.querySelector('.badge')?.textContent])), [['planned', '等计划批准'], ['planned', '等计划批准']]);
  await shot(page, 'pending-1440.png');
  mark('a waiting plan shows the approval banner, status and result text');

  // Its other actions lead to the plan, its editor and a note to the Lead; the banner stays above every tab.
  await page.locator('[data-run-approval] [data-action="show-plan"]').click();
  await page.locator('#detail-tab-collaboration[aria-selected="true"]').waitFor();
  await page.locator('[data-collab-task="add_zero"]:visible').first().waitFor();
  assert.equal(await banner(page).count(), 1);
  await page.locator('[data-run-approval] [data-action="edit-plan"]').click();
  await page.locator('.collab-plan-dialog[open]').waitFor();
  await page.locator('[data-plan-close]').click();
  await page.locator('.collab-plan-dialog[open]').waitFor({ state: 'detached' });
  await page.locator('[data-run-approval] [data-action="guide-lead"]').click();
  await page.waitForFunction(() => document.activeElement?.matches('[data-guidance-text]'));
  assert.equal(await page.locator('[data-guidance-kind]').inputValue(), 'lead', 'the note is addressed to the Lead');
  assert.equal(approvals.length, 0, 'looking, editing and writing a note approve nothing');
  await openTab(page, 'result');
  mark('查看计划, 修改计划 and 给 Lead 留言 open the plan, its editor and a note to the Lead');

  // The plan changed after the page last read it: the saved checkpoint rejects the approval of the older version.
  revise(control, 'plan-v2');
  await page.locator('[data-run-approval] [data-action="approve-plan"]').click();
  await page.locator('.run-approval-error').getByText('批准没有生效：你批准之前计划又改过了。请看一遍新的计划再批准。').waitFor();
  assert.equal(await page.locator('[data-run-approval] [data-action="approve-plan"]').isEnabled(), true, 'the owner can approve again');
  assert.deepEqual(approvals.map(item => item.planVersion), ['plan-v1']);
  await shot(page, 'conflict-1440.png');
  mark('an approval of an older plan is rejected with a readable reason');

  // The current version: busy while the solver reads it, then the run goes on and the banner leaves.
  control.emit(); await poll(page);
  await page.locator('[data-run-approval] [data-action="approve-plan"]').click();
  await page.locator('[data-run-approval] [data-action="approve-plan"]').getByText('正在批准').waitFor();
  assert.equal(await page.locator('[data-run-approval] [data-action="edit-plan"]').isDisabled(), true);
  await page.locator('#toast:not([hidden])').getByText('批准已提交，运行确认后 Agent 就开始工作').waitFor();
  for (let tries = 0; control.approval.status !== 'approved' && tries < 50; tries++) await page.waitForTimeout(100);
  await poll(page);
  await banner(page).waitFor({ state: 'detached' });
  assert.notEqual(await page.locator('.detail-statusline [data-status]').innerText(), '等你批准计划');
  assert.deepEqual(approvals.map(item => item.planVersion), ['plan-v1', 'plan-v2']);
  assert.equal(control.approval.approvedId, approvals[1].id);
  assert.equal(await page.locator('#result-verdict-heading').innerText(), '研究正在运行');
  assert.equal(await page.locator('.result-verdict-mark .spinner').count(), 1);
  assert.deepEqual(await page.locator('.result-goals .goal-row').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.goalState)), ['working', 'working']);
  mark('approving the current version releases the run');
  // While the Lead revises the plan from a note, nothing can be approved; the solver may still reject an approval
  // that it reads after one more change, and the banner says so once that rejection is observed.
  const second = (await postRun({ page }, input)).id;
  for (let tries = 0; !controls.has(second) && tries < 50; tries++) await page.waitForTimeout(100);
  const revising = controls.get(second)!;
  revising.approval.leadRevising = true; revising.emit();
  await refreshHistory(page); await selectHistoryRun(page, second);
  await page.locator('#run-approval-heading').getByText('Lead 正在按你的留言修改计划').waitFor();
  assert.equal(await page.locator('[data-run-approval] [data-action="approve-plan"]').isDisabled(), true);
  assert.match(await page.locator('#detail-panel').innerText(), /Lead 正在按你的留言修改研究计划，改完后再请你批准/u);
  // The Lead is working on the plan, so the verdict spins while the goals still wait.
  assert.equal(await page.locator('#result-verdict-heading').innerText(), '证明尚未开始');
  assert.equal(await page.locator('.result-verdict-mark .spinner').count(), 1);
  assert.equal(await page.locator('.result-goals .goal-row[data-goal-state="planned"]').count(), 2);
  await shot(page, 'revising-1440.png');
  revise(revising, 'plan-v2'); revising.approval.leadRevising = false; revising.emit(); await poll(page);
  await page.locator('#run-approval-heading').getByText('研究计划等你批准').waitFor();
  revising.answer = () => 'reject';
  await page.locator('[data-run-approval] [data-action="approve-plan"]').click();
  await page.locator('#toast:not([hidden])').getByText('批准已提交，运行确认后 Agent 就开始工作').waitFor();
  for (let tries = 0; !revising.approval.rejections.length && tries < 50; tries++) await page.waitForTimeout(100);
  await poll(page);
  await page.locator('.run-approval-error').getByText('批准没有生效：你批准之前计划又改过了。请看一遍新的计划再批准。').waitFor();
  assert.equal(await page.locator('[data-run-approval] [data-action="approve-plan"]').isEnabled(), true);
  revising.approval.rejections = []; revising.emit();
  mark('a revising Lead blocks approval, and a rejection read by the solver is shown');
  session = await context.storageState();
  await context.close();

  // Phones and English: the same banner, wrapped and translated.
  {
    const { context, page } = await open(375);
    await selectHistoryRun(page, second);
    await banner(page).waitFor();
    assert.equal(await fits(page), true, 'the banner fits at 375 px');
    await banner(page).scrollIntoViewIfNeeded();
    await shot(page, 'pending-375.png');
    await context.close();
  }
  {
    const { context, page } = await open(1440, 'en');
    await selectHistoryRun(page, second);
    await page.locator('#run-approval-heading').getByText('The research plan is waiting for your approval').waitFor();
    assert.match(await banner(page).innerText(), /The Lead split the problem into 2 tasks[\s\S]*Approve and start/u);
    assert.deepEqual(await audit(page, { scope: '[data-run-approval]' }), [], 'English approval banner');
    assert.equal(await page.locator('#result-verdict-heading').innerText(), 'Proving has not started');
    assert.equal(await page.locator('.result-goals .goal-row .badge').first().innerText(), 'Awaiting plan approval');
    await shot(page, 'pending-en-1440.png');
    await context.close();
  }
  mark('the banner fits at 375 px and reads in English');
  {
    // A plan that becomes ready while the tab is hidden: one desktop notification, and the tab title counts it until
    // it is approved. In a visible tab, a plan of another run waiting is a toast instead.
    const { context, page } = await open(1440, 'zh', true);
    const third = (await postRun({ page }, input)).id;
    for (let tries = 0; !controls.has(third) && tries < 50; tries++) await page.waitForTimeout(100);
    const later = controls.get(third)!;
    later.approval.status = 'awaiting-plan'; later.emit();
    await refreshHistory(page); await selectHistoryRun(page, third);
    await page.locator('#run-approval-heading').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#result-verdict-heading').innerText(), '证明尚未开始');
    assert.match(await page.locator('#detail-panel').innerText(), /Lead 正在拟定研究计划，拟好后会请你批准/u);
    await page.locator('#detail-panel [data-action="notify"]').click();
    await page.locator('#detail-panel [data-action="notify"][aria-pressed="true"]').waitFor();
    await page.locator('#toast:not([hidden])').getByText('研究结束或计划等你批准时会发送桌面通知').waitFor();
    await page.waitForFunction(() => document.title.startsWith('(1) 等你批准计划'));
    await setHidden(page, true);
    Object.assign(later.approval, { status: 'pending', requestedAt: Date.now() }); later.emit();
    await page.waitForFunction(() => document.title.startsWith('(2) 等你批准计划'), undefined, { timeout: 25_000 });
    const shown = await notifications(page);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].title, 'TheoremOS · 研究计划等你批准');
    assert.match(shown[0].body, /证明两个加零的等式\nLead 已经拟好研究计划/u);
    await setHidden(page, false);
    await selectHistoryRun(page, second);
    later.approval.leadRevising = true; later.emit(); await poll(page);
    await page.waitForFunction(() => document.title.startsWith('(1) 等你批准计划'));
    later.approval.leadRevising = false; later.emit(); await poll(page);
    await page.locator('#toast:not([hidden])').getByText('「证明两个加零的等式」的研究计划等你批准').waitFor();
    assert.equal((await notifications(page)).length, 1, 'a visible tab gets a toast, not a desktop notification');
    later.finish(); await context.close();
  }
  mark('a plan that becomes ready sends one desktop notification from a hidden tab, a toast in a visible one, and counts in the tab title');
  assert.deepEqual(errors, []);
  console.log('Plan-approval browser checks passed');
} finally {
  for (const control of controls.values()) control.finish();
  await browser?.close();
  await service.close();
}
