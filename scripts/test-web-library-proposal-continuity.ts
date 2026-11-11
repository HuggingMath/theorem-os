#!/usr/bin/env bun
// Disposable HTTP/Chromium fixtures only. No models, Lean processes or mail are invoked.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { WebResearchLibraryTrials } from '../apps/web/researchLibraryTrials';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { researchMathExampleValidator } from '../apps/web/researchMathExamples';
import type { WebRunner } from '../apps/web/runner';
import type { WebPrecheckOutput, WebPrecheckRunner } from '../apps/web/precheck';
import type { ResearchFeedback } from '../apps/web/researchProjectTypes';
import { loadWebSample } from '../apps/web/sample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { freePort, preferFullCollaboration, startBrowser } from './web-scenario';
import { showArtifacts } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..'), output = path.resolve(process.env.THEOREMOS_LIBRARY_CONTINUITY_OUTPUT ?? path.join(root, 'out/library-proposal-continuity'));
const staticRoot = path.resolve(process.env.THEOREMOS_WEB_STATIC_ROOT ?? path.join(root, 'out/web'));
await fs.access(path.join(staticRoot, 'library.html')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-browser-library-trials-'));
const original = 'theorem preserved : 1 = 1 := by rfl\nnamespace Research\ntheorem target (n : Nat) : n + 0 = n := by sorry\nend Research';
const commit = 'a'.repeat(40), environmentDigest = mathDigest('browser-fixture-recorded-runtime-environment');
let workerCalls = 0, commandCalls = 0, mailCalls = 0;
const compilerCalls: Parameters<WebPrecheckRunner>[0][] = [];
const workerInputs: Parameters<WebRunner['run']>[0][] = [];
let compiler: (value: Parameters<WebPrecheckRunner>[0]) => Promise<WebPrecheckOutput> = async value =>
  ({ output: '', exitCode: 0, timedOut: false, checkedTarget: value.candidateTarget?.name });
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable trial fixture' }; },
  async run(value, send) {
    workerCalls++; workerInputs.push(structuredClone(value));
    const observed = structuredClone(loadWebSample()!.observations.at(-1)!);
    observed.webRunId = value.id; observed.sequence = 1;
    observed.inspection.configuration.environmentDigest = environmentDigest;
    observed.inspection.tasks = [{ id: 'target', kind: 'goal', objective: 'Prove the addition identity', theorem: 'Research.target',
      type: '(n : Nat) : n + 0 = n', group: 'main', status: 'working', control: 'active', version: 'task-v1', premises: ['n : Nat'],
      plannedDependencies: [], attempts: 1, proof: { status: 'open' }, parkedBy: [], parkedRoutes: {} }];
    observed.plan = { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [{ id: 'target', kind: 'goal',
      objective: 'Prove the addition identity', dependsOn: [], revision: 1, proofPath: 'Main.lean', theoremName: 'Research.target' }] };
    observed.sources = [{ taskId: 'target', taskVersion: 'task-v1', commit, sourceDigest: mathDigest(value.input.source), environmentDigest,
      file: 'Main.lean', source: value.input.source, scope: 'owned-file' }];
    observed.inspection.problem.targets = [{ theoremName: 'Research.target', proofPath: 'Main.lean' }];
    send({ type: 'observation', observation: observed });
    send({ type: 'result', result: { status: 'incomplete', proof: value.input.source, report: { fixture: true, acceptance: 'not-assessed' } } });
  },
  async command() { commandCalls++; throw new Error('Trials must not dispatch a run command'); },
  async check(value, signal) {
    compilerCalls.push(structuredClone(value)); signal.throwIfAborted();
    return Promise.race([compiler(value), new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })]);
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner,
{ sample: null, mailer: async () => { mailCalls++; throw new Error('Trials must not send mail'); } });
const fixtures = new WebResearchAssets(service.storage, { identity: owner => service.research.projects.identity(owner),
  async resolveMathematics() {
    return { environment: 'standard', environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest,
      declarations: [{ name: 'Shared.zero', type: '(n : Nat) : n + 0 = n', file: 'Submission/Library/Shared.lean' }],
      pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'Submission/Library/Shared.lean',
        source: 'namespace Shared\ntheorem zero (n : Nat) : n + 0 = n := by simp\nend Shared\n',
        origin: { kind: 'run', runId: 'browser-publication', commit, file: 'Main.lean' } }] } };
  }, async validateMathematics() { return { passed: true, receiptRefs: ['fixture-only-publication-check'] }; },
  validateMathematicsExample: researchMathExampleValidator(service.storage, runner),
});
const trials = new WebResearchLibraryTrials({ storage: service.storage, jobs: service.jobs, projects: service.research.projects, assets: fixtures, runner });
const browser = await startBrowser(service.server, port), errors: string[] = [], external: string[] = [], checks: object[] = [];
let active: Page | undefined, phase = 'setup';
async function publish(owner: string, id: string) {
  const asset = fixtures.create(owner, { requestId: id, type: 'mathematics', name: `Addition ${id}`,
    content: { source: { kind: 'run', runId: 'browser-publication', commit }, usage: { conditions: 'For $n \\in \\mathbb{N}$.', result: 'Conclude $n + 0 = n$.',
      examples: [{ id: 'universal', title: 'Quantified addition identity', declaration: 'Shared.zero', type: '∀ n : Nat, n + 0 = n',
        proof: 'by\n  intro n\n  exact Shared.zero n', argumentNotes: 'n is an arbitrary natural number.' }] } } });
  const preview = await fixtures.preview(owner, asset.id), queued = await fixtures.publish(owner, asset.id,
    { requestId: `publish-${id}`, expectedRevision: asset.revision, previewDigest: preview.previewDigest,
      version: 'v1', license: 'MIT', visibility: 'public' });
  const complete = await fixtures.waitForPublication(owner, queued.id); assert.equal(complete.status, 'completed', complete.reason);
  return fixtures.release(owner, asset.id, 'v1');
}
try {
  for (const [width, language] of [[1440, 'zh'], [390, 'en']] as const) {
    phase = `fixture-${language}`;
    const tx = (zh: string, en: string) => language === 'zh' ? zh : en;
    const context = await browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await preferFullCollaboration(context); await context.addInitScript(language => localStorage.setItem('theorem-os.web-locale.v1', language), language);
    await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(12_000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/library.html'); await page.getByRole('heading', { name: tx('数学库', 'Library'), exact: true }).waitFor();
    const owner = (await context.cookies(origin)).find(item => item.name === 'theoremos_session')!.value;
    const run = service.jobs.create(owner, { providerId: 'openai', apiKey: 'sk-DISPOSABLE-TRIAL-FIXTURE', model: 'fixture-no-model', effort: 'high', environment: 'standard', source: original, task: 'Addition trial fixture', maxTurns: 1, maxRunSeconds: 30, workers: 1, coordination: 'independent' }, { id: 'openai', name: 'Fixture', baseUrl: 'http://127.0.0.1/never-called' });
    for (let attempt = 0; attempt < 40 && run.status !== 'completed'; attempt++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(run.status, 'completed');
    const projects = ['First addition project', 'Second addition project'].map((title, index) => {
      let project = service.research.projects.create(owner, { requestId: `project-${index}`, title, visibility: 'members' });
      project = service.research.projects.addVersion(owner, project.id, { requestId: 'statement', expectedRevision: project.revision, statement: 'Addition identity', source: original, environment: 'standard' });
      return service.research.projects.bindRun(owner, project.id, { requestId: 'binding', expectedRevision: project.revision, runId: run.id, statementVersionId: project.versions[0].id, exposure: 'members', grants: { proof: true } });
    });
    const release = await publish(owner, `math-${width}`), target = trials.targets(owner, release.assetId, release.version).find(item => item.ref.runId === run.id && !item.ref.projectId)!;
    const prepare = (requestId: string) => trials.prepare(owner, release.assetId, release.version, { requestId, releaseDigest: release.digest, target: target.ref, declaration: 'Shared.zero', proof: 'by\n  exact Shared.zero n', argumentNotes: 'Library n maps to task n', missingPremises: '' });
    const prepared = prepare('prepared'), passed = await trials.check(owner, prepared.id, { requestId: 'check', expectedDigest: prepared.digest, confirmed: true }); assert.equal(passed.status, 'passed');
    const address = (id: string) => `${origin}/library.html?${new URLSearchParams({ entry: release.assetId, version: release.version, trial: id, run: run.id, task: 'target' })}`;
    const libraryReturn = address(passed.id); await page.goto(libraryReturn);
    const trial = page.locator('[data-library-trial]'), proposal = trial.locator('[data-library-trial-proposal]'), form = proposal.locator('[data-library-proposal-form]');
    const openProposal = async () => { await trial.locator('[data-library-trial-receipt]').waitFor(); if (!(await proposal.evaluate(el => (el as HTMLDetailsElement).open))) await proposal.locator(':scope > summary').click(); await form.waitFor(); };
    await openProposal();
    const explanation = form.getByRole('textbox', { name: tx('提案说明', 'Proposal explanation'), exact: true }), projectSelect = form.locator('[data-library-proposal-project]'), share = form.locator('[data-library-proposal-share]');
    const initialProject = await projectSelect.inputValue(), selectedProject = projects.find(item => item.id !== initialProject)!;
    const note = tx('参数 n 对应当前目标中的自然数；不增加前提。请核对固定 Shared.zero 的导入与目标类型，再批准新尝试。', 'The argument n matches the natural number in this goal and adds no premise. Check the fixed Shared.zero import and goal type before approving a new attempt.');
    phase = `LIB1-reload-${language}`; await projectSelect.selectOption(selectedProject.id); await explanation.fill(note); await share.check(); await page.reload(); await openProposal();
    assert.equal(await explanation.inputValue(), note); assert.equal(await projectSelect.inputValue(), selectedProject.id); assert.equal(await share.isChecked(), false);
    await form.locator('[data-library-proposal-draft-saved]').waitFor();
    phase = `LIB1-project-isolation-${language}`; await projectSelect.selectOption(initialProject); assert.equal(await explanation.inputValue(), ''); await explanation.fill('A separate explanation for the other project');
    await projectSelect.selectOption(selectedProject.id); assert.equal(await explanation.inputValue(), note); assert.equal(await share.isChecked(), false);
    phase = `LIB1-navigation-${language}`; await page.goto(`${origin}/theorems.html?id=${selectedProject.id}`); await page.locator('main[aria-busy="false"]').waitFor(); await page.goto(libraryReturn); await openProposal();
    assert.equal(await explanation.inputValue(), note); assert.equal(await projectSelect.inputValue(), selectedProject.id);
    phase = `LIB1-fixed-trial-isolation-${language}`; const another = prepare('another-trial'); await trials.check(owner, another.id, { requestId: 'another-check', expectedDigest: another.digest, confirmed: true });
    await page.goto(address(another.id)); await openProposal(); assert.equal(await explanation.inputValue(), '');
    await page.goto(libraryReturn); await openProposal(); assert.equal(await explanation.inputValue(), note);
    await proposal.screenshot({ path: path.join(output, `proposal-restored-${language}.png`) });
    checks.push({ id: 'LIB1', language, width, reloadPreservesTextAndProject: true, navigationPreservesTextAndProject: true, projectExplanationsIsolated: true, fixedTrialsIsolated: true, sharingConsentRequiresReview: true });

    phase = `LIB2-submit-and-independent-human-approval-${language}`;
    await share.check(); const responseWait = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/research/theorems/${selectedProject.id}/feedback`);
    await form.locator('[data-library-proposal-submit]').click(); const response = await responseWait; assert.equal(response.status(), 201);
    const candidate = (await response.json()).item as ResearchFeedback; assert.equal(candidate.text, note); assert.equal(candidate.projectId, selectedProject.id); assert.equal(candidate.proofCheck?.status, 'checked');
    await proposal.getByRole('link', { name: tx('打开任务提案', 'Open the task proposal'), exact: true }).click();
    const ownerFeedback = page.locator(`#feedback-${candidate.id}`); await ownerFeedback.locator('[data-candidate-delivery-status="awaiting-review"]').waitFor();
    const projectUrl = page.url(), peerContext = await browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await preferFullCollaboration(peerContext); await peerContext.addInitScript(language => localStorage.setItem('theorem-os.web-locale.v1', language), language);
    await peerContext.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    const peer = await peerContext.newPage(); peer.setDefaultTimeout(12_000); peer.on('pageerror', error => errors.push(error.message));
    await peer.goto(`${origin}/theorems.html`); await peer.locator('main[aria-busy="false"]').waitFor();
    const reviewer = (await peerContext.cookies(origin)).find(item => item.name === 'theoremos_session')!.value;
    service.research.projects.setMember(owner, selectedProject.id, service.research.projects.identity(reviewer), { requestId: 'reviewer', expectedRevision: service.research.projects.detail(owner, selectedProject.id).revision, role: 'collaborator' });
    await peer.goto(projectUrl); const peerFeedback = peer.locator(`#feedback-${candidate.id}`); await peerFeedback.locator('[data-candidate-approve]').click(); await peerFeedback.locator('[data-candidate-delivery-status="approved"]').waitFor();
    await page.reload(); await ownerFeedback.locator('[data-prepare-library-attempt]').waitFor();
    const originalBefore = JSON.stringify(run), projectBefore = service.research.projects.detail(owner, selectedProject.id), workersBefore = workerCalls;
    phase = `LIB2-origin-draft-recovery-${language}`; await ownerFeedback.locator('[data-prepare-library-attempt]').click(); await page.locator('[data-library-proposal-origin][data-library-proposal-ready=true]').waitFor();
    assert.equal(await page.locator('#source').inputValue(), passed.source);
    const editedSource = `${passed.source}\n-- deliberate personal edit after approval`; await page.locator('#source').fill(editedSource);
    await page.waitForFunction(() => Object.keys(sessionStorage).some(key => (sessionStorage.getItem(key) ?? '').includes('deliberate personal edit')));
    await page.reload(); await page.locator('[data-library-proposal-origin][data-library-proposal-origin-status=available]').waitFor();
    assert.equal(await page.locator('#source').inputValue(), editedSource); assert.equal(await page.locator(`a[href*="${candidate.id}"]`).count() > 0, true); assert.equal(workerCalls, workersBefore);
    await page.locator('[data-library-proposal-origin]').screenshot({ path: path.join(output, `origin-restored-${language}.png`) });
    phase = `LIB2-private-launch-${language}`;
    await page.evaluate(() => { const field = document.querySelector<HTMLInputElement>('#api-key')!; field.value = 'sk-DISPOSABLE-REVIEWED-ATTEMPT'; field.dispatchEvent(new Event('input', { bubbles: true })); });
    const launchWait = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
    await page.locator('#run-form').evaluate(form => (form as HTMLFormElement).requestSubmit()); const launch = await launchWait; assert.equal(launch.status(), 201, await launch.text());
    const request = launch.request().postDataJSON(), expectedOrigin = { projectId: selectedProject.id, feedbackId: candidate.id, trialDigest: passed.digest };
    assert.deepEqual(request.libraryProposalOrigin, expectedOrigin);
    const created = (await launch.json()).run;
    for (let attempt = 0; attempt < 40 && service.jobs.get(owner, created.id)?.status !== 'completed'; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    const launched = service.jobs.get(owner, created.id)!; assert.deepEqual(launched.libraryProposalOrigin, expectedOrigin);
    assert.deepEqual(service.storage.getRun(owner, created.id)?.libraryProposalOrigin, expectedOrigin);
    assert.equal(launched.source, editedSource.trim()); assert.ok(launched.researchConfiguration?.libraryPack?.modules.some(module => module.file === 'Submission/Library/Shared.lean'));
    assert.equal(workerInputs.at(-1)!.input.libraryProposalOrigin, undefined, 'Private provenance must not enter the worker');
    assert.equal(service.research.projects.detail(reviewer, selectedProject.id).runs.some(item => item.runId === launched.id), false);
    assert.equal(JSON.stringify(run), originalBefore);
    await page.locator(`.detail-heading[data-run="${launched.id}"]`).waitFor({ state: 'attached' }); await showArtifacts(page);
    const privateHeader = page.locator('[data-library-proposal-attempt]'); await privateHeader.waitFor(); await privateHeader.locator('[data-library-proposal-new-version]').waitFor();
    const attach = privateHeader.locator('[data-library-proposal-attach]'); assert.equal(await attach.isDisabled(), true);
    assert.equal(service.research.projects.detail(owner, selectedProject.id).versions.length, projectBefore.versions.length);
    await page.reload(); await page.locator(`.detail-heading[data-run="${launched.id}"]`).waitFor({ state: 'attached' }); await showArtifacts(page); await privateHeader.locator('[data-library-proposal-new-version]').waitFor(); await privateHeader.locator('[data-library-proposal-feedback]').waitFor();
    await privateHeader.screenshot({ path: path.join(output, `private-attempt-before-sharing-${language}.png`) });
    phase = `LIB2-reject-fabricated-origin-${language}`; const badRequest = structuredClone(request); badRequest.requestId = `invalid-origin-${language}`; badRequest.libraryProposalOrigin.trialDigest = 'f'.repeat(64);
    const bad = await page.evaluate(async body => { const session = await (await fetch('/api/session')).json(); const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify(body) }); return { status: response.status, value: await response.json() }; }, badRequest);
    assert.equal(bad.status, 409); assert.equal(workerCalls, workersBefore + 1);
    phase = `LIB2-explicit-sharing-and-lost-response-${language}`;
    let lose = true; const attachmentRequests: object[] = [];
    await page.route(`**/api/research/theorems/${selectedProject.id}/library-proposals/${candidate.id}/attempts`, async route => {
      attachmentRequests.push(route.request().postDataJSON()); const response = await route.fetch();
      if (lose) { lose = false; assert.equal(response.status(), 200); await route.fulfill({ status: 503, json: { error: 'Fixture attachment response lost' } }); } else await route.fulfill({ response });
    });
    await privateHeader.locator('[data-library-proposal-attach-confirm]').check(); await attach.click(); await privateHeader.getByRole('alert').filter({ hasText: 'Fixture attachment response lost' }).waitFor();
    await attach.click(); await page.locator('[data-library-proposal-attachment=attached]').waitFor(); assert.deepEqual(attachmentRequests[0], attachmentRequests[1]);
    const projectAfter = service.research.projects.detail(owner, selectedProject.id), binding = projectAfter.runs.find(item => item.runId === launched.id)!;
    assert.equal(projectAfter.versions.length, projectBefore.versions.length + 1); assert.deepEqual(projectAfter.versions[0], projectBefore.versions[0]);
    assert.equal(binding.exposure, 'members'); assert.deepEqual(binding.grants, { guidance: false, edit: false, approve: false, proof: false });
    assert.deepEqual(binding.libraryProposalOrigin, expectedOrigin);
    const sourceProposalAfter = projectAfter.feedback.find(item => item.id === candidate.id)!; assert.equal(sourceProposalAfter.candidateDelivery?.status, 'approved'); assert.deepEqual(sourceProposalAfter.target, candidate.target);
    phase = `LIB2-member-visible-followthrough-${language}`; await peer.goto(projectUrl); await peerFeedback.locator(`[data-library-proposal-followup="${launched.id}"]`).waitFor();
    const sharedRead = await peer.evaluate(async pathname => (await (await fetch(pathname)).json()).run, `/api/research/theorems/${selectedProject.id}/runs/${launched.id}`);
    assert.equal(sharedRead.libraryProposalOrigin, undefined, 'Cross-account run views omit private source handles');
    await peerFeedback.locator('[data-library-proposal-followups]').screenshot({ path: path.join(output, `project-followup-${language}.png`) });
    await peerFeedback.locator(`[data-library-proposal-followup="${launched.id}"]`).click(); assert.equal(new URL(peer.url()).searchParams.get('run'), launched.id);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    checks.push({ id: 'LIB2', language, width, originSurvivesEditedDraftAndReload: true, editableSourceStartsPrivateRun: true, persistedOrigin: expectedOrigin, fixedLibraryTransport: true, workerOriginStripped: true, invalidOriginStatus: bad.status, privateUntilExplicitAttachment: true, explicitNewVersion: true, lostAttachmentResponseRetriedSameRequest: true, newStatementVersions: projectAfter.versions.length - projectBefore.versions.length, originalStatementUnchanged: true, originalProposalAndRunUnchanged: true, sharedGrants: binding.grants, memberCanFollowOriginalProposalToAttempt: true, crossAccountRunOriginStripped: true });
    await peerContext.close(); await context.close(); active = undefined;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(commandCalls, 0); assert.equal(mailCalls, 0);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', fixtureOnly: true, checks, recordedChecks: compilerCalls.length, recordedWorkers: workerCalls, commandCalls, mailCalls, errors, external }, null, 2));
  console.log(JSON.stringify({ status: 'passed', output, checks: checks.length }));
} catch (error) {
  await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  const state = await active?.evaluate(() => ({ url: location.href, alerts: [...document.querySelectorAll('[role="alert"]')].map(item => item.textContent) })).catch(() => undefined);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', phase, error: String(error), state, checks, errors, external }, null, 2)); throw error;
} finally { await browser.close(); await trials.close(); await fixtures.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
