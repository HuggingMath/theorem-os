#!/usr/bin/env bun
// Disposable loopback service and recorded runner only. No real models, Lean, mail or production accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebResearchLibraryTrials } from '../apps/web/researchLibraryTrials';
import { WebResearchBudgets } from '../apps/web/researchBudgets';
import { loadWebSample } from '../apps/web/sample';
import type { WebRunner } from '../apps/web/runner';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { freePort, preferFullCollaboration, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/library-personal');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.access(path.join(staticRoot, 'research.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-library-personal-')), port = await freePort(), origin = `http://127.0.0.1:${port}`;
const original = 'theorem preserved : 1 = 1 := by rfl\nnamespace Research\ntheorem target (n : Nat) : n + 0 = n := by sorry\nend Research';
const commit = 'a'.repeat(40), environmentDigest = getLeanTaskEnvironment('standard').dependencyDigest;
let workers = 0, compilerCalls = 0, prohibited = 0, pass = true;
const inputs: Parameters<WebRunner['run']>[0][] = [];
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Disposable continuity fixture' }; },
  async run(input, send) {
    workers++; inputs.push(structuredClone(input));
    const observation = structuredClone(loadWebSample()!.observations.at(-1)!); observation.webRunId = input.id; observation.sequence = 1;
    observation.inspection.configuration.environmentDigest = environmentDigest;
    observation.inspection.tasks = [{ id: 'target', kind: 'goal', objective: 'Prove addition', theorem: 'Research.target', type: '(n : Nat) : n + 0 = n',
      group: 'main', status: 'working', control: 'active', version: 'task-v1', premises: ['n : Nat'], plannedDependencies: [], attempts: 1, proof: { status: 'open' }, parkedBy: [], parkedRoutes: {} }];
    observation.plan = { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [{ id: 'target', kind: 'goal', objective: 'Prove addition', dependsOn: [],
      revision: 1, proofPath: 'Main.lean', theoremName: 'Research.target' }] };
    observation.sources = [{ taskId: 'target', taskVersion: 'task-v1', commit, sourceDigest: mathDigest(input.input.source), environmentDigest,
      file: 'Main.lean', source: input.input.source, scope: 'owned-file' }];
    observation.inspection.problem.targets = [{ theoremName: 'Research.target', proofPath: 'Main.lean' }];
    send({ type: 'observation', observation }); send({ type: 'result', result: { status: 'incomplete', proof: input.input.source,
      report: { fixture: true, acceptance: 'not-assessed', usage: { totalTokens: 1200 } } } });
  },
  async check(input) { compilerCalls++; return { output: '', exitCode: pass ? 0 : 1, timedOut: false, checkedTarget: input.candidateTarget?.name }; },
  async command() { prohibited++; throw new Error('No runtime commands in this fixture'); },
  async formalize() { prohibited++; throw new Error('No models in this fixture'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner, { sample: null,
  mailer: async () => { prohibited++; throw new Error('No mail in this fixture'); } });
const assets = new WebResearchAssets(service.storage, { identity: owner => service.research.projects.identity(owner),
  async resolveMathematics() { return { environment: 'standard', environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest,
    declarations: [{ name: 'Shared.zero', type: '(n : Nat) : n + 0 = n', file: 'Submission/Library/Shared.lean' }],
    pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'Submission/Library/Shared.lean',
      source: 'namespace Shared\ntheorem zero (n : Nat) : n + 0 = n := by simp\nend Shared\n', origin: { kind: 'run', runId: 'fixed-browser-library', commit, file: 'Main.lean' } }] } }; },
  async validateMathematics() { return { passed: true, receiptRefs: ['controlled-publication-receipt'] }; } });
