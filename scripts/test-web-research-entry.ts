#!/usr/bin/env bun
// Real loopback HTTP and browser login. Codes are delivered to an in-memory fixture, never to SMTP.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Cookie, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { localeStorageKey } from '../apps/web/i18n';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { readResearchEntry, researchEntryQuery, resolveResearchEntry } from '../apps/web/client/researchEntry';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/entry');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.access(path.join(staticRoot, 'practice.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-entry-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const emails = ['zh-statement', 'zh-lean', 'en-statement', 'en-lean'].map(name => `${name}@example.org`);
const mail: { to: string; text: string }[] = [], errors: string[] = [], external: string[] = [], businessWrites: string[] = [];
const checks: object[] = [], failures: object[] = [];
const runtimeCalls = { run: 0, formalize: 0, check: 0 };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable entry and login fixture' }; },
  async run() { runtimeCalls.run++; throw new Error('Preparing an entry must not start research'); },
  async formalize() { runtimeCalls.formalize++; throw new Error('Preparing an entry must not call a model'); },
  async check() { runtimeCalls.check++; throw new Error('Preparing an entry must not invoke Lean'); },
};
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_AUTH: 'email',
  THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: emails.join(','),
  THEOREMOS_WEB_PROVIDERS: JSON.stringify([{ id: 'fixture', name: 'Local fixture', baseUrl: 'https://provider.invalid/v1' }]) });
