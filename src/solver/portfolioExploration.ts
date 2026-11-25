import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isSimpleLeanName } from '../math/leanSyntax';
import { mathDigest, readMathText } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import type { MathAgentOptions, MathAgentSession } from '../runtime/agentSession';
import { projectResearchHarnessProfile } from '../runtime/researchHarness';
import type { SolverRunState } from './archive';
import { withSolverWorktree } from './problem';
import { portfolioRouteIdSchema as routeId, retiredRouteSchema } from './routeControl';
import { ResearchUsage } from './researchUsage';
import { buildTokenBudget, initializeUsageAccounting, modelDispatchAllowed, type RequestUsageAccounting, type UsageAccounting } from './usageBudget';

export const PORTFOLIO_DEFAULT_SECONDS = 1800;
export const PORTFOLIO_MAX_SECONDS = 86_400;

const profiles = ['structural-symmetry', 'explicit-constructive', 'falsification-obstruction'] as const;
const profileSchema = z.enum(profiles);
type ScoutProfile = z.infer<typeof profileSchema>;
const profileInstructions: Record<ScoutProfile, string> = {
  'structural-symmetry': 'Look for coordinate changes, symmetries, invariants, convexity, monotonicity and conceptual reductions.',
  'explicit-constructive': 'Find an explicit formula, witness, rational bound or direct construction.',
  'falsification-obstruction': 'Attack the key reductions in the other routes. Seek concrete counterexamples, degeneracies and complexity blowup.',
};
const text = (max: number) => z.string().trim().min(1).max(max);
const probeName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/u);
const timestamp = z.number().int().nonnegative();
export const portfolioFoundationLemmaSchema = z.object({
  id: routeId, proofPath: text(256), theoremName: text(256).refine(isSimpleLeanName),
  type: text(4_000), objective: text(750),
}).strict();
const falsificationEvidence = z.object({
  kind: z.enum(['counterexample', 'obstruction']), claim: text(500), probe: text(1_000), result: text(1_000),
}).strict();
const reportBodySchema = z.object({
  routeId, status: z.enum(['proposed', 'refuted', 'inconclusive']), blueprintSummary: text(1_200),
  keyTransformations: z.array(text(350)).max(6), proposedFoundationLemmas: z.array(portfolioFoundationLemmaSchema).max(6),
  falsificationEvidence: z.array(falsificationEvidence).max(3).default([]),
  obstructions: z.array(text(500)).max(4).default([]), probeRefs: z.array(probeName).max(4).default([]),
}).strict();
const reportSchema = reportBodySchema.extend({ profile: profileSchema });
export type PortfolioScoutReport = z.infer<typeof reportSchema>;

export const portfolioGateSchema = z.object({
  primaryRouteId: routeId.optional(), backupRouteId: routeId.optional(),
  retiredRoutes: z.array(retiredRouteSchema), foundationLemmas: z.array(portfolioFoundationLemmaSchema),
}).strict();
export const portfolioScoutSchema = z.object({
  profile: profileSchema, status: z.enum(['pending', 'running', 'reported', 'failed', 'timed-out']),
  turns: timestamp, reports: z.array(reportSchema).max(3).optional(),
  probes: z.array(z.object({ ref: probeName, digest: z.string().regex(/^[a-f0-9]{64}$/u), text: z.string().max(8192) })).max(12).optional(),
  usage: z.record(z.unknown()).optional(), usageBeforeThread: z.record(z.unknown()).optional(),
  lastInputTokens: timestamp.optional(),
}).strict();
export const portfolioExplorationSchema = z.object({
  phase: z.enum(['exploring', 'completed', 'skipped']),
  durationMs: z.number().int().positive().max(PORTFOLIO_MAX_SECONDS * 1000),
  scouts: z.array(portfolioScoutSchema).max(3), deadlineAt: timestamp.optional(), gate: portfolioGateSchema.optional(),
}).strict();
type PortfolioScout = z.infer<typeof portfolioScoutSchema> & {
  turns: number;
  usageAccounting?: UsageAccounting; requestUsageAccounting?: RequestUsageAccounting;
};
export type PortfolioExploration = Omit<z.infer<typeof portfolioExplorationSchema>, 'scouts'> & { scouts: PortfolioScout[] };

