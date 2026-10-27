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
import { closeSettings, openSettings } from './web-ui-controls';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-saved-key');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the saved key check.'); });
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-web-saved-key-'));
const credential = 'sk-saved-key-browser-check-never-publish-K9z4';
const keys: string[] = [];
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local saved key fixture; no model or Lean' }; },
  async run(input, send) { keys.push(input.input.apiKey); send({ type: 'result', result: { status: 'incomplete', proof: '', report: { fixture: true } } }); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const mail: { to: string; text: string }[] = [];
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:',
  THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org', THEOREMOS_WEB_DATA_ROOT: data, THEOREMOS_WEB_KEY_SECRET: '5c'.repeat(32) }), runner,
{ mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const mark = (check: string) => console.log(`PASS ${check}`);

/** A signed-in browser context, as on a separate device; the login page itself is covered by test:web-login. */
async function signedIn(browser: Browser, email: string, options: { locale?: 'zh' | 'en'; theme?: 'light' | 'dark' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
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
  const page = await context.newPage(), errors: string[] = [], posted: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs') posted.push(request.postData() ?? ''); });
  await page.goto(origin);
  await page.locator('#submit-run:enabled').waitFor();
  return { context, page, errors, posted };
}
async function submit(page: Page, posted: string[], task: string, key?: string) {
  const before = posted.length;
  await page.locator('#new-research').click();
  await page.locator('#task').fill(task);
  await openSettings(page);
  if (key !== undefined) await page.locator('#api-key').fill(key);
  await page.locator('#settings-submit').click();
  await page.locator('#toast').filter({ hasText: /研究已提交|Research submitted/u }).waitFor();
  assert.equal(posted.length, before + 1, 'the form submitted once');
  return JSON.parse(posted.at(-1)!) as { apiKey: string; saveKey?: boolean };
}
const required = (page: Page) => page.locator('#api-key').evaluate(input => (input as HTMLInputElement).required);
const stores = (page: Page) => page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage));

let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
try {
  browser = await startBrowser(service.server, port);

  const first = await signedIn(browser, 'alice@example.org');
  await openSettings(first.page);
  assert.equal(await first.page.locator('#save-key').isChecked(), true, 'saving is not on by default');
  assert.equal(await first.page.locator('#key-save-note').isVisible(), true);
  assert.equal(await first.page.locator('#key-memory-row').isHidden(), true, 'the tab-only memory still shows');
  assert.equal(await first.page.locator('#delete-saved-key').isHidden(), true);
  assert.equal(await required(first.page), true);
  await closeSettings(first.page);
  const sent = await submit(first.page, first.posted, 'Save it', credential);
  assert.equal(sent.apiKey, credential); assert.equal(sent.saveKey, true);
  await first.page.locator('#toast').filter({ hasText: 'Key 已保存到你的账号' }).waitFor();
  await openSettings(first.page);
  assert.equal(await first.page.locator('#api-key').inputValue(), '', 'the field keeps the key after submission');
  assert.match(await first.page.locator('#api-key').getAttribute('placeholder') ?? '', /K9z4/u);
  assert.match(await first.page.locator('#saved-key-note').innerText(), /K9z4/u);
  assert.equal(await first.page.locator('#delete-saved-key').isVisible(), true);
  assert.equal(await required(first.page), false);
  assert.ok(!(await stores(first.page)).includes(credential), 'the key is in browser storage');
  assert.deepEqual(await audit(first.page, { scope: '#settings-connection' }), [], 'Connection settings accessibility');
  await first.page.locator('#key-save-note').scrollIntoViewIfNeeded();
  await first.page.screenshot({ path: path.join(output, 'saved-1440.png') });
  mark('ticked by default, the key is saved to the account on submission, the field empties and shows only the last four characters');

  await first.page.reload();
  await first.page.locator('#submit-run:enabled').waitFor();
  const reused = await submit(first.page, first.posted, 'Reuse after reload');
  assert.equal(reused.apiKey, ''); assert.equal(reused.saveKey, undefined);
  const second = await signedIn(browser, 'alice@example.org');
  await openSettings(second.page);
  assert.match(await second.page.locator('#saved-key-note').innerText(), /K9z4/u, 'another device does not see the saved key');
  await closeSettings(second.page);
  assert.equal((await submit(second.page, second.posted, 'Another device')).apiKey, '');
  assert.deepEqual(keys, [credential, credential, credential], 'the runs did not get the saved key');
  assert.ok(!(await second.page.content()).includes(credential) && !(await stores(second.page)).includes(credential));
  mark('after a reload and on another device the key field may stay empty and runs use the saved key, which never reaches the page');

  const bob = await signedIn(browser, 'bob@example.org');
  await openSettings(bob.page);
  assert.equal(await bob.page.locator('#saved-key-note').isHidden(), true, 'another account sees a saved key');
  assert.equal(await required(bob.page), true);
  assert.equal(await bob.page.locator('#api-key').getAttribute('placeholder'), '');
  assert.equal((await (await bob.context.request.get(`${origin}/api/session`)).json()).account.savedKeys, undefined);
  mark('another account sees no saved key and still has to enter its own');

  await openSettings(second.page);
  await second.page.locator('#delete-saved-key').click();
  await second.page.locator('#toast').filter({ hasText: '已删除保存的 API Key' }).waitFor();
  assert.equal(await second.page.locator('#saved-key-note').isHidden(), true);
  assert.equal(await second.page.locator('#delete-saved-key').isHidden(), true);
  assert.equal(await required(second.page), true);
  assert.equal((await (await second.context.request.get(`${origin}/api/session`)).json()).account.savedKeys, undefined);
  assert.deepEqual(await fs.readdir(path.join(data, 'keys')), []);
  mark('deleting the saved key makes the field required again and removes it from the server');
  for (const page of [first, second, bob]) assert.deepEqual(page.errors, []);
  await Promise.all([first.context.close(), second.context.close(), bob.context.close()]);

  const english = await signedIn(browser, 'alice@example.org', { locale: 'en', theme: 'dark' });
  await submit(english.page, english.posted, 'English', credential);
  await openSettings(english.page);
  await settled(english.page);
  const texts = await english.page.locator('#settings-connection').evaluate(section => [...section.querySelectorAll('label, p, button, input')]
    .filter(node => (node as HTMLElement).checkVisibility()).map(node => `${node.textContent ?? ''} ${node.getAttribute('placeholder') ?? ''}`));
  assert.deepEqual(texts.filter(text => /[一-鿿]/u.test(text)), [], 'Chinese text in the English connection settings');
  assert.deepEqual(await contrastProblems(english.page, '#settings-connection'), [], 'Connection settings contrast below WCAG AA (dark)');
  await english.page.locator('#key-save-note').scrollIntoViewIfNeeded();
  await english.page.screenshot({ path: path.join(output, 'saved-en-dark-1440.png') });
  assert.deepEqual(english.errors, []);
  mark('in English and the dark theme the saved key settings have no Chinese text and pass contrast');
  console.log('Saved key checks passed: default save, ending only, reload and another device, other account, delete, English and dark theme.');
} finally {
  await browser?.close();
  await service.close();
  await fs.rm(data, { recursive: true, force: true });
}
