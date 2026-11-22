#!/usr/bin/env bun
// Disposable local accounts; all model, compiler and email operations are prohibited.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { WebStorage } from '../apps/web/storage';
import type { WebRunner } from '../apps/web/runner';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { freePort, startBrowser } from './web-scenario';
import { openAdvancedChatSettings, openChatBudget, openChatModelSettings } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/research-closure/planning-browser');
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-start-planning-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
await fs.mkdir(output, { recursive: true });
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'zh@example.org,en@example.org',
  THEOREMOS_WEB_PROVIDERS: JSON.stringify([{ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1' }]) });
const storage = new WebStorage(dataRoot), accounts = ['zh', 'en'].map(name => ({ id: crypto.randomUUID(), email: `${name}@example.org`,
  createdAt: new Date().toISOString(), termsAt: new Date().toISOString(), termsVersion: config.auth!.termsVersion }));
for (const account of accounts) storage.saveRecord(['accounts', `${mathDigest(account.email)}.json`], account);
const sessions = accounts.map(account => ({ id: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
  csrf: mathDigest(crypto.randomUUID()), touchedAt: Date.now(), account: { id: account.id, email: account.email } }));
for (const session of sessions) storage.saveSession(session);
let prohibited = 0;
const deny = async () => { prohibited++; throw new Error('No model, compiler or email calls are allowed'); };
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Disposable planning fixture' }; }, run: deny, formalize: deny, explain: deny };
const service = createWebService(config, runner, { sample: null, mailer: deny });
const browser = await startBrowser(service.server, port), errors: string[] = [], external: string[] = [], checks: object[] = [], writes: string[] = [];
let phase = 'setup', failure: unknown, active: Page | undefined;
const fit = async (page: Page) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page overflow');
try {
  for (const [index, language, width] of [[0, 'zh', 1440], [1, 'en', 390]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(15_000);
    await context.addCookies([{ name: 'theoremos_session', value: sessions[index].id, url: origin }]);
    await context.addInitScript(language => localStorage.setItem('theorem-os.web-locale.v1', language), language);
    await context.route(/^https?:\/\//u, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(request.url()); await route.abort(); return; }
      if (request.method() !== 'GET' && request.method() !== 'HEAD') writes.push(`${request.method()} ${url.pathname}`);
      if (url.pathname === '/api/provider/models') { prohibited++; await route.fulfill({ status: 503, json: { error: 'No model calls in this test' } }); return; }
      await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    phase = `new-account-rate-${language}`;
    await page.goto(`${origin}/?lang=${language}`); await page.locator('#formalize-original').waitFor();
    const runs = await page.evaluate(async () => (await (await fetch('/api/runs')).json()).runs);
    assert.equal(runs.length, 0, 'Rate entry works before the first run');
    await openChatModelSettings(page);
    await page.locator('#formalize-model').fill('planned-model');
    const cost = page.locator('#natural-research [data-start-cost]');
    // Quota and cost sit behind one closed line under the limits.
    await openChatBudget(page);
    await cost.locator('[data-cost-unavailable]').waitFor();
    await cost.locator('[data-start-rate] > summary').click();
    await cost.locator('[data-start-rate-value]').fill('10');
    await cost.locator('[data-start-rate-currency]').selectOption('USD');
    assert.equal(await page.locator('[data-first-budget]:not([data-first-budget=custom])').count(), 0, 'No preset budgets');
    await cost.locator('[data-cost-unavailable]').waitFor();
    assert.equal(await cost.locator('[data-cost-total]').count(), 0, 'Unlimited tokens have no finite cost estimate');
    await openAdvancedChatSettings(page);
    await page.locator('#formalize-tokens').fill('60000');
    await page.locator('#research-tokens').fill('60000');
    await openChatBudget(page);
    assert.match(await cost.locator('[data-cost-stage=formalization]').innerText(), /USD 0\.60/u);
    assert.match(await cost.locator('[data-cost-stage=proof]').innerText(), /USD 0\.60/u);
    assert.match(await cost.locator('[data-cost-total]').innerText(), /USD 1\.20/u);
    await openAdvancedChatSettings(page);
    await page.locator('#formalize-tokens').fill('');
    await page.locator('#research-tokens').fill('');
    await openChatBudget(page);
    await cost.locator('[data-cost-unavailable]').waitFor();
    assert.equal(await cost.locator('[data-cost-total]').count(), 0, 'Clearing the token limits restores the unlimited estimate');
    await openAdvancedChatSettings(page);
    await page.locator('#formalize-tokens').fill('400000');
    await page.locator('#research-tokens').fill('200000');
    await openChatBudget(page);
    assert.match(await cost.locator('[data-cost-total]').innerText(), /USD 6\.00/u);
    await cost.locator('[data-start-rate-save]').click(); await cost.locator('[data-start-rate-saved]').waitFor();
    const rates = await page.evaluate(async () => (await (await fetch('/api/research/workspace/rates')).json()).items);
    assert.deepEqual(rates, [{ providerId: 'fixture', model: 'planned-model', currency: 'USD', perMillion: 10 }]);
    phase = `formula-preview-${language}`;
    const formula = String.raw`Prove $n+0=n$.\n\n$$\sum_{k=1}^{n} k=\frac{n(n+1)}{2}$$`.replaceAll('\\n', '\n');
    await page.locator('#formalize-original').fill(formula);
    const writeCount = writes.length;
    await page.locator('[data-input-view=preview]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-input-preview] .katex').length === 2);
    assert.equal(await page.locator('#formalize-original').inputValue(), formula);
    await fit(page); await page.screenshot({ path: path.join(output, `planning-${language}.png`), fullPage: true });
    await page.locator('[data-input-view=edit]').click();
    assert.equal(await page.locator('#formalize-original').inputValue(), formula);
    await page.waitForFunction(() => document.activeElement?.id === 'formalize-original');
    assert.equal(writes.length, writeCount, 'Preview has no write or model request');
    await page.reload(); await openChatBudget(page); await cost.locator('[data-cost-total]').waitFor();
    assert.match(await cost.locator('[data-cost-total]').innerText(), /USD 6\.00/u);
    assert.equal(await page.locator('#formalize-original').inputValue(), formula);
    phase = `rate-isolation-${language}`;
    await openChatModelSettings(page);
    await page.locator('#formalize-model').fill('other-model'); await openChatBudget(page);
    await cost.locator('[data-cost-unavailable]').waitFor(); assert.equal(await cost.locator('[data-cost-total]').count(), 0);
    await cost.locator('[data-start-rate] > summary').click(); await cost.locator('[data-start-rate-value]').fill('0');
    assert.match(await cost.locator('[data-cost-total]').innerText(), /CNY 0\.00/u);
    await cost.locator('[data-start-rate-value]').fill(''); await cost.locator('[data-cost-unavailable]').waitFor();
    phase = `lean-planning-${language}`;
    await page.goto(`${origin}/?entry=lean&template=polynomial&environment=mathlib&lang=${language}`);
    await page.locator('#research-run-cost [data-start-cost]').waitFor();
    const leanCost = page.locator('#research-run-cost');
    await leanCost.locator('[data-start-rate] > summary').click(); await leanCost.locator('[data-start-rate-value]').fill('10');
    await leanCost.locator('[data-cost-set-limit]').click();
    await page.locator('#max-tokens').fill('20'); await page.locator('#close-settings').click();
    await leanCost.locator('[data-cost-stage=proof]').waitFor(); assert.equal(await leanCost.locator('[data-cost-stage=formalization]').count(), 0);
    await fit(page); await page.screenshot({ path: path.join(output, `lean-planning-${language}.png`), fullPage: true });
    checks.push({ language, width, beforeFirstRun: true, estimatesAndPresets: true, savedRateReload: true, modelIsolation: true,
      zeroAndMissingRate: true, localFormulaPreview: true, exactInputKept: true, leanEstimate: true });
    await context.close();
  }
  assert.equal(prohibited, 0); assert.deepEqual(external, []); assert.deepEqual(errors, []);
  assert.ok(writes.every(request => request === 'PUT /api/research/workspace/rates'), JSON.stringify(writes));
} catch (error) { failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 10_000 }).catch(() => {}); }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, writes, errors, external, prohibited,
    ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Research start planning: ${checks.length} desktop/mobile workflows passed`);
