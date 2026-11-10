#!/usr/bin/env bun
// Disposable local records only; no model, Lean process, mail or production access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, startBrowser, waitForRun } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'out/product-continuity/post-lifecycle-20261111/workspace');
await fs.mkdir(output, { recursive: true });
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-workspace-continuity-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let recordedRuns = 0, prohibitedCalls = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable recorded workspace fixture' }; },
  async run(input, send) {
    recordedRuns++;
    const tokens = input.input.task === 'Small problem' ? 1000 : input.input.task === 'Large problem' ? 9000 : undefined;
    send({ type: 'result', result: { status: 'limit_reached', proof: '', report: { usage: tokens === undefined ? {} : { totalTokens: tokens } } } });
  },
  async formalize() { prohibitedCalls++; throw new Error('No models'); },
  async check() { prohibitedCalls++; throw new Error('No compiler'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: directory }), runner,
{ sample: null, mailer: async () => { prohibitedCalls++; throw new Error('No mail'); } });
const browser = await startBrowser(service.server, port);
const checks: object[] = [], errors: string[] = [], external: string[] = [];
let active: Page | undefined, phase = 'setup', failure: unknown;
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    phase = `setup-${language}`;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ key, language }) => localStorage.setItem(key, language), { key: localeStorageKey, language });
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/workspace.html?tab=usage'); await page.locator('[data-workspace-page]').waitFor();
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const session = await page.evaluate(async () => (await fetch('/api/session')).json()), provider = session.providers[0];
    const runs = ['Small problem', 'Large problem', 'Unknown problem'].map((task, index) => service.jobs.create(owner, {
      providerId: provider.id, apiKey: 'sk-disposable-unused', model: 'fixture', effort: 'low', environment: 'standard',
      source: `theorem problem_${index} : True := by sorry`, task, maxTurns: 1, maxRunSeconds: 30, workers: 1, coordination: 'cooperative',
    }, provider));
    for (const run of runs) await waitForRun({ page }, run.id, value => value.status === 'completed');
    service.research.workspace.saveRate(owner, { requestId: crypto.randomUUID(), providerId: provider.id, model: 'fixture', currency: 'USD', perMillion: 100 });

    phase = `usage-${language}`;
    await page.reload(); await page.locator('.workspace-usage-group').first().waitFor();
    const ledger = service.research.workspace.ledger(owner);
    assert.equal(ledger.knownTokens, 10000); assert.equal(ledger.groups.length, 3);
    const metrics = page.locator('.workspace-metrics strong'), selector = page.locator('.workspace-select select');
    const allTokenText = language === 'zh' ? '1 万' : '10K';
    assert.deepEqual(await metrics.allTextContents(), [allTokenText, '3', '1']);
    assert.ok((await page.locator('.workspace-estimate').innerText()).includes('USD 1.0000'));
    const small = ledger.groups.find(group => group.entries.some(entry => entry.id === `proof:${runs[0].id}`))!;
    await selector.selectOption(small.id);
    assert.equal(await page.locator('.workspace-usage-group').count(), 1);
    assert.deepEqual(await metrics.allTextContents(), ['1000', '1', '0']);
    assert.ok((await page.locator('[data-usage-scope]').innerText()).includes(language === 'zh' ? '所选题目' : 'Selected problem'));
    assert.ok((await page.locator('.workspace-estimate').innerText()).includes('USD 0.1000'));
    await page.screenshot({ path: path.join(output, `usage-selected-${language}.png`), fullPage: true });
    const unknown = ledger.groups.find(group => group.entries.some(entry => entry.id === `proof:${runs[2].id}`))!;
    await selector.selectOption(unknown.id);
    assert.deepEqual(await metrics.allTextContents(), ['0', '1', '1']);
    assert.equal(await page.locator('.workspace-estimate').count(), 0, 'unknown usage must not display a zero price');
    await selector.selectOption('');
    assert.deepEqual(await metrics.allTextContents(), [allTokenText, '3', '1']);
    await page.goto(`${origin}/workspace.html?tab=usage&run=${runs[0].id}`);
    await page.locator('.workspace-usage-group').waitFor();
    assert.deepEqual(await page.locator('.workspace-metrics strong').allTextContents(), ['1000', '1', '0']);

    phase = `search-${language}`;
    for (let index = 0; index < 45; index++) {
      const id = crypto.randomUUID(), messageId = crypto.randomUUID();
      service.storage.saveRecord(['owners', mathDigest(owner), 'conversations', `${id}.json`], {
        id, title: `Search marker ${String(index).padStart(2, '0')}`, runId: runs[0].id,
        createdAt: runs[0].createdAt, updatedAt: new Date(Date.now() + index).toISOString(),
        messages: [{ id: messageId, role: 'user', kind: 'text', text: 'pagination-continuity-marker', status: 'complete', createdAt: runs[0].createdAt }],
      });
    }
    await page.goto(origin + '/workspace.html?tab=search&q=pagination-continuity-marker&kind=conversation');
    await page.locator('.workspace-result').first().waitFor();
    assert.equal(await page.locator('.workspace-result').count(), 40);
    await page.getByRole('button', { name: language === 'zh' ? '下一页' : 'Next', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.workspace-result').length === 5);
    assert.equal(new URL(page.url()).searchParams.get('offset'), '40');
    const selected = page.locator('.workspace-result h3 a').nth(2), selectedTitle = await selected.innerText(), selectedId = await selected.getAttribute('id');
    await selected.click(); await page.waitForURL(url => url.searchParams.has('chat'));
    await page.goBack(); await page.waitForFunction(() => document.querySelectorAll('.workspace-result').length === 5);
    assert.equal(new URL(page.url()).searchParams.get('offset'), '40');
    assert.equal(await page.locator('.workspace-result h3 a').nth(2).innerText(), selectedTitle);
    await page.waitForFunction(id => document.activeElement?.id === id, selectedId);
    await page.screenshot({ path: path.join(output, `search-return-${language}.png`), fullPage: true });
    await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.workspace-result').length === 5);
    await page.waitForFunction(id => document.activeElement?.id === id, selectedId);
    await page.getByRole('button', { name: language === 'zh' ? '上一页' : 'Previous', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.workspace-result').length === 40);
    assert.equal(new URL(page.url()).searchParams.has('offset'), false);
    await page.goto(origin + '/workspace.html?tab=search&q=pagination-continuity-marker&kind=conversation&offset=40');
    await page.waitForFunction(() => document.querySelectorAll('.workspace-result').length === 5);
    await page.locator('#workspace-query').fill('Search marker 44'); await page.locator('.workspace-search button').click();
    await page.waitForFunction(() => document.querySelectorAll('.workspace-result').length === 1);
    assert.equal(new URL(page.url()).searchParams.has('offset'), false);
    await page.goto(origin + '/workspace.html?tab=search&q=pagination-continuity-marker&kind=conversation&offset=40');
    await page.waitForFunction(() => document.querySelectorAll('.workspace-result').length === 5);
    await page.locator('.workspace-filters button').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.workspace-result').length === 40);
    assert.equal(new URL(page.url()).searchParams.has('offset'), false);
    const layout = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(layout.content <= layout.viewport + 1, JSON.stringify(layout));
    checks.push({ language, width, usage: 'selected problem controls tokens, stages, missing usage and costs; all/deep-linked run recover',
      search: 'URL offset, back and reload retain selected result and focus; new queries and kinds reset pagination' });
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibitedCalls, 0); assert.equal(recordedRuns, 6);
} catch (error) {
  failure = error;
  if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks,
    recordedRuns, prohibitedCalls, errors, external, ...(failure ? { error: String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(directory, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Workspace post-lifecycle: ${checks.length} bilingual desktop/mobile workflows passed`);
