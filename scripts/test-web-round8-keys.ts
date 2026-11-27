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
import { closeSettings, enterLean, fillConfig, newResearch, openSettings, clickWorkbenchAction } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-round8-keys');
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round8-keys-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const oldKey = 'sk-disposable-round8-original-K9z4', newKey = 'sk-disposable-round8-replacement-R7m2';
const mail: { to: string; text: string }[] = [], checks: object[] = [], errors: string[] = [], external: string[] = [];
const runnerEndings: string[] = [];
let formalizationCalls = 0, phase = 'setup', failure: unknown, active: Page | undefined;
const releaseGates: (() => void)[] = [];
const runner: WebRunner = {
  async readiness() { return { ready: true, nativeTeam: true, message: 'Disposable key ordering regression; no model or Lean' }; },
  async formalize() { formalizationCalls++; throw new Error('Key management must not formalize'); },
  async run(input, send) {
    runnerEndings.push(input.input.apiKey.slice(-4));
    send({ type: 'result', result: { status: 'incomplete', proof: '', report: { fixture: true } } });
  },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: data,
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'round8-zh@example.org,round8-en@example.org',
  THEOREMOS_WEB_KEY_SECRET: '5c'.repeat(32), THEOREMOS_WEB_PROVIDERS: JSON.stringify([{ id: 'sub2api', name: 'Local fixture', baseUrl: 'https://example.invalid/v1' }]),
}), runner, { sample: null, mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const browser = await startBrowser(service.server, port);

async function naturalSettings(page: Page) {
  if (await page.locator('#run-settings[open]').count()) await closeSettings(page);
  await page.locator('#open-natural-language').click();
  await page.locator('#formalize-original').waitFor();
  await clickWorkbenchAction(page, '#open-settings');
  await page.locator('#formalize-settings[open]').waitFor();
}
async function leanSettings(page: Page) { await enterLean(page); await openSettings(page); }
const required = (page: Page) => page.locator('#api-key').evaluate(node => (node as HTMLInputElement).required);
async function note(page: Page, ending: string) {
  await page.locator('#saved-key-note').filter({ hasText: ending }).waitFor();
  assert.equal(await required(page), false); assert.equal(await page.locator('#delete-saved-key').isVisible(), true);
}
async function saveNatural(page: Page, key: string, notice: string) {
  await page.locator('#formalize-key').fill(key); await page.locator('#chat-save-key').click();
  await page.locator('#chat-key-notice').filter({ hasText: notice }).waitFor();
}
async function hold(page: Page, method: string, pathname: string, responseStatus = 200) {
  const reached = deferred(), gate = deferred(); releaseGates.push(gate.resolve);
  let held = false, body: unknown;
  await page.route('**' + pathname, async route => {
    if (route.request().method() !== method || held) { await route.continue(); return; }
    held = true;
    const response = await route.fetch(); body = await response.json();
    assert.equal(response.status(), responseStatus); reached.resolve(); await gate.promise; await route.fulfill({ response });
  });
  return { reached: reached.promise, release: gate.resolve, body: () => body, remove: () => page.unroute('**' + pathname) };
}
async function submitLean(page: Page, task: string, key = '', save = false) {
  await newResearch(page); await fillConfig(page, 'source', 'theorem round8_key_fixture : True := by\n  sorry\n');
  await page.locator('#task').fill(task); await openSettings(page); await page.locator('#api-key').fill(key);
  await page.locator('#save-key').setChecked(save); await page.locator('#settings-submit').click();
}

try {
  for (const locale of ['zh', 'en'] as const) {
    const label = locale === 'zh' ? 'zh-1440' : 'en-390', en = locale === 'en';
    const savedNotice = en ? 'Key saved to your account' : 'Key 已保存到你的账号';
    const deletedNotice = en ? 'Saved API key deleted' : '已删除保存的 API Key';
    const context = await browser.newContext({ viewport: { width: en ? 390 : 1440, height: 960 }, reducedMotion: 'reduce' });
    await context.addInitScript(([key, locale]) => localStorage.setItem(key, locale), [localeStorageKey, locale]);
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    const request = context.request;
    let csrf = (await (await request.get(origin + '/api/session')).json()).csrfToken;
    const post = (pathname: string, body: object) => request.post(origin + pathname, { data: body, headers: { 'X-CSRF-Token': csrf } });
    const captcha = await (await post('/api/auth/captcha', {})).json();
    assert.equal((await post('/api/auth/code', { email: `round8-${locale}@example.org`, captchaId: captcha.id, captcha: '24680' })).status(), 200);
    const login = await post('/api/auth/verify', { email: `round8-${locale}@example.org`, code: mail.at(-1)!.text.match(/\b\d{6}\b/u)![0] });
    assert.equal(login.status(), 200); csrf = (await login.json()).csrfToken;
    const serverKeys = async () => (await (await request.get(origin + '/api/session')).json()).account.savedKeys ?? [];
    const page = await context.newPage(); active = page; page.setDefaultTimeout(12_000);
    page.on('pageerror', error => errors.push(label + ': ' + error.message));
    const keyWrites: { method: string; path: string }[] = [], runRequests: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/auth/keys/') && request.method() !== 'GET') keyWrites.push({ method: request.method(), path: url.pathname });
      if (url.pathname === '/api/runs' && request.method() === 'POST') runRequests.push(request.url());
    });
    try {
      await page.goto(origin); await page.locator('#formalize-original').waitFor();
      await clickWorkbenchAction(page, '#open-settings'); await saveNatural(page, oldKey, savedNotice);
      await leanSettings(page); await note(page, 'K9z4');

      phase = label + ': delayed Lean delete followed by natural save preserves the replacement';
      const deletion = await hold(page, 'DELETE', '/api/auth/keys/sub2api');
      await page.locator('#delete-saved-key').click(); await deletion.reached;
      assert.deepEqual(deletion.body(), { savedKeys: [] });
      await naturalSettings(page); await page.locator('#formalize-key').fill(newKey); await page.locator('#chat-save-key').click();
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('#chat-save-key')?.disabled === true);
      assert.equal(keyWrites.at(-1)?.method, 'DELETE', 'replacement waits for the deletion response');
      const replacement = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/auth/keys/sub2api');
      deletion.release(); assert.equal((await replacement).status(), 200);
      await page.locator('#chat-key-notice').filter({ hasText: savedNotice }).waitFor(); await deletion.remove();
      assert.deepEqual(await serverKeys(), [{ providerId: 'sub2api', ending: 'R7m2' }]);
      await leanSettings(page); await note(page, 'R7m2');
      await page.screenshot({ path: path.join(output, label + '-replacement-preserved.png') });
      await closeSettings(page);
      const used = runnerEndings.length;
      await submitLean(page, label + ' use saved replacement');
      await page.locator('#toast').filter({ hasText: /研究已提交|Research submitted/u }).waitFor();
      assert.equal(runnerEndings.length, used + 1); assert.equal(runnerEndings.at(-1), 'R7m2');
      checks.push({ name: phase, status: 'pass', queueOrder: ['DELETE', 'PUT'], savedEnding: 'R7m2', blankKeySubmissionUsesReplacement: true });

      phase = label + ': delayed natural save followed by Lean delete leaves both views and server empty';
      await newResearch(page); await naturalSettings(page);
      const saving = await hold(page, 'PUT', '/api/auth/keys/sub2api');
      await page.locator('#formalize-key').fill(oldKey); await page.locator('#chat-save-key').click(); await saving.reached;
      await leanSettings(page); await page.locator('#delete-saved-key').click();
      assert.equal(keyWrites.at(-1)?.method, 'PUT', 'deletion waits for the save response');
      const deleted = page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname === '/api/auth/keys/sub2api');
      saving.release(); assert.equal((await deleted).status(), 200);
      await page.locator('#toast').filter({ hasText: deletedNotice }).waitFor(); await saving.remove();
      assert.deepEqual(await serverKeys(), []); assert.equal(await required(page), true);
      assert.equal(await page.locator('#saved-key-note').isHidden(), true); assert.equal(await page.locator('#delete-saved-key').isHidden(), true);
      await naturalSettings(page); assert.equal(await page.locator('#chat-delete-key').count(), 0);
      checks.push({ name: phase, status: 'pass', queueOrder: ['PUT', 'DELETE'], savedKeys: [] });

      phase = label + ': a run saving a key waits for an earlier natural save and retains its newer key';
      const pendingSave = await hold(page, 'PUT', '/api/auth/keys/sub2api');
      await page.locator('#formalize-key').fill(oldKey); await page.locator('#chat-save-key').click(); await pendingSave.reached;
      const count = runnerEndings.length, requestsBefore = runRequests.length;
      await submitLean(page, label + ' save through run', newKey, true);
      assert.equal(runRequests.length, requestsBefore, 'run submission waits for earlier key change');
      assert.equal(runnerEndings.length, count);
      assert.deepEqual(await serverKeys(), [{ providerId: 'sub2api', ending: 'K9z4' }]);
      const submitted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
      pendingSave.release(); assert.equal((await submitted).status(), 201); await pendingSave.remove();
      await page.locator('#toast').filter({ hasText: /研究已提交|Research submitted/u }).waitFor();
      await page.waitForFunction(() => document.querySelector('#saved-key-note')?.textContent?.includes('R7m2'));
      await newResearch(page); await openSettings(page); await note(page, 'R7m2');
      assert.deepEqual(await serverKeys(), [{ providerId: 'sub2api', ending: 'R7m2' }]);
      assert.equal(runnerEndings.length, count + 1, 'replacement starts no additional run');
      checks.push({ name: phase, status: 'pass', savedEnding: 'R7m2', runsStarted: 1 });
      const storage = await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage));
      assert.ok(!storage.includes(oldKey) && !storage.includes(newKey), 'credentials never enter browser storage');
      console.log(label + ': all 3 saved-key ordering checks passed');
    } finally { await context.close(); active = undefined; }
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(formalizationCalls, 0);
} catch (cause) {
  failure = cause; await active?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw cause;
} finally {
  for (const release of releaseGates) release();
  await browser.close(); await service.close(); await fs.rm(data, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(), checks,
    errors, external, runnerEndings, formalizationCalls, realModels: 0, realLean: 0, externalMail: 0, fixturesRemoved: true,
    ...(failure ? { phase, error: String(failure) } : {}) }, null, 2) + '\n');
}
