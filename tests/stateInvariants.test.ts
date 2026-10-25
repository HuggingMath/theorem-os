import { describe, expect, it } from 'vitest';
import type { SolverRunState, SolverWorkerState } from '../src/solver/archive';
import type { CooperationState } from '../src/solver/cooperationShared';
import { checkSolverRunState } from '../src/solver/stateInvariants';
import type { CooperativeTask, TaskRecord } from '../src/solver/tasks';

const task = (id: string, kind: CooperativeTask['kind'], dependsOn: string[] = []): CooperativeTask =>
  ({ id, kind, objective: `Settle ${id}.`, dependsOn, revision: 0 });
const node = (value: CooperativeTask, status: TaskRecord['status'], workerId?: string): TaskRecord =>
  ({ task: value, status, attempts: workerId ? 1 : 0,
    ...(workerId ? { assignment: { taskId: value.id, taskDigest: 'digest', workerId, seedCommit: 'seed' } } : {}) });
const worker = (id: string, phase: SolverWorkerState['phase'], scheduling?: 'working' | 'idle' | 'stopped') =>
  ({ id, role: id === 'solver' ? 'lead' : 'researcher', worktree: `/unused/${id}`, phase, turns: 1,
    ...(scheduling ? { scheduling: { status: scheduling, since: 0 } } : {}) }) as SolverWorkerState;
const state = (phase: SolverRunState['phase'], tasks: TaskRecord[], workers: SolverWorkerState[],
  cooperation: Partial<CooperationState> = {}) => ({ phase, workers, cooperation: { tasks, ...cooperation } }) as SolverRunState;
const codes = (value: SolverRunState) => checkSolverRunState(value).map(item => `${item.severity}:${item.code}`);

describe('persisted solver state invariants', () => {
  it('reports the dangling investigation and external-input stall seen in the M4 putnam_2010_a3 hang', () => {
    // Shape of the real snapshot: the goal waits on a blocked lemma; the recovery points at a removed task.
    const stalled = state('checking', [
      node(task('fderiv_pair', 'lemma'), 'integrated', 'researcher-1'),
      node(task('line_hasDerivAt', 'lemma', ['fderiv_pair']), 'integrated', 'engineer'),
      node(task('bounded_self', 'lemma'), 'blocked', 'researcher-2'),
      node(task('goal', 'goal', ['line_hasDerivAt', 'bounded_self']), 'pending'),
    ], [worker('solver', 'checking', 'idle'), worker('researcher-1', 'checking', 'idle'),
      worker('researcher-2', 'finished', 'stopped'), worker('engineer', 'checking', 'idle')], {
      frontierRecoveries: [{ id: 'recovery', taskIds: ['bounded_self'], goalIds: ['goal'], status: 'awaiting-input',
        taskInputDigests: ['input'], investigationTaskId: 'frontier_input_recovery' }],
      frontierWaiting: { inputDigest: 'input', taskIds: ['bounded_self'], goalIds: ['goal'], reason: 'awaiting-new-mathematical-input' },
    });
    expect(codes(stalled)).toEqual(['warning:recovery_investigation_missing', 'warning:quiescent_awaiting_external_input']);
    expect(checkSolverRunState(stalled).at(-1)!.refs).toEqual(['goal']);
  });

  it('reports a lost wake-up when ready work exists and every worker is idle', () => {
    expect(codes(state('running', [node(task('lemma', 'lemma'), 'pending'), node(task('goal', 'goal', ['lemma']), 'pending')],
      [worker('solver', 'running', 'idle'), worker('researcher-1', 'prepared', 'idle')])))
      .toEqual(['error:quiescent_with_ready_work']);
  });

  it('does not judge liveness while a worker is active or after the host released the state', () => {
    const tasks = [node(task('goal', 'goal'), 'pending')];
    expect(codes(state('running', tasks, [worker('solver', 'running', 'working')]))).toEqual([]);
    expect(codes(state('finished', tasks, [worker('solver', 'finished', 'stopped')]))).toEqual([]);
  });

  it('rejects broken graph references, cycles and double ownership', () => {
    const broken = state('finished', [
      node(task('a', 'lemma', ['b']), 'pending'), node(task('b', 'lemma', ['a']), 'pending'),
      node(task('c', 'lemma', ['missing']), 'running'),
      node(task('d', 'lemma'), 'running', 'prover-1'), node(task('e', 'lemma'), 'running', 'prover-1'),
      node(task('f', 'lemma'), 'integrated', 'ghost'), node(task('f', 'lemma'), 'integrated', 'continuation'),
    ], [worker('solver', 'finished'), worker('prover-1', 'finished')]);
    expect(codes(broken).toSorted()).toEqual(['error:task_assignment_unknown_worker', 'error:task_dependency_cycle',
      'error:task_dependency_missing', 'error:task_duplicate_id', 'error:task_running_unassigned',
      'error:worker_multiple_running_tasks']);
  });

  it('accepts a consistent graph with an imported continuation proof', () => {
    expect(codes(state('running', [node(task('lemma', 'lemma'), 'integrated', 'continuation'),
      node(task('goal', 'goal', ['lemma']), 'running', 'solver')], [worker('solver', 'running', 'working')]))).toEqual([]);
  });
});
