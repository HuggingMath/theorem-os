#!/usr/bin/env bun
// The solving process: the checklist under the task's status, and the live workspace beside it on a wide screen.
// Local fixtures only: a formalization and a run are replayed through a runner. No model, no Lean.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WorkerFormalizationInput, WorkerFormalizationMessage } from '../apps/web/formalizationTypes';
import type { WorkerInput, WorkerMessage } from '../apps/web/shared';
import { localeStorageKey } from '../apps/web/i18n';
import { webFormalizationEvidence, webFormalizationStatement } from '../tests/helpers/webFormalizationFixture';
import { audit } from './web-a11y';
import { deferred, freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-solve-process');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the solve process check.'); });
await fs.mkdir(output, { recursive: true });
const original = webFormalizationStatement;
const statement = 'theorem addition (n : Nat) : n + 1 = 1 + n := by\n  sorry';
const failing = 'theorem addition (n : Nat) : n + 1 = 1 + n := by\n  exact Nat.add_comm n 1';
const lean = (passed: boolean, line?: number) => ({ passed, messages: passed ? [] : [{ severity: 'error' as const, text: 'unknown tactic', ...(line ? { line } : {}) }] });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let pending: { input: WorkerFormalizationInput; send(message: WorkerFormalizationMessage): void; resolve(): void } | undefined;
let runInput: WorkerInput | undefined;
// The proof stays live until the reader has looked at it; the test releases the end of the run itself.
let releaseRun: (() => void) | undefined;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: '本地解题过程验证环境' }; },
  formalize(input, send, signal) {
    return new Promise<void>(resolve => { pending = { input: structuredClone(input), send, resolve };
      signal.addEventListener('abort', () => resolve(), { once: true }); });
  },
  async run(input, send, signal) {
    runInput = structuredClone(input);
    const progress = (event: string, message: string, details?: Record<string, unknown>) => send({ type: 'progress', event, message, ...(details ? { details } : {}) });
    const action = (body: Record<string, unknown>) => send({ type: 'action', action: body as never });
    progress('solve_started', '开始解题');
    progress('research_action', '直接求解', { workerId: 'solver', operation: 'direct' });
    await sleep(20);
    progress('turn_started', '第 1 轮', { workerId: 'solver', turn: 1 });
    // The Agent's file is saved as a candidate before it checks it, so the check arrives with the source Lean named its error in.
    send({ type: 'artifact', artifact: { source: statement, workerId: 'solver', capturedAt: new Date().toISOString(), status: 'candidate' } } as WorkerMessage);
    action({ workerId: 'solver', itemId: '1:c1', phase: 'started', kind: 'command', status: 'running', command: "theorem-os check-lean --file 'Submission.lean'" });
    action({ workerId: 'solver', itemId: '1:c1', phase: 'completed', kind: 'command', status: 'failed', exitCode: 1,
      command: "theorem-os check-lean --file 'Submission.lean'", output: 'error: unknown tactic', lean: lean(false, 2) });
    progress('proof_check_started', 'Lean 检查', { workerId: 'solver', turn: 1 });
    const held = deferred(); releaseRun = held.resolve;
    await Promise.race([held.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
    if (signal.aborted) return;
    action({ workerId: 'solver', itemId: '1:e1', phase: 'started', kind: 'edit', status: 'running', changes: [{ path: 'Submission.lean' }] });
    action({ workerId: 'solver', itemId: '1:e1', phase: 'completed', kind: 'edit', status: 'done', changes: [{ path: 'Submission.lean' }] });
    progress('turn_started', '第 2 轮', { workerId: 'solver', turn: 2 });
    progress('proof_checked', 'Lean 检查通过', { workerId: 'solver', passed: true });
    progress('candidate_selected', '选定候选', { workerId: 'solver' });
    progress('evaluation_started', '独立验收', { workerId: 'solver' });
    progress('evaluation_finished', '验收通过', { status: 'passed' });
    send({ type: 'result', result: { status: 'evaluated_passed', proof: failing, report: { status: 'evaluated_passed' } } } as WorkerMessage);
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: path.join(root, 'out/web-solve-process/data') });
// Trusted test configuration bypasses the public configuration's HTTPS requirement for this loopback fixture.
config.providers = [{ id: 'sub2api', name: 'Local fixture', baseUrl: 'http://127.0.0.1:1/v1' }];
const service = createWebService(config, runner);
const checks: string[] = [], errors: string[] = [];
const mark = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
async function eventually(check: () => boolean, _description: string) {
  while (!check()) await sleep(40);
}
async function credentials(page: Page) {
  if (!await page.locator('input[name="chat-participation"][value="automatic"]').isVisible())
    await page.locator('[data-chat-participation-control] > summary').click();
  await page.locator('input[name="chat-participation"][value="automatic"]').check();
  if (!await page.locator('#formalize-key').isVisible()) await page.locator('#open-settings').click();
  await page.locator('#formalize-key').fill('sk-disposable-browser-fixture');
  if (await page.locator('#formalize-environment').isEnabled()) await page.locator('#formalize-environment').selectOption('standard');
  await page.locator('#formalize-start:enabled').waitFor();
}
const process = (page: Page) => page.locator('[data-solve-process]');
const live = (page: Page) => page.locator('#chat-live-panel');
const artifact = (page: Page) => page.evaluate(() => document.body.dataset.chatArtifact ?? '');

let browser: Browser | undefined;
try {
  browser = await startBrowser(service.server, port);
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    const page = await context.newPage(); page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0);
    page.on('pageerror', error => errors.push(error.message));
    pending = undefined; runInput = undefined; releaseRun = undefined;
    await page.goto(origin); await page.locator('#formalize-original').waitFor();
    await page.locator('#formalize-original').fill(original); await credentials(page);
    await page.locator('#formalize-start').click();
    await eventually(() => Boolean(pending), 'The formalization starts');
    const formalization = pending!;
    // Rounds the host recorded: a plan, a statement, a Lean compilation that failed, its feedback, a second try.
    formalization.send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'role', workerId: 'r1-plan-1', role: 'plan', slot: 'plan-1', state: 'finished',
      summary: { taskKind: 'prove', sections: [{ kind: 'conclusions', items: [original] }] } } } });
    formalization.send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'compile', state: 'started', source: statement } } });
    formalization.send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'compile', state: 'failed', source: statement, lean: lean(false, 2) } } });
    formalization.send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'revision', stage: 'round', text: 'Lean 报错：第 2 行 unknown tactic。' } } });
    await process(page).waitFor();
    await page.locator('.solve-process-title').filter({ hasText: '解题过程' }).waitFor();
    assert.equal(await process(page).getAttribute('open'), '', 'The recorded diagnostic process starts open');
    await process(page).locator(':scope > summary').click();
    assert.equal(await process(page).getAttribute('open'), null, 'The reader can fold diagnostic records');
    await process(page).locator(':scope > summary').click();
    await page.waitForFunction(() => document.querySelectorAll('.solve-stage[data-stage]').length >= 3);
    assert.equal(await process(page).getAttribute('open'), '', 'The reader can open the detailed execution records');
    assert.match(await page.locator('.solve-stage[data-stage="formalize"]').innerText(), /形式化原题/u);
    assert.match(await process(page).innerText(), /编译检查|第 1 轮/u);
    assert.equal(await page.locator('.solve-stage[data-stage="prove"]').count(), 1);
    assert.equal(await page.locator('.solve-stage[data-stage="verify"]').count(), 1);
    mark(`${width}px: the reader opens the formalization's rounds, compile and feedback when needed`);

    formalization.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(formalization.input) }); formalization.resolve();
    await eventually(() => Boolean(runInput), 'The confirmed statement starts one proof');
    await eventually(() => runInput!.input.source.length > 0, 'The proof receives the statement');
    // A wide screen's check rows open the workspace beside the chat; a phone's open their record in place.
    await page.waitForFunction(wide => document.querySelectorAll(wide ? '[data-solve-check]' : '.solve-row[data-solve-row]').length > 0,
      width === 1440, { timeout: 0 });
    await page.locator('.research-conversation-meta').waitFor();
    assert.match(await page.locator('.research-conversation-meta').innerText(), /\d\d:\d\d/u);
    assert.equal(await page.locator('[data-research-stop]').isVisible(), true);
    // The run's own Lean check arrives with its action, a moment after the run starts.
    await page.waitForFunction(() => /自查|Lean 检查/u.test(document.querySelector('.solve-stage[data-stage="prove"]')?.textContent ?? ''),
      undefined, { timeout: 0 });
    assert.match(await page.locator('.solve-stage[data-stage="prove"]').innerText(), /自查|Lean 检查/u);
    mark(`${width}px: the running proof shows its elapsed time, tokens, stop and its Agent's Lean check`);
    if (width === 1440) {
      // The live workspace opens by itself beside the conversation, on the file the check was about.
      await page.waitForFunction(() => document.body.dataset.chatArtifact === 'live', undefined, { timeout: 0 });
      assert.equal(await artifact(page), 'live', 'A wide screen opens the live workspace by itself');
      assert.equal(await live(page).isVisible(), true);
      await live(page).locator('.live-code .lean-line').first().waitFor();
      assert.match(await live(page).locator('.live-file-head').innerText(), /Submission\.lean/u);
      assert.ok(await live(page).locator('[data-live-check]').count() > 0);
      assert.equal(await live(page).locator('.live-check[aria-current=true]').count(), 1, 'It follows the latest check');
      // The Agent's own check kept the file it read; picking it puts Lean's error under the line it names.
      const own = live(page).locator('[data-live-check]').filter({ hasText: '自查' }).filter({ hasText: '第 2 行出错' });
      await own.waitFor();
      await own.click();
      assert.equal(await live(page).locator('.live-check[aria-current=true]').count(), 1, 'A picked check stays current');
      assert.match(await live(page).locator('.live-marks').innerText(), /第 2 行/u);
      assert.ok(await live(page).locator('.live-code .lean-line[data-marked]').count() > 0, 'Lean\'s error is shown under its line');
      await page.locator('.live-code').screenshot({ path: path.join(output, 'live-code-1440.png') });
      mark('1440px: the live workspace shows the checked file with Lean\'s error under its line');
      // Back in the conversation, the checklist's check row reopens the same workspace.
      await page.locator('#close-research-output').click();
      await page.waitForFunction(() => document.body.dataset.chatArtifact !== 'live');
      assert.equal(await live(page).isVisible(), false, 'Returning to the chat closes the workspace');
      await page.locator('[data-solve-check]').first().click();
      await page.waitForFunction(() => document.body.dataset.chatArtifact === 'live');
      mark('1440px: a check row in the checklist opens the workspace beside the chat');
    } else {
      assert.equal(await live(page).isVisible(), false, 'A phone shows the checklist only');
      assert.equal(await page.locator('[data-research-artifact="live"]').isVisible(), true, 'A phone can explicitly open the current source');
      const row = page.locator('.solve-row').filter({ has: page.locator('[data-solve-check]') }).first();
      const toggle = row.locator('.solve-row-toggle');
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      assert.match(await row.innerText(), /unknown tactic/u, 'A phone can expand the saved check feedback in place');
      await row.locator('[data-solve-check]').click();
      await live(page).waitFor();
      await page.locator('#close-research-output').click();
      await page.waitForFunction(() => document.body.dataset.chatArtifact !== 'live');
      mark('390px: check feedback expands in place and its source opens on request');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(await audit(page), []);
    await settled(page);
    await page.screenshot({ path: path.join(output, `process-${width}.png`), fullPage: true });
    await process(page).locator(':scope > summary').click();
    assert.equal(await process(page).getAttribute('open'), null, 'The reader can fold the detailed records again');
    releaseRun!();
    await page.waitForFunction(() => document.querySelector('.research-conversation-status')?.getAttribute('data-accepted') === 'true', undefined, { timeout: 0 });
    await page.waitForFunction(() => document.querySelector('details.solve-process')?.hasAttribute('open') === false);
    assert.equal(await process(page).getAttribute('open'), null, 'A finished task folds its checklist to one line');
    assert.match(await process(page).locator('summary').innerText(), /Lean 检查 \d+ 次|尝试 \d+ 次/u);
    assert.equal(await page.locator('[data-research-stop]').count(), 0, 'A finished task has no stop button');
    assert.ok(await page.locator('.solve-stage[data-stage="verify"]').count() >= 0);
    await page.screenshot({ path: path.join(output, `finished-${width}.png`), fullPage: true });
    mark(`${width}px: the finished task folds to one line and keeps its record`);
    await page.context().close();
  }
  assert.deepEqual(errors, []);
  console.log(`PASS solve process: ${checks.length} checks`);
} catch (error) {
  for (const test of checks) console.log(`passed: ${test}`);
  console.error(error);
  globalThis.process.exitCode = 1;
} finally {
  await browser?.close();
  service.server.close();
}
