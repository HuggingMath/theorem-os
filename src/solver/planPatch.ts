import type { CooperativeTask, RouteGroup } from './tasks';
import type { ProofRoute } from './proofRoutes';
import { canonicalMathJson } from '../math/mathRuntimeIo';

/** The accepted Lead graph a revision is written against. */
export type PlanPatchBase = { version: string; tasks: readonly CooperativeTask[]; groups: readonly RouteGroup[];
  proofRoutes?: readonly ProofRoute[] };

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Leads sometimes nest a revision under `tasks` (`{"baseVersion":"v","tasks":{"baseVersion":"v","upsert":[...]}}`).
 * It names the same change, so lift it to the top level instead of rejecting the whole decision.
 */
export function liftNestedPlanPatch(value: unknown): unknown {
  if (!record(value) || !record(value.tasks) || (value.tasks.upsert === undefined && value.tasks.remove === undefined)) return value;
  const { tasks: nested, ...rest } = value;
  const clash = Object.keys(nested).find(key => rest[key] !== undefined && rest[key] !== nested[key]);
  if (clash) throw new Error(`math_plan_patch_invalid: ${clash} appears both at the top level and inside tasks; ` +
    'put baseVersion, upsert and remove at the top level and omit tasks.');
  return { ...rest, ...nested };
}

/** A revision names only changed tasks; a complete `tasks` list remains the full-graph form. */
export function isPlanPatch(value: unknown): value is Record<string, unknown> {
  if (!record(value) || (value.upsert === undefined && value.remove === undefined)) return false;
  if (value.tasks !== undefined) throw new Error('math_plan_patch_invalid: use either a complete tasks list or upsert/remove, not both.');
  return true;
}

/**
 * Expand `{baseVersion, upsert, remove, groups?, proofRoutes?}` against the accepted graph.
 * Upserting an existing id replaces only the supplied fields (null deletes one); a changed kind
 * replaces the whole task. New ids need complete task definitions. The result is an ordinary
 * plan object for the normal validator, so coverage, targets and acyclicity are checked as before.
 */
export function expandPlanPatch(value: Record<string, unknown>, base: PlanPatchBase | undefined,
  options: { acceptedBaseVersions?: readonly string[]; rebased?: boolean } = {}): Record<string, unknown> {
  if (!base || !base.tasks.length) throw new Error('math_plan_patch_without_base: publish a complete tasks list for the first plan.');
  const { upsert = [], remove = [] } = value as { upsert?: unknown; remove?: unknown };
  if (typeof value.baseVersion !== 'string' || !Array.isArray(upsert) || !Array.isArray(remove) ||
      upsert.some(task => !record(task) || typeof task.id !== 'string') || remove.some(id => typeof id !== 'string'))
    throw new Error('math_plan_patch_invalid: use {"baseVersion":"...","upsert":[{"id":"...",...}],"remove":["id"]}.');
  const accepted = options.acceptedBaseVersions ?? [base.version];
  if (!accepted.includes(value.baseVersion))
    throw new Error(`math_plan_patch_version_conflict: baseVersion ${value.baseVersion} is not the accepted plan ${base.version}; ` +
      'rewrite this patch against the current accepted graph.');
  const upserts = upsert as Record<string, unknown>[], removals = remove as string[];
  const upsertIds = upserts.map(task => task.id as string);
  if (new Set(upsertIds).size !== upsertIds.length || new Set(removals).size !== removals.length)
    throw new Error('math_plan_patch_duplicate_task');
  const both = removals.find(id => upsertIds.includes(id));
  if (both) throw new Error(`math_plan_patch_conflicting_task: ${both} is both upserted and removed.`);
  const current = new Map(base.tasks.map(task => [task.id, task]));
  // A rebased patch was already applied by this dispatch's own publication.
  const unknown = removals.find(id => !current.has(id));
  if (unknown && !options.rebased) throw new Error(`math_plan_patch_unknown_task: ${unknown} is not in the accepted graph.`);
  const removed = new Set(removals);
  const changed = new Map(upserts.map(patch => {
    const previous = current.get(patch.id as string);
    const merged: Record<string, unknown> = previous && (patch.kind === undefined || patch.kind === previous.kind)
      ? { ...previous, ...patch } : { ...patch };
    for (const [key, entry] of Object.entries(merged)) if (entry === null) delete merged[key];
    // Leads sometimes copy the host's initial scheduling status into a new task.
    // It means the same as an omitted policy. This dispatch may repeat its
    // already-published patch in final notes, where the task now exists; permit
    // that exact no-op only when the host explicitly rebases the old dispatch.
    // Existing task changes still require active/paused/stopped, never host states.
    if (merged.status === 'pending') {
      const normalized = { ...merged }; delete normalized.status;
      if (!previous || options.rebased && value.baseVersion !== base.version &&
          canonicalMathJson(normalized) === canonicalMathJson(previous)) delete merged.status;
    }
    return [patch.id as string, merged];
  }));
  const tasks: unknown[] = [...base.tasks.filter(task => !removed.has(task.id)).map(task => changed.get(task.id) ?? task),
    ...upserts.filter(patch => !current.has(patch.id as string)).map(patch => changed.get(patch.id as string)!)];
  const ids = new Set(tasks.map(task => (task as { id: string }).id));
  for (const task of tasks) for (const id of (task as { dependsOn?: unknown }).dependsOn as unknown[] ?? [])
    if (typeof id === 'string' && removed.has(id) && !ids.has(id))
      throw new Error(`math_plan_patch_dangling_dependency: ${(task as { id: string }).id} still depends on removed ${id}.`);
  const replace = <T>(key: 'groups' | 'proofRoutes', fallback: T) => value[key] === undefined ? fallback : value[key] ?? [];
  return { tasks, groups: replace('groups', base.groups), proofRoutes: replace('proofRoutes', base.proofRoutes ?? []) };
}

/** One task per line keeps a large accepted graph greppable and cheap to inspect by id. */
export function formatPlanJson(plan: { tasks: readonly unknown[]; groups?: readonly unknown[]; proofRoutes?: readonly unknown[] }) {
  const list = (items: readonly unknown[]) => items.length ? '[\n' + items.map(item => '  ' + JSON.stringify(item)).join(',\n') + '\n]' : '[]';
  return '{\n"tasks": ' + list(plan.tasks) +
    (plan.groups ? ',\n"groups": ' + list(plan.groups) : '') +
    (plan.proofRoutes?.length ? ',\n"proofRoutes": ' + list(plan.proofRoutes) : '') + '\n}';
}
