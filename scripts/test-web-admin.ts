#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { localeStorageKey } from '../apps/web/i18n';
import { themeStorageKey } from '../apps/web/client/themePreference';
import { audit } from './web-a11y';
import { contrastProblems } from './web-contrast';
import { freePort, settled, startBrowser } from './web-scenario';
import { clickWorkbenchAction, openSettings } from './web-ui-controls';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-admin');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the admin check.'); });
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-web-admin-'));
const allowlist = path.join(data, 'allowlist.txt');
await fs.writeFile(allowlist, '# beta testers\nbob@example.org\n');
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: '本地管理验证环境' }; },
  async run() { throw new Error('The admin check must not start a run'); },
};
const mail: { to: string; text: string }[] = [];
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:',
  THEOREMOS_WEB_ALLOWLIST: 'carol@example.org', THEOREMOS_WEB_ADMINS: 'admin@example.org', THEOREMOS_WEB_DATA_ROOT: data,
  THEOREMOS_WEB_ADMIN_KEYS: JSON.stringify({ sub2api: 'sk-admin-browser-check-never-publish' }) }), runner,
{ mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const mark = (check: string) => console.log(`PASS ${check}`);

/** A signed-in browser context; the login page itself is covered by test:web-login. */
async function signedIn(browser: Browser, email: string, options: { locale?: 'zh' | 'en'; theme?: 'light' | 'dark'; width?: number } = {}) {
  const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 } });
  await context.addInitScript(([localeKey, locale, themeKey, theme]) => {
    if (locale && localStorage.getItem(localeKey) === null) localStorage.setItem(localeKey, locale);
    if (theme && localStorage.getItem(themeKey) === null) localStorage.setItem(themeKey, theme);
  }, [localeStorageKey, options.locale ?? '', themeStorageKey, options.theme ?? ''] as const);
  const api = context.request;
  let csrf = (await (await api.get(`${origin}/api/session`)).json()).csrfToken as string;
  const post = (route: string, body: unknown) => api.post(`${origin}${route}`, { data: body, headers: { 'X-CSRF-Token': csrf } });
  const { id } = await (await post('/api/auth/captcha', {})).json();
  assert.equal((await post('/api/auth/code', { email, captchaId: id, captcha: '24680' })).status(), 200);
  const verified = await post('/api/auth/verify', { email, code: mail.at(-1)!.text.match(/\b\d{6}\b/u)![0] });
  assert.equal(verified.status(), 200);
  csrf = (await verified.json()).csrfToken;
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/status of 40[03]/u.test(message.text())) errors.push(message.text()); });
  await page.goto(origin);
  await page.locator('#open-account').waitFor({ state: 'attached' });
  return { context, page, errors };
}

async function openAdmin(page: Page) {
  await clickWorkbenchAction(page, '#open-account');
  await page.locator('#account-dialog[open]').waitFor();
  await page.click('#open-admin');
  await page.locator('#admin-dialog[open] .admin-funnel').waitFor();
  await settled(page);
}
const listed = (page: Page) => page.locator('.admin-list .admin-email').allInnerTexts();

/** Visible Chinese text inside the admin dialog. */
function chineseText(page: Page) {
  return page.evaluate(() => {
    const han = /[　-〿一-鿿＀-￯]/u, found: string[] = [], dialog = document.querySelector('#admin-dialog')!;
    const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? '';
      if (han.test(text) && node.parentElement?.checkVisibility()) found.push(text.slice(0, 60));
    }
    for (const element of dialog.querySelectorAll('[aria-label],[title],[placeholder]')) for (const name of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(name);
      if (value && han.test(value)) found.push(`[${name}] ${value.slice(0, 60)}`);
    }
    return found;
  });
}

