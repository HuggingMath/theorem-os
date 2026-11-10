import { describe, it, expect } from 'vitest';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { markTaskAcceptance, taskVersion, type RouteRecord, type TaskRecord } from '../src/solver/tasks';
import { configuredSolverModules } from '../src/solver/modules';
import { createTaskConnectionCheck } from '../src/solver/taskConnections';

it('keeps M3 priority for both proof roles under every configured scheduler', () => {
  const researcher: ResearchWorker = { id: 'researcher', role: 'researcher', worktree: '/researcher', ownedFiles: [] };
  const engineer: ResearchWorker = { ...researcher, id: 'engineer', role: 'engineer' };
  const goal: TaskRecord = { task: { id: 'original', kind: 'goal', objective: 'Original', dependsOn: [], revision: 0 }, status: 'pending', attempts: 0 };
  const research: TaskRecord = { ...goal, task: { ...goal.task, id: 'explore', kind: 'research' } };
  for (const scheduler of ['plan', 'critical-path', 'continuation']) {
    const { M5 } = configuredSolverModules('direct', scheduler);
    for (const worker of [researcher, engineer]) {
      expect(M5.assign([goal, research], worker, [researcher, engineer])).toBe(goal);
      expect(M5.assign([research, goal], worker, [researcher, engineer])).toBe(research);
      const pinned = { ...goal, task: { ...goal.task, ownerId: 'other' } };
      expect(M5.assign([pinned, research], worker, [researcher, engineer])).toBe(research);
      expect(M5.assign([{ ...goal, assignment: { taskId: 'original', taskDigest: 'version', workerId: 'other', seedCommit: 'seed' } }],
        worker, [researcher, engineer])).toBeUndefined();
    }
    const groups = [{ group: { id: 'main', objective: 'Proof', status: 'active' as const, revision: 0, engineerId: engineer.id }, turns: 0 }];
    expect(M5.assign([goal, research], researcher, [researcher, engineer], groups)).toBe(research);
    expect(M5.assign([goal, research], engineer, [researcher, engineer], groups)).toBe(goal);
    expect(M5.assign([goal], { ...researcher, role: 'lead' }, [researcher, engineer])).toBeUndefined();
  }
});

const capacityWorker = (id: string, role: ResearchWorker['role'] = 'researcher'): ResearchWorker => ({
  id, role, worktree: `/fixture/${id}`, ownedFiles: [],
});
const capacityNode = (id: string, kind: TaskRecord['task']['kind'] = 'lemma', dependsOn: string[] = []): TaskRecord => ({
  task: { id, kind, objective: `Investigate ${id}`, dependsOn, revision: 0,
    // Capacity fixtures isolate ordinary dependency waiting from the first application check.
    ...(kind === 'goal' ? { conditional: false } : {}),
    ...(['lemma', 'goal'].includes(kind) ? { theoremName: id, proofPath: 'Submission.lean', type: 'True' } : {}) },
  status: 'pending', attempts: 0,
});
const occupy = (record: TaskRecord, workerId: string) => {
  record.status = 'running';
  record.assignment = { taskId: record.task.id, taskDigest: taskVersion(record.task), workerId, seedCommit: 'fixture' };
};
const capacityGroup = (maxConcurrent?: number): RouteRecord => ({
  group: { id: 'main', objective: 'Original proof', status: 'active', revision: 0, maxConcurrent }, turns: 0,
});
function capacityFixture(slots = 3, occupied = slots - 1) {
  const workers = Array.from({ length: slots }, (_, index) => capacityWorker(`worker-${index}`, index === slots - 1 ? 'engineer' : 'researcher'));
  const running = Array.from({ length: occupied }, (_, index) => capacityNode(`working-${index}`));
  running.forEach((record, index) => occupy(record, workers[index]!.id));
  const core = capacityNode('core'), independent = capacityNode('independent', 'research');
  const goal = capacityNode('original', 'goal', [...running.map(record => record.task.id), core.task.id]);
  return { workers, running, core, independent, goal, tasks: [...running, core, independent, goal] };
}

function connectionCapacityFixture() {
  const workers = [capacityWorker('connecting'), capacityWorker('screening')];
  const input = capacityNode('input'), first = capacityNode('application', 'lemma', ['input']);
  const goal = capacityNode('original', 'goal', [first.task.id]);
  goal.task = { ...goal.task, conditional: true };
  const research = capacityNode('construction', 'research');
  research.task = { ...research.task, consumerGoalIds: [goal.task.id] };
  const tasks = [input, first, goal, research];
  occupy(goal, workers[0].id);
  goal.assignment!.dependencies = [{ taskId: first.task.id, taskDigest: taskVersion(first.task) }];
  goal.assignment!.connectionCheck = createTaskConnectionCheck(goal.task, goal.assignment!, tasks,
    { environmentDigest: 'fixture-env', problemReceiptDigest: 'fixture-problem' });
  return { workers, input, first, goal, research, tasks, groups: [capacityGroup(3)] };
}

