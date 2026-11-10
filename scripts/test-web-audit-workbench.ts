#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { localeStorageKey } from '../apps/web/i18n';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { freePort, settled, startBrowser, webScenario, writeScenarioReport,
  type ScenarioHarness, type ScenarioSuite } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'out/web-audit-workbench');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => {
  throw new Error('Run bun run build:web before the workbench audit regression check.');
});
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-web-audit-workbench-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const email = 'workbench-audit@example.org';
const mail: Array<{ text: string }> = [];
let workerStarts = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local workbench audit fixture' }; },
  async run() { workerStarts++; throw new Error('Workbench navigation must not start a model or Lean worker'); },
  async formalize() { workerStarts++; throw new Error('Workbench navigation must not start formalization'); },
};
const service = createWebService(readWebConfig({
  THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: data,
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_ALLOWLIST: email, THEOREMOS_WEB_SMTP_URL: 'log:',
}), runner, { mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const checks: object[] = [], screenshots: string[] = [];
const suite: ScenarioSuite = { origin, output, checks, failedScenario: '', failureScreenshot: '' };
let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;

async function signIn(context: BrowserContext) {
  const session = await context.request.get(`${origin}/api/session`);
  assert.equal(session.status(), 200);
  const headers = { 'X-CSRF-Token': (await session.json()).csrfToken as string };
  const captcha = await context.request.post(`${origin}/api/auth/captcha`, { data: {}, headers });
  assert.equal(captcha.status(), 200);
  const code = await context.request.post(`${origin}/api/auth/code`, {
    data: { email, captchaId: (await captcha.json()).id, captcha: '24680' }, headers,
  });
  assert.equal(code.status(), 200);
  assert.equal(mail.length, 1, 'The fixture mailer captures the login code without sending mail');
  const digits = mail[0]!.text.match(/\b\d{6}\b/u)?.[0];
  assert.ok(digits, 'The local login fixture produced its code');
  const verified = await context.request.post(`${origin}/api/auth/verify`, { data: { email, code: digits }, headers });
  assert.equal(verified.status(), 200);
}
async function home(page: Page) {
  await page.goto(origin);
  await page.locator('#formalize-original').waitFor();
  await page.locator('#formalize-provider option').first().waitFor({ state: 'attached' });
  await page.locator('#open-account').waitFor();
  assert.equal(await page.locator('body').getAttribute('data-entry'), 'natural');
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: path.join(output, name) }); screenshots.push(name);
}
const report = (status: 'passed' | 'failed', error?: unknown) => writeScenarioReport(
  path.join(output, 'report.json'), suite, status, error,
  'Loopback HTTP service, temporary account storage, captured login mail and Chromium. No models, Lean or external requests.',
  { checks, screenshots, workerStarts }, { failureRequests: true },
);

try {
  browser = await startBrowser(service.server, port);
  const login = await browser.newContext();
  let auth: Awaited<ReturnType<BrowserContext['storageState']>>;
  try { await signIn(login); auth = await login.storageState(); } finally { await login.close(); }

  const scenario = (name: string, run: (h: ScenarioHarness) => Promise<void>) =>
    webScenario(browser!, suite, name, run, {
      context: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', storageState: auth },
      init: context => context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey),
      collaborationDetail: 'simple',
      harness: (page, context) => ({ page, context, requests: [] }),
      routes: { local: 'Workbench regressions must remain local', blockWrites: true },
      timeout: { label: 'Workbench audit', seconds: 30 },
      verify: ({ requests }, elapsedMs) => {
        assert.deepEqual(requests.filter(request => request.method !== 'GET'), [], 'Navigation and imports must not write to the API');
        assert.equal(workerStarts, 0);
        return { name, elapsedMs: elapsedMs(), requests };
      },
    });

  await scenario('W01: brand returns home with the unsent original; explicit new chat still clears it', async ({ page }) => {
    await home(page);
    const original = '  对任意自然数 n，证明 $n + 0 = n$。\n\n保留原题的换行及首尾空格。  ';
    await page.locator('#formalize-original').fill(original);
    await page.locator('#workbench-home').click();
    assert.equal(await page.locator('#formalize-original').inputValue(), original, 'Returning home must preserve the unsent original');
    await page.reload(); await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), original, 'Brand navigation must not overwrite the saved draft');

    await page.locator('[data-chat-sample]').click();
    await page.waitForURL(url => url.search === '?sample');
    await page.locator('#workbench-home').click();
    await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), original, 'Returning from the read-only sample restores the home draft');
    await screenshot(page, 'brand-preserved-draft.png');

    await page.locator('#topbar-draft').click();
    assert.equal(await page.locator('#formalize-original').inputValue(), '', 'Explicit new chat must still start blank');
    await page.reload(); await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), '', 'Explicitly cleared drafts stay empty after reload');
  });

  await scenario('W03: dropping a Lean file on the natural home immediately displays its exact source', async ({ page }) => {
    await home(page);
    const source = '-- 拖入的完整题目\nimport Mathlib\n\ntheorem dropped_statement : True := by\n  trivial\n';
    await page.evaluate(source => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([source], 'Dropped.lean', { type: 'text/plain' }));
      document.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, source);
    await page.locator('#source').waitFor({ state: 'visible' });
    assert.equal(await page.locator('body').getAttribute('data-entry'), 'lean', 'The successful import must display the Lean entry');
    assert.equal(await page.locator('#source').inputValue(), source, 'Import must preserve the exact file contents');
    assert.equal(await page.locator('#formalize-original').isVisible(), false);
    await screenshot(page, 'dropped-lean-visible.png');
  });

  await scenario('W02: the signed-in account button is fully visible and usable at 320px and 390px', async ({ page }) => {
    await home(page);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 }); await settled(page);
      const bounds = await page.locator('#open-account').boundingBox();
      assert.ok(bounds, `The account button must be visible at ${width}px`);
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 0.5,
        `The complete account button must fit at ${width}px: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844, 'The account button must fit vertically');
      assert.ok(bounds.width >= 24 && bounds.height >= 24, 'The account action must retain its touch target');
      const icon = await page.locator('#open-account svg').boundingBox();
      assert.ok(icon && icon.x >= 0 && icon.x + icon.width <= width, `The account icon must be on screen at ${width}px`);
      const reachable = await page.locator('#open-account').evaluate(button => {
        const box = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      });
      assert.equal(reachable, true, `The account button must be unobscured at ${width}px`);
      await screenshot(page, `account-${width}.png`);
      await page.locator('#open-account').click();
      await page.locator('#account-dialog[open]').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('#account-dialog').waitFor({ state: 'hidden' });
    }
  });

  await report('passed');
  console.log('Workbench audit regressions passed: preserved home draft, visible Lean import and complete mobile account action.');
} catch (error) {
  await report('failed', error); throw error;
} finally {
  await browser?.close(); await service.close(); await fs.rm(data, { recursive: true, force: true });
}
