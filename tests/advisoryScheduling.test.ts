import { describe, expect, it } from 'vitest';
import { assignSharedResearchTask, researchWorkers } from '../src/solver/modules/organization';
import { readyResearchTasks } from '../src/solver/modules/search';
import { taskVersion, type CooperativeTask, type RouteRecord, type TaskRecord } from '../src/solver/tasks';

const workers = researchWorkers('/disposable/scheduling-fixture', [], 4);
const engineer = workers.find(worker => worker.id === 'engineer')!;
const task = (id: string, kind: CooperativeTask['kind'] = 'research', overrides: Partial<CooperativeTask> = {}): TaskRecord => ({
  task: { id, kind, objective: `Investigate ${id}`, revision: 0, dependsOn: [],
    ...(kind === 'goal' || kind === 'lemma' ? { proofPath: 'Submission.lean', theoremName: id, type: 'True' } : {}), ...overrides },
  status: 'pending', attempts: 0,
});
const assign = (node: TaskRecord, workerId: string) => {
  node.assignment = { assignmentId: `saved-${node.task.id}`, taskId: node.task.id, taskDigest: taskVersion(node.task),
    workerId, seedCommit: 'saved-source-commit' };
  return node;
};
const ids = (nodes: readonly TaskRecord[]) => nodes.map(node => node.task.id);

