import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import type { ObligationSnapshot } from './obligationProgress';
import type { ProofRoute } from './proofRoutes';
import { isAdvisoryTask, taskGroup, taskProofContractVersion, taskVersion,
  type CooperativeTask, type RouteGroup, type RouteRecord, type TaskRecord } from './tasks';
import { nextCheckSchema, type NextCheck } from './mathematicalGapContract';
import { nextCheckExecutionMatchesTask } from './mathematicalGaps';
import type { NextCheckRecord } from './nextCheckContract';
import { z } from 'zod';

/** A review interval of started worker execution, never a deadline for a proof. */
export const GOAL_PROGRESS_REVIEW_MS = 30 * 60_000;
export type GoalProgressNextCheck = NextCheck & { targetTaskId: string; taskDigest?: string };
export type GoalProgressDecision = { id: string; reason: string; nextChecks: GoalProgressNextCheck[] };
export type GoalProgressState = {
  schema: 'theoremos.goal-progress.v1'; problemReceiptDigest: string; sequence: number;
  goals: { key: string; proofPath: string; theoremName: string; taskId?: string; activeMs: number;
    observedAt: number; active: boolean; seenEvidence: string[]; lastProgressAt?: number; closed: boolean;
    /** Active effort since an already observed frontier obligation closed unconditionally. */
    coreActiveMs?: number; coreSeenEvidence?: string[]; lastCoreProgressAt?: number; lastReviewedCoreMs?: number;
    coreFrontier?: { taskId: string; taskDigest: string; contractDigest: string }[] }[];
  pending?: { id: string; at: number; goalKeys: string[]; goalIds: string[]; retryAt?: number };
  decisions?: { id: string; at: number; reason: string; goalKeys: string[]; nextChecks?: GoalProgressNextCheck[] }[];
};
const savedCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Optional additions preserve checkpoints written before core tracking and executable reviews. */
export const goalProgressStateSchema = z.object({
  schema: z.literal('theoremos.goal-progress.v1'), problemReceiptDigest: z.string(), sequence: savedCount,
  goals: z.array(z.object({ key: z.string(), proofPath: z.string(), theoremName: z.string(), taskId: z.string().optional(),
    activeMs: savedCount, observedAt: savedCount, active: z.boolean(), seenEvidence: z.array(z.string()),
    lastProgressAt: savedCount.optional(), closed: z.boolean(), coreActiveMs: savedCount.optional(),
    coreSeenEvidence: z.array(z.string()).optional(), lastCoreProgressAt: savedCount.optional(), lastReviewedCoreMs: savedCount.optional(),
    coreFrontier: z.array(z.object({ taskId: z.string(), taskDigest: z.string(), contractDigest: z.string() })).optional() })),
  pending: z.object({ id: z.string(), at: savedCount, goalKeys: z.array(z.string()), goalIds: z.array(z.string()),
    retryAt: savedCount.optional() }).optional(),
  decisions: z.array(z.object({ id: z.string(), at: savedCount, reason: z.string().min(1).max(2000), goalKeys: z.array(z.string()),
    nextChecks: z.array(nextCheckSchema.required({ targetTaskId: true }).extend({ taskDigest: z.string().optional() }))
      .min(1).max(32).optional() })).max(16).optional(),
}).transform((value): GoalProgressState => value as GoalProgressState);
const hash = (value: unknown) => mathDigest(canonicalMathJson(value));
const contract = (task: CooperativeTask | undefined) => task && ({ proofPath: task.proofPath,
  type: task.type?.trim(), premises: task.premises,
  declaration: task.declaration, conditional: task.conditional, family: task.family });

function goalPath(id: string, tasks: ReadonlyMap<string, CooperativeTask>, routes: readonly ProofRoute[] = []) {
  const path = new Set<string>();
  const visit = (id: string) => {
    if (path.has(id)) return; path.add(id);
    tasks.get(id)?.dependsOn.forEach(visit);
    for (const route of routes) if (route.targetTaskId === id)
      [route.closingTaskId, ...route.prerequisiteTaskIds].forEach(visit);
  };
  visit(id);
  return path;
}

/** Host checks already carry a scoped consumer; ordinary advisory tasks name their original goals. */
function researchServesGoal(task: CooperativeTask, goalId: string, path: ReadonlySet<string>, checks: readonly NextCheckRecord[]) {
  return isAdvisoryTask(task) && (task.consumerGoalIds?.includes(goalId) || checks.some(record =>
    record.status === 'pending' && record.taskId === task.id && record.taskDigest === taskVersion(task) &&
    path.has(record.scope.consumer.taskId)));
}

