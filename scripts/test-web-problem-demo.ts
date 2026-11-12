#!/usr/bin/env bun
// One explicitly labelled frontend simulation. No real model, Lean, Docker or external delivery.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WorkerFormalizationInput, WorkerFormalizationMessage } from '../apps/web/formalizationTypes';
import type { WebExplanation, WebExplanationDocument, WebExplanationOverview, WorkerInput, WorkerMessage } from '../apps/web/shared';
import { localeStorageKey } from '../apps/web/i18n';
import { webFormalizationEvidence, webFormalizationStatement } from '../tests/helpers/webFormalizationFixture';
import { freePort, preferFullCollaboration, settled, startBrowser } from './web-scenario';
import { openAdvancedChatSettings } from './web-ui-controls';
import { audit } from './web-a11y';

declare const Bun: { serve(options: { hostname: string; port: number; idleTimeout: number;
  fetch(request: Request): Response | Promise<Response> }): { port: number; stop(force?: boolean): void } };

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_DEMO_OUTPUT ?? path.join(root, 'out/web-problem-demo');
await fs.access(path.join(root, 'out/web/app.js'));
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-one-problem-demo-'));
const original = webFormalizationStatement;
const proof = 'theorem addition (n : Nat) : n + 1 = 1 + n := by\n  exact Nat.add_comm n 1\n';
const checks: string[] = [], screenshots: string[] = [], errors: string[] = [], external: string[] = [];
const requests: { method: string; pathname: string }[] = [], providerCalls: Record<string, unknown>[] = [];
const timings: { stage: string; elapsedMs: number }[] = [], started = performance.now();
const mark = (text: string) => { checks.push(text); console.log(`PASS ${text}`); };
let phase = 'setup', failure: unknown, runId = '', explanationReady = false;
const formalizations: { input: WorkerFormalizationInput; send(message: WorkerFormalizationMessage): void; resolve(): void }[] = [];
const runs: { input: WorkerInput; send(message: WorkerMessage): void; resolve(): void }[] = [];
let reply: { delta(text: string): void; finish(): void } | undefined;
const answerStart = '【本地模拟回答】这里直接使用自然数加法交换律。\n\n';
const answerEnd = [
  '对任意 $a,b\\in\\mathbb N$，交换律给出 $a+b=b+a$。将 $a=n$、$b=1$ 代入，就得到 $n+1=1+n$。',
  'Lean 中的 `Nat.add_comm n 1` 是这个等式的证明项；`exact` 用它关闭同类型的目标。没有增加任何假设；当 $n=0$ 时，两边都等于 $1$。',
  '这段回答由本地测试提供，不代表本次调用模型或重新执行 Lean 验收。',
].join('\n\n');
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
  assert.equal(new URL(request.url).pathname, '/v1/responses');
  providerCalls.push(await request.json() as Record<string, unknown>);
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
  async readiness() { return { ready: true, message: '本地前端模拟：不执行模型或 Lean' }; },
  formalize(input, send, signal) { return new Promise<void>(resolve => {
    formalizations.push({ input: structuredClone(input), send, resolve });
    signal.addEventListener('abort', () => resolve(), { once: true });
  }); },
  run(input, send, signal) { return new Promise<void>(resolve => {
    runs.push({ input: structuredClone(input), send, resolve }); runId = input.id;
    signal.addEventListener('abort', () => resolve(), { once: true });
    send({ type: 'progress', event: 'solve_started', message: '本地模拟：开始证明自然数加法恒等式' });
    send({ type: 'progress', event: 'research_action', message: '本地模拟：应用 Nat.add_comm', details: { workerId: 'solver', operation: 'direct' } });
    send({ type: 'action', action: { workerId: 'solver', itemId: 'demo-plan', phase: 'completed', kind: 'message', status: 'done',
      text: '本地模拟解题说明：加法交换律对所有自然数成立；将第二个参数取为 1，即得到原目标。' } });
    send({ type: 'artifact', artifact: { source: proof, workerId: 'solver', capturedAt: new Date().toISOString(), status: 'candidate' } });
  }); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot });
config.providers = [{ id: 'sub2api', name: '本地模拟提供商', baseUrl: `http://127.0.0.1:${provider.port}/v1` }];
const service = createWebService(config, runner, { sample: null });
const at = new Date().toISOString();
const mathematicalExplanation: WebExplanationDocument = { schema: 'theorem-os.web-explanation.v1', target: 'addition', language: 'zh',
  toolchain: 'frontend-simulation', mathlibRevision: null, overview: '本地模拟讲解：这是自然数加法交换律的一个实例。下面逐步对应原题与 Lean 证明。', axioms: [],
  sections: [{ name: 'addition', kind: 'theorem', target: true, title: '自然数与 1 的加法恒等式',
    statement: '对任意 $n\\in\\mathbb N$，证明 $n+1=1+n$。', lines: { start: 1, end: 2 }, signature: { start: 1, end: 1 }, unexplained: [], statementReviews: [],
    steps: [
      { text: '先固定任意自然数 $n$。原题没有额外假设，也包含 $n=0$。', uses: [], lines: [{ start: 1, end: 1 }], reviews: [] },
      { text: '自然数加法交换律是 $a+b=b+a$。取 $a=n$、$b=1$，即得 $n+1=1+n$。',
        uses: [{ name: 'Nat.add_comm', place: 'step', spans: [] }], lines: [{ start: 2, end: 2 }], reviews: [] },
      { text: '用 `exact Nat.add_comm n 1` 将这一证明项交给 Lean，目标类型正好一致。这里展示的是预先提供的模拟代码，本次没有运行 Lean。',
        uses: [{ name: 'Nat.add_comm', place: 'step', spans: [] }], lines: [{ start: 2, end: 2 }], reviews: [] },
    ] }], metrics: { declarations: 1, steps: 3, citations: 2, excerptCoverage: 1, proofLines: 1, explainedLines: 1, ambiguousExcerpts: 0 },
  model: 'local-fixture', effort: 'high', auditors: 0, rounds: 0, tokens: null };
