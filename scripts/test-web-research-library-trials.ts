#!/usr/bin/env bun
// Disposable HTTP/Chromium fixtures only. No models, Lean processes or mail are invoked.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { researchMathExampleValidator } from '../apps/web/researchMathExamples';
import type { WebRunner } from '../apps/web/runner';
import type { WebPrecheckOutput, WebPrecheckRunner } from '../apps/web/precheck';
import type { ResearchLibraryTrial } from '../apps/web/researchLibraryTrialTypes';
import type { ResearchFeedback } from '../apps/web/researchProjectTypes';
import { loadWebSample } from '../apps/web/sample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { freePort, preferFullCollaboration, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/research-library-trials');
await fs.access(path.join(root, 'out/web/library.html')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-browser-library-trials-'));
const original = 'theorem preserved : 1 = 1 := by rfl\nnamespace Research\ntheorem target (n : Nat) : n + 0 = n := by sorry\nend Research';
const commit = 'a'.repeat(40), environmentDigest = getLeanTaskEnvironment('standard').dependencyDigest;
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
    observed.sources = [{ taskId: 'target', taskVersion: 'task-v1', commit, sourceDigest: mathDigest(original), environmentDigest,
      file: 'Main.lean', source: original, scope: 'owned-file' }];
    observed.inspection.problem.targets = [{ theoremName: 'Research.target', proofPath: 'Main.lean' }];
    send({ type: 'observation', observation: observed });
    send({ type: 'result', result: { status: 'incomplete', proof: original, report: { fixture: true, acceptance: 'not-assessed' } } });
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
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner,
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
    phase = `trial-${width}-${language}`;
    const tx = (zh: string, en: string) => language === 'zh' ? zh : en;
    const context = await browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await preferFullCollaboration(context);
    await context.addInitScript(language => { try { localStorage.setItem('theorem-os.web-locale.v1', language); } catch { /* Blank page. */ } }, language);
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
    });
    context.on('page', page => { page.setDefaultTimeout(12_000); page.on('pageerror', error => errors.push(error.message)); });
    const page = await context.newPage(); active = page;
    await page.goto(origin + '/library.html');
    await page.getByRole('heading', { name: tx('数学库', 'Library'), exact: true }).waitFor();
    const owner = (await context.cookies(origin)).find(item => item.name === 'theoremos_session')!.value;
    const run = service.jobs.create(owner, { providerId: 'openai', apiKey: 'sk-DISPOSABLE-TRIAL-FIXTURE', model: 'fixture-no-model',
      effort: 'high', environment: 'standard', source: original, task: 'Addition trial fixture', maxTurns: 1, maxRunSeconds: 30,
      workers: 1, coordination: 'independent' }, { id: 'openai', name: 'Fixture', baseUrl: 'http://127.0.0.1/never-called' });
    for (let attempt = 0; attempt < 20 && run.status !== 'completed'; attempt++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(run.status, 'completed');
    let project = service.research.projects.create(owner, { requestId: 'project', title: 'Addition project', visibility: 'members' });
    project = service.research.projects.addVersion(owner, project.id, { requestId: 'statement', expectedRevision: project.revision,
      statement: 'Addition identity', source: original, environment: 'standard' });
    project = service.research.projects.bindRun(owner, project.id, { requestId: 'binding', expectedRevision: project.revision,
      runId: run.id, statementVersionId: project.versions[0].id, exposure: 'members', grants: { proof: true } });
    const release = await publish(owner, `math-${width}`), initialCalls = compilerCalls.length, workersBefore = workerCalls;
    const before = JSON.stringify(run), beforeCommands = commandCalls;
    const entry = new URLSearchParams({ run: run.id, project: project.id, task: 'target', taskVersion: 'task-v1', commit });
    await page.goto(`${origin}/library.html?${entry}`);
    await page.locator('[data-library-collection="shared"]').click();
    await page.getByRole('link', { name: new RegExp(`Addition math-${width}`) }).first().click();
    assert.equal(new URL(page.url()).searchParams.get('run'), run.id, 'Directory navigation keeps the exact task context');
    assert.equal(new URL(page.url()).searchParams.get('project'), project.id);
    const trial = page.locator('[data-library-trial]');
    phase = `checked-examples-${width}-${language}`;
    const example = page.locator('[data-math-example="universal"]');
    await example.locator(':scope > summary').click();
    await example.getByText(tx('独立检查通过', 'Independently checked'), { exact: true }).waitFor();
    assert.ok(await page.locator('[data-math-usage] .katex').count() >= 2, 'Applicability and result formulas render with KaTeX');
    await example.locator('[data-load-math-example]').click(); await trial.locator('[data-math-example-loaded]').waitFor();
    assert.equal(compilerCalls.length, initialCalls, 'Loading a checked example must not compile or submit it');
    const goals = trial.getByRole('combobox', { name: tx('研究 / 精确任务版本', 'Research / exact task version'), exact: true });
    await goals.locator('option:checked').filter({ hasText: 'Research.target' }).waitFor({ state: 'attached' });
    const proof = trial.getByRole('textbox', { name: tx('候选 Lean 证明体', 'Candidate Lean proof body'), exact: true });
    const argumentsNote = trial.getByRole('textbox', { name: tx('参数如何对应（可选）', 'Argument mapping (optional)'), exact: true });
    assert.equal(await proof.inputValue(), 'by\n  intro n\n  exact Shared.zero n');
    await argumentsNote.fill('Library n maps to task n'); await proof.fill('by\n  exact Shared.zero n\n');
    const prepare = trial.getByRole('button', { name: tx('准备并审阅候选', 'Prepare candidate for review'), exact: true });
    const preparedResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/research/library/${release.assetId}/releases/${release.version}/trials`);
    phase = `prepare-${width}-${language}`; await prepare.click();
    const prepared = await preparedResponse; assert.equal(prepared.status(), 201);
    assert.equal(prepared.request().postDataJSON().proof, 'by\n  exact Shared.zero n\n');
    const savedTrial: ResearchLibraryTrial = (await prepared.json()).item;
    assert.equal(savedTrial.proof, 'by\n  exact Shared.zero n');
    await page.waitForURL(url => url.searchParams.get('trial') === savedTrial.id);
    await page.waitForFunction(value => document.querySelector<HTMLTextAreaElement>('[data-library-trial] textarea[required]')?.value === value, savedTrial.proof);
    const review = trial.locator('[data-library-trial-review]'); await review.waitFor();
    assert.equal(JSON.parse(await goals.inputValue())[1], project.id, 'The owner’s project link chooses its binding even when a personal target is available');
    assert.equal(compilerCalls.length, initialCalls, 'Preparing a candidate must not call the checker');
    await review.getByText('import Submission.Library.Shared', { exact: false }).waitFor();
    const check = review.getByRole('button', { name: tx('确认并独立检查', 'Confirm and check independently'), exact: true });
    const confirmed = review.getByRole('checkbox'); assert.equal(await check.isDisabled(), true);
    const checkbox = await confirmed.boundingBox(); assert.ok(checkbox && checkbox.width <= 20 && checkbox.height <= 20, 'Review checkbox keeps its compact size');
    await confirmed.check(); assert.equal(await check.isEnabled(), true);
    await argumentsNote.fill('Changed mapping'); await argumentsNote.fill('Library n maps to task n');
    assert.equal(await confirmed.isChecked(), false, 'Editing and reverting a candidate resets its explicit review');
    assert.equal(await check.isDisabled(), true);
    const trialId = new URL(page.url()).searchParams.get('trial'); assert.ok(trialId);
    phase = `recover-prepared-${width}-${language}`; await page.reload(); await review.waitFor();
    assert.equal(await proof.inputValue(), 'by\n  exact Shared.zero n'); assert.equal(await confirmed.isChecked(), false);
    assert.equal(compilerCalls.length, initialCalls);

    let uncertain = true; const attempts: object[] = [];
    await page.route(`**/api/research/library-trials/${trialId}/check`, async route => {
      attempts.push(route.request().postDataJSON()); const response = await route.fetch();
      if (uncertain) { uncertain = false; assert.equal(response.status(), 200);
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture confirmation response lost' }) });
      } else await route.fulfill({ response });
    });
    phase = `uncertain-check-${width}-${language}`; await confirmed.check(); await check.click();
    await review.getByRole('alert').filter({ hasText: 'Fixture confirmation response lost' }).waitFor();
    await check.click(); const receipt = trial.locator('[data-library-trial-receipt]');
    await receipt.getByRole('heading', { name: tx('试用候选通过独立检查', 'Trial candidate passed the independent check'), exact: true }).waitFor();
    assert.equal(compilerCalls.length, initialCalls + 1); assert.deepEqual(attempts[0], attempts[1]);
    await page.unroute(`**/api/research/library-trials/${trialId}/check`);
    phase = `recover-receipt-${width}-${language}`; await page.reload(); await receipt.waitFor();
    const saved = await page.evaluate(async id => {
      const response = await fetch(`/api/research/library-trials/${id}`); return response.json();
    }, trialId) as { item: ResearchLibraryTrial };
    assert.equal(saved.item.check?.receipt.acceptance, 'not-assessed'); assert.equal(saved.item.check?.receipt.checkedDeclaration, 'Research.target');
    assert.equal(saved.item.release.digest, release.digest);

    // A technical failure preserves the exact draft; a retry checks only this candidate.
    phase = `technical-retry-${width}-${language}`; await proof.fill('by\n  simpa using Shared.zero n'); await prepare.click(); await review.waitFor();
    let technical = true;
    compiler = async value => { if (technical) { technical = false; throw new Error('Fixture compiler temporarily unavailable'); }
      return { output: '', exitCode: 0, timedOut: false, checkedTarget: value.candidateTarget?.name }; };
    await confirmed.check(); await check.click();
    await review.getByRole('alert').waitFor(); await check.click(); await receipt.waitFor();
    assert.equal(compilerCalls.length, initialCalls + 3);

    // Reload while the check is in flight, then recover the same receipt through GET.
    phase = `in-flight-recovery-${width}-${language}`; await proof.fill('by\n  exact Shared.zero n -- recover in-flight'); await prepare.click(); await review.waitFor();
    let finish!: (value: WebPrecheckOutput) => void;
    let started!: () => void;
    const checkStarted = new Promise<void>(resolve => { started = resolve; });
    compiler = async () => new Promise(resolve => { finish = resolve; started(); });
    await confirmed.check(); await check.click();
    await checkStarted; await page.reload();
    await trial.getByText(tx('这份候选正在独立检查，完成后会显示回执。', 'This candidate is being checked. The receipt will appear when it completes.'), { exact: true }).waitFor();
    finish({ output: '', exitCode: 0, timedOut: false, checkedTarget: 'Research.target' });
    await receipt.waitFor(); assert.equal(compilerCalls.length, initialCalls + 4);
    compiler = async value => ({ output: '', exitCode: 0, timedOut: false, checkedTarget: value.candidateTarget?.name });

    const layout = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(layout.content <= layout.viewport + 1, `Library trial overflow: ${JSON.stringify(layout)}`);
    await page.screenshot({ path: path.join(output, `trial-receipt-${width}-${language}.png`), fullPage: true });
    assert.equal(JSON.stringify(run), before, 'A Library trial does not change source, tasks, acceptance or run status');
    assert.equal(workerCalls, workersBefore); assert.equal(commandCalls, beforeCommands);

    // Share the private checked trial as a real candidate, get a different human's review, then prepare a new attempt.
    phase = `share-proposal-${width}-${language}`;
    const proposal = trial.locator('[data-library-trial-proposal]'); await proposal.locator(':scope > summary').click();
    const proposalForm = proposal.locator('[data-library-proposal-form]'); await proposalForm.waitFor();
    const explanation = proposalForm.getByRole('textbox', { name: tx('提案说明', 'Proposal explanation'), exact: true });
    const share = proposalForm.locator('[data-library-proposal-share]'), submitProposal = proposalForm.locator('[data-library-proposal-submit]');
    await explanation.fill('Apply the fixed Shared.zero result to the current exact goal.');
    assert.equal(await submitProposal.isDisabled(), true); await share.check();
    await explanation.fill('Changed explanation'); await explanation.fill('Apply the fixed Shared.zero result to the current exact goal.');
    assert.equal(await share.isChecked(), false, 'Editing and reverting the proposal resets sharing consent');
    assert.equal(service.research.projects.detail(owner, project.id).feedback.length, 0);
    await share.check(); const candidateResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/research/theorems/${project.id}/feedback`);
    await submitProposal.click(); const response = await candidateResponse; assert.equal(response.status(), 201);
    const candidate = ((await response.json()) as { item: ResearchFeedback }).item;
    await proposal.locator(`[data-library-proposal-created="${candidate.id}"]`).waitFor();
    assert.equal(candidate.candidateDelivery?.status, 'awaiting-review'); assert.equal(candidate.proofCheck?.status, 'checked');
    assert.equal(compilerCalls.length, initialCalls + 5, 'Submitting the proposal independently rechecks the exact candidate');
    assert.equal(commandCalls, beforeCommands); assert.equal(JSON.stringify(run), before);
    const libraryReturn = page.url();
    await proposal.getByRole('link', { name: tx('打开任务提案', 'Open the task proposal'), exact: true }).click();
    const ownerFeedback = page.locator(`#feedback-${candidate.id}`); await ownerFeedback.locator('[data-candidate-delivery-status="awaiting-review"]').waitFor();

    const peerContext = await browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await preferFullCollaboration(peerContext);
    await peerContext.addInitScript(language => { localStorage.setItem('theorem-os.web-locale.v1', language); }, language);
    await peerContext.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    const peer = await peerContext.newPage(); peer.setDefaultTimeout(12_000); peer.on('pageerror', error => errors.push(error.message));
    await peer.goto(`${origin}/theorems.html`);
    await peer.locator('main[aria-busy="false"]').waitFor();
    const reviewer = (await peerContext.cookies(origin)).find(item => item.name === 'theoremos_session')!.value;
    project = service.research.projects.setMember(owner, project.id, service.research.projects.identity(reviewer), {
      requestId: 'reviewer', expectedRevision: service.research.projects.detail(owner, project.id).revision, role: 'collaborator' });
    phase = `exact-project-target-${width}-${language}`;
    let secondProject = service.research.projects.create(owner, { requestId: 'second-project', title: 'Another addition project', visibility: 'members' });
    secondProject = service.research.projects.addVersion(owner, secondProject.id, { requestId: 'second-statement', expectedRevision: secondProject.revision,
      statement: 'Addition identity', source: original, environment: 'standard' });
    secondProject = service.research.projects.bindRun(owner, secondProject.id, { requestId: 'second-binding', expectedRevision: secondProject.revision,
      runId: run.id, statementVersionId: secondProject.versions[0].id, exposure: 'members', grants: { proof: true } });
    secondProject = service.research.projects.setMember(owner, secondProject.id, service.research.projects.identity(reviewer), {
      requestId: 'second-project-reviewer', expectedRevision: secondProject.revision, role: 'collaborator' });
    for (const exactProject of [project, secondProject]) {
      const params = new URLSearchParams(entry);
      params.set('project', exactProject.id); params.set('entry', release.assetId); params.set('version', release.version);
      await peer.goto(`${origin}/library.html?${params}`);
      const selectedGoal = peer.locator('[data-library-trial] select').first().locator('option:checked').filter({ hasText: exactProject.title });
      await selectedGoal.waitFor({ state: 'attached' });
      assert.deepEqual(JSON.parse((await selectedGoal.getAttribute('value'))!).slice(0, 5), [run.id, exactProject.id, 'target', 'task-v1', commit]);
    }
    phase = `human-review-${width}-${language}`;
    await peer.goto(page.url()); const peerFeedback = peer.locator(`#feedback-${candidate.id}`);
    const frozenEvidence = peerFeedback.locator('[data-library-candidate-evidence]'); await frozenEvidence.locator(':scope > summary').click();
    await frozenEvidence.getByText('Library n maps to task n', { exact: true }).waitFor();
    await frozenEvidence.locator('[data-library-candidate-module="Submission/Library/Shared.lean"] > summary').click();
    await frozenEvidence.getByText('namespace Shared', { exact: false }).waitFor();
    assert.equal(await peer.evaluate(async id => (await fetch(`/api/research/library-trials/${id}`)).status, new URL(libraryReturn).searchParams.get('trial')), 404,
      'A project member reviews the shared snapshot without access to the author’s private trial');
    await peerFeedback.locator('[data-candidate-approve]').click(); await peerFeedback.locator('[data-candidate-delivery-status="approved"]').waitFor();
    assert.equal(commandCalls, beforeCommands, 'Human approval for a new attempt never dispatches to the completed run');
    await page.reload(); await ownerFeedback.locator('[data-prepare-library-attempt]').waitFor();
    const workersAtPreparation = workerCalls;
    await ownerFeedback.locator('[data-prepare-library-attempt]').click();
    await page.locator('[data-library-proposal-origin][data-library-proposal-ready="true"]').waitFor();
    assert.equal(await page.locator('#source').inputValue(), candidate.payload && 'source' in candidate.payload ? candidate.payload.source : '');
    await page.getByText(`Addition math-${width} · v1`, { exact: false }).first().waitFor();
    assert.equal(workerCalls, workersAtPreparation, 'Preparing the reviewed candidate never starts a worker');
    await page.screenshot({ path: path.join(output, `reviewed-new-attempt-${width}-${language}.png`), fullPage: true });
    // Submit the actual composer, preserving the browser's ResearchSelection rather than reconstructing a test-only request.
    phase = `launch-fixed-attempt-${width}-${language}`;
    await page.evaluate(() => {
      const field = document.querySelector<HTMLInputElement>('#api-key')!; field.value = 'sk-DISPOSABLE-REVIEWED-ATTEMPT'; field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const launch = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
    await page.locator('#run-form').evaluate(form => (form as HTMLFormElement).requestSubmit());
    const launched = await launch; assert.ok(launched.ok(), await launched.text());
    const launchedBody = launched.request().postDataJSON() as { researchSelection: { libraries: unknown[] } };
    assert.deepEqual(launchedBody.researchSelection.libraries, [saved.item.release]);
    for (let attempt = 0; attempt < 40 && workerCalls === workersAtPreparation; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(workerCalls, workersAtPreparation + 1);
    const launchedInput = workerInputs.at(-1)!;
    assert.equal(launchedInput.input.source, candidate.payload && 'source' in candidate.payload ? candidate.payload.source.trim() : '');
    assert.ok(launchedInput.researchConfiguration?.libraryPack?.modules.some(module => module.file === 'Submission/Library/Shared.lean'));
    assert.equal(JSON.stringify(run), before); await peerContext.close();
    await page.goto(libraryReturn); await receipt.waitFor();

    const beforeDiagnostics = compilerCalls.length;
    phase = `diagnostics-${width}-${language}`; await proof.fill('by\n  exact Shared.zero (n + 1)'); await prepare.click(); await review.waitFor();
    compiler = async () => ({ output: JSON.stringify({ severity: 'error', pos: { line: 5, column: 2 }, data: 'Fixture argument type mismatch' }), exitCode: 1, timedOut: false });
    await confirmed.check(); await check.click();
    await receipt.getByRole('heading', { name: tx('试用候选未通过检查', 'Trial candidate did not pass'), exact: true }).waitFor();
    await receipt.getByText(/Fixture argument type mismatch/u).first().waitFor();
    await page.screenshot({ path: path.join(output, `trial-diagnostics-${width}-${language}.png`), fullPage: true });
    assert.equal(JSON.stringify(run), before);

    // Same task contract, newer exact source: stale prepare is rejected rather than silently retargeted.
    const next = structuredClone(run.observation!); next.sequence++; next.sources[0].commit = 'b'.repeat(40);
    run.observation = next; service.storage.saveRun(owner, run);
    await proof.fill('by\n  exact Shared.zero n -- stale source'); await prepare.click();
    await trial.getByRole('alert').filter({ hasText: tx('任务版本或源码提交已经改变', 'The task version or source commit has changed') }).waitFor();
    assert.equal(compilerCalls.length, beforeDiagnostics + 1);
    checks.push({ width, language, layout, trialId, confirmedCompileCalls: 5, uncertainAttempts: attempts.length,
      preparedDoesNotCheck: true, trimmedProofReviewable: true, exactProjectTarget: true, draftAndReceiptRecovered: true, runUnchanged: true, staleSourceRejected: true,
      checkedExampleLoadedWithoutCompiler: true, explicitSharing: true, separateHumanApproval: true, reviewedNewAttemptPrepared: true, actualComposerLaunchIncludesFixedPack: true });
    compiler = async value => ({ output: '', exitCode: 0, timedOut: false, checkedTarget: value.candidateTarget?.name });
    await context.close(); active = undefined;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(commandCalls, 0); assert.equal(mailCalls, 0);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', fixtureOnly: true, checks,
    compilerCalls: compilerCalls.length, workerCalls, commandCalls, mailCalls, errors, external }, null, 2));
  console.log(JSON.stringify({ status: 'passed', output, checks: checks.length, compilerCalls: compilerCalls.length, commandCalls, mailCalls }));
} catch (error) {
  await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  const failureState = await active?.evaluate(() => ({ url: location.href,
    selects: [...document.querySelectorAll('[data-library-trial] select')].map(select => ({ value: (select as HTMLSelectElement).value, html: select.outerHTML })),
    alerts: [...document.querySelectorAll('[role="alert"]')].map(item => item.textContent) })).catch(() => undefined);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', phase, error: String(error), failureState, checks, errors, external }, null, 2));
  throw error;
} finally {
  await browser.close(); await fixtures.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
