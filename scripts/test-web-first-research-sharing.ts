#!/usr/bin/env bun
// Disposable loopback service, synthetic accepted evidence and intercepted model-list/submission requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { explanationKey } from '../apps/web/explanations';
import { localeStorageKey } from '../apps/web/i18n';
import { createWebService } from '../apps/web/server';
import { shareSnapshot } from '../apps/web/share';
import type { WebShareSnapshot } from '../apps/web/shareTypes';
import type { WebRunner } from '../apps/web/runner';
import type { WebExplanation, WebSession } from '../apps/web/shared';
import { readingCommit, readingEvidence, readingRun } from '../tests/helpers/shareReadingFixture';
import { audit } from './web-a11y';
import { freePort, postRun, startBrowser, waitForRun } from './web-scenario';
import { openChatBudget, openChatParticipation } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/first-research-sharing');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.access(path.join(staticRoot, 'share.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-reading-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const credential = 'sk-disposable-first-reading';
const checks: object[] = [], failures: object[] = [], errors: string[] = [], external: string[] = [];
const runtimeCalls = { run: 0, formalize: 0, check: 0, explain: 0 };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable reader fixture' }; },
  async run(input, send) {
    runtimeCalls.run++;
    assert.equal(input.input.task, readingRun().task);
    const run = readingRun(input.id);
    send({ type: 'observation', observation: run.observation! });
    send({ type: 'result', result: run.result! });
  },
  async formalize() { runtimeCalls.formalize++; throw new Error('No real formalization is permitted in this fixture'); },
  async check() { runtimeCalls.check++; throw new Error('No Lean process is permitted in this fixture'); },
  async explain() { runtimeCalls.explain++; throw new Error('Explanations are seeded synthetic evidence'); },
};
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_PROVIDERS: JSON.stringify([{ id: 'fixture-a', name: 'Fixture A', baseUrl: 'https://fixture-a.invalid/v1' },
    { id: 'fixture-b', name: 'Fixture B', baseUrl: 'https://fixture-b.invalid/v1' }]) });
const service = createWebService(config, runner, { sample: null });
const browser = await startBrowser(service.server, port);

