#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebObservation, WebInspection } from '../apps/web/collaboration';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput } from '../apps/web/shared';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { buildTheoremKnowledge, type KnowledgeRouteFindingCandidate } from '../src/solver/theoremKnowledge';
import { refreshHistory, selectHistoryRun } from './web-ui-controls';
import { deferred, freePort, postRun, settled, startBrowser, webScenario, writeScenarioReport,
  type ScenarioHarness, type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-knowledge-context');
await fs.mkdir(output, { recursive: true });
const environmentA = mathDigest('recorded environment A'), environmentB = mathDigest('recorded environment B');
const goal = '∀ n : Nat, n = n', objective = 'Explore an identity route with explicit assumptions';
const historicalProblem = 'another-archived-problem', currentProblem = 'current-browser-problem';
const source = 'theorem original_goal : True := by sorry\n';
const finding: KnowledgeRouteFindingCandidate = {
  evidence: 'recorded-advisory-not-replayed', acceptance: 'not-assessed', conclusion: 'supporting',
  summary: 'An archived identity route', finding: 'Apply reflexivity after introducing the variable.', notes: 'Historical notes only.',
  scope: { problemId: historicalProblem, problemReceiptDigest: mathDigest('historical problem receipt'), environmentDigest: environmentA,
    source: { kind: 'lemma', statementKind: 'closed-task-type', statement: goal, premises: [] }, dependencies: [] },
  evidenceRefs: [], obstructions: [], remainingObligations: [], reconsiderWhen: [],
  provenance: { source: 'fixture-state.json', sourceDigest: mathDigest('fixture state'), runId: 'historical-run', taskId: 'historical-task',
    taskDigest: mathDigest(goal), groupId: 'main', deliveryId: 'historical-delivery', sourceCommit: 'a'.repeat(40),
    findingDigest: mathDigest('Apply reflexivity after introducing the variable.'), notesDigest: mathDigest('Historical notes only.') },
};
const catalog = buildTheoremKnowledge([{
  name: 'Saved.identity', file: 'Knowledge.lean', type: goal, typeKind: 'closed-task-type', kind: 'lemma',
  description: 'A recorded identity theorem from another problem', premises: [],
  dependencies: { statement: [], proof: [], tasks: [], coverage: 'recorded' },
  files: { 'Knowledge.lean': `theorem Saved.identity : ${goal} := by intro n; rfl\n` },
  provenance: { kind: 'solver-check', problemId: historicalProblem, source: 'local browser fixture',
    sourceDigest: mathDigest('historical source'), sourceCommit: 'a'.repeat(40), receiptIds: ['historical-check'], environmentDigest: environmentA },
}], undefined, [finding]);
const theoremId = catalog.entries[0]!.id, findingId = catalog.routeFindings![0]!.id;
const now = () => new Date().toISOString();
function observation(id: string): WebObservation {
  const tasks = [
    { id: 'identity_task', kind: 'lemma' as const, objective: 'Prove the exact identity type', type: goal,
      dependsOn: [], revision: 0, theoremName: 'identity_task', proofPath: 'Submission.lean' },
    { id: 'research', kind: 'research' as const, objective, dependsOn: [], revision: 0 },
    { id: 'original', kind: 'goal' as const, objective: 'Prove the original theorem', type: 'True',
      dependsOn: [], revision: 0, theoremName: 'original_goal', proofPath: 'Submission.lean' },
  ];
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `solver-${id}`, stateDigest: mathDigest('initial state'), resultDigest: null };
  const inspection: WebInspection = {
    schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
    problem: { id: currentProblem, statement: 'Investigate identity', formalStatement: 'True', assumptions: [],
      targets: [{ proofPath: 'Submission.lean', theoremName: 'original_goal' }] },
    configuration: { model: 'local-fixture', effort: 'low', workers: 2, coordination: 'cooperative',
      buildDigest: mathDigest('fixture build'), environmentDigest: environmentA },
    turns: 0, planVersion: 'plan-v1',
    scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
    knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded',
      droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
    mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
      digest: mathDigest('obligations'), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
    progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['identity_task', 'original'] },
    groups: [], tasks: tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective, type: task.type,
      group: 'main', status: 'pending', control: 'active', version: `${task.id}-v1`, theorem: task.theoremName,
      premises: [], plannedDependencies: [], attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })),
    workers: [], statementReviews: [], edits: [],
  };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, inspection,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks },
    sources: [], checks: [], guidance: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}
type Control = { observation: WebObservation; emit(): void; finish(): void };
const controls = new Map<string, Control>();
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local knowledge context HTTP fixture' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), finish: resolve, emit() {
        this.observation.sequence++; this.observation.observedAt = now();
        this.observation.snapshot.stateDigest = mathDigest(`fixture state ${this.observation.sequence}`);
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      controls.set(input.id, control);
      signal.addEventListener('abort', () => resolve(), { once: true });
      send({ type: 'catalog', catalog }); control.emit();
    });
  },
};
type Hold = { pathname: string; ready: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; done: ReturnType<typeof deferred> };
type Search = { url: URL; body: { catalogDigest: string; results: { hits: Array<{ environmentMatch: string }> };
  findings: { hits: Array<{ environmentMatch: string; statementMatch: string; scopeMatch: string; problemReceiptMatch: string }> } } };
