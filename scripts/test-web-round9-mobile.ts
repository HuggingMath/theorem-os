#!/usr/bin/env bun
// Touch navigation and editor scrolling on real loopback HTTP; no runner, model, Lean or email.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { freePort, ready, settled, startBrowser } from './web-scenario';
import { showChat } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/frontend-round9/mobile');
await fs.access(path.join(staticRoot, 'app.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round9-mobile-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const checks: object[] = [], errors: string[] = [], external: string[] = [], writes: object[] = [];
let calls = 0, browser: Browser | undefined, active: Page | undefined, phase = 'setup', failure: unknown;
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Local touch navigation fixture' }; },
  async run() { calls++; throw new Error('Mobile navigation must not start a worker'); } };
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner, { sample: null });
type View = { left: number; top: number; right: number; bottom: number; width: number; height: number; x: number; y: number;
  hit: boolean; contentHeight: number; lineHeight: number; scrollTop: number; scrollHeight: number; clientHeight: number };
async function view(page: Page, selector: string): Promise<View> {
  return page.locator(selector).evaluate(element => {
    const el = element as HTMLElement, rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const box = parent.getBoundingClientRect(), computed = getComputedStyle(parent);
      if (/auto|scroll|hidden|clip/u.test(computed.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (/auto|scroll|hidden|clip/u.test(computed.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      if (parent.matches('dialog:modal')) break;
    }
    const x = (left + right) / 2, y = (top + bottom) / 2, hit = document.elementFromPoint(x, y);
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top), x, y,
      hit: !!hit && el.contains(hit), contentHeight: Math.max(0, Math.min(bottom, rect.bottom - parseFloat(style.paddingBottom)) - Math.max(top, rect.top + parseFloat(style.paddingTop))),
      lineHeight: parseFloat(style.lineHeight) || 0, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
}
/** Coordinates only: Playwright locator.tap would silently scroll overflow:hidden ancestors for us. */
async function tap(page: Page, selector: string) {
  const box = await view(page, selector);
  assert.ok(box.width > 10 && box.height > 10 && box.hit, `${selector} needs a visible, uncovered touch target: ${JSON.stringify(box)}`);
  await page.touchscreen.tap(box.x, box.y); await settled(page);
}
async function swipe(page: Page, cdp: CDPSession, selector: string, direction: 'up' | 'down', distance = 180) {
  const box = await view(page, selector);
  assert.ok(box.height > 40, `${selector} has room for a swipe`);
  // A side inset avoids selecting text or operating a row's button while the finger moves.
  const x = box.left + 5, available = Math.min(distance, box.height - 24);
  const start = direction === 'up' ? box.bottom - 12 : box.top + 12;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
  for (let step = 1; step <= 12; step++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + (direction === 'up' ? -1 : 1) * available * step / 12 }] });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  // Touch scrolling can continue after the finger lifts. Wait for the target to stop moving before a coordinate tap.
  const stopped = await page.locator(selector).evaluate(element => new Promise<boolean>(resolve => {
    let previous = element.scrollTop, stable = 0, frames = 0;
    const tick = () => {
      const current = element.scrollTop;
      stable = Math.abs(current - previous) < .5 ? stable + 1 : 0;
      previous = current;
      if (stable >= 6) resolve(true);
      else if (++frames >= 120) resolve(false);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  assert.ok(stopped, `${selector} touch scrolling settles before the next action`);
}
async function reach(page: Page, cdp: CDPSession, scroller: string, selector: string, minimumContent = 0) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const box = await view(page, selector);
    if (box.hit && box.height >= 20 && box.contentHeight >= minimumContent) return box;
    const target = await page.locator(selector).boundingBox(), pane = await view(page, scroller);
    assert.ok(target);
    await swipe(page, cdp, scroller, target.y + target.height / 2 > pane.y ? 'up' : 'down', 110);
  }
  throw new Error(`Touch scrolling cannot reach ${selector}: ${JSON.stringify(await view(page, selector))}`);
}
async function context(width: number, height: number, locale: 'zh' | 'en') {
  const ctx = await browser!.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    reducedMotion: 'reduce', locale: locale === 'zh' ? 'zh-CN' : 'en-US' });
  await ctx.addInitScript(locale => { try { localStorage.setItem('theorem-os.locale.v1', locale); } catch { /* about:blank */ } }, locale);
  await ctx.route(/^https?:\/\//u, async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.href); await route.abort(); }
    else {
      if (url.pathname.startsWith('/api/') && route.request().method() !== 'GET') writes.push({ phase, method: route.request().method(), path: url.pathname });
      await route.continue();
    }
  });
  const page = active = await ctx.newPage(); page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(`${phase}: ${error.message}`));
  await page.goto(origin); await page.locator('#formalize-original').waitFor();
  return { ctx, page, cdp: await ctx.newCDPSession(page) };
}
async function seedHistory(ctx: BrowserContext) {
  const owner = (await ctx.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
  const ids: string[] = [];
  for (let index = 0; index < 24; index++) {
    const id = crypto.randomUUID(), at = new Date(Date.UTC(2026, 10, 9, 12, index)).toISOString(); ids.push(id);
    service.storage.saveRecord(['owners', mathDigest(owner), 'conversations', `${id}.json`], { id, title: `Fixture conversation ${String(index + 1).padStart(2, '0')}`,
      createdAt: at, updatedAt: at, messages: [{ id: crypto.randomUUID(), role: 'user', kind: 'text', text: `Original fixture ${index + 1}`, createdAt: at, status: 'complete' }] });
  }
  return ids;
}

try {
  browser = await startBrowser(service.server, port);
  for (const [locale, width, height] of [['zh', 390, 844], ['en', 320, 640]] as const) {
    phase = `history/${locale}/${width}x${height}`;
    const { ctx, page, cdp } = await context(width, height, locale);
    try {
      await page.locator('#formalize-original').fill('First mobile draft'); await page.locator('#formalize-original').press('Enter');
      assert.match(await page.locator('#formalize-original').inputValue(), /\n$/u);
      const ids = await seedHistory(ctx); await page.reload(); await page.locator('#formalize-original').waitFor();
      await tap(page, '#open-history'); await page.locator(`[data-chat-row="${ids[0]}"]`).waitFor({ state: 'attached' });
      assert.equal(await page.locator('.chat-task-history').getAttribute('open'), null, 'proof tasks stay collapsed by default');
      const before = await view(page, '#chat-history-list');
      const taskBefore = await view(page, '.chat-task-history>summary');
      assert.ok(taskBefore.height >= 30 && taskBefore.hit, 'the proof-task entry remains reachable with long conversations');
      for (let attempt = 0; attempt < 10; attempt++) {
        const last = await view(page, `[data-chat-row="${ids[0]}"] .chat-history-item`);
        if (last.height >= 30 && last.hit) break;
        await swipe(page, cdp, '#chat-history-list', 'up', 260);
      }
      const after = await view(page, '#chat-history-list'), oldest = await view(page, `[data-chat-row="${ids[0]}"] .chat-history-item`);
      assert.ok(after.scrollTop > before.scrollTop && oldest.height >= 30 && oldest.hit, 'a real finger swipe reaches the oldest conversation');
      await tap(page, '.chat-task-history>summary');
      await page.waitForFunction(() => document.querySelector<HTMLDetailsElement>('.chat-task-history')!.open);
      const taskList = await view(page, '#run-list'), chatWithTasks = await view(page, '#chat-history-list');
      assert.ok(taskList.height >= 60 && chatWithTasks.height >= 100, 'both history sections retain reading space');
      await page.screenshot({ path: path.join(output, `history-open-tasks-${locale}-${width}.png`) });
      await tap(page, '.chat-task-history>summary');
      for (let attempt = 0; attempt < 10; attempt++) {
        const search = await view(page, '[data-chat-search]'); if (search.hit && search.height >= 20) break;
        await swipe(page, cdp, '#chat-history-list', 'down', 260);
      }
      await tap(page, '[data-chat-search]'); await page.keyboard.insertText('conversation 01');
      assert.equal(await page.locator('[data-chat-row]').count(), 1);
      await tap(page, `[data-chat-row="${ids[0]}"] .chat-history-item`);
      await page.locator('#history-dialog').waitFor({ state: 'hidden' });
      await page.locator(`.chat-messages[data-conversation="${ids[0]}"]`).waitFor();
      checks.push({ phase, conversationFixtures: ids.length, before, after, oldest, taskBefore, taskList, chatWithTasks,
        nativeSwipe: true, searchThenOpenOldest: true, mobileEnterInsertsNewline: true });
      console.log(`PASS ${phase}`);
    } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png') }); throw error; }
    finally { await ctx.close(); }
  }

  const source = 'theorem mobile_fixture : True := by\n  have step : True := by trivial\n  exact step';
  for (const [locale, width, height] of [['zh', 390, 844], ['zh', 812, 375], ['en', 390, 320], ['en', 390, 260]] as const) {
    phase = `editor/${locale}/${width}x${height}`;
    const { ctx, page, cdp } = await context(width, height, locale);
    try {
      await ready(page); await showChat(page); await page.locator('#source').fill(source);
      // These ordinary locator clicks only enter the editor from the long source page. In-dialog checks use coordinates.
      await page.locator('#expand-source').click(); await page.locator('#source-editor[open]').waitFor();
      await tap(page, '#editor-find-toggle'); await page.locator('#editor-find-input').fill('step');
      await tap(page, '#editor-replace-toggle'); await page.locator('#editor-replace-input').fill('lemma');
      await reach(page, cdp, '#source-editor', '#editor-replace-all'); await tap(page, '#editor-replace-all');
      assert.equal(await page.locator('#expanded-source').inputValue(), source.replaceAll('step', 'lemma'));
      const buffer = await reach(page, cdp, '#source-editor', '#expanded-source', 42);
      assert.ok(buffer.contentHeight >= 42, 'at least two source lines remain visible after native scrolling');
      await page.screenshot({ path: path.join(output, `editor-source-${locale}-${width}x${height}.png`) });
      await tap(page, '#expanded-source'); await page.keyboard.insertText('-- touch edit ');
      const edited = await page.locator('#expanded-source').inputValue(); assert.ok(edited.includes('-- touch edit '));
      assert.equal(await page.locator('#source').inputValue(), source, 'scratch changes do not apply early');
      let review: object | undefined;
      if (height <= 480) {
        await reach(page, cdp, '#source-editor', '#editor-review-toggle'); await tap(page, '#editor-review-toggle');
        await page.locator('#editor-review').waitFor();
        const diff = await reach(page, cdp, '#source-editor', '#editor-review-scroll', 42);
        const added = await reach(page, cdp, '#editor-review-scroll', '#editor-review-body .diff-added >> nth=0', 12);
        assert.match((await page.locator('#editor-review-body .diff-added').allTextContents()).join(' '), /lemma/u);
        await page.screenshot({ path: path.join(output, `editor-review-${locale}-${width}x${height}.png`) });
        await reach(page, cdp, '#source-editor', '#editor-review-toggle'); await tap(page, '#editor-review-toggle');
        await page.locator('#editor-source-surface').waitFor();
        assert.equal(await page.locator('#expanded-source').inputValue(), edited, 'returning from review preserves the edited buffer');
        review = { diff, added, touchOpenedAndReturned: true, sourcePreserved: true };
      }
      await reach(page, cdp, '#source-editor', '#apply-editor');
      const apply = await view(page, '#apply-editor'); await page.screenshot({ path: path.join(output, `editor-apply-${locale}-${width}x${height}.png`) });
      await tap(page, '#apply-editor'); await page.locator('#source-editor').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#source').inputValue(), edited);
      await page.locator('#expand-source').click(); await page.locator('#source-editor[open]').waitFor();
      await reach(page, cdp, '#source-editor', '#expanded-source', 42); await tap(page, '#expanded-source'); await page.keyboard.insertText('-- discard ');
      await reach(page, cdp, '#source-editor', '#cancel-editor'); const cancel = await view(page, '#cancel-editor'); await tap(page, '#cancel-editor');
      await page.locator('#editor-discard-dialog[open]').waitFor();
      await reach(page, cdp, '#editor-discard-dialog', '#discard-editor-changes'); await tap(page, '#discard-editor-changes');
      await page.locator('#source-editor').waitFor({ state: 'hidden' }); assert.equal(await page.locator('#source').inputValue(), edited);
      checks.push({ phase, buffer, apply, cancel, ...(review ? { review } : {}), replaceAll: true, touchEditedAndApplied: true, touchCancelDiscarded: true });
      console.log(`PASS ${phase}`);
    } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png') }); throw error; }
    finally { await ctx.close(); }
  }
  assert.equal(calls, 0); assert.deepEqual(writes, []); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) { failure = error; console.error(error); process.exitCode = 1; await active?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
finally {
  await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(), staticRoot,
    mode: 'Real local HTTP and Chromium touch emulation with disposable stored conversations. Short viewports test available height, not an actual OS software keyboard.',
    checks, errors, external, writes, runnerCalls: calls, temporaryDataRemoved: true,
    ...(failure ? { failedScenario: phase, error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2) + '\n');
}
