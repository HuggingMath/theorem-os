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
import { freePort, settled, startBrowser, ready } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-ui-smoke');
await fs.access(path.join(root, 'out/web/login.js')).catch(() => { throw new Error('Run bun run build:web before the login check.'); });
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-web-login-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const runner: WebRunner = { async readiness() { return { ready: true, message: '本地登录验证环境' }; }, async run() {} };
const mail: { to: string; text: string }[] = [];
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:',
  THEOREMOS_WEB_ALLOWLIST: 'alice@example.org', THEOREMOS_WEB_DATA_ROOT: data });
const service = createWebService(config, runner,
{ mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
// The workbench at the root address; it may already name the run it reopened (?run= or ?chat=) when the load event fires.
const workbench = (url: URL) => url.origin === origin && url.pathname === '/';
const mark = (check: string) => console.log(`PASS ${check}`);
let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
try {
  browser = await startBrowser(service.server, port);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/status of (?:40[013]|428)/u.test(message.text())) errors.push(message.text()); });

  const firstVisit: string[] = [];
  const recordFirstVisit = (request: { url(): string }) => firstVisit.push(new URL(request.url()).pathname);
  page.on('request', recordFirstVisit);
  await page.goto(origin);
  await page.waitForURL(/\/login\.html$/u);
  await page.locator('#send-code:enabled').waitFor();
  page.off('request', recordFirstVisit);
  // The server sends a signed-out visitor to the login page; the workbench bundle is never fetched on the way.
  assert.deepEqual(firstVisit.filter(pathname => /^\/(?:app\.js|formalize\.css|research-conversation\.css|assets\/katex\/)/u.test(pathname)), [],
    `A signed-out first visit loads the workbench: ${firstVisit.join(' ')}`);
  assert.equal(firstVisit.filter(pathname => pathname === '/api/session').length, 1, 'A signed-out first visit asks for its session once');
  assert.ok(await page.locator('#captcha-image').evaluate((image: HTMLImageElement) => image.decode().then(() => image.naturalWidth > 0)));
  // The guide, the terms and the privacy notice are pages of this service and need no account; feedback goes to the site.
  const guide = await page.locator('.login-footer a[data-guide]').evaluate(link => (link as HTMLAnchorElement).href);
  assert.equal(guide, `${origin}/guide.html`);
  const guidePage = await page.request.get(guide);
  assert.equal(guidePage.status(), 200);
  assert.match(await guidePage.text(), /<h1>使用说明<\/h1>/u);
  const legal = await page.locator('.login-footer a:not([data-guide]):not([data-feedback])').evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href));
  assert.deepEqual(legal, [`${origin}/terms.html`, `${origin}/privacy.html`]);
  const termsPage = await page.request.get(legal[0]);
  assert.equal(termsPage.status(), 200);
  assert.match(await termsPage.text(), /<h1>使用条款<\/h1>/u);
  const footer = await page.locator('.login-footer a[data-feedback]').evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href));
  assert.equal(footer.length, 1);
  assert.ok(footer.every(href => href.startsWith('https://theoremos.top/')), `Login footer links leave the site: ${footer}`);
  assert.ok(footer.some(href => href.includes('feedback.html?') && href.includes('area=workbench')), 'Login footer lacks the prefilled feedback link');
  const access = page.locator('#login-access'), accessLink = access.getByRole('link');
  assert.equal(await access.isVisible(), true, 'Allowlist visitors need a way to request access');
  assert.equal(await accessLink.innerText(), '申请内测');
  assert.equal(await accessLink.getAttribute('href'), 'https://theoremos.top/#start');
  await page.locator('#locale-switch').click();
  await page.locator('#send-code:enabled').waitFor();
  assert.equal(await access.locator('span').innerText(), 'Need beta access?');
  assert.equal(await accessLink.innerText(), 'Request access');
  assert.equal(await accessLink.getAttribute('href'), 'https://theoremos.top/en/#start');
  await page.locator('#locale-switch').click();
  await page.locator('#send-code:enabled').waitFor();
  const previousSignup = config.auth!.signup;
  config.auth!.signup = 'open';
  await page.reload();
  await page.locator('#send-code:enabled').waitFor();
  assert.equal(await access.isVisible(), false, 'Open signup does not need a beta application prompt');
  config.auth!.signup = previousSignup;
  await page.reload();
  await page.locator('#send-code:enabled').waitFor();
  assert.equal(await access.isVisible(), true);
  assert.deepEqual(await audit(page), [], 'Login page accessibility');
  mark('the login page shows a localized beta application link only for allowlist visitors, and passes the accessibility audit');

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
  await page.waitForURL(workbench);
  await page.locator('#open-account').waitFor();
  assert.equal(await page.locator('#open-account').innerText(), 'alice@example.org');
  await ready(page);
  mark('a wrong code is reported, the right code opens the workbench with the account in the top bar');

  // A terms change gates an existing session too, and accepting it keeps the same account.
  const accountId = service.auth!.getAccount('alice@example.org')!.id;
  const editPendingDraft = async (name: string) => {
    const draft = { source: `theorem ${name} : True := by sorry\n`, task: `Unsent instructions ${name}`, natural: `Unsent natural-language problem ${name}` };
    if (await page.locator('body[data-entry="lean"]').count()) await page.locator('#open-natural-language').click();
    await page.locator('#formalize-original').fill(draft.natural);
    await page.evaluate(value => {
      for (const id of ['source', 'task'] as const) {
        const input = document.getElementById(id) as HTMLTextAreaElement;
        input.value = value[id]; input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, draft);
    return draft;
  };
  const assertPendingDraft = async (draft: { source: string; task: string; natural: string }) => {
    assert.equal(await page.locator('#source').inputValue(), draft.source);
    assert.equal(await page.locator('#task').inputValue(), draft.task);
    assert.equal(await page.locator('#formalize-original').inputValue(), draft.natural);
  };
  const initialDraft = await editPendingDraft('before_terms_reload');
  config.auth!.termsVersion = 'browser-v2';
  await page.reload();
  await page.waitForURL(/\/login\.html/u);
  await page.locator('#terms-step:not([hidden])').waitFor();
  assert.equal(await page.locator('#login-access').isVisible(), false, 'Terms confirmation must not ask an existing account to apply');
  assert.equal(await page.locator('#accept-terms').isChecked(), false);
  await page.click('#confirm-terms');
  assert.match(await page.locator('#login-error').innerText(), /请先阅读/u);
  assert.equal(service.auth!.getAccount('alice@example.org')!.termsVersion, undefined);
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Updated terms overflow at ${width}px`);
    assert.deepEqual(await audit(page), [], 'Updated terms accessibility');
  }
  await page.locator('#accept-terms').check();
  await page.click('#confirm-terms');
  await page.waitForURL(workbench);
  await ready(page);
  assert.equal(service.auth!.getAccount('alice@example.org')!.id, accountId);
  assert.equal(service.auth!.getAccount('alice@example.org')!.termsVersion, 'browser-v2');
  await assertPendingDraft(initialDraft);
  // A live request returning 428 takes the other redirect path and must flush edits before the debounce expires.
  const liveDraft = await editPendingDraft('before_terms_response');
  const blockedRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.status() === 428);
  config.auth!.termsVersion = 'browser-v3';
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('#refresh-runs')!.click());
  await blockedRead;
  await page.waitForURL(/\/login\.html/u);
  await page.locator('#terms-step:not([hidden])').waitFor();
  await page.locator('#accept-terms').check();
  await page.click('#confirm-terms');
  await page.waitForURL(workbench);
  await ready(page);
  await assertPendingDraft(liveDraft);
  config.auth!.termsVersion = undefined;
  await page.setViewportSize({ width: 1440, height: 900 });
  mark('an existing session confirms changed terms on desktop and mobile; reload and HTTP 428 preserve Lean and conversation drafts');
  // The following mail-link scenarios start with the same empty draft as before this independent recovery check.
  await page.locator('#open-natural-language').click();
  await page.locator('#formalize-original').fill('');
  await page.evaluate(() => {
    for (const key of ['theorem-os.web-draft.v1', 'theorem-os.web-draft-recovery.v1', 'theorem-os.web-submission.v1']) sessionStorage.removeItem(key);
  });
  await page.goto(origin);
  await ready(page);

  // Signed in, the account button joins the top bar; when the bar is full the address truncates, and every other control,
  // the search button included, keeps a target of at least 24px without overlapping its neighbour.
  for (const width of [1440, 1150, 850, 768, 561, 560, 414, 390, 375, 360, 320]) {
    await page.setViewportSize({ width, height: 760 });
    await settled(page);
    const bar = await page.locator('#topbar').evaluate(topbar => ({ scroll: topbar.scrollWidth, client: topbar.clientWidth,
      controls: [...topbar.querySelectorAll<HTMLElement>('button, a')].filter(control => control.getClientRects().length).map(control => {
        const box = control.getBoundingClientRect();
        return { name: control.id || control.className.split(' ')[0], left: box.left, right: box.right, width: box.width, height: box.height };
      }).sort((a, b) => a.left - b.left) }));
    assert.ok(bar.scroll <= bar.client, `The signed-in top bar overflows at ${width}px: ${JSON.stringify(bar)}`);
    for (const name of ['palette-trigger', 'open-settings', 'locale-switch', 'open-account'])
      assert.ok(bar.controls.some(control => control.name === name && control.right <= width), `${name} is missing at ${width}px: ${JSON.stringify(bar.controls)}`);
    for (const control of bar.controls) assert.ok(control.width >= 24 && control.height >= 24, `${control.name} is under 24px at ${width}px: ${JSON.stringify(control)}`);
    for (const [index, control] of bar.controls.slice(1).entries())
      assert.ok(control.left >= bar.controls[index].right - 0.5, `${bar.controls[index].name} and ${control.name} overlap at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  mark('the signed-in top bar keeps the search button, settings, language and account at 24px or more, without overlap, from 1440 to 320 pixels');

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
  // Leave the old workbench before clearing its cookie: an in-flight API reply can otherwise restore it.
  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.goto(link);
  await page.waitForURL(url => url.pathname === '/login.html' && url.search === `?run=${older}`);
  // /api/session sets the anonymous cookie after the document loads. Let that response settle before restoring
  // the authenticated cookies; otherwise it can overwrite them between addCookies() and the next reload.
  await page.locator('#send-code:enabled').waitFor();
  // Signing in elsewhere and reloading this login page counts the same as signing in on it: it returns to the linked run.
  await page.context().addCookies(cookies);
  await page.reload();
  await page.waitForURL(workbench);
  await page.locator(`#run-list [data-run-id="${older}"][aria-pressed="true"]`).waitFor({ state: 'attached' });
  // The open run is addressed by its run id or, once its conversation opens beside it, by that conversation; either reopens it.
  assert.match(new URL(page.url()).search, new RegExp(`^\\?(?:run=${older}|chat=[\\w-]+)$`, 'u'), 'The address bar names the run the link opened');
  await page.reload();
  await page.locator(`#run-list [data-run-id="${older}"][aria-pressed="true"]`).waitFor({ state: 'attached' });
  mark('a completion mail links to its run, and the link still opens that run after the login page');

  // A session that ends while a conversation is open keeps that conversation through the login page.
  await page.waitForURL(url => url.searchParams.has('chat'));
  const chatAddress = new URL(page.url()).search, signedIn = await page.context().cookies();
  await page.context().clearCookies();
  await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
  await page.waitForURL(url => url.pathname === '/login.html' && url.search === chatAddress);
  await page.locator('#send-code:enabled').waitFor();
  await page.context().addCookies(signedIn);
  await page.reload();
  await page.waitForURL(url => workbench(url) && url.search === chatAddress);
  mark('a session that ends on an open conversation returns to that conversation after the login page');

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
  // Until the page has its session, the password form cannot be sent: it would carry no session cookie or CSRF token.
  let releaseSession!: () => void;
  const sessionHeld = new Promise<void>(resolve => { releaseSession = resolve; });
  await page.route('**/api/session', async route => { await sessionHeld; await route.continue(); }, { times: 1 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.click('#use-password');
  assert.equal(await page.locator('#password-submit').isDisabled(), true, 'The password form can be sent before the page has its session');
  releaseSession();
  await page.locator('#password-submit:enabled').waitFor();
  await page.fill('#password-email', 'alice@example.org');
  await page.fill('#login-password', 'wrong-password');
  await page.click('#password-submit');
  await page.locator('#login-error:not([hidden])').waitFor();
  assert.equal(await page.locator('#login-error').innerText(), '邮箱或密码不正确。');
  await page.fill('#login-password', password);
  await page.click('#password-submit');
  await page.waitForURL(workbench);
  await page.click('#open-account');
  await page.locator('#account-dialog[open]').waitFor();
  assert.equal(await page.locator('#account-current-wrap').isVisible(), true);
  await page.click('#logout');
  await page.waitForURL(/\/login\.html$/u);
  await page.goto(origin);
  await page.waitForURL(/\/login\.html$/u);
  mark('the account dialog sets a password; the password form waits for the session, a wrong password fails and the right one opens the same account');

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
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  console.error('Login check failed at', page?.url());
  await page?.screenshot({ path: path.join(output, 'login-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await service.close();
  await fs.rm(data, { recursive: true, force: true });
}
