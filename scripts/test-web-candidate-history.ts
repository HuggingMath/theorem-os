#!/usr/bin/env bun
// Real local HTTP + browser workflow with disposable controlled workers; no model or Lean execution.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebConversation } from '../apps/web/conversationTypes';
import type { WebRunner } from '../apps/web/runner';
import type { WorkerFormalizationInput, WorkerFormalizationMessage } from '../apps/web/formalizationTypes';
import type { WebRun, WorkerInput, WorkerMessage } from '../apps/web/shared';
import { formalizationCompiledCandidate, formalizationInputDigest } from '../src/math/formalization';
import { syntheticElaboration } from '../tests/helpers/formalizationFixture';
import { webFormalizationEvidence, webFormalizationStatement } from '../tests/helpers/webFormalizationFixture';
import { localeStorageKey } from '../apps/web/i18n';
import { collaborationDetailStorageKey } from '../apps/web/client/runAwareness';
import { deferred, freePort, startBrowser } from './web-scenario';
import { openAdvancedChatSettings } from './web-ui-controls';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const waitTimeout = 15_000;
const output = path.resolve(process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-candidate-history'));
await fs.access(path.join(root, 'out/web/app.js'));
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-candidate-history-'));
type Formalizer = { input: WorkerFormalizationInput; signal: AbortSignal; send(message: WorkerFormalizationMessage): void };
type Proof = { input: WorkerInput; send(message: WorkerMessage): void; resolve(): void };
const formalizers: Formalizer[] = [], proofs: Proof[] = [];
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Controlled candidate history fixture' }; },
  formalize(input, send, signal) {
    const held = deferred();
    formalizers.push({ input: structuredClone(input), send, signal });
    signal.addEventListener('abort', held.resolve, { once: true });
    return held.promise;
  },
  run(input, send, signal) {
    const held = deferred();
    proofs.push({ input: structuredClone(input), send, resolve: held.resolve });
    signal.addEventListener('abort', held.resolve, { once: true });
    send({ type: 'artifact', artifact: { source: input.input.source, workerId: 'solver',
      status: 'candidate', capturedAt: new Date().toISOString() } });
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
async function eventually(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + waitTimeout;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `${label} did not finish within 15 seconds.`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function readRun(page: Page, id: string): Promise<WebRun> {
  return page.evaluate(async id => (await (await fetch(`/api/runs/${id}`)).json()).run, id);
}
async function readConversation(page: Page, id: string): Promise<WebConversation> {
  return page.evaluate(async id => (await (await fetch(`/api/conversations/${id}`)).json()).conversation, id);
}
async function statement(page: Page, source: string) {
  await page.locator('#research-chat-thread [data-research-artifact="original"]').click();
  await page.waitForFunction(source => document.querySelector('.chat-original-content pre code')?.textContent === source,
    source, { timeout: waitTimeout });
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: path.join(output, name), fullPage: true, timeout: waitTimeout });
}
try {
  browser = await startBrowser(service.server, port);
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce',
      permissions: ['clipboard-read', 'clipboard-write'] });
    context.setDefaultTimeout(waitTimeout); context.setDefaultNavigationTimeout(30_000);
    await context.addInitScript(keys => {
      localStorage.setItem(keys.locale, 'zh');
      localStorage.setItem(keys.detail, 'full');
    }, { locale: localeStorageKey, detail: collaborationDetailStorageKey });
    await context.route(/^https?:\/\//u, async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
      if (url.pathname.startsWith('/api/')) requests.push(`${route.request().method()} ${url.pathname}`);
      await route.continue();
    });
    const page = activePage = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#formalize-original').fill(webFormalizationStatement);
    const automatic = page.locator('input[name="chat-participation"][value="automatic"]');
    if (!await automatic.isVisible()) await page.locator('[data-chat-participation-control] > summary').click();
    await automatic.check();
    if (!await page.locator('#formalize-key').isVisible()) await page.locator('#open-settings').click();
    await page.locator('#formalize-key').fill('sk-local-candidate-history-fixture');
    await openAdvancedChatSettings(page);
    await page.locator('#formalize-environment').selectOption('standard');
    for (const selector of ['#formalize-minutes', '#formalize-tokens', '#research-minutes', '#research-tokens', '#research-turns'])
      assert.equal(await page.locator(selector).inputValue(), '', 'Default budgets remain unlimited');
    const formalizerIndex = formalizers.length, proofIndex = proofs.length;
    await page.locator('#formalize-start:enabled').click();
    await eventually(() => formalizers.length > formalizerIndex, 'Starting the formalization worker');
    await page.waitForFunction(() => new URL(location.href).searchParams.has('chat'), undefined, { timeout: waitTimeout });
    const mainId = new URL(page.url()).searchParams.get('chat')!;
    const formalizer = formalizers[formalizerIndex];
    assert.equal(formalizer.input.maxRunSeconds, 0); assert.equal(formalizer.input.maxTotalTokens, 0);
    const first = formalizationCompiledCandidate(webFormalizationEvidence(formalizer.input));
    formalizer.send({ type: 'compiled', candidate: first });
    formalizer.send({ type: 'progress', progress: { phase: 'reviewing', round: 1 } });
    await eventually(() => proofs.length > proofIndex, 'Starting the first candidate proof');
    const proof = proofs[proofIndex], firstRun = proof.input.id;
    assert.equal(proof.input.input.maxRunSeconds, 0); assert.equal(proof.input.input.maxTurns, 0);
    assert.equal(proof.input.input.maxTotalTokens, 0);
    const acceptedSource = first.candidate.source.replace('sorry', 'exact Nat.add_comm n 1');
    proof.send({ type: 'result', result: { status: 'evaluated_passed', proof: acceptedSource, report: { fixture: true } } });
    proof.resolve();
    await page.waitForFunction(() => /候选 Lean 陈述证明通过/u.test(document.querySelector('#research-chat-thread .research-conversation-state')?.textContent ?? ''), undefined, { timeout: waitTimeout });

    const elaborated = syntheticElaboration(first.candidate.source.replace('n + 1 = 1 + n', '1 + n = n + 1'),
      first.request.environment, { detailedContext: true, semanticContext: true, structureContext: true,
        boundedLibraryContext: first.request.contextProtocol === 'kernel-v3' });
    const candidate = { ...first.candidate, source: elaborated.source };
    const revised = formalizationCompiledCandidate({ ...first, candidate, inputDigest: formalizationInputDigest(first.request, candidate),
      sourceSha256: elaborated.sourceSha256, targets: elaborated.targets, snapshot: elaborated.snapshot as typeof first.snapshot,
      snapshotDigest: elaborated.snapshotDigest, compilation: elaborated.compilation as typeof first.compilation, round: 2 });
    formalizer.send({ type: 'compiled', candidate: revised });
    formalizer.send({ type: 'progress', progress: { phase: 'reviewing', round: 2 } });
    await eventually(() => proofs.length > proofIndex + 1, 'Starting the revised candidate proof');
    const currentRun = proofs[proofIndex + 1].input.id;
    await eventually(async () => (await readConversation(page, mainId)).runId === currentRun, 'Following the revised candidate');
    await statement(page, revised.candidate.source);
    assert.match(await page.locator('.chat-original-content').innerText(), /后台审核中/u);
    assert.equal(await page.locator('.chat-original-header a').innerText(), formalizer.input.reviewMode === 'direct' ? '形式化详情' : '完整审核');
    assert.equal(await page.locator('[data-run-formalization] a').innerText(), '查看最新审核');
    await screenshot(page, `latest-candidate-${width}.png`);
    await page.locator('#close-research-output').click();
    mark(`${width}px: original conversation follows the revised candidate and its pending review`);

    const historicalPage = activePage = await context.newPage();
    historicalPage.on('pageerror', error => errors.push(error.message));
    await historicalPage.goto(`${origin}/?run=${firstRun}`);
    await historicalPage.waitForFunction(() => new URL(location.href).searchParams.has('chat'), undefined, { timeout: waitTimeout });
    const historicalId = new URL(historicalPage.url()).searchParams.get('chat')!;
    assert.notEqual(historicalId, mainId);
    assert.equal((await readConversation(historicalPage, historicalId)).runId, firstRun);
    assert.equal((await readConversation(historicalPage, historicalId)).formalizationId, undefined);
    await statement(historicalPage, first.candidate.source);
    assert.match(await historicalPage.locator('.chat-original-content').innerText(), /此陈述已被新版本替代/u);
    assert.equal(await historicalPage.locator('.chat-original-header a').innerText(), '查看最新审核');
    assert.match((await historicalPage.locator('.chat-original-header a').getAttribute('href'))!, new RegExp(formalizer.input.id, 'u'));
    assert.equal(await historicalPage.locator('#research-chat-thread [data-chat-background-review]').count(), 0);
    await screenshot(historicalPage, `historical-statement-${width}.png`);
    mark(`${width}px: old run link preserves its original statement and superseded review status`);

    await historicalPage.locator('[data-chat-statement-copy]').click();
    await historicalPage.waitForFunction(() => /代码已复制/u.test(document.querySelector('[data-chat-statement-copy]')?.textContent ?? ''), undefined, { timeout: waitTimeout });
    assert.equal(await historicalPage.evaluate(() => navigator.clipboard.readText()), first.candidate.source);
    const statementDownload = historicalPage.waitForEvent('download', { timeout: waitTimeout });
    await historicalPage.locator('[data-chat-statement-download]').click();
    assert.equal(await fs.readFile((await (await statementDownload).path())!, 'utf8'), first.candidate.source);
    await historicalPage.locator('#close-research-output').click();
    await historicalPage.locator('#research-chat-thread [data-research-artifact="source"]').click();
    await historicalPage.waitForFunction(source => document.querySelector('#detail-panel .source-code code')?.textContent === source,
      acceptedSource, { timeout: waitTimeout });
    assert.equal(await historicalPage.locator('[data-run-formalization] a').innerText(), '查看最新审核');
    await historicalPage.locator('[data-action="copy-source"]').click();
    await eventually(async () => await historicalPage.evaluate(() => navigator.clipboard.readText()) === acceptedSource, 'Copying the historical proof');
    const proofDownload = historicalPage.waitForEvent('download', { timeout: waitTimeout });
    await historicalPage.locator('[data-action="download-proof"]').click();
    assert.equal(await fs.readFile((await (await proofDownload).path())!, 'utf8'), acceptedSource);
    await screenshot(historicalPage, `historical-proof-${width}.png`);
    mark(`${width}px: historical statement and accepted proof copy and download their own version`);

    // Reproduce the older persisted format, which stored both IDs for an explicitly selected run.
    const owner = service.storage.listRecords(['owners']).find(owner => service.storage.getRecord<WebConversation>(
      ['owners', owner, 'conversations', historicalId + '.json'])?.id === historicalId);
    assert.ok(owner);
    const recordPath = ['owners', owner, 'conversations', historicalId + '.json'];
    const legacy = service.storage.getRecord<WebConversation>(recordPath)!;
    legacy.formalizationId = formalizer.input.id; delete legacy.followFormalization;
    service.storage.saveRecord(recordPath, legacy);
    await historicalPage.reload();
    await statement(historicalPage, first.candidate.source);
    assert.equal(new URL(historicalPage.url()).searchParams.get('chat'), historicalId);
    assert.equal((await readRun(historicalPage, firstRun)).result?.proof, acceptedSource);
    assert.match(await historicalPage.locator('.chat-original-content').innerText(), /此陈述已被新版本替代/u);
    mark(`${width}px: a legacy saved formalization and run association remains fixed after reload`);
    await historicalPage.locator('#close-research-output').click();
    await historicalPage.goto(`${origin}/?run=${firstRun}`);
    await statement(historicalPage, first.candidate.source);
    assert.equal(new URL(historicalPage.url()).searchParams.get('chat'), historicalId);
    await historicalPage.locator('#close-research-output').click();
    await historicalPage.goto(`${origin}/?chat=${mainId}`);
    await statement(historicalPage, revised.candidate.source);
    assert.equal((await readConversation(historicalPage, mainId)).runId, currentRun);
    assert.equal(proofs.length, proofIndex + 2, 'Viewing history never starts another proof');
    await screenshot(historicalPage, `return-to-latest-${width}.png`);
    mark(`${width}px: refresh and repeated old links stay on history; main conversation still opens the latest candidate`);
    await historicalPage.locator('#close-research-output').click();
    assert.equal(await historicalPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await historicalPage.locator('[data-research-stop]').click();
    await eventually(() => formalizer.signal.aborted, 'Stopping the formalization worker');
    await context.close(); activePage = undefined;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(),
    mode: 'controlled-local-workers', paidModelCalls: false, leanAcceptancePerformed: false,
    timeLimit: null, tokenLimit: null, checks, requests, errors }, null, 2) + '\n');
  console.log(`PASS candidate history browser checks: ${checks.length}`);
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: waitTimeout }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', checkedAt: new Date().toISOString(),
    mode: 'controlled-local-workers', paidModelCalls: false, leanAcceptancePerformed: false, timeLimit: null, tokenLimit: null,
    checks, requests, errors, error: error instanceof Error ? error.stack : String(error) }, null, 2) + '\n');
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close(); await service.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
