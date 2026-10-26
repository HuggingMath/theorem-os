import { describe, expect, it } from 'vitest';
import type { SolverProblem } from '../src/solver/problem';
import { parseCooperationPlan } from '../src/solver/tasks';
import { expandPlanPatch, formatPlanJson, isPlanPatch } from '../src/solver/planPatch';
import { parseLeadPlan } from '../src/solver/cooperationShared';
import { parseMathResponse } from '../src/solver/deliveries';

const problem = {
  ownedFiles: ['Submission.lean'],
  targets: [{ proofPath: 'Submission.lean', theoremName: 'Submission.main' }],
  declarations: { 'Submission.lean': [{ name: 'main', header: 'main : True' }] },
} as unknown as SolverProblem;
const lemma = (id: string, dependsOn: string[] = []) => ({ id, kind: 'lemma', objective: `Prove ${id}.`,
  theoremName: `Submission.${id}`, type: 'True', dependsOn });
const accepted = parseCooperationPlan(problem, { tasks: [lemma('core'), lemma('side'),
  { id: 'goal', kind: 'goal', objective: 'Prove the frozen target.', theoremName: 'Submission.main', dependsOn: ['core'] }] });
const base = { version: 'v1', tasks: accepted.tasks, groups: accepted.groups };

describe('Lead plan revisions', () => {
  it('distinguishes a revision from a complete graph and rejects a mixture', () => {
    expect(isPlanPatch({ tasks: [] })).toBe(false);
    expect(isPlanPatch({ baseVersion: 'v1', upsert: [] })).toBe(true);
    expect(isPlanPatch({ baseVersion: 'v1', remove: ['side'] })).toBe(true);
    expect(() => isPlanPatch({ tasks: [], upsert: [] })).toThrow('math_plan_patch_invalid');
  });

  it('merges supplied fields into an existing task, deletes null fields and appends new tasks', () => {
    const plan = parseLeadPlan(problem, { baseVersion: 'v1', upsert: [
      { id: 'core', status: 'paused' }, { id: 'side', ownerId: 'researcher-1' }, lemma('bridge', ['side']),
      { id: 'goal', dependsOn: ['core', 'bridge'] }] }, base);
    expect(plan.fromPatch).toBe(true);
    expect(plan.tasks.map(task => task.id)).toEqual(['core', 'side', 'goal', 'bridge']);
    expect(plan.tasks[0]).toMatchObject({ status: 'paused', type: 'True', theoremName: 'Submission.core' });
    expect(plan.tasks[1].ownerId).toBe('researcher-1');
    expect(plan.tasks[2].dependsOn).toEqual(['core', 'bridge']);
    const cleared = parseLeadPlan(problem, { baseVersion: 'v1', upsert: [{ id: 'side', ownerId: null }] },
      { ...base, tasks: plan.tasks });
    expect(cleared.tasks[1].ownerId).toBeUndefined();
  });

  it('replaces a task whose kind changes instead of keeping stale typed fields', () => {
    const plan = parseLeadPlan(problem, { baseVersion: 'v1', upsert: [
      { id: 'side', kind: 'research', objective: 'Investigate whether side is needed.' }] }, base);
    expect(plan.tasks[1]).toEqual({ id: 'side', kind: 'research', objective: 'Investigate whether side is needed.',
      dependsOn: [], revision: 0 });
  });

  it('removes tasks, keeps groups and routes unless replaced, and validates the expanded graph', () => {
    const plan = parseLeadPlan(problem, { baseVersion: 'v1', remove: ['side'] }, base);
    expect(plan.tasks.map(task => task.id)).toEqual(['core', 'goal']);
    expect(plan.groups).toEqual(accepted.groups);
    expect(() => parseLeadPlan(problem, { baseVersion: 'v1', remove: ['core'] }, base))
      .toThrow('math_plan_patch_dangling_dependency: goal still depends on removed core.');
    expect(() => parseLeadPlan(problem, { baseVersion: 'v1', remove: ['goal'] }, base))
      .toThrow('math_plan_incomplete_original_coverage');
    expect(() => parseLeadPlan(problem, { baseVersion: 'v1', upsert: [{ id: 'core', dependsOn: ['goal'] }] }, base))
      .toThrow('math_plan_dependency_cycle');
  });

  it('rejects stale, malformed, ambiguous and baseless revisions', () => {
    expect(() => expandPlanPatch({ baseVersion: 'v0', upsert: [] }, base)).toThrow('math_plan_patch_version_conflict');
    expect(() => expandPlanPatch({ upsert: [] }, base)).toThrow('math_plan_patch_invalid');
    expect(() => expandPlanPatch({ baseVersion: 'v1', upsert: [{ objective: 'no id' }] }, base)).toThrow('math_plan_patch_invalid');
    expect(() => expandPlanPatch({ baseVersion: 'v1', upsert: [{ id: 'core' }, { id: 'core' }] }, base))
      .toThrow('math_plan_patch_duplicate_task');
    expect(() => expandPlanPatch({ baseVersion: 'v1', upsert: [{ id: 'side' }], remove: ['side'] }, base))
      .toThrow('math_plan_patch_conflicting_task');
    expect(() => expandPlanPatch({ baseVersion: 'v1', remove: ['missing'] }, base)).toThrow('math_plan_patch_unknown_task');
    expect(() => expandPlanPatch({ baseVersion: 'v1', upsert: [] }, undefined)).toThrow('math_plan_patch_without_base');
    // The dispatch's own publication already applied it; repeating it in final notes is not stale.
    expect(expandPlanPatch({ baseVersion: 'v0', remove: ['missing'] }, base,
      { acceptedBaseVersions: ['v1', 'v0'], rebased: true }).tasks).toHaveLength(3);
  });

  it('formats one task per line as an ordinary readable plan fence', () => {
    const text = formatPlanJson({ tasks: accepted.tasks, groups: accepted.groups });
    expect(text.split('\n').filter(line => line.startsWith('  {"id":'))).toHaveLength(4);
    expect(parseMathResponse('```math\n' + text + '\n```', 'math-plan')).toEqual({ tasks: accepted.tasks, groups: accepted.groups });
    expect(JSON.parse(formatPlanJson({ tasks: [] }))).toEqual({ tasks: [] });
  });
});

