import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import type { ObligationSnapshot } from './obligationProgress';
import { routeEvidence, type ProofRoute } from './proofRoutes';
import { buildProofContinuation } from './progress';
import { hasTaskAcceptance, isAdvisoryTask, taskGroup, taskProofContractVersion, taskVersion,
  type CooperativeTask, type RouteGroup, type RouteRecord, type TaskRecord } from './tasks';
import { nextCheckSchema, type NextCheck } from './mathematicalGapContract';
import { nextCheckExecutionMatchesTask } from './mathematicalGaps';
import type { NextCheckRecord } from './nextCheckContract';
import { z } from 'zod';
import { invalidPlanField } from './planDiagnostics';

/** A review interval of started worker execution, never a deadline for a proof. */
export const GOAL_PROGRESS_REVIEW_MS = 30 * 60_000;
export const GOAL_PROGRESS_REASON_MAX_LENGTH = 2000;
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
  decisions: z.array(z.object({ id: z.string(), at: savedCount, reason: z.string().min(1).max(GOAL_PROGRESS_REASON_MAX_LENGTH), goalKeys: z.array(z.string()),
    nextChecks: z.array(nextCheckSchema.required({ targetTaskId: true }).extend({ taskDigest: z.string().optional() }))
      .min(1).max(32).optional() })).max(16).optional(),
}).transform((value): GoalProgressState => value as GoalProgressState);
const hash = (value: unknown) => mathDigest(canonicalMathJson(value));
const contract = (task: CooperativeTask | undefined) => task && ({ proofPath: task.proofPath,
  type: task.type?.trim(), premises: task.premises,
  declaration: task.declaration, conditional: task.conditional, family: task.family });

