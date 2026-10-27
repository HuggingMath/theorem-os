#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { webSampleRunId } from '../apps/web/shared';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-ui-smoke');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the onboarding check.'); });
await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
// No run is ever submitted here; a call to the runner means the sample leaked into real work.
const runner: WebRunner = {
  async readiness() { return { ready: true, message: '本地引导验证环境' }; },
  async run() { throw new Error('The onboarding check must not start a run'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner);
const mark = (check: string) => console.log(`PASS ${check}`);
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const writes: string[] = [];

let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
try {
  browser = await startBrowser(service.server, port);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (request.method() !== 'GET' && request.url().includes(webSampleRunId)) writes.push(`${request.method()} ${request.url()}`); });
  await page.goto(origin);
  await page.locator('#submit-run:enabled').waitFor();

  // A new visitor sees the three steps, the sample entry and the glossary link.
  const welcome = page.locator('.chat-welcome[data-first-run="true"]');
  await welcome.waitFor();
  assert.deepEqual(await welcome.locator('.welcome-steps strong').allInnerTexts(), ['写下原题', '连接模型', '等待验收']);
  assert.match(await page.locator('.welcome-sample').innerText(), /先看一次完整运行[\s\S]*无需 API Key/u);
  assert.equal(await page.locator('#conversation-scroll').evaluate(scroll => scroll.scrollTop), 0, 'The welcome opens scrolled past its heading');
  await settled(page);
  await page.screenshot({ path: path.join(output, 'onboarding-welcome-1440.png') });
  mark('a first visit explains the three steps and offers the sample run');

  // The sample opens without a key, says it is read-only, and offers no destructive or sharing action.
  await page.locator('.welcome-sample').click();
  await page.locator('[data-sample-badge]').waitFor();
  assert.match(await page.locator('[data-sample-note]').innerText(), /离线脚本[\s\S]*独立验收都是真实执行的/u);
  assert.equal(await page.locator('#detail-tab-overview').getAttribute('aria-selected'), 'true');
  for (const action of ['delete-run', 'cancel', 'share-run']) assert.equal(await page.locator(`[data-action="${action}"]`).count(), 0, `Sample offers ${action}`);
  assert.match(await page.locator('[data-action="reuse-run"]').innerText(), /用这道题开始研究/u);
  assert.match(await page.locator('#detail-panel').innerText(), /完整原题已通过独立验收/u);
  await page.locator('.overview-workspace [data-term="acceptance"]').waitFor();
  assert.equal(await field(page, 'api-key'), '');
  await settled(page);
  await page.screenshot({ path: path.join(output, 'onboarding-sample-1440.png') });
  mark('the sample opens without an API key as a read-only accepted run');

  // Every tab renders the recording; collaboration shows the plan and hides archiving.
  for (const tab of ['collaboration', 'source', 'modules', 'report', 'events']) {
    await page.locator(`#detail-tab-${tab}`).click();
    await page.locator(`#detail-panel[data-tab="${tab}"]`).waitFor();
  }
  // A first visit sees the simple layer: the outcome with a way to the report, and none of the expert sections.
  await page.locator('#detail-tab-collaboration').click();
  await page.locator('.collab-now-ended [data-collab-open-report]').waitFor();
  assert.equal(await page.locator('.collab-layout').isHidden(), true, 'The simple layer shows the task graph');
  assert.equal(await page.locator('.collab-navigation').isHidden(), true, 'The simple layer shows the section navigation');
  await page.locator('.collab-detail-toggle [data-collab-detail="full"]').click();
  await page.locator('.collab-surface [data-collab-task]').first().waitFor();
  assert.equal(await page.locator('[data-collab-archive]').isHidden(), true);
  assert.equal(await page.locator('[data-collab-plan]').isDisabled(), true);
  assert.ok(!(await page.locator('.collab-surface').innerText()).includes('连接中断'), 'Sample collaboration claims a lost connection');
  await settled(page);
  await page.screenshot({ path: path.join(output, 'onboarding-sample-collaboration-1440.png') });
  mark('each tab renders the sample, and collaboration stays read-only without claiming a disconnect');

  // A term hint opens a tip, keeps focus on its button and closes on Escape; the tip links to the glossary.
  const hint = page.locator('.collab-surface [data-term="plan"]');
  await hint.click();
  const tip = page.locator('#term-tip');
  await tip.waitFor({ state: 'visible' });
  assert.equal(await hint.getAttribute('aria-expanded'), 'true');
  assert.match(await tip.innerText(), /任务计划/u);
  await page.keyboard.press('Escape');
  await tip.waitFor({ state: 'hidden' });
  assert.equal(await hint.evaluate(button => button === document.activeElement), true);
  await hint.press('Enter');
  await tip.waitFor({ state: 'visible' });
  await tip.getByRole('button', { name: '全部术语' }).click();
  await page.locator('#glossary-dialog[open]').waitFor();
  assert.equal(await page.locator('#term-plan').getAttribute('data-current'), 'true');
  assert.match(await page.locator('#glossary-dialog').innerText(), /独立验收[\s\S]*S3/u);
  const glossaryFeedback = new URL((await page.locator('#glossary-dialog a[data-feedback]').getAttribute('href'))!);
  assert.equal(glossaryFeedback.pathname, '/feedback.html');
  assert.equal(glossaryFeedback.searchParams.get('area'), 'workbench');
  await settled(page);
  assert.ok(await page.locator('#close-glossary').isVisible() && (await page.locator('#close-glossary').boundingBox())!.y >= 0, 'Glossary scrolled its close button away');
  await page.screenshot({ path: path.join(output, 'onboarding-glossary-1440.png') });
  await page.keyboard.press('Escape');
  await page.locator('#glossary-dialog').waitFor({ state: 'hidden' });
  mark('a term tip is keyboard operable, and its glossary link opens at that term');

  // Inside a modal dialog the tip still shows above it, and Escape closes the tip before the dialog.
  await page.locator('#open-settings').click();
  await page.locator('#run-settings[open]').waitFor();
  const coordination = page.locator('#run-settings [data-term="coordination"]');
  await coordination.scrollIntoViewIfNeeded();
  await coordination.click();
  await tip.waitFor({ state: 'visible' });
  assert.equal(await tip.evaluate(element => element.closest('dialog')?.id), 'run-settings');
  const box = (await coordination.boundingBox())!;
  const covering = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('#term-tip') !== null, [box.x + box.width / 2, box.y + box.height + 20]);
  assert.ok(covering || (await tip.boundingBox())!.y < box.y, 'Tip is not shown next to its button inside the dialog');
  await page.keyboard.press('Escape');
  await tip.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#run-settings').evaluate(dialog => (dialog as HTMLDialogElement).open), true);
  await page.locator('#close-settings').click();
  mark('a tip inside the settings dialog shows above it and Escape closes only the tip');

  // Reusing the sample fills a draft; the key stays empty and the saved position still points nowhere.
  const connection = { provider: await field(page, 'provider'), model: await field(page, 'model'), effort: await field(page, 'effort') };
  await page.locator('[data-action="reuse-run"]').click();
  await page.locator('#draft-preview').waitFor();
  assert.match(await field(page, 'task'), /自然数加法定理/u);
  assert.equal(await field(page, 'api-key'), '');
  assert.deepEqual({ provider: await field(page, 'provider'), model: await field(page, 'model'), effort: await field(page, 'effort') }, connection,
    'Reusing the sample replaced the visitor\'s model connection');
  const resume = await page.evaluate(() => localStorage.getItem('theorem-os.web-resume.v1'));
  assert.equal(resume, null, 'The sample must not become the resumed run');
  await page.locator('#run-settings[open]').waitFor();
  assert.equal(await page.locator('#api-key').evaluate(input => input === document.activeElement), true);
  await page.locator('#close-settings').click();
  await page.locator('#run-settings').waitFor({ state: 'hidden' });
  mark('reusing the sample opens a draft at the empty API key with its task filled, and leaves no resume entry');

  // The glossary and the sample are reachable from the top bar and the command palette.
  await page.locator('#open-glossary').click();
  await page.locator('#glossary-dialog[open]').waitFor();
  await page.locator('#close-glossary').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('#command-palette[open] input').fill('示例');
  await page.locator('#palette-open-sample').click();
  await page.locator('[data-sample-badge]').waitFor();
  // The palette's feedback command opens the prefilled site form in a new tab.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('#command-palette[open] input').fill('反馈');
  await context.route('https://theoremos.top/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>feedback</title>' }));
  const [feedbackTab] = await Promise.all([context.waitForEvent('page'), page.locator('#palette-send-feedback').click()]);
  const opened = new URL(feedbackTab.url());
  assert.equal(opened.pathname, '/feedback.html');
  assert.match(opened.searchParams.get('environment')!, /^TheoremOS workbench · .+ · zh$/u);
  await feedbackTab.close();
  mark('the top bar opens the glossary, and the palette opens the sample and the feedback form');

  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 760 });
    await settled(page);
    assert.ok(await noOverflow(page), `Sample overflows at ${width}px`);
    await page.screenshot({ path: path.join(output, `onboarding-sample-${width}.png`) });
  }
  await page.locator('#new-research').click().catch(() => undefined);
  const fresh = await context.newPage();
  await fresh.setViewportSize({ width: 320, height: 760 });
  await fresh.goto(origin);
  await fresh.locator('.chat-welcome[data-first-run="true"]').waitFor();
  await settled(fresh);
  assert.ok(await noOverflow(fresh), 'Welcome overflows at 320px');
  const bar = await fresh.evaluate(() => { const actions = document.querySelector('.topbar-actions')!; return actions.scrollWidth <= actions.clientWidth + 1 && actions.getBoundingClientRect().right <= innerWidth; });
  assert.ok(bar, 'Top bar actions are clipped at 320px');
  await fresh.screenshot({ path: path.join(output, 'onboarding-welcome-320.png'), fullPage: true });
  mark('welcome and sample fit 375px and 320px without horizontal overflow');

  assert.deepEqual(writes, [], 'The sample run received a write request');
  assert.equal((await (await fresh.request.get(`${origin}/api/runs`)).json()).runs.length, 0);
  assert.deepEqual(errors, []);
  console.log('Onboarding checks passed: first-run steps, read-only sample, tabs, term tips, glossary, reuse and narrow layout.');
} finally {
  await browser?.close();
  await service.close();
}

function field(page: Page, id: string) {
  return page.locator(`#${id}`).inputValue();
}
