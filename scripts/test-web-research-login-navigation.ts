#!/usr/bin/env bun
// Real login and navigation on disposable local services; no external mail, model, Lean or task execution.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import type { WebConversation } from '../apps/web/conversationTypes';
import { localeStorageKey } from '../apps/web/i18n';
import type { WebRunner } from '../apps/web/runner';
import { createWebService } from '../apps/web/server';
import { loginHref } from '../apps/web/shared';
import { audit } from './web-a11y';
import { freePort } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/web-research-login-navigation');
await fs.access(path.join(root, 'out/web/login.js'));
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-research-navigation-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const mail: { to: string; text: string }[] = [], forbiddenCalls: string[] = [], external: string[] = [], writes: string[] = [], errors: string[] = [];
const forbidden = (name: string): never => { forbiddenCalls.push(name); throw new Error(`Navigation cannot invoke runner.${name}`); };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local login and navigation fixture' }; },
  async run() { return forbidden('run'); }, async formalize() { return forbidden('formalize'); },
  async check() { return forbidden('check'); }, async command() { return forbidden('command'); }, async explain() { return forbidden('explain'); },
};
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: temporary,
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'navigation@example.org' });
const service = createWebService(config, runner, { sample: null, captchaAnswer: () => '24680', mailer: async message => { mail.push(message); } });
service.server.requestTimeout = 0; service.server.headersTimeout = 0; service.server.setTimeout(0);
await new Promise<void>((resolve, reject) => { service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolve); });
const browser = await chromium.launch({ headless: true, timeout: 0 });
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
const chatId = crypto.randomUUID(), savedAt = '2026-11-10T07:00:00.000Z';
const conversation: WebConversation = { id: chatId, title: 'Retained navigation conversation', createdAt: savedAt, updatedAt: savedAt,
  messages: [{ id: crypto.randomUUID(), role: 'user', kind: 'text', text: 'Return to this existing conversation without starting any research.', createdAt: savedAt, status: 'complete' }] };
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin) { external.push(request.url()); await route.abort(); return; }
  if (!['GET', 'HEAD'].includes(request.method()) && !url.pathname.startsWith('/api/auth/')) {
    writes.push(`${request.method()} ${url.pathname}`); await route.abort(); return;
  }
  if (url.pathname === `/api/conversations/${chatId}`) { await route.fulfill({ json: { conversation } }); return; }
  if (url.pathname === '/api/conversations' && request.method() === 'GET') {
    const { messages: _, ...summary } = conversation;
    await route.fulfill({ json: { conversations: [{ ...summary, answering: false }] } }); return;
  }
  await route.continue();
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const checks: string[] = [], screenshots: string[] = [];
const mark = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
async function screenshot(name: string, fullPage = true) {
  await page.screenshot({ path: path.join(output, name), fullPage, timeout: 0 }); screenshots.push(name);
}
async function returned(target: string) {
  const expected = new URL(target, origin);
  await page.waitForURL(url => url.pathname === expected.pathname && url.search === expected.search && url.hash === expected.hash, { timeout: 0 });
  assert.equal(new URL(page.url()).origin, origin);
  await page.locator('.research-shell').waitFor({ timeout: 0 });
}
async function logout() {
  const response = await page.request.get(origin + '/api/session', { timeout: 0 });
  const session = await response.json();
  const result = await page.request.post(origin + '/api/auth/logout', { timeout: 0, headers: { 'X-CSRF-Token': session.csrfToken }, data: {} });
  assert.equal(result.status(), 200);
}
async function fit() {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'navigation fits the viewport');
  assert.deepEqual(await audit(page), []);
}
const labels = ['工作台', '我的研究', '定理', '数学家', 'Library'];
async function navigation() {
  const desktop = page.locator('#topbar .research-space-links');
  if (await desktop.isVisible()) return desktop;
  const menu = page.locator('[data-research-mobile-navigation]');
  await menu.locator('summary').click();
  await menu.locator('nav').waitFor({ timeout: 0 });
  return menu.locator('nav');
}
let failure: unknown;
try {
  const theoremTarget = '/theorems.html?q=Galois+groups&field=algebra&sort=updated&offset=20&create=1&person=example-researcher#new-theorem';
  await page.goto(origin + loginHref(theoremTarget), { timeout: 0 });
  await page.locator('#send-code:enabled').waitFor({ timeout: 0 });
  await page.locator('#login-email').fill('navigation@example.org');
  await page.locator('#login-captcha').fill('24680');
  await page.locator('#send-code').click();
  await page.locator('#code-step:not([hidden])').waitFor({ timeout: 0 });
  const code = mail.at(-1)?.text.match(/\b\d{6}\b/u)?.[0]; assert.ok(code, 'the disposable mail fixture captures the code');
  await page.locator('#login-code').fill(code); await page.locator('#verify-code').click();
  await returned(theoremTarget); await fit(); await screenshot('email-return-theorem.png');
  mark('email login returns to the exact theorem filters, create intent, person and fragment without creating or following anything');

  const peopleTarget = '/people.html?q=Galois&field=algebra&offset=20#follow-researcher';
  await page.goto(origin + loginHref(peopleTarget), { timeout: 0 });
  await returned(peopleTarget); await fit(); await screenshot('signed-in-return-people.png');
  mark('an already signed-in visitor returns to the exact mathematician directory and follow intent without a write');

  const password = 'disposable-navigation-password';
  await service.auth!.setPassword('navigation@example.org', password, undefined, true);
  await logout();
  const libraryTarget = '/library.html?type=skill&q=algebra&create=1&workbenchChat=' + chatId + '#new-asset';
  await page.goto(origin + loginHref(libraryTarget), { timeout: 0 });
  await page.locator('#password-submit:enabled').waitFor({ state: 'attached', timeout: 0 });
  await page.locator('#use-password').click();
  await page.locator('#password-email').fill('navigation@example.org');
  await page.locator('#login-password').fill(password); await page.locator('#password-submit').click();
  await returned(libraryTarget); await fit(); await screenshot('password-return-library.png');
  mark('password login returns to Library filters and create intent with the original workbench conversation');

  config.auth!.termsVersion = 'navigation-v2';
  await page.goto(origin + loginHref(peopleTarget), { timeout: 0 });
  await page.locator('#terms-step:not([hidden])').waitFor({ timeout: 0 });
  await page.locator('#accept-terms').check(); await page.locator('#confirm-terms').click();
  await returned(peopleTarget);
  mark('accepting updated terms returns to the same research page instead of discarding its filters');

  await page.goto(origin + '/login.html?' + new URLSearchParams({ returnTo: '//outside.example/theorems.html?create=1' }), { timeout: 0 });
  await page.waitForURL(url => url.origin !== origin || url.pathname === '/', { timeout: 0 });
  assert.equal(new URL(page.url()).origin, origin); assert.equal(new URL(page.url()).pathname, '/');
  mark('an external or malformed login return falls back to the same-site workbench');

  await page.goto(origin + '/login.html?' + new URLSearchParams({ chat: chatId }), { timeout: 0 });
  await page.waitForURL(url => url.pathname === '/' && url.searchParams.get('chat') === chatId, { timeout: 0 });
  await page.locator('#research-chat-thread').getByText(conversation.messages[0]!.text, { exact: true }).waitFor({ timeout: 0 });
  mark('legacy chat login links continue to return to their existing conversation');

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${origin}/?chat=${chatId}`, { timeout: 0 });
    await page.locator('#research-chat-thread').getByText(conversation.messages[0]!.text, { exact: true }).waitFor({ timeout: 0 });
    const draft = `${width}px: retain this unsent draft across the shared navigation`;
    await page.locator('#formalize-original').fill(draft);
    for (const destination of ['theorems', 'people', 'library'] as const) {
      const nav = await navigation();
      assert.deepEqual(await nav.locator('a').allTextContents(), labels);
      const links = await nav.locator('a').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, href: (node as HTMLAnchorElement).href })));
      for (const link of links) {
        const url = new URL(link.href);
        assert.equal(url.origin, origin);
        assert.equal(url.searchParams.get(link.text === '工作台' ? 'chat' : 'workbenchChat'), chatId);
      }
      if (destination === 'theorems') { await fit(); await screenshot(`workbench-navigation-${width}.png`); }
      await nav.locator(`a[href^="${destination}.html"]`).click();
      await page.waitForURL(url => url.pathname === `/${destination}.html` && url.searchParams.get('workbenchChat') === chatId, { timeout: 0 });
      const shared = page.locator('.research-nav'); await shared.waitFor({ timeout: 0 });
      assert.deepEqual(await shared.locator('a').allTextContents(), labels);
      for (const link of await shared.locator('a').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, href: (node as HTMLAnchorElement).href })))) {
        const url = new URL(link.href);
        assert.equal(url.searchParams.get(link.text === '工作台' ? 'chat' : 'workbenchChat'), chatId);
      }
      await fit(); await screenshot(`${destination}-navigation-${width}.png`, false);
      await shared.getByRole('link', { name: '工作台', exact: true }).click();
      await page.waitForURL(url => url.pathname === '/' && url.searchParams.get('chat') === chatId, { timeout: 0 });
      await page.locator('#research-chat-thread').getByText(conversation.messages[0]!.text, { exact: true }).waitFor({ timeout: 0 });
      assert.equal(await page.locator('#formalize-original').inputValue(), draft);
    }
    mark(`${width}px: all four destinations are reachable and each research page returns to the original conversation and unsent draft`);
  }

  await logout();
  const anonymousLibraryTarget = '/library.html?type=skill&q=radicals&workbenchChat=' + chatId + '&tag=algebra';
  await page.goto(origin + anonymousLibraryTarget, { timeout: 0 });
  const createAsset = page.getByRole('link', { name: '登录后创建成果', exact: true });
  await createAsset.waitFor({ timeout: 0 });
  const expectedCreate = new URL(anonymousLibraryTarget, origin);
  expectedCreate.searchParams.set('create', '1'); expectedCreate.hash = 'new-asset';
  const createLogin = new URL(await createAsset.getAttribute('href') ?? '', page.url());
  assert.equal(createLogin.pathname, '/login.html');
  assert.equal(createLogin.searchParams.get('returnTo'), expectedCreate.pathname + expectedCreate.search + expectedCreate.hash);
  await createAsset.click();
  await page.locator('#password-submit:enabled').waitFor({ state: 'attached', timeout: 0 });
  await screenshot('library-anonymous-create-login.png', false);
  await page.locator('#use-password').click(); await page.locator('#password-email').fill('navigation@example.org');
  await page.locator('#accept-terms').check();
  await page.locator('#login-password').fill(password); await page.locator('#password-submit').click();
  await returned(expectedCreate.pathname + expectedCreate.search + expectedCreate.hash);
  await page.locator('#new-asset').waitFor({ timeout: 0 });
  await fit(); await screenshot('library-create-intent-return.png', false);
  mark('the real anonymous Library create link preserves all filters and chat, then opens the creation panel after login without creating an asset');
  assert.deepEqual(writes, []); assert.deepEqual(external, []); assert.deepEqual(forbiddenCalls, []); assert.deepEqual(errors, []);
} catch (error) {
  failure = error;
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 0 }).catch(() => undefined);
  throw error;
} finally {
  await browser.close(); await service.close(); await fs.rm(temporary, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    checks, screenshots, browserTimeouts: 0, deadline: null, tokenLimit: null, roundLimit: null,
    realModelCalls: 0, realLeanProcesses: 0, externalMail: false, fixturesRemoved: true, errors, external, writes, forbiddenCalls,
    ...(failure ? { error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2) + '\n');
}
