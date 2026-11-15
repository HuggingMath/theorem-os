#!/usr/bin/env bun
// End-to-end Playwright verification for the Kervaire126-inspired Solving Progress Proof Map
// across planned multi-stage DAGs, unplanned 3-stage pipelines, /?sample showcase, light & dark themes,
// zh & en locales, and 320px / 390px / 1440px viewports.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebObservation } from '../apps/web/collaboration';
import { localeStorageKey } from '../apps/web/i18n';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { audit } from './web-a11y';
import { freePort, settled, startBrowser } from './web-scenario';
import { openChatResultDetails } from './web-ui-controls';

declare const Bun: { serve(options: { hostname: string; port: number; fetch(request: Request): Response | Promise<Response> }): { port: number; stop(force?: boolean): void } };

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-proof-map');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.access(path.join(staticRoot, 'app.js'));
await fs.mkdir(output, { recursive: true });

const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-proof-map-'));
const credential = 'sk-local-proof-map-fixture';
const now = () => new Date().toISOString();
const checks: object[] = [], errors: string[] = [], external: string[] = [], commands: object[] = [];
let phase = 'setup', mode: 'dag' | 'unplanned' = 'dag', browser: Browser | undefined;

type Control = { observation: WebObservation; emit(): void; finish(): void };
const controls = new Map<string, Control>();

