import type { GoalPathCandidate, GoalPathReview } from './goalPathReview';
import { expandPlanPatch, type PlanPatchBase } from './planPatch';
import { planError, taskGroup } from './tasks';
import { familyParent } from './taskFamilies';
import { canonicalMathJson } from '../math/mathRuntimeIo';

/**
 * The Lead's answer to a stalled original goal, written in the same revision as
 * `"goalPath":{"adopt":["CANDIDATE_ID"],"decline":[{"taskId":"...","reason":"..."}]}`. A mechanical candidate is
 * expanded here into ordinary upserts or group changes, so adopting it needs no other edit; any other adopted
 * candidate must be visible in the revision itself. The expanded revision is then validated like any other plan.
 * Decisions only record how the Lead answered the review; they never accept a proof.
 */
export type GoalPathDecisions = { adopted: { id: string; action: GoalPathCandidate['action']; taskId: string }[];
  declined: { taskId: string; reason: string }[] };

export const MAX_GOAL_PATH_DECLINE_CHARS = 500;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const invalid = (detail: Record<string, unknown>) => planError('math_plan_goal_path_invalid', detail,
  'Use "goalPath":{"adopt":["CANDIDATE_ID"],"decline":[{"taskId":"STALLED_INPUT","reason":"..."}]} beside baseVersion.');

const taskContract = (task: Record<string, unknown> | undefined) => {
  if (!task) return null;
  const list = (value: unknown) => Array.isArray(value) ? [...new Set(value)].sort() : value ?? [];
  return { kind: task.kind, type: typeof task.type === 'string' ? task.type.trim() : task.type,
    dependsOn: list(task.dependsOn), premises: list(task.premises), conditional: task.conditional === true,
    declaration: task.declaration, family: task.family };
};

/**
 * Strip `goalPath` from a Lead plan value and expand it against the current review. Without a review (a replay of an
 * already applied publication) or without a stalled goal there is nothing left to answer, so the field is dropped.
 * Decisions about inputs that are no longer stalled are moot and ignored; an unknown candidate of a stalled input is not.
 */
