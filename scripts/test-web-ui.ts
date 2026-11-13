#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { readWebConfig, webLimits, webTemplates } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebResult, WebRun, WorkerInput } from '../apps/web/shared';
import { closeDialog, closeHistory, closeSettings, discardSourceEditor, fillConfig, openHistory, openSettings, openTab, selectConfig, selectHistoryRun,
  showArtifacts, showChat, stageLabelsReadable, withSettings } from './web-ui-controls';
import { freePort, startBrowser, ready } from './web-scenario';
import { readableDuration } from '../apps/web/presentation';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-ui-smoke');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the browser check.'); });
await fs.mkdir(output, { recursive: true });
await fs.rm(path.join(output, 'report.json'), { force: true });
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const credential = `sk-theoremos-ui-fixture-${crypto.randomUUID()}`;
type Control = { progress(event: string, message?: string): void; artifact(source: string, workerId?: string): void; finish(result: WebResult): void };
const controls = new Map<string, Control>();
const received: WorkerInput[] = [];
const runner: WebRunner = {
  async readiness() { return { ready: true, message: '本地 UI 验证环境' }; },
  async run(input, send, signal) {
    received.push(input);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { controls.delete(input.id); reject(new Error('Cancelled fixture')); };
      signal.addEventListener('abort', abort, { once: true });
      const complete = (result: WebResult) => {
        signal.removeEventListener('abort', abort);
        controls.delete(input.id); send({ type: 'result', result }); resolve();
      };
      controls.set(input.id, {
        progress: (event, message = 'Fixture activity') => send({ type: 'progress', event, message }),
        artifact: (source, workerId = 'engineer') => send({ type: 'artifact', artifact: {
          source, workerId, capturedAt: new Date().toISOString(), status: 'candidate',
        } }),
        finish: complete,
      });
      if (signal.aborted) abort();
    });
  },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner);
