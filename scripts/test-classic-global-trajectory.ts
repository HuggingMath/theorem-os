#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import { createWebService } from '../apps/web/server';
import type { ArchiveCatalog, ArchiveProcess, ArchiveRecord } from '../docs/web/types';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/classic-global-trajectory');
const staticRoot = path.join(root, 'out/web');
const catalog = JSON.parse(await fs.readFile(path.join(staticRoot, 'classics/data/catalog.json'), 'utf8')) as ArchiveCatalog;
assert.equal(catalog.records.length, 16);
assert.ok((await fs.readFile(path.join(staticRoot, 'classics/site.js'), 'utf8')).includes('data-global-run'),
  'Run bun run build:web with the whole-problem trajectory before this check');
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-global-trajectory-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let runnerCalls = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Read-only saved trajectory fixture; no model or Lean' }; },
  async run() { runnerCalls++; throw new Error('Viewing saved global trajectories must not start a worker'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: data, THEOREMOS_WEB_AUTH: 'none' }), runner);
type Run = ArchiveProcess['runs'][number];
const selectedCheck = (run: Run) => run.checks?.find(check => check.status === 'failed')
  ?? run.checks?.filter(check => check.scope === 'original').at(-1) ?? run.checks?.at(-1);
const complex = catalog.records.filter(record => record.process!.runs.length > 1)
  .sort((a, b) => b.process!.runs.length - a.process!.runs.length)[0];
assert.ok(complex, 'The actual archive needs multiple saved research runs');
const failure = catalog.records.flatMap(record => record.process!.runs.map(run => ({ record, run, check: selectedCheck(run) })))
  .filter(({ run, check }) => check?.status === 'failed' && check.diagnostics &&
    (check.scope === 'original' || run.tasks.some(task => task.id === check.taskId)))
  .sort((a, b) => a.check!.diagnostics!.length - b.check!.diagnostics!.length)[0];
assert.ok(failure?.check, 'A global check stage must expose an actual saved failure');
const checks: string[] = [], errors: string[] = [], external: string[] = [], apiReads: string[] = [];
const writes: { method: string; path: string }[] = [], screenshots: string[] = [], cacheAssets: string[] = [];
const viewportEvidence: object[] = [];
let browser: Browser | undefined, active: Page | undefined, current = 'start browser';
const mark = (message: string) => { checks.push(message); console.log(`PASS ${message}`); };
const attr = (name: string, value: string) => `[${name}=${JSON.stringify(value)}]`;
const hash = (page: Page) => new URLSearchParams(new URL(page.url()).hash.slice(1));
const ordinary = (locale: string) => `${origin}/classics/${locale === 'en' ? 'en/' : ''}archive.html#status=verified`;
const lane = (page: Page, run: Run) => page.locator(`.global-run-lane${attr('data-global-run-id', run.runId)}`);
const assetVersions = Object.fromEntries(await Promise.all(['site.js', 'process.css'].map(async file =>
  [file, createHash('sha256').update(await fs.readFile(path.join(staticRoot, 'classics', file))).digest('hex').slice(0, 16)])));

