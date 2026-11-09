#!/usr/bin/env bun
// Disposable loopback services exercise capability failures and recovery without starting research.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/frontend-round9/availability');
await fs.mkdir(output, { recursive: true });
const checks: object[] = [], errors: string[] = [], external: string[] = [], writes: string[] = [];
const original = '保留这份原题：对任意自然数 n，证明 n + 0 = n。';
const texts = {
  zh: {
    runtime: '当前服务暂不支持自然语言解题，可切换到 Lean 输入。',
    provider: '当前服务未配置自然语言解题的模型，请联系管理员；也可切换到 Lean 输入。',
    offline: '运行环境暂未就绪，原题会保留；恢复后可继续发送。',
  },
  en: {
    runtime: 'This service does not currently support solving natural-language problems. You can switch to Lean input.',
    provider: 'No model service is configured for natural-language problems. Contact the administrator, or switch to Lean input.',
    offline: 'The runtime is not ready. Your problem is kept; you can send it when the runtime recovers.',
  },
};
let phase = 'setup', failure: unknown, runnerCalls = 0;
try {
  for (const kind of ['runtime', 'provider', 'offline'] as const) {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round9-availability-'));
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    let runtimeReady = kind !== 'offline';
    const runner: WebRunner = {
      async readiness() { return { ready: runtimeReady, message: runtimeReady ? 'Ready' : 'Fixture runtime unavailable' }; },
      async run() { runnerCalls++; throw new Error('Availability checks must not start a run'); },
      ...(kind === 'runtime' ? {} : { async formalize() { runnerCalls++; throw new Error('Availability checks must not formalize'); } }),
    };
    const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
      THEOREMOS_WEB_DATA_ROOT: data,
      THEOREMOS_WEB_STATIC_ROOT: process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web'),
      THEOREMOS_WEB_PROVIDERS: JSON.stringify([{ id: kind === 'provider' ? 'sub2api' : 'openai', name: 'Disposable fixture', baseUrl: 'https://example.invalid/v1' }]),
    });
    const service = createWebService(config, runner, { sample: null });
    let browser: Browser | undefined;
    try {
      browser = await startBrowser(service.server, port);
      for (const [locale, width] of [['zh', 1440], ['en', 390]] as const) {
        phase = `${kind}/${locale}/${width}`;
        const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
        await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, locale]);
        await context.route(/^https?:\/\//u, async route => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
          if (url.pathname.startsWith('/api/') && route.request().method() !== 'GET') {
            writes.push(`${phase}: ${route.request().method()} ${url.pathname}`);
            await route.abort(); return;
          }
          await route.continue();
        });
        const page = await context.newPage(); page.setDefaultTimeout(12_000);
        page.on('pageerror', error => errors.push(`${phase}: ${error.message}`));
        try {
          const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/formalizations');
          await page.goto(origin); const capabilities = (await (await response).json()).generation;
          assert.equal(capabilities.available, false); assert.equal(capabilities.reason, kind === 'provider' ? 'provider' : 'runtime');
          await page.locator('#formalize-original').fill(original);
          await page.locator('#open-settings').click();
          if (kind !== 'provider') await page.locator('#formalize-key').fill('sk-disposable-availability');
          await page.locator('#formalize-settings > summary').click();
          assert.equal(await page.locator('#formalize-start').isDisabled(), true);
          const before = await page.locator('#natural-research').innerText();
          await fs.writeFile(path.join(output, `${kind}-${locale}-${width}-observed.json`), JSON.stringify({ capabilities, text: before }, null, 2) + '\n');
          await page.screenshot({ path: path.join(output, `${kind}-${locale}-${width}.png`), fullPage: true });
          assert.equal(await page.locator('#formalize-send-status').innerText(), texts[locale][kind], 'A disabled natural-language send must explain the current blocker');
          assert.ok(!before.includes('API Key 后发送') && !before.includes('Enter your API key'), 'An unavailable capability must not be presented as a missing key');
          if (kind === 'runtime' || kind === 'provider') {
            await page.locator('.chat-lean-entry').click();
            await page.locator('#source').waitFor();
            assert.equal(await page.locator('#submit-run').isEnabled(), true, 'Lean remains available when only natural-language solving is unsupported');
            await page.locator('#open-natural-language').click();
            await page.locator('#formalize-original').waitFor();
            assert.equal(await page.locator('#formalize-original').inputValue(), original, 'The original survives checking the Lean alternative');
          } else {
            runtimeReady = true;
            const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/formalizations');
            await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
            await refreshed;
            await page.locator('#formalize-start:enabled').waitFor({ state: 'attached' });
            assert.equal(await page.locator('#formalize-send-status').count(), 0, 'A recovered capability clears the old blocker');
            assert.equal(await page.locator('#formalize-original').inputValue(), original);
            runtimeReady = false;
          }
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          checks.push({ name: phase, status: 'passed', capabilityReason: capabilities.reason, actionableBlocker: true,
            draftPreserved: true, ...(kind === 'offline' ? { recoveredWithoutReload: true } : { leanFallbackAvailable: true }) });
          console.log(`PASS ${phase}`);
        } finally { await context.close(); }
      }
    } finally { await browser?.close(); await service.close(); await fs.rm(data, { recursive: true, force: true }); }
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []); assert.equal(runnerCalls, 0);
} catch (error) { failure = error; throw error; }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, errors, external,
    writes, runnerCalls, realModels: 0, realLean: 0, externalMail: 0, fixturesRemoved: true,
    ...(failure ? { failure: String(failure) } : {}) }, null, 2) + '\n');
}
