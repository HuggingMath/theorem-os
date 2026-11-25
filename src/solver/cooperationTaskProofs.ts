import { isAdvisoryTask as advisory, isFeasibilityReview } from './tasks';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VerifierFailureError } from './verifierFailure';
import { mathGitResult } from '../math/mathGit';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { projectMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { hashMathFormalSourceDeclaration, inspectLeanDeclarationRegions } from '../math/leanSource';
import { commitSolverSources, committedSource, git, withSolverWorktree } from './problem';
import { solverProofFeedback, solverSourceFeedback } from './feedback';
import { independentFeasibilityWorker, type ResearchWorker } from './modules/organization';
import { proofReceiptsMatch, type ProofCheck } from './modules/evidence';
import { routeAllowsTask, taskCanStart, selectedTaskRoute } from './modules/search';
import { deliveryDetails, deliveryFinding, MAX_RESEARCH_NOTES_BYTES, parseMathResponse, type DeliveryRecord } from './deliveries';
import { checkTaskProof, createTaskSourceProjector, isAttributedTaskProof, ownedSourceDigest, projectedGoalInputs, taskChanges, trustedTaskProjectionReuse, type TaskProof } from './cooperativeProof';
import { proofReferencesUnchanged, type ProofReferences } from './proofReferences';
import { captureDeliveryArtifacts, diagnoseUnbackedLeanClaims, validateDeliveryArtifactClaims, type DeliveryArtifactManifest } from './deliveryArtifacts';
import { validateLemmaRequests } from './taskProposals';
import { routeBlockerBasis, type BlockerBasis } from './routeControl';
import { attributeTaskReferences } from './taskReferenceAttribution';
import { checkpointCandidate } from './researchEvidence';
import { committedResearchNotesDigest, feasibilityReviewInputDigest, researchCheckpointInputDigest, researchCheckpointLocalInputDigest, researchCheckpointOutputDigest,
  researchHandoffNotesDigest, resumableFeasibilityReviewInput, UNCHANGED_RESEARCH_CHECKPOINT, type ResearchCheckpoint } from './researchCheckpoints';
import { savedContextCheckpoint } from './contextCheckpoint';
import { inspectKnowledgeUses, type KnowledgeUse } from './knowledgeUsage';
import { checkKnowledgeApplications } from './knowledgeApplications';
import { bindMathematicalGap, mathematicalGaps } from './mathematicalGaps';
import { bindCheckOutcome } from './nextChecks';
import { researchPublicationNotes } from './researchPublication';
import { taskConnectionCheckCurrent, taskInputsMissingFromSeed } from './taskConnections';
import { hasLeanResourceLimitFailure, hasLeanSourceDiagnostic } from './proofReuse';
import { assumableLemma, taskGroup, taskReferenceDependencies, assignmentDeliveryFile, markTaskReferences, markTaskAcceptance, hasTaskAcceptance, type CooperativeTask,
  type TaskAssignment, type TaskRecord, type CooperativeAction } from './tasks';
import { digest, FailedTaskInput, bounded } from './cooperationShared';
import { CooperationStatements } from './cooperationStatements';
import { prepareResearchDelivery, ResearchAdmissionError, type ResearchSubmission } from './researchAdmission';
import { settleResearch } from './researchRecords';

type ProofDeliveryRequest = {
  worker: ResearchWorker; action: Extract<CooperativeAction, { kind: 'task' }>;
  commit: string; summary: string; options: Partial<DeliveryRecord>; record?: DeliveryRecord;
  /** Host-only candidate: validate again, then claim its still-current assignment atomically. */
  prepared?: { proof: TaskProof; current: () => boolean; claim: () => void; advisorySummary?: string };
};
export type ProofDeliveryAnnotation = () => Promise<void>;
export type ProofDeliveryState = Pick<TaskRecord, 'assignment' | 'proof' | 'integratedCheck' | 'status' | 'feedback'>;

/** Task proof checks, failed-input memory and research checkpoints. */
export abstract class CooperationTaskProofs extends CooperationStatements {
  // Implemented by later layers; listed here because this layer calls them.
  protected abstract queueIntegration<T>(operation: () => Promise<T>, worker?: ResearchWorker, task?: CooperativeTask): Promise<T>;
  protected abstract integrateReadyNow(annotations: ProofDeliveryAnnotation[]): Promise<void>;
  protected abstract integrateNow(node: TaskRecord): Promise<ProofDeliveryState | undefined>;
  private proofDeliveryRequests = new Map<string, ProofDeliveryRequest>();
  private proofDeliveryAnnotations = new WeakMap<DeliveryRecord, ProofDeliveryAnnotation>();
  protected pendingProofDeliveryRecords = new WeakSet<DeliveryRecord>();
  abstract interrupted(worker: ResearchWorker, action: CooperativeAction): void;
  abstract rejected(action: CooperativeAction, feedback: string, commit?: string, incomplete?: boolean): void;
  private feasibilityInput(task: CooperativeTask, workerId: string) {
    const state = this.input.state;
    return { task, workerId, tasks: this.archive.tasks, deliveries: this.archive.deliveries ?? [],
      problem: state.problem, environmentDigest: state.environmentDigest, problemReceiptDigest: state.problem.receiptDigest,
      retrievalDigest: state.retrievalDigest, knowledgeDigest: state.knowledgeDigest,
      worktree: this.lead.worktree, canonicalCommit: this.archive.canonicalCommit! };
  }
  protected feasibilityInputDigest(task: CooperativeTask, workerId: string) {
    return feasibilityReviewInputDigest(this.feasibilityInput(task, workerId));
  }
  private checkpointInputDigest(task: CooperativeTask, workerId: string) {
    return researchCheckpointInputDigest({ task, workerId, tasks: this.archive.tasks, deliveries: this.archive.deliveries ?? [],
      environmentDigest: this.input.state.environmentDigest, problemReceiptDigest: this.input.state.problem.receiptDigest,
      problem: this.input.state.problem, worktree: this.lead.worktree, canonicalCommit: this.archive.canonicalCommit! });
  }
  private checkpointLocalInputDigest(task: CooperativeTask, workerId: string, legacyProgress = false) {
    return researchCheckpointLocalInputDigest({ task, workerId, tasks: this.archive.tasks, deliveries: this.archive.deliveries ?? [],
      environmentDigest: this.input.state.environmentDigest, problemReceiptDigest: this.input.state.problem.receiptDigest }, legacyProgress);
  }
  private checkpointInputMatches(node: TaskRecord, workerId: string, checkpoint: ResearchCheckpoint, localInputDigest: string) {
    if (!checkpoint.localInputDigest) return this.checkpointInputDigest(node.task, workerId) === checkpoint.inputDigest;
    return checkpoint.localInputDigest === localInputDigest || Boolean(node.nextCheckId &&
      checkpoint.localInputDigest === this.checkpointLocalInputDigest(node.task, workerId, true));
  }
  private checkpointOutputDigests = new Map<string, string>();
  private checkpointOutputDigest(worktree: string, commit: string) {
    const key = `${worktree}\0${commit}`, cached = this.checkpointOutputDigests.get(key);
    if (cached) return cached;
    const value = researchCheckpointOutputDigest(this.input.state.problem, worktree, commit);
    this.checkpointOutputDigests.set(key, value);
    if (this.checkpointOutputDigests.size > 256) this.checkpointOutputDigests.delete(this.checkpointOutputDigests.keys().next().value!);
    return value;
  }
  private checkpointOutputAdvanced(worker: ResearchWorker, node: TaskRecord,
    checkpoint: Pick<ResearchCheckpoint, 'taskDigest' | 'outputDigest'>) {
    const draft = this.archive.researchDrafts?.[node.task.id], assignment = node.assignment;
    // The retained commit supplies the component identities missing from older checkpoint records.
    // A worktree released for another responsibility is not this task's new output.
    if (!draft || draft.suspended || !assignment || draft.taskDigest !== checkpoint.taskDigest ||
        draft.workerId !== worker.id || draft.assignmentId !== assignment.assignmentId ||
        draft.seedCommit !== assignment.seedCommit || draft.canonicalCommit !== assignment.canonicalCommit ||
        draft.outputDigest !== checkpoint.outputDigest) return false;
    const commit = git(worker.worktree, ['rev-parse', 'HEAD']);
    if (commit === draft.commit) return false;
    const sourceDigest = this.leanSourceDigest(worker.worktree, commit);
    const sourceChanged = sourceDigest !== this.leanSourceDigest(worker.worktree, draft.commit);
    const notesBlob = git(worker.worktree, ['ls-tree', '--format=%(objectname)', commit, '--', 'RESEARCH.md']);
    const notesChanged = Boolean(notesBlob && notesBlob !== git(worker.worktree,
      ['ls-tree', '--format=%(objectname)', draft.commit, '--', 'RESEARCH.md']) &&
      committedSource(worker.worktree, commit, 'RESEARCH.md').trim());
    if (!sourceChanged && !notesChanged) return false;
    const resets = [...new Set([assignment.seedCommit, assignment.canonicalCommit, this.archive.canonicalCommit]
      .filter((value): value is string => Boolean(value)))];
    const sourceAdvanced = sourceChanged && resets.every(reset => this.leanSourceDigest(worker.worktree, reset) !== sourceDigest);
    if (!sourceAdvanced && !notesChanged) return false;
    const rewind = mathGitResult(worker.worktree, ['merge-base', '--is-ancestor', commit, draft.commit], { maxBuffer: 4096 });
    if (rewind.error) throw rewind.error;
    if (rewind.status === 0) return false;
    if (rewind.status !== 1) throw new Error('math_research_workspace_unavailable');
    // Reseeding may save a different HEAD without producing a new investigation.
    const outputDigest = this.checkpointOutputDigest(worker.worktree, commit);
    return outputDigest !== checkpoint.outputDigest &&
      this.checkpointOutputDigest(worker.worktree, draft.commit) === checkpoint.outputDigest &&
      !resets.some(reset => this.checkpointOutputDigest(worker.worktree, reset) === outputDigest);
  }
  private leanSourceDigest(worktree: string, commit: string) {
    const key = `${worktree}\0${commit}`, cached = this.leanSourceDigests.get(key);
    if (cached) return cached;
    const problem = this.input.state.problem;
    const value = mathDigest(canonicalMathJson(problem.ownedFiles.filter(file => file.endsWith('.lean')).sort().map(file =>
      [file, mathDigest(committedSource(worktree, commit, `${problem.projectRelative}/${file}`))])));
    this.leanSourceDigests.set(key, value);
    if (this.leanSourceDigests.size > 256) this.leanSourceDigests.delete(this.leanSourceDigests.keys().next().value!);
    return value;
  }
  private taskSourceDigest(task: CooperativeTask, worktree: string, commit: string, local = false) {
    const source = committedSource(worktree, commit, `${this.input.state.problem.projectRelative}/${task.proofPath}`);
    const targets = inspectLeanDeclarationRegions(source).filter(region =>
      region.name.split('.').at(-1) === task.theoremName?.split('.').at(-1));
    if (targets.length !== 1) return `declaration-count:${targets.length}`;
    // Selecting a different saved proof is new input; renaming the same declaration is not.
    const target = source.slice(targets[0].startOffset, targets[0].endOffset)
      .replace(/^(theorem|lemma)(\s+)[^\s([{:\n]+/u, '$1$2__task_target');
    return mathDigest(canonicalMathJson({ ...(local ? {} : { file: task.proofPath, offset: targets[0].startOffset }), source: target }));
  }
  private failedTaskBasis(task: CooperativeTask, conditions?: readonly CooperativeTask[],
    assignment = this.node(task.id)?.assignment): { basis: BlockerBasis; inputDigest: string } {
    const normalized = task.kind === 'lemma' ? { ...task, theoremName: undefined, proofPath: undefined } : task;
    conditions ??= this.assignmentConditions(task, assignment);
    const node = this.node(task.id), routeId = node && selectedTaskRoute(node, this.archive.tasks)?.id;
    const raw = routeBlockerBasis(normalized, this.archive.tasks, this.input.state.environmentDigest,
      this.input.state.problem.receiptDigest, routeId);
    const contractDigest = mathDigest(canonicalMathJson({ problemReceiptDigest: this.input.state.problem.receiptDigest,
      kind: normalized.kind, proofPath: normalized.proofPath, theoremName: normalized.theoremName,
      type: normalized.type, premises: normalized.premises ?? [], conditional: Boolean(normalized.conditional),
      conditions: conditions.map(task => ({ kind: task.kind, type: task.type, premises: task.premises ?? [] })) }));
    const environmentDigest = mathDigest(canonicalMathJson({ environmentDigest: this.input.state.environmentDigest,
      buildDigest: this.input.state.buildDigest, evaluatorDigest: this.input.state.evaluatorDigest,
      environment: projectMathematicsRuntimeEnvironment(this.input.access.get(this.lead.id)?.environment ?? {}) }));
    const previous = this.archive.failedTaskInputs?.findLast(record => record.basis.contractDigest === contractDigest &&
      record.basis.environmentDigest === environmentDigest) ??
      this.archive.failedTaskInputs?.findLast(record => record.basis.contractDigest === contractDigest && this.missingTaskDeclaration(record));
    const basis: BlockerBasis = { contractDigest, environmentDigest,
      dependencies: Object.fromEntries(Object.entries(raw.dependencies).map(([id, entry]) => {
        const dependency = this.node(id), proof = dependency?.integratedCheck;
        const fresh = dependency?.status === 'integrated' && proof && hasTaskAcceptance(proof) &&
          proof.taskDigest === digest(dependency.task) && !proof.conditions?.length;
        const prior = previous?.basis.dependencies[id] ?? Object.values(previous?.basis.dependencies ?? {})
          .find(candidate => candidate.contractDigest === entry.contractDigest);
        return [id, { ...entry, evidenceDigest: fresh && entry.evidenceDigest ? entry.evidenceDigest :
          prior?.contractDigest === entry.contractDigest ? prior.evidenceDigest : undefined }];
      })) };
    // Dependency task IDs, revision counters and replayed receipts do not change the mathematics.
    const inputDigest = mathDigest(canonicalMathJson({ contractDigest, environmentDigest,
      dependencies: Object.values(basis.dependencies).map(entry => canonicalMathJson(entry)).sort() }));
    return { basis, inputDigest };
  }
  private missingTaskDeclaration(record: FailedTaskInput) {
    return record.targetDigest === 'declaration-count:0' && record.feedback.startsWith('math_task_missing_declaration\n');
  }
  private sameFailedTaskBasis(record: FailedTaskInput, candidate: Pick<FailedTaskInput, 'inputDigest' | 'basis' | 'targetDigest'>) {
    if (record.inputDigest === candidate.inputDigest) return true;
    // A different checker cannot materialize a declaration absent from these same sources.
    // Still reopen for changed contracts, assumptions, checked dependencies or selected route inputs.
    if (!this.missingTaskDeclaration(record) || candidate.targetDigest !== 'declaration-count:0' ||
        record.basis.contractDigest !== candidate.basis.contractDigest) return false;
    const dependencies = (basis: BlockerBasis) => Object.values(basis.dependencies).map(entry => canonicalMathJson(entry)).sort();
    return canonicalMathJson(dependencies(record.basis)) === canonicalMathJson(dependencies(candidate.basis));
  }
  private previousTaskFailure(candidate: ReturnType<CooperationTaskProofs['failedTaskInput']>) {
    return this.archive.failedTaskInputs?.findLast(record => record.sourceDigest === candidate.sourceDigest &&
      record.targetDigest === candidate.targetDigest && this.sameFailedTaskBasis(record, candidate));
  }
  protected failedTaskInput(task: CooperativeTask, assignment: TaskAssignment, worktree: string, commit: string, conditions?: readonly CooperativeTask[]) {
    const { basis, inputDigest } = this.failedTaskBasis(task, conditions, assignment), sourceDigest = this.leanSourceDigest(worktree, commit);
    const targetDigest = this.taskSourceDigest(task, worktree, commit);
    const localTargetDigest = this.taskSourceDigest(task, worktree, commit, true);
    return { id: mathDigest(canonicalMathJson({ inputDigest, sourceDigest, targetDigest })), taskId: task.id, taskDigest: digest(task),
      ...(!localTargetDigest.startsWith('declaration-count:') ? {
        attemptFingerprint: mathDigest(canonicalMathJson({ inputDigest, target: localTargetDigest })),
      } : {}),
      inputDigest, basis, sourceDigest, targetDigest, seedSourceDigest: this.leanSourceDigest(worktree, assignment.seedCommit),
      seedTargetDigest: this.taskSourceDigest(task, worktree, assignment.seedCommit),
      canonicalSourceDigest: this.leanSourceDigest(this.lead.worktree, this.archive.canonicalCommit!),
      canonicalTargetDigest: this.taskSourceDigest(task, this.lead.worktree, this.archive.canonicalCommit!) };
  }
  protected rememberTaskFailure(candidate: Omit<FailedTaskInput, 'feedback' | 'repair'>, feedback: string, repair?: FailedTaskInput['repair']) {
    const records = this.archive.failedTaskInputs ??= [];
    const previous = records.find(record => record.id === candidate.id);
    if (previous) return previous;
    const related = candidate.attemptFingerprint && records.findLast(record => record.attemptFingerprint === candidate.attemptFingerprint);
    const relatedFailureIds = related ? [related.id] : [];
    const record: FailedTaskInput = { ...candidate, feedback: bounded(feedback, 8000),
      ...(relatedFailureIds.length ? { relatedFailureIds } : {}), ...(repair ? { repair } : {}) };
    records.push(record);
    if (relatedFailureIds.length) {
      this.wakeLead('task-repeated-attempt');
      this.input.emit('task_attempt_repeated_advisory', { taskId: record.taskId, failureId: record.id,
        attemptFingerprint: record.attemptFingerprint, relatedFailureIds, evidence: 'same-target-and-local-inputs-not-equivalence' });
    }
    this.input.emit('task_failed_input_recorded', { taskId: record.taskId, taskDigest: record.taskDigest,
      failureId: record.id, inputDigest: record.inputDigest, sourceDigest: record.sourceDigest });
    this.input.save();
    return record;
  }
  private deterministicTaskFailure(proof: TaskProof) {
    if (!proof.passed && isAttributedTaskProof(proof) && proof.verification.results.length === 1 &&
        hasLeanResourceLimitFailure(proof.verification)) return true;
    return !proof.passed && proof.verification.status === 'failed' && Boolean(proof.verification.targetCommit) &&
      proof.verification.results.length > 0 && proof.verification.results.every(result => !result.cleanupError &&
        ['failed', 'kernel_verified'].includes(result.status) &&
        !/(?:timed?\s*out|timeout|rate[- ]limit|unauthenticated|unauthorized|authentication|request (?:failed|error)|stream disconnected)/iu.test(result.error ?? '')) &&
      proof.verification.results.some(result => result.status === 'failed' &&
        ((result.sorryCount ?? 0) > 0 || (result.admitCount ?? 0) > 0 ||
          hasLeanSourceDiagnostic(`${result.stdoutPreview || ''}\n${result.stderrPreview || ''}`)));
  }
  protected pendingTaskRepair(node: TaskRecord, record: FailedTaskInput) {
    const repair = record.repair;
    return Boolean(repair?.pending && repair.taskId === node.task.id && repair.taskDigest === digest(node.task) &&
      node.assignment?.workerId === repair.workerId && node.assignment.taskDigest === repair.taskDigest);
  }
  /** Transport-only turns are not proof failures; source and typed corrections share one saved grant. */
  protected firstTaskRepair(node: TaskRecord, failureId?: string) {
    const version = digest(node.task);
    return node.sourceRepair?.taskDigest !== version && !this.archive.failedTaskInputs?.some(record =>
      record.taskId === node.task.id && record.taskDigest === version && (record.id !== failureId || record.repair));
  }
  private reportedTaskMathematicalBlocker(node: TaskRecord, candidate: ReturnType<CooperationTaskProofs['failedTaskInput']>) {
    const assignment = node.assignment;
    if (!assignment || assignment.taskDigest !== candidate.taskDigest || digest(node.task) !== candidate.taskDigest ||
        candidate.targetDigest !== 'declaration-count:0') return false;
    const gaps = mathematicalGaps(this.archive, { problemReceiptDigest: this.input.state.problem.receiptDigest,
      environmentDigest: this.input.state.environmentDigest }, node.task);
    return gaps.some(gap => {
      if (gap.scopeStatus !== 'current-contracts' || gap.scope.source.id !== node.task.id) return false;
      const delivery = this.archive.deliveries!.find(record => record.id === gap.deliveryId)!;
      if (delivery.producer !== assignment.workerId || delivery.assignmentKey !== assignmentDeliveryFile(assignment) || !delivery.commit) return false;
      const finding = deliveryFinding(delivery);
      if (!finding || this.leanSourceDigest(this.lead.worktree, delivery.commit) !== candidate.sourceDigest) return false;
      const report = JSON.parse(finding);
      return report.needsDecision === true && ['inconclusive', 'refuted'].includes(report.conclusion);
    });
  }
  private repeatedTaskFeedback(record: FailedTaskInput) {
    return 'math_task_repeated_failed_input\nThe same Lean source and mathematical inputs already failed. ' +
      'Save a changed proof or supply new premises, checked dependency evidence, or verifier inputs before retrying.\n' + record.feedback;
  }
  protected refreshFailedTaskInputs() {
    if (!this.archive.failedTaskInputs?.length) return false;
    let changed = false;
    const canonicalSourceDigest = this.leanSourceDigest(this.lead.worktree, this.archive.canonicalCommit!);
    for (const node of this.archive.tasks) {
      if (advisory(node.task) || !['pending', 'blocked'].includes(node.status) ||
          [node.proof, node.integratedCheck].some(proof => proof?.passed && proof.taskDigest === digest(node.task))) continue;
      const { basis, inputDigest } = this.failedTaskBasis(node.task);
      const worker = this.input.workers.find(worker => worker.id === node.assignment?.workerId);
      const session = worker && this.input.state.workers?.find(record => record.id === worker.id);
      const active = worker && this.active.get(worker.id)?.action;
      const ownsOutput = worker && node.assignment?.taskDigest === digest(node.task) &&
        (!session || session.sessionTaskId === node.task.id && (!session.sessionTaskVersion || session.sessionTaskVersion === digest(node.task))) &&
        (!active || active.kind === 'task' && active.task.id === node.task.id && active.assignment === node.assignment) &&
        !this.archive.tasks.some(other => other !== node && other.status === 'running' && other.assignment?.workerId === worker.id);
      const sourceDigest = ownsOutput ? this.leanSourceDigest(worker.worktree, git(worker.worktree, ['rev-parse', 'HEAD'])) : canonicalSourceDigest;
      const targetDigest = ownsOutput ? this.taskSourceDigest(node.task, worker.worktree, git(worker.worktree, ['rev-parse', 'HEAD'])) :
        this.taskSourceDigest(node.task, this.lead.worktree, this.archive.canonicalCommit!);
      const record = this.archive.failedTaskInputs.findLast(record => this.sameFailedTaskBasis(record, { basis, inputDigest, targetDigest }) &&
        (record.sourceDigest === sourceDigest && record.targetDigest === targetDigest || !ownsOutput &&
          (record.seedSourceDigest === sourceDigest && record.seedTargetDigest === targetDigest ||
            record.canonicalSourceDigest === sourceDigest && record.canonicalTargetDigest === targetDigest)));
      if (record && !this.pendingTaskRepair(node, record)) {
        const feedback = this.repeatedTaskFeedback(record);
        if (node.status === 'blocked' && node.feedback === feedback) continue;
        this.moveTask(node, 'blocked', 'input-blocked'); node.feedback = feedback; this.wakeLead('task-repeated-input-blocked'); changed = true;
        this.input.emit('task_repeated_input_blocked', { taskId: node.task.id, taskDigest: digest(node.task),
          failureId: record.id, inputDigest, sourceDigest });
      } else if (!record && node.status === 'blocked' && node.feedback?.startsWith('math_task_repeated_failed_input\n')) {
        this.moveTask(node, 'pending', 'reopened'); node.feedback = undefined; changed = true;
        this.input.emit('task_failed_input_reopened', { taskId: node.task.id, inputDigest, sourceDigest });
      }
    }
    return changed;
  }
  protected refreshResearchCheckpoints() {
    for (const [taskId, checkpoint] of Object.entries(this.archive.researchCheckpoints ?? {})) {
      if (!checkpoint.paused) continue;
      const node = this.node(taskId), worker = this.input.workers.find(worker => worker.id === node?.assignment?.workerId);
      if (!node || digest(node.task) !== checkpoint.taskDigest) { delete this.archive.researchCheckpoints![taskId]; continue; }
      if (!worker || node.status !== 'blocked' || !node.feedback?.startsWith('math_research_checkpoint_unchanged')) continue;
      const localInputDigest = this.checkpointLocalInputDigest(node.task, worker.id);
      const inputChanged = !this.checkpointInputMatches(node, worker.id, checkpoint, localInputDigest);
      // Upgrade a matching old pause before processing the next publication after restore.
      if (!inputChanged && node.nextCheckId) checkpoint.localInputDigest = localInputDigest;
      // Seeding another responsibility suspends its old draft before the new model session exists.
      // That host-written output cannot advance the paused task, even while its session id is stale.
      const session = this.input.state.workers?.find(record => record.id === worker.id), active = this.active.get(worker.id)?.action;
      const ownsOutput = !this.archive.researchDrafts?.[taskId]?.suspended && (!session || session.sessionTaskId === taskId &&
        (!session.sessionTaskVersion || session.sessionTaskVersion === checkpoint.taskDigest)) &&
        (!active || active.kind === 'task' && active.task.id === taskId && active.assignment.taskDigest === checkpoint.taskDigest) &&
        !this.archive.tasks.some(other => other.task.id !== taskId && other.status === 'running' && other.assignment?.workerId === worker.id);
      const outputChanged = !inputChanged && ownsOutput && this.checkpointOutputAdvanced(worker, node, checkpoint);
      if (!inputChanged && !outputChanged) {
        // The pause is still current, so its obstruction now parks this input for the Lead instead of
        // leaving silently blocked. Parking is a scheduling verdict only: it names what must change and
        // never accepts or refutes anything. Escalate once so repeated passes stay quiet.
        const parking = this.archive.blockers?.find(record => record.id === checkpoint.blockerId);
        if (parking?.status === 'open') {
          parking.status = 'parked'; parking.count = Math.max(parking.count, 2); parking.updatedAt = Date.now();
          this.input.emit('route_parked', { blockerId: parking.id, taskId: parking.taskId, groupId: parking.groupId,
            count: parking.count, scope: parking.scope, evidenceStatus: parking.evidenceStatus, reopenOn: parking.reopenOn });
        }
        continue;
      }
      const blocker = this.archive.blockers?.find(record => record.id === checkpoint.blockerId);
      if (blocker) { blocker.status = 'reopened'; blocker.reopenedReason = inputChanged ? 'checkpoint-input-changed' : 'checkpoint-output-changed'; }
      this.moveTask(node, 'pending', 'reopened'); node.feedback = undefined;
      delete this.archive.researchCheckpoints![taskId];
      this.input.emit('research_checkpoint_reopened', { taskId, reason: inputChanged ? 'new-input' : 'new-output' });
    }
  }
  protected preserveResearchDraft(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>,
    commit: string, artifacts: DeliveryArtifactManifest, restored?: { handoffNotesDigest?: string }) {
    const notesDigest = committedResearchNotesDigest(worker.worktree, commit);
    const previous = this.archive.researchDrafts?.[action.task.id], assignment = action.assignment;
    const retainedNotesDigest = previous?.taskDigest === assignment.taskDigest && previous.workerId === worker.id &&
      previous.assignmentId === assignment.assignmentId && previous.seedCommit === assignment.seedCommit &&
      previous.canonicalCommit === assignment.canonicalCommit ? previous.handoffNotesDigest : undefined;
    const research = this.input.state.workers?.find(record => record.id === worker.id) ?? this.input.state;
    // Restoring bytes is a host operation, so it must carry attribution from the inspected old snapshot.
    // Ordinary saves may establish it by changing the assignment's seed notes or acknowledging their digest.
    const handoffNotesDigest = restored
      ? notesDigest && notesDigest === restored.handoffNotesDigest ? notesDigest : undefined
      : researchHandoffNotesDigest(notesDigest, committedResearchNotesDigest(worker.worktree, assignment.seedCommit),
        retainedNotesDigest, savedContextCheckpoint(research, worker.worktree));
    (this.archive.researchDrafts ??= {})[action.task.id] = { taskDigest: action.assignment.taskDigest,
      workerId: worker.id, assignmentId: action.assignment.assignmentId,
      seedCommit: action.assignment.seedCommit, canonicalCommit: action.assignment.canonicalCommit,
      commit, outputDigest: this.checkpointOutputDigest(worker.worktree, commit), artifacts, handoffNotesDigest,
      ...(isFeasibilityReview(action.task) ? { feasibilityInputDigest: assignment.feasibilityInputDigest } : {}) };
    this.pin(commit);
  }
  /** A scheduling handoff retains code without submitting an unfinished assigned declaration. */
  retainContextDraft(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>, commit: string,
    reason: 'context' | 'connection' = 'context') {
    if (!this.current(action)) return;
    const previous = this.archive.researchDrafts?.[action.task.id], assignment = action.assignment;
    const previousOutput = previous?.taskDigest === assignment.taskDigest && previous.workerId === worker.id &&
      previous.assignmentId === assignment.assignmentId && previous.seedCommit === assignment.seedCommit &&
      previous.canonicalCommit === assignment.canonicalCommit ? previous.outputDigest :
        this.checkpointOutputDigest(worker.worktree, assignment.seedCommit);
    const artifacts = captureDeliveryArtifacts({ problem: this.input.state.problem,
      worktree: worker.worktree, commit, assignment: action.assignment });
    this.preserveResearchDraft(worker, action, commit, artifacts);
    const node = this.node(action.task.id), outputDigest = this.archive.researchDrafts![action.task.id].outputDigest;
    node.connectionCheckpoint = reason === 'connection' && assignment.connectionCheck && previousOutput === outputDigest
      ? { basisDigest: assignment.connectionCheck.basisDigest,
        inputDigest: this.checkpointInputDigest(action.task, worker.id), outputDigest } : undefined;
    if (!artifacts.artifacts.length || this.archive.deliveries?.some(record => record.producer === worker.id &&
        record.taskId === action.task.id && record.taskDigest === action.assignment.taskDigest && record.commit === commit)) return;
    this.record(worker, action.task, 'progress', 'advisory',
      `Supporting code saved at a ${reason} checkpoint. Inspect the retained commit and exact declarations before adopting typed work; the assigned proof remains unfinished.`,
      { commit, artifacts, remainingObligations: [action.task.id] });
  }
  /** New mathematical inputs or durable owned output earn another connection attempt. */
  protected refreshConnectionCheckpoints() {
    for (const node of this.archive.tasks) {
      const checkpoint = node.connectionCheckpoint, assignment = node.assignment;
      if (!checkpoint || node.status !== 'pending') continue;
      const worker = this.input.workers.find(worker => worker.id === assignment?.workerId);
      if (!worker || !assignment || checkpoint.basisDigest !== assignment.connectionCheck?.basisDigest ||
          !taskConnectionCheckCurrent(node.task, assignment, this.archive.tasks,
            { environmentDigest: this.input.state.environmentDigest, problemReceiptDigest: this.input.state.problem.receiptDigest }) ||
          checkpoint.inputDigest !== this.checkpointInputDigest(node.task, worker.id) ||
          this.checkpointOutputAdvanced(worker, node, { taskDigest: assignment.taskDigest, outputDigest: checkpoint.outputDigest }))
        node.connectionCheckpoint = undefined;
    }
  }
  protected suspendResearchDrafts(worker: ResearchWorker, taskId?: string) {
    let changed = false;
    for (const [id, draft] of Object.entries(this.archive.researchDrafts ?? {}))
      if (draft.workerId === worker.id && id !== taskId && !draft.suspended) { draft.suspended = true; changed = true; }
    // Persist ownership before a different responsibility overwrites the worktree.
    if (changed) this.input.save();
  }
  protected researchWorkspaceChanged(worker: ResearchWorker, node: TaskRecord) {
    if (isFeasibilityReview(node.task) && node.assignment?.feasibilityInputDigest !==
        this.feasibilityInputDigest(node.task, worker.id)) return true;
    const session = this.input.state.workers?.find(record => record.id === worker.id);
    if (session?.sessionTaskId && (session.sessionTaskId !== node.task.id ||
        session.sessionTaskVersion && session.sessionTaskVersion !== digest(node.task))) return true;
    if (!session?.sessionTaskId &&
        (session?.sessionStatementReview || session?.sessionRole && session.sessionRole !== 'researcher')) return true;
    // Restoring another task's draft can move HEAD behind this assignment's seed.
    // Session metadata alone does not establish ownership of the current checkout.
    if (node.assignment) {
      const ancestry = mathGitResult(worker.worktree, ['merge-base', '--is-ancestor', node.assignment.seedCommit, 'HEAD'],
        { maxBuffer: 4096 });
      if (ancestry.error) throw ancestry.error;
      if (ancestry.status === 1) return true;
      if (ancestry.status !== 0) throw new Error('math_research_workspace_unavailable');
    }
    if (session?.sessionTaskId) return false;
    const checkpoint = this.archive.researchCheckpoints?.[node.task.id];
    return Boolean(checkpoint && checkpoint.outputDigest !==
      this.checkpointOutputDigest(worker.worktree, git(worker.worktree, ['rev-parse', 'HEAD'])));
  }
  private async inspectResearchDraft(node: TaskRecord, assignment: TaskAssignment,
    draft: NonNullable<typeof this.archive.researchDrafts>[string]) {
    if (draft.taskDigest !== digest(node.task) || draft.workerId !== assignment.workerId ||
        draft.assignmentId !== assignment.assignmentId || draft.seedCommit !== assignment.seedCommit ||
        draft.canonicalCommit !== assignment.canonicalCommit ||
        draft.artifacts?.problemReceiptDigest !== this.input.state.problem.receiptDigest ||
        draft.artifacts?.taskId !== node.task.id || draft.artifacts?.taskDigest !== draft.taskDigest ||
        draft.artifacts?.seedCommit !== draft.seedCommit || draft.artifacts?.commit !== draft.commit) return;
    const problem = this.input.state.problem;
    return withSolverWorktree(this.lead.worktree, draft.commit, async checkout => {
      const feedback = solverSourceFeedback(problem, checkout);
      if (feedback) throw new Error(feedback);
      if (this.checkpointOutputDigest(checkout, draft.commit) !== draft.outputDigest)
        throw new Error('math_research_draft_output_changed');
      captureDeliveryArtifacts({ problem, worktree: checkout, commit: draft.commit, assignment });
      return { notes: git(checkout, ['ls-tree', '--format=%(objectname)', draft.commit, '--', 'RESEARCH.md'])
        ? committedSource(checkout, draft.commit, 'RESEARCH.md') : undefined,
        handoffNotesDigest: researchHandoffNotesDigest(committedResearchNotesDigest(checkout, draft.commit),
          committedResearchNotesDigest(checkout, draft.seedCommit), draft.handoffNotesDigest),
        canonicalSourceDigest: ownedSourceDigest(problem, checkout, draft.canonicalCommit ?? draft.seedCommit) };
    });
  }
  /** Move a stopped research snapshot, never a live writer or its session, to a free peer. */
  protected async transferResearchDraft(worker: ResearchWorker, node: TaskRecord, current: () => boolean): Promise<boolean> {
    const assignment = node.assignment, draft = this.archive.researchDrafts?.[node.task.id];
    if (!assignment || !draft || !current()) return false;
    const problem = this.input.state.problem;
    const checkpoint = this.archive.researchCheckpoints?.[node.task.id];
    let sameCheckpointInput = false;
    let prepared: { successor: TaskAssignment; commit: string; artifacts: DeliveryArtifactManifest; canonicalChanged: boolean;
      handoffNotesDigest?: string };
    try {
      const saved = await this.inspectResearchDraft(node, assignment, draft);
      if (!saved || !current() || node.assignment !== assignment || this.archive.researchDrafts?.[node.task.id] !== draft) return false;
      // Snapshot inspection yields to other publications. Only the inputs still
      // current after that wait may inherit the old unchanged counters.
      sameCheckpointInput = checkpoint?.taskDigest === digest(node.task) && this.checkpointInputMatches(node, assignment.workerId,
        checkpoint, this.checkpointLocalInputDigest(node.task, assignment.workerId));
      const canonical = this.archive.canonicalCommit!;
      const canonicalChanged = ownedSourceDigest(problem, this.lead.worktree, canonical) !== saved.canonicalSourceDigest;
      this.suspendResearchDrafts(worker, node.task.id);
      if (canonicalChanged) this.seed(worker, canonical, node.task);
      else git(worker.worktree, ['reset', '--hard', draft.commit]);
      const notesFile = path.join(worker.worktree, 'RESEARCH.md');
      if (saved.notes === undefined) fs.rmSync(notesFile, { force: true });
      else fs.writeFileSync(notesFile, saved.notes);
      const commit = commitSolverSources(problem, worker.worktree);
      const successor: TaskAssignment = { taskId: node.task.id, taskDigest: digest(node.task), workerId: worker.id,
        assignmentId: crypto.randomUUID(), seedCommit: canonicalChanged ? commit : assignment.seedCommit,
        canonicalCommit: canonicalChanged ? canonical : assignment.canonicalCommit, groupId: taskGroup(node.task),
        routeId: assignment.routeId,
        dependencies: this.dependencies(node.task).map(input => ({ taskId: input.task.id, taskDigest: digest(input.task) })) };
      const artifacts = captureDeliveryArtifacts({ problem, worktree: worker.worktree, commit, assignment: successor });
      this.pin(draft.commit); this.pin(commit);
      prepared = { successor, commit, artifacts, canonicalChanged, handoffNotesDigest: saved.handoffNotesDigest };
    } catch (error) {
      this.input.signal.throwIfAborted();
      this.input.emit('research_draft_transfer_failed', { taskId: node.task.id, workerId: worker.id,
        reason: error instanceof Error ? error.message : 'math_research_draft_transfer_failed' });
      return false;
    }
    const { successor, commit, artifacts, canonicalChanged, handoffNotesDigest } = prepared;
    node.assignment = successor;
    this.preserveResearchDraft(worker, { kind: 'task', task: node.task, assignment: successor }, commit, artifacts, { handoffNotesDigest });
    // Keep the original writer and immutable source as advisory provenance; its
    // late events no longer match the successor assignment object or delivery log.
    // Persistence failures propagate after installing the successor, rather than
    // returning a retryable failure for a transfer that already changed ownership.
    const previousWorker = this.input.workers.find(peer => peer.id === assignment.workerId)!;
    this.record(previousWorker, node.task, 'progress', 'advisory',
      'Saved research draft transferred to an available peer. The original snapshot remains advisory and requires independent checking.',
      { commit: draft.commit, artifacts: draft.artifacts, assignmentKey: assignmentDeliveryFile(assignment),
        remainingObligations: [node.task.id] });
    if (checkpoint && sameCheckpointInput && this.archive.researchCheckpoints?.[node.task.id] === checkpoint &&
        checkpoint.outputDigest === this.checkpointOutputDigest(worker.worktree, commit)) {
      // Changing the writer and emitting handoff provenance is not mathematical
      // progress. Keep the task's unchanged-count and backoff across the transfer.
      checkpoint.localInputDigest = this.checkpointLocalInputDigest(node.task, worker.id);
      checkpoint.inputDigest = this.checkpointInputDigest(node.task, worker.id);
    }
    this.input.emit('research_draft_transferred', { taskId: node.task.id, taskDigest: successor.taskDigest,
      fromWorkerId: assignment.workerId, workerId: worker.id, sourceCommit: draft.commit, commit,
      previousAssignmentId: assignment.assignmentId, assignmentId: successor.assignmentId, canonicalChanged });
    this.input.save();
    return true;
  }
  protected async restoreResearchDraft(worker: ResearchWorker, node: TaskRecord): Promise<boolean> {
    const draft = this.archive.researchDrafts?.[node.task.id], assignment = node.assignment!;
    if (!draft || assignment.workerId !== worker.id) return false;
    const problem = this.input.state.problem;
    try {
      const feasibility = isFeasibilityReview(node.task);
      const resumeInput = () => draft.feasibilityInputDigest === assignment.feasibilityInputDigest
        ? resumableFeasibilityReviewInput(this.feasibilityInput(node.task, worker.id), draft) : undefined;
      let feasibilityInputDigest = feasibility ? resumeInput() : undefined;
      if (feasibility && !feasibilityInputDigest) {
        draft.suspended = true;
        this.input.emit('research_draft_restore_failed', { taskId: node.task.id,
          reason: 'math_feasibility_draft_input_changed' });
        this.input.save();
        return false;
      }
      const saved = await this.inspectResearchDraft(node, assignment, draft);
      if (!saved || !this.archive.tasks.includes(node) || node.assignment !== assignment || digest(node.task) !== draft.taskDigest ||
          node.status !== 'pending' || assignment.workerId !== worker.id || node.task.ownerId && node.task.ownerId !== worker.id ||
          !independentFeasibilityWorker(node, worker, this.archive.tasks, this.archive.groups) ||
          !taskCanStart(node.task, this.archive.tasks, this.archive.groups) || !routeAllowsTask(node.task, this.archive.tasks, this.archive.groups)) return false;
      // Snapshot inspection yields. Recheck against the latest inputs before restoring.
      if (feasibility && !(feasibilityInputDigest = resumeInput())) {
        draft.suspended = true;
        this.input.save();
        return false;
      }
      const canonicalChanged = ownedSourceDigest(problem, this.lead.worktree, this.archive.canonicalCommit!) !== saved.canonicalSourceDigest;
      this.suspendResearchDrafts(worker, node.task.id);
      if (canonicalChanged) {
        if (draft.artifacts.artifacts.some(artifact => artifact.kind === 'owned-source'))
          this.record(worker, node.task, 'progress', 'advisory',
            'Saved research source draft retained separately while the canonical proof advanced; it requires independent checking.',
            { commit: draft.commit, artifacts: draft.artifacts, remainingObligations: [node.task.id] });
        fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), '');
        const seedCommit = this.seed(worker, this.archive.canonicalCommit!, node.task);
        // A connection permission binds the old seed and dispatch, so the normal
        // dispatcher must rebuild it for the restored sources and new identity.
        node.assignment = { ...assignment, assignmentId: crypto.randomUUID(), seedCommit,
          canonicalCommit: this.archive.canonicalCommit, connectionCheck: undefined,
          ...(feasibility ? { feasibilityInputDigest } : {}) };
      } else {
        // Restore the validated snapshot so its frozen seed remains an ancestor.
        git(worker.worktree, ['reset', '--hard', draft.commit]);
      }
      // Preserve the distinction between missing notes and an empty tracked file.
      const notesFile = path.join(worker.worktree, 'RESEARCH.md');
      if (saved.notes === undefined) fs.rmSync(notesFile, { force: true });
      else fs.writeFileSync(notesFile, saved.notes);
      const commit = commitSolverSources(problem, worker.worktree);
      // A rebased assignment starts with the restored notes too. Otherwise the host's restoration
      // looks like a fresh notes write relative to an empty seed and can attribute inherited text.
      if (canonicalChanged) node.assignment = { ...node.assignment!, seedCommit: commit };
      this.preserveResearchDraft(worker, { kind: 'task', task: node.task, assignment: node.assignment! }, commit,
        captureDeliveryArtifacts({ problem, worktree: worker.worktree, commit, assignment: node.assignment! }),
        { handoffNotesDigest: saved.handoffNotesDigest });
      this.input.emit('research_draft_restored', { taskId: node.task.id, commit, canonicalChanged });
      this.input.save();
      return true;
    } catch (error) {
      this.input.signal.throwIfAborted();
      this.input.emit('research_draft_restore_failed', { taskId: node.task.id,
        reason: error instanceof Error ? error.message : 'math_research_draft_restore_failed' });
      return false;
    }
  }
  protected async researchCheckpoint(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>, commit: string, countStagnation: boolean) {
    if (isFeasibilityReview(action.task) && !this.node(action.task.id).nextCheckId) {
      // A saved independent review is only a handoff, even if its notes contain a provisional result.
      // Do not publish it, complete the review or apply ordinary research stagnation parking.
      // Host-scoped next checks retain their explicit partial-finding/outcome protocol below.
      this.input.emit('feasibility_review_checkpoint_saved', { taskId: action.task.id, workerId: worker.id,
        commit, inputDigest: action.assignment.feasibilityInputDigest, acceptance: 'not-assessed' });
      this.interrupted(worker, action);
      return;
    }
    const node = this.node(action.task.id), taskDigest = digest(node.task);
    const notesBlob = git(worker.worktree, ['ls-tree', '--format=%(objectname)', commit, '--', 'RESEARCH.md']);
    const notes = notesBlob ? committedSource(worker.worktree, commit, 'RESEARCH.md') : '';
    const artifacts = this.archive.researchDrafts?.[node.task.id]?.artifacts;
    const previous = this.archive.researchCheckpoints?.[node.task.id];
    const advisoryCheckpoint = this.input.state.workers?.find(record => record.id === worker.id)?.advisoryCheckpoint;
    const checkpointScope = mathDigest(canonicalMathJson({ kind: 'task', taskDigest }));
    let checkpoint: NonNullable<typeof this.archive.researchCheckpoints>[string] | undefined;
    if (countStagnation) {
      const inputDigest = this.checkpointInputDigest(node.task, worker.id), outputDigest = this.checkpointOutputDigest(worker.worktree, commit);
      const localInputDigest = this.checkpointLocalInputDigest(node.task, worker.id);
      const candidate = checkpointCandidate(notes, artifacts);
      const sameInput = previous?.taskDigest === taskDigest && this.checkpointInputMatches(node, worker.id, previous, localInputDigest);
      const count = sameInput && previous.outputDigest === outputDigest
        ? previous.count + 1 : 1;
      const unchangedEvidenceCount = sameInput && previous.candidateOutputDigest === candidate.digest
        ? (previous.unchangedEvidenceCount ?? 1) + 1 : 1;
      const paused = count >= 3 && unchangedEvidenceCount >= 2;
      checkpoint = (this.archive.researchCheckpoints ??= {})[node.task.id] = { taskDigest, inputDigest, outputDigest,
        localInputDigest, candidateOutputDigest: candidate.digest, candidateStatus: candidate.status, unchangedEvidenceCount, count, paused,
        ...(advisoryCheckpoint?.scope === checkpointScope ? { advisoryCheckpoint: { ...advisoryCheckpoint } } : {}) };
      this.input.emit('research_checkpoint_recorded', { taskId: node.task.id, ...checkpoint });
    } else {
      if (previous?.taskDigest === taskDigest && advisoryCheckpoint?.scope === checkpointScope)
        previous.advisoryCheckpoint = { ...advisoryCheckpoint };
      this.input.emit('research_proof_handoff_saved', { taskId: node.task.id, workerId: worker.id, commit });
    }
    // A checkpoint is a partial publication, not a completed investigation. Only
    // explicit control JSON is eligible; ordinary prose and unfinished JSON remain drafts.
    let finding: any;
    try { finding = parseMathResponse(notes, 'math-result'); }
    catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error &&
          ['math_math-result_requires_one_block', 'math_response_invalid'].includes(error.message))) throw error;
    }
    const inherited = git(worker.worktree, ['ls-tree', '--format=%(objectname)', action.assignment.seedCommit, '--', 'RESEARCH.md']);
    // Scoped checkOutcome has a separate completion protocol; never settle it merely
    // because the scheduler yielded its writer.
    if (finding && finding.checkOutcome === undefined && notesBlob !== inherited) {
      taskChanges(this.input.state.problem, worker.worktree, commit, node.task, action.assignment);
      await this.publishResearchFinding(worker, action, commit, { kind: 'notes', text: notes }, { artifacts, checkpoint: true });
      if (!this.current(action)) return;
    }
    if (checkpoint?.paused) {
      const { inputDigest, outputDigest } = checkpoint;
      const scope = `assigned-local-inference/checkpoint:${mathDigest(canonicalMathJson({ inputDigest, outputDigest }))}`;
      this.reportBlockers(node.task, [{ mechanism: 'unchanged-research-checkpoint', scope }]);
      Object.assign(checkpoint, { blockerId: this.archive.blockers?.find(record => record.taskId === node.task.id && record.scope === scope)?.id });
      this.rejected(action, UNCHANGED_RESEARCH_CHECKPOINT, commit);
    } else this.interrupted(worker, action);
  }
  protected async publishResearchFinding(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>, commit: string,
    submission: ResearchSubmission, options: Partial<DeliveryRecord> & { checkpoint?: boolean } = {}, sources?: unknown, probes?: unknown) {
    const { checkpoint = false, ...deliveryOptions } = options;
    // A publication belongs to the inputs dispatched to this writer, even if its live
    // assignment gains a newer context while the asynchronous checks are running.
    const assignment = structuredClone(action.assignment), basis = assignment.researchBasis;
    const assignmentKey = assignmentDeliveryFile(assignment);
    const environmentDigest = this.input.state.environmentDigest, problemReceiptDigest = this.input.state.problem.receiptDigest;
    // Explicit bytes form one immutable event snapshot. Never read the live writer's
    // source files or index while publishing advisory support.
    let sourceSnapshot: [string, string][] | undefined;
    if (sources !== undefined) {
      const owned = this.input.state.problem.ownedFiles.filter(file => file.endsWith('.lean') &&
        !Object.hasOwn(this.input.state.problem.frozenFiles ?? {}, file));
      const invalid = (message: string) => new ResearchAdmissionError({ status: 'rejected', code: 'math_delivery_invalid',
        issues: [{ path: 'sources', message }], recovery: 'correct-and-resubmit' });
      if (submission.kind !== 'event' || !sources || typeof sources !== 'object' || Array.isArray(sources))
        throw invalid('Provide the complete owned Lean sources as an object of file paths to source strings.');
      const entries = Object.entries(sources);
      if (entries.length !== owned.length || entries.some(([file, source]) => !owned.includes(file) || typeof source !== 'string'))
        throw invalid('Include every owned .lean file exactly once, using problem-relative paths and complete source strings.');
      sourceSnapshot = entries as [string, string][];
      if (sourceSnapshot.reduce((bytes, [, source]) => bytes + Buffer.byteLength(source), 0) > MAX_RESEARCH_NOTES_BYTES)
        throw invalid('The combined owned Lean source snapshot must not exceed ' + MAX_RESEARCH_NOTES_BYTES + ' UTF-8 bytes.');
    }
    const admission = prepareResearchDelivery(checkpoint && submission.kind === 'notes'
      ? { kind: 'event', value: { ...parseMathResponse(submission.text, 'math-result'), needsDecision: true } } : submission, { source: action.task,
      assignment, tasks: this.archive.tasks, deliveries: this.archive.deliveries,
      nextChecks: this.archive.nextChecks, proofSearchRecords: this.archive.proofSearchRecords,
      identity: { problemReceiptDigest, environmentDigest } });
    if (admission.status === 'rejected') throw new ResearchAdmissionError(submission.kind === 'event' && admission.code === 'math_route_blocker_invalid'
      ? { ...admission, issues: admission.issues.map(issue => ({ ...issue, path: 'finding.' + issue.path })) } : admission);
    const finding = structuredClone(admission.finding), text = JSON.stringify(finding);
    const complete = !checkpoint && (submission.kind === 'notes' || finding.checkOutcome !== undefined);
    const node = this.node(action.task.id), details = deliveryDetails(finding);
    const lemmaRequests = validateLemmaRequests(this.input.state.problem, this.archive.tasks.map(node => node.task),
      this.archive.groups?.map(route => route.group) ?? [], node.task, finding.lemmaRequests,
      this.archive.deliveries?.filter(delivery => delivery.kind === 'research' && delivery.status !== 'superseded' &&
        delivery.taskId === node.task.id && delivery.taskDigest === digest(node.task)).flatMap(delivery => delivery.lemmaRequests ?? []));
    const explorationIds = new Set(this.archive.tasks.filter(item => item.capacityExploration).map(item => item.task.id));
    if (lemmaRequests.some(proposal => proposal.dependsOn.some(id => explorationIds.has(id))))
      throw new Error('math_research_lemma_requests_invalid: advisory exploration IDs are provenance, not typed proof inputs.');
    const publish = async (fixedWorker: ResearchWorker, fixedCommit: string) => {
      if (!this.current(action)) return;
      let artifacts = deliveryOptions.artifacts ?? captureDeliveryArtifacts({ problem: this.input.state.problem,
        worktree: fixedWorker.worktree, commit: fixedCommit, assignment });
      artifacts = { ...artifacts, reportedChecks: validateDeliveryArtifactClaims(finding, artifacts) };
      const sourceDigest = ownedSourceDigest(this.input.state.problem, fixedWorker.worktree, fixedCommit);
      const findingKey = checkpoint ? canonicalMathJson(finding) : '';
      const artifactKey = checkpoint ? checkpointCandidate('', artifacts).digest : '';
      const basisKey = checkpoint ? canonicalMathJson(basis ?? assignmentKey) : '';
      // Compare immutable content and dispatch inputs, not Git metadata or note offsets.
      // The existing deliveries persist this identity across task switches and restarts.
      const alreadyPublished = () => checkpoint && (this.archive.deliveries ?? []).some(record => {
        if (record.kind !== 'research' || record.status === 'superseded' || record.producer !== worker.id ||
            record.taskId !== action.task.id || record.taskDigest !== assignment.taskDigest || record.sourceDigest !== sourceDigest ||
            record.artifacts?.problemReceiptDigest !== problemReceiptDigest ||
            canonicalMathJson(record.researchRecord?.basis ?? record.assignmentKey ?? null) !== basisKey ||
            checkpointCandidate('', record.artifacts).digest !== artifactKey) return false;
        const previous = deliveryFinding(record);
        try { return previous !== undefined && canonicalMathJson(JSON.parse(previous)) === findingKey; }
        catch { return false; }
      });
      if (alreadyPublished()) return;
      const artifactWarning = diagnoseUnbackedLeanClaims(finding, artifacts);
      const knowledge = this.captureKnowledgeUseCheck(fixedWorker, node.task, fixedCommit);
      const knowledgeUses = await checkKnowledgeApplications(knowledge.uses, knowledge.input);
      if (!this.current(action) || this.node(action.task.id) !== node || worker.id !== assignment.workerId ||
          assignmentDeliveryFile(action.assignment) !== assignmentKey || environmentDigest !== this.input.state.environmentDigest ||
          problemReceiptDigest !== this.input.state.problem.receiptDigest) return;
      if (alreadyPublished()) return;
      if (details.mathematicalGap) bindMathematicalGap(details.mathematicalGap, node.task, this.archive,
        { problemReceiptDigest, environmentDigest });
      const checkOutcomeScope = details.checkOutcome && bindCheckOutcome(details.checkOutcome, node.task, assignment,
        this.archive, { problemReceiptDigest, environmentDigest });
      const remaining = [...new Set([...(details.remainingObligations ?? []),
        ...this.dependencies(node.task).filter(dependency => !['integrated', 'completed'].includes(dependency.status)).map(dependency => dependency.task.id)])];
      // Creating the delivery pins its immutable evidence before completed becomes
      // observable. The delivery and its completion record publish together below.
      const record = this.createDeliveryRecord(worker, node.task, 'research',
        !remaining.length && node.task.kind !== 'sketch' ? 'advisory' : 'conditional', details.summary,
        { ...details, ...deliveryOptions, assignmentKey, remainingObligations: remaining, commit: fixedCommit, artifacts,
          sourceDigest,
          lemmaRequests, finding: text, findingDigest: mathDigest(text), knowledgeUses,
          ...(checkOutcomeScope ? { checkOutcomeScope } : {}),
          ...(artifactWarning ? { artifactWarning } : {}) });
      record.researchRecord = settleResearch({ id: record.id, assignment, basis, commit: fixedCommit, finding: text, complete });
      // A challenge alone is never a repeated-blocker report that parks the proof task.
      this.reportBlockers(node.task, finding.blockers ?? (complete && finding.conclusion === 'refuted' ? [{
        mechanism: 'reported-local-refutation', scope: 'assigned-local-inference', evidenceRefs: details.evidenceRefs,
      }] : undefined));
      (this.archive.deliveries ??= []).push(record);
      if (complete) {
        node.finding = text; this.moveTask(node, 'completed', 'research-completed'); node.feedback = undefined;
        node.researchCompletion = record.researchRecord;
        if (this.archive.unchangedResearch) delete this.archive.unchangedResearch[node.task.id];
        if (this.archive.researchCheckpoints) delete this.archive.researchCheckpoints[node.task.id];
      }
      if (finding.needsDecision === true || finding.conclusion === 'refuted' || lemmaRequests.length || artifactWarning) this.wakeLead('research-finding');
      this.resolveDeliveryReceipts(worker, action, finding.replacesReceipt, complete);
      this.publishDeliveryRecord(record);
      this.observeKnowledgeUses(node.task, fixedCommit, knowledgeUses, knowledge.rejected);
      this.input.emit('research_delivered', { taskId: node.task.id, conclusion: finding.conclusion, complete });
    };
    if (submission.kind === 'notes') await publish(worker, commit);
    else {
      // Explicit events leave the writer's live files and Git index untouched.
      await withSolverWorktree(worker.worktree, commit, async checkout => {
        for (const [file, source] of sourceSnapshot ?? [])
          fs.writeFileSync(path.join(checkout, this.input.state.problem.projectRelative, file), source);
        fs.writeFileSync(path.join(checkout, 'RESEARCH.md'), researchPublicationNotes(finding, probes));
        await publish({ ...worker, worktree: checkout }, commitSolverSources(this.input.state.problem, checkout));
      });
    }
  }
  protected sourceProjector(worktree: string, commit: string, compact = false,
    preserved: readonly { file: string; name: string }[] = []) {
    const identity = mathDigest(canonicalMathJson({ problem: this.input.state.problem, worktree, commit, compact, preserved }));
    let cached = this.preparedSources.get(compact);
    if (cached?.identity !== identity) {
      cached = { identity, project: createTaskSourceProjector(this.input.state.problem, worktree, commit, { compact, preserved }) };
      this.preparedSources.set(compact, cached);
    }
    return cached.project;
  }
  protected sourceGoalInputs(task: CooperativeTask, tasks: readonly TaskRecord[], worktree: string, commit: string,
    conditions: readonly CooperativeTask[] = []) {
    try { return projectedGoalInputs(this.sourceProjector(worktree, commit), task, tasks, conditions, (sourceTask, error) => {
      if (sourceTask.id !== task.id) this.input.emit('task_source_input_unavailable', { taskId: task.id,
        sourceTaskId: sourceTask.id, commit, reason: bounded(error instanceof Error ? error.message : String(error), 2000) });
    }); }
    catch { return []; } // Missing draft declarations are diagnosed by the actual proof check.
  }
  protected retainedTaskGoals(task: CooperativeTask, tasks: readonly TaskRecord[], worktree: string, commit: string,
    conditions: readonly CooperativeTask[] = []) {
    const goals = new Set(this.dependencies(task, tasks).filter(node => node.task.kind === 'goal' &&
      node.task.id !== task.id && node.status === 'integrated').map(node => node.task.theoremName!));
    for (const node of this.sourceGoalInputs(task, tasks, worktree, commit, conditions)) {
      const proof = node.integratedCheck;
      // Retain this candidate's source for a new kernel check, rather than reuse
      // the earlier receipt. Whole-module references may change with unrelated helpers.
      if (node.status === 'integrated' && proof?.passed && !proof.conditions?.length &&
          proof.taskDigest === digest(node.task) && this.checkedDeliveries.has(proof) && hasTaskAcceptance(proof))
        goals.add(node.task.theoremName!);
    }
    return [...goals];
  }
  protected assignmentConditions(task: CooperativeTask, assignment?: TaskAssignment,
    tasks: readonly TaskRecord[] = this.archive.tasks, worktree = this.lead.worktree): readonly CooperativeTask[] {
    const dependencies = this.dependencies(task, tasks);
    if (!assignment?.connectionCheck) {
      if (!task.conditional) return [];
      if (!assignment) return dependencies.filter(node => assumableLemma(node.task) && node.status !== 'integrated').map(node => node.task);
      if (assignment.taskId !== task.id || assignment.taskDigest !== digest(task)) throw new Error('math_task_condition_version_invalid');
      // Explicit conditional contracts also authorize only their frozen, exact dispatch inputs.
      return (assignment.dependencies ?? []).map(reference => {
        const input = tasks.find(node => node.task.id === reference.taskId);
        if (!input || digest(input.task) !== reference.taskDigest) throw new Error('math_task_condition_version_invalid');
        return input.task;
      }).filter(input => assumableLemma(input));
    }
    if (!taskConnectionCheckCurrent(task, assignment, tasks)) throw new Error('math_task_condition_version_invalid');
    const check = assignment.connectionCheck;
    // Historical dispatches predate assumedInputs. Reconstruct only from their immutable seed,
    // never from a dependency's integration status at the time this delivery is checked.
    const assumed = check.assumedInputs ?? taskInputsMissingFromSeed(check.inputs, tasks, dependency =>
      committedSource(worktree, assignment.seedCommit, `${this.input.state.problem.projectRelative}/${dependency.proofPath}`));
    return assumed.map(reference => tasks.find(node => node.task.id === reference.taskId)!.task);
  }
  protected async check(task: CooperativeTask, assignment: TaskAssignment, worktree: string, commit: string,
    conditions?: readonly CooperativeTask[], checked?: TaskProof, reuseDeliveryFailure = false, incompleteDelivery = false,
    taskGraph: readonly TaskRecord[] = this.archive.tasks,
    checkEnvironment?: { environment: NodeJS.ProcessEnv; digest: string },
    additionalRetainedGoals: readonly string[] = []): Promise<TaskProof> {
    this.input.signal.throwIfAborted();
    if (reuseDeliveryFailure && !checked) {
      const candidate = this.failedTaskInput(task, assignment, worktree, commit, conditions);
      const previous = this.previousTaskFailure(candidate);
      if (previous) {
        this.input.emit('task_failure_check_reused', { taskId: task.id, taskDigest: digest(task), commit, failureId: previous.id });
        throw new Error(this.repeatedTaskFeedback(previous));
      }
      const pending = this.checkingTaskInputs.get(candidate.id);
      if (pending) {
        await pending;
        return this.check(task, assignment, worktree, commit, conditions, checked, true, incompleteDelivery);
      }
      let finish!: () => void;
      const checking = new Promise<void>(resolve => { finish = resolve; });
      this.checkingTaskInputs.set(candidate.id, checking);
      this.refreshPlanApproval();
      const reserveRepair = () => {
        const node = this.node(task.id);
        return node?.assignment === assignment && digest(node.task) === candidate.taskDigest &&
          (incompleteDelivery || this.firstTaskRepair(node, candidate.id))
          ? { taskId: task.id, taskDigest: candidate.taskDigest, workerId: assignment.workerId, pending: true } : undefined;
      };
      try {
        const proof = await this.check(task, assignment, worktree, commit, conditions, checked);
        if (this.deterministicTaskFailure(proof)) this.rememberTaskFailure(candidate, solverProofFeedback(proof), reserveRepair());
        return proof;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('math_task_missing_declaration\n')) {
          const node = this.node(task.id);
          const mathematicalBlocker = node?.assignment === assignment && this.reportedTaskMathematicalBlocker(node, candidate);
          // Persist the block with the failure so restart recovery cannot invent a code repair.
          if (mathematicalBlocker) { this.moveTask(node, 'blocked', 'input-blocked'); node.feedback = error.message; this.wakeLead('task-blocked'); }
          this.rememberTaskFailure(candidate, error.message, mathematicalBlocker ? undefined : reserveRepair());
        }
        throw error;
      } finally {
        this.checkingTaskInputs.delete(candidate.id); finish(); this.wake();
      }
    }
    const tasks = taskGraph.map(node => ({ ...node }));
    const taskDigest = digest(task);
    const environmentDigest = checkEnvironment?.digest ?? this.input.state.environmentDigest;
    if (assignment.connectionCheck && !taskConnectionCheckCurrent(task, assignment, tasks,
      { environmentDigest, problemReceiptDigest: this.input.state.problem.receiptDigest }))
      throw new Error('math_task_condition_version_invalid');
    conditions ??= this.assignmentConditions(task, assignment, tasks, worktree);
    const retainedGoals = [...new Set([...this.retainedTaskGoals(task, tasks, worktree, commit, conditions),
      ...additionalRetainedGoals.filter(name => name !== task.theoremName)])];
    const checker = this.input.modules.M2.checkTask ?? checkTaskProof;
    const environment = checkEnvironment?.environment ?? this.input.access.get(this.lead.id)!.environment;
    const proof = checked ?? await checker(this.input.state.problem, worktree, commit, task, assignment, retainedGoals,
      environment, this.input.signal, this.input.timeoutMs, conditions, environmentDigest,
      ...(checker === checkTaskProof ? [this.taskProofCache] : []));
    const failureContext = { taskId: task.id, taskDigest, sourceCommit: commit,
      seedCommit: assignment.seedCommit, projectionMode: proof.projectionMode ?? 'full' as const,
      conditions: conditions.map(task => ({ taskId: task.id, taskDigest: digest(task) })), verification: proof.verification };
    const identityFailure = () => new VerifierFailureError({ ...failureContext, stage: 'task-proof-identity' },
      undefined, 'math_task_check_identity_changed');
    const reuse = trustedTaskProjectionReuse(proof);
    if (proof.projectionReuse && !reuse || checker === checkTaskProof && proof.passed && !isAttributedTaskProof(proof))
      throw identityFailure();
    if (checker === checkTaskProof && !isAttributedTaskProof(proof)) throw new VerifierFailureError({
      ...failureContext, stage: 'task-proof-attribution' });
    const projectionCommit = reuse?.projectionCommit ?? proof.verification.targetCommit;
    if (reuse && (reuse.checkedProjectionCommit !== proof.verification.targetCommit ||
        git(worktree, ['rev-parse', `${reuse.projectionCommit}^{tree}`]) !== reuse.projectionTree ||
        git(worktree, ['rev-parse', `${reuse.checkedProjectionCommit}^{tree}`]) !== reuse.projectionTree))
      throw identityFailure();
    const declarationHash = proof.passed && proof.verification.targetCommit && hashMathFormalSourceDeclaration(
      committedSource(worktree, proof.verification.targetCommit, `${this.input.state.problem.projectRelative}/${task.proofPath}`), task.theoremName!);
    const compact = isAttributedTaskProof(proof) && proof.projectionMode === 'compact';
    const projected = (proof.passed || reuse) && this.sourceProjector(worktree, commit, compact,
      compact ? proof.changes : [])(task, retainedGoals, conditions);
    const allowed = new Set(this.input.state.problem.ownedFiles.map(file => `${this.input.state.problem.projectRelative}/${file}`));
    allowed.add('RESEARCH.md');
    const projectionMatches = projected && projectionCommit &&
      [...projected].every(([file, source]) => source === committedSource(worktree, projectionCommit,
        `${this.input.state.problem.projectRelative}/${file}`)) &&
      git(worktree, ['diff', '--no-renames', '--name-only', '-z', commit, projectionCommit, '--'])
        .split('\0').filter(Boolean).every(file => allowed.has(file));
    if (proof.commit !== commit || proof.taskDigest !== taskDigest || proof.seedCommit !== assignment.seedCommit ||
        proof.sourceDigest !== ownedSourceDigest(this.input.state.problem, worktree, commit) ||
        canonicalMathJson(proof.conditions ?? []) !== canonicalMathJson(conditions.map(task => ({ taskId: task.id, taskDigest: digest(task) }))) ||
        (reuse && !projectionMatches) ||
        (proof.passed && (!projectionMatches || !declarationHash || !proofReceiptsMatch(proof.verification, proof.verification.targetCommit,
          [{ proofPath: task.proofPath!, theoremName: task.theoremName!, expectedSourceDeclarationHash: declarationHash,
            statementHash: taskDigest, leanStatementHash: taskDigest, claim: 'statement' }]))))
      throw identityFailure();
    if (proof.passed && conditions.length && projected) proof.projection = {
      environmentDigest,
      problemReceiptDigest: this.input.state.problem.receiptDigest,
      sourceDigest: mathDigest(canonicalMathJson([...projected])),
    };
    else delete proof.projection;
    if (proof.references) {
      const references = proof.references;
      references.tasks = attributeTaskReferences(references, tasks);
      markTaskReferences(proof);
    }
    this.pin(proof.commit); this.pin(projectionCommit); this.pin(proof.verification.targetCommit);
    this.checkedDeliveries.add(proof); markTaskAcceptance(proof);
    return proof;
  }
  /** Check isolated sources concurrently; only publishing and canonical integration are serialized. */
  protected async publishTaskProof(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>,
    commit: string, summary: string, options: Partial<DeliveryRecord> = {}, recovering = false,
    prepared?: ProofDeliveryRequest['prepared']) {
    const key = canonicalMathJson([worker.id, assignmentDeliveryFile(action.assignment), commit]);
    const previous = this.proofPublications.get(key);
    if (previous) {
      const request = this.proofDeliveryRequests.get(key);
      if (request) {
        for (const field of Object.keys(options) as (keyof DeliveryRecord)[]) {
          const value = options[field];
          if (value !== undefined && request.options[field] === undefined) Object.assign(request.options, { [field]: value });
        }
        if (options.evidenceRefs) request.options.evidenceRefs = [...new Set([...(request.options.evidenceRefs ?? []), ...options.evidenceRefs])];
        if (request.record) await this.input.exclusiveCheck(async () => this.mergeProofDeliveryMetadata(request));
      }
      return previous.pending;
    }
    const request: ProofDeliveryRequest = { worker, action, commit, summary, options: { ...options }, prepared };
    this.proofDeliveryRequests.set(key, request);
    const pending = this.publishCheckedTaskProof(request, recovering);
    const publication = { workerId: worker.id, action, pending };
    this.proofPublications.set(key, publication);
    try { this.changed(); return await pending; }
    finally {
      const current = this.proofPublications.get(key) === publication;
      if (current) this.proofPublications.delete(key);
      if (this.proofDeliveryRequests.get(key) === request) this.proofDeliveryRequests.delete(key);
      if (current) this.changed();
    }
  }
  private async publishCheckedTaskProof(request: ProofDeliveryRequest, recovering: boolean): Promise<TaskProof | undefined> {
    const { worker, action, commit, options, prepared } = request;
    if (prepared && !prepared.current()) return;
    const previous = this.node(action.task.id);
    // Notes-only completion cannot renew obsolete conditional inputs after unconditional integration.
    const notesOnly = previous?.status === 'integrated' && previous.proof && taskReferenceDependencies(previous) &&
      proofReferencesUnchanged(this.input.state.problem, this.lead.worktree, this.archive.canonicalCommit!,
        previous.integratedCheck!.references!, this.input.state.environmentDigest) &&
      git(worker.worktree, ['diff', '--no-renames', '--name-only', '-z', previous.proof.commit, commit, '--'])
        .split('\0').filter(Boolean).every(file => file === 'RESEARCH.md');
    const proof = previous?.proof && (previous.proof.commit === commit || notesOnly) &&
      ['delivered', 'conditional', 'integrated'].includes(previous.status) && this.checkedDeliveries.has(previous.proof) ? previous.proof :
      await this.check(action.task, action.assignment, worker.worktree, commit, undefined, prepared?.proof, true, recovering);
    const staged = await this.input.exclusiveCheck(async () => {
      if (prepared) {
        if (!prepared.current()) return;
        prepared.claim();
      }
      if (!this.current(action) || !(proof.references?.tasks ?? []).every(reference =>
          this.archive.tasks.some(node => node.task.id === reference.taskId && digest(node.task) === reference.taskDigest))) {
        this.record(worker, action.task, 'proof', 'superseded', 'Assignment changed while its proof was being checked.',
          { ...options, commit, taskDigest: action.assignment.taskDigest, dependencies: action.assignment.dependencies ?? [] });
        this.input.emit('task_delivery_superseded', { taskId: action.task.id, workerId: worker.id, commit });
        return;
      }
      const node = this.node(action.task.id);
      if (['conditional', 'integrated'].includes(node.status)) {
        return { node, proof: node.proof?.commit === commit ? node.proof : undefined, publication: this.proofDeliveryState(node) };
      }
      if (recovering && !proof.passed && proof.verification.status === 'failed') {
        node.feedback = solverProofFeedback(proof);
        if (this.deterministicTaskFailure(proof)) this.continueTaskCheckpoint(worker, node, commit);
        this.interrupted(worker, action);
        return { node: undefined, proof };
      }
      this.deliverProof(node, proof);
      return { node, proof, publication: this.proofDeliveryState(node) };
    });
    if (!staged?.node) return staged?.proof;
    return this.settleProofDeliveries(annotations => this.queueIntegration(async () => {
      const node = staged.node, submitted = staged.proof;
      if (submitted && this.current(action) && node.proof === submitted) {
        let publication: ProofDeliveryState | undefined = staged.publication;
        if (node.status === 'delivered') publication = await this.integrateNow(node);
        else if (node.status === 'integrated') await this.syncPreparedStatements();
        if (publication) {
          const annotate = await this.publishProofDelivery(node, request, publication);
          if (annotate) annotations.push(annotate);
        }
      }
      await this.integrateReadyNow(annotations);
      return submitted;
    }, worker, action.task));
  }
  protected currentTaskSourceRepair(node: TaskRecord) {
    const repair = node.sourceRepair, assignment = node.assignment;
    return repair && assignment && repair.taskDigest === digest(node.task) && repair.taskDigest === assignment.taskDigest &&
      repair.workerId === assignment.workerId && repair.assignmentId === assignment.assignmentId &&
      repair.seedCommit === assignment.seedCommit ? repair : undefined;
  }
  protected restoreTaskSourceRepair(node: TaskRecord) {
    const repair = this.currentTaskSourceRepair(node);
    if (!repair || repair.pending || repair.startedAttempt !== node.attempts) return;
    repair.pending = true; delete repair.startedAttempt;
    this.input.emit('task_repair_interrupted', { taskId: node.task.id, workerId: repair.workerId, reason: 'source-contract' });
  }
  protected settleTaskSourceRepair(node: TaskRecord) {
    const repair = this.currentTaskSourceRepair(node);
    if (repair && !repair.pending) delete repair.startedAttempt;
  }
  protected retryTaskSourceLocally(node: TaskRecord): boolean {
    const assignment = node.assignment;
    if (!assignment || !this.liveWorkers.has(assignment.workerId)) return false;
    let repair = this.currentTaskSourceRepair(node);
    if (repair ? !repair.pending : !this.firstTaskRepair(node)) return false;
    repair ??= node.sourceRepair = { taskDigest: digest(node.task), workerId: assignment.workerId,
      assignmentId: assignment.assignmentId, seedCommit: assignment.seedCommit, pending: true };
    this.moveTask(node, 'pending', 'local-repair');
    this.input.emit('task_repair_requested', { taskId: node.task.id, workerId: assignment.workerId,
      taskDigest: assignment.taskDigest, reason: 'source-contract' });
    return true;
  }
  protected retryTaskLocally(node: TaskRecord, commit?: string): boolean {
    if (!node.assignment || !this.liveWorkers.has(node.assignment.workerId)) return false;
    const worker = this.input.workers.find(worker => worker.id === node.assignment!.workerId);
    const candidate = worker && this.failedTaskInput(node.task, node.assignment, worker.worktree,
      commit ?? node.proof?.commit ?? git(worker.worktree, ['rev-parse', 'HEAD']));
    const failed = candidate && this.previousTaskFailure(candidate);
    if (candidate && failed?.feedback.startsWith('math_task_missing_declaration\n') &&
        this.reportedTaskMathematicalBlocker(node, candidate)) {
      delete failed.repair;
      this.input.emit('task_mathematical_gap_blocked', { taskId: node.task.id, taskDigest: digest(node.task),
        failureId: failed.id, evidence: 'model-reported-advisory' });
      return false;
    }
    if (failed?.repair ? !this.pendingTaskRepair(node, failed) :
        failed ? !this.firstTaskRepair(node, failed.id) : node.attempts !== 1) return false;
    if (failed && !failed.repair) failed.repair = { taskId: node.task.id, taskDigest: digest(node.task),
      workerId: node.assignment.workerId, pending: true };
    this.moveTask(node, 'pending', 'local-repair');
    this.input.emit('task_repair_requested', { taskId: node.task.id, workerId: node.assignment.workerId,
      taskDigest: node.assignment.taskDigest });
    return true;
  }
  /** A failed request that left the seed's Lean sources untouched is no attempt, so it must not record a failed input. */
  protected untouchedTaskSeed(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>, commit: string) {
    const node = this.node(action.task.id);
    if (this.leanSourceDigest(worker.worktree, commit) !== this.leanSourceDigest(worker.worktree, action.assignment.seedCommit)) return false;
    const candidate = this.failedTaskInput(action.task, action.assignment, worker.worktree, commit);
    return !this.previousTaskFailure(candidate) &&
      !(node.assignment === action.assignment && this.reportedTaskMathematicalBlocker(node, candidate));
  }
  protected restoreInterruptedRepair(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>, commit: string) {
    const node = this.node(action.task.id), candidate = this.failedTaskInput(action.task, action.assignment, worker.worktree, commit);
    const failed = this.previousTaskFailure(candidate), repair = failed?.repair;
    if (!repair || repair.pending || repair.taskId !== node.task.id || repair.taskDigest !== digest(node.task) ||
        repair.workerId !== worker.id || repair.startedAttempt !== node.attempts) return false;
    repair.pending = true; delete repair.startedAttempt;
    node.feedback = failed!.feedback; this.moveTask(node, 'pending', 'local-repair');
    this.input.emit('task_repair_interrupted', { taskId: node.task.id, workerId: worker.id, failureId: failed!.id });
    this.changed(); return true;
  }
  protected continueTaskCheckpoint(worker: ResearchWorker, node: TaskRecord, commit: string) {
    const candidate = this.failedTaskInput(node.task, node.assignment!, worker.worktree, commit);
    const failed = this.previousTaskFailure(candidate);
    if (!failed) return true;
    if (failed.feedback.startsWith('math_task_missing_declaration\n') &&
        this.reportedTaskMathematicalBlocker(node, candidate)) return false;
    this.settleTaskRepair(node);
    failed.repair ??= { taskId: node.task.id, taskDigest: digest(node.task), workerId: worker.id, pending: true };
    this.input.emit('task_checkpoint_continuation_requested', { taskId: node.task.id, workerId: worker.id, failureId: failed.id });
    return true;
  }
  protected settleTaskRepair(node: TaskRecord) {
    for (const { repair } of this.archive.failedTaskInputs ?? []) if (repair && !repair.pending &&
        repair.taskId === node.task.id && repair.taskDigest === digest(node.task) &&
        repair.workerId === node.assignment?.workerId && repair.startedAttempt === node.attempts) delete repair.startedAttempt;
  }
  private deliverProof(node: TaskRecord, proof: TaskProof) {
    if (['unavailable', 'blocked'].includes(proof.verification.status)) {
      node.proof ??= proof;
      throw new VerifierFailureError({ stage: 'task-proof-delivery', taskId: node.task.id,
        taskDigest: digest(node.task), sourceCommit: proof.commit, seedCommit: proof.seedCommit,
        projectionMode: proof.projectionMode ?? 'full', conditions: proof.conditions, verification: proof.verification });
    }
    node.proof = proof;
    this.settleTaskSourceRepair(node);
    if (proof.passed || this.deterministicTaskFailure(proof)) this.settleTaskRepair(node);
    this.moveTask(node, proof.passed ? proof.conditions?.length ? 'conditional' : 'delivered' : 'blocked', 'proof-checked');
    if (proof.passed) node.feedback = undefined;
    else {
      node.feedback = solverProofFeedback(proof);
      const repairable = this.deterministicTaskFailure(proof) || proof.verification.status === 'failed' && proof.verification.results.some(result =>
        result.status === 'failed' && ((result.sorryCount ?? 0) > 0 || result.error === 'Lean exited with status 1.'));
      if (!repairable || !this.retryTaskLocally(node, proof.commit)) this.wakeLead('task-check-failed');
    }
    this.input.emit('task_checked', { taskId: node.task.id, passed: proof.passed, conditional: Boolean(proof.conditions?.length), commit: proof.commit });
    this.changed();
  }
  /** Keep canonical failures authoritative, while draining all checks before a caller releases its workspace. */
  protected async settleProofDeliveries<T>(operation: (annotations: ProofDeliveryAnnotation[]) => Promise<T>): Promise<T> {
    const annotations: ProofDeliveryAnnotation[] = [];
    let result: T, failure: unknown, failed = false;
    try { result = await operation(annotations); }
    catch (error) { failed = true; failure = error; }
    const checks = await Promise.allSettled(annotations.map(annotate => annotate()));
    if (failed) throw failure;
    const rejected = checks.find(check => check.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    return result!;
  }
  private updateProofDeliveryMetadata(record: DeliveryRecord, metadata: Partial<DeliveryRecord>) {
    const fields = Object.keys(metadata) as (keyof DeliveryRecord)[];
    if (fields.every(field => record[field] === metadata[field] ||
      record[field] !== undefined && metadata[field] !== undefined && canonicalMathJson(record[field]) === canonicalMathJson(metadata[field]))) return false;
    this.pin(metadata.commit); this.pin(metadata.artifacts?.commit); this.pin(metadata.evidence?.verification.targetCommit);
    const previous = Object.fromEntries(fields.map(field => [field, record[field]]));
    Object.assign(record, metadata);
    try { this.changed(); }
    catch (error) { Object.assign(record, previous); throw error; }
    return true;
  }
  private mergeProofDeliveryMetadata(request: ProofDeliveryRequest) {
    const { record, action, options } = request;
    if (!record || record.status === 'superseded' || !this.current(action) || !this.archive.deliveries?.includes(record)) return;
    this.updateProofDeliveryMetadata(record, {
      submissionId: record.submissionId ?? options.submissionId,
      assignmentKey: record.assignmentKey ?? options.assignmentKey,
      artifacts: record.artifacts ?? options.artifacts,
      artifactWarning: record.artifactWarning ?? options.artifactWarning,
      evidenceRefs: [...new Set([...(record.evidenceRefs ?? []), ...(options.evidenceRefs ?? [])])],
    });
  }
  protected proofDeliveryCurrent(node: TaskRecord): boolean {
    const { proof, assignment, integratedCheck, status } = node, version = digest(node.task);
    return this.archive.tasks.includes(node) && !!proof && !!assignment && assignment.taskDigest === version && proof.taskDigest === version &&
      (status === 'integrated' ? !!integratedCheck?.passed && integratedCheck.taskDigest === version && this.checkedDeliveries.has(integratedCheck)
        : this.checkedDeliveries.has(proof));
  }
  protected proofDeliveryState(node: TaskRecord): ProofDeliveryState {
    const { assignment, proof, integratedCheck, status, feedback } = node;
    return { assignment, proof, integratedCheck, status, feedback };
  }
  /** Publish the proof now; return optional annotation work for the caller to await outside the canonical queue. */
  protected async publishProofDelivery(node: TaskRecord, request?: ProofDeliveryRequest,
    expected?: ProofDeliveryState): Promise<ProofDeliveryAnnotation | undefined> {
    const expectedState = expected ?? this.proofDeliveryState(node);
    return this.input.exclusiveCheck(async () => {
      const proof = node.proof, assignment = node.assignment;
      // Feedback can change after this stage settles; the saved state owns its summary.
      if (!proof || !assignment || !this.proofDeliveryCurrent(node) || node.proof !== expectedState.proof ||
          node.assignment !== expectedState.assignment || node.status !== expectedState.status ||
          node.integratedCheck !== expectedState.integratedCheck) return;
      request ??= this.proofDeliveryRequests.get(canonicalMathJson([
        assignment.workerId, assignmentDeliveryFile(assignment), proof.commit,
      ]));
      if (request && request.commit !== proof.commit) return;
      const worker = request?.worker ?? this.input.workers.find(worker => worker.id === assignment.workerId) ?? this.lead;
      const action = request?.action ?? { kind: 'task' as const, task: node.task, assignment };
      if (this.node(action.task.id) !== node || node.assignment !== action.assignment || digest(node.task) !== action.assignment.taskDigest) return;
      const task = structuredClone(node.task), taskDigest = digest(task), integratedProof = node.integratedCheck, status = node.status;
      const environmentDigest = this.input.state.environmentDigest, problemReceiptDigest = this.input.state.problem.receiptDigest;
      const verdict: DeliveryRecord['status'] | undefined = status === 'integrated' ? 'verified' : status === 'conditional' ? 'conditional' :
        !proof.passed || status === 'blocked' ? 'failed' : undefined;
      if (!verdict) return;
      // A verified publication describes canonical acceptance; artifacts still identify the worker's original submission.
      const evidence = verdict === 'verified' ? integratedProof! : request ? proof : integratedProof ?? proof;
      const options = request?.options ?? {}, assignmentKey = options.assignmentKey ?? assignmentDeliveryFile(assignment);
      let record = this.archive.deliveries?.find(record => record.producer === worker.id && record.kind === 'proof' && record.status === verdict &&
        record.taskId === task.id && record.taskDigest === taskDigest && record.assignmentKey === assignmentKey &&
        (verdict === 'verified' || record.commit === proof.commit));
      // Preserve host probe findings; a worker's own completion summary is not an acceptance verdict.
      const hostAdvisorySummary = request?.prepared?.advisorySummary ?? record?.hostAdvisorySummary;
      const summary = verdict === 'verified' ? 'Checked proof integrated with freshly validated dependencies.' +
        (hostAdvisorySummary ? ' ' + hostAdvisorySummary : '') :
        (verdict === 'failed' ? expectedState.feedback : undefined) ?? request?.summary ??
        (verdict === 'conditional' ? 'Fixed declaration checked; unresolved lemma assumptions remain obligations.' :
          'Proof did not pass host acceptance.');
      // A passing proof needs this integration's failure state; a replay can only resume its existing record.
      if (verdict === 'failed' && proof.passed && !expected && !record) return;
      if (record && verdict === 'verified' && this.updateProofDeliveryMetadata(record, {
        commit: evidence.commit, sourceDigest: evidence.sourceDigest, summary, hostAdvisorySummary, actualReferences: evidence.references,
        evidence: { passed: evidence.passed, verification: { status: evidence.verification.status,
          targetCommit: evidence.verification.targetCommit,
          results: evidence.verification.results.map(({ receiptId }) => ({ receiptId })) } },
      })) this.pendingProofDeliveryRecords.add(record);
      if (record && request) { request.record = record; this.mergeProofDeliveryMetadata(request); }
      let knowledge: ReturnType<CooperationTaskProofs['captureKnowledgeUseCheck']> | undefined;
      if (!record) {
        knowledge = this.captureKnowledgeUseCheck(worker, task, proof.commit,
          this.checkedDeliveries.has(proof) ? proof : integratedProof);
        record = this.createDeliveryRecord(worker, task, 'proof', verdict,
          summary,
          { ...options, assignmentKey, commit: evidence.commit, sourceDigest: evidence.sourceDigest,
            ...(hostAdvisorySummary ? { hostAdvisorySummary } : {}),
            evidence, actualReferences: evidence.references, knowledgeUses: knowledge.uses });
        (this.archive.deliveries ??= []).push(record);
        this.pendingProofDeliveryRecords.add(record);
        if (request) request.record = record;
      }
      if (this.pendingProofDeliveryRecords.has(record)) {
        knowledge ??= this.captureKnowledgeUseCheck(worker, task, proof.commit,
          this.checkedDeliveries.has(proof) ? proof : integratedProof);
        this.publishDeliveryRecord(record);
        this.pendingProofDeliveryRecords.delete(record);
      }
      const pendingAnnotation = this.proofDeliveryAnnotations.get(record);
      if (pendingAnnotation) return pendingAnnotation;
      if (!knowledge && record.knowledgeUses !== undefined && record.knowledgeUses.every(use => !use.application || use.application.check)) return;
      knowledge ??= this.captureKnowledgeUseCheck(worker, task, proof.commit,
        this.checkedDeliveries.has(proof) ? proof : integratedProof);
      if (!knowledge.uses.some(use => use.application)) {
        if (record.knowledgeUses !== knowledge.uses) { record.knowledgeUses = knowledge.uses; this.changed(); }
        if (!this.input.signal.aborted && this.current(action))
          this.observeKnowledgeUses(task, proof.commit, knowledge.uses, knowledge.rejected);
        return;
      }
      const publication = record;
      const capturedKnowledge = knowledge;
      let pending: Promise<void> | undefined;
      const annotate = () => {
        if (pending) return pending;
        pending = (async () => {
          if (this.input.signal.aborted) return;
          const knowledgeUses = await checkKnowledgeApplications(capturedKnowledge.uses, capturedKnowledge.input);
          await this.input.exclusiveCheck(async () => {
            if (this.input.signal.aborted || !this.current(action) || this.node(task.id) !== node || digest(node.task) !== taskDigest || node.status !== status ||
                node.assignment !== assignment || node.proof !== proof || node.integratedCheck !== integratedProof ||
                this.input.state.environmentDigest !== environmentDigest || this.input.state.problem.receiptDigest !== problemReceiptDigest ||
                publication.status !== verdict || !this.archive.deliveries?.includes(publication)) return;
            const previous = publication.knowledgeUses;
            publication.knowledgeUses = knowledgeUses;
            try { this.changed(); }
            catch (error) { publication.knowledgeUses = previous; throw error; }
            this.observeKnowledgeUses(task, proof.commit, knowledgeUses, capturedKnowledge.rejected);
          });
        })();
        this.proofDeliveryChecks.add(pending);
        this.refreshPlanApproval();
        void pending.then(() => {
          this.proofDeliveryChecks.delete(pending!); this.proofDeliveryAnnotations.delete(publication);
          this.wake();
        }, () => {
          this.proofDeliveryChecks.delete(pending!); this.proofDeliveryAnnotations.delete(publication);
          this.wake();
        });
        return pending;
      };
      this.proofDeliveryAnnotations.set(publication, annotate);
      return annotate;
    });
  }
  private captureKnowledgeUseCheck(worker: ResearchWorker, task: CooperativeTask, commit: string, proof?: ProofCheck & { references?: ProofReferences }) {
    task = structuredClone(task);
    let value: unknown;
    try { value = parseMathResponse(committedSource(worker.worktree, commit, 'RESEARCH.md'), 'math-result', {}, 'summary').knowledgeUses; }
    catch { /* Host reference observation also works without optional model reports. */ }
    // Consume the pinned source snapshots now; only normalized uses cross the async seam.
    const access = this.input.access.get(worker.id);
    const { uses, rejected } = inspectKnowledgeUses(value, access?.knowledgeSnapshot, task, proof, access?.installedLibrary);
    const worktree = worker.worktree, projectRelative = this.input.state.problem.projectRelative;
    return { uses, rejected, input: { task, projectRoot: path.join(worktree, projectRelative),
      env: { ...this.input.access.get(worker.id)?.environment }, environmentDigest: this.input.state.environmentDigest,
      commit, signal: this.input.signal, timeoutMs: this.input.timeoutMs ?? Infinity,
      originalContexts: this.input.state.problem.targets.map(({ proofPath, theoremName }) => ({ proofPath, theoremName })),
      sourceAtCommit: (file: string) => committedSource(worktree, commit, path.posix.join(projectRelative, file)),
      previous: uses.some(use => use.application)
        ? structuredClone(this.archive.deliveries?.flatMap(delivery => delivery.knowledgeUses ?? [])) : undefined } };
  }
  private observeKnowledgeUses(task: CooperativeTask, commit: string, observed: readonly KnowledgeUse[], rejected: number) {
    if (rejected) this.input.emit('knowledge_use_rejected', { taskId: task.id, commit, rejected });
    for (const use of observed) this.input.emit('knowledge_use_observed', { ...use, taskId: task.id, commit });
  }
}
