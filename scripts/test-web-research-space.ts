#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WorkerInput, WebRunInput, WorkerMessage } from '../apps/web/shared';
import type { WebObservation, WebInspection } from '../apps/web/collaboration';
import type { ResearchFeedback, ResearchProjectDetail, ResearcherProfile } from '../apps/web/researchProjectTypes';
import type { ResearchAsset, ResearchPublication } from '../apps/web/researchAssetTypes';
import { closeSettings, openSettings } from './web-ui-controls';
import { freePort, postRun, preferFullCollaboration, ready, settled, startBrowser, webScenario, writeScenarioReport, type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-research-space');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-research-browser-'));
const source = 'theorem research_fixture : True := by sorry\n', credential = 'sk-local-research-fixture';
const hash = (letter: string) => letter.repeat(64), now = () => new Date().toISOString();
const inputs: WorkerInput[] = [];
type Control = { observation: WebObservation; send: (message: WorkerMessage) => void; emit: () => void };
const controls = new Map<string, Control>();
function observation(id: string): WebObservation {
  const tasks = [{ id: 'lemma', kind: 'lemma' as const, objective: 'Prove a supporting fact', dependsOn: [], revision: 0, theoremName: 'supporting_fact', proofPath: 'Main.lean', type: 'True' },
    { id: 'goal', kind: 'goal' as const, objective: 'Prove the original statement', dependsOn: ['lemma'], revision: 0, theoremName: 'research_fixture', proofPath: 'Main.lean', type: 'True' }];
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `fixture-${id}`, stateDigest: hash('a'), resultDigest: null };
  const inspection: WebInspection = { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
    problem: { id: 'research-browser-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'research_fixture', proofPath: 'Main.lean' }] },
    configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative', buildDigest: hash('b'), environmentDigest: hash('e') }, turns: 1, planVersion: 'fixture-plan-v1',
    scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
    knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded', droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] },
    tokenBudget: {}, continuation: {}, mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: hash('c'), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
    progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['lemma', 'goal'] }, groups: [],
    tasks: tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective, group: 'main', status: 'pending', control: 'active', version: `${task.id}-v1`, theorem: task.theoremName, type: task.type,
      premises: [], plannedDependencies: task.dependsOn, attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })), workers: [], statementReviews: [], edits: [] };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1, evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, inspection,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'fixture-plan-v1', tasks }, sources: [], checks: [], guidance: [], coverage: { sources: 'partial', checks: 'partial' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable local research UI fixture' }; },
  async run(input, send, signal) {
    inputs.push(input);
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), send, emit() { this.observation.sequence++; this.observation.observedAt = now(); this.send({ type: 'observation', observation: structuredClone(this.observation) }); } };
      controls.set(input.id, control); control.emit(); signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  async command(id, command) {
    const control = controls.get(id); assert.ok(control);
    if (command.type === 'guidance') {
      const guidance = { ...command.guidance, status: 'delivered' as const, deliveredTo: ['fixture-lead'], createdAt: now(), updatedAt: now() };
      control.observation.guidance.push(guidance); control.emit(); return { id: command.guidance.id, status: 'delivered', guidance, observation: structuredClone(control.observation) };
    }
    throw new Error(`Unexpected fixture command: ${command.type}`);
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '8' }), runner);
const browser = await startBrowser(service.server, port), suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const runInput: WebRunInput = { providerId: 'openai', apiKey: credential, model: 'fixture', effort: 'low', environment: 'standard', source,
  task: 'Disposable collaboration fixture', maxTurns: 2, maxRunSeconds: 60, workers: 2, coordination: 'cooperative' };
