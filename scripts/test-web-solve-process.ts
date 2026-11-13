#!/usr/bin/env bun
import { clickWorkbenchAction, openAdvancedChatSettings, openChatParticipation, openChatResultDetails } from './web-ui-controls';
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
const output = globalThis.process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-solve-process');
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
  const until = Date.now() + 15_000;
  while (!check()) { assert.ok(Date.now() < until, _description); await sleep(40); }
}
async function credentials(page: Page) {
  await openChatParticipation(page);
  await page.locator('input[name="chat-participation"][value="automatic"]').check();
  if (!await page.locator('#formalize-key').isVisible()) await clickWorkbenchAction(page, '#open-settings');
  await page.locator('#formalize-key').fill('sk-disposable-browser-fixture');
  await openAdvancedChatSettings(page);
  if (await page.locator('#formalize-environment').isEnabled()) await page.locator('#formalize-environment').selectOption('standard');
  await page.locator('#formalize-start:enabled').waitFor();
}
const process = (page: Page) => page.locator('[data-solve-process]');
const live = (page: Page) => page.locator('#chat-live-panel');
const artifact = (page: Page) => page.evaluate(() => document.body.dataset.chatArtifact ?? '');

let browser: Browser | undefined, activePage: Page | undefined, failure: unknown;
try {
  browser = await startBrowser(service.server, port);
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(30_000);
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    const page = activePage = await context.newPage();
    const writes: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    pending = undefined; runInput = undefined; releaseRun = undefined;
    await page.goto(origin); await page.locator('#formalize-original').waitFor();
    await page.locator('#formalize-original').fill(original); await credentials(page);
    await page.locator('#formalize-start').click();
    await eventually(() => Boolean(pending), 'The formalization starts');
    await page.locator('.research-conversation-status').waitFor();
    await page.locator('.chat-messages[data-conversation]').waitFor();
    assert.equal(await page.locator('[data-chat-mathematics], [data-chat-math-summary]').count(), 0,
      'a formalization without mathematical records has no empty progress section');
    const formalization = pending!;
    formalization.send({ type: 'progress', progress: { phase: 'compiling', round: 1, tokens: 1200 } });
    // Rounds the host recorded: a plan, a statement, a Lean compilation that failed, its feedback, a second try.
    formalization.send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'role', workerId: 'r1-plan-1', role: 'plan', slot: 'plan-1', state: 'finished',
      summary: { taskKind: 'prove', sections: [{ kind: 'conclusions', items: [original] }] } } } });
    formalization.send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'compile', state: 'started', source: statement } } });
    formalization.send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'compile', state: 'failed', source: statement, lean: lean(false, 2) } } });
    formalization.send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'revision', stage: 'round', text: 'Lean 报错：第 2 行 unknown tactic。' } } });
    await page.locator('[data-chat-math-finding]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('[data-chat-math-summary]').count(), 0, 'the original task is not repeated as a new mathematical update');
    assert.equal(await page.locator('[data-chat-result-more]').getAttribute('open'), null, 'Detailed progress starts behind one disclosure');
    await openChatResultDetails(page);
    assert.ok((await page.locator('[data-chat-math-finding]').innerText()).includes(original),
      'opening the details retains the original recorded statement');
    await process(page).waitFor();
    await page.locator('.solve-process-title').filter({ hasText: '解题过程' }).waitFor();
    // 简洁, the default reading, keeps the diagnostic records to one line while the task runs.
    assert.equal(await process(page).getAttribute('open'), null, 'The recorded diagnostic process starts folded');
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
      width === 1440, { timeout: 15_000 });
    await page.locator('.research-conversation-meta').waitFor();
    assert.match(await page.locator('.research-conversation-meta').innerText(), /\d\d:\d\d/u);
    assert.match(await page.locator('.research-conversation-meta').innerText(), /Token 1200/u);
    assert.equal(await page.locator('[data-research-stop]').isVisible(), true);
    const runningDetails = page.locator('[data-chat-result-more]'), status = page.locator('.research-conversation-status');
    await runningDetails.locator(':scope > summary').click();
    assert.equal(await runningDetails.getAttribute('open'), null);
    assert.equal(await status.locator('.research-conversation-meta, [data-research-artifact="live"]').count(), 0,
      'Simple status leaves timing, token use and the live workspace in the details');
    assert.doesNotMatch(await status.innerText(), /\d\d:\d\d|Token 1200|实时工作区/u);
    assert.equal(await page.locator('.research-conversation-meta').isVisible(), false);
    assert.equal(await page.locator('[data-research-artifact="live"]').isVisible(), false);
    assert.equal(await status.locator('.chat-task-status-line [data-research-stop]').isVisible(), true,
      'Stopping remains available beside the running status with details closed');
    await page.screenshot({ path: path.join(output, `running-status-${width}.png`), fullPage: true });
    await openChatResultDetails(page);
    assert.equal(await page.locator('.research-conversation-meta').count(), 1, 'Elapsed time and token use have one place');
    assert.equal(await runningDetails.locator('.research-conversation-meta').isVisible(), true);
    assert.match(await runningDetails.locator('.research-conversation-meta').innerText(), /\d\d:\d\d[\s\S]*Token 1200/u);
    assert.equal(await page.locator('[data-research-artifact="live"]').count(), 1, 'The live workspace has one entry');
    assert.equal(await runningDetails.locator('[data-research-artifact="live"]').isVisible(), true);
    // The run's own Lean check arrives with its action, a moment after the run starts.
    await page.waitForFunction(() => /自查|Lean 检查/u.test(document.querySelector('.solve-stage[data-stage="prove"]')?.textContent ?? ''),
      undefined, { timeout: 15_000 });
    assert.match(await page.locator('.solve-stage[data-stage="prove"]').innerText(), /自查|Lean 检查/u);
    mark(`${width}px: the running proof shows its elapsed time, tokens, stop and its Agent's Lean check`);
    if (width === 1440) {
      assert.notEqual(await artifact(page), 'live', 'Simple reading keeps the conversation on one surface while the proof runs');
      assert.equal(await live(page).isVisible(), false);
      await page.locator('[data-research-artifact="live"]').click();
      await page.waitForFunction(() => document.body.dataset.chatArtifact === 'live');
      assert.equal(await live(page).isVisible(), true);
      await live(page).locator('.live-code .lean-line').first().waitFor();
      assert.match(await live(page).locator('.live-file-head').innerText(), /Submission\.lean/u);
      // The check list stays folded to one line under the code until the reader opens it.
      assert.equal(await live(page).locator('details.live-checks').getAttribute('open'), null, 'The check list starts folded');
      await live(page).locator('details.live-checks > summary').click();
      assert.ok(await live(page).locator('[data-live-check]').count() > 0);
      assert.equal(await live(page).locator('.live-check[aria-current=true]').count(), 1, 'It follows the latest check');
      // The Agent's own check kept the file it read; picking it puts Lean's error under the line it names.
      const own = live(page).locator('[data-live-check]').filter({ hasText: '自查' }).filter({ hasText: '第 2 行出错' });
      await own.waitFor();
      await own.click();
      assert.equal(await live(page).locator('.live-check[aria-current=true]').count(), 1, 'A picked check stays current');
      assert.match(await live(page).locator('.live-code .lean-marks').innerText(), /第 2 行/u);
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
    if (await page.locator('#close-research-output').isVisible()) await page.locator('#close-research-output').click();
    await page.locator('[data-chat-result-more] > summary').click();
    releaseRun!();
    await page.waitForFunction(() => document.querySelector('.research-conversation-status')?.getAttribute('data-accepted') === 'true');
    await page.waitForFunction(() => document.querySelector('details.solve-process')?.hasAttribute('open') === false);
    assert.equal(await process(page).getAttribute('open'), null, 'A finished task folds its checklist to one line');
    assert.equal(await page.locator('[data-research-stop]').count(), 0, 'A finished task has no stop button');
    assert.equal(await live(page).isVisible(), false, 'Finishing does not reopen the workspace after the reader closed it');
    assert.equal(await page.locator('#run-detail').isVisible(), false, 'The result stays in the conversation until requested');
    const result = page.locator('[data-chat-result-more]');
    assert.equal(await result.getAttribute('open'), null);
    assert.equal(await status.locator('.research-conversation-state strong').innerText(), 'Lean 陈述证明通过');
    assert.equal(await status.locator('[data-statement-verdict]').innerText(),
      '原题含义：请查看形式化记录。 Lean 验收证明的是这份陈述，不能替代对自然语言原意的核对。');
    assert.equal(await status.locator('.research-conversation-description').count(), 0,
      'An accepted simple status keeps its title and original-meaning note without repeating the technical description');
    const acceptedDescription = result.locator('.research-conversation-description');
    assert.equal(await acceptedDescription.count(), 1);
    assert.equal(await acceptedDescription.textContent(), '冻结的 Lean 陈述已通过独立验收。');
    assert.equal(await acceptedDescription.isVisible(), false, 'The acceptance description stays behind the closed details');
    await page.screenshot({ path: path.join(output, `accepted-status-${width}.png`), fullPage: true });
    const savedWorkspace = page.locator('[data-research-artifact="live"]');
    assert.equal(await savedWorkspace.isVisible(), false, 'An ended task keeps its saved workspace behind the result details');
    await openChatResultDetails(page);
    assert.equal(await acceptedDescription.isVisible(), true, 'Opening proof details recovers the complete acceptance description');
    assert.equal(await page.locator('.research-conversation-meta').count(), 1);
    assert.equal(await result.locator('.research-conversation-meta').isVisible(), true);
    assert.equal(await savedWorkspace.isVisible(), true);
    const previousWrites = [...writes];
    await savedWorkspace.click();
    await live(page).waitFor();
    await live(page).locator('.live-code .lean-line').first().waitFor();
    assert.match(await live(page).locator('.live-code').innerText(), /theorem addition/u);
    await page.locator('#close-research-output').click();
    await page.waitForFunction(() => document.body.dataset.chatArtifact !== 'live');
    assert.equal(await live(page).isVisible(), false);
    assert.deepEqual(writes, previousWrites, 'Opening and closing the saved workspace only reads the retained records');
    assert.match(await process(page).locator('summary').innerText(), /Lean 检查 \d+ 次|尝试 \d+ 次/u);
    await process(page).locator(':scope > summary').click();
    await page.locator('.solve-stage[data-stage="verify"]').waitFor();
    assert.match(await page.locator('.solve-stage[data-stage="verify"]').innerText(), /独立验收|验收通过/u);
    await page.locator('[data-research-artifact="result"]').click(); await page.locator('.result-verdict').waitFor();
    await page.screenshot({ path: path.join(output, `finished-${width}.png`), fullPage: true });
    mark(`${width}px: the finished task folds to one line and keeps its record`);
    await page.context().close();
    activePage = undefined;
  }
  assert.deepEqual(errors, []);
  console.log(`PASS solve process: ${checks.length} checks`);
} catch (error) {
  failure = error;
  await activePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  for (const test of checks) console.log(`passed: ${test}`);
  console.error(error);
  globalThis.process.exitCode = 1;
} finally {
  await browser?.close();
  await service.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, errors,
    paidModelCalls: false, realLeanProcesses: 0,
    ...(failure ? { error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2) + '\n');
}
