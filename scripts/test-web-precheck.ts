#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { localeStorageKey } from '../apps/web/i18n';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebPrecheckOutput } from '../apps/web/precheck';
import { audit } from './web-a11y';
import { freePort, settled, startBrowser, ready } from './web-scenario';
import { enterLean, showChat } from './web-ui-controls';

/**
 * The statement check in the composer and inline editor, against a fixture compiler (no Docker, no model): it runs by
 * itself after an edit; a Lean error is listed with its line, selects that range in the editor and stops submission
 * until fixed or dismissed; structural failures need no compile and cannot be dismissed; a newer edit replaces a
 * slow check; an unavailable checker never blocks. Audited in Chinese and English, laid out at 375 and 320 px.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-precheck');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the precheck check.'); });
await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const compiled: string[] = [], aborted: string[] = [];
let starts = 0;
const line = (severity: string, data: string, source: string, at: string, kind = 'error.fixture') => {
  const offset = source.indexOf(at), before = source.slice(0, offset), start = before.lastIndexOf('\n') + 1;
  const position = { line: before.split('\n').length, column: [...before.slice(start)].length };
  return JSON.stringify({ severity, data, kind, isSilent: false, pos: position, endPos: { ...position, column: position.column + [...at].length } });
};
/** `foo` is unknown, `SLOW` waits until the request goes away, `UNAVAILABLE` has no compiler, the rest compiles. */
const check: WebRunner['check'] = async ({ source }, signal) => {
  compiled.push(source);
  if (source.includes('UNAVAILABLE')) throw new Error('fixture: no compiler');
  if (source.includes('SLOW')) return new Promise<WebPrecheckOutput>((_, reject) => signal.addEventListener('abort', () => { aborted.push(source); reject(signal.reason); }, { once: true }));
  const lines: string[] = [];
  if (source.includes('foo')) lines.push(line('error', 'Unknown identifier `foo`', source, 'foo'));
  if (source.includes('unused_h')) lines.push(line('warning', 'unused variable `unused_h`', source, 'unused_h', 'linter.unusedVariables'));
  // Each theorem's body runs to the next theorem.
  for (const match of source.matchAll(/theorem (\S+)[\s\S]*?(?=\ntheorem |$)/gu)) if (/\bsorry\b/u.test(match[0]))
    lines.push(line('warning', 'declaration uses `sorry`', source, match[1], 'hasSorry'));
  return { output: lines.join('\n'), exitCode: lines.some(item => item.includes('"error"')) ? 1 : 0, timedOut: false };
};
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Precheck fixture' }; },
  async run(input, send) { starts++; send({ type: 'result', result: { status: 'incomplete', proof: input.input.source, report: { fixture: true } } }); },
  check,
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner);
const mark = (text: string) => console.log(`PASS ${text}`);
const good = 'theorem fixture_add (a b : Nat) : a + b = b + a := by\n  sorry\n';
// The error sits after a wide character on its line, so a UTF-16 column would select the wrong text.
const broken = 'theorem fixture_add (a b : Nat) : a + b = b + a := by\n  sorry\n\ntheorem fixture_two (x : Nat) : x = x := by\n  -- 𝔽 note\n  exact foo x\n';

