#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { freePort, startBrowser } from './web-scenario';
import { showArtifacts } from './web-ui-controls';

/**
 * First-load cost of the workbench on a slow connection: bytes on the wire per resource, first contentful paint and the
 * time until the chat composer takes input, for a first visit and a repeat visit. `--report` only prints; otherwise the budget
 * below is enforced. Fixture runner, no model or Lean; the service is the real one, so headers and encoding are what
 * users get from the origin.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-load');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the load check.'); });
await fs.mkdir(output, { recursive: true });
const reportOnly = process.argv.includes('--report');
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local load fixture; no model or Lean' }; },
  async run(_input, send) { send({ type: 'result', result: { status: 'incomplete', proof: '', report: { fixture: true } } }); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner);
const browser = await startBrowser(service.server, port);
// Roughly "Fast 3G": 150 ms round trip, 1.6 Mbit/s down.
const slow = { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 };
type Visit = { firstContentfulPaintMs: number; readyMs: number; transferred: number; resources: { path: string; bytes: number; encoding: string; cache: string }[] };
async function visit(page: Page): Promise<Visit> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', slow);
  const seen = new Map<string, { path: string; encoding: string; cache: string; bytes: number }>();
  cdp.on('Network.responseReceived', event => {
    const url = new URL(event.response.url); if (url.origin !== origin) return;
    const header = (name: string) => Object.entries(event.response.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? '';
    seen.set(event.requestId, { path: url.pathname, encoding: header('content-encoding') || 'identity',
      cache: event.response.fromDiskCache || event.response.fromPrefetchCache ? 'disk' : header('cache-control'), bytes: 0 });
  });
  cdp.on('Network.loadingFinished', event => { const item = seen.get(event.requestId); if (item) item.bytes = event.encodedDataLength; });
  const started = Date.now();
  await page.goto(origin, { waitUntil: 'commit' });
  // The workbench opens on the natural-language composer; it is ready once the question box takes input.
  await page.locator('#formalize-original:enabled').waitFor({ timeout: 120_000 });
  const readyMs = Date.now() - started;
  // Fonts are requested once text needs them; wait for them and the network to go quiet before counting.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle', { timeout: 120_000 });
  const firstContentfulPaintMs = await page.evaluate(() => Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1));
  const resources = [...seen.values()].filter(item => !item.path.startsWith('/api/')).sort((a, b) => b.bytes - a.bytes);
  await cdp.detach();
  return { firstContentfulPaintMs, readyMs, transferred: resources.reduce((sum, item) => sum + item.bytes, 0), resources };
}
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
function print(name: string, result: Visit) {
  console.log(`${name}: FCP ${result.firstContentfulPaintMs} ms, ready ${result.readyMs} ms, ${kb(result.transferred)} transferred`);
  for (const item of result.resources) console.log(`  ${item.path.padEnd(40)} ${kb(item.bytes).padStart(8)}  ${item.encoding.padEnd(8)} ${item.cache}`);
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const first = await visit(await context.newPage());
  const repeat = await visit(await context.newPage());
  await context.close();
  print('first visit', first); print('repeat visit', repeat);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), network: slow, first, repeat }, null, 2));
  if (!reportOnly) {
    // Measured 2026-10-27 on this profile: first 240 KB code, 1610 KB total, FCP 0.7 s, ready 3.5 s; repeat 6 KB, ready 1.0 s.
    // 2026-11-05, chat-first workbench: first 349 KB code (app.js 284 KB with KaTeX moved to math.js, loaded with the first
    // formula), 788 KB total, FCP 0.8 s, ready 4.0 s; repeat 7 KB, ready 1.0 s. The code budget moved from 300 KB to 380 KB.
    // The margins absorb machine noise; growing past them is a decision, not drift.
    const code = (visit: Visit) => visit.resources.filter(item => /\.(?:js|css)$|\/$/u.test(item.path)).reduce((sum, item) => sum + item.bytes, 0);
    // Files up to 1 KB (theme.js) are sent as they are, as in staticFiles.ts; with headers they transfer under 2 KB.
    for (const item of first.resources.filter(item => /\.(?:js|css|html)$|\/$/u.test(item.path) && item.bytes > 2048))
      assert.ok(['br', 'gzip'].includes(item.encoding), `${item.path} must be sent compressed, got ${item.encoding}`);
    assert.ok(code(first) <= 380 * 1024, `first visit HTML, JS and CSS ${kb(code(first))} exceed 380 KB`);
    assert.ok(first.transferred <= 1800 * 1024, `first visit ${kb(first.transferred)} exceeds 1800 KB`);
    assert.ok(first.firstContentfulPaintMs > 0 && first.firstContentfulPaintMs <= 1500, `first contentful paint ${first.firstContentfulPaintMs} ms exceeds 1500 ms`);
    assert.ok(first.readyMs <= 5000, `first visit ready after ${first.readyMs} ms, budget 5000 ms`);
    assert.ok(repeat.transferred <= 50 * 1024, `repeat visit ${kb(repeat.transferred)} exceeds 50 KB`);
    assert.ok(repeat.readyMs <= 2000, `repeat visit ready after ${repeat.readyMs} ms, budget 2000 ms`);
    console.log('Load budget checks passed');

    const versionedApp = first.resources.find(item => /^\/app\.[a-f0-9]{16}\.js$/u.test(item.path));
    assert.ok(versionedApp?.cache.includes('immutable'), 'The workbench starts from a cacheable, versioned entry');
    assert.ok(first.resources.some(item => /^\/app\.[a-f0-9]{16}\.css$/u.test(item.path) && item.cache.includes('immutable')),
      'The workbench loads its matching stylesheet');
    assert.equal(first.resources.some(item => item.path === '/app.js' || item.path === '/app.css'), false,
      'A cached entry from an earlier deployment cannot intercept the current page');
    assert.ok(repeat.resources.some(item => item.path === versionedApp.path && item.bytes === 0),
      'A repeat visit uses the versioned entry from the browser cache');
    assert.ok(first.resources.some(item => /^\/chunks\/[\w-]+-[A-Z0-9]{8}\.js$/u.test(item.path) && item.cache.includes('immutable')),
      'The hashed import graph can be cached too');
    console.log('PASS the workbench opens the current version and a repeat visit reuses its cached assets');

    assert.equal(first.resources.some(item => /\/chunks\/(?:runViews|en)-/u.test(item.path)), false,
      'A blank Chinese composer does not load the run workspace or full English dictionary');
    assert.equal(first.resources.some(item => /\/assets\/(?:fonts\/Noto(?:Sans|Serif)SC-common\.woff2|katex\/katex\.min\.css)$/u.test(item.path)), false,
      'An empty workbench skips the long-text fonts and math stylesheet');
    const englishContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    const english = await englishContext.newPage(), englishErrors: string[] = [];
    english.on('pageerror', error => englishErrors.push(error.message));
    await english.goto(`${origin}/?lang=en`);
    await english.locator('#formalize-original:enabled').waitFor();
    assert.equal(await english.locator('html').getAttribute('lang'), 'en-US');
    assert.equal(await english.locator('#open-natural-language').innerText(), 'Natural language');
    assert.ok(await english.evaluate(() => performance.getEntriesByType('resource').some(item => /\/chunks\/en-/u.test(item.name))),
      'English loads its full dictionary before presenting the composer');
    assert.deepEqual(englishErrors, []);
    await englishContext.close();
    console.log('PASS empty Chinese and English composers load the required language modules');

    const historyContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    const history = await historyContext.newPage();
    const capabilities = Promise.withResolvers<void>();
    const historyId = crypto.randomUUID(), at = new Date().toISOString();
    await history.route('**/api/formalizations', async route => {
      await capabilities.promise;
      await route.continue();
    });
    await history.route('**/api/conversations', route => route.fulfill({ json: { conversations: [
      { id: historyId, title: '已保存的对话', createdAt: at, updatedAt: at, answering: false },
    ] } }));
    try {
      await history.goto(origin);
      await history.locator(`[data-chat-row="${historyId}"]`).waitFor({ state: 'attached', timeout: 5_000 });
    } finally {
      capabilities.resolve();
      await history.unrouteAll({ behavior: 'wait' });
      await historyContext.close();
    }
    console.log('PASS conversation history appears while formalization records are still loading');

    const startContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    try {
      for (const fault of ['network', 'body', 'gateway', 'stalled'] as const) {
        const startup = await startContext.newPage();
        const firstAttempt = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        let reads = 0;
        await startup.clock.install();
        await startup.route(/\/api\/session\?runs$/u, async route => {
          if (++reads !== 1) return route.continue();
          firstAttempt.resolve();
          if (fault === 'network') return route.abort('connectionreset');
          if (fault === 'body') return route.fulfill({ contentType: 'application/json', body: '{"auth":' });
          if (fault === 'gateway') return route.fulfill({ status: 503, json: { error: 'Local fixture unavailable' } });
          await release.promise;
          return route.abort('failed').catch(() => {});
        });
        try {
          await startup.goto(origin, { waitUntil: 'domcontentloaded' });
          await firstAttempt.promise;
          if (fault === 'stalled') {
            await startup.locator('#workbench-connecting').waitFor();
            await startup.clock.runFor(6500);
          }
          await startup.locator('#formalize-original:enabled').waitFor({ timeout: 3500 });
          assert.equal(reads, 2, `Startup recovers from a ${fault} failure with one replacement request`);
          assert.equal(await startup.locator('#global-notice').isHidden(), true);
        } finally {
          release.resolve();
          await startup.close();
        }
      }
    } finally { await startContext.close(); }
    console.log('PASS initial connection recovers from a dropped fetch, truncated JSON, 503, or stalled first response');

    const retryContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    const retry = await retryContext.newPage();
    await retry.route('**/chunks/runViews-*.js', route => route.abort('failed'));
    await retry.goto(`${origin}/?sample`);
    await retry.locator('[data-chat-result-more]').waitFor({ state: 'attached' });
    await retry.locator('[data-chat-result-more] > summary').click();
    await retry.locator('[data-research-artifact="roadmap"]').click();
    await retry.locator('#detail-panel [role="alert"]').waitFor();
    await retry.unroute('**/chunks/runViews-*.js');
    await retry.locator('#detail-panel').getByRole('button', { name: '重试', exact: true }).click();
    await retry.locator('[data-sample-badge]').waitFor({ state: 'attached' });
    await showArtifacts(retry);
    assert.equal(new URL(retry.url()).searchParams.has('sample'), true);
    assert.equal(await retry.locator('#detail-panel [role="alert"]').count(), 0);
    await retryContext.close();
    console.log('PASS a failed workspace module is visible and Retry restores the selected sample');
  }
} finally {
  await browser.close(); await service.close();
}
