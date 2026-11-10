#!/usr/bin/env bun
// Recorded local HTTP fixtures only. No model, Lean, email or production account access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { loadWebSample } from '../apps/web/sample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { localeStorageKey } from '../apps/web/i18n';
import type { WebRunner } from '../apps/web/runner';
import type { WebRun } from '../apps/web/shared';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/product-continuity/research-depth/budget-history');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-depth-ui-'));
const sample = loadWebSample()!, port = await freePort(), origin = `http://127.0.0.1:${port}`;
let fixtureRuns = 0, prohibited = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable recorded fixture' }; },
  async run(input, send) {
    fixtureRuns++;
    for (const sequence of [1, 2]) {
      const observation = structuredClone(sample.observations.at(-1)!); observation.webRunId = input.id; observation.sequence = sequence;
      observation.snapshot.stateDigest = mathDigest(`${input.id}:${sequence}`); observation.inspection.usage = {};
      observation.inspection.edits = []; observation.guidance = [];
      const task = observation.inspection.tasks[0]; task.version = `depth-task-${sequence}`;
      task.informalStatement = 'For every natural number $n$, $n+0=n$.';
      task.informalProof = sequence === 1 ? 'archived-depth-marker: unfold $n+0$ to obtain $n$; then use reflexivity.'
        : 'current-depth-marker: use the preceding reduction and close the equality.';
      task.proof.commit = String(sequence).repeat(40);
      const source = `theorem depth_${sequence} : True := by trivial`;
      task.proof.sourceDigest = mathDigest(source); observation.inspection.configuration.environmentDigest = 'e'.repeat(64);
      observation.sources = [{ taskId: task.id, taskVersion: task.version, commit: task.proof.commit, sourceDigest: mathDigest(source),
        environmentDigest: 'e'.repeat(64), file: 'Depth.lean', source, scope: 'owned-file' }];
      observation.checks = [{ id: `depth-check-${sequence}`, taskId: task.id, taskVersion: task.version, commit: task.proof.commit,
        sourceDigest: mathDigest(source), environmentDigest: 'e'.repeat(64), record: { passed: sequence === 2, diagnostic: `depth-diagnostic-${sequence}` } }];
      send({ type: 'observation', observation });
    }
    send({ type: 'result', result: { status: 'limit_reached', proof: '', report: { usage: { totalTokens: 1200 } } } });
  },
  async check() { prohibited++; throw new Error('No Lean in this fixture'); },
  async formalize() { prohibited++; throw new Error('No model in this fixture'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner,
{ mailer: async () => { prohibited++; throw new Error('No mail in this fixture'); } });
const browser = await startBrowser(service.server, port), errors: string[] = [], external: string[] = [], checks: object[] = [];
let phase = 'setup', active: Page | undefined, failure: unknown;
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    phase = `setup-${language}`;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ key, language }) => localStorage.setItem(key, language), { key: localeStorageKey, language });
    await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/workspace.html?tab=search'); await page.locator('#workspace-query').waitFor();
    const owner = (await context.cookies(origin)).find(item => item.name === 'theoremos_session')!.value;
    const session = await page.evaluate(async () => (await fetch('/api/session')).json()), provider = session.providers[0];
    const created = ['Earlier depth attempt', 'Current depth attempt'].map(task => service.jobs.create(owner, { providerId: provider.id, apiKey: 'sk-fixture-never-sent',
      model: 'depth-fixture-model', effort: 'high', environment: sample.run.environment, source: sample.run.source.trim(), task,
      maxTurns: 2, maxRunSeconds: 60, maxTotalTokens: 10000, workers: 2, coordination: 'cooperative' }, provider));
    await page.waitForFunction(async () => { const { runs } = await (await fetch('/api/runs')).json(); return runs.length === 2 && runs.every((item: WebRun) => item.status === 'completed'); });

    phase = `history-${language}`;
    await page.locator('#workspace-query').fill('archived-depth-marker'); await page.locator('.workspace-search button').click();
    await page.locator('.workspace-filters button').filter({ hasText: language === 'zh' ? '历史推导与检查' : 'Historical reasoning and checks' }).click();
    await page.locator('.workspace-result h3 a').first().click(); await page.locator('[data-research-history]').waitFor();
    assert.match(await page.locator('[data-research-history]').innerText(), /archived-depth-marker/);
    assert.match(await page.locator('[data-history-source]').innerText(), /depth_1/);
    assert.doesNotMatch(await page.locator('[data-history-source]').innerText(), /depth_2/);
    await page.waitForFunction(() => Boolean(document.querySelector('[data-research-history] .katex')));
    await page.reload(); await page.locator('[data-history-source]').waitFor();
    await page.screenshot({ path: path.join(output, `historical-source-${language}.png`), fullPage: true });
    await page.goto(origin + '/workspace.html?tab=search&kind=history&q=depth-diagnostic-1');
    await page.locator('.workspace-result h3 a').first().click(); await page.locator('[data-history-check]').waitFor();
    assert.match(await page.locator('[data-history-check]').innerText(), /depth-diagnostic-1/);

    phase = `budget-${language}`;
    await page.evaluate(async ({ providerId }) => {
      const session = await (await fetch('/api/session')).json();
      const response = await fetch('/api/research/workspace/rates', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ requestId: crypto.randomUUID(), providerId, model: 'depth-fixture-model', currency: 'CNY', perMillion: 10 }) });
      if (!response.ok) throw new Error(await response.text());
    }, { providerId: provider.id });
    await page.goto(`${origin}/problem.html?run=${created[1].id}&tab=outcomes`);
    await page.locator('[data-problem-budget-facts]').waitFor();
    assert.match(await page.locator('[data-problem-budget-facts]').innerText(), /2,400|2\.4k|2400/);
    await page.locator('[data-budget-editor] summary').click(); await page.locator('[data-budget-token-limit]').fill('150000');
    await page.locator('[data-budget-amount]').fill('2'); await page.locator('[data-save-problem-budget]').click();
    await page.waitForFunction(async runId => (await (await fetch(`/api/research/workspace/problem/${runId}/budget`)).json()).item.plan.revision === 1, created[1].id);
    await page.locator('[data-budget-next-tokens]').fill('100000'); await page.locator('[data-budget-forecast]').waitFor();
    assert.match(await page.locator('[data-budget-forecast]').innerText(), /1\.0000/);
    await page.screenshot({ path: path.join(output, `problem-budget-${language}.png`), fullPage: true });

    // Prepare an existing unsent draft so the budget action must retain a reversible copy.
    await page.goto(origin + '/?entry=lean&template=polynomial&environment=mathlib');
    await page.locator('#task').waitFor({ state: 'attached' });
    await page.waitForFunction(() => !(document.querySelector('#composer-settings') as HTMLButtonElement)?.disabled && !document.body.dataset.connecting);
    await page.locator('#proof-instructions summary').click(); await page.locator('#task').fill('Unsent work to preserve');
    await page.locator('#task').blur();
    await page.waitForFunction(() => document.querySelector('#draft-status')?.textContent?.includes('草稿已存') || document.querySelector('#draft-status')?.textContent?.includes('Draft saved'));
    await page.goto(`${origin}/problem.html?run=${created[1].id}&tab=outcomes`); await page.locator('[data-prepare-budget-attempt]').click();
    await page.locator('[data-budget-attempt-ready=true]').waitFor();
    assert.equal(await page.locator('#source').inputValue(), sample.run.source.trim()); assert.equal(await page.locator('#max-tokens').inputValue(), '10');
    assert.equal(await page.locator('#api-key').inputValue(), ''); assert.equal(fixtureRuns, checks.length * 2 + 2);
    if (await page.locator('#run-settings').evaluate((element: HTMLDialogElement) => element.open)) await page.locator('#close-settings').click();
    await page.locator('[data-research-budget-draft] [data-budget-forecast]').waitFor();
    const forecast = page.locator('[data-research-budget-draft]'); assert.match(await forecast.innerText(), /CNY 1\.0000/);
    await page.reload(); await page.locator('[data-research-budget-draft] [data-budget-forecast]').waitFor();
    assert.equal(await page.locator('#max-tokens').inputValue(), '10');
    await page.screenshot({ path: path.join(output, `prepared-budget-${language}.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.locator('#restore-draft').click();
    assert.equal(await page.locator('#task').inputValue(), 'Unsent work to preserve');
    assert.equal(fixtureRuns, checks.length * 2 + 2);
    checks.push({ language, width, history: true, preciseSource: true, checkDiagnostics: true, budget: true, prepareAndReload: true, draftRecovery: true });
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0);
} catch (error) {
  failure = error;
  await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.html'), await active?.content().catch(() => '') ?? '');
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, phase, fixtureRuns, prohibited, errors, external, failure: failure instanceof Error ? failure.stack : failure }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(JSON.stringify({ checks: checks.length, fixtureRuns, prohibited, errors: errors.length, external: external.length, output }));
