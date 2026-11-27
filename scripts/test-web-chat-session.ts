#!/usr/bin/env bun
import { clickWorkbenchAction, openAdvancedChatSettings, openChatBudget, openChatParticipation, openChatResultDetails } from './web-ui-controls';
// Disposable HTTP services and recorded mathematics evidence only: no external model or Lean process.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebConversation } from '../apps/web/conversationTypes';
import type { WorkerFormalizationInput, WorkerFormalizationMessage } from '../apps/web/formalizationTypes';
import type { WebRunner } from '../apps/web/runner';
import type { WorkerInput } from '../apps/web/shared';
import { localeStorageKey } from '../apps/web/i18n';
import { deferred } from '../tests/helpers/async';
import { webFormalizationEvidence, webFormalizationStatement } from '../tests/helpers/webFormalizationFixture';
import { audit } from './web-a11y';
import { freePort, startBrowser } from './web-scenario';

declare const Bun: { serve(options: { hostname: string; port: number; idleTimeout?: number; fetch(request: Request): Response | Promise<Response> }): { port: number; stop(force?: boolean): void } };

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-chat-session');
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-chat-browser-'));
const original = `  ${webFormalizationStatement}\n\n  `;
const question = '请解释这道题的证明思路。', followup = '你刚才提到的交换律在 Lean 中怎么表达？';
const answer = '这是加法交换律的一个实例。可以用 Nat.add_comm n 1，但这里的回答不代表 Lean 验收。';
const richCode = ['theorem addition (n : Nat) : n + 1 = 1 + n := by',
  ...Array.from({ length: 18 }, (_, index) => `  -- 证明说明 ${index + 1}：使用加法交换律`),
  '  exact Nat.add_comm n 1'].join('\n');
