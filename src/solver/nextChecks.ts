import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import type { DeliveryRecord } from './deliveries';
import { mathematicalGaps, mathematicalGapVisible, nextCheckExecutionMatchesTask } from './mathematicalGaps';
import type { NextCheck } from './mathematicalGapContract';
import { nextCheckDecisionSchema, type CheckOutcome, type NextCheckDecision, type NextCheckRecord } from './nextCheckContract';
import { isAdvisoryTask, isFeasibilityReview, taskGroup, taskVersion, type CooperativeTask, type TaskAssignment, type TaskRecord, type RouteGroup, type RouteRecord } from './tasks';
import { independentFeasibilityWorker } from './modules/organization';
import { currentDefinitionContractCheck } from './definitionContractChecks';
import type { ProofRoute } from './proofRoutes';
import type { ProofSearchRecord } from './proofSearchRecords';

type Identity = { problemReceiptDigest: string; environmentDigest: string };
type State = { tasks: readonly TaskRecord[]; deliveries?: readonly DeliveryRecord[]; nextChecks?: readonly NextCheckRecord[];
  groups?: readonly RouteRecord[]; proofRoutes?: readonly ProofRoute[];
  proofSearchRecords?: Readonly<Record<string, ProofSearchRecord>> };
type Gap = ReturnType<typeof mathematicalGaps>[number];
const hash = (value: unknown) => mathDigest(canonicalMathJson(value));
const reference = (task: CooperativeTask) => ({ taskId: task.id, taskDigest: taskVersion(task) });

export function nextCheckTarget(gap: Gap, state: State): CooperativeTask | undefined {
  const targetId = gap.nextCheck?.targetTaskId ??
    (gap.nextCheck?.execution?.kind === 'proof-search' ? gap.nextCheck.execution.taskId :
      isAdvisoryTask(gap.scope.source) ? gap.consumer.taskId : gap.scope.source.id);
  const node = state.tasks.find(item => item.task.id === targetId);
  if (!node || node.nextCheckId || node.capacityExploration ||
      taskGroup(node.task) !== taskGroup(gap.scope.source) && node.task.sharing === 'group' ||
      gap.nextCheck && !nextCheckExecutionMatchesTask(gap.nextCheck, node.task)) return;
  return node.task;
}

/** Check host-adopted identity, not a worker-supplied basis or a host/worker path spelling. */
function executionSearchBasis(check: NextCheck, target: CooperativeTask, state: State, identity: Identity,
  requireCheckpointMatch: boolean): string | undefined | null {
  const execution = check.execution;
  if (execution?.kind !== 'proof-search' || !execution.checkpoint && !execution.basis && !execution.node) return;
  const record = state.proofSearchRecords?.[target.id];
  if (!record || record.taskId !== target.id || record.taskDigest !== taskVersion(target) ||
      record.problemReceiptDigest !== identity.problemReceiptDigest || record.environmentDigest !== identity.environmentDigest ||
      execution.basis && execution.basis !== record.basisDigest ||
      requireCheckpointMatch && execution.checkpoint && execution.checkpoint.digest !== record.checkpoint.digest) return null;
  return record.basisDigest;
}

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
function executionInstructions(record: Pick<NextCheckRecord, 'id' | 'check' | 'scope'>): string {
  const execution = record.check.execution;
  if (!execution) return '';
  if (execution.kind === 'application') return '\nCheck this exact closed application in the assigned project (advisory type elaboration only):\n' +
    'theorem-os check-lean --worktree . --file ' + shellQuote(execution.context.file) +
    ' --context ' + shellQuote(execution.context.declaration) + ' --type ' + shellQuote(execution.expectedType) +
    ' --expression ' + shellQuote(execution.expression) + ' --timeout-seconds 60\n' +
    'Retain the diagnostic artifact and remaining inference; elaboration does not prove the target or any erased helper.';
  const requestFile = `.scratch/tmp/next-check-${record.id}.json`;
  return '\nProof-search execution data (advisory; the host does not run commands from this report):\n' +
    canonicalMathJson({ ...execution, context: record.scope.executionContext,
      ...(record.scope.executionBasisDigest ? { requiredBasisDigest: record.scope.executionBasisDigest } : {}) }) + '\n' +
    'Write a request file at ' + requestFile + ' using this template, then fill its tactics array with finite candidates:\n' +
    canonicalMathJson({ branches: [{ ...(execution.node ? { from: execution.node } : {}), tactics: [] }],
      limits: { timeoutMs: 60_000, maxTransitions: 32 } }) + '\n' +
    'For continuation, read the matching worker-local COOPERATION.json.proofSearchRecords[taskId].checkpoint and require the bound basis; ' +
    'set request.resume to that worker-local checkpoint. Host checkpoint paths are not worker paths. A changed basis requires a new scoped check.\n' +
    'theorem-os proof-search --worktree . --file ' + shellQuote(record.scope.executionContext!.file) +
    ' --theorem ' + shellQuote(record.scope.executionContext!.declaration) + ' --request-file ' + shellQuote(requestFile) + '\n' +
    'Retain the valid prefix, stuck goals, tried candidates and checkpoint artifact in checkOutcome.evidenceRefs. ' +
    'A closed candidate must still follow the assigned owner\'s ready/freeze/checker flow; this investigation grants no source ownership or proof acceptance.';
}