async function observe(context: BrowserContext, label: string, cacheEnabled = false) {
  // Playwright routing disables HTTP caching, so the cache scenario observes events without routing.
  if (!cacheEnabled) await context.route(/^https?:\/\//u, route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!['GET', 'HEAD'].includes(request.method())) return route.abort();
    return route.continue();
  });
  context.on('request', request => {
    const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) return;
    if (url.origin !== origin) external.push(url.href);
    if (!['GET', 'HEAD'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname });
    if (url.pathname.startsWith('/api/')) apiReads.push(url.pathname);
    if (cacheEnabled && /\/(?:site\.js|process\.css)$/u.test(url.pathname)) cacheAssets.push(url.href);
  });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${label}: ${message.text()}`); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`${label}: ${response.status()} ${new URL(response.url()).pathname}`); });
  });
}

async function list(page: Page, locale: string) {
  const entry = new URL(ordinary(locale));
  assert.equal(new URLSearchParams(entry.hash.slice(1)).has('tab'), false, 'Start from the ordinary classics URL');
  assert.equal(new URLSearchParams(entry.hash.slice(1)).has('proof'), false);
  await page.goto(entry.href);
  await page.locator('.proof-row').first().waitFor();
  await page.evaluate(() => document.fonts.ready); await settled(page);
  assert.equal(await page.locator('.catalog').isVisible(), true);
}
async function global(page: Page) {
  await page.locator('.process-global-trajectory').waitFor();
  await page.evaluate(() => document.fonts.ready); await settled(page);
  assert.equal(hash(page).get('tab'), 'process');
  assert.equal(hash(page).get('mode'), 'global');
  for (const param of ['run', 'node', 'task', 'step']) assert.equal(hash(page).has(param), false,
    `Global links must not retain a selected ${param}`);
  assert.equal(await page.locator('#tab-process').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('[data-process-view="global"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.archive-process').getAttribute('data-process-layout'), 'global');
  assert.equal(await page.locator('.catalog').isVisible(), false);
}
async function enter(page: Page, record: ArchiveRecord, locale: string, explicit = false) {
  await list(page, locale);
  await page.locator(explicit ? `.row-route-open${attr('data-proof-route', record.id)}` : `.proof-row${attr('data-proof-id', record.id)}`).click();
  await global(page);
  assert.equal(hash(page).get('proof'), record.id);
}
async function backToGlobal(page: Page) {
  await page.locator('[data-process-view="global"]').click(); await global(page);
}
async function fits(page: Page, label: string) {
  await settled(page);
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width + 1, `${label}: document overflow ${JSON.stringify(dimensions)}`);
}
async function firstViewport(page: Page, locale: string, label: string) {
  assert.equal(await page.locator('.process-view-toolbar h4').innerText(), locale === 'en' ? 'Whole-problem trajectory' : '全局解题轨迹');
  const evidence = await page.evaluate(() => ['.process-view-toolbar h4', '.global-research'].map(selector => {
    const element = document.querySelector<HTMLElement>(selector)!;
    const box = element.getBoundingClientRect();
    const x = Math.max(0, box.left) + Math.min(box.width, innerWidth - Math.max(0, box.left)) / 2;
    const y = Math.max(0, box.top) + Math.min(box.height, innerHeight - Math.max(0, box.top)) / 2;
    const hit = document.elementFromPoint(x, y);
    return { selector, top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: innerWidth, height: innerHeight,
      visibleRatio: Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(0, box.top)) / box.height,
      unobscured: !!hit && (hit === element || element.contains(hit)) };
  }));
  for (const item of evidence) assert.ok(item.visibleRatio >= 0.9 && item.unobscured,
    `${label}: the trajectory title and first research stage must be visible without scrolling ${JSON.stringify(item)}`);
  viewportEvidence.push({ label, evidence });
}
async function verifyAssets(page: Page) {
  const urls = await page.locator('script[src],link[rel="stylesheet"][href]').evaluateAll(nodes => nodes.map(node =>
    node.getAttribute('src') ?? node.getAttribute('href')!));
  for (const file of ['site.js', 'process.css']) {
    const found = urls.map(url => new URL(url, page.url())).find(url => url.pathname.endsWith(`/${file}`));
    assert.ok(found, `The page must load ${file}`);
    assert.equal(found.searchParams.get('v'), assetVersions[file], `${file} must be addressed by its current content hash`);
  }
}
async function verifyGlobal(page: Page, record: ArchiveRecord) {
  const process = record.process!;
  const actual = await page.locator('.global-run-lane').evaluateAll(lanes => lanes.map(lane => ({
    id: lane.getAttribute('data-global-run-id'), final: lane.getAttribute('data-final'),
    buttons: [...lane.querySelectorAll<HTMLButtonElement>('button.global-stage')].map(button => ({
      run: button.dataset.globalRun, node: button.dataset.globalNode, step: button.dataset.globalStep,
    })), retained: lane.querySelector('.global-run-label small')?.textContent,
  })));
  assert.deepEqual(actual.map(lane => lane.id), process.runs.map(run => run.runId), 'Every actual run appears once, in saved order');
  assert.deepEqual(actual.filter(lane => lane.final === 'true').map(lane => lane.id), [record.campaign!.runId]);
  assert.equal(await page.locator('.global-final-badge').count(), 1, 'The whole problem has exactly one saved final acceptance');
  for (let index = 0; index < process.runs.length; index++) {
    const run = process.runs[index], row = actual[index];
    assert.equal(row.buttons.length, 3);
    assert.ok(row.buttons.every(button => button.run === run.runId), 'Stages cannot jump to another run');
    assert.equal(row.buttons[0].node, 'problem');
    assert.equal(row.buttons[2].node, run.runId === record.campaign!.runId ? 'acceptance' : 'end');
    const check = selectedCheck(run);
    assert.equal(row.buttons[1].step, check ? `check:${check.id}` : undefined);
    assert.equal(row.buttons[1].node, check?.scope === 'original' ? 'original' : check?.taskId ? `task:${check.taskId}` : 'problem');
    const previous = index ? process.runs[index - 1] : undefined;
    const retained = new Set((run.checks ?? []).filter(check => check.taskId && check.sourceDigest &&
      previous?.checks?.some(before => before.taskId === check.taskId && before.sourceDigest === check.sourceDigest))
      .map(check => `${check.taskId}\0${check.sourceDigest}`)).size;
    if (retained) assert.ok(row.retained?.includes(String(retained)), 'Retained source count needs a matching task and source hash');
    else assert.equal(row.retained, undefined, 'No retention badge without matching task and source identities');
  }
  return process.runs.length;
}
async function shot(page: Page, filename: string, fullPage = true) {
  await page.screenshot({ path: path.join(output, filename), fullPage }); screenshots.push(filename);
}

try {
  browser = await startBrowser(service.server, port);
  for (const locale of ['zh', 'en']) for (const width of [1440, 390, 320]) {
    const label = `${locale} ${width}px`; current = label;
    const context = await browser.newContext({ viewport: { width, height: width < 700 ? 844 : 1000 }, reducedMotion: 'reduce' });
    await observe(context, label);
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000);
    try {
      await enter(page, complex, locale);
      await firstViewport(page, locale, label); await verifyGlobal(page, complex); await verifyAssets(page); await fits(page, label);
      assert.equal(await page.locator('#tab-process').innerText(), locale === 'en' ? 'Routes and trajectory' : '路线与轨迹');
      await shot(page, `global-${locale}-${width}-viewport.png`, false);
      await shot(page, `global-${locale}-${width}.png`);
      mark(`${label}: ordinary classics row opens all runs in the first viewport with an explicit trajectory tab`);

      const earlier = complex.process!.runs.find(run => run.runId !== complex.campaign!.runId)!;
      await lane(page, earlier).locator('.global-research').click();
      await page.locator('.process-roadmap').waitFor();
      assert.equal(hash(page).get('mode'), 'roadmap'); assert.equal(hash(page).get('run'), earlier.runId);
      assert.equal(hash(page).get('node') ?? 'problem', 'problem');
      assert.equal(await page.locator('.process-roadmap button[data-process-node="problem"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.archive-process').getAttribute('data-process-run-id'), earlier.runId);
      assert.equal(await page.locator('.process-roadmap button[data-process-node^="task:"]').count(), earlier.tasks.length);
      await fits(page, `${label}: research route`); await backToGlobal(page); await verifyGlobal(page, complex);
      mark(`${label}: research stages open that run's real lemma roadmap and return to the complete trajectory`);

      await enter(page, failure.record, locale);
      await lane(page, failure.run).locator('.global-checks').click();
      await page.locator('#process-step-detail').waitFor();
      assert.equal(hash(page).get('run'), failure.run.runId); assert.equal(hash(page).get('mode'), 'roadmap');
      assert.equal(hash(page).get('step'), `check:${failure.check!.id}`);
      assert.equal(await page.locator('.process-diagnostics pre').textContent(), failure.check!.diagnostics);
      assert.equal(await page.locator('[data-process-acceptance]').count(), 0);
      await fits(page, `${label}: check diagnostic`);
      await shot(page, `diagnostic-${locale}-${width}.png`);
      await backToGlobal(page);
      mark(`${label}: verification stage opens the exact saved failed-check diagnostic`);

      const final = failure.record.process!.runs.find(run => run.runId === failure.record.campaign!.runId)!;
      await lane(page, final).locator('.global-outcome').click();
      await page.locator('[data-process-acceptance]').waitFor();
      assert.equal(hash(page).get('run'), failure.record.campaign!.runId);
      assert.equal(hash(page).get('node'), 'acceptance');
      assert.deepEqual(await page.locator('[data-process-acceptance] .process-targets code').allTextContents(), failure.record.campaign!.targets);
      await fits(page, `${label}: final acceptance`); await backToGlobal(page);
      const location = page.url(); await page.reload(); await global(page);
      assert.equal(page.url(), location); await verifyGlobal(page, failure.record);
      mark(`${label}: final outcome opens original-target acceptance and global view survives refresh`);

      await enter(page, complex, locale, true); await verifyGlobal(page, complex);
      await fits(page, `${label}: explicit entry`);
      const overview = new URL(ordinary(locale)); overview.hash = new URLSearchParams({ status: 'verified', proof: complex.id, tab: 'overview' }).toString();
      await page.goto(overview.href); await page.locator('#tab-overview[aria-selected="true"]').waitFor();
      assert.equal(await page.locator('.process-global-trajectory').count(), 0);
      assert.equal(await page.locator('.catalog').isVisible(), true);
      mark(`${label}: visible row action opens global view and explicit overview links keep their meaning`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); active = undefined; }
  }

  current = 'all sixteen ordinary entries';
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await observe(context, current); const page = await context.newPage(); active = page;
  let totalRuns = 0;
  for (const record of catalog.records) {
    current = `ordinary entry: ${record.id}`;
    await enter(page, record, 'zh'); totalRuns += await verifyGlobal(page, record); await fits(page, current);
  }
  await context.close(); active = undefined;
  mark(`all 16 accepted problems open complete global trajectories with ${totalRuns} actual runs and one correctly bound acceptance each`);

  current = 'cache-enabled ordinary entry and reload';
  const cached = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await observe(cached, current, true); const cachedPage = await cached.newPage(); active = cachedPage;
  await enter(cachedPage, complex, 'zh'); await verifyAssets(cachedPage);
  await cachedPage.reload(); await global(cachedPage); await verifyGlobal(cachedPage, complex); await verifyAssets(cachedPage);
  for (const file of ['site.js', 'process.css']) {
    const requests = cacheAssets.map(url => new URL(url)).filter(url => url.pathname.endsWith(`/${file}`));
    assert.ok(requests.length >= 2, `Cache-enabled navigation and reload must request ${file}`);
    assert.ok(requests.every(url => url.searchParams.get('v') === assetVersions[file]), 'Cache-enabled navigation must keep current asset version URLs');
  }
  await cached.close(); active = undefined;
  mark('normal cache-enabled browser loads and reloads global trajectories with the current content-versioned script and stylesheet');
  assert.equal(runnerCalls, 0); assert.deepEqual(writes, []); assert.deepEqual(apiReads, []); assert.deepEqual(external, []); assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(),
    checks, screenshots, viewportEvidence, records: catalog.records.length, runs: totalRuns, assetVersions, cacheAssets,
    paidModelCalls: false, runnerCalls, leanProcesses: 0, writes, apiReads, external, errors,
    complexExample: complex.id, failureExample: { record: failure.record.id, run: failure.run.runId, check: failure.check!.id } }, null, 2) + '\n');
  console.log(`Classic global trajectories passed ${checks.length} checks without models, Lean, mail or runtime writes.`);
} catch (error) {
  await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', checkedAt: new Date().toISOString(), current,
    error: error instanceof Error ? error.message : String(error), checks, viewportEvidence, paidModelCalls: false,
    runnerCalls, writes, apiReads, external, errors }, null, 2) + '\n');
  throw error;
} finally {
  await browser?.close(); await service.close(); await fs.rm(data, { recursive: true, force: true });
}