/** Compact checks may omit reference metadata. Only this process's exact acceptance fills that gap. */
function freshlyCheckedWithoutReferences(node: TaskRecord, environmentDigest: string | undefined,
  problemReceiptDigest: string) {
  const proof = node.integratedCheck, digest = taskVersion(node.task);
  if (node.pendingValidation || node.status !== 'integrated' || !proof?.passed || proof.references ||
      proof.taskDigest !== digest || proof.conditions?.length || !hasTaskAcceptance(proof)) return false;
  if (proof.projection && (proof.projection.problemReceiptDigest !== problemReceiptDigest ||
      environmentDigest && proof.projection.environmentDigest !== environmentDigest)) return false;
  const verification = proof.verification;
  return verification.status === 'kernel_verified' && Boolean(verification.targetCommit) &&
    verification.results.length === 1 && verification.results.every(receipt => receipt.status === 'kernel_verified' &&
      receipt.targetCommit === verification.targetCommit && Boolean(receipt.receiptId) &&
      receipt.proofPath === node.task.proofPath && receipt.theoremName === node.task.theoremName &&
      receipt.statementHash === digest && receipt.leanStatementHash === digest && receipt.claim === 'statement');
}

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
  const records = [...nodes.values()], routes = input.proofRoutes ?? records.flatMap(node => node.alternativeRoutes ?? []);
  // Re-read current task receipts instead of replaying a saved goalProgress/frontier label.
  const recorded = routeEvidence(records, input.snapshot.environmentDigest);
  const fresh = new Set(records.filter(node => freshlyCheckedWithoutReferences(node,
    input.snapshot.environmentDigest, input.problemReceiptDigest)).map(node => node.task.id));
  const proofStatus = (id: string) => {
    if (fresh.has(id)) return 'checked';
    const status = recorded.status(id), node = nodes.get(id);
    // Old checkpoints may also omit the environment. That cannot make a restored compact receipt fresh.
    return status === 'checked' && !(node?.integratedCheck ?? node?.proof)?.references ? 'unverified' : status;
  };
  const settlements = new Map<string, boolean>();
  const settled = (id: string): boolean => {
    if (settlements.has(id)) return settlements.get(id)!;
    settlements.set(id, false);
    const node = nodes.get(id);
    const result = Boolean(node && !node.pendingValidation && proofStatus(id) === 'checked' &&
      (fresh.has(id) || recorded.settled(id, false) &&
        (node.integratedCheck?.references?.tasks ?? []).every(input => settled(input.taskId))));
    settlements.set(id, result); return result;
  };
  const closed = new Set(records.filter(node => settled(node.task.id)).map(node => node.task.id));
  const continuation = buildProofContinuation(records.map(node => ({ ...node,
    task: node.task.kind === 'goal' ? { ...node.task, status: 'active' as const } : node.task,
    status: node.status === 'integrated' && !closed.has(node.task.id) ? 'pending' as const : node.status,
  })), { environmentDigest: input.snapshot.environmentDigest, proofRoutes: routes });
  const parents = new Map<string, Set<string>>();
  for (const node of records) for (const id of [...node.task.dependsOn, ...routes.filter(route => route.targetTaskId === node.task.id)
    .flatMap(route => [route.closingTaskId, ...route.prerequisiteTaskIds])]) {
    const owners = parents.get(id) ?? new Set<string>(); owners.add(node.task.id); parents.set(id, owners);
  }
  const resumed: string[] = [];
  const goals = input.targets.map(target => {
    const key = hash(target), old = state.goals.find(goal => goal.key === key);
    const node = input.tasks.find(node => node.task.kind === 'goal' && node.task.proofPath === target.proofPath &&
      node.task.theoremName === target.theoremName);
    const path = node ? goalPath(node.task.id, tasks, routes) : new Set<string>();
    const evidence = [...path].flatMap(id => {
      const proofNode = nodes.get(id), proof = proofNode?.integratedCheck ?? proofNode?.proof;
      if (!proofNode || !proof || !['checked', 'conditional'].includes(proofStatus(id))) return [];
      // Task IDs, objectives and revision counters can change while the same mathematics is replayed.
      return [hash({ contract: contract(proofNode.task), checked: proofStatus(id),
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
      const current = nodes.get(previous.taskId);
      if (!current || !path.has(previous.taskId) || !closed.has(previous.taskId) || proofStatus(previous.taskId) !== 'checked' ||
          taskProofContractVersion(current.task) !== previous.contractDigest) return [];
      return [hash({ contract: contract(current.task), environmentDigest: input.snapshot.environmentDigest })];
    });
    const newCoreEvidence = coreEvidence.filter(item => !goal.coreSeenEvidence!.includes(item));
    if (newCoreEvidence.length) {
      goal.coreActiveMs = 0; goal.lastReviewedCoreMs = 0; goal.lastCoreProgressAt = now;
    }
    goal.coreSeenEvidence = [...new Set([...goal.coreSeenEvidence, ...coreEvidence])];
    const frontier = continuation.goals.find(item => item.taskId === node?.task.id);
    const frontierIds = new Set([...(frontier?.frontier ?? []), ...(frontier?.alternatives ?? []).flatMap(route => route.frontier)]
      .filter(id => !closed.has(id)));
    // An advisory investigation cannot hide the nearest unresolved mathematical consumer.
    const mathematical = new Set<string>(), seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id) || !path.has(id) || closed.has(id)) return; seen.add(id);
      const current = nodes.get(id);
      if (current && !isAdvisoryTask(current.task)) mathematical.add(id);
      else for (const parent of parents.get(id) ?? []) visit(parent);
    };
    frontierIds.forEach(visit);
    goal.coreFrontier = [...mathematical].sort().flatMap(id => {
      const current = nodes.get(id);
      return current ? [{ taskId: id, taskDigest: taskVersion(current.task),
        contractDigest: taskProofContractVersion(current.task) }] : [];
    });
    goal.closed = Boolean(node && closed.has(node.task.id));
    goal.taskId = node?.task.id;
    goal.active = !goal.closed && Boolean(node && (node.task.status ?? 'active') === 'active' &&
      (input.groups?.find(group => group.group.id === taskGroup(node.task))?.group.status ?? 'active') === 'active' &&
      ([...path].some(id => input.activeTaskIds.has(id)) || [...nodes.values()].some(candidate =>
        input.activeTaskIds.has(candidate.task.id) && (candidate.task.status ?? 'active') === 'active' &&
        (input.groups?.find(group => group.group.id === taskGroup(candidate.task))?.group.status ?? 'active') === 'active' &&
        researchServesGoal(candidate.task, node.task.id, path, input.nextChecks ?? []))));
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
      typeof (decision as GoalProgressDecision).reason !== 'string' || !(decision as GoalProgressDecision).reason.trim())
    throw new Error('math_plan_progress_review_invalid: provide the presented id, reason and nextChecks.');
  const reason = (decision as GoalProgressDecision).reason;
  if (reason.length > GOAL_PROGRESS_REASON_MAX_LENGTH)
    throw invalidPlanField('math_plan_progress_review_invalid', 'progressReview.reason',
      'Shorten the reason to at most ' + GOAL_PROGRESS_REASON_MAX_LENGTH + ' characters (received ' + reason.length + ').');
  // Historical notes may contain a reason-only response. Loading it supplies no new decision.
  if (restoring && !Object.hasOwn(decision, 'nextChecks')) return;
  const nextChecks = nextCheckSchema.required({ targetTaskId: true }).array().min(1).max(32)
    .safeParse((decision as GoalProgressDecision).nextChecks);
  if (!nextChecks.success)
    throw new Error('math_plan_progress_review_invalid: nextChecks require action, objective, expectedEvidence and targetTaskId.');
  return { id: (decision as GoalProgressDecision).id, reason: reason.trim(),
    nextChecks: nextChecks.data.map(check => ({ ...check, targetTaskId: check.targetTaskId })) };
}

/** A still-current review shown to this dispatch requires an explicit answer. Peer-settled reviews do not. */
export function requireGoalProgressDecision(state: GoalProgressState | undefined, presentedId: string | undefined,
  decision: GoalProgressDecision | undefined): GoalProgressDecision | undefined {
  if (!presentedId || state?.pending?.id !== presentedId) return;
  if (!decision) throw new Error('math_plan_progress_review_missing: answer the presented review in progressReview.');
  if (decision.id !== presentedId)
    throw new Error('math_plan_progress_review_stale: progressReview must answer ' + presentedId);
  return decision;
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
  const unanswered = goals.filter(goal => !checks.some(check => goal.path.has(check.targetTaskId) ||
    researchServesGoal(tasks.get(check.targetTaskId)!, goal.id, goal.path, nextChecks)));
  if (unanswered.length)
    throw new Error('math_plan_progress_review_goal_unanswered: ' + unanswered.map(goal => goal.id).join(', '));
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
