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
import type { WebCommand, WebObservation, WebPlanProposal } from '../apps/web/collaboration';
import { closeDialog, fitViewport, refreshHistory, selectHistoryRun } from './web-ui-controls';
import { deferred, freePort, postRun, settled, startBrowser, webScenario, writeScenarioReport,
  type ScenarioHarness, type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-plan-recovery');
await fs.mkdir(output, { recursive: true });
const now = () => new Date().toISOString(), digest = (character: string) => character.repeat(64);
type Control = { observation: WebObservation; mode: 'unknown' | 'queued' | 'applied'; emit(): void; finish(): void };
type Call = { method: string; pathname: string; body: string | null };
type Harness = ScenarioHarness & { runIds: string[]; calls: Call[]; effect?: (route: Route) => Promise<boolean> };
const controls = new Map<string, Control>();
const commands: Array<{ runId: string; command: WebCommand }> = [];

function observation(id: string): WebObservation {
  const plan: WebObservation['plan'] = { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [
    { id: 'base', kind: 'lemma', objective: 'Prove the reusable premise', dependsOn: [], revision: 0,
      theoremName: 'base', proofPath: 'Submission.lean', type: 'True' },
    { id: 'original', kind: 'goal', objective: 'Prove the original theorem', dependsOn: ['base'], revision: 0,
      theoremName: 'original_goal', proofPath: 'Submission.lean', type: 'True' },
  ] };
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `solver-${id}`, stateDigest: digest('a'), resultDigest: null };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId,
    observedAt: now(), sequence: 1, evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, plan,
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot,
      evidence: 'recorded-not-replayed', phase: 'cooperative',
      problem: { id: 'plan-recovery-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [],
        targets: [{ proofPath: 'Submission.lean', theoremName: 'original_goal' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative',
        buildDigest: digest('b'), environmentDigest: digest('e') }, turns: 1, planVersion: plan.baseVersion,
      scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 2, working: 1, proofAssignments: 1,
        preparing: 0, stopping: 0, idle: 1, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin',
        retrievalCoverage: 'recorded', droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] },
      tokenBudget: {}, continuation: {}, mathematics: { snapshot: { schema: 'theorem-os.obligation.v1',
        evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: digest('c'),
        obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['base', 'original'] },
      groups: [], tasks: plan.tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective,
        group: 'main', status: 'pending', control: 'active', version: `${task.id}-v1`, theorem: task.theoremName,
        type: task.type, premises: [], plannedDependencies: task.dependsOn, attempts: 0,
        proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })),
      workers: [{ id: 'lead', role: 'lead', phase: 'waiting', turns: 1, dispatchWait: { status: 'unknown' } },
        { id: 'prover-1', role: 'prover', phase: 'proving', task: 'base', turns: 1, dispatchWait: { status: 'unknown' } }],
      statementReviews: [], edits: [] }, sources: [], checks: [], guidance: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}

