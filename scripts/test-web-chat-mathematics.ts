#!/usr/bin/env bun
// Read-only local API records in the real workbench; never runs a model, Lean, or explanation generation.
// Browser waits are bounded; fixture budgets do not invoke any model or proof runner.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import type { WebInspectedTask, WebObservation } from '../apps/web/collaboration';
import { readWebConfig } from '../apps/web/config';
import type { WebConversation } from '../apps/web/conversationTypes';
import type { WebFormalization, WebFormalizationActivity } from '../apps/web/formalizationTypes';
import { localeStorageKey } from '../apps/web/i18n';
import { collaborationDetailStorageKey } from '../apps/web/client/runAwareness';
import type { WebRunner } from '../apps/web/runner';
import { createWebService } from '../apps/web/server';
import type { WebExplanation, WebExplanationDocument, WebExplanationOverview, WebRun } from '../apps/web/shared';
import { proofOutline } from '../apps/web/verificationKit';
import { audit } from './web-a11y';
import { freePort, preferFullCollaboration } from './web-scenario';
import { clickWorkbenchAction, openChatResultDetails, openNavigationMenu } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-chat-mathematics');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Build the current web client before running the chat mathematics check.'); });
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-chat-mathematics-'));
const forbiddenCalls: string[] = [], writes: string[] = [], external: string[] = [], errors: string[] = [], reads: string[] = [];
const forbidden = (name: string): never => { forbiddenCalls.push(name); throw new Error(`Read-only mathematics cannot invoke runner.${name}`); };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local mathematics display fixture' }; },
  async run() { return forbidden('run'); }, async formalize() { return forbidden('formalize'); },
  async check() { return forbidden('check'); }, async command() { return forbidden('command'); }, async explain() { return forbidden('explain'); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: temporary }), runner, { sample: null });
service.server.requestTimeout = 0; service.server.headersTimeout = 0; service.server.setTimeout(0);
await new Promise<void>((resolve, reject) => { service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolve); });
const browser = await chromium.launch({ headless: true, timeout: 15_000 });
const checks: string[] = [], screenshots: string[] = [];
const mark = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
const at = '2026-11-10T07:00:00.000Z';
const originalTask = '请说明自然数加法的两个性质。';
const source = 'theorem swap_sum (a b : Nat) : a + b = b + a := by\n  exact Nat.add_comm a b\n\ntheorem identity_sum (a : Nat) : a + 0 = a := by\n  exact Nat.add_zero a\n';
const budgetInputs = ['#formalize-minutes', '#formalize-tokens', '#research-minutes', '#research-tokens', '#research-turns'];

function task(id: string, changes: Partial<WebInspectedTask> = {}): WebInspectedTask {
  return { id, kind: 'lemma', objective: id, informalStatement: id, group: 'main', status: 'completed', control: 'active',
    version: `${id}-v1`, theorem: id, premises: [], plannedDependencies: [], attempts: 1,
    proof: { status: 'checked', receiptIds: [`${id}-receipt`] }, parkedBy: [], parkedRoutes: {}, ...changes };
}
function observation(webRunId: string): WebObservation {
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: 'recorded-mathematics', stateDigest: 'a'.repeat(64), resultDigest: null };
  const tasks = [
    task('checked_comm', { informalStatement: '已检查：自然数加法可以交换次序。' }),
    task('checked_zero', { informalStatement: '已检查：加上零不改变自然数。' }),
    task('checked_assoc', { informalStatement: '已检查：自然数加法满足结合律。' }),
    task('checked_fourth', { informalStatement: '已检查：第四个辅助引理保留在展开项中。' }),
    task('working_target', { kind: 'goal', status: 'running', informalStatement: '正在把辅助引理组合成主目标。', proof: { status: 'unchecked' } }),
    task('delivered_helper', { status: 'delivered', informalStatement: '候选已提交，等待检查结果。', proof: { status: 'unchecked' } }),
    task('conditional_helper', { status: 'conditional', informalStatement: '这个候选引理仍然依赖未证明的输入。',
      proof: { status: 'checked', receiptIds: ['conditional-receipt'], conditions: [{ taskId: 'input', taskDigest: 'input-v1' }] } }),
    task('paused_helper', { control: 'paused', informalStatement: '已暂停的引理不属于当前已检查成果。' }),
    task('blocked_target', { kind: 'goal', status: 'blocked', informalStatement: '需要补充归纳步骤。', proof: { status: 'unchecked' },
      feedback: '主目标的归纳步骤仍缺少一个等式变换。' }),
    task('latest_finding', { kind: 'research', status: 'completed', proof: { status: 'not-applicable' },
      finding: '已记录的研究结果：先使用结合律，再应用交换律。' }),
  ];
  return { schema: 'theorem-os.web-observation.v1', webRunId, solverRunId: snapshot.runId, observedAt: at, sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot,
      evidence: 'recorded-not-replayed', phase: 'running', problem: { id: 'recorded-mathematics', statement: 'Read-only mathematics fixture',
        formalStatement: 'True', assumptions: [], targets: [] },
      configuration: { model: 'fixture', effort: 'high', workers: 1, coordination: 'cooperative', buildDigest: 'fixture-build', environmentDigest: 'fixture-env' },
      turns: 0, usage: { totalTokens: 1234 }, planVersion: 'recorded-plan', scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0,
        proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'unknown',
        droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'theoremos.obligation-snapshot.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
        digest: 'b'.repeat(64), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 4, conditionalProofTasks: 1, completedResearchTasks: 1, openProofTasks: ['working_target', 'blocked_target'] },
      groups: [], tasks, workers: [], statementReviews: [], edits: [] },
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'recorded-plan',
      tasks: tasks.map(item => ({ id: item.id, kind: item.kind, objective: item.objective, dependsOn: [], revision: 0 })) },
    sources: [], checks: [], guidance: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}
