#!/usr/bin/env bun
// Read-only local API records in the real workbench; never runs a model, Lean, or explanation generation.
// Zero browser/server timeouts and zero fixture budgets mean these checks have no time, token or round limit.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import type { WebInspectedTask, WebObservation } from '../apps/web/collaboration';
import { readWebConfig } from '../apps/web/config';
import type { WebConversation } from '../apps/web/conversationTypes';
import { localeStorageKey } from '../apps/web/i18n';
import type { WebRunner } from '../apps/web/runner';
import { createWebService } from '../apps/web/server';
import type { WebExplanation, WebExplanationDocument, WebExplanationOverview, WebRun } from '../apps/web/shared';
import { audit } from './web-a11y';
import { freePort, preferFullCollaboration } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/web-chat-mathematics');
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
const browser = await chromium.launch({ headless: true, timeout: 0 });
const checks: string[] = [], screenshots: string[] = [];
const mark = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
const at = '2026-11-10T07:00:00.000Z';
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
      turns: 0, planVersion: 'recorded-plan', scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0,
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
    messages: [{ id: crypto.randomUUID(), role: 'user', kind: 'task', text: '请说明自然数加法的两个性质。', createdAt: at, status: 'complete' }] };
}
function explanationDocument(target: string): WebExplanationDocument {
  const first = target === 'swap_sum';
  const statement = first ? '对任意自然数 a、b，a + b = b + a。' : '对任意自然数 a，a + 0 = a。';
  return { schema: 'theorem-os.web-explanation.v1', target, language: 'zh', toolchain: 'recorded-fixture', mathlibRevision: null,
    overview: first ? '已有讲解概览：使用自然数加法交换律得到第一个结论。' : '已有讲解概览：零是自然数加法的右单位元。', axioms: [],
    sections: [{ name: target, kind: 'theorem', target: true, title: first ? '加法交换律' : '加法右单位元', statement,
      lines: { start: 1, end: 2 }, signature: { start: 1, end: 1 }, unexplained: [], statementReviews: [],
      steps: [{ text: first ? '将自然数 a 和 b 代入加法交换律，得到所需等式。' : '应用自然数加零定理，直接得到目标。',
        uses: [{ name: first ? 'Nat.add_comm' : 'Nat.add_zero', place: 'step', spans: [] },
          ...(first ? [{ name: 'supporting_identity', place: 'declaration' as const, spans: [] }] : [])], lines: [{ start: 2, end: 2 }], reviews: [] }] },
    { name: 'supporting_identity', kind: 'definition', target: false, title: '辅助定义', statement: '辅助定义保留在展开项中。',
      lines: { start: 4, end: 5 }, signature: { start: 4, end: 4 }, unexplained: [], statementReviews: [], steps: [] }],
    metrics: { declarations: 2, steps: 1, citations: 1, excerptCoverage: 1, proofLines: 1, explainedLines: 1, ambiguousExcerpts: 0 },
    model: 'recorded-fixture', effort: 'high', auditors: 2, rounds: 1, tokens: null };
}
function explanation(value: WebRun, target: string): WebExplanation {
  return { id: `${value.id}-${target}`, runId: value.id, target, language: 'zh', status: 'approved', createdAt: at, updatedAt: at,
    model: 'recorded-fixture', effort: 'high', maxRunSeconds: 0, maxTotalTokens: 0, document: explanationDocument(target) };
}
function overview(value: WebRun, available: boolean, entries?: WebExplanation[], canGenerate = false): WebExplanationOverview {
  return { run: { id: value.id, title: value.title, environment: value.environment, providerId: value.providerId, model: value.model,
    effort: value.effort, proof: value.result!.proof }, targets: [{ name: 'swap_sum', declarations: 2 }, { name: 'identity_sum', declarations: 2 }],
    explanations: entries ?? (available ? ['swap_sum', 'identity_sum'].map(target => { const { document: _, ...item } = explanation(value, target); return item; }) : []),
    generation: canGenerate ? { available: true, model: 'recorded-fixture', effort: 'high', key: 'required', maxRunSeconds: 0,
      maxTotalTokens: 0, reference: { declarations: 2, seconds: 0, tokens: 0 } } : { available: false, reason: 'runtime' } };
}
async function fit(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'the mathematics display fits the viewport');
  assert.deepEqual(await audit(page), []);
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: path.join(output, name), fullPage: true, timeout: 0 }); screenshots.push(name);
}
async function visibleNavigation(page: Page, labels: string[]) {
  const links = page.locator('#topbar .research-space-links a');
  assert.deepEqual(await links.allTextContents(), labels);
  const boxes = await links.evaluateAll(items => items.map(item => {
    const box = item.getBoundingClientRect();
    return { width: box.width, height: box.height, left: box.left, right: box.right, top: box.top, bottom: box.bottom, cut: item.scrollWidth > item.clientWidth + 1 };
  }));
  for (const box of boxes) assert(box.width > 0 && box.height >= 24 && !box.cut && box.left >= 0 && box.right <= page.viewportSize()!.width
    && box.top >= 0 && box.bottom <= page.viewportSize()!.height, `navigation label is fully visible: ${JSON.stringify(box)}`);
}
async function beforeProcess(page: Page, selector: string) {
  assert.equal(await page.locator(selector).evaluate(element => {
    const process = document.querySelector('[data-solve-process]');
    return !!process && !!(element.compareDocumentPosition(process) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true, `${selector} precedes the process details`);
}
let active: Page | undefined, failure: unknown;
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
    // The mathematical progress block and the output buttons of a running proof are the 详细 reading; 简洁 shows them in the workspace.
    await preferFullCollaboration(context);
    await context.addInitScript(key => { if (!localStorage.getItem(key)) localStorage.setItem(key, 'zh'); }, localeStorageKey);
    const accepted = run('completed'), missing = run('completed'), working = run('running'), unavailable = run('completed'),
      queued = run('completed'), generating = run('completed'), failed = run('completed'), cancelled = run('completed'), exhausted = run('completed');
    const runs = [accepted, missing, working, unavailable, queued, generating, failed, cancelled, exhausted], conversations = runs.map(conversation);
    let generated = false, failAcceptedOverview = false;
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
      const selectedRun = runs.find(item => url.pathname.startsWith(`/api/runs/${item.id}`));
      if (selectedRun) {
        const endpoint = url.pathname.slice(`/api/runs/${selectedRun.id}`.length);
        if (!endpoint) { await route.fulfill({ json: { run: selectedRun } }); return; }
        if (endpoint === '/explanations') {
          reads.push(url.pathname);
          if (selectedRun === accepted && failAcceptedOverview) {
            await route.fulfill({ status: 503, json: { error: '临时读取失败（本地模拟）' } }); return;
          }
          const fixtureStatus = selectedRun === queued ? 'queued' : selectedRun === generating && !generated ? 'running'
            : selectedRun === failed ? 'error' : selectedRun === cancelled ? 'cancelled' : selectedRun === exhausted ? 'exhausted' : undefined;
          const entries = fixtureStatus ? [{ ...explanation(selectedRun, 'swap_sum'), document: undefined, status: fixtureStatus,
            ...(fixtureStatus === 'queued' ? { queue: { position: 3, ahead: 2 } } : fixtureStatus === 'running'
              ? { progress: { phase: 'auditing', batches: 3, approvedBatches: 1, updatedAt: at } }
              : { reason: 'explanation_gateway_unavailable' }) } as WebExplanation] : undefined;
          await route.fulfill({ json: overview(selectedRun, selectedRun === accepted || selectedRun === generating && generated, entries,
            selectedRun !== unavailable && selectedRun !== accepted && selectedRun !== working) }); return;
        }
        if (endpoint === '/explanations/item') {
          reads.push(url.pathname + url.search); assert.ok(selectedRun === accepted || selectedRun === generating && generated);
          assert.equal(url.searchParams.get('language'), 'zh');
          const target = url.searchParams.get('target'); assert.ok(['swap_sum', 'identity_sum'].includes(target!));
          await route.fulfill({ json: { explanation: explanation(selectedRun, target!) } }); return;
        }
        if (endpoint === '/actions') { await route.fulfill({ json: { actions: [], dropped: 0 } }); return; }
        if (endpoint === '/events') { await route.fulfill({ json: { events: [] } }); return; }
        if (endpoint === '/outline') { await route.fulfill({ status: 404, json: { error: 'No outline in read-only fixture' } }); return; }
      }
      await route.continue();
    });
    const page = active = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/', { timeout: 0 });
    await page.locator('#topbar .research-space-links').waitFor({ timeout: 0 });
    await visibleNavigation(page, ['工作台', '我的研究', '定理', '数学家', '数学库']);
    const participation = page.locator('[data-chat-participation-control]'), input = page.locator('#formalize-original');
    await participation.waitFor({ timeout: 0 });
    assert.equal(await participation.evaluate((element: HTMLDetailsElement) => element.open), false);
    assert.equal(await participation.locator('input[value="guided"]').isChecked(), true);
    assert.equal((await participation.locator('summary').innerText()).trim(), '共同推进');
    assert.equal(await input.evaluate(element => !!(element.compareDocumentPosition(document.querySelector('[data-chat-participation-control]')!) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    const inputBox = await input.boundingBox(); assert.ok(inputBox && inputBox.y >= 0 && inputBox.y < 1000, 'the task input is immediately visible');
    await fit(page); await screenshot(page, `${width}-input-first.png`);
    await page.locator('#formalize-settings > summary').click();
    const advanced = page.locator('[data-chat-advanced-settings]');
    assert.equal(await advanced.evaluate((node: HTMLDetailsElement) => node.open), false, 'optional settings start collapsed');
    for (const selector of ['#formalize-provider', '#formalize-model', '#formalize-key', '#check-model-connection'])
      assert.equal(await page.locator(selector).isVisible(), true, `${selector} is available in primary setup`);
    for (const selector of ['#formalize-environment', '#formalize-effort', ...budgetInputs])
      assert.equal(await page.locator(selector).isVisible(), false, `${selector} belongs to optional advanced setup`);
    await screenshot(page, `${width}-simple-settings.png`);
    await advanced.locator(':scope > summary').click({ timeout: 0 });
    for (const selector of budgetInputs) { assert.equal(await page.locator(selector).inputValue(), ''); assert.equal(await page.locator(selector).getAttribute('placeholder'), '不限'); }
    await fit(page); await screenshot(page, `${width}-unlimited-settings.png`);
    await advanced.locator(':scope > summary').click({ timeout: 0 });
    mark(`${width}: visible task input, collapsed guided participation and empty unlimited budgets`);
    await page.locator('#formalize-settings > summary').click();
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
    await page.goto(`${origin}/?chat=${conversations[0].id}`, { timeout: 0 });
    const answer = page.locator('[data-chat-answer]');
    await answer.locator('[data-chat-answer-document="swap_sum"]').waitFor({ timeout: 0 });
    assert.match(await answer.innerText(), /已有讲解概览：使用自然数加法交换律/u);
    assert.match(await answer.locator('.chat-answer-steps').innerText(), /将自然数 a 和 b 代入加法交换律/u);
    assert.equal(await answer.locator('.chat-answer-uses code').innerText(), 'Nat.add_comm');
    assert.equal(await answer.locator('.chat-answer-support').evaluate((element: HTMLDetailsElement) => element.open), false);
    assert.equal(await answer.locator('[data-chat-answer-select] option').count(), 2);
    assert.equal(await answer.locator('[data-chat-answer-select] option:checked').innerText(), '加法交换律');
    await beforeProcess(page, '[data-chat-answer]');
    await answer.locator('h3').scrollIntoViewIfNeeded();
    await fit(page); await screenshot(page, `${width}-saved-explanation.png`);
    await input.fill('保留已写的独立追问。');
    await answer.locator('[data-chat-answer-question="swap_sum:0"]').click();
    const followup = await input.inputValue();
    assert.ok(followup.startsWith('保留已写的独立追问。\n\n'));
    for (const text of ['加法交换律', '第 1 步', '对任意自然数', '将自然数 a 和 b', 'Nat.add_comm', accepted.id]) assert.ok(followup.includes(text));
    assert.deepEqual(writes, [], 'step questioning prepares a draft without sending it');
    await answer.locator('[data-chat-answer-use="supporting_identity"]').click();
    assert.equal(await answer.locator('.chat-answer-support').evaluate((element: HTMLDetailsElement) => element.open), true);
    assert.match(await answer.locator('.chat-answer-support').innerText(), /辅助定义保留/u);
    await fit(page); await screenshot(page, `${width}-step-question-and-definition.png`);
    mark(`${width}: human target title, selected-step question with precise context, existing follow-up preservation and local definition expansion`);

    failAcceptedOverview = true;
    await answer.locator('[data-chat-answer-refresh]').click();
    await answer.locator('[data-chat-answer-retry]').waitFor({ timeout: 0 });
    assert.equal(await answer.locator('[data-chat-answer-document="swap_sum"]').count(), 1);
    assert.match(await answer.innerText(), /刷新失败，下面保留上次读取的解答/u);
    await answer.locator('h3').scrollIntoViewIfNeeded();
    await fit(page); await screenshot(page, `${width}-refresh-preserves-explanation.png`);
    failAcceptedOverview = false; await answer.locator('[data-chat-answer-retry]').click();
    await page.waitForFunction(() => !document.querySelector('[data-chat-answer-retry]'), undefined, { timeout: 0 });
    assert.equal(await answer.locator('[data-chat-answer-document="swap_sum"]').count(), 1);
    mark(`${width}: transient read failure preserves the readable solution and retry recovers in place`);
    await answer.locator('[data-chat-answer-select]').selectOption('identity_sum');
    await answer.locator('[data-chat-answer-document="identity_sum"]').waitFor({ timeout: 0 });
    assert.match(await answer.innerText(), /零是自然数加法的右单位元/u);
    assert.equal(await answer.locator('.chat-answer-uses code').innerText(), 'Nat.add_zero');
    assert.equal(await answer.locator('[data-chat-answer-document="swap_sum"]').count(), 0);
    await answer.locator('h3').scrollIntoViewIfNeeded();
    await fit(page); await screenshot(page, `${width}-second-target.png`);
    mark(`${width}: saved explanation overview, statement, steps and citation are readable directly; target switching reads the selected document`);
    const more = page.locator('[data-chat-result-more]');
    assert.equal(await more.evaluate((node: HTMLDetailsElement) => node.open), false);
    assert.equal(await page.locator('[data-research-artifact="source"]').isVisible(), true);
    assert.equal(await page.locator('[data-chat-download-kit]').isVisible(), false);
    await more.locator('summary').click();
    for (const selector of ['[data-research-artifact="roadmap"]', '[data-research-artifact="result"]', '[data-chat-download-kit]', '[data-chat-share]'])
      assert.equal(await more.locator(selector).isVisible(), true);
    await fit(page); await screenshot(page, `${width}-more-result-actions.png`);
    mark(`${width}: accepted proof stays directly accessible and secondary result actions remain in the collapsed menu`);

    await more.getByRole('button', { name: '修改题目', exact: true }).click();
    await page.locator('[data-chat-editing-problem]').waitFor({ timeout: 0 });
    assert.equal(new URL(page.url()).searchParams.get('editProblem'), conversations[0].id);
    assert.equal(await input.inputValue(), conversations[0].messages[0].text);
    const edited = '任务 A 的独立修改：请进一步证明交换律的变体。';
    await input.fill(edited); await page.reload({ timeout: 0 });
    await page.waitForFunction(value => document.querySelector<HTMLTextAreaElement>('#formalize-original')?.value === value, edited, { timeout: 0 });
    assert.equal(await page.locator('[data-chat-editing-problem]').count(), 1);
    await page.locator('[data-chat-return-home]').click();
    await page.waitForFunction(value => document.querySelector<HTMLTextAreaElement>('#formalize-original')?.value === value, draft, { timeout: 0 });
    assert.equal(new URL(page.url()).search, '');
    await page.goBack({ timeout: 0 });
    await page.waitForFunction(value => document.querySelector<HTMLTextAreaElement>('#formalize-original')?.value === value, edited, { timeout: 0 });
    await fit(page); await screenshot(page, `${width}-separate-problem-edit.png`);
    assert.deepEqual(writes, []);
    mark(`${width}: editing a historical problem preserves the home draft and the separate edit through reload and browser Back`);
    let libraryLink = page.locator('#topbar a[data-workbench-library]');
    if (!await libraryLink.isVisible()) {
      await page.locator('[data-research-mobile-navigation] > summary').click();
      libraryLink = page.locator('[data-research-mobile-link="library"]');
    }
    await libraryLink.click();
    await page.locator('.research-page .topbar').waitFor({ timeout: 0 });
    assert.equal(new URL(page.url()).searchParams.get('workbenchEdit'), conversations[0].id);
    const editReturn = page.locator('.topbar a').filter({ hasText: '工作台' });
    assert.equal(new URL(await editReturn.getAttribute('href') ?? '', page.url()).searchParams.get('editProblem'), conversations[0].id);
    await editReturn.click();
    await page.waitForFunction(value => document.querySelector<HTMLTextAreaElement>('#formalize-original')?.value === value, edited, { timeout: 0 });
    assert.equal(await page.locator('[data-chat-editing-problem]').count(), 1);
    await page.locator('[data-chat-return-home]').click();
    await page.waitForFunction(value => document.querySelector<HTMLTextAreaElement>('#formalize-original')?.value === value, draft, { timeout: 0 });
    mark(`${width}: Library browsing returns to the separate edited problem and keeps the original home draft intact`);

    await page.goto(`${origin}/?chat=${conversations[1].id}`, { timeout: 0 });
    await page.waitForFunction(() => document.querySelector('[data-chat-answer]')?.textContent?.includes('这份验收证明还没有可阅读的讲解。'), undefined, { timeout: 0 });
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
      [generating, 'running', '正在核对讲解与证明'], [failed, 'error', '无法连接模型服务，请稍后重试。'],
      [cancelled, 'cancelled', '已停止生成'], [exhausted, 'exhausted', '讲解没有完成'],
    ] as const) {
      await page.goto(`${origin}/?chat=${conversations[runs.indexOf(value)]!.id}`, { timeout: 0 });
      const state = page.locator(`[data-chat-answer-status="${status}"]`); await state.waitFor({ timeout: 0 });
      assert.ok((await state.innerText()).includes(text));
      if (status === 'unavailable') assert.equal(await state.locator('[data-chat-explain]').count(), 0);
      else assert.equal(await state.locator('[data-chat-explain]').innerText(), ['queued', 'running'].includes(status) ? '查看讲解进度' : '重新生成详细解答');
      if (status === 'running') {
        assert.match(await state.innerText(), /已通过批次\s+1\s*\/\s*3/u);
        generated = true;
        await page.locator('[data-chat-answer-document="swap_sum"]').waitFor({ timeout: 0 });
      }
      await fit(page); await screenshot(page, `${width}-explanation-${status}.png`);
    }
    mark(`${width}: unavailable, queued, running, failed, cancelled and incomplete explanations show accurate states; the finished document appears automatically without generation`);

    await page.goto(`${origin}/?chat=${conversations[2].id}`, { timeout: 0 });
    const mathematics = page.locator('[data-chat-mathematics]');
    await mathematics.locator('[data-chat-math-checked]').waitFor({ timeout: 0 });
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
    if (width === 320) {
      await page.goto(origin + '/', { timeout: 0 }); await input.waitFor({ timeout: 0 });
      await page.setViewportSize({ width: 640, height: 360 });
      await visibleNavigation(page, ['工作台', '我的研究', '定理', '数学家', '数学库']); await fit(page);
      await screenshot(page, '640-360-visible-navigation.png');
      await page.setViewportSize({ width: 320, height: 568 });
      await Promise.all([page.waitForEvent('domcontentloaded', { timeout: 0 }), page.locator('#locale-switch').click({ timeout: 0 })]);
      await input.waitFor({ timeout: 0 }); await visibleNavigation(page, ['Workbench', 'My research', 'Theorem', 'Mathematicians', 'Library']); await fit(page);
      await screenshot(page, '320-en-visible-navigation.png');
      mark('visible text navigation fits Chinese 640×360 landscape and English 320px without opening a menu');
    }
    await context.close(); active = undefined;
  }
  assert.deepEqual(forbiddenCalls, []); assert.deepEqual(external, []); assert.deepEqual(errors, []); assert.deepEqual(writes, []);
} catch (error) {
  failure = error;
  if (active) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 0 }).catch(() => undefined);
  throw error;
} finally {
  await browser.close(); await service.close(); await fs.rm(temporary, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    mode: 'real Chromium and web client with read-only recorded API fixtures; no model, Lean or generation', checks, screenshots,
    browserTimeouts: 0, deadline: null, tokenLimit: null, roundLimit: null, realModelCalls: 0, realLeanProcesses: 0,
    paidModelCalls: false, fixturesRemoved: true, forbiddenCalls, errors, external, writes, reads,
    ...(failure ? { error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2) + '\n');
}
