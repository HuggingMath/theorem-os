#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page, Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput, WorkerMessage } from '../apps/web/shared';
import type { WebGuidanceInput, WebInspection, WebObservation } from '../apps/web/collaboration';
import type { ResearchFeedback, ResearchFeedbackInput, ResearchProjectDetail, ResearcherProfile } from '../apps/web/researchProjectTypes';
import { deferred, freePort, postRun, preferFullCollaboration, settled, startBrowser, webScenario, writeScenarioReport,
  type ScenarioHarness, type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-discussion-guidance');
await fs.access(path.join(root, 'out/web/research.js'));
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-discussion-guidance-'));
const source = 'theorem discussion_fixture : True := by sorry\n', credential = 'sk-local-discussion-guidance-fixture';
const now = () => new Date().toISOString(), digest = (letter: string) => letter.repeat(64);
type Guidance = Extract<ResearchFeedbackInput, { kind: 'guidance' }>;
type Control = { observation: WebObservation; emit(): void };
type Call = { method: string; pathname: string; body: string | null };
type Harness = ScenarioHarness & { calls: Call[]; effect?: (route: Route) => Promise<boolean> };
const controls = new Map<string, Control>();
const commands: { runId: string; guidance: WebGuidanceInput }[] = [];

function observation(id: string): WebObservation {
  const tasks = [{ id: 'lemma', kind: 'lemma' as const, objective: 'Prove the supporting fact with its assumptions', dependsOn: [], revision: 0,
    theoremName: 'supporting_fact', proofPath: 'Main.lean', type: 'True' },
  { id: 'goal', kind: 'goal' as const, objective: 'Prove the original statement', dependsOn: ['lemma'], revision: 0,
    theoremName: 'discussion_fixture', proofPath: 'Main.lean', type: 'True' }];
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: `fixture-${id}`, stateDigest: digest('a'), resultDigest: null };
  const inspection: WebInspection = { schema: 'deepscientist.math.inspection.v1', runId: snapshot.runId, snapshot,
    evidence: 'recorded-not-replayed', phase: 'cooperative',
    problem: { id: 'discussion-guidance-browser-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [],
      targets: [{ theoremName: 'discussion_fixture', proofPath: 'Main.lean' }] },
    configuration: { model: 'fixture', effort: 'low', workers: 2, coordination: 'cooperative', buildDigest: digest('b'), environmentDigest: digest('e') },
    turns: 1, planVersion: 'fixture-plan-v1',
    scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 0, working: 0, proofAssignments: 0, preparing: 0, stopping: 0, idle: 0, stopped: 0 },
    knowledge: { status: 'disabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded',
      droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
    mathematics: { snapshot: { schema: 'theorem-os.obligation.v1', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', digest: digest('c'),
      obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 64 },
    progress: { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['lemma', 'goal'] }, groups: [],
    tasks: tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective, group: 'main', status: 'pending', control: 'active',
      version: `${task.id}-v1`, theorem: task.theoremName, type: task.type, premises: [], plannedDependencies: task.dependsOn,
      attempts: 0, proof: { status: 'none' }, parkedBy: [], parkedRoutes: {} })), workers: [], statementReviews: [], edits: [] };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: now(), sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot, inspection,
    plan: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'fixture-plan-v1', tasks }, sources: [], checks: [], guidance: [],
    coverage: { sources: 'partial', checks: 'partial' } };
}
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable discussion guidance browser fixture; no model or Lean' }; },
  async run(input, send: (message: WorkerMessage) => void, signal) {
    await new Promise<void>(resolve => {
      const control: Control = { observation: observation(input.id), emit() {
        this.observation.sequence++; this.observation.observedAt = now();
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } };
      controls.set(input.id, control); signal.addEventListener('abort', () => resolve(), { once: true }); control.emit();
    });
  },
  async command(runId, command) {
    assert.equal(command.type, 'guidance', 'discussion conversion only sends mathematical guidance');
    if (command.type !== 'guidance') throw new Error('Unexpected non-guidance fixture command');
    commands.push({ runId, guidance: structuredClone(command.guidance) });
    const control = controls.get(runId)!;
    const guidance = { ...command.guidance, status: 'delivered' as const, deliveredTo: ['fixture-lead'], createdAt: now(), updatedAt: now() };
    control.observation.guidance.push(guidance); control.emit();
    return { id: guidance.id, status: 'delivered', guidance, observation: structuredClone(control.observation) };
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '4' }), runner);
const browser = await startBrowser(service.server, port), suite: ScenarioSuite = { origin, output, checks: [], failedScenario: '' };
const input: WebRunInput = { providerId: 'openai', apiKey: credential, model: 'fixture', effort: 'low', environment: 'standard', source,
  task: 'Review discussions through a fixed research run', maxTurns: 2, maxRunSeconds: 300, workers: 2, coordination: 'cooperative' };