function run(status: 'running' | 'completed'): WebRun {
  const id = crypto.randomUUID();
  return { id, title: '只读数学展示测试', status, phase: status === 'running' ? 'solving' : 'finished', createdAt: at, updatedAt: at,
    providerId: 'openai', model: 'recorded-fixture', effort: 'high', environment: 'standard', source, task: '检查已有数学记录的展示。',
    maxTurns: 0, maxRunSeconds: 0, maxTotalTokens: 0, workers: 1, coordination: 'cooperative', events: [],
    ...(status === 'completed' ? { finishedAt: at, result: { status: 'evaluated_passed', proof: source, report: {} } } : { observation: observation(id) }) };
}
function conversation(value: WebRun): WebConversation {
  return { id: crypto.randomUUID(), title: value.title, runId: value.id, createdAt: at, updatedAt: at,
    messages: [{ id: crypto.randomUUID(), role: 'user', kind: 'text', text: originalTask, createdAt: at, status: 'complete' },
      { id: crypto.randomUUID(), role: 'assistant', kind: 'task', text: '', createdAt: at, status: 'complete' }] };
}
function explanationDocument(target: string, language: 'zh' | 'en' = 'zh'): WebExplanationDocument {
  const first = target === 'swap_sum', english = language === 'en';
  const statement = english ? first ? 'For any natural numbers a and b, a + b = b + a.' : 'For any natural number a, a + 0 = a.'
    : first ? '对任意自然数 a、b，a + b = b + a。' : '对任意自然数 a，a + 0 = a。';
  return { schema: 'theorem-os.web-explanation.v1', target, language, toolchain: 'recorded-fixture', mathlibRevision: null,
    overview: english ? first ? 'The saved proof uses commutativity of natural number addition.' : 'Zero is a right identity for natural number addition.'
      : first ? '已有讲解概览：使用自然数加法交换律得到第一个结论。' : '已有讲解概览：零是自然数加法的右单位元。', axioms: [],
    sections: [{ name: target, kind: 'theorem', target: true,
      title: english ? first ? 'Commutativity of addition' : 'Right identity for addition' : first ? '加法交换律' : '加法右单位元', statement,
      lines: { start: 1, end: 2 }, signature: { start: 1, end: 1 }, unexplained: [], statementReviews: [],
      steps: [{ text: english ? first ? 'Apply commutativity of addition to the natural numbers a and b.' : 'Apply the natural number addition-by-zero theorem.'
        : first ? '将自然数 a 和 b 代入加法交换律，得到所需等式。' : '应用自然数加零定理，直接得到目标。',
        uses: [{ name: first ? 'Nat.add_comm' : 'Nat.add_zero', place: 'step', spans: [] },
          ...(first ? [{ name: 'supporting_identity', place: 'declaration' as const, spans: [] }] : [])], lines: [{ start: 2, end: 2 }], reviews: [] }] },
    { name: 'supporting_identity', kind: 'definition', target: false, title: english ? 'Supporting definition' : '辅助定义',
      statement: english ? 'The supporting definition remains in the disclosure.' : '辅助定义保留在展开项中。',
      lines: { start: 4, end: 5 }, signature: { start: 4, end: 4 }, unexplained: [], statementReviews: [], steps: [] }],
    metrics: { declarations: 2, steps: 1, citations: 1, excerptCoverage: 1, proofLines: 1, explainedLines: 1, ambiguousExcerpts: 0 },
    model: 'recorded-fixture', effort: 'high', auditors: 2, rounds: 1, tokens: null };
}
function explanation(value: WebRun, target: string, language: 'zh' | 'en' = 'zh'): WebExplanation {
  return { id: `${value.id}-${target}`, runId: value.id, target, language, status: 'approved', createdAt: at, updatedAt: at,
    model: 'recorded-fixture', effort: 'high', maxRunSeconds: 0, maxTotalTokens: 0, document: explanationDocument(target, language) };
}
function overview(value: WebRun, available: boolean, entries?: WebExplanation[], canGenerate = false, language: 'zh' | 'en' = 'zh'): WebExplanationOverview {
  return { run: { id: value.id, title: value.title, environment: value.environment, providerId: value.providerId, model: value.model,
    effort: value.effort, proof: value.result!.proof }, targets: [{ name: 'swap_sum', declarations: 2 }, { name: 'identity_sum', declarations: 2 }],
    explanations: entries ?? (available ? ['swap_sum', 'identity_sum'].map(target => { const { document: _, ...item } = explanation(value, target, language); return item; }) : []),
    generation: canGenerate ? { available: true, model: 'recorded-fixture', effort: 'high', key: 'required', maxRunSeconds: 0,
      maxTotalTokens: 0, reference: { declarations: 2, seconds: 0, tokens: 0 } } : { available: false, reason: 'runtime' } };
}
async function fit(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'the mathematics display fits the viewport');
  assert.deepEqual(await audit(page), []);
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: path.join(output, name), fullPage: true, timeout: 15_000 }); screenshots.push(name);
}
async function visibleNavigation(page: Page, labels: string[]) {
  await openNavigationMenu(page);
  const links = page.locator('#topbar .research-space-links a:not(#open-classics)');
  assert.deepEqual(await links.allTextContents(), labels.slice(1));
  assert.equal(await page.locator('#workbench-home:visible').count(), 1, 'the brand returns to the workbench');
  const boxes = await links.evaluateAll(items => items.map(item => {
    const box = item.getBoundingClientRect();
    return { width: box.width, height: box.height, left: box.left, right: box.right, top: box.top, bottom: box.bottom, cut: item.scrollWidth > item.clientWidth + 1 };
  }));
  for (const box of boxes) assert(box.width > 0 && box.height >= 24 && !box.cut && box.left >= 0 && box.right <= page.viewportSize()!.width
    && box.top >= 0 && box.bottom <= page.viewportSize()!.height, `navigation label is fully visible: ${JSON.stringify(box)}`);
  await page.keyboard.press('Escape');
}
async function beforeProcess(page: Page, selector: string) {
  assert.equal(await page.locator(selector).evaluate(element => {
    const process = document.querySelector('[data-solve-process]');
    return !!process && !!(element.compareDocumentPosition(process) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true, `${selector} precedes the process details`);
}
async function answerOrder(page: Page, target: string, language: 'zh' | 'en' = 'zh', hasSelector = true) {
  const document = page.locator(`[data-chat-answer-document="${target}"]`), saved = explanationDocument(target, language);
  const title = saved.sections[0]!.title, targetRegion = page.getByRole('region', { name: title, exact: true });
  assert.equal(await page.getByRole('combobox', { name: language === 'en' ? 'Read target' : '阅读目标', exact: true }).count(), hasSelector ? 1 : 0);
  assert.equal(await targetRegion.count(), 1, 'the named target remains available to assistive technology');
  assert.equal(await targetRegion.getByRole('heading', { name: title, exact: true }).count(), hasSelector ? 0 : 1,
    'the target name stays visible when no selector supplies it');
  const conclusion = document.locator('[data-chat-answer-conclusion]'), idea = document.locator('[data-chat-answer-idea]'),
    derivation = document.locator('[data-chat-answer-derivation]');
  assert.equal(await conclusion.getByRole('heading', { name: language === 'en' ? 'Conclusions' : '结论', exact: true }).count(), 1);
  assert.equal(await idea.getByRole('heading', { name: language === 'en' ? 'Proof outline' : '证明思路', exact: true }).count(), 1);
  assert.equal(await derivation.getByRole('heading', { name: language === 'en' ? 'Derivation' : '推导过程', exact: true }).count(), 1);
  assert.ok((await conclusion.innerText()).includes(saved.sections[0]!.statement));
  assert.ok((await idea.innerText()).includes(saved.overview));
  assert.ok((await derivation.innerText()).includes(saved.sections[0]!.steps[0]!.text));
  assert.equal(await document.getByText(saved.sections[0]!.statement, { exact: true }).count(), 1,
    'the selected target statement appears once as the conclusion');
  assert.equal(await document.evaluate(node => {
    const conclusion = node.querySelector('[data-chat-answer-conclusion]')!, idea = node.querySelector('[data-chat-answer-idea]')!,
      derivation = node.querySelector('[data-chat-answer-derivation]')!;
    return !!(conclusion.compareDocumentPosition(idea) & Node.DOCUMENT_POSITION_FOLLOWING)
      && !!(idea.compareDocumentPosition(derivation) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true, 'the saved conclusion precedes the proof idea and derivation');
}
async function nextAnswerWithKeyboard(page: Page, language: 'zh' | 'en' = 'zh') {
  const select = page.getByRole('combobox', { name: language === 'en' ? 'Read target' : '阅读目标', exact: true });
  await select.focus();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await page.locator('[data-chat-answer-document="identity_sum"]').waitFor({ timeout: 15_000 });
  assert.equal(await select.inputValue(), 'identity_sum');
  assert.equal(await select.evaluate(element => document.activeElement === element), true,
    'reading another target keeps keyboard focus on the named selector');
}
async function mathematicsHeadingInView(page: Page) {
  const bounds = await page.locator('[data-chat-mathematics] > h3').evaluate(async heading => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const title = heading.getBoundingClientRect(), thread = document.querySelector('#research-chat-thread')!.getBoundingClientRect();
    return { top: title.top, bottom: title.bottom, height: title.height,
      visibleTop: Math.max(thread.top, 0), visibleBottom: Math.min(thread.bottom, innerHeight) };
  });
  assert.ok(bounds.height > 0 && bounds.top >= bounds.visibleTop - 1 && bounds.bottom <= bounds.visibleBottom + 1,
    `the revealed mathematical heading stays inside the chat viewport after two frames: ${JSON.stringify(bounds)}`);
}
async function runningMetadata(page: Page, simple: boolean, expanded = false, language: 'zh' | 'en' = 'zh') {
  const status = page.locator('.research-conversation-status'), metadata = page.locator('[data-chat-run-meta]'),
    workspace = page.locator('[data-research-artifact="live"]'), stop = page.locator('[data-research-stop]');
  assert.equal(await metadata.count(), 1, 'the recorded run metadata appears once');
  assert.equal(await metadata.locator('time').count(), 1);
  assert.equal(await metadata.locator('time').getAttribute('datetime'), at);
  assert.equal(await metadata.locator(':scope > span').textContent(), language === 'en' ? '1234 tokens' : 'Token 1234');
  assert.equal(await metadata.locator(':scope > span').isVisible(), !simple || expanded);
  assert.equal(await workspace.count(), 1, 'the current workspace has one entry');
  assert.equal(await stop.count(), 1, 'stopping remains a single action');
  assert.equal(await status.locator('[data-research-stop]').isVisible(), true);
  assert.equal(await metadata.isVisible(), !simple || expanded);
  assert.equal(await workspace.isVisible(), !simple || expanded);
  if (simple) {
    assert.equal(await status.locator('[data-chat-run-meta], time, [data-research-artifact="live"]').count(), 0);
    assert.equal(await status.locator('.chat-task-status-line > [data-research-stop]').count(), 1);
    assert.equal(await metadata.evaluate(element => element.closest('[data-chat-result-more]') !== null), true);
    assert.equal(await workspace.evaluate(element => element.closest('[data-chat-result-more]') !== null), true);
  } else {
    assert.equal(await status.locator('[data-chat-run-meta]').count(), 1);
    assert.equal(await status.locator('[data-research-artifact="live"]').count(), 1);
  }
  assert.equal(await status.locator('.research-conversation-description').isVisible(), true,
    'the running description stays readable with either detail preference');
}
let active: Page | undefined, failure: unknown;
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(30_000);
    // Keep the complete recorded-work assertions in 详细, then revisit the same records in the ordinary 简洁 reading.
    await preferFullCollaboration(context);
    await context.addInitScript(key => { if (!localStorage.getItem(key)) localStorage.setItem(key, 'zh'); }, localeStorageKey);
    const accepted = run('completed'), missing = run('completed'), working = run('running'), unavailable = run('completed'),
      queued = run('completed'), generating = run('completed'), failed = run('completed'), cancelled = run('completed'), exhausted = run('completed'),
      missingTarget = run('completed'), emptyStatement = run('completed'), unrecorded = run('running'), singleTarget = run('completed'),
      repeatedStatement = run('running'), refinedStatement = run('running'), findingOnly = run('running'), waitingReview = run('completed');
    waitingReview.formalization = { id: crypto.randomUUID(), original: originalTask, confirmation: 'pending' };
    delete unrecorded.observation;
    delete repeatedStatement.observation; delete refinedStatement.observation;
    findingOnly.observation!.inspection.tasks = [task('recorded_finding', { kind: 'research', proof: { status: 'not-applicable' }, finding: originalTask })];
    findingOnly.observation!.inspection.progress = { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 1, openProofTasks: [] };
    const runs = [accepted, missing, working, unavailable, queued, generating, failed, cancelled, exhausted, missingTarget, emptyStatement, unrecorded, singleTarget,
      repeatedStatement, refinedStatement, findingOnly, waitingReview],
      conversations = runs.map(conversation);
    const statementFixtures = [{ run: repeatedStatement, text: ` \n${originalTask}\n ` },
      { run: refinedStatement, text: '对任意自然数 a、b，还需要说明 b + a = a + b 的逆向等式。' }].map(({ run: value, text }) => {
      const item: WebFormalization = { id: crypto.randomUUID(), original: originalTask, environment: 'standard', model: 'recorded-fixture', effort: 'high',
        status: 'confirmed', workflow: 'solve', confirmation: 'automatic', runId: value.id, createdAt: at, updatedAt: at, confirmedAt: at, activity: { count: 1 } };
      const activity: WebFormalizationActivity[] = [{ type: 'step', sequence: 1, at, step: { round: 1, step: 'role', workerId: 'recorded-backtranslation', role: 'backtranslate', slot: 'backtranslate',
        state: 'finished', summary: { sections: [{ kind: 'conclusions', items: [text] }] } } }];
      conversations[runs.indexOf(value)]!.formalizationId = item.id;
      if (value === refinedStatement) conversations[runs.indexOf(value)]!.messages.push({ id: crypto.randomUUID(), role: 'user', kind: 'text', text,
        createdAt: at, status: 'complete' });
      return { item, activity, run: value, text };
    });
    let generated = false, failAcceptedOverview = false, legacyMath = false, explanationLanguage: 'zh' | 'en' = 'zh';
    let generatingPhase: 'auditing' | 'retrying' = 'auditing', slowProgress: Promise<void> | undefined, failProgress = false;
    let browsingSaved = false;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(request.url()); await route.abort(); return; }
      if (!['GET', 'HEAD'].includes(request.method())) { writes.push(`${request.method()} ${url.pathname}`); await route.abort(); return; }
      if (url.pathname === '/api/conversations') {
        await route.fulfill({ json: { conversations: browsingSaved ? conversations.map(({ messages: _, ...summary }) => ({ ...summary, answering: false })) : [] } }); return;
      }
      const selectedConversation = conversations.find(item => url.pathname === `/api/conversations/${item.id}`);
      if (selectedConversation) { await route.fulfill({ json: { conversation: selectedConversation } }); return; }
      if (url.pathname === '/api/runs') { await route.fulfill({ json: { runs: browsingSaved ? runs : [] } }); return; }
      const formalization = statementFixtures.find(fixture => url.pathname === `/api/formalizations/${fixture.item.id}` || url.pathname === `/api/formalizations/${fixture.item.id}/activity`);
      if (formalization) {
        if (url.pathname.endsWith('/activity')) await route.fulfill({ json: { activity: formalization.activity.filter(entry => entry.sequence > Number(url.searchParams.get('after') ?? 0)), dropped: 0 } });
        else await route.fulfill({ json: { formalization: formalization.item } });
        return;
      }
      const selectedRun = runs.find(item => url.pathname.startsWith(`/api/runs/${item.id}`));
      if (selectedRun) {
        const endpoint = url.pathname.slice(`/api/runs/${selectedRun.id}`.length);
        if (!endpoint) { await route.fulfill({ json: { run: selectedRun } }); return; }
        if (endpoint === '/paper') {
          const targets = proofOutline(selectedRun)!.declarations.filter(item => item.role === 'target').map(item => item.name);
          await route.fulfill({ json: { title: selectedRun.title, targets, target: url.searchParams.get('target') ?? targets[0],
            language: url.searchParams.get('language') ?? 'en', defaultProviderId: 'sub2api',
            providers: [{ id: 'sub2api', name: 'Sub2API', defaultModel: 'deepseek-flash', key: 'required' }] } }); return;
        }
        if (endpoint === '/explanations') {
          reads.push(url.pathname);
          if (selectedRun === accepted && failAcceptedOverview) {
            await route.fulfill({ status: 503, json: { error: '临时读取失败（本地模拟）' } }); return;
          }
          if (selectedRun === generating) {
            if (slowProgress) await slowProgress;
            if (failProgress) { await route.fulfill({ status: 503, json: { error: '临时读取进度失败（本地模拟）' } }); return; }
          }
          const fixtureStatus = selectedRun === queued || selectedRun === waitingReview ? 'queued' : selectedRun === generating && !generated ? 'running'
            : selectedRun === failed ? 'error' : selectedRun === cancelled ? 'cancelled' : selectedRun === exhausted ? 'exhausted' : undefined;
          const entries = fixtureStatus ? [{ ...explanation(selectedRun, 'swap_sum', explanationLanguage), document: undefined, status: fixtureStatus,
            ...(selectedRun === waitingReview ? { automatic: true, progress: { phase: 'waiting_review', updatedAt: at } }
              : fixtureStatus === 'queued' ? { queue: { position: 3, ahead: 2 } } : fixtureStatus === 'running'
              ? { progress: { phase: generatingPhase, batches: 3, approvedBatches: 1, round: 2, modelRequestFailures: 2, updatedAt: at } }
              : fixtureStatus === 'error' ? { reason: 'informalization_role_retries_exhausted',
                progress: { phase: 'auditing', modelRequestFailures: 3, updatedAt: at } } : { reason: 'explanation_gateway_unavailable' }) } as WebExplanation] : undefined;
          const savedOverview = overview(selectedRun, [accepted, missingTarget, emptyStatement, singleTarget].includes(selectedRun) || selectedRun === generating && generated, entries,
            selectedRun !== unavailable && selectedRun !== accepted && selectedRun !== working, explanationLanguage);
          if (selectedRun === waitingReview) savedOverview.generation = { available: false, reason: 'not_accepted' };
          if (selectedRun === singleTarget) {
            savedOverview.targets = savedOverview.targets.filter(target => target.name === 'swap_sum');
            savedOverview.explanations = savedOverview.explanations.filter(item => item.target === 'swap_sum');
          }
          await route.fulfill({ json: savedOverview }); return;
        }
        if (endpoint === '/explanations/item') {
          reads.push(url.pathname + url.search); assert.ok([accepted, missingTarget, emptyStatement, singleTarget].includes(selectedRun) || selectedRun === generating && generated);
          assert.equal(url.searchParams.get('language'), explanationLanguage);
          const target = url.searchParams.get('target'); assert.ok(['swap_sum', 'identity_sum'].includes(target!));
          const saved = explanation(selectedRun, target!, explanationLanguage);
          if (selectedRun === missingTarget || selectedRun === emptyStatement) {
            const selected = saved.document!.sections[0]!;
            if (selectedRun === missingTarget) saved.document!.sections.shift();
            else selected.statement = '';
            saved.document!.sections.unshift({ ...explanationDocument('identity_sum').sections[0]!,
              statement: '这是另一目标的已保存陈述，不能作为当前目标的结论。' });
          }
          if (legacyMath && selectedRun === singleTarget) {
            const [main, support] = saved.document!.sections;
            main.title = '**二次关系下换位子的 $n$ 次幂为零**';
            main.statement = 'A²B − (2:ℂ)•(ABA) + BA² = 0';
            main.steps[0].text = '迹条件 htrace 对 $0<k\\le n$ 成立。假设 h 说右端为零。';
            main.steps[0].uses.push({ name: 'matrix_trace', place: 'declaration', spans: [] });
            support.title = '二次关系推出 $A$ 与换位子可交换';
            saved.document!.sections.push({ ...support, name: 'matrix_trace', title: '矩阵版本：迹条件推出 $C^n=0$' });
          }
          await route.fulfill({ json: { explanation: saved } }); return;
        }
        if (endpoint === '/actions') { await route.fulfill({ json: { actions: [], dropped: 0 } }); return; }
        if (endpoint === '/events') { await route.fulfill({ json: { events: [] } }); return; }
        if (endpoint === '/outline') {
          if (selectedRun === accepted) await route.fulfill({ json: { outline: proofOutline(selectedRun) } });
          else await route.fulfill({ status: 404, json: { error: 'No outline in read-only fixture' } });
          return;
        }
      }
      await route.continue();
    });
    const page = active = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/', { timeout: 15_000 });
    await page.locator('[data-navigation-toggle]').waitFor({ timeout: 15_000 });
    await visibleNavigation(page, ['工作台', '我的研究', '定理', '数学家', '数学库']);
    const participation = page.locator('[data-chat-participation]'), input = page.locator('#formalize-original');
    await participation.waitFor({ state: 'attached', timeout: 15_000 });
    assert.equal(await participation.isVisible(), false);
    assert.equal(await participation.locator('input[value="guided"]').isChecked(), true);
    assert.equal(await participation.evaluate(element => element.closest('#formalize-settings') !== null), true);
    assert.equal(await input.evaluate(element => !!(element.compareDocumentPosition(document.querySelector('[data-chat-participation]')!) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    const inputBox = await input.boundingBox(); assert.ok(inputBox && inputBox.y >= 0 && inputBox.y < 1000, 'the task input is immediately visible');
    await fit(page); await screenshot(page, `${width}-input-first.png`);
    await page.locator('#formalize-settings > summary').click();
    assert.equal(await participation.isVisible(), true);
    const advanced = page.locator('[data-chat-advanced-settings]');
    assert.equal(await advanced.evaluate((node: HTMLDetailsElement) => node.open), false, 'optional settings start collapsed');
    for (const selector of ['#formalize-key', '#check-model-connection'])
      assert.equal(await page.locator(selector).isVisible(), true, `${selector} is available in research settings`);
    for (const selector of ['#formalize-environment', ...budgetInputs])
      assert.equal(await page.locator(selector).isVisible(), false, `${selector} belongs to optional advanced setup`);
    await screenshot(page, `${width}-simple-settings.png`);
    await advanced.locator(':scope > summary').click({ timeout: 15_000 });
    for (const selector of budgetInputs) { assert.equal(await page.locator(selector).inputValue(), ''); assert.equal(await page.locator(selector).getAttribute('placeholder'), '不限'); }
    await fit(page); await screenshot(page, `${width}-unlimited-settings.png`);
    await advanced.locator(':scope > summary').click({ timeout: 15_000 });
    mark(`${width}: visible task input, collapsed guided participation and empty unlimited budgets`);
    const modelMenu = page.locator('#chat-model-settings > summary');
    await modelMenu.click();
    for (const selector of ['#formalize-provider', '#formalize-model', '#formalize-effort'])
      assert.equal(await page.locator(selector).isVisible(), true, `${selector} is available in model settings`);
    assert.equal(await page.locator('#formalize-key').isVisible(), false, 'model settings never opens the key field');
    await modelMenu.click();
    const draft = '保留这份题目草稿，在配置 Key 后再发送。';
    await input.fill(draft);
    await page.locator('[data-chat-configure-key]').click();
    assert.equal(await page.locator('#formalize-settings').evaluate((node: HTMLDetailsElement) => node.open), true);
    assert.equal(await page.locator('#formalize-key').evaluate(node => document.activeElement === node), true);
    assert.equal(await input.inputValue(), draft); assert.deepEqual(writes, []);
    await page.locator('#formalize-key').fill('disposable-fixture-key');
    assert.equal(await page.locator('[data-chat-key-required]').count(), 0);
    assert.equal(await page.locator('#formalize-start').isEnabled(), true);
    await page.locator('#formalize-settings > summary').click();
    await fit(page); await screenshot(page, `${width}-key-next-step.png`);
    mark(`${width}: missing-key action opens and focuses settings while retaining the unsent draft`);

    browsingSaved = true;
    await page.goto(`${origin}/?chat=${conversations[0].id}`, { timeout: 15_000 });
    const answer = page.locator('[data-chat-answer]');
    await answer.locator('[data-chat-answer-document="swap_sum"]').waitFor({ timeout: 15_000 });
    const draftLink = page.locator('[data-chat-paper]');
    assert.equal(await draftLink.evaluate(element => element.previousElementSibling?.getAttribute('data-research-artifact')), 'source');
    await page.mouse.move(0, 0);
    const artifactStyle = (element: Element) => {
      const { borderRadius, borderColor, height, padding, fontSize, fontWeight } = getComputedStyle(element);
      return { borderRadius, borderColor, height, padding, fontSize, fontWeight };
    };
    assert.deepEqual(await draftLink.evaluate(artifactStyle),
      await page.locator('.research-conversation-artifacts [data-research-artifact="source"]').evaluate(artifactStyle),
      'The paper link shares the accepted proof button style');
    await draftLink.click();
    assert.equal(new URL(page.url()).searchParams.get('run'), accepted.id);
    assert.equal(new URL(page.url()).searchParams.get('chat'), conversations[0].id);
    await page.getByText('swap_sum', { exact: true }).first().waitFor();
    await page.getByRole('heading', { name: '尚无论文初稿' }).waitFor();
    assert.equal(await page.getByText('main.tex', { exact: true }).count(), 0);
    assert.equal(await page.locator('a[download]').count(), 0);
    await fit(page);
    if (width === 1440) {
      assert.deepEqual(await page.getByLabel('目标定理').locator('option').allTextContents(), ['swap_sum', 'identity_sum']);
      await page.getByRole('button', { name: '生成初稿', exact: true }).click();
      await page.getByRole('dialog').getByLabel('API Key').waitFor();
      await page.keyboard.press('Escape');
    }
    await page.getByRole('link', { name: '返回对话', exact: true }).click();
    await page.locator(`[data-conversation="${conversations[0].id}"] [data-chat-paper]`).waitFor();
    await answer.locator('[data-chat-answer-document="swap_sum"]').waitFor({ timeout: 15_000 });
    mark(`${width}: accepted proof opens an empty paper draft without a model request and returns to the same conversation`);
    const more = page.locator('[data-chat-result-more]');
    const fullAcceptedDescription = await page.locator('.research-conversation-status .research-conversation-description').innerText();
    assert.equal(await page.locator('.research-conversation-status [data-chat-run-meta]').count(), 1,
      'full reading keeps accepted run metadata in the status');
    assert.equal(await page.locator('[data-chat-run-meta]').count(), 1);
    assert.equal(await more.locator('.research-conversation-description, [data-chat-run-meta]').count(), 0);
    assert.equal(await answer.locator('[data-chat-explain], [data-chat-answer-refresh]').count(), 0, 'readable answers keep secondary explanation actions in the existing details');
    assert.equal(await more.evaluate((node: HTMLDetailsElement) => node.open), false);
    assert.match(await answer.innerText(), /已有讲解概览：使用自然数加法交换律/u);
    assert.match(await answer.locator('.chat-answer-steps').innerText(), /将自然数 a 和 b 代入加法交换律/u);
    assert.equal(await answer.locator('.chat-answer-uses code').innerText(), 'Nat.add_comm');
    assert.equal(await answer.locator('.chat-answer-support').evaluate((element: HTMLDetailsElement) => element.open), false);
    assert.equal(await answer.locator('[data-chat-answer-select] option').count(), 2);
    assert.equal(await answer.locator('[data-chat-answer-select] option:checked').innerText(), '加法交换律');
    await answerOrder(page, 'swap_sum');
    assert.equal(await answer.locator('[data-chat-answer-target="swap_sum"]').getAttribute('id'), `chat-answer-${accepted.id}-swap_sum-swap_sum`);
    await beforeProcess(page, '[data-chat-answer]');
    await answer.locator('h3').scrollIntoViewIfNeeded();
    await fit(page); await screenshot(page, `${width}-saved-explanation.png`);
    await input.fill('保留已写的独立追问。');
    await answer.locator('[data-chat-answer-question="swap_sum:0"]').focus();
    await page.keyboard.press('Enter');
    const followup = await input.inputValue();
    assert.ok(followup.startsWith('保留已写的独立追问。\n\n'));
    for (const text of ['加法交换律', '第 1 步', '对任意自然数', '将自然数 a 和 b', 'Nat.add_comm', accepted.id]) assert.ok(followup.includes(text));
    const stepUrl = `${origin}/explain.html?run=${accepted.id}&target=swap_sum&language=zh#at=swap_sum&step=1`;
    assert.ok(followup.includes(stepUrl));
    if (width === 1440) {
      const reader = await context.newPage();
      reader.on('pageerror', error => errors.push(error.message));
      try {
        await reader.goto(stepUrl);
        await reader.locator('.explain-section.is-target .explain-steps > li.is-active').filter({ hasText: '将自然数 a 和 b 代入加法交换律' }).waitFor();
      } finally { await reader.close(); }
    }
    assert.deepEqual(writes, [], 'step questioning prepares a draft without sending it');
    await answer.locator('[data-chat-answer-use="supporting_identity"]').click();
    assert.equal(await answer.locator('.chat-answer-support').evaluate((element: HTMLDetailsElement) => element.open), true);
    assert.equal(await answer.locator('.chat-answer-support').evaluate(element => document.activeElement === element), true);
    assert.match(await answer.locator('.chat-answer-support').innerText(), /辅助定义保留/u);
    const referenceBounds = await answer.locator('.chat-answer-support > summary').evaluate(async element => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const reference = element.getBoundingClientRect(), thread = document.querySelector('#research-chat-thread')!.getBoundingClientRect();
      return { top: reference.top, bottom: reference.bottom, height: reference.height,
        visibleTop: Math.max(thread.top, 0), visibleBottom: Math.min(thread.bottom, innerHeight) };
    });
    assert.ok(referenceBounds.height > 0 && referenceBounds.top >= referenceBounds.visibleTop - 1 && referenceBounds.bottom <= referenceBounds.visibleBottom + 1,
      `following a local citation reveals its named definition in the chat viewport: ${JSON.stringify(referenceBounds)}`);
    await fit(page); await screenshot(page, `${width}-step-question-and-definition.png`);
    mark(`${width}: human target title, selected-step question with precise context, existing follow-up preservation and local definition expansion`);

    await more.locator(':scope > summary').click();
    const explanationLink = more.locator('[data-chat-explain]');
    assert.equal(await explanationLink.innerText(), '打开完整讲解');
    assert.equal(await explanationLink.getAttribute('target'), '_blank');
    const explanationUrl = new URL(await explanationLink.getAttribute('href') ?? '', page.url());
    assert.equal(explanationUrl.pathname, '/explain.html');
    assert.equal(explanationUrl.searchParams.get('run'), accepted.id);
    assert.equal(explanationUrl.searchParams.get('target'), 'swap_sum');
    const readsBeforeRefresh = reads.length;
    failAcceptedOverview = true;
    await more.locator('[data-chat-answer-refresh]').click();
    await answer.locator('[data-chat-answer-retry]').waitFor({ timeout: 15_000 });
    assert.ok(reads.slice(readsBeforeRefresh).includes(`/api/runs/${accepted.id}/explanations`), 'the relocated refresh reads the saved explanation overview');
    assert.equal(await answer.locator('[data-chat-answer-document="swap_sum"]').count(), 1);
    assert.match(await answer.innerText(), /刷新失败，下面保留上次读取的解答/u);
    assert.match(await answer.locator('[data-chat-answer-document="swap_sum"]').innerText(), /将自然数 a 和 b 代入加法交换律/u);
    assert.equal(await answer.locator('[data-chat-explain], [data-chat-answer-refresh]').count(), 0);
    assert.equal(await input.inputValue(), followup);
    assert.deepEqual(writes, []); assert.deepEqual(forbiddenCalls, []);
    await answer.locator('h3').scrollIntoViewIfNeeded();
    await fit(page); await screenshot(page, `${width}-refresh-preserves-explanation.png`);
    failAcceptedOverview = false; await answer.locator('[data-chat-answer-retry]').click();
    await page.waitForFunction(() => !document.querySelector('[data-chat-answer-retry]'), undefined, { timeout: 15_000 });
    assert.equal(await answer.locator('[data-chat-answer-document="swap_sum"]').count(), 1);
    assert.equal(await input.inputValue(), followup);
    assert.deepEqual(writes, []); assert.deepEqual(forbiddenCalls, []);
    await more.locator(':scope > summary').click();
    assert.equal(await more.evaluate((node: HTMLDetailsElement) => node.open), false);
    mark(`${width}: transient read failure preserves the readable solution and retry recovers in place`);
    await nextAnswerWithKeyboard(page);
    await answer.locator('[data-chat-answer-document="identity_sum"]').waitFor({ timeout: 15_000 });
    assert.match(await answer.innerText(), /零是自然数加法的右单位元/u);
    assert.equal(await answer.locator('.chat-answer-uses code').innerText(), 'Nat.add_zero');
    assert.equal(await answer.locator('[data-chat-answer-document="swap_sum"]').count(), 0);
    await answerOrder(page, 'identity_sum');
    await answer.locator('h3').scrollIntoViewIfNeeded();
    await fit(page); await screenshot(page, `${width}-second-target.png`);
    mark(`${width}: saved explanation overview, statement, steps and citation are readable directly; target switching reads the selected document`);
    assert.equal(await answer.locator('[data-chat-explain], [data-chat-answer-refresh]').count(), 0);
    assert.equal(await more.evaluate((node: HTMLDetailsElement) => node.open), false);
    assert.equal(await page.locator('[data-research-artifact="source"]').isVisible(), true);
    assert.equal(await page.locator('[data-chat-download-kit]').isVisible(), false);
    await more.locator(':scope > summary').click();
    assert.equal(await more.locator('[data-chat-answer-refresh]').isVisible(), true);
    const selectedExplanation = new URL(await more.locator('[data-chat-explain]').getAttribute('href') ?? '', page.url());
    assert.equal(selectedExplanation.pathname, '/explain.html');
    assert.equal(selectedExplanation.searchParams.get('run'), accepted.id);
    assert.equal(selectedExplanation.searchParams.get('target'), 'identity_sum', 'the details link follows the current canonical target');
    for (const selector of ['[data-research-artifact="roadmap"]', '[data-research-artifact="result"]', '[data-chat-download-kit]', '[data-chat-share]'])
      assert.equal(await more.locator(selector).isVisible(), true);
    await fit(page); await screenshot(page, `${width}-more-result-actions.png`);
    mark(`${width}: accepted proof stays directly accessible and secondary result actions remain in the collapsed menu`);

    await more.getByRole('button', { name: '修改题目', exact: true }).click();
    await page.locator('[data-chat-editing-problem]').waitFor({ timeout: 15_000 });
    assert.equal(new URL(page.url()).searchParams.get('editProblem'), conversations[0].id);
    assert.equal(await input.inputValue(), conversations[0].messages[0].text);
    const edited = '任务 A 的独立修改：请进一步证明交换律的变体。';
    await input.fill(edited); await page.reload({ timeout: 15_000 });
    await page.waitForFunction(value => document.querySelector<HTMLTextAreaElement>('#formalize-original')?.value === value, edited, { timeout: 15_000 });
    assert.equal(await page.locator('[data-chat-editing-problem]').count(), 1);
    await page.locator('[data-chat-return-home]').click();
    await page.waitForFunction(value => document.querySelector<HTMLTextAreaElement>('#formalize-original')?.value === value, draft, { timeout: 15_000 });
    assert.equal(new URL(page.url()).search, '');
    await page.goBack({ timeout: 15_000 });
    await page.waitForFunction(value => document.querySelector<HTMLTextAreaElement>('#formalize-original')?.value === value, edited, { timeout: 15_000 });
    await fit(page); await screenshot(page, `${width}-separate-problem-edit.png`);
    assert.deepEqual(writes, []);
    mark(`${width}: editing a historical problem preserves the home draft and the separate edit through reload and browser Back`);
    await openNavigationMenu(page);
    const libraryLink = page.locator('#topbar a[data-workbench-library]');
    await libraryLink.click();
    await page.locator('.research-page .topbar').waitFor({ timeout: 15_000 });
    assert.equal(new URL(page.url()).searchParams.get('workbenchEdit'), conversations[0].id);
    const editReturn = page.locator('.topbar a').filter({ hasText: '工作台' });
    assert.equal(new URL(await editReturn.getAttribute('href') ?? '', page.url()).searchParams.get('editProblem'), conversations[0].id);
    await editReturn.click();
    await page.waitForFunction(value => document.querySelector<HTMLTextAreaElement>('#formalize-original')?.value === value, edited, { timeout: 15_000 });
    assert.equal(await page.locator('[data-chat-editing-problem]').count(), 1);
    await page.locator('[data-chat-return-home]').click();
    await page.waitForFunction(value => document.querySelector<HTMLTextAreaElement>('#formalize-original')?.value === value, draft, { timeout: 15_000 });
    mark(`${width}: Library browsing returns to the separate edited problem and keeps the original home draft intact`);

    await page.goto(`${origin}/?chat=${conversations[1].id}`, { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('[data-chat-answer]')?.textContent?.includes('这份验收证明还没有可阅读的讲解。'), undefined, { timeout: 15_000 });
    const generate = page.locator('[data-chat-answer] [data-chat-explain]');
    assert.equal(await generate.innerText(), '生成详细解答'); assert.equal(await generate.getAttribute('target'), '_blank');
    const generationUrl = new URL(await generate.getAttribute('href') ?? '', page.url());
    assert.equal(generationUrl.pathname, '/explain.html'); assert.equal(generationUrl.searchParams.get('run'), missing.id);
    assert.equal(generationUrl.searchParams.get('target'), 'swap_sum');
    assert.equal(await page.locator('[data-chat-answer-document]').count(), 0);
    assert.equal(reads.some(url => url.includes(`/api/runs/${missing.id}/explanations/item`)), false);
    assert.deepEqual(writes, []); await fit(page); await screenshot(page, `${width}-missing-explanation.png`);
    mark(`${width}: missing saved explanation has an explicit generation link and performs no generation request`);

    for (const [value, status, text] of [
      [unavailable, 'unavailable', '当前服务不提供证明讲解。'], [queued, 'queued', '前面 2 份'],
      [generating, 'running', '正在核对讲解与证明'], [failed, 'error', '模型请求反复失败，自动重试已停止。'],
      [cancelled, 'cancelled', '已停止生成'], [exhausted, 'exhausted', '讲解没有完成'],
    ] as const) {
      await page.goto(`${origin}/?chat=${conversations[runs.indexOf(value)]!.id}`, { timeout: 15_000 });
      const state = page.locator(`[data-chat-answer-status="${status}"]`); await state.waitFor({ timeout: 15_000 });
      assert.ok((await state.innerText()).includes(text));
      if (status === 'unavailable') assert.equal(await state.locator('[data-chat-explain], [data-chat-answer-refresh]').count(), 0,
        'an unavailable service with no saved explanation offers no generation or refresh action');
      else {
        assert.equal(await state.locator('[data-chat-explain]').innerText(), ['queued', 'running'].includes(status) ? '查看讲解进度' : '重新生成详细解答');
        assert.equal(await state.locator('[data-chat-answer-refresh]').isVisible(), true,
          'queued, running and stopped explanations retain their refresh action');
      }
      if (status === 'running') {
        assert.match(await state.innerText(), /已通过批次\s+1\s*\/\s*3/u);
        assert.equal(await state.getByText('讲解第 2 轮').isVisible(), true);
        assert.equal(await state.getByText('模型请求失败 2 次').isVisible(), true);
        if (width === 390) {
          let releaseSlowProgress!: () => void;
          slowProgress = new Promise<void>(resolve => { releaseSlowProgress = resolve; });
          try {
            const overviewPath = `/api/runs/${generating.id}/explanations`;
            await page.waitForRequest(request => new URL(request.url()).pathname === overviewPath);
            await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[data-chat-answer-refresh]')?.disabled === true);
            assert.equal(await state.getByText('正在核对讲解与证明').isVisible(), true);
            assert.equal(await state.getByText('模型请求失败 2 次').isVisible(), true);
            assert.equal(await state.getByText('正在读取已有讲解…').count(), 0);
            failProgress = true;
          } finally {
            slowProgress = undefined;
            releaseSlowProgress();
          }
          await state.getByText('讲解状态暂时无法更新，下面显示上次获取的进度。').waitFor();
          assert.equal(await state.getByText('讲解第 2 轮').isVisible(), true);
          failProgress = false; generatingPhase = 'retrying';
          await state.locator('[data-chat-answer-retry]').click();
          await state.getByText('模型请求失败，正在自动重试').waitFor();
          assert.equal(await state.getByText('讲解第 2 轮').isVisible(), true);
          await fit(page); await screenshot(page, `${width}-explanation-retrying.png`);
        }
        generated = true;
        await page.locator('[data-chat-answer-document="swap_sum"]').waitFor({ timeout: 15_000 });
      }
      if (status === 'error') assert.equal(await state.getByText('模型请求失败 3 次').isVisible(), true);
      await fit(page); await screenshot(page, `${width}-explanation-${status}.png`);
    }
    mark(`${width}: unavailable, queued, running, failed, cancelled and incomplete explanations show accurate states; the finished document appears automatically without generation`);

    if (width === 390) {
      await page.goto(`${origin}/?chat=${conversations[runs.indexOf(waitingReview)]!.id}`, { timeout: 15_000 });
      const waiting = page.locator('[data-chat-answer-status="queued"]');
      await waiting.getByText('题意审核通过后，讲解会自动进入生成队列。').waitFor();
      assert.equal(await waiting.getByText('等待原题含义审核').isVisible(), true);
      assert.equal(await waiting.locator('.spinner').count(), 0);
      assert.equal(await waiting.getByText('讲解会在后台继续，完成后自动显示。').count(), 0);
      await fit(page); await screenshot(page, `${width}-explanation-waiting-review.png`);
      waitingReview.formalization!.confirmation = 'rejected';
      await page.reload();
      await page.getByText('原题含义审核尚未通过，暂未生成讲解。').waitFor();
      assert.equal(await page.locator('[data-chat-answer] [data-chat-explain]').count(), 0);
      assert.equal(await page.locator('[data-research-artifact="source"]').isVisible(), true);
      const reviewFailure: WebFormalization = { id: waitingReview.formalization!.id, original: originalTask, environment: 'standard',
        model: 'recorded-fixture', effort: 'high', status: 'error', createdAt: at, updatedAt: at, runId: waitingReview.id,
        reason: 'formalization_role_incomplete', progress: { phase: 'reviewing' },
        compiled: { digest: 'fixture', source, sourceSha256: 'fixture', round: 1 } };
      await page.route(`${origin}/api/formalizations/${reviewFailure.id}`, route => route.fulfill({ json: { formalization: reviewFailure } }));
      conversations[runs.indexOf(waitingReview)]!.formalizationId = reviewFailure.id;
      waitingReview.formalization!.confirmation = 'interrupted';
      await page.reload();
      const failure = page.locator('[data-formalization-failure]');
      await failure.getByText('formalization_role_incomplete').waitFor();
      assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'true');
      assert.equal(await page.locator('[data-chat-result-more]').evaluate(node => (node as HTMLDetailsElement).open), false);
      assert.equal(await failure.locator('[data-research-artifact="original"]').isVisible(), true);
      mark(`${width}: waiting for statement review, model retries, and a failed status refresh show distinct states without concealing progress`);
    }

    for (const [value, kind] of [[missingTarget, 'missing-target'], [emptyStatement, 'empty-statement']] as const) {
      await page.goto(`${origin}/?chat=${conversations[runs.indexOf(value)]!.id}`, { timeout: 15_000 });
      const document = answer.locator('[data-chat-answer-document="swap_sum"]');
      await document.waitFor({ timeout: 15_000 });
      assert.equal(await document.locator('[data-chat-answer-conclusion]').count(), 0,
        'a missing selected statement never borrows another target as its conclusion');
      assert.ok((await document.locator('[data-chat-answer-idea]').innerText()).includes(explanationDocument('swap_sum').overview));
      assert.equal(await document.locator('[data-chat-answer-idea]').evaluate(element => !!(element.compareDocumentPosition(
        window.document.querySelector('[data-chat-answer-derivation]')!) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
      assert.ok((await document.locator('[data-chat-answer-derivation]').innerText()).includes('这是另一目标的已保存陈述，不能作为当前目标的结论。'));
      assert.equal(await document.getByRole('heading', { name: '加法右单位元', exact: true }).isVisible(), true,
        'another saved target keeps its visible name even when the selector names the current target');
      if (value === emptyStatement) {
        assert.equal(await document.getByRole('heading', { name: '加法交换律', exact: true }).isVisible(), true,
          'both target titles remain visible in a document with multiple target sections');
        assert.equal(await document.locator('[data-chat-answer-target="swap_sum"]').getAttribute('id'), `chat-answer-${value.id}-swap_sum-swap_sum`);
        await answer.locator('[data-chat-answer-question="swap_sum:0"]').click();
        assert.ok((await input.inputValue()).includes(`${origin}/explain.html?run=${value.id}&target=swap_sum&language=zh#at=swap_sum&step=1`),
          'the selected step retains the original saved section index after other target sections');
      }
      assert.deepEqual(writes, []); assert.deepEqual(forbiddenCalls, []);
      await answer.locator('h3').scrollIntoViewIfNeeded();
      await fit(page); await screenshot(page, `${width}-${kind}-conclusion.png`);
    }
    mark(`${width}: missing target and empty selected statement retain the saved idea and derivation without inventing a conclusion or changing source anchors`);

    await page.goto(`${origin}/?chat=${conversations[runs.indexOf(singleTarget)]!.id}`, { timeout: 15_000 });
    await answer.locator('[data-chat-answer-document="swap_sum"]').waitFor({ timeout: 15_000 });
    assert.equal(await answer.locator('[data-chat-answer-select]').count(), 0);
    await answerOrder(page, 'swap_sum', 'zh', false);
    assert.equal(await answer.getByRole('heading', { name: '加法交换律', exact: true }).isVisible(), true);
    await input.fill('保留只有一个阅读目标的追问。');
    await answer.locator('[data-chat-answer-question="swap_sum:0"]').focus();
    await page.keyboard.press('Enter');
    const singleFollowup = await input.inputValue();
    assert.ok(singleFollowup.startsWith('保留只有一个阅读目标的追问。\n\n'));
    for (const text of ['加法交换律', '对任意自然数', 'Nat.add_comm', `${origin}/explain.html?run=${singleTarget.id}&target=swap_sum&language=zh#at=swap_sum&step=1`])
      assert.ok(singleFollowup.includes(text));
    assert.deepEqual(writes, []); assert.deepEqual(forbiddenCalls, []);
    await answer.locator('h3').scrollIntoViewIfNeeded();
    await fit(page); await screenshot(page, `${width}-single-target-name.png`);
    mark(`${width}: a saved answer with one selectable target retains its visible target name and keyboard step questions without a selector`);

    legacyMath = true;
    singleTarget.observation = observation(singleTarget.id);
    await page.reload();
    const matrix = answer.locator('[data-chat-answer-document="swap_sum"]');
    await matrix.locator('h4 strong .math[data-math-state="ready"]').waitFor();
    assert.equal(await matrix.locator('h4 strong .math').getAttribute('title'), 'n');
    for (const [name, formula] of [['supporting_identity', 'A'], ['matrix_trace', 'C^n=0']]) {
      const link = matrix.locator(`[data-chat-answer-use="${name}"]`);
      await link.locator('.math[data-math-state="ready"]').waitFor();
      assert.equal(await link.locator('.math').getAttribute('title'), formula);
      await link.focus(); await page.keyboard.press('Enter');
      const section = matrix.locator(`details[id$="-${name}"]`);
      await section.locator('summary .math[data-math-state="ready"]').waitFor();
      assert.equal(await section.locator('summary .math').getAttribute('title'), formula);
      assert.equal(await section.evaluate((node: HTMLDetailsElement) => node.open && document.activeElement === node), true);
    }
    assert.match(await matrix.locator('[data-chat-answer-conclusion]').innerText(), /A²B − 2ABA \+ BA² = 0/u);
    assert.doesNotMatch(await matrix.locator('.chat-answer-steps').innerText(), /\bh(?:trace)?\b/u);
    assert.equal(await page.locator('[data-chat-plan-progress]').count(), 0, 'An accepted run with recorded plan tasks never shows an incomplete-looking counter');
    await fit(page);
    mark(`${width}: formula titles, keyboard citations and readable notation in a legacy explanation, with a clear final verdict`);
    legacyMath = false;

    await page.goto(`${origin}/?chat=${conversations[2].id}`, { timeout: 15_000 });
    const mathematics = page.locator('[data-chat-mathematics]');
    await mathematics.locator('[data-chat-math-checked]').waitFor({ timeout: 15_000 });
    await runningMetadata(page, false);
    for (const selector of ['[data-chat-math-checked]', '[data-chat-math-working]', '[data-chat-math-blockers]', '[data-chat-math-finding]']) await beforeProcess(page, selector);
    assert.equal(await mathematics.locator('[data-chat-math-checked] [data-chat-math-task]').count(), 4);
    assert.equal(await mathematics.locator('[data-chat-math-checked] [data-chat-math-task="conditional_helper"]').count(), 0);
    assert.equal(await mathematics.locator('[data-chat-math-task="paused_helper"]').count(), 0);
    assert.equal(await mathematics.locator('[data-chat-math-working] [data-chat-math-task="working_target"]').count(), 1);
    assert.equal(await mathematics.locator('[data-chat-math-working] [data-chat-math-task="conditional_helper"]').count(), 1);
    for (const [id, status, label] of [['working_target', 'running', '正在证明'], ['delivered_helper', 'delivered', '候选已提交，等待检查'],
      ['conditional_helper', 'conditional', '候选仍有前提待证明']]) {
      const row = mathematics.locator(`[data-chat-math-task="${id}"]`).locator('..');
      assert.equal(await row.locator(`[data-chat-math-status="${status}"]`).innerText(), label);
    }
    assert.equal(await mathematics.locator('[data-chat-math-blockers]').evaluate(element => !!(element.compareDocumentPosition(document.querySelector('[data-chat-math-working]')!) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    assert.equal(await mathematics.locator('[data-chat-math-working]').evaluate(element => !!(element.compareDocumentPosition(document.querySelector('[data-chat-math-checked]')!) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    assert.match(await mathematics.locator('[data-chat-math-blockers]').innerText(), /主目标的归纳步骤仍缺少一个等式变换/u);
    assert.match(await mathematics.locator('[data-chat-math-finding]').innerText(), /先使用结合律，再应用交换律/u);
    assert.equal(await mathematics.locator('[data-chat-math-finding] time').count(), 0, 'findings do not acquire heartbeat timestamps');
    assert.equal(await page.locator('[data-chat-answer]').count(), 0, 'checked helpers do not imply an accepted whole proof');
    assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false');
    const remaining = mathematics.locator('[data-chat-math-checked] details');
    assert.equal(await remaining.evaluate((element: HTMLDetailsElement) => element.open), false);
    await remaining.locator('summary').click();
    assert.equal(await mathematics.locator('[data-chat-math-task="checked_fourth"]').isVisible(), true);
    await mathematics.locator('h3').scrollIntoViewIfNeeded();
    await fit(page); await screenshot(page, `${width}-mathematical-progress.png`);
    await mathematics.locator('[data-chat-math-blockers]').scrollIntoViewIfNeeded();
    await mathematics.locator('[data-chat-math-finding]').scrollIntoViewIfNeeded();
    assert.equal(await mathematics.locator('[data-chat-math-finding]').isVisible(), true);
    await screenshot(page, `${width}-mathematical-findings.png`);
    mark(`${width}: checked helpers, current work, blocker and untimestamped finding precede technical process details without claiming whole-proof acceptance`);

    await page.evaluate(key => localStorage.setItem(key, 'simple'), collaborationDetailStorageKey);
    await page.goto(`${origin}/?chat=${conversations[2].id}`, { timeout: 15_000 });
    const summary = page.locator('[data-chat-math-summary]');
    await summary.waitFor({ timeout: 15_000 });
    await runningMetadata(page, true);
    assert.equal(await page.locator('[data-chat-result-more]').evaluate((element: HTMLDetailsElement) => element.open), false);
    assert.equal(await mathematics.isVisible(), false, 'full records stay behind the existing closed disclosure in simple reading');
    const summaryText = await summary.innerText();
    for (const text of ['主目标的归纳步骤仍缺少一个等式变换。', '正在把辅助引理组合成主目标。', '正在证明', '已检查：自然数加法可以交换次序。'])
      assert.ok(summaryText.includes(text), `simple reading shows the recorded fact: ${text}`);
    assert.equal(await summary.locator('[data-chat-math-summary-checked]').getAttribute('data-chat-math-summary-checked'), '4');
    assert.equal(await summary.locator('[data-chat-math-summary-checked] h4').innerText(), '已检查的引理与目标（4）');
    assert.equal(await summary.locator('[data-chat-math-summary-status="running"]').innerText(), '正在证明');
    for (const text of ['已检查：加上零不改变自然数。', '已检查：自然数加法满足结合律。', '已暂停的引理', '先使用结合律，再应用交换律'])
      assert.ok(!summaryText.includes(text), 'simple reading shows a short selection while the complete records remain reachable');
    assert.doesNotMatch(summaryText, /%|百分比|预计|ETA/iu);
    assert.equal(await page.locator('[data-chat-answer]').count(), 0);
    assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false');
    const progressToggle = page.locator('[data-chat-result-more] > summary');
    assert.equal(await page.locator('[data-chat-math-more]').count(), 0);
    assert.equal(await progressToggle.count(), 1, 'the existing native disclosure is the only progress entry');
    await summary.scrollIntoViewIfNeeded();
    await fit(page); await screenshot(page, `${width}-simple-mathematical-summary.png`);
    await progressToggle.click();
    await mathematics.waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement === document.querySelector('[data-chat-mathematics]'), undefined, { timeout: 15_000 });
    assert.equal(await page.locator('[data-chat-result-more]').evaluate((element: HTMLDetailsElement) => element.open), true);
    assert.equal(await mathematics.evaluate(element => element.closest('[data-chat-result-more]') !== null), true,
      'simple reading opens complete mathematical records inside the existing solving-progress disclosure');
    assert.equal(await summary.isVisible(), false, 'opening the full records hides the duplicate summary');
    assert.equal(await mathematics.locator('[data-chat-math-checked] [data-chat-math-task]').count(), 4);
    assert.equal(await mathematics.locator('[data-chat-math-working] [data-chat-math-task="conditional_helper"]').count(), 1);
    assert.equal(await mathematics.locator('[data-chat-math-task="paused_helper"]').count(), 0);
    assert.equal(await mathematics.locator('[data-chat-math-finding] time').count(), 0);
    await runningMetadata(page, true, true);
    await fit(page); await mathematicsHeadingInView(page);
    await screenshot(page, `${width}-simple-mathematical-details.png`);
    await progressToggle.click();
    assert.equal(await summary.isVisible(), true);
    assert.equal(await mathematics.isVisible(), false);
    assert.equal(await summary.innerText(), summaryText, 'returning to the conversation restores the same saved facts');
    await runningMetadata(page, true);
    assert.equal(await progressToggle.evaluate(async element => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return document.activeElement === element;
    }), true, 'closing the native disclosure keeps focus on its summary');
    assert.deepEqual(writes, []); assert.deepEqual(forbiddenCalls, []);
    mark(`${width}: simple running proof shows the recorded blocker, current goal and checked count; one disclosure opens and focuses the full records and folds back without extra work`);

    await page.goto(`${origin}/?chat=${conversations[0].id}`, { timeout: 15_000 });
    await answer.locator('[data-chat-answer-document="swap_sum"]').waitFor({ timeout: 15_000 });
    const acceptedStatus = page.locator('.research-conversation-status'), acceptedDescription = page.locator('.research-conversation-description'),
      acceptedMetadata = page.locator('[data-chat-run-meta]');
    assert.equal(await acceptedStatus.getAttribute('data-accepted'), 'true');
    assert.equal(await acceptedStatus.locator('.research-conversation-state strong').innerText(), '完整原题通过');
    assert.equal(await acceptedStatus.locator('.research-conversation-description, [data-chat-run-meta], time').count(), 0);
    assert.equal(await acceptedDescription.count(), 1);
    assert.equal(await more.locator('.research-conversation-description').count(), 1);
    assert.equal(await acceptedDescription.textContent(), fullAcceptedDescription);
    assert.equal(await acceptedDescription.isVisible(), false);
    assert.equal(await acceptedMetadata.count(), 1);
    assert.equal(await more.locator('[data-chat-run-meta] time').count(), 1);
    assert.equal(await acceptedMetadata.isVisible(), false);
    assert.equal(await page.locator('[data-research-stop]').count(), 0);
    assert.equal(await page.locator('[data-research-artifact="source"]').count(), 1);
    assert.equal(await answer.isVisible(), true);
    await answerOrder(page, 'swap_sum');
    await input.fill('保留简洁模式的独立追问。');
    await answer.locator('[data-chat-answer-question="swap_sum:0"]').click();
    const simpleFollowup = await input.inputValue();
    assert.ok(simpleFollowup.startsWith('保留简洁模式的独立追问。\n\n'));
    assert.ok(simpleFollowup.includes(stepUrl));
    await acceptedStatus.scrollIntoViewIfNeeded();
    await fit(page); await screenshot(page, `${width}-simple-accepted-solution.png`);
    await more.locator(':scope > summary').click();
    assert.equal(await acceptedDescription.isVisible(), true);
    assert.equal(await acceptedDescription.innerText(), fullAcceptedDescription);
    assert.equal(await acceptedMetadata.isVisible(), true);
    assert.equal(await answer.locator('[data-chat-answer-document="swap_sum"]').count(), 1);
    assert.equal(await input.inputValue(), simpleFollowup);
    await acceptedDescription.scrollIntoViewIfNeeded();
    await fit(page); await screenshot(page, `${width}-simple-accepted-details.png`);
    await more.locator(':scope > summary').click();
    assert.equal(await acceptedDescription.isVisible(), false);
    assert.equal(await acceptedMetadata.isVisible(), false);
    await answer.locator('[data-chat-answer-select]').selectOption('identity_sum');
    await answer.locator('[data-chat-answer-document="identity_sum"]').waitFor({ timeout: 15_000 });
    await answerOrder(page, 'identity_sum');
    assert.equal(await answer.locator('[data-chat-answer-document="swap_sum"]').count(), 0);
    assert.equal(await input.inputValue(), simpleFollowup);
    assert.equal(new URL(await more.locator('[data-chat-explain]').getAttribute('href') ?? '', page.url()).searchParams.get('target'), 'identity_sum');
    assert.equal(await acceptedDescription.count(), 1);
    assert.equal(await acceptedMetadata.count(), 1);
    assert.deepEqual(writes, []); assert.deepEqual(forbiddenCalls, []);
    mark(`${width}: simple accepted solution keeps its verdict and answer visible, retains one technical description and metadata in details, and preserves the follow-up through disclosure and target changes`);

    await page.goto(`${origin}/?chat=${conversations[runs.indexOf(unrecorded)]!.id}`, { timeout: 15_000 });
    await page.locator('.research-conversation-status').waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('[data-chat-math-summary]').count(), 0,
      'a run with no observation or formalization activity has no invented mathematical summary');
    assert.equal(await page.locator('[data-chat-math-checked], [data-chat-math-working], [data-chat-math-blockers], [data-chat-math-finding]').count(), 0);
    assert.equal(await mathematics.count(), 0, 'empty full mathematics records do not render a heading or placeholder');
    await openChatResultDetails(page);
    assert.equal(await mathematics.count(), 0, 'opening process details does not create an empty mathematics section');
    await page.evaluate(key => localStorage.setItem(key, 'full'), collaborationDetailStorageKey);
    await page.reload({ timeout: 15_000 }); await page.locator('.research-conversation-status').waitFor({ timeout: 15_000 });
    assert.equal(await mathematics.count(), 0, 'detailed reading also omits a progress section without records');
    await page.evaluate(key => localStorage.setItem(key, 'simple'), collaborationDetailStorageKey);
    await page.reload({ timeout: 15_000 }); await page.locator('.research-conversation-status').waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('[data-chat-answer]').count(), 0);
    assert.equal(await page.locator('.research-conversation-status').getAttribute('data-accepted'), 'false');
    assert.deepEqual(writes, []); assert.deepEqual(forbiddenCalls, []);
    await fit(page); await screenshot(page, `${width}-simple-no-mathematical-records.png`);
    mark(`${width}: simple running proof without recorded mathematics invents no goals, blockers, checked work or conclusion`);

    for (const fixture of statementFixtures) {
      await page.goto(`${origin}/?chat=${conversations[runs.indexOf(fixture.run)]!.id}`, { timeout: 15_000 });
      const record = page.locator('[data-chat-math-finding]'); await record.waitFor({ state: 'attached', timeout: 15_000 });
      const repeated = fixture.run === repeatedStatement;
      if (repeated) assert.equal(await summary.count(), 0, 'a saved statement identical to the original user task adds no second progress block');
      else {
        await summary.waitFor({ timeout: 15_000 });
        assert.equal(await summary.locator('[data-chat-math-summary-latest="statement"] .chat-message-content').innerText(), fixture.text,
          'a different mathematical statement remains readable even when a later discussion mentions it');
      }
      assert.equal(await record.isVisible(), false, 'the complete statement record starts behind the existing disclosure');
      await openChatResultDetails(page); assert.ok((await record.innerText()).includes(fixture.text.trim()), 'details retain the recorded statement text');
      await fit(page); await screenshot(page, `${width}-${repeated ? 'repeated-task-in-details' : 'distinct-recorded-statement'}.png`);
      await page.locator('[data-chat-result-more] > summary').click();
      assert.equal(await summary.count(), repeated ? 0 : 1, 'closing the records restores the appropriate compact reading');
      assert.deepEqual(writes, []); assert.deepEqual(forbiddenCalls, []);
      mark(`${width}: ${repeated ? 'the repeated original task stays in details without a second summary' : 'a genuinely different recorded statement remains in the summary and details'}`);
    }
    await page.goto(`${origin}/?chat=${conversations[runs.indexOf(findingOnly)]!.id}`, { timeout: 15_000 });
    const finding = summary.locator('[data-chat-math-summary-latest="finding"]'); await finding.waitFor({ timeout: 15_000 });
    assert.ok((await finding.innerText()).includes(originalTask), 'an actual research finding is retained even when its text matches the user task');
    await fit(page); await screenshot(page, `${width}-recorded-finding-summary.png`);
    mark(`${width}: a recorded research finding remains visible when its text matches the original task`);
    if (width === 390) {
      explanationLanguage = 'en';
      await page.evaluate(key => localStorage.setItem(key, 'en'), localeStorageKey);
      await page.goto(`${origin}/?chat=${conversations[2].id}`, { timeout: 15_000 });
      await summary.waitFor({ timeout: 15_000 });
      await runningMetadata(page, true, false, 'en');
      assert.equal(await summary.locator('h3').innerText(), 'Mathematical progress');
      assert.equal(await page.locator('[data-chat-math-more]').count(), 0);
      assert.equal(await progressToggle.count(), 1);
      assert.equal(await progressToggle.innerText(), 'View solving progress');
      await summary.scrollIntoViewIfNeeded();
      await fit(page); await screenshot(page, '390-en-simple-mathematical-summary.png');
      await progressToggle.focus(); await page.keyboard.press('Enter');
      await mathematics.waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => document.activeElement === document.querySelector('[data-chat-mathematics]'), undefined, { timeout: 15_000 });
      assert.equal(await summary.isVisible(), false);
      await runningMetadata(page, true, true, 'en');
      await fit(page); await mathematicsHeadingInView(page);
      await screenshot(page, '390-en-simple-mathematical-details.png');
      await progressToggle.focus(); await page.keyboard.press('Enter');
      assert.equal(await summary.isVisible(), true);
      assert.equal(await mathematics.isVisible(), false);
      await runningMetadata(page, true, false, 'en');
      assert.equal(await progressToggle.evaluate(async element => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        return document.activeElement === element;
      }), true, 'closing with Enter keeps focus on the native summary');
      await page.goto(`${origin}/?chat=${conversations[0].id}`, { timeout: 15_000 });
      await answer.locator('[data-chat-answer-document="swap_sum"]').waitFor({ timeout: 15_000 });
      await answerOrder(page, 'swap_sum', 'en');
      assert.equal(await acceptedStatus.locator('.research-conversation-state strong').innerText(), 'Original problem accepted');
      assert.equal(await acceptedStatus.locator('.research-conversation-description, [data-chat-run-meta], time').count(), 0);
      assert.equal(await acceptedDescription.count(), 1);
      assert.equal(await acceptedDescription.isVisible(), false);
      assert.equal(await acceptedMetadata.isVisible(), false);
      await answer.locator('h3').scrollIntoViewIfNeeded();
      await fit(page); await screenshot(page, '390-en-saved-explanation.png');
      const englishFollowup = await input.inputValue(), englishDescription = await acceptedDescription.textContent();
      await more.locator(':scope > summary').click();
      assert.equal(await acceptedDescription.isVisible(), true);
      assert.equal(await acceptedDescription.innerText(), englishDescription);
      assert.equal(await acceptedMetadata.isVisible(), true);
      await more.locator(':scope > summary').click();
      assert.equal(await acceptedDescription.isVisible(), false);
      assert.equal(await acceptedMetadata.isVisible(), false);
      assert.equal(await input.inputValue(), englishFollowup);
      await nextAnswerWithKeyboard(page, 'en');
      await answerOrder(page, 'identity_sum', 'en');
      assert.equal(await input.inputValue(), englishFollowup);
      assert.deepEqual(writes, []); assert.deepEqual(forbiddenCalls, []);
      mark('390px English: mathematical progress title and disclosure action, then saved conclusions, proof outline and derivation appear in order without overflow');
    }
    if (width === 320) {
      await page.goto(origin + '/', { timeout: 15_000 }); await input.waitFor({ timeout: 15_000 });
      await page.setViewportSize({ width: 640, height: 360 });
      await visibleNavigation(page, ['工作台', '我的研究', '定理', '数学家', '数学库']); await fit(page);
      await screenshot(page, '640-360-visible-navigation.png');
      await page.setViewportSize({ width: 320, height: 568 });
      await Promise.all([page.waitForEvent('domcontentloaded', { timeout: 15_000 }), clickWorkbenchAction(page, '#locale-switch')]);
      await input.waitFor({ timeout: 15_000 }); await visibleNavigation(page, ['Workbench', 'My research', 'Theorem', 'Mathematicians', 'Library']); await fit(page);
      await screenshot(page, '320-en-visible-navigation.png');
      mark('text navigation in the menu fits Chinese 640×360 landscape and English 320px');
    }
    await context.close(); active = undefined;
  }
  assert.deepEqual(forbiddenCalls, []); assert.deepEqual(external, []); assert.deepEqual(errors, []); assert.deepEqual(writes, []);
} catch (error) {
  failure = error;
  if (active) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 15_000 }).catch(() => undefined);
  throw error;
} finally {
  await browser.close(); await service.close(); await fs.rm(temporary, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    mode: 'real Chromium and web client with read-only recorded API fixtures; no model, Lean or generation', checks, screenshots,
    browserTimeouts: 15_000, tokenLimit: null, roundLimit: null, realModelCalls: 0, realLeanProcesses: 0,
    paidModelCalls: false, fixturesRemoved: true, forbiddenCalls, errors, external, writes, reads,
    ...(failure ? { error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2) + '\n');
}