export const portfolioUsageRecords = (state: Pick<SolverRunState, 'portfolioExploration'>) =>
  state.portfolioExploration?.scouts ?? [];

/** The gate ranks proposals and records scoped negative knowledge. It never emits proof receipts. */
export function evaluatePortfolioGate(reports: readonly PortfolioScoutReport[], at = Date.now()): z.infer<typeof portfolioGateSchema> {
  const retired = new Map<string, z.infer<typeof retiredRouteSchema>>();
  for (const report of reports) {
    const evidence = report.falsificationEvidence[0];
    if (report.status !== 'refuted' || !evidence || retired.has(report.routeId)) continue;
    retired.set(report.routeId, { routeId: report.routeId, source: 'portfolio', retiredAt: at,
      reason: `${evidence.claim}: ${evidence.result}`.slice(0, 1500),
      evidenceRefs: [`portfolio:${report.profile}/${report.routeId}`, ...report.probeRefs.map(ref => `portfolio:${report.profile}/${ref}`)] });
  }
  const viable = reports.filter(report => report.status === 'proposed' && !retired.has(report.routeId)).sort((a, b) =>
    a.obstructions.length - b.obstructions.length ||
    Number(b.proposedFoundationLemmas.length > 0) - Number(a.proposedFoundationLemmas.length > 0) ||
    b.probeRefs.length - a.probeRefs.length ||
    a.proposedFoundationLemmas.length - b.proposedFoundationLemmas.length ||
    a.keyTransformations.length - b.keyTransformations.length ||
    a.routeId.localeCompare(b.routeId));
  const primary = viable[0], backup = viable.find(report => report.routeId !== primary.routeId);
  return { ...(primary ? { primaryRouteId: primary.routeId } : {}), ...(backup ? { backupRouteId: backup.routeId } : {}),
    retiredRoutes: [...retired.values()], foundationLemmas: primary?.proposedFoundationLemmas ?? [] };
}

export function portfolioPhase2Guidance(portfolio?: PortfolioExploration): string {
  if (portfolio?.phase !== 'completed' || !portfolio.gate) return '';
  const { gate } = portfolio;
  if (!portfolio.scouts.some(scout => scout.reports?.length))
    return 'Phase 1 ended without a usable report. Proceed with the frozen problem and delegate independent gaps using available worker capacity.';
  const summaries = [gate.primaryRouteId, gate.backupRouteId].flatMap(id => {
    if (!id) return [];
    const report = portfolio.scouts.flatMap(scout => scout.reports ?? []).find(report =>
      report.routeId === id && report.status === 'proposed');
    return report ? [{ routeId: id, blueprintSummary: report.blueprintSummary,
      keyTransformations: report.keyTransformations }] : [{ routeId: id }];
  });
  return 'Phase 1 portfolio gate (advisory mathematical evidence). Use the primary blueprint and schedule shared foundation lemmas ' +
    'as small exact obligations before dispatching goal families. Treat retired routes and their evidence as negative knowledge. ' +
    'Carry every proposed lemma through normal Lean preflight and independent proof checks.\n' +
    JSON.stringify({ primaryRouteId: gate.primaryRouteId, backupRouteId: gate.backupRouteId, blueprints: summaries,
      retiredRoutes: gate.retiredRoutes, foundationLemmas: gate.foundationLemmas });
}

