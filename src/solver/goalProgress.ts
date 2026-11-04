import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import type { ObligationSnapshot } from './obligationProgress';
import type { ProofRoute } from './proofRoutes';
import { taskGroup, type CooperativeTask, type RouteRecord, type TaskRecord } from './tasks';

/** A review interval of started worker execution, never a deadline for a proof. */
export const GOAL_PROGRESS_REVIEW_MS = 30 * 60_000;
export type GoalProgressDecision = { id: string; reason: string };
export type GoalProgressState = {
  schema: 'theoremos.goal-progress.v1'; problemReceiptDigest: string; sequence: number;
  goals: { key: string; proofPath: string; theoremName: string; taskId?: string; activeMs: number;
    observedAt: number; active: boolean; seenEvidence: string[]; lastProgressAt?: number; closed: boolean }[];
  pending?: { id: string; at: number; goalKeys: string[]; goalIds: string[]; retryAt?: number };
  decisions?: { id: string; at: number; reason: string; goalKeys: string[] }[];
};
const hash = (value: unknown) => mathDigest(canonicalMathJson(value));
const contract = (task: CooperativeTask | undefined) => task && ({ proofPath: task.proofPath,
  type: task.type?.trim(), premises: task.premises,
  declaration: task.declaration, conditional: task.conditional, family: task.family });

/** A restart has no running workers. Saved wall time must never count as execution. */
export function resetGoalProgressClock(state: GoalProgressState | undefined, now = Date.now()) {
  for (const goal of state?.goals ?? []) { goal.observedAt = now; goal.active = false; }
}

/**
 * Observe each frozen goal's own path. Scheduling, notes, revisions, receipt replay and unrelated proofs
 * do not restart its clock. These are recorded mathematical inputs, never a new proof acceptance.
 */
