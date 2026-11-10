import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_EXAMPLE_PROOF } from '../src/math/localExample';
import type { SolverRunState } from '../src/solver/archive';
import type { CooperativeResearch } from '../src/solver/cooperation';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { committedSource, commitSolverSources, type SolverProblem } from '../src/solver/problem';
import { parseCooperationPlan, taskVersion } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const host = vi.hoisted(() => ({ verify: vi.fn(), createSession: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(), checkManyFormalVerifications: host.verify,
  resolveMathematicsLakePackagesCache: () => undefined,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));

describe('complete candidate yields an active Lead to host assembly', () => {
  let directory: string, problem: SolverProblem, workers: ResearchWorker[], state: SolverRunState;
  let cooperative: CooperativeResearch, controller: AbortController;
  let events: { event: string; details?: Record<string, unknown> }[];
  const budget = { maxTurns: Infinity, remainingMs: Infinity };
  const sourceFile = (worker: ResearchWorker) => path.join(worker.worktree, problem.projectRelative, 'Submission.lean');
  const graph = () => ({ tasks: state.cooperation!.tasks.map(node => node.task),
    groups: state.cooperation!.groups!.map(route => route.group) });
  const changed = () => cooperative.deactivate(workers[1]);
  const finishGoals = () => {
    fs.writeFileSync(sourceFile(workers[1]), LOCAL_EXAMPLE_PROOF);
    const commit = commitSolverSources(problem, workers[1].worktree);
    state.cooperation!.canonicalCommit = commit;
    for (const node of state.cooperation!.tasks) node.status = 'integrated';
    return commit;
  };
  const startLead = async () => {
    const action = await cooperative.next(workers[0], budget);
    if (action?.kind !== 'lead') throw new Error('fixture_expected_lead');
    expect(cooperative.started(workers[0], action)).toBe(true);
    const interrupt = vi.fn(async () => {});
    cooperative.activate(workers[0], action, interrupt, async () => {});
    expect(cooperative.current(action)).toBe(true);
    return { action, interrupt };
  };

  beforeEach(() => {
    host.verify.mockReset().mockImplementation(() => { throw new Error('fixture_unexpected_verification'); });
    host.createSession.mockReset().mockImplementation(() => { throw new Error('fixture_real_models_forbidden'); });
    const example = localExample('solver-assembly-lead-yield-', 'lead');
    ({ directory, problem } = example);
    workers = [leadWorker(problem, example.workspace), peerWorker(example, 'engineer', { role: 'engineer' })];
    const plan = parseCooperationPlan(problem, { tasks: problem.targets.map((target, index) => ({
      id: `goal_${index}`, kind: 'goal', objective: `Prove ${target.theoremName}.`, ...target,
    })) });
    state = solverState(problem, example.workspace, { runId: 'assembly-lead-yield-fixture', phase: 'running',
      workers: workers.map(worker => ({ ...worker, phase: 'running', turns: 0 })),
      cooperation: { canonicalCommit: problem.baseCommit, error: 'The Lead has a pending route decision.',
        tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    events = []; controller = new AbortController();
    cooperative = cooperativeResearch({ state, workers, retrievalRoot: directory, signal: controller.signal,
      emit: (event, details) => events.push({ event, details }) });
  });

  afterEach(async () => {
    controller.abort(); await cooperative.stop();
    expect(host.verify).not.toHaveBeenCalled(); expect(host.createSession).not.toHaveBeenCalled();
    vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });

  it('interrupts once, rejects the stopped Lead plan and sources, then assembles without another model turn', async () => {
    const { action, interrupt } = await startLead();
    fs.writeFileSync(sourceFile(workers[0]), fs.readFileSync(sourceFile(workers[0]), 'utf8')
      .replace('theorem add_zero', 'lemma stale_lead_draft : True := by trivial\ntheorem add_zero'));
    const stalePlan = graph();
    stalePlan.tasks[0] = { ...stalePlan.tasks[0], objective: 'Reopen the completed original goal.' };
    fs.writeFileSync(path.join(workers[0].worktree, 'RESEARCH.md'), JSON.stringify(stalePlan));
    const staleCommit = commitSolverSources(problem, workers[0].worktree);
    const canonical = finishGoals(), tasks = structuredClone(state.cooperation!.tasks);
    const planVersion = state.cooperation!.planVersion;

    changed(); changed();
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(events.filter(item => item.event === 'lead_yielded_for_assembly')).toEqual([
      { event: 'lead_yielded_for_assembly', details: { workerId: workers[0].id, seedCommit: action.seedCommit, commit: canonical } },
    ]);
    expect(cooperative.current(action)).toBe(false);

    cooperative.deactivate(workers[0]);
    // A changing readiness predicate cannot make a stopped dispatch current again.
    state.cooperation!.tasks[0].status = 'pending'; changed();
    expect(cooperative.current(action)).toBe(false);
    state.cooperation!.tasks[0].status = 'integrated'; changed();
    await expect(cooperative.deliver(workers[0], action, staleCommit, true, 'scheduling-checkpoint'))
      .resolves.toEqual({ checkWhole: false });
    expect(state.cooperation!.canonicalCommit).toBe(canonical);
    expect(state.cooperation!.planVersion).toBe(planVersion);
    expect(state.cooperation!.tasks).toEqual(tasks);
    expect(committedSource(workers[0].worktree, canonical, `${problem.projectRelative}/Submission.lean`)).toBe(LOCAL_EXAMPLE_PROOF);
    expect(events.some(item => item.event === 'lead_decision_superseded')).toBe(true);

    const assembly = await cooperative.next(workers[0], { maxTurns: 0, remainingMs: 1000 });
    expect(assembly).toMatchObject({ kind: 'assemble' });
    expect(state.cooperation!.review).toBeUndefined();
    expect(state.check).toBeUndefined();
  });

  it.each(['incomplete-goal', 'approval', 'synchronization'] as const)
  ('keeps the Lead active while the candidate is blocked by %s', async blocker => {
    const { action, interrupt } = await startLead();
    const canonical = finishGoals();
    if (blocker === 'incomplete-goal') state.cooperation!.tasks[0].status = 'conditional';
    else if (blocker === 'approval') state.planApproval = true;
    else state.cooperation!.tasks[0].pendingValidation = { id: 'pending-check',
      taskDigest: taskVersion(state.cooperation!.tasks[0].task), canonicalCommit: canonical,
      environmentDigest: state.environmentDigest, problemReceiptDigest: problem.receiptDigest };
    changed();
    expect(interrupt).not.toHaveBeenCalled();
    expect(cooperative.current(action)).toBe(true);

    state.cooperation!.tasks[0].status = 'integrated';
    state.planApproval = false;
    delete state.cooperation!.tasks[0].pendingValidation;
    // Synchronization completion and budget updates may only wake waiters, without changed().
    cooperative.modelBudgetChanged();
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(cooperative.current(action)).toBe(false);
  });
});
