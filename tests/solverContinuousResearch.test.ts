import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import { CooperativeResearch } from '../src/solver/cooperation';
import { directSolverModules, type SolverModules } from '../src/solver/modules';
import type { ResearchWorker } from '../src/solver/modules/organization';
import type { SolverProblem } from '../src/solver/problem';
import { setTaskStatus } from '../src/solver/taskLifecycle';
import { parseCooperationPlan } from '../src/solver/tasks';
import { answeredGoalPathStall, cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

// A failed original route is an ordinary Lead planning input. Once the Lead has decided on exactly these inputs and
// nothing runs, no process input can arrive, so dispatch ends the run instead of waiting for outside input.
describe('idle original-goal frontier', () => {
  let directory: string, problem: SolverProblem, state: SolverRunState, workers: ResearchWorker[];
  let modules: SolverModules, controller: AbortController, cooperation: CooperativeResearch | undefined;
  let events: { event: string; details?: Record<string, unknown> }[];

  beforeEach(() => {
    const example = localExample('solver-continuous-research-', 'lead');
    ({ directory, problem } = example);
    workers = [leadWorker(problem, example.workspace), peerWorker(example, 'researcher')];
    const plan = parseCooperationPlan(problem, { tasks: problem.targets.map((target, index) => ({
      id: `goal_${index}`, kind: 'goal', objective: `Prove ${target.theoremName}`,
      proofPath: target.proofPath, theoremName: target.theoremName,
    })) });
    state = solverState(problem, example.workspace, { runId: 'continuous-research-fixture', phase: 'prepared',
      workers: workers.map(worker => ({ ...worker, phase: 'prepared', turns: 0 })),
      cooperation: { canonicalCommit: problem.baseCommit,
        tasks: plan.tasks.map(task => ({ task, status: 'blocked', attempts: 1 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    modules = { ...directSolverModules,
      M1: { ...directSolverModules.M1, open: vi.fn(async () => { throw new Error('fixture_unexpected_model'); }) } };
    controller = new AbortController(); events = []; cooperation = undefined;
  });

  afterEach(async () => {
    controller.abort();
    await cooperation?.stop();
    vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });

  const create = (continuous: boolean) => cooperation = cooperativeResearch({ state, workers, modules, retrievalRoot: directory,
    continuousResearch: continuous, signal: controller.signal, emit: (event, details) => events.push({ event, details }) });
  const budget = { maxTurns: Infinity, remainingMs: Infinity };

  it.each([true, false])('ends after the Lead already decided on the failed frontier (continuous=%s)', async continuous => {
    const fixture = create(continuous);
    state.cooperation!.planVersion = (fixture as any).planVersion();
    state.cooperation!.lastLeadInputDigest = (fixture as any).planningInputDigest();
    // That decision's context showed the stalled goal path, as every live Lead turn does.
    expect(answeredGoalPathStall(state)).toBeDefined();

    await expect(fixture.next(workers[0], budget)).resolves.toBeUndefined();

    expect(events.filter(item => item.event === 'routes_idle')).toEqual([expect.objectContaining({
      details: expect.objectContaining({ reason: 'unchanged-mathematical-input' }) })]);
    expect(state.cooperation!.tasks.every(node => node.status === 'blocked' && node.attempts === 1)).toBe(true);
    expect(modules.M1.open).not.toHaveBeenCalled(); expect(state.turns).toBe(0);
  });

  it('reconsiders a failed frontier with new inputs in an ordinary Lead plan turn', async () => {
    const fixture = create(true);
    state.cooperation!.planVersion = (fixture as any).planVersion();

    const action = await fixture.next(workers[0], budget);

    expect(action).toMatchObject({ kind: 'lead', planNonce: expect.any(String) });
    expect(action).not.toHaveProperty('recovery');
    expect(action).not.toHaveProperty('coordination');
    expect(events.some(item => item.event === 'routes_idle')).toBe(false);
  });

  it('waits on a stalled plan when a task starts, then reopens planning on new feedback', async () => {
    const fixture = create(true);
    state.cooperation!.planVersion = (fixture as any).planVersion();
    const goal = state.cooperation!.tasks[0];
    setTaskStatus(goal, 'pending', 'reopened');
    const reason = new Error('math_plan_changed_original_target');
    (fixture as any).rejectPlan(reason);
    const first = state.cooperation!.planRejection!;
    expect(first.stalled).toBe(false);

    setTaskStatus(goal, 'running', 'dispatched');
    (fixture as any).rejectPlan(reason);
    expect(state.cooperation!.planRejection).toMatchObject({ inputDigest: first.inputDigest, stalled: true });

    const waiting = vi.spyOn(fixture as any, 'waitForDispatch');
    const lead = fixture.next(workers[0], budget);
    expect(waiting).toHaveBeenCalledOnce();
    setTaskStatus(goal, 'blocked', 'rejected');
    goal.feedback = 'The saved proof exposed an unavailable premise.';
    (fixture as any).changed();
    await expect(lead).resolves.toMatchObject({ kind: 'lead' });
  });

  it.each([
    { continuous: true, restored: false },
    { continuous: true, restored: true },
    { continuous: false, restored: false },
    { continuous: false, restored: true },
  ])('ends on repeated invalid plans with continuous=$continuous, restored=$restored', async ({ continuous, restored }) => {
    let fixture = create(continuous);
    state.cooperation!.planVersion = (fixture as any).planVersion();
    (fixture as any).rejectPlan(new Error('math_plan_changed_original_target'));
    (fixture as any).rejectPlan(new Error('math_plan_changed_original_target'));
    expect(state.cooperation!.planRejection?.stalled).toBe(true);
    if (restored) {
      await fixture.stop();
      state = JSON.parse(JSON.stringify(state));
      fixture = create(continuous);
      await fixture.restore();
    }

    await expect(fixture.next(workers[0], budget)).resolves.toBeUndefined();

    expect(events.some(item => item.event === (continuous ? 'routes_idle' : 'plan_stalled'))).toBe(true);
    expect(state.cooperation!.planRejection?.stalled).toBe(true);
    expect(modules.M1.open).not.toHaveBeenCalled(); expect(state.turns).toBe(0);
  });
});
