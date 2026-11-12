#!/usr/bin/env bun
// Full built application with synthetic proof API replay. No model or Lean is invoked, and every timeout is disabled.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import type { WebInspectedTask, WebInspectedWorker, WebObservation, WebPlanTask } from '../apps/web/collaboration';
import { readWebConfig } from '../apps/web/config';
import type { WebConversation } from '../apps/web/conversationTypes';
import { webFormalizationDefaults, webFormalizationLimits } from '../apps/web/formalizationTypes';
import { collaborationDetailStorageKey } from '../apps/web/client/runAwareness';
import { localeStorageKey } from '../apps/web/i18n';
import { createWebService } from '../apps/web/server';
import { webLimits, type WebAgentAction, type WebAgentActionBody, type WebEventDetails, type WebRun, type WebSession } from '../apps/web/shared';
import { extendTrajectory, recordedTrajectory, trajectoryPage } from '../apps/web/trajectory';
import { proofOutline } from '../apps/web/verificationKit';
import { taskVersion } from '../src/solver/tasks';
import { audit } from './web-a11y';
import { freePort, preferFullCollaboration, settled } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const completionReadingOnly = process.argv.includes('--completion-reading-only');
/** The default 简洁 reading of the same replay: one record per task, grouped tools, folded checks. */
const simpleReadingOnly = process.argv.includes('--simple-reading');
const output = path.join(root, completionReadingOnly ? 'out/web-proof-thinking-completion' : simpleReadingOnly ? 'out/web-proof-thinking-simple' : 'out/web-proof-thinking');
const at = new Date().toISOString(), model = 'gpt-6.1-sol';
const provider = { id: 'fixture', name: 'Proof UI fixture · no model / Lean', baseUrl: 'https://fixture.invalid' };
const header = `import Mathlib
-- Synthetic proof UI fixture only; all source, research, review and verification records are replayed.
-- No model, tool or Lean process runs. This replay supplies no mathematical verification evidence.
`;
const statement = `${header}theorem ui_fixture_add_identity (n : Nat) : n + 0 = n ∧ 0 + n = n := by
  sorry
`;
const failedSource = `${header}theorem ui_fixture_add_identity (n : Nat) : n + 0 = n ∧ 0 + n = n := by
  exact Nat.add_zero n
`;
const correctedSource = `${header}theorem ui_fixture_add_identity (n : Nat) : n + 0 = n ∧ 0 + n = n := by
  constructor
  · exact Nat.add_zero n
  · exact Nat.zero_add n
`;
const hiddenReasoning = 'UI_FIXTURE_PROOF_RAW_REASONING_MUST_NOT_APPEAR';
const finalPayload = 'UI_FIXTURE_PROOF_FINAL_PROTOCOL_JSON_MUST_NOT_APPEAR';
const diagnostic = 'Synthetic Lean error: the goal is a conjunction, but the supplied term proves only its left side.';
const warning = 'Synthetic Lean warning retained in full. UI_FIXTURE_PROOF_WARNING_TAIL';
const info = 'Synthetic Lean information retained in full. UI_FIXTURE_PROOF_INFO_TAIL';
const checkOutput = 'Synthetic check output only: no command was executed.\nUI_FIXTURE_PROOF_CHECK_OUTPUT_TAIL';
const text = {
  zh: {
    title: '证明过程 UI 回放 · 无真实模型或 Lean',
    original: 'UI 测试题：证明每个自然数 n 都满足 n + 0 = n 且 0 + n = n。本次只回放合成记录，不运行模型或 Lean。',
    first: '**整理证明目标**\n原题的结论包含两个等式，先核对两侧加零所用的引理。',
    expanded: '**整理证明目标**\n原题的结论包含两个等式，先核对两侧加零所用的引理。分别证明左右两个分支，再用合取构造器合并。',
    plan: '先检索加零恒等式，分别证明左、右分支，最后合并并提交独立检查。',
    research: '检索 Nat.add_zero 与 Nat.zero_add，检查参数顺序及返回的等式方向。',
    left: '证明 n + 0 = n，并保存可供主目标复用的引理。',
    right: '证明 0 + n = n，并保存可供主目标复用的引理。',
    goal: '把两个分支合并成原题要求的合取结论。',
    finding: '找到 Nat.add_zero 与 Nat.zero_add；它们分别覆盖右加零与左加零，无须新增假设。',
    researcherSummary: '**检索并核对引理**\n已找到两个加零引理，正在核对它们与子目标的类型是否一致。',
    engineerSummary: '**分别构造两个分支**\n先完成 n + 0 = n，再完成 0 + n = n，随后组合为合取。',
    commentary: '已完成引理检索。接下来保存第一个合成候选，并回放 Lean 检查结果。',
    revision: '**根据类型错误修正**\n第一次候选只证明了左侧等式；完整目标是合取，需要先使用 constructor，再分别提供两个证明。',
    leftDone: '右加零引理已完成并纳入合成候选。',
    rightDone: '左加零引理已完成并纳入合成候选。',
    reviewerSummary: '**核对完整结论**\n两个分支都使用原来的自然数参数，合取顺序与原题一致。',
    review: '合成审阅记录：参数 n 未改变，两个等式均保留，未新增假设；建议把完整候选交给独立验收。',
    blueprint: '对合取分别构造左右两个证明，再保持原始参数 n 合并。UI_FIXTURE_PROOF_BLUEPRINT',
    outstanding: '仍需把两个分支合并成完整候选，并在独立环境回放验收。UI_FIXTURE_PROOF_REMAINING_OBLIGATION',
    stopped: '合成停止记录：用户取消，未进行独立验收；保存的摘要与候选代码仍可查看。',
  },
  en: {
    title: 'Proof process UI replay · no model or Lean',
    original: 'UI fixture: prove n + 0 = n and 0 + n = n for every natural number n. Only synthetic records are replayed; no model or Lean runs.',
    first: '**Organize the proof goal**\nThe conclusion contains two equalities. Check the lemmas for adding zero on each side.',
    expanded: '**Organize the proof goal**\nThe conclusion contains two equalities. Check the lemmas for adding zero on each side. Prove each branch and combine them with the conjunction constructor.',
    plan: 'Find the zero-addition identities, prove each branch, combine them and submit the whole candidate for an independent check.',
    research: 'Look up Nat.add_zero and Nat.zero_add, checking their parameter order and equality direction.',
    left: 'Prove n + 0 = n and save the lemma for the main goal.',
    right: 'Prove 0 + n = n and save the lemma for the main goal.',
    goal: 'Combine both branches into the conjunction required by the original goal.',
    finding: 'Found Nat.add_zero and Nat.zero_add. They cover adding zero on the right and left, with no extra assumptions.',
    researcherSummary: '**Find and check the lemmas**\nBoth zero-addition lemmas were found. Their types are being compared with the subgoals.',
    engineerSummary: '**Construct both branches**\nProve n + 0 = n first, then 0 + n = n, and combine them into a conjunction.',
    commentary: 'The lemma search is complete. Save the first synthetic candidate and replay its Lean check.',
    revision: '**Revise using the type error**\nThe first candidate proves only the left equality. The whole goal is a conjunction: use constructor first, then supply both proofs.',
    leftDone: 'The right-zero lemma is complete and included in the synthetic candidate.',
    rightDone: 'The left-zero lemma is complete and included in the synthetic candidate.',
    reviewerSummary: '**Check the full conclusion**\nBoth branches use the original natural-number parameter and keep the conjunction in the requested order.',
    review: 'Synthetic review record: parameter n is unchanged, both equalities remain, and no assumption was added. Submit the whole candidate for independent acceptance.',
    blueprint: 'Construct a proof of each conjunct and combine them using the original parameter n. UI_FIXTURE_PROOF_BLUEPRINT',
    outstanding: 'Combine both branches into a complete candidate and replay acceptance in an independent environment. UI_FIXTURE_PROOF_REMAINING_OBLIGATION',
    stopped: 'Synthetic stop record: cancelled by the user before independent acceptance. Saved summaries and candidate code remain available.',
  },
};
const capabilities = { available: true, model, providerId: provider.id, key: 'server', limits: webFormalizationLimits,
  defaults: webFormalizationDefaults, providers: [{ ...provider, defaultModel: model, key: 'server' }] };
const session: WebSession = { draftOwner: 'proof-thinking-ui-fixture', csrfToken: 'proof-ui-fixture-csrf', auth: 'none', providers: [provider],
  environments: [{ id: 'mathlib', name: 'Mathlib · UI fixture', description: 'No Lean execution', toolchain: 'leanprover/lean4:v4.33.0' }], templates: [],
  defaults: { model, effort: 'max', maxTurns: 0, maxRunSeconds: 0, workers: 4, coordination: 'cooperative', environment: 'mathlib' },
  limits: webLimits, runtime: { ready: true, message: 'Synthetic proof replay only' }, runs: { runs: [], version: 'proof-ui-fixture' } };