function dagObservation(id: string): WebObservation {
  const snapshot = { schema: 'theoremos.run-observation.v1', runId: 'solver-' + id, stateDigest: mathDigest('dag-1'), resultDigest: null };
  const tasks = [
    {
      id: 'research_lit',
      kind: 'research' as const,
      objective: 'Survey parity invariants and modular decomposition in Mathlib',
      group: 'stage1',
      status: 'completed',
      control: 'active',
      version: 'r-v1',
      premises: [],
      plannedDependencies: [],
      attempts: 1,
      owner: 'scout-1',
      finding: 'Mathlib Nat.even_or_odd and Finset.sum_congr isolate the quadratic residue split.',
      files: ['Mathlib/Data/Nat/Parity.lean'],
      proof: { status: 'none' },
      parkedBy: [],
      parkedRoutes: {},
    },
    {
      id: 'sketch_bridge',
      kind: 'sketch' as const,
      objective: 'Reduce the main inequality to a parity invariant and an upper tail bound',
      group: 'stage2',
      status: 'completed',
      control: 'active',
      version: 's-v1',
      theorem: 'reduction_bridge',
      type: '∀ n : ℕ, ParitySplit n → TailBound n → MainGoal n',
      declaration: 'lemma reduction_bridge (n : ℕ) (h₁ : ParitySplit n) (h₂ : TailBound n) : MainGoal n',
      premises: ['research_lit'],
      plannedDependencies: ['research_lit'],
      attempts: 1,
      assignedTo: 'architect-1',
      files: ['Submission/Bridge.lean'],
      proof: { status: 'draft' },
      parkedBy: [],
      parkedRoutes: {},
    },
    {
      id: 'lemma_parity',
      kind: 'lemma' as const,
      objective: 'Prove the parity invariant ParitySplit n for all natural numbers n',
      group: 'stage3',
      status: 'completed',
      control: 'active',
      version: 'lp-v1',
      theorem: 'parity_split_holds',
      type: '∀ n : ℕ, ParitySplit n',
      declaration: 'lemma parity_split_holds (n : ℕ) : ParitySplit n',
      premises: ['sketch_bridge'],
      plannedDependencies: ['sketch_bridge'],
      attempts: 2,
      assignedTo: 'prover-1',
      verifiedArtifact: { artifactId: 'art-parity', sha256: mathDigest('parity-ok') },
      files: ['Submission/Parity.lean'],
      proof: { status: 'checked' },
      parkedBy: [],
      parkedRoutes: {},
    },
    {
      id: 'lemma_bound',
      kind: 'lemma' as const,
      objective: 'Establish the sharper upper tail bound TailBound n without auxiliary sorry',
      group: 'stage3',
      status: 'blocked',
      control: 'active',
      version: 'lb-v1',
      theorem: 'tail_bound_holds',
      type: '∀ n : ℕ, TailBound n',
      declaration: 'lemma tail_bound_holds (n : ℕ) : TailBound n',
      premises: ['sketch_bridge'],
      plannedDependencies: ['sketch_bridge'],
      attempts: 3,
      owner: 'prover-2',
      feedback: 'linarith failed on nonlinear product term (n + 1)^2; needs nlinarith or induction step.',
      files: ['Submission/Bound.lean'],
      proof: { status: 'failed' },
      parkedBy: [],
      parkedRoutes: {},
    },
    {
      id: 'goal_main',
      kind: 'goal' as const,
      objective: 'Combine parity_split_holds and tail_bound_holds via reduction_bridge to close main_theorem',
      group: 'stage4',
      status: 'pending',
      control: 'active',
      version: 'g-v1',
      theorem: 'main_theorem',
      type: '∀ n : ℕ, MainGoal n',
      declaration: 'theorem main_theorem (n : ℕ) : MainGoal n',
      premises: ['lemma_parity', 'lemma_bound'],
      plannedDependencies: ['lemma_parity', 'lemma_bound'],
      attempts: 0,
      files: ['Main.lean'],
      proof: { status: 'none' },
      parkedBy: [],
      parkedRoutes: {},
    },
  ];
  return {
    schema: 'theorem-os.web-observation.v1',
    webRunId: id,
    solverRunId: snapshot.runId,
    observedAt: now(),
    sequence: 1,
    evidence: 'recorded-not-replayed',
    acceptance: 'not-assessed',
    snapshot,
    inspection: {
      schema: 'deepscientist.math.inspection.v1',
      runId: snapshot.runId,
      snapshot,
      evidence: 'recorded-not-replayed',
      phase: 'cooperative',
      problem: {
        id: 'kervaire-dag-fixture',
        statement: '对任意自然数 $n$，证明奇偶分解与尾部上界共同蕴含目标性质 $\\mathrm{MainGoal}(n)$。',
        formalStatement: 'theorem main_theorem (n : ℕ) : MainGoal n',
        assumptions: [],
        targets: [{ theoremName: 'main_theorem', proofPath: 'Main.lean' }],
      },
      configuration: {
        model: 'fixture',
        effort: 'medium',
        workers: 3,
        coordination: 'cooperative',
        buildDigest: mathDigest('build'),
        environmentDigest: mathDigest('env'),
      },
      turns: 4,
      planVersion: 'plan-v1',
      scheduling: { evidence: 'recorded-dispatch-state', observedWorkers: 2, working: 1, proofAssignments: 1, preparing: 0, stopping: 0, idle: 1, stopped: 0 },
      knowledge: { status: 'enabled', evidence: 'recorded-not-replayed', attribution: 'model-reported-origin', retrievalCoverage: 'recorded', droppedRetrievals: 0, retrievals: [], originalUses: [], uses: [] },
      tokenBudget: {},
      continuation: {},
      mathematics: {
        snapshot: {
          schema: 'theorem-os.obligation.v1',
          evidence: 'recorded-not-replayed',
          acceptance: 'not-assessed',
          digest: mathDigest('math-dag'),
          obligations: [],
          goals: [],
          blockers: [],
          routes: [],
          advisory: [],
        },
        recentChanges: [],
        retainedChangeLimit: 64,
      },
      progress: {
        checkedProofTasks: 1,
        conditionalProofTasks: 1,
        completedResearchTasks: 1,
        openProofTasks: ['lemma_bound', 'goal_main'],
      },
      groups: [],
      tasks: tasks as any,
      workers: [
        {
          id: 'prover-2',
          role: 'prover',
          status: 'working',
          taskId: 'lemma_bound',
          summary: 'Refining nonlinear product inequality in Submission/Bound.lean',
          updatedAt: now(),
        } as any,
      ],
      statementReviews: [],
      edits: [],
    },
    plan: {
      schema: 'deepscientist.math.plan-edit.v1',
      baseVersion: 'plan-v1',
      tasks: [
        { id: 'research_lit', kind: 'research', objective: tasks[0]!.objective, dependsOn: [], revision: 0 },
        { id: 'sketch_bridge', kind: 'sketch', objective: tasks[1]!.objective, dependsOn: ['research_lit'], revision: 0, theoremName: 'reduction_bridge', proofPath: 'Submission/Bridge.lean', type: tasks[1]!.type },
        { id: 'lemma_parity', kind: 'lemma', objective: tasks[2]!.objective, dependsOn: ['sketch_bridge'], revision: 0, theoremName: 'parity_split_holds', proofPath: 'Submission/Parity.lean', type: tasks[2]!.type },
        { id: 'lemma_bound', kind: 'lemma', objective: tasks[3]!.objective, dependsOn: ['sketch_bridge'], revision: 0, theoremName: 'tail_bound_holds', proofPath: 'Submission/Bound.lean', type: tasks[3]!.type },
        { id: 'goal_main', kind: 'goal', objective: tasks[4]!.objective, dependsOn: ['lemma_parity', 'lemma_bound'], revision: 0, theoremName: 'main_theorem', proofPath: 'Main.lean', type: tasks[4]!.type },
      ],
    },
    history: [],
    sources: [
      {
        id: 'src-bound',
        at: now(),
        kind: 'candidate',
        actor: 'prover-2',
        file: 'Submission/Bound.lean',
        source: 'lemma tail_bound_holds (n : ℕ) : TailBound n := by\n  linarith\n',
      } as any,
    ],
    checks: [
      {
        id: 'chk-parity',
        at: now(),
        actor: 'prover-1',
        file: 'Submission/Parity.lean',
        source: 'lemma parity_split_holds (n : ℕ) : ParitySplit n := by\n  exact Nat.even_or_odd n\n',
        lean: { ok: true, exitCode: 0, durationMs: 420, messages: [], sorryCount: 0, axiomNames: [] },
      } as any,
      {
        id: 'chk-bound',
        at: now(),
        actor: 'prover-2',
        file: 'Submission/Bound.lean',
        source: 'lemma tail_bound_holds (n : ℕ) : TailBound n := by\n  linarith\n',
        lean: {
          ok: false,
          exitCode: 1,
          durationMs: 510,
          messages: [{ severity: 'error', file: 'Submission/Bound.lean', line: 2, column: 3, text: 'linarith failed to find a contradiction' }],
          sorryCount: 0,
          axiomNames: [],
        },
      } as any,
    ],
    guidance: [],
    coverage: { sources: 'recorded', checks: 'recorded' },
  };
}

