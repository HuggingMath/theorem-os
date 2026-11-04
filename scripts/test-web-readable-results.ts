#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput } from '../apps/web/shared';
import type { WebInspectedTask, WebObservation } from '../apps/web/collaboration';
import { localeStorageKey } from '../apps/web/i18n';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { refreshHistory, selectHistoryRun } from './web-ui-controls';
import { freePort, postRun, settled, startBrowser, webScenario, writeScenarioReport, type ScenarioHarness, type ScenarioSuite } from './web-scenario';
import { loadWebSample, type WebSampleFile } from '../apps/web/sample';
import { replaySample, withFailedAttempt } from './web-trajectory-fixture';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-readable-results');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the readable results check.'); });
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
const raw = '<img src=x onerror="globalThis.__resultsXss=1">';
const source = 'namespace Fixture\n\ntheorem main (n : Nat) : n + 0 = n := by sorry\n\ntheorem side : True := by sorry\n\nend Fixture\n';
const proof = 'namespace Fixture\n\nlemma helper (n : Nat) : n + 0 = n := rfl\n\ndef unused (n : Nat) := n + n\n\n' +
  'theorem main (n : Nat) : n + 0 = n := helper n\n\ntheorem side : True := trivial\n\nend Fixture\n';
const references = (...names: string[]) => ({ statement: [], proof: names.map(name => ({ name, file: 'Submission.lean' })) });
const evaluated = (recorded: boolean) => ({ status: 'passed', method: 'host-lean-kernel-all-targets', verification: { passed: true,
  commit: 'c'.repeat(40), sourceDigest: 'd'.repeat(64), verification: { status: 'passed', results: [
    { theoremName: 'Fixture.main', status: 'kernel_verified', axioms: ['propext', 'Fixture.trustMe'], elaboratedDeclarationType: '∀ (n : ℕ), n + 0 = n',
      ...(recorded ? { declarationReferences: references('Fixture.helper') } : {}) },
    { theoremName: 'Fixture.side', status: 'kernel_verified', axioms: [], ...(recorded ? { declarationReferences: references() } : {}) }] } } });
const environmentDigest = mathDigest('readable results fixture');
const task = (id: string, extra: Partial<WebInspectedTask>): WebInspectedTask => ({ id, kind: 'lemma', objective: `Objective ${id}`, group: 'main',
  status: 'pending', control: 'active', version: `${id}-v1`, premises: [], plannedDependencies: [], attempts: 0, proof: { status: 'none' },
  parkedBy: [], parkedRoutes: {}, ...extra });
