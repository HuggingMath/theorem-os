#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { loadWebSample } from '../apps/web/sample';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput, WorkerInput } from '../apps/web/shared';
import { closeSettings, openSettings, openTab as openRunTab, selectHistoryRun, openSample, showArtifacts } from './web-ui-controls';
import { audit } from './web-a11y';
import { freePort, postRun, readRun, ready, settled, startBrowser, waitForRun } from './web-scenario';
import { replaySample, withFailedAttempt } from './web-trajectory-fixture';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// This suite exercises the retained version/event reader; test-web-roadmap covers the default visual view.
const openTab = async (page: Page, tab: string) => {
  await openRunTab(page, tab);
  if (tab === 'trajectory') await page.locator('[data-trajectory-view="steps"]').click();
};
/** Beside the chat the run panel is narrower than a viewer column; 展开成果 gives it the width the side viewer needs. */
const expandResults = async (page: Page) => {
  if (await page.locator('body[data-results-expanded="true"]').count()) return;
  await page.locator('#expand-research-output').click();
  await page.locator('body[data-results-expanded="true"]').waitFor({ state: 'attached' });
};
const output = path.join(root, 'out/web-ui-smoke');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the trajectory check.'); });
await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const sample = loadWebSample()!, recording = withFailedAttempt(sample);
/** A pause in the replay before one of its observations: `reached` once the replay waits there, `release` to go on. */
type Gate = { reached: Promise<void>; arrive: () => void; release: () => void; open: Promise<void> };
const gate = (): Gate => {
  let arrive = () => {}, release = () => {};
  const reached = new Promise<void>(resolve => { arrive = resolve; }), open = new Promise<void>(resolve => { release = resolve; });
  return { reached, arrive, release, open };
};
// Before observation 3 the first attempt has passed; before 4 the second has failed; before 5 the third has passed.
const gates = new Map([[3, gate()], [4, gate()], [5, gate()]]);
const continued: WorkerInput[] = [];
// The recording replays at its own pace, about eleven seconds from the first event to the result, plus the pauses.
const runner: WebRunner = {
  async readiness() { return { ready: true, message: '本地轨迹验证环境' }; },
  run: async (input, send, signal) => {
    // A run started from a recorded version only has to show what reached the worker.
    if (input.continuation) {
      continued.push(input);
      send({ type: 'result', result: { status: 'incomplete', proof: input.continuation.source.replace('exact Nat.zero_add n', 'simp'), report: {} } }); return;
    }
    let observations = 0;
    return replaySample(recording, input.id, send, signal, { hold: message => {
      if (message.type !== 'observation') return undefined;
      const held = gates.get(observations++);
      held?.arrive();
      return held?.open;
    } });
  },
};
// A local stand-in for the provider answers 问为什么; each answer waits for `answerNext` so the pending state can be seen.
const explained: { authorization?: string; body: { model: string; input: { role: string; content: { text: string }[] }[] } }[] = [];
let answerNext = () => {}, dropped = 0;
const explanation = '**原因**：`rfl` 只在两边按定义算出来相同的时候成立。`Nat` 的加法对第二个参数递归，`0 + n` 算不下去。\n\n改用引理：\n\n```lean\ntheorem zero_add (n : Nat) : 0 + n = n := by\n  exact Nat.zero_add n\n```';
const provider = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', chunk => chunks.push(chunk));
  response.on('close', () => { if (!response.writableEnded) dropped++; });
  request.on('end', () => {
    explained.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    answerNext = () => response.end([...explanation.match(/[\s\S]{1,12}/gu)!].map(delta => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`).join('')
      + `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 1180, output_tokens: 140, total_tokens: 1320 } } })}\n\n`);
  });
});
await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
const service = createWebService({ ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }),
  providers: [{ id: 'openai', name: 'OpenAI', baseUrl: `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}/v1` }] }, runner);
const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-theoremos-trajectory-fixture', model: 'fixture-trajectory-model',
  effort: 'low', environment: 'standard', source: sample.run.source, task: sample.run.task, maxTurns: 12, maxRunSeconds: 300,
  workers: 3, coordination: 'cooperative' };
const mark = (check: string) => console.log(`PASS ${check}`);
/** The account's line for each Agent, as one line of text. */
const tallyAgents = (page: Page) => page.locator('[data-tally-agent]').evaluateAll(rows => rows.map(row => (row as HTMLElement).innerText.replace(/\s+/gu, ' ').trim()));
const steps = (page: Page) => page.locator('#detail-panel .trajectory-step');
const kinds = (page: Page) => steps(page).evaluateAll(items => items.map(item => item.getAttribute('data-kind')));
const step = (page: Page, selector: string) => page.locator(`#detail-panel .trajectory-step${selector}`);
const viewer = (page: Page) => page.locator('#trajectory-viewer');
const modal = (page: Page) => viewer(page).evaluate(dialog => dialog.matches(':modal'));
const shot = async (page: Page, name: string) => { await settled(page); await page.screenshot({ path: path.join(output, name) }); };
const trajectoryReads = (requests: URL[]) => requests.filter(url => /^\/api\/runs\/[^/]+\/trajectory$/u.test(url.pathname));
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
  && [...document.querySelectorAll('#detail-panel .trajectory-step')].every(item => item.getBoundingClientRect().right <= innerWidth + 1));
