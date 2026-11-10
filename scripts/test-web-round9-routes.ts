#!/usr/bin/env bun
// Native Chromium IME events against the shared renderer and fixed classic recordings; no model or Lean calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import type { Browser, CDPSession, Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { loadWebSample } from '../apps/web/sample';
import { freePort, startBrowser, settled } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_ROUND9_ROUTES_OUTPUT ?? path.join(root, 'out/frontend-round9/routes');
await fs.mkdir(output, { recursive: true });
const fixtureOnly = process.argv.includes('--fixture-only');
const bundle = await build({
  stdin: { contents: `import {mountSolutionRoute} from './apps/web/solutionRouteView';
    const locale = new URL(location.href).searchParams.get('locale') === 'en' ? 'en' : 'zh';
    const models = Object.fromEntries(['recorded','source'].map(basis=>[basis,{
      schema:'theoremos.solution-route.v1',id:'round9-' + locale + '-' + basis,title:'initial-route',locale,basis,initial:'goal',
      nodes:[{id:'goal',kind:'problem',status:'recorded',title:'原题 / Original problem'},
        {id:'derive',kind:'derivation',status:'recorded',title:'推导 / Derivation',summary:'positive-marker',sections:[{title:'Reasoning',text:'The positive bound feeds the next step.'}]},
        {id:'result',kind:'outcome',status:'passed',title:'结论 / Result'}],
      edges:[{from:'goal',to:'derive',kind:'sequence'},{from:'derive',to:'result',kind:'dependency'}]
    }]));
    let active='recorded';const root=document.querySelector('#route');
    const controller=mountSolutionRoute(root,models[active]);
    window.routeFixture={models,controller,poll(version){models[active]={...models[active],title:'refresh-'+version,
      nodes:[...models[active].nodes.filter(node=>node.id!=='new-step'),{id:'new-step',kind:'derivation',status:'recorded',title:'推导补充 / More derivation'}]};controller.update(models[active]);},
      show(basis){active=basis;controller.update(models[active]);}};
    window.routeDraws=0;new MutationObserver(records=>window.routeDraws+=records.length).observe(root,{childList:true});`,
    resolveDir: root, sourcefile: 'round9-route-fixture.ts', loader: 'ts' },
  bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact',
});
const fixtureJs = bundle.outputFiles[0]!.text;
const fixtureCss = await fs.readFile(path.join(root, 'apps/web/solutionRoute.css'), 'utf8');
const fixtureHtml = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/__route-fixture.css"></head><body><div id="route"></div><script src="/__route-fixture.js"></script></body></html>';
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round9-routes-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let runnerCalls = 0;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_AUTH: 'none' }), {
  async readiness() { return { ready: true, message: 'Fixed route IME fixture' }; },
  async run() { runnerCalls++; throw new Error('Searching a route must not start a runner.'); },
}, { sample: loadWebSample() });
const checks: object[] = [], errors: string[] = [], writes: string[] = [], external: string[] = [];
let browser: Browser | undefined, current = '';
const query = (page: Page) => page.locator('.solution-route [data-solution-search]');
const ids = (page: Page) => page.locator('[data-solution-node]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.solutionNode));
async function compose(cdp: CDPSession, text: string) {
  await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
}
async function scenario(name: string, locale: 'zh' | 'en', viewport: { width: number; height: number }, run: (page: Page, cdp: CDPSession) => Promise<object>) {
  current = name;
  const context = await browser!.newContext({ locale: locale === 'en' ? 'en-US' : 'zh-CN', viewport, reducedMotion: 'reduce', hasTouch: viewport.width < 900 });
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
    checks.push({ name, locale, viewport, ...await run(page, await context.newCDPSession(page)) });
    await page.screenshot({ path: path.join(output, `${name}.png`) }); console.log(`PASS ${name}`);
  } catch (error) { await page.screenshot({ path: path.join(output, `failure-${name}.png`) }).catch(() => {}); throw error; }
  finally { await context.close(); }
}

