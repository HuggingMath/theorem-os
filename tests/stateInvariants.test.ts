import { describe, expect, it } from 'vitest';
import type { SolverRunState, SolverWorkerState } from '../src/solver/archive';
import type { CooperationState } from '../src/solver/cooperationShared';
import { checkSolverRunState, restoreResidue } from '../src/solver/stateInvariants';
import { setTaskStatus, taskTransitionAllowed } from '../src/solver/taskLifecycle';
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
  it('reports the external-input stall seen in the M4 putnam_2010_a3 hang', () => {
    // Shape of the real snapshot: the goal waits on a blocked lemma and nothing can run.
    const stalled = state('checking', [
      node(task('fderiv_pair', 'lemma'), 'integrated', 'researcher-1'),
      node(task('line_hasDerivAt', 'lemma', ['fderiv_pair']), 'integrated', 'engineer'),
      node(task('bounded_self', 'lemma'), 'blocked', 'researcher-2'),
      node(task('goal', 'goal', ['line_hasDerivAt', 'bounded_self']), 'pending'),
    ], [worker('solver', 'checking', 'idle'), worker('researcher-1', 'checking', 'idle'),
      worker('researcher-2', 'finished', 'stopped'), worker('engineer', 'checking', 'idle')]);
    expect(codes(stalled)).toEqual(['warning:quiescent_awaiting_external_input']);
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

  it('reports out-of-order Lead wake counters and recorded invalid task transitions', () => {
    const tasks = [node(task('goal', 'goal'), 'pending')], workers = [worker('solver', 'finished')];
    expect(codes(state('finished', tasks, workers, { leadWakes: { requested: 2, consumed: 2, settled: 1 } }))).toEqual([]);
    expect(codes(state('finished', tasks, workers, { leadWakes: { requested: 1, consumed: 2, settled: 0 } })))
      .toEqual(['error:lead_wakes_invalid']);
    expect(codes(state('finished', tasks, workers, { invalidTaskTransitions: [
      { taskId: 'goal', from: 'completed', to: 'running', cause: 'dispatched', at: 1 }] })))
      .toEqual(['error:task_transition_invalid']);
  });

  it('admits each status change only through a cause that can produce it', () => {
    expect(taskTransitionAllowed('pending', 'running', 'dispatched')).toBe(true);
    expect(taskTransitionAllowed('completed', 'running', 'dispatched')).toBe(false);
    expect(taskTransitionAllowed('integrated', 'pending', 'interrupted')).toBe(false);
    expect(taskTransitionAllowed('delivered', 'integrated', 'integrated')).toBe(true);
    // An unchanged status is never a transition.
    expect(taskTransitionAllowed('blocked', 'blocked', 'dispatched')).toBe(true);
    const record = node(task('lemma', 'lemma'), 'completed');
    // The write still happens: diagnosis must see the state the code produced, not a silently repaired one.
    expect(setTaskStatus(record, 'running', 'dispatched')).toBe(false);
    expect(record.status).toBe('running');
  });

  it('finds process-local claims that a restore left behind', () => {
    const settled = { requested: 3, consumed: 2, settled: 2 };
    expect(restoreResidue({ tasks: [node(task('lemma', 'lemma'), 'pending', 'prover-1')], leadWakes: settled })).toEqual([]);
    const residue = restoreResidue({ tasks: [node(task('lemma', 'lemma'), 'running', 'prover-1')],
      review: { commit: 'c', sourceDigest: 's', status: 'running', workerId: 'reviewer' } as CooperationState['review'],
      leadWakes: { requested: 3, consumed: 3, settled: 2 } });
    expect(residue.map(item => item.code)).toEqual(['restore_running_task', 'restore_running_review',
      'restore_unsettled_lead_dispatch']);
    expect(restoreResidue({ tasks: [], leadWakes: { requested: 1, consumed: 1, settled: 1 } }).map(item => item.code))
      .toEqual(['restore_missing_initial_plan']);
  });
});