function checkTask(record: Pick<NextCheckRecord, 'id' | 'taskId' | 'check' | 'scope'>, gap: Gap): CooperativeTask {
  return { id: record.taskId, kind: 'research', revision: 0, reviewScope: 'feasibility',
    objective: `Investigate one missing inference (${record.check.action}): ${record.check.objective}\n` +
      `Required discriminating evidence: ${record.check.expectedEvidence}\n` +
      `Publish checkOutcome for checkId ${record.id}; inconclusive evidence leaves the inference unknown.` + executionInstructions(record),
    dependsOn: [...new Set([record.scope.parent.taskId, record.scope.target.taskId, record.scope.consumer.taskId])],
    groupId: taskGroup(gap.scope.source), sharing: 'group' };
}

/** The same scoped question is scheduled once, even if its author republishes the same gap. */
export function proposedNextChecks(state: State, identity: Identity, now: number) {
  return mathematicalGaps(state, identity).flatMap(gap => {
    if (gap.scopeStatus !== 'current-contracts' || !gap.nextCheck) return [];
    const target = nextCheckTarget(gap, state);
    if (!target) return [];
    const executionBasisDigest = executionSearchBasis(gap.nextCheck, target, state, identity, true);
    if (executionBasisDigest === null) return [];
    const delivery = state.deliveries?.find(item => item.id === gap.deliveryId);
    const scope = { ...identity, parent: reference(gap.scope.source), target: reference(target),
      consumer: reference(gap.scope.consumer), dependencies: gap.scope.dependencies,
      gapScopeDigest: hash(gap.scope), ...(gap.commit ? { sourceCommit: gap.commit } : {}),
      ...(delivery?.sourceDigest ? { sourceDigest: delivery.sourceDigest } : {}),
      ...(gap.nextCheck.execution ? { executionContext: { file: target.proofPath!, declaration: target.theoremName! } } : {}),
      ...(executionBasisDigest ? { executionBasisDigest } : {}) };
    // Notes-only commits do not create another investigation of identical mathematical inputs.
    const execution = gap.nextCheck.execution;
    const check = execution?.kind === 'proof-search' && execution.checkpoint
      ? { ...gap.nextCheck, execution: { ...execution, checkpoint: { digest: execution.checkpoint.digest } } } : gap.nextCheck;
    const id = hash({ check, scope: { ...scope, sourceCommit: undefined }, remaining: gap.remaining });
    const taskId = `gap_check_${id.slice(0, 40)}`;
    const task = checkTask({ id, taskId, check: gap.nextCheck, scope }, gap);
    const record: NextCheckRecord = { id, gapDeliveryId: gap.deliveryId, taskId, taskDigest: taskVersion(task),
      check: gap.nextCheck, scope, status: 'pending', createdAt: now };
    return [{ record, node: { task, status: 'pending' as const, attempts: 0, nextCheckId: id } }];
  });
}