const trials = new WebResearchLibraryTrials({ storage: service.storage, jobs: service.jobs, projects: service.research.projects, assets, runner });
const budgets = new WebResearchBudgets(service.storage, service.research.problems, service.research.workspace);
const browser = await startBrowser(service.server, port), errors: string[] = [], external: string[] = [], checks: object[] = [];
let phase = 'setup', active: Page | undefined;
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', locale: language === 'zh' ? 'zh-CN' : 'en-US' });
    await preferFullCollaboration(context); await context.addInitScript(language => localStorage.setItem('theorem-os.web-locale.v1', language), language);
    await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/workspace.html?tab=usage`); await page.locator('[data-workspace-page]').waitFor();
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const session = await page.evaluate(async () => (await fetch('/api/session')).json()), provider = session.providers[0];
    const runs = [original, `${original}\n-- another attempt`].map((source, index) => service.jobs.create(owner,
      { providerId: provider.id, apiKey: 'sk-disposable-not-sent', model: 'controlled-model', effort: 'high', environment: 'standard', source,
        task: `Personal addition attempt ${index + 1}`, maxTurns: 1, maxRunSeconds: 60, workers: 1, coordination: 'independent' }, provider));
    await page.waitForFunction(async () => { const { runs } = await (await fetch('/api/runs')).json(); return runs.length === 2 && runs.every((run: { status: string }) => run.status === 'completed'); });
    const [first, second] = runs, before = JSON.stringify(first), workerStart = workers;
    const firstBudget = budgets.save(owner, first!.id, undefined, { requestId: 'first-budget', expectedRevision: 0, currency: 'USD', tokenLimit: 500000, amountLimit: 20 });
    budgets.save(owner, second!.id, undefined, { requestId: 'second-budget', expectedRevision: 0, currency: 'USD', tokenLimit: 900000, amountLimit: 50 });
    let project = service.research.projects.create(owner, { requestId: 'project', title: 'Continuity project', visibility: 'members' });
    const attach = (run: typeof first) => {
      project = service.research.projects.addVersion(owner, project.id, { requestId: `version-${run!.id}`, expectedRevision: project.revision,
        statement: 'Addition identity', source: run!.source, environment: 'standard' });
      project = service.research.projects.bindRun(owner, project.id, { requestId: `bind-${run!.id}`, expectedRevision: project.revision, runId: run!.id,
        statementVersionId: project.versions.at(-1)!.id });
    };
    phase = `single-budget-inheritance-${language}`; attach(first);
    await page.goto(`${origin}/problem.html?run=${first!.id}&project=${project.id}&tab=outcomes`); await page.locator('[data-budget-inherited]').waitFor();
    assert.equal(budgets.view(owner, first!.id, project.id).plan.amountLimit, 20); assert.equal(budgets.view(owner, first!.id, project.id).plan.currency, 'USD');
    phase = `conflicting-budget-resolution-${language}`; attach(second); await page.reload();
    const conflict = page.locator('[data-budget-continuity]'); await conflict.waitFor();
    const requests: object[] = []; let lose = true;
    await page.route('**/budget/inherit?*', async route => {
      requests.push(route.request().postDataJSON()); const response = await route.fetch();
      if (lose) { lose = false; await route.fulfill({ status: 503, json: { error: 'Fixture budget response lost' } }); } else await route.fulfill({ response });
    });
    const select = conflict.locator(`[data-inherit-budget="${firstBudget.plan.key}"]`); await select.click();
    await conflict.getByRole('alert').filter({ hasText: 'Fixture budget response lost' }).waitFor(); await select.click();
    await conflict.waitFor({ state: 'detached' }); assert.deepEqual(requests[0], requests[1]); assert.equal(budgets.view(owner, first!.id, project.id).plan.amountLimit, 20);
    await page.unroute('**/budget/inherit?*'); checks.push({ language, width, singleInheritance: true, conflictReviewed: true, uncertainResponseDeduplicated: true });

    phase = `trial-history-directory-${language}`;
    const asset = assets.create(owner, { requestId: `library-${language}`, type: 'mathematics', name: 'Fixed addition library', content: { source: { kind: 'run', runId: 'fixed-browser-library', commit } } });
    const preview = await assets.preview(owner, asset.id), publication = await assets.publish(owner, asset.id, { requestId: 'publish', expectedRevision: asset.revision,
      previewDigest: preview.previewDigest, version: 'v1', license: 'MIT', visibility: 'public' });
    assert.equal((await assets.waitForPublication(owner, publication.id)).status, 'completed');
    const release = assets.release(owner, asset.id, 'v1'), target = trials.targets(owner, asset.id, 'v1').find(item => item.ref.runId === first!.id)!;
    const prepare = (id: string) => trials.prepare(owner, asset.id, 'v1', { requestId: id, releaseDigest: release.digest, target: target.ref,
      declaration: 'Shared.zero', proof: 'by\n  exact Shared.zero n', argumentNotes: 'Use the same natural number n.', missingPremises: '' });
    prepare('prepared'); const passed = prepare('passed'); await trials.check(owner, passed.id, { requestId: 'check-passed', expectedDigest: passed.digest, confirmed: true });
    const failed = prepare('failed'); pass = false; await trials.check(owner, failed.id, { requestId: 'check-failed', expectedDigest: failed.digest, confirmed: true }); pass = true;
    await page.goto(`${origin}/workspace.html?tab=trials&asset=${asset.id}`); await page.locator('[data-trial-history-item]').first().waitFor();
    assert.equal(await page.locator('[data-trial-history-item]').count(), 3);
    await page.locator('[data-trial-history-filter]').selectOption('passed'); await page.waitForFunction(() => document.querySelectorAll('[data-trial-history-item]').length === 1);
    await page.locator(`[data-trial-history-item="${passed.id}"] [data-open-trial-history]`).click();
    const reader = page.locator(`[data-trial-history-reader="${passed.id}"]`); await reader.locator('[data-trial-frozen-receipt]').waitFor();
    assert.match(await reader.locator('[data-trial-frozen-source]').innerText(), /exact Shared.zero n/);
    assert.match(await reader.locator('[data-trial-frozen-receipt]').innerText(), /not-assessed/);
    await page.reload(); await reader.locator('[data-trial-frozen-receipt]').waitFor(); const compiledBeforeReading = compilerCalls;
    await page.screenshot({ path: path.join(output, `trial-history-${language}.png`), fullPage: true });

    phase = `personal-trial-prepare-and-confirmed-launch-${language}`;
    await reader.locator('[data-prepare-personal-trial]').click();
    await page.waitForFunction(expected => (document.querySelector('#source') as HTMLTextAreaElement)?.value === expected, passed.source);
    assert.equal(workers, workerStart); assert.equal(compilerCalls, compiledBeforeReading); assert.equal(await page.locator('#api-key').inputValue(), '');
    await page.reload(); await page.waitForFunction(expected => (document.querySelector('#source') as HTMLTextAreaElement)?.value === expected, passed.source);
    assert.equal(workers, workerStart);
    await page.screenshot({ path: path.join(output, `prepared-personal-${language}.png`), fullPage: true });
    await page.evaluate(() => { const key = document.querySelector<HTMLInputElement>('#api-key')!; key.value = 'sk-disposable-personal-attempt'; key.dispatchEvent(new Event('input', { bubbles: true })); });
    const launch = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
    await page.locator('#run-form').evaluate(form => (form as HTMLFormElement).requestSubmit()); const launched = await launch; assert.ok(launched.ok(), await launched.text());
    assert.deepEqual(launched.request().postDataJSON().researchSelection.libraries, [release && { assetId: release.assetId, version: release.version, digest: release.digest }]);
    for (let attempt = 0; attempt < 40 && workers === workerStart; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(workers, workerStart + 1); assert.equal(inputs.at(-1)!.input.source, passed.source.trim());
    assert.ok(inputs.at(-1)!.researchConfiguration?.libraryPack?.modules.some(module => module.file === 'Submission/Library/Shared.lean'));
    assert.equal(JSON.stringify(first), before);
    checks.push({ language, width, privateTrialDirectory: true, filters: true, frozenReceiptReloaded: true, preparedWithoutExecution: true, confirmedLaunchIncludesFixedLibrary: true });

    phase = `outdated-trial-remains-readable-${language}`;
    const next = structuredClone(first!.observation!); next.sequence++; next.inspection.tasks[0].version = 'task-v2'; next.sources[0].taskVersion = 'task-v2'; next.sources[0].commit = 'b'.repeat(40);
    first!.observation = next; service.storage.saveRun(owner, first!);
    await page.goto(`${origin}/workspace.html?tab=trials&trial=${passed.id}`); await reader.locator('[data-trial-historical]').waitFor();
    await reader.locator('[data-trial-frozen-receipt]').waitFor(); assert.equal(await reader.locator('[data-prepare-personal-trial]').count(), 0);
    assert.match(await reader.locator('[data-trial-frozen-receipt]').innerText(), /task-v1/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const reprepare = reader.locator('[data-reprepare-trial]'), currentTarget = new URL((await reprepare.getAttribute('href'))!, origin);
    assert.equal(currentTarget.searchParams.get('task'), 'target'); assert.equal(currentTarget.searchParams.get('taskVersion'), null); assert.equal(currentTarget.searchParams.get('commit'), null);
    await reprepare.click(); const currentForm = page.locator('[data-library-trial]');
    await currentForm.locator('select').first().locator('option:checked').filter({ hasText: 'task-v2' }).waitFor({ state: 'attached' });
    assert.equal(await currentForm.locator('textarea[required]').inputValue(), '');
    checks.push({ language, width, oldSourceAndReceiptReadable: true, stalePreparationBlocked: true, explicitReprepareSelectsSameTaskCurrentVersion: true });
    await context.close(); active = undefined;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', fixtureOnly: true, checks, workers, compilerCalls, prohibited, errors, external }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }));
} catch (cause) {
  await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', phase, error: String(cause), url: active?.url(), checks, errors, external, prohibited }, null, 2)); throw cause;
} finally { await browser.close(); await trials.close(); await assets.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
