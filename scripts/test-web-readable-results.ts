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
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local readable results fixture; no model or Lean' }; },
  async run(input, send) {
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
  environment: 'standard', source, task, maxTurns: 2, maxRunSeconds: 60, workers: 1, coordination: 'cooperative' });
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
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await h.page.evaluate(async id => (await (await fetch(`/api/runs/${id}`)).json()).run.status, run.id);
    if (state === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await refreshHistory(h.page); await selectHistoryRun(h.page, run.id);
  await h.page.locator('#detail-tab-report').click();
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
    for (const value of ['2 个原题目标，求解过程新增了 2 个辅助声明。', 'Fixture.main', '∀ (n : ℕ), n + 0 = n', '用到：Fixture.helper',
      '依赖公理：propext、Fixture.trustMe', 'Fixture.trustMe 不在 Lean 的三个标准公理之内', '直接证明，没有用到新增的辅助声明', '不依赖任何公理',
      '被 Fixture.main 用到', '没有被任何目标用到', '新增辅助声明', '定义'])
      assert.ok(text.includes(value), `outline shows ${value}`);
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
    await page.locator('#detail-tab-overview').click(); await page.locator('#detail-tab-report').click();
    await outline.locator('.outline-item').first().waitFor(); await settled(page);
    assert.equal(h.requests.filter(item => item.pathname === `/api/runs/${run.id}/outline`).length, reads, 'the outline is read once per run');
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
    assert.ok(!text.includes('用到：') && !text.includes('被 Fixture.main 用到') && !text.includes('没有被任何目标用到'), 'no usage is inferred');
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

  await scenario('the result views read in English', async h => {
    const { page } = h; await open(h, 'Stop when stuck');
    const stuck = await page.locator('#detail-panel .report-stuck').innerText();
    for (const value of ['Where it stopped', '1 checked · 2 open', 'Attempted 4 times', 'The latest proof did not pass the Lean check', 'View in Collaboration'])
      assert.ok(stuck.includes(value), `English stuck view shows ${value}`);
    await open(h, 'Prove with a helper');
    const outline = page.locator('#detail-panel .report-outline');
    await outline.locator('.outline-item').first().waitFor();
    const text = await outline.innerText();
    for (const value of ['Proof structure', '2 original targets; the solver added 2 helper declarations.', 'Uses: Fixture.helper', 'Used by Fixture.main',
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
    await fits(page, ['#detail-panel .report-outline', '#detail-panel .outline-item', '#detail-panel .local-check .button', '#detail-panel .local-check-steps']);
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
