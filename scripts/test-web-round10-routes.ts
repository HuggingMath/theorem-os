#!/usr/bin/env bun
// Read-only saved archive recordings: no models, Lean or production data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { loadWebSample } from '../apps/web/sample';
import { freePort, startBrowser, settled } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_ROUND10_ROUTES_OUTPUT ?? path.join(root, 'out/frontend-round10/routes');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round10-routes-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let runnerCalls = 0;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_AUTH: 'none' }), {
  async readiness() { return { ready: true, message: 'Fixed archive source-location regression' }; },
  async run() { runnerCalls++; throw new Error('Source browsing must not start a runner.'); },
}, { sample: loadWebSample() });
const checks: object[] = [], errors: string[] = [], writes: string[] = [], external: string[] = [];
let browser: Browser | undefined, current = '';
type Expected = { name: string; sha256: string; line: number; endLine: number; code: string };
const normalize = (code: string) => code.split('\n').map(line => line.trimEnd()).join('\n').trimEnd();
const sourceKeys = ['source', 'sourceSha256', 'line', 'endLine'];
const paramsOf = (page: Page) => new URLSearchParams(new URL(page.url()).hash.slice(1));
async function ready(page: Page) { await page.locator('[data-solution-route-state="ready"]').waitFor(); await settled(page); }
async function openStep(page: Page, id: string) {
  if (!await page.locator('[data-solution-route-state="ready"]').count()) {
    await page.locator('[data-process-view="global"]').click(); await ready(page);
  }
  await page.locator('[data-solution-mode="explanation"]').click();
  await page.locator('.solution-route-tools [data-solution-view="read"]').click();
  await page.locator('[data-solution-reader-select]').selectOption(id);
  await page.locator('[data-solution-open]').click();
}
async function sourceState(page: Page, expected: Expected, sourceTab = false) {
  const selector = sourceTab ? '.source-code' : '.process-check-source .process-code:not(.process-diff)';
  await page.waitForFunction(({ selector, expected }) => {
    const panel = document.querySelector<HTMLElement>(selector);
    return panel?.dataset.sourceDigest === expected.sha256
      && panel.querySelectorAll('[data-source-highlight]').length === expected.endLine - expected.line + 1;
  }, { selector, expected });
  await page.evaluate(() => document.fonts.ready); await settled(page);
  const state = await page.locator(selector).evaluate(panel => {
    const element = panel as HTMLElement, rows = [...panel.querySelectorAll<HTMLElement>('[data-source-line]')];
    const first = panel.querySelector<HTMLElement>('[aria-current="location"]');
    const rect = element.getBoundingClientRect(), line = first?.getBoundingClientRect();
    return { name: element.dataset.sourceName, sha256: element.dataset.sourceDigest,
      lines: rows.length, highlights: [...panel.querySelectorAll<HTMLElement>('[data-source-highlight]')].map(row => Number(row.dataset.sourceLine)),
      plainCode: rows.map(row => row.lastElementChild?.textContent ?? '').join('\n'), scrollTop: element.scrollTop,
      highlightedLineVisible: !!line && line.top >= rect.top && line.top < rect.bottom };
  });
  assert.equal(state.name, expected.name); assert.equal(state.sha256, expected.sha256);
  assert.deepEqual(state.highlights, Array.from({ length: expected.endLine - expected.line + 1 }, (_, index) => expected.line + index));
  assert.equal(normalize(state.plainCode), normalize(expected.code));
  assert.equal(state.highlightedLineVisible, true);
  const params = paramsOf(page);
  assert.equal(params.get('source'), expected.name); assert.equal(params.get('sourceSha256'), expected.sha256);
  assert.equal(params.get('line'), String(expected.line)); assert.equal(params.get('endLine'), String(expected.endLine));
  const { plainCode: _code, ...evidence } = state;
  return { ...evidence, url: page.url() };
}
async function fallback(page: Page, url: string, expected: Expected) {
  await page.goto(url); await page.locator('#process-step-detail').waitFor();
  await page.evaluate(() => document.fonts.ready); await settled(page);
  assert.equal(await page.locator('[data-source-highlight]').count(), 0);
  for (const key of sourceKeys) assert.equal(paramsOf(page).has(key), false, `Discard stale ${key}`);
  const code = page.locator('.process-check-source .process-code code');
  if (await code.count()) {
    assert.equal(normalize(await code.innerText()), normalize(expected.code));
    assert.ok((await page.locator('.process-code-digest').innerText()).includes(expected.sha256));
  }
  return { url: page.url(), sourceVisible: !!await code.count(), noRange: true };
}

