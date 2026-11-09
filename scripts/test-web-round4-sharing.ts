#!/usr/bin/env bun
// Run-sharing conflict and recovery against disposable local accounts. No model, Lean or production.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput, WorkerMessage } from '../apps/web/shared';
import type { WebObservation, WebInspection } from '../apps/web/collaboration';
import type { ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { freePort, postRun, preferFullCollaboration, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/frontend-round4/sharing');
await fs.access(path.join(root, 'out/web/research.js'));
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-research-browser-'));
const source = 'theorem research_fixture : True := by sorry\n', credential = 'sk-local-research-fixture';
const hash = (letter: string) => letter.repeat(64), now = () => new Date().toISOString();
type Control = { observation: WebObservation; send: (message: WorkerMessage) => void; emit: () => void };
const controls = new Map<string, Control>();
function observation(id: string): WebObservation {
  const tasks = [{ id: 'lemma', kind: 'lemma' as const, objective: 'Prove a supporting fact', dependsOn: [], revision: 0, theoremName: 'supporting_fact', proofPath: 'Main.lean', type: 'True' },
    { id: 'goal', kind: 'goal' as const, objective: 'Prove the original statement', dependsOn: ['lemma'], revision: 0, theoremName: 'research_fixture', proofPath: 'Main.lean', type: 'True' }];
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `fixture-${id}`, stateDigest: hash('a'), resultDigest: null };
  const inspection: WebInspection = { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
    problem: { id: 'research-browser-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'research_fixture', proofPath: 'Main.lean' }] },
    configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative', buildDigest: hash('b'), environmentDigest: hash('e') }, turns: 1, planVersion: 'fixture-plan-v1',
    scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
    knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded', droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] },
    tokenBudget: {}, continuation: {}, mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: hash('c'), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
    progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['lemma', 'goal'] }, groups: [],
    tasks: tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective, group: 'main', status: 'pending', control: 'active', version: `${task.id}-v1`, theorem: task.theoremName, type: task.type,
      premises: [], plannedDependencies: task.dependsOn, attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })), workers: [], statementReviews: [], edits: [] };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1, evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, inspection,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'fixture-plan-v1', tasks }, sources: [], checks: [], guidance: [], coverage: { sources: 'partial', checks: 'partial' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable local research UI fixture' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), send, emit() { this.observation.sequence++; this.observation.observedAt = now(); this.send({ type: 'observation', observation: structuredClone(this.observation) }); } };
      controls.set(input.id, control); control.emit(); signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  async command(id, command) {
    const control = controls.get(id); assert.ok(control);
    if (command.type === 'guidance') {
      const guidance = { ...command.guidance, status: 'delivered' as const, deliveredTo: ['fixture-lead'], createdAt: now(), updatedAt: now() };
      control.observation.guidance.push(guidance); control.emit(); return { id: command.guidance.id, status: 'delivered', guidance, observation: structuredClone(control.observation) };
    }
    throw new Error(`Unexpected fixture command: ${command.type}`);
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '8' }), runner);
const browser = await startBrowser(service.server, port);
const runInput: WebRunInput = { providerId: 'openai', apiKey: credential, model: 'fixture', effort: 'low', environment: 'standard', source,
  task: 'Disposable collaboration fixture', maxTurns: 2, maxRunSeconds: 300, workers: 2, coordination: 'cooperative' };
async function http<T>(page: Page, method: string, pathname: string, input?: unknown): Promise<T> {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const value = await response.json(); if (!response.ok) throw new Error(`Fixture HTTP ${response.status}: ${value.error}`); return value;
  }, { method, pathname, input }) as Promise<T>;
}


const contexts = await Promise.all([browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }),
  browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })]);
