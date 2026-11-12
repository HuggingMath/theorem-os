#!/usr/bin/env bun
// Harder frontend simulation: use the existing Schur Lean example, never an unrelated formalization receipt.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebExplanation, WebExplanationOverview, WorkerInput, WorkerMessage } from '../apps/web/shared';
import { researchExamples } from '../apps/web/problemExamples';
import { localeStorageKey } from '../apps/web/i18n';
import { schurDemoProof, schurDemoExplanation, schurEqualityQuestion, schurEqualityAnswer } from './fixtures/schurDemo';
import { freePort, preferFullCollaboration, settled, startBrowser } from './web-scenario';
import { showExamples, withSettings } from './web-ui-controls';
import { audit } from './web-a11y';

declare const Bun: { serve(options: { hostname: string; port: number; idleTimeout: number;
  fetch(request: Request): Response | Promise<Response> }): { port: number; stop(force?: boolean): void } };

const root = path.resolve(import.meta.dirname, '..'), example = researchExamples.find(item => item.id === 'schur-cubic')!;
const output = process.env.THEOREMOS_SCHUR_DEMO_OUTPUT ?? path.join(root, 'out/web-schur-demo');
await fs.access(path.join(root, 'out/web/app.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-schur-demo-'));
const task = example.original + '\n\n请先证明排序情形的辅助引理，再覆盖全部变量顺序；不直接调用 Schur 不等式结论。';
const target = schurDemoExplanation.target, proof = schurDemoProof;
const mainLine = schurDemoExplanation.sections.find(section => section.target)!.signature.end;
const candidate = proof.split('\n').slice(0, mainLine).join('\n') + '\n  sorry\n\nend SchurCubic\n';
const checks: string[] = [], screenshots: string[] = [], errors: string[] = [], external: string[] = [], forbiddenCalls: string[] = [];
const requests: { method: string; pathname: string }[] = [], providerCalls: Record<string, unknown>[] = [];
const mark = (text: string) => { checks.push(text); console.log(`PASS ${text}`); };
const runs: { input: WorkerInput; send(message: WorkerMessage): void; resolve(): void }[] = [];
let phase = 'setup', failure: unknown, runId = '', explanationReady = false;
let reply: { delta(text: string): void; finish(): void } | undefined;
const answerStart = '【本地模拟回答】等号条件要同时检查分解式中的两个非负项。\n\n';
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
  assert.equal(new URL(request.url).pathname, '/v1/responses'); providerCalls.push(await request.json() as Record<string, unknown>);
  let text = '', closed = false;
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    const send = (event: object) => { if (!closed) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); };
    reply = { delta(value) { text += value; send({ type: 'response.output_text.delta', delta: value }); }, finish() {
      send({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } });
      if (!closed) { closed = true; controller.close(); }
    } };
    request.signal.addEventListener('abort', () => { if (!closed) { closed = true; controller.close(); } }, { once: true });
  }, cancel() { closed = true; } }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
} });
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Schur 前端模拟；不执行模型或 Lean' }; },
  async formalize() { forbiddenCalls.push('formalize'); throw new Error('This example uses its own Lean template; no formalization receipt may be reused.'); },
  run(input, send, signal) { return new Promise<void>(resolve => {
    runs.push({ input: structuredClone(input), send, resolve }); runId = input.id;
    signal.addEventListener('abort', () => resolve(), { once: true });
    send({ type: 'progress', event: 'solve_started', message: '本地模拟：证明三次 Schur 不等式' });
    send({ type: 'progress', event: 'research_action', message: '本地模拟：拆分代数恒等式与排序情形', details: { workerId: 'solver', operation: 'direct' } });
    send({ type: 'progress', event: 'turn_started', message: '本地模拟：第 1 轮，构造辅助引理', details: { workerId: 'solver', turn: 1 } });
    send({ type: 'action', action: { workerId: 'solver', itemId: 'schur-plan', phase: 'completed', kind: 'message', status: 'done',
      text: '本地模拟证明概要：保留 a、b、c 的三个非负条件；先把差值分解为两项，再证明排序情形非负，最后处理六种顺序。' } });
    send({ type: 'artifact', artifact: { source: candidate, workerId: 'solver', capturedAt: new Date().toISOString(), status: 'candidate' } });
  }); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot });
