import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MathematicsVerifierBatchRequest, MathematicsVerifierBatchResult } from '../src/math/verifier';
import { maskLeanCommentsAndStrings } from '../src/math/leanSyntax';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import { parseCooperationPlan } from '../src/solver/tasks';
import { buildResearchContext } from '../src/solver/modules/context';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { readyResearchTasks, taskCanStart } from '../src/solver/modules/search';
import { committedSource, commitSolverSources, git, readSolverProblem, type SolverProblem } from '../src/solver/problem';
import { automaticTaskConnection, createTaskConnectionCheck, freshTaskConnection, hasTaskConnectionCheck,
  taskConnectionCheckCurrent } from '../src/solver/taskConnections';
import { assignmentDeliveryFile, freshlyAccepted, taskVersion, type CooperativeAction, type CooperativeTask, type TaskAssignment, type TaskRecord } from '../src/solver/tasks';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';
import { verifiedBatch } from './helpers/verifier';
import { conditionalPayloads } from './helpers/conditionalProjection';

const host = vi.hoisted(() => ({ verify: vi.fn(), createSession: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(), checkManyFormalVerifications: host.verify,
  resolveMathematicsLakePackagesCache: () => undefined,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));
const identity = { environmentDigest: 'environment', problemReceiptDigest: 'problem' };
const records = (): TaskRecord[] => [{ task: { id: 'input', kind: 'lemma', objective: 'Core input', type: 'True',
  theoremName: 'N.input', proofPath: 'Submission.lean', revision: 0, dependsOn: [] }, status: 'pending', attempts: 0 },
{ task: { id: 'consumer', kind: 'goal', objective: 'Apply the input', theoremName: 'N.target',
  proofPath: 'Submission.lean', revision: 0, dependsOn: ['input'] }, status: 'pending', attempts: 8 }];
const assignmentFor = (tasks: TaskRecord[]): TaskAssignment => ({ taskId: tasks[1].task.id,
  taskDigest: taskVersion(tasks[1].task), workerId: 'engineer', seedCommit: 'fixed-seed',
  dependencies: [{ taskId: tasks[0].task.id, taskDigest: taskVersion(tasks[0].task) }] });

describe('consumer connection dispatch', () => {
  it('offers an ordinary consumer before its typed input without changing the task contract', () => {
    const tasks = records(), digest = taskVersion(tasks[1].task);
    expect(taskCanStart(tasks[1].task, tasks)).toBe(true);
    expect(readyResearchTasks(tasks)[0].task.id).toBe('consumer');
    expect(freshTaskConnection(tasks[1], tasks)).toBe(true);
    const assignment = assignmentFor(tasks);
    assignment.connectionCheck = createTaskConnectionCheck(tasks[1].task, assignment, tasks, identity);
    expect(hasTaskConnectionCheck(tasks[1].task, assignment)).toBe(true);
    tasks[1].assignment = assignment;
    expect(freshTaskConnection(tasks[1], tasks)).toBe(false);
    expect(taskVersion(tasks[1].task)).toBe(digest); expect(tasks[1].task.conditional).toBeUndefined();
  });

  it('binds the dispatch to exact inputs, environment, seed and route topology', () => {
    const tasks = records(), assignment = assignmentFor(tasks);
    assignment.connectionCheck = createTaskConnectionCheck(tasks[1].task, assignment, tasks, identity);
    expect(taskConnectionCheckCurrent(tasks[1].task, assignment, tasks, identity)).toBe(true);
    tasks[0].status = 'integrated';
    expect(taskConnectionCheckCurrent(tasks[1].task, assignment, tasks, identity)).toBe(true);
    expect(taskConnectionCheckCurrent(tasks[1].task, assignment, tasks, { ...identity, environmentDigest: 'other' })).toBe(false);
    expect(hasTaskConnectionCheck(tasks[1].task, { ...assignment, seedCommit: 'other' })).toBe(false);
    tasks[0].task = { ...tasks[0].task, type: 'False' };
    expect(taskConnectionCheckCurrent(tasks[1].task, assignment, tasks, identity)).toBe(false);
    const fresh = records(), next = assignmentFor(fresh);
    next.connectionCheck = createTaskConnectionCheck(fresh[1].task, next, fresh, identity);
    fresh[1].alternativeRoutes = [{ id: 'route', targetTaskId: 'consumer', closingTaskId: 'input', prerequisiteTaskIds: [] }];
    expect(taskConnectionCheckCurrent(fresh[1].task, next, fresh, identity)).toBe(false);
  });

  it('freezes only unfinished inputs and binds their assumption permission to the exact worker dispatch', () => {
    const tasks = records(), assignment: TaskAssignment = { ...assignmentFor(tasks), assignmentId: 'dispatch-1' };
    tasks.push({ ...tasks[0], task: { ...tasks[0].task, id: 'ready', theoremName: 'N.ready' }, status: 'integrated' });
    assignment.dependencies.push({ taskId: 'ready', taskDigest: taskVersion(tasks[2].task) });
    assignment.connectionCheck = createTaskConnectionCheck(tasks[1].task, assignment, tasks, identity);
    expect(assignment.connectionCheck.assumedInputs).toEqual([{ taskId: 'input', taskDigest: taskVersion(tasks[0].task) }]);
    tasks[0].status = 'integrated';
    expect(taskConnectionCheckCurrent(tasks[1].task, assignment, tasks, identity)).toBe(true);
    expect(hasTaskConnectionCheck(tasks[1].task, { ...assignment, workerId: 'another-worker' })).toBe(false);
    expect(hasTaskConnectionCheck(tasks[1].task, { ...assignment, assignmentId: 'dispatch-2' })).toBe(false);
    expect(hasTaskConnectionCheck({ ...tasks[1].task, objective: 'Changed contract' }, assignment)).toBe(false);
  });

  it.each([
    ['absent', 'namespace N\nend N\n'],
    ['in another namespace', 'namespace Other\nlemma N.input : True := by trivial\nend Other\n'],
  ])('includes integrated inputs %s from an upgraded historical assignment seed', (_description, source) => {
    const tasks = records(), assignment = assignmentFor(tasks);
    tasks[0].status = 'integrated';
    tasks.push({ ...tasks[0], task: { ...tasks[0].task, id: 'unfinished', theoremName: 'N.unfinished' }, status: 'pending' });
    assignment.dependencies.push({ taskId: 'unfinished', taskDigest: taskVersion(tasks[2].task) });
    assignment.connectionCheck = createTaskConnectionCheck(tasks[1].task, assignment, tasks, identity,
      () => source);
    expect(assignment.connectionCheck.assumedInputs).toEqual(assignment.dependencies);
  });

  it('respects explicit opt out, untyped blockers, private inputs and paused groups', () => {
    const tasks = records(); tasks[1].task = { ...tasks[1].task, conditional: false };
    expect(taskCanStart(tasks[1].task, tasks)).toBe(false);
    tasks[1].task = { ...tasks[1].task, conditional: undefined };
    tasks[0].task = { ...tasks[0].task, groupId: 'private', sharing: 'group' };
    expect(automaticTaskConnection(tasks[1].task, tasks)).toBe(false);
    tasks[0].task = { ...tasks[0].task, groupId: undefined, kind: 'research', type: undefined };
    expect(automaticTaskConnection(tasks[1].task, tasks)).toBe(false);
    expect(readyResearchTasks(records(), [{ group: { id: 'main', objective: 'Paused', status: 'paused', revision: 0 }, turns: 0 }])).toEqual([]);
  });

  it('does not revive blocked or parked inputs through a fresh consumer', () => {
    const tasks = records(); tasks[0].status = 'blocked';
    expect(taskCanStart(tasks[1].task, tasks)).toBe(false);
    tasks[0].status = 'pending'; tasks[0].routeParking = ['missing-core-input'];
    expect(taskCanStart(tasks[1].task, tasks)).toBe(false);
    tasks[0].routeParking = [];
    expect(taskCanStart(tasks[1].task, tasks)).toBe(true);
  });

  it.each(['paused', 'stopped', 'spent'] as const)('does not offer an early check using an unfinished input from a %s group', control => {
    const tasks = records(); tasks[0].task = { ...tasks[0].task, groupId: 'input-group', sharing: 'problem' };
    const groups = [{ group: { id: 'main', objective: 'Consumer', status: 'active' as const, revision: 0 }, turns: 0 },
      { group: { id: 'input-group', objective: 'Input', status: control === 'spent' ? 'active' as const : control,
        revision: 0, maxTurns: control === 'spent' ? 1 : undefined }, turns: 1 }];
    expect(taskCanStart(tasks[1].task, tasks, groups)).toBe(false);
    expect(readyResearchTasks(tasks, groups)).toEqual([]);
    tasks[0].status = 'integrated';
    expect(taskCanStart(tasks[1].task, tasks, groups)).toBe(true);
  });

  it.each(['integrated', 'paused', 'stopped', 'parked', 'route-parked', 'group-paused', 'group-stopped', 'group-spent'] as const)(
    'does not offer a helper connection solely for a %s consumer', control => {
      const tasks = records(); tasks[1].task = { ...tasks[1].task, kind: 'lemma', type: 'True' };
      tasks.push({ task: { id: 'target', kind: 'goal', objective: 'Original consumer', theoremName: 'N.target',
        proofPath: 'Submission.lean', revision: 0, dependsOn: ['consumer'], groupId: 'target-group' }, status: 'pending', attempts: 0 });
      const consumer = tasks[2];
      if (control === 'integrated') consumer.status = 'integrated';
      if (control === 'paused' || control === 'stopped') consumer.task = { ...consumer.task, status: control };
      if (control === 'parked') consumer.routeParking = ['closed-route'];
      if (control === 'route-parked') {
        consumer.task = { ...consumer.task, dependsOn: [] };
        consumer.alternativeRoutes = [{ id: 'closed-route', targetTaskId: 'target', closingTaskId: 'consumer', prerequisiteTaskIds: [] }];
        consumer.parkedRoutes = { 'closed-route': ['missing-input'] };
      }
      const groups = [{ group: { id: 'main', objective: 'Helper', status: 'active' as const, revision: 0 }, turns: 0 },
        { group: { id: 'target-group', objective: 'Consumer', revision: 0,
          status: control === 'group-paused' ? 'paused' as const : control === 'group-stopped' ? 'stopped' as const : 'active' as const,
          maxTurns: control === 'group-spent' ? 1 : undefined }, turns: 1 }];
      expect(automaticTaskConnection(tasks[1].task, tasks, groups)).toBe(false);
      expect(taskCanStart(tasks[1].task, tasks, groups)).toBe(false);
      expect(readyResearchTasks(tasks, groups).map(node => node.task.id)).not.toContain('consumer');
    });

  it('checks an OR closing lemma early while the original target still waits for a checked route', () => {
    const tasks = records();
    tasks.splice(1, 0, { task: { id: 'closing', kind: 'lemma', objective: 'Close this route', type: 'True',
      theoremName: 'N.closing', proofPath: 'Submission.lean', revision: 0, dependsOn: ['input'] }, status: 'pending', attempts: 12 });
    tasks[2].task = { ...tasks[2].task, dependsOn: [] };
    tasks[2].alternativeRoutes = [{ id: 'route', targetTaskId: 'consumer', closingTaskId: 'closing', prerequisiteTaskIds: ['input'] }];
    expect(readyResearchTasks(tasks)[0].task.id).toBe('closing');
    expect(taskCanStart(tasks[2].task, tasks)).toBe(false);
    const assignment: TaskAssignment = { taskId: 'closing', taskDigest: taskVersion(tasks[1].task),
      workerId: 'engineer', seedCommit: 'seed', dependencies: [{ taskId: 'input', taskDigest: taskVersion(tasks[0].task) }] };
    assignment.connectionCheck = createTaskConnectionCheck(tasks[1].task, assignment, tasks, identity);
    tasks[2].alternativeRoutes = [{ ...tasks[2].alternativeRoutes[0], id: 'changed-route' }];
    expect(taskConnectionCheckCurrent(tasks[1].task, assignment, tasks, identity)).toBe(false);
  });
});
