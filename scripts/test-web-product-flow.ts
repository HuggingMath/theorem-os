#!/usr/bin/env bun
// Disposable loopback service and recorded tutorial evidence. No provider, Lean or production job is called.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { loadWebSample } from '../apps/web/sample';
import type { WebRunner } from '../apps/web/runner';
import type { WebGuidanceRecord, WebObservation } from '../apps/web/collaboration';
import type { WebRun, WebRunInput, WorkerInput } from '../apps/web/shared';
import type { ResearchAsset, ResearchAssetPrefill } from '../apps/web/researchAssetTypes';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, preferFullCollaboration, settled, startBrowser } from './web-scenario';
import { closeSettings, showArtifacts } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..');
const focusedHome = process.env.THEOREMOS_PRODUCT_FLOW_FOCUS === 'home-math';
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-flow/workbench', ...(focusedHome ? ['home-math'] : []));
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.access(path.join(staticRoot, 'app.js'));
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-product-flow-'));
const sample = loadWebSample()!;
const credential = 'sk-disposable-product-flow-fixture';
const now = () => new Date().toISOString();
type Control = { observation: WebObservation; emit(): void; finish(): void };
const controls = new Map<string, Control>();
const starts: WorkerInput[] = [], commands: object[] = [], checks: object[] = [], requests: object[] = [];
const errors: string[] = [], external: string[] = [];
let phase = 'setup', blockedPrechecks = 0, formalizeCalls = 0, mailCalls = 0, browser: Browser | undefined, active: Page | undefined, failure: unknown;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable product-flow fixture; no model or Lean' }; },
  async check() { blockedPrechecks++; throw new Error('Product-flow checks cannot invoke Lean'); },
  async formalize() { formalizeCalls++; throw new Error('Product-flow checks cannot invoke a formalization model'); },
  async run(input, send, signal) {
    starts.push(input);
    const mode = input.input.task.split('|')[0];
    if (mode === 'plan') {
      await new Promise<void>(resolve => {
        const observation = structuredClone(sample.observations[0]!);
        observation.webRunId = input.id;
        observation.sources = []; observation.checks = [];
        observation.plan!.tasks[1]!.dependsOn = ['goal_1'];
        observation.inspection.tasks[1]!.plannedDependencies = ['goal_1'];
        observation.inspection.planApproval = { required: true, status: 'pending', planVersion: observation.plan!.baseVersion,
          requestedAt: Date.now(), rejections: [], leadRevising: false };
        const control: Control = { observation, finish: resolve, emit() {
          this.observation.sequence++; this.observation.observedAt = now();
          send({ type: 'observation', observation: structuredClone(this.observation) });
        } };
        controls.set(input.id, control);
        signal.addEventListener('abort', () => resolve(), { once: true });
        send({ type: 'progress', event: 'solve_started', message: 'Controlled fixture plan awaiting approval' });
        control.emit();
      });
      return;
    }
    const observations = mode === 'accepted' ? sample.observations : mode === 'partial' ? sample.observations.slice(0, 4) : [];
    for (const recorded of observations) {
      const observation = structuredClone(recorded); observation.webRunId = input.id;
      send({ type: 'observation', observation });
    }
    const firstCheck = sample.events.findIndex(event => event.type === 'task_recheck_finished');
    for (const event of mode === 'accepted' ? sample.events : mode === 'partial' ? sample.events.slice(0, firstCheck + 1) : [])
      send({ type: 'progress', event: event.type, message: event.message, ...(event.details ? { details: event.details } : {}) });
    if (mode === 'accepted') {
      const result = structuredClone(sample.run.result!); result.report.usage = { totalTokens: 2400 };
      send({ type: 'result', result });
    } else if (mode === 'partial') {
      const source = observations.at(-1)!.sources.find(item => item.taskId === 'goal_1' && item.commit === observations.at(-1)!.inspection.tasks[0]!.proof.commit)!;
      send({ type: 'artifact', artifact: { source: source.source, workerId: 'fixture', capturedAt: now(), status: 'candidate' } });
      send({ type: 'result', result: { status: 'limit_reached', proof: '', report: { status: 'limit_reached', reason: 'math_run_stopped',
        failure: { kind: 'time_limit', reason: 'math_run_stopped' }, usage: { totalTokens: 1200 } } } });
    } else send({ type: 'result', result: { status: 'incomplete', proof: '', report: { status: 'incomplete', usage: {} } } });
  },
  async command(runId, command) {
    const control = controls.get(runId)!;
    if (command.type === 'capture') return { id: 'capture', status: 'captured', observation: structuredClone(control.observation) };
    if (command.type === 'plan-approval') {
      commands.push({ phase, runId, type: command.type, planVersion: command.approval.planVersion });
      assert.equal(command.approval.planVersion, control.observation.plan!.baseVersion, 'Approval binds the displayed plan version');
      Object.assign(control.observation.inspection.planApproval!, { status: 'approved', approvedId: command.approval.id,
        approvedVersion: command.approval.planVersion, approvedAt: Date.now() });
      control.emit();
      return { id: command.approval.id, status: 'queued', planVersion: command.approval.planVersion };
    }
    assert.equal(command.type, 'guidance');
    if (command.type !== 'guidance') throw new Error('Unexpected fixture command');
    const status = command.guidance.text.startsWith('Accept') ? 'accepted' : 'declined';
    const guidance: WebGuidanceRecord = { ...command.guidance, status: 'delivered', deliveredTo: ['fixture-lead'], createdAt: now(), updatedAt: now(),
      decision: { guidanceId: command.guidance.id, status, reason: `Fixture ${status} decision with a recorded reason`, workerId: 'fixture-lead', decidedAt: now(),
        sourcePlanVersion: control.observation.plan!.baseVersion,
        evidenceRefs: status === 'accepted' ? [{ kind: 'task', id: 'goal_1', version: control.observation.inspection.tasks[0]!.version }] : [] } };
    commands.push({ phase, runId, type: command.type, status });
    control.observation.guidance.push(guidance); control.emit();
    return { id: guidance.id, status: 'delivered', guidance, observation: structuredClone(control.observation) };
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_AUTH: 'none', THEOREMOS_WEB_CONCURRENCY: '4' });
config.providers = [{ id: 'fixture', name: 'Disposable fixture', baseUrl: `${origin}/unused-model-provider` }];
config.clientIpHeader = 'x-fixture-scenario';
const service = createWebService(config, runner, { sample: null, mailer: async () => { mailCalls++; throw new Error('No mail from product-flow fixtures'); } });

