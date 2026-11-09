#!/usr/bin/env bun
// Real project grants and Chromium; disposable state and controlled previews, without mathematical acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebObservation } from '../apps/web/collaboration';
import type { ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { freePort, startBrowser, preferFullCollaboration, settled } from './web-scenario';
import { mathDigest } from '../src/math/mathRuntimeIo';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/frontend-round10/collaboration');
await fs.access(path.join(root, 'out/web/research.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round10-collaboration-'));
const source = 'theorem plan_access_fixture : True := by sorry\n';
const now = () => new Date().toISOString(), hash = (value: string) => mathDigest(value);
type Control = { finish(): void };
const controls = new Map<string, Control>(), commands: string[] = [], writes: string[] = [];
const checks: object[] = [], errors: string[] = [], external: string[] = [], mail: unknown[] = [];
let phase = 'setup';
function observation(id: string): WebObservation {
  const tasks = [{ id: 'lemma', kind: 'lemma' as const, objective: '证明辅助事实', dependsOn: [], revision: 0, theoremName: 'supporting_fact', proofPath: 'Main.lean', type: 'True' },
    { id: 'goal', kind: 'goal' as const, objective: '从辅助事实推出原题', dependsOn: ['lemma'], revision: 0, theoremName: 'plan_access_fixture', proofPath: 'Main.lean', type: 'True' }];
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: 'fixture-' + id, stateDigest: hash('initial'), resultDigest: null };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
      problem: { id: 'round10-plan-access-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'plan_access_fixture', proofPath: 'Main.lean' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative', buildDigest: hash('build'), environmentDigest: hash('environment') }, turns: 1, planVersion: 'plan-v1',
      scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded', droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] },
      tokenBudget: {}, continuation: {}, mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: hash('mathematics'), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['lemma', 'goal'] }, groups: [],
      tasks: tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective, group: 'main', status: 'pending', control: 'active', version: task.id + '-v1', theorem: task.theoremName, type: task.type,
        premises: [], plannedDependencies: task.dependsOn, attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })),
      workers: [], statementReviews: [], edits: [] },
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks }, sources: [], checks: [], guidance: [], coverage: { sources: 'partial', checks: 'partial' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable plan-access regression' }; },
  async check() { throw new Error('This regression cannot check or accept mathematical proofs'); },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      controls.set(input.id, { finish: resolve }); signal.addEventListener('abort', () => resolve(), { once: true });
      send({ type: 'observation', observation: observation(input.id) });
    });
  },
  async command(_runId, command) {
    commands.push(command.type);
    assert.equal(command.type, 'edit-preview', 'The regression must never apply a plan');
    if (command.type !== 'edit-preview') throw new Error('Unexpected command');
    return { id: command.proposal.id, status: 'validated', affectedTaskIds: ['lemma'], changes: [{ taskId: 'lemma', fields: ['objective'] }] };
  },
};
const port = await freePort(), origin = 'http://127.0.0.1:' + port;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '4' }), runner,
{ sample: null, mailer: async message => { mail.push(message); throw new Error('This regression cannot send mail'); } });
const browser = await startBrowser(service.server, port);
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const ownerContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
for (const actor of [context, ownerContext]) {
  await preferFullCollaboration(actor);
  actor.on('page', page => { page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message)); });
  await actor.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
  });
}
const page = await context.newPage(), owner = await ownerContext.newPage();
page.on('request', request => {
  if (request.method() === 'POST' && /\/edits(?:\/preview)?$/u.test(new URL(request.url()).pathname)) writes.push(new URL(request.url()).pathname);
});
async function http<T>(actor: Page, method: string, pathname: string, input?: unknown): Promise<T> {
  return actor.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); if (!response.ok) throw new Error('Fixture HTTP ' + response.status + ': ' + body.error); return body;
  }, { method, pathname, input }) as Promise<T>;
}
const reply = (method: string, pathname: string) => page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === pathname);
async function remainsBlocked(json: string, reason: string) {
  await page.locator('[data-plan-availability]').getByText(reason, { exact: true }).waitFor();
  for (const name of ['preview', 'rebase', 'apply', 'retry']) assert.equal(await page.locator(`[data-plan-${name}]`).isDisabled(), true);
  const before = writes.length;
  for (const name of ['preview', 'rebase', 'apply']) await page.locator(`[data-plan-${name}]`).evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settled(page);
  assert.equal(writes.length, before, 'Unavailable controls and their handlers must send no plan POST');
  assert.equal(await page.locator('#collab-plan-json').inputValue(), json);
  assert.equal(await page.locator('.collab-plan-dialog').evaluate((node: HTMLDialogElement) => node.open), true);
}
try {
  await Promise.all([page.goto(origin + '/theorems.html'), owner.goto(origin + '/theorems.html')]);
  await Promise.all([page.locator('main[aria-busy="false"]').waitFor(), owner.locator('main[aria-busy="false"]').waitFor()]);
  let project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', '/api/research/theorems', { requestId: crypto.randomUUID(), title: '计划弹窗授权与连接恢复', description: '一次性本地回执，不进行数学验收', visibility: 'members' })).item;
  const projectPath = '/api/research/theorems/' + project.id;
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', projectPath + '/versions', { requestId: crypto.randomUUID(), expectedRevision: project.revision, statement: 'Prove True', source, environment: 'standard', confirmation: { confirmed: true } })).item;
  const version = project.currentStatementVersionId!;
  const peerId = (await http<{ researcherId: string }>(page, 'GET', '/api/research/session')).researcherId; assert.ok(peerId);
  const ownerId = (await http<{ researcherId: string }>(owner, 'GET', '/api/research/session')).researcherId; assert.notEqual(peerId, ownerId);
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'PUT', projectPath + '/members/' + peerId, { requestId: crypto.randomUUID(), expectedRevision: project.revision, role: 'collaborator' })).item;
  for (const width of [1440, 390]) {
    phase = 'grant-change-' + width;
    const run = (await http<{ run: { id: string } }>(owner, 'POST', '/api/runs', { requestId: crypto.randomUUID(), providerId: 'openai', apiKey: 'sk-disposable-plan-access', model: 'fixture', effort: 'low', environment: 'standard', source,
      task: '检查计划弹窗操作权限与恢复', maxTurns: 2, maxRunSeconds: 600, workers: 2, coordination: 'cooperative' })).run;
    for (let attempt = 0; attempt < 100 && !controls.has(run.id); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(controls.has(run.id));
    const grants = async (edit: boolean) => {
      project = (await http<{ item: ResearchProjectDetail }>(owner, 'GET', projectPath)).item;
      return (await http<{ item: ResearchProjectDetail }>(owner, 'POST', projectPath + '/runs', { requestId: crypto.randomUUID(), expectedRevision: project.revision, statementVersionId: version, runId: run.id,
        exposure: 'members', grants: { guidance: true, edit, approve: false, proof: false } })).item;
    };
    const projected = (edit: boolean) => page.waitForResponse(async response => {
      if (response.request().method() !== 'GET' || new URL(response.url()).pathname !== projectPath || response.status() !== 200) return false;
      const body = await response.json(); return body.item.runs.find((item: { runId: string }) => item.runId === run.id)?.permissions.edit === edit;
    }, { timeout: 20000 });
    await grants(true);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(origin + '/theorems.html?id=' + project.id + '&version=' + version + '&run=' + run.id);
    await page.locator('[data-collab-plan]:enabled').click(); await page.locator('.collab-plan-dialog[open]').waitFor();
    await page.locator('[data-plan-task]').selectOption('lemma');
    await page.locator('[data-plan-objective]').fill('保留完整本地草稿：说明辅助结论如何接到原题 ' + width);
    const json = await page.locator('#collab-plan-json').inputValue(), editPath = projectPath + '/runs/' + run.id + '/edits';
    const preview = async () => {
      const response = reply('POST', editPath + '/preview'); await page.locator('[data-plan-preview]').click(); assert.equal((await response).status(), 200);
      await page.locator('[data-plan-apply]:enabled').waitFor();
    };
    await preview();
    const denied = projected(false); await grants(false); await denied;
    const deniedReason = '当前没有此运行的计划编辑权限。草稿已保留。';
    await remainsBlocked(json, deniedReason);
    assert.equal(await page.locator('[data-collab-plan]').isDisabled(), true);
    const peerView = (await http<{ item: ResearchProjectDetail }>(page, 'GET', projectPath)).item;
    assert.equal(peerView.permissions.edit, true);
    assert.equal(peerView.runs.find(item => item.runId === run.id)!.permissions.read, true);
    await page.locator('[data-plan-availability]').scrollIntoViewIfNeeded();
    await page.locator('.collab-plan-dialog').screenshot({ path: path.join(output, 'revoked-edit-preserved-' + width + '.png') });
    const restored = projected(true); await grants(true); await restored;
    await page.waitForFunction(() => (document.querySelector('[data-plan-preview]') as HTMLButtonElement)?.disabled === false);
    assert.equal(await page.locator('[data-plan-apply]').isDisabled(), true, 'A preview from before revocation must not be reused');
    assert.equal(await page.locator('#collab-plan-json').inputValue(), json); await preview();

    phase = 'disconnection-and-recovery-' + width;
    const observationPath = projectPath + '/runs/' + run.id + '/observation', observationUrl = origin + observationPath;
    await page.route(observationUrl, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '本地连接故障回归' }) }));
    await remainsBlocked(json, '连接中断，暂时无法预览或提交计划。草稿已保留。');
    await page.locator('[data-plan-availability]').scrollIntoViewIfNeeded();
    await page.locator('.collab-plan-dialog').screenshot({ path: path.join(output, 'disconnected-preserved-' + width + '.png') });
    await page.unroute(observationUrl); const reconnected = reply('GET', observationPath); assert.equal((await reconnected).status(), 200);
    await page.waitForFunction(() => (document.querySelector('[data-plan-preview]') as HTMLButtonElement)?.disabled === false);
    assert.equal(await page.locator('[data-plan-apply]').isDisabled(), true); await preview();

    phase = 'ended-run-preserves-draft-' + width;
    await http(owner, 'POST', '/api/runs/' + run.id + '/cancel');
    await remainsBlocked(json, '运行已结束，无法再修改计划。草稿已保留。');
    await page.locator('[data-plan-availability]').scrollIntoViewIfNeeded();
    await page.locator('.collab-plan-dialog').screenshot({ path: path.join(output, 'ended-run-preserved-' + width + '.png') });
    await page.locator('[data-plan-close]').click();
    checks.push({ width, initialPreview: 200, revokedControlsDisabled: true, revokedPosts: 0, completeDraftRetained: true,
      restoredPreview: 200, disconnectedControlsDisabled: true, disconnectedPosts: 0, reconnectedPreview: 200, endedControlsDisabled: true, endedPosts: 0 });
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(mail, []);
  assert.equal(writes.length, 6); assert.deepEqual(commands, Array(6).fill('edit-preview'));
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, errors, external, planPosts: writes, controlledCommands: commands,
    realModels: 0, realLean: 0, externalMail: 0, productionTouched: false, mathematicalAcceptance: 'not-assessed' }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', scenarios: checks.length, output }));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ phase, error: String(error), checks, writes, commands, errors, external }, null, 2) + '\n'); throw error;
} finally {
  for (const control of controls.values()) control.finish();
  await context.close(); await ownerContext.close(); await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
