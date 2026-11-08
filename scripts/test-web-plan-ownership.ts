#!/usr/bin/env bun
// Real loopback HTTP and Chromium with in-memory accounts and a synthetic runner. No model, Lean or Docker calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput } from '../apps/web/shared';
import type { WebObservation } from '../apps/web/collaboration';
import { closeDialog, refreshHistory, selectHistoryRun } from './web-ui-controls';
import { freePort, ready, settled, startBrowser, webScenario, writeScenarioReport,
  type ScenarioHarness, type ScenarioSuite } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/web-plan-ownership');
await fs.mkdir(output, { recursive: true });
const now = () => new Date().toISOString(), digest = (text: string) => text.repeat(64);
const controls = new Map<string, { finish(): void }>();
const commands: { runId: string; type: string }[] = [];
const mail: { to: string; text: string }[] = [];
function observation(id: string): WebObservation {
  const tasks = [{ id: 'base', kind: 'lemma' as const, objective: 'Synthetic local premise', dependsOn: [], revision: 0,
    theoremName: 'base', proofPath: 'Submission.lean', type: 'True' },
  { id: 'original', kind: 'goal' as const, objective: 'Synthetic original target', dependsOn: ['base'], revision: 0,
    theoremName: 'original_goal', proofPath: 'Submission.lean', type: 'True' }];
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `solver-${id}`, stateDigest: digest('a'), resultDigest: null };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId,
    observedAt: now(), sequence: 1, evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks },
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot,
      evidence: 'recorded-not-replayed', phase: 'cooperative',
      problem: { id: 'ownership-fixture', statement: 'Synthetic True fixture', formalStatement: 'True', assumptions: [],
        targets: [{ proofPath: 'Submission.lean', theoremName: 'original_goal' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative', buildDigest: digest('b'), environmentDigest: digest('e') },
      turns: 1, planVersion: 'plan-v1', scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 2,
        working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 2, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin',
        retrievalCoverage: 'recorded', droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed',
        acceptance: 'not-assessed', digest: digest('c'), obligations: [], goals: [], blockers: [], routes: [], advisory: [] },
        recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['base', 'original'] },
      groups: [], tasks: tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective, group: 'main',
        status: 'pending', control: 'active', version: `${task.id}-v1`, theorem: task.theoremName, type: task.type,
        premises: [], plannedDependencies: task.dependsOn, attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })),
      workers: [], statementReviews: [], edits: [] }, sources: [], checks: [], guidance: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local plan ownership fixture' }; },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      controls.set(input.id, { finish: resolve });
      signal.addEventListener('abort', () => resolve(), { once: true });
      send({ type: 'observation', observation: observation(input.id) });
    });
  },
  async command(runId, command) {
    commands.push({ runId, type: command.type });
    if (command.type === 'capture') return { id: 'capture', status: 'captured', observation: observation(runId) };
    if (command.type !== 'edit' && command.type !== 'edit-preview') throw new Error(`Unexpected fixture command: ${command.type}`);
    return { id: command.proposal.id, status: command.type === 'edit-preview' ? 'validated' : 'unknown' };
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_CONCURRENCY: '8',
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org' }), runner,
{ sample: null, mailer: async item => { mail.push(item); }, captchaAnswer: () => '12345' });
const browser = await startBrowser(service.server, port);
const suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const accountCookies = new Map<string, Awaited<ReturnType<BrowserContext['cookies']>>>();
type Login = Awaited<ReturnType<typeof login>>;
type Harness = ScenarioHarness & { alice: Login; runIds: string[] };
async function login(context: BrowserContext, email: string) {
  const cookies = accountCookies.get(email);
  if (cookies) await context.addCookies(cookies);
  const request = context.request;
  let session = await (await request.get(origin + '/api/session')).json();
  const headers = () => ({ 'X-CSRF-Token': session.csrfToken, Origin: origin });
  if (!cookies) {
    const captcha = await (await request.post(origin + '/api/auth/captcha', { headers: headers(), data: {} })).json();
    const sent = await request.post(origin + '/api/auth/code', { headers: headers(), data: { email, captchaId: captcha.id, captcha: '12345' } });
    assert.equal(sent.status(), 200);
    const code = mail.findLast(item => item.to === email)!.text.match(/\b\d{6}\b/)![0];
    const verified = await request.post(origin + '/api/auth/verify', { headers: headers(), data: { email, code } });
    assert.equal(verified.status(), 200); session = await verified.json();
    accountCookies.set(email, await context.cookies());
  }
  return { async create(task: string) {
    const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-local-plan-ownership', model: 'fixture', effort: 'low',
      environment: 'standard', source: 'theorem original_goal : True := by sorry\n', task,
      maxTurns: 2, maxRunSeconds: 60, workers: 2, coordination: 'cooperative' };
    const response = await request.post(origin + '/api/runs', { headers: headers(), data: input });
    assert.equal(response.status(), 201);
    return (await response.json()).run.id as string;
  } };
}
async function reconnect(page: Page, email: string) {
  const session = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session' && response.status() === 200);
  const listed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  assert.equal((await (await session).json()).account.email, email);
  await listed; await settled(page);
}
async function openPlan(page: Page, id: string) {
  await refreshHistory(page); await selectHistoryRun(page, id, 'collaboration');
  await page.locator('[data-collab-plan]:enabled').click();
  await page.locator('.collab-plan-dialog[open]').waitFor();
  await page.locator('[data-plan-task]').selectOption('base');
}
try {
  // Separate authenticated sessions model cookies being replaced by another tab without expiring the previous owner.
  for (const email of ['alice@example.org', 'bob@example.org']) {
    const context = await browser.newContext();
    try { await login(context, email); } finally { await context.close(); }
  }
  for (const width of [1440, 390]) for (const outcome of ['unknown', 'error', 'missing-retry'] as const) {
    const name = `${width}px: switching owner closes a private plan and revokes its late ${outcome} response`;
    await webScenario<Harness>(browser, suite, name, async h => {
      const { page, context } = h, id = await h.alice.create('Synthetic Alice run'); h.runIds.push(id);
      await openPlan(page, id);
      const privateText = `Alice private full plan ${width} ${outcome}`;
      await page.locator('[data-plan-objective]').fill(privateText);
      const aliceJson = await page.locator('#collab-plan-json').inputValue();
      await reconnect(page, 'alice@example.org');
      assert.equal(await page.locator('.collab-plan-dialog[open]').count(), 1, 'same-owner reconnect preserves an open editor');
      assert.equal(await page.locator('#collab-plan-json').inputValue(), aliceJson);
      await page.locator('[data-plan-preview]').click(); await page.locator('[data-plan-apply]:enabled').waitFor();
      const editPath = `/api/runs/${id}/edits`, commandId = JSON.parse(aliceJson).id as string;
      if (outcome === 'missing-retry') {
        await page.route(`**${editPath}`, route => route.abort(), { times: 1 });
        await page.locator('[data-plan-apply]').click();
        await page.locator('[data-plan-retry]:enabled').waitFor();
      }
      // Delay body handling after api() already checked Alice's HTTP owner header.
      await page.evaluate(({ pathname, outcome }) => {
        const json = Response.prototype.json;
        Response.prototype.json = async function () {
          const value = await json.call(this);
          if (new URL(this.url).pathname === pathname && (value.receipt?.status === 'unknown' || this.status === 404)) {
            await new Promise<void>(resolve => { (window as any).__releasePrivatePlan = resolve; });
            if (outcome === 'error') throw new Error('Alice private late response failed');
          }
          return value;
        };
      }, { pathname: outcome === 'missing-retry' ? `/api/runs/${id}/commands/${commandId}` : editPath, outcome });
      await page.locator(outcome === 'missing-retry' ? '[data-plan-retry]' : '[data-plan-apply]').click();
      await page.waitForFunction(() => Boolean((window as any).__releasePrivatePlan));
      const bob = await login(context, 'bob@example.org');
      await reconnect(page, 'bob@example.org');
      assert.equal(await page.locator('.collab-plan-dialog[open]').count(), 0, 'an owner change must close the old owner plan editor');
      assert.ok(!(await page.locator('body').innerText()).includes(privateText), 'the new owner cannot see the private plan');
      const bobId = await bob.create('Synthetic Bob run'); h.runIds.push(bobId); await openPlan(page, bobId);
      await page.locator('[data-plan-objective]').fill('Bob current editable proposal');
      const bobJson = await page.locator('#collab-plan-json').inputValue();
      const afterSwitch = h.requests.length;
      await page.evaluate(() => (window as any).__releasePrivatePlan()); await settled(page);
      assert.equal(await page.locator('#collab-plan-json').inputValue(), bobJson);
      assert.equal(await page.locator('[data-plan-receipt]').innerText(), '', 'Alice receipt/error cannot enter Bob editor');
      assert.deepEqual(h.requests.slice(afterSwitch).filter(request => request.pathname.startsWith(`/api/runs/${id}/commands/`)
        || request.method === 'POST' && request.pathname === editPath), [],
        'a revoked command cannot read or retry its receipt under the new owner');
      await page.locator('[data-plan-preview]').click(); await page.locator('[data-plan-apply]:enabled').waitFor();
      await closeDialog(page, '.collab-plan-dialog', () => page.locator('[data-plan-close]').click());
      await login(context, 'alice@example.org'); await reconnect(page, 'alice@example.org'); await openPlan(page, id);
      assert.ok(!(await page.locator('#collab-plan-json').inputValue()).includes(privateText), 'discarded plan drafts cannot revive after a later login');
      await page.screenshot({ path: path.join(output, `owner-switch-${width}-${outcome}.png`) });
    }, {
      context: { viewport: { width, height: 1000 }, reducedMotion: 'reduce' },
      harness: (page, context) => ({ page, context, requests: [], alice: undefined as unknown as Login, runIds: [] }),
      routes: { local: 'All browser requests must stay on the local synthetic fixture' },
      open: async h => { h.alice = await login(h.context, 'alice@example.org'); await h.page.goto(origin); await ready(h.page); },
      timeout: { label: 'Plan ownership', seconds: 45 },
      verify: (h, elapsedMs) => ({ name, elapsedMs: elapsedMs(), requests: h.requests, runIds: h.runIds }),
      cleanup: async h => {
        await h.page.evaluate(() => (window as any).__releasePrivatePlan?.()).catch(() => {});
        for (const id of h.runIds) controls.get(id)?.finish();
      },
    });
  }
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined, 'local-real-http-plan-ownership',
    { checks: suite.checks, commands, screenshots: [1440, 390].flatMap(width => ['unknown', 'error', 'missing-retry']
      .map(outcome => `owner-switch-${width}-${outcome}.png`)) });
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error, 'local-real-http-plan-ownership',
    { checks: suite.checks }, { failureRequests: true }); throw error;
} finally {
  for (const control of controls.values()) control.finish();
  await browser.close(); await service.close();
}