type Harness = ScenarioHarness & { searches: Search[]; hold?: Hold; holds: Hold[] };
function hold(h: Harness, pathname: string) {
  const gate = { pathname, ready: deferred(), release: deferred(), done: deferred() };
  h.holds.push(gate); h.hold = gate; return gate;
}
function harness(page: Harness['page'], context: Harness['context']): Harness {
  const h: Harness = { page, context, requests: [], searches: [], holds: [] };
  h.intercept = async route => {
    const url = new URL(route.request().url());
    if (!/^\/api\/knowledge\/(?:search|[a-f0-9]{64})$/u.test(url.pathname)) return false;
    const gate = h.hold?.pathname === url.pathname ? h.hold : undefined;
    if (gate) h.hold = undefined;
    const response = await route.fetch();
    assert.equal(response.status(), 200, 'knowledge fixtures exercise the actual successful HTTP service');
    if (url.pathname === '/api/knowledge/search') h.searches.push({ url, body: await response.json() });
    if (gate) { gate.ready.resolve(); await gate.release.promise; }
    await route.fulfill({ response }); gate?.done.resolve(); return true;
  };
  return h;
}
async function refreshObservation(page: Page) {
  const response = page.waitForResponse(response => /\/observation$/u.test(new URL(response.url()).pathname));
  await page.locator('[data-collab-refresh]').click(); assert.equal((await response).status(), 200); await settled(page);
}
async function poll(page: Page) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'GET');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await response; await settled(page);
}
function assertRequest(search: Search, expectedGoal: string, environment?: string) {
  assert.equal(search.url.searchParams.get('q'), 'identity');
  assert.equal(search.url.searchParams.get('goal'), expectedGoal, 'the exact selected task type or objective reaches the real search API');
  assert.equal(search.url.searchParams.get('environmentDigest'), environment ?? null);
  assert.equal(search.url.searchParams.has('problemId'), false, 'cross-problem knowledge stays available by default');
  assert.equal(search.url.searchParams.has('problemReceiptDigest'), false, 'the UI must not invent a missing problem receipt');
}
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-local-knowledge-context-fixture', model: 'local-fixture', effort: 'low',
  environment: 'standard', source, task: 'Inspect knowledge in its actual research context', maxTurns: 1, maxRunSeconds: 120, workers: 2, coordination: 'cooperative' };
