import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import type { DeliveryRecord } from './deliveries';
import { plannedTaskDependencyIds } from './modules/search';
import { isAdvisoryTask, taskGroup, taskReferenceDependencies, taskVersion, type CooperativeTask, type TaskRecord } from './tasks';
import type { MathematicalGap, NextCheck } from './mathematicalGapContract';
export { mathematicalGapSchema, type MathematicalGap } from './mathematicalGapContract';
export type MathematicalGapScope = Readonly<{
  problemReceiptDigest: string; environmentDigest: string;
  source: CooperativeTask; consumer: CooperativeTask;
  dependencies: DeliveryRecord['dependencies'];
}>;
type GapState = { tasks: readonly TaskRecord[]; deliveries?: readonly DeliveryRecord[] };

/** An executable check names an existing declaration; it cannot manufacture a theorem from goal text. */
export function nextCheckExecutionMatchesTask(check: NextCheck, target: CooperativeTask): boolean {
  const execution = check.execution;
  if (!execution) return true;
  if ((check.targetTaskId && check.targetTaskId !== target.id) || !target.proofPath || !target.theoremName || isAdvisoryTask(target)) return false;
  return execution.kind === 'application'
    ? execution.context.file === target.proofPath && execution.context.declaration === target.theoremName
    : execution.taskId === target.id && execution.taskDigest === taskVersion(target) && target.kind === 'lemma' &&
      target.declaration !== 'definition' && !target.conditional && Boolean(target.type?.trim());
}

/** A public source does not publish a private consumer's contract or an executable target's inputs. */
export function mathematicalGapVisible(delivery: DeliveryRecord, state: GapState, viewer?: CooperativeTask): boolean {
  if (!delivery.mathematicalGap && !delivery.mathematicalGapScope) return true;
  const scope = delivery.mathematicalGapScope;
  if (!scope || !delivery.mathematicalGap) return false;
  const visible = (task: CooperativeTask) => !viewer || taskGroup(task) === taskGroup(viewer) || task.sharing !== 'group';
  const check = delivery.mathematicalGap.nextCheck;
  if (viewer && check?.execution) {
    const targetId = check.targetTaskId ?? (check.execution.kind === 'proof-search' ? check.execution.taskId :
      isAdvisoryTask(scope.source) ? scope.consumer.id : scope.source.id);
    const target = state.tasks.find(node => node.task.id === targetId)?.task;
    if (!target || !visible(target)) return false;
  }
  return [scope.source, scope.consumer].every(task => visible(task) &&
    state.tasks.filter(node => node.task.id === task.id).every(node => visible(node.task)));
}

export function bindMathematicalGap(gap: MathematicalGap, source: CooperativeTask, state: GapState,
  identity: { problemReceiptDigest: string; environmentDigest: string }): MathematicalGapScope {
  const consumer = state.tasks.find(node => node.task.kind === 'goal' && node.task.id === gap.consumer.taskId &&
    taskVersion(node.task) === gap.consumer.taskDigest)?.task;
  if (!consumer || taskGroup(source) !== taskGroup(consumer) && consumer.sharing === 'group')
    throw new Error('math_delivery_invalid:gap_consumer');
  const check = gap.nextCheck, execution = check?.execution;
  const targetId = check?.targetTaskId ?? (execution?.kind === 'proof-search' ? execution.taskId :
    execution ? isAdvisoryTask(source) ? consumer.id : source.id : undefined);
  if (targetId) {
    const target = state.tasks.find(node => node.task.id === targetId);
    if (!target || target.nextCheckId || target.capacityExploration ||
        taskGroup(source) !== taskGroup(target.task) && target.task.sharing === 'group' ||
        check && !nextCheckExecutionMatchesTask(check, target.task))
      throw new Error('math_delivery_invalid:gap_next_check_target');
  }
  if (gap.previousDeliveryId) {
    const prior = state.deliveries?.find(item => item.id === gap.previousDeliveryId);
    if (!prior?.mathematicalGapScope || prior.mathematicalGapScope.consumer.id !== consumer.id ||
        prior.mathematicalGapScope.problemReceiptDigest !== identity.problemReceiptDigest ||
        !mathematicalGapVisible(prior, state, source))
      throw new Error('math_delivery_invalid:gap_previous');
  }
  const nodes = new Map(state.tasks.map(node => [node.task.id, node]));
  const ids = (node: TaskRecord) => taskReferenceDependencies(node)?.map(reference => reference.taskId) ??
    plannedTaskDependencyIds(node, state.tasks);
  const sourceNode = nodes.get(source.id), visited = new Set([source.id]);
  const pending = [...(sourceNode?.task === source ? ids(sourceNode) : source.dependsOn),
    ...(targetId ? [targetId] : [])].reverse();
  const dependencies: DeliveryRecord['dependencies'] = [];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const input = nodes.get(id);
    if (!input) throw new Error('math_delivery_invalid:gap_dependency');
    dependencies.push({ taskId: id, taskDigest: taskVersion(input.task) });
    pending.push(...[...ids(input)].reverse());
  }
  return { ...identity, source: structuredClone(source), consumer: structuredClone(consumer), dependencies };
}

