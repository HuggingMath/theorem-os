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
import { keyMemoryStorageKey } from '../apps/web/client/keyMemory';
import { closeSettings, fillConfig, newResearch, openSettings, showArtifacts } from './web-ui-controls';
import { freePort, settled, startBrowser, webScenario, writeScenarioReport, type ScenarioHarness, type ScenarioSuite, ready } from './web-scenario';

/**
 * Opt-in API Key memory for one tab: off by default, kept across submissions and reloads in the same tab when ticked,
 * never in localStorage or drafts, never offered to another provider address or another tab, forgotten on untick,
 * on "forget" and after a rejected key. Fixture runner only; no model call.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-key-memory');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the key memory check.'); });
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
const credential = 'sk-local-key-memory-fixture-0123456789';
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local key memory fixture; no model or Lean' }; },
  async run(input, send) {
    send({ type: 'result', result: { status: 'incomplete', proof: '', report: input.input.task.includes('reject')
      ? { failure: { kind: 'authentication', reason: 'math_model_authentication_failed' } } : { fixture: true } } });
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
// Two providers, so a remembered key can be checked against the address it was entered for.
const providers = JSON.stringify([{ id: 'first', name: 'First', baseUrl: 'https://first.example/v1' }, { id: 'second', name: 'Second', baseUrl: 'https://second.example/v1' }]);
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin, THEOREMOS_WEB_PROVIDERS: providers,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '8' }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
type Harness = ScenarioHarness & { posted: string[] };
const screenshots: string[] = [];
function scenario(name: string, run: (h: Harness) => Promise<void>, options: { width?: number; locale?: 'zh' | 'en' } = {}) {
  const { width = 1440, locale = 'zh' } = options;
  return webScenario<Harness>(browser, suite, name, run, {
    context: { viewport: { width, height: width > 850 ? 1000 : 812 }, reducedMotion: 'reduce' },
    init: context => context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, locale] as const),
    harness: (page, context) => {
      const h: Harness = { page, context, requests: [], posted: [] };
      page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs') h.posted.push(request.postData() ?? ''); });
      return h;
    },
    routes: { local: 'Key memory must stay local' }, open: true, timeout: { label: 'Key memory', seconds: 50 },
  });
}
const storage = (page: Page) => page.evaluate(key => ({ tab: sessionStorage.getItem(key), local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) }), keyMemoryStorageKey);
const keyField = (page: Page) => page.locator('#api-key').inputValue();
async function submit(h: Harness, task: string, options: { key?: string; remember?: boolean } = {}) {
  const { page } = h, before = h.posted.length;
  await newResearch(page);
  // New drafts start without a source.
  await fillConfig(page, 'source', 'theorem key_memory_fixture : True := by\n  sorry\n');
  await page.locator('#task').fill(task);
  await openSettings(page);
  if (options.key !== undefined) await page.locator('#api-key').fill(options.key);
  if (options.remember !== undefined) await page.locator('#remember-key').setChecked(options.remember);
  await page.locator('#settings-submit').click();
  for (let attempt = 0; attempt < 100 && h.posted.length === before; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.posted.length, before + 1, 'the form submitted once');
  await page.locator('#toast').filter({ hasText: /研究已提交|Research submitted/u }).waitFor();
  // The toast precedes the attached conversation; finish that navigation before exercising another input mode.
  await page.waitForURL(url => Boolean(url.searchParams.get('chat')));
  return JSON.parse(h.posted.at(-1)!).apiKey as string;
}

try {
  await scenario('off by default: the key is used once and stored nowhere', async h => {
    const { page } = h;
    await openSettings(page);
    assert.equal(await page.locator('#remember-key').isChecked(), false, 'remembering is opt-in');
    assert.equal(await page.locator('#forget-key').isHidden(), true);
    await closeSettings(page);
    assert.equal(await submit(h, 'Once', { key: credential }), credential);
    await openSettings(page);
    assert.equal(await keyField(page), '', 'the field empties after submission');
    const stored = await storage(page);
    assert.equal(stored.tab, null); assert.ok(!stored.local.includes(credential) && !stored.session.includes(credential), 'the key is in no storage');
  });

  await scenario('ticked, the key stays for later submissions and a reload in this tab, and only here', async h => {
    const { page, context } = h;
    assert.equal(await submit(h, 'First', { key: credential, remember: true }), credential);
    let stored = await storage(page);
    assert.ok(stored.tab?.includes(credential), 'kept in this tab'); assert.ok(!stored.local.includes(credential), 'never in localStorage');
    assert.equal(await submit(h, 'Second'), credential, 'the next submission reuses it without typing');
    await openSettings(page);
    assert.equal(await keyField(page), credential); assert.equal(await page.locator('#remember-key').isChecked(), true);
    assert.equal(await page.locator('#forget-key').isVisible(), true);
    await page.screenshot({ path: path.join(output, 'remembered-1440.png') }); screenshots.push('remembered-1440.png');
    await closeSettings(page);
    await page.reload(); await ready(page);
    await openSettings(page); assert.equal(await keyField(page), credential, 'a reload in the same tab keeps it'); await closeSettings(page);
    // Draft storage holds no key even while one is remembered.
    stored = await storage(page);
    assert.equal(stored.session.split(credential).length - 1, 1, 'only the memory entry holds the key');
    const other = await context.newPage();
    await other.goto(origin); await ready(other);
    await openSettings(other);
    assert.equal(await keyField(other), '', 'another tab does not get it'); assert.equal(await other.locator('#remember-key').isChecked(), false);
    await other.close();
  });

  await scenario('another provider address gets no key, and switching back offers it again', async h => {
    const { page } = h;
    await submit(h, 'First', { key: credential, remember: true });
    await newResearch(page); await openSettings(page);
    await page.locator('#provider').selectOption('second');
    assert.equal(await keyField(page), '', 'not offered to another address'); assert.equal(await page.locator('#remember-key').isChecked(), false);
    await page.locator('#api-key').fill('sk-typed-for-second');
    await page.locator('#provider').selectOption('first');
    assert.equal(await keyField(page), 'sk-typed-for-second', 'a key the reader typed is never replaced');
    assert.equal(await page.locator('#remember-key').isChecked(), false, 'nor is the reader\'s choice of the box');
    await page.locator('#api-key').fill('');
    await page.locator('#provider').selectOption('second'); await page.locator('#provider').selectOption('first');
    assert.equal(await keyField(page), credential, 'the remembered key returns for its own address');
    await closeSettings(page);
  });

  await scenario('unticking or "forget" clears it at once', async h => {
    const { page } = h;
    await submit(h, 'First', { key: credential, remember: true });
    await newResearch(page); await openSettings(page);
    await page.locator('#remember-key').setChecked(false);
    assert.equal((await storage(page)).tab, null, 'unticking forgets');
    await page.locator('#remember-key').setChecked(true);
    assert.ok((await storage(page)).tab?.includes(credential), 'ticking again remembers the key in the field');
    await page.locator('#forget-key').click();
    await page.locator('#toast').filter({ hasText: '已清除此标签页记住的 API Key' }).waitFor();
    assert.equal((await storage(page)).tab, null); assert.equal(await keyField(page), '');
    assert.equal(await page.locator('#remember-key').isChecked(), false); assert.equal(await page.locator('#forget-key').isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'api-key', 'focus goes to the key field');
    await closeSettings(page);
  });

  await scenario('a key the provider rejected is forgotten when the reader goes to change it', async h => {
    const { page } = h;
    await submit(h, 'Please reject', { key: credential, remember: true });
    // The recovery actions sit in the run's result, opened from the chat.
    await showArtifacts(page);
    await page.locator('[data-recovery="key"]').click();
    await page.locator('#run-settings[open]').waitFor(); await settled(page);
    assert.equal(await keyField(page), ''); assert.equal((await storage(page)).tab, null);
    assert.equal(await page.locator('#remember-key').isChecked(), false);
    await closeSettings(page);
  });

  await scenario('the option reads in English', async h => {
    const { page } = h; await openSettings(page);
    const text = await page.locator('#settings-connection').innerText();
    for (const value of ['Remember in this tab', 'Cleared when this tab closes. Used for this provider only.']) assert.ok(text.includes(value), `English shows ${value}`);
    await closeSettings(page);
  }, { locale: 'en' });

  for (const width of [375, 320]) await scenario(`the option fits ${width}px`, async h => {
    const { page } = h;
    await submit(h, 'First', { key: credential, remember: true });
    await newResearch(page); await openSettings(page);
    await page.locator('#forget-key').scrollIntoViewIfNeeded();
    for (const selector of ['.key-memory-option', '#forget-key', '#key-memory-note']) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1, `${selector} must fit ${width}px: ${JSON.stringify(box)}`);
    }
    await page.screenshot({ path: path.join(output, `remembered-${width}.png`) }); screenshots.push(`remembered-${width}.png`);
    await closeSettings(page);
  }, { width });

  await scenario('a replacement anonymous session cannot restore the previous owner draft or remembered key after a reload', async h => {
    const { page, context } = h;
    await submit(h, 'Owner boundary', { key: credential, remember: true });
    await newResearch(page);
    await fillConfig(page, 'source', 'theorem previous_anonymous_owner : True := by sorry');
    await page.locator('#open-natural-language').click();
    const draft = 'previous_anonymous_owner_private_natural_draft';
    await page.locator('#formalize-original').fill(draft);
    const owner = await page.evaluate(async () => (await (await fetch('/api/session')).json()).draftOwner);
    await page.reload(); await ready(page);
    await page.locator('#open-natural-language').click();
    assert.equal(await page.locator('#formalize-original').inputValue(), draft, 'The same anonymous session keeps its draft');
    await context.clearCookies();
    await page.reload(); await ready(page);
    const next = await page.evaluate(async () => (await (await fetch('/api/session')).json()).draftOwner);
    assert.notEqual(next, owner, 'The cookie change creates a different anonymous owner');
    await page.locator('#open-natural-language').click();
    assert.equal(await page.locator('#formalize-original').inputValue(), '', 'A new anonymous owner starts with a blank natural draft');
    const stored = await storage(page);
    assert.equal(stored.tab, null, 'A remembered key belongs only to its original anonymous owner');
    assert.ok(!stored.session.includes(draft) && !stored.session.includes(credential));
  });

  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined, 'local-real-http-key-memory',
    { checks: suite.checks, leanProcesses: 0, screenshots }, { credential });
  console.log('Key memory browser checks passed');
} catch (raw) {
  // Assertion messages quote field values; the report must not carry the fixture key.
  const error = raw instanceof Error ? Object.assign(new Error(raw.message.split(credential).join('[key]')), { stack: raw.stack?.split(credential).join('[key]') }) : raw;
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-key-memory',
    { checks: suite.checks, leanProcesses: 0 }, { credential, failureRequests: true }); throw error;
} finally {
  await browser.close(); await service.close();
}
