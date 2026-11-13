#!/usr/bin/env bun
import { openAdvancedChatSettings, clickWorkbenchAction } from './web-ui-controls';
// Actual loopback HTTP and Chromium; the formalizer only waits for cancellation. No model or Lean calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { localeStorageKey } from '../apps/web/i18n';
import type { WebRunner } from '../apps/web/runner';
import { createWebService } from '../apps/web/server';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/web-chat-cancel-recovery');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-chat-cancel-'));
const controls = new Map<string, AbortSignal>();
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable cancellation fixture' }; },
  async run() { throw new Error('Cancellation must not launch proof research'); },
  async formalize(input, _send, signal) {
    controls.set(input.id, signal);
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner, { sample: null });
const browser = await startBrowser(service.server, port);
const checks: string[] = [], errors: string[] = [];
let activePage: Page | undefined;
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    await context.route(/^https?:\/\//, async route => {
      assert.equal(new URL(route.request().url()).origin, origin, 'The fixture cannot contact an external service');
      await route.continue();
    });
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0);
    page.on('pageerror', error => errors.push(error.message));
    const writes: string[] = [];
    page.on('request', request => { if (request.method() !== 'GET') writes.push(new URL(request.url()).pathname); });
    await page.goto(origin); await page.locator('#formalize-original').fill('Local cancellation fixture: every natural number equals itself.');
    await clickWorkbenchAction(page, '#open-settings');
    await page.locator('#formalize-key').fill('sk-local-cancellation-fixture');
    await openAdvancedChatSettings(page);
    await page.locator('#formalize-environment').selectOption('standard');
    const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/formalizations'));
    await page.locator('#formalize-start:enabled').click();
    const { formalization } = await (await created).json();
    await page.locator('[data-research-stop]').waitFor();
    // Delay JSON after the HTTP response arrived, so the old read remains inside loadTask during cancellation.
    await page.evaluate(id => {
      const json = Response.prototype.json;
      Response.prototype.json = async function () {
        const value = await json.call(this), state = window as any;
        if (!state.__cancelReadHeld && this.url.endsWith(`/api/formalizations/${id}`) && this.status === 200
          && ['queued', 'running'].includes(value.formalization?.status)) {
          state.__cancelReadHeld = true;
          await new Promise<void>(resolve => { state.__releaseCancelRead = resolve; });
        }
        return value;
      };
    }, formalization.id);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => Boolean((window as any).__cancelReadHeld));
    const cancelled = page.waitForResponse(response => response.request().method() === 'POST'
      && response.url().endsWith(`/api/formalizations/${formalization.id}/cancel`));
    await page.locator('[data-research-stop]').click();
    assert.equal((await (await cancelled).json()).formalization.status, 'cancelled');
    await page.locator('.research-conversation-state').getByText('已取消', { exact: true }).waitFor();
    assert.equal(controls.get(formalization.id)?.aborted, true, 'Cancellation stops the actual local fixture worker');
    const draft = 'A newer unsent draft after cancellation';
    await page.locator('#formalize-original').fill(draft);
    await page.evaluate(() => (window as any).__releaseCancelRead());
    await settled(page);
    assert.equal(await page.locator('[data-research-stop]').count(), 0, 'A stale GET cannot make a cancelled task look active');
    assert.ok((await page.locator('.research-conversation-state').innerText()).includes('已取消'));
    assert.equal(await page.locator('#formalize-original').inputValue(), draft);
    assert.equal(writes.filter(url => url === '/api/formalizations').length, 1);
    assert.equal(writes.filter(url => url.endsWith('/cancel')).length, 1);
    assert.equal(writes.filter(url => url === '/api/runs').length, 0);
    await page.screenshot({ path: path.join(output, `cancelled-${width}.png`), fullPage: true });
    checks.push(`${width}px: delayed pre-cancellation JSON cannot restore an active task or overwrite a newer draft`);
    console.log(`PASS ${checks.at(-1)}`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, paidModelCalls: false, realLean: false }, null, 2) + '\n');
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', checks, paidModelCalls: false, realLean: false,
    error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n');
  throw error;
} finally {
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
