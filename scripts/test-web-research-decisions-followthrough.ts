#!/usr/bin/env bun
// Disposable HTTP/Chromium state. All mathematics, approval delivery and people are fixture data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebObservation } from '../apps/web/collaboration';
import type { ResearchFeedback } from '../apps/web/researchProjectTypes';
import { readingRun, readingEnvironment } from '../tests/helpers/shareReadingFixture';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { freePort, preferFullCollaboration, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/product-continuity/research-followthrough/decisions');
await fs.mkdir(output, { recursive: true });
const build = JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8'));
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-decision-continuity-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const controls = new Map<string, { observation: WebObservation; emit(): void }>(), originals = new Map<string, WebObservation>();
const commands: { runId: string; id: string; planVersion?: string }[] = [], checks: object[] = [], errors: string[] = [], external: string[] = [];
let prohibited = 0, phase = 'setup', active: Page | undefined, failure: unknown;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable decision continuity fixture' }; },
  async run(input, send, signal) {
    const fixture = readingRun(input.id), observation = fixture.observation!;
    observation.sequence = 1; observation.snapshot.stateDigest = mathDigest(`decision-first:${input.id}`);
    observation.inspection.configuration.environmentDigest = readingEnvironment; observation.inspection.planVersion = 'decision-plan-1';
    observation.plan!.baseVersion = 'decision-plan-1'; observation.guidance = []; observation.inspection.edits = [];
    observation.inspection.planApproval = input.input.model === 'fixture-approval'
      ? { required: true, status: 'pending', planVersion: 'decision-plan-1', rejections: [], leadRevising: false } : undefined;
    for (const check of observation.checks) check.record = { passed: true };
    originals.set(input.id, structuredClone(observation)); send({ type: 'observation', observation: structuredClone(observation) });
    if (input.input.model === 'fixture-history') {
      observation.sequence = 2; observation.snapshot.stateDigest = mathDigest(`decision-second:${input.id}`);
      observation.inspection.tasks[0].version = mathDigest('decision-task-v2'); observation.inspection.tasks[0].informalProof = 'Second derivation';
      observation.sources[0].taskVersion = observation.inspection.tasks[0].version;
      send({ type: 'observation', observation }); send({ type: 'result', result: fixture.result! }); return;
    }
    await new Promise<void>(resolve => {
      controls.set(input.id, { observation, emit() { send({ type: 'observation', observation: structuredClone(this.observation) }); } });
      if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  async command(runId, command) {
    if (command.type === 'capture') return { id: 'capture', status: 'captured' };
    assert.equal(command.type, 'plan-approval');
    if (command.type !== 'plan-approval') throw new Error('Unexpected fixture command');
    commands.push({ runId, id: command.approval.id, planVersion: command.approval.planVersion });
    return { id: command.approval.id, status: 'unknown', reason: 'Fixture delivery cannot yet be confirmed' };
  },
  async check() { prohibited++; throw new Error('No compiler in this scenario'); },
  async formalize() { prohibited++; throw new Error('No model in this scenario'); },
  async explain() { prohibited++; throw new Error('No model in this scenario'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '6' }), runner,
  { sample: null, mailer: async () => { prohibited++; throw new Error('No mail in this scenario'); } });
const browser = await startBrowser(service.server, port);
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    phase = `setup-${language}-${width}`;
    const actors = await Promise.all([0, 1].map(() => browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', viewport: { width, height: 1000 }, reducedMotion: 'reduce' })));
    for (const actor of actors) {
      await actor.addInitScript(language => { localStorage.setItem('theorem-os.web-locale.v1', language); }, language);
      await preferFullCollaboration(actor);
      await actor.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    }
    const [page, peer] = await Promise.all(actors.map(actor => actor.newPage())); active = page;
    for (const current of [page, peer]) { current.setDefaultTimeout(20_000); current.on('pageerror', error => errors.push(error.message)); }
    await Promise.all([page, peer].map(current => current.goto(origin + '/workspace.html')));
    await page.locator('.workspace-tabs').waitFor();
    const owner = (await actors[0].cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const peerOwner = (await actors[1].cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const session = await page.evaluate(async () => (await fetch('/api/session')).json()), provider = session.providers[0], source = readingRun().source.trim();
    const peerId = service.research.projects.identity(peerOwner);
    service.research.projects.saveProfile(owner, { requestId: 'owner-profile', expectedRevision: 0, displayName: 'Project Owner', visibility: 'public' });
    service.research.projects.saveProfile(peerOwner, { requestId: 'private-peer-profile', expectedRevision: 0, displayName: 'Private Teammate', visibility: 'private', bio: 'PRIVATE_PROFILE_BIO' });
    const create = (model: string) => service.jobs.create(owner, { providerId: provider.id, apiKey: 'sk-disposable-not-sent', model, effort: 'high', source,
      task: 'Trace the saved mathematical route', environment: 'standard', maxTurns: 2, maxRunSeconds: 600, workers: 1, coordination: 'cooperative' }, provider);
    const history = create('fixture-history'); await page.waitForFunction(async id => (await (await fetch(`/api/runs/${id}`)).json()).run.status === 'completed', history.id);
    let project = service.research.projects.create(owner, { requestId: 'project', title: 'Decision continuity', visibility: 'members' });
    project = service.research.projects.setMember(owner, project.id, peerId, { requestId: 'private-peer', expectedRevision: project.revision, role: 'collaborator' });
    project = service.research.projects.addVersion(owner, project.id, { requestId: 'version', expectedRevision: project.revision, statement: 'A fixed duplicate equality', source, environment: 'standard' });
    project = service.research.projects.bindRun(owner, project.id, { requestId: 'history-binding', expectedRevision: project.revision, runId: history.id, statementVersionId: project.versions[0].id });

    phase = `historical-step-discussion-${language}-${width}`;
    const old = originals.get(history.id)!, task = old.inspection.tasks[0];
    const savedRoute = `${origin}/problem.html?${new URLSearchParams({ run: history.id, project: project.id, tab: 'route', at: '1', atState: old.snapshot.stateDigest, task: task.id, taskVersion: task.version, commit: task.proof.commit! })}`;
    await page.goto(savedRoute); await page.locator('[data-evolution-selected="1"]').waitFor();
    await page.getByRole('button', { name: language === 'zh' ? '讨论这一步' : 'Discuss this step', exact: true }).click();
    const composer = page.locator('[data-discussion-composer]'); await composer.locator('[data-discussion-context]').waitFor();
    assert.equal(await page.locator('[data-feedback-scope]').inputValue(), 'task');
    assert.equal(await page.locator('[data-feedback-scope] option[value="task"]').evaluate(node => (node as HTMLOptionElement).disabled), false);
    assert.ok(!(await page.locator('.problem-context').innerText()).includes('此尝试没有这一节点版本'));
    await composer.getByLabel(language === 'zh' ? '讨论内容' : 'Discussion', { exact: true }).fill('Explain the original transition from normalization to conclusion.');
    const posted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/research/theorems/${project.id}/feedback`);
    await composer.getByRole('button', { name: language === 'zh' ? '保存讨论' : 'Save discussion', exact: true }).click();
    const response = await posted; assert.equal(response.status(), 201); const discussion = (await response.json() as { item: ResearchFeedback }).item;
    assert.deepEqual(discussion.discussionContext, { runId: history.id, statementVersionId: project.versions[0].id,
      observationRef: { sequence: 1, stateDigest: old.snapshot.stateDigest }, taskRef: { id: task.id, version: task.version }, commit: task.proof.commit, taskTitle: task.objective });
    assert.equal(discussion.target, undefined); const comment = page.locator(`#feedback-${discussion.id}`); await comment.waitFor();
    const returnLink = comment.locator('[data-discussion-return-context]'); assert.equal(new URL((await returnLink.getAttribute('href'))!, origin).searchParams.get('atState'), old.snapshot.stateDigest);
    await comment.screenshot({ path: path.join(output, `historical-discussion-${language}-${width}.png`) });
    await returnLink.click(); await page.locator('[data-evolution-selected="1"]').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('taskVersion'), task.version);

    phase = `approval-restoration-${language}-${width}`;
    const running = create('fixture-approval'); await page.waitForFunction(async id => Boolean((await (await fetch(`/api/runs/${id}`)).json()).run.observation), running.id);
    const runningUrl = `${origin}/problem.html?run=${running.id}`, sentBodies: { id: string; planVersion: string }[] = [];
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/runs/${running.id}/plan-approval`) sentBodies.push(request.postDataJSON()); });
    await page.goto(runningUrl); await page.locator('[data-problem-review-plan]').click(); await page.locator('[data-inline-confirm-plan]').check(); await page.locator('[data-inline-approve-plan]').click();
    await page.locator('[data-inline-command-status="unknown"]').waitFor(); const originalId = commands.filter(item => item.runId === running.id)[0].id;
    await page.reload(); await page.locator('[data-inline-open]').click(); await page.locator('[data-inline-command-status="unknown"]').waitFor();
    assert.equal(await page.locator('[data-inline-personal-approval]').getAttribute('data-approval-request-id'), originalId);
    assert.equal(await page.locator('[data-inline-approve-plan]').isDisabled(), true);
    assert.equal(await page.locator('[data-inline-confirm-plan]').isDisabled(), true);
    assert.equal(sentBodies.length, 1, 'Reload checks the receipt without resending approval');
    let missingReceipt = true;
    await page.route(`**/api/runs/${running.id}/commands/${originalId}`, async route => {
      if (missingReceipt) { missingReceipt = false; await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Receipt unavailable in this controlled request' }) }); }
      else await route.continue();
    });
    await page.locator('[data-inline-retry-command]').click(); await page.waitForFunction(id => document.querySelector('[data-inline-personal-approval]')?.getAttribute('data-approval-request-id') === id && !document.querySelector<HTMLButtonElement>('[data-inline-retry-command]')?.disabled, originalId);
    assert.equal(sentBodies.length, 2); assert.equal(sentBodies[1].id, originalId); assert.equal(commands.filter(item => item.runId === running.id).length, 1);
    await page.goto(origin + '/workspace.html'); await page.goto(runningUrl + '&tab=route'); await page.locator('[data-inline-open]').click(); await page.locator('[data-inline-command-status="unknown"]').waitFor();
    const control = controls.get(running.id)!; control.observation.sequence++; control.observation.snapshot.stateDigest = mathDigest(`plan-changed:${running.id}`);
    control.observation.plan!.baseVersion = 'decision-plan-2'; control.observation.inspection.planVersion = 'decision-plan-2'; control.observation.inspection.planApproval!.planVersion = 'decision-plan-2'; control.emit();
    await page.reload(); await page.locator('[data-inline-open]').click(); await page.locator('[data-inline-command-status="unknown"]').waitFor();
    assert.match(await page.locator('[data-personal-approval-original]').innerText(), /decision-plan-1/u);
    assert.equal(await page.locator('[data-inline-approve-plan]').isDisabled(), true);
    missingReceipt = true; await page.locator('[data-inline-retry-command]').click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-inline-retry-command]')?.disabled);
    assert.equal(sentBodies.length, 2, 'A changed current plan cannot replace or resend the original approval');
    await page.locator('[data-inline-drawer]').screenshot({ path: path.join(output, `approval-restored-${language}-${width}.png`) });
    control.observation.sequence++; control.observation.snapshot.stateDigest = mathDigest(`approval-rejected:${running.id}`);
    control.observation.inspection.planApproval!.rejections = [{ id: originalId, planVersion: 'decision-plan-1', reason: 'The saved plan was superseded.', at: Date.now() }]; control.emit();
    await page.reload(); await page.locator('[data-inline-open]').click(); await page.locator('[data-inline-command-status="rejected"]').waitFor();
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[data-inline-confirm-plan]')?.disabled === false);
    assert.equal(await page.locator('[data-inline-confirm-plan]').isDisabled(), false); assert.equal(await page.locator('[data-inline-confirm-plan]').isChecked(), false);
    const savedAttempts = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('theoremos:personal-approval:v1:')).map(key => localStorage.getItem(key)));
    assert.ok(!savedAttempts.some(item => item?.includes(originalId))); assert.equal(service.storage.listCommands(owner, running.id).length, 1);

    phase = `private-member-role-and-selectors-${language}-${width}`;
    project = service.research.projects.detail(owner, project.id);
    project = service.research.projects.bindRun(owner, project.id, { requestId: 'running-binding', expectedRevision: project.revision, runId: running.id,
      statementVersionId: project.versions[0].id, grants: { guidance: true, edit: true, approve: true, proof: true } });
    const review = service.research.projects.submitFeedback(owner, project.id, { requestId: 'review-discussion', kind: 'discussion', text: 'Check this argument before continuing.' });
    const liveTask = control.observation.inspection.tasks[0];
    await page.goto(`${origin}/theorems.html?${new URLSearchParams({ id: project.id, run: running.id, task: liveTask.id, taskVersion: liveTask.version })}`);
    const member = page.locator(`[data-project-member="${peerId}"]`); await member.waitFor();
    assert.match(await member.innerText(), /Private Teammate/u); assert.equal(await member.locator('a').count(), 0);
    assert.equal(await page.evaluate(async id => (await fetch(`/api/research/people/${id}`)).status, peerId), 404);
    assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_PROFILE_BIO'));
    const workspace = page.locator('[data-task-workspace]'); await workspace.getByRole('combobox').first().selectOption(JSON.stringify([liveTask.id, liveTask.version]));
    await workspace.getByText(language === 'zh' ? '正式交接给同行' : 'Hand off to a colleague', { exact: true }).click();
    const handoff = workspace.getByLabel(language === 'zh' ? '接手人' : 'Next researcher');
    const reviewer = page.locator(`#feedback-${review.id} [data-reviewer-select]`); await reviewer.waitFor();
    const expectedName = language === 'zh' ? 'Private Teammate · 协作者' : 'Private Teammate · Collaborator';
    assert.equal(await handoff.locator(`option[value="${peerId}"]`).innerText(), expectedName);
    assert.equal(await reviewer.locator(`option[value="${peerId}"]`).innerText(), expectedName);
    const role = member.locator('[data-member-role]');
    const changed = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/research/theorems/${project.id}/members/${peerId}`);
    await role.selectOption('reader'); assert.equal((await changed).status(), 200);
    await page.waitForFunction(id => document.querySelector<HTMLSelectElement>(`[data-member-role="${id}"]`)?.value === 'reader'
      && !document.querySelector(`[data-reviewer-select] option[value="${id}"]`), peerId);
    assert.equal(await handoff.locator(`option[value="${peerId}"]`).count(), 0);
    assert.equal(service.research.projects.detail(peerOwner, project.id).permissions.edit, false);
    await member.screenshot({ path: path.join(output, `private-member-${language}-${width}.png`) });
    const restored = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/research/theorems/${project.id}/members/${peerId}`);
    await role.selectOption('collaborator'); assert.equal((await restored).status(), 200);
    await reviewer.locator(`option[value="${peerId}"]`).waitFor({ state: 'attached' });
    assert.equal(await reviewer.locator(`option[value="${peerId}"]`).innerText(), expectedName);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow');
    assert.equal(commands.filter(item => item.runId === running.id).length, 1); assert.equal(sentBodies.every(item => item.id === originalId && item.planVersion === 'decision-plan-1'), true);
    service.jobs.cancel(owner, running.id);
    checks.push({ language, width, historicalContextSavedAndReturned: true, taskFilterRetainsDiscussion: true, reloadAndNavigationRetainOriginalApproval: true,
      missingReceiptRetryUsesOriginalId: true, changedPlanCannotReplaceOriginal: true, rejectionRequiresReviewAgain: true, privateMemberNameAndRoleConsistent: true,
      privateProfileRemainsUnreadable: true, rowRoleUpdatesBothSelectors: true, approvalCommands: 1 });
    await Promise.all(actors.map(actor => actor.close()));
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0);
} catch (cause) { failure = cause; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', build, phase, checks, errors, external, prohibited,
    ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Research decision continuity: ${checks.length} desktop/mobile workflows passed`);