describe.each(['plan', 'critical-path', 'continuation'])('%s shared proof capacity', scheduler => {
  it('screens related untried research before filling the last slot with another conditional application', () => {
    const { workers, first, research, tasks, groups } = connectionCapacityFixture();
    const modules = configuredSolverModules('direct', scheduler);
    expect(modules.M5.assign([first, research], workers[1], workers, groups, tasks)).toBe(research);
  });

  it('lets a yielded conditional goal screen its untried research before resuming the saved application', () => {
    const { workers, first, goal, research, tasks, groups } = connectionCapacityFixture();
    goal.status = 'pending'; goal.attempts = 1; goal.assignment!.workerId = workers[1].id;
    goal.assignment!.connectionCheck = createTaskConnectionCheck(goal.task, goal.assignment!, tasks,
      { environmentDigest: 'fixture-env', problemReceiptDigest: 'fixture-problem' });
    occupy(first, workers[0].id);
    const modules = configuredSolverModules('direct', scheduler);
    expect(modules.M5.assign([goal, research], workers[1], workers, groups, tasks)).toBe(research);
  });

  it.each(['attempted', 'owner', 'assignment', 'other-goal', 'other-group', 'stale-connection',
    'changed-connection-input', 'spare-slot', 'already-researching', 'unconditional-goal'] as const)(
    'preserves eligibility and proof priority when %s', control => {
      const { workers, first, goal, research, tasks, groups } = connectionCapacityFixture();
      if (control === 'attempted') research.attempts = 1;
      if (control === 'owner') research.task = { ...research.task, ownerId: 'other' };
      if (control === 'assignment') research.assignment = { taskId: research.task.id,
        taskDigest: taskVersion(research.task), workerId: 'other', seedCommit: 'fixture' };
      if (control === 'other-goal') research.task = { ...research.task, consumerGoalIds: ['other'] };
      if (control === 'other-group') research.task = { ...research.task, groupId: 'other' };
      if (control === 'stale-connection') goal.assignment!.connectionCheck!.basisDigest = 'stale';
      if (control === 'changed-connection-input') first.task = { ...first.task, revision: first.task.revision + 1 };
      if (control === 'spare-slot') workers.push(capacityWorker('spare'));
      if (control === 'already-researching') {
        const active = capacityNode('active-research', 'research');
        active.task = { ...active.task, consumerGoalIds: [goal.task.id] };
        const peer = capacityWorker('peer'); workers.push(peer); occupy(active, peer.id); tasks.push(active);
      }
      if (control === 'unconditional-goal') first.task = { ...first.task, kind: 'goal', conditional: false };
      const modules = configuredSolverModules('direct', scheduler);
      expect(modules.M5.assign([first, research], workers[1], workers, groups, tasks)).toBe(first);
    });

  it.each([2, 3, 4])('reserves the last of %i actual proof slots for an independent question', slots => {
    const workers = Array.from({ length: slots }, (_, index) => capacityWorker(`worker-${index}`));
    const support = Array.from({ length: slots + 1 }, (_, index) => capacityNode(`support-${index}`));
    const independent = capacityNode('independent', 'research');
    const tasks = [...support, independent, capacityNode('original', 'goal', support.map(record => record.task.id))];
    const groups = [capacityGroup(slots + 1)], modules = configuredSolverModules('direct', scheduler);
    const assigned = workers.map(worker => {
      const selected = modules.M5.assign(modules.M3.ready(tasks, groups), worker, workers, groups, tasks)!;
      expect(selected).toBeDefined(); occupy(selected, worker.id); return selected.task.id;
    });
    expect(assigned).toEqual([...support.slice(0, slots - 1).map(record => record.task.id), independent.task.id]);
  });

  it('continues M3 work when the independent question is absent, pinned elsewhere or already active', () => {
    for (const control of ['absent', 'owner', 'assignment', 'already-running'] as const) {
      const fixture = capacityFixture(), { workers, running, core, independent, tasks } = fixture;
      if (control === 'absent') tasks.splice(tasks.indexOf(independent), 1);
      if (control === 'owner') independent.task = { ...independent.task, ownerId: 'other' };
      if (control === 'assignment') independent.assignment = { taskId: independent.task.id, taskDigest: taskVersion(independent.task), workerId: 'other', seedCommit: 'fixture' };
      if (control === 'already-running') {
        running[1]!.status = 'completed'; occupy(independent, workers[1]!.id);
      }
      const groups = [capacityGroup(5)], modules = configuredSolverModules('direct', scheduler), before = structuredClone(tasks);
      expect(modules.M5.assign(modules.M3.ready(tasks, groups), workers.at(-1)!, workers, groups, tasks)).toBe(core);
      expect(tasks).toEqual(before);
    }
  });
});

