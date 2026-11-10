#!/usr/bin/env bun
// Full built application + local API replay. No model, Lean, task, token or elapsed-time budget is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import type { WebConversation } from '../apps/web/conversationTypes';
import { webFormalizationDefaults, webFormalizationLimits, type WebFormalization,
  type WebFormalizationActivity, type WebFormalizationBackgroundReview, type WebFormalizationCapabilities,
  type WebFormalizationStep } from '../apps/web/formalizationTypes';
import { localeStorageKey } from '../apps/web/i18n';
import { createWebService } from '../apps/web/server';
import { webLimits, type WebAgentActionBody, type WebFormalizationReport, type WebSession } from '../apps/web/shared';
import { audit } from './web-a11y';
import { freePort, settled } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'out/web-formalization-progress');
const original = `伽罗瓦根式可解性判别定理（Galois's Solvability Criterion）

设 K 是特征为 0 的域，f(x)∈K[x] 是次数至少为 1 的多项式。设 L 为 f(x) 在 K 上的分裂域，G=Gal(L/K)。

定义 f(x) 在 K 上根式可解，当且仅当存在有限域扩张塔
K=K_0⊆K_1⊆⋯⊆K_m，
其中对每个 i=1,…,m，存在 α_i∈K_i 和正整数 n_i，使得
K_i=K_{i−1}(α_i)，且 α_i^{n_i}∈K_{i−1}，
并且 L⊆K_m。

证明：
f(x) 在 K 上根式可解，当且仅当 G 是可解群。

这里，可解群是指存在有限次正规子群列
G=G_0 ▹ G_1 ▹ ⋯ ▹ G_r={e}，
使得每个商群 G_i/G_{i+1} 均为阿贝尔群。

证明要求：
严格证明必要性与充分性两个方向。
处理根式扩张不一定是伽罗瓦扩张的问题。
解释引入单位根和正规闭包的必要性，并证明关键步骤。
可以使用域论基础定理和伽罗瓦理论基本定理，但不得直接引用待证定理或其等价形式。
所有辅助引理必须明确陈述并证明，或准确说明所引用的独立经典定理。
给出逻辑完整、无循环论证的证明。`;
const header = `import Mathlib
-- UI fixture only: source and compiler events are replayed.
-- No Lean or model process runs. This is NOT a proof of Galois's criterion.
`;
const source1 = `${header}theorem ui_fixture_only : True := by
  exact (0 : Nat)
`;
const source2 = `${header}-- UI fixture revision: synthetic statement placeholder, not mathematical evidence.
theorem ui_fixture_only : True := by
  sorry
`;
const diagnostic = 'UI fixture diagnostic only: expected True; received Nat. No Lean process ran.';
const diagnosticExtra = 'UI fixture second error: a synthetic declaration is missing.\nEvery error remains readable, including this final line: UI_FIXTURE_ERROR_TAIL.';
const diagnosticWarning = 'UI fixture warning only: synthetic unused variable.\nUI_FIXTURE_WARNING_TAIL';
const diagnosticInfo = 'UI fixture information only: synthetic elaborator trace.\nUI_FIXTURE_INFO_TAIL';
const compilerFeedback = 'UI fixture host feedback only: revise the replayed errors before the next synthetic check.\nUI_FIXTURE_HOST_FEEDBACK_TAIL';
const longSummaryTail = 'UI_FIXTURE_FULL_SAVED_SUMMARY_TAIL';
const longSummary = Array.from({ length: 100 }, (_, index) =>
  `Saved public summary paragraph ${index + 1}: this is a synthetic progress record for reading a long saved summary in full. No model reasoning or mathematical proof is supplied.`
).join('\n\n') + `\n\n${longSummaryTail}`;
const toolOutput = Array.from({ length: 30 }, (_, index) => `Synthetic tool output ${index + 1}: a recorded search result, with no actual tool invocation.`).join('\n')
  + '\nUI_FIXTURE_TOOL_OUTPUT_TAIL';
