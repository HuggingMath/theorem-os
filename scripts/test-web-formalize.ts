#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebFormalizationReport } from '../apps/web/shared';
import { webFormalizationLimits, type WebFormalization, type WebFormalizationCapabilities } from '../apps/web/formalizationTypes';
import type { WebConversation } from '../apps/web/conversationTypes';
import { localeStorageKey } from '../apps/web/i18n';
import { researchExamples } from '../apps/web/problemExamples';
import { freePort, startBrowser, ready } from './web-scenario';
import { audit } from './web-a11y';
import { openSettings, closeSettings, enterLean, showExamples } from './web-ui-controls';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-formalize'); await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), {
  async readiness() { return { ready: true, message: 'Fixture only' }; },
  async run() { throw new Error('This UI test must never call a model'); },
});
const original = '  For every natural number n, prove $n + 0 = n$.\n\nKeep this exact text.  ';
const report: WebFormalizationReport = {
  schema: 'theorem-os.web-formalization-report.v1', problemId: 'addition', original,
  statement: 'theorem addition (n : Nat) : n + 0 = n := by\n  sorry\n', environment: 'standard', toolchain: 'leanprover/lean4:v4.19.0', mathlibRevision: null,
  targets: [{ name: 'addition', lines: { start: 1, end: 2 } }], correspondences: [], coverage: [],
  backtranslation: { mathematics: 'For each natural number n, adding zero leaves n unchanged.', assumptions: [], definitions: [], targets: [] },
  reviews: [{ reviewer: 'reviewer-1', verdict: 'approved', summary: 'The statement preserves the original claim.', checks: [{ name: 'complete', value: 'true' }], issues: [] }],
  model: 'deepseek-flash', effort: 'max', rounds: 1, evidenceSha256: 'a'.repeat(64), approvedAt: '2026-11-02T01:00:00Z',
};
const baseItem: WebFormalization = { id: '11111111-1111-4111-8111-111111111111', original, environment: 'standard', model: 'deepseek-flash', effort: 'max',
  status: 'running', createdAt: '2026-11-02T01:00:00Z', updatedAt: '2026-11-02T01:00:00Z', progress: { phase: 'planning', tokens: 900 } };
