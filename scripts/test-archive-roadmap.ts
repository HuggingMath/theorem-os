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
import { buildArchiveRoadmap } from '../docs/web/processRoadmap';
import type { ArchiveCatalog, ArchiveProcess, ArchiveRecord } from '../docs/web/types';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/archive-roadmap');
const staticRoot = path.join(root, 'out/web');
const catalog = JSON.parse(await fs.readFile(path.join(staticRoot, 'classics/data/catalog.json'), 'utf8')) as ArchiveCatalog;
assert.equal(catalog.records.length, 16);
assert.ok((await fs.readFile(path.join(staticRoot, 'classics/site.js'), 'utf8')).includes('data-process-node'),
  'Run bun run build:web with the real archive roadmap before this check');
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-archive-roadmap-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let runnerCalls = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Read-only archived roadmap fixture; no model or Lean' }; },
  async run() { runnerCalls++; throw new Error('Reading the archive roadmap must not start a worker'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: data, THEOREMOS_WEB_AUTH: 'none' }), runner);
type Run = ArchiveProcess['runs'][number];
const all = catalog.records.flatMap(record => record.process!.runs.map(run => ({ record, run })));
const complex = all.filter(({ run }) => run.tasks.some(task => task.dependencies.length) && run.tasks.some(task => task.status === 'blocked')
  && (run.deliveries?.length ?? 0) > 0).sort((a, b) => b.run.tasks.length - a.run.tasks.length)[0];
assert.ok(complex, 'The real archive must contain a branching graph with a blocked branch');
const failure = all.flatMap(({ record, run }) => (run.checks ?? []).filter(check => check.scope === 'task' && check.taskId &&
  run.tasks.some(task => task.id === check.taskId) && check.status === 'failed' && check.diagnostics &&
  check.sourceDigest && record.process!.sources?.[check.sourceDigest]).map(check => ({ record, run, check })))
  .sort((a, b) => a.check.diagnostics!.length - b.check.diagnostics!.length)[0];
assert.ok(failure, 'A real failed task proof with its saved source and diagnostic is required');
const checks: string[] = [], errors: string[] = [], writes: { method: string; path: string }[] = [], apiReads: string[] = [], external: string[] = [];
const screenshots: string[] = [];
let browser: Browser | undefined, active: Page | undefined, current = 'start browser';
const attr = (name: string, value: string) => `[${name}=${JSON.stringify(value)}]`;
const node = (page: Page, id: string) => page.locator(`.process-roadmap button${attr('data-process-node', id)}`);
const view = (page: Page) => page.locator('.process-map-viewport');
const hash = (page: Page) => new URLSearchParams(new URL(page.url()).hash.slice(1));
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const mark = (message: string) => { checks.push(message); console.log(`PASS ${message}`); };
const urlFor = (record: ArchiveRecord, locale: string, params: Record<string, string> = {}) =>
  `${origin}/classics/${locale === 'en' ? 'en/' : ''}archive.html#${new URLSearchParams({ proof: record.id, tab: 'process', status: 'verified', ...params })}`;