export function applyGoalPathDecisions(value: unknown, review: GoalPathReview | undefined, base: PlanPatchBase | undefined):
  { value: unknown; decisions?: GoalPathDecisions } {
  if (!record(value) || value.goalPath === undefined) return { value };
  if (value.tasks !== undefined) throw planError('math_plan_goal_path_requires_revision', {},
    'Answer a stalled goal in a revision with baseVersion; a complete tasks list cannot carry goalPath.');
  const { goalPath, ...rest } = value;
  const revision = { ...rest, upsert: rest.upsert ?? [] };
  const stalled = review?.goals.filter(goal => goal.stalled) ?? [];
  if (!stalled.length || !base) return { value: revision };
  if (!record(goalPath) || (goalPath.adopt !== undefined && !Array.isArray(goalPath.adopt)) ||
      (goalPath.decline !== undefined && !Array.isArray(goalPath.decline)))
    throw invalid({ field: 'goalPath' });
  const adopt = (goalPath.adopt ?? []) as unknown[], decline = (goalPath.decline ?? []) as unknown[];
  if (adopt.some(id => typeof id !== 'string') || new Set(adopt).size !== adopt.length) throw invalid({ field: 'adopt' });
  if (!Array.isArray(revision.upsert) || revision.upsert.some(task => !record(task) || typeof task.id !== 'string') ||
      (rest.remove !== undefined && !Array.isArray(rest.remove)))
    return { value: revision }; // The ordinary patch validator reports the malformed revision.
  const candidates = new Map(stalled.flatMap(goal => goal.candidates).map(candidate => [candidate.id, candidate] as const));
  const frontier = new Set(stalled.flatMap(goal => goal.frontier.map(item => item.taskId)));
  const leadUpserts = revision.upsert as Record<string, unknown>[];
  const removed = new Set(((rest.remove ?? []) as unknown[]).filter(id => typeof id === 'string') as string[]);
  // What the Lead's own revision changes, before any mechanical expansion.
  const touched = new Set([...leadUpserts.map(task => task.id as string), ...removed]);
  // A derived family member is edited through its family task, which also consumes it.
  const consumers = (taskId: string) => [...base.tasks.filter(task => task.dependsOn.includes(taskId)).map(task => task.id),
    ...[familyParent(base.tasks, taskId)?.id ?? []].flat()];
  /** A claimed revision must change this obligation's argument, not merely its label or revision counter. */
  const appliedRevision = (candidate: GoalPathCandidate) => {
    // Expand the Lead's own patch before mechanical candidates add their independent edits.
    const expanded = expandPlanPatch(revision, base);
    const next = new Map((expanded.tasks as Record<string, unknown>[]).map(task => [task.id as string, task]));
    const previous = new Map(base.tasks.map(task => [task.id, task]));
    const inputs = (taskId: string) => [...(previous.get(taskId)?.dependsOn ?? []),
      ...(base.proofRoutes ?? []).filter(route => route.targetTaskId === taskId)
        .flatMap(route => [route.closingTaskId, ...route.prerequisiteTaskIds])];
    const path = new Set<string>();
    const visit = (id: string) => { if (path.has(id)) return; path.add(id); inputs(id).forEach(visit); };
    for (const goal of stalled) if (goal.frontier.some(item => item.taskId === candidate.taskId)) visit(goal.taskId);
    const related = new Set([candidate.taskId]);
    for (const taskId of related) for (const task of base.tasks)
      if (path.has(task.id) && (inputs(task.id).includes(taskId) || familyParent(base.tasks, taskId)?.id === task.id)) related.add(task.id);
    if ([...related].some(id => canonicalMathJson(taskContract(previous.get(id))) !== canonicalMathJson(taskContract(next.get(id)))))
      return true;
    // Changing an alternative's id or ordering leaves the same mathematical route.
    const routes = (items: unknown) => Array.isArray(items) ? items.filter(record)
      .filter(route => related.has(route.targetTaskId as string))
      .map(route => ({ targetTaskId: route.targetTaskId, closingTaskId: route.closingTaskId,
        prerequisiteTaskIds: Array.isArray(route.prerequisiteTaskIds) ? [...route.prerequisiteTaskIds].sort() : route.prerequisiteTaskIds }))
      .map(route => canonicalMathJson(route)).sort() : [];
    if (canonicalMathJson(routes(base.proofRoutes)) !== canonicalMathJson(routes(expanded.proofRoutes))) return true;
    // An independent feasibility check is immediately startable advisory work; it need not rewrite the proof contract.
    const check = (task: Record<string, unknown> | undefined, groups: unknown) => Boolean(task &&
      ['research', 'sketch'].includes(task.kind as string) && task.reviewScope === 'feasibility' &&
      (task.status ?? 'active') === 'active' && Array.isArray(task.dependsOn) && task.dependsOn.some(id => related.has(id)) &&
      (Array.isArray(groups) && groups.length ? groups : [{ id: 'main' }]).some(group =>
        record(group) && group.id === (task.groupId ?? 'main') && (group.status ?? 'active') === 'active'));
    return [...next.values()].some(task => check(task, expanded.groups) &&
      (!check(previous.get(task.id as string), base.groups) ||
        canonicalMathJson(taskContract(previous.get(task.id as string))) !== canonicalMathJson(taskContract(task))));
  };
  const upserts = new Map(leadUpserts.map(task => [task.id as string, { ...task }]));
  const conflict = (candidate: GoalPathCandidate, field: string) => planError('math_plan_goal_path_conflict',
    { candidateId: candidate.id, field }, 'The revision sets this field differently from the adopted candidate; drop one.');
  /** `next` sees the field the revision itself supplies, else the accepted value; undefined means they disagree. */
  const patch = (candidate: GoalPathCandidate, taskId: string, field: string,
    next: (current: unknown, supplied: boolean) => unknown) => {
    if (removed.has(taskId)) throw conflict(candidate, 'remove');
    const entry = upserts.get(taskId) ?? { id: taskId }, supplied = field in entry;
    const value = next(supplied ? entry[field] : (base.tasks.find(task => task.id === taskId) as Record<string, unknown> | undefined)?.[field], supplied);
    if (value === undefined) throw conflict(candidate, field);
    entry[field] = value; upserts.set(taskId, entry);
  };
  let groups = rest.groups as unknown[] | undefined;
  const decisions: GoalPathDecisions = { adopted: [], declined: [] };
  for (const id of adopt as string[]) {
    const candidate = candidates.get(id);
    if (!candidate) {
      const taskId = id.split(':')[1];
      if (taskId && !frontier.has(taskId)) continue;
      throw planError('math_plan_goal_path_unknown_candidate', { candidateId: id,
        candidates: [...candidates.keys()].filter(key => !taskId || key.split(':')[1] === taskId).slice(0, 8) },
        'Adopt an id listed in goalPath.goals[].candidates of the current review.');
    }
    if (candidate.mechanical) {
      // A member's status follows its family task, so resuming a member resumes the family.
      if (candidate.action === 'resume') patch(candidate, familyParent(base.tasks, candidate.taskId)?.id ?? candidate.taskId, 'status',
        (current, supplied) => supplied && current !== 'active' && current !== null ? undefined : 'active');
      else if (candidate.action === 'connect') patch(candidate, candidate.taskId, 'dependsOn', current =>
        Array.isArray(current) ? [...new Set([...current, ...candidate.relatedTaskIds!])] : undefined);
      else if (candidate.action === 'assume') for (const consumer of candidate.relatedTaskIds!)
        patch(candidate, consumer, 'conditional', (current, supplied) => supplied && current === false ? undefined : true);
      else if (candidate.action === 'reopen-route') {
        const task = base.tasks.find(item => item.id === candidate.taskId);
        const groupId = task ? taskGroup(task) : 'main';
        if (groups) {
          const supplied = groups.find(item => record(item) && item.id === groupId) as Record<string, unknown> | undefined;
          if (supplied && (supplied.status ?? 'active') !== 'active') throw conflict(candidate, 'groups');
        } else groups = base.groups.map(group => group.id === groupId ? { ...group, status: 'active' } : group);
      }
    } else {
      const visible = candidate.action === 'reopen-route' ? groups !== undefined
        : ['revise', 'decompose'].includes(candidate.action) ? appliedRevision(candidate)
        : touched.has(candidate.taskId) || consumers(candidate.taskId).some(id => touched.has(id));
      if (!visible) throw planError('math_plan_goal_path_unapplied', { candidateId: id },
        'This candidate is not mechanical: change the relevant mathematical contract, dependencies or route, ' +
        'or assign an active feasibility check of this input; objective edits and revision counters do not apply it. Otherwise decline it.');
    }
    decisions.adopted.push({ id, action: candidate.action, taskId: candidate.taskId });
  }
  for (const item of decline) {
    if (!record(item) || typeof item.taskId !== 'string' || typeof item.reason !== 'string' || !item.reason.trim() ||
        item.reason.length > MAX_GOAL_PATH_DECLINE_CHARS)
      throw invalid({ field: 'decline', maxReasonChars: MAX_GOAL_PATH_DECLINE_CHARS });
    if (!frontier.has(item.taskId)) continue;
    if (decisions.declined.some(entry => entry.taskId === item.taskId)) throw invalid({ field: 'decline', taskId: item.taskId, duplicate: true });
    if (decisions.adopted.some(entry => entry.taskId === item.taskId))
      throw planError('math_plan_goal_path_conflict', { taskId: item.taskId, field: 'decline' }, 'Either adopt a candidate for this input or decline it.');
    decisions.declined.push({ taskId: item.taskId, reason: item.reason.trim() });
  }
  return { value: { ...revision, upsert: [...upserts.values()], ...(groups !== undefined ? { groups } : {}) }, decisions };
}
