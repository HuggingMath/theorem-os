#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { localeStorageKey } from '../apps/web/i18n';
import { themeStorageKey } from '../apps/web/client/themePreference';
import { audit } from './web-a11y';
import { contrastProblems } from './web-contrast';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-guide');
await fs.access(path.join(root, 'out/web/guide.js')).catch(() => { throw new Error('Run bun run build:web before the guide check.'); });
await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: '本地说明页验证环境' }; },
  async run() { throw new Error('The guide check must not start a run'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner);
const mark = (check: string) => console.log(`PASS ${check}`);
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const sections = ['start', 'watch', 'results', 'after', 'keys', 'data'];

async function open(browser: Browser, options: { locale?: 'zh' | 'en'; theme?: 'light' | 'dark'; width?: number } = {}) {
  const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 } });
  // Seeded once, so a reload after the page's own language switch keeps the new choice.
  await context.addInitScript(([localeKey, locale, themeKey, theme]) => {
    if (locale && localStorage.getItem(localeKey) === null) localStorage.setItem(localeKey, locale);
    if (theme && localStorage.getItem(themeKey) === null) localStorage.setItem(themeKey, theme);
  }, [localeStorageKey, options.locale ?? '', themeStorageKey, options.theme ?? ''] as const);
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return { context, page, errors };
}

/** Visible Chinese text, apart from the language switch, which names Chinese in Chinese. */
function chineseText(page: Page) {
  return page.evaluate(() => {
    const han = /[　-〿一-鿿＀-￯]/u, found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement, text = node.textContent?.trim() ?? '';
      if (han.test(text) && parent?.checkVisibility() && !parent.closest('[lang="zh-CN"]')) found.push(text.slice(0, 60));
    }
    for (const element of document.querySelectorAll('[aria-label],[title]')) for (const name of ['aria-label', 'title']) {
      const value = element.getAttribute(name);
      if (value && han.test(value) && !element.closest('[lang="zh-CN"]')) found.push(`[${name}] ${value.slice(0, 60)}`);
    }
    if (han.test(document.title)) found.push(`title ${document.title}`);
    return found;
  });
}
let browser: Browser | undefined;
try {
  browser = await startBrowser(service.server, port);

  // The welcome, the glossary and the palette each open the guide in a new tab, so a draft in progress stays put.
  {
    const { context, page, errors } = await open(browser);
    await page.goto(origin);
    await page.locator('#submit-run:enabled').waitFor({ state: 'attached' });
    const welcomeGuide = page.locator('.chat-welcome a[data-guide]');
    assert.equal(await welcomeGuide.innerText(), '使用说明');
    assert.equal(await welcomeGuide.getAttribute('target'), '_blank');
    const [fromWelcome] = await Promise.all([context.waitForEvent('page'), welcomeGuide.click()]);
    await fromWelcome.locator('#start-heading').waitFor();
    assert.equal(new URL(fromWelcome.url()).pathname, '/guide.html');
    await fromWelcome.close();
    await page.locator('#open-glossary').click();
    await page.locator('#glossary-dialog[open]').waitFor();
    const [fromGlossary] = await Promise.all([context.waitForEvent('page'), page.locator('#glossary-dialog a[data-guide]').click()]);
    await fromGlossary.locator('#start-heading').waitFor();
    await fromGlossary.close();
    await page.locator('#close-glossary').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await page.locator('#command-palette[open] input').fill('说明');
    const [fromPalette] = await Promise.all([context.waitForEvent('page'), page.locator('#palette-open-guide').click()]);
    await fromPalette.locator('#start-heading').waitFor();
    await fromPalette.close();
    assert.match(await page.locator('.welcome-steps').innerText(), /是否保存由你决定/u, 'The welcome no longer says the reader decides whether the key is kept');
    assert.deepEqual(errors, []);
    await context.close();
  }
  mark('the welcome, glossary and command palette open the guide in a new tab');

  // The guide itself: every section in the contents, working anchors, a way back, and no accessibility problems.
  {
    const { context, page, errors } = await open(browser);
    await page.goto(`${origin}/guide.html`);
    await page.locator('#locale-switch:not([hidden])').waitFor();
    assert.deepEqual(await page.locator('.guide-toc a').evaluateAll(links => links.map(link => link.getAttribute('href'))), sections.map(id => `#${id}`));
    for (const id of sections) assert.equal(await page.locator(`section#${id} h2`).count(), 1, `Section ${id} has no heading`);
    // A section high enough on the page to scroll to the top; the last ones end where the page does.
    await page.locator('.guide-toc a[href="#results"]').click();
    await settled(page);
    assert.ok(Math.abs((await page.locator('#results').boundingBox())!.y - 16) < 4, 'The contents link does not reach its section');
    assert.equal(await page.locator('.share-top a[href="./"]').count(), 1, 'The guide has no way back to the workbench');
    assert.match((await page.locator('a[data-feedback]').getAttribute('href'))!, /feedback\.html/u);
    assert.deepEqual(await audit(page, { uniqueIds: true, references: true }), []);
    assert.deepEqual(await contrastProblems(page), [], 'Guide contrast below WCAG AA (light)');
    await page.screenshot({ path: path.join(output, 'guide-zh-1440.png'), fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  }
  mark('the guide lists its sections, the contents links work, and it passes the accessibility and contrast rules');

  // English, the dark theme and phone widths.
  {
    const { context, page, errors } = await open(browser, { locale: 'en', theme: 'dark' });
    await page.goto(`${origin}/guide.html`);
    await page.locator('#locale-switch:not([hidden])').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en-US');
    assert.equal(await page.locator('h1').innerText(), 'Guide');
    assert.deepEqual(await chineseText(page), []);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.deepEqual(await contrastProblems(page), [], 'Guide contrast below WCAG AA (dark)');
    await page.screenshot({ path: path.join(output, 'guide-en-dark-1440.png'), fullPage: true });
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 760 });
      await settled(page);
      assert.ok(await noOverflow(page), `Guide overflows at ${width}px`);
      await page.screenshot({ path: path.join(output, `guide-en-dark-${width}.png`), fullPage: true });
    }
    // The switch goes back to Chinese and stays on the guide.
    await page.locator('#locale-switch').click();
    await page.locator('h1', { hasText: '使用说明' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/guide.html');
    assert.deepEqual(errors, []);
    await context.close();
  }
  mark('the guide is fully English in English, legible in the dark theme, fits 375px and 320px, and switches language in place');
  console.log('Guide checks passed: entry points, contents, accessibility, contrast in both themes, English and phone widths.');
} finally {
  await browser?.close();
  await service.close();
}
