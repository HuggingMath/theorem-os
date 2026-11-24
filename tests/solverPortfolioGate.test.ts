import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { buildRunInspection } from '../src/solver/inspection';
import { configurePortfolioExploration, evaluatePortfolioGate, portfolioPhase2Guidance,
  runPortfolioExploration, type PortfolioScoutReport } from '../src/solver/portfolioExploration';
import { localExample, solverState } from './helpers/solver';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const foundation = { id: 'base-change-of-variables', proofPath: 'Submission.lean', theoremName: 'Portfolio.sharedBase',
  type: '∀ (n : Nat), n + 0 = n', objective: 'Prove the shared change of variables separately.' };
const proposal = (profile: PortfolioScoutReport['profile'], fields: Partial<PortfolioScoutReport> = {}): PortfolioScoutReport => ({
  profile, routeId: profile, status: 'proposed', blueprintSummary: 'Reduce to a one-dimensional identity.',
  keyTransformations: ['Use the same parameter for both integrals.'], proposedFoundationLemmas: [foundation],
  falsificationEvidence: [], obstructions: [], probeRefs: [], ...fields,
});
const structural = proposal('structural-symmetry', { obstructions: ['Endpoint symmetry fails.'] });
const constructive = proposal('explicit-constructive', { blueprintSummary: 'Construct a rational witness.' });
const refutation = proposal('falsification-obstruction', {
  routeId: 'structural-symmetry', status: 'refuted', proposedFoundationLemmas: [],
  falsificationEvidence: [{ kind: 'counterexample', claim: 'The map preserves the endpoint.', probe: 'Evaluate map(0).', result: 'map(0) = 1.' }],
  probeRefs: ['witness.py'],
});
const assignment = (options: MathAgentOptions) => options.environment!.DEEPSCIENTIST_MATH_WORKER_ID!.slice('portfolio-'.length) as
  PortfolioScoutReport['profile'];
const withoutProfile = ({ profile: _, ...result }: PortfolioScoutReport) => result;

function fixture(durationMs = 1000, capacity = 3) {
  const { directory, workspace, problem } = localExample('portfolio-gate-');
  roots.push(directory);
  const state = solverState(problem, workspace, { phase: 'prepared', runId: 'portfolio-fixture', workerCount: capacity });
  state.portfolioExploration = configurePortfolioExploration(undefined, { enable: true, durationMs, capacity, startedResearch: false });
  const stateFile = path.join(directory, 'state.json');
  const events: { event: string; details?: Record<string, unknown> }[] = [];
  const input = { state, taskText: 'Prove the original statement.', executable: 'offline', profile: 'offline', maxTurns: 4,
    maxTurnMs: Infinity, maxTotalTokens: 1000, remainingMs: () => Infinity, signal: new AbortController().signal,
    prepareWorkspace: (workspace: string) => ({ project: path.join(workspace, problem.projectRelative), environment: {} }),
    emit: (event: string, details?: Record<string, unknown>) => { events.push({ event, details }); },
    save: () => writeSolverRunState(stateFile, state) };
  return { state, stateFile, events, input };
}

function session(options: MathAgentOptions, reports: PortfolioScoutReport[], beforeReport = () => Promise.resolve()): MathAgentSession {
  return {
    threadId: 'fixture-thread', close: async () => {}, interrupt: async () => {},
    stopForFreeze: async () => ({ status: 'stopped' }),
    run: async (_message, _id, workspace, start) => {
      start('fixture-turn');
      await beforeReport();
      if (reports.some(report => report.probeRefs.includes('witness.py')))
        fs.writeFileSync(path.join(workspace, '.scratch', 'portfolio', 'witness.py'), 'assert 0 + 1 == 1\n');
      fs.writeFileSync(path.join(workspace, 'PORTFOLIO.json'), JSON.stringify({ reports: reports.map(withoutProfile) }));
      options.onUsage({ totalTokens: 20 }, { turnId: 'fixture-turn' });
      return 'completed';
    },
  };
}