/** Retain immutable evidence across revisions; changed inputs make it history, never a current result. */
export function mathematicalGaps(state: GapState, identity: { problemReceiptDigest: string; environmentDigest: string },
  viewer?: CooperativeTask) {
  const nodes = new Map(state.tasks.map(node => [node.task.id, node.task]));
  return (state.deliveries ?? []).flatMap(delivery => {
    const gap = delivery.mathematicalGap, scope = delivery.mathematicalGapScope;
    if (!gap || !scope || !mathematicalGapVisible(delivery, state, viewer) ||
        scope.problemReceiptDigest !== identity.problemReceiptDigest ||
        delivery.taskDigest !== taskVersion(scope.source) || gap.consumer.taskDigest !== taskVersion(scope.consumer)) return [];
    const current = scope.environmentDigest === identity.environmentDigest && delivery.status !== 'superseded' &&
      [scope.source, scope.consumer].every(task => nodes.has(task.id) && taskVersion(nodes.get(task.id)!) === taskVersion(task)) &&
      scope.dependencies.every(input => nodes.has(input.taskId) && taskVersion(nodes.get(input.taskId)!) === input.taskDigest);
    return [{ deliveryId: delivery.id, ...gap, scope, scopeStatus: current ? 'current-contracts' as const : 'historical-scope' as const,
      evidence: 'model-reported-advisory' as const, evidenceRefs: delivery.evidenceRefs,
      findingDigest: delivery.findingDigest, commit: delivery.commit, createdAt: delivery.createdAt }];
  });
}

