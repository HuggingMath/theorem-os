#!/usr/bin/env bun
// Disposable Library regression workflows: recorded runner, no models, Lean, mail or production data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebResearchLibraryTrials } from '../apps/web/researchLibraryTrials';
import { loadWebSample } from '../apps/web/sample';
import type { WebRunner } from '../apps/web/runner';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { freePort, preferFullCollaboration, startBrowser } from '../scripts/web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/post-continuity-20261111/library');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-library-product-audit-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const source = 'theorem preserved : 1 = 1 := by rfl\nnamespace Research\ntheorem target (n : Nat) : n + 0 = n := by sorry\nend Research';
const commit = 'a'.repeat(40), environmentDigest = mathDigest('product-library-audit-environment');
let workers = 0, prohibited = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable audit fixture' }; },
  async run(input, send) {
    workers++;
    const observation = structuredClone(loadWebSample()!.observations.at(-1)!);
    observation.webRunId = input.id; observation.sequence = 1;
    observation.inspection.configuration.environmentDigest = environmentDigest;
    observation.inspection.tasks = [{ id: 'target', kind: 'goal', objective: 'Prove addition', theorem: 'Research.target', type: '(n : Nat) : n + 0 = n',
      group: 'main', status: 'working', control: 'active', version: 'task-v1', premises: ['n : Nat'], plannedDependencies: [], attempts: 1, proof: { status: 'open' }, parkedBy: [], parkedRoutes: {} }];
    observation.plan = { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [{ id: 'target', kind: 'goal', objective: 'Prove addition', dependsOn: [],
      revision: 1, proofPath: 'Main.lean', theoremName: 'Research.target' }] };
    observation.sources = [{ taskId: 'target', taskVersion: 'task-v1', commit, sourceDigest: mathDigest(input.input.source), environmentDigest,
      file: 'Main.lean', source: input.input.source, scope: 'owned-file' }];
    observation.inspection.problem.targets = [{ theoremName: 'Research.target', proofPath: 'Main.lean' }];
    send({ type: 'observation', observation });
    send({ type: 'result', result: { status: 'incomplete', proof: input.input.source, report: { fixture: true, acceptance: 'not-assessed' } } });
  },
  async check() { prohibited++; throw new Error('Audit must not invoke Lean'); },
  async command() { prohibited++; throw new Error('Audit must not invoke runtime commands'); },
  async formalize() { prohibited++; throw new Error('Audit must not invoke models'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner,
  { sample: null, mailer: async () => { prohibited++; throw new Error('Audit must not send mail'); } });
const assets = new WebResearchAssets(service.storage, {
  identity: owner => service.research.projects.identity(owner),
  async resolveMathematics() { return {
    environment: 'standard', environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest,
    declarations: [{ name: 'Shared.zero', type: '(n : Nat) : n + 0 = n', file: 'Submission/Library/Shared.lean' }],
    pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'Submission/Library/Shared.lean',
      source: 'namespace Shared\ntheorem zero (n : Nat) : n + 0 = n := by simp\nend Shared\n',
      origin: { kind: 'run', runId: 'fixed-browser-library', commit, file: 'Main.lean' } }] },
  }; },
  async validateMathematics() { return { passed: true, receiptRefs: ['fixture-publication-only'] }; },
});
const trials = new WebResearchLibraryTrials({ storage: service.storage, jobs: service.jobs, projects: service.research.projects, assets, runner });
const browser = await startBrowser(service.server, port), errors: string[] = [], external: string[] = [], checks: object[] = [];
let phase = 'setup', active: Page | undefined;
async function makeContext(language: 'zh' | 'en', width: number): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: language === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce' });
  await preferFullCollaboration(context);
  await context.addInitScript(language => { try { localStorage.setItem('theorem-os.web-locale.v1', language); } catch { /* Initial blank document has no storage. */ } }, language);
  await context.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
  });
  context.on('page', page => { page.setDefaultTimeout(12_000); page.on('pageerror', error => errors.push(error.message)); });
  return context;
}
async function ownerOf(context: BrowserContext) { return (await context.cookies(origin)).find(item => item.name === 'theoremos_session')!.value; }
async function publish(owner: string, id: string, version: string) {
  const current = assets.get(owner, id), preview = await assets.preview(owner, id);
  const publication = await assets.publish(owner, id, { requestId: `publish-${id}-${version}`, expectedRevision: current.revision,
    previewDigest: preview.previewDigest, version, license: 'MIT', visibility: 'public', releaseNotes: `Release ${version}` });
  assert.equal((await assets.waitForPublication(owner, publication.id)).status, 'completed');
  return assets.release(owner, id, version);
}
async function http(page: Page, pathname: string) {
  return page.evaluate(async pathname => { const response = await fetch(pathname); return { status: response.status, body: await response.json() }; }, pathname);
}
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const tx = (zh: string, en: string) => language === 'zh' ? zh : en;
    const authorContext = await makeContext(language, width), readerContext = await makeContext(language, width);
    const authorPage = await authorContext.newPage(), page = await readerContext.newPage(); active = page;
    await authorPage.goto(`${origin}/library.html`); await authorPage.locator('main').waitFor();
    await page.goto(`${origin}/library.html`); await page.locator('main').waitFor();
    const author = await ownerOf(authorContext), reader = await ownerOf(readerContext);
    assert.notEqual(author, reader);

    phase = `follow-compare-control-${language}`;
    const skill = assets.create(author, { requestId: `skill-${language}`, type: 'skill', name: `Route audit ${language}`,
      content: { instructions: 'Inspect the exact goal.', steps: ['Read goal', 'Check premises'], slots: ['M1'] } });
    await publish(author, skill.id, 'v1');
    await page.goto(`${origin}/library.html?entry=${skill.id}&version=v1`);
    await page.getByRole('button', { name: tx('关注新版本', 'Follow new releases'), exact: true }).click();
    await page.getByRole('button', { name: tx('已关注新版本', 'Following new releases'), exact: true }).waitFor();
    let current = assets.get(author, skill.id);
    assets.update(author, skill.id, { requestId: `skill-v2-${language}`, expectedRevision: current.revision,
      content: { instructions: 'Inspect the exact goal and explain the next step.', steps: ['Read goal', 'Check premises', 'Connect next step'], slots: ['M1'] } });
    await publish(author, skill.id, 'v2');
    await page.goto(`${origin}/workspace.html?tab=inbox#asset-updates`);
    const updates = page.locator('#asset-updates');
    await updates.getByRole('link', { name: tx('查看版本差异', 'Compare releases'), exact: true }).click();
    await page.locator('[data-release-comparison]').getByRole('heading', { name: 'v1 → v2', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, `follow-before-withdrawal-${language}.png`), fullPage: true });

    phase = `follow-withdrawn-baseline-${language}`;
    assets.withdraw(author, skill.id, { requestId: `withdraw-v1-${language}`, expectedRevision: assets.get(author, skill.id).revision, version: 'v1' });
    await page.goto(`${origin}/workspace.html?tab=inbox#asset-updates`);
    const updatePayload = await http(page, '/api/research/asset-follows');
    assert.equal(updatePayload.status, 200);
    const upgrade = updatePayload.body.updates.find((item: any) => item.assetId === skill.id);
    assert.equal(upgrade.fromVersion, 'v1'); assert.equal(upgrade.toVersion, 'v2');
    await updates.getByRole('link', { name: tx('查看版本差异', 'Compare releases'), exact: true }).click();
    await page.getByRole('button', { name: tx('已关注新版本', 'Following new releases'), exact: true }).waitFor();
    await page.locator('[data-release-comparison-unavailable]').waitFor();
    assert.match(await page.locator('[data-release-comparison-unavailable]').innerText(), /v1/);
    assert.equal(await page.locator('[data-release-comparison] select').count(), 0);
    const accessibleLink = page.locator('[data-release-comparison-unavailable] a');
    assert.match((await accessibleLink.getAttribute('href'))!, /version=v2/);
    assert.equal(await page.locator('[data-release-comparison-unavailable] button').isEnabled(), true);
    const inaccessibleCompare = await http(page, `/api/research/library/${skill.id}/compare?from=v1&to=v2`);
    assert.equal(inaccessibleCompare.status, 404);
    const onlyV2 = { url: page.url(), comparisonSections: await page.locator('[data-release-comparison]').count(), notice: await page.locator('[data-release-comparison-unavailable]').innerText(), alerts: await page.getByRole('alert').allTextContents(),
      availableRelease: (await http(page, `/api/research/library/${skill.id}/releases/v2`)).status, comparisonResponse: inaccessibleCompare };
    await page.screenshot({ path: path.join(output, `follow-one-release-withdrawn-${language}.png`), fullPage: true });
    current = assets.get(author, skill.id);
    assets.update(author, skill.id, { requestId: `skill-v3-${language}`, expectedRevision: current.revision,
      content: { instructions: 'Inspect goal, next step, and proof.', steps: ['Read goal', 'Check premises', 'Connect next step', 'Check proof'], slots: ['M1'] } });
    await publish(author, skill.id, 'v3');
    await page.goto(`${origin}/workspace.html?tab=inbox#asset-updates`);
    await updates.getByRole('link', { name: tx('查看版本差异', 'Compare releases'), exact: true }).first().click();
    await page.locator('[data-release-comparison-unavailable]').waitFor();
    assert.equal(await page.locator('[data-release-comparison] select').first().inputValue(), 'v1');
    assert.equal(await page.locator('[data-release-comparison] select').first().locator('option[value=v1]').getAttribute('disabled'), '');
    const twoNewer = { url: page.url(), alerts: await page.locator('[data-release-comparison]').getByRole('alert').allTextContents(),
      compareFromValue: await page.locator('[data-release-comparison] select').first().inputValue() };
    await page.screenshot({ path: path.join(output, `follow-two-releases-withdrawn-${language}.png`), fullPage: true });
    await page.locator('[data-release-comparison] select').first().selectOption('v2');
    await page.locator('[data-release-comparison]').getByRole('heading', { name: 'v2 → v3', exact: true }).waitFor();
    assert.equal(await page.locator('[data-release-comparison-unavailable]').count(), 0);
    assert.equal(new URL(page.url()).searchParams.get('compareFrom'), 'v2');
    await page.reload(); await page.locator('[data-release-comparison]').getByRole('heading', { name: 'v2 → v3', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, `follow-explicit-comparison-${language}.png`), fullPage: true });
    checks.push({ finding: 'L1', language, width, baselineControl: true, upgrade, onlyV2, twoNewer, explicitAccessibleComparison: true, selectedComparisonSurvivesReload: true });

    phase = `trial-edit-draft-${language}`;
    const session = await http(page, '/api/session'), provider = session.body.providers[0];
    const run = service.jobs.create(reader, { providerId: provider.id, apiKey: 'sk-disposable-not-sent', model: 'recorded-fixture', effort: 'high', environment: 'standard', source,
      task: `Trial editing audit ${language}`, maxTurns: 1, maxRunSeconds: 60, workers: 1, coordination: 'independent' }, provider);
    await page.waitForFunction(async runId => { const data = await (await fetch('/api/runs')).json(); return data.runs.some((run: any) => run.id === runId && run.status === 'completed'); }, run.id);
    const math = assets.create(reader, { requestId: `math-${language}`, type: 'mathematics', name: `Trial addition ${language}`,
      content: { source: { kind: 'run', runId: 'fixed-browser-library', commit } } });
    await publish(reader, math.id, 'v1');
    await page.goto(`${origin}/library.html?entry=${math.id}&version=v1&run=${run.id}`);
    const form = page.locator('[data-library-trial]');
    const proofField = form.getByRole('textbox', { name: tx('候选 Lean 证明体', 'Candidate Lean proof body'), exact: true });
    const argumentField = form.getByRole('textbox', { name: tx('参数如何对应（可选）', 'Argument mapping (optional)'), exact: true });
    const missingField = form.getByRole('textbox', { name: tx('仍需补充的前提（可选）', 'Premises still needed (optional)'), exact: true });
    const prepareButton = form.getByRole('button', { name: tx('准备并审阅候选', 'Prepare candidate for review'), exact: true });
    const proofA = 'by\n  exact Shared.zero n', proofB = 'by\n  -- Revised argument after checking the target\n  simpa only using Shared.zero n';
    const argumentA = 'Saved mapping: use the current natural number n.', argumentB = 'Revised mapping: n is the same target variable; no coercion is needed.';
    const missingB = 'Revised premises: verify the target environment before checking.';
    await proofField.fill(proofA); await argumentField.fill(argumentA); await prepareButton.click();
    await form.locator('[data-library-trial-review]').waitFor();
    const savedId = new URL(page.url()).searchParams.get('trial')!; assert.ok(savedId);
    await page.reload(); await form.locator('[data-library-trial-review]').waitFor();
    assert.equal(await proofField.inputValue(), proofA); assert.equal(await argumentField.inputValue(), argumentA);
    await proofField.fill(proofB); await argumentField.fill(argumentB); await missingField.fill(missingB);
    assert.equal(await form.locator('[data-library-trial-review]').count(), 0);
    await form.locator('[data-library-trial-draft-saved]').waitFor();
    await page.screenshot({ path: path.join(output, `trial-unsaved-edits-${language}.png`), fullPage: true });
    const persistedEdit = await page.evaluate(needle => ({
      local: Object.values(localStorage).some(value => value.includes(needle)), session: Object.values(sessionStorage).some(value => value.includes(needle)),
    }), 'Revised mapping: n is the same target variable');
    let dialogs = 0;
    page.on('dialog', async dialog => { dialogs++; await dialog.accept(); });
    await page.reload(); await form.locator('[data-library-trial-draft-saved]').waitFor();
    assert.equal(await form.locator('[data-library-trial-review]').count(), 0);
    assert.equal(new URL(page.url()).searchParams.get('trial'), savedId);
    const restored = { proof: await proofField.inputValue(), argumentNotes: await argumentField.inputValue(), missingPremises: await missingField.inputValue(), dialogs };
    assert.equal(restored.proof, proofB); assert.equal(restored.argumentNotes, argumentB); assert.equal(restored.missingPremises, missingB);
    assert.equal(persistedEdit.session, true);
    assert.equal(dialogs, 0);
    await page.screenshot({ path: path.join(output, `trial-edits-reverted-${language}.png`), fullPage: true });
    await prepareButton.click();
    await form.locator('[data-library-trial-review]').waitFor();
    const newSavedId = new URL(page.url()).searchParams.get('trial')!;
    assert.notEqual(savedId, newSavedId);
    await page.reload(); await form.locator('[data-library-trial-review]').waitFor();
    assert.equal(await proofField.inputValue(), proofB); assert.equal(await argumentField.inputValue(), argumentB); assert.equal(await missingField.inputValue(), missingB);
    assert.equal(await form.getByRole('checkbox').first().isChecked(), false);
    assert.equal(await form.getByRole('button', { name: tx('确认并独立检查', 'Confirm and check independently'), exact: true }).isDisabled(), true);
    const secondRun = service.jobs.create(reader, { providerId: provider.id, apiKey: 'sk-disposable-not-sent', model: 'recorded-fixture', effort: 'high', environment: 'standard', source,
      task: `Separate trial target ${language}`, maxTurns: 1, maxRunSeconds: 60, workers: 1, coordination: 'independent' }, provider);
    await page.waitForFunction(async runId => { const data = await (await fetch('/api/runs')).json(); return data.runs.some((run: any) => run.id === runId && run.status === 'completed'); }, secondRun.id);
    await page.reload(); await form.locator('[data-library-trial-review]').waitFor();
    const targetSelect = form.getByRole('combobox', { name: tx('研究 / 精确任务版本', 'Research / exact task version'), exact: true });
    const originalTarget = await targetSelect.inputValue();
    const secondTarget = await targetSelect.locator('option').evaluateAll((options, runId) => options.map(option => option as HTMLOptionElement).find(option => option.value.includes(runId))?.value, secondRun.id);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      (window as unknown as { restoreTrialStorage: () => void }).restoreTrialStorage = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('theorem-os.library-trial-draft.v1:')) throw new DOMException('Disposable quota fixture', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    const proofC = proofB + '\n  -- A further revision after preparing B';
    await proofField.fill(proofC); await form.locator('[data-library-trial-draft-error]').waitFor();
    assert.equal(await proofField.inputValue(), proofC);
    const leaveProtected = await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
    assert.equal(leaveProtected, true);
    assert.ok(secondTarget); await targetSelect.selectOption(secondTarget);
    await page.waitForFunction(() => (document.querySelector('[data-library-trial] fieldset') as HTMLFieldSetElement)?.disabled === false);
    const leaveProtectedOnOtherTarget = await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
    assert.equal(leaveProtectedOnOtherTarget, true);
    await targetSelect.selectOption(originalTarget);
    await page.waitForFunction(() => (document.querySelector('[data-library-trial] fieldset') as HTMLFieldSetElement)?.disabled === false);
    assert.equal(await proofField.inputValue(), proofC);
    await form.locator('[data-library-trial-draft-error]').waitFor();
    await page.screenshot({ path: path.join(output, `trial-storage-failure-${language}.png`), fullPage: true });
    await page.evaluate(() => (window as unknown as { restoreTrialStorage: () => void }).restoreTrialStorage());
    await form.getByRole('button', { name: tx('重试保存草稿', 'Retry saving the draft'), exact: true }).click();
    await form.locator('[data-library-trial-draft-error]').waitFor({ state: 'hidden' });
    await page.reload(); await form.locator('[data-library-trial-draft-saved]').waitFor();
    assert.equal(await proofField.inputValue(), proofC);
    assert.equal(await form.locator('[data-library-trial-review]').count(), 0);
    assert.ok(secondTarget); await targetSelect.selectOption(secondTarget);
    await proofField.waitFor({ state: 'visible' }); await page.waitForFunction(() => (document.querySelector('[data-library-trial] fieldset') as HTMLFieldSetElement)?.disabled === false);
    assert.equal(await proofField.inputValue(), '');
    await proofField.fill('by\n  -- separate target draft\n  exact Shared.zero n');
    await targetSelect.selectOption(originalTarget);
    await page.waitForFunction(() => (document.querySelector('[data-library-trial] fieldset') as HTMLFieldSetElement)?.disabled === false);
    assert.equal(await proofField.inputValue(), proofC);
    await page.screenshot({ path: path.join(output, `trial-target-isolation-${language}.png`), fullPage: true });
    checks.push({ finding: 'L2', language, width, savedId, editedFields: { proof: proofB, argumentNotes: argumentB, missingPremises: missingB }, persistedEdit, restored,
      preparedCandidatePreservedControl: true, newSavedId, savedBReloadedControl: true, checkConfirmationReset: true, storageFailureVisible: true, leaveProtected, retryPreservesEdits: true, exactTargetDraftsIsolated: true, failedStorageTargetSwitchPreservesEdits: true, leaveProtectedOnOtherTarget });
    await readerContext.close(); await authorContext.close(); active = undefined;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0); assert.equal(workers, 4);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(),
    build: JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8')), fixtureOnly: true, checks, workers, prohibited, errors, external }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output, workers, prohibited }));
} catch (error) {
  await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'probe-failed', phase, error: String(error), url: active?.url(), checks, workers, prohibited, errors, external }, null, 2));
  throw error;
} finally { await browser.close(); await trials.close(); await assets.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
