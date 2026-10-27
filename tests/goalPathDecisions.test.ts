import { describe, expect, it } from 'vitest';
import type { SolverProblem } from '../src/solver/problem';
import { parseCooperationPlan, type RouteRecord, type TaskRecord } from '../src/solver/tasks';
import { parseLeadPlan } from '../src/solver/cooperationShared';
import { applyGoalPathDecisions, MAX_GOAL_PATH_DECLINE_CHARS } from '../src/solver/goalPathDecisions';
import { reviewGoalPaths } from '../src/solver/goalPathReview';
import { integratedProof } from './helpers/taskProof';

const problem = {
  ownedFiles: ['Submission.lean'],
  targets: [{ proofPath: 'Submission.lean', theoremName: 'Submission.main' }],
  declarations: { 'Submission.lean': [{ name: 'main', header: 'main : True' }] },
} as unknown as SolverProblem;
const lemma = (id: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}) => ({ id, kind: 'lemma',
  objective: `Prove ${id}.`, theoremName: `Submission.${id}`, proofPath: 'Submission.lean', type: 'True', dependsOn, ...extra });
const goal = { id: 'goal', kind: 'goal', objective: 'Prove the frozen target.', theoremName: 'Submission.main',
  proofPath: 'Submission.lean', dependsOn: ['bridge'] };

/** An accepted graph goal <- bridge <- core, its records, and the review a Lead dispatch would be shown. */
function fixture(core: Record<string, unknown> = { status: 'paused' }, options: { extra?: Record<string, unknown>[];
  groups?: Record<string, unknown>[]; turns?: Record<string, number>; status?: Record<string, TaskRecord['status']>; checked?: string[] } = {}) {
  const plan = parseCooperationPlan(problem, { tasks: [lemma('core', [], core), lemma('bridge', ['core']), goal, ...options.extra ?? []],
    ...(options.groups ? { groups: options.groups } : {}) });
  const records: TaskRecord[] = plan.tasks.map(task => ({ task, status: options.status?.[task.id] ?? 'pending', attempts: 0 }));
  for (const id of options.checked ?? []) integratedProof(records.find(item => item.task.id === id)!, { environmentDigest: 'environment' });
  const groups: RouteRecord[] = plan.groups.map(group => ({ group, turns: options.turns?.[group.id] ?? 0 }));
  const base = { version: 'v1', tasks: plan.tasks, groups: plan.groups };
  const review = reviewGoalPaths(records, { groups, environmentDigest: 'environment' });
  const parse = (goalPath: unknown, revision: Record<string, unknown> = {}) =>
    parseLeadPlan(problem, { baseVersion: 'v1', ...revision, goalPath }, base, { goalPath: review });
  return { base, review, parse, task: (plan: { tasks: { id: string }[] }, id: string) => plan.tasks.find(task => task.id === id) as Record<string, unknown> };
}