const created: { projectId?: string; assetId?: string; authorId?: string; thirdCookies?: Awaited<ReturnType<BrowserContext['cookies']>> } = {};
async function http<T>(page: Page, method: string, pathname: string, input?: unknown): Promise<T> {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const value = await response.json(); if (!response.ok) throw new Error(`Fixture HTTP ${response.status}: ${value.error}`); return value;
  }, { method, pathname, input }) as Promise<T>;
}
async function request(page: Page, method: string, pathname: string, action: () => Promise<unknown>, readBody = true) {
  const received = page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === method).then(async response => {
    assert.ok(response.ok(), `${method} ${pathname}: ${response.status()}`); return readBody ? await response.json() : undefined;
  });
  await action(); return await received;
}
async function fit(page: Page, label: string) {
  await settled(page); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${label} fits the viewport`);
}
function reviseLemma(control: Control) {
  const task = control.observation.inspection.tasks.find(task => task.id === 'lemma')!;
  control.observation.history = [...(control.observation.history ?? []), structuredClone(task)];
  task.version = 'lemma-v2'; task.objective = 'Prove the revised supporting fact with explicit assumptions'; task.type = 'True ∧ True';
  control.observation.inspection.planVersion = 'fixture-plan-v2';
  control.observation.plan!.baseVersion = 'fixture-plan-v2';
  Object.assign(control.observation.plan!.tasks.find(task => task.id === 'lemma')!, { revision: 1, objective: task.objective, type: task.type });
  control.observation.snapshot.stateDigest = hash('d'); control.emit();
}
async function visibleFeedback(page: Page) {
  return page.locator('[data-research-feedback-workspace] article[id^="feedback-"]:visible').evaluateAll(nodes => nodes.map(node => node.id).sort());
}

try {
  await webScenario(browser, suite, 'three sessions create, collaborate, publish and reuse fixed versions', async ({ page }) => {
    const others = await Promise.all([browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }), browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })]);
    const errors: string[] = [], external: string[] = [];
    try {
      for (const context of others) {
        await preferFullCollaboration(context);
        await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
        context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      }
      const collaborator = await others[0].newPage(), visitor = await others[1].newPage();
      await page.goto(`${origin}/people.html`); await page.getByRole('link', { name: '我的主页', exact: true }).click();
      await page.getByText('编辑我的资料', { exact: true }).click();
      await page.getByLabel('显示名', { exact: true }).fill('Fixture Mathematician A'); await page.getByLabel('研究领域，用逗号分隔').fill('logic, algebra');
      await page.getByLabel('简介', { exact: true }).fill('Collaborative mathematics browser fixture.'); await page.getByLabel('资料可见范围').selectOption('public');
      await request(page, 'PUT', '/api/research/profile', () => page.getByRole('button', { name: '保存资料', exact: true }).click());
      await page.getByRole('heading', { name: 'Fixture Mathematician A', exact: true }).waitFor();
      const a = await http<{ researcherId: string }>(page, 'GET', '/api/research/session'); created.authorId = a.researcherId;
      await page.screenshot({ path: path.join(output, 'people-desktop.png'), fullPage: true });
      await collaborator.goto(`${origin}/people.html`); const b = await http<{ researcherId: string; profile: ResearcherProfile }>(collaborator, 'GET', '/api/research/session');
      await http(collaborator, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(), expectedRevision: b.profile.revision, displayName: 'Fixture Mathematician B', visibility: 'public' });
      await visitor.goto(`${origin}/people.html`); const c = await http<{ researcherId: string; profile: ResearcherProfile }>(visitor, 'GET', '/api/research/session');
      await http(visitor, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(), expectedRevision: c.profile.revision, displayName: 'Fixture Mathematician C', visibility: 'public' });
      assert.equal(new Set([a.researcherId, b.researcherId, c.researcherId]).size, 3, 'independent browser sessions');

      await page.goto(`${origin}/theorems.html`); await page.getByRole('button', { name: '新建定理', exact: true }).click();
      await page.getByLabel('定理名称', { exact: true }).fill('Collaborative True');
      await page.getByLabel('研究描述', { exact: true }).fill('A fixed statement shared across three sessions.'); await page.getByLabel('领域，用逗号分隔').fill('logic');
      await page.getByRole('combobox', { name: /可见范围/u }).selectOption('public');
      await request(page, 'POST', '/api/research/theorems', () => page.getByRole('button', { name: '创建定理', exact: true }).click(), false);
      await page.waitForURL(/theorems\.html\?id=/u); created.projectId = new URL(page.url()).searchParams.get('id')!;
      const projectPath = `/api/research/theorems/${created.projectId}`;
      await page.locator('[data-project-statement-editor]').waitFor(); await page.getByLabel('自然语言 / TeX 原题', { exact: true }).fill('Prove that True holds.');
      await page.getByLabel('完整 Lean 源码', { exact: true }).fill(source); await page.getByRole('combobox', { name: /证明环境/u }).selectOption('standard');
      await page.getByLabel('目标声明，每行：限定名 | 文件').fill('research_fixture | Main.lean');
      await page.getByLabel('我已核对自然语言题意与 Lean 陈述一致').check();
      await request(page, 'POST', `${projectPath}/versions`, () => page.getByRole('button', { name: '保存新版本', exact: true }).click());
      await page.getByText('提交者已确认题意', { exact: true }).waitFor();
      await page.getByLabel('数学家', { exact: true }).fill(b.researcherId);
      await request(page, 'PUT', `${projectPath}/members/${b.researcherId}`, () => page.getByRole('button', { name: '保存成员', exact: true }).click());
      const ownRun = await postRun({ page }, runInput); assert.ok(controls.has(ownRun.id));
      await page.getByText('关联我的研究运行', { exact: true }).click();
      // The list was read before this fixture run existed; refresh the document to fetch the current list.
      await page.reload(); await page.getByText('关联我的研究运行', { exact: true }).click();
      await page.getByLabel('与当前陈述源码、环境一致的运行').selectOption(ownRun.id); await page.getByLabel('运行可见范围').selectOption('public');
      await page.getByLabel('数学指导', { exact: true }).check();
      await request(page, 'POST', `${projectPath}/runs`, () => page.getByRole('button', { name: '关联运行', exact: true }).click());
      await page.locator('.collab-surface').waitFor();
      await page.getByLabel('讨论内容', { exact: true }).fill('Owner discussion with an explicit statement version.');
      await request(page, 'POST', `${projectPath}/feedback`, () => page.getByRole('button', { name: '保存讨论', exact: true }).click());

      await collaborator.goto(`${origin}/theorems.html?id=${created.projectId}`); await collaborator.locator('.collab-surface').waitFor();
      const follow = collaborator.getByRole('button', { name: '关注', exact: true }); await follow.focus(); await collaborator.keyboard.press('Space');
      await collaborator.getByRole('button', { name: '已关注', exact: true }).waitFor();
      await collaborator.locator('[data-collab-task="lemma"]').first().click();
      await collaborator.locator('[data-collab-nav-guide]').click();
      assert.ok(await collaborator.locator('.research-collaboration').evaluate(node => node.scrollTop > 0), 'guidance navigation scrolls the research viewport');
      await collaborator.locator('[data-guidance-text]').fill('Use the supporting fact and keep its assumptions explicit.');
      await request(collaborator, 'POST', `${projectPath}/runs/${ownRun.id}/guidance`, () => collaborator.locator('[data-collab-guidance-form] button[type="submit"]').click());
      await collaborator.getByText('Use the supporting fact and keep its assumptions explicit.', { exact: true }).last().waitFor();
      await collaborator.getByLabel('讨论内容', { exact: true }).fill('Draft retained while observations refresh.');
      const readingTop = await collaborator.locator('.research-collaboration').evaluate(node => node.scrollTop);
      controls.get(ownRun.id)!.emit();
      await collaborator.waitForResponse(response => new URL(response.url()).pathname === projectPath && response.request().method() === 'GET');
      assert.equal(await collaborator.getByLabel('讨论内容', { exact: true }).inputValue(), 'Draft retained while observations refresh.');
      assert.equal(await collaborator.locator('[data-collab-task="lemma"]').first().getAttribute('aria-pressed'), 'true');
      assert.equal(await collaborator.locator('.research-collaboration').evaluate(node => node.scrollTop), readingTop, 'observation refresh retains the reading position');
      await fit(collaborator, 'theorem desktop'); await collaborator.screenshot({ path: path.join(output, 'theorems-desktop.png'), fullPage: true });
      await collaborator.setViewportSize({ width: 390, height: 844 }); await collaborator.reload(); await collaborator.locator('.collab-surface').waitFor();
      assert.equal(await collaborator.locator('[data-collab-task-view="list"]').getAttribute('aria-pressed'), 'true', 'mobile research starts with the task list');
      await collaborator.locator('[data-collab-section-picker]').selectOption('guidance');
      assert.ok(await collaborator.locator('.research-collaboration').evaluate(node => node.scrollTop > 0), 'mobile navigation scrolls the research viewport');
      await fit(collaborator, 'member theorem mobile'); await collaborator.screenshot({ path: path.join(output, 'theorems-member-mobile.png'), fullPage: true });

      await page.goto(`${origin}/library.html?create=1`); await page.getByRole('combobox', { name: /内容类型/u }).selectOption('skill');
      await page.getByLabel('名称', { exact: true }).fill('Explicit assumptions Skill'); await page.getByLabel('用途与说明').fill('Keep assumptions visible when planning elementary proofs.');
      await page.getByLabel('适用情境与执行要求').fill('Before proposing a proof route, list the hypotheses used by each supporting lemma.');
      await page.getByLabel('执行步骤，每行一步').fill('Read the frozen statement.\nList assumptions for each lemma.\nReturn a dependency-aware plan.');
      await request(page, 'POST', '/api/research/library', () => page.getByRole('button', { name: '创建私有草稿', exact: true }).click(), false);
      await page.waitForURL(url => url.pathname === '/library.html' && url.searchParams.has('entry')); created.assetId = new URL(page.url()).searchParams.get('entry')!;
      await request(page, 'GET', `/api/research/library/${created.assetId}/preview`, () => page.getByRole('button', { name: '预览将公开的内容', exact: true }).click());
      await page.locator('.research-draft-preview').waitFor();
      await page.getByLabel('许可证', { exact: true }).fill('MIT'); await page.getByRole('combobox', { name: /^发布范围/u }).selectOption('public'); await page.getByLabel('我已审阅保存的草稿及发布范围').check();
      const publish = await request(page, 'POST', `/api/research/library/${created.assetId}/publish`, () => page.getByRole('button', { name: '发布并检查', exact: true }).click()) as { item: ResearchPublication };
      await page.getByText('查看发布版本', { exact: true }).waitFor();
      const published = await http<{ item: ResearchPublication }>(page, 'GET', `/api/research/publications/${publish.item.id}`); assert.equal(published.item.status, 'completed');
      await visitor.goto(`${origin}/theorems.html?id=${created.projectId}`); await visitor.getByText('当前只展示公开运行概况，尚无已公开的验收证明。', { exact: true }).waitFor();
      assert.equal(await visitor.locator('.collab-surface').count(), 0, 'public visitors do not receive the internal research graph');
      await visitor.goto(`${origin}/library.html?entry=${created.assetId}&version=v1`); await visitor.getByText('适用情境与要求', { exact: true }).waitFor();
      await fit(visitor, 'library desktop'); await visitor.screenshot({ path: path.join(output, 'library-desktop.png'), fullPage: true });
      const downloaded = await http<{ item: ResearchAsset }>(visitor, 'GET', `/api/research/library/${created.assetId}`); assert.equal(downloaded.item.release?.license, 'MIT');
      await visitor.getByRole('button', { name: '用于新研究', exact: true }).click(); await visitor.locator('.composer-research-selection').waitFor();
      assert.ok((await visitor.locator('.composer-research-selection').innerText()).includes('Explicit assumptions Skill'));
      await ready(visitor); await openSettings(visitor); await visitor.locator('#provider').selectOption('openai'); await visitor.locator('#model').fill('fixture'); await visitor.locator('#api-key').fill(credential); await closeSettings(visitor);
      await visitor.evaluate(value => { const field = document.querySelector<HTMLTextAreaElement>('#source')!; field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); }, source);
      await visitor.locator('#task').fill('Use the selected shared Skill for this research.');
      const started = await request(visitor, 'POST', '/api/runs', () => visitor.locator('#submit-run:enabled').click());
      const worker = inputs.find(input => input.id === started.run.id); assert.ok(worker?.researchConfiguration);
      assert.equal(worker.researchConfiguration.skills[0].ref.assetId, created.assetId); assert.equal(worker.researchConfiguration.skills[0].ref.version, 'v1');
      assert.ok(worker.researchConfiguration.modulePlan.custom.some(module => module.instructions.includes('list the hypotheses')));
      const project = await http<{ item: ResearchProjectDetail }>(page, 'GET', projectPath); assert.equal(project.item.versions.length, 1); assert.ok(project.item.feedback.some(item => item.kind === 'guidance' && item.author.id === b.researcherId));
      created.thirdCookies = await others[1].cookies(); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    } finally { await Promise.all(others.map(context => context.close())); }
  }, { context: { viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }, harness: (page, context) => ({ page, context, requests: [] }),
    routes: { local: 'Research UI fixture must stay local' }, timeout: { label: 'Research collaboration', seconds: 110 }, failure: { fullPage: true } });

  await webScenario(browser, suite, 'exact route versions, retained feedback drafts and observable adoption results', async ({ page }) => {
    await page.goto(`${origin}/theorems.html`);
    const project = await http<{ item: ResearchProjectDetail }>(page, 'POST', '/api/research/theorems',
      { requestId: crypto.randomUUID(), title: 'Versioned feedback fixture', visibility: 'private' });
    const projectPath = `/api/research/theorems/${project.item.id}`;
    const versioned = await http<{ item: ResearchProjectDetail }>(page, 'POST', `${projectPath}/versions`, {
      requestId: crypto.randomUUID(), expectedRevision: project.item.revision, statement: 'Prove True with explicit supporting assumptions.', source, environment: 'standard',
      targets: [{ theoremName: 'research_fixture', proofPath: 'Main.lean' }], confirmation: { confirmed: true },
    });
    const statementVersionId = versioned.item.currentStatementVersionId!;
    const run = await postRun({ page }, { ...runInput, task: 'Feedback route A' });
    const otherRun = await postRun({ page }, { ...runInput, task: 'Feedback route B with the same task IDs and versions' });
    let projectRevision = versioned.item.revision;
    for (const item of [run, otherRun]) {
      const bound = await http<{ item: ResearchProjectDetail }>(page, 'POST', `${projectPath}/runs`,
        { requestId: crypto.randomUUID(), expectedRevision: projectRevision, runId: item.id, statementVersionId, exposure: 'members' });
      projectRevision = bound.item.revision;
    }
    const control = controls.get(run.id)!, otherControl = controls.get(otherRun.id)!;
    const feedback = async (control: Control, text: string, taskId: string) => {
      const task = control.observation.inspection.tasks.find(task => task.id === taskId)!;
      return (await http<{ item: ResearchFeedback }>(page, 'POST', `${projectPath}/feedback`, {
        requestId: crypto.randomUUID(), kind: 'guidance', text, recipient: { kind: 'task', id: task.id },
        target: { runId: control.observation.webRunId, statementVersionId, taskRef: { id: task.id, version: task.version },
          observationRef: { sequence: control.observation.sequence, stateDigest: control.observation.snapshot.stateDigest } },
      })).item;
    };
    const historical = await feedback(control, 'Historical lemma advice: preserve the original assumptions.', 'lemma');
    reviseLemma(control); reviseLemma(otherControl);
    const current = await feedback(control, 'Current lemma advice: make the revised hypotheses explicit.', 'lemma');
    const goal = await feedback(control, 'Goal advice: explain how the supporting fact closes the original statement.', 'goal');
    const other = await feedback(otherControl, 'Other run advice: do not mix an identically named task into this route.', 'lemma');
    await http(page, 'POST', `${projectPath}/feedback/${goal.id}/decision`,
      { requestId: crypto.randomUUID(), status: 'needs-info', reason: 'The goal still needs a dependency explanation.', expectedRevision: goal.revision });
    const href = (task: string, taskVersion: string) => `${origin}/theorems.html?${new URLSearchParams({
      id: project.item.id, run: run.id, version: statementVersionId, task, taskVersion })}`;
    await page.goto(href('lemma', 'lemma-v2')); await page.locator('[data-research-feedback-workspace]').waitFor();
    await page.locator('[data-inspected-task-version]').filter({ hasText: 'lemma-v2' }).waitFor();
    const scope = page.locator('[data-feedback-scope]'), status = page.locator('[data-feedback-status]'), search = page.locator('[data-feedback-search]');
    const article = (item: ResearchFeedback) => page.locator(`article#feedback-${item.id}`);
    const oldArticle = article(historical), currentArticle = article(current);
    const expectedAll = [historical, current, goal, other].map(item => `feedback-${item.id}`).sort();
    assert.equal(await scope.inputValue(), 'all', 'the feedback workspace starts with the whole project');
    await status.selectOption('all'); assert.deepEqual(await visibleFeedback(page), expectedAll);
    await oldArticle.getByText('记录采纳决定', { exact: true }).click();
    const reason = 'Keep the v1 rationale while adopting the explicitly linked v2 execution.';
    await oldArticle.getByLabel('理由', { exact: true }).fill(reason);
    const retainedArticle = (await oldArticle.elementHandle())!;
    await scope.selectOption('task');
    assert.deepEqual(await visibleFeedback(page), [`feedback-${current.id}`], 'task scope uses both the run ID and the exact selected version');
    assert.equal(await oldArticle.evaluate(node => node instanceof HTMLElement && node.hidden), true, 'filtering hides the historical article');
    assert.equal(await retainedArticle.evaluate(node => node.isConnected), true, 'filtering keeps the original feedback article mounted');
    await search.fill('No matching feedback should replace an existing draft');
    assert.deepEqual(await visibleFeedback(page), []);
    await search.fill(''); await scope.selectOption('run');
    assert.deepEqual(await visibleFeedback(page), [historical, current, goal].map(item => `feedback-${item.id}`).sort(), 'run scope excludes the second run');
    await status.selectOption('pending');
    assert.deepEqual(await visibleFeedback(page), [historical, current].map(item => `feedback-${item.id}`).sort());
    await status.selectOption('attention'); assert.ok((await visibleFeedback(page)).includes(`feedback-${goal.id}`), 'needs-info remains visible as attention');
    await status.selectOption('all'); await scope.selectOption('all');
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === projectPath && response.request().method() === 'GET');
    control.emit(); await refreshed;
    assert.equal(await oldArticle.getByLabel('理由', { exact: true }).inputValue(), reason, 'polling and every filter preserve the adoption rationale');
    assert.equal(await retainedArticle.evaluate((node, id) => node === document.getElementById(id), `feedback-${historical.id}`), true);
    await oldArticle.getByLabel('证据引用，每行一项').fill('task:lemma@lemma-v2\ntask:goal@goal-v1');
    const accepted = await request(page, 'POST', `${projectPath}/feedback/${historical.id}/decision`,
      () => oldArticle.getByRole('button', { name: '保存决定', exact: true }).click());
    assert.equal(accepted.item.decision.status, 'accepted'); assert.equal(accepted.item.execution.status, 'not-started');
    await status.selectOption('accepted'); await oldArticle.waitFor({ state: 'visible' });
    assert.deepEqual(await visibleFeedback(page), [`feedback-${historical.id}`]);
    await status.selectOption('all'); await scope.selectOption('task');
    assert.deepEqual(await visibleFeedback(page), [historical, current].map(item => `feedback-${item.id}`).sort(), 'an explicit execution reference can associate the older feedback with v2');
    await oldArticle.locator('.guidance-outcome-details > summary').click();
    const executionLinks = oldArticle.getByRole('link', { name: /^查看执行节点/u });
    assert.equal(await executionLinks.count(), 2, 'both recorded execution nodes can be inspected');
    for (const link of await executionLinks.all()) {
      const target = new URL((await link.getAttribute('href'))!, page.url());
      assert.equal(target.searchParams.get('run'), run.id); assert.equal(target.searchParams.get('version'), statementVersionId);
      assert.ok(['lemma@lemma-v2', 'goal@goal-v1'].includes(`${target.searchParams.get('task')}@${target.searchParams.get('taskVersion')}`));
    }
    await status.selectOption('executing'); assert.deepEqual(await visibleFeedback(page), []);
    const lemma = control.observation.inspection.tasks.find(task => task.id === 'lemma')!;
    lemma.status = 'running'; lemma.attempts = 1; control.emit();
    await oldArticle.waitFor({ state: 'visible' }); assert.deepEqual(await visibleFeedback(page), [`feedback-${historical.id}`]);
    await status.selectOption('completed'); assert.deepEqual(await visibleFeedback(page), []);
    for (const task of control.observation.inspection.tasks) { task.status = 'completed'; task.proof = { status: 'checked' }; }
    control.observation.inspection.progress.openProofTasks = []; control.observation.inspection.progress.checkedProofTasks = 2; control.emit();
    await oldArticle.waitFor({ state: 'visible' }); assert.deepEqual(await visibleFeedback(page), [`feedback-${historical.id}`]);
    assert.equal(await currentArticle.evaluate(node => node instanceof HTMLElement && node.hidden), true, 'an unaccepted current suggestion is not completed by nearby task activity');
    await fit(page, 'feedback desktop'); await page.screenshot({ path: path.join(output, 'feedback-route-desktop.png'), fullPage: true });

    await status.selectOption('all'); await scope.selectOption('all');
    const timeline = page.locator(`a[href="#feedback-${historical.id}"]`).first(); await timeline.click();
    assert.equal(new URL(page.url()).hash, `#feedback-${historical.id}`);
    await oldArticle.getByText('查看对应节点', { exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('task') === 'lemma' && url.searchParams.get('taskVersion') === 'lemma-v1');
    assert.equal(new URL(page.url()).searchParams.get('run'), run.id); assert.equal(new URL(page.url()).searchParams.get('version'), statementVersionId);
    await page.locator('[data-inspected-task-version]').filter({ hasText: 'lemma-v1' }).waitFor();
    assert.match(await page.locator('[data-task-history-notice]').innerText(), /历史/u);
    assert.match(await page.locator('[data-collab-inspector] .collab-inspected-objective').innerText(), /Prove a supporting fact/u);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-feedback-task-context]').getByRole('button', { name: '查看此节点反馈', exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('[data-feedback-scope]')?.value === 'task');
    assert.equal(await scope.inputValue(), 'task');
    assert.deepEqual(await visibleFeedback(page), [`feedback-${historical.id}`], 'historical task scope excludes the current-version suggestion');
    await fit(page, 'historical feedback mobile'); await page.screenshot({ path: path.join(output, 'feedback-route-mobile.png'), fullPage: true });
    const outcomeDetails = oldArticle.locator('.guidance-outcome-details');
    if (!await outcomeDetails.evaluate(element => (element as HTMLDetailsElement).open)) await outcomeDetails.locator(':scope > summary').click();
    const executionHref = await oldArticle.getByRole('link', { name: /^查看执行节点/u }).evaluateAll(links => links.map(link => link.getAttribute('href')!));
    const toCurrent = executionHref.find(value => new URL(value, page.url()).searchParams.get('task') === 'lemma')!;
    await oldArticle.locator(`a[href="${toCurrent}"]`).click();
    await page.waitForURL(url => url.searchParams.get('taskVersion') === 'lemma-v2');
    await page.locator('[data-inspected-task-version]').filter({ hasText: 'lemma-v2' }).waitFor();
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('heading', { name: project.item.title, level: 1, exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await status.selectOption('all'); await scope.selectOption('all');
    await oldArticle.getByText('View corresponding node', { exact: true }).waitFor();
    await oldArticle.locator('.guidance-outcome-details > summary').click();
    assert.equal(await oldArticle.getByRole('link', { name: /^View execution node/u }).count(), 2);
    assert.ok((await page.locator('[data-feedback-summary]').innerText()).trim());
    await fit(page, 'English feedback mobile'); await page.screenshot({ path: path.join(output, 'feedback-route-en-mobile.png'), fullPage: true });
    await page.goto(href('lemma', 'lemma-never-retained'));
    await page.locator('[data-inspected-task-version]').filter({ hasText: 'lemma-never-retained' }).waitFor();
    assert.ok((await page.locator('[data-task-history-notice]').innerText()).trim(), 'a missing historical version has an explicit notice');
    assert.equal(await page.locator('[data-collab-inspector] .collab-inspected-title').count(), 0, 'a missing version never renders the current contract');
    await fit(page, 'missing historical task mobile'); await page.screenshot({ path: path.join(output, 'feedback-route-missing-mobile.png'), fullPage: true });
    const unavailableRun = new URL(href('lemma', 'lemma-v1')); unavailableRun.searchParams.set('run', 'run-no-longer-visible');
    await page.goto(unavailableRun.href);
    await page.getByText('The selected run is unavailable. Choose a run you can access.', { exact: true }).waitFor();
    assert.equal(await page.locator('.collab-surface').count(), 0, 'an unavailable run never falls back to another run with the same task');
    const unavailableStatement = new URL(href('lemma', 'lemma-v1')); unavailableStatement.searchParams.set('version', 'statement-no-longer-visible');
    await page.goto(unavailableStatement.href);
    await page.getByText('The selected statement version is unavailable. Choose a version from the list.', { exact: true }).waitFor();
    assert.equal(await page.locator('.collab-surface').count(), 0, 'an unavailable statement never falls back to another version');
    await page.goto(href('lemma', 'lemma-v2'));
    await page.locator('[data-inspected-task-version]').filter({ hasText: 'lemma-v2' }).waitFor();
    assert.equal(await page.locator('.collab-surface').count(), 1, 'a valid exact link restores the selected run and task version');
    await retainedArticle.dispose();
  }, { context: { viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }, harness: (page, context) => ({ page, context, requests: [] }),
    routes: { local: 'Route feedback fixture must stay local' }, timeout: { label: 'Route feedback', seconds: 105 }, failure: { fullPage: true } });

  await webScenario(browser, suite, '390px layouts, keyboard access and English navigation', async ({ page }) => {
    for (const [name, url, heading] of [
      ['people', `/people.html?id=${created.authorId}`, 'Fixture Mathematician A'],
      ['theorems', `/theorems.html?id=${created.projectId}`, 'Collaborative True'],
      ['library', `/library.html?entry=${created.assetId}&version=v1`, 'Explicit assumptions Skill'],
    ]) {
      await page.goto(origin + url); await page.getByRole('heading', { name: heading, exact: true }).waitFor(); await fit(page, `${name} mobile`);
      await page.screenshot({ path: path.join(output, `${name}-mobile.png`), fullPage: true });
    }
    await page.goto(`${origin}/people.html?id=${created.authorId}`); await page.getByRole('heading', { name: 'Fixture Mathematician A', exact: true }).waitFor();
    await page.keyboard.press('Tab'); assert.equal(await page.locator('.skip-link').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Enter'); assert.equal(await page.locator('#main').evaluate(node => node === document.activeElement), true);
    await page.getByRole('button', { name: 'English', exact: true }).click(); await page.locator('html[lang="en"]').waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en'); await fit(page, 'English mobile');
  }, { context: { viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }, init: async context => { if (created.thirdCookies) await context.addCookies(created.thirdCookies); },
    harness: (page, context) => ({ page, context, requests: [] }), routes: { local: 'Mobile research fixture must stay local' }, timeout: { label: 'Research mobile', seconds: 45 }, failure: { fullPage: true } });
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined, 'real HTTP, three disposable sessions, mocked worker, no model calls', { checks: suite.checks }, { credential });
  console.log(`Research-space browser checks passed: ${output}`);
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'real HTTP with a mocked worker', { checks: suite.checks }, { credential, failureRequests: true });
  throw error;
} finally { await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
