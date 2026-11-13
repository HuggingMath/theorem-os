#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { nextSteps, summarizeGoals } from '../apps/web/report';
import type { WebRunner } from '../apps/web/runner';
import { loadWebSample } from '../apps/web/sample';
import { createWebService } from '../apps/web/server';
import type { StoredWebArchive } from '../apps/web/storage';
import type { WebRunInput, WorkerInput } from '../apps/web/shared';
import { closeSettings, openRunMenu, showArtifacts, showChat } from './web-ui-controls';
import { freePort, postRun, readRun, ready, settled, startBrowser, waitForRun, webScenario, writeScenarioReport,
  type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-ui-smoke');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the continuation/archive check.'); });
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-continuation-archive-'));
const sample = loadWebSample()!;
const source = 'import Std\n\nnamespace Tutorial\n\ntheorem zero_add (n : Nat) : 0 + n = n := by\n  sorry\n\nend Tutorial';
const credential = `sk-continuation-archive-fixture-${crypto.randomUUID()}`;
const starts: WorkerInput[] = [];
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable continuation/archive fixture' }; },
  async run(input, send) {
    starts.push(input);
    if (input.continuation) {
      send({ type: 'result', result: { status: 'incomplete', proof: input.continuation.source, report: {} } });
      return;
    }
    // The first original goal is now a checked helper; the remaining original goal is open.
    for (const original of sample.observations.slice(0, 4)) {
      const observation = structuredClone(original);
      observation.webRunId = input.id;
      observation.solverRunId = `fixture-${input.id}`;
      observation.snapshot.runId = observation.inspection.runId = observation.inspection.snapshot.runId = observation.solverRunId;
      observation.inspection.problem.targets = observation.inspection.problem.targets.filter(item => item.theoremName === 'Tutorial.zero_add');
      observation.inspection.problem.statement = 'Prove zero_add using the checked add_zero helper.';
      observation.inspection.problem.formalStatement = source;
      observation.inspection.tasks.find(task => task.id === 'goal_1')!.kind = 'lemma';
      if (observation.plan) observation.plan.tasks.find(task => task.id === 'goal_1')!.kind = 'lemma';
      observation.inspection.mathematics.snapshot.goals = observation.inspection.mathematics.snapshot.goals.filter(item => item.taskId === 'goal_2');
      send({ type: 'observation', observation });
    }
    const firstCheck = sample.events.findIndex(event => event.type === 'task_recheck_finished');
    for (const event of sample.events.slice(0, firstCheck + 1))
      send({ type: 'progress', event: event.type, message: event.message, ...(event.details ? { details: event.details } : {}) });
    const { sequence: _sequence, at: _at, ...action } = sample.actions![0]!;
    send({ type: 'action', action });
    for (let index = 0; index < 205; index++) send({ type: 'progress', event: 'fixture_progress', message: `Saved fixture event ${index}` });
    send({ type: 'result', result: { status: 'limit_reached', proof: '', report: {
      status: 'limit_reached', reason: 'math_run_stopped', failure: { kind: 'time_limit', reason: 'math_run_stopped' } } } });
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_AUTH: 'none' }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const reportFile = path.join(output, 'continuation-archive-report.json');
let archiveSummary: StoredWebArchive['summary'] | undefined;
const input: WebRunInput = { providerId: 'openai', apiKey: credential, model: 'fixture', effort: 'low', environment: 'standard',
  source, task: 'Continue the checked helper while the original goal remains open', maxTurns: 2, maxRunSeconds: 60,
  workers: 2, coordination: 'cooperative' };

