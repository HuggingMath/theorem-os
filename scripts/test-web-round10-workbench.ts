#!/usr/bin/env bun
// Real loopback HTTP and disposable records; the runner and discussion provider are controlled fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebObservation } from '../apps/web/collaboration';
import { localeStorageKey } from '../apps/web/i18n';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { deferred, freePort, settled, startBrowser } from './web-scenario';

declare const Bun: { serve(options: { hostname: string; port: number; fetch(request: Request): Response | Promise<Response> }): { port: number; stop(force?: boolean): void } };

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/frontend-round10/workbench');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.access(path.join(staticRoot, 'app.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round10-workbench-'));
const credential = 'sk-local-round10-workbench-fixture', now = () => new Date().toISOString();
const checks: object[] = [], requests: object[] = [], errors: string[] = [], external: string[] = [], providerCalls: object[] = [], commands: object[] = [];
let phase = 'setup', workerCalls = 0, leanChecks = 0, mailCalls = 0, browser: Browser | undefined, active: Page | undefined, failure: unknown;
type Control = { observation: WebObservation; emit(): void; finish(): void };
type Task = { runId: string; id: string; pathname: string; owner: string };
const controls = new Map<string, Control>();
function observation(id: string): WebObservation {
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: 'fixture-' + id, stateDigest: mathDigest('initial'), resultDigest: null };
  const task = { id: 'goal', kind: 'goal' as const, objective: 'Use the stated premise to prove the current goal', group: 'main', status: 'pending', control: 'active',
    version: 'goal-v1', theorem: 'workbench_goal', type: 'True', premises: [], plannedDependencies: [], attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1, evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    inspection: { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot, evidence: 'recorded-not-replayed', phase: 'cooperative',
      problem: { id: 'round10-workbench-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'workbench_goal', proofPath: 'Main.lean' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative', buildDigest: mathDigest('build'), environmentDigest: mathDigest('environment') }, turns: 1, planVersion: 'plan-v1',
      scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
      knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded', droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] },
      tokenBudget: {}, continuation: {}, mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: mathDigest('math'), obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
      progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['goal'] }, groups: [], tasks: [task], workers: [], statementReviews: [], edits: [] },
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [{ id: 'goal', kind: 'goal', objective: task.objective, dependsOn: [], revision: 0, theoremName: 'workbench_goal', proofPath: 'Main.lean', type: 'True' }] },
    history: [], sources: [], checks: [], guidance: [], coverage: { sources: 'partial', checks: 'partial' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Isolated Round10 workbench runner' }; },
  async check() { leanChecks++; throw new Error('Workbench regressions must not check Lean'); },
  async run(input, send, signal) { workerCalls++; await new Promise<void>(resolve => {
    const control: Control = { observation: observation(input.id), finish: resolve, emit() {
      this.observation.sequence++; this.observation.observedAt = now(); this.observation.snapshot.stateDigest = mathDigest('state-' + this.observation.sequence);
      send({ type: 'observation', observation: structuredClone(this.observation) });
    } }; controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true }); control.emit();
  }); },
  async command(runId, command) {
    const control = controls.get(runId)!;
    if (command.type === 'capture') return { id: 'capture', status: 'captured', observation: structuredClone(control.observation) };
    if (command.type !== 'guidance') throw new Error('Unexpected workbench command');
    commands.push({ phase, runId, input: structuredClone(command.guidance) });
    const guidance = { ...command.guidance, status: 'delivered' as const, deliveredTo: ['fixture-lead'], createdAt: now(), updatedAt: now() };
    control.observation.guidance.push(guidance); control.emit();
    return { id: guidance.id, status: 'delivered', guidance, observation: structuredClone(control.observation) };
  },
};
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request: Request) {
  assert.equal(new URL(request.url).pathname, '/v1/responses');
  const body = await request.json() as { model: string; input: unknown[] };
  providerCalls.push({ phase, model: body.model, lastQuestion: body.input.at(-1) });
  return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Local discussion fixture answer; no Lean or research action was performed.' }] }] });
} });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '4' });
config.providers = [{ id: 'local', name: 'Local workbench fixture', baseUrl: `http://127.0.0.1:${provider.port}/v1` }];
const service = createWebService(config, runner, { sample: null, mailer: async () => { mailCalls++; throw new Error('Workbench regressions must not send mail'); } });
async function open(width = 1440, locale: 'zh' | 'en' = 'zh') {
  const ctx = await browser!.newContext({ viewport: { width, height: width < 850 ? 844 : 1000 }, reducedMotion: 'reduce', locale: locale === 'zh' ? 'zh-CN' : 'en-US' });
  await ctx.addInitScript(({ key, locale }) => localStorage.setItem(key, locale), { key: localeStorageKey, locale });
  await ctx.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
  });
  const page = active = await ctx.newPage(); page.setDefaultTimeout(12_000); page.on('pageerror', error => errors.push(`${phase}: ${error.message}`));
  page.on('request', request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    let body: any; try { body = request.postDataJSON(); if (body && 'apiKey' in body) body.apiKey = '[fixture key omitted]'; } catch { /* GET */ }
    requests.push({ phase, method: request.method(), pathname: url.pathname, ...(body ? { body } : {}) });
  });
  await page.goto(origin); await page.locator('#formalize-original').waitFor();
  assert.match(await page.locator('html').getAttribute('lang') ?? '', locale === 'zh' ? /^zh/u : /^en/u);
  return { ctx, page };
}
async function http(page: Page, method: string, pathname: string, input?: unknown): Promise<any> {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); if (!response.ok) throw new Error(`Fixture HTTP ${response.status}: ${body.error}`);
    return body;
  }, { method, pathname, input });
}
async function task(page: Page, ctx: BrowserContext): Promise<Task> {
  const run = (await http(page, 'POST', '/api/runs', { requestId: crypto.randomUUID(), providerId: 'local', apiKey: credential, model: 'fixture', effort: 'low',
    environment: 'standard', source: 'theorem workbench_goal : True := by sorry\n', task: 'Round10 workbench recovery', maxTurns: 2, maxRunSeconds: 600, workers: 2, coordination: 'cooperative' })).run;
  await page.waitForFunction(async id => !!(await (await fetch(`/api/runs/${id}`)).json()).run.observation, run.id);
  const conversation = (await http(page, 'POST', '/api/conversations', { runId: run.id })).conversation;
  const owner = (await ctx.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
  await page.goto(`${origin}/?chat=${conversation.id}`); await page.locator(`[data-conversation="${conversation.id}"]`).waitFor();
  await page.locator('[data-chat-guidance-mode-open]').waitFor();
  return { runId: run.id, id: conversation.id, pathname: `/api/conversations/${conversation.id}`, owner };
}
async function settings(page: Page) {
  if (!await page.locator('#formalize-key').isVisible()) await page.locator('#formalize-settings>summary').click();
}
async function key(page: Page, value = credential) {
  await settings(page); await page.locator('#formalize-key').fill(value); await page.locator('#formalize-settings>summary').click();
}
const stored = (c: Task) => service.conversations.read(c.owner, c.id);
async function complete(c: Task, text: string, count = 1) {
  const until = Date.now() + 10_000;
  while (true) {
    const conversation = stored(c);
    if (conversation.messages.filter(message => message.role === 'user' && message.text === text.trim()).length === count && conversation.messages.at(-1)?.status === 'complete') return conversation;
    assert.ok(Date.now() < until, `The local response completes: ${phase}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function draft(page: Page, c: Task) {
  return page.evaluate(id => {
    const key = Object.keys(sessionStorage).find(key => key.startsWith('theorem-os.chat-draft.') && key.endsWith('.' + id));
    return key ? JSON.parse(sessionStorage.getItem(key)!) : null;
  }, c.id);
}
async function privacy(page: Page) {
  assert.equal(await page.evaluate(secret => JSON.stringify(sessionStorage).includes(secret) || JSON.stringify(localStorage).includes(secret), credential), false);
}
const mark = (details: object) => { checks.push({ phase, ...details }); console.log(`PASS ${phase}`); };
try {
  browser = await startBrowser(service.server, port);
  for (const [width, locale] of [[1440, 'zh'], [390, 'en']] as const) {
    phase = `guidance/${locale}/${width}`; const { ctx, page } = await open(width, locale);
    let c: Task | undefined;
    try {
      c = await task(page, ctx); const original = 'Unsent guidance: prove the helper before the main target.';
      await page.locator('[data-chat-guidance-mode-open]').click(); await page.locator('[data-chat-guidance-target]').selectOption('goal');
      await page.locator('#formalize-original').fill(original);
      assert.deepEqual((await draft(page, c)).guidance, { runId: c.runId, taskRef: { id: 'goal', version: 'goal-v1' } });
      await page.locator('#topbar-draft').click(); await page.waitForURL(origin + '/');
      await page.goBack(); await page.locator(`[data-conversation="${c.id}"]`).waitFor();
      await page.locator('[data-chat-guidance-mode-open][aria-pressed="true"]').waitFor();
      assert.equal(await page.locator('[data-chat-guidance-target]').inputValue(), 'goal');
      assert.equal(await page.locator('#formalize-original').inputValue(), original);
      await page.reload(); await page.locator('[data-chat-guidance-mode-open][aria-pressed="true"]').waitFor();
      assert.equal(await page.locator('[data-chat-guidance-target]').inputValue(), 'goal');
      assert.deepEqual((await draft(page, c)).guidance.taskRef, { id: 'goal', version: 'goal-v1' });
      const control = controls.get(c.runId)!; control.observation.inspection.tasks[0]!.version = 'goal-v2'; control.emit();
      await page.reload(); await page.locator('[data-chat-guidance-mode-open][aria-pressed="true"]').waitFor();
      const confirm = page.locator('[data-chat-guidance-mode] button:not([data-chat-guidance-cancel])'); await confirm.waitFor();
      assert.equal(await page.locator('#formalize-start').isDisabled(), true);
      assert.deepEqual((await draft(page, c)).guidance.taskRef, { id: 'goal', version: 'goal-v1' }, 'refresh never silently rebinds the observed task');
      await page.screenshot({ path: path.join(output, `guidance-stale-${locale}-${width}.png`) });
      await confirm.click(); assert.equal(await page.locator('#formalize-start').isEnabled(), true);
      assert.deepEqual((await draft(page, c)).guidance.taskRef, { id: 'goal', version: 'goal-v2' });
      const commandBefore = commands.length, providerBefore = providerCalls.length;
      if (width > 850) await page.locator('#formalize-original').press('Enter'); else await page.locator('#formalize-start').click();
      await page.locator('[data-chat-guidance-receipt][data-guidance-status="delivered"]').waitFor();
      assert.equal(commands.length, commandBefore + 1); assert.equal(providerCalls.length, providerBefore);
      assert.deepEqual((commands.at(-1) as any).input.taskRef, { id: 'goal', version: 'goal-v2' });
      await page.locator('[data-chat-guidance-mode-open]').click(); await page.locator('#formalize-original').fill('Guidance to the lead survives refresh.');
      await page.reload(); await page.locator('[data-chat-guidance-mode-open][aria-pressed="true"]').waitFor();
      assert.equal(await page.locator('[data-chat-guidance-target]').inputValue(), '');
      await page.locator('[data-chat-guidance-cancel]').click(); await page.reload();
      await page.locator('[data-chat-discussion-mode][aria-pressed="true"]').waitFor();
      assert.equal(await page.locator('[data-chat-guidance-target]').count(), 0); assert.equal((await draft(page, c)).guidance, undefined);
      await privacy(page); mark({ restoredAfterBackAndRefresh: true, restoredTaskVersion: 'goal-v1', explicitConfirmedVersion: 'goal-v2',
        guidanceCommands: 1, discussionCalls: 0, leadModeRestored: true, explicitDiscussionPersists: true });
    } finally { if (c) controls.get(c.runId)?.finish(); await ctx.close(); }
  }

  // The workspace lists the plan next to the conversation; a task there addresses guidance to itself in the composer.
  for (const [width, locale] of [[1440, 'zh'], [390, 'en']] as const) {
    phase = `workspace-guidance/${locale}/${width}`; const { ctx, page } = await open(width, locale);
    let c: Task | undefined;
    try {
      c = await task(page, ctx); const live = page.locator('#chat-live-panel');
      // A wide screen opens the workspace of a running task by itself; a phone opens it from the status line.
      if (width < 1100) await page.locator('#research-chat-thread [data-research-artifact="live"]').click();
      await live.locator('[data-live-plan]').waitFor();
      const row = live.locator('[data-live-task="goal"]');
      assert.equal(await row.getAttribute('data-tone'), 'pending');
      assert.equal(await live.locator('[data-live-done]').innerText(), locale === 'zh' ? '已完成 0/1' : '0 of 1 done');
      assert.equal(await live.locator('[data-live-failed]').count(), 0);
      // Guidance while the proof runs has one entry, the composer's 指导 Agent; the status line no longer repeats it.
      assert.equal(await page.locator('#research-chat-thread [data-research-guidance]').count(), 0);
      assert.equal(await page.locator('[data-chat-guidance-mode-open]').count(), 1);
      await row.locator('.live-task-head').click();
      const control = controls.get(c.runId)!;
      const recordedTask = control.observation.inspection.tasks[0]!;
      recordedTask.status = 'blocked'; control.emit();
      await page.waitForFunction(() => document.querySelector('[data-live-task="goal"]')?.getAttribute('data-tone') === 'failed');
      assert.equal(await row.locator('.live-task-head').getAttribute('aria-expanded'), 'true', 'A newly failed task preserves the reader’s explicit expansion');
      await row.locator('.live-task-head').click();
      recordedTask.status = 'running'; control.emit();
      await page.waitForFunction(() => document.querySelector('[data-live-task="goal"]')?.getAttribute('data-tone') === 'active');
      assert.equal(await row.locator('.live-task-head').getAttribute('aria-expanded'), 'false', 'A retry preserves the reader’s explicit collapse');
      await row.locator('.live-task-head').click();
      await row.locator('[data-live-guide="goal"]').click();
      await page.locator('[data-chat-guidance-mode-open][aria-pressed="true"]').waitFor();
      assert.equal(await page.locator('[data-chat-guidance-target]').inputValue(), 'goal');
      assert.equal(await page.locator('#formalize-original').isVisible(), true, 'Guiding a task leaves the reader at the composer');
      assert.deepEqual((await draft(page, c)).guidance, { runId: c.runId, taskRef: { id: 'goal', version: 'goal-v1' } });
      const text = 'Workspace guidance: settle the helper first.';
      const commandBefore = commands.length, providerBefore = providerCalls.length;
      await page.locator('#formalize-original').fill(text); await page.locator('#formalize-start:enabled').click();
      await page.locator('[data-chat-guidance-receipt][data-guidance-status="delivered"]').waitFor();
      assert.equal(commands.length, commandBefore + 1); assert.equal(providerCalls.length, providerBefore, 'Guidance goes to the running research, not to a discussion model');
      assert.equal((commands.at(-1) as any).input.text, text); assert.deepEqual((commands.at(-1) as any).input.taskRef, { id: 'goal', version: 'goal-v1' });
      await privacy(page); mark({ guidedTask: 'goal', delivered: true });
    } finally { if (c) controls.get(c.runId)?.finish(); await ctx.close(); }
  }

  for (const variant of ['retry-original', 'retry-newer', 'reload-original', 'reload-newer', 'not-accepted-newer'] as const) {
    phase = `message/${variant}`; const { ctx, page } = await open(); let c: Task | undefined;
    try {
      c = await task(page, ctx); const current = c;
      const original = '  Explain why this helper proves the current goal.  ', newer = variant.endsWith('newer') ? 'A newer unsent question must remain editable.' : original;
      await key(page); await page.locator('#formalize-original').fill(original);
      let blockReads = true, sent = 0; const ids: string[] = [], statuses: number[] = [], before = providerCalls.length;
      await page.route(origin + c.pathname, async route => {
        if (blockReads && route.request().method() === 'GET') await route.fulfill({ status: 503, json: { error: 'Local read held until recovery' } });
        else await route.continue();
      });
      await page.route(origin + c.pathname + '/messages', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        ids.push(route.request().postDataJSON().requestId); sent++;
        if (sent === 1 && variant === 'not-accepted-newer') { await route.abort('failed'); return; }
        const response = await route.fetch(); statuses.push(response.status());
        if (sent === 1) { assert.equal(response.status(), 202); await route.abort('failed'); }
        else await route.fulfill({ response });
      });
      await page.locator('#formalize-start').click(); await page.locator('#formalize-error').waitFor();
      assert.equal((await draft(page, c)).pendingMessage.requestId, ids[0]); assert.ok(ids[0]);
      if (variant !== 'not-accepted-newer') await complete(c, original);
      await page.locator('#formalize-original').fill(newer);
      const pendingBefore = await draft(page, c);
      if (variant.startsWith('reload')) {
        blockReads = false; await page.reload(); await page.locator(`[data-conversation="${c.id}"]`).waitFor();
        await page.waitForFunction(value => (document.querySelector('#formalize-original') as HTMLTextAreaElement)?.value === value,
          variant.endsWith('newer') ? newer : '');
        assert.equal(await page.locator('#formalize-key').inputValue(), '');
        assert.equal(sent, 1, 'a successful GET recovers acceptance without another send');
      } else {
        if (variant !== 'not-accepted-newer') await key(page, '');
        await page.locator('#formalize-error button').click();
        await page.waitForFunction(value => (document.querySelector('#formalize-original') as HTMLTextAreaElement)?.value === value,
          variant.endsWith('newer') ? newer : '');
        assert.equal(sent, 2); assert.equal(ids[1], ids[0], 'delivery retry preserves the original send identity');
      }
      await page.waitForFunction(id => {
        const key = Object.keys(sessionStorage).find(key => key.startsWith('theorem-os.chat-draft.') && key.endsWith('.' + id));
        return key && !JSON.parse(sessionStorage.getItem(key)!).pendingMessage;
      }, c.id);
      const completed = await complete(c, original);
      assert.equal(completed.messages.filter(message => message.requestId === ids[0]).length, 1);
      assert.equal(providerCalls.length - before, 1); assert.equal((await draft(page, c)).pendingMessage, undefined);
      assert.equal(await page.locator('#formalize-original').inputValue(), variant.endsWith('newer') ? newer : '');
      assert.equal(await page.locator('#formalize-error').count(), 0, 'acceptance clears the send error it resolves');
      await page.screenshot({ path: path.join(output, `message-${variant}.png`) });
      // Identical text intentionally sent again gets a new identity and a second answer.
      blockReads = false; await key(page); await page.locator('#formalize-original').fill(original);
      await page.locator('#formalize-start').click(); const repeated = await complete(c, original, 2);
      const questions = repeated.messages.filter(message => message.role === 'user' && message.text === original.trim());
      assert.notEqual(questions[0]!.requestId, questions[1]!.requestId); assert.equal(providerCalls.length - before, 2);
      await privacy(page); mark({ acceptedBeforeLoss: variant !== 'not-accepted-newer', originalRequestId: ids[0], sentIds: ids,
        statuses, pendingBefore, originalQuestionCountAfterRecovery: 1, providerCallsAfterRecovery: 1,
        newerDraftPreserved: variant.endsWith('newer'), intentionalRepeatAllowed: true, runId: current.runId });
    } finally { if (c) controls.get(c.runId)?.finish(); await ctx.close(); }
  }

  phase = 'message/definitive-refusal-can-be-corrected';
  {
    const { ctx, page } = await open(); let c: Task | undefined;
    try {
      c = await task(page, ctx); await key(page); const before = providerCalls.length;
      await page.locator('#formalize-original').fill('x'.repeat(4001));
      const refused = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === c!.pathname + '/messages');
      await page.locator('#formalize-start').click(); assert.equal((await refused).status(), 400); await page.locator('#formalize-error').waitFor();
      assert.equal((await draft(page, c)).pendingMessage, undefined, 'a definitive refusal does not lock the rejected request identity');
      const corrected = 'A valid corrected question after a definitive refusal.';
      await page.locator('#formalize-original').fill(corrected); await page.locator('#formalize-start').click(); await complete(c, corrected);
      assert.equal(providerCalls.length - before, 1); await privacy(page);
      mark({ refusalStatus: 400, correctedDraftAccepted: true, discussionCalls: 1 });
    } finally { if (c) controls.get(c.runId)?.finish(); await ctx.close(); }
  }

  phase = 'message/late-receipt-other-draft';
  {
    const { ctx, page } = await open(); let c: Task | undefined; const release = deferred();
    try {
      c = await task(page, ctx); const held = deferred(), before = providerCalls.length;
      await key(page); await page.locator('#formalize-original').fill('Accepted question before opening a different draft.');
      await page.route(origin + c.pathname + '/messages', async route => {
        const response = await route.fetch(); assert.equal(response.status(), 202); held.resolve(); await release.promise; await route.fulfill({ response });
      });
      await page.locator('#formalize-start').click(); await held.promise;
      await page.locator('#topbar-draft').click(); await page.waitForURL(origin + '/');
      const home = 'Independent new problem must survive the old receipt.'; await page.locator('#formalize-original').fill(home);
      release.resolve(); await complete(c, 'Accepted question before opening a different draft.'); await settled(page);
      assert.equal(new URL(page.url()).search, ''); assert.equal(await page.locator('#formalize-original').inputValue(), home);
      await page.goBack(); await page.locator(`[data-conversation="${c.id}"]`).waitFor();
      assert.equal(await page.locator('#formalize-original').inputValue(), '');
      assert.equal((await draft(page, c)).pendingMessage, undefined); assert.equal(providerCalls.length - before, 1);
      await page.goForward(); await page.waitForURL(origin + '/');
      assert.equal(await page.locator('#formalize-original').inputValue(), home); await privacy(page);
      mark({ lateReceiptKeepsHomeRouteAndDraft: true, originatingSendRecoveredOnBack: true, discussionCalls: 1 });
    } finally { release.resolve(); if (c) controls.get(c.runId)?.finish(); await ctx.close(); }
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(leanChecks, 0); assert.equal(mailCalls, 0);
} catch (error) { failure = error; console.error(error); process.exitCode = 1; await active?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
finally {
  await browser?.close(); for (const control of controls.values()) control.finish(); await service.close(); provider.stop(true);
  await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: now(), staticRoot,
    mode: 'Isolated local HTTP, controlled runner and loopback discussion provider; no real model, Lean or email',
    checks, requests, commands, providerCalls, errors, external, controlledWorkerCalls: workerCalls, leanChecks, mailCalls, temporaryDataRemoved: true,
    ...(failure ? { failedPhase: phase, error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2) + '\n');
}
