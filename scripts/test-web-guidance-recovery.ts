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
import type { WebCommand, WebGuidanceInput, WebGuidanceRecord, WebObservation } from '../apps/web/collaboration';
import { refreshHistory, selectHistoryRun, showArtifacts } from './web-ui-controls';
import { deferred, freePort, postRun, settled, startBrowser, webScenario, writeScenarioReport,
  type ScenarioHarness, type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-guidance-recovery');
await fs.mkdir(output, { recursive: true });
const now = () => new Date().toISOString(), digest = (character: string) => character.repeat(64);
type Control = { observation: WebObservation; mode: 'unknown' | 'queued' | 'stale'; emit(observedAt?: string): void; finish(): void };
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
      problem: { id: 'guidance-recovery-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [],
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
function hostReceipt(runId: string, guidance: WebGuidanceInput, status: WebGuidanceRecord['status']) {
  const control = controls.get(runId)!;
  const record: WebGuidanceRecord = { ...structuredClone(guidance), status, createdAt: now(), updatedAt: now(),
    ...(status === 'delivered' ? { deliveredTo: ['prover-1'] } : {}),
    ...(status === 'failed' ? { reason: 'math_guidance_task_superseded' } : {}) };
  control.observation.guidance = [...control.observation.guidance.filter(item => item.id !== record.id), record];
  control.emit(); return record;
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local guidance recovery HTTP fixture' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), mode: 'unknown', finish: resolve,
        emit(observedAt = now()) { this.observation = { ...this.observation, sequence: this.observation.sequence + 1, observedAt };
          send({ type: 'observation', observation: structuredClone(this.observation) }); } };
      controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true }); control.emit();
    });
  },
  async command(runId, command) {
    commands.push({ runId, command: structuredClone(command) });
    const control = controls.get(runId)!;
    if (command.type !== 'guidance') throw new Error('Guidance recovery must not send other commands');
    if (control.mode === 'stale') return { id: command.guidance.id, status: 'rejected', reason: 'math_guidance_task_superseded' };
    if (control.mode === 'unknown') return { id: command.guidance.id, status: 'unknown', reason: 'fixture_delivery_uncertain' };
    const guidance = hostReceipt(runId, command.guidance, 'queued');
    return { id: guidance.id, status: guidance.status, guidance };
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-local-guidance-recovery-fixture', model: 'fixture', effort: 'low',
  environment: 'standard', source: 'theorem original_goal : True := by sorry\n', task: 'Inspect human guidance recovery',
  maxTurns: 2, maxRunSeconds: 60, workers: 2, coordination: 'cooperative' };