export const MATHEMATICAL_GAP_ENTRY_MAX_BYTES = 8 * 1024;
export const MATHEMATICAL_GAP_CONTEXT_MAX_BYTES = 32 * 1024;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function preview(value: string, maxBytes: number) {
  if (jsonBytes(value) <= maxBytes) return value;
  let lower = 0, upper = Math.min(value.length, maxBytes), end = 0;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (jsonBytes(value.slice(0, middle)) <= maxBytes) { end = middle; lower = middle + 1; }
    else upper = middle - 1;
  }
  if (end && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
  return { preview: value.slice(0, end), complete: false as const, bytes: Buffer.byteLength(value),
    sha256: mathDigest(value) };
}
function gapEntry(item: ReturnType<typeof mathematicalGaps>[number], textBytes: number) {
  const { scope } = item;
  const descriptions = { previousGap: preview(item.previousGap, textBytes), reduced: preview(item.reduced, textBytes),
    remaining: preview(item.remaining, textBytes), evidenceScope: preview(item.evidenceScope, textBytes) };
  const reconsiderWhen = item.reconsiderWhen.slice(0, 4).map(value => preview(value, 256));
  const evidenceRefs = item.evidenceRefs.slice(0, 4).map(value => preview(value, 256));
  const dependencies = scope.dependencies.slice(0, 4);
  const execution = item.nextCheck?.execution;
  const executionPreview = execution?.kind === 'application' ? { ...execution,
    expression: preview(execution.expression, textBytes), expectedType: preview(execution.expectedType, textBytes),
    context: { file: preview(execution.context.file, 256), declaration: preview(execution.context.declaration, 256) } } :
    execution && { ...execution, ...(execution.checkpoint ? { checkpoint: { ...execution.checkpoint,
      path: preview(execution.checkpoint.path, 256) } } : {}) };
  const nextCheck = item.nextCheck && { ...item.nextCheck,
    objective: preview(item.nextCheck.objective, textBytes), expectedEvidence: preview(item.nextCheck.expectedEvidence, textBytes),
    ...(executionPreview ? { execution: executionPreview } : {}) };
  const executionComplete = !executionPreview || (executionPreview.kind === 'application'
    ? typeof executionPreview.expression === 'string' && typeof executionPreview.expectedType === 'string' &&
      Object.values(executionPreview.context).every(value => typeof value === 'string')
    : !executionPreview.checkpoint || typeof executionPreview.checkpoint.path === 'string');
  const checkComplete = !nextCheck || typeof nextCheck.objective === 'string' && typeof nextCheck.expectedEvidence === 'string' && executionComplete;
  const complete = Object.values(descriptions).every(value => typeof value === 'string') &&
    reconsiderWhen.every(value => typeof value === 'string') && item.reconsiderWhen.length === reconsiderWhen.length &&
    evidenceRefs.every(value => typeof value === 'string') && item.evidenceRefs.length === evidenceRefs.length &&
    scope.dependencies.length === dependencies.length && checkComplete;
  return { deliveryId: item.deliveryId, consumer: item.consumer, previousDeliveryId: item.previousDeliveryId,
    ...(nextCheck ? { nextCheck } : {}),
    ...descriptions, reconsiderWhen, evidenceRefs, dependencies, complete,
    omittedRetryConditions: item.reconsiderWhen.length - reconsiderWhen.length,
    omittedEvidenceRefs: item.evidenceRefs.length - evidenceRefs.length,
    omittedDependencies: scope.dependencies.length - dependencies.length,
    evidenceRefsDigest: mathDigest(canonicalMathJson(item.evidenceRefs)),
    dependenciesDigest: mathDigest(canonicalMathJson(scope.dependencies)),
    scopeStatus: item.scopeStatus, evidence: item.evidence, findingDigest: item.findingDigest,
    commit: item.commit, createdAt: item.createdAt, scopeDigest: mathDigest(canonicalMathJson(scope)),
    source: { taskId: scope.source.id, taskDigest: taskVersion(scope.source) }, environmentDigest: scope.environmentDigest,
    read: { file: 'COOPERATION.json', collection: 'mathematicalGaps', deliveryId: item.deliveryId } };
}

/** Keep the latest gap per original and route in mandatory context, with full immutable retrieval handles. */
export function mathematicalGapContext(entries: ReturnType<typeof mathematicalGaps>) {
  const latest = new Map<string, (typeof entries)[number]>();
  for (const item of entries) latest.set(canonicalMathJson([item.consumer.taskId, taskGroup(item.scope.source)]), item);
  const selected = [...latest.values()].sort((a, b) => b.createdAt - a.createdAt || a.deliveryId.localeCompare(b.deliveryId)).slice(0, 8);
  const shown: ReturnType<typeof gapEntry>[] = [];
  const packet = (items: typeof shown) => ({ total: entries.length, shown: items.length,
    complete: latest.size === items.length && items.every(item => item.complete), omittedRoutes: latest.size - items.length,
    omittedForBudget: selected.length - items.length, maxBytes: MATHEMATICAL_GAP_CONTEXT_MAX_BYTES, entries: items });
  for (const item of selected) {
    let display = gapEntry(item, 1024);
    if (jsonBytes(display) > MATHEMATICAL_GAP_ENTRY_MAX_BYTES) display = gapEntry(item, 512);
    if (jsonBytes(display) <= MATHEMATICAL_GAP_ENTRY_MAX_BYTES &&
        jsonBytes(packet([...shown, display])) <= MATHEMATICAL_GAP_CONTEXT_MAX_BYTES) shown.push(display);
  }
  return packet(shown);
}

/** Full and same-thread dispatches carry the same bounded gap evidence, not just its retrieval ids. */
export function mathematicalGapContextText(entries: ReturnType<typeof mathematicalGaps>) {
  return entries.length ? 'Persistent mathematical gaps (advisory; historical-scope reports require review of changed inputs; ' +
    'complete records remain in COOPERATION.json):\n' + JSON.stringify(mathematicalGapContext(entries)) : '';
}
