#!/usr/bin/env bun
// Library compatibility and dependency navigation regressions. Disposable localhost fixtures; no real model, Lean or mail.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { WebResearchAssets } from '../apps/web/researchAssets';
import type { WebRunner } from '../apps/web/runner';
import { loadWebSample } from '../apps/web/sample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { freePort, preferFullCollaboration, settled, startBrowser } from '../scripts/web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/post-state-20261111/library');
await fs.mkdir(output, { recursive: true });
const build = JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8'));
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-library-post-state-audit-'));
const source = 'namespace Research\ntheorem target (n : Nat) : n + 0 = n := by sorry\nend Research';
const commit = 'a'.repeat(40), runtimeEnvironment = mathDigest('disposable-recorded-library-runtime');
const errors: string[] = [], external: string[] = [], checks: object[] = [];
let recordedRuns = 0, prohibited = 0, browserStarts = 0, phase = 'setup', active: Page | undefined;
const forbidden = async () => { prohibited++; throw new Error('The audit must not call a real runtime or mailer'); };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Recorded audit fixture' }; },
  async run(input, send) {
    recordedRuns++;
    const observation = structuredClone(loadWebSample()!.observations.at(-1)!);
    observation.webRunId = input.id; observation.sequence = 1;
    observation.inspection.configuration.environmentDigest = runtimeEnvironment;
    observation.inspection.tasks = [{ id: 'target', kind: 'goal', objective: input.input.task,
      theorem: 'Research.target', type: '(n : Nat) : n + 0 = n', group: 'main', status: 'working', control: 'active',
      version: 'task-v1', premises: ['n : Nat'], plannedDependencies: [], attempts: 1,
      proof: { status: 'open' }, parkedBy: [], parkedRoutes: {} }];
    observation.plan = { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [{ id: 'target', kind: 'goal',
      objective: input.input.task, dependsOn: [], revision: 1, proofPath: 'Main.lean', theoremName: 'Research.target' }] };
    observation.sources = [{ taskId: 'target', taskVersion: 'task-v1', commit, sourceDigest: mathDigest(source),
      environmentDigest: runtimeEnvironment, file: 'Main.lean', source, scope: 'owned-file' }];
    observation.inspection.problem.targets = [{ theoremName: 'Research.target', proofPath: 'Main.lean' }];
    send({ type: 'observation', observation });
    send({ type: 'result', result: { status: 'incomplete', proof: source, report: { fixture: true, acceptance: 'not-assessed' } } });
  }, check: forbidden, command: forbidden, formalize: forbidden,
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner,
  { sample: null, mailer: forbidden });