/** Contract matching never upgrades an advisory result to a proved premise. */
export function currentNextCheck(record: NextCheckRecord, state: State, identity: Identity): boolean {
  if (record.origin === 'definition-contract') return currentDefinitionContractCheck(record, state, identity);
  if (record.status === 'stale' || record.scope.problemReceiptDigest !== identity.problemReceiptDigest ||
      record.scope.environmentDigest !== identity.environmentDigest) return false;
  const nodes = new Map(state.tasks.map(node => [node.task.id, node]));
  const refs = [record.scope.parent, record.scope.target, record.scope.consumer, ...record.scope.dependencies];
  if (refs.some(ref => !nodes.has(ref.taskId) || taskVersion(nodes.get(ref.taskId)!.task) !== ref.taskDigest)) return false;
  const target = nodes.get(record.scope.target.taskId)!.task;
  if (!nextCheckExecutionMatchesTask(record.check, target)) return false;
  if (record.check.execution) {
    if (!record.scope.executionContext || record.scope.executionContext.file !== target.proofPath ||
        record.scope.executionContext.declaration !== target.theoremName) return false;
    const basis = executionSearchBasis(record.check, target, state, identity, false);
    if (basis === null || basis !== record.scope.executionBasisDigest) return false;
  } else if (record.scope.executionContext || record.scope.executionBasisDigest) return false;
  const gap = state.deliveries?.find(delivery => delivery.id === record.gapDeliveryId);
  return Boolean(gap && gap.status !== 'superseded' && gap.mathematicalGap?.nextCheck && gap.mathematicalGapScope &&
    gap.mathematicalGapScope.problemReceiptDigest === identity.problemReceiptDigest &&
    hash(gap.mathematicalGapScope) === record.scope.gapScopeDigest &&
    (!record.check.execution || record.scope.sourceCommit === gap.commit && record.scope.sourceDigest === gap.sourceDigest) &&
    canonicalMathJson(gap.mathematicalGap.nextCheck) === canonicalMathJson(record.check) &&
    (!nodes.has(record.taskId) || nodes.get(record.taskId)!.nextCheckId === record.id &&
      taskVersion(nodes.get(record.taskId)!.task) === record.taskDigest));
}

export function bindCheckOutcome(outcome: CheckOutcome, source: CooperativeTask, assignment: TaskAssignment,
  state: State, identity: Identity) {
  const record = state.nextChecks?.find(item => item.id === outcome.checkId);
  if (!record || record.status !== 'pending' || !currentNextCheck(record, state, identity) ||
      record.taskId !== source.id || record.taskDigest !== taskVersion(source) ||
      assignment.taskId !== record.taskId || assignment.taskDigest !== record.taskDigest)
    throw new Error('math_delivery_invalid:check_outcome_scope');
  return record.scope;
}

export function visibleNextChecks(state: State, viewer?: CooperativeTask) {
  return (state.nextChecks ?? []).filter(record => {
    const gap = state.deliveries?.find(item => item.id === record.gapDeliveryId);
    if (record.origin !== 'definition-contract' && (!gap || !mathematicalGapVisible(gap, state, viewer))) return false;
    const tasks = [record.scope.parent, record.scope.target, record.scope.consumer].map(ref =>
      state.tasks.find(node => node.task.id === ref.taskId)?.task);
    return !viewer || tasks.every(task => task && (taskGroup(task) === taskGroup(viewer) || task.sharing !== 'group'));
  });
}

export function parseNextCheckDecisions(value: unknown): NextCheckDecision[] | undefined {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'nextCheckDecisions')) return;
  const input = (value as { nextCheckDecisions: unknown }).nextCheckDecisions;
  const errorCode = 'math_plan_next_check_decisions_invalid';
  if (!Array.isArray(input) || input.length > 32) throw new Error(errorCode + ': nextCheckDecisions must be an array of at most 32 decisions');
  const decisions = input.map((item, index) => {
    const parsed = nextCheckDecisionSchema.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const field = `nextCheckDecisions[${index}]` + issue.path.map(key => '.' + String(key)).join('');
      throw new Error(`${errorCode}: ${field}: ${issue.message}`);
    }
    return parsed.data;
  });
  if (new Set(decisions.map(item => item.checkId)).size !== decisions.length)
    throw new Error(errorCode + ': each checkId must appear once in nextCheckDecisions');
  return decisions;
}

const argument = (task?: CooperativeTask) => task && ({ kind: task.kind, proofPath: task.proofPath,
  theoremName: task.theoremName, type: task.type, dependsOn: [...task.dependsOn].sort(), premises: task.premises,
  conditional: task.conditional, declaration: task.declaration });

