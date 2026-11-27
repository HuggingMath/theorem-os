#!/usr/bin/env bun
// Real HTTP + Chromium, with disposable data and deterministic approval receipts. No mathematical acceptance.
import { webAgentTeamPreset } from '../apps/web/researchMode';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebInspection, WebObservation } from '../apps/web/collaboration';
import type { ResearchFeedback, ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { freePort, preferFullCollaboration, settled, startBrowser } from './web-scenario';
import { mathDigest } from '../src/math/mathRuntimeIo';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/frontend-round8/approval');
await fs.access(path.join(root, 'out/web/research.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round8-approval-'));
const source = 'theorem approval_fixture : True := by sorry\n', now = () => new Date().toISOString();
type Control = { observation: WebObservation; mode: 'approved' | 'unknown'; emit(): void; finish(): void };
const controls = new Map<string, Control>(), commands: { runId: string; id: string; planVersion: string }[] = [];
const checks: object[] = [], errors: string[] = [], external: string[] = [], mail: unknown[] = [];
let phase = 'setup';
function observation(id: string): WebObservation {
  const tasks = [{ id: 'goal', kind: 'goal' as const, objective: '核对原题再开始证明', dependsOn: [], revision: 0, theoremName: 'approval_fixture', proofPath: 'Main.lean', type: 'True' }];
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: 'fixture-' + id, stateDigest: mathDigest('initial'), resultDigest: null };
  const inspection: WebInspection = { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'research',
    problem: { id: 'round8-approval-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'approval_fixture', proofPath: 'Main.lean' }] },
    configuration: { model: 'fixture', effort: 'low', workers: 1, coordination: 'independent', buildDigest: mathDigest('build'), environmentDigest: mathDigest('environment') }, turns: 1, planVersion: 'plan-v1',
    scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
    knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded', droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] },
    tokenBudget: {}, continuation: {}, mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: mathDigest('mathematics'), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
    progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['goal'] }, groups: [],
    tasks: tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective, group: 'main', status: 'pending', control: 'active', version: 'goal-v1', theorem: task.theoremName, type: task.type,
      premises: [], plannedDependencies: [], attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })), workers: [], statementReviews: [], edits: [],
    planApproval: { required: true, status: 'pending', planVersion: 'plan-v1', requestedAt: Date.now(), rejections: [], leadRevising: false } };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1, evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, inspection,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks }, sources: [], checks: [], guidance: [], coverage: { sources: 'partial', checks: 'partial' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, nativeTeam: true, message: 'Disposable project plan approval regression' }; },
  async check() { throw new Error('Approval regressions must not check or accept proofs'); },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), mode: 'approved', finish: resolve, emit() {
        this.observation.sequence++; this.observation.observedAt = now(); this.observation.snapshot.stateDigest = mathDigest('state-' + this.observation.sequence);
        this.observation.inspection.snapshot.stateDigest = this.observation.snapshot.stateDigest;
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      Object.assign(control.observation.inspection.configuration, { researchMode: 'skill',
        researchSkill: { name: 'theoremos-research', digest: mathDigest('fixture skill'), loading: 'native' },
        researchDelegation: { mode: 'team', maxAgents: input.input.nativeTeamCapacity } });
      controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true }); control.emit();
    });
  },
  async command(runId, command) {
    const control = controls.get(runId)!;
    if (command.type === 'capture') return { id: 'capture', status: 'captured', observation: structuredClone(control.observation) };
    if (command.type !== 'plan-approval') throw new Error('Unexpected command: ' + command.type);
    commands.push({ runId, ...command.approval });
    if (control.mode === 'unknown') return { id: command.approval.id, status: 'unknown', reason: 'Controlled approval outcome remains unconfirmed' };
    const approval = control.observation.inspection.planApproval!;
    if (command.approval.planVersion !== approval.planVersion) return { id: command.approval.id, status: 'rejected', reason: 'math_plan_approval_version_conflict' };
    Object.assign(approval, { status: 'approved', approvedId: command.approval.id, approvedVersion: command.approval.planVersion, approvedAt: Date.now() });
    control.emit(); return { id: command.approval.id, status: 'queued', observation: structuredClone(control.observation) };
  },
};
const port = await freePort(), origin = 'http://127.0.0.1:' + port;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '8' }), runner,
{ sample: null, mailer: async message => { mail.push(message); throw new Error('Approval regressions cannot send mail'); } });
const browser = await startBrowser(service.server, port), context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await preferFullCollaboration(context);
context.on('page', page => { page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message)); });
await context.route(/^https?:\/\//u, async route => {
  if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
});
const page = await context.newPage();
async function http<T>(method: string, pathname: string, input?: unknown): Promise<T> {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); if (!response.ok) throw new Error('Fixture HTTP ' + response.status + ': ' + body.error);
    return body;
  }, { method, pathname, input }) as Promise<T>;
}
const reply = (method: string, pathname: string) => page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === pathname);
const box = () => page.locator('[data-project-plan-approval]');
const approve = () => box().getByRole('button', { name: '批准此版本并继续研究', exact: true });
const inspect = () => box().locator('[data-approval-check]');
const retry = () => box().locator('[data-approval-retry]');
const review = () => box().locator('[data-approval-review-current]');
const dispatchClick = async (selector: string) => { await box().locator(selector).evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await settled(page); };
async function refresh(runId: string, projectPath: string) {
  const read = reply('GET', projectPath + '/runs/' + runId + '/observation');
  await page.locator('[data-collab-refresh]:enabled').click(); await (await read).finished(); await settled(page);
}
const revise = (runId: string, revising: boolean, version = controls.get(runId)!.observation.inspection.planVersion!) => {
  const control = controls.get(runId)!;
  control.observation.plan!.baseVersion = control.observation.inspection.planVersion = version;
  Object.assign(control.observation.inspection.planApproval!, { planVersion: version, leadRevising: revising }); control.emit();
};
try {
  await page.goto(origin + '/theorems.html');
  let project = (await http<{ item: ResearchProjectDetail }>('POST', '/api/research/theorems', { requestId: crypto.randomUUID(), title: '审批等待与恢复回归', description: '本地控制回执，不代表数学验收', visibility: 'private' })).item;
  const projectPath = '/api/research/theorems/' + project.id, feedbackPath = projectPath + '/feedback';
  project = (await http<{ item: ResearchProjectDetail }>('POST', projectPath + '/versions', { requestId: crypto.randomUUID(), expectedRevision: project.revision, statement: 'Prove True', source, environment: 'standard', confirmation: { confirmed: true } })).item;
  const version = project.currentStatementVersionId!, posts: any[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === feedbackPath) posts.push(request.postDataJSON()); });
  const create = async (task: string) => {
    const { run } = await http<{ run: { id: string } }>('POST', '/api/runs', { providerId: 'openai', apiKey: 'sk-local-approval-fixture',
      model: 'fixture', effort: 'low', environment: 'standard', source, task, maxTurns: 2, maxRunSeconds: 600,
      ...webAgentTeamPreset(), planApproval: true });
    for (let attempt = 0; attempt < 100 && !controls.has(run.id); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(controls.has(run.id)); project = (await http<{ item: ResearchProjectDetail }>('GET', projectPath)).item;
    await http('POST', projectPath + '/runs', { requestId: crypto.randomUUID(), expectedRevision: project.revision, statementVersionId: version, runId: run.id,
      exposure: 'members', grants: { guidance: true, edit: true, approve: true, proof: true } });
    return run.id;
  };
  const open = async (runId: string) => { await page.goto(origin + '/theorems.html?id=' + project.id + '&version=' + version + '&run=' + runId); await box().waitFor(); };

  phase = 'fresh-approval-waits-for-revision-and-explicitly-approves-latest';
  const runA = await create('等待 Lead 完成修改'); revise(runA, true); await open(runA);
  await box().locator('[data-approval-revising]').waitFor(); assert.equal(await approve().isDisabled(), true);
  const beforeFresh = posts.length; await dispatchClick('button');
  assert.equal(posts.length, beforeFresh); assert.equal(commands.filter(item => item.runId === runA).length, 0);
  await box().screenshot({ path: path.join(output, 'fresh-approval-waits-for-revision.png') });
  revise(runA, false, 'plan-v2'); await refresh(runA, projectPath); await approve().waitFor(); assert.equal(await approve().isEnabled(), true);
  assert.equal(posts.length, beforeFresh, 'Finishing a revision never submits an approval automatically');
  const accepted = reply('POST', feedbackPath); await approve().click(); const acceptedReply = await accepted;
  assert.equal(acceptedReply.status(), 201); assert.equal(acceptedReply.request().postDataJSON().planVersion, 'plan-v2');
  assert.equal((await acceptedReply.json()).item.execution.status, 'completed'); assert.equal(controls.get(runA)!.observation.acceptance, 'not-assessed');
  checks.push({ name: phase, width: 1440, disabledDuringRevision: true, handlerGuarded: true, automaticPosts: 0, explicitPlanVersion: 'plan-v2', status: 201, mathematicalAcceptance: 'not-assessed' });

  phase = 'mobile-original-retry-pauses-but-receipt-remains-readable';
  await page.setViewportSize({ width: 390, height: 844 });
  const runB = await create('旧批准的失败恢复'); await open(runB);
  let original: any;
  const unavailable = async (route: Route) => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().kind === 'plan-approval') {
      original = route.request().postDataJSON();
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Controlled submission was not received' }) });
    } else await route.continue();
  };
  await page.route('**' + feedbackPath, unavailable); await approve().click(); await retry().waitFor(); assert.equal(await retry().isEnabled(), true);
  await page.unroute('**' + feedbackPath, unavailable); assert.ok(original);
  revise(runB, true); await refresh(runB, projectPath); await box().locator('[data-approval-revising]').waitFor();
  assert.equal(await retry().isDisabled(), true); assert.equal(await inspect().isEnabled(), true);
  const beforeRetry = posts.length; await dispatchClick('[data-approval-retry]'); assert.equal(posts.length, beforeRetry);
  const readOriginal = reply('GET', feedbackPath); await inspect().click(); assert.equal((await readOriginal).status(), 200);
  await inspect().waitFor(); assert.equal(await box().getAttribute('data-approval-request-id'), original.requestId); assert.equal(posts.length, beforeRetry);
  await box().screenshot({ path: path.join(output, 'mobile-retry-waits-receipt-still-available.png') });
  const fit = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth })); assert.ok(fit.content <= fit.viewport + 1, JSON.stringify(fit));
  revise(runB, false, 'plan-v2'); await refresh(runB, projectPath); assert.equal(await retry().isEnabled(), true); assert.equal(posts.length, beforeRetry);
  const rejected = reply('POST', feedbackPath); await retry().click(); const rejectedReply = await rejected;
  assert.equal(rejectedReply.status(), 409); assert.deepEqual(rejectedReply.request().postDataJSON(), original, 'Retry must retain the complete original snapshot');
  await review().waitFor(); const beforeReview = posts.length; await review().click(); assert.equal(posts.length, beforeReview); await approve().waitFor();
  const latest = reply('POST', feedbackPath); await approve().click(); const latestReply = await latest;
  assert.equal(latestReply.status(), 201); assert.equal(latestReply.request().postDataJSON().planVersion, 'plan-v2'); assert.notEqual(latestReply.request().postDataJSON().requestId, original.requestId);
  checks.push({ name: phase, disabledDuringRevision: true, originalRecordRead: 200, originalRequestRetained: true, originalReplay: 409,
    latestVersionRequiresExplicitReviewAndApproval: true, latestPlanVersion: 'plan-v2', latestApproval: 201, ...fit });

  phase = 'saved-unknown-request-restores-while-lead-revises';
  const runC = await create('恢复已有待核对批准'); controls.get(runC)!.mode = 'unknown'; await open(runC);
  const unknown = reply('POST', feedbackPath); await approve().click(); const unknownReply = await unknown;
  assert.equal(unknownReply.status(), 201); const record: ResearchFeedback = (await unknownReply.json()).item; assert.equal(record.delivery.status, 'unknown');
  const savedInput = unknownReply.request().postDataJSON(); await inspect().waitFor();
  revise(runC, true); const beforeRestore = posts.length, beforeCommands = commands.length;
  await page.reload(); await inspect().waitFor(); await box().locator('[data-approval-revising]').waitFor();
  assert.equal(await box().getAttribute('data-approval-request-id'), savedInput.requestId);
  assert.equal(await inspect().isEnabled(), true); assert.equal(await retry().count(), 0); assert.equal(await approve().count(), 0);
  const readSaved = reply('GET', feedbackPath); await inspect().click(); assert.equal((await readSaved).status(), 200); await inspect().waitFor();
  assert.equal(posts.length, beforeRestore); assert.equal(commands.length, beforeCommands);
  const persisted = (await http<{ item: ResearchProjectDetail }>('GET', projectPath)).item.feedback.filter(item => item.requestId === savedInput.requestId);
  assert.equal(persisted.length, 1); assert.equal(persisted[0].delivery.status, 'unknown'); assert.equal(persisted[0].execution.status, 'not-started');
  await box().screenshot({ path: path.join(output, 'saved-unknown-revision-keeps-original-record.png') });
  checks.push({ name: phase, restoredOriginalRequest: true, originalLookup: 200, savedRecords: 1, additionalPosts: 0, additionalCommands: 0, execution: 'not-started' });

  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(mail, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, errors, external, realModels: 0, realLean: 0, externalMail: 0, productionTouched: false,
    controlledApprovalCommands: commands.length, noMathematicalAcceptance: true }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ phase, error: String(error), checks, errors, external }, null, 2) + '\n'); throw error;
} finally {
  for (const control of controls.values()) control.finish(); await context.close(); await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