let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
try {
  browser = await startBrowser(service.server, port);

  let bob = await signedIn(browser, 'bob@example.org');
  await clickWorkbenchAction(bob.page, '#open-account');
  await bob.page.locator('#account-dialog[open]').waitFor();
  assert.equal(await bob.page.locator('#open-admin').isVisible(), false, 'A tester sees the admin button');
  assert.equal((await bob.context.request.get(`${origin}/api/admin/overview`)).status(), 403);
  await bob.page.keyboard.press('Escape');
  await bob.page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await bob.page.locator('#command-palette[open] input').fill('admin');
  assert.equal(await bob.page.locator('#palette-open-admin').count(), 0, 'A tester finds the admin command');
  await bob.page.keyboard.press('Escape');
  await openSettings(bob.page);
  assert.equal(await bob.page.locator('#api-key').evaluate(input => (input as HTMLInputElement).required), true, 'A tester may skip the key');
  assert.equal(await bob.page.locator('#server-key-note').isVisible(), false);
  mark('a tester gets neither the admin button nor the admin command, and the server refuses the admin routes; the key stays required');

  const { context, page, errors } = await signedIn(browser, 'admin@example.org');
  await openSettings(page);
  await page.selectOption('#provider', 'sub2api');
  assert.equal(await page.locator('#server-key-note').isVisible(), true, 'The admin is not told the server holds a key');
  assert.equal(await page.locator('#api-key').evaluate(input => (input as HTMLInputElement).required), false);
  assert.equal(await page.locator('#api-key').inputValue(), '', 'The held key reached the browser');
  assert.ok(!(await page.content()).includes('sk-admin-browser-check'), 'The held key is in the page');
  await page.selectOption('#provider', 'openai');
  assert.equal(await page.locator('#server-key-note').isVisible(), false);
  assert.equal(await page.locator('#api-key').evaluate(input => (input as HTMLInputElement).required), true);
  await page.selectOption('#provider', 'sub2api');
  await page.reload();
  await page.locator('#open-account').waitFor({ state: 'attached' });
  mark('for the admin, the Sub2API key may stay empty because the server holds it, and the key never reaches the page; OpenAI still needs one');
  await openAdmin(page);
  assert.deepEqual(await listed(page), ['admin@example.org', 'bob@example.org', 'carol@example.org']);
  assert.deepEqual(await page.locator('.admin-list .badge').allInnerTexts(), ['管理员', '白名单文件', '部署配置']);
  assert.deepEqual(await page.locator('.admin-funnel dd > .mono:first-child').allInnerTexts(), ['3', '2', '0', '0']);
  assert.equal(await page.locator('.admin-remove').count(), 1, 'Only file entries can be removed online');
  assert.deepEqual(await page.locator('.admin-table tbody th > span[translate="no"]').allInnerTexts(), ['admin@example.org', 'bob@example.org']);
  assert.deepEqual(await audit(page, { scope: '#admin-dialog' }), [], 'Admin dialog accessibility');
  assert.deepEqual(await contrastProblems(page, '#admin-dialog'), [], 'Admin dialog contrast below WCAG AA (light)');
  await page.screenshot({ path: path.join(output, 'admin-1440.png') });
  mark('the admin dialog lists the allowlist with its sources, the funnel and the accounts, and passes the accessibility and contrast rules');

  const bobId = service.auth!.getAccount('bob@example.org')!.id;
  const bobRow = page.locator('.admin-table tbody tr', { hasText: 'bob@example.org' });
  await bobRow.getByRole('button', { name: '暂停 bob@example.org', exact: true }).click();
  await bobRow.getByRole('button', { name: '确认暂停', exact: true }).click();
  await bobRow.getByRole('button', { name: '恢复 bob@example.org', exact: true }).waitFor();
  assert.equal((await bob.context.request.get(`${origin}/api/runs`)).status(), 401, 'Suspension must revoke existing sessions');
  assert.ok(service.auth!.getAccount('bob@example.org')!.suspendedAt);
  await bobRow.getByRole('button', { name: '恢复 bob@example.org', exact: true }).click();
  await bobRow.getByRole('button', { name: '确认恢复', exact: true }).click();
  await bobRow.getByRole('button', { name: '暂停 bob@example.org', exact: true }).waitFor();
  const previousBob = bob;
  bob = await signedIn(browser, 'bob@example.org');
  await previousBob.context.close();
  assert.equal(service.auth!.getAccount('bob@example.org')!.id, bobId);
  assert.equal((await bob.context.request.get(`${origin}/api/runs`)).status(), 200);
  mark('suspension revokes a tester session; restoration allows sign-in to the same account');

  await page.fill('#admin-email', ' Dave@Example.org ');
  await page.click('.admin-add button[type=submit]');
  await page.locator('#toast').filter({ hasText: '已加入白名单' }).waitFor();
  assert.deepEqual(await listed(page), ['admin@example.org', 'bob@example.org', 'carol@example.org', 'dave@example.org']);
  assert.equal(await page.locator('#admin-email').inputValue(), '');
  assert.equal(await fs.readFile(allowlist, 'utf8'), '# beta testers\nbob@example.org\ndave@example.org\n');
  await page.fill('#admin-email', 'carol@example.org');
  await Promise.all([page.waitForResponse(`${origin}/api/admin/allowlist`), page.click('.admin-add button[type=submit]')]);
  await page.locator('#admin-email:enabled').waitFor();
  assert.equal((await listed(page)).length, 4, 'Adding a configured address duplicates it');
  mark('adding an address writes it to the allowlist file, clears the field, and an address already present is not duplicated');

  await page.locator('.admin-list li', { hasText: 'bob@example.org' }).locator('.admin-remove').click();
  await page.locator('.admin-confirm .button-destructive').waitFor();
  assert.deepEqual(await audit(page, { scope: '#admin-dialog' }), [], 'Admin dialog accessibility while confirming');
  await page.locator('.admin-confirm .text-button').click();
  assert.equal(await page.locator('.admin-confirm').count(), 0);
  await page.locator('.admin-list li', { hasText: 'bob@example.org' }).locator('.admin-remove').click();
  await page.locator('.admin-confirm .button-destructive').click();
  await page.locator('#toast').filter({ hasText: '已移出白名单' }).waitFor();
  assert.deepEqual(await listed(page), ['admin@example.org', 'carol@example.org', 'dave@example.org']);
  assert.equal(await page.locator('.admin-table .badge.warning').innerText(), '已移出白名单');
  assert.equal(await fs.readFile(allowlist, 'utf8'), '# beta testers\ndave@example.org\n');
  assert.equal((await bob.context.request.get(`${origin}/api/runs`)).status(), 401, 'A removed tester stays signed in');
  mark('removal asks for confirmation, can be cancelled, rewrites the file and signs the removed tester out at once');

  await page.keyboard.press('Escape');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('#command-palette[open] input').fill('admin');
  await page.locator('#palette-open-admin').click();
  await page.locator('#admin-dialog[open] .admin-funnel').waitFor();
  await page.click('#close-admin');
  assert.equal(await page.locator('#admin-dialog[open]').count(), 0);
  mark('the command palette opens the admin dialog and the close button dismisses it');
  assert.deepEqual(errors, []);
  await context.close(); await bob.context.close();

  const english = await signedIn(browser, 'admin@example.org', { locale: 'en', theme: 'dark' });
  await openAdmin(english.page);
  assert.deepEqual(await chineseText(english.page), []);
  assert.deepEqual(await audit(english.page, { scope: '#admin-dialog' }), [], 'Admin dialog accessibility (English)');
  assert.deepEqual(await contrastProblems(english.page, '#admin-dialog'), [], 'Admin dialog contrast below WCAG AA (dark)');
  await english.page.screenshot({ path: path.join(output, 'admin-en-dark-1440.png') });
  for (const width of [375, 320]) {
    await english.page.setViewportSize({ width, height: 760 });
    await settled(english.page);
    const fit = await english.page.locator('#admin-dialog').evaluate(dialog => {
      const box = dialog.getBoundingClientRect(), content = dialog.querySelector('.admin-content')!;
      const rows = [...dialog.querySelectorAll('.admin-list li, .admin-add, .admin-funnel')].map(row => row.getBoundingClientRect().right);
      return { left: box.left, right: box.right, content: content.scrollWidth <= content.clientWidth, rows: Math.max(...rows) };
    });
    assert.ok(fit.left >= 0 && fit.right <= width && fit.content && fit.rows <= fit.right, `Admin dialog overflows at ${width}px: ${JSON.stringify(fit)}`);
    await english.page.screenshot({ path: path.join(output, `admin-en-${width}.png`) });
  }
  assert.deepEqual(english.errors, []);
  mark('in English and the dark theme the dialog has no Chinese text, passes contrast, and fits 375 and 320 pixel screens');
  console.log('Admin checks passed: tester refusal, overview, add, remove with confirmation and sign-out, palette, English, dark theme and phone widths.');
} finally {
  await browser?.close();
  await service.close();
  await fs.rm(data, { recursive: true, force: true });
}