const capabilities: WebFormalizationCapabilities = { available: true, model: 'deepseek-flash', providerId: 'sub2api', key: 'required', limits: webFormalizationLimits };
const errors: string[] = [];
let browser: Browser | undefined;
async function setup(browser: Browser, options: { width?: number; locale?: string; items?: WebFormalization[]; actualSession?: boolean;
  capabilities?: WebFormalizationCapabilities; conversation?: WebConversation; loseCreationResponse?: boolean } = {}) {
  const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 1000 } });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, options.locale ?? 'zh']);
  const page = await context.newPage(); page.on('pageerror', cause => errors.push(cause.message));
  const items = options.items ?? [], caps = options.capabilities ?? capabilities, writes: { path: string; body: Record<string, unknown> }[] = [];
  const creations = new Map<string, WebFormalization>();
  let lostResponse = false;
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/session') {
      if (options.actualSession) return route.continue();
      return json({ csrfToken: 'fixture-csrf', auth: 'none' });
    }
    if (method !== 'GET') {
      if (!options.actualSession) assert.equal(request.headers()['x-csrf-token'], 'fixture-csrf');
      writes.push({ path: url.pathname, body: request.postDataJSON() ?? {} });
    }
    if (!url.pathname.startsWith('/api/formalizations')) {
      if (options.conversation && url.pathname === '/api/conversations') {
        if (method === 'POST') {
          assert.deepEqual(request.postDataJSON(), { formalizationId: options.conversation.formalizationId });
          return json({ conversation: options.conversation }, 201);
        }
        const { messages: _, ...summary } = options.conversation;
        return json({ conversations: [{ ...summary, answering: false }] });
      }
      if (options.conversation && url.pathname === `/api/conversations/${options.conversation.id}`) return json({ conversation: options.conversation });
      if (method === 'POST' && url.pathname === '/api/runs') return json({ error: 'Fixture captured request; no model started.' }, 422);
      return route.continue();
    }
    if (url.pathname === '/api/formalizations') {
      if (method === 'GET') return json({ formalizations: items.map(({ report: _, ...rest }) => rest), generation: caps });
      assert.equal(method, 'POST'); const body = request.postDataJSON();
      assert.notEqual(body.solve, true, 'The standalone advanced utility must retain manual confirmation');
      assert.match(body.requestId, /^[a-f0-9-]{36}$/u);
      const previous = creations.get(body.requestId);
      if (previous) return json({ formalization: previous });
      items.unshift({ ...baseItem, original: body.original, environment: body.environment, effort: body.effort });
      creations.set(body.requestId, items[0]!);
      if (options.loseCreationResponse && !lostResponse) { lostResponse = true; return route.abort('connectionreset'); }
      return json({ formalization: items[0] });
    }
    const item = items.find(item => url.pathname.split('/')[3] === item.id);
    if (!item) return json({ error: 'Fixture not found' }, 404);
    if (method === 'DELETE') { items.splice(items.indexOf(item), 1); return json({ deletedId: item.id }); }
    if (method === 'POST' && url.pathname.endsWith('/cancel')) { item.status = 'cancelled'; delete item.report; }
    if (method === 'POST' && url.pathname.endsWith('/confirm')) {
      assert.equal(request.postDataJSON().evidenceSha256, report.evidenceSha256); item.status = 'confirmed';
    }
    return json({ formalization: item });
  });
  await page.goto(`${origin}/formalize.html`);
  await page.locator('#formalize-budget').filter({ hasText: 'deepseek-flash' }).waitFor();
  return { context, page, items, writes };
}
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
try {
  browser = await startBrowser(service.server, port);
  for (const locale of ['zh', 'en']) {
    const { page, context, writes } = await setup(browser, { locale, actualSession: true, width: locale === 'en' ? 390 : 1440 });
    // Both entry paths use the same problems. Choosing an example never starts a paid request.
    await page.goto(origin);
    await enterLean(page);
    await showExamples(page); await page.locator('.research-example').last().waitFor();
    // Global entry points remain available when the home page restores a previous run.
    await page.goto(`${origin}/?sample`);
    // The sample opens in the chat; its run header stays behind the artifact panel until one is opened.
    await page.locator('[data-sample-badge]').waitFor({ state: 'attached' });
    // Over a run the input-mode switch gives way to the chat; 新对话 in the top bar leads back to a new problem.
    assert.equal(await page.locator('#research-input-mode').isVisible(), false);
    const topEntry = await page.locator('#topbar-draft').boundingBox();
    assert.ok(topEntry && topEntry.y >= 0 && topEntry.y + topEntry.height < 220);
    await enterLean(page);
    await page.locator('#open-research-examples').click();
    await page.locator('.research-examples').waitFor();
    assert.equal(await page.locator('body').getAttribute('data-view'), 'draft');
    assert.equal(await page.locator('.research-example').count(), researchExamples.length);
    const selected = researchExamples.find(example => example.id === 'add-zero')!;
    assert.equal(await page.locator('.research-example [data-chat-template]').first().getAttribute('data-chat-template'), selected.id);
    await page.locator(`[data-chat-template="${selected.id}"]`).click();
    assert.equal(await page.locator('#source').inputValue(), selected.source);
    assert.equal(await page.locator('#environment').inputValue(), selected.environment);
    assert.equal(await page.locator(`[data-chat-template="${selected.id}"]`).getAttribute('aria-pressed'), 'true');
    const href = await page.locator(`.research-example a[href*="${selected.id}"]`).getAttribute('href');
    await page.screenshot({ path: path.join(output, `examples-${locale}.png`), fullPage: true });
    assert.equal(await noOverflow(page), true);
    await page.goto(`${origin}/${href}`);
    await page.locator('#formalize-budget').filter({ hasText: 'deepseek-flash' }).waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), locale === 'en' ? selected.originalEn : selected.original);
    assert.equal(await page.locator('#formalize-environment').inputValue(), selected.environment);
    assert.equal(writes.length, 0);
    for (const example of researchExamples) {
      await page.locator('#formalize-original').fill('');
      await page.locator('#formalize-example').selectOption(example.id);
      assert.equal(await page.locator('#formalize-original').inputValue(), locale === 'en' ? example.originalEn : example.original);
      assert.equal(await page.locator('#formalize-environment').inputValue(), example.environment);
    }
    await page.locator('#formalize-original').fill('My own problem with edited hypotheses.');
    assert.equal(await page.locator('#formalize-example').inputValue(), '');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#formalize-example').selectOption(researchExamples[0]!.id);
    assert.equal(await page.locator('#formalize-original').inputValue(), 'My own problem with edited hypotheses.');
    assert.equal(await page.locator('#formalize-example').inputValue(), '');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#formalize-example').selectOption(selected.id);
    assert.equal(writes.length, 0);
    await page.screenshot({ path: path.join(output, `natural-example-${locale}.png`), fullPage: true });
    assert.equal(await noOverflow(page), true);
    assert.deepEqual(await audit(page), []);
    await page.locator('#formalize-key').fill('fixture-example-key');
    await page.locator('#formalize-start').click();
    await page.locator('#formalize-current').waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.body.original, locale === 'en' ? selected.originalEn : selected.original);
    assert.equal(writes[0]!.body.environment, selected.environment);
    await context.close();
  }
  {
    const { page, context, items, writes } = await setup(browser);
    assert.equal(writes.length, 0);
    assert.equal(await page.locator('#formalize-effort').inputValue(), 'high');
    assert.equal(await page.locator('#formalize-start').isDisabled(), true);
    await page.locator('#formalize-original').fill(original); await page.locator('#formalize-key').fill('fixture-secret-key');
    await page.locator('#formalize-start').click(); await page.locator('#formalize-progress').filter({ hasText: '规划陈述' }).waitFor();
    assert.equal(writes.length, 1); assert.equal(writes[0]!.body.original, original); assert.equal(writes[0]!.body.apiKey, 'fixture-secret-key');
    assert.equal(writes[0]!.body.effort, 'high');
    assert.equal(await page.locator('#formalize-key').inputValue(), '');
    assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes('fixture-secret-key')), false);
    await page.reload(); await page.locator('#formalize-progress').filter({ hasText: '规划陈述' }).waitFor(); assert.equal(writes.length, 1);
    assert.equal(await page.locator('#formalize-source-text').textContent(), original);
    items[0]!.status = 'review'; items[0]!.report = { ...report, effort: items[0]!.effort };
    await page.locator('#formalize-refresh').click(); await page.locator('#formalize-review').waitFor();
    assert.equal(await page.locator('#formalize-confirm').isDisabled(), true);
    assert.match(await page.locator('#formalize-prose').innerText(), /The statement preserves/u);
    assert.match(await page.locator('#formalize-code').innerText(), /sorry/u);
    assert.equal(await page.locator('#formalize-use').isVisible(), false);
    await page.screenshot({ path: path.join(output, 'review-1440.png'), fullPage: true });
    await page.locator('#formalize-checked').check(); await page.locator('#formalize-confirm').click();
    await page.locator('#formalize-use').waitFor(); assert.equal(writes.length, 2);
    assert.match(await page.locator('#formalize-prose .explain-notice').innerText(), /你已确认此陈述/u);
    assert.doesNotMatch(await page.locator('#formalize-prose .explain-notice').innerText(), /未经人工审阅/u);
    assert.equal(await page.locator('#formalize-use').getAttribute('href'), '/?formalization=11111111-1111-4111-8111-111111111111');
    await page.reload(); await page.locator('#formalize-use').waitFor(); assert.equal(writes.length, 2);
    assert.equal(await page.locator('#formalize-confirmation').isVisible(), false);
    assert.deepEqual(await audit(page), []);
    await context.close();
  }
  console.log('PASS exact original input, key lifecycle, persisted read-only refresh, reviewed evidence and explicit confirmation');
  {
    const { page, context, writes } = await setup(browser);
    await page.locator('#formalize-effort').selectOption('max');
    await page.locator('#formalize-original').fill(original);
    await page.reload(); await page.locator('#formalize-budget').filter({ hasText: 'deepseek-flash' }).waitFor();
    assert.equal(await page.locator('#formalize-effort').inputValue(), 'max');
    await page.locator('#formalize-key').fill('fixture-explicit-max-key');
    await page.locator('#formalize-start').click(); await page.locator('#formalize-current').waitFor();
    assert.equal(writes.length, 1); assert.equal(writes[0]!.body.effort, 'max');
    await context.close();
  }
  console.log('PASS standalone defaults to high while a saved explicit max draft remains max');
  for (const destination of ['reload', 'record', 'example']) {
    const other = { ...baseItem, id: '22222222-2222-4222-8222-222222222222', original: 'A different saved record' };
    const caps = { ...capabilities };
    const { page, context, items, writes } = await setup(browser, { loseCreationResponse: true, items: [other], capabilities: caps });
    try {
      await page.locator('#formalize-original').fill('Uncertain standalone original');
      await page.locator('#formalize-effort').selectOption('low');
      await page.locator('#formalize-key').fill('fixture-retry-secret');
      await page.locator('#formalize-start').click(); await page.locator('#formalize-error').waitFor();
      assert.equal(new URL(page.url()).search, '', 'A new submission no longer names the older selected record');
      assert.equal(items.length, 2);
      if (destination === 'reload') {
        caps.available = false;
        await page.reload(); await page.locator('#formalize-start:enabled').waitFor();
        assert.equal(await page.locator('#formalize-original').inputValue(), 'Uncertain standalone original');
        assert.equal(await page.locator('#formalize-effort').inputValue(), 'low');
        assert.equal(await page.locator('#formalize-key').inputValue(), '');
        await page.locator('#formalize-start').click();
        await page.locator('#formalize-source-text').filter({ hasText: 'Uncertain standalone original' }).waitFor({ state: 'attached' });
        const creates = writes.filter(write => write.path === '/api/formalizations');
        assert.equal(creates.length, 2); assert.equal(creates[0]!.body.requestId, creates[1]!.body.requestId);
        assert.equal(items.length, 2, 'Replay needs neither a key, runtime availability nor a free queue slot');
      } else if (destination === 'record') {
        await page.goto(`${origin}/formalize.html?id=${other.id}`);
        await page.locator('#formalize-source-text').filter({ hasText: other.original }).waitFor({ state: 'attached' });
        assert.equal(await page.locator('#formalize-original').inputValue(), other.original);
        assert.equal(await page.locator('#formalize-effort').inputValue(), 'max');
        assert.equal(new URL(page.url()).search, `?id=${other.id}`);
        assert.equal(writes.length, 1, 'Explicit record navigation only reads its requested record');
      } else {
        const example = researchExamples.find(item => item.id === 'schur-cubic')!;
        await page.goto(`${origin}/formalize.html?example=${example.id}`);
        await page.locator('#formalize-budget').filter({ hasText: 'deepseek-flash' }).waitFor();
        assert.equal(await page.locator('#formalize-original').inputValue(), example.original);
        assert.equal(await page.locator('#formalize-example').inputValue(), example.id);
        assert.equal(writes.length, 1, 'An explicit example link never replays an older uncertain problem');
      }
      assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes('fixture-retry-secret')), false);
    } finally { await context.close(); }
  }
  console.log('PASS standalone uncertain submission survives refresh while explicit record and example links retain their targets');
  {
    const conversation: WebConversation = { id: '22222222-2222-4222-8222-222222222222', formalizationId: baseItem.id,
      title: original.trim(), createdAt: baseItem.createdAt, updatedAt: baseItem.updatedAt, messages: [] };
    const { page, context, writes } = await setup(browser, { actualSession: true, conversation,
      items: [{ ...baseItem, status: 'review', workflow: 'solve', humanReview: true, report }] });
    await page.locator('#formalize-confirmation').waitFor();
    assert.match(await page.locator('#formalize-progress').innerText(), /待你确认/u);
    assert.equal(await page.locator('#formalize-research-status').isVisible(), false);
    await page.locator('#formalize-checked').check(); await page.locator('#formalize-confirm').click();
    await page.locator('#formalize-use').filter({ hasText: '返回对话' }).waitFor();
    assert.equal(writes.length, 1); assert.equal(writes[0]!.path, `/api/formalizations/${baseItem.id}/confirm`);
    assert.match(await page.locator('#formalize-progress').innerText(), /已确认陈述/u);
    assert.doesNotMatch(await page.locator('#formalize-confirmed').innerText(), /带入研究草稿/u);
    assert.match(await page.locator('#formalize-confirmed').innerText(), /双 Agent 研究.*审核研究计划/u);
    await page.reload(); await page.locator('#formalize-use').filter({ hasText: '返回对话' }).waitFor();
    await page.clock.install();
    const reads: string[] = [];
    page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/api/formalizations')) reads.push(request.url()); });
    await page.clock.fastForward(15_000);
    assert.deepEqual(reads, [], 'Confirmed human review waits for the user without polling for automatic research');
    assert.equal(writes.length, 1, 'Review and refresh must never start guided research');
    assert.equal(await page.locator('#formalize-use').getAttribute('href'), '/');
    await page.locator('#formalize-use').click(); await page.waitForURL(`${origin}/?chat=${conversation.id}`);
    assert.deepEqual(writes.map(write => write.path), [`/api/formalizations/${baseItem.id}/confirm`, '/api/conversations']);
    await context.close();
  }
  console.log('PASS human review preserves confirmation, stops automatic polling and returns to its chat without starting research');
  {
    const { page, context, writes } = await setup(browser, { actualSession: true,
      items: [{ ...baseItem, status: 'review', report }], capabilities: { ...capabilities, key: 'server' } });
    await page.locator('#formalize-review').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), original);
    assert.equal(await page.locator('#formalize-environment').inputValue(), 'standard');
    await page.locator('#formalize-checked').check();
    await page.locator('#formalize-original').fill(`${original}\n`);
    await page.locator('#formalize-changed').waitFor();
    assert.equal(await page.locator('#formalize-confirm').isDisabled(), true);
    assert.equal(await page.locator('#formalize-checked').isChecked(), false);
    assert.equal(await page.locator('#formalize-checked').isDisabled(), true);
    await page.locator('#formalize-confirm').dispatchEvent('click');
    assert.equal(writes.length, 0, 'Changed original must never confirm the previous statement');
    await page.locator('#formalize-original').fill(original);
    await page.locator('#formalize-checked').check();
    await page.locator('#formalize-environment').selectOption('mathlib');
    assert.equal(await page.locator('#formalize-confirm').isDisabled(), true);
    await page.locator('#formalize-confirm').dispatchEvent('click');
    assert.equal(writes.length, 0, 'Changed environment must never confirm the previous statement');
    await page.locator('#formalize-environment').selectOption('standard');
    await page.locator('#formalize-checked').check();
    await page.locator('#formalize-confirm').click();
    await page.locator('#formalize-use[aria-disabled="false"]').waitFor();
    assert.equal(writes.length, 1);
    await page.locator('#formalize-original').fill('A different natural-language problem.');
    await page.locator('#formalize-environment').selectOption('mathlib');
    const address = page.url();
    assert.equal(await page.locator('#formalize-use').getAttribute('href'), null);
    await page.locator('#formalize-use').dispatchEvent('click');
    assert.equal(page.url(), address);
    assert.equal(await page.locator('#formalize-original').isVisible(), true);
    assert.equal(writes.length, 1, 'Stale continue must never start research');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#formalize-list [data-id]').click();
    assert.equal(await page.locator('#formalize-original').inputValue(), 'A different natural-language problem.');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#formalize-list [data-id]').click();
    await page.locator('#formalize-use[aria-disabled="false"]').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), original);
    assert.equal(await page.locator('#formalize-environment').inputValue(), 'standard');
    assert.equal(await page.locator('#formalize-changed').isVisible(), false);
    await page.locator('#formalize-use').click();
    await page.locator('#draft-formalization-link').waitFor();
    assert.equal(await page.locator('#source').inputValue(), report.statement);
    assert.equal(writes.length, 1, 'Matching handoff must remain an explicit draft action');
    await context.close();
  }
  console.log('PASS stale originals and environments block manual confirmation and handoff; history preserves unsaved text until explicit replacement');
  {
    const { page, context, writes, items } = await setup(browser, { items: [{ ...baseItem }], capabilities: { ...capabilities, key: 'saved' } });
    await page.locator('[data-action="cancel"]').click(); await page.locator('#formalize-progress').filter({ hasText: '已取消' }).waitFor();
    assert.equal(writes.length, 1); await page.locator('[data-action="reuse"]').click();
    assert.equal(await page.locator('#formalize-original').inputValue(), original); assert.equal(writes.length, 1);
    assert.equal(await page.locator('#formalize-start').isEnabled(), true);
    items[0]!.status = 'error'; items[0]!.reason = 'formalization_worker_failed';
    await page.locator('#formalize-refresh').click(); await page.locator('#formalize-progress').filter({ hasText: '生成失败' }).waitFor();
    assert.equal(writes.length, 1);
    assert.doesNotMatch(await page.locator('#formalize-reason').innerText(), /formalization_worker_failed/u);
    await page.reload(); await page.locator('#formalize-progress').filter({ hasText: '生成失败' }).waitFor(); assert.equal(writes.length, 1);
    page.once('dialog', dialog => dialog.accept()); await page.locator('[data-action="delete"]').click();
    await page.locator('#formalize-list').filter({ hasText: '还没有形式化记录' }).waitFor(); assert.equal(writes.length, 2);
    assert.equal(await page.locator('#formalize-current').isVisible(), false);
    await context.close();
  }
  console.log('PASS cancellation, saved key availability and failures never automatically retry');
  {
    const { page, context, writes } = await setup(browser, { actualSession: true, items: [{ ...baseItem, status: 'confirmed', report }] });
    await page.locator('#formalize-use').click();
    await page.locator('#draft-formalization-link').waitFor();
    assert.equal(await page.locator('#source').inputValue(), report.statement);
    assert.equal(await page.locator('#environment').inputValue(), report.environment);
    assert.equal(await page.locator('#draft-formalization-link').getAttribute('href'), 'formalize.html?id=11111111-1111-4111-8111-111111111111');
    assert.equal(writes.length, 0, 'Opening the confirmed problem must not start research');
    await page.reload(); await enterLean(page); await page.locator('#draft-formalization-link').waitFor();
    assert.equal(await page.locator('#source').inputValue(), report.statement);
    assert.equal(await page.locator('#environment').inputValue(), report.environment);
    await openSettings(page); await page.locator('#api-key').fill('fixture-research-key'); await closeSettings(page);
    if (!await page.locator('#proof-instructions[open]').count()) await page.locator('#proof-instructions > summary').click();
    await page.locator('#task').fill('Prove the statement using the standard library.');
    await page.locator('#submit-run').click(); await page.locator('#form-error').filter({ hasText: 'Fixture captured request' }).waitFor();
    assert.equal(writes.length, 1); assert.equal(writes[0]!.path, '/api/runs');
    assert.equal(writes[0]!.body.formalizationId, baseItem.id); assert.equal(writes[0]!.body.source, report.statement);
    assert.equal(writes[0]!.body.environment, report.environment);
    await page.locator('#source').fill(report.statement + '-- edited\n');
    assert.equal(await page.locator('#draft-formalization-link').isVisible(), false, 'Edited source must release the evidence binding');
    await page.reload(); await enterLean(page); await ready(page);
    assert.equal(await page.locator('#draft-formalization-link').isVisible(), false);
    assert.equal(await page.locator('#source').inputValue(), report.statement + '-- edited\n');
    await context.close();
  }
  console.log('PASS confirmed statement handoff, exact source and environment, restored binding and explicit research submission payload');
  for (const width of [320, 390]) {
    const { page, context, writes } = await setup(browser, { width, locale: 'en', items: [{ ...baseItem, status: 'review', report }],
      capabilities: { ...capabilities, available: false, reason: 'runtime', key: 'server' } });
    await page.locator('#formalize-review').waitFor();
    assert.equal(await page.locator('#formalize-start').isDisabled(), true);
    assert.match(await page.locator('#formalize-unavailable').innerText(), /runtime/u);
    assert.equal(await noOverflow(page), true, `Overflow at ${width}px`);
    await page.locator('[data-action="pane"][data-pane="lean"]').click(); assert.equal(await page.locator('#formalize-lean').isVisible(), true);
    await page.locator('[data-action="pane"][data-pane="prose"]').click();
    const untranslated = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), found: string[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.parentElement?.checkVisibility() && !node.parentElement.closest('[lang="zh-CN"],[translate="no"]') && /[\u4e00-\u9fff]/u.test(node.textContent ?? '')) found.push(node.textContent!);
      return found;
    });
    assert.deepEqual(untranslated, []); assert.deepEqual(await audit(page), []); assert.equal(writes.length, 0);
    await page.screenshot({ path: path.join(output, `review-en-${width}.png`), fullPage: true }); await context.close();
  }
  console.log('PASS 320px and 390px English layouts, disabled runtime, no overflow and accessibility');
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await service.close(); }
