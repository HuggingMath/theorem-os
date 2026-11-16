#!/usr/bin/env bun
import { clickWorkbenchAction, openAdvancedChatSettings, openChatParticipation, openChatResultDetails } from './web-ui-controls';
// A disposable HTTP service, saved statement evidence and a controlled runner; no model, Docker or Lean.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { localeStorageKey } from '../apps/web/i18n';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WorkerInput, WorkerMessage } from '../apps/web/shared';
import type { WorkerFormalizationInput, WorkerFormalizationMessage } from '../apps/web/formalizationTypes';
import type { WebGuidanceRecord, WebObservation, WebPlanProposal } from '../apps/web/collaboration';
import { formalizationDigest } from '../src/math/formalization';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { SolverProblem } from '../src/solver/problem';
import { parseCooperationPlan, taskVersion } from '../src/solver/tasks';
import { webFormalizationEvidence, webFormalizationStatement } from '../tests/helpers/webFormalizationFixture';
import { audit } from './web-a11y';
import { freePort, settled, startBrowser } from './web-scenario';

declare const Bun: { serve(options: { hostname: string; port: number; fetch(request: Request): Promise<Response> }):
  { port: number; stop(force?: boolean): void } };
const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-human-decisions');
await fs.access(path.join(root, 'out/web/app.js'));
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-human-decisions-'));
const source = 'theorem addition (n : Nat) : n + 1 = 1 + n := by sorry\n';
const problem: SolverProblem = { kind: 'example', workspace: temporary, projectRelative: '.',
  baseCommit: mathDigest('fixture base').slice(0, 40), receiptDigest: mathDigest('fixture receipt'),
  activeProblemPath: path.join(temporary, 'unused-problem.json'), ownedFiles: ['Submission.lean'], trustedFiles: {}, sourceStructure: {},
  declarations: { 'Submission.lean': [{ name: 'addition', header: 'addition (n : Nat) : n + 1 = 1 + n' }] },
  targets: [{ proofPath: 'Submission.lean', theoremName: 'addition', declarationHash: mathDigest('addition (n : Nat) : n + 1 = 1 + n') }],
  contract: { problemId: 'human-decisions-fixture', informalStatement: webFormalizationStatement, formalStatement: source,
    assumptions: [], knownTraps: [], acceptanceCriteria: [], officialVerificationCommand: 'fixture-never-run',
    statementHash: mathDigest(webFormalizationStatement), leanStatementHash: mathDigest(source) } };
