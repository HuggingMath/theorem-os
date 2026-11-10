import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import type { NextCheckRecord } from './nextCheckContract';
import type { ProofRoute } from './proofRoutes';
import { independentFeasibilityWorker } from './modules/organization';
import { allRoutesParked, checkedUnconditionally, groupOpen, isAdvisoryTask, isDefinitionTask,
  isFeasibilityReview, taskGroup, taskVersion, type RouteRecord, type TaskRecord } from './tasks';

type Identity = { problemReceiptDigest: string; environmentDigest: string };
type State = { tasks: readonly TaskRecord[]; groups?: readonly RouteRecord[];
  proofRoutes?: readonly ProofRoute[]; nextChecks?: readonly NextCheckRecord[] };
const hash = (value: unknown) => mathDigest(canonicalMathJson(value));
const preview = (value: string | undefined, limit: number) => value && value.length > limit ? value.slice(0, limit) + '…' : value ?? '';
const reference = (node: TaskRecord) => ({ taskId: node.task.id, taskDigest: taskVersion(node.task) });
const inputs = (node: TaskRecord, state: State) => [...new Set([...node.task.dependsOn,
  ...(state.proofRoutes ?? node.alternativeRoutes ?? []).filter(route => route.targetTaskId === node.task.id &&
    !node.parkedRoutes?.[route.id]?.length).flatMap(route => [...route.prerequisiteTaskIds, route.closingTaskId])])];
const active = (node: TaskRecord, state: State) => (node.task.status ?? 'active') === 'active' && !node.routeParking?.length &&
  !allRoutesParked(node) && (!state.groups || groupOpen(state.groups.find(group => group.group.id === taskGroup(node.task))));

function originalGoalPath(goal: TaskRecord, state: State): Set<string> {
  const nodes = new Map(state.tasks.map(node => [node.task.id, node])), seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    const node = nodes.get(id);
    if (!node || !active(node, state) || isAdvisoryTask(node.task) || node.nextCheckId || node.capacityExploration) return;
    seen.add(id);
    if (!checkedUnconditionally(node)) inputs(node, state).forEach(visit);
  };
  if (goal.task.kind === 'goal' && !checkedUnconditionally(goal)) visit(goal.task.id);
  return seen;
}

function dependencies(target: TaskRecord, state: State) {
  const nodes = new Map(state.tasks.map(node => [node.task.id, node]));
  const seen = new Set<string>([target.task.id]), found: TaskRecord[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = nodes.get(id);
    if (!node || node.nextCheckId || node.capacityExploration) return;
    found.push(node); inputs(node, state).forEach(visit);
  };
  inputs(target, state).forEach(visit);
  return found.map(reference).sort((a, b) => a.taskId.localeCompare(b.taskId));
}

function definitionCheck(target: TaskRecord, consumer: TaskRecord, state: State, identity: Identity, now: number) {
  const scope = { ...identity, parent: reference(target), target: reference(target), consumer: reference(consumer),
    dependencies: dependencies(target, state),
    gapScopeDigest: hash({ origin: 'definition-contract', target: reference(target), consumer: reference(consumer) }) };
  const check = { action: 'construction-check' as const, targetTaskId: target.task.id,
    objective: `Test the realizability of the exact definition interface ${target.task.id} before its consumers expand it.\n` +
      `Declaration: ${preview(target.task.theoremName, 100)}; file: ${preview(target.task.proofPath, 100)}.\n` +
      `Type preview:\n${preview(target.task.type, 500)}\n` +
      `Read the complete exact type in COOPERATION.json tasks[].task for id ${target.task.id}, digest ${taskVersion(target.task)}.\n` +
      `Original consumer: ${consumer.task.id}. Inspect the actual definitions and inferred structures in this pinned environment. ` +
      'Start with one small or boundary instance that can distinguish a valid construction from an impossible interface. ' +
      'Unfold the relevant argument positions and check the required map, norm, measure or algebraic laws as applicable. ' +
      'A type that elaborates need not be inhabited; an existing theorem name does not establish its application. ' +
      'Report a scoped counterexample, an actual small-instance construction, or the precise unresolved condition. ' +
      'Do not solve the full original problem or duplicate an existing investigation.',
    expectedEvidence: 'Retained Lean probe code and its actual result for the critical inference, including exact assumptions ' +
      'and argument bindings. A #check result alone is only name/type evidence. Distinguish refuted, supporting and ' +
      'inconclusive; a failed proof attempt is not a refutation and a special case does not prove the general interface.' };
  const id = hash({ origin: 'definition-contract', scope, check }), taskId = `contract_check_${id.slice(0, 40)}`;
  const task = { id: taskId, kind: 'research' as const, revision: 0, reviewScope: 'feasibility' as const,
    objective: `${check.objective}\nRequired discriminating evidence: ${check.expectedEvidence}\n` +
      `Publish checkOutcome for checkId ${id}; this is advisory and grants no proof acceptance.`,
    dependsOn: [target.task.id, consumer.task.id], consumerGoalIds: [consumer.task.id],
    groupId: taskGroup(target.task), sharing: 'group' as const };
  const record: NextCheckRecord = { origin: 'definition-contract', id, taskId, taskDigest: taskVersion(task),
    check, scope, status: 'pending', createdAt: now };
  return { record, node: { task, status: 'pending' as const, attempts: 0, nextCheckId: id } };
}

