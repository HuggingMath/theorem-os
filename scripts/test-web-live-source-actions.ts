#!/usr/bin/env bun
// Replay owner-only API records through the real workbench. No task submissions, model calls or Lean execution.
// All waits are unbounded; a fixture records its state but imposes no time, token or round budget.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import type { WebConversation } from '../apps/web/conversationTypes';
import type { WebFormalization, WebFormalizationActivity, WebFormalizationStep } from '../apps/web/formalizationTypes';
import { localeStorageKey } from '../apps/web/i18n';
import type { WebRunner } from '../apps/web/runner';
import { createWebService } from '../apps/web/server';
import { audit } from './web-a11y';
import { freePort } from './web-scenario';

type CopyProbe = { clipboard: Clipboard; writes: string[]; release?: () => void };
type FixtureWindow = Window & { __liveSource: CopyProbe };
const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/web-live-source-actions');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the live source action check.'); });
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-live-source-'));
const forbiddenCalls: string[] = [], errors: string[] = [], external: string[] = [], writes: string[] = [];
const forbidden = (name: string): never => { forbiddenCalls.push(name); throw new Error(`Read-only source actions must not call runner.${name}`); };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local source action fixture' }; },
  async run() { return forbidden('run'); }, async formalize() { return forbidden('formalize'); },
  async check() { return forbidden('check'); }, async command() { return forbidden('command'); }, async explain() { return forbidden('explain'); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: temporary }), runner, { sample: null });
