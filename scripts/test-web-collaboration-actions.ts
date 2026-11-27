#!/usr/bin/env bun
// Chromium + disposable HTTP state; controlled checks fail without running Lean or models.
import { seedCooperativeRun } from './web-cooperative-fixture';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebObservation } from '../apps/web/collaboration';
import type { ResearchFeedback, ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import type { ResearchCollaborationInbox, ResearchIssue } from '../apps/web/researchCollaborationTypes';
import { freePort, startBrowser, preferFullCollaboration, settled } from './web-scenario';
import { mathDigest } from '../src/math/mathRuntimeIo';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/product-continuity/collaboration-actions');
await fs.access(path.join(root, 'out/web/research.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-collaboration-actions-'));
const source = 'theorem plan_access_fixture : True := by sorry\n', commit = '1'.repeat(40), environment = 'e'.repeat(64);
const now = () => new Date().toISOString(), hash = mathDigest;
const controls = new Map<string, { observation: WebObservation; finish(): void; emit(): void }>();
const commands: string[] = [];
const checks: object[] = [], errors: string[] = [], external: string[] = [], mail: unknown[] = [];
let phase = 'setup', controlledChecks = 0;
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
  async readiness() { return { ready: true, message: 'Disposable collaboration workflow' }; },
  async check() { controlledChecks++; return { exitCode: 1, timedOut: false, output: 'Main.lean:1:1: error: controlled fixture did not run Lean' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const observed = observation(input.id); observed.sources = [{ taskId: 'goal', taskVersion: 'goal-v1', commit, source, sourceDigest: hash(source), environmentDigest: environment, file: 'Main.lean', scope: 'owned-file' }];
      const control = { observation: observed, finish: resolve, emit() { this.observation.observedAt = now(); send({ type: 'observation', observation: structuredClone(this.observation) }); } };
      controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true }); control.emit();
    });
  },
  async command(_runId, command) {
    if (command.type === 'capture') return { id: 'capture', status: 'captured' };
    commands.push(command.type);
    throw new Error('A historical run must not receive scheduler commands');
  },
};
const port = await freePort(), origin = 'http://127.0.0.1:' + port;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '4' }), runner,
{ sample: null, mailer: async message => { mail.push(message); throw new Error('No external mail allowed'); } });
const browser = await startBrowser(service.server, port), actors = await Promise.all([0, 1, 2].map(() => browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })));
for (const actor of actors) {
  await preferFullCollaboration(actor);
  actor.on('page', page => { page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message)); });
  await actor.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
}
const [owner, peer, visitor] = await Promise.all(actors.map(actor => actor.newPage()));
async function http<T>(actor: Page, method: string, pathname: string, input?: unknown): Promise<T> {
  return actor.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); if (!response.ok) throw new Error('Fixture HTTP ' + response.status + ': ' + body.error); return body;
  }, { method, pathname, input }) as Promise<T>;
}
const reply = (page: Page, method: string, pathname: string) => page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === pathname);
async function save(page: Page, method: string, pathname: string, action: () => Promise<unknown>, expected = 200) { const response = reply(page, method, pathname); await action(); assert.equal((await response).status(), expected); }
async function open(page: Page, href: string) { await page.goto(origin + '/' + href); await page.locator('main[aria-busy="false"]').waitFor(); }
try {
  await Promise.all([owner, peer, visitor].map(page => open(page, 'theorems.html')));
  const sessions = await Promise.all([owner, peer, visitor].map(page => http<{ researcherId: string }>(page, 'GET', '/api/research/session')));
  for (const [index, page] of [owner, peer, visitor].entries()) await http(page, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(), expectedRevision: 0, displayName: ['Owner', 'Peer', 'Other'][index], visibility: 'public' });
  let project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', '/api/research/theorems', { requestId: crypto.randomUUID(), title: '决议执行与人工评审', visibility: 'members' })).item;
  const projectPath = '/api/research/theorems/' + project.id;
  for (const person of sessions.slice(1)) project = (await http<{ item: ResearchProjectDetail }>(owner, 'PUT', `${projectPath}/members/${person.researcherId}`, { requestId: crypto.randomUUID(), role: 'collaborator', expectedRevision: project.revision })).item;
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', projectPath + '/versions', { requestId: crypto.randomUUID(), expectedRevision: project.revision, statement: 'Prove True', source, environment: 'standard' })).item;
  const version = project.currentStatementVersionId!;
  const createdRun = await seedCooperativeRun(service, owner.context(), origin, { providerId: 'openai', apiKey: 'sk-disposable-actions', model: 'fixture', effort: 'low', environment: 'standard', source, task: 'Collaboration actions', maxTurns: 2, maxRunSeconds: 600, workers: 2, coordination: 'cooperative' });
  for (let attempt = 0; attempt < 100 && !controls.has(createdRun.id); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  const control = controls.get(createdRun.id)!; assert.ok(control);
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', projectPath + '/runs', { requestId: crypto.randomUUID(), expectedRevision: project.revision, statementVersionId: version, runId: createdRun.id, exposure: 'members', grants: { guidance: true, edit: true, approve: true, proof: true } })).item;
  const href = `theorems.html?id=${project.id}&version=${version}&run=${createdRun.id}&task=goal&taskVersion=goal-v1`;
  const target = { runId: createdRun.id, statementVersionId: version, observationRef: { sequence: 1, stateDigest: control.observation.snapshot.stateDigest }, taskRef: { id: 'goal', version: 'goal-v1' } };

  phase = 'issue-draft-reload-and-account-isolation';
  await open(owner, href); await owner.locator('[data-task-workspace]').getByRole('button', { name: '就此任务发起议题', exact: true }).click();
  const issues = owner.locator('#collaboration-issues');
  await issues.getByLabel('需要共同决定的问题').fill('如何从辅助引理推出 $Q$？');
  await issues.getByLabel('背景、分歧与已有证据').fill('保留原任务版本，比较两种连接方法');
  await open(owner, href); await issues.getByText('发起议题', { exact: true }).click();
  await issues.locator('[data-human-drafts] summary').click(); await issues.locator('[data-restore-draft]').click();
  assert.equal(await issues.getByLabel('需要共同决定的问题').inputValue(), '如何从辅助引理推出 $Q$？');
  await open(peer, href); await peer.locator('#collaboration-issues').getByText('发起议题', { exact: true }).click();
  assert.equal(await peer.locator('#collaboration-issues [data-restore-draft]').count(), 0);
  const createIssue = reply(owner, 'POST', projectPath + '/issues'); await issues.getByRole('button', { name: '保存议题', exact: true }).click();
  const issue = (await (await createIssue).json() as { item: ResearchIssue }).item; assert.deepEqual(issue.target, target);
  checks.push({ name: phase, frozenTaskRecovered: true, otherAccountDraftVisible: false });

  phase = 'reply-draft-stale-revision-review'; await open(peer, href);
  const peerIssue = peer.locator('#issue-' + issue.id);
  await peerIssue.getByText('补充意见或记录决议', { exact: true }).click(); await peerIssue.getByLabel('内容类型').selectOption('proposal');
  await peerIssue.getByLabel('补充内容').fill('先应用辅助引理，再消去最后一个前提');
  await http(owner, 'POST', `${projectPath}/issues/${issue.id}/replies`, { requestId: crypto.randomUUID(), expectedRevision: issue.revision, kind: 'comment', text: '请明确最后一步的连接依据' });
  await open(peer, href); await peerIssue.getByText('补充意见或记录决议', { exact: true }).click();
  await peerIssue.locator('[data-human-drafts] summary').click(); await peerIssue.locator('[data-restore-draft]').click();
  assert.equal(await peerIssue.getByLabel('补充内容').inputValue(), '先应用辅助引理，再消去最后一个前提');
  assert.equal(await peerIssue.getByRole('button', { name: '提交意见', exact: true }).isDisabled(), true);
  await peerIssue.getByRole('button', { name: '已核对，基于最新议题继续', exact: true }).click();
  await save(peer, 'POST', `${projectPath}/issues/${issue.id}/replies`, () => peerIssue.getByRole('button', { name: '提交意见', exact: true }).click());
  let currentIssue = (await http<{ item: { issues: ResearchIssue[] } }>(owner, 'GET', projectPath + '/collaboration')).item.issues[0];
  const proposal = currentIssue.replies.find(item => item.kind === 'proposal')!;
  currentIssue = (await http<{ item: ResearchIssue }>(owner, 'POST', `${projectPath}/issues/${issue.id}/resolution`, { requestId: crypto.randomUUID(), expectedRevision: currentIssue.revision, action: 'resolve', proposalId: proposal.id, text: '采用辅助引理后消去前提的路线' })).item;
  checks.push({ name: phase, exactRevisionRecovered: true, staleSubmissionBlocked: true, explicitReview: true });

  phase = 'historical-issue-execution-is-read-only';
  const resolution = currentIssue.resolution!;
  const issueSource = { issueId: issue.id, issueRevision: currentIssue.revision,
    resolutionAt: resolution.createdAt, proposalId: proposal.id };
  const historicalFeedback: ResearchFeedback = {
    id: 'historical-guidance', requestId: crypto.randomUUID(), projectId: project.id,
    author: resolution.author, kind: 'guidance', text: '历史指导：用辅助引理完成最后一步', visibility: 'members',
    issueSource: { ...issueSource, title: issue.title, resolution: { text: resolution.text, author: resolution.author },
      proposal: { id: proposal.id, text: proposal.text, author: proposal.author }, originalTarget: target },
    target, payload: { recipient: { kind: 'task', id: 'goal' } }, delivery: { status: 'delivered', commandId: 'historical-guidance' },
    decision: { status: 'pending', evidenceRefs: [] }, execution: { status: 'not-started', taskRefs: [], resultRefs: [] },
    revision: 1, createdAt: resolution.createdAt, updatedAt: resolution.createdAt,
  };
  const projectRecord = ['research', 'projects', `${project.id}.json`];
  const stored = service.storage.getRecord<{ feedback: ResearchFeedback[] }>(projectRecord)!;
  stored.feedback.push(historicalFeedback);
  service.storage.saveRecord(projectRecord, stored);
  await open(owner, href);
  const issueAnchor = '#issue-' + issue.id;
  const resolvedIssue = owner.locator(issueAnchor);
  await resolvedIssue.getByText(resolution.text, { exact: true }).waitFor();
  assert.equal(await resolvedIssue.locator('[data-prepare-issue-execution]').count(), 0);
  const record = owner.locator('#feedback-' + historicalFeedback.id);
  await record.locator('[data-feedback-issue-source] summary').click();
  await record.getByText(proposal.text, { exact: true }).waitFor();
  assert.equal(await record.getByRole('link', { name: '查看议题', exact: true }).getAttribute('href'), issueAnchor);
  const session = await http<{ csrfToken: string }>(owner, 'GET', '/api/session');
  const legacyMutation = await owner.request.post(origin + projectPath + '/feedback', {
    headers: { 'X-CSRF-Token': session.csrfToken },
    data: { requestId: crypto.randomUUID(), kind: 'guidance', text: '继续历史运行', issueSource, target, recipient: { kind: 'task', id: 'goal' } },
  });
  assert.equal(legacyMutation.status(), 409);
  assert.deepEqual(commands, []);
  checks.push({ name: phase, frozenOriginVisible: true, legacyWriteRejected: true });

  phase = 'review-ownership-and-personal-inbox';
  const feedback = (await http<{ item: ResearchProjectDetail['feedback'][number] }>(owner, 'POST', projectPath + '/feedback', { requestId: crypto.randomUUID(), kind: 'discussion', text: '请评审这一步 $P \\Rightarrow Q$', statementVersionId: version })).item;
  await open(owner, href); const ownerFeedback = owner.locator('#feedback-' + feedback.id);
  await ownerFeedback.locator('[data-reviewer-select]').selectOption(sessions[1].researcherId);
  await save(owner, 'POST', `${projectPath}/feedback/${feedback.id}/review`, () => ownerFeedback.getByRole('button', { name: '确认分配', exact: true }).click());
  const inboxPath = '/api/research/collaboration/inbox';
  const peerInbox = (await http<ResearchCollaborationInbox>(peer, 'GET', inboxPath)).items.find(item => item.kind === 'review' && item.href.includes(feedback.id))!;
  assert.ok(peerInbox); assert.equal((await http<ResearchCollaborationInbox>(visitor, 'GET', inboxPath)).items.some(item => item.kind === 'review' && item.href.includes(feedback.id)), false);
  await http(peer, 'POST', inboxPath + '/' + encodeURIComponent(peerInbox.id), { requestId: crypto.randomUUID(), action: 'done' });
  const takeover = await visitor.evaluate(async ({ path, revision }) => { const session = await (await fetch('/api/session')).json(); return (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ requestId: crypto.randomUUID(), action: 'claim', expectedRevision: revision }) })).status; }, { path: `${projectPath}/feedback/${feedback.id}/review`, revision: feedback.revision + 1 });
  assert.equal(takeover, 403); checks.push({ name: phase, onlyAssignedReviewerInbox: true, takeoverRejected: 403 });

  phase = 'needs-info-resubmit-and-review-transfer'; await open(peer, href);
  const peerFeedback = peer.locator('#feedback-' + feedback.id); await peerFeedback.getByText('记录采纳决定', { exact: true }).click();
  await peerFeedback.getByLabel('决定').selectOption('needs-info'); await peerFeedback.getByLabel('理由', { exact: true }).fill('请补充从前提推出目标的具体一步');
  await save(peer, 'POST', `${projectPath}/feedback/${feedback.id}/decision`, () => peerFeedback.getByRole('button', { name: '保存决定', exact: true }).click());
  await open(owner, href); await ownerFeedback.getByLabel('补充推导、说明或证据').fill('将归纳假设代入辅助引理，消去前提即可得到目标');
  await save(owner, 'POST', `${projectPath}/feedback/${feedback.id}/review`, () => ownerFeedback.getByRole('button', { name: '补充并重新送审', exact: true }).click());
  const renewed = (await http<ResearchCollaborationInbox>(peer, 'GET', inboxPath)).items.find(item => item.kind === 'review' && item.href.includes(feedback.id))!;
  assert.ok(renewed); assert.notEqual(renewed.id, peerInbox.id); assert.equal(renewed.processed, false);
  await open(peer, href); await peerFeedback.locator('[data-reviewer-select]').selectOption(sessions[2].researcherId);
  await save(peer, 'POST', `${projectPath}/feedback/${feedback.id}/review`, () => peerFeedback.getByRole('button', { name: '确认移交', exact: true }).click());
  assert.equal((await http<ResearchCollaborationInbox>(peer, 'GET', inboxPath)).items.some(item => item.kind === 'review' && item.href.includes(feedback.id)), false);
  assert.equal((await http<ResearchCollaborationInbox>(visitor, 'GET', inboxPath)).items.some(item => item.kind === 'review' && item.href.includes(feedback.id)), true);
  const afterReview = (await http<{ item: ResearchProjectDetail }>(owner, 'GET', projectPath)).item.feedback.find(item => item.id === feedback.id)!;
  assert.ok(afterReview.reviewHistory?.some(item => item.text?.includes('归纳假设'))); assert.equal(afterReview.decision.status, 'pending');
  checks.push({ name: phase, resubmissionRevivesInbox: true, supplementPersisted: true, transferMovesResponsibility: true });

  phase = 'candidate-draft-obsolete-baseline-review'; await open(owner, href);
  await owner.locator('[data-task-workspace]').getByRole('button', { name: '编写候选并送评审', exact: true }).click();
  const candidate = owner.locator('[data-candidate-composer]'), candidateText = 'theorem plan_access_fixture : True := by trivial\n';
  await candidate.getByLabel('修改后的候选源码').fill(candidateText); await candidate.getByLabel('修改说明').fill('候选草稿必须保留原基准');
  control.observation.sequence++; control.observation.snapshot.stateDigest = hash('new-task-source'); control.observation.inspection.snapshot.stateDigest = control.observation.snapshot.stateDigest;
  control.observation.inspection.tasks.find(task => task.id === 'goal')!.version = 'goal-v2';
  control.observation.sources[0] = { ...control.observation.sources[0], taskVersion: 'goal-v2', commit: '2'.repeat(40), source: source + '-- new baseline\n', sourceDigest: hash(source + '-- new baseline\n') }; control.emit();
  await open(owner, href); await candidate.getByText('提交候选证明', { exact: true }).click(); await candidate.locator('[data-human-drafts] summary').click(); await candidate.locator('[data-restore-draft]').click();
  assert.equal(await candidate.getByLabel('修改后的候选源码').inputValue(), candidateText);
  assert.ok((await candidate.getByLabel('选择带有源码快照的任务').inputValue()).includes(commit));
  assert.equal(await candidate.getByRole('button', { name: '提交检查', exact: true }).isDisabled(), true);
  await candidate.getByRole('button', { name: '更新到最新基准，保留编辑', exact: true }).click();
  assert.equal(await candidate.getByLabel('修改后的候选源码').inputValue(), candidateText);
  assert.equal(await candidate.getByRole('button', { name: '提交检查', exact: true }).isDisabled(), true);
  await candidate.locator('[data-confirm-draft-baseline]').click();
  await save(owner, 'POST', projectPath + '/feedback', () => candidate.getByRole('button', { name: '提交检查', exact: true }).click(), 201);
  const candidateRecord = (await http<{ item: ResearchProjectDetail }>(owner, 'GET', projectPath)).item.feedback.find(item => item.kind === 'proof-submission')!;
  assert.equal(candidateRecord.target?.taskRef?.version, 'goal-v2'); assert.equal(candidateRecord.proofCheck?.status, 'failed');
  assert.equal(candidateRecord.payload && 'base' in candidateRecord.payload ? candidateRecord.payload.base.commit : '', '2'.repeat(40));
  checks.push({ name: phase, frozenOldSourceRestored: true, editsRetainedAfterRebase: true, explicitBaselineReview: true, proofAccepted: false });

  phase = 'mobile-workflow-layout'; await owner.setViewportSize({ width: 390, height: 844 }); await settled(owner);
  await owner.screenshot({ path: path.join(output, 'mobile-workflow.png'), fullPage: true });
  assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  checks.push({ name: phase, horizontalOverflow: false });
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(mail, []); assert.equal(controlledChecks, 1);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, commands, controlledChecks, realLean: 0, realModels: 0, externalMail: 0, productionTouched: false, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', scenarios: checks.length, output }));
} catch (error) {
  await Promise.all([owner, peer, visitor].map((page, index) => page.screenshot({ path: path.join(output, 'failure-' + index + '.png'), fullPage: true }).catch(() => {})));
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ phase, error: String(error), checks, errors, external }, null, 2) + '\n'); throw error;
} finally {
  for (const control of controls.values()) control.finish();
  await Promise.all(actors.map(actor => actor.close())); await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