config.providers = [{ id: 'sub2api', name: '本地模拟提供商', baseUrl: `http://127.0.0.1:${provider.port}/v1` }];
const service = createWebService(config, runner, { sample: null }), at = new Date().toISOString();
function explanation(): WebExplanation {
  return { id: `${runId}-schur-demo`, runId, target, language: 'zh', createdAt: at, updatedAt: at,
    status: explanationReady ? 'approved' : 'running', model: 'local-fixture', effort: 'high', maxRunSeconds: 0, maxTotalTokens: 0,
    ...(explanationReady ? { document: schurDemoExplanation } : { progress: { phase: 'auditing', batches: 3, approvedBatches: 1, updatedAt: at } }) };
}
async function eventually(check: () => boolean) { while (!check()) await new Promise(resolve => setTimeout(resolve, 40)); }
let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined;
async function shot(name: string) {
  await settled(page!); await page!.evaluate(() => document.fonts.ready);
  assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, name + ': no page overflow');
  assert.deepEqual(await audit(page!), []);
  await page!.screenshot({ path: path.join(output, name), fullPage: true, timeout: 0 }); screenshots.push(name);
}
try {
  browser = await startBrowser(service.server, port);
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  // The mathematical progress block and the output buttons of a running proof are the 详细 reading; 简洁 shows them in the workspace.
  await preferFullCollaboration(context);
  context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0); await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  await context.addInitScript(key => {
    localStorage.setItem(key, 'zh');
    window.addEventListener('DOMContentLoaded', () => {
      const note = document.createElement('div'); note.setAttribute('role', 'note'); note.textContent = 'Schur 前端模拟 · 未调用模型或 Lean';
      note.style.cssText = 'position:fixed;right:6px;bottom:6px;z-index:2147483647;pointer-events:none;max-width:90vw;padding:4px 8px;border:1px solid #a67035;background:#fff8e9;color:#714d23;font:11px/1.5 sans-serif';
      document.body.append(note);
    });
  }, localeStorageKey);
  await context.route(/^https?:\/\//u, async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
    if (url.pathname.startsWith('/api/')) requests.push({ method: request.method(), pathname: url.pathname });
    if (runId && request.method() === 'GET' && url.pathname === `/api/runs/${runId}/explanations`) {
      const value: WebExplanationOverview = { run: { id: runId, title: '三次 Schur 不等式（本地模拟）', environment: 'mathlib', providerId: 'sub2api', model: 'local-fixture', effort: 'high', proof },
        targets: [{ name: target, declarations: schurDemoExplanation.sections.length }], explanations: [explanation()], generation: { available: false, reason: 'runtime' } };
      await route.fulfill({ json: value }); return;
    }
    if (runId && request.method() === 'GET' && url.pathname === `/api/runs/${runId}/explanations/item`) {
      assert(explanationReady); assert.equal(url.searchParams.get('target'), target);
      await route.fulfill({ json: { explanation: explanation() } }); return;
    }
    await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0); page.on('pageerror', error => errors.push(error.message));
  phase = '选择较难原题'; await page.goto(origin); await page.locator('#formalize-original').waitFor();
  await page.locator('.chat-examples > summary').click(); await page.locator('#formalize-example').selectOption(example.id);
  assert.equal(await page.locator('#formalize-original').inputValue(), example.original);
  assert.equal(await page.locator('#formalize-environment').inputValue(), 'mathlib');
  assert.equal(requests.filter(request => request.method === 'POST').length, 0);
  await shot('01-schur-natural-statement.png');
  mark('选择 Schur 例题完整保留三个非负条件，没有归一化或预设大小顺序');

  phase = '提交自身 Lean 声明'; await showExamples(page); await page.locator('[data-chat-template="schur-cubic"]').click();
  assert.equal(await page.locator('#source').inputValue(), example.source); assert.equal(await page.locator('#environment').inputValue(), 'mathlib');
  await page.locator('#task').fill(task);
  await withSettings(page, async () => {
    await page.locator('#api-key').fill('local-schur-demo-not-a-real-key');
    await page.locator('#model').fill('local-fixture');
    for (const selector of ['#max-seconds', '#max-tokens', '#max-turns']) { await page.locator(selector).fill(''); assert.equal(await page.locator(selector).inputValue(), ''); }
    await shot('02-schur-unlimited-settings.png');
  });
  await page.locator('#submit-run:enabled').click(); await eventually(() => runs.length === 1);
  await page.waitForURL(url => url.searchParams.has('chat')); const run = runs[0];
  assert.equal(run.input.input.source, example.source.trim()); assert.equal(run.input.input.task, task); assert.equal(run.input.input.environment, 'mathlib');
  assert.equal(run.input.formalization, undefined);
  for (const key of ['maxRunSeconds', 'maxTotalTokens', 'maxTurns'] as const) assert.equal(run.input.input[key], 0);
  mark('真实本地接口收到 Schur 自身声明和中文原题；只启动一次证明，时间、Token、轮次不限');

  phase = '辅助引理与未完成主目标';
  await page.locator('[data-research-artifact="source"]:enabled').waitFor(); await page.locator('[data-research-artifact="source"]').click();
  await page.locator('#detail-panel[data-tab="source"]').waitFor();
  assert.equal((await page.locator('#detail-panel .code-scroll code').innerText()).trim(), candidate.trim());
  assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false');
  await shot('03-partial-lemmas-candidate.png'); await page.locator('#close-research-output').click();
  mark('中间候选保留辅助引理和未完成主目标，明确显示尚未验收');

  phase = '完成六种顺序的候选';
  run.send({ type: 'progress', event: 'turn_started', message: '本地模拟：第 2 轮，补齐六种变量顺序', details: { workerId: 'solver', turn: 2 } });
  run.send({ type: 'artifact', artifact: { source: proof, workerId: 'solver', capturedAt: new Date().toISOString(), status: 'candidate' } });
  run.send({ type: 'action', action: { workerId: 'solver', itemId: 'schur-cases', phase: 'completed', kind: 'message', status: 'done',
    text: '本地模拟：已用 le_total 穷尽三变量的六种顺序，再将排序引理的结论通过代数恒等式转回原目标。代码由测试预先提供，未执行 Lean。' } });
  await page.locator('[data-research-artifact="source"]').click();
  await page.waitForFunction(expected => document.querySelector('#detail-panel .code-scroll code')?.textContent?.trim() === expected.trim(), proof);
  assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false');
  await shot('04-complete-candidate-before-review.png'); await page.locator('#close-research-output').click();
  mark('长证明更新后立即可读，完成候选与验收通过保持区分');
  run.send({ type: 'progress', event: 'evaluation_started', message: '本地模拟：最终检查' });
  run.send({ type: 'result', result: { status: 'evaluated_passed', proof, report: { status: 'evaluated_passed', fixture: true, realModelCalls: 0, realLeanProcesses: 0 } } }); run.resolve();
  await page.locator('.research-conversation-status[data-accepted="true"]').waitFor(); await page.locator('.chat-answer-generation').waitFor();
  phase = '后台讲解与代码导出'; await shot('05-explanation-background.png');
  await page.locator('[data-research-artifact="source"]').click(); await page.locator('#detail-panel[data-tab="source"]').waitFor();
  await page.locator('#detail-panel [data-action="copy-source"]').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), proof);
  const download = page.waitForEvent('download', { timeout: 0 }); await page.locator('#detail-panel [data-action="download-proof"]').click();
  await (await download).saveAs(path.join(output, 'SchurCubic.lean')); assert.equal(await fs.readFile(path.join(output, 'SchurCubic.lean'), 'utf8'), proof);
  assert.doesNotMatch(proof, /\bsorry\b/u); await page.locator('#close-research-output').click();
  mark('详细讲解后台处理时，完整候选仍可复制下载，导出内容与显示一致');

  phase = '多步证明与辅助引理'; explanationReady = true; await page.locator('[data-chat-answer-refresh]').click();
  const answer = page.locator(`[data-chat-answer-document="${target}"]`); await answer.waitFor();
  assert.equal(await answer.locator('.chat-answer-target .chat-answer-steps > li').count(), schurDemoExplanation.sections.find(section => section.target)!.steps.length);
  assert.doesNotMatch(await answer.innerText(), /\\u[0-9a-f]{4}/iu);
  await answer.locator('.chat-answer-target .math[data-math-state="ready"]').first().waitFor();
  await answer.locator('.chat-answer-target').evaluate(node => node.scrollIntoView({ block: 'start' }));
  await shot('06-schur-detailed-proof.png');
  await answer.locator('.chat-answer-target .chat-answer-steps > li').last().scrollIntoViewIfNeeded();
  await shot('06b-schur-proof-conclusion.png');
  const link = answer.locator('.chat-answer-target [data-chat-answer-use]').first(); await link.click();
  const support = answer.locator('.chat-answer-support[open]'); await support.waitFor();
  assert.equal(await support.evaluate(node => node === document.activeElement), true); await shot('07-expanded-supporting-lemma.png');
  mark('主证明显示完整步骤、数学公式与本地辅助引理链接；点击会展开并定位引理');

  phase = '等号条件追问';
  await page.locator('#formalize-original').fill(schurEqualityQuestion);
  if (!await page.locator('#formalize-key').isVisible()) await page.locator('#open-settings').click();
  await page.locator('#formalize-key').fill('local-schur-demo-not-a-real-key');
  await page.locator('#formalize-start:enabled').click(); await eventually(() => Boolean(reply)); reply!.delta(answerStart);
  await page.waitForFunction(() => document.querySelector('#research-chat-thread')?.textContent?.includes('【本地模拟回答】'));
  await shot('08-equality-streaming.png'); reply!.delta(schurEqualityAnswer); reply!.finish(); await page.locator('#chat-stop').waitFor({ state: 'hidden' });
  const chatId = new URL(page.url()).searchParams.get('chat')!;
  const conversation = await page.evaluate(async id => (await (await fetch(`/api/conversations/${id}`)).json()).conversation, chatId);
  assert.equal(conversation.messages.at(-1).text, answerStart + schurEqualityAnswer);
  assert.equal(runs.length, 1); assert.equal(providerCalls.length, 1);
  const input = providerCalls[0].input as { role: string; content: { text: string }[] }[];
  assert.equal(input.length, 1); assert.equal(input[0].role, 'user');
  const prefix = 'Recorded task context:\n', separator = '\n\nQuestion: ', sent = input[0].content[0].text;
  assert(sent.startsWith(prefix)); const split = sent.indexOf(separator);
  assert(split > prefix.length); assert.equal(sent.slice(split + separator.length), schurEqualityQuestion);
  const sentContext = JSON.parse(sent.slice(prefix.length, split));
  assert(sentContext.original.includes(example.original)); assert.equal(sentContext.run.source, example.source.trim());
  assert.equal(sentContext.run.task, task); assert.equal(sentContext.run.proof, proof);
  assert.doesNotMatch(await page.locator('#research-chat-thread').innerText(), /\\u[0-9a-f]{4}/iu);
  await shot('09-equality-answer.png');
  mark('等号条件追问保留原题及证明上下文，完整流式回答两类等号情形，不重启证明');

  phase = '手机长证明恢复'; const draft = '如果允许一个变量为负，这个不等式还成立吗？';
  await page.locator('#formalize-original').fill(draft); await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
  await page.locator(`[data-chat-answer-document="${target}"]`).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('chat'), chatId); assert.equal(await page.locator('#formalize-original').inputValue(), draft);
  const savedAnswer = conversation.messages.at(-1), savedQuestion = conversation.messages.find((message: { id: string }) => message.id === savedAnswer.replyTo);
  assert.equal(await page.locator(`[data-message-id="${savedQuestion.id}"] .chat-message-content`).innerText(), schurEqualityQuestion);
  const restoredAnswer = page.locator(`[data-message-id="${savedAnswer.id}"][data-message-status="complete"] .chat-message-content`);
  await restoredAnswer.waitFor();
  const expectedParagraphs = (answerStart + schurEqualityAnswer).trim().split('\n\n');
  const actualParagraphs = restoredAnswer.locator(':scope > p'); assert.equal(await actualParagraphs.count(), expectedParagraphs.length);
  for (const [index, expectedText] of expectedParagraphs.entries()) {
    const paragraph = actualParagraphs.nth(index), rendered = await paragraph.innerText();
    for (const fragment of expectedText.split(/\$[^$]+\$/u)) if (fragment.trim()) assert(rendered.includes(fragment.trim()));
    assert.deepEqual(await paragraph.locator('.math').evaluateAll(nodes => nodes.map(node => node.getAttribute('title'))),
      [...expectedText.matchAll(/\$([^$]+)\$/gu)].map(match => match[1]));
  }
  assert.equal(await page.locator('#formalize-key').inputValue(), ''); await shot('10-mobile-restored.png');
  await page.locator('.chat-answer-target').evaluate(node => node.scrollIntoView({ block: 'start' })); await shot('11-mobile-proof.png');
  await page.locator('.chat-answer-target .chat-answer-steps > li').nth(3).evaluate(node => node.scrollIntoView({ block: 'start' }));
  await shot('11b-mobile-decomposition.png');
  const mobileLink = page.locator('.chat-answer-target [data-chat-answer-use]').first(); await mobileLink.click();
  await page.locator('.chat-answer-support[open]').waitFor(); await shot('12-mobile-lemma.png');
  mark('390px 手机刷新恢复较长证明、等号追问和未发送草稿，公式与引理可读且无页面横向溢出');
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(forbiddenCalls, []);
  assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/runs').length, 1);
  assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/formalizations').length, 0);
} catch (error) { failure = error; await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 0 }).catch(() => {}); }
finally {
  for (const run of runs) run.resolve(); reply?.finish(); await context?.tracing.stop({ path: path.join(output, 'trace.zip') });
  await browser?.close(); await service.close(); provider.stop(true); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    problem: { id: example.id, title: example.name, original: example.original, target, task },
    mode: 'Real local app and HTTP submission through the existing Lean example; staged synthetic runner, explanation and streaming follow-up.',
    evidenceBoundary: 'This tests the harder problem after selecting its own Lean statement. It does not test automatic natural-language formalization. The proof source is an uncompiled candidate; completion and approval statuses are synthetic, not new acceptance evidence.',
    checks, screenshots, requests, errors, external, forbiddenCalls, formalizationCalls: 0, proofCalls: runs.length, localProviderCalls: providerCalls.length,
    realModelCalls: 0, realLeanProcesses: 0, executionDeadline: null, tokenLimit: null, roundLimit: null, browserTimeouts: 0, fixtureDataRemoved: true,
    ...(failure ? { failedPhase: phase, error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2) + '\n');
}
if (failure) throw failure;
console.log(JSON.stringify({ status: 'passed', checks: checks.length, screenshots: screenshots.length, output }));
