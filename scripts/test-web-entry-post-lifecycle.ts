#!/usr/bin/env bun
// Disposable recorded fixtures and intercepted submissions; no model, Lean, mail or production data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { WebStorage } from '../apps/web/storage';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebSharedProofs } from '../apps/web/sharedProofs';
import { shareSnapshot } from '../apps/web/share';
import { localeStorageKey } from '../apps/web/i18n';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { WebRunner } from '../apps/web/runner';
import { freePort } from './web-scenario';
import { closeSettings, openSettings } from './web-ui-controls';
import { webFormalizationEvidence, webFormalizationStatement } from '../tests/helpers/webFormalizationFixture';
import { readingRun } from '../tests/helpers/shareReadingFixture';
import { defaultResearchModulePlan } from '../src/solver/modules/policy';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/post-lifecycle-20261111/entry');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-entry-continuity-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`, email = 'entry-continuity@example.org';
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: email,
  THEOREMOS_WEB_PROVIDERS: JSON.stringify([{ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1' }]) });
const storage = new WebStorage(dataRoot), account = { id: crypto.randomUUID(), email, completionEmail: false,
  createdAt: new Date().toISOString(), termsAt: new Date().toISOString(), termsVersion: config.auth!.termsVersion };
storage.saveRecord(['accounts', `${mathDigest(email)}.json`], account);
const session = { id: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''), csrf: mathDigest(crypto.randomUUID()),
  touchedAt: Date.now(), account: { id: account.id, email } };
storage.saveSession(session);
let recordedRuns = 0, recordedFormalizations = 0, prohibited = 0, blockedPrechecks = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable recorded continuity fixture' }; },
  async run(_input, send) { recordedRuns++; send({ type: 'error', message: 'Recorded ended run.' }); },
  async formalize(input, send) { recordedFormalizations++; send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(input) }); },
  async check() { blockedPrechecks++; throw new Error('This fixture does not execute Lean'); },
};
const service = createWebService(config, runner, { sample: null, mailer: async () => { prohibited++; throw new Error('No mail allowed'); } });
const owner = `account:${account.id}`, provider = config.providers[0];
const asset = service.research.assets.create(owner, { requestId: 'continuity-skill', type: 'skill', name: 'Pinned original strategy',
  content: { instructions: 'Keep the exact recorded strategy.', steps: ['Inspect the exact goal'], slots: ['M1'] } });
const publication = await service.research.assets.publish(owner, asset.id, { requestId: 'publish-skill', expectedRevision: asset.revision, version: 'v1', license: 'MIT', visibility: 'private' });
const skill = (await service.research.assets.waitForPublication(owner, publication.id)).release!;
const recordedAssets = new WebResearchAssets(storage, { identity: viewer => service.research.projects.identity(viewer),
  async resolveMathematics() { return { environment: 'standard', environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest,
    declarations: [{ name: 'Pinned.identity', type: '(n : Nat) : n + 0 = n', file: 'Submission/Library/Pinned.lean' }],
    pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'Submission/Library/Pinned.lean',
      source: 'namespace Pinned\ntheorem identity (n : Nat) : n + 0 = n := by simp\nend Pinned\n',
      origin: { kind: 'run', runId: 'recorded-evidence', commit: 'a'.repeat(40), file: 'Main.lean' } }] } }; },
  async validateMathematics() { return { passed: true, receiptRefs: ['recorded-publication'] }; } });
const mathematics = recordedAssets.create(owner, { requestId: 'recorded-math', type: 'mathematics', name: 'Pinned original dependency',
  content: { source: { kind: 'run', runId: 'recorded-evidence', commit: 'a'.repeat(40) } } });
const mathPublication = await recordedAssets.publish(owner, mathematics.id, { requestId: 'publish-math', expectedRevision: mathematics.revision,
  version: 'v1', license: 'MIT', visibility: 'private' });
