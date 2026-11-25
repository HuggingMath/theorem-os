import { parseCooperationPlan } from './tasks';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalMathJson, mathDigest, writeMathJsonDurable } from '../math/mathRuntimeIo';
import type { LeanStatementContext } from '../math/leanStatementContext';
import { commitSolverSources, committedSource, git, solverSourceConstraints } from './problem';
import type { DispatchWaitObservation, SolverRunState } from './archive';
import { independentFeasibilityWorker, type ResearchWorker } from './modules/organization';
import type { WorkerAccess } from './research';
import type { SolverModules } from './modules';
import { originalGoalTaskFocus, originalGoalFrontierSnapshot, plannedTaskDependencyIds, taskDependencyRecords } from './modules/search';
import { type DeliveryRecord } from './deliveries';
import { rejectedDeliveryReceipt, deliveryReceiptFeedback, type DeliveryReceipt } from './deliveryReceipts';
import { proofReadyRecord, type ProofReadyRecord } from './proofReady';
import type { ProofCheck } from './modules/evidence';
import { createTaskSourceProjector, isAttributedTaskProof, ownedSourceDigest, TaskProofCache, type TaskProof } from './cooperativeProof';
import { researchSourceTasks, scopedResearchSources } from './researchSources';
import { isStatementAction, statementReviewSummary, type StatementReview } from './statementReview';
import { type ProofReferences } from './proofReferences';
import { attributeTaskReferences } from './taskReferenceAttribution';
import { buildProofContinuation } from './progress';
import { leadResearchInputs } from './contextCompiler';
import type { ResearchDecision } from './researchDecisions';
import { recordRouteBlockers, refreshRouteBlockers, validateBlockerProposals } from './routeControl';
import { parseProofRoutes } from './proofRoutes';
import { retireCooperativeRoutes, retiredCooperativeRoute } from './cooperationRoutes';
import { createProofRoutePriorityIndex } from './routePriority';
import { captureObligationSnapshot, diffObligationProgress } from './obligationProgress';
import { reviewGoalPaths } from './goalPathReview';
import { reviewProjectionDependencies } from './projectionDependencyReview';
import type { GoalPathDecisions } from './goalPathDecisions';
import type { PlanPatchBase } from './planPatch';
import type { PlanToolContext } from './planTool';
import { bindMathematicalGap, mathematicalGapVisible } from './mathematicalGaps';
import { currentNextCheck, proposedNextChecks } from './nextChecks';
import { proposedDefinitionContractChecks } from './definitionContractChecks';
import { taskConnectionCheckCurrent } from './taskConnections';
import { TaskTypePreflightCache } from './taskTypePreflight';
import { currentCapacityExploration, plannedTaskRecords } from './capacityExploration';
import { assignmentDeliveryFile, isFeasibilityReview, markTaskAcceptance, markTaskReferences, taskGroup, taskReferenceDependencies, type CooperativeTask, type TaskRecord, type CooperativeAction } from './tasks';
import { digest, ReviewRecord, HumanEditRecord, CooperationState, TaskVersions, RETRY_DISPATCH, bounded } from './cooperationShared';
import { emptyLeadWakes, leadWakePending, reopenLeadWakes, requestLeadWake, type LeadWakeReason } from './leadWakes';
import { MAX_INVALID_TASK_TRANSITIONS, setTaskStatus, type TaskStatus, type TaskTransitionCause } from './taskLifecycle';
import { planApprovalStatus } from './planApproval';
import { projectProofSearchRecord, proofSearchTargetForAssignment } from './proofSearchRecords';
import { answerGoalProgress, GOAL_PROGRESS_REVIEW_MS, goalProgressTaskContext, observeGoalProgress, resetGoalProgressClock,
  type GoalProgressDecision } from './goalProgress';

/** Shared cooperation state, scheduling primitives and the per-worker context projection. */
/** Lead turns that may leave a presented stall unanswered before it is recorded as ignored. */
export const MAX_UNANSWERED_GOAL_PATH_TURNS = 2;

