#!/usr/bin/env bun
// Real browser cookie ordering and session recovery with disposable loopback accounts only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page, Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebSession } from '../apps/web/shared';
import { deferred, freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/frontend-round7/session');
await fs.access(path.join(root, 'out/web/research.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round7-session-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const mail: { to: string; text: string }[] = [], errors: string[] = [], external: string[] = [], checks: object[] = [];
let runnerCalls = 0;
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Disposable session cookie regression' }; },
  async run() { runnerCalls++; throw new Error('Session regressions must not start research'); } };
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_AUTH: 'email',
  THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org', THEOREMOS_WEB_SESSION_TTL_SECONDS: '60' });
const service = createWebService(config, runner, { sample: null, mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const browser = await startBrowser(service.server, port), contexts: BrowserContext[] = [];
const password = 'Disposable-Round7-Session-Only-2026';
const realNow = Date.now;
let phase = 'setup', current: Page | undefined;
async function context(width = 1440) {
  const value = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 1000 }, reducedMotion: 'reduce' }); contexts.push(value);
  await value.addInitScript(() => { try { localStorage.setItem('theorem-os.locale.v1', 'zh'); } catch { /* about:blank has no storage. */ } });
  await value.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  value.on('page', page => { page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message)); });
  return value;
}
async function session(value: BrowserContext): Promise<WebSession> {
  const response = await value.request.get(origin + '/api/session'); assert.equal(response.status(), 200); return response.json();
}
async function call(value: BrowserContext, method: string, pathname: string, input?: unknown) {
  const web = await session(value);
  const response = await value.request.fetch(origin + pathname, { method, headers: { 'X-CSRF-Token': web.csrfToken, 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { data: input }) });
  const body = await response.json(); assert.ok(response.ok(), `${method} ${pathname}: ${response.status()} ${body.error}`); return body;
}
async function register(value: BrowserContext, name: 'Alice' | 'Bob') {
  const email = name.toLowerCase() + '@example.org', captcha = await call(value, 'POST', '/api/auth/captcha', {});
  await call(value, 'POST', '/api/auth/code', { email, captchaId: captcha.id, captcha: '24680' });
  const code = mail.findLast(item => item.to === email)?.text.match(/\b\d{6}\b/u)?.[0]; assert.ok(code);
  await call(value, 'POST', '/api/auth/verify', { email, code });
  await call(value, 'PATCH', '/api/auth/password', { password });
  await call(value, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(), expectedRevision: 0,
    displayName: name, bio: name + ' stored biography', fields: ['algebra'], links: [], visibility: 'public' });
}
async function login(value: BrowserContext, name: 'Alice' | 'Bob') {
  await call(value, 'POST', '/api/auth/password/login', { email: name.toLowerCase() + '@example.org', password });
  const web = await session(value); assert.equal(web.account?.email, name.toLowerCase() + '@example.org'); return web;
}
const frames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
async function lateBootstrap(nextPerson: 'Alice' | 'Bob', width: number) {
  const value = await context(width); await login(value, 'Alice');
  const page = current = await value.newPage(); await page.goto(origin + '/people.html');
  await page.getByText('编辑我的资料', { exact: true }).click();
  const draft = page.getByRole('textbox', { name: '简介', exact: true }), text = 'UNSENT_ALICE_DRAFT_' + nextPerson;
  await draft.fill(text); await draft.evaluate(input => input.setAttribute('data-session-draft-marker', 'original'));
  const reached = deferred(), release = deferred(), verifying = deferred(), confirm = deferred();
  let firstVerification = true;
  const holdVerification = async (route: Route) => {
    if (!firstVerification) { await route.continue(); return; } firstVerification = false;
    const response = await route.fetch(); verifying.resolve(); await confirm.promise; await route.fulfill({ response });
  };
  await page.route('**/api/research/session', holdVerification);
  let first = true, captured: { cookie: string; session: WebSession } | undefined;
  const hold = async (route: Route) => {
    if (!first) { await route.continue(); return; } first = false;
    // Independent fetch does not apply Set-Cookie to Chromium until fulfill below releases the actual response.
    const request = route.request(), response = await fetch(request.url(), { headers: request.headers() });
    const headers = Object.fromEntries(response.headers.entries()), body = Buffer.from(await response.arrayBuffer());
    captured = { cookie: headers['set-cookie']!, session: JSON.parse(body.toString()) };
    reached.resolve(); await release.promise; await route.fulfill({ status: response.status, headers, body });
  };
  await page.route('**/api/session', hold);
  try {
    const expiredAt = realNow() + 61_001; Date.now = () => expiredAt;
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await reached.promise; Date.now = realNow;
    assert.ok(captured); assert.equal(captured.session.account, undefined);
    assert.match(captured.cookie, /^theoremos_bootstrap=/u); assert.equal(captured.cookie.includes('theoremos_session='), false);
    const newer = await login(value, nextPerson);
    const identityBefore = (await value.cookies(origin)).find(item => item.name === 'theoremos_session')?.value; assert.ok(identityBefore);
    const delivered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session');
    release.resolve(); await (await delivered).finished(); await verifying.promise; await frames(page);
    const retainedEditor = page.locator('[data-session-draft-marker="original"]');
    assert.equal(await retainedEditor.count(), 1); assert.equal(await retainedEditor.inputValue(), text);
    assert.equal(await retainedEditor.isVisible(), false);
    assert.equal(await retainedEditor.evaluate(input => Boolean(input.closest('[inert][aria-hidden="true"]'))), true);
    confirm.resolve();
    const identityAfter = (await value.cookies(origin)).find(item => item.name === 'theoremos_session')?.value;
    const live = await session(value);
    assert.equal(identityAfter, identityBefore); assert.equal(live.account?.email, newer.account?.email);
    await page.getByRole('heading', { name: nextPerson, exact: true }).waitFor();
    await page.locator('main[aria-busy="false"]').waitFor(); await frames(page);
    const staleCsrf = await value.request.patch(origin + '/api/auth/account', {
      headers: { 'X-CSRF-Token': captured.session.csrfToken }, data: { completionEmail: false } });
    assert.equal(staleCsrf.status(), 403); assert.notEqual((await session(value)).account?.completionEmail, false);
    const draftRetained = await draft.count() > 0 && await draft.inputValue() === text;
    const originalEditorRetained = await draft.count() > 0 && await draft.getAttribute('data-session-draft-marker') === 'original';
    const result = { name: phase, nextPerson, width, bootstrapUsesSeparateCookie: true, signedInCookieUnchanged: true,
      activeAccount: live.account?.email, staleAnonymousCsrf: 403, draftRetained, originalEditorRetained,
      oldEditorMountedDuringVerification: true, oldEditorHiddenAndInertDuringVerification: true };
    checks.push(result);
    await page.screenshot({ path: path.join(output, nextPerson === 'Alice' ? 'same-account-draft-after-late-bootstrap.png' : 'new-account-after-late-bootstrap.png'), fullPage: true });
    if (nextPerson === 'Alice') assert.ok(draftRetained && originalEditorRetained, 'Same-account reauthentication must retain the previous unsent editor draft');
    else assert.equal(draftRetained, false, 'An Alice draft must not be mounted for Bob');
    let webReads = 0, researchReads = 0;
    const count = (request: import('playwright').Request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/api/session') webReads++;
      if (pathname === '/api/research/session') researchReads++;
    };
    page.on('request', count);
    const focused = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session');
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await (await focused).finished(); await frames(page);
    await page.locator('main[aria-busy="false"]').waitFor(); page.off('request', count);
    assert.equal(webReads, 1); assert.equal(researchReads, 0);
  } finally {
    Date.now = realNow; release.resolve(); confirm.resolve();
    await page.unroute('**/api/session', hold); await page.unroute('**/api/research/session', holdVerification); await value.close();
  }
}
try {
  const alice = await context(), bob = await context(); await register(alice, 'Alice'); await register(bob, 'Bob');
  await alice.close(); await bob.close();
  phase = 'expired anonymous bootstrap arrives after another tab logs in as Bob';
  await lateBootstrap('Bob', 1440);
  phase = 'expired anonymous bootstrap arrives after same-account reauthentication';
  await lateBootstrap('Alice', 390);

  phase = 'legacy anonymous cookie, terms, password UI login and logout remain compatible';
  const legacy = await context(390), anonymous = await session(legacy);
  const cookie = (await legacy.cookies(origin)).find(item => item.name === 'theoremos_bootstrap')!;
  assert.ok(cookie); await legacy.clearCookies();
  await legacy.addCookies([{ name: 'theoremos_session', value: cookie.value, url: origin, httpOnly: true, sameSite: 'Strict' }]);
  assert.equal((await session(legacy)).csrfToken, anonymous.csrfToken);
  const page = current = await legacy.newPage(); await page.goto(origin + '/login.html');
  await page.locator('#use-password').click(); await page.locator('#password-submit:enabled').waitFor();
  await page.locator('#password-email').fill('alice@example.org'); await page.locator('#login-password').fill(password);
  await page.locator('#password-submit').click(); await page.waitForURL(origin + '/');
  await page.locator('#open-account').click(); await page.locator('#account-email').getByText('alice@example.org', { exact: true }).waitFor();
  const logged = await session(legacy); assert.equal(logged.account?.email, 'alice@example.org');
  config.auth!.termsVersion = 'round7-session-v2';
  assert.equal((await session(legacy)).termsRequired, true);
  const gated = await legacy.request.get(origin + '/api/research/session'); assert.equal(gated.status(), 428);
  await call(legacy, 'POST', '/api/auth/terms', { terms: true, termsVersion: 'round7-session-v2' });
  assert.equal((await session(legacy)).csrfToken, logged.csrfToken);
  await page.screenshot({ path: path.join(output, 'legacy-cookie-mobile-login.png'), fullPage: true });
  const logout = await legacy.request.post(origin + '/api/auth/logout', { headers: { 'X-CSRF-Token': logged.csrfToken }, data: {} });
  assert.equal(logout.status(), 200);
  assert.equal((await legacy.cookies(origin)).some(item => item.name === 'theoremos_session' || item.name === 'theoremos_bootstrap'), false);
  const signedOut = await session(legacy); assert.equal(signedOut.account, undefined); assert.notEqual(signedOut.csrfToken, logged.csrfToken);
  assert.ok((await legacy.cookies(origin)).some(item => item.name === 'theoremos_bootstrap'));
  checks.push({ name: phase, legacyAnonymousAccepted: true, passwordUiLogin: true, termsGate: 428, termsAccepted: true, csrfRetainedAcrossTerms: true,
    bothCookiesClearedAtLogout: true, nextAnonymousBootstrap: true });
  await legacy.close();
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(runnerCalls, 0);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, errors, external,
    realModels: 0, realLean: 0, externalMail: 0, runnerCalls, productionTouched: false }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }));
} catch (error) {
  await current?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ phase, error: String(error), checks, errors, external }, null, 2) + '\n'); throw error;
} finally {
  Date.now = realNow; await Promise.all(contexts.map(value => value.close())); await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
