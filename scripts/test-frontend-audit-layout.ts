#!/usr/bin/env bun
// Browser regressions for the audited layouts, using built assets and a read-only recorded run.
import { revealRouteControls } from './web-ui-controls';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import { loadWebSample } from '../apps/web/sample';
import { createWebService } from '../apps/web/server';
import type { ArchiveCatalog } from '../docs/web/types';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const siteRoot = path.join(root, 'out/site'), webRoot = path.join(root, 'out/web');
const output = path.join(root, 'out/frontend-audit-layout');
await Promise.all(['index.html', 'landing.js'].map(file => fs.access(path.join(siteRoot, file))));
const catalog = JSON.parse(await fs.readFile(path.join(webRoot, 'classics/data/catalog.json'), 'utf8')) as ArchiveCatalog;
const classic = catalog.records.find(record => record.id === 'openai_totient_companion_zero');
assert.ok(classic, 'Build the classic library before running the layout regressions.');
const sample = loadWebSample();
assert.ok(sample, 'The workbench recording is required; this suite never creates a run.');
await fs.mkdir(output, { recursive: true });

const mime: Record<string, string> = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const site = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://fixture').pathname);
    const file = path.resolve(siteRoot, `.${pathname}${pathname.endsWith('/') ? 'index.html' : ''}`);
    if (!file.startsWith(siteRoot + path.sep)) { response.writeHead(404); response.end(); return; }
    const body = await fs.readFile(file);
    response.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream' }); response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let runnerCalls = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Recorded layout fixture; no model or Lean' }; },
  async run() { runnerCalls++; throw new Error('Browsing the layout must not start a worker.'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: webRoot, THEOREMOS_WEB_AUTH: 'none' }), runner, { sample });
const checks: object[] = [], writes: string[] = [], errors: string[] = [];
const githubClicks: string[] = [];
let browser: Browser | undefined, current = 'Start local services', failure: string | undefined;

async function scenario(name: string, viewport: { width: number; height: number }, allowedOrigin: string,
  run: (page: Page, context: BrowserContext) => Promise<object>) {
  current = name;
  const context = await browser!.newContext({ viewport, locale: 'zh-CN', reducedMotion: 'reduce' });
  await context.route(/^https?:\/\//u, route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== allowedOrigin) {
      // Preserve the real target=_blank click while replacing its external navigation locally.
      if (request.isNavigationRequest() && url.href === 'https://github.com/HuggingMath/TheoremOS') {
        githubClicks.push(url.href);
        return route.fulfill({ contentType: 'text/html', body: '<p id="audit-external-target">GitHub click intercepted locally</p>' });
      }
      return route.abort();
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(`${request.method()} ${url.pathname}`); return route.abort();
    }
    return route.continue();
  });
  context.on('page', page => {
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  });
  const page = await context.newPage();
  try {
    const details = await run(page, context);
    checks.push({ name, viewport, ...details }); console.log(`PASS ${name}`);
  } catch (error) {
    failure = `failure-${checks.length + 1}.png`;
    await page.screenshot({ path: path.join(output, failure) }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}

// Include every clipping ancestor: a positive DOM height alone missed the original hidden detail pane.
async function visibleBox(locator: Locator) {
  return locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/u.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (/(auto|scroll|hidden|clip)/u.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      // The expanded fixed dialog escapes the workbench's ordinary detail-panel scroller.
      if (style.position === 'fixed') break;
    }
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top),
      endVisible: bottom >= rect.bottom - 2 && bottom > top, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
  });
}

async function readExpandedDetails(page: Page, map: Locator) {
  const inspector = map.locator('[data-solution-inspector]');
  assert.ok((await inspector.innerText()).trim().length > 0, 'The selected step must contain real recorded detail.');
  let before = await visibleBox(inspector);
  // The workspace scrollbar also permits reading below a short map; wheel its edge, inside the scroll owner.
  for (let attempt = 0; before.height < 48 && attempt < 8; attempt++) {
    const bounds = await visibleBox(map.locator('.solution-route-workspace'));
    await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 180); await settled(page); before = await visibleBox(inspector);
  }
  assert.ok(before.height >= 48 && before.width >= 120, `Expanded step details must be readable: ${JSON.stringify(before)}`);
  const tail = inspector.locator('button, p, pre, time, [data-solution-prose]').last();
  assert.equal(await tail.count(), 1, 'The recorded detail must expose a readable ending.');
  const initialEnd = await visibleBox(tail);
  const scrollState = () => map.evaluate(element => [...element.querySelectorAll<HTMLElement>('.solution-route-workspace, [data-solution-inspector], pre'), element]
    .map(node => node.scrollTop));
  const initialScroll = await scrollState();
  let end = initialEnd, gestures = 0;
  while (!end.endVisible && gestures < 30) {
    const area = await visibleBox(inspector);
    assert.ok(area.height >= 24, 'The details must remain available while reading.');
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
    await page.mouse.wheel(0, 420); await settled(page);
    end = await visibleBox(tail); gestures++;
  }
  assert.ok(end.endVisible, `The end of the selected step must be reachable by scrolling: ${JSON.stringify(end)}`);
  const finalScroll = await scrollState();
  if (!initialEnd.endVisible) assert.notDeepEqual(finalScroll, initialScroll, 'A real scroll container must move to reveal the detail ending.');
  return { visibleDetails: before, ending: end, wheelGestures: gestures, initialScroll, finalScroll };
}

