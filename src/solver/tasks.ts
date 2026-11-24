import type { SolverProblem } from './problem';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { isSimpleLeanName } from '../math/leanSyntax';
import type { DeliveryRecord } from './deliveries';
import type { TaskProof } from './cooperativeProof';
import type { StatementAction } from './statementReview';
import type { TaskTypePreflight } from './taskTypePreflight';
import { parseProofRoutes, type ProofRoute } from './proofRoutes';
import type { CapacityExploration } from './capacityExploration';
import type { ResearchBasis, ResearchRecord } from './researchRecords';
import { expandTaskFamilies, type TaskFamily } from './taskFamilies';
import type { researchSourceKinds } from './researchReferences';
import { planError, PlanValidationError } from './planDiagnostics';
export { planError } from './planDiagnostics';

export type CooperativeTask = Readonly<{ id: string; kind: 'research' | 'sketch' | 'lemma' | 'goal'; objective: string;
  dependsOn: readonly string[]; revision: number; proofPath?: string; theoremName?: string; type?: string;
  groupId?: string; sharing?: 'group' | 'problem'; status?: 'active' | 'paused' | 'stopped'; ownerId?: string; premises?: readonly string[];
  /** Initial scaffold preference; an idle generalist may take unstarted work while this peer is busy. */
  preferredOwnerId?: string;
  /** Tool/source focus for an advisory investigation; this is not a separate agent role. */
  researchSource?: typeof researchSourceKinds[number];
  /** Original goals served by advisory effort; these are attribution links, never proof dependencies. */
  consumerGoalIds?: readonly string[];
  conditional?: boolean; statementReview?: boolean; informalStatement?: string;
  /** Blueprint prose: the intended informal argument and its literature sources. Guidance only, never a premise. */
  informalProof?: string; citations?: readonly string[];
  reviewScope?: 'final-candidate' | 'feasibility';
  /** A typed lemma task whose target is a new `def` of `type`; consumers use its body, never an assumed copy. */
  declaration?: 'definition';
  /** A range lemma the host splits into member tasks and assembles; see taskFamilies.ts. */
  family?: TaskFamily;
  /** Host-derived member of this family task id; never supplied by a model plan. */
  familyMember?: string }>;
export type RouteGroup = Readonly<{ id: string; objective: string; status: 'active' | 'paused' | 'stopped'; revision: number;
  engineerId?: string; maxTurns?: number; maxConcurrent?: number }>;
export type RouteRecord = { group: RouteGroup; turns: number; busy?: number };
export const taskGroup = (task: CooperativeTask): string => task.groupId ?? 'main';
export type TaskConnectionCheck = Readonly<{
  schema: 'theorem-os.consumer-connection.v1'; consumer: { taskId: string; taskDigest: string };
  inputs: readonly { taskId: string; taskDigest: string }[]; seedCommit: string; dependenciesDigest: string;
  /** Fixed dispatch inputs that still needed local binders in the worker's seed. */
  assumedInputs?: readonly { taskId: string; taskDigest: string }[]; workerId?: string; assignmentId?: string;
  routeId?: string; routesDigest: string; problemReceiptDigest: string; environmentDigest: string; basisDigest: string;
}>;
export type TaskAssignment = { taskId: string; taskDigest: string; workerId: string; seedCommit: string; assignmentId?: string; groupId?: string; canonicalCommit?: string;
  dependencies?: DeliveryRecord['dependencies']; routeId?: string; connectionCheck?: TaskConnectionCheck;
  /** Same-reviewer intermediate notes may resume only against these fixed inspection inputs. */
  feasibilityInputDigest?: string;
  /** Historical seed diagnostic for this assignment; never a model failure or accepted proof. */
  canonicalProbe?: Readonly<{ evidence: 'advisory-canonical-check'; proofAcceptance: 'not-accepted';
    sourceCommit: string; environmentDigest: string; verificationStatus: TaskProof['verification']['status'];
    receiptIds: readonly string[]; feedback: string }>;
  /** Actual prompt inputs, frozen when a research turn starts. */
  researchBasis?: ResearchBasis };
