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
import type { WebRunInput } from '../apps/web/shared';
import { englishAuthoredSample } from './web-i18n-fixture';
import { newResearch, openHistory, openModulesTab, selectHistoryRun, stageLabelsReadable, enterLean, showExamples, openSample, openSettings } from './web-ui-controls';
import { freePort, postRun, readRun, settled, startBrowser, ready } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-ui-smoke');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the language check.'); });
await fs.mkdir(output, { recursive: true });
const localeKey = 'theorem-os.web-locale.v1';
const proof = 'theorem fixture : True := by\n  trivial\n';
// The runner's own messages stay Chinese like any server text; the check is that the client translates them.
const runner: WebRunner = {
  async readiness() { return { ready: true, message: '运行环境就绪' }; },
  async formalize() { throw new Error('The language check must not start formalization'); },
  async run(_input, send) {
    send({ type: 'result', result: { status: 'evaluated_passed', proof, report: { turns: 2, solveWallMs: 31_000, usage: { totalTokens: 48_000 },
      environment: { toolchain: 'leanprover/lean4:v4.33.0', mathlibRevision: 'f'.repeat(40) },
      candidateCheck: { passed: true, results: [{ theoremName: 'fixture', status: 'kernel_verified' }] },
      evaluator: { status: 'passed', method: 'host-lean-kernel-all-targets',
        verification: { sourceDigest: 'e'.repeat(64), verification: { results: [{ theoremName: 'fixture', status: 'kernel_verified' }] } } } } } });
  },
};
const mark = (check: string) => console.log(`PASS ${check}`);
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/**
 * Visible Chinese text outside content marked as not for translation: user and Agent text carries translate="no",
 * and the language switch names Chinese in Chinese (lang="zh-CN").
 */
function chineseText(page: Page, selector = 'body') {
  return page.evaluate(selector => {
    const han = /\p{Script=Han}/u, found: string[] = [];
    const exempt = (element: Element | null) => element?.closest('[translate="no"],[lang="zh-CN"],[hidden],template') !== null;
    const scope = document.querySelector(selector);
    if (!scope) return [`missing ${selector}`];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement, text = node.textContent?.trim() ?? '';
      if (!han.test(text) || exempt(parent) || !parent?.checkVisibility()) continue;
      found.push(`${parent.tagName.toLowerCase()}${parent.id ? '#' + parent.id : ''}.${[...parent.classList].join('.')}: ${text.slice(0, 60)}`);
    }
    // A tooltip or label that repeats exempt text inside the element, such as a history row's title, is content too.
    const content = (element: Element) => new Set([...element.querySelectorAll('[translate="no"]')].map(node => node.textContent?.trim()));
    for (const element of scope.querySelectorAll('[aria-label],[title],[placeholder]')) {
      if (exempt(element) || !element.checkVisibility()) continue;
      for (const name of ['aria-label', 'title', 'placeholder']) {
        const value = element.getAttribute(name);
        if (value && han.test(value) && !content(element).has(value.trim())) found.push(`${element.tagName.toLowerCase()}[${name}]: ${value.slice(0, 60)}`);
      }
    }
    return found;
  }, selector);
}
const probe = process.argv.includes('--probe');
async function english(page: Page, where: string, selector?: string) {
  const found = await chineseText(page, selector);
  const text = await page.locator(selector ?? 'body').innerText();
  for (const match of text.matchAll(/(?:^|[^\d.,])1 (?:more |research )?(agents|lines|theorems|tasks|tokens|runs|minutes|entries|times|goals)\b/gu)) found.push(`plural after 1: ${match[0].trim()}`);
  if (probe) { if (found.length) console.log(`-- ${where}\n${found.join('\n')}`); return; }
  assert.deepEqual(found, [], `Chinese text in the English ${where}`);
}

const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner, { sample: englishAuthoredSample() });
const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-theoremos-i18n-fixture', model: 'deepseek-flash', effort: 'max',
  environment: 'standard', source: 'theorem fixture : True := by\n  sorry\n', task: '证明一个平凡命题', maxTurns: 4, maxRunSeconds: 120,
  workers: 2, coordination: 'cooperative' };