const library = (await recordedAssets.waitForPublication(owner, mathPublication.id)).release!;
const agentAsset = service.research.assets.create(owner, { requestId: 'continuity-agent', type: 'agent', name: 'Pinned original Agent', content: {
  environment: 'standard', providerId: provider.id, model: 'agent-default-must-not-overwrite-run', effort: 'max', workers: 3,
  modulePlan: { ...defaultResearchModulePlan(), scheduler: 'critical-path' }, skills: [skill], libraries: [library] } });
const agentPublication = await service.research.assets.publish(owner, agentAsset.id, { requestId: 'publish-agent', expectedRevision: agentAsset.revision,
  version: 'v1', license: 'MIT', visibility: 'private' });
const agent = (await service.research.assets.waitForPublication(owner, agentPublication.id)).release!;
const configuration = service.research.assets.freeze(owner, { agent, skills: [skill], libraries: [library] }, 'standard');
const source = 'import Submission.Library.Pinned\n\ntheorem pinned_problem (n : Nat) : n + 0 = n := by\n  exact Pinned.identity n\n';
const run = service.jobs.create(owner, { providerId: provider.id, apiKey: 'sk-disposable-never-sent', model: 'original-lean-model', effort: 'high',
  environment: 'standard', source, task: 'Keep the exact statement and strategy.', maxTurns: 3, maxRunSeconds: 180, maxTotalTokens: 30000,
  workers: 1, coordination: 'independent' }, provider, undefined, undefined, undefined, configuration);
const formalization = service.formalizations.create(owner, { original: webFormalizationStatement, providerId: provider.id, apiKey: 'sk-disposable-never-sent',
  model: 'original-natural-model', effort: 'high', environment: 'standard', maxRunSeconds: 120, maxTotalTokens: 20000,
  research: { maxRunSeconds: 180, maxTurns: 3, maxTotalTokens: 30000 }, solve: true, humanReview: true }, provider, 'original-natural-model');
