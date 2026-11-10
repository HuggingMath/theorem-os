import { describe, expect, it } from 'vitest';
import { currentDefinitionContractCheck, proposedDefinitionContractChecks } from '../src/solver/definitionContractChecks';
import { bindCheckOutcome, currentNextCheck, nextCheckContextText, visibleNextChecks } from '../src/solver/nextChecks';
import { nextCheckRecordSchema } from '../src/solver/nextCheckContract';
import { continuationResearchTasks, taskCanStart } from '../src/solver/modules/search';
import { taskVersion, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';

const identity = { problemReceiptDigest: 'problem', environmentDigest: 'environment' };
const task = (id: string, patch: Partial<CooperativeTask> = {}): TaskRecord => ({ task: {
  id, kind: 'lemma', objective: `Establish ${id}`, revision: 0, type: 'True', theoremName: id,
  proofPath: 'Main.lean', dependsOn: [], ...patch }, status: 'pending', attempts: 0 });
function fixture() {
  const tasks = [task('witness', { declaration: 'definition', type: 'ℕ', ownerId: 'author' }),
    task('left', { dependsOn: ['witness'] }), task('right', { dependsOn: ['witness'] }),
    task('goal', { kind: 'goal', dependsOn: ['left', 'right'] })];
  return { tasks, groups: [{ group: { id: 'main', objective: 'Main route', revision: 0,
    status: 'active' as const, maxConcurrent: 3 }, turns: 0 }] };
}
const checked = (node: TaskRecord) => ({ ...node, status: 'integrated' as const,
  integratedCheck: { passed: true, taskDigest: taskVersion(node.task), conditions: [] } as TaskRecord['integratedCheck'] });

describe('early shared definition checks', () => {
  it('uses the existing advisory lifecycle, visible to workers without fabricating a gap delivery', () => {
    const state = fixture(), [proposal] = proposedDefinitionContractChecks(state, identity, 10);
    expect(proposal.record).toMatchObject({ origin: 'definition-contract', createdAt: 10, status: 'pending',
      scope: { parent: { taskId: 'witness' }, target: { taskId: 'witness' }, consumer: { taskId: 'goal' } } });
    expect(proposal.record.gapDeliveryId).toBeUndefined();
    expect(nextCheckRecordSchema.parse(JSON.parse(JSON.stringify(proposal.record)))).toEqual(proposal.record);
    const view = { ...state, tasks: [...state.tasks, proposal.node], nextChecks: [proposal.record] };
    expect(currentNextCheck(proposal.record, view, identity)).toBe(true);
    expect(visibleNextChecks(view, proposal.node.task)).toEqual([proposal.record]);
    expect(nextCheckContextText(view.nextChecks, proposal.node.task.id)).toContain('definition-contract');
    expect(taskCanStart(proposal.node.task, view.tasks, view.groups)).toBe(true);
    expect(continuationResearchTasks(view.tasks, view.groups)[0].task.id).toBe(proposal.node.task.id);
    const assignment = { taskId: proposal.node.task.id, taskDigest: taskVersion(proposal.node.task),
      workerId: 'checker', seedCommit: 'seed' };
    expect(bindCheckOutcome({ checkId: proposal.record.id, conclusion: 'inconclusive',
      summary: 'The small case remains open.', evidenceRefs: [] }, proposal.node.task, assignment, view, identity))
      .toEqual(proposal.record.scope);
    expect(view.tasks.slice(0, 4).map(node => node.task.dependsOn)).toEqual([[], ['witness'], ['witness'], ['left', 'right']]);
  });

  it('retains one identity across notes, refreshes, serialized restart and unrelated work', () => {
    const state = fixture(), [first] = proposedDefinitionContractChecks(state, identity, 1);
    const view = JSON.parse(JSON.stringify({ ...state, tasks: [...state.tasks, first.node], nextChecks: [first.record] }));
    view.tasks.push(task('unrelated'));
    const [again] = proposedDefinitionContractChecks(view, identity, 2);
    expect(again.record.id).toBe(first.record.id);
    expect(currentNextCheck(first.record, view, identity)).toBe(true);
    first.record.status = 'decided';
    expect(proposedDefinitionContractChecks({ ...view, nextChecks: [first.record] }, identity, 3)[0].record.id).toBe(first.record.id);
  });

  it('expires after an exact type, dependency or environment changes and issues a new identity', () => {
    const state = fixture(); state.tasks.unshift(task('input'));
    state.tasks[1].task = { ...state.tasks[1].task, dependsOn: ['input'] };
    const [first] = proposedDefinitionContractChecks(state, identity, 0);
    const changed = structuredClone(state);
    changed.tasks[0].task = { ...changed.tasks[0].task, type: 'False' };
    expect(currentNextCheck(first.record, changed, identity)).toBe(false);
    expect(proposedDefinitionContractChecks(changed, identity, 1)[0].record.id).not.toBe(first.record.id);
    expect(currentNextCheck(first.record, state, { ...identity, environmentDigest: 'other' })).toBe(false);
    const changedType = structuredClone(state);
    changedType.tasks[1].task = { ...changedType.tasks[1].task, type: 'ℤ' };
    expect(currentNextCheck(first.record, changedType, identity)).toBe(false);
  });

  it.each(['ordinary', 'single-consumer', 'off-path', 'paused', 'parked', 'closed-group', 'already-checked', 'invalid-type'])(
    'does not add model work for %s inputs', scenario => {
      const state = fixture();
      if (scenario === 'ordinary') state.tasks[0].task = { ...state.tasks[0].task, declaration: undefined };
      if (scenario === 'single-consumer') state.tasks[2].task = { ...state.tasks[2].task, dependsOn: [] };
      if (scenario === 'off-path') state.tasks[3].task = { ...state.tasks[3].task, dependsOn: [] };
      if (scenario === 'paused') state.tasks[0].task = { ...state.tasks[0].task, status: 'paused' };
      if (scenario === 'parked') state.tasks[0].routeParking = ['obstruction'];
      if (scenario === 'closed-group') state.groups[0].group = { ...state.groups[0].group, status: 'paused' as 'active' };
      if (scenario === 'already-checked') state.tasks[0] = checked(state.tasks[0]);
      if (scenario === 'invalid-type') state.tasks[0].typePreflight = { status: 'invalid' } as TaskRecord['typePreflight'];
      expect(proposedDefinitionContractChecks(state, identity, 0)).toEqual([]);
    });

  it('type elaboration alone still needs the independent check', () => {
    const state = fixture();state.tasks[0].typePreflight = { status: 'elaborated' } as TaskRecord['typePreflight'];
    expect(proposedDefinitionContractChecks(state, identity, 0)).toHaveLength(1);
  });

  it('stops an unfinished automatic check when the definition has actually been checked', () => {
    const state = fixture(), [proposal] = proposedDefinitionContractChecks(state, identity, 0);
    state.tasks[0] = checked(state.tasks[0]);
    expect(currentDefinitionContractCheck(proposal.record, state, identity)).toBe(false);
    expect(proposedDefinitionContractChecks(state, identity, 0)).toEqual([]);
  });

  it.each(['paused-definition', 'paused-goal', 'parked-definition', 'closed-group', 'removed-path', 'checked-goal'])(
    'expires unfinished work after %s without discarding returned evidence', scenario => {
      const state = fixture(), [proposal] = proposedDefinitionContractChecks(state, identity, 0);
      if (scenario === 'paused-definition') state.tasks[0].task.status = 'paused';
      if (scenario === 'paused-goal') state.tasks[3].task.status = 'paused';
      if (scenario === 'parked-definition') state.tasks[0].routeParking = ['obstruction'];
      if (scenario === 'closed-group') state.groups[0].group.status = 'paused' as 'active';
      if (scenario === 'removed-path') for (const index of [1, 2]) state.tasks[index].task.dependsOn = [];
      if (scenario === 'checked-goal') state.tasks[3] = checked(state.tasks[3]);
      expect(proposedDefinitionContractChecks(state, identity, 1)).toEqual([]);
      expect(currentNextCheck(proposal.record, state, identity)).toBe(false);
      // Status and downstream relevance changes do not erase evidence about unchanged contracts.
      expect(currentNextCheck({ ...proposal.record, status: 'awaiting-decision' }, state, identity)).toBe(true);
      expect(currentNextCheck({ ...proposal.record, status: 'decided' }, state, identity)).toBe(true);
    });

  it('does not duplicate an eligible explicit review, but an author-owned review cannot hide the need', () => {
    const state = fixture();
    const review = task('review', { kind: 'research', reviewScope: 'feasibility', dependsOn: ['witness'] });
    state.tasks.push(review);
    expect(proposedDefinitionContractChecks(state, identity, 0)).toEqual([]);
    review.task = { ...review.task, ownerId: 'author' };
    expect(proposedDefinitionContractChecks(state, identity, 0)).toHaveLength(1);
    review.task = { ...review.task, ownerId: 'checker' };
    expect(proposedDefinitionContractChecks(state, identity, 0)).toEqual([]);
    review.task = { ...review.task, ownerId: undefined };
    review.assignment = { taskId: review.task.id, taskDigest: taskVersion(review.task), workerId: 'author', seedCommit: 'seed' };
    expect(proposedDefinitionContractChecks(state, identity, 0)).toHaveLength(1);
  });

  it('retains exact interface identity without exceeding the archive text budget', () => {
    const state = fixture();state.tasks[0].task = { ...state.tasks[0].task, type: '(n : ℕ) → '.repeat(500) + 'ℕ' };
    const [proposal] = proposedDefinitionContractChecks(state, identity, 0);
    expect(nextCheckRecordSchema.safeParse(proposal.record).success).toBe(true);
    expect(proposal.record.check.objective).toContain(taskVersion(state.tasks[0].task));
    expect(proposal.record.check.objective).toContain('COOPERATION.json');
  });

  it('rejects tampered host questions and never relaxes the ordinary gap-origin schema', () => {
    const state = fixture(); state.tasks[0].task = { ...state.tasks[0].task, sharing: 'group' };
    const [proposal] = proposedDefinitionContractChecks(state, identity, 0);
    expect(currentNextCheck({ ...proposal.record, check: { ...proposal.record.check, objective: 'Prove True instead.' } }, state, identity)).toBe(false);
    expect(nextCheckRecordSchema.safeParse({ ...proposal.record, origin: undefined }).success).toBe(false);
    expect(nextCheckRecordSchema.safeParse({ ...proposal.record, gapDeliveryId: 'invented' }).success).toBe(false);
    expect(visibleNextChecks({ ...state, nextChecks: [proposal.record] }, task('private', { groupId: 'other' }).task)).toEqual([]);
  });
});