let browser: Browser | undefined;
try {
  browser = await startBrowser(service.server, port);
  // An English browser gets the English workbench without choosing anything.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  // Punctuation and authored content are allowed; an untranslated interface label must still fail the audit.
  await page.setContent('<span>＋，。</span><p translate="no">用户原文</p><span lang="zh-CN">中文</span><button>未翻译的按钮</button>');
  assert.deepEqual(await chineseText(page), ['button.: 未翻译的按钮']);
  await page.goto(origin);
  await page.locator('#natural-research #formalize-original').waitFor();
  await english(page, 'natural-language start');
  assert.equal(await page.locator('#formalize-settings').evaluate(node => (node as HTMLDetailsElement).open), false);
  await page.locator('#open-settings').click();
  await page.waitForFunction(() => document.activeElement?.id === 'formalize-key');
  assert.equal(await page.locator('#formalize-settings').evaluate(node => (node as HTMLDetailsElement).open), true);
  await english(page, 'natural-language connection settings', '#formalize-settings');
  await page.locator('#formalize-settings > summary').click();
  await enterLean(page);
  await ready(page);
  await showExamples(page); await page.locator('.chat-welcome[data-first-run="true"]').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en-US');
  assert.deepEqual(await page.locator('.welcome-steps strong').allInnerTexts(), ['Write the problem', 'Connect a model', 'Wait for acceptance']);
  assert.equal(await page.locator('#locale-switch').innerText(), '中文');
  await settled(page);
  await english(page, 'welcome');
  await page.screenshot({ path: path.join(output, 'i18n-welcome-1440.png') });
  mark('an English browser opens the English workbench, with a switch labelled in Chinese');

  // The sample run, every tab, settings, the glossary and the palette read in English; stored Chinese event text is translated.
  await openSample(page);
  await english(page, 'sample result');
  for (const tab of ['trajectory', 'collaboration', 'source', 'events', 'modules']) {
    if (tab === 'modules') await openModulesTab(page);
    else await page.locator(`#detail-tab-${tab}`).click();
    await page.locator(`#detail-panel[data-tab="${tab}"]`).waitFor();
    if (tab === 'trajectory') await page.locator('#detail-panel .solution-route').waitFor();
    await settled(page);
    await english(page, `sample ${tab} tab`);
  }
  // In a run, 设置 opens the chat's connection settings; the run settings belong to the Lean editor.
  await openSettings(page);
  // The registered module implementations, named by the server, read in English too once their sections are opened.
  for (const selector of ['[data-server-module-library]', '[data-module-registry] details'])
    await page.locator(`#run-settings ${selector}`).evaluate(details => { (details as HTMLDetailsElement).open = true; });
  assert.match((await page.locator('#run-settings .collab-registry-entry strong').allInnerTexts()).join('\n'), /M1 · Bounded proof research/u);
  await english(page, 'settings', '#run-settings');
  for (const selector of ['[data-module-registry] details', '[data-server-module-library]'])
    await page.locator(`#run-settings ${selector}`).evaluate(details => { (details as HTMLDetailsElement).open = false; });
  await page.locator('#close-settings').click();
  // The top bar has no glossary button; the command palette opens it.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('#palette-open-glossary').click();
  await page.locator('#glossary-dialog[open]').waitFor();
  await english(page, 'glossary', '#glossary-dialog');
  await page.screenshot({ path: path.join(output, 'i18n-glossary-1440.png') });
  await page.locator('#close-glossary').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('#command-palette[open]').waitFor();
  await english(page, 'command palette', '#command-palette');
  await page.keyboard.press('Escape');
  mark('the sample, its tabs, settings, glossary and palette have no untranslated interface text');

  // A finished run of the visitor's own: their task stays as written, the interface around it is English.
  const run = await postRun({ page }, input);
  for (let attempt = 0; attempt < 100 && (await readRun({ page }, run.id)).status !== 'completed'; attempt++) await page.waitForTimeout(50);
  await page.reload();
  await page.locator('#natural-research #formalize-original').waitFor();
  await openHistory(page);
  await english(page, 'run history', '#history-sidebar');
  await selectHistoryRun(page, run.id);
  await page.locator('[data-action="share-run"]').waitFor();
  await english(page, 'accepted run');
  await page.locator('[data-action="share-run"]').click();
  await page.locator('#share-dialog[open]').waitFor();
  await english(page, 'share dialog', '#share-dialog');
  await page.locator('#create-share:enabled').click();
  await page.locator('#share-link-row:not([hidden])').waitFor();
  const url = await page.locator('#share-url').inputValue();
  await page.locator('#close-share').click();
  mark('an accepted run of the visitor\'s own, its history and the share dialog read in English');

  // A signed-out English reader gets the share page in English and can switch it to Chinese.
  const visitor = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const reader = await visitor.newPage();
  reader.on('pageerror', error => errors.push(error.message));
  await reader.goto(url);
  await reader.locator('#share-content:not([hidden])').waitFor();
  assert.equal(await reader.evaluate(() => document.documentElement.lang), 'en-US');
  assert.match(await reader.locator('body').innerText(), /accepted|acceptance/iu);
  await english(reader, 'share page');
  await reader.screenshot({ path: path.join(output, 'i18n-share-1440.png'), fullPage: true });
  for (const width of [375, 320]) {
    await reader.setViewportSize({ width, height: 760 });
    await settled(reader);
    assert.ok(await noOverflow(reader), `English share page overflows at ${width}px`);
  }
  await Promise.all([reader.waitForEvent('load'), reader.locator('#locale-switch').click()]);
  await reader.locator('#share-content:not([hidden])').waitFor();
  assert.equal(await reader.evaluate(() => document.documentElement.lang), 'zh-CN');
  assert.match(await reader.locator('body').innerText(), /Lean 陈述证明通过/u);
  assert.equal(await reader.locator('#locale-switch').innerText(), 'English');
  await visitor.close();
  mark('the share page follows the reader\'s language, fits 320px, and switches to Chinese');

  // The switch saves the choice, keeps the draft, and the Chinese interface stays after a reload.
  await newResearch(page);
  await page.locator('#task').fill('A draft that must survive the switch');
  await Promise.all([page.waitForEvent('load'), page.locator('#locale-switch').click()]);
  await page.locator('#natural-research #formalize-original').waitFor();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), localeKey), 'zh');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
  assert.equal(await page.locator('#task').inputValue(), 'A draft that must survive the switch');
  assert.equal(await page.locator('#locale-switch').innerText(), 'English');
  await page.reload();
  await page.locator('#natural-research #formalize-original').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
  // The palette switches back, so keyboard users never need the top bar.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('#command-palette[open] input').fill('english');
  await Promise.all([page.waitForEvent('load'), page.locator('#palette-switch-locale').click()]);
  await page.locator('#natural-research #formalize-original').waitFor();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), localeKey), 'en');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en-US');
  mark('the top-bar switch and the palette command change language, remember it and keep the draft');

  // The English top bar and welcome still fit narrow screens, where the switch shows only its icon.
  for (const width of [375, 320]) {
    const narrow = await context.newPage();
    await narrow.setViewportSize({ width, height: 760 });
    await narrow.goto(origin);
    await narrow.locator('#natural-research #formalize-original').waitFor();
    await settled(narrow);
    assert.ok(await noOverflow(narrow), `English workbench overflows at ${width}px`);
    assert.ok(await narrow.evaluate(() => { const actions = document.querySelector('.topbar-actions')!; return actions.scrollWidth <= actions.clientWidth + 1 && actions.getBoundingClientRect().right <= innerWidth; }),
      `English top bar is clipped at ${width}px`);
    assert.equal(await narrow.getByRole('button', { name: '中文' }).count(), 1, 'The icon-only switch lost its accessible name');
    // The home starts a new natural-language problem; choose the accepted record explicitly.
    await selectHistoryRun(narrow, run.id);
    await narrow.locator('.artifact-stages[data-ended]').waitFor();
    await narrow.evaluate(() => document.fonts.ready);
    await settled(narrow);
    await stageLabelsReadable(narrow, `English run header at ${width}px`);
    await narrow.screenshot({ path: path.join(output, `i18n-workbench-${width}.png`) });
    await narrow.close();
  }
  mark('the English workbench and an ended run\'s stage names fit 375px and 320px and the icon-only switch keeps its name');
  await context.close();
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await service.close();
}
// The login page is English for an English browser, with the switch in its footer, and the server's refusals read in English too.
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-web-i18n-'));
const loginPort = await freePort(), loginOrigin = `http://127.0.0.1:${loginPort}`;
const login = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(loginPort), THEOREMOS_WEB_PUBLIC_URL: loginOrigin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:',
  THEOREMOS_WEB_ALLOWLIST: 'alice@example.org', THEOREMOS_WEB_DATA_ROOT: data }), runner,
{ mailer: async () => undefined, captchaAnswer: () => '24680' });
try {
  browser = await startBrowser(login.server, loginPort);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(loginOrigin);
  await page.waitForURL(/\/login\.html$/u);
  await page.locator('#send-code:enabled').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en-US');
  await english(page, 'login page');
  assert.equal(await page.locator('.locale-switch-separator').isVisible(), true);
  await page.fill('#login-email', 'mallory@example.org');
  await page.fill('#login-captcha', '24680');
  await page.click('#send-code');
  await page.locator('#login-error:not([hidden])').waitFor();
  assert.equal(await page.locator('#login-error').innerText(), 'This email does not have beta access yet. Apply for the beta, then log in once you are accepted.');
  await page.locator('#send-code:enabled').waitFor();
  await english(page, 'login page after a refusal');
  await page.screenshot({ path: path.join(output, 'i18n-login-1440.png') });
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 760 });
    await settled(page);
    assert.ok(await noOverflow(page), `English login page overflows at ${width}px`);
  }
  await Promise.all([page.waitForEvent('load'), page.locator('#locale-switch').click()]);
  await page.locator('#send-code:enabled').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
  assert.match(await page.locator('body').innerText(), /已获准的内测邮箱/u);
  assert.deepEqual(errors, []);
  mark('the login page follows the browser language, fits 320px, and switches to Chinese');
} finally {
  await browser?.close();
  await login.close();
  await fs.rm(data, { recursive: true, force: true });
}
if (!probe) console.log('Language checks passed: English workbench, sample, dialogs, own run, share and login pages, switching and narrow layout.');