function observation(id: string): WebObservation {
  const tasks = [task('main_goal', { kind: 'goal', theorem: 'Fixture.main', type: '∀ (n : ℕ), n + 0 = n', plannedDependencies: ['bridge'] }),
    task('bridge', { theorem: 'Fixture.bridge', type: `∀ (n : ℕ), n + 0 = n ${raw}`, status: 'blocked', attempts: 4,
      proof: { status: 'failed', failureCategory: 'proof' }, feedback: `unsolved goals\nn : ℕ\n⊢ n + 0 = n ${raw}` }),
    task('base', { theorem: 'Fixture.base', type: 'True', status: 'integrated', attempts: 1, proof: { status: 'checked' } })];
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `solver-${id}`, stateDigest: mathDigest(id), resultDigest: null };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: new Date().toISOString(), sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, plan: null, sources: [], checks: [], guidance: [],
    coverage: { sources: 'recorded', checks: 'recorded' },
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'finished',
      problem: { id: 'readable-results', statement: 'Prove main', formalStatement: source, assumptions: [], targets: [{ proofPath: 'Submission.lean', theoremName: 'Fixture.main' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 1, coordination: 'cooperative', buildDigest: mathDigest('build'), environmentDigest },
      turns: 3, scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 1, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 1 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded',
        droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'theoremos.obligation-snapshot.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: mathDigest('obligations'),
        environmentDigest, obligations: [], routes: [], advisory: [],
        goals: [{ taskId: 'main_goal', taskDigest: 'main_goal-v1', closed: false, frontier: [{ taskId: 'bridge', taskDigest: 'bridge-v1' }], missingDependencies: [] }],
        blockers: [{ id: 'b1', taskId: 'bridge', taskDigest: 'bridge-v1', groupId: 'main', mechanism: `missing lemma in the pinned corpus ${raw}`, scope: 'task',
          evidenceStatus: 'model-reported', status: 'open', reopenOn: [] }] }, recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 1, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['main_goal', 'bridge'] },
      groups: [], tasks, workers: [], statementReviews: [], edits: [] } };
}
/** Six parts of one problem stopped by the budget: two closed by the solver's own Lean check, one conditional, three open. */
function manyGoals(id: string): WebObservation {
  const base = observation(id), parts = ['a', 'b', 'c', 'd', 'e', 'f'], closed = new Set(['a', 'd']);
  const tasks = parts.map(part => task(`goal_${part}`, { kind: 'goal', theorem: `Fixture.part_${part}`, type: 'True',
    ...(closed.has(part) ? { status: 'integrated', proof: { status: 'checked' } } : part === 'e'
      ? { status: 'conditional', proof: { status: 'conditional', conditions: [{ taskId: 'goal_b', taskDigest: 'goal_b-v1' }] } } : {}) }));
  const goals = parts.map(part => ({ taskId: `goal_${part}`, taskDigest: `goal_${part}-v1`, closed: closed.has(part), frontier: [], missingDependencies: [] }));
  const inspection = base.inspection;
  return { ...base, inspection: { ...inspection, tasks, usage: { inputTokens: 98_000, outputTokens: 30_000, totalTokens: 128_000 },
    problem: { ...inspection.problem, targets: parts.map(part => ({ proofPath: 'Submission.lean', theoremName: `Fixture.part_${part}` })) },
    mathematics: { ...inspection.mathematics!, snapshot: { ...inspection.mathematics!.snapshot, goals, blockers: [] } } } };
}
const sample = loadWebSample()!;
/** The recording up to zero_add's rejected first try, where the budget runs out: add_zero is checked, zero_add's latest check failed. */
function stoppedAfterFailure(): WebSampleFile {
  const recording = withFailedAttempt(sample);
  const failed = recording.events.find(event => event.type === 'task_checked' && event.details?.passed === false)!;
  recording.events = recording.events.filter(event => event.sequence <= failed.sequence);
  recording.observations = recording.observations.slice(0, 4);
  const last = recording.observations.at(-1)!;
  last.inspection.tasks = last.inspection.tasks.map(task => task.id === 'goal_2' ? { ...task, attempts: 1, proof: { ...task.proof, status: 'failed', failureCategory: 'proof' } } : task);
  return recording;
}
const limitReached = { status: 'limit_reached', proof: '', report: { status: 'limit_reached', reason: 'math_run_stopped', failure: { kind: 'time_limit', reason: 'math_run_stopped' } } } as const;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local readable results fixture; no model or Lean' }; },
  async run(input, send, signal) {
    // The recorded sample up to add_zero's own Lean check, then the time budget runs out before acceptance.
    if (input.input.task.includes('checked')) {
      await replaySample(sample, input.id, send, signal, { until: 'task_recheck_finished' });
      send({ type: 'result', result: { status: 'limit_reached', proof: '', report: { status: 'limit_reached', reason: 'math_run_stopped', failure: { kind: 'time_limit', reason: 'math_run_stopped' } } } });
      return;
    }
    if (input.input.task.includes('failed check')) {
      await replaySample(stoppedAfterFailure(), input.id, message => { if (message.type !== 'artifact' && message.type !== 'result') send(message); }, signal);
      send({ type: 'result', result: limitReached }); return;
    }
    if (input.input.task.includes('many goals')) {
      // The report's total is the run's own count; it wins over the last observation's.
      send({ type: 'observation', observation: manyGoals(input.id) });
      send({ type: 'result', result: { status: 'limit_reached', proof: '', report: { status: 'limit_reached', reason: 'math_run_stopped', usage: { totalTokens: 131_400 } } } });
      return;
    }
    if (input.input.task.includes('stuck')) {
      send({ type: 'observation', observation: observation(input.id) });
      send({ type: 'result', result: { status: 'limit_reached', proof: '', report: { status: 'limit_reached', reason: 'math_run_stopped' } } });
      return;
    }
    send({ type: 'result', result: { status: 'evaluated_passed', proof, report: { status: 'evaluated_passed', evaluator: evaluated(!input.input.task.includes('unrecorded')) } } });
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const input = (task: string): WebRunInput => ({ providerId: 'openai', apiKey: 'sk-local-readable-results-fixture', model: 'fixture', effort: 'low',
  environment: 'standard', source: task.includes('checked') || task.includes('failed check') ? sample.run.source : source, task, maxTurns: 2, maxRunSeconds: 60, workers: 1, coordination: 'cooperative',
  ...(task.includes('many goals') ? { maxTotalTokens: 500_000 } : {}) });
type Harness = ScenarioHarness;
const screenshots: string[] = [];
function scenario(name: string, run: (h: Harness) => Promise<void>, options: { width?: number; locale?: 'zh' | 'en' } = {}) {
  const { width = 1440, locale = 'zh' } = options;
  return webScenario<Harness>(browser, suite, name, run, {
    context: { viewport: { width, height: width > 850 ? 1000 : 812 }, reducedMotion: 'reduce', acceptDownloads: true },
    init: context => context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, locale] as const),
    harness: (page, context) => ({ page, context, requests: [] }), routes: { local: 'Readable results must stay local' }, open: true,
    timeout: { label: 'Readable results', seconds: 50 },
  });
}
async function open(h: Harness, task: string) {
  const run = await postRun(h, input(task));
  // The replayed sample takes a few seconds at its recorded pace; the other fixtures finish at once.
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await h.page.evaluate(async id => (await (await fetch(`/api/runs/${id}`)).json()).run.status, run.id);
    if (state === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, attempt < 20 ? 30 : 100));
  }
  await refreshHistory(h.page); await selectHistoryRun(h.page, run.id);
  await h.page.locator('#detail-tab-result').click();
  await h.page.locator('#detail-panel .report-summary').waitFor();
  return run;
}
async function fits(page: Page, selectors: string[]) {
  const width = page.viewportSize()!.width;
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'results must not widen the document');
  for (const selector of selectors) {
    const box = await page.locator(selector).first().boundingBox();
    assert.ok(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1, `${selector} must fit ${width}px: ${JSON.stringify(box)}`);
  }
}
const noXss = (page: Page) => page.evaluate(() => (globalThis as { __resultsXss?: number }).__resultsXss).then(value => assert.equal(value, undefined));