const fixture: { projectId?: string; statementVersionId?: string; runId?: string; ownerId?: string; authorId?: string;
  ownerCookies?: Awaited<ReturnType<BrowserContext['cookies']>>; sources: Record<string, ResearchFeedback> } = { sources: {} };
const projectPath = () => `/api/research/theorems/${fixture.projectId}`;
const feedbackPath = () => `${projectPath()}/feedback`;
const projectUrl = () => `${origin}/theorems.html?${new URLSearchParams({ id: fixture.projectId!, run: fixture.runId!, version: fixture.statementVersionId! })}`;
const article = (page: Page, item: ResearchFeedback) => page.locator(`article#feedback-${item.id}`);
const sent = (h: Harness, item: ResearchFeedback) => h.calls.filter(call => call.method === 'POST' && call.pathname === feedbackPath()
  && call.body && JSON.parse(call.body).sourceFeedbackId === item.id);
const reads = (h: Harness) => h.calls.filter(call => call.method === 'GET' && call.pathname === feedbackPath());
async function httpResult<T>(page: Page, method: string, pathname: string, body?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(async ({ method, pathname, body }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { method, pathname, body }) as Promise<{ status: number; body: T }>;
}
async function http<T>(page: Page, method: string, pathname: string, body?: unknown) {
  const result = await httpResult<T>(page, method, pathname, body);
  assert.ok(result.status >= 200 && result.status < 300, `Fixture ${method} ${pathname}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}
async function request(page: Page, method: string, pathname: string, action: () => Promise<unknown>) {
  const result = page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === pathname)
    .then(async response => { assert.ok(response.ok(), `${method} ${pathname}: ${response.status()}`); return response.json(); });
  await action(); return result;
}
async function profile(page: Page, displayName: string) {
  await page.goto(`${origin}/people.html`); await page.locator('main.research-shell').waitFor();
  const session = await http<{ researcherId: string; profile: ResearcherProfile }>(page, 'GET', '/api/research/session');
  await http(page, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(), expectedRevision: session.profile.revision,
    displayName, visibility: 'public' }); return session.researcherId;
}
async function discuss(page: Page, text: string, visibility: 'members' | 'public') {
  const form = page.locator('form').filter({ has: page.getByLabel('讨论内容', { exact: true }) });
  await form.getByLabel('讨论内容', { exact: true }).fill(text); await form.locator('select').selectOption(visibility);
  const result = await request(page, 'POST', feedbackPath(), () => form.getByRole('button', { name: '保存讨论', exact: true }).click());
  await article(page, result.item).waitFor(); return result.item as ResearchFeedback;
}
async function forward(page: Page, item: ResearchFeedback, recipient = 'lead') {
  const details = article(page, item).locator('[data-forward-discussion]');
  if (!(await details.evaluate(node => (node as HTMLDetailsElement).open))) await details.locator('summary').click();
  const form = details.locator('[data-discussion-guidance-form]');
  await form.locator('[data-forward-run]').selectOption(fixture.runId!);
  await form.locator('[data-forward-recipient] option[value="task:lemma"]').waitFor({ state: 'attached' });
  await form.locator('[data-forward-recipient]').selectOption(recipient);
  await form.locator('button[type="submit"]:enabled').waitFor(); return form;
}
async function fit(page: Page, name: string) {
  await settled(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name} has no horizontal overflow`);
}
function reviseLemma() {
  const control = controls.get(fixture.runId!)!, task = control.observation.inspection.tasks.find(task => task.id === 'lemma')!;
  control.observation.history = [...(control.observation.history ?? []), structuredClone(task)];
  task.version = 'lemma-v2'; task.objective = 'Prove the revised fact with explicit hypotheses'; task.type = 'True ∧ True';
  control.observation.inspection.planVersion = 'fixture-plan-v2'; control.observation.plan!.baseVersion = 'fixture-plan-v2';
  Object.assign(control.observation.plan!.tasks.find(task => task.id === 'lemma')!, { revision: 1, objective: task.objective, type: task.type });
  control.observation.snapshot.stateDigest = digest('d'); control.emit();
}
async function feedbacks(page: Page) { return (await http<{ items: ResearchFeedback[] }>(page, 'GET', feedbackPath())).items; }
function scenario(name: string, run: (h: Harness) => Promise<void>, setup = false) {
  return webScenario(browser, suite, name, run, {
    context: { viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' },
    init: async context => { if (!setup && fixture.ownerCookies) await context.addCookies(fixture.ownerCookies); },
    harness: (page, context) => {
      const h: Harness = { page, context, requests: [], calls: [] };
      h.intercept = async route => {
        const request = route.request(), pathname = new URL(request.url()).pathname;
        h.calls.push({ method: request.method(), pathname, body: pathname === feedbackPath() ? request.postData() : null });
        return await h.effect?.(route) ?? false;
      }; return h;
    }, routes: { local: 'Discussion guidance verification stays on the disposable local service' },
    timeout: { label: 'Discussion guidance', seconds: setup ? 100 : 55 }, failure: { fullPage: true },
    verify: (h, elapsedMs) => ({ name, elapsedMs: elapsedMs(), calls: h.calls }),
  });
}

try {
  await scenario('three identities preserve discussion authorship, forwarding permissions and public visibility', async h => {
    const { page, context } = h;
    const others = await Promise.all([browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }),
      browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })]);
    const errors: string[] = [], external: string[] = [];
    try {
      for (const other of others) {
        await preferFullCollaboration(other);
        other.on('page', page => page.on('pageerror', error => errors.push(error.message)));
        await other.route(/^https?:\/\//u, async route => {
          if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
          else await route.continue();
        });
      }
      const author = await others[0].newPage(), visitor = await others[1].newPage();
      fixture.ownerId = await profile(page, 'Fixture Forwarder A'); fixture.authorId = await profile(author, 'Fixture Author B');
      const visitorId = await profile(visitor, 'Fixture Public Visitor C');
      assert.equal(new Set([fixture.ownerId, fixture.authorId, visitorId]).size, 3);
      let project = (await http<{ item: ResearchProjectDetail }>(page, 'POST', '/api/research/theorems',
        { requestId: crypto.randomUUID(), title: 'Discussion to fixed run guidance', visibility: 'public' })).item;
      fixture.projectId = project.id;
      project = (await http<{ item: ResearchProjectDetail }>(page, 'POST', `${projectPath()}/versions`, {
        requestId: crypto.randomUUID(), expectedRevision: project.revision, statement: 'Prove True with explicit supporting assumptions.', source,
        environment: 'standard', targets: [{ theoremName: 'discussion_fixture', proofPath: 'Main.lean' }], confirmation: { confirmed: true },
      })).item;
      fixture.statementVersionId = project.currentStatementVersionId!;
      project = (await http<{ item: ResearchProjectDetail }>(page, 'PUT', `${projectPath()}/members/${fixture.authorId}`,
        { requestId: crypto.randomUUID(), expectedRevision: project.revision, role: 'reader' })).item;
      const run = await postRun({ page }, input); fixture.runId = run.id;
      await http(page, 'POST', `${projectPath()}/runs`, { requestId: crypto.randomUUID(), expectedRevision: project.revision,
        runId: run.id, statementVersionId: fixture.statementVersionId, exposure: 'public', grants: { guidance: false } });
      await author.goto(projectUrl()); await author.getByLabel('讨论内容', { exact: true }).waitFor();
      const authorsProject = (await http<{ item: ResearchProjectDetail }>(author, 'GET', projectPath())).item;
      assert.equal(authorsProject.permissions.member, true); assert.equal(authorsProject.runs[0].permissions.guidance, false);
      for (const [key, text, visibility] of [
        ['members', 'Member discussion: retain the explicit assumptions before changing the proof route.', 'members'],
        ['public', 'Public discussion: explain the dependency between the supporting fact and the original theorem.', 'public'],
        ['task', 'Task discussion: make the selected contract assumptions explicit.', 'members'],
        ['lost', 'Recovery discussion: preserve the original request while checking a lost response.', 'members'],
      ] as const) fixture.sources[key] = await discuss(author, text, visibility);
      assert.equal(await author.locator('[data-forward-discussion]').count(), 0, 'a reader can discuss without permission to forward to a run');
      const forbidden = await httpResult(author, 'POST', feedbackPath(), { requestId: crypto.randomUUID(), kind: 'guidance',
        sourceFeedbackId: fixture.sources.members.id, text: 'A reader must not send run guidance.', visibility: 'members', recipient: { kind: 'lead' },
        target: { runId: run.id, statementVersionId: fixture.statementVersionId, observationRef: {
          sequence: controls.get(run.id)!.observation.sequence, stateDigest: controls.get(run.id)!.observation.snapshot.stateDigest } } });
      assert.equal(forbidden.status, 403); assert.equal(commands.length, 0);

      await page.goto(projectUrl()); await article(page, fixture.sources.members).waitFor();
      const membersForm = await forward(page, fixture.sources.members);
      assert.equal(await membersForm.locator('[data-forward-text]').inputValue(), fixture.sources.members.text, 'forwarding starts from the original suggestion');
      assert.deepEqual(await membersForm.locator('[data-forward-visibility] option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)), ['members']);
      const membersText = 'Forwarded member guidance: review the original assumptions with the Lead.';
      await membersForm.locator('[data-forward-text]').fill(membersText);
      const membersDerived = (await request(page, 'POST', feedbackPath(), () => membersForm.getByRole('button', { name: '发送运行指导', exact: true }).click())).item as ResearchFeedback;
      assert.equal(membersDerived.sourceFeedbackId, fixture.sources.members.id); assert.equal(membersDerived.author.id, fixture.ownerId);
      assert.equal(membersDerived.visibility, 'members'); assert.equal(membersDerived.delivery.status, 'delivered');
      assert.equal((JSON.parse(sent(h, fixture.sources.members)[0].body!) as Guidance).visibility, 'members');
      assert.equal(commands.length, 1); assert.deepEqual(commands[0].guidance.recipient, { kind: 'lead' });
      const derivedArticle = article(page, membersDerived); await derivedArticle.locator('[data-feedback-source]').waitFor();
      assert.match(await derivedArticle.locator('.research-item-meta').first().innerText(), /Fixture Forwarder A/u);
      assert.match(await derivedArticle.locator('[data-feedback-source]').innerText(), /Fixture Author B/u);
      await article(page, fixture.sources.members).locator(`[data-feedback-forwards] a[href="#feedback-${membersDerived.id}"]`).click();
      await page.waitForFunction(id => location.hash === `#feedback-${id}`, membersDerived.id);
      await derivedArticle.locator(`[data-feedback-source] a[href="#feedback-${fixture.sources.members.id}"]`).click();
      await page.waitForFunction(id => location.hash === `#feedback-${id}`, fixture.sources.members.id);
      assert.equal((await feedbacks(page)).find(item => item.id === fixture.sources.members.id)!.text, fixture.sources.members.text);
      const publicAttempt = JSON.parse(sent(h, fixture.sources.members)[0].body!) as Guidance;
      const protectedSource = await httpResult(page, 'POST', feedbackPath(), { ...publicAttempt, requestId: crypto.randomUUID(), visibility: 'public' });
      assert.equal(protectedSource.status, 403, 'a forged public conversion cannot reveal a members-only source');
      assert.equal(commands.length, 1);

      const publicForm = await forward(page, fixture.sources.public);
      await publicForm.locator('[data-forward-visibility]').selectOption('public');
      await publicForm.locator('[data-forward-text]').fill('Public forwarded guidance: explain and record the dependency choice.');
      const publicDerived = (await request(page, 'POST', feedbackPath(), () => publicForm.getByRole('button', { name: '发送运行指导', exact: true }).click())).item as ResearchFeedback;
      assert.equal(publicDerived.visibility, 'public'); assert.equal(publicDerived.sourceFeedbackId, fixture.sources.public.id);
      await author.reload(); await article(author, membersDerived).locator('[data-feedback-source]').waitFor();
      assert.match(await article(author, fixture.sources.members).locator('[data-feedback-forwards]').innerText(), /Fixture Forwarder A/u);
      assert.match(await article(author, membersDerived).locator('[data-feedback-source]').innerText(), /Fixture Author B/u);
      assert.equal(await author.locator('[data-forward-discussion]').count(), 0);
      await visitor.goto(projectUrl()); await article(visitor, publicDerived).locator('[data-feedback-source]').waitFor();
      const publicRecords = await feedbacks(visitor);
      assert.ok(publicRecords.some(item => item.id === fixture.sources.public.id)); assert.ok(publicRecords.some(item => item.id === publicDerived.id));
      for (const secret of [fixture.sources.members, fixture.sources.task, fixture.sources.lost, membersDerived]) {
        assert.equal(publicRecords.some(item => item.id === secret.id), false); assert.equal(await article(visitor, secret).count(), 0);
      }
      assert.equal(await visitor.locator('.collab-surface').count(), 0); assert.equal(await visitor.locator('[data-forward-discussion]').count(), 0);
      await fit(page, 'forwarding desktop'); await page.screenshot({ path: path.join(output, 'forward-desktop.png'), fullPage: true });
      await visitor.getByRole('button', { name: 'English', exact: true }).click();
      await visitor.getByRole('heading', { name: 'Discussion to fixed run guidance', exact: true }).waitFor();
      await article(visitor, publicDerived).locator('[data-feedback-source]').getByText('View original suggestion', { exact: true }).waitFor();
      await fit(visitor, 'public English mobile'); await visitor.screenshot({ path: path.join(output, 'public-en-mobile.png'), fullPage: true });
      fixture.ownerCookies = await context.cookies(); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    } finally { await Promise.all(others.map(context => context.close())); }
  }, true);

  await scenario('task version confirmation and a missing POST retry keep the exact original and newer draft separate', async h => {
    const { page } = h, source = fixture.sources.task;
    await page.goto(projectUrl()); const form = await forward(page, source, 'task:lemma');
    const originalText = 'Task-specific original guidance for the revised lemma contract.';
    await form.locator('[data-forward-text]').fill(originalText); reviseLemma();
    await form.locator('[data-forward-confirm-version]').waitFor();
    assert.equal(await form.locator('[data-forward-text]').inputValue(), originalText);
    assert.equal(await form.locator('button[type="submit"]').isDisabled(), true, 'a stale task target requires explicit confirmation');
    assert.match(await form.locator('[data-forward-version-issue]').innerText(), /lemma-v2/u);
    await fit(page, 'task version confirmation'); await page.screenshot({ path: path.join(output, 'task-version-desktop.png'), fullPage: true });
    await form.locator('[data-forward-confirm-version]').click(); await form.locator('button[type="submit"]:enabled').waitFor();
    let aborted = false;
    h.effect = async route => {
      if (aborted || route.request().method() !== 'POST' || new URL(route.request().url()).pathname !== feedbackPath()) return false;
      if (JSON.parse(route.request().postData()!).sourceFeedbackId !== source.id) return false;
      aborted = true; await route.abort('failed'); return true;
    };
    const deliveredBefore = commands.length;
    await form.getByRole('button', { name: '发送运行指导', exact: true }).click();
    await form.locator('[data-forward-retry]:enabled').waitFor();
    const originalBody = sent(h, source)[0].body!, original = JSON.parse(originalBody) as Guidance;
    assert.equal(original.target.taskRef!.version, 'lemma-v2'); assert.equal(original.target.statementVersionId, fixture.statementVersionId);
    assert.equal(original.sourceFeedbackId, source.id); assert.equal(original.text, originalText);
    assert.deepEqual(original.recipient, { kind: 'task', id: 'lemma' });
    assert.equal(commands.length, deliveredBefore); assert.ok(reads(h).length >= 1, 'uncertain submission is checked with a real feedback GET');
    assert.equal((await feedbacks(page)).some(item => item.requestId === original.requestId), false);
    const newerText = 'A newer Lead draft remains local while retrying the original task guidance.';
    await form.locator('[data-forward-text]').fill(newerText); await form.locator('[data-forward-recipient]').selectOption('lead');
    assert.equal(await form.locator('button[type="submit"]').isDisabled(), true);
    const writesBefore = sent(h, source).length;
    await request(page, 'GET', feedbackPath(), () => form.locator('[data-forward-receipt]').click());
    await form.locator('[data-forward-retry]:enabled').waitFor(); assert.equal(sent(h, source).length, writesBefore, 'manual receipt inspection does not post');
    const callCount = h.calls.length;
    const accepted = await request(page, 'POST', feedbackPath(), () => form.locator('[data-forward-retry]').click());
    await form.locator('[data-forward-pending]').waitFor({ state: 'hidden' });
    assert.equal(sent(h, source).length, 2); assert.equal(sent(h, source)[1].body, originalBody, 'retry reuses the entire original request body');
    assert.deepEqual(h.calls.slice(callCount).filter(call => call.pathname === feedbackPath()).map(call => call.method), ['GET', 'POST']);
    assert.equal(accepted.item.requestId, original.requestId); assert.equal(commands.length, deliveredBefore + 1);
    assert.equal(commands.at(-1)!.guidance.taskRef!.version, 'lemma-v2');
    assert.equal(await form.locator('[data-forward-text]').inputValue(), newerText);
    assert.equal(await form.locator('[data-forward-recipient]').inputValue(), 'lead');
    await form.locator('button[type="submit"]:enabled').waitFor();
    assert.equal((await feedbacks(page)).filter(item => item.sourceFeedbackId === source.id && item.requestId === original.requestId).length, 1);
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('heading', { name: 'Discussion to fixed run guidance', exact: true }).waitFor();
    const english = await forward(page, source, 'lead');
    await english.getByRole('button', { name: 'Send run guidance', exact: true }).waitFor();
    assert.equal(await article(page, source).locator('[data-forward-discussion] summary').innerText(), 'Forward to a run');
    await fit(page, 'forward form English mobile'); await page.screenshot({ path: path.join(output, 'forward-en-mobile.png'), fullPage: true });
  });

  await scenario('a persisted POST with a lost response is recovered by GET without duplicating delivery or overwriting edits', async h => {
    const { page } = h, source = fixture.sources.lost;
    await page.goto(projectUrl()); const form = await forward(page, source);
    const text = 'An accepted Lead instruction whose response will be lost.';
    await form.locator('[data-forward-text]').fill(text);
    // A same-text record from another source is a real response-list distractor, not a mocked GET.
    const control = controls.get(fixture.runId!)!;
    await http(page, 'POST', feedbackPath(), { requestId: crypto.randomUUID(), kind: 'guidance', sourceFeedbackId: fixture.sources.members.id,
      text, visibility: 'members', recipient: { kind: 'lead' }, target: { runId: fixture.runId, statementVersionId: fixture.statementVersionId,
        observationRef: { sequence: control.observation.sequence, stateDigest: control.observation.snapshot.stateDigest } } });
    const accepted = deferred(), release = deferred(); let dropped = false;
    h.effect = async route => {
      if (dropped || route.request().method() !== 'POST' || new URL(route.request().url()).pathname !== feedbackPath()) return false;
      if (JSON.parse(route.request().postData()!).sourceFeedbackId !== source.id) return false;
      dropped = true; const response = await route.fetch(); assert.equal(response.status(), 201);
      accepted.resolve(); await release.promise; await route.abort('failed'); return true;
    };
    const deliveredBefore = commands.length;
    const newerText = 'New edited draft kept after the original Lead delivery is recovered.';
    try {
      await form.getByRole('button', { name: '发送运行指导', exact: true }).click(); await accepted.promise;
      assert.equal(commands.length, deliveredBefore + 1);
      await form.locator('[data-forward-text]').fill(newerText);
    } finally { release.resolve(); }
    await form.locator('[data-forward-pending]').waitFor({ state: 'hidden' });
    await form.locator('button[type="submit"]:enabled').waitFor();
    assert.equal(sent(h, source).length, 1, 'recovering a lost response sends no second write');
    assert.equal(commands.length, deliveredBefore + 1, 'the runner receives one delivery');
    assert.ok(reads(h).length >= 1, 'recovery uses the real feedback-list GET');
    assert.equal(await form.locator('[data-forward-text]').inputValue(), newerText);
    const original = JSON.parse(sent(h, source)[0].body!) as Guidance;
    const recovered = (await feedbacks(page)).filter(item => item.sourceFeedbackId === source.id && item.author.id === fixture.ownerId && item.requestId === original.requestId);
    assert.equal(recovered.length, 1); assert.equal(recovered[0].text, text); assert.equal(recovered[0].delivery.status, 'delivered');
    await article(page, recovered[0]).locator('[data-feedback-source]').waitFor();
    await fit(page, 'lost response recovery desktop'); await page.screenshot({ path: path.join(output, 'recovered-response-desktop.png'), fullPage: true });
  });
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'passed', undefined,
    'real HTTP, three disposable research identities, mocked runner, no models or Lean', { checks: suite.checks, deliveredCommands: commands.length }, { credential });
  console.log(`Discussion guidance browser checks passed: ${output}`);
} catch (error) {
  await writeScenarioReport(path.join(output, 'report.json'), suite, 'failed', error,
    'real HTTP and disposable research identities with a mocked runner', { checks: suite.checks, deliveredCommands: commands.length }, { credential, failureRequests: true });
  throw error;
} finally { await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