export type TaskRecord = { task: CooperativeTask; readonly status: 'pending' | 'running' | 'blocked' | 'conditional' | 'delivered' | 'integrated' | 'completed';
  /** Host-owned scoped feasibility work, excluded from the Lead's editable proof graph. */
  nextCheckId?: string;
  /** Host-owned advisory work; never supplied by a model plan. */
  capacityExploration?: CapacityExploration;
  attempts: number; assignment?: TaskAssignment; proof?: TaskProof; integratedCheck?: TaskProof; feedback?: string; finding?: string;
  researchCompletion?: ResearchRecord;
  /** An unchanged conditional handoff yields to an executable input without abandoning its draft. */
  connectionCheckpoint?: { basisDigest: string; inputDigest: string; outputDigest: string };
  /** One source-contract correction belongs to this assignment, not equivalent mathematical tasks. */
  sourceRepair?: { taskDigest: string; workerId: string; assignmentId?: string; seedCommit: string;
    pending: boolean; startedAttempt?: number };
  pendingValidation?: { id: string; taskDigest: string; canonicalCommit: string; environmentDigest: string; problemReceiptDigest: string; proof?: boolean };
  typePreflight?: TaskTypePreflight;
  routeParking?: string[]; parkedRoutes?: Record<string, string[]>; alternativeRoutes?: readonly ProofRoute[] };
export type CooperativeAction = { kind: 'lead' | 'assemble'; seedCommit: string; planVersion?: string; planningInputDigest?: string;
  initialPlanNonce?: string;
  planNonce?: string;
  /** Stable mathematical responsibility, independent of graph presentation. */
  responsibilityDigest?: string; } |
  { kind: 'review'; seedCommit: string; sourceDigest: string; assignmentId?: string } | { kind: 'task'; assignment: TaskAssignment; task: CooperativeTask } | StatementAction;

export const taskVersion = (task: CooperativeTask) => {
  const { status: _status, ownerId: _owner, preferredOwnerId: _preferredOwner, statementReview: _review, informalStatement: _intent,
    informalProof: _proof, citations: _citations, consumerGoalIds: _consumers, ...mathematics } = task;
  return mathDigest(canonicalMathJson(mathematics));
};
const objectiveWords = (objective: string) => objective.replace(/\s+/gu, ' ').trim();
/**
 * A revised plan that only re-spaces an accepted objective keeps the accepted wording, so the task keeps its version and
 * its running assignment; any other change, a bumped revision included, still produces a new version.
 */
export function keepRespacedObjectives(tasks: readonly CooperativeTask[], accepted: ReadonlyMap<string, CooperativeTask>) {
  return tasks.map(task => {
    const previous = accepted.get(task.id);
    if (!previous || previous.objective === task.objective || objectiveWords(previous.objective) !== objectiveWords(task.objective)) return task;
    const kept = { ...task, objective: previous.objective };
    return taskVersion(kept) === taskVersion(previous) ? kept : task;
  });
}
/** Planning revisions still supersede assignments; checked sources can be revalidated separately. */
export const taskProofContractVersion = (task: CooperativeTask) => {
  if (isAdvisoryTask(task)) return taskVersion(task);
  const { objective: _objective, revision: _revision, ...contract } = task;
  return taskVersion(contract as CooperativeTask);
};
// Object identity is process-local: archived references never authorize narrower dependency checks.
const checkedReferences = new WeakSet<TaskProof>();
export function taskReferenceDependencies(node: TaskRecord): DeliveryRecord['dependencies'] | undefined {
  const proof = node.integratedCheck, references = proof?.references;
  return !node.pendingValidation && node.status === 'integrated' && proof?.passed && !proof.conditions?.length &&
    proof.taskDigest === taskVersion(node.task) && checkedReferences.has(proof) && references?.tasks &&
    references.inputs.every(input => input.name) ? references.tasks : undefined;
}
export const markTaskReferences = (proof: TaskProof) => checkedReferences.add(proof);
export const hasTaskReferences = (proof: TaskProof) => checkedReferences.has(proof);
// Restored JSON cannot authorize final-candidate dispatch before the host rechecks it.
const freshTaskAcceptances = new WeakMap<TaskProof, string>();
const acceptanceIdentity = (proof: TaskProof) => canonicalMathJson({ commit: proof.commit, sourceDigest: proof.sourceDigest,
  taskDigest: proof.taskDigest, conditions: proof.conditions, projection: proof.projection, verification: proof.verification && {
    status: proof.verification.status, targetCommit: proof.verification.targetCommit,
    receipts: proof.verification.results.map(result => [result.receiptId, result.status, result.targetCommit]) } });
