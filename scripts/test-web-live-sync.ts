#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebObservation } from '../apps/web/collaboration';
import type { WebRunInput } from '../apps/web/shared';
import { fillConfig, openTab, selectHistoryRun } from './web-ui-controls';
import { deferred, freePort, postRun, settled, startBrowser, webScenario, writeScenarioReport,
  type ScenarioHarness, type ScenarioSuite, runtimeWrite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), output = path.join(root, 'out/web-live-sync');
await fs.mkdir(output, { recursive: true });
const now = () => new Date().toISOString();
function observation(id: string): WebObservation {
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `solver-${id}`, stateDigest: 'a'.repeat(64), resultDigest: null };
  const task = { id: 'original', kind: 'goal' as const, objective: 'Inspect live proof collaboration', dependsOn: [], revision: 0,
    theoremName: 'original', proofPath: 'Submission.lean', type: 'True' };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId,
    observedAt: now(), sequence: 1, evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [task] },
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot,
      evidence: 'recorded-not-replayed', phase: 'cooperative',
      problem: { id: 'live-sync-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [],
        targets: [{ proofPath: 'Submission.lean', theoremName: 'original' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 1, coordination: 'cooperative', buildDigest: 'b'.repeat(64), environmentDigest: 'e'.repeat(64) },
      turns: 1, planVersion: 'plan-v1', scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 1, working: 1,
        proofAssignments: 1, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin',
        retrievalCoverage: 'recorded', droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] },
      tokenBudget: {}, continuation: {}, mathematics: { snapshot: { schema: 'theoremos.obligation-snapshot.v1',
        evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: 'c'.repeat(64),
        obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['original'] },
      groups: [], tasks: [{ ...task, group: 'main', status: 'running', control: 'active', owner: 'lead', version: 'original-v1',
        theorem: task.theoremName, premises: [], plannedDependencies: [], attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} }],
      workers: [{ id: 'lead', role: 'lead', phase: 'proving', task: 'original', turns: 1, dispatchWait: { status: 'unknown' } }],
      statementReviews: [], edits: [] }, sources: [], checks: [], guidance: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}
type Control = { observation: WebObservation; emit(): void; finish(): void };
const controls = new Map<string, Control>();
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local live-sync fixture; no model or Lean' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), finish: resolve, emit() {
        this.observation.sequence++; this.observation.observedAt = now();
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true }); control.emit();
    });
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
type Harness = ScenarioHarness & { runIds: string[]; effect?: (route: Route) => Promise<boolean> };
type Probe = { opened: number; closed: number; errors: number; events: number; sources: EventSource[] };
const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-local-live-sync-fixture', model: 'fixture', effort: 'low', environment: 'standard',
  source: 'theorem original : True := by sorry\n', task: 'Inspect live synchronization', maxTurns: 2, maxRunSeconds: 60, workers: 1, coordination: 'cooperative' };