async function setSource(page: Page, source: string) {
  await page.evaluate(value => {
    const editor = document.querySelector<HTMLTextAreaElement>('#source')!;
    editor.value = value; editor.dispatchEvent(new Event('input', { bubbles: true }));
  }, source);
}
const chip = (page: Page) => page.locator('#source-check-chip');
async function chipTone(page: Page, tone: string) { await page.locator(`#source-check-chip[data-tone="${tone}"]`).waitFor({ timeout: 10_000 }); }
async function fillRequired(page: Page, task: string) {
  if (!await page.locator('#proof-instructions').evaluate(node => (node as HTMLDetailsElement).open))
    await page.locator('#proof-instructions > summary').click();
  await page.locator('#task').fill(task);
  await page.evaluate(() => {
    const key = document.querySelector<HTMLInputElement>('#api-key')!;
    key.value = 'sk-precheck-fixture-never-sent'; key.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function noOverflow(page: Page, where: string) {
  const wide = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.composer-source-row, .composer-source-row *, #source-check, #source-check *')]
    .filter(node => node.getClientRects().length && node.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
    .map(node => `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}.${node.className}`));
  assert.deepEqual(wide, [], `${where}: elements leave the screen`);
}

let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
try {
  browser = await startBrowser(service.server, port);
  for (const locale of ['zh', 'en'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, locale] as const);
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#new-research:enabled').waitFor({ state: 'attached' });
    await enterLean(page);
    await ready(page);
    await page.locator('#inline-problem-fields').waitFor();

    // A statement that compiles: the composer says so once the edit settles, and the list stays empty.
    // Each locale uses its own text, since the service answers a repeated statement from its cache.
    const first = good.replace('fixture_add', `fixture_first_${locale}`);
    await setSource(page, first);
    await chipTone(page, 'good');
    assert.equal(compiled.at(-1), first);
    assert.match(await chip(page).innerText(), locale === 'zh' ? /可编译/u : /Compiles/u);
    mark(`a compiling statement is reported in the composer (${locale})`);

    // An error: listed with its line, named in the readiness card, and submission stops there.
    await setSource(page, broken.replace('fixture_two', `fixture_two_${locale}`));
    await chipTone(page, 'bad');
    await page.locator('#submission-readiness[data-state="missing"]').waitFor();
    await fillRequired(page, 'Prove both fixture theorems.');
    const title = await page.locator('#readiness-title').innerText();
    assert.match(title, locale === 'zh' ? /原题第 6 行：Unknown identifier `foo`/u : /Statement line 6: Unknown identifier `foo`/u);
    const before = starts;
    await page.locator('#submit-run').click();
    await page.waitForFunction(() => document.activeElement?.id === 'source');
    assert.equal(await page.locator('#run-settings').isVisible(), false, 'a diagnostic must focus the inline editor without opening settings');
    const selected = await page.evaluate(() => { const editor = document.querySelector<HTMLTextAreaElement>('#source')!; return editor.value.slice(editor.selectionStart, editor.selectionEnd); });
    assert.equal(selected, 'foo', 'submitting must select the reported range, counting columns in code points');
    assert.equal(starts, before, 'a statement with Lean errors must not start a run');
    assert.equal(await page.locator('#source-validation').isVisible(), true);
    const items = page.locator('#source-check .source-check-item');
    assert.equal(await items.count(), 1);
    assert.match(await items.first().innerText(), locale === 'zh' ? /第 6 行[\s\S]*错误[\s\S]*Unknown identifier/u : /Line 6[\s\S]*Error[\s\S]*Unknown identifier/u);
    await settled(page);
    assert.deepEqual(await audit(page, { scope: '#inline-problem-fields' }), [], `inline editor with check results (${locale})`);
    await page.screenshot({ path: path.join(output, `precheck-${locale}-errors.png`) });
    mark(`a Lean error is listed by line, selected in the editor and stops submission (${locale})`);

    // Clicking a listed diagnostic goes back to it after the caret moved away.
    await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('#source')!.setSelectionRange(0, 0));
    await items.first().click();
    assert.equal(await page.evaluate(() => { const editor = document.querySelector<HTMLTextAreaElement>('#source')!; return editor.value.slice(editor.selectionStart, editor.selectionEnd); }), 'foo');
    mark(`a listed diagnostic selects its range (${locale})`);

    // The user may disagree with the check; dismissing lets this exact text through.
    await page.locator('#dismiss-source-check').click();
    await page.locator('#source-validation').waitFor({ state: 'hidden' });
    await page.locator('#submit-run').click();
    await page.waitForFunction(count => document.querySelectorAll('.run-row').length > count, 0);
    await page.waitForFunction(() => document.querySelector('#toast:not([hidden])'));
    assert.equal(starts, before + 1, 'a dismissed check must allow the submission');
    mark(`dismissing the check lets the same statement be submitted (${locale})`);

    // Structural failures need no compile and are not dismissible, since the server rejects them too.
    // The submission opened its run; 新建研究 returns to the Lean composer.
    await showChat(page);
    const compiles = compiled.length;
    await setSource(page, 'def fixture_only := 1\n');
    await chipTone(page, 'bad');
    assert.equal(compiled.length, compiles, 'a structural failure must not start the compiler');
    await chip(page).click();
    await page.waitForFunction(() => document.activeElement?.id === 'source');
    assert.equal(await page.locator('#run-settings').isVisible(), false, 'the check chip must lead to the inline editor');
    assert.equal(await page.locator('#dismiss-source-check').count(), 0);
    assert.match(await page.locator('#source-check').innerText(), locale === 'zh' ? /没有找到 theorem 或 lemma/u : /No theorem or lemma found/u);
    mark(`a structural failure is explained without a compile and cannot be dismissed (${locale})`);

    // A newer edit replaces a slow check, and the slow compile is stopped.
    await setSource(page, 'theorem fixture_slow : True := by sorry -- SLOW\n');
    await page.locator('#source-check .source-check[data-tone="busy"]').waitFor();
    await setSource(page, good.replace('fixture_add', `fixture_${locale}`));
    await page.locator('#source-check .source-check[data-tone="good"]').waitFor();
    for (let attempt = 0; attempt < 20 && !aborted.some(source => source.includes('SLOW')); attempt++) await page.waitForTimeout(50);
    assert.ok(aborted.some(source => source.includes('SLOW')), 'the superseded compile must be stopped');
    aborted.length = 0;
    mark(`a newer edit replaces a slow check (${locale})`);

    // No compiler: the check says so and submission goes ahead.
    await setSource(page, 'theorem fixture_unavailable : True := by sorry -- UNAVAILABLE\n');
    await page.locator('#source-check .source-check[data-tone="warn"]').waitFor();
    assert.equal(await page.locator('#source-validation').isVisible(), false);
    await fillRequired(page, 'Prove the fixture theorem.');
    await page.locator('#submission-readiness[data-state="ready"]').waitFor();
    mark(`an unavailable checker does not block (${locale})`);

    // Phone widths: the composer row keeps the attachment, the status and the draft state on screen.
    await setSource(page, broken);
    await chipTone(page, 'bad');
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 760 });
      await settled(page);
      await noOverflow(page, `${width}px composer (${locale})`);
      assert.ok(await chip(page).isVisible());
      await page.screenshot({ path: path.join(output, `precheck-${locale}-${width}.png`) });
    }
    assert.deepEqual(await audit(page), [], `composer at 320px (${locale})`);
    mark(`the composer status fits at 375 and 320 px and passes the audit (${locale})`);
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await browser?.close();
  service.server.close();
}
console.log('Precheck checks passed: automatic check, error listing and selection, submission block and dismissal, structural failures, superseding, unavailable checker, phone layout.');
