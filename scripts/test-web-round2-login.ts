#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { localeStorageKey } from '../apps/web/i18n';
import { deferred, freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'out/frontend-round2/login');
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round2-login-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let workerCalls = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local login fixture' }; },
  async run() { workerCalls++; throw new Error('Login must not start a worker.'); },
};
const mail: { to: string; text: string }[] = [];
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: data,
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org' });
const service = createWebService(config, runner, { sample: null,
  mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const errors: string[] = [], external: string[] = [], checks: object[] = [];
let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
let failure: string | undefined;
const releases: Array<() => void> = [];
const progressKey = 'theorem-os.login-progress.v1';

async function loginPage(width = 1440) {
  const context = await browser!.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  await context.addInitScript(key => { if (localStorage.getItem(key) === null) localStorage.setItem(key, 'zh'); }, localeStorageKey);
  await context.route(/^https?:\/\//, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); return; }
    await route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/login.html`);
  await page.locator('#send-code:enabled').waitFor({ state: 'attached' });
  return { page, context };
}
async function send(page: Page, email: string) {
  await page.locator('#login-email').fill(email);
  await page.locator('#login-captcha').fill('24680');
  if (await page.locator('#terms-option').isVisible()) await page.locator('#accept-terms').check();
  await page.locator('#send-code').click();
}
async function forms(page: Page) { return page.locator('form.login-form:visible').evaluateAll(items => items.map(item => item.id)); }
async function secretsAbsent(page: Page, ...secrets: string[]) {
  const progress = await page.evaluate(key => sessionStorage.getItem(key), progressKey);
  assert.ok(progress, 'There should be recoverable login progress.');
  const saved = JSON.parse(progress);
  assert.deepEqual(Object.keys(saved).sort(), ['challenge', 'email', 'owner', 'step']);
  for (const secret of secrets) assert.equal(progress.includes(secret), false, 'A credential was stored with login progress.');
  return saved;
}
try {
  browser = await startBrowser(service.server, port);
  {
    const { page, context } = await loginPage(390);
    const received = deferred(), release = deferred(); releases.push(release.resolve);
    await page.route('**/api/auth/code', async route => {
      const response = await route.fetch(); received.resolve(); await release.promise; await route.fulfill({ response });
    });
    await send(page, 'alice@example.org'); await received.promise;
    await page.locator('#use-password').click();
    const passwordText = 'round-two-password-never-store';
    await page.locator('#login-password').fill(passwordText);
    release.resolve();
    await page.locator('#send-code:enabled').waitFor({ state: 'attached' });
    assert.deepEqual(await forms(page), ['password-step']);
    assert.equal(await page.locator('#login-password').inputValue(), passwordText);
    assert.equal(await page.locator('#login-password').evaluate(input => document.activeElement === input), true, 'A late code response must not steal password focus.');
    const count = mail.length;
    await page.locator('#use-code').click();
    await page.locator('#code-step:visible').waitFor();
    assert.deepEqual(await forms(page), ['code-step']);
    assert.equal(mail.length, count, 'Returning to the already sent code must not send another mail.');
    assert.equal(await page.locator('#resend-code').isDisabled(), true);
    await secretsAbsent(page, passwordText, mail.at(-1)!.text.match(/\b\d{6}\b/u)![0]);
    await page.screenshot({ path: path.join(output, 'late-response-390.png'), fullPage: true });
    checks.push({ name: 'A01: a delayed successful code response preserves the last login mode and focus; returning resumes the original code', width: 390, mailCount: count });
    await context.close();
  }
  {
    const { page, context } = await loginPage();
    await send(page, 'bob@example.org'); await page.locator('#code-step:visible').waitFor();
    const otp = mail.at(-1)!.text.match(/\b\d{6}\b/u)![0], count = mail.length;
    await page.locator('#login-code').fill(otp);
    const original = await secretsAbsent(page, otp);
    await page.locator('#locale-switch').click();
    await page.locator('html[lang="en-US"]').waitFor({ state: 'attached' });
    await page.locator('#send-code:enabled').waitFor({ state: 'attached' });
    assert.deepEqual(await forms(page), ['code-step']);
    assert.match(await page.locator('#code-sent').innerText(), /bob@example\.org/u);
    assert.equal(await page.locator('#login-code').inputValue(), '', 'The OTP is not persisted.');
    assert.equal(await page.locator('#resend-code').isDisabled(), true);
    const restored = await secretsAbsent(page, otp);
    assert.deepEqual(restored.challenge, original.challenge, 'A language switch must not restart the cooldown or validity period.');
    await page.screenshot({ path: path.join(output, 'verification-english-1440.png'), fullPage: true });
    await page.locator('#locale-switch').click();
    await page.locator('html[lang="zh-CN"]').waitFor({ state: 'attached' });
    await page.locator('#send-code:enabled').waitFor({ state: 'attached' });
    assert.deepEqual(await forms(page), ['code-step']);
    assert.equal(mail.length, count, 'No resend is needed after either language switch.');
    await page.locator('#login-code').fill(otp);
    await page.locator('#verify-code').click();
    await page.waitForURL(url => url.pathname === '/');
    await page.locator('#open-account').waitFor({ state: 'attached' });
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), progressKey), null, 'Successful login clears progress.');
    checks.push({ name: 'A02: both language switches preserve the code step and absolute cooldown; the original code signs in', mailCount: count });
    await context.close();
  }
  {
    const { page, context } = await loginPage();
    await page.locator('#login-email').fill('alice@example.org');
    await page.locator('#use-password').click();
    const secret = 'password-only-in-the-current-form';
    await page.locator('#login-password').fill(secret);
    await page.locator('#locale-switch').click();
    await page.locator('html[lang="en-US"]').waitFor({ state: 'attached' });
    await page.locator('#send-code:enabled').waitFor({ state: 'attached' });
    assert.deepEqual(await forms(page), ['password-step']);
    assert.equal(await page.locator('#password-email').inputValue(), 'alice@example.org');
    assert.equal(await page.locator('#login-password').inputValue(), '');
    const progress = await page.evaluate(key => sessionStorage.getItem(key), progressKey);
    assert.equal(progress!.includes(secret), false);
    await context.clearCookies();
    await page.reload(); await page.locator('#send-code:enabled').waitFor({ state: 'attached' });
    assert.deepEqual(await forms(page), ['email-step']);
    assert.equal(await page.locator('#login-email').inputValue(), '', 'Another anonymous session must not inherit the stored email.');
    checks.push({ name: 'The selected password mode and email survive language changes; passwords and another session do not' });
    await context.close();
  }
  {
    const { page, context } = await loginPage();
    const old = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), progressKey);
    old.step = 'code'; old.email = 'alice@example.org';
    old.challenge = { email: 'alice@example.org', expiresAt: Date.now() - 1000, resendAt: Date.now() - 2000 };
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), { key: progressKey, value: old });
    await page.reload(); await page.locator('#send-code:enabled').waitFor({ state: 'attached' });
    assert.deepEqual(await forms(page), ['email-step']);
    assert.equal(await page.locator('#login-email').inputValue(), 'alice@example.org');
    checks.push({ name: 'An expired challenge returns to the email step without reviving an expired code' });
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(workerCalls, 0);
} catch (error) { failure = error instanceof Error ? error.stack : String(error); }
finally {
  for (const release of releases) release();
  await browser?.close(); await service.close(); await fs.rm(data, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, failure,
    uncaughtPageErrors: errors, externalRequests: external, realModelCalls: 0, realLeanCalls: 0, workerCalls, actualEmailsSent: 0,
    cleanup: { browserClosed: true, serviceClosed: true, temporaryDataRemoved: true } }, null, 2) + '\n');
}
if (failure) throw new Error(failure);
console.log(`Passed ${checks.length} login recovery scenarios.`);
