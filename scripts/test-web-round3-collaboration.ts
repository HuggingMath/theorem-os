#!/usr/bin/env bun
// Third-round claim, decision and revoked-access regressions. Local fake observations/checks only; no models, Lean or real mail.
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
import type { ResearchFeedback, ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import type { WebRun, WorkerMessage } from '../apps/web/shared';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/frontend-round3/collaboration/access-validation');
await fs.access(path.join(root, 'out/web/research.js')).catch(() => { throw new Error('Run bun run build:web before the collaboration check.'); });
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round3-access-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const now = () => new Date().toISOString(), hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const source = 'theorem research_fixture : True := by sorry';
type Control = { observation: WebObservation; emit(): void };
const controls = new Map<string, Control>();
const evidence: Record<string, unknown> = {};
const errors: string[] = [], external: string[] = [], mail: unknown[] = [];
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
      premises: [], plannedDependencies: task.dependsOn, attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })), workers: [], statementReviews: [], edits: [] };
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
    if (command.type === 'capture') return { id: 'capture', status: 'captured', observation: structuredClone(controls.get(id)!.observation) };
    if (command.type === 'guidance-withdraw') return { id: command.id, status: 'rejected', reason: 'fixture_guidance_withdraw_not_simulated' };
    return { id: command.type === 'guidance' ? command.guidance.id : command.type === 'plan-approval' ? command.approval.id : command.proposal.id, status: 'queued' };
  },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '4' }), runner,
{ sample: null, mailer: async message => { mail.push(message); throw new Error('The collaboration fixture never sends email'); } });

