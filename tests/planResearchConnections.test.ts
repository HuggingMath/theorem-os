import { describe, expect, it } from 'vitest';
import { continuationResearchTasks, originalGoalTaskFocus, readyResearchTasks, taskDependenciesReady } from '../src/solver/modules/search';
import { buildProofContinuation } from '../src/solver/progress';
import { taskVersion, type RouteRecord, type TaskRecord } from '../src/solver/tasks';
import { integratedProof } from './helpers/taskProof';

const node = (id: string, kind: TaskRecord['task']['kind'] = 'lemma', dependsOn: string[] = []): TaskRecord => ({
  task: { id, kind, objective: `Investigate ${id}`, dependsOn, revision: 0,
    ...(['lemma', 'goal'].includes(kind) ? { type: 'True', theoremName: id, proofPath: 'Submission.lean' } : {}),
    ...(kind === 'goal' ? { conditional: false } : {}) }, status: 'pending', attempts: 0,
});
const group = (id = 'main', status: RouteRecord['group']['status'] = 'active'): RouteRecord => ({
  group: { id, objective: id, status, revision: 0 }, turns: 0,
});
function fixture() {
  const core = node('core'), goal = node('goal', 'goal', ['core']), research = node('research', 'research');
  research.task = { ...research.task, consumerGoalIds: ['goal'] };
  return { core, goal, research, tasks: [core, goal, research] };
}

describe('explicit advisory consumer connections', () => {
  it('focuses attributed research without adding a proof edge, readiness requirement, or mathematical version', () => {
    const { core, goal, research, tasks } = fixture(), original = structuredClone(tasks);
    const continuation = buildProofContinuation(tasks);
    const digest = taskVersion(research.task), focus = originalGoalTaskFocus(tasks);
    expect([...focus.targetedResearch]).toEqual(['research']);
    expect(focus.support.has('research')).toBe(true);
    expect([...focus.proofPath]).toEqual(['goal', 'core']);
    expect([...focus.frontier]).toEqual(['core']);
    expect(focus.proofGoals.has('research')).toBe(false);
    expect(taskDependenciesReady(goal.task, tasks)).toBe(false);
    expect(readyResearchTasks(tasks)).toContain(research);
    research.task = { ...research.task, consumerGoalIds: [] };
    expect(taskVersion(research.task)).toBe(digest);
    expect(originalGoalTaskFocus(tasks).targetedResearch.has('research')).toBe(false);
    expect(buildProofContinuation(tasks)).toEqual(continuation);
    expect(goal).toEqual(original[1]); expect(core).toEqual(original[0]);
  });

  it('prioritizes attributed work over unrelated research while its original proof waits', () => {
    const { core, research, tasks } = fixture();
    const waiting = tasks.map(item => item === core ? { ...core, status: 'blocked' as const } : item);
    const independent = node('independent', 'research');
    expect(continuationResearchTasks([independent, ...waiting]).map(item => item.task.id))
      .toEqual([research.task.id, independent.task.id]);
  });

  it.each(['paused', 'stopped', 'closed-group', 'spent-group', 'parked', 'settled', 'missing', 'not-goal'] as const)(
    'does not target a %s original goal', mode => {
      const { goal, research, tasks } = fixture(); let groups = [group()];
      if (mode === 'paused' || mode === 'stopped') goal.task = { ...goal.task, status: mode };
      if (mode === 'closed-group') groups = [group('main', 'stopped')];
      if (mode === 'spent-group') groups[0] = { ...group(), group: { ...group().group, maxTurns: 1 }, turns: 1 };
      if (mode === 'parked') goal.routeParking = ['known-blocker'];
      if (mode === 'settled') integratedProof(goal);
      if (mode === 'missing') research.task = { ...research.task, consumerGoalIds: ['absent'] };
      if (mode === 'not-goal') research.task = { ...research.task, consumerGoalIds: ['core'] };
      const focus = originalGoalTaskFocus(tasks, groups);
      expect(focus.targetedResearch.has(research.task.id)).toBe(false);
    });

  it.each(['paused', 'stopped', 'closed-group', 'parked'] as const)('keeps a %s investigation out of support', mode => {
    const { research, tasks } = fixture(); let groups = [group()];
    if (mode === 'paused' || mode === 'stopped') research.task = { ...research.task, status: mode };
    if (mode === 'parked') research.routeParking = ['known-blocker'];
    if (mode === 'closed-group') {
      research.task = { ...research.task, groupId: 'other' };
      groups = [group(), group('other', 'paused')];
    }
    const focus = originalGoalTaskFocus(tasks, groups);
    expect(focus.targetedResearch.has(research.task.id)).toBe(false);
    expect(focus.support.has(research.task.id)).toBe(false);
  });

  it('honors group sharing when attributing research to an original goal', () => {
    const { goal, research, tasks } = fixture();
    research.task = { ...research.task, groupId: 'other' };
    const groups = [group(), group('other')];
    goal.task = { ...goal.task, sharing: 'group' };
    expect(originalGoalTaskFocus(tasks, groups).targetedResearch.has('research')).toBe(false);
    goal.task = { ...goal.task, sharing: 'problem' };
    expect(originalGoalTaskFocus(tasks, groups).targetedResearch.has('research')).toBe(true);
  });

  it('does not reopen research for a settled goal used by another unfinished goal', () => {
    const { goal, research, tasks } = fixture();
    integratedProof(goal);
    const other = node('other', 'goal', [goal.task.id]);
    const focus = originalGoalTaskFocus([...tasks, other]);
    expect(focus.proofPath.has(goal.task.id)).toBe(true);
    expect(focus.targetedResearch.has(research.task.id)).toBe(false);
  });

  it('retains ordinary research dependencies while attribution adds only advisory support', () => {
    const { research, tasks } = fixture(), helper = node('probe_input');
    research.task = { ...research.task, dependsOn: [helper.task.id] };
    const focus = originalGoalTaskFocus([...tasks, helper]);
    expect(focus.support.has(helper.task.id)).toBe(true);
    expect(focus.proofPath.has(helper.task.id)).toBe(false);
    expect(focus.frontier.has(helper.task.id)).toBe(false);
    expect(readyResearchTasks([...tasks, helper])).toContain(research);
  });
});
