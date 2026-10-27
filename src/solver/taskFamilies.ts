import type { CooperativeTask } from './tasks';

/**
 * A lemma over a finite index range, `∀ i : Nat, lo ≤ i → i < hi → predicate i`. The host splits the range into
 * consecutive member lemmas of `chunk` indices and assembles the family proof from them, so a large case table
 * is dispatchable work and unproved members stay explicit hypotheses of the conditional family check.
 */
export type TaskFamily = Readonly<{ lo: number; hi: number; chunk: number; predicate: string }>;
/** Bounds plan size and the assembly term; 256 members elaborate in under a second. */
export const MAX_FAMILY_MEMBERS = 256;
const MEMBER_SUFFIX = /^_c(0|[1-9][0-9]*)$/u;

export const familyType = (lo: number, hi: number, predicate: string) => `∀ i : Nat, ${lo} ≤ i → i < ${hi} → ${predicate} i`;
export const familyMemberId = (parentId: string, index: number) => `${parentId}_c${index}`;
export const familyMemberName = (theoremName: string, index: number) => `${theoremName}_c${index}`;
const isMemberIdOf = (parentId: string, id: string) => id.startsWith(`${parentId}_c`) && MEMBER_SUFFIX.test(id.slice(parentId.length));

/** Consecutive half-open ranges covering `[lo, hi)`; only the last may be shorter. */
export function familyRanges(family: TaskFamily): { lo: number; hi: number }[] {
  return Array.from({ length: Math.ceil((family.hi - family.lo) / family.chunk) }, (_, index) => ({
    lo: family.lo + index * family.chunk, hi: Math.min(family.hi, family.lo + (index + 1) * family.chunk) }));
}

const leanName = /^[\p{L}_][\p{L}\p{M}\p{N}_'?!]*(?:\.[\p{L}_][\p{L}\p{M}\p{N}_'?!]*)*$/u;

/** The invalid field, or undefined; derived member ids must stay valid task ids. */
function familyField(task: Record<string, unknown>): string | undefined {
  const family = task.family as Record<string, unknown>;
  if (!family || typeof family !== 'object' || Array.isArray(family) ||
      Object.keys(family).some(key => !['lo', 'hi', 'chunk', 'predicate'].includes(key))) return 'family';
  const { lo, hi, chunk, predicate } = family;
  if (![lo, hi].every(value => Number.isSafeInteger(value) && (value as number) >= 0) || (lo as number) >= (hi as number)) return 'family.range';
  if (!Number.isSafeInteger(chunk) || (chunk as number) < 1 ||
      Math.ceil(((hi as number) - (lo as number)) / (chunk as number)) > MAX_FAMILY_MEMBERS) return 'family.chunk';
  // The binder is `i`; a predicate rooted at it would capture the bound index instead of naming a declaration.
  if (typeof predicate !== 'string' || !leanName.test(predicate) || predicate.split('.')[0] === 'i') return 'family.predicate';
  if (task.kind !== 'lemma' || task.declaration !== undefined) return 'kind';
  if (typeof task.id !== 'string' || task.id.length + `_c${MAX_FAMILY_MEMBERS}`.length > 64) return 'id';
  return undefined;
}

type FamilyError = (code: string, detail: Record<string, unknown>, hint?: string) => Error;

/**
 * Rederive every family's members from its parent before ordinary validation. Members are host-owned: a marked
 * copy from an earlier accepted graph is replaced, and an unmarked task under a derived member id is rejected.
 * The parent gets the derived type, `conditional:true` by default, and its members appended to `dependsOn`.
 */