async function http<T = any>(page: Page, method: string, pathname: string, input?: unknown): Promise<T> {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json();
    if (!response.ok) throw new Error(`Fixture HTTP ${response.status}: ${body.error}`);
    return body;
  }, { method, pathname, input }) as Promise<T>;
}
async function open(width: number, locale: 'zh' | 'en') {
  const context = await browser!.newContext({ viewport: { width, height: width < 850 ? 844 : 1000 }, reducedMotion: 'reduce', locale: locale === 'zh' ? 'zh-CN' : 'en-US',
    extraHTTPHeaders: { 'x-fixture-scenario': `${locale}-${width}` } });
  await context.addInitScript(({ key, locale }) => localStorage.setItem(key, locale), { key: localeStorageKey, locale });
  await preferFullCollaboration(context);
  await context.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  const page = active = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(`${phase}: ${error.message}`));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) requests.push({ phase, method: request.method(), pathname: url.pathname });
  });
  await page.goto(origin); await page.locator('[data-start-guide]').waitFor();
  return { context, page };
}
async function run(page: Page, mode: string, changes: Partial<WebRunInput> = {}) {
  const input: WebRunInput = { providerId: 'fixture', apiKey: credential, model: 'fixture', effort: 'low', environment: 'standard',
    source: sample.run.source, task: `${mode}| Product-flow ${mode}`, maxTurns: 2, maxRunSeconds: 60, maxTotalTokens: 30_000,
    workers: 2, coordination: 'cooperative', ...changes };
  const created = (await http<{ run: WebRun }>(page, 'POST', '/api/runs', { ...input, requestId: crypto.randomUUID() })).run;
  await page.waitForFunction(async ({ id, active }) => {
    const value = (await (await fetch(`/api/runs/${id}`)).json()).run;
    return active ? value?.observation?.inspection.planApproval?.status === 'pending' : value?.status === 'completed';
  }, { id: created.id, active: mode === 'plan' });
  return (await http<{ run: WebRun }>(page, 'GET', `/api/runs/${created.id}`)).run;
}
async function visitRun(page: Page, id: string) {
  await page.goto(`${origin}/?run=${id}`);
  await page.locator(`.detail-heading[data-run="${id}"]`).waitFor({ state: 'attached' });
}
async function layout(page: Page, label: string) {
  await settled(page);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: document horizontal overflow`);
  const violations = await page.evaluate(() => [...document.querySelectorAll('button, a, input, select, textarea')].filter(node => {
    const rect = node.getBoundingClientRect();
    if (!node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    if (!rect.width || !rect.height || node.closest('[hidden], [inert], .sr-only, .roadmap-viewport, .solution-route-viewport, .run-monitor-list, .code-scroll, .diff-scroll, .trajectory-diff, .research-comparison-scroll')) return false;
    return rect.left < -2 || rect.right > innerWidth + 2;
  }).map(node => `${node.tagName.toLowerCase()}#${node.id}.${node.className}`));
  assert.deepEqual(violations, [], `${label}: visible controls must remain within the screen`);
}
async function shot(page: Page, name: string, fullPage = false) {
  await layout(page, name); await page.screenshot({ path: path.join(output, `${name}.png`), fullPage });
}
function mark(details: object) { checks.push({ phase, ...details }); console.log(`PASS ${phase}`); }
const libraryList = async (page: Page) => (await http<{ items: ResearchAsset[] }>(page, 'GET', '/api/research/library?mine=1')).items;