function observation(run: WebRun): WebObservation {
  const snapshot = { schema: 'theorem-os.inspection-snapshot.v1', runId: run.id, stateDigest: 'a'.repeat(64), resultDigest: null };
  const workers: WebInspectedWorker[] = ['lead', 'researcher', 'engineer', 'reviewer'].map(role => ({ id: role, role,
    phase: 'running', turns: 1, dispatchWait: { status: 'recorded' }, scheduling: { status: 'working', since: Date.parse(at) } }));
  return { schema: 'theorem-os.web-observation.v1', webRunId: run.id, solverRunId: `synthetic-${run.id}`, observedAt: at, sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, plan: null, sources: [], checks: [], guidance: [], deliveries: [],
    coverage: { sources: 'recorded', checks: 'recorded' }, inspection: {
      schema: 'theorem-os.run-inspection.v1', runId: run.id, snapshot, evidence: 'recorded-not-replayed', phase: 'solving',
      problem: { id: 'proof-ui-fixture', statement: run.task, formalStatement: statement, assumptions: [],
        targets: [{ proofPath: 'Submission.lean', theoremName: 'ui_fixture_add_identity' }] },
      configuration: { model, effort: 'max', workers: 4, coordination: 'cooperative', buildDigest: 'b'.repeat(64), environmentDigest: 'c'.repeat(64) },
      turns: 1, scheduling: { evidence: 'recorded', observedWorkers: 4, working: 4, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
      knowledge: { status: 'unused', evidence: 'recorded', attribution: 'synthetic-ui-fixture', retrievalCoverage: 'recorded',
        droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: null, continuation: null,
      mathematics: { snapshot: { schema: 'theoremos.obligation-snapshot.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
        digest: 'd'.repeat(64), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: [] },
      groups: [], tasks: [], workers, statementReviews: [], edits: [],
    } };
}

await fs.access(path.join(root, 'out/web/app.js'));
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-proof-thinking-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const runtimeCalls: string[] = [];
const neverRun = (name: string): never => { runtimeCalls.push(name); throw new Error(`Proof UI replay must not run ${name}`); };
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: path.join(temporary, 'data') }), {
  async readiness() { return { ready: true, message: 'Proof UI replay only' }; },
  async run() { neverRun('proof runner'); }, async formalize() { neverRun('formalization runner'); },
}, { sample: null });
let browser: Browser | undefined, activeContext: BrowserContext | undefined, activePage: Page | undefined;
let scenario = '', stage = '';
const checks: object[] = [], screenshots: string[] = [], errors: string[] = [], writes: string[] = [], external: string[] = [], unexpectedApi: string[] = [];
let accessibilityChecks = 0;
try {
  await new Promise<void>((resolve, reject) => { service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true, timeout: 0 });
  const scenarios = completionReadingOnly ? [['zh', 390]] as const : [['zh', 1440], ['zh', 390], ['en', 390]] as const;
  for (const [locale, width] of scenarios) {
    scenario = `${locale}-${width}`;
    const copy = text[locale], context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce',
      locale: locale === 'zh' ? 'zh-CN' : 'en-US', acceptDownloads: true });
    activeContext = context; context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
    await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, locale]);
    // Every saved record, version and diagnostic is the 详细 reading; --simple-reading covers the default 简洁 one.
    if (!simpleReadingOnly) await preferFullCollaboration(context);
    await context.addInitScript(() => {
      const copied: string[] = [];
      Object.assign(window, { proofFixtureClipboard: copied });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (value: string) => { copied.push(value); },
      } });
    });
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0);
    page.on('pageerror', error => errors.push(`${scenario}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${scenario}: ${message.text()}`); });
    const run: WebRun = { id: '33333333-3333-4333-8333-333333333333', title: copy.title, status: 'running', phase: 'solving',
      createdAt: at, updatedAt: at, providerId: provider.id, model, effort: 'max', environment: 'mathlib', source: statement, task: copy.original,
      maxTurns: 0, maxRunSeconds: 0, maxTotalTokens: 0, workers: 4, coordination: 'cooperative', events: [], actions: { count: 0 },
      timings: { preparing: at, solving: at } };
    run.observation = observation(run);
    const conversation: WebConversation = { id: '44444444-4444-4444-8444-444444444444', title: copy.title, createdAt: at, updatedAt: at, runId: run.id,
      messages: [{ id: 'question', role: 'user', kind: 'text', text: copy.original, createdAt: at, status: 'complete' },
        { id: 'task', role: 'assistant', kind: 'task', text: '', createdAt: at, status: 'complete' }] };
    const actions: WebAgentAction[] = [];
    const stoppedRun: WebRun = { ...structuredClone(run), id: '55555555-5555-4555-8555-555555555555', status: 'cancelled', phase: 'finished',
      finishedAt: at, artifact: { source: failedSource, workerId: 'engineer', status: 'candidate', capturedAt: at },
      events: [{ sequence: 1, at, type: 'turn_started', message: copy.stopped, details: { workerId: 'engineer', turn: 1 } }], actions: { count: 2 } };
    stoppedRun.observation = observation(stoppedRun);
    const stoppedActions: WebAgentAction[] = [
      { sequence: 1, at, workerId: 'engineer', itemId: 'stopped-summary', kind: 'message', textSource: 'commentary', phase: 'completed', status: 'done', text: copy.stopped },
      { sequence: 2, at, workerId: 'engineer', itemId: 'unfinished-check', kind: 'command', phase: 'started', status: 'running',
        command: 'theorem-os check-lean --file Submission.lean' },
    ];
    const stoppedConversation: WebConversation = { ...structuredClone(conversation), id: '66666666-6666-4666-8666-666666666666', runId: stoppedRun.id };
    const runs = new Map([[run.id, run], [stoppedRun.id, stoppedRun]]), conversations = new Map([[conversation.id, conversation], [stoppedConversation.id, stoppedConversation]]);
    const trajectories = new Map([...runs.keys()].map(id => [id, recordedTrajectory([], [])]));
    let revision = 0, detailReads = 0;
    const touch = () => {
      run.updatedAt = new Date(Date.parse(at) + ++revision * 1000).toISOString(); conversation.updatedAt = run.updatedAt;
      run.observation!.observedAt = run.updatedAt; run.observation!.sequence++;
    };
    const event = (type: string, message: string, details?: WebEventDetails) => {
      run.events.push({ sequence: run.events.length + 1, at: run.updatedAt, type, message, ...(details ? { details } : {}) });
    };
    const action = (body: WebAgentActionBody) => {
      actions.push({ ...body, sequence: actions.length + 1, at: run.updatedAt }); run.actions = { count: actions.length };
    };
    const summary = (workerId: string, itemId: string, value: string, completed = false) => action({ workerId, itemId, kind: 'reasoning', textSource: 'summary',
      phase: completed ? 'completed' : 'started', status: completed ? 'done' : 'running', text: value });
    const tasks: WebPlanTask[] = [
      { id: 'research', kind: 'research', objective: copy.research, informalStatement: copy.research, dependsOn: [], revision: 1, ownerId: 'researcher' },
      { id: 'left-zero', kind: 'lemma', objective: copy.left, dependsOn: ['research'], revision: 1, ownerId: 'engineer',
        theoremName: 'ui_fixture_right_zero', proofPath: 'Submission.lean', type: '(n : Nat) : n + 0 = n', premises: ['n : Nat'], informalStatement: copy.left, informalProof: copy.blueprint },
      { id: 'right-zero', kind: 'lemma', objective: copy.right, dependsOn: ['research'], revision: 1, ownerId: 'engineer',
        theoremName: 'ui_fixture_left_zero', proofPath: 'Submission.lean', type: '(n : Nat) : 0 + n = n', premises: ['n : Nat'], informalStatement: copy.right, informalProof: copy.blueprint },
      { id: 'goal', kind: 'goal', objective: copy.goal, dependsOn: ['left-zero', 'right-zero'], revision: 1, ownerId: 'engineer',
        theoremName: 'ui_fixture_add_identity', proofPath: 'Submission.lean', type: '(n : Nat) : n + 0 = n ∧ 0 + n = n',
        premises: ['n : Nat'], informalStatement: copy.goal, informalProof: copy.blueprint },
    ];
    const inspected = (task: WebPlanTask): WebInspectedTask => ({ id: task.id, kind: task.kind, objective: task.objective, group: 'proof-ui-fixture',
      status: task.kind === 'research' ? 'running' : 'pending', control: 'active', owner: task.ownerId, version: taskVersion(task), theorem: task.theoremName, type: task.type,
      informalStatement: task.informalStatement, premises: task.premises ?? [], plannedDependencies: task.dependsOn, attempts: 0,
      proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} });
    await context.route(/^https?:\/\//u, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
      if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
      if (request.method() !== 'GET') { writes.push(`${request.method()} ${url.pathname}`); await route.fulfill({ status: 422, json: { error: 'Read-only synthetic proof fixture' } }); return; }
      const json = (body: unknown) => route.fulfill({ json: body });
      if (url.pathname === '/api/session') return json(session);
      if (url.pathname === '/api/research/overview') return json({ projects: [], notifications: [] });
      if (url.pathname === '/api/runs') return json({ runs: [...runs.values()], version: `proof-fixture-${revision}` });
      if (url.pathname === '/api/runs/stream') return route.fulfill({ status: 204, contentType: 'text/event-stream' });
      if (url.pathname === '/api/formalizations') return json({ formalizations: [], generation: capabilities });
      if (url.pathname === '/api/conversations') return json({ conversations: [...conversations.values()].map(({ messages: _messages, ...item }) => ({ ...item, answering: false })) });
      for (const item of conversations.values()) if (url.pathname === `/api/conversations/${item.id}`) return json({ conversation: item });
      for (const item of runs.values()) {
        if (url.pathname === `/api/runs/${item.id}`) { detailReads++; return json({ run: item }); }
        if (url.pathname === `/api/runs/${item.id}/events`) return json({ events: item.events.filter(record => record.sequence > Number(url.searchParams.get('after') ?? 0)) });
        if (url.pathname === `/api/runs/${item.id}/actions`) return json({ actions: (item.id === run.id ? actions : stoppedActions)
          .filter(record => record.sequence > Number(url.searchParams.get('after') ?? 0)), dropped: 0 });
        if (url.pathname === `/api/runs/${item.id}/trajectory`) {
          const trajectory = trajectories.get(item.id)!;
          extendTrajectory(trajectory, item.events, item.observation ? [item.observation] : []);
          return json({ trajectory: trajectoryPage(trajectory, { after: Number(url.searchParams.get('after') ?? 0),
            since: Number(url.searchParams.get('since') ?? 0), instance: url.searchParams.get('instance') ?? undefined }) });
        }
        if (url.pathname === `/api/runs/${item.id}/outline`) return json({ outline: proofOutline(item) });
        if (url.pathname === `/api/runs/${item.id}/explanations`) return json({ run: { id: item.id, title: item.title,
          environment: item.environment, model: item.model, effort: item.effort, proof: item.result?.proof },
          targets: [], explanations: [], generation: { available: false, reason: 'runtime' } });
      }
      unexpectedApi.push(url.pathname); await route.fulfill({ status: 500, json: { error: `Unexpected proof fixture API: ${url.pathname}` } });
    });
    const thinking = page.locator('#research-chat-thread [data-thinking-process]');
    const thinkingBody = thinking.locator('.thinking-body');
    const allFilter = thinking.locator('[data-thinking-filter="all"]');
    const explanationsFilter = thinking.locator('[data-thinking-filter="explanations"]');
    const latest = thinking.locator('[data-thinking-latest]');
    const newRecordBadge = thinking.locator('[data-thinking-new-count]');
    const options = thinking.locator('[data-thinking-options]');
    const optionsToggle = options.locator(':scope > summary');
    const searchToggle = thinking.locator('[data-thinking-search-toggle]');
    const searchBack = thinking.locator('[data-thinking-search-back]');
    const query = thinking.locator('[data-thinking-query]');
    const searchClose = thinking.locator('[data-thinking-search-close]');
    const previousMatch = thinking.locator('[data-thinking-search-previous]');
    const nextMatch = thinking.locator('[data-thinking-search-next]');
    const composer = page.locator('#formalize-original');
    const quoteBar = page.locator('[data-chat-quote]');
    const quoteUndo = page.locator('[data-chat-quote-undo]');
    let historyAnchorDelta = 0, reopenedScrollDelta = 0, reopenedAnchorDelta = 0;
    let searchAnchorDelta = 0, searchReturnAnchorDelta = 0, searchReturnReadingDelta = 0;
    const toolbarHeights: number[] = [];
    const newRecordCounts: { checkpoint: string; count: number }[] = [];
    const navigationSelections: number[] = [];
    const codeCopies: { checkpoint: string; characters: number; thinkingScrollDelta: number; threadScrollDelta: number; fontSize: number }[] = [];
    const versionCopies: { field: string; characters: number; thinkingScrollDelta: number; threadScrollDelta: number }[] = [];
    const copySnapshot = () => page.evaluate(() => {
      const thinking = document.querySelector('#research-chat-thread [data-thinking-process]')!;
      const draft = document.querySelector<HTMLTextAreaElement>('#formalize-original')!;
      return { copied: (window as unknown as { proofFixtureClipboard: string[] }).proofFixtureClipboard.slice(),
        open: (thinking as HTMLDetailsElement).open, following: thinking.getAttribute('data-thinking-following'),
        details: [...thinking.querySelectorAll<HTMLDetailsElement>('details[data-thinking-detail]')].map(node => [node.dataset.thinkingDetail, node.open]),
        versions: [...thinking.querySelectorAll<HTMLDetailsElement>('details[data-thinking-version]')].map(node => [node.dataset.thinkingVersion, node.open]),
        thinkingTop: thinking.querySelector('.thinking-body')!.scrollTop, threadTop: document.querySelector('#research-chat-thread')!.scrollTop,
        draft: { text: draft.value, start: draft.selectionStart, end: draft.selectionEnd, direction: draft.selectionDirection, top: draft.scrollTop } };
    });
    const expectLocalCopy = async (button: Locator, source: string, checkpoint: string, copiedLabel: string) => {
      await button.evaluate(node => {
        const body = node.closest('.thinking-body')!;
        // Match a reader scrolling to the control so polling records this reading position.
        body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
        node.scrollIntoView({ block: 'center', behavior: 'instant' });
        body.dispatchEvent(new Event('scroll'));
        document.querySelector('#research-chat-thread')!.dispatchEvent(new Event('scroll'));
      });
      await settled(page);
      const before = await copySnapshot(), writesBefore = writes.length;
      await button.click(); await page.waitForFunction(count => (window as unknown as { proofFixtureClipboard: string[] }).proofFixtureClipboard.length > count, before.copied.length);
      await settled(page);
      const after = await copySnapshot(), thinkingScrollDelta = after.thinkingTop - before.thinkingTop, threadScrollDelta = after.threadTop - before.threadTop;
      assert.deepEqual(after.copied, [...before.copied, source], `${checkpoint}: copy writes the full original source to the local clipboard fixture`);
      assert.equal(await button.getAttribute('aria-label'), copiedLabel);
      assert.deepEqual({ open: after.open, following: after.following, details: after.details, versions: after.versions, draft: after.draft },
        { open: before.open, following: before.following, details: before.details, versions: before.versions, draft: before.draft }, `${checkpoint}: copy preserves reading choices and the discussion draft`);
      assert.ok(Math.abs(thinkingScrollDelta) <= 1 && Math.abs(threadScrollDelta) <= 1,
        `${checkpoint}: copy preserves inner and outer scrolling ${JSON.stringify({ thinkingScrollDelta, threadScrollDelta })}`);
      assert.equal(writes.length, writesBefore, `${checkpoint}: copy sends no request`);
      return { thinkingScrollDelta, threadScrollDelta };
    };
    const expectCodeCopy = async (block: Locator, source: string, checkpoint: string, visible = source) => {
      assert.equal(await block.locator('pre code').textContent(), visible, `${checkpoint}: highlighting preserves the exact visible source`);
      assert.ok(await block.locator('pre code [class^="lean-"]').count() > 0, `${checkpoint}: Lean syntax has readable highlighting`);
      const expanded = await block.getAttribute('data-expanded');
      const { thinkingScrollDelta, threadScrollDelta } = await expectLocalCopy(block.locator('[data-chat-code-copy]'), source, checkpoint, locale === 'zh' ? '代码已复制' : 'Code copied');
      assert.equal(await block.getAttribute('data-expanded'), expanded, `${checkpoint}: copying does not expand or collapse the code`);
      assert.equal(await block.locator('pre code').textContent(), visible, `${checkpoint}: copying leaves displayed source unchanged`);
      const layout = await block.evaluate(node => {
        const header = node.querySelector('header')!, label = header.querySelector('span')!, button = header.querySelector('button')!;
        const text = button.querySelector('span')!, pre = node.querySelector('pre')!, box = node.getBoundingClientRect();
        const labelBox = label.getBoundingClientRect(), buttonBox = button.getBoundingClientRect();
        return { fontSize: parseFloat(getComputedStyle(pre).fontSize),
          buttonFits: buttonBox.left >= box.left && buttonBox.right <= box.right + 1 && labelBox.right <= buttonBox.left + 1,
          oneLineButton: text.getBoundingClientRect().height <= parseFloat(getComputedStyle(text).lineHeight) + 1,
          sourceFits: pre.scrollWidth <= pre.clientWidth + 1 };
      });
      assert.ok(layout.fontSize >= 12 && layout.buttonFits && layout.oneLineButton && layout.sourceFits,
        `${checkpoint}: code and its copy button remain readable inside the viewport ${JSON.stringify(layout)}`);
      codeCopies.push({ checkpoint, characters: source.length, thinkingScrollDelta, threadScrollDelta, fontSize: layout.fontSize });
    };
    const expectVersionCopy = async (details: Locator, field: 'task' | 'commit' | 'source', value: string) => {
      const labels = { task: ['任务版本', 'Task version'], commit: ['提交版本', 'Commit'], source: ['源码摘要', 'Source digest'] };
      const label = labels[field][locale === 'zh' ? 0 : 1], row = details.locator(`[data-thinking-version-field="${field}"]`);
      assert.equal(await row.locator('dd code').textContent(), value, `The complete ${field} version is available as readable text`);
      const button = row.locator(`[data-thinking-version-copy="${field}"]`);
      assert.equal(await button.getAttribute('aria-label'), locale === 'zh' ? `复制${label}` : `Copy ${label}`);
      const deltas = await expectLocalCopy(button, value, `${field} version`, locale === 'zh' ? `${label}已复制` : `${label} copied`);
      assert.equal(await row.locator('dd code').textContent(), value, 'Copying leaves the complete version text unchanged');
      const layout = await row.evaluate(node => {
        const code = node.querySelector('dd code')!, button = node.querySelector('button')!, term = node.querySelector('dt')!;
        const codeBox = code.getBoundingClientRect(), buttonBox = button.getBoundingClientRect(), termBox = term.getBoundingClientRect();
        return { textFits: code.scrollWidth <= code.clientWidth + 1 && codeBox.right <= innerWidth + 1,
          buttonFits: buttonBox.left >= termBox.left && buttonBox.right <= termBox.right + 1,
          fontSize: parseFloat(getComputedStyle(code).fontSize) };
      });
      assert.ok(layout.textFits && layout.buttonFits && layout.fontSize >= 12, `Full version text and its copy button fit the viewport: ${JSON.stringify(layout)}`);
      versionCopies.push({ field, characters: value.length, ...deltas });
    };
    const expectNewRecords = async (count: number, checkpoint: string) => {
      await settled(page);
      const actual = await newRecordBadge.count() ? Number.parseInt(await newRecordBadge.innerText(), 10) : 0;
      assert.equal(actual, count, checkpoint);
      if (count > 0) {
        assert.equal(await newRecordBadge.isVisible(), true, 'The unread number remains visible on mobile');
        assert.equal(await latest.getAttribute('aria-label'), locale === 'zh'
          ? `查看最新进展（${count} 条新记录）` : `Latest progress (${count} new ${count === 1 ? 'record' : 'records'})`);
      }
      newRecordCounts.push({ checkpoint, count: actual });
    };
    const chooseRecords = async (expand: boolean) => {
      await optionsToggle.click(); await settled(page);
      assert.equal(await options.getAttribute('open'), '');
      await options.locator(expand ? '[data-thinking-expand-all]' : '[data-thinking-collapse-all]').click();
      await settled(page);
      assert.equal(await options.getAttribute('open'), null, 'A record option closes the menu');
      assert.ok(await optionsToggle.evaluate(node => document.activeElement === node), 'A record option returns focus to its trigger');
    };
    const findRecords = async (value: string, expected: number) => {
      await query.fill(value); await settled(page);
      assert.equal(await thinking.locator('[data-thinking-entry]').count(), expected);
      assert.equal(Number.parseInt(await thinking.locator('.thinking-search-count').innerText(), 10), expected);
      assert.ok(await thinkingBody.evaluate(node => node.scrollTop <= 2), 'A new query starts at the first result');
    };
    const expectSelectedMatch = async (index: number, focus?: 'input' | 'previous' | 'next', visible = true) => {
      await settled(page);
      const selected = thinking.locator('[data-thinking-selected="true"]');
      assert.equal(await selected.count(), 1);
      assert.equal(await selected.getAttribute('data-thinking-entry'), `prove:researcher:history-${index}`);
      assert.equal(await selected.getAttribute('aria-current'), 'true');
      const position = thinking.locator('.thinking-search-count');
      assert.equal(await position.getAttribute('data-thinking-search-position'), String(index + 1));
      assert.equal((await position.innerText()).replace(/\s+/g, ' ').trim(), `${index + 1} / 44`);
      assert.equal(await position.getAttribute('aria-label'), locale === 'zh' ? `第 ${index + 1} / 44 条匹配` : `Match ${index + 1} of 44`);
      if (focus) assert.ok(await (focus === 'input' ? query : focus === 'previous' ? previousMatch : nextMatch).evaluate(node => document.activeElement === node),
        'Navigating preserves the initiating input or button focus');
      if (visible) {
        const bounds = await selected.evaluate(entry => {
          const body = entry.closest('.thinking-body')!.getBoundingClientRect();
          const toolbar = entry.closest('[data-thinking-process]')!.querySelector('.thinking-controls')!.getBoundingClientRect();
          const thread = document.querySelector('#research-chat-thread')!.getBoundingClientRect();
          return { top: entry.getBoundingClientRect().top, visibleTop: Math.max(body.top, toolbar.bottom, thread.top),
            visibleBottom: Math.min(body.bottom, thread.bottom, innerHeight), bodyTop: body.top, toolbarBottom: toolbar.bottom,
            threadTop: thread.top, innerScrollTop: entry.closest('.thinking-body')!.scrollTop,
            threadScrollTop: document.querySelector('#research-chat-thread')!.scrollTop };
        });
        assert.ok(bounds.top >= bounds.visibleTop - 4 && bounds.top < bounds.visibleBottom,
          `The selected result starts inside the visible log below the toolbar: ${JSON.stringify(bounds)}`);
      }
      assert.equal(await thinking.locator('[data-thinking-detail][open]').count(), 0, 'Result navigation preserves the globally folded details');
      navigationSelections.push(index + 1);
    };
    const scrollBody = async (position: 'top' | 'middle' | 'bottom') => {
      await settled(page);
      await thinkingBody.evaluate((node, where) => {
        node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: where === 'top' ? -1 : 1 }));
        node.scrollTop = where === 'top' ? 0 : where === 'bottom' ? node.scrollHeight : Math.max(1, (node.scrollHeight - node.clientHeight) / 2);
        node.dispatchEvent(new Event('scroll'));
      }, position);
      await settled(page);
    };
    const rootScrollHeights: { screen: string; rootHeight: number; viewportHeight: number }[] = [];
    const contains = async (value: string) => {
      await page.waitForFunction(expected => document.querySelector('#research-chat-thread [data-thinking-process]')?.textContent?.includes(expected), value);
      const content = await thinking.textContent(); assert.ok(!content?.includes(hiddenReasoning)); assert.ok(!content?.includes(finalPayload));
    };
    const capture = async (name: string, focus?: string, preserveView = false) => {
      stage = name;
      if (focus) await thinking.locator(focus).evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
      else if (!preserveView) await thinking.scrollIntoViewIfNeeded();
      await settled(page); await page.mouse.move(0, 0);
      if (width === 390 && await thinking.locator('.thinking-controls').isVisible() && !await query.count()) {
        const height = await thinking.locator('.thinking-controls').evaluate(node => node.getBoundingClientRect().height);
        toolbarHeights.push(height);
        assert.ok(height <= 52, `${scenario}/${name}: the compact toolbar stays in one row: ${height}px`);
      }
      const bounds = await page.evaluate(() => ({ rootHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight,
        noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1 }));
      rootScrollHeights.push({ screen: name, rootHeight: bounds.rootHeight, viewportHeight: bounds.viewportHeight });
      assert.equal(bounds.noHorizontalOverflow, true, `${scenario}/${name}: horizontal overflow`);
      assert.ok(bounds.rootHeight <= bounds.viewportHeight * 2, `${scenario}/${name}: thinking records escape their scroll container: ${JSON.stringify(bounds)}`);
      assert.deepEqual(await audit(page), [], `${scenario}/${name}: accessibility`); accessibilityChecks++;
      const file = `${scenario}-${name}.png`; screenshots.push(file); await page.screenshot({ path: path.join(output, file), fullPage: true, timeout: 0 });
      console.log(`PASS ${scenario}: ${name}`);
    };
    const openConversation = async (id: string) => {
      await page.locator(`[data-chat-row="${id}"] a.chat-history-item`).evaluate(node => (node as HTMLAnchorElement).click());
      await page.waitForFunction(expected => document.querySelector('#research-chat-thread [data-conversation]')?.getAttribute('data-conversation') === expected, id);
      await settled(page);
    };
    const expectNoLatestOverlap = async () => {
      await latest.scrollIntoViewIfNeeded(); await settled(page);
      assert.equal(await page.locator('[data-chat-latest]').isVisible(), false, 'The outer latest button yields to a visible thinking log');
      const controls = await latest.getAttribute('aria-controls');
      assert.ok(controls); assert.equal(controls, await thinkingBody.getAttribute('id'), 'The latest action identifies its own log');
      const covered = await latest.evaluate(button => {
        const box = button.getBoundingClientRect(), section = button.closest('[data-thinking-process]')!;
        const body = section.querySelector('.thinking-body')!.getBoundingClientRect();
        const toolbar = section.querySelector('.thinking-controls')!.getBoundingClientRect();
        const thread = document.querySelector('#research-chat-thread')!.getBoundingClientRect();
        if (box.top < toolbar.top - 1 || box.bottom > toolbar.bottom + 1) return ['latest action lies outside the toolbar'];
        const top = Math.max(0, body.top, thread.top, toolbar.bottom), bottom = Math.min(innerHeight, body.bottom, thread.bottom);
        const walker = document.createTreeWalker(section.querySelector('.thinking-entries')!, NodeFilter.SHOW_TEXT);
        const overlaps: string[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          if ([...range.getClientRects()].some(rect => rect.top < bottom && rect.bottom > top && rect.left < box.right && rect.right > box.left
            && Math.max(rect.top, top) < box.bottom && Math.min(rect.bottom, bottom) > box.top)) overlaps.push(node.textContent.trim().slice(0, 100));
        }
        return overlaps;
      });
      assert.deepEqual(covered, [], 'The dedicated latest control leaves the visible explanation text unobstructed');
    };

    if (completionReadingOnly) {
      stage = 'proof-completed-while-reading';
      event('solve_started', 'Synthetic proof run started.');
      for (let index = 0; index < 60; index++) {
        touch(); summary('researcher', `completion-history-${index}`,
          `${copy.research} Synthetic saved record ${index + 1}. UI_FIXTURE_PROOF_COMPLETION_HISTORY_${index}`, true);
      }
      await page.goto(`${origin}/?chat=${conversation.id}`, { timeout: 0 });
      await contains('UI_FIXTURE_PROOF_COMPLETION_HISTORY_59');
      assert.equal(await thinking.getAttribute('open'), '', 'A fresh running proof opens its process by default');
      assert.equal(await thinking.getAttribute('data-thinking-following'), 'true');
      await thinkingBody.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await settled(page);
      await scrollBody('middle');
      await page.waitForFunction(() => document.querySelector('[data-thinking-process]')?.getAttribute('data-thinking-following') === 'false');
      await settled(page);
      const beforeCompletion = await thinkingBody.evaluate(body => {
        const top = body.getBoundingClientRect().top;
        const entry = [...body.querySelectorAll<HTMLElement>('.thinking-entries > [data-thinking-entry]')]
          .find(node => node.getBoundingClientRect().bottom > top + 1)!;
        return { id: entry.dataset.thinkingEntry!, offset: entry.getBoundingClientRect().top - top, scrollTop: body.scrollTop,
          threadOffset: entry.getBoundingClientRect().top - document.querySelector('#research-chat-thread')!.getBoundingClientRect().top,
          firstMounted: body.querySelector<HTMLElement>('[data-thinking-entry]')!.dataset.thinkingEntry };
      });
      touch(); event('evaluation_finished', 'Synthetic independent acceptance passed.', { workerId: 'engineer', status: 'passed' });
      run.status = 'completed'; run.phase = 'finished'; run.finishedAt = run.updatedAt;
      run.result = { status: 'evaluated_passed', proof: correctedSource, report: { fixture: 'Synthetic acceptance only; no verification process ran.' } };
      await page.waitForFunction(() => document.querySelector('.research-conversation-status')?.getAttribute('data-accepted') === 'true');
      await settled(page);
      assert.equal(await thinking.getAttribute('open'), '', 'Finishing a proof keeps its process open when the reader only scrolled up');
      assert.equal(await thinking.getAttribute('data-thinking-following'), 'false');
      const afterCompletion = await thinking.locator(`[data-thinking-entry="${beforeCompletion.id}"]`).evaluate(entry => {
        const body = entry.closest('.thinking-body')!;
        return { offset: entry.getBoundingClientRect().top - body.getBoundingClientRect().top, scrollTop: body.scrollTop,
          threadOffset: entry.getBoundingClientRect().top - document.querySelector('#research-chat-thread')!.getBoundingClientRect().top,
          firstMounted: body.querySelector<HTMLElement>('[data-thinking-entry]')!.dataset.thinkingEntry };
      });
      const completionScrollDelta = Math.abs(afterCompletion.scrollTop - beforeCompletion.scrollTop);
      const completionAnchorDelta = Math.abs(afterCompletion.offset - beforeCompletion.offset);
      const completionThreadAnchorDelta = Math.abs(afterCompletion.threadOffset - beforeCompletion.threadOffset);
      assert.ok(completionAnchorDelta <= 4, `Completion preserves the paused reader's anchor: ${JSON.stringify({ beforeCompletion, afterCompletion, completionAnchorDelta, completionScrollDelta })}`);
      assert.ok(completionThreadAnchorDelta <= 4, `Completion preserves the reader's outer thread position: ${JSON.stringify({ beforeCompletion, afterCompletion, completionThreadAnchorDelta })}`);
      await capture('proof-completed-while-reading');

      await scrollBody('top');
      await settled(page);
      await thinking.locator('.thinking-earlier').click();
      await page.waitForFunction(() => document.querySelector('[data-thinking-entry="prove:researcher:completion-history-0"]'));
      await settled(page);
      assert.ok(await thinkingBody.evaluate(node => document.activeElement === node), 'Loading history returns keyboard focus to the log');
      await latest.click();
      await page.waitForFunction(() => document.querySelector('[data-thinking-process]')?.getAttribute('data-thinking-following') === 'true');
      const afterLatest = await thinking.evaluate(node => ({ open: (node as HTMLDetailsElement).open, bodyCount: node.querySelectorAll('.thinking-body').length }));
      assert.equal(afterLatest.open, true, `Returning to latest keeps a completed process open: ${JSON.stringify({ afterLatest, beforeCompletion, afterCompletion, completionScrollDelta, completionAnchorDelta, completionThreadAnchorDelta })}`);
      assert.ok(await thinkingBody.evaluate(node => document.activeElement === node), 'Returning to latest returns keyboard focus to the log');
      assert.ok(await thinkingBody.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop <= 2));
      assert.equal(await latest.isVisible(), false);
      touch(); summary('engineer', 'completion-following-update', 'UI_FIXTURE_PROOF_COMPLETION_CONTINUES_FOLLOWING', true);
      await contains('UI_FIXTURE_PROOF_COMPLETION_CONTINUES_FOLLOWING');
      assert.equal(await thinking.getAttribute('open'), '', 'New records keep the completed process open after resuming follow');
      assert.equal(await thinking.getAttribute('data-thinking-following'), 'true');
      assert.ok(await thinkingBody.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop <= 2), 'Resumed following continues for the next saved record');
      assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(external, []); assert.deepEqual(unexpectedApi, []); assert.deepEqual(runtimeCalls, []);
      checks.push({ scenario, detailReads, freshRunningTask: true, noManualOuterToggle: true, completionPreservesOpenReading: true,
        beforeCompletion, afterCompletion, completionScrollDelta, completionAnchorDelta, completionThreadAnchorDelta,
        historyFocusReturnsToLog: true, latestFocusReturnsToLog: true, completedProcessContinuesFollowing: true, rootScrollHeights });
      await context.close(); activeContext = undefined; activePage = undefined;
      continue;
    }

    if (simpleReadingOnly) {
      stage = 'simple-reading';
      const detail = () => page.evaluate(key => localStorage.getItem(key), collaborationDetailStorageKey);
      const rows = thinking.locator('.thinking-entries > li'), group = thinking.locator('[data-thinking-kind="actions"]');
      const failedCheck = thinking.locator('[data-thinking-detail="check:p:engineer:proof-check-1"]');
      const brief = thinking.locator('[data-thinking-check-brief]'), process = page.locator('[data-solve-process]');
      const chooseLevel = async (level: 'simple' | 'full') => {
        await optionsToggle.click(); await settled(page);
        assert.deepEqual(await options.locator('[data-thinking-level]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-pressed'))),
          level === 'full' ? ['true', 'false'] : ['false', 'true'], 'The menu marks the reading in use');
        await options.locator(`[data-thinking-level="${level}"]`).click();
        await page.waitForFunction(value => document.querySelector('[data-thinking-process]')?.getAttribute('data-detail') === value, level);
        await settled(page);
        assert.equal(await options.getAttribute('open'), null, 'Choosing a reading closes the menu');
        assert.equal(await detail(), level, 'The reading is saved for this browser');
      };
      event('solve_started', 'Synthetic proof run started.');
      touch(); summary('lead', 'public-summary', copy.first, true);
      touch();
      run.observation!.plan = { schema: 'theorem-os.research-plan.v1', baseVersion: 'v1', tasks };
      run.observation!.inspection.planVersion = 'v1'; run.observation!.inspection.tasks = tasks.map(inspected);
      run.observation!.inspection.tasks.find(task => task.id === 'left-zero')!.status = 'running';
      event('plan_updated', copy.plan, { workerId: 'lead', role: 'lead' });
      touch(); event('task_assigned', copy.left, { workerId: 'engineer', role: 'engineer', taskId: 'left-zero' });
      touch(); summary('researcher', 'research-summary', copy.researcherSummary, true);
      for (const [index, command] of ["theorem-os search-lean --query 'Nat.add_zero'", 'rg SyntheticProofFixture Mathlib', "theorem-os search-lean --query 'Nat.zero_add'"].entries()) {
        touch(); action({ workerId: 'researcher', itemId: `simple-tool-${index}`, kind: 'command', phase: 'completed', status: 'done',
          command, output: `UI_FIXTURE_PROOF_SIMPLE_TOOL_OUTPUT_${index}${index === 0
            ? '\n' + Array.from({ length: 40 }, (_, row) => `Earlier tool output row ${row + 1}`).join('\n') : ''}` });
      }
      touch(); summary('engineer', 'proof-summary', copy.engineerSummary, true);
      touch(); run.artifact = { source: failedSource, workerId: 'engineer', status: 'candidate', capturedAt: run.updatedAt };
      action({ workerId: 'engineer', itemId: 'proof-check-1', kind: 'command', phase: 'completed', status: 'failed', exitCode: 1,
        command: 'theorem-os check-lean --file Submission.lean', output: checkOutput, lean: { passed: false, messages: [
          { severity: 'warning', line: 4, text: warning }, { severity: 'error', line: 5, column: 9, text: diagnostic },
        ] } });
      await page.goto(`${origin}/?chat=${conversation.id}`, { timeout: 0 });
      await contains(copy.engineerSummary.split('\n')[1]!); await failedCheck.waitFor(); await settled(page);
      assert.equal(await detail(), null, 'A new browser has made no choice');
      assert.equal(await thinking.getAttribute('data-detail'), 'simple', 'A new browser reads the conversation in 简洁');
      assert.equal(await thinking.getAttribute('open'), '', 'The readable log still opens while the task runs');
      assert.equal(await process.getAttribute('open'), null, 'The step checklist stays one line');
      assert.equal(await page.locator('[data-chat-outcomes], [data-chat-next-action]').count(), 0, 'A task that needs nothing from the reader says its state once');
      // One record per task: the running lemma's plan is behind its progress record; tasks not started keep their plan.
      assert.deepEqual(await thinking.locator('[data-thinking-work="plan"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-thinking-task')).sort()),
        ['goal', 'research', 'right-zero']);
      const lemma = thinking.locator('[data-thinking-task="left-zero"]');
      assert.equal(await lemma.count(), 1); assert.equal(await lemma.getAttribute('data-thinking-work'), 'proof');
      assert.ok((await lemma.locator('.thinking-head').innerText()).includes(locale === 'zh' ? '正在证明' : 'Proving'), 'Who, what and its state share one line');
      assert.ok(!(await lemma.innerText()).includes('UI_FIXTURE_PROOF_BLUEPRINT'), 'The plan details start folded');
      await lemma.locator('details > summary').first().click(); await settled(page);
      assert.ok((await lemma.innerText()).includes('UI_FIXTURE_PROOF_BLUEPRINT'), 'The folded plan opens inside the progress record');
      await lemma.locator('details > summary').first().click(); await settled(page);
      assert.equal(await thinking.locator('details[data-thinking-version]').count(), 0, 'Version identifiers belong to 详细');
      assert.equal(await thinking.locator('.thinking-entry-meta').count(), 0, 'No separate line for who and when');
      // Three searches in a row read as one line.
      assert.equal(await group.count(), 1); assert.equal(await thinking.locator('[data-thinking-kind="action"]').count(), 0);
      assert.equal((await group.locator('.thinking-group-count').innerText()).trim(), locale === 'zh' ? '3 项工具操作' : '3 tool actions');
      assert.ok((await group.locator('.thinking-group-latest').innerText()).includes('Nat.zero_add'), 'The line names the latest action');
      assert.equal(await group.locator(':scope > details').getAttribute('open'), null);
      assert.ok(!(await thinking.innerText()).includes('UI_FIXTURE_PROOF_SIMPLE_TOOL_OUTPUT_0'));
      // A failed check stays one line and still says what Lean objected to first.
      assert.equal(await failedCheck.getAttribute('open'), null);
      assert.equal(await brief.count(), 1);
      assert.ok((await brief.innerText()).includes(diagnostic) && (await brief.innerText()).includes(locale === 'zh' ? '第 5 行出错' : 'Error on line 5'),
        `The folded check names the first error, not the earlier warning: ${await brief.innerText()}`);
      assert.equal(await failedCheck.locator('.thinking-source').count(), 0);
      const question = thinking.locator('[data-thinking-question="prove:lead:public-summary"]');
      assert.equal((await question.innerText()).trim(), ''); assert.equal(await question.getAttribute('aria-label'), locale === 'zh' ? '追问这一步' : 'Ask about this step');
      await capture('simple-reading');

      await group.locator(':scope > details > summary').click(); await settled(page);
      assert.equal(await group.locator('.route-items > li').count(), 3, 'The line opens to each action');
      await failedCheck.locator(':scope > summary').click(); await failedCheck.locator('.thinking-source').waitFor(); await settled(page);
      assert.equal(await failedCheck.locator('.thinking-source pre code').textContent(), failedSource, 'The check opens to its saved source');
      assert.equal(await brief.count(), 0, 'An opened check shows the full report instead of the one-line excerpt');
      touch(); summary('researcher', 'simple-polling', 'UI_FIXTURE_PROOF_SIMPLE_POLLING', true);
      await contains('UI_FIXTURE_PROOF_SIMPLE_POLLING');
      assert.equal(await group.locator(':scope > details').getAttribute('open'), '', 'Polling keeps the opened group');
      assert.equal(await failedCheck.getAttribute('open'), '', 'Polling keeps the opened check');
      await capture('simple-reading-opened', '[data-thinking-kind="actions"]');
      await question.click(); await settled(page);
      for (const line of copy.first.split('\n')) assert.ok((await composer.inputValue()).includes(`> ${line}`), 'The icon quotes the step into the draft');
      await composer.fill('');

      await chooseLevel('full');
      assert.equal(await thinking.locator('[data-thinking-work="plan"]').count(), 4, '详细 lists every saved record');
      assert.equal(await group.count(), 0); assert.equal(await thinking.locator('[data-thinking-kind="action"]').count(), 3);
      assert.ok((await thinking.innerText()).includes('UI_FIXTURE_PROOF_SIMPLE_TOOL_OUTPUT_0'), '详细 opens tool output');
      assert.ok(await thinking.locator('details[data-thinking-version]').count() > 0);
      assert.equal(await failedCheck.getAttribute('open'), ''); assert.equal(await brief.count(), 0);
      assert.equal(await question.innerText(), locale === 'zh' ? '追问这一步' : 'Ask about this step');
      assert.equal(await process.getAttribute('open'), '', '详细 opens the step checklist while the task runs');
      await capture('simple-switched-to-full');
      await chooseLevel('simple');
      assert.equal(await group.count(), 1); assert.equal(await group.locator(':scope > details').getAttribute('open'), null, 'Returning to 简洁 folds again');
      assert.equal(await failedCheck.getAttribute('open'), null); assert.equal(await brief.count(), 1);
      assert.equal(await process.getAttribute('open'), null);
      await page.reload({ timeout: 0 }); await failedCheck.waitFor(); await settled(page);
      assert.equal(await thinking.getAttribute('data-detail'), 'simple', 'The choice survives a refresh');

      // A long task shows its latest twelve rows; the rest is one click away.
      for (let index = 0; index < 20; index++) { touch(); summary('researcher', `simple-history-${index}`, `UI_FIXTURE_PROOF_SIMPLE_HISTORY_${index}`, true); }
      await contains('UI_FIXTURE_PROOF_SIMPLE_HISTORY_19'); await settled(page);
      assert.equal(await rows.count(), 12);
      const earlier = thinking.locator('.thinking-earlier'), hidden = Number((await earlier.innerText()).match(/\d+/u)![0]);
      await scrollBody('top'); await settled(page); await earlier.click();
      await page.waitForFunction(() => document.querySelector('[data-thinking-entry="prove:lead:public-summary"]'));
      await settled(page);
      // The count is in saved records: the folded line of three tools stands for three of them.
      assert.equal(await rows.count() + 2, 12 + hidden, 'The earlier count matches the records it reveals');
      await capture('simple-reading-history');

      stage = 'simple-search-context';
      // A context jump must reopen a manually folded group and reveal the matching action, beyond an open long output.
      await group.locator(':scope > details > summary').click(); await settled(page);
      const earlierTool = group.locator('[data-thinking-detail="prove:researcher:simple-tool-0"]');
      await earlierTool.locator(':scope > summary').click(); await settled(page);
      assert.equal(await earlierTool.getAttribute('open'), '');
      await group.locator(':scope > details > summary').click(); await settled(page);
      assert.equal(await group.locator(':scope > details').getAttribute('open'), null);
      await searchToggle.click(); await findRecords('UI_FIXTURE_PROOF_SIMPLE_TOOL_OUTPUT_1', 1);
      await thinking.locator('[data-thinking-context="prove:researcher:simple-tool-1"]').click(); await settled(page);
      assert.equal(await group.locator(':scope > details').getAttribute('open'), '', 'Search context reopens the manually folded tool group');
      const matchingTool = group.locator('[data-thinking-detail="prove:researcher:simple-tool-1"]');
      assert.equal(await matchingTool.getAttribute('open'), '', 'The matching action opens inside the group');
      assert.equal(await earlierTool.getAttribute('open'), '', 'The unrelated open action keeps its state');
      const contextBounds = await matchingTool.locator(':scope > summary').evaluate(node => {
        const body = node.closest('.thinking-body')!.getBoundingClientRect(), toolbar = node.closest('[data-thinking-process]')!.querySelector('.thinking-controls')!.getBoundingClientRect();
        const thread = document.querySelector('#research-chat-thread')!.getBoundingClientRect();
        return { top: node.getBoundingClientRect().top, visibleTop: Math.max(body.top, toolbar.bottom, thread.top),
          visibleBottom: Math.min(body.bottom, thread.bottom, innerHeight) };
      });
      assert.ok(contextBounds.top >= contextBounds.visibleTop - 4 && contextBounds.top < contextBounds.visibleBottom,
        `Search context reveals the matching action below the earlier output: ${JSON.stringify(contextBounds)}`);
      await capture('simple-search-context', '[data-thinking-detail="prove:researcher:simple-tool-1"]');
      await searchBack.click(); await settled(page);
      assert.equal(await query.inputValue(), 'UI_FIXTURE_PROOF_SIMPLE_TOOL_OUTPUT_1', 'Returning to search keeps the original query');
      assert.equal(await thinking.locator('[data-thinking-selected="true"]').getAttribute('data-thinking-entry'), 'prove:researcher:simple-tool-1');
      assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(external, []); assert.deepEqual(unexpectedApi, []); assert.deepEqual(runtimeCalls, []);
      checks.push({ scenario, defaultIsSimple: true, oneRecordPerTask: true, toolRunsGrouped: true, failedCheckFirstError: true,
        versionsOnlyInFull: true, checklistFoldedWhileRunning: true, levelSwitchBothWaysAndPersisted: true, latestTwelveRows: true,
        searchContextReopensGroup: true, searchContextRevealsMatchingAction: true, searchReturnKeepsQuery: true, contextBounds, hidden, rootScrollHeights });
      await context.close(); activeContext = undefined; activePage = undefined;
      continue;
    }

    stage = 'proof-started';
    event('solve_started', 'Synthetic proof run started.');
    event('turn_started', copy.first, { workerId: 'lead', role: 'lead', turn: 1 });
    summary('lead', 'public-summary', copy.first);
    action({ workerId: 'lead', itemId: 'raw-reasoning', kind: 'reasoning', phase: 'completed', status: 'done', text: hiddenReasoning });
    action({ workerId: 'lead', itemId: 'final-protocol', kind: 'message', phase: 'completed', status: 'done', text: JSON.stringify({ fixture: finalPayload }) });
    await page.goto(`${origin}/?chat=${conversation.id}`, { timeout: 0 });
    await contains(copy.first.split('\n')[1]!);
    assert.equal(await thinking.getAttribute('open'), '');
    assert.equal(await allFilter.getAttribute('aria-pressed'), 'true');
    assert.equal(await explanationsFilter.getAttribute('aria-pressed'), 'false');
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'true');
    assert.equal(await latest.isVisible(), false, 'A short log that follows the latest record needs no return control');
    assert.equal(await options.getAttribute('open'), null);
    assert.equal(await thinking.locator('[data-thinking-expand-all]').isVisible(), false, 'Low-frequency record options are hidden by default');
    await optionsToggle.click(); await settled(page);
    assert.equal(Number.parseInt(await options.locator('.thinking-options-menu p').innerText(), 10), await thinking.locator('[data-thinking-entry]').count(), 'Record options report the available entry count');
    await optionsToggle.press('Escape'); await settled(page);
    assert.equal(await options.getAttribute('open'), null, 'Escape closes record options');
    await optionsToggle.click(); await settled(page); await allFilter.click(); await settled(page);
    assert.equal(await options.getAttribute('open'), null, 'Clicking outside closes record options');
    const diagnostics = page.locator('[data-solve-process]');
    assert.equal(await diagnostics.getAttribute('open'), '');
    await diagnostics.locator(':scope > summary').click();
    assert.equal(await diagnostics.getAttribute('open'), null);
    assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false');
    await capture('proof-started');

    touch(); summary('lead', 'public-summary', copy.expanded);
    await contains(copy.expanded.split('\n')[1]!);
    assert.equal(await thinking.locator('[data-thinking-entry="prove:lead:public-summary"]').count(), 1, 'One saved public summary replaces its streaming snapshot');
    assert.ok((await thinking.locator('[data-thinking-entry="prove:lead:public-summary"] .thinking-entry-meta').innerText()).includes('Lead'));
    await capture('proof-streaming');

    stage = 'proof-markdown-code-copy';
    const summaryEntry = thinking.locator('[data-thinking-entry="prove:lead:public-summary"]');
    const entriesBeforeCode = await thinking.locator('[data-thinking-entry]').count();
    const markdownSource = ['-- UI_FIXTURE_SHARED_MARKDOWN_CODE', ...Array.from({ length: 23 }, (_, index) =>
      `theorem ui_fixture_markdown_${index + 1} : True := by trivial`), '-- UI_FIXTURE_SHARED_MARKDOWN_CODE_TAIL'].join('\n');
    await composer.fill(`UI_FIXTURE_CODE_COPY_DRAFT_${locale}\nPreserve this unsent question while copying Lean.`);
    touch(); summary('lead', 'public-summary', `${copy.expanded}\n\n\`\`\`lean\n${markdownSource}\n\`\`\``);
    const markdownCode = summaryEntry.locator('.chat-code');
    await markdownCode.waitFor(); await settled(page);
    assert.equal(await thinking.locator('[data-thinking-entry]').count(), entriesBeforeCode, 'A temporary Markdown code sample updates the existing public record');
    assert.equal(await summaryEntry.locator('.route-item-note').count(), 0, 'An 18-line code preview does not mean the public record was clipped');
    const markdownPreview = markdownSource.split('\n').slice(0, 18).join('\n');
    assert.equal(await markdownCode.locator('pre code').textContent(), markdownPreview, 'Shared Markdown code still starts with exactly eighteen source lines');
    const markdownToggle = markdownCode.locator('[data-chat-code-toggle]');
    assert.equal(await markdownToggle.getAttribute('aria-expanded'), 'false');
    await expectCodeCopy(markdownCode, markdownSource, 'collapsed Markdown code', markdownPreview);
    await markdownToggle.click(); await settled(page);
    assert.equal(await markdownToggle.getAttribute('aria-expanded'), 'true');
    await expectCodeCopy(markdownCode, markdownSource, 'expanded Markdown code');
    await markdownToggle.click(); await settled(page);
    assert.equal(await markdownCode.locator('pre code').textContent(), markdownPreview, 'Collapsing a shared code block restores its original eighteen-line preview');
    touch(); summary('lead', 'public-summary', copy.expanded);
    await page.waitForFunction(() => !document.querySelector('[data-thinking-entry="prove:lead:public-summary"] .chat-code'));
    await contains(copy.expanded.split('\n')[1]!);
    assert.equal(await thinking.locator('[data-thinking-entry]').count(), entriesBeforeCode);
    assert.equal(await summaryEntry.locator('.route-item-note').count(), 0);
    if (await latest.isVisible()) await latest.click();

    touch();
    run.observation!.plan = { schema: 'theorem-os.research-plan.v1', baseVersion: 'v1', tasks };
    run.observation!.inspection.planVersion = 'v1'; run.observation!.inspection.tasks = tasks.map(inspected);
    run.observation!.inspection.tasks.find(task => task.id === 'left-zero')!.status = 'running';
    event('plan_updated', copy.plan, { workerId: 'lead', role: 'lead' });
    event('task_assigned', copy.research, { workerId: 'researcher', role: 'researcher', taskId: 'research' });
    event('task_assigned', copy.left, { workerId: 'engineer', role: 'engineer', taskId: 'left-zero' });
    summary('lead', 'public-summary', copy.expanded, true);
    summary('researcher', 'research-summary', copy.researcherSummary);
    summary('engineer', 'proof-summary', copy.engineerSummary);
    action({ workerId: 'lead', itemId: 'public-plan', kind: 'plan', phase: 'completed', status: 'done', text: copy.plan });
    action({ workerId: 'researcher', itemId: 'find-zero-lemmas', kind: 'command', phase: 'completed', status: 'done',
      command: "theorem-os search-lean --query 'Nat.add_zero' --query 'Nat.zero_add'", output: 'Synthetic search output. UI_FIXTURE_PROOF_SEARCH_OUTPUT_TAIL',
      found: [{ query: 'Nat.add_zero', total: 1, names: ['Nat.add_zero'] }, { query: 'Nat.zero_add', total: 1, names: ['Nat.zero_add'] }] });
    await contains(copy.researcherSummary.split('\n')[1]!); await contains(copy.engineerSummary.split('\n')[1]!);
    assert.ok((await thinking.locator('[data-thinking-entry="prove:researcher:research-summary"] .thinking-entry-meta').innerText()).includes('Researcher'));
    assert.ok((await thinking.locator('[data-thinking-entry="prove:engineer:proof-summary"] .thinking-entry-meta').innerText()).includes('Engineer'));
    const search = thinking.locator('[data-thinking-detail="prove:researcher:find-zero-lemmas"]');
    await search.waitFor(); assert.equal(await search.getAttribute('open'), '');
    assert.ok((await search.innerText()).includes('UI_FIXTURE_PROOF_SEARCH_OUTPUT_TAIL'));
    assert.equal(await thinking.locator('[data-thinking-work="plan"]').count(), 4, 'The real saved plan appears as four readable task records');
    const goalPlan = thinking.locator('[data-thinking-work="plan"][data-thinking-task="goal"]');
    assert.ok((await goalPlan.innerText()).includes(copy.goal));
    assert.ok((await goalPlan.innerText()).includes(copy.blueprint));
    assert.ok((await goalPlan.innerText()).includes('n : Nat'));
    for (const dependency of [copy.left, copy.right]) assert.ok((await goalPlan.innerText()).includes(dependency), 'Dependencies use their saved objectives');
    assert.equal(await goalPlan.locator('.thinking-work-sections pre code').textContent(), '(n : Nat) : n + 0 = n ∧ 0 + n = n');
    assert.equal(await goalPlan.locator('[data-thinking-detail]').getAttribute('open'), '');
    assert.equal(await goalPlan.locator(`.thinking-work-ref code[title="${taskVersion(tasks.find(task => task.id === 'goal')!)}"]`).count(), 1);
    const goalVersion = taskVersion(tasks.find(task => task.id === 'goal')!);
    const goalVersions = goalPlan.locator('details[data-thinking-version]'), goalVersionSummary = goalVersions.locator(':scope > summary');
    assert.equal(await goalVersions.getAttribute('open'), null, 'Version metadata starts folded while the mathematical details stay open');
    assert.equal(await goalVersionSummary.getAttribute('aria-label'), locale === 'zh' ? '查看任务 goal 的完整版本' : 'View the full version of task goal');
    assert.ok((await goalVersionSummary.innerText()).includes(locale === 'zh' ? '当前任务版本' : 'Current task version'));
    await goalVersionSummary.focus(); await goalVersionSummary.press('Enter'); await settled(page);
    assert.equal(await goalVersions.getAttribute('open'), '');
    assert.ok(await goalVersionSummary.evaluate(node => document.activeElement === node), 'Keyboard expansion keeps focus on the native summary');
    assert.equal(await goalPlan.locator('[data-thinking-detail]').getAttribute('open'), '', 'Opening metadata does not fold the mathematical explanation');
    await expectVersionCopy(goalVersions, 'task', goalVersion);
    await goalVersionSummary.press('Space'); await settled(page);
    assert.equal(await goalVersions.getAttribute('open'), null, 'Space closes the native version disclosure');
    assert.equal(await goalPlan.locator('[data-thinking-detail]').getAttribute('open'), '');
    const planCode = goalPlan.locator('.thinking-work-sections .chat-code');
    assert.equal(await planCode.locator('[data-chat-code-toggle]').count(), 0, 'The saved Lean statement is fully displayed in the expanded work details');
    await expectCodeCopy(planCode, '(n : Nat) : n + 0 = n ∧ 0 + n = n', 'saved plan statement');
    const workTypography = await thinking.locator('[data-thinking-work="proof"][data-thinking-task="left-zero"]').evaluate(node => {
      const role = node.querySelector('.thinking-role')!, time = node.querySelector('.thinking-entry-meta time')!;
      const title = node.querySelector('.thinking-work-head strong')!, status = node.querySelector('.thinking-work-head>span')!;
      const text = node.querySelector('.chat-message-content')!, roleBox = role.getBoundingClientRect(), timeBox = time.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect(), statusBox = status.getBoundingClientRect();
      return { roleSize: parseFloat(getComputedStyle(role).fontSize), roleWeight: Number(getComputedStyle(role).fontWeight),
        titleSize: parseFloat(getComputedStyle(title).fontSize), bodySize: parseFloat(getComputedStyle(text).fontSize),
        metaFits: roleBox.right <= timeBox.left + 1 || timeBox.top >= roleBox.bottom - 1,
        stateFits: titleBox.right <= statusBox.left + 1 || statusBox.top >= titleBox.bottom - 1 };
    });
    assert.ok(workTypography.roleSize >= 12 && workTypography.roleWeight >= 600 && workTypography.titleSize >= 14 && workTypography.bodySize >= 14,
      `Roles and mathematical explanations have readable type: ${JSON.stringify(workTypography)}`);
    assert.ok(workTypography.metaFits && workTypography.stateFits, 'Roles, timestamps, work titles and statuses do not overlap');
    await composer.fill(''); await settled(page);
    await capture('proof-plan-and-roles', '[data-thinking-work="plan"][data-thinking-task="goal"]');

    stage = 'proof-step-question';
    await settled(page);
    const emptyComposerHeight = await composer.evaluate(node => node.getBoundingClientRect().height);
    const expectQuoteCount = async (count: number) => {
      await settled(page);
      if (count === 0) {
        assert.equal(await quoteBar.count(), 0, 'No complete automatic quote remains available to undo');
        assert.equal(await quoteUndo.count(), 0);
      } else {
        assert.equal(await quoteBar.locator('[data-chat-quote-count]').getAttribute('data-chat-quote-count'), String(count));
        assert.equal(await quoteUndo.isVisible(), true);
      }
    };
    const expectComposerEnd = async () => {
      assert.ok(await composer.evaluate(node => {
        const input = node as HTMLTextAreaElement;
        return document.activeElement === input && input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      }), 'Undo returns focus and the caret to the end of the discussion draft');
      assert.ok(await composer.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop <= 2),
        'An explicit quote or undo action reveals the end of the discussion draft');
    };
    const originalDraft = `UI_FIXTURE_PROOF_QUESTION_DRAFT_${locale}\n\nKeep this existing paragraph exactly as typed.\n\n${Array.from({ length: 14 }, (_, index) =>
      `Draft paragraph ${index + 1}: K = K_0 ⊆ K_1 ⊆ ⋯ ⊆ K_m, K_i = K_{i−1}(α_i), α_i^{n_i} ∈ K_{i−1}.\n> Preserve this quoted mathematics paragraph and the question being edited.`).join('\n\n')}`;
    await composer.fill(originalDraft);
    const summaryQuestion = thinking.locator('[data-thinking-question="prove:lead:public-summary"]');
    const summaryAt = await thinking.locator('[data-thinking-entry="prove:lead:public-summary"] time').getAttribute('datetime');
    assert.equal(await summaryQuestion.innerText(), locale === 'zh' ? '追问这一步' : 'Ask about this step');
    await summaryQuestion.click(); await settled(page);
    const summaryDraft = await composer.inputValue();
    assert.ok(summaryDraft.endsWith(originalDraft), 'Quoting a step preserves the existing discussion draft verbatim');
    for (const line of copy.expanded.split('\n')) assert.ok(summaryDraft.includes(`> ${line}`), 'The quote uses the current streamed public summary');
    assert.ok(summaryDraft.includes('Lead'));
    assert.ok(summaryAt && summaryDraft.includes(summaryAt), 'The quote keeps the original record timestamp');
    assert.equal(await page.locator('[data-chat-guidance-mode]').count(), 0, 'Asking about a step stays in ordinary discussion');
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'false', 'Asking pauses automatic progress following');
    assert.ok(await composer.evaluate(node => {
      const input = node as HTMLTextAreaElement;
      return document.activeElement === input && input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    }));
    assert.ok(await composer.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop <= 2), 'The discussion caret and viewport reach the end of the draft');
    await summaryQuestion.click(); await settled(page);
    assert.equal(await composer.inputValue(), summaryDraft, 'Repeating the same step quote does not duplicate it');
    await expectQuoteCount(1);
    assert.equal(await thinking.locator('[data-thinking-kind="action"] [data-thinking-question], [data-thinking-kind="check"] [data-thinking-question]').count(), 0,
      'Tool operations and checks do not offer a discussion quote');
    await capture('proof-step-question', undefined, true);

    await goalPlan.locator('[data-thinking-detail] > summary').click(); await settled(page);
    assert.equal(await goalPlan.locator('[data-thinking-detail]').getAttribute('open'), null);
    await goalPlan.locator('[data-thinking-question]').click(); await settled(page);
    const workDraft = await composer.inputValue();
    await expectQuoteCount(2);
    assert.ok((await quoteBar.innerText()).includes(locale === 'zh' ? '已引用 2 条记录' : 'Quoted records: 2'));
    assert.equal(await quoteUndo.innerText(), locale === 'zh' ? '撤回上次引用' : 'Undo last quote');
    assert.ok(workDraft.endsWith(summaryDraft), 'The saved work quote is inserted before the existing draft');
    for (const value of ['goal', goalVersion, copy.goal, copy.blueprint, 'n : Nat', copy.left, copy.right, '(n : Nat) : n + 0 = n ∧ 0 + n = n'])
      assert.ok(workDraft.includes(value), `A work quote includes saved metadata and folded sections: ${value}`);
    assert.equal(await goalPlan.locator('[data-thinking-detail]').getAttribute('open'), null, 'Quoting folded work leaves its details folded');
    assert.ok(await composer.evaluate(node => {
      const input = node as HTMLTextAreaElement;
      return document.activeElement === input && input.selectionEnd === input.value.length;
    }));
    const composerPosition = () => composer.evaluate(node => {
      const input = node as HTMLTextAreaElement;
      return { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection,
        top: input.scrollTop, maximumTop: input.scrollHeight - input.clientHeight, length: input.value.length,
        focused: document.activeElement === input };
    });
    type ComposerPosition = Awaited<ReturnType<typeof composerPosition>>;
    const draftEditingPositions: { checkpoint: string; before: ComposerPosition; after: ComposerPosition; scrollDelta: number }[] = [];
    const selectDraftPosition = async (fraction: number, direction: 'forward' | 'backward') => {
      await composer.focus();
      await composer.evaluate((node, fraction) => {
        const input = node as HTMLTextAreaElement, start = Math.floor(input.value.length * fraction);
        input.setSelectionRange(start, start);
      }, fraction);
      // Native caret movement reveals the selected paragraph inside the overflowing textarea.
      await composer.press('ArrowRight');
      await composer.evaluate((node, direction) => {
        const input = node as HTMLTextAreaElement, start = input.selectionStart;
        input.setSelectionRange(start, start + 13, direction);
      }, direction);
      await settled(page);
      const position = await composerPosition();
      assert.ok(position.start > 0 && position.end < position.length && position.top > 0 && position.top < position.maximumTop,
        `The fixture edits a middle paragraph in a long draft: ${JSON.stringify(position)}`);
      assert.equal(position.direction, direction);
      return position;
    };
    const expectDraftPosition = async (before: ComposerPosition, checkpoint: string, focused?: boolean) => {
      await settled(page);
      const after = await composerPosition(), scrollDelta = after.top - before.top;
      assert.deepEqual({ start: after.start, end: after.end, direction: after.direction },
        { start: before.start, end: before.end, direction: before.direction }, `${checkpoint}: editing selection`);
      assert.ok(Math.abs(scrollDelta) <= 1, `${checkpoint}: textarea scroll position ${JSON.stringify({ before, after, scrollDelta })}`);
      if (focused !== undefined) assert.equal(after.focused, focused, `${checkpoint}: restoring a position does not steal focus`);
      draftEditingPositions.push({ checkpoint, before, after, scrollDelta });
    };
    const composerSettings = page.locator('#formalize-settings > summary');
    const openWithoutComposerFocus = async (id: string) => {
      await composerSettings.focus(); await openConversation(id);
      assert.ok(await composerSettings.evaluate(node => document.activeElement === node), 'Restoring a draft keeps focus on the existing settings control');
    };
    await goalVersionSummary.click(); await settled(page);
    assert.equal(await goalVersions.getAttribute('open'), '');
    assert.equal(await goalPlan.locator('[data-thinking-detail]').getAttribute('open'), null, 'Version metadata can remain open while the mathematics is folded');
    const quotedDraftPosition = await selectDraftPosition(0.47, 'backward');
    const readsBeforeQuote = detailReads;
    touch(); summary('lead', 'public-summary', copy.expanded, true);
    while (detailReads <= readsBeforeQuote) await settled(page);
    assert.equal(await composer.inputValue(), workDraft, 'Polling preserves the editable quoted draft');
    await expectQuoteCount(2);
    assert.ok(await composer.evaluate(node => document.activeElement === node), 'Polling preserves discussion input focus');
    await expectDraftPosition(quotedDraftPosition, 'polling a quoted long draft', true);
    assert.equal(await goalVersions.getAttribute('open'), '', 'Polling preserves the independent version disclosure');
    await openWithoutComposerFocus(stoppedConversation.id);
    assert.equal(await composer.inputValue(), '', 'A quote draft does not leak into a different conversation');
    await expectQuoteCount(0);
    assert.equal(await thinking.locator('[data-thinking-version][open]').count(), 0, 'A different proof does not inherit an open version disclosure');
    const otherDraft = `UI_FIXTURE_OTHER_CONVERSATION_DRAFT_${locale}\n\n${Array.from({ length: 17 }, (_, index) =>
      `Other conversation paragraph ${index + 1}: preserve this independent draft, its selection and internal scroll position.\n> A separate mathematics question: G_i/G_{i+1} is abelian.`).join('\n\n')}`;
    await composer.fill(otherDraft);
    const otherDraftPosition = await selectDraftPosition(0.63, 'forward');
    await openWithoutComposerFocus(conversation.id);
    await thinking.waitFor();
    assert.equal(await composer.inputValue(), workDraft, 'SPA conversation navigation restores the complete quoted draft');
    await expectQuoteCount(2);
    await expectDraftPosition(quotedDraftPosition, 'SPA return to the quoted draft', false);
    assert.equal(await goalVersions.getAttribute('open'), '', 'Returning to the proof restores its open version disclosure');
    await openWithoutComposerFocus(stoppedConversation.id);
    assert.equal(await composer.inputValue(), otherDraft, 'Each conversation restores its own independent long draft');
    await expectDraftPosition(otherDraftPosition, 'SPA return to the other long draft', false);

    await composer.fill(''); await settled(page);
    const clearedDraftPosition = await composerPosition();
    assert.deepEqual({ start: clearedDraftPosition.start, end: clearedDraftPosition.end, top: clearedDraftPosition.top }, { start: 0, end: 0, top: 0 });
    await openWithoutComposerFocus(conversation.id);
    await expectDraftPosition(quotedDraftPosition, 'main draft after clearing another conversation', false);
    await openWithoutComposerFocus(stoppedConversation.id);
    assert.equal(await composer.inputValue(), '', 'A cleared draft remains empty on return');
    await expectDraftPosition(clearedDraftPosition, 'a cleared draft never restores an old position', false);

    await composer.fill(otherDraft); await selectDraftPosition(0.61, 'backward');
    const replacementDraft = `UI_FIXTURE_REPLACEMENT_DRAFT_${locale}`;
    await composer.fill(replacementDraft); await settled(page);
    const replacementDraftPosition = await composerPosition();
    assert.equal(replacementDraftPosition.top, 0, 'Replacing the long draft with a short draft removes its old internal scroll');
    await openWithoutComposerFocus(conversation.id);
    await expectDraftPosition(quotedDraftPosition, 'main draft after replacing another conversation', false);
    await openWithoutComposerFocus(stoppedConversation.id);
    assert.equal(await composer.inputValue(), replacementDraft);
    await expectDraftPosition(replacementDraftPosition, 'a replacement draft never restores an old position', false);
    await composer.fill(''); await settled(page);
    await openWithoutComposerFocus(conversation.id); await thinking.waitFor();
    await expectDraftPosition(quotedDraftPosition, 'independent positions after cleaning the other draft', false);
    await page.reload({ timeout: 0 });
    await contains(copy.expanded.split('\n')[1]!); await goalPlan.waitFor(); await settled(page);
    assert.equal(await composer.inputValue(), workDraft, 'Refreshing restores the editable quoted draft');
    await expectQuoteCount(2);
    await expectDraftPosition(quotedDraftPosition, 'refresh restores the quoted draft editing position', false);
    await capture('proof-draft-editing-position', undefined, true);
    await page.locator('[data-chat-guidance-mode-open]').click(); await settled(page);
    assert.equal(await page.locator('[data-chat-guidance-mode]').count(), 1);
    assert.equal(await thinking.locator('[data-thinking-question]').count(), 0, 'Guidance mode hides ordinary discussion quote actions');
    assert.equal(await quoteBar.count(), 0, 'Guidance mode hides the discussion quote undo controls');
    assert.equal(await quoteUndo.count(), 0);
    assert.equal(await composer.inputValue(), workDraft);
    await page.locator('[data-chat-guidance-target]').selectOption('goal');
    assert.equal(await page.locator('[data-chat-guidance-target]').inputValue(), 'goal', 'The existing task guidance selector keeps its meaning');
    await page.locator('[data-chat-guidance-cancel]').click(); await settled(page);
    assert.equal(await page.locator('[data-chat-guidance-mode]').count(), 0);
    assert.ok(await summaryQuestion.isVisible(), 'Returning to discussion restores step questions');
    assert.equal(await composer.inputValue(), workDraft, 'Leaving guidance mode preserves the discussion draft');
    await expectQuoteCount(2);

    stage = 'proof-step-quote-undo';
    const laterInput = '\n\nUI_FIXTURE_PROOF_LATER_QUESTION\nPreserve the question I added after quoting both steps.';
    await composer.fill(`${workDraft}${laterInput}`);
    await expectQuoteCount(2);
    await quoteUndo.click(); await settled(page);
    assert.equal(await composer.inputValue(), `${summaryDraft}${laterInput}`, 'Undo removes the most recent work quote and preserves the existing question and later input');
    await expectQuoteCount(1); await expectComposerEnd();
    await capture('proof-step-quote-undo', undefined, true);
    await quoteUndo.click(); await settled(page);
    assert.equal(await composer.inputValue(), `${originalDraft}${laterInput}`, 'The second undo removes only the remaining automatic summary quote');
    await expectQuoteCount(0); await expectComposerEnd();

    await summaryQuestion.click(); await settled(page);
    await goalPlan.locator('[data-thinking-question]').click(); await settled(page);
    await expectQuoteCount(2);
    const draftBeforeEdit = await composer.inputValue();
    const editedQuoteDraft = draftBeforeEdit.replace(goalVersion, `UI_FIXTURE_USER_EDITED_${goalVersion}`);
    assert.notEqual(editedQuoteDraft, draftBeforeEdit, 'The fixture edits the automatically quoted task version');
    await composer.fill(editedQuoteDraft); await expectQuoteCount(0);
    assert.equal(await composer.inputValue(), editedQuoteDraft, 'Editing an automatic quote disables unsafe undo and preserves the text verbatim');

    await composer.fill(''); await expectQuoteCount(0);
    await summaryQuestion.click(); await settled(page);
    await expectQuoteCount(1);
    await quoteUndo.click(); await settled(page);
    assert.equal(await composer.inputValue(), '', 'Undoing a quote inserted into an empty draft restores the empty draft');
    await expectQuoteCount(0); await expectComposerEnd();
    const restoredComposerHeight = await composer.evaluate(node => node.getBoundingClientRect().height);
    assert.ok(Math.abs(restoredComposerHeight - emptyComposerHeight) <= 1,
      `Removing the last quote restores the natural empty composer height: ${JSON.stringify({ emptyComposerHeight, restoredComposerHeight })}`);
    assert.deepEqual(writes, [], 'Preparing and navigating a step question sends no request');
    assert.equal(conversation.messages.length, 2, 'Quoting never appends or sends a conversation message');
    await composer.fill('');
    if (!await goalPlan.locator('[data-thinking-detail]').evaluate(node => (node as HTMLDetailsElement).open))
      await goalPlan.locator('[data-thinking-detail] > summary').click();
    if (await latest.isVisible()) await latest.click();
    await settled(page);

    const observationOnlyBefore = { updatedAt: run.updatedAt, events: run.events.length, actions: actions.length };
    const research = run.observation!.inspection.tasks.find(task => task.id === 'research')!;
    const findingProtocol = JSON.stringify({ schema: 'synthetic-ui-research-finding', summary: copy.finding, conclusion: 'supporting',
      statement: copy.research, premises: ['n : Nat'], remainingObligations: [copy.outstanding], privateProtocolField: finalPayload });
    Object.assign(research, { status: 'completed', finding: findingProtocol });
    run.observation!.sequence++;
    run.observation!.inspection.progress.completedResearchTasks = 1;
    await contains(copy.finding);
    assert.deepEqual({ updatedAt: run.updatedAt, events: run.events.length, actions: actions.length }, observationOnlyBefore,
      'The finding arrives through observation.sequence alone, without a timestamp, event, action or commentary update');
    const researchWork = thinking.locator('[data-thinking-work="research"][data-thinking-task="research"]');
    assert.equal(await researchWork.count(), 1);
    for (const value of [copy.finding, copy.research, copy.outstanding, 'n : Nat']) assert.ok((await researchWork.innerText()).includes(value));
    assert.ok(!(await researchWork.innerText()).includes('synthetic-ui-research-finding'), 'The research protocol schema stays out of readable prose');
    await capture('proof-observation-only-finding', '[data-thinking-work="research"][data-thinking-task="research"]');

    stage = 'proof-history-anchor';
    await chooseRecords(false);
    if (await thinking.getAttribute('data-thinking-following') !== 'true') await latest.click();
    await page.waitForFunction(() => document.querySelector('[data-thinking-process]')?.getAttribute('data-thinking-following') === 'true');
    for (let index = 0; index < 44; index++) {
      touch(); summary('researcher', `history-${index}`, `${copy.research} Synthetic saved record ${index + 1}. UI_FIXTURE_PROOF_HISTORY_${index}`, true);
    }
    await contains('UI_FIXTURE_PROOF_HISTORY_43');
    assert.equal(await thinking.locator('[data-thinking-entry]').count(), 40, 'A long proof initially mounts its latest forty records');
    await scrollBody('top');
    await settled(page);
    const historyAnchor = await thinkingBody.evaluate(body => {
      const entry = body.querySelector<HTMLElement>('.thinking-entries > [data-thinking-entry]')!;
      return { id: entry.dataset.thinkingEntry!, top: entry.getBoundingClientRect().top - body.getBoundingClientRect().top };
    });
    stage = 'proof-search-results';
    assert.equal(await search.count(), 0, 'The older search tool lies outside the mounted forty-record window');
    const outsideShortcut = await page.locator('textarea').first().evaluate(node => {
      (node as HTMLTextAreaElement).focus();
      const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
      node.dispatchEvent(event); return event.defaultPrevented;
    });
    assert.equal(outsideShortcut, false, 'The thinking shortcut leaves focus outside its region alone');
    assert.equal(await query.count(), 0);
    await thinkingBody.focus(); await thinkingBody.press('Control+f'); await settled(page);
    assert.ok(await query.evaluate(node => document.activeElement === node), 'Control+F in the log opens and focuses its search');
    await findRecords('ui_fixture_proof_search_output_tail', 1);
    const searchEntry = thinking.locator('[data-thinking-entry="prove:researcher:find-zero-lemmas"]');
    assert.equal(await search.getAttribute('open'), null, 'Searching keeps globally collapsed tool details folded');
    assert.ok((await searchEntry.locator('[data-thinking-match]').innerText()).includes('UI_FIXTURE_PROOF_SEARCH_OUTPUT_TAIL'),
      'A safe snippet explains a match inside folded, previously unmounted output');
    assert.equal((await searchEntry.locator('[data-thinking-match] mark').textContent())?.toLowerCase(), 'ui_fixture_proof_search_output_tail');
    assert.equal(await thinking.locator('mark').count(), await thinking.locator('[data-thinking-match] mark').count(), 'Highlighting stays in the plain-text snippets');
    await query.press('Meta+f'); await settled(page);
    assert.deepEqual(await query.evaluate(node => ({ start: (node as HTMLInputElement).selectionStart, end: (node as HTMLInputElement).selectionEnd })),
      { start: 0, end: 'ui_fixture_proof_search_output_tail'.length }, 'Command+F selects the current query');
    const readsBeforeSearch = detailReads;
    touch(); summary('lead', 'public-summary', copy.expanded, true);
    await page.waitForFunction(() => document.querySelector('[data-thinking-process]')?.getAttribute('data-thinking-following') === 'false');
    while (detailReads <= readsBeforeSearch) await settled(page);
    assert.equal(await query.inputValue(), 'ui_fixture_proof_search_output_tail', 'Polling preserves the search input');
    assert.equal(await thinking.locator('[data-thinking-entry]').count(), 1);
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'false');
    await capture('proof-search-results');
    for (const excluded of ['UI_FIXTURE_NO_SAVED_RECORD_MATCH', hiddenReasoning, finalPayload]) {
      await findRecords(excluded, 0);
      assert.equal(await thinking.locator('.thinking-empty').isVisible(), true, 'An unmatched or private record has an explicit empty state');
      assert.equal(await previousMatch.isDisabled(), true);
      assert.equal(await nextMatch.isDisabled(), true);
    }
    const publicHeading = copy.first.split('\n')[0]!.replaceAll('**', '');
    await findRecords(publicHeading, 1);
    assert.equal(await thinking.locator('[data-thinking-entry="prove:lead:public-summary"] strong').textContent(), publicHeading,
      'Search highlighting preserves the saved Markdown heading');
    assert.equal(await thinking.locator('.thinking-summary strong mark').count(), 0);

    stage = 'proof-search-navigation';
    await query.fill('UI_FIXTURE_PROOF_HISTORY_'); await settled(page);
    assert.equal(await thinking.locator('[data-thinking-entry]').count(), 40, 'A new broad query initially mounts the latest forty results');
    assert.equal(Number.parseInt(await thinking.locator('.thinking-search-count').innerText(), 10), 44);
    assert.equal(await thinking.locator('[data-thinking-selected="true"]').count(), 0, 'A new query has no selected result');
    assert.equal(await previousMatch.isDisabled(), false); assert.equal(await nextMatch.isDisabled(), false);
    assert.ok((await previousMatch.getAttribute('title'))?.includes('Shift+Enter'));
    assert.ok((await nextMatch.getAttribute('title'))?.includes('Enter'));
    await query.press('Enter'); await expectSelectedMatch(0, 'input');
    await nextMatch.click(); await expectSelectedMatch(1, 'next');
    await previousMatch.click(); await expectSelectedMatch(0, 'previous');
    await previousMatch.click(); await expectSelectedMatch(43, 'previous');
    await query.press('Enter'); await expectSelectedMatch(0, 'input');
    const ignoredNavigation = await query.evaluate(node => {
      const events = [new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }),
        new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }),
        ...['ctrlKey', 'metaKey', 'altKey'].map(modifier => new KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, bubbles: true, cancelable: true }))];
      return events.map(event => { node.dispatchEvent(event); return event.defaultPrevented; });
    });
    assert.deepEqual(ignoredNavigation, [false, false, false, false, false], 'IME and modified Enter keys keep their existing behavior');
    await expectSelectedMatch(0, 'input');
    touch(); summary('researcher', 'history-0', `${copy.research} Synthetic saved record 1. UI_FIXTURE_PROOF_HISTORY_0\n\nUI_FIXTURE_PROOF_NAVIGATION_POLL`, true);
    await contains('UI_FIXTURE_PROOF_NAVIGATION_POLL');
    await expectSelectedMatch(0, 'input');
    await thinking.locator(':scope > summary').click(); await settled(page);
    assert.equal(await thinking.getAttribute('open'), null);
    await thinking.locator(':scope > summary').click(); await settled(page);
    assert.equal(await query.inputValue(), 'UI_FIXTURE_PROOF_HISTORY_');
    await expectSelectedMatch(0, undefined, false);
    await openConversation(stoppedConversation.id);
    await thinking.waitFor();
    assert.equal(await query.count(), 0, 'Another task does not inherit the active search');
    await openConversation(conversation.id); await thinking.waitFor();
    assert.equal(await query.inputValue(), 'UI_FIXTURE_PROOF_HISTORY_');
    await expectSelectedMatch(0, undefined, false);
    await query.press('Shift+Enter'); await expectSelectedMatch(43, 'input');
    await query.press('Enter'); await expectSelectedMatch(0, 'input');
    const navigationReading = await thinking.locator('[data-thinking-selected="true"]').evaluate(entry =>
      entry.getBoundingClientRect().top - entry.closest('.thinking-body')!.getBoundingClientRect().top);
    await thinking.locator('[data-thinking-selected="true"] [data-thinking-context]').click(); await settled(page);
    assert.equal(await searchBack.isVisible(), true, 'Viewing a result in context provides a return to the same search');
    assert.equal(await searchToggle.count(), 0);
    await searchBack.click(); await settled(page);
    assert.equal(await query.inputValue(), 'UI_FIXTURE_PROOF_HISTORY_');
    assert.equal(await allFilter.getAttribute('aria-pressed'), 'true');
    await expectSelectedMatch(0, 'input');
    searchReturnReadingDelta = Math.abs(await thinking.locator('[data-thinking-selected="true"]').evaluate(entry =>
      entry.getBoundingClientRect().top - entry.closest('.thinking-body')!.getBoundingClientRect().top) - navigationReading);
    assert.ok(searchReturnReadingDelta <= 4, `Returning to a multi-result search restores its result reading anchor: ${searchReturnReadingDelta}px`);
    await capture('proof-search-navigation', undefined, true);
    await findRecords('UI_FIXTURE_PROOF_NAVIGATION_NO_MATCH', 0);
    assert.equal(await thinking.locator('[data-thinking-selected="true"]').count(), 0, 'Editing a query resets its selected result');
    assert.equal(await thinking.locator('[data-thinking-search-position]').count(), 0);
    assert.equal(await previousMatch.isDisabled(), true); assert.equal(await nextMatch.isDisabled(), true);
    await query.fill(''); await settled(page);
    assert.equal(await thinking.locator('[data-thinking-selected="true"]').count(), 0, 'Clearing the query resets the selected result');
    assert.equal(await thinking.locator('[data-thinking-search-position]').count(), 0);
    assert.equal(await previousMatch.isDisabled(), true); assert.equal(await nextMatch.isDisabled(), true);
    assert.equal(await thinking.locator('[data-thinking-entry]').count(), 40);
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'false', 'Clearing a query keeps reading paused');
    await findRecords('ui_fixture_proof_search_output_tail', 1);
    await searchClose.click(); await settled(page);
    assert.equal(await query.count(), 0);
    assert.ok(await thinkingBody.evaluate(node => document.activeElement === node), 'Ending search returns focus to the log');
    const afterSearchTop = await thinking.locator(`[data-thinking-entry="${historyAnchor.id}"]`).evaluate(entry =>
      entry.getBoundingClientRect().top - entry.closest('.thinking-body')!.getBoundingClientRect().top);
    searchAnchorDelta = Math.abs(afterSearchTop - historyAnchor.top);
    assert.ok(searchAnchorDelta <= 4, `Ending search restores the original reading anchor: ${searchAnchorDelta}px`);
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'false');
    await searchToggle.click(); await findRecords('ui_fixture_proof_search_output_tail', 1);
    await query.press('Escape'); await settled(page);
    assert.equal(await query.count(), 0, 'Escape ends search');
    assert.ok(await thinkingBody.evaluate(node => document.activeElement === node));
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'false');

    await searchToggle.click(); await findRecords('ui_fixture_proof_search_output_tail', 1);
    const toolResultReading = await searchEntry.evaluate(entry =>
      entry.getBoundingClientRect().top - entry.closest('.thinking-body')!.getBoundingClientRect().top);
    await searchEntry.locator('[data-thinking-context]').click(); await settled(page);
    assert.equal(await query.count(), 0, 'Viewing context ends the search');
    assert.equal(await allFilter.getAttribute('aria-pressed'), 'true', 'Viewing context preserves the current record scope');
    assert.ok(await thinking.locator('[data-thinking-entry]').count() > 1, 'The old matching record is mounted with its surrounding saved records');
    assert.equal(await search.getAttribute('open'), '', 'Viewing context opens the chosen tool');
    assert.ok((await search.innerText()).includes('UI_FIXTURE_PROOF_SEARCH_OUTPUT_TAIL'));
    assert.ok((await search.innerText()).includes("theorem-os search-lean --query 'Nat.add_zero' --query 'Nat.zero_add'"));
    assert.equal(await search.locator('mark').count(), 0, 'Viewing context keeps command and output DOM intact');
    assert.equal(await thinking.locator('[data-thinking-detail][open]').count(), 1, 'Viewing context leaves other records and the global folded mode intact');
    assert.ok(await thinkingBody.evaluate(node => document.activeElement === node));
    const contextPosition = await searchEntry.evaluate(entry => {
      const body = entry.closest('.thinking-body')!.getBoundingClientRect();
      const toolbar = entry.closest('[data-thinking-process]')!.querySelector('.thinking-controls')!.getBoundingClientRect();
      const thread = document.querySelector('#research-chat-thread')!.getBoundingClientRect();
      const item = entry.getBoundingClientRect();
      return { top: item.top, bottom: item.bottom, visibleTop: Math.max(body.top, toolbar.bottom, thread.top), visibleBottom: Math.min(body.bottom, thread.bottom, innerHeight) };
    });
    assert.ok(contextPosition.top >= contextPosition.visibleTop - 4 && contextPosition.top < contextPosition.visibleBottom,
      `Viewing context locates the selected record in the visible log: ${JSON.stringify(contextPosition)}`);
    assert.equal(await searchBack.isVisible(), true);
    assert.equal(await searchBack.getAttribute('aria-label'), locale === 'zh' ? '返回搜索结果' : 'Return to search results');
    assert.equal(await searchToggle.count(), 0, 'The context return action replaces opening a fresh search');
    if (width === 390) assert.equal(await searchBack.locator('span').isVisible(), false, 'The mobile return action keeps its text label out of the compact toolbar');
    await capture('proof-search-context', undefined, true);
    const readsBeforeContext = detailReads;
    touch(); summary('lead', 'public-summary', copy.expanded, true);
    while (detailReads <= readsBeforeContext) await settled(page);
    assert.equal(await searchBack.isVisible(), true, 'Polling preserves the context return path');
    await thinking.locator(':scope > summary').click(); await settled(page);
    await thinking.locator(':scope > summary').click(); await settled(page);
    assert.equal(await searchBack.isVisible(), true, 'Folding and reopening preserves the context return path');
    await openConversation(stoppedConversation.id); await thinking.waitFor();
    assert.equal(await searchBack.count(), 0, 'A context return path does not leak into another task');
    await openConversation(conversation.id); await thinking.waitFor();
    assert.equal(await searchBack.isVisible(), true, 'SPA navigation restores the original context return path');
    await searchBack.click(); await settled(page);
    assert.equal(await query.inputValue(), 'ui_fixture_proof_search_output_tail');
    assert.equal(await allFilter.getAttribute('aria-pressed'), 'true');
    assert.equal(await thinking.locator('[data-thinking-selected="true"]').getAttribute('data-thinking-entry'), 'prove:researcher:find-zero-lemmas');
    assert.equal(await thinking.locator('[data-thinking-selected="true"]').getAttribute('aria-current'), 'true');
    assert.equal(await thinking.locator('.thinking-search-count').getAttribute('data-thinking-search-position'), '1');
    assert.equal((await thinking.locator('.thinking-search-count').innerText()).replace(/\s+/g, ' ').trim(), '1 / 1');
    assert.ok(await query.evaluate(node => {
      const input = node as HTMLInputElement;
      return document.activeElement === input && !(input.selectionStart === 0 && input.selectionEnd === input.value.length);
    }), 'Returning by button focuses the query without selecting all its text');
    assert.equal(await search.getAttribute('open'), '', 'Returning to results preserves the detail opened in context');
    const returnedToolReading = await searchEntry.evaluate(entry =>
      entry.getBoundingClientRect().top - entry.closest('.thinking-body')!.getBoundingClientRect().top);
    assert.ok(Math.abs(returnedToolReading - toolResultReading) <= 4, 'Returning to the single tool result restores its reading anchor');
    await capture('proof-search-return', undefined, true);
    await searchEntry.locator('[data-thinking-context]').click(); await settled(page);
    await thinkingBody.press('Control+f'); await settled(page);
    assert.equal(await query.inputValue(), 'ui_fixture_proof_search_output_tail');
    assert.ok(await query.evaluate(node => {
      const input = node as HTMLInputElement;
      return document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length;
    }), 'Control+F in context returns to the existing query and selects it');
    await query.press('Escape'); await settled(page);
    const afterRoundTrip = await thinking.locator(`[data-thinking-entry="${historyAnchor.id}"]`).evaluate(entry =>
      entry.getBoundingClientRect().top - entry.closest('.thinking-body')!.getBoundingClientRect().top);
    searchReturnAnchorDelta = Math.abs(afterRoundTrip - historyAnchor.top);
    assert.ok(searchReturnAnchorDelta <= 4, `Ending the returned search restores its original pre-search reading anchor: ${searchReturnAnchorDelta}px`);
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'false');
    await searchToggle.click(); await findRecords('ui_fixture_proof_search_output_tail', 1);
    await searchEntry.locator('[data-thinking-context]').click(); await settled(page);
    await latest.click(); await settled(page);
    assert.equal(await searchBack.count(), 0, 'Returning to latest discards the context return path');
    await searchToggle.click(); await settled(page);
    assert.equal(await query.inputValue(), '', 'A new search after resuming follow starts with an empty query');
    await searchClose.click(); await scrollBody('top');
    await thinking.locator('.thinking-earlier').click();
    await page.waitForFunction(() => document.querySelector('[data-thinking-entry="prove:researcher:history-0"]'));
    await settled(page);
    assert.ok(await thinkingBody.evaluate(node => document.activeElement === node), 'Loading history returns keyboard focus to the log');
    assert.ok(await thinking.locator('[data-thinking-entry]').count() > 40);
    const loadedAnchorTop = await thinking.locator(`[data-thinking-entry="${historyAnchor.id}"]`).evaluate(entry =>
      entry.getBoundingClientRect().top - entry.closest('.thinking-body')!.getBoundingClientRect().top);
    historyAnchorDelta = Math.abs(loadedAnchorTop - historyAnchor.top);
    assert.ok(historyAnchorDelta <= 4, `Loading earlier records preserves the current reading anchor: ${historyAnchorDelta}px`);
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'false');
    await chooseRecords(true);
    await capture('proof-history-anchor');

    await thinking.locator(':scope > summary').scrollIntoViewIfNeeded(); await settled(page);
    const beforeFold = await thinkingBody.evaluate(body => {
      const toolbar = body.closest('[data-thinking-process]')!.querySelector('.thinking-controls')!.getBoundingClientRect();
      const thread = document.querySelector('#research-chat-thread')!.getBoundingClientRect();
      const top = Math.max(body.getBoundingClientRect().top, toolbar.bottom, thread.top);
      const entry = [...body.querySelectorAll<HTMLElement>('.thinking-entries > [data-thinking-entry]')].find(node => node.getBoundingClientRect().bottom > top + 1)!;
      return { id: entry.dataset.thinkingEntry!, offset: entry.getBoundingClientRect().top - body.getBoundingClientRect().top, scrollTop: body.scrollTop,
        bodyTop: body.getBoundingClientRect().top, toolbarBottom: toolbar.bottom, threadTop: thread.top };
    });
    await thinking.locator(':scope > summary').click();
    await page.waitForFunction(() => !document.querySelector('[data-thinking-process]')?.hasAttribute('open'));
    touch(); summary('engineer', 'folded-public-update', `**UI_FIXTURE_PROOF_FOLDED_STREAM_UPDATE**\n${copy.engineerSummary}`);
    await contains('UI_FIXTURE_PROOF_FOLDED_STREAM_UPDATE');
    assert.equal(await thinking.getAttribute('open'), null, 'Streaming preserves a reader\'s choice to fold the whole proof process');
    await capture('proof-folded');
    await thinking.locator(':scope > summary').click();
    await contains('UI_FIXTURE_PROOF_FOLDED_STREAM_UPDATE');
    await settled(page);
    const afterFold = await thinking.locator(`[data-thinking-entry="${beforeFold.id}"]`).evaluate(entry => {
      const body = entry.closest('.thinking-body')!, toolbar = entry.closest('[data-thinking-process]')!.querySelector('.thinking-controls')!.getBoundingClientRect();
      const thread = document.querySelector('#research-chat-thread')!.getBoundingClientRect();
      return { offset: entry.getBoundingClientRect().top - body.getBoundingClientRect().top, scrollTop: body.scrollTop,
        bodyTop: body.getBoundingClientRect().top, toolbarBottom: toolbar.bottom, threadTop: thread.top };
    });
    reopenedScrollDelta = Math.abs(afterFold.scrollTop - beforeFold.scrollTop);
    reopenedAnchorDelta = Math.abs(afterFold.offset - beforeFold.offset);
    assert.ok(reopenedScrollDelta <= 4, `Reopening the process preserves its inner scroll position: ${JSON.stringify({ beforeFold, afterFold, reopenedScrollDelta })}`);
    assert.ok(reopenedAnchorDelta <= 4, `Reopening the process preserves its visible reading anchor: ${JSON.stringify({ beforeFold, afterFold, reopenedAnchorDelta, reopenedScrollDelta })}`);
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'false');

    stage = 'proof-explanations-filter';
    await explanationsFilter.click();
    await page.waitForFunction(() => document.querySelector('[data-thinking-filter="explanations"]')?.getAttribute('aria-pressed') === 'true');
    assert.equal(await allFilter.getAttribute('aria-pressed'), 'false');
    assert.equal(await thinking.locator('[data-thinking-kind="action"], [data-thinking-kind="check"]').count(), 0,
      'The explanations view contains public summaries and saved mathematical work');
    assert.ok(await thinking.locator('[data-thinking-kind="summary"]').count() > 0);
    assert.ok(await thinking.locator('[data-thinking-kind="work"]').count() > 0);
    touch(); summary('engineer', 'filter-update', 'UI_FIXTURE_PROOF_FILTER_POLLING_UPDATE', true);
    await contains('UI_FIXTURE_PROOF_FILTER_POLLING_UPDATE');
    assert.equal(await explanationsFilter.getAttribute('aria-pressed'), 'true', 'Polling preserves the chosen explanations view');
    await capture('proof-explanations-filter', '[data-thinking-work="plan"][data-thinking-task="goal"]');
    await allFilter.click();
    await search.waitFor();
    assert.equal(await allFilter.getAttribute('aria-pressed'), 'true');
    assert.equal(await search.getAttribute('open'), '', 'Returning to all records restores the saved tool details');

    stage = 'proof-outer-latest-fallback';
    const question = conversation.messages[0]!, originalQuestion = question.text;
    question.text = `${originalQuestion}\n\n${Array.from({ length: 35 }, (_, index) => `${copy.original} Synthetic earlier conversation paragraph ${index + 1}.`).join('\n\n')}\n\nUI_FIXTURE_PROOF_EARLIER_CONVERSATION`;
    touch();
    await page.waitForFunction(() => document.querySelector('[data-message-id="question"]')?.textContent?.includes('UI_FIXTURE_PROOF_EARLIER_CONVERSATION'));
    await settled(page);
    await page.locator('#research-chat-thread').evaluate(node => {
      node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
      node.scrollTop = 0; node.dispatchEvent(new Event('scroll'));
    });
    await page.waitForFunction(() => {
      const body = document.querySelector('.thinking-body'), thread = document.querySelector('#research-chat-thread'), button = document.querySelector<HTMLButtonElement>('[data-chat-latest]');
      return body && thread && button && body.getBoundingClientRect().top >= thread.getBoundingClientRect().bottom && !button.hidden;
    });
    assert.equal(await page.locator('[data-chat-latest]').isVisible(), true, 'The outer latest action remains available while reading earlier conversation text');
    await page.locator('[data-chat-latest]').click();
    await settled(page);
    assert.equal(await page.locator('[data-chat-latest]').isVisible(), false, 'Returning to the visible proof log removes the duplicate outer action');
    question.text = originalQuestion; touch();
    await page.waitForFunction(() => !document.querySelector('[data-message-id="question"]')?.textContent?.includes('UI_FIXTURE_PROOF_EARLIER_CONVERSATION'));

    await search.locator(':scope > summary').click();
    await page.waitForFunction(() => !document.querySelector('[data-thinking-detail="prove:researcher:find-zero-lemmas"]')?.hasAttribute('open'));
    touch(); summary('engineer', 'proof-summary', `${copy.engineerSummary}\n\nUI_FIXTURE_PROOF_SINGLE_DETAIL_STAYS_FOLDED`);
    await contains('UI_FIXTURE_PROOF_SINGLE_DETAIL_STAYS_FOLDED');
    assert.equal(await search.getAttribute('open'), null, 'One folded tool stays folded as other proof records update');
    await chooseRecords(false);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-thinking-process] [data-thinking-detail]')].every(node => !node.hasAttribute('open')));
    touch(); action({ workerId: 'researcher', itemId: 'tool-after-collapse', kind: 'command', phase: 'completed', status: 'done',
      command: 'rg SyntheticProofFixture Mathlib', output: 'UI_FIXTURE_PROOF_NEW_TOOL_AFTER_COLLAPSE' });
    const laterTool = thinking.locator('[data-thinking-detail="prove:researcher:tool-after-collapse"]');
    await laterTool.waitFor(); assert.equal(await laterTool.getAttribute('open'), null, 'New tools obey the latest global details choice');
    assert.ok((await goalPlan.innerText()).includes(copy.goal), 'Plan objectives remain readable when supplementary details are folded');
    assert.equal(await goalPlan.locator('[data-thinking-detail]').getAttribute('open'), null);
    await capture('proof-collapsed-details');
    await chooseRecords(true);
    await laterTool.locator('.route-output').waitFor();
    assert.equal(await laterTool.getAttribute('open'), '');

    const longPublicSummary = Array.from({ length: 45 }, (_, index) => `${copy.engineerSummary.split('\n')[1]} Synthetic saved progress paragraph ${index + 1}.`).join('\n\n')
      + '\n\nUI_FIXTURE_PROOF_FULL_SUMMARY_TAIL';
    touch(); summary('engineer', 'long-public-summary', longPublicSummary);
    await contains('UI_FIXTURE_PROOF_FULL_SUMMARY_TAIL');
    assert.equal(await thinkingBody.evaluate(node => node.scrollHeight > node.clientHeight), true);
    await scrollBody('top');
    await settled(page);
    touch(); summary('engineer', 'long-public-summary', `${longPublicSummary}\n\nUI_FIXTURE_PROOF_SCROLL_UPDATE`, true);
    await contains('UI_FIXTURE_PROOF_SCROLL_UPDATE');
    assert.ok(await thinkingBody.evaluate(node => node.scrollTop <= 2), 'An update preserves the reader\'s position when they scroll up');
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'false');
    assert.equal(await thinking.locator('.thinking-controls').count(), 1, 'One toolbar controls this log');
    await scrollBody('middle');
    await thinkingBody.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await settled(page);
    const stickyControls = await thinking.locator('.thinking-controls').evaluate(node => {
      const controls = node.getBoundingClientRect(), body = node.closest('[data-thinking-process]')!.querySelector('.thinking-body')!.getBoundingClientRect();
      const thread = document.querySelector('#research-chat-thread')!.getBoundingClientRect();
      return { top: controls.top, bottom: controls.bottom, visibleTop: Math.max(0, thread.top), visibleBottom: Math.min(innerHeight, body.bottom, thread.bottom) };
    });
    assert.ok(stickyControls.top >= stickyControls.visibleTop - 2 && stickyControls.bottom <= stickyControls.visibleBottom + 2,
      `The controls stay visible while reading deep in the log: ${JSON.stringify(stickyControls)}`);
    await expectNoLatestOverlap();
    assert.ok(await latest.getAttribute('aria-label'), 'An icon-only latest control has an accessible name');
    if (width === 390) assert.equal(await latest.locator('span:not([data-thinking-new-count])').isVisible(), false, 'The mobile latest control hides its text label to save space');
    await capture('proof-scrolled-history');

    stage = 'proof-new-records';
    await latest.click(); await settled(page);
    await scrollBody('middle');
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'false');
    await expectNewRecords(0, 'A new reading pause starts without unread records');
    touch(); summary('engineer', 'new-record-summary', 'UI_FIXTURE_PROOF_UNREAD_SUMMARY', true);
    await contains('UI_FIXTURE_PROOF_UNREAD_SUMMARY');
    await expectNewRecords(1, 'One new public summary counts once');
    touch(); summary('engineer', 'new-record-summary', 'UI_FIXTURE_PROOF_UNREAD_SUMMARY_UPDATED', true);
    await contains('UI_FIXTURE_PROOF_UNREAD_SUMMARY_UPDATED');
    await expectNewRecords(1, 'Streaming an existing summary ID does not add an unread record');
    touch(); action({ workerId: 'researcher', itemId: 'new-record-tool', kind: 'command', phase: 'completed', status: 'done',
      command: 'rg UI_FIXTURE_PROOF_UNREAD_TOOL Mathlib', output: 'UI_FIXTURE_PROOF_UNREAD_TOOL_OUTPUT' });
    await contains('UI_FIXTURE_PROOF_UNREAD_TOOL_OUTPUT');
    await expectNewRecords(2, 'All records include the new summary and tool');
    await explanationsFilter.click();
    await expectNewRecords(1, 'Explanation scope counts only the new summary');
    await allFilter.click();
    await expectNewRecords(2, 'Returning to all records restores the tool count');
    await searchToggle.click(); await findRecords('UI_FIXTURE_PROOF_UNREAD_SUMMARY', 1);
    assert.equal(await latest.isVisible(), false, 'Search hides the latest action without clearing its unread records');
    touch(); summary('engineer', 'new-record-summary', 'UI_FIXTURE_PROOF_UNREAD_SUMMARY_SEARCH_POLL', true);
    await contains('UI_FIXTURE_PROOF_UNREAD_SUMMARY_SEARCH_POLL');
    assert.equal(await query.inputValue(), 'UI_FIXTURE_PROOF_UNREAD_SUMMARY');
    await query.fill('UI_FIXTURE_PROOF_HISTORY_'); await settled(page);
    assert.equal(await thinking.locator('[data-thinking-entry]').count(), 40, 'A broad search keeps its own forty-result window');
    assert.equal(await thinkingBody.evaluate(node => node.scrollHeight > node.clientHeight), true, 'The broad search has a scrollable result list');
    await scrollBody('bottom');
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'false', 'The bottom of search results does not resume following the full log');
    await searchClose.click();
    await expectNewRecords(2, 'Polling and ending search preserve the unread IDs');
    await searchToggle.click(); await findRecords('UI_FIXTURE_PROOF_UNREAD_SUMMARY', 1);
    await thinking.locator('[data-thinking-entry="prove:engineer:new-record-summary"] [data-thinking-context]').click(); await settled(page);
    await expectNewRecords(2, 'Viewing search context preserves unread IDs');
    await searchBack.click(); await settled(page);
    assert.equal(await query.inputValue(), 'UI_FIXTURE_PROOF_UNREAD_SUMMARY');
    await searchClose.click();
    await expectNewRecords(2, 'Returning from context and ending search keeps unread IDs');
    await thinking.locator(':scope > summary').click(); await settled(page);
    assert.equal(await thinking.getAttribute('open'), null);
    await thinking.locator(':scope > summary').click();
    await expectNewRecords(2, 'Folding and reopening preserves the unread count');
    await chooseRecords(false); await expectNewRecords(2, 'Collapsing details preserves the unread count');
    await chooseRecords(true); await expectNewRecords(2, 'Expanding details preserves the unread count');
    await openConversation(stoppedConversation.id);
    await thinking.waitFor();
    assert.equal(await newRecordBadge.count(), 0, 'Unread records do not leak to another task');
    await openConversation(conversation.id);
    await thinking.waitFor();
    await expectNewRecords(2, 'SPA navigation restores the original task unread count');
    await expectNoLatestOverlap();
    await capture('proof-new-records');
    await latest.click();
    await page.waitForFunction(() => document.querySelector('[data-thinking-process]')?.getAttribute('data-thinking-following') === 'true');
    assert.ok(await thinkingBody.evaluate(node => document.activeElement === node), 'Returning to latest returns keyboard focus to the log');
    assert.ok(await thinkingBody.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop <= 2), 'Returning to latest reaches the end of this log');
    assert.equal(await latest.isVisible(), false);
    await expectNewRecords(0, 'Returning to latest clears unread records');
    touch(); summary('engineer', 'following-update', 'UI_FIXTURE_PROOF_LATEST_FOLLOWS_NEW_RECORD', true);
    await contains('UI_FIXTURE_PROOF_LATEST_FOLLOWS_NEW_RECORD');
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'true');
    assert.ok(await thinkingBody.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop <= 2), 'Following remains enabled for the next saved record');
    await expectNewRecords(0, 'Records arriving while following do not accumulate unread counts');
    await scrollBody('middle');
    await expectNewRecords(0, 'The second reading pause starts a fresh baseline');
    touch(); summary('engineer', 'second-unread-summary', 'UI_FIXTURE_PROOF_SECOND_UNREAD_ROUND', true);
    await contains('UI_FIXTURE_PROOF_SECOND_UNREAD_ROUND');
    await expectNewRecords(1, 'A second pause counts only its own new records');
    await searchToggle.click(); await findRecords('UI_FIXTURE_PROOF_SECOND_UNREAD_ROUND', 1);
    await thinking.locator('[data-thinking-entry="prove:engineer:second-unread-summary"] [data-thinking-context]').click(); await settled(page);
    assert.equal(await searchBack.isVisible(), true);
    await scrollBody('bottom');
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'true', 'Manually reaching the bottom resumes following');
    assert.equal(await searchBack.count(), 0, 'Manually reaching the full log bottom discards the context return path');
    await expectNewRecords(0, 'Manually reaching the bottom clears unread records');

    touch();
    run.observation!.deliveries!.push({ id: 'research-delivery', producer: 'researcher', taskId: 'research', taskDigest: research.version, kind: 'research', status: 'completed',
      statement: copy.research, premises: ['n : Nat'], dependencies: [], remainingObligations: [copy.outstanding], summary: copy.finding, finding: findingProtocol,
      evidenceRefs: [], createdAt: Date.parse(run.updatedAt) });
    event('research_delivered', copy.finding, { workerId: 'researcher', taskId: 'research' });
    summary('researcher', 'research-summary', copy.researcherSummary, true);
    action({ workerId: 'engineer', itemId: 'public-commentary', kind: 'message', textSource: 'commentary', phase: 'completed', status: 'done', text: copy.commentary });
    run.artifact = { source: failedSource, workerId: 'engineer', status: 'candidate', capturedAt: run.updatedAt };
    action({ workerId: 'engineer', itemId: 'proof-check-1', kind: 'command', phase: 'completed', status: 'failed', exitCode: 1,
      command: 'theorem-os check-lean --file Submission.lean', output: checkOutput, lean: { passed: false, messages: [
        { severity: 'error', line: 5, column: 9, text: diagnostic }, { severity: 'warning', line: 4, text: warning }, { severity: 'info', line: 5, text: info },
      ] } });
    await contains(copy.commentary);
    assert.equal(await thinking.locator('[data-thinking-work="research"][data-thinking-task="research"]').count(), 1,
      'A matching delivery replaces the same task version\'s finding instead of repeating it');
    const failedCheck = thinking.locator('[data-thinking-detail="check:p:engineer:proof-check-1"]');
    await failedCheck.locator('.route-lean').waitFor();
    for (const value of [diagnostic, warning, info, checkOutput, 'theorem-os check-lean --file Submission.lean']) assert.ok((await failedCheck.innerText()).includes(value));
    assert.equal(await failedCheck.locator('.thinking-source pre code').textContent(), failedSource);
    await searchToggle.click(); await findRecords(diagnostic, 1);
    assert.equal(await failedCheck.locator('.thinking-source pre code').textContent(), failedSource, 'A diagnostic match leaves the saved Lean source intact');
    assert.equal(await failedCheck.locator('.thinking-source mark').count(), 0, 'Snippet highlighting does not modify the Lean source DOM');
    assert.equal(await thinking.locator('mark').count(), await thinking.locator('[data-thinking-match] mark').count());
    await searchClose.click(); await settled(page);
    assert.equal(await thinking.locator('[data-thinking-entry="prove:engineer:proof-check-1"]').count(), 0, 'The Lean action is included once in its check');
    await composer.fill(`UI_FIXTURE_SOURCE_COPY_DRAFT_${locale}\nKeep this question while reading the failed and corrected Lean.`);
    assert.equal(await failedCheck.locator('.thinking-source [data-chat-code-toggle]').count(), 0, 'Saved check source is displayed in full by default');
    await expectCodeCopy(failedCheck.locator('.thinking-source .chat-code'), failedSource, 'failed check saved source');
    await capture('proof-failed-check', '[data-thinking-detail="check:p:engineer:proof-check-1"] > summary');

    touch(); summary('engineer', 'proof-summary', copy.revision);
    action({ workerId: 'engineer', itemId: 'revise-source', kind: 'edit', phase: 'completed', status: 'done', changes: [{ path: 'Submission.lean', change: 'update',
      diff: '@@ -4,2 +4,4 @@\n theorem ui_fixture_add_identity (n : Nat) : n + 0 = n ∧ 0 + n = n := by\n-  exact Nat.add_zero n\n+  constructor\n+  · exact Nat.add_zero n\n+  · exact Nat.zero_add n' }] });
    run.artifact = { source: correctedSource, workerId: 'engineer', status: 'candidate', capturedAt: run.updatedAt };
    action({ workerId: 'engineer', itemId: 'proof-check-2', kind: 'command', phase: 'completed', status: 'done', exitCode: 0,
      command: 'theorem-os check-lean --file Submission.lean', output: 'Synthetic check passed. No Lean process ran.', lean: { passed: true, messages: [] } });
    await contains(copy.revision.split('\n')[1]!);
    const passedCheck = thinking.locator('[data-thinking-detail="check:p:engineer:proof-check-2"]');
    await page.waitForFunction(source => document.querySelector('[data-thinking-detail="check:p:engineer:proof-check-2"] .thinking-source pre code')?.textContent === source, correctedSource);
    assert.equal(await passedCheck.locator('.thinking-source pre code').textContent(), correctedSource);
    assert.equal(await thinking.locator('[data-thinking-entry="prove:engineer:proof-summary"]').count(), 1);
    assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false', 'An agent check alone does not accept the original problem');
    await expectCodeCopy(passedCheck.locator('.thinking-source .chat-code'), correctedSource, 'corrected check saved source');
    await composer.fill(''); await settled(page);
    await capture('proof-revised-check', '[data-thinking-detail="check:p:engineer:proof-check-2"] > summary');

    touch();
    for (const id of ['left-zero', 'right-zero']) {
      const task = run.observation!.inspection.tasks.find(item => item.id === id)!;
      Object.assign(task, { status: 'integrated', feedback: id === 'left-zero' ? copy.leftDone : copy.rightDone,
        proof: { status: 'checked', commit: 'fixture-commit', sourceDigest: 'e'.repeat(64) } });
      event('lemma_checked', id === 'left-zero' ? copy.leftDone : copy.rightDone, { workerId: 'engineer', taskId: id, passed: true });
      event('task_integrated', id === 'left-zero' ? copy.leftDone : copy.rightDone, { workerId: 'engineer', taskId: id, passed: true });
    }
    run.observation!.inspection.progress.checkedProofTasks = 2;
    event('review_assigned', copy.review, { workerId: 'reviewer', role: 'reviewer', taskId: 'goal' });
    summary('engineer', 'proof-summary', copy.revision, true);
    summary('reviewer', 'review-summary', copy.reviewerSummary);
    run.observation!.inspection.review = { commit: 'fixture-commit', sourceDigest: 'e'.repeat(64), status: 'approved', workerId: 'reviewer', summary: copy.review };
    run.observation!.inspection.statementReviews.push({ taskId: 'goal', version: taskVersion(tasks.find(task => task.id === 'goal')!), status: 'approved',
      intendedStatement: copy.goal, leanStatement: '(n : Nat) : n + 0 = n ∧ 0 + n = n', workerId: 'reviewer', summary: copy.review, premises: ['n : Nat'] });
    event('review_completed', copy.review, { workerId: 'reviewer', taskId: 'goal', passed: true });
    await contains(copy.reviewerSummary.split('\n')[1]!);
    assert.ok((await thinking.locator('[data-thinking-entry="prove:reviewer:review-summary"] .thinking-entry-meta').innerText()).includes('Reviewer'));
    for (const [id, objective, feedback] of [['left-zero', copy.left, copy.leftDone], ['right-zero', copy.right, copy.rightDone]]) {
      const proofWork = thinking.locator(`[data-thinking-work="proof"][data-thinking-task="${id}"]`);
      await proofWork.waitFor();
      await page.waitForFunction(({ taskId, savedFeedback }) => document.querySelector(`[data-thinking-work="proof"][data-thinking-task="${taskId}"]`)
        ?.textContent?.includes(savedFeedback), { taskId: id, savedFeedback: feedback });
      for (const value of [objective, feedback, locale === 'zh' ? '局部 Lean 检查通过' : 'Local Lean check passed'])
        assert.ok((await proofWork.innerText()).includes(value), `The actual lemma record explains its progress: ${value}`);
    }
    const reviewWork = thinking.locator('[data-thinking-work="review"]');
    assert.equal(await reviewWork.count(), 2, 'Both saved statement and candidate reviews are readable');
    for (const value of await reviewWork.allInnerTexts()) assert.ok(value.includes(copy.review));
    assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false', 'Lemma completion and review do not replace independent acceptance');
    await capture('proof-lemmas-and-review', '[data-thinking-work="proof"][data-thinking-task="left-zero"]');

    stage = 'proof-version-details';
    const candidateReview = thinking.locator('[data-thinking-work="review"]:not([data-thinking-task])');
    const candidateVersions = candidateReview.locator('details[data-thinking-version]');
    assert.equal(await candidateVersions.getAttribute('open'), null, 'A new candidate version starts folded independently of task version metadata');
    assert.equal(await candidateVersions.locator(':scope > summary').getAttribute('aria-label'), locale === 'zh'
      ? '查看候选的完整版本' : 'View the full candidate version');
    await composer.fill(`UI_FIXTURE_VERSION_COPY_DRAFT_${locale}\nKeep this question while copying the recorded candidate versions.`);
    await candidateVersions.locator(':scope > summary').click(); await settled(page);
    const candidate = run.observation!.inspection.review!;
    await expectVersionCopy(candidateVersions, 'commit', candidate.commit);
    await expectVersionCopy(candidateVersions, 'source', candidate.sourceDigest);
    const readsBeforeCandidateVersions = detailReads;
    touch(); summary('reviewer', 'review-summary', copy.reviewerSummary);
    while (detailReads <= readsBeforeCandidateVersions) await settled(page);
    assert.equal(await candidateVersions.getAttribute('open'), '', 'Polling preserves the expanded candidate versions');
    assert.equal(await candidateVersions.locator('[data-thinking-version-field="source"] dd code').textContent(), candidate.sourceDigest);
    await composer.fill(''); await settled(page);
    await candidateVersions.evaluate(node => {
      const body = node.closest('.thinking-body')!;
      body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
      body.dispatchEvent(new Event('scroll'));
      document.querySelector('#research-chat-thread')!.dispatchEvent(new Event('scroll'));
    });
    await settled(page);
    const versionFieldsView = await candidateVersions.locator('.thinking-version-fields').evaluate(node => {
      const box = node.getBoundingClientRect(), body = node.closest('.thinking-body')!.getBoundingClientRect();
      const thread = document.querySelector('#research-chat-thread')!.getBoundingClientRect();
      const controls = node.closest('[data-thinking-process]')!.querySelector('.thinking-controls')!.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, visibleTop: Math.max(body.top, thread.top, controls.bottom), visibleBottom: Math.min(body.bottom, thread.bottom, innerHeight) };
    });
    assert.ok(versionFieldsView.top >= versionFieldsView.visibleTop - 1 && versionFieldsView.bottom <= versionFieldsView.visibleBottom + 1,
      `Both complete candidate fields are visible in the version screenshot: ${JSON.stringify(versionFieldsView)}`);
    await capture('proof-version-details', undefined, true);

    touch(); event('candidate_selected', 'Synthetic candidate selected.', { workerId: 'engineer' });
    event('evaluation_started', 'Synthetic independent acceptance started.', { workerId: 'engineer' }); run.phase = 'evaluating';
    await thinking.locator('[data-thinking-entry="check:v:evaluation"]').waitFor();
    assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false');
    await capture('proof-independent-acceptance', '[data-thinking-detail="check:v:evaluation"] > summary');
    touch(); event('evaluation_finished', 'Synthetic independent acceptance passed.', { workerId: 'engineer', status: 'passed' });
    summary('reviewer', 'review-summary', copy.reviewerSummary, true);
    run.status = 'completed'; run.phase = 'finished'; run.finishedAt = run.updatedAt;
    run.result = { status: 'evaluated_passed', proof: correctedSource, report: { fixture: 'Synthetic acceptance only; no verification process ran.' } };
    await page.waitForFunction(() => document.querySelector('.research-conversation-status')?.getAttribute('data-accepted') === 'true');
    assert.equal(await thinking.getAttribute('open'), '', 'An explicit choice to keep proof history open survives completion');
    if (!await thinking.evaluate(node => (node as HTMLDetailsElement).open)) await thinking.locator(':scope > summary').click();
    await capture('proof-completed', '[data-thinking-detail="check:v:evaluation"] > summary');
    assert.equal(await page.locator('[data-research-stop]').count(), 0);

    await explanationsFilter.click();
    await settled(page);
    await scrollBody('top');
    await page.waitForFunction(() => document.querySelector('[data-thinking-process]')?.getAttribute('data-thinking-following') === 'false');
    assert.equal(await explanationsFilter.getAttribute('aria-pressed'), 'true');
    await openConversation(stoppedConversation.id);
    await thinking.waitFor();
    assert.equal(await thinking.getAttribute('open'), null, 'A stopped proof initially folds its recorded process');
    if (!await thinking.evaluate(node => (node as HTMLDetailsElement).open)) await thinking.locator(':scope > summary').click();
    await contains(copy.stopped);
    assert.equal(await allFilter.getAttribute('aria-pressed'), 'true', 'A different proof starts with its own default filter');
    assert.equal(await explanationsFilter.getAttribute('aria-pressed'), 'false');
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'true', 'A different proof does not inherit the previous proof\'s paused follow state');
    assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false');
    assert.equal(await page.locator('[data-research-stop]').count(), 0);
    assert.equal(await thinking.getAttribute('data-active'), 'false');
    assert.equal(await thinking.locator('[data-thinking-entry="check:p:engineer:unfinished-check"][data-tone="stopped"]').count(), 1,
      'A check interrupted by cancellation is displayed as unfinished, with its saved source retained');
    assert.equal(await thinking.locator('[data-thinking-entry="check:v:evaluation"]').count(), 0, 'Cancellation does not invent an independent acceptance result');
    await capture('proof-stopped');
    await openConversation(conversation.id);
    await thinking.waitFor();
    assert.equal(await thinking.getAttribute('open'), '', 'Returning to a task restores the reader\'s open history');
    assert.equal(await explanationsFilter.getAttribute('aria-pressed'), 'true', 'The explanations filter is remembered separately for each proof');
    assert.equal(await thinking.getAttribute('data-thinking-following'), 'false', 'Returning to a task restores its own paused follow state');
    assert.equal(await candidateVersions.getAttribute('open'), '', 'Candidate version disclosure also survives SPA navigation');
    assert.equal(await thinking.locator('[data-thinking-kind="action"], [data-thinking-kind="check"]').count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(external, []); assert.deepEqual(unexpectedApi, []); assert.deepEqual(runtimeCalls, []);
    checks.push({ scenario, detailReads, publicSummaries: true, summaryDeduplicated: true, toolsExpandedByDefault: true,
      wholeProcessFoldingPreserved: true, singleToolFoldingPreserved: true, globalDetailsChoicePreserved: true, scrollPositionPreserved: true,
      explanationFilterAndPolling: true, taskFilterAndFollowMemory: true, latestRestoresContinuousFollowing: true,
      controlsStayVisible: true, outerLatestSuppressedForVisibleLog: true, outerLatestAvailableOutsideLog: true,
      latestDoesNotCoverText: true, historyAnchorDelta, reopenedScrollDelta, reopenedAnchorDelta,
      recordOptionsMenu: true, savedRecordSearch: true, searchPollingAndPrivateEmptyStates: true, searchCloseAndEscape: true, searchAnchorDelta, toolbarHeights,
      searchSnippetsAndMarks: true, scopedFindShortcut: true, collapsedMatchContext: true, markdownAndLeanDomPreserved: true,
      currentStepDiscussionQuote: true, foldedWorkQuoteWithFullVersion: true, quotePreservesDraftAndFocus: true,
      quoteDeduplicatedAndNotSent: true, quotedDraftSurvivesPollingAndNavigation: true, guidanceModeKeepsItsMeaning: true,
      quoteUndoPreservesOriginalAndLaterInput: true, quoteUndoInReverseInsertionOrder: true,
      quoteUndoMetadataSurvivesNavigationAndRefresh: true, editedQuoteStopsUndoWithoutChangingText: true,
      quoteUndoRespectsGuidance: true, emptyComposerHeight, restoredComposerHeight,
      draftEditingPositions, draftSelectionDirectionAndScrollSurvivePollingNavigationAndRefresh: true,
      draftPositionsIndependentByConversation: true, restoredDraftPositionDoesNotStealFocus: true, clearedAndReplacedDraftPositionsStayCurrent: true,
      newRecordCounts, newRecordScopeAndPersistence: true, sameIdUpdatesNotCounted: true, latestAndManualBottomClearCounts: true,
      searchResultBottomKeepsUnread: true,
      navigationSelections, searchResultNavigation: true, searchSelectionSurvivesPollingFoldingAndNavigation: true,
      searchNavigationRespectsImeAndModifiers: true,
      searchContextRoundTrip: true, searchReturnAnchorDelta, searchReturnReadingDelta,
      searchReturnSurvivesPollingFoldingAndNavigation: true, contextFindRestoresExistingQuery: true,
      savedPlanDetails: true, taskVersionsMatch: true, observationOnlyFindingUpdate: true, findingDeliveryDeduplicated: true,
      codeCopies, workTypography, sharedMarkdownEighteenLinePreviewAndFullCopy: true, savedLeanHighlightedAndCopiedVerbatim: true,
      versionCopies, completeVersionsAccessibleByKeyboardAndTouch: true, versionDisclosureIndependentFromMathDetails: true,
      versionDisclosureSurvivesPollingAndSpa: true, versionDisclosureIsolatedByProof: true,
      lemmaProgressAndFeedback: true, savedStatementAndCandidateReviews: true,
      fullLeanDiagnostics: true, checkedSourcePreserved: true, independentAcceptance: true, stoppedState: true,
      unlabelledReasoningAndFinalProtocolExcluded: true, rootScrollHeights });
    await context.close(); activeContext = undefined; activePage = undefined;
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', mode: 'full built application + synthetic proof API replay',
    mathematicalProof: false, performanceMeasurement: false, paidModelCalls: false, leanExecution: false,
    note: '计划、研究、引理、源码、Lean 检查、审阅和验收均为合成 fixture，不代表真实数学或性能结果。',
    timeoutMs: 0, tokenLimit: null, accessibilityChecks, checks, screenshots }, null, 2) + '\n');
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 0 }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', mode: 'full built application + synthetic proof API replay',
    mathematicalProof: false, performanceMeasurement: false, paidModelCalls: false, leanExecution: false, timeoutMs: 0, tokenLimit: null,
    scenario, stage, checks, screenshots, errors, writes, external, unexpectedApi, runtimeCalls,
    error: error instanceof Error ? error.stack : String(error) }, null, 2) + '\n');
  throw error;
} finally {
  await activeContext?.close(); await browser?.close(); await service.close(); await fs.rm(temporary, { recursive: true, force: true });
}