const richAnswer = ['## 证明思路', '', String.raw`设 $n \in \mathbb{N}$。**加法交换律**给出`, '', '$$n + 1 = 1 + n$$', '',
  '1. 对任意自然数使用交换律。', '2. 代入第二个参数 1。', '', '```lean', richCode, '```', '',
  ...Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 步说明：这是保留阅读位置的本地测试内容，不代表新执行的 Lean 验收。`) ].join('\n');
const providerCalls: Record<string, any>[] = [];
let holdAnswer = false, releaseAnswer: (() => void) | undefined;
type StreamReply = { text: string; aborted: boolean; delta(text: string): void; complete(): void };
const streamReplies: StreamReply[] = [];
let streamNextAnswer = false;
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
  assert.equal(new URL(request.url).pathname, '/v1/responses');
  providerCalls.push(await request.json() as Record<string, any>);
  if (streamNextAnswer) {
    streamNextAnswer = false;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: object) => { if (!closed) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); };
        const reply: StreamReply = { text: '', aborted: false, delta(text) {
          this.text += text; send({ type: 'response.output_text.delta', delta: text });
        }, complete() {
          send({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: this.text }] }] } });
          if (!closed) { closed = true; controller.close(); }
        } };
        streamReplies.push(reply);
        request.signal.addEventListener('abort', () => {
          reply.aborted = true;
          if (!closed) { closed = true; controller.close(); }
        }, { once: true });
      },
      cancel() { closed = true; },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  }
  if (holdAnswer) await new Promise<void>(resolve => { releaseAnswer = resolve; request.signal.addEventListener('abort', () => resolve(), { once: true }); });
  return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }] });
} });
type Pending = { input: WorkerFormalizationInput; send(message: WorkerFormalizationMessage): void; resolve(): void };
const formalizations: Pending[] = [], runs: WorkerInput[] = [];
const runner: WebRunner = {
  async readiness() { return { ready: true, nativeTeam: true, message: 'Disposable chat browser fixture' }; },
  formalize(input, send, signal) {
    return new Promise<void>(resolve => { formalizations.push({ input: structuredClone(input), send, resolve });
      signal.addEventListener('abort', () => resolve(), { once: true }); });
  },
  async run(input, send) { runs.push(structuredClone(input));
    const status = runs.length === 2 ? 'evaluated_passed' : 'incomplete';
    send({ type: 'result', result: { status, proof: status === 'evaluated_passed'
      ? input.input.source.replace('sorry', 'exact Nat.add_comm n 1') : input.input.source, report: { status, fixture: true } } }); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: path.join(temporary, 'data') });
// Trusted test configuration bypasses the public configuration's HTTPS requirement for this loopback fixture.
config.providers = [{ id: 'sub2api', name: 'Local fixture', baseUrl: `http://127.0.0.1:${provider.port}/v1` }];
const service = createWebService(config, runner);
service.server.requestTimeout = 0; service.server.headersTimeout = 0; service.server.setTimeout(0);
let browser: Browser | undefined, activePage: Page | undefined;
const checks: string[] = [], errors: string[] = [], requests: string[] = [], screenshots: string[] = [];
const mark = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
async function screenshot(page: Page, filename: string) {
  await page.screenshot({ path: path.join(output, filename), fullPage: true }); screenshots.push(filename);
}
async function eventually(check: () => boolean, description: string) {
  const until = Date.now() + 15_000;
  while (!check()) { assert.ok(Date.now() < until, description); await new Promise(resolve => setTimeout(resolve, 40)); }
}
const budgetInputs = ['#formalize-minutes', '#formalize-tokens', '#research-minutes', '#research-tokens', '#research-turns'];
const positiveBudgets = ['4', '120000', '3', '80000', '4'];
async function blankBudgets(page: Page) {
  await openAdvancedChatSettings(page);
  for (const selector of budgetInputs) {
    assert.equal(await page.locator(selector).inputValue(), '', `${selector} represents unlimited with a blank value`);
    assert.equal(await page.locator(selector).getAttribute('placeholder'), '不限');
  }
  await openChatBudget(page);
  assert.match(await page.locator('[data-chat-budget]').innerText(), /形式化[\s\S]*不限[\s\S]*证明[\s\S]*不限/u);
  assert.doesNotMatch(await page.locator('[data-chat-budget]').innerText(), /0 Token|0 分钟|0 轮/u);
  await openAdvancedChatSettings(page);
}
/** The status says where the task is once; a task that needs nothing from the reader adds no "your next action" line. */
async function outcomes(page: Page) {
  const state = page.locator('.research-conversation-state strong'); await state.waitFor();
  assert.ok((await state.innerText()).trim());
  assert.equal(await page.locator('[data-chat-outcomes]').count(), 0, 'The status is not repeated as a three-line summary');
  assert.equal(await page.locator('[data-chat-next-action]').count(), 0, 'An automatic task asks nothing of the reader');
}
async function historyMetadata(page: Page, id: string) {
  const row = page.locator(`[data-chat-row="${id}"]`);
  await row.locator('.chat-history-item').waitFor();
  assert.equal(await row.locator('[data-chat-history-status]:visible').count(), 0, 'A settled chat has no routine status line');
  const value = await page.evaluate(async id => (await (await fetch(`/api/conversations/${id}`)).json()).conversation as WebConversation, id);
  const time = row.locator('time.chat-history-time');
  assert.equal(await time.isVisible(), false, 'Timestamps stay in the secondary menu');
  const trigger = row.locator('[data-chat-row-actions]');
  await trigger.click(); await time.waitFor();
  assert.equal(await time.getAttribute('datetime'), value.updatedAt, 'history dates the current saved conversation');
  assert.ok((await time.innerText()).trim(), 'the saved timestamp is formatted for reading');
  await page.keyboard.press('Tab'); await page.keyboard.press('Escape');
  assert.equal(await time.isVisible(), false);
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'Escape stays in history and restores the menu trigger');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  assert.equal(await row.locator('[data-chat-delete]').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await time.isVisible(), false, 'Tabbing past the menu closes it so it cannot cover the next control');
}
async function credentials(page: Page) {
  const automatic = page.locator('input[name="chat-participation"][value="automatic"]');
  if (await automatic.count() && await automatic.isEnabled()) {
    await openChatParticipation(page);
    await automatic.check();
  }
  if (!await page.locator('#formalize-key').isVisible()) await clickWorkbenchAction(page, '#open-settings');
  await page.locator('#formalize-key').fill('sk-disposable-browser-fixture');
  await openAdvancedChatSettings(page);
  if (await page.locator('#formalize-environment').isEnabled()) await page.locator('#formalize-environment').selectOption('mathlib');
  await page.locator('#formalize-start:enabled').waitFor();
}
async function conversation(page: Page): Promise<WebConversation> {
  const id = new URL(page.url()).searchParams.get('chat'); assert.ok(id, 'Conversation has a stable URL');
  return page.evaluate(async id => (await (await fetch(`/api/conversations/${id}`)).json()).conversation, id);
}
async function openChatHistory(page: Page) {
  if (!await page.locator('#chat-history-list').isVisible()) await page.locator('#open-history').click();
  await page.locator('[data-chat-search]').waitFor();
}
async function expectMessage(page: Page, value: string) {
  await page.waitForFunction(value => document.querySelector('#research-chat-thread')?.textContent?.includes(value), value);
}
async function assertSameComposer(page: Page) {
  assert.equal(await page.evaluate(() => (window as any).__chatComposer === document.querySelector('#formalize-original')), true,
    'The composer is the same DOM node throughout conversation and artifact navigation');
}
async function composerSize(page: Page) {
  return page.locator('#formalize-original').evaluate((input: HTMLTextAreaElement) => {
    const style = getComputedStyle(input);
    return { rows: input.rows, height: input.getBoundingClientRect().height,
      minHeight: Number.parseFloat(style.minHeight), maxHeight: Number.parseFloat(style.maxHeight),
      scrollHeight: input.scrollHeight, clientHeight: input.clientHeight };
  });
}
async function readingPosition(page: Page) {
  return page.locator('#research-chat-thread').evaluate(thread => {
    const top = thread.getBoundingClientRect().top;
    const message = [...thread.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find(node => node.getBoundingClientRect().bottom > top + 4)!;
    return { messageId: message.dataset.messageId!, offset: message.getBoundingClientRect().top - top };
  });
}
async function expectReadingPosition(page: Page, position: { messageId: string; offset: number }) {
  await page.waitForFunction(({ messageId, offset }) => {
    const thread = document.querySelector<HTMLElement>('#research-chat-thread');
    const message = document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    return thread && message && Math.abs(message.getBoundingClientRect().top - thread.getBoundingClientRect().top - offset) < 5;
  }, position);
}
async function readEarlierMessages(page: Page) {
  await page.locator('#research-chat-thread').hover();
  await page.mouse.wheel(0, -10_000);
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#research-chat-thread')!.scrollTop < 10);
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(() => { const top = document.querySelector<HTMLElement>('#research-chat-thread')!.scrollTop;
    return top > 100 && top < 140; });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function openStream(page: Page, text: string) {
  const count = streamReplies.length; streamNextAnswer = true;
  await page.locator('#formalize-original').fill(text); await credentials(page);
  await page.locator('#formalize-start').click();
  await eventually(() => streamReplies.length === count + 1, 'The local provider receives a streaming request');
  await page.locator('#chat-stop').waitFor();
  const message = (await conversation(page)).messages.at(-1)!;
  return { reply: streamReplies.at(-1)!, message: page.locator(`[data-message-id="${message.id}"]`), messageId: message.id };
}
async function waitForAnswerStatus(page: Page, status: 'complete' | 'interrupted') {
  const id = new URL(page.url()).searchParams.get('chat')!;
  await page.waitForFunction(async ({ id, status }) => {
    const { conversation } = await (await fetch(`/api/conversations/${id}`)).json();
    return conversation.messages.at(-1).status === status;
  }, { id, status }, { polling: 500 });
  await page.locator(`.chat-message:last-of-type[data-message-status="${status}"]`).waitFor();
}
try {
  browser = await startBrowser(service.server, port);
  {
    const context = await browser.newContext({ locale: 'zh-CN' });
    const page = await context.newPage();
    try {
      await page.goto(origin); await page.locator('#formalize-original').waitFor();
      await page.evaluate(() => {
        sessionStorage.setItem('theorem-os.chat-draft.anonymous.home', 'Private draft from an earlier anonymous session');
        sessionStorage.setItem('theorem-os.chat-submission.v1.anonymous', JSON.stringify({
          requestId: '11111111-1111-4111-8111-111111111111', digest: 'a'.repeat(64) }));
      });
      await page.reload(); await page.locator('#formalize-original').waitFor();
      assert.equal(await page.locator('#formalize-original').inputValue(), '');
      assert.equal(await page.evaluate(async () => {
        const session = await (await fetch('/api/session')).json();
        return sessionStorage.getItem(`theorem-os.chat-submission.v1.${session.draftOwner}`);
      }), null, 'Unbound anonymous identities must never be assigned to the current owner');
      mark('old anonymous drafts and submission identities do not migrate into a current owner');
    } finally { await context.close(); }
  }
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    const writes: string[] = [];
    page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    try {
      const modelCalls = providerCalls.length, statementCount = formalizations.length, proofCount = runs.length;
      await page.goto(origin); await page.locator('#formalize-original').waitFor();
      const homeSize = await composerSize(page);
      assert.equal(homeSize.rows, 3, 'A new problem retains a multiline input');
      assert.equal(homeSize.minHeight, 92, 'The home composer retains its original minimum height');
      assert.ok(homeSize.height >= 92 && homeSize.height <= 260, 'The home input stays comfortably sized');
      mark(`${width}px: the new-problem input retains three rows and a 92px minimum`);
      const draft = `${width}px: this unlimited home draft must survive refresh without being sent`;
      await page.locator('#formalize-original').fill(draft);
      await blankBudgets(page);
      for (const [index, selector] of budgetInputs.entries()) await page.locator(selector).fill(positiveBudgets[index]);
      for (const selector of budgetInputs) await page.locator(selector).fill('');
      await blankBudgets(page);
      await page.waitForFunction(() => Object.entries(sessionStorage).some(([key, raw]) => {
        if (!key.startsWith('theorem-os.chat-draft.') || !key.endsWith('.home')) return false;
        const settings = JSON.parse(raw).settings;
        return settings?.maxRunSeconds === 0 && settings.maxTotalTokens === 0
          && settings.research?.maxRunSeconds === 0 && settings.research.maxTotalTokens === 0 && settings.research.maxTurns === 0;
      }));
      await page.reload(); await page.locator('#formalize-original').waitFor();
      assert.equal(await page.locator('#formalize-original').inputValue(), draft);
      await blankBudgets(page);
      assert.equal(new URL(page.url()).search, '');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(writes, [], 'editing and restoring a home draft sends no task or provider request');
      assert.equal(providerCalls.length, modelCalls); assert.equal(formalizations.length, statementCount); assert.equal(runs.length, proofCount);
      await screenshot(page, `unlimited-home-draft-${width}.png`);
      mark(`${width}px: home defaults and cleared limits persist as unlimited after refresh without submitting anything`);
    } finally { await context.close(); }
  }
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    const writes: string[] = [];
    page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname); });
    await page.goto(origin); await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), '');
    await page.evaluate(() => { (window as any).__chatComposer = document.querySelector('#formalize-original'); });
    await page.locator('#formalize-original').fill(original); await credentials(page);
    const originalSize = await composerSize(page);
    assert.equal(originalSize.rows, 3);
    assert.ok(originalSize.height >= 92, 'A multiline original does not inherit the compact follow-up height');
    assert.equal(await page.locator('#formalize-original').inputValue(), original, 'Multiline input preserves whitespace before submission');
    if (width === 1440) {
      await page.locator('#formalize-minutes').fill('4'); await page.locator('#formalize-tokens').fill('120000');
      await page.locator('#research-minutes').fill('3'); await page.locator('#research-tokens').fill('80000');
      await page.locator('#research-turns').fill('4');
    } else {
      await blankBudgets(page);
      for (const [index, selector] of budgetInputs.entries()) await page.locator(selector).fill(positiveBudgets[index]);
      assert.equal(await page.locator('#formalize-start').isEnabled(), true, 'explicit user limits keep a valid submission enabled');
      for (const selector of budgetInputs) await page.locator(selector).fill('');
      await blankBudgets(page);
      assert.equal(await page.locator('#formalize-start').isEnabled(), true, 'clearing all limits restores an unlimited, sendable problem');
    }
    if (width === 1440) {
      await page.locator('#formalize-original').press('Shift+Enter'); assert.equal(writes.length, 0);
      await page.locator('#formalize-original').fill(original);
      await page.locator('#formalize-original').evaluate(node => {
        node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
        node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      });
      assert.equal(writes.length, 0, 'IME confirmation must not submit the problem');
      await page.locator('#formalize-original').press('Enter');
      assert.equal(writes.length, 0, 'Enter edits a multiline new problem without submitting');
      assert.equal(await page.locator('#formalize-original').inputValue(), `${original}\n`);
      await page.locator('#formalize-original').fill(original);
      await page.locator('#formalize-original').press('Control+Enter');
    } else await page.locator('#formalize-start').click();
    await page.waitForURL(url => url.searchParams.has('chat'));
    await eventually(() => formalizations.length === (width === 1440 ? 1 : 2), 'One natural formalization starts');
    assert.equal(await page.locator('#formalize-original').inputValue(), '');
    assert.equal((await conversation(page)).messages[0]?.text, original, 'Server message preserves the exact original');
    await page.waitForFunction(() => {
      const input = document.querySelector<HTMLTextAreaElement>('#formalize-original');
      return input?.rows === 1 && Math.abs(input.getBoundingClientRect().height - 56) <= 1;
    });
    const emptySize = await composerSize(page), writesBeforeSizing = writes.length, callsBeforeSizing = providerCalls.length;
    assert.equal(emptySize.minHeight, 56, 'An empty follow-up leaves more room for reading');
    await screenshot(page, `compact-followup-${width}.png`);
    const longDraft = Array.from({ length: 24 }, (_, index) => `第 ${index + 1} 行：请继续解释这个证明步骤及其使用条件。`).join('\n');
    await page.locator('#formalize-original').fill(longDraft);
    await page.waitForFunction(() => document.querySelector('#formalize-original')!.getBoundingClientRect().height >= 259);
    const expandedSize = await composerSize(page);
    assert.equal(await page.locator('#formalize-original').inputValue(), longDraft);
    assert.equal(expandedSize.rows, 1);
    assert.ok(expandedSize.height > emptySize.height && expandedSize.height <= 261, 'A long follow-up grows within the 260px cap');
    assert.ok(expandedSize.scrollHeight > expandedSize.clientHeight, 'Long follow-ups remain editable by scrolling within the cap');
    await screenshot(page, `expanded-followup-${width}.png`);
    await page.locator('#formalize-original').fill('');
    await page.waitForFunction(() => Math.abs(document.querySelector('#formalize-original')!.getBoundingClientRect().height - 56) <= 1);
    if (width === 390) {
      await page.setViewportSize({ width: 320, height: 1000 });
      const narrowSize = await composerSize(page);
      assert.ok(Math.abs(narrowSize.height - 56) <= 1, 'A narrow empty follow-up still occupies one line');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await screenshot(page, 'compact-followup-320.png');
      await page.setViewportSize({ width: 320, height: 480 });
      await page.locator('#formalize-original').fill(longDraft);
      await page.waitForFunction(() => Math.abs(document.querySelector('#formalize-original')!.getBoundingClientRect().height - 96) <= 1);
      const shortSize = await composerSize(page);
      assert.equal(shortSize.maxHeight, 96, 'Short screens retain the 96px input cap');
      assert.ok(shortSize.height <= 97 && shortSize.scrollHeight > shortSize.clientHeight);
      assert.equal(await page.locator('#formalize-original').inputValue(), longDraft, 'The short-screen cap preserves all follow-up text');
      assert.ok((await page.locator('#research-chat-thread').boundingBox())!.height > 0, 'Short screens retain space to read the conversation');
      await screenshot(page, 'expanded-followup-320x480.png');
      await page.locator('#formalize-original').fill('');
      await page.waitForFunction(() => Math.abs(document.querySelector('#formalize-original')!.getBoundingClientRect().height - 56) <= 1);
      await page.setViewportSize({ width, height: 1000 });
    }
    assert.equal(writes.length, writesBeforeSizing, 'Sizing and clearing a follow-up do not submit it');
    assert.equal(providerCalls.length, callsBeforeSizing, 'Editing a follow-up never invokes a model');
    await assertSameComposer(page);
    mark(`${width}px: empty follow-up is 56px, long input grows to 260px, and clearing shrinks it without submitting`);
    const pending = formalizations.at(-1)!;
    assert.equal(pending.input.effort, 'high', 'New formalizations default to high reasoning');
    await outcomes(page);
    if (width === 1440) {
      assert.equal(pending.input.maxRunSeconds, 240); assert.equal(pending.input.maxTotalTokens, 120000);
      assert.equal(pending.input.provider.id, 'sub2api'); assert.equal(pending.input.model, 'deepseek-flash');
    } else assert.deepEqual({ maxRunSeconds: pending.input.maxRunSeconds, maxTotalTokens: pending.input.maxTotalTokens,
      maxRounds: pending.input.maxRounds, maxPlanningRounds: pending.input.maxPlanningRounds },
      { maxRunSeconds: 0, maxTotalTokens: 0, maxRounds: 0, maxPlanningRounds: 0 });
    pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) }); pending.resolve();
    await openChatResultDetails(page);
    await page.locator('[data-research-artifact="source"]:enabled').waitFor();
    await eventually(() => runs.length === formalizations.length, 'The approved formalization starts one proof');
    assert.equal(runs.at(-1)?.input.effort, 'high', 'New proof tasks also default to high after formalization');
    assert.equal((runs.at(-1)?.formalization as { request?: { statement?: string } } | undefined)?.request?.statement, original);
    assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), String(width === 390));
    assert.equal(await page.locator('#research-chat-thread [data-statement-verdict]').innerText(),
      `${width === 390 ? '原题含义：请查看形式化记录。' : 'Lean 编译通过'} Lean 验收证明的是这份陈述，不能替代对自然语言原意的核对。`);
    if (width === 1440) {
      assert.equal(runs.at(-1)?.input.maxRunSeconds, 180); assert.equal(runs.at(-1)?.input.maxTotalTokens, 80000);
      assert.equal(runs.at(-1)?.input.maxTurns, 4);
    } else {
      assert.equal(await page.locator('.research-conversation-state').innerText(), 'Lean 陈述证明通过');
      const { maxRunSeconds, maxTotalTokens, maxTurns } = runs.at(-1)!.input;
      assert.deepEqual({ maxRunSeconds, maxTotalTokens, maxTurns }, { maxRunSeconds: 0, maxTotalTokens: 0, maxTurns: 0 });
      mark('390px: blank defaults submit unlimited formalization and proof budgets; explicit values can be cleared without disabling send');
    }
    await outcomes(page);
    await assertSameComposer(page);
    const sessionUrl = page.url(), id = (await conversation(page)).id;
    await page.locator('#formalize-original').fill(question);
    await page.locator('[data-research-artifact="source"]').click();
    await page.locator('#detail-panel[data-tab="source"]').waitFor();
    if (width === 390) {
      assert.match(await page.locator('#detail-panel .code-scroll code').innerText(), /exact Nat.add_comm n 1/u);
      assert.equal(await page.locator('.source-status.verified').count(), 1, 'Only a recorded accepted run exposes a verified proof');
    }
    await page.locator('#close-research-output').click();
    assert.equal(await page.locator('#formalize-original').inputValue(), question); await assertSameComposer(page);
    await openChatResultDetails(page);
    await page.locator('[data-research-artifact="original"]').click();
    await page.locator('#chat-original-panel').waitFor();
    assert.equal(await page.locator('#chat-original-panel .chat-original-columns .chat-message-text').first().textContent(), original);
    assert.match(await page.locator('#chat-original-panel pre code').first().textContent() ?? '', /theorem addition/u);
    assert.equal(await page.locator('#chat-original-panel .chat-backtranslation').count(), 0, 'Direct generation does not fabricate a blind translation');
    assert.equal(await page.locator('#chat-original-panel .chat-correspondences article').count(), 0, 'Direct generation does not fabricate independent correspondences');
    assert.equal(await page.locator('#chat-original-panel [data-download-statement]').count(), 1, 'The compiled statement remains downloadable');
    await page.locator('#close-research-output').click();
    assert.equal(await page.locator('#formalize-original').inputValue(), question); await assertSameComposer(page);
    const callsBefore = providerCalls.length;
    await page.locator('#formalize-start').click(); await expectMessage(page, answer);
    assert.equal(providerCalls.length, callsBefore + 1);
    assert.equal(writes.filter(path => path === '/api/formalizations').length, 1);
    assert.equal(writes.filter(path => path === '/api/runs').length, 0, 'Browser does not silently launch a new proof for follow-up text');
    assert.equal((await conversation(page)).id, id);
    assert.ok(JSON.stringify(providerCalls.at(-1)?.input).includes(webFormalizationStatement));
    const taskContext = providerCalls.at(-1)?.input[0].content[0].text;
    assert.match(taskContext, width === 390 ? /passed independent Lean acceptance/u : /ended without an independently accepted proof/u);
    assert.doesNotMatch(taskContext, /evaluated_passed|supportsGuidance|resultStatus/u);
    assert.equal(await page.locator('#formalize-key').inputValue(), 'sk-disposable-browser-fixture', 'The key remains in memory for continuous conversation');
    assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes('sk-disposable-browser-fixture')), false);
    let releaseRead: (() => void) | undefined, readHeld = false, readDelivered = false;
    if (width === 1440) {
      const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
      await page.route(`**/api/conversations/${id}`, async route => {
        const response = await route.fetch({ timeout: 15_000 }); readHeld = true;
        await readGate; await route.fulfill({ response }); readDelivered = true;
      }, { times: 1 });
      // Returning to the tab reads the conversation at once; that snapshot predates the next send.
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await eventually(() => readHeld, 'The controller has an old conversation snapshot in flight');
      holdAnswer = true;
    }
    await page.locator('#formalize-original').fill(followup);
    await page.locator('#formalize-start').click();
    await eventually(() => providerCalls.length === callsBefore + 2, 'A second contextual answer reaches the local provider');
    if (width === 1440) {
      await expectMessage(page, followup); await page.locator('#chat-stop').waitFor();
      releaseRead!(); await eventually(() => readDelivered, 'The stale GET response is delivered after the send');
      // Let the fulfilled fetch and Preact update settle, before any subsequent 1.5s poll can repair state.
      await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 150)));
      assert.ok((await page.locator('#research-chat-thread').innerText()).includes(followup), 'A stale GET cannot erase the newly sent user message');
      assert.equal(await page.locator('.chat-message[data-message-status="pending"]').count(), 1,
        'The pending reply remains visible immediately after the stale GET');
      assert.equal(await page.locator('#chat-stop').isVisible(), true);
      releaseAnswer?.(); holdAnswer = false;
      mark('an older in-flight conversation GET cannot overwrite a newly sent message or its pending reply');
    }
    await page.waitForFunction(async id => {
      const { conversation } = await (await fetch(`/api/conversations/${id}`)).json();
      return conversation.messages.at(-1).status === 'complete';
    }, id, { polling: 500 });
    assert.ok(JSON.stringify(providerCalls.at(-1)?.input).includes(question));
    assert.ok(JSON.stringify(providerCalls.at(-1)?.input).includes(answer));
    assert.equal(providerCalls.at(-1)?.input.at(-1).content[0].text, followup);
    await expectMessage(page, followup); await assertSameComposer(page);
    mark(`${width}px: exact original, automatic proof, stable composer, IME and contextual follow-ups`);

    if (width === 1440) {
      await waitForAnswerStatus(page, 'complete');
      let readHeld = false, readDelivered = false, releaseRead!: () => void;
      const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
      await page.route(`**/api/conversations/${id}`, async route => {
        readHeld = true; await readGate;
        await route.fulfill({ status: 503, json: { error: '过期的读取错误' } }); readDelivered = true;
      }, { times: 1 });
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await eventually(() => readHeld, 'The old conversation read remains in flight before another send');
      const { reply, message } = await openStream(page, '成功发送后，旧读取失败不应覆盖这次对话。');
      await message.waitFor();
      releaseRead(); await eventually(() => readDelivered, 'The failed old read returns after the successful send');
      await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 150)));
      assert.equal(await page.locator('#formalize-error').count(), 0, 'A superseded read cannot report a stale error over a successful send');
      reply.delta('本地测试的成功回答。'); reply.complete(); await waitForAnswerStatus(page, 'complete');
      mark('a failed old conversation read cannot overwrite a successful send with a stale error');
    }

    const draft = '保留这条尚未发送的追问';
    await page.locator('#formalize-original').fill(draft);
    const beforeReload = requests.filter(path => path === `GET /api/conversations/${id}`).length;
    await page.reload();
    await expectMessage(page, followup);
    assert.ok(requests.filter(path => path === `GET /api/conversations/${id}`).length - beforeReload <= 4,
      'Reload initializes one controller instead of recursively requesting the same conversation');
    assert.equal(await page.locator('#formalize-original').inputValue(), draft, 'Draft is restored in its own conversation');
    assert.equal(await page.locator('#formalize-key').inputValue(), '');
    await page.locator('#workbench-home').click(); await page.waitForURL(origin + '/');
    assert.equal(await page.locator('#formalize-original').inputValue(), '');
    await page.goBack(); await page.waitForURL(sessionUrl); await expectMessage(page, followup);
    assert.equal(await page.locator('#formalize-original').inputValue(), draft);
    await page.locator('#topbar-draft').click(); await page.waitForURL(origin + '/');
    assert.equal(await page.locator('#formalize-original').inputValue(), '');
    if (width <= 850 || await page.locator('body').getAttribute('data-history-collapsed') === 'true') await page.locator('#open-history').click();
    await historyMetadata(page, id);
    await page.locator(`#chat-history-list a[href="?chat=${id}"]`).click();
    await expectMessage(page, followup);
    assert.equal(await page.locator('#formalize-original').inputValue(), draft);
    assert.equal(writes.filter(path => path === '/api/formalizations').length, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(await audit(page), []);
    await screenshot(page, `conversation-${width}.png`);
    mark(`${width}px: home, new chat, history, browser back, refresh and per-session drafts`);

    if (width === 1440) {
      const input = page.locator('#formalize-original');
      const homeDraft = '一份尚未发送的新题草稿';
      const row = page.locator(`[data-chat-row="${id}"] .chat-history-item`);
      const thread = page.locator(`[data-conversation="${id}"]`);
      const readError = page.locator('#formalize-error');
      const threadPath = `**/api/conversations/${id}`;
      const writeCount = writes.length;
      await page.locator('#workbench-home').click(); await page.waitForURL(origin + '/');
      await input.fill(homeDraft);
      await openChatHistory(page);

      const read = deferred<string | undefined>(), release = deferred();
      await page.route(threadPath, async route => {
        read.resolve(route.request().headers()['if-none-match']);
        await release.promise;
        await route.continue();
      }, { times: 1 });
      const validated = page.waitForResponse(response => response.url().endsWith(`/api/conversations/${id}`));
      try {
        await row.click();
        await thread.getByText(followup, { exact: true }).waitFor({ timeout: 2500 });
        assert.equal(await input.inputValue(), draft, 'The requested draft is editable before the server replies');
        assert.ok(await read.promise, 'Reopening a conversation checks the revision already in memory');
      } finally { release.resolve(); }
      assert.equal((await validated).status(), 304, 'An unchanged conversation needs no response body');
      mark('returning to a conversation restores its messages and draft before the server response');

      await page.locator('#workbench-home').click(); await page.waitForURL(origin + '/');
      await openChatHistory(page);
      await page.route(threadPath, route => route.fulfill({
        status: 500, json: { error: '本地测试：对话读取暂时失败' },
      }), { times: 1 });
      await row.click(); await readError.filter({ hasText: '本地测试：对话读取暂时失败' }).waitFor();
      assert.equal(await page.locator('#research-chat-thread h1').count(), 0);
      assert.equal(await input.inputValue(), draft);
      assert.equal(await thread.getByText(followup, { exact: true }).isVisible(), true, 'Brief failures keep the last available messages readable');
      await readError.waitFor({ state: 'detached', timeout: 5000 });

      await page.locator('#workbench-home').click(); await page.waitForURL(origin + '/');
      assert.equal(await input.inputValue(), homeDraft);
      await openChatHistory(page);
      await page.route(threadPath, route => route.fulfill({
        status: 404, json: { error: '本地测试：找不到对话' },
      }), { times: 1 });
      await row.click(); await readError.filter({ hasText: '本地测试：找不到对话' }).waitFor();
      assert.equal(await thread.count(), 0, 'A missing conversation is removed from the preview');
      await readError.getByRole('button', { name: '重试', exact: true }).click();
      await expectMessage(page, followup);
      assert.equal(await input.inputValue(), draft);
      await page.locator('#workbench-home').click(); await page.waitForURL(origin + '/');
      assert.equal(await input.inputValue(), homeDraft, 'Loading a conversation never replaces the home draft');
      await page.goBack(); await expectMessage(page, followup);
      assert.equal(await input.inputValue(), draft);
      assert.equal(writes.length, writeCount, 'Automatic and explicit history reads send no writes');
      mark('temporary history failures recover promptly and manual retries retain the selected chat and both drafts');
    }

    // In a conversation the composer is at the bottom, so its settings open upwards, above the settings button and on screen.
    const settings = page.locator('#formalize-settings'), settingsOpen = await settings.evaluate(details => (details as HTMLDetailsElement).open);
    await settings.evaluate(details => { (details as HTMLDetailsElement).open = true; });
    await settings.locator(':scope > .chat-settings-fields').waitFor();
    const placement = await settings.evaluate(node => ({ panel: node.querySelector(':scope > .chat-settings-fields')!.getBoundingClientRect().toJSON(),
      button: node.querySelector(':scope > summary')!.getBoundingClientRect().toJSON() }));
    assert.ok(placement.panel.bottom <= placement.button.top && placement.panel.top >= 0, `The settings must open above the composer: ${JSON.stringify(placement)}`);
    await settings.evaluate((details, open) => { (details as HTMLDetailsElement).open = open; }, settingsOpen);
    mark(`${width}px: in a conversation the settings open above the composer`);

    if (width === 1440) {
      await page.route(`**/api/conversations/${id}/messages`, route => route.fulfill({ status: 503, json: { error: '本地测试：暂时不可用' } }), { times: 1 });
      await credentials(page); await page.locator('#formalize-start').click();
      await page.getByText('本地测试：暂时不可用', { exact: true }).waitFor();
      assert.equal(await page.locator('#formalize-original').inputValue(), draft, 'Failed HTTP send retains the unsent draft');
      const read = page.waitForResponse(response => response.url().endsWith(`/api/conversations/${id}`) && (response.ok() || response.status() === 304));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await read;
      await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 150)));
      assert.equal(await page.getByText('本地测试：暂时不可用', { exact: true }).count(), 1, 'A later successful read keeps the failed send in view');
      holdAnswer = true; await credentials(page); await page.locator('#formalize-start').click();
      await page.locator('#chat-stop').waitFor(); await page.locator('#chat-stop').click();
      await page.waitForFunction(async id => {
        const { conversation } = await (await fetch(`/api/conversations/${id}`)).json();
        return conversation.messages.at(-1).status === 'interrupted';
      }, id, { polling: 500 });
      releaseAnswer?.(); holdAnswer = false;
      assert.equal(formalizations.length, 1); assert.equal(runs.length, 1);
      await expectMessage(page, '已停止');
      mark('failed send retains draft; stop interrupts the answer without starting or cancelling proof tasks');

      const formalizationId = (await conversation(page)).formalizationId;
      assert.ok(formalizationId);
      const taskPath = `**/api/formalizations/${formalizationId}`, listPath = '**/api/formalizations';
      let releaseReads!: () => void, taskReads = 0, listReads = 0;
      const heldReads = new Promise<void>(resolve => { releaseReads = resolve; });
      await page.route(taskPath, async route => { taskReads++; await heldReads; await route.continue(); });
      await page.route(listPath, async route => { listReads++; await heldReads; await route.continue(); });
      try {
        const streaming = await openStream(page, '请继续解释证明中的归纳步骤。');
        await eventually(() => taskReads > 0 && listReads > 0, 'The task and record list reads are both pending');
        const partial = '任务和历史仍在加载时显示这段回答。';
        streaming.reply.delta(partial);
        await streaming.message.getByText(partial, { exact: true }).waitFor({ timeout: 4000 });
        assert.deepEqual([taskReads, listReads], [1, 1], 'Polling the answer does not start duplicate task or list reads');
        await page.locator('#chat-stop').click();
        await streaming.message.and(page.locator('[data-message-status="interrupted"]')).waitFor({ timeout: 4000 });
        assert.equal((await conversation(page)).messages.at(-1)?.text, partial);
        mark('a reply shows incoming text and can be stopped while the task and record lists are still loading');
      } finally {
        releaseReads(); await page.unroute(taskPath); await page.unroute(listPath);
      }
    }
    {
      const { reply, message } = await openStream(page, '请给出带公式和完整 Lean 示例的证明说明。');
      const split = richAnswer.indexOf('```lean');
      reply.delta(richAnswer.slice(0, split));
      await message.locator('[data-chat-markdown]').getByRole('heading', { name: '证明思路', exact: true }).waitFor();
      await message.locator('.katex').nth(1).waitFor({ state: 'attached' });
      assert.equal(await message.getAttribute('data-message-status'), 'pending', 'Partial mathematical text is visible before completion');
      assert.ok(await message.locator('.katex').count() >= 2, 'Inline and block mathematics are typeset while the answer is pending');
      reply.delta(richAnswer.slice(split)); reply.complete(); await waitForAnswerStatus(page, 'complete');
      assert.equal((await conversation(page)).messages.at(-1)?.text, richAnswer, 'The saved answer retains the raw Markdown');
      assert.equal(await message.locator('ol li').count(), 2);
      const toggle = message.locator('[data-chat-code-toggle]'); await toggle.waitFor();
      const wasExpanded = await toggle.getAttribute('aria-expanded');
      await toggle.click();
      assert.notEqual(await toggle.getAttribute('aria-expanded'), wasExpanded, 'The long Lean block can expand or fold');
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      await message.locator('[data-chat-code-copy]').click();
      assert.equal((await page.evaluate(() => navigator.clipboard.readText())).trimEnd(), richCode, 'Copy returns Lean source without controls or line numbers');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      mark(`${width}px: streaming Markdown typesets math, retains raw text, and copies/folds the Lean example`);

      await page.locator('#formalize-original').fill('保留阅读位置时写下的草稿');
      await readEarlierMessages(page);
      const position = await readingPosition(page);
      await page.locator('#topbar-draft').click();
      if (width <= 850 || await page.locator('body').getAttribute('data-history-collapsed') === 'true') await page.locator('#open-history').click();
      await page.locator(`#chat-history-list a[href="?chat=${id}"]`).click();
      await expectReadingPosition(page, position);
      assert.equal(await page.locator('#formalize-original').inputValue(), '保留阅读位置时写下的草稿');
      await page.reload(); await expectReadingPosition(page, position);
      mark(`${width}px: conversation switching and refresh restore the message being read and its draft`);

      const partial = await openStream(page, '请分段继续解释，先保留已经输出的内容。');
      const first = '第一段已经输出：这条说明保存在当前对话。\n\n';
      const second = '第二段继续输出：你可以阅读前文，也可以回到最新回答。';
      partial.reply.delta(first); await expectMessage(page, '第一段已经输出');
      assert.equal(await partial.message.getAttribute('data-message-status'), 'pending');
      await readEarlierMessages(page);
      const reading = await readingPosition(page);
      partial.reply.delta(second); await expectMessage(page, '第二段继续输出');
      await expectReadingPosition(page, reading);
      await page.locator('[data-chat-latest]').waitFor(); await page.locator('[data-chat-latest]').click();
      await page.waitForFunction(() => { const thread = document.querySelector<HTMLElement>('#research-chat-thread')!;
        return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 10; });
      const calls = providerCalls.length;
      await page.locator('#formalize-original').fill('流式输出期间未发送的草稿');
      await page.reload(); await expectMessage(page, '第二段继续输出');
      assert.equal(providerCalls.length, calls, 'Refresh reconnects to saved progress without sending another provider request');
      assert.equal(await page.locator(`[data-message-id="${partial.messageId}"]`).getAttribute('data-message-status'), 'pending');
      assert.equal(await page.locator('#formalize-original').inputValue(), '流式输出期间未发送的草稿');
      await page.locator('#chat-stop').click(); await waitForAnswerStatus(page, 'interrupted');
      assert.equal((await conversation(page)).messages.at(-1)?.text, first + second, 'Stopping retains all received text');
      partial.reply.delta('不应出现的迟到内容'); partial.reply.complete();
      await page.reload(); await expectMessage(page, '第二段继续输出');
      assert.equal((await conversation(page)).messages.at(-1)?.text, first + second, 'Stopped text survives refresh and ignores late provider output');
      assert.equal(await page.locator(`[data-message-id="${partial.messageId}"]`).getAttribute('data-message-status'), 'interrupted');
      assert.equal(formalizations.length, width === 1440 ? 1 : 2);
      assert.equal(runs.length, formalizations.length);
      await screenshot(page, `streaming-preserved-${width}.png`);
      mark(`${width}px: incoming text preserves reading position; return-to-latest, pending refresh and stop retain partial output`);
    }
    if (width === 390) {
      // Reproduce a retained, approved statement whose first proof enqueue failed. The retry reuses its task identity.
      const savedConversation = await conversation(page);
      const saved = await page.evaluate(async formalizationId => (await (await fetch(`/api/formalizations/${formalizationId}`)).json()).formalization,
        savedConversation.formalizationId!);
      let resumed = false, continueCalls = 0;
      const formalizationCount = formalizations.length, proofCount = runs.length;
      await page.route(`**/api/conversations/${id}`, route => route.fulfill({ json: { conversation: {
        ...savedConversation, runId: resumed ? savedConversation.runId : undefined,
      } } }));
      await page.route(`**/api/formalizations/${saved.id}`, route => route.fulfill({ json: { formalization: resumed ? saved
        : { ...saved, runId: undefined, researchError: 'formalization_research_queue_failed' } } }));
      await page.route(`**/api/formalizations/${saved.id}/research`, route => {
        continueCalls++; resumed = true; return route.fulfill({ json: { formalization: saved } });
      });
      await page.reload(); await page.locator('[data-research-continue]').waitFor();
      assert.match(await page.locator('[data-formalization-failure]').innerText(), /继续证明/u);
      await page.locator('[data-research-continue]').click();
      await page.locator('#formalize-key').waitFor(); await page.locator('#formalize-key').fill('sk-disposable-browser-fixture');
      await page.locator('#formalize-settings > summary').click();
      await page.locator('[data-research-continue]').click();
      await openChatResultDetails(page);
      await page.locator('[data-research-artifact="source"]:enabled').waitFor();
      assert.equal(continueCalls, 1);
      assert.equal(formalizations.length, formalizationCount, 'Continuing a retained statement does not pay for formalization again');
      assert.equal(runs.length, proofCount, 'The browser uses the returned existing proof identity');
      assert.equal(await page.locator('[data-research-continue]').count(), 0);
      mark('a retained formalization offers one explicit continuation, requests a missing key, and returns to the saved proof without re-formalizing');
    }
    await context.close();
  }
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    let releaseResponse: (() => void) | undefined, responseHeld = false;
    const gate = new Promise<void>(resolve => { releaseResponse = resolve; });
    await page.route('**/api/formalizations', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch({ timeout: 15_000 }); responseHeld = true;
      await gate; await route.fulfill({ response });
    });
    try {
      await page.goto(origin); await page.locator('#formalize-original').fill(original); await credentials(page);
      await page.locator('#formalize-start').click();
      await eventually(() => responseHeld, 'The real formalization request is accepted before delaying its response');
      await page.locator('#topbar-draft').click();
      const nextDraft = '这是新对话里尚未发送的题目';
      await page.locator('#formalize-original').fill(nextDraft);
      releaseResponse!();
      await page.waitForFunction(async () => (await (await fetch('/api/conversations')).json()).conversations.length === 1,
        undefined, { polling: 500 });
      assert.equal(new URL(page.url()).search, '', 'A late first-send response cannot navigate away from the new chat');
      assert.equal(await page.locator('#formalize-original').inputValue(), nextDraft);
      const pending = formalizations.at(-1)!;
      pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) }); pending.resolve();
      await eventually(() => runs.length === 3, 'The original authorized task continues after navigating to a new chat');
      const saved = await page.evaluate(async () => (await (await fetch('/api/conversations')).json()).conversations[0]);
      assert.ok(saved.runId, 'History retains the completed task association');
      assert.equal(new URL(page.url()).search, '');
      assert.equal(await page.locator('#formalize-original').inputValue(), nextDraft);
      await openChatHistory(page);
      await page.locator(`#chat-history-list a[href="?chat=${saved.id}"]`).waitFor();
      await page.locator(`#chat-history-list a[href="?chat=${saved.id}"]`).click();
      await expectMessage(page, webFormalizationStatement);
      assert.equal((await conversation(page)).runId, saved.runId);
      mark('a late first-send response preserves the new blank route and draft while the authorized task remains in history');
    } finally { releaseResponse?.(); await context.close(); }
  }
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    try {
      const started = formalizations.length, proofs = runs.length;
      await page.goto(origin); await page.locator('#formalize-original').fill(original); await credentials(page);
      await page.locator('#formalize-start').click();
      await eventually(() => formalizations.length === started + 1, 'The failing formalization starts');
      const pending = formalizations.at(-1)!;
      await page.waitForURL(url => url.searchParams.has('chat'));
      const historyRow = page.locator(`[data-chat-row="${(await conversation(page)).id}"]`);
      await openChatHistory(page);
      await page.locator('[data-chat-running]').locator(historyRow).waitFor();
      await historyRow.locator('[data-chat-row-actions]').click();
      await historyRow.locator('[data-chat-rename]').click();
      const titleInput = historyRow.locator('[data-chat-title]');
      const draftTitle = 'Renaming while the task finishes';
      await titleInput.fill(draftTitle);
      await titleInput.evaluate((input: HTMLInputElement) => input.setSelectionRange(0, 8));
      pending.send({ type: 'progress', progress: { phase: 'generating', round: 3, tokens: 200_000 } });
      pending.send({ type: 'result', status: 'exhausted', reason: 'formalization_token_limit' }); pending.resolve();
      await historyRow.locator('[data-tone="danger"]').waitFor();
      assert.deepEqual(await titleInput.evaluate((input: HTMLInputElement) => ({
        focused: document.activeElement === input, draft: input.value, selection: [input.selectionStart, input.selectionEnd],
      })), { focused: true, draft: draftTitle, selection: [0, 8] }, 'A task status update preserves the current title edit and selection');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.hasAttribute('data-chat-row-actions'));
      assert.equal(await historyRow.locator('[data-chat-row-actions]').evaluate(node => node === document.activeElement), true, 'Cancel returns to the same conversation after it moves');
      assert.equal(await page.locator('[data-chat-running]').locator(historyRow).count(), 0, 'The conversation moves to its new group after editing');
      if (width <= 850) await page.locator('#close-history').click();
      mark(`${width}px: history keeps the title edit and keyboard focus while a background task changes status`);
      const details = page.locator('[data-formalization-failure]');
      await details.waitFor();
      assert.equal(await page.locator('[data-chat-result-more]').evaluate((element: HTMLDetailsElement) => element.open), false);
      const rows = await details.locator('dt').evaluateAll(nodes => nodes.map(node => [node.textContent,
        node.nextElementSibling?.textContent]));
      assert.deepEqual(rows, [['错误代码', 'formalization_token_limit'], ['停止阶段', '生成 Lean 陈述'],
        ['保留成果', '没有保存可用的 Lean 陈述。']]);
      assert.match(await details.innerText(), /已用完本次 Token 预算，尚未完成形式化。/u);
      assert.match(await details.innerText(), /先核对本次用量和预算/u);
      assert.equal(runs.length, proofs, 'A failed formalization starts no proof');
      // With no proof run, the page is named after the conversation, as a run would name it.
      const named = [...(await conversation(page)).title];
      const pageTitle = `${named.length > 30 ? `${named.slice(0, 29).join('')}…` : named.join('')} · TheoremOS`;
      assert.equal(await page.title(), pageTitle, 'A conversation without a run names the page');
      await page.reload(); await details.waitFor();
      assert.equal(await page.title(), pageTitle, 'A reopened conversation names the page');
      if (width === 1440) {
        const id = (await conversation(page)).id, reads: string[] = [];
        page.on('request', request => { if (new URL(request.url()).pathname === `/api/conversations/${id}`) reads.push(request.method()); });
        await page.waitForTimeout(8000);
        assert.deepEqual(reads, [], 'A conversation with nothing in progress is not re-read every few seconds');
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await eventually(() => reads.length === 1, 'Returning to the tab reads the conversation at once');
        mark('an idle conversation polls slowly and returning to the tab refreshes it at once');
        // The initial request and its transport retry fail. The next successful conditional read clears the error.
        let drops = 0;
        await page.route(`**/api/conversations/${id}`, route => { drops++; return route.abort('internetdisconnected'); }, { times: 2 });
        // The refresh started above may still be running, and a refresh never overlaps another; ask until one reaches the network.
        const readDeadline = Date.now() + 15_000;
        while (!drops) {
          assert.ok(Date.now() < readDeadline, 'The next background refresh reaches the network');
          await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(200);
        }
        await page.locator('#formalize-error').filter({ hasText: '无法连接服务器' }).waitFor();
        assert.equal(drops, 2);
        const revalidated = page.waitForResponse(response => response.url().endsWith(`/api/conversations/${id}`) && response.status() === 304);
        await revalidated;
        await page.locator('#formalize-error').waitFor({ state: 'detached' });
        mark('an unchanged conversation needs no response body and a successful 304 clears a previous background read error');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Failure details fit the width');
      await screenshot(page, `formalization-failure-${width}.png`);
      mark(`${width}px: a failed formalization shows stage, reason, kept work, next step and diagnostic code, and names the page after its conversation`);
    } finally { await context.close(); }
  }
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.route('**/api/conversations', route => route.request().method() === 'GET'
        ? route.fulfill({ status: 503, json: { error: '本地测试：暂时不可用' } }) : route.continue(), { times: 2 });
      await page.goto(origin); await page.locator('#formalize-original').waitFor();
      if (await page.locator('body').getAttribute('data-history-collapsed') === 'true') await page.locator('#open-history').click();
      const failed = page.locator('#chat-history-list [role="alert"]');
      await failed.waitFor();
      assert.match(await failed.innerText(), /对话列表暂时没有加载出来。/u, 'A list that failed to load does not read as an empty history');
      assert.equal(await page.getByText('还没有对话').count(), 0);
      assert.deepEqual(await audit(page), []);
      // This browser is a new owner, so the list that loads on retry is genuinely empty.
      await page.locator('[data-chat-history-retry]').click();
      await page.getByText('还没有对话').waitFor();
      assert.equal(await failed.count(), 0);
      mark('a failed history load says so and retries');
    } finally { await context.close(); }
  }
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    try {
      const calls = providerCalls.length, started = formalizations.length;
      // The first conversation response can precede proof enqueue and arrive after formalization ends.
      // Hold that snapshot so a confirmed task cannot silently switch to idle polling before it gets its run.
      let releaseConversation!: () => void, capturedConversation!: () => void;
      const conversationResponse = new Promise<void>(resolve => { capturedConversation = resolve; });
      const conversationRelease = new Promise<void>(resolve => { releaseConversation = resolve; });
      await page.route('**/api/conversations', async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        const response = await route.fetch({ timeout: 15_000 });
        assert.equal((await response.json()).conversation.runId, undefined, 'The delayed conversation predates proof enqueue');
        capturedConversation(); await conversationRelease;
        await route.fulfill({ response });
      });
      await page.goto(origin); await page.locator('#formalize-original').fill(original); await credentials(page);
      await page.locator('#formalize-start').click();
      await eventually(() => formalizations.length === started + 1, 'The history fixture starts its statement');
      await conversationResponse;
      const pending = formalizations.at(-1)!, proofCount = runs.length;
      pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) }); pending.resolve();
      await eventually(() => runs.length > proofCount, 'The held conversation statement starts its proof');
      releaseConversation();
      await openChatResultDetails(page);
      await page.locator('[data-research-artifact="source"]:enabled').waitFor();
      mark(`${width}px: a delayed conversation response still attaches its completed proof before idle polling`);
      const saved = await conversation(page);
      assert.ok(saved.runId && saved.formalizationId);
      await page.reload(); await expectMessage(page, webFormalizationStatement);
      await openChatHistory(page);
      const row = page.locator(`[data-chat-row="${saved.id}"]`), title = `History ${width}: additive identity`;
      await historyMetadata(page, saved.id);
      await page.clock.install();
      const refreshVisibleHistory = async () => {
        // Allow the previous history refresh to remain fresh for its full interval.
        await page.clock.setSystemTime(await page.evaluate(() => Date.now() + 6100));
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      };
      let releaseHistory!: () => void, historyHeld = false, historyDelivered = false;
      const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
      await page.route('**/api/conversations', async route => {
        const response = await route.fetch({ timeout: 15_000 }); historyHeld = true;
        await historyGate; await route.fulfill({ response }); historyDelivered = true;
      }, { times: 1 });
      await refreshVisibleHistory();
      await eventually(() => historyHeld, 'The history snapshot predates the title change');
      await row.locator('[data-chat-row-actions]').click();
      await row.locator('[data-chat-rename]').click();
      assert.equal(await row.locator('[data-chat-title]').evaluate(node => node === document.activeElement), true, 'Rename opens with the title focused');
      await row.locator('[data-chat-title]').fill(title);
      await row.locator('[data-chat-history-confirm]').click();
      await row.locator('a.chat-history-item').filter({ hasText: title }).waitFor();
      releaseHistory(); await eventually(() => historyDelivered, 'The old history arrives after the title update');
      await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 150)));
      assert.equal(await row.locator('.chat-history-copy > span:first-child').innerText(), title, 'A stale list cannot restore the previous conversation title');
      await historyMetadata(page, saved.id);
      await page.locator('[data-chat-search]').fill('NO MATCHING CONVERSATION');
      await row.waitFor({ state: 'detached' });
      await page.getByText('没有匹配的对话', { exact: true }).waitFor();
      await page.locator('[data-chat-search]').fill('ADDITIVE IDENTITY');
      await row.waitFor();
      await page.reload(); await expectMessage(page, webFormalizationStatement);
      assert.equal((await conversation(page)).title, title, 'The renamed conversation persists after refresh');
      await openChatHistory(page);
      assert.equal(await row.locator('.chat-history-copy > span:first-child').innerText(), title);
      await historyMetadata(page, saved.id);
      mark(`${width}px: conversation search filters titles and a renamed title survives refresh`);

      await page.locator('#chat-problem-records > summary').click();
      const linked = page.locator(`[data-chat-record="${saved.formalizationId}"]`);
      await linked.locator('[data-chat-delete-record]:enabled').waitFor();
      await linked.locator('[data-chat-delete-record]').click();
      const rejected = page.waitForResponse(response => response.request().method() === 'DELETE'
        && new URL(response.url()).pathname === `/api/formalizations/${saved.formalizationId}`);
      await linked.locator('[data-chat-history-confirm]').click();
      assert.equal((await rejected).status(), 409);
      await linked.locator('[role="alert"]').filter({ hasText: '已有研究使用这份原题' }).waitFor();
      await linked.getByRole('button', { name: '取消', exact: true }).click();
      let releaseDeletedHistory!: () => void, deletedHistoryHeld = false, deletedHistoryDelivered = false;
      const deletedHistoryGate = new Promise<void>(resolve => { releaseDeletedHistory = resolve; });
      await page.route('**/api/conversations', async route => {
        const response = await route.fetch({ timeout: 15_000 }); deletedHistoryHeld = true;
        await deletedHistoryGate; await route.fulfill({ response }); deletedHistoryDelivered = true;
      }, { times: 1 });
      await refreshVisibleHistory();
      await eventually(() => deletedHistoryHeld, 'A history snapshot predates conversation deletion');
      await row.locator('[data-chat-row-actions]').click();
      await row.locator('[data-chat-delete]').click();
      assert.equal(await row.locator('[data-chat-history-cancel]').evaluate(node => node === document.activeElement), true, 'Delete puts initial focus on Cancel');
      assert.match(await row.locator('.chat-history-edit').innerText(), /只删除这段对话，题目、证明任务和分享链接仍保留。/u);
      await row.locator('[data-chat-history-confirm]').click();
      await page.waitForURL(url => !url.search);
      await row.waitFor({ state: 'detached' });
      releaseDeletedHistory(); await eventually(() => deletedHistoryDelivered, 'The old list returns after deletion');
      await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 150)));
      assert.equal(await row.count(), 0, 'An older history response cannot restore a deleted conversation');
      mark(`${width}px: older history responses cannot undo a rename or restore a deleted conversation`);
      const retained = await page.evaluate(async ({ id, runId, formalizationId }) => ({
        conversation: (await fetch(`/api/conversations/${id}`)).status,
        run: (await fetch(`/api/runs/${runId}`)).status,
        formalization: (await fetch(`/api/formalizations/${formalizationId}`)).status,
      }), saved);
      assert.deepEqual(retained, { conversation: 404, run: 200, formalization: 200 });
      mark(`${width}px: a linked statement refuses deletion with a reason; deleting the current conversation returns home and keeps the proof task and statement`);

      if (width <= 850 && await page.locator('#history-dialog[open]').count()) await page.keyboard.press('Escape');
      assert.equal(await page.locator('#chat-problem-records[open]').count(), 1, 'Record management remains expanded while a new statement is created');
      await page.locator('#formalize-original').fill(original); await credentials(page);
      await page.locator('#formalize-start').click();
      await eventually(() => formalizations.length === started + 2, 'The removable statement fixture starts');
      const stopped = formalizations.at(-1)!;
      stopped.send({ type: 'result', status: 'exhausted', reason: 'formalization_token_limit' }); stopped.resolve();
      await openChatResultDetails(page);
      await page.locator('[data-formalization-failure]').waitFor();
      const unlinked = await conversation(page);
      assert.equal(unlinked.runId, undefined);
      await openChatHistory(page);
      assert.equal(await page.locator('#chat-problem-records[open]').count(), 1, 'The expanded record list updates without toggling it');
      const record = page.locator(`[data-chat-record="${unlinked.formalizationId}"]`);
      await record.locator('[data-chat-delete-record]:enabled').waitFor();
      let releaseRecords!: () => void, recordsHeld = false, recordsDelivered = false;
      const recordsGate = new Promise<void>(resolve => { releaseRecords = resolve; });
      await page.route('**/api/formalizations', async route => {
        const response = await route.fetch({ timeout: 15_000 }); recordsHeld = true;
        await recordsGate; await route.fulfill({ response }); recordsDelivered = true;
      }, { times: 1 });
      await page.locator('#chat-problem-records > summary').click();
      await page.locator('#chat-problem-records > summary').click();
      await eventually(() => recordsHeld, 'The record list snapshot predates deletion');
      await record.locator('[data-chat-delete-record]').click();
      const removed = page.waitForResponse(response => response.request().method() === 'DELETE'
        && new URL(response.url()).pathname === `/api/formalizations/${unlinked.formalizationId}`);
      await record.locator('[data-chat-history-confirm]').click();
      assert.equal((await removed).status(), 200);
      await record.waitFor({ state: 'detached' });
      releaseRecords(); await eventually(() => recordsDelivered, 'The old record list returns after deletion');
      await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 150)));
      assert.equal(await record.count(), 0, 'An old capabilities response cannot restore a deleted statement record');
      mark(`${width}px: a deleted statement stays removed when an older record list arrives`);
      assert.equal(await page.evaluate(async id => (await fetch(`/api/formalizations/${id}`)).status, unlinked.formalizationId), 404);
      const kept = await conversation(page);
      assert.equal(kept.id, unlinked.id);
      assert.equal(kept.messages[0]?.text, original, 'Removing a statement retains the original conversation');
      if (width <= 850) await page.keyboard.press('Escape');
      else await page.locator('#open-history').click();
      await page.locator('#research-chat-thread .research-conversation-state').filter({ hasText: '关联任务记录已删除' }).waitFor();
      assert.equal(await page.getByText('正在读取任务', { exact: true }).count(), 0, 'A removed record has a terminal state rather than an endless load');
      await page.locator('#research-chat-thread').getByRole('button', { name: '修改题目', exact: true }).click();
      await page.waitForURL(url => url.searchParams.get('editProblem') === unlinked.id);
      assert.equal(await page.locator('#formalize-original').inputValue(), original, 'Editing the retained conversation restores the exact original draft');
      const editedSize = await composerSize(page);
      assert.equal(editedSize.rows, 3, 'Editing an original problem restores multiline input');
      assert.equal(editedSize.minHeight, 92);
      assert.ok(editedSize.height >= 92, 'An edited original retains room for the complete problem');
      await page.locator('[data-chat-return-home]').click();
      await page.waitForURL(url => !url.search);
      assert.equal(formalizations.length, started + 2, 'Restoring the draft does not create a statement');
      assert.equal(providerCalls.length, calls, 'History management never invokes the model');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      mark(`${width}px: an expanded record list shows the new statement; removal has a terminal state and restores the original for editing`);
    } finally { await context.close(); }
  }
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    const page = await context.newPage(), ids: string[] = [];
    try {
      await page.goto(origin); await page.locator('#formalize-original').fill('First queued browser problem'); await credentials(page);
      let response = page.waitForResponse(reply => reply.request().method() === 'POST' && new URL(reply.url()).pathname === '/api/formalizations');
      await page.locator('#formalize-start').click(); ids.push((await (await response).json()).formalization.id);
      await page.waitForURL(url => url.searchParams.has('chat'));
      await page.locator('#topbar-draft').click();
      await page.locator('#formalize-original').fill('Second queued browser problem'); await credentials(page);
      assert.equal(await page.locator('#formalize-start').isEnabled(), true, 'One active task leaves a second owner slot');
      response = page.waitForResponse(reply => reply.request().method() === 'POST' && new URL(reply.url()).pathname === '/api/formalizations');
      await page.locator('#formalize-start').click(); const second = (await (await response).json()).formalization; ids.push(second.id);
      assert.equal(second.status, 'queued'); assert.equal(second.queue.position, 1);
      await page.locator('[data-formalization-queue]').filter({ hasText: '排队第 1 位' }).waitFor();
      await page.locator('#topbar-draft').click(); await page.locator('#formalize-original').fill('Third problem waits');
      assert.equal(await page.locator('#formalize-start').isDisabled(), true, 'Two active tasks fill this owner queue');
      mark('same-owner chat accepts a second task, displays FIFO and disables a third');
    } finally {
      await page.evaluate(async ids => {
        const session = await (await fetch('/api/session')).json();
        for (const id of ids) await fetch(`/api/formalizations/${id}/cancel`, { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken } });
      }, ids).catch(() => {});
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(),
    paidModelCalls: false, browserTimeouts: 0, providerIdleTimeout: 0, deadline: null, tokenLimit: null, roundLimit: null,
    realModelCalls: 0, realLeanProcesses: 0, mode: 'real Chromium, disposable HTTP services and a loopback response fixture; positive input budgets test propagation only', checks, screenshots }, null, 2) + '\n');
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', paidModelCalls: false, checks, screenshots,
    error: error instanceof Error ? error.message : String(error), url: activePage?.url(), requests }, null, 2) + '\n');
  throw error;
} finally { releaseAnswer?.(); await browser?.close(); await service.close(); provider.stop(true); await fs.rm(temporary, { recursive: true, force: true }); }
