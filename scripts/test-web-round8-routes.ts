#!/usr/bin/env bun
// Fixed archive UI recordings only: never invoke a model, Lean or a production service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { loadWebSample } from '../apps/web/sample';
import type { ArchiveProcess } from '../docs/web/types';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_ROUND8_ROUTES_OUTPUT ?? path.join(root, 'out/frontend-round8/routes');
await fs.mkdir(output, { recursive: true });
const proof = 'openai_snaky_certificate';
const assignment = `(window.theoremosProcesses??={})[${JSON.stringify(proof)}]=`;
const asset = await fs.readFile(path.join(root, 'out/web/classics/data/process', `${proof}.js`), 'utf8');
assert.ok(asset.startsWith(assignment) && asset.endsWith(';\n'));
const saved = JSON.parse(asset.slice(assignment.length, -2)) as ArchiveProcess;
const savedRun = saved.runs[0]!;
const known = new Set(savedRun.tasks.map(task => task.id));
const deliveries = savedRun.deliveries!;
const deliveryCases = [
  { name: 'unassigned-progress', delivery: deliveries.find(item => !item.taskId && item.kind !== 'review')!, node: 'problem' },
  { name: 'removed-task-research', delivery: deliveries.find(item => item.taskId && !known.has(item.taskId) && item.kind === 'research')!, node: 'problem' },
  { name: 'current-task-delivery', delivery: deliveries.find(item => item.taskId && known.has(item.taskId) && item.kind !== 'review')!, node: '' },
  { name: 'saved-review', delivery: deliveries.find(item => item.kind === 'review')!, node: 'review' },
];
for (const item of deliveryCases) {
  assert.ok(item.delivery, `Missing fixed archive material for ${item.name}`);
  if (!item.node) item.node = `task:${item.delivery.taskId}`;
}
const originalCheck = savedRun.checks!.find(check => check.scope === 'original' && check.sourceDigest)!;
assert.ok(originalCheck);
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round8-routes-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let runnerCalls = 0;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_AUTH: 'none' }), {
  async readiness() { return { ready: true, message: 'Fixed archived record navigation fixture' }; },
  async run() { runnerCalls++; throw new Error('Record browsing must not start a runner.'); },
}, { sample: loadWebSample() });
const checks: object[] = [], errors: string[] = [], writes: string[] = [], external: string[] = [];
let browser: Browser | undefined, current = '';
const address = (locale: 'zh' | 'en', fields: Record<string, string> = {}) => `${origin}/classics/${locale === 'en' ? 'en/' : ''}archive.html#${new URLSearchParams({
  proof, tab: 'process', mode: 'global', run: savedRun.runId, ...fields })}`;