const service = createWebService(config, runner, { sample: null, mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const browser = await startBrowser(service.server, port);
let seedCookies: Cookie[] | undefined;

async function scenario(name: string, language: 'zh' | 'en', signedIn: boolean, run: (page: Page, context: BrowserContext) => Promise<object>) {
  const context = await browser.newContext({ viewport: { width: language === 'zh' ? 1440 : 390, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' });
  await context.addInitScript(({ key, value }) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); } catch { /* A scenario deliberately blocks local storage. */ }
  }, { key: localeStorageKey, value: language });
  if (signedIn) { assert.ok(seedCookies); await context.addCookies(seedCookies); }
  await context.route(/^https?:\/\//u, async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
    if (request.method() !== 'GET' && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/')) {
      businessWrites.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 422, json: { error: 'This draft-only fixture cannot start a task' } }); return;
    }
    await route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', error => errors.push(`${name}: ${error.stack || error.message}`));
  try {
    checks.push({ name, ...await run(page, context) });
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true }); console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message : String(error), url: page.url() });
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true }).catch(() => {});
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally { await context.close(); }
}
async function expectLanguage(page: Page, language: 'zh' | 'en') {
  await page.waitForFunction(language => document.documentElement.lang === (language === 'en' ? 'en-US' : 'zh-CN'), language, { timeout: 4000 });
}
async function login(page: Page, address: string) {
  await page.locator('#send-code:enabled').waitFor();
  await page.locator('#login-email').fill(address); await page.locator('#login-captcha').fill('24680');
  if (await page.locator('#terms-option').isVisible()) await page.locator('#accept-terms').check();
  await page.locator('#send-code').click(); await page.locator('#code-step:visible').waitFor();
  const code = mail.findLast(item => item.to === address)?.text.match(/\b\d{6}\b/u)?.[0]; assert.ok(code);
  await page.locator('#login-code').fill(code); await page.locator('#verify-code').click();
  await page.waitForURL(url => url.pathname === '/'); await page.locator('#open-account').waitFor();
}
try {
  for (const language of ['zh', 'en'] as const) for (const kind of ['statement', 'lean'] as const) {
    await scenario(`${language}-${kind}-login-continuity`, language === 'zh' ? 'en' : 'zh', false, async (page, context) => {
      const entry = readResearchEntry(`?entry=${kind}&lang=${language}`)!;
      const query = researchEntryQuery(entry);
      await page.goto(`${origin}/${query}&text=do-not-carry-problem-text&target=https%3A%2F%2Fexample.org`);
      await page.waitForURL(url => url.pathname === '/login.html');
      const redirect = new URL(page.url());
      assert.deepEqual([...redirect.searchParams.keys()].sort(), ['entry', 'environment', 'lang', 'template']);
      assert.equal(redirect.search, query); await expectLanguage(page, language);
      await login(page, `${language}-${kind}@example.org`);
      if (!seedCookies) seedCookies = await context.cookies(origin);
      await page.waitForFunction(() => !new URL(location.href).searchParams.has('entry'));
      await expectLanguage(page, language);
      const web = await (await context.request.get(`${origin}/api/session`)).json();
      const draft = resolveResearchEntry(entry, web.templates)!; assert.ok(draft);
      if (kind === 'statement') {
        await page.locator('body[data-entry=natural]').waitFor({ state: 'attached' });
        assert.equal(await page.locator('#formalize-original').inputValue(), draft.statement);
        assert.equal(await page.locator('#formalize-environment').inputValue(), 'mathlib');
        assert.equal(await page.locator('#formalize-start').isDisabled(), true);
        await page.waitForFunction(() => {
          const input = document.querySelector<HTMLTextAreaElement>('#formalize-original');
          if (!input) return false;
          const rect = input.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight;
        }, undefined, { timeout: 4000 });
      } else {
        await page.locator('body[data-entry=lean]').waitFor({ state: 'attached' });
        assert.equal(await page.locator('#source').inputValue(), draft.source);
        assert.equal(await page.locator('#environment').inputValue(), 'mathlib');
        assert.equal(await page.locator('#template').inputValue(), 'polynomial');
        await page.waitForFunction(() => {
          const input = document.querySelector<HTMLTextAreaElement>('#source');
          if (!input) return false;
          const rect = input.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight;
        }, undefined, { timeout: 4000 });
      }
      assert.equal(new URL(page.url()).searchParams.get('lang'), language, 'Workbench navigation must preserve the explicit linked language');
      assert.deepEqual((await (await context.request.get(`${origin}/api/runs`)).json()).runs, []);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), localeStorageKey), language);
      return { kind, language, environment: draft.environment, loginRedirect: redirect.pathname + redirect.search, preparedOnly: true,
        preparedDraftVisible: true };
    });
  }
  await scenario('legacy-login-locale-switch', 'zh', false, async page => {
    await page.goto(`${origin}/login.html`); await page.locator('#send-code:enabled').waitFor();
    await page.locator('#login-email').fill('draft@example.org');
    await page.locator('#locale-switch').click(); await expectLanguage(page, 'en');
    assert.equal(await page.locator('#login-email').inputValue(), 'draft@example.org');
    await page.locator('#locale-switch').click(); await expectLanguage(page, 'zh');
    assert.equal(new URL(page.url()).search, ''); return { noLinkedLanguage: true, switchedBothWays: true, emailPreserved: true };
  });
  await scenario('legacy-workbench-locale-switch', 'zh', true, async page => {
    await page.goto(origin); await page.locator('#formalize-original').waitFor();
    await page.locator('#formalize-original').fill('Legacy draft survives a language change.');
    await page.locator('#locale-switch').click(); await expectLanguage(page, 'en');
    assert.equal(await page.locator('#formalize-original').inputValue(), 'Legacy draft survives a language change.');
    await page.locator('#locale-switch').click(); await expectLanguage(page, 'zh');
    return { noLinkedLanguage: true, switchedBothWays: true, draftPreserved: true };
  });
  await scenario('linked-login-locale-switch', 'zh', false, async page => {
    await page.goto(`${origin}/?entry=statement&template=add-zero&environment=standard&lang=zh`);
    await page.locator('#send-code:enabled').waitFor(); await page.locator('#locale-switch').click();
    await expectLanguage(page, 'en');
    assert.equal(new URL(page.url()).searchParams.get('entry'), 'statement');
    return { linkedLanguage: true, userCanOverride: true, entryPreserved: true };
  });
  await scenario('linked-workbench-locale-switch', 'zh', true, async page => {
    await page.goto(`${origin}/?entry=statement&template=add-zero&environment=standard&lang=zh`);
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('entry'));
    await page.locator('#formalize-original').waitFor(); await page.locator('#locale-switch').click();
    await expectLanguage(page, 'en'); return { linkedLanguage: true, userCanOverrideAfterEntryConsumed: true };
  });
  await scenario('linked-language-survives-refresh-without-storage', 'zh', true, async (page, context) => {
    await context.addInitScript(() => Object.defineProperty(window, 'localStorage', {
      configurable: true, get() { throw new DOMException('Local storage disabled in this scenario', 'SecurityError'); },
    }));
    await page.goto(`${origin}/?entry=lean&template=polynomial&environment=mathlib&lang=en`);
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('entry'));
    await page.locator('body[data-entry=lean]').waitFor({ state: 'attached' });
    await expectLanguage(page, 'en');
    await page.reload(); await page.locator('#open-account').waitFor();
    await expectLanguage(page, 'en');
    assert.equal(new URL(page.url()).searchParams.get('lang'), 'en');
    return { localStorageAvailable: false, linkedLanguage: 'en', languageSurvivesRefresh: true };
  });
  await scenario('public-recorded-practice-without-login', 'en', false, async page => {
    const api: string[] = []; page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) api.push(new URL(request.url()).pathname); });
    await page.goto(`${origin}/practice.html?lang=en`); await page.locator('[data-research-practice]').waitFor();
    assert.equal(new URL(page.url()).pathname, '/practice.html');
    assert.match(await page.locator('h1').innerText(), /research decisions/u);
    assert.deepEqual(api, []); return { signedIn: false, publicStaticPage: true, apiRequests: 0 };
  });
  await scenario('redirect-drops-invalid-template-and-private-text', 'zh', false, async (page, context) => {
    const response = await context.request.get(`${origin}/?entry=lean&template=private-template&environment=mathlib&lang=en&text=private`, { maxRedirects: 0 });
    assert.equal(response.status(), 302); assert.equal(response.headers().location, '/login.html?lang=en');
    await page.goto(`${origin}${response.headers().location}`); await page.locator('#send-code:enabled').waitFor();
    return { invalidTemplateIgnored: true, privateTextNotForwarded: true };
  });
  assert.deepEqual(runtimeCalls, { run: 0, formalize: 0, check: 0 });
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(businessWrites, []);
} finally {
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, failures, errors, external, businessWrites, runtimeCalls, fixtureMailCount: mail.length, realMailSent: false }, null, 2));
}
assert.deepEqual(failures, [], 'Research entry integration failures; see report.json');
console.log(`Research entry continuity passed ${checks.length} scenarios. No model, Lean or real mail.`);