/** How far the trajectory's scroller is from its bottom, in pixels. */
const gap = (page: Page) => page.locator('#detail-panel').evaluate(panel => panel.scrollHeight - panel.scrollTop - panel.clientHeight);
const atBottom = async (page: Page, label: string) => {
  for (let tries = 0; tries < 40; tries++) { if (await gap(page) <= 4) return; await page.waitForTimeout(100); }
  assert.fail(`${label}: ${await gap(page)}px above the latest step`);
};
/** Opens a folded step and one of its panels, unless it is open already; the panel shows in the viewer. */
const open = async (page: Page, item: ReturnType<typeof step>, mode: string) => {
  if (await item.getAttribute('data-open') === 'false') await item.locator('.trajectory-fold').click();
  const toggle = item.locator(`[data-trajectory-mode="${mode}"]`);
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator('#trajectory-viewer[open]').waitFor();
};
const focused = (page: Page) => page.evaluate(() => {
  const element = document.activeElement as HTMLElement | null;
  return element?.dataset.trajectoryMode ?? element?.dataset.step ?? element?.className ?? '';
});

let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
try {
  browser = await startBrowser(service.server, port);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [], requests: URL[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text()); });
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) requests.push(url); });
  await page.goto(origin);
  await ready(page);
  await openSample(page);
  await openTab(page, 'trajectory');
  await expandResults(page);
  await step(page, '[data-kind="evaluation"]').waitFor();
  assert.deepEqual(await kinds(page), ['problem', 'plan', 'guidance', 'attempt', 'edit', 'attempt', 'proof', 'guidance', 'delivery', 'evaluation']);
  assert.equal(await page.locator('[data-trajectory-detail="simple"]').getAttribute('aria-pressed'), 'true', '简洁 is the default');
  assert.match(await step(page, '[data-kind="problem"]').innerText(), /add_zero[\s\S]*zero_add/u);
  assert.equal(await step(page, '[data-kind="evaluation"]').getAttribute('data-tone'), 'passed');
  const assembled = step(page, '[data-kind="proof"]');
  assert.equal(await assembled.getAttribute('data-open'), 'false', 'a passed step folds to its title line');
  assert.equal(await assembled.locator('[data-trajectory-mode]').count(), 0);
  await open(page, assembled, 'code');
  assert.equal(await assembled.getAttribute('data-open'), 'true');
  assert.match(await viewer(page).locator('.trajectory-code-text').innerText(), /exact Nat\.zero_add n/u);
  const code = assembled.locator('[data-trajectory-mode="code"]');
  assert.equal(await code.getAttribute('aria-expanded'), 'true');
  assert.equal(await code.getAttribute('aria-controls'), 'trajectory-viewer');
  assert.equal(await modal(page), false, 'on a wide screen the viewer sits beside the steps');
  const [list, side] = await Promise.all([page.locator('#detail-panel .trajectory').boundingBox(), viewer(page).boundingBox()]);
  assert.ok(list && side && side.x >= list.x + list.width, `viewer beside the steps: ${JSON.stringify({ list, side })}`);
  assert.equal(await viewer(page).locator('.trajectory-gutter').count(), 0, 'a finished run has no line guidance');
  assert.equal(await page.locator('#detail-panel [data-trajectory-continue]').count(), 0, 'the sample has no version of the visitor\'s own to continue from');
  assert.equal(await page.locator('#detail-panel [data-trajectory-mode="ask"]').count(), 0, 'nor one to ask about');
  // The finished run closes with its account: in 简洁 one line, without the Agents.
  assert.match(await page.locator('[data-tally-line]').innerText(), /^用时 .+ · Lean 检查 6 次 · 尝试 2 次 · 任务 2 个$/u);
  assert.equal(await page.locator('[data-tally-agent]').count(), 0, '简洁 leaves the Agents out of the account');
  assert.deepEqual(await audit(page, { scope: '#detail-panel' }), [], 'Sample trajectory accessibility');
  await shot(page, 'trajectory-sample-1440.png');
  await page.keyboard.press('Escape');
  await viewer(page).waitFor({ state: 'detached' });
  assert.equal(await focused(page), 'code', 'closing the viewer returns to the button that opened it');
  mark('the welcome sample reads as ten folded mathematical steps, with the assembled proof one click away beside them');

  await page.locator('[data-trajectory-detail="full"]').click();
  await page.locator('#detail-panel .trajectory-overview').waitFor();
  assert.match(await step(page, '[data-kind="plan"]').innerText(), /Lead/u, '详细 names the Agents');
  // 详细 adds what each Agent did: the Lead's plan and assembly, the Researcher's report, the Engineer's tasks.
  assert.deepEqual(await tallyAgents(page), ['Lead 写了 1 版计划 · 组装完整证明 1 次', 'Researcher 提交 1 份报告',
    'Engineer 做了 add_zero zero_add · 通过 2 个 · 尝试 2 次']);
  await openTab(page, 'collaboration');
  assert.equal(await page.locator('.collab-detail-toggle [data-collab-detail="full"]').getAttribute('aria-pressed'), 'true', 'one detail level for both tabs');
  await page.locator('.collab-detail-toggle [data-collab-detail="simple"]').click();
  await openTab(page, 'trajectory');
  await step(page, '[data-kind="evaluation"]').waitFor();
  assert.equal(await page.locator('#detail-panel .trajectory-overview').count(), 0);
  assert.doesNotMatch(await page.locator('#detail-panel .trajectory-steps').innerText(), /Engineer|第 1 次/u, '简洁 leaves out who and which try');
  mark('简洁 and 详细 switch the trajectory and the collaboration tab together; 详细 adds the time overview and the Agents');

  // A short window, so the live steps overflow it and following the latest one means scrolling.
  await page.setViewportSize({ width: 1440, height: 560 });
  const run = await postRun({ page }, input, 'Trajectory fixture'), liveStart = Date.now();
  await page.reload();
  await ready(page);
  await selectHistoryRun(page, run.id, 'trajectory');
  await openTab(page, 'trajectory');
  await expandResults(page);
  const live = step(page, '[data-kind="live"]');
  await live.waitFor();
  assert.match(await live.innerText(), /进行中/u);
  assert.match(await live.innerText(), /Lead|Engineer|Researcher/u, 'the live step names who is working, also in 简洁');
  assert.doesNotMatch(await page.locator('#detail-panel .trajectory').innerText(), /goal_\d/u, 'tasks are named by their theorems');
  await gates.get(3)!.reached;
  const first = step(page, '[data-kind="attempt"]').first();
  await first.waitFor();
  // The replay is held here, so the run's newest message stays its last: the live step leads with it, the Agent named.
  const newest = (await readRun({ page }, run.id)).events.at(-1)!, worker = newest.details?.workerId;
  const said = worker && newest.message.endsWith(` · ${worker}`) ? newest.message.slice(0, -worker.length - 3) : newest.message;
  const liveLatest = live.locator('.trajectory-live-latest');
  await page.waitForFunction(({ text }) => document.querySelector('#detail-panel .trajectory-live-latest>span')?.textContent?.startsWith(text), { text: said.split('\n', 1)[0]! });
  assert.match(await liveLatest.locator('time').innerText(), /^\+\d\d:\d\d/u, 'the message keeps its time since the start, as the steps do');
  if (worker) assert.doesNotMatch(await liveLatest.innerText(), new RegExp(` · ${worker}$`, 'u'), 'the Agent is named, not its id');
  assert.ok(await page.locator('#detail-panel').evaluate(panel => panel.scrollHeight > panel.clientHeight + 100), 'the live steps overflow');
  await atBottom(page, 'a live run follows its latest step');
  assert.equal(await page.locator('[data-trajectory-tally]').count(), 0, 'a running run has no account yet');
  await shot(page, 'trajectory-live-1440.png');
  mark('a live run shows its Agents at work under its newest message, and keeps its latest step in view');

  await open(page, first, 'code');
  await viewer(page).locator('.trajectory-code-text').waitFor();
  const gutter = viewer(page).locator('.trajectory-gutter button');
  const lines = (await viewer(page).locator('.trajectory-code-text').innerText()).split('\n');
  assert.deepEqual(await gutter.evaluateAll(items => items.map(item => item.getAttribute('data-line'))),
    lines.flatMap((line, index) => line.trim() ? [String(index + 1)] : []), 'every line of the running attempt with code on it has a guidance button');
  assert.equal(lines[0], 'namespace Tutorial'); assert.equal(lines[1], ''); assert.match(lines[2]!, /^theorem add_zero/u);
  assert.deepEqual(await audit(page, { scope: '#detail-panel' }), [], 'Live trajectory accessibility');
  await gutter.first().focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.line), '3', 'arrow keys move between lines, past blank ones');
  await shot(page, 'trajectory-line-1440.png');
  await page.keyboard.press('Enter');
  await page.locator('#detail-tab-collaboration[aria-selected="true"]').waitFor();
  const draft = page.locator('#detail-panel [data-guidance-text]');
  await draft.waitFor();
  assert.equal(await draft.inputValue(), 'Submission.lean 第 3 行：theorem add_zero (n : Nat) : n + 0 = n := by rfl');
  assert.equal(await page.locator('#detail-panel [data-guidance-notice]').innerText(), '代码行已加入本地指导草稿，尚未发送');
  assert.equal(await page.locator('#detail-panel [data-guidance-kind]').inputValue(), 'task');
  assert.equal(await page.locator('#detail-panel [data-guidance-target]').inputValue(), 'goal_1', 'addressed to the attempt\'s task');
  assert.equal(await draft.evaluate(text => text === document.activeElement), true, 'the draft takes focus');
  await shot(page, 'trajectory-line-draft-1440.png');
  mark('a line of a running attempt goes into the guidance draft, unsent, addressed to its task');

  await openTab(page, 'trajectory');
  await first.waitFor();
  await atBottom(page, 'coming back to a live run starts at its latest step');
  await page.locator('#detail-panel').evaluate(panel => { panel.scrollTop = 0; });
  await settled(page);
  const back = page.locator('#detail-panel .trajectory-latest');
  await back.waitFor();
  assert.equal(await back.innerText(), '回到最新');
  gates.get(3)!.release();
  await gates.get(4)!.reached;
  await back.filter({ hasText: '新增' }).waitFor();
  assert.equal(await page.locator('#detail-panel').evaluate(panel => panel.scrollTop), 0, 'a reader who scrolled up stays where they are');
  assert.match(await back.innerText(), /^回到最新 · 新增 \d+ 步$/u);
  await shot(page, 'trajectory-latest-1440.png');
  await back.click();
  await atBottom(page, '回到最新');
  await back.waitFor({ state: 'detached' });
  const latest = await page.locator('#detail-panel .trajectory-steps').getAttribute('data-latest');
  gates.get(4)!.release();
  await gates.get(5)!.reached;
  await page.waitForFunction(before => document.querySelector('#detail-panel .trajectory-steps')?.getAttribute('data-latest') !== before, latest);
  await atBottom(page, 'following again after 回到最新');
  gates.get(5)!.release();
  mark('scrolling up stops following and counts new steps on 回到最新, which goes back to following');

  await step(page, '[data-kind="evaluation"][data-tone="passed"]').waitFor({ timeout: 20_000 });
  await waitForRun({ page }, run.id, run => run.status === 'completed');
  await live.waitFor({ state: 'detached' });
  await page.waitForTimeout(2_000);
  // Once the run ends its account counts the failed try too: one more Lean check and one more attempt than the sample.
  assert.match(await page.locator('[data-tally-line]').innerText(), /^用时 .+ · Lean 检查 7 次 · 尝试 3 次 · 任务 2 个$/u);
  const liveSeconds = (Date.now() - liveStart) / 1000;
  assert.equal(await page.locator('#detail-panel .trajectory-latest').count(), 0);
  assert.deepEqual(await kinds(page), ['problem', 'plan', 'guidance', 'attempt', 'edit', 'attempt', 'proof', 'guidance', 'delivery', 'evaluation'],
    '简洁 leaves out the attempt a later one replaced');
  await page.locator('[data-trajectory-detail="full"]').click();
  // 详细 has zero_add's two attempts as one line, folded once the second passed, and opening to both.
  const retries = step(page, '[data-kind="retries"]');
  await retries.waitFor();
  assert.deepEqual(await kinds(page), ['problem', 'plan', 'guidance', 'attempt', 'edit', 'retries', 'proof', 'guidance', 'delivery', 'evaluation']);
  assert.equal(await retries.getAttribute('data-open'), 'false', 'the attempts fold once the last one passed');
  assert.equal((await retries.locator('h4').innerText()).replace(/\s+/gu, ' ').trim(), 'zero_add Engineer 试了 2 次 第 2 次通过 已集成 通过', 'one line, with the tone spoken for a screen reader');
  await retries.locator('.trajectory-fold').first().click();
  await step(page, '[data-kind="attempt"][data-tone="failed"]').waitFor();
  assert.deepEqual(await kinds(page), ['problem', 'plan', 'guidance', 'attempt', 'edit', 'retries', 'attempt', 'attempt', 'proof', 'guidance', 'delivery', 'evaluation']);
  const reads = trajectoryReads(requests).filter(url => url.pathname.includes(run.id));
  assert.ok(reads.length >= 2 && reads.length <= liveSeconds / 1.5 + 8, `trajectory reads during ${liveSeconds.toFixed(0)} s: ${reads.length}`);
  assert.ok(reads.slice(1).every(url => url.searchParams.get('instance') && Number(url.searchParams.get('after')) > 0), 'later reads ask only for what is new');
  assert.ok(Number(reads.at(-1)!.searchParams.get('since')) > 0, 'later reads skip versions already held');
  mark(`the finished run settles into the same steps; 详细 has zero_add's two attempts as one folded line that opens to both (${reads.length} incremental reads in ${liveSeconds.toFixed(0)} s)`);

  await page.setViewportSize({ width: 1440, height: 900 });
  const failed = step(page, '[data-kind="attempt"][data-tone="failed"]');
  assert.equal(await failed.getAttribute('data-open'), 'false', 'a failed attempt a later one replaced is folded in its run');
  const failedText = await failed.innerText();
  for (const text of ['第 1 次', '未通过：The rfl tactic failed.']) assert.ok(failedText.includes(text), `failed attempt shows ${text}`);
  assert.equal(await failed.locator('.trajectory-marker').evaluate(marker => getComputedStyle(marker, '::after').backgroundColor !== 'rgba(0, 0, 0, 0)'), true,
    'a failure is marked by a red dot');
  assert.doesNotMatch(await page.locator('#detail-panel .trajectory').innerText(), /goal_\d|Possible reasons/u);
  await open(page, failed, 'feedback');
  await viewer(page).locator('.trajectory-feedback').waitFor();
  const feedback = failed.locator('[data-trajectory-mode="feedback"]');
  assert.equal(await feedback.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator(`#${await feedback.getAttribute('aria-controls')}`).count(), 1);
  assert.match(await viewer(page).locator('.trajectory-feedback').innerText(), /The rfl tactic failed[\s\S]*⊢ 0 \+ n = n/u);
  assert.equal(await viewer(page).locator('.trajectory-gutter').count(), 0, 'line guidance ends with the run');
  await shot(page, 'trajectory-feedback-1440.png');
  // Lean's message sits under the line it is about, and its location in the output is a link to that line.
  const location = viewer(page).locator('.lean-location');
  assert.deepEqual(await location.allInnerTexts(), ['Submission.lean:4:44']);
  await location.click();
  const marks = viewer(page).locator('.trajectory-code-text .lean-marks');
  await marks.waitFor();
  assert.equal(await failed.locator('[data-trajectory-mode="code"]').getAttribute('aria-expanded'), 'true', 'the link opens the code');
  assert.equal(await marks.evaluate(item => item === document.activeElement), true, 'the link brings the line\'s message into focus');
  assert.deepEqual(await viewer(page).locator('.trajectory-code-text [data-marked]').evaluateAll(lines => lines.map(line => line.getAttribute('data-line'))), ['4']);
  assert.match(await marks.innerText(), /^第 4 行 · Lean 报错\nThe rfl tactic failed\.[\s\S]*\n⊢ 0 \+ n = n$/u);
  assert.deepEqual(await viewer(page).locator('[data-marks-line]').allInnerTexts(), ['第 4 行']);
  // Each number stays level with its line: the column has blank rows beside the message.
  const level = await viewer(page).locator('.trajectory-code').evaluate(box => {
    const numbers = box.querySelector<HTMLElement>('pre.trajectory-line-numbers')!, range = document.createRange(), rows: number[] = [];
    const walker = document.createTreeWalker(numbers, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) for (const found of (node.textContent ?? '').matchAll(/\d+/gu)) {
      range.setStart(node, found.index!); range.setEnd(node, found.index! + found[0].length);
      const rect = range.getBoundingClientRect(); rows[Number(found[0]) - 1] = rect.top + rect.height / 2;
    }
    return [...box.querySelectorAll('.trajectory-code-text .lean-line')].map((line, index) => {
      const rect = line.getClientRects()[0]!;
      return Math.abs(rect.top + rect.height / 2 - rows[index]!);
    });
  });
  assert.ok(level.length === 6 && level.every(distance => distance <= 1), `the numbers stay beside their lines: ${level.join(', ')}`);
  assert.deepEqual(await audit(page, { scope: '#detail-panel' }), [], 'Lean messages accessibility');
  await shot(page, 'trajectory-marks-1440.png');
  const second = step(page, '[data-kind="attempt"]').filter({ hasText: '第 2 次' });
  assert.equal(await second.count(), 1);
  await open(page, second, 'diff');
  await viewer(page).locator('.trajectory-diff').waitFor();
  const changed = await viewer(page).locator('.trajectory-diff tr.diff-removed, .trajectory-diff tr.diff-added')
    .evaluateAll(rows => rows.map(row => `${row.className} ${row.querySelector('[data-diff-text]')?.textContent}`));
  assert.ok(changed.some(row => row.startsWith('diff-removed') && row.includes('by rfl'))
    && changed.some(row => row.startsWith('diff-added') && row.includes('exact Nat.zero_add n')), changed.join('\n'));
  assert.equal(await page.locator('#detail-panel .trajectory-feedback').count(), 0, 'one panel is open at a time');
  assert.equal(await feedback.getAttribute('aria-expanded'), 'false');
  const modes = viewer(page).locator('[data-viewer-mode]');
  assert.deepEqual(await modes.evaluateAll(items => items.map(item => `${item.getAttribute('data-viewer-mode')}:${item.getAttribute('aria-pressed')}`)),
    ['code:false', 'diff:true'], 'a passed attempt has no Lean feedback to show, nor a failure to ask about');
  await modes.filter({ hasText: '看代码' }).click();
  await viewer(page).locator('.trajectory-code-text').waitFor();
  assert.match(await viewer(page).locator('.trajectory-code-text').innerText(), /exact Nat\.zero_add n/u);
  assert.equal(await viewer(page).locator('.lean-marks, [data-marks-summary]').count(), 0, 'a passed attempt\'s code has no messages under its lines');
  assert.equal(await second.locator('[data-trajectory-mode="code"]').getAttribute('aria-expanded'), 'true', 'the viewer\'s modes are the step\'s buttons');
  await modes.filter({ hasText: '对比上一版' }).click();
  await viewer(page).locator('.trajectory-diff').waitFor();
  assert.deepEqual(await audit(page, { scope: '#detail-panel' }), [], 'Finished trajectory accessibility');
  await shot(page, 'trajectory-diff-1440.png');
  mark('the failed attempt opens Lean\'s feedback beside the steps, its message under line 4 of its code, and the next attempt compares its code with the failed one');

  const overview = page.locator('#detail-panel .trajectory-overview');
  assert.deepEqual(await overview.locator('.trajectory-lane-name').allInnerTexts(), ['Lead', 'Engineer']);
  assert.equal(await overview.locator('.trajectory-block.failed').count(), 1, 'the failed attempt is a red block');
  const all = await steps(page).count();
  await overview.scrollIntoViewIfNeeded();
  const track = (await overview.locator('.trajectory-lane-track').first().boundingBox())!;
  await page.mouse.move(track.x + track.width * 0.3, track.y + track.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width * 0.7, track.y + track.height / 2, { steps: 5 });
  await page.mouse.up();
  const chip = page.locator('#detail-panel .trajectory-window');
  await chip.waitFor();
  assert.match(await chip.innerText(), /只看 \+\d\d:\d\d 到 \+\d\d:\d\d 之间的步骤/u);
  const within = await steps(page).count();
  assert.ok(within > 0 && within < all, `a stretch of time keeps only its steps: ${within} of ${all}`);
  await shot(page, 'trajectory-window-1440.png');
  await chip.getByRole('button', { name: '看全部' }).click();
  await chip.waitFor({ state: 'detached' });
  assert.equal(await steps(page).count(), all);
  await overview.locator('.trajectory-lanes').focus();
  await page.keyboard.press('ArrowRight');
  assert.match(await overview.locator('[aria-live]').innerText(), /^(Lead|Engineer)：.+，\+\d\d:\d\d 到 \+\d\d:\d\d$/u);
  await page.keyboard.press('Enter');
  await chip.waitFor();
  await page.keyboard.press('Escape');
  await chip.waitFor({ state: 'detached' });
  // The failed attempt sits in its folded run, which the block opens.
  await retries.locator('.trajectory-fold').first().click();
  await failed.waitFor({ state: 'detached' });
  await overview.locator('.trajectory-block.failed').click();
  assert.equal(await failed.evaluate(item => item === document.activeElement), true, 'a block opens its step, and the run of attempts it is in');
  mark('详细\'s time overview shows each Agent\'s work, a dragged or keyed stretch limits the steps, and a block opens its step');

  const attemptTasks = () => steps(page).evaluateAll(items => items.filter(item => ['attempt', 'retries'].includes(item.getAttribute('data-kind')!) && !item.closest('.trajectory-retries'))
    .map(item => `${item.querySelector('.trajectory-task')?.textContent}×${item.getAttribute('data-retries') ?? 1}`));
  await page.locator('#detail-panel .trajectory-filter select').selectOption({ label: 'zero_add' });
  assert.deepEqual(await attemptTasks(), ['zero_add×2']);
  await openTab(page, 'result');
  await openTab(page, 'trajectory');
  assert.equal(await page.locator('#detail-panel .trajectory-filter select option:checked').innerText(), 'zero_add');
  assert.deepEqual(await attemptTasks(), ['zero_add×2']);
  const idle = trajectoryReads(requests).length;
  await page.waitForTimeout(4_000);
  assert.equal(trajectoryReads(requests).length, idle, 'a finished run is not polled');
  mark('the task filter keeps only that task\'s attempts across tab switches, and a finished run is not polled');

  await open(page, step(page, '[data-kind="attempt"]').filter({ hasText: '第 2 次' }), 'diff');
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    await settled(page);
    assert.ok(await fits(page), `trajectory overflows at ${width}px`);
    assert.equal(await modal(page), true, `at ${width}px the viewer covers the screen`);
    const box = await viewer(page).boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.height >= 700, `the open comparison fits ${width}px: ${JSON.stringify(box)}`);
    await shot(page, `trajectory-${width}.png`);
  }
  await page.keyboard.press('Escape');
  await viewer(page).waitFor({ state: 'detached' });
  assert.equal(await focused(page), 'diff');
  // A finished run's code wraps on a phone: each line under its own number, nothing to scroll sideways, the text unchanged.
  await open(page, step(page, '[data-kind="attempt"]').filter({ hasText: '第 2 次' }), 'code');
  const wrapped = await viewer(page).locator('.trajectory-code.lean-wrap').evaluate(code => {
    const text = code.querySelector<HTMLElement>('.trajectory-code-text')!, lines = [...text.querySelectorAll<HTMLElement>('.lean-line')];
    return { sideways: code.scrollWidth - code.clientWidth, column: getComputedStyle(code.querySelector('.trajectory-line-numbers')!).display,
      numbered: getComputedStyle(lines[0]!, '::before').content, lines: lines.length, wraps: lines.some(line => line.getClientRects().length > 1),
      text: text.innerText.replace(/\n$/u, '').split('\n').length };
  });
  assert.ok(wrapped.sideways <= 0 && wrapped.column === 'none' && wrapped.numbered === 'counter(lean-line)' && wrapped.wraps && wrapped.text === wrapped.lines,
    `the code wraps at 320px under its own line numbers: ${JSON.stringify(wrapped)}`);
  await page.keyboard.press('Escape');
  await viewer(page).waitFor({ state: 'detached' });
  mark('the steps fit 375 and 320 pixel screens, where the comparison and the code open full screen, the code wraps under its line numbers, and Esc returns to its button');

  await page.setViewportSize({ width: 1440, height: 900 });
  await settled(page);
  await step(page, '[data-kind="attempt"]').filter({ hasText: '第 2 次' }).locator('[data-trajectory-continue]').click();
  await page.locator('#run-settings[open]').waitFor();
  assert.equal(await page.locator('#api-key').evaluate(field => field === document.activeElement), true, 'continuing asks for the key first');
  assert.equal(await page.locator('#draft-continuation').isHidden(), false);
  assert.equal(await page.locator('#draft-continuation-label').innerText(), '从「zero_add · 第 2 次」继续');
  assert.equal(await page.locator('#task').inputValue(), sample.run.task, 'the new draft is the same problem');
  await closeSettings(page);
  await shot(page, 'trajectory-continue-draft-1440.png');
  await page.setViewportSize({ width: 375, height: 812 });
  await settled(page);
  const attached = await page.locator('#draft-continuation').boundingBox();
  assert.ok(attached && attached.x >= 0 && attached.x + attached.width <= 376 && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    `the continuation chip fits 375px: ${JSON.stringify(attached)}`);
  await shot(page, 'trajectory-continue-draft-375.png');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);
  await page.locator('#api-key').fill(input.apiKey);
  await page.locator('#settings-submit').click();
  await page.locator('body[data-view="run"]').waitFor({ state: 'attached' });
  await showArtifacts(page);
  const note = page.locator('[data-run-continuation]');
  await note.waitFor();
  const continuedId = (await page.locator('.detail-heading').getAttribute('data-run'))!;
  await waitForRun({ page }, continuedId, run => run.status === 'completed');
  await page.locator(`.detail-heading[data-run="${continuedId}"]`).getByText('运行结束', { exact: true }).waitFor();
  assert.match(await note.innerText(), /从「zero_add · 第 2 次」继续/u);
  assert.equal(continued.length, 1);
  assert.equal(continued[0]!.continuation?.runId, run.id);
  assert.match(continued[0]!.continuation?.source ?? '', /exact Nat\.zero_add n/u, 'the worker receives the saved code of that version');
  assert.equal(await page.locator('#draft-continuation').isHidden(), true, 'one submission uses the continuation');
  assert.deepEqual(await audit(page, { scope: '#run-detail' }), [], 'Continued run accessibility');
  await shot(page, 'trajectory-continued-1440.png');
  await note.getByRole('button', { name: '看原运行' }).click();
  await page.locator(`.detail-heading[data-run="${run.id}"]`).waitFor({ state: 'attached' }); await showArtifacts(page);
  // The original lists what came of it: the later run, the version it started from, and its own status.
  const later = page.locator('#detail-panel [data-result-later]');
  await later.waitFor();
  assert.equal(await later.locator('h3').innerText(), '历次研究\n1');
  const row = later.locator('[data-action="open-continued"]');
  assert.equal(await row.getAttribute('data-run-id'), continuedId);
  assert.match(await row.innerText(), /^zero_add · 第 2 次\s+运行结束\s+\S/u);
  assert.deepEqual(await audit(page, { scope: '#detail-panel [data-result-later]' }), [], 'Later runs accessibility');
  await later.scrollIntoViewIfNeeded();
  await shot(page, 'trajectory-later-1440.png');
  // 对比代码 sets this run's code beside the later run's.
  const compare = later.locator('[data-action="compare-continued"]');
  assert.equal(await compare.getAttribute('aria-pressed'), 'false');
  await compare.click();
  const comparison = page.locator('#result-compare[open]');
  await comparison.waitFor();
  assert.equal(await compare.getAttribute('aria-pressed'), 'true');
  assert.equal(await comparison.locator('h4').innerText(), '比较研究');
  assert.match(await comparison.locator('.side-viewer-title>p').innerText(), /与「zero_add · 第 2 次」的研究记录对照/u);
  await comparison.locator('details > summary').filter({ hasText: '对比代码' }).click();
  assert.match((await comparison.locator('tr.diff-added').allInnerTexts()).join('\n'), /by simp/u, 'the later run\'s change is shown as added');
  assert.match((await comparison.locator('tr.diff-removed').allInnerTexts()).join('\n'), /exact Nat\.zero_add n/u);
  const folded = comparison.locator('[data-action="compare-folded"]');
  const wasFolded = await folded.isChecked();
  await folded.click();
  await page.waitForFunction(folded => document.querySelector<HTMLInputElement>('#result-compare [data-action="compare-folded"]')?.checked === folded, !wasFolded);
  assert.deepEqual(await audit(page, { scope: '#result-compare' }), [], 'Compare viewer accessibility');
  await shot(page, 'trajectory-compare-1440.png');
  await page.keyboard.press('Escape');
  await page.locator('#result-compare').waitFor({ state: 'detached' });
  assert.equal(await compare.evaluate(button => button === document.activeElement && button.getAttribute('aria-pressed') === 'false'), true,
    'closing the comparison returns to its button');
  mark('对比代码 on a later run sets the two runs\' code side by side, folds unchanged lines on request, and Esc returns to its button');
  await row.click();
  await page.locator(`.detail-heading[data-run="${continuedId}"]`).waitFor({ state: 'attached' }); await showArtifacts(page);
  assert.deepEqual(await page.locator('#detail-panel [data-result-later] [data-action="open-continued"]').evaluateAll(items =>
    items.map(item => (item as HTMLElement).dataset.runId)), [run.id], 'the continued research lists its original attempt without listing itself');
  await note.getByRole('button', { name: '看原运行' }).click();
  await page.locator(`.detail-heading[data-run="${run.id}"]`).waitFor({ state: 'attached' }); await showArtifacts(page);
  mark('从这一版继续 starts a new run on the same problem with that version\'s code for the worker, and both attempts list each other under 历次研究');

  await openTab(page, 'trajectory');
  const asking = step(page, '[data-kind="attempt"][data-tone="failed"]');
  await asking.waitFor();
  assert.deepEqual(await asking.locator('[data-trajectory-mode]').evaluateAll(items => items.map(item => item.getAttribute('data-trajectory-mode'))),
    ['code', 'feedback', 'ask'], 'a failed attempt of one\'s own run can be asked about');
  await open(page, asking, 'feedback');
  await viewer(page).locator('[data-trajectory-ask-hint]').click();
  const question = viewer(page).locator('[data-ask-question]');
  await question.waitFor();
  assert.equal(await question.evaluate(field => field === document.activeElement), true, 'the hint opens the question box');
  assert.equal(await viewer(page).locator('[data-viewer-mode="ask"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await asking.locator('[data-trajectory-mode="ask"]').getAttribute('aria-expanded'), 'true');
  assert.match(await viewer(page).locator('.trajectory-ask-cost').innerText(), /fixture-trajectory-model[\s\S]*按服务商计费，不计入运行预算/u, 'the cost is named before asking');
  assert.equal(await question.inputValue(), '这一步为什么没通过？应该怎么改？');
  await viewer(page).locator('[data-ask-submit]').click();
  assert.equal(await viewer(page).locator('.trajectory-error').innerText(), '请填写这个服务商的 API Key');
  assert.equal(explained.length, 0, 'nothing is sent without a key');
  assert.equal(await viewer(page).locator('[data-ask-key]').evaluate(field => field === document.activeElement), true);
  await viewer(page).locator('[data-ask-key]').fill(input.apiKey);
  await viewer(page).locator('[data-ask-submit]').click();
  await viewer(page).locator('.trajectory-ask-thread .trajectory-loading').waitFor();
  assert.equal(await viewer(page).locator('[data-ask-submit]').innerText(), '停止');
  for (let tries = 0; !explained.length && tries < 50; tries++) await page.waitForTimeout(100);
  assert.equal(explained[0]!.authorization, `Bearer ${input.apiKey}`);
  assert.equal(explained[0]!.body.model, input.model, 'the run\'s own model answers');
  const given = explained[0]!.body.input[0]!.content[0]!.text;
  assert.ok(given.includes('by rfl') && given.includes('The rfl tactic failed') && given.includes('Question: 这一步为什么没通过？应该怎么改？'), given);
  assert.equal(await question.inputValue(), '', 'the question moves into the thread while it is answered');
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await shot(page, 'trajectory-ask-pending-1440.png');
  answerNext();
  const answer = viewer(page).locator('.trajectory-ask-answer');
  await answer.waitFor();
  assert.match(await answer.locator('p').first().innerText(), /^原因：rfl 只在两边/u, 'bold and code spans are kept, without their marks');
  assert.match(await answer.locator('.trajectory-ask-code').innerText(), /exact Nat\.zero_add n/u);
  assert.equal(await answer.locator('.trajectory-ask-code .lean-keyword').count() > 0, true, 'code in an answer is coloured like the code viewer');
  assert.match(await viewer(page).locator('.trajectory-ask-turn .trajectory-note').innerText(), /约 1320 Token · 这是解释，没有经过 Lean 检查/u);
  assert.equal(await question.inputValue(), '', 'the box empties for a follow-up');
  assert.deepEqual(await audit(page, { scope: '#detail-panel' }), [], 'Ask panel accessibility');
  await viewer(page).locator('[data-ask-submit]').scrollIntoViewIfNeeded();
  await shot(page, 'trajectory-ask-1440.png');
  await question.fill('为什么 simp 也可以？');
  await question.press('Control+Enter');
  for (let tries = 0; explained.length < 2 && tries < 50; tries++) await page.waitForTimeout(100);
  assert.deepEqual(explained[1]!.body.input.map(item => item.role), ['user', 'assistant', 'user'], 'a follow-up carries the earlier answer');
  assert.equal(explained[1]!.authorization, `Bearer ${input.apiKey}`, 'the typed key serves the follow-up');
  answerNext();
  await viewer(page).locator('.trajectory-ask-turn').nth(1).locator('.trajectory-ask-answer').waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  await settled(page);
  assert.equal(await modal(page), true);
  const askBox = await viewer(page).boundingBox();
  assert.ok(askBox && askBox.x >= 0 && askBox.x + askBox.width <= 376 && await viewer(page).locator('.side-viewer-body').evaluate(body => body.scrollWidth <= body.clientWidth + 1),
    `the ask panel fits 375px: ${JSON.stringify(askBox)}`);
  await viewer(page).locator('[data-ask-question]').scrollIntoViewIfNeeded();
  await shot(page, 'trajectory-ask-375.png');
  await question.fill('那 omega 呢？');
  await viewer(page).locator('[data-ask-submit]').click();
  for (let tries = 0; explained.length < 3 && tries < 50; tries++) await page.waitForTimeout(100);
  assert.equal(explained.length, 3);
  await viewer(page).locator('[data-ask-submit]').click();
  for (let tries = 0; !dropped && tries < 50; tries++) await page.waitForTimeout(100);
  assert.equal(dropped, 1, 'stopping closes the call to the provider');
  await viewer(page).locator('[data-ask-submit]').filter({ hasText: '提问' }).waitFor();
  assert.equal(await question.inputValue(), '那 omega 呢？', 'a stopped question comes back to the box');
  assert.equal(await viewer(page).locator('.trajectory-error').count(), 0, 'stopping is not an error');
  assert.equal(await viewer(page).locator('.trajectory-ask-turn').count(), 2);
  await viewer(page).locator('[data-ask-submit]').click();
  for (let tries = 0; explained.length < 4 && tries < 50; tries++) await page.waitForTimeout(100);
  assert.equal(explained.length, 4, 'the stopped question no longer holds the account\'s slot');
  answerNext();
  await viewer(page).locator('.trajectory-ask-turn').nth(2).locator('.trajectory-ask-answer').waitFor();
  await page.keyboard.press('Escape');
  await viewer(page).waitFor({ state: 'detached' });
  mark('问为什么 asks the run\'s own model about a failed attempt, with the cost named first, the key asked once, follow-ups carrying the thread and 停止 giving the question back');
  assert.deepEqual(errors, []);
  console.log('Trajectory checks passed: sample, detail level, live following and line guidance, feedback, comparison, time overview, filter, polling, narrow layout, continuing from a version and asking why a step failed.');
} finally {
  for (const held of gates.values()) held.release();
  await browser?.close();
  await service.close();
  provider.closeAllConnections(); provider.close();
}
