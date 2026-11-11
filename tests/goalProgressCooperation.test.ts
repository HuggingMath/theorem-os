import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import type { CooperativeResearch } from '../src/solver/cooperation';
import { directSolverModules, type SolverModules } from '../src/solver/modules';
import { commitSolverSources } from '../src/solver/problem';
import { TaskTypePreflightCache } from '../src/solver/taskTypePreflight';
import { leadPlanDeliveryFile, parseCooperationPlan, taskVersion } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const interval = 60_000;
const budget = { maxTurns: Infinity, remainingMs: Infinity };

describe('goal progress controls the cooperative planning loop', () => {
  const directories: string[] = [], controls: AbortController[] = [], runs: CooperativeResearch[] = [];
  const waiting: Promise<unknown>[] = [];

  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
    vi.spyOn(TaskTypePreflightCache.prototype, 'check').mockImplementation(async input => ({ current: () => true,
      result: { status: 'unavailable', reason: 'offline fixture does not open Lean', inputDigest: 'fixture-input',
        taskDigest: taskVersion(input.task), evidence: 'advisory-type-elaboration', proofAcceptance: 'not-assessed' } }));
  });
  afterEach(async () => {
    controls.splice(0).forEach(controller => controller.abort());
    await Promise.allSettled(runs.splice(0).map(run => run.stop()));
    await Promise.allSettled(waiting.splice(0));
    vi.useRealTimers(); vi.restoreAllMocks();
    directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true }));
  });

  const tracked = <T>(promise: Promise<T>) => {
    waiting.push(promise); void promise.catch(() => {});
    let finished = false;
    void promise.then(() => { finished = true; }, () => { finished = true; });
    return { promise, finished: () => finished };
  };
  const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

  function fixture() {
    const example = localExample('goal-progress-cooperation-', 'lead'); directories.push(example.directory);
    const { directory, workspace, problem } = example;
    const workers = [leadWorker(problem, workspace), peerWorker(example, 'engineer', { role: 'engineer' }),
      peerWorker(example, 'prover', { role: 'prover' }), peerWorker(example, 'researcher')];
    const plan = parseCooperationPlan(problem, { tasks: problem.targets.map((target, index) => ({
      id: `goal_${index + 1}`, kind: 'goal', objective: `Prove ${target.theoremName}.`, ...target,
      conditional: false, ownerId: 'engineer', ...(index ? { status: 'paused' } : {}),
    })) });
    fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), '```math-plan\n' + JSON.stringify(plan) + '\n```\n');
    let state = solverState(problem, workspace, { runId: 'goal-progress-fixture', phase: 'running',
      workers: workers.map(worker => ({ ...worker, phase: 'running', turns: 0 })),
      cooperation: { canonicalCommit: problem.baseCommit,
        tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    let allowed = true;
    const events: { event: string; details?: Record<string, unknown> }[] = [];
    const check = vi.fn(async () => { throw new Error('fixture_unexpected_proof_or_model_call'); });
    const modules: SolverModules = { ...directSolverModules,
      M1: { ...directSolverModules.M1, open: check },
      M2: { version: directSolverModules.M2.version, check, checkTask: check } };
    const create = () => {
      const controller = new AbortController(); controls.push(controller);
      const run = cooperativeResearch({ state, workers, modules, retrievalRoot: directory, signal: controller.signal,
        modelDispatchAllowed: () => allowed, goalProgressReviewMs: interval,
        emit: (event, details) => events.push({ event, details }) });
      runs.push(run); return run;
    };
    let cooperation = create();
    const startGoal = async () => {
      const action = await cooperation.next(workers[1], budget);
      expect(action).toMatchObject({ kind: 'task', task: { id: 'goal_1' } });
      if (action?.kind !== 'task') throw new Error('fixture_expected_original_goal');
      expect(cooperation.started(workers[1], action)).toBe(true);
      const interrupt = vi.fn(async () => {});
      cooperation.activate(workers[1], action, interrupt, async () => {});
      return { action, interrupt };
    };
    const leadAction = async () => {
      const action = await cooperation.next(workers[0], budget);
      expect(action).toMatchObject({ kind: 'lead' });
      if (action?.kind !== 'lead') throw new Error('fixture_expected_lead_review');
      expect(cooperation.started(workers[0], action)).toBe(true);
      cooperation.activate(workers[0], action, async () => {}, async () => {});
      return action;
    };
    const commitPlan = (value: unknown) => {
      fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), '```math-plan\n' + JSON.stringify(value) + '\n```\n');
      return commitSolverSources(problem, workspace);
    };
    return { workers, problem, events, check, create, startGoal, leadAction, commitPlan,
      get state() { return state; }, get cooperation() { return cooperation; },
      setAllowed: (value: boolean) => { allowed = value; },
      async restart() {
        await cooperation.stop();
        const file = path.join(directory, 'state.json'); writeSolverRunState(file, state);
        state = readSolverRunState(file); cooperation = create(); await cooperation.restore();
      } };
  }

  const requested = (events: ReturnType<typeof fixture>['events']) =>
    events.filter(item => item.event === 'goal_progress_review_requested');

  it('wakes Lead for an active unproductive goal and turns its accepted revision into prover work', async () => {
    const run = fixture(), { cooperation, workers, state } = run;
    const engineer = await run.startGoal();
    state.cooperation!.lastLeadInputDigest = (cooperation as any).planningInputDigest();
    const lead = tracked(cooperation.next(workers[0], budget));
    await flush(); expect(lead.finished()).toBe(false);
    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(lead.finished()).toBe(false); expect(requested(run.events)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const action = await lead.promise;
    expect(action).toMatchObject({ kind: 'lead' });
    if (action?.kind !== 'lead') throw new Error('fixture_expected_progress_review');
    const pending = state.cooperation!.goalProgress!.pending!;
    expect(pending.goalIds).toEqual(['goal_1']); expect(requested(run.events)).toHaveLength(1);
    expect(cooperation.current(engineer.action)).toBe(true); expect(engineer.interrupt).not.toHaveBeenCalled();
    expect(cooperation.started(workers[0], action)).toBe(true);
    cooperation.activate(workers[0], action, async () => {}, async () => {});
    await vi.advanceTimersByTimeAsync(interval * 2);
    expect(requested(run.events)).toHaveLength(1);
    const file = leadPlanDeliveryFile(action)!;
    fs.appendFileSync(path.join(workers[0].worktree, file), JSON.stringify({ kind: 'plan', dispatchNonce: action.planNonce,
      baseVersion: action.planVersion, summary: 'Replace the unsupported direct argument with a typed estimate.',
      upsert: [{ id: 'goal_1', dependsOn: ['estimate'] }, { id: 'estimate', kind: 'lemma',
        objective: 'Prove the estimate consumed by the original goal.', proofPath: 'Submission.lean',
        theoremName: 'Tutorial.progress_estimate', type: '1 = 1', dependsOn: [], ownerId: 'prover' }],
      progressReview: { id: pending.id, reason: 'The original proof has no checked intermediate fact; prove this estimate next.',
        nextChecks: [{ action: 'construction-check', targetTaskId: 'estimate', objective: 'Prove the exact estimate.',
          expectedEvidence: 'A kernel-checked estimate available to the original goal.' }] },
    }) + '\n');
    await cooperation.pulse(workers[0].id);
    await cooperation.deliver(workers[0], action, commitSolverSources(run.problem, workers[0].worktree));
    cooperation.deactivate(workers[0]); cooperation.deactivate(workers[1]);
    expect(state.cooperation!.goalProgress!.pending).toBeUndefined();
    expect(state.cooperation!.goalProgress!.decisions).toContainEqual(expect.objectContaining({ id: pending.id }));
    expect(engineer.interrupt).toHaveBeenCalledOnce();
    expect(cooperation.current(engineer.action)).toBe(false);
    const next = await cooperation.next(workers[2], budget);
    expect(next).toMatchObject({ kind: 'task', task: { id: 'estimate' } });
    expect(cooperation.started(workers[2], next!)).toBe(true);
    expect(run.check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined();
  });

  it.each(['checkpoint', 'invalid-plan', 'missing-answer', 'wrong-review-id'] as const)(
    'keeps an unanswered progress review after %s', async kind => {
      const run = fixture(); await run.startGoal(); await vi.advanceTimersByTimeAsync(interval);
      const action = await run.leadAction(), pending = structuredClone(run.state.cooperation!.goalProgress!.pending!);
      const patch = { baseVersion: action.planVersion, upsert: kind === 'invalid-plan'
        ? [{ id: 'goal_1', theoremName: 'Tutorial.changed_original' }] : [],
      ...(kind === 'missing-answer' || kind === 'checkpoint' ? {} : {
        progressReview: { id: kind === 'wrong-review-id' ? 'unpresented-review' : pending.id,
          reason: 'This response must only settle the exact presented valid decision.',
          nextChecks: [{ action: 'construction-check', targetTaskId: 'goal_1', objective: 'Check the original goal proof.',
            expectedEvidence: 'A checked proof or an exact residual goal.' }] },
      }) };
      const commit = kind === 'checkpoint' ? action.seedCommit : run.commitPlan(patch);
      await run.cooperation.deliver(run.workers[0], action, commit, kind === 'checkpoint', 'scheduling-checkpoint');
      run.cooperation.deactivate(run.workers[0]);
      expect(run.state.cooperation!.goalProgress!.pending?.id).toBe(pending.id);
      expect(run.events.filter(item => item.event === 'goal_progress_review_answered')).toHaveLength(0);
      expect(run.state.cooperation!.planRejection).toBeDefined();
      expect(run.state.cooperation!.lastLeadPauseInputDigest).toBeUndefined();
      if (kind === 'checkpoint' || kind === 'missing-answer')
        expect(run.state.cooperation!.error).toContain('math_plan_progress_review_missing');
      if (kind === 'wrong-review-id')
        expect(run.state.cooperation!.error).toContain('math_plan_progress_review_stale');
      expect(run.check).not.toHaveBeenCalled();
    });

  it('settles a progress decision saved in a checkpoint even when the accepted graph stays identical', async () => {
    const run = fixture(); await run.startGoal(); await vi.advanceTimersByTimeAsync(interval);
    const action = await run.leadAction(), archive = run.state.cooperation!, id = archive.goalProgress!.pending!.id;
    const planVersion = archive.planVersion;
    const commit = run.commitPlan({ baseVersion: action.planVersion, upsert: [], progressReview: { id,
      reason: 'Check the exact original construction before selecting a different route.',
      nextChecks: [{ action: 'construction-check', targetTaskId: 'goal_1', objective: 'Check the original construction.',
        expectedEvidence: 'A checked construction or its exact residual gap.' }] } });
    await run.cooperation.deliver(run.workers[0], action, commit, true, 'scheduling-checkpoint');
    run.cooperation.deactivate(run.workers[0]);
    expect(archive.planVersion).toBe(planVersion);
    expect(archive.goalProgress!.pending).toBeUndefined();
    expect(archive.goalProgress!.decisions?.filter(decision => decision.id === id)).toHaveLength(1);
    expect(run.events.filter(item => item.event === 'goal_progress_review_answered')).toHaveLength(1);
    expect(archive.lastLeadPauseInputDigest).toBeUndefined();
    expect(archive.error).toBeUndefined();
    expect(run.check).not.toHaveBeenCalled();
  });

  it.each(['model-disabled', 'plan-approval', 'provider-cooldown'] as const)(
    'excludes %s waiting from active execution and resumes the remaining interval', async gate => {
      const run = fixture(); await run.startGoal(); await vi.advanceTimersByTimeAsync(interval / 3);
      if (gate === 'model-disabled') run.setAllowed(false);
      if (gate === 'plan-approval') run.state.planApproval = true;
      if (gate === 'provider-cooldown') run.state.workers![1].recovery = { phase: 'cooling-down', reason: 'provider unavailable',
        cycles: 1, startedAt: Date.now(), nextRetryAt: Date.now() + interval * 10, waitedMs: 0 };
      run.cooperation.modelBudgetChanged();
      // A dispatch refresh observes the gate; no private host implementation is called by the fixture.
      const gated = tracked(run.cooperation.next(run.workers[0], budget));
      await flush(); await vi.advanceTimersByTimeAsync(interval * 4);
      expect(requested(run.events)).toHaveLength(0);
      expect(run.state.cooperation!.goalProgress!.goals[0].activeMs).toBe(interval / 3);
      run.setAllowed(true); run.state.planApproval = false; delete run.state.workers![1].recovery;
      run.cooperation.modelBudgetChanged();
      await flush(); await vi.advanceTimersByTimeAsync(interval * 2 / 3 - 1);
      expect(requested(run.events)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(requested(run.events)).toHaveLength(1);
      expect(await gated.promise).toMatchObject({ kind: 'lead' });
    });

  it.each(['model-disabled', 'plan-approval'] as const)('retains an already owed review behind the %s gate', async gate => {
    const run = fixture(); await run.startGoal(); await vi.advanceTimersByTimeAsync(interval);
    const id = run.state.cooperation!.goalProgress!.pending!.id;
    if (gate === 'model-disabled') run.setAllowed(false); else run.state.planApproval = true;
    run.cooperation.modelBudgetChanged();
    const next = tracked(run.cooperation.next(run.workers[0], budget));
    await flush(); await vi.advanceTimersByTimeAsync(interval * 2);
    expect(next.finished()).toBe(false);
    expect(run.state.cooperation!.goalProgress!.pending!.id).toBe(id);
    expect(run.events.filter(item => item.event === 'goal_progress_review_dispatched')).toHaveLength(0);
    run.setAllowed(true); run.state.planApproval = false; run.cooperation.modelBudgetChanged();
    expect(await next.promise).toMatchObject({ kind: 'lead' });
    expect(run.state.cooperation!.goalProgress!.pending!.id).toBe(id);
    expect(run.events.filter(item => item.event === 'goal_progress_review_dispatched')).toHaveLength(1);
  });

  it('preserves execution spent before stop while excluding a saved run\'s offline interval', async () => {
    const run = fixture(); await run.startGoal(); await vi.advanceTimersByTimeAsync(interval / 3);
    await run.cooperation.stop();
    const saved = run.state.cooperation!.goalProgress!.goals[0].activeMs;
    expect(saved).toBe(interval / 3);
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    await run.restart();
    expect(run.state.cooperation!.goalProgress!.goals[0].activeMs).toBe(saved);
    expect(run.state.cooperation!.goalProgress!.goals[0].active).toBe(false);
    await run.startGoal();
    await vi.advanceTimersByTimeAsync(interval - saved - 1);
    expect(requested(run.events)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run.cooperation.next(run.workers[0], budget)).toMatchObject({ kind: 'lead' });
    expect(requested(run.events)).toHaveLength(1);
  });

  it('keeps the global progress review in Lead context and out of every peer projection', async () => {
    const run = fixture(), engineer = await run.startGoal(); await vi.advanceTimersByTimeAsync(interval);
    const action = await run.leadAction();
    expect(run.cooperation.contextState(action, run.workers[0]).goalProgress?.pending).toBeDefined();
    for (const worker of run.workers.slice(1)) {
      expect(run.cooperation.contextState(worker.id === 'engineer' ? engineer.action : undefined, worker).goalProgress).toBeUndefined();
      const context = JSON.parse(fs.readFileSync(path.join(worker.worktree, 'COOPERATION.json'), 'utf8'));
      expect(context).not.toHaveProperty('goalProgress');
    }
    expect(JSON.parse(fs.readFileSync(path.join(run.workers[0].worktree, 'COOPERATION.json'), 'utf8')).goalProgress.pending)
      .toMatchObject({ id: run.state.cooperation!.goalProgress!.pending!.id });
  });
});