try {
  await new Promise<void>((resolve, reject) => { site.once('error', reject); site.listen(0, '127.0.0.1', resolve); });
  const landingOrigin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  browser = await startBrowser(service.server, port);
  for (const locale of ['zh', 'en'] as const) {
    const landingUrl = `${landingOrigin}/${locale === 'en' ? 'en/' : ''}`;
    await scenario(`L01 ${locale}: low-height navigation reaches GitHub`, { width: 812, height: 375 }, landingOrigin, async (page, context) => {
      await page.goto(landingUrl); await page.locator('.menu-toggle').click();
      const menu = page.locator('#mobile-nav'), last = menu.locator('a').last();
      await menu.hover({ position: { x: 20, y: 130 } }); await page.mouse.wheel(0, 700); await settled(page);
      await last.scrollIntoViewIfNeeded();
      const visible = await visibleBox(last);
      assert.ok(visible.height >= 44, `The last navigation link must fit in the viewport: ${JSON.stringify(visible)}`);
      await page.screenshot({ path: path.join(output, `menu-${locale}-812x375.png`) });
      const opened = context.waitForEvent('page');
      await last.click(); const popup = await opened;
      await popup.locator('#audit-external-target').waitFor(); await popup.close();
      assert.equal(githubClicks.length, locale === 'zh' ? 1 : 2, 'The real link click must reach the locally intercepted navigation.');
      return { visible };
    });
    for (const viewport of [{ width: 812, height: 375 }, { width: 390, height: 480 }, { width: 390, height: 844 }]) {
      await scenario(`L02 ${locale}: keyboard graph ${viewport.width}x${viewport.height}`, viewport, landingOrigin, async page => {
        await page.goto(landingUrl);
        const m5 = page.locator('[data-graph-component="m5"]');
        await m5.scrollIntoViewIfNeeded(); await m5.focus(); await settled(page);
        await page.keyboard.press('End');
        await page.waitForFunction(() => {
          const focus = document.activeElement as HTMLElement | null;
          if (focus?.dataset.graphComponent !== 'm2') return false;
          const rect = focus.getBoundingClientRect(), header = document.querySelector('.site-header')!.getBoundingClientRect();
          return rect.top >= Math.max(0, header.bottom) - 1 && rect.bottom <= innerHeight + 1;
        });
        const m2 = page.locator('[data-graph-component="m2"]');
        assert.equal(await m2.getAttribute('aria-pressed'), 'true');
        assert.match(await page.locator('#module-graph-route').innerText(), /^M2/u);
        const visible = await visibleBox(m2);
        await page.screenshot({ path: path.join(output, `graph-${locale}-${viewport.width}x${viewport.height}.png`) });
        return { visible };
      });
    }
  }

  for (const surface of ['classics', 'workbench'] as const) {
    for (const viewport of [{ width: 812, height: 375 }, { width: 390, height: 480 },
      { width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      await scenario(`R01 ${surface}: expanded map and detail ${viewport.width}x${viewport.height}`, viewport, origin, async page => {
        if (surface === 'classics') {
          await page.goto(`${origin}/classics/archive.html#${new URLSearchParams({ proof: classic.id, tab: 'process', status: 'verified' })}`);
          await page.locator('[data-solution-route-state="ready"]').waitFor();
          const recorded = page.locator('[data-solution-mode="recorded"]');
          if (await recorded.count() && await recorded.getAttribute('aria-pressed') !== 'true') await recorded.click();
        } else {
          await page.goto(`${origin}/?sample`);
          await page.locator('[data-research-artifact="roadmap"]').click();
        }
        const map = page.locator('.solution-route');
        const task = map.locator(surface === 'workbench' ? '[data-solution-node="task:goal_2"]' : '[data-solution-node^="task:"]').first();
        await task.click();
        const selected = await task.getAttribute('data-solution-node');
        await revealRouteControls(map);
        await map.locator('[data-solution-expand]').click();
        await map.locator('[data-solution-expand][aria-expanded="true"]').waitFor(); await settled(page);
        assert.equal(await map.getAttribute('role'), 'dialog');
        const bounds = (await map.boundingBox())!;
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1
          && bounds.y + bounds.height <= viewport.height + 1, 'The expanded route must remain inside the viewport.');
        const graph = await visibleBox(map.locator('.solution-route-viewport'));
        assert.ok(graph.height >= 48 && graph.width >= 120, `The expanded map must retain a usable visible area: ${JSON.stringify(graph)}`);
        const mapDetails = await readExpandedDetails(page, map);
        await page.screenshot({ path: path.join(output, `${surface}-expanded-${viewport.width}x${viewport.height}.png`) });
        await map.locator('.solution-route-tools [data-solution-view="read"]').click();
        assert.equal(await map.getAttribute('data-solution-reading'), 'true');
        assert.equal(await map.locator('[data-solution-reader-select]').inputValue(), selected);
        const readingDetails = await readExpandedDetails(page, map);
        await page.screenshot({ path: path.join(output, `${surface}-reading-${viewport.width}x${viewport.height}.png`) });
        await page.keyboard.press('Escape');
        await map.locator('[data-solution-expand][aria-expanded="false"]').waitFor();
        assert.equal(await map.locator('[data-solution-expand]').evaluate(button => document.activeElement === button), true);
        return { selected, graph, mapDetails, readingDetails };
      });
    }
  }
  assert.deepEqual(writes, [], 'Layout browsing must not send business writes.');
  assert.deepEqual(errors, [], 'The layout scenarios must have no uncaught browser errors.');
  assert.equal(runnerCalls, 0, 'No model, Lean or solver runner may execute.');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, githubClicks,
    writes, errors, runnerCalls, paidModelCalls: false }, null, 2) + '\n');
} catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', current, checks, failure,
    error: error instanceof Error ? error.message : String(error), githubClicks, writes, errors, runnerCalls }, null, 2) + '\n');
  throw error;
} finally {
  await browser?.close();
  await service.close();
  await new Promise<void>(resolve => site.close(() => resolve()));
}
