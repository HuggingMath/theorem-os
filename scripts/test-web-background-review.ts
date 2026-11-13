#!/usr/bin/env bun
// Disposable local HTTP service and controlled workers. No model calls or Lean acceptance is performed here.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WorkerFormalizationInput, WorkerFormalizationMessage } from '../apps/web/formalizationTypes';
import type { WebRun, WorkerInput, WorkerMessage } from '../apps/web/shared';
import { formalizationCompiledCandidate } from '../src/math/formalization';
import { webFormalizationEvidence, webFormalizationStatement } from '../tests/helpers/webFormalizationFixture';
import { localeStorageKey } from '../apps/web/i18n';
import { deferred, freePort, preferFullCollaboration, startBrowser } from './web-scenario';
import { openAdvancedChatSettings, openChatParticipation, clickWorkbenchAction } from './web-ui-controls';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-background-review'));
await fs.access(path.join(root, 'out/web/app.js'));
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-background-browser-'));
type Formalizer = { input: WorkerFormalizationInput; signal: AbortSignal; send(message: WorkerFormalizationMessage): void; resolve(): void };
type Proof = { input: WorkerInput; signal: AbortSignal; send(message: WorkerMessage): void; resolve(): void };
const formalizers: Formalizer[] = [], proofs: Proof[] = [];
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local background review fixture; no model' }; },
  formalize(input, send, signal) {
    const held = deferred();
    formalizers.push({ input: structuredClone(input), send, signal, resolve: held.resolve });
    signal.addEventListener('abort', held.resolve, { once: true });
    return held.promise;
  },
  run(input, send, signal) {
    const held = deferred();
    proofs.push({ input: structuredClone(input), send, signal, resolve: held.resolve });
    signal.addEventListener('abort', held.resolve, { once: true });
    send({ type: 'progress', event: 'solve_started', message: 'Fixture proof started while review is held' });
    send({ type: 'artifact', artifact: { source: input.input.source.replace('sorry', 'exact Nat.add_comm n 1'),
      workerId: 'solver', status: 'candidate', capturedAt: new Date().toISOString() } });
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
async function screenshot(page: Page, name: string) {
  const status = page.locator('#research-chat-thread .research-conversation-state');
  if (await status.count()) await status.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, name), fullPage: true, timeout: 0 });
}
async function submit(page: Page) {
  await page.locator('#formalize-original').fill(webFormalizationStatement);
  const automatic = page.locator('input[name="chat-participation"][value="automatic"]');
  await openChatParticipation(page);
  await automatic.check();
  if (!await page.locator('#formalize-key').isVisible()) await clickWorkbenchAction(page, '#open-settings');
  await page.locator('#formalize-key').fill('sk-local-background-review-fixture');
  await openAdvancedChatSettings(page);
  await page.locator('#formalize-environment').selectOption('standard');
  for (const selector of ['#formalize-minutes', '#formalize-tokens', '#research-minutes', '#research-tokens', '#research-turns'])
    assert.equal(await page.locator(selector).inputValue(), '', 'Default budgets remain unlimited');
  const index = formalizers.length;
  await page.locator('#formalize-start:enabled').click();
  await eventually(() => formalizers.length > index);
  return formalizers[index];
}
async function run(page: Page, id: string): Promise<WebRun> {
  return page.evaluate(async id => (await (await fetch(`/api/runs/${id}`)).json()).run, id);
}
try {
  browser = await startBrowser(service.server, port);
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce',
      permissions: ['clipboard-read', 'clipboard-write'] });
    context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
    // The mathematical progress block and the output buttons of a running proof are the 详细 reading; 简洁 shows them in the workspace.
    await preferFullCollaboration(context);
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    await context.route(/^https?:\/\//u, async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
      if (url.pathname.startsWith('/api/')) requests.push(`${route.request().method()} ${url.pathname}`);
      await route.continue();
    });
    const page = activePage = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    const formalizer = await submit(page), evidence = webFormalizationEvidence(formalizer.input);
    const compiled = formalizationCompiledCandidate(evidence), proofIndex = proofs.length;
    formalizer.send({ type: 'compiled', candidate: compiled });
    formalizer.send({ type: 'progress', progress: { phase: 'reviewing', round: 1 } });
    await eventually(() => proofs.length > proofIndex);
    const proof = proofs[proofIndex], id = proof.input.id;
    assert.equal(proof.input.formalization, undefined);
    assert.equal(proof.input.input.maxRunSeconds, 0); assert.equal(proof.input.input.maxTurns, 0);
    assert.equal(proof.input.input.maxTotalTokens, 0);
    await page.locator('[data-chat-background-review]').waitFor();
    await page.locator('[data-research-stop]').waitFor();
    assert.equal(formalizer.signal.aborted, false);
    assert.match(await page.locator('#research-chat-thread [data-statement-verdict]').innerText(), /后台审核中/u);
    mark(`${width}px: compiled candidate starts proof while its review remains running`);

    await page.locator('#research-chat-thread [data-research-artifact="original"]').click();
    await page.locator('[data-chat-statement-copy]').click();
    await page.waitForFunction(() => /代码已复制/u.test(document.querySelector('[data-chat-statement-copy]')?.textContent ?? ''), undefined, { timeout: 0 });
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), compiled.candidate.source);
    const downloadPending = page.waitForEvent('download', { timeout: 0 });
    await page.locator('[data-chat-statement-download]').click();
    const download = await downloadPending;
    assert.equal(await fs.readFile((await download.path())!, 'utf8'), compiled.candidate.source);
    await page.locator('#close-research-output').click();
    assert.equal((await run(page, id)).formalization?.confirmation, 'pending');
    await screenshot(page, `proof-and-review-${width}.png`);
    mark(`${width}px: candidate statement can be copied and downloaded before review`);

    const reviewPage = await context.newPage();
    reviewPage.on('pageerror', error => errors.push(error.message));
    await reviewPage.goto(`${origin}/formalize.html?id=${formalizer.input.id}`);
    await reviewPage.locator('#formalize-compiled').waitFor();
    assert.equal(await reviewPage.locator('#formalize-compiled pre').textContent(), compiled.candidate.source);
    assert.match(await reviewPage.locator('#formalize-research-status').innerText(), /证明与原题含义审核同时进行/u);
    assert.equal(await reviewPage.locator('[data-compiled-copy]').isEnabled(), true);
    await screenshot(reviewPage, `formalization-review-pending-${width}.png`);
    await reviewPage.close(); await page.bringToFront();
    mark(`${width}px: formalization details expose compiled code without claiming review approval`);

    const source = proof.input.input.source.replace('sorry', 'exact Nat.add_comm n 1');
    proof.send({ type: 'result', result: { status: 'evaluated_passed', proof: source,
      report: { status: 'evaluated_passed', fixture: true } } });
    proof.resolve();
    await page.waitForFunction(() => /候选 Lean 陈述证明通过/u.test(document.querySelector('.research-conversation-state')?.textContent ?? ''), undefined, { timeout: 0 });
    await page.locator('[data-chat-background-review]').waitFor();
    assert.equal(await page.locator('[data-chat-share]').count(), 0);
    assert.equal(await page.locator('[data-chat-answer]').count(), 0);
    await page.reload();
    await page.locator('[data-chat-background-review]').waitFor();
    assert.match(await page.locator('#research-chat-thread [data-statement-verdict]').innerText(), /后台审核中/u);
    assert.equal(proofs.length, proofIndex + 1, 'Reload never starts a second proof');
    assert.equal((await run(page, id)).result?.proof, source);
    await screenshot(page, `proof-ready-review-pending-${width}.png`);
    mark(`${width}px: completed candidate proof remains available across reload while review is pending`);

    formalizer.send({ type: 'result', status: 'approved', evidence }); formalizer.resolve();
    await page.waitForFunction(direct => (direct ? /Lean 编译通过/u : /模型审核通过/u)
      .test(document.querySelector('#research-chat-thread [data-statement-verdict]')?.textContent ?? ''), formalizer.input.reviewMode === 'direct', { timeout: 0 });
    if (formalizer.input.reviewMode === 'direct') assert.doesNotMatch(
      await page.locator('#research-chat-thread [data-statement-verdict]').innerText(), /模型审核通过/u);
    await page.waitForFunction(() => !document.querySelector('[data-chat-background-review]'), undefined, { timeout: 0 });
    assert.equal(await page.locator('[data-chat-background-review]').count(), 0);
    assert.equal(await page.locator('[data-research-stop]').count(), 0);
    assert.equal(proofs.length, proofIndex + 1, 'Approval attaches to the existing proof');
    const approved = await run(page, id);
    assert.equal(approved.formalization?.confirmation, 'automatic'); assert.ok(approved.formalization?.evidenceSha256);
    assert.equal(approved.result?.proof, source); assert.equal(approved.source, compiled.candidate.source);
    await screenshot(page, `approved-same-proof-${width}.png`);
    mark(`${width}px: ${formalizer.input.reviewMode === 'direct' ? 'compiled evidence' : 'review approval'} attaches to the same frozen candidate and proof`);

    await page.locator('#topbar-draft').click();
    const cancelledFormalizer = await submit(page), cancelledEvidence = webFormalizationEvidence(cancelledFormalizer.input);
    const nextIndex = proofs.length;
    cancelledFormalizer.send({ type: 'compiled', candidate: formalizationCompiledCandidate(cancelledEvidence) });
    await eventually(() => proofs.length > nextIndex);
    await page.locator('[data-chat-background-review]').waitFor();
    const cancelReview = `**/api/formalizations/${cancelledFormalizer.input.id}/cancel`;
    if (width === 390) {
      await page.route(cancelReview, route => route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: 'Local fixture: review stop request failed' }) }));
      await page.locator('[data-research-stop]').click();
      await eventually(() => proofs[nextIndex].signal.aborted);
      assert.equal(cancelledFormalizer.signal.aborted, false, 'The failed review stop is not reported as successful');
      await page.waitForFunction(() => /Local fixture: review stop request failed/u.test(document.querySelector('#research-chat-thread')?.textContent ?? ''), undefined, { timeout: 0 });
      assert.equal((await run(page, proofs[nextIndex].input.id)).status, 'cancelled');
      mark('390px: proof stop is still attempted when the review stop request fails');
      await page.unroute(cancelReview);
    }
    await page.locator('[data-research-stop]').click();
    await eventually(() => cancelledFormalizer.signal.aborted && proofs[nextIndex].signal.aborted);
    await page.waitForFunction(() => !document.querySelector('[data-research-stop]'), undefined, { timeout: 0 });
    assert.equal((await run(page, proofs[nextIndex].input.id)).formalization?.confirmation, 'interrupted');
    await screenshot(page, `cancelled-both-${width}.png`);
    mark(`${width}px: one stop action cancels both proof and background review`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await context.close(); activePage = undefined;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(),
    mode: 'controlled-local-workers', paidModelCalls: false, leanAcceptancePerformed: false,
    timeLimit: null, tokenLimit: null, checks, requests, errors }, null, 2) + '\n');
  console.log(`PASS background review browser checks: ${checks.length}`);
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 0 }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', checkedAt: new Date().toISOString(),
    mode: 'controlled-local-workers', paidModelCalls: false, leanAcceptancePerformed: false, checks, requests, errors,
    error: error instanceof Error ? error.stack : String(error) }, null, 2) + '\n');
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close(); await service.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
