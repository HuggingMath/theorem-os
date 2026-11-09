#!/usr/bin/env bun
// Real HTTP and Chromium with disposable state; controlled guidance receipts never imply proof acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebObservation } from '../apps/web/collaboration';
import type { ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { freePort, preferFullCollaboration, settled, startBrowser } from './web-scenario';
import { mathDigest } from '../src/math/mathRuntimeIo';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/frontend-round9/collaboration');
await fs.access(path.join(root, 'out/web/research.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round9-collaboration-'));
const source = 'theorem guidance_fixture : True := by sorry\n', now = () => new Date().toISOString();
type Control = { observation: WebObservation; emit(): void; finish(): void };
const controls = new Map<string, Control>(), commands: { runId: string; taskId?: string; taskVersion?: string }[] = [];
const checks: object[] = [], errors: string[] = [], external: string[] = [], mail: unknown[] = [];
let phase = 'setup';
function observation(id: string): WebObservation {
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: 'fixture-' + id, stateDigest: mathDigest('initial'), resultDigest: null };
  const task = { id: 'goal', kind: 'goal' as const, objective: '当前任务：使用新增假设证明结论', group: 'main', status: 'pending', control: 'active',
    version: 'goal-v2', theorem: 'guidance_fixture', type: 'True', premises: [], plannedDependencies: [], attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1, evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
      problem: { id: 'round9-guidance-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'guidance_fixture', proofPath: 'Main.lean' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative', buildDigest: mathDigest('build'), environmentDigest: mathDigest('environment') }, turns: 1, planVersion: 'plan-v2',
      scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded', droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] },
      tokenBudget: {}, continuation: {}, mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: mathDigest('mathematics'), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['goal'] }, groups: [], tasks: [task], workers: [], statementReviews: [], edits: [] },
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v2', tasks: [{ id: 'goal', kind: 'goal', objective: task.objective, dependsOn: [], revision: 1, theoremName: 'guidance_fixture', proofPath: 'Main.lean', type: 'True' }] },
    history: [{ ...structuredClone(task), version: 'goal-v1', objective: '历史任务：核对第一步的假设' }], sources: [], checks: [], guidance: [], coverage: { sources: 'partial', checks: 'partial' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable historical guidance regression' }; },
  async check() { throw new Error('Guidance regressions must not check mathematical proofs'); },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), finish: resolve, emit() {
        this.observation.sequence++; this.observation.observedAt = now(); this.observation.snapshot.stateDigest = mathDigest('state-' + this.observation.sequence);
        this.observation.inspection.snapshot.stateDigest = this.observation.snapshot.stateDigest;
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true }); control.emit();
    });
  },
  async command(runId, command) {
    const control = controls.get(runId)!;
    if (command.type === 'capture') return { id: 'capture', status: 'captured', observation: structuredClone(control.observation) };
    if (command.type !== 'guidance') throw new Error('Unexpected command: ' + command.type);
    commands.push({ runId, taskId: command.guidance.taskRef?.id, taskVersion: command.guidance.taskRef?.version });
    const guidance = { ...command.guidance, status: 'delivered' as const, deliveredTo: ['fixture-lead'], createdAt: now(), updatedAt: now() };
    control.observation.guidance.push(guidance); control.emit();
    return { id: guidance.id, status: 'delivered', guidance, observation: structuredClone(control.observation) };
  },
};
const port = await freePort(), origin = 'http://127.0.0.1:' + port;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '4' }), runner,
{ sample: null, mailer: async message => { mail.push(message); throw new Error('Guidance regressions cannot send mail'); } });
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
try {
  await page.goto(origin + '/theorems.html');
  let project = (await http<{ item: ResearchProjectDetail }>('POST', '/api/research/theorems', { requestId: crypto.randomUUID(), title: '历史任务指导版本回归', description: '本地控制回执，不代表数学验收', visibility: 'private' })).item;
  const projectPath = '/api/research/theorems/' + project.id;
  project = (await http<{ item: ResearchProjectDetail }>('POST', projectPath + '/versions', { requestId: crypto.randomUUID(), expectedRevision: project.revision, statement: 'Prove True', source, environment: 'standard', confirmation: { confirmed: true } })).item;
  const version = project.currentStatementVersionId!;
  const run = (await http<{ run: { id: string } }>('POST', '/api/runs', { requestId: crypto.randomUUID(), providerId: 'openai', apiKey: 'sk-local-guidance-fixture', model: 'fixture', effort: 'low',
    environment: 'standard', source, task: '历史任务指导入口', maxTurns: 2, maxRunSeconds: 600, workers: 2, coordination: 'cooperative' })).run;
  for (let attempt = 0; attempt < 100 && !controls.has(run.id); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(controls.has(run.id)); project = (await http<{ item: ResearchProjectDetail }>('GET', projectPath)).item;
  await http('POST', projectPath + '/runs', { requestId: crypto.randomUUID(), expectedRevision: project.revision, statementVersionId: version, runId: run.id,
    exposure: 'members', grants: { guidance: true, edit: true, approve: true, proof: true } });
  const url = origin + '/theorems.html?id=' + project.id + '&version=' + version + '&run=' + run.id;
  const inspector = page.locator('[data-collab-inspector]'), guide = page.locator('[data-collab-guide-task]');
  for (const width of [1440, 390]) {
    phase = 'historical-guidance-' + width;
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(url + '&task=goal&taskVersion=goal-v1'); await inspector.getByText('goal-v1', { exact: true }).first().waitFor();
    assert.equal(await guide.isDisabled(), true);
    const read = reply('GET', projectPath + '/runs/' + run.id + '/observation');
    await page.locator('[data-collab-refresh]:enabled').click(); await (await read).finished(); await settled(page);
    assert.match(await inspector.innerText(), /历史/u); assert.equal(await guide.isDisabled(), true, 'Refreshing must keep historical guidance disabled');
    const before = commands.length;
    await guide.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await settled(page);
    assert.equal(await page.locator('[data-guidance-kind]').inputValue(), 'lead', 'The click handler must not retarget the historical inspector to the current task');
    assert.equal(commands.length, before);
    await page.locator('.collab-inspector').screenshot({ path: path.join(output, 'historical-guidance-disabled-' + width + '.png') });

    await inspector.locator('[data-task-current]').click(); await inspector.getByText('goal-v2', { exact: true }).first().waitFor(); assert.equal(await guide.isEnabled(), true);
    await guide.click(); await page.locator('[data-guidance-text]').fill('已核对当前版本后，请补充从假设到结论的推导 ' + width);
    const posted = reply('POST', projectPath + '/runs/' + run.id + '/guidance');
    await page.getByRole('button', { name: '发送指导', exact: true }).click(); const response = await posted; assert.equal(response.status(), 200);
    assert.deepEqual(response.request().postDataJSON().taskRef, { id: 'goal', version: 'goal-v2' });
    await page.locator('[data-guidance-notice]').getByText(/已送达/u).waitFor();
    assert.equal(commands.length, before + 1);
    assert.equal(await page.locator('[data-guidance-text]').inputValue(), '');
    const fit = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth })); assert.ok(fit.content <= fit.viewport + 1, JSON.stringify(fit));
    await page.locator('.collab-guidance').screenshot({ path: path.join(output, 'explicit-current-guidance-delivered-' + width + '.png') });

    await page.goto(url + '&task=goal&taskVersion=unavailable-version');
    await inspector.getByText('unavailable-version', { exact: true }).first().waitFor();
    const missingRead = reply('GET', projectPath + '/runs/' + run.id + '/observation');
    await page.locator('[data-collab-refresh]:enabled').click(); await (await missingRead).finished(); await settled(page);
    assert.equal(await guide.isDisabled(), true, 'A missing historical version must not guide the current task either');
    checks.push({ width, historicalVersion: 'goal-v1', disabledAfterRefresh: true, handlerGuarded: true, missingVersionDisabled: true,
      explicitCurrentVersion: 'goal-v2', guidanceStatus: 200, deliveryVisible: true, draftClearedAfterDelivery: true, ...fit });
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(mail, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, errors, external, realModels: 0, realLean: 0, externalMail: 0,
    productionTouched: false, controlledGuidanceCommands: commands, mathematicalAcceptance: 'not-assessed' }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ phase, error: String(error), checks, errors, external }, null, 2) + '\n'); throw error;
} finally {
  for (const control of controls.values()) control.finish(); await context.close(); await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
