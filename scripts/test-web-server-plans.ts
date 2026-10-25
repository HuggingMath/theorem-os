#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebSavedModulePlan } from '../apps/web/moduleRegistry';
import { openSettings } from './web-ui-controls';
import { deferred, freePort, settled, startBrowser, webScenario, writeScenarioReport, type ScenarioHarness, type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-server-plans');
await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local saved plan fixture' }; },
  async run() { throw new Error('Plan library operations must not start a worker'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const select = '[data-server-plan-select]', remove = '[data-server-plan-delete]', confirm = '[data-server-plan-delete-confirm]';
const notice = '[data-server-plan-notice]';
const defaultPlan = { scheduler: 'plan', context: 'full', custom: [] };

async function request<T>(page: Page, url = '/api/module-plans', method = 'GET', body?: unknown) {
  return page.evaluate(async ({ url, method, body }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, payload: await response.json() };
  }, { url, method, body }) as Promise<{ status: number; payload: T }>;
}
async function savedPlans(page: Page) { return (await request<{ plans: WebSavedModulePlan[] }>(page)).payload.plans; }
async function save(page: Page, name = '可复用证明方案') {
  await page.locator('[data-server-plan-name]').fill(name);
  await page.locator('[data-server-plan-save]').click();
  await page.locator(notice).getByText(/已保存/).waitFor();
}
async function draft(page: Page) {
  return page.evaluate(() => ({ source: (document.querySelector('#source') as HTMLTextAreaElement).value,
    task: (document.querySelector('#task') as HTMLTextAreaElement).value,
    catalog: (document.querySelector('#knowledge-catalog') as HTMLSelectElement).value,
    stored: sessionStorage.getItem('theorem-os.web-draft.v1') }));
}
async function editDraft(page: Page) {
  await page.locator('#module-plan-scheduler').selectOption('critical-path');
  await page.locator('#module-plan-context').selectOption('essential');
  await page.waitForFunction(() => {
    const plan = JSON.parse(sessionStorage.getItem('theorem-os.web-draft.v1') || 'null')?.draft?.modulePlan;
    return plan?.scheduler === 'critical-path' && plan?.context === 'essential';
  });
  await settled(page);
  return draft(page);
}
async function deletion(page: Page) { await page.locator(remove).click(); await page.locator('[data-server-plan-deletion]').waitFor(); }
const scenario = (name: string, run: (h: ScenarioHarness) => Promise<void>, width = 1440) => webScenario(browser, suite, name, run, {
  context: { viewport: { width, height: width > 850 ? 1000 : 812 }, reducedMotion: 'reduce' },
  harness: (page, context) => ({ page, context, requests: [] }), routes: { local: 'Plan operations must stay local' },
  open: async ({ page }) => {
    await page.goto(origin); await page.locator('#submit-run:enabled').waitFor(); await openSettings(page);
    await page.locator('[data-server-module-library] > summary').click();
    await page.locator('[data-server-plan-refresh]:enabled').waitFor();
  },
  timeout: { label: 'Server module plans', seconds: 40 },
  verify: (h, elapsedMs) => {
    assert.equal(h.requests.some(record => record.pathname === '/api/runs' && record.method !== 'GET'), false);
    assert.ok(h.requests.filter(record => record.method !== 'GET').every(record => record.pathname.startsWith('/api/module-plans')));
    return { name, elapsedMs: elapsedMs(), requests: h.requests };
  },
});

try {
  await scenario('save, cancel deletion and preserve the edited draft', async ({ page, requests }) => {
    assert.equal(await page.locator(remove).isDisabled(), true);
    await save(page);
    const selected = await page.locator(select).inputValue(), before = await editDraft(page);
    await deletion(page);
    await page.locator('[data-server-plan-delete-cancel]').click();
    assert.equal(requests.filter(item => item.method === 'DELETE').length, 0);
    assert.equal(await page.locator(select).inputValue(), selected);
    await deletion(page); await page.locator(confirm).click();
    await page.locator(notice).getByText(/已删除/).waitFor();
    assert.deepEqual(await draft(page), before);
    assert.deepEqual(await savedPlans(page), []);
    assert.equal(await page.locator(select).inputValue(), '');
    assert.equal(await page.locator(remove).isDisabled(), true);
  });

  await scenario('concurrent update requires a new deletion confirmation', async ({ page, requests }) => {
    await save(page);
    const [previous] = await savedPlans(page), before = await editDraft(page);
    const changed = await request<{ plan: WebSavedModulePlan }>(page, '/api/module-plans', 'POST', {
      id: previous!.id, baseUpdatedAt: previous!.updatedAt, name: '另一页面更新的方案', plan: { ...defaultPlan, context: 'essential' },
    });
    assert.equal(changed.status, 200);
    await deletion(page); await page.locator(confirm).click();
    await page.locator(notice).getByText(/方案仍在服务器/).waitFor();
    assert.equal((await savedPlans(page))[0]!.updatedAt, changed.payload.plan.updatedAt);
    assert.equal(await page.locator('[data-server-plan-deletion]').isHidden(), true);
    assert.deepEqual(await draft(page), before);
    assert.equal(requests.filter(item => item.method === 'DELETE').length, 1);
    await deletion(page); await page.locator('[data-server-plan-delete-description]').getByText(/另一页面更新的方案/).waitFor();
    await page.locator(confirm).click(); await page.locator(notice).getByText(/已删除/).waitFor();
    assert.deepEqual(await savedPlans(page), []); assert.deepEqual(await draft(page), before);
  });

  await scenario('lost deletion response is read back without another write', async h => {
    const { page, requests } = h;
    await save(page); const before = await editDraft(page);
    const received = deferred(), release = deferred();
    h.intercept = async (route: Route) => {
      if (route.request().method() !== 'DELETE') return false;
      const response = await route.fetch(); assert.equal(response.status(), 200);
      received.resolve(); await release.promise; await route.abort(); return true;
    };
    try {
      await deletion(page); await page.locator(confirm).click(); await received.promise;
      for (const selector of [select, remove, confirm, '[data-server-plan-save]', '[data-server-plan-refresh]'])
        assert.equal(await page.locator(selector).isDisabled(), true, selector);
      await page.locator(confirm).evaluate(button => (button as HTMLButtonElement).click());
    } finally { release.resolve(); }
    await page.locator(notice).getByText(/已删除/).waitFor();
    assert.equal(requests.filter(item => item.method === 'DELETE').length, 1);
    assert.deepEqual(await savedPlans(page), []); assert.deepEqual(await draft(page), before);
  });

  await scenario('failed deletion and unavailable readback preserve the draft', async h => {
    const { page, requests } = h;
    await save(page); const before = await editDraft(page);
    h.intercept = async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (request.method() === 'DELETE' || pathname === '/api/module-plans' && request.method() === 'GET') {
        await route.abort(); return true;
      }
      return false;
    };
    await deletion(page); await page.locator(confirm).click();
    await page.locator(notice).getByText(/暂时无法确认删除结果/).waitFor();
    assert.equal(requests.filter(item => item.method === 'DELETE').length, 1);
    assert.deepEqual(await draft(page), before);
    h.intercept = undefined;
    await page.locator('[data-server-plan-refresh]').click(); await page.locator('[data-server-plan-refresh]:enabled').waitFor();
    assert.equal((await savedPlans(page)).length, 1);
    assert.deepEqual(await draft(page), before);
  });

  await scenario('delete a saved plan to free the twelve-plan capacity', async ({ page }) => {
    for (let index = 0; index < 12; index++) {
      const response = await request(page, '/api/module-plans', 'POST', { name: `方案 ${index}`, plan: defaultPlan });
      assert.equal(response.status, 200);
    }
    await page.locator('[data-server-plan-refresh]').click(); await page.locator(`${select} option`).nth(12).waitFor({ state: 'attached' });
    await page.locator('[data-server-plan-name]').fill('第十三个方案'); await page.locator('[data-server-plan-save]').click();
    await page.locator(notice).getByText(/12 项上限/).waitFor();
    await page.locator(select).selectOption({ label: '方案 0' }); const before = await editDraft(page);
    await deletion(page); await page.locator(confirm).click(); await page.locator(notice).getByText(/已删除/).waitFor();
    await save(page, '第十三个方案');
    assert.equal((await savedPlans(page)).length, 12); assert.deepEqual(await draft(page), before);
  });

  for (const width of [375, 320]) await scenario(`saved plan deletion fits ${width}px`, async ({ page }) => {
    await save(page, '<img data-plan-injection src=x>'); await editDraft(page); await deletion(page);
    assert.equal(await page.locator('[data-plan-injection]').count(), 0);
    await page.locator('[data-server-plan-deletion]').scrollIntoViewIfNeeded();
    for (const selector of ['.server-module-plans', '.server-plan-actions', '[data-server-plan-deletion]']) {
      const bounds = await page.locator(selector).evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, width: node.clientWidth, scroll: node.scrollWidth };
      }));
      assert.ok(bounds.every(box => box.left >= 0 && box.right <= width + 1 && box.scroll <= box.width + 1), selector);
    }
    await page.screenshot({ path: path.join(output, `delete-${width}.png`) });
    await page.locator(confirm).click(); await page.locator(notice).getByText(/已删除/).waitFor();
  }, width);
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined, 'local-real-http-server-plans', { checks: suite.checks });
  console.log(`Server plan checks passed: ${suite.checks.length} scenarios`);
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-server-plans', { checks: suite.checks }); throw error;
} finally { await browser.close(); await service.close(); }