try {
  browser = await startBrowser(service.server, port);
  for (const [width, locale] of [[1440, 'zh'], [390, 'zh'], [390, 'en']] as const) {
    phase = `first-problem/${locale}/${width}`;
    const { context, page } = await open(width, locale);
    let plan: WebRun | undefined;
    try {
      if (focusedHome) {
        phase = `home-math/${locale}/${width}`;
        const partial = await run(page, 'partial', { task: 'partial| Prove $n + 0 = n$ for $n \\in \\mathbb{N}$' });
        await run(page, 'accepted', { task: 'accepted| Proof of $0 + n = n$ and $n + 0 = n$' });
        plan = await run(page, 'plan', { task: 'plan| Check $\\forall n \\in \\mathbb{N},\\;n + 0 = n$',
          source: '-- separate mathematical title fixture\n' + sample.run.source, planApproval: true });
        await page.goto(origin);
        await page.locator('#refresh-runs:enabled').waitFor({ state: 'attached' });
        if (await page.locator('#open-natural-language').isVisible()) await page.locator('#open-natural-language').click();
        const overview = page.locator('[data-research-overview]'); await overview.waitFor();
        const inbox = page.locator(`[data-overview-action="plan:${plan.id}"] strong`);
        await inbox.locator('.katex').first().waitFor();
        for (const details of await overview.locator('[data-overview-card] > details:not(.research-overview-statement)').all())
          await details.locator('summary').click();
        const titles = overview.locator('.research-overview-card h3 a');
        assert.equal(await titles.count(), 2);
        for (const title of await titles.all()) assert.ok(await title.locator('.katex').count(), 'Problem-card titles render their mathematical notation');
        const history = overview.locator('.research-overview-records a');
        assert.equal(await history.count(), 3);
        for (const title of [inbox, ...await titles.all(), ...await history.all()]) {
          assert.ok(await title.locator('.katex').count(), 'Inbox, card and history titles render mathematics');
          assert.equal(await title.locator('.katex-error').count(), 0);
          const plainText = await title.evaluate(element => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), parts: string[] = [];
            while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest('.katex')) parts.push(walker.currentNode.textContent ?? '');
            return parts.join('');
          });
          assert.doesNotMatch(plainText, /\$|\\(?:forall|mathbb|in)\b/u, 'No raw TeX leaks outside the rendered formula');
          const clippedFormula = await title.evaluate(element => {
            const title = element.getBoundingClientRect();
            return [...element.querySelectorAll('.katex')].some(formula => {
              const mathHost = formula.closest('.math');
              const scrolls = mathHost && ['auto', 'scroll'].includes(getComputedStyle(mathHost).overflowX);
              const box = (scrolls ? mathHost : formula).getBoundingClientRect();
              return box.left < title.left - 1 || box.right > title.right + 1;
            });
          });
          assert.equal(clippedFormula, false, 'Mathematical titles must not clip part of a formula');
        }
        await overview.evaluate(element => element.scrollIntoView({ block: 'start' }));
        await shot(page, `home-math-overview-${locale}-${width}`);
        const group = overview.locator('[data-overview-card]').filter({ has: page.locator(`a[href="?run=${partial.id}"]`) });
        await group.evaluate(element => element.scrollIntoView({ block: 'start' }));
        await shot(page, `home-math-history-${locale}-${width}`);
        mark({ inboxTitleMath: true, problemCardTitles: 2, historyTitles: 3, rawTexOutsideMath: false, formulaHostsContained: true, browserErrors: errors.length });
        continue;
      }
      const initialStarts = starts.length;
      const guide = page.locator('[data-start-guide]');
      await guide.locator('[data-start-prepare]').click();
      assert.match(await page.locator('#formalize-original').inputValue(), locale === 'zh' ? /假设与对象：[\s\S]*需要证明：/u : /Objects and assumptions:[\s\S]*Claim to prove:/u);
      assert.equal(starts.length, initialStarts);
      await shot(page, `start-template-${locale}-${width}`);
      await guide.locator('.research-intents button').nth(1).click();
      await guide.locator('[data-start-prepare]').click();
      await page.locator('body[data-entry="lean"]').waitFor({ state: 'attached' });
      await page.locator('#edit-draft-source').click();
      await page.locator('#source-editor[open]').waitFor();
      await page.locator('#expanded-source').fill(sample.run.source);
      await page.locator('#apply-editor').click();
      await page.locator('#source-editor[open]').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#source').inputValue(), sample.run.source);
      assert.equal(starts.length, initialStarts, 'Preparing either entry must not start research');
      mark({ templateInserted: true, leanEditorOpenedAndApplied: true, noAutomaticRun: true });

      phase = `returning-home/${locale}/${width}`;
      const partial = await run(page, 'partial'), accepted = await run(page, 'accepted'), unknown = await run(page, 'unknown');
      const helper = partial.observation!.inspection.tasks.find(item => item.id === 'goal_1')!;
      const mismatch = await run(page, 'changed-statement', { source: sample.run.source.replace('n + 0 = n', 'n + 0 = n + 0'),
        continueFrom: { runId: partial.id, taskId: helper.id, commit: helper.proof.commit!, label: 'Changed original statement fixture' } });
      plan = await run(page, 'plan', { source: '-- separate plan-review fixture\n' + sample.run.source, planApproval: true });
      await page.goto(origin);
      // Draft restoration chooses the entry after the session arrives; wait for initialization to finish before switching it.
      await page.locator('#refresh-runs:enabled').waitFor({ state: 'attached' });
      if (await page.locator('#open-natural-language').isVisible()) await page.locator('#open-natural-language').click();
      await page.locator('[data-research-overview]').waitFor();
      await page.locator(`[data-overview-action="plan:${plan.id}"]`).waitFor();
      const group = page.locator('[data-overview-card]').filter({ has: page.locator(`a[href="?run=${partial.id}"]`) });
      assert.equal(await group.count(), 1, 'A single problem card must contain runs with the same frozen statement');
      assert.equal(await group.locator(`.research-overview-records a[href="?run=${partial.id}"]`).count(), 1);
      assert.equal(await group.locator(`.research-overview-records a[href="?run=${accepted.id}"]`).count(), 1);
      assert.equal(await group.locator(`.research-overview-records a[href="?run=${unknown.id}"]`).count(), 1);
      assert.equal(await group.locator(`a[href="?run=${mismatch.id}"]`).count(), 0, 'Changed statements must not silently enter the same group');
      await page.locator('[data-overview-filter="waiting"]').click();
      assert.equal(await page.locator('[data-overview-card]').count(), 1, 'The attention filter must expose the waiting plan');
      await page.locator('[data-overview-filter="all"]').click();
      await page.locator('[data-overview-search]').fill('separate plan-review fixture');
      assert.equal(await page.locator('[data-overview-card]').count(), 1);
      await page.locator('[data-overview-search]').fill('');
      await shot(page, `returning-home-${locale}-${width}`);
      await page.locator(`[data-overview-action="plan:${plan.id}"]`).click();
      await page.locator('[data-problem-page]').waitFor();
      assert.equal(new URL(page.url()).pathname, '/problem.html');
      await page.locator('.problem-tabs a[href*="tab=overview"]').click();
      await page.locator('[data-problem-attention-item="plan-approval"] a.button').click();
      await page.locator('[data-chat-approve-plan]').waitFor();
      mark({ groupedRunIds: [partial.id, accepted.id, unknown.id], separateStatementRun: mismatch.id, actionablePendingPlan: plan.id });

      phase = `plan-decision/${locale}/${width}`;
      const summary = page.locator('[data-chat-plan-decision] [data-decision-summary]');
      assert.equal(await summary.getAttribute('data-plan-version'), controls.get(plan.id)!.observation.plan!.baseVersion);
      await summary.locator('summary').click();
      assert.match(await summary.locator('.decision-summary-facts').innerText(), /暂无记录|Not recorded/u, 'Missing plan rationale stays explicitly unknown');
      await summary.locator('.decision-summary-tasks button').filter({ hasText: 'Tutorial.zero_add' }).first().click();
      await page.locator('[data-roadmap-node="task:goal_2"][aria-pressed="true"]').waitFor();
      await shot(page, `plan-task-node-${locale}-${width}`);
      await visitRun(page, plan.id);
      await page.locator('[data-chat-approve-plan]').click();
      await page.waitForFunction(async id => (await (await fetch(`/api/runs/${id}`)).json()).run.observation.inspection.planApproval.status === 'approved', plan.id);
      await page.reload(); await page.locator('[data-chat-plan-decision][data-waiting="false"]').waitFor();
      assert.equal(await page.locator('[data-chat-approve-plan]').count(), 0);
      mark({ taskEntrySelected: 'goal_2', approvedVersion: controls.get(plan.id)!.observation.plan!.baseVersion });

      phase = `guidance-outcomes/${locale}/${width}`;
      const conversation = (await http(page, 'POST', '/api/conversations', { runId: plan.id })).conversation;
      await page.goto(`${origin}/?chat=${conversation.id}`); await page.locator('[data-chat-guidance-mode-open]').waitFor();
      for (const [text, outcome] of [['Accept the supporting lemma first.', 'accepted'], ['Decline this alternative direction.', 'declined']] as const) {
        await page.locator('[data-chat-guidance-mode-open]').click();
        await page.locator('#formalize-original').fill(text);
        await page.locator('#formalize-start').click();
        const shown = page.locator(`[data-guidance-outcome="${outcome}"]`); await shown.waitFor();
        await shown.locator('summary').click();
        assert.ok((await shown.innerText()).includes(`Fixture ${outcome} decision with a recorded reason`));
        assert.match(await shown.locator('.guidance-outcome-stages li').last().innerText(), /暂无记录|Not recorded/u, 'A decision alone must not invent completed execution');
      }
      await shot(page, `guidance-outcomes-${locale}-${width}`);
      mark({ observationDecisionStatuses: ['accepted', 'declined'], reasonVisible: true, executionRemainsUnrecorded: true });

      phase = `recovery-draft/${locale}/${width}`;
      await visitRun(page, partial.id);
      const choices = page.locator('[data-recovery-choices]').first();
      assert.match(await choices.innerText(), /预填|prepare/u);
      const beforeRecovery = starts.length;
      await page.locator('[data-chat-recovery="budget"]').click();
      await page.locator('#run-settings[open]').waitFor();
      assert.equal(await page.locator('#max-seconds').inputValue(), '120');
      assert.equal(await page.locator('#max-turns').inputValue(), String(partial.maxTurns));
      assert.equal(await page.locator('#source').inputValue(), partial.source);
      assert.equal(await page.locator('#api-key').inputValue(), '');
      assert.equal(starts.length, beforeRecovery, 'Budget recovery must only prepare a draft');
      await shot(page, `recovery-budget-settings-${locale}-${width}`);
      await closeSettings(page);
      assert.equal(await page.locator('[data-continuation-preview] a').getAttribute('href'), `?run=${partial.id}`);
      assert.match(await page.locator('[data-continuation-preview]').innerText(), /不自动带入候选代码|candidate code is not carried automatically/u);
      await visitRun(page, partial.id);
      await page.locator('[data-chat-recovery="continue-checked"]').click();
      await page.locator('#run-settings[open]').waitFor();
      assert.match(await page.locator('#settings-continuation').innerText(), /add_zero/u);
      assert.equal(await page.locator('#source').inputValue(), partial.source);
      await closeSettings(page);
      assert.equal(await page.locator('[data-continuation-preview] code').innerText(), helper.proof.commit);
      assert.equal(await page.locator('[data-continuation-preview] a').getAttribute('href'), `?run=${partial.id}`);
      assert.equal(starts.length, beforeRecovery, 'Selecting a checked source must not start another worker');
      await shot(page, `recovery-checked-origin-${locale}-${width}`);
      mark({ budgetPrepared: 120, originalStatementPreserved: true, carriedCommit: helper.proof.commit, extraWorkerStarts: starts.length - beforeRecovery });

      phase = `run-comparison/${locale}/${width}`;
      for (const [other, comparable] of [[accepted, true], [unknown, true], [mismatch, false]] as const) {
        await visitRun(page, partial.id); await showArtifacts(page); await page.locator('#detail-tab-result').click();
        await page.locator(`[data-action="compare-continued"][data-run-id="${other.id}"]`).click();
        const comparison = page.locator('[data-research-comparison]'); await comparison.waitFor();
        assert.equal(await comparison.getAttribute('data-comparable'), String(comparable));
        const body = await comparison.innerText();
        assert.match(body, /结果|Result/u); assert.match(body, /目标进展|Goal progress/u); assert.match(body, /证明用量|Proof usage/u);
        if (other.id === unknown.id) assert.match(body, /未记录|Not recorded/u);
        if (!comparable) assert.match(body, /不计算进展增量|no progress delta/u);
        await shot(page, `comparison-${other.id === accepted.id ? 'accepted' : other.id === unknown.id ? 'unknown' : 'different-statement'}-${locale}-${width}`);
      }
      mark({ resultGoalAndUsageRows: true, unknownUsageVisible: true, changedStatementWarning: true });

      phase = `library-final-proof/${locale}/${width}`;
      const initialAssets = (await libraryList(page)).length;
      await visitRun(page, accepted.id);
      await page.locator('[data-chat-result-more] > summary').click();
      const savedLink = page.locator(`#research-chat-thread [data-save-library][href="library.html?create=1&fromRun=${accepted.id}"]`);
      assert.equal(await savedLink.getAttribute('href'), `library.html?create=1&fromRun=${accepted.id}`);
      await page.route('**/api/research/library/from-run?*', route => route.fulfill({ status: 503, json: { error: 'Fixture source read temporarily unavailable' } }));
      await savedLink.click();
      await page.locator('[data-library-run-creator] [role="alert"]').waitFor();
      assert.equal((await libraryList(page)).length, initialAssets);
      await page.unroute('**/api/research/library/from-run?*');
      await page.locator('[data-library-run-creator] button').filter({ hasText: /重新读取成果来源|Retry loading source/u }).click();
      const fixed = page.locator('[data-library-prefill="original-proof"]'); await fixed.waitFor();
      assert.ok((await fixed.innerText()).includes(String(accepted.result!.report.solution_commit)));
      const proofOrigin = new URL(await fixed.locator('[data-library-source-link]').getAttribute('href') ?? '', origin);
      assert.equal(proofOrigin.searchParams.get('run'), accepted.id);
      assert.equal(proofOrigin.searchParams.get('view'), 'source');
      const name = page.getByRole('textbox', { name: locale === 'zh' ? '名称' : 'Name', exact: true });
      assert.equal(await name.inputValue(), accepted.title);
      assert.equal(await page.getByRole('combobox', { name: locale === 'zh' ? /^草稿可见范围/u : /^Draft visibility/u }).inputValue(), 'private');
      assert.equal((await libraryList(page)).length, initialAssets, 'Prefilling a Library form creates nothing');
      const savedName = `${accepted.title} · reviewed`;
      await name.fill(savedName);
      const create = page.getByRole('button', { name: locale === 'zh' ? '创建私有草稿' : 'Create draft', exact: true });
      await page.route('**/api/research/library', async route => route.request().method() === 'POST'
        ? route.fulfill({ status: 503, json: { error: 'Fixture draft save temporarily unavailable' } }) : route.continue());
      await create.click(); await page.getByRole('alert').filter({ hasText: 'Fixture draft save temporarily unavailable' }).waitFor();
      assert.equal(await name.inputValue(), savedName);
      assert.equal((await libraryList(page)).length, initialAssets);
      await shot(page, `library-save-failure-${locale}-${width}`, true);
      await page.unroute('**/api/research/library');
      await create.click();
      await page.waitForURL(url => url.pathname === '/library.html' && url.searchParams.has('entry'));
      const afterSaved = await libraryList(page), saved = afterSaved.find(item => item.name === savedName);
      assert.ok(saved, 'The explicitly saved draft must be readable after navigation');
      assert.equal(saved.visibility, 'private');
      assert.equal(saved.name, savedName);
      assert.equal((saved.draft as { source: { scope?: string; runId?: string } }).source.scope, 'original-proof');
      assert.equal((saved.draft as { source: { runId?: string } }).source.runId, accepted.id);
      assert.equal(afterSaved.length, initialAssets + 1);
      mark({ acceptedRunId: accepted.id, prefillCreatesNothing: true, explicitPrivateSave: saved.id, failedReadAndSaveRecover: true, editedNameRetained: true });

      phase = `library-checked-task/${locale}/${width}`;
      await visitRun(page, partial.id); await showArtifacts(page); await page.locator('#detail-tab-trajectory').click();
      await page.locator('[data-trajectory-view="steps"]').click();
      await page.locator('[data-trajectory-detail="full"]').click();
      await page.locator('[data-focus-key="trajectory-task"]').selectOption('goal_1');
      const taskLink = page.locator('[data-save-library][href*="task=goal_1"]').first();
      for (let attempt = 0; !await taskLink.count() && attempt < 12; attempt++) {
        const closed = page.locator('.trajectory-fold[aria-expanded="false"]').first();
        if (!await closed.count()) break;
        await closed.click();
      }
      await taskLink.waitFor();
      const destination = new URL(await taskLink.getAttribute('href') ?? '', origin);
      const taskCommit = destination.searchParams.get('commit')!;
      const taskVersion = destination.searchParams.get('taskVersion');
      assert.ok(taskVersion, 'The saved task link must carry the exact checked task version');
      const selection = new URLSearchParams({ run: partial.id, task: 'goal_1', commit: taskCommit, taskVersion });
      const prefill = (await http<{ item: ResearchAssetPrefill }>(page, 'GET', `/api/research/library/from-run?${selection}`)).item;
      assert.ok(prefill.source.kind === 'run'); assert.equal(prefill.source.scope, 'checked-task');
      assert.equal(prefill.source.taskVersion, taskVersion);
      const expectedReceipt = partial.observation!.checks.find(check => check.taskId === 'goal_1' && check.taskVersion === taskVersion
        && check.commit === taskCommit && check.record.passed === true);
      assert.ok(expectedReceipt, 'The selected task must retain its actual recorded check');
      assert.equal(prefill.evidence.environmentDigest, expectedReceipt.environmentDigest, 'Runtime evidence is preserved without substituting a dependency digest');
      assert.ok(prefill.evidence.checkRefs.includes(expectedReceipt.id));
      await taskLink.click();
      const taskPrefill = page.locator('[data-library-prefill="checked-task"]'); await taskPrefill.waitFor();
      await taskPrefill.locator('summary').click();
      const shown = await taskPrefill.innerText();
      const taskOrigin = new URL(await taskPrefill.locator('[data-library-source-link]').getAttribute('href') ?? '', origin);
      assert.equal(taskOrigin.searchParams.get('run'), partial.id);
      assert.equal(taskOrigin.searchParams.get('task'), 'goal_1');
      assert.equal(taskOrigin.searchParams.get('taskVersion'), taskVersion);
      assert.equal(taskOrigin.searchParams.get('commit'), taskCommit);
      assert.ok(shown.includes(taskCommit)); assert.ok(shown.includes('goal_1')); assert.ok(shown.includes(taskVersion));
      assert.ok(shown.includes(expectedReceipt.id));
      assert.equal(await page.getByRole('textbox', { name: locale === 'zh' ? '名称' : 'Name', exact: true }).inputValue(), 'Tutorial.add_zero');
      assert.equal((await libraryList(page)).length, initialAssets + 1, 'Opening a checked-task prefill still requires explicit confirmation');
      await shot(page, `library-task-prefill-${locale}-${width}`, true);
      mark({ taskId: 'goal_1', taskVersion, commit: taskCommit, sourceScope: 'checked-task', receiptIds: prefill.evidence.checkRefs,
        runtimeEnvironmentDigest: prefill.evidence.environmentDigest, prefillCreatesNothing: true });

      assert.equal(await page.evaluate(secret => JSON.stringify(sessionStorage).includes(secret) || JSON.stringify(localStorage).includes(secret), credential), false);
    } catch (error) {
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
      await fs.writeFile(path.join(output, 'failure.html'), await page.content()).catch(() => {});
      throw error;
    } finally {
      if (plan) controls.get(plan.id)?.finish();
      await context.close();
    }
  }
  assert.deepEqual(errors, [], 'The integrated product flow must not raise browser errors');
  assert.deepEqual(external, [], 'All browser traffic must stay on the disposable loopback service');
  assert.equal(formalizeCalls, 0); assert.equal(mailCalls, 0);
  for (const name of ['failure.png', 'failure.html']) await fs.rm(path.join(output, name), { force: true });
  console.log(focusedHome ? 'Home mathematical-title checks passed: inbox, problem cards and run history.'
    : 'Product-flow integration passed: onboarding, grouped home, human decisions, draft recovery, comparison and Library handoff.');
} catch (error) {
  failure = error;
  if (active && !active.isClosed()) {
    await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(output, 'failure.html'), await active.content()).catch(() => {});
  }
  throw error;
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: now(), phase, checks, commands,
    workerStarts: starts.map(input => ({ id: input.id, task: input.input.task })), requests, errors, external, blockedPrechecks, actualLeanCalls: 0, formalizeCalls, mailCalls,
    ...(failure ? { failure: failure instanceof Error ? failure.stack : String(failure) } : {}),
    evidence: 'Local HTTP, disposable state and controlled/recorded fixtures. No new model, Lean or production job.' }, null, 2) + '\n');
  for (const control of controls.values()) control.finish();
  await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