function hostReceipt(runId: string, proposal: WebPlanProposal, status: 'applied' | 'rejected') {
  const control = controls.get(runId)!;
  if (status === 'applied') {
    control.observation.plan = { ...structuredClone(proposal), baseVersion: 'plan-v2' };
    control.observation.inspection.planVersion = 'plan-v2';
  }
  control.observation.inspection.edits.push({ id: proposal.id, status, baseVersion: proposal.baseVersion,
    planVersion: status === 'applied' ? 'plan-v2' : undefined, affectedTasks: ['base'],
    ...(status === 'applied' ? { recheck: { status: 'pending', tasks: [{ taskId: 'base', taskDigest: 'base-v1', status: 'pending' }] } } : {}),
    reason: status === 'rejected' ? 'fixture_host_rejected' : undefined });
  control.emit();
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local plan recovery HTTP fixture' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), mode: 'unknown', finish: resolve,
        emit() { this.observation = { ...this.observation, sequence: this.observation.sequence + 1, observedAt: now() };
          send({ type: 'observation', observation: structuredClone(this.observation) }); } };
      controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true }); control.emit();
    });
  },
  async command(runId, command) {
    commands.push({ runId, command: structuredClone(command) });
    const control = controls.get(runId)!;
    if (command.type === 'capture') return { id: 'capture', status: 'captured', observation: control.observation };
    if (command.type === 'guidance') throw new Error('Plan recovery must not send guidance');
    if (command.type === 'plan-approval') throw new Error('Plan recovery must not approve a plan');
    if (command.proposal.baseVersion !== control.observation.plan!.baseVersion) throw new Error('math_edit_version_conflict');
    if (command.type === 'edit-preview') return { id: command.proposal.id, status: 'validated', affectedTaskIds: ['base'],
      changes: [{ taskId: 'base', fields: ['objective'] }] };
    if (control.mode !== 'applied') return { id: command.proposal.id, status: control.mode,
      ...(control.mode === 'unknown' ? { reason: 'fixture_delivery_uncertain' } : {}) };
    hostReceipt(runId, command.proposal, 'applied');
    return { id: command.proposal.id, status: 'queued', baseVersion: command.proposal.baseVersion, observation: control.observation };
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-local-plan-recovery-fixture', model: 'fixture', effort: 'low',
  environment: 'standard', source: 'theorem original_goal : True := by sorry\n', task: 'Inspect plan recovery',
  maxTurns: 2, maxRunSeconds: 60, workers: 2, coordination: 'cooperative' };
const receipt = '[data-plan-receipt]', refresh = '[data-plan-receipt-refresh]', retry = '[data-plan-retry]';
const json = (page: Page) => page.locator('#collab-plan-json').inputValue();
const proposal = async (page: Page) => JSON.parse(await json(page)) as WebPlanProposal;
const edits = (h: Harness, id: string) => h.calls.filter(call => call.method === 'POST' && call.pathname === `/api/runs/${id}/edits`);
const reads = (h: Harness, id: string) => h.calls.filter(call => call.method === 'GET' && call.pathname.startsWith(`/api/runs/${id}/commands/`));
const delivered = (id: string) => commands.filter(item => item.runId === id && item.command.type === 'edit');
async function select(h: Harness, id: string) {
  await selectHistoryRun(h.page, id, 'collaboration'); await h.page.locator('.collab-surface').waitFor();
  await h.page.locator('[data-collab-task="base"]:visible').first().waitFor();
}
async function create(h: Harness) {
  const run = await postRun(h, input); h.runIds.push(run.id);
  await refreshHistory(h.page); await select(h, run.id); return run;
}
async function openPlan(page: Page) {
  await page.locator('[data-collab-plan]:enabled').click();
  await page.locator('.collab-plan-dialog[open]').waitFor(); await page.locator('[data-plan-task]').selectOption('base');
}
const closePlan = (page: Page) => closeDialog(page, '.collab-plan-dialog', () => page.locator('[data-plan-close]').click());
async function preview(page: Page) {
  await page.locator('[data-plan-preview]').click(); await page.locator('[data-plan-apply]:enabled').waitFor();
}
async function poll(page: Page) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'GET');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await response; await settled(page);
}
async function observed(page: Page, sequence: number) {
  await page.waitForFunction(sequence => document.querySelector('[data-collab-observation]')?.textContent?.includes(`观察 #${sequence} ·`), sequence);
}
async function applied(page: Page, id: string) {
  await page.locator(receipt).getByText(new RegExp(`回执 ${id} · 已应用`)).waitFor();
}
function scenario(name: string, run: (h: Harness) => Promise<void>, width = 1440) {
  return webScenario<Harness>(browser, suite, name, run, {
    context: { viewport: { width, height: width > 850 ? 1000 : 812 }, reducedMotion: 'reduce' },
    harness: (page, context) => {
      const h: Harness = { page, context, requests: [], runIds: [], calls: [] };
      h.intercept = async route => {
        const pathname = new URL(route.request().url()).pathname;
        h.calls.push({ method: route.request().method(), pathname,
          body: /\/edits(?:\/preview)?$/.test(pathname) ? route.request().postData() : null });
        return await h.effect?.(route) ?? false;
      }; return h;
    }, routes: { local: 'Plan recovery browser checks must stay local' }, open: true,
    timeout: { label: 'Plan recovery', seconds: 45 },
    verify: (h, elapsedMs) => ({ name, elapsedMs: elapsedMs(), calls: h.calls, runIds: h.runIds }),
    cleanup: h => { for (const id of h.runIds) controls.get(id)?.finish(); },
  });
}

