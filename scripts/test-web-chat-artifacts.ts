#!/usr/bin/env bun
// Live UI with a recorded mathematics task and local provider/command fixtures; no real model or Lean execution.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { loadWebSample } from '../apps/web/sample';
import type { WebRunner } from '../apps/web/runner';
import type { WebGuidanceInput, WebGuidanceRecord, WebObservation } from '../apps/web/collaboration';
import type { WebRunInput, WorkerMessage } from '../apps/web/shared';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, postRun, startBrowser } from './web-scenario';
import { withFailedAttempt } from './web-trajectory-fixture';
import { audit } from './web-a11y';

declare const Bun: { serve(options: { hostname: string; port: number; idleTimeout?: number; fetch(request: Request): Response | Promise<Response> }): { port: number; stop(force?: boolean): void } };

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/web-chat-artifacts');
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-chat-artifacts-'));
const sample = withFailedAttempt(loadWebSample()!);
type Control = { observation: WebObservation; send(message: WorkerMessage): void; emit(): void; finish(): void };
const controls = new Map<string, Control>();
const commands: { runId: string; input: WebGuidanceInput }[] = [];
let loseNextCommandReceipt = false;
const reply = ['下面讨论 Tutorial.zero_add 的证明。', '',
  ...Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 段：已记录的目标是自然数左侧加零不变，可以查看这个目标的路线图与检查记录。`), '',
  '相关任务：Tutorial.zero_add。'].join('\n\n');
const providerCalls: unknown[] = [];
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  providerCalls.push(await request.json());
  return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: reply }] }] });
} });
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local recorded task fixture' }; },
  run(input, send, signal) {
    assert.equal(input.input.source, sample.run.source.trim(), 'Recorded task evidence belongs to the source used by this test');
    return new Promise<void>(resolve => {
      const observation = { ...structuredClone(sample.observations[3]!), webRunId: input.id };
      const control: Control = { observation, send, finish: resolve, emit() {
        this.observation.sequence++; this.observation.observedAt = new Date().toISOString();
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      controls.set(input.id, control);
      send({ type: 'progress', event: 'solve_started', message: '回放已记录的证明任务' });
      for (const recorded of sample.observations.slice(0, 4))
        send({ type: 'observation', observation: { ...structuredClone(recorded), webRunId: input.id } });
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  async command(runId, command) {
    const control = controls.get(runId)!;
    if (command.type === 'capture') return { id: 'capture', status: 'captured', observation: control.observation };
    assert.equal(command.type, 'guidance', 'This fixture only accepts proof requirements');
    if (command.type !== 'guidance') throw new Error('Unexpected fixture command');
    commands.push({ runId, input: structuredClone(command.guidance) });
    const at = new Date().toISOString();
    const guidance: WebGuidanceRecord = { ...command.guidance, status: 'queued', createdAt: at, updatedAt: at };
    control.observation.guidance.push(guidance);
    if (loseNextCommandReceipt) {
      loseNextCommandReceipt = false;
      throw new Error('Local fixture lost the acknowledgement after accepting the proof requirement');
    }
    control.emit();
    return { id: guidance.id, status: 'queued', guidance, observation: control.observation };
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: path.join(temporary, 'data') });
config.providers = [{ id: 'sub2api', name: 'Local fixture', baseUrl: `http://127.0.0.1:${provider.port}/v1` }];
const service = createWebService(config, runner, { sample: null });
const input: WebRunInput = { providerId: 'sub2api', apiKey: 'sk-local-chat-artifact-fixture', model: 'fixture',
  effort: 'low', environment: sample.run.environment, source: sample.run.source, task: 'Inspect recorded chat artifacts and requirements',
  maxTurns: 10, maxRunSeconds: 300, workers: 3, coordination: 'cooperative' };
let browser: Browser | undefined, page: Page | undefined;
const errors: string[] = [], checks: string[] = [];
const mark = (value: string) => { checks.push(value); console.log(`PASS ${value}`); };
try {
  browser = await startBrowser(service.server, port);
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(key => localStorage.setItem(key, 'zh'), localeStorageKey);
    page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    const writes: string[] = [];
    page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname); });
    await page.goto(origin); await page.locator('#formalize-original').waitFor();
    const run = await postRun({ page }, input);
    await page.goto(`${origin}/?run=${run.id}`); await page.waitForURL(url => url.searchParams.has('chat'));
    const chatId = new URL(page.url()).searchParams.get('chat')!;
    await page.locator('#formalize-original').fill('请讨论 Tutorial.zero_add 的具体证明任务。');
    await page.locator('#open-settings').click(); await page.locator('#formalize-key').fill('sk-local-chat-artifact-fixture');
    await page.locator('#formalize-start:enabled').click();
    const taskLink = page.locator('.chat-message-assistant [data-chat-task-link="goal_2"]');
    await taskLink.waitFor();
    await page.locator('#formalize-original').fill('查看路线图后继续提问的草稿');
    await taskLink.scrollIntoViewIfNeeded();
    const before = await taskLink.evaluate(link => {
      const message = link.closest<HTMLElement>('[data-message-id]')!, thread = document.querySelector('#research-chat-thread')!;
      return { id: message.dataset.messageId!, offset: message.getBoundingClientRect().top - thread.getBoundingClientRect().top };
    });
    await taskLink.click();
    await page.locator('#detail-panel[data-tab="trajectory"]').waitFor();
    const node = page.locator('[data-roadmap-node="task:goal_2"]');
    await page.locator('[data-roadmap-node="task:goal_2"][aria-pressed="true"]').waitFor();
    assert.match(await node.innerText(), /Tutorial\.zero_add/u);
    assert.match(await page.locator('.roadmap-detail-summary').innerText(), /0 \+ n = n/u);
    assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false',
      'Recorded partial task checks never mark an active run accepted');
    await page.screenshot({ path: path.join(output, `task-goal2-${width}.png`), fullPage: true });
    await page.locator('[data-action="show-task-source"][data-task-id="goal_2"]').click();
    const taskSource = page.locator('[data-task-source-code]'); await taskSource.waitFor();
    await page.waitForFunction(() => {
      const source = document.querySelector('[data-task-source-code]');
      if (!source) return false;
      const bounds = source.getBoundingClientRect();
      let top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
      for (let parent = source.parentElement; parent; parent = parent.parentElement) {
        if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue;
        const clip = parent.getBoundingClientRect();
        top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
      }
      return bottom - top >= Math.min(80, bounds.height);
    });
    const recordedSource = await taskSource.innerText();
    assert.ok(controls.get(run.id)!.observation.sources.some(source => source.taskId === 'goal_2' && source.source === recordedSource),
      'The task source is an exact recorded snapshot for the linked theorem');
    assert.match(recordedSource, /theorem zero_add/u);
    assert.match(await page.locator('[data-task-source-identities]').innerText(), /goal_2/u);
    await page.screenshot({ path: path.join(output, `task-source-${width}.png`) });
    await page.locator('#close-research-output').click();
    await page.waitForFunction(({ id, offset }) => {
      const message = document.querySelector(`[data-message-id="${id}"]`)!, thread = document.querySelector('#research-chat-thread')!;
      return Math.abs(message.getBoundingClientRect().top - thread.getBoundingClientRect().top - offset) < 5;
    }, before);
    assert.equal(await taskLink.evaluate(link => link === document.activeElement), true, 'Returning from the task restores the invoking link focus');
    assert.equal(await page.locator('#formalize-original').inputValue(), '查看路线图后继续提问的草稿');
    assert.equal(new URL(page.url()).searchParams.get('chat'), chatId);
    mark(`${width}px: a theorem mention opens its exact roadmap task and recorded Lean source, then returns to the same message, focus and draft`);

    const instruction = '证明 Tutorial.zero_add 时请优先使用 Nat.zero_add，并保留原题声明。';
    const callsBefore = providerCalls.length, commandsBefore = commands.length;
    await page.locator('[data-chat-guidance-mode-open]').click();
    await page.locator('[data-chat-guidance-target]').selectOption('goal_2');
    await page.locator('#formalize-original').fill(instruction);
    // Sending proof requirements uses the existing task, not a new model completion.
    if (!await page.locator('#formalize-key').isVisible()) await page.locator('#open-settings').click();
    await page.locator('#formalize-key').fill('');
    await page.locator('#formalize-start:enabled').click();
    const receipt = page.locator('[data-chat-guidance-receipt][data-guidance-status="queued"]'); await receipt.waitFor();
    assert.equal(commands.length, commandsBefore + 1);
    const command = commands.at(-1)!;
    assert.equal(command.runId, run.id); assert.equal(command.input.text, instruction);
    assert.deepEqual(command.input.recipient, { kind: 'task', id: 'goal_2' });
    assert.equal(command.input.taskRef?.id, 'goal_2');
    assert.equal(command.input.taskRef?.version, controls.get(run.id)!.observation.inspection.tasks.find(task => task.id === 'goal_2')?.version);
    assert.equal(await page.locator('#formalize-original').inputValue(), '');
    const control = controls.get(run.id)!;
    const delivered = control.observation.guidance.find(item => item.id === command.input.id)!;
    Object.assign(delivered, { status: 'delivered', deliveredTo: ['prover-2'], updatedAt: new Date().toISOString() }); control.emit();
    await page.locator(`[data-chat-guidance-receipt="${command.input.id}"][data-guidance-status="delivered"]`).waitFor();
    await page.reload();
    await page.locator(`[data-chat-guidance-receipt="${command.input.id}"][data-guidance-status="delivered"]`).waitFor();
    assert.equal(commands.length, commandsBefore + 1, 'Refresh reads the receipt without repeating the command');
    assert.equal(providerCalls.length, callsBefore, 'Guidance does not create a chat completion');
    assert.equal(writes.filter(path => path === '/api/runs').length, 1, 'Only the explicit recorded task was started');
    assert.equal(writes.filter(path => path === '/api/formalizations').length, 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(await audit(page), []);
    await page.screenshot({ path: path.join(output, `guidance-delivered-${width}.png`), fullPage: true });
    mark(`${width}px: proof requirements target the recorded task version; queued/delivered receipts persist without duplicate work`);

    const uncertainText = '请保留这条证明要求，待实际投递记录确认。';
    const nextText = '下一条要求：说明零元定理的参数与当前任务的对应关系。';
    const beforeUncertain = commands.length;
    await page.locator('[data-chat-guidance-mode-open]').click();
    await page.locator('[data-chat-guidance-target]').selectOption('goal_2');
    await page.locator('#formalize-original').fill(uncertainText);
    loseNextCommandReceipt = true;
    await page.locator('#formalize-start:enabled').click();
    await page.locator('[data-chat-guidance-receipt][data-guidance-status="unknown"]').waitFor();
    assert.equal(commands.length, beforeUncertain + 1);
    assert.equal(await page.locator('#formalize-original').inputValue(), uncertainText, 'An uncertain receipt retains the submitted text');
    const uncertainCommand = commands.at(-1)!;
    await page.locator('#formalize-original').fill(nextText);
    assert.equal(await page.locator('#formalize-start').isDisabled(), true, 'Another proof requirement waits for the uncertain receipt');
    const confirmed = control.observation.guidance.find(item => item.id === uncertainCommand.input.id)!;
    Object.assign(confirmed, { status: 'delivered', deliveredTo: ['prover-2'], updatedAt: new Date().toISOString() }); control.emit();
    await page.locator(`[data-chat-guidance-receipt="${uncertainCommand.input.id}"][data-guidance-status="delivered"]`).waitFor();
    await page.locator('#formalize-start:enabled').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), nextText, 'Delivery reconciliation preserves a newer unsent draft');
    assert.equal(commands.length, beforeUncertain + 1, 'Observing delivery does not submit the uncertain command again');
    await page.locator('#formalize-start').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-chat-guidance-receipt][data-guidance-status="queued"]').length === 1);
    assert.equal(commands.length, beforeUncertain + 2);
    assert.equal(commands.at(-1)!.input.text, nextText);
    assert.notEqual(commands.at(-1)!.input.id, uncertainCommand.input.id, 'The next proof requirement has a new command identity');
    assert.equal(providerCalls.length, callsBefore);
    assert.equal(writes.filter(path => path === '/api/runs').length, 1);
    await page.screenshot({ path: path.join(output, `guidance-recovered-${width}.png`), fullPage: true });
    mark(`${width}px: an uncertain receipt reconciles to delivered, preserves a newer draft and permits the next requirement without resending`);
    control.finish(); await context.close();
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', paidModelCalls: false, checks }, null, 2) + '\n');
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  const viewport = await page?.evaluate(() => {
    const source = document.querySelector('[data-task-source-code]');
    return { width: innerWidth, height: innerHeight, documentHeight: document.documentElement.scrollHeight,
      source: source?.getBoundingClientRect().toJSON(), sourceScrollers: source ? [...function* () {
        for (let node = source.parentElement; node; node = node.parentElement)
          yield { tag: node.tagName, id: node.id, class: node.className, top: node.scrollTop, height: node.clientHeight, scrollHeight: node.scrollHeight, overflow: getComputedStyle(node).overflowY };
      }()] : [] };
  }).catch(() => undefined);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', paidModelCalls: false, checks,
    error: error instanceof Error ? error.message : String(error), viewport }, null, 2) + '\n');
  throw error;
} finally {
  for (const control of controls.values()) control.finish();
  await browser?.close(); await service.close(); provider.stop(true); await fs.rm(temporary, { recursive: true, force: true });
}