function unplannedObservation(id: string): WebObservation {
  const obs = dagObservation(id);
  obs.inspection.tasks = [];
  obs.plan = undefined;
  obs.inspection.progress = { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: [] };
  return obs;
}

const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Proof map fixture runner' }; },
  async check() { throw new Error('Proof map fixture must not invoke real Lean'); },
  async run(input, send, signal) {
    await new Promise<void>(resolve => {
      const control: Control = {
        observation: mode === 'dag' ? dagObservation(input.id) : unplannedObservation(input.id),
        finish: resolve,
        emit() {
          this.observation.sequence++;
          this.observation.observedAt = now();
          this.observation.snapshot.stateDigest = mathDigest('pm-' + this.observation.sequence);
          send({ type: 'observation', observation: structuredClone(this.observation) });
        },
      };
      controls.set(input.id, control);
      signal.addEventListener('abort', () => resolve(), { once: true });
      control.emit();
    });
  },
  async command(runId, command) {
    const control = controls.get(runId)!;
    if (command.type === 'capture') return { id: 'capture', status: 'captured', observation: structuredClone(control.observation) };
    if (command.type !== 'guidance') throw new Error('Unexpected command');
    commands.push(structuredClone(command.guidance));
    const guidance = { ...command.guidance, status: 'delivered' as const, deliveredTo: ['prover-2'], createdAt: now(), updatedAt: now() };
    control.observation.guidance.push(guidance);
    control.emit();
    return { id: guidance.id, status: 'delivered', guidance, observation: structuredClone(control.observation) };
  },
};