const reviewElapsed = (goal: GoalProgressState['goals'][number]) => Math.max(goal.activeMs,
  (goal.coreActiveMs ?? 0) - (goal.lastReviewedCoreMs ?? 0));

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
  /** Current scoped host checks, filtered by the cooperation host before observation. */
  nextChecks?: readonly NextCheckRecord[];
  activeTaskIds: ReadonlySet<string>; now?: number; intervalMs?: number;
}) {
  const now = input.now ?? Date.now(), interval = input.intervalMs ?? GOAL_PROGRESS_REVIEW_MS;
  const state: GoalProgressState = previous && previous.problemReceiptDigest === input.problemReceiptDigest ? previous : {
    schema: 'theoremos.goal-progress.v1', problemReceiptDigest: input.problemReceiptDigest, sequence: 0, goals: [] };
  const nodes = new Map(input.tasks.filter(node => !node.capacityExploration).map(node => [node.task.id, node]));
  const tasks = new Map([...nodes].map(([id, node]) => [id, node.task]));
  const obligations = new Map(input.snapshot.obligations.map(item => [item.taskId, item]));
  const resumed: string[] = [];
  const goals = input.targets.map(target => {
    const key = hash(target), old = state.goals.find(goal => goal.key === key);
    const node = input.tasks.find(node => node.task.kind === 'goal' && node.task.proofPath === target.proofPath &&
      node.task.theoremName === target.theoremName);
    const path = node ? goalPath(node.task.id, tasks, input.proofRoutes) : new Set<string>();
    const evidence = [...path].flatMap(id => {
      const obligation = obligations.get(id), proofNode = nodes.get(id), proof = proofNode?.integratedCheck ?? proofNode?.proof;
      if (!proofNode || !proof || !['checked', 'conditional'].includes(obligation?.recordedProof ?? '')) return [];
      // Task IDs, objectives and revision counters can change while the same mathematics is replayed.
      return [hash({ contract: contract(proofNode.task), checked: obligation!.recordedProof,
        conditions: (proof.conditions ?? []).map(item => contract(nodes.get(item.taskId)?.task) ?? item.taskDigest)
          .map(value => canonicalMathJson(value)).sort(),
        ...(proof.references ? { scope: proof.references.scope,
          inputs: proof.references.inputs.filter(value => {
            const root = proof.references!.root;
            // Source regions may store the written short name while Lean exports the qualified root.
            // Renaming that wrapper does not change its mathematical inputs.
            return value.file !== root.file || !value.name ||
              value.name !== root.name && !root.name.endsWith('.' + value.name);
          }).map(value => canonicalMathJson(value)).sort() } : {}) })];
    });
    const goal: GoalProgressState['goals'][number] = old ??
      { key, ...target, activeMs: 0, observedAt: now, active: false, seenEvidence: [], closed: false };
    goal.coreActiveMs ??= 0; goal.coreSeenEvidence ??= []; goal.lastReviewedCoreMs ??= 0;
    if (goal.active) {
      const elapsed = Math.max(0, now - goal.observedAt);
      goal.activeMs += elapsed; goal.coreActiveMs += elapsed;
    }
    const newEvidence = evidence.filter(item => !goal.seenEvidence.includes(item));
    if (old && newEvidence.length) { goal.activeMs = 0; goal.lastProgressAt = now; if (node) resumed.push(node.task.id); }
    goal.seenEvidence = [...new Set([...goal.seenEvidence, ...evidence])];
    // New wrappers and conditional connections remain useful inputs, but cannot settle the old frontier.
    // Match the prior obligation's contract before crediting closure: a weakened or removed task is not progress.
    const coreEvidence = (goal.coreFrontier ?? []).flatMap(previous => {
      const current = nodes.get(previous.taskId), obligation = obligations.get(previous.taskId);
      if (!current || !path.has(previous.taskId) || !obligation?.closed || obligation.recordedProof !== 'checked' ||
          taskProofContractVersion(current.task) !== previous.contractDigest) return [];
      return [hash({ contract: contract(current.task), environmentDigest: input.snapshot.environmentDigest })];
    });
    const newCoreEvidence = coreEvidence.filter(item => !goal.coreSeenEvidence!.includes(item));
    if (newCoreEvidence.length) {
      goal.coreActiveMs = 0; goal.lastReviewedCoreMs = 0; goal.lastCoreProgressAt = now;
    }
    goal.coreSeenEvidence = [...new Set([...goal.coreSeenEvidence, ...coreEvidence])];
    const frontier = input.snapshot.goals.find(item => item.taskId === node?.task.id);
    const frontierIds = new Set([...(frontier?.frontier ?? []), ...(frontier?.alternatives ?? []).flatMap(route => route.frontier)]
      .map(item => item.taskId));
    goal.coreFrontier = [...frontierIds].sort().flatMap(id => {
      const current = nodes.get(id), obligation = obligations.get(id);
      return current && obligation && !obligation.closed ? [{ taskId: id, taskDigest: obligation.taskDigest,
        contractDigest: taskProofContractVersion(current.task) }] : [];
    });
    goal.closed = Boolean(node && obligations.get(node.task.id)?.closed);
    goal.taskId = node?.task.id;
    goal.active = !goal.closed && Boolean(node && (node.task.status ?? 'active') === 'active' &&
      (input.groups?.find(group => group.group.id === taskGroup(node.task))?.group.status ?? 'active') === 'active') &&
      ([...path].some(id => input.activeTaskIds.has(id)) || [...nodes.values()].some(candidate =>
        input.activeTaskIds.has(candidate.task.id) && (candidate.task.status ?? 'active') === 'active' &&
        (input.groups?.find(group => group.group.id === taskGroup(candidate.task))?.group.status ?? 'active') === 'active' &&
        researchServesGoal(candidate.task, node.task.id, path, input.nextChecks ?? [])));
    goal.observedAt = now;
    return goal;
  });
  state.goals = goals;
  if (state.pending) {
    const stillOwed = goals.filter(goal => state.pending!.goalKeys.includes(goal.key) && !goal.closed && reviewElapsed(goal) >= interval);
    if (!stillOwed.length) delete state.pending;
    else { state.pending.goalKeys = stillOwed.map(goal => goal.key); state.pending.goalIds = stillOwed.flatMap(goal => goal.taskId ?? []); }
  }
  const due = goals.filter(goal => goal.active && reviewElapsed(goal) >= interval);
  let requested = false;
  if (!state.pending && due.length) {
    state.pending = { id: hash({ problem: input.problemReceiptDigest, sequence: ++state.sequence }), at: now,
      goalKeys: due.map(goal => goal.key), goalIds: due.flatMap(goal => goal.taskId ?? []) };
    requested = true;
  }
  const delays = goals.filter(goal => goal.active && !state.pending?.goalKeys.includes(goal.key) &&
    !(state.pending && reviewElapsed(goal) >= interval))
    .map(goal => Math.max(1, interval - reviewElapsed(goal)));
  return { state, requested, resumed, nextDelayMs: delays.length ? Math.min(...delays) : undefined };
}

