#!/usr/bin/env bun
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
import { webFormalizationEvidence, webFormalizationStatement } from '../tests/helpers/webFormalizationFixture';
import { audit } from './web-a11y';
import { freePort, startBrowser } from './web-scenario';

declare const Bun: { serve(options: { hostname: string; port: number; idleTimeout?: number; fetch(request: Request): Response | Promise<Response> }): { port: number; stop(force?: boolean): void } };

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/web-chat-session');
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
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 60, async fetch(request) {
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
  async readiness() { return { ready: true, message: 'Disposable chat browser fixture' }; },
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
let browser: Browser | undefined, activePage: Page | undefined;
const checks: string[] = [], errors: string[] = [], requests: string[] = [];
const mark = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
async function eventually(check: () => boolean, description: string) {
  const until = Date.now() + 15_000;
  while (!check()) { assert.ok(Date.now() < until, description); await new Promise(resolve => setTimeout(resolve, 40)); }
}
async function credentials(page: Page) {
  if (!await page.locator('#formalize-key').isVisible()) await page.locator('#open-settings').click();
  await page.locator('#formalize-key').fill('sk-disposable-browser-fixture');
  if (await page.locator('#formalize-environment').isEnabled()) await page.locator('#formalize-environment').selectOption('standard');
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
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    const writes: string[] = [];
    page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname); });
    await page.goto(origin); await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), '');
    await page.evaluate(() => { (window as any).__chatComposer = document.querySelector('#formalize-original'); });
    await page.locator('#formalize-original').fill(original); await credentials(page);
    if (width === 1440) {
      await page.locator('#formalize-minutes').fill('4'); await page.locator('#formalize-tokens').fill('120000');
      await page.locator('#research-minutes').fill('3'); await page.locator('#research-tokens').fill('80000');
      await page.locator('#research-turns').fill('4');
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
    } else await page.locator('#formalize-start').click();
    await page.waitForURL(url => url.searchParams.has('chat'));
    await eventually(() => formalizations.length === (width === 1440 ? 1 : 2), 'One natural formalization starts');
    assert.equal(await page.locator('#formalize-original').inputValue(), '');
    assert.equal((await conversation(page)).messages[0]?.text, original, 'Server message preserves the exact original');
    const pending = formalizations.at(-1)!;
    if (width === 1440) {
      assert.equal(pending.input.maxRunSeconds, 240); assert.equal(pending.input.maxTotalTokens, 120000);
      assert.equal(pending.input.provider.id, 'sub2api'); assert.equal(pending.input.model, 'deepseek-flash');
    } else {
      assert.equal(pending.input.maxRunSeconds, 0, 'Blank formalization time reaches the worker as unlimited');
      assert.equal(pending.input.maxTotalTokens, 0, 'Blank formalization tokens reach the worker as unlimited');
    }
    pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) }); pending.resolve();
    await page.locator('[data-research-artifact="source"]:enabled').waitFor();
    await eventually(() => runs.length === formalizations.length, 'The approved formalization starts one proof');
    assert.equal((runs.at(-1)?.formalization as { request?: { statement?: string } } | undefined)?.request?.statement, original);
    assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), String(width === 390));
    assert.match(await page.locator('#research-chat-thread [data-statement-verdict]').innerText(), /模型审核通过，未经人工确认/u);
    if (width === 1440) {
      assert.equal(runs.at(-1)?.input.maxRunSeconds, 180); assert.equal(runs.at(-1)?.input.maxTotalTokens, 80000);
      assert.equal(runs.at(-1)?.input.maxTurns, 4);
    } else {
      assert.equal(runs.at(-1)?.input.maxRunSeconds, 0, 'Blank proof time reaches the worker as unlimited');
      assert.equal(runs.at(-1)?.input.maxTotalTokens, 0, 'Blank proof tokens reach the worker as unlimited');
      assert.equal(runs.at(-1)?.input.maxTurns, 0, 'Blank proof turns reach the worker as unlimited');
      assert.equal(await page.locator('.research-conversation-state').innerText(), 'Lean 陈述证明通过');
    }
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
    await page.locator('[data-research-artifact="original"]').click();
    await page.locator('#chat-original-panel').waitFor();
    assert.equal(await page.locator('#chat-original-panel .chat-original-columns .chat-message-text').first().textContent(), original);
    assert.match(await page.locator('#chat-original-panel pre code').first().textContent() ?? '', /theorem addition/u);
    assert.equal(await page.locator('#chat-original-panel .chat-backtranslation .chat-message-text').textContent(), original);
    assert.ok(await page.locator('#chat-original-panel .chat-correspondences article').count() > 0,
      'The conversation still exposes specific natural-language/Lean correspondences');
    await page.locator('#close-research-output').click();
    assert.equal(await page.locator('#formalize-original').inputValue(), question); await assertSameComposer(page);
    const callsBefore = providerCalls.length;
    await page.locator('#formalize-start').click(); await expectMessage(page, answer);
    assert.equal(providerCalls.length, callsBefore + 1);
    assert.equal(writes.filter(path => path === '/api/formalizations').length, 1);
    assert.equal(writes.filter(path => path === '/api/runs').length, 0, 'Browser does not silently launch a new proof for follow-up text');
    assert.equal((await conversation(page)).id, id);
    assert.ok(JSON.stringify(providerCalls.at(-1)?.input).includes(webFormalizationStatement));
    assert.ok(providerCalls.at(-1)?.input[0].content[0].text.includes(`"accepted":${width === 390}`));
    assert.equal(await page.locator('#formalize-key').inputValue(), 'sk-disposable-browser-fixture', 'The key remains in memory for continuous conversation');
    assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes('sk-disposable-browser-fixture')), false);
    let releaseRead: (() => void) | undefined, readHeld = false, readDelivered = false;
    if (width === 1440) {
      const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
      await page.route(`**/api/conversations/${id}`, async route => {
        const response = await route.fetch(); readHeld = true;
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
    await page.locator(`#chat-history-list a[href="?chat=${id}"]`).click();
    await expectMessage(page, followup);
    assert.equal(await page.locator('#formalize-original').inputValue(), draft);
    assert.equal(writes.filter(path => path === '/api/formalizations').length, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(await audit(page), []);
    await page.screenshot({ path: path.join(output, `conversation-${width}.png`), fullPage: true });
    mark(`${width}px: home, new chat, history, browser back, refresh and per-session drafts`);

    // In a conversation the composer is at the bottom, so its settings open upwards, above the settings button and on screen.
    const settings = page.locator('#formalize-settings'), settingsOpen = await settings.evaluate(details => (details as HTMLDetailsElement).open);
    await settings.evaluate(details => { (details as HTMLDetailsElement).open = true; });
    await page.locator('.chat-settings-fields').waitFor();
    const placement = await page.evaluate(() => ({ panel: document.querySelector('.chat-settings-fields')!.getBoundingClientRect().toJSON(),
      button: document.querySelector('#formalize-settings > summary')!.getBoundingClientRect().toJSON() }));
    assert.ok(placement.panel.bottom <= placement.button.top && placement.panel.top >= 0, `The settings must open above the composer: ${JSON.stringify(placement)}`);
    await settings.evaluate((details, open) => { (details as HTMLDetailsElement).open = open; }, settingsOpen);
    mark(`${width}px: in a conversation the settings open above the composer`);

    if (width === 1440) {
      await page.route(`**/api/conversations/${id}/messages`, route => route.fulfill({ status: 503, json: { error: '本地测试：暂时不可用' } }), { times: 1 });
      await credentials(page); await page.locator('#formalize-start').click();
      await page.getByText('本地测试：暂时不可用', { exact: true }).waitFor();
      assert.equal(await page.locator('#formalize-original').inputValue(), draft, 'Failed HTTP send retains the unsent draft');
      const read = page.waitForResponse(response => response.url().endsWith(`/api/conversations/${id}`) && response.ok());
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
    }
    {
      const { reply, message } = await openStream(page, '请给出带公式和完整 Lean 示例的证明说明。');
      const split = richAnswer.indexOf('```lean');
      reply.delta(richAnswer.slice(0, split));
      await message.locator('[data-chat-markdown]').getByRole('heading', { name: '证明思路', exact: true }).waitFor();
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
      await page.screenshot({ path: path.join(output, `streaming-preserved-${width}.png`), fullPage: true });
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
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    let releaseResponse: (() => void) | undefined, responseHeld = false;
    const gate = new Promise<void>(resolve => { releaseResponse = resolve; });
    await page.route('**/api/formalizations', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(); responseHeld = true;
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
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    try {
      const started = formalizations.length, proofs = runs.length;
      await page.goto(origin); await page.locator('#formalize-original').fill(original); await credentials(page);
      await page.locator('#formalize-start').click();
      await eventually(() => formalizations.length === started + 1, 'The failing formalization starts');
      const pending = formalizations.at(-1)!;
      pending.send({ type: 'progress', progress: { phase: 'generating', round: 3, tokens: 200_000 } });
      pending.send({ type: 'result', status: 'exhausted', reason: 'formalization_token_limit' }); pending.resolve();
      const details = page.locator('[data-formalization-failure]');
      await details.waitFor();
      const rows = await details.locator('dt').evaluateAll(nodes => nodes.map(node => [node.textContent,
        node.nextElementSibling?.textContent]));
      assert.deepEqual(rows, [['停止阶段', '生成 Lean 陈述'], ['原因', '已用完本次 Token 预算，尚未完成形式化。'],
        ['保留成果', '没有保存可用的 Lean 陈述。'], ['下一步', '修改题目后重新发送；不会自动重试。'],
        ['诊断编号', 'formalization_token_limit']]);
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
        // A read that fails while the network is down says so; the read after the connection returns clears it.
        let dropped = false;
        await page.route(`**/api/conversations/${id}`, route => { dropped = true; return route.abort('internetdisconnected'); }, { times: 1 });
        // The refresh started above may still be running, and a refresh never overlaps another; ask until one reaches the network.
        for (let attempt = 0; !dropped && attempt < 50; attempt++) {
          await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(200);
        }
        await page.locator('#formalize-error').filter({ hasText: '无法连接服务器' }).waitFor();
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await page.locator('#formalize-error').waitFor({ state: 'detached' });
        mark('a failed background read shows until the connection returns, and the next read clears it');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Failure details fit the width');
      await page.screenshot({ path: path.join(output, `formalization-failure-${width}.png`), fullPage: true });
      mark(`${width}px: a failed formalization shows stage, reason, kept work, next step and diagnostic code, and names the page after its conversation`);
    } finally { await context.close(); }
  }
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.route('**/api/conversations', route => route.request().method() === 'GET'
        ? route.fulfill({ status: 503, json: { error: '本地测试：暂时不可用' } }) : route.continue(), { times: 1 });
      await page.goto(origin); await page.locator('#formalize-original').waitFor();
      if (await page.locator('body').getAttribute('data-history-collapsed') === 'true') await page.locator('#open-history').click();
      const failed = page.locator('#chat-history-list [role="alert"]');
      await failed.waitFor();
      assert.match(await failed.innerText(), /对话列表暂时没有加载出来。/u, 'A list that failed to load does not read as an empty history');
      assert.equal(await page.getByText('新对话会保存在这里').count(), 0);
      assert.deepEqual(await audit(page), []);
      // This browser is a new owner, so the list that loads on retry is genuinely empty.
      await page.locator('[data-chat-history-retry]').click();
      await page.getByText('新对话会保存在这里').waitFor();
      assert.equal(await failed.count(), 0);
      const missing = '00000000-0000-4000-8000-000000000000';
      await page.route(`**/api/conversations/${missing}`, route => route.fulfill({ status: 429, body: '' }), { times: 1 });
      await page.goto(`${origin}/?chat=${missing}`);
      await page.getByText('请求太频繁，请稍后再试。').first().waitFor();
      mark('a failed history load says so and retries; a rate-limited read names the limit');
    } finally { await context.close(); }
  }
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    try {
      const calls = providerCalls.length, started = formalizations.length;
      await page.goto(origin); await page.locator('#formalize-original').fill(original); await credentials(page);
      await page.locator('#formalize-start').click();
      await eventually(() => formalizations.length === started + 1, 'The history fixture starts its statement');
      const pending = formalizations.at(-1)!;
      pending.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(pending.input) }); pending.resolve();
      await page.locator('[data-research-artifact="source"]:enabled').waitFor();
      const saved = await conversation(page);
      assert.ok(saved.runId && saved.formalizationId);
      await openChatHistory(page);
      const row = page.locator(`[data-chat-row="${saved.id}"]`), title = `History ${width}: additive identity`;
      await row.locator('[data-chat-rename]').click();
      await row.locator('[data-chat-title]').fill(title);
      await row.locator('[data-chat-history-confirm]').click();
      await row.locator('a.chat-history-item').filter({ hasText: title }).waitFor();
      await page.locator('[data-chat-search]').fill('NO MATCHING CONVERSATION');
      await row.waitFor({ state: 'detached' });
      await page.getByText('没有匹配的对话', { exact: true }).waitFor();
      await page.locator('[data-chat-search]').fill('ADDITIVE IDENTITY');
      await row.waitFor();
      await page.reload(); await expectMessage(page, webFormalizationStatement);
      assert.equal((await conversation(page)).title, title, 'The renamed conversation persists after refresh');
      await openChatHistory(page);
      assert.equal(await row.locator('a.chat-history-item').innerText(), title);
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
      await row.locator('[data-chat-delete]').click();
      assert.match(await row.locator('.chat-history-edit').innerText(), /只删除这段对话，题目、证明任务和分享链接仍保留。/u);
      await row.locator('[data-chat-history-confirm]').click();
      await page.waitForURL(url => !url.search);
      await row.waitFor({ state: 'detached' });
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
      await page.locator('[data-formalization-failure]').waitFor();
      const unlinked = await conversation(page);
      assert.equal(unlinked.runId, undefined);
      await openChatHistory(page);
      assert.equal(await page.locator('#chat-problem-records[open]').count(), 1, 'The expanded record list updates without toggling it');
      const record = page.locator(`[data-chat-record="${unlinked.formalizationId}"]`);
      await record.locator('[data-chat-delete-record]:enabled').waitFor();
      await record.locator('[data-chat-delete-record]').click();
      const removed = page.waitForResponse(response => response.request().method() === 'DELETE'
        && new URL(response.url()).pathname === `/api/formalizations/${unlinked.formalizationId}`);
      await record.locator('[data-chat-history-confirm]').click();
      assert.equal((await removed).status(), 200);
      await record.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(async id => (await fetch(`/api/formalizations/${id}`)).status, unlinked.formalizationId), 404);
      const kept = await conversation(page);
      assert.equal(kept.id, unlinked.id);
      assert.equal(kept.messages[0]?.text, original, 'Removing a statement retains the original conversation');
      if (width <= 850) await page.keyboard.press('Escape');
      else await page.locator('#open-history').click();
      await page.locator('#research-chat-thread .research-conversation-state').filter({ hasText: '关联任务记录已删除' }).waitFor();
      assert.equal(await page.getByText('正在读取任务', { exact: true }).count(), 0, 'A removed record has a terminal state rather than an endless load');
      await page.locator('#research-chat-thread').getByRole('button', { name: '修改题目', exact: true }).click();
      await page.waitForURL(url => !url.search);
      assert.equal(await page.locator('#formalize-original').inputValue(), original, 'Editing the retained conversation restores the exact original draft');
      assert.equal(formalizations.length, started + 2, 'Restoring the draft does not create a statement');
      assert.equal(providerCalls.length, calls, 'History management never invokes the model');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      mark(`${width}px: an expanded record list shows the new statement; removal has a terminal state and restores the original for editing`);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', paidModelCalls: false, checks }, null, 2) + '\n');
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', paidModelCalls: false, checks,
    error: error instanceof Error ? error.message : String(error), url: activePage?.url(), requests }, null, 2) + '\n');
  throw error;
} finally { releaseAnswer?.(); await browser?.close(); await service.close(); provider.stop(true); await fs.rm(temporary, { recursive: true, force: true }); }