const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch() {
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Fixture reply.' }] }] });
  },
});

const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({
  THEOREMOS_WEB_PORT: String(port),
  THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot,
  THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_CONCURRENCY: '4',
});
config.providers = [{ id: 'local', name: 'Proof Map Fixture', baseUrl: `http://127.0.0.1:${provider.port}/v1` }];
const service = createWebService(config, runner, { mailer: async () => { throw new Error('No mail'); } });

async function openPage(width: number, locale: 'zh' | 'en', theme: 'light' | 'dark' = 'light') {
  const ctx = await browser!.newContext({
    viewport: { width, height: width < 850 ? 844 : 1000 },
    reducedMotion: 'reduce',
    locale: locale === 'zh' ? 'zh-CN' : 'en-US',
    colorScheme: theme,
  });
  await ctx.addInitScript(({ key, locale, theme }) => {
    localStorage.setItem(key, locale);
    localStorage.setItem('theorem-os-theme', theme);
  }, { key: localeStorageKey, locale, theme });
  await ctx.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', err => errors.push(`${phase}: ${err.message}`));
  await page.goto(origin);
  await page.locator('#formalize-original').waitFor();
  return { ctx, page };
}

async function http(page: Page, method: string, pathname: string, input?: unknown): Promise<any> {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const res = await fetch(pathname, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error}`);
    return body;
  }, { method, pathname, input });
}

async function startRun(page: Page) {
  const run = (await http(page, 'POST', '/api/runs', {
    requestId: crypto.randomUUID(),
    providerId: 'local',
    apiKey: credential,
    model: 'fixture',
    effort: 'medium',
    environment: 'mathlib',
    source: 'theorem main_theorem (n : ℕ) : MainGoal n := by\n  sorry\n',
    task: '对任意自然数 n，证明奇偶分解与尾部上界共同蕴含目标性质 MainGoal n。',
    maxTurns: 6,
    maxRunSeconds: 600,
    workers: 3,
    coordination: 'cooperative',
  })).run;
  await page.waitForFunction(async id => !!(await (await fetch(`/api/runs/${id}`)).json()).run.observation, run.id);
  const conversation = (await http(page, 'POST', '/api/conversations', { runId: run.id })).conversation;
  await page.goto(`${origin}/?chat=${conversation.id}`);
  await page.locator(`[data-conversation="${conversation.id}"]`).waitFor();
  return { runId: run.id, conversationId: conversation.id };
}

async function assertCleanFitAndA11y(page: Page) {
  await settled(page);
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth);
  assert.ok(overflow <= 1, `${phase}: expected zero horizontal overflow, got +${overflow}px`);
  const a11yIssues = await audit(page);
  assert.deepEqual(a11yIssues, [], `${phase}: accessibility issues: ${JSON.stringify(a11yIssues)}`);
}

try {
  browser = await startBrowser(service.server, port);

  // 1. Sample showcase (`/?sample`) renders inline conversation ProofMap immediately without opening <details>.
  for (const [width, locale, theme] of [[1440, 'zh', 'light'], [1440, 'en', 'dark'], [390, 'zh', 'light'], [320, 'en', 'light']] as const) {
    phase = `sample/${locale}/${theme}/${width}`;
    const { ctx, page } = await openPage(width, locale, theme);
    try {
      await page.goto(`${origin}/?sample`);
      await page.locator('[data-chat-sample-note]').waitFor();
      const convMap = page.locator('#research-chat-thread [data-proof-map="conversation"]');
      await convMap.waitFor({ state: 'visible' });
      assert.equal(await page.locator('[data-chat-result-more]').evaluate(el => (el as HTMLDetailsElement).open), false,
        'Sample keeps <details> closed while ProofMap is directly visible above it');
      const reductionText = await convMap.locator('[data-pm-reduction]').innerText();
      assert.doesNotMatch(reductionText, /%|百分比|预计|\bETA\b/iu, 'Never claim percentages or ETAs');
      await assertCleanFitAndA11y(page);
      await page.screenshot({ path: path.join(output, `sample-proof-map-${locale}-${theme}-${width}.png`), fullPage: true });
      checks.push({ phase, ok: true });
      console.log(`PASS ${phase}`);
    } finally {
      await ctx.close();
    }
  }

  // 2. Live 5-node Kervaire-style DAG across conversation + workspace panels, SVG edge routing, Use/Prove expansion, guidance, and live transition.
  mode = 'dag';
  for (const [width, locale, theme] of [[1440, 'zh', 'light'], [1440, 'zh', 'dark'], [1440, 'en', 'light'], [390, 'zh', 'light'], [320, 'en', 'light']] as const) {
    phase = `dag/${locale}/${theme}/${width}`;
    const { ctx, page } = await openPage(width, locale, theme);
    let runId: string | undefined;
    try {
      const started = await startRun(page);
      runId = started.runId;

      // Inline conversation ProofMap is visible right in the thread!
      const convMap = page.locator('#research-chat-thread [data-proof-map="conversation"]');
      await convMap.waitFor({ state: 'visible' });
      assert.equal(await convMap.locator('[data-pm-stage]').count(), 4, '4 topological stages (research -> sketch -> lemmas -> goal)');
      assert.equal(await convMap.locator('[data-pm-step]').count(), 4, '4 progressive bottleneck narrowing steps');
      const convText = await convMap.innerText();
      assert.doesNotMatch(convText, /%|百分比|预计|\bETA\b/iu);
      await assertCleanFitAndA11y(page);
      await page.screenshot({ path: path.join(output, `dag-conversation-${locale}-${theme}-${width}.png`), fullPage: true });

      // Open live workspace panel and verify workspace ProofMap, routed SVG edges, inline Use/Prove detail, and guidance wiring!
      const live = page.locator('#chat-live-panel');
      if (!await live.isVisible()) {
        await openChatResultDetails(page);
        await page.locator('#research-chat-thread [data-research-artifact="live"]').click();
      }
      const wsMap = live.locator('[data-proof-map="workspace"]');
      await wsMap.waitFor({ state: 'visible' });
      await wsMap.locator('[data-pm-goal-bridge]').waitFor({ state: 'visible' });

      // Check SVG edges are non-empty orthogonal paths!
      await page.waitForFunction(() => document.querySelectorAll('#chat-live-panel svg.pm-edges > path[data-pm-edge][d^="M"]').length >= 5);
      const edgeCount = await wsMap.locator('svg.pm-edges > path[data-pm-edge][d^="M"]').count();
      assert.equal(edgeCount, 5, '5 DAG dependency edges routed cleanly');

      // Failed/blocked node `lemma_bound` defaults to expanded in workspace variant, showing Use/Prove and failure reason!
      const boundCard = wsMap.locator('[data-live-task="lemma_bound"]');
      assert.equal(await boundCard.getAttribute('data-tone'), 'failed');
      assert.equal(await boundCard.locator('.live-task-head').getAttribute('aria-expanded'), 'true');
      assert.match(await boundCard.locator('[data-live-task-reason]').innerText(), /linarith failed/u);
      assert.equal(await boundCard.locator('.pm-detail-io dt').count(), 2, 'Shows both Use and Prove obligations');

      await assertCleanFitAndA11y(page);
      await page.screenshot({ path: path.join(output, `dag-workspace-${locale}-${theme}-${width}.png`), fullPage: true });

      if (width === 1440 && locale === 'zh' && theme === 'light') {
        // Test clicking `[data-live-guide="lemma_bound"]` inside the ProofMap card!
        const beforeCmd = commands.length;
        await boundCard.locator('[data-live-guide="lemma_bound"]').click();
        await page.locator('[data-chat-guidance-mode-open][aria-pressed="true"]').waitFor();
        assert.equal(await page.locator('[data-chat-guidance-target]').inputValue(), 'lemma_bound');
        await page.locator('#formalize-original').fill('Use nlinarith on (n + 1)^2.');
        await page.locator('#formalize-start:enabled').click();
        await page.locator('[data-chat-guidance-receipt][data-guidance-status="delivered"]').waitFor();
        assert.equal(commands.length, beforeCmd + 1);

        // Stream live progress: `lemma_bound` passes verification and `goal_main` becomes active!
        const control = controls.get(runId)!;
        const boundTask = control.observation.inspection.tasks.find(t => t.id === 'lemma_bound')!;
        boundTask.status = 'completed';
        (boundTask as any).feedback = undefined;
        (boundTask as any).verifiedArtifact = { artifactId: 'art-bound', sha256: mathDigest('bound-ok') };
        const goalTask = control.observation.inspection.tasks.find(t => t.id === 'goal_main')!;
        goalTask.status = 'running';
        control.observation.inspection.progress = {
          checkedProofTasks: 2,
          conditionalProofTasks: 1,
          completedResearchTasks: 1,
          openProofTasks: ['goal_main'],
        };
        control.emit();

        await page.waitForFunction(() =>
          document.querySelector('#chat-live-panel [data-live-task="lemma_bound"]')?.getAttribute('data-tone') === 'done'
          && document.querySelector('#chat-live-panel [data-live-task="goal_main"]')?.getAttribute('data-tone') === 'active'
        );
        // Expand goal_main to inspect final closure card
        await wsMap.locator('[data-live-task="goal_main"] .live-task-head').click();
        await assertCleanFitAndA11y(page);
        await page.screenshot({ path: path.join(output, `dag-workspace-progressed-zh-light-1440.png`), fullPage: true });
      }

      checks.push({ phase, edgeCount, ok: true });
      console.log(`PASS ${phase}`);
    } finally {
      if (runId) controls.get(runId)?.finish();
      await ctx.close();
    }
  }

  // 3. Unplanned run (`tasks: []`) defaults LiveWorkspace to `file` tab (.live-code visible) and offers 3-stage pipeline ProofMap on `plan` tab.
  mode = 'unplanned';
  phase = 'pipeline/zh/light/1440';
  {
    const { ctx, page } = await openPage(1440, 'zh', 'light');
    let runId: string | undefined;
    try {
      const started = await startRun(page);
      runId = started.runId;
      assert.equal(await page.locator('#research-chat-thread [data-proof-map="conversation"]').count(), 0,
        'Unplanned single-task run keeps conversation thread compact without DAG map');
      await openChatResultDetails(page);
      await page.locator('#research-chat-thread [data-research-artifact="live"]').click();
      const live = page.locator('#chat-live-panel');
      await live.locator('.live-code').waitFor({ state: 'visible' });
      assert.equal(await live.locator('.live-workspace').getAttribute('data-live-tab-shown'), 'file');
      await live.locator('[data-live-tab="plan"]').click();
      const pipeMap = live.locator('[data-proof-map="workspace"][data-pm-mode="pipeline"]');
      await pipeMap.waitFor({ state: 'visible' });
      assert.equal(await pipeMap.locator('[data-pm-stage]').count(), 3);
      await assertCleanFitAndA11y(page);
      await page.screenshot({ path: path.join(output, 'pipeline-workspace-zh-light-1440.png'), fullPage: true });
      checks.push({ phase, ok: true });
      console.log(`PASS ${phase}`);
    } finally {
      if (runId) controls.get(runId)?.finish();
      await ctx.close();
    }
  }

  assert.deepEqual(errors, [], `Unexpected page errors: ${JSON.stringify(errors)}`);
  assert.deepEqual(external, [], `Unexpected external requests: ${JSON.stringify(external)}`);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: true, checks }, null, 2));
  console.log(`ALL PROOF MAP CHECKS PASSED (${checks.length} scenarios)`);
} catch (err) {
  console.error(`FAILED at phase ${phase}:`, err);
  process.exitCode = 1;
} finally {
  for (const control of controls.values()) control.finish();
  await browser?.close();
  await service.close();
  provider.stop(true);
  await fs.rm(dataRoot, { recursive: true, force: true });
}
