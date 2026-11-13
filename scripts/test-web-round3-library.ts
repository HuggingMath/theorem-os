#!/usr/bin/env bun
// Configuration response ordering against disposable local Skill releases; no model, Lean or mail.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page, Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { FrozenResearchConfiguration, ResearchAsset, ResearchPublication } from '../apps/web/researchAssetTypes';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'out/frontend-round3/library');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round3-library-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const runtimeCalls: string[] = [], errors: string[] = [], external: string[] = [];
const checks: { name: string; elapsedMs: number }[] = [];
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable Library fixture' }; },
  async run() { runtimeCalls.push('run'); throw new Error('No research may start in this fixture'); },
  async check() { runtimeCalls.push('check'); throw new Error('No Lean in this fixture'); },
  async formalize() { runtimeCalls.push('formalize'); throw new Error('No model in this fixture'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner,
{ sample: null, mailer: async () => { throw new Error('No mail in this fixture'); } });
let browser: Browser | undefined, page: Page | undefined, failure: unknown, currentCheck = 'setup';
async function http<T>(method: string, pathname: string, input?: unknown): Promise<T> {
  return page!.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const payload = await response.json(); if (!response.ok) throw new Error(`Fixture HTTP ${response.status}: ${payload.error}`); return payload;
  }, { method, pathname, input }) as Promise<T>;
}
async function skill(name: string) {
  const { item: asset } = await http<{ item: ResearchAsset }>('POST', '/api/research/library', { requestId: crypto.randomUUID(),
    type: 'skill', name, visibility: 'private', content: { instructions: `Fixture ${name}`, slots: ['M1'] } });
  const { item: publication } = await http<{ item: ResearchPublication }>('POST', `/api/research/library/${asset.id}/publish`, {
    requestId: crypto.randomUUID(), expectedRevision: asset.revision, version: 'v1', license: 'MIT', visibility: 'private' });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { item } = await http<{ item: ResearchPublication }>('GET', `/api/research/publications/${publication.id}`);
    if (item.status === 'completed') break;
    assert.notEqual(item.status, 'failed', item.reason); assert.ok(Date.now() < deadline);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return asset;
}
async function check(name: string, run: () => Promise<void>) {
  currentCheck = name; const started = performance.now(); await run();
  checks.push({ name, elapsedMs: Math.round(performance.now() - started) }); console.log(`PASS ${name}`);
}

try {
  browser = await startBrowser(service.server, port);
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10_000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/library.html`); await page.getByRole('heading', { name: '数学库', exact: true }).waitFor();
  const first = await skill('First reasoning Skill'), second = await skill('Second reasoning Skill');
  await page.goto(`${origin}/library.html?entry=${first.id}&version=v1`);
  await page.getByRole('button', { name: '加入配置选择', exact: true }).click();
  await page.goto(`${origin}/library.html?entry=${second.id}&version=v1`);
  await page.getByRole('button', { name: '加入配置选择', exact: true }).click();
  const selection = page.locator('.research-selection-panel');
  const configurationUrl = `${origin}/api/research/configuration`;
  const checkedText = '组合检查通过，版本与依赖已固定。';
  for (const outcome of ['success', 'error'] as const) {
    await check(`R3-L-${outcome} an old two-Skill response does not label the changed selection`, async () => {
      if (outcome === 'error') await page!.getByRole('button', { name: '加入配置选择', exact: true }).click();
      let held: Route | undefined;
      await page!.route(configurationUrl, async route => { held = route; });
      await selection.getByRole('button', { name: '检查组合', exact: true }).click();
      await assert.doesNotReject(async () => {
        const deadline = Date.now() + 5000;
        while (!held) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
      });
      assert.equal(held!.request().postDataJSON().selection.skills.length, 2);
      await page!.getByRole('button', { name: '已加入配置选择', exact: true }).click();
      assert.equal(await selection.locator('li').count(), 1);
      if (outcome === 'success') await held!.fulfill({ response: await held!.fetch() });
      else await held!.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Old selection conflict fixture' }) });
      await selection.getByRole('button', { name: '检查组合', exact: true }).waitFor();
      await page!.unroute(configurationUrl);
      assert.equal(await selection.getByText(checkedText, { exact: true }).count(), 0, 'Only the current selection may be labelled checked');
      assert.equal(await selection.getByRole('alert').count(), 0, 'An old selection error must not attach to the current selection');
      assert.equal(await selection.getByText('查看固定配置身份', { exact: true }).count(), 0);
      await page!.screenshot({ path: path.join(output, `${outcome}-after-selection-change.png`), fullPage: true });
    });
  }
  await check('R3-L-current checking the current selection shows its own fixed identity', async () => {
    await selection.getByRole('combobox', { name: '目标环境', exact: true }).selectOption('standard');
    const reply = page!.waitForResponse(response => response.url() === configurationUrl && response.request().method() === 'POST');
    await selection.getByRole('button', { name: '检查组合', exact: true }).click();
    const response = await reply; assert.equal(response.status(), 200);
    const { item } = await response.json() as { item: FrozenResearchConfiguration };
    assert.equal(item.skills.length, 1); assert.equal(item.skills[0]!.ref.assetId, first.id); assert.equal(item.environment, 'standard');
    await selection.getByText(checkedText, { exact: true }).waitFor();
    await selection.locator('summary').click(); assert.ok((await selection.innerText()).includes(item.digest));
    await page!.screenshot({ path: path.join(output, 'current-selection-checked.png'), fullPage: true });
    await selection.getByRole('button', { name: '带入工作台', exact: true }).click();
    await page!.waitForURL(url => url.origin === origin && url.pathname === '/');
    await page!.locator('.composer-research-selection strong').waitFor();
    assert.equal(await page!.locator('#environment').inputValue(), 'standard');
    assert.ok((await page!.locator('.composer-research-selection').innerText()).includes(first.name));
    assert.equal((await page!.locator('.composer-research-selection').innerText()).includes(second.name), false);
  });
  assert.deepEqual(runtimeCalls, []); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) {
  failure = error; await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
} finally {
  await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'execution.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks,
    ...(failure ? { failedCheck: currentCheck, error: String(failure) } : {}), pageErrors: errors, externalRequests: external,
    runtimeCalls, modelCalls: 0, leanCalls: 0, realMail: false, productionWrites: false, fixturesRemoved: true }, null, 2) + '\n');
}
