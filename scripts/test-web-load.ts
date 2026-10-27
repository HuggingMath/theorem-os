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

/**
 * First-load cost of the workbench on a slow connection: bytes on the wire per resource, first contentful paint and the
 * time until the composer can submit, for a first visit and a repeat visit. `--report` only prints; otherwise the budget
 * below is enforced. Fixture runner, no model or Lean; the service is the real one, so headers and encoding are what
 * users get from the origin.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-load');
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
  await page.locator('#submit-run:enabled').waitFor({ timeout: 120_000 });
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
    // The margins absorb machine noise; growing past them is a decision, not drift.
    const code = (visit: Visit) => visit.resources.filter(item => /\.(?:js|css)$|\/$/u.test(item.path)).reduce((sum, item) => sum + item.bytes, 0);
    // Files up to 1 KB (theme.js) are sent as they are, as in staticFiles.ts; with headers they transfer under 2 KB.
    for (const item of first.resources.filter(item => /\.(?:js|css|html)$|\/$/u.test(item.path) && item.bytes > 2048))
      assert.ok(['br', 'gzip'].includes(item.encoding), `${item.path} must be sent compressed, got ${item.encoding}`);
    assert.ok(code(first) <= 300 * 1024, `first visit HTML, JS and CSS ${kb(code(first))} exceed 300 KB`);
    assert.ok(first.transferred <= 1800 * 1024, `first visit ${kb(first.transferred)} exceeds 1800 KB`);
    assert.ok(first.firstContentfulPaintMs > 0 && first.firstContentfulPaintMs <= 1500, `first contentful paint ${first.firstContentfulPaintMs} ms exceeds 1500 ms`);
    assert.ok(first.readyMs <= 5000, `first visit ready after ${first.readyMs} ms, budget 5000 ms`);
    assert.ok(repeat.transferred <= 50 * 1024, `repeat visit ${kb(repeat.transferred)} exceeds 50 KB; files must revalidate`);
    assert.ok(repeat.readyMs <= 2000, `repeat visit ready after ${repeat.readyMs} ms, budget 2000 ms`);
    console.log('Load budget checks passed');
  }
} finally {
  await browser.close(); await service.close();
}