/** Rebuttal evidence must come from another current host-bound check of the same mathematical target. */
function hasCurrentCounterEvidence(record: NextCheckRecord, deliveryId: string | undefined, state: State, identity: Identity): boolean {
  if (!deliveryId || deliveryId === record.outcome?.deliveryId) return false;
  const original = state.deliveries?.find(delivery => delivery.id === record.outcome?.deliveryId);
  const delivery = state.deliveries?.find(item => item.id === deliveryId);
  const other = state.nextChecks?.find(item => item.id !== record.id && item.outcome?.deliveryId === deliveryId);
  return Boolean(original && delivery && other && ['awaiting-decision', 'decided'].includes(other.status) &&
    currentNextCheck(other, state, identity) && canonicalMathJson(other.scope.target) === canonicalMathJson(record.scope.target) &&
    canonicalMathJson(other.scope.consumer) === canonicalMathJson(record.scope.consumer) &&
    other.outcome?.conclusion === 'supporting' && delivery.kind === 'research' && delivery.status === 'advisory' &&
    delivery.taskId === other.taskId && delivery.taskDigest === other.taskDigest && delivery.createdAt >= original.createdAt &&
    delivery.checkOutcome?.checkId === other.id && delivery.checkOutcome.conclusion === 'supporting' &&
    delivery.checkOutcome.evidenceRefs.some(reference => reference.trim()) &&
    canonicalMathJson(delivery.checkOutcomeScope) === canonicalMathJson(other.scope) &&
    canonicalMathJson({ ...other.outcome, deliveryId: undefined, commit: undefined }) === canonicalMathJson(delivery.checkOutcome));
}

/** A concrete new independent check can reconsider the inference without pretending to repair its proof. */
function hasFreshFeasibilityRevision(record: NextCheckRecord, state: State,
  plan: { tasks: readonly CooperativeTask[]; groups: readonly RouteGroup[] }): boolean {
  const previous = new Map(state.tasks.map(node => [node.task.id, node]));
  const proposed = plan.tasks.map(task => ({ ...(previous.get(task.id) ?? { status: 'pending' as const, attempts: 0 }), task }));
  const groups = plan.groups.map(group => ({ group, turns: 0 }));
  const eligible = (task: CooperativeTask, tasks: readonly TaskRecord[], candidateGroups: typeof groups) => {
    const existing = previous.get(task.id);
    if (task.id === record.taskId || existing?.nextCheckId || existing?.capacityExploration || !isFeasibilityReview(task) ||
        (task.status ?? 'active') !== 'active' || !task.dependsOn.includes(record.scope.target.taskId) ||
        !candidateGroups.some(route => route.group.id === taskGroup(task) && (route.group.status ?? 'active') === 'active')) return false;
    return !task.ownerId || independentFeasibilityWorker({ task, status: 'pending', attempts: 0 },
      { id: task.ownerId, role: 'researcher' }, tasks, candidateGroups);
  };
  return plan.tasks.some(task => {
    if (!eligible(task, proposed, groups)) return false;
    const old = previous.get(task.id)?.task;
    // The scope or activation changes; relabeling an existing check cannot answer the same outcome twice.
    return !old || !eligible(old, state.tasks, groups) || canonicalMathJson(argument(task)) !== canonicalMathJson(argument(old));
  });
}

