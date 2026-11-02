#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { audit } from './web-a11y';
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
  page.on('console', message => { if (message.type() === 'error' && !/status of 40[013]/u.test(message.text())) errors.push(message.text()); });

  await page.goto(origin);
  await page.waitForURL(/\/login\.html$/u);
  await page.locator('#send-code:enabled').waitFor();
  assert.ok(await page.locator('#captcha-image').evaluate((image: HTMLImageElement) => image.decode().then(() => image.naturalWidth > 0)));
  // The usage guide is a page of this service and needs no account; the other footer links go to the site.
  const guide = await page.locator('.login-footer a[data-guide]').evaluate(link => (link as HTMLAnchorElement).href);
  assert.equal(guide, `${origin}/guide.html`);
  const guidePage = await page.request.get(guide);
  assert.equal(guidePage.status(), 200);
  assert.match(await guidePage.text(), /<h1>使用说明<\/h1>/u);
  const footer = await page.locator('.login-footer a:not([data-guide])').evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href));
  assert.equal(footer.length, 3);
  assert.ok(footer.every(href => href.startsWith('https://theoremos.top/')), `Login footer links leave the site: ${footer}`);
  assert.ok(footer.some(href => href.includes('feedback.html?') && href.includes('area=workbench')), 'Login footer lacks the prefilled feedback link');
  assert.deepEqual(await audit(page), [], 'Login page accessibility');
  mark('the workbench sends a visitor without an account to the login page, which shows a captcha image, the usage guide and site links and passes the accessibility audit');

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
  await page.locator('#submit-run:enabled').waitFor({ state: 'attached' });
  mark('a wrong code is reported, the right code opens the workbench with the account in the top bar');

  // Signed in, the account button joins the top bar; on phones the model name truncates so the button stays on screen.
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 760 });
    await settled(page);
    const bar = await page.locator('#topbar').evaluate(topbar => ({ scroll: topbar.scrollWidth, client: topbar.clientWidth,
      account: document.querySelector('#open-account')!.getBoundingClientRect().right }));
    assert.ok(bar.scroll <= bar.client && bar.account <= width, `The signed-in top bar overflows at ${width}px: ${JSON.stringify(bar)}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  mark('the signed-in top bar keeps the account button on 375 and 320 pixel screens');

  // The runner here ends every run without a result, so each one ends with an error and mails its link.
  const csrf = (await (await page.request.get(`${origin}/api/session`)).json()).csrfToken as string;
  const submit = async (task: string) => (await (await page.request.post(`${origin}/api/runs`, { headers: { 'X-CSRF-Token': csrf },
    data: { providerId: 'openai', apiKey: 'sk-login-test-never-publish', model: 'gpt-6.1-sol', effort: 'xhigh', source: 'theorem example : True := by sorry',
      task, maxTurns: 2, maxRunSeconds: 30, workers: 1, coordination: 'cooperative' } })).json()).run.id as string;
  const older = await submit('Older run'), newer = await submit('Newer run');
  for (let attempt = 0; attempt < 100 && mail.filter(item => /\?run=/u.test(item.text)).length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  const link = mail.find(item => item.text.includes(`?run=${older}`))?.text.match(/https?:\/\/\S+\?run=\S+/u)?.[0];
  assert.ok(link && mail.some(item => item.text.includes(`?run=${newer}`)), 'Each finished run mails its link');
  assert.ok(mail.every(item => !item.text.includes('sk-login-test')), 'A completion mail carries the API key');
  const cookies = await page.context().cookies();
  await page.context().clearCookies();
  await page.goto(link);
  await page.waitForURL(/\/login\.html$/u);
  await page.context().addCookies(cookies);
  await page.goto(`${origin}/login.html`);
  await page.waitForURL(`${origin}/`);
  await page.locator(`#run-list [data-run-id="${older}"][aria-pressed="true"]`).waitFor({ state: 'attached' });
  assert.equal(new URL(page.url()).search, `?run=${older}`, 'The address bar names the run the link opened');
  mark('a completion mail links to its run, and the link still opens that run after the login page');

  await page.click('#open-account');
  await page.locator('#account-dialog[open]').waitFor();
  assert.equal(await page.locator('#completion-email').isChecked(), true, 'Completion mail starts off');
  await page.locator('#completion-email').uncheck();
  await page.locator('#toast').filter({ hasText: '已关闭结束邮件' }).waitFor();
  assert.equal((await (await page.request.get(`${origin}/api/session`)).json()).account.completionEmail, false);
  await page.reload();
  await page.click('#open-account');
  await page.locator('#account-dialog[open]').waitFor();
  assert.equal(await page.locator('#completion-email').isChecked(), false, 'The completion mail choice is lost on reload');
  await page.locator('#completion-email').check();
  await page.locator('#toast').filter({ hasText: '研究结束时会发邮件到登录邮箱' }).waitFor();
  await page.keyboard.press('Escape');
  mark('the account dialog turns the completion mail off and on, and the choice is kept by the server');

  await page.click('#open-account');
  await page.locator('#account-dialog[open]').waitFor();
  await settled(page);
  assert.equal(await page.locator('#delete-account').isDisabled(), true);
  await page.fill('#account-confirm', 'ALICE@example.org');
  assert.equal(await page.locator('#delete-account').isDisabled(), false);
  await page.fill('#account-confirm', '');
  assert.deepEqual(await audit(page, { scope: '#account-dialog' }), [], 'Account dialog accessibility');
  await page.screenshot({ path: path.join(output, 'login-account-1440.png') });
  const password = 'WebLoginStrong2026!';
  await page.fill('#account-new-password', password);
  await page.fill('#account-repeat-password', password);
  await page.click('#save-password');
  await page.locator('#toast').filter({ hasText: '密码已更新' }).waitFor();
  assert.equal((await (await page.request.get(origin + '/api/session')).json()).account.passwordSet, true);
  await page.click('#logout');
  await page.waitForURL(/\/login\.html$/u);
  await page.click('#use-password');
  await page.fill('#password-email', 'alice@example.org');
  await page.fill('#login-password', 'wrong-password');
  await page.click('#password-submit');
  await page.locator('#login-error:not([hidden])').waitFor();
  assert.equal(await page.locator('#login-error').innerText(), '邮箱或密码不正确。');
  await page.fill('#login-password', password);
  await page.click('#password-submit');
  await page.waitForURL(origin + '/');
  await page.click('#open-account');
  await page.locator('#account-dialog[open]').waitFor();
  assert.equal(await page.locator('#account-current-wrap').isVisible(), true);
  await page.click('#logout');
  await page.waitForURL(/\/login\.html$/u);
  await page.goto(origin);
  await page.waitForURL(/\/login\.html$/u);
  mark('the account dialog sets a password; a wrong password fails and the right one opens the same account');

  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 760 });
    await page.goto(`${origin}/login.html`);
    await page.locator('#send-code:enabled').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Login page overflows at ${width}px`);
    await page.screenshot({ path: path.join(output, `login-${width}.png`) });
  }
  mark('the login page fits 375 and 320 pixel screens');
  assert.deepEqual(errors, []);
  console.log('Login checks passed: email and password login, account password setup, run links, account menu, logout and narrow layouts.');
} finally {
  await browser?.close();
  await service.close();
  await fs.rm(data, { recursive: true, force: true });
}
