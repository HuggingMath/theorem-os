#!/usr/bin/env bun
import assert from 'node:assert/strict';
import path from 'node:path';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), {
  async readiness() { return { ready: true, message: 'Read-only screenshot preview' }; },
  async run() { throw new Error('Screenshots must never create a run'); },
  async formalize() { throw new Error('Screenshots must never create a formalization'); },
});
const browser = await startBrowser(service.server, port);
let writes = 0;
try {
  for (const locale of ['zh', 'en'] as const) for (const [width, height, filename] of [
    [1440, 500, 'workbench-desktop.png'], [390, 440, 'workbench-mobile.png'],
    [1440, 900, 'workbench-full-desktop.png'], [390, 844, 'workbench-full-mobile.png'],
  ] as const) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, locale]);
    const page = await context.newPage();
    await page.route('**/api/**', route => {
      if (route.request().method() !== 'GET') { writes++; return route.abort(); }
      return route.continue();
    });
    await page.goto(origin);
    await page.locator('#formalize-original').waitFor();
    await page.locator('.chat-start h1').waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('#formalize-original').inputValue(), '');
    assert.equal(await page.locator('#formalize-key').inputValue(), '');
    const name = locale === 'en' ? filename.replace('.png', '-en.png') : filename;
    await page.screenshot({ path: path.join(root, 'docs/assets', name) });
    await context.close();
  }
  assert.equal(writes, 0);
  console.log('Captured Chinese and English natural-language entry previews; no task submissions or model calls.');
} finally {
  await browser.close();
  await service.close();
}
