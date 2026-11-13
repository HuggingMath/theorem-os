#!/usr/bin/env bun
// Six first-visit layouts on a disposable local service. Browsing and editing never start a model or Lean.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { localeStorageKey } from '../apps/web/i18n';
import { researchExamples } from '../apps/web/problemExamples';
import { audit } from './web-a11y';
import { closeHistory, enterLean, openAdvancedChatSettings, openChatBudget, openChatParticipation, openHistory, openNavigationMenu } from './web-ui-controls';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-simple-workbench');
await fs.access(path.join(root, 'out/web/app.js'));
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-simple-workbench-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let workerCalls = 0;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_CLIENT_IP_HEADER: 'x-simple-fixture' }), {
  async readiness() { return { ready: true, message: 'Disposable simple workbench fixture' }; },
  async run() { workerCalls++; throw new Error('Editing and reading must not start a proof'); },
  async formalize() { workerCalls++; throw new Error('Editing and reading must not start formalization'); },
});
const checks: object[] = [], errors: string[] = [], writes: string[] = [], external: string[] = [], processPolls: string[] = [];
const screenshots: string[] = [];
const original = '  对任意自然数 n，证明 n + 0 = n。\n\nKeep the complete original.  ';
let browser: Browser | undefined, page: Page | undefined, phase = 'start', failure: unknown;
async function fit(actor: Page) {
  await settled(actor);
  assert.equal(await actor.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth + 1), true,
    `${phase}: no horizontal document overflow`);
  assert.deepEqual(await audit(actor), [], `${phase}: accessibility`);
}
async function shot(actor: Page, filename: string) {
  await fit(actor); await actor.screenshot({ path: path.join(output, filename), fullPage: true }); screenshots.push(filename);
}
async function toolbarLayout(actor: Page) {
  await actor.evaluate(() => document.fonts.ready);
  await settled(actor);
  const layout = await actor.locator('.chat-composer-toolbar').evaluate(toolbar => {
    const style = getComputedStyle(toolbar), bounds = toolbar.getBoundingClientRect();
    const settings = toolbar.querySelector('#formalize-settings > summary')!.getBoundingClientRect();
    const submit = toolbar.querySelector('#formalize-start')!.getBoundingClientRect();
    const available = bounds.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const needed = settings.width + submit.width + (parseFloat(style.columnGap) || 0);
    return { available, needed, sameRow: Math.abs(settings.y + settings.height / 2 - submit.y - submit.height / 2) <= 2,
      controlsFit: [settings, submit].every(box => box.width > 0 && box.x >= bounds.x - 1 && box.right <= bounds.right + 1) };
  });
  assert.equal(layout.controlsFit, true, `${phase}: settings and submit stay inside their toolbar`);
  if (actor.viewportSize()!.width >= 390 && layout.needed <= layout.available + 1)
    assert.equal(layout.sameRow, true, `${phase}: controls that fit share one toolbar row: ${JSON.stringify(layout)}`);
  assert.equal(await actor.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth + 1), true);
  return layout;
}
function mark(name: string, fields: object = {}) { checks.push({ name, ...fields }); console.log(`PASS ${name}`); }
async function newProblem(actor: Page) {
  await actor.locator('#topbar-draft').click();
  await actor.locator('#formalize-original').waitFor();
  await actor.waitForFunction(() => (document.querySelector('#formalize-original') as HTMLTextAreaElement)?.value === '');
}
try {
  browser = await startBrowser(service.server, port);
  for (const locale of ['zh', 'en'] as const) for (const width of [320, 390, 1440]) {
    phase = `${locale}/${width}`;
    const context = await browser.newContext({ locale: locale === 'zh' ? 'zh-CN' : 'en-US',
      viewport: { width, height: width === 1440 ? 1000 : 844 }, reducedMotion: 'reduce',
      extraHTTPHeaders: { 'x-simple-fixture': crypto.randomUUID() } });
    context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(30_000);
    await context.addInitScript(([key, language]) => localStorage.setItem(key, language), [localeStorageKey, locale]);
    await context.route(/^https?:\/\//u, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
      if (/^\/api\/(?:runs\/[^/]+\/(?:events|actions)|formalizations\/[^/]+\/activity)$/u.test(url.pathname)) processPolls.push(url.pathname);
      if (!['GET', 'HEAD'].includes(request.method())) { writes.push(`${request.method()} ${url.pathname}`); await route.abort(); return; }
      await route.continue();
    });
    page = await context.newPage(); const actor = page;
    actor.on('pageerror', error => errors.push(`${phase}: ${error.message}`));
    await actor.goto(origin); await actor.locator('#formalize-original:enabled').waitFor();
    assert.equal(await actor.locator('#formalize-original').inputValue(), '');
    assert.equal(await actor.locator('#formalize-start:visible').count(), 1, 'One send control owns the problem');
    assert.equal(await actor.locator('#formalize-start').isDisabled(), true);
    assert.equal(await actor.locator('#topbar-draft:visible').count(), 1);
    assert.equal(await actor.locator('#topbar .brand').count(), 1, 'The interactive topbar replaces the initial brand');
    assert.equal(await actor.locator('#topbar .brand').getAttribute('id'), 'workbench-home');
    assert.equal(await actor.locator('#open-history:visible').count(), 1);
    assert.equal(await actor.locator('[data-navigation-toggle]:visible').count(), 1);
    assert.equal(await actor.locator('body').getAttribute('data-history-collapsed'), 'true', 'A fresh workbench keeps history behind its button');
    assert.equal(await actor.locator('#formalize-settings[open], [data-first-research-start][open], [data-chat-examples][open]').count(), 0);
    assert.equal(await actor.locator('[data-chat-configure]:visible, [data-first-connection]:visible, [data-research-overview]:visible').count(), 0);
    assert.equal(await actor.locator('[data-chat-examples] > summary:visible').count(), 1);
    assert.equal(await actor.locator('[data-chat-sample]').isVisible(), false);
    assert.equal(await actor.locator('.chat-lean-entry').isVisible(), false);
    assert.equal(await actor.locator('#research-conversation-panel select:visible').count(), 0);
    assert.equal(await actor.locator('[data-chat-participation]:visible, [data-problem-account-drafts]:visible').count(), 0,
      'The default anonymous home keeps research mode in settings and has no cloud-draft action');
    assert.equal(await actor.locator('[data-chat-configure-key]').count(), 0, 'A blank problem keeps the ordinary settings entry');
    const homeToolbar = await toolbarLayout(actor);
    await shot(actor, `home-${locale}-${width}.png`);
    mark(`${phase}: one composer and collapsed choices replace the repeated first-visit panels`, { homeToolbar });

    const savedResearch = actor.locator('[data-chat-research-overview]');
    assert.equal(await savedResearch.evaluate(node => (node as HTMLDetailsElement).open), false);
    assert.equal(await actor.locator('[data-research-overview]').count(), 0, 'Saved research mounts after the reader asks for it');
    await savedResearch.locator(':scope > summary').click();
    await actor.locator('[data-research-overview]').waitFor();
    const budget = await openChatBudget(actor);
    await actor.locator('.chat-start h1').scrollIntoViewIfNeeded();
    await settled(actor);
    const headingBox = await actor.locator('.chat-start h1').boundingBox();
    const panelBox = await actor.locator('#research-conversation-panel').boundingBox();
    assert.ok(headingBox && panelBox && headingBox.y >= panelBox.y - 1 && headingBox.y + headingBox.height <= actor.viewportSize()!.height + 1,
      'Expanding the budget and saved research must leave the opening heading reachable at the top');
    await shot(actor, `saved-research-${locale}-${width}.png`);
    await budget.locator(':scope > summary').click();
    await savedResearch.locator(':scope > summary').click();
    await actor.locator('[data-research-overview]').waitFor({ state: 'detached' });
    mark(`${phase}: the optional saved-research disclosure retains grouping and personal research access`);

    const menu = actor.locator('[data-navigation-menu]'), toggle = menu.locator('[data-navigation-toggle]');
    await toggle.focus(); await toggle.press('Enter'); await menu.locator('[data-navigation-panel]').waitFor();
    for (const destination of ['workspace', 'theorems', 'people', 'library'])
      assert.equal(await menu.locator(`a[href^="${destination}.html"]`).isVisible(), true, `${destination} remains reachable`);
    await toggle.press('Tab');
    assert.equal(await menu.evaluate(node => node.contains(document.activeElement) && document.activeElement !== node.querySelector('summary')), true);
    await actor.keyboard.press('Escape');
    assert.equal(await menu.evaluate(node => (node as HTMLDetailsElement).open), false);
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true, 'Escape returns to the menu trigger');
    await openNavigationMenu(actor); await shot(actor, `menu-${locale}-${width}.png`); await actor.keyboard.press('Escape');
    mark(`${phase}: one keyboard menu reaches the professional pages and restores focus on Escape`);

    await actor.locator('#formalize-original').fill(original);
    const configureKey = actor.locator('[data-chat-configure-key]');
    assert.equal(await configureKey.count(), 1, 'One settings summary handles the missing Key');
    assert.equal(await configureKey.evaluate(node => node.tagName === 'SUMMARY' && node.parentElement?.id === 'formalize-settings'), true);
    assert.equal(await configureKey.locator('.chat-model-label').innerText(), locale === 'en' ? 'Enter API key' : '填写 API Key');
    assert.equal(await actor.locator('[data-chat-key-required], .chat-key-next-step').count(), 0, 'The missing-Key entry needs no separate hint card');
    const keyToolbar = await toolbarLayout(actor);
    await shot(actor, `missing-key-${locale}-${width}.png`);
    await configureKey.click();
    assert.equal(await actor.locator('#formalize-settings').evaluate(node => (node as HTMLDetailsElement).open), true);
    assert.equal(await actor.locator('#formalize-key').evaluate(node => node === document.activeElement), true);
    assert.equal(await actor.locator('#formalize-original').inputValue(), original);
    assert.equal(await actor.locator('#formalize-start').isDisabled(), true);
    await configureKey.click();
    assert.equal(await actor.locator('#formalize-settings').evaluate(node => (node as HTMLDetailsElement).open), false,
      'The same summary closes its settings');
    assert.equal(await actor.locator('#formalize-original').inputValue(), original);
    assert.equal(await actor.locator('#formalize-key').inputValue(), '');
    await configureKey.focus(); await configureKey.press('Enter');
    await actor.waitForFunction(() => (document.querySelector('#formalize-settings') as HTMLDetailsElement).open
      && document.activeElement?.id === 'formalize-key');
    assert.equal(await actor.locator('#formalize-original').inputValue(), original, 'Keyboard configuration preserves the exact original');
    await openChatParticipation(actor);
    assert.equal(await actor.locator('#formalize-settings [data-chat-participation]').isVisible(), true);
    assert.equal(await actor.locator('.first-research-setup-steps, [data-setup-next], [data-setup-part]').count(), 0);
    const guided = actor.locator('input[name="chat-participation"][value="guided"]');
    assert.equal(await guided.isChecked(), true);
    await actor.locator('input[name="chat-participation"][value="automatic"]').check();
    assert.equal(await actor.locator('#formalize-settings').evaluate(node => (node as HTMLDetailsElement).open), true,
      'Choosing research mode keeps its settings open');
    await guided.check();
    assert.equal(await actor.locator('#formalize-settings').evaluate(node => (node as HTMLDetailsElement).open), true);
    await actor.locator('#formalize-key').fill('sk-simple-workbench-local-only');
    assert.equal(await actor.locator('#formalize-start').isEnabled(), true);
    assert.equal(await actor.locator('[data-chat-configure-key]').count(), 0, 'A filled Key restores the model summary');
    await openAdvancedChatSettings(actor);
    await actor.locator('#research-turns').fill('-1');
    assert.equal(await actor.locator('#formalize-start').isDisabled(), true);
    await actor.locator('#formalize-settings > summary').click();
    await actor.locator('[data-chat-fix-budget="research-turns"]').click();
    assert.equal(await actor.locator('#research-turns').evaluate(node => node === document.activeElement), true);
    assert.equal(await actor.locator('#research-turns').getAttribute('aria-invalid'), 'true');
    assert.equal(await actor.locator('#research-turns-error').isVisible(), true);
    await shot(actor, `budget-error-${locale}-${width}.png`);
    await actor.locator('#research-turns').fill(''); await actor.locator('#formalize-settings > summary').click();
    assert.equal(await actor.locator('#formalize-start').isEnabled(), true);
    mark(`${phase}: required Key and invalid budget reveal and focus their settings without a submission`, { keyToolbar });

    await openHistory(actor); await closeHistory(actor);
    assert.equal(await actor.locator('#formalize-original').inputValue(), original);
    await actor.reload(); await actor.locator('#formalize-original:enabled').waitFor();
    assert.equal(await actor.locator('#formalize-original').inputValue(), original);
    assert.equal(await actor.locator('#formalize-key').inputValue(), '');
    await enterLean(actor);
    assert.equal(await actor.locator('#formalize-settings').getAttribute('open'), null, 'Entering Lean closes the composer settings');
    assert.equal(await actor.locator('#source').inputValue(), '');
    const lean = 'theorem simple_fixture : True := by\n  sorry\n'; await actor.locator('#source').fill(lean);
    await actor.reload(); await actor.locator('#source:visible').waitFor();
    assert.equal(await actor.locator('#source').inputValue(), lean);
    await actor.locator('#open-natural-language').click(); await actor.locator('#formalize-original').waitFor();
    assert.equal(await actor.locator('#formalize-settings').getAttribute('open'), null, 'Returning to natural input keeps composer settings closed');
    assert.equal(await actor.locator('#formalize-original').inputValue(), original);
    mark(`${phase}: history and reload retain the original and separate Lean draft while clearing credentials`);

    await newProblem(actor);
    await actor.locator('[data-chat-examples] > summary').click();
    const example = researchExamples.find(item => item.id === 'add-zero')!;
    await actor.locator('#formalize-example').selectOption(example.id);
    assert.equal(await actor.locator('#formalize-original').inputValue(), locale === 'en' ? example.originalEn : example.original);
    assert.equal(await actor.locator('#formalize-environment').inputValue(), 'mathlib');
    if (!await actor.locator('[data-chat-sample]').isVisible()) await actor.locator('[data-chat-examples] > summary').click();
    await actor.locator('[data-chat-sample]').click();
    await actor.locator('[data-chat-sample-note]').waitFor();
    assert.equal(await actor.locator('#run-detail').isVisible(), false, 'Simple reading keeps the result detail closed');
    const result = actor.locator('[data-chat-result-more]');
    assert.equal(await result.evaluate(node => (node as HTMLDetailsElement).open), false);
    await actor.locator('[data-chat-answer-unavailable]').waitFor();
    assert.equal(await actor.locator('[data-chat-answer-refresh]').count(), 0, 'A read-only sample has no explanation to refresh');
    await actor.locator('#chat-live-panel .live-workspace').waitFor({ state: 'attached' });
    assert.equal(await actor.locator('#chat-live-panel').evaluate(node => [...node.childNodes]
      .some(child => child.nodeType === Node.TEXT_NODE && Boolean(child.textContent?.trim()))), false,
      'The lazy workspace mount removes the loading placeholder completely');
    await result.locator(':scope > summary').click();
    const thinking = result.locator('[data-thinking-process]');
    assert.equal(await thinking.getAttribute('data-active'), 'false', 'A completed sample never shows active thinking');
    assert.doesNotMatch(await result.innerText(), /正在思考…|等待模型返回公开摘要|Thinking…|Waiting for the model/u);
    const process = result.locator('[data-solve-process]');
    await process.locator(':scope > summary').click();
    await process.locator('[data-solve-row]').first().waitFor({ state: 'attached' });
    assert.ok(await process.locator('[data-solve-row]').count() > 0, 'The embedded sample provides real process rows');
    assert.equal(await process.locator('[data-tone="active"]').count(), 0, 'Sample process rows have completed');
    await actor.locator('#research-chat-thread').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await settled(actor);
    const bottomSpace = await actor.locator('#research-chat-thread').evaluate(thread => thread.getBoundingClientRect().bottom
      - thread.querySelector('.chat-result-more-actions')!.getBoundingClientRect().bottom);
    assert.ok(bottomSpace >= 28, `Expanded result actions keep breathing room at the bottom: ${bottomSpace}px`);
    const viewport = actor.viewportSize()!, thread = actor.locator('#research-chat-thread'), latest = actor.locator('[data-chat-latest]');
    for (const height of [viewport.height, 600]) {
      await actor.setViewportSize({ width, height });
      await thread.evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
      await settled(actor);
      assert.equal(await latest.isVisible(), false, 'Latest stays hidden at the bottom of the thread');
      const hiddenHeight = await thread.evaluate(node => node.clientHeight);
      await thread.evaluate(node => {
        node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
        node.scrollTop = 0; node.dispatchEvent(new Event('scroll'));
      });
      await settled(actor);
      // Samples do not bind a saved reading position, so expose the real control to test both CSS states.
      await latest.evaluate(button => { (button as HTMLButtonElement).hidden = false; });
      await latest.waitFor({ state: 'visible' });
      await settled(actor);
      assert.equal(await thread.evaluate(node => node.clientHeight), hiddenHeight, 'Showing latest never changes the thread height');
      assert.equal(await latest.evaluate(button => {
        const box = button.getBoundingClientRect(), thread = document.querySelector('#research-chat-thread')!.getBoundingClientRect(),
          composer = document.querySelector('#natural-research')!.getBoundingClientRect();
        return box.top >= thread.top && box.bottom <= composer.top && button.scrollHeight <= button.clientHeight;
      }), true, 'The latest pill floats inside the thread above the composer without clipping text');
      assert.equal((await latest.boundingBox())!.height, height <= 600 ? 30 : 34, 'Latest keeps its compact viewport-specific height');
      await latest.click();
      await settled(actor);
      assert.equal(await latest.isVisible(), false, 'Latest returns to the bottom of the thread');
      assert.equal(await thread.evaluate(node => node.clientHeight), hiddenHeight, 'Hiding latest never changes the thread height');
    }
    await actor.setViewportSize(viewport);
    await actor.locator('[data-research-artifact="result"]').click(); await actor.locator('.result-verdict').waitFor();
    const closeOutput = actor.locator('#close-research-output'), expandOutput = actor.locator('#expand-research-output');
    assert.equal(await closeOutput.innerText(), width === 1440 ? locale === 'en' ? 'Hide panel' : '收起面板' : locale === 'en' ? 'Back to chat' : '返回对话');
    if (width === 1440) {
      assert.equal(await closeOutput.evaluate(button => {
        const close = button.getBoundingClientRect(), expand = document.querySelector('#expand-research-output')!.getBoundingClientRect();
        return Math.abs(close.y + close.height / 2 - expand.y - expand.height / 2) <= 1 && close.right < expand.left;
      }), true, 'Panel controls share one row without overlapping');
      await expandOutput.click();
      assert.equal(await closeOutput.innerText(), locale === 'en' ? 'Back to chat' : '返回对话');
      assert.equal(await actor.locator('#research-conversation-panel').isVisible(), false);
      await expandOutput.click();
      assert.equal(await closeOutput.innerText(), locale === 'en' ? 'Hide panel' : '收起面板');
      for (const breakpoint of [1100, 1101]) {
        await actor.setViewportSize({ width: breakpoint, height: 1000 }); await settled(actor);
        assert.equal(await closeOutput.innerText(), breakpoint === 1100 ? locale === 'en' ? 'Back to chat' : '返回对话' : locale === 'en' ? 'Hide panel' : '收起面板');
        assert.equal(await actor.locator('#research-conversation-panel').isVisible(), breakpoint === 1101);
      }
      await actor.setViewportSize({ width, height: 1000 });
    }
    assert.equal(await actor.locator('#detail-panel .result-route, #detail-panel [data-result-roadmap]').count(), 0,
      'A simple report leaves detailed routes in their existing workspace tabs');
    assert.equal(await actor.locator('#detail-panel .result-verdict').isVisible(), true);
    assert.equal(await actor.locator('#detail-panel .result-proof').isVisible(), true, 'The report still presents the accepted proof');
    await shot(actor, `sample-report-${locale}-${width}.png`);
    assert.equal(new URL(actor.url()).searchParams.has('sample'), true);
    await actor.locator('#close-research-output').click();
    await newProblem(actor);
    mark(`${phase}: the single examples entry prepares a draft or opens a read-only sample and its report`);
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(external, []); assert.deepEqual(processPolls, [], 'Samples never poll role or agent activity'); assert.equal(workerCalls, 0);
} catch (error) {
  failure = error; globalThis.process.exitCode = 1;
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error);
} finally {
  await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    checks, screenshots, errors, writes, external, processPolls, workerCalls, paidModelCalls: false, leanProcesses: 0, temporaryDataRemoved: true,
    ...(failure ? { phase, error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2) + '\n');
}
