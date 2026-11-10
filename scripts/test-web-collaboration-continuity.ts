#!/usr/bin/env bun
// Chromium + disposable HTTP state; controlled checks fail without running Lean or models.
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
import type { ResearchCollaborationInbox, ResearchIssue } from '../apps/web/researchCollaborationTypes';
import { freePort, startBrowser, preferFullCollaboration, settled } from './web-scenario';
import { mathDigest } from '../src/math/mathRuntimeIo';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/product-continuity/collaboration');
await fs.access(path.join(root, 'out/web/research.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-collaboration-continuity-'));
const source = 'theorem plan_access_fixture : True := by sorry\n', commit = '1'.repeat(40), environment = 'e'.repeat(64);
const now = () => new Date().toISOString(), hash = mathDigest;
const controls = new Map<string, { observation: WebObservation; finish(): void; emit(): void }>();
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
  async command(_runId, command) { throw new Error('This scenario must not dispatch solver commands: ' + command.type); },
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
  for (const [index, page] of [owner, peer, visitor].entries()) await http(page, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(), expectedRevision: 0, displayName: ['Owner', 'Peer', 'Visitor'][index], visibility: 'public', fields: ['algebra'] });
  let project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', '/api/research/theorems', { requestId: crypto.randomUUID(), title: '协作连续流程', visibility: 'private' })).item;
  const projectPath = '/api/research/theorems/' + project.id;
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', projectPath + '/versions', { requestId: crypto.randomUUID(), expectedRevision: project.revision, statement: 'Prove True', source, environment: 'standard' })).item;
  const version = project.currentStatementVersionId!;
  const createdRun = (await http<{ run: { id: string } }>(owner, 'POST', '/api/runs', { requestId: crypto.randomUUID(), providerId: 'openai', apiKey: 'sk-disposable-collaboration', model: 'fixture', effort: 'low', environment: 'standard', source, task: 'Collaboration continuity', maxTurns: 2, maxRunSeconds: 600, workers: 2, coordination: 'cooperative' })).run;
  for (let attempt = 0; attempt < 100 && !controls.has(createdRun.id); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(controls.has(createdRun.id));
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', projectPath + '/runs', { requestId: crypto.randomUUID(), expectedRevision: project.revision, statementVersionId: version, runId: createdRun.id, exposure: 'members', grants: { guidance: true, edit: true, approve: true, proof: true } })).item;
  const href = `theorems.html?id=${project.id}&version=${version}&run=${createdRun.id}&task=goal&taskVersion=goal-v1`;
  phase = 'invitation-private-boundary';
  await open(owner, href);
  const membership = owner.locator('#collaboration-members'); await membership.getByText('邀请同行参与', { exact: true }).click();
  await membership.getByLabel('选择数学家').selectOption(sessions[1].researcherId); await membership.getByLabel('希望共同推进什么').fill('一起检查精确任务版本');
  await save(owner, 'POST', projectPath + '/invitations', () => membership.getByRole('button', { name: '发送站内邀请', exact: true }).click(), 201);
  const denied = await peer.evaluate(async path => (await fetch(path)).status, projectPath); assert.equal(denied, 404);
  await open(peer, 'workspace.html?tab=inbox'); const inbox = peer.locator('[data-collaboration-inbox]');
  const invitation = inbox.locator('[data-inbox-item^="invitation:"]'); await invitation.waitFor();
  assert.equal(await invitation.getByRole('link', { name: '打开并继续' }).count(), 0);
  const invitationId = (await invitation.getAttribute('data-inbox-item'))!.slice('invitation:'.length);
  const csrf = await peer.evaluate(async ({ pathname }) => (await fetch(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), action: 'accept', expectedRevision: 0 }) })).status, { pathname: projectPath + '/invitations/' + invitationId + '/respond' }); assert.equal(csrf, 403);
  await save(peer, 'POST', projectPath + '/invitations/' + invitationId + '/respond', () => invitation.getByRole('button', { name: '接受', exact: true }).click());
  assert.equal((await http<{ item: ResearchProjectDetail }>(peer, 'GET', projectPath)).item.permissions.edit, true);
  checks.push({ name: phase, privateBeforeAccept: 404, csrfRejected: 403, acceptedRole: 'collaborator' });

  phase = 'claim-candidate-review'; await open(owner, href); const workspace = owner.locator('[data-task-workspace]');
  await workspace.getByLabel('正在处理的任务').selectOption(JSON.stringify(['lemma', 'lemma-v1']));
  await owner.locator('[data-inspected-task-heading]').filter({ hasText: 'lemma' }).waitFor();
  await workspace.getByLabel('正在处理的任务').selectOption(JSON.stringify(['goal', 'goal-v1']));
  await owner.locator('[data-inspected-task-heading]').filter({ hasText: 'goal' }).waitFor();
  await save(owner, 'POST', projectPath + '/assignments', () => workspace.getByRole('button', { name: '认领此任务', exact: true }).click());
  await workspace.getByRole('button', { name: '由我认领', exact: true }).waitFor();
  await workspace.getByRole('button', { name: '编写候选并送评审', exact: true }).click();
  const candidate = owner.locator('[data-candidate-composer]');
  await owner.waitForFunction(commit => (document.querySelector('[data-candidate-composer] select') as HTMLSelectElement)?.value.includes(commit), commit);
  assert.ok((await candidate.getByLabel('选择带有源码快照的任务').inputValue()).includes(commit));
  await candidate.getByLabel('修改后的候选源码').fill('theorem plan_access_fixture : True := by trivial\n'); await candidate.getByLabel('修改说明').fill('候选交由独立检查，测试检查器会拒绝');
  await save(owner, 'POST', projectPath + '/feedback', () => candidate.getByRole('button', { name: '提交检查', exact: true }).click(), 201);
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'GET', projectPath)).item;
  const submitted = project.feedback.find(item => item.kind === 'proof-submission')!; assert.ok(submitted); assert.equal(submitted.proofCheck?.status, 'failed');
  assert.equal(project.assignments.find(item => item.author.id === sessions[0].researcherId)?.feedbackId, submitted.id);
  await owner.locator('#feedback-' + submitted.id).waitFor({ state: 'visible' });
  checks.push({ name: phase, nodeSelectionSynced: true, claimAutoLinked: true, controlledCheck: 'failed', proofAccepted: false });

  phase = 'confirmed-handoff'; await open(owner, href);
  await save(owner, 'POST', projectPath + '/assignments', () => workspace.getByRole('button', { name: '认领此任务', exact: true }).click());
  await workspace.getByText('正式交接给同行', { exact: true }).click(); await workspace.getByLabel('接手人').selectOption(sessions[1].researcherId);
  await workspace.getByLabel('已有结果、未解问题与下一步').fill('已有候选未过检查，请沿精确基准补全');
  const handoffResponse = reply(owner, 'POST', projectPath + '/handoffs'); await workspace.getByRole('button', { name: '发起交接，等待确认', exact: true }).click();
  const handoffBody = await (await handoffResponse).json(); assert.ok(handoffBody.item.id);
  assert.equal((await http<{ item: ResearchProjectDetail }>(owner, 'GET', projectPath)).item.assignments.find(item => item.author.id === sessions[0].researcherId)?.status, 'claimed');
  await open(peer, href); await save(peer, 'POST', projectPath + '/handoffs/' + handoffBody.item.id + '/respond', () => peer.locator('[data-task-workspace]').getByRole('button', { name: '确认接手', exact: true }).click());
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'GET', projectPath)).item;
  assert.equal(project.assignments.find(item => item.author.id === sessions[0].researcherId)?.status, 'released'); assert.equal(project.assignments.find(item => item.author.id === sessions[1].researcherId)?.status, 'claimed');
  checks.push({ name: phase, senderReleasedAfterAcceptance: true, recipientClaimed: true });

  phase = 'issue-proposal-resolution'; await open(owner, href);
  await owner.locator('#feedback-' + submitted.id).getByRole('button', { name: '就此反馈发起议题', exact: true }).click();
  const issues = owner.locator('#collaboration-issues'); await issues.getByLabel('需要共同决定的问题').fill('如何补齐 $P \\Rightarrow Q$？');
  await issues.getByLabel('背景、分歧与已有证据').fill('从当前候选的失败结果讨论下一步 $\\alpha + \\beta$');
  const issueResponse = reply(owner, 'POST', projectPath + '/issues'); await issues.getByRole('button', { name: '保存议题', exact: true }).click();
  const issue = ((await (await issueResponse).json()) as { item: ResearchIssue }).item; assert.equal(issue.sourceFeedbackId, submitted.id);
  await open(peer, href); const peerIssue = peer.locator('#issue-' + issue.id); await peerIssue.getByText('补充意见或记录决议', { exact: true }).click();
  await peerIssue.locator('h4 .katex').waitFor(); assert.equal(await peerIssue.locator('h4 .katex-error').count(), 0);
  await peerIssue.getByLabel('内容类型').selectOption('proposal'); await peerIssue.getByLabel('补充内容').fill('将前提拆为两个引理，再连接原始目标');
  await save(peer, 'POST', projectPath + '/issues/' + issue.id + '/replies', () => peerIssue.getByRole('button', { name: '提交意见', exact: true }).click());
  await open(owner, href); const ownerIssue = owner.locator('#issue-' + issue.id); await ownerIssue.getByText('补充意见或记录决议', { exact: true }).click();
  const proposal = (await http<{ item: { issues: ResearchIssue[] } }>(owner, 'GET', projectPath + '/collaboration')).item.issues.find(item => item.id === issue.id)!.replies[0];
  await ownerIssue.getByLabel('采用的方案（可选）').selectOption(proposal.id); await ownerIssue.getByLabel('补充内容').fill('采用拆分引理的方案，保留原始候选供比较');
  await save(owner, 'POST', projectPath + '/issues/' + issue.id + '/resolution', () => ownerIssue.getByRole('button', { name: '记录决议', exact: true }).click());
  await ownerIssue.getByText('已形成决议', { exact: true }).waitFor();
  await owner.getByLabel('搜索反馈与证据').fill('no-feedback-matches'); assert.equal(await owner.locator('#feedback-' + submitted.id).isVisible(), false);
  await ownerIssue.getByRole('link', { name: '查看来源反馈', exact: true }).click(); await owner.locator('#feedback-' + submitted.id).waitFor({ state: 'visible' });
  checks.push({ name: phase, sourceFeedback: true, mathTitleRendered: true, proposalSelected: true, resolutionPersisted: true, hiddenFeedbackRevealed: true });

  phase = 'issue-revision-and-decision-history';
  await ownerIssue.getByLabel('补充内容').fill('新的边界情形需要重新核对');
  await save(owner, 'POST', projectPath + '/issues/' + issue.id + '/resolution', () => ownerIssue.getByRole('button', { name: '重新打开议题', exact: true }).click());
  await open(peer, href); await peerIssue.getByText('补充意见或记录决议', { exact: true }).click();
  const draft = '保留这段尚未提交的讨论草稿'; await peerIssue.getByLabel('补充内容').fill(draft);
  const before = (await http<{ item: { issues: ResearchIssue[] } }>(owner, 'GET', projectPath + '/collaboration')).item.issues.find(item => item.id === issue.id)!;
  await http(owner, 'POST', projectPath + '/issues/' + issue.id + '/replies', { requestId: crypto.randomUUID(), expectedRevision: before.revision, kind: 'comment', text: '新异议已补充，请先核对' });
  await peerIssue.getByText('议题已有更新，草稿已保留。请先查看新回复或决议。', { exact: false }).waitFor({ timeout: 20000 });
  assert.equal(await peerIssue.getByLabel('补充内容').inputValue(), draft);
  assert.equal(await peerIssue.getByRole('button', { name: '提交意见', exact: true }).isDisabled(), true);
  assert.equal(await peerIssue.getByRole('button', { name: '记录决议', exact: true }).isDisabled(), true);
  await peerIssue.getByRole('button', { name: '已核对，基于最新议题继续', exact: true }).click();
  await save(peer, 'POST', projectPath + '/issues/' + issue.id + '/replies', () => peerIssue.getByRole('button', { name: '提交意见', exact: true }).click());
  await open(owner, href); await ownerIssue.getByText('历次决议与重新讨论', { exact: true }).click(); await ownerIssue.getByText('采用拆分引理的方案，保留原始候选供比较', { exact: true }).waitFor();
  await ownerIssue.getByText('补充意见或记录决议', { exact: true }).click(); await ownerIssue.getByLabel('补充内容').fill('新回复已核对，继续采用原方案');
  await save(owner, 'POST', projectPath + '/issues/' + issue.id + '/resolution', () => ownerIssue.getByRole('button', { name: '记录决议', exact: true }).click());
  checks.push({ name: phase, draftPreserved: true, staleDecisionBlocked: true, explicitRevisionAcknowledgement: true, originalResolutionRetained: true });

  phase = 'inbox-read-vs-processed'; await open(peer, 'workspace.html?tab=inbox');
  const claim = inbox.locator('[data-inbox-item^="claim:"]'); await claim.waitFor(); const claimKey = (await claim.getAttribute('data-inbox-item'))!;
  await save(peer, 'POST', '/api/research/collaboration/inbox/' + encodeURIComponent(claimKey), () => claim.getByRole('button', { name: '标为已读', exact: true }).click());
  let claimState = (await http<ResearchCollaborationInbox>(peer, 'GET', '/api/research/collaboration/inbox')).items.find(item => item.id === claimKey)!;
  assert.equal(claimState.read, true); assert.equal(claimState.processed, false);
  await save(peer, 'POST', '/api/research/collaboration/inbox/' + encodeURIComponent(claimKey), () => claim.getByRole('button', { name: '从我的待办收起', exact: true }).click());
  await open(peer, 'workspace.html?tab=inbox'); await inbox.getByRole('button', { name: '已处理', exact: true }).click(); await inbox.locator('[data-inbox-item="' + claimKey + '"]').waitFor();
  claimState = (await http<ResearchCollaborationInbox>(peer, 'GET', '/api/research/collaboration/inbox')).items.find(item => item.id === claimKey)!; assert.equal(claimState.processed, true);
  assert.equal(new URL(claimState.href, origin).searchParams.get('taskVersion'), 'goal-v1');
  checks.push({ name: phase, independentReadState: true, processedPersistedAfterReload: true, preciseTaskLink: true });

  phase = 'public-application-accept-and-decline'; project = (await http<{ item: ResearchProjectDetail }>(owner, 'GET', projectPath)).item;
  await http(owner, 'PATCH', projectPath, { requestId: crypto.randomUUID(), expectedRevision: project.revision, visibility: 'public' });
  for (const response of ['拒绝', '接受']) {
    await open(visitor, 'theorems.html?id=' + project.id); const visitorMembership = visitor.locator('#collaboration-members');
    await visitorMembership.getByText('申请加入研究', { exact: true }).click(); await visitorMembership.getByLabel('想参与的方向与可提供的帮助').fill('希望只读复核已有推导');
    await visitorMembership.getByLabel('希望以何种方式参与').selectOption('reader');
    await save(visitor, 'POST', projectPath + '/join-requests', () => visitorMembership.getByRole('button', { name: '提交加入申请', exact: true }).click(), 201);
    await open(owner, href); const application = membership.locator('.collaboration-request').filter({ hasText: '希望只读复核已有推导' }).last();
    const responseWait = owner.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/respond'));
    await application.getByRole('button', { name: response, exact: true }).click(); assert.equal((await responseWait).status(), 200);
  }
  assert.equal((await http<{ item: ResearchProjectDetail }>(visitor, 'GET', projectPath)).item.permissions.edit, false);
  await open(visitor, 'theorems.html?id=' + project.id); assert.equal(await visitor.locator('#issue-' + issue.id).getByText('重新讨论', { exact: true }).count(), 0);
  checks.push({ name: phase, declineThenAccept: true, readerCannotEdit: true });

  phase = 'same-task-version-exact-source';
  const control = controls.get(createdRun.id)!; control.observation.sequence++; control.observation.snapshot.stateDigest = hash('source-update'); control.observation.inspection.snapshot.stateDigest = control.observation.snapshot.stateDigest;
  control.observation.sources[0] = { ...control.observation.sources[0], commit: '2'.repeat(40), source: source + '-- NEW_SOURCE_SNAPSHOT\n', sourceDigest: hash(source + '-- NEW_SOURCE_SNAPSHOT\n') }; control.emit();
  await open(peer, href + '&commit=' + commit); await peer.locator('[data-task-source-after]').waitFor();
  assert.ok((await peer.locator('[data-task-source-after]').inputValue()).includes(commit)); assert.equal(await peer.locator('[data-task-source-code]').textContent(), source);
  assert.equal(await peer.locator('[data-candidate-composer]').count(), 0); assert.equal(await peer.locator('[data-collab-guide-task]').isDisabled(), true);
  assert.equal(await peer.locator('[data-task-workspace]').getByRole('button', { name: '认领此任务', exact: true }).count(), 0);
  await peer.screenshot({ path: path.join(output, 'fixed-source-desktop.png'), fullPage: true });
  await peer.setViewportSize({ width: 390, height: 844 }); await settled(peer);
  assert.equal(await peer.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await peer.screenshot({ path: path.join(output, 'fixed-source-mobile.png'), fullPage: true });
  checks.push({ name: phase, requestedCommit: commit, latestCommit: '2'.repeat(40), readonly: true, mobileOverflow: false });

  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(mail, []); assert.equal(controlledChecks, 1);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, controlledChecks, realLean: 0, realModels: 0, externalMail: 0, productionTouched: false, errors }, null, 2) + '\n');
  const previousFailures = path.join(output, 'previous-failures'); await fs.mkdir(previousFailures, { recursive: true });
  await Promise.all(['failure.json', 'failure-0.png', 'failure-1.png', 'failure-2.png'].map(file => fs.rename(path.join(output, file), path.join(previousFailures, file)).catch(error => { if (error.code !== 'ENOENT') throw error; })));
  console.log(JSON.stringify({ status: 'passed', scenarios: checks.length, output }));
} catch (error) {
  await Promise.all([owner, peer, visitor].map((page, index) => page.screenshot({ path: path.join(output, 'failure-' + index + '.png'), fullPage: true }).catch(() => {})));
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ phase, error: String(error), checks, errors, external }, null, 2) + '\n'); throw error;
} finally {
  for (const control of controls.values()) control.finish();
  await Promise.all(actors.map(actor => actor.close())); await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
