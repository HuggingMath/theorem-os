#!/usr/bin/env bun
// Real local HTTP and Chromium, with delayed responses and controlled observations; no model, Lean or mail.
import { seedCooperativeRun } from './web-cooperative-fixture';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebObservation, WebInspection } from '../apps/web/collaboration';
import type { WorkerMessage } from '../apps/web/shared';
import { freePort, startBrowser, settled } from './web-scenario';
import { openTab, refresh } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'out/frontend-round5/workbench');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT || path.join(root, 'out/web');
await fs.mkdir(output, { recursive: true });
await fs.access(path.join(staticRoot, 'app.js'));
const now = () => new Date().toISOString(), hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const source = 'theorem research_fixture : True := by sorry';
function observation(id: string): WebObservation {
  const tasks = [{ id: 'lemma', kind: 'lemma' as const, objective: 'Prove a supporting fact', dependsOn: [], revision: 0, theoremName: 'supporting_fact', proofPath: 'Main.lean', type: 'True' },
    { id: 'goal', kind: 'goal' as const, objective: 'Prove the original statement', dependsOn: ['lemma'], revision: 0, theoremName: 'research_fixture', proofPath: 'Main.lean', type: 'True' }];
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `fixture-${id}`, stateDigest: hash('initial'), resultDigest: null };
  const inspection: WebInspection = { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
    problem: { id: 'round2-browser-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'research_fixture', proofPath: 'Main.lean' }] },
    configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative', buildDigest: hash('build'), environmentDigest: hash('environment') }, turns: 1, planVersion: 'fixture-plan-v1',
    scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
    knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded', droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] },
    tokenBudget: {}, continuation: {}, mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: hash('math'), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
    progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['lemma', 'goal'] }, groups: [],
    tasks: tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective, group: 'main', status: 'pending', control: 'active', version: `${task.id}-v1`, theorem: task.theoremName, type: task.type,
      premises: [], plannedDependencies: task.dependsOn, attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })), workers: [], statementReviews: [], edits: [], planApproval: { required: true, status: 'pending', planVersion: 'fixture-plan-v1', requestedAt: Date.now(), rejections: [], leadRevising: false } };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1, evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, inspection,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'fixture-plan-v1', tasks }, sources: tasks.map(task => ({ scope: 'owned-file', taskId: task.id, taskVersion: `${task.id}-v1`, commit: '1'.repeat(40),
      sourceDigest: hash(source), environmentDigest: hash('environment'), file: 'Main.lean', source })), checks: [], guidance: [], coverage: { sources: 'partial', checks: 'partial' } };
}

