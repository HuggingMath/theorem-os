#!/usr/bin/env bun
import assert from 'node:assert/strict';
import path from 'node:path';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let modelInvocations = 0;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), {
  async readiness() { return { ready: true, message: 'Read-only screenshot preview' }; },
  async run() { modelInvocations++; throw new Error('Screenshots must never create a run'); },
  async formalize() { modelInvocations++; throw new Error('Screenshots must never create a formalization'); },
});
const browser = await startBrowser(service.server, port);
let writes = 0;
const captures: object[] = [], externalRequests: string[] = [], errors: string[] = [];
const labels = {
  zh: { language: 'zh-CN', title: '今天想证明什么？', problem: '证明：对任意自然数 n，n + 0 = n。' },
  en: { language: 'en-US', title: 'What would you like to prove?', problem: 'Prove that n + 0 = n for every natural number n.' },
};
try {
  for (const locale of ['zh', 'en'] as const) {
    const label = labels[locale];
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
      reducedMotion: 'reduce', locale: label.language });
    await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, locale]);
    await context.route(/^https?:\/\//, route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { externalRequests.push(url.origin); return route.abort(); }
      if (url.pathname.startsWith('/api/') && request.method() !== 'GET') { writes++; return route.abort(); }
      return route.continue();
    });
    try {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      await page.locator('.chat-start h1').filter({ hasText: label.title }).waitFor();
      assert.equal(await page.getAttribute('html', 'lang'), label.language);
      await page.locator('#formalize-original').fill(label.problem);
      for (const device of ['desktop', 'mobile'] as const) {
        const full = device === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 };
        await page.setViewportSize(full);
        const settle = () => page.evaluate(async () => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          await document.fonts.ready;
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        await settle();
        assert.equal(await page.locator('#formalize-original').inputValue(), label.problem);
        assert.equal(await page.locator('#formalize-key').inputValue(), '');
        const suffix = locale === 'en' ? '-en' : '';
        await page.screenshot({ path: path.join(root, 'docs/assets', `workbench-full-${device}${suffix}.png`) });
        captures.push({ locale, file: `workbench-full-${device}${suffix}.png`, logical: full, deviceScaleFactor: 2 });
        // Keep the product's full-height layout; crop the actual heading and composer after it has settled.
        if (device === 'mobile') { await page.setViewportSize({ width: 374, height: 844 }); await settle(); }
        const size = device === 'desktop' ? { width: 900, height: 520 } : { width: 350, height: 520 };
        const clip = await page.evaluate(size => {
          const heading = document.querySelector('.chat-start h1')!.getBoundingClientRect();
          const composer = document.querySelector('#formalize-form')!.getBoundingClientRect();
          const budget = document.querySelector('.chat-budget-summary')!.getBoundingClientRect();
          const bottom = budget.bottom + 8;
          const x = Math.round(composer.left + composer.width / 2 - size.width / 2);
          const y = Math.round(bottom - size.height);
          return { x, y, ...size, headingFits: heading.top >= y && heading.bottom <= y + size.height,
            composerFits: composer.left >= x && composer.right <= x + size.width + 1 && composer.bottom <= y + size.height,
            headerClear: y >= document.querySelector('#topbar')!.getBoundingClientRect().bottom };
        }, size);
        assert.ok(clip.headingFits && clip.composerFits && clip.headerClear,
          `The ${locale} ${device} preview must show the complete title and input below the page header`);
        const { x, y, width, height } = clip;
        await page.screenshot({ path: path.join(root, 'docs/assets', `workbench-${device}${suffix}.png`),
          clip: { x, y, width, height } });
        captures.push({ locale, file: `workbench-${device}${suffix}.png`, logical: size, viewport: page.viewportSize(),
          clip: { x, y, width, height }, problem: label.problem, deviceScaleFactor: 2 });
      }
    } finally { await context.close(); }
  }
  assert.equal(writes, 0);
  assert.equal(modelInvocations, 0);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ captures, writes, modelInvocations, externalRequests, errors,
    modelInvoked: false, problemSubmitted: false, apiKeyEmpty: true }, null, 2));
} finally {
  await browser.close();
  await service.close();
}