const pageErrors: string[] = [], external: string[] = [], checks: object[] = [];
let phase = 'setup';
try {
  for (const context of contexts) {
    await preferFullCollaboration(context);
    await context.route(/^https?:\/\//u, async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { external.push(url.host); await route.abort(); } else await route.continue();
    });
    context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
  }
  const owner = await contexts[0].newPage(), second = await contexts[0].newPage(), member = await contexts[1].newPage();
  owner.setDefaultTimeout(10_000); second.setDefaultTimeout(10_000); member.setDefaultTimeout(10_000);
  await owner.goto(`${origin}/theorems.html`); await member.goto(`${origin}/theorems.html`); await second.goto(`${origin}/theorems.html`);
  const profile = await http<{ researcherId: string }>(member, 'GET', '/api/research/session');
  let project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', '/api/research/theorems', {
    requestId: crypto.randomUUID(), title: 'Run-sharing conflict fixture', description: 'Disposable permission recovery scenario.', visibility: 'members',
  })).item;
  const route = `/api/research/theorems/${project.id}`;
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', route + '/versions', { requestId: crypto.randomUUID(),
    expectedRevision: project.revision, statement: 'Prove True', source, environment: 'standard', confirmation: { confirmed: true } })).item;
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'PUT', route + '/members/' + profile.researcherId, {
    requestId: crypto.randomUUID(), expectedRevision: project.revision, role: 'collaborator',
  })).item;
  const run = await postRun({ page: owner }, runInput); assert.ok(controls.has(run.id));
  const initialGrants = { guidance: true, edit: false, approve: false, proof: false };
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', route + '/runs', { requestId: crypto.randomUUID(),
    expectedRevision: project.revision, statementVersionId: project.currentStatementVersionId, runId: run.id,
    exposure: 'members', grants: initialGrants })).item;
  const initialRevision = project.revision;
  await owner.goto(`${origin}/theorems.html?id=${project.id}&run=${run.id}`);
  await owner.getByText('调整此运行的共享与授权', { exact: true }).click();
  const form = owner.locator('form').filter({ has: owner.getByRole('button', { name: '保存运行授权', exact: true }) });
  assert.equal(await form.getByLabel('数学指导', { exact: true }).isChecked(), true);

  phase = 'save-against-old-baseline';
  await form.locator('select').selectOption('public');
  // Hold project refreshes at the first page's baseline until its first save is rejected.
  await owner.route(origin + route, async intercepted => {
    if (intercepted.request().method() === 'GET') await intercepted.fulfill({ json: { item: project } });
    else await intercepted.continue();
  });
  const revoked = (await http<{ item: ResearchProjectDetail }>(second, 'POST', route + '/runs', {
    requestId: crypto.randomUUID(), expectedRevision: initialRevision, runId: run.id,
    statementVersionId: project.currentStatementVersionId, exposure: 'members', grants: { ...initialGrants, guidance: false },
  })).item;
  const revokedRevision = revoked.revision;
  const memberBefore = (await http<{ item: ResearchProjectDetail }>(member, 'GET', route)).item.runs.find(x => x.runId === run.id)!;
  assert.equal(memberBefore.permissions.guidance, false);
  const rejectedPromise = owner.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === route + '/runs');
  await form.getByRole('button', { name: '保存运行授权', exact: true }).click();
  const rejected = await rejectedPromise;
  assert.equal(rejected.status(), 409);
  const rejectedPayload = rejected.request().postDataJSON();
  assert.equal(rejectedPayload.expectedRevision, initialRevision);
  await form.getByRole('alert').waitFor();
  assert.equal(await form.locator('select').inputValue(), 'public');
  assert.equal(await form.getByLabel('数学指导', { exact: true }).isChecked(), true);
  checks.push({ name: 'An unseen remote change rejects the old baseline with 409 and retains the local draft', payload: rejectedPayload, status: rejected.status() });
  await owner.unroute(origin + route);

  phase = 'automatic-refresh-preserves-draft-and-blocks-save';
  await owner.waitForResponse(async response => {
    if (new URL(response.url()).pathname !== route || response.request().method() !== 'GET' || response.status() !== 200) return false;
    return (await response.json()).item.revision === revokedRevision;
  }, { timeout: 20_000 });
  await form.locator('button[type="submit"]:disabled').waitFor();
  assert.equal(await form.locator('select').inputValue(), 'public');
  assert.equal(await form.getByLabel('数学指导', { exact: true }).isChecked(), true);
  await form.getByRole('button', { name: '载入最新授权', exact: true }).waitFor();
  await owner.screenshot({ path: path.join(output, 'conflict-draft-retained.png'), fullPage: true });
  checks.push({ name: 'A newer project revision keeps the old draft visible but prevents silent resubmission', initialRevision, revokedRevision });

  phase = 'load-latest-and-save-another-field';
  await form.getByRole('button', { name: '载入最新授权', exact: true }).click();
  assert.equal(await form.locator('select').inputValue(), 'members');
  assert.equal(await form.getByLabel('数学指导', { exact: true }).isChecked(), false);
  assert.equal(await form.getByRole('alert').count(), 0);
  assert.equal(await form.getByRole('button', { name: '保存运行授权', exact: true }).isEnabled(), true);
  await form.locator('select').selectOption('public');
  const requestPromise = owner.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === route + '/runs');
  const responsePromise = owner.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === route + '/runs');
  await form.getByRole('button', { name: '保存运行授权', exact: true }).click();
  const request = await requestPromise, response = await responsePromise;
  const payload = request.postDataJSON(), saved = await response.json();
  assert.equal(response.status(), 201); assert.equal(payload.expectedRevision, revokedRevision); assert.equal(payload.grants.guidance, false);
  const memberAfter = (await http<{ item: ResearchProjectDetail }>(member, 'GET', route)).item.runs.find(x => x.runId === run.id)!;
  assert.equal(memberAfter.permissions.guidance, false);
  assert.equal(memberAfter.exposure, 'public');
  await form.locator('button[type="submit"]:enabled').waitFor();
  checks.push({ name: 'Loading latest permissions adopts the real revoked grant; changing visibility preserves it on a successful save',
    payload, status: response.status(), resultingRevision: saved.item.revision, memberBefore, memberAfter });
  assert.deepEqual(pageErrors, []); assert.deepEqual(external, []);
  await owner.screenshot({ path: path.join(output, 'saved-with-revocation-preserved.png'), fullPage: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks,
    pageErrors, external, realModelCalls: 0, realLeanCalls: 0, productionTouched: false }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }));
} catch (error) {
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ phase, error: String(error), checks, pageErrors }, null, 2) + '\n');
  throw error;
} finally {
  await Promise.all(contexts.map(context => context.close())); await browser.close(); await service.close();
  await fs.rm(dataRoot, { recursive: true, force: true });
}
