#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page, Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchAccountDraftResult } from '../apps/web/researchPersonalTypes';
import type { ProblemDraftValue } from '../apps/web/problemDraftTypes';
import { freePort, startBrowser } from './web-scenario';
import { enterLean, closeSettings, openAdvancedChatSettings, openChatModelSettings } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/research-followthrough/entry');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.mkdir(output, { recursive: true }); await fs.access(path.join(staticRoot, 'app.js'));
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-problem-drafts-')), port = await freePort(), origin = `http://127.0.0.1:${port}`;
const email = 'problem-drafts@example.org', mail: { to: string; text: string }[] = [], errors: string[] = [], external: string[] = [];
const writes: string[] = [], checks: string[] = [], contexts: BrowserContext[] = [];
let prohibited = 0, phase = 'login', active: Page | undefined, failure: unknown;
let release: unknown;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable problem draft fixture' }; },
  async run() { prohibited++; throw new Error('Drafts must not run research'); },
  async formalize() { prohibited++; throw new Error('Keyboard submission is intercepted before any model call'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_AUTH: 'email',
  THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: email,
  THEOREMOS_WEB_PROVIDERS: JSON.stringify([{ id: 'fixture', name: 'Local fixture', baseUrl: 'https://fixture.invalid/v1' }]) }), runner,
  { sample: null, mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const browser = await startBrowser(service.server, port);
async function context(language: 'zh' | 'en' = 'zh', mobile = false) {
  const current = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: 1000 }, reducedMotion: 'reduce', locale: language === 'zh' ? 'zh-CN' : 'en-US', hasTouch: mobile }); contexts.push(current);
  await current.addInitScript(language => { try { localStorage.setItem('theorem-os.web-locale.v1', language); } catch {} }, language);
  await current.route(/^https?:\/\//u, async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.origin); await route.abort(); return; }
    if (request.method() !== 'GET' && url.pathname.startsWith('/api/')) {
      writes.push(`${request.method()} ${url.pathname}`);
      if (!url.pathname.startsWith('/api/auth/') && !url.pathname.startsWith('/api/research/personal/drafts')) {
        await route.fulfill({ status: 422, json: { error: 'Fixture intercepted submission before execution.' } }); return;
      }
      if (url.pathname === '/api/research/personal/drafts' && request.method() === 'POST') assert.equal(JSON.stringify(request.postDataJSON()).includes('sk-disposable-key'), false);
    }
    await route.continue();
  });
  current.on('page', page => { page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.stack || error.message)); });
  return current;
}
async function login(page: Page) {
  await page.locator('#send-code:enabled').waitFor(); await page.locator('#login-email').fill(email); await page.locator('#login-captcha').fill('24680');
  if (await page.locator('#terms-option').isVisible()) await page.locator('#accept-terms').check();
  await page.locator('#send-code').click(); await page.locator('#code-step:visible').waitFor();
  const code = mail.at(-1)?.text.match(/\b\d{6}\b/u)?.[0]; assert.ok(code);
  await page.locator('#login-code').fill(code); await page.locator('#verify-code').click(); await page.waitForURL(url => url.pathname === '/');
  await page.locator('#formalize-original').waitFor();
}
const panel = (page: Page) => page.locator('[data-problem-account-drafts]:visible');
async function openPanel(page: Page) {
  await closeNaturalSettings(page);
  if (!(await panel(page).getAttribute('open') === '')) await panel(page).locator(':scope > summary').click();
  await panel(page).locator('[data-problem-draft-title]').waitFor();
}
async function save(page: Page, title: string): Promise<ResearchAccountDraftResult<ProblemDraftValue>> {
  if (await panel(page).count()) {
    await openPanel(page); await panel(page).locator('[data-problem-draft-title]').fill(title);
    const response = page.waitForResponse(response => response.url() === `${origin}/api/research/personal/drafts` && response.request().method() === 'POST');
    await panel(page).locator('[data-save-problem-draft]').click();
    const result = await response; assert.equal(result.status(), 201, await result.text());
    await panel(page).locator('[data-save-problem-draft]:enabled').waitFor();
    return (await result.json()).item;
  }
  assert.equal(await panel(page).count(), 0);
  if (await page.locator('body[data-entry=lean]').count()) {
    const task = await page.locator('#task').inputValue();
    await page.waitForFunction(expected => {
      try { return JSON.parse(sessionStorage.getItem('theorem-os.web-draft.v1') || '{}')?.draft?.task === expected; } catch { return false; }
    }, task);
  } else {
    const text = await page.locator('#formalize-original').inputValue();
    await page.waitForFunction(expected => Object.entries(sessionStorage).some(([k, v]) => {
      if (!k.startsWith('theorem-os.chat-draft.') || k.endsWith('.quotes') || k.endsWith('.position')) return false;
      try { return JSON.parse(v).text === expected; } catch { return false; }
    }), text);
  }
  return await page.evaluate(async savedTitle => {
    const session = await (await fetch('/api/session')).json();
    const owner = session.draftOwner;
    const mode = document.body.dataset.entry === 'lean' ? 'lean' : 'natural';
    let value: ProblemDraftValue;
    if (mode === 'lean') {
      const stored = JSON.parse(sessionStorage.getItem('theorem-os.web-draft.v1') || '{}');
      value = { mode: 'lean', draft: stored.draft };
    } else {
      const chatKey = Object.keys(sessionStorage).find(key => key.startsWith('theorem-os.chat-draft.') && !key.endsWith('.quotes') && !key.endsWith('.position'));
      const stored = chatKey ? JSON.parse(sessionStorage.getItem(chatKey) || '{}') : {};
      value = { mode: 'natural', text: stored.text ?? '', settings: stored.settings };
    }
    const bindingKey = `theorem-os.problem-draft.${owner}.${mode}`;
    const binding = JSON.parse(sessionStorage.getItem(bindingKey) || 'null') || { draftKey: crypto.randomUUID(), revision: 0, title: '' };
    const sig = (v: unknown, t: string) => JSON.stringify([t, v], (_k, x) => x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
    const response = await fetch('/api/research/personal/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({
        requestId: crypto.randomUUID(), expectedRevision: binding.revision,
        scope: { kind: 'problem', draftKey: binding.draftKey }, value, summary: savedTitle,
        deviceId: 'test-device', deviceName: 'Desktop browser', clientUpdatedAt: new Date().toISOString(),
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const item = (await response.json()).item;
    sessionStorage.setItem(bindingKey, JSON.stringify({
      draftKey: binding.draftKey, revision: item.version.revision, title: savedTitle,
      draftId: item.draft.id, versionId: item.version.id, savedSignature: sig(value, savedTitle),
    }));
    return item;
  }, title);
}
async function chooseVersion(page: Page, item: ResearchAccountDraftResult, click = true) {
  const current = new URL(page.url());
  if (current.searchParams.get('accountDraft') !== item.draft.id || current.searchParams.get('draftVersion') !== item.version.id) {
    await page.goto(`${origin}/?accountDraft=${item.draft.id}&draftVersion=${item.version.id}`);
  }
  await openPanel(page);
  await panel(page).getByRole('button', { name: /刷新账号版本|Refresh account versions/u }).click();
  const group = panel(page).locator(`[data-problem-draft="${item.draft.id}"]`); await group.waitFor();
  if (!(await group.getAttribute('open') === '')) await group.locator(':scope > summary').click();
  const button = group.locator(`[data-problem-draft-version="${item.version.id}"] [data-restore-problem-draft]`); await button.waitFor();
  if (click) await button.click(); return button;
}
async function waitOriginal(page: Page, text: string) {
  await page.waitForFunction(text => (document.querySelector('#formalize-original') as HTMLTextAreaElement | null)?.value === text, text);
}
async function settings(page: Page) { await openAdvancedChatSettings(page); }
async function closeNaturalSettings(page: Page) { if (await page.locator('#formalize-settings[open]:visible').count()) await page.locator('#formalize-settings > summary').click(); }
async function noOverflow(page: Page) { assert.equal(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1), false); }

try {
  const desktop = await context(), page = await desktop.newPage(); active = page;
  await page.goto(origin); await page.waitForURL(url => url.pathname === '/login.html'); await login(page);
  release = await page.evaluate(async () => (await (await fetch('/api/product/status')).json()).release);
  phase = 'original-recovery';
  const original = '  原题：设 $n \\in \\mathbb{N}$，证明 $n+0=n$。\n先比较归纳法与化简法，再选一条路线。\n';
  await page.locator('#formalize-original').fill(original); await openChatModelSettings(page);
  await page.locator('#formalize-model').fill('original-model'); await page.locator('#formalize-effort').selectOption('high');
  await settings(page);
  await page.locator('#formalize-environment').selectOption('mathlib'); await page.locator('#formalize-key').fill('sk-disposable-key');
  await closeNaturalSettings(page);
  await page.locator('.chat-examples > summary').click(); await page.locator('#formalize-example').selectOption('add-zero');
  const choices = await page.locator('#formalize-example option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value).filter(Boolean));
  assert.ok(choices.length > 1);
  if (!await page.locator('#formalize-example').isVisible()) await page.locator('.chat-examples > summary').click();
  await page.locator('#formalize-example').selectOption(choices.find(value => value !== 'add-zero')!);
  assert.notEqual(await page.locator('#formalize-original').inputValue(), original);
  await page.reload(); await page.locator('[data-recover-original]').click(); await waitOriginal(page, original); await settings(page);
  assert.equal(await page.locator('#formalize-model').inputValue(), 'original-model'); assert.equal(await page.locator('#formalize-environment').inputValue(), 'mathlib');
  assert.equal(await page.locator('#formalize-effort').inputValue(), 'high'); assert.equal(await page.locator('#formalize-key').inputValue(), '');
  checks.push('Original text and settings survive multiple example replacements and refresh.');

  phase = 'natural-account-save';
  assert.equal(await panel(page).count(), 0, 'Authenticated home hides idle cloud-draft panel');
  await page.locator('#formalize-key').fill('sk-disposable-key');
  const natural = await save(page, '待完成的归纳证明'); assert.equal(natural.version.value.mode, 'natural');
  await page.goto(`${origin}/?accountDraft=${natural.draft.id}&draftVersion=${natural.version.id}`);
  await openPanel(page);
  await page.locator('#formalize-original').fill(original + '还在继续编辑。');
  await panel(page).getByText('新修改尚未保存到账号。', { exact: true }).waitFor();
  const mobile = await context('en', true); await mobile.addCookies(await desktop.cookies(origin));
  const other = await mobile.newPage(); active = other; await other.goto(origin); await other.locator('#formalize-original').waitFor();
  assert.equal(await other.locator('#formalize-original').inputValue(), '');
  assert.equal(await panel(other).count(), 0);
  await chooseVersion(other, natural); await waitOriginal(other, original);
  assert.equal(new URL(other.url()).searchParams.has('accountDraft'), false);
  assert.equal(await panel(other).count(), 0, 'Restoring hides the explicit recovery drawer');
  await settings(other);
  assert.equal(await other.locator('#formalize-model').inputValue(), 'original-model'); assert.equal(await other.locator('#formalize-environment').inputValue(), 'mathlib');
  assert.equal(await other.locator('#formalize-key').inputValue(), '');
  await closeNaturalSettings(other);
  await other.screenshot({ path: path.join(output, 'mobile-en-restored-account-draft.png'), fullPage: true });
  checks.push('Named natural draft restores exact content, environment and model on a second device without an API key.');

  phase = 'parallel-versions';
  const desktopText = original + '电脑：先展开定义。', mobileText = original + '手机：先做归纳。';
  await page.goto(origin); await page.locator('#formalize-original').waitFor();
  await page.locator('#formalize-original').fill(desktopText); const desktopSave = await save(page, '待完成的归纳证明');
  await other.locator('#formalize-original').fill(mobileText); const mobileSave = await save(other, '待完成的归纳证明');
  assert.equal(desktopSave.conflict, false); assert.equal(mobileSave.conflict, true); assert.equal(mobileSave.draft.id, natural.draft.id);
  await chooseVersion(other, desktopSave); await waitOriginal(other, desktopText);
  await other.goto(`${origin}/?accountDraft=${natural.draft.id}&draftVersion=${mobileSave.version.id}`);
  await openPanel(other);
  await noOverflow(other); await other.screenshot({ path: path.join(output, 'mobile-en-account-drafts.png'), fullPage: true });
  await chooseVersion(other, mobileSave); await waitOriginal(other, mobileText);
  checks.push('Parallel edits from the same revision preserve both branches and either exact version can be restored.');

  phase = 'restore-read-race'; active = page;
  await page.goto(`${origin}/?accountDraft=${natural.draft.id}&draftVersion=${natural.version.id}`);
  await openPanel(page);
  let releaseRead!: () => void, requested!: () => void;
  const held = new Promise<void>(resolve => { releaseRead = resolve; }), received = new Promise<void>(resolve => { requested = resolve; });
  const pattern = `**/api/research/personal/drafts/${natural.draft.id}?version=${natural.version.id}`;
  const hold = async (route: Route) => { requested(); await held; await route.continue(); };
  await page.route(pattern, hold); await chooseVersion(page, natural); await received;
  const duringRestore = '恢复请求期间仍在输入的新推导'; await page.locator('#formalize-original').fill(duringRestore); releaseRead();
  await panel(page).getByText('读取期间原题已修改，请重新选择恢复。', { exact: true }).waitFor();
  assert.equal(await page.locator('#formalize-original').inputValue(), duringRestore); await page.unroute(pattern, hold);
  checks.push('A late restore response cannot overwrite edits made while loading.');

  phase = 'lean-account-save';
  await page.goto(origin); await page.locator('#formalize-original').waitFor();
  await enterLean(page);
  assert.equal(await panel(page).count(), 0, 'Authenticated Lean editor hides idle cloud-draft panel');
  const leanSource = 'import Mathlib\n\ntheorem across_devices (n : ℕ) : n + 0 = n := by\n  sorry\n';
  await page.locator('#source').fill(leanSource); await page.locator('#task').fill('保留这一份未完成证明与预算。');
  await page.locator('#composer-settings').click(); await page.locator('#model').fill('lean-draft-model');
  await page.locator('[data-settings-section="settings-execution"]').click();
  await page.locator('#max-turns').fill('7'); await page.locator('#max-seconds').fill('600'); await page.locator('#workers').fill('3');
  await closeSettings(page); const lean = await save(page, 'Lean 待完成版本'); assert.equal(lean.version.value.mode, 'lean');
  await chooseVersion(other, lean); await other.locator('body[data-entry=lean]').waitFor({ state: 'attached' });
  assert.equal(await other.locator('#source').inputValue(), leanSource); assert.equal(await other.locator('#task').inputValue(), '保留这一份未完成证明与预算。');
  assert.equal(await other.locator('#model').inputValue(), 'lean-draft-model'); assert.equal(await other.locator('#max-turns').inputValue(), '7');
  assert.equal(await other.locator('#max-seconds').inputValue(), '600'); assert.equal(await other.locator('#workers').inputValue(), '3');
  assert.equal(await other.locator('#api-key').inputValue(), '');
  await other.goto(`${origin}/?accountDraft=${lean.draft.id}&draftVersion=${lean.version.id}`);
  await openChatModelSettings(other); await enterLean(other);
  await openPanel(other); assert.equal(await panel(other).locator('[data-problem-draft-title]').inputValue(), 'Lean 待完成版本');
  const leanAgain = await save(other, 'Lean 待完成版本'); assert.equal(leanAgain.draft.id, lean.draft.id); assert.equal(leanAgain.conflict, false);
  await chooseVersion(other, natural); await waitOriginal(other, original);
  await other.goto(`${origin}/?accountDraft=${natural.draft.id}&draftVersion=${natural.version.id}`);
  await openPanel(other);
  assert.equal(await panel(other).locator('[data-problem-draft-title]').inputValue(), '待完成的归纳证明');
  const naturalAgain = await save(other, '待完成的归纳证明'); assert.equal(naturalAgain.draft.id, natural.draft.id);
  checks.push('Natural and Lean drafts restore across modes with correct title, independent save identity and Lean budgets.');
  await page.goto(`${origin}/?accountDraft=${lean.draft.id}&draftVersion=${lean.version.id}`);
  await openChatModelSettings(page); await enterLean(page);
  await openPanel(page);
  await page.locator('#source').fill('theorem recover_this_original : True := by\n  sorry\n');
  await chooseVersion(page, lean); await page.locator('#restore-draft').click();
  assert.equal(await page.locator('#source').inputValue(), 'theorem recover_this_original : True := by\n  sorry\n');
  checks.push('Restoring a Lean account draft retains the replaced local source through the existing recovery control.');

  phase = 'login-deep-link';
  const third = await context(), linked = await third.newPage(); active = linked;
  await linked.goto(`${origin}/?accountDraft=${natural.draft.id}&draftVersion=${natural.version.id}`);
  await linked.waitForURL(url => url.pathname === '/login.html'); assert.equal(new URL(linked.url()).searchParams.get('accountDraft'), natural.draft.id);
  await login(linked); await panel(linked).locator(`[data-problem-draft-version="${natural.version.id}"][data-requested=true]`).waitFor();
  assert.equal(await linked.locator('#formalize-original').inputValue(), ''); await linked.reload(); await linked.locator('#formalize-original').waitFor();
  await panel(linked).locator(`[data-problem-draft-version="${natural.version.id}"][data-requested=true]`).waitFor();
  await linked.screenshot({ path: path.join(output, 'desktop-zh-original-recovery.png'), fullPage: true });
  await chooseVersion(linked, natural); await waitOriginal(linked, original);
  assert.equal(new URL(linked.url()).searchParams.has('accountDraft'), false);
  assert.equal(await panel(linked).count(), 0);
  checks.push('A draft link survives login and refresh, opens a preview, and restores only after an explicit click.');
  await noOverflow(linked);

  phase = 'keyboard'; active = linked;
  await settings(linked); await linked.locator('#formalize-key').fill('sk-disposable-key');
  await closeNaturalSettings(linked);
  await linked.locator('#formalize-original').fill('证明：\\begin{aligned}');
  const submissions: string[] = [];
  await linked.route('**/api/formalizations', async route => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    submissions.push(route.request().postDataJSON().original); await route.fulfill({ status: 422, json: { error: 'Fixture intercepted submission before execution.' } });
  });
  await linked.locator('#formalize-original').press('Enter'); assert.equal(await linked.locator('#formalize-original').inputValue(), '证明：\\begin{aligned}\n'); assert.equal(submissions.length, 0);
  // Playwright press() sends a normal browser hotkey even after a synthetic compositionstart.
  // A real IME key carries isComposing (and 229 in engines using the legacy code).
  await linked.locator('#formalize-original').dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, isComposing: true, keyCode: 229 });
  assert.equal(submissions.length, 0);
  await linked.locator('#formalize-original').press('Control+Enter'); await linked.getByText('Fixture intercepted submission before execution.', { exact: true }).waitFor();
  assert.equal(submissions.length, 1);
  await other.locator('#formalize-original').fill('Mobile new line'); await other.locator('#formalize-original').press('Enter');
  assert.equal(await other.locator('#formalize-original').inputValue(), 'Mobile new line\n');
  checks.push('Enter inserts a line; Ctrl+Enter submits once; IME composition and touch Enter do not submit.');
  assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.equal(writes.some(value => value === 'POST /api/runs'), false);
} catch (error) { failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', at: new Date().toISOString(), phase, localOnly: true,
    release, checks, errors, external, prohibited, writes, ...(failure ? { error: String(failure) } : {}) }, null, 2));
  if (!failure) await fs.rm(path.join(output, 'failure.png'), { force: true });
  await Promise.all(contexts.map(context => context.close())); await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`PASS problem draft continuity (${checks.length} checks); no model, Lean or external mail calls.`);
