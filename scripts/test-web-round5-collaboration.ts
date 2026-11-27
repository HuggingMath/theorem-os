#!/usr/bin/env bun
// Statement draft preservation and historical human-claim release. Local disposable accounts and observations only.
import { seedCooperativeRun } from './web-cooperative-fixture';
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
import { freePort, preferFullCollaboration, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/frontend-round5/collaboration');
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

const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await preferFullCollaboration(context);
const errors: string[] = [], external: string[] = [], checks: object[] = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.route(/^https?:\/\//u, async route => {
  if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
  else await route.continue();
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
let phase = 'setup';
try {
  await page.goto(`${origin}/theorems.html`);
  let project = (await http<{ item: ResearchProjectDetail }>(page, 'POST', '/api/research/theorems', {
    requestId: crypto.randomUUID(), title: 'Round 5 collaboration regression', description: 'Disposable local observations only.', visibility: 'members',
  })).item;
  const projectPath = `/api/research/theorems/${project.id}`;
  project = (await http<{ item: ResearchProjectDetail }>(page, 'POST', `${projectPath}/versions`, {
    requestId: crypto.randomUUID(), expectedRevision: project.revision, statement: 'Prove True.', source, environment: 'standard', confirmation: { confirmed: true },
  })).item;
  const version = project.currentStatementVersionId!;

  phase = 'statement-editor-preserves-new-input-while-saving';
  await page.goto(`${origin}/theorems.html?id=${project.id}`);
  await page.getByText('添加陈述版本', { exact: true }).click();
  const form = page.locator('form').filter({ has: page.getByRole('textbox', { name: '完整 Lean 源码', exact: true }) });
  const statement = form.getByRole('textbox', { name: '自然语言 / TeX 原题', exact: true });
  const code = form.getByRole('textbox', { name: '完整 Lean 源码', exact: true });
  await statement.fill('FIRST submitted statement: prove True.');
  await code.fill(source);
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { arrived = resolve; });
  let submitted: unknown;
  await page.route(origin + projectPath + '/versions', async intercepted => {
    submitted = intercepted.request().postDataJSON();
    const upstream = await intercepted.fetch(); arrived();
    await gate; await intercepted.fulfill({ response: upstream });
  });
  await form.getByRole('button', { name: '保存新版本', exact: true }).click();
  await requested;
  await statement.fill('SECOND unsent draft: prove True and preserve this work.');
  await code.fill('theorem second_unsent_draft : True := by trivial\n');
  const assumptions = form.getByRole('textbox', { name: '前提，每行一条', exact: true });
  const targets = form.getByRole('textbox', { name: '目标声明，每行：限定名 | 文件', exact: true });
  const environment = form.getByRole('combobox', { name: '证明环境', exact: true });
  const confirmed = form.getByRole('checkbox', { name: '我已核对自然语言题意与 Lean 陈述一致', exact: true });
  await assumptions.fill('Preserve the newly edited assumption.');
  await targets.fill('second_unsent_draft | Main.lean');
  await environment.selectOption('standard');
  await confirmed.check();
  const readDraft = async () => ({ statement: await statement.inputValue(), source: await code.inputValue(),
    assumptions: await assumptions.inputValue(), targets: await targets.inputValue(), environment: await environment.inputValue(), confirmed: await confirmed.isChecked() });
  const beforeReply = await readDraft();
  await page.screenshot({ path: path.join(output, 'newer-statement-draft-before-response.png'), fullPage: true });
  const received = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === projectPath + '/versions');
  release(); await received;
  await form.getByRole('button', { name: '保存新版本', exact: true }).waitFor();
  await form.getByText('陈述版本已保存，期间的新编辑已保留。', { exact: true }).waitFor();
  const afterReply = await readDraft();
  assert.deepEqual(afterReply, beforeReply);
  await page.unroute(origin + projectPath + '/versions');
  const persisted = (await http<{ item: ResearchProjectDetail }>(page, 'GET', projectPath)).item;
  assert.equal(persisted.versions.some(item => item.statement === beforeReply.statement || item.source === beforeReply.source), false);
  checks.push({ name: 'Statement save preserves every newer field without claiming those edits were saved', beforeReply, afterReply, submitted,
    savedVersionStatements: persisted.versions.map(item => item.statement) });
  await page.screenshot({ path: path.join(output, 'newer-statement-draft-preserved.png'), fullPage: true });

  phase = 'unchanged-statement-draft-clears-on-success';
  // Use the refreshed revision that includes the first successful submission.
  await page.reload(); await page.getByText('添加陈述版本', { exact: true }).click();
  await statement.fill(beforeReply.statement); await code.fill(beforeReply.source);
  await assumptions.fill(beforeReply.assumptions); await targets.fill(beforeReply.targets);
  await environment.selectOption(beforeReply.environment); await confirmed.check();
  const unchangedSaved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === projectPath + '/versions');
  await form.getByRole('button', { name: '保存新版本', exact: true }).click();
  const unchangedReply = await unchangedSaved; assert.equal(unchangedReply.status(), 201);
  await form.getByRole('button', { name: '保存新版本', exact: true }).waitFor();
  assert.equal(await statement.inputValue(), ''); assert.equal(await code.inputValue(), '');
  assert.equal(await assumptions.inputValue(), ''); assert.equal(await targets.inputValue(), ''); assert.equal(await confirmed.isChecked(), false);
  checks.push({ name: 'An unchanged submitted draft still clears after a successful save', payload: unchangedReply.request().postDataJSON(), status: unchangedReply.status() });

  phase = 'release-the-existing-claim-after-task-version-changes';
  const run = await seedCooperativeRun(service, page.context(), origin, runInput); assert.ok(controls.has(run.id));
  project = (await http<{ item: ResearchProjectDetail }>(page, 'GET', projectPath)).item;
  project = (await http<{ item: ResearchProjectDetail }>(page, 'POST', `${projectPath}/runs`, {
    requestId: crypto.randomUUID(), expectedRevision: project.revision, statementVersionId: version, runId: run.id,
    exposure: 'members', grants: { guidance: true, edit: true, approve: true, proof: true },
  })).item;
  await page.goto(`${origin}/theorems.html?id=${project.id}&version=${version}&run=${run.id}`);
  await page.getByText('人类参与者与任务认领', { exact: true }).click();
  const task = page.getByRole('combobox', { name: '任务与版本', exact: true });
  await task.selectOption('lemma@lemma-v1');
  const claimResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === projectPath + '/assignments');
  await page.getByRole('button', { name: '保存参与状态', exact: true }).click();
  const claimReply = await claimResponse; assert.equal(claimReply.status(), 200);
  const originalClaim = (await claimReply.json()).item.assignments[0];
  const control = controls.get(run.id)!;
  control.observation.inspection.tasks[0].version = 'lemma-v2';
  control.observation.inspection.planVersion = 'fixture-plan-v2';
  control.observation.plan!.baseVersion = 'fixture-plan-v2';
  control.observation.plan!.tasks[0].revision = 1;
  control.emit();
  await task.locator('option[value="lemma@lemma-v2"]').waitFor({ state: 'attached', timeout: 15000 });
  const claimCard = page.locator(`[data-human-assignment-id="${originalClaim.id}"]`);
  await claimCard.getByText(/lemma-v1.*已认领/u).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存参与状态', exact: true }).isDisabled(), true);
  const releasedResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === projectPath + '/assignments');
  await claimCard.getByRole('button', { name: '释放此认领', exact: true }).click();
  const releaseReply = await releasedResponse; assert.equal(releaseReply.status(), 200);
  const releasePayload = releaseReply.request().postDataJSON();
  assert.deepEqual(releasePayload.target, originalClaim.target);
  await claimCard.getByText(/lemma-v1.*已释放/u).waitFor();
  assert.equal(await claimCard.getByRole('button', { name: '释放此认领', exact: true }).count(), 0);
  const after = (await http<{ item: ResearchProjectDetail }>(page, 'GET', projectPath)).item;
  assert.equal(after.assignments.length, 1); assert.equal(after.assignments[0].id, originalClaim.id);
  assert.equal(after.assignments[0].status, 'released'); assert.deepEqual(after.assignments[0].target, originalClaim.target);
  await page.screenshot({ path: path.join(output, 'old-task-claim-released.png'), fullPage: true });
  await page.reload(); await page.getByText('人类参与者与任务认领', { exact: true }).click();
  await claimCard.getByText(/lemma-v1.*已释放/u).waitFor();
  checks.push({ name: 'An existing claim can be released directly after its task version changes; reload retains the same assignment and exact original target',
    originalClaim, currentTaskVersion: control.observation.inspection.tasks[0].version,
    releasePayload, status: releaseReply.status(), persistedAssignment: after.assignments[0] });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed',
    checks, errors, external, realModels: 0, realLean: 0, productionTouched: false }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ phase, error: String(error), checks, errors, external }, null, 2) + '\n');
  throw error;
} finally {
  await context.close(); await browser.close(); await service.close();
  await fs.rm(dataRoot, { recursive: true, force: true });
}


