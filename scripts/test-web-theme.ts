#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { localeStorageKey } from '../apps/web/i18n';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { themeStorageKey } from '../apps/web/client/themePreference';
import { audit } from './web-a11y';
import { contrastProblems } from './web-contrast';
import { freePort, settled, startBrowser, ready } from './web-scenario';
import { openModulesTab, openSample, showExamples, clickWorkbenchAction } from './web-ui-controls';

/**
 * Light and dark interface: without a choice the page follows the system, before the first paint and live when the
 * system changes; a choice from the account dialog or the command palette wins, survives a reload, reaches other tabs
 * and is removed again by "Match system". Every visible text passes WCAG contrast in both themes on the welcome page,
 * every tab of the read-only sample, the dialogs, a phone width, the login page and the share page, and the focused composer's
 * outline passes the 3:1 non-text contrast.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-theme');
await fs.access(path.join(root, 'out/web/theme.js')).catch(() => { throw new Error('Run bun run build:web before the theme check.'); });
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Theme check' }; },
  async run() { throw new Error('The theme check must not start a run'); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner);
// The login page only stays when email sign-in is on; it gets its own service with a stub mailer.
const loginPort = await freePort(), loginOrigin = `http://127.0.0.1:${loginPort}`;
const loginService = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(loginPort), THEOREMOS_WEB_PUBLIC_URL: loginOrigin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:',
  THEOREMOS_WEB_ALLOWLIST: 'reader@example.org', THEOREMOS_WEB_DATA_ROOT: path.join(output, 'login-data') }), runner, { mailer: async () => {} });
const mark = (check: string) => console.log(`PASS ${check}`);
const paper = { light: 'rgb(245, 244, 238)', dark: 'rgb(27, 26, 24)' };
const theme = (page: Page) => page.evaluate(() => ({ theme: document.documentElement.dataset.theme, background: getComputedStyle(document.documentElement).backgroundColor,
  chrome: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') }));
const stored = (page: Page) => page.evaluate(key => localStorage.getItem(key), themeStorageKey);
const legible = async (page: Page, where: string, scope?: string) => assert.deepEqual(await contrastProblems(page, scope), [], `Contrast below WCAG AA: ${where}`);

async function open(browser: Browser, colorScheme: 'light' | 'dark', width = 1440, locale: 'zh' | 'en' = 'zh') {
  const context = await browser.newContext({ viewport: { width, height: width > 850 ? 900 : 812 }, colorScheme, reducedMotion: 'reduce' });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, locale] as const);
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, errors };
}
async function workbench(page: Page) {
  await page.goto(origin);
  await ready(page);
  await settled(page);
}
async function paletteRun(page: Page, id: string) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('#command-palette[open]').waitFor();
  await page.locator(`#palette-${id}`).click();
  await page.locator('#command-palette').waitFor({ state: 'hidden' });
}
let browser: Browser | undefined;
try {
  browser = await startBrowser(service.server, port);
  await new Promise<void>(resolve => loginService.server.listen(loginPort, '127.0.0.1', resolve));

  // No choice: the system theme is on <html> before any script of the app runs, and follows a live system change.
  for (const scheme of ['light', 'dark'] as const) {
    const { context, page, errors } = await open(browser, scheme);
    await page.route(/\/app\.[a-f0-9]{16}\.js$/u, async route => { await new Promise(resolve => setTimeout(resolve, 400)); await route.continue(); });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.deepEqual(await theme(page), { theme: scheme, background: paper[scheme], chrome: scheme === 'dark' ? '#1b1a18' : '#f5f4ee' }, `first paint follows the ${scheme} system theme`);
    await ready(page);
    assert.equal(await stored(page), null, 'Following the system stores nothing');
    await page.emulateMedia({ colorScheme: scheme === 'light' ? 'dark' : 'light' });
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, scheme === 'light' ? 'dark' : 'light');
    assert.deepEqual(errors, []);
    await context.close();
  }
  mark('without a choice the page has the system theme before the app script runs, stores nothing and follows a system change');

  // A choice from the palette wins over the system, survives a reload, reaches another tab, and "Match system" removes it.
  {
    const { context, page, errors } = await open(browser, 'light');
    await workbench(page);
    await paletteRun(page, 'theme-dark');
    assert.deepEqual(await theme(page), { theme: 'dark', background: paper.dark, chrome: '#1b1a18' });
    assert.equal(await stored(page), 'dark');
    const other = await context.newPage();
    await workbench(other);
    assert.equal((await theme(other)).theme, 'dark', 'A new tab opens with the choice');
    await page.reload(); await ready(page);
    assert.equal((await theme(page)).theme, 'dark', 'The choice survives a reload');
    await page.emulateMedia({ colorScheme: 'light' });
    assert.equal((await theme(page)).theme, 'dark', 'A choice is not overridden by the system');
    await paletteRun(page, 'theme-light');
    await other.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await page.locator('#command-palette[open]').waitFor();
    assert.equal(await page.locator('#palette-theme-light').count(), 0, 'The palette does not offer the current choice');
    assert.equal(await page.locator('#palette-theme-system').count(), 1);
    await page.keyboard.press('Escape');
    await paletteRun(page, 'theme-system');
    assert.equal(await stored(page), null, '"Match system" removes the stored choice');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    // emulateMedia changes one page only; the other tab still sees a light system and now follows it.
    await other.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.deepEqual(errors, []);
    await context.close();
  }
  mark('a palette choice wins over the system, survives a reload, reaches other tabs and "Match system" removes it');

  // The account dialog shows the current choice and changes it; the dialog passes the audit and contrast in both themes.
  {
    const { context, page, errors } = await open(browser, 'dark');
    await workbench(page);
    const showAccount = () => page.evaluate(() => (document.getElementById('account-dialog') as HTMLDialogElement).showModal());
    await showAccount();
    assert.equal(await page.locator('input[name="theme"][value="system"]').isChecked(), true);
    await legible(page, 'account dialog (dark)', '#account-dialog');
    assert.deepEqual(await audit(page, { scope: '#account-dialog' }), [], 'Account dialog accessibility');
    await page.locator('#account-dialog label:has(input[value="light"])').click();
    assert.equal((await theme(page)).theme, 'light');
    assert.equal(await stored(page), 'light');
    await legible(page, 'account dialog (light)', '#account-dialog');
    await page.screenshot({ path: path.join(output, 'account-light-1440.png') });
    await page.keyboard.press('ArrowRight');
    assert.equal((await theme(page)).theme, 'dark', 'The arrow keys move through the choice');
    await page.screenshot({ path: path.join(output, 'account-dark-1440.png') });
    await page.keyboard.press('Escape');
    await paletteRun(page, 'theme-system');
    await showAccount();
    assert.equal(await page.locator('input[name="theme"][value="system"]').isChecked(), true, 'The dialog shows a choice made in the palette');
    assert.deepEqual(errors, []);
    await context.close();
  }
  mark('the account dialog shows and changes the choice, works with the arrow keys and passes the audit and contrast in both themes');

  // Contrast over the whole workbench in both themes and both languages, and at a phone width.
  for (const scheme of ['light', 'dark'] as const) for (const locale of ['zh', 'en'] as const) {
    const { context, page, errors } = await open(browser, scheme, 1440, locale);
    await workbench(page);
    await legible(page, `welcome (${scheme}, ${locale})`);
    // At this width the history is the docked left column, checked with the rest of the page above.
    await showExamples(page);
    for (const [trigger, id] of [['#open-settings', 'run-settings'], ['.welcome-glossary', 'glossary-dialog'], ['Control+K', 'command-palette']]) {
      if (trigger === 'Control+K') await page.keyboard.press(trigger); else await clickWorkbenchAction(page, trigger);
      await page.locator(`#${id}[open]`).waitFor(); await settled(page);
      await legible(page, `${id} (${scheme}, ${locale})`, `#${id}`);
      await page.keyboard.press('Escape');
      await page.locator(`#${id}`).waitFor({ state: 'hidden' });
    }
    await openSample(page);
    for (const tab of ['result', 'trajectory', 'collaboration', 'source', 'events', 'modules']) {
      if (tab === 'modules') await openModulesTab(page);
      else await page.locator(`#detail-tab-${tab}`).click();
      if (tab === 'trajectory') await page.locator('#detail-panel .solution-route').waitFor();
      await settled(page);
      if (tab === 'collaboration') {
        await page.locator('.collab-detail-toggle [data-collab-detail="full"]').click(); await settled(page);
      }
      await legible(page, `sample ${tab} (${scheme}, ${locale})`);
      if (locale === 'zh') await page.screenshot({ path: path.join(output, `sample-${tab}-${scheme}-1440.png`) });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  for (const scheme of ['light', 'dark'] as const) {
    const { context, page, errors } = await open(browser, scheme, 390);
    await workbench(page);
    await legible(page, `phone compose (${scheme})`);
    await openSample(page); await settled(page);
    await legible(page, `phone sample (${scheme})`);
    await page.screenshot({ path: path.join(output, `phone-sample-${scheme}-390.png`) });
    assert.deepEqual(errors, []);
    await context.close();
  }
  mark('every visible text passes WCAG AA contrast in both themes: welcome, dialogs, palette, all sample tabs (zh and en) and a phone width');

  // Typing in the composer thickens its outline in a colour at 3:1 or more against the resting border, the page and its fill.
  for (const scheme of ['light', 'dark'] as const) {
    const { context, page, errors } = await open(browser, scheme);
    // The natural-language home, not workbench(), which switches to the Lean editor.
    await page.goto(origin); await page.locator('#formalize-original').waitFor(); await settled(page);
    const form = page.locator('#natural-research #formalize-form');
    const look = () => form.evaluate(element => { const style = getComputedStyle(element);
      return { border: style.borderTopColor, ring: style.boxShadow, fill: style.backgroundColor, page: getComputedStyle(document.body).backgroundColor }; });
    const idle = await look();
    await page.locator('#formalize-original').focus();
    await page.waitForFunction(border => getComputedStyle(document.querySelector('#natural-research #formalize-form')!).borderTopColor !== border, idle.border);
    const focused = await look();
    assert.ok(focused.ring.startsWith(`${focused.border} 0px 0px 0px 1px`), `The focused composer has a second pixel of outline (${scheme}): ${focused.ring}`);
    const ratios = await page.evaluate(([color, others]) => {
      const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
      const luminance = (value: string) => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = value; canvas.fillRect(0, 0, 1, 1);
        const [r, g, b] = [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3).map(channel => { channel /= 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      return others.map(other => { const [high, low] = [luminance(color), luminance(other)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05); });
    }, [focused.border, [idle.border, focused.page, focused.fill]] as const);
    assert.ok(ratios.every(ratio => ratio >= 3), `Composer focus contrast below 3:1 (${scheme}): ${ratios.map(ratio => ratio.toFixed(2)).join(', ')}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
  mark('the focused composer has a 2px outline at 3:1 or more against its resting border, the page and its fill, in both themes');

  // The login and share pages load the same theme script and pass contrast in the dark theme.
  {
    const { context, page, errors } = await open(browser, 'dark');
    await page.goto(`${loginOrigin}/login.html`);
    await page.locator('#send-code').waitFor(); await settled(page);
    assert.equal((await theme(page)).theme, 'dark');
    await legible(page, 'login (dark)');
    await page.screenshot({ path: path.join(output, 'login-dark-1440.png') });
    await page.goto(`${origin}/share.html#short`);
    await page.waitForLoadState('networkidle'); await settled(page);
    assert.equal((await theme(page)).theme, 'dark');
    await legible(page, 'share error (dark)');
    assert.deepEqual(errors, []);
    await context.close();
  }
  mark('the login and share pages follow the theme and pass contrast in the dark theme');
  console.log('Theme checks passed: system default before first paint and live, palette and account choice, persistence, other tabs, WCAG contrast in both themes, composer focus outline.');
} finally {
  await browser?.close(); await service.close(); await loginService.close();
}
