#!/usr/bin/env bun
// Disposable HTTP service, recorded observations and a fake runner; no external model, Lean or email.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { loadWebSample } from '../apps/web/sample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { WebRunner } from '../apps/web/runner';
import type { WebRun } from '../apps/web/shared';
import type { WebConversation } from '../apps/web/conversationTypes';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, startBrowser, settled } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/problem');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-problem-ui-'));
const sample = loadWebSample()!, port = await freePort(), origin = `http://127.0.0.1:${port}`;
let runs = 0, prohibited = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable recorded fixture' }; },
  async run(input, send) {
    runs++;
    const observation = structuredClone(sample.observations.at(-1)!); observation.webRunId = input.id;
    const task = observation.inspection.tasks[0];
    task.informalStatement = 'For every natural number $n$, $n+0=n$.';
    task.informalProof = input.input.task.startsWith('Earlier')
      ? 'First unfold $n+0$. This reduces the expression to $n$, so the remaining equality is $n=n$.'
      : 'Use the preceding reduction of $n+0$ to $n$. Reflexivity then closes $n=n$.';
    const reduction = structuredClone(task); reduction.id = 'reduction'; reduction.kind = 'research'; reduction.theorem = undefined;
    reduction.version = input.input.task.startsWith('Earlier') ? 'reduction-v1' : 'reduction-v2'; reduction.objective = 'Unfold addition at zero';
    reduction.informalProof = 'The second argument of addition is $0$. Applying its defining equation gives $n+0=n$.';
    reduction.finding = 'The next goal is the reflexive equality $n=n$.'; reduction.proof = { status: 'not-started' }; reduction.status = 'completed';
    task.plannedDependencies = ['reduction']; observation.inspection.tasks.unshift(reduction);
    const baseline = structuredClone(observation); baseline.sequence = 1; baseline.snapshot.stateDigest = mathDigest(`baseline:${input.id}`);
    baseline.inspection.planVersion = 'fixture-plan-before'; if (baseline.plan) baseline.plan.baseVersion = 'fixture-plan-before';
    baseline.inspection.edits = []; baseline.guidance = []; baseline.checks = [];
    baseline.inspection.tasks.find(item => item.id === task.id)!.version = 'fixture-goal-before';
    baseline.inspection.tasks.find(item => item.id === task.id)!.informalProof = 'Unfold zero addition, then justify the cancellation step.';
    send({ type: 'observation', observation: baseline });
    observation.sequence = 2; observation.snapshot.stateDigest = mathDigest(`result:${input.id}`); observation.inspection.planVersion = 'fixture-plan-after';
    if (observation.plan) observation.plan.baseVersion = 'fixture-plan-after';
    observation.inspection.edits = [{ id: 'fixture-human-edit', status: 'applied', baseVersion: 'fixture-plan-before', planVersion: 'fixture-plan-after', affectedTasks: [task.id] }];
    observation.guidance = [{ id: 'fixture-human-guidance', recipient: { kind: 'task', id: task.id }, taskRef: { id: task.id, version: 'fixture-goal-before' },
      text: 'Make the cancellation step explicit.', observationRef: { sequence: 1, stateDigest: baseline.snapshot.stateDigest }, status: 'delivered', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      decision: { guidanceId: 'fixture-human-guidance', status: 'accepted', reason: 'The revised plan records the requested argument.', evidenceRefs: [{ kind: 'edit', id: 'fixture-human-edit' }], workerId: 'Lead', decidedAt: new Date().toISOString() } }];
    send({ type: 'observation', observation });
    send({ type: 'result', result: { status: input.input.task.startsWith('Earlier') ? 'limit_reached' : 'evaluated_passed',
      proof: sample.run.result!.proof, report: { usage: { totalTokens: 1200 } } } });
  },
  async check() { prohibited++; throw new Error('No Lean in the problem UI check'); },
  async formalize() { prohibited++; throw new Error('No models in the problem UI check'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_CLIENT_IP_HEADER: 'x-fixture-scenario',
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner,
{ mailer: async () => { prohibited++; throw new Error('No mail in the problem UI check'); } });
const browser = await startBrowser(service.server, port), errors: string[] = [], external: string[] = [], checks: object[] = [];
let phase = 'setup', active: Page | undefined, failure: unknown;
const read = (page: Page, pathname: string) => page.evaluate(async pathname => {
  const response = await fetch(pathname), value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
}, pathname);
try {
  for (const language of ['zh', 'en'] as const) for (const width of [1440, 390]) {
    phase = `${language}-${width}`;
    // Each independent browser scenario represents a separate visitor, including its request allowance.
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: language === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce', extraHTTPHeaders: { 'x-fixture-scenario': `${language}-${width}` } });
    await context.addInitScript(({ key, language }) => localStorage.setItem(key, language), { key: localeStorageKey, language });
    await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/problem.html'); await page.locator('[data-problem-page]').waitFor();
    const owner = (await context.cookies(origin)).find(item => item.name === 'theoremos_session')!.value;
    const provider = (await read(page, '/api/session')).providers[0];
    const created = ['Earlier attempt', 'Accepted attempt'].map(task => service.jobs.create(owner, {
      providerId: provider.id, apiKey: 'sk-fixture-never-sent', model: 'fixture-model', effort: 'high', environment: sample.run.environment,
      source: sample.run.source.trim(), task, maxTurns: 2, maxRunSeconds: 60, maxTotalTokens: 10000, workers: 2, coordination: 'cooperative',
    }, provider));
    await page.waitForFunction(async () => { const { runs } = await (await fetch('/api/runs')).json(); return runs.length === 2 && runs.every((run: WebRun) => run.status === 'completed'); });
    const selected = service.jobs.get(owner, created[1].id)!, task = selected.observation!.inspection.tasks.find(item => item.id === 'goal_1')!;
    const conversation: WebConversation = { id: crypto.randomUUID(), title: 'Follow-up about the reduction', runId: selected.id,
      createdAt: selected.createdAt, updatedAt: selected.updatedAt, messages: [{ id: crypto.randomUUID(), role: 'user', kind: 'text',
        text: 'Why does $n+0$ reduce to $n$?', status: 'complete', createdAt: selected.createdAt }] };
    service.storage.saveRecord(['owners', mathDigest(owner), 'conversations', `${conversation.id}.json`], conversation);
    await page.goto(`${origin}/problem.html?${new URLSearchParams({ run: selected.id, tab: 'route', task: task.id, taskVersion: task.version, commit: task.proof.commit! })}`);
    await page.locator('[data-problem-route-decision] .solution-route-detail h4').filter({ hasText: task.theorem! }).waitFor();
    assert.match(await page.locator('[data-problem-route-decision] .solution-route-detail').innerText(), /preceding reduction/);
    await page.waitForFunction(() => document.querySelectorAll('.katex').length > 0);
    const clickTab = async (tab: string) => { await page.locator(`.problem-tabs a[href*="tab=${tab}"]`).click(); await settled(page); };
    await clickTab('outcomes'); assert.equal(new URL(page.url()).searchParams.get('task'), task.id);
    await page.reload(); await page.locator('.problem-table').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('commit'), task.proof.commit);
    await clickTab('route'); await page.locator('[data-problem-route-decision] .solution-route-detail h4').filter({ hasText: task.theorem! }).waitFor();
    const exactSource = page.locator('.problem-context a');
    assert.equal(new URL(await exactSource.getAttribute('href') ?? '', origin).searchParams.get('commit'), task.proof.commit);
    await page.screenshot({ path: path.join(output, `route-${language}-${width}.png`), fullPage: true });

    phase = `human-decision-${language}-${width}`;
    await page.locator('[data-problem-select-decision="fixture-human-guidance"]').click();
    const decision = page.locator('[data-problem-decision-evidence="fixture-human-guidance"]'); await decision.waitFor();
    assert.match(await decision.locator('[data-decision-snapshot="before"]').innerText(), /justify the cancellation step/);
    assert.match(await decision.locator('[data-decision-snapshot="after"]').innerText(), /preceding reduction/);
    await page.waitForFunction(() => document.querySelector('[data-solution-node="task:goal_1"]')?.getAttribute('data-connected') === 'true');
    assert.equal(new URL(page.url()).searchParams.get('decision'), 'fixture-human-guidance');
    await clickTab('outcomes'); await page.reload(); await page.locator('.problem-table').waitFor();
    await clickTab('route'); await decision.waitFor(); assert.equal(new URL(page.url()).searchParams.get('decision'), 'fixture-human-guidance');
    await page.screenshot({ path: path.join(output, `human-decision-${language}-${width}.png`), fullPage: true });

    phase = `comparison-${language}-${width}`;
    await clickTab('compare'); await page.locator('[data-problem-compare]').selectOption(created[0].id);
    await page.locator('.problem-change[data-change=changed]').first().waitFor();
    assert.equal(await page.locator('.problem-comparison .solution-route').count(), 2);
    await page.locator('[data-problem-attempt-task-comparison]').waitFor();
    await page.locator('.problem-change').filter({ hasText: 'Unfold addition at zero' }).click();
    const waitForReductionInBoth = () => page.waitForFunction(() => {
      const headings = [...document.querySelectorAll('.problem-comparison [data-solution-heading]')];
      return headings.length === 2 && headings.every(item => item.textContent?.includes('Unfold addition'));
    });
    await waitForReductionInBoth();
    await page.locator('.problem-comparison [data-solution-node="decision:fixture-human-guidance"]').last().click();
    await page.locator('.problem-comparison [data-solution-heading="decision:fixture-human-guidance"]').waitFor();
    await page.locator('.problem-change').filter({ hasText: 'Unfold addition at zero' }).click();
    await waitForReductionInBoth();
    await page.screenshot({ path: path.join(output, `comparison-${language}-${width}.png`), fullPage: true });
    const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth })); assert.ok(layout.width <= layout.viewport + 1, JSON.stringify(layout));

    phase = `discussion-${language}-${width}`;
    await clickTab('discussion'); await page.locator('summary').filter({ hasText: conversation.title }).click();
    const messageLink = page.locator('.problem-message a'); assert.equal(new URL(await messageLink.getAttribute('href') ?? '', origin).searchParams.get('message'), conversation.messages[0].id);

    phase = `stages-${language}-${width}`;
    await clickTab('stages');
    const title = language === 'zh' ? '阶段名称' : 'Stage title', conclusion = language === 'zh' ? '已确认的结论' : 'Confirmed conclusion';
    await page.getByLabel(title, { exact: true }).fill('Reduction reviewed');
    await page.getByLabel(conclusion, { exact: true }).fill('Unfold $n+0$, then use reflexivity.'); await settled(page);
    await clickTab('route'); await clickTab('stages');
    assert.equal(await page.getByLabel(conclusion, { exact: true }).inputValue(), 'Unfold $n+0$, then use reflexivity.');
    await page.reload(); await page.getByLabel(title, { exact: true }).waitFor();
    assert.equal(await page.getByLabel(title, { exact: true }).inputValue(), 'Reduction reviewed');
    await page.locator('[data-problem-run]').selectOption(created[0].id); await page.getByLabel(title, { exact: true }).waitFor();
    assert.equal(await page.getByLabel(title, { exact: true }).inputValue(), '');
    await page.locator('[data-problem-run]').selectOption(selected.id); await page.getByLabel(title, { exact: true }).waitFor();
    assert.equal(await page.getByLabel(title, { exact: true }).inputValue(), 'Reduction reviewed');
    // A new saved observation changes the evidence while preserving the mathematical task version.
    const changed = structuredClone(service.jobs.get(owner, selected.id)!); changed.observation!.sequence++;
    changed.observation!.inspection.tasks.find(item => item.id === task.id)!.informalProof = 'An updated derivation after the draft was written.';
    service.storage.saveRun(owner, changed); Object.assign(service.jobs.get(owner, selected.id)!, changed);
    await page.reload(); const acknowledgement = page.getByRole('button', { name: language === 'zh' ? '已核对最新证据' : 'I reviewed the latest evidence', exact: true }); await acknowledgement.waitFor();
    const save = page.getByRole('button', { name: language === 'zh' ? '保存阶段结论' : 'Save stage conclusion', exact: true }); assert.ok(await save.isDisabled());
    await acknowledgement.click(); await save.click(); await page.locator('[data-stage-id]').waitFor();
    assert.equal(await page.getByLabel(title, { exact: true }).inputValue(), '');
    const frozen = page.locator('[data-stage-id]'); await frozen.locator('summary').click();
    await frozen.locator('.solution-route-detail').waitFor(); await page.screenshot({ path: path.join(output, `stage-${language}-${width}.png`), fullPage: true });
    const saved = await read(page, `/api/research/workspace/problem/${selected.id}`);
    assert.equal(saved.item.stages.length, 1); assert.equal(saved.item.stages[0].snapshot.tasks.find((item: { id: string }) => item.id === task.id).derivation, 'An updated derivation after the draft was written.');
    await page.reload(); await page.locator('[data-stage-id]').waitFor(); assert.equal(await page.getByLabel(title, { exact: true }).inputValue(), '');

    phase = `history-${language}-${width}`;
    await clickTab('overview'); await clickTab('route'); await page.goBack();
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'overview'); await page.getByRole('heading', { name: language === 'zh' ? '这道题研究到哪里了' : 'Where the research stands', exact: true }).waitFor();
    await page.goto(origin + '/problem.html'); await page.locator('[data-problem-run]').waitFor(); assert.equal(await page.locator('[data-problem-run]').inputValue(), selected.id);
    phase = `collaboration-${language}-${width}`;
    let project = service.research.projects.create(owner, { requestId: 'problem-project', title: 'A shared problem', visibility: 'members' });
    project = service.research.projects.addVersion(owner, project.id, { requestId: 'problem-version', expectedRevision: project.revision,
      statement: 'For each natural number, adding zero leaves it unchanged.', source: selected.source, environment: selected.environment });
    project = service.research.projects.bindRun(owner, project.id, { requestId: 'problem-binding', expectedRevision: project.revision,
      runId: selected.id, statementVersionId: project.versions[0].id });
    const currentObservation = service.jobs.get(owner, selected.id)!.observation!;
    const currentTarget = { runId: selected.id, statementVersionId: project.versions[0].id,
      observationRef: { sequence: currentObservation.sequence, stateDigest: currentObservation.snapshot.stateDigest }, taskRef: { id: task.id, version: task.version } };
    project = service.research.projects.assignTask(owner, project.id, { requestId: 'problem-human-claim', expectedRevision: project.revision, target: currentTarget, status: 'claimed' });
    const routeIssue = service.research.projects.createIssue(owner, project.id, { requestId: 'problem-route-issue', expectedRevision: project.revision,
      target: currentTarget, title: 'Review the cancellation argument', text: 'Check how this step connects to the final reflexive equality.' });
    for (let index = 0; index < 6; index++) service.research.projects.createIssue(owner, project.id, { requestId: `problem-extra-issue-${index}`,
      expectedRevision: service.research.projects.detail(owner, project.id).revision,
      target: currentTarget, title: `Additional recorded question ${index + 1}`, text: 'A separate open question about the saved argument.' });
    await page.goto(`${origin}/problem.html?${new URLSearchParams({ run: selected.id, project: project.id, tab: 'overview' })}`);
    const attentionIssue = page.locator(`[data-problem-attention-item="issue:${routeIssue.id}"]`); await attentionIssue.waitFor();
    assert.match(await attentionIssue.innerText(), /cancellation argument/);
    assert.equal(await page.locator('[data-problem-attention-item]').count(), 5);
    await page.locator('[data-problem-attention-expand]').click(); assert.equal(await page.locator('[data-problem-attention-item]').count(), 7);
    await page.locator('[data-problem-attention-expand]').click(); assert.equal(await page.locator('[data-problem-attention-item]').count(), 5);
    await page.screenshot({ path: path.join(output, `attention-${language}-${width}.png`), fullPage: true });
    await attentionIssue.locator('a.button').click(); await page.locator(`[data-collaboration-issue="${routeIssue.id}"]`).waitFor();
    await page.goto(origin + '/');
    const primaryEntry = page.locator(`[data-overview-open][href*="project=${project.id}"]`); await primaryEntry.waitFor();
    assert.equal(new URL(await primaryEntry.getAttribute('href') ?? '', origin).pathname, '/problem.html');
    await primaryEntry.click(); await page.locator('[data-problem-run]').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('project'), project.id);
    await page.goto(`${origin}/problem.html?${new URLSearchParams({ run: selected.id, project: project.id, tab: 'discussion', task: task.id, taskVersion: task.version, commit: task.proof.commit! })}`);
    await page.locator('[data-research-feedback-workspace]').waitFor();
    const discussion = page.getByLabel(language === 'zh' ? '讨论内容' : 'Discussion', { exact: true });
    await discussion.fill('A human review of the route: use $n=n$.'); await settled(page);
    await clickTab('route'); await clickTab('discussion');
    const restoreDiscussion = async () => { const drafts = page.locator('[data-discussion-composer] [data-human-drafts]');
      await drafts.locator('summary').click(); await drafts.locator('[data-restore-draft]').first().click(); };
    await restoreDiscussion();
    assert.equal(await discussion.inputValue(), 'A human review of the route: use $n=n$.');
    await page.reload(); await discussion.waitFor(); await restoreDiscussion(); assert.equal(await discussion.inputValue(), 'A human review of the route: use $n=n$.');
    await page.getByRole('button', { name: language === 'zh' ? '保存讨论' : 'Save discussion', exact: true }).click();
    await page.locator('.research-feedback-event').filter({ hasText: 'A human review of the route' }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('task'), task.id);
    await clickTab('stages'); await page.locator('[data-stage-id]').waitFor();
    assert.equal((await read(page, `/api/research/workspace/problem/${selected.id}?project=${project.id}`)).item.stages.length, 1);
    await page.screenshot({ path: path.join(output, `project-${language}-${width}.png`), fullPage: true });
    await context.close(); checks.push({ language, width, context: 'URL and history; exact version/commit; last view', comparison: 'two interactive graphs; task changes and full derivations; no overflow',
      humanDecision: 'explicit edit/task references; correct baseline and result derivations; current graph highlights; selection survives tabs/reload',
      draft: 'tab/reload recovery; run isolation; stale evidence acknowledgement; ordinary discussion recovery', stage: 'immutable snapshot; saved once; preserved after project attachment',
      entryAndAttention: 'My research primary opens problem; existing open issue links to its real discussion; five items by default and all seven expand/collapse', collaboration: 'unified page submits to the real feedback API' });
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0); assert.equal(runs, 8);
} catch (error) {
  failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(), phase, checks, errors, external, runs, prohibited,
    ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Problem workspace: ${checks.length} bilingual desktop/mobile workflows passed`);
