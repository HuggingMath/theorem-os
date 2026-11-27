#!/usr/bin/env bun
// Disposable HTTP sessions and a controlled recorded runner; no model, Lean, mail or production access.
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
import type { ResearchAnnotation, ResearchAnnotationPage, ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import type { ResearchCollaborationInbox, ResearchIssue } from '../apps/web/researchCollaborationTypes';
import type { ResearchProblem, ResearchStageConclusion } from '../apps/web/researchProblemTypes';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, startBrowser, preferFullCollaboration } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/product-continuity/message-stage');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-message-stage-'));
const sample = loadWebSample()!, port = await freePort(), origin = `http://127.0.0.1:${port}`;
let prohibited = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable message and stage workflow' }; },
  async run(input, send) {
    const observation = structuredClone(sample.observations.at(-1)!);
    observation.webRunId = input.id; observation.sequence = 1; observation.snapshot.stateDigest = mathDigest(`message-stage:${input.id}`);
    observation.inspection.tasks[0].informalProof = 'Subtract $b$ on both sides, then substitute into the closing goal.';
    observation.inspection.planApproval = undefined; observation.inspection.edits = []; observation.guidance = [];
    send({ type: 'observation', observation });
    send({ type: 'result', result: { status: 'limit_reached', proof: '', report: { usage: { totalTokens: 1200 } } } });
  },
  async check() { prohibited++; throw new Error('No Lean in this workflow'); },
  async formalize() { prohibited++; throw new Error('No model in this workflow'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_CLIENT_IP_HEADER: 'x-fixture-scenario' }), runner,
{ sample: null, mailer: async () => { prohibited++; throw new Error('No mail in this workflow'); } });
const browser = await startBrowser(service.server, port), checks: object[] = [], errors: string[] = [], external: string[] = [];
let phase = 'setup', active: Page | undefined, failure: unknown;
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
    const actors = await Promise.all([0, 1].map(index => browser.newContext({ viewport: { width, height: 1000 }, locale: language === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce', extraHTTPHeaders: { 'x-fixture-scenario': `message-stage-${language}-${index}` } })));
    for (const actor of actors) {
      await actor.addInitScript(({ key, language }) => { try { localStorage.setItem(key, language); } catch { /* Initial opaque documents do not expose storage. */ } }, { key: localeStorageKey, language });
      await preferFullCollaboration(actor);
      await actor.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
      actor.on('page', page => { page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); });
    }
    const [owner, peer] = await Promise.all(actors.map(actor => actor.newPage())); active = owner;
    await Promise.all([owner, peer].map(page => page.goto(origin + '/theorems.html')));
    for (const [page, name] of [[owner, 'Stage author'], [peer, 'Stage peer']] as const) await http(page, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(), expectedRevision: 0, displayName: name, visibility: 'public' });
    const peerSession = await http<{ researcherId: string }>(peer, 'GET', '/api/research/session');
    const run = await seedCooperativeRun(service, owner.context(), origin, { providerId: 'openai', apiKey: 'sk-disposable-message-fixture', model: 'fixture', effort: 'low', environment: sample.run.environment,
      source: sample.run.source.trim(), task: 'Message and stage workflow', maxTurns: 2, maxRunSeconds: 60, workers: 2, coordination: 'cooperative' });
    await owner.waitForFunction(async id => (await (await fetch(`/api/runs/${id}`)).json()).run.status === 'completed', run.id);
    const problemPath = `/api/research/workspace/problem/${run.id}`, initial = (await http<{ item: ResearchProblem }>(owner, 'GET', problemPath)).item;
    const stage = (await http<{ item: ResearchStageConclusion }>(owner, 'POST', `${problemPath}/stages`, { requestId: crypto.randomUUID(), evidenceDigest: initial.evidenceDigest,
      title: 'Frozen reduction', conclusion: 'Subtract $b$ and obtain $a=c-b$.', boundaries: 'An additive group.', unresolved: 'The final goal is still open.', next: 'Check the closing substitution.' })).item;
    let project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', '/api/research/theorems', { requestId: crypto.randomUUID(), title: 'Stage discussion', visibility: 'members' })).item;
    const projectPath = `/api/research/theorems/${project.id}`;
    project = (await http<{ item: ResearchProjectDetail }>(owner, 'PUT', `${projectPath}/members/${peerSession.researcherId}`, { requestId: crypto.randomUUID(), role: 'collaborator', expectedRevision: project.revision })).item;
    project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', `${projectPath}/versions`, { requestId: crypto.randomUUID(), expectedRevision: project.revision, source: sample.run.source.trim(), statement: 'A recorded mathematical problem', environment: sample.run.environment })).item;
    project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', `${projectPath}/runs`, { requestId: crypto.randomUUID(), expectedRevision: project.revision, runId: run.id, statementVersionId: project.currentStatementVersionId })).item;
    const privatePeerView = (await http<{ item: ResearchProblem }>(peer, 'GET', `${problemPath}?project=${project.id}`)).item;
    assert.equal(privatePeerView.stages.length, 0, 'Personal conclusions remain private before explicit reference');
    await http(peer, 'POST', `${projectPath}/feedback`, { requestId: crypto.randomUUID(), kind: 'discussion', text: 'Is the closing substitution justified?', statementVersionId: project.currentStatementVersionId });

    phase = `annotation-message-${language}-${width}`;
    const task = initial.brief.tasks[0], notesPath = `${projectPath}/runs/${run.id}/annotations`;
    const notes = await http<ResearchAnnotationPage>(peer, 'GET', `${notesPath}?${new URLSearchParams({ task: task.id, taskVersion: task.version })}`);
    const field = notes.context.fields.find(item => item.field === 'derivation')!; assert.ok(field);
    const annotation = (await http<{ item: ResearchAnnotation }>(peer, 'POST', notesPath, { requestId: crypto.randomUUID(), target: { observationRef: notes.context.target.observationRef, taskRef: notes.context.target.taskRef },
      anchor: { kind: 'mathematics', field: field.field, fieldDigest: field.digest, startOffset: 0, endOffset: field.text.length, quote: field.text }, text: 'Explain how this connects to the closing goal.' })).item;
    const inboxPath = '/api/research/collaboration/inbox';
    const inbox = await http<ResearchCollaborationInbox>(owner, 'GET', inboxPath), annotationItem = inbox.items.find(item => item.kind === 'annotation')!;
    assert.ok(annotationItem); assert.equal(annotationItem.category, 'reply');
    assert.ok(inbox.items.some(item => item.kind === 'update' && item.category === 'progress'));
    assert.equal(inbox.pending, inbox.counts.decision + inbox.counts.reply);
    await owner.goto(origin + '/workspace.html?tab=inbox&inbox=reply#collaboration-inbox');
    const center = owner.locator('[data-collaboration-inbox]'); await center.locator(`[data-inbox-item="${annotationItem.id}"]`).waitFor();
    await center.locator('[data-inbox-filter="progress"]').click();
    assert.equal(await center.locator(`[data-inbox-item="${annotationItem.id}"]`).count(), 0);
    assert.doesNotMatch(await center.innerText(), /提出讨论建议/);
    await center.locator('[data-inbox-filter="reply"]').click();
    await center.locator(`[data-inbox-item="${annotationItem.id}"]`).getByRole('link', { name: language === 'zh' ? '打开并继续' : 'Open and continue', exact: true }).click();
    await owner.locator('[data-inline-drawer][open]').waitFor();
    const thread = owner.locator(`[data-annotation-thread="${annotation.id}"]`); await thread.waitFor();
    assert.equal(new URL(owner.url()).searchParams.get('annotation'), annotation.id);
    await thread.getByLabel(language === 'zh' ? '回应这条批注' : 'Reply to this comment', { exact: true }).fill('The substitution uses the equality obtained in this reduction.');
    const replied = mutation(owner, `${notesPath}/${annotation.id}`); await thread.locator('[data-reply-annotation]').click(); assert.equal((await replied).status(), 200);
    await peer.goto(origin + '/workspace.html?tab=inbox&inbox=reply'); active = peer;
    const peerInbox = await http<ResearchCollaborationInbox>(peer, 'GET', inboxPath), replyItem = peerInbox.items.find(item => item.kind === 'annotation')!;
    assert.equal(replyItem.read, false); assert.match(replyItem.text ?? '', /substitution/);
    await peer.locator(`[data-inbox-item="${replyItem.id}"]`).getByRole('link', { name: language === 'zh' ? '打开并继续' : 'Open and continue', exact: true }).click();
    const peerThread = peer.locator(`[data-annotation-thread="${annotation.id}"]`); await peerThread.waitFor();
    const resolved = mutation(peer, `${notesPath}/${annotation.id}`); await peerThread.locator('[data-resolve-annotation]').click(); assert.equal((await resolved).status(), 200);
    const after = await http<ResearchCollaborationInbox>(owner, 'GET', inboxPath);
    assert.ok(after.items.some(item => item.kind === 'annotation' && item.resolved && item.category === 'progress'));
    await owner.goto(origin + '/workspace.html?tab=inbox&inbox=progress'); active = owner;
    await owner.locator('[data-inbox-read-all]').click();
    await owner.waitForFunction(async () => (await (await fetch('/api/research/collaboration/inbox')).json()).unread === 0);
    assert.ok((await http<{ items: { read: boolean }[] }>(owner, 'GET', '/api/research/notifications')).items.every(item => item.read));
    await owner.screenshot({ path: path.join(output, `messages-${language}-${width}.png`), fullPage: true });

    phase = `stage-reference-${language}-${width}`;
    await owner.goto(`${origin}/problem.html?${new URLSearchParams({ run: run.id, project: project.id, tab: 'stages' })}`);
    const reference = owner.locator(`[data-stage-reference-control="${stage.id}"]`); await reference.waitFor();
    await reference.getByText(language === 'zh' ? '引用到项目议题' : 'Reference in a project issue', { exact: true }).click();
    await reference.getByLabel(language === 'zh' ? '议题名称' : 'Issue title', { exact: true }).fill('Choose the next proof step');
    await reference.getByLabel(language === 'zh' ? '希望共同讨论什么' : 'What should the project discuss?', { exact: true }).fill('Should we prove the substitution or check the boundary first?');
    const referenced = mutation(owner, `${problemPath}/stages/${stage.id}/reference`); await reference.locator('[data-stage-reference-submit]').click();
    const response = await referenced; assert.equal(response.status(), 201); const issue = (await response.json() as { item: ResearchIssue }).item;
    assert.equal(issue.stageReference?.author.displayName, 'Stage author'); assert.equal(issue.stageReference?.evidenceDigest, stage.evidenceDigest);
    assert.equal(issue.stageReference?.snapshot.attempts.length, 0);
    await reference.locator('[data-stage-reference-link]').click();
    const shared = owner.locator(`[data-shared-stage-reference="${stage.id}"]`); await shared.waitFor();
    await shared.locator('[data-stage-reference-evidence] summary').click();
    await shared.locator('.solution-route').waitFor();
    assert.match(await shared.innerText(), /Stage author/); assert.match(await shared.innerText(), /final goal is still open/);
    assert.doesNotMatch(await shared.innerText(), /limit_reached/);
    await owner.screenshot({ path: path.join(output, `stage-${language}-${width}.png`), fullPage: true });
    await peer.goto(`${origin}/problem.html?${new URLSearchParams({ run: run.id, project: project.id, tab: 'discussion' })}#issue-${issue.id}`); active = peer;
    await peer.locator(`[data-shared-stage-reference="${stage.id}"]`).waitFor();
    assert.ok(await peer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal overflow');
    checks.push({ language, width, progressExcludedFromPending: true, annotationReplyLocated: true, resolvedMovesToProgress: true, unifiedRead: true, personalStagePrivate: true, stageExplicitlyReferenced: true, frozenRouteVisibleToPeer: true });
    await Promise.all(actors.map(actor => actor.close()));
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0);
} catch (error) {
  failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, errors, external, prohibited,
    ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Message and stage continuity: ${checks.length} workflows passed`);