try {
  await scenario('a passed run lists targets, helpers, axioms and hands out a kit that unpacks', async h => {
    const { page } = h, run = await open(h, 'Prove with a helper');
    const outline = page.locator('#detail-panel .report-outline');
    await outline.locator('.outline-item').first().waitFor();
    assert.equal(await outline.locator('h3').innerText(), '证明结构');
    const text = await outline.innerText();
    // Names the file declares read as it writes them (main, helper); trustMe is not declared there, so it stays in full.
    for (const value of ['2 个原题目标，求解过程新增了 2 个辅助声明。', '∀ (n : ℕ), n + 0 = n', '用到：helper',
      '依赖公理：propext、Fixture.trustMe', 'Fixture.trustMe 不在 Lean 的三个标准公理之内', '直接证明，没有用到新增的辅助声明', '不依赖任何公理',
      '被 main 用到', '没有被任何目标用到', '新增辅助声明', '定义'])
      assert.ok(text.includes(value), `outline shows ${value}`);
    assert.ok(!text.includes('Fixture.main') && !text.includes('Fixture.helper'), 'the namespace is not repeated on every name');
    assert.equal(await outline.locator('.outline-item code[title="Fixture.main"]').first().innerText(), 'main', 'the full name stays in the tooltip');
    assert.equal(await outline.locator('.badge.warning').count(), 1, 'only the target with a nonstandard axiom is flagged');
    await outline.locator('.local-check-guide summary').click();
    const guide = await outline.locator('.local-check-steps').innerText();
    assert.ok(guide.includes('lake build Submission') && guide.includes('lake env lean Check.lean') && !guide.includes('cache get'));
    const [download] = await Promise.all([page.waitForEvent('download'), outline.getByRole('link', { name: '下载本地复核包' }).click()]);
    assert.equal(download.suggestedFilename(), `theoremos-${run.id.slice(0, 8)}-verify.zip`);
    const file = path.join(output, 'kit.zip'); await download.saveAs(file);
    assert.match(execFileSync('unzip', ['-l', file], { encoding: 'utf8' }), /Check\.lean[\s\S]*README\.txt/u);
    assert.equal(execFileSync('unzip', ['-p', file, `theoremos-${run.id.slice(0, 8)}/Submission.lean`], { encoding: 'utf8' }), proof);
    assert.equal(await page.locator('#detail-panel .report-stuck').count(), 0, 'a passed run has nothing stuck');
    await outline.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'outline-desktop.png') }); screenshots.push('outline-desktop.png');
    const reads = h.requests.filter(item => item.pathname === `/api/runs/${run.id}/outline`).length;
    await page.locator('#detail-tab-collaboration').click(); await page.locator('#detail-tab-result').click();
    await outline.locator('.outline-item').first().waitFor(); await settled(page);
    assert.equal(h.requests.filter(item => item.pathname === `/api/runs/${run.id}/outline`).length, reads, 'the outline is read once per run');
  });

  await scenario('each declaration of the proof structure opens the source at its line, and 目录 lists them there', async h => {
    const { page } = h;
    await open(h, 'Prove with a helper');
    const outline = page.locator('#detail-panel .report-outline');
    await outline.locator('.outline-item').first().waitFor();
    const jumps = await outline.locator('[data-action="jump-declaration"]').evaluateAll(buttons => buttons.map(button => [button.querySelector('code')!.textContent, button.getAttribute('data-line')]));
    assert.deepEqual(Object.fromEntries(jumps), { main: '7', side: '9', helper: '3', unused: '5' });
    const marked = () => page.evaluate(() => [...CSS.highlights.get('source-line') ?? []].map(range => range.toString()).join(''));
    await outline.locator('[data-action="jump-declaration"]').filter({ hasText: 'helper' }).click();
    await page.locator('#detail-tab-source[aria-selected="true"]').waitFor();
    assert.equal(await marked(), 'lemma helper (n : Nat) : n + 0 = n := rfl', 'the source marks the declaration\'s line');
    assert.equal(await page.locator('#detail-panel .code-scroll').evaluate(scroll => scroll === document.activeElement), true, 'the code takes focus');
    const toggle = page.locator('#open-source-outline');
    assert.equal(await toggle.locator('.field-count').innerText(), '4');
    await toggle.click();
    const items = page.locator('#source-outline .source-outline-item');
    assert.deepEqual(await items.evaluateAll(list => list.map(item => [item.querySelector('code')!.textContent, item.querySelector('.source-outline-kind')!.textContent,
      item.querySelector('.source-outline-line')!.textContent])), [['helper', '引理', '3'], ['unused', '定义', '5'], ['main', '定理', '7'], ['side', '定理', '9']]);
    assert.equal(await items.filter({ hasText: 'helper' }).evaluate(item => item.getAttribute('aria-current') === 'location' && item === document.activeElement), true,
      '目录 opens at the declaration being read');
    await page.screenshot({ path: path.join(output, 'source-outline-desktop.png') }); screenshots.push('source-outline-desktop.png');
    await items.filter({ hasText: 'side' }).click();
    await page.locator('#source-outline').waitFor({ state: 'hidden' });
    assert.equal(await marked(), 'theorem side : True := trivial');
    await toggle.click(); await page.keyboard.press('Escape');
    await page.locator('#source-outline').waitFor({ state: 'hidden' });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  });

  await scenario('an outline read that fails offers a retry, and unrecorded references are not guessed', async h => {
    const { page } = h;
    let failures = 1;
    h.intercept = async route => {
      if (!new URL(route.request().url()).pathname.endsWith('/outline') || failures-- <= 0) return false;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '服务暂时不可用' }) }); return true;
    };
    await open(h, 'Prove unrecorded');
    const outline = page.locator('#detail-panel .report-outline');
    await outline.getByText('证明结构整理失败：服务暂时不可用').waitFor();
    await outline.getByRole('button', { name: '重新整理' }).click();
    await outline.locator('.outline-item').first().waitFor();
    const text = await outline.innerText();
    assert.ok(text.includes('这次运行没有记录引用关系'), 'says references were not recorded');
    assert.ok(!text.includes('用到：') && !text.includes('被 main 用到') && !text.includes('没有被任何目标用到'), 'no usage is inferred');
  });

  await scenario('a stuck run names the open subgoal and opens it in collaboration', async h => {
    const { page } = h; await open(h, 'Stop when stuck');
    const stuck = page.locator('#detail-panel .report-stuck');
    await stuck.waitFor();
    const text = await stuck.innerText();
    for (const value of ['卡在哪里', '已检查 1 个 · 未完成 2 个', '原题目标尚未闭合', 'Fixture.bridge', '受阻', '已尝试 4 次', '最近一次证明未通过 Lean 检查',
      `missing lemma in the pinned corpus ${raw}`, `∀ (n : ℕ), n + 0 = n ${raw}`]) assert.ok(text.includes(value), `stuck view shows ${value}`);
    assert.equal(await stuck.locator('img').count(), 0); await noXss(page);
    await stuck.locator('summary').filter({ hasText: '最近反馈' }).click();
    assert.ok((await stuck.locator('.diagnostic-output').innerText()).includes('⊢ n + 0 = n'));
    assert.equal(await page.locator('#detail-panel .report-outline').count(), 0, 'no proof, no structure');
    await stuck.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'stuck-desktop.png') }); screenshots.push('stuck-desktop.png');
    await stuck.getByRole('button', { name: '在协作中查看' }).click();
    await page.locator('[data-inspected-task-heading]').filter({ hasText: 'bridge' }).waitFor();
    assert.equal(await page.locator('#detail-tab-collaboration').getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-inspected-task-heading')), true, 'focus lands on the task');
  });

  await scenario('a long goal list reads by status, with the checked goals folded and a bar of what is finished', async h => {
    const { page } = h; await open(h, 'Stop with many goals');
    const goals = page.locator('#detail-panel .result-goals');
    assert.equal((await goals.locator('[data-goal-counts]').innerText()).replace(/\s+/gu, ' '), 'Lean 已检查 2 · 有条件 1 · 未解决 3');
    assert.deepEqual(await goals.locator('.goal-group').evaluateAll(groups => groups.map(group => [(group as HTMLElement).dataset.goalGroup,
      group.querySelector('summary')!.textContent, (group as HTMLDetailsElement).open])), [['open', '未解决4', true], ['checked', 'Lean 已检查2', false]]);
    assert.deepEqual(await goals.locator('[data-goal-group="open"] .goal-row .item-heading code').allInnerTexts(),
      ['Fixture.part_b', 'Fixture.part_c', 'Fixture.part_e', 'Fixture.part_f'], 'problem order inside the group');
    assert.deepEqual(await goals.locator('.goal-bar').evaluate(bar => [bar.classList.contains('ended'), ...Array.from(bar.children, item =>
      [(item as HTMLElement).dataset.goalSegment, Math.round(item.getBoundingClientRect().width / bar.getBoundingClientRect().width * 100)])]),
      [true, ['checked', 33], ['conditional', 17]]);
    assert.equal(await goals.locator('[data-goal-group="checked"] .goal-row').first().isVisible(), false, 'finished goals start folded');
    await goals.locator('[data-goal-group="checked"] summary').click();
    await goals.locator('[data-goal-group="checked"] .goal-row[data-goal-state="checked"]').first().waitFor();
    await settled(page); await goals.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'goals-grouped.png') }); screenshots.push('goals-grouped.png');
    const tokens = page.locator('.detail-statusline [data-header-tokens]');
    assert.equal(await tokens.innerText(), 'Token 13.1 万 / 50 万', 'the run\'s own total, from its report, beside its cap');
    assert.match(await tokens.getAttribute('title') ?? '', /所有 Agent.*上限 50 万/u);
    await page.locator('.detail-heading').screenshot({ path: path.join(output, 'header-tokens.png') }); screenshots.push('header-tokens.png');
    await open(h, 'Stop when stuck');
    assert.equal(await page.locator('#detail-panel .result-goals .goal-group').count(), 0, 'one goal stays a flat list');
    assert.equal(await page.locator('#detail-panel .result-goals .goal-bar').count(), 0, 'one goal needs no bar');
    assert.equal(await page.locator('.detail-statusline [data-header-tokens]').count(), 0, 'a run with no reported usage shows no count');
  });

  await scenario('a run that ended unaccepted offers its checked code and why its latest check failed as next steps, without a model call', async h => {
    const { page } = h; await open(h, 'Stop after a failed check');
    const actions = page.locator('#detail-panel .result-verdict-actions [data-recovery]');
    assert.deepEqual(await actions.evaluateAll(items => items.map(item => [(item as HTMLElement).dataset.recovery, item.textContent])),
      [['continue-checked', '从已检查的代码继续'], ['ask-failed', '问为什么没通过'], ['budget', '提高解题预算']]);
    await page.locator('#detail-panel .result-verdict').screenshot({ path: path.join(output, 'next-steps.png') }); screenshots.push('next-steps.png');
    await actions.filter({ hasText: '问为什么没通过' }).click();
    const viewer = page.locator('#trajectory-viewer[open]');
    await viewer.waitFor(); await viewer.locator('[data-ask-question]').waitFor();
    assert.equal(await page.locator('#detail-tab-trajectory').getAttribute('aria-selected'), 'true');
    assert.match(await viewer.locator('.side-viewer-heading').innerText(), /zero_add/u);
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-ask-question'));
    assert.equal(h.requests.filter(item => item.pathname.endsWith('/explain')).length, 0, 'opening the question asks nothing yet');
    await page.screenshot({ path: path.join(output, 'next-steps-ask.png') }); screenshots.push('next-steps-ask.png');
    // Beside the chat the run panel is narrower than a viewer column, so the question opens as a dialog over the tabs.
    await page.keyboard.press('Escape'); await viewer.waitFor({ state: 'hidden' });
    await page.locator('#detail-tab-result').click(); await actions.first().waitFor();
    await actions.filter({ hasText: '从已检查的代码继续' }).click();
    await page.locator('#run-settings[open]').waitFor();
    assert.equal(await page.locator('#draft-continuation-label').innerText(), '从「add_zero · 第 1 次」继续');
    assert.equal(await page.locator('#task').inputValue(), 'Stop after a failed check', 'the new draft is the same problem');
    assert.equal(await page.locator('#api-key').evaluate(field => field === document.activeElement), true, 'continuing asks for the key first');
  });

  await scenario('a run stopped by its budget ends its trajectory with where its targets stood', async h => {
    const { page } = h; await open(h, 'Stop when stuck');
    await page.locator('#detail-tab-trajectory').click();
    await page.locator('[data-trajectory-view="steps"]').click();
    const end = page.locator('#detail-panel .trajectory-step[data-kind="end"]');
    await end.waitFor();
    assert.match(await end.locator('h4').innerText(), /解题时间用完/u);
    assert.equal((await end.locator('[data-end-goals="open"]').innerText()).replace(/\s+/gu, ' ').trim(), '仍未解决 main');
    assert.equal(await end.locator('[data-end-goals="passed"]').count(), 0, 'nothing the run did not check is listed as checked');
  });

  await scenario('a goal the run checked but did not get accepted opens its checked code', async h => {
    const { page } = h; await open(h, 'Stop once checked');
    const checked = page.locator('#detail-panel .result-goals .goal-row[data-goal-state="checked"]');
    await checked.waitFor();
    assert.match(await checked.locator('code').first().innerText(), /add_zero/u);
    assert.equal(await checked.getByRole('button', { name: '在协作中查看' }).count(), 0, 'a checked goal points at its code, not at collaboration');
    assert.equal(await page.locator('#detail-panel .result-goals .goal-row[data-goal-state="open"]').getByRole('button', { name: '在协作中查看' }).count(), 1,
      'an open goal still opens in collaboration');
    await checked.getByRole('button', { name: '查看通过检查的代码' }).click();
    const viewer = page.locator('#trajectory-viewer[open]');
    await viewer.waitFor();
    assert.equal(await page.locator('#detail-tab-trajectory').getAttribute('aria-selected'), 'true');
    assert.match(await viewer.locator('.side-viewer-heading').innerText(), /add_zero[\s\S]*Lean 检查通过/u);
    assert.match(await viewer.locator('.trajectory-code-text').innerText(), /theorem add_zero \(n : Nat\) : n \+ 0 = n := by rfl/u);
    const opened = page.locator('#detail-panel .trajectory-step[data-kind="attempt"] [data-trajectory-mode="code"][aria-expanded="true"]');
    assert.equal(await opened.count(), 1, 'the attempt it came from is open beside the code');
    assert.match(await opened.locator('xpath=ancestor::li[contains(@class,"trajectory-step")]').locator('h4').innerText(), /add_zero/u);
    await page.screenshot({ path: path.join(output, 'checked-code-desktop.png') }); screenshots.push('checked-code-desktop.png');
  });

  await scenario('the result views read in English', async h => {
    const { page } = h; await open(h, 'Stop when stuck');
    const stuck = await page.locator('#detail-panel .report-stuck').innerText();
    for (const value of ['Where it stopped', '1 checked · 2 open', 'Attempted 4 times', 'The latest proof did not pass the Lean check', 'View in Collaboration'])
      assert.ok(stuck.includes(value), `English stuck view shows ${value}`);
    await open(h, 'Prove with a helper');
    const outline = page.locator('#detail-panel .report-outline');
    await outline.locator('.outline-item').first().waitFor();
    const text = await outline.innerText();
    for (const value of ['Proof structure', '2 original targets; the solver added 2 helper declarations.', 'Uses: helper', 'Used by main',
      'Download verification kit', 'How to re-check on your own computer']) assert.ok(text.includes(value), `English outline shows ${value}`);
  }, { locale: 'en' });

  for (const width of [375, 320]) await scenario(`stuck and outline views fit ${width}px`, async h => {
    const { page } = h; await open(h, 'Stop when stuck');
    await page.locator('#detail-panel .report-stuck').scrollIntoViewIfNeeded();
    await fits(page, ['#detail-panel .report-stuck', '#detail-panel .stuck-type', '#detail-panel .stuck-blockers']);
    await page.screenshot({ path: path.join(output, `stuck-${width}.png`) }); screenshots.push(`stuck-${width}.png`);
    await open(h, 'Prove with a helper');
    const outline = page.locator('#detail-panel .report-outline');
    await outline.locator('.outline-item').first().waitFor(); await outline.locator('.local-check-guide summary').click();
    await fits(page, ['#detail-panel .report-outline', '#detail-panel .outline-item', '#detail-panel .outline-jump', '#detail-panel .local-check .button', '#detail-panel .local-check-steps']);
    await outline.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `outline-${width}.png`) }); screenshots.push(`outline-${width}.png`);
  }, { width });

  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined, 'local-real-http-readable-results',
    { checks: suite.checks, leanProcesses: 0, screenshots }, { credential: 'sk-local-readable-results-fixture' });
  console.log('Readable results browser checks passed');
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-readable-results',
    { checks: suite.checks, leanProcesses: 0 }, { credential: 'sk-local-readable-results-fixture', failureRequests: true }); throw error;
} finally {
  await browser.close(); await service.close();
}
