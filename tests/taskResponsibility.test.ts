import { describe, expect, it } from 'vitest';
import { createCapacityExploration } from '../src/solver/capacityExploration';
import { assessTaskResponsibility, assignSharedResearchTask,
  type ResearchWorker, type ResponsibilityContext } from '../src/solver/modules/organization';
import { readyResearchTasks } from '../src/solver/modules/search';
import { checkedUnconditionally, taskVersion, type RouteRecord, type TaskRecord } from '../src/solver/tasks';

const worker = (id: string, role: ResearchWorker['role'] = 'researcher'): ResearchWorker => ({
  id, role, worktree: `/fixture/${id}`, ownedFiles: ['Submission.lean'],
});
const node = (id: string, kind: TaskRecord['task']['kind'] = 'lemma', dependsOn: string[] = []): TaskRecord => ({
  task: { id, kind, objective: `Resolve ${id}`, dependsOn, revision: 0,
    ...(['lemma', 'goal'].includes(kind) ? {
      proofPath: 'Submission.lean', theoremName: `Submission.${id}`, type: 'True', conditional: false,
    } : {}) },
  status: 'pending', attempts: 0,
});
const saveAssignment = (record: TaskRecord, owner: ResearchWorker) => {
  record.assignment = { taskId: record.task.id, taskDigest: taskVersion(record.task), workerId: owner.id,
    seedCommit: 'saved-seed', assignmentId: 'saved-assignment' };
};
const group = (engineerId?: string): RouteRecord => ({
  group: { id: 'main', objective: 'Original proof', status: 'active', revision: 0, engineerId }, turns: 0,
});