try {
  browser = await startBrowser(service.server, port);
  for (const entry of [
    { name: 'hadamard-zh-desktop', proof: 'openai_hadamard_cube_fiber', locale: 'zh', viewport: { width: 1440, height: 900 } },
    { name: 'triangle-en-mobile', proof: 'openai_triangle_face', locale: 'en', viewport: { width: 390, height: 844 } },
  ] as const) {
    current = entry.name;
    const context = await browser.newContext({ locale: entry.locale === 'zh' ? 'zh-CN' : 'en-US', viewport: entry.viewport,
      reducedMotion: 'reduce', hasTouch: entry.viewport.width < 900 });
    await context.route(/^https?:\/\//u, route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.href); return route.abort(); }
      if (!['GET', 'HEAD'].includes(request.method())) { writes.push(`${request.method()} ${url.pathname}`); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(`${entry.name}: ${error.message}`));
    try {
      await page.goto(`${origin}/classics/${entry.locale === 'en' ? 'en/' : ''}archive.html#proof=${entry.proof}&tab=process`); await ready(page);
      assert.equal(await page.locator('html').getAttribute('lang'), entry.locale === 'en' ? 'en' : 'zh-CN');
      const saved = await page.evaluate(proof => {
        const process = (window as any).theoremosProcesses[proof], walkthrough = process.walkthrough;
        return { run: walkthrough.runId, steps: walkthrough.steps.map((step: any) => ({ id: step.id, ...step.evidence.source,
          sha256: walkthrough.proofSha256, code: process.sources[walkthrough.proofSha256].code })) };
      }, entry.proof) as { run: string; steps: (Expected & { id: string })[] };
      const first = saved.steps[0], last = saved.steps.at(-1)!;
      await openStep(page, first.id); const firstSource = await sourceState(page, first);
      await openStep(page, last.id); const before = await sourceState(page, last);
      assert.notEqual(firstSource.url, before.url);
      await page.screenshot({ path: path.join(output, `${entry.name}-before-reload.png`) });
      await page.reload(); const reload = await sourceState(page, last);
      assert.equal(reload.url, before.url);
      await page.screenshot({ path: path.join(output, `${entry.name}-after-reload.png`) });
      const newPage = await context.newPage();
      await newPage.goto(before.url); const fresh = await sourceState(newPage, last);
      await newPage.close();
      await page.locator('[data-view-link="quickstart"]').click();
      await page.locator('#quickstart-view').waitFor({ state: 'visible' });
      await page.goBack(); const back = await sourceState(page, last);
      await page.goForward(); await page.locator('#quickstart-view').waitFor({ state: 'visible' });
      await page.goBack(); await sourceState(page, last);

      const rejected = [];
      const lineCount = last.code.trimEnd().split('\n').length;
      for (const [name, fields] of [
        ['zero-line', { line: '0' }], ['fractional-line', { line: '1.5' }], ['reversed-range', { line: '10', endLine: '9' }],
        ['out-of-file', { endLine: String(lineCount + 10) }], ['stale-digest', { sourceSha256: 'f'.repeat(64) }],
        ['different-file', { source: 'not-the-checked-file.lean' }], ['missing-check', { step: 'check:retired-check' }],
        ['missing-run', { run: 'retired-run' }],
      ] as const) {
        const url = new URL(before.url), params = new URLSearchParams(url.hash.slice(1));
        for (const [key, value] of Object.entries(fields)) params.set(key, value);
        url.hash = params.toString(); rejected.push({ name, ...await fallback(page, url.href, last) });
      }
      const legacy = new URL(before.url), legacyParams = new URLSearchParams(legacy.hash.slice(1));
      for (const key of sourceKeys) legacyParams.delete(key);
      legacy.hash = legacyParams.toString(); const legacySource = await fallback(page, legacy.href, last);
      assert.equal(legacySource.sourceVisible, true);

      // The same location format restores source-only readers too; manual jumps clear the old range from copied links.
      const archive = new URL(before.url), archiveParams = new URLSearchParams(archive.hash.slice(1));
      archiveParams.set('tab', 'source');
      for (const key of ['mode', 'run', 'step', 'node', 'code']) archiveParams.delete(key);
      archive.hash = archiveParams.toString(); await page.goto(archive.href);
      const sourceOnly = await sourceState(page, last, true);
      await page.reload(); await sourceState(page, last, true);
      await page.locator('[data-action="jump-declaration"]').click();
      for (const key of sourceKeys) assert.equal(paramsOf(page).has(key), false);
      await page.goto(archive.href); await sourceState(page, last, true);
      const files = await page.locator('#source-file option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
      const otherFile = files.find(name => name !== last.name);
      if (otherFile) {
        await page.locator('#source-file').selectOption(otherFile);
        for (const key of sourceKeys) assert.equal(paramsOf(page).has(key), false);
        assert.equal(await page.locator('.source-code').getAttribute('data-source-name'), otherFile);
      }
      checks.push({ name: entry.name, proof: entry.proof, locale: entry.locale, viewport: entry.viewport,
        first: { id: first.id, source: firstSource }, last: { id: last.id, before, reload, fresh, back }, rejected,
        legacySource, sourceOnly, sourceSelectionClearsRange: !!otherFile, jumpClearsRange: true });
      console.log(`PASS ${entry.name}`);
    } catch (error) { await page.screenshot({ path: path.join(output, `failure-${entry.name}.png`) }).catch(() => {}); throw error; }
    finally { await context.close(); }
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(external, []); assert.equal(runnerCalls, 0);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, errors, writes, external, runnerCalls }, null, 2) + '\n');
} catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', current, checks, errors, writes, external, runnerCalls,
    error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n'); throw error;
} finally { await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
