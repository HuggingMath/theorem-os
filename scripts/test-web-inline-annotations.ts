#!/usr/bin/env bun
// Disposable HTTP/Chromium state with a controlled runner; no real models, Lean or mail.
import { webAgentTeamPreset } from '../apps/web/researchMode';
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
import type { ResearchAnnotation, ResearchAnnotationPage, ResearchFeedback, ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { freePort, startBrowser, preferFullCollaboration } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/product-continuity/research-depth/annotations');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-inline-annotations-'));
const source = 'theorem target : True := by\n  sorry\n', commit = '1'.repeat(40), environmentDigest = mathDigest('inline-annotations-environment');
const controls = new Map<string, { observation: WebObservation; emit(): void }>();
const commands: { id: string; type: string }[] = [], errors: string[] = [], external: string[] = [], checks: object[] = [];
let compileCalls = 0, prohibited = 0, phase = 'setup', active: Page | undefined, failure: unknown;
const runner: WebRunner = {
  async readiness() { return { ready: true, nativeTeam: true, message: 'Controlled inline annotation workflow' }; },
  async check(input) { compileCalls++; return { exitCode: 0, timedOut: false, output: '', checkedTarget: input.candidateTarget?.name }; },
  async run(input, send, signal) {
    const observation = structuredClone(loadWebSample()!.observations.at(-1)!);
    observation.webRunId = input.id; observation.sequence = 1; observation.snapshot.stateDigest = mathDigest(`inline-v1:${input.id}`);
    observation.inspection.problem = { id: 'inline-fixture', statement: 'Prove $\\mathrm{True}$', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'target', proofPath: 'Main.lean' }] };
    Object.assign(observation.inspection.configuration, {
      environmentDigest, workers: 1, coordination: 'independent', researchMode: 'skill',
      researchSkill: { name: 'theoremos-research', digest: mathDigest('fixture skill'), loading: 'native' },
      researchDelegation: { mode: 'team', maxAgents: input.input.nativeTeamCapacity },
    });
    observation.inspection.tasks = [{ id: 'goal', kind: 'goal', objective: 'Prove True', theorem: 'target', type: 'True', informalStatement: 'The proposition $\\mathrm{True}$ is inhabited.',
      informalProof: 'Use the constructor $\\mathrm{True.intro}$ to close the goal.', group: 'main', status: 'working', control: 'active', version: 'goal-v1', premises: ['No extra assumptions.'], plannedDependencies: [],
      attempts: 0, proof: { status: 'open' }, parkedBy: [], parkedRoutes: {} }];
    observation.inspection.edits = []; observation.inspection.statementReviews = []; observation.inspection.planVersion = 'plan-v1';
    observation.inspection.planApproval = { required: true, status: 'pending', planVersion: 'plan-v1', rejections: [], leadRevising: false };
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
  async command(runId, command) {
    if (command.type === 'capture') return { id: 'capture', status: 'captured' };
    if (command.type !== 'plan-approval') throw new Error('Unexpected command: ' + command.type);
    const id = command.approval.id;
    commands.push({ id, type: command.type });
    const control = controls.get(runId)!;
    if (command.type === 'plan-approval') {
      control.observation.sequence++; control.observation.snapshot.stateDigest = mathDigest(`approved:${runId}:${id}`);
      control.observation.inspection.planApproval = { ...control.observation.inspection.planApproval!, status: 'approved', approvedId: id, approvedVersion: command.approval.planVersion }; control.emit();
    }
    return { id, status: 'delivered' };
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
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${body.error}`); return body;
  }, { method, pathname, input }) as Promise<T>;
}
const mutation = (page: Page, pathname: string) => page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === pathname);
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    phase = `setup-${language}-${width}`;
    const actors = await Promise.all([0, 1].map(() => browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', viewport: { width, height: 1000 }, reducedMotion: 'reduce' })));
    for (const actor of actors) {
      await actor.addInitScript(language => { try { localStorage.setItem('theorem-os.web-locale.v1', language); } catch { /* Initial opaque documents have no storage. */ } }, language);
      await preferFullCollaboration(actor);
      await actor.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
      actor.on('page', page => { page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message)); });
    }
    const [owner, peer] = await Promise.all(actors.map(actor => actor.newPage())); active = owner;
    await Promise.all([owner, peer].map(page => page.goto(origin + '/theorems.html')));
    const peerSession = await http<{ researcherId: string }>(peer, 'GET', '/api/research/session');
    for (const [page, name] of [[owner, 'Owner'], [peer, 'Peer']] as const) await http(page, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(), expectedRevision: 0, displayName: name, visibility: 'public' });
    const { run } = await http<{ run: { id: string } }>(owner, 'POST', '/api/runs', { providerId: 'openai', apiKey: 'sk-disposable-inline-fixture', model: 'fixture', effort: 'low', environment: 'standard', source, task: 'Prove True', maxTurns: 2, maxRunSeconds: 600, ...webAgentTeamPreset(), planApproval: true });
    await owner.waitForFunction(async id => (await (await fetch(`/api/runs/${id}`)).json()).run.observation, run.id);
    const routeUrl = `${origin}/problem.html?${new URLSearchParams({ run: run.id, tab: 'route', task: 'goal', taskVersion: 'goal-v1' })}`;
    await owner.goto(routeUrl); const inline = owner.locator('[data-research-inline-actions]'); await inline.locator('[data-inline-open]').click(); await inline.locator('[data-inline-approve-plan]').waitFor();
    assert.equal(await inline.locator('[data-inline-drawer]').evaluate(node => (node as HTMLDialogElement).open), true);
    await owner.keyboard.press('Escape'); assert.equal(await inline.locator('[data-inline-drawer]').evaluate(node => (node as HTMLDialogElement).open), false);
    assert.equal(await inline.locator('[data-inline-open]').evaluate(node => document.activeElement === node), true);
    await inline.locator('[data-inline-open]').click();
    assert.match(await inline.locator('[data-inline-math-context]').innerText(), /True\.intro/);
    phase = `personal-plan-approval-${language}-${width}`;
    assert.equal(await inline.locator('[data-inline-approve-plan]').isDisabled(), true);
    await inline.locator('[data-inline-confirm-plan]').check();
    const approval = mutation(owner, `/api/runs/${run.id}/plan-approval`); await inline.locator('[data-inline-approve-plan]').click(); assert.equal((await approval).status(), 200);
    assert.equal(await inline.locator('[data-inline-guidance]').count(), 0);

    phase = `personal-math-and-source-annotations-${language}-${width}`;
    const notesPath = `/api/research/runs/${run.id}/annotations`, notes = inline.locator('[data-research-annotations]');
    await notes.getByText(language === 'zh' ? '添加精确批注' : 'Add a passage comment', { exact: true }).click();
    await notes.locator('[data-annotation-field]').selectOption('derivation'); await notes.locator('[data-annotation-whole-field]').click();
    await notes.getByLabel(language === 'zh' ? '这一步的疑问或修改建议' : 'Question or suggested change for this passage', { exact: true }).fill('Explain why this constructor proves the proposition.');
    const mathSave = mutation(owner, notesPath); await notes.locator('[data-save-annotation]').click(); const mathResponse = await mathSave; assert.equal(mathResponse.status(), 201);
    const mathNote = (await mathResponse.json() as { item: ResearchAnnotation }).item; assert.equal(mathNote.anchor.kind, 'mathematics');
    await notes.locator('[data-annotation-kind="source"]').click(); await notes.locator('[data-annotation-line="2"]').click();
    await notes.getByLabel(language === 'zh' ? '这一步的疑问或修改建议' : 'Question or suggested change for this passage', { exact: true }).fill('Replace this placeholder with the explicit constructor.');
    const sourceSave = mutation(owner, notesPath); await notes.locator('[data-save-annotation]').click(); const sourceResponse = await sourceSave; assert.equal(sourceResponse.status(), 201);
    const sourceNote = (await sourceResponse.json() as { item: ResearchAnnotation }).item; assert.deepEqual(sourceNote.anchor, { kind: 'source', file: 'Main.lean', sourceDigest: mathDigest(source), startLine: 2, endLine: 2, quote: '  sorry' });
    const thread = notes.locator(`[data-annotation-thread="${sourceNote.id}"]`); await thread.waitFor();
    await thread.getByLabel(language === 'zh' ? '回应这条批注' : 'Reply to this comment', { exact: true }).fill('I will use True.intro in the next candidate.');
    const replied = mutation(owner, `${notesPath}/${sourceNote.id}`); await thread.locator('[data-reply-annotation]').click(); assert.equal((await replied).status(), 200);
    await owner.waitForFunction(id => document.querySelector(`[data-annotation-thread="${id}"]`)?.textContent?.includes('I will use True.intro'), sourceNote.id);
    const resolved = mutation(owner, `${notesPath}/${sourceNote.id}`); await thread.locator('[data-resolve-annotation]').click(); assert.equal((await resolved).status(), 200);
    await owner.waitForFunction(id => document.querySelector(`[data-annotation-thread="${id}"]`)?.getAttribute('data-annotation-status') === 'resolved', sourceNote.id);
    await owner.screenshot({ path: path.join(output, `personal-${language}-${width}.png`) });

    phase = `shared-claim-and-candidate-${language}-${width}`;
    let project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', '/api/research/theorems', { requestId: crypto.randomUUID(), title: 'Inline research', visibility: 'members', candidateDeliveryPolicy: 'reviewed' })).item;
    const projectPath = `/api/research/theorems/${project.id}`;
    project = (await http<{ item: ResearchProjectDetail }>(owner, 'PUT', `${projectPath}/members/${peerSession.researcherId}`, { requestId: crypto.randomUUID(), expectedRevision: project.revision, role: 'collaborator' })).item;
    project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', `${projectPath}/versions`, { requestId: crypto.randomUUID(), expectedRevision: project.revision, source, statement: 'Prove True', environment: 'standard' })).item;
    project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', `${projectPath}/runs`, { requestId: crypto.randomUUID(), expectedRevision: project.revision, runId: run.id, statementVersionId: project.currentStatementVersionId, grants: { guidance: true, edit: true, approve: true, proof: true } })).item;
    const projectUrl = routeUrl + `&project=${project.id}`; await peer.goto(projectUrl); active = peer;
    const peerInline = peer.locator('[data-research-inline-actions]'); await peerInline.locator('[data-inline-open]').click(); await peerInline.locator('[data-inline-claim]').waitFor();
    const claimed = mutation(peer, `${projectPath}/assignments`); await peerInline.locator('[data-inline-claim]').click(); assert.equal((await claimed).status(), 200);
    await peerInline.locator('[data-inline-candidate]').click(); const composer = peerInline.locator('[data-candidate-composer]');
    await composer.getByLabel(language === 'zh' ? '修改后的候选源码' : 'Edited candidate source', { exact: true }).fill('theorem target : True := by\n  exact True.intro\n');
    await composer.getByLabel(language === 'zh' ? '修改说明' : 'Change description', { exact: true }).fill('Close the goal with its explicit constructor.');
    const candidateSaved = mutation(peer, `${projectPath}/feedback`); await composer.getByRole('button', { name: language === 'zh' ? '提交检查' : 'Submit for checking', exact: true }).click();
    const candidateResponse = await candidateSaved; assert.equal(candidateResponse.status(), 201); const candidate = (await candidateResponse.json() as { item: ResearchFeedback }).item;
    assert.equal(candidate.candidateDelivery?.status, 'awaiting-review'); assert.equal(candidate.author.id, peerSession.researcherId);
    assert.equal(new URL(peer.url()).pathname, '/problem.html', 'Candidate submission stays beside the proof route');

    phase = `shared-exact-review-${language}-${width}`;
    await owner.goto(projectUrl); active = owner; const ownerInline = owner.locator('[data-research-inline-actions]'); await ownerInline.locator('[data-inline-open]').click();
    await ownerInline.getByText(language === 'zh' ? '在此审阅对应提交与决定' : 'Review related submissions and decisions here', { exact: true }).click();
    assert.equal(await ownerInline.locator('[data-feedback-scope]').inputValue(), 'task', 'The drawer initially scopes reviews to the selected task');
    const candidateRow = ownerInline.locator(`#feedback-${candidate.id}`); await candidateRow.locator('[data-candidate-delivery-status="awaiting-review"]').waitFor();
    await candidateRow.getByText(language === 'zh' ? '对公式或源码作精确评审' : 'Review a formula or exact source passage', { exact: true }).click();
    const candidateNotes = candidateRow.locator('[data-research-annotations]'); await candidateNotes.getByText(language === 'zh' ? '添加精确批注' : 'Add a passage comment', { exact: true }).click();
    await candidateNotes.locator('[data-annotation-kind="source"]').click(); await candidateNotes.locator('[data-annotation-line="2"]').click();
    await candidateNotes.getByLabel(language === 'zh' ? '这一步的疑问或修改建议' : 'Question or suggested change for this passage', { exact: true }).fill('Explain the type of this exact constructor.');
    const anchored = mutation(owner, `${projectPath}/runs/${run.id}/annotations`); await candidateNotes.locator('[data-save-annotation]').click(); assert.equal((await anchored).status(), 201);
    const reviewed = (await http<{ item: ResearchFeedback }>(owner, 'GET', `${projectPath}/feedback/${candidate.id}`)).item;
    assert.equal(reviewed.reviewComments?.[0].anchor?.kind, 'source'); assert.equal(reviewed.reviewComments?.[0].anchor?.quote, '  exact True.intro');
    assert.equal(new URL(owner.url()).pathname, '/problem.html', 'Exact peer review stays beside the route');
    await owner.screenshot({ path: path.join(output, `shared-review-${language}-${width}.png`) });

    phase = `outdated-anchors-${language}-${width}`;
    const control = controls.get(run.id)!; control.observation.sequence++; control.observation.snapshot.stateDigest = mathDigest(`source-changed:${run.id}`);
    control.observation.sources[0] = { ...control.observation.sources[0], source: source + '-- current source changed\n', commit: '2'.repeat(40), sourceDigest: mathDigest(source + '-- current source changed\n') };
    control.emit(); await owner.goto(routeUrl); await owner.locator('[data-inline-open]').click();
    await owner.locator('[data-inline-annotation-scope]').selectOption('private');
    await owner.locator(`[data-annotation-thread="${sourceNote.id}"] [data-annotation-outdated]`).waitFor();
    const old = (await http<ResearchAnnotationPage>(owner, 'GET', `${notesPath}?task=goal&taskVersion=goal-v1`)).items.find(item => item.id === sourceNote.id)!;
    assert.equal(old.staleReason, 'source-changed'); assert.equal(old.anchor.quote, '  sorry');
    assert.equal(old.status, 'resolved');
    const drawer = owner.locator('[data-inline-drawer]');
    assert.ok(await drawer.evaluate(node => node.scrollHeight > node.clientHeight && node.scrollWidth <= node.clientWidth + 1), 'Drawer scrolls internally without horizontal overflow');
    await drawer.locator('[data-inline-close]').click(); assert.equal(await owner.locator('[data-inline-open]').evaluate(node => document.activeElement === node), true);
    assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page overflow');
    checks.push({ language, width, initialScopeTask: true, drawerFocusRestored: true, drawerScrollsWithoutOverflow: true, personalPlanApproved: true, sourceAndMathAnchorsValidated: true, replyResolved: true,
      sharedClaimAndCandidateInline: true, exactReviewJoinsRevisionFlow: true, outdatedAnchorRetained: true });
    await Promise.all(actors.map(actor => actor.close()));
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0); assert.equal(compileCalls, 2); assert.equal(commands.length, 2);
} catch (error) {
  failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, errors, external, compileCalls, prohibited, ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Inline decisions and exact annotations: ${checks.length} desktop/mobile workflows passed`);
