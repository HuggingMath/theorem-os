#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, startBrowser } from './web-scenario';
import { openAdvancedChatSettings } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-four/onboarding');
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-budget-corrections-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let prohibited = 0;
const deny = async () => { prohibited++; throw new Error('No models, Lean or external mail in budget validation'); };
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: data,
  THEOREMOS_WEB_PROVIDERS: JSON.stringify([{ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1' }]),
}), { readiness: async () => ({ ready: true, message: 'Disposable budget correction fixture' }), run: deny, formalize: deny, explain: deny, check: deny }, { sample: null, mailer: deny });
const browser = await startBrowser(service.server, port), checks: object[] = [], errors: string[] = [], external: string[] = [], writes: string[] = [];
let active: Page | undefined, failure: unknown, phase = 'setup';
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(15_000);
    await context.addInitScript(({ language, key }) => localStorage.setItem(key, language), { language, key: localeStorageKey });
    await context.route(/^https?:\/\//u, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(request.url()); await route.abort(); return; }
      if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${url.pathname}`);
      await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    phase = `${language}-unlimited-normal-control`;
    await page.goto(`${origin}/?lang=${language}`);
    const original = 'For every natural number n, prove that n + 0 = n.';
    await page.locator('#formalize-original').fill(original);
    await page.locator('#formalize-settings > summary').click();
    await page.locator('#formalize-model').fill('fixture-model'); await page.locator('#formalize-key').fill('sk-disposable-unused');
    assert.equal(await page.locator('#formalize-start').isEnabled(), true);
    await openAdvancedChatSettings(page);
    const samples = [
      { field: 'research-tokens', value: '5000', fixed: '10000', range: '10,000', label: language === 'zh' ? '证明 Token 上限' : 'Proof token limit' },
      { field: 'formalize-tokens', value: '2000001', fixed: '2000000', range: '2,000,000', label: language === 'zh' ? '形式化 Token 上限' : 'Statement token limit' },
      { field: 'research-turns', value: '1.5', fixed: '20', range: '20', label: language === 'zh' ? '研究轮次' : 'Research turns' },
      { field: 'formalize-minutes', value: '1.5', fixed: '30', range: '30', label: language === 'zh' ? '形式化时间' : 'Statement time' },
      { field: 'research-minutes', value: '16', fixed: '15', range: '15', label: language === 'zh' ? '证明时间' : 'Proof time' },
    ];
    for (const sample of samples) {
      phase = `${language}-correct-${sample.field}`;
      const input = page.locator(`#${sample.field}`);
      await input.fill(sample.value);
      assert.equal(await page.locator('#formalize-start').isEnabled(), false);
      assert.equal(await input.getAttribute('aria-invalid'), 'true');
      assert.equal(await input.getAttribute('aria-describedby'), `${sample.field}-error`);
      assert.ok((await page.locator(`#${sample.field}-error`).innerText()).includes(sample.range));
      assert.equal(await input.evaluate(node => (node as HTMLInputElement).validity.valid), false);
      await page.locator('[data-chat-advanced-settings] > summary').click();
      await page.locator('#formalize-settings > summary').click();
      const summary = page.locator('[data-chat-budget-errors]');
      assert.ok((await summary.innerText()).includes(sample.label));
      assert.ok((await summary.innerText()).includes(sample.range));
      if (sample.field === 'research-tokens') {
        await summary.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `collapsed-budget-error-${language}.png`), fullPage: true });
      }
      await page.locator(`[data-chat-fix-budget=${sample.field}]`).click();
      assert.equal(await page.locator('#formalize-settings').evaluate(node => (node as HTMLDetailsElement).open), true);
      assert.equal(await page.locator('[data-chat-advanced-settings]').evaluate(node => (node as HTMLDetailsElement).open), true);
      await page.waitForFunction(field => document.activeElement?.id === field, sample.field);
      if (sample.field === 'research-tokens') await page.screenshot({ path: path.join(output, `focused-budget-correction-${language}.png`), fullPage: true });
      await input.fill(sample.fixed);
      assert.equal(await page.locator('[data-chat-budget-errors]').count(), 0);
      assert.equal(await input.getAttribute('aria-invalid'), null);
      assert.equal(await input.evaluate(node => (node as HTMLInputElement).validity.valid), true);
      assert.equal(await page.locator('#formalize-start').isEnabled(), true);
      assert.equal(await page.locator('#formalize-original').inputValue(), original);
      checks.push({ id: `N1-correct-${sample.field}`, language, width, invalidValue: sample.value, validValue: sample.fixed,
        actualRangeShown: true, collapsedFieldLocated: true, focusRestored: true, originalPreserved: true });
    }
    phase = `${language}-multiple-errors-and-reload`;
    await page.locator('#formalize-tokens').fill('4000'); await page.locator('#research-tokens').fill('5000');
    assert.equal(await page.locator('[data-chat-fix-budget]').count(), 2);
    await page.locator('#formalize-tokens').fill('');
    assert.equal(await page.locator('[data-chat-fix-budget]').count(), 1);
    await page.reload(); await page.locator('[data-chat-fix-budget=research-tokens]').waitFor();
    await page.locator('[data-chat-fix-budget=research-tokens]').click();
    await page.waitForFunction(() => document.activeElement?.id === 'research-tokens');
    assert.equal(await page.locator('#research-tokens').inputValue(), '5000');
    await page.locator('#research-tokens').fill('');
    await openAdvancedChatSettings(page);
    await page.locator('#formalize-key').fill('sk-disposable-unused');
    assert.equal(await page.locator('#formalize-start').isEnabled(), true);
    assert.equal(await page.locator('#formalize-form').evaluate(node => (node as HTMLFormElement).checkValidity()), true);
    assert.equal(await page.locator('#formalize-original').inputValue(), original);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    checks.push({ id: 'N1-multiple-errors-refresh-and-unlimited-recovery', language, width,
      eachFieldCorrectedSeparately: true, refreshRetainsErrorAndInput: true, blankIsUnlimited: true, nativeFormValid: true });
    await context.close(); active = undefined;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []); assert.equal(prohibited, 0);
} catch (cause) { failure = cause; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 10_000 }).catch(() => {}); }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, errors, external, writes, prohibited,
    realModelCalls: 0, realLeanCalls: 0, realMailCalls: 0, build: JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8')),
    ...(failure ? { error: String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(data, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`First budget corrections: ${checks.length} desktop/mobile cases passed`);