export const markTaskAcceptance = (proof: TaskProof) => {
  if (proof.passed && proof.verification?.status === 'kernel_verified') freshTaskAcceptances.set(proof, acceptanceIdentity(proof));
};
export const hasTaskAcceptance = (proof: TaskProof) => freshTaskAcceptances.get(proof) === acceptanceIdentity(proof);
/** A passed, unconditional integration of exactly `taskDigest` that this host process accepted. */
export const freshlyAccepted = (node: TaskRecord | undefined, taskDigest: string): boolean => node?.status === 'integrated' &&
  !!node.integratedCheck?.passed && node.integratedCheck.taskDigest === taskDigest && !node.integratedCheck.conditions?.length &&
  hasTaskAcceptance(node.integratedCheck);
/** Integrated with a passing, unconditional check of the current task version; no acceptance receipt is required. */
export const checkedUnconditionally = (node: TaskRecord | undefined): boolean => node?.status === 'integrated' &&
  !!node.integratedCheck?.passed && node.integratedCheck.taskDigest === taskVersion(node.task) && !node.integratedCheck.conditions?.length;
export const openRoutes = (node: TaskRecord) => node.alternativeRoutes?.filter(route => !node.parkedRoutes?.[route.id]?.length) ?? [];
/** Every OR branch is parked; false for a task without branches. */
export const allRoutesParked = (node: TaskRecord): boolean =>
  Boolean(node.alternativeRoutes?.length && node.alternativeRoutes.every(route => node.parkedRoutes?.[route.id]?.length));
/** The route group is active and below its turn cap. */
export const groupOpen = (record: RouteRecord | undefined): record is RouteRecord =>
  Boolean(record && record.group.status === 'active' && record.turns < (record.group.maxTurns ?? Infinity));

/** Compute invalidation before changing assignments or emitting any notifications. */
export function invalidatedTaskIds(previous: readonly TaskRecord[], tasks: readonly CooperativeTask[],
  changedGroups: ReadonlySet<string>, dependencies: ReadonlyMap<string, readonly string[]>, changedTasks: ReadonlySet<string> = new Set(),
  version: (task: CooperativeTask) => string = taskVersion): Set<string> {
  const proposed = new Map(tasks.map(task => [task.id, version(task)]));
  const invalidated = new Set(previous.filter(node => changedTasks.has(node.task.id) || changedGroups.has(taskGroup(node.task)) ||
    proposed.get(node.task.id) !== version(node.task)).map(node => node.task.id));
  const consumers = new Map<string, string[]>();
  for (const task of tasks) for (const id of dependencies.get(task.id) ?? task.dependsOn) {
    const list = consumers.get(id) ?? []; list.push(task.id); consumers.set(id, list);
  }
  const queue = [...invalidated];
  for (let i = 0; i < queue.length; i++) for (const id of consumers.get(queue[i]) ?? []) {
    if (!invalidated.has(id)) { invalidated.add(id); queue.push(id); }
  }
  return invalidated;
}

export const assignmentDeliveryFile = (assignment: TaskAssignment) => `DELIVERIES-${mathDigest(canonicalMathJson({
  taskId: assignment.taskId, taskDigest: assignment.taskDigest, seedCommit: assignment.seedCommit,
  ...(assignment.assignmentId === undefined ? {} : { assignmentId: assignment.assignmentId }) }))}.jsonl`;

/** An explicit initial-plan event is scoped to one host-created Lead dispatch. */
export const initialPlanDeliveryFile = (action: CooperativeAction) => action.kind === 'lead' && action.initialPlanNonce
  ? `DELIVERIES-${mathDigest(canonicalMathJson({ kind: 'initial-plan', nonce: action.initialPlanNonce,
    seedCommit: action.seedCommit, planVersion: action.planVersion, planningInputDigest: action.planningInputDigest }))}.jsonl`
  : undefined;

