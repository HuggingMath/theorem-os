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
import { compareSources } from '../apps/web/client/sourceDiff';
import { processMessage, readableProcessText } from '../docs/web/processText';
import type { ProofWalkthrough } from '../docs/web/proofWalkthroughTypes';
import type { ArchiveCatalog, ArchiveProcess, ArchiveRecord } from '../docs/web/types';
import { workflowNote } from '../docs/web/workflowNotes';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/classic-global-trajectory');
const staticRoot = path.join(root, 'out/web');
const catalog = JSON.parse(await fs.readFile(path.join(staticRoot, 'classics/data/catalog.json'), 'utf8')) as ArchiveCatalog;
assert.equal(catalog.records.length, 16);
assert.ok((await fs.readFile(path.join(staticRoot, 'classics/site.js'), 'utf8')).includes('data-workflow-stage'),
  'Build the complete archived research workflow before running this browser check');
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-complete-flow-'));
const port = await freePort(), origin = 'http://127.0.0.1:' + port;
let runnerCalls = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Read-only saved workflow fixture; no model or Lean' }; },
  async run() { runnerCalls++; throw new Error('Reading saved research must not start a worker'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: data, THEOREMOS_WEB_AUTH: 'none' }), runner);
type Run = ArchiveProcess['runs'][number];
type Check = NonNullable<Run['checks']>[number];
const realRecord = (id: string) => {
  const record = catalog.records.find(record => record.id === id);
  assert.ok(record, 'Missing actual archived problem ' + id); return record;
};
const triangle = realRecord('openai_triangle_face');
const threeState = realRecord('openai_three_state_supercritical');
const honeycomb = realRecord('openai_honeycomb_free_energy');
const finalRun = (record: ArchiveRecord) => record.process!.runs.find(run => run.runId === record.campaign!.runId)!;
const all = catalog.records.flatMap(record => record.process!.runs.map(run => ({ record, run })));
const failure = all.flatMap(({ record, run }) => (run.checks ?? []).filter(check => check.status === 'failed' && check.diagnostics
  && check.sourceDigest && record.process!.sources?.[check.sourceDigest] && check.taskId && run.tasks.some(task => task.id === check.taskId))
  .map(check => ({ record, run, check }))).sort((a, b) => a.check.diagnostics!.length - b.check.diagnostics!.length)[0];
assert.ok(failure, 'The real archive must contain a failed check with its saved bytes');
const previousCheck = (record: ArchiveRecord, run: Run, check: Check) => (run.checks ?? [])
  .filter(item => item.id !== check.id && item.at < check.at && item.taskId === check.taskId && item.scope === check.scope)
  .sort((a, b) => b.at.localeCompare(a.at)).find(item => item.sourceDigest && check.sourceDigest
    && record.process!.sources?.[item.sourceDigest]?.path === record.process!.sources?.[check.sourceDigest]?.path);
const revisions = all.flatMap(({ record, run }) => (run.checks ?? []).flatMap(check => {
  if (!check.sourceDigest || !record.process!.sources?.[check.sourceDigest]) return [];
  const before = previousCheck(record, run, check);
  if (!before?.sourceDigest || before.sourceDigest === check.sourceDigest
    || run.checks!.some(item => item.id !== check.id && item.at === check.at && item.taskId === check.taskId && item.scope === check.scope)) return [];
  const old = record.process!.sources![before.sourceDigest], source = record.process!.sources![check.sourceDigest];
  if (!old || !source) return [];
  const comparison = compareSources(old.code, source.code);
  return comparison.status === 'ready' && comparison.added + comparison.removed > 0
    ? [{ record, run, check, before, comparison, bytes: old.code.length + source.code.length }] : [];
})).sort((a, b) => a.bytes - b.bytes);
const revision = revisions.find(item => item.record.id === threeState.id) ?? revisions[0];
assert.ok(revision, 'The real archive must contain comparable later source versions');
const checks: string[] = [], errors: string[] = [], external: string[] = [], apiReads: string[] = [];
const writes: { method: string; path: string }[] = [], screenshots: string[] = [], cacheAssets: string[] = [], viewportEvidence: object[] = [];
let browser: Browser | undefined, active: Page | undefined, current = 'start browser';
const mark = (message: string) => { checks.push(message); console.log('PASS ' + message); };
const attr = (name: string, value: string) => '[' + name + '=' + JSON.stringify(value) + ']';
const hash = (page: Page) => new URLSearchParams(new URL(page.url()).hash.slice(1));
const ordinary = (locale: string) => origin + '/classics/' + (locale === 'en' ? 'en/' : '') + 'archive.html#status=verified';
const runButton = (page: Page, run: Run) => page.locator(attr('data-global-select', run.runId));
const entry = (page: Page, id: string) => page.locator('.global-workflow ' + attr('data-workflow-entry', id));
const stage = (page: Page, name: string) => page.locator('.global-workflow ' + attr('data-workflow-stage', name));
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const byTime = <T extends { at: string }>(values: T[]) => values.slice().sort((a, b) => a.at.localeCompare(b.at));
const assetVersions = Object.fromEntries(await Promise.all(['site.js', 'process.css'].map(async file =>
  [file, digest(await fs.readFile(path.join(staticRoot, 'classics', file))).slice(0, 16)])));
const processAssetVersions = Object.fromEntries(await Promise.all(catalog.records.map(async record =>
  [record.id, digest(await fs.readFile(path.join(staticRoot, 'classics/data/process', record.id + '.js'))).slice(0, 16)])));
const processAssetRequests: string[] = [];
const figureAssetVersion = digest(await fs.readFile(path.join(staticRoot, 'classics/data/proof-figures.js'))).slice(0, 16);
const figureAssetRequests: string[] = [];

