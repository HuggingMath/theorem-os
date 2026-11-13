#!/usr/bin/env bun
// Disposable loopback service with two recorded observations; no model, Lean, mail or production data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebRun } from '../apps/web/shared';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readingEnvironment, readingRun } from '../tests/helpers/shareReadingFixture';
import { freePort, startBrowser, preferFullCollaboration } from './web-scenario';
import { openProblemHistory } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/research-closure/run-continuity');
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-run-continuity-')), port = await freePort(), origin = `http://127.0.0.1:${port}`;
await fs.mkdir(output, { recursive: true });
const firstDigest = mathDigest('run-continuity-first'), secondDigest = mathDigest('run-continuity-second');
const fixtures = new Map<string, { first: WebRun; second: WebRun }>();
let workers = 0, prechecks = 0, prohibited = 0;
function records(id: string) {
  const first = readingRun(id), before = first.observation!;
  before.sequence = 1; before.snapshot.stateDigest = firstDigest; before.observedAt = '2026-11-10T01:00:00Z';
  before.inspection.configuration.environmentDigest = readingEnvironment; before.inspection.planVersion = 'plan-1';
  before.guidance = []; before.inspection.edits = []; before.inspection.planApproval = undefined;
  for (const check of before.checks) check.record = { passed: true };
  const second = structuredClone(first), after = second.observation!, task = after.inspection.tasks[0];
  after.sequence = 2; after.snapshot.stateDigest = secondDigest; after.observedAt = '2026-11-10T01:02:00Z';
  after.inspection.planVersion = 'plan-2'; after.plan!.baseVersion = 'plan-2';
  task.version = mathDigest('run-continuity-version-2'); task.informalProof = 'Second recorded derivation'; task.proof.status = 'failed';
  const source = after.sources.find(item => item.taskId === task.id)!;
  source.source = source.source.replace('  rfl', '  exact missing_lemma'); source.taskVersion = task.version; source.commit = '9'.repeat(40); source.sourceDigest = mathDigest(source.source);
  task.proof.commit = source.commit; task.proof.sourceDigest = source.sourceDigest;
  after.checks = [{ id: 'second-failed-check', taskId: task.id, taskVersion: task.version, commit: source.commit, sourceDigest: source.sourceDigest,
    environmentDigest: source.environmentDigest, record: { passed: false, stderrPreview: 'Submission.lean:4:8: error: unknown identifier missing_lemma' } }];
  after.inspection.tasks = [task]; after.plan!.tasks = after.plan!.tasks.filter(item => item.id === task.id); after.plan!.proofRoutes = [];
  second.result = { status: 'evaluated_failed', proof: source.source, report: {} };
  return { first, second };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Controlled continuity fixture' }; },
  async run(input, send, signal) {
    workers++;
    if (input.input.model === 'fixture-auth-error') { send({ type: 'error', message: 'Fixture key rejected', failure: { kind: 'authentication' } }); return; }
    const fixture = records(input.id); fixtures.set(input.id, fixture);
    if (input.input.model === 'fixture-approval') {
      fixture.first.observation!.inspection.planApproval = { required: true, status: 'pending', planVersion: 'plan-1', rejections: [], leadRevising: false };
      send({ type: 'observation', observation: fixture.first.observation! });
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); }); return;
    }
    send({ type: 'observation', observation: fixture.first.observation! });
    send({ type: 'observation', observation: fixture.second.observation! });
    send({ type: 'result', result: fixture.second.result! });
  },
  async command(_run, command) { if (command.type === 'capture') return { id: 'capture', status: 'captured' }; prohibited++; throw new Error('No decision may be submitted by this reader test'); },
  async check() { prechecks++; return { exitCode: 0, timedOut: false, output: '' }; },
  async formalize() { prohibited++; throw new Error('No model in this fixture'); },
  async explain() { prohibited++; throw new Error('No model in this fixture'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '4',
  THEOREMOS_WEB_CLIENT_IP_HEADER: 'x-fixture-continuity' }), runner, { sample: null, mailer: async () => { prohibited++; throw new Error('No mail in this fixture'); } });
