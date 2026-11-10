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
import type { ResearchJourney, ResearchUnreadChanges } from '../apps/web/researchJourneyTypes';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/product-continuity/research-depth/journey');
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
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner,
{ mailer: async () => { prohibited++; throw new Error('No mail in journey UI check'); } });
const browser = await startBrowser(service.server, port), errors: string[] = [], external: string[] = [], checks: object[] = [];
let phase = 'setup', active: Page | undefined, failure: unknown;
const read = <T>(page: Page, pathname: string) => page.evaluate(async pathname => {
  const response = await fetch(pathname), value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
}, pathname) as Promise<T>;
try {
  for (const language of ['zh', 'en'] as const) for (const width of [1440, 390]) {
    phase = `${language}-${width}`;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: language === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce' });
    await context.addInitScript(({ key, language }) => localStorage.setItem(key, language), { key: localeStorageKey, language });
    await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/problem.html'); await page.locator('[data-problem-page]').waitFor();
    const owner = (await context.cookies(origin)).find(item => item.name === 'theoremos_session')!.value;
    const provider = (await read<{ providers: { id: string }[] }>(page, '/api/session')).providers[0];
    const input = { providerId: provider.id, apiKey: 'sk-fixture-never-sent', model: 'fixture-model', effort: 'high' as const, environment: sample.run.environment,
      source: sample.run.source.trim(), maxTurns: 2, maxRunSeconds: 60, maxTotalTokens: 10000, workers: 2, coordination: 'cooperative' as const };
    const parent = service.jobs.create(owner, { ...input, task: 'Parent branch' }, provider as never);
    const independent = service.jobs.create(owner, { ...input, task: 'Independent branch' }, provider as never);
    await page.waitForFunction(async () => { const { runs } = await (await fetch('/api/runs')).json(); return runs.length === 2 && runs.every((run: WebRun) => run.status === 'completed'); });
    const savedParent = service.jobs.get(owner, parent.id)!, observation = savedParent.observation!;
    const inherited = observation.sources.find(source => observation.inspection.tasks.some(task => task.id === source.taskId && task.version === source.taskVersion
      && task.proof.commit === source.commit && task.proof.sourceDigest === source.sourceDigest))!;
    const child = service.jobs.create(owner, { ...input, task: 'Continued branch', continueFrom: { runId: parent.id, taskId: inherited.taskId, commit: inherited.commit, label: 'Continue here' } }, provider as never);
    await page.waitForFunction(async () => { const { runs } = await (await fetch('/api/runs')).json(); return runs.length === 3 && runs.every((run: WebRun) => run.status === 'completed'); });
    const endpoint = `/api/research/workspace/problem/${parent.id}`;
    const journey = (await read<{ item: ResearchJourney }>(page, endpoint + '/journey')).item;
    assert.equal(journey.attempts.length, 3); assert.equal(journey.lineage.length, 1); assert.equal(journey.lineage[0].status, 'recorded');
    assert.equal(journey.lineage[0].fromRunId, parent.id); assert.equal(journey.lineage[0].toRunId, child.id);
    assert.equal(journey.lineage.some(edge => edge.fromRunId === independent.id || edge.toRunId === independent.id), false);
    await page.goto(`${origin}/problem.html?run=${parent.id}&tab=overview`);
    await page.locator('[data-research-changes] .research-empty').waitFor();
    assert.equal(await page.locator('[data-research-change]').count(), 0);
    await page.locator('.problem-tabs a[href*="tab=route"]').click(); await page.locator('[data-problem-map=global]').click(); await page.locator('[data-research-journey]').waitFor();
    const view = page.locator('[data-research-journey]');
    await page.waitForFunction(() => document.querySelectorAll('[data-research-journey] [data-journey-attempt]').length === 3);
    assert.equal(await view.locator('[data-journey-attempt]').count(), 3);
    const childButton = view.locator(`[data-journey-attempt="${child.id}"]`); await childButton.focus(); await page.keyboard.press('Enter');
    await view.locator(`[data-journey-attempt-detail="${child.id}"]`).waitFor();
    await view.locator('[data-journey-lineage=recorded] button').click(); await view.locator('[data-journey-source-reader] pre').first().waitFor();
    assert.ok((await view.locator('[data-journey-source-reader] pre').first().innerText()).includes(inherited.source.trim()));
    assert.ok((await view.locator('.journey-identity').innerText()).includes(inherited.taskVersion));
    await view.locator('[data-journey-source-reader] > header button').click();
    const parentButton = view.locator(`[data-journey-attempt="${parent.id}"]`); await parentButton.focus(); await page.keyboard.press('Enter');
    await view.locator(`[data-journey-attempt-detail="${parent.id}"]`).waitFor();
    const proofButton = view.locator(`[data-journey-task="${inherited.taskId}"]`); await proofButton.focus(); await page.keyboard.press('Enter');
    await view.locator(`[data-journey-task-detail="${inherited.taskId}"]`).waitFor();
    assert.match(await view.locator('.journey-task-detail').innerText(), /Unfold the zero case/);
    const participate = new URL((await view.locator('[data-journey-participate]').getAttribute('href'))!, origin);
    assert.equal(participate.searchParams.get('run'), parent.id); assert.equal(participate.searchParams.get('task'), inherited.taskId);
    assert.equal(participate.searchParams.get('taskVersion'), inherited.taskVersion); assert.equal(participate.searchParams.get('commit'), inherited.commit);
    await view.locator('.journey-connections button').first().click();
    await view.locator('[data-journey-task-detail="journey-reduction"]').waitFor();
    assert.match(await view.locator('.journey-task-detail').innerText(), /defining equation of addition/);
    await view.locator('.journey-connections button').first().click();
    await view.locator(`[data-journey-task-detail="${inherited.taskId}"]`).waitFor();
    await view.locator('[data-journey-open-source]').click(); await view.locator('[data-journey-source-reader] pre').first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-research-journey] .katex').length > 0);
    await view.locator('[data-journey-source-reader] > header button').click();
    await view.locator('[data-journey-expand-all]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-research-journey] [data-solution-node^="journey-task:"]').length > 3);
    await page.screenshot({ path: path.join(output, `journey-${language}-${width}.png`), fullPage: true });
    const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    assert.ok(layout.width <= layout.viewport + 1, JSON.stringify(layout));

    phase = `changes-${language}-${width}`;
    const updated = structuredClone(savedParent.observation!); updated.sequence++; updated.snapshot.stateDigest = mathDigest(`later:${savedParent.id}`);
    updated.inspection.tasks.find(task => task.id === inherited.taskId)!.informalProof = 'Use cancellation after substituting the preceding equality. This is the updated derivation.';
    updated.checks.push({ ...updated.checks[0], id: 'journey-new-check', record: { passed: false, reason: 'A premise is missing.' } });
    updated.guidance.push({ id: 'journey-human-guidance', recipient: { kind: 'task', id: inherited.taskId }, taskRef: { id: inherited.taskId, version: inherited.taskVersion },
      text: 'Record the cancellation argument.', observationRef: { sequence: savedParent.observation!.sequence, stateDigest: savedParent.observation!.snapshot.stateDigest },
      status: 'delivered', createdAt: savedParent.createdAt, updatedAt: savedParent.updatedAt });
    savedParent.observation = updated; service.storage.saveObservation(owner, updated); service.storage.saveRun(owner, savedParent);
    await page.locator('.problem-tabs a[href*="tab=overview"]').click(); await page.locator('[data-research-change=task]').first().waitFor();
    const changes = (await read<{ item: ResearchUnreadChanges }>(page, endpoint + '/changes')).item;
    assert.ok(changes.counts.task > 0); assert.equal(changes.counts.check, 1); assert.equal(changes.counts.human, 1);
    const taskChange = page.locator('[data-research-change=task]').filter({ has: page.locator('a') }).first();
    await taskChange.locator('[data-research-change-link]').first().click(); await page.locator('[data-research-change-record] h4').waitFor();
    assert.match(await page.locator('[data-research-change-record]').innerText(), /Unfold the zero case/);
    const exactLink = await taskChange.locator('[data-research-change-link]').last().getAttribute('href');
    await page.goto(new URL(exactLink!, origin).href); await page.locator('[data-research-change-record]').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-research-change-record]')?.textContent?.includes('updated derivation'));
    await page.screenshot({ path: path.join(output, `changes-${language}-${width}.png`), fullPage: true });
    await page.locator('[data-research-mark-read]').click();
    await page.waitForFunction(() => document.querySelector('[data-research-changes]') && document.querySelectorAll('[data-research-change]').length === 0);
    assert.equal((await read<{ item: ResearchUnreadChanges }>(page, endpoint + '/changes')).item.changes.length, 0);
    const compact = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    assert.ok(compact.width <= compact.viewport + 1, JSON.stringify(compact));
    checks.push({ language, width, attempts: 3, inheritance: 1, taskChanges: changes.counts.task, checkChanges: 1, humanChanges: 1,
      keyboard: true, exactSource: true, firstVisitEmpty: true, deepLink: true, markRead: true });
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0); assert.equal(runCount, 12);
} catch (error) {
  failure = error;
  if (active && !active.isClosed()) { await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); await fs.writeFile(path.join(output, 'failure.html'), await active.content()); }
} finally {
  await browser.close(); await service.jobs.close(); await service.formalizations.close(); await service.explanations.close(); await service.research.assets.close();
  await new Promise<void>(resolve => service.server.close(() => resolve())); await fs.rm(dataRoot, { recursive: true, force: true });
}
await fs.writeFile(path.join(output, 'checks.json'), JSON.stringify({ passed: !failure, phase, checks, errors, external, prohibited, runCount }, null, 2));
if (failure) throw failure;
console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
