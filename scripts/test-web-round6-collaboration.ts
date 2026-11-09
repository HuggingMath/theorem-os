#!/usr/bin/env bun
// Real Chromium collaboration regression using disposable loopback data and controlled checks only.
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
import type { ResearchCandidateReview, ResearchFeedback, ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { freePort, postRun, preferFullCollaboration, startBrowser } from './web-scenario';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/frontend-round6/collaboration');
await fs.access(path.join(root, 'out/web/research.js'));
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-research-browser-'));
const source = 'theorem research_fixture : True := by sorry\n', credential = 'sk-local-research-fixture';
const candidateSource = 'theorem research_fixture : True := by exact True.intro\n';
const hash = (letter: string) => letter.repeat(64), now = () => new Date().toISOString();
type Control = { observation: WebObservation; send: (message: WorkerMessage) => void; emit: () => void };
const controls = new Map<string, Control>();
let checkerCalls = 0, guidanceCalls = 0;
function observation(id: string): WebObservation {
  const tasks = [{ id: 'lemma', kind: 'lemma' as const, objective: 'Prove a supporting fact', dependsOn: [], revision: 0, theoremName: 'supporting_fact', proofPath: 'Main.lean', type: 'True' },
    { id: 'goal', kind: 'goal' as const, objective: 'Prove the original statement', dependsOn: ['lemma'], revision: 0, theoremName: 'research_fixture', proofPath: 'Main.lean', type: 'True' }];
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: 'fixture-' + id, stateDigest: hash('a'), resultDigest: null };
  const inspection: WebInspection = { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
    problem: { id: 'research-browser-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'research_fixture', proofPath: 'Main.lean' }] },
    configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative', buildDigest: hash('b'), environmentDigest: hash('e') }, turns: 1, planVersion: 'fixture-plan-v1',
    scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
    knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded', droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] },
    tokenBudget: {}, continuation: {}, mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: hash('c'), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
    progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['lemma', 'goal'] }, groups: [],
    tasks: tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective, group: 'main', status: 'pending', control: 'active', version: task.id + '-v1', theorem: task.theoremName, type: task.type,
      premises: [], plannedDependencies: task.dependsOn, attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })), workers: [], statementReviews: [], edits: [] };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1, evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, inspection,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'fixture-plan-v1', tasks }, sources: [{ scope: 'owned-file', taskId: 'goal', taskVersion: 'goal-v1',
      commit: '1'.repeat(40), sourceDigest: mathDigest(source), environmentDigest: hash('e'), file: 'Main.lean', source }], checks: [], guidance: [], coverage: { sources: 'partial', checks: 'partial' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable local research UI fixture' }; },
  async check(input) { checkerCalls++; return { output: '', exitCode: 0, timedOut: false, checkedTarget: input.candidateTarget?.name }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), send, emit() { this.observation.sequence++; this.observation.observedAt = now(); this.send({ type: 'observation', observation: structuredClone(this.observation) }); } };
      controls.set(input.id, control); control.emit(); signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  async command(id, command) {
    const control = controls.get(id); assert.ok(control);
    if (command.type === 'guidance') {
      guidanceCalls++;
      const guidance = { ...command.guidance, status: 'delivered' as const, deliveredTo: ['fixture-lead'], createdAt: now(), updatedAt: now() };
      control.observation.guidance.push(guidance); control.emit(); return { id: command.guidance.id, status: 'delivered', guidance, observation: structuredClone(control.observation) };
    }
    throw new Error('Unexpected fixture command: ' + command.type);
  },
};
const port = await freePort(), origin = 'http://127.0.0.1:' + port;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '8' }), runner);
const browser = await startBrowser(service.server, port);
const runInput: WebRunInput = { providerId: 'openai', apiKey: credential, model: 'fixture', effort: 'low', environment: 'standard', source,
  task: 'Disposable collaboration fixture', maxTurns: 2, maxRunSeconds: 300, workers: 2, coordination: 'cooperative' };
