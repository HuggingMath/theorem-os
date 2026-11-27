#!/usr/bin/env bun
// Disposable HTTP/Chromium state and a controlled runner. No models, Lean or mail.
import { seedCooperativeRun } from './web-cooperative-fixture';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { loadWebSample } from '../apps/web/sample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { WebRunner } from '../apps/web/runner';
import type { WebObservation } from '../apps/web/collaboration';
import type { ResearchFeedback, ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { freePort, startBrowser, preferFullCollaboration } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/product-continuity/candidate-continuity');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-candidate-continuity-'));
const source = 'theorem target : True := by sorry\n', commit = '1'.repeat(40), environmentDigest = mathDigest('controlled-candidate-environment');
const controls = new Map<string, { observation: WebObservation; emit(): void }>();
const commands: { id: string; type: string }[] = [], errors: string[] = [], external: string[] = [], checks: object[] = [];
let compileCalls = 0, prohibited = 0, phase = 'setup', active: Page | undefined, failure: unknown;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Controlled candidate workflow' }; },
  async check(input) { compileCalls++; return { exitCode: 0, timedOut: false, output: '', checkedTarget: input.candidateTarget?.name }; },
  async run(input, send, signal) {
    const observation = structuredClone(loadWebSample()!.observations.at(-1)!);
    observation.webRunId = input.id; observation.sequence = 1; observation.snapshot.stateDigest = mathDigest('candidate-v1');
    observation.inspection.problem = { id: 'candidate-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'target', proofPath: 'Main.lean' }] };
    observation.inspection.configuration.environmentDigest = environmentDigest;
    observation.inspection.tasks = [{ id: 'goal', kind: 'goal', objective: 'Prove True', theorem: 'target', type: 'True',
      group: 'main', status: 'working', control: 'active', version: 'goal-v1', premises: [], plannedDependencies: [],
      attempts: 0, proof: { status: 'open' }, parkedBy: [], parkedRoutes: {} }];
    observation.inspection.edits = []; observation.inspection.statementReviews = []; observation.inspection.planVersion = 'plan-v1';
    observation.inspection.progress = { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['goal'] };
    observation.plan = { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [
      { id: 'goal', kind: 'goal', objective: 'Prove True', revision: 0, dependsOn: [], theoremName: 'target', proofPath: 'Main.lean', type: 'True' }] };
    observation.sources = [{ taskId: 'goal', taskVersion: 'goal-v1', commit, source, sourceDigest: mathDigest(source), environmentDigest, file: 'Main.lean', scope: 'owned-file' }];
    observation.checks = []; observation.guidance = []; observation.history = []; observation.deliveries = [];
    observation.coverage = { sources: 'recorded', checks: 'recorded' };
    await new Promise<void>(resolve => {
      controls.set(input.id, { observation, emit() { send({ type: 'observation', observation: structuredClone(this.observation) }); } });
      controls.get(input.id)!.emit(); signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  async command(_id, command) {
    if (command.type === 'capture') return { id: 'capture', status: 'captured' };
    if (command.type === 'guidance-withdraw') return { id: command.id, status: 'rejected', reason: 'fixture_guidance_withdraw_not_simulated' };
    const id = command.type === 'guidance' ? command.guidance.id : command.type === 'plan-approval' ? command.approval.id : command.proposal.id;
    commands.push({ id, type: command.type }); return { id, status: 'delivered' };
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '4' }), runner,
{ sample: null, mailer: async () => { prohibited++; throw new Error('No mail allowed'); } });
const browser = await startBrowser(service.server, port);
async function http<T>(page: Page, method: string, pathname: string, input?: unknown): Promise<T> {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${body.error}`); return body;
  }, { method, pathname, input }) as Promise<T>;
}
const mutation = (page: Page, pathname: string) => page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === pathname);
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    phase = `setup-${language}-${width}`;
    const actors = await Promise.all([0, 1].map(() => browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', viewport: { width, height: 1000 }, reducedMotion: 'reduce' })));
    for (const actor of actors) {
      await actor.addInitScript(language => { try { localStorage.setItem('theorem-os.web-locale.v1', language); } catch { /* Opaque initial documents have no storage. */ } }, language);
      await preferFullCollaboration(actor);
      await actor.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
      actor.on('page', page => { page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message)); });
    }
    const [reviewer, author] = await Promise.all(actors.map(actor => actor.newPage())); active = reviewer;
    await Promise.all([reviewer, author].map(page => page.goto(origin + '/theorems.html')));
    const authorSession = await http<{ researcherId: string }>(author, 'GET', '/api/research/session');
    for (const [page, name] of [[reviewer, 'Reviewer'], [author, 'Author']] as const)
      await http(page, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(), expectedRevision: 0, displayName: name, visibility: 'public' });
    let project = (await http<{ item: ResearchProjectDetail }>(reviewer, 'POST', '/api/research/theorems', { requestId: crypto.randomUUID(), title: 'Candidate continuity', visibility: 'members' })).item;
    const projectPath = `/api/research/theorems/${project.id}`;
    project = (await http<{ item: ResearchProjectDetail }>(reviewer, 'PUT', `${projectPath}/members/${authorSession.researcherId}`, { requestId: crypto.randomUUID(), expectedRevision: project.revision, role: 'collaborator' })).item;
    project = (await http<{ item: ResearchProjectDetail }>(reviewer, 'POST', `${projectPath}/versions`, { requestId: crypto.randomUUID(), expectedRevision: project.revision, source, statement: 'Prove True', environment: 'standard' })).item;
    const run = await seedCooperativeRun(service, reviewer.context(), origin, { providerId: 'openai', apiKey: 'sk-disposable-candidate-fixture', model: 'fixture', effort: 'low', environment: 'standard', source, task: 'Prove True', maxTurns: 2, maxRunSeconds: 600, workers: 2, coordination: 'cooperative' });
    await reviewer.waitForFunction(async id => (await (await fetch(`/api/runs/${id}`)).json()).run.observation, run.id);
    project = (await http<{ item: ResearchProjectDetail }>(reviewer, 'POST', `${projectPath}/runs`, { requestId: crypto.randomUUID(), expectedRevision: project.revision, runId: run.id, statementVersionId: project.currentStatementVersionId, grants: { guidance: true, edit: true, approve: true, proof: true } })).item;
    const href = `${origin}/theorems.html?${new URLSearchParams({ id: project.id, version: project.currentStatementVersionId!, run: run.id, task: 'goal', taskVersion: 'goal-v1' })}`;
    await reviewer.goto(href);
    await reviewer.getByText(language === 'zh' ? '编辑题目信息' : 'Edit project information', { exact: true }).click();
    await reviewer.locator('[data-candidate-policy]').waitFor();
    const policy = reviewer.locator('[data-candidate-policy]');
    if (await policy.evaluate(element => element.tagName === 'SELECT')) await policy.selectOption('reviewed');
    else await policy.locator('select').selectOption('reviewed');
    const policyForm = policy.locator('xpath=ancestor-or-self::form');
    if (await policyForm.count()) { await policyForm.getByRole('button', { name: language === 'zh' ? /保存|确认/ : /Save|Confirm/ }).click(); }
    await reviewer.waitForFunction(async pathname => (await (await fetch(pathname)).json()).item.candidateDeliveryPolicy === 'reviewed', projectPath);
    project = (await http<{ item: ResearchProjectDetail }>(reviewer, 'GET', projectPath)).item;
    const target = { runId: run.id, statementVersionId: project.currentStatementVersionId!, observationRef: { sequence: 1, stateDigest: controls.get(run.id)!.observation.snapshot.stateDigest }, taskRef: { id: 'goal', version: 'goal-v1' } };
    const base = { commit, sourceDigest: mathDigest(source), environmentDigest, file: 'Main.lean' };
    phase = `checked-awaiting-review-${language}-${width}`;
    const commandsBefore = commands.length;
    let candidate = (await http<{ item: ResearchFeedback }>(author, 'POST', `${projectPath}/feedback`, { requestId: crypto.randomUUID(), kind: 'proof-submission', text: 'A direct proof of True', source: 'theorem target : True := by trivial\n', base, target })).item;
    assert.equal(candidate.proofCheck?.status, 'checked'); assert.equal(candidate.candidateDelivery?.status, 'awaiting-review');
    assert.equal(commands.length, commandsBefore, 'Checking must not dispatch a candidate that needs human review');
    await reviewer.goto(`${href}#feedback-${candidate.id}`);
    let row = reviewer.locator(`#feedback-${candidate.id}`); await row.locator('[data-candidate-delivery-status="awaiting-review"]').waitFor();
    await author.goto(`${href}#feedback-${candidate.id}`);
    await author.locator(`#feedback-${candidate.id} [data-decision-peer-required]`).waitFor();
    await reviewer.screenshot({ path: path.join(output, `awaiting-review-${language}-${width}.png`), fullPage: true });
    phase = `review-and-revise-${language}-${width}`;
    await row.locator('[data-review-comment]').fill('Please spell out the constructor used to close True.');
    const commentResponse = mutation(reviewer, `${projectPath}/feedback/${candidate.id}/review-comments`);
    await row.locator('[data-save-review-comment]').click(); assert.equal((await commentResponse).status(), 200);
    candidate = (await http<{ item: ResearchFeedback }>(reviewer, 'GET', `${projectPath}/feedback/${candidate.id}`)).item;
    const firstId = candidate.id, commentId = candidate.reviewComments![0].id;
    await author.goto(`${href}#feedback-${firstId}`);
    await author.locator(`#feedback-${firstId} [data-revise-candidate]`).click();
    const composer = author.locator('[data-candidate-composer]'); await composer.locator('[data-submit-revision]').waitFor();
    assert.equal(await composer.getByLabel(language === 'zh' ? '修改后的候选源码' : 'Edited candidate source', { exact: true }).inputValue(), 'theorem target : True := by trivial\n');
    await composer.getByLabel(language === 'zh' ? '修改后的候选源码' : 'Edited candidate source', { exact: true }).fill('theorem target : True := by\n  exact True.intro\n');
    await composer.getByLabel(language === 'zh' ? '修改说明' : 'Change description', { exact: true }).fill('Use the explicit constructor.');
    await composer.locator(`[data-revision-response="${commentId}"]`).fill('The proof now applies True.intro explicitly.');
    const revisedResponse = mutation(author, `${projectPath}/feedback`); await composer.locator('[data-submit-revision]').click();
    const revisedReply = await revisedResponse; assert.equal(revisedReply.status(), 201);
    candidate = (await revisedReply.json() as { item: ResearchFeedback }).item;
    assert.equal(candidate.candidateRevision?.parentFeedbackId, firstId); assert.equal(candidate.candidateRevision?.number, 2);
    assert.equal(candidate.candidateRevision?.parentSnapshot.proofCheck?.status, 'checked');
    assert.equal(candidate.candidateRevision?.responses[0].commentId, commentId);
    assert.equal(candidate.candidateDelivery?.status, 'awaiting-review'); assert.equal(commands.length, commandsBefore);
    const previous = (await http<{ item: ResearchFeedback }>(reviewer, 'GET', `${projectPath}/feedback/${firstId}`)).item;
    assert.equal(previous.supersededBy, candidate.id);
    await reviewer.goto(`${href}#feedback-${candidate.id}`); row = reviewer.locator(`#feedback-${candidate.id}`);
    await row.locator('[data-candidate-revision] > summary').click(); await row.locator('[data-candidate-revision-diff]').waitFor();
    assert.match(await row.locator('[data-candidate-revision]').innerText(), /True\.intro/);
    await reviewer.screenshot({ path: path.join(output, `revision-${language}-${width}.png`), fullPage: true });
    phase = `human-adoption-does-not-dispatch-${language}-${width}`;
    assert.equal(await row.locator('[data-candidate-approve], [data-candidate-withdraw]').count(), 0);
    const decision = row.locator('[data-feedback-decision]');
    await decision.locator('summary').click();
    await decision.locator('[data-decision-status]').selectOption('accepted');
    await decision.getByLabel(language === 'zh' ? '理由' : 'Reason', { exact: true }).fill('The explicit constructor proves the reviewed statement.');
    const adoptionResponse = mutation(reviewer, `${projectPath}/feedback/${candidate.id}/decision`);
    await decision.locator('[data-save-decision]').click(); assert.equal((await adoptionResponse).status(), 200);
    candidate = (await http<{ item: ResearchFeedback }>(reviewer, 'GET', `${projectPath}/feedback/${candidate.id}`)).item;
    assert.equal(candidate.decision.status, 'accepted');
    assert.equal(candidate.delivery.status, 'not-sent');
    assert.equal(commands.length, commandsBefore);
    phase = `continue-work-after-plan-change-${language}-${width}`;
    project = (await http<{ item: ResearchProjectDetail }>(author, 'GET', projectPath)).item;
    await http(author, 'POST', `${projectPath}/assignments`, { requestId: crypto.randomUUID(), expectedRevision: project.revision, target, status: 'claimed' });
    const control = controls.get(run.id)!, observed = control.observation;
    observed.sequence++; observed.snapshot.stateDigest = mathDigest('candidate-v2'); observed.inspection.snapshot = { ...observed.snapshot };
    observed.inspection.planVersion = 'plan-v2'; observed.inspection.tasks[0].version = 'goal-v2'; observed.inspection.tasks[0].objective = 'Prove True with an explicit constructor';
    observed.plan!.baseVersion = 'plan-v2'; observed.plan!.tasks[0].revision = 1; observed.plan!.tasks[0].objective = observed.inspection.tasks[0].objective;
    observed.sources[0] = { ...observed.sources[0], taskVersion: 'goal-v2', commit: '2'.repeat(40), source: source + '-- updated baseline\n', sourceDigest: mathDigest(source + '-- updated baseline\n') };
    control.emit();
    await reviewer.waitForFunction(async id => (await (await fetch(`/api/runs/${id}`)).json()).run?.observation?.sequence === 2, run.id);
    const impact = await http<{ items: { id: string; kind: string; author: { id: string }; canContinue: boolean }[] }>(author, 'GET', `${projectPath}/runs/${run.id}/work-impact`);
    const claim = impact.items.find(item => item.kind === 'claim' && item.author.id === authorSession.researcherId)!;
    assert.ok(claim?.canContinue, 'The claim has a current task to continue against');
    const currentHref = new URL(href); currentHref.searchParams.set('taskVersion', 'goal-v2');
    await author.goto(currentHref.href); active = author;
    const work = author.locator(`[data-work-impact-item="${claim.id}"]`); await work.waitFor();
    await work.getByText(language === 'zh' ? '核对后处理这项工作' : 'Review and handle this work', { exact: true }).click();
    await work.getByLabel(language === 'zh' ? '接续或结束的说明' : 'Reason for continuing or ending', { exact: true }).fill('Reviewed the revised goal and continue the existing claim.');
    await work.locator('[data-work-confirm]').check();
    const continuedResponse = mutation(author, `${projectPath}/work-continuations`); await work.locator('[data-continue-work]').click();
    assert.equal((await continuedResponse).status(), 200);
    project = (await http<{ item: ResearchProjectDetail }>(author, 'GET', projectPath)).item;
    assert.ok(project.assignments.some(item => item.author.id === authorSession.researcherId && item.target.taskRef?.version === 'goal-v1' && item.status === 'released'));
    assert.ok(project.assignments.some(item => item.author.id === authorSession.researcherId && item.target.taskRef?.version === 'goal-v2' && item.status === 'claimed'));
    assert.equal(commands.length, commandsBefore, 'Moving a claim does not submit another proof or rerun research');
    await author.screenshot({ path: path.join(output, `continued-work-${language}-${width}.png`), fullPage: true });
    checks.push({ language, width, checkedBeforeReview: true, authorCannotApprove: true, revisionRetainsEvidenceAndResponses: true, supersededCandidateNotDispatched: true, humanDecisionWithoutDispatch: true, claimContinuesWithHistory: true });
    assert.ok(await reviewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page overflow');
    await Promise.all(actors.map(actor => actor.close()));
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0); assert.equal(compileCalls, 4);
} catch (error) {
  failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, errors, external, compileCalls, prohibited, ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Candidate continuity: ${checks.length} desktop/mobile workflows passed`);