/** Only an accepted Lead plan that explicitly answers this presented review may settle it. */
export function answerGoalProgress(state: GoalProgressState, decision: GoalProgressDecision, now = Date.now()) {
  const pending = state.pending;
  if (!pending || pending.id !== decision.id) return false;
  state.decisions = [...state.decisions ?? [], { ...decision, at: now, goalKeys: pending.goalKeys }].slice(-16);
  for (const goal of state.goals) if (pending.goalKeys.includes(goal.key)) {
    if (goal.active) goal.coreActiveMs = (goal.coreActiveMs ?? 0) + Math.max(0, now - goal.observedAt);
    goal.activeMs = 0; goal.observedAt = now;
    goal.lastReviewedCoreMs = goal.coreActiveMs ?? 0;
  }
  delete state.pending;
  return true;
}

export function parseGoalProgressDecision(value: unknown, restoring = false): GoalProgressDecision | undefined {
  if (!value || typeof value !== 'object' || !('progressReview' in value)) return;
  const decision = (value as { progressReview: unknown }).progressReview;
  if (!decision || typeof decision !== 'object' || Array.isArray(decision) ||
      typeof (decision as GoalProgressDecision).id !== 'string' || !(decision as GoalProgressDecision).id.trim() ||
      typeof (decision as GoalProgressDecision).reason !== 'string' || !(decision as GoalProgressDecision).reason.trim() ||
      (decision as GoalProgressDecision).reason.length > 2000)
    throw new Error('math_plan_progress_review_invalid: provide the presented id, reason and nextChecks.');
  // Historical notes may contain a reason-only response. Loading it supplies no new decision.
  if (restoring && !Object.hasOwn(decision, 'nextChecks')) return;
  const nextChecks = nextCheckSchema.required({ targetTaskId: true }).array().min(1).max(32)
    .safeParse((decision as GoalProgressDecision).nextChecks);
  if (!nextChecks.success)
    throw new Error('math_plan_progress_review_invalid: nextChecks require action, objective, expectedEvidence and targetTaskId.');
  return { id: (decision as GoalProgressDecision).id, reason: (decision as GoalProgressDecision).reason.trim(),
    nextChecks: nextChecks.data.map(check => ({ ...check, targetTaskId: check.targetTaskId })) };
}

