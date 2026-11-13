#!/usr/bin/env bun
// Disposable HTTP/Chromium fixtures only. No models, Lean processes or mail are invoked.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { WebResearchLibraryTrials } from '../apps/web/researchLibraryTrials';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { researchMathExampleValidator } from '../apps/web/researchMathExamples';
import type { WebRunner } from '../apps/web/runner';
import type { WebPrecheckOutput, WebPrecheckRunner } from '../apps/web/precheck';
import { loadWebSample } from '../apps/web/sample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { closeSettings } from './web-ui-controls';
import { freePort, preferFullCollaboration, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/continuity-seven/recovery-library');
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
const trials = new WebResearchLibraryTrials({ storage: service.storage, jobs: service.jobs, projects: service.research.projects, assets: fixtures, runner });
const browser = await startBrowser(service.server, port), errors: string[] = [], external: string[] = [], checks: object[] = [];
const configurationReads: { status: number; request: unknown }[] = [];
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
const classic = JSON.parse(await fs.readFile(path.join(root, 'out/web/classics/data/index.json'), 'utf8')).records[0];
try {
  for (const [width, language] of [[1440, 'zh'], [390, 'en']] as const) {
    const context = await browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await preferFullCollaboration(context); await context.addInitScript(language => localStorage.setItem('theorem-os.web-locale.v1', language), language);
    await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(12_000); page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/research/configuration')
        configurationReads.push({ status: response.status(), request: response.request().postDataJSON() });
    });
    phase = `fixture-${language}`; await page.goto(`${origin}/library.html`); await page.locator('main[aria-busy="false"]').waitFor();
    const owner = (await context.cookies(origin)).find(item => item.name === 'theoremos_session')!.value;
    const run = service.jobs.create(owner, { providerId: 'openai', apiKey: 'sk-disposable-not-sent', model: 'fixture-no-model', effort: 'high', environment: 'standard', source: original, task: 'Library undo control', maxTurns: 1, maxRunSeconds: 30, workers: 1, coordination: 'independent' }, { id: 'openai', name: 'Fixture', baseUrl: 'http://127.0.0.1/never-called' });
    for (let attempt = 0; attempt < 40 && run.status !== 'completed'; attempt++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(run.status, 'completed'); const release = await publish(owner, `undo-${width}`);
    const target = trials.targets(owner, release.assetId, release.version).find(item => item.ref.runId === run.id)!; assert.ok(target);
    const prepared = trials.prepare(owner, release.assetId, release.version, { requestId: 'prepared', releaseDigest: release.digest, target: target.ref, declaration: 'Shared.zero', proof: 'by\n  exact Shared.zero n', argumentNotes: 'n maps to n', missingPremises: '' });
    const passed = await trials.check(owner, prepared.id, { requestId: 'check', expectedDigest: prepared.digest, confirmed: true }); assert.equal(passed.status, 'passed');
    const prepareAddress = `${origin}/?libraryTrial=${passed.id}&trialDigest=${passed.digest}`;
    const submit = async () => {
      await page.evaluate(() => { const field = document.querySelector<HTMLInputElement>('#api-key')!; field.value = 'sk-disposable-not-sent'; field.dispatchEvent(new Event('input', { bubbles: true })); });
      const pending = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
      await page.locator('#run-form').evaluate(form => (form as HTMLFormElement).requestSubmit()); const response = await pending; assert.equal(response.status(), 201, await response.text());
      const request = response.request().postDataJSON(); delete request.apiKey;
      const created = (await response.json()).run;
      for (let attempt = 0; attempt < 40 && service.jobs.get(owner, created.id)?.status !== 'completed'; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
      return { request, run: service.jobs.get(owner, created.id)! };
    };
    phase = `normal-library-reload-and-submit-${language}`; await page.goto(prepareAddress); await page.locator('[data-library-trial-ready=true]').waitFor();
    await page.reload(); await page.waitForFunction(source => (document.querySelector('#source') as HTMLTextAreaElement)?.value === source, passed.source);
    await page.getByText(`Addition undo-${width} · v1`, { exact: false }).first().waitFor();
    const normal = await submit(); assert.deepEqual(normal.request.researchSelection.libraries, [passed.release]); assert.ok(normal.run.researchConfiguration?.libraryPack?.modules.some(item => item.file === 'Submission/Library/Shared.lean'));
    phase = `library-before-classic-${language}`; await page.goto(prepareAddress); await page.locator('[data-library-trial-ready=true]').waitFor();
    assert.equal(await page.locator('#source').inputValue(), passed.source); await closeSettings(page);
    await page.screenshot({ path: path.join(output, `undo-fixed-library-before-${language}.png`), fullPage: true });
    const beforeStorage = await page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).filter(key => key === 'theoremos.research.selection').map(key => [key, sessionStorage.getItem(key)])));
    phase = `classic-replace-${language}`; await page.goto(`${origin}/?fromClassic=${classic.id}&lang=${language}`); await page.locator('[data-classic-preview] > summary').click(); await page.locator('[data-classic-confirm]').click(); await page.locator('[data-classic-ready=true]').waitFor(); await closeSettings(page);
    const originalClassic = await page.locator('#source').inputValue();
    const releaseEndpoint = `**/api/research/library/${release.assetId}/releases/${release.version}`;
    phase = `dependency-read-failure-${language}`;
    await page.route(releaseEndpoint, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary fixture read failure' }) }));
    const failedRead = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/library/${release.assetId}/releases/${release.version}`) && response.status() === 503);
    await page.locator('#restore-draft').click(); await failedRead; await page.locator('#restore-draft:enabled').waitFor();
    assert.equal(await page.locator('#source').inputValue(), originalClassic, 'Failed dependency reads preserve the current draft');
    assert.ok(await page.evaluate(() => sessionStorage.getItem('theorem-os.web-draft-recovery.v1')));
    await page.unroute(releaseEndpoint);
    phase = `dependency-read-with-newer-edits-${language}`;
    let releaseRead!: () => void, sawRead!: () => void;
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    const requested = new Promise<void>(resolve => { sawRead = resolve; });
    await page.route(releaseEndpoint, async route => { const response = await route.fetch(); sawRead(); await gate; await route.fulfill({ response }); });
    await page.locator('#restore-draft').click(); await requested;
    const newerDraft = originalClassic + '\n-- Preserve edits while checking fixed dependencies\n';
    await page.locator('#source').fill(newerDraft); releaseRead(); await page.locator('#restore-draft:enabled').waitFor();
    assert.equal(await page.locator('#source').inputValue(), newerDraft, 'A completed read cannot overwrite newer edits');
    assert.ok(await page.evaluate(() => sessionStorage.getItem('theorem-os.web-draft-recovery.v1')));
    await page.unroute(releaseEndpoint);
    phase = `classic-undo-library-${language}`; await page.locator('#restore-draft').click();
    await page.waitForFunction(source => (document.querySelector('#source') as HTMLTextAreaElement)?.value === source, passed.source);
    const afterUndo = { source: await page.locator('#source').inputValue(), task: await page.locator('#task').inputValue(), selectedReleaseVisible: (await page.locator('#run-form').innerText()).includes(`Addition undo-${width}`), storage: await page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).filter(key => key === 'theoremos.research.selection').map(key => [key, sessionStorage.getItem(key)]))) };
    await page.screenshot({ path: path.join(output, `undo-fixed-library-after-${language}.png`), fullPage: true });
    phase = `undo-actual-submit-${language}`; const undone = await submit();
    assert.equal(undone.request.source, normal.request.source); assert.deepEqual(undone.request.researchSelection, normal.request.researchSelection); assert.equal(undone.run.researchConfiguration?.libraryPack?.modules.some(item => item.file === 'Submission/Library/Shared.lean') ?? false, true);
    checks.push({ id: 'REC1-undo-restores-fixed-library', language, width, classicId: classic.id, fixedRelease: passed.release, beforeStorage, normalRequest: normal.request, normalRunHasFixedPack: true, afterUndo, undoRequest: undone.request, undoRunHasFixedPack: true, restoredSourceStillImportsFixedLibrary: afterUndo.source.includes('import Submission.Library.Shared'), normalRunId: normal.run.id, undoRunId: undone.run.id, failedReadPreservesBothDrafts: true, newerEditsPreservedDuringRead: true });
    await context.close(); active = undefined;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(commandCalls, 0); assert.equal(mailCalls, 0);
  await fs.writeFile(path.join(output, 'undo-report.json'), JSON.stringify({ status: 'passed', build: JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8')), checks, recordedChecks: compilerCalls.length, recordedWorkers: workerCalls, realModelCalls: 0, realLeanCalls: 0, commandCalls, mailCalls, errors, external }, null, 2)); console.log(JSON.stringify({ status: 'passed', checks: checks.length }));
} catch (error) {
  await active?.screenshot({ path: path.join(output, 'undo-probe-failure.png'), fullPage: true }).catch(() => undefined);
  const diagnostics = await active?.evaluate(() => ({
    source: document.querySelector<HTMLTextAreaElement>('#source')?.value.slice(-2048),
    environment: document.querySelector<HTMLSelectElement>('#environment')?.value,
    notices: ['#toast', '#form-error', '#draft-recovery-text'].map(selector => ({ selector, text: document.querySelector(selector)?.textContent?.slice(0, 1000) })),
    selection: document.querySelector('.composer-research-selection')?.textContent?.slice(0, 1000),
    recovery: Object.fromEntries(Object.keys(sessionStorage).filter(key => key.includes('draft-recovery') || key.includes('research.selection')).slice(0, 8)
      .map(key => [key, sessionStorage.getItem(key)?.slice(0, 24000)])),
  })).catch(() => undefined);
  await fs.writeFile(path.join(output, 'undo-report.json'), JSON.stringify({ status: 'probe-failed', phase, error: String(error), checks, errors, external,
    diagnostics, configurationReads: configurationReads.slice(-8) }, null, 2)); throw error;
} finally { await browser.close(); await trials.close(); await fixtures.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