async function scenario(name: string, language: 'zh' | 'en', width: number,
  run: (page: Page, context: BrowserContext) => Promise<object>) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' });
  await context.addInitScript(({ key, value }) => { localStorage.setItem(key, value); }, { key: localeStorageKey, value: language });
  await context.route(/^https?:\/\//u, async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
    await route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', error => errors.push(`${name}: ${error.stack || error.message}`));
  try {
    checks.push({ name, language, width, ...await run(page, context) });
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message : String(error), url: page.url() });
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true }).catch(() => {});
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally { await context.close(); }
}
const noOverflow = async (page: Page) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page must fit its viewport');
async function publicSnapshot(page: Page, snapshot: WebShareSnapshot, token: string) {
  await page.route(`**/api/share/${token}`, route => route.fulfill({ json: { share: snapshot } }));
  await page.goto(`${origin}/share.html#${token}`);
  await page.locator('#share-content:not([hidden])').waitFor();
}
let publicShare: { token: string; url: string; owner: string; runId: string; snapshot: WebShareSnapshot };
try {
  for (const [language, width, participation] of [['zh', 1440, 'guided'], ['zh', 390, 'automatic'],
    ['en', 1440, 'automatic'], ['en', 320, 'guided']] as const) {
    await scenario(`first-${language}-${width}-${participation}`, language, width, async page => {
      const submissions: Record<string, unknown>[] = [], connectionChecks: Record<string, unknown>[] = [], writes: string[] = [];
      let connection: 'available' | 'unknown' | 'error' = 'available';
      await page.route('**/api/**', async route => {
        const request = route.request(), pathname = new URL(request.url()).pathname;
        if (pathname === '/api/session' && request.method() === 'GET') {
          const response = await route.fetch(), session = await response.json() as WebSession;
          session.quota = { windowHours: 24, windowEndsAt: '2026-11-11T00:00:00.000Z',
            formalizations: { limit: 5, used: 2 }, runs: { limit: 5, used: 1 }, explanations: { limit: 1, used: 0 } };
          await route.fulfill({ response, json: session }); return;
        }
        if (/^\/api\/providers\/[^/]+\/check$/u.test(pathname)) {
          connectionChecks.push(request.postDataJSON());
          await route.fulfill({ json: { status: connection, message: `Fixture model-list result: ${connection}` } }); return;
        }
        if (request.method() !== 'GET') {
          writes.push(pathname);
          if (pathname === '/api/formalizations') submissions.push(request.postDataJSON());
          await route.fulfill({ status: 422, json: { error: 'The submission was captured without starting a worker.' } }); return;
        }
        await route.continue();
      });
      await page.goto(origin); await page.locator('[data-first-research-start]').waitFor();
      assert.equal(await page.locator('#formalize-start').isDisabled(), true);
      assert.equal(await page.locator('#formalize-settings[open]').count(), 0);
      assert.equal(await page.locator('[data-first-research-more][open]').count(), 0);
      await openChatBudget(page);
      assert.match(await page.locator('[data-chat-budget]').innerText(), language === 'zh' ? /不限/u : /Unlimited/u);
      assert.doesNotMatch(await page.locator('[data-chat-budget]').innerText(), /(?:0 Token|0 min|0 分钟)/u);
      assert.match(await page.locator('[data-first-research-quota]').innerText(), /3[\s\S]*4/u);
      await page.locator('[data-first-research-more] > summary').click();
      await noOverflow(page);
      await page.locator('#formalize-settings > summary').click();
      await page.locator('#formalize-key').fill(credential);
      await page.locator('#formalize-provider').selectOption('fixture-b');
      assert.equal(await page.locator('#formalize-key').inputValue(), '', 'Changing provider clears a provider-specific key');
      await page.locator('#formalize-key').fill(credential);
      await page.locator('#formalize-model').fill('fixture-model');
      for (const status of ['available', 'unknown', 'error'] as const) {
        connection = status; await page.locator('#check-model-connection').click();
        await page.locator(`#chat-connection-result[data-status=${status}]`).waitFor();
        assert.match(await page.locator('#formalize-settings > summary').getAttribute('aria-label') ?? '', {
          available: /模型列表可访问|Model list accessible/u, unknown: /仍需核对|Needs confirmation/u,
          error: /连接需处理|Connection needs attention/u,
        }[status]);
      }
      assert.equal(connectionChecks.length, 3);
      assert.equal(connectionChecks[0]!.apiKey, credential); assert.equal(connectionChecks[0]!.model, 'fixture-model');
      await page.locator('#formalize-model').fill('fixture-model-v2');
      assert.equal(await page.locator('#chat-connection-result').count(), 0, 'Editing the model invalidates the check');
      await page.locator('#formalize-settings > summary').click();
      await openChatBudget(page);
      await page.locator('[data-first-budget=trial]').click();
      assert.equal(await page.locator('#formalize-minutes').inputValue(), '');
      assert.equal(await page.locator('#research-minutes').inputValue(), '');
      assert.equal(await page.locator('#research-turns').inputValue(), '3');
      assert.equal(await page.locator('#formalize-tokens').inputValue(), '');
      assert.equal(await page.locator('#research-tokens').inputValue(), '');
      await page.locator('[data-first-budget=standard]').click();
      assert.equal(await page.locator('#formalize-minutes').inputValue(), '');
      assert.equal(await page.locator('#research-minutes').inputValue(), '');
      assert.equal(await page.locator('#research-turns').inputValue(), '5');
      assert.equal(await page.locator('#formalize-tokens').inputValue(), '');
      assert.equal(await page.locator('#research-tokens').inputValue(), '');
      await page.locator('[data-first-budget=trial]').click();
      await openChatParticipation(page);
      await page.locator(`input[name=chat-participation][value=${participation}]`).check();
      await openChatBudget(page);
      assert.match(await page.locator('[data-first-research-stages]').innerText(), participation === 'guided'
        ? language === 'zh' ? /你确认题意[\s\S]*你批准/u : /your statement review[\s\S]*your approval/u
        : language === 'zh' ? /自动开始证明/u : /automatically/u);
      await page.locator('#formalize-original').fill('Prove $n+0=n$ for every natural number $n$.');
      assert.equal(await page.locator('#formalize-start').isEnabled(), true, 'Model-list checks are optional');
      assert.match(await page.locator('#formalize-start').innerText(), participation === 'guided'
        ? language === 'zh' ? /开始核对题目/u : /Start statement review/u : language === 'zh' ? /开始解题/u : /Start solving/u);
      await noOverflow(page); assert.deepEqual(await audit(page), []);
      await page.screenshot({ path: path.join(output, `first-${language}-${width}-${participation}-prepared.png`), fullPage: true });
      assert.deepEqual(writes, [], 'Setup, checks and presets do not start work');
      await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/formalizations'),
        page.locator('#formalize-start').click()]);
      assert.equal(submissions.length, 1);
      const payload = submissions[0]!;
      assert.equal(payload.solve, true); assert.equal(payload.humanReview, participation === 'guided' ? true : undefined);
      assert.equal(payload.providerId, 'fixture-b'); assert.equal(payload.model, 'fixture-model-v2');
      assert.equal(payload.maxRunSeconds, 0); assert.equal(payload.maxTotalTokens, 0);
      assert.deepEqual(payload.research, { maxRunSeconds: 0, maxTotalTokens: 0, maxTurns: 3 });
      assert.equal(await page.locator('#formalize-original').inputValue(), payload.original);
      return { participation, capturedSubmissions: submissions.length, connectionStates: ['available', 'unknown', 'error'],
        setupOnlyUntilSubmit: true, exactBudgets: true, rejectedDraftKept: true };
    });
  }

  await scenario('share-service-projection', 'zh', 1440, async (page, context) => {
    await page.goto(origin); await page.locator('#formalize-original').waitFor();
    const fixture = readingRun();
    const created = await postRun({ page }, { providerId: 'fixture-a', apiKey: credential, model: 'fixture-model',
      effort: 'max', environment: 'standard', source: fixture.source, task: fixture.task,
      maxTurns: 3, maxRunSeconds: 120, workers: 1, coordination: 'independent' });
    const accepted = await waitForRun({ page }, created.id, run => run.status === 'completed');
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const now = new Date().toISOString();
    for (const language of ['zh', 'en'] as const) {
      const key = explanationKey('reading_target', language);
      const record: WebExplanation = { id: crypto.randomUUID(), runId: accepted.id, target: 'reading_target', language,
        status: 'approved', model: 'PRIVATE-EXPLANATION-MODEL', effort: 'max', maxRunSeconds: 120, maxTotalTokens: 10000,
        createdAt: now, updatedAt: now, finishedAt: now };
      service.storage.saveExplanation(owner, key, record);
      service.storage.saveExplanationEvidence(owner, accepted.id, key, readingEvidence(language));
    }
    // A record labelled approved with missing evidence must not become a public explanation.
    service.storage.saveExplanation(owner, explanationKey('missing_target', 'zh'), {
      id: crypto.randomUUID(), runId: accepted.id, target: 'missing_target', language: 'zh', status: 'approved',
      model: 'PRIVATE-MISSING-DOCUMENT', effort: 'max', maxRunSeconds: 120, maxTotalTokens: 10000, createdAt: now, updatedAt: now });
    const link = await page.evaluate(async runId => {
      const session = await (await fetch('/api/session')).json();
      const response = await fetch(`/api/runs/${runId}/share`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: '{}' });
      if (response.status !== 201) throw new Error(`Share creation returned ${response.status}`);
      return (await response.json()).share as { token: string; url: string };
    }, accepted.id);
    const response = await context.request.get(`${origin}/api/share/${link.token}`);
    assert.equal(response.status(), 200);
    const snapshot = (await response.json()).share as WebShareSnapshot;
    assert.equal(snapshot.reading!.explanations.length, 2);
    assert.equal(snapshot.reading!.tasks[1]!.dependencies[0], 'normalization');
    assert.equal(snapshot.reading!.tasks[0]!.source?.commit, readingCommit);
    for (const secret of [credential, accepted.id, 'PRIVATE-', '/home/private']) assert.equal(JSON.stringify(snapshot).includes(secret), false);
    service.jobs.get(owner, accepted.id)!.observation!.inspection.tasks[0]!.informalProof = 'Changed after sharing';
    const reread = await (await context.request.get(`${origin}/api/share/${link.token}`)).json();
    assert.deepEqual(reread.share, snapshot, 'Sharing freezes its reading material at creation');
    publicShare = { ...link, owner, runId: accepted.id, snapshot };
    return { approvedEvidenceReverified: true, frozenSnapshot: true, privateMetadataExcluded: true };
  });
  assert.ok(publicShare!, 'Share fixture was created');

  for (const [language, width] of [['zh', 1440], ['en', 390], ['en', 320]] as const) {
    await scenario(`shared-reader-${language}-${width}`, language, width, async (page, context) => {
      const requests: string[] = []; page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(new URL(request.url()).pathname);
      });
      await page.goto(publicShare.url); await page.locator('[data-share-reading]').waitFor();
      assert.equal(await page.locator('.share-reading-prose').getAttribute('lang'), language);
      assert.equal(await page.locator('[data-share-derivation]').count(), 2);
      assert.ok(await page.locator('#share-title .katex').count() > 0, 'Mathematical titles must render their formulas');
      assert.ok(await page.locator('.share-reading .katex').count() > 0, 'Mathematics must render with KaTeX');
      assert.equal(await page.locator('.share-reading .katex-error').count(), 0);
      assert.match(await page.locator('.share-reading-prose').innerText(), language === 'zh' ? /用前一步/u : /Rewrite with the previous equality/u);
      await page.locator('[data-share-derivation="1:0"] > details > summary').click();
      assert.match(await page.locator('[data-share-derivation="1:0"] details').innerText(), /⊢ duplicate n = n \+ n/u);
      assert.match(await page.locator('[data-share-derivation="1:0"] details').innerText(), /rfl/u);
      await page.locator('[data-share-derivation="1:0"] > details > summary').click();
      const hash = new URL(page.url()).hash;
      await page.locator('[data-share-jump=share-reading-heading]').click();
      assert.equal(new URL(page.url()).hash, hash);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'share-reading-heading');
      await page.locator('[data-share-reading-view=route]').click();
      const node = page.locator('[data-solution-node]').first(); await node.waitFor();
      await node.focus(); await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('[data-solution-node][aria-pressed=true]').getAttribute('data-solution-node') === await node.getAttribute('data-solution-node'), false);
      const expandAll = page.locator('[data-solution-all]');
      if (await expandAll.getAttribute('aria-pressed') === 'true') await expandAll.click();
      await expandAll.click();
      await page.locator('[data-solution-node="derivation:reading_target:0"]').click();
      await page.locator('[data-solution-details="evidence:derivation:reading_target:0"] > summary').click();
      assert.match(await page.locator('[data-solution-inspector]').innerText(), /rw \[duplicate_eq\]/u);
      await page.locator('[data-solution-zoom=in]').click();
      assert.match(await page.locator('[data-solution-zoom=reset]').innerText(), /110%/u);
      await page.locator('[data-solution-expand]').click();
      assert.equal(await page.locator('.solution-route[role=dialog]').count(), 1);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.solution-route[role=dialog]').count(), 0);
      await noOverflow(page); assert.deepEqual(await audit(page), []);
      await page.screenshot({ path: path.join(output, `shared-reader-${language}-${width}-route.png`), fullPage: true });
      await page.locator('[data-solution-open="derivation:reading_target:0"]').click();
      await page.waitForFunction(() => document.activeElement?.id === 'share-derivation-2-0');
      assert.equal(await page.locator('[data-share-reading-view=reading]').getAttribute('aria-pressed'), 'true');
      assert.equal(new URL(page.url()).hash, hash, 'Opening a route step preserves the share token');
      const other = language === 'zh' ? 'en' : 'zh';
      await page.locator('[data-share-explanation]').selectOption({ index: other === 'zh' ? 0 : 1 });
      assert.equal(await page.locator('.share-reading-prose').getAttribute('lang'), other);
      assert.equal(new URL(page.url()).hash, hash, 'Reading navigation preserves the share token');
      await page.locator('[data-share-explanation]').selectOption({ index: language === 'zh' ? 0 : 1 });
      await noOverflow(page); assert.deepEqual(await audit(page), []);
      assert.deepEqual(await context.cookies(), [], 'Public readers receive no session');
      assert.deepEqual(requests, [`/api/share/${publicShare.token}`]);
      return { mathematicalSteps: 2, renderedMath: true, goalSourceToggle: true, keyboardRoute: true,
        languageSelection: true, anonymousReadOnly: true, tokenPreserved: true };
    });
  }
  for (const [language, width, legacy] of [['zh', 390, false], ['en', 320, true]] as const) {
    await scenario(`shared-${legacy ? 'legacy' : 'recorded'}-${language}-${width}`, language, width, async page => {
      const snapshot = shareSnapshot(readingRun())!;
      if (legacy) delete snapshot.reading;
      await publicSnapshot(page, snapshot, legacy ? 'L'.repeat(32) : 'R'.repeat(32));
      if (legacy) assert.match(await page.locator('[data-share-reading]').innerText(), /no recorded step-by-step explanation/u);
      else {
        assert.equal(await page.locator('.share-recorded-tasks > li').count(), 2);
        await page.locator('.share-recorded-tasks > li').last().locator('button').click();
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'share-task-0');
        await page.locator('.share-recorded-tasks > li').first().locator('details > summary').click();
        assert.match(await page.locator('.share-recorded-tasks > li').first().innerText(), new RegExp(readingCommit, 'u'));
      }
      await page.locator('[data-share-reading-view=route]').click();
      await page.locator(`[data-solution-node="${legacy ? 'declaration:reading_target' : 'task:conclusion'}"]`).click();
      assert.match(await page.locator('[data-solution-inspector]').innerText(), legacy ? /rw \[duplicate_eq\]/u : /normalization/u);
      await noOverflow(page); assert.deepEqual(await audit(page), []);
      return { legacy, explicitMissingExplanation: legacy, recordedDependencies: !legacy, sourceFallback: legacy };
    });
  }
  service.storage.deleteShare(publicShare.owner, publicShare.runId);
  await scenario('shared-reader-revoked', 'zh', 390, async page => {
    await page.goto(publicShare.url); await page.locator('#share-missing:not([hidden])').waitFor();
    assert.equal(await page.locator('#share-content').isHidden(), true);
    return { revokedImmediately: true };
  });
  assert.deepEqual(runtimeCalls, { run: 1, formalize: 0, check: 0, explain: 0 });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) {
  failures.push({ name: 'fixture-or-invariant', message: error instanceof Error ? error.stack : String(error) });
} finally {
  const report = { status: failures.length ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    mode: 'isolated loopback browser and synthetic evidence', paidModelCalls: false, leanProcesses: false,
    checks, failures, errors, external, runtimeCalls };
  assert.equal(JSON.stringify(report).includes(credential), false);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failures.length) throw new Error(`${failures.length} first research / sharing checks failed; see ${output}/report.json`);
console.log(`First research / sharing checks passed: ${checks.length}; report ${output}/report.json`);
