#!/usr/bin/env bun
import assert from 'node:assert/strict';
import path from 'node:path';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebConversation, WebConversationSummary } from '../apps/web/conversationTypes';
import { freePort, startBrowser } from './web-scenario';
import { clickWorkbenchAction } from './web-ui-controls';

const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.resolve(import.meta.dirname, '../out/web') });
const service = createWebService(config, {
  async readiness() { return { ready: true, message: 'Local rate limit fixture' }; },
  async run() { throw new Error('Rate limit checks never start research'); },
});
const browser = await startBrowser(service.server, port);
try {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const failed = page.locator('#formalize-error');
  const limit = failed.filter({ hasText: '请求太频繁，请稍后再试。' });
  const missing = '00000000-0000-4000-8000-000000000000';
  let throttled = 0;
  await page.route(`**/api/conversations/${missing}`, route => {
    throttled++;
    return route.fulfill({ status: 429, body: '' });
  });
  await page.goto(`${origin}/?chat=${missing}`); await limit.waitFor();
  assert.equal(throttled, 2, 'An edge 429 without a reason gets one retry');
  let quota = 0;
  await page.route(`**/api/conversations/${missing}`, route => {
    quota++;
    return route.fulfill({ status: 429, json: { error: '本地测试：额度已用完' } });
  });
  await page.reload(); await failed.filter({ hasText: '本地测试：额度已用完' }).waitFor();
  assert.equal(quota, 1, 'A quota 429 with a reason is shown without retrying');
  console.log('PASS edge limits get one retry and quota errors surface immediately');

  const waiting = '00000000-0000-4000-8000-000000000001', next = '00000000-0000-4000-8000-000000000002';
  const capped = '00000000-0000-4000-8000-000000000003', stamp = new Date().toISOString();
  const records: WebConversationSummary[] = [waiting, next, capped].map((id, index) =>
    ({ id, title: `本地对话 ${index + 1}`, createdAt: stamp, updatedAt: stamp, answering: false }));
  const loaded = (id: string): WebConversation => ({ ...records.find(item => item.id === id)!,
    messages: [{ id, role: 'user', kind: 'text', text: `本地记录 ${id.at(-1)}`, createdAt: stamp, status: 'complete' }] });
  await page.route('**/api/conversations', route => route.fulfill({ json: { conversations: records } }));
  let abandonedReads = 0;
  await page.route(`**/api/conversations/${waiting}`, route => {
    abandonedReads++;
    return route.fulfill({ status: 429, contentType: 'application/problem+json',
      json: { cloudflare_error: true, error_code: 1015, retryable: true, retry_after: 8 } });
  });
  await page.route(`**/api/conversations/${next}`, route => route.fulfill({ json: { conversation: loaded(next) } }));
  await page.goto(origin); await page.clock.install();
  const open = async (id: string) => {
    if (!await page.locator('#chat-history-list').isVisible()) await page.locator('#open-history').click();
    await page.locator(`[data-chat-row="${id}"] .chat-history-item`).click();
  };
  const message = (text: string) => page.locator('#research-chat-thread').getByText(text, { exact: true });
  const limitedRead = page.waitForResponse(response => response.url().endsWith(`/api/conversations/${waiting}`));
  await open(waiting); await limitedRead;
  await open(waiting);
  await open(next); await message('本地记录 2').waitFor();
  await page.clock.fastForward(10_000);
  assert.equal(abandonedReads, 1, 'Repeated clicks and the abandoned read send no further requests');
  assert.equal(await failed.count(), 0);
  console.log('PASS switching history cancels a throttled read and leaves the latest chat usable');

  let cappedReads = 0;
  const retryAt = new Date(await page.evaluate(() => Date.now()) + 60_000).toUTCString();
  await page.route(`**/api/conversations/${capped}`, route => ++cappedReads === 1
    ? route.fulfill({ status: 429, body: '', headers: { 'Retry-After': retryAt } })
    : route.fulfill({ json: { conversation: loaded(capped) } }));
  await open(capped); await limit.waitFor({ timeout: 4_000 });
  await page.clock.fastForward(8_000);
  await limit.getByRole('button', { name: '重试' }).click(); await limit.waitFor();
  assert.equal(cappedReads, 1, 'A long Retry-After date prevents both early automatic and manual requests');
  await page.clock.fastForward(60_000); await message('本地记录 3').waitFor();
  assert.equal(cappedReads, 2, 'The conversation refreshes after the requested wait');
  console.log('PASS the full Retry-After window is honored and reading resumes when it ends');

  let otherChatReads = 0;
  await page.route(`**/api/conversations/${waiting}`, route => route.fulfill({
    status: 429, json: { error: '请求过于频繁，请稍后重试。' },
    headers: { 'Retry-After': '60', 'X-Theoremos-Rate-Limit-Scope': 'api' },
  }));
  await page.route(`**/api/conversations/${next}`, route => {
    otherChatReads++;
    return route.fulfill({ json: { conversation: loaded(next) } });
  });
  await open(waiting); await failed.filter({ hasText: '请求过于频繁，请稍后重试。' }).waitFor();
  await open(next); await limit.waitFor();
  await page.clock.fastForward(10_000);
  assert.equal(otherChatReads, 0, 'The server address limit suppresses requests for other chats too');
  await page.clock.fastForward(60_000); await message('本地记录 2').waitFor();
  assert.equal(otherChatReads, 1, 'Only the selected chat is fetched after the address limit expires');
  console.log('PASS the workbench shares a server address limit across conversations');

  let shortReads = 0;
  const originLimit = failed.filter({ hasText: '请求过于频繁，请稍后重试。' });
  await page.route(`**/api/conversations/${waiting}`, route => ++shortReads % 2 === 1
    ? route.fulfill({ status: 429, json: { error: '请求过于频繁，请稍后重试。' },
        headers: { 'Retry-After': '2', 'X-Theoremos-Rate-Limit-Scope': 'api' } })
    : route.fulfill({ json: { conversation: loaded(waiting) } }));
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await open(waiting); await originLimit.waitFor();
  await page.clock.runFor(1900);
  assert.equal(shortReads, 1, 'The idle thread does not send during the cooldown');
  await page.clock.runFor(200);
  await message('本地记录 1').waitFor({ timeout: 2_000 });
  assert.equal(shortReads, 2, 'The idle thread recovers at the deadline without waiting for its next poll');

  const visibility = (hidden: boolean) => page.evaluate(hide => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: hide });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await open(next); await message('本地记录 2').waitFor();
  await open(waiting); await originLimit.waitFor();
  await visibility(true);
  await page.clock.runFor(2100);
  assert.equal(shortReads, 3, 'A hidden thread stays quiet when the cooldown expires');
  await visibility(false);
  await message('本地记录 1').waitFor({ timeout: 2_000 });
  assert.equal(shortReads, 4, 'The restored page reads the thread once');
  await page.clock.resume();
  console.log('PASS an idle conversation resumes at the cooldown deadline or when its tab returns');

  const reconnectDraft = page.locator('#formalize-original');
  const notice = page.locator('#global-notice-text');
  await reconnectDraft.fill('网络断开时保留这条草稿');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  let reconnects = 0, recoveredReads = 0;
  await page.route('**/api/session', route => ++reconnects === 1
    ? route.fulfill({ status: 429, json: { error: '本地测试：会话暂时限流' }, headers: { 'Retry-After': '20' } })
    : route.continue());
  await page.route(`**/api/conversations/${waiting}`, route => {
    recoveredReads++;
    const conversation = loaded(waiting);
    conversation.messages[0]!.text = '网络恢复后的对话记录';
    return route.fulfill({ json: { conversation } });
  });
  await page.context().setOffline(true);
  await notice.filter({ hasText: '网络已断开' }).waitFor({ state: 'attached' });
  await page.context().setOffline(false);
  await notice.filter({ hasText: '本地测试：会话暂时限流' }).waitFor({ state: 'attached' });
  await page.clock.runFor(19_500);
  assert.deepEqual([reconnects, recoveredReads], [1, 0]);
  await page.clock.runFor(1000);
  await notice.filter({ hasText: /^$/u }).waitFor({ state: 'attached' });
  await message('网络恢复后的对话记录').waitFor({ timeout: 4000 });
  assert.deepEqual([reconnects, recoveredReads], [2, 1]);
  assert.equal(await reconnectDraft.inputValue(), '网络断开时保留这条草稿');
  await page.unroute('**/api/session');
  await page.clock.resume();
  console.log('PASS a later session recovery resumes the open conversation after an offline interval and a limit');

  let challenges = 0;
  const challengeMessage = failed.filter({ hasText: 'Cloudflare 安全验证阻止了请求' });
  await page.route(`**/api/conversations/${capped}`, route => ++challenges === 1
    ? route.fulfill({ status: 403, contentType: 'text/html', body: '<html>Security challenge</html>',
      headers: { 'cf-mitigated': 'challenge' } })
    : route.fulfill({ json: { conversation: loaded(capped) } }));
  await open(capped); await challengeMessage.waitFor();
  await open(next); await message('本地记录 2').waitFor();
  await open(capped); await challengeMessage.waitFor();
  await page.clock.fastForward(10_000);
  assert.equal(challenges, 1, 'A challenge quiets the affected route and leaves other conversations usable');
  await page.clock.fastForward(30_000); await message('本地记录 3').waitFor();
  assert.equal(challenges, 2, 'The challenged conversation loads after the cooldown');
  console.log('PASS a Cloudflare challenge appears separately and does not block unrelated history');

  let sends = 0;
  await page.route(`**/api/conversations/${capped}/messages`, route => {
    assert.equal(route.request().method(), 'POST');
    sends++;
    return route.fulfill({ status: 429, headers: { 'Retry-After': '30' },
      json: { cloudflare_error: true, error_code: 1015, retryable: true, retry_after: 30 } });
  });
  if (!await page.locator('#formalize-key').isVisible()) await clickWorkbenchAction(page, '#open-settings');
  await page.locator('#formalize-key').fill('sk-disposable-rate-limit-fixture');
  const composer = page.locator('#formalize-original'), draft = '限流期间保留的草稿';
  await composer.fill(draft);
  await page.locator('#formalize-start').click(); await limit.waitFor();
  await page.locator('#formalize-start').click(); await limit.waitFor();
  assert.equal(sends, 1, 'Another click during cooldown does not send a write');
  await page.clock.fastForward(35_000);
  assert.equal(sends, 1, 'Ending the cooldown never replays the write');
  assert.equal(await composer.inputValue(), draft, 'The rejected message stays in the composer');
  console.log('PASS a throttled send keeps the draft and is never replayed');

  for (const fixture of [
    { status: 429, json: { error: '请求过于频繁，请稍后重试。' }, headers: { 'Retry-After': '60' },
      wait: 60_000, notice: '请求过于频繁，请稍后重试。' },
    { status: 429, json: { cloudflare_error: true, error_code: 1015, retryable: true, retry_after: 30 },
      headers: {}, wait: 30_000, notice: '请求太频繁，请稍后再试。' },
    { status: 522, json: { cloudflare_error: true, error_code: 522, retryable: true, retry_after: 120 },
      headers: { 'Retry-After': '30' }, wait: 30_000, notice: '服务暂时不可用，请稍后重试' },
  ]) {
    let connections = 0;
    const { status, json, headers, wait, notice } = fixture;
    const startup = /\/api\/session\?runs$/u;
    await page.route(startup, route => ++connections === 1
      ? route.fulfill({ status, json, headers: headers as Record<string, string> })
      : route.continue());
    await page.goto(origin);
    await page.locator('#global-notice-text').filter({ hasText: notice }).waitFor();
    await page.clock.fastForward(10_000);
    assert.equal(connections, 1, 'Workbench startup does not repeat the session request during cooldown');
    await page.clock.fastForward(wait);
    await page.locator('#formalize-original:enabled').waitFor();
    assert.equal(connections, 2, 'Workbench startup reconnects after the advertised wait');
    await page.unroute(startup);
  }
  assert.deepEqual(errors, []);
  console.log('PASS startup recovers from the origin limit, JSON 1015 and 522, preferring Retry-After over the body');
} finally {
  await browser.close(); await service.close();
}