try {
  await webScenario(browser, suite, 'real research context, stale response invalidation and historical references', async h => {
    const { page } = h, run = await postRun(h, input);
    await refreshHistory(page); await selectHistoryRun(page, run.id);
    await page.locator('.collab-graph [data-collab-task="identity_task"]').click();
    const context = page.locator('[data-knowledge-context]'), detail = page.locator('.collab-knowledge-detail');
    const theorem = page.locator(`[data-knowledge-id="${theoremId}"]`), routeFinding = page.locator(`[data-knowledge-id="${findingId}"]`);
    await context.getByText('identity_task-v1', { exact: true }).waitFor();
    const exported = (await (await page.request.get(`${origin}/api/runs/${run.id}`)).json()).run.knowledgeCatalogDigest as string;
    assert.ok(exported); await page.locator(`#knowledge-catalog-search option[value="${exported}"]`).waitFor({ state: 'attached' });
    await page.locator('#knowledge-catalog-search').selectOption(exported);
    await page.locator('#knowledge-search').fill('identity'); await page.locator('.collab-knowledge-search button').click();
    await theorem.getByText(/记录环境一致/).waitFor(); await routeFinding.getByText(/目标与记录文本一致/).waitFor();
    assertRequest(h.searches.at(-1)!, goal, environmentA);
    assert.equal(h.searches.at(-1)!.body.catalogDigest, exported);
    assert.equal(h.searches.at(-1)!.body.results.hits[0]!.environmentMatch, 'match');
    assert.deepEqual(h.searches.at(-1)!.body.findings.hits.map(hit => ({ environment: hit.environmentMatch,
      statement: hit.statementMatch, receipt: hit.problemReceiptMatch, scope: hit.scopeMatch })),
    [{ environment: 'match', statement: 'exact-recorded-text', receipt: 'unknown', scope: 'not-established' }]);
    assert.ok((await theorem.innerText()).includes(historicalProblem), 'a theorem from another problem remains visible');
    await routeFinding.getByText(/适用范围尚未确认/).waitFor();
    await theorem.click(); await detail.locator('[data-knowledge-reference]').click();
    const guidance = page.locator('[data-guidance-text]'), draft = await guidance.inputValue();
    for (const expected of [theoremId, `目录 ${exported}`, currentProblem, 'identity_task', 'identity_task-v1', environmentA, '历史证据', '重新检查']) assert.ok(draft.includes(expected), expected);
    assert.equal(h.requests.some(request => request.pathname.includes('/guidance') && request.method !== 'GET'), false, 'a reference remains a local draft');
    await detail.locator('details').evaluateAll(nodes => nodes.forEach(node => node.removeAttribute('open')));
    await page.locator('.collab-knowledge').screenshot({ path: path.join(output, 'knowledge-context.png') });

    const control = controls.get(run.id)!, unchangedCount = h.searches.length;
    control.emit(); await refreshObservation(page); await poll(page);
    control.emit(); await refreshObservation(page); await settled(page);
    assert.equal(h.searches.length, unchangedCount, 'unchanged context must not search again on observation updates or ordinary polling');
    assert.equal(await detail.locator('[data-knowledge-reference]').count(), 1, 'unchanged context keeps readable evidence open');

    const oldSearch = hold(h, '/api/knowledge/search');
    await page.locator('.collab-knowledge-search button').click(); await oldSearch.ready.promise;
    control.observation.inspection.configuration.environmentDigest = environmentB;
    control.observation.inspection.tasks.find(task => task.id === 'identity_task')!.version = 'identity_task-v2';
    control.emit(); await refreshObservation(page);
    await context.getByText('identity_task-v2', { exact: true }).waitFor(); await theorem.getByText(/记录环境不同/).waitFor();
    assertRequest(h.searches.at(-1)!, goal, environmentB);
    oldSearch.release.resolve(); await oldSearch.done.promise; await settled(page);
    await theorem.getByText(/记录环境不同/).waitFor();
    assert.equal(await detail.locator('[data-knowledge-reference]').count(), 0, 'a context change invalidates an old reference');

    const oldDetail = hold(h, `/api/knowledge/${theoremId}`);
    await theorem.click(); await oldDetail.ready.promise;
    await page.locator('.collab-graph [data-collab-task="research"]').click();
    await context.getByText('research-v1', { exact: true }).waitFor(); await routeFinding.getByText(/仅关键词相关/).waitFor();
    assertRequest(h.searches.at(-1)!, objective, environmentB);
    oldDetail.release.resolve(); await oldDetail.done.promise; await settled(page);
    assert.equal(await detail.innerText(), '', 'an old detail response cannot restore another task’s evidence or reference');
    assert.equal(await page.locator('#knowledge-search').inputValue(), 'identity');
    assert.equal(await page.locator('#knowledge-catalog-search').inputValue(), exported);

    control.observation.inspection.configuration.environmentDigest = '';
    control.observation.inspection.problem.id = 'current-problem-without-recorded-environment';
    control.emit(); await refreshObservation(page);
    await theorem.getByText(/未提供当前环境/).waitFor();
    assertRequest(h.searches.at(-1)!, objective);
    assert.equal(h.searches.at(-1)!.body.results.hits[0]!.environmentMatch, 'not-requested');
    assert.equal(h.searches.at(-1)!.body.findings.hits[0]!.scopeMatch, 'not-established');
    await guidance.fill(''); await routeFinding.click(); await detail.locator('[data-knowledge-reference]').click();
    const reference = await guidance.inputValue();
    for (const expected of [findingId, exported, 'current-problem-without-recorded-environment', 'research-v1', '当前环境尚未记录', '历史证据', '重新检查']) assert.ok(reference.includes(expected), expected);
    assert.equal(reference.includes(environmentA), false); assert.equal(reference.includes(environmentB), false);
    assert.ok((await page.locator('.collab-metrics').innerText()).includes('尚未验收通过'));
    await detail.locator('details').evaluateAll(nodes => nodes.forEach(node => node.removeAttribute('open')));
    await page.locator('.collab-knowledge').screenshot({ path: path.join(output, 'knowledge-context-missing-environment.png') });
  }, { context: { viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }, harness,
    routes: { local: 'Knowledge context scenarios must stay on the local HTTP fixture' }, open: true,
    timeout: { label: 'Knowledge research context', seconds: 60 },
    verify: (h, elapsedMs) => ({ name: 'real research context, stale responses and bound references', elapsedMs: elapsedMs(),
      searchRequests: h.searches.map(({ url }) => Object.fromEntries(url.searchParams)), requests: h.requests }),
    cleanup: h => { for (const gate of h.holds) gate.release.resolve(); },
  });
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined, 'local-real-http-runtime-fixture',
    { checks: suite.checks, screenshots: ['knowledge-context.png', 'knowledge-context-missing-environment.png'] }, { credential: input.apiKey });
  console.log('Knowledge context browser checks passed');
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-runtime-fixture',
    { checks: suite.checks }, { credential: input.apiKey, failureRequests: true });
  throw error;
} finally {
  for (const control of controls.values()) control.finish();
  await browser.close(); await service.close();
}
