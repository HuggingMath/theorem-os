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
import { showExamples, openSample } from './web-ui-controls';

/**
 * Keyboard and screen-reader pass over the workbench, in Chinese and English: the static audit (names, labels, ARIA
 * references, unique ids) on the welcome page, every tab of the sample run and each dialog; Tab reaches the main
 * controls with a visible focus ring; the detail tabs follow the arrow-key tab pattern; and every dialog closes on
 * Escape with focus back on the control that opened it. Runs against the read-only sample, so nothing is submitted.
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

/** Opens a dialog with its trigger, audits it, closes it with Escape and checks focus went back to the trigger. */
async function dialog(page: Page, trigger: string, id: string, where: string) {
  await page.locator(trigger).focus();
  await page.keyboard.press('Enter');
  await page.locator(`#${id}[open]`).waitFor();
  await settled(page);
  await clean(page, where, `#${id}`);
  assert.ok(await page.evaluate(dialogId => document.getElementById(dialogId)!.contains(document.activeElement), id), `${where}: focus did not move into the dialog`);
  await page.keyboard.press('Escape');
  await page.locator(`#${id}`).waitFor({ state: 'hidden' });
  assert.ok(await page.locator(trigger).evaluate(element => element === document.activeElement), `${where}: focus did not return to ${trigger}`);
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
    assert.ok(stops.some(stop => stop.name.startsWith('button#open-history')) && stops.some(stop => stop.name.startsWith('button#open-settings')), `Tab misses the top bar: ${stops.map(stop => stop.name).join(' | ')}`);
    mark(`Tab starts at the skip link and reaches the top bar with a visible focus ring (${locale})`);

    await dialog(page, '#open-settings', 'run-settings', `settings (${locale})`);
    // The simplified top bar keeps the glossary in the welcome and the palette.
    await dialog(page, '.welcome-glossary', 'glossary-dialog', `glossary (${locale})`);
    // Wide screens dock the history beside the workspace; its button folds and unfolds it and keeps focus.
    const history = page.locator('#open-history');
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
    // The top bar has no palette button; Ctrl+K opens it and Escape returns focus to where it was.
    await page.locator('#open-settings').focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await page.locator('#command-palette[open]').waitFor();
    await clean(page, `command palette (${locale})`, '#command-palette');
    await page.keyboard.press('Escape');
    await page.locator('#command-palette').waitFor({ state: 'hidden' });
    assert.ok(await page.locator('#open-settings').evaluate(element => element === document.activeElement), 'Palette did not return focus');
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

} finally {
  await browser?.close();
  service.server.close();
}
console.log('Accessibility checks passed: audit of the welcome, dialogs, sample tabs, phone layout; keyboard order, focus rings and focus return.');
