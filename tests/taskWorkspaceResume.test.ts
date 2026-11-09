import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { CooperativeResearch } from '../src/solver/cooperation';
import { researchTaskRole } from '../src/solver/modules/organization';
import { commitSolverSources, git } from '../src/solver/problem';
import { TaskTypePreflightCache } from '../src/solver/taskTypePreflight';
import { taskVersion, type CooperativeAction, type TaskRecord } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { localExample, peerWorker, solverState } from './helpers/solver';

type TaskAction = Extract<CooperativeAction, { kind: 'task' }>;
const budget = { maxTurns: Infinity, remainingMs: Infinity };
const directories: string[] = [];
const instances: CooperativeResearch[] = [];

function fixture() {
  const example = localExample('task-workspace-resume-');
  directories.push(example.directory);
  const lead = peerWorker(example, 'lead', { role: 'lead' });
  const worker = peerWorker(example, 'prover-1');
  const tasks: TaskRecord[] = ['a', 'b'].map(id => ({
    task: { id, kind: 'lemma', objective: `Prove helper ${id}`, dependsOn: [], revision: 0,
      ownerId: worker.id, proofPath: 'Submission.lean', theoremName: `Tutorial.task_${id}`, type: 'True',
      status: id === 'a' ? 'active' : 'paused' },
    status: 'pending', attempts: 0,
  }));
  tasks.push(...example.problem.targets.map((target, index): TaskRecord => ({
    task: { id: `goal-${index}`, kind: 'goal', objective: `Prove ${target.theoremName}`, dependsOn: ['a', 'b'],
      revision: 0, conditional: false, proofPath: target.proofPath, theoremName: target.theoremName },
    status: 'pending', attempts: 0,
  })));
  const state = solverState(example.problem, lead.worktree, { runId: 'workspace-resume', phase: 'running',
    coordination: 'cooperative', workerCount: 2,
    workers: [lead, worker].map(peer => ({ id: peer.id, role: peer.role, worktree: peer.worktree,
      phase: 'running', turns: 0 })),
    cooperation: { canonicalCommit: example.problem.baseCommit, tasks,
      groups: [{ group: { id: 'main', objective: 'Prove the original tutorial targets', status: 'active', revision: 0 }, turns: 0 }] },
  });
  const cooperative = cooperativeResearch({ state, workers: [lead, worker], retrievalRoot: '' });
  instances.push(cooperative);
  const sourceFile = path.join(worker.worktree, example.problem.projectRelative, 'Submission.lean');
  const canonicalSource = fs.readFileSync(sourceFile, 'utf8');
  return { ...example, state, cooperative, worker, tasks,
    session: state.workers![1]!, sourceFile, canonicalSource, notesFile: path.join(worker.worktree, 'RESEARCH.md') };
}

type Fixture = ReturnType<typeof fixture>;

function select(f: Fixture, id: 'a' | 'b') {
  for (const node of f.tasks.filter(node => node.task.kind === 'lemma'))
    node.task = { ...node.task, status: node.task.id === id ? 'active' : 'paused' };
}

async function start(f: Fixture, id: 'a' | 'b'): Promise<TaskAction> {
  const action = await f.cooperative.next(f.worker, budget);
  expect(action).toMatchObject({ kind: 'task', task: { id } });
  if (action?.kind !== 'task') throw new Error('fixture_expected_typed_task');
  expect(f.cooperative.started(f.worker, action)).toBe(true);
  Object.assign(f.session, { sessionRole: researchTaskRole(action.task), sessionTaskId: action.task.id,
    sessionTaskVersion: taskVersion(action.task), sessionAssignmentId: action.assignment.assignmentId });
  return action;
}

function saveDraft(f: Fixture, action: TaskAction, name: string, notes: string) {
  const source = f.canonicalSource.replace('end Tutorial', `lemma ${name} : True := by sorry\n\nend Tutorial`);
  fs.writeFileSync(f.sourceFile, source);
  fs.writeFileSync(f.notesFile, notes);
  const commit = commitSolverSources(f.problem, f.worker.worktree);
  f.cooperative.retainContextDraft(f.worker, action, commit);
  return { commit, source, notes };
}

async function deliverFailedRequest(f: Fixture, action: TaskAction) {
  const commit = commitSolverSources(f.problem, f.worker.worktree);
  await expect(f.cooperative.deliver(f.worker, action, commit, true, 'request-failure'))
    .resolves.toMatchObject({ checkWhole: false });
  expect(f.tasks.find(node => node.task.id === action.task.id)!.status).toBe('pending');
  expect(f.state.cooperation!.failedTaskInputs ?? []).toEqual([]);
}