/** Later plans also publish once per frozen dispatch, with an explicit compare-and-swap base. */
export const leadPlanDeliveryFile = (action: CooperativeAction) => initialPlanDeliveryFile(action) ??
  (action.kind === 'lead' && action.planNonce
    ? `DELIVERIES-${mathDigest(canonicalMathJson({ kind: 'plan', nonce: action.planNonce,
      seedCommit: action.seedCommit, planVersion: action.planVersion, planningInputDigest: action.planningInputDigest }))}.jsonl`
    : undefined);

export const isAdvisoryTask = (task: CooperativeTask) => task.kind === 'research' || task.kind === 'sketch';
export const isDefinitionTask = (task: CooperativeTask) => task.kind === 'lemma' && task.declaration === 'definition';
/** A typed proposition whose fixed statement a conditional consumer may bind before it is proved. Definitions are not
 * propositions: a consumer needs their actual body, so they must be integrated first. */
export const assumableLemma = (task: CooperativeTask | undefined): boolean =>
  Boolean(task && task.kind === 'lemma' && task.type?.trim() && !isDefinitionTask(task));
export const isFinalCandidateReview = (task: CooperativeTask) => isAdvisoryTask(task) &&
  (task.reviewScope === 'final-candidate' || task.id === 'independent_candidate_review');
export const isFeasibilityReview = (task: CooperativeTask) => isAdvisoryTask(task) &&
  task.reviewScope === 'feasibility' && !isFinalCandidateReview(task);
/** Pin a deferred decision's `waitsOn` ids to their current typed, non-advisory task versions. `invalid` rejects a malformed
 * list; `invalidTask` prefixes the id that names no such task. */
export function parseWaitsOn(value: unknown, deferred: boolean, task: (id: string) => CooperativeTask | undefined, invalid: string,
  invalidTask: string): { taskId: string; taskDigest: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!deferred || !Array.isArray(value) || !value.length || new Set(value).size !== value.length ||
      value.some(id => typeof id !== 'string')) throw new Error(invalid);
  return value.map((taskId: string) => {
    const proposed = task(taskId);
    if (!proposed || isAdvisoryTask(proposed) || proposed.kind === 'lemma' && !proposed.type?.trim())
      throw new Error(invalidTask + taskId);
    return { taskId, taskDigest: taskVersion(proposed) };
  });
}

const validId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/u.test(value);
/** Blueprint prose travels with every plan copy, so it stays short; full sources belong in references. */
export const MAX_INFORMAL_PROOF_CHARS = 2000, MAX_CITATIONS = 8, MAX_CITATION_CHARS = 300;
const optionalFields = (value: any, keys: readonly string[]) =>
  Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
/** A null field means "unset", as it does in a revision upsert; Leads write `"ownerId": null` for an unowned task. */
const withoutNulls = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null)) : value;

export type CooperationPlanProblem = Pick<SolverProblem, 'ownedFiles' | 'frozenFiles' | 'targets' | 'declarations'>;