export abstract class CooperationCore {
  protected readonly lead: ResearchWorker;
  protected readonly archive: CooperationState;
  protected presentedResearchInputs = new WeakMap<CooperativeAction, { shown: DeliveryRecord[]; total: number }>();
  protected pendingSourceResearchDecisions = new WeakMap<CooperativeAction, ResearchDecision[]>();
  protected presentedNextCheckOutcomes = new WeakMap<CooperativeAction, { checkId: string; outcomeDeliveryId: string }[]>();
  protected lastAssembly?: string;
  private assemblyYieldedLeads = new WeakSet<CooperativeAction>();
  private waiters = new Set<() => void>();
  protected dispatchRevision = 0;
  protected reservedTurns = new Set<string>();
  protected liveWorkers: Set<string>;
  protected checkedDeliveries = new WeakSet<TaskProof>();
  protected readonly taskProofCache = new TaskProofCache();
  protected readonly rejectedIntegrationBatches = new Set<string>();
  protected readonly taskTypePreflight = new TaskTypePreflightCache();
  protected preparingTaskTypes = new Map<TaskRecord, {
    workerId: string; groupId: string; controller: AbortController; current: () => boolean; settled: Promise<void>;
  }>();
  /** Exact helper contracts already tried by the host tactic battery in this process. */
  protected readonly tacticBatteryAttempts = new Set<string>();
  protected readonly libraryApplicationAttempts = new Set<string>();
  /** Exact family contracts whose host assembly was already checked in this process. */
  protected readonly familyAssemblyAttempts = new Set<string>();
  protected invalidTaskTypes = new Map<TaskRecord, { canonical: string; environment: string; taskDigest: string;
    dependencies: string; project: string; workerId: string; environmentIdentity?: string }>();
  protected readonly preparedSources = new Map<boolean, { identity: string; project: ReturnType<typeof createTaskSourceProjector> }>();
  protected checkedStatementReferences = new WeakSet<ProofReferences>();
  protected fixedReviewScope?: { review: ReviewRecord; commit: string; sourceDigest: string; environmentDigest: string;
    tasksDigest: string; required: ReadonlyMap<string, string> };
  protected statementContexts = new Map<string, LeanStatementContext>();
  protected preparingStatements?: Promise<void>;
  protected preparingStatementTasks = new Set<string>();
  protected planSynchronization?: Promise<void>;
  protected planSynchronizations = new Set<Promise<void>>();
  protected leadDeliveries = new Set<Promise<unknown>>();
  protected active = new Map<string, { action: CooperativeAction; interrupt: () => Promise<void>; notify: (message: string, options?: { requireTurn?: boolean; mode?: 'advisory' }) => Promise<void>;
    requestReady?: () => Promise<void>; cancelled?: boolean }>();
  private freshProofReady = new WeakMap<CooperativeAction, string>();
  protected notifications = new Set<Promise<void>>();
  private deliveryReceiptNotifications = new Set<string>();
  protected pendingPulse?: Promise<ReadonlyMap<string, Promise<void>>>;
  protected deliveryChecks = new Map<string, Promise<void>>();
  protected proofPublications = new Map<string, {
    workerId: string; action: Extract<CooperativeAction, { kind: 'task' }>; pending: Promise<TaskProof | undefined>;
  }>();
  protected proofDeliveryChecks = new Set<Promise<void>>();
  protected integrationQueue = Promise.resolve();
  protected integrationQueueDepth = 0;
  protected leadEvidence = new WeakMap<CooperativeAction, string>();
  private goalProgressTimer?: NodeJS.Timeout;
  protected goalProgressBudget?: { maxTurns: number; deadline: number };
  protected presentedGoalProgress = new WeakMap<CooperativeAction, string>();
  protected goalProgressDecisions = new WeakMap<CooperativeAction, GoalProgressDecision>();
  /** The goal-path stall a Lead dispatch was shown: its digest, goals and the stalled inputs its review listed. */
  protected presentedGoalPathStalls = new WeakMap<CooperativeAction, { digest: string; goalIds: readonly string[]; taskIds: readonly string[] }>();
  /** goalPath answers accepted from a Lead dispatch's publications, in order. */
  protected goalPathDecisions = new WeakMap<CooperativeAction, GoalPathDecisions>();
  /** Tasks on the routes of the currently stalled goals, recomputed with the stall itself. */
  protected goalPathStallTasks: ReadonlySet<string> = new Set();
  protected publishedPlans = new WeakMap<CooperativeAction, { plan: ReturnType<typeof parseCooperationPlan>; version: string; responseDigest: string }>();
  protected checkingTaskInputs = new Map<string, Promise<void>>();
  protected leanSourceDigests = new Map<string, string>();
  protected timer?: NodeJS.Timeout;
  protected stopping = false;
  protected failure?: Error;
  private pinned = new Set<string>();
  // Implemented by later layers; listed here because this layer calls them.
  protected abstract statementReviewAllowed(task: CooperativeTask, dispatch?: boolean): boolean;
  protected abstract syncEditChecks(nodes: ReadonlyMap<string, TaskRecord>, versions: TaskVersions): void;
  protected abstract refreshFeasibilityAssignments(): boolean;
  protected abstract planningInputDigest(): string;
  protected abstract refreshFailedTaskInputs(): boolean;
  protected abstract refreshResearchCheckpoints(): void;
  protected abstract suspendResearchDrafts(worker: ResearchWorker, taskId?: string): void;
  protected abstract planVersion(): string;
  protected abstract planPatchBase(): PlanPatchBase | undefined;
  protected abstract canAssemble(commit: string): boolean;
  protected abstract synchronizationPending(): boolean;
  abstract contextState(action?: CooperativeAction, worker?: ResearchWorker, versions?: TaskVersions): CooperationState;
  constructor(protected readonly input: { state: SolverRunState; workers: readonly ResearchWorker[];
    access: ReadonlyMap<string, WorkerAccess>; signal: AbortSignal; timeoutMs?: number; taskText?: string;
    /** Exact continuation checks verified in this process; conditional receipts keep their frozen inputs. */
    freshContinuationChecks?: readonly TaskProof[];
    continuousResearch?: boolean;
    modelDispatchAllowed?: () => boolean;
    goalProgressReviewMs?: number;
    /** Only idle human approval time is excluded; initial planning and owner-requested revisions still execute. */
    onPlanApprovalWaiting?: (waiting: boolean) => void;
    save: () => void; emit: (event: string, details?: Record<string, unknown>) => void;
    modules: SolverModules; exclusiveCheck: <T>(check: () => Promise<T>) => Promise<T> }) {
    this.lead = input.workers[0];
    this.archive = input.state.cooperation ??= { tasks: [] };
    resetGoalProgressClock(this.archive.goalProgress);
    const legacyLeadWakes = !this.archive.leadWakes;
    if (this.archive.leadWakes) reopenLeadWakes(this.archive.leadWakes);
    else this.archive.leadWakes = emptyLeadWakes();
    this.archive.proofRoutes = parseProofRoutes(this.archive.proofRoutes, this.archive.tasks.map(node => node.task));
    const gateRetirements = input.state.portfolioExploration?.gate?.retiredRoutes ?? [];
    let retirementChanged = false;
    if (gateRetirements.length) {
      const retired = new Map(gateRetirements.map(route => [route.routeId, route]));
      for (const route of this.archive.retiredRoutes ?? []) retired.set(route.routeId, route);
      retirementChanged = retired.size !== (this.archive.retiredRoutes?.length ?? 0);
      this.archive.retiredRoutes = [...retired.values()];
    }
    if (this.archive.retiredRoutes?.length) {
      const retirement = retireCooperativeRoutes({
        tasks: this.archive.tasks.map(node => node.task),
        groups: this.archive.groups?.map(route => route.group) ?? [],
        proofRoutes: this.archive.proofRoutes,
      }, this.archive);
      if (retirement) {
        this.archive.retiredRouteTasks = retirement.retiredRouteTasks;
        retirementChanged ||= (this.archive.proofRoutes?.length ?? 0) !== (retirement.plan.proofRoutes?.length ?? 0);
        this.archive.proofRoutes = retirement.plan.proofRoutes;
        for (const route of this.archive.groups ?? []) {
          if (route.group.status !== 'stopped' && this.archive.retiredRoutes.some(record => record.routeId === route.group.id)) {
            route.group = { ...route.group, status: 'stopped' };
            retirementChanged = true;
          }
        }
        if (this.stopRetiredRouteTasks() || retirementChanged)
          this.archive.planVersion = this.planVersion();
      }
    }
    this.syncProofRoutes();
    if (!this.archive.canonicalCommit) {
      this.archive.canonicalCommit = git(this.lead.worktree, ['rev-parse', 'HEAD']);
      this.archive.leadSeedCommit ??= this.archive.canonicalCommit;
    }
    // Continuation seeding and this cooperation instance share the proof objects.
    // Register unconditional acceptance only for exact objects on integrated tasks;
    // conditional receipts go through the ordinary check identity path on restore. This
    // keeps the restore path able to reuse a fresh receipt without trusting a
    // deserialized or otherwise unrelated proof value.
    for (const proof of input.freshContinuationChecks ?? []) {
      const node = this.archive.tasks.find(node => node.status === 'integrated' && node.integratedCheck === proof);
      if (!node || !proof.passed || proof.conditions?.length || proof.taskDigest !== digest(node.task) ||
          proof.commit !== this.archive.canonicalCommit || !isAttributedTaskProof(proof) ||
          proof.references && proof.references.environmentDigest !== input.state.environmentDigest) continue;
      if (proof.references) {
        proof.references.tasks = attributeTaskReferences(proof.references, this.archive.tasks);
        markTaskReferences(proof);
      }
      this.checkedDeliveries.add(proof); markTaskAcceptance(proof);
    }
    this.liveWorkers = new Set(input.workers.map(worker => worker.id));
    if (!this.archive.tasks.length) {
      // Without a graph every peer is idle; the first plan is always owed.
      if (!leadWakePending(this.archive.leadWakes)) this.wakeLead('initial-plan');
    } else if (legacyLeadWakes) {
      // Older states saved no wake-ups: infer the unanswered decision once from its durable inputs.
      const researchInputs = leadResearchInputs(this.archive.deliveries ?? [],
        new Map(this.archive.tasks.map(node => [node.task.id, node])), this.archive.researchDecisions).length > 0;
      if (this.archive.error || (researchInputs || this.archive.tasks.some(node => node.status === 'blocked')) &&
          this.archive.lastLeadInputDigest !== this.planningInputDigest()) this.wakeLead('restored-legacy-state');
    }
  }
  /** Ask the Lead for a decision; the request is saved with the state change that caused it. */
  protected wakeLead(reason: LeadWakeReason) { requestLeadWake(this.archive.leadWakes!, reason); }
  /** One timer for the next goal review. Busy worker labels and offline time never arm it. */
  protected refreshGoalProgress(snapshot = this.archive.progressSnapshot) {
    clearTimeout(this.goalProgressTimer); this.goalProgressTimer = undefined;
    const now = Date.now(), budget = this.goalProgressBudget;
    const enabled = !this.stopping && !this.failure && !this.input.signal.aborted && !this.planApprovalPending() &&
      this.input.modelDispatchAllowed?.() !== false && (!budget || now < budget.deadline && this.input.state.turns < budget.maxTurns);
    const active = new Set<string>();
    if (enabled) {
      for (const [workerId, work] of this.active) if (work.action.kind === 'task' && !work.cancelled &&
          this.liveWorkers.has(workerId) && this.current(work.action) &&
          this.input.state.workers?.find(worker => worker.id === workerId)?.recovery?.phase !== 'cooling-down')
        active.add(work.action.task.id);
      for (const node of this.preparingTaskTypes.keys()) active.add(node.task.id);
      for (const node of this.archive.tasks) if (node.assignment && this.deliveryChecks.has(node.assignment.workerId)) active.add(node.task.id);
      for (const publication of this.proofPublications.values()) if (this.current(publication.action)) active.add(publication.action.task.id);
    }
    const observation = observeGoalProgress(this.archive.goalProgress, {
      problemReceiptDigest: this.input.state.problem.receiptDigest, targets: this.input.state.problem.targets,
      tasks: this.archive.tasks, snapshot: snapshot ?? captureObligationSnapshot(this.archive.tasks, {
        groups: this.archive.groups, environmentDigest: this.input.state.environmentDigest, proofRoutes: this.archive.proofRoutes }),
      nextChecks: this.archive.nextChecks?.filter(record => currentNextCheck(record, this.archive, this.explorationIdentity)),
      proofRoutes: this.archive.proofRoutes, groups: this.archive.groups, activeTaskIds: active, now, intervalMs: this.input.goalProgressReviewMs });
    this.archive.goalProgress = observation.state;
    if (observation.resumed.length) this.input.emit('goal_progress_resumed', { goalIds: observation.resumed, acceptance: 'not-assessed' });
    if (observation.requested) {
      this.wakeLead('goal-progress-review');
      this.input.emit('goal_progress_review_requested', { ...observation.state.pending, acceptance: 'not-assessed' });
    }
    const retryAt = observation.state.pending?.retryAt;
    const retryDelay = retryAt !== undefined && retryAt > now ? retryAt - now : undefined;
    const delay = observation.nextDelayMs === undefined ? retryDelay : Math.min(observation.nextDelayMs, retryDelay ?? Infinity);
    if (enabled && delay !== undefined) {
      this.goalProgressTimer = setTimeout(() => { this.goalProgressTimer = undefined; this.changed(); },
        Math.min(delay, Math.max(1, (budget?.deadline ?? Infinity) - now)));
      this.goalProgressTimer.unref();
    }
    return observation.requested;
  }
  protected presentGoalProgressReview(action: CooperativeAction) {
    const pending = this.archive.goalProgress?.pending;
    if (!pending) return;
    this.presentedGoalProgress.set(action, pending.id);
    pending.retryAt = Date.now() + (this.input.goalProgressReviewMs ?? GOAL_PROGRESS_REVIEW_MS);
    this.input.emit('goal_progress_review_dispatched', { id: pending.id, goalIds: pending.goalIds });
    this.refreshGoalProgress();
  }
  protected answerGoalProgressReview(action: CooperativeAction) {
    const decision = this.goalProgressDecisions.get(action), state = this.archive.goalProgress;
    if (!decision || !state || this.presentedGoalProgress.get(action) !== decision.id || !answerGoalProgress(state, decision)) return;
    this.input.emit('goal_progress_review_answered', { ...decision, acceptance: 'not-assessed' });
    for (const [workerId, active] of this.active) if (active.action.kind === 'task' && !active.cancelled && this.current(active.action)) {
      const task = active.action.task, message = goalProgressTaskContext(state, task);
      if (!message || !decision.nextChecks.some(check => check.targetTaskId === task.id)) continue;
      const pending = active.notify(message).catch(() => {
        this.input.emit('notification_deferred', { workerId, reviewId: decision.id });
      });
      this.notifications.add(pending); void pending.finally(() => this.notifications.delete(pending));
    }
    this.refreshGoalProgress();
  }
  /**
   * Record whether some original goal has no frontier input that can run. The condition is recomputed from durable
   * state, so it is not a saved wake-up: a new stall stays owed to the Lead until a turn answers it (answerGoalPathStall)
   * or it is recorded as ignored, and an identical stall is not asked again. Busy workers elsewhere do not answer it. An applied human edit is itself the
   * planning decision for a stall it creates, unless a goal of that stall was already owed a Lead turn before it.
   */
  protected refreshGoalPathStall(edit?: HumanEditRecord) {
    const review = reviewGoalPaths(this.archive.tasks, { groups: this.archive.groups, proofRoutes: this.archive.proofRoutes,
      environmentDigest: this.input.state.environmentDigest, candidates: false });
    this.goalPathStallTasks = new Set(review.stalledPathTaskIds);
    const previous = this.archive.goalPathStall;
    const owed = previous?.active && previous.answeredAt === undefined ? previous.goalIds : [];
    const decided = edit?.status === 'applied' && !review.stalledGoalIds.some(goalId => owed.includes(goalId));
    if (!review.stallDigest) {
      if (!previous?.active) return false;
      previous.active = false; return true;
    }
    if (previous?.digest === review.stallDigest) {
      if (previous.active) return false;
      previous.active = true;
      if (decided) previous.answeredAt ??= Date.now();
      return true;
    }
    this.archive.goalPathStall = { digest: review.stallDigest, active: true, at: Date.now(),
      goalIds: review.stalledGoalIds, taskIds: review.stalledTaskIds.slice(0, 16), ...(decided ? { answeredAt: Date.now() } : {}) };
    this.input.emit('goal_path_stalled', { digest: review.stallDigest, goalIds: review.stalledGoalIds, taskIds: review.stalledTaskIds,
      ...(decided ? { answeredByEdit: edit!.id } : {}) });
    return true;
  }
  protected unansweredGoalPathStall() {
    const stall = this.archive.goalPathStall;
    return stall?.active && stall.answeredAt === undefined ? stall.digest : undefined;
  }
  /** The review a Lead is shown, with candidate ids: the basis for its goalPath answer. */
  protected goalPathReview(candidates = true) {
    const options = { groups: this.archive.groups, proofRoutes: this.archive.proofRoutes,
      environmentDigest: this.input.state.environmentDigest };
    const review = reviewGoalPaths(this.archive.tasks, { ...options, candidates: false });
    if (!candidates || !review.stalledTaskIds.length) return review;
    const projectionConnections = reviewProjectionDependencies({ problem: this.input.state.problem,
      worktree: this.lead.worktree, canonicalCommit: this.archive.canonicalCommit,
      environmentDigest: this.input.state.environmentDigest, tasks: this.archive.tasks,
      consumerTaskIds: review.stalledTaskIds,
      retainedGoals: task => this.dependencies(task).filter(node => node.task.kind === 'goal' && node.status === 'integrated')
        .map(node => node.task.theoremName!) });
    return reviewGoalPaths(this.archive.tasks, { ...options, projectionConnections });
  }
  /** What a Lead dispatch is shown of the current stall: the stalled inputs listed in its bounded review. */
  protected presentedGoalPathStall() {
    const stall = this.archive.goalPathStall;
    if (!stall?.active) return;
    const review = this.goalPathReview(false);
    return { digest: stall.digest, goalIds: stall.goalIds,
      taskIds: [...new Set(review.goals.filter(goal => goal.stalled).flatMap(goal => goal.frontier.map(item => item.taskId)))] };
  }
  /**
   * A Lead turn that was shown the stalled goals answers the stall its decision leaves on them when that stall differs
   * from the one it was shown (a re-pause, a revision, a reopened route), or when its goalPath adopted or declined every
   * presented input. A settled turn that did neither leaves it owed; after MAX_UNANSWERED_GOAL_PATH_TURNS such turns it
   * is recorded as ignored and no longer wakes the Lead. An unfinished (checkpointed) turn answers it by having seen it,
   * as before: its saved pause, not the stall, decides when the Lead continues. A goal that newly stalls stays owed.
   */
  protected answerGoalPathStall(action: CooperativeAction, settled = true) {
    this.refreshGoalPathStall();
    const stall = this.archive.goalPathStall, presented = this.presentedGoalPathStalls.get(action);
    if (!stall?.active || !presented || stall.answeredAt !== undefined || !stall.goalIds.every(goalId => presented.goalIds.includes(goalId)))
      return;
    const decisions = this.goalPathDecisions.get(action), now = Date.now();
    if (decisions?.declined.length) stall.declined = [...(stall.declined ?? []).filter(item =>
      !decisions.declined.some(entry => entry.taskId === item.taskId)),
      ...decisions.declined.map(item => ({ ...item, at: now }))].slice(-16);
    const covered = new Set([...decisions?.adopted.map(item => item.taskId) ?? [], ...stall.declined?.map(item => item.taskId) ?? []]);
    if (!settled || stall.digest !== presented.digest || presented.taskIds.every(taskId => covered.has(taskId))) {
      stall.answeredAt = now; return;
    }
    stall.unanswered = (stall.unanswered ?? 0) + 1;
    const missing = presented.taskIds.filter(taskId => !covered.has(taskId));
    if (stall.unanswered < MAX_UNANSWERED_GOAL_PATH_TURNS) {
      this.input.emit('goal_path_stall_unanswered', { digest: stall.digest, taskIds: missing, unanswered: stall.unanswered });
      return;
    }
    stall.answeredAt = stall.ignoredAt = now;
    this.input.emit('goal_path_stall_ignored', { digest: stall.digest, goalIds: stall.goalIds, taskIds: missing, unanswered: stall.unanswered });
  }
  /** Keep a Lead dispatch's accepted goalPath answers until its turn settles. */
  protected recordGoalPathDecisions(action: CooperativeAction, decisions: GoalPathDecisions) {
    const previous = this.goalPathDecisions.get(action);
    this.goalPathDecisions.set(action, { adopted: [...previous?.adopted ?? [], ...decisions.adopted],
      declined: [...(previous?.declined ?? []).filter(item => !decisions.declined.some(entry => entry.taskId === item.taskId)),
        ...decisions.declined] });
    if (decisions.adopted.length || decisions.declined.length)
      this.input.emit('goal_path_decided', { adopted: decisions.adopted.map(item => item.id),
        declined: decisions.declined.map(item => item.taskId) });
  }
  /** The only live task status write. Staged validation copies are checked but never recorded. */
  protected moveTask(node: TaskRecord, to: TaskStatus, cause: TaskTransitionCause) {
    const from = node.status;
    if (setTaskStatus(node, to, cause) || !this.archive.tasks.includes(node)) return;
    const record = { taskId: node.task.id, from, to, cause, at: Date.now() };
    this.archive.invalidTaskTransitions = [...this.archive.invalidTaskTransitions ?? [], record].slice(-MAX_INVALID_TASK_TRANSITIONS);
    this.input.emit('task_transition_invalid', record);
  }
  protected get livePeers() { return this.input.workers.filter(worker => worker.id !== this.lead.id && this.liveWorkers.has(worker.id)); }
  /** A stopped worker never returns in this process; a restart restores every plan reservation. */
  protected get stoppedWorkers(): ReadonlySet<string> {
    return new Set(this.input.workers.filter(worker => !this.liveWorkers.has(worker.id)).map(worker => worker.id));
  }
  protected get responsibility() {
    return { tasks: this.archive.tasks, groups: this.archive.groups, stopped: this.stoppedWorkers };
  }
  protected workerCoolingDown(workerId: string) {
    return this.input.state.workers?.some(worker => worker.id === workerId && worker.recovery?.phase === 'cooling-down') === true;
  }
  protected get allocationPeers() {
    const occupied = new Set([...this.active].filter(([, active]) => active.action.kind !== 'task').map(([id]) => id));
    if (this.archive.review?.status === 'running' && this.archive.review.workerId) occupied.add(this.archive.review.workerId);
    for (const review of this.archive.statementReviews ?? []) if (review.workerId && ['translating', 'reviewing'].includes(review.status))
      occupied.add(review.workerId);
    return this.livePeers.filter(worker => !occupied.has(worker.id) && !this.workerCoolingDown(worker.id));
  }
  protected get explorationIdentity() {
    return { environmentDigest: this.input.state.environmentDigest,
      problemReceiptDigest: this.input.state.problem.receiptDigest };
  }
  /** The CAS plan belongs to Lead; host advisory capacity is a separate execution overlay. */
  protected plannedTasks() { return plannedTaskRecords(this.archive.tasks); }
  /** Turn one scoped mathematical question into ordinary feasibility work and retain its complete lifecycle. */
  protected refreshNextChecks() {
    const identity = { problemReceiptDigest: this.input.state.problem.receiptDigest, environmentDigest: this.input.state.environmentDigest };
    const now = Date.now();
    for (const proposed of [...proposedNextChecks(this.archive, identity, now),
      ...proposedDefinitionContractChecks(this.archive, identity, now)]) {
      const previous = this.archive.nextChecks?.find(record => record.id === proposed.record.id);
      if (previous) {
        // A pause or removed downstream path can expire an unfinished definition check.
        // When that exact question becomes relevant again, resume its one existing record.
        if (previous.origin === 'definition-contract' && previous.status === 'stale' && !previous.outcome) {
          const node = this.archive.tasks.find(item => item.nextCheckId === previous.id);
          if (currentNextCheck({ ...previous, status: 'pending' }, this.archive, identity)) {
            previous.status = 'pending';
            if (node) { node.task = { ...node.task, status: 'active' }; this.moveTask(node, 'pending', 'reopened'); }
            else this.archive.tasks.push(proposed.node);
            this.input.emit('next_check_resumed', { checkId: previous.id, taskId: previous.taskId });
          }
        }
        continue;
      }
      // A model task cannot take ownership of the host's deterministic check id.
      if (this.archive.tasks.some(node => node.task.id === proposed.node.task.id)) continue;
      (this.archive.nextChecks ??= []).push(proposed.record); this.archive.tasks.push(proposed.node);
      this.input.emit('next_check_scheduled', { checkId: proposed.record.id, taskId: proposed.node.task.id,
        target: proposed.record.scope.target, consumer: proposed.record.scope.consumer,
        ...(proposed.record.origin ? { origin: proposed.record.origin } : {}) });
    }
    for (const record of this.archive.nextChecks ?? []) {
      const node = this.archive.tasks.find(item => item.nextCheckId === record.id);
      if (record.status !== 'stale' && !currentNextCheck(record, this.archive, identity)) {
        record.status = 'stale';
        if (node) { node.task = { ...node.task, status: 'stopped' }; this.moveTask(node, 'blocked', 'expired'); }
        this.input.emit('next_check_expired', { checkId: record.id, taskId: record.taskId });
      }
      if (record.status === 'pending') {
        const outcome = this.archive.deliveries?.find(delivery => delivery.checkOutcome?.checkId === record.id &&
          delivery.kind === 'research' && delivery.status !== 'superseded' && delivery.taskId === record.taskId &&
          delivery.taskDigest === record.taskDigest && canonicalMathJson(delivery.checkOutcomeScope) === canonicalMathJson(record.scope));
        if (outcome?.checkOutcome) {
          record.outcome = { ...outcome.checkOutcome, deliveryId: outcome.id, ...(outcome.commit ? { commit: outcome.commit } : {}) };
          record.status = 'awaiting-decision';
          if (node && node.status !== 'completed') this.moveTask(node, 'completed', 'research-completed');
          this.wakeLead('research-finding');
          this.input.emit('next_check_outcome', { checkId: record.id, outcomeDeliveryId: outcome.id, conclusion: outcome.checkOutcome.conclusion });
        }
      }
      // Older continuation seeds could leave a settled check's task in the work queue.
      if (node && (record.status === 'awaiting-decision' || record.status === 'decided') &&
          (node.status === 'pending' || node.status === 'running'))
        this.moveTask(node, 'completed', 'research-completed');
      if (record.status !== 'pending' && node?.assignment) {
        const active = this.active.get(node.assignment.workerId);
        if (active?.action.kind === 'task' && active.action.assignment === node.assignment && !active.cancelled) {
          active.cancelled = true; void active.interrupt().catch(() => {});
        }
      }
    }
  }
  protected includeNextCheckTasks(plan: ReturnType<typeof parseCooperationPlan>) {
    const hostNodes = this.archive.tasks.filter(node => node.nextCheckId);
    const hostIds = new Set(hostNodes.map(node => node.task.id));
    for (const task of plan.tasks) {
      const host = hostNodes.find(node => node.task.id === task.id);
      if (host && digest(task) !== digest(host.task)) throw new Error('math_plan_host_next_check_changed');
      if (!host && task.dependsOn.some(id => hostIds.has(id)))
        throw new Error('math_plan_host_next_check_dependency: adopt a separate typed lemma; advisory checks are not proof inputs.');
    }
    plan.tasks = plan.tasks.filter(task => !hostIds.has(task.id));
    const proposed = this.nextCheckPlanView(plan);
    for (const node of hostNodes) {
      const record = this.archive.nextChecks?.find(item => item.id === node.nextCheckId);
      if (record && currentNextCheck(record, proposed, this.explorationIdentity) && plan.groups.some(group => group.id === taskGroup(node.task)))
        plan.tasks.push(node.task);
    }
  }
  protected nextCheckPlanView(plan: ReturnType<typeof parseCooperationPlan>) {
    const previousGroups = new Map(this.archive.groups?.map(record => [record.group.id, record]));
    return { ...this.archive, tasks: this.capacityPlanView(plan), proofRoutes: plan.proofRoutes,
      groups: plan.groups.map(group => ({ group, turns: previousGroups.get(group.id)?.turns ?? 0 })) };
  }
  protected refreshCapacityExplorations() {
    let changed = false;
    for (const node of this.archive.tasks) {
      if (!node.capacityExploration || (node.task.status ?? 'active') !== 'active' ||
          currentCapacityExploration(node, this.archive.tasks, this.explorationIdentity)) continue;
      node.task = { ...node.task, status: 'stopped' };
      this.moveTask(node, 'blocked', 'expired'); node.feedback = 'math_capacity_exploration_expired: Its frozen target or mathematical inputs are no longer current.';
      for (const record of this.archive.deliveries ?? []) if (record.taskId === node.task.id) record.status = 'superseded';
      const active = node.assignment && this.active.get(node.assignment.workerId);
      if (active?.action.kind === 'task' && active.action.assignment === node.assignment && !active.cancelled) {
        active.cancelled = true; void active.interrupt().catch(() => {});
      }
      this.input.emit('capacity_exploration_expired', { taskId: node.task.id,
        targetTaskId: node.capacityExploration.targetTaskId, inputDigest: node.capacityExploration.inputDigest });
      changed = true;
    }
    return changed;
  }
  protected capacityPlanView(plan: ReturnType<typeof parseCooperationPlan>): TaskRecord[] {
    const existing = new Map(this.archive.tasks.map(node => [node.task.id, node]));
    return plan.tasks.map(task => {
      const previous = existing.get(task.id);
      return { ...(previous && digest(previous.task) === digest(task) ? previous : { status: 'pending' as const, attempts: 0 }),
        task, alternativeRoutes: plan.proofRoutes?.filter(route => route.targetTaskId === task.id) };
    });
  }
  protected includeCapacityExplorations(plan: ReturnType<typeof parseCooperationPlan>) {
    const existing = new Map(this.archive.tasks.map(node => [node.task.id, node]));
    const hostIds = new Set(this.archive.tasks.filter(node => node.capacityExploration).map(node => node.task.id));
    for (const task of plan.tasks) {
      const previous = existing.get(task.id);
      if (previous?.capacityExploration) {
        if (digest(task) !== digest(previous.task) || task.ownerId !== previous.capacityExploration.workerId)
          throw new Error('math_plan_host_exploration_changed: create a separate typed task for an adopted interface.');
      } else if (task.dependsOn.some(id => hostIds.has(id)))
        throw new Error('math_plan_host_exploration_dependency: use the actual typed inputs, not advisory exploration IDs.');
    }
    const proposed = this.capacityPlanView(plan);
    plan.tasks = plan.tasks.filter(task => {
      const previous = existing.get(task.id);
      return !previous?.capacityExploration || digest(previous.task) !== digest(task) ||
        currentCapacityExploration({ ...previous, task }, proposed, this.explorationIdentity);
    });
    const ids = new Set(plan.tasks.map(task => task.id));
    for (const node of this.archive.tasks) if (node.capacityExploration && !ids.has(node.task.id) &&
        plan.groups.some(group => group.id === taskGroup(node.task)) &&
        currentCapacityExploration(node, proposed, this.explorationIdentity)) {
      plan.tasks.push(node.task); ids.add(node.task.id);
    }
    return plan;
  }
  protected syncProofRoutes() {
    for (const node of this.archive.tasks) node.alternativeRoutes = this.archive.proofRoutes?.filter(route => route.targetTaskId === node.task.id);
  }
  protected supersedeStatementReview(review: StatementReview) {
    review.status = 'superseded';
    for (const record of this.archive.deliveries ?? []) if (record.statementReviewId === review.id) record.status = 'superseded';
  }
  protected stopRetiredRouteTasks() {
    if (!this.archive.retiredRoutes?.length) return false;
    let changed = false;
    for (const node of this.archive.tasks) {
      if (node.status === 'integrated') continue;
      const route = retiredCooperativeRoute(node.task, this.archive);
      if (!route) {
        if (!node.assignment?.routeId || !this.archive.retiredRoutes.some(item => item.routeId === node.assignment?.routeId)) continue;
        if (node.status === 'running') this.moveTask(node, 'pending', 'interrupted');
        node.assignment = undefined;
        changed = true;
        continue;
      }
      const feedback = `math_route_retired: ${route.routeId}: ${route.reason}`;
      if (node.status === 'blocked' && node.task.status === 'stopped' && node.feedback === feedback && !node.assignment) continue;
      node.task = { ...node.task, status: 'stopped' };
      this.moveTask(node, 'blocked', 'route-retired');
      node.assignment = undefined;
      node.pendingValidation = undefined;
      node.feedback = feedback;
      changed = true;
    }
    for (const review of this.archive.statementReviews ?? []) {
      if (review.status === 'superseded') continue;
      const node = this.node(review.taskId);
      if (node && node.status !== 'integrated' && retiredCooperativeRoute(node.task, this.archive)) {
        this.supersedeStatementReview(review);
        changed = true;
      }
    }
    return changed;
  }
  protected actionRouteRetired(action: Extract<CooperativeAction, { kind: 'task' }>) {
    return Boolean(retiredCooperativeRoute(action.task, this.archive) ||
      this.archive.retiredRoutes?.some(route => route.routeId === action.assignment.routeId));
  }
  protected recordDispatchWait(worker: ResearchWorker,
    observation: Omit<DispatchWaitObservation, 'observedAt' | 'endedAt' | 'planVersion'>) {
    const record = this.input.state.workers?.find(item => item.id === worker.id);
    if (!record) return;
    const basis = { ...observation, planVersion: this.archive.planVersion ?? this.planVersion() };
    const previous = record.scheduling?.wait;
    if (previous) {
      const { observedAt: _at, endedAt, ...prior } = previous;
      if (endedAt === undefined && canonicalMathJson(prior) === canonicalMathJson(basis)) return;
      this.clearDispatchWait(worker, 'changed');
    }
    const wait: DispatchWaitObservation = { ...basis, observedAt: Date.now() };
    record.scheduling ??= { status: 'idle', since: wait.observedAt };
    record.scheduling.wait = wait;
    this.input.emit('dispatch_wait', { workerId: worker.id, ...wait });
    this.changed();
  }
  protected clearDispatchWait(worker: ResearchWorker, reason: 'changed' | 'selected' | 'stopped') {
    const scheduling = this.input.state.workers?.find(item => item.id === worker.id)?.scheduling;
    if (!scheduling?.wait) return;
    const wait = scheduling.wait;
    if (reason !== 'stopped') delete scheduling.wait;
    if (wait.endedAt !== undefined) return;
    wait.endedAt = Date.now();
    this.input.emit('dispatch_wait_ended', { workerId: worker.id, observedAt: wait.observedAt,
      endedAt: wait.endedAt, planVersion: wait.planVersion, stage: wait.stage, reason });
  }
  protected changed(edit?: HumanEditRecord) {
    this.refreshNextChecks();
    this.refreshCapacityExplorations();
    this.refreshFeasibilityAssignments();
    this.refreshResearchCheckpoints();
    this.stopRetiredRouteTasks();
    for (const blocker of refreshRouteBlockers(this.archive.blockers ?? [], this.archive.tasks,
      this.input.state.environmentDigest, this.input.state.problem.receiptDigest)) {
      this.wakeLead('route-reopened');
      this.input.emit('route_reopened', { blockerId: blocker.id, taskId: blocker.taskId, reason: blocker.reopenedReason });
    }
    this.refreshFailedTaskInputs();
    this.refreshGoalPathStall(edit);
    const snapshot = captureObligationSnapshot(this.archive.tasks, { groups: this.archive.groups,
      environmentDigest: this.input.state.environmentDigest, proofRoutes: this.archive.proofRoutes, blockers: this.archive.blockers });
    const progress = diffObligationProgress(this.archive.progressSnapshot, snapshot);
    this.archive.progressSnapshot = snapshot;
    if (progress) {
      this.archive.progressReceipts = [...(this.archive.progressReceipts ?? []), progress].slice(-64);
      this.input.emit('obligation_progress', { receipt: progress });
    }
    this.refreshGoalProgress(snapshot);
    const nodes = new Map(this.archive.tasks.map(node => [node.task.id, node]));
    const versions = this.taskVersions();
    const busy = new Map<string, Set<string | undefined>>();
    const occupy = (groupId: string, workerId?: string) => {
      const owners = busy.get(groupId) ?? new Set<string | undefined>(); owners.add(workerId); busy.set(groupId, owners);
    };
    for (const node of this.archive.tasks) if (node.status === 'running') occupy(taskGroup(node.task), node.assignment?.workerId);
    for (const [id, active] of this.active) if (active.action.kind === 'task' &&
        !this.actionRouteRetired(active.action)) occupy(taskGroup(active.action.task), id);
    for (const publication of this.proofPublications.values()) if (!this.actionRouteRetired(publication.action))
      occupy(taskGroup(publication.action.task), publication.workerId);
    for (const preparation of this.preparingTaskTypes.values()) occupy(preparation.groupId, preparation.workerId);
    for (const review of this.archive.statementReviews ?? []) {
      const node = nodes.get(review.taskId);
      if (node && ['translating', 'reviewing'].includes(review.status)) occupy(taskGroup(node.task), review.workerId);
    }
    for (const route of this.archive.groups ?? []) route.busy = busy.get(route.group.id)?.size ?? 0;
    this.archive.planVersion ??= this.planVersion();
    if (edit?.status === 'applied') edit.planVersion = this.archive.planVersion;
    this.refreshPlanApproval();
    this.syncEditChecks(nodes, versions);
    // A new inbox can supersede an assessment-only Lead without publishing a plan.
    // Reclaim its running turn as well as rejecting stale decisions.
    const lead = this.active.get(this.lead.id);
    if (lead?.action.kind === 'lead' && !lead.cancelled && !this.current(lead.action)) {
      lead.cancelled = true; void lead.interrupt().catch(() => {});
    }
    const agents = this.input.workers.map(peer => {
      const active = this.active.get(peer.id);
      const publication = [...this.proofPublications.values()].find(item => item.workerId === peer.id);
      const work = active?.action ?? publication?.action;
      const preparation = [...this.preparingTaskTypes].find(([, item]) => item.workerId === peer.id)?.[0];
      const status = !this.liveWorkers.has(peer.id) ? 'stopped' as const
        : active && (active.cancelled || !this.current(active.action)) ? 'stopping' as const
        : work ? 'working' as const : preparation ? 'preparing' as const : 'idle' as const;
      const action = work?.kind ?? (preparation ? 'task' : undefined);
      const taskId = work?.kind === 'task' ? work.task.id : preparation?.task.id;
      const record = this.input.state.workers?.find(worker => worker.id === peer.id);
      if (record) {
        if ((work || preparation) && record.scheduling?.wait?.stage !== 'integration-queue') this.clearDispatchWait(peer, 'selected');
        const previous = record.scheduling;
        const same = previous?.status === status && previous.action === action && previous.taskId === taskId;
        record.scheduling = { status, action, taskId, since: same ? previous.since : Date.now(), wait: previous?.wait };
      }
      return { id: peer.id, role: work && (work.kind === 'review' || isStatementAction(work) ||
        work.kind === 'task' && isFeasibilityReview(work.task)) ? 'reviewer' : peer.role,
        status,
        work: work && { kind: work.kind, taskId: work.kind === 'task' ? work.task.id : undefined,
          version: work.kind === 'task' ? work.assignment.taskDigest : work.seedCommit } };
    });
    this.input.save();
    for (const worker of this.input.workers) {
      const action = this.active.get(worker.id)?.action;
      const scoped = this.contextState(action, worker, versions);
      const search = action?.kind === 'task' ? projectProofSearchRecord({
        record: this.archive.proofSearchRecords?.[this.proofSearchScope(action).taskId],
        scope: this.proofSearchScope(action),
        projectRoot: path.join(worker.worktree, this.input.state.problem.projectRelative),
        runDirectory: path.dirname(this.lead.worktree),
      }) : undefined;
      const visible = new Set(scoped.tasks.map(node => node.task.id));
      const requiredCheckDeliveries = new Set((scoped.nextChecks ?? []).filter(record =>
        record.status === 'pending' || record.status === 'awaiting-decision').flatMap(record =>
        [...(record.gapDeliveryId ? [record.gapDeliveryId] : []), ...(record.outcome ? [record.outcome.deliveryId] : [])]));
      const recentDeliveries = new Set((scoped.deliveries ?? []).slice(-16).map(record => record.id));
      const deliveries = (scoped.deliveries ?? []).filter(record => recentDeliveries.has(record.id) || requiredCheckDeliveries.has(record.id));
      writeMathJsonDurable(path.join(worker.worktree, 'COOPERATION.json'), {
        planVersion: this.archive.planVersion,
        ...(worker.id === this.lead.id ? { planTool: {
          problem: { targets: this.input.state.problem.targets, ownedFiles: this.input.state.problem.ownedFiles,
            frozenFiles: this.input.state.problem.frozenFiles, declarations: this.input.state.problem.declarations },
          base: this.planPatchBase(), goalPath: scoped.goalPathReview,
        } satisfies PlanToolContext } : {}),
        ...(scoped.landedHelpers?.length ? { landedHelpers: scoped.landedHelpers } : {}),
        ...(scoped.retiredRoutes?.length ? { retiredRoutes: scoped.retiredRoutes } : {}),
        edits: (this.archive.edits ?? []).slice(-16),
        agents,
        dispatchWaits: (this.input.state.workers ?? []).flatMap(peer => {
          const wait = peer.scheduling?.wait;
          if (!wait) return [];
          const candidates = wait.candidates.filter(item => visible.has(item.taskId));
          return [{ workerId: peer.id, ...wait, candidates,
            omittedCandidates: wait.omittedCandidates + wait.candidates.length - candidates.length }];
        }),
        ...(worker.id === this.lead.id && scoped.error ? { error: scoped.error, planRejection: scoped.planRejection } : {}),
        ...(scoped.planPublicationRejection ? { planPublicationRejection: scoped.planPublicationRejection } : {}),
        ...(scoped.contextCheckpointRejection ? { contextCheckpointRejection: scoped.contextCheckpointRejection } : {}),
        capacityExplorations: scoped.tasks.filter(node => node.capacityExploration).map(node => ({
          taskId: node.task.id, status: node.status, ...node.capacityExploration })),
        parallelQuestions: scoped.parallelQuestions ?? [],
        tasks: scoped.tasks,
        failedTaskInputs: scoped.failedTaskInputs ?? [],
        peers: this.archive.tasks.map(node => ({ id: node.task.id, taskDigest: digest(node.task),
          objectiveDigest: mathDigest(node.task.objective), groupId: taskGroup(node.task), kind: node.task.kind,
          status: node.status, owner: node.assignment?.workerId ?? node.task.ownerId, dependsOn: node.task.dependsOn,
          ...(visible.has(node.task.id) ? { objective: node.task.objective, feedback: node.feedback,
            canonicalProbe: node.assignment?.canonicalProbe,
            actualReferences: (node.integratedCheck ?? node.proof)?.references } : {}) })),
        deliveries: deliveries.map(({ evidence: _evidence, researchRecord: _researchRecord, ...record }) => record),
        deliveryReceipts: scoped.deliveryReceipts ?? [],
        proofReadyRecords: scoped.proofReadyRecords ?? [],
        proofSearchRecords: search ? { [search.taskId]: search } : {},
        mathematicalGaps: scoped.mathematicalGaps ?? [],
        nextChecks: scoped.nextChecks ?? [],
        ...(action?.kind === 'task' ? { researchDelivery: { assignment: action.assignment,
          problemReceiptDigest: this.input.state.problem.receiptDigest, environmentDigest: this.input.state.environmentDigest,
          projectRelative: this.input.state.problem.projectRelative,
          ownedFiles: this.input.state.problem.ownedFiles.filter(file => file.endsWith('.lean') &&
            !Object.hasOwn(this.input.state.problem.frozenFiles ?? {}, file)) } } : {}),
        blockers: scoped.blockers ?? [],
        proofRoutes: scoped.proofRoutes ?? [],
        routePriority: createProofRoutePriorityIndex(scoped.tasks, { groups: scoped.groups,
          environmentDigest: this.input.state.environmentDigest, proofRoutes: scoped.proofRoutes }),
        frontierFocus: originalGoalFrontierSnapshot(originalGoalTaskFocus(scoped.tasks, scoped.groups, this.input.state.environmentDigest)),
        mathematicalChanges: scoped.progressReceipts?.slice(-16) ?? [],
        ...(scoped.goalProgress ? { goalProgress: scoped.goalProgress } : {}),
        continuation: buildProofContinuation(scoped.tasks, { groups: scoped.groups, environmentDigest: this.input.state.environmentDigest,
          proofRoutes: scoped.proofRoutes }),
        statements: (scoped.statementReviews ?? []).map(statementReviewSummary),
      });
    }
    this.wake();
  }
  /** An independent scoped check may continue its explicit target's advisory search, never an arbitrary task. */
  protected proofSearchScope(action: Extract<CooperativeAction, { kind: 'task' }>) {
    const identity = { problemReceiptDigest: this.input.state.problem.receiptDigest,
      environmentDigest: this.input.state.environmentDigest };
    const checks = (this.archive.nextChecks ?? []).filter(record => currentNextCheck(record, this.archive, identity));
    return { ...identity, ...proofSearchTargetForAssignment(action.assignment, checks, identity) };
  }
  /** With --plan-approval, the first accepted plan holds every worker until a human approves its exact version. */
  protected planApprovalPending() {
    return planApprovalStatus(this.input.state) === 'pending';
  }
  protected refreshPlanApproval() {
    const pending = this.planApprovalPending();
    if (pending && this.archive.planApproval?.requestedAt === undefined) {
      this.archive.planApproval = { ...this.archive.planApproval, requestedAt: Date.now(), requestedVersion: this.archive.planVersion };
      this.input.emit('plan_approval_requested', { planVersion: this.archive.planVersion });
    }
    const waiting = pending && !this.stopping && !this.failure && !this.input.signal.aborted &&
      this.liveWorkers.has(this.lead.id) && !this.active.size && !this.reservedTurns.size &&
      !this.preparingTaskTypes.size && !this.preparingStatements && !this.planSynchronizations.size &&
      !this.leadDeliveries.size && !this.deliveryChecks.size && !this.proofPublications.size &&
      !this.proofDeliveryChecks.size && !this.checkingTaskInputs.size && !this.integrationQueueDepth;
    // A planning checkpoint may close every model session. Keep the CLI alive to receive approval
    // while its execution timer is paused, using the existing input poller.
    if (waiting) this.timer?.ref(); else this.timer?.unref();
    this.input.onPlanApprovalWaiting?.(waiting);
  }
  protected cancelStaleTaskTypes() {
    for (const pending of this.preparingTaskTypes.values())
      if (!pending.controller.signal.aborted && !pending.current()) pending.controller.abort();
  }
  protected wake() {
    this.dispatchRevision++;
    this.cancelStaleTaskTypes();
    this.refreshPlanApproval();
    const lead = this.active.get(this.lead.id), canonical = this.archive.canonicalCommit;
    if (lead?.action.kind === 'lead' && !lead.cancelled && canonical && !this.stopping && !this.failure &&
        !this.input.signal.aborted && !this.planApprovalPending() && !this.synchronizationPending() &&
        this.lastAssembly !== canonical && this.canAssemble(canonical)) {
      // Synchronization can settle with only a wake. Yield this dispatch permanently before
      // stopping its writer, so late plans and source drafts cannot replace the candidate.
      this.assemblyYieldedLeads.add(lead.action);
      lead.cancelled = true;
      this.input.emit('lead_yielded_for_assembly', { workerId: this.lead.id, seedCommit: lead.action.seedCommit, commit: canonical });
      void lead.interrupt().catch(() => {});
    }
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  modelBudgetChanged() { this.refreshGoalProgress(); this.input.save(); this.wake(); }
  workerAvailabilityChanged() { this.wake(); }
  protected rejectWorkerDelivery(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>,
    submission: string, error: Error): DeliveryReceipt {
    const receipt = rejectedDeliveryReceipt({ assignment: action.assignment, workerId: worker.id,
      environmentDigest: this.input.state.environmentDigest, submission, error, now: Date.now(),
      receipts: this.archive.deliveryReceipts });
    const receipts = this.archive.deliveryReceipts ??= [];
    const previous = receipts.find(item => item.id === receipt.id);
    if (previous) return previous;
    receipts.push(receipt);
    const node = this.node(action.task.id);
    if (this.current(action) && node) node.feedback = deliveryReceiptFeedback(receipt);
    return receipt;
  }
  protected async notifyDeliveryReceipts(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>) {
    const active = this.active?.get(worker.id);
    if (!active || active.action !== action || !this.current(action)) return;
    const notified = this.deliveryReceiptNotifications ??= new Set();
    for (const receipt of this.archive.deliveryReceipts ?? []) {
      if (receipt.status !== 'needs-correction' || receipt.workerId !== worker.id || receipt.assignmentKey !== assignmentDeliveryFile(action.assignment) ||
          receipt.environmentDigest !== this.input.state.environmentDigest || notified.has(receipt.id)) continue;
      // Reserve this receipt while its soft notice waits, without blocking later worker deliveries.
      notified.add(receipt.id);
      const pending = Promise.resolve().then(async () => {
        if (this.active.get(worker.id) !== active || !this.current(action)) throw new Error('math_notification_assignment_changed');
        await active.notify(deliveryReceiptFeedback(receipt));
      }).catch(() => {
        notified.delete(receipt.id);
        this.input.emit('delivery_receipt_notification_deferred', { workerId: worker.id, receiptId: receipt.id });
      });
      const notifications = this.notifications ??= new Set();
      notifications.add(pending); void pending.finally(() => notifications.delete(pending));
    }
  }
  protected resolveDeliveryReceipts(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>,
    replacesReceipt?: unknown, complete = false) {
    const scoped = (this.archive.deliveryReceipts ?? []).filter(receipt => receipt.workerId === worker.id &&
      receipt.assignmentKey === assignmentDeliveryFile(action.assignment) && receipt.taskId === action.assignment.taskId &&
      receipt.taskDigest === action.assignment.taskDigest && receipt.seedCommit === action.assignment.seedCommit &&
      receipt.environmentDigest === this.input.state.environmentDigest);
    const byId = new Map(scoped.map(receipt => [receipt.id, receipt]));
    const replaced = new Set<string>();
    let id = typeof replacesReceipt === 'string' ? replacesReceipt : undefined;
    while (id && !replaced.has(id)) {
      const receipt = byId.get(id);
      if (!receipt || receipt.status === 'superseded') break;
      replaced.add(id); id = receipt.replacesReceipt;
    }
    for (const receipt of scoped) {
      if (receipt.status !== 'needs-correction' || !complete && !replaced.has(receipt.id)) continue;
      receipt.status = 'recorded';
      const node = this.node(action.task.id);
      if (node.feedback === deliveryReceiptFeedback({ ...receipt, status: 'needs-correction' }))
        node.feedback = undefined;
    }
    const pending = this.archive.deliveryReceipts?.findLast(receipt => receipt.status === 'needs-correction' &&
      receipt.workerId === worker.id && receipt.assignmentKey === assignmentDeliveryFile(action.assignment) &&
      receipt.environmentDigest === this.input.state.environmentDigest);
    const node = this.node(action.task.id);
    if (pending && !node.feedback) node.feedback = deliveryReceiptFeedback(pending);
  }
  protected receiveProofReady(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>, submissionId: string) {
    const created = proofReadyRecord({ assignment: action.assignment, workerId: worker.id, submissionId,
      problemReceiptDigest: this.input.state.problem.receiptDigest, environmentDigest: this.input.state.environmentDigest, now: Date.now() });
    const records = this.archive.proofReadyRecords ??= [];
    let record = records.find(item => item.id === created.id);
    if (record && ['checked', 'failed', 'superseded'].includes(record.status)) return;
    if (!record) { records.push(created); record = created; }
    if (!this.current(action) || worker.id !== action.assignment.workerId) {
      record.status = 'superseded'; record.reason = 'Assignment changed before readiness intake.'; this.changed(); return;
    }
    const fresh = this.freshProofReady.get(action) === record.id;
    for (const other of records) if (other !== record && other.assignmentKey === record.assignmentKey &&
        other.workerId === worker.id && other.status === 'awaiting-freeze') {
      other.status = 'superseded'; other.reason = 'A later readiness event replaced this request.';
    }
    // Only a newly consumed event can grant this process permission to freeze a live workspace.
    this.freshProofReady.set(action, record.id);
    this.changed();
    const active = this.active.get(worker.id);
    if (!fresh && record.status === 'awaiting-freeze' && active?.action === action && active.requestReady) {
      const pending = active.requestReady().catch(() => {
        this.input.emit('proof_ready_notification_deferred', { workerId: worker.id, receiptId: record!.id });
      });
      this.notifications.add(pending); void pending.finally(() => this.notifications.delete(pending));
    }
  }
  private proofReadyCurrent(record: ProofReadyRecord, worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>) {
    return record.workerId === worker.id && worker.id === action.assignment.workerId &&
      record.assignmentKey === assignmentDeliveryFile(action.assignment) && record.taskId === action.task.id &&
      record.taskDigest === action.assignment.taskDigest && record.seedCommit === action.assignment.seedCommit &&
      record.problemReceiptDigest === this.input.state.problem.receiptDigest &&
      record.environmentDigest === this.input.state.environmentDigest && this.current(action);
  }
  pendingProofReady(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>): ProofReadyRecord | undefined {
    const records = (this.archive.proofReadyRecords ?? []).filter(record => record.workerId === worker.id &&
      record.assignmentKey === assignmentDeliveryFile(action.assignment) && ['awaiting-freeze', 'frozen'].includes(record.status));
    let changed = false;
    for (const record of records) if (!this.proofReadyCurrent(record, worker, action)) {
      record.status = 'superseded'; record.reason = 'Assignment or frozen input identity changed.'; changed = true;
    }
    if (changed) this.changed();
    return records.findLast(record => record.status === 'frozen' || record.status === 'awaiting-freeze' &&
      this.freshProofReady.get(action) === record.id);
  }
  proofReadyFrozen(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>, commit: string): ProofReadyRecord | undefined {
    const record = this.pendingProofReady(worker, action);
    if (!record) return;
    if (record.snapshotCommit) {
      if (record.snapshotCommit !== commit) throw new Error('math_proof_ready_snapshot_changed');
      return record;
    }
    // Callers stop the writer first. Every read here addresses the host's immutable commit.
    const sourceDigest = ownedSourceDigest(this.input.state.problem, worker.worktree, commit);
    this.pin(commit);
    Object.assign(record, { status: 'frozen', snapshotCommit: commit, sourceDigest, frozenAt: Date.now() });
    this.changed();
    this.input.emit('proof_ready_frozen', { readyId: record.id, taskId: record.taskId, taskDigest: record.taskDigest,
      workerId: record.workerId, assignmentKey: record.assignmentKey, seedCommit: record.seedCommit,
      commit, snapshotCommit: commit, sourceDigest, frozenAt: record.frozenAt });
    return record;
  }
  proofReadyCompleted(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>,
    proof?: ProofCheck & { conditions?: TaskProof['conditions'] }, reason?: string): void {
    const record = this.pendingProofReady(worker, action);
    if (!record) return;
    if (!proof || !proof.passed) {
      record.status = 'failed'; record.reason = reason ?? 'The fixed declaration did not pass independent checking.';
    } else {
      if (record.status !== 'frozen' || proof.commit !== record.snapshotCommit || proof.sourceDigest !== record.sourceDigest ||
          !this.checkedDeliveries.has(proof as TaskProof) || !proof.verification.results.length)
        throw new Error('math_proof_ready_check_identity_changed');
      Object.assign(record, { status: 'checked', evidence: proof.conditions?.length ? 'conditional' : 'unconditional',
        conditions: proof.conditions ? [...proof.conditions] : [], receiptIds: proof.verification.results.map(result => result.receiptId) });
      delete record.reason;
    }
    this.freshProofReady.delete(action); this.changed();
  }
  proofReadyFailedFreeze(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>, reason: string): void {
    const record = this.pendingProofReady(worker, action);
    if (!record || record.snapshotCommit) return;
    record.status = 'failed'; record.reason = 'Freeze unconfirmed: ' + reason;
    this.freshProofReady.delete(action); this.changed();
  }
  activate(worker: ResearchWorker, action: CooperativeAction, interrupt: () => Promise<void>, notify: (message: string, options?: { requireTurn?: boolean; mode?: 'advisory' }) => Promise<void>,
    requestReady?: () => Promise<void>) {
    this.active.set(worker.id, { action, interrupt, notify, requestReady }); this.changed();
  }
  deactivate(worker: ResearchWorker) { this.active.delete(worker.id); this.changed(); }
  protected nextCheckDispatchable(node: TaskRecord) {
    return !node.nextCheckId || this.archive.nextChecks?.some(record => record.id === node.nextCheckId &&
      record.status === 'pending' && currentNextCheck(record, this.archive, this.explorationIdentity)) === true;
  }
  current(action: CooperativeAction) {
    if (action.kind === 'assemble') return !this.failure && !this.stopping && this.liveWorkers.has(this.lead.id) && this.canAssemble(action.seedCommit);
    if (action.kind === 'lead' && this.assemblyYieldedLeads.has(action)) return false;
    if (action.kind === 'lead' && (action.planNonce || action.initialPlanNonce) && !this.leadEvidence.has(action)) return false;
    if (isStatementAction(action)) {
      const review = this.archive.statementReviews?.find(item => item.id === action.reviewId);
      const node = this.node(action.taskId);
      return Boolean(review && review.status === (action.kind === 'backtranslate' ? 'translating' : 'reviewing') &&
        review.assignmentId === action.assignmentId &&
        review.taskDigest === action.taskDigest && review.commit === action.seedCommit &&
        review.snapshotDigest === action.snapshotDigest && review.workspace === action.workspace && node &&
        digest(node.task) === action.taskDigest && this.statementReviewAllowed(node.task));
    }
    if (action.kind === 'lead') {
      const version = this.publishedPlans.get(action)?.version ?? action.planVersion;
      return version === undefined || version === this.archive.planVersion;
    }
    if (action.kind === 'review') {
      const review = this.archive.review;
      return Boolean(review && review.status === 'running' && review.commit === action.seedCommit &&
        review.sourceDigest === action.sourceDigest && review.assignmentId === action.assignmentId);
    }
    return action.kind !== 'task' || !this.actionRouteRetired(action) &&
      this.archive.tasks.some(node => node.assignment === action.assignment && digest(node.task) === action.assignment.taskDigest &&
      this.nextCheckDispatchable(node) &&
      (!node.capacityExploration || currentCapacityExploration(node, this.archive.tasks, this.explorationIdentity)) &&
      (!action.assignment.connectionCheck || taskReferenceDependencies(node) || taskConnectionCheckCurrent(node.task,
        action.assignment, this.archive.tasks, { environmentDigest: this.input.state.environmentDigest,
          problemReceiptDigest: this.input.state.problem.receiptDigest })) &&
      (!isFeasibilityReview(node.task) || this.input.workers.some(worker => worker.id === action.assignment.workerId &&
        independentFeasibilityWorker(node, worker, this.archive.tasks, this.archive.groups))) &&
      (taskReferenceDependencies(node) ?? action.assignment.dependencies ?? []).every(dependency => this.archive.tasks.some(item => item.task.id === dependency.taskId && digest(item.task) === dependency.taskDigest)) &&
      (node.task.status ?? 'active') === 'active' && this.archive.groups?.find(route => route.group.id === taskGroup(node.task))?.group.status === 'active');
  }
  protected taskVersions() {
    return new Map(this.archive.tasks.map(({ task }) => [task.id, { task, version: digest(task) }]));
  }
  protected deliveryVisible(record: DeliveryRecord, task: CooperativeTask | undefined, versions: TaskVersions, gapViewer = task) {
    if (record.status === 'superseded') return false;
    if (!mathematicalGapVisible(record, this.archive, gapViewer)) return false;
    if (!record.taskId) return !task;
    const node = versions.get(record.taskId);
    return node && node.version === record.taskDigest && record.dependencies.every(dependency =>
      versions.get(dependency.taskId)?.version === dependency.taskDigest) &&
      (!task || taskGroup(node.task) === taskGroup(task) || node.task.sharing !== 'group');
  }
  private inform(record: DeliveryRecord) {
    const versions = this.taskVersions();
    for (const [id, active] of this.active) {
      if (id === record.producer) continue;
      if (isStatementAction(active.action)) continue;
      const task = active.action.kind === 'task' ? active.action.task : undefined;
      if (task && record.taskId && !this.deliveryVisible(record, task, versions)) continue;
      const notice = `Cooperation update: ${record.kind} ${record.id}, task ${record.taskId ?? 'original'}, status ${record.status}. Read COOPERATION.json for peer state and current-version references; use M4 to choose relevant material. This notification grants no proof acceptance.`;
      const pending = active.notify(notice, { mode: 'advisory' }).catch(() => { this.input.emit('notification_deferred', { workerId: id, deliveryId: record.id }); });
      this.notifications.add(pending); void pending.finally(() => this.notifications.delete(pending));
    }
    this.input.emit('delivery_published', { deliveryId: record.id, producer: record.producer, workerId: record.producer,
      taskId: record.taskId, taskDigest: record.taskDigest, assignmentKey: record.assignmentKey,
      commit: record.commit, sourceDigest: record.sourceDigest,
      receiptIds: record.evidence?.verification.results.map(result => result.receiptId),
      kind: record.kind, status: record.status });
  }
  protected pin(commit?: string) {
    if (!commit || this.pinned.has(commit)) return;
    if (!/^[a-f0-9]{40,64}$/u.test(commit)) throw new Error('math_delivery_invalid_commit');
    git(this.lead.worktree, ['update-ref', `refs/math/${this.input.state.runId}/evidence/${commit}`, commit]);
    this.pinned.add(commit);
  }
  protected record(worker: ResearchWorker, task: CooperativeTask | undefined, kind: DeliveryRecord['kind'], status: DeliveryRecord['status'],
    summary: string, options: Partial<DeliveryRecord> = {}) {
    const record = this.createDeliveryRecord(worker, task, kind, status, summary, options);
    (this.archive.deliveries ??= []).push(record);
    this.publishDeliveryRecord(record);
    return record;
  }
  protected createDeliveryRecord(worker: ResearchWorker, task: CooperativeTask | undefined, kind: DeliveryRecord['kind'], status: DeliveryRecord['status'],
    summary: string, options: Partial<DeliveryRecord> = {}): DeliveryRecord {
    if (options.mathematicalGap && task) options = { ...options, mathematicalGapScope: bindMathematicalGap(options.mathematicalGap, task,
      this.archive, { problemReceiptDigest: this.input.state.problem.receiptDigest, environmentDigest: this.input.state.environmentDigest }) };
    const inputs = task && status !== 'superseded' ? this.dependencies(task) : [];
    const references = task && kind === 'proof' && status === 'verified' ? taskReferenceDependencies(this.node(task.id)) : undefined;
    const dependencies = references ?? inputs.map(node => ({ taskId: node.task.id, taskDigest: digest(node.task) }));
    const remaining = inputs.filter(node => !['integrated', 'completed'].includes(node.status)).map(node => node.task.id);
    const record: DeliveryRecord = { id: crypto.randomUUID(), producer: worker.id, taskId: task?.id, taskDigest: task && digest(task),
      groupId: task && taskGroup(task), kind, status, statement: task?.type ?? task?.objective ?? this.input.state.problem.contract.formalStatement,
      premises: task?.premises ?? this.input.state.problem.contract.assumptions, dependencies, remainingObligations: remaining,
      summary: bounded(summary, 5000), evidenceRefs: [], createdAt: Date.now(), ...options };
    if (record.evidence) {
      const { passed, verification: { status, targetCommit, results } } = record.evidence;
      // Proof records own the receipts; deliveries refer to their immutable IDs.
      record.evidence = { passed, verification: { status, targetCommit,
        results: results.map(({ receiptId }) => ({ receiptId })) } };
    }
    this.pin(record.commit); this.pin(record.artifacts?.commit); this.pin(record.evidence?.verification.targetCommit);
    return record;
  }
  protected publishDeliveryRecord(record: DeliveryRecord) {
    this.changed();
    if (record.status !== 'superseded') this.inform(record);
  }
  protected reportBlockers(task: CooperativeTask, value: unknown) {
    const proposals = validateBlockerProposals(value, task, this.archive.tasks);
    for (const blocker of recordRouteBlockers(this.archive.blockers ??= [], proposals, task, this.archive.tasks,
      this.input.state.environmentDigest, this.input.state.problem.receiptDigest)) {
      this.wakeLead('route-blocker-recorded');
      this.input.emit(blocker.status === 'parked' ? 'route_parked' : 'route_blocker_recorded', {
        blockerId: blocker.id, taskId: blocker.taskId, groupId: blocker.groupId, count: blocker.count,
        scope: blocker.scope, evidenceStatus: blocker.evidenceStatus, reopenOn: blocker.reopenOn });
    }
  }
  protected async wait() {
    const signal = this.input.signal; signal.throwIfAborted();
    await new Promise<void>(resolve => {
      const wake = () => { signal.removeEventListener('abort', wake); this.waiters.delete(wake); resolve(); };
      this.waiters.add(wake); signal.addEventListener('abort', wake, { once: true });
    });
    signal.throwIfAborted();
  }
  protected node(id: string) { return this.archive.tasks.find(node => node.task.id === id)!; }
  protected dependencies(task: CooperativeTask, tasks: readonly TaskRecord[] = this.archive.tasks): TaskRecord[] {
    return taskDependencyRecords(task, tasks);
  }
  protected synchronizationBlocked(task: CooperativeTask): boolean {
    return [this.node(task.id), ...this.dependencies(task)].some(node => node &&
      (node.pendingValidation || this.preparingStatementTasks.has(node.task.id)));
  }
  protected async waitForDispatch(observedRevision = this.dispatchRevision): Promise<typeof RETRY_DISPATCH> {
    // A wake between checking readiness and subscribing already invalidates the selection.
    if (observedRevision === this.dispatchRevision) await this.wait();
    return RETRY_DISPATCH;
  }
  protected visible(task: CooperativeTask): TaskRecord[] {
    const nodes = new Map(this.archive.tasks.map(node => [node.task.id, node]));
    const visible = new Set(this.archive.tasks.filter(node => taskGroup(node.task) === taskGroup(task) ||
      (node.task.sharing !== 'group' && ['integrated', 'completed'].includes(node.status))));
    const seen = new Set<string>();
    const visit = (node: TaskRecord) => {
      if (seen.has(node.task.id)) return; seen.add(node.task.id);
      for (const id of plannedTaskDependencyIds(node, this.archive.tasks)) {
        const input = nodes.get(id);
        if (!input || (taskGroup(input.task) !== taskGroup(task) && input.task.sharing === 'group')) continue;
        visible.add(input); visit(input);
      }
    };
    const current = nodes.get(task.id); if (current) visit(current);
    return this.archive.tasks.filter(node => visible.has(node));
  }
  protected seed(worker: ResearchWorker, commit: string, task?: CooperativeTask): string {
    this.suspendResearchDrafts(worker, task?.id);
    const session = this.input.state.workers?.find(record => record.id === worker.id);
    const previousGroup = session?.sessionGroupId;
    if (task && (previousGroup && previousGroup !== taskGroup(task) || session?.sessionTaskId && session.sessionTaskId !== task.id) ||
        !task && worker.id !== this.lead.id) fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), '');
    const sources = Object.fromEntries(this.input.state.problem.ownedFiles.map(file => [file,
      committedSource(this.lead.worktree, commit, `${this.input.state.problem.projectRelative}/${file}`)]));
    for (const [file, source] of Object.entries(scopedResearchSources(this.input.state.problem, task, sources,
      researchSourceTasks(this.archive.tasks)))) {
      fs.writeFileSync(path.join(worker.worktree, this.input.state.problem.projectRelative, file), source);
    }
    const problem = this.input.state.problem;
    if (fs.existsSync(path.join(worker.worktree, problem.projectRelative, '.lake/source-constraints.json'))) {
      writeMathJsonDurable(path.join(worker.worktree, problem.projectRelative, '.lake/source-constraints.json'),
        solverSourceConstraints(problem), 0o400);
    }
    const seed = commitSolverSources(this.input.state.problem, worker.worktree);
    if (worker.id === this.lead.id) {
      this.archive.leadSeedCommit = seed; this.pin(seed); this.input.save();
    }
    return seed;
  }
}
