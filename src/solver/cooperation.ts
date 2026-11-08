import { proofSearchRecordMatches } from './proofSearchRecords';
import { isAdvisoryTask as advisory } from './tasks';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VerificationCheckpointError } from './verificationCheckpoint';
import { canonicalMathJson, mathDigest, readMathText, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { inspectLeanDeclarationRegions, inspectLeanSource, inspectScopedLeanDeclarations } from '../math/leanSource';
import { committedSource, git, originalDeclarationRegions, solverSourceConstraints } from './problem';
import { solverProofFeedback, solverSourceFeedback } from './feedback';
import { assessTaskResponsibility, assignSharedResearchTask, independentFeasibilityWorker, type ResearchWorker } from './modules/organization';
import type { DispatchWaitObservation } from './archive';
import { CAPACITY_EXPLORATION_FOCUSES, capacityExplorationInput, createCapacityExploration,
  currentCapacityExploration, TIMED_EXPLORATION_FOCUSES, TIMED_EXPLORATION_IDLE_MS, TIMED_EXPLORATION_MIN_REMAINING_MS,
  TIMED_EXPLORATION_UNANSWERED_WAKES, timedExplorationTargets } from './capacityExploration';
import { hasFreshSolverCheck, proofReceiptsMatch, type ProofCheck } from './modules/evidence';
import { originalGoalTaskFocus, readyResearchTasks, researchCanAdvance, routeAllowsTask, taskCanStart, taskDependenciesReady, selectedTaskRoute } from './modules/search';
import { deliveryDetails, reviewVerdict, readMathResponse as block, MAX_RESEARCH_NOTES_BYTES } from './deliveries';
import { checkTaskProof, ownedSourceDigest, taskChanges } from './cooperativeProof';
import { assertStatementSnapshot, isStatementAction, resetStatementReview } from './statementReview';
import { captureProofReferences } from './proofReferences';
import { captureDeliveryArtifacts, type DeliveryArtifactManifest } from './deliveryArtifacts';
import { attributeTaskReferences } from './taskReferenceAttribution';
import { taskConsumerProjection } from './taskConsumers';
import { parallelQuestions } from './taskQuestions';
import { contextCheckpointRejection } from './contextCheckpoint';
import { leadResearchInputs } from './contextCompiler';
import { deliverHumanGuidance, readHumanGuidance } from './humanGuidance';
import { mathematicalGaps, mathematicalGapVisible } from './mathematicalGaps';
import { visibleNextChecks } from './nextChecks';
import { goalProgressForTask } from './goalProgress';
import { automaticTaskConnection, createTaskConnectionCheck } from './taskConnections';
import { TACTIC_BATTERY_TIMEOUT_MS } from './tacticBattery';
import { LIBRARY_APPLICATION_TIMEOUT_MS } from './libraryApplication';
import { knowledgeReferenceCoverage } from './knowledgeUsage';
import { taskTypePreflightEnvironmentIdentity, typeDiagnosticExcerpt, type TaskTypePreflight } from './taskTypePreflight';
import { assignmentDeliveryFile, isDefinitionTask, isFeasibilityReview, taskGroup, type CooperativeTask, type CooperativeAction, type TaskAssignment, type TaskRecord } from './tasks';
import { consumeLeadWakes, dropLeadWakes, LEAD_MAX_BACKOFF, leadWakePending, settleLeadWakes } from './leadWakes';
import { idlePeersAwaitingLead, IDLE_PEER_WAKE_MS, leadInbox, leadInboxBasis, NO_WORK_STAGES, type LeadInboxBasis } from './leadInbox';
import { restoreResidue } from './stateInvariants';
import { digest, directDeliveryRejections, isTaskSourceRepairFeedback, rejectionCode, CooperationState, TaskVersions, DispatchBudget, RETRY_DISPATCH, DispatchResult, bounded } from './cooperationShared';
import { CooperationInputs } from './cooperationInputs';
import { ResearchAdmissionError } from './researchAdmission';
export { parseCooperationPlan } from './tasks';
export { taskGroup, taskVersion, taskReferenceDependencies, assignmentDeliveryFile } from './tasks';
export type { CooperativeTask, RouteGroup, RouteRecord, TaskAssignment, TaskRecord, CooperativeAction } from './tasks';
export { readCooperationPlan } from './cooperationShared';
export type { ReviewRecord, HumanEditRecord, InitialPlanPublication, CooperationState } from './cooperationShared';

/** Lead plans; workers claim distinct ready obligations; only checked source enters the canonical proof. */
export class CooperativeResearch extends CooperationInputs {
  private guidancePulse?: Promise<void>;
  private humanGuidanceCheckpoint(stopped = false): Promise<void> {
    return this.guidancePulse ??= deliverHumanGuidance({
      stateFile: path.join(path.dirname(this.lead.worktree), 'state.json'), state: this.input.state, stopped,
      recipients: () => [...this.active].flatMap(([workerId, active]) => {
        const worker = this.input.workers.find(item => item.id === workerId);
        if (!worker || active.cancelled || isStatementAction(active.action)) return [];
        const action = active.action;
        return [{ workerId, role: worker.role,
          ...(action.kind === 'task' ? { taskRef: { id: action.task.id, version: action.assignment.taskDigest } } : {}),
          current: () => !this.stopping && !this.input.signal.aborted && this.active.get(workerId) === active &&
            !active.cancelled && this.current(action), notify: message => active.notify(message, { requireTurn: true }) }];
      }),
      onRecord: record => {
        this.input.emit('human_guidance_' + record.status, { id: record.id, recipient: record.recipient,
          taskRef: record.taskRef, deliveredTo: record.deliveredTo, reason: record.reason });
        // An idle Lead needs a decision turn before its normal checkpoint can deliver this note.
        if (record.status === 'deferred' && record.recipient.kind === 'lead' && !record.taskRef &&
            (!record.recipient.id || record.recipient.id === this.lead.id)) this.wake();
      },
    }).catch(error => {
      if (error instanceof Error && error.message === 'math_runtime_lease_busy') return;
      this.input.emit('human_guidance_unavailable', { reason: error instanceof Error ? error.message : 'math_guidance_unavailable' });
    }).finally(() => { this.guidancePulse = undefined; });
  }
  /**
   * Optional advisory supply for otherwise idle expanded teams, without a Lead graph mutation. A small team gets
   * the same supply only through a narrow gate (timedExplorationDue), on its crux consumer.
   */
  private async requestCapacityExploration(worker: ResearchWorker, budget: DispatchBudget, previousReady: readonly TaskRecord[]) {
    const expanded = this.input.workers.length > 4 && budget.remainingMs === Infinity;
    const timed = this.input.workers.length <= 4;
    if (!this.input.continuousResearch || !expanded && !timed ||
        !['prover', 'researcher', 'engineer'].includes(worker.role) || budget.maxTurns !== Infinity) return false;
    return this.input.exclusiveCheck(async () => {
      if (this.stopping || this.failure || this.input.signal.aborted || this.input.modelDispatchAllowed?.() === false ||
          !this.liveWorkers.has(this.lead.id) || !this.allocationPeers.some(peer => peer.id === worker.id) ||
          this.active.has(worker.id) || this.reservedTurns.has(worker.id) || this.deliveryChecks.has(worker.id) ||
          [...this.proofPublications.values()].some(publication => publication.workerId === worker.id) ||
          [...this.preparingTaskTypes.values()].some(pending => pending.workerId === worker.id) ||
          this.pendingFixedStatementReviews() || this.archive.review && ['pending', 'running'].includes(this.archive.review.status)) return false;
      const ready = readyResearchTasks(this.archive.tasks, this.archive.groups)
        .filter(node => !this.preparingTaskTypes.has(node) && !this.synchronizationBlocked(node.task) &&
          (!node.capacityExploration || currentCapacityExploration(node, this.archive.tasks, this.explorationIdentity)));
      // A peer may have published real work while this request waited for the archive transaction.
      const newlyReady = assignSharedResearchTask(ready, worker, this.allocationPeers, this.archive.groups, this.archive.tasks, this.stoppedWorkers);
      if (newlyReady) return !previousReady.includes(newlyReady);
      if (timed && !this.timedExplorationDue(worker, budget)) return false;
      const focus = originalGoalTaskFocus(this.plannedTasks(), this.archive.groups, this.input.state.environmentDigest);
      const targets = [...focus.frontier].map(id => this.node(id)).filter(node => node &&
        ['lemma', 'goal'].includes(node.task.kind) && !['integrated', 'completed', 'delivered'].includes(node.status) &&
        !this.synchronizationBlocked(node.task) && routeAllowsTask(node.task, this.archive.tasks, this.archive.groups));
      // Expanded teams spread each method across the frontier; the timed gate stays on the crux first.
      const plan = timed ? timedExplorationTargets(targets).flatMap(target =>
        TIMED_EXPLORATION_FOCUSES.map(method => ({ method, target })))
        : CAPACITY_EXPLORATION_FOCUSES.flatMap(method => targets.map(target => ({ method, target })));
      for (const { method, target } of plan) {
        const inputDigest = capacityExplorationInput(target.task, this.archive.tasks, this.explorationIdentity);
        if (this.archive.capacityExplorationInputs?.some(input => input.targetTaskId === target.task.id &&
            input.inputDigest === inputDigest && input.focus === method)) continue;
        const node = createCapacityExploration(target, worker, this.archive.tasks, this.explorationIdentity, method);
        if (this.archive.tasks.some(existing => existing.task.id === node.task.id) ||
            !currentCapacityExploration(node, this.archive.tasks, this.explorationIdentity) ||
            !routeAllowsTask(node.task, [...this.archive.tasks, node], this.archive.groups)) continue;
        // Marker and tombstone become durable together. No Lead files or CAS base are rewritten.
        (this.archive.capacityExplorationInputs ??= []).push({ inputDigest, focus: method,
          targetTaskId: target.task.id, taskId: node.task.id });
        this.archive.tasks.push(node);
        this.input.emit('capacity_exploration_requested', { workerId: worker.id, taskId: node.task.id,
          targetTaskId: target.task.id, inputDigest, focus: method, evidenceStatus: 'advisory',
          ...(timed ? { gate: 'timed-idle' } : {}) });
        this.changed(); return true;
      }
      return false;
    });
  }
  private explorationTimer?: { at: number; timer: NodeJS.Timeout };
  /**
   * The narrow gate for a team of at most four. This peer has waited at least
   * TIMED_EXPLORATION_IDLE_MS with nothing it can start; since the last deciding Lead turn the Lead was woken for idle
   * peers at least twice while this peer was idle, and no Lead turn is running now; and enough solving time remains.
   * Only the wait itself matures with time, so a peer that is otherwise eligible is re-dispatched when it does.
   */
  private timedExplorationDue(worker: ResearchWorker, budget: DispatchBudget): boolean {
    const scheduling = this.input.state.workers?.find(record => record.id === worker.id)?.scheduling;
    const wait = scheduling?.wait, wake = this.archive.idlePeerWake;
    if (budget.remainingMs < TIMED_EXPLORATION_MIN_REMAINING_MS || this.active.has(this.lead.id) ||
        scheduling?.status !== 'idle' || !wait || wait.endedAt !== undefined || !NO_WORK_STAGES.has(wait.stage) ||
        !wake || wake.at <= (this.archive.leadDecisionBasisAt ?? 0) || (wake.count ?? 1) < TIMED_EXPLORATION_UNANSWERED_WAKES ||
        wake.at < scheduling.since) return false;
    const dueAt = scheduling.since + TIMED_EXPLORATION_IDLE_MS, now = Date.now();
    if (dueAt <= now) return true;
    // One timer serves every waiting peer: the earliest one re-dispatches all, and later peers re-arm it.
    if (dueAt - now <= budget.remainingMs - TIMED_EXPLORATION_MIN_REMAINING_MS && !(this.explorationTimer && this.explorationTimer.at <= dueAt)) {
      clearTimeout(this.explorationTimer?.timer);
      const timer = setTimeout(() => { this.explorationTimer = undefined; if (!this.stopping) this.wake(); }, dueAt - now);
      timer.unref(); this.explorationTimer = { at: dueAt, timer };
    }
    return false;
  }
  /** A normal advisory checkpoint preserves the draft before the new typed task takes priority. */
  shouldYieldCapacityExploration(worker: ResearchWorker, action: CooperativeAction): boolean {
    if (action.kind !== 'task' || !this.current(action)) return false;
    const node = this.node(action.task.id);
    if (!node?.capacityExploration || !['prover', 'researcher', 'engineer'].includes(worker.role)) return false;
    const groups = this.archive.groups?.map(route => ({ ...route,
      busy: Math.max(0, (route.busy ?? 0) - Number(route.group.id === taskGroup(node.task))) }));
    const ready = readyResearchTasks(this.archive.tasks, groups).filter(candidate => !candidate.capacityExploration &&
      !advisory(candidate.task) && !this.preparingTaskTypes.has(candidate) && !this.synchronizationBlocked(candidate.task));
    return Boolean(assignSharedResearchTask(ready, worker, this.allocationPeers, groups, this.archive.tasks, this.stoppedWorkers));
  }
  private leadPauseInputs = new WeakMap<CooperativeAction, string>();
  private pendingLeadInboxBases = new WeakMap<CooperativeAction, LeadInboxBasis>();
  private idlePeerTimer?: NodeJS.Timeout;
  /**
   * Busy peers never return the Lead's turn, so a peer left without startable work would wait for them. One wake per
   * idle peer no deciding Lead turn has seen idle: the inbox already lists idle workers, and a turn that decides (or
   * this wake) moves the basis past them. A turn cut or paused without a decision has not answered them, so a peer
   * an earlier wake named is re-owed a turn on the Lead's backoff schedule. Nothing running is the ordinary
   * idle-Lead path, not this one.
   */
  private wakeForIdlePeers() {
    clearTimeout(this.idlePeerTimer); this.idlePeerTimer = undefined;
    if (this.stopping || !this.active.size && !this.proofPublications.size || this.active.has(this.lead.id) || !this.archive.tasks.length) return;
    const decidedAt = this.archive.leadDecisionBasisAt ?? 0, previous = this.archive.idlePeerWake;
    const unanswered = previous && previous.at > decidedAt ? previous : undefined;
    const retry = unanswered && { at: unanswered.at,
      notBefore: unanswered.at + IDLE_PEER_WAKE_MS * 2 ** Math.min(unanswered.count ?? 1, LEAD_MAX_BACKOFF) };
    const { due, dueAt } = idlePeersAwaitingLead(this.input.state.workers ?? [], this.lead.id, decidedAt, Date.now(), retry);
    if (due.length) {
      this.archive.idlePeerWake = { at: Date.now(), workerIds: due, ...(unanswered ? { count: (unanswered.count ?? 1) + 1 } : {}) };
      this.wakeLead('peers-idle');
      this.input.emit('lead_woken_for_idle_peers', { workerIds: due, idleWakeMs: IDLE_PEER_WAKE_MS });
      this.input.save();
    } else if (dueAt !== undefined) {
      this.idlePeerTimer = setTimeout(() => { this.idlePeerTimer = undefined; if (!this.stopping) this.wake(); },
        Math.max(0, dueAt - Date.now()));
      this.idlePeerTimer.unref();
    }
  }
  private leadResponsibilityDigest(): string {
    const focus = originalGoalTaskFocus(this.archive.tasks, this.archive.groups, this.input.state.environmentDigest);
    return mathDigest(canonicalMathJson({ schema: 'theorem-os.lead-responsibility.v1', ...this.explorationIdentity,
      frontier: this.archive.tasks.filter(node => focus.frontier.has(node.task.id)).map(node =>
        [node.task.id, capacityExplorationInput(node.task, this.archive.tasks, this.explorationIdentity)])
        .sort(([a], [b]) => a.localeCompare(b)) }));
  }
  protected refreshFeasibilityAssignments() {
    let changed = false;
    for (const node of this.archive.tasks) {
      const assignment = node.assignment;
      if (!assignment || !isFeasibilityReview(node.task) || !['pending', 'running'].includes(node.status)) continue;
      const worker = this.input.workers.find(worker => worker.id === assignment.workerId);
      if (worker && independentFeasibilityWorker(node, worker, this.archive.tasks, this.archive.groups)) continue;
      this.moveTask(node, 'pending', 'reassigned'); node.assignment = undefined;
      node.feedback = 'math_feasibility_review_independence_lost: Reassign this advisory review to a peer who does not own or produce the inspected inputs.';
      const draft = this.archive.researchDrafts?.[node.task.id];
      if (draft?.assignmentId === assignment.assignmentId && draft.workerId === assignment.workerId) draft.suspended = true;
      const active = this.active.get(assignment.workerId);
      if (active?.action.kind === 'task' && active.action.assignment === assignment && !active.cancelled) {
        active.cancelled = true; void active.interrupt().catch(() => {});
      }
      if (node.task.ownerId) this.wakeLead('feasibility-review-reassigned');
      this.input.emit('feasibility_review_reassigned', { taskId: node.task.id, workerId: assignment.workerId,
        assignmentId: assignment.assignmentId, reason: 'reviewer-no-longer-independent', draftCommit: draft?.commit });
      changed = true;
    }
    return changed;
  }
  /** A live publication never authorizes a superseded dispatch or changed decisions. */
  planSnapshot(action: CooperativeAction) {
    return this.current(action) ? this.publishedPlans.get(action)?.plan : undefined;
  }
  initialPlanSnapshot(action: CooperativeAction) { return this.planSnapshot(action); }
  start() {
    this.timer = setInterval(() => { void this.humanGuidanceCheckpoint(); void this.inputs().catch(error => {
      this.input.emit('cooperation_poll_failed', { reason: error instanceof Error ? error.message : 'unknown' });
      if (error instanceof VerificationCheckpointError || error instanceof Error && error.message === 'math_verifier_unavailable') { this.failure = error; this.changed(); }
    }); }, 200);
    this.timer.unref();
  }
  async stop() {
    this.stopping = true;
    this.refreshGoalProgress();
    if (this.planApprovalPending()) this.input.emit('plan_approval_unanswered', { planVersion: this.archive.planVersion });
    clearTimeout(this.idlePeerTimer); this.idlePeerTimer = undefined;
    clearTimeout(this.explorationTimer?.timer); this.explorationTimer = undefined;
    for (const worker of this.input.workers) this.clearDispatchWait(worker, 'stopped');
    this.wake();
    clearInterval(this.timer);
    await this.guidancePulse;
    await this.humanGuidanceCheckpoint(true);
    let pending: ReadonlyMap<string, Promise<void>> | undefined;
    try { pending = await this.pendingPulse; } catch (error) { if (!this.input.signal.aborted) throw error; }
    const drained = new Set<Promise<unknown>>();
    let failure: unknown;
    for (;;) {
      const work = [...new Set<Promise<unknown>>([...(pending?.values() ?? []), ...(this.pendingPulse ? [this.pendingPulse] : []),
        ...this.deliveryChecks.values(), ...[...this.proofPublications.values()].map(publication => publication.pending),
        ...this.proofDeliveryChecks, ...this.planSynchronizations,
        ...this.leadDeliveries, ...[...this.preparingTaskTypes.values()].map(pending => pending.settled),
        ...(this.preparingStatements ? [this.preparingStatements] : []), this.integrationQueue])]
        .filter(item => !drained.has(item));
      if (!work.length) break;
      work.forEach(item => drained.add(item));
      const checks = await Promise.allSettled(work);
      const failed = checks.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') failure ??= failed.reason;
      await Promise.resolve();
    }
    if (failure && !this.input.signal.aborted) throw failure;
    await Promise.allSettled([...this.notifications]);
    this.syncPlanNotes();
    if (!this.input.signal.aborted) this.archive.canonicalCommit = this.seed(this.lead, this.archive.canonicalCommit!);
    this.input.save();
  }
  async pulse(workerId?: string): Promise<void> {
    await this.humanGuidanceCheckpoint();
    if (workerId) await this.deliveryChecks.get(workerId);
    const pending = await this.inputs();
    const checks = await Promise.allSettled(workerId ? [pending.get(workerId)] : [...pending.values()]);
    const failed = checks.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  async restore() {
    if (this.refreshFeasibilityAssignments()) this.changed();
    for (const node of this.archive.tasks) if (['pending', 'running'].includes(node.status)) this.restoreTaskSourceRepair(node);
    for (const failed of this.archive.failedTaskInputs ?? []) {
      let repair = failed.repair;
      const node = this.node(repair?.taskId ?? failed.taskId);
      if (!repair && node && node.attempts === 1 && ['pending', 'running'].includes(node.status) &&
          failed.taskDigest === digest(node.task) && node.assignment?.taskDigest === failed.taskDigest) {
        repair = failed.repair = { taskId: node.task.id, taskDigest: failed.taskDigest,
          workerId: node.assignment.workerId, pending: true };
        this.input.emit('task_repair_requested', { taskId: node.task.id, workerId: repair.workerId,
          taskDigest: repair.taskDigest, reason: 'failed-check-restored' });
      }
      if (!repair || repair.pending || !node || !['pending', 'running'].includes(node.status) ||
          repair.taskDigest !== digest(node.task) || repair.workerId !== node.assignment?.workerId || repair.startedAttempt !== node.attempts) continue;
      repair.pending = true; delete repair.startedAttempt;
      this.input.emit('task_repair_interrupted', { taskId: node.task.id, workerId: repair.workerId, failureId: failed.id, reason: 'process-restored' });
    }
    this.syncPlanNotes();
    for (const review of this.archive.statementReviews ?? []) if (review.status !== 'superseded') {
      try { assertStatementSnapshot(review); }
      catch { this.supersedeStatementReview(review); continue; }
      resetStatementReview(review);
    }
    // A resumed review must inspect the fixed version again.
    if (this.archive.review) { this.archive.review.status = 'pending'; this.archive.review.workerId = undefined; }
    const publication = this.archive.planPublication ?? this.archive.initialPlanPublication;
    // A finalized dispatch can still leave inherited notes behind the accepted graph.
    if (!publication &&
        fs.existsSync(path.join(this.lead.worktree, 'RESEARCH.md'))) {
      try {
        const rejection = this.archive.planRejection;
        if (!rejection?.stalled || rejection.proposalDigest !== this.proposedPlanDigest() ||
            rejection.inputDigest !== this.planningInputDigest()) {
          const plan = this.readLeadPlan();
          const initial = !this.archive.tasks.length;
          await this.acceptPlan(plan);
          if (initial) dropLeadWakes(this.archive.leadWakes!);
        }
      } catch (error) { this.rejectPlan(error); }
    }
    if (!solverSourceFeedback(this.input.state.problem, this.lead.worktree)) {
      await this.restoreLeadSources();
      const integrated = this.archive.tasks.filter(node => node.status === 'integrated');
      this.markPendingValidation(integrated, new Set(integrated.map(node => node.task.id)));
      if (integrated.length || this.archive.edits?.some(edit => edit.pendingSync)) await this.schedulePlanSynchronization();
      await this.input.exclusiveCheck(() => this.recheckConditional());
    } else {
      for (const node of this.archive.tasks.filter(node => node.status === 'integrated')) {
        this.moveTask(node, 'blocked', 'invalidated'); node.feedback = 'math_canonical_source_invalid';
      }
      this.wakeLead('canonical-source-invalid');
    }
    for (const node of this.archive.tasks) if (node.status === 'running') this.moveTask(node, 'pending', 'interrupted');
    for (const node of this.archive.tasks.filter(node => node.status === 'delivered')) await this.integrate(node);
    await this.integrateReady();
    const statements = this.prepareStatementContexts(); if (statements) await statements;
    this.syncStatementReviews();
    if (publication) {
      // Preserve the draft in restoreLeadSources, then seed future decisions from the accepted graph.
      this.archive.planEdited = true; this.syncPlanNotes();
    }
    this.changed();
    const residue = restoreResidue(this.archive);
    if (residue.length) this.input.emit('restore_residue', { violations: residue });
  }
  private dispatchBudgetExhausted(budget: DispatchBudget, modelAllowed: boolean) {
    return this.input.state.turns >= budget.maxTurns || budget.remainingMs <= 0 || !modelAllowed;
  }
  private async exhaustedDispatch(budget: DispatchBudget, modelAllowed: boolean, running = false): Promise<DispatchResult> {
    const refund = modelAllowed && budget.remainingMs > 0 && this.waitForTurn(budget.maxTurns);
    if (refund) { await refund; return RETRY_DISPATCH; }
    if (running) return this.waitForDispatch();
  }
  protected canAssemble(commit: string) {
    if (commit !== this.archive.canonicalCommit || this.candidateSynchronizationBlocked()) return false;
    const goals = this.archive.tasks.filter(node => node.task.kind === 'goal');
    return this.reviewed() || goals.length > 0 && goals.every(node => node.status === 'integrated');
  }
  async next(worker: ResearchWorker, budget: DispatchBudget): Promise<CooperativeAction | undefined> {
    this.goalProgressBudget = { maxTurns: budget.maxTurns, deadline: Date.now() + budget.remainingMs };
    if (this.refreshGoalProgress()) this.changed();
    for (;;) {
      if (this.stopping) return;
      this.input.signal.throwIfAborted();
      if (this.failure) throw this.failure;
      if (this.refreshCapacityExplorations()) this.changed();
      if (this.refreshFeasibilityAssignments()) this.changed();
      this.refreshResearchCheckpoints();
      if (this.refreshFailedTaskInputs()) this.changed();
      if (this.refreshInvalidTaskTypes()) this.changed();
      if (this.refreshGoalPathStall()) this.changed();
      if (!this.liveWorkers.has(this.lead.id)) {
        this.recordDispatchWait(worker, { stage: 'lead-unavailable', candidates: [], candidateCount: 0, omittedCandidates: 0 });
        return;
      }
      const modelAllowed = this.input.modelDispatchAllowed?.() !== false;
      const result = await (worker.id === this.lead.id
        ? this.nextLead(worker, budget, modelAllowed) : this.nextPeer(worker, budget, modelAllowed));
      if (result !== RETRY_DISPATCH) return result;
    }
  }
  private async nextLead(worker: ResearchWorker, budget: DispatchBudget, modelAllowed: boolean): Promise<DispatchResult> {
    if (this.synchronizationPending()) {
      this.recordDispatchWait(worker, { stage: 'synchronizing', candidates: [], candidateCount: 0, omittedCandidates: 0 });
      return this.waitForDispatch();
    }
    if (this.planApprovalPending()) {
      // Nothing runs until a person approves; only their own note to the Lead earns a revision turn.
      if (this.dispatchBudgetExhausted(budget, modelAllowed)) return this.exhaustedDispatch(budget, modelAllowed, this.active.size > 0 || this.proofPublications.size > 0);
      const guidance = this.pendingLeadGuidance(this.archive.planApproval?.guidanceIds);
      if (!guidance.length) return this.waitForDispatch();
      const record = this.archive.planApproval ??= {};
      record.guidanceIds = [...record.guidanceIds ?? [], ...guidance].slice(-512); record.revisionAt = Date.now();
      this.input.emit('plan_approval_revision', { guidanceIds: guidance, planVersion: this.archive.planVersion });
      return this.leadDecision(worker, this.archive.canonicalCommit!, this.planningInputDigest());
    }
    if (this.pendingFixedStatementReviews()) {
      if (!this.livePeers.length || budget.remainingMs <= 0 ||
          this.input.state.turns >= budget.maxTurns && !this.reservedTurns.size || !modelAllowed && !this.active.size) return;
      return this.waitForDispatch();
    }
    const head = this.archive.canonicalCommit!;
    if (this.canAssemble(head) && this.lastAssembly !== head) {
      this.syncPlanNotes();
      const seed = this.seed(worker, head); this.archive.canonicalCommit = seed;
      this.cancelStaleTaskTypes();
      this.lastAssembly = seed; return { kind: 'assemble', seedCommit: seed };
    }
    const running = this.preparingTaskTypes.size > 0 || this.active.size > 0 || this.proofPublications.size > 0 || this.archive.tasks.some(node => ['running', 'delivered'].includes(node.status) ||
      (node.status === 'conditional' && taskDependenciesReady(node.task, this.archive.tasks))) || this.archive.review?.status === 'running' ||
      this.archive.statementReviews?.some(review => ['translating', 'reviewing'].includes(review.status) ||
        (modelAllowed && this.input.state.turns < budget.maxTurns && budget.remainingMs > 0 &&
          ['pending', 'translated'].includes(review.status) && this.livePeers.length > 0 &&
          this.statementReviewAllowed(this.node(review.taskId).task, true)));
    if (this.dispatchBudgetExhausted(budget, modelAllowed)) return this.exhaustedDispatch(budget, modelAllowed, running);
    if (!running && !this.livePeers.length) return;
    if (this.archive.review && ['pending', 'running'].includes(this.archive.review.status)) return this.waitForDispatch();
    if (this.pendingLeadGuidance().length) return this.leadDecision(worker, head, this.planningInputDigest());
    this.wakeForIdlePeers();
    const wakes = this.archive.leadWakes!, through = wakes.requested;
    const pendingProgress = this.archive.goalProgress?.pending;
    const owedProgress = pendingProgress && (pendingProgress.retryAt ?? 0) <= Date.now();
    // Conditions recomputed from durable state; only one-shot events are saved wake-ups.
    let wake = leadWakePending(wakes);
    // Idle peers are not in the planning digests, so their unconsumed wake must not be deduplicated away.
    const owedIdle = (wakes.recent ?? []).some(item => item.reason === 'peers-idle' && item.seq > wakes.consumed && item.seq <= through);
    const rejection = this.archive.planRejection;
    if (rejection?.stalled && !owedProgress) {
      if (rejection.inputDigest === this.planningInputDigest() && rejection.proposalDigest === this.proposedPlanDigest()) {
        dropLeadWakes(wakes, through);
        if (!running && !this.canAdvance()) {
          if (this.input.continuousResearch) return this.idleFrontier(this.activeGoalFrontier(), rejection.inputDigest);
          this.input.emit('plan_stalled', { ...rejection }); return;
        }
        return this.waitForDispatch();
      }
      wake = true;
    }
    if (this.archive.lastLeadPauseInputDigest &&
        this.archive.lastLeadPauseInputDigest !== this.leadPauseInputDigest()) wake = true;
    // An original goal whose whole frontier cannot run is owed one Lead turn, even when that Lead's own decision
    // (a pause, say) produced it and other workers are busy elsewhere. It wakes after the existing reconsideration
    // paths so their events still name the frontier they reopen, and after work already running on the stalled
    // goal's own route settles, since that result is part of what the turn must answer.
    const goalPathStall = this.unansweredGoalPathStall();
    const owedStall = goalPathStall && !this.goalPathStallWorkRunning() ? goalPathStall : undefined;
    if (!wake && this.archive.tasks.length) {
      const support = originalGoalTaskFocus(this.archive.tasks, this.archive.groups).support;
      const supportingWork = this.archive.tasks.some(node => support.has(node.task.id) &&
        (this.preparingTaskTypes.has(node) || ['running', 'delivered'].includes(node.status) ||
          node.status === 'conditional' && taskDependenciesReady(node.task, this.archive.tasks))) ||
        this.archive.statementReviews?.some(review => support.has(review.taskId) &&
          ['pending', 'translating', 'translated', 'reviewing'].includes(review.status));
      // Independent work must not defer reconsidering a stalled original argument; it is an ordinary plan turn.
      if (!supportingWork && !this.hasAssignableTask(support) && !this.canAdvance(support)) {
        const frontier = this.activeGoalFrontier(), inputDigest = this.planningInputDigest();
        if (frontier.some(item => item.status === 'blocked' && item.attempts > 0) && inputDigest !== this.archive.lastLeadInputDigest) {
          wake = true;
          this.input.emit('blocked_tasks_reconsidered', { taskIds: frontier.map(item => item.taskId),
            goalIds: [...new Set(frontier.flatMap(item => item.goalIds))], inputDigest });
        }
      }
    }
    if (!running && !wake && this.archive.tasks.length && (!this.archive.review || this.archive.review.status === 'changes_requested') &&
        !this.canAdvance()) {
      // Parking prevents repeating an inference, not reconsidering its unfinished original goal.
      const frontier = this.activeGoalFrontier();
      const inputDigest = this.planningInputDigest();
      if (!frontier.length || inputDigest === this.archive.lastLeadInputDigest) {
        if (!owedStall && !owedProgress) return this.idleFrontier(frontier, inputDigest);
        // A mechanical resume of unattempted inputs comes before asking the Lead about the stall.
        if (!this.preparingTaskTypes.size && this.resumeUnattemptedFrontier(frontier)) return RETRY_DISPATCH;
      } else {
        wake = true;
        this.input.emit('blocked_tasks_reconsidered', { taskIds: frontier.map(item => item.taskId),
          goalIds: [...new Set(frontier.flatMap(item => item.goalIds))], inputDigest });
      }
    }
    if (owedStall || owedProgress) wake = true;
    if (wake || (!running && (!this.livePeers.length || !this.hasAssignableTask()))) {
      const inputDigest = this.planningInputDigest();
      // The previous decision (or pause) already answers these inputs; drop the wake-ups without a turn.
      if (inputDigest === this.archive.lastLeadInputDigest && !this.archive.error && !owedStall && !owedIdle && !owedProgress) {
        dropLeadWakes(wakes, through);
        return !running && !this.hasAssignableTask() ? this.idleFrontier(this.activeGoalFrontier(), inputDigest) : RETRY_DISPATCH;
      }
      if (this.archive.tasks.length && this.archive.lastLeadPauseInputDigest === this.leadPauseInputDigest() && !owedStall && !owedIdle && !owedProgress) {
        dropLeadWakes(wakes, through);
        return !running && !this.hasAssignableTask()
          ? this.idleFrontier(this.activeGoalFrontier(), inputDigest) : this.waitForDispatch();
      }
      consumeLeadWakes(wakes, through);
      const action = this.leadDecision(worker, head, inputDigest);
      if (goalPathStall) this.input.emit('goal_path_stall_dispatched', { digest: goalPathStall });
      return action;
    }
    return this.waitForDispatch();
  }
  private leadDecision(worker: ResearchWorker, head: string, inputDigest: string): CooperativeAction {
    this.syncPlanNotes();
    const planVersion = this.archive.planVersion ??= this.planVersion();
    const action: CooperativeAction = { kind: 'lead', seedCommit: this.seed(worker, head), planVersion,
      planningInputDigest: inputDigest, responsibilityDigest: this.leadResponsibilityDigest(),
      ...(!this.archive.tasks.length && !this.archive.initialPlanPublication ? { initialPlanNonce: crypto.randomUUID() } : {}),
      ...(this.archive.tasks.length ? { planNonce: crypto.randomUUID() } : {}) };
    this.leadEvidence.set(action, this.planningEvidenceDigest());
    const research = leadResearchInputs(this.archive.deliveries ?? [],
      new Map(this.archive.tasks.map(node => [node.task.id, node])), this.archive.researchDecisions);
    this.presentedResearchInputs.set(action, { shown: research.slice(-8), total: research.length });
    this.leadPauseInputs.set(action, this.leadPauseInputDigest(action.seedCommit));
    const presented = this.presentedGoalPathStall();
    if (presented) this.presentedGoalPathStalls.set(action, presented);
    this.presentGoalProgressReview(action);
    return action;
  }
  /** Undelivered unscoped notes for this Lead; approval revisions exclude notes already dispatched. */
  private pendingLeadGuidance(answeredIds: readonly string[] = []): string[] {
    const answered = new Set(answeredIds);
    let records: ReturnType<typeof readHumanGuidance>;
    try { records = readHumanGuidance(path.join(path.dirname(this.lead.worktree), 'state.json'), this.input.state.runId); }
    catch { return []; }
    return records.filter(record => record.recipient.kind === 'lead' && (!record.recipient.id || record.recipient.id === this.lead.id) && !record.taskRef &&
      ['queued', 'deferred'].includes(record.status) && !answered.has(record.id)).map(record => record.id);
  }
  /** Work on a stalled goal's own route that settles without the Lead: a run, delivery, ready recheck, type or statement check. */
  private goalPathStallWorkRunning() {
    const route = this.goalPathStallTasks;
    return this.archive.tasks.some(node => route.has(node.task.id) &&
      (this.preparingTaskTypes.has(node) || ['running', 'delivered'].includes(node.status) ||
        node.status === 'conditional' && taskDependenciesReady(node.task, this.archive.tasks))) ||
      Boolean(this.archive.statementReviews?.some(review => route.has(review.taskId) && ['translating', 'reviewing'].includes(review.status)));
  }
  private taskDispatchBlock(node: TaskRecord): 'preparing-type' | 'synchronizing' | 'capacity-expired' | undefined {
    if (this.preparingTaskTypes.has(node)) return 'preparing-type';
    if (this.synchronizationBlocked(node.task)) return 'synchronizing';
    if (node.capacityExploration && !currentCapacityExploration(node, this.archive.tasks, this.explorationIdentity))
      return 'capacity-expired';
  }
  private recordTaskWait(worker: ResearchWorker, ranked: readonly TaskRecord[], ready: readonly TaskRecord[]) {
    const dependencies = !ranked.length ? this.archive.tasks.filter(node =>
      ['pending', 'blocked'].includes(node.status) && assessTaskResponsibility(node, worker, this.responsibility).kind === 'matches' &&
      routeAllowsTask(node.task, this.archive.tasks, this.archive.groups) && !this.synchronizationBlocked(node.task) &&
      !taskCanStart(node.task, this.archive.tasks, this.archive.groups)) : [];
    if (dependencies.length) {
      this.recordDispatchWait(worker, { stage: 'dependency-blocked', candidateCount: dependencies.length,
        omittedCandidates: Math.max(0, dependencies.length - 16), candidates: dependencies.slice(0, 16).map(node => ({
          taskId: node.task.id, taskDigest: digest(node.task), reason: 'dependency' })) });
      return;
    }
    const candidates: DispatchWaitObservation['candidates'] = ranked.slice(0, 16).map(node => {
      const hostBlock = this.taskDispatchBlock(node);
      const assessment = assessTaskResponsibility(node, worker, this.responsibility);
      return { taskId: node.task.id, taskDigest: digest(node.task),
        reason: hostBlock ?? (assessment.kind === 'blocked' ? assessment.reason : 'policy-no-selection') };
    });
    this.recordDispatchWait(worker, { stage: !ranked.length ? 'm3-no-ready' : !ready.length ? 'host-filtered' : 'm5-no-selection',
      candidateCount: ranked.length, omittedCandidates: ranked.length - candidates.length, candidates });
  }
  private async nextPeer(worker: ResearchWorker, budget: DispatchBudget, modelAllowed: boolean): Promise<DispatchResult> {
    if (budget.remainingMs <= 0 || !modelAllowed || this.input.state.turns >= budget.maxTurns) {
      this.recordDispatchWait(worker, { stage: 'budget-gated',
        gate: budget.remainingMs <= 0 ? 'time-limit' : !modelAllowed ? 'model-disabled' : 'turn-limit',
        candidates: [], candidateCount: 0, omittedCandidates: 0 });
      return budget.remainingMs <= 0 || !modelAllowed ? undefined : this.exhaustedDispatch(budget, modelAllowed);
    }
    if (this.planApprovalPending()) {
      this.recordDispatchWait(worker, { stage: 'plan-approval', candidates: [], candidateCount: 0, omittedCandidates: 0 });
      return this.waitForDispatch();
    }
    const review = this.archive.review;
    const reviewer = this.reviewer();
    const statement = reviewer?.id === worker.id && this.archive.statementReviews?.find(item =>
      ['pending', 'translated'].includes(item.status) && this.statementReviewAllowed(this.node(item.taskId).task, true) &&
      ![...this.active.values()].some(active => isStatementAction(active.action) && active.action.reviewId === item.id));
    if (statement) {
      this.clearDispatchWait(worker, 'selected');
      const kind = statement.status === 'pending' ? 'backtranslate' : 'statement-review';
      fs.rmSync(path.join(statement.workspace, 'RESEARCH.md'), { force: true });
      statement.status = kind === 'backtranslate' ? 'translating' : 'reviewing'; statement.workerId = worker.id;
      statement.assignmentId = crypto.randomUUID();
      this.input.emit('statement_review_assigned', { workerId: worker.id, taskId: statement.taskId, reviewId: statement.id, kind, role: 'reviewer' });
      this.changed(); return { kind, reviewId: statement.id, taskId: statement.taskId, taskDigest: statement.taskDigest,
        snapshotDigest: statement.snapshotDigest, seedCommit: statement.commit, workspace: statement.workspace,
        assignmentId: statement.assignmentId };
    }
    if (review?.status === 'pending' && reviewer?.id === worker.id && !this.candidateSynchronizationBlocked()) {
      this.clearDispatchWait(worker, 'selected');
      this.seed(worker, review.commit);
      const notes = path.join(worker.worktree, 'RESEARCH.md');
      if (fs.existsSync(notes)) fs.writeFileSync(notes, fs.readFileSync(notes, 'utf8').replace(/```(?:math|math-review)\s*\n[\s\S]*?\n```/gu, ''));
      review.workerId = worker.id; review.status = 'running'; review.assignmentId = crypto.randomUUID();
      this.input.emit('review_assigned', { workerId: worker.id, commit: review.commit, role: 'reviewer' });
      this.changed(); return { kind: 'review', seedCommit: review.commit, sourceDigest: review.sourceDigest,
        assignmentId: review.assignmentId };
    }
    const ranked = this.input.modules.M3.ready(this.archive.tasks, this.archive.groups);
    const ready = ranked.filter(node => !this.taskDispatchBlock(node));
    this.releaseStoppedAssignments(ready, worker);
    const node = this.input.modules.M5.assign(ready, worker,
      this.allocationPeers, this.archive.groups, this.archive.tasks, this.stoppedWorkers);
    if (!node) {
      this.recordTaskWait(worker, ranked, ready);
      if (await this.requestCapacityExploration(worker, budget, ready)) return RETRY_DISPATCH;
      return this.liveWorkers.has(worker.id) ? this.waitForDispatch() : undefined;
    }
    if (!ready.includes(node) || !this.archive.tasks.includes(node) || node.status !== 'pending' ||
        !taskCanStart(node.task, this.archive.tasks, this.archive.groups) ||
        !routeAllowsTask(node.task, this.archive.tasks, this.archive.groups) ||
        assessTaskResponsibility(node, worker, this.responsibility).kind !== 'matches') throw new Error('math_task_assignment_invalid');
    this.clearDispatchWait(worker, 'selected');
    const selectedRoute = selectedTaskRoute(node, this.archive.tasks);
    if (node.assignment && node.alternativeRoutes?.length && node.assignment.routeId !== selectedRoute?.id)
      node.assignment = undefined;
    let resuming = node.assignment?.workerId === worker.id;
    if (resuming && advisory(node.task) &&
        (this.archive.researchDrafts?.[node.task.id]?.suspended || this.researchWorkspaceChanged(worker, node))) {
      const previousAssignment = node.assignment;
      const restored = await this.restoreResearchDraft(worker, node);
      if (this.synchronizationBlocked(node.task) || !this.archive.tasks.includes(node) || node.status !== 'pending' ||
          !restored && node.assignment !== previousAssignment ||
          assessTaskResponsibility(node, worker, this.responsibility).kind !== 'matches' ||
          !taskCanStart(node.task, this.archive.tasks, this.archive.groups) || !routeAllowsTask(node.task, this.archive.tasks, this.archive.groups)) return RETRY_DISPATCH;
      if (!restored) {
        fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), '');
        node.assignment = undefined; resuming = false;
        if (this.archive.researchCheckpoints) delete this.archive.researchCheckpoints[node.task.id];
        node.feedback = 'math_research_draft_unavailable: No matching saved draft is available; continue from the current canonical sources and save findings for this assignment.';
        this.input.emit('research_draft_unavailable', { taskId: node.task.id, workerId: worker.id });
      }
    }
    this.suspendResearchDrafts(worker, node.task.id);
    const seed = this.archive.canonicalCommit!;
    const scopedSeed = resuming ? seed : this.seed(worker, seed, node.task);
    const dispatchAssignment: TaskAssignment = node.assignment ?? { taskId: node.task.id, taskDigest: digest(node.task), workerId: worker.id,
      seedCommit: scopedSeed, assignmentId: crypto.randomUUID(), canonicalCommit: seed, groupId: taskGroup(node.task),
      routeId: selectedRoute?.id,
      dependencies: this.dependencies(node.task).map(item => ({ taskId: item.task.id, taskDigest: digest(item.task) })) };
    if (node.task.kind === 'lemma' || node.task.kind === 'goal' && this.input.access.get(worker.id)?.installedLibrary) {
      const task = node.task, taskDigest = digest(task), environment = this.input.state.environmentDigest;
      const dependencies = this.typePreflightDependencies(task), head = git(worker.worktree, ['rev-parse', 'HEAD']);
      const project = path.join(worker.worktree, this.input.state.problem.projectRelative), started = Date.now();
      const routeDigest = canonicalMathJson(selectedRoute ?? null);
      const assignment = node.assignment, workerAccess = this.input.access.get(worker.id), leadAccess = this.input.access.get(this.lead.id);
      const problemReceipt = this.input.state.problem.receiptDigest;
      const controller = new AbortController(), signal = AbortSignal.any([this.input.signal, controller.signal]);
      const preparationGroups = () => {
        const publishing = [...this.proofPublications.values()].some(publication => publication.action.assignment === dispatchAssignment);
        // Publication already occupies this worker's group slot. Test whether the
        // preparation can keep that slot, without charging itself a second one.
        return publishing ? this.archive.groups?.map(route => route.group.id === taskGroup(task)
          ? { ...route, busy: Math.max(0, (route.busy ?? 0) - 1) } : route) : this.archive.groups;
      };
      const current = () => !signal.aborted && !this.stopping && !this.failure && this.liveWorkers.has(this.lead.id) &&
        this.archive.canonicalCommit === seed && this.archive.tasks.includes(node) && digest(node.task) === taskDigest &&
        this.typePreflightDependencies(task) === dependencies && this.input.access.get(worker.id) === workerAccess &&
        this.input.access.get(this.lead.id) === leadAccess && this.input.state.problem.receiptDigest === problemReceipt &&
        this.input.state.environmentDigest === environment && node.status === 'pending' && node.assignment === assignment &&
        !this.synchronizationBlocked(node.task) && taskCanStart(node.task, this.archive.tasks, this.archive.groups) &&
        routeAllowsTask(node.task, this.archive.tasks, preparationGroups()) && this.liveWorkers.has(worker.id) &&
        assessTaskResponsibility(node, worker, this.responsibility).kind === 'matches' &&
        canonicalMathJson(selectedTaskRoute(node, this.archive.tasks) ?? null) === routeDigest &&
        this.input.modelDispatchAllowed?.() !== false &&
        !this.dispatchBudgetExhausted(budget, true) && Date.now() - started < budget.remainingMs;
      // Cancellation keeps the worker occupied until the Lean check has cleaned up.
      let finishPreparation!: () => void;
      const settled = new Promise<void>(resolve => { finishPreparation = resolve; });
      this.preparingTaskTypes.set(node, { workerId: worker.id, controller, current, settled });
      this.changed();
      try {
        const checker = this.input.modules.M2.checkTask ?? checkTaskProof;
        const retainedGoals = () => this.retainedTaskGoals(task, this.archive.tasks, worker.worktree, head);
        const publishable = () => current() && taskDependenciesReady(task, this.archive.tasks) &&
          git(worker.worktree, ['rev-parse', 'HEAD']) === head &&
          this.input.modules.M5.assign([node], worker, this.allocationPeers, this.archive.groups, this.archive.tasks, this.stoppedWorkers) === node;
        const claim = () => {
          // Publication owns cleanup from here; changing the assignment must not cancel its own preparation.
          this.preparingTaskTypes.delete(node);
          node.assignment = dispatchAssignment;
        };
        const applyLibrary = this.input.modules.M2.applyLibrary, library = workerAccess?.installedLibrary;
        const libraryKey = canonicalMathJson([taskDigest, scopedSeed, environment, library?.digest ?? null]);
        if (applyLibrary && library && leadAccess && workerAccess && !node.assignment && !isDefinitionTask(task) &&
            !task.conditional && !automaticTaskConnection(task, this.archive.tasks, this.archive.groups) &&
            taskDependenciesReady(task, this.archive.tasks) && !this.libraryApplicationAttempts.has(libraryKey)) {
          this.libraryApplicationAttempts.add(libraryKey);
          const applicationStarted = Date.now();
          const application = await applyLibrary({ problem: this.input.state.problem, task, library, taskText: this.input.taskText, environmentDigest: environment,
            worktree: worker.worktree, seedCommit: scopedSeed });
          if (!current()) { this.libraryApplicationAttempts.delete(libraryKey); return RETRY_DISPATCH; }
          let proof, checkError: string | undefined;
          if (application.commit && application.status === 'candidate') {
            try {
              proof = await checker(this.input.state.problem, worker.worktree, application.commit, task, dispatchAssignment,
                retainedGoals(), leadAccess.environment, signal,
                Math.min(this.input.timeoutMs ?? Infinity, LIBRARY_APPLICATION_TIMEOUT_MS, budget.remainingMs - (Date.now() - started)),
                [], environment, ...(checker === checkTaskProof ? [this.taskProofCache] : []));
            } catch (error) {
              if (!current()) return RETRY_DISPATCH;
              checkError = bounded(error instanceof Error ? error.message : String(error), 1000);
            }
          }
          if (!publishable()) return RETRY_DISPATCH;
          const references = proof && knowledgeReferenceCoverage(task, proof);
          this.input.emit('task_library_application', { taskId: task.id, taskDigest, workerId: worker.id, seedCommit: scopedSeed,
            libraryDigest: library.digest, candidates: application.candidates, status: application.status, reason: application.reason,
            durationMs: Date.now() - applicationStarted, ...(checkError ? { checkError } : {}),
            ...(application.commit ? { commit: application.commit } : {}),
            ...(references ? { referenceCoverage: references.coverage, usedDeclarations: application.candidates.filter(candidate =>
              references.references?.some(reference => reference.name === candidate.name && reference.file === candidate.file)) } : {}),
            ...(proof ? { passed: proof.passed, verificationStatus: proof.verification.status,
              receiptIds: proof.verification.results.map(result => result.receiptId) } : {}) });
          if (proof?.passed) {
            await this.publishTaskProof(worker, { kind: 'task', task, assignment: dispatchAssignment }, application.commit!,
              'Host applied an installed library theorem to this exact task before starting a model.', {}, false,
              { proof, current: publishable, claim });
            return RETRY_DISPATCH;
          }
          if (proof || checkError) node.feedback = [bounded(node.feedback ?? '', 3000),
            'Host library application attempt (advisory): ' + JSON.stringify(application.candidates) + '\n' +
            bounded(checkError ?? solverProofFeedback(proof!), 2000) +
            '\nThese bounded exact/apply attempts did not close this task. Inspect the full interfaces and adapt the application or continue the proof.']
            .filter(Boolean).join('\n\n');
        }
        if (task.kind === 'lemma') {
          const checked: { result: TaskTypePreflight; current: () => boolean } = workerAccess ? await this.taskTypePreflight.check({ problem: this.input.state.problem, task,
            projectRoot: project,
            // A family type never names its own members, which do not exist in source until they are proved.
            dependencies: this.dependencies(task).map(item => item.task).filter(input => input.familyMember !== task.id), environmentDigest: environment,
            env: workerAccess.environment, signal,
            timeoutMs: this.input.timeoutMs ?? Infinity }) : {
              result: { status: 'unavailable', inputDigest: mathDigest(canonicalMathJson([taskDigest, environment, 'worker-environment-unavailable'])),
                taskDigest, reason: 'worker-environment-unavailable', evidence: 'advisory-type-elaboration', proofAcceptance: 'not-assessed' },
              current: () => !this.input.signal.aborted,
            };
          if (!current() || !checked.current() || git(worker.worktree, ['rev-parse', 'HEAD']) !== head ||
              this.input.modules.M5.assign([node], worker, this.allocationPeers, this.archive.groups, this.archive.tasks, this.stoppedWorkers) !== node)
            return RETRY_DISPATCH;
          node.typePreflight = checked.result;
          this.input.emit('task_type_preflight', { taskId: node.task.id, workerId: worker.id, ...checked.result });
          if (checked.result.status === 'invalid') {
            this.invalidTaskTypes.set(node, { canonical: seed, environment, taskDigest, dependencies, project, workerId: worker.id,
              environmentIdentity: taskTypePreflightEnvironmentIdentity(project, workerAccess!.environment) });
            this.moveTask(node, 'blocked', 'rejected');
            const excerpt = typeDiagnosticExcerpt(task.type!, checked.result.reason);
            node.feedback = 'math_task_type_invalid\n' + bounded(checked.result.reason, 2000) + (excerpt ? `\n${excerpt}` : '') +
              (checked.result.artifact ? `\nAdvisory type diagnostics in ${worker.id}'s worktree: ${checked.result.artifact.path} (${checked.result.artifact.digest})` : '') +
              '\nRevise the closed helper type or its context before proving it. This is not proof acceptance or a mathematical refutation.';
            this.wakeLead('task-type-invalid'); this.changed(); return RETRY_DISPATCH;
          }
          const publishable = () => current() && checked.current() && taskDependenciesReady(task, this.archive.tasks) &&
            git(worker.worktree, ['rev-parse', 'HEAD']) === head &&
            this.input.modules.M5.assign([node], worker, this.allocationPeers, this.archive.groups, this.archive.tasks, this.stoppedWorkers) === node;
          const assembleFamily = this.input.modules.M2.assembleFamily;
          const familyKey = canonicalMathJson([taskDigest, dependencies, environment]);
          if (assembleFamily && task.family && !node.assignment && leadAccess && workerAccess && checked.result.status === 'elaborated' &&
              checked.result.context && !this.familyAssemblyAttempts.has(familyKey)) {
            // One host assembly per exact family contract in this process; a failure falls through to a model.
            this.familyAssemblyAttempts.add(familyKey);
            const assemblyStarted = Date.now();
            const assembly = await assembleFamily({ problem: this.input.state.problem, task, worktree: worker.worktree,
              seedCommit: scopedSeed, context: checked.result.context });
            if (!current()) { this.familyAssemblyAttempts.delete(familyKey); return RETRY_DISPATCH; }
            // Unproved members (and other fixed lemma inputs) are bound exactly as in the ordinary conditional check.
            const conditions = this.assignmentConditions(task, dispatchAssignment);
            let proof, checkError: string | undefined;
            if (assembly.commit) {
              try {
                proof = await checker(this.input.state.problem, worker.worktree, assembly.commit, task, dispatchAssignment,
                  retainedGoals(), leadAccess.environment, signal, this.input.timeoutMs, conditions, environment,
                  ...(checker === checkTaskProof ? [this.taskProofCache] : []));
              } catch (error) {
                if (!current()) return RETRY_DISPATCH;
                checkError = bounded(error instanceof Error ? error.message : String(error), 600);
              }
            }
            this.input.emit('task_family_assembly', { taskId: task.id, taskDigest, workerId: worker.id, seedCommit: scopedSeed,
              status: assembly.status, reason: assembly.reason, durationMs: Date.now() - assemblyStarted,
              assumedInputs: conditions.map(input => input.id), ...(checkError ? { checkError } : {}),
              ...(assembly.commit ? { commit: assembly.commit } : {}), ...(proof ? { passed: proof.passed,
                verificationStatus: proof.verification.status, receiptIds: proof.verification.results.map(result => result.receiptId) } : {}) });
            // A conditional family starts before its members are checked, so this omits the dependency-readiness gate.
            const assembled = () => current() && checked.current() && git(worker.worktree, ['rev-parse', 'HEAD']) === head &&
              this.input.modules.M5.assign([node], worker, this.allocationPeers, this.archive.groups, this.archive.tasks, this.stoppedWorkers) === node;
            if (proof?.passed) {
              if (!assembled()) return RETRY_DISPATCH;
              await this.publishTaskProof(worker, { kind: 'task', task, assignment: dispatchAssignment }, assembly.commit!,
                'Host assembled this family lemma from its member lemmas before starting a model.' + (conditions.length
                  ? ` Its check binds its ${conditions.length} lemma input(s) as explicit hypotheses; the host rechecks it unconditionally once they integrate.` : ''),
                {}, false, { proof, current: assembled, claim });
              return RETRY_DISPATCH;
            }
            if (!assembled()) return RETRY_DISPATCH;
          }
          const canonicalCandidate = leadAccess && workerAccess && this.canonicalHelperCandidate(node, worker, scopedSeed);
          if (canonicalCandidate) {
            // A failed probe is not a model delivery. Keep it outside failure memory and archive acceptance.
            const probeStarted = Date.now();
            let proof;
            try {
              proof = await checker(this.input.state.problem, worker.worktree, scopedSeed, task, dispatchAssignment,
                retainedGoals(), leadAccess!.environment, signal, this.input.timeoutMs, [], environment,
                ...(checker === checkTaskProof ? [this.taskProofCache] : []));
            } catch (error) {
              if (!current()) return RETRY_DISPATCH;
              throw error;
            }
            if (!publishable()) return RETRY_DISPATCH;
            const receiptIds = proof.verification.results.map(result => result.receiptId);
            const feedback = !proof.passed ? bounded(solverProofFeedback(proof), 2000) : undefined;
            this.input.emit('task_canonical_probe', { taskId: task.id, taskDigest, workerId: worker.id, seedCommit: scopedSeed,
              passed: proof.passed, status: proof.verification.status, durationMs: Date.now() - probeStarted,
              receiptIds, ...(feedback ? { feedback } : {}) });
            if (proof.passed) {
              await this.publishTaskProof(worker, { kind: 'task', task, assignment: dispatchAssignment }, scopedSeed,
                'Existing canonical helper checked against this exact task before starting a model.', {}, false,
                { proof, current: publishable, claim });
              return RETRY_DISPATCH;
            }
            dispatchAssignment.canonicalProbe = { evidence: 'advisory-canonical-check', proofAcceptance: 'not-accepted',
              sourceCommit: scopedSeed, environmentDigest: environment, verificationStatus: proof.verification.status,
              receiptIds, feedback: feedback! };
          }
          const closeTask = this.input.modules.M2.closeTask;
          const batteryKey = canonicalMathJson([taskDigest, dependencies, environment]);
          if (closeTask && !canonicalCandidate && leadAccess && workerAccess && checked.result.status === 'elaborated' &&
              checked.result.context && !isDefinitionTask(task) && this.tacticBatteryCandidate(node) && !this.tacticBatteryAttempts.has(batteryKey)) {
            // One host attempt per exact helper contract in this process; a failure is not model feedback.
            this.tacticBatteryAttempts.add(batteryKey);
            const batteryStarted = Date.now();
            const battery = await closeTask({ problem: this.input.state.problem, task, worktree: worker.worktree, seedCommit: scopedSeed,
              context: checked.result.context, env: workerAccess.environment, signal,
              timeoutMs: Math.min(this.input.timeoutMs ?? Infinity, TACTIC_BATTERY_TIMEOUT_MS) });
            // A superseded preparation has not tried this contract; leave it to the next eligible dispatch.
            if (!current()) { this.tacticBatteryAttempts.delete(batteryKey); return RETRY_DISPATCH; }
            let proof, checkError: string | undefined;
            if (battery.status === 'closed' && battery.commit) {
              try {
                proof = await checker(this.input.state.problem, worker.worktree, battery.commit, task, dispatchAssignment,
                  retainedGoals(), leadAccess.environment, signal, this.input.timeoutMs, [], environment,
                  ...(checker === checkTaskProof ? [this.taskProofCache] : []));
              } catch (error) {
                // Host automation never blocks the ordinary model assignment.
                if (!current()) return RETRY_DISPATCH;
                checkError = bounded(error instanceof Error ? error.message : String(error), 600);
              }
            }
            this.input.emit('task_tactic_battery', { taskId: task.id, taskDigest, workerId: worker.id, seedCommit: scopedSeed,
              status: battery.status, reason: battery.reason, durationMs: Date.now() - batteryStarted, ...(checkError ? { checkError } : {}),
              ...(battery.commit ? { commit: battery.commit } : {}), ...(battery.artifact ? { artifact: battery.artifact } : {}),
              ...(battery.vacuous ? { vacuous: true } : {}), ...(proof ? { passed: proof.passed, verificationStatus: proof.verification.status,
                receiptIds: proof.verification.results.map(result => result.receiptId) } : {}) });
            if (proof?.passed) {
              if (!publishable()) return RETRY_DISPATCH;
              await this.publishTaskProof(worker, { kind: 'task', task, assignment: dispatchAssignment }, battery.commit!,
                'Host tactic battery closed this exact helper type before starting a model.' + (battery.vacuous
                  ? ' Host vacuity probe: its hypotheses alone derive False, so no consumer can discharge them; ' +
                    'revise the helper unless it is an intended impossible case.' : ''), {}, false,
                { proof, current: publishable, claim });
              return RETRY_DISPATCH;
            }
            if (!publishable()) return RETRY_DISPATCH;
          }
        }
      } finally {
        this.preparingTaskTypes.delete(node); finishPreparation(); this.changed();
      }
    }
    node.assignment ??= dispatchAssignment;
    if (!node.assignment.connectionCheck && automaticTaskConnection(node.task, this.archive.tasks, this.archive.groups)) {
      // Upgrading an idle historical assignment keeps its saved draft but supersedes late publications.
      if (resuming) node.assignment = { ...node.assignment, assignmentId: crypto.randomUUID() };
      node.assignment.connectionCheck = createTaskConnectionCheck(node.task, node.assignment, this.archive.tasks,
        { environmentDigest: this.input.state.environmentDigest, problemReceiptDigest: this.input.state.problem.receiptDigest },
        dependency => committedSource(worker.worktree, node.assignment!.seedCommit,
          `${this.input.state.problem.projectRelative}/${dependency.proofPath}`));
      this.input.emit('task_connection_check_assigned', { taskId: node.task.id, workerId: worker.id,
        connectionCheck: node.assignment.connectionCheck });
    }
    if (!advisory(node.task) &&
        fs.existsSync(path.join(worker.worktree, this.input.state.problem.projectRelative, '.lake/source-constraints.json'))) {
      const problem = this.input.state.problem;
      // Local diagnostics should reject the same unrelated goal edits as task delivery,
      // before the worker spends time compiling a candidate it cannot submit.
      const declarations = Object.fromEntries(Object.entries(problem.declarations).map(([file, originals]) => {
        // Library modules are byte-frozen as a whole; their declarations need no per-task bodies.
        if (problem.frozenFiles && Object.hasOwn(problem.frozenFiles, file)) return [file, originals];
        const source = committedSource(worker.worktree, node.assignment!.seedCommit, `${problem.projectRelative}/${file}`);
        const matching = originalDeclarationRegions(source);
        return [file, originals.map(original => {
          if (original.body || file === node.task.proofPath &&
              original.name.split('.').at(-1) === node.task.theoremName?.split('.').at(-1)) return original;
          const region = matching(original)[0]!;
          return { ...original, body: mathDigest(source.slice(region.bodyOffset, region.endOffset).trim()) };
        })];
      }));
      writeMathJsonDurable(path.join(worker.worktree, problem.projectRelative, '.lake/source-constraints.json'),
        solverSourceConstraints(problem, declarations), 0o400);
    }
    this.moveTask(node, 'running', 'dispatched');
    const route = this.archive.groups?.find(record => record.group.id === taskGroup(node.task));
    this.input.emit('task_assigned', { taskId: node.task.id, workerId: worker.id, kind: node.task.kind,
      taskDigest: node.assignment.taskDigest, assignmentKey: assignmentDeliveryFile(node.assignment),
      planVersion: this.archive.planVersion, groupId: taskGroup(node.task), groupTurns: route?.turns,
      seedCommit: node.assignment.seedCommit });
    this.changed(); return { kind: 'task', assignment: node.assignment, task: node.task };
  }
  /** Host proof attempts start only from a fresh, unconditional typed helper whose dependencies are checked. */
  private tacticBatteryCandidate(node: TaskRecord): boolean {
    const task = node.task;
    return !node.assignment && !task.conditional && Boolean(task.type?.trim()) && taskDependenciesReady(task, this.archive.tasks) &&
      !automaticTaskConnection(task, this.archive.tasks, this.archive.groups);
  }
  /** Declaration scanning only selects complete candidates; the checker still establishes proof and exact type. */
  private canonicalHelperCandidate(node: TaskRecord, worker: ResearchWorker, seed: string): boolean {
    const task = node.task;
    if (!this.tacticBatteryCandidate(node)) return false;
    const source = committedSource(worker.worktree, seed, `${this.input.state.problem.projectRelative}/${task.proofPath}`);
    // The current task projector also requires a unique leaf name within this file.
    const declarations = inspectScopedLeanDeclarations(source).filter(item =>
      item.name.split('.').at(-1) === task.theoremName!.split('.').at(-1));
    if (declarations.length !== 1 || declarations[0].kind !== (isDefinitionTask(task) ? 'definition' : 'theorem') ||
        declarations[0].qualifiedName !== task.theoremName) return false;
    const region = inspectLeanDeclarationRegions(source).find(item => item.startOffset === declarations[0].startOffset)!;
    const inspected = inspectLeanSource(source.slice(region.bodyOffset, region.endOffset));
    return inspected.sorryCount === 0 && inspected.admitCount === 0;
  }
  private typePreflightDependencies(task: CooperativeTask) {
    return canonicalMathJson(this.dependencies(task).map(item => [item.task.id, digest(item.task)]));
  }
  private refreshInvalidTaskTypes() {
    let changed = false;
    for (const node of this.archive.tasks) {
      if (node.status !== 'blocked' || node.typePreflight?.status !== 'invalid') continue;
      const prior = this.invalidTaskTypes.get(node);
      const access = prior && this.input.access.get(prior.workerId);
      if (prior && access && prior.canonical === this.archive.canonicalCommit && prior.environment === this.input.state.environmentDigest &&
          prior.taskDigest === digest(node.task) && prior.dependencies === this.typePreflightDependencies(node.task) &&
          prior.environmentIdentity === taskTypePreflightEnvironmentIdentity(prior.project, access.environment)) continue;
      this.moveTask(node, 'pending', 'reopened'); node.typePreflight = undefined;
      if (node.feedback?.startsWith('math_task_type_invalid\n')) node.feedback = undefined;
      this.invalidTaskTypes.delete(node); changed = true;
    }
    return changed;
  }
  private canAdvance(taskIds?: ReadonlySet<string>) {
    return researchCanAdvance(this.archive.tasks, this.archive.groups, this.liveWorkers, node =>
      !this.preparingTaskTypes.has(node) && !this.synchronizationBlocked(node.task) &&
      this.livePeers.some(worker => assessTaskResponsibility(node, worker, this.responsibility).kind === 'matches' &&
        this.input.modules.M5.assign([node], worker, this.livePeers, this.archive.groups, this.archive.tasks, this.stoppedWorkers) === node), taskIds,
      this.stoppedWorkers);
  }
  private hasAssignableTask(taskIds?: ReadonlySet<string>) {
    return this.input.modules.M3.ready(this.archive.tasks, this.archive.groups).some(node => !this.preparingTaskTypes.has(node) && !this.synchronizationBlocked(node.task) &&
      (!taskIds || taskIds.has(node.task.id)) && this.archive.tasks.includes(node) &&
      this.livePeers.some(worker => assessTaskResponsibility(node, worker, this.responsibility).kind === 'matches' &&
        this.input.modules.M5.assign([node], worker, this.livePeers, this.archive.groups, this.archive.tasks, this.stoppedWorkers) === node));
  }
  reviewed(check?: ProofCheck) {
    const required = this.fixedStatementReviewTasks();
    if (this.fixedReviewScope && !required) return false;
    return !this.candidateSynchronizationBlocked() && this.archive.review?.status === 'accepted' && this.archive.review.commit === this.archive.canonicalCommit &&
      (!check || (check.commit === this.archive.review.commit && check.sourceDigest === this.archive.review.sourceDigest)) &&
      this.archive.tasks.filter(node => node.task.statementReview && (!required || required.has(node.task.id))).every(node => this.archive.statementReviews?.some(review =>
        review.taskId === node.task.id && review.taskDigest === digest(node.task) && review.status === 'accepted'));
  }
  requireReview(check: ProofCheck) {
    if (this.archive.review?.commit !== check.commit || this.archive.review.sourceDigest !== check.sourceDigest) {
      this.archive.review = { commit: check.commit, sourceDigest: check.sourceDigest, status: 'pending' };
      this.input.emit('review_requested', { commit: check.commit });
    }
    const configured = this.archive.tasks.filter(node => node.task.statementReview), used = new Set<string>();
    const problem = this.input.state.problem;
    let complete = hasFreshSolverCheck(check) && proofReceiptsMatch(check.verification, check.commit,
      problem.targets.map(target => ({ proofPath: target.proofPath, theoremName: target.theoremName,
        expectedSourceDeclarationHash: target.declarationHash, statementHash: problem.contract.statementHash,
        leanStatementHash: problem.contract.leanStatementHash, claim: 'statement' })));
    if (complete) for (const target of problem.targets) {
      const receipt = check.verification.results.find(result => result.proofPath === target.proofPath && result.theoremName === target.theoremName);
      const references = receipt?.declarationReferences && captureProofReferences(problem, this.lead.worktree, check.commit,
        { name: target.theoremName, file: target.proofPath }, receipt.declarationReferences, this.input.state.environmentDigest);
      if (!references) { complete = false; break; }
      for (const reference of attributeTaskReferences(references, this.archive.tasks)) used.add(reference.taskId);
    }
    const required = new Map(configured.filter(node => !complete || node.task.kind === 'goal' || used.has(node.task.id))
      .map(node => [node.task.id, digest(node.task)]));
    this.fixedReviewScope = { review: this.archive.review, commit: check.commit, sourceDigest: check.sourceDigest,
      environmentDigest: this.input.state.environmentDigest, tasksDigest: this.statementTaskIdentity(), required };
    for (const active of this.active.values()) if (isStatementAction(active.action) && !this.current(active.action) && !active.cancelled) {
      const reviewId = active.action.reviewId;
      const statement = this.archive.statementReviews?.find(item => item.id === reviewId);
      if (statement) resetStatementReview(statement);
      active.cancelled = true; void active.interrupt().catch(() => {});
    }
    this.input.emit('final_statement_review_scope', { commit: check.commit, sourceDigest: check.sourceDigest,
      referenceCoverage: complete ? 'complete' : 'unknown', requiredTaskIds: [...required.keys()],
      unusedTaskIds: configured.filter(node => !required.has(node.task.id)).map(node => node.task.id) });
    this.changed();
  }
  contextState(action?: CooperativeAction, worker?: ResearchWorker, versions: TaskVersions = this.taskVersions()): CooperationState {
    const record = worker && this.input.state.workers?.find(item => item.id === worker.id);
    const checkpointWorkerId = worker?.id ?? (action?.kind === 'task' ? action.assignment.workerId : action?.kind === 'lead' ? this.lead.id : undefined);
    const checkpointResearch = this.input.state.workers?.find(peer => peer.id === checkpointWorkerId) ??
      (checkpointWorkerId === this.lead.id ? this.input.state : undefined);
    const ordinaryWorker = !action && worker && worker.id !== this.lead.id;
    const task = action?.kind === 'task' ? action.task : ordinaryWorker ?
      this.archive.tasks.find(node => node.status === 'running' && node.assignment?.workerId === worker.id)?.task ??
      this.archive.tasks.find(node => node.task.id === record?.sessionTaskId)?.task : undefined;
    const tasks = task ? this.visible(task) : ordinaryWorker ?
      this.archive.tasks.filter(node => node.task.sharing !== 'group' && ['integrated', 'completed'].includes(node.status)) : this.archive.tasks;
    const gapViewer = task ?? (ordinaryWorker ? { id: 'idle', groupId: '__idle__' } as CooperativeTask : undefined);
    const visibleIds = new Set(tasks.map(node => node.task.id));
    const visible = (id: string, version: string) => visibleIds.has(id) && versions.get(id)?.version === version;
    const deliveries = this.archive.deliveries?.filter(item => this.deliveryVisible(item, task, versions, gapViewer) &&
      (task || tasks === this.archive.tasks || !item.taskId || versions.get(item.taskId)?.task.sharing !== 'group')) ?? [];
    const hiddenFindings = new Set((this.archive.deliveries ?? []).filter(item =>
      !mathematicalGapVisible(item, this.archive, gapViewer)).flatMap(item => item.findingDigest ? [item.findingDigest] : []));
    const scopedFinding = <T extends { finding?: string }>(node: T): T => node.finding && hiddenFindings.has(mathDigest(node.finding)) ?
      { ...node, finding: undefined } : node;
    const proofRoutes = (this.archive.proofRoutes ?? this.archive.tasks.flatMap(node => node.alternativeRoutes ?? []))
      .filter(route => visibleIds.has(route.targetTaskId) &&
        [route.closingTaskId, ...route.prerequisiteTaskIds].every(id => visibleIds.has(id)));
    const scopedTasks = tasks.map(node => scopedFinding(node.alternativeRoutes?.length ? { ...node,
      alternativeRoutes: proofRoutes.filter(route => route.targetTaskId === node.task.id) } : node));
    // The Lead's own context is built before its turn starts; that turn then becomes the next inbox basis.
    const leadInboxView = action?.kind === 'lead' && !this.active.has(this.lead.id) ? leadInbox(this.archive.leadInboxBasis, {
      tasks: this.archive.tasks, planVersion: this.archive.planVersion, deliveries: this.archive.deliveries, leadId: this.lead.id,
      workers: this.input.state.workers, roles: new Map(this.input.workers.map(peer => [peer.id, peer.role])) }) : undefined;
    // Keep the earliest snapshot for this dispatch: repeating a change is harmless, skipping one is not.
    if (action?.kind === 'lead' && !this.active.has(this.lead.id) && !this.pendingLeadInboxBases.has(action))
      this.pendingLeadInboxBases.set(action, leadInboxBasis(this.archive.tasks, this.archive.planVersion));
    if (action?.kind === 'lead' && !this.active.has(this.lead.id) && !this.presentedNextCheckOutcomes.has(action))
      this.presentedNextCheckOutcomes.set(action, (this.archive.nextChecks ?? []).flatMap(record =>
        record.status === 'awaiting-decision' && record.outcome ? [{ checkId: record.id, outcomeDeliveryId: record.outcome.deliveryId }] : []));
    const searchScope = action?.kind === 'task' ? this.proofSearchScope(action) : undefined;
    const searchRecord = searchScope && this.archive.proofSearchRecords?.[searchScope.taskId];
    return { ...this.archive, tasks: scopedTasks, leadInbox: leadInboxView,
      researchDecisions: action?.kind === 'lead' || worker?.id === this.lead.id ? this.archive.researchDecisions : undefined,
      ...(action?.kind === 'lead' && this.presentedResearchInputs.has(action) ? {
        leadResearchInputIds: this.presentedResearchInputs.get(action)!.shown.map(record => record.id),
        leadResearchInputCount: this.presentedResearchInputs.get(action)!.total,
      } : {}),
      proofSearchRecords: searchScope && proofSearchRecordMatches(searchRecord, searchScope)
        ? { [searchScope.taskId]: searchRecord } : undefined,
      goalProgress: action?.kind === 'lead' || worker?.id === this.lead.id ? this.archive.goalProgress :
        action?.kind === 'task' ? goalProgressForTask(this.archive.goalProgress, action.task) : undefined,
      goalPathReview: action?.kind === 'lead' || worker?.id === this.lead.id ? this.goalPathReview() : undefined,
      planPublicationRejection: (action?.kind === 'lead' || worker?.id === this.lead.id) &&
        this.archive.planPublicationRejection?.baseVersion === this.archive.planVersion ? this.archive.planPublicationRejection : undefined,
      contextCheckpointRejection: checkpointResearch ? contextCheckpointRejection(checkpointResearch) : undefined,
      deliveryReceipts: this.archive.deliveryReceipts?.filter(receipt => worker && receipt.workerId === worker.id &&
        receipt.environmentDigest === this.input.state.environmentDigest &&
        (action?.kind === 'task' ? receipt.assignmentKey === assignmentDeliveryFile(action.assignment) :
          visible(receipt.taskId, receipt.taskDigest))),
      proofReadyRecords: this.archive.proofReadyRecords?.filter(receipt =>
        (action?.kind === 'lead' || worker?.id === this.lead.id || worker && receipt.workerId === worker.id &&
          (action?.kind !== 'task' || receipt.assignmentKey === assignmentDeliveryFile(action.assignment))) &&
        receipt.problemReceiptDigest === this.input.state.problem.receiptDigest &&
        receipt.environmentDigest === this.input.state.environmentDigest),
      parallelQuestions: parallelQuestions(this.archive.tasks, task).filter(question => !ordinaryWorker || task ||
        versions.get(question.taskId)?.task.sharing !== 'group'),
      consumerInterfaces: task ? taskConsumerProjection(task, this.archive.tasks, this.archive.proofRoutes) : undefined,
      mathematicalGaps: mathematicalGaps(this.archive, { problemReceiptDigest: this.input.state.problem.receiptDigest,
        environmentDigest: this.input.state.environmentDigest }, gapViewer),
      nextChecks: visibleNextChecks(this.archive, gapViewer),
      failedTaskInputs: this.archive.failedTaskInputs?.filter(record => tasks === this.archive.tasks || visible(record.taskId, record.taskDigest)),
      progressSnapshot: tasks === this.archive.tasks ? this.archive.progressSnapshot : undefined,
      progressReceipts: tasks === this.archive.tasks ? this.archive.progressReceipts : undefined,
      blockers: this.archive.blockers?.filter(blocker => tasks === this.archive.tasks ||
        (visibleIds.has(blocker.taskId) && task && blocker.groupId === taskGroup(task))),
      proofRoutes,
      unchangedResearch: this.archive.unchangedResearch && Object.fromEntries(Object.entries(this.archive.unchangedResearch)
        .filter(([id, record]) => visible(id, record.taskDigest))),
      researchCheckpoints: this.archive.researchCheckpoints && Object.fromEntries(Object.entries(this.archive.researchCheckpoints)
        .filter(([id, record]) => visible(id, record.taskDigest))),
      researchDrafts: this.archive.researchDrafts && Object.fromEntries(Object.entries(this.archive.researchDrafts)
        .filter(([id, record]) => visible(id, record.taskDigest))),
      // Public progress can steer another route before its proof is complete; it remains advisory.
      deliveries,
      history: (tasks === this.archive.tasks ? this.archive.history : this.archive.history?.filter(item =>
        visible(item.task.id, digest(item.task))))?.map(scopedFinding),
      statementReviews: this.archive.statementReviews?.filter(item => item.status !== 'superseded' && visible(item.taskId, item.taskDigest)) };
  }
  private async deliverLead(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'lead' | 'assemble' }>, commit: string,
    recovering: boolean, recoveryKind: 'checkpoint' | 'request-failure' | 'scheduling-checkpoint'): Promise<{ checkWhole: boolean; savedPlan?: boolean }> {
    const staged = await this.input.exclusiveCheck(async () => {
      if (!this.current(action)) {
        this.input.emit('lead_decision_superseded', { commit }); this.syncPlanNotes(); this.wakeLead('lead-turn-superseded'); this.changed();
        return { finished: true as const, checkWhole: false };
      }
      const sourceChanged = ownedSourceDigest(this.input.state.problem, worker.worktree, action.seedCommit) !==
        ownedSourceDigest(this.input.state.problem, worker.worktree, commit);
      let accepted = false;
      const publishedPlan = this.planSnapshot(action);
      const previousPlanVersion = this.planVersion();
      try {
        const schedulingDraft = recovering && recoveryKind === 'scheduling-checkpoint' && !action.initialPlanNonce &&
          !publishedPlan && this.archive.tasks.length > 0;
        const notesFile = path.join(worker.worktree, 'RESEARCH.md');
        const savedNotes = (publishedPlan || schedulingDraft) && fs.existsSync(notesFile)
          ? readMathText(notesFile, MAX_RESEARCH_NOTES_BYTES) : '';
        let unchangedCheckpoint = false;
        if (schedulingDraft) {
          try {
            const seedNotes = git(worker.worktree, ['ls-tree', '--name-only', action.seedCommit, '--', 'RESEARCH.md'])
              ? committedSource(worker.worktree, action.seedCommit, 'RESEARCH.md') : '';
            unchangedCheckpoint = this.proposedPlanDigest(seedNotes) === this.proposedPlanDigest(savedNotes);
          } catch { /* Without a readable dispatch baseline, validate the saved response normally. */ }
        }
        const notes = savedNotes.trimStart();
        const hasFinalPlan = this.publishedPlans.get(action)?.responseDigest !== this.proposedPlanDigest() &&
          (notes.startsWith('{') || /```(?:math|json|math-plan)\s*\n/u.test(notes));
        if (unchangedCheckpoint) {
          // Inherited control notes are a draft, not a fresh response to this dispatch.
          // Continue below so saved Lean source changes still take the ordinary merge path.
          this.pin(commit); this.wakeLead('lead-checkpoint-unchanged');
          this.input.emit('lead_checkpoint_saved', { commit, seedCommit: action.seedCommit,
            reason: 'unchanged-control-response' });
        } else if (publishedPlan && !hasFinalPlan) {
          // A published immutable event remains useful when the continued writer only saves notes.
          accepted = true;
        } else await this.acceptPlan(undefined, undefined, undefined, action);
        if (!unchangedCheckpoint) accepted = true;
      } catch (error) {
        if (recovering) {
          // A checkpoint or failed request may leave only a partial graph. Keep it resumable.
          this.archive.planRejection = undefined;
          const reason = error instanceof Error ? error.message : 'math_plan_incomplete';
          this.input.emit('plan_rejected', { proposalDigest: this.proposedPlanDigest(), inputDigest: this.planningInputDigest(),
            error: reason, stalled: false, incomplete: true, recoveryKind });
          this.preserveLeadDraft(commit, action.seedCommit, reason);
        } else this.rejectPlan(error);
        if (!this.archive.tasks.length && !(recovering && recoveryKind === 'request-failure')) {
          try { await this.startInitialTasks(); }
          catch (fallbackError) { this.input.emit('initial_plan_fallback_failed', {
            reason: fallbackError instanceof Error ? fallbackError.message : 'math_initial_plan_failed' }); }
        }
      }
      const decisionProgress = Boolean(publishedPlan) || accepted && previousPlanVersion !== this.planVersion();
      const savedPlan = recovering && recoveryKind === 'request-failure' && decisionProgress;
      if (accepted && !recovering && action.kind === 'lead') {
        const nonce = action.initialPlanNonce ?? action.planNonce;
        for (const publication of [this.archive.planPublication, this.archive.initialPlanPublication])
          if (nonce && publication?.nonce === nonce) publication.finalized = true;
      }
      if (accepted && (!recovering || decisionProgress)) this.rememberLeadDecision(action);
      if (recovering && recoveryKind !== 'request-failure' && action.kind === 'lead' &&
          !action.initialPlanNonce && !decisionProgress) {
        this.archive.lastLeadPauseInputDigest = this.leadPauseInputs.get(action);
      }
      // The decision or pause above is durable now; a restart must not re-ask this turn's wake-ups.
      settleLeadWakes(this.archive.leadWakes!);
      // A failed request that saved nothing has not considered the stall; a decision, rejection or pause has.
      if (!recovering || recoveryKind !== 'request-failure' || decisionProgress) this.answerGoalPathStall(action, !recovering);
      this.changed();
      return { finished: false as const, sourceChanged, savedPlan, planVersion: this.archive.planVersion };
    });
    if (staged.finished) return { checkWhole: false };
    const saved = staged.savedPlan ? { savedPlan: true } : {};
    if (!staged.sourceChanged) return { checkWhole: false, ...saved };
    try {
      for (;;) {
        const snapshot = await this.input.exclusiveCheck(async () => {
          if (this.archive.planVersion !== staged.planVersion) {
            this.preserveLeadDraft(commit, action.seedCommit, 'math_lead_decision_superseded', false); this.changed(); return;
          }
          return { canonical: this.archive.canonicalCommit!, environmentDigest: this.input.state.environmentDigest,
            problemReceiptDigest: this.input.state.problem.receiptDigest };
        });
        if (!snapshot) return { checkWhole: false, ...saved };
        const merged = await this.mergeLeadSources(commit, action.seedCommit, snapshot.canonical);
        const published = await this.input.exclusiveCheck(async () => {
          this.input.signal.throwIfAborted();
          if (this.archive.planVersion !== staged.planVersion) {
            this.preserveLeadDraft(commit, action.seedCommit, 'math_lead_decision_superseded', false); this.changed(); return 'superseded';
          }
          if (this.archive.canonicalCommit !== snapshot.canonical || this.input.state.environmentDigest !== snapshot.environmentDigest ||
              this.input.state.problem.receiptDigest !== snapshot.problemReceiptDigest) return 'retry';
          this.archive.canonicalCommit = merged;
          this.settleSourceResearchDecisions(action, snapshot.canonical, merged);
          const integrated = new Set(this.archive.tasks.filter(node => node.status === 'integrated').map(node => node.task.id));
          this.markPendingValidation(this.archive.tasks.filter(node => integrated.has(node.task.id) || node.task.statementReview), integrated);
          this.changed(); return 'published';
        });
        if (published === 'retry') continue;
        if (published === 'superseded') return { checkWhole: false, ...saved };
        await this.schedulePlanSynchronization();
        return await this.input.exclusiveCheck(async () => {
          if (this.archive.planVersion !== staged.planVersion || this.candidateSynchronizationBlocked()) return { checkWhole: false, ...saved };
          const problem = this.input.state.problem;
          const unchangedDraft = git(worker.worktree, ['rev-parse', 'HEAD']) === commit && problem.ownedFiles.every(file => {
            const local = path.join(worker.worktree, problem.projectRelative, file);
            return fs.existsSync(local) && fs.readFileSync(local, 'utf8') === committedSource(worker.worktree, commit, `${problem.projectRelative}/${file}`);
          });
          if (unchangedDraft) this.archive.canonicalCommit = this.seed(worker, this.archive.canonicalCommit!);
          this.changed(); return { checkWhole: unchangedDraft, ...saved };
        });
      }
    } catch (error) {
      this.input.signal.throwIfAborted();
      if (error instanceof VerificationCheckpointError || error instanceof Error && error.message === 'math_verifier_unavailable') throw error;
      await this.input.exclusiveCheck(async () => {
        this.preserveLeadDraft(commit, action.seedCommit, error instanceof Error ? error.message : 'math_lead_integration_failed',
          this.archive.planVersion === staged.planVersion);
        this.changed();
      });
      return { checkWhole: false, ...saved };
    }
  }
  async deliver(worker: ResearchWorker, action: CooperativeAction, commit: string, recovering = false,
    recoveryKind: 'checkpoint' | 'request-failure' | 'scheduling-checkpoint' = 'checkpoint'): Promise<{ check?: ProofCheck; checkWhole: boolean; savedPlan?: boolean }> {
    if (isStatementAction(action)) return this.deliverStatement(worker, action);
    if (action.kind === 'review') {
      const review = this.archive.review;
      if (!review || !this.current(action) || review.workerId !== worker.id) {
        this.record(worker, undefined, 'review', 'superseded', 'The reviewed version is no longer current.', { commit: action.seedCommit });
        return { checkWhole: false };
      }
      if (recovering) { this.interrupted(worker, action); return { checkWhole: false }; }
      let evidenceRefs: readonly string[] = [];
      try {
        if (ownedSourceDigest(this.input.state.problem, worker.worktree, commit) !== action.sourceDigest)
          throw new Error('math_review_source_changed');
        const result = block(worker.worktree, 'math-review', { commit: action.seedCommit });
        if (result.commit !== action.seedCommit) throw new Error('math_review_delivery_invalid');
        const status = reviewVerdict(result.verdict, 'math_review_delivery_invalid');
        const details = deliveryDetails(result);
        review.status = status; review.summary = details.summary;
        evidenceRefs = details.evidenceRefs;
        this.input.emit('review_completed', { commit: review.commit, verdict: review.status, workerId: worker.id });
      } catch (error) {
        review.status = 'changes_requested'; review.summary = error instanceof Error ? error.message : 'math_review_failed';
      }
      review.workerId = undefined;
      if (review.status === 'accepted') this.lastAssembly = undefined;
      else { this.archive.error = review.summary; this.wakeLead('review-changes-requested'); }
      this.record(worker, undefined, 'review', review.status, review.summary ?? '', { commit: review.commit, sourceDigest: review.sourceDigest, evidenceRefs });
      return { checkWhole: false };
    }
    if (action.kind === 'assemble') {
      this.changed();
      return { checkWhole: true };
    }
    if (action.kind !== 'task') {
      const pending = this.deliverLead(worker, action, commit, recovering, recoveryKind);
      this.leadDeliveries.add(pending);
      try { return await pending; } finally { this.leadDeliveries.delete(pending); this.wake(); }
    }
    const node = this.node(action.task.id);
    if (!this.current(action)) {
      this.record(worker, action.task, advisory(action.task) ? 'research' : 'proof', 'superseded', 'Delivery belongs to a superseded assignment.',
        { taskDigest: action.assignment.taskDigest, premises: action.task.premises ?? [], dependencies: action.assignment.dependencies ?? [], commit });
      this.input.emit('task_delivery_superseded', { taskId: action.task.id, workerId: worker.id, commit });
      return { checkWhole: false };
    }
    let unchangedNotesBlob: string | undefined;
    let artifacts: DeliveryArtifactManifest | undefined;
    try {
      artifacts = captureDeliveryArtifacts({ problem: this.input.state.problem, worktree: worker.worktree, commit, assignment: action.assignment });
      if (advisory(node.task)) {
        if (recovering) {
          this.preserveResearchDraft(worker, action, commit, artifacts);
          if (recoveryKind === 'checkpoint' || recoveryKind === 'scheduling-checkpoint')
            this.researchCheckpoint(worker, action, commit);
          else this.interrupted(worker, action);
          return { checkWhole: false };
        }
        taskChanges(this.input.state.problem, worker.worktree, commit, node.task, action.assignment);
        const notesBlob = (version: string) => git(worker.worktree, ['ls-tree', '--format=%(objectname)', version, '--', 'RESEARCH.md']);
        const inherited = notesBlob(action.assignment.seedCommit);
        if (inherited === notesBlob(commit)) {
          unchangedNotesBlob = inherited;
          throw new Error(inherited ? 'math_research_delivery_unchanged: Replace inherited RESEARCH.md with findings for the current task.'
            : 'math_research_delivery_unchanged: Write RESEARCH.md with findings for the current task.');
        }
        await this.publishResearchFinding(worker, action, commit,
          { kind: 'notes', text: committedSource(worker.worktree, commit, 'RESEARCH.md') }, { artifacts });
      } else {
        // The same assignment resumes; the next real turn of this draft is still checked.
        if (recovering && recoveryKind === 'request-failure' && this.untouchedTaskSeed(worker, action, commit)) {
          this.interrupted(worker, action); return { checkWhole: false };
        }
        const proof = await this.publishTaskProof(worker, action, commit,
          'Fixed declaration checked; unresolved lemma assumptions remain obligations.', { artifacts }, recovering);
        return { check: proof, checkWhole: false };
      }
    } catch (error) {
      this.input.signal.throwIfAborted();
      if (!(error instanceof Error) || error.name === 'AbortError' ||
          ['delivered', 'conditional', 'integrated'].includes(node.status) ||
          !(error instanceof SyntaxError) && !directDeliveryRejections.has(rejectionCode(error))) throw error;
      if (!this.current(action)) return { checkWhole: false };
      const feedback = error instanceof Error ? error.message : 'math_task_delivery_failed';
      if (advisory(node.task)) {
        // A turn that never wrote RESEARCH.md is rejected with an empty submission instead of stopping the worker.
        const submission = git(worker.worktree, ['ls-tree', '--name-only', commit, '--', 'RESEARCH.md'])
          ? committedSource(worker.worktree, commit, 'RESEARCH.md') : '';
        this.rejectWorkerDelivery(worker, action, submission, error);
        this.input.save();
      }
      if (artifacts?.artifacts.length) this.record(worker, node.task, 'progress', 'advisory',
        'Recoverable supporting code retained after an incomplete or rejected delivery; it still requires typed host checking.',
        { commit, artifacts, remainingObligations: [node.task.id] });
      if (error instanceof ResearchAdmissionError) {
        // A malformed report is corrected by the same writer, not a mathematical route failure.
        this.preserveResearchDraft(worker, action, commit, artifacts);
        this.interrupted(worker, action);
        return { checkWhole: false };
      }
      if (recovering && recoveryKind === 'request-failure' && feedback.startsWith('math_task_repeated_failed_input\n') &&
          this.restoreInterruptedRepair(worker, action, commit)) {
        return { checkWhole: false };
      }
      if (recovering && feedback.startsWith('math_task_missing_declaration\n')) {
        if (this.continueTaskCheckpoint(worker, node, commit)) {
          node.feedback = feedback; this.interrupted(worker, action);
        } else this.rejected(action, feedback, commit);
        return { checkWhole: false };
      }
      if (/^math_task_(?:missing_declaration|repeated_failed_input)\n/u.test(feedback) || isTaskSourceRepairFeedback(feedback))
        this.rejected(action, feedback, commit, recovering);
      else if (recovering) { node.feedback = feedback; this.interrupted(worker, action); }
      else if (unchangedNotesBlob !== undefined) {
        this.reportBlockers(node.task, [{ mechanism: 'unchanged-research-delivery', scope: 'assigned-local-inference' }]);
        const previous = this.archive.unchangedResearch?.[node.task.id];
        const count = previous?.taskDigest === action.assignment.taskDigest && previous.notesBlob === unchangedNotesBlob ? previous.count + 1 : 1;
        (this.archive.unchangedResearch ??= {})[node.task.id] = { taskDigest: action.assignment.taskDigest, notesBlob: unchangedNotesBlob, count };
        this.input.emit('research_delivery_unchanged', { taskId: node.task.id, taskDigest: action.assignment.taskDigest, count, needsDecision: count >= 2 });
        if (count >= 2) this.rejected(action, feedback, commit);
        else { node.feedback = feedback; this.interrupted(worker, action); }
      } else this.rejected(action, feedback, commit);
    }
    return { checkWhole: false };
  }
  interrupted(worker: ResearchWorker, action: CooperativeAction) {
    if (isStatementAction(action)) {
      const review = this.archive.statementReviews?.find(item => item.id === action.reviewId);
      if (review && this.current(action) && review.workerId === worker.id) resetStatementReview(review);
    } else if (action.kind === 'task') {
      const node = this.node(action.task.id);
      if (this.current(action) && node.status === 'running' && node.assignment?.workerId === worker.id) this.moveTask(node, 'pending', 'interrupted');
    }
    else if (action.kind === 'review') {
      const review = this.archive.review;
      if (review && this.current(action) && review.workerId === worker.id) { review.status = 'pending'; review.workerId = undefined; }
    }
    else this.wakeLead('lead-turn-interrupted');
    this.changed();
  }
  rejected(action: CooperativeAction, feedback: string, commit?: string, incomplete = false) {
    if (['task', 'lead', 'review'].includes(action.kind) && !this.current(action)) return;
    let localRepair = false;
    let reviewWorker: ResearchWorker | undefined;
    if (isStatementAction(action)) {
      const review = this.archive.statementReviews?.find(item => item.id === action.reviewId);
      if (!review || !this.current(action)) return;
      review.status = 'changes_requested'; review.summary = feedback;
      const worker = this.input.workers.find(item => item.id === review.workerId);
      review.workerId = undefined;
      this.archive.error = feedback; this.wakeLead('statement-review-rejected');
      if (worker) this.record(worker, this.node(review.taskId).task, 'failure', 'failed', feedback,
        { sourceDigest: review.snapshotDigest, commit: review.commit });
      else this.changed();
      return;
    } else if (action.kind === 'task') {
      const node = this.node(action.task.id); this.moveTask(node, 'blocked', 'rejected'); node.feedback = feedback;
      if (incomplete) this.restoreTaskSourceRepair(node);
      else this.settleTaskSourceRepair(node);
      if (isTaskSourceRepairFeedback(feedback)) localRepair = this.retryTaskSourceLocally(node);
      else if (/^math_task_(?:missing_declaration|repeated_failed_input)\n/u.test(feedback)) {
        const worker = this.input.workers.find(worker => worker.id === action.assignment.workerId);
        if (worker && commit && feedback.startsWith('math_task_missing_declaration\n'))
          this.rememberTaskFailure(this.failedTaskInput(action.task, action.assignment, worker.worktree, commit), feedback);
        localRepair = this.retryTaskLocally(node, commit);
        if (!localRepair) this.settleTaskRepair(node);
      }
    } else if (action.kind === 'review') {
      reviewWorker = this.input.workers.find(item => item.id === this.archive.review!.workerId);
      this.archive.review!.status = 'changes_requested'; this.archive.review!.summary = feedback;
      this.archive.review!.workerId = undefined;
    } else this.archive.error = feedback;
    const worker = action.kind === 'task' ? this.input.workers.find(item => item.id === action.assignment.workerId) :
      action.kind === 'review' ? reviewWorker : this.lead;
    if (!localRepair) this.wakeLead(action.kind === 'task' ? 'task-delivery-rejected' :
      action.kind === 'review' ? 'review-changes-requested' : 'lead-turn-rejected');
    if (worker) this.record(worker, action.kind === 'task' ? action.task : undefined, 'failure', 'failed', feedback, { commit });
    else this.changed();
  }
  assemblyFailed(check: ProofCheck) { this.archive.error = solverProofFeedback(check); this.wakeLead('assembly-failed'); this.changed(); }
  /** A reserved turn may still be refunded; the caller rechecks synchronously after waking. */
  waitForTurn(maxTurns: number): Promise<void> | undefined {
    return this.input.state.turns >= maxTurns && this.reservedTurns.size ? this.wait() : undefined;
  }
  reserveTurn(worker: ResearchWorker) { this.reservedTurns.add(worker.id); }
  settleTurn(worker: ResearchWorker) { if (this.reservedTurns.delete(worker.id)) this.wake(); }
  release(worker: ResearchWorker, action: CooperativeAction) {
    if (action.kind === 'task' && this.current(action)) {
      const node = this.node(action.task.id);
      if (!node.attempts) node.assignment = undefined;
      if (node.status === 'running') this.moveTask(node, 'pending', 'interrupted');
      this.changed();
    } else this.interrupted(worker, action);
  }
  /**
   * A stopped worker never returns in this process, so its saved assignment would block every peer.
   * The record stays durable until a responsible live peer actually takes the task: a restart resumes the
   * original worker's draft and repair chain instead.
   */
  private releaseStoppedAssignments(ready: readonly TaskRecord[], worker: ResearchWorker) {
    for (const node of ready) {
      const assignment = node.assignment;
      if (!assignment || assignment.workerId === worker.id || this.liveWorkers.has(assignment.workerId) ||
          !this.input.workers.some(item => item.id === assignment.workerId)) continue;
      node.assignment = undefined;
      if (assessTaskResponsibility(node, worker, this.responsibility).kind !== 'matches') { node.assignment = assignment; continue; }
      this.input.emit('task_assignment_released', { taskId: node.task.id, workerId: assignment.workerId,
        takenBy: worker.id, reason: 'worker-stopped' });
      this.changed();
    }
  }
  private reviewer(): ResearchWorker | undefined {
    const available = this.livePeers.filter(worker => !this.active.has(worker.id) &&
      !(this.archive.review?.status === 'running' && this.archive.review.workerId === worker.id) &&
      !this.archive.tasks.some(node => node.status === 'running' && node.assignment?.workerId === worker.id) &&
      !this.archive.statementReviews?.some(review => review.workerId === worker.id && ['translating', 'reviewing'].includes(review.status)));
    const selected = this.input.modules.M5.reviewer(available, this.lead.id);
    if (selected && (!available.includes(selected) || selected.role === 'lead')) throw new Error('math_review_assignment_invalid');
    return selected;
  }
  /** Assignments reserve concurrency immediately; charge only when a model turn actually starts. */
  started(worker: ResearchWorker, action: CooperativeAction): boolean {
    if (this.failure || this.stopping || !this.liveWorkers.has(worker.id) || !this.liveWorkers.has(this.lead.id)) return false;
    if (this.refreshFeasibilityAssignments()) this.changed();
    if (!this.current(action)) return false;
    if (action.kind === 'task' && action.assignment.workerId !== worker.id) throw new Error('math_task_assignment_invalid');
    if (action.kind === 'review' && this.archive.review?.workerId !== worker.id) throw new Error('math_review_assignment_invalid');
    const inboxBasis = action.kind === 'lead' ? this.pendingLeadInboxBases.get(action) : undefined;
    if (inboxBasis) { this.archive.leadInboxBasis = inboxBasis; this.pendingLeadInboxBases.delete(action); }
    if (isStatementAction(action) && this.archive.statementReviews?.find(item => item.id === action.reviewId)?.workerId !== worker.id)
      throw new Error('math_statement_review_assignment_invalid');
    if (action.kind === 'task' &&
        assessTaskResponsibility(this.node(action.task.id), worker, this.responsibility).kind !== 'matches') return false;
    const task = action.kind === 'task' ? action.task : isStatementAction(action) ? this.node(action.taskId).task : undefined;
    if (task && this.synchronizationBlocked(task) || (action.kind === 'review' || action.kind === 'assemble') &&
        this.candidateSynchronizationBlocked()) return false;
    const route = task && this.archive.groups?.find(record => record.group.id === taskGroup(task));
    const fixedStatement = isStatementAction(action) && this.fixedStatementReviewTasks()?.get(action.taskId) === action.taskDigest;
    if (route && !fixedStatement && (route.group.status !== 'active' || route.turns >= (route.group.maxTurns ?? Infinity))) return false;
    if (route && !fixedStatement) route.turns++;
    if (action.kind === 'task') {
      const node = this.node(action.task.id);
      const sourceRepair = this.currentTaskSourceRepair(node);
      if (sourceRepair?.pending) { sourceRepair.pending = false; sourceRepair.startedAttempt = node.attempts + 1; }
      for (const record of this.archive.failedTaskInputs ?? []) if (this.pendingTaskRepair(node, record)) {
        record.repair!.pending = false; record.repair!.startedAttempt = node.attempts + 1;
      }
      node.attempts++;
    }
    this.changed(); return true;
  }
  stopped(worker: ResearchWorker, error?: string) {
    this.clearDispatchWait(worker, 'stopped');
    this.liveWorkers.delete(worker.id);
    if (this.archive.review?.status === 'running' && this.archive.review.workerId === worker.id) {
      this.archive.review.status = 'pending'; this.archive.review.workerId = undefined;
    }
    for (const review of this.archive.statementReviews ?? [])
      if (review.workerId === worker.id && ['translating', 'reviewing'].includes(review.status)) resetStatementReview(review);
    for (const node of this.archive.tasks.filter(node => node.status === 'running' && node.assignment?.workerId === worker.id)) {
      this.moveTask(node, 'pending', 'interrupted'); node.feedback = error;
      if (error) this.wakeLead('worker-stopped');
    }
    this.changed();
  }
}
