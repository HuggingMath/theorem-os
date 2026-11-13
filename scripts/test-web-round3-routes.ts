#!/usr/bin/env bun
// Uses only fixed archive bytes and the read-only workbench recording.
import assert from 'node:assert/strict';
import { showArtifacts } from './web-ui-controls';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Locator, Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { loadWebSample } from '../apps/web/sample';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/frontend-round3/routes/regressions');
await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let runnerCalls = 0;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_AUTH: 'none' }), {
  async readiness() { return { ready: true, message: 'Read-only route regression fixture' }; },
  async run() { runnerCalls++; throw new Error('Browsing must never start a model or Lean runner.'); },
}, { sample: loadWebSample() });
const checks: object[] = [], errors: string[] = [], writes: string[] = [];
let browser: Browser | undefined, current = '', screenshot: string | undefined;
async function scenario(name: string, locale: 'zh' | 'en', viewport: { width: number; height: number }, run: (page: Page) => Promise<object>) {
  if (process.argv.includes('--details-only') && !name.startsWith('R3-route-02')) return;
  current = name;
  const context = await browser!.newContext({ locale: locale === 'en' ? 'en-US' : 'zh-CN', viewport, reducedMotion: 'reduce', hasTouch: locale === 'en' });
  await context.addInitScript(value => localStorage.setItem('theorem-os.web-locale.v1', value), locale);
  await context.route(/^https?:\/\//u, route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!['GET', 'HEAD'].includes(request.method())) { writes.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  try { checks.push({ ...await run(page), name, locale, viewport }); console.log(`PASS ${name}`); }
  catch (error) {
    screenshot = `failure-${checks.length + 1}.png`;
    await page.screenshot({ path: path.join(output, screenshot) }).catch(() => {}); throw error;
  } finally { await context.close(); }
}
async function openClassic(page: Page, locale: 'zh' | 'en', mode: 'source' | 'recorded') {
  await page.goto(`${origin}/classics/${locale === 'en' ? 'en/' : ''}archive.html#proof=openai_totient_companion_zero&tab=process`);
  await page.locator('[data-solution-route-state="ready"]').waitFor();
  await page.locator(`[data-solution-mode="${mode}"]`).click(); await settled(page);
}
async function selection(map: Locator) {
  return map.evaluate(root => {
    const viewport = root.querySelector<HTMLElement>('.solution-route-viewport')!, selected = root.querySelector<HTMLElement>('[data-solution-node][aria-pressed="true"]');
    const v = viewport.getBoundingClientRect(), s = selected?.getBoundingClientRect();
    return { id: selected?.dataset.solutionNode, visible: Boolean(s && s.left >= v.left - 1 && s.right <= v.right + 1 && s.top >= v.top - 1 && s.bottom <= v.bottom + 1),
      viewport: v.toJSON(), card: s?.toJSON(), left: viewport.scrollLeft, top: viewport.scrollTop };
  });
}
// A paragraph is readable only if it also clears clipping ancestors and the browser viewport.
async function visibleParagraph(map: Locator) {
  return map.locator('[data-solution-inspector]').evaluate(inspector => {
    const candidates = [...inspector.querySelectorAll<HTMLElement>('[data-solution-section-heading]')];
    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      let top = 0, bottom = innerHeight;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden|clip)/u.test(getComputedStyle(parent).overflowY)) {
          const box = parent.getBoundingClientRect(); top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
        }
        if (getComputedStyle(parent).position === 'fixed') break;
      }
      if (rect.top >= top && rect.bottom <= bottom) return { index: element.dataset.solutionSectionHeading!, text: element.textContent, top: rect.top, bottom: rect.bottom };
    }
    return undefined;
  });
}
async function paragraphVisibility(map: Locator, index: string) {
  return map.locator(`[data-solution-section-heading="${index}"]`).evaluate(element => {
    const rect = element.getBoundingClientRect(); let top = 0, bottom = innerHeight;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll|hidden|clip)/u.test(getComputedStyle(parent).overflowY)) {
        const box = parent.getBoundingClientRect(); top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
      }
      if (getComputedStyle(parent).position === 'fixed') break;
    }
    return { visible: rect.top >= top - 2 && rect.bottom <= bottom + 2, text: element.textContent, top: rect.top, bottom: rect.bottom, visibleTop: top, visibleBottom: bottom };
  });
}
async function scrollState(map: Locator) {
  return map.evaluate(root => Object.fromEntries(['.solution-route-workspace', '[data-solution-inspector]'].map(selector => [selector, root.querySelector<HTMLElement>(selector)?.scrollTop ?? 0])));
}

