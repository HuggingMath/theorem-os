#!/usr/bin/env bun
import { openAdvancedChatSettings } from './web-ui-controls';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page, Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { webFormalizationEvidence } from '../tests/helpers/webFormalizationFixture';
import { freePort, settled, startBrowser, webScenario, writeScenarioReport,
  type ScenarioHarness, type ScenarioSuite } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/web-round2-workbench');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the round 2 workbench check.'); });
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round2-workbench-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const credential = 'sk-disposable-round2-workbench';
const original = '对任意自然数 n，证明 n + 1 = 1 + n。';
const edited = '  对任意自然数 n，证明 n + 0 = n。\n\n保留我的修改。  ';
const identityKey = 'theorem-os.chat-submission.v1.anonymous';
const formalizationCalls: string[] = [];
let fakeRunCalls = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local round 2 workbench fixture' }; },
  async formalize(input, send) {
    formalizationCalls.push(input.original);
    send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(input) });
  },
  async run(input, send) {
    fakeRunCalls++;
    send({ type: 'result', result: { status: 'incomplete', proof: input.input.source, report: { fixture: true } } });
  },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: data, THEOREMOS_WEB_AUTH: 'none',
  THEOREMOS_WEB_PROVIDERS: JSON.stringify([{ id: 'openai', name: 'Local fixture', baseUrl: 'https://example.invalid/v1' }]),
}), runner);
type Harness = ScenarioHarness & { posts: Array<{ pathname: string; body: Record<string, unknown> }> };
const checks: object[] = [], screenshots: string[] = [];
const suite: ScenarioSuite = { origin, output, checks, failedScenario: '', failureScreenshot: '' };
let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
const scenario = (name: string, run: (h: Harness) => Promise<void>, width = 1440) => webScenario(browser!, suite, name, run, {
  context: { viewport: { width, height: 900 }, reducedMotion: 'reduce' }, collaborationDetail: 'simple',
  init: context => context.addInitScript(() => localStorage.setItem('theorem-os.locale.v1', 'zh')),
  harness: (page, context) => {
    const h: Harness = { page, context, requests: [], posts: [] };
    h.intercept = async route => {
      if (route.request().method() === 'POST') h.posts.push({ pathname: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
      return false;
    };
    return h;
  },
  routes: { local: 'Workbench recovery must remain on the local fixture service' }, timeout: { label: 'Round 2 workbench', seconds: 45 },
  verify: (h, elapsedMs) => {
    assert.ok(h.posts.every(post => ['/api/runs', '/api/formalizations', '/api/conversations'].includes(post.pathname)),
      'Recovery must not confirm research, start proof work or send a model discussion');
    return { name, width, elapsedMs: elapsedMs(), requests: h.requests };
  },
});
async function home(page: Page) {
  await page.goto(origin); await page.locator('#formalize-original').waitFor();
  await page.waitForFunction(() => Boolean((document.querySelector('#formalize-model') as HTMLInputElement)?.value));
}
async function credentials(page: Page) {
  await page.locator('#open-settings').click();
  await openAdvancedChatSettings(page);
  await page.locator('#formalize-environment').selectOption('standard');
  await page.locator('#formalize-model').fill('fixture-model'); await page.locator('#formalize-key').fill(credential);
  await page.locator('input[name="chat-participation"][value="guided"]').check();
}
const identity = (page: Page) => page.evaluate(key => sessionStorage.getItem(key), identityKey);
async function screenshot(page: Page, name: string) { await page.screenshot({ path: path.join(output, name) }); screenshots.push(name); }
async function drop(page: Page, name: string, contents: string) {
  await page.evaluate(({ name, contents }) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([contents], name, { type: 'text/plain' }));
    document.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { name, contents });
}
async function attachFailure(h: Harness, failures = 1) {
  const counts = { formalizationPosts: 0, attachPosts: 0 };
  h.intercept = async (route: Route) => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (request.method() !== 'POST') return false;
    h.posts.push({ pathname, body: request.postDataJSON() });
    if (pathname === '/api/formalizations') counts.formalizationPosts++;
    if (pathname === '/api/conversations') {
      counts.attachPosts++;
      if (counts.attachPosts <= failures) { await route.fulfill({ status: 503, json: { error: 'Local attach failure' } }); return true; }
    }
    return false;
  };
  await home(h.page); await credentials(h.page); await h.page.locator('#formalize-original').fill(original);
  await h.page.locator('#formalize-start').click(); await h.page.locator('#formalize-error').waitFor();
  await h.page.locator('#formalize-settings > summary').click();
  assert.equal(counts.formalizationPosts, 1); assert.equal(counts.attachPosts, 1);
  return counts;
}
const report = (status: 'passed' | 'failed', error?: unknown) => writeScenarioReport(path.join(output, 'report.json'), suite, status, error,
  'Temporary loopback service, isolated sessions and synthetic recorded formalization evidence. No real models, Lean, mail or production writes.',
  { checks, screenshots, fakeFormalizationCalls: formalizationCalls.length, fakeRunCalls }, { credential, failureRequests: true });