async function expectRecord(page: Page, step: string, node?: string) {
  const map = await page.locator('.archive-process').getAttribute('data-process-layout') === 'roadmap';
  const selector = map ? '.process-map-task-records' : '#process-step-list';
  assert.equal(await page.locator(`${selector} [data-process-step][aria-pressed="true"]`).getAttribute('data-process-step'), step);
  assert.equal(await page.locator('#process-step-detail').count(), 1);
  if (map && node) assert.equal(await page.locator('.process-map-node[aria-pressed="true"]').getAttribute('data-process-node'), node);
  assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('step'), step);
}
async function roundTrip(page: Page, step: string, node: string) {
  await expectRecord(page, step, node);
  await page.locator('[data-process-view="steps"]').click(); await expectRecord(page, step);
  await page.locator('[data-process-view="roadmap"]').click(); await expectRecord(page, step, node);
  await page.reload(); await page.locator('#process-step-detail').waitFor(); await expectRecord(page, step, node);
}
async function scenario(name: string, locale: 'zh' | 'en', viewport: { width: number; height: number },
  run: (page: Page) => Promise<object>, processFixture?: ArchiveProcess) {
  current = name;
  const context = await browser!.newContext({ locale: locale === 'en' ? 'en-US' : 'zh-CN', viewport, reducedMotion: 'reduce', hasTouch: viewport.width < 900 });
  await context.route(/^https?:\/\//u, route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(`${name}: ${url.href}`); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) { writes.push(`${name}: ${request.method()} ${url.pathname}`); return route.abort(); }
    if (processFixture && url.pathname === `/classics/data/process/${proof}.js`) return route.fulfill({ contentType: 'text/javascript', body: `${assignment}${JSON.stringify(processFixture)};\n` });
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  try { checks.push({ name, locale, viewport, ...await run(page) }); console.log(`PASS ${name}`); }
  catch (error) { await page.screenshot({ path: path.join(output, `failure-${name}.png`) }).catch(() => {}); throw error; }
  finally { await context.close(); }
}

try {
  browser = await startBrowser(service.server, port);
  for (const locale of ['zh', 'en'] as const) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await scenario(`saved-records-${locale}-${viewport.width}`, locale, viewport, async page => {
      await page.goto(address(locale)); await page.locator('.global-workflow').waitFor();
      const records = [];
      for (const item of deliveryCases) {
        const step = `delivery:${item.delivery.id}`;
        const link = page.locator(`[data-workflow-entry="${step}"] [data-global-run]`);
        assert.equal(await link.getAttribute('data-global-node'), item.node);
        await link.click(); await roundTrip(page, step, item.node);
        const detail = await page.locator('#process-step-detail').innerText();
        assert.ok((await page.locator('#process-step-detail .process-message').innerText()).trim().length > 20);
        if (item.delivery.taskId && !known.has(item.delivery.taskId)) assert.ok((await page.locator('#process-step-detail').textContent())!.includes(item.delivery.taskId));
        await page.screenshot({ path: path.join(output, `${item.name}-${locale}-${viewport.width}.png`) });
        records.push({ name: item.name, step, node: item.node, detailCharacters: detail.length, modesAndReload: true });
        await page.locator('[data-process-view="global"]').click(); await page.locator('.global-workflow').waitFor();
      }
      const step = `check:${originalCheck.id}`;
      await page.locator(`[data-workflow-entry="${step}"] [data-global-run]`).click();
      await roundTrip(page, step, 'original');
      await page.locator('[data-process-code="source"]').click();
      assert.equal(await page.locator('.process-check-source code').textContent(), saved.sources![originalCheck.sourceDigest!]!.code);
      assert.ok((await page.locator('.process-code-digest').innerText()).includes(originalCheck.sourceDigest!));
      await page.locator('[data-process-node="acceptance"]').click();
      assert.equal(await page.locator('[data-process-acceptance]').count(), 1);
      assert.equal(await page.locator('.process-map-node[aria-pressed="true"]').getAttribute('data-process-node'), 'acceptance');
      return { records, originalCheck: { step, digest: originalCheck.sourceDigest, modesAndReload: true }, acceptancePreserved: true };
    });
  }
  // Same public page, with small fixed records served only to the local browser. Covers absent local task IDs and old review URLs.
  const fixture = structuredClone(saved), run = fixture.runs[0]!;
  const fixtureChecks = [
    { ...originalCheck, id: 'fixture-unassigned-local-check', scope: 'task' as const, taskId: undefined, status: 'failed', diagnostics: 'fixture-unassigned-check-body' },
    { ...originalCheck, id: 'fixture-historical-local-check', scope: 'task' as const, taskId: 'fixture-retired-task', status: 'failed', diagnostics: 'fixture-historical-check-body' },
  ];
  run.checks!.push(...fixtureChecks);
  const fixtureReview = { ...deliveries.find(delivery => delivery.kind === 'review')!, id: 'fixture-historical-review', taskId: 'fixture-retired-task', summary: 'fixture-historical-review-body' };
  run.deliveries!.push(fixtureReview);
  for (const [locale, viewport] of [['zh', { width: 390, height: 844 }], ['en', { width: 1440, height: 900 }]] as const) {
    await scenario(`generic-records-${locale}-${viewport.width}`, locale, viewport, async page => {
      await page.goto(address(locale)); await page.locator('.global-workflow').waitFor();
      for (const check of fixtureChecks) {
        const step = `check:${check.id}`;
        const link = page.locator(`[data-workflow-entry="${step}"] [data-global-run]`);
        assert.equal(await link.getAttribute('data-global-node'), 'problem');
        await link.click(); await roundTrip(page, step, 'problem');
        assert.equal(await page.locator('.process-diagnostics pre').innerText(), check.diagnostics);
        await page.locator('[data-process-code="source"]').click();
        assert.equal(await page.locator('.process-check-source code').textContent(), saved.sources![check.sourceDigest!]!.code);
        await page.locator('[data-process-view="global"]').click();
      }
      const step = `delivery:${fixtureReview.id}`;
      const link = page.locator(`[data-workflow-entry="${step}"] [data-global-run]`);
      assert.equal(await link.getAttribute('data-global-node'), 'review'); await link.click();
      await roundTrip(page, step, 'review');
      assert.equal(await page.locator('#process-step-detail .process-message').innerText(), fixtureReview.summary);
      await page.goto(address(locale, { mode: 'roadmap', step, node: 'task:fixture-retired-task' }));
      await page.locator('#process-step-detail').waitFor(); await expectRecord(page, step, 'review');
      await page.goto(address(locale, { mode: 'roadmap', step }));
      await page.locator('#process-step-detail').waitFor(); await expectRecord(page, step, 'review');
      await page.screenshot({ path: path.join(output, `generic-review-${locale}-${viewport.width}.png`) });
      return { localChecks: fixtureChecks.map(check => check.id), unassignedSourcePreserved: true, historicalReview: fixtureReview.id,
        modesAndReload: true, staleNodeUrlRestored: true, stepOnlyUrlRestored: true };
    }, fixture);
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(external, []); assert.equal(runnerCalls, 0);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, errors, writes, external, runnerCalls }, null, 2) + '\n');
} catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', current, checks, errors, writes, external, runnerCalls,
    error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n'); throw error;
} finally { await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