const browser = await startBrowser(service.server, port), checks: object[] = [], errors: string[] = [], external: string[] = [];
let phase = 'setup', failure: unknown, active: Page | undefined;
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-fixture-continuity': `${language}-${width}` } });
    await context.addInitScript(language => localStorage.setItem('theorem-os.web-locale.v1', language), language);
    await preferFullCollaboration(context);
    await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/workspace.html`); await page.locator('.workspace-tabs').waitFor();
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const session = await page.evaluate(async () => (await fetch('/api/session')).json()), provider = session.providers[0], recorded = readingRun();
    const create = (model: string) => service.jobs.create(owner, { providerId: provider.id, apiKey: 'sk-disposable-not-sent', model, effort: 'high',
      source: recorded.source, task: recorded.task, environment: recorded.environment, maxTurns: 2, maxRunSeconds: 600, workers: 1, coordination: 'cooperative' }, provider);
    phase = `failure-and-recovery-${language}`;
    const failed = create('fixture-auth-error');
    await page.waitForFunction(async id => (await (await fetch(`/api/runs/${id}`)).json()).run.status === 'error', failed.id);
    await page.goto(`${origin}/problem.html?run=${failed.id}&lang=${language}`); const status = page.locator('[data-problem-run-state="error"]'); await status.waitFor();
    assert.equal(await status.evaluate(node => node.parentElement!.firstElementChild === node), true, 'Run state is the first overview content');
    assert.match(await status.innerText(), language === 'zh' ? /没有生成任务路线/ : /ended before a task route/);
    assert.doesNotMatch(await page.locator('[data-problem-attention]').innerText(), /没有待处理|no pending blockers/);
    await page.screenshot({ path: path.join(output, `failure-state-${language}.png`), fullPage: true });
    const recovery = status.locator('[data-problem-recovery="key"]'); await recovery.waitFor();
    assert.equal(new URL((await recovery.getAttribute('href'))!, origin).searchParams.get('run'), failed.id);
    const beforeRecovery = workers; await recovery.click();
    await page.waitForFunction(expected => (document.querySelector('#source') as HTMLTextAreaElement)?.value.trim() === expected, recorded.source.trim());
    assert.equal(await page.locator('#api-key').inputValue(), ''); assert.equal(workers, beforeRecovery, 'Recovery prepares a draft without starting a worker');
    assert.equal(new URL(page.url()).searchParams.has('recovery'), false, 'Recovery action is consumed once');
    await page.keyboard.press('Escape');
    phase = `pending-plan-${language}`;
    const pending = create('fixture-approval');
    await page.waitForFunction(async id => Boolean((await (await fetch(`/api/runs/${id}`)).json()).run.observation?.inspection.planApproval), pending.id);
    await page.goto(`${origin}/problem.html?run=${pending.id}&lang=${language}`);
    await page.locator('[data-problem-review-plan]').click(); await page.locator('[data-inline-drawer][open]').waitFor();
    assert.equal(await page.locator('[data-inline-approve-plan]').isDisabled(), true); assert.equal(prohibited, 0, 'Opening review never approves the plan');
    await page.screenshot({ path: path.join(output, `pending-plan-${language}.png`), fullPage: true });
    await page.keyboard.press('Escape'); service.jobs.cancel(owner, pending.id);
    phase = `current-check-${language}`;
    const run = create('fixture-history');
    await page.waitForFunction(async id => (await (await fetch(`/api/runs/${id}`)).json()).run.status === 'completed', run.id);
    const fixture = fixtures.get(run.id)!, beforeTask = fixture.first.observation!.inspection.tasks[0], afterTask = fixture.second.observation!.inspection.tasks[0];
    await page.goto(`${origin}/problem.html?${new URLSearchParams({ run: run.id, tab: 'route', task: afterTask.id, taskVersion: afterTask.version, lang: language })}`);
    await page.locator('[data-problem-open-check="second-failed-check"]').click();
    const reader = page.locator('[data-research-check="second-failed-check"]'); await reader.locator('[data-check-diagnostics] .research-check-message').waitFor();
    assert.match(await reader.locator('[data-check-diagnostics]').innerText(), /unknown identifier missing_lemma/);
    assert.equal(await reader.locator('.research-check-raw').evaluate(node => (node as HTMLDetailsElement).open), false);
    await reader.locator('[data-check-source-location]').click();
    const sourceLine = reader.locator('[data-check-source-line="4"]');
    assert.equal(await sourceLine.getAttribute('aria-current'), 'location'); assert.match(await sourceLine.innerText(), /exact missing_lemma/);
    await page.waitForFunction(() => document.activeElement?.matches('[data-research-check="second-failed-check"] [data-check-source-line="4"]'));
    await reader.locator('[data-check-source-version]').selectOption('previous'); assert.match(await reader.locator('[data-check-source-line="4"]').innerText(), /rfl/);
    await reader.locator('[data-check-open-diff]').click(); await reader.locator('[data-check-diff] table').waitFor();
    assert.match(await reader.locator('[data-check-diff]').innerText(), /rfl[\s\S]*exact missing_lemma|exact missing_lemma[\s\S]*rfl/);
    await page.screenshot({ path: path.join(output, `check-diff-${language}.png`), fullPage: true });
    phase = `frozen-history-${language}`;
    await openProblemHistory(page);
    await page.locator('[data-evolution-moment]').selectOption(`1:${firstDigest}`); await page.locator('[data-evolution-selected="1"]').waitFor();
    await page.locator('[data-solution-node="task:conclusion"]').waitFor();
    assert.equal(await page.locator('[data-inline-open]').count(), 0, 'Frozen reading has no active decision drawer');
    await page.locator('[data-solution-node="task:normalization"]').click();
    await page.locator('[data-solution-heading="task:normalization"]').waitFor();
    assert.doesNotMatch(await page.locator('[data-problem-route-workspace]').innerText(), /Second recorded derivation|second-failed-check/);
    await page.locator('[data-problem-open-source]').click(); await page.locator('[data-journey-source-reader] pre').first().waitFor();
    assert.match(await page.locator('[data-journey-source-reader]').innerText(), /rfl/); assert.doesNotMatch(await page.locator('[data-journey-source-reader]').innerText(), /missing_lemma/);
    await page.locator('[data-problem-open-check="receipt-normalization"]').click(); await page.locator('[data-research-check="receipt-normalization"] [data-check-passed="true"]').waitFor();
    await page.locator('[data-problem-map="global"]').click(); await page.locator('[data-journey-task-detail="normalization"]').waitFor();
    assert.equal(await page.locator('[data-journey-task-detail="normalization"]').getAttribute('data-task-version'), beforeTask.version);
    await page.locator('[data-journey-task="conclusion"]').waitFor();
    await page.locator('[data-journey-check="receipt-normalization"] summary').click();
    await page.locator('[data-research-check="receipt-normalization"] [data-check-passed="true"]').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('atState'), firstDigest);
    await page.reload(); await page.locator('[data-journey-task-detail="normalization"]').waitFor();
    assert.equal(await page.locator('[data-evolution-moment]').inputValue(), `1:${firstDigest}`);
    assert.equal(await page.locator('[data-journey-task-detail="normalization"]').getAttribute('data-task-version'), beforeTask.version);
    await page.locator('[data-problem-map="attempt"]').click(); await page.locator('[data-solution-node="task:conclusion"]').waitFor();
    await page.goBack(); await page.locator('[data-journey-task-detail="normalization"]').waitFor();
    await page.goForward(); await page.locator('[data-solution-node="task:conclusion"]').waitFor();
    await page.screenshot({ path: path.join(output, `frozen-route-${language}.png`), fullPage: true });
    await page.locator('[data-evolution-live]').click(); await page.locator('[data-solution-node="task:normalization"]').waitFor();
    assert.equal(await page.locator('[data-solution-node="task:conclusion"]').count(), 0);
    await openProblemHistory(page);
    await page.locator('[data-problem-map="global"]').click(); await page.locator('[data-journey-task="normalization"]').click();
    await page.locator('[data-journey-check="second-failed-check"] summary').click();
    await page.locator('[data-research-check="second-failed-check"] .research-check-message').waitFor();
    assert.match(await page.locator('[data-journey-task-detail="normalization"]').innerText(), /Second recorded derivation/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow');
    assert.equal(workers, beforeRecovery + 2, 'Only explicitly created fixture runs started');
    checks.push({ language, width, realFailureStatus: true, recoveryPreparedWithoutStarting: true, planReviewWithoutApproval: true,
      diagnosticLineFocused: true, previousSourceCompared: true, frozenGraphDerivationSourceAndChecks: true, globalCurrentAndHistoryNavigation: true, noOverflow: true });
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0);
} catch (error) {
  failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (!failure) await fs.rm(path.join(output, 'failure.png'), { force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, errors, external, workers, prechecks, prohibited,
    ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Run status, check diagnosis and saved-moment reading: ${checks.length} desktop/mobile workflows passed`);