const text = '[data-guidance-text]', kind = '[data-guidance-kind]', target = '[data-guidance-target]';
const pending = '[data-guidance-pending]', refresh = '[data-guidance-receipt-refresh]', retry = '[data-guidance-retry]';
const context = '[data-guidance-context]', confirm = '[data-guidance-confirm-version]', notice = '[data-guidance-notice]';
const submit = '[data-collab-guidance-form] button[type="submit"]';
const posts = (h: Harness, id: string) => h.calls.filter(call => call.method === 'POST' && call.pathname === `/api/runs/${id}/guidance`);
const reads = (h: Harness, id: string) => h.calls.filter(call => call.method === 'GET' && call.pathname.startsWith(`/api/runs/${id}/commands/`));
const delivered = (id: string) => commands.filter(item => item.runId === id && item.command.type === 'guidance');
const original = (h: Harness, id: string) => JSON.parse(posts(h, id)[0]!.body!) as WebGuidanceInput;
async function draft(page: Page) { return { text: await page.locator(text).inputValue(), kind: await page.locator(kind).inputValue(), target: await page.locator(target).inputValue() }; }
async function select(h: Harness, id: string) {
  await selectHistoryRun(h.page, id); await h.page.locator('.collab-surface').waitFor();
  await h.page.locator('[data-collab-task="base"]:visible').first().waitFor();
}
async function create(h: Harness) {
  const run = await postRun(h, input); h.runIds.push(run.id);
  await refreshHistory(h.page); await select(h, run.id); return run;
}
async function guideTask(page: Page, id = 'base') {
  await page.locator(`[data-collab-task="${id}"]:visible`).first().click();
  await page.locator('[data-collab-guide-task]').click();
  await page.locator(context).filter({ hasText: `${id}-v1` }).waitFor();
}
async function workerDraft(page: Page, value: string) {
  await page.locator(text).fill(value); await page.locator(kind).selectOption('worker'); await page.locator(target).selectOption('prover-1');
}
async function poll(page: Page) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'GET');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await response; await settled(page);
}
async function pendingOriginal(page: Page, guidance: WebGuidanceInput) {
  assert.equal(await page.locator(pending).isVisible(), true);
  assert.deepEqual(JSON.parse((await page.locator(`${pending} pre`).textContent())!), guidance, 'pending guidance preserves its exact original snapshot');
}
function scenario(name: string, run: (h: Harness) => Promise<void>, width = 1440) {
  return webScenario(browser, suite, name, run, {
    context: { viewport: { width, height: width > 850 ? 1000 : 812 }, reducedMotion: 'reduce' },
    harness: (page, browserContext) => {
      const h: Harness = { page, context: browserContext, requests: [], runIds: [], calls: [] };
      h.intercept = async route => {
        const pathname = new URL(route.request().url()).pathname;
        h.calls.push({ method: route.request().method(), pathname,
          body: pathname.endsWith('/guidance') ? route.request().postData() : null });
        return await h.effect?.(route) ?? false;
      }; return h;
    }, routes: { local: 'Guidance recovery browser checks must stay local' }, open: true,
    timeout: { label: 'Guidance recovery', seconds: 45 },
    verify: (h, elapsedMs) => ({ name, elapsedMs: elapsedMs(), calls: h.calls, runIds: h.runIds }),
    cleanup: h => { for (const id of h.runIds) controls.get(id)?.finish(); },
  });
}