async function raw(page: Page, method: string, pathname: string, input?: unknown) {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  }, { method, pathname, input });
}
async function http<T>(page: Page, method: string, pathname: string, input?: unknown): Promise<T> {
  const response = await raw(page, method, pathname, input);
  assert.ok(response.status >= 200 && response.status < 300, 'HTTP ' + response.status + ': ' + response.body.error);
  return response.body as T;
}
const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })));
const errors: string[] = [], external: string[] = [], checks: object[] = [];
for (const context of contexts) {
  await preferFullCollaboration(context);
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
}
const [owner, visitor, other] = await Promise.all(contexts.map(context => context.newPage()));
for (const page of [owner, visitor, other]) page.setDefaultTimeout(15000);
const discussion = (page: Page) => page.locator('form').filter({ has: page.getByRole('button', { name: '保存讨论', exact: true }) });
const postResponse = (page: Page, pathname: string) => page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === pathname);
let phase = 'setup';
try {
  await Promise.all([owner, visitor, other].map(page => page.goto(origin + '/theorems.html')));
  let project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', '/api/research/theorems', {
    requestId: crypto.randomUUID(), title: 'Round 6 collaboration regression', description: 'Disposable local observations only.', visibility: 'public',
  })).item;
  const route = '/api/research/theorems/' + project.id, feedbackRoute = route + '/feedback';
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', route + '/versions', {
    requestId: crypto.randomUUID(), expectedRevision: project.revision, statement: 'Version one: prove True.', source, environment: 'standard', confirmation: { confirmed: true },
  })).item;
  const v1 = project.currentStatementVersionId!;
  const url = (version = v1) => origin + '/theorems.html?id=' + project.id + '&version=' + version;
  await visitor.goto(url());

  phase = 'non-member-default-private-discussion-remains-readable';
  const visitorView = (await http<{ item: ResearchProjectDetail }>(visitor, 'GET', route)).item;
  assert.equal(visitorView.permissions.member, false); assert.equal(visitorView.permissions.discuss, true);
  const visitorForm = discussion(visitor), visitorText = visitorForm.getByRole('textbox', { name: /^讨论内容/u });
  assert.equal(await visitorForm.getByRole('combobox', { name: '可见范围', exact: true }).inputValue(), 'members');
  assert.equal(await visitorForm.locator('option:checked').textContent(), '项目成员和我');
  const privateText = 'PRIVATE_VISITOR_DISCUSSION: Please check this argument.';
  await visitorText.fill(privateText);
  const privateResponse = postResponse(visitor, feedbackRoute);
  await visitorForm.getByRole('button', { name: '保存讨论', exact: true }).click();
  const privateReply = await privateResponse; assert.equal(privateReply.status(), 201);
  const privateRecord: ResearchFeedback = (await privateReply.json()).item;
  assert.equal(privateRecord.authorReadable, true); assert.equal(privateRecord.visibility, 'members');
  const privateCard = visitor.locator('#feedback-' + privateRecord.id);
  await privateCard.waitFor(); assert.ok((await privateCard.innerText()).includes(privateText));
  assert.equal(await visitorText.inputValue(), '');
  assert.equal((await raw(visitor, 'GET', feedbackRoute + '/' + privateRecord.id)).status, 200);
  assert.equal((await raw(visitor, 'POST', feedbackRoute, privateReply.request().postDataJSON())).body.item.id, privateRecord.id);
  assert.equal((await raw(other, 'GET', feedbackRoute + '/' + privateRecord.id)).status, 404);
  assert.equal((await fetch(origin + feedbackRoute + '/' + privateRecord.id)).status, 404);
  assert.equal((await raw(owner, 'GET', feedbackRoute + '/' + privateRecord.id)).status, 200);
  await owner.goto(url()); await owner.locator('#feedback-' + privateRecord.id).waitFor();
  await http(owner, 'POST', feedbackRoute + '/' + privateRecord.id + '/decision', { requestId: crypto.randomUUID(), expectedRevision: privateRecord.revision,
    status: 'needs-info', reason: 'Please explain the second implication.', evidenceRefs: [] });
  await visitor.reload(); await privateCard.getByText('Please explain the second implication.', { exact: true }).waitFor();
  await visitor.screenshot({ path: path.join(output, 'visitor-private-discussion-and-reply.png'), fullPage: true });
  checks.push({ id: 'COL6-D01', name: 'Default private visitor discussion stays readable to author and project members; unrelated and anonymous readers are excluded',
    visibility: privateRecord.visibility, authorReadable: privateRecord.authorReadable, authorRead: 200, replaySameRecord: true, unrelatedRead: 404, anonymousRead: 404, ownerReplyVisible: true });

  phase = 'public-discussion-still-works';
  await visitorForm.getByRole('combobox', { name: '可见范围', exact: true }).selectOption('public');
  await visitorText.fill('PUBLIC_DISCUSSION_CONTROL: This can be read by other visitors.');
  const publicResponse = postResponse(visitor, feedbackRoute);
  await visitorForm.getByRole('button', { name: '保存讨论', exact: true }).click();
  const publicRecord: ResearchFeedback = (await (await publicResponse).json()).item;
  await visitor.locator('#feedback-' + publicRecord.id).waitFor();
  assert.equal((await raw(other, 'GET', feedbackRoute + '/' + publicRecord.id)).status, 200);
  checks.push({ name: 'Explicit public discussions remain public', unrelatedRead: 200 });

  phase = 'discussion-version-navigation-retains-draft';
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'GET', route)).item;
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', route + '/versions', {
    requestId: crypto.randomUUID(), expectedRevision: project.revision, statement: 'Version two: prove True and True.',
    source: 'theorem research_fixture : True ∧ True := by sorry\n', environment: 'standard', confirmation: { confirmed: true },
  })).item;
  const v2 = project.currentStatementVersionId!;
  await owner.goto(url(v2));
  const ownerForm = discussion(owner), ownerText = ownerForm.getByRole('textbox', { name: /^讨论内容/u });
  await ownerText.fill('VERSION_TWO_DISCUSSION: Both components must be shown.');
  const versionResponse = postResponse(owner, feedbackRoute);
  await ownerForm.getByRole('button', { name: '保存讨论', exact: true }).click();
  const versionRecord: ResearchFeedback = (await (await versionResponse).json()).item;
  assert.equal(versionRecord.statementVersionId, v2);
  const versionCard = owner.locator('#feedback-' + versionRecord.id), statementSelect = owner.getByRole('combobox', { name: '当前查看的陈述', exact: true });
  await versionCard.locator('[data-discussion-statement]').getByRole('link', { name: '陈述版本 · v2', exact: true }).waitFor();
  const draft = 'UNSENT_DRAFT_PRESERVED_DURING_VERSION_NAVIGATION';
  await ownerText.fill(draft); await statementSelect.selectOption(v1);
  assert.equal(await versionCard.isVisible(), true, 'Discussions intentionally have project-wide scope');
  await versionCard.locator('[data-discussion-statement] a').click();
  assert.equal(await statementSelect.inputValue(), v2); assert.equal(await ownerText.inputValue(), draft);
  assert.equal(new URL(owner.url()).searchParams.get('version'), v2);
  await statementSelect.selectOption(v1);
  const event = owner.locator('.research-event').filter({ has: owner.locator('a[href="#feedback-' + versionRecord.id + '"]') });
  await event.getByRole('link', { name: '查看陈述版本 · v2', exact: true }).click();
  assert.equal(await statementSelect.inputValue(), v2); assert.equal(await ownerText.inputValue(), draft);
  const savedProject = (await http<{ item: ResearchProjectDetail }>(owner, 'GET', route)).item;
  assert.equal(savedProject.activity.find(item => item.feedbackId === versionRecord.id)?.statementVersionId, v2);
  assert.equal(savedProject.feedback.some(item => item.text === draft), false);
  await owner.screenshot({ path: path.join(output, 'discussion-version-navigation.png'), fullPage: true });
  checks.push({ id: 'COL6-D02', name: 'Discussion card and timeline navigate to the saved version without clearing an unsent draft',
    savedVersion: v2, cardNavigation: true, timelineNavigation: true, projectWideDiscussion: true, draftRetained: true });

  phase = 'submit-candidate-through-ui';
  const run = await postRun({ page: owner }, runInput); assert.ok(controls.has(run.id));
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'GET', route)).item;
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', route + '/runs', {
    requestId: crypto.randomUUID(), expectedRevision: project.revision, statementVersionId: v1, runId: run.id,
    exposure: 'public', grants: { guidance: true, edit: true, approve: true, proof: true },
  })).item;
  await owner.goto(url(v1) + '&run=' + run.id);
  await owner.getByText('提交候选证明', { exact: true }).click();
  const candidateForm = owner.locator('form').filter({ has: owner.getByRole('button', { name: '提交检查', exact: true }) });
  await candidateForm.getByRole('combobox', { name: '选择带有源码快照的任务', exact: true }).selectOption({ index: 1 });
  await candidateForm.getByRole('textbox', { name: '修改后的候选源码', exact: true }).fill(candidateSource);
  await candidateForm.getByRole('textbox', { name: '修改说明', exact: true }).fill('CANDIDATE_REVIEW: inspect the exact submitted proof.');
  const candidateResponse = postResponse(owner, feedbackRoute);
  await candidateForm.getByRole('button', { name: '提交检查', exact: true }).click();
  const candidateReply = await candidateResponse; assert.equal(candidateReply.status(), 201);
  const candidate: ResearchFeedback = (await candidateReply.json()).item;
  assert.equal(candidate.proofCheck?.status, 'checked'); assert.equal(candidate.decision.status, 'pending');
  assert.equal(checkerCalls, 1); assert.equal(guidanceCalls, 1);
  const visitorId = (await http<{ researcherId: string }>(visitor, 'GET', '/api/research/session')).researcherId;
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'GET', route)).item;
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'PUT', route + '/members/' + visitorId,
    { requestId: crypto.randomUUID(), expectedRevision: project.revision, role: 'collaborator' })).item;
  await visitor.goto(url(v1) + '&run=' + run.id);
  const candidateCard = visitor.locator('#feedback-' + candidate.id), review = candidateCard.locator('[data-candidate-review]');
  await candidateCard.waitFor(); await review.getByText('审阅候选证明', { exact: true }).click();
  const reviewRoute = feedbackRoute + '/' + candidate.id + '/candidate-review';
  const originalReview = (await http<{ item: ResearchCandidateReview }>(visitor, 'GET', reviewRoute)).item;
  assert.equal(originalReview.source, candidateSource); assert.equal(originalReview.baseline?.source, source);
  assert.equal(originalReview.check?.receiptId, candidate.proofCheck?.receiptId);
  assert.equal(mathDigest(canonicalMathJson(originalReview.check!.receipt)), originalReview.check!.receiptId);
  assert.equal(await review.locator('[data-candidate-source]').textContent(), candidateSource);
  await review.getByRole('button', { name: '提交基准', exact: true }).click();
  await review.locator('[data-candidate-baseline]').waitFor();
  assert.equal(await review.locator('[data-candidate-baseline]').textContent(), source);
  await review.getByRole('button', { name: '差异对比', exact: true }).click();
  const diff = review.locator('[data-candidate-diff]'); await diff.waitFor();
  assert.ok((await diff.textContent())?.includes('exact True.intro')); assert.ok((await diff.textContent())?.includes('sorry'));
  await visitor.screenshot({ path: path.join(output, 'candidate-source-diff-desktop.png'), fullPage: true });
  await review.getByRole('button', { name: '检查回执', exact: true }).click();
  await review.getByText('完整检查回执', { exact: true }).click();
  assert.deepEqual(JSON.parse((await review.locator('[data-candidate-check-receipt]').textContent())!), originalReview.check!.receipt);
  await candidateCard.getByText('记录采纳决定', { exact: true }).click();
  await candidateCard.getByRole('textbox', { name: '理由', exact: true }).waitFor();
  assert.equal(candidate.decision.status, 'pending', 'Reviewing is separate from adoption and original acceptance');
  checks.push({ id: 'COL6-D03', name: 'Another collaborator can inspect candidate source, exact baseline, diff and immutable check before deciding',
    candidateDigest: originalReview.sourceDigest, receiptId: originalReview.check!.receiptId, checkerCalls, guidanceCalls });

  phase = 'historical-candidate-review-after-task-update';
  const control = controls.get(run.id)!;
  const newerSource = 'theorem research_fixture : True := by trivial -- NEW_CURRENT_TASK_SOURCE\n';
  control.observation.inspection.tasks.find(task => task.id === 'goal')!.version = 'goal-v2';
  control.observation.sources[0] = { ...control.observation.sources[0], taskVersion: 'goal-v2', commit: '2'.repeat(40), sourceDigest: mathDigest(newerSource), source: newerSource };
  control.emit();
  assert.deepEqual((await http<{ item: ResearchCandidateReview }>(visitor, 'GET', reviewRoute)).item, originalReview);
  await visitor.reload(); await review.getByText('审阅候选证明', { exact: true }).click();
  await review.getByRole('button', { name: '提交基准', exact: true }).click();
  await review.locator('[data-candidate-baseline]').waitFor();
  assert.equal(await review.locator('[data-candidate-baseline]').textContent(), source);
  assert.equal(checkerCalls, 1); assert.equal(guidanceCalls, 1);
  checks.push({ name: 'Reload after task/source advances preserves the historical baseline and check, without rerunning either', currentTaskVersion: 'goal-v2', frozenTaskVersion: originalReview.target.taskRef?.version });

  phase = 'review-request-error-can-retry';
  await visitor.route(origin + reviewRoute + '**', intercepted => intercepted.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'REVIEW_TEMPORARILY_UNAVAILABLE' }) }));
  await visitor.reload(); await review.getByText('审阅候选证明', { exact: true }).click();
  await review.getByText('REVIEW_TEMPORARILY_UNAVAILABLE', { exact: true }).waitFor();
  assert.equal(await review.locator('[data-candidate-source]').textContent(), candidateSource);
  await visitor.unroute(origin + reviewRoute + '**');
  await review.getByRole('button', { name: '重新读取审阅资料', exact: true }).click();
  await review.getByRole('button', { name: '提交基准', exact: true }).click();
  await review.locator('[data-candidate-baseline]').waitFor();
  assert.equal(await review.getByText('REVIEW_TEMPORARILY_UNAVAILABLE', { exact: true }).count(), 0);
  checks.push({ name: 'Review transport failure preserves submitted source and supports an explicit successful retry' });

  phase = 'mobile-candidate-review';
  await visitor.setViewportSize({ width: 390, height: 844 });
  await review.getByRole('button', { name: '差异对比', exact: true }).click(); await diff.waitFor();
  const overflow = await visitor.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert.ok(overflow.content <= overflow.viewport + 1, JSON.stringify(overflow));
  await review.scrollIntoViewIfNeeded();
  await visitor.screenshot({ path: path.join(output, 'candidate-review-mobile.png'), fullPage: true });
  checks.push({ name: 'Candidate code, diff and long identities fit a 390 px screen without page overflow', ...overflow });

  phase = 'candidate-review-respects-current-run-membership';
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'GET', route)).item;
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'PUT', route + '/members/' + visitorId,
    { requestId: crypto.randomUUID(), expectedRevision: project.revision, role: 'reader' })).item;
  assert.equal((await raw(visitor, 'GET', reviewRoute)).status, 200);
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'PUT', route + '/members/' + visitorId,
    { requestId: crypto.randomUUID(), expectedRevision: project.revision, role: null })).item;
  assert.equal((await raw(visitor, 'GET', reviewRoute)).status, 404);
  assert.equal((await raw(other, 'GET', reviewRoute)).status, 404);
  assert.equal((await raw(visitor, 'GET', feedbackRoute + '/' + privateRecord.id)).status, 200);
  const memberRecord = (await http<{ item: ResearchFeedback }>(owner, 'POST', feedbackRoute, { requestId: crypto.randomUUID(), kind: 'discussion',
    statementVersionId: v1, text: 'MEMBER_ONLY_CONTROL', visibility: 'members' })).item;
  assert.equal((await raw(visitor, 'GET', feedbackRoute + '/' + memberRecord.id)).status, 404);
  await http(owner, 'PATCH', route, { requestId: crypto.randomUUID(), expectedRevision: (await http<{ item: ResearchProjectDetail }>(owner, 'GET', route)).item.revision, visibility: 'members' });
  assert.equal((await raw(visitor, 'GET', feedbackRoute + '/' + privateRecord.id)).status, 404);
  checks.push({ name: 'Reader members can review; revocation removes private candidate and member feedback; project privacy still revokes outside author access', readerReview: 200, revokedReview: 404, unrelatedReview: 404, memberOnlyDiscussion: 404, hiddenProjectAuthorDiscussion: 404 });

  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, errors, external,
    realModels: 0, realLean: 0, productionTouched: false, controlledCheckerCalls: checkerCalls, controlledGuidanceCalls: guidanceCalls }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }));
} catch (error) {
  await owner.screenshot({ path: path.join(output, 'failure-owner.png'), fullPage: true }).catch(() => {});
  await visitor.screenshot({ path: path.join(output, 'failure-visitor.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ phase, error: String(error), checks, errors, external }, null, 2) + '\n');
  throw error;
} finally {
  await Promise.all(contexts.map(context => context.close())); await browser.close(); await service.close();
  await fs.rm(dataRoot, { recursive: true, force: true });
}
