#!/usr/bin/env bun
// Real local UI with disposable accounts and recorded observations. Candidate save receipts are controlled fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import type { WebInspection, WebObservation } from '../apps/web/collaboration';
import type { WebRunner } from '../apps/web/runner';
import { createWebService } from '../apps/web/server';
import type { WebRun } from '../apps/web/shared';
import { localeStorageKey } from '../apps/web/i18n';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { deferred, freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_PROJECT_DRAFTS_OUTPUT ?? path.join(root, 'out/web-project-drafts');
await fs.access(path.join(root, 'out/web/research.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-project-drafts-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const checks: string[] = [], screenshots: string[] = [], errors: string[] = [], external: string[] = [], forbiddenCalls: string[] = [];
const mail: { to: string; text: string }[] = [];
const forbidden = (name: string): never => { forbiddenCalls.push(name); throw new Error(`Draft regressions cannot invoke runner.${name}`); };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable project draft regression' }; },
  async run() { return forbidden('run'); }, async formalize() { return forbidden('formalize'); },
  async check() { return forbidden('check'); }, async command() { return forbidden('command'); }, async explain() { return forbidden('explain'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org' }), runner,
  { sample: null, captchaAnswer: () => '24680', mailer: async message => { mail.push(message); } });
const password = 'Disposable-project-drafts-only-2026';
async function account(name: string) {
  const email = `${name.toLowerCase()}@example.org`, captcha = service.auth!.captcha(name);
  await service.auth!.requestCode(name, { email, captchaId: captcha.id, captcha: '24680' });
  const code = mail.findLast(item => item.to === email)?.text.match(/\b\d{6}\b/u)?.[0]; assert.ok(code);
  const value = service.auth!.verifyCode({ email, code }); await service.auth!.setPassword(email, password, undefined, true);
  const owner = `account:${value.id}`;
  const profile = service.research.projects.saveProfile(owner, { requestId: 'profile', expectedRevision: 0, displayName: name, visibility: 'public' });
  return { email, owner, profile };
}
const alice = await account('Alice'), bob = await account('Bob');
const statementSource = 'theorem project_goal : True := by sorry';
const candidateA = 'theorem project_goal : True := by\n  -- Alice independent candidate\n  exact True.intro\n';
const candidateB = 'theorem project_goal : True := by\n  -- another run, another draft\n  trivial\n';
const now = () => new Date().toISOString(), hash = (value: string) => mathDigest(value);
function observation(runId: string, version = 1): WebObservation {
  const taskVersion = `goal-v${version}`, snapshot = { schema: 'theoremos.run-observation.v1', runId: `fixture-${runId}`,
    stateDigest: hash(`${runId}:${version}`), resultDigest: null };
  const task = { id: 'goal', kind: 'goal' as const, objective: 'Prove the original statement', dependsOn: [], revision: version,
    theoremName: 'project_goal', proofPath: 'Main.lean', type: 'True' };
  const inspection: WebInspection = { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot,
    evidence: 'recorded-not-replayed', phase: 'cooperative',
    problem: { id: 'project-draft-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'project_goal', proofPath: 'Main.lean' }] },
    configuration: { model: 'fixture', effort: 'low', workers: 1, coordination: 'cooperative', buildDigest: hash('build'), environmentDigest: hash('environment') },
    turns: 1, planVersion: 'plan-v1', scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0, proofAssignments: 0,
      preparing: 0, stopping: 0, idle: 0, stopped: 0 },
    knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded', droppedRetrievals: 0,
      retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
    mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: hash('math'),
      obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
    progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['goal'] }, groups: [],
    tasks: [{ id: task.id, kind: task.kind, objective: task.objective, group: 'main', status: 'pending', control: 'active', version: taskVersion,
      theorem: task.theoremName, type: task.type, premises: [], plannedDependencies: [], attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} }],
    workers: [], statementReviews: [], edits: [] };
  const source = version === 1 ? statementSource : `${statementSource}\n-- updated base ${version}`;
  return { schema: 'theorem-os.web-observation.v1', webRunId: runId, solverRunId: snapshot.runId, observedAt: now(), sequence: version,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, inspection,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [task] },
    sources: [{ scope: 'owned-file', taskId: task.id, taskVersion, commit: String(version).repeat(40), sourceDigest: hash(source),
      environmentDigest: hash('environment'), file: 'Main.lean', source }], checks: [], guidance: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}
const runA = crypto.randomUUID(), runB = crypto.randomUUID();
function saveRun(id: string, version = 1) {
  const value: WebRun = { id, title: id === runA ? 'Candidate run A' : 'Candidate run B', status: 'running', phase: 'research', createdAt: now(), updatedAt: now(),
    providerId: 'openai', model: 'fixture', effort: 'low', environment: 'standard', source: statementSource, task: 'Prove True',
    maxTurns: 0, maxRunSeconds: 0, workers: 1, coordination: 'cooperative', events: [], observation: observation(id, version) };
  service.storage.saveRun(alice.owner, value);
}
saveRun(runA); saveRun(runB);
let project = service.research.projects.create(alice.owner, { requestId: 'project', title: 'Research draft continuity', visibility: 'members' });
project = service.research.projects.setMember(alice.owner, project.id, bob.profile.id,
  { requestId: 'member', expectedRevision: project.revision, role: 'collaborator' });
project = service.research.projects.addVersion(alice.owner, project.id, { requestId: 'version', expectedRevision: project.revision,
  statement: 'Prove True', source: statementSource, environment: 'standard', confirmation: { confirmed: true } });
const versionId = project.currentStatementVersionId!;
for (const runId of [runA, runB]) project = service.research.projects.bindRun(alice.owner, project.id,
  { requestId: `bind-${runId}`, expectedRevision: project.revision, statementVersionId: versionId, runId, grants: { proof: true } });
const projectRoute = `/api/research/theorems/${project.id}`, feedbackRoute = `${projectRoute}/feedback`;
const url = (runId = runA) => `${origin}/theorems.html?${new URLSearchParams({ id: project.id, version: versionId, run: runId })}`;
const browser = await startBrowser(service.server, port);
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
await context.addInitScript(key => { try { localStorage.setItem(key, 'zh'); } catch { /* about:blank has no origin. */ } }, localeStorageKey);
await context.route(/^https?:\/\//u, async route => {
  if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
  else await route.continue();
});
const page = await context.newPage(); page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0);
page.on('pageerror', error => errors.push(error.message));
async function auth(method: string, pathname: string, body: object) {
  const session = await (await context.request.get(origin + '/api/session', { timeout: 0 })).json();
  const response = await context.request.fetch(origin + pathname, { method, timeout: 0,
    headers: { 'X-CSRF-Token': session.csrfToken }, data: body });
  assert.equal(response.status(), 200, `${pathname}: ${await response.text()}`);
}
async function signIn(person: typeof alice) { await auth('POST', '/api/auth/password/login', { email: person.email, password }); }
const proof = () => page.locator('[data-project-proof-draft]');
const source = () => proof().getByRole('textbox', { name: '修改后的候选源码', exact: true });
const description = () => proof().getByRole('textbox', { name: '修改说明', exact: true });
const baseChoice = () => proof().getByRole('combobox', { name: '选择带有源码快照的任务', exact: true });
const discussion = () => page.locator('form').filter({ has: page.getByRole('button', { name: '保存讨论', exact: true }) });
const discussionText = () => discussion().getByRole('textbox', { name: '讨论内容', exact: true });
const statement = () => page.locator('[data-project-statement-draft]');
async function expand(form: ReturnType<typeof proof>) {
  await form.waitFor({ state: 'attached', timeout: 0 });
  await form.evaluate(node => { const details = node.closest('details'); if (details) details.open = true; });
}
async function readCandidate() { return { source: await source().inputValue(), text: await description().inputValue(), base: await baseChoice().inputValue() }; }
async function screenshot(name: string) {
  await settled(page); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(output, name), fullPage: true, timeout: 0 }); screenshots.push(name);
}
const mark = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
type ReceiptGate = { kind: 'proof-submission' | 'discussion' | 'statement'; arrived: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; payload?: any };
let nextReceipt: ReceiptGate | undefined;
const gates: ReceiptGate[] = [], candidatePayloads: any[] = [];
function hold(kind: ReceiptGate['kind']): ReceiptGate {
  const gate: ReceiptGate = { kind, arrived: deferred(), release: deferred() }; nextReceipt = gate; gates.push(gate); return gate;
}
async function receipt(route: Route) {
  if (route.request().method() !== 'POST') return route.continue();
  const payload = route.request().postDataJSON(), kind = new URL(route.request().url()).pathname.endsWith('/versions') ? 'statement' : payload.kind;
  const gate = nextReceipt?.kind === kind ? nextReceipt : undefined; if (gate) { gate.payload = payload; nextReceipt = undefined; }
  if (kind === 'proof-submission') {
    candidatePayloads.push(payload); gate?.arrived.resolve(); if (gate) await gate.release.promise;
    // Only the successful save receipt is simulated; this regression never invokes the proof checker.
    return route.fulfill({ status: 201, json: { item: { id: crypto.randomUUID(), kind, text: payload.text } } });
  }
  const response = await route.fetch({ timeout: 0 }); assert.equal(response.status(), 201);
  gate?.arrived.resolve(); if (gate) await gate.release.promise;
  return route.fulfill({ response });
}
await page.route(origin + feedbackRoute, receipt); await page.route(origin + projectRoute + '/versions', receipt);
let failure: unknown, phase = 'candidate-run-switch';
try {
  await signIn(alice); await page.goto(url(), { timeout: 0 }); await expand(proof());
  await baseChoice().selectOption({ index: 1 }); await source().fill(candidateA); await description().fill('Alice original fixed-base explanation');
  const originalCandidate = await readCandidate();
  const runSelect = page.getByRole('combobox', { name: '选择研究运行', exact: true });
  await runSelect.selectOption(runB); await expand(proof()); assert.equal(await source().inputValue(), '');
  await baseChoice().selectOption({ index: 1 }); await source().fill(candidateB); await description().fill('Run B independent explanation');
  await runSelect.selectOption(runA); await expand(proof()); assert.deepEqual(await readCandidate(), originalCandidate);
  await page.reload({ timeout: 0 }); await expand(proof()); assert.deepEqual(await readCandidate(), originalCandidate);
  await screenshot('candidate-switch-refresh.png'); mark('candidate source, change description and exact original base survive two-run switching and refresh');

  phase = 'candidate-stale-base'; saveRun(runA, 2); await page.reload({ timeout: 0 }); await expand(proof());
  assert.deepEqual(await readCandidate(), originalCandidate);
  await proof().getByText('任务或源码已有更新。旧基准和你的编辑已保留，请先核对最新基准。', { exact: true }).waitFor({ timeout: 0 });
  assert.equal(await proof().getByRole('button', { name: '提交检查', exact: true }).isEnabled(), false);
  await screenshot('candidate-stale-base.png');
  await proof().getByRole('button', { name: '更新到最新基准，保留编辑', exact: true }).click();
  assert.equal(await source().inputValue(), candidateA); assert.equal(await description().inputValue(), originalCandidate.text);
  assert.ok((await baseChoice().inputValue()).includes('goal-v2'));
  assert.equal(await proof().getByRole('button', { name: '提交检查', exact: true }).isDisabled(), true, 'a changed baseline needs explicit review');
  await proof().locator('[data-confirm-draft-baseline]').click();
  mark('a newer task leaves restored text and old base intact, disables submission, and changes base only through the existing explicit action');

  phase = 'discussion-statement-refresh';
  const discussionDraft = 'Alice discussion: preserve these exact unsent lines.\n  Including whitespace.';
  await discussionText().fill(discussionDraft); await expand(statement());
  await statement().getByRole('textbox', { name: '自然语言 / TeX 原题', exact: true }).fill('Alice unsent new statement');
  await statement().getByRole('textbox', { name: '完整 Lean 源码', exact: true }).fill('theorem unsent_statement : True := by trivial\n');
  await statement().getByRole('combobox', { name: '证明环境', exact: true }).selectOption('standard');
  await statement().getByRole('textbox', { name: '前提，每行一条', exact: true }).fill('Preserve this assumption');
  await statement().getByRole('textbox', { name: '目标声明，每行：限定名 | 文件', exact: true }).fill('unsent_statement | Main.lean');
  await statement().getByRole('checkbox').check();
  const readStatement = async () => ({ statement: await statement().getByRole('textbox', { name: '自然语言 / TeX 原题', exact: true }).inputValue(),
    source: await statement().getByRole('textbox', { name: '完整 Lean 源码', exact: true }).inputValue(),
    environment: await statement().getByRole('combobox', { name: '证明环境', exact: true }).inputValue(),
    assumptions: await statement().getByRole('textbox', { name: '前提，每行一条', exact: true }).inputValue(),
    targets: await statement().getByRole('textbox', { name: '目标声明，每行：限定名 | 文件', exact: true }).inputValue(), confirmed: await statement().getByRole('checkbox').isChecked() });
  const statementDraft = await readStatement(), candidateBeforeAccount = await readCandidate();
  await page.reload({ timeout: 0 }); await expand(statement());
  assert.equal(await discussionText().inputValue(), discussionDraft); assert.deepEqual(await readStatement(), statementDraft);
  mark('discussion and every new-statement field restore after refresh');

  phase = 'account-isolation'; await auth('POST', '/api/auth/logout', {}); await signIn(bob); await page.reload({ timeout: 0 });
  await expand(statement()); await expand(proof());
  assert.equal(await discussionText().inputValue(), ''); assert.equal(await source().inputValue(), '');
  assert.equal(await statement().getByRole('textbox', { name: '自然语言 / TeX 原题', exact: true }).inputValue(), '');
  await discussionText().fill('Bob independently unsent discussion');
  await statement().getByRole('textbox', { name: '自然语言 / TeX 原题', exact: true }).fill('Bob independent statement');
  await baseChoice().selectOption({ index: 1 }); await source().fill('Bob independent candidate'); await description().fill('Bob explanation');
  await screenshot('bob-independent-drafts.png');
  await auth('POST', '/api/auth/logout', {}); await signIn(alice); await page.reload({ timeout: 0 }); await expand(proof()); await expand(statement());
  assert.equal(await discussionText().inputValue(), discussionDraft); assert.deepEqual(await readStatement(), statementDraft);
  assert.deepEqual(await readCandidate(), candidateBeforeAccount);
  mark('switching accounts in the same tab exposes only the active account drafts and restores the first account drafts on return');

  phase = 'candidate-save-race';
  const candidateGate = hold('proof-submission'); await proof().getByRole('button', { name: '提交检查', exact: true }).click(); await candidateGate.arrived.promise;
  assert.equal(candidateGate.payload.target.observationRef.sequence, 2); assert.equal(candidateGate.payload.target.taskRef.version, 'goal-v2');
  const newerCandidate = candidateA + '-- edited while the prior save receipt was pending\n';
  await source().fill(newerCandidate); await description().fill('Newer unsent candidate description');
  candidateGate.release.resolve(); await proof().getByText('已保存。', { exact: true }).waitFor({ timeout: 0 });
  await page.reload({ timeout: 0 }); await expand(proof()); assert.equal(await source().inputValue(), newerCandidate);
  assert.equal(await description().inputValue(), 'Newer unsent candidate description');
  await proof().getByRole('button', { name: '提交检查', exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('[data-project-proof-draft] textarea') as HTMLTextAreaElement)?.value === '');
  await page.reload({ timeout: 0 }); await expand(proof()); assert.equal(await source().inputValue(), ''); assert.equal(await description().inputValue(), '');
  assert.equal(await baseChoice().inputValue(), '');
  const localHistory = page.locator('#candidate-composer [data-human-drafts] > details').first(); await expand(localHistory);
  const oldCandidate = localHistory.locator('.collaboration-draft').filter({ hasText: 'goal-v1' });
  assert.equal(await oldCandidate.count(), 1, 'an older fixed baseline remains available only through explicit restoration');
  await oldCandidate.locator('[data-restore-draft]').click();
  assert.equal(await source().inputValue(), candidateA); assert.ok((await baseChoice().inputValue()).includes('goal-v1'));
  assert.equal(await proof().getByRole('button', { name: '提交检查', exact: true }).isDisabled(), true);
  await page.reload({ timeout: 0 }); await expand(proof()); assert.equal(await source().inputValue(), candidateA);
  mark('a candidate save receipt keeps later edits; unchanged success clears the active draft, while older baselines stay available for explicit reviewed restoration');

  phase = 'discussion-save-race';
  const discussionGate = hold('discussion'); await discussion().getByRole('button', { name: '保存讨论', exact: true }).click(); await discussionGate.arrived.promise;
  await discussionText().fill('Newer unsent discussion written while saving'); discussionGate.release.resolve();
  await discussion().getByText('已保存。', { exact: true }).waitFor({ timeout: 0 }); await page.reload({ timeout: 0 });
  assert.equal(await discussionText().inputValue(), 'Newer unsent discussion written while saving');
  await discussion().getByRole('button', { name: '保存讨论', exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('#research-discussion form textarea') as HTMLTextAreaElement)?.value === '');
  await page.reload({ timeout: 0 }); assert.equal(await discussionText().inputValue(), '');
  await discussionText().fill('A later local discussion that the author clears'); await discussionText().fill('');
  await page.reload({ timeout: 0 }); assert.equal(await discussionText().inputValue(), '');
  mark('a real discussion save preserves later edits, clears unchanged submissions, and keeps explicitly erased local text empty after refresh');

  phase = 'statement-save-race'; await expand(statement());
  const statementGate = hold('statement'); await statement().getByRole('button', { name: '保存新版本', exact: true }).click(); await statementGate.arrived.promise;
  await statement().getByRole('textbox', { name: '自然语言 / TeX 原题', exact: true }).fill('Newer unsent statement while saving');
  await statement().getByRole('textbox', { name: '完整 Lean 源码', exact: true }).fill('theorem newer_statement : True := by trivial\n');
  await statement().getByRole('textbox', { name: '目标声明，每行：限定名 | 文件', exact: true }).fill('newer_statement | Main.lean');
  const newerStatement = await readStatement(); statementGate.release.resolve();
  await statement().getByText('陈述版本已保存，期间的新编辑已保留。', { exact: true }).waitFor({ timeout: 0 });
  await page.reload({ timeout: 0 }); await expand(statement()); assert.deepEqual(await readStatement(), newerStatement);
  await screenshot('newer-statement-after-save-refresh.png');
  await statement().getByRole('checkbox').check();
  await statement().getByRole('button', { name: '保存新版本', exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('[data-project-statement-draft] textarea') as HTMLTextAreaElement)?.value === '');
  await page.reload({ timeout: 0 }); await expand(statement());
  assert.equal(await statement().getByRole('textbox', { name: '自然语言 / TeX 原题', exact: true }).inputValue(), '');
  assert.equal(await statement().getByRole('textbox', { name: '完整 Lean 源码', exact: true }).inputValue(), '');
  mark('a real statement save preserves all later edits across refresh and removes an unchanged successful draft');
  assert.equal(candidatePayloads.length, 2); assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(forbiddenCalls, []);
} catch (error) { failure = error; await screenshot('failure.png').catch(() => undefined); }
finally {
  for (const gate of gates) gate.release.resolve(); await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: now(), checks, screenshots,
    errors, external, forbiddenCalls, candidateReceiptFixtures: candidatePayloads.length, browserTimeouts: 0, deadline: null, tokenLimit: null, roundLimit: null,
    realModelCalls: 0, realLeanProcesses: 0, externalMail: false, fixturesRemoved: true,
    ...(failure ? { phase, error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2) + '\n');
}
if (failure) throw failure;
console.log(JSON.stringify({ status: 'passed', checks: checks.length, screenshots: screenshots.length, output }));