/** Validate before any archive mutation. A route decision consumes one exact scoped outcome. */
export function prepareNextCheckDecisions(state: State & { proofRoutes?: readonly ProofRoute[] }, identity: Identity,
  plan: { tasks: CooperativeTask[]; groups: readonly RouteGroup[]; proofRoutes?: readonly ProofRoute[] },
  decisions: readonly NextCheckDecision[] = [], presented: readonly { checkId: string; outcomeDeliveryId: string }[] = []) {
  const pending = (state.nextChecks ?? []).filter(record => record.status === 'awaiting-decision' && currentNextCheck(record, state, identity));
  const byId = new Map((state.nextChecks ?? []).map(record => [record.id, record]));
  for (const shown of presented) if (pending.some(record => record.id === shown.checkId && record.outcome?.deliveryId === shown.outcomeDeliveryId) &&
      !decisions.some(decision => decision.checkId === shown.checkId && decision.outcomeDeliveryId === shown.outcomeDeliveryId))
    throw new Error('math_plan_next_check_decision_required: ' + shown.checkId);
  const prepared = decisions.map(decision => {
    const record = byId.get(decision.checkId);
    if (record?.decision && canonicalMathJson({ ...record.decision, at: undefined, planVersion: undefined }) === canonicalMathJson(decision))
      return { record, decision, repeated: true };
    if (!record || !pending.includes(record) || record.outcome?.deliveryId !== decision.outcomeDeliveryId)
      throw new Error('math_plan_next_check_outcome_stale: ' + decision.checkId);
    if (decision.action === 'continue' && (record.outcome.conclusion === 'refuted' || decision.counterEvidenceDeliveryId !== undefined) &&
        !hasCurrentCounterEvidence(record, decision.counterEvidenceDeliveryId, state, identity))
      throw new Error('math_plan_next_check_counter_evidence_required: a refuted inference needs another current supporting check ' +
        'of this exact target with retained evidence, or revise the argument, assign a new independent feasibility check, or stop.');
    if (decision.action === 'revise') {
      const ids = new Set([record.scope.target.taskId, record.scope.consumer.taskId]);
      const changed = [...ids].some(id => canonicalMathJson(argument(state.tasks.find(node => node.task.id === id)?.task)) !==
        canonicalMathJson(argument(plan.tasks.find(task => task.id === id))));
      const routes = (items: readonly ProofRoute[] = []) => items.filter(route => ids.has(route.targetTaskId))
        .map(({ targetTaskId, closingTaskId, prerequisiteTaskIds }) => ({ targetTaskId, closingTaskId,
          prerequisiteTaskIds: [...prerequisiteTaskIds].sort() })).sort((a, b) => canonicalMathJson(a).localeCompare(canonicalMathJson(b)));
      if (!changed && canonicalMathJson(routes(state.proofRoutes)) === canonicalMathJson(routes(plan.proofRoutes)) &&
          !hasFreshFeasibilityRevision(record, state, plan))
        throw new Error('math_plan_next_check_revision_required: change the target argument, dependencies or route, ' +
          'or assign a new active independent feasibility check of the target.');
    }
    if (decision.action === 'stop') {
      const index = plan.tasks.findIndex(task => task.id === record.scope.target.taskId);
      if (index >= 0) plan.tasks[index] = { ...plan.tasks[index]!, status: 'paused' };
    }
    return { record, decision, repeated: false };
  });
  return prepared;
}

/** Bounded mandatory context; exact records and retained outcomes remain in COOPERATION.json. */
export function nextCheckContextText(records: readonly NextCheckRecord[], taskId?: string) {
  const selected = records.filter(record => taskId ? record.taskId === taskId || record.scope.target.taskId === taskId ||
    record.scope.consumer.taskId === taskId : record.status === 'awaiting-decision').slice(-8);
  return selected.length ? 'Scoped next checks (advisory, never proof acceptance). Read complete records in COOPERATION.json.nextChecks:\n' +
    JSON.stringify(selected.map(record => ({ id: record.id, origin: record.origin,
      gapDeliveryId: record.gapDeliveryId, taskId: record.taskId,
      target: record.scope.target, consumer: record.scope.consumer, status: record.status,
      executionContext: record.scope.executionContext, executionBasisDigest: record.scope.executionBasisDigest,
      check: { ...record.check, objective: record.check.objective.slice(0, 800), expectedEvidence: record.check.expectedEvidence.slice(0, 800),
        ...(record.check.execution && Buffer.byteLength(JSON.stringify(record.check.execution)) > 2000
          ? { execution: { kind: record.check.execution.kind, complete: false,
            preview: JSON.stringify(record.check.execution).slice(0, 800),
            read: { file: 'COOPERATION.json', collection: 'nextChecks', checkId: record.id } } } : {}) },
      outcome: record.outcome && { ...record.outcome, summary: record.outcome.summary.slice(0, 800),
        evidenceRefs: record.outcome.evidenceRefs.slice(0, 4).map(ref => ref.slice(0, 256)) },
      decision: record.decision && { ...record.decision, reason: record.decision.reason.slice(0, 800) } }))) : '';
}