service.server.requestTimeout = 0; service.server.headersTimeout = 0; service.server.setTimeout(0);
await new Promise<void>((resolve, reject) => { service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolve); });
const browser = await chromium.launch({ headless: true, timeout: 0 });
const checks: string[] = [], screenshots: string[] = [];
const mark = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
const original = '\uFEFF-- 原始版本 α：保留 CRLF、缩进和尾部空白\r\ntheorem sample : True := by\r\n\ttrivial  \r\n';
const revised = '-- newer candidate, not accepted\ntheorem sample : True := by\n  exact True.intro\n';
const excerpt = '-- 已保存的前半部分 β\r\ntheorem sample : True := by\r\n';
const time = (sequence: number) => new Date(Date.UTC(2026, 10, 10, 1, sequence)).toISOString();
const live = (page: Page) => page.locator('#chat-live-panel');
const copy = (page: Page) => live(page).locator('[data-live-copy]');
const download = (page: Page) => live(page).locator('[data-live-download]');
// The Lean check list is folded under the code by default; the reader opens it to pick a version.
async function openChecks(page: Page) {
  const list = live(page).locator('details.live-checks');
  await list.waitFor({ timeout: 0 });
  if (await list.getAttribute('open') === null) await list.locator(':scope > summary').click();
}
async function settled(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function copied(page: Page, source: string, keyboard = false) {
  if (keyboard) { await copy(page).focus(); await page.keyboard.press('Enter'); } else await copy(page).click();
  await live(page).locator('.live-file-feedback:not([data-error])').waitFor({ timeout: 0 });
  assert.equal(await page.evaluate(() => (window as unknown as FixtureWindow).__liveSource.writes.at(-1)), source, 'copy receives the displayed source unchanged');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clipboard.replace(/\r\n?/gu, '\n'), source.replace(/\r\n?/gu, '\n'), 'the browser clipboard contains the copied code');
}
async function downloaded(page: Page, source: string, filename: string, keyboard = false) {
  const waiting = page.waitForEvent('download', { timeout: 0 });
  if (keyboard) { await download(page).focus(); await page.keyboard.press('Space'); } else await download(page).click();
  const result = await waiting, file = await result.path();
  assert.equal(result.suggestedFilename(), filename);
  assert.equal(await result.failure(), null);
  assert(file);
  assert.deepEqual(await fs.readFile(file), Buffer.from(source, 'utf8'), 'download preserves BOM, Unicode, CRLF, indentation and trailing bytes');
}
async function fit(page: Page) {
  await settled(page);
  for (const selector of ['.live-file-toolbar', '[data-live-copy]', '[data-live-download]']) {
    const box = await live(page).locator(selector).boundingBox();
    assert(box && box.x >= -1 && box.x + box.width <= page.viewportSize()!.width + 1, `${selector} fits the viewport`);
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'actions do not widen the page');
  assert.deepEqual(await audit(page), []);
}
/** The status says where the task is once; a task that needs nothing from the reader adds no "your next action" line. */
async function outcomes(page: Page) {
  const state = page.locator('.research-conversation-state strong');
  await state.waitFor({ timeout: 0 });
  assert.ok((await state.innerText()).trim());
  assert.equal(await page.locator('[data-chat-outcomes], [data-chat-next-action]').count(), 0);
}
let active: Page | undefined, failure: unknown;
try {
  for (const language of ['zh', 'en'] as const) {
    const context = await browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
    context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
    await context.addInitScript(({ key, language }) => {
      localStorage.setItem(key, language);
      const probe: CopyProbe = { clipboard: navigator.clipboard, writes: [] };
      (window as unknown as FixtureWindow).__liveSource = probe;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (text: string) => { probe.writes.push(text); await probe.clipboard.writeText(text); },
        readText: () => probe.clipboard.readText(),
      } });
    }, { key: localeStorageKey, language });
    const page = active = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const activity: WebFormalizationActivity[] = [], formalizationId = crypto.randomUUID(), chatId = crypto.randomUUID();
    const formalization: WebFormalization = { id: formalizationId, original: '证明 True，保留生成过程中的源码。',
      environment: 'standard', model: 'read-only-fixture', effort: 'max', status: 'running', createdAt: time(0), updatedAt: time(0),
      progress: { phase: 'generating', updatedAt: time(0) }, activity: { count: 0 },
      maxRunSeconds: 0, maxTotalTokens: 0, research: { maxRunSeconds: 0, maxTotalTokens: 0, maxTurns: 0 } };
    const conversation: WebConversation = { id: chatId, formalizationId, title: 'Live source actions', createdAt: time(0), updatedAt: time(0),
      messages: [{ id: crypto.randomUUID(), role: 'user', kind: 'task', text: formalization.original, createdAt: time(0), status: 'complete' }] };
    const append = (step: WebFormalizationStep) => {
      const sequence = activity.length + 1, at = time(sequence);
      activity.push({ type: 'step', sequence, at, step });
      formalization.activity = { count: activity.length }; formalization.updatedAt = at;
    };
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(request.url()); await route.abort(); return; }
      if (!['GET', 'HEAD'].includes(request.method())) { writes.push(`${request.method()} ${url.pathname}`); await route.abort(); return; }
      if (url.pathname === `/api/conversations/${chatId}`) { await route.fulfill({ json: { conversation } }); return; }
      if (url.pathname === '/api/conversations') {
        const { messages: _, ...summary } = conversation;
        await route.fulfill({ json: { conversations: [{ ...summary, answering: false }] } }); return;
      }
      if (url.pathname === `/api/formalizations/${formalizationId}`) { await route.fulfill({ json: { formalization } }); return; }
      if (url.pathname === `/api/formalizations/${formalizationId}/activity`) {
        const after = Number(url.searchParams.get('after') ?? 0);
        await route.fulfill({ json: { activity: activity.filter(item => item.sequence > after), dropped: 0 } }); return;
      }
      await route.continue();
    });
    await page.goto(`${origin}/?chat=${chatId}`, { timeout: 0 });
    await live(page).waitFor({ timeout: 0 });
    assert.equal(await copy(page).count(), 0, 'no action without a displayed source');
    append({ round: 1, step: 'compile', state: 'started', source: original });
    await copy(page).waitFor({ timeout: 0 });
    assert.equal(formalization.status, 'running'); assert.equal(formalization.report, undefined);
    assert.equal(await copy(page).isEnabled(), true); assert.equal(await download(page).isEnabled(), true);
    await copied(page, original, true); await downloaded(page, original, 'Formalization.lean', true);
    mark(`${language}: original source is reusable before compile, review or proof acceptance finishes; keyboard and raw bytes`);

    append({ round: 1, step: 'compile', state: 'failed', lean: { passed: false, messages: [{ severity: 'error', file: 'Formalization.lean', line: 3, text: 'Recorded local fixture error' }] } });
    append({ round: 2, step: 'compile', state: 'started', source: revised });
    await openChecks(page);
    await live(page).locator('[data-live-check="f:3"]').waitFor({ timeout: 0 });
    await copied(page, revised); await downloaded(page, revised, 'Formalization.lean');
    await live(page).locator('[data-live-check="f:1"]').click();
    await live(page).locator('.lean-line[data-marked]').waitFor({ timeout: 0 });
    await copied(page, original); await downloaded(page, original, 'Formalization.lean');
    mark(`${language}: latest and historical checks export their own versions and retain Lean error marks`);

    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: () => new Promise<void>(resolve => { (window as unknown as FixtureWindow).__liveSource.release = resolve; }),
    } }));
    await copy(page).click();
    await page.waitForFunction(() => typeof (window as unknown as FixtureWindow).__liveSource.release === 'function', undefined, { timeout: 0 });
    await live(page).locator('[data-live-check="f:3"]').click();
    await page.evaluate(() => (window as unknown as FixtureWindow).__liveSource.release!()); await settled(page);
    assert.equal(await live(page).locator('.live-file-feedback').count(), 0, 'a previous version finishing its copy cannot claim the newly selected file was copied');
    mark(`${language}: a delayed copy cannot show success against another selected version`);

    append({ round: 2, step: 'compile', state: 'passed', lean: { passed: true, messages: [] } });
    append({ round: 3, step: 'compile', state: 'started', source: excerpt, sourceClipped: true });
    await live(page).locator('[data-live-check="f:5"]').waitFor({ timeout: 0 });
    await live(page).locator('[data-live-check="f:5"]').click();
    assert.equal(await copy(page).innerText(), language === 'zh' ? '复制片段' : 'Copy excerpt');
    assert.equal(await download(page).innerText(), language === 'zh' ? '下载片段' : 'Download excerpt');
    assert.equal(await live(page).locator('.live-excerpt').innerText(), language === 'zh' ? '源码片段' : 'Source excerpt');
    await downloaded(page, excerpt, 'Formalization.lean.partial.txt');
    for (const unavailable of [false, true]) {
      await page.evaluate(unavailable => Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: unavailable ? undefined : { writeText: async () => { throw new DOMException('Denied by fixture', 'NotAllowedError'); } } }), unavailable);
      await copy(page).click();
      await live(page).locator('.live-file-feedback[data-error=true]').waitFor({ timeout: 0 });
      assert.equal(await live(page).locator('.live-file-feedback').innerText(), language === 'zh' ? '复制失败，请选择代码复制。' : 'Copy failed. Select the code and copy it manually.');
      assert.equal(await copy(page).innerText(), language === 'zh' ? '复制片段' : 'Copy excerpt');
    }
    await page.evaluate(() => {
      const probe = (window as unknown as FixtureWindow).__liveSource;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (text: string) => { probe.writes.push(text); await probe.clipboard.writeText(text); }, readText: () => probe.clipboard.readText(),
      } });
    });
    await copied(page, excerpt);
    mark(`${language}: excerpts are explicit, downloads cannot look complete, clipboard denial/unavailability is truthful and retryable`);

    // Keep the original resize checks, then also enter from a page that has never opened the desktop workspace.
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 }); await fit(page);
      const filename = `${language}-${width}.png`;
      await page.screenshot({ path: path.join(output, filename), fullPage: true, timeout: 0 }); screenshots.push(filename);
    }
    mark(`${language}: open workspace actions fit desktop and phone widths, with accessible controls`);
    for (const width of [390, 320]) {
      const mobile = active = await context.newPage();
      await mobile.setViewportSize({ width, height: 1000 });
      mobile.on('pageerror', error => errors.push(error.message));
      await mobile.goto(`${origin}/?chat=${chatId}`, { timeout: 0 });
      await outcomes(mobile);
      const open = mobile.locator('[data-research-artifact="live"]'), draft = `${language}-${width}: keep this unsent question`;
      await open.waitFor({ timeout: 0 });
      assert.equal(await live(mobile).isVisible(), false, 'a cold phone page starts with its conversation');
      await mobile.locator('#formalize-original').fill(draft);
      let filename = `${language}-${width}-cold-conversation.png`;
      await mobile.screenshot({ path: path.join(output, filename), fullPage: true, timeout: 0 }); screenshots.push(filename);
      await open.click(); await copy(mobile).waitFor({ timeout: 0 });
      await copied(mobile, excerpt); await downloaded(mobile, excerpt, 'Formalization.lean.partial.txt');
      await fit(mobile);
      filename = `${language}-${width}-cold-code.png`;
      await mobile.screenshot({ path: path.join(output, filename), fullPage: true, timeout: 0 }); screenshots.push(filename);
      await mobile.locator('#close-research-output').click();
      assert.equal(await mobile.locator('#research-conversation-panel').isVisible(), true);
      assert.equal(new URL(mobile.url()).searchParams.get('chat'), chatId);
      assert.equal(await mobile.locator('#formalize-original').inputValue(), draft);
      const records = mobile.locator('details.solve-process');
      if (await records.getAttribute('open') === null) await records.locator(':scope > summary').click();
      const firstRound = mobile.locator('[data-solve-row="f:round:1"] > .solve-row-line > .solve-row-head');
      if (await firstRound.getAttribute('aria-expanded') === 'false') await firstRound.click();
      await mobile.locator('[data-solve-check="f:1"]').click();
      await openChecks(mobile);
      await live(mobile).locator('[data-live-check="f:1"][aria-current="true"]').waitFor({ timeout: 0 });
      await live(mobile).locator('.lean-line[data-marked]').waitFor({ timeout: 0 });
      await copied(mobile, original); await downloaded(mobile, original, 'Formalization.lean');
      await fit(mobile);
      filename = `${language}-${width}-check-code.png`;
      await mobile.screenshot({ path: path.join(output, filename), fullPage: true, timeout: 0 }); screenshots.push(filename);
      await mobile.locator('#close-research-output').click();
      await mobile.reload({ timeout: 0 }); await outcomes(mobile);
      await open.waitFor({ timeout: 0 });
      assert.equal(await live(mobile).isVisible(), false, 'refresh retains the phone conversation until its code is requested');
      assert.equal(await mobile.locator('#formalize-original').inputValue(), draft);
      await open.click(); await copy(mobile).waitFor({ timeout: 0 });
      await copied(mobile, excerpt); await downloaded(mobile, excerpt, 'Formalization.lean.partial.txt');
      await fit(mobile);
      filename = `${language}-${width}-refreshed-code.png`;
      await mobile.screenshot({ path: path.join(output, filename), fullPage: true, timeout: 0 }); screenshots.push(filename);
      await mobile.locator('#close-research-output').click();
      assert.equal(await mobile.locator('#research-conversation-panel').isVisible(), true);
      assert.equal(await mobile.locator('#formalize-original').inputValue(), draft);
      mark(`${language}/${width}px: cold and refreshed phone conversations open existing raw code; closing preserves the conversation and a Lean check reopens its own version`);
      await mobile.close(); active = page;
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    append({ round: 3, step: 'compile', state: 'passed', lean: { passed: true, messages: [] } });
    append({ round: 4, step: 'compile', state: 'started', source: '' });
    await live(page).locator('[data-live-check="f:7"]').waitFor({ timeout: 0 });
    await live(page).locator('[data-live-check="f:7"]').click();
    await copied(page, ''); await downloaded(page, '', 'Formalization.lean');
    mark(`${language}: an explicitly saved empty source exports zero bytes`);
    // A long folded history must keep its own scrollbar so the oldest saved file remains reachable.
    const previousChecks = await live(page).locator('[data-live-check]').count();
    for (let round = 5; round < 25; round++) {
      append({ round, step: 'compile', state: 'started', source: revised });
      append({ round, step: 'compile', state: 'passed', lean: { passed: true, messages: [] } });
    }
    await page.waitForFunction(count => document.querySelectorAll('#chat-live-panel [data-live-check]').length === count,
      previousChecks + 20, { timeout: 0 });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 }); await openChecks(page); await settled(page);
      const history = live(page).locator('.live-checks > ol');
      const geometry = await history.evaluate(list => {
        const before = { clientHeight: list.clientHeight, scrollHeight: list.scrollHeight };
        list.scrollTop = list.scrollHeight;
        const box = list.getBoundingClientRect(), last = list.lastElementChild!.getBoundingClientRect();
        return { ...before, scrollTop: list.scrollTop, lastVisible: last.top >= box.top - 1 && last.bottom <= box.bottom + 1 };
      });
      assert.ok(geometry.scrollHeight > geometry.clientHeight && geometry.scrollTop > 0, 'The long history scrolls inside its panel');
      assert.ok(geometry.lastVisible, 'The oldest check is reachable without scrolling the clipped outer panel');
      await live(page).locator('[data-live-check="f:1"]').click();
      await live(page).locator('[data-live-check="f:1"][aria-current="true"]').waitFor({ timeout: 0 });
      await copied(page, original); await downloaded(page, original, 'Formalization.lean');
      await live(page).locator('.live-checks > summary').click();
      assert.equal(await live(page).locator('details.live-checks').getAttribute('open'), null);
      await openChecks(page);
      assert.equal(await live(page).locator('[data-live-check="f:1"][aria-current="true"]').count(), 1, 'Folding keeps the selected historical file');
      await fit(page);
      mark(`${language}/${width}px: long check history scrolls to its oldest source and preserves selection when folded`);
    }
    await context.close(); active = undefined;
  }
  assert.deepEqual(forbiddenCalls, []); assert.deepEqual(external, []); assert.deepEqual(errors, []); assert.deepEqual(writes, []);
} catch (error) {
  failure = error;
  if (active) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 0 }).catch(() => undefined);
  throw error;
} finally {
  await browser.close(); await service.close(); await fs.rm(temporary, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    mode: 'real Chromium and workbench with read-only local API record fixtures; no model or Lean', checks, screenshots,
    browserTimeouts: 0, deadline: null, tokenLimit: null, roundLimit: null, realModelCalls: 0, realLeanProcesses: 0, fixturesRemoved: true,
    paidModelCalls: false, forbiddenCalls, errors, external, writes,
    ...(failure ? { error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2) + '\n');
}
