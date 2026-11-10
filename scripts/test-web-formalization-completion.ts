#!/usr/bin/env bun
// Formalization-only local HTTP/browser regression. Workers and compilation receipts are controlled fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebFormalization, WorkerFormalizationInput, WorkerFormalizationMessage } from '../apps/web/formalizationTypes';
import { localeStorageKey } from '../apps/web/i18n';
import { formalizationCompiledCandidate } from '../src/math/formalization';
import { webFormalizationEvidence, webFormalizationStatement } from '../tests/helpers/webFormalizationFixture';
import { deferred, freePort, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-formalization-completion'));
await fs.access(path.join(root, 'out/web/formalize.js'));
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-formalization-completion-'));
type Formalizer = { input: WorkerFormalizationInput; send(message: WorkerFormalizationMessage): void; resolve(): void };
const formalizers: Formalizer[] = [];
let proofCalls = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local formalization completion fixture' }; },
  async run() { proofCalls++; throw new Error('Formalization-only test must never start proof work'); },
  formalize(input, send, signal) {
    const held = deferred();
    formalizers.push({ input: structuredClone(input), send, resolve: held.resolve });
    signal.addEventListener('abort', held.resolve, { once: true });
    return held.promise;
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: path.join(temporary, 'data') });
config.providers = [{ id: 'sub2api', name: 'Local fixture', baseUrl: 'http://127.0.0.1:1/v1' }];
const service = createWebService(config, runner, { sample: null });
const checks: string[] = [], errors: string[] = [], external: string[] = [], requests: string[] = [];
let browser: Browser | undefined, activePage: Page | undefined;
function mark(name: string) { checks.push(name); console.log(`PASS ${name}`); }
async function eventually(check: () => boolean) {
  while (!check()) await new Promise(resolve => setTimeout(resolve, 20));
}
async function read(page: Page, id: string): Promise<WebFormalization> {
  return page.evaluate(async id => (await (await fetch(`/api/formalizations/${id}`)).json()).formalization, id);
}
async function submit(page: Page) {
  await page.locator('#formalize-original').fill(webFormalizationStatement);
  await page.locator('#formalize-environment').selectOption('standard');
  await page.locator('#formalize-key').fill('sk-local-formalization-only-fixture');
  assert.match(await page.locator('#formalize-budget').innerText(), /时间：不限.*Token：不限/u);
  const index = formalizers.length;
  await page.locator('#formalize-start:enabled').click();
  await eventually(() => formalizers.length > index);
  const pending = formalizers[index];
  assert.equal(pending.input.maxRunSeconds, 0); assert.equal(pending.input.maxTotalTokens, 0);
  assert.equal(pending.input.maxRounds, 0); assert.equal(pending.input.maxPlanningRounds, 0);
  return pending;
}
async function screenshot(page: Page, name: string) {
  await page.locator('#formalize-current').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, name), fullPage: true, timeout: 0 });
}
async function approve(page: Page, pending: Formalizer) {
  const evidence = webFormalizationEvidence(pending.input);
  pending.send({ type: 'result', status: 'approved', evidence }); pending.resolve();
  await page.waitForFunction(() => !document.querySelector('#formalize-review')?.hasAttribute('hidden')
    && /待你确认/u.test(document.querySelector('#formalize-progress')?.textContent ?? ''), undefined, { timeout: 0 });
  const record = await read(page, pending.input.id);
  assert.equal(record.status, 'review'); assert.equal(record.workflow, undefined); assert.equal(record.runId, undefined);
  assert.equal(record.report?.statement, evidence.candidate.source);
  if (pending.input.reviewMode === 'direct') {
    assert.equal(record.report?.reviews.length, 0);
    assert.equal(record.report?.semanticReview, 'not-performed');
  } else {
    assert.equal(record.report?.reviews.length, 2);
    assert.ok(record.report!.reviews.every(review => review.verdict === 'approved'));
  }
  assert.equal(await page.locator('#formalize-actions [data-action="cancel"]').count(), 0);
  assert.equal(proofCalls, 0);
}
try {
  browser = await startBrowser(service.server, port);
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    await context.route(/^https?:\/\//u, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
      if (url.pathname.startsWith('/api/')) requests.push(`${request.method()} ${url.pathname}`);
      if (url.pathname === '/api/formalizations' && request.method() === 'POST')
        assert.notEqual(request.postDataJSON().solve, true);
      await route.continue();
    });
    const page = activePage = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/formalize.html`);
    const pending = await submit(page), evidence = webFormalizationEvidence(pending.input);
    pending.send({ type: 'compiled', candidate: formalizationCompiledCandidate(evidence) });
    pending.send({ type: 'progress', progress: { phase: pending.input.reviewMode === 'direct' ? 'compiling' : 'reviewing', round: 1 } });
    await page.locator('#formalize-compiled').waitFor();
    assert.equal(await page.locator('#formalize-compiled pre').textContent(), evidence.candidate.source);
    assert.equal(proofCalls, 0);
    await screenshot(page, `compiled-reviewing-${width}.png`);
    mark(`${width}px: compiled statement remains available before report settlement without starting proof`);

    await approve(page, pending);
    await screenshot(page, `formalization-ready-${width}.png`);
    mark(`${width}px: completed formalization report reflects its actual review mode`);
    await page.reload();
    await page.locator('#formalize-review').waitFor();
    assert.equal((await read(page, pending.input.id)).status, 'review');
    assert.equal(formalizers.length, width === 1440 ? 1 : 3, 'Reload never resubmits the formalization');
    await page.locator('#formalize-checked').check();
    await page.locator('#formalize-confirm:enabled').click();
    await page.locator('#formalize-confirmed').waitFor();
    assert.equal((await read(page, pending.input.id)).status, 'confirmed');
    assert.equal((await read(page, pending.input.id)).runId, undefined);
    assert.equal(proofCalls, 0);
    await screenshot(page, `confirmed-no-proof-${width}.png`);
    mark(`${width}px: reload preserves the report and manual confirmation still starts no proof`);

    const next = await submit(page);
    assert.notEqual(next.input.id, pending.input.id);
    await approve(page, next);
    assert.equal(proofCalls, 0);
    mark(`${width}px: completion releases its execution slot so the next formalization also finishes`);
    await context.close(); activePage = undefined;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(proofCalls, 0);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(),
    mode: 'formalization-only-controlled-local-workers', timeLimit: null, tokenLimit: null, roundLimit: null,
    paidModelCalls: false, leanCompilationPerformed: false, proofTasksStarted: proofCalls, checks, requests, errors }, null, 2) + '\n');
  console.log(`PASS formalization-only browser checks: ${checks.length}`);
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 0 }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', checkedAt: new Date().toISOString(),
    mode: 'formalization-only-controlled-local-workers', paidModelCalls: false, proofTasksStarted: proofCalls,
    checks, requests, errors, error: error instanceof Error ? error.stack : String(error) }, null, 2) + '\n');
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close(); await service.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