const initial = parseCooperationPlan(problem, { tasks: [
  { id: 'approach', kind: 'research', objective: 'Explore additive commutativity', dependsOn: [], revision: 0 },
  { id: 'original', kind: 'goal', objective: 'Prove the original addition identity', dependsOn: ['approach'], revision: 0,
    proofPath: 'Submission.lean', theoremName: 'addition' },
] });
type Formalization = { input: WorkerFormalizationInput; send(message: WorkerFormalizationMessage): void; finish(): void };
type Control = { input: WorkerInput; observation: WebObservation; emit(): void; finish(): void };
const formalizations: Formalization[] = [], started: WorkerInput[] = [], controls = new Map<string, Control>();
const approvals: { runId: string; id: string; planVersion: string }[] = [];
const edits: { runId: string; preview: boolean; proposal: WebPlanProposal }[] = [];
const guidance: { runId: string; record: WebGuidanceRecord }[] = [];
const now = () => new Date().toISOString();
let providerCalls = 0;
const discussion = 'This is a discussion of the recorded problem; it does not change the running proof.';
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  assert.equal(new URL(request.url).pathname, '/v1/responses');
  await request.json(); providerCalls++;
  return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: discussion }] }] });
} });
function observation(input: WorkerInput): WebObservation {
  const cooperative = input.input.coordination === 'cooperative' && input.input.workers >= 2;
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `solver-${input.id}`, stateDigest: mathDigest(input.id), resultDigest: null };
  const plan = cooperative ? { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1',
    tasks: structuredClone(initial.tasks), groups: structuredClone(initial.groups) } : null;
  return { schema: 'theorem-os.web-observation.v1', webRunId: input.id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, plan,
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed',
      phase: cooperative ? 'cooperative' : 'running', problem: { id: problem.contract.problemId, statement: webFormalizationStatement,
        formalStatement: input.input.source, assumptions: [], targets: problem.targets },
      configuration: { model: input.input.model, effort: input.input.effort, workers: input.input.workers, coordination: input.input.coordination,
        buildDigest: mathDigest('fixture build'), environmentDigest: mathDigest('fixture environment') },
      turns: 1, ...(plan ? { planVersion: plan.baseVersion } : {}),
      scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: input.input.workers, working: 0, proofAssignments: 0,
        preparing: 0, stopping: 0, idle: input.input.workers, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded',
        droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'theoremos.obligation-snapshot.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
        digest: mathDigest('fixture mathematics'), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0,
        openProofTasks: plan?.tasks.map(task => task.id) ?? [] }, groups: initial.groups.map(group => ({ group, turns: 0 })),
      tasks: (plan?.tasks ?? []).map(task => ({ id: task.id, kind: task.kind, objective: task.objective, group: task.groupId ?? 'main',
        status: 'pending', control: 'active', version: taskVersion(task), theorem: task.theoremName, type: task.type, premises: [],
        plannedDependencies: task.dependsOn, attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })),
      workers: cooperative ? [
        { id: 'lead', role: 'lead', phase: 'waiting', turns: 1, dispatchWait: { status: 'unknown' } },
        { id: 'engineer', role: 'engineer', phase: 'waiting', turns: 0,
          dispatchWait: { status: 'recorded', observation: { stage: 'plan-approval' } } },
      ] : [{ id: 'solver', role: 'lead', phase: 'running', turns: 1, dispatchWait: { status: 'unknown' } }],
      statementReviews: [], edits: [], ...(input.input.planApproval ? { planApproval: { required: true, status: 'pending',
        planVersion: 'plan-v1', requestedAt: Date.now(), rejections: [], leadRevising: false } } : {}),
    }, sources: [], checks: [], guidance: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}
