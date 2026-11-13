#!/usr/bin/env bun
// Synthetic proof/evidence and a stub runner, served over loopback HTTP in real Chromium. No model or Lean calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput } from '../apps/web/shared';
import { localeStorageKey } from '../apps/web/i18n';
import { webExplanationEvidence, type FixtureUnit } from '../tests/helpers/webExplanationFixture';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.resolve(process.env.THEOREMOS_TEST_OUTPUT || path.join(root, 'out/web-explain-recovery'));
await fs.mkdir(output, { recursive: true });
const target = 'recovery_target', helper = 'theorem recovery_helper : True := by trivial';
const statement = `theorem ${target} : True := by exact recovery_helper`;
const proof = `${helper}\n\n${statement}\n`;
const units = (language: 'zh' | 'en'): FixtureUnit[] => [
  { name: 'recovery_helper', kind: 'theorem', snippet: helper, texts: [`${language}: synthetic helper explanation.`] },
  { name: target, kind: 'theorem', snippet: statement, uses: ['recovery_helper'], texts: [`${language}: synthetic target explanation.`] },
];
let holdEnglish = false;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local explanation recovery fixture' }; },
  async run(_input, send) { send({ type: 'result', result: { status: 'evaluated_passed', proof, report: { fixture: true } } }); },
  async explain(input, send, signal) {
    if (input.language === 'en' && holdEnglish) {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return;
    }
    send({ type: 'result', status: 'approved', evidence: webExplanationEvidence({ proof, target,
      units: units(input.language), language: input.language }) });
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner, { sample: null });
const browser = await startBrowser(service.server, port);
const checks: string[] = [], failures: { name: string; error: string }[] = [];
async function until(check: () => Promise<boolean>, name: string) {
  for (const started = Date.now(); Date.now() - started < 10_000;) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${name}`);
}
type Harness = { page: Page; context: BrowserContext; base: string; call(url: string, method?: 'GET' | 'POST', data?: unknown): Promise<any> };
async function scenario(name: string, width: number, both: boolean, work: (h: Harness) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
  await context.route(/^https?:\/\//, async route => {
    assert.equal(new URL(route.request().url()).origin, origin, 'All browser requests stay on the local fixture');
    await route.continue();
  });
  const page = await context.newPage(), errors: string[] = [];
  page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message));
  let base = '';
  const session = await (await context.request.get(origin + '/api/session')).json();
  const call: Harness['call'] = async (url, method = 'GET', data = {}) => {
    const response = method === 'GET' ? await context.request.get(origin + url)
      : await context.request.post(origin + url, { headers: { 'X-CSRF-Token': session.csrfToken }, data });
    assert.ok(response.ok(), `Local fixture ${method} ${url} returned ${response.status()}`);
    return response.json();
  };
  try {
    holdEnglish = !both;
    const input: WebRunInput = { providerId: 'sub2api', apiKey: 'sk-local-explanation-recovery', model: 'deepseek-flash', effort: 'low',
      environment: 'standard', source: `${helper}\n\ntheorem ${target} : True := by sorry\n`, task: 'Synthetic explanation recovery fixture',
      maxTurns: 1, maxRunSeconds: 60, workers: 1, coordination: 'cooperative' };
    const { run } = await call('/api/runs', 'POST', input);
    await until(async () => (await call(`/api/runs/${run.id}`)).run.status === 'completed', 'the local run completes');
    base = `/api/runs/${run.id}/explanations`;
    for (const language of both ? ['zh', 'en'] : ['zh']) {
      await call(base, 'POST', { target, language, apiKey: input.apiKey });
      await until(async () => (await call(`${base}/item?target=${target}&language=${language}`)).explanation.status === 'approved', 'fixture explanation approved');
    }
    await work({ page, context, base, call });
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, `${both ? 'document' : 'generation'}-${width}.png`), fullPage: true });
    checks.push(name); console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${both ? 'document' : 'generation'}-failure-${width}.png`), fullPage: true }).catch(() => {});
    failures.push({ name, error: error instanceof Error ? error.message : String(error) });
    console.log(`FAIL ${name}: ${failures.at(-1)!.error}`);
  } finally {
    if (base) await call(`${base}/cancel?target=${target}&language=en`, 'POST').catch(() => {});
    await context.close();
  }
}
const address = (base: string) => `${origin}/explain.html?${new URLSearchParams({ run: base.split('/')[3]!, target, language: 'zh' })}`;
try {
  for (const width of [1440, 390]) {
    await scenario(`${width}px: saved prose opens directly and optional routes preserve reading and deep links in both languages`, width, true, async ({ page, base }) => {
      await page.goto(address(base)); await page.locator('.explain-document').waitFor();
      for (const language of ['zh', 'en'] as const) {
        const url = new URL(address(base)); url.searchParams.set('language', language); url.searchParams.set('lang', language);
        await page.goto(url.href); await page.locator('.explain-document').waitFor();
        const disclosure = page.locator('[data-explain-route]'), route = disclosure.locator('.solution-route');
        assert.equal(await disclosure.getAttribute('open'), null, 'Saved explanations start on the prose');
        assert.equal(await route.isVisible(), false, 'The route is optional');
        assert.equal(await route.count(), 1, 'The hidden route stays mounted');
        assert.equal(await disclosure.locator(':scope > summary').innerText(), language === 'en' ? 'Proof route' : '证明路线');
        assert.equal(await page.locator('.explain-overview').isVisible(), true, 'The proof outline is available in prose');
        assert.ok((await page.locator('.explain-section').first().innerText()).includes(`${language}: synthetic helper explanation.`));
        await page.screenshot({ path: path.join(output, `prose-default-${language}-${width}.png`), fullPage: true });
        await disclosure.locator(':scope > summary').click();
        await route.locator('[data-solution-node="declaration:recovery_helper"]').click();
        await route.locator('[data-solution-zoom="in"]').click();
        const zoom = await route.locator('[data-solution-zoom="reset"]').innerText();
        await disclosure.locator(':scope > summary').click();
        await page.locator('[data-action="detail"][data-detail="outline"]').click();
        assert.equal(await disclosure.getAttribute('open'), null, 'Changing prose detail does not reopen the graph');
        await disclosure.locator(':scope > summary').click();
        assert.equal(await route.locator('[data-solution-zoom="reset"]').innerText(), zoom);
        assert.equal(await route.locator('[data-solution-node="declaration:recovery_helper"]').getAttribute('aria-pressed'), 'true');
        await route.locator('[data-solution-open]').click();
        await until(() => page.evaluate(() => document.activeElement?.id === 'explain-section-0'), 'A route action focuses the matching prose section');
        assert.equal(await page.locator('.explain-section').first().locator('.explain-steps').isVisible(), true, 'A route action unfolds the section in outline mode');
        assert.equal(await page.locator('#explain-split').getAttribute('data-pane'), 'prose');
        const helperLine = page.locator('.lean-row.is-active').first();
        assert.equal(await helperLine.getAttribute('data-line'), '1', 'The same section remains marked in Lean');
        await page.evaluate(url => history.replaceState(null, '', url), `${url.href}#at=recovery_helper&step=1`);
        await page.reload();
        await page.locator('.explain-steps > li.is-active[data-anchor="0"][data-step="0"]').waitFor();
        assert.equal(await disclosure.getAttribute('open'), null, 'A prose-only deep link keeps the route folded');
        await page.goto(`${url.href}#node=declaration%3Arecovery_helper`);
        await route.locator('[data-solution-node="declaration:recovery_helper"][aria-pressed="true"]').waitFor();
        assert.equal(await disclosure.getAttribute('open'), '', 'A node deep link opens the graph');
        await page.screenshot({ path: path.join(output, `route-link-${language}-${width}.png`), fullPage: true });
      }
    });
    await scenario(`${width}px: a generation response stays with its requested language after browser Back`, width, false, async ({ page, base, call }) => {
      await page.goto(address(base)); await page.locator('.explain-document').waitFor();
      await page.locator('[data-action="use"][data-target="0"]').click();
      await page.locator('[data-action="language"][data-language="en"]').click();
      await page.locator('#explain-prose [data-action="generate"]').waitFor();
      await page.evaluate(path => {
        const json = Response.prototype.json;
        Response.prototype.json = async function () {
          const value = await json.call(this);
          if (this.url.endsWith(path) && this.status === 201 && value.explanation?.language === 'en') {
            await new Promise<void>(resolve => { (window as any).__releaseGeneration = resolve; });
          }
          return value;
        };
      }, base);
      await page.locator('#explain-prose [data-action="generate"]').click();
      await page.locator('#explain-dialog[open] #explain-api-key').fill('sk-local-explanation-recovery');
      await page.locator('#explain-dialog[open] button[type="submit"]').click();
      await page.waitForFunction(() => Boolean((window as any).__releaseGeneration));
      await page.goBack();
      await page.locator('[data-action="language"][data-language="zh"][aria-pressed="true"]').waitFor();
      await page.evaluate(() => (window as any).__releaseGeneration()); await settled(page);
      assert.equal(await page.locator('.explain-document').count(), 1, 'An English result cannot remove the current approved Chinese explanation');
      assert.ok((await page.locator('.explain-document').innerText()).includes('zh: synthetic target explanation.'));
      await page.locator('[data-action="language"][data-language="en"]').click();
      await page.locator('.explain-progress').waitFor();
      assert.equal((await call(base)).explanations.length, 2, 'The authorized English task and approved Chinese explanation both remain');
    });
    await scenario(`${width}px: old-language read errors stay out of the current document, and a current failure can be retried`, width, true, async ({ page, base }) => {
      let releaseChinese!: () => void, held = false;
      const gate = new Promise<void>(resolve => { releaseChinese = resolve; });
      await page.route(`**${base}/item?**`, async route => {
        if (new URL(route.request().url()).searchParams.get('language') !== 'zh') return route.continue();
        held = true; await gate;
        await route.fulfill({ status: 503, json: { error: 'Previous Chinese document read failed' } });
      }, { times: 1 });
      await page.addInitScript(() => {
        const json = Response.prototype.json;
        Response.prototype.json = async function () {
          const value = await json.call(this);
          if (this.url.includes('/explanations/item?') && this.url.includes('language=en') && value.explanation?.document) {
            await new Promise<void>(resolve => { (window as any).__releaseDocument = resolve; });
          }
          return value;
        };
      });
      await page.goto(address(base));
      await until(async () => held, 'Chinese document read held');
      await page.locator('[data-action="language"][data-language="en"]').click();
      await page.waitForFunction(() => Boolean((window as any).__releaseDocument));
      releaseChinese(); await settled(page);
      assert.equal(await page.locator('#explain-prose .inline-error').count(), 0, 'An old language error cannot replace the current pending document');
      await page.evaluate(() => (window as any).__releaseDocument());
      await page.locator('.explain-document').waitFor();
      assert.ok((await page.locator('.explain-document').innerText()).includes('en: synthetic target explanation.'));
      await page.route(`**${base}/item?**`, async route => {
        assert.equal(new URL(route.request().url()).searchParams.get('language'), 'zh');
        await route.fulfill({ status: 503, json: { error: 'Current Chinese document read failed' } });
      }, { times: 1 });
      await page.locator('[data-action="language"][data-language="zh"]').click();
      await page.locator('#explain-prose .inline-error').filter({ hasText: 'Current Chinese document read failed' }).waitFor();
      await page.locator('[data-action="language"][data-language="en"]').click();
      await page.locator('.explain-document').waitFor();
      assert.equal(await page.locator('#explain-prose .inline-error').count(), 0, 'Switching language clears the previous document error');
      await page.locator('[data-action="language"][data-language="zh"]').click();
      await page.locator('.explain-document').waitFor();
      assert.ok((await page.locator('.explain-document').innerText()).includes('zh: synthetic target explanation.'));
    });
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failures.length ? 'failed' : 'passed',
    checks, failures, paidModelCalls: false, realLean: false }, null, 2) + '\n');
  assert.deepEqual(failures, []);
} finally {
  await browser.close(); await service.close();
}