describe('proof capacity accounting', () => {
  const modules = configuredSolverModules('direct', 'plan');
  it('deduplicates live proof identities and excludes lead and reviewer roles', () => {
    const { workers, core, independent, tasks } = capacityFixture(2), groups = [capacityGroup(5)];
    const live = [...workers, ...workers, capacityWorker('lead', 'lead'), capacityWorker('reviewer', 'reviewer')];
    expect(modules.M5.assign([core, independent], workers[1]!, live, groups, tasks)).toBe(independent);
  });

  it.each(['stopped', 'unassigned', 'stale'] as const)('does not count a %s running record as occupied proof capacity', control => {
    const { workers, running, core, independent, tasks } = capacityFixture(2), groups = [capacityGroup(5)];
    if (control === 'stopped') running[0]!.assignment!.workerId = 'stopped-worker';
    if (control === 'unassigned') running[0]!.assignment = undefined;
    if (control === 'stale') running[0]!.assignment!.taskDigest = 'old-task-version';
    expect(modules.M5.assign([core, independent], workers[1]!, workers, groups, tasks)).toBe(core);
  });

  it('counts one occupied slot for several restored records naming the same worker', () => {
    const { workers, running, core, independent, tasks } = capacityFixture(3), groups = [capacityGroup(5)];
    running[1]!.assignment!.workerId = workers[0]!.id;
    expect(modules.M5.assign([core, independent], workers[2]!, workers, groups, tasks)).toBe(core);
  });

  it.each([undefined, 3])('reserves the last group slot with maxConcurrent %s despite spare live workers', maxConcurrent => {
    const { workers, core, independent, tasks } = capacityFixture(4, 2), groups = [capacityGroup(maxConcurrent)];
    expect(modules.M5.assign(modules.M3.ready(tasks, groups), workers[2]!, workers, groups, tasks)).toBe(independent);
    groups[0]!.group = { ...groups[0]!.group, maxConcurrent: 4 };
    expect(modules.M5.assign(modules.M3.ready(tasks, groups), workers[2]!, workers, groups, tasks)).toBe(core);
  });

  it('honors an explicit group concurrency reservation', () => {
    const { workers, core, independent, tasks } = capacityFixture(4, 1), groups = [{ ...capacityGroup(3), busy: 2 }];
    expect(modules.M5.assign([core, independent], workers[2]!, workers, groups, tasks)).toBe(independent);
  });

  it.each(['owner', 'assignment'] as const)('allows an independent candidate pinned to the current worker through %s', pin => {
    const { workers, core, independent, tasks } = capacityFixture(2), worker = workers[1]!, groups = [capacityGroup(5)];
    if (pin === 'owner') independent.task = { ...independent.task, ownerId: worker.id };
    else independent.assignment = { taskId: independent.task.id, taskDigest: taskVersion(independent.task), workerId: worker.id, seedCommit: 'fixture' };
    expect(modules.M5.assign([core, independent], worker, workers, groups, tasks)).toBe(independent);
  });

  it('prefers another original-goal route over a peripheral question', () => {
    const { workers, running, core, independent, goal, tasks } = capacityFixture(2);
    const checked = capacityNode('checked'); checked.status = 'integrated';
    checked.integratedCheck = { passed: true, taskDigest: taskVersion(checked.task), conditions: [],
      verification: { status: 'kernel_verified', targetCommit: 'checked', results: [
        { status: 'kernel_verified', targetCommit: 'checked', receiptId: 'fixture-receipt' },
      ] } } as TaskRecord['integratedCheck'];
    markTaskAcceptance(checked.integratedCheck!);
    const alternate = capacityNode('alternate'), closeA = capacityNode('close_a', 'lemma', ['checked', running[0]!.task.id, 'core']),
      closeB = capacityNode('close_b', 'lemma', ['alternate']);
    goal.task = { ...goal.task, dependsOn: [] };
    goal.alternativeRoutes = [
      { id: 'route_a', targetTaskId: goal.task.id, prerequisiteTaskIds: ['checked', running[0]!.task.id, 'core'], closingTaskId: 'close_a' },
      { id: 'route_b', targetTaskId: goal.task.id, prerequisiteTaskIds: ['alternate'], closingTaskId: 'close_b' },
    ];
    alternate.attempts = 10;
    tasks.push(checked, alternate, closeA, closeB);
    expect(modules.M5.assign([core, independent, alternate], workers[1]!, workers, undefined, tasks)).toBe(alternate);
  });

  it('uses attempts to break equally ranked independent candidates without changing M3 otherwise', () => {
    const { workers, core, independent, tasks } = capacityFixture(2), fresh = capacityNode('fresh', 'research');
    independent.attempts = 5; tasks.push(fresh);
    expect(modules.M5.assign([core, independent, fresh], workers[1]!, workers, undefined, tasks)).toBe(fresh);
    expect(modules.M5.assign([independent, core, fresh], workers[1]!, workers, undefined, tasks)).toBe(independent);
  });
});
