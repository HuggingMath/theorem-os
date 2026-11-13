#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { localeStorageKey } from '../apps/web/i18n';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { audit, tabStops } from './web-a11y';
import { freePort, settled, startBrowser, ready } from './web-scenario';
import { showExamples, openSample, openHistory } from './web-ui-controls';

/**
 * Keyboard and screen-reader pass over the workbench, in Chinese and English: the static audit (names, labels, ARIA
 * references, unique ids) on the welcome page, every tab of the sample run and each dialog; Tab reaches the main
 * controls with a visible focus ring; the detail tabs follow the arrow-key tab pattern; and every dialog closes on
 * Escape with focus back on the control that opened it. Under forced colours (Windows high contrast) the current, selected
 * and focused states stay visible. Runs against the read-only sample, so nothing is submitted.
 * The login page is audited in test-web-login, which configures accounts.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-a11y');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the accessibility check.'); });
await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Accessibility check' }; },
  async run() { throw new Error('The accessibility check must not start a run'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner);
const mark = (check: string) => console.log(`PASS ${check}`);
const clean = async (page: Page, where: string, scope?: string) => assert.deepEqual(await audit(page, { scope }), [], `Accessibility problems: ${where}`);

/** Opens a dialog with the keyboard, audits it, and verifies focus returns to its visible navigation control. */
async function dialog(page: Page, trigger: string, id: string, where: string) {
  const fromNavigation = await page.locator(trigger).evaluate(element => Boolean(element.closest('[data-navigation-menu]')));
  if (fromNavigation) {
    const menu = page.locator('[data-navigation-menu]');
    if (!await menu.evaluate(node => (node as HTMLDetailsElement).open)) {
      await menu.locator('[data-navigation-toggle]').focus();
      await page.keyboard.press('Enter');
      await menu.locator('[data-navigation-panel]').waitFor();
    }
  }
  await page.locator(trigger).focus();
  await page.keyboard.press('Enter');
  await page.locator(`#${id}[open]`).waitFor();
  await settled(page);
  await clean(page, where, `#${id}`);
  assert.ok(await page.evaluate(dialogId => document.getElementById(dialogId)!.contains(document.activeElement), id), `${where}: focus did not move into the dialog`);
  await page.keyboard.press('Escape');
  await page.locator(`#${id}`).waitFor({ state: 'hidden' });
  const returnFocus = fromNavigation ? '[data-navigation-toggle]' : trigger;
  assert.ok(await page.locator(returnFocus).evaluate(element => element === document.activeElement), `${where}: focus did not return to ${returnFocus}`);
}