try {
  browser = await startBrowser(service.server, port);
  for (const [locale, viewport] of [['zh', { width: 390, height: 844 }], ['en', { width: 1440, height: 900 }]] as const) {
    await scenario(`generic-ime-${locale}-${viewport.width}`, locale, viewport, async (page, cdp) => {
      await page.goto(`${origin}/__route-fixture.html?locale=${locale}`); await query(page).waitFor();
      await query(page).focus();
      await page.evaluate(() => { (window as any).originalSearch = document.activeElement; (window as any).routeDraws = 0; });
      const interim = [];
      for (const [index, text] of ['t', 'tu', '推', '推导'].entries()) {
        await compose(cdp, text);
        if (index === 1 || index === 2) await page.evaluate(version => (window as any).routeFixture.poll(version), index);
        const state = await query(page).evaluate(input => ({ value: (input as HTMLInputElement).value, same: input === (window as any).originalSearch,
          focused: input === document.activeElement, draws: (window as any).routeDraws }));
        assert.equal(state.value, text); assert.equal(state.same, true); assert.equal(state.focused, true); assert.equal(state.draws, 0);
        assert.deepEqual(await ids(page), ['goal', 'derive', 'result']); interim.push(state);
      }
      await cdp.send('Input.insertText', { text: '推导' }); await settled(page);
      assert.equal(await query(page).inputValue(), '推导'); assert.deepEqual(await ids(page), ['derive', 'new-step']);
      assert.equal(await page.locator('.solution-route-heading h3').innerText(), 'refresh-2');
      assert.equal(await page.evaluate(() => (window as any).routeDraws), 1, 'Commit applies the search and latest pending refresh once.');
      await query(page).dispatchEvent('input', { bubbles: true }); await settled(page);
      assert.equal(await page.evaluate(() => (window as any).routeDraws), 1, 'A trailing committed input event does not redraw the same query.');
      await page.locator('[data-solution-node="derive"]').focus(); await page.keyboard.press('End');
      assert.equal(await page.locator('[data-solution-heading]').getAttribute('data-solution-heading'), 'new-step');
      await query(page).fill(''); await page.locator('[data-solution-expand]').click(); await query(page).focus();
      await compose(cdp, 'tu');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.solution-route').getAttribute('data-solution-expanded'), 'true', 'IME Escape keeps the route canvas open.');
      await compose(cdp, ''); await settled(page);
      assert.equal(await query(page).inputValue(), ''); assert.equal((await ids(page)).length, 4);
      await page.keyboard.press('Escape'); assert.equal(await page.locator('.solution-route').getAttribute('data-solution-expanded'), 'false');
      await query(page).focus(); await compose(cdp, 'interim');
      await page.evaluate(() => { (window as any).routeFixture.poll(3); (window as any).routeFixture.show('source'); });
      await compose(cdp, '');
      assert.equal(await page.locator('.solution-route').getAttribute('data-solution-route-basis'), 'source');
      assert.equal(await query(page).inputValue(), '', 'An interrupted composition does not populate another model.');
      await query(page).fill(''); await query(page).focus(); await page.keyboard.type('positive-marker');
      assert.deepEqual(await ids(page), ['derive']);
      assert.equal(await query(page).evaluate(input => input === document.activeElement), true);
      await query(page).fill('no-saved-step-round9'); assert.deepEqual(await ids(page), []); await query(page).fill('');
      assert.equal((await ids(page)).length, 3);
      return { interim, committed: '推导', refresh: 'refresh-2', commitDraws: 1, cancellation: true, imeEscape: true,
        externalModelSwitch: true, regularTyping: true, noMatchesRecovery: true, keyboardNavigation: true };
    });
  }
  if (!fixtureOnly) for (const locale of ['zh', 'en'] as const) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await scenario(`classics-ime-${locale}-${viewport.width}`, locale, viewport, async (page, cdp) => {
      await page.goto(`${origin}/classics/${locale === 'en' ? 'en/' : ''}archive.html#proof=openai_hadamard_cube_fiber&tab=process`);
      await page.locator('[data-solution-route-state="ready"]').waitFor();
      const text = locale === 'zh' ? '原题' : 'problem', sequence = locale === 'zh' ? ['y', 'yuan', '原', text] : ['p', 'pro', text];
      await query(page).fill(text); const expected = await ids(page); assert.ok(expected.length > 0);
      await query(page).fill(''); await query(page).focus();
      for (const value of sequence) { await compose(cdp, value); assert.equal(await query(page).inputValue(), value); }
      await cdp.send('Input.insertText', { text }); assert.equal(await query(page).inputValue(), text); assert.deepEqual(await ids(page), expected);
      await page.locator('[data-solution-node]').first().focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('[data-solution-heading]').getAttribute('data-solution-heading'), expected[0]);
      await page.locator('.solution-route-tools [data-solution-view="read"]').click();
      assert.equal(await page.locator('[data-solution-reader-select]').inputValue(), expected[0]);
      await page.locator('.solution-route-tools [data-solution-view="map"]').click();
      assert.equal(await query(page).inputValue(), text); await query(page).fill('');
      await page.locator('[data-solution-mode="explanation"]').click();
      await query(page).fill(''); await page.locator('[data-solution-node]').first().focus(); await page.keyboard.press('End');
      const last = await page.locator('[data-solution-heading]').getAttribute('data-solution-heading');
      await page.locator('.solution-route-tools [data-solution-view="read"]').click();
      assert.equal(await page.locator('[data-solution-reader-select]').inputValue(), last);
      await page.locator('[data-solution-expand]').click(); await page.keyboard.press('Escape');
      assert.equal(await page.locator('[data-solution-expand]').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('[data-solution-expand]').evaluate(button => button === document.activeElement), true);
      return { text, expected, nativeComposition: true, keyboardSelect: true, readingRoundTrip: true, last, expandedEscape: true };
    });
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(external, []); assert.equal(runnerCalls, 0);
  await fs.writeFile(path.join(output, fixtureOnly ? 'fixture-report.json' : 'report.json'), JSON.stringify({ status: 'passed', checks, errors, writes, external, runnerCalls }, null, 2) + '\n');
} catch (error) {
  await fs.writeFile(path.join(output, fixtureOnly ? 'fixture-report.json' : 'report.json'), JSON.stringify({ status: 'failed', current, checks, errors, writes, external, runnerCalls,
    error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n'); throw error;
} finally { await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