const naturalChat = service.conversations.create(owner, { formalizationId: formalization.id }), leanChat = service.conversations.create(owner, { runId: run.id });
const sharedRun = readingRun(crypto.randomUUID()), snapshot = shareSnapshot(sharedRun)!, token = crypto.randomUUID().replaceAll('-', '');
service.storage.saveRun('account:shared-author', sharedRun);
service.storage.saveShare('account:shared-author', sharedRun.id, { token, createdAt: snapshot.sharedAt, snapshot });
const sharedProofs = new WebSharedProofs(storage), reading = sharedProofs.register(owner, { token, requestId: 'register-shared' });
const prepared = sharedProofs.prepare(owner, reading.id, { requestId: 'prepare-shared', expectedDigest: reading.digest, confirmed: true });
await new Promise<void>((resolve, reject) => { service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolve); });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const errors: string[] = [], external: string[] = [], checks: object[] = [], contexts: BrowserContext[] = [];
let phase = 'setup', active: Page | undefined, failure: unknown;
async function actor(language: 'zh' | 'en', width: number) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: language === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce' });
  contexts.push(context); await context.addCookies([{ name: 'theoremos_session', value: session.id, url: origin }]);
  await context.addInitScript(({ key, language }) => localStorage.setItem(key, language), { key: localeStorageKey, language });
  await context.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message)); active = page; return page;
}
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const page = await actor(language, width);
    phase = `historical-edit-${language}`;
    await page.goto(origin); await page.locator('#formalize-original').waitFor();
    const unsaved = `Unsaved original A (${language}): n + 0 = n; my derivation must survive.`;
    await page.locator('#formalize-original').fill(unsaved);
    const readSettings = () => page.evaluate(() => Object.fromEntries(['formalize-provider', 'formalize-model', 'formalize-environment', 'formalize-effort',
      'formalize-minutes', 'formalize-tokens', 'research-minutes', 'research-tokens', 'research-turns'].map(id => [id, (document.getElementById(id) as HTMLInputElement).value])));
    const homeSettings = await readSettings();
    await page.goto(`${origin}/?chat=${naturalChat.id}`);
    await page.getByRole('button', { name: language === 'zh' ? '修改题目' : 'Edit problem', exact: true }).click();
    await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), formalization.original);
    const values = await readSettings();
    assert.deepEqual(values, { 'formalize-provider': provider.id, 'formalize-model': formalization.model, 'formalize-environment': 'mathlib',
      'formalize-effort': 'high', 'formalize-minutes': '2', 'formalize-tokens': '20000', 'research-minutes': '3', 'research-tokens': '30000', 'research-turns': '3' });
    assert.equal(new URL(page.url()).searchParams.get('editProblem'), naturalChat.id);
    await page.reload(); await page.locator('[data-chat-return-home]').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), formalization.original);
    assert.deepEqual(await readSettings(), values, 'The independent edit retains the recorded settings after refresh');
    await page.locator('[data-chat-return-home]').click(); assert.equal(await page.locator('#formalize-original').inputValue(), unsaved);
    assert.deepEqual(await readSettings(), homeSettings, 'Returning home restores its own settings');
    checks.push({ finding: 'EN1+EN3', language, width, originalRecoveredAfterReload: true, exactHistoricalSettings: values });

    phase = `retry-pinned-${language}`;
    const retry = await actor(language, width); await retry.goto(`${origin}/?chat=${leanChat.id}`);
    await retry.locator('[data-chat-recovery=retry]').click(); await retry.locator('#run-settings[open]').waitFor();
    const selectionPanel = retry.locator('.composer-research-selection').filter({ hasText: mathematics.name }); await selectionPanel.waitFor({ state: 'attached' });
    await closeSettings(retry); await retry.reload(); await selectionPanel.waitFor({ state: 'attached' });
    await retry.locator('body[data-entry=lean]').waitFor({ state: 'attached' });
    const restoredRun = await retry.evaluate(() => Object.fromEntries(['model', 'effort', 'workers', 'max-turns', 'max-seconds', 'max-tokens'].map(id => [id, (document.getElementById(id) as HTMLInputElement).value])));
    assert.deepEqual(restoredRun, { model: run.model, effort: run.effort, workers: '1', 'max-turns': '3', 'max-seconds': '180', 'max-tokens': '3' });
    await openSettings(retry);
    await retry.locator('#api-key').fill('sk-disposable-intercepted'); await closeSettings(retry);
    let submitted: Record<string, any> | undefined;
    await retry.route('**/api/runs', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      submitted = route.request().postDataJSON(); delete submitted!.apiKey;
      await route.fulfill({ status: 422, json: { error: 'Recorded submission intercepted before execution.' } });
    });
    const response = retry.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'POST');
    await retry.locator('#submit-run:enabled').click(); await response;
    assert.equal(submitted!.source, run.source); assert.equal(submitted!.model, run.model); assert.equal(submitted!.maxTotalTokens, 30000);
    assert.deepEqual(submitted!.researchSelection.skills, [skill].map(item => ({ assetId: item.assetId, version: item.version, digest: item.digest })));
    assert.deepEqual(submitted!.researchSelection.libraries, [library].map(item => ({ assetId: item.assetId, version: item.version, digest: item.digest })));
    assert.deepEqual(submitted!.researchSelection.agent, { assetId: agent.assetId, version: agent.version, digest: agent.digest });
    assert.deepEqual(submitted!.modulePlan, run.modulePlan);
    await retry.screenshot({ path: path.join(output, `pinned-retry-${language}.png`), fullPage: true });
    checks.push({ finding: 'EN2', language, width, submitted, restoredRun });

    phase = `unavailable-pinned-${language}`;
    const unavailable = await actor(language, width); await unavailable.goto(`${origin}/?chat=${leanChat.id}`);
    await unavailable.route(`**/api/research/library/${library.assetId}/releases/${library.version}`, route => route.fulfill({ status: 404,
      json: { error: language === 'zh' ? '固定库版本已不可用。' : 'Pinned library version is unavailable.' } }));
    await unavailable.locator('[data-chat-recovery=retry]').click();
    await unavailable.locator('#toast').filter({ hasText: language === 'zh' ? '固定库版本已不可用' : 'Pinned library version is unavailable' }).waitFor();
    assert.equal(await unavailable.locator('body').getAttribute('data-entry'), 'natural');
    assert.equal(new URL(unavailable.url()).searchParams.get('chat'), leanChat.id);
    checks.push({ finding: 'EN2-unavailable', language, width, draftNotReplaced: true });

    phase = `unavailable-provider-${language}`;
    const missingProvider = await actor(language, width);
    await missingProvider.route(`**/api/formalizations/${formalization.id}`, async route => {
      const response = await route.fetch(), body = await response.json(); body.formalization.providerId = 'removed-original-provider';
      await route.fulfill({ response, json: body });
    });
    await missingProvider.goto(`${origin}/?chat=${naturalChat.id}`);
    await missingProvider.getByRole('button', { name: language === 'zh' ? '修改题目' : 'Edit problem', exact: true }).click();
    await missingProvider.locator('#formalize-settings > summary').click();
    assert.equal(await missingProvider.locator('#formalize-provider').inputValue(), 'removed-original-provider');
    assert.ok((await missingProvider.locator('#formalize-provider option:checked').innerText()).includes('removed-original-provider'));
    await missingProvider.locator('#formalize-key').fill('sk-disposable-not-submitted');
    assert.equal(await missingProvider.locator('#formalize-start').isDisabled(), true);
    checks.push({ finding: 'EN3-unavailable-provider', language, width, originalProviderVisible: true, requiresExplicitReplacement: true });

    phase = `shared-refresh-${language}`;
    const shared = await actor(language, width);
    await shared.goto(`${origin}/?sharedDraft=${prepared.id}`); await shared.locator('[data-shared-proof-ready=true]').waitFor();
    await shared.locator('#source').waitFor({ state: 'visible' });
    const edited = `${prepared.source}\n-- My independent change ${language}\n`;
    await shared.locator('#source').fill(edited);
    const originalLink = await shared.locator('[data-shared-proof-origin] a').getAttribute('href');
    assert.ok(originalLink?.includes(reading.id)); assert.ok(!shared.url().includes('sharedDraft'));
    await shared.reload(); await shared.locator('[data-shared-proof-origin] a').waitFor();
    await shared.locator('#source').waitFor({ state: 'visible' });
    assert.equal(await shared.locator('body').getAttribute('data-entry'), 'lean'); assert.equal(await shared.locator('#source').inputValue(), edited);
    assert.equal(await shared.locator('[data-shared-proof-origin] a').getAttribute('href'), originalLink);
    assert.ok((await shared.locator('[data-shared-proof-origin]').innerText()).includes(prepared.origin.title));
    await shared.screenshot({ path: path.join(output, `shared-draft-reloaded-${language}.png`), fullPage: true });
    checks.push({ finding: 'R4', language, width, editedSourcePreserved: true, provenanceRetained: true, entry: 'lean' });
    // A new explicit classic entry takes precedence over restoring an earlier shared Lean draft.
    await shared.goto(`${origin}/?fromClassic=recorded-classic&lang=${language}`); await shared.locator('[data-classic-origin]').waitFor();
    await shared.locator('[data-inbox-summary] > div > a').first().waitFor();
    assert.equal(await shared.locator('body').getAttribute('data-entry'), 'natural');
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(recordedRuns, 1); assert.equal(recordedFormalizations, 1); assert.equal(prohibited, 0);
} catch (error) { failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(), phase,
    checks, errors, external, recordedRuns, recordedFormalizations, blockedPrechecks, actualModelCalls: 0, actualLeanCalls: 0, mailCalls: prohibited,
    ...(failure ? { error: String(failure) } : {}) }, null, 2));
  for (const context of contexts) await context.close(); await browser.close(); await service.close(); await recordedAssets.close();
  await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Entry continuity: ${checks.length} bilingual desktop/mobile checks passed`);
