#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { loadWebSample } from '../apps/web/sample';
import type { WorkerInput } from '../apps/web/shared';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, ready, settled, startBrowser, webScenario, writeScenarioReport, type ScenarioSuite } from './web-scenario';
import { enterLean, fillConfig, selectHistoryRun, showArtifacts, showChat, withSettings } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-skill-research');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.access(path.join(staticRoot, 'app.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-browser-skill-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`, credential = 'sk-offline-skill-browser-fixture';
const actual: WorkerInput[] = [], retained = new Map<string, ReturnType<typeof skillObservation>>();
const injection = '<img data-skill-injection src=x onerror="globalThis.__skillInjected=true">';

/** Synthetic presentation fixture; real sidecar/receipt projection is covered by webSkillDeclarationArtifacts.test.ts. */
function skillObservation(input: WorkerInput) {
  const value = structuredClone(loadWebSample()!.observations[0]!);
  value.webRunId = input.id; value.sequence = 1; value.observedAt = new Date().toISOString();
  value.inspection.phase = 'running';
  value.inspection.problem = { id: 'skill-fixture', statement: 'Prove the original goal.', formalStatement: input.input.source,
    assumptions: [], targets: [{ proofPath: 'Submission.lean', theoremName: 'original' }] };
  value.inspection.configuration = { model: input.input.model, effort: input.input.effort, workers: 1, coordination: 'independent',
    researchMode: 'skill', researchSkill: { name: 'mathematical-research', digest: mathDigest('frozen-browser-skill'), loading: 'file' },
    buildDigest: mathDigest('fixture-build'), environmentDigest: mathDigest('fixture-environment') };
  value.inspection.tasks = []; value.inspection.workers = []; value.inspection.groups = [];
  value.inspection.progress = { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: [] };
  const frontier = value.inspection.mathematics.snapshot;
  frontier.goals = []; frontier.obligations = []; frontier.routes = []; frontier.blockers = []; frontier.advisory = [];
  value.inspection.mathematics.recentChanges = []; value.inspection.statementReviews = []; value.inspection.edits = [];
  value.plan = null; value.sources = []; value.checks = []; value.guidance = []; value.deliveries = []; value.history = [];
  value.declarations = { status: 'recorded', digest: mathDigest('fixture-sidecar'), omitted: 0,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', requiresFreshCheck: true,
    declarations: [{ id: mathDigest('fixture-declaration'), file: 'Submission.lean', name: 'Research.reusable', type: '∀ n : Nat, n = n',
      elaboratedType: '∀ (n : Nat), Eq n n', premises: ['The parameter is arbitrary.', injection],
      sourceCommit: 'a'.repeat(40), checkedCommit: 'b'.repeat(40), environmentDigest: mathDigest('fixture-environment'), receiptIds: ['offline-browser-receipt'] }] };
  return value;
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Offline skill presentation fixture' }; },
  async run(input, send, signal) {
    actual.push(structuredClone(input)); const observation = skillObservation(input); retained.set(input.id, observation);
    send({ type: 'progress', event: 'solve_started', message: 'Offline fixture research' });
    send({ type: 'observation', observation });
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve(); });
  },
  async command(id, command) {
    assert.equal(command.type, 'capture');
    return { id: 'capture', status: 'captured', observation: structuredClone(retained.get(id)!) };
  },
};
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '2' });
config.providers = [{ id: 'fixture', name: 'Offline fixture', baseUrl: 'http://127.0.0.1:1/v1' }];
const service = createWebService(config, runner), checks: object[] = [], suite: ScenarioSuite = { origin, output, checks, failedScenario: '' };
let browser: Browser | undefined, failure: unknown;
try {
  browser = await startBrowser(service.server, port);
  for (const [width, language] of [[1440, 'zh'], [390, 'en']] as const) {
    await webScenario(browser, suite, `skill-create-restore-artifacts-${language}-${width}`, async ({ page }) => {
      await enterLean(page);
      assert.equal(await page.locator('#research-mode').inputValue(), 'legacy');
      await fillConfig(page, 'source', 'namespace Research\ntheorem original : True := by sorry\nend Research\n');
      await page.locator('#task').fill('Prove the original goal.');
      await withSettings(page, async () => {
        await page.locator('#research-mode').selectOption('skill'); await page.locator('#skill-loading').selectOption('file');
        assert.equal(await page.locator('#workers').inputValue(), '1'); assert.equal(await page.locator('#workers').isDisabled(), true);
        assert.equal(await page.locator('input[name="coordination"]:checked').inputValue(), 'independent');
        assert.equal(await page.locator('[data-settings-section="module-plan"]').isVisible(), false);
        assert.equal(await page.locator('.plan-approval-option').isVisible(), false);
      });
      await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('theorem-os.web-draft.v1') ?? '{}').draft?.skillLoading === 'file');
      await page.reload(); await ready(page); await enterLean(page);
      assert.equal(await page.locator('#research-mode').inputValue(), 'skill'); assert.equal(await page.locator('#skill-loading').inputValue(), 'file');
      await showArtifacts(page); await page.locator('[data-draft-view="modules"]').click();
      await page.locator('.module-skill-mode').waitFor(); assert.equal(await page.locator('.module-layout').isVisible(), false);
      await withSettings(page, () => page.locator('#research-mode').selectOption('legacy'));
      await showArtifacts(page); await page.locator('.module-layout').waitFor();
      await withSettings(page, async () => {
        assert.equal(await page.locator('#workers').isDisabled(), false);
        await page.locator('#research-mode').selectOption('skill'); await page.locator('#model').fill('offline-fixture');
        await page.locator('#api-key').fill(credential); await page.locator('#max-turns').fill('2'); await page.locator('#max-seconds').fill('60');
      });
      await showArtifacts(page); await page.locator('.module-skill-mode').waitFor();
      assert.equal(await page.locator('.module-layout').isVisible(), false);
      await showChat(page);
      const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'POST');
      await page.locator('#submit-run').click(); const response = await created; assert.equal(response.status(), 201);
      const runId = (await response.json()).run.id;
      await page.waitForFunction(async id => Boolean((await (await fetch(`/api/runs/${id}`)).json()).run.researchSkill), runId);
      const received = actual.find(item => item.id === runId)!;
      assert.ok(received, `Fixture worker for ${runId} was not started; observed ids: ${actual.map(item => item.id).join(', ')}`);
      assert.equal(received.input.researchMode, 'skill'); assert.equal(received.input.skillLoading, 'file'); assert.equal(received.input.workers, 1);
      assert.equal(received.input.modulePlan, undefined);
      await selectHistoryRun(page, runId, 'collaboration');
      assert.equal(await page.locator('[data-collab-nav-guide]').isVisible(), false);
      assert.equal(await page.locator('[data-collab-plan]').isVisible(), false);
      assert.equal(await page.locator('.collab-guidance').isVisible(), false);
      assert.equal(await page.locator('[data-collab-jump="guidance"]').isVisible(), false);
      const records = page.locator('[data-independent-declarations]'); await records.waitFor();
      assert.match(await records.innerText(), /Research\.reusable/); assert.match(await records.innerText(), /∀ \(n : Nat\), Eq n n/);
      const declaration = records.locator('[data-independent-declaration]'); await declaration.locator('details').first().locator('summary').click();
      assert.match(await declaration.innerText(), /parameter is arbitrary/); assert.equal(await page.locator('[data-skill-injection]').count(), 0);
      await declaration.locator('details').last().locator('summary').click(); assert.match(await declaration.innerText(), /offline-browser-receipt/);
      assert.match(await records.innerText(), language === 'zh' ? /重新检查.*原题.*单独验收/u : /fresh check.*original problem.*separately/u);
      const stored = await page.evaluate(async id => (await (await fetch(`/api/runs/${id}`)).json()).run, runId);
      assert.equal(stored.result, undefined); assert.deepEqual(stored.observation.inspection.tasks, []);
      const archiveStatus = await page.evaluate(async id => {
        const session = await (await fetch('/api/session')).json();
        return (await fetch(`/api/runs/${id}/archive`, { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken } })).status;
      }, runId);
      assert.equal(archiveStatus, 200, 'Skill records remain available for capture and archival.');
      await settled(page); const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth);
      assert.ok(overflow <= 1, `Horizontal overflow: ${overflow}`);
      await page.screenshot({ path: path.join(output, `skill-records-${language}-${width}.png`), fullPage: true });
    }, { context: { viewport: { width, height: 940 }, reducedMotion: 'reduce', locale: language === 'zh' ? 'zh-CN' : 'en-US' },
      init: context => context.addInitScript(({ key, language }) => localStorage.setItem(key, language), { key: localeStorageKey, language }),
      harness: (page, context) => ({ page, context, requests: [] }), routes: { local: 'This scenario must not contact a provider.' },
      collaborationDetail: 'simple', open: true, failure: { prefix: 'skill-', fullPage: true } });
  }
} catch (error) { failure = error; }
finally {
  await writeScenarioReport(path.join(output, 'report.json'), suite, failure ? 'failed' : 'passed', failure,
    'disposable HTTP service and browser; synthetic presentation records', { checks, workerStarts: actual.length,
      actualLeanChecks: 0, modelCalls: 0 }, { credential });
  await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