async function observe(context: BrowserContext, label: string, cacheEnabled = false) {
  // Routing disables HTTP caching; the cache scenario only observes request events.
  if (!cacheEnabled) await context.route(/^https?:\/\//u, route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) return route.abort();
    return route.continue();
  });
  context.on('request', request => {
    const url = new URL(request.url()); if (!/^https?:$/u.test(url.protocol)) return;
    if (url.origin !== origin) external.push(url.href);
    if (!['GET', 'HEAD'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname });
    if (url.pathname.startsWith('/api/')) apiReads.push(url.pathname);
    if (/\/data\/process\/[^/]+\.js$/u.test(url.pathname)) processAssetRequests.push(url.href);
    if (url.pathname.endsWith('/data/proof-figures.js')) figureAssetRequests.push(url.href);
    if (cacheEnabled && /\/(?:site\.js|process\.css)$/u.test(url.pathname)) cacheAssets.push(url.href);
  });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(label + ': ' + error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(label + ': ' + message.text()); });
    page.on('response', response => { if (response.status() >= 400) errors.push(label + ': ' + response.status() + ' ' + new URL(response.url()).pathname); });
  });
}
async function global(page: Page, record: ArchiveRecord, run = finalRun(record)) {
  await page.locator('.process-global-trajectory').waitFor(); await settled(page);
  assert.equal(hash(page).get('proof'), record.id);
  assert.equal(hash(page).get('tab'), 'process'); assert.equal(hash(page).get('mode'), 'global');
  assert.equal(hash(page).get('run') ?? record.campaign!.runId, run.runId);
  for (const param of ['node', 'task', 'step']) assert.equal(hash(page).has(param), false, 'Global URL must not expose stale ' + param);
  assert.equal(await page.locator('#tab-process').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('[data-process-view="global"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.archive-process').getAttribute('data-process-layout'), 'global');
  assert.equal(await page.locator('.archive-process').getAttribute('data-process-run-id'), run.runId);
  assert.equal(await page.locator('.global-workflow').getAttribute('data-global-selected-run'), run.runId);
  assert.equal(await runButton(page, run).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.global-history [aria-pressed="true"]').count(), 1);
  assert.equal(await page.locator('.catalog').isVisible(), false);
}
async function enter(page: Page, record: ArchiveRecord, locale: string, explicit = false) {
  const url = ordinary(locale);
  assert.equal(new URLSearchParams(new URL(url).hash.slice(1)).has('proof'), false);
  await page.goto(url); await page.locator('.proof-row').first().waitFor();
  await page.evaluate(() => document.fonts.ready); await settled(page);
  assert.equal(await page.locator('.catalog').isVisible(), true);
  await page.locator(explicit ? '.row-route-open' + attr('data-proof-route', record.id) : '.proof-row' + attr('data-proof-id', record.id)).click();
  await global(page, record);
}
async function chooseRun(page: Page, record: ArchiveRecord, run: Run, key?: 'Enter' | 'Space') {
  const history = page.locator('.global-history-panel');
  if (!await history.evaluate(element => (element as HTMLDetailsElement).open)) await history.locator('summary').click();
  const button = runButton(page, run);
  if (key) { await button.focus(); await button.press(key); } else await button.click();
  await global(page, record, run);
  assert.equal(hash(page).get('run'), run.runId, 'An explicit selected run must be saved in the link');
  assert.equal(await page.locator('.global-history-panel > summary').evaluate(element => element === document.activeElement), true,
    'Selecting a run closes its history and restores focus to the history control');
}
async function back(page: Page, record: ArchiveRecord, run: Run) {
  await page.locator('[data-process-view="global"]').click(); await global(page, record, run);
}
async function fits(page: Page, label: string) {
  await settled(page);
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width + 1, label + ': document overflow ' + JSON.stringify(dimensions));
}
async function visible(page: Page, selector: string, label: string) {
  const evidence = await page.locator(selector).first().evaluate(element => {
    const box = element.getBoundingClientRect();
    const x = Math.max(0, box.left) + Math.max(0, Math.min(box.right, innerWidth) - Math.max(0, box.left)) / 2;
    const y = Math.max(0, box.top) + Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(0, box.top)) / 2;
    const hit = document.elementFromPoint(x, y);
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: innerWidth, height: innerHeight,
      visibleRatio: Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(0, box.top)) / box.height,
      unobscured: !!hit && (hit === element || element.contains(hit)) };
  });
  assert.ok(evidence.visibleRatio >= 0.9 && evidence.unobscured, label + ': effective visibility ' + JSON.stringify(evidence));
  return evidence;
}
async function firstViewport(page: Page, label: string, locale: string) {
  assert.equal(await page.locator('.process-view-toolbar h4').innerText(), locale === 'en' ? 'Whole-problem trajectory' : '全局解题轨迹');
  const title = await visible(page, '.proof-walkthrough-heading h5', label);
  const selection = await visible(page, '.global-workflow-heading', label);
  const phase = await visible(page, '[data-global-scroll="global-plan"]', label);
  const outline = await visible(page, '.proof-overview > li:first-child', label);
  assert.ok(outline.top < outline.height * 0.65, label + ': the mathematical route must appear in the first part of the viewport');
  viewportEvidence.push({ label, title, selection, phase, outline });
}
async function phase(page: Page, name: string, id: string) {
  const location = page.url(), button = page.locator('.global-workflow-stages ' + attr('data-global-scroll', id));
  await button.focus(); await button.press('Enter'); await settled(page);
  assert.equal(page.url(), location, 'A phase jump must keep the selected run and evidence location');
  const heading = stage(page, name).locator('.workflow-section-heading > h5');
  assert.equal(await heading.evaluate(element => element === document.activeElement), true, 'Phase navigation must move keyboard focus to its heading');
  await visible(page, '#' + id + ' .workflow-section-heading > h5', current + ': ' + name);
}
async function openProofRoute(page: Page) {
  const panel = page.locator('.proof-route-panel');
  if (!await panel.evaluate(element => (element as HTMLDetailsElement).open)) await panel.locator('summary').click();
  await settled(page);
  assert.equal(await panel.evaluate(element => (element as HTMLDetailsElement).open), true);
  assert.equal(await panel.locator('summary').getAttribute('aria-expanded'), 'true');
  const diagram = await panel.locator('.proof-route-map').evaluate(map => {
    const svg = map.querySelector<SVGSVGElement>('.proof-route-edges')!, box = svg.getBoundingClientRect();
    const edges = [...map.querySelectorAll<SVGPathElement>('[data-proof-edge]')];
    const buttons = new Map([...map.querySelectorAll<HTMLElement>('[data-proof-route-step]')].map(button => [button.dataset.proofRouteStep, button]));
    return {
      mapWidth: map.clientWidth, contentHeight: map.querySelector<HTMLElement>('.proof-route-nodes')!.offsetHeight,
      width: box.width, height: box.height,
      drawn: edges.every(edge => !!edge.getAttribute('d') && !/NaN|Infinity/u.test(edge.getAttribute('d')!)),
      highlighted: edges.filter(edge => ['input', 'output'].includes(edge.dataset.proofRelation!)).map(edge => {
        const from = buttons.get(edge.dataset.from)!.getBoundingClientRect(), to = buttons.get(edge.dataset.to)!.getBoundingClientRect();
        const rendered = edge.getBoundingClientRect();
        return { width: rendered.width, height: rendered.height, nodeDistance: Math.abs(from.top + from.height / 2 - to.top - to.height / 2) };
      }),
    };
  });
  assert.equal(diagram.drawn, true, 'Opening the route must draw its dependency arrows from the visible nodes');
  assert.ok(diagram.width >= diagram.mapWidth - 2 && diagram.height >= diagram.contentHeight - 2,
    'The dependency SVG must cover the real diagram content, not inherit an icon-sized viewport: ' + JSON.stringify(diagram));
  assert.ok(diagram.highlighted.length > 0, 'The selected step must have visible incoming or outgoing dependency arrows');
  for (const edge of diagram.highlighted) assert.ok(edge.width > 1 && edge.height >= edge.nodeDistance * 0.9,
    'Highlighted arrows must span their actual nodes after SVG scaling: ' + JSON.stringify(edge));
}
async function reading(page: Page, walkthrough: ProofWalkthrough, id: string, locale: 'zh' | 'en') {
  const index = walkthrough.steps.findIndex(step => step.id === id), step = walkthrough.steps[index];
  assert.ok(step, 'Reading must identify a real proof step');
  await page.waitForFunction(id => document.querySelector<HTMLElement>('[data-proof-walkthrough]')?.dataset.proofActive === id, id);
  await settled(page);
  const state = await page.locator('[data-proof-walkthrough]').evaluate(root => {
    const ids = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)].map(node => node.dataset.proofRouteStep).sort();
    const edgeIds = (relation: string) => [...root.querySelectorAll<SVGElement>('[data-proof-edge][data-proof-relation="' + relation + '"]')]
      .map(edge => edge.dataset.from + '->' + edge.dataset.to).sort();
    return {
      current: ids('[data-proof-route-step][aria-current="step"]'),
      inputs: ids('[data-proof-route-step][data-proof-relation="input"]'),
      outputs: ids('[data-proof-route-step][data-proof-relation="output"]'),
      inputEdges: edgeIds('input'), outputEdges: edgeIds('output'),
      counts: [...root.querySelectorAll('[data-proof-reading-count]')].map(node => node.textContent),
      titles: [...root.querySelectorAll('[data-proof-reading-title]')].map(node => node.textContent),
    };
  });
  const consumers = walkthrough.steps.filter(candidate => candidate.dependsOn.includes(id)).map(candidate => candidate.id).sort();
  assert.deepEqual(state.current, [id], 'The diagram must identify only the step being read');
  assert.deepEqual(state.inputs, [...step.dependsOn].sort());
  assert.deepEqual(state.outputs, consumers);
  assert.deepEqual(state.inputEdges, step.dependsOn.map(previous => previous + '->' + id).sort());
  assert.deepEqual(state.outputEdges, consumers.map(next => id + '->' + next).sort());
  const count = String(index + 1).padStart(2, '0') + ' / ' + String(walkthrough.steps.length).padStart(2, '0');
  assert.deepEqual(state.counts, [count, count], 'Desktop and mobile reading counters must stay synchronized');
  assert.deepEqual(state.titles, [step.title[locale], step.title[locale]]);
  assert.equal(await page.locator('.proof-overview [aria-current="step"]').getAttribute('data-proof-overview-stage'),
    String(walkthrough.stages.findIndex(stage => stage.stepIds.includes(id))), 'The overview follows the current mathematical stage');
  await visible(page, '#proof-derivation-' + id + ' h5', current + ': reading heading');
}
async function verifyProofFigure(page: Page, record: ArchiveRecord, locale: 'zh' | 'en', label: string) {
  const step = record.process!.walkthrough!.steps.find(step => step.figure)!;
  assert.ok(step?.figure, record.id + ': an actual accepted proof step must own the figure');
  const location = page.url(), figure = page.locator(attr('data-proof-figure', step.figure));
  await page.locator('[data-proof-figures-state="ready"]').waitFor();
  await figure.scrollIntoViewIfNeeded(); await settled(page);
  const diagram = await figure.locator('.proof-figure-svg').evaluate(svg => {
    const box = svg.getBoundingClientRect(), parent = svg.parentElement!.getBoundingClientRect();
    return { width: box.width, height: box.height, left: box.left, right: box.right, parentLeft: parent.left, parentRight: parent.right };
  });
  assert.ok(diagram.width >= 150 && diagram.height >= 100 && diagram.left >= diagram.parentLeft - 1 && diagram.right <= diagram.parentRight + 1,
    'The mathematical SVG must use the full column and fit the screen: ' + JSON.stringify(diagram));
  if (step.figure === 'triangle-matchings') {
    for (const choice of ['0', '1', '2', 'all']) {
      const button = figure.locator(attr('data-triangle-choice', choice));
      await button.focus(); await button.press(choice === '1' ? 'Space' : 'Enter');
      assert.equal(await button.evaluate(node => node === document.activeElement), true, 'Changing a matching preserves its control and keyboard focus');
      assert.equal(await figure.getAttribute('data-triangle-choice'), choice);
      assert.equal(await figure.locator('[aria-pressed="true"]').count(), 1);
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      const k = choice === 'all' ? 3 : 1, t = choice === 'all' ? 0 : 1;
      assert.equal(await figure.locator('[data-edge-kind="old"][data-selected="true"]').count(), k);
      assert.equal(await figure.locator('[data-edge-kind="new"][data-selected="true"]').count(), t);
      assert.equal(await figure.locator('[data-triangle-equation]').textContent(), k + ' + 2 × ' + t + ' = 3');
    }
  } else if (step.figure === 'four-corner-cover') {
    const p = figure.locator('[data-cover-coordinate="p"]'), q = figure.locator('[data-cover-coordinate="q"]');
    for (const [a, b, corner] of [[0.1, 0.1, '00'], [0.9, 0.9, '11'], [0.8, 0.2, '10'], [0.2, 0.8, '01']] as const) {
      const svg = figure.locator('[data-cover-picture]');
      await svg.scrollIntoViewIfNeeded();
      const click = await svg.evaluate((node, coordinates) => {
        const svg = node as SVGSVGElement;
        const [a, b] = coordinates;
        const point = new DOMPoint(34 + 148 * a + 74 * b, 196 - 74 * Math.sqrt(3) * b).matrixTransform(svg.getScreenCTM()!);
        return { x: point.x, y: point.y };
      }, [a, b]);
      await page.mouse.click(click.x, click.y);
      assert.equal(await figure.getAttribute('data-cover-corner'), corner);
      assert.equal(await p.inputValue(), String(a)); assert.equal(await q.inputValue(), String(b));
      assert.equal(await figure.locator('[data-cover-region][data-selected="true"]').getAttribute('data-cover-region'), corner);
      assert.equal(await figure.locator('[data-cover-corner]').textContent(), '(' + corner[0] + ', ' + corner[1] + ')');
      const selected = await figure.locator('[data-cover-point]').evaluate(node => [Number(node.getAttribute('cx')), Number(node.getAttribute('cy'))]);
      assert.ok(Math.abs(selected[0] - (34 + 148 * a + 74 * b)) < 0.00001);
      assert.ok(Math.abs(selected[1] - (196 - 74 * Math.sqrt(3) * b)) < 0.00001);
    }
    await p.focus(); await p.press('ArrowRight');
    assert.equal(await p.inputValue(), '0.21');
    assert.equal(await p.evaluate(node => node === document.activeElement), true, 'Slider calculations preserve native keyboard focus');
    assert.equal(await figure.locator('[data-cover-output="p"]').textContent(), '0.21');
    assert.ok((await figure.locator('[data-cover-quadratic]').textContent())!.includes('0.04210'));
    await p.press('Home'); await q.focus(); await q.press('End');
    assert.equal(await p.inputValue(), '0'); assert.equal(await q.inputValue(), '1');
    assert.equal(await figure.getAttribute('data-cover-corner'), '01');
    assert.ok((await figure.locator('[data-cover-distance]').textContent())!.includes('0.0000'));
    const svg = figure.locator('[data-cover-picture]'); await svg.scrollIntoViewIfNeeded();
    const drag = await svg.evaluate(node => {
      const transform = (node as SVGSVGElement).getScreenCTM()!;
      return [[0, 1], [0.42, 0.28]].map(([a, b]) => {
        const point = new DOMPoint(34 + 148 * a + 74 * b, 196 - 74 * Math.sqrt(3) * b).matrixTransform(transform);
        return { x: point.x, y: point.y };
      });
    });
    await page.mouse.move(drag[0].x, drag[0].y); await page.mouse.down();
    await page.mouse.move(drag[1].x, drag[1].y, { steps: 8 }); await page.mouse.up();
    assert.equal(await p.inputValue(), '0.42'); assert.equal(await q.inputValue(), '0.28');
    assert.equal(await figure.getAttribute('data-cover-corner'), '10');
  } else {
    const expected = [
      { stage: 'base', gap: '(0,0)', height: '1', first: '1,0', absent: '0,0' },
      { stage: 'placed', gap: '(-4,-1)', height: '1', first: '0,0', absent: '-4,-1' },
      { stage: 'fork', gap: '(0,0)', height: '2', first: '-4,-1', absent: '0,0' },
    ];
    for (const item of expected) {
      const button = figure.locator(attr('data-snaky-stage', item.stage));
      await button.focus(); await button.press(item.stage === 'placed' ? 'Space' : 'Enter');
      assert.equal(await button.evaluate(node => node === document.activeElement), true);
      assert.equal(await figure.getAttribute('data-snaky-current'), item.stage);
      assert.equal(await figure.locator('[aria-pressed="true"]').count(), 1);
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      assert.equal(await figure.locator('[data-snaky-cell]').count(), 6);
      assert.equal(await figure.locator('[data-snaky-cell-role="required"]').count(), 5);
      assert.equal(await figure.locator(attr('data-snaky-cell', item.first)).getAttribute('data-snaky-cell-role'), 'required');
      assert.equal(await figure.locator(attr('data-snaky-cell', item.absent)).getAttribute('data-snaky-cell-role'), 'gap');
      assert.equal(await figure.locator('[data-snaky-gap]').textContent(), item.gap);
      assert.equal(await figure.locator('[data-snaky-height]').textContent(), item.height);
    }
  }
  assert.equal(page.url(), location, 'A mathematical illustration must retain the exact selected proof and run URL');
  assert.equal(await page.locator(attr('data-proof-derivation', step.id) + ' .proof-walkthrough-calculation').isVisible(), true);
  await fits(page, label + ': ' + step.figure);
  await figure.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
  // Place the figure below both sticky reading controls for a readable screenshot.
  await page.evaluate(() => scrollBy(0, -200));
  await shot(page, 'figure-' + locale + '-' + page.viewportSize()!.width + '-' + step.figure + '.png');
}
async function verifyAssets(page: Page) {
  const urls = await page.locator('script[src],link[rel="stylesheet"][href]').evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('src') ?? node.getAttribute('href')!));
  for (const file of ['site.js', 'process.css']) {
    const url = urls.map(value => new URL(value, page.url())).find(url => url.pathname.endsWith('/' + file));
    assert.ok(url, 'The page must load ' + file);
    assert.equal(url.searchParams.get('v'), assetVersions[file], file + ' must use its final content hash');
  }
}
async function verifyWorkflow(page: Page, record: ArchiveRecord, run: Run, locale: 'zh' | 'en') {
  await global(page, record, run);
  const actual = await page.locator('.global-workflow').evaluate(workflow => ({
    stages: [...workflow.querySelectorAll<HTMLElement>('[data-workflow-stage]')].map(section => section.dataset.workflowStage),
    objectives: [...workflow.querySelectorAll<HTMLElement>('[data-workflow-task]')].map(row => {
      const body = row.querySelector('dd')!.cloneNode(true) as HTMLElement;
      body.querySelector('.workflow-task-dependencies')?.remove();
      return { id: row.dataset.workflowTask, objective: body.textContent };
    }),
    entries: [...workflow.querySelectorAll<HTMLElement>('[data-workflow-entry]')].map(row => ({
      id: row.dataset.workflowEntry!, kind: row.dataset.workflowKind, stage: row.closest<HTMLElement>('[data-workflow-stage]')!.dataset.workflowStage,
      time: row.querySelector('time')?.getAttribute('datetime'),
      retained: !!row.querySelector('.workflow-retained'),
      preview: row.querySelector(':scope > .workflow-prose')?.textContent ?? '',
      full: row.querySelector('.workflow-full-text > .workflow-prose')?.textContent,
      link: (() => { const button = row.querySelector<HTMLElement>('.workflow-record-link'); return button
        ? { run: button.dataset.globalRun, node: button.dataset.globalNode, step: button.dataset.globalStep } : undefined; })(),
    })),
    taskNodes: [...workflow.querySelectorAll<HTMLElement>('.process-roadmap button[data-process-node^="task:"]')].map(node => node.dataset.processNode),
    edges: [...workflow.querySelectorAll<SVGElement>('.process-roadmap path[data-map-edge][data-kind="dependency"]')].map(edge => edge.dataset.from + '->' + edge.dataset.to).sort(),
  }));
  const walkthrough = record.process?.walkthrough?.runId === run.runId ? record.process.walkthrough : undefined;
  assert.deepEqual(actual.stages, walkthrough ? ['research', 'plan', 'implementation', 'review'] : ['plan', 'research', 'implementation', 'review']);
  assert.equal(await page.locator('[data-proof-walkthrough]').count(), Number(Boolean(walkthrough)));
  if (walkthrough) {
    assert.equal(await page.locator('[data-proof-walkthrough]').getAttribute('data-proof-sha'), record.campaign!.proofSha256);
    assert.equal(await page.locator('[data-proof-derivation]').count(), walkthrough.steps.length);
    assert.equal(await page.locator('.proof-walkthrough-strategy').textContent(), walkthrough.strategy[locale]);
    assert.deepEqual(await page.locator('[data-proof-overview-stage]').evaluateAll(buttons => buttons.map(button => ({
      steps: (button as HTMLElement).dataset.proofOverviewSteps!.split(' '),
      target: (button as HTMLElement).dataset.globalScroll,
      title: button.querySelector('strong')!.textContent,
      summary: button.querySelector('.proof-overview-copy > span')!.textContent,
    }))), walkthrough.stages.map(stage => ({ steps: stage.stepIds, target: 'proof-derivation-' + stage.stepIds[0],
      title: stage.title[locale], summary: stage.summary[locale] })));
    const route = page.locator('.proof-walkthrough-route');
    assert.deepEqual(await route.locator('[data-proof-route-step]').evaluateAll(buttons => buttons.map(button => ({
      id: (button as HTMLElement).dataset.proofRouteStep, title: (button as HTMLElement).dataset.proofRouteTitle,
      controls: button.getAttribute('aria-controls'),
    }))), walkthrough.steps.map(step => ({ id: step.id, title: step.title[locale], controls: 'proof-derivation-' + step.id })));
    assert.deepEqual(await route.locator('[data-proof-edge]').evaluateAll(edges => edges.map(edge =>
      (edge as SVGElement).dataset.from + '->' + (edge as SVGElement).dataset.to).sort()),
    walkthrough.steps.flatMap(step => step.dependsOn.map(previous => previous + '->' + step.id)).sort(),
    record.id + ': proof arrows must preserve every actual dependency without adding sequential edges');
    for (const step of walkthrough.steps) {
      const row = page.locator(attr('data-proof-derivation', step.id));
      assert.equal(await row.locator('.proof-walkthrough-claim > p').textContent(), step.claim[locale]);
      assert.equal(await row.locator('.proof-walkthrough-explanation > p').textContent(), step.because[locale]);
      assert.equal(await row.locator('.proof-walkthrough-next > p').textContent(), step.next[locale]);
      assert.deepEqual(await row.locator('.proof-walkthrough-statement').allTextContents(), step.derivation.map(line => line.statement[locale]));
      assert.deepEqual(await row.locator('.proof-walkthrough-justification').allTextContents(), step.derivation.map(line => line.reason[locale]));
      assert.deepEqual(await row.locator('[data-proof-dependency]').evaluateAll(buttons => buttons.map(button => (button as HTMLElement).dataset.proofDependency)), step.dependsOn);
      assert.equal(await row.locator('[data-proof-figure]').count(), Number(Boolean(step.figure)));
      if (step.figure) assert.equal(await row.locator('[data-proof-figure]').getAttribute('data-proof-figure'), step.figure);
      assert.deepEqual(await row.locator('[data-proof-consumer]').evaluateAll(buttons => buttons.map(button => (button as HTMLElement).dataset.proofConsumer)),
        walkthrough.steps.filter(candidate => candidate.dependsOn.includes(step.id)).map(candidate => candidate.id),
        record.id + '/' + step.id + ': later-result links must be the exact reverse of the dependency relation');
      const source = record.process!.sources![walkthrough.proofSha256];
      assert.deepEqual(await row.locator('.proof-walkthrough-source > ol code').allTextContents(),
        source.code.split('\n').slice(step.evidence.source.line - 1, step.evidence.source.endLine).map(line => line || ' '));
    }
  }
  const expectedPlan = run.events.flatMap((event, index) => event.kind === 'plan-edit' && event.message?.trim() ? ['event:' + index] : []);
  const expected = [...expectedPlan, ...(run.deliveries ?? []).map(delivery => 'delivery:' + delivery.id), ...(run.checks ?? []).map(check => 'check:' + check.id)].sort();
  assert.deepEqual(actual.entries.map(row => row.id).sort(), expected, record.id + ': every actual delivery and check appears exactly once');
  assert.equal(new Set(actual.entries.map(row => row.id)).size, actual.entries.length, 'No repeated or synthesized workflow entries');
  assert.deepEqual(actual.objectives, run.tasks.map(task => ({ id: task.id, objective: readableProcessText(task.objective, Number.MAX_SAFE_INTEGER) })), 'All complete task objectives must remain available');
  assert.deepEqual(actual.taskNodes.slice().sort(), run.tasks.map(task => 'task:' + task.id).sort());
  const taskIds = new Set(run.tasks.map(task => task.id));
  const edges = [...new Set(run.tasks.flatMap(task => task.dependencies.filter(id => taskIds.has(id)).map(id => 'task:' + id + '->task:' + task.id)))].sort();
  assert.deepEqual(actual.edges, edges, 'Inline diagram must preserve the actual task dependencies');
  const research = byTime((run.deliveries ?? []).filter(delivery => ['research', 'progress'].includes(delivery.kind)));
  assert.deepEqual(actual.entries.filter(row => row.stage === 'research').slice(0, research.length).map(row => row.id), research.map(delivery => 'delivery:' + delivery.id));
  const implementation = byTime([...(run.deliveries ?? []).filter(delivery => ['proof', 'failure'].includes(delivery.kind))
    .map(delivery => ({ at: delivery.at, id: 'delivery:' + delivery.id })), ...(run.checks ?? []).map(check => ({ at: check.at, id: 'check:' + check.id }))]);
  assert.deepEqual(actual.entries.filter(row => row.stage === 'implementation').map(row => row.id), implementation.map(item => item.id), 'Candidates, failures, checks and later versions must share one chronological sequence');
  assert.deepEqual(actual.entries.filter(row => row.stage === 'review').map(row => row.id),
    byTime((run.deliveries ?? []).filter(delivery => delivery.kind === 'review')).map(delivery => 'delivery:' + delivery.id));
  const older = new Set(record.process!.runs.slice(0, record.process!.runs.indexOf(run)).flatMap(item => (item.deliveries ?? []).map(delivery => delivery.id)));
  for (const delivery of run.deliveries ?? []) {
    const row = actual.entries.find(row => row.id === 'delivery:' + delivery.id)!;
    const full = processMessage(delivery.summary, locale), note = workflowNote(delivery.id, locale);
    assert.equal(row.time, delivery.at);
    assert.equal(row.full ?? row.preview, full, delivery.id + ': complete saved prose must be readable');
    if (note) assert.equal(row.preview, note, 'Curated Chinese note must retain an accessible original');
    else if (full.length > 720) assert.equal(row.preview, full.slice(0, 720).trimEnd() + '…');
    else assert.equal(row.preview, full);
    assert.equal(row.retained, older.has(delivery.id) || !!run.startedAt && delivery.at < run.startedAt);
    assert.deepEqual(row.link, { run: run.runId, node: delivery.taskId ? 'task:' + delivery.taskId : delivery.kind === 'review' ? 'review' : 'problem', step: 'delivery:' + delivery.id });
  }
  for (const check of run.checks ?? []) {
    const row = actual.entries.find(row => row.id === 'check:' + check.id)!;
    assert.equal(row.time, check.at); assert.equal(row.retained, !!run.startedAt && check.at < run.startedAt);
    assert.deepEqual(row.link, { run: run.runId, node: check.scope === 'original' ? 'original' : check.taskId ? 'task:' + check.taskId : 'problem', step: 'check:' + check.id });
  }
  assert.deepEqual(await page.locator('.global-run-lane').evaluateAll(lanes => lanes.map(lane => lane.getAttribute('data-global-run-id'))),
    record.process!.runs.map(run => run.runId));
  assert.deepEqual(await page.locator('.global-run-lane[data-final="true"]').evaluateAll(lanes => lanes.map(lane => lane.getAttribute('data-global-run-id'))), [record.campaign!.runId]);
  const final = run.runId === record.campaign!.runId;
  assert.equal(await page.locator('.global-final-badge').count(), Number(final));
  assert.equal(await page.locator('[data-process-acceptance]').count(), Number(final));
  assert.equal(await page.locator('.process-roadmap button[data-process-node="acceptance"]').count(), Number(final));
  if (final) assert.deepEqual(await page.locator('[data-process-acceptance] .process-targets code').allTextContents(), record.campaign!.targets);
  await fits(page, record.id + '/' + run.runId);
  return { deliveries: run.deliveries?.length ?? 0, checks: run.checks?.length ?? 0, tasks: run.tasks.length,
    retained: actual.entries.filter(row => row.retained).length, proseCharacters: actual.entries.reduce((sum, row) => sum + row.preview.length, 0) };
}
async function shot(page: Page, filename: string) {
  await settled(page); await page.screenshot({ path: path.join(output, filename) }); screenshots.push(filename);
}
async function openCheck(page: Page, record: ArchiveRecord, run: Run, check: Check) {
  await entry(page, 'check:' + check.id).locator('.workflow-record-link').click();
  await page.locator('#process-step-detail').waitFor();
  assert.equal(hash(page).get('mode'), 'roadmap'); assert.equal(hash(page).get('run'), run.runId);
  assert.equal(hash(page).get('step'), 'check:' + check.id);
  assert.equal(hash(page).get('node'), check.scope === 'original' ? 'original' : 'task:' + check.taskId);
  assert.equal(await page.locator('.process-diagnostics pre').textContent(), check.diagnostics);
  assert.equal(await page.evaluate(() => document.activeElement?.matches('#process-step-detail, #process-map-inspector')), true);
  assert.equal(await page.locator('.process-map-task-records ' + attr('data-process-step', 'check:' + check.id)).getAttribute('aria-pressed'), 'true');
  await page.locator('[data-process-code="source"]').click();
  const source = record.process!.sources![check.sourceDigest!];
  assert.equal(await page.locator('.process-code:not(.process-diff) code').textContent(), source.code);
  assert.equal(digest(source.code), source.sha256);
  assert.ok((await page.locator('.process-code-digest').innerText()).includes(source.sha256));
}