beforeEach(() => {
  // These scheduling tests do not need Lean elaboration or a model session.
  vi.spyOn(TaskTypePreflightCache.prototype, 'check').mockImplementation(async input => ({
    result: { status: 'unavailable', taskDigest: taskVersion(input.task), inputDigest: mathDigest('fixture-no-lean'),
      reason: 'fixture-no-lean', evidence: 'advisory-type-elaboration', proofAcceptance: 'not-assessed' },
    current: () => true,
  }));
});

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.stop();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('typed task workspace resumption', () => {
  it('reassigns an unsaved typed task after another draft restores HEAD behind its seed', async () => {
    const f = fixture();
    select(f, 'b');
    const b = await start(f, 'b');
    const savedB = saveDraft(f, b, 'saved_b_support', 'Task B draft notes.\n');
    f.cooperative.interrupted(f.worker, b);

    select(f, 'a');
    const a = await start(f, 'a');
    expect(git(f.worker.worktree, ['rev-parse', `${a.assignment.seedCommit}^`])).toBe(savedB.commit);
    expect(f.state.cooperation!.researchDrafts?.a).toBeUndefined();
    f.cooperative.interrupted(f.worker, a);

    select(f, 'b');
    const restoredB = await start(f, 'b');
    expect(git(f.worker.worktree, ['rev-parse', 'HEAD'])).toBe(savedB.commit);
    expect(fs.readFileSync(f.sourceFile, 'utf8')).toBe(savedB.source);
    f.cooperative.interrupted(f.worker, restoredB);

    select(f, 'a');
    const resumed = await start(f, 'a');
    await deliverFailedRequest(f, resumed);
    expect(resumed.assignment.assignmentId).not.toBe(a.assignment.assignmentId);
    expect(fs.readFileSync(f.sourceFile, 'utf8')).toBe(f.canonicalSource);
    expect(fs.readFileSync(f.notesFile, 'utf8')).toBe('');
  });

  it('restores a saved typed draft with that task’s source and exact notes', async () => {
    const f = fixture();
    const a = await start(f, 'a');
    const savedA = saveDraft(f, a, 'saved_a_support', '\ufeffTask A draft λ\r\n');
    f.cooperative.interrupted(f.worker, a);

    select(f, 'b');
    const b = await start(f, 'b');
    saveDraft(f, b, 'saved_b_support', 'Task B draft notes.\n');
    f.cooperative.interrupted(f.worker, b);

    select(f, 'a');
    const resumed = await start(f, 'a');
    expect(resumed.assignment).toBe(a.assignment);
    expect(fs.readFileSync(f.sourceFile, 'utf8')).toBe(savedA.source);
    expect(fs.readFileSync(f.notesFile, 'utf8')).toBe(savedA.notes);
    expect(git(f.worker.worktree, ['merge-base', '--is-ancestor', resumed.assignment.seedCommit, 'HEAD'])).toBe('');
    f.cooperative.interrupted(f.worker, resumed);
  });

  it('reassigns a same-task session when HEAD is reset to the assignment seed’s parent', async () => {
    const f = fixture();
    select(f, 'b');
    const b = await start(f, 'b');
    fs.writeFileSync(f.notesFile, 'Previous task B notes.\n');
    const previous = commitSolverSources(f.problem, f.worker.worktree);
    f.cooperative.interrupted(f.worker, b);

    select(f, 'a');
    const a = await start(f, 'a');
    expect(git(f.worker.worktree, ['rev-parse', `${a.assignment.seedCommit}^`])).toBe(previous);
    f.cooperative.interrupted(f.worker, a);
    git(f.worker.worktree, ['reset', '--hard', previous]);
    expect(f.session.sessionTaskId).toBe(a.task.id);
    expect(f.session.sessionTaskVersion).toBe(taskVersion(a.task));

    const resumed = await start(f, 'a');
    await deliverFailedRequest(f, resumed);
    expect(resumed.assignment.assignmentId).not.toBe(a.assignment.assignmentId);
    expect(fs.readFileSync(f.sourceFile, 'utf8')).toBe(f.canonicalSource);
    expect(fs.readFileSync(f.notesFile, 'utf8')).toBe('');
  });

  it.each(['prover', 'engineer'] as const)('preserves uncommitted source and notes on a same-task %s continuation', async role => {
    const f = fixture();
    const a = await start(f, 'a');
    const saved = saveDraft(f, a, 'saved_a_support', 'Earlier task A checkpoint.\n');
    const latestSource = saved.source.replace('saved_a_support', 'latest_a_support');
    const latestNotes = 'Task A made more progress after its checkpoint.\n';
    fs.writeFileSync(f.sourceFile, latestSource);
    fs.writeFileSync(f.notesFile, latestNotes);
    f.cooperative.interrupted(f.worker, a);
    f.session.sessionRole = role;

    const resumed = await start(f, 'a');
    expect(resumed.assignment).toBe(a.assignment);
    expect(git(f.worker.worktree, ['rev-parse', 'HEAD'])).toBe(saved.commit);
    expect(fs.readFileSync(f.sourceFile, 'utf8')).toBe(latestSource);
    expect(fs.readFileSync(f.notesFile, 'utf8')).toBe(latestNotes);
    expect(f.state.cooperation!.researchDrafts!.a!.commit).toBe(saved.commit);
    f.cooperative.interrupted(f.worker, resumed);
  });
});