const fixtures = new WebResearchAssets(service.storage, { identity: owner => service.research.projects.identity(owner),
  async resolveMathematics(_owner, ref) {
    const environment = ref.kind === 'run' && ref.runId.includes('mathlib') ? 'mathlib' : 'standard';
    return { environment, environmentDigest: getLeanTaskEnvironment(environment).dependencyDigest,
      declarations: [{ name: 'Shared.zero', type: '(n : Nat) : n + 0 = n', file: 'Submission/Library/Shared.lean' }],
      pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'Submission/Library/Shared.lean',
        source: 'namespace Shared\ntheorem zero (n : Nat) : n + 0 = n := by simp\nend Shared\n',
        origin: { kind: 'run', runId: 'recorded-library-publication', commit, file: 'Main.lean' } }] } };
  }, async validateMathematics() { return { passed: true, receiptRefs: ['recorded-audit-publication'] }; },
});
const browser = await startBrowser(service.server, port);
async function publish(owner: string, id: string, version = 'v1') {
  const asset = fixtures.get(owner, id), preview = await fixtures.preview(owner, id);
  const queued = await fixtures.publish(owner, id, { requestId: `publish-${id}-${version}`, expectedRevision: asset.revision,
    previewDigest: preview.previewDigest, version, license: 'MIT', visibility: 'public' });
  const completed = await fixtures.waitForPublication(owner, queued.id);
  assert.equal(completed.status, 'completed', completed.reason); return fixtures.release(owner, id, version);
}
async function run(owner: string, title: string) {
  const record = service.jobs.create(owner, { providerId: 'openai', apiKey: 'disposable-recorded-not-sent', model: 'fixture', effort: 'high', environment: 'standard',
    source, task: title, maxTurns: 1, maxRunSeconds: 30, workers: 1, coordination: 'independent' },
    { id: 'openai', name: 'Recorded fixture', baseUrl: 'http://127.0.0.1/never-called' });
  for (let attempt = 0; attempt < 30 && record.status !== 'completed'; attempt++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(record.status, 'completed'); return record;
}
async function snapshot(page: Page, name: string) {
  await settled(page);
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  await page.screenshot({ path: path.join(output, `${name}-viewport.png`), fullPage: false });
}
async function state(page: Page) {
  return page.evaluate(() => ({ url: location.href, body: document.body.innerText,
    target: (document.querySelector('[data-library-trial] select') as HTMLSelectElement)?.value,
    viewport: innerWidth, contentWidth: document.documentElement.scrollWidth }));
}
try {
  for (const [width, language] of [[1440, 'zh'], [390, 'en']] as const) {
    const tx = (zh: string, en: string) => language === 'zh' ? zh : en;
    const context = await browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await preferFullCollaboration(context);
    await context.addInitScript(value => { try { localStorage.setItem('theorem-os.web-locale.v1', value); } catch {} }, language);
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    context.on('page', page => { page.setDefaultTimeout(10_000); page.on('pageerror', error => errors.push(error.message)); });
    context.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === 'POST' && pathname === '/api/runs') browserStarts++;
    });
    const page = await context.newPage(); active = page;
    await page.goto(`${origin}/library.html?lang=${language}`);
    await page.getByRole('heading', { name: tx('数学库', 'Library'), exact: true }).waitFor();
    const owner = (await context.cookies(origin)).find(item => item.name === 'theoremos_session')!.value;
    const author = `disposable-public-author-${language}`;
    const original = await run(owner, `Original addition problem ${language}`), decoy = await run(owner, `Newer unrelated problem ${language}`);
    const originalBefore = JSON.stringify(original), decoyBefore = JSON.stringify(decoy);
    const math = fixtures.create(author, { requestId: `math-control-${language}`, type: 'mathematics', name: `Stable addition ${language}`,
      description: 'An addition identity for natural numbers.', area: 'algebra',
      content: { source: { kind: 'run', runId: 'standard-publication', commit }, usage: { conditions: 'For natural numbers.', result: 'Establish n + 0 = n.', examples: [] } } });
    await publish(author, math.id);
    const migrated = fixtures.create(author, { requestId: `math-migrated-${language}`, type: 'mathematics', name: `Migrated addition ${language}`,
      description: 'An addition identity with two environment releases.', area: 'algebra', content: { source: { kind: 'run', runId: 'standard-publication', commit } } });
    const oldRelease = await publish(author, migrated.id);
    const current = fixtures.get(author, migrated.id);
    fixtures.update(author, migrated.id, { requestId: `change-environment-${language}`, expectedRevision: current.revision,
      content: { source: { kind: 'run', runId: 'mathlib-publication', commit } } });
    const newerRelease = await publish(author, migrated.id, 'v2');
    fixtures.update(author, migrated.id, { requestId: `private-environment-${language}`,
      expectedRevision: fixtures.get(author, migrated.id).revision, content: { source: { kind: 'run', runId: 'standard-private-publication', commit } } });
    const privatePublication = await fixtures.publish(author, migrated.id, { requestId: `private-${language}`,
      expectedRevision: fixtures.get(author, migrated.id).revision, previewDigest: (await fixtures.preview(author, migrated.id)).previewDigest,
      version: 'v3-private', license: 'MIT', visibility: 'private' });
    assert.equal((await fixtures.waitForPublication(author, privatePublication.id)).status, 'completed');
    const agent = fixtures.create(author, { requestId: `agent-${language}`, type: 'agent', name: `Addition agent ${language}`,
      description: 'An explicit mathematics dependency.', content: { environment: 'standard', modulePlan: { scheduler: 'plan', context: 'full', custom: [] },
      skills: [], libraries: [{ assetId: math.id, version: 'v1' }] } });
    await publish(author, agent.id);
    const target = new URLSearchParams({ run: original.id, task: 'target', taskVersion: 'task-v1', commit, lang: language });

    phase = `environment-discovery-${language}`;
    await page.goto(`${origin}/library.html?${target}`);
    await page.locator('[data-library-discovery]').waitFor();
    await page.locator(`[data-library-match="${math.id}"]`).waitFor();
    await page.locator(`[data-library-match="${migrated.id}"]`).waitFor();
    const compatibleControl = await page.locator(`[data-library-match="${math.id}"]`).count();
    const recommendation = page.locator('.research-directory-card').filter({ hasText: migrated.name });
    await recommendation.locator('[data-library-recommended-release="v1"]').waitFor();
    const recommendationHref = await recommendation.locator('.research-card-heading').getAttribute('href');
    assert.equal(new URL(recommendationHref!, origin).searchParams.get('version'), 'v1');
    assert.equal(compatibleControl, 1);
    await snapshot(page, `compatible-history-recommended-${language}`);
    await page.locator('.research-directory-grid').screenshot({ path: path.join(output, `compatible-history-recommended-${language}-detail.png`) });
    await recommendation.locator('.research-card-heading').click();
    await page.getByRole('heading', { name: migrated.name, exact: true }).waitFor();
    const releaseSelect = page.getByRole('combobox', { name: tx('查看固定版本', 'View a fixed version'), exact: true });
    assert.equal(await releaseSelect.inputValue(), 'v1');
    assert.equal(await releaseSelect.locator('option[value="v3-private"]').count(), 0);
    const trialSelect = page.locator('[data-library-trial]').getByRole('combobox', { name: tx('研究 / 精确任务版本', 'Research / exact task version'), exact: true });
    await trialSelect.waitFor();
    await page.waitForFunction(runId => (document.querySelector('[data-library-trial] select') as HTMLSelectElement)?.value.includes(runId), original.id);
    const recommendedDetail = await state(page);
    assert.ok(recommendedDetail.target?.includes(original.id));
    await snapshot(page, `recommended-release-exact-target-${language}`);
    await trialSelect.selectOption(recommendedDetail.target!);
    await page.locator('.research-breadcrumb a').click();
    await page.locator('[data-library-environment]').selectOption('');
    const allEnvironments = page.locator('.research-directory-card').filter({ hasText: migrated.name }).locator('.research-card-heading');
    await page.waitForFunction(id => {
      const item = [...document.querySelectorAll<HTMLAnchorElement>('.research-directory-card .research-card-heading')].find(item => item.href.includes(id));
      return item && new URL(item.href).searchParams.get('version') === 'v2';
    }, migrated.id);
    assert.equal(new URL((await allEnvironments.getAttribute('href'))!, origin).searchParams.get('version'), 'v2');
    await page.locator('[data-library-environment]').selectOption('target');
    await page.locator('.research-directory-card').filter({ hasText: migrated.name }).locator('[data-library-recommended-release="v1"]').waitFor();
    const currentMigrated = fixtures.get(author, migrated.id);
    fixtures.withdraw(author, migrated.id, { requestId: `withdraw-old-${language}`, expectedRevision: currentMigrated.revision, version: 'v1' });
    await page.reload(); await page.locator(`[data-library-match="${math.id}"]`).waitFor();
    assert.equal(await page.locator(`[data-library-match="${migrated.id}"]`).count(), 0);
    checks.push({ finding: 'L4', language, width, controlAssetId: math.id, migratedAssetId: migrated.id, compatibleControl,
      oldEnvironment: oldRelease.mathematics?.environment, latestPublicEnvironment: newerRelease.mathematics?.environment,
      recommendedVersion: 'v1', recommendationHref, recommendedDetail, unfilteredVersion: 'v2', privateReleaseHidden: true, withdrawnReleaseExcluded: true });

    phase = `dependency-context-${language}`;
    await page.goto(`${origin}/library.html?${target}`);
    await page.locator(`[data-library-match="${math.id}"]`).waitFor();
    await page.locator('.research-card-heading').filter({ hasText: math.name }).click();
    await page.waitForFunction(runId => (document.querySelector('[data-library-trial] select') as HTMLSelectElement)?.value.includes(runId), original.id);
    const directoryControl = await state(page);
    assert.ok(directoryControl.target?.includes(original.id));
    await snapshot(page, `directory-target-control-${language}`);
    await page.locator('[data-library-trial]').screenshot({ path: path.join(output, `directory-target-control-${language}-detail.png`) });
    const agentTarget = new URLSearchParams(target); agentTarget.set('type', 'agent');
    await page.goto(`${origin}/library.html?${agentTarget}`);
    await page.locator('.research-card-heading').filter({ hasText: agent.name }).click();
    await page.getByRole('heading', { name: agent.name, exact: true }).waitFor();
    const agentContext = await state(page);
    const dependency = page.locator('.research-content .research-list-item').filter({ hasText: `${math.id}@v1` });
    await dependency.waitFor();
    const dependencyHref = await dependency.getAttribute('href');
    await dependency.click();
    await page.getByRole('heading', { name: math.name, exact: true }).waitFor();
    const dependencyContext = await state(page);
    for (const [key, value] of target) assert.equal(new URL(page.url()).searchParams.get(key), value);
    assert.equal(new URL(page.url()).searchParams.get('version'), 'v1');
    const trial = page.locator('[data-library-trial]');
    await trial.getByRole('combobox', { name: tx('研究 / 精确任务版本', 'Research / exact task version'), exact: true }).waitFor();
    await page.waitForFunction(() => Boolean((document.querySelector('[data-library-trial] select') as HTMLSelectElement)?.value));
    const selectedDependencyGoal = await state(page);
    assert.ok(selectedDependencyGoal.target?.includes(original.id));
    assert.equal(selectedDependencyGoal.target?.includes(decoy.id), false);
    await trial.getByRole('textbox', { name: tx('候选 Lean 证明体', 'Candidate Lean proof body'), exact: true }).fill('by\n  exact Shared.zero n');
    const preparedResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/trials'));
    await trial.getByRole('button', { name: tx('准备并审阅候选', 'Prepare candidate for review'), exact: true }).click();
    const prepared = await preparedResponse; assert.equal(prepared.status(), 201);
    assert.equal((await prepared.json()).item.target.ref.runId, original.id);
    await trial.locator('[data-library-trial-review]').waitFor();
    assert.equal(await trial.getByRole('checkbox').isChecked(), false);
    await snapshot(page, `dependency-exact-target-preserved-${language}`);
    await trial.screenshot({ path: path.join(output, `dependency-exact-target-preserved-${language}-detail.png`) });

    phase = `dependency-stale-context-${language}`;
    const stale = new URLSearchParams(agentTarget); stale.set('entry', agent.id); stale.set('commit', 'b'.repeat(40));
    await page.goto(`${origin}/library.html?${stale}`);
    await page.getByRole('heading', { name: agent.name, exact: true }).waitFor();
    await page.locator('.research-content .research-list-item').filter({ hasText: `${math.id}@v1` }).click();
    await trial.getByRole('combobox', { name: tx('研究 / 精确任务版本', 'Research / exact task version'), exact: true }).waitFor();
    await trial.getByRole('alert').filter({ hasText: tx('入口对应的任务版本或源码提交已改变', 'The linked task version or source commit has changed') }).waitFor();
    assert.equal(await trial.getByRole('combobox', { name: tx('研究 / 精确任务版本', 'Research / exact task version'), exact: true }).inputValue(), '');
    assert.equal(await trial.getByRole('button', { name: tx('准备并审阅候选', 'Prepare candidate for review'), exact: true }).isDisabled(), true);
    checks.push({ finding: 'L3', language, width, originalRunId: original.id, decoyRunId: decoy.id,
      directoryControl, agentContext, dependencyHref, dependencyContext, selectedDependencyGoal, preparedForOriginalTarget: true, explicitConfirmationRequired: true, staleTargetNotSubstituted: true });
    assert.equal(JSON.stringify(original), originalBefore); assert.equal(JSON.stringify(decoy), decoyBefore);
    await context.close(); active = undefined;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0); assert.equal(browserStarts, 0); assert.equal(recordedRuns, 4);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), build, fixtureOnly: true,
    checks, recordedRuns, prohibited, browserStarts, errors, external }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, recordedRuns, prohibited, browserStarts, errors, external }));
} catch (error) {
  await active?.screenshot({ path: path.join(output, 'probe-failure.png'), fullPage: true }).catch(() => undefined);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', phase, error: String(error), state: active ? await state(active).catch(() => undefined) : undefined,
    build, checks, recordedRuns, prohibited, browserStarts, errors, external }, null, 2));
  throw error;
} finally {
  await browser.close(); await fixtures.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