try {
  browser = await startBrowser(service.server, port);
  for (const locale of ['zh', 'en'] as const) for (const width of [1440, 390, 320]) {
    const label = locale + ' ' + width + 'px'; current = label;
    const context = await browser.newContext({ viewport: { width, height: width < 700 ? 844 : 1000 }, reducedMotion: 'reduce' });
    await observe(context, label); const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000);
    try {
      await enter(page, triangle, locale);
      await page.evaluate(() => document.fonts.ready); await firstViewport(page, label, locale); await verifyAssets(page);
      const complete = await verifyWorkflow(page, triangle, finalRun(triangle), locale);
      assert.ok(complete.proseCharacters > 2_000, 'A complete complex workflow must expose actual research prose');
      await shot(page, 'workflow-' + locale + '-' + width + '-entry.png');
      mark(label + ': ordinary classics entry defaults to final research with a complete DAG, objectives and actual saved prose');
      const walkthrough = triangle.process!.walkthrough!;
      const outlineUrl = page.url();
      for (const index of [2, 0]) {
        const outline = page.locator('[data-proof-overview-stage="' + index + '"]');
        await outline.focus(); await outline.press('Enter');
        const id = walkthrough.stages[index].stepIds[0];
        await reading(page, walkthrough, id, locale);
        assert.equal(await page.locator(attr('data-proof-derivation', id) + ' h5').evaluate(element => element === document.activeElement), true);
        await visible(page, '#' + 'proof-derivation-' + id + ' h5', label + ': outline jump');
        assert.equal(page.url(), outlineUrl, 'The overview navigates within the same accepted proof and run');
      }
      const selectedStep = walkthrough.steps[2], followingStep = walkthrough.steps[3];
      const routeStep = page.locator('.proof-walkthrough-route ' + attr('data-global-scroll', 'proof-derivation-' + selectedStep.id));
      const panel = page.locator('.proof-route-panel'), compact = width <= 1100, beforeStep = page.url();
      assert.equal(await panel.evaluate(element => (element as HTMLDetailsElement).open), !compact,
        'The complete route starts open on desktop and collapsed on narrow screens');
      await openProofRoute(page); await shot(page, 'derivation-' + locale + '-' + width + '-route.png');
      const routeButtons = panel.locator('[data-proof-route-step]');
      await routeStep.focus(); await page.keyboard.press('End');
      assert.equal(await routeButtons.last().evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Home');
      assert.equal(await routeButtons.first().evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
      assert.equal(await routeStep.evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Enter');
      const derivation = page.locator(attr('data-proof-derivation', selectedStep.id));
      assert.equal(await derivation.locator('h5').evaluate(element => element === document.activeElement), true);
      await reading(page, walkthrough, selectedStep.id, locale);
      assert.equal(page.url(), beforeStep);
      assert.equal(await panel.evaluate(element => (element as HTMLDetailsElement).open), !compact);
      if (compact) {
        await openProofRoute(page); await routeStep.focus(); await page.keyboard.press('Escape'); await settled(page);
        assert.equal(await panel.evaluate(element => (element as HTMLDetailsElement).open), false);
        assert.equal(await panel.locator('summary').getAttribute('aria-expanded'), 'false');
        assert.equal(await panel.locator('summary').evaluate(element => element === document.activeElement), true,
          'Escape must dismiss the mobile diagram and return focus to its summary');
      }
      const dependency = selectedStep.dependsOn[0];
      assert.ok(dependency, 'The counting argument uses an earlier result');
      const dependencyButton = derivation.locator(attr('data-proof-dependency', dependency));
      await dependencyButton.focus(); await dependencyButton.press('Enter');
      assert.equal(await page.locator(attr('data-proof-derivation', dependency) + ' h5').evaluate(element => element === document.activeElement), true);
      await reading(page, walkthrough, dependency, locale);
      assert.equal(page.url(), beforeStep, 'Reading a prerequisite preserves the selected archived run');
      await page.locator(attr('data-proof-derivation', dependency) + ' ' + attr('data-proof-consumer', selectedStep.id)).press('Space');
      await reading(page, walkthrough, selectedStep.id, locale);
      const scrolledStep = walkthrough.steps[4];
      await page.locator(attr('data-proof-derivation', scrolledStep.id)).evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await reading(page, walkthrough, scrolledStep.id, locale);
      assert.equal(page.url(), beforeStep, 'Ordinary scrolling and result links preserve the selected archived run and URL');
      await page.locator(attr('data-proof-derivation', walkthrough.steps.at(-1)!.id)).evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await reading(page, walkthrough, walkthrough.steps.at(-1)!.id, locale);
      await openProofRoute(page);
      const lastNode = await routeButtons.last().evaluate(button => {
        const row = button.getBoundingClientRect(), map = button.closest('.proof-route-map')!.getBoundingClientRect();
        return { top: row.top, bottom: row.bottom, mapTop: map.top, mapBottom: map.bottom };
      });
      assert.ok(lastNode.top >= lastNode.mapTop - 1 && lastNode.bottom <= lastNode.mapBottom + 1,
        'The selected last step must remain visible in a scrolled route: ' + JSON.stringify(lastNode));
      await openProofRoute(page); await routeStep.click(); await reading(page, walkthrough, selectedStep.id, locale);
      assert.equal(await panel.evaluate(element => (element as HTMLDetailsElement).open), !compact,
        'Choosing a route node closes the mobile diagram');
      await shot(page, 'derivation-' + locale + '-' + width + '-reason.png');
      const explanation = derivation.locator('.proof-walkthrough-explanation');
      assert.equal(await explanation.evaluate(element => (element as HTMLDetailsElement).open), false);
      await explanation.locator('summary').focus(); await explanation.locator('summary').press('Enter');
      assert.equal(await explanation.evaluate(element => (element as HTMLDetailsElement).open), true);
      assert.equal(await explanation.locator('p').isVisible(), true);
      assert.equal(await derivation.locator('.proof-walkthrough-calculation').isVisible(), true,
        'The line-by-line calculations stay expanded independently of the supporting explanation');
      await explanation.locator('summary').press('Space');
      await derivation.locator('.proof-walkthrough-source > summary').focus();
      await derivation.locator('.proof-walkthrough-source > summary').press('Enter');
      assert.equal(await derivation.locator('.proof-walkthrough-source').getAttribute('open'), '');
      await fits(page, label + ': proof derivation and exact source excerpt');
      await shot(page, 'derivation-' + locale + '-' + width + '-source.png');
      await derivation.locator('.proof-walkthrough-next > button').click();
      assert.equal(await page.locator(attr('data-proof-derivation', followingStep.id) + ' h5').evaluate(element => element === document.activeElement), true);
      await reading(page, walkthrough, followingStep.id, locale);
      assert.equal(page.url(), beforeStep);
      await page.locator(attr('data-proof-derivation', followingStep.id) + ' .proof-walkthrough-source-open').click();
      await page.locator('.process-code:not(.process-diff) code').waitFor();
      assert.equal(hash(page).get('code'), 'source');
      assert.equal(await page.locator('.process-code:not(.process-diff) code').textContent(), triangle.process!.sources![walkthrough.proofSha256].code);
      assert.equal(hash(page).get('run'), walkthrough.runId);
      const checkedSourceLink = page.url(); await page.reload();
      await page.locator('.process-code:not(.process-diff) code').waitFor();
      assert.equal(page.url(), checkedSourceLink);
      assert.equal(await page.locator('.process-code:not(.process-diff) code').textContent(), triangle.process!.sources![walkthrough.proofSha256].code);
      await back(page, triangle, finalRun(triangle));
      await phase(page, 'research', 'global-findings');
      mark(label + ': exact derivations and source excerpts, real dependency arrows and result links, keyboard route selection, unobscured headings and scroll-synchronized reading positions work');
      for (const [name, id] of [['plan', 'global-plan'], ['research', 'global-findings'], ['implementation', 'global-implementation'], ['review', 'global-review']]) {
        await phase(page, name, id); await fits(page, label + ': ' + name);
        await shot(page, 'workflow-' + locale + '-' + width + '-' + name + '.png');
      }
      mark(label + ': keyboard phase navigation reveals all four workflow stages and moves focus to their headings');

      await phase(page, 'plan', 'global-plan');
      const objectives = page.locator('.workflow-task-objectives');
      const location = page.url(); await objectives.locator('summary').focus(); await objectives.locator('summary').press('Enter');
      assert.equal(await objectives.getAttribute('open'), ''); assert.equal(page.url(), location);
      const task = finalRun(triangle).tasks.find(task => task.status === 'integrated')!;
      const objective = objectives.locator(attr('data-workflow-task', task.id));
      assert.ok((await objective.locator('dd').textContent())!.includes(readableProcessText(task.objective, Number.MAX_SAFE_INTEGER)));
      await objective.locator('dt > button').press('Enter'); await page.locator('.process-map-inspector').waitFor();
      assert.equal(hash(page).get('mode'), 'roadmap'); assert.equal(hash(page).get('run'), triangle.campaign!.runId);
      assert.equal(hash(page).get('node'), 'task:' + task.id);
      await back(page, triangle, finalRun(triangle));

      const historical = triangle.process!.runs.find(run => run.runId !== triangle.campaign!.runId && run.tasks.length > 0)!;
      await chooseRun(page, triangle, historical, 'Space'); await verifyWorkflow(page, triangle, historical, locale);
      assert.equal(await page.locator('[data-process-acceptance]').count(), 0);
      const selectedLink = page.url(); await page.reload(); await global(page, triangle, historical);
      assert.equal(page.url(), selectedLink); await verifyWorkflow(page, triangle, historical, locale);
      await chooseRun(page, triangle, finalRun(triangle), 'Enter');
      mark(label + ': objectives expand natively, task links reach the exact node, and run selection retains URL, focus and refresh state');

      const noteDelivery = finalRun(triangle).deliveries!.find(delivery => workflowNote(delivery.id, 'zh'))!;
      const noteRow = entry(page, 'delivery:' + noteDelivery.id);
      const fullText = processMessage(noteDelivery.summary, locale);
      const raw = noteRow.locator('.workflow-full-text');
      assert.equal(await raw.count(), 1);
      const beforeExpansion = page.url(); await raw.locator('summary').focus(); await raw.locator('summary').press('Enter');
      assert.equal(await raw.getAttribute('open'), ''); assert.equal(page.url(), beforeExpansion);
      assert.equal(await raw.locator('.workflow-prose').textContent(), fullText);
      assert.equal(await raw.locator('.workflow-prose').isVisible(), true);
      if (locale === 'zh') assert.equal(await noteRow.locator(':scope > .workflow-prose').textContent(), workflowNote(noteDelivery.id, locale));
      await shot(page, 'workflow-' + locale + '-' + width + '-research-original.png');
      await noteRow.locator('.workflow-record-link').click(); await page.locator('#process-step-detail').waitFor();
      assert.equal(hash(page).get('run'), triangle.campaign!.runId); assert.equal(hash(page).get('step'), 'delivery:' + noteDelivery.id);
      assert.equal(hash(page).get('node'), 'task:' + noteDelivery.taskId);
      assert.equal(await page.evaluate(() => document.activeElement?.matches('#process-step-detail, #process-map-inspector')), true);
      await back(page, triangle, finalRun(triangle));
      mark(label + ': mathematical research body and complete original are readable, and its delivery opens the exact recorded step');

      await enter(page, failure.record, locale);
      if (failure.run.runId !== failure.record.campaign!.runId) await chooseRun(page, failure.record, failure.run);
      await verifyWorkflow(page, failure.record, failure.run, locale);
      assert.ok((await entry(page, 'check:' + failure.check.id).locator('.workflow-check-excerpt').textContent())!.length > 0);
      await openCheck(page, failure.record, failure.run, failure.check); await fits(page, label + ': failed-check source');
      await shot(page, 'workflow-' + locale + '-' + width + '-failure-source.png');
      await back(page, failure.record, failure.run);
      await enter(page, revision.record, locale);
      if (revision.run.runId !== revision.record.campaign!.runId) await chooseRun(page, revision.record, revision.run);
      assert.ok((await entry(page, 'check:' + revision.check.id).innerText()).includes(locale === 'en' ? 'Later source version' : '后续源码版本'));
      await openCheck(page, revision.record, revision.run, revision.check);
      await page.locator('[data-process-code="diff"]').click(); await page.locator('.process-diff').waitFor();
      assert.ok(await page.locator('.process-diff [data-diff="added"],.process-diff [data-diff="removed"]').count() > 0);
      assert.ok((await page.locator('.process-code-meta').innerText()).includes('+' + revision.comparison.added + ' / −' + revision.comparison.removed));
      assert.equal(hash(page).get('run'), revision.run.runId); assert.equal(hash(page).get('step'), 'check:' + revision.check.id);
      await fits(page, label + ': later-version diff'); await back(page, revision.record, revision.run);
      mark(label + ': failed-check links show exact diagnostics and checked bytes; later versions compare the real prior source');

      await enter(page, honeycomb, locale, true); await verifyWorkflow(page, honeycomb, finalRun(honeycomb), locale);
      await phase(page, 'review', 'global-review');
      await page.locator('[data-process-open-tab="source"]').click(); await page.locator('.source-code').waitFor();
      assert.equal(hash(page).get('tab'), 'source');
      await page.locator('#tab-process').click(); await global(page, honeycomb, finalRun(honeycomb));
      for (const record of catalog.records.filter(record => record.process!.walkthrough!.steps.some(step => step.figure))) {
        await enter(page, record, locale); await verifyProofFigure(page, record, locale, label);
      }
      mark(label + ': all three mathematical figures support real pointer or keyboard interaction, update exact objects and calculations, and preserve proof identity and focus');
      const overview = new URL(ordinary(locale)); overview.hash = new URLSearchParams({ proof: triangle.id, status: 'verified', tab: 'overview' }).toString();
      await page.goto(overview.href); await page.locator('#tab-overview[aria-selected="true"]').waitFor();
      assert.equal(await page.locator('.global-workflow').count(), 0);
      mark(label + ': the unique acceptance leads to the final proof, and explicit overview links remain valid');
      assert.deepEqual(errors, []);
    } catch (error) {
      await shot(page, 'failure-' + locale + '-' + width + '.png').catch(() => {}); throw error;
    } finally { await context.close(); active = undefined; }
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await observe(context, 'all archived runs'); const page = await context.newPage(); active = page;
  let runs = 0, deliveries = 0, savedChecks = 0, tasks = 0, retained = 0, proseCharacters = 0;
  for (const record of catalog.records) {
    await enter(page, record, 'zh');
    for (const run of record.process!.runs) {
      current = record.id + '/' + run.runId;
      await chooseRun(page, record, run);
      const result = await verifyWorkflow(page, record, run, 'zh');
      runs++; deliveries += result.deliveries; savedChecks += result.checks; tasks += result.tasks;
      retained += result.retained; proseCharacters += result.proseCharacters;
    }
  }
  assert.equal(runs, 45); assert.ok(deliveries > 400 && savedChecks > 300 && retained > 0);
  await context.close(); active = undefined;
  mark('all 16 problems and all ' + runs + ' saved runs preserve ' + deliveries + ' deliveries, ' + savedChecks
    + ' checks, full objectives, true DAGs, chronological stages, inherited markers and run-bound acceptance');

  for (const locale of ['zh', 'en'] as const) {
    const narrow = await browser.newContext({ viewport: { width: 320, height: 844 }, reducedMotion: 'reduce' });
    await observe(narrow, locale + ' all derivations at 320px');
    const narrowPage = await narrow.newPage(); active = narrowPage;
    try {
      for (const record of catalog.records) {
        current = locale + '/320/' + record.id;
        await enter(narrowPage, record, locale);
        await verifyWorkflow(narrowPage, record, finalRun(record), locale);
        await fits(narrowPage, current + ': every derivation line and prerequisite');
      }
      mark(locale + ': all 16 proof derivations, line-by-line explanations and dependencies fit a 320px screen');
    } finally { await narrow.close(); active = undefined; }
  }

  current = 'cache-enabled normal entry and run refresh';
  const cached = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await observe(cached, current, true); const cachedPage = await cached.newPage(); active = cachedPage;
  await enter(cachedPage, threeState, 'zh'); await verifyAssets(cachedPage);
  const history = threeState.process!.runs.find(run => run.runId !== threeState.campaign!.runId && run.tasks.length > 0)!;
  await chooseRun(cachedPage, threeState, history); await cachedPage.reload();
  await global(cachedPage, threeState, history); await verifyWorkflow(cachedPage, threeState, history, 'zh'); await verifyAssets(cachedPage);
  for (const file of ['site.js', 'process.css']) {
    const requests = cacheAssets.map(value => new URL(value)).filter(url => url.pathname.endsWith('/' + file));
    assert.ok(requests.length >= 2);
    assert.ok(requests.every(url => url.searchParams.get('v') === assetVersions[file]));
  }
  await cached.close(); active = undefined;
  mark('normal cache-enabled navigation and refresh keep the chosen run and use final content-versioned assets');
  assert.equal(runnerCalls, 0); assert.deepEqual(writes, []); assert.deepEqual(apiReads, []); assert.deepEqual(external, []); assert.deepEqual(errors, []);
  assert.ok(processAssetRequests.length >= 16);
  assert.ok(figureAssetRequests.length > 0);
  assert.ok(figureAssetRequests.every(value => new URL(value).searchParams.get('v') === figureAssetVersion),
    'Mathematical controls must load their separate script with its final content version');
  for (const value of processAssetRequests) {
    const url = new URL(value), id = url.pathname.split('/').at(-1)!.slice(0, -3);
    assert.equal(url.searchParams.get('v'), processAssetVersions[id], 'Lazy proof explanations must use the final process content version');
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(),
    checks, screenshots, viewportEvidence, records: catalog.records.length, runs, deliveries, savedChecks, tasks, retained, proseCharacters,
    derivationLines: catalog.records.reduce((sum, record) => sum + record.process!.walkthrough!.steps.reduce((count, step) => count + step.derivation.length, 0), 0),
    readingStages: catalog.records.reduce((sum, record) => sum + record.process!.walkthrough!.stages.length, 0),
    proofDependencies: catalog.records.reduce((sum, record) => sum + record.process!.walkthrough!.steps.reduce((count, step) => count + step.dependsOn.length, 0), 0),
    assetVersions, cacheAssets, processAssetVersions, processAssetRequests, figureAssetVersion, figureAssetRequests,
    paidModelCalls: false, runnerCalls, leanProcesses: 0, writes, apiReads, external, errors,
    failureExample: { record: failure.record.id, run: failure.run.runId, check: failure.check.id },
    revisionExample: { record: revision.record.id, run: revision.run.runId, before: revision.before.id, after: revision.check.id } }, null, 2) + '\n');
  console.log('Complete research workflows passed ' + checks.length + ' checks without models, Lean, mail or runtime writes.');
} catch (error) {
  await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', checkedAt: new Date().toISOString(), current,
    error: error instanceof Error ? error.message : String(error), checks, viewportEvidence, paidModelCalls: false,
    runnerCalls, writes, apiReads, external, errors }, null, 2) + '\n');
  throw error;
} finally {
  await browser?.close(); await service.close(); await fs.rm(data, { recursive: true, force: true });
}