async function observe(context: BrowserContext, label: string) {
  await context.route(/^https?:\/\//u, route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.href); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) { writes.push({ method: request.method(), path: url.pathname }); return route.abort(); }
    if (url.pathname.startsWith('/api/')) apiReads.push(url.pathname);
    return route.continue();
  });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${label}: ${message.text()}`); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`${label}: ${response.status()} ${new URL(response.url()).pathname}`); });
  });
}
async function open(page: Page, record: ArchiveRecord, locale: string, params: Record<string, string> = {}) {
  await page.goto(urlFor(record, locale, params));
  await page.locator('.process-roadmap').waitFor(); await page.evaluate(() => document.fonts.ready); await settled(page);
  assert.equal(await page.locator('[data-process-view="roadmap"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.process-step-list').isVisible(), false, 'The default experience must be a graph');
  assert.equal(await page.locator('#tab-process').getAttribute('aria-selected'), 'true');
}
async function selectRun(page: Page, run: Run) {
  await page.locator(`.process-run-nav ${attr('data-process-run', run.runId)}`).click();
  assert.equal(await page.locator('.archive-process').getAttribute('data-process-run-id'), run.runId);
  assert.equal(hash(page).get('run'), run.runId);
  await page.locator('.process-roadmap').waitFor();
}
async function verifyGraph(page: Page, record: ArchiveRecord, run: Run) {
  const ids = new Set(run.tasks.map(task => task.id));
  const expectedDependencies = [...new Set(run.tasks.flatMap(task => task.dependencies.filter(id => ids.has(id))
    .map(id => `task:${id}->task:${task.id}`)))].sort();
  const actualDependencies = await page.locator('.process-roadmap path[data-map-edge][data-kind="dependency"]').evaluateAll(paths =>
    paths.map(path => `${path.getAttribute('data-from')}->${path.getAttribute('data-to')}`).sort());
  assert.deepEqual(actualDependencies, expectedDependencies, 'Visible edges must be exactly the archived task dependencies');
  const actualIds = await page.locator('.process-roadmap button[data-process-node]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-process-node')).sort());
  assert.equal(new Set(actualIds).size, actualIds.length);
  for (const id of ids) assert.ok(actualIds.includes(`task:${id}`), `Missing real archived task ${id}`);
  assert.equal(await node(page, 'acceptance').count(), Number(run.runId === record.campaign!.runId), 'Only the evidence-bound final run can display acceptance');
  const model = buildArchiveRoadmap({ ...record, excerpt: '' }, run, 'zh');
  assert.deepEqual(actualIds, model.nodes.map(node => node.id).sort());
  const boxes = await page.locator('.process-roadmap button[data-process-node]').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { id: node.getAttribute('data-process-node'), x: box.x, y: box.y, right: box.right, bottom: box.bottom };
  }));
  for (let left = 0; left < boxes.length; left++) for (let right = left + 1; right < boxes.length; right++) {
    const a = boxes[left], b = boxes[right];
    assert.ok(Math.min(a.right, b.right) - Math.max(a.x, b.x) <= 1 || Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) <= 1,
      `Graph nodes ${a.id} and ${b.id} overlap and cannot be read or clicked independently`);
  }
  for (const edge of await page.locator('.process-roadmap path[data-map-edge]').evaluateAll(paths => paths.map(path => ({
    from: path.getAttribute('data-from')!, to: path.getAttribute('data-to')!, path: path.getAttribute('d'),
  })))) {
    assert.ok(actualIds.includes(edge.from) && actualIds.includes(edge.to), 'Graph edges cannot point at nonexistent nodes');
    assert.ok(edge.path && !/NaN|undefined|Infinity/u.test(edge.path), 'An edge must have real SVG geometry');
  }
  return expectedDependencies.length;
}
async function fits(page: Page, label: string) {
  await settled(page);
  const box = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
    viewport: document.querySelector('.process-map-viewport')?.getBoundingClientRect().toJSON(),
    detail: document.querySelector('#process-step-detail')?.getBoundingClientRect().toJSON() }));
  assert.ok(box.scroll <= box.width + 1, `${label}: document overflow ${JSON.stringify(box)}`);
  for (const section of [box.viewport, box.detail]) if (section) assert.ok(section.left >= -1 && section.right <= box.width + 1, `${label}: the graph or its evidence leaves the page`);
}
async function shot(page: Page, filename: string) {
  await settled(page); await page.screenshot({ path: path.join(output, filename), fullPage: true }); screenshots.push(filename);
}

try {
  browser = await startBrowser(service.server, port);
  for (const locale of ['zh', 'en']) for (const width of [1440, 390, 320]) {
    const label = `${locale} ${width}px`; current = label;
    const context = await browser.newContext({ viewport: { width, height: width < 700 ? 844 : 1000 }, reducedMotion: 'reduce' });
    await observe(context, label);
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000);
    try {
      await open(page, complex.record, locale);
      const final = complex.record.process!.runs.find(run => run.runId === complex.record.campaign!.runId)!;
      await verifyGraph(page, complex.record, final);
      await selectRun(page, complex.run);
      const dependencies = await verifyGraph(page, complex.record, complex.run);
      assert.ok(dependencies > 4, 'The complex example must exercise multiple real dependency edges');
      assert.equal(await page.locator('.catalog').isVisible(), false);
      await fits(page, `${label}: default graph`);
      await shot(page, `roadmap-${locale}-${width}.png`);
      mark(`${label}: the default graph contains every real task and exactly ${dependencies} archived dependencies`);

      const blocked = complex.run.tasks.find(task => task.status === 'blocked')!;
      await node(page, `task:${blocked.id}`).click();
      assert.equal(hash(page).get('node'), `task:${blocked.id}`);
      assert.equal(hash(page).get('task'), blocked.id);
      assert.equal(await node(page, `task:${blocked.id}`).getAttribute('aria-pressed'), 'true');
      assert.equal(await node(page, `task:${blocked.id}`).getAttribute('data-tone'), 'attention');
      const blockedChecks = (complex.run.checks ?? []).filter(check => check.scope === 'task' && check.taskId === blocked.id);
      const blockedModel = buildArchiveRoadmap({ ...complex.record, excerpt: '' }, complex.run, locale as 'zh' | 'en').nodes.find(node => node.id === `task:${blocked.id}`)!;
      assert.deepEqual(blockedModel.checkIds.slice().sort(), blockedChecks.map(check => check.id).sort());
      assert.equal(await page.locator('#process-step-detail [data-process-acceptance]').count(), 0, 'A blocked branch is not original-problem acceptance');
      const location = page.url(); await page.reload(); await page.locator('.process-roadmap').waitFor();
      assert.equal(page.url(), location);
      assert.equal(await node(page, `task:${blocked.id}`).getAttribute('aria-pressed'), 'true');
      assert.equal(hash(page).get('run'), complex.run.runId);
      const selectedBox = (await node(page, `task:${blocked.id}`).boundingBox())!, canvasBox = (await view(page).boundingBox())!;
      assert.ok(selectedBox.x < canvasBox.x + canvasBox.width && selectedBox.x + selectedBox.width > canvasBox.x
        && selectedBox.y < canvasBox.y + canvasBox.height && selectedBox.y + selectedBox.height > canvasBox.y,
      'Reload must reveal the selected node inside the graph viewport');
      await fits(page, `${label}: selected blocked task`);
      mark(`${label}: a blocked branch opens its own saved evidence and stays selected after refresh`);

      // Zoom must change the actual diagram; drag must pan the actual scroll viewport.
      await page.locator('[data-map-zoom="actual"]').click(); await settled(page);
      const actualWidth = (await node(page, 'problem').boundingBox())!.width;
      await page.locator('[data-map-zoom="in"]').click(); await settled(page);
      const inWidth = (await node(page, 'problem').boundingBox())!.width;
      assert.ok(inWidth > actualWidth + 1, 'Zoom in must enlarge rendered graph nodes');
      await page.locator('[data-map-zoom="out"]').click(); await settled(page);
      assert.ok(Math.abs((await node(page, 'problem').boundingBox())!.width - actualWidth) < 2, 'Zoom out must restore the previous scale');
      const viewport = view(page);
      await viewport.scrollIntoViewIfNeeded();
      await viewport.evaluate(element => element.scrollTo(0, 0));
      const viewportBox = (await viewport.boundingBox())!;
      const maxScroll = await viewport.evaluate(element => element.scrollWidth - element.clientWidth);
      assert.ok(maxScroll > 60, 'Actual size must make the complex graph meaningfully pannable');
      await page.mouse.move(viewportBox.x + 110, viewportBox.y + 8); await page.mouse.down();
      await page.mouse.move(viewportBox.x + 35, viewportBox.y + 8, { steps: 8 }); await page.mouse.up();
      assert.ok(await viewport.evaluate(element => element.scrollLeft) > 20, 'Dragging the canvas must change its scroll position');
      await page.locator('[data-map-zoom="fit"]').click(); await settled(page);
      assert.ok((await node(page, 'problem').boundingBox())!.width <= actualWidth + 1, 'Fit must scale the complex graph into the available canvas');
      await fits(page, `${label}: zoom and pan`);
      mark(`${label}: zoom controls change node size and dragging pans the actual graph canvas`);

      // A task node must expose an actual failed check and the bytes checked at that time.
      await open(page, failure.record, locale, { run: failure.run.runId });
      await node(page, `task:${failure.check.taskId}`).click();
      const evidenceButton = page.locator(`.process-map-task-records ${attr('data-process-step', `check:${failure.check.id}`)}`);
      assert.equal(await evidenceButton.count(), 1, 'The node must expose its real failed check');
      await evidenceButton.click();
      assert.equal(await page.locator('.process-diagnostics pre').textContent(), failure.check.diagnostics);
      assert.equal(hash(page).get('step'), `check:${failure.check.id}`);
      assert.equal(hash(page).get('node'), `task:${failure.check.taskId}`);
      await page.locator('[data-process-code="source"]').click();
      const source = failure.record.process!.sources![failure.check.sourceDigest!];
      assert.equal(await page.locator('.process-code:not(.process-diff) code').textContent(), source.code);
      assert.equal(digest(source.code), source.sha256);
      assert.ok((await page.locator('.process-code-digest').innerText()).includes(source.sha256));
      await fits(page, `${label}: node check and source`);
      await shot(page, `evidence-${locale}-${width}.png`);
      mark(`${label}: clicking a task opens a real failed check, diagnostic and exact SHA-256-bound source`);

      await page.locator('[data-process-view="steps"]').click();
      await page.locator('.process-step-list').waitFor();
      assert.equal(hash(page).get('mode'), 'steps');
      assert.equal(hash(page).get('step'), `check:${failure.check.id}`);
      await page.locator('[data-process-view="roadmap"]').click(); await page.locator('.process-roadmap').waitFor();
      assert.equal(await node(page, `task:${failure.check.taskId}`).getAttribute('aria-pressed'), 'true');
      const historical = failure.record.process!.runs.find(run => run.runId !== failure.record.campaign!.runId);
      if (historical) {
        await selectRun(page, historical);
        assert.equal(await node(page, 'acceptance').count(), 0, 'Earlier runs cannot inherit final acceptance');
      }
      const accepted = failure.record.process!.runs.find(run => run.runId === failure.record.campaign!.runId)!;
      await selectRun(page, accepted); await node(page, 'acceptance').click();
      assert.equal(await page.locator('[data-process-acceptance]').count(), 1);
      for (const target of failure.record.campaign!.targets) assert.ok((await page.locator('[data-process-acceptance]').innerText()).includes(target));
      await page.locator('[data-action="back-list"]').first().click();
      assert.equal(await page.locator('.catalog').isVisible(), true);
      assert.equal(await page.locator('.proof-row.is-selected').getAttribute('data-proof-id'), failure.record.id);
      await fits(page, `${label}: return to list`);
      mark(`${label}: graph/steps preserve selected evidence, history keeps acceptance run-bound, and the list remains reachable`);
      assert.deepEqual(errors, []);
    } catch (error) {
      await page.screenshot({ path: path.join(output, `failure-${locale}-${width}.png`), fullPage: true });
      await fs.writeFile(path.join(output, `failure-${locale}-${width}.json`), JSON.stringify({ label, url: page.url(),
        error: String(error), errors }, null, 2) + '\n'); throw error;
    } finally { await context.close(); active = undefined; }
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await observe(context, 'all sixteen'); const page = await context.newPage(); active = page;
  let taskNodes = 0, dependencyEdges = 0;
  for (const record of catalog.records) {
    current = `all sixteen: ${record.id}`;
    await open(page, record, 'zh');
    const run = record.process!.runs.find(run => run.runId === record.campaign!.runId)!;
    dependencyEdges += await verifyGraph(page, record, run); taskNodes += run.tasks.length;
    await node(page, 'acceptance').click();
    assert.equal(await page.locator('[data-process-acceptance]').count(), 1);
    const raw = await page.request.get(`${origin}/classics/data/proofs/${record.id}/process.json`);
    assert.equal(raw.status(), 200); assert.deepEqual(await raw.json(), record.process);
  }
  await context.close(); active = undefined;
  mark(`all 16 accepted problems open real default roadmaps with ${taskNodes} task nodes and ${dependencyEdges} saved dependency edges`);
  assert.equal(runnerCalls, 0); assert.deepEqual(writes, []); assert.deepEqual(apiReads, []); assert.deepEqual(external, []); assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(),
    checks, screenshots, records: catalog.records.length, taskNodes, dependencyEdges, paidModelCalls: false,
    runnerCalls, leanProcesses: 0, writes, apiReads, external, errors, complexExample: { record: complex.record.id, run: complex.run.runId },
    failureExample: { record: failure.record.id, run: failure.run.runId, check: failure.check.id } }, null, 2) + '\n');
  console.log(`Archive roadmaps passed ${checks.length} checks with no model, Lean, email or research calls.`);
} catch (error) {
  await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', checkedAt: new Date().toISOString(),
    current, error: error instanceof Error ? error.message : String(error), checks, paidModelCalls: false,
    runnerCalls, writes, apiReads, errors }, null, 2) + '\n'); throw error;
} finally {
  await browser?.close(); await service.close(); await fs.rm(data, { recursive: true, force: true });
}
