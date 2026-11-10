#!/usr/bin/env bun
// Fixed run recording only: opening evidence must not start a model or Lean process.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { loadWebSample } from '../apps/web/sample';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, startBrowser, settled } from './web-scenario';
import { openTab } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_ROUND6_ROUTES_OUTPUT ?? path.join(root, 'out/frontend-round6/routes');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round6-routes-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let runnerCalls = 0;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_AUTH: 'none' }), {
  async readiness() { return { ready: true, message: 'Fixed route recording fixture' }; },
  async run() { runnerCalls++; throw new Error('Evidence browsing must not start a runner.'); },
}, { sample: loadWebSample() });
const checks: object[] = [], errors: string[] = [], writes: string[] = [], external: string[] = [];
let browser: Browser | undefined, current = '';
try {
  browser = await startBrowser(service.server, port);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
    for (const expandedResults of viewport.width >= 940 ? [false, true] : [false]) {
      current = `${viewport.width}-${expandedResults ? 'expanded-results' : 'split'}`;
      const context = await browser.newContext({ locale: 'zh-CN', viewport, reducedMotion: 'reduce' });
      await context.addInitScript(key => { try { localStorage.setItem(key, 'zh'); } catch { /* Blank frame. */ } }, localeStorageKey);
      await context.route(/^https?:\/\//u, route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { external.push(url.href); return route.abort(); }
        if (!['GET', 'HEAD'].includes(request.method())) { writes.push(`${request.method()} ${url.pathname}`); return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      page.on('pageerror', error => errors.push(`${current}: ${error.message}`));
      try {
        await page.goto(`${origin}/?sample`); await openTab(page, 'trajectory');
        if (expandedResults) await page.locator('#expand-research-output').click();
        const map = page.locator('.solution-route'); await map.waitFor();
        await map.locator('[data-solution-all]').click();
        await map.locator('[data-solution-node^="record:attempt:"]').first().click();
        const selected = await map.locator('[data-solution-heading]').getAttribute('data-solution-heading');
        const overflow = await page.evaluate(() => document.body.style.overflow);
        await map.locator('[data-solution-expand]').click();
        assert.equal(await map.getAttribute('data-solution-expanded'), 'true');
        await map.locator('[data-solution-open]').click();
        const viewer = page.locator('#trajectory-viewer[open]'); await viewer.waitFor();
        await viewer.getByText('theorem add_zero', { exact: false }).first().waitFor(); await settled(page);
        assert.equal(await map.getAttribute('data-solution-expanded'), 'false', 'Evidence must leave the canvas overlay.');
        assert.equal(await map.locator('[data-solution-heading]').getAttribute('data-solution-heading'), selected);
        assert.equal(await page.evaluate(() => document.body.style.overflow), overflow, 'Restore the page scroll state.');
        const visible = await viewer.evaluate(dialog => {
          const close = dialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!;
          const c = close.getBoundingClientRect(), body = dialog.querySelector('.side-viewer-body')!.getBoundingClientRect();
          return { modal: dialog.matches(':modal'), hostWidth: dialog.closest<HTMLElement>('[data-viewer-host]')!.clientWidth,
            closeReachable: c.top >= 0 && c.bottom <= innerHeight && c.left >= 0 && c.right <= innerWidth
              && dialog.contains(document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)),
            readableHeight: Math.max(0, Math.min(body.bottom, innerHeight) - Math.max(body.top, 0)),
            source: dialog.querySelector('.side-viewer-body')!.textContent };
        });
        assert.ok(visible.closeReachable, `Close is on screen and receives pointer input: ${JSON.stringify(visible)}`);
        assert.ok(visible.readableHeight > 80, 'The code reader is immediately on screen.');
        assert.match(visible.source!, /theorem add_zero.*by rfl/u);
        assert.equal(visible.modal, visible.hostWidth < 940, 'Keep the normal split/modal reader behavior.');
        await page.screenshot({ path: path.join(output, `${current}.png`) });
        await viewer.getByRole('button', { name: '关闭', exact: true }).click();
        await viewer.waitFor({ state: 'detached' });
        assert.equal(await map.locator('[data-solution-open]').evaluate(button => button === document.activeElement), true,
          'Closing restores keyboard focus to the route evidence action.');
        await page.keyboard.press('Enter'); await page.locator('#trajectory-viewer[open]').waitFor();
        await page.keyboard.press('Escape'); await page.locator('#trajectory-viewer').waitFor({ state: 'detached' });
        checks.push({ name: current, viewport, expandedResults, selected, ...visible, source: undefined });
        console.log(`PASS ${current}: evidence visible, close/keyboard usable, route selection preserved`);
      } catch (error) {
        await page.screenshot({ path: path.join(output, `failure-${current}.png`) }).catch(() => {}); throw error;
      } finally { await context.close(); }
    }
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(external, []); assert.equal(runnerCalls, 0);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, errors, writes, external, runnerCalls }, null, 2) + '\n');
} catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', current, checks, errors, writes, external, runnerCalls,
    error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n'); throw error;
} finally { await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