/** One independent check for a shared, unproved definition on an active original-goal path.
 * Ordinary proof tasks and isolated exploration do not acquire an extra review or dependency wait. */
export function proposedDefinitionContractChecks(state: State, identity: Identity, now: number) {
  const goals = state.tasks.filter(node => node.task.kind === 'goal' && active(node, state) && !checkedUnconditionally(node));
  const paths = new Map(goals.map(goal => [goal.task.id, originalGoalPath(goal, state)]));
  return state.tasks.flatMap(target => {
    if (!isDefinitionTask(target.task) || !target.task.type?.trim() || !active(target, state) ||
        checkedUnconditionally(target) || target.pendingValidation || target.typePreflight?.status === 'invalid') return [];
    const consumers = goals.filter(goal => paths.get(goal.task.id)!.has(target.task.id) &&
      (taskGroup(goal.task) === taskGroup(target.task) || goal.task.sharing !== 'group'));
    if (!consumers.length) return [];
    const path = new Set(consumers.flatMap(goal => [...paths.get(goal.task.id)!]));
    const direct = state.tasks.filter(node => path.has(node.task.id) && node.task.id !== target.task.id &&
      active(node, state) && !isAdvisoryTask(node.task) && inputs(node, state).includes(target.task.id));
    if (direct.length < 2) return [];
    // A planned independent review already inspecting this exact contract owns the question.
    if (state.tasks.some(node => !node.nextCheckId && isFeasibilityReview(node.task) && active(node, state) &&
        taskGroup(node.task) === taskGroup(target.task) && node.task.dependsOn.includes(target.task.id) &&
        [node.task.ownerId, node.assignment?.workerId].every(id => !id ||
          independentFeasibilityWorker(node, { id, role: 'researcher' }, state.tasks, state.groups)) &&
        (['pending', 'running'].includes(node.status) || node.status === 'completed' &&
          node.researchCompletion?.taskDigest === taskVersion(node.task) &&
          node.researchCompletion.basis.dependencies.some(ref => ref.taskId === target.task.id &&
            ref.taskDigest === taskVersion(target.task))))) return [];
    const existing = state.nextChecks?.find(record => record.origin === 'definition-contract' &&
      currentDefinitionContractCheck(record, state, identity) && record.scope.target.taskId === target.task.id);
    const consumer = consumers.find(node => node.task.id === existing?.scope.consumer.taskId) ??
      consumers.toSorted((a, b) => a.task.id.localeCompare(b.task.id))[0]!;
    return [definitionCheck(target, consumer, state, identity, now)];
  });
}

/** Rebuild the host question from current contracts; no model-supplied evidence can invent this origin. */
export function currentDefinitionContractCheck(record: NextCheckRecord, state: State, identity: Identity): boolean {
  if (record.origin !== 'definition-contract' || record.gapDeliveryId !== undefined || record.status === 'stale') return false;
  const target = state.tasks.find(node => node.task.id === record.scope.target.taskId);
  const consumer = state.tasks.find(node => node.task.id === record.scope.consumer.taskId);
  if (!target || !isDefinitionTask(target.task) || !target.task.type?.trim() ||
      !consumer || consumer.task.kind !== 'goal') return false;
  // Scheduling relevance may disappear without changing the exact contract digests.
  // Retain delivered evidence, but stop unfinished work off the active original-goal path.
  if (record.status === 'pending' && (checkedUnconditionally(target) ||
      !originalGoalPath(consumer, state).has(target.task.id))) return false;
  const expected = definitionCheck(target, consumer, state, identity, record.createdAt);
  const node = state.tasks.find(node => node.task.id === record.taskId);
  return expected.record.id === record.id && expected.record.taskId === record.taskId &&
    expected.record.taskDigest === record.taskDigest && canonicalMathJson(expected.record.scope) === canonicalMathJson(record.scope) &&
    canonicalMathJson(expected.record.check) === canonicalMathJson(record.check) &&
    (!node || node.nextCheckId === record.id && taskVersion(node.task) === record.taskDigest);
}