/** Bind an accepted plan's next checks to live tasks serving the goals of this review. */
export function prepareGoalProgressDecision(decision: GoalProgressDecision, state: GoalProgressState | undefined,
  plan: { tasks: readonly CooperativeTask[]; groups: readonly RouteGroup[]; proofRoutes?: readonly ProofRoute[] },
  nextChecks: readonly NextCheckRecord[] = [], currentTasks: readonly TaskRecord[] = []): GoalProgressDecision {
  if (!state?.pending || state.pending.id !== decision.id) throw new Error('math_plan_progress_review_stale');
  const tasks = new Map(plan.tasks.map(task => [task.id, task]));
  const goals = state.goals.filter(goal => state.pending!.goalKeys.includes(goal.key)).flatMap(goal => {
    const task = plan.tasks.find(task => task.kind === 'goal' && task.proofPath === goal.proofPath && task.theoremName === goal.theoremName);
    return task ? [{ id: task.id, path: goalPath(task.id, tasks, plan.proofRoutes) }] : [];
  });
  const checks = decision.nextChecks.map(check => {
    const task = tasks.get(check.targetTaskId);
    const previous = currentTasks.find(node => node.task.id === check.targetTaskId);
    if (!task || (task.status ?? 'active') !== 'active' ||
        !nextCheckExecutionMatchesTask(check, task) ||
        previous && ['integrated', 'completed'].includes(previous.status) && taskVersion(previous.task) === taskVersion(task) ||
        (plan.groups.find(group => group.id === taskGroup(task))?.status ?? 'active') !== 'active' ||
        !goals.some(goal => goal.path.has(task.id) || researchServesGoal(task, goal.id, goal.path, nextChecks)))
      throw new Error('math_plan_progress_review_task_unavailable: ' + check.targetTaskId);
    return { ...check, taskDigest: taskVersion(task) };
  });
  if (goals.some(goal => !checks.some(check => goal.path.has(check.targetTaskId) ||
      researchServesGoal(tasks.get(check.targetTaskId)!, goal.id, goal.path, nextChecks))))
    throw new Error('math_plan_progress_review_goal_unanswered');
  return { ...decision, nextChecks: checks };
}

export function goalProgressForTask(state: GoalProgressState | undefined, task: CooperativeTask): GoalProgressState | undefined {
  if (!state) return;
  const decision = [...state.decisions ?? []].reverse().find(item => item.nextChecks?.some(check => check.targetTaskId === task.id));
  const nextChecks = decision?.nextChecks?.filter(check => check.targetTaskId === task.id && check.taskDigest === taskVersion(task));
  const decisions = nextChecks?.length ? [{ ...decision!, nextChecks }] : [];
  return decisions.length ? { schema: state.schema, problemReceiptDigest: state.problemReceiptDigest,
    sequence: state.sequence, goals: [], decisions } : undefined;
}

/** The latest accepted direction for this exact task is mandatory on its next turn, including after restart. */
export function goalProgressTaskContext(state: GoalProgressState | undefined, task: CooperativeTask): string {
  const decision = [...state?.decisions ?? []].reverse().find(item => item.nextChecks?.some(check => check.targetTaskId === task.id));
  const checks = decision?.nextChecks?.filter(check => check.targetTaskId === task.id && check.taskDigest === taskVersion(task));
  return checks?.length ? 'Accepted goal progress review next checks (planning guidance, never mathematical progress or proof acceptance):\n' +
    JSON.stringify({ reviewId: decision!.id, goalKeys: decision!.goalKeys, reason: decision!.reason, nextChecks: checks }) : '';
}