try {
  browser = await startBrowser(service.server, port);

  await scenario('W2-03: retry attaches the shown history task even when an older new-problem submission is unresolved', async h => {
    const { page } = h; await home(page);
    const run = await page.evaluate(async () => {
      const session = await (await fetch('/api/session')).json();
      const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ providerId: 'openai', model: 'fixture-model', apiKey: 'sk-local-history-fixture', effort: 'low', environment: 'standard',
          source: 'theorem history_statement : True := by sorry\n', task: 'Local history fixture', maxTurns: 2, maxRunSeconds: 60, workers: 1, coordination: 'cooperative' }) });
      if (response.status !== 201) throw new Error(`History fixture failed: ${response.status}`);
      return (await response.json()).run;
    });
    await page.reload(); await page.locator('#formalize-original').waitFor(); await credentials(page);
    await page.locator('#formalize-original').fill(original);
    let formalizationPosts = 0, attachPosts = 0;
    h.intercept = async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'POST') return false;
      h.posts.push({ pathname, body: route.request().postDataJSON() });
      if (pathname === '/api/formalizations') {
        formalizationPosts++; await route.fulfill({ status: 503, json: { error: 'Local first-send failure' } }); return true;
      }
      if (pathname === '/api/conversations' && ++attachPosts === 1) {
        await route.fulfill({ status: 503, json: { error: 'Local history attachment failure' } }); return true;
      }
      return false;
    };
    await page.locator('#formalize-start').click(); await page.locator('#formalize-error').waitFor();
    const pending = await identity(page); assert.ok(pending);
    await page.locator('#formalize-settings > summary').click();
    if (await page.locator('body[data-history-collapsed="true"]').count()) await page.locator('#open-history').click();
    if (await page.locator('.chat-task-history:not([open]) > summary').count()) await page.locator('.chat-task-history > summary').click();
    await page.locator(`#run-list [data-run-id="${run.id}"]`).click();
    await page.locator('#formalize-error').filter({ hasText: 'Local history attachment failure' }).waitFor();
    await page.locator('#formalize-error button').filter({ hasText: '重试' }).click();
    await page.waitForURL(url => url.searchParams.has('chat'));
    assert.equal(attachPosts, 2); assert.equal(formalizationPosts, 1);
    assert.equal(await identity(page), pending, 'Recovering a different history task must preserve the original uncertain submission identity');
    assert.equal(await page.locator('#formalize-error').count(), 0);
  });

  await scenario('W2-02: a changed original requires an explicit recovery choice and prepares the new problem without starting it', async h => {
    const { page } = h, counts = await attachFailure(h, 2);
    await page.locator('#formalize-original').fill(edited); const pending = await identity(page); assert.ok(pending);
    assert.equal(await page.locator('#formalize-start').isDisabled(), true);
    await page.locator('[data-chat-submission-recovery]').waitFor();
    await page.locator('#formalize-original').press('Enter'); await settled(page);
    assert.equal(counts.attachPosts, 1, 'Enter must not silently recover the old task when the original changed');
    await page.locator('[data-chat-prepare-edited]').click();
    await page.locator('#formalize-error').filter({ hasText: 'Local attach failure' }).waitFor();
    assert.equal(await identity(page), pending, 'A failed recovery keeps the exact original identity');
    assert.equal(await page.locator('#formalize-original').inputValue(), edited);
    assert.equal(counts.formalizationPosts, 1);
    await page.locator('[data-chat-prepare-edited]').click();
    await page.waitForFunction(() => location.search === '' && !document.querySelector('[data-chat-submission-recovery]'));
    assert.equal(await page.locator('#formalize-original').inputValue(), edited);
    assert.equal(await identity(page), null, 'The old identity clears only after its task record is successfully recovered');
    assert.equal(counts.attachPosts, 3); assert.equal(counts.formalizationPosts, 1, 'Preparing the changed problem must not start a second task');
    await screenshot(page, 'modified-problem-prepared.png');
    const before = formalizationCalls.length;
    await credentials(page); await page.locator('#formalize-start').click();
    await page.waitForURL(url => url.searchParams.has('chat'));
    assert.equal(counts.formalizationPosts, 2, 'Only a later explicit send starts the changed problem');
    assert.equal(formalizationCalls.length, before + 1);
    const tasks = await page.evaluate(async () => (await (await fetch('/api/formalizations')).json()).formalizations);
    assert.deepEqual(tasks.map((item: { original: string }) => item.original).sort(), [original, edited].sort());
  });

  for (const width of [320, 390]) await scenario(`W2-02: ${width}px recovery opens the original and keeps the complete changed problem on home`, async h => {
    const { page } = h, counts = await attachFailure(h);
    await page.locator('#formalize-original').fill(edited);
    await page.locator('[data-chat-submission-recovery]').waitFor();
    for (const selector of ['[data-chat-recover-submission]', '[data-chat-prepare-edited]']) {
      await page.locator(selector).scrollIntoViewIfNeeded();
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 900,
        `Recovery action must fit the viewport at ${width}px: ${selector} ${JSON.stringify(box)}`);
      assert.ok(box.width >= 24 && box.height >= 24, 'Recovery actions must retain a usable touch target');
    }
    await screenshot(page, `recovery-choices-${width}.png`);
    await page.locator('[data-chat-recover-submission]').click(); await page.waitForURL(url => url.searchParams.has('chat'));
    assert.equal(counts.formalizationPosts, 1); assert.equal(counts.attachPosts, 2);
    assert.equal(await page.locator('#formalize-original').inputValue(), '', 'The changed problem is not a draft discussion of the original task');
    const conversation = await page.evaluate(async () => (await (await fetch(`/api/conversations/${new URLSearchParams(location.search).get('chat')}`)).json()).conversation);
    assert.equal(conversation.messages[0].text, original);
    await page.locator('#workbench-home').click(); await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), edited);
    await page.reload(); await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), edited, 'Prepared changes survive reload');
  }, width);

  await scenario('W2-01: invalid file errors are visible on the natural home and successful Lean drops still show their exact contents', async ({ page }) => {
    await home(page); await page.locator('#formalize-original').fill(edited);
    for (const [name, content, reason] of [['notes.txt', 'text', '请选择 .lean 文件'], ['Empty.lean', ' \n', '源码文件为空']]) {
      await drop(page, name!, content!);
      await page.locator('#toast:visible').filter({ hasText: reason! }).waitFor();
      assert.equal(await page.locator('body').getAttribute('data-entry'), 'natural');
      assert.equal(await page.locator('#formalize-original').inputValue(), edited);
      assert.equal(await page.locator('#formalize-settings').evaluate(node => (node as HTMLDetailsElement).open), false,
        'An invalid file must not unexpectedly open API Key settings');
      await screenshot(page, `import-error-${name}.png`);
    }
    const source = '-- 完整文件\ntheorem imported_statement : True := by\n  trivial\n';
    await drop(page, 'Valid.lean', source); await page.locator('#source').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#source').inputValue(), source);
    assert.equal(await page.locator('body').getAttribute('data-entry'), 'lean');
    assert.equal(await page.locator('#source-error').isVisible(), false);
    await page.locator('#open-natural-language').click(); await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), edited);
  });

  assert.equal(fakeRunCalls, 1, 'Only the explicit disposable history fixture may start the fake proof runner');
  assert.equal(formalizationCalls.length, 4, 'Only explicitly sent original or changed problems start fake formalization');
  await report('passed'); console.log('Round 2 workbench: history retry, explicit task recovery and visible import errors passed.');
} catch (error) { await report('failed', error); throw error; }
finally { await browser?.close(); await service.close(); await fs.rm(data, { recursive: true, force: true }); }