let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
try {
  browser = await startBrowser(service.server, port);
  for (const locale of ['zh', 'en'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, locale] as const);
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await ready(page);
    await showExamples(page); await page.locator('.chat-welcome[data-first-run="true"]').waitFor();
    await settled(page);
    await clean(page, `welcome (${locale})`);

    // Opening the examples left focus on their toggle; Tab order starts again from the document.
    await page.evaluate(() => {
      const root = document.documentElement; root.tabIndex = -1; root.focus({ preventScroll: true }); root.removeAttribute('tabindex');
    });
    // The first Tab shows the skip link, which moves focus to the workspace; the top bar follows in reading order.
    await page.keyboard.press('Tab');
    assert.ok(await page.locator('.skip-link').evaluate(link => link === document.activeElement), 'The first Tab stop is not the skip link');
    const stops = await tabStops(page, 12);
    const hidden = stops.filter(stop => !stop.visible || !stop.indicated);
    assert.deepEqual(hidden, [], `Focus stops without a visible focus ring (${locale})`);
    assert.ok(stops.some(stop => stop.name.startsWith('button#open-history')) && stops.some(stop => /^summary (?:菜单|Menu)$/u.test(stop.name)), `Tab misses the top bar: ${stops.map(stop => stop.name).join(' | ')}`);
    mark(`Tab starts at the skip link and reaches the top bar with a visible focus ring (${locale})`);

    await dialog(page, '#open-settings', 'run-settings', `settings (${locale})`);
    // The simplified top bar keeps the glossary in the welcome and the palette.
    await dialog(page, '.welcome-glossary', 'glossary-dialog', `glossary (${locale})`);
    // Wide screens dock the history beside the workspace; its button folds and unfolds it and keeps focus.
    const history = page.locator('#open-history');
    if (await history.getAttribute('aria-expanded') === 'false') {
      await history.focus();
      await page.keyboard.press('Enter');
      await page.locator('#history-sidebar .run-history').waitFor();
    }
    await history.focus();
    await page.keyboard.press('Enter');
    await page.locator('body[data-history-collapsed="true"]').waitFor({ state: 'attached' });
    assert.equal(await history.getAttribute('aria-expanded'), 'false');
    await page.locator('#topbar-draft').waitFor();
    await clean(page, `collapsed history (${locale})`);
    await page.keyboard.press('Enter');
    await page.locator('#history-sidebar .run-history').waitFor();
    assert.equal(await history.getAttribute('aria-expanded'), 'true');
    assert.ok(await page.evaluate(() => document.activeElement?.id === 'open-history' || Boolean(document.activeElement?.closest('#history-sidebar'))),
      'unfolding the history must leave focus on its button or move it into the list');
    await page.setViewportSize({ width: 820, height: 900 });
    await settled(page);
    await dialog(page, '#open-history', 'history-dialog', `history dialog (${locale})`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await settled(page);
    // The menu's search button opens the palette; so does Ctrl+K, and Escape returns focus to the visible menu control.
    await dialog(page, '.topbar .palette-trigger', 'command-palette', `command palette (${locale})`);
    await page.locator('[data-navigation-toggle]').focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await page.locator('#command-palette[open]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#command-palette').waitFor({ state: 'hidden' });
    assert.ok(await page.locator('[data-navigation-toggle]').evaluate(element => element === document.activeElement), 'Palette did not return focus');
    mark(`settings, glossary, the history sidebar and dialog and the palette pass the audit, close on Escape and return focus (${locale})`);

    // The sample: each tab is reachable with the arrow keys and every panel passes the audit.
    await openSample(page);
    await page.locator('#detail-tab-result').focus();
    const order = await page.locator('[data-detail-tab]').evaluateAll(tabs => tabs.map(tab => (tab as HTMLElement).dataset.detailTab!));
    for (let step = 0; step < order.length; step++) {
      const tab = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.detailTab!);
      await page.locator(`#detail-panel[data-tab="${tab}"]`).waitFor();
      if (tab === 'collaboration') {
        // Audit the full layer too, then return to the simple default and put focus back on the tab.
        await page.locator('.collab-now-ended').waitFor();
        await page.locator('.collab-detail-toggle [data-collab-detail="full"]').click();
        await page.locator('.collab-surface [data-collab-task]').first().waitFor();
        await settled(page);
        await clean(page, `sample collaboration full layer (${locale})`);
        await page.locator('.collab-detail-toggle [data-collab-detail="simple"]').click();
        await page.locator('.collab-now-ended').waitFor();
        await page.locator('#detail-tab-collaboration').focus();
      }
      await settled(page);
      assert.equal(await page.locator(`#detail-tab-${tab}`).getAttribute('aria-selected'), 'true');
      await clean(page, `sample ${tab} tab (${locale})`);
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(previous => (document.activeElement as HTMLElement | null)?.dataset.detailTab !== previous, tab);
    }
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.detailTab), order[0]);
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.detailTab), order.at(-1));
    mark(`the sample's tabs follow the arrow-key pattern and every panel passes the audit (${locale})`);

    // On a phone the run fills the screen; the new-research page shows its composer, whichever input mode it was left in.
    await page.setViewportSize({ width: 375, height: 760 });
    await settled(page);
    await clean(page, `375px run (${locale})`);
    await page.locator('#open-history').click();
    await page.locator('#history-dialog[open]').waitFor();
    await page.locator('#open-draft').click();
    await page.locator('body[data-view="draft"]').waitFor({ state: 'attached' });
    await page.locator('#submit-run').or(page.locator('#natural-research #formalize-original')).first().waitFor();
    await settled(page);
    await clean(page, `375px new research (${locale})`);
    mark(`the 375px layout passes the audit (${locale})`);
    await page.screenshot({ path: path.join(output, `a11y-${locale}-375.png`) });
    assert.deepEqual(errors, []);
    await context.close();
  }

  // Forced colours (Windows high contrast) drop backgrounds, border colours and shadows; current, selected and focused
  // states must still show, and the Lean source carries no token colours that would read as search matches.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, forcedColors: 'active', reducedMotion: 'reduce' });
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    const now = new Date().toISOString(), ids = ['0123abcd-0123-4abc-8def-0123456789ab', '1123abcd-0123-4abc-8def-0123456789ab'];
    const chats = ids.map((id, index) => ({ id, title: ['证明素数有无穷多个', '一元五次方程'][index], createdAt: now, updatedAt: now, answering: false }));
    const thread = { ...chats[0], messages: [{ id: 'm1', role: 'user', kind: 'text', text: '证明素数有无穷多个。', createdAt: now, status: 'complete' },
      { id: 'm2', role: 'assistant', kind: 'text', text: '假设只有有限个素数。', createdAt: now, status: 'complete', replyTo: 'm1' }] };
    await context.route('**/api/conversations', route => route.request().method() === 'GET' ? route.fulfill({ json: { conversations: chats } }) : route.abort());
    await context.route('**/api/conversations/*', route => route.request().method() === 'GET' ? route.fulfill({ json: { conversation: thread } }) : route.abort());
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // The browser's Highlight, read from a probe, since its value differs between systems.
    const highlight = () => page.evaluate(() => {
      const probe = document.body.appendChild(document.createElement('i')); probe.style.color = 'Highlight';
      const value = getComputedStyle(probe).color; probe.remove(); return value;
    });
    const outline = (selector: string) => page.locator(selector).first().evaluate(element => {
      const style = getComputedStyle(element); return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
    });
    await page.goto(`${origin}/?chat=${ids[0]}`);
    await page.locator('.chat-message-user').waitFor();
    await openHistory(page); await settled(page);
    const system = await highlight();
    assert.deepEqual(await outline('.chat-history-item[aria-current="page"]'), { style: 'solid', width: '2px', color: system }, 'The current conversation is ringed');
    assert.equal((await outline('.chat-history-item:not([aria-current])')).style, 'none', 'Other conversations are not ringed');
    assert.equal(await page.locator('.chat-message-user').evaluate(element => getComputedStyle(element).borderTopStyle), 'solid', 'The question keeps an outline');
    await page.locator('#formalize-original').focus();
    assert.deepEqual(await outline('#formalize-form'), { style: 'solid', width: '2px', color: system }, 'The focused composer is ringed');
    await page.screenshot({ path: path.join(output, 'a11y-forced-colors-chat.png') });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await page.locator('#command-palette[open]').waitFor(); await page.keyboard.press('ArrowDown');
    // The active row is drawn in system colours without the Canvas backplate that would hide its label.
    assert.deepEqual(await page.locator('.palette-options button[aria-selected=true]').evaluate(element => [getComputedStyle(element).backgroundColor,
      getComputedStyle(element.querySelector('.palette-label')!).forcedColorAdjust]), [system, 'none']);
    await page.keyboard.press('Escape');
    mark('forced colours: the current conversation, the focused composer and the palette row are shown in system colours');

    await page.goto(origin); await ready(page);
    await openSample(page);
    await page.locator('#detail-tab-source').click();
    await page.locator('#detail-panel[data-tab="source"] .code-scroll code').waitFor(); await settled(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    assert.equal((await outline('#detail-tab-source')).color, system, 'The selected tab is ringed');
    assert.equal((await outline('#detail-tab-result')).style, 'none');
    const tokens = () => page.evaluate(() => CSS.highlights.get('lean-keyword')?.size ?? 0);
    assert.equal(await tokens(), 0, 'Forced colours paint highlights as selections, so the source has no token highlights');
    await page.screenshot({ path: path.join(output, 'a11y-forced-colors-source.png') });
    await page.emulateMedia({ forcedColors: 'none' });
    await page.waitForFunction(() => (CSS.highlights.get('lean-keyword')?.size ?? 0) > 0);
    mark('forced colours: the selected tab is ringed, and the Lean token colours return when forced colours end');
    assert.deepEqual(errors, []);
    await context.close();
  }

} finally {
  await browser?.close();
  service.server.close();
}
console.log('Accessibility checks passed: audit of the welcome, dialogs, sample tabs, phone layout; keyboard order, focus rings and focus return; forced colours.');
