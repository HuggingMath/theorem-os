import { describe, expect, it } from 'vitest';
import { assignSharedResearchTask, researchWorkers } from '../src/solver/modules/organization';
import { readyResearchTasks } from '../src/solver/modules/search';
import { createTaskConnectionCheck } from '../src/solver/taskConnections';
import { taskVersion, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';

const workers = researchWorkers('/disposable/connection-checkpoint', [], 4);
const owner = workers.find(worker => worker.id === 'researcher-2')!;
const record = (id: string, options: Partial<CooperativeTask> = {}): TaskRecord => ({
  task: { id, kind: 'lemma', objective: `Prove ${id}`, revision: 0, dependsOn: [],
    theoremName: id, proofPath: 'Submission.lean', type: 'True', ...options }, status: 'pending', attempts: 0,
});

function fixture() {
  const consumer = record('consumer', { conditional: true, ownerId: owner.id, dependsOn: ['bridge'] });
  const bridge = record('bridge', { ownerId: 'engineer', dependsOn: ['leaf'] });
  const leaf = record('leaf', { ownerId: owner.id });
  const goal = record('goal', { kind: 'goal', conditional: false, dependsOn: ['consumer'] });
  const tasks = [consumer, bridge, leaf, goal];
  consumer.assignment = { taskId: consumer.task.id, taskDigest: taskVersion(consumer.task), workerId: owner.id,
    assignmentId: 'fixed-connection', seedCommit: 'saved-draft', dependencies: [bridge, leaf].map(node =>
      ({ taskId: node.task.id, taskDigest: taskVersion(node.task) })) };
  consumer.assignment.connectionCheck = createTaskConnectionCheck(consumer.task, consumer.assignment, tasks,
    { environmentDigest: 'environment', problemReceiptDigest: 'problem' });
  consumer.attempts = 3;
  consumer.connectionCheckpoint = { basisDigest: consumer.assignment.connectionCheck.basisDigest,
    inputDigest: 'a'.repeat(64), outputDigest: 'b'.repeat(64) };
  const select = (worker = owner) => assignSharedResearchTask(readyResearchTasks(tasks), worker, workers, undefined, tasks);
  return { consumer, bridge, leaf, goal, tasks, select };
}

describe('unchanged conditional checkpoints yield to executable prerequisites', () => {
  it('starts an owned transitive leaf without changing the saved consumer or its assignment', () => {
    const { tasks, consumer, leaf, select } = fixture(), before = structuredClone(tasks);
    expect(select()).toBe(leaf);
    expect(tasks).toEqual(before);
    expect(consumer.assignment?.assignmentId).toBe('fixed-connection');
  });

  it('keeps the first connection and connections with new durable output ahead of the leaf', () => {
    const { consumer, select } = fixture();
    consumer.connectionCheckpoint = undefined;
    expect(select()).toBe(consumer);
    consumer.assignment = undefined; consumer.attempts = 0;
    expect(select()).toBe(consumer);
  });

  it.each(['other-owner', 'blocked', 'not-ready'] as const)(
    'continues the connection when its leaf is %s', kind => {
      const { consumer, leaf, tasks, select } = fixture();
      if (kind === 'other-owner') leaf.task.ownerId = 'engineer';
      if (kind === 'blocked') Object.assign(leaf, { status: 'blocked' });
      if (kind === 'not-ready') {
        leaf.task.dependsOn = ['missing-input'];
        tasks.push(record('missing-input', { ownerId: 'engineer' }));
        // Bind the existing connection to the updated fixed leaf type/dependencies.
        consumer.assignment!.dependencies = tasks.filter(node => ['bridge', 'leaf', 'missing-input'].includes(node.task.id))
          .map(node => ({ taskId: node.task.id, taskDigest: taskVersion(node.task) }));
        consumer.assignment!.connectionCheck = createTaskConnectionCheck(consumer.task, consumer.assignment!, tasks,
          { environmentDigest: 'environment', problemReceiptDigest: 'problem' });
        consumer.connectionCheckpoint!.basisDigest = consumer.assignment!.connectionCheck!.basisDigest;
      }
      if (kind === 'blocked') {
        // A fixed conditional contract can remain startable while its input is blocked.
        // The scheduling override must never claim that input as executable work.
        expect(select()).not.toBe(leaf);
      } else expect(select()).toBe(consumer);
    });

  it('does not promote a leaf after the connection identity has changed', () => {
    const { consumer, select } = fixture();
    consumer.connectionCheckpoint!.basisDigest = '0'.repeat(64);
    expect(select()).toBe(consumer);
  });

  it('preserves ready original goal priority and worker ownership', () => {
    const { goal, leaf, select } = fixture();
    goal.task.dependsOn = []; goal.task.ownerId = owner.id;
    expect(select()).toBe(goal);
    expect(select(workers.find(worker => worker.id === 'engineer')!)).not.toBe(leaf);
  });
});