try {
  browser = await startBrowser(service.server, port);
  for (const locale of ['zh', 'en'] as const) {
    await scenario(`R3-route-01 ${locale}: clearing a search keeps the chosen declaration in view`, locale,
      locale === 'en' ? { width: 390, height: 844 } : { width: 1440, height: 900 }, async page => {
        await openClassic(page, locale, 'source'); const map = page.locator('.solution-route');
        const query = locale === 'zh' ? 'TheoremOS.Analysis.asympAveragedModulus_eq_unit' : 'TheoremOS.Analysis.HasDaugavetProperty.unitSlice';
        await map.locator('[data-solution-search]').fill(query);
        await map.locator('[data-solution-node] strong').getByText(query, { exact: true }).click(); await settled(page);
        const before = await selection(map); assert.ok(before.visible);
        await map.locator('[data-solution-search]').fill(''); await settled(page);
        const cleared = await selection(map); assert.equal(cleared.id, before.id); assert.ok(cleared.visible, JSON.stringify(cleared));
        assert.equal(await map.locator('[data-solution-search]').evaluate(input => input === document.activeElement), true, 'Search keeps keyboard focus.');
        await map.locator('[data-solution-expand]').click(); await settled(page);
        const expanded = await selection(map); assert.equal(expanded.id, before.id); assert.ok(expanded.visible, JSON.stringify(expanded));
        await page.screenshot({ path: path.join(output, `clear-search-${locale}.png`) });
        await page.keyboard.press('Escape'); return { before, cleared, expanded };
      });
  }
  for (const surface of ['classics', 'workbench'] as const) for (const locale of ['zh', 'en'] as const) for (const reading of [false, true]) {
    await scenario(`R3-route-02 ${surface} ${locale} ${reading ? 'reading' : 'map'}: close/reopen preserves the paragraph`, locale,
      locale === 'en' ? { width: 390, height: 480 } : { width: 1440, height: 900 }, async page => {
        if (surface === 'classics') await openClassic(page, locale, 'recorded');
        else { await page.goto(`${origin}/?sample`); await page.locator('[data-sample-badge]').waitFor({ state: 'attached' }); await showArtifacts(page); await page.locator('#detail-tab-trajectory').click(); await page.locator('[data-trajectory-view="roadmap"]').click(); }
        const map = page.locator('.solution-route');
        await map.locator(surface === 'workbench' ? '[data-solution-node="task:goal_2"]' : '[data-solution-node^="task:"]').first().click(); await settled(page);
        const selected = await map.locator('[data-solution-heading]').getAttribute('data-solution-heading');
        await map.locator('[data-solution-expand]').click();
        if (reading) await map.locator('.solution-route-tools [data-solution-view="read"]').click();
        const owner = reading || locale === 'en' ? map.locator('.solution-route-workspace') : map.locator('[data-solution-inspector]');
        for (let gesture = 0; gesture < 10; gesture++) {
          const bounds = (await owner.boundingBox())!;
          await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2);
          await page.mouse.wheel(0, 240); await settled(page);
          if (Object.values(await scrollState(map)).some(top => top > 100) && await visibleParagraph(map)) break;
        }
        const before = await scrollState(map), paragraph = await visibleParagraph(map);
        assert.ok(Object.values(before).some(top => top > 100), 'Read a later part of the task first.');
        assert.ok(paragraph, 'Record an actual readable paragraph.');
        await page.keyboard.press('Escape'); await settled(page);
        const closed = await paragraphVisibility(map, paragraph.index);
        assert.equal(closed.text, paragraph.text); assert.ok(closed.visible, `The paragraph must stay visible after closing: ${JSON.stringify(closed)}`);
        assert.equal(await map.locator('[data-solution-expand]').evaluate(button => button === document.activeElement), true);
        // The close control stays focused; Enter reopens it without scrolling the page back to its toolbar.
        await page.keyboard.press('Enter'); await settled(page);
        const reopened = await paragraphVisibility(map, paragraph.index);
        assert.ok(reopened.visible, `The same paragraph must stay visible after reopening: ${JSON.stringify(reopened)}`);
        assert.equal(await map.locator('[data-solution-heading]').getAttribute('data-solution-heading'), selected);
        await page.screenshot({ path: path.join(output, `preserved-${surface}-${locale}-${reading ? 'reading' : 'map'}.png`) });
        await map.locator('[data-solution-step="next"]').click(); await settled(page);
        assert.notEqual(await map.locator('[data-solution-heading]').getAttribute('data-solution-heading'), selected);
        if (reading) {
          assert.equal(await map.locator('.solution-route-workspace').evaluate(element => element.scrollTop), 0, 'A new node starts at its heading.');
        } else assert.equal(await map.locator('[data-solution-inspector]').evaluate(element => element.scrollTop), 0, 'A new node starts at the top of its details.');
        return { selected, before, paragraph, closed, reopened };
      });
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.equal(runnerCalls, 0);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, errors, writes, runnerCalls, paidModelCalls: false }, null, 2) + '\n');
} catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', current, screenshot, checks, errors, writes, runnerCalls,
    error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n'); throw error;
} finally { await browser?.close(); await service.close(); }
