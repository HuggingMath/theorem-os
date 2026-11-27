#!/usr/bin/env bun
import { openAdvancedChatSettings, clickWorkbenchAction, openChatParticipation } from './web-ui-controls';
// Disposable accounts, recorded formalization evidence and a fake runner; no external model or Lean.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { webFormalizationEvidence, webFormalizationStatement } from '../tests/helpers/webFormalizationFixture';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-chat-recovery');
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-chat-recovery-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const mail: { text: string }[] = [], formalizations: string[] = [], external: string[] = [], checks: string[] = [];
const mark = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
let proofCalls = 0, runtimeReady = true, browser: Browser | undefined, page: Page | undefined;
const credential = 'sk-chat-recovery-disposable-secret';
const runner: WebRunner = {
  async readiness() { return { ready: runtimeReady, nativeTeam: runtimeReady, message: 'Local recovery fixture' }; },
  async run() { proofCalls++; throw new Error('Recovery checks must not start proof research'); },
  async formalize(input, send) {
    formalizations.push(input.id);
    send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(input) });
  },
};
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: data,
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SIGNUP: 'open', THEOREMOS_WEB_SMTP_URL: 'log:',
  THEOREMOS_WEB_KEY_SECRET: 'a'.repeat(64) });
let service = createWebService(config, runner, { mailer: async item => { mail.push(item); }, captchaAnswer: () => '24680' });
const selected = { 'formalize-provider': 'openai', 'formalize-model': 'fixture-chosen-model',
  'formalize-environment': 'mathlib', 'formalize-effort': 'low', 'formalize-minutes': '2', 'formalize-tokens': '20000',
  'research-minutes': '1', 'research-tokens': '15000', 'research-turns': '2' };
