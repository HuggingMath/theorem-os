#!/usr/bin/env bun
// Second-round collaboration regressions. Local fake observations/checks only; no models, Lean or real mail.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page, Response, Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebInspection, WebObservation } from '../apps/web/collaboration';
import type { ResearchProjectDetail, ResearcherProfile } from '../apps/web/researchProjectTypes';
import type { WebRun, WorkerMessage } from '../apps/web/shared';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-round2-collaboration');
await fs.access(path.join(root, 'out/web/research.js')).catch(() => { throw new Error('Run bun run build:web before the collaboration check.'); });
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round2-collaboration-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const now = () => new Date().toISOString(), hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const source = 'theorem research_fixture : True := by sorry\nlemma supporting_fact : True := by sorry';
const candidate = 'theorem research_fixture : True := by sorry\nlemma supporting_fact : True := by exact True.intro';
type Control = { observation: WebObservation; emit(): void };
const controls = new Map<string, Control>();
const fakeCalls: string[] = [], errors: string[] = [], external: string[] = [], mail: unknown[] = [];
const checks: { name: string; elapsedMs: number }[] = [];
let browser: Browser | undefined, page: Page | undefined, currentCheck = 'setup', failure: unknown;

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
    fakeCalls.push('run');
    await new Promise<void>(resolve => {
      const control = { observation: observation(input.id), emit() {
        this.observation.sequence++; this.observation.observedAt = now(); this.observation.snapshot.stateDigest = hash(`state-${this.observation.sequence}`);
        this.observation.inspection.snapshot.stateDigest = this.observation.snapshot.stateDigest;
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      controls.set(input.id, control); control.emit(); signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  async check() {
    fakeCalls.push('check');
    return { output: JSON.stringify({ severity: 'error', pos: { line: 1, column: 0 }, data: 'Local fixture check: candidate received without invoking Lean.' }), exitCode: 1, timedOut: false };
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
async function check(name: string, run: () => Promise<void>) {
  currentCheck = name; const started = performance.now(); await run(); checks.push({ name, elapsedMs: Math.round(performance.now() - started) }); console.log(`PASS ${name}`);
}
function response(method: string, pathname: string, target = page!) {
  return target.waitForResponse(reply => reply.request().method() === method && new URL(reply.url()).pathname === pathname);
}
async function ok(reply: Promise<Response>) { const received = await reply; assert.ok(received.ok(), `${received.status()} ${await received.text()}`); return received; }

try {
  browser = await startBrowser(service.server, port);
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
  });
  context.on('page', opened => { opened.setDefaultTimeout(10_000); opened.on('pageerror', error => errors.push(error.message)); });
  page = await context.newPage(); await page.goto(`${origin}/theorems.html`); await page.getByRole('heading', { name: '定理', exact: true }).waitFor();
  let project = (await http<{ item: ResearchProjectDetail }>('POST', '/api/research/theorems', { requestId: crypto.randomUUID(), title: 'Round 2 collaboration fixture', description: 'Disposable local browser regression', fields: ['logic'], visibility: 'private' })).item;
  const projectPath = `/api/research/theorems/${project.id}`, feedbackPath = `${projectPath}/feedback`;
  project = (await http<{ item: ResearchProjectDetail }>('POST', `${projectPath}/versions`, { requestId: crypto.randomUUID(), expectedRevision: project.revision,
    statement: 'Prove True.', source, environment: 'standard', confirmation: { confirmed: true } })).item;
  const version = project.currentStatementVersionId!;
  const projectUrl = `${origin}/theorems.html?id=${project.id}&version=${version}`;

  await check('R2-C01 a pending discussion save preserves later edits and ordinary saves still clear', async () => {
    await page!.goto(projectUrl); const input = page!.getByRole('textbox', { name: /^讨论内容/u });
    await input.fill('First comment sent to the server.');
    let reached!: () => void, release!: () => void;
    const pending = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const hold = async (route: Route) => {
      const received = await route.fetch(); reached(); await gate; await route.fulfill({ response: received });
    };
    await page!.route('**' + feedbackPath, hold);
    try {
      await page!.getByRole('button', { name: '保存讨论', exact: true }).click(); await pending;
      await input.fill('Second unsaved deduction typed during the first save.');
      const saved = response('POST', feedbackPath); release(); await ok(saved);
      await page!.getByText('已保存。', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), 'Second unsaved deduction typed during the first save.');
      const current = (await http<{ item: ResearchProjectDetail }>('GET', projectPath)).item;
      assert.equal(current.feedback.filter(item => item.kind === 'discussion').length, 1); assert.equal(current.feedback[0].text, 'First comment sent to the server.');
    } finally { release(); await page!.unroute('**' + feedbackPath, hold); }
    const saved = response('POST', feedbackPath); await page!.getByRole('button', { name: '保存讨论', exact: true }).click(); await ok(saved);
    await page!.waitForFunction(() => (document.querySelector('textarea[maxlength="4000"]') as HTMLTextAreaElement)?.value === '');
    assert.equal(await input.inputValue(), '');
    await page!.screenshot({ path: path.join(output, 'discussion-saved.png'), fullPage: true });
  });

  const run = (await http<{ run: WebRun }>('POST', '/api/runs', { requestId: crypto.randomUUID(), providerId: 'openai', apiKey: 'sk-disposable-collaboration-fixture', model: 'fixture', effort: 'low', environment: 'standard',
    source, task: 'Round 2 fake observation fixture', maxTurns: 2, maxRunSeconds: 300, workers: 2, coordination: 'cooperative' })).run;
  for (let attempt = 0; attempt < 100 && !controls.has(run.id); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(controls.has(run.id)); project = (await http<{ item: ResearchProjectDetail }>('GET', projectPath)).item;
  await http('POST', `${projectPath}/runs`, { requestId: crypto.randomUUID(), expectedRevision: project.revision, runId: run.id, statementVersionId: version, exposure: 'members', grants: { proof: true } });

  await check('R2-C03 stable candidate identity, explicit rebase and server version protection preserve human source', async () => {
    await page!.goto(`${projectUrl}&run=${run.id}`); await page!.getByText('提交候选证明', { exact: true }).click();
    const select = page!.getByRole('combobox', { name: '选择带有源码快照的任务', exact: true });
    await select.selectOption({ label: 'lemma · Main.lean · lemma-v1' });
    const input = page!.getByLabel('修改后的候选源码', { exact: true }); await input.fill(candidate);
    await page!.getByLabel('修改说明', { exact: true }).fill('Human proof preserved across source updates.');
    const stableChoice = await select.inputValue(), control = controls.get(run.id)!;
    control.observation.sources.reverse(); control.emit();
    await page!.waitForResponse(reply => new URL(reply.url()).pathname === `${projectPath}/runs/${run.id}/observation`);
    assert.equal(await select.inputValue(), stableChoice); assert.equal(await select.locator('option:checked').textContent(), 'lemma · Main.lean · lemma-v1');
    assert.equal(await input.inputValue(), candidate);
    const update = (number: number) => {
      const next = `lemma-v${number}`; control.observation.inspection.tasks.find(task => task.id === 'lemma')!.version = next;
      const index = control.observation.sources.findIndex(item => item.taskId === 'lemma');
      control.observation.sources[index] = { ...control.observation.sources[index], taskVersion: next, commit: String(number).repeat(40), source: source + '\n-- new baseline', sourceDigest: hash(source + `-${number}`) }; control.emit();
    };
    update(2);
    const rebase = page!.getByRole('button', { name: '更新到最新基准，保留编辑', exact: true }); await rebase.waitFor({ timeout: 15_000 });
    assert.ok((await select.locator('option:checked').textContent())?.includes('lemma-v1'));
    assert.ok((await select.locator('option:checked').textContent())?.includes('草稿基准已过期'));
    assert.equal(await page!.getByRole('button', { name: '提交检查', exact: true }).isDisabled(), true);
    await rebase.click(); assert.equal(await input.inputValue(), candidate);
    await page!.locator('[data-confirm-draft-baseline]').click();
    assert.equal(await select.locator('option:checked').textContent(), 'lemma · Main.lean · lemma-v2');
    await page!.screenshot({ path: path.join(output, 'candidate-rebased.png'), fullPage: true });
    const race = async (route: Route) => { update(3); await route.continue(); };
    await page!.route('**' + feedbackPath, race);
    try {
      const rejected = response('POST', feedbackPath); await page!.getByRole('button', { name: '提交检查', exact: true }).click(); const received = await rejected;
      assert.equal(received.status(), 409, 'A version change after clicking is still protected by the server');
      assert.equal(received.request().postDataJSON().target.taskRef.version, 'lemma-v2'); assert.equal(fakeCalls.filter(call => call === 'check').length, 0);
      assert.equal(await input.inputValue(), candidate);
    } finally { await page!.unroute('**' + feedbackPath, race); }
    await rebase.waitFor({ timeout: 15_000 }); await rebase.click(); assert.equal(await input.inputValue(), candidate);
    await page!.locator('[data-confirm-draft-baseline]').click();
    const submitted = response('POST', feedbackPath); await page!.getByRole('button', { name: '提交检查', exact: true }).click(); const received = await ok(submitted);
    const payload = received.request().postDataJSON(); assert.equal(payload.target.taskRef.version, 'lemma-v3'); assert.equal(payload.base.commit, '3'.repeat(40)); assert.equal(payload.source, candidate);
    assert.equal(fakeCalls.filter(call => call === 'check').length, 1, 'Only the latest-base submission reaches the fake checker');
    assert.equal((await received.json()).item.proofCheck.status, 'failed', 'The fixture checker supplies no real proof acceptance');
    assert.equal(await page!.locator('[data-research-feedback-workspace]').count(), 1, 'The latest FeedbackWorkspace is retained');
  });

  await check('R2-C04 profile conflicts show latest values while preserving drafts until explicit confirmation', async () => {
    await page!.goto(`${origin}/people.html?editProfile=1#profile-management`); await page!.getByLabel('显示名', { exact: true }).waitFor();
    await page!.getByLabel('显示名', { exact: true }).fill('My retained name'); await page!.getByLabel('简介', { exact: true }).fill('My retained biography');
    const other = await context.newPage(); await other.goto(`${origin}/people.html?editProfile=1#profile-management`); await other.getByLabel('显示名', { exact: true }).waitFor();
    await other.getByLabel('显示名', { exact: true }).fill('Name saved by the second tab'); const saved = response('PUT', '/api/research/profile', other);
    await other.getByRole('button', { name: '保存资料', exact: true }).click(); await ok(saved);
    const rejected = response('PUT', '/api/research/profile'); await page!.getByRole('button', { name: '保存资料', exact: true }).click(); assert.equal((await rejected).status(), 409);
    const keep = page!.getByRole('button', { name: '已核对，保留我的编辑', exact: true }); await keep.waitFor();
    assert.equal(await page!.getByLabel('显示名', { exact: true }).inputValue(), 'My retained name'); assert.equal(await page!.getByLabel('简介', { exact: true }).inputValue(), 'My retained biography');
    assert.equal(await page!.getByRole('button', { name: '保存资料', exact: true }).isDisabled(), true);
    const review = page!.getByRole('region', { name: '核对最新资料', exact: true }); await review.getByText('Name saved by the second tab', { exact: true }).waitFor();
    await page!.screenshot({ path: path.join(output, 'profile-conflict-review.png'), fullPage: true });
    let current = (await http<{ researcherId: string; profile: ResearcherProfile }>('GET', '/api/research/session')).profile;
    assert.equal(current.displayName, 'Name saved by the second tab');
    await keep.click(); current = (await http<{ profile: ResearcherProfile }>('GET', '/api/research/session')).profile;
    assert.equal(current.displayName, 'Name saved by the second tab', 'Review confirmation does not automatically overwrite the saved profile');
    const confirmed = response('PUT', '/api/research/profile'); await page!.getByRole('button', { name: '保存资料', exact: true }).click(); await ok(confirmed);
    current = (await http<{ profile: ResearcherProfile }>('GET', '/api/research/session')).profile;
    assert.equal(current.displayName, 'My retained name'); assert.equal(current.bio, 'My retained biography'); await other.close();
  });

  await check('R2-C02 discussion length matches the server limit and explains it before submission', async () => {
    await page!.goto(projectUrl); const input = page!.getByRole('textbox', { name: /^讨论内容/u });
    assert.equal(await input.getAttribute('maxlength'), '4000'); await page!.getByText('最多 4000 字符。 0 / 4000', { exact: true }).waitFor();
    await input.fill('x'.repeat(4000)); const saved = response('POST', feedbackPath); await page!.getByRole('button', { name: '保存讨论', exact: true }).click(); await ok(saved);
    await input.fill('x'.repeat(3999)); await input.press('End'); await input.press('x'); await input.press('x'); assert.equal((await input.inputValue()).length, 4000, 'Typing cannot exceed the accepted limit');
    await page!.screenshot({ path: path.join(output, 'discussion-length-limit.png'), fullPage: true });
  });
  assert.deepEqual(errors, [], 'No uncaught browser errors'); assert.deepEqual(external, [], 'All requests stay on the local fixture service'); assert.deepEqual(mail, [], 'No mail is sent');
} catch (error) {
  failure = error; await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
} finally {
  await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'execution.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: now(), checks,
    ...(failure ? { failedCheck: currentCheck, error: failure instanceof Error ? failure.message : String(failure) } : {}), pageErrors: errors, externalRequests: external,
    fakeCalls, realModelCalls: 0, realLeanCalls: 0, productionWrites: false, realMail: false, fixturesRemoved: true }, null, 2) + '\n');
}