export function parseCooperationPlan(problem: CooperationPlanProblem, value: any): { tasks: CooperativeTask[]; groups: RouteGroup[]; proofRoutes?: ProofRoute[] } {
  if (value?.tasks && typeof value.tasks === 'object' && !Array.isArray(value.tasks))
    throw planError('math_plan_invalid', { field: 'tasks' },
      'tasks must be the complete array of task objects; a revision omits tasks and puts baseVersion, upsert and remove at the top level');
  if (value && typeof value === 'object' && !Array.isArray(value) && value.tasks === undefined)
    throw planError('math_plan_invalid', { field: 'tasks' },
      'include the complete tasks array, or use a revision with baseVersion and upsert/remove; ' +
      'when only answering decisions, use {"baseVersion":"CURRENT_PLAN_VERSION","upsert":[]} plus the required decisions in the same JSON object');
  if (value && !Array.isArray(value.tasks))
    throw planError('math_plan_invalid', { field: 'tasks' }, 'Supply the complete array of task objects.');
  if (!value || value.tasks.length < 1)
    throw new PlanValidationError('math_plan_invalid', '', [{ path: 'tasks', message: 'Supply a nonempty array of task objects.' }]);
  // Leads routinely serialize an empty explicit list; it carries the same meaning as omitting it.
  const rawGroups = !Array.isArray(value.groups) || !value.groups.length
    ? [{ id: 'main', objective: 'Prove the original problem' }] : value.groups.map(withoutNulls);
  const groups: RouteGroup[] = rawGroups.map((group: any, index: number) => {
    const field = !group || typeof group !== 'object' ? 'group' : !validId(group.id) ? 'id' :
      typeof group.objective !== 'string' || !group.objective.trim() ? 'objective' :
      !['active', 'paused', 'stopped'].includes(group.status ?? 'active') ? 'status' :
      !Number.isSafeInteger(group.revision ?? 0) || (group.revision ?? 0) < 0 ? 'revision' :
      group.engineerId !== undefined && !validId(group.engineerId) ? 'engineerId' :
      group.maxTurns !== undefined && (!Number.isSafeInteger(group.maxTurns) || group.maxTurns < 0) ? 'maxTurns' :
      group.maxConcurrent !== undefined && (!Number.isSafeInteger(group.maxConcurrent) || group.maxConcurrent < 1) ? 'maxConcurrent' : undefined;
    if (field) throw planError('math_plan_invalid_group', { index, groupId: validId(group?.id) ? group.id : undefined, field });
    return { id: group.id, objective: group.objective, status: group.status ?? 'active', revision: group.revision ?? 0,
      ...optionalFields(group, ['engineerId', 'maxTurns', 'maxConcurrent']) };
  });
  const duplicateGroup = groups.find((group, index) => groups.findIndex(item => item.id === group.id) !== index);
  if (duplicateGroup) throw planError('math_plan_duplicate_group', { groupId: duplicateGroup.id });
  const tasks: CooperativeTask[] = expandTaskFamilies(value.tasks.map(withoutNulls), planError).map((value: any) => {
    // A research request with an exact proof target is proof work, regardless of its label.
    if (value && ['research', 'sketch'].includes(value.kind) && value.theoremName &&
        typeof value.type === 'string' && value.type.trim())
      value = { ...value, kind: 'lemma' };
    const editable = problem.ownedFiles.filter(file => file.endsWith('.lean') && !Object.hasOwn(problem.frozenFiles ?? {}, file));
    const task = value && { ...value, dependsOn: value.dependsOn ?? [], proofPath: value.proofPath ??
      (value.kind === 'goal' ? problem.targets.find(target => target.theoremName === value.theoremName)?.proofPath :
        editable.length === 1 ? editable[0] : undefined) };
    const taskId = validId(task?.id) ? task.id : undefined;
    const field = !task || typeof task !== 'object' ? 'task' : !taskId ? 'id' :
      !['research', 'sketch', 'lemma', 'goal'].includes(task.kind) ? 'kind' :
      typeof task.objective !== 'string' || !task.objective.trim() ? 'objective' :
      !Array.isArray(task.dependsOn) || task.dependsOn.some((id: unknown) => typeof id !== 'string') ? 'dependsOn' :
      !Number.isSafeInteger(task.revision ?? 0) || (task.revision ?? 0) < 0 ? 'revision' :
      task.status !== undefined && !['active', 'paused', 'stopped'].includes(task.status) ? 'status' :
      task.conditional !== undefined && (typeof task.conditional !== 'boolean' || isAdvisoryTask(task)) ? 'conditional' :
      task.statementReview !== undefined && (typeof task.statementReview !== 'boolean' || isAdvisoryTask(task)) ? 'statementReview' :
      task.reviewScope !== undefined && (!isAdvisoryTask(task) ||
        !['final-candidate', 'feasibility'].includes(task.reviewScope)) ? 'reviewScope' :
      task.informalStatement !== undefined && (typeof task.informalStatement !== 'string' || !task.informalStatement.trim()) ||
        task.statementReview === true && !task.informalStatement ? 'informalStatement' :
      task.informalProof !== undefined && (typeof task.informalProof !== 'string' || !task.informalProof.trim() ||
        task.informalProof.length > MAX_INFORMAL_PROOF_CHARS) ? 'informalProof' :
      task.citations !== undefined && (!Array.isArray(task.citations) || !task.citations.length || task.citations.length > MAX_CITATIONS ||
        task.citations.some((item: unknown) => typeof item !== 'string' || !item.trim() || item.length > MAX_CITATION_CHARS)) ? 'citations' :
      task.ownerId !== undefined && !validId(task.ownerId) ? 'ownerId' :
      task.preferredOwnerId !== undefined && (!validId(task.preferredOwnerId) || task.kind !== 'goal' || task.ownerId !== undefined) ? 'preferredOwnerId' :
      task.researchSource !== undefined && (!isAdvisoryTask(task) || !['mathlib', 'verified-library', 'public-literature'].includes(task.researchSource)) ? 'researchSource' :
      task.consumerGoalIds !== undefined && (!isAdvisoryTask(task) || !Array.isArray(task.consumerGoalIds) ||
        task.consumerGoalIds.some((id: unknown) => !validId(id))) ? 'consumerGoalIds' :
      task.premises !== undefined && (!Array.isArray(task.premises) ||
        task.premises.some((premise: unknown) => typeof premise !== 'string')) ? 'premises' :
      task.declaration !== undefined && (task.declaration !== 'definition' || task.kind !== 'lemma' ||
        task.conditional === true || task.statementReview === true) ? 'declaration' : undefined;
    if (field) throw planError('math_plan_invalid_task', { taskId, field }, field === 'status'
      ? 'Task policy status must be active, paused or stopped, or omitted. Host scheduling and proof-acceptance states are not plan fields.' : '');
    if (!groups.some(group => group.id === (task.groupId ?? 'main')) ||
        (task.sharing !== undefined && !['group', 'problem'].includes(task.sharing)))
      throw planError('math_plan_invalid_task_group', { taskId, groupId: task.groupId ?? 'main', sharing: task.sharing },
        'Use a declared group id and sharing "group" or "problem".');
    if (!isAdvisoryTask(task) && (!problem.ownedFiles.includes(task.proofPath) ||
        !isSimpleLeanName(task.theoremName)))
      throw planError('math_plan_invalid_proof_target', { taskId: task.id,
        proofPath: task.proofPath, theoremName: task.theoremName,
        field: !problem.ownedFiles.includes(task.proofPath) ? 'proofPath' : 'theoremName' },
        'Use an owned proofPath and an ordinary qualified Lean name.');
    if (!isAdvisoryTask(task) && Object.hasOwn(problem.frozenFiles ?? {}, task.proofPath))
      throw planError('math_plan_frozen_proof_path', { taskId, proofPath: task.proofPath },
        'Submission/Library modules are frozen host libraries; put the task in another owned file that imports the module.');
    if (task.kind === 'goal' && !problem.targets.some(target => target.proofPath === task.proofPath && target.theoremName === task.theoremName))
      throw planError('math_plan_changed_original_target', { taskId, proofPath: task.proofPath, theoremName: task.theoremName },
        'A goal task must name an original target exactly; use a lemma task for a helper statement.');
    if (task.kind === 'lemma' && typeof task.type === 'string' && task.type.trim() === 'FULL_CLOSED_LEAN_TYPE')
      throw planError('math_plan_placeholder_helper_type', { taskId, field: 'type' },
        'Supply the actual closed Lean type, or use an untyped research/sketch task for advisory findings.');
    if (task.kind === 'lemma' && (typeof task.type !== 'string' || !task.type.trim()))
      throw planError('math_plan_invalid_helper_type', { taskId, field: 'type' }, 'Supply the closed Lean type of the helper.');
    if (task.kind === 'lemma') {
      const leaf = task.theoremName.split('.').at(-1);
      const file = Object.keys(problem.declarations).find(file => problem.declarations[file]!.some(item => item.name.split('.').at(-1) === leaf));
      if (file) throw planError('math_plan_invalid_helper_type', { taskId, field: 'theoremName', theoremName: task.theoremName,
        ...(Object.hasOwn(problem.frozenFiles ?? {}, file) ? { libraryFile: file } : {}) },
        Object.hasOwn(problem.frozenFiles ?? {}, file)
          ? 'This name is already proved in a frozen Submission/Library module; import that module and use it instead of a new task, or choose a distinct helper name.'
          : 'A helper must not reuse the final name component of a frozen declaration.');
    }
    return { id: task.id, kind: task.kind, objective: task.objective, dependsOn: [...new Set<string>(task.dependsOn)],
      revision: task.revision ?? 0, ...(isAdvisoryTask(task) ? {} : { proofPath: task.proofPath, theoremName: task.theoremName }),
      ...(task.kind === 'lemma' ? { type: task.type } : {}),
      ...optionalFields(task, ['conditional', 'statementReview', 'informalStatement', 'informalProof', 'citations', 'reviewScope', 'status',
        'ownerId', 'preferredOwnerId', 'researchSource', 'premises', 'groupId', 'declaration', 'family', 'familyMember']),
      ...(task.consumerGoalIds ? { consumerGoalIds: [...new Set<string>(task.consumerGoalIds)].sort() } : {}),
      ...(task.sharing === undefined ? groups.length > 1 ? { sharing: 'group' } : {} : { sharing: task.sharing }) };
  });
  const duplicateId = tasks.find((task, index) => tasks.findIndex(item => item.id === task.id) !== index);
  if (duplicateId) throw planError('math_plan_duplicate_task', { taskId: duplicateId.id });
  const shortName = (task: CooperativeTask) => task.theoremName!.split('.').at(-1);
  const typed = tasks.filter(task => !isAdvisoryTask(task));
  const duplicateName = typed.find((task, index) => typed.findIndex(item => shortName(item) === shortName(task)) !== index);
  if (duplicateName) throw planError('math_plan_duplicate_task', { taskId: duplicateName.id, theoremName: duplicateName.theoremName },
    'Typed tasks need distinct final theorem name components.');
  const uncovered = problem.targets.find(target => tasks.filter(task => task.kind === 'goal' && task.proofPath === target.proofPath && task.theoremName === target.theoremName).length !== 1);
  if (uncovered) throw planError('math_plan_incomplete_original_coverage', { proofPath: uncovered.proofPath, theoremName: uncovered.theoremName },
    'Each original target needs exactly one goal task.');
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) for (const id of task.consumerGoalIds ?? []) {
    const consumer = byId.get(id);
    if (!consumer || consumer.kind !== 'goal')
      throw planError('math_plan_invalid_task', { taskId: task.id, field: 'consumerGoalIds' }, 'Reference original goal tasks.');
    if (taskGroup(task) !== taskGroup(consumer) && consumer.sharing === 'group')
      throw planError('math_plan_dependency_not_shared', { taskId: task.id, consumerGoalId: id });
  }
  const visiting: string[] = [], visited = new Set<string>();
  const visit = (id: string, consumer?: string) => {
    if (visiting.includes(id)) throw planError('math_plan_dependency_cycle', { cycle: [...visiting.slice(visiting.indexOf(id)), id] });
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw planError('math_plan_missing_dependency', { taskId: consumer, dependsOn: id });
    visiting.push(id); task.dependsOn.forEach(input => visit(input, id)); visiting.pop(); visited.add(id);
  };
  tasks.forEach(task => visit(task.id));
  for (const task of tasks) for (const id of task.dependsOn) {
    const dependency = byId.get(id)!;
    if (taskGroup(task) !== taskGroup(dependency) && dependency.sharing === 'group')
      throw planError('math_plan_dependency_not_shared', { taskId: task.id, dependsOn: id },
        'A cross-group dependency needs sharing "problem" on its input.');
    if (task.kind === 'goal' && dependency.kind === 'goal' && task.proofPath === dependency.proofPath) {
      const declarations = problem.declarations[task.proofPath!]!;
      const position = (name: string) => declarations.findIndex(item => item.name.split('.').at(-1) === name.split('.').at(-1));
      if (position(dependency.theoremName!) > position(task.theoremName!))
        throw new Error(`math_plan_forward_goal_dependency: ${task.id} precedes ${dependency.id} in ${task.proofPath}. ` +
          'Extract the shared argument into a named lemma before both original goals; preserve original declaration order and other goal proofs.');
    }
  }
  const proofRoutes = parseProofRoutes(value.proofRoutes, tasks);
  return { tasks, groups, ...(proofRoutes.length ? { proofRoutes } : {}) };
}
