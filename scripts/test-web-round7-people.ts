#!/usr/bin/env bun
// Real local HTTP/browser regressions with disposable accounts; no model, Lean or mail delivery.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page, Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { ResearcherProfile } from '../apps/web/researchProjectTypes';
import type { WebRunner } from '../apps/web/runner';
import { deferred, freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_ROUND7_PEOPLE_OUTPUT ?? path.join(root, 'out/web-round7-people');
await fs.access(path.join(root, 'out/web/research.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round7-people-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const mail: Array<{ to: string; text: string }> = [], pageErrors: string[] = [], external: string[] = [], checks: object[] = [], layouts: object[] = [];
let runnerCalls = 0;
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Disposable account and profile regression fixture' }; },
  async run() { runnerCalls++; throw new Error('People regressions must not start research runs'); } };
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_AUTH: 'email',
  THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org,carol@example.org' }), runner,
  { sample: null, mailer: async message => { mail.push(message); }, captchaAnswer: () => '13579' });
type BodyGate = { method: string; pathname: string; started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
let nextGate: BodyGate | undefined;
const gates: BodyGate[] = [];
// Keep the server's actual headers and JSON. Only defer end() so fetch checks its headers before the session changes.
service.server.prependListener('request', (request, response) => {
  if (!nextGate || request.method !== nextGate.method || request.url !== nextGate.pathname) return;
  const gate = nextGate; nextGate = undefined;
  const end = response.end.bind(response);
  response.end = ((...args: Parameters<typeof end>) => {
    response.flushHeaders(); gate.started.resolve();
    void gate.release.promise.then(() => end(...args)); return response;
  }) as typeof response.end;
});
const browser = await startBrowser(service.server, port);
const passwords = { Alice: 'Disposable-Alice-Round7-Only-2026', Bob: 'Disposable-Bob-Round7-Only-2026', Carol: 'Disposable-Carol-Round7-Only-2026' };
type Person = keyof typeof passwords;
async function newContext(locale: 'zh' | 'en' = 'zh') {
  const context = await browser.newContext({ locale: locale === 'en' ? 'en-US' : 'zh-CN',
    viewport: { width: locale === 'en' ? 390 : 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(locale => { try { localStorage.setItem('theorem-os.locale.v1', locale); } catch { /* about:blank has no storage. */ } }, locale);
  await context.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  context.on('page', page => { page.setDefaultTimeout(12_000); page.on('pageerror', error => pageErrors.push(error.message)); });
  return context;
}
async function call(context: BrowserContext, method: string, pathname: string, input?: unknown) {
  const session = await (await context.request.get(origin + '/api/session')).json();
  const response = await context.request.fetch(origin + pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
    ...(input === undefined ? {} : { data: input }) });
  return { status: response.status(), body: await response.json() };
}
async function ok(context: BrowserContext, method: string, pathname: string, input?: unknown): Promise<any> {
  const result = await call(context, method, pathname, input);
  assert.ok(result.status >= 200 && result.status < 300, `${method} ${pathname}: ${JSON.stringify(result)}`); return result.body;
}
async function register(context: BrowserContext, name: Person) {
  const email = name.toLowerCase() + '@example.org', captcha = await ok(context, 'POST', '/api/auth/captcha', {});
  await ok(context, 'POST', '/api/auth/code', { email, captchaId: captcha.id, captcha: '13579' });
  const code = mail.findLast(item => item.to === email)?.text.match(/\b\d{6}\b/u)?.[0]; assert.ok(code);
  await ok(context, 'POST', '/api/auth/verify', { email, code });
  await ok(context, 'PATCH', '/api/auth/password', { password: passwords[name] });
  await ok(context, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(), expectedRevision: 0, displayName: name,
    fields: ['algebra'], bio: `${name} starting biography`, links: [], visibility: 'public' });
}
async function login(context: BrowserContext, name: Person) {
  await ok(context, 'POST', '/api/auth/password/login', { email: name.toLowerCase() + '@example.org', password: passwords[name] });
}
const frame = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function screenshot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scrollWidth <= dimensions.width + 1, `${name}: horizontal overflow`);
  layouts.push({ name, ...dimensions }); await page.screenshot({ path: path.join(output, name), fullPage: true });
}
async function showAccount(page: Page, name: Person) {
  if (await page.locator('#account-dialog').evaluate((dialog: HTMLDialogElement) => dialog.open)) await page.locator('#close-account').click();
  await page.locator(`#open-account[title="${name.toLowerCase()}@example.org"]`).waitFor();
  await page.locator('#open-account').click();
  assert.equal(await page.locator('#account-email').textContent(), `${name.toLowerCase()}@example.org`);
}
async function reconnect(page: Page, context: BrowserContext, name: Person) {
  await login(context, name);
  const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/session');
  await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
  await (await response).finished(); await showAccount(page, name);
}
function holdBody(page: Page, method: string, pathname: string) {
  const gate: BodyGate = { method, pathname, started: deferred(), release: deferred() }; gates.push(gate); nextGate = gate;
  const response = page.waitForResponse(reply => reply.request().method() === method && new URL(reply.url()).pathname === pathname);
  return { gate, response };
}
let phase = 'setup', active: Page | undefined, failure: unknown;
try {
  const alice = await newContext(), bob = await newContext(), carol = await newContext();
  await register(alice, 'Alice'); await register(bob, 'Bob'); await register(carol, 'Carol');
  for (const locale of ['zh', 'en'] as const) {
    const text = (zh: string, en: string) => locale === 'en' ? en : zh, label = locale === 'en' ? 'en-390' : 'zh-1440';
    for (const externalUpdate of [false, true]) {
      phase = label + (externalUpdate ? ': reviewed replacement creates a new save intent' : ': unchanged uncertain save recovers the original receipt once');
      const context = await newContext(locale); await context.addCookies(await alice.cookies(origin));
      const page = await context.newPage(); active = page; await page.goto(origin + '/people.html');
      await page.getByText(text('编辑我的资料', 'Edit my profile'), { exact: true }).click();
      const biography = page.getByLabel(text('简介', 'Biography'), { exact: true }), save = page.getByRole('button', { name: text('保存资料', 'Save profile'), exact: true });
      const input = `${label} RETAINED PROFILE ${externalUpdate ? 'NEW INTENT' : 'ORIGINAL RECEIPT'}`;
      const writes: Array<Record<string, unknown>> = []; let first = true, firstSaved: ResearcherProfile | undefined, reviewed: ResearcherProfile | undefined;
      const truncate = async (route: Route) => {
        if (route.request().method() !== 'PUT') { await route.continue(); return; }
        writes.push(route.request().postDataJSON());
        const response = await route.fetch(); assert.equal(response.status(), 200);
        if (first) {
          first = false; firstSaved = (await response.json()).item;
          if (externalUpdate) {
            const current = firstSaved!;
            reviewed = (await ok(alice, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(), expectedRevision: current.revision,
              displayName: current.displayName, fields: current.fields, bio: `${label} OTHER DEVICE NEWER PROFILE`, links: current.links, visibility: current.visibility })).item;
          } else reviewed = firstSaved;
          await route.fulfill({ response, body: '{"item":' });
        } else await route.fulfill({ response });
      };
      await page.route('**/api/research/profile', truncate);
      try {
        await biography.fill(input); await save.click();
        await page.getByText(text('服务器响应未能完整读取，请重试。当前输入已保留。', 'The server response could not be read completely. Please retry. Your input is preserved.'), { exact: true }).waitFor();
        const latest = page.getByRole('region', { name: text('核对最新资料', 'Review the latest profile'), exact: true });
        await latest.waitFor(); assert.ok(reviewed); await latest.getByText(reviewed.bio, { exact: true }).waitFor();
        assert.equal(await biography.inputValue(), input); assert.equal(writes.length, 1);
        await latest.getByRole('button', { name: text('已核对，保留我的编辑', 'Reviewed; keep my edits'), exact: true }).click();
        assert.equal(writes.length, 1, 'Reviewing must not save implicitly');
        const response = page.waitForResponse(reply => reply.request().method() === 'PUT' && new URL(reply.url()).pathname === '/api/research/profile');
        await save.click(); assert.equal((await response).status(), 200);
        await page.getByText(text('已保存。', 'Saved.'), { exact: true }).waitFor();
        const persisted = (await ok(alice, 'GET', '/api/research/session')).profile as ResearcherProfile;
        assert.equal(persisted.bio, input); assert.equal(await biography.inputValue(), input); assert.equal(writes.length, 2);
        if (externalUpdate) {
          assert.notEqual(writes[0].requestId, writes[1].requestId); assert.equal(writes[1].expectedRevision, reviewed.revision);
          assert.equal(persisted.revision, reviewed.revision + 1);
        } else {
          assert.equal(writes[0].requestId, writes[1].requestId); assert.deepEqual(writes[0], writes[1]); assert.equal(persisted.revision, firstSaved!.revision);
        }
        await screenshot(page, `${label}-profile-${externalUpdate ? 'new-intent' : 'original-receipt'}.png`);
        checks.push({ name: phase, passed: true, requestIdReused: !externalUpdate, savedTextMatchesInput: true, writes: writes.map(write => ({ requestId: write.requestId, expectedRevision: write.expectedRevision })), revision: persisted.revision });
      } finally { await page.unroute('**/api/research/profile', truncate); await context.close(); }
    }

    for (const scenario of [{ wanted: false, target: 'Bob' as Person, targetPreference: true },
      { wanted: true, target: 'Bob' as Person, targetPreference: false },
      ...(locale === 'en' ? [{ wanted: false, target: 'Alice' as Person, targetPreference: true }] : [])]) {
      phase = `${label}: late preference body ${scenario.wanted} leaves ${scenario.target} preference ${scenario.targetPreference}`;
      const context = await newContext(locale);
      // Give account-switch scenarios their own login; the final same-owner check can renew the seed session itself.
      if (scenario.target === 'Alice') await context.addCookies(await alice.cookies(origin)); else await login(context, 'Alice');
      await ok(context, 'PATCH', '/api/auth/account', { completionEmail: !scenario.wanted });
      if (scenario.target === 'Bob') await ok(bob, 'PATCH', '/api/auth/account', { completionEmail: scenario.targetPreference });
      const page = await context.newPage(); active = page; await page.goto(origin + '/'); await showAccount(page, 'Alice');
      const pending = holdBody(page, 'PATCH', '/api/auth/account');
      await page.locator('#completion-email').setChecked(scenario.wanted); await pending.gate.started.promise;
      const response = await pending.response; assert.equal(response.status(), 200); await frame(page);
      if (scenario.target === 'Alice') {
        await ok(alice, 'PATCH', '/api/auth/account', { completionEmail: scenario.targetPreference });
      }
      await reconnect(page, context, scenario.target);
      assert.equal(await page.locator('#completion-email').isChecked(), scenario.targetPreference);
      pending.gate.release.resolve(); await response.finished(); await page.locator('#completion-email:enabled').waitFor(); await frame(page);
      await showAccount(page, scenario.target);
      const actual = (await ok(context, 'GET', '/api/session')).account;
      assert.equal(await page.locator('#completion-email').isChecked(), scenario.targetPreference);
      assert.equal(actual.completionEmail !== false, scenario.targetPreference); assert.equal(actual.email, `${scenario.target.toLowerCase()}@example.org`);
      // The current account can still change its preference normally after the old response has been discarded.
      await page.locator('#completion-email').setChecked(!scenario.targetPreference); await page.locator('#completion-email:enabled').waitFor();
      assert.equal((await ok(context, 'GET', '/api/session')).account.completionEmail !== false, !scenario.targetPreference);
      await page.locator('#completion-email').setChecked(scenario.targetPreference); await page.locator('#completion-email:enabled').waitFor();
      assert.equal((await ok(context, 'GET', '/api/session')).account.completionEmail !== false, scenario.targetPreference);
      await screenshot(page, `${label}-preference-${scenario.target}-${scenario.wanted}.png`);
      checks.push({ name: phase, passed: true, actualHeadersDeliveredBeforeRotation: true, oldBodyDiscarded: true, currentPreferenceStillEditable: true });
      if (scenario.target === 'Alice') await alice.addCookies(await context.cookies(origin));
      await context.close();
    }
  }

  phase = 'normal password changes persist; a prior account password body cannot clear the next account form';
  const context = await newContext(); await context.addCookies(await alice.cookies(origin)); const page = await context.newPage(); active = page;
  await page.goto(origin + '/'); await showAccount(page, 'Alice');
  async function passwordFields(current: string, next: string) {
    await page.locator('#account-current-password').fill(current); await page.locator('#account-new-password').fill(next); await page.locator('#account-repeat-password').fill(next);
  }
  const updated = 'Disposable-Alice-Updated-Round7-2026'; await passwordFields(passwords.Alice, updated); await page.locator('#save-password').click();
  await page.locator('#save-password:enabled').waitFor(); assert.equal(await page.locator('#account-new-password').inputValue(), '');
  assert.equal(await page.locator('#account-password-error').isVisible(), false); passwords.Alice = updated;
  const finalPassword = 'Disposable-Alice-Final-Round7-2026'; const passwordPending = holdBody(page, 'PATCH', '/api/auth/password');
  await passwordFields(passwords.Alice, finalPassword); await page.locator('#save-password').click(); await passwordPending.gate.started.promise;
  const passwordResponse = await passwordPending.response; assert.equal(passwordResponse.status(), 200); await frame(page); passwords.Alice = finalPassword;
  await reconnect(page, context, 'Bob'); await passwordFields(passwords.Bob, 'BOB NEW PASSWORD NOT SUBMITTED');
  passwordPending.gate.release.resolve(); await passwordResponse.finished(); await page.locator('#save-password:enabled').waitFor(); await frame(page);
  assert.equal(await page.locator('#account-new-password').inputValue(), 'BOB NEW PASSWORD NOT SUBMITTED');
  assert.equal(await page.locator('#account-repeat-password').inputValue(), 'BOB NEW PASSWORD NOT SUBMITTED');
  assert.equal(await page.locator('#account-current-password').inputValue(), passwords.Bob);
  assert.equal(await page.locator('#account-password-error').isVisible(), false);
  assert.equal((await ok(bob, 'GET', '/api/session')).account.passwordSet, true);
  checks.push({ name: phase, passed: true, normalPasswordChangeAccepted: true, nextAccountPasswordInputsPreserved: true });

  phase = 'a completed prior account logout body cannot navigate or show an error in a new account';
  const logoutPending = holdBody(page, 'POST', '/api/auth/logout'); await page.locator('#logout').click(); await logoutPending.gate.started.promise;
  const logoutResponse = await logoutPending.response; assert.equal(logoutResponse.status(), 200); await frame(page);
  await reconnect(page, context, 'Carol'); logoutPending.gate.release.resolve(); await logoutResponse.finished();
  await page.locator('#logout:enabled').waitFor(); await frame(page);
  assert.equal(new URL(page.url()).pathname, '/'); assert.equal(await page.locator('#account-email').textContent(), 'carol@example.org');
  assert.equal(await page.locator('#account-error').isVisible(), false); assert.equal((await ok(context, 'GET', '/api/session')).account.email, 'carol@example.org');
  checks.push({ name: phase, passed: true, newAccountRetained: true, staleLogoutNavigation: false }); await context.close();
  assert.deepEqual(pageErrors, []); assert.deepEqual(external, []); assert.equal(runnerCalls, 0);
} catch (error) {
  failure = error; await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
} finally {
  for (const gate of gates) gate.release.resolve();
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(), phase,
    ...(failure ? { error: String(failure) } : {}), checks, layouts, pageErrors, externalRequests: external, runnerCalls,
    realModels: false, realLean: false, realMail: false, interceptedMailCount: mail.length, productionWrites: false, disposableFixturesRemoved: true }, null, 2) + '\n');
}