try {
  for (const width of [1440, 390]) for (const originalState of ['applied', 'pending'] as const)
    await scenario(`${width}px: correcting invalid JSON creates a fresh draft after an ${originalState} submission`, async h => {
      const { page } = h, run = await create(h), control = controls.get(run.id)!;
      control.mode = originalState === 'applied' ? 'applied' : 'unknown';
      await openPlan(page); await page.locator('[data-plan-objective]').fill('Original submitted JSON proposal'); await preview(page);
      const original = await proposal(page); await page.locator('[data-plan-apply]').click();
      await page.locator('[data-plan-objective]:enabled').waitFor();
      if (originalState === 'applied') await applied(page, original.id);
      else await page.locator(`${refresh}:enabled`).waitFor();
      await page.locator('[data-plan-advanced] summary').click();
      const editor = page.locator('#collab-plan-json');
      for (const incomplete of ['{', '[]', '{}', 'null']) {
        await editor.fill(incomplete);
        assert.equal(await page.locator('[data-plan-preview]').isDisabled(), true, 'incomplete JSON cannot be previewed');
      }
      const corrected = { ...structuredClone(original), baseVersion: control.observation.plan!.baseVersion };
      corrected.tasks.find(task => task.id === 'base')!.objective = 'Corrected newer JSON proposal';
      await editor.fill(JSON.stringify(corrected, null, 2)); await editor.press('Tab');
      const newer = await proposal(page), newerText = await json(page);
      assert.equal(newer.tasks.find(task => task.id === 'base')!.objective, corrected.tasks[0]!.objective);
      if (originalState === 'pending') {
        assert.deepEqual(JSON.parse((await page.locator(`${receipt} pre`).textContent())!), original, 'the exact original pending command remains recoverable');
        hostReceipt(run.id, original, 'rejected');
        await page.locator(receipt).getByText(new RegExp(`回执 ${original.id} · 已拒绝`)).waitFor();
        assert.equal(await json(page), newerText, 'the original late receipt cannot change the corrected draft');
        assert.equal(await page.locator(refresh).isHidden(), true);
      }
      await page.locator('[data-plan-preview]').click(); await page.locator('[data-plan-objective]:enabled').waitFor();
      assert.equal(await page.locator('[data-plan-apply]').isEnabled(), true, 'the corrected draft preview must remain usable instead of showing the original command receipt');
      assert.notEqual(newer.id, original.id, 'correcting temporary invalid JSON must retire the already submitted command ID');
      await page.locator(receipt).getByText(new RegExp(`回执 ${newer.id} · 已校验`)).waitFor();
      control.mode = 'applied'; await page.locator('[data-plan-apply]').click(); await applied(page, newer.id);
      const sent = edits(h, run.id).map(call => JSON.parse(call.body!) as WebPlanProposal);
      assert.deepEqual(sent.map(item => item.id), [original.id, newer.id], 'a corrected draft is a separate command, never a replay of the original');
      assert.equal(sent[1]!.tasks.find(task => task.id === 'base')!.objective, 'Corrected newer JSON proposal');
      assert.equal(delivered(run.id).length, 2);
    }, width);

  for (const status of ['applied', 'rejected'] as const) await scenario(`live ${status} receipt resolves an unknown command while preserving draft and focus`, async h => {
    const { page } = h, run = await create(h); await openPlan(page);
    await page.locator('[data-plan-objective]').fill(`Original proposal for ${status}`); await preview(page);
    const original = await proposal(page); await page.locator('[data-plan-apply]').click();
    await page.locator(`${refresh}:enabled`).waitFor(); await page.locator(receipt).getByText(/回执 .* · 结果尚未确认/).waitFor();
    assert.equal(reads(h, run.id).length, 1, 'unknown POST must automatically read the original receipt');
    await page.locator(refresh).click(); await page.locator(`${refresh}:enabled`).waitFor();
    assert.equal(reads(h, run.id).length, 2, 'manual refresh must read again');
    assert.equal(await page.locator(retry).isHidden(), true, 'an existing unknown receipt must not offer a missing-command retry');
    await page.locator('[data-plan-objective]').fill(`New local draft after ${status}`);
    const newerText = await json(page), newer = await proposal(page); assert.notEqual(newer.id, original.id);
    assert.deepEqual(JSON.parse((await page.locator(`${receipt} pre`).textContent())!), original, 'pending original remains reviewable after editing');
    assert.equal(await page.locator('[data-plan-apply]').isDisabled(), true);
    const control = controls.get(run.id)!;
    control.observation.inspection.edits.push({ id: `${original.id}-unrelated`, status: 'applied', baseVersion: original.baseVersion });
    control.emit(); await observed(page, control.observation.sequence);
    assert.equal(await page.locator(refresh).isVisible(), true, 'a different edit ID cannot confirm the pending command');
    assert.deepEqual(JSON.parse((await page.locator(`${receipt} pre`).textContent())!), original);
    const focus = page.locator('[data-plan-objective]');
    await focus.focus(); await focus.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(3, 9));
    const beforeReads = reads(h, run.id).length;
    hostReceipt(run.id, original, status);
    await page.locator(receipt).getByText(new RegExp(`回执 ${original.id} · ${status === 'applied' ? '已应用' : '已拒绝'}`)).waitFor();
    await page.locator('[data-plan-objective]:enabled').waitFor();
    assert.equal(await json(page), newerText, 'host receipt must preserve the newer full draft');
    assert.deepEqual(await focus.evaluate((node: HTMLTextAreaElement) => ({ focused: document.activeElement === node,
      start: node.selectionStart, end: node.selectionEnd })), { focused: true, start: 3, end: 9 }, 'live receipts cannot interrupt editing');
    assert.equal(await page.locator(refresh).isHidden(), true);
    assert.equal(reads(h, run.id).length, beforeReads, 'observed outcomes need no manual or automatic receipt GET');
    assert.equal(edits(h, run.id).length, 1); assert.equal(delivered(run.id).length, 1);
    assert.ok(reads(h, run.id).every(call => call.pathname.endsWith(`/${original.id}`)));
    if (status === 'applied') {
      await page.locator('[data-plan-rebase]').click(); await page.locator('[data-plan-apply]:enabled').waitFor();
      const rebased = await proposal(page), previewedText = await json(page);
      assert.notEqual(rebased.id, original.id);
      await focus.focus(); await focus.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 7));
      const priorEdit = control.observation.inspection.edits.find(edit => edit.id === original.id)!;
      priorEdit.recheck = { status: 'passed', tasks: [{ taskId: 'base', taskDigest: 'base-v1', status: 'passed' }] };
      control.emit(); await observed(page, control.observation.sequence);
      await page.locator(receipt).getByText(new RegExp(`回执 ${rebased.id} · 已校验`)).waitFor();
      assert.equal(await page.locator('[data-plan-apply]').isEnabled(), true, 'an earlier command recheck cannot replace the new draft preview');
      assert.equal(await json(page), previewedText);
      assert.deepEqual(await focus.evaluate((node: HTMLTextAreaElement) => ({ focused: document.activeElement === node,
        start: node.selectionStart, end: node.selectionEnd })), { focused: true, start: 2, end: 7 });
    }
  });

  for (const operation of ['post-unknown', 'post-queued', 'receipt-unknown', 'receipt-error'] as const)
    await scenario(`live applied and recheck progress survive a late ${operation} response`, async h => {
      const { page } = h, run = await create(h), control = controls.get(run.id)!;
      control.mode = operation === 'post-queued' ? 'queued' : 'unknown'; await openPlan(page);
      await page.locator('[data-plan-objective]').fill(`Original command awaiting ${operation}`); await preview(page);
      const original = await proposal(page), holdPost = operation.startsWith('post-');
      if (!holdPost) {
        await page.locator('[data-plan-apply]').click(); await page.locator(`${refresh}:enabled`).waitFor();
        await page.locator(receipt).getByText(new RegExp(`回执 ${original.id} · 结果尚未确认`)).waitFor();
        await page.locator('[data-plan-objective]').fill(`Newer draft while ${operation} is delayed`);
      }
      const newerText = await json(page), held = deferred(), release = deferred(), completed = deferred();
      const target = holdPost ? `/api/runs/${run.id}/edits` : `/api/runs/${run.id}/commands/${original.id}`;
      h.effect = async route => {
        if (new URL(route.request().url()).pathname !== target || route.request().method() !== (holdPost ? 'POST' : 'GET')) return false;
        const response = await route.fetch(); assert.equal(response.status(), 200); held.resolve();
        await release.promise;
        if (operation === 'receipt-error') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_late_read_failure' }) });
        else await route.fulfill({ response });
        completed.resolve(); return true;
      };
      try {
        await page.locator(holdPost ? '[data-plan-apply]' : refresh).click(); await held.promise;
        const beforeReads = reads(h, run.id).length;
        hostReceipt(run.id, original, 'applied'); await applied(page, original.id);
        await page.locator('[data-plan-recheck]').getByText('待重新检查', { exact: true }).waitFor();
        await page.locator('[data-plan-recheck] summary').click();
        const edit = control.observation.inspection.edits.find(edit => edit.id === original.id)!;
        edit.recheck = { status: 'passed', tasks: [{ taskId: 'base', taskDigest: 'base-v1', status: 'passed',
          lastCheck: { commit: 'fixture-checked-commit', sourceDigest: digest('d'), environmentDigest: digest('e'),
            passed: true, conditional: false, receiptIds: ['fixture-recheck-receipt'] } }] };
        control.emit();
        await page.locator('[data-plan-recheck]').getByText('重新检查通过', { exact: true }).waitFor();
        assert.equal(await page.locator('[data-plan-recheck] details').evaluate((node: HTMLDetailsElement) => node.open), true, 'live recheck updates preserve the open evidence details');
        const finishedRecheck = await page.locator('[data-plan-recheck]').innerText();
        assert.match(finishedRecheck, /fixture-recheck-receipt/);
        const response = page.waitForResponse(response => new URL(response.url()).pathname === target && response.request().method() === (holdPost ? 'POST' : 'GET'));
        release.resolve(); await completed.promise; await response; await settled(page);
        await page.locator('[data-plan-objective]:enabled').waitFor();
        await applied(page, original.id);
        assert.equal(await page.locator('[data-plan-recheck]').innerText(), finishedRecheck, 'late responses cannot rewind recheck evidence');
        assert.equal(await page.locator(refresh).isHidden(), true, 'live confirmation must remain confirmed');
        assert.equal(await page.locator(retry).isHidden(), true);
        assert.equal(await json(page), newerText, 'late response must not alter the full local draft');
        assert.doesNotMatch(await page.locator(receipt).innerText(), /fixture_late_read_failure|fixture_delivery_uncertain|结果尚未确认/);
        assert.equal(reads(h, run.id).length, beforeReads, 'confirmed observations avoid another receipt recovery read');
        assert.equal(edits(h, run.id).length, 1); assert.equal(delivered(run.id).length, 1);
      } finally { release.resolve(); }
    });

  await scenario('a background run receipt reconciles on reopening without changing another run draft', async h => {
    const { page } = h, runA = await create(h), runB = await create(h); await select(h, runA.id); await openPlan(page);
    await page.locator('[data-plan-objective]').fill('Run A original uncertain proposal'); await preview(page);
    const originalA = await proposal(page); await page.locator('[data-plan-apply]').click();
    await page.locator(`${refresh}:enabled`).waitFor(); await page.locator(receipt).getByText(/回执 .* · 结果尚未确认/).waitFor();
    await page.locator('[data-plan-objective]').fill('Run A newer local draft'); const textA = await json(page);
    await closePlan(page); await select(h, runB.id); await openPlan(page);
    await page.locator('[data-plan-objective]').fill('Run B draft must stay isolated from A'); const textB = await json(page);
    const beforeReads = reads(h, runA.id).length;
    const updated = page.waitForResponse(async response => {
      if (new URL(response.url()).pathname !== '/api/runs' || response.status() !== 200) return false;
      const body = await response.json();
      return body.runs?.some((run: { id: string; observation?: WebObservation }) => run.id === runA.id &&
        run.observation?.inspection.edits.some(edit => edit.id === originalA.id && edit.status === 'applied'));
    });
    hostReceipt(runA.id, originalA, 'applied'); await updated; await settled(page);
    assert.equal(await json(page), textB);
    assert.equal(await page.locator(`${receipt} > :not([data-decision-summary])`).count(), 0, 'only B’s own plan summary may appear; A’s receipt must stay with A');
    await closePlan(page); await select(h, runA.id); await openPlan(page); await applied(page, originalA.id);
    assert.equal(await json(page), textA); assert.equal(await page.locator(refresh).isHidden(), true);
    assert.equal(reads(h, runA.id).length, beforeReads, 'reopening uses the latest saved observation');
    await closePlan(page); await select(h, runB.id); await openPlan(page); assert.equal(await json(page), textB);
    assert.equal(edits(h, runA.id).length, 1); assert.equal(delivered(runA.id).length, 1);
  });

  await scenario('a lost accepted POST response confirms through SSE without recovery reads', async h => {
    const { page } = h, run = await create(h); controls.get(run.id)!.mode = 'applied'; await openPlan(page);
    await page.locator('[data-plan-objective]').fill('Persist before dropping the browser response'); await preview(page);
    const original = await proposal(page), received = deferred(), release = deferred();
    h.effect = async route => {
      if (route.request().method() !== 'POST' || new URL(route.request().url()).pathname !== `/api/runs/${run.id}/edits`) return false;
      const response = await route.fetch(); assert.equal(response.status(), 200); received.resolve();
      await release.promise; await route.abort(); return true;
    };
    try {
      await page.locator('[data-plan-apply]').click(); await received.promise; assert.equal(delivered(run.id).length, 1);
      await applied(page, original.id);
    }
    finally { release.resolve(); }
    await page.locator(receipt).getByText(new RegExp(`回执 ${original.id} · 已应用`)).waitFor();
    await page.locator('[data-plan-objective]:enabled').waitFor();
    assert.equal(edits(h, run.id).length, 1, 'lost responses must never resend an edit automatically');
    assert.equal(reads(h, run.id).length, 0, 'a matching live receipt avoids reading again after the lost response');
    assert.equal(delivered(run.id).length, 1);
    assert.equal(await page.locator(refresh).isHidden(), true);
  });

  await scenario('missing edit retries its exact original snapshot after GET and retains a newer draft', async h => {
    const { page } = h, run = await create(h); await openPlan(page);
    await page.locator('[data-plan-objective]').fill('Original snapshot before a request abort'); await preview(page);
    const original = await proposal(page); let aborted = false;
    h.effect = async route => {
      if (aborted || route.request().method() !== 'POST' || new URL(route.request().url()).pathname !== `/api/runs/${run.id}/edits`) return false;
      aborted = true; await route.abort(); return true;
    };
    await page.locator('[data-plan-apply]').click(); await page.locator(`${retry}:enabled`).waitFor();
    assert.equal(delivered(run.id).length, 0, 'aborted POST must not reach the runner');
    assert.equal(reads(h, run.id).length, 1);
    await page.locator('[data-plan-objective]').fill('Newer draft must not be sent by the retry control');
    await page.locator('[data-plan-type]').fill('True ∧ True');
    const newerText = await json(page); assert.notEqual((await proposal(page)).id, original.id);
    assert.deepEqual(JSON.parse((await page.locator(`${receipt} pre`).textContent())!), original);
    controls.get(run.id)!.mode = 'applied'; const before = h.calls.length;
    await page.locator(retry).click(); await applied(page, original.id);
    await page.locator('[data-plan-objective]:enabled').waitFor();
    const recovery = h.calls.slice(before).filter(call => call.pathname.includes('/commands/') || call.pathname.endsWith('/edits'));
    assert.deepEqual(recovery.map(call => call.method), ['GET', 'POST'], 'explicit retry must check again before sending');
    const posts = edits(h, run.id); assert.equal(posts.length, 2); assert.equal(posts[1]!.body, posts[0]!.body, 'retry must send the exact original serialized body');
    assert.deepEqual(JSON.parse(posts[1]!.body!), original);
    assert.equal(delivered(run.id).length, 1); assert.equal(await json(page), newerText);
  });

  for (const operation of ['preview', 'rebase', 'readLatest', 'apply'] as const) await scenario(`late run A ${operation} response cannot change run B`, async h => {
    const { page } = h, runA = await create(h), runB = await create(h);
    const readsPlan = operation === 'readLatest' || operation === 'rebase';
    controls.get(runA.id)!.mode = 'applied'; await select(h, runA.id); await openPlan(page);
    await page.locator('[data-plan-objective]').fill(`Run A ${operation} proposal`);
    if (operation === 'apply') await preview(page);
    const originalA = await json(page), idA = (await proposal(page)).id;
    const received = deferred(), release = deferred(), completed = deferred();
    const target = `/api/runs/${runA.id}/${readsPlan ? 'observation' : operation === 'preview' ? 'edits/preview' : 'edits'}`;
    h.effect = async route => {
      if (new URL(route.request().url()).pathname !== target || route.request().method() !== (readsPlan ? 'GET' : 'POST')) return false;
      const response = await route.fetch(); assert.equal(response.status(), 200); received.resolve();
      await release.promise; await route.fulfill({ response }); completed.resolve(); return true;
    };
    try {
      await page.locator(operation === 'rebase' ? '[data-plan-rebase]' : operation === 'readLatest' ? '[data-plan-current]' : operation === 'preview' ? '[data-plan-preview]' : '[data-plan-apply]').click();
      await received.promise; assert.equal(await page.locator('[data-plan-objective]').isDisabled(), true);
      if (readsPlan) {
        const control = controls.get(runA.id)!; control.observation.plan!.baseVersion = 'run-A-newer-plan';
        control.observation.inspection.planVersion = 'run-A-newer-plan'; control.emit(); await poll(page);
        await page.locator('[data-plan-versions]').getByText('run-A-newer-plan', { exact: true }).waitFor();
      }
      await closePlan(page); await select(h, runB.id); await openPlan(page);
      assert.equal(await page.locator('[data-plan-objective]').isDisabled(), false, 'another run must remain editable while A is pending');
      await page.locator('[data-plan-objective]').fill(`Run B local draft during ${operation}`);
      const beforeB = await json(page); release.resolve(); await completed.promise; await settled(page);
      assert.equal(await json(page), beforeB, 'late A response must not replace B full JSON');
      assert.equal(await page.locator('[data-plan-objective]').isDisabled(), false);
      assert.equal(await page.locator(`${receipt} > :not([data-decision-summary])`).count(), 0, 'A receipt must not appear beside B’s own plan summary');
      assert.equal(await page.locator('[data-plan-comparison]').textContent(), '', 'A comparison must not appear in B');
      await page.locator('[data-plan-type]').fill('True ∧ True'); const editedB = await json(page);
      await closePlan(page); await select(h, runA.id); await openPlan(page);
      await page.locator('[data-plan-objective]:enabled').waitFor();
      if (operation === 'rebase') {
        const rebased = await proposal(page), original = JSON.parse(originalA) as WebPlanProposal;
        assert.equal(rebased.baseVersion, 'run-A-newer-plan', 'a late rebase must use the newest observation already saved for A');
        assert.notEqual(rebased.id, original.id);
        assert.deepEqual({ ...rebased, id: original.id, baseVersion: original.baseVersion }, original, 'rebasing must retain A full local proposal');
        await page.locator(receipt).getByText(new RegExp(`回执 ${rebased.id} · 已校验`)).waitFor();
        assert.equal(await page.locator('[data-plan-apply]').isEnabled(), true, 'the rebased preview must be usable on return');
      } else assert.equal(await json(page), originalA, 'A must retain its own draft after completion');
      if (readsPlan) {
        await page.locator('[data-plan-comparison]').getByText('当前服务器计划 · 本地草稿保留', { exact: true }).waitFor();
        await page.locator('[data-plan-versions]').getByText('run-A-newer-plan', { exact: true }).last().waitFor();
        const comparison = JSON.parse((await page.locator('[data-plan-comparison] pre').textContent())!);
        assert.equal(comparison.baseVersion, 'run-A-newer-plan', 'a late read cannot rewind A saved server plan');
      } else {
        await page.locator(receipt).getByText(new RegExp(`回执 ${idA} · ${operation === 'apply' ? '已应用' : '已校验'}`)).waitFor();
        if (operation === 'preview') assert.equal(await page.locator('[data-plan-apply]').isDisabled(), false);
      }
      await closePlan(page); await select(h, runB.id); await openPlan(page); assert.equal(await json(page), editedB);
    } finally { release.resolve(); }
  });

  for (const width of [375, 320]) await scenario(`pending receipt and retry controls fit ${width}px`, async h => {
    const { page } = h, run = await create(h); await openPlan(page);
    await page.locator('[data-plan-objective]').fill('Review the original pending snapshot on a narrow screen'); await preview(page);
    const original = await proposal(page);
    h.effect = async route => {
      if (route.request().method() !== 'POST' || new URL(route.request().url()).pathname !== `/api/runs/${run.id}/edits`) return false;
      await route.abort(); return true;
    };
    await page.locator('[data-plan-apply]').click(); await page.locator(`${retry}:enabled`).waitFor();
    await page.locator('[data-plan-objective]').fill('A newer local draft remains editable on mobile');
    await page.locator(receipt).getByText('待核对的原提交', { exact: true }).click();
    assert.deepEqual(JSON.parse((await page.locator(`${receipt} pre`).textContent())!), original);
    await page.locator(receipt).scrollIntoViewIfNeeded();
    await fitViewport(page, '.collab-plan-dialog', 'pending editor must not widen the mobile document', true);
    await fitViewport(page, '.collab-dialog-footer', 'pending footer must fit the mobile document', true);
    for (const selector of [refresh, retry, '[data-plan-current]', '[data-plan-rebase]', '[data-plan-preview]', '[data-plan-apply]', '[data-plan-close]'])
      await fitViewport(page, selector, `${selector} must remain reachable on mobile`, true);
    assert.equal(await page.locator('.collab-plan-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.screenshot({ path: path.join(output, `pending-${width}.png`) });
    assert.equal(edits(h, run.id).length, 1); assert.equal(delivered(run.id).length, 0);
  }, width);

  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined, 'local-real-http-plan-recovery',
    { checks: suite.checks, commands: commands.map(item => ({ runId: item.runId, type: item.command.type })),
      screenshots: ['pending-375.png', 'pending-320.png'] }, { credential: input.apiKey });
  console.log('Plan recovery browser checks passed');
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-plan-recovery',
    { checks: suite.checks }, { credential: input.apiKey, failureRequests: true }); throw error;
} finally {
  for (const control of controls.values()) control.finish(); await browser.close(); await service.close();
}