export function expandTaskFamilies(rawTasks: readonly unknown[], error: FamilyError): unknown[] {
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const parents = rawTasks.filter((task): task is Record<string, unknown> => record(task) && task.family !== undefined);
  for (const parent of parents) {
    const field = familyField(parent);
    if (field) throw error('math_plan_invalid_task', { taskId: typeof parent.id === 'string' ? parent.id : undefined, field },
      field.startsWith('family') ? `A family is {"lo":0,"hi":N,"chunk":K,"predicate":"Namespace.name"} with lo < hi, ` +
        `at most ${MAX_FAMILY_MEMBERS} members and a predicate naming a declaration other than the binder i.` :
        field === 'kind' ? 'Only a kind:"lemma" proposition task may declare a family.' : 'Use a family id of at most 59 characters.');
  }
  // Every `ID_cN` is reserved, not only the current range: expansion strips stale member ids from the family's inputs.
  const reserved = (id: unknown) => typeof id === 'string' ? parents.find(parent => isMemberIdOf(parent.id as string, id))?.id : undefined;
  const kept = rawTasks.filter(task => {
    if (!record(task)) return true;
    if (task.familyMember !== undefined) return false;
    const familyId = reserved(task.id);
    if (familyId !== undefined)
      throw error('math_plan_family_member_edited', { taskId: task.id, familyId },
        `Ids ${familyId}_c0, ${familyId}_c1, … are reserved for the members of family task ${familyId}; change the family task instead of a member, or use another id.`);
    return true;
  });
  return kept.flatMap(task => {
    if (!record(task) || task.family === undefined) return [task];
    const family = task.family as TaskFamily, id = task.id as string;
    // An omitted dependsOn means no inputs; a malformed one is left for the ordinary validator to name.
    const listed = task.dependsOn ?? [];
    const inputs = Array.isArray(listed) ? listed.filter(input => typeof input !== 'string' || !isMemberIdOf(id, input)) : undefined;
    const ranges = familyRanges(family);
    const members = typeof task.theoremName !== 'string' ? [] : ranges.map((range, index) => ({
      id: familyMemberId(id, index), kind: 'lemma',
      objective: `Member ${index} of family ${id}: prove ${family.predicate} i for ${range.lo} ≤ i < ${range.hi}. ` +
        'The host assembles the family from its members; see the family task for the route.',
      ...(task.proofPath !== undefined ? { proofPath: task.proofPath } : {}),
      theoremName: familyMemberName(task.theoremName as string, index), type: familyType(range.lo, range.hi, family.predicate),
      dependsOn: inputs ?? [], familyMember: id,
      ...Object.fromEntries(['groupId', 'sharing', 'status'].filter(key => task[key] !== undefined).map(key => [key, task[key]])),
    }));
    const parent = { ...task, family: { lo: family.lo, hi: family.hi, chunk: family.chunk, predicate: family.predicate },
      type: familyType(family.lo, family.hi, family.predicate), conditional: task.conditional ?? true,
      dependsOn: inputs ? [...inputs, ...members.map(member => member.id)] : task.dependsOn };
    return [parent, ...members];
  });
}

/** The Lead-facing graph: members are derivable from their family task, so they and their ids are omitted. */
export function collapseTaskFamilies(tasks: readonly CooperativeTask[]): CooperativeTask[] {
  const families = new Map(tasks.filter(task => task.family).map(task => [task.id, task]));
  return tasks.filter(task => !task.familyMember || !families.has(task.familyMember)).map(task => !task.family ? task :
    { ...task, dependsOn: task.dependsOn.filter(id => !isMemberIdOf(task.id, id)) });
}

/** The family task deriving member `id`, found among parents only, so it also works on a collapsed graph. */
export function familyParent(tasks: readonly CooperativeTask[], id: string): CooperativeTask | undefined {
  return tasks.find(task => task.family && isMemberIdOf(task.id, id) &&
    Number(id.slice(task.id.length + 2)) < familyRanges(task.family).length);
}

/**
 * The family proof term: a balanced split on `i < bound` dispatching each index to its member. Member names are
 * written exactly as their task theorem names so a conditional check can bind unproved members by name.
 */
export function familyAssemblyProof(theoremName: string, family: TaskFamily): string {
  const ranges = familyRanges(family);
  const split = (start: number, end: number, lower: string, upper: string, depth: number): string => {
    if (end - start === 1) return `${familyMemberName(theoremName, start)} i ${lower} ${upper}`;
    const middle = Math.floor((start + end) / 2), hypothesis = `h${depth}`;
    return `(if ${hypothesis} : i < ${ranges[middle]!.lo} then ${split(start, middle, lower, hypothesis, depth + 1)} ` +
      `else ${split(middle, end, `(Nat.not_lt.mp ${hypothesis})`, upper, depth + 1)})`;
  };
  return `fun i hlo hhi => ${split(0, ranges.length, 'hlo', 'hhi', 0)}`;
}