describe('goal-path answers in a Lead revision', () => {
  it('leaves a plan without goalPath alone and rejects goalPath on a complete tasks list', () => {
    const { review, base } = fixture();
    const value = { baseVersion: 'v1', upsert: [] };
    expect(applyGoalPathDecisions(value, review, base)).toEqual({ value });
    expect(() => applyGoalPathDecisions({ tasks: [], goalPath: { adopt: [] } }, review, base))
      .toThrow('math_plan_goal_path_requires_revision');
  });

  it('drops an answer with no stalled goal or no review, keeping a decisions-only revision a valid patch', () => {
    const runnable = fixture({});
    expect(runnable.review.stalledGoalIds).toEqual([]);
    expect(applyGoalPathDecisions({ baseVersion: 'v1', goalPath: { adopt: ['resume:core'] } }, runnable.review, runnable.base))
      .toEqual({ value: { baseVersion: 'v1', upsert: [] } });
    const replay = parseLeadPlan(problem, { baseVersion: 'v1', goalPath: { adopt: ['resume:core'] } }, runnable.base);
    expect(replay).toMatchObject({ fromPatch: true }); expect(replay).not.toHaveProperty('goalPathDecisions');
  });

  it('applies a mechanical resume from its id alone', () => {
    const { parse, task } = fixture();
    const plan = parse({ adopt: ['resume:core'] });
    expect(task(plan, 'core').status).toBe('active');
    expect(plan.goalPathDecisions).toEqual({ adopted: [{ id: 'resume:core', action: 'resume', taskId: 'core' }], declined: [] });
    // The revision may restate the same change, but not contradict it.
    expect(task(parse({ adopt: ['resume:core'] }, { upsert: [{ id: 'core', status: 'active' }] }), 'core').status).toBe('active');
    expect(() => parse({ adopt: ['resume:core'] }, { upsert: [{ id: 'core', status: 'stopped' }] }))
      .toThrow('math_plan_goal_path_conflict');
    expect(() => parse({ adopt: ['resume:core'] }, { remove: ['core'] })).toThrow('math_plan_goal_path_conflict');
  });

  it('connects an equal checked off-path lemma and marks consumers conditional for an assumed input', () => {
    const { parse, task, review } = fixture({ status: 'paused' }, { extra: [lemma('glue')], status: { glue: 'integrated' }, checked: ['glue'] });
    const ids = review.goals[0]!.candidates.map(candidate => [candidate.id, candidate.mechanical]);
    expect(ids).toEqual(expect.arrayContaining([['connect:core:glue', true], ['assume:core', true], ['decompose:core', false]]));
    const connected = parse({ adopt: ['connect:core:glue'] });
    expect(task(connected, 'core').dependsOn).toEqual(['glue']);
    const assumed = parse({ adopt: ['assume:core'] });
    expect(task(assumed, 'bridge').conditional).toBe(true);
    expect(() => parse({ adopt: ['assume:core'] }, { upsert: [{ id: 'bridge', conditional: false }] }))
      .toThrow('math_plan_goal_path_conflict');
  });

  it('reopens a paused input group mechanically but needs the new budget written for a spent turn cap', () => {
    const groups = [{ id: 'main', objective: 'Prove the original problem' }, { id: 'side', objective: 'Core estimate', status: 'paused' }];
    const paused = fixture({ groupId: 'side', sharing: 'problem' }, { groups });
    expect(paused.review.goals[0]!.candidates[0]).toMatchObject({ id: 'reopen-route:core', mechanical: true });
    const reopened = paused.parse({ adopt: ['reopen-route:core'] });
    expect(reopened.groups.find(group => group.id === 'side')!.status).toBe('active');
    expect(() => paused.parse({ adopt: ['reopen-route:core'] }, { groups: groups.map(group => ({ ...group })) }))
      .toThrow('math_plan_goal_path_conflict');
    const spent = fixture({ groupId: 'side', sharing: 'problem' }, { groups: [groups[0], { ...groups[1], status: 'active', maxTurns: 1 }], turns: { side: 1 } });
    expect(spent.review.goals[0]!.candidates[0]).toMatchObject({ id: 'reopen-route:core', mechanical: false });
    expect(() => spent.parse({ adopt: ['reopen-route:core'] })).toThrow('math_plan_goal_path_unapplied');
    const raised = spent.parse({ adopt: ['reopen-route:core'] }, { groups: [groups[0], { ...groups[1], status: 'active', maxTurns: 4 }] });
    expect(raised.groups.find(group => group.id === 'side')!.maxTurns).toBe(4);
  });

  it('requires a non-mechanical candidate to be visible on the input or a consumer in the same revision', () => {
    const { parse } = fixture({}, { status: { core: 'blocked' } });
    expect(() => parse({ adopt: ['revise:core'] })).toThrow('math_plan_goal_path_unapplied');
    expect(parse({ adopt: ['revise:core'] }, { upsert: [{ id: 'core', type: '1 = 1' }] }).goalPathDecisions!.adopted)
      .toEqual([{ id: 'revise:core', action: 'revise', taskId: 'core' }]);
    expect(parse({ adopt: ['decompose:core'] }, { upsert: [{ id: 'bridge', dependsOn: ['core', 'piece'] }, lemma('piece')] })
      .goalPathDecisions!.adopted[0]).toMatchObject({ id: 'decompose:core' });
  });

  it('names the listed candidates for an unknown id of a stalled input and ignores ids of inputs no longer stalled', () => {
    const { parse } = fixture();
    let error: unknown;
    try { parse({ adopt: ['revise:core'] }); } catch (caught) { error = caught; }
    expect(String(error)).toContain('math_plan_goal_path_unknown_candidate');
    expect(String(error)).toContain('resume:core');
    expect(parse({ adopt: ['resume:elsewhere'] }).goalPathDecisions).toEqual({ adopted: [], declined: [] });
    expect(() => parse({ adopt: ['nonsense'] })).toThrow('math_plan_goal_path_unknown_candidate');
  });

  it('records a declined input with its trimmed mathematical reason and validates the answer shape', () => {
    const { parse } = fixture();
    const reason = '  The bridge needs the compact seed first.  ';
    expect(parse({ decline: [{ taskId: 'core', reason }, { taskId: 'elsewhere', reason: 'moot' }] }).goalPathDecisions)
      .toEqual({ adopted: [], declined: [{ taskId: 'core', reason: reason.trim() }] });
    for (const goalPath of [[], { adopt: 'resume:core' }, { adopt: ['resume:core', 'resume:core'] }, { adopt: [1] },
      { decline: [{ taskId: 'core', reason: ' ' }] }, { decline: [{ taskId: 'core', reason: 'x'.repeat(MAX_GOAL_PATH_DECLINE_CHARS + 1) }] },
      { decline: [{ taskId: 'core' }] }, { decline: [{ taskId: 'core', reason: 'a' }, { taskId: 'core', reason: 'b' }] }])
      expect(() => parse(goalPath), JSON.stringify(goalPath)).toThrow('math_plan_goal_path_invalid');
    expect(() => parse({ adopt: ['resume:core'], decline: [{ taskId: 'core', reason: 'Both.' }] }))
      .toThrow('math_plan_goal_path_conflict');
  });

  it('leaves a malformed revision to the ordinary patch validator', () => {
    const { parse } = fixture();
    expect(() => parse({ adopt: ['resume:core'] }, { upsert: [{ status: 'active' }] })).toThrow('math_plan_patch_invalid');
    expect(() => parse({ adopt: ['resume:core'] }, { baseVersion: 'v0' })).toThrow('math_plan_patch_version_conflict');
  });
});
