import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import type { CooperativeResearch } from '../src/solver/cooperation';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { TaskTypePreflightCache, type TaskTypePreflight } from '../src/solver/taskTypePreflight';
import { parseCooperationPlan, taskVersion, type CooperativeAction } from '../src/solver/tasks';
import { deferred } from './helpers/async';
import { cooperativeResearch, workerDeliveryModules } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

type Check = Awaited<ReturnType<TaskTypePreflightCache['check']>>;
type Action = Extract<CooperativeAction, { kind: 'task' }>;
const budget = { maxTurns: Infinity, remainingMs: Infinity };
describe('route capacity during concurrent host preflight', () => {
  let directory: string, state: SolverRunState, controller: AbortController, scheduler: CooperativeResearch;
  let first: ResearchWorker, second: ResearchWorker;
  const active = new Map<string, { signal: AbortSignal; finish: () => void }[]>();
  const waits: Promise<CooperativeAction | undefined>[] = [];
  const events: { name: string; detail?: Record<string, unknown> }[] = [];
  const next = (worker: ResearchWorker) => {
    const result = scheduler.next(worker, budget);
    waits.push(result);
    void result.catch(() => {});
    return result;
  };
  const held = (id: string, index = 0) => active.get(id)![index]!;
  const names = () => [...active].flatMap(([id, calls]) => calls.map(() => id));
  const busy = () => state.cooperation!.groups!.find(group => group.group.id === 'main')?.busy;
  const node = (id: string) => state.cooperation!.tasks.find(task => task.task.id === id)!;
  const assigned = () => events.filter(event => event.name === 'task_assigned').map(event => event.detail?.taskId);
  const waitUntil = async (predicate: () => boolean) => {
    for (let retry = 0; !predicate() && retry < 20; retry++) await new Promise(resolve => setImmediate(resolve));
    expect(predicate()).toBe(true);
  };
  beforeEach(() => {
    active.clear(); events.length = 0;
    const example = localExample('route-preflight-contention-', 'lead');
    directory = example.directory;
    const lead = leadWorker(example.problem, example.workspace);
    first = peerWorker(example, 'first'); second = peerWorker(example, 'second');
    const workers = [lead, first, second];
    const plan = parseCooperationPlan(example.problem, { tasks: [
      { id: 'first_helper', kind: 'lemma', objective: 'First independent helper', theoremName: 'Tutorial.first_helper',
        proofPath: 'Submission.lean', type: 'True', ownerId: first.id },
      { id: 'second_helper', kind: 'lemma', objective: 'Second independent helper', theoremName: 'Tutorial.second_helper',
        proofPath: 'Submission.lean', type: 'True', ownerId: second.id },
      ...example.problem.targets.map((target, index) => ({ id: 'goal_' + index, kind: 'goal',
        objective: 'Frozen target', theoremName: target.theoremName, proofPath: target.proofPath, status: 'paused' })),
    ], groups: [{ id: 'main', objective: 'Run one proof at a time.', maxConcurrent: 1 },
      { id: 'other', objective: 'Independent route with its own capacity.', maxConcurrent: 1 }] });
    state = solverState(example.problem, example.workspace, { runId: 'preflight-replay', phase: 'running',
      workers: workers.map(worker => ({ ...worker, phase: 'running', turns: 0 })),
      cooperation: { canonicalCommit: example.problem.baseCommit,
        tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    controller = new AbortController();
    scheduler = cooperativeResearch({ state, workers, retrievalRoot: directory, signal: controller.signal,
      modules: workerDeliveryModules, emit: (name, detail) => events.push({ name, detail }) });
    vi.spyOn(TaskTypePreflightCache.prototype, 'check').mockImplementation(({ task, signal }) => {
      const gate = deferred<Check>();
      const calls = active.get(task.id) ?? [];
      calls.push({ signal: signal!, finish: () => gate.resolve({ current: () => true,
        result: { status: 'elaborated', inputDigest: task.id, taskDigest: taskVersion(task), reason: 'fixture',
          evidence: 'advisory-type-elaboration', proofAcceptance: 'not-assessed' } as TaskTypePreflight }) });
      active.set(task.id, calls);
      return gate.promise;
    });
  });
  afterEach(async () => {
    controller.abort();
    for (const calls of active.values()) for (const call of calls) call.finish();
    await Promise.allSettled(waits.splice(0));
    await scheduler.stop();
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('holds the final route slot from preflight through model dispatch', async () => {
    const firstPending = next(first);
    const secondPending = next(second);
    await waitUntil(() => state.workers![2].scheduling?.wait !== undefined);
    expect(names()).toEqual(['first_helper']);
    expect(assigned()).toEqual([]);
    expect(busy()).toBe(1);
    expect(held('first_helper').signal.aborted).toBe(false);
    held('first_helper').finish();
    const firstAction = await firstPending as Action;
    expect(firstAction.task.id).toBe('first_helper');
    expect(busy()).toBe(1);
    expect(names()).toEqual(['first_helper']);
    expect(node('second_helper')).toMatchObject({ status: 'pending', attempts: 0 });

    scheduler.release(first, firstAction);
    await waitUntil(() => active.has('second_helper'));
    held('second_helper').finish();
    expect(await secondPending).toMatchObject({ kind: 'task', task: { id: 'second_helper' } });
    expect(names()).toEqual(['first_helper', 'second_helper']);
    expect(assigned()).toEqual(['first_helper', 'second_helper']);
  });

  it('retains the concurrent preflight on a separate route', async () => {
    node('second_helper').task = { ...node('second_helper').task, groupId: 'other' };
    const firstPending = next(first);
    const secondPending = next(second);
    await waitUntil(() => names().length === 2);
    held('first_helper').finish();
    expect(await firstPending).toMatchObject({ kind: 'task', task: { id: 'first_helper' } });
    expect(held('second_helper').signal.aborted).toBe(false);
    held('second_helper').finish();
    expect(await secondPending).toMatchObject({ kind: 'task', task: { id: 'second_helper' } });
    expect(names()).toEqual(['first_helper', 'second_helper']);
  });

  it('keeps a stopped owner’s assignment when the peer preflight is cancelled', async () => {
    node('second_helper').task = { ...node('second_helper').task, status: 'paused' };
    const original = next(first);
    held('first_helper').finish();
    const firstAction = await original as Action;
    expect(scheduler.started(first, firstAction)).toBe(true);
    scheduler.stopped(first);
    const takeover = next(second);
    await waitUntil(() => active.get('first_helper')?.length === 2);
    expect(node('first_helper').assignment).toBe(firstAction.assignment);

    scheduler.stopped(second);
    expect(held('first_helper', 1).signal.aborted).toBe(true);
    held('first_helper', 1).finish();
    expect(await takeover).toBeUndefined();
    expect(node('first_helper').assignment).toBe(firstAction.assignment);
    expect(events.some(event => event.name === 'task_assignment_released')).toBe(false);
    expect(busy()).toBe(0);
  });

  it('wakes an idle peer for fixed review when the preferred worker enters cooldown', async () => {
    node('first_helper').task = { ...node('first_helper').task, status: 'paused' };
    node('second_helper').task = { ...node('second_helper').task, status: 'paused' };
    const commit = state.cooperation!.canonicalCommit!;
    scheduler.requireReview({ commit, sourceDigest: 'fixture-source', passed: true,
      verification: { schema: 'deepscientist.mathematics.verification-batch/v1', sessionId: 'fixture',
        status: 'kernel_verified', results: [], targetCommit: commit, events: [], startedAt: 0, checkedAt: 0, durationMs: 0 } });
    const offered = next(second);
    expect(await Promise.race([offered, delay(30, 'waiting')])).toBe('waiting');
    state.workers![1]!.recovery = { phase: 'cooling-down', reason: 'math_model_request_failed', cycles: 4,
      nextRetryAt: Date.now() + 300_000, startedAt: Date.now(), waitedMs: 0 };
    scheduler.workerAvailabilityChanged();
    expect(await Promise.race([offered, delay(1000, 'waiting')])).toMatchObject({ kind: 'review', seedCommit: commit });
    expect(state.cooperation!.review).toMatchObject({ status: 'running', workerId: second.id });
  });

  it('gives fixed review to the idle peer while the preferred worker is in preflight', async () => {
    node('second_helper').task = { ...node('second_helper').task, status: 'paused' };
    const firstPending = next(first);
    await waitUntil(() => names().length === 1);
    const commit = state.cooperation!.canonicalCommit!;
    scheduler.requireReview({ commit, sourceDigest: 'fixture-source', passed: true,
      verification: { schema: 'deepscientist.mathematics.verification-batch/v1', sessionId: 'fixture',
        status: 'kernel_verified', results: [], targetCommit: commit, events: [], startedAt: 0, checkedAt: 0, durationMs: 0 } });
    expect(state.workers![1].scheduling).toMatchObject({ status: 'preparing', taskId: 'first_helper' });
    expect(state.workers![2].scheduling?.status).toBe('idle');
    expect(await Promise.race([next(second), delay(1000, 'waiting')])).toMatchObject({ kind: 'review', seedCommit: commit });
    expect(state.cooperation!.review).toMatchObject({ status: 'running', workerId: second.id });
    expect(held('first_helper').signal.aborted).toBe(false);
    held('first_helper').finish();
    expect(await firstPending).toMatchObject({ kind: 'task', task: { id: 'first_helper' } });
  });
});
