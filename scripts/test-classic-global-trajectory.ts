#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import { createWebService } from '../apps/web/server';
import { compareSources } from '../apps/web/client/sourceDiff';
import { proseSegments, type ProseSegment } from '../apps/web/client/explainText';
import { processMessage, readableProcessText } from '../docs/web/processText';
import type { ProofWalkthrough } from '../docs/web/proofWalkthroughTypes';
import type { ArchiveCatalog, ArchiveProcess, ArchiveRecord } from '../docs/web/types';
import { workflowNote } from '../docs/web/workflowNotes';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/classic-global-trajectory');
const staticRoot = path.join(root, 'out/web');
const catalog = JSON.parse(await fs.readFile(path.join(staticRoot, 'classics/data/catalog.json'), 'utf8')) as ArchiveCatalog;
// Keep the existing reviewed explanations as a fixed regression set. Universal imported-problem coverage lives in
// test-universal-solution-route.ts; adding a problem must not require adding a hand-authored walkthrough here.
const detailedRecords = catalog.records.filter(record => record.process?.walkthrough);
assert.equal(detailedRecords.length, 18, 'Retain all eighteen detailed proof explanations');
assert.equal(detailedRecords.reduce((sum, record) => sum + record.process!.walkthrough!.steps.length, 0), 110,
  'Retain all one hundred and ten reviewed derivation steps');
const figureCount = detailedRecords.reduce((sum, record) => sum + record.process!.walkthrough!.steps.filter(step => step.figure).length, 0);
assert.equal(figureCount, 8, 'The built archive must include all eight mathematical figures');
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
  const record = detailedRecords.find(record => record.id === id);
  assert.ok(record, 'Missing actual archived problem ' + id); return record;
};
const triangle = realRecord('openai_triangle_face');
const threeState = realRecord('openai_three_state_supercritical');
const honeycomb = realRecord('openai_honeycomb_free_energy');
const finalRun = (record: ArchiveRecord) => record.process!.runs.find(run => run.runId === record.campaign!.runId)!;
const all = detailedRecords.flatMap(record => record.process!.runs.map(run => ({ record, run })));
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
// MathML, its TeX annotation and the visual glyphs describe one formula; compare its retained source only once.
const proseTexts = (locator: Locator) => locator.evaluateAll(elements => elements.map(element => {
  const prose = element.cloneNode(true) as HTMLElement;
  for (const formula of prose.querySelectorAll<HTMLElement>('.math:not(.math-source)')) {
    const suffix = [...formula.querySelectorAll('.katex-html > .katex-base')].flatMap(base => [...base.childNodes])
      .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? '').join('');
    formula.replaceWith(document.createTextNode(formula.title + suffix));
  }
  return prose.textContent ?? '';
}));
const proseText = async (locator: Locator) => (await proseTexts(locator))[0];
const expectedProse = (text: string): string => {
  const segments = proseSegments(text);
  const math = (items: readonly ProseSegment[]): boolean => items.some(segment => segment.kind === 'math' || segment.kind === 'display' || segment.kind === 'code'
    || segment.kind === 'strong' && math(proseSegments(segment.text)));
  const content = (items: readonly ProseSegment[]): string => items.map(segment =>
    segment.kind === 'strong' ? content(proseSegments(segment.text)) : segment.text).join('');
  return math(segments) ? content(segments) : text;
};
const assetVersions = Object.fromEntries(await Promise.all(['site.js', 'process.css'].map(async file =>
  [file, digest(await fs.readFile(path.join(staticRoot, 'classics', file))).slice(0, 16)])));
const processAssetVersions = Object.fromEntries(await Promise.all(catalog.records.map(async record =>
  [record.id, digest(await fs.readFile(path.join(staticRoot, 'classics/data/process', record.id + '.js'))).slice(0, 16)])));
