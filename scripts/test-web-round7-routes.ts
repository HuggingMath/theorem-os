#!/usr/bin/env bun
// Local renderer fixtures and fixed archive recordings only; no model or Lean runs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import type { Browser, Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { loadWebSample } from '../apps/web/sample';
import type { ArchiveProcess } from '../docs/web/types';
import { freePort, startBrowser, settled } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_ROUND7_ROUTES_OUTPUT ?? path.join(root, 'out/frontend-round7/routes');
await fs.mkdir(output, { recursive: true });
const bundle = await build({
  stdin: { contents: `import {mountSolutionRoute} from './apps/web/solutionRouteView';
    const locale = new URL(location.href).searchParams.get('locale') === 'en' ? 'en' : 'zh';
    const models = Object.fromEntries(['recorded', 'source', 'explanation'].map(basis => [basis, {
      schema:'theoremos.solution-route.v1', id:'generic-' + basis, title:locale === 'en' ? 'Three-step route' : '三步路线',
      locale, basis, initial:basis + '-1',
      nodes:[1,2,3].map(index=>({id:basis + '-' + index, kind:'derivation', status:'recorded',
        title:(locale === 'en' ? 'Step ' : '步骤 ') + index, sections:[{title:'Reasoning',text:'Recorded step ' + index}]})),
      edges:[1,2].map(index=>({from:basis + '-' + index,to:basis + '-' + (index + 1),kind:'dependency'}))
    }]));
    let active = 'recorded';
    const controller = mountSolutionRoute(document.querySelector('#route'), models[active]);
    window.routeFixture = {models, show(basis) { active = basis; controller.update(models[active]); },
      update(patch) { models[active] = {...models[active],...patch}; controller.update(models[active]); }};`,
    resolveDir: root, sourcefile: 'round7-route-fixture.ts', loader: 'ts' },
  bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact',
});
const fixtureJs = bundle.outputFiles[0]!.text;
const fixtureCss = await fs.readFile(path.join(root, 'apps/web/solutionRoute.css'), 'utf8');
const fixtureHtml = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/__route-fixture.css"></head><body><div id="route"></div><script src="/__route-fixture.js"></script></body></html>';
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round7-routes-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let runnerCalls = 0;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_AUTH: 'none' }), {
  async readiness() { return { ready: true, message: 'Fixed route recording fixture' }; },
  async run() { runnerCalls++; throw new Error('Route browsing must not start a runner.'); },
}, { sample: loadWebSample() });
const checks: object[] = [], errors: string[] = [], writes: string[] = [], external: string[] = [];
let browser: Browser | undefined, current = '';
const selected = (page: Page) => page.locator('.solution-route [data-solution-heading]').getAttribute('data-solution-heading');
async function expectSelection(page: Page, id: string) {
  assert.equal(await selected(page), id);
  assert.equal(await page.locator('[data-solution-node][aria-pressed="true"]').getAttribute('data-solution-node'), id);
  const picker = page.locator('[data-solution-reader-select]');
  if (await picker.count()) assert.equal(await picker.inputValue(), id);
}
async function scenario(name: string, locale: 'zh' | 'en', viewport: { width: number; height: number }, run: (page: Page) => Promise<object>) {
  current = name;
  const context = await browser!.newContext({ locale: locale === 'zh' ? 'zh-CN' : 'en-US', viewport,
    reducedMotion: 'reduce', hasTouch: viewport.width < 900 });
  await context.route(/^https?:\/\//u, route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(`${name}: ${url.href}`); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) { writes.push(`${name}: ${request.method()} ${url.pathname}`); return route.abort(); }
    const fixture = url.pathname === '/__route-fixture.html' ? { contentType: 'text/html', body: fixtureHtml }
      : url.pathname === '/__route-fixture.js' ? { contentType: 'text/javascript', body: fixtureJs }
        : url.pathname === '/__route-fixture.css' ? { contentType: 'text/css', body: fixtureCss } : undefined;
    return fixture ? route.fulfill(fixture) : route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  try {
    checks.push({ name, locale, viewport, ...await run(page) });
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({ path: path.join(output, `failure-${name}.png`) }).catch(() => {}); throw error;
  } finally { await context.close(); }
}

try {
  browser = await startBrowser(service.server, port);
  for (const [locale, viewport] of [['zh', { width: 1440, height: 900 }], ['en', { width: 320, height: 568 }]] as const) {
    await scenario(`generic-${locale}-${viewport.width}`, locale, viewport, async page => {
      await page.goto(`${origin}/__route-fixture.html?locale=${locale}`);
      await page.locator('[data-solution-node="recorded-2"]').click();
      await page.evaluate(() => (window as any).routeFixture.show('explanation'));
      await page.locator('.solution-route-tools [data-solution-view="read"]').click();
      await page.locator('[data-solution-reader-select]').selectOption('explanation-3');
      await page.evaluate(() => (window as any).routeFixture.show('source'));
      await page.locator('[data-solution-node="source-2"]').click();
      for (const [mode, id, reading] of [['recorded', 'recorded-2', false], ['explanation', 'explanation-3', true],
        ['source', 'source-2', false], ['explanation', 'explanation-3', true]] as const) {
        await page.evaluate(mode => (window as any).routeFixture.show(mode), mode);
        await expectSelection(page, id);
        assert.equal(await page.locator('.solution-route').getAttribute('data-solution-reading'), String(reading));
      }
      await page.locator('.solution-route-tools [data-solution-view="map"]').click();
      await expectSelection(page, 'explanation-3');
      await page.locator('.solution-route-tools [data-solution-view="read"]').click();
      await expectSelection(page, 'explanation-3');
      await page.evaluate(() => (window as any).routeFixture.update({ initial: 'explanation-2' }));
      await expectSelection(page, 'explanation-2');
      await page.locator('[data-solution-reader-select]').selectOption('explanation-3');
      await page.evaluate(() => (window as any).routeFixture.update({}));
      await expectSelection(page, 'explanation-3');
      await page.evaluate(() => {
        const fixture = (window as any).routeFixture;
        fixture.update({ nodes: fixture.models.explanation.nodes.filter((node: { id: string }) => node.id !== 'explanation-3') });
      });
      await expectSelection(page, 'explanation-2');
      await page.evaluate(() => {
        const fixture = (window as any).routeFixture;
        fixture.update({ nodes: fixture.models.explanation.nodes.filter((node: { id: string }) => node.id !== 'explanation-2') });
      });
      await expectSelection(page, 'explanation-1');
      await page.evaluate(() => (window as any).routeFixture.update({ nodes: [] }));
      assert.equal(await page.locator('[data-solution-heading]').count(), 0);
      assert.equal(await page.locator('[data-solution-node]').count(), 0);
      return { independentModeSelection: true, readingPreserved: true, mapReadRoundTrip: true,
        externalInitial: true, unchangedInitialPolling: true, removedSelectionFallback: true, emptyRoute: true };
    });
  }
  for (const locale of ['zh', 'en'] as const) for (const viewport of [{ width: 1440, height: 900 }, { width: 320, height: 568 }]) {
    for (const proof of ['openai_hadamard_cube_fiber', 'openai_triangle_face']) {
      await scenario(`classics-${proof}-${locale}-${viewport.width}`, locale, viewport, async page => {
        await page.goto(`${origin}/classics/${locale === 'en' ? 'en/' : ''}archive.html#proof=${proof}&tab=process`);
        await page.locator(`[data-solution-route-record="${proof}"][data-solution-route-state="ready"]`).waitFor();
        const map = page.locator('.solution-route');
        await page.locator('[data-solution-mode="explanation"]').click();
        await map.locator('.solution-route-tools [data-solution-view="read"]').click();
        const ids = await map.locator('[data-solution-reader-select] option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
        assert.ok(ids.length > 1, 'The saved proof contains multiple derivation steps.');
        const id = ids.at(-1)!;
        await map.locator('[data-solution-reader-select]').selectOption(id);
        await page.locator('[data-solution-mode="explanation"]').click(); await expectSelection(page, id);
        await map.locator('.solution-route-tools [data-solution-view="map"]').click(); await expectSelection(page, id);
        await map.locator('.solution-route-tools [data-solution-view="read"]').click(); await expectSelection(page, id);
        const modeSelections: Record<string, string> = { explanation: id };
        for (const mode of ['recorded', 'source']) {
          await page.locator(`[data-solution-mode="${mode}"]`).click();
          await map.locator('[data-solution-node]').last().click();
          modeSelections[mode] = (await selected(page))!;
        }
        for (const mode of ['explanation', 'recorded', 'source', 'explanation']) {
          await page.locator(`[data-solution-mode="${mode}"]`).click();
          await expectSelection(page, modeSelections[mode]);
        }
        assert.equal(await map.getAttribute('data-solution-reading'), 'true');
        await page.waitForFunction(() => !document.querySelector('[data-math-state="loading"]'));
        assert.equal(await page.locator('.math-error,[data-math-state="error"]').count(), 0);
        const expected = await page.evaluate(({ proof, id }) => {
          const process = (window as unknown as { theoremosProcesses: Record<string, ArchiveProcess> }).theoremosProcesses[proof];
          const walkthrough = process.walkthrough!, step = walkthrough.steps.find(step => step.id === id)!;
          return { digest: walkthrough.proofSha256, ...step.evidence.source };
        }, { proof, id });
        await map.locator('[data-solution-open]').click(); await settled(page);
        const source = await page.locator('.process-code[data-source-digest]').evaluate(element => ({
          name: (element as HTMLElement).dataset.sourceName, digest: (element as HTMLElement).dataset.sourceDigest,
          lines: [...element.querySelectorAll<HTMLElement>('[data-source-highlight]')].map(line => Number(line.dataset.sourceLine)),
        }));
        assert.equal(source.name, expected.name); assert.equal(source.digest, expected.digest);
        assert.deepEqual(source.lines, Array.from({ length: expected.endLine - expected.line + 1 }, (_, index) => expected.line + index));
        return { steps: ids.length, selected: id, modeSelections, mapReadRoundTrip: true, source };
      });
    }
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(external, []); assert.equal(runnerCalls, 0);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, errors, writes, external, runnerCalls }, null, 2) + '\n');
} catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', current, checks, errors, writes, external, runnerCalls,
    error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n'); throw error;
} finally { await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
