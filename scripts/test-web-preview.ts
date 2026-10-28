#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localeStorageKey } from '../apps/web/i18n';
import { audit } from './web-a11y';
import { freePort, settled, startBrowser } from './web-scenario';

/**
 * Renders the component preview in both interface languages at desktop and phone widths: every specimen mounts without
 * errors, English shows no untranslated interface text, nothing overflows the page, and each specimen passes the
 * static accessibility audit. Screenshots land in out/web-preview-check for review.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'out/web-preview'), output = path.join(root, 'out/web-preview-check');
await fs.access(path.join(site, 'preview.js')).catch(() => { throw new Error('Run bun run build:web-preview first.'); });
await fs.mkdir(output, { recursive: true });
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname, file = path.join(site, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(site)) { response.writeHead(403).end(); return; }
  try {
    const body = await fs.readFile(file);
    // The workbench's CSP forbids inline styles and scripts; the preview runs under the same rule.
    response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream',
      'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:" }).end(body);
  } catch { response.writeHead(404).end(); }
});
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const specimens = ['foundations', 'sections', 'topbar', 'conversation', 'monitor', 'header', 'result', 'collaboration'];
// Ids the workbench renders once per page; the preview mounts several variants of the same component side by side.
const repeatedIds = /^(open-history|open-settings|current-model|open-glossary|locale-switch|connection-status|open-account|detail-tab-[a-z]+|result-[a-z]+-heading)$/u;
const han = /[㐀-鿿]/u;

const browser = await startBrowser(server, port);
try {
  for (const locale of ['zh', 'en'] as const) for (const width of [1440, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, locale] as const);
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(origin);
    await page.locator('[data-specimen="collaboration"] [data-collab-task]').first().waitFor({ state: 'attached' });
    assert.equal(await page.locator('html').getAttribute('lang'), locale === 'en' ? 'en' : 'zh-CN');
    for (const id of specimens) {
      const stage = page.locator(`[data-specimen="${id}"] .preview-stage`);
      assert.ok((await stage.innerText()).trim().length > 0, `${id} rendered nothing`);
      if (locale === 'en') {
        // Interface text must be English; text marked with another language (the language switch) is meant to stay as is.
        const leaks = await stage.evaluate((node, pattern) => {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), found: string[] = [], expression = new RegExp(pattern, 'u');
          for (let text = walker.nextNode(); text; text = walker.nextNode()) if (expression.test(text.textContent ?? '') && !text.parentElement?.closest('[data-fixture],[lang]:not(html)')) found.push(text.textContent!.trim());
          for (const element of node.querySelectorAll('[aria-label],[title],[placeholder]')) for (const name of ['aria-label', 'title', 'placeholder'])
            if (expression.test(element.getAttribute(name) ?? '')) found.push(`${name}=${element.getAttribute(name)}`);
          return found;
        }, han.source);
        assert.deepEqual(leaks, [], `${id} shows untranslated text in English`);
      }
      const problems = (await audit(page, { scope: `[data-specimen="${id}"]`, uniqueIds: false })).filter(problem => !/^aria-controls points at missing #detail-panel/u.test(problem));
      assert.deepEqual(problems, [], `${id} accessibility (${locale}, ${width}px)`);
    }
    const duplicates = (await audit(page)).filter(problem => problem.startsWith('duplicate id') && !repeatedIds.test(problem.match(/#(\S+)/u)![1]!));
    assert.deepEqual(duplicates, [], 'Duplicate ids beyond the repeated component variants');
    // Name the outermost elements that stick out, so a failure says where to look.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth ? [] : [...document.querySelectorAll('body *')]
      .filter(element => element.getBoundingClientRect().right > innerWidth + 1 && !element.parentElement?.closest('.preview-stage *') && getComputedStyle(element).position !== 'fixed')
      .filter((element, _index, all) => !all.some(other => other !== element && other.contains(element)))
      .map(element => `${element.tagName.toLowerCase()}.${String(element.className).trim().split(/\s+/u).join('.')} ${Math.round(element.getBoundingClientRect().right)}px`).slice(0, 8));
    assert.deepEqual(overflow, [], `The preview overflows at ${width}px (${locale})`);
    // The palette opens from the preview bar and closes on Escape with focus back on its trigger.
    await page.locator('[data-preview-palette]').click();
    await page.locator('#command-palette[open]').waitFor();
    assert.deepEqual(await audit(page, { scope: '#command-palette', uniqueIds: false }), [], 'Command palette accessibility');
    await page.keyboard.press('Escape');
    await page.locator('#command-palette').waitFor({ state: 'hidden' });
    assert.deepEqual(errors, [], `Page errors (${locale}, ${width}px)`);
    await settled(page);
    await page.screenshot({ path: path.join(output, `preview-${locale}-${width}.png`), fullPage: true });
    console.log(`PASS component preview renders every specimen in ${locale} at ${width}px`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log('Component preview checks passed');