const text = '[data-guidance-text]';
const probe = (page: Page) => page.evaluate(() => {
  const { sources: _, ...counts } = (window as unknown as { __liveSync: Probe }).__liveSync; return counts;
});
const lists = (h: Harness) => h.requests.filter(r => r.method === 'GET' && r.pathname === '/api/runs').length;
async function sequence(page: Page, value: number, timeout = 10_000) {
  await page.waitForFunction(value => document.querySelector('[data-collab-observation]')?.textContent?.includes(`观察 #${value} ·`), value, { timeout });
}
async function live(page: Page) { await page.waitForFunction(() => (window as unknown as { __liveSync: Probe }).__liveSync.events > 0); }
/** A run created through the API is opened from the history (the root address stays on a new problem); these checks read the task graph on 协作. */
async function collaboration(page: Page, id: string) {
  if (!await page.locator(`[data-run-id="${id}"][aria-pressed="true"]`).count()) await selectHistoryRun(page, id);
  await openTab(page, 'collaboration');
}
async function create(h: Harness) {
  const run = await postRun(h, input); h.runIds.push(run.id); await collaboration(h.page, run.id);
  await h.page.locator('.collab-graph [data-collab-task="original"]').waitFor(); await settled(h.page); return run;
}
function scenario(name: string, run: (h: Harness) => Promise<void>, options: { unavailable?: boolean; interruptFirst?: boolean } = {}) {
  return webScenario(browser, suite, name, run, {
    context: { viewport: { width: 1440, height: 950 }, reducedMotion: 'reduce' },
    init: context => context.addInitScript(() => {
      const counts: Probe = { opened: 0, closed: 0, errors: 0, events: 0, sources: [] };
      (window as unknown as { __liveSync: Probe }).__liveSync = counts;
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options); counts.opened++; counts.sources.push(this);
          this.addEventListener('runs-changed', () => counts.events++);
          this.addEventListener('error', () => counts.errors++);
        }
        close() { counts.closed++; super.close(); }
      };
    }),
    harness: (page, context) => {
      const h: Harness = { page, context, requests: [], runIds: [] };
      let interrupted = false;
      h.intercept = async route => {
        if (new URL(route.request().url()).pathname === '/api/runs/stream') {
          if (options.unavailable) {
            await route.fulfill({ status: 503, json: { error: 'Fixture live stream unavailable' } }); return true;
          }
          if (options.interruptFirst && !interrupted) {
            interrupted = true;
            const response = await route.fetch({ url: origin + '/api/runs' });
            await route.fulfill({ status: 200, contentType: 'text/event-stream',
              body: `retry: 1000\nevent: runs-changed\ndata: ${JSON.stringify({ version: response.headers()['etag'] })}\n\n` });
            return true;
          }
        }
        return await h.effect?.(route) ?? false;
      }; return h;
    }, routes: { local: 'Live synchronization must stay on the temporary local HTTP service' }, open: true,
    timeout: { label: 'Live synchronization', seconds: 35 },
    verify: async (h, elapsedMs) => ({ name, elapsedMs: elapsedMs(), probe: await probe(h.page), requests: h.requests }),
    cleanup: h => { for (const id of h.runIds) controls.get(id)?.finish(); },
  });
}