/** Omitting both flags leaves older runs on their historical direct-start path. */
export function configurePortfolioExploration(saved: PortfolioExploration | undefined, input: {
  enable?: boolean; skip?: boolean; durationMs?: number; capacity: number; startedResearch: boolean;
}): PortfolioExploration | undefined {
  if (input.enable && input.skip) throw new Error('conflicting --portfolio-exploration and --skip-portfolio');
  if (input.durationMs !== undefined && (!input.enable && !saved || input.skip))
    throw new Error('--portfolio-seconds requires --portfolio-exploration');
  if (saved) {
    if (input.durationMs !== undefined && input.durationMs !== saved.durationMs) throw new Error('math_resume_portfolio_duration_changed');
    if (input.skip && saved.phase === 'exploring') return { ...saved, phase: 'skipped' };
    return saved;
  }
  if (!input.enable) return undefined;
  if (input.startedResearch) throw new Error('math_portfolio_must_precede_phase_two');
  if (input.capacity < 2) throw new Error('--portfolio-exploration requires at least two workers or a team with at least two agents');
  const durationMs = portfolioExplorationSchema.shape.durationMs.parse(input.durationMs ?? PORTFOLIO_DEFAULT_SECONDS * 1000);
  return { phase: 'exploring', durationMs,
    scouts: profiles.slice(0, Math.min(3, input.capacity)).map(profile => ({ profile, status: 'pending', turns: 0 })) };
}

const reportFile = 'PORTFOLIO.json';
const instructions = (profile: ScoutProfile, ownedFiles: readonly string[], budgetMs: number) => {
  const example = { reports: [{ routeId: profile, status: 'proposed', blueprintSummary: 'Reduction with explicit remaining premises.',
    keyTransformations: ['First reduction'], proposedFoundationLemmas: [{ id: 'base-identity',
      proofPath: ownedFiles[0], theoremName: 'Portfolio.baseIdentity', type: '∀ (n : Nat), n = n',
      objective: 'State one small shared prerequisite with its exact mathematical meaning.' }],
    falsificationEvidence: [], obstructions: [], probeRefs: [] }] };
  return [
    'Phase 1 portfolio scout: ' + profile + '. ' + profileInstructions[profile],
    `Wall-clock budget remaining: ${Math.ceil(budgetMs / 1000)} seconds. Write an initial valid ${reportFile} by halfway, even if your finding is inconclusive. ` +
      'Update it as evidence improves by writing a temporary file in the same directory and renaming it over the report.',
    'Inspect the fixed Lean statement. Use mathematical derivations and quick numerical or symbolic probes with Python, PARI/GP, SymPy or SAT as available.',
    'Keep original Lean files read-only. If necessary, write at most two Lean API probes of fewer than 40 lines each under .scratch/portfolio. Do not formalize full proofs.',
    'Test the key claim in your own route even when another scout is assigned to falsification. The route IDs are ' + profiles.join(', ') + '.',
    'For a refutation, use the affected routeId and include falsificationEvidence entries with kind (counterexample or obstruction), exact claim, reproducible probe or derivation, and result.',
    'Report uncertainty as inconclusive. List up to six small shared foundation lemma statements with exact closed Lean types and a proofPath from ' + JSON.stringify(ownedFiles) + '.',
    'Save probes under .scratch/portfolio and list their basenames in probeRefs. Write one JSON object to ' + reportFile + ' with up to three reports and return.',
    JSON.stringify(example),
  ].join('\n');
};

function readScoutReports(worktree: string, profile: ScoutProfile, problem: SolverRunState['problem']) {
  const file = path.join(worktree, reportFile);
  assertMathCanonicalPath(file);
  const { reports } = z.object({ reports: z.array(reportBodySchema).min(1).max(3) }).strict()
    .parse(JSON.parse(readMathText(file, 96 * 1024)));
  const editable = new Set(problem.ownedFiles.filter(file => file.endsWith('.lean') && !Object.hasOwn(problem.frozenFiles ?? {}, file)));
  if (new Set(reports.map(report => report.routeId)).size !== reports.length ||
      reports.some(report => !profileSchema.safeParse(report.routeId).success ||
      report.status === 'proposed' && report.routeId !== profile)) throw new Error('math_portfolio_route_outside_assignment');
  const probes = [];
  for (const ref of new Set(reports.flatMap(report => report.probeRefs))) {
    const file = path.join(worktree, '.scratch', 'portfolio', ref);
    assertMathCanonicalPath(file);
    const text = readMathText(file, 8192);
    probes.push({ ref, text, digest: mathDigest(text) });
  }
  return { probes, reports: reports.map(report => ({ ...report, profile,
    proposedFoundationLemmas: report.proposedFoundationLemmas.filter(lemma => editable.has(lemma.proofPath)) })) };
}

