#!/usr/bin/env bun
// Project plan approval recovery regressions. Local fake observations/checks only; no models, Lean or real mail.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page, Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebInspection, WebObservation } from '../apps/web/collaboration';
import type { ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import type { WebRun, WorkerMessage } from '../apps/web/shared';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/frontend-round3/collaboration/validation');
await fs.access(path.join(root, 'out/web/research.js')).catch(() => { throw new Error('Run bun run build:web before the collaboration check.'); });
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round3-collaboration-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const now = () => new Date().toISOString(), hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const source = 'theorem research_fixture : True := by sorry';
const evidence: Record<string, unknown> = {}, commands: unknown[] = [];
type Control = { observation: WebObservation; emit(): void };
const controls = new Map<string, Control>();
const errors: string[] = [], external: string[] = [], mail: unknown[] = [];
let approvalMode: 'approved' | 'queued' | 'unknown' = 'approved';
let browser: Browser | undefined, page: Page | undefined, failure: unknown;

function observation(id: string): WebObservation {
  const tasks = [{ id: 'lemma', kind: 'lemma' as const, objective: 'Prove a supporting fact', dependsOn: [], revision: 0, theoremName: 'supporting_fact', proofPath: 'Main.lean', type: 'True' },
    { id: 'goal', kind: 'goal' as const, objective: 'Prove the original statement', dependsOn: ['lemma'], revision: 0, theoremName: 'research_fixture', proofPath: 'Main.lean', type: 'True' }];
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `fixture-${id}`, stateDigest: hash('initial'), resultDigest: null };
  const inspection: WebInspection = { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
    problem: { id: 'round2-browser-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'research_fixture', proofPath: 'Main.lean' }] },
    configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative', buildDigest: hash('build'), environmentDigest: hash('environment') }, turns: 1, planVersion: 'fixture-plan-v1',
    scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
    knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded', droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] },
    tokenBudget: {}, continuation: {}, mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: hash('math'), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
    progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['lemma', 'goal'] }, groups: [],
    tasks: tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective, group: 'main', status: 'pending', control: 'active', version: `${task.id}-v1`, theorem: task.theoremName, type: task.type,
      premises: [], plannedDependencies: task.dependsOn, attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })), workers: [], statementReviews: [], edits: [], planApproval: { required: true, status: 'pending', planVersion: 'fixture-plan-v1', requestedAt: Date.now(), rejections: [], leadRevising: false } };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1, evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, inspection,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'fixture-plan-v1', tasks }, sources: tasks.map(task => ({ scope: 'owned-file', taskId: task.id, taskVersion: `${task.id}-v1`, commit: '1'.repeat(40),
      sourceDigest: hash(source), environmentDigest: hash('environment'), file: 'Main.lean', source })), checks: [], guidance: [], coverage: { sources: 'partial', checks: 'partial' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable collaboration browser fixture' }; },
  async run(input, send: (message: WorkerMessage) => void, signal) {
    await new Promise<void>(resolve => {
      const control = { observation: observation(input.id), emit() {
        this.observation.sequence++; this.observation.observedAt = now(); this.observation.snapshot.stateDigest = hash(`state-${this.observation.sequence}`);
        this.observation.inspection.snapshot.stateDigest = this.observation.snapshot.stateDigest;
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      controls.set(input.id, control); control.emit(); signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  async command(id, command) {
    const control = controls.get(id)!;
    if (command.type === 'capture') return { id: 'capture', status: 'captured', observation: structuredClone(control.observation) };
    if (command.type === 'guidance-withdraw') return { id: command.id, status: 'rejected', reason: 'fixture_guidance_withdraw_not_simulated' };
    commands.push(structuredClone(command));
    if (command.type === 'plan-approval') {
      const approval = control.observation.inspection.planApproval!;
      if (command.approval.planVersion !== approval.planVersion) return { id: command.approval.id, status: 'rejected', reason: 'math_plan_approval_version_conflict' };
      if (approvalMode !== 'approved') return { id: command.approval.id, status: approvalMode, reason: approvalMode === 'unknown' ? 'fixture_command_outcome_unconfirmed' : undefined };
      Object.assign(approval, { status: 'approved', approvedId: command.approval.id, approvedVersion: command.approval.planVersion, approvedAt: Date.now() });
      control.emit(); return { id: command.approval.id, status: 'queued', observation: structuredClone(control.observation) };
    }
    return { id: command.type === 'guidance' ? command.guidance.id : command.proposal.id, status: 'queued' };
  },

};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner,
{ sample: null, mailer: async message => { mail.push(message); throw new Error('The collaboration fixture never sends email'); } });

async function http<T>(method: string, pathname: string, input?: unknown): Promise<T> {
  return page!.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const payload = await response.json(); if (!response.ok) throw new Error(`Fixture HTTP ${response.status}: ${payload.error}`); return payload;
  }, { method, pathname, input }) as Promise<T>;
}
function response(method: string, pathname: string, target = page!) {
  return target.waitForResponse(reply => reply.request().method() === method && new URL(reply.url()).pathname === pathname);
}

try {
  browser = await startBrowser(service.server, port);
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
  });
  context.on('page', opened => { opened.setDefaultTimeout(10_000); opened.on('pageerror', error => errors.push(error.message)); });
  page = await context.newPage(); await page.goto(`${origin}/theorems.html`); await page.getByRole('heading', { name: '定理', exact: true }).waitFor();
  let project = (await http<{ item: ResearchProjectDetail }>('POST', '/api/research/theorems', { requestId: crypto.randomUUID(), title: 'Round 3 collaboration fixture', description: 'Disposable local browser audit', fields: ['logic'], visibility: 'private' })).item;
  const projectPath = `/api/research/theorems/${project.id}`, feedbackPath = `${projectPath}/feedback`;
  project = (await http<{ item: ResearchProjectDetail }>('POST', `${projectPath}/versions`, { requestId: crypto.randomUUID(), expectedRevision: project.revision,
    statement: 'Prove True.', source, environment: 'standard', confirmation: { confirmed: true } })).item;
  const version = project.currentStatementVersionId!;
  const run = (await http<{ run: WebRun }>('POST', '/api/runs', { requestId: crypto.randomUUID(), providerId: 'openai', apiKey: 'sk-disposable-collaboration-fixture', model: 'fixture', effort: 'low', environment: 'standard',
    source, task: 'Round 3 fake observation fixture', maxTurns: 2, maxRunSeconds: 300, workers: 2, coordination: 'cooperative', planApproval: true })).run;
  for (let attempt = 0; attempt < 100 && !controls.has(run.id); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(controls.has(run.id)); project = (await http<{ item: ResearchProjectDetail }>('GET', projectPath)).item;
  await http('POST', `${projectPath}/runs`, { requestId: crypto.randomUUID(), expectedRevision: project.revision, runId: run.id, statementVersionId: version, exposure: 'members', grants: { approve: true, guidance: true, edit: true, proof: true } });
  const url = `${origin}/theorems.html?id=${project.id}&version=${version}&run=${run.id}`;
  await page.goto(url);
  const approve = page.getByRole('button', { name: '批准此版本并继续研究', exact: true }); await approve.waitFor();
  const approvalRequests: unknown[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === feedbackPath) approvalRequests.push(request.postDataJSON()); });
  const control = controls.get(run.id)!;
  const race = async (route: Route) => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().kind === 'plan-approval') {
      control.observation.plan!.baseVersion = 'fixture-plan-v2';
      control.observation.inspection.planVersion = 'fixture-plan-v2';
      control.observation.inspection.planApproval!.planVersion = 'fixture-plan-v2';
      control.emit();
    }
    await route.continue();
  };
  await page.route('**' + feedbackPath, race);
  const rejected = response('POST', feedbackPath); await approve.click(); const first = await rejected;
  assert.equal(first.status(), 409);
  const firstBody = first.request().postDataJSON(); assert.equal(firstBody.planVersion, 'fixture-plan-v1');
  await page.unroute('**' + feedbackPath, race);
  const pending = page.locator('.research-publication').filter({ hasText: '等待批准计划：' });
  await page.waitForFunction(() => [...document.querySelectorAll('.research-publication')].some(node => node.textContent?.includes('等待批准计划：fixture-plan-v2')), undefined, { timeout: 15000 });
  const review = page.getByRole('button', { name: '改为核对当前计划', exact: true }); await review.waitFor();
  assert.ok((await pending.innerText()).includes('原批准版本：fixture-plan-v1'));
  assert.equal(await page.getByRole('button', { name: '重试原计划批准', exact: true }).count(), 0, 'A rejected old plan is not offered as an endless retry');
  const stored = (await http<{ item: ResearchProjectDetail }>('GET', projectPath)).item;
  assert.equal(stored.feedback.filter(item => item.kind === 'plan-approval').length, 0, 'The 409 did not save an approval');
  const requestCount = () => approvalRequests.length;
  const before = requestCount(); await review.click(); assert.equal(requestCount(), before, 'Reviewing the new plan does not approve it');
  await approve.waitFor(); const fresh = response('POST', feedbackPath); await approve.click(); const accepted = await fresh;
  assert.ok(accepted.ok()); assert.equal(accepted.request().postDataJSON().planVersion, 'fixture-plan-v2');
  assert.notEqual(accepted.request().postDataJSON().requestId, firstBody.requestId, 'A reviewed new version owns a new request ID');
  assert.equal(commands.length, 1);
  evidence.definitiveRejection = { first: { status: first.status(), body: firstBody }, recovered: { status: accepted.status(), body: accepted.request().postDataJSON() } };
  console.log('PASS definitive 409 keeps the old identity visible and lets the current plan be reviewed and approved without reload');

  const reset = (version: string) => {
    control.observation.plan!.baseVersion = control.observation.inspection.planVersion = version;
    control.observation.inspection.planApproval = { required: true, status: 'pending', planVersion: version, requestedAt: Date.now(), rejections: [], leadRevising: false };
    control.emit();
  };
  reset('fixture-plan-v3'); await page.reload(); await approve.waitFor();
  let droppedBody: Record<string, unknown> | undefined;
  const unavailable = async (route: Route) => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().kind === 'plan-approval') {
      droppedBody = route.request().postDataJSON();
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Disposable approval transport outage' }) });
    } else await route.continue();
  };
  await page.route('**' + feedbackPath, unavailable);
  await approve.click(); const retry = page.getByRole('button', { name: '重试原计划批准', exact: true }); await retry.waitFor();
  await page.unroute('**' + feedbackPath, unavailable);
  assert.ok(droppedBody); assert.equal(droppedBody.planVersion, 'fixture-plan-v3');
  reset('fixture-plan-v4');
  await page.waitForFunction(() => document.querySelector('[data-project-plan-approval]')?.textContent?.includes('等待批准计划：fixture-plan-v4'), undefined, { timeout: 15000 });
  assert.ok((await pending.innerText()).includes('原批准版本：fixture-plan-v3'));
  assert.equal(await review.count(), 0, 'An unconfirmed request cannot be replaced with the latest version');
  const replayed = response('POST', feedbackPath); await retry.click(); const replay = await replayed;
  assert.equal(replay.status(), 409); assert.deepEqual(replay.request().postDataJSON(), droppedBody, 'Retry keeps the exact original request, target, observation and plan version');
  await review.waitFor(); await pending.screenshot({ path: path.join(output, 'rejected-original-and-current.png') });
  const afterReplay = requestCount(); await review.click(); assert.equal(requestCount(), afterReplay, 'Explicit review does not send a new approval');
  const v4 = response('POST', feedbackPath); await approve.click(); const approvedV4 = await v4;
  assert.ok(approvedV4.ok()); assert.equal(approvedV4.request().postDataJSON().planVersion, 'fixture-plan-v4');
  evidence.uncertainRetry = { dropped: droppedBody, replay: { status: replay.status(), body: replay.request().postDataJSON() }, recovered: { status: approvedV4.status(), body: approvedV4.request().postDataJSON() } };
  console.log('PASS uncertain failure pins the exact original request until receipt lookup or a definitive rejection');

  reset('fixture-plan-v5'); await page.reload(); await approve.waitFor();
  const commandsBefore = commands.length;
  let savedBody: Record<string, unknown> | undefined;
  const lostResponse = async (route: Route) => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().kind === 'plan-approval') {
      savedBody = route.request().postDataJSON();
      const received = await route.fetch(); assert.ok(received.ok());
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Disposable lost successful response' }) });
    } else await route.continue();
  };
  await page.route('**' + feedbackPath, lostResponse); await approve.click();
  await page.waitForFunction(() => !document.querySelector('[data-project-plan-approval]') || document.querySelector('[data-project-plan-approval]')?.textContent?.includes('批准已记录，等待运行确认。'));
  await page.unroute('**' + feedbackPath, lostResponse);
  const afterLost = (await http<{ item: ResearchProjectDetail }>('GET', projectPath)).item;
  const records = afterLost.feedback.filter(item => item.requestId === savedBody?.requestId);
  assert.equal(records.length, 1); assert.ok(['queued', 'delivered'].includes(records[0].delivery.status)); assert.equal(commands.length, commandsBefore + 1);
  assert.equal(await review.count(), 0); assert.equal(await retry.count(), 0, 'A saved successful approval is recovered from its record');
  evidence.lostSuccessResponse = { body: savedBody, savedRecords: records.length, deliveredCommands: commands.length - commandsBefore };
  console.log('PASS a lost successful response is recovered from the saved feedback and never sends a second approval');

  reset('fixture-plan-v6'); await page.reload(); await approve.waitFor(); approvalMode = 'unknown';
  const beforeUnknown = commands.length;
  const unknownResponse = response('POST', feedbackPath); await approve.click(); const unknown = await unknownResponse;
  assert.equal(unknown.status(), 201); assert.equal((await unknown.json()).item.delivery.status, 'unknown');
  const inspect = page.getByRole('button', { name: '核对原批准记录', exact: true }); await inspect.waitFor();
  const unknownInput = unknown.request().postDataJSON(), beforeUnknownReload = approvalRequests.length;
  await page.reload(); await inspect.waitFor();
  assert.equal(await pending.getAttribute('data-approval-request-id'), unknownInput.requestId, 'Reload restores the saved unknown request ID');
  assert.equal(approvalRequests.length, beforeUnknownReload, 'Reload never sends another approval');
  assert.equal(commands.length, beforeUnknown + 1);
  assert.equal(await approve.count(), 0); assert.equal(await retry.count(), 0); assert.equal(await review.count(), 0);
  for (let read = 0; read < 2; read++) {
    const checked = response('GET', feedbackPath); await inspect.click(); assert.ok((await checked).ok()); await inspect.waitFor({ state: 'visible' });
  }
  assert.equal(commands.length, beforeUnknown + 1, 'Receipt checks for HTTP 201 unknown do not dispatch a second approval');
  const unknownProject = (await http<{ item: ResearchProjectDetail }>('GET', projectPath)).item;
  const unknownRecord = unknownProject.feedback.filter(item => item.requestId === unknown.request().postDataJSON().requestId);
  assert.equal(unknownRecord.length, 1);
  evidence.unknownReload = { originalRequest: unknownInput, restoredRequestId: await pending.getAttribute('data-approval-request-id'), savedRecords: unknownRecord.length, commands: commands.length - beforeUnknown };
  await pending.screenshot({ path: path.join(output, 'unknown-approval-single-request.png') });
  Object.assign(control.observation.inspection.planApproval!, { status: 'approved', approvedId: unknownRecord[0].id, approvedVersion: 'fixture-plan-v6', approvedAt: Date.now() }); control.emit();
  const settled = response('GET', feedbackPath); await inspect.click(); assert.ok((await settled).ok());
  reset('fixture-plan-v7');
  await approve.waitFor({ timeout: 15000 }); approvalMode = 'queued';
  const queuedResponse = response('POST', feedbackPath); await approve.click(); const queued = await queuedResponse;
  assert.equal(queued.status(), 201); assert.equal((await queued.json()).item.delivery.status, 'queued'); await inspect.waitFor();
  const queuedInput = queued.request().postDataJSON(), beforeQueuedReload = approvalRequests.length;
  await page.reload(); await inspect.waitFor();
  assert.equal(await pending.getAttribute('data-approval-request-id'), queuedInput.requestId, 'Reload restores the queued approval instead of generating a new ID');
  assert.equal(approvalRequests.length, beforeQueuedReload);
  evidence.queuedReload = { originalRequest: queuedInput, restoredRequestId: await pending.getAttribute('data-approval-request-id'), additionalPosts: approvalRequests.length - beforeQueuedReload };
  assert.equal(await approve.count(), 0, 'A queued approval keeps the same pending plan from receiving a new request');
  const beforeQueuedCheck = commands.length;
  const queuedCheck = response('GET', feedbackPath); await inspect.click(); assert.ok((await queuedCheck).ok());
  assert.equal(commands.length, beforeQueuedCheck);
  await pending.screenshot({ path: path.join(output, 'queued-approval-awaits-run.png') });
  reset('fixture-plan-v8'); await approve.waitFor({ timeout: 15000 }); approvalMode = 'queued';
  const nextVersion = response('POST', feedbackPath); await approve.click(); const next = await nextVersion;
  assert.ok(next.ok()); assert.equal(next.request().postDataJSON().planVersion, 'fixture-plan-v8'); await inspect.waitFor();
  const rejectedRecord = (await next.json()).item;
  control.observation.inspection.planApproval!.rejections.push({ id: rejectedRecord.id, planVersion: 'fixture-plan-v8', reason: 'fixture_approval_rejected_after_queue', at: Date.now() }); control.emit();
  await review.waitFor({ timeout: 15000 });
  const beforeReviewingRejected = requestCount(); await review.click(); assert.equal(requestCount(), beforeReviewingRejected);
  approvalMode = 'approved'; const reviewedAgain = response('POST', feedbackPath); await approve.click(); const finalApproval = await reviewedAgain;
  assert.ok(finalApproval.ok()); assert.equal(finalApproval.request().postDataJSON().planVersion, 'fixture-plan-v8');
  assert.notEqual(finalApproval.request().postDataJSON().requestId, next.request().postDataJSON().requestId);
  evidence.unknownAndQueued = { unknownRequest: unknown.request().postDataJSON(), unknownSavedRecords: unknownRecord.length,
    queuedRequest: queued.request().postDataJSON(), nextPlan: next.request().postDataJSON() };
  console.log('PASS unknown and queued acknowledgments keep one request per pending plan; recorded approval, version progress or explicit host rejection resolves the original');
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(mail, []);

} catch (error) { failure = error; await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
} finally {
  await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'execution.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: now(), evidence,
    ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}), pageErrors: errors, externalRequests: external,
    realModelCalls: 0, realLeanCalls: 0, productionWrites: false, realMail: false, fixturesRemoved: true }, null, 2) + '\n');
}