try {
  await scenario('live invalidations update tasks immediately and combine a burst without disturbing reading', async h => {
    const { page } = h; await live(page); const run = await create(h), control = controls.get(run.id)!;
    await page.locator('[data-collab-nav-guide]').click(); await page.locator(text).fill('Keep this unsent mathematical guidance');
    const node = await page.locator(text).elementHandle(), before = await page.locator('#detail-panel').evaluate(node => node.scrollTop);
    await page.waitForTimeout(100); const requests = lists(h), events = (await probe(page)).events;
    const started = performance.now();
    for (let turn = 2; turn <= 25; turn++) {
      control.observation.inspection.workers[0]!.turns = turn;
      control.observation.inspection.tasks[0]!.owner = 'live-owner-' + turn; control.emit();
    }
    await sequence(page, control.observation.sequence, 1500);
    assert.match(await page.locator('.collab-graph [data-collab-task="original"]').innerText(), /live-owner-25/);
    assert.equal((await probe(page)).events - events, 1, 'same-turn changes produce one small notification');
    assert.equal(lists(h) - requests, 1, 'one notification produces one conditional list read');
    assert.equal(await node!.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator(text).inputValue(), 'Keep this unsent mathematical guidance');
    assert.equal(await page.locator('#detail-panel').evaluate(node => node.scrollTop), before);
    assert.equal(h.requests.some(r => r.pathname.endsWith('/observation')), false);
    console.log(`Live burst reached the browser in ${Math.round(performance.now() - started)} ms including browser waits`);
    await node!.dispose();
  });

  await scenario('a notification arriving during an older GET triggers a second read after it settles', async h => {
    const { page } = h; await live(page); const run = await create(h), control = controls.get(run.id)!;
    await page.waitForTimeout(100);
    const held = deferred(), release = deferred(); let holding = true;
    h.effect = async route => {
      if (!holding || route.request().method() !== 'GET' || new URL(route.request().url()).pathname !== '/api/runs') return false;
      holding = false; const headers = route.request().headers(); delete headers['if-none-match'];
      const response = await route.fetch({ headers }); held.resolve(); await release.promise;
      await route.fulfill({ response }); return true;
    };
    const before = lists(h), events = (await probe(page)).events;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await held.promise;
    try {
      control.observation.inspection.tasks[0]!.owner = 'newer-than-held-read'; control.emit();
      await page.waitForFunction(events => (window as unknown as { __liveSync: Probe }).__liveSync.events > events, events);
      assert.equal(lists(h) - before, 1, 'overlapping notifications do not start parallel list reads');
      release.resolve(); await sequence(page, control.observation.sequence, 1500);
      assert.match(await page.locator('.collab-graph [data-collab-task="original"]').innerText(), /newer-than-held-read/);
      assert.equal(lists(h) - before, 2, 'the invalidation received during the GET is retained');
    } finally { release.resolve(); }
  });

  await scenario('two tabs in the same session receive changes and cancellation without manual refresh', async h => {
    await live(h.page); const run = await create(h), control = controls.get(run.id)!;
    const other = await h.context.newPage();
    try {
      await other.goto(origin); await live(other); await collaboration(other, run.id); await sequence(other, control.observation.sequence);
      control.observation.inspection.tasks[0]!.owner = 'shared-session-update'; control.emit();
      await Promise.all([sequence(h.page, control.observation.sequence, 1500), sequence(other, control.observation.sequence, 1500)]);
      await h.page.locator('[data-action="cancel"]').click(); await h.page.locator('#confirm-cancel-run').click();
      await other.waitForFunction(() => document.querySelector('.detail-statusline .badge')?.getAttribute('data-status')?.startsWith('cancelled:'));
      assert.equal(await other.locator('[data-action="cancel"]').count(), 0);
    } finally { await other.close(); }
  });

  await scenario('REST polling keeps the page usable while the live endpoint is unavailable', async h => {
    const { page } = h;
    await page.waitForFunction(() => (window as unknown as { __liveSync: Probe }).__liveSync.errors > 0);
    const run = await create(h), control = controls.get(run.id)!;
    await page.locator('[data-collab-nav-guide]').click(); await page.locator(text).fill('Offline stream preserves the draft');
    control.observation.inspection.tasks[0]!.owner = 'polling-fallback'; control.emit();
    await sequence(page, control.observation.sequence, 6000);
    assert.equal((await probe(page)).events, 0); assert.equal(await page.locator('#global-notice').isHidden(), true);
    assert.equal(await page.locator('[data-collab-guidance-form] button[type="submit"]').isEnabled(), true);
    assert.equal(await page.locator(text).inputValue(), 'Offline stream preserves the draft');
  }, { unavailable: true });

  await scenario('an interrupted live response reconnects through the same EventSource and catches changes during the gap', async h => {
    const { page } = h;
    await page.waitForFunction(() => (window as unknown as { __liveSync: Probe }).__liveSync.errors > 0);
    const initial = await probe(page);
    const run = await postRun(h, input); h.runIds.push(run.id);
    const control = controls.get(run.id)!; await collaboration(page, run.id);
    control.observation.inspection.tasks[0]!.owner = 'changed-during-reconnect'; control.emit();
    await page.waitForFunction(events => (window as unknown as { __liveSync: Probe }).__liveSync.events > events, initial.events);
    await sequence(page, control.observation.sequence, 1500);
    assert.match(await page.locator('.collab-graph [data-collab-task="original"]').innerText(), /changed-during-reconnect/);
    assert.equal(h.requests.filter(r => r.pathname === '/api/runs/stream').length, 2);
    assert.equal((await probe(page)).opened, initial.opened, 'the browser reconnects the existing EventSource');
    assert.equal((await probe(page)).closed, initial.closed, 'a stream interruption does not rebuild the application connection');
    assert.equal(h.requests.filter(runtimeWrite).length, 1, 'reconnection does not replay the run creation');
  }, { interruptFirst: true });

  await scenario('hidden and restored pages close old streams and reconcile missed changes without replaying writes', async h => {
    const { page } = h; await live(page); const run = await create(h), control = controls.get(run.id)!;
    const initial = await probe(page), writes = h.requests.filter(runtimeWrite).length;
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal((await probe(page)).closed, initial.closed + 1);
    control.observation.inspection.tasks[0]!.owner = 'changed-while-hidden'; control.emit();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sequence(page, control.observation.sequence, 1500);
    await page.waitForFunction(opened => (window as unknown as { __liveSync: Probe }).__liveSync.opened > opened, initial.opened);
    await page.waitForTimeout(100); const beforeOldMessage = lists(h);
    await page.evaluate(() => (window as unknown as { __liveSync: Probe }).__liveSync.sources[0]!.dispatchEvent(
      new MessageEvent('runs-changed', { data: JSON.stringify({ version: 'closed-stream-message' }) })));
    await settled(page); assert.equal(lists(h), beforeOldMessage, 'closed stream callbacks cannot refresh a new connection');
    assert.equal(h.requests.filter(runtimeWrite).length, writes);
  });

  await scenario('a delayed creation response keeps the newer run already received through the stream', async h => {
    const { page } = h; await live(page);
    await fillConfig(page, 'source', input.source); await page.locator('#task').fill('Create a run with a delayed response');
    await fillConfig(page, 'api-key', input.apiKey);
    const held = deferred(), release = deferred(); let createdId = '';
    h.effect = async route => {
      if (route.request().method() !== 'POST' || new URL(route.request().url()).pathname !== '/api/runs') return false;
      const response = await route.fetch(); assert.equal(response.status(), 201);
      createdId = (await response.json()).run.id; h.runIds.push(createdId); held.resolve(); await release.promise;
      await route.fulfill({ response }); return true;
    };
    await page.locator('#submit-run').click(); await held.promise;
    try {
      // The composer stays until the response settles the outcome; the newer stream state reaches the list first.
      const control = controls.get(createdId)!;
      const streamed = page.waitForResponse(async response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'GET'
        && response.status() === 200 && (await response.text()).includes('ahead-of-post-response'));
      control.observation.inspection.tasks[0]!.owner = 'ahead-of-post-response'; control.emit();
      await streamed; await page.locator(`#run-list [data-run-id="${createdId}"]`).waitFor({ state: 'attached' });
      assert.equal(await page.locator('body[data-view="draft"]').count(), 1, 'the run must not replace the composer before its response');
      await page.evaluate(() => {
        // Every status the run header shows from now on, including the first one when the run opens.
        const statuses: string[] = []; (window as unknown as { __statuses: string[] }).__statuses = statuses;
        const record = () => { const status = document.querySelector('.detail-statusline .badge')?.getAttribute('data-status'); if (status && statuses.at(-1) !== status) statuses.push(status); };
        new MutationObserver(record).observe(document.querySelector('#run-detail')!, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status'] });
      });
      // The new run replaces the composer with the newer streamed state, never the response's older one.
      release.resolve(); await collaboration(page, createdId); await settled(page);
      await sequence(page, control.observation.sequence, 1500);
      const statuses = await page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses);
      assert.ok(statuses.length > 0, 'the run header must open'); assert.equal(statuses.some(value => value.startsWith('queued:')), false, statuses.join(','));
      assert.match(await page.locator('.collab-graph [data-collab-task="original"]').innerText(), /ahead-of-post-response/);
      assert.equal(h.requests.filter(r => r.method === 'POST' && r.pathname === '/api/runs').length, 1);
    } finally { release.resolve(); }
  });

  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', null, 'local-real-http-and-native-event-source', {
    checks: suite.checks, leanProcesses: 0,
  }, { credential: input.apiKey });
  console.log(`Live synchronization: ${suite.checks.length}/${suite.checks.length} passed`);
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-and-native-event-source', {
    checks: suite.checks, leanProcesses: 0,
  }, { credential: input.apiKey, failureRequests: true }); throw error;
} finally {
  for (const control of controls.values()) control.finish(); await browser.close(); await service.close();
}