async function download(page: Page, selector: string) {
  const pending = page.waitForEvent('download');
  await page.locator(selector).click();
  const file = await pending, bytes = await fs.readFile((await file.path())!);
  assert.equal(bytes.includes(Buffer.from(credential)), false, 'download does not contain the disposable key');
  return { filename: file.suggestedFilename(), bytes, body: JSON.parse(bytes.toString('utf8')) };
}
async function continuationNotice(page: Page) {
  await page.locator('#run-settings[open]').waitFor();
  const notice = page.locator('#settings-continuation');
  assert.match(await notice.innerText(), /带入成果：add_zero/u);
  assert.match(await notice.innerText(), /重新通过 Lean 检查与独立验收/u);
  const visible = await notice.evaluate(node => {
    const box = node.getBoundingClientRect(), pane = node.closest('.settings-content')!.getBoundingClientRect();
    return box.top >= pane.top && box.bottom <= pane.bottom;
  });
  assert.equal(visible, true, 'the carried result and fresh-check notice are visible in configuration');
  assert.equal(await page.locator('#source').inputValue(), source, 'the original problem stays frozen');
  assert.equal(await page.locator('#api-key').inputValue(), '');
  assert.equal(starts.length, 1, 'opening continuation does not start another worker');
}

try {
  await webScenario(browser, suite, 'Checked helper continuation and complete retained research downloads', async h => {
    const { page, context } = h;
    const created = await postRun(h, input);
    const run = await waitForRun(h, created.id, item => item.status === 'completed');
    const goals = summarizeGoals(run)!;
    assert.deepEqual(goals.goals.map(goal => goal.state), ['open']);
    assert.equal(goals.goals[0]!.subgoals[0]!.state, 'proved');
    assert.ok(nextSteps(run, goals).some(step => step.id === 'continue-checked' && step.tasks.includes('goal_1')));
    const helper = run.observation!.inspection.tasks.find(task => task.id === 'goal_1')!;
    const checkedSource = run.observation!.sources.find(item => item.taskId === helper.id && item.commit === helper.proof.commit)!;
    assert.equal(helper.proof.status, 'checked'); assert.ok(checkedSource);
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    service.storage.saveCommand(owner, run.id, 'fixture-guidance', { id: 'fixture-guidance', status: 'delivered' });

    await page.goto(`${origin}/?run=${run.id}`); await ready(page);
    await page.locator('[data-chat-recovery="continue-checked"]').waitFor();
    const downloaded = await download(page, `.chat-task-actions a[href="/api/runs/${run.id}/download"]`);
    const archive = downloaded.body as StoredWebArchive;
    assert.equal(downloaded.filename, `theoremos-${run.id}.json`);
    assert.equal(archive.schema, 'theorem-os.web-archive.v1');
    assert.ok(archive.events.length > 200); assert.equal(archive.events[0]!.sequence, 1);
    assert.equal(archive.observations.length, 4); assert.equal(archive.actions!.length, 1);
    assert.ok(archive.sources.length > 0); assert.ok(archive.checks.length > 0);
    assert.deepEqual(archive.commands, [{ id: 'fixture-guidance', status: 'delivered' }]);
    assert.deepEqual(archive.summary.coverage, { events: 'complete', observations: 'complete', actions: 'complete',
      commands: 'recorded', sources: 'partial', checks: 'partial' });
    assert.equal(archive.summary.requiresFreshCheck, true);
    assert.equal(archive.summary.evidence, 'recorded-not-replayed');
    archiveSummary = archive.summary;
    await fs.writeFile(path.join(output, 'continuation-helper-archive.json'), downloaded.bytes);
    assert.equal((await readRun(h, run.id)).archives, undefined, 'download does not add a saved archive');
    await page.screenshot({ path: path.join(output, 'continuation-helper-chat.png') });

    await showArtifacts(page); await page.locator('#detail-tab-result').click();
    await page.locator('#detail-panel [data-recovery="continue-checked"]').waitFor();
    await openRunMenu(page);
    assert.equal(await page.locator('[data-action="download-run"]').innerText(), '下载完整研究归档');
    assert.equal(await page.locator('[data-action="download-snapshot"]').innerText(), '下载运行快照');
    const snapshot = await download(page, '[data-action="download-snapshot"]');
    assert.equal(snapshot.filename, `theoremos-${run.id}-snapshot.json`);
    assert.equal(snapshot.body.schema, 'theorem-os.web-export.v1');
    assert.equal(snapshot.body.run.events.length, 200); assert.equal(snapshot.body.actions, undefined);
    await fs.writeFile(path.join(output, 'continuation-helper-snapshot.json'), snapshot.bytes);
    await page.locator('[data-run-menu] > summary').click();
    await page.locator('#detail-panel [data-recovery="continue-checked"]').click();
    await continuationNotice(page);
    await page.screenshot({ path: path.join(output, 'continuation-helper-settings.png') });
    await closeSettings(page);

    // Reopen the original chat and exercise its own direct continuation entry, then explicitly submit.
    await page.goto(`${origin}/?run=${run.id}`); await ready(page);
    await page.locator('[data-chat-recovery="continue-checked"]').click();
    await continuationNotice(page);
    await page.setViewportSize({ width: 375, height: 812 }); await settled(page);
    await continuationNotice(page);
    await page.screenshot({ path: path.join(output, 'continuation-helper-settings-375.png') });
    await page.locator('#api-key').fill(credential);
    await page.locator('#settings-submit').click();
    await page.locator('body[data-view="run"]').waitFor({ state: 'attached' });
    assert.equal(starts.length, 2);
    assert.equal(starts[1]!.input.source, source);
    assert.deepEqual(starts[1]!.continuation, { runId: run.id, taskId: helper.id, commit: helper.proof.commit,
      label: starts[1]!.continuation!.label, taskVersion: archive.sources.find(item => item.taskId === helper.id && item.commit === helper.proof.commit)!.taskVersion, sourceDigest: checkedSource.sourceDigest,
      environmentDigest: checkedSource.environmentDigest, file: checkedSource.file, source: checkedSource.source });
    assert.match(starts[1]!.continuation!.label, /add_zero/u);
    const continued = await waitForRun(h, starts[1]!.id, item => item.status === 'completed');
    assert.equal(continued.result!.status, 'incomplete', 'carrying a checked result does not grant acceptance');
    assert.equal((await readRun(h, run.id)).source, source);
    await showArtifacts(page);
    assert.match(await page.locator('[data-run-continuation]').innerText(), /仍要重新通过 Lean 检查/u);

    // A full research archive remains a draft import; it never restores server history or an attached result.
    await page.setViewportSize({ width: 1440, height: 900 });
    await showChat(page);
    const pending = page.waitForEvent('filechooser'); await page.locator('#import-task').click();
    await (await pending).setFiles({ name: downloaded.filename, mimeType: 'application/json', buffer: downloaded.bytes });
    await page.locator('#import-task-dialog[open]').waitFor();
    assert.equal(await page.locator('#import-source-preview').textContent(), source);
    assert.match(await page.locator('#import-description').innerText(), /不恢复历史运行/u);
    await page.locator('#confirm-import').click(); await page.locator('#import-task-dialog[open]').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#source').inputValue(), source);
    assert.equal(await page.locator('#draft-continuation').isHidden(), true);
    assert.equal(await page.locator('#api-key').inputValue(), '');
    assert.equal(starts.length, 2);
    assert.equal((await page.evaluate(async () => (await (await fetch('/api/runs')).json()).runs)).length, 2);
  }, {
    context: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' },
    harness: (page, context) => ({ page, context, requests: [] }), routes: { local: 'All requests stay on the disposable loopback service' },
    open: async h => { await h.page.goto(origin); await ready(h.page); }, timeout: { label: 'Continuation/archive', seconds: 45 },
    failure: { prefix: 'continuation-archive-' },
  });
  await writeScenarioReport(reportFile, suite, 'passed', undefined,
    'Local HTTP service, Chromium and recorded fixture checks. No model, Lean or production job was called.',
    { workerStarts: starts.length, archive: archiveSummary, checks: suite.checks }, { credential });
} catch (error) {
  await writeScenarioReport(reportFile, suite, 'failed', error,
    'Local HTTP service, Chromium and recorded fixture checks. No model, Lean or production job was called.',
    { workerStarts: starts.length, archive: archiveSummary, checks: suite.checks }, { credential, failureRequests: true });
  throw error;
} finally {
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