describe('Lead plan validation feedback', () => {
  const goal = { id: 'goal', kind: 'goal', objective: 'Prove the frozen target.', theoremName: 'Submission.main', dependsOn: [] as string[] };
  const rejection = (value: unknown) => {
    try { parseCooperationPlan(problem, value); } catch (error) { return (error as Error).message; }
    throw new Error('fixture_expected_rejection');
  };
  // Details are flat JSON objects, followed by an optional repair hint.
  const detail = (message: string) => JSON.parse(/^math_plan_[a-z_]+: (\{.*?\})(?:\. |$)/u.exec(message)![1]);

  it('names the rejected task, field or dependency instead of a bare code', () => {
    expect(detail(rejection({ tasks: [goal, { ...lemma('core'), objective: ' ' }] })))
      .toEqual({ taskId: 'core', field: 'objective' });
    expect(detail(rejection({ tasks: [goal, { ...lemma('core'), status: 'done' }] })))
      .toEqual({ taskId: 'core', field: 'status' });
    expect(detail(rejection({ tasks: [{ ...goal, dependsOn: ['missing_bridge'] }] })))
      .toEqual({ taskId: 'goal', dependsOn: 'missing_bridge' });
    expect(detail(rejection({ tasks: [{ ...goal, dependsOn: ['a'] }, lemma('a', ['b']), lemma('b', ['a'])] })))
      .toEqual({ cycle: ['a', 'b', 'a'] });
    expect(detail(rejection({ tasks: [goal, lemma('core'), { ...lemma('copy'), theoremName: 'Other.core' }] })))
      .toEqual({ taskId: 'copy', theoremName: 'Other.core' });
    expect(rejection({ tasks: [{ ...goal, proofPath: 'Submission.lean', theoremName: 'Submission.renamed' }] }))
      .toMatch(/^math_plan_changed_original_target: \{"taskId":"goal".*use a lemma task for a helper statement\.$/u);
    expect(rejection({ tasks: [lemma('core')] })).toMatch(/^math_plan_incomplete_original_coverage: \{"proofPath":"Submission.lean","theoremName":"Submission.main"\}/u);
    expect(detail(rejection({ tasks: [goal], groups: [{ id: 'main', objective: 'Main.' }, { id: 'side', objective: 'Side.', maxConcurrent: 0 }] })))
      .toEqual({ index: 1, groupId: 'side', field: 'maxConcurrent' });
    expect(detail(rejection({ tasks: [goal, lemma('core'), lemma('close', ['core'])],
      proofRoutes: [{ id: 'route', targetTaskId: 'goal', closingTaskId: 'close', prerequisiteTaskIds: ['side'] }] })))
      .toEqual({ routeId: 'route', taskId: 'side' });
  });
});