describe('advisory work at an equal scheduling priority', () => {
  it('gives an untried investigation a turn after the SAT-style repeated checkpoint', () => {
    const audit = assign(task('scaling-audit'), 'researcher-1'); Object.assign(audit, { status: 'running' });
    const goal = assign(task('goal', 'goal'), 'researcher-2'); Object.assign(goal, { status: 'running' });
    const upper = assign(task('ub-mechanism', 'research', { dependsOn: ['scaling-audit'] }), engineer.id);
    upper.attempts = 4;
    const nodes = [goal, audit, upper, task('lb-mechanism', 'research', { dependsOn: ['scaling-audit'] }),
      task('lean-plumbing'), task('literature-route')];
    const groups: RouteRecord[] = [{ group: { id: 'main', objective: 'Prove the goal', status: 'active', revision: 0 }, turns: 12, busy: 2 }];
    const before = structuredClone(nodes);
    const ready = readyResearchTasks(nodes, groups);
    expect(ids(ready)).toEqual(['lb-mechanism', 'lean-plumbing', 'literature-route', 'ub-mechanism']);
    expect(assignSharedResearchTask(ready, engineer, workers, groups, nodes)?.task.id).toBe('lb-mechanism');
    expect(nodes).toEqual(before);
  });

  it('keeps saved assignments available to their owner after another investigation settles', () => {
    const saved = assign(task('saved'), engineer.id); saved.attempts = 4;
    const fresh = task('fresh'), nodes = [saved, fresh];
    const assignment = saved.assignment;
    expect(assignSharedResearchTask(readyResearchTasks(nodes), engineer, workers, undefined, nodes)).toBe(fresh);
    Object.assign(fresh, { status: 'completed' });
    expect(assignSharedResearchTask(readyResearchTasks(nodes), engineer, workers, undefined, nodes)).toBe(saved);
    expect(saved.assignment).toBe(assignment);
    expect(assignSharedResearchTask(readyResearchTasks(nodes), workers[1]!, workers, undefined, nodes)).toBeUndefined();
  });

  it('preserves formal-proof slots and ready goal priority when advisory attempts differ', () => {
    const resumed = task('resumed'); resumed.attempts = 4;
    const helper = task('helper', 'lemma'), fresh = task('fresh'), goal = task('goal', 'goal');
    expect(ids(readyResearchTasks([resumed, helper, fresh, goal]))).toEqual(['goal', 'fresh', 'helper', 'resumed']);
  });

  it.each(['research', 'sketch'] as const)('dispatches an untried ready proof before repeatedly resumed %s on the same goal', kind => {
    const peer = workers.find(worker => worker.id === 'researcher-2')!;
    const running = [assign(task('working-left', 'lemma'), 'researcher-1'),
      assign(task('working-right', 'lemma'), engineer.id)];
    running.forEach(node => { node.status = 'running'; });
    const helper = task('ready-input', 'lemma'), second = task('other-ready-input', 'lemma');
    const goal = task('original', 'goal', { dependsOn: [...running.map(node => node.task.id), helper.task.id, second.task.id],
      conditional: false });
    const resumed = assign(task('resumed', kind, { ownerId: peer.id, dependsOn: [goal.task.id] }), peer.id);
    resumed.attempts = 12;
    const nodes = [resumed, helper, second, ...running, goal];
    const groups: RouteRecord[] = [{ group: { id: 'main', objective: 'Prove the goal', status: 'active', revision: 0 },
      turns: 24, busy: 2 }];
    const before = structuredClone(nodes);
    const ready = readyResearchTasks(nodes, groups);
    expect(ids(ready)).toEqual([helper.task.id, second.task.id, resumed.task.id]);
    expect(assignSharedResearchTask(ready, peer, workers, groups, nodes)).toBe(helper);
    expect(nodes).toEqual(before);
  });

  it('preserves the first investigation and only yields repeated research to an executable consumed proof', () => {
    const investigation = task('investigation');
    const helper = task('ready-input', 'lemma');
    const waiting = task('waiting-input', 'lemma', { dependsOn: [helper.task.id], conditional: false });
    const disconnected = task('disconnected', 'lemma');
    const goal = task('original', 'goal', { dependsOn: [waiting.task.id], conditional: false });
    const nodes = [investigation, disconnected, waiting, helper, goal];
    expect(ids(readyResearchTasks(nodes))).toEqual(['investigation', 'disconnected', helper.task.id]);
    investigation.attempts = 1;
    expect(ids(readyResearchTasks(nodes))).toEqual([helper.task.id, 'disconnected', 'investigation']);
    helper.task = { ...helper.task, ownerId: 'other' };
    expect(assignSharedResearchTask(readyResearchTasks(nodes), engineer, workers, undefined, nodes)).toBe(disconnected);
    helper.status = 'blocked';
    expect(ids(readyResearchTasks(nodes))).toEqual(['investigation', 'disconnected']);
  });

  it('keeps the last independent slot after a resumed investigation yields M3 priority', () => {
    const running = [assign(task('working-left', 'lemma'), 'researcher-1'),
      assign(task('working-right', 'lemma'), 'researcher-2')];
    running.forEach(node => { node.status = 'running'; });
    const resumed = task('independent'); resumed.attempts = 12;
    const helper = task('ready-input', 'lemma');
    const goal = task('original', 'goal', { dependsOn: [...running.map(node => node.task.id), helper.task.id], conditional: false });
    const nodes = [resumed, helper, ...running, goal];
    const groups: RouteRecord[] = [{ group: { id: 'main', objective: 'Prove the goal', status: 'active', revision: 0 },
      turns: 24, busy: 2 }];
    const ready = readyResearchTasks(nodes, groups);
    expect(ids(ready)).toEqual([helper.task.id, resumed.task.id]);
    expect(assignSharedResearchTask(ready, engineer, workers, groups, nodes)).toBe(resumed);
  });

  it('keeps a fresh feasibility review before a ready proof and resumed research', () => {
    const resumed = task('resumed'); resumed.attempts = 12;
    const helper = task('ready-input', 'lemma');
    const goal = task('original', 'goal', { dependsOn: [helper.task.id], conditional: false });
    const review = task('review', 'research', { reviewScope: 'feasibility', dependsOn: [goal.task.id] });
    expect(ids(readyResearchTasks([resumed, helper, review, goal]))).toEqual(['review', helper.task.id, resumed.task.id]);
  });

  it('keeps a fresh feasibility review ahead of ordinary investigations', () => {
    const resumed = task('resumed'); resumed.attempts = 4;
    const review = task('review', 'research', { reviewScope: 'feasibility' });
    expect(ids(readyResearchTasks([resumed, task('fresh'), review, task('goal', 'goal')]))).toEqual(['goal', 'review', 'fresh', 'resumed']);
  });

  it('preserves route evidence priority over the advisory attempt count', () => {
    const supported = task('supported'); supported.attempts = 4;
    const untried = task('untried'), blocked = task('blocked', 'lemma'); Object.assign(blocked, { status: 'blocked' });
    const closing = task('closing', 'lemma', { dependsOn: ['supported'] });
    const blockedClosing = task('blocked-closing', 'lemma', { dependsOn: ['untried', 'blocked'] });
    const goal = task('goal', 'goal');
    goal.alternativeRoutes = [
      { id: 'open-route', targetTaskId: 'goal', closingTaskId: 'closing', prerequisiteTaskIds: [] },
      { id: 'blocked-route', targetTaskId: 'goal', closingTaskId: 'blocked-closing', prerequisiteTaskIds: [] },
    ];
    expect(ids(readyResearchTasks([untried, supported, blocked, closing, blockedClosing, goal]))).toEqual(['supported', 'untried']);
  });

  it('retains stable plan order for equal attempts and never offers running work', () => {
    const running = task('running'); Object.assign(running, { status: 'running' });
    const second = task('second'), first = task('first'), snapshot = structuredClone(running);
    expect(ids(readyResearchTasks([running, second, first]))).toEqual(['second', 'first']);
    expect(running).toEqual(snapshot);
  });
});