function explanation(): WebExplanation {
  return { id: `${runId}-demo`, runId, target: 'addition', language: 'zh', createdAt: at, updatedAt: at,
    status: explanationReady ? 'approved' : 'running', model: 'local-fixture', effort: 'high', maxRunSeconds: 0, maxTotalTokens: 0,
    ...(explanationReady ? { document: mathematicalExplanation } : { progress: { phase: 'auditing', batches: 1, approvedBatches: 0, updatedAt: at } }) };
}
async function eventually(check: () => boolean) { while (!check()) await new Promise(resolve => setTimeout(resolve, 40)); }
let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined;
async function shot(name: string) {
  await settled(page!); await page!.evaluate(() => document.fonts.ready);
  assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, name + ': no page overflow');
  assert.deepEqual(await audit(page!), []);
  await page!.screenshot({ path: path.join(output, name), fullPage: true, timeout: 0 }); screenshots.push(name);
  timings.push({ stage: phase, elapsedMs: Math.round(performance.now() - started) });
}
try {
  browser = await startBrowser(service.server, port);
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
  // The mathematical progress block and the output buttons of a running proof are the 详细 reading; 简洁 shows them in the workspace.
  await preferFullCollaboration(context);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  await context.addInitScript(key => {
    localStorage.setItem(key, 'zh');
    window.addEventListener('DOMContentLoaded', () => {
      const note = document.createElement('div'); note.setAttribute('role', 'note'); note.textContent = '本地前端模拟 · 未调用模型或 Lean';
      note.style.cssText = 'position:fixed;right:6px;bottom:6px;z-index:2147483647;pointer-events:none;max-width:90vw;padding:4px 8px;border:1px solid #a67035;background:#fff8e9;color:#714d23;font:11px/1.5 sans-serif';
      document.body.append(note);
    });
  }, localeStorageKey);
  await context.route(/^https?:\/\//u, async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
    if (url.pathname.startsWith('/api/')) requests.push({ method: request.method(), pathname: url.pathname });
    if (runId && request.method() === 'GET' && url.pathname === `/api/runs/${runId}/explanations`) {
      const value: WebExplanationOverview = { run: { id: runId, title: '自然数加法恒等式（本地模拟）', environment: 'standard', providerId: 'sub2api', model: 'local-fixture', effort: 'high', proof },
        targets: [{ name: 'addition', declarations: 1 }], explanations: [explanation()], generation: { available: false, reason: 'runtime' } };
      await route.fulfill({ json: value }); return;
    }
    if (runId && request.method() === 'GET' && url.pathname === `/api/runs/${runId}/explanations/item`) {
      assert(explanationReady); assert.equal(url.searchParams.get('target'), 'addition');
      await route.fulfill({ json: { explanation: explanation() } }); return;
    }
    await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0);
  page.on('pageerror', error => errors.push(error.message));
  phase = '输入原题与无限制预算'; await page.goto(origin); await page.locator('#formalize-original').fill(original);
  await page.locator('[data-chat-participation-control] > summary').click();
  await page.locator('input[name="chat-participation"][value="automatic"]').check();
  await page.locator('#open-settings').click(); await page.locator('#formalize-key').fill('local-demo-not-a-real-key');
  await openAdvancedChatSettings(page); await page.locator('#formalize-environment').selectOption('standard');
  for (const selector of ['#formalize-minutes', '#formalize-tokens', '#research-minutes', '#research-tokens', '#research-turns']) assert.equal(await page.locator(selector).inputValue(), '');
  await shot('01-input-unlimited.png'); await page.locator('#formalize-start').click();
  await page.waitForURL(url => url.searchParams.has('chat')); await eventually(() => formalizations.length === 1);
  const formalization = formalizations[0];
  assert.equal(formalization.input.original, original);
  for (const key of ['maxRunSeconds', 'maxTotalTokens', 'maxRounds', 'maxPlanningRounds'] as const) assert.equal(formalization.input[key], 0);
  mark('原题精确保留，只启动一次形式化；全部预算为无限制');

  phase = '形式化过程展示';
  formalization.send({ type: 'progress', progress: { phase: 'planning', round: 1 } });
  formalization.send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'role', workerId: 'r1-plan-1', role: 'plan', slot: 'plan-1', state: 'finished',
    summary: { taskKind: 'prove', sections: [{ kind: 'conclusions', items: ['本地模拟：对任意自然数 n，证明 n + 1 = 1 + n。'] }, { kind: 'assumptions', items: ['n 的类型是 Nat；没有额外假设。'] }] } } } });
  formalization.send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'compile', state: 'passed',
    source: 'theorem addition (n : Nat) : n + 1 = 1 + n := by sorry\n', targets: ['addition'], lean: { passed: true, messages: [] }, text: '本地模拟编译记录' } } });
  await page.locator('[data-solve-process]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-chat-math-finding]')?.textContent?.includes('本地模拟：对任意自然数 n'));
  await shot('02-formalization-process.png');
  mark('形式化过程展示题意、自然数范围和同一个 Lean 目标');
  formalization.send({ type: 'result', status: 'approved', evidence: webFormalizationEvidence(formalization.input) }); formalization.resolve();
  await eventually(() => runs.length === 1); const run = runs[0];
  for (const key of ['maxRunSeconds', 'maxTotalTokens', 'maxTurns'] as const) assert.equal(run.input.input[key], 0);
  assert.equal((run.input.formalization as { request: { statement: string } }).request.statement, original);

  phase = '验收前候选代码可用';
  await page.locator('[data-research-artifact="source"]:enabled').waitFor(); await page.locator('[data-research-artifact="source"]').click();
  await page.locator('#detail-panel[data-tab="source"]').waitFor();
  assert.equal((await page.locator('#detail-panel .code-scroll code').innerText()).trim(), proof.trim());
  assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false');
  await shot('03-candidate-before-verification.png');
  mark('证明尚未完成时，已能打开候选代码，且不会提前显示通过');
  await page.locator('#close-research-output').click();
  run.send({ type: 'progress', event: 'proof_check_started', message: '本地模拟：检查候选证明' });
  run.send({ type: 'action', action: { workerId: 'solver', itemId: 'demo-check', phase: 'completed', kind: 'command', status: 'done', command: 'simulation: replay recorded proof check', output: '本地模拟检查数据；未执行 Lean', lean: { passed: true, messages: [] } } });
  run.send({ type: 'progress', event: 'evaluation_started', message: '本地模拟：最终检查' });
  run.send({ type: 'result', result: { status: 'evaluated_passed', proof, report: { status: 'evaluated_passed', fixture: true, realModelCalls: 0, realLeanProcesses: 0 } } }); run.resolve();
  await page.locator('.research-conversation-status[data-accepted="true"]').waitFor();
  await page.locator('.chat-answer-generation').waitFor();
  phase = '讲解后台核对时读取代码';
  await shot('04-code-ready-explanation-background.png');
  await page.locator('[data-research-artifact="source"]').click(); await page.locator('#detail-panel[data-tab="source"]').waitFor();
  await page.locator('#detail-panel [data-action="copy-source"]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), proof);
  const download = page.waitForEvent('download', { timeout: 0 }); await page.locator('#detail-panel [data-action="download-proof"]').click();
  await (await download).saveAs(path.join(output, 'Submission.lean'));
  assert.equal(await fs.readFile(path.join(output, 'Submission.lean'), 'utf8'), proof);
  assert.equal(/\bsorry\b/u.test(proof), false); await shot('05-copy-download-code.png');
  await page.locator('#close-research-output').click();
  mark('讲解处于后台核对状态时，证明源码仍可查看、复制和下载，三者一致');

  phase = '详细数学解答'; explanationReady = true; await page.locator('[data-chat-answer-refresh]').click();
  await page.locator('[data-chat-answer-document="addition"]').waitFor();
  assert.equal(await page.locator('.chat-answer-steps > li').count(), 3);
  assert.doesNotMatch(await page.locator('[data-chat-answer-document]').innerText(), /\\u[0-9a-f]{4}/iu);
  await page.locator('[data-chat-answer-document] .math[data-math-state="ready"]').first().waitFor();
  await page.locator('#chat-answer-heading').scrollIntoViewIfNeeded();
  await shot('06-detailed-answer.png');
  mark('详细解答显示三步数学说明、已排版公式与所用引理');
  await page.locator('[data-chat-answer-question="addition:1"]').click();
  assert.match(await page.locator('#formalize-original').inputValue(), /Nat\.add_comm/u);
  assert.equal(providerCalls.length, 0, '解释这一步只预填追问，不自动发送');
  await page.locator('#formalize-start').click(); await eventually(() => Boolean(reply));
  reply!.delta(answerStart);
  await page.waitForFunction(() => document.querySelector('#research-chat-thread')?.textContent?.includes('【本地模拟回答】'));
  phase = '带题目上下文的流式追问'; await shot('07-streaming-followup.png');
  reply!.delta(answerEnd); reply!.finish();
  await page.waitForFunction(() => document.querySelector('#research-chat-thread')?.textContent?.includes('没有增加任何假设'));
  await page.locator('#chat-stop').waitFor({ state: 'hidden' });
  assert.doesNotMatch(await page.locator('#research-chat-thread').innerText(), /\\u[0-9a-f]{4}/iu);
  assert.equal(providerCalls.length, 1); assert(JSON.stringify(providerCalls[0].input).includes(original));
  assert.equal(formalizations.length, 1); assert.equal(runs.length, 1);
  mark('步骤追问保留原题上下文并流式显示回答，不重复启动形式化或证明');

  phase = '手机刷新恢复'; const chatUrl = page.url(), draft = '如果把 1 换成任意自然数 m，应该怎样修改证明？';
  await page.locator('#formalize-original').fill(draft);
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
  await page.locator('[data-chat-answer-document="addition"]').waitFor();
  await page.waitForFunction(() => document.querySelector('#research-chat-thread')?.textContent?.includes('没有增加任何假设'));
  assert.equal(page.url(), chatUrl); assert.equal(await page.locator('#formalize-original').inputValue(), draft);
  assert.equal(await page.locator('#formalize-key').inputValue(), '');
  await shot('08-mobile-restored.png');
  await page.locator('[data-chat-answer-document="addition"]').scrollIntoViewIfNeeded(); await shot('09-mobile-mathematics.png');
  mark('390px 手机刷新后恢复结果、追问和未发送草稿；API Key 未持久化');
  assert.equal(formalizations.length, 1); assert.equal(runs.length, 1); assert.equal(providerCalls.length, 1);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) {
  failure = error; await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 0 }).catch(() => {});
} finally {
  for (const value of formalizations) value.resolve(); for (const value of runs) value.resolve(); reply?.finish();
  await context?.tracing.stop({ path: path.join(output, 'trace.zip') });
  await browser?.close(); await service.close(); provider.stop(true); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    problem: { title: '自然数与 1 的加法恒等式', original, chinese: '对任意自然数 n，证明 n + 1 = 1 + n。', target: 'addition' },
    mode: 'Explicit frontend simulation: real local HTTP application and browser, gated fixture runner, synthetic explanation and streaming local provider.',
    evidenceBoundary: 'Formalization helper reuses its fixed addition correspondence fixture; model/compilation receipts and proof result are synthetic. No new proof acceptance or solver speed result is claimed.',
    checks, screenshots, requests, errors, external, timelinesAreSimulationOnly: true, timings,
    formalizationCalls: formalizations.length, proofCalls: runs.length, localProviderCalls: providerCalls.length,
    realModelCalls: 0, realLeanProcesses: 0, executionDeadline: null, tokenLimit: null, roundLimit: null, browserTimeouts: 0,
    fixtureDataRemoved: true, ...(failure ? { failedPhase: phase, error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2) + '\n');
}
if (failure) throw failure;
console.log(JSON.stringify({ status: 'passed', checks: checks.length, screenshots: screenshots.length, output }));
