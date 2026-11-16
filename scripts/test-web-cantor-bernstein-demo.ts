#!/usr/bin/env bun
// Frontend simulation with a custom Cantor–Bernstein declaration; no model, Lean or automatic formalization.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebExplanation, WebExplanationOverview, WorkerInput, WorkerMessage } from '../apps/web/shared';
import { localeStorageKey } from '../apps/web/i18n';
import { demoOriginal, demoSource, demoTask, demoProof, demoExplanation, demoQuestion, demoAnswer } from './fixtures/cantorBernsteinDemo';
import { freePort, preferFullCollaboration, settled, startBrowser } from './web-scenario';
import { showChat, withSettings, clickWorkbenchAction } from './web-ui-controls';
import { audit } from './web-a11y';

declare const Bun: { serve(options: { hostname: string; port: number; idleTimeout: number;
  fetch(request: Request): Response | Promise<Response> }): { port: number; stop(force?: boolean): void } };

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_CANTOR_BERNSTEIN_DEMO_OUTPUT ?? path.join(root, 'out/web-cantor-bernstein-demo');
await fs.access(path.join(root, 'out/web/app.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-cantor-bernstein-demo-'));
const title = '康托–伯恩斯坦定理', target = 'CantorBernsteinDemo.cantor_bernstein';
const task = demoOriginal + '\n\n' + demoTask, proof = demoProof;
const mainSection = demoExplanation.sections.find(section => section.target && section.name === target)!;
assert(mainSection, 'The fixture must explain the requested Cantor–Bernstein target.');
assert.equal(demoExplanation.target, target);
const candidate = proof.split('\n').slice(0, mainSection.signature.end).join('\n') + '\n  sorry\n\nend CantorBernsteinDemo\n';
const helperName = 'CantorBernsteinDemo.candidate_good', nestedHelperName = 'CantorBernsteinDemo.candidate';
const checks: string[] = [], screenshots: string[] = [], errors: string[] = [], external: string[] = [], forbiddenCalls: string[] = [];
const requests: { method: string; pathname: string }[] = [], providerCalls: Record<string, unknown>[] = [];
const mark = (text: string) => { checks.push(text); console.log(`PASS ${text}`); };
const runs: { input: WorkerInput; send(message: WorkerMessage): void; resolve(): void }[] = [];
let phase = 'setup', failure: unknown, runId = '', explanationReady = false;
let reply: { delta(text: string): void; finish(): void } | undefined;
const answerStart = '【本地模拟回答】下面把分层集合与分段双射落实到自然数，逐项列出前十个像。\n\n';
const fullAnswer = answerStart + demoAnswer;
const mapping = [0, 2, 1, 6, 3, 4, 5, 14, 7, 8].map((value, n) => [String(n), String(value)]);
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
  async readiness() { return { ready: true, message: '环境就绪' }; },
  async formalize() { forbiddenCalls.push('formalize'); throw new Error('This simulation pastes its own Lean declaration and must not invoke automatic formalization.'); },
  run(input, send, signal) { return new Promise<void>(resolve => {
    runs.push({ input: structuredClone(input), send, resolve }); runId = input.id;
    signal.addEventListener('abort', () => resolve(), { once: true });
    send({ type: 'progress', event: 'solve_started', message: '本地模拟：由双向单射构造双射' });
    send({ type: 'progress', event: 'research_action', message: '本地模拟：递归定义 stage 与 good 集合，证明补集元素具有唯一逆像', details: { workerId: 'solver', operation: 'direct' } });
    send({ type: 'progress', event: 'turn_started', message: '本地模拟：第 1 轮，建立递归集合与分段映射辅助引理', details: { workerId: 'solver', turn: 1 } });
    send({ type: 'action', action: { workerId: 'solver', itemId: 'cantor-bernstein-plan', phase: 'completed', kind: 'message', status: 'done',
      text: '本地模拟证明概要：保留任意类型和两个单射假设；从没有 g 逆像的元素出发递归扩展 stage，取并集 good，在 good 上使用 f、补集上使用 g 的唯一逆像，再分别证明单射与满射。' } });
    send({ type: 'artifact', artifact: { source: candidate, workerId: 'solver', capturedAt: new Date().toISOString(), status: 'candidate' } });
  }); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot });
config.providers = [{ id: 'sub2api', name: '本地模拟提供商', baseUrl: `http://127.0.0.1:${provider.port}/v1` }];
const service = createWebService(config, runner, { sample: null }), at = new Date().toISOString();
function explanation(): WebExplanation {
  return { id: `${runId}-cantor-bernstein-demo`, runId, target, language: 'zh', createdAt: at, updatedAt: at,
    status: explanationReady ? 'approved' : 'running', model: 'local-fixture', effort: 'high', maxRunSeconds: 0, maxTotalTokens: 0,
    ...(explanationReady ? { document: demoExplanation } : { progress: { phase: 'auditing', batches: 5, approvedBatches: 2, updatedAt: at } }) };
}
async function eventually(check: () => boolean) { while (!check()) await new Promise(resolve => setTimeout(resolve, 40)); }
let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined;
async function shot(name: string) {
  await settled(page!); await page!.evaluate(() => document.fonts.ready);
  assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, name + ': no page overflow');
  assert.deepEqual(await audit(page!), []);
  await page!.screenshot({ path: path.join(output, name), fullPage: true, timeout: 0 }); screenshots.push(name);
}
async function openHelper(from: Locator, name: string) {
  const link = from.locator(`[data-chat-answer-use="${name}"]`).first(), href = await link.getAttribute('href');
  assert(href?.startsWith('#'), `${name}: local dependency must name its destination`);
  await link.click();
  const support = page!.locator(`[id="${href.slice(1)}"]`);
  await support.waitFor();
  assert.equal(await support.evaluate(node => node instanceof HTMLDetailsElement && node.open), true, `${name}: helper opens`);
  assert.equal(await support.evaluate(node => node === document.activeElement), true, `${name}: focus reaches the linked helper`);
  await support.locator(':scope > summary').scrollIntoViewIfNeeded();
  return support;
}
const mathPattern = /\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/gu;
const plain = (text: string) => text.replace(/`([^`]*)`/gu, '$1').replace(/\*\*([^*]+)\*\*/gu, '$1').replace(/\s+/gu, ' ').trim();
/** Check narrative fragments and every TeX source without flattening a Markdown table into paragraphs. */
async function checkMessage(content: Locator, markdown: string, label: string) {
  await content.waitFor();
  await content.evaluate(async node => {
    while ([...node.querySelectorAll<HTMLElement>('.math')].some(formula => formula.dataset.mathState === 'loading'))
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  const formulas = [...markdown.matchAll(mathPattern)].map(match => match[1] ?? match[2] ?? match[3] ?? match[4]);
  assert.deepEqual(await content.locator('.math').evaluateAll(nodes => nodes.map(node => node.getAttribute('title'))), formulas, `${label}: all formula sources survive`);
  assert.deepEqual(await content.locator('.math').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-math-state'))), formulas.map(() => 'ready'), `${label}: all formulas render`);
  const rendered = plain(await content.innerText());
  for (const block of markdown.trim().split(/\n\s*\n/gu)) {
    if (/^\s*\|/u.test(block)) continue;
    for (const fragment of block.replace(mathPattern, '\u0000').split('\u0000').map(plain).filter(Boolean))
      assert(rendered.includes(fragment), `${label}: missing narrative fragment ${fragment}`);
  }
  assert.doesNotMatch(rendered, /\\u[0-9a-f]{4}/iu);
}
async function checkMappingTable(content: Locator, label: string) {
  const tables = content.locator('.chat-markdown-table > table');
  assert.equal(await tables.count(), 1, `${label}: exactly one mapping table`);
  const table = tables.first(), wrapper = content.locator('.chat-markdown-table');
  assert.equal(await table.locator('thead th').count(), 2, `${label}: two columns`);
  assert.deepEqual(await table.locator('tbody tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent?.trim()))), mapping, `${label}: all ten n and h(n) values`);
  await wrapper.evaluate(node => node.scrollIntoView({ block: 'start' }));
  assert.equal(await table.isVisible(), true, `${label}: table is displayed`);
  assert.equal(await wrapper.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, `${label}: both columns fit`);
  assert.equal(await table.locator('th,td').evaluateAll(cells => cells.every(cell => {
    const box = cell.getBoundingClientRect(), style = getComputedStyle(cell);
    return box.width > 0 && box.height > 0 && Number.parseFloat(style.fontSize) >= 12;
  })), true, `${label}: cells have readable dimensions and type`);
}
try {
  browser = await startBrowser(service.server, port);
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  // The mathematical progress block and the output buttons of a running proof are the 详细 reading; 简洁 shows them in the workspace.
  await preferFullCollaboration(context);
  context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0); await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  await context.addInitScript(key => {
    localStorage.setItem(key, 'zh');
  }, localeStorageKey);
  await context.route(/^https?:\/\//u, async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
    if (url.pathname.startsWith('/api/')) requests.push({ method: request.method(), pathname: url.pathname });
    if (runId && request.method() === 'GET' && url.pathname === `/api/runs/${runId}/explanations`) {
      const value: WebExplanationOverview = { run: { id: runId, title: `${title}（本地模拟）`, environment: 'mathlib', providerId: 'sub2api', model: 'local-fixture', effort: 'high', proof },
        targets: [{ name: target, declarations: demoExplanation.sections.length }], explanations: [explanation()], generation: { available: false, reason: 'runtime' } };
      await route.fulfill({ json: value }); return;
    }
    if (runId && request.method() === 'GET' && url.pathname === `/api/runs/${runId}/explanations/item`) {
      assert(explanationReady); assert.equal(url.searchParams.get('target'), target);
      await route.fulfill({ json: { explanation: explanation() } }); return;
    }
    await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0); page.on('pageerror', error => errors.push(error.message));
  phase = '输入自定义康托–伯恩斯坦原题'; await page.goto(origin); await page.locator('#formalize-original').waitFor();
  await page.locator('#formalize-original').fill(demoOriginal);
  assert.equal(await page.locator('#formalize-original').inputValue(), demoOriginal);
  assert.equal(requests.filter(request => request.method === 'POST').length, 0);
  await shot('01-cantor-bernstein-natural-statement.png');
  mark('从自然语言输入框填写完整自定义原题，保留任意类型及双向单射假设');

  phase = '粘贴自身 Lean 声明'; await showChat(page);
  await page.locator('#environment').selectOption('mathlib'); await page.locator('#source').fill(demoSource); await page.locator('#task').fill(task);
  assert.equal(await page.locator('#source').inputValue(), demoSource); assert.equal(await page.locator('#task').inputValue(), task);
  assert.equal(await page.locator('#environment').inputValue(), 'mathlib');
  await withSettings(page, async () => {
    await page.locator('#api-key').fill('local-cantor-bernstein-demo-not-a-real-key'); await page.locator('#model').fill('local-fixture');
    for (const selector of ['#max-seconds', '#max-tokens', '#max-turns']) { await page.locator(selector).fill(''); assert.equal(await page.locator(selector).inputValue(), ''); }
    await shot('02-cantor-bernstein-unlimited-settings.png');
  });
  await page.locator('#submit-run:enabled').click(); await eventually(() => runs.length === 1);
  await page.waitForURL(url => url.searchParams.has('chat')); const run = runs[0];
  assert.equal(run.input.input.source, demoSource.trim()); assert.equal(run.input.input.task, task); assert.equal(run.input.input.environment, 'mathlib');
  assert.equal(run.input.formalization, undefined);
  for (const key of ['maxRunSeconds', 'maxTotalTokens', 'maxTurns'] as const) assert.equal(run.input.input[key], 0);
  mark('真实本地接口收到自定义声明及完整中文原题，只启动一次证明，时间、Token、轮次不限');

  phase = '递归集合与分段映射候选';
  await page.locator('[data-research-artifact="source"]:enabled').waitFor(); await page.locator('[data-research-artifact="source"]').click();
  await page.locator('#detail-panel[data-tab="source"]').waitFor();
  assert.equal((await page.locator('#detail-panel .code-scroll code').innerText()).trim(), candidate.trim());
  assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false');
  await shot('03-recursive-sets-and-helpers.png'); await page.locator('#close-research-output').click();
  mark('中间候选包含递归集合、补集逆像与分段映射辅助声明，主目标未完成时尚未验收');

  phase = '单射与满射候选';
  run.send({ type: 'progress', event: 'turn_started', message: '本地模拟：第 2 轮，分别证明分段映射单射和满射', details: { workerId: 'solver', turn: 2 } });
  run.send({ type: 'artifact', artifact: { source: proof, workerId: 'solver', capturedAt: new Date().toISOString(), status: 'candidate' } });
  run.send({ type: 'action', action: { workerId: 'solver', itemId: 'cantor-bernstein-bijection', phase: 'completed', kind: 'message', status: 'done',
    text: '本地模拟：按 good 与补集分情况证明 h 单射，再对 g(b) 是否属于 good 分情况证明满射。完整候选由测试预先提供，未执行 Lean。' } });
  await page.locator('[data-research-artifact="source"]').click();
  await page.waitForFunction(expected => document.querySelector('#detail-panel .code-scroll code')?.textContent?.trim() === expected.trim(), proof);
  assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false');
  await shot('04-complete-bijection-candidate.png'); await page.locator('#close-research-output').click();
  mark('完整双射候选更新后即可阅读，候选完成与验收通过仍是不同状态');
  run.send({ type: 'progress', event: 'evaluation_started', message: '本地模拟：最终检查' });
  run.send({ type: 'result', result: { status: 'evaluated_passed', proof, report: { status: 'evaluated_passed', fixture: true, realModelCalls: 0, realLeanProcesses: 0 } } }); run.resolve();
  await page.locator('.research-conversation-status[data-accepted="true"]').waitFor(); await page.locator('.chat-answer-generation').waitFor();
  phase = '后台讲解与代码导出'; await shot('05-explanation-background.png');
  await page.locator('[data-research-artifact="source"]').click(); await page.locator('#detail-panel[data-tab="source"]').waitFor();
  await page.locator('#detail-panel [data-action="copy-source"]').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), proof);
  const download = page.waitForEvent('download', { timeout: 0 }); await page.locator('#detail-panel [data-action="download-proof"]').click();
  await (await download).saveAs(path.join(output, 'CantorBernsteinDemo.lean'));
  assert.equal(await fs.readFile(path.join(output, 'CantorBernsteinDemo.lean'), 'utf8'), proof);
  assert.doesNotMatch(proof, /\bsorry\b/u); await page.locator('#close-research-output').click();
  mark('详细讲解后台处理时可复制下载完整候选，显示、剪贴板与 Lean 文件逐字一致');

  phase = '主证明与多层辅助引理'; explanationReady = true; await page.locator('[data-chat-answer-refresh]').click();
  const answer = page.locator(`[data-chat-answer-document="${target}"]`), main = answer.locator(`[data-chat-answer-target="${target}"]`);
  await answer.waitFor(); assert.equal(await main.locator('.chat-answer-steps > li').count(), mainSection.steps.length);
  assert.doesNotMatch(await answer.innerText(), /\\u[0-9a-f]{4}/iu);
  await main.locator('.math[data-math-state="ready"]').first().waitFor();
  await main.evaluate(node => node.scrollIntoView({ block: 'start' })); await shot('06-main-proof-start.png');
  await main.locator('.chat-answer-steps > li').last().scrollIntoViewIfNeeded(); await shot('07-main-proof-conclusion.png');
  const helper = await openHelper(main, helperName); await shot('08-piecewise-helper.png');
  const nestedHelper = await openHelper(helper, nestedHelperName); await shot('09-helper-local-dependency.png');
  assert.notEqual(await helper.getAttribute('id'), await nestedHelper.getAttribute('id'));
  assert.equal(await helper.evaluate(node => (node as HTMLDetailsElement).open), true);
  mark('从主证明进入分段映射引理，再沿引理内依赖定位另一个辅助声明；多项展开仍定位和聚焦正确');

  phase = '自然数构造与映射表追问';
  await page.locator('#formalize-original').fill(demoQuestion);
  if (!await page.locator('#formalize-key').isVisible()) await clickWorkbenchAction(page, '#open-settings');
  await page.locator('#formalize-key').fill('local-cantor-bernstein-demo-not-a-real-key');
  await page.locator('#formalize-start:enabled').click(); await eventually(() => Boolean(reply)); reply!.delta(answerStart);
  await page.waitForFunction(() => document.querySelector('#research-chat-thread')?.textContent?.includes('【本地模拟回答】'));
  await shot('10-concrete-example-streaming.png'); reply!.delta(demoAnswer); reply!.finish(); await page.locator('#chat-stop').waitFor({ state: 'hidden' });
  const chatId = new URL(page.url()).searchParams.get('chat')!;
  const conversation = await page.evaluate(async id => (await (await fetch(`/api/conversations/${id}`)).json()).conversation, chatId);
  const savedAnswer = conversation.messages.at(-1), savedQuestion = conversation.messages.find((message: { id: string }) => message.id === savedAnswer.replyTo);
  assert.equal(savedAnswer.text, fullAnswer); assert.equal(savedAnswer.status, 'complete'); assert.equal(savedQuestion.text, demoQuestion);
  assert.equal(runs.length, 1); assert.equal(providerCalls.length, 1); assert.equal(providerCalls[0].max_output_tokens, undefined);
  const input = providerCalls[0].input as { role: string; content: { text: string }[] }[];
  assert.equal(input.length, 1); assert.equal(input[0].role, 'user');
  const prefix = 'Recorded task context:\n', separator = '\n\nQuestion: ', sent = input[0].content[0].text;
  assert(sent.startsWith(prefix)); const split = sent.indexOf(separator);
  assert(split > prefix.length); assert.equal(sent.slice(split + separator.length), demoQuestion);
  const sentContext = JSON.parse(sent.slice(prefix.length, split));
  assert(sentContext.original.includes(demoOriginal)); assert.equal(sentContext.run.source, demoSource.trim());
  assert.equal(sentContext.run.task, task); assert.equal(sentContext.run.proof, proof);
  const questionContent = page.locator(`[data-message-id="${savedQuestion.id}"] .chat-message-content`);
  const answerContent = page.locator(`[data-message-id="${savedAnswer.id}"][data-message-status="complete"] .chat-message-content`);
  await checkMessage(questionContent, demoQuestion, 'desktop question'); await checkMessage(answerContent, fullAnswer, 'desktop answer');
  await answerContent.evaluate(node => node.scrollIntoView({ block: 'start' })); await shot('11-natural-number-explanation.png');
  await checkMappingTable(answerContent, 'desktop'); await shot('12-desktop-ten-value-table.png');
  mark('追问保留原题、声明、任务要求和完整证明上下文，流式展示具体构造及前十个像，不重启证明');
  mark('桌面映射表有两列十行，n=0..9 与 h(n)=0,2,1,6,3,4,5,14,7,8 逐项一致，文字与公式完整');

  phase = '手机恢复证明与完整问答'; const draft = '若两边都是空集，这个构造和分段双射仍然适用吗？';
  await page.locator('#formalize-original').fill(draft); await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
  await page.locator(`[data-chat-answer-document="${target}"]`).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('chat'), chatId); assert.equal(await page.locator('#formalize-original').inputValue(), draft);
  const restoredConversation = await page.evaluate(async id => (await (await fetch(`/api/conversations/${id}`)).json()).conversation, chatId);
  assert.equal(restoredConversation.messages.find((message: { id: string }) => message.id === savedQuestion.id).text, demoQuestion);
  assert.equal(restoredConversation.messages.find((message: { id: string }) => message.id === savedAnswer.id).text, fullAnswer);
  await checkMessage(questionContent, demoQuestion, 'mobile restored question'); await checkMessage(answerContent, fullAnswer, 'mobile restored answer');
  assert.equal(await page.locator('#formalize-key').inputValue(), '');
  await answerContent.evaluate(node => node.scrollIntoView({ block: 'start' })); await shot('13-mobile-restored-answer.png');
  await checkMappingTable(answerContent, 'mobile'); await shot('14-mobile-ten-value-table.png');
  await main.evaluate(node => node.scrollIntoView({ block: 'start' })); await shot('15-mobile-main-proof-start.png');
  await main.locator('.chat-answer-steps > li').last().scrollIntoViewIfNeeded(); await shot('16-mobile-main-proof-conclusion.png');
  const mobileHelper = await openHelper(main, helperName); await shot('17-mobile-piecewise-helper.png');
  const mobileNested = await openHelper(mobileHelper, nestedHelperName); await shot('18-mobile-helper-local-dependency.png');
  assert.notEqual(await mobileHelper.getAttribute('id'), await mobileNested.getAttribute('id'));
  assert.equal(await mobileHelper.evaluate(node => (node as HTMLDetailsElement).open), true);
  mark('390px 手机刷新恢复完整问答、全部公式、十行映射表和草稿，表格两列可读，多层引理链接仍正确');
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(forbiddenCalls, []);
  assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/runs').length, 1);
  assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/formalizations').length, 0);
  assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === `/api/conversations/${chatId}/messages`).length, 1);
} catch (error) { failure = error; await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 0 }).catch(() => {}); }
finally {
  for (const run of runs) run.resolve(); reply?.finish(); await context?.tracing.stop({ path: path.join(output, 'trace.zip') });
  await browser?.close(); await service.close(); provider.stop(true); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    problem: { id: 'cantor-bernstein-custom', title, original: demoOriginal, target, task },
    mode: 'Real local app and HTTP submission through a manually entered custom Lean declaration; staged synthetic runner, explanation and streaming follow-up.',
    evidenceBoundary: 'This tests the harder problem after pasting its own Lean statement. It does not test automatic natural-language formalization. The proof source is an uncompiled candidate; completion and approval statuses are synthetic, not new acceptance evidence.',
    checks, screenshots, requests, errors, external, forbiddenCalls, formalizationCalls: 0, proofCalls: runs.length, localProviderCalls: providerCalls.length,
    realModelCalls: 0, realLeanProcesses: 0, executionDeadline: null, tokenLimit: null, roundLimit: null, browserTimeouts: 0, fixtureDataRemoved: true,
    mapping: mapping.map(([n, value]) => ({ n: Number(n), h: Number(value) })), helperChain: [target, helperName, nestedHelperName],
    ...(failure ? { failedPhase: phase, error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2) + '\n');
}
if (failure) throw failure;
console.log(JSON.stringify({ status: 'passed', checks: checks.length, screenshots: screenshots.length, output }));