describe('task responsibility assessment', () => {
  it('shares an unstarted fallback goal only after the Researcher has no ready investigation', () => {
    const engineer = worker('engineer', 'engineer'), peer = worker('peer'), other = worker('other');
    const working = node('working', 'goal'), waiting = node('waiting', 'goal'), research = node('research', 'research');
    waiting.task = { ...waiting.task, preferredOwnerId: engineer.id };
    research.task = { ...research.task, ownerId: peer.id };
    working.status = 'running'; saveAssignment(working, engineer);
    const tasks = [working, waiting, research];
    const peers = [engineer, peer, other];
    expect(assignSharedResearchTask(readyResearchTasks(tasks), peer, peers, undefined, tasks)).toBe(research);
    research.status = 'blocked';
    expect(assignSharedResearchTask([waiting], peer, peers, undefined, tasks)).toBe(waiting);
    const version = taskVersion(waiting.task);
    saveAssignment(waiting, peer);
    expect(assessTaskResponsibility(waiting, peer, { tasks })).toEqual({ kind: 'matches' });
    expect(assessTaskResponsibility(waiting, other, { tasks })).toEqual({ kind: 'blocked', reason: 'saved-assignment' });
    expect(assessTaskResponsibility(waiting, engineer, { tasks })).toEqual({ kind: 'blocked', reason: 'saved-assignment' });
    expect(taskVersion({ ...waiting.task, preferredOwnerId: undefined })).toBe(version);
  });

  it.each(['owner-idle', 'attempted', 'group-engineer', 'exclusive-owner', 'stale-owner-assignment'] as const)(
    'keeps the preference boundary for %s', boundary => {
      const engineer = worker('engineer', 'engineer'), peer = worker('peer');
      const working = node('working', 'goal'), waiting = node('waiting', 'goal');
      waiting.task = { ...waiting.task, preferredOwnerId: engineer.id };
      working.status = 'running'; saveAssignment(working, engineer);
      if (boundary === 'owner-idle') working.status = 'pending';
      if (boundary === 'attempted') waiting.attempts = 1;
      if (boundary === 'exclusive-owner') waiting.task = { ...waiting.task, preferredOwnerId: undefined, ownerId: engineer.id };
      if (boundary === 'stale-owner-assignment') working.assignment!.taskDigest = 'stale';
      const groups = boundary === 'group-engineer' ? [group(engineer.id)] : undefined;
      expect(assignSharedResearchTask([waiting], peer, [engineer, peer], groups, [working, waiting])).toBeUndefined();
    });

  it('keeps a saved assignment exclusive after its task owner is removed', () => {
    const author = worker('author'), peer = worker('peer'), saved = node('saved'), alternative = node('alternative');
    saved.task = { ...saved.task, ownerId: author.id }; saveAssignment(saved, author);
    const assignment = saved.assignment, version = taskVersion(saved.task);
    const context: ResponsibilityContext = { tasks: [saved, alternative] };
    expect(assessTaskResponsibility(saved, peer, context)).toEqual({ kind: 'blocked', reason: 'owner' });

    saved.task = { ...saved.task, ownerId: undefined };
    expect(taskVersion(saved.task)).toBe(version);
    expect(assessTaskResponsibility(saved, peer, context)).toEqual({ kind: 'blocked', reason: 'saved-assignment' });
    expect(assessTaskResponsibility(saved, author, context)).toEqual({ kind: 'matches' });
    expect(assignSharedResearchTask(context.tasks, peer, [author, peer], undefined, context.tasks)).toBe(alternative);
    expect(saved.assignment).toBe(assignment);
    expect(saved.status).toBe('pending');
  });

  it('reports the first responsibility conflict without relaxing Engineer or saved ownership', () => {
    const engineer = worker('engineer', 'engineer'), author = worker('author'), peer = worker('peer');
    const goal = node('original', 'goal'); goal.task = { ...goal.task, ownerId: author.id }; saveAssignment(goal, author);
    const context = { tasks: [goal], groups: [group(engineer.id)] };
    expect(assessTaskResponsibility(goal, { id: 'prover', role: 'prover' }, context))
      .toEqual({ kind: 'blocked', reason: 'role' });
    expect(assessTaskResponsibility(goal, peer, context)).toEqual({ kind: 'blocked', reason: 'engineer' });
    expect(assessTaskResponsibility(goal, author, context)).toEqual({ kind: 'blocked', reason: 'engineer' });
    expect(assessTaskResponsibility(goal, engineer, context)).toEqual({ kind: 'blocked', reason: 'owner' });
    goal.task = { ...goal.task, ownerId: undefined };
    expect(assessTaskResponsibility(goal, engineer, context)).toEqual({ kind: 'blocked', reason: 'saved-assignment' });
    expect(assignSharedResearchTask([goal], engineer, [author, engineer], context.groups, context.tasks)).toBeUndefined();
  });

  it('uses the full input graph for independent review while allowing unrelated authors', () => {
    const writer = worker('writer'), owner = worker('owner'), engineer = worker('engineer', 'engineer');
    const checker = worker('checker'), written = node('written'), owned = node('owned'), original = node('original', 'goal');
    saveAssignment(written, writer); owned.task = { ...owned.task, ownerId: owner.id };
    const unrelated = node('unrelated'); saveAssignment(unrelated, checker);
    const review = node('review', 'research', [written.task.id, owned.task.id, original.task.id]);
    review.task = { ...review.task, reviewScope: 'feasibility' };
    const context = { tasks: [written, owned, original, unrelated, review], groups: [group(engineer.id)] };
    const peers = [writer, owner, engineer, checker];
    for (const author of [writer, owner, engineer]) {
      expect(assessTaskResponsibility(review, author, context)).toEqual({ kind: 'blocked', reason: 'review-independence' });
      expect(assignSharedResearchTask([review], author, peers, context.groups, context.tasks)).toBeUndefined();
    }
    expect(assessTaskResponsibility(review, checker, context)).toEqual({ kind: 'matches' });
    expect(assignSharedResearchTask([review], checker, peers, context.groups, context.tasks)).toBe(review);
  });

  it('detects public in-flight duplicates outside the candidate list and respects private group scope', () => {
    const researcher = worker('researcher'), running = node('running', 'research');
    running.task = { ...running.task, objective: 'Find a concrete witness', groupId: 'left', sharing: 'problem' };
    running.status = 'running';
    const duplicate = node('duplicate', 'research'), alternative = node('alternative', 'research');
    duplicate.task = { ...duplicate.task, objective: running.task.objective, groupId: 'right', sharing: 'problem' };
    const context = { tasks: [running, duplicate, alternative] }, before = structuredClone(context);
    expect(assessTaskResponsibility(duplicate, researcher, context)).toEqual({ kind: 'blocked', reason: 'running-duplicate' });
    expect(assignSharedResearchTask([duplicate, alternative], researcher, [researcher], undefined, context.tasks)).toBe(alternative);
    expect(context).toEqual(before);

    running.task = { ...running.task, sharing: 'group' };
    expect(assessTaskResponsibility(duplicate, researcher, context)).toEqual({ kind: 'matches' });
    expect(assignSharedResearchTask([duplicate, alternative], researcher, [researcher], undefined, context.tasks)).toBe(duplicate);
  });

  it('retains the host exploration exception for its bound Prover without outranking planned proof work', () => {
    const prover = worker('prover', 'prover'), target = node('target');
    const exploration = createCapacityExploration(target, prover, [target],
      { environmentDigest: 'environment', problemReceiptDigest: 'problem' }, 'construction');
    const context = { tasks: [target, exploration] };
    expect(assessTaskResponsibility(exploration, prover, context)).toEqual({ kind: 'matches' });
    expect(assignSharedResearchTask([exploration, target], prover, [prover], undefined, context.tasks)).toBe(target);
    expect(assessTaskResponsibility({ ...exploration, capacityExploration: undefined }, prover, context))
      .toEqual({ kind: 'blocked', reason: 'role' });
    expect(assessTaskResponsibility(exploration, { id: 'other-prover', role: 'prover' }, context))
      .toEqual({ kind: 'blocked', reason: 'role' });
  });

  it('matches responsibility without making an unready helper assignable or accepted', () => {
    const prover = worker('prover', 'prover'), premise = node('premise'), helper = node('helper', 'lemma', [premise.task.id]);
    const context = { tasks: [premise, helper] }, before = structuredClone(context);
    expect(assessTaskResponsibility(helper, { id: prover.id, role: prover.role }, context)).toEqual({ kind: 'matches' });
    const ready = readyResearchTasks(context.tasks);
    expect(ready).not.toContain(helper);
    expect(assignSharedResearchTask(ready, prover, [prover], undefined, context.tasks)).toBe(premise);
    expect(helper.assignment).toBeUndefined();
    expect(checkedUnconditionally(helper)).toBe(false);
    expect(context).toEqual(before);
  });
});