const fileDiff = '@@ -1,2 +1,3 @@\n import Mathlib\n--- synthetic old comment\n+-- UI fixture file change only\n+-- UI_FIXTURE_FILE_DIFF_TAIL';
const reviewSummary = 'UI fixture only: synthetic background review requested changes; this is not a mathematical assessment.';
const model = 'gpt-6.1-sol';
const evidenceSha256 = 'a'.repeat(64), sourceSha256 = 'b'.repeat(64);
const at = new Date().toISOString();
const provider = { id: 'fixture', name: 'UI fixture · no model / Lean', baseUrl: 'https://fixture.invalid' };
const capabilities: WebFormalizationCapabilities = {
  available: true, model, providerId: provider.id, key: 'server', limits: webFormalizationLimits,
  defaults: webFormalizationDefaults, providers: [{ ...provider, defaultModel: model, key: 'server' }],
};
const session: WebSession = {
  draftOwner: 'formalization-progress-ui-fixture', csrfToken: 'ui-fixture-csrf', auth: 'none', providers: [provider],
  environments: [{ id: 'mathlib', name: 'Mathlib · UI fixture', description: 'UI fixture; no Lean execution',
    toolchain: 'leanprover/lean4:v4.33.0' }], templates: [],
  defaults: { model, effort: 'max', maxTurns: 0, maxRunSeconds: 0, workers: 1, coordination: 'cooperative', environment: 'mathlib' },
  limits: webLimits, runtime: { ready: true, message: 'UI fixture only; no model or Lean execution' },
  runs: { runs: [], version: 'ui-fixture' },
};
function background(status: WebFormalizationBackgroundReview['status'], updatedAt: string): WebFormalizationBackgroundReview {
  return { status, evidenceSha256, sourceSha256, queuedAt: updatedAt, startedAt: updatedAt,
    ...(status === 'changes_requested' ? { finishedAt: updatedAt, result: {
      schema: 'theorem-os.formalization-audit.v1', evidenceSha256, sourceSha256, snapshotDigest: 'c'.repeat(64),
      originalSha256: 'd'.repeat(64), environmentDigest: 'e'.repeat(64), model, effort: 'max', startedAt: updatedAt, finishedAt: updatedAt,
      session: { threadId: 'independent-ui-fixture', turnId: 'review-turn', status: 'completed',
        inputDigest: 'f'.repeat(64), outputDigest: '1'.repeat(64), usage: {} },
      review: { verdict: 'changes_requested', summary: reviewSummary,
        checks: { domains: false, assumptions: false, conclusions: false, definitions: false, quantifierScope: false, instanceCoherence: false },
        issues: [{ aspect: 'conclusions', originalFragment: 'f(x) 在 K 上根式可解，当且仅当 G 是可解群。',
          leanFragment: 'theorem ui_fixture_only : True', explanation: reviewSummary }] },
    } } : {}),
  };
}
function report(review: WebFormalizationBackgroundReview, updatedAt: string): WebFormalizationReport {
  return { schema: 'theorem-os.web-formalization-report.v1', problemId: 'galois-ui-fixture', original, statement: source2,
    environment: 'mathlib', toolchain: 'leanprover/lean4:v4.33.0', mathlibRevision: null, model, effort: 'max', rounds: 2,
    targets: [{ name: 'ui_fixture_only', lines: { start: 5, end: 7 } }], correspondences: [], coverage: [], backtranslation: null,
    reviews: [], semanticReview: 'not-performed', evidenceSha256, approvedAt: updatedAt, backgroundReview: review };
}
type Step = 'prepare' | 'write' | 'compile' | 'ready';
const steps: Step[] = ['prepare', 'write', 'compile', 'ready'];
const descriptions = {
  zh: {
    queued: '任务已排队，开始后会在这里更新进度。',
    preparing: '正在准备 Lean 与数学库，随后开始编写陈述。',
    generating: '正在把原题中的对象、条件和结论写成 Lean 陈述。',
    compiling: '陈述已生成，正在用 Lean 检查类型、定义和语法。',
    revising: 'Lean 检查未通过，正在根据报错修改陈述。',
    saving: 'Lean 编译通过，正在保存代码与检查记录。',
    ready: 'Lean 陈述已可查看和下载，可以继续证明。',
    background: '代码已可使用，审核在后台同步进行。',
  },
  en: {
    queued: 'The task is queued. Progress will appear here when it starts.',
    preparing: 'Preparing Lean and the mathematics libraries before writing the statement.',
    generating: 'Writing the objects, assumptions and conclusions of the problem as a Lean statement.',
    compiling: 'The statement is written. Lean is checking its types, definitions and syntax.',
    revising: 'The Lean check failed. The statement is being revised using the errors.',
    saving: 'Lean compilation passed. Saving the code and check records.',
    ready: 'The Lean statement is ready to view and download. You can continue with the proof.',
    background: 'The code is ready to use. Review continues in the background.',
  },
};
const thoughts = {
  zh: {
    first: '**核对对象范围**\n先核对域、分裂域与自同构群的对象范围。',
    expanded: '**核对对象范围**\n先核对域、分裂域与自同构群的对象范围。确认特征为零及有限扩张的条件会写进 Lean 陈述。',
    search: '**检索已有定义**\n正在检索分裂域与群可解性的已有定义，整理原题使用的对象和条件。',
    searchTitle: '检索已有定义',
    commentary: '对象与条件已整理，正在生成 Lean 陈述并提交编译检查。',
  },
  en: {
    first: '**Check the objects**\nCheck the domains of the field, splitting field and automorphism group.',
    expanded: '**Check the objects**\nCheck the domains of the field, splitting field and automorphism group. Include the characteristic-zero and finite-extension assumptions in the Lean statement.',
    search: '**Find existing definitions**\nLook up the existing definitions of splitting fields and solvable groups, then organize the objects and assumptions from the problem.',
    searchTitle: 'Find existing definitions',
    commentary: 'The objects and assumptions are organized. The Lean statement is being written and submitted for compilation.',
  },
};
const hiddenReasoning = 'UI_FIXTURE_UNLABELLED_REASONING_MUST_NOT_APPEAR_IN_THINKING';
const finalPayload = 'UI_FIXTURE_FINAL_JSON_MUST_NOT_APPEAR_IN_THINKING';

