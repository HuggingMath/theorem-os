#!/usr/bin/env bun
// Disposable recorded fixtures only: no model, Lean, email or production service.
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
import type { ResearchJourney } from '../apps/web/researchJourneyTypes';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-four/workspace');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-journey-ui-'));
const sample = loadWebSample()!, port = await freePort(), origin = `http://127.0.0.1:${port}`;
let runCount = 0, prohibited = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable recorded fixture' }; },
  async run(input, send) {
    runCount++;
    const observation = structuredClone(sample.observations.at(-1)!); observation.webRunId = input.id; observation.sequence = 1;
    observation.snapshot.stateDigest = mathDigest(`journey-fixture:${input.id}`); observation.guidance = []; observation.inspection.edits = [];
    const source = observation.sources.find(source => observation.inspection.tasks.some(task => task.id === source.taskId && task.version === source.taskVersion
      && task.proof.commit === source.commit && task.proof.sourceDigest === source.sourceDigest))!;
    const task = observation.inspection.tasks.find(task => task.id === source.taskId)!;
    // Keep this fixture's continuation source unambiguous. The unit suite separately covers
    // historical captures that reuse a commit under multiple task versions.
    observation.sources = observation.sources.filter(item => item.taskId !== source.taskId || item.commit !== source.commit || item.taskVersion === source.taskVersion);
    task.informalStatement = 'For natural numbers $n$, prove $n+0=n$.';
    task.informalProof = 'Unfold the zero case of addition. The remaining goal is $n=n$, which reflexivity proves.';
    const reduction = structuredClone(task); reduction.id = 'journey-reduction'; reduction.kind = 'research'; reduction.theorem = undefined;
    reduction.version = 'journey-reduction-version'; reduction.objective = 'Reduce addition at zero'; reduction.plannedDependencies = [];
    reduction.informalProof = 'The defining equation of addition gives $n+0=n$. Substitute this into the closing equality.';
    reduction.finding = 'The next step is the reflexive equality $n=n$.'; reduction.proof = { status: 'not-started' }; reduction.status = 'completed';
    task.plannedDependencies = [reduction.id]; observation.inspection.tasks.unshift(reduction);
    send({ type: 'observation', observation });
    send({ type: 'result', result: { status: input.input.task === 'Continued branch' ? 'evaluated_passed' : 'limit_reached',
      proof: sample.run.result!.proof, report: { usage: { totalTokens: 1000 } } } });
  },
  async check() { prohibited++; throw new Error('No Lean in journey UI check'); },
  async formalize() { prohibited++; throw new Error('No models in journey UI check'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_CLIENT_IP_HEADER: 'x-fixture-scenario', THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner,
{ mailer: async () => { prohibited++; throw new Error('No mail in journey UI check'); } });
const browser = await startBrowser(service.server, port), errors: string[] = [], external: string[] = [], checks: object[] = [];
let phase = 'setup', active: Page | undefined, failure: unknown;
const read = <T>(page: Page, pathname: string) => page.evaluate(async pathname => {
  const response = await fetch(pathname), value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
}, pathname) as Promise<T>;
try {
  for (const language of ['zh', 'en'] as const) for (const width of [1440, 390]) {
    phase = `setup-${language}-${width}`;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce',
      extraHTTPHeaders: { 'x-fixture-scenario': `${language}-${width}` } });
    await context.addInitScript(({ key, language }) => localStorage.setItem(key, language), { key: localeStorageKey, language });
    await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(12_000); page.on('pageerror', error => errors.push(error.message));
    const responses: { path: string; status: number }[] = [];
    page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/research/workspace/problem/')) responses.push({ path: url.pathname + url.search, status: response.status() }); });
    await page.goto(origin + '/problem.html'); await page.locator('[data-problem-page]').waitFor();
    const owner = (await context.cookies(origin)).find(item => item.name === 'theoremos_session')!.value;
    const provider = (await read<{ providers: { id: string }[] }>(page, '/api/session')).providers[0];
    const input = { providerId: provider.id, apiKey: 'sk-fixture-never-sent', model: 'fixture-model', effort: 'high' as const,
      environment: sample.run.environment, source: sample.run.source.trim(), maxTurns: 2, maxRunSeconds: 60, maxTotalTokens: 10000, workers: 2, coordination: 'cooperative' as const };
    const parent = service.jobs.create(owner, { ...input, task: 'Project parent' }, provider as never);
    const sibling = service.jobs.create(owner, { ...input, task: 'Project sibling' }, provider as never);
    await page.waitForFunction(async () => { const { runs } = await (await fetch('/api/runs')).json(); return runs.length === 2 && runs.every((run: WebRun) => run.status === 'completed'); });
    const inherited = service.jobs.get(owner, parent.id)!.observation!.sources.find(source => service.jobs.get(owner, parent.id)!.observation!.inspection.tasks.some(task => task.id === source.taskId && task.version === source.taskVersion && task.proof.commit === source.commit))!;
    const child = service.jobs.create(owner, { ...input, task: 'Continued branch', continueFrom: { runId: parent.id, taskId: inherited.taskId, commit: inherited.commit, label: 'Continue here' } }, provider as never);
    await page.waitForFunction(async () => { const { runs } = await (await fetch('/api/runs')).json(); return runs.length === 3 && runs.every((run: WebRun) => run.status === 'completed'); });
    let project = service.research.projects.create(owner, { requestId: 'navigation-project', title: 'Version and continuation evidence', visibility: 'members' });
    project = service.research.projects.addVersion(owner, project.id, { requestId: 'navigation-v1', expectedRevision: project.revision, statement: 'Addition at zero', source: input.source, environment: input.environment });
    for (const run of [parent, sibling]) project = service.research.projects.bindRun(owner, project.id, { requestId: `bind-${run.id}`, expectedRevision: project.revision, runId: run.id, statementVersionId: project.versions[0].id });
    const address = `${origin}/problem.html?${new URLSearchParams({ run: parent.id, project: project.id, tab: 'route', map: 'global', lang: language })}`;
    const journey = (await read<{ item: ResearchJourney }>(page, `/api/research/workspace/problem/${parent.id}/journey?project=${project.id}`)).item;
    assert.equal(journey.attempts.find(item => item.id === child.id)?.projectId, undefined);
    const choose = async (run: WebRun) => { await page.locator(`[data-journey-attempt="${run.id}"]`).click(); await page.locator(`[data-journey-attempt-detail="${run.id}"]`).waitFor(); assert.equal(await page.locator('[data-problem-run]').inputValue(), run.id); };
    const assertFit = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `horizontal overflow ${language}-${width}`);
    phase = `project-bound-control-${language}-${width}`;
    await page.goto(address); await page.locator(`[data-journey-attempt="${sibling.id}"]`).waitFor(); await choose(sibling);
    assert.equal(new URL(page.url()).searchParams.get('project'), project.id);
    await page.screenshot({ path: path.join(output, `project-bound-switch-${language}-${width}.png`), fullPage: true });
    phase = `project-to-personal-${language}-${width}`;
    await choose(child); assert.equal(new URL(page.url()).searchParams.has('project'), false);
    const personalAddress = page.url(); await assertFit();
    assert.equal(service.research.projects.detail(owner, project.id).runs.length, 2, 'Navigation never auto-shares a personal continuation');
    await page.screenshot({ path: path.join(output, `personal-continuation-switch-${language}-${width}.png`), fullPage: true });
    await page.reload(); await page.locator(`[data-journey-attempt-detail="${child.id}"]`).waitFor(); assert.equal(await page.locator('[data-problem-run]').inputValue(), child.id);
    await choose(parent); assert.equal(new URL(page.url()).searchParams.get('project'), project.id, 'Returning to a bound attempt restores its own project');
    checks.push({ id: 'W1-attempt-selection-keeps-target-context', language, width, boundRun: sibling.id, personalRun: child.id, personalAddress, returnsToProject: true, retainedAfterReload: true, autoShared: false });

    phase = `historical-cross-run-task-${language}-${width}`;
    const moment = service.jobs.get(owner, parent.id)!.observation!;
    const historicAddress = address + `&at=${moment.sequence}&atState=${moment.snapshot.stateDigest}&compare=${sibling.id}`;
    await page.goto(historicAddress); await page.locator('[data-evolution-selected]').waitFor();
    assert.equal(await page.locator('[data-problem-route-history]').evaluate(node => (node as HTMLDetailsElement).open), true,
      'a historical deep link opens its saved-moment controls automatically');
    await page.locator('[data-journey-expand-all]').click();
    const parentTask = journey.attempts.find(item => item.id === parent.id)!.tasks.find(item => item.task.id === inherited.taskId)!.task;
    await page.locator(`[data-solution-node="journey-task:${encodeURIComponent(parent.id)}:${encodeURIComponent(parentTask.id)}"]`).click();
    await page.locator(`[data-journey-task-detail="${parentTask.id}"]`).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('atState'), moment.snapshot.stateDigest, 'Reading another step in the same historical attempt preserves its moment');
    const childTask = journey.attempts.find(item => item.id === child.id)!.tasks.find(item => item.task.id === inherited.taskId)!.task;
    await page.locator(`[data-solution-node="journey-task:${encodeURIComponent(child.id)}:${encodeURIComponent(childTask.id)}"]`).click();
    await page.locator(`[data-journey-task-detail="${childTask.id}"]`).waitFor();
    const taskUrl = new URL(page.url());
    assert.equal(await page.locator('[data-problem-run]').inputValue(), child.id); assert.equal(taskUrl.searchParams.has('project'), false);
    assert.equal(taskUrl.searchParams.has('at'), false); assert.equal(taskUrl.searchParams.has('atState'), false); assert.equal(taskUrl.searchParams.has('compare'), false);
    assert.equal(taskUrl.searchParams.get('task'), childTask.id); assert.equal(taskUrl.searchParams.get('taskVersion'), childTask.version); assert.equal(taskUrl.searchParams.get('commit'), childTask.commit);
    await assertFit(); await page.screenshot({ path: path.join(output, `cross-run-task-${language}-${width}.png`), fullPage: true });
    checks.push({ id: 'W1-cross-run-task-preserves-fixed-version-and-clears-old-context', language, width, address: page.url(), taskVersion: childTask.version, commit: childTask.commit, sameRunHistoryPreserved: true, crossRunHistoryCleared: true });

    phase = `verified-old-version-control-${language}-${width}`;
    project = service.research.projects.bindRun(owner, project.id, { requestId: 'attach-accepted-control', expectedRevision: project.revision, runId: child.id, statementVersionId: project.versions[0].id });
    await page.goto(origin + '/'); await page.locator('[data-chat-research-overview] > summary').click(); await page.locator(`[data-overview-card="project:${project.id}"]`).waitFor();
    const filter = page.locator('[data-overview-filter=passed]'); assert.equal(await filter.innerText(), language === 'zh' ? '有通过记录' : 'Has verified runs'); await filter.click();
    const card = page.locator(`[data-overview-card="project:${project.id}"]`); await card.locator(`[data-overview-verified-run="${child.id}"]`).waitFor();
    assert.match(await card.locator('[data-overview-verified]').innerText(), /v1/);
    const oldControl = await card.innerText();
    const currentSource = input.source + '\n\n-- A new statement version\ntheorem audit_requirement : True := by trivial';
    const current = service.jobs.create(owner, { ...input, source: currentSource, task: 'Current statement not accepted' }, provider as never);
    await page.waitForFunction(async () => { const { runs } = await (await fetch('/api/runs')).json(); return runs.length === 4 && runs.every((run: WebRun) => run.status === 'completed'); });
    project = service.research.projects.addVersion(owner, project.id, { requestId: 'navigation-v2', expectedRevision: project.revision, statement: 'Additional theorem required', source: currentSource, environment: input.environment });
    project = service.research.projects.bindRun(owner, project.id, { requestId: 'bind-current-version', expectedRevision: project.revision, runId: current.id, statementVersionId: project.versions[1].id });
    phase = `verified-record-and-current-state-${language}-${width}`;
    await page.goto(origin + '/'); await page.locator('[data-chat-research-overview] > summary').click(); await page.locator(`[data-overview-progress="${current.id}"]`).waitFor(); await page.locator('[data-overview-filter=passed]').click();
    const acceptedLink = card.locator(`[data-overview-verified-run="${child.id}"]`); await acceptedLink.waitFor();
    assert.equal(await acceptedLink.innerText(), language === 'zh' ? '陈述 v1 · 完整原题通过 →' : 'Statement v1 · Original problem accepted →');
    assert.equal(await card.locator('[data-overview-verified-run]').count(), 1); assert.equal(await card.locator(`[data-overview-verified-run="${current.id}"]`).count(), 0);
    assert.match(await card.locator(`[data-overview-run-status="${current.id}"]`).innerText(), language === 'zh' ? /最新尝试/ : /Latest attempt/);
    const acceptedHref = new URL((await acceptedLink.getAttribute('href'))!, origin), latestHref = new URL((await card.locator('[data-overview-open]').getAttribute('href'))!, origin);
    assert.equal(acceptedHref.searchParams.get('run'), child.id); assert.equal(acceptedHref.searchParams.get('project'), project.id); assert.equal(latestHref.searchParams.get('run'), current.id);
    await assertFit(); await page.screenshot({ path: path.join(output, `historical-verified-current-unaccepted-${language}-${width}.png`), fullPage: true });
    const recordText = await card.innerText();
    await acceptedLink.click(); await page.locator('[data-problem-run]').waitFor(); assert.equal(await page.locator('[data-problem-run]').inputValue(), child.id);
    assert.equal((await read<{ item: { brief: { accepted: boolean } } }>(page, `/api/research/workspace/problem/${child.id}?project=${project.id}`)).item.brief.accepted, true);
    assert.equal(service.research.projects.detail(owner, project.id).runs.length, 4);
    checks.push({ id: 'W2-verified-record-names-old-version-and-opens-its-accepted-run', language, width, normalControl: oldControl, cardText: recordText,
      acceptedRun: child.id, currentUnacceptedRun: current.id, acceptedHref: acceptedHref.pathname + acceptedHref.search, latestHref: latestHref.pathname + latestHref.search, currentRunStatus: service.jobs.get(owner, current.id)!.result!.status });
    assert.deepEqual(responses.filter(item => item.status >= 400), [], 'All workspace reads use their target context');
    await context.close(); active = undefined;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0); assert.equal(runCount, 16);
} catch (error) {
  failure = error;
  if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, errors, external, prohibited, recordedRuns: runCount,
    realModelCalls: 0, realLeanCalls: 0, mailCalls: 0, build: JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8')), ...(failure ? { error: String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }));