const checks: string[] = [];
const screenshots: string[] = [];
const mark = (check: string) => { checks.push(check); console.log(`PASS ${check}`); };
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await startBrowser(service.server, port);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors: string[] = [];
  let creationRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/runs' && request.method() === 'POST') creationRequests++; });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await ready(page);
  // A new Lean draft starts blank in Mathlib; the suite then loads the polynomial template.
  assert.equal(await page.locator('#environment').inputValue(), 'mathlib');
  assert.equal(await page.locator('#source').inputValue(), '');
  const template = webTemplates.find(template => template.id === 'polynomial')!;
  await selectConfig(page, 'template', template.id);
  assert.equal(await page.locator('#source').inputValue(), template.source);
  const initialWidths = [1440, 375, 320];
  const previewValue = (name: string) => page.locator(`#draft-preview [data-preview-value="${name}"]`);
  // The preview renders only while it is open, so each check opens it with the source read first.
  async function assertPreviewSource() {
    const source = await page.locator('#source').inputValue();
    await showArtifacts(page);
    await page.waitForFunction(source => Array.from(document.querySelectorAll('#draft-preview-code code'))
      .map(code => code.textContent ?? '').join('\n') === source, source);
  }
  async function assertPreviewConnection() {
    await showArtifacts(page);
    assert.equal(await previewValue('model').innerText(), await page.locator('#model').inputValue());
    const environment = await page.locator('#environment option:checked').innerText();
    assert.ok((await previewValue('environment').innerText()).includes(environment));
    const seconds = await page.locator('#max-seconds').inputValue();
    const budget = await previewValue('budget').innerText();
    assert.equal(budget, Number(seconds) === 0 ? '不限' : readableDuration(Number(seconds) * 1000), 'preview budget must read the entered seconds as a duration');
    assert.ok((await previewValue('workers').innerText()).includes(await page.locator('#workers').inputValue()));
  }
  // The Lean editor is one centred column; its preview opens from 预览 in place of the composer.
  await showArtifacts(page);
  await page.locator('#draft-preview').waitFor();
  assert.equal(await page.locator('#draft-preview .preview-status').innerText(), '草稿');
  await assertPreviewSource();
  await assertPreviewConnection();
  for (const width of initialWidths) {
    const height = width > 850 ? 900 : 812;
    await page.setViewportSize({ width, height });
    await showChat(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `initial composer overflows ${width}px`);
    assert.equal(await page.locator('#run-settings').isVisible(), false, 'configuration must start collapsed');
    assert.equal(await page.locator('#runs-panel').isVisible(), false, 'the composer stands alone until the preview opens');
    for (const selector of ['#source', '#task', '#submit-run']) {
      // The column scrolls; each control comes into view inside the viewport.
      await page.locator(selector).scrollIntoViewIfNeeded();
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= height + 1,
        `${selector} is outside the ${width}x${height} viewport: ${JSON.stringify(box)}`);
    }
    if (width > 850) assert.ok((await page.locator('#source').boundingBox())!.width >= 400, 'desktop source must retain a readable width');
    await screenshot(width === 1440 ? 'desktop-initial-preview.png' : `mobile-${width}-initial.png`);
    await openSettings(page);
    const settings = await page.locator('#run-settings').boundingBox();
    assert.ok(settings && settings.x >= 0 && settings.y >= 0 && settings.x + settings.width <= width + 1
      && settings.y + settings.height <= height + 1, `settings dialog overflows ${width}x${height}`);
    assert.equal(await page.locator('#run-settings').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), true);
    await closeSettings(page);
    assert.equal(await page.locator('#open-settings').evaluate(node => node === document.activeElement), true);
    await showArtifacts(page);
    await page.locator('#draft-preview').waitFor();
    assert.equal(await page.locator('#compose-panel').isVisible(), false, 'the preview replaces the composer');
    for (const selector of ['#draft-preview', '#draft-preview .preview-source', '#draft-preview .draft-source-scroll']) {
      const bounds = await page.locator(selector).boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${selector} overflows initial ${width}px view`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `initial preview overflows ${width}px`);
    assert.equal(await page.locator('#draft-preview .preview-status').innerText(), '草稿');
    await assertPreviewSource();
    await screenshot(width === 1440 ? 'desktop-initial-source.png' : `mobile-${width}-initial-source.png`);
    await showChat(page);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  mark('the Lean composer and its preview fit 1440, 375 and 320px views, the preview opens in place of the composer, and settings dialogs fit');
  // The chat-first layout shows no pane separator (#pane-resizer is hidden in every view), so no keyboard resizing is checked.

  const previewSource = 'namespace Preview\n\n-- α preview\ntheorem preview : True := by\n  trivial\nend Preview\n';
  const previewTask = '预览更新任务\n保留原始 Lean 声明。';
  await selectConfig(page, 'environment', 'standard');
  await fillConfig(page, 'source', previewSource);
  await page.locator('#task').fill(previewTask);
  await withSettings(page, async () => {
    await page.locator('#model').fill('fixture-preview-model');
    await page.locator('#max-turns').fill('4');
    await page.locator('#max-seconds').fill('125');
    await page.locator('#workers').fill('3');
  });
  await assertPreviewSource();
  await assertPreviewConnection();
  await page.waitForFunction(task => document.querySelector('#draft-preview')?.textContent?.includes(task), previewTask);

  const longPreviewLines = Array.from({ length: 180 }, (_, index) => index === 0
    ? `-- <img data-preview-injection src="fixture"> & ${'long Lean source '.repeat(30)}`
    : `-- source line ${index + 1}`);
  const longPreviewSource = longPreviewLines.join('\n');
  await fillConfig(page, 'source', longPreviewSource);
  await showArtifacts(page);
  await page.waitForFunction(source => document.querySelector('#draft-preview-code code')?.textContent === source,
    longPreviewLines.slice(0, 160).join('\n'));
  assert.equal(await page.locator('#source').inputValue(), longPreviewSource);
  assert.match(await page.locator('.preview-source-heading > span').innerText(), /前 160 \/ 180 行/);
  assert.equal(await page.locator('#draft-preview-code [data-preview-injection]').count(), 0, 'source markup must stay escaped');
  assert.deepEqual((await page.locator('.preview-line-numbers').textContent())?.split('\n'),
    Array.from({ length: 160 }, (_, index) => String(index + 1)));
  for (const width of initialWidths) {
    await page.setViewportSize({ width, height: width > 850 ? 900 : 812 });
    await showArtifacts(page);
    const scrolled = await page.locator('.draft-source-scroll').evaluate(scroll => {
      scroll.scrollTop = 120;
      scroll.scrollLeft = 120;
      return { top: scroll.scrollTop, left: scroll.scrollLeft, height: scroll.getBoundingClientRect().height };
    });
    assert.ok(scrolled.top > 0 && scrolled.left > 0, `long source must scroll both ways at ${width}px`);
    assert.ok(scrolled.height > 0 && scrolled.height <= (width > 850 ? 900 : 812), `preview height must stay bounded at ${width}px`);
    const model = `fixture-preview-model-${width}`;
    await fillConfig(page, 'model', model);
    await showArtifacts(page);
    await page.waitForFunction(model => document.querySelector('[data-preview-value="model"]')?.textContent === model, model);
    const afterEdit = await page.locator('.draft-source-scroll').evaluate(scroll => ({
      top: scroll.scrollTop, left: scroll.scrollLeft, height: scroll.getBoundingClientRect().height,
    }));
    assert.deepEqual(afterEdit, scrolled, `editing the model must preserve source scrolling and height at ${width}px`);
    assert.equal(await page.locator('#draft-preview-code code').textContent(), longPreviewLines.slice(0, 160).join('\n'));
    await showChat(page);
  }
  mark('long draft previews cap at 160 lines, escape source markup and preserve bounded height and both scroll positions after model edits');

  const resizedModel = 'fixture-preview-desktop-resize';
  await fillConfig(page, 'model', resizedModel);
  await page.setViewportSize({ width: 1440, height: 900 });
  await showArtifacts(page);
  await page.waitForFunction(model => document.querySelector('[data-preview-value="model"]')?.textContent === model, resizedModel);
  await assertPreviewConnection();
  mark('a draft edited in the 320px composer updates its preview when resizing directly to desktop');

  await fillConfig(page, 'source', previewSource);
  await assertPreviewSource();
  await withSettings(page, async () => {
    await page.locator('#api-key').fill(credential);
    await page.locator('#toggle-key').click();
  });
  await showArtifacts(page);
  assert.equal((await page.locator('#draft-preview').innerHTML()).includes(credential), false);
  await withSettings(page, async () => {
    for (const id of ['max-turns', 'max-seconds', 'workers']) await page.locator(`#${id}`).fill('');
  });
  await showArtifacts(page);
  assert.equal(await previewValue('budget').innerText(), '不限');
  assert.equal(await previewValue('workers').innerText(), '未设置');
  assert.equal((await page.locator('#draft-preview').innerText()).includes('NaN'), false);
  assert.equal((await page.locator('#draft-preview').innerHTML()).includes(credential), false);
  await withSettings(page, () => page.locator('#reset-form').click());
  // 重置 returns to the blank Mathlib draft; the suite loads the polynomial template again for the runs below.
  assert.equal(await page.locator('#source').inputValue(), '');
  assert.equal(await page.locator('#environment').inputValue(), 'mathlib');
  assert.equal(await page.locator('#api-key').inputValue(), '');
  assert.equal(await page.locator('#api-key').getAttribute('type'), 'password');
  await selectConfig(page, 'template', template.id);
  assert.equal(await page.locator('#source').inputValue(), template.source);
  await showArtifacts(page);
  assert.equal(await page.locator('#draft-preview .preview-status').innerText(), '草稿');
  await assertPreviewSource();
  await assertPreviewConnection();
  assert.equal(creationRequests, 0, 'preview changes and reset must not submit runs');
  assert.equal(received.length, 0, 'preview changes must not start a worker');
  assert.equal(await page.locator('#run-count').textContent(), '0');
  await showChat(page);
  await page.locator('#submit-run').click();
  await page.locator('#run-settings[open]').waitFor();
  assert.equal(await page.locator('#api-key').evaluate(node => node === document.activeElement), true,
    'a missing API key must open settings and focus the required field');
  assert.equal(creationRequests, 0, 'incomplete settings must never create a run');
  await closeSettings(page);
  mark('draft preview mirrors source, task, model, environment and budget, handles empty numbers, excludes the API key and resets without POST requests');

  await page.locator('#task').fill('实数平方展开\n保留原始题目，使用 Mathlib 构造并验证证明。');
  const task = await page.locator('#task').inputValue();
  await withSettings(page, async () => {
    await page.locator('#max-turns').fill('3');
    await page.locator('#max-seconds').fill('90');
    await page.locator('#workers').fill('2');
    await page.locator('input[name="coordination"][value="independent"]').check();
  });
  async function submit(method: 'button' | 'enter' = 'button'): Promise<WebRun> {
    await fillConfig(page, 'api-key', credential);
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'POST');
    if (method === 'enter') await page.locator('#task').press('Enter');
    else await page.locator('#submit-run').click();
    const posted = await response;
    assert.equal(posted.status(), 201);
    const payload = await posted.json() as { run: WebRun };
    assert.equal(JSON.stringify(payload).includes(credential), false);
    await page.waitForFunction(() => (document.querySelector('#api-key') as HTMLInputElement).value === '');
    assert.equal(await page.locator('#task').inputValue(), '', 'a successful send must clear the chat input');
    // A sent task opens as its own run, on every width.
    await page.locator(`[data-run-id="${payload.run.id}"][aria-pressed="true"]`).waitFor({ state: 'attached' });
    await page.locator('body[data-view="run"]').waitFor({ state: 'attached' });
    if ((page.viewportSize()?.width ?? 1440) <= 850) {
      // A run opens on its conversation; its results open from the chat's artifacts.
      await page.locator('#research-conversation-panel').waitFor();
      assert.equal(await page.locator('#history-dialog[open]').count(), 0);
    }
    await openTab(page, 'result');
    assert.equal(await page.locator('#detail-panel .result-task .task-content').innerText(), payload.run.task);
    return payload.run;
  }
  async function screenshot(name: string) {
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.evaluate(() => { if (innerWidth > 850) document.querySelector('#form-fields')!.scrollTop = 0; });
    await page.screenshot({ path: path.join(output, name), fullPage: true });
    screenshots.push(name);
  }
  async function stage(label: string) {
    await page.waitForFunction(label => document.querySelector('.artifact-stages li[data-stage="active"] .stage-label')?.textContent === label, label);
  }
  /** 构造证明's duration in the run header, kept on its stage (shown only while it runs); empty until solving starts. */
  const solvingStage = '.artifact-stages li:nth-child(3)';
  const solvingClock = async () => await page.locator(solvingStage).getAttribute('data-elapsed') ?? '';
  await page.setViewportSize({ width: 375, height: 812 });
  await fillConfig(page, 'api-key', credential);
  await page.locator('#task').dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  assert.equal(creationRequests, 0, 'IME confirmation must not submit a request');
  await page.locator('#task').press('Control+End');
  await page.locator('#task').press('Shift+Enter');
  assert.equal(await page.locator('#task').inputValue(), task + '\n');
  assert.equal(creationRequests, 0, 'Shift+Enter must insert a newline without submitting');
  await page.locator('#task').fill(task);
  const primary = await submit('enter');
  await page.setViewportSize({ width: 1440, height: 900 });
  mark('IME Enter and Shift+Enter never submit; Enter sends once, clears the input and opens the new run on mobile');
  await stage('准备环境');
  assert.equal(await solvingClock(), '');
  const before = await page.locator('[data-header-clock]').innerText();
  await page.waitForFunction(before => document.querySelector('[data-header-clock]')?.textContent !== before, before);
  assert.equal(await solvingClock(), '');
  assert.equal(await page.locator('.artifact-stages .stage-clock').count(), 1, 'only the stage in progress shows a clock');
  await screenshot('desktop-preparing.png');
  mark('Mathlib preparation has a live total clock and leaves the solving clock unstarted');

  await showChat(page);
  await page.locator('#task').fill(task);
  const queued = await submit();
  await stage('排队');
  assert.equal(controls.has(queued.id), false);
  await page.locator('.detail-actions [data-action="cancel"]').click();
  assert.match(await page.locator('#cancel-run-description').innerText(), /还在排队.*不会调用模型/);
  await page.locator('#confirm-cancel-run').click();
  await page.locator('#detail-panel .result-verdict').filter({ hasText: '运行已取消' }).waitFor();
  assert.equal(await page.locator('.artifact-stages li[data-stage="skipped"]').count(), 3);
  assert.equal(controls.has(queued.id), false);
  await selectHistoryRun(page, primary.id);
  await stage('准备环境');
  mark('queued cancellation skips all unexecuted phases and never starts a worker');

  const control = controls.get(primary.id)!;
  control.progress('solve_started');
  const firstCandidate = primary.source.replace('by sorry', 'by\n  sorry') + '-- First live candidate\n';
  const latestCandidate = primary.source.replace('by sorry', 'by\n  ring') + '-- <img data-artifact-injection src=x>\n';
  await page.locator('#detail-tab-source').click();
  control.artifact(firstCandidate);
  await page.waitForFunction(source => document.querySelector('#detail-panel .code-scroll code')?.textContent === source, firstCandidate);
  assert.equal(await page.locator('[data-source-view="proof"]').innerText(), '候选源码');
  assert.equal(await page.locator('.source-status.verified').count(), 0);
  await page.locator('[data-source-view="input"]').click();
  control.artifact(latestCandidate, 'researcher-1');
  await page.waitForFunction(() => document.querySelector('#detail-panel .source-status')?.textContent?.includes('原始题目'));
  assert.equal(await page.locator('#detail-panel .code-scroll code').textContent(), primary.source);
  await page.locator('[data-source-view="proof"]').click();
  await page.waitForFunction(source => document.querySelector('#detail-panel .code-scroll code')?.textContent === source, latestCandidate);
  assert.equal(await page.locator('[data-artifact-injection]').count(), 0, 'live source markup must remain escaped');
  assert.ok((await page.locator('.source-status').innerText()).includes('researcher-1'));
  assert.equal(await page.locator('.source-status.verified').count(), 0);
  await page.locator('[data-action="copy-source"]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), latestCandidate);
  await screenshot('desktop-live-candidate.png');
  await page.setViewportSize({ width: 320, height: 812 });
  await showArtifacts(page);
  await screenshot('mobile-320-live-candidate.png');
  await page.setViewportSize({ width: 1440, height: 900 });
  mark('live worker snapshots update candidate Lean code without implying acceptance or changing the frozen original source');
  for (let index = 0; index < 30; index++) control.progress('worker_activity', `Research step ${index + 1}: inspect the current candidate`);
  await openTab(page, 'events');
  const activity = page.locator('#detail-panel .activity-scroll');
  await page.waitForFunction(() => document.querySelectorAll('#detail-panel .activity-table tbody tr').length >= 30);
  assert.equal(await activity.evaluate(scroll => scroll.scrollHeight > scroll.clientHeight + 240), true);
  // Newest first: reading earlier activity means scrolling down, which pauses following.
  await activity.evaluate(scroll => { scroll.scrollTop = 120; });
  await page.locator('#activity-latest').waitFor();
  assert.equal(await page.locator('#activity-follow').getAttribute('aria-pressed'), 'false');
  /** The first row under the table header, and its offset in the scroll frame. */
  const readingRow = () => activity.evaluate(scroll => {
    const header = scroll.querySelector('thead th')!.getBoundingClientRect().bottom, frame = scroll.getBoundingClientRect().top;
    const row = Array.from(scroll.querySelectorAll<HTMLElement>('tbody tr')).find(row => row.getBoundingClientRect().bottom > header + 1)!;
    return { sequence: row.dataset.sequence, offset: row.getBoundingClientRect().top - frame };
  });
  const reading = await readingRow();
  control.progress('worker_activity', 'Research update while reading earlier activity');
  await page.waitForFunction(() => document.querySelector('#detail-panel .activity-table')?.textContent?.includes('Research update while reading earlier activity'));
  const kept = await readingRow();
  assert.equal(kept.sequence, reading.sequence, 'new activity must keep the row being read');
  assert.ok(Math.abs(kept.offset - reading.offset) <= 1, 'new activity must preserve the reading position while scrolled down');
  assert.ok((await page.locator('#activity-latest').innerText()).includes('1 条新活动'));
  await page.locator('#activity-latest').click();
  await page.waitForFunction(() => document.querySelector('#detail-panel .activity-scroll')!.scrollTop < 1);
  await page.locator('#activity-latest').waitFor({ state: 'hidden' });
  control.progress('worker_activity', 'Research update while following the latest activity');
  await page.waitForFunction(() => document.querySelector('#detail-panel .activity-table tbody tr td:last-child')?.textContent
    ?.includes('Research update while following the latest activity'));
  assert.ok(await activity.evaluate(scroll => scroll.scrollTop) < 1, 'following must keep the newest activity in view');
  await openTab(page, 'result');
  mark('live activity preserves earlier reading positions; returning to the latest resumes following updates');
  for (let index = 0; index < 210; index++) control.progress('worker_activity');
  await stage('构造证明');
  await page.waitForFunction(selector => !['00:00', '--:--', ''].includes(document.querySelector<HTMLElement>(selector)?.dataset.elapsed ?? ''), solvingStage);
  control.progress('evaluation_started');
  await stage('独立验收');
  const solvingTime = await solvingClock();
  assert.equal(await page.locator(`${solvingStage} .stage-clock`).count(), 0, 'a finished stage keeps its duration in the tooltip');
  await page.reload();
  await ready(page);
  await selectHistoryRun(page, primary.id);
  await stage('独立验收');
  assert.equal(await solvingClock(), solvingTime);
  const stored = await page.evaluate(async id => (await (await fetch(`/api/runs/${id}`)).json()).run as WebRun, primary.id);
  assert.equal(stored.events.some(event => event.type === 'solve_started'), false);
  assert.ok(stored.timings?.preparing && stored.timings.solving && stored.timings.evaluating);
  mark('phase clocks survive 200-event rotation and page reload; evaluation freezes solving time');

  const proof = primary.source.replace('by sorry', 'by ring');
  assert.notEqual(proof, primary.source);
  control.finish({ status: 'evaluated_passed', proof, report: { status: 'evaluated_passed', fixture: true, environment: 'mathlib' } });
  await page.locator('#detail-panel .result-verdict.passed').waitFor();
  control.artifact('-- Late snapshot must not override the final proof\n');
  await page.locator('.detail-actions [data-action="cancel"]').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#detail-panel .result-task .facts')?.textContent?.includes('结束时间'));
  assert.equal(await page.locator('.artifact-stages li[data-stage="done"]').count(), 4);
  const completedTime = await page.locator('[data-header-clock]').innerText();
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('[data-header-clock]').innerText(), completedTime);
  await screenshot('desktop-completed.png');
  mark('completed phase clocks freeze and successful acceptance remains explicit');

  await page.locator('#detail-tab-source').click();
  assert.equal(await page.locator('#detail-panel .code-scroll code').textContent(), proof);
  assert.equal(await page.locator('.source-status.verified').count(), 1, 'only the final accepted proof may show verified status');
  await page.locator('[data-action="copy-source"]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), proof);
  await page.locator('[data-source-view="input"]').click();
  assert.equal(await page.locator('#detail-panel .code-scroll code').textContent(), primary.source);
  await page.locator('[data-action="copy-source"]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), primary.source);
  await page.locator('[data-source-view="proof"]').click();
  const download = page.waitForEvent('download');
  await page.locator('[data-action="download-proof"]').click();
  const downloaded = await download;
  assert.equal(await fs.readFile((await downloaded.path())!, 'utf8'), proof);
  assert.equal(downloaded.suggestedFilename(), `${/theorem\s+(\S+)/.exec(primary.source)![1]}.lean`, 'the proof file is named after the theorem, not the run ID');
  await screenshot('desktop-proof.png');
  await page.locator('#detail-tab-result').click();
  await page.locator('#detail-panel .result-proof [data-action="copy-proof"]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), proof);
  await page.locator('#toast').filter({ hasText: '验收证明已复制' }).waitFor();
  await page.locator('#detail-tab-source').click();
  mark('proof and immutable input switch independently; copy and Lean download match the displayed proof');

  // The palette finds a run by the theorem it proves, which the Chinese task never names, and lists each group once.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('#command-palette[open]').waitFor();
  const groups = await page.locator('#command-palette .palette-group').allInnerTexts();
  assert.deepEqual(groups, [...new Set(groups)], 'every palette group heading appears once');
  await page.locator('#command-palette[open] input').fill(/theorem\s+(\S+)/.exec(primary.source)![1]);
  assert.equal(await page.locator(`#palette-run-${primary.id}`).isVisible(), true);
  await page.locator('#command-palette[open] input').fill('api key');
  assert.equal(await page.locator('#palette-options [role="option"]').first().getAttribute('id'), 'palette-open-settings');
  await page.keyboard.press('Escape');
  await page.locator('#command-palette').waitFor({ state: 'hidden' });
  mark('the command palette finds a run by its theorem name and the settings by "api key", with one heading per group');

  // The open run's actions are in the palette too, found by what they do.
  async function paletteFind(query: string) {
    if (!await page.locator('#command-palette[open]').count()) await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await page.locator('#command-palette[open] input').fill(query);
    return page.locator('#palette-options [role="option"]').evaluateAll(nodes => nodes.map(node => node.id));
  }
  assert.deepEqual(await paletteFind('下载'), ['palette-run-download-proof', 'palette-run-download-archive']);
  const paletteDownload = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  const fromPalette = await paletteDownload;
  assert.equal(fromPalette.suggestedFilename(), downloaded.suggestedFilename());
  assert.equal(await fs.readFile((await fromPalette.path())!, 'utf8'), proof);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  assert.equal((await paletteFind('复制'))[0], 'palette-run-copy-proof');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), proof);
  assert.ok((await paletteFind('分享')).includes('palette-run-share'));
  assert.ok((await paletteFind('删除')).includes('palette-run-delete'));
  // Within a group, a command whose name holds the query comes before one that only lists it as a keyword,
  // and a view is found by what it holds: 报告 finds 结果.
  const sourceMatches = (await paletteFind('源码')).filter(id => /^palette-(run-copy-proof|tab-source)$/u.test(id));
  assert.deepEqual(sourceMatches, ['palette-tab-source', 'palette-run-copy-proof']);
  assert.equal((await paletteFind('报告'))[0], 'palette-tab-result');
  await page.keyboard.press('Escape');
  await page.locator('#command-palette').waitFor({ state: 'hidden' });
  // Choosing a run from the palette leaves the keyboard on that run, not on the control the palette was opened from.
  await paletteFind(/theorem\s+(\S+)/.exec(primary.source)![1]);
  await page.locator(`#palette-run-${primary.id}`).click();
  await page.waitForFunction(() => document.activeElement?.id.startsWith('detail-tab-'));
  mark('the palette downloads, copies, shares and deletes the open run, and choosing a run focuses its tabs');

  await selectConfig(page, 'environment', 'standard');
  await page.locator('#task').fill('Changed draft');
  await fillConfig(page, 'api-key', credential);
  // Reuse lives in the run header, so leave the edited draft for the run.
  await selectHistoryRun(page, primary.id);
  await page.locator('[data-action="reuse-run"]').click();
  await closeSettings(page);
  assert.equal(await page.locator('#environment').inputValue(), 'mathlib');
  assert.equal(await page.locator('#source').inputValue(), primary.source);
  assert.equal(await page.locator('#task').inputValue(), task);
  assert.equal(await page.locator('#max-turns').inputValue(), '3');
  assert.equal(await page.locator('#max-seconds').inputValue(), '90');
  assert.equal(await page.locator('#workers').inputValue(), '2');
  assert.equal(await page.locator('input[name="coordination"]:checked').inputValue(), 'independent');
  assert.equal(await page.locator('#api-key').inputValue(), '');
  assert.equal(await page.locator('#api-key').getAttribute('type'), 'password');
  assert.equal(await page.locator('#template').inputValue(), '');
  assert.equal(received.length, 1);
  assert.equal(await page.locator('#run-count').textContent(), '2');
  mark('reuse restores original task, environment and budget, clears the key and does not submit a run');

  const requestsBeforeEditing = creationRequests;
  await selectConfig(page, 'template', 'polynomial');
  const imported = 'import Mathlib\r\n\r\ntheorem imported_sum (x : ℝ) : x + 0 = x := by\r\n  sorry\r\n';
  await page.locator('#source-file').setInputFiles({ name: 'sample.LEAN', mimeType: 'text/plain', buffer: Buffer.from(imported) });
  await page.waitForFunction(source => (document.querySelector('#source') as HTMLTextAreaElement).value === source.replace(/\r\n/g, '\n'), imported);
  assert.equal(await page.locator('#template').inputValue(), '');
  assert.equal(await page.locator('#environment').inputValue(), 'mathlib');
  assert.equal(await page.locator('#task').inputValue(), '保留原题声明，补全 Lean 证明并通过独立验收。');
  const importedDraft = await page.locator('#source').inputValue();
  await page.locator('#task').fill('自定义导入任务');
  await page.locator('#source-file').setInputFiles({ name: 'again.lean', mimeType: 'text/plain', buffer: Buffer.from(imported) });
  await page.locator('#toast').filter({ hasText: 'Lean 文件已载入' }).waitFor();
  assert.equal(await page.locator('#task').inputValue(), '自定义导入任务');
  await openSettings(page);
  for (const file of [{ name: 'wrong.txt', buffer: Buffer.from('not Lean') }, { name: 'large.lean', buffer: Buffer.alloc(webLimits.maxSourceBytes + 1, 'a') }]) {
    await page.locator('#source-file').setInputFiles({ ...file, mimeType: 'text/plain' });
    await page.locator('#source-error').waitFor();
    assert.equal(await page.locator('#source').inputValue(), importedDraft);
  }
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      File.prototype.arrayBuffer = original;
      const data = await original.call(this);
      await new Promise<void>(resolve => { (window as unknown as { releaseImport: () => void }).releaseImport = resolve; });
      return data;
    };
  });
  await page.locator('#source-file').setInputFiles({ name: 'late.lean', mimeType: 'text/plain', buffer: Buffer.from(imported) });
  await page.waitForFunction(() => typeof (window as unknown as { releaseImport?: () => void }).releaseImport === 'function');
  const newerDraft = importedDraft + '\n-- Updated during file read';
  await fillConfig(page, 'source', newerDraft);
  await page.evaluate(() => (window as unknown as { releaseImport: () => void }).releaseImport());
  await page.locator('#toast').filter({ hasText: '草稿已变化，未导入文件' }).waitFor();
  assert.equal(await page.locator('#source').inputValue(), newerDraft);
  mark('Lean import stays local, preserves environment and custom task, rejects invalid files and cannot overwrite a newer draft');

  // The full-screen source editor opens from the Lean composer and returns there.
  await showChat(page);
  await page.locator('#expand-source').click();
  await page.locator('#source-editor[open]').waitFor();
  assert.equal(await page.locator('#expanded-source').evaluate(node => node === document.activeElement), true);
  await page.locator('#expanded-source').fill('discarded');
  await discardSourceEditor(page);
  assert.equal(await page.locator('#source').inputValue(), newerDraft);
  await page.locator('#expand-source').click();
  await page.locator('#expanded-source').fill('discarded by Escape');
  await discardSourceEditor(page, () => page.keyboard.press('Escape'));
  assert.equal(await page.locator('#source').inputValue(), newerDraft);
  assert.equal(await page.locator('#expand-source').evaluate(node => node === document.activeElement), true);
  await page.locator('#expand-source').click();
  await page.locator('#expanded-source').fill(' ');
  await page.locator('#apply-editor').click();
  await page.locator('#editor-error').waitFor();
  await page.locator('#expanded-source').fill('a'.repeat(webLimits.maxSourceBytes + 1));
  await page.locator('#apply-editor').click();
  assert.ok((await page.locator('#editor-error').innerText()).includes('大小'));
  assert.equal(await page.locator('#source').inputValue(), newerDraft);
  const edited = newerDraft + '\n-- Applied in expanded editor';
  await page.locator('#expanded-source').fill(edited);
  await screenshot('desktop-source-editor.png');
  await closeDialog(page, '#source-editor', () => page.locator('#apply-editor').click());
  assert.equal(await page.locator('#source').inputValue(), edited);
  assert.equal(creationRequests, requestsBeforeEditing);
  assert.equal(await page.locator('#api-key').inputValue(), '');
  await closeSettings(page);
  await selectHistoryRun(page, primary.id);
  await page.locator('[data-action="reuse-run"]').click();
  await closeSettings(page);
  mark('expanded editing applies atomically, validates size and restores focus; Cancel and Escape preserve the composer');

  await selectConfig(page, 'environment', 'standard');
  const standardAddition = webTemplates.find(item => item.id === 'addition')!;
  await fillConfig(page, 'source', standardAddition.source);
  await fillConfig(page, 'task', standardAddition.task);
  await openHistory(page);
  await page.locator('#run-filter').selectOption('error');
  await page.locator('#run-search').fill('not-a-current-run');
  await closeHistory(page);
  const incomplete = await submit();
  assert.equal(await page.locator('#run-filter').inputValue(), 'all');
  assert.equal(await page.locator('#run-search').inputValue(), '');
  await stage('准备环境');
  controls.get(incomplete.id)!.progress('solve_started');
  controls.get(incomplete.id)!.finish({ status: 'incomplete', proof: incomplete.source,
    report: { status: 'incomplete', fixture: true, environment: 'standard' } });
  await page.locator('#detail-panel .result-verdict.warning').waitFor();
  assert.equal(await page.locator('.artifact-stages li').nth(3).getAttribute('data-stage'), 'skipped');
  assert.equal(await page.locator('#detail-panel .result-verdict.passed').count(), 0);
  await page.locator('#detail-tab-source').click();
  assert.equal(await page.locator('[data-source-view="proof"]').innerText(), '候选源码');
  mark('an incomplete standard-library attempt stays unaccepted and leaves evaluation unexecuted');

  await openHistory(page);
  await page.locator('#run-filter').selectOption('passed');
  assert.equal(await page.locator('[data-run-id]').count(), 1);
  assert.equal(await page.locator('#run-count').textContent(), '1/3');
  assert.equal(await page.locator('[data-run-id]').getAttribute('data-run-id'), primary.id);
  assert.equal(await page.locator('.detail-heading').getAttribute('data-run'), incomplete.id);
  await page.locator('#run-search').fill(`MATHLIB ${primary.model.toUpperCase()}`);
  assert.equal(await page.locator('[data-run-id]').count(), 1);
  await page.locator('#run-search').fill('no-matching-run');
  await page.locator('[data-clear-filters]').waitFor();
  assert.equal(await page.locator('[data-run-id]').count(), 0);
  await page.locator('#clear-run-search').click();
  assert.equal(await page.locator('#run-filter').inputValue(), 'passed');
  assert.equal(await page.locator('[data-run-id]').count(), 1);
  await page.locator('#run-search').fill('no-matching-run');
  await page.locator('[data-clear-filters]').click();
  assert.equal(await page.locator('#run-filter').inputValue(), 'all');
  assert.equal(await page.locator('[data-run-id]').count(), 3);
  await page.locator('#run-filter').selectOption('unproved');
  await page.locator(`[data-run-id="${incomplete.id}"]`).focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('.run-row.selected').getAttribute('data-run-id'), incomplete.id);
  await openHistory(page);
  await page.locator('#run-filter').selectOption('cancelled');
  assert.equal(await page.locator('[data-run-id]').getAttribute('data-run-id'), queued.id);
  await page.locator('#run-filter').selectOption('all');
  await page.locator('[data-run-id]').first().focus();
  await page.keyboard.press('End');
  assert.equal(await page.locator('.run-row.selected').getAttribute('data-run-id'), primary.id);
  mark('history combines status and text, retains hidden selection, distinguishes accepted results and navigates only filtered rows');

  await selectHistoryRun(page, primary.id);
  await page.locator('#detail-panel .result-verdict.passed').waitFor();
  const widths = [1440, 1250, 1024, 851, 850, 375, 320];
  for (const width of widths) {
    const height = width > 850 ? 640 : 812;
    await page.setViewportSize({ width, height });
    await showChat(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `compose overflow at ${width}`);
    if (width > 850) {
      // The Lean editor is one scrolling column; 提交 at its foot scrolls into view and the page itself never scrolls.
      await page.locator('#submit-run').scrollIntoViewIfNeeded();
      const submit = await page.locator('#submit-run').boundingBox();
      assert.ok(submit && submit.y >= 0 && submit.y + submit.height <= height, `submit outside ${width}x${height}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, `desktop page scrolls at ${width}`);
    }
    await selectHistoryRun(page, primary.id);
    if (width <= 850) {
      await openHistory(page);
      const selected = await page.locator('.run-row.selected').boundingBox();
      assert.ok(selected && selected.x >= 0 && selected.x + selected.width <= width, `selected history item hidden at ${width}`);
      await closeHistory(page);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `detail overflow at ${width}`);
    // The run has ended, so phones name every stage too instead of showing four bare check marks.
    await stageLabelsReadable(page, `${width}px`);
    await page.locator('#detail-tab-source').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `source overflow at ${width}`);
    if (width === 320) await screenshot('mobile-320-proof.png');
    await openTab(page, 'result');
    if (width === 1024) await screenshot('desktop-1024-completed.png');
    if (width === 375 || width === 320) {
      await screenshot(`mobile-${width}-completed.png`);
      await page.locator('[data-action="reuse-run"]').click();
      await showChat(page);
      assert.equal(await page.locator('#source').isVisible(), true);
      assert.equal(await page.locator('#api-key').inputValue(), '');
      assert.equal(await page.locator('#environment').inputValue(), 'mathlib');
      await page.locator('#expand-source').click();
      const editor = await page.locator('#source-editor').boundingBox();
      const apply = await page.locator('#apply-editor').boundingBox();
      assert.ok(editor && editor.x >= 0 && editor.x + editor.width <= width && editor.y >= 0 && editor.y + editor.height <= height);
      assert.ok(apply && apply.y >= 0 && apply.y + apply.height <= height && apply.x + apply.width <= width);
      assert.equal(await page.locator('#source-editor').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      await screenshot(`mobile-${width}-source-editor.png`);
      await closeDialog(page, '#source-editor', () => page.locator('#cancel-editor').click());
    }
  }
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(key => JSON.stringify(localStorage).includes(key) || JSON.stringify(sessionStorage).includes(key), credential), false);
  mark('320–1440px views fit; desktop submission scrolls into view at 640px height without page scroll; mobile reuse and source controls work');
  const report = { status: 'passed', checkedAt: new Date().toISOString(), mode: 'Real HTTP service and Chromium; controlled worker fixture. No Docker, Lean or model provider is called.',
    paidModelCalls: false, checks, widths, initialWidths, screenshots };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Browser report: ${path.join(output, 'report.json')}`);
} finally {
  await browser?.close();
  await service.close();
}