function revise(control: Control, version: string) {
  control.observation.plan!.baseVersion = version;
  control.observation.inspection.planVersion = version;
  control.observation.inspection.planApproval!.planVersion = version;
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local human decision browser fixture' }; },
  formalize(input, send, signal) {
    return new Promise<void>(resolve => {
      formalizations.push({ input: structuredClone(input), send, finish: resolve });
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  async run(input, send: (message: WorkerMessage) => void, signal) {
    started.push(structuredClone(input));
    await new Promise<void>(resolve => {
      let finished = false;
      const control: Control = { input, observation: observation(input), emit() {
        this.observation.sequence++; this.observation.observedAt = now();
        this.observation.snapshot.stateDigest = mathDigest(`${input.id}:${this.observation.sequence}`);
        send({ type: 'observation', observation: structuredClone(this.observation) });
      }, finish() {
        if (finished) return; finished = true;
        send({ type: 'result', result: { status: 'incomplete', proof: '', report: { fixture: true } } }); resolve();
      } };
      controls.set(input.id, control);
      signal.addEventListener('abort', () => resolve(), { once: true });
      send({ type: 'progress', event: 'solve_started', message: 'Started controlled research fixture' }); control.emit();
    });
  },
  async command(runId, command) {
    const control = controls.get(runId)!;
    if (command.type === 'capture') return { id: 'capture', status: 'captured', observation: structuredClone(control.observation) };
    if (command.type === 'guidance-withdraw') return { id: command.id, status: 'rejected', reason: 'fixture_guidance_withdraw_not_simulated' };
    if (command.type === 'plan-approval') {
      approvals.push({ runId, ...command.approval });
      assert.equal(command.approval.planVersion, control.observation.inspection.planApproval!.planVersion,
        'Approval must refer to the exact plan the person currently sees');
      return { id: command.approval.id, status: 'queued', planVersion: command.approval.planVersion };
    }
    if (command.type === 'guidance') {
      assert.ok(control.input.input.workers >= 2, 'A single worker cannot accept cooperative guidance');
      const record: WebGuidanceRecord = { ...structuredClone(command.guidance), status: 'queued', createdAt: now(), updatedAt: now() };
      guidance.push({ runId, record }); control.observation.guidance.push(record); control.emit();
      return { id: record.id, status: 'queued', guidance: structuredClone(record), observation: structuredClone(control.observation) };
    }
    const proposal = command.proposal;
    assert.equal(proposal.baseVersion, control.observation.plan!.baseVersion);
    const parsed = parseCooperationPlan(problem, proposal);
    edits.push({ runId, preview: command.type === 'edit-preview', proposal: structuredClone(proposal) });
    if (command.type === 'edit-preview') return { id: proposal.id, status: 'validated', affectedTaskIds: parsed.tasks.map(task => task.id) };
    control.observation.plan = { ...structuredClone(proposal), tasks: parsed.tasks, groups: parsed.groups };
    for (const task of control.observation.inspection.tasks) {
      const updated = parsed.tasks.find(item => item.id === task.id)!;
      task.objective = updated.objective; task.version = taskVersion(updated);
    }
    revise(control, 'plan-v2');
    control.observation.inspection.edits.push({ id: proposal.id, status: 'applied', baseVersion: proposal.baseVersion,
      planVersion: 'plan-v2', affectedTasks: parsed.tasks.map(task => task.id), recheck: { status: 'pending', tasks: [] } });
    control.emit();
    return { id: proposal.id, status: 'queued', observation: structuredClone(control.observation) };
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: path.join(temporary, 'data') });
config.providers = [{ id: 'sub2api', name: 'Local fixture', baseUrl: `http://127.0.0.1:${provider.port}/v1` }];
const service = createWebService(config, runner);
const checks: string[] = [], errors: string[] = [], external: string[] = [], expectedNetworkErrors: string[] = [];
const offlineChecks = new WeakSet<Page>();
const checkpoints: unknown[] = [];
let browser: Browser | undefined, activePage: Page | undefined, currentCheck = 'Start';
const mark = (value: string) => { checks.push(value); console.log(`PASS ${value}`); };
async function checkpoint(page: Page, label: string) {
  checkpoints.push(await page.evaluate(label => ({ label, url: location.href, title: document.title,
    body: { ...document.body.dataset }, statementDecisions: document.querySelectorAll('[data-chat-statement-decision]').length,
    planDecisions: document.querySelectorAll('[data-chat-plan-decision]').length,
    thread: document.querySelector('#research-chat-thread')?.textContent?.slice(0, 3000) }), label));
}
async function eventually(check: () => boolean, description: string) {
  const until = Date.now() + 15_000;
  while (!check()) { assert.ok(Date.now() < until, description); await new Promise(resolve => setTimeout(resolve, 40)); }
}
async function closeArtifacts(page: Page) {
  if (await page.locator('#close-research-output').isVisible()) await page.locator('#close-research-output').click();
}
async function fillKey(page: Page) {
  if (!await page.locator('#formalize-key').isVisible()) await clickWorkbenchAction(page, '#open-settings');
  await page.locator('#formalize-key').fill('sk-human-decisions-disposable-fixture');
  if (await page.locator('#formalize-settings').getAttribute('open') !== null) await page.locator('#formalize-settings > summary').click();
}
async function fit(page: Page, selector: string, label: string) {
  await settled(page);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: page overflow`);
  for (const node of await page.locator(`${selector} button:visible, ${selector} input:visible, ${selector} select:visible`).all()) {
    const box = await node.boundingBox();
    assert.ok(box && box.width > 0 && box.x >= -1 && box.x + box.width <= page.viewportSize()!.width + 1,
      `${label}: control must fit: ${await node.getAttribute('aria-label') ?? await node.innerText()}`);
    assert.ok((await node.getAttribute('aria-label') ?? await node.innerText()).trim() || await node.getAttribute('type') === 'radio',
      `${label}: each action has a name`);
  }
}
async function open(width: number, locale: 'zh' | 'en') {
  const context = await browser!.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [localeStorageKey, locale]);
  const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', error => errors.push(`${locale}/${width}: ${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = `${locale}/${width}: ${message.text()}`;
    if (offlineChecks.has(page) && /net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED)/u.test(message.text())) expectedNetworkErrors.push(text);
    else errors.push(text);
  });
  const writes: { path: string; body: any }[] = [];
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
    if (request.method() === 'POST') writes.push({ path: url.pathname, body: request.postDataJSON() });
    return route.continue();
  });
  await page.goto(origin); await openChatParticipation(page);
  return { context, page, writes };
}
async function startStatement(page: Page, automatic = false) {
  const count = formalizations.length;
  if (automatic) await page.locator('input[name="chat-participation"][value="automatic"]').check();
  await page.locator('#formalize-original').fill(webFormalizationStatement);
  if (!await page.locator('#formalize-key').isVisible()) await clickWorkbenchAction(page, '#open-settings');
  await page.locator('#formalize-key').fill('sk-human-decisions-disposable-fixture');
  await openAdvancedChatSettings(page);
  await page.locator('#formalize-environment').selectOption('standard');
  await page.locator('#formalize-settings > summary').click();
  await page.locator('#formalize-start:enabled').click();
  await eventually(() => formalizations.length === count + 1, 'One statement is formalized');
  const pending = formalizations.at(-1)!;
  const evidence = webFormalizationEvidence(pending.input);
  pending.send({ type: 'activity', activity: { type: 'step', step: { round: 1, step: 'role', workerId: 'recorded-backtranslation', role: 'backtranslate', slot: 'backtranslate',
    state: 'finished', summary: { sections: [{ kind: 'conclusions', items: [pending.input.original] }] } } } });
  pending.send({ type: 'result', status: 'approved', evidence }); pending.finish();
  return { pending, evidence };
}
try {
  browser = await startBrowser(service.server, port);
  for (const locale of ['zh', 'en'] as const) for (const width of [1440, 390, 320]) {
    const label = `${locale} ${width}px`, { context, page, writes } = await open(width, locale);
    let releaseWorkspace: (() => void) | undefined;
    if (locale === 'zh') {
      const workspace = new Promise<void>(resolve => { releaseWorkspace = resolve; });
      await page.route('**/chunks/runViews-*.js', async route => { await workspace; await route.continue(); });
    }
    const runCount = started.length;
    currentCheck = `${label}: visible participation and statement confirmation`;
    assert.equal(await page.locator('input[name="chat-participation"][value="guided"]').isChecked(), true);
    assert.match(await page.locator('[data-chat-participation]').innerText(), /2\s*(?:个\s*)?Agents?/iu);
    await fit(page, '[data-chat-participation]', label);
    const { pending, evidence } = await startStatement(page);
    const submitted = writes.find(item => item.path === '/api/formalizations')!.body;
    assert.equal(submitted.solve, true); assert.equal(submitted.humanReview, true);
    await closeArtifacts(page);
    const statement = page.locator('[data-chat-statement-decision]'); await statement.waitFor();
    await page.locator('[data-chat-math-finding]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('[data-chat-next-action]').count(), 0, 'the confirmation card supplies its own action without an outer duplicate');
    assert.equal(await page.locator('[data-chat-math-summary]').count(), 0, 'the recorded statement is not repeated beside the same confirmation text');
    assert.equal(started.length, runCount, 'Without human statement confirmation no research run starts');
    assert.equal((await (await page.request.get(`${origin}/api/formalizations/${pending.input.id}`)).json()).formalization.status, 'review');
    await page.locator('[data-research-artifact="original"]').first().click();
    await page.locator('#chat-original-panel').waitFor();
    assert.match(await page.locator('#chat-original-panel').innerText(), /theorem addition/u);
    await closeArtifacts(page);
    assert.equal(started.length, runCount, 'Reading original/Lean does not confirm or start proof');
    await checkpoint(page, `${label}: before pending-statement reload`);
    await page.reload(); await statement.waitFor(); await closeArtifacts(page);
    await checkpoint(page, `${label}: after pending-statement reload`);
    assert.equal(started.length, runCount, 'Reload preserves the pending human decision');
    // The temporary provider credential deliberately does not survive navigation.
    await fillKey(page);
    await checkpoint(page, `${label}: after opening settings and refilling key`);
    await fit(page, '[data-chat-statement-decision]', label);
    await page.screenshot({ path: path.join(output, `statement-${locale}-${width}.png`), fullPage: true });
    await page.locator('[data-chat-confirm-statement]:enabled').click();
    await eventually(() => started.length === runCount + 1, 'Statement confirmation starts exactly one research run');
    const run = started.at(-1)!, control = controls.get(run.id)!;
    assert.equal(run.input.workers, 2); assert.equal(run.input.coordination, 'cooperative'); assert.equal(run.input.planApproval, true);
    assert.equal(writes.find(item => item.path.endsWith('/confirm'))!.body.evidenceSha256, formalizationDigest(evidence));
    await closeArtifacts(page);
    const decision = page.locator('[data-chat-plan-decision]'); await decision.waitFor();
    assert.equal(await page.locator('[data-chat-next-action]').count(), 0, 'the plan card supplies its own next action');
    assert.ok((await decision.innerText()).includes(initial.tasks[0]!.objective), 'The decision shows actual plan tasks');
    if (releaseWorkspace) {
      currentCheck = `${label}: first task action waits for the workspace module`;
      if (width === 390) {
        await decision.locator('[data-decision-summary-details] > summary').click();
        await decision.locator('.decision-summary-tasks button').first().click();
        await page.locator('#detail-tab-trajectory[aria-selected="true"]').waitFor();
        releaseWorkspace();
        await page.locator('[data-roadmap-node="task:approach"][aria-pressed="true"]').waitFor();
        mark(`${label}: the first task link selects its roadmap node after the delayed workspace module loads`);
      } else {
        await page.locator('[data-chat-edit-plan]').click();
        await page.locator('#detail-tab-collaboration[aria-selected="true"]').waitFor();
        assert.equal(await page.locator('.collab-plan-dialog[open]').count(), 0);
        if (width === 320) await closeArtifacts(page);
        releaseWorkspace();
        if (width === 320) {
          await page.locator('#detail-panel .collab-surface').waitFor({ state: 'attached' });
          assert.equal(await page.locator('.collab-plan-dialog[open]').count(), 0);
          mark(`${label}: returning to the conversation cancels a pending first plan edit`);
        } else {
          await page.locator('.collab-plan-dialog[open]').waitFor();
          await page.locator('[data-plan-close]').click();
          mark(`${label}: the first plan edit opens after its delayed workspace module loads`);
        }
      }
      await closeArtifacts(page);
    }
    if (locale === 'zh' && width === 1440) {
      currentCheck = `${label}: an observation without a cooperative plan does not advertise guidance`;
      const planned = structuredClone(control.observation);
      control.observation.plan = null;
      control.observation.inspection.phase = 'preparing';
      control.observation.inspection.tasks = [];
      delete control.observation.inspection.planVersion;
      control.observation.inspection.planApproval = { required: true, status: 'awaiting-plan', rejections: [], leadRevising: false };
      control.emit();
      await page.locator('[data-chat-review-plan]').waitFor({ state: 'detached' });
      assert.equal(await page.locator('[data-chat-guidance-mode-open], [data-research-guidance]').count(), 0,
        'Two configured workers and a preparing observation do not yet provide a cooperative guidance recipient');
      control.observation.plan = planned.plan;
      control.observation.inspection = planned.inspection;
      control.emit();
      await page.locator('[data-chat-review-plan]').waitFor();
      await page.locator('[data-chat-guidance-mode-open]').waitFor();
      assert.equal(guidance.length, 0, 'Preparing and restoring the plan sends no guidance command');
      mark(`${label}: preparing observation hides guidance until the cooperative plan exists`);
    }
    assert.equal(control.observation.inspection.workers.find(worker => worker.id === 'engineer')!.turns, 0);
    await fit(page, '[data-chat-plan-decision]', label);
    await page.screenshot({ path: path.join(output, `plan-${locale}-${width}.png`), fullPage: true });
    mark(`${label}: guided is visible by default; reading/reloading never starts proof; confirming exact evidence starts a gated two-Agent plan`);

    currentCheck = `${label}: offline decisions preserve the current task`;
    const approvalsBeforeOffline = approvals.length, editsBeforeOffline = edits.length;
    offlineChecks.add(page);
    try {
      await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await page.locator('[data-chat-approve-plan]:disabled').waitFor();
      assert.equal(await page.locator('[data-chat-edit-plan]').isDisabled(), true);
      assert.equal(await decision.isVisible(), true, 'The recorded plan remains readable while disconnected');
      await page.locator('[data-chat-approve-plan]').evaluate((button: HTMLButtonElement) => button.click());
      await page.locator('[data-chat-edit-plan]').evaluate((button: HTMLButtonElement) => button.click());
      assert.equal(approvals.length, approvalsBeforeOffline); assert.equal(edits.length, editsBeforeOffline);
      assert.equal(await page.locator('.collab-plan-dialog[open]').count(), 0, 'Disconnected editing does not open a stale editor');
    } finally {
      await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    }
    await page.locator('[data-chat-approve-plan]:enabled').waitFor();
    await page.locator('[data-chat-edit-plan]:enabled').waitFor();
    offlineChecks.delete(page);
    assert.equal(started.length, runCount + 1); assert.equal(approvals.length, approvalsBeforeOffline); assert.equal(edits.length, editsBeforeOffline);
    mark(`${label}: disconnect disables approval and editing; reconnect restores both without changing or restarting the research`);

    currentCheck = `${label}: plan navigation, preview and application`;
    await page.locator('[data-chat-review-plan]').click();
    await page.locator('#detail-tab-collaboration[aria-selected="true"]').waitFor();
    assert.equal(await page.locator('#run-detail').isVisible(), true, 'Opening the plan replaces any live workspace');
    await closeArtifacts(page);
    await page.locator('[data-chat-edit-plan]').click();
    const dialog = page.locator('.collab-plan-dialog[open]'); await dialog.waitFor();
    await page.locator('[data-plan-task]').selectOption('approach');
    const revisedObjective = 'Use Nat.add_comm while preserving the original theorem';
    await page.locator('[data-plan-objective]').fill(revisedObjective);
    assert.equal(await page.locator('[data-plan-apply]').isDisabled(), true);
    await page.locator('[data-plan-preview]').click(); await page.locator('[data-plan-apply]:enabled').waitFor();
    assert.equal(edits.filter(edit => edit.runId === run.id && !edit.preview).length, 0, 'Preview has no application side effect');
    await page.locator('[data-plan-apply]').click();
    await eventually(() => edits.some(edit => edit.runId === run.id && !edit.preview), 'The editor submits a real validated plan edit');
    assert.equal(control.observation.plan!.tasks.find(task => task.id === 'approach')!.objective, revisedObjective);
    await page.locator('[data-plan-close]').click(); await closeArtifacts(page);
    await page.waitForFunction(text => document.querySelector('[data-chat-plan-decision]')?.textContent?.includes(text), revisedObjective);
    assert.equal(approvals.filter(approval => approval.runId === run.id).length, 0, 'Editing a plan never approves it');

    currentCheck = `${label}: queued approval, version conflict and host confirmation`;
    await page.locator('[data-chat-approve-plan]:enabled').click();
    await eventually(() => approvals.filter(approval => approval.runId === run.id).length === 1, 'One approval command is sent');
    const first = approvals.at(-1)!; assert.equal(first.planVersion, 'plan-v2');
    assert.equal(await page.locator('[data-chat-approve-plan]').isDisabled(), true);
    assert.equal(await decision.isVisible(), true, 'Queued approval is not yet host-confirmed approval');
    assert.equal(control.observation.inspection.workers.find(worker => worker.id === 'engineer')!.turns, 0);
    revise(control, 'plan-v3');
    control.observation.inspection.planApproval!.rejections.push({ id: first.id, planVersion: first.planVersion,
      reason: 'math_plan_approval_version_conflict', at: Date.now() }); control.emit();
    await page.locator('[data-chat-review-current-plan]').click();
    await page.locator('[data-chat-approve-plan]:enabled').waitFor();
    assert.match(await decision.innerText(), locale === 'zh' ? /批准.*没有生效|计划.*改|版本/u : /changed|did not|not.*appl|version/iu);
    await page.locator('[data-chat-approve-plan]').click();
    await eventually(() => approvals.filter(approval => approval.runId === run.id).length === 2, 'The corrected version can be approved');
    const approved = approvals.at(-1)!; assert.equal(approved.planVersion, 'plan-v3'); assert.notEqual(approved.id, first.id);
    assert.equal(await decision.isVisible(), true);
    Object.assign(control.observation.inspection.planApproval!, { status: 'approved', approvedId: approved.id,
      approvedVersion: approved.planVersion, approvedAt: Date.now() });
    Object.assign(control.observation.inspection.workers.find(worker => worker.id === 'engineer')!, { phase: 'running', turns: 1 });
    control.observation.inspection.scheduling.working = 1; control.emit();
    await decision.waitFor({ state: 'detached' });
    assert.equal(await page.locator('[data-chat-approve-plan]').count(), 0);
    if (!await page.locator('#chat-live-panel').isVisible()) {
      await openChatResultDetails(page);
      await page.locator('[data-research-artifact="live"]').click();
    }
    await page.locator('[data-live-tab="plan"]').click();
    assert.equal(await page.locator('[data-live-edit-plan]').isEnabled(), true,
      'The person can continue changing the plan after its initial approval');
    await closeArtifacts(page);
    mark(`${label}: chat opens the real plan editor; preview/apply preserve the gate; queued and rejected approvals recover using the current plan version`);

    currentCheck = `${label}: discussion and guidance are separate`;
    const commandsBefore = guidance.length, callsBefore = providerCalls;
    assert.equal(await page.locator('[data-chat-discussion-mode]').getAttribute('aria-pressed'), 'true');
    await page.locator('#formalize-original').fill('Explain the recorded addition strategy.');
    await page.locator('#formalize-start:enabled').click();
    await page.waitForFunction(text => document.querySelector('#research-chat-thread')?.textContent?.includes(text), discussion);
    assert.equal(providerCalls, callsBefore + 1); assert.equal(guidance.length, commandsBefore);
    await page.locator('[data-chat-guidance-mode-open]').click();
    assert.equal(await page.locator('[data-chat-guidance-mode-open]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-chat-guidance-target]').selectOption('approach');
    await page.locator('#formalize-original').fill('Apply Nat.add_comm to the unchanged original goal.');
    await page.locator('#formalize-start:enabled').click();
    await eventually(() => guidance.length === commandsBefore + 1, 'Proof guidance reaches the active research team');
    const sent = guidance.at(-1)!;
    assert.equal(sent.runId, run.id); assert.equal(sent.record.recipient.kind, 'task');
    assert.equal(sent.record.taskRef?.version, control.observation.inspection.tasks.find(task => task.id === 'approach')!.version);
    assert.equal(providerCalls, callsBefore + 1, 'Guidance sends no discussion completion');
    Object.assign(sent.record, { status: 'delivered', deliveredTo: ['engineer'], updatedAt: now() }); control.emit();
    await page.locator(`[data-chat-guidance-receipt="${sent.record.id}"][data-guidance-status="delivered"]`).waitFor();
    await page.reload(); await closeArtifacts(page);
    await page.locator(`[data-chat-guidance-receipt="${sent.record.id}"][data-guidance-status="delivered"]`).waitFor();
    assert.equal(guidance.length, commandsBefore + 1, 'Reload never resends a proof requirement');
    assert.equal(started.length, runCount + 1); assert.equal(writes.filter(write => write.path === '/api/formalizations').length, 1);
    await fit(page, '#formalize-form', label);
    assert.deepEqual(await audit(page), [], `${label}: accessible decisions and composer`);
    await page.screenshot({ path: path.join(output, `guidance-${locale}-${width}.png`), fullPage: true });
    control.finish(); await context.close();
    mark(`${label}: ordinary discussion changes no task, guidance targets the current task version, and delivery survives reload without duplicate work`);
  }

  currentCheck = 'Explicit automatic mode and single-Agent capability';
  {
    const { context, page, writes } = await open(1440, 'zh');
    const before = started.length;
    await startStatement(page, true);
    assert.equal(writes.find(write => write.path === '/api/formalizations')!.body.humanReview, undefined,
      'Automatic mode keeps the existing API contract without a human-review flag');
    await eventually(() => started.length === before + 1, 'Automatic mode starts proof without manual confirmation');
    const run = started.at(-1)!; assert.equal(run.input.workers, 1); assert.equal(run.input.planApproval, undefined);
    await closeArtifacts(page);
    await page.waitForFunction(() => document.querySelector('.research-conversation-status'));
    assert.equal(await page.locator('[data-chat-statement-decision]').count(), 0);
    assert.equal(await page.locator('[data-chat-plan-decision]').count(), 0);
    assert.equal(await page.locator('[data-chat-guidance-mode-open], [data-research-guidance]').count(), 0,
      'A single-Agent run never advertises the unsupported cooperative guidance path');
    await page.getByText('这里发送的是讨论，不会调整正在进行的解题。', { exact: true }).waitFor();
    assert.deepEqual(await audit(page), []);
    controls.get(run.id)!.finish(); await context.close();
    mark('Explicit automatic mode retains the single-Agent flow and exposes no unsupported guidance or approval controls');
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checkedAt: now(), checks,
    statementFixtures: formalizations.length, researchFixtures: started.length, planApprovals: approvals.length,
    planPreviews: edits.filter(edit => edit.preview).length, planApplications: edits.filter(edit => !edit.preview).length,
    guidanceCommands: guidance.length, localDiscussionReplies: providerCalls, expectedNetworkErrors,
    paidModelCalls: false, leanProcesses: 0 }, null, 2) + '\n');
  console.log(`Human decision checks passed. Report and screenshots: ${path.relative(root, output)}`);
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', currentCheck, checks,
    error: error instanceof Error ? error.message : String(error), browserErrors: errors, external, expectedNetworkErrors,
    checkpoints, failureState: await activePage?.evaluate(() => ({ url: location.href, title: document.title,
      body: { ...document.body.dataset }, thread: document.querySelector('#research-chat-thread')?.textContent?.slice(0, 6000) })).catch(() => null),
    paidModelCalls: false, leanProcesses: 0 }, null, 2) + '\n');
  throw error;
} finally {
  for (const pending of formalizations) pending.finish();
  for (const control of controls.values()) control.finish();
  await browser?.close(); await service.close(); provider.stop(true);
  await fs.rm(temporary, { recursive: true, force: true });
}