describe('portfolio exploration gate', () => {
  it('retires evidence-backed alternatives and ranks a primary and at most one backup', () => {
    const fallback = proposal('falsification-obstruction', { obstructions: ['Requires a preliminary smoothness bound.'] });
    const unsupported = proposal('falsification-obstruction', { routeId: 'explicit-constructive', status: 'refuted' });
    const gate = evaluatePortfolioGate([structural, constructive, fallback, refutation, unsupported], 42);
    expect(gate).toEqual({ primaryRouteId: 'explicit-constructive', backupRouteId: 'falsification-obstruction',
      retiredRoutes: [{ routeId: 'structural-symmetry', reason: 'The map preserves the endpoint.: map(0) = 1.',
        retiredAt: 42, source: 'portfolio', evidenceRefs: ['portfolio:falsification-obstruction/structural-symmetry',
          'portfolio:falsification-obstruction/witness.py'] }], foundationLemmas: [foundation] });
    expect(evaluatePortfolioGate([refutation]).primaryRouteId).toBeUndefined();
    expect(evaluatePortfolioGate([{ ...constructive, proposedFoundationLemmas: [] },
      { ...structural, obstructions: [] }]).primaryRouteId).toBe('structural-symmetry');
  });

  it.each([true, false])('runs concurrent scouts and hands off checked artifact metadata (native advisory: %s)', async nativeAdvisory => {
    const { state, stateFile, input, events } = fixture(5000);
    const opened: MathAgentOptions[] = [];
    let release!: () => void, attacksReady!: () => void;
    const available = new Promise<void>(resolve => { release = resolve; });
    const attackTargets = new Promise<void>(resolve => { attacksReady = resolve; });
    const notify = vi.fn(async (text: string) => { if (text.includes('Construct a rational witness.')) attacksReady(); });
    await runPortfolioExploration({ ...input, open: async options => {
      opened.push(options);
      if (opened.length === 3) release();
      const profile = assignment(options);
      const scout = session(options, [profile === 'structural-symmetry' ? structural
        : profile === 'explicit-constructive' ? constructive : refutation],
        () => profile === 'falsification-obstruction' ? attackTargets : available);
      return profile === 'falsification-obstruction'
        ? { ...scout, notify, advisoryNotifications: nativeAdvisory ? 'native-history' : undefined } : scout;
    } });
    expect(opened.map(assignment)).toEqual(['structural-symmetry', 'explicit-constructive', 'falsification-obstruction']);
    expect(new Set(opened.map(options => options.workspace)).size).toBe(3);
    expect(opened.every(options => options.isolateProcess && options.workspace !== state.worktree && !fs.existsSync(options.workspace))).toBe(true);
    expect(opened[0].instructions).toContain('symmetries');
    expect(opened[1].instructions).toContain('rational bound');
    expect(opened[2].instructions).toContain('counterexamples');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Construct a rational witness.'),
      nativeAdvisory ? { mode: 'advisory' } : { waitForRequest: true });
    expect(state.tokenBudget?.reportedTotalTokens).toBe(60);
    expect(events.filter(event => event.event === 'portfolio_scout_started')).toHaveLength(3);
    const restored = readSolverRunState(stateFile), persisted = restored.portfolioExploration;
    expect(buildRunInspection(restored)).toMatchObject({ turns: 3, usage: { totalTokens: 60 },
      tokenBudget: { reportedTotalTokens: 60, usageComplete: true } });
    expect(persisted).toEqual(state.portfolioExploration);
    expect(persisted?.gate?.retiredRoutes[0].routeId).toBe('structural-symmetry');
    expect(persisted?.scouts[2].probes).toMatchObject([{ ref: 'witness.py', text: 'assert 0 + 1 == 1\n' }]);
    expect(portfolioPhase2Guidance(persisted)).toContain('Construct a rational witness.');
    expect(portfolioPhase2Guidance(persisted)).toContain(foundation.type);
    expect(state.check).toBeUndefined();
    const open = vi.fn();
    await runPortfolioExploration({ ...input, state: readSolverRunState(stateFile), open });
    expect(open).not.toHaveBeenCalled();
  });

  it('resumes only unfinished scouts within the saved deadline', async () => {
    const { state, stateFile, input } = fixture(4000, 2);
    const first = state.portfolioExploration!.scouts[0];
    first.status = 'reported';
    first.reports = [structural];
    state.portfolioExploration!.deadlineAt = Date.now() + 3000;
    input.save();
    const resumed = readSolverRunState(stateFile), deadline = resumed.portfolioExploration!.deadlineAt;
    const open = vi.fn(async options => session(options, [constructive]));
    await runPortfolioExploration({ ...input, state: resumed, open });
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0][0].turnTimeoutMs).toBeLessThanOrEqual(3000);
    expect(resumed.portfolioExploration).toMatchObject({ phase: 'completed', deadlineAt: deadline,
      gate: { primaryRouteId: 'explicit-constructive', backupRouteId: 'structural-symmetry' } });
  });

  it('closes an expired stage without spending a model turn and preserves direct and skip behavior', async () => {
    const { state, input } = fixture(100);
    const open = vi.fn();
    expect(configurePortfolioExploration(undefined, { capacity: 1, startedResearch: true })).toBeUndefined();
    expect(configurePortfolioExploration(undefined, { capacity: 1, startedResearch: false, skip: true })).toBeUndefined();
    expect(() => configurePortfolioExploration(undefined, { capacity: 1, startedResearch: false, enable: true }))
      .toThrow('requires at least two workers');
    const skipped = configurePortfolioExploration(state.portfolioExploration, { capacity: 3, startedResearch: false, skip: true });
    expect(skipped?.phase).toBe('skipped');
    await runPortfolioExploration({ ...input, state: { ...state, portfolioExploration: skipped }, open });
    await runPortfolioExploration({ ...input, state: { ...state, portfolioExploration: undefined }, open });
    state.portfolioExploration!.deadlineAt = Date.now() - 1;
    await runPortfolioExploration({ ...input, open });
    expect(open).not.toHaveBeenCalled();
    expect(state.portfolioExploration).toMatchObject({ phase: 'completed',
      scouts: Array.from({ length: 3 }, () => expect.objectContaining({ status: 'timed-out' })) });
  });

  it('reserves a proof turn and does not start an undersized portfolio', async () => {
    const { state, input } = fixture(5000);
    const open = vi.fn();
    await runPortfolioExploration({ ...input, maxTurns: 2, open });
    expect(open).not.toHaveBeenCalled();
    expect(state.turns).toBe(0);
    const enabled = configurePortfolioExploration(undefined, { enable: true, capacity: 3, startedResearch: false });
    state.portfolioExploration = enabled;
    const scout = vi.fn(async options => session(options, [proposal(assignment(options))]));
    await runPortfolioExploration({ ...input, maxTurns: 3, open: scout });
    expect(scout).toHaveBeenCalledTimes(2);
    expect(state.turns).toBe(2);
  });
});