const processAssetRequests: string[] = [];
const figureAssetVersion = digest(await fs.readFile(path.join(staticRoot, 'classics/data/proof-figures.js'))).slice(0, 16);
const figureAssetRequests: string[] = [];
const solutionAssetVersion = digest(await fs.readFile(path.join(staticRoot, 'classics/data/solution-route.js'))).slice(0, 16);
const solutionAssetRequests: string[] = [];

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
    if (url.pathname.endsWith('/data/solution-route.js')) solutionAssetRequests.push(url.href);
    if (cacheEnabled && /\/(?:site\.js|process\.css|solution-route\.js)$/u.test(url.pathname)) cacheAssets.push(url.href);
  });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(label + ': ' + error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(label + ': ' + message.text()); });
    page.on('response', response => { if (response.status() >= 400) errors.push(label + ': ' + response.status() + ' ' + new URL(response.url()).pathname); });
  });
}
async function global(page: Page, record: ArchiveRecord, run = finalRun(record)) {
  await page.locator('.process-global-trajectory').waitFor(); await settled(page);
  await page.locator(attr('data-solution-route-record', record.id) + attr('data-solution-route-run', run.runId)
    + '[data-solution-route-state="ready"]').waitFor();
  await page.waitForFunction(() => !document.querySelector('#inspector .math[data-math-state="loading"]'));
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
  assert.equal(await page.locator('[data-solution-route-state]').count(), 0);
  assert.equal(await page.locator('.solution-route').count(), 0, 'The catalog must not mount a problem route before one is opened');
  assert.equal(await page.locator('[data-global-select][aria-pressed="true"], [data-solution-node][aria-pressed="true"]').count(), 0,
    'Loading shared prose typesetting must not select a problem run or route node');
  if (explicit) {
    await page.locator('.row-route-open' + attr('data-proof-route', record.id)).click();
  } else {
    await page.locator('.proof-row' + attr('data-proof-id', record.id)).click();
    await page.locator('[data-proof-solution=' + JSON.stringify(record.id) + ']').waitFor();
    assert.equal(hash(page).get('tab'), 'reading', 'Clicking a classic row opens proof explanation reading first');
    await page.locator('#tab-process').click();
  }
  await global(page, record);
}
async function openReading(page: Page, record: ArchiveRecord) {
  await page.locator('#tab-reading').click();
  await page.locator('[data-proof-solution=' + JSON.stringify(record.id) + ']').waitFor();
  await page.waitForFunction(() => !document.querySelector('#inspector .math[data-math-state="loading"]'));
  await settled(page);
  assert.equal(hash(page).get('proof'), record.id);
  assert.equal(hash(page).get('tab'), 'reading');
  assert.equal(await page.locator('#tab-reading').getAttribute('aria-selected'), 'true');
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
  await page.locator('[data-solution-route-state="ready"]').waitFor();
  assert.equal(await page.locator('.process-view-toolbar h4').innerText(), locale === 'en' ? 'Whole-problem trajectory' : '全局解题轨迹');
  const title = await visible(page, '.solution-route-heading h3', label);
  const selection = await visible(page, '.global-workflow-heading', label);
  const routeEntry = await visible(page, '[data-solution-mode="recorded"]', label);
  assert.equal(await page.locator('.solution-route').getAttribute('data-solution-route-basis'), 'explanation');
  assert.equal(await page.locator('.solution-route-overview').isVisible(), true, 'the mathematical context is visible by default');
  await page.locator('[data-solution-expand]').scrollIntoViewIfNeeded(); await settled(page);
  const expand = await visible(page, '[data-solution-expand]', label);
  assert.ok(title.top < title.height * 0.65, label + ': the shared solution route must appear in the first part of the viewport');
  viewportEvidence.push({ label, title, selection, routeEntry, expand });
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
  const walkthrough = record.process!.walkthrough!, steps = walkthrough.steps.filter(step => step.figure);
  assert.ok(steps.length > 0, record.id + ': actual accepted proof steps must own the figures');
  for (const step of steps) {
    const baseReadingHash = () => {
      const params = hash(page); params.delete('reading'); params.delete('readingSha'); return params.toString();
    };
    const expectedBase = baseReadingHash(), row = page.locator(attr('data-proof-derivation', step.id));
    const figure = row.locator(attr('data-proof-figure', step.figure!));
    const identity = async () => {
      assert.equal(baseReadingHash(), expectedBase, 'A mathematical illustration must retain the exact selected proof URL');
      const parameters = new URLSearchParams(new URL(page.url()).hash.slice(1));
      assert.equal(parameters.get('proof'), record.id);
      assert.equal(parameters.get('tab'), 'reading');
      assert.equal(await page.locator('[data-proof-solution]').getAttribute('data-proof-solution-run'), walkthrough.runId);
      assert.equal(await page.locator('[data-proof-walkthrough]').getAttribute('data-proof-sha'), walkthrough.proofSha256);
    };
    await identity();
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
    } else if (step.figure === 'snaky') {
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
    } else if (step.figure === 'convex-mass-section') {
      const input = figure.locator('input[data-convex-mu]'), reset = figure.locator('button[data-convex-reset]');
      const normalize = (value: string | null) => (value ?? '').replace(/\s/gu, '');
      const verifyMass = async (mu: number) => {
        const one = (1 - mu).toFixed(2), three = mu.toFixed(2), mass = (1 + 2 * mu).toFixed(2), excess = (2 * mu).toFixed(2);
        assert.equal(Number(await input.inputValue()), mu);
        assert.equal(await figure.getAttribute('data-convex-mu'), String(mu));
        assert.equal(await figure.getAttribute('data-convex-section'), String(mu === 0));
        assert.equal(await figure.locator('[data-convex-output]').textContent(), three);
        assert.equal(await input.getAttribute('aria-valuetext'), locale === 'en' ? 'Total mass-three weight ' + three : '质量三组总权重 ' + three);
        assert.equal(normalize(await figure.locator('[data-convex-one-weight]').textContent()), '1−μ=' + one);
        assert.equal(normalize(await figure.locator('[data-convex-three-weight]').textContent()), 'μ=' + three);
        assert.equal(normalize(await figure.locator('[data-convex-equation]').textContent()), 'L(y)=(1−μ)+3μ=' + one + '+3×' + three + '=' + mass);
        assert.equal(normalize(await figure.locator('[data-convex-excess]').textContent()), 'L(y)−1=2μ=' + excess + '≥0');
        const graphic = await figure.locator('[data-convex-picture]').evaluate(svg => ({
          one: Number(svg.querySelector('[data-convex-weight="one"]')!.getAttribute('width')),
          three: Number(svg.querySelector('[data-convex-weight="three"]')!.getAttribute('width')),
          mass: Number(svg.querySelector('[data-convex-mass-point]')!.getAttribute('cx')),
          excessStart: Number(svg.querySelector('[data-convex-excess-segment]')!.getAttribute('x1')),
          excessEnd: Number(svg.querySelector('[data-convex-excess-segment]')!.getAttribute('x2')),
          lower: Number(svg.querySelector('[data-convex-lower-bound]')!.getAttribute('x1')),
        }));
        assert.ok(Math.abs(graphic.one - 272 * (1 - mu)) < 0.00001 && Math.abs(graphic.three - 272 * mu) < 0.00001,
          'The SVG weight bars must represent the same grouped weights as the calculation');
        assert.ok(Math.abs(graphic.mass - (24 + 272 * mu)) < 0.00001 && Math.abs(graphic.excessEnd - graphic.mass) < 0.00001);
        assert.equal(graphic.excessStart, 24); assert.equal(graphic.lower, 24);
        if (mu === 0) assert.equal(normalize(await figure.locator('[data-convex-bridge]').textContent()), 'Q=R∩{L=1}=conv{f(1ₙ)}=f(P)',
          'The zero mass-three weight must expose the actual generator-to-f(P) bridge');
        else assert.equal(await figure.locator('.proof-figure-equation[data-convex-bridge]').count(), 0);
        await identity();
      };
      await verifyMass(0.25);
      for (const [key, mu] of [['Home', 0], ['ArrowRight', 0.01], ['End', 1]] as const) {
        await input.focus(); await input.press(key); await verifyMass(mu);
        assert.equal(await input.evaluate(node => node === document.activeElement), true, 'Native range keys must keep slider focus');
      }
      await reset.click(); await verifyMass(0);
      assert.equal(await reset.evaluate(node => node === document.activeElement), true, 'Pointer reset must retain the section control');
      const sliderBox = await input.boundingBox(); assert.ok(sliderBox);
      await input.click({ position: { x: sliderBox.width / 2, y: sliderBox.height / 2 } }); await verifyMass(0.5);
      assert.equal(await input.evaluate(node => node === document.activeElement), true);
      await reset.focus(); await reset.press('Space'); await verifyMass(0);
      assert.equal(await reset.evaluate(node => node === document.activeElement), true, 'Keyboard reset must keep focus while updating the section');
    } else if (step.figure === 'color-separation') {
      const radius = Math.sqrt(3) / 4;
      const verifySeparation = async (kind: 'shared' | 'distinct') => {
        const shared = kind === 'shared', upper = shared ? 2 * radius : 1 + 2 * radius;
        const lower = shared ? 1 : Math.sqrt(63) / 4, gap = lower - upper, scale = 266 / (shared ? 1.2 : 2.25);
        const button = figure.locator(attr('data-separation-case', kind));
        assert.equal(await figure.getAttribute('data-separation-current'), kind);
        assert.equal(await figure.locator('.proof-figure-controls [aria-pressed="true"]').count(), 1);
        assert.equal(await button.getAttribute('aria-pressed'), 'true');
        assert.equal(await button.evaluate(node => node === document.activeElement), true, 'Changing center cases preserves the activated control and focus');
        assert.equal(await figure.locator('[data-separation-upper]').textContent(), upper.toFixed(4));
        assert.equal(await figure.locator('[data-separation-lower]').textContent(), lower.toFixed(4));
        assert.equal(await figure.locator('[data-separation-gap]').textContent(), gap.toFixed(4) + ' > 0');
        assert.equal(await figure.locator('[data-separation-inequality]').textContent(), shared ? '1 = dist(x,y) ≤ 2r < 1'
          : 'dist(Cₓ,Cᵧ) ≥ 3√7/4 > 1+2rdist(Cₓ,Cᵧ) ≤ r+1+r = 1+2r');
        const graphic = await figure.locator('[data-separation-picture]').evaluate(svg => ({
          segments: [...svg.querySelectorAll('[data-segment]')].map(node => ({ kind: node.getAttribute('data-segment'),
            x: Number(node.getAttribute('x')), width: Number(node.getAttribute('width')), label: node.nextElementSibling!.textContent })),
          gapX: Number(svg.querySelector('.proof-distance-gap')!.getAttribute('x')),
          gapWidth: Number(svg.querySelector('.proof-distance-gap')!.getAttribute('width')),
          lowerX: Number(svg.querySelector('circle')!.getAttribute('cx')),
          guides: [...svg.querySelectorAll('.proof-distance-guide')].map(node => Number(node.getAttribute('x1'))),
        }));
        assert.deepEqual(graphic.segments.map(segment => segment.kind), shared ? ['cover', 'cover'] : ['cover', 'unit', 'cover']);
        assert.deepEqual(graphic.segments.map(segment => segment.label), shared ? ['≤r', '≤r'] : ['≤r', '1', '≤r']);
        let distance = 0;
        for (const [index, segment] of graphic.segments.entries()) {
          const length = !shared && index === 1 ? 1 : radius;
          assert.ok(Math.abs(segment.x - (24 + distance * scale)) < 0.00001 && Math.abs(segment.width - length * scale) < 0.00001,
            'The two or three visible route segments must match the covering/unit distance bounds');
          distance += length;
        }
        assert.ok(Math.abs(distance - upper) < 0.00001 && Math.abs(graphic.gapX - (24 + upper * scale)) < 0.00001);
        assert.ok(Math.abs(graphic.gapWidth - gap * scale) < 0.00001 && Math.abs(graphic.lowerX - (24 + lower * scale)) < 0.00001);
        assert.deepEqual(graphic.guides.map(value => Math.round(value * 100000)), [24 + upper * scale, 24 + lower * scale].map(value => Math.round(value * 100000)));
        await identity();
      };
      for (const kind of ['shared', 'distinct'] as const) {
        const button = figure.locator(attr('data-separation-case', kind));
        await button.focus(); await button.press(kind === 'shared' ? 'Enter' : 'Space'); await verifySeparation(kind);
        const premise = kind === 'shared' ? 'exclude-a-shared-center' : 'separate-equal-color-centers';
        assert.ok(walkthrough.steps.some(previous => previous.id === premise) && step.dependsOn.includes(premise),
          'The dynamic illustration reference must identify a real mathematical premise of this step');
        const reference = figure.locator('button.proof-figure-reference[data-global-scroll]');
        assert.equal(await reference.getAttribute('data-global-scroll'), 'proof-derivation-' + premise);
        if (kind === 'shared') { await reference.focus(); await reference.press('Enter'); } else await reference.click();
        await settled(page);
        const premiseRow = page.locator(attr('data-proof-derivation', premise)), heading = premiseRow.locator('header > h5');
        const jump = await heading.evaluate(node => { const box = node.getBoundingClientRect(); return {
          focused: node === document.activeElement, top: box.top, bottom: box.bottom, height: innerHeight,
        }; });
        assert.ok(jump.focused && jump.top >= 0 && jump.bottom <= jump.height,
          'A dynamically generated reference must scroll to and focus the real premise heading: ' + JSON.stringify(jump));
        await identity();
        const returnButton = premiseRow.locator('button' + attr('data-proof-consumer', step.id));
        await returnButton.click(); await settled(page);
        assert.equal(await row.locator('header > h5').evaluate(node => node === document.activeElement), true,
          'The premise’s actual consumer link returns to the illustrated proof step');
        await identity(); await figure.scrollIntoViewIfNeeded();
      }
      for (const kind of ['shared', 'distinct'] as const) {
        await figure.locator(attr('data-separation-case', kind)).click(); await verifySeparation(kind);
      }
    } else if (step.figure === 'snaky-fork') {
      // Independent expected coordinates from accepted mr_4/mr_6/mr_7 and entry_7's two shifts.
      const source4 = { a: ['-3,-1', '-2,-1', '-1,-1', '0,-1', '1,0'], h: ['-3,-1', '-2,-1', '-1,-1', '0,-1', '0,0', '1,0'] };
      const source6 = { a: ['-4,-1', '-3,-1', '-2,-1', '-1,-1', '-1,0'], h: ['-4,-1', '-3,-1', '-2,-1', '-1,-1', '-1,0', '0,0'] };
      const placed4 = { a: ['-4,-1', '-3,-1', '-2,-1', '-1,-1', '0,0'], h: ['-4,-1', '-3,-1', '-2,-1', '-1,-1', '-1,0', '0,0'] };
      const placed6 = { a: ['-3,-1', '-2,-1', '-1,-1', '0,-1', '0,0'], h: ['-3,-1', '-2,-1', '-1,-1', '0,-1', '0,0', '1,0'] };
      const union = ['-4,-1', '-3,-1', '-2,-1', '-1,-1', '0,-1', '0,0'], common = ['-3,-1', '-2,-1', '-1,-1', '0,0'];
      const parent = { a: ['-4,-1', '-3,-1', '-2,-1', '-1,-1', '0,-1'], h: ['-4,-1', '-3,-1', '-2,-1', '-1,-1', '-1,0', '0,-1', '0,0', '1,0'] };
      const cells = (value: string | null) => [...(value ?? '').matchAll(/\((-?\d+),\s*(-?\d+)\)/gu)].map(match => match[1] + ',' + match[2]).sort();
      const verifyFork = async (kind: 'child4' | 'child6' | 'combine' | 'fork') => {
        const expected = kind === 'child4' ? placed4 : kind === 'child6' ? placed6 : kind === 'combine' ? { a: union, h: parent.h } : parent;
        const button = figure.locator(attr('data-snaky-fork-stage', kind));
        assert.equal(await figure.getAttribute('data-snaky-fork-current'), kind);
        assert.equal(await figure.locator('.proof-figure-controls [aria-pressed="true"]').count(), 1);
        assert.equal(await button.getAttribute('aria-pressed'), 'true');
        assert.equal(await button.evaluate(node => node === document.activeElement), true, 'Fork layer changes preserve the original button and focus');
        const graphic = await figure.locator('[data-snaky-fork-cell]').evaluateAll(nodes => nodes.map(node => ({
          cell: node.getAttribute('data-snaky-fork-cell')!, required: node.getAttribute('data-snaky-fork-required') === 'true',
          common: node.getAttribute('data-snaky-fork-common') === 'true', removed: node.getAttribute('data-snaky-fork-removed') === 'true',
          x: Number(node.querySelector('rect')!.getAttribute('x')), y: Number(node.querySelector('rect')!.getAttribute('y')),
          label: node.querySelector('text')?.textContent, outlines: node.querySelectorAll('rect').length,
        })));
        assert.deepEqual(graphic.map(cell => cell.cell).sort(), expected.h.slice().sort());
        assert.deepEqual(graphic.filter(cell => cell.required).map(cell => cell.cell).sort(), expected.a.slice().sort());
        for (const cell of graphic) {
          const [x, y] = cell.cell.split(',').map(Number);
          assert.equal(cell.x, 150 + 24 * x - 10); assert.equal(cell.y, 112 - 24 * y - 10);
        }
        if (kind === 'combine') {
          assert.deepEqual(cells(await figure.locator('[data-snaky-fork-union-a]').textContent()), union.slice().sort());
          assert.deepEqual(cells(await figure.locator('[data-snaky-fork-common-h]').textContent()), common.slice().sort());
          assert.deepEqual(cells(await figure.locator('[data-snaky-fork-union-h]').textContent()), parent.h.slice().sort());
          assert.equal(graphic.filter(cell => cell.required).length, 6); assert.equal(graphic.filter(cell => cell.common).length, 4);
          assert.deepEqual(graphic.filter(cell => cell.common).map(cell => cell.cell).sort(), common.slice().sort());
          assert.ok(graphic.filter(cell => cell.common).every(cell => cell.outlines === 2 && cell.required), 'Common H already lies inside the six-cell union A');
          for (const [cell, label] of [['-4,-1', '4'], ['0,-1', '6'], ['-3,-1', '4+6'], ['-2,-1', '4+6'], ['-1,-1', '4+6']])
            assert.equal(graphic.find(item => item.cell === cell)!.label, label, 'The union layer must identify the actual contributing children');
          assert.ok((await figure.locator('[data-snaky-fork-readout]').textContent())!.includes('C⊆U ⇒ U∪C=U'));
        } else {
          assert.deepEqual(cells(await figure.locator('[data-snaky-fork-a]').textContent()), expected.a.slice().sort());
          assert.deepEqual(cells(await figure.locator('[data-snaky-fork-h]').textContent()), expected.h.slice().sort());
          assert.equal(await figure.locator('[data-snaky-fork-height]').textContent(), kind === 'child4' ? '1' : kind === 'child6' ? '2' : '3');
          const envelopeOnly = expected.h.filter(cell => !expected.a.includes(cell)).sort();
          assert.deepEqual(cells(await figure.locator('[data-snaky-fork-envelope-only]').textContent()), envelopeOnly);
          assert.deepEqual(graphic.filter(cell => !cell.required).map(cell => cell.cell).sort(), envelopeOnly);
          if (kind === 'fork') {
            assert.equal(graphic.filter(cell => cell.required).length, 5); assert.equal(graphic.length, 8);
            assert.deepEqual(envelopeOnly, ['-1,0', '0,0', '1,0']);
            assert.deepEqual(graphic.filter(cell => cell.removed).map(cell => cell.cell), ['0,0']);
            assert.equal(graphic.find(cell => cell.cell === '0,0')!.required, false);
            assert.equal(await figure.locator('[data-snaky-fork-added]').textContent(), '∅');
            assert.deepEqual(cells(await figure.locator('[data-snaky-fork-removed-a]').textContent()), ['0,0']);
            assert.ok((await figure.locator('[data-snaky-fork-readout]').textContent())!.includes('h₇=1+max(1,2)=3'));
          } else {
            const original = kind === 'child4' ? source4 : source6;
            assert.deepEqual(cells(await figure.locator('[data-snaky-fork-source-a]').textContent()), original.a.slice().sort());
            assert.deepEqual(cells(await figure.locator('[data-snaky-fork-source-h]').textContent()), original.h.slice().sort());
            assert.ok((await figure.locator('[data-snaky-fork-readout]').textContent())!.includes(kind === 'child4' ? 'P₄(x,y)=(x−1,y)' : 'P₆(x,y)=(x+1,y)'));
          }
        }
        await identity();
      };
      for (const kind of ['child4', 'child6', 'combine', 'fork'] as const) {
        const button = figure.locator(attr('data-snaky-fork-stage', kind));
        if (kind === 'combine') await button.click(); else { await button.focus(); await button.press(kind === 'child6' ? 'Space' : 'Enter'); }
        await verifyFork(kind);
        if (kind === 'child4' || kind === 'child6') {
          const details = figure.locator('[data-snaky-fork-readout] details'), summary = details.locator('summary');
          await summary.focus(); await summary.press('Enter');
          assert.equal(await details.getAttribute('open'), '');
          assert.equal(await figure.locator('[data-snaky-fork-source-a]').isVisible(), true);
          assert.equal(await figure.locator('[data-snaky-fork-source-h]').isVisible(), true);
          assert.equal(await summary.evaluate(node => node === document.activeElement), true);
          await summary.press('Enter'); await button.focus(); await identity();
        }
      }
      for (const kind of ['child4', 'fork'] as const) {
        await figure.locator(attr('data-snaky-fork-stage', kind)).click(); await verifyFork(kind);
      }
    } else if (step.figure === 'truffet-elimination') {
      const expected = [
        { kind: 'initial', state: 'initial', remaining: '{0, 1}', objective: 'c(w)=w₀', reference: 'write-the-concrete-system',
          rows: ['0 ≤ max(w₀,w₁)', 'max(1+w₁,−2) ≤ w₀'], points: [] },
        { kind: 'first', state: 'middle', remaining: '{0}', objective: 'c(w)=w₀', reference: 'force-the-first-elimination',
          rows: ['0 ≤ max(w₀,0)', 'max(1+0,−2)=1 ≤ w₀'], points: [] },
        { kind: 'second', state: 'finalState', remaining: '∅', objective: 'c(w)=1+w₂=1', reference: 'force-the-second-elimination',
          rows: ['0 ≤ max(1,0)=1', 'max(1+0,−2)=1 ≤ 1'], points: ['output'] },
        { kind: 'compare', state: 'finalState', remaining: '∅', objective: 'c(w)=1+w₂=1', reference: 'exhibit-the-better-point',
          rows: [], points: ['output', 'better'] },
      ] as const;
      const original = (w0: number, w1: number) => ({ row0: { rhs: 0, lhs: Math.max(w0, w1) },
        row1: { rhs: Math.max(1 + w1, -2), lhs: w0 }, cost: w0 });
      const verifyTruffet = async (kind: typeof expected[number]['kind']) => {
        const item = expected.find(item => item.kind === kind)!, button = figure.locator(attr('data-truffet-stage', kind));
        assert.equal(await figure.getAttribute('data-truffet-current'), kind);
        assert.equal(await figure.getAttribute('data-truffet-state'), item.state);
        assert.equal(await figure.locator('[data-truffet-remaining]').textContent(), item.remaining,
          'The normalized third coordinate must never become a remaining elimination variable');
        assert.equal(await figure.locator('[data-truffet-objective]').textContent(), item.objective);
        assert.equal(await figure.locator('.proof-figure-controls [aria-pressed="true"]').count(), 1);
        assert.equal(await button.getAttribute('aria-pressed'), 'true');
        assert.equal(await button.evaluate(node => node === document.activeElement), true,
          'Real elimination controls must preserve focus while updating the saved state');
        assert.equal(await figure.locator('[data-truffet-region]').getAttribute('points'), '52,214 116,214 276,54 52,54',
          'All stages must retain the original feasible region w₀≥max(0,1+w₁)');
        assert.equal(await figure.locator('[data-truffet-boundary]').getAttribute('points'), '52,214 116,214 276,54');
        assert.deepEqual(await figure.locator('[data-truffet-row]').allTextContents(), [...item.rows]);
        assert.equal(await figure.locator('[data-truffet-first-line]').count(), Number(kind !== 'initial'));
        assert.equal(await figure.locator('[data-truffet-first-feasible]').count(), Number(kind !== 'initial'));
        if (kind !== 'initial') {
          const line = await figure.locator('[data-truffet-first-line]').evaluate(node => ['x1', 'x2', 'y1', 'y2'].map(name => Number(node.getAttribute(name))));
          const ray = await figure.locator('[data-truffet-first-feasible]').evaluate(node => ['x1', 'x2', 'y1', 'y2'].map(name => Number(node.getAttribute(name))));
          assert.deepEqual(line, [180, 180, 54, 246]); assert.deepEqual(ray, [180, 180, 54, 150],
            'The saved choice w₁=0 lifts middle to the feasible ray w₀≥1, rather than changing the original system');
        }
        const points = await figure.locator('[data-truffet-point]').evaluateAll(nodes => nodes.map(node => ({
          name: node.getAttribute('data-truffet-point'), w0: Number(node.getAttribute('data-w0')), w1: Number(node.getAttribute('data-w1')),
          x: Number(node.getAttribute('cx')), y: Number(node.getAttribute('cy')), cost: Number(node.getAttribute('data-cost')),
        })));
        assert.deepEqual(points.map(point => point.name), [...item.points]);
        for (const point of points) {
          const coordinates = point.name === 'output' ? [1, 0] : [0, -1];
          assert.deepEqual([point.w0, point.w1], coordinates);
          const values = original(point.w0, point.w1);
          assert.ok(values.row0.rhs <= values.row0.lhs && values.row1.rhs <= values.row1.lhs,
            'Both plotted witnesses must satisfy both original max constraints');
          assert.equal(point.cost, values.cost);
          assert.equal(point.x, 180 + 64 * point.w1); assert.equal(point.y, 214 - 64 * point.w0);
        }
        if (kind === 'first') assert.equal(await figure.locator('[data-truffet-substitution]').textContent(), 'w₁=w₂=0');
        if (kind === 'second') {
          assert.equal(await figure.locator('[data-truffet-substitution]').textContent(), 'w₀=1+w₂=1');
          assert.ok((await figure.locator('[data-truffet-readout]').textContent())!.includes('⊥≤⊥'),
            'stop must be explained by the null rows’ reference columns');
        }
        if (kind === 'compare') {
          assert.deepEqual(original(1, 0), { row0: { rhs: 0, lhs: 1 }, row1: { rhs: 1, lhs: 1 }, cost: 1 });
          assert.deepEqual(original(0, -1), { row0: { rhs: 0, lhs: 0 }, row1: { rhs: 0, lhs: 0 }, cost: 0 });
          assert.equal(await figure.locator('[data-truffet-output]').textContent(), '(1,0,0)');
          assert.equal(await figure.locator('[data-truffet-better]').textContent(), '(0,−1,0)');
          assert.deepEqual(await figure.locator('[data-truffet-output-row]').allTextContents(), ['0 ≤ max(1,0)=1', 'max(1+0,−2)=1 ≤ 1']);
          assert.deepEqual(await figure.locator('[data-truffet-better-row]').allTextContents(), ['0 ≤ max(0,−1)=0', 'max(1−1,−2)=0 ≤ 0']);
          assert.equal(await figure.locator('[data-truffet-output-cost]').textContent(), '1');
          assert.equal(await figure.locator('[data-truffet-better-cost]').textContent(), '0');
          assert.equal(await figure.locator('[data-truffet-cost-gap]').textContent(), '1');
        }
        const labels = await figure.locator('[data-truffet-board]').evaluate(svg => {
          const box = svg.getBoundingClientRect();
          return [...svg.querySelectorAll('text')].map(node => {
            const text = node.getBoundingClientRect();
            return { value: node.textContent, fits: text.left >= box.left - 1 && text.right <= box.right + 1 };
          });
        });
        assert.ok(labels.every(label => label.fits), 'All plot labels must fit the SVG at the current viewport: ' + JSON.stringify(labels));
        await identity();
      };
      for (const item of expected) {
        const button = figure.locator(attr('data-truffet-stage', item.kind));
        if (item.kind === 'second') await button.click(); else { await button.focus(); await button.press(item.kind === 'first' ? 'Space' : 'Enter'); }
        await verifyTruffet(item.kind);
        assert.ok(walkthrough.steps.some(previous => previous.id === item.reference), 'The stage reference must name an actual proof step');
        const reference = figure.locator('button.proof-figure-reference[data-global-scroll]');
        assert.equal(await reference.getAttribute('data-global-scroll'), 'proof-derivation-' + item.reference);
        if (item.kind === 'compare') await reference.click(); else { await reference.focus(); await reference.press('Enter'); }
        await settled(page);
        assert.equal(await page.locator(attr('data-proof-derivation', item.reference) + ' header > h5').evaluate(node => node === document.activeElement), true,
          'The dynamically rendered stage reference must focus its real mathematical heading');
        await identity();
        if (item.reference !== step.id) {
          const route = page.locator('.proof-route-panel');
          if (!await route.evaluate(node => (node as HTMLDetailsElement).open)) await route.locator('summary').click();
          await route.locator('button' + attr('data-proof-route-step', step.id)).click(); await settled(page);
          assert.equal(await row.locator('header > h5').evaluate(node => node === document.activeElement), true);
          await identity();
        }
        await figure.scrollIntoViewIfNeeded();
      }
      for (const kind of ['initial', 'compare'] as const) {
        await figure.locator(attr('data-truffet-stage', kind)).click(); await verifyTruffet(kind);
      }
    } else if (step.figure === 'hadamard-fiber') {
      const changeStage = async (kind: 'unit' | 'select' | 'sum') => {
        const button = figure.locator(attr('data-fiber-stage', kind));
        await button.focus(); await button.press(kind === 'select' ? 'Space' : 'Enter');
        assert.equal(await button.evaluate(node => node === document.activeElement), true);
        assert.equal(await figure.getAttribute('data-fiber-current'), kind);
        assert.equal(await figure.locator('[data-fiber-stage][aria-pressed="true"]').count(), 1);
        assert.equal(await button.getAttribute('aria-pressed'), 'true');
        assert.equal(await figure.locator('[data-fiber-cases]').isVisible(), kind !== 'sum');
        await identity();
      };
      for (const kind of ['unit', 'select'] as const) {
        await changeStage(kind);
        for (const branch of ['a', 'b'] as const) {
          const button = figure.locator(attr('data-fiber-branch', branch));
          await button.focus(); await button.press(branch === 'a' ? 'Enter' : 'Space');
          assert.equal(await button.evaluate(node => node === document.activeElement), true);
          assert.equal(await figure.getAttribute('data-fiber-case'), branch);
          assert.equal(await figure.locator('[data-fiber-branch][aria-pressed="true"]').count(), 1);
          assert.equal(await figure.locator('[data-fiber-lane][data-active="true"]').getAttribute('data-fiber-lane'), branch);
          const actual = (await figure.locator('[data-fiber-local]').textContent())!.replace(/\s/gu, '');
          if (kind === 'unit') assert.equal(actual, 'v³=' + branch + '⇒' + branch + '·conj(v)²=v');
          else {
            assert.equal(await figure.locator('[data-fiber-selected]').textContent(), 'F(v) = ' + (branch === 'a' ? '(a−b)v' : '0'));
            assert.ok(actual.includes(branch === 'a' ? '=av−b(a·conj(v)²)=av−bv=(a−b)v' : 'F(v)=a(v−v)=0'));
          }
          await fits(page, label + ': fiber ' + kind + '/' + branch); await identity();
        }
      }
      await changeStage('sum');
      assert.deepEqual(await figure.locator('[data-fiber-total] > li').allTextContents(), [
        '(a−b)Sₐ = Σₖ F(vₖ)', '= aΣₖvₖ − abΣₖconj(vₖ)²', '= a·0 − ab·0 = 0', 'a−b≠0 ⇒ Sₐ=0',
      ]);
      for (const premise of ['derive-the-first-moment', 'derive-the-second-moment']) {
        await figure.locator('button' + attr('data-global-scroll', 'proof-derivation-' + premise)).click(); await settled(page);
        const premiseRow = page.locator(attr('data-proof-derivation', premise));
        assert.equal(await premiseRow.locator('header > h5').evaluate(node => node === document.activeElement), true);
        await premiseRow.locator('button' + attr('data-proof-consumer', 'sum-and-cancel')).click(); await settled(page);
        const sum = page.locator('[data-proof-derivation="sum-and-cancel"]');
        assert.equal(await sum.locator('header > h5').evaluate(node => node === document.activeElement), true);
        await sum.locator('button' + attr('data-proof-dependency', step.id)).click(); await settled(page);
        assert.equal(await row.locator('header > h5').evaluate(node => node === document.activeElement), true);
        await identity();
      }
      await figure.locator('[data-fiber-stage="select"]').click();
      await figure.locator('[data-fiber-branch="a"]').click();
      assert.equal(await figure.locator('[data-fiber-selected]').textContent(), 'F(v) = (a−b)v');
      await figure.locator('[data-fiber-stage="sum"]').click();
    } else {
      assert.fail('No browser interaction check for ' + step.figure);
    }
    await identity();
    assert.equal(await page.locator(attr('data-proof-derivation', step.id) + ' .proof-walkthrough-calculation').isVisible(), true);
    await fits(page, label + ': ' + step.figure);
    await figure.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
    // Place the figure below both sticky reading controls for a readable screenshot.
    await page.evaluate(() => scrollBy(0, -200));
    await shot(page, 'figure-' + locale + '-' + page.viewportSize()!.width + '-' + step.figure + '.png');
  }
}
async function verifyAssets(page: Page) {
  const urls = await page.locator('script[src],link[rel="stylesheet"][href]').evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('src') ?? node.getAttribute('href')!));
  for (const file of ['site.js', 'process.css']) {
    const url = urls.map(value => new URL(value, page.url())).find(url => url.pathname.endsWith('/' + file));
    assert.ok(url, 'The page must load ' + file);
    assert.equal(url.searchParams.get('v'), assetVersions[file], file + ' must use its final content hash');
  }
  const routes = await page.evaluate(() => performance.getEntriesByType('resource').map(resource => resource.name)
    .filter(value => new URL(value).pathname.endsWith('/data/solution-route.js')));
  assert.equal(routes.length, 1, 'Opening and switching saved runs must reuse one lazy route renderer per page');
  assert.equal(new URL(routes[0]!).searchParams.get('v'), solutionAssetVersion,
    'The lazy route renderer must use its final content hash');
}
async function verifyWorkflow(page: Page, record: ArchiveRecord, run: Run, locale: 'zh' | 'en') {
  await global(page, record, run);
  const actual = await page.locator('.global-workflow').evaluate(element => {
    const workflow = element.cloneNode(true) as HTMLElement;
    for (const formula of workflow.querySelectorAll<HTMLElement>('.math:not(.math-source)')) {
      const suffix = [...formula.querySelectorAll('.katex-html > .katex-base')].flatMap(base => [...base.childNodes])
        .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? '').join('');
      formula.replaceWith(document.createTextNode(formula.title + suffix));
    }
    return {
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
    };
  });
  const walkthrough = record.process?.walkthrough?.runId === run.runId ? record.process.walkthrough : undefined;
  assert.deepEqual(actual.stages, walkthrough ? ['research', 'plan', 'implementation', 'review'] : ['plan', 'research', 'implementation', 'review']);
  assert.equal(await page.locator('[data-proof-walkthrough]').count(), 0, 'De-duplicated process tab uses a compact digest instead of repeating the full derivation');
  assert.equal(await page.locator('[data-proof-walkthrough-digest]').count(), Number(Boolean(walkthrough)));
  if (walkthrough) {
    const digestCard = page.locator('[data-proof-walkthrough-digest]');
    assert.equal(await digestCard.getAttribute('data-proof-sha'), record.campaign!.proofSha256);
    assert.equal(await proseText(digestCard.locator('.proof-walkthrough-strategy')), expectedProse(walkthrough.strategy[locale]));
    assert.deepEqual(await digestCard.locator('[data-proof-overview-stage]').evaluateAll(buttons => buttons.map(button => ({
      steps: (button as HTMLElement).dataset.proofOverviewSteps!.split(' '),
      target: (button as HTMLElement).dataset.openReadingStep,
    }))), walkthrough.stages.map(stage => ({ steps: stage.stepIds, target: 'proof-derivation-' + stage.stepIds[0] })));
    assert.deepEqual(await proseTexts(digestCard.locator('[data-proof-overview-stage] strong')),
      walkthrough.stages.map(stage => expectedProse(stage.title[locale])));
    assert.deepEqual(await proseTexts(digestCard.locator('[data-proof-overview-stage] .proof-overview-copy > span')),
      walkthrough.stages.map(stage => expectedProse(stage.summary[locale])));
  }
  const expectedPlan = run.events.flatMap((event, index) => event.kind === 'plan-edit' && event.message?.trim() ? ['event:' + index] : []);
  const expected = [...expectedPlan, ...(run.deliveries ?? []).map(delivery => 'delivery:' + delivery.id), ...(run.checks ?? []).map(check => 'check:' + check.id)].sort();
  assert.deepEqual(actual.entries.map(row => row.id).sort(), expected, record.id + ': every actual delivery and check appears exactly once');
  assert.equal(new Set(actual.entries.map(row => row.id)).size, actual.entries.length, 'No repeated or synthesized workflow entries');
  assert.deepEqual(actual.objectives, run.tasks.map(task => ({ id: task.id, objective: expectedProse(readableProcessText(task.objective, Number.MAX_SAFE_INTEGER)) })), 'All complete task objectives must remain available');
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
    assert.equal(row.full ?? row.preview, expectedProse(full), delivery.id + ': complete saved prose must be readable');
    if (note) assert.equal(row.preview, expectedProse(note), 'Curated Chinese note must retain an accessible original');
    else if (full.length > 720) assert.equal(row.preview, expectedProse(full.slice(0, 720).trimEnd() + '…'));
    else assert.equal(row.preview, expectedProse(full));
    assert.equal(row.retained, older.has(delivery.id) || !!run.startedAt && delivery.at < run.startedAt);
    assert.deepEqual(row.link, { run: run.runId, node: taskIds.has(delivery.taskId ?? '') ? 'task:' + delivery.taskId : delivery.kind === 'review' ? 'review' : 'problem', step: 'delivery:' + delivery.id });
  }
  for (const check of run.checks ?? []) {
    const row = actual.entries.find(row => row.id === 'check:' + check.id)!;
    assert.equal(row.time, check.at); assert.equal(row.retained, !!run.startedAt && check.at < run.startedAt);
    assert.deepEqual(row.link, { run: run.runId, node: check.scope === 'original' ? 'original' : taskIds.has(check.taskId ?? '') ? 'task:' + check.taskId : 'problem', step: 'check:' + check.id });
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
async function verifyReadingWalkthrough(page: Page, record: ArchiveRecord, walkthrough: ProofWalkthrough, locale: 'zh' | 'en') {
  assert.equal(await page.locator('[data-proof-walkthrough]').getAttribute('data-proof-sha'), record.campaign!.proofSha256);
  assert.equal(await page.locator('[data-proof-derivation]').count(), walkthrough.steps.length);
  assert.equal(await proseText(page.locator('.proof-walkthrough-strategy')), expectedProse(walkthrough.strategy[locale]));
  assert.deepEqual(await page.locator('[data-proof-overview-stage]').evaluateAll(buttons => buttons.map(button => ({
    steps: (button as HTMLElement).dataset.proofOverviewSteps!.split(' '),
    target: (button as HTMLElement).dataset.globalScroll,
  }))), walkthrough.stages.map(stage => ({ steps: stage.stepIds, target: 'proof-derivation-' + stage.stepIds[0] })));
  assert.deepEqual(await proseTexts(page.locator('[data-proof-overview-stage] strong')),
    walkthrough.stages.map(stage => expectedProse(stage.title[locale])));
  assert.deepEqual(await proseTexts(page.locator('[data-proof-overview-stage] .proof-overview-copy > span')),
    walkthrough.stages.map(stage => expectedProse(stage.summary[locale])));
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
    assert.equal(await proseText(row.locator('.proof-walkthrough-claim > p')), expectedProse(step.claim[locale]));
    assert.equal(await proseText(row.locator('.proof-walkthrough-explanation > p')), expectedProse(step.because[locale]));
    assert.equal(await proseText(row.locator('.proof-walkthrough-next > p')), expectedProse(step.next[locale]));
    assert.deepEqual(await proseTexts(row.locator('.proof-walkthrough-statement')), step.derivation.map(line => expectedProse(line.statement[locale])));
    assert.deepEqual(await proseTexts(row.locator('.proof-walkthrough-justification')), step.derivation.map(line => expectedProse(line.reason[locale])));
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
      await openReading(page, triangle);
      await verifyReadingWalkthrough(page, triangle, walkthrough, locale);
      const readingBaseHash = () => {
        const params = hash(page); params.delete('reading'); params.delete('readingSha'); return params.toString();
      };
      const baseReadingParams = readingBaseHash();
      for (const index of [2, 0]) {
        const outline = page.locator('[data-proof-overview-stage="' + index + '"]');
        await outline.focus(); await outline.press('Enter');
        const id = walkthrough.stages[index].stepIds[0];
        await reading(page, walkthrough, id, locale);
        assert.equal(await page.locator(attr('data-proof-derivation', id) + ' h5').evaluate(element => element === document.activeElement), true);
        await visible(page, '#' + 'proof-derivation-' + id + ' h5', label + ': outline jump');
        assert.equal(readingBaseHash(), baseReadingParams, 'The overview navigates within the same accepted proof');
      }
      const selectedStep = walkthrough.steps[2], followingStep = walkthrough.steps[3];
      const routeStep = page.locator('.proof-walkthrough-route ' + attr('data-global-scroll', 'proof-derivation-' + selectedStep.id));
      const panel = page.locator('.proof-route-panel'), compact = width <= 1100;
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
      assert.equal(readingBaseHash(), baseReadingParams);
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
      assert.equal(readingBaseHash(), baseReadingParams, 'Reading a prerequisite preserves the selected proof');
      await page.locator(attr('data-proof-derivation', dependency) + ' ' + attr('data-proof-consumer', selectedStep.id)).press('Space');
      await reading(page, walkthrough, selectedStep.id, locale);
      const scrolledStep = walkthrough.steps[4];
      await page.locator(attr('data-proof-derivation', scrolledStep.id)).evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await reading(page, walkthrough, scrolledStep.id, locale);
      assert.equal(readingBaseHash(), baseReadingParams, 'Ordinary scrolling and result links preserve the selected proof');
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
      assert.equal(readingBaseHash(), baseReadingParams);
      const followingEvidence = page.locator(attr('data-proof-derivation', followingStep.id) + ' .proof-walkthrough-source');
      await followingEvidence.locator(':scope > summary').click();
      await followingEvidence.locator('.proof-walkthrough-source-open').click();
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
      assert.ok((await proseText(objective.locator('dd'))).includes(expectedProse(readableProcessText(task.objective, Number.MAX_SAFE_INTEGER))));
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
      assert.equal(await proseText(raw.locator('.workflow-prose')), expectedProse(fullText));
      assert.equal(await raw.locator('.workflow-prose').isVisible(), true);
      if (locale === 'zh') assert.equal(await proseText(noteRow.locator(':scope > .workflow-prose')), expectedProse(workflowNote(noteDelivery.id, locale)!));
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
      for (const record of detailedRecords.filter(record => record.process!.walkthrough!.steps.some(step => step.figure))) {
        await enter(page, record, locale); await openReading(page, record); await verifyProofFigure(page, record, locale, label);
      }
      mark(label + ': all eight mathematical figures support real pointer or keyboard interaction, update exact objects and calculations, and preserve proof identity and focus');
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
  for (const record of detailedRecords) {
    await enter(page, record, 'zh');
    for (const run of record.process!.runs) {
      current = record.id + '/' + run.runId;
      await chooseRun(page, record, run);
      const result = await verifyWorkflow(page, record, run, 'zh');
      runs++; deliveries += result.deliveries; savedChecks += result.checks; tasks += result.tasks;
      retained += result.retained; proseCharacters += result.proseCharacters;
    }
  }
  const expectedTotalRuns = detailedRecords.reduce((sum, record) => sum + record.process!.runs.length, 0);
  assert.equal(runs, expectedTotalRuns); assert.ok(deliveries > 400 && savedChecks > 300 && retained > 0);
  await context.close(); active = undefined;
  mark('the 18 detailed explanations and their ' + runs + ' saved runs preserve ' + deliveries + ' deliveries, ' + savedChecks
    + ' checks, full objectives, true DAGs, chronological stages, inherited markers and run-bound acceptance');

  for (const locale of ['zh', 'en'] as const) {
    const narrow = await browser.newContext({ viewport: { width: 320, height: 844 }, reducedMotion: 'reduce' });
    await observe(narrow, locale + ' all derivations at 320px');
    const narrowPage = await narrow.newPage(); active = narrowPage;
    try {
      for (const record of detailedRecords) {
        current = locale + '/320/' + record.id;
        await enter(narrowPage, record, locale);
        await verifyWorkflow(narrowPage, record, finalRun(record), locale);
        await openReading(narrowPage, record);
        await verifyReadingWalkthrough(narrowPage, record, record.process!.walkthrough!, locale);
        await fits(narrowPage, current + ': every derivation line and prerequisite');
      }
      mark(locale + ': all 18 proof derivations, line-by-line explanations and dependencies fit a 320px screen');
    } finally { await narrow.close(); active = undefined; }
  }

  current = 'cache-enabled normal entry and run refresh';
  const cached = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await observe(cached, current, true); const cachedPage = await cached.newPage(); active = cachedPage;
  await enter(cachedPage, threeState, 'zh'); await verifyAssets(cachedPage);
  const history = threeState.process!.runs.find(run => run.runId !== threeState.campaign!.runId && run.tasks.length > 0)!;
  await chooseRun(cachedPage, threeState, history); await verifyAssets(cachedPage); await cachedPage.reload();
  await global(cachedPage, threeState, history); await verifyWorkflow(cachedPage, threeState, history, 'zh'); await verifyAssets(cachedPage);
  for (const file of ['site.js', 'process.css']) {
    const requests = cacheAssets.map(value => new URL(value)).filter(url => url.pathname.endsWith('/' + file));
    assert.ok(requests.length >= 2);
    assert.ok(requests.every(url => url.searchParams.get('v') === assetVersions[file]));
  }
  const cachedRoutes = cacheAssets.map(value => new URL(value)).filter(url => url.pathname.endsWith('/data/solution-route.js'));
  assert.equal(cachedRoutes.length, 2, 'Each document loads the lazy route renderer once, including a normal cached refresh');
  assert.ok(cachedRoutes.every(url => url.searchParams.get('v') === solutionAssetVersion));
  await cached.close(); active = undefined;
  mark('normal cache-enabled navigation and refresh keep the chosen run and use final content-versioned assets');
  assert.equal(runnerCalls, 0); assert.deepEqual(writes, []); assert.deepEqual(apiReads, []); assert.deepEqual(external, []); assert.deepEqual(errors, []);
  assert.ok(processAssetRequests.length >= 16);
  assert.ok(figureAssetRequests.length > 0);
  assert.ok(figureAssetRequests.every(value => new URL(value).searchParams.get('v') === figureAssetVersion),
    'Mathematical controls must load their separate script with its final content version');
  assert.ok(solutionAssetRequests.length > 0);
  assert.ok(solutionAssetRequests.every(value => new URL(value).searchParams.get('v') === solutionAssetVersion),
    'All lazy route loads must use the final renderer content version');
  for (const value of processAssetRequests) {
    const url = new URL(value), id = url.pathname.split('/').at(-1)!.slice(0, -3);
    assert.equal(url.searchParams.get('v'), processAssetVersions[id], 'Lazy proof explanations must use the final process content version');
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(),
    checks, screenshots, viewportEvidence, catalogRecords: catalog.records.length, detailedExplanationRecords: detailedRecords.length,
    figureCount, runs, deliveries, savedChecks, tasks, retained, proseCharacters,
    derivationLines: detailedRecords.reduce((sum, record) => sum + record.process!.walkthrough!.steps.reduce((count, step) => count + step.derivation.length, 0), 0),
    readingStages: detailedRecords.reduce((sum, record) => sum + record.process!.walkthrough!.stages.length, 0),
    proofDependencies: detailedRecords.reduce((sum, record) => sum + record.process!.walkthrough!.steps.reduce((count, step) => count + step.dependsOn.length, 0), 0),
    assetVersions, cacheAssets, processAssetVersions, processAssetRequests, figureAssetVersion, figureAssetRequests, solutionAssetVersion, solutionAssetRequests,
    paidModelCalls: false, runnerCalls, leanProcesses: 0, writes, apiReads, external, errors,
    failureExample: { record: failure.record.id, run: failure.run.runId, check: failure.check.id },
    revisionExample: { record: revision.record.id, run: revision.run.runId, before: revision.before.id, after: revision.check.id } }, null, 2) + '\n');
  console.log('Complete research workflows passed ' + checks.length + ' checks without models, Lean, mail or runtime writes.');
} catch (error) {
  await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', checkedAt: new Date().toISOString(), current,
    error: error instanceof Error ? error.message : String(error), checks, viewportEvidence, figureCount, paidModelCalls: false,
    runnerCalls, writes, apiReads, external, errors }, null, 2) + '\n');
  throw error;
} finally {
  await browser?.close(); await service.close(); await fs.rm(data, { recursive: true, force: true });
}
