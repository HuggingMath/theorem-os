#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-ui-smoke');
await fs.access(path.join(root, 'out/web/login.js')).catch(() => { throw new Error('Run bun run build:web before the login check.'); });
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-web-login-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const runner: WebRunner = { async readiness() { return { ready: true, message: '本地登录验证环境' }; }, async run() {} };
const mail: { to: string; text: string }[] = [];
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:',
  THEOREMOS_WEB_ALLOWLIST: 'alice@example.org', THEOREMOS_WEB_DATA_ROOT: data }), runner,
{ mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const mark = (check: string) => console.log(`PASS ${check}`);
let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
try {
  browser = await startBrowser(service.server, port);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/status of 40[03]/u.test(message.text())) errors.push(message.text()); });

  await page.goto(origin);
  await page.waitForURL(/\/login\.html$/u);
  await page.locator('#send-code:enabled').waitFor();
  assert.ok(await page.locator('#captcha-image').evaluate((image: HTMLImageElement) => image.decode().then(() => image.naturalWidth > 0)));
  mark('the workbench sends a visitor without an account to the login page, which shows a captcha image');

  await page.fill('#login-email', 'mallory@example.org');
  await page.fill('#login-captcha', '24680');
  await page.click('#send-code');
  await page.locator('#login-error:not([hidden])').waitFor();
  assert.match(await page.locator('#login-error').innerText(), /内测资格/u);
  assert.equal(await page.locator('#login-captcha').inputValue(), '', 'A spent captcha must be cleared for the next attempt');
  assert.equal(mail.length, 0);
  mark('an address outside the allowlist gets no mail and a clear reason');

  await page.fill('#login-email', 'alice@example.org');
  await page.fill('#login-captcha', '24680');
  await page.click('#send-code');
  await page.locator('#code-step:not([hidden])').waitFor();
  assert.match(await page.locator('#code-sent').innerText(), /alice@example\.org/u);
  assert.equal(await page.locator('#resend-code').isDisabled(), true);
  await page.screenshot({ path: path.join(output, 'login-code-1440.png') });
  await page.fill('#login-code', '12-345');
  assert.equal(await page.locator('#login-code').inputValue(), '12345', 'The code field keeps digits only');
  const code = mail[0]!.text.match(/\b\d{6}\b/u)![0];
  await page.fill('#login-code', code === '000000' ? '111111' : '000000');
  await page.click('#verify-code');
  await page.locator('#login-error:not([hidden])').waitFor();
  assert.equal(await page.locator('#login-error').innerText(), '验证码不正确。');
  await page.fill('#login-code', code);
  await page.click('#verify-code');
  await page.waitForURL(`${origin}/`);
  await page.locator('#open-account').waitFor();
  assert.equal(await page.locator('#open-account').innerText(), 'alice@example.org');
  await page.locator('#submit-run:enabled').waitFor();
  mark('a wrong code is reported, the right code opens the workbench with the account in the top bar');

  await page.click('#open-account');
  await page.locator('#account-dialog[open]').waitFor();
  await settled(page);
  assert.equal(await page.locator('#delete-account').isDisabled(), true);
  await page.fill('#account-confirm', 'ALICE@example.org');
  assert.equal(await page.locator('#delete-account').isDisabled(), false);
  await page.fill('#account-confirm', '');
  await page.screenshot({ path: path.join(output, 'login-account-1440.png') });
  await page.click('#logout');
  await page.waitForURL(/\/login\.html$/u);
  await page.goto(origin);
  await page.waitForURL(/\/login\.html$/u);
  mark('the account dialog only enables deletion after the email is typed, and logout returns to the login page');

  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 760 });
    await page.goto(`${origin}/login.html`);
    await page.locator('#send-code:enabled').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Login page overflows at ${width}px`);
    await page.screenshot({ path: path.join(output, `login-${width}.png`) });
  }
  mark('the login page fits 375 and 320 pixel screens');
  assert.deepEqual(errors, []);
  console.log('Login checks passed: redirect, captcha, allowlist refusal, code entry and errors, account menu, logout and narrow layouts.');
} finally {
  await browser?.close();
  await service.close();
  await fs.rm(data, { recursive: true, force: true });
}