type Control = { observation: WebObservation; emit(): void; send(message: WorkerMessage): void; finish(): void };
const controls = new Map<string, Control>();
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local round 5 synchronization fixture' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), send, finish: resolve, emit() {
        this.observation.sequence++; this.observation.observedAt = now();
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      controls.set(input.id, control); control.emit();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
};
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round5-workbench-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_DATA_ROOT: data, THEOREMOS_WEB_STATIC_ROOT: staticRoot }), runner, { sample: null });
const checks: object[] = [], errors: string[] = [], external: string[] = [];
let browser: Browser | undefined, active: Page | undefined, current = '', failure: unknown;
try {
  browser = await startBrowser(service.server, port);
  for (const [kind, width] of [['approval', 1440], ['approval', 390], ['restart', 1440], ['completion', 1440]] as const) {
    current = `${kind}/${width}`;
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: 'reduce', locale: 'zh-CN' });
    await context.addInitScript(() => {
      localStorage.setItem('theorem-os.locale.v1', 'zh');
      localStorage.setItem('theorem-os.web-collaboration-detail.v1', 'full');
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(`${current}: ${error.message}`));
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    let control: Control | undefined;
    try {
      await page.goto(origin); await page.locator('#formalize-original').waitFor();
      const run = await seedCooperativeRun(service, page.context(), origin, { providerId: 'openai', apiKey: 'sk-disposable-round5-fixture', model: 'fixture', effort: 'low', environment: 'standard',
        source, task: 'Observe plan state synchronization', maxTurns: 2, maxRunSeconds: 300, workers: 2, coordination: 'cooperative', planApproval: true });
      await page.goto(origin + '/?run=' + run.id);
      await page.waitForURL(url => url.searchParams.has('chat'));
      const waiting = page.locator('[data-chat-plan-decision][data-waiting="true"]');
      await waiting.waitFor();
      assert.equal((await waiting.locator('h3').innerText()).trim(), '研究计划，等你决定');
      await openTab(page, 'collaboration');
      await page.locator('[data-collab-observation]').waitFor({ state: 'attached' });
      control = controls.get(run.id)!;
      const stale = await page.evaluate(async () => (await fetch('/api/runs')).json());
      assert.equal(stale.runs.find((item: { id: string }) => item.id === run.id).observation.sequence, 2);
      if (kind === 'approval') {
        Object.assign(control.observation.inspection.planApproval!, { status: 'approved', approvedId: crypto.randomUUID(), approvedVersion: 'fixture-plan-v1', approvedAt: Date.now() });
        control.emit();
        await waiting.waitFor({ state: 'detached' });
        assert.equal(await page.locator('[data-chat-approve-plan]').count(), 0, 'An approved plan asks nothing more of the reader');
      } else if (kind === 'restart') {
        const before = control.observation.solverRunId, next = before + '-round2';
        control.observation.solverRunId = next;
        control.observation.snapshot.runId = next;
        control.observation.inspection.runId = next;
        control.observation.inspection.planVersion = control.observation.plan!.baseVersion = 'fixture-plan-v2';
        control.observation.inspection.planApproval!.planVersion = 'fixture-plan-v2';
        control.observation.inspection.tasks[0]!.version = 'lemma-v2';
        control.observation.inspection.tasks[0]!.objective = control.observation.plan!.tasks[0]!.objective = 'Round 2 supporting task';
        control.send({ type: 'library_restart', previousSolverRunId: before, solverRunId: next, round: 1 });
        control.emit();
        await page.waitForFunction(() => document.querySelector('[data-chat-plan-decision]')?.textContent?.includes('Round 2 supporting task'));
      } else {
        control.send({ type: 'result', result: { status: 'incomplete', proof: source, report: { fixture: true } } });
        control.finish();
        await page.locator('[data-research-stop]').waitFor({ state: 'detached' });
      }
      if (kind !== 'completion') await page.waitForFunction(() => document.querySelector('[data-collab-observation]')?.textContent?.includes('观察 #3'));
      await page.route(origin + '/api/runs', route => route.fulfill({ json: stale }));
      await refresh({ page }); await settled(page);
      if (kind === 'approval') {
        assert.equal(await waiting.count(), 0, 'A stale read cannot bring back the approval prompt');
        assert.equal(await page.locator('[data-chat-approve-plan]').count(), 0);
      } else if (kind === 'restart') {
        assert.ok((await page.locator('[data-chat-plan-decision]').innerText()).includes('Round 2 supporting task'));
        assert.ok((await page.locator('[data-collab-observation]').innerText()).includes('观察 #3'));
      } else {
        assert.equal(await page.locator('[data-research-stop]').count(), 0);
        assert.equal(await page.locator('[data-chat-approve-plan]').count(), 0);
        assert.equal(await page.locator('[data-action="cancel"]').count(), 0);
      }
      await page.screenshot({ path: path.join(output, `${kind}-${width}.png`) });
      checks.push({ kind, width, heldObservation: 2, retainedObservation: kind === 'completion' ? 2 : 3,
        planDecision: (await page.locator('[data-chat-plan-decision]').allTextContents())[0] ?? null });
      console.log(`PASS ${current}: late chat read preserves the live state`);
    } finally { control?.finish(); await context.close(); }
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) { failure = String(error); await active?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, errors, external,
    failure, current, realModelCalls: 0, realLeanCalls: 0 }, null, 2) + '\n');
  for (const control of controls.values()) control.finish();
  await browser?.close(); await service.close(); await fs.rm(data, { recursive: true, force: true });
}