async function http<T>(method: string, pathname: string, input?: unknown, target = page!): Promise<T> {
  return target.evaluate(async ({ method, pathname, input }) => {
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
  const newContext = async () => {
    const context = await browser!.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
    });
    context.on('page', opened => { opened.setDefaultTimeout(15000); opened.on('pageerror', error => errors.push(error.message)); });
    return context;
  };
  const ownerContext = await newContext(); page = await ownerContext.newPage();
  await page.goto(`${origin}/theorems.html`); await page.getByRole('heading', { name: '定理', exact: true }).waitFor();
  let project = (await http<{ item: ResearchProjectDetail }>('POST', '/api/research/theorems', { requestId: crypto.randomUUID(), title: 'Round 3 private collaboration fixture', description: 'Disposable local browser regression', fields: ['logic'], visibility: 'members' })).item;
  const projectPath = `/api/research/theorems/${project.id}`, feedbackPath = `${projectPath}/feedback`;
  project = (await http<{ item: ResearchProjectDetail }>('POST', `${projectPath}/versions`, { requestId: crypto.randomUUID(), expectedRevision: project.revision,
    statement: 'Prove True.', source, environment: 'standard', confirmation: { confirmed: true } })).item;
  const version = project.currentStatementVersionId!;
  const startRun = async (target = page!) => {
    const run = (await http<{ run: WebRun }>('POST', '/api/runs', { requestId: crypto.randomUUID(), providerId: 'openai', apiKey: 'sk-disposable-collaboration-fixture', model: 'fixture', effort: 'low', environment: 'standard',
      source, task: 'Round 3 fake collaboration observation', maxTurns: 2, maxRunSeconds: 300, workers: 2, coordination: 'cooperative' }, target)).run;
    for (let attempt = 0; attempt < 100 && !controls.has(run.id); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(controls.has(run.id));
    const latest = (await http<{ item: ResearchProjectDetail }>('GET', projectPath, undefined, target)).item;
    await http('POST', `${projectPath}/runs`, { requestId: crypto.randomUUID(), expectedRevision: latest.revision, runId: run.id, statementVersionId: version, exposure: 'members', grants: { guidance: true, edit: true, approve: true, proof: true } }, target);
    return run;
  };
  const run = await startRun();
  const targetFor = (id: string) => { const observation = controls.get(id)!.observation; return { runId: id, statementVersionId: version, taskRef: { id: 'lemma', version: 'lemma-v1' },
    observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest } }; };
  const ownerFeedback = (await http<{ item: ResearchFeedback }>('POST', feedbackPath, { requestId: crypto.randomUUID(), kind: 'guidance', text: 'Private route argument retained only for authorized project members.', visibility: 'members', recipient: { kind: 'task', id: 'lemma' }, target: targetFor(run.id) })).item;
  const url = (runId: string) => `${origin}/theorems.html?id=${project.id}&version=${version}&run=${runId}`;
  await page.goto(url(run.id)); await page.getByText('人类参与者与任务认领', { exact: true }).click();
  const task = page.getByRole('combobox', { name: '任务与版本', exact: true }), linked = page.getByRole('combobox', { name: '关联本人反馈（可选）', exact: true });
  await task.selectOption('lemma@lemma-v1'); await linked.selectOption(ownerFeedback.id); assert.equal(await linked.inputValue(), ownerFeedback.id);
  await task.selectOption('goal@goal-v1'); assert.equal(await linked.inputValue(), '');
  const savedClaim = response('POST', `${projectPath}/assignments`); await page.getByRole('button', { name: '保存参与状态', exact: true }).click(); const claim = await savedClaim;
  assert.ok(claim.ok()); assert.equal(claim.request().postDataJSON().target.taskRef.id, 'goal'); assert.equal(claim.request().postDataJSON().feedbackId, undefined);
  await page.reload(); await page.getByText('人类参与者与任务认领', { exact: true }).click(); await task.selectOption('lemma@lemma-v1'); await linked.selectOption(ownerFeedback.id);
  const linkedClaim = response('POST', `${projectPath}/assignments`); await page.getByRole('button', { name: '保存参与状态', exact: true }).click(); const withFeedback = await linkedClaim;
  assert.ok(withFeedback.ok()); assert.equal(withFeedback.request().postDataJSON().feedbackId, ownerFeedback.id);
  evidence.taskSwitch = { switched: claim.request().postDataJSON(), linked: withFeedback.request().postDataJSON() };
  console.log('PASS switching tasks clears the previous feedback ID; choosing a valid link still saves');

  const observationPath = `${projectPath}/runs/${run.id}/observation`, routeRoot = page.locator('.research-collaboration');
  await routeRoot.waitFor({ state: 'visible' });
  let observationStatus: number | undefined = 503;
  const observationFailure = async (route: Route) => {
    if (route.request().method() === 'GET' && observationStatus) await route.fulfill({ status: observationStatus, contentType: 'application/json', body: JSON.stringify({ error: `Disposable observation failure ${observationStatus}` }) });
    else await route.continue();
  };
  await page.route('**' + observationPath, observationFailure);
  const outage = await page.waitForResponse(reply => new URL(reply.url()).pathname === observationPath && reply.status() === 503, { timeout: 15000 });
  assert.equal(outage.status(), 503); assert.equal(await routeRoot.isVisible(), true);
  const reconnect = page.getByText('当前展示上一次成功读取的观测；恢复连接后会继续更新。', { exact: true }); await reconnect.waitFor();
  const observationAccess: { status: number; rootHidden: boolean; reconnectVisible: boolean }[] = [];
  for (const status of [403, 401, 404]) {
    observationStatus = status;
    await page.waitForResponse(reply => new URL(reply.url()).pathname === observationPath && reply.status() === status, { timeout: 15000 });
    await routeRoot.waitFor({ state: 'hidden' }); assert.equal(await routeRoot.count(), 1, 'The observation-only failure leaves the project mounted');
    assert.equal(await reconnect.count(), 0, 'Access errors do not claim that a cached observation is still displayed');
    assert.equal(await page.getByText(ownerFeedback.text, { exact: true }).isVisible(), true);
    observationAccess.push({ status, rootHidden: await routeRoot.isHidden(), reconnectVisible: await reconnect.isVisible() });
    if (status === 403) await page.screenshot({ path: path.join(output, 'observation-only-403-clears-route.png'), fullPage: true });
    observationStatus = undefined;
    await page.waitForResponse(reply => new URL(reply.url()).pathname === observationPath && reply.status() === 200, { timeout: 15000 });
    await routeRoot.waitFor({ state: 'visible' });
  }
  await page.unroute('**' + observationPath, observationFailure);
  evidence.observationAccess = { transient503RetainsRoute: true, denied: observationAccess, recoveryRestoresRoute: await routeRoot.isVisible() };
  console.log('PASS observation-only 401/403/404 hides the previous route without a reconnect claim; 503 and authorized recovery preserve the intended view');

  const peerContext = await newContext(), peer = await peerContext.newPage(); await peer.goto(`${origin}/people.html`);
  const peerId = (await http<{ researcherId: string }>('GET', '/api/research/session', undefined, peer)).researcherId;
  const membership = async (role: 'collaborator' | 'reader' | null) => {
    const latest = (await http<{ item: ResearchProjectDetail }>('GET', projectPath)).item;
    return (await http<{ item: ResearchProjectDetail }>('PUT', `${projectPath}/members/${peerId}`, { requestId: crypto.randomUUID(), expectedRevision: latest.revision, role })).item;
  };
  await membership('collaborator'); await peer.goto(url(run.id));
  const decision = peer.locator(`article#feedback-${ownerFeedback.id}`);
  await decision.getByText('记录采纳决定', { exact: true }).click(); await decision.getByLabel('理由', { exact: true }).fill('Collaborator can record a decision with the granted guidance permission.');
  const savedDecision = response('POST', `${feedbackPath}/${ownerFeedback.id}/decision`, peer); await decision.getByRole('button', { name: '保存决定', exact: true }).click(); const acceptedDecision = await savedDecision;
  assert.ok(acceptedDecision.ok()); const acceptedDecisionItem = (await acceptedDecision.json()).item;
  const peerRun = await startRun(peer);
  const peerFeedback = (await http<{ item: ResearchFeedback }>('POST', feedbackPath, { requestId: crypto.randomUUID(), kind: 'guidance', text: 'Reader-owned run feedback fixture.', visibility: 'members', recipient: { kind: 'task', id: 'lemma' }, target: targetFor(peerRun.id) }, peer)).item;
  await membership('reader'); await peer.goto(url(peerRun.id));
  await peer.locator(`article#feedback-${peerFeedback.id}`).waitFor();
  const readerView = (await http<{ item: ResearchProjectDetail }>('GET', projectPath, undefined, peer)).item;
  assert.equal(readerView.permissions.edit, false); assert.equal(readerView.runs.find(item => item.runId === peerRun.id)!.permissions.manage, true);
  assert.equal(await peer.locator(`article#feedback-${peerFeedback.id}`).getByText('记录采纳决定', { exact: true }).count(), 0);
  evidence.decisionPermissions = { collaboratorStatus: acceptedDecision.status(), collaboratorActor: acceptedDecisionItem.decision.actor,
    reader: { edit: readerView.permissions.edit, ownRunManage: readerView.runs.find(item => item.runId === peerRun.id)!.permissions.manage, decisionFormVisible: false } };
  console.log('PASS granted collaborators can save decisions; readers cannot even on their own runs');

  await membership('collaborator'); await peer.goto(url(run.id));
  await peer.getByText(ownerFeedback.text, { exact: true }).waitFor(); const draft = peer.getByRole('textbox', { name: /^讨论内容/u });
  await draft.fill('Unsaved local discussion before a temporary server outage.');
  const temporaryFailure = async (route: Route) => {
    if (route.request().method() === 'GET') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Disposable temporary project outage' }) });
    else await route.continue();
  };
  await peer.route('**' + projectPath, temporaryFailure);
  const failedPoll = await peer.waitForResponse(reply => reply.request().method() === 'GET' && new URL(reply.url()).pathname === projectPath && reply.status() === 503, { timeout: 20000 });
  assert.equal(await draft.inputValue(), 'Unsaved local discussion before a temporary server outage.');
  assert.equal(await peer.getByText(ownerFeedback.text, { exact: true }).isVisible(), true, 'Transient failures keep the last authorized view and local draft');
  await peer.unroute('**' + projectPath, temporaryFailure);
  const deniedDetail = peer.waitForResponse(reply => new URL(reply.url()).pathname === projectPath && reply.status() === 404, { timeout: 20000 });
  const deniedObservation = peer.waitForResponse(reply => new URL(reply.url()).pathname === `${projectPath}/runs/${run.id}/observation` && reply.status() === 404, { timeout: 20000 });
  await membership(null); const [detail404, observation404] = await Promise.all([deniedDetail, deniedObservation]);
  await peer.waitForFunction(() => !document.querySelector('[data-research-feedback-workspace]'));
  assert.equal(await peer.getByText(ownerFeedback.text, { exact: true }).count(), 0); assert.equal(await draft.count(), 0);
  assert.equal(await peer.getByRole('region', { name: '运行路线与协作', exact: true }).count(), 0);
  await peer.getByRole('heading', { name: '无法打开此定理', exact: true }).waitFor();
  assert.equal(await peer.getByRole('heading', { name: '正在读取定理…', exact: true }).count(), 0);
  const retryDetail = peer.getByRole('button', { name: '重新读取', exact: true });
  const retried = peer.waitForResponse(reply => new URL(reply.url()).pathname === projectPath && reply.status() === 404, { timeout: 10000 });
  await retryDetail.click(); const retry404 = await retried; await peer.getByRole('heading', { name: '无法打开此定理', exact: true }).waitFor();
  evidence.unavailableDetail = { heading: '无法打开此定理', loadingVisible: false, retryStatus: retry404.status() };
  await peer.screenshot({ path: path.join(output, 'revoked-member-cleared.png'), fullPage: true });
  evidence.access = { temporaryFailure: failedPoll.status(), retainedDuring503: true, revokedDetail: detail404.status(), revokedObservation: observation404.status(), privateFeedbackVisible: false, submissionFormVisible: false, routeVisible: false };
  console.log('PASS temporary outages retain drafts; revoked membership removes cached private feedback, route and action forms');
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(mail, []);
} catch (error) { failure = error; await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
} finally {
  await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'execution.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: now(), evidence,
    ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}), pageErrors: errors, externalRequests: external,
    realModelCalls: 0, realLeanCalls: 0, productionWrites: false, realMail: false, fixturesRemoved: true }, null, 2) + '\n');
}