try {
  await scenario('receipt observations update the whole workbench before a delayed older list returns', async h => {
    const { page } = h, run = await create(h); await guideTask(page);
    await page.locator(text).fill('Original guidance awaiting a host receipt'); await page.locator(submit).click();
    await page.locator(`${refresh}:enabled`).waitFor(); const sent = original(h, run.id);
    await page.locator(text).fill('A newer draft must survive the receipt and stale list');
    const held = deferred(), release = deferred(), control = controls.get(run.id)!;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    h.effect = async route => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET') return false;
      if (url.pathname === '/api/runs') {
        const headers = route.request().headers(); delete headers['if-none-match'];
        const response = await route.fetch({ headers }); held.resolve(); await release.promise;
        await route.fulfill({ response }); return true;
      }
      if (url.pathname === `/api/runs/${run.id}/commands/${sent.id}`) {
        control.observation.inspection.tasks.find(task => task.id === 'base')!.owner = 'prover-1';
        hostReceipt(run.id, sent, 'delivered'); control.emit(future);
      }
      return false;
    };
    const oldList = page.waitForResponse(r => new URL(r.url()).pathname === '/api/runs' && r.request().method() === 'GET');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await held.promise;
    try {
      await page.locator(refresh).click(); await page.locator(pending).waitFor({ state: 'hidden' });
      const sequence = control.observation.sequence;
      await page.waitForFunction(sequence => document.querySelector('[data-collab-observation]')?.textContent?.includes(`观察 #${sequence} ·`), sequence);
      const updated = await page.evaluate(at => `更新 ${new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(at))}`, future);
      assert.equal(await page.locator('.updated-at').innerText(), updated, 'receipt also updates the app run cache and header');
      assert.match(await page.locator('.collab-graph [data-collab-task="base"]').innerText(), /prover-1/);
      release.resolve(); await oldList; await settled(page);
      assert.equal(await page.locator('.updated-at').innerText(), updated, 'late list cannot rewind the app observation timestamp');
      assert.match(await page.locator('[data-collab-observation]').innerText(), new RegExp(`观察 #${sequence} ·`));
      assert.equal(await page.locator(text).inputValue(), 'A newer draft must survive the receipt and stale list');
      assert.equal(posts(h, run.id).length, 1); assert.equal(delivered(run.id).length, 1);
      assert.equal(h.requests.some(r => r.pathname.endsWith('/observation')), false, 'receipt synchronization needs no second observation request');
    } finally { release.resolve(); h.effect = undefined; }
  });

  for (const status of ['delivered', 'failed'] as const) await scenario(`unknown guidance becomes ${status} and keeps the newer draft`, async h => {
    const { page } = h, run = await create(h); await guideTask(page);
    await page.locator(text).fill(`Original human guidance before ${status}`); await page.locator(submit).click();
    await page.locator(`${refresh}:enabled`).waitFor(); const sent = original(h, run.id);
    assert.equal(reads(h, run.id).length, 1, 'unknown response must automatically read its stable command receipt');
    assert.equal(await page.locator(retry).isHidden(), true);
    await workerDraft(page, `New local draft during ${status}`); const newer = await draft(page);
    await pendingOriginal(page, sent); assert.equal(await page.locator(submit).isDisabled(), true);
    await page.locator(refresh).click(); await page.locator(`${refresh}:enabled`).waitFor();
    assert.equal(posts(h, run.id).length, 1, 'manual receipt check must remain read-only');
    h.effect = async route => {
      if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === `/api/runs/${run.id}/commands/${sent.id}`)
        hostReceipt(run.id, sent, status);
      return false;
    };
    await page.locator(refresh).click();
    await page.locator(pending).waitFor({ state: 'hidden' }); await page.locator(`${submit}:enabled`).waitFor();
    assert.deepEqual(await draft(page), newer); assert.equal(posts(h, run.id).length, 1); assert.equal(delivered(run.id).length, 1);
    assert.ok(reads(h, run.id).every(call => call.pathname.endsWith(`/${sent.id}`)));
    await page.locator('.collab-guidance-record').filter({ hasText: sent.text }).waitFor();
  });

  await scenario('lost accepted POST response is recovered by a command GET without a second write', async h => {
    const { page } = h, run = await create(h); controls.get(run.id)!.mode = 'queued'; await guideTask(page);
    await page.locator(text).fill('Persisted human guidance with a lost response');
    const received = deferred(), release = deferred();
    h.effect = async route => {
      if (route.request().method() !== 'POST' || new URL(route.request().url()).pathname !== `/api/runs/${run.id}/guidance`) return false;
      const response = await route.fetch(); assert.equal(response.status(), 200); received.resolve();
      await release.promise; await route.abort(); return true;
    };
    try { await page.locator(submit).click(); await received.promise; assert.equal(delivered(run.id).length, 1); }
    finally { release.resolve(); }
    await page.locator(`${submit}:enabled`).waitFor(); await page.locator(pending).waitFor({ state: 'hidden' });
    assert.equal(await page.locator(text).inputValue(), '');
    assert.equal(posts(h, run.id).length, 1); assert.equal(reads(h, run.id).length, 1); assert.equal(delivered(run.id).length, 1);
  });

  await scenario('missing guidance retries the exact original input after a second GET and keeps new edits', async h => {
    const { page } = h, run = await create(h); await guideTask(page);
    await page.locator(text).fill('Original task-bound guidance before abort'); let aborted = false;
    h.effect = async route => {
      if (aborted || route.request().method() !== 'POST' || new URL(route.request().url()).pathname !== `/api/runs/${run.id}/guidance`) return false;
      aborted = true; await route.abort(); return true;
    };
    await page.locator(submit).click(); await page.locator(`${retry}:enabled`).waitFor(); const sent = original(h, run.id);
    assert.equal(delivered(run.id).length, 0); assert.equal(reads(h, run.id).length, 1);
    await workerDraft(page, 'Newer guidance is separate from the original pending command'); const newer = await draft(page);
    await pendingOriginal(page, sent); controls.get(run.id)!.mode = 'queued'; const before = h.calls.length;
    await page.locator(retry).click(); await page.locator(pending).waitFor({ state: 'hidden' });
    await page.locator(`${submit}:enabled`).waitFor();
    const recovery = h.calls.slice(before).filter(call => call.pathname.includes('/commands/') || call.pathname.endsWith('/guidance'));
    assert.deepEqual(recovery.map(call => call.method), ['GET', 'POST']);
    assert.equal(posts(h, run.id).length, 2); assert.equal(posts(h, run.id)[1]!.body, posts(h, run.id)[0]!.body);
    assert.deepEqual(JSON.parse(posts(h, run.id)[1]!.body!), sent);
    assert.deepEqual(await draft(page), newer); assert.equal(delivered(run.id).length, 1);
  });

  for (const missing of [false, true]) await scenario(`receipt read failures cannot resend ${missing ? 'missing' : 'unknown'} guidance`, async h => {
    const { page } = h, run = await create(h); await guideTask(page);
    await page.locator(text).fill('Read errors must not send another guidance command');
    if (missing) h.effect = async route => {
      if (route.request().method() !== 'POST' || new URL(route.request().url()).pathname !== `/api/runs/${run.id}/guidance`) return false;
      await route.abort(); return true;
    };
    await page.locator(submit).click(); await page.locator(`${missing ? retry : refresh}:enabled`).waitFor();
    const sent = original(h, run.id), before = posts(h, run.id).length;
    h.effect = async route => {
      if (route.request().method() !== 'GET' || !new URL(route.request().url()).pathname.startsWith(`/api/runs/${run.id}/commands/`)) return false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_receipt_temporarily_unavailable' }) }); return true;
    };
    await page.locator(missing ? retry : refresh).click(); await page.locator(`${refresh}:enabled`).waitFor();
    assert.equal(posts(h, run.id).length, before); await pendingOriginal(page, sent);
    assert.equal(await page.locator(retry).isHidden(), true, 'a failed read does not prove that the command is missing');
    h.effect = async route => {
      if (route.request().method() !== 'GET' || !new URL(route.request().url()).pathname.startsWith(`/api/runs/${run.id}/commands/`)) return false;
      await route.abort(); return true;
    };
    await page.locator(refresh).click(); await page.locator(`${refresh}:enabled`).waitFor();
    assert.equal(posts(h, run.id).length, before); await pendingOriginal(page, sent);
  });

  await scenario('unsent task guidance keeps its observed version until the human confirms the new version', async h => {
    const { page } = h, run = await create(h); controls.get(run.id)!.mode = 'queued'; await guideTask(page);
    await page.locator(text).fill('Guidance written against the original base task'); const before = await draft(page);
    const control = controls.get(run.id)!, task = control.observation.inspection.tasks.find(task => task.id === 'base')!;
    task.version = 'base-v2'; task.type = 'True ∧ True'; control.observation.plan!.baseVersion = 'plan-v2';
    control.emit(); await poll(page);
    await page.locator(`${confirm}:visible`).waitFor(); assert.deepEqual(await draft(page), before);
    assert.ok((await page.locator(context).innerText()).includes('base-v1')); assert.ok((await page.locator(context).innerText()).includes('base-v2'));
    assert.equal(await page.locator(submit).isDisabled(), true); assert.equal(posts(h, run.id).length, 0);
    await page.locator(confirm).click(); await page.locator(`${submit}:enabled`).waitFor();
    assert.deepEqual(await draft(page), before); await page.locator(submit).click(); await page.locator(`${submit}:enabled`).waitFor();
    assert.equal(original(h, run.id).taskRef!.version, 'base-v2'); assert.equal(original(h, run.id).text, before.text);
  });

  await scenario('task deletion preserves the selected target and prevents silent retargeting', async h => {
    const { page } = h, run = await create(h); await guideTask(page);
    await page.locator(text).fill('Guidance must remain attached to the removed target');
    const control = controls.get(run.id)!; control.observation.inspection.tasks = control.observation.inspection.tasks.filter(task => task.id !== 'base');
    control.observation.plan!.tasks = control.observation.plan!.tasks.filter(task => task.id !== 'base'); control.emit(); await poll(page);
    assert.equal(await page.locator(target).inputValue(), 'base'); assert.equal(await page.locator(submit).isDisabled(), true);
    assert.equal(await page.locator(text).inputValue(), 'Guidance must remain attached to the removed target');
    assert.equal(posts(h, run.id).length, 0);
  });

  await scenario('late guidance response preserves another recipient draft and another run', async h => {
    const { page } = h, runA = await create(h), runB = await create(h); controls.get(runA.id)!.mode = 'queued';
    await select(h, runA.id); await guideTask(page); await page.locator(text).fill('Same text retained when the recipient changes');
    const received = deferred(), release = deferred(), completed = deferred();
    h.effect = async route => {
      if (route.request().method() !== 'POST' || new URL(route.request().url()).pathname !== `/api/runs/${runA.id}/guidance`) return false;
      const response = await route.fetch(); assert.equal(response.status(), 200); received.resolve();
      await release.promise; await route.fulfill({ response }); completed.resolve(); return true;
    };
    try {
      await page.locator(submit).click(); await received.promise;
      await workerDraft(page, 'Same text retained when the recipient changes'); const newerA = await draft(page);
      await select(h, runB.id); await guideTask(page, 'original'); await page.locator(text).fill('Independent unsent research B guidance');
      const beforeB = await draft(page); assert.equal(await page.locator(submit).isDisabled(), false);
      release.resolve(); await completed.promise; await settled(page);
      assert.deepEqual(await draft(page), beforeB); assert.equal(await page.locator(notice).textContent(), '');
      assert.equal(await page.locator(pending).isHidden(), true); assert.equal(posts(h, runB.id).length, 0);
      await select(h, runA.id); await page.locator(`${submit}:enabled`).waitFor(); assert.deepEqual(await draft(page), newerA);
      await select(h, runB.id); assert.deepEqual(await draft(page), beforeB);
    } finally { release.resolve(); }
  });

  await scenario('an explicit runtime task-version rejection resolves the pending command', async h => {
    const { page } = h, run = await create(h); controls.get(run.id)!.mode = 'stale'; await guideTask(page);
    await page.locator(text).fill('Version changed between browser submission and runtime validation');
    await page.locator(submit).click(); await page.locator(`${submit}:enabled`).waitFor();
    await page.locator(pending).waitFor({ state: 'hidden' });
    assert.equal(await page.locator(text).inputValue(), 'Version changed between browser submission and runtime validation');
    assert.ok((await page.locator(notice).textContent())!.includes('math_guidance_task_superseded'));
    assert.equal(posts(h, run.id).length, 1); assert.equal(delivered(run.id).length, 1);
  });

  for (const width of [375, 320]) await scenario(`pending guidance snapshot and recovery controls fit ${width}px`, async h => {
    const { page } = h, run = await create(h); await guideTask(page);
    await page.locator(text).fill('An original pending human instruction on a narrow screen');
    h.effect = async route => {
      if (route.request().method() !== 'POST' || new URL(route.request().url()).pathname !== `/api/runs/${run.id}/guidance`) return false;
      await route.abort(); return true;
    };
    await page.locator(submit).click(); await page.locator(`${retry}:enabled`).waitFor();
    await page.locator(text).fill('A newer editable draft while the original command awaits recovery');
    await pendingOriginal(page, original(h, run.id)); await showArtifacts(page);
    const summary = page.locator(`${pending} summary`); if (await summary.count()) await summary.click();
    await page.locator(refresh).scrollIntoViewIfNeeded();
    for (const selector of [pending, refresh, retry, context, text, submit]) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1, `${selector} must fit ${width}px: ${JSON.stringify(box)}`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    for (const selector of [refresh, retry]) {
      const box = await page.locator(selector).boundingBox(); assert.ok(box && box.y >= -1 && box.y + box.height <= 813, `${selector} remains visible after scrolling`);
    }
    await page.screenshot({ path: path.join(output, `pending-${width}.png`) });
    assert.equal(posts(h, run.id).length, 1); assert.equal(delivered(run.id).length, 0);
  }, width);

  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined, 'local-real-http-guidance-recovery',
    { checks: suite.checks, commands: commands.map(item => ({ runId: item.runId, type: item.command.type })),
      screenshots: ['pending-375.png', 'pending-320.png'] }, { credential: input.apiKey });
  console.log('Guidance recovery browser checks passed');
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-guidance-recovery',
    { checks: suite.checks }, { credential: input.apiKey, failureRequests: true }); throw error;
} finally {
  for (const control of controls.values()) control.finish(); await browser.close(); await service.close();
}