await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-formalization-progress-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const runtimeCalls: string[] = [];
const neverRun = (name: string): never => { runtimeCalls.push(name); throw new Error(`UI replay must not run ${name}`); };
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: path.join(temporary, 'data') }), {
  async readiness() { return { ready: true, message: 'Browser fixture only' }; },
  async run() { neverRun('proof runner'); },
  async formalize() { neverRun('formalization runner'); },
}, { sample: null });
let browser: Browser | undefined, activePage: Page | undefined, activeContext: BrowserContext | undefined;
let scenario = '', stage = '';
const checks: object[] = [], errors: string[] = [], writes: string[] = [], external: string[] = [], unexpectedApi: string[] = [];
const screenshots: string[] = [];
try {
  await fs.access(path.join(root, 'out/web/app.js'));
  await new Promise<void>((resolve, reject) => {
    service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolve);
  });
  browser = await chromium.launch({ headless: true, timeout: 0, env: { ...process.env, LANG: 'zh_CN.UTF-8' } });
  for (const [locale, width] of [['zh', 1440], ['zh', 390], ['en', 390]] as const) {
    scenario = `${locale}-${width}`;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce',
      locale: locale === 'zh' ? 'zh-CN' : 'en-US', acceptDownloads: true });
    activeContext = context;
    context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
    await context.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [localeStorageKey, locale]);
    const page = await context.newPage(); activePage = page;
    page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0);
    page.on('pageerror', error => errors.push(`${scenario}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${scenario}: ${message.text()}`); });
    const item: WebFormalization = { id: '11111111-1111-4111-8111-111111111111', original, environment: 'mathlib',
      model, effort: 'max', reviewMode: 'direct', status: 'queued', createdAt: at, updatedAt: at,
      maxRunSeconds: 0, maxTotalTokens: 0, research: { maxRunSeconds: 0, maxTurns: 0, maxTotalTokens: 0 },
      progress: { phase: 'queued' }, activity: { count: 0 } };
    const conversation: WebConversation = {
      id: '22222222-2222-4222-8222-222222222222', title: 'Galois criterion · UI fixture (no model / Lean)',
      createdAt: at, updatedAt: at, formalizationId: item.id, messages: [
        { id: 'question', role: 'user', kind: 'text', text: original, createdAt: at, status: 'complete' },
        { id: 'task', role: 'assistant', kind: 'task', text: '', createdAt: at, status: 'complete' },
      ],
    };
    const rootScrollHeights: { screen: string; rootHeight: number; viewportHeight: number }[] = [];
    const activity: WebFormalizationActivity[] = [];
    let revision = 0, detailReads = 0, readUpdated: (() => void) | undefined;
    let updatedRead = Promise.resolve();
    const append = (step: WebFormalizationStep) => activity.push({ type: 'step', sequence: activity.length + 1, at: item.updatedAt, step });
    const appendAction = (action: WebAgentActionBody) => {
      activity.push({ type: 'action', sequence: activity.length + 1, at: item.updatedAt, action });
      item.activity = { count: activity.length };
    };
    const summary = (itemId: string, text: string, completed = false) => appendAction({ workerId: 'r1-generate', itemId,
      kind: 'reasoning', textSource: 'summary', phase: completed ? 'completed' : 'started', status: completed ? 'done' : 'running', text });
    const update = (phase: NonNullable<WebFormalization['progress']>['phase'], events: WebFormalizationStep[] = []) => {
      updatedRead = new Promise<void>(resolve => { readUpdated = resolve; });
      item.updatedAt = new Date(Date.parse(at) + ++revision * 1000).toISOString(); conversation.updatedAt = item.updatedAt;
      item.status = 'running'; item.progress = { phase, round: phase === 'queued' || phase === 'preparing' ? undefined
        : events.find(event => event.round === 2)?.round ?? item.progress?.round ?? 1 };
      events.forEach(append); item.activity = { count: activity.length };
    };
    await context.route(/^https?:\/\//u, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
      if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
      if (request.method() !== 'GET') {
        writes.push(`${request.method()} ${url.pathname}`);
        await route.fulfill({ status: 422, json: { error: 'Read-only UI fixture; no runtime commands' } }); return;
      }
      const json = (body: unknown) => route.fulfill({ json: body });
      if (url.pathname === '/api/session') return json(session);
      if (url.pathname === '/api/runs') return json({ runs: [], version: 'ui-fixture' });
      if (url.pathname === '/api/runs/stream') {
        await route.fulfill({ status: 204, contentType: 'text/event-stream' }); return;
      }
      if (url.pathname === '/api/formalizations') return json({ formalizations: [{ ...item, report: undefined }], generation: capabilities });
      if (url.pathname === `/api/formalizations/${item.id}`) {
        detailReads++; const sentRevision = revision;
        await json({ formalization: item });
        if (sentRevision === revision) readUpdated?.();
        return;
      }
      if (url.pathname === `/api/formalizations/${item.id}/activity`)
        return json({ activity: activity.filter(entry => entry.sequence > Number(url.searchParams.get('after') ?? 0)), dropped: 0 });
      if (url.pathname === '/api/conversations') {
        const { messages: _messages, ...summary } = conversation;
        return json({ conversations: [{ ...summary, answering: false }] });
      }
      if (url.pathname === `/api/conversations/${conversation.id}`) return json({ conversation });
      unexpectedApi.push(url.pathname);
      await route.fulfill({ status: 500, json: { error: `Unexpected UI fixture request: ${url.pathname}` } });
    });
    const progress = page.locator('#research-chat-thread [data-formalization-progress]');
    const description = page.locator('#research-chat-thread .research-conversation-description');
    const download = page.locator('#research-chat-thread [data-download-statement]');
    const thinking = page.locator('#research-chat-thread [data-thinking-process]');
    const expectThought = async (text: string) => {
      await page.waitForFunction(expected => {
        const section = document.querySelector('#research-chat-thread [data-thinking-process]');
        return section?.textContent?.includes(expected);
      }, text);
      assert.equal(await thinking.locator('[data-thinking-entry="formalize:r1-generate:public-summary-1"]').count(), 1,
        'Streaming snapshots replace one public summary instead of duplicating it');
      assert.ok(!(await thinking.innerText()).includes(hiddenReasoning));
      assert.ok(!(await thinking.innerText()).includes(finalPayload));
    };
    const expectProgress = async (current: Step | undefined, label: keyof typeof descriptions.zh) => {
      await updatedRead;
      await page.waitForFunction(({ current, steps, expectedDescription }) => {
        const root = document.querySelector('#research-chat-thread [data-formalization-progress]');
        if (!root || document.querySelector('#research-chat-thread .research-conversation-description')?.textContent !== expectedDescription) return false;
        const position = current ? steps.indexOf(current) : steps.length;
        return steps.every((id, index) => {
          const element = root.querySelector(`[data-formalization-step="${id}"]`);
          return element?.getAttribute('data-tone') === (index < position ? 'done' : index === position ? 'active' : 'pending')
            && element?.getAttribute('aria-current') === (index === position ? 'step' : null);
        });
      }, { current, steps, expectedDescription: descriptions[locale][label] });
      assert.equal(await progress.locator('[data-formalization-step]').count(), 4);
      assert.equal(await description.innerText(), descriptions[locale][label]);
      assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false');
    };
    const capture = async (name: string, accessible = false) => {
      stage = name;
      await progress.scrollIntoViewIfNeeded(); await settled(page);
      if (width > 1100) await page.locator('#research-chat-thread .chat-task').evaluate(node => {
        node.scrollIntoView({ block: 'start', behavior: 'instant' });
      });
      if (name === 'thinking-all-diagnostics') {
        await thinking.locator('[data-thinking-kind="check"][data-tone="failed"] .thinking-check-head').evaluate(node => {
          node.scrollIntoView({ block: 'start', behavior: 'instant' });
        });
      }
      await page.mouse.move(0, 0);
      await settled(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${scenario}/${name}: horizontal overflow`);
      const vertical = await page.evaluate(() => ({ rootHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight }));
      rootScrollHeights.push({ screen: name, ...vertical });
      if (name.startsWith('thinking-')) assert.ok(vertical.rootHeight <= vertical.viewportHeight * 2,
        `${scenario}/${name}: long thinking records must stay inside their scroll container instead of extending the root scroll area: ${JSON.stringify(vertical)}`);
      if (accessible) assert.deepEqual(await audit(page), [], `${scenario}/${name}: accessibility`);
      const file = `${scenario}-${name}.png`; screenshots.push(file);
      await page.screenshot({ path: path.join(output, file), fullPage: true, timeout: 0 });
      console.log(`PASS ${scenario}: ${name}`);
    };
    const sourceVisible = async (source: string) => {
      const entry = progress.locator('[data-formalization-code]'); await entry.waitFor();
      if (width > 1100) {
        if (await page.locator('#close-research-output').isVisible()) await page.locator('#close-research-output').click();
        await entry.click();
        await page.locator('body[data-chat-artifact="live"]').waitFor();
        await page.locator('#chat-live-panel .live-code').waitFor();
        const text = await page.locator('#chat-live-panel .live-code').innerText();
        assert.ok(text.includes('UI fixture only: source and compiler events are replayed.'));
        assert.ok(text.includes(source === source1 ? 'exact (0 : Nat)' : 'synthetic statement placeholder'));
      } else {
        const details = progress.locator('details.formalization-current-code');
        if (!await details.evaluate(node => (node as HTMLDetailsElement).open)) await entry.click();
        assert.equal(await details.locator('pre code').textContent(), source);
        assert.equal(await details.locator('pre').isVisible(), true);
      }
    };
    const downloaded = async () => {
      const received = page.waitForEvent('download', { timeout: 0 }); await download.click();
      const file = await received;
      assert.match(file.suggestedFilename(), /\.lean$/u);
      assert.equal(await fs.readFile((await file.path())!, 'utf8'), source2);
    };

    stage = 'queued';
    await page.goto(`${origin}/?chat=${conversation.id}`, { timeout: 0 });
    await expectProgress('prepare', 'queued');
    assert.equal(await progress.locator('[data-formalization-code]').count(), 0);
    assert.equal(await thinking.locator('[data-thinking-entry]').count(), 0, 'No summary or code is invented while the task is queued');
    assert.equal(await page.locator('details.solve-process').getAttribute('open'), null, 'Diagnostic records stay folded beside the readable thinking section');
    await capture('queued', true);
    update('preparing'); await expectProgress('prepare', 'preparing'); await capture('preparing');
    update('generating', [{ round: 1, step: 'role', workerId: 'r1-generate', role: 'generate', slot: 'generate', state: 'started' }]);
    summary('public-summary-1', thoughts[locale].first);
    appendAction({ workerId: 'r1-generate', itemId: 'legacy-reasoning', kind: 'reasoning', phase: 'completed', status: 'done', text: hiddenReasoning });
    appendAction({ workerId: 'r1-generate', itemId: 'final-payload', kind: 'message', phase: 'completed', status: 'done', text: JSON.stringify({ fixture: finalPayload }) });
    await expectProgress('write', 'generating');
    await expectThought(thoughts[locale].first.split('\n')[1]!);
    assert.equal(await thinking.getAttribute('open'), '', 'A live task opens its readable public-summary section');
    await capture('generating');
    update('generating'); summary('public-summary-1', thoughts[locale].expanded);
    await expectThought(thoughts[locale].expanded.split('\n')[1]!);
    assert.equal(await thinking.locator('[data-thinking-kind="summary"]').count(), 1);
    await capture('thinking-streaming', true);
    await thinking.locator(':scope > summary').click();
    await page.waitForFunction(() => !document.querySelector('[data-thinking-process]')?.hasAttribute('open'));
    update('generating');
    summary('public-summary-1', thoughts[locale].expanded, true);
    appendAction({ workerId: 'r1-generate', itemId: 'search-definitions', kind: 'command', phase: 'completed', status: 'done',
      command: "theorem-os search-lean --query 'IsSolvable'", found: [{ query: 'IsSolvable', total: 1, names: ['IsSolvable'] }] });
    summary('public-summary-2', thoughts[locale].search);
    await page.waitForFunction(expected => document.querySelector('[data-thinking-process] .thinking-preview')?.textContent === expected,
      thoughts[locale].searchTitle);
    assert.equal(await thinking.getAttribute('open'), null, 'An update preserves the reader\'s folded state');
    await capture('thinking-folded', true);
    if (locale === 'en') {
      // A fresh page has no manual choice, so the completed task should later fold automatically.
      await page.reload({ timeout: 0 }); await expectProgress('write', 'generating');
    } else await thinking.locator(':scope > summary').click();
    await expectThought(thoughts[locale].expanded.split('\n')[1]!);
    assert.ok((await thinking.innerText()).includes(thoughts[locale].search.split('\n')[1]!));
    assert.equal(await thinking.locator('[data-thinking-kind="summary"]').count(), 2);
    assert.equal(await thinking.locator('[data-thinking-kind="action"]').count(), 1);
    assert.equal(await progress.locator('[data-formalization-code]').count(), 0, 'Public progress does not invent a Lean file before one is saved');
    await capture('thinking-history', true);

    stage = 'thinking-expanded-details';
    const searchDetail = thinking.locator('[data-thinking-entry="formalize:r1-generate:search-definitions"] [data-thinking-detail]');
    assert.equal(await searchDetail.evaluate(node => (node as HTMLDetailsElement).open), true, 'Saved tools start expanded');
    assert.ok((await searchDetail.innerText()).includes("theorem-os search-lean --query 'IsSolvable'"));
    update('generating');
    summary('long-public-summary', longSummary);
    appendAction({ workerId: 'r1-generate', itemId: 'long-tool-output', kind: 'command', phase: 'completed', status: 'done',
      command: "theorem-os search-lean --query 'SyntheticLongOutput'", output: toolOutput, exitCode: 0 });
    appendAction({ workerId: 'r1-generate', itemId: 'file-diff', kind: 'edit', phase: 'completed', status: 'done',
      changes: [{ path: 'SyntheticStatement.lean', change: 'update', diff: fileDiff }] });
    await expectThought(longSummaryTail);
    const longEntry = thinking.locator('[data-thinking-entry="formalize:r1-generate:long-public-summary"]');
    assert.ok(longSummary.length > 8_000);
    assert.ok((await longEntry.innerText()).includes(longSummaryTail), 'The full saved public summary stays readable beyond 8k characters');
    const outputDetail = thinking.locator('[data-thinking-entry="formalize:r1-generate:long-tool-output"] [data-thinking-detail]');
    const diffDetail = thinking.locator('[data-thinking-entry="formalize:r1-generate:file-diff"] [data-thinking-detail]');
    await page.waitForFunction(() => {
      const output = document.querySelector('[data-thinking-entry="formalize:r1-generate:long-tool-output"] [data-thinking-detail]');
      const diff = document.querySelector('[data-thinking-entry="formalize:r1-generate:file-diff"] [data-thinking-detail]');
      return output?.hasAttribute('open') && diff?.hasAttribute('open') && diff.textContent?.includes('UI_FIXTURE_FILE_DIFF_TAIL');
    });
    assert.equal(await outputDetail.locator('.route-output').textContent(), toolOutput, 'The complete saved tool output is available');
    assert.ok((await diffDetail.innerText()).includes('SyntheticStatement.lean'));
    assert.ok((await diffDetail.innerText()).includes('UI_FIXTURE_FILE_DIFF_TAIL'));
    await capture('thinking-expanded-details', true);

    await searchDetail.locator(':scope > summary').click();
    await page.waitForFunction(() => !document.querySelector('[data-thinking-entry="formalize:r1-generate:search-definitions"] [data-thinking-detail]')?.hasAttribute('open'));
    update('generating'); summary('long-public-summary', `${longSummary}\n\nUI_FIXTURE_POLLING_UPDATE`);
    await expectThought('UI_FIXTURE_POLLING_UPDATE');
    assert.equal(await searchDetail.evaluate(node => (node as HTMLDetailsElement).open), false, 'One manually folded tool stays folded during polling');
    assert.equal(await outputDetail.evaluate(node => (node as HTMLDetailsElement).open), true, 'Folding one tool leaves other tools expanded');

    await thinking.locator('[data-thinking-options] > summary').click();
    await thinking.locator('[data-thinking-collapse-all]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-thinking-process] [data-thinking-detail]')]
      .every(node => !node.hasAttribute('open')));
    update('generating');
    summary('long-public-summary', `${longSummary}\n\nUI_FIXTURE_DETAILS_STAY_FOLDED`);
    appendAction({ workerId: 'r1-generate', itemId: 'after-collapse', kind: 'command', phase: 'completed', status: 'done',
      command: "theorem-os search-lean --query 'SyntheticAfterCollapse'", output: 'UI_FIXTURE_NEW_TOOL_AFTER_COLLAPSE' });
    await expectThought('UI_FIXTURE_DETAILS_STAY_FOLDED');
    await page.waitForFunction(() => document.querySelector('[data-thinking-entry="formalize:r1-generate:after-collapse"] [data-thinking-detail]'));
    assert.equal(await thinking.locator('[data-thinking-detail][open]').count(), 0, 'Polling and new tools preserve the global folded-details mode');
    await capture('thinking-collapsed-details', true);

    const thinkingBody = thinking.locator('.thinking-body');
    assert.equal(await thinkingBody.evaluate(node => node.scrollHeight > node.clientHeight), true, 'Long saved summaries can be scrolled');
    await settled(page);
    await thinkingBody.evaluate(node => { node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -500 })); node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    await settled(page);
    update('generating'); summary('long-public-summary', `${longSummary}\n\nUI_FIXTURE_SCROLL_UPDATE`, true);
    await expectThought('UI_FIXTURE_SCROLL_UPDATE');
    assert.ok(await thinkingBody.evaluate(node => node.scrollTop <= 2), 'A streaming update preserves the reader\'s position when they scroll up');

    await thinking.locator('[data-thinking-latest]').click();
    await page.waitForFunction(() => document.querySelector('[data-thinking-process]')?.getAttribute('data-thinking-following') === 'true');
    update('generating');
    for (let index = 0; index < 42; index++) summary(`history-${index}`, `Synthetic saved public record ${index + 1}. UI_FIXTURE_HISTORY_${index}`, true);
    await page.waitForFunction(() => document.querySelector('[data-thinking-process]')?.textContent?.includes('UI_FIXTURE_HISTORY_41'));
    assert.equal(await thinking.locator('[data-thinking-entry]').count(), 40, 'Only the latest 40 records mount until older history is requested');
    assert.equal(await thinking.locator('[data-thinking-entry="formalize:r1-generate:public-summary-1"]').count(), 0);
    assert.equal(await thinking.locator('.thinking-earlier').count(), 1, 'Older saved history remains available');
    if (width === 1440) {
      await thinking.locator('.thinking-earlier').click();
      await page.waitForFunction(() => document.querySelector('[data-thinking-entry="formalize:r1-generate:public-summary-1"]'));
      assert.ok(await thinking.locator('[data-thinking-entry]').count() > 40, 'The earlier-history control loads every saved record');
    }
    await thinking.locator('[data-thinking-options] > summary').click();
    await thinking.locator('[data-thinking-expand-all]').click();
    await page.waitForFunction(() => !!document.querySelector('[data-thinking-entry="formalize:r1-generate:public-summary-1"]')
      && [...document.querySelectorAll('[data-thinking-process] [data-thinking-detail]')].every(node => node.hasAttribute('open')));
    await expectThought('UI_FIXTURE_NEW_TOOL_AFTER_COLLAPSE');
    assert.equal(await thinking.locator('.thinking-earlier').count(), 0, 'Expand all includes earlier history');
    assert.ok((await longEntry.innerText()).includes(longSummaryTail));
    update('generating');
    appendAction({ workerId: 'r1-generate', itemId: 'after-expand', kind: 'command', phase: 'completed', status: 'done',
      command: "theorem-os search-lean --query 'SyntheticAfterExpand'", output: 'UI_FIXTURE_NEW_TOOL_AFTER_EXPAND' });
    await expectThought('UI_FIXTURE_NEW_TOOL_AFTER_EXPAND');
    assert.equal(await thinking.locator('[data-thinking-entry="formalize:r1-generate:after-expand"] [data-thinking-detail]').evaluate(node => (node as HTMLDetailsElement).open), true,
      'New tools follow the latest global expanded-details mode');
    await capture('thinking-long-history', true);

    update('compiling', [
      { round: 1, step: 'role', workerId: 'r1-generate', role: 'generate', slot: 'generate', state: 'finished' },
      { round: 1, step: 'compile', state: 'started', source: source1 },
    ]);
    summary('public-summary-2', thoughts[locale].search, true);
    appendAction({ workerId: 'r1-generate', itemId: 'public-commentary', kind: 'message', textSource: 'commentary',
      phase: 'completed', status: 'done', text: thoughts[locale].commentary });
    await expectProgress('compile', 'compiling'); await sourceVisible(source1);
    await page.waitForFunction(expected => document.querySelector('[data-thinking-process]')?.textContent?.includes(expected), thoughts[locale].commentary);
    assert.equal(await download.count(), 0); await capture('compiling', true);
    update('compiling', [{ round: 1, step: 'compile', state: 'failed', text: compilerFeedback,
      lean: { passed: false, messages: [
        { severity: 'error', line: 5, column: 9, text: diagnostic },
        { severity: 'error', line: 6, column: 1, text: diagnosticExtra },
        { severity: 'warning', line: 4, text: diagnosticWarning },
        { severity: 'info', line: 5, text: diagnosticInfo },
      ] } }]);
    await expectProgress('write', 'revising');
    const failedCheck = thinking.locator('[data-thinking-kind="check"][data-tone="failed"] [data-thinking-detail]');
    await page.waitForFunction(() => document.querySelector('[data-thinking-kind="check"][data-tone="failed"] [data-thinking-detail]')?.textContent?.includes('UI_FIXTURE_INFO_TAIL'));
    assert.equal(await failedCheck.evaluate(node => (node as HTMLDetailsElement).open), true, 'Lean check details start expanded');
    const failedCheckText = await failedCheck.innerText();
    for (const message of [diagnostic, diagnosticExtra, diagnosticWarning, diagnosticInfo, compilerFeedback])
      assert.ok(failedCheckText.includes(message), `The thinking check includes all saved details: ${message}`);
    assert.equal(await failedCheck.locator('.thinking-source pre code').textContent(), source1, 'The exact checked source stays available beside the diagnostics');
    assert.equal(await failedCheck.locator('[data-severity="error"]').count(), 2);
    assert.equal(await failedCheck.locator('[data-severity="warning"]').count(), 1);
    assert.equal(await failedCheck.locator('[data-severity="info"]').count(), 1);
    await failedCheck.scrollIntoViewIfNeeded();
    await capture('thinking-all-diagnostics', true);
    assert.equal(await page.locator('#research-chat-thread .research-conversation-state strong').innerText(),
      locale === 'zh' ? '根据 Lean 报错修改陈述' : 'Revising the statement from Lean errors');
    if (width > 1100) await page.locator('#chat-live-panel .lean-mark-row').filter({ hasText: diagnostic }).waitFor();
    else {
      const records = page.locator('details.solve-process');
      if (!await records.evaluate(node => (node as HTMLDetailsElement).open)) await records.locator(':scope > summary').click();
      const row = page.locator('[data-solve-row^="f:compile:"][data-tone="failed"]').first();
      const head = row.locator('.solve-row-head');
      if (await head.getAttribute('aria-expanded') !== 'true') await head.click();
      assert.ok((await row.innerText()).includes(diagnostic));
      const bounds = await row.locator('.route-lean pre').evaluateAll(pres => pres.map(pre => ({
        scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth,
        right: pre.getBoundingClientRect().right,
        rowRight: pre.closest('[data-solve-row]')!.getBoundingClientRect().right,
      })));
      assert.equal(bounds.length, 4);
      assert.ok(bounds.every(entry => entry.scrollWidth <= entry.clientWidth + 1), `${scenario}: Every Lean diagnostic must wrap within its pre: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.every(entry => entry.right <= entry.rowRight + 1), `${scenario}: Every Lean diagnostic must stay within its row: ${JSON.stringify(bounds)}`);
    }
    await capture('failed-revising', true);
    update('generating', [
      { round: 1, step: 'revision', stage: 'round', text: 'UI fixture only: revise the synthetic statement after the replayed diagnostic.' },
      { round: 2, step: 'role', workerId: 'r2-generate', role: 'generate', slot: 'generate', state: 'started' },
    ]);
    await expectProgress('write', 'revising'); await capture('generating-revision');
    update('compiling', [
      { round: 2, step: 'role', workerId: 'r2-generate', role: 'generate', slot: 'generate', state: 'finished' },
      { round: 2, step: 'compile', state: 'started', source: source2 },
    ]);
    await expectProgress('compile', 'compiling'); await sourceVisible(source2); await capture('compiling-revision');
    update('compiling', [{ round: 2, step: 'compile', state: 'passed', lean: { passed: true, messages: [] }, targets: ['ui_fixture_only'] }]);
    await expectProgress('ready', 'saving');
    assert.equal(await download.count(), 0, 'A compiler pass without a saved report cannot be downloaded yet');
    await capture('passed-saving-report', true);
    update('finishing'); item.status = 'confirmed'; item.confirmedAt = item.updatedAt; item.finishedAt = item.updatedAt;
    item.backgroundReview = background('running', item.updatedAt); item.report = report(item.backgroundReview, item.updatedAt);
    await expectProgress(undefined, 'ready');
    assert.equal(await thinking.getAttribute('open'), '', 'Reading and using the history controls keeps the process open across completion');
    await thinking.locator(':scope > summary').click();
    await page.waitForFunction(() => !document.querySelector('[data-thinking-process]')?.hasAttribute('open'));
    const reviewing = page.locator('#research-chat-thread [data-background-review="running"]'); await reviewing.waitFor();
    assert.ok((await reviewing.innerText()).includes(descriptions[locale].background));
    assert.equal(await progress.locator('[data-formalization-code]').count(), 0);
    await downloaded(); await capture('ready-background-running', true);
    const readsBefore = detailReads;
    item.updatedAt = new Date(Date.parse(item.updatedAt) + 1000).toISOString(); conversation.updatedAt = item.updatedAt;
    item.backgroundReview = background('changes_requested', item.updatedAt); item.report.backgroundReview = item.backgroundReview;
    await page.locator('#research-chat-thread [data-background-review="changes_requested"]').waitFor();
    await expectProgress(undefined, 'ready');
    assert.ok((await page.locator('#research-chat-thread [data-background-review]').innerText()).includes(reviewSummary));
    assert.ok(detailReads > readsBefore, 'A confirmed task continues polling while the background review runs');
    await downloaded();
    await page.locator('#formalize-original').fill('UI fixture draft remains editable after background review.');
    assert.equal(await page.locator('#formalize-original').inputValue(), 'UI fixture draft remains editable after background review.');
    await capture('ready-background-changes-requested', true);
    assert.deepEqual(errors, [], 'Browser console and page errors');
    assert.deepEqual(writes, [], 'The UI replay must not send runtime writes');
    assert.deepEqual(external, [], 'Every browser request stays on the local application origin');
    assert.deepEqual(unexpectedApi, [], 'Every API read uses an explicit route fixture');
    assert.deepEqual(runtimeCalls, [], 'Neither a model nor Lean was started');
    checks.push({ scenario, phases: 10, detailReads, downloads: 2, compilerAttempts: 2, compilerFailures: 1,
      noOverflow: true, accessibility: 'passed', sourcePreserved: true, backgroundReviewDoesNotGateCode: true,
      publicSummaryUpdates: true, summaryDeduplicated: true, foldingChoicePreserved: true, unlabelledReasoningExcluded: true,
      fullSavedSummary: true, fullToolOutput: true, fileDiff: true, toolDetailsExpandedByDefault: true,
      perToolFoldingPreserved: true, globalDetailsModePreserved: true, scrollPositionPreserved: true,
      earlierHistory: true, allLeanMessages: true, hostFeedbackAndCheckedSource: true, thinkingRootScrollAreaBounded: true, rootScrollHeights });
    await context.close(); activeContext = undefined; activePage = undefined;
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', mode: 'full built application + synthetic API replay',
    mathematicalProof: false, performanceMeasurement: false, paidModelCalls: false, leanExecution: false,
    note: 'UI 回放耗时不代表真实数学任务性能。摘要、源码、编译与审核结果均为模拟 fixture。',
    timeoutMs: 0, tokenLimit: null, checks, screenshots }, null, 2) + '\n');
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 0 }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', mode: 'full built application + synthetic API replay',
    mathematicalProof: false, performanceMeasurement: false, paidModelCalls: false, leanExecution: false,
    note: 'UI 回放耗时不代表真实数学任务性能。摘要、源码、编译与审核结果均为模拟 fixture。',
    timeoutMs: 0, tokenLimit: null, scenario, stage, checks, screenshots,
    errors, writes, external, unexpectedApi, runtimeCalls, error: error instanceof Error ? error.stack : String(error) }, null, 2) + '\n');
  throw error;
} finally {
  await activeContext?.close(); await browser?.close(); await service.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
