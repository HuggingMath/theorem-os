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

  it('lifts a revision nested under tasks and rejects a conflicting or non-revision tasks object', () => {
    const nested = parseLeadPlan(problem, { baseVersion: 'v1', summary: 'Pause side.',
      tasks: { baseVersion: 'v1', upsert: [{ id: 'side', status: 'paused' }] } }, base);
    expect(nested.fromPatch).toBe(true);
    expect(nested.tasks[1]).toMatchObject({ id: 'side', status: 'paused' });
    expect(() => parseLeadPlan(problem, { baseVersion: 'v1', tasks: { baseVersion: 'v0', remove: ['side'] } }, base))
      .toThrow(/^math_plan_patch_invalid: baseVersion appears both at the top level and inside tasks/u);
    expect(() => parseLeadPlan(problem, { tasks: { goal: lemma('goal') } }))
      .toThrow(/^math_plan_invalid: \{"field":"tasks"\}\. tasks must be the complete array/u);
    expect(() => parseLeadPlan(problem, { tasks: [] })).toThrow(/^math_plan_invalid$/u);
  });

  it('keeps research, progress and next-check decisions identical when lifting a nested revision', () => {
    const decisions = {
      researchDecisions: [{ deliveryId: 'finding', outcome: 'decline', reason: 'The finding does not close this gap.' }],
      progressReview: { id: 'review', reason: 'Check the exact construction before changing the route.',
        nextChecks: [{ action: 'construction-check', targetTaskId: 'goal', objective: 'Check the original construction.',
          expectedEvidence: 'A checked construction or its exact missing premise.' }] },
      nextCheckDecisions: [{ checkId: 'a'.repeat(64), outcomeDeliveryId: 'outcome', action: 'continue',
        reason: 'The scoped check leaves a concrete construction to investigate.' }],
    };
    const flat = { baseVersion: 'v1', upsert: [], ...decisions };
    const nested = { baseVersion: 'v1', tasks: { baseVersion: 'v1', upsert: [], ...decisions } };
    const before = structuredClone(nested);
    expect(parseLeadPlan(problem, nested, base)).toEqual(parseLeadPlan(problem, flat, base));
    expect(nested).toEqual(before);
  });

  it('rejects invalid or conflicting decisions inside a nested revision', () => {
    const invalid = { id: 'review', reason: 'Missing the required discriminating checks.' };
    expect(() => parseLeadPlan(problem, { baseVersion: 'v1', tasks: {
      baseVersion: 'v1', upsert: [], progressReview: invalid } }, base))
      .toThrow('math_plan_progress_review_invalid');
    expect(() => parseLeadPlan(problem, { baseVersion: 'v1', progressReview: invalid, tasks: {
      baseVersion: 'v1', upsert: [], progressReview: { ...invalid, reason: 'A conflicting response.' } } }, base))
      .toThrow('math_plan_patch_invalid: progressReview appears both');
    expect(() => parseLeadPlan(problem, { baseVersion: 'v1', researchDecisions: [], tasks: {
      baseVersion: 'v1', upsert: [], researchDecisions: [{ deliveryId: 'finding', outcome: 'decline', reason: 'Conflicting.' }] } }, base))
      .toThrow('math_plan_patch_invalid: researchDecisions appears both');
  });

  it('explains the required graph syntax when a decision-only revision omits upsert and remove', () => {
    let failure: unknown;
    try { parseLeadPlan(problem, { baseVersion: 'v1', researchDecisions: [] }, base); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/^math_plan_invalid/u);
    expect(message).toContain('tasks');
    expect(message).toContain('upsert');
    expect(message).toContain('remove');
    expect(message).toContain('"upsert":[]');
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

  it('rejects a declaration in a new helper type before accepting either plan form', () => {
    const invalid = { ...lemma('bridge'), type: 'theorem Submission.bridge : True' };
    expect(() => parseLeadPlan(problem, { tasks: [...base.tasks, invalid] }, base))
      .toThrow('math_plan_invalid_helper_type');
    expect(() => parseLeadPlan(problem, { baseVersion: 'v1', upsert: [invalid] }, base))
      .toThrow('math_plan_invalid_helper_type');
    expect(base.tasks.some(task => task.id === 'bridge')).toBe(false);
  });

  it('keeps a legacy graph readable while requiring repaired helper types to be terms', () => {
    const legacy = { ...base, tasks: base.tasks.map(task => task.id === 'core'
      ? { ...task, type: 'theorem Submission.core : True' } : task) };
    expect(parseCooperationPlan(problem, legacy).tasks[0].type).toBe('theorem Submission.core : True');
    expect(parseLeadPlan(problem, { baseVersion: 'v1', upsert: [{ id: 'side', status: 'paused' }] }, legacy).tasks[0])
      .toEqual(legacy.tasks[0]);
    expect(() => parseLeadPlan(problem, { baseVersion: 'v1', upsert: [{ id: 'core', type: 'lemma Submission.core : True' }] }, legacy))
      .toThrow('math_plan_invalid_helper_type');
    const repaired = parseLeadPlan(problem, { baseVersion: 'v1', upsert: [{ id: 'core', type: '∀ (P : Prop), P → P' }] }, legacy);
    expect(repaired.tasks[0].type).toBe('∀ (P : Prop), P → P');
  });

  it('reads a null field of a complete plan as unset, as a revision does', () => {
    const goal = { id: 'goal', kind: 'goal', objective: 'Prove the frozen target.', theoremName: 'Submission.main', dependsOn: ['core'] };
    const plan = parseLeadPlan(problem, { tasks: [{ ...lemma('core'), ownerId: null, status: null, family: null }, { ...goal, ownerId: null }],
      groups: [{ id: 'main', objective: 'Main.', engineerId: null }] });
    expect(plan.tasks).toEqual(parseCooperationPlan(problem, { tasks: [lemma('core'), goal],
      groups: [{ id: 'main', objective: 'Main.' }] }).tasks);
    expect(plan.tasks[0]).not.toHaveProperty('ownerId');
    expect(plan.groups[0]).not.toHaveProperty('engineerId');
    expect(() => parseCooperationPlan(problem, { tasks: [null, goal] })).toThrow('math_plan_invalid_task: {"field":"task"}');
    expect(() => parseCooperationPlan(problem, { tasks: [{ ...lemma('core'), ownerId: 7 }, goal] }))
      .toThrow('math_plan_invalid_task: {"taskId":"core","field":"ownerId"}');
  });

  it('normalizes only a new task\'s pending scheduling default and preserves the proposed inputs', () => {
    const patch = { baseVersion: 'v1', upsert: [{ ...lemma('bridge'), status: 'pending' }] };
    const plan = parseLeadPlan(problem, patch, base);
    expect(plan.tasks.find(task => task.id === 'bridge')).toEqual({ ...lemma('bridge'), proofPath: 'Submission.lean', revision: 0 });
    expect(plan.tasks.find(task => task.id === 'bridge')).not.toHaveProperty('status');
    expect(patch.upsert[0].status).toBe('pending');
    expect(plan.tasks.slice(0, 3)).toEqual(base.tasks);
  });

  it('requires an explicit policy for existing tasks and rejects fabricated host acceptance', () => {
    const pausedBase = { ...base, tasks: base.tasks.map(task => task.id === 'side' ? { ...task, status: 'paused' as const } : task) };
    expect(() => parseLeadPlan(problem, { baseVersion: 'v1', upsert: [{ id: 'side', status: 'pending' }] }, pausedBase))
      .toThrow('Task policy status must be active, paused or stopped');
    expect(pausedBase.tasks.find(task => task.id === 'side')?.status).toBe('paused');
    for (const status of ['running', 'integrated', 'checked', 'completed', 'delivered'])
      expect(() => parseLeadPlan(problem, { baseVersion: 'v1', upsert: [{ ...lemma('bridge'), status }] }, base))
        .toThrow('math_plan_invalid_task: {"taskId":"bridge","field":"status"}');
    expect(() => parseCooperationPlan(problem, { tasks: [{ ...lemma('bridge'), status: 'pending' }, ...base.tasks] }))
      .toThrow('Task policy status must be active, paused or stopped');
  });

  it('allows only an unchanged pending default replay when the host rebases the same published dispatch', () => {
    const patch = { baseVersion: 'v1', upsert: [{ ...lemma('bridge'), status: 'pending' }] };
    const published = parseLeadPlan(problem, patch, base);
    const current = { ...base, version: 'v2', tasks: published.tasks };
    const options = { acceptedBaseVersions: ['v1', 'v2'], rebased: true };
    expect(parseLeadPlan(problem, patch, current, options).tasks).toEqual(published.tasks);
    expect(() => parseLeadPlan(problem, { ...patch, baseVersion: 'v2' }, current, options))
      .toThrow('field":"status');
    expect(() => parseLeadPlan(problem, { ...patch, upsert: [{ ...patch.upsert[0], objective: 'Changed mathematics.' }] }, current, options))
      .toThrow('field":"status');
    const paused = { ...current, tasks: current.tasks.map(task => task.id === 'bridge' ? { ...task, status: 'paused' as const } : task) };
    expect(() => parseLeadPlan(problem, patch, paused, options)).toThrow('field":"status');
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