const original = `${webFormalizationStatement}\n\n第二行：保留原题的空白和说明。`;
async function snapshot() {
  return page!.evaluate(ids => ({ fields: Object.fromEntries(ids.map(id => [id, (document.getElementById(id) as HTMLInputElement).value])),
    original: (document.getElementById('formalize-original') as HTMLTextAreaElement).value,
    participation: (document.querySelector('input[name="chat-participation"]:checked') as HTMLInputElement).value }), Object.keys(selected));
}
async function initialized() {
  await page!.locator('#formalize-original').waitFor();
  await page!.waitForFunction(() => Boolean((document.querySelector('#formalize-model') as HTMLInputElement)?.value));
}
async function assertNoStoredKey() {
  assert.equal(await page!.evaluate(key => JSON.stringify([sessionStorage, localStorage]).includes(key), credential), false);
}
async function participation(value: 'automatic' | 'guided') {
  const radio = page!.locator(`input[name="chat-participation"][value="${value}"]`);
  if (!await radio.isVisible()) await openChatParticipation(page!);
  await radio.check();
}
try {
  browser = await startBrowser(service.server, port);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', locale: 'zh-CN' });
  context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(30_000);
  await context.addInitScript(() => localStorage.setItem('theorem-os.locale.v1', 'zh'));
  await context.route(/^https?:\/\//, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  page = await context.newPage();
  await page.goto(origin);
  await page.locator('#send-code:enabled').waitFor();
  await page.locator('#login-email').fill('recovery@example.org');
  await page.locator('#login-captcha').fill('24680'); await page.locator('#accept-terms').check();
  await page.locator('#send-code').click(); await page.locator('#code-step:not([hidden])').waitFor();
  await page.locator('#login-code').fill(mail.at(-1)!.text.match(/\b\d{6}\b/u)![0]);
  await page.locator('#verify-code').click(); await page.waitForURL(origin + '/'); await initialized();
  await openChatParticipation(page);
  await page.locator('input[name="chat-participation"][value="automatic"]').check();
  await page.locator('#chat-model-settings > summary').click();
  await page.locator('#formalize-provider').selectOption(selected['formalize-provider']);
  await page.locator('#formalize-effort').selectOption(selected['formalize-effort']);
  await page.locator('#formalize-model').fill(selected['formalize-model']);
  await openAdvancedChatSettings(page);
  await page.locator('#formalize-environment').selectOption(selected['formalize-environment']);
  for (const id of ['formalize-minutes', 'formalize-tokens', 'research-minutes', 'research-tokens', 'research-turns'] as const) await page.locator(`#${id}`).fill(selected[id]);
  await page.locator('#formalize-original').fill(original); await page.locator('#formalize-key').fill(credential);
  await assertNoStoredKey();
  await page.locator('#chat-save-key').click(); await page.locator('#chat-key-notice').filter({ hasText: 'Key 已保存' }).waitFor();
  const draft = await snapshot();
  assert.deepEqual(draft, { fields: selected, original, participation: 'automatic' });
  await page.locator('#formalize-settings > summary').click();
  await page.locator('[data-chat-examples] > summary').click();
  await page.locator('[data-chat-sample]').click(); await page.waitForURL(url => url.origin === origin && url.searchParams.has('sample'));
  await page.locator('[data-chat-sample-note]').waitFor(); await page.goBack(); await page.waitForURL(origin + '/');
  await page.waitForFunction(text => (document.querySelector('#formalize-original') as HTMLTextAreaElement)?.value === text, original);
  assert.deepEqual(await snapshot(), draft);
  await page.reload(); await initialized(); assert.deepEqual(await snapshot(), draft); await assertNoStoredKey();
  assert.equal(await page.locator('#formalize-start').isEnabled(), true);
  mark('G02/G03: exact original and all nonsecret settings survive sample/Back and refresh with a saved key');

  let sent: Record<string, any> | undefined;
  const interceptBudget = async (route: import('playwright').Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Local request-body checkpoint' }) });
  };
  await page.route('**/api/formalizations', interceptBudget);
  await page.locator('#formalize-start').click(); await page.locator('.chat-error').waitFor();
  assert.ok(sent?.requestId); assert.equal(sent?.maxRunSeconds, 120); assert.equal(sent?.maxTotalTokens, 20_000);
  assert.deepEqual(sent?.research, { maxRunSeconds: 60, maxTotalTokens: 15_000, maxTurns: 2 });
  assert.equal(sent?.environment, 'mathlib');
  assert.equal(sent?.humanReview, undefined); assert.equal(sent?.providerId, 'openai'); assert.equal(sent?.model, selected['formalize-model']);
  assert.equal(formalizations.length, 0); await page.unroute('**/api/formalizations', interceptBudget);
  mark('G02: actual refreshed request retains 120s/20k formalization and 60s/15k/2-turn proof limits');

  await page.locator('#topbar-draft').click(); await page.locator('#formalize-original').fill(webFormalizationStatement);
  await participation('guided');
  let receiptStatus = 0, droppedFormalization = false, droppedConversation = false;
  await page.route('**/api/formalizations', async route => {
    if (route.request().method() !== 'POST' || droppedFormalization) return route.continue();
    const response = await route.fetch({ timeout: 0 }); receiptStatus = response.status(); droppedFormalization = true; await route.abort('failed');
  });
  await page.locator('#formalize-start').click(); await page.locator('.chat-error').waitFor();
  assert.equal(receiptStatus, 201); assert.equal(formalizations.length, 1);
  const firstId = formalizations[0];
  // Simulate the former client's email scope. Only this account's already-bound state may migrate.
  await page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json(), owner = session.draftOwner, email = session.account.email;
    for (const key of Object.keys(sessionStorage)) {
      const target = key.startsWith(`theorem-os.chat-draft.${owner}.`)
        ? `theorem-os.chat-draft.${email}.${key.slice(`theorem-os.chat-draft.${owner}.`.length)}`
        : key === `theorem-os.chat-submission.v1.${owner}` ? `theorem-os.chat-submission.v1.${email}` : undefined;
      if (target) { sessionStorage.setItem(target, sessionStorage.getItem(key)!); sessionStorage.removeItem(key); }
    }
  });
  // Reopen the server from disk as well as the page: the idempotency record must outlive either process.
  await service.close();
  service = createWebService(config, runner, { mailer: async item => { mail.push(item); }, captchaAnswer: () => '24680' });
  service.server.requestTimeout = 0; service.server.headersTimeout = 0; service.server.setTimeout(0);
  await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
  await page.reload(); await initialized();
  await page.route('**/api/conversations', async route => {
    if (route.request().method() !== 'POST' || droppedConversation) return route.continue();
    const response = await route.fetch({ timeout: 0 }); assert.equal(response.status(), 201); droppedConversation = true; await route.abort('failed');
  });
  await page.locator('#formalize-start').click(); await page.locator('.chat-error').waitFor();
  assert.equal(formalizations.length, 1); assert.equal(droppedConversation, true);
  await page.reload(); await initialized(); await page.locator('#formalize-start').click();
  await page.waitForURL(url => url.searchParams.has('chat')); await page.locator('[data-chat-confirm-statement]').waitFor();
  const records = await page.evaluate(async () => ({
    formalizations: (await (await fetch('/api/formalizations')).json()).formalizations,
    conversations: (await (await fetch('/api/conversations')).json()).conversations,
  }));
  assert.deepEqual(records.formalizations.map((item: { id: string }) => item.id), [firstId]);
  assert.equal(records.conversations.length, 1); assert.equal(records.conversations[0].formalizationId, firstId);
  assert.equal(formalizations.length, 1); assert.equal(proofCalls, 0); await assertNoStoredKey();
  mark('G01: lost formalization and conversation receipts, page refresh and server restart recover one task and one conversation');
  const cookies = await context.cookies(); await context.close();

  // The first send must also recover when no earlier refresh normalized the default budget object's field order.
  const defaultsContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', locale: 'zh-CN' });
  defaultsContext.setDefaultTimeout(15_000); defaultsContext.setDefaultNavigationTimeout(30_000);
  await defaultsContext.addCookies(cookies);
  page = await defaultsContext.newPage(); await page.goto(origin); await initialized();
  await page.locator('#formalize-original').fill(webFormalizationStatement);
  await clickWorkbenchAction(page, '#open-settings');
  await participation('guided');
  await openAdvancedChatSettings(page);
  await page.locator('#formalize-environment').selectOption('mathlib'); await page.locator('#formalize-key').fill(credential);
  let defaultRequestId = '', defaultDropped = false;
  await page.route('**/api/formalizations', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const id = route.request().postDataJSON().requestId;
    if (defaultDropped) { assert.equal(id, defaultRequestId); return route.continue(); }
    defaultRequestId = id; defaultDropped = true;
    const response = await route.fetch({ timeout: 0 }); assert.equal(response.status(), 201); await route.abort('failed');
  });
  await page.locator('#formalize-start').click(); await page.locator('.chat-error').waitFor();
  assert.equal(formalizations.length, 2);
  runtimeReady = false;
  await page.reload(); await initialized();
  assert.equal(await page.locator('#formalize-key').inputValue(), '');
  assert.equal(await page.locator('#formalize-start').isEnabled(), true);
  await page.locator('#formalize-start').click();
  await page.waitForURL(url => url.searchParams.has('chat')); await page.locator('[data-chat-confirm-statement]').waitFor();
  assert.equal(formalizations.length, 2);
  runtimeReady = true;
  mark('G01: default-budget first send recovers its receipt after refresh even without a key or ready worker');
  await page.unroute('**/api/formalizations');
  await page.reload(); await initialized();
  await page.locator('#topbar-draft').click(); await page.locator('#formalize-original').fill(webFormalizationStatement);
  await clickWorkbenchAction(page, '#open-settings'); await page.locator('#formalize-key').fill(credential);
  await participation('guided');
  await page.locator('#formalize-settings > summary').click();
  let releaseConversation!: () => void, conversationHeld = false;
  const gate = new Promise<void>(resolve => { releaseConversation = resolve; });
  await page.route('**/api/conversations', async route => {
    if (route.request().method() !== 'POST' || conversationHeld) return route.continue();
    const response = await route.fetch({ timeout: 0 }); conversationHeld = true; await gate; await route.fulfill({ response });
  });
  await page.locator('#formalize-start').click();
  while (!conversationHeld) await page.waitForTimeout(30);
  await page.locator('[data-chat-examples] > summary').click();
  await page.locator('[data-chat-sample]').click(); await page.waitForURL(url => url.origin === origin && url.searchParams.has('sample'));
  const delivered = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/conversations');
  releaseConversation(); await delivered;
  await page.goBack(); await page.waitForURL(origin + '/'); await initialized();
  assert.equal(await page.locator('#formalize-original').inputValue(), webFormalizationStatement);
  await page.locator('#formalize-start').click();
  await page.waitForURL(url => url.searchParams.has('chat')); await page.locator('[data-chat-confirm-statement]').waitFor();
  assert.equal(formalizations.length, 3);
  mark('G01/G03: a late conversation receipt during sample navigation retains identity and restores the original task on Back');
  await defaultsContext.close();

  for (const [width, height] of [[812, 375], [390, 480], [390, 844], [1440, 900]]) {
    const sampleContext = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', locale: 'zh-CN' });
    sampleContext.setDefaultTimeout(15_000); sampleContext.setDefaultNavigationTimeout(30_000);
    await sampleContext.addCookies(cookies);
    const samplePage = await sampleContext.newPage(); page = samplePage;
    await samplePage.goto(origin);
    if (await samplePage.locator('#login-email').isVisible()) {
      await sampleContext.close();
      throw new Error('Short viewport needs the authenticated recovery session');
    }
    await samplePage.locator('[data-chat-examples] > summary').click();
    await samplePage.locator('[data-chat-sample]').click(); await samplePage.waitForURL(url => url.origin === origin && url.searchParams.has('sample'));
    await samplePage.locator('[data-chat-sample-note]').waitFor();
    assert.ok(await samplePage.locator('#research-chat-thread').evaluate(node => node.clientHeight) >= Math.min(100, height * .25));
    await samplePage.screenshot({ path: path.join(output, `conversation-${width}x${height}.png`), fullPage: true });
    await samplePage.locator('[data-chat-result-more] > summary').click();
    await samplePage.locator('[data-research-artifact="roadmap"]').click();
    await samplePage.locator('.solution-route-view-controls [data-solution-view="read"]').click();
    await samplePage.locator('[data-solution-reader-select]').waitFor();
    await samplePage.screenshot({ path: path.join(output, `roadmap-${width}x${height}.png`), fullPage: true });
    for (const artifact of ['result', 'source']) {
      await samplePage.goto(origin + '/?sample');
      if (artifact === 'result') await samplePage.locator('[data-chat-result-more] > summary').click();
      await samplePage.locator(`[data-research-artifact="${artifact}"]`).click();
      await samplePage.locator(`#detail-tab-${artifact}[aria-selected="true"]`).waitFor();
    }
    assert.equal(await samplePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    mark(`G08: ${width}×${height} keeps a readable thread; roadmap reading, result and source respond to normal clicks`);
    await sampleContext.close();
  }
  assert.deepEqual(external, []); assert.equal(proofCalls, 0);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', paidModelCalls: false, realLeanCalls: false,
    browserTimeouts: 0, deadline: null, tokenLimit: null, roundLimit: null, checks }, null, 2) + '\n');
  console.log(`Chat recovery: ${checks.length} checks passed`);
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', checks, error: String(error) }, null, 2) + '\n');
  throw error;
} finally { await browser?.close(); await service.close(); await fs.rm(data, { recursive: true, force: true }); }
