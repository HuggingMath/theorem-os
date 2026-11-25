import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { directSolverModules } from '../src/solver/modules';
import { commitSolverSources } from '../src/solver/problem';
import { parseCooperationPlan } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const budget = { maxTurns: Infinity, remainingMs: Infinity };

function fixture(emitHook?: (event: string, details?: Record<string, unknown>) => void, addOtherWork = false) {
  const example = localExample('worker-exit-replay-', 'lead');
  const { directory, workspace, problem } = example;
  const workers = [leadWorker(problem, workspace), peerWorker(example, 'owner'), peerWorker(example, 'idle')];
  const [, owner, idle] = workers;
  const plan = parseCooperationPlan(problem, { tasks: [
    ...(addOtherWork ? [{ id: 'other', kind: 'research', objective: 'Run an independent enumeration.', ownerId: idle.id }] : []),
    { id: 'reserved', kind: 'research', objective: 'Investigate a local obstruction.', ownerId: owner.id },
    ...problem.targets.map((target, index) => ({ id: `goal_${index}`, kind: 'goal',
      objective: 'Original target.', theoremName: target.theoremName, proofPath: target.proofPath, status: 'paused' })),
  ] });
  const state = solverState(problem, workspace, { runId: 'worker-exit-replay', phase: 'running',
    workers: workers.map(worker => ({ ...worker, phase: 'running', turns: 0 })),
    cooperation: { canonicalCommit: problem.baseCommit, tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
      groups: plan.groups.map(group => ({ group, turns: 0 })) } });
  const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const emit = (event: string, details?: Record<string, unknown>) => { events.push({ event, details }); emitHook?.(event, details); };
  const controller = new AbortController();
  const forbidden = () => { throw new Error('fixture_model_and_verifier_forbidden'); };
  const newRuntime = (saved = state) => cooperativeResearch({ state: saved, workers, retrievalRoot: directory,
    emit, signal: controller.signal, modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open: forbidden },
      M2: { ...directSolverModules.M2, check: forbidden, checkTask: forbidden } } });
  const runtime = newRuntime();
  return { ...example, owner, idle, state, runtime, events, controller, newRuntime,
    reserved: state.cooperation!.tasks.find(node => node.task.id === 'reserved')! };
}

it.each(['registered', 'racing'] as const)('dispatches a stopped owner’s task with %s waiter timing', async timing => {
  let f: ReturnType<typeof fixture>;
  f = fixture((event, details) => {
    if (timing === 'racing' && event === 'dispatch_wait' && details?.workerId === 'idle')
      queueMicrotask(() => f.runtime.stopped(f.owner, 'fixture_worker_failed'));
  });
  let waiting: ReturnType<typeof f.runtime.next> | undefined;
  try {
    const original = await f.runtime.next(f.owner, budget);
    if (original?.kind !== 'task') throw new Error('owner task missing');
    expect(f.runtime.started(f.owner, original)).toBe(true);
    f.runtime.start();
    waiting = f.runtime.next(f.idle, budget);
    const observed = waiting.then(action => ({ task: action?.kind === 'task' && action.task.id }));
    if (timing === 'registered') {
      await new Promise<void>(resolve => setImmediate(resolve));
      f.runtime.stopped(f.owner, 'fixture_worker_failed');
    }
    expect(await Promise.race([observed, delay(1000, 'waiting')])).toEqual({ task: 'reserved' });
    expect(f.events.filter(item => item.event === 'task_assignment_released')).toEqual([{
      event: 'task_assignment_released', details: { taskId: 'reserved', workerId: f.owner.id, takenBy: f.idle.id, reason: 'worker-stopped' },
    }]);
  } finally {
    f.controller.abort();
    await Promise.allSettled([waiting]);
    await f.runtime.stop();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

it('preserves a stopped worker’s draft when the live peer takes a different task', async () => {
  const f = fixture(undefined, true);
  let resumed: ReturnType<typeof f.newRuntime> | undefined;
  try {
    const action = await f.runtime.next(f.owner, budget);
    if (action?.kind !== 'task') throw new Error('owner task missing');
    expect(action.task.id).toBe('reserved');
    expect(f.runtime.started(f.owner, action)).toBe(true);
    const marker = 'A checked bound for the original task.';
    const proofFile = path.join(f.owner.worktree, f.problem.projectRelative, 'Submission.lean');
    fs.appendFileSync(proofFile, '\n-- ' + marker + '\n');
    fs.writeFileSync(path.join(f.owner.worktree, 'RESEARCH.md'), marker + '\n');
    const commit = commitSolverSources(f.problem, f.owner.worktree);
    f.runtime.retainContextDraft(f.owner, action, commit);
    f.runtime.stopped(f.owner, 'fixture_worker_failed');
    expect(f.reserved.assignment?.assignmentId).toBe(action.assignment.assignmentId);
    expect(f.state.cooperation!.researchDrafts!.reserved.commit).toBe(commit);
    const candidate = await f.runtime.next(f.idle, budget);
    expect(candidate).toMatchObject({ kind: 'task', task: { id: 'other' } });
    expect(f.reserved).toMatchObject({ status: 'pending' });
    expect(f.reserved.assignment?.assignmentId).toBe(action.assignment.assignmentId);
    expect(f.events.some(item => item.event === 'task_assignment_released')).toBe(false);
    const previous = JSON.parse(JSON.stringify(f.state)) as typeof f.state;
    resumed = f.newRuntime(previous);
    await resumed.restore();
    const afterRestart = await resumed.next(f.owner, budget);
    expect(afterRestart).toMatchObject({ kind: 'task', task: { id: 'reserved' } });
    if (afterRestart?.kind !== 'task') throw new Error('restart task missing');
    expect(afterRestart.assignment.assignmentId).toBe(action.assignment.assignmentId);
    expect(fs.readFileSync(proofFile, 'utf8')).toContain(marker);
    expect(previous.cooperation!.researchDrafts!.reserved.commit).toBe(commit);
  } finally {
    f.controller.abort();
    await resumed?.stop();
    await f.runtime.stop();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
