#!/usr/bin/env bun
// Disposable localhost service and recorded evidence only; no models, Lean, mail or production data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Download, Page, Route } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebRun } from '../apps/web/shared';
import type { ResearchBrief } from '../apps/web/researchWorkspaceTypes';
import { readingEnvironment, readingRun } from '../tests/helpers/shareReadingFixture';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_DELIVERY_OUTPUT ?? path.join(root, 'out/product-continuity/brief-export');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-brief-export-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let workers = 0, prohibited = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable recorded fixture' }; },
  async run(input, send) {
    workers++;
    const run = readingRun(input.id), observation = run.observation!;
    observation.inspection.configuration.environmentDigest = readingEnvironment;
    observation.inspection.problem.statement = input.input.task;
    observation.inspection.problem.formalStatement = input.input.source;
    for (const task of observation.inspection.tasks) task.finding = `Delivery evidence ${input.input.task.split(' ')[0]}`;
    for (const check of observation.checks) check.record = { passed: true };
    send({ type: 'observation', observation }); send({ type: 'result', result: run.result! });
  },
  async check() { prohibited++; throw new Error('No compiler in this fixture'); },
  async formalize() { prohibited++; throw new Error('No model in this fixture'); },
  async explain() { prohibited++; throw new Error('No model in this fixture'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_SOURCE_COMMIT: 'a'.repeat(40), THEOREMOS_WEB_CLIENT_IP_HEADER: 'x-fixture-scenario' }), runner,
{ sample: null, mailer: async () => { prohibited++; throw new Error('No mail in this fixture'); } });
const browser = await startBrowser(service.server, port), checks: object[] = [], errors: string[] = [], external: string[] = [];
let failure: unknown, phase = 'setup', active: Page | undefined;
const controls = (page: Page) => page.locator('[data-brief-controls]');
function gate() {
  let release!: () => void, signal!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { signal = resolve; });
  return { held, requested, release, signal };
}
try {
  for (const language of ['zh', 'en'] as const) for (const width of [1440, 390]) {
    const tag = `${language}-${width}`, markerA = `EXPORT_A_${tag}`, markerB = `EXPORT_B_${tag}`;
    phase = `setup-${tag}`;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-fixture-scenario': tag } });
    await context.addInitScript(language => localStorage.setItem('theorem-os.web-locale.v1', language), language);
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/workspace.html?tab=brief`); await page.evaluate(async () => await fetch('/api/session'));
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const session = await page.evaluate(async () => await (await fetch('/api/session')).json()), provider = session.providers[0], recorded = readingRun();
    const create = (marker: string) => service.jobs.create(owner, { providerId: provider.id, apiKey: 'sk-disposable-not-sent', model: 'fixture', effort: 'high',
      source: recorded.source, task: `${marker} ${recorded.task}`, environment: recorded.environment, maxTurns: 1, maxRunSeconds: 60, workers: 1, coordination: 'independent' }, provider);
    const a = create(markerA), b = create(markerB);
    await page.waitForFunction(async () => (await (await fetch('/api/runs')).json()).runs.every((run: WebRun) => run.status === 'completed'));
    const briefA = await page.evaluate(async id => (await (await fetch(`/api/research/workspace/brief/${id}`)).json()).item as ResearchBrief, a.id);
    assert.equal(briefA.selectedRunId, a.id); assert.notEqual(briefA.title, service.jobs.get(owner, b.id)!.title);
    const openA = async (entry: 'problem' | 'workspace' = 'problem') => {
      await page.goto(`${origin}/${entry}.html?run=${a.id}&tab=brief`, { waitUntil: 'domcontentloaded' }); await controls(page).waitFor();
      await page.locator('[data-research-brief]').getByText(`Delivery evidence ${markerA}`, { exact: true }).first().waitFor();
    };
    const verifyArtifact = async (download: Download, name: string) => {
      assert.equal(download.suggestedFilename(), `theoremos-brief-${a.id}.html`);
      const artifact = path.join(output, `${name}-${tag}.html`); await download.saveAs(artifact);
      const local = await context.newPage(), requests: string[] = [];
      await local.route(/^https?:\/\//u, async route => { requests.push(route.request().url()); await route.abort(); });
      await local.goto(pathToFileURL(artifact).href);
      assert.equal(await local.title(), briefA.title);
      assert.equal(await local.locator('html').getAttribute('lang'), language === 'en' ? 'en' : 'zh-CN');
      assert.equal(await local.locator('[data-brief-controls]').count(), 0);
      assert.equal(await local.locator('.research-error').count(), 0);
      assert.equal(await local.locator('details:not([open])').count(), 0);
      const text = await local.locator('body').innerText(); assert.ok(text.includes(markerA));
      assert.ok(!text.includes(`Delivery evidence ${markerB}`)); assert.ok(text.includes(briefA.sourceDigest));
      assert.equal(await local.locator('pre code').first().textContent(), briefA.leanStatement);
      assert.ok(await local.locator('.katex').count() > 0);
      assert.equal(await local.locator('.math[data-math-state=loading]').count(), 0);
      assert.equal(await local.locator('a[href="#brief-task-normalization"]').count(), 1);
      assert.ok((await local.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute('href')!)))
        .every(href => href.startsWith('#') || new URL(href).origin === origin));
      await local.close();
      return artifact;
    };
    phase = `stationary-and-offline-${tag}`;
    await openA(); await page.waitForFunction(() => document.querySelectorAll('[data-research-brief] .katex').length > 0);
    if (language === 'zh' && width === 1440) {
      const failedStyle = async (route: Route) => route.request().resourceType() === 'fetch'
        ? await route.fulfill({ status: 503, body: 'Disposable export read failure' }) : await route.continue();
      await page.route('**/research.css', failedStyle);
      await page.getByRole('button', { name: 'HTML', exact: true }).click(); await page.locator('[data-research-brief] [role=alert]').waitFor();
      await page.unroute('**/research.css', failedStyle);
    }
    const normal = page.waitForEvent('download'); await page.getByRole('button', { name: 'HTML', exact: true }).click();
    const stationary = await normal;
    // Inspect the actual standalone document with every HTTP request blocked.
    const artifact = await verifyArtifact(stationary, 'stationary');
    const local = await context.newPage(), offlineRequests: string[] = [];
    await local.route(/^https?:\/\//u, async route => { offlineRequests.push(route.request().url()); await route.abort(); });
    await local.goto(pathToFileURL(artifact).href);
    const hrefs = await local.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute('href')!));
    assert.ok(hrefs.some(href => href.startsWith(origin)));
    assert.ok(hrefs.every(href => href.startsWith('#') || new URL(href).origin === origin));
    await local.locator('a[href="#brief-task-normalization"]').click();
    assert.equal(new URL(local.url()).protocol, 'file:'); assert.equal(new URL(local.url()).hash, '#brief-task-normalization');
    assert.deepEqual(offlineRequests, []);
    await local.screenshot({ path: path.join(output, `offline-dependency-${tag}.png`), fullPage: true });
    await local.close();
    // Fixed identity, source bytes, complete formulas and removed controls apply to every exported document.
    const baselineArtifact = artifact;
    const delayed: object[] = [];
    for (const stage of ['styles', 'fonts', 'math'] as const) {
      phase = `${stage}-switch-${tag}`;
      const pending = gate(); let heldCount = 0;
      const pattern = stage === 'styles' ? '**/research.css' : stage === 'fonts' ? '**/*.woff2' : '**/math.js';
      const intercept = async (route: Route) => {
        if (stage !== 'math' && route.request().resourceType() !== 'fetch') { await route.continue(); return; }
        heldCount++; pending.signal(); await pending.held; await route.continue();
      };
      if (stage === 'math') await page.route(pattern, intercept);
      const entry = stage === 'fonts' ? 'workspace' : 'problem';
      await openA(entry);
      if (stage === 'math') assert.ok(await page.locator('[data-research-brief] .math[data-math-state=loading]').count() > 0);
      else { await page.waitForFunction(() => document.querySelectorAll('[data-research-brief] .katex').length > 0); await page.route(pattern, intercept); }
      const download = page.waitForEvent('download');
      try {
        await page.getByRole('button', { name: 'HTML', exact: true }).click(); await pending.requested;
        const selector = entry === 'problem' ? page.locator('[data-problem-run]') : page.locator('.workspace-select select');
        await selector.selectOption(b.id); await page.waitForURL(url => url.searchParams.get('run') === b.id);
        await page.locator('[data-research-brief]').getByText(`Delivery evidence ${markerB}`, { exact: true }).first().waitFor();
        pending.release();
        const result = await download, artifact = await verifyArtifact(result, `${stage}-switch`);
        assert.ok(heldCount > 0); delayed.push({ stage, from: a.id, selectedAtDownload: b.id, heldCount, artifact, exportedRun: a.id, frozenSourceDigest: briefA.sourceDigest, title: briefA.title });
      } finally { pending.release(); await page.unroute(pattern, intercept); }
    }
    checks.push({ language, width, staticExport: baselineArtifact, offlineDependencies: true, otherLinksAbsolute: true,
      fixedFilenameTitleSourceAndRun: true, delayed });
    await page.screenshot({ path: path.join(output, `selected-after-export-${tag}.png`), fullPage: true });
    await context.close();
  }
  assert.equal(workers, 8); assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) { failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(), phase,
    build: JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8')), checks, workers, prohibited, errors, external,
    ...(failure ? { error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Brief export continuity: ${checks.length} language/viewport combinations passed`);