/** Run once before planning, on disposable worktrees pinned to the original commit. */
export async function runPortfolioExploration(input: {
  state: SolverRunState; executable: string; profile: string; taskText: string; signal: AbortSignal;
  open: (options: MathAgentOptions) => Promise<MathAgentSession>; remainingMs: () => number;
  maxTurns: number; maxTurnMs: number; maxTotalTokens: number;
  prepareWorkspace: (workspace: string) => { project: string; environment: NodeJS.ProcessEnv };
  assertCurrent?: () => void;
  save: () => void; emit: (event: string, details?: Record<string, unknown>) => void;
}): Promise<void> {
  const { state, save, emit } = input;
  const portfolio = state.portfolioExploration;
  if (portfolio?.phase !== 'exploring') return;
  input.signal.throwIfAborted();
  input.assertCurrent?.();
  const proofRecords = [...(state.workers ?? [state]), ...(state.agentTeam?.workers ?? [])];
  for (const record of [...proofRecords, ...portfolio.scouts]) initializeUsageAccounting(record);
  portfolio.deadlineAt ??= Date.now() + Math.min(portfolio.durationMs, input.remainingMs());
  const remainingMs = () => Math.max(0, Math.min(input.remainingMs(), portfolio.deadlineAt! - Date.now()));
  const changed = () => {
    state.tokenBudget = buildTokenBudget(input.maxTotalTokens, [...proofRecords, ...portfolio.scouts], state.tokenBudget?.enforcement);
    save();
  };
  const eligible = portfolio.scouts.filter(scout => scout.status === 'pending' || scout.status === 'running');
  const capacity = Math.max(0, input.maxTurns - state.turns - 1);
  const selected = portfolio.scouts.length - eligible.length + capacity >= 2 ? eligible.slice(0, capacity) : [];
  for (const scout of eligible) if (!selected.includes(scout)) scout.status = 'failed';
  changed();
  emit('portfolio_exploration_started', { deadlineAt: portfolio.deadlineAt, profiles: selected.map(scout => scout.profile) });
  const deadline = new AbortController();
  const signal = AbortSignal.any([input.signal, deadline.signal]);
  const runRoot = path.dirname(state.worktree);
  const portfolioWorktreeRoot = path.join(runRoot, 'portfolio-worktrees');
  const portfolioProfileRoot = path.join(runRoot, 'portfolio-profiles');
  const timedOut = () => !input.signal.aborted && (deadline.signal.aborted || !remainingMs());
  const deadlineTimer = setTimeout(() => deadline.abort(new Error('math_portfolio_scout_timed_out')), Math.ceil(remainingMs()));
  deadlineTimer.unref();
  let falsifier: MathAgentSession | undefined;
  const proposals = () => portfolio.scouts.flatMap(scout => (scout.reports ?? []).filter(report => report.status === 'proposed')
    .map(({ routeId, blueprintSummary, keyTransformations }) => ({ routeId, blueprintSummary, keyTransformations })));
  try {
    if (selected.length && remainingMs() && modelDispatchAllowed(state.tokenBudget!)) {
      const sourceProfile = path.resolve(input.profile);
      if (isMathPathWithin(sourceProfile, portfolioProfileRoot) || isMathPathWithin(sourceProfile, portfolioWorktreeRoot))
        throw new Error('math_portfolio_profile_must_be_separate');
      for (const directory of [portfolioWorktreeRoot, portfolioProfileRoot]) {
        assertMathCanonicalPath(directory);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      }
    }
    const outcomes = await Promise.allSettled(selected.map(async scout => {
      if (!remainingMs() || !modelDispatchAllowed(state.tokenBudget!)) {
        scout.status = remainingMs() ? 'failed' : 'timed-out'; changed(); return;
      }
      const profile = scout.profile;
      const workerId = 'portfolio-' + profile;
      // A retry uses a fresh thread. Preserve the cumulative usage already observed for the earlier attempt.
      scout.usageBeforeThread = scout.usage;
      scout.status = 'running'; save();
      try {
        await withSolverWorktree(state.worktree, state.problem.baseCommit, async worktree => {
          const prepared = input.prepareWorkspace(worktree);
          fs.mkdirSync(path.join(worktree, '.scratch', 'portfolio'), { recursive: true, mode: 0o700 });
          let session: MathAgentSession | undefined, started = false, result: string | undefined;
          let wrapUpTimer: ReturnType<typeof setTimeout> | undefined;
          const usage = new ResearchUsage({ state, research: scout, maxTotalTokens: input.maxTotalTokens,
            signal, remainingMs, changed, emit: (event, details) => emit(event, { ...details, profile }) });
          const sessionId = randomUUID();
          const profileDirectory = path.join(portfolioProfileRoot, `${profile}-${sessionId}`);
          const scoutProfile = path.join(profileDirectory, 'profile');
          try {
            signal.throwIfAborted();
            fs.mkdirSync(profileDirectory, { mode: 0o700 });
            if (state.agentHarness && state.agentHarness.id !== 'codex') {
              projectResearchHarnessProfile(state.agentHarness, scoutProfile, prepared.environment, state.model);
            } else {
              fs.mkdirSync(scoutProfile, { mode: 0o700 });
              // Provider environment keys and configured auth commands still work. Never copy credential stores.
              const config = path.resolve(input.profile, 'config.toml');
              assertMathCanonicalPath(config);
              if (fs.existsSync(config)) fs.writeFileSync(path.join(scoutProfile, 'config.toml'), fs.readFileSync(config),
                { flag: 'wx', mode: 0o400 });
            }
            const scoutBudgetMs = Math.max(1, Math.min(input.maxTurnMs, remainingMs()));
            session = await input.open({ executable: input.executable, profile: scoutProfile, workspace: worktree,
              proofProjectRoot: prepared.project, model: state.model, effort: state.effort, isolateProcess: true,
              isolatedWorkspaceParent: portfolioWorktreeRoot,
              environment: { ...prepared.environment, DEEPSCIENTIST_MATH_WORKER_ID: workerId,
                DEEPSCIENTIST_MATH_WORKER_WORKTREE: worktree },
              instructions: instructions(profile, state.problem.ownedFiles, scoutBudgetMs), signal,
              turnTimeoutMs: scoutBudgetMs,
              ...usage.bindSession(sessionId, () => session?.lastInputTokens) });
            signal.throwIfAborted();
            if (!remainingMs()) throw new Error('math_portfolio_scout_timed_out');
            if (!modelDispatchAllowed(state.tokenBudget!)) {
              scout.status = 'failed';
              return;
            }
            usage.sessionOpened(session);
            state.turns++; scout.turns++;
            const counts = state.dispatchCounts ??= {};
            counts.research = (counts.research ?? 0) + 1;
            started = true; usage.begin(undefined, 'portfolio-' + profile);
            emit('portfolio_scout_started', { profile, workerId });
            const attacks = profile === 'falsification-obstruction';
            const currentProposals = attacks ? proposals() : [];
            const turnBudgetMs = Math.min(remainingMs(), scoutBudgetMs);
            const wrapUpLeadMs = Math.min(60_000, Math.max(15_000, Math.floor(turnBudgetMs * 0.3)));
            try {
              const activeScout = session;
              result = await activeScout.run(input.taskText + '\n\nRead the frozen statement in ' + state.problem.projectRelative + '.' +
                (currentProposals.length ? '\nProposals to test:\n' + JSON.stringify(currentProposals) : ''), randomUUID(), worktree,
                turnId => {
                  usage.turnStarted(turnId);
                  if (attacks) falsifier = activeScout;
                  const remaining = Math.min(remainingMs(), turnBudgetMs);
                  if (remaining <= 20_000) return;
                  wrapUpTimer = setTimeout(() => {
                    if (signal.aborted) return;
                    const notice = `Stop starting probes and stop any running experiments. Write or finalize ${reportFile} now ` +
                      'with your best route, exact obstruction or reproducible refutation. Use inconclusive if needed. Save it atomically and return.';
                    void activeScout.notify?.(notice, activeScout.advisoryNotifications === 'native-history' ? { mode: 'advisory' } : undefined)
                      .catch(async error => {
                        // Older app-servers may lack advisory history injection. Their normal steer still works.
                        if (!signal.aborted && activeScout.advisoryNotifications === 'native-history' &&
                            error instanceof Error && error.message.startsWith('math_codex_rpc_failed:-32601:'))
                          await activeScout.notify?.(notice).catch(() => {});
                      });
                  }, Math.max(1000, remaining - wrapUpLeadMs));
                  wrapUpTimer.unref();
                });
            } catch (error) {
              if (!signal.aborted && !timedOut()) throw error;
            }
          } finally {
            clearTimeout(wrapUpTimer);
            if (falsifier === session) falsifier = undefined;
            try {
              const stopped = await session?.stopForFreeze?.();
              if (session && stopped?.status !== 'stopped') throw new Error('math_portfolio_scout_stop_unconfirmed');
            } finally {
              try { await session?.close(); }
              finally {
                if (started) usage.finish(result === 'completed' || result === 'submitted');
                usage.sessionClosed(sessionId);
                fs.rmSync(profileDirectory, { recursive: true, force: true });
              }
            }
          }
          // Only accept validated advisory files. Reports atomically saved before a deadline remain useful.
          if (fs.existsSync(path.join(worktree, reportFile))) {
            Object.assign(scout, readScoutReports(worktree, profile, state.problem));
            scout.status = 'reported';
            void falsifier?.notify?.('Scout route proposals to test:\n' + JSON.stringify(proposals()),
              falsifier.advisoryNotifications === 'native-history' ? { mode: 'advisory' } : { waitForRequest: true }).catch(() => {});
          } else if (!input.signal.aborted) throw new Error('math_portfolio_scout_report_missing');
        }, portfolioWorktreeRoot);
      } catch (error) {
        if (!input.signal.aborted) scout.status = timedOut() ? 'timed-out' : 'failed';
        const reason = error instanceof Error ? /^math_[a-z0-9_]{1,72}(?=:|$)/u.exec(error.message)?.[0] : undefined;
        emit('portfolio_scout_unavailable', { profile, workerId, status: scout.status,
          reason: timedOut() ? 'math_portfolio_scout_timed_out' : reason ?? 'math_portfolio_scout_failed' });
      } finally { changed(); }
      emit('portfolio_scout_finished', { profile, workerId, status: scout.status, reports: scout.reports?.length ?? 0 });
    }));
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  } finally {
    clearTimeout(deadlineTimer);
    for (const directory of [portfolioWorktreeRoot, portfolioProfileRoot]) {
      if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    }
  }
  input.signal.throwIfAborted();
  input.assertCurrent?.();
  portfolio.gate = evaluatePortfolioGate(portfolio.scouts.flatMap(scout => scout.reports ?? []));
  portfolio.phase = 'completed';
  changed();
  emit('portfolio_gate_evaluated', { ...portfolio.gate });
}
