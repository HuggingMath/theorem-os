#!/usr/bin/env bun
import { openAdvancedChatSettings, openChatBudget } from './web-ui-controls';
// Empty-home and advanced-input regressions. Actual chat/task HTTP flows live in test-web-chat-session.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { localeStorageKey } from '../apps/web/i18n';
import { researchExamples } from '../apps/web/problemExamples';
import { freePort, settled, startBrowser } from './web-scenario';
import { audit } from './web-a11y';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-natural-first');
await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), {
  async readiness() { return { ready: true, message: 'Browser fixture only' }; },
  async run() { throw new Error('This UI test must never call a model'); },
  async formalize() { throw new Error('This UI test must never call a model'); },
});
const original = '  对任意自然数 n，证明 $n + 0 = n$。\n\n保留完整原题及空格。  ';
const checks: string[] = [], errors: string[] = [];
let browser: Browser | undefined, activePage: Page | undefined;
const noOverflow = (page: Page) => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth + 1);
const mark = (value: string) => { checks.push(value); console.log(`PASS ${value}`); };
async function openConnectionSettings(page: Page) {
  const settings = page.locator('#formalize-settings');
  if (!await settings.evaluate(node => (node as HTMLDetailsElement).open)) await settings.locator(':scope > summary').click();
  await settings.locator(':scope > .chat-settings-fields').waitFor();
}
async function openExamples(page: Page) {
  const examples = page.locator('[data-chat-examples]');
  if (!await examples.evaluate(node => (node as HTMLDetailsElement).open)) await examples.locator('summary[data-chat-first-example]').click();
  await page.locator('#formalize-example').waitFor();
}
async function lean(page: Page) {
  if (await page.locator('#entry-lean').isVisible()) await page.locator('#entry-lean').click();
  else {
    await openConnectionSettings(page);
    await page.locator('.chat-lean-entry').click();
  }
  await page.locator('#source').waitFor();
}
try {
  browser = await startBrowser(service.server, port);
  for (const [locale, width] of [['zh', 1440], ['zh', 390], ['en', 320], ['en', 390]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(30_000); context.setDefaultNavigationTimeout(30_000);
    await context.addInitScript(([key, value]) => {
      localStorage.setItem(key, value);
      if (!sessionStorage.getItem('theorem-os.web-draft-owner.v1')) sessionStorage.setItem('theorem-os.research-entry.v1', 'lean');
    }, [localeStorageKey, locale]);
    const page = await context.newPage(); activePage = page;
    page.on('pageerror', error => errors.push(error.message));
    const writes: string[] = [];
    const connectionChecks: { url: string; body: Record<string, unknown> }[] = [];
    let connectionStatus: 'available' | 'unknown' = 'available';
    await page.route('**/api/**', async route => {
      if (/\/api\/providers\/[^/]+\/check$/u.test(new URL(route.request().url()).pathname)) {
        connectionChecks.push({ url: route.request().url(), body: route.request().postDataJSON() });
        return route.fulfill({ json: { status: connectionStatus, message: connectionStatus === 'available' ? 'Key and model available; no model called.' : 'Model list unavailable; verify when sending.' } });
      }
      if (route.request().method() !== 'GET') {
        writes.push(new URL(route.request().url()).pathname);
        return route.fulfill({ status: 422, json: { error: 'This UI-only fixture must not start a task' } });
      }
      return route.continue();
    });
    await page.goto(origin); await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('body').getAttribute('data-entry'), 'natural', 'Old advanced-mode preference cannot replace the blank natural home');
    assert.equal(await page.locator('#formalize-original').inputValue(), '');
    assert.equal(await page.locator('.composer').isVisible(), false);
    assert.equal(await page.locator('#formalize-settings[open]').count(), 0);
    assert.equal(await page.locator('#formalize-start').isDisabled(), true);
    assert.equal(await page.locator('#research-conversation-panel select:visible').count(), 0);
    assert.equal(await page.locator('#topbar-draft').isVisible(), true);
    assert.equal(await page.locator('#workbench-home').getAttribute('href'), './');
    const emptyInput = await page.locator('#formalize-original').boundingBox();
    assert.ok(emptyInput && emptyInput.height < 180, 'The initial input is comfortably sized');
    // The heading and the composer share one centre line.
    const centres = await page.evaluate(() => ['.chat-start h1', '#natural-research'].map(selector => {
      const box = document.querySelector(selector)!.getBoundingClientRect(); return box.left + box.width / 2;
    }));
    assert.ok(Math.max(...centres) - Math.min(...centres) <= 2, `The empty-chat heading is off centre: ${centres.map(Math.round).join(', ')}`);
    assert.equal(await noOverflow(page), true); assert.deepEqual(await audit(page), []);
    await page.screenshot({ path: path.join(output, `natural-${locale}-${width}.png`), fullPage: true });
    mark(`${locale} ${width}px: blank natural home, centred heading, collapsed choices, visible new chat and no overflow`);

    await openExamples(page);
    const starter = researchExamples.find(example => example.id === 'add-zero')!;
    await page.locator('#formalize-example').selectOption(starter.id);
    assert.equal(await page.locator('#formalize-original').inputValue(), locale === 'en' ? starter.originalEn : starter.original);
    assert.equal(await page.locator('#formalize-environment').inputValue(), 'mathlib');
    assert.deepEqual(await page.locator('#formalize-environment option:not([hidden])').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)), ['mathlib']);
    assert.equal(writes.length, 0, 'The first-use example only fills the draft');
    await page.locator('#topbar-draft').click();
    await openExamples(page);
    await page.locator('[data-chat-sample]').click();
    await page.locator('[data-chat-sample-note]').waitFor();
    assert.equal(new URL(page.url()).searchParams.has('sample'), true);
    assert.equal(new URL(page.url()).searchParams.size, 1);
    assert.equal(await page.locator('[data-chat-share]').count(), 0);
    assert.equal(await page.locator('#formalize-start').isDisabled(), true);
    assert.equal(await page.locator('[data-first-research-start], [data-chat-participation]').count(), 0,
      'A read-only sample must not display new-submission setup over the recorded result');
    await page.locator('[data-chat-result-more] > summary').click();
    await page.locator('[data-research-artifact="result"]').click();
    await page.locator('.result-verdict').waitFor();
    assert.equal(writes.length, 0, 'Opening the sample and its acceptance report creates no paid task');
    await page.locator('#topbar-draft').click();
    mark(`${locale} ${width}px: visible first-use actions fill an editable starter or open a read-only example and its report without a key`);

    // The composer sits under the heading here, so its settings open below it, and a short screen scrolls them into view.
    if (width === 320) await page.setViewportSize({ width, height: 640 });
    await openConnectionSettings(page);
    await settled(page);
    assert.equal(await page.locator('#formalize-effort').inputValue(), 'high');
    const placement = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return { panel: box('#formalize-settings .chat-settings-fields'), toolbar: box('.chat-composer-toolbar'), heading: box('.chat-start h1'), height: innerHeight };
    });
    assert.ok(placement.panel.top >= placement.toolbar.bottom && placement.panel.top > placement.heading.bottom && placement.panel.bottom <= placement.height + 1,
      `The home settings must open below the composer and on screen: ${JSON.stringify(placement)}`);
    if (width === 1440) {
      assert.equal(await page.locator('#formalize-provider').inputValue(), 'sub2api');
      assert.equal(await page.locator('#formalize-model').inputValue(), 'deepseek-flash');
      const budgetFields = ['#formalize-minutes', '#formalize-tokens', '#research-minutes', '#research-tokens', '#research-turns'];
      await openAdvancedChatSettings(page);
      for (const selector of budgetFields) assert.equal(await page.locator(selector).inputValue(), '', `${selector} defaults to unlimited`);
      await openChatBudget(page);
      assert.match(await page.locator('[data-chat-budget]').innerText(), /形式化[\s\S]*不限[\s\S]*证明[\s\S]*不限/u);
      await openConnectionSettings(page);
      await page.locator('#formalize-key').fill('gateway-key-to-clear');
      const model = page.locator('#chat-model-settings > summary');
      await model.click();
      await page.locator('#formalize-provider').selectOption('openai');
      assert.equal(await page.locator('#formalize-key').inputValue(), '', 'A gateway key cannot accidentally be sent to OpenAI');
      assert.equal(await page.locator('#chat-key-help a').getAttribute('href'), 'https://platform.openai.com/api-keys');
      assert.equal(await page.locator('#formalize-model').inputValue(), 'gpt-6.1-sol');
      await openConnectionSettings(page);
      await page.locator('#formalize-key').fill('sk-disposable-check');
      await page.locator('#check-model-connection').click();
      await page.locator('#chat-connection-result[data-status="available"]').waitFor();
      assert.equal(connectionChecks.length, 1);
      assert.equal(connectionChecks[0]?.body.model, 'gpt-6.1-sol');
      assert.equal(connectionChecks[0]?.body.apiKey, 'sk-disposable-check');
      await model.click();
      await page.locator('#formalize-model').fill('fixture-other-model');
      assert.equal(await page.locator('#chat-connection-result').count(), 0, 'A model change invalidates the prior connection result');
      await openConnectionSettings(page);
      connectionStatus = 'unknown';
      await page.locator('#check-model-connection').click();
      await page.locator('#chat-connection-result[data-status="unknown"]').waitFor();
      assert.equal(connectionChecks.length, 2);
      assert.equal(connectionChecks[1]?.body.model, 'fixture-other-model');
      await page.locator('#formalize-key').fill('changed-key');
      assert.equal(await page.locator('#chat-connection-result').count(), 0, 'Changing the key invalidates the prior result');
      await page.locator('#formalize-original').fill(original);
      await openAdvancedChatSettings(page);
      assert.equal(await page.locator('#formalize-start').isEnabled(), true, 'Empty budgets allow submission');
      for (const selector of budgetFields) {
        await page.locator(selector).fill('0');
        assert.equal(await page.locator('#formalize-start').isEnabled(), true, `${selector}=0 allows unlimited submission`);
        await page.locator(selector).fill('-1');
        assert.equal(await page.locator('#formalize-start').isDisabled(), true, `${selector} rejects a negative budget`);
        await page.locator(selector).fill('');
        assert.equal(await page.locator('#formalize-start').isEnabled(), true, `${selector} can be cleared for unlimited submission`);
      }
      await page.locator('#formalize-tokens').fill('120000');
      await page.locator('#research-tokens').fill('80000');
      await page.locator('#formalize-minutes').fill('4');
      await page.locator('#research-minutes').fill('3');
      await page.locator('#research-turns').fill('4');
      await model.click();
      await page.locator('#formalize-effort').selectOption('max');
      assert.equal(await page.locator('#formalize-start').isEnabled(), true);
      await openChatBudget(page);
      assert.match(await page.locator('[data-chat-budget]').innerText(), /4 分钟[\s\S]*3 分钟/u);
      assert.equal(writes.length, 0, 'Connection checks and budget edits create no paid task');
      await model.click();
      await page.locator('#formalize-provider').selectOption('sub2api');
      await page.locator('#formalize-original').fill('');
      await openConnectionSettings(page);
      mark('provider-specific key guidance, key clearing, unlimited defaults, optional finite budgets and two non-generating connection checks');
    }
    await page.locator('#formalize-settings > summary').click();
    await page.locator('#formalize-settings .chat-settings-fields').waitFor({ state: 'hidden' });
    if (width === 320) await page.setViewportSize({ width, height: 1000 });
    mark(`${locale} ${width}px: the home settings open below the composer, clear of the heading and the input, and on screen`);

    await page.locator('#formalize-original').fill(original);
    await openConnectionSettings(page); await page.locator('#formalize-key').fill('fixture-secret-not-persisted');
    await page.reload(); await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), original, 'Original whitespace and line breaks survive reload');
    assert.equal(await page.locator('#formalize-key').inputValue(), '');
    assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes('fixture-secret-not-persisted')), false);
    await lean(page);
    assert.equal(await page.locator('#source').inputValue(), '', 'Advanced input must not insert a tutorial problem');
    assert.equal(await page.locator('#template').inputValue(), '');
    assert.equal(await page.locator('#task').isVisible(), false, 'Proof instructions stay optional');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.locator('#inline-problem-fields #source').isEditable(), true);
    assert.equal(await page.locator('#run-settings #source, #run-settings #environment, #run-settings #template').count(), 0);
    const typedLean = 'theorem typed_directly (n : Nat) : n = n := by\n  sorry\n';
    await page.locator('#source').fill(typedLean);
    await page.reload(); await page.locator('#source').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#source').inputValue(), typedLean, 'Lean draft survives reload separately from natural language');
    assert.equal(await noOverflow(page), true); assert.deepEqual(await audit(page), []);
    await page.screenshot({ path: path.join(output, `inline-lean-${locale}-${width}.png`), fullPage: true });
    await page.locator('#open-natural-language').click(); await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('#formalize-effort').inputValue(), width === 1440 ? 'max' : 'high',
      'Reload preserves an explicit max selection and otherwise keeps the high default');
    assert.equal(await page.locator('#formalize-original').inputValue(), original);
    assert.equal(writes.length, 0);
    mark(`${locale} ${width}px: original and Lean drafts remain separate; credentials clear on refresh; advanced editing needs no configuration dialog`);

    if (width === 1440) {
      await lean(page); await page.locator('#source').fill('');
      await page.locator('#proof-instructions > summary').click();
      await page.locator('#task').fill('帮我证明高斯定理');
      await page.locator('#submit-run').click();
      assert.equal(writes.length, 0, 'Instructions cannot substitute for an empty formal statement');
      await page.locator('#task-as-original').click(); await page.locator('#formalize-original').waitFor();
      assert.equal(await page.locator('#formalize-original').inputValue(), '帮我证明高斯定理');
      assert.equal(writes.length, 0, 'Moving instructions to the natural input does not launch a task');
      mark('Empty Lean source cannot prove an example; move-to-natural preserves the user request without launching it');
    }
    await page.locator('#topbar-draft').click(); assert.equal(await page.locator('#formalize-original').inputValue(), '');
    await openExamples(page);
    assert.equal(await page.locator('#formalize-example option').nth(1).getAttribute('value'), 'add-zero');
    for (const id of ['add-zero', 'schur-cubic']) {
      const example = researchExamples.find(example => example.id === id)!;
      await openExamples(page);
      await page.locator('#formalize-example').selectOption(example.id);
      assert.equal(await page.locator('#formalize-original').inputValue(), locale === 'en' ? example.originalEn : example.original);
      assert.equal(await page.locator('#formalize-environment').inputValue(), example.environment);
    }
    assert.equal(writes.length, 0, 'Choosing a natural-language example only prepares an editable draft');
    await page.locator('#workbench-home').click();
    assert.equal(new URL(page.url()).search, '');
    const lastExample = researchExamples.find(example => example.id === 'schur-cubic')!;
    const exampleDraft = locale === 'en' ? lastExample.originalEn : lastExample.original;
    assert.equal(await page.locator('#formalize-original').inputValue(), exampleDraft, 'Returning home preserves the current draft.');
    await page.reload(); await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), exampleDraft, 'The preserved draft survives reload.');
    await page.locator('#topbar-draft').click();
    assert.equal(await page.locator('#formalize-original').inputValue(), '');
    await page.reload(); await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), '');
    mark(`${locale} ${width}px: examples set matching environments; home preserves the draft and explicit new chat clears it`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, paidModelCalls: false }, null, 2) + '\n');
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 10_000 }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', checks, paidModelCalls: false,
    error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n');
  throw error;
} finally { await browser?.close(); await service.close(); }