export function observeGoalProgress(previous: GoalProgressState | undefined, input: {
  problemReceiptDigest: string; targets: readonly { proofPath: string; theoremName: string }[];
  tasks: readonly TaskRecord[]; snapshot: ObligationSnapshot; proofRoutes?: readonly ProofRoute[]; groups?: readonly RouteRecord[];
  activeTaskIds: ReadonlySet<string>; now?: number; intervalMs?: number;
}) {
  const now = input.now ?? Date.now(), interval = input.intervalMs ?? GOAL_PROGRESS_REVIEW_MS;
  const state: GoalProgressState = previous && previous.problemReceiptDigest === input.problemReceiptDigest ? previous : {
    schema: 'theoremos.goal-progress.v1', problemReceiptDigest: input.problemReceiptDigest, sequence: 0, goals: [] };
  const nodes = new Map(input.tasks.filter(node => !node.capacityExploration).map(node => [node.task.id, node]));
  const obligations = new Map(input.snapshot.obligations.map(item => [item.taskId, item]));
  const resumed: string[] = [];
  const goals = input.targets.map(target => {
    const key = hash(target), old = state.goals.find(goal => goal.key === key);
    const node = input.tasks.find(node => node.task.kind === 'goal' && node.task.proofPath === target.proofPath &&
      node.task.theoremName === target.theoremName);
    const path = new Set<string>();
    const visit = (id: string) => {
      if (path.has(id)) return; path.add(id);
      nodes.get(id)?.task.dependsOn.forEach(visit);
      for (const route of input.proofRoutes ?? []) if (route.targetTaskId === id)
        [route.closingTaskId, ...route.prerequisiteTaskIds].forEach(visit);
    };
    if (node) visit(node.task.id);
    const evidence = [...path].flatMap(id => {
      const obligation = obligations.get(id), proofNode = nodes.get(id), proof = proofNode?.integratedCheck ?? proofNode?.proof;
      if (!proofNode || !proof || !['checked', 'conditional'].includes(obligation?.recordedProof ?? '')) return [];
      // Task IDs, objectives and revision counters can change while the same mathematics is replayed.
      return [hash({ contract: contract(proofNode.task), checked: obligation!.recordedProof,
        conditions: (proof.conditions ?? []).map(item => contract(nodes.get(item.taskId)?.task) ?? item.taskDigest)
          .map(value => canonicalMathJson(value)).sort(),
        ...(proof.references ? { scope: proof.references.scope,
          inputs: proof.references.inputs.filter(value => value.file !== proof.references!.root.file ||
            value.name !== proof.references!.root.name).map(value => canonicalMathJson(value)).sort() } : {}) })];
    });
    const goal = old ?? { key, ...target, activeMs: 0, observedAt: now, active: false, seenEvidence: [], closed: false };
    if (goal.active) goal.activeMs += Math.max(0, now - goal.observedAt);
    const newEvidence = evidence.filter(item => !goal.seenEvidence.includes(item));
    if (old && newEvidence.length) { goal.activeMs = 0; goal.lastProgressAt = now; if (node) resumed.push(node.task.id); }
    goal.seenEvidence = [...new Set([...goal.seenEvidence, ...evidence])];
    goal.closed = Boolean(node && obligations.get(node.task.id)?.closed);
    goal.taskId = node?.task.id;
    goal.active = !goal.closed && Boolean(node && (node.task.status ?? 'active') === 'active' &&
      (input.groups?.find(group => group.group.id === taskGroup(node.task))?.group.status ?? 'active') === 'active') &&
      [...path].some(id => input.activeTaskIds.has(id));
    goal.observedAt = now;
    return goal;
  });
  state.goals = goals;
  if (state.pending) {
    const stillOwed = goals.filter(goal => state.pending!.goalKeys.includes(goal.key) && !goal.closed && goal.activeMs >= interval);
    if (!stillOwed.length) delete state.pending;
    else { state.pending.goalKeys = stillOwed.map(goal => goal.key); state.pending.goalIds = stillOwed.flatMap(goal => goal.taskId ?? []); }
  }
  const due = goals.filter(goal => goal.active && goal.activeMs >= interval);
  let requested = false;
  if (!state.pending && due.length) {
    state.pending = { id: hash({ problem: input.problemReceiptDigest, sequence: ++state.sequence }), at: now,
      goalKeys: due.map(goal => goal.key), goalIds: due.flatMap(goal => goal.taskId ?? []) };
    requested = true;
  }
  const delays = goals.filter(goal => goal.active && !state.pending?.goalKeys.includes(goal.key) &&
    !(state.pending && goal.activeMs >= interval))
    .map(goal => Math.max(1, interval - goal.activeMs));
  return { state, requested, resumed, nextDelayMs: delays.length ? Math.min(...delays) : undefined };
}

/** Only an accepted Lead plan that explicitly answers this presented review may settle it. */
export function answerGoalProgress(state: GoalProgressState, decision: GoalProgressDecision, now = Date.now()) {
  const pending = state.pending;
  if (!pending || pending.id !== decision.id) return false;
  state.decisions = [...state.decisions ?? [], { ...decision, at: now, goalKeys: pending.goalKeys }].slice(-16);
  for (const goal of state.goals) if (pending.goalKeys.includes(goal.key)) {
    goal.activeMs = 0; goal.observedAt = now;
  }
  delete state.pending;
  return true;
}

export function parseGoalProgressDecision(value: unknown): GoalProgressDecision | undefined {
  if (!value || typeof value !== 'object' || !('progressReview' in value)) return;
  const decision = (value as { progressReview: unknown }).progressReview;
  if (!decision || typeof decision !== 'object' || Array.isArray(decision) ||
      typeof (decision as GoalProgressDecision).id !== 'string' || !(decision as GoalProgressDecision).id.trim() ||
      typeof (decision as GoalProgressDecision).reason !== 'string' || !(decision as GoalProgressDecision).reason.trim() ||
      (decision as GoalProgressDecision).reason.length > 2000)
    throw new Error('math_plan_progress_review_invalid: use progressReview:{id:"REVIEW_ID",reason:"decision, evidence and next check"}.');
  return { id: (decision as GoalProgressDecision).id, reason: (decision as GoalProgressDecision).reason.trim() };
}
