import { parseCooperationPlan, isAdvisoryTask as advisory } from './tasks';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { VerificationCheckpointError } from './verificationCheckpoint';
import { canonicalMathJson, mathDigest, parseMathJson, readMathFile } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import { mathGitResult } from '../math/mathGit';
import { type ResearchWorker } from './modules/organization';
import { taskCanStart } from './modules/search';
import { deliveryDetails, pendingDeliveryLines, readMathResponse, parseMathResponse } from './deliveries';
import { assertSolverSources, committedSource, commitSolverProjection, git, withSolverWorktree } from './problem';
import { isStatementAction } from './statementReview';
import { captureDeliveryArtifacts } from './deliveryArtifacts';
import { bindMathematicalGap } from './mathematicalGaps';
import { assignmentDeliveryFile, isFeasibilityReview, isFinalCandidateReview, leadPlanDeliveryFile, type TaskRecord, type CooperativeAction } from './tasks';
import { directDeliveryRejections, rejectionCode, HumanEditRecord, TaskVersions, bounded, leadPlanPublicationFeedback,
  leadPlanPublicationTarget, parseLeadPlan, type PlanPublicationRejection } from './cooperationShared';
import { CooperationPlanning } from './cooperationPlanning';
import { ResearchAdmissionError } from './researchAdmission';
import { acceptContextCheckpoint, contextCheckpointRejection, contextCheckpointRejectionFeedback, savedContextCheckpoint } from './contextCheckpoint';
import { MAX_PLAN_APPROVAL_REJECTIONS, planApprovalInputSchema, planApprovalLog, planApprovalStatus, type PlanApprovalInput } from './planApproval';
import { latestProofSearchRecord, retainProofSearchCheckpoint } from './proofSearchRecords';
import { recordHumanGuidanceDecisions } from './humanGuidance';
import { helperNominationsSchema } from './incrementalHelpers';

/** Worker delivery intake. */
export abstract class CooperationInputs extends CooperationPlanning {
  abstract leadCheckpointInstruction(action: Extract<CooperativeAction, { kind: 'lead' | 'assemble' }>): string;
  protected abstract leadDecisionObligations(action?: Extract<CooperativeAction, { kind: 'lead' | 'assemble' }>): { any: boolean };
  protected guidancePulse?: Promise<void>;
  protected async retainGuidanceDecisions(worker: ResearchWorker, action: CooperativeAction, decisions: unknown) {
    if (decisions === undefined || isStatementAction(action)) return;
    const pending = Promise.resolve(this.guidancePulse).then(async () => {
      try {
        await recordHumanGuidanceDecisions({ stateFile: path.join(path.dirname(this.lead.worktree), 'state.json'),
          state: this.input.state, workerId: worker.id, decisions,
          scope: action.kind === 'task' ? { taskRef: { id: action.task.id, version: action.assignment.taskDigest } }
            : { planVersion: action.kind === 'lead' ? action.planVersion ?? this.archive.planVersion : this.archive.planVersion },
          current: () => !this.stopping && !this.input.signal.aborted && this.current(action) &&
            (action.kind === 'task' ? action.assignment.workerId === worker.id :
              action.kind === 'review' ? this.archive.review?.workerId === worker.id : worker.id === this.lead.id),
          onRecord: record => this.input.emit('human_guidance_decided', { id: record.id, decision: record.decision, evidence: 'advisory' }),
        });
      } catch (error) {
        this.input.emit('human_guidance_decision_rejected', { workerId: worker.id,
          reason: error instanceof Error ? error.message : 'math_guidance_decision_invalid' });
      }
    });
    this.guidancePulse = pending;
    try { await pending; } finally { if (this.guidancePulse === pending) this.guidancePulse = undefined; }
  }
  /** A host import has no model writer; retain the normal readiness, snapshot and receipt boundary. */
  freezeImportedProof(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>,
    submissionId: string, commit: string) {
    this.receiveProofReady(worker, action, submissionId);
    return this.proofReadyFrozen(worker, action, commit);
  }
  private planPublicationNotification?: PlanPublicationRejection;
  private leadDraftBaselines = new WeakMap<CooperativeAction, string | null>();
  private contextCheckpointNotifications?: WeakMap<object, object>;
  protected syncEditChecks(nodes: ReadonlyMap<string, TaskRecord>, versions: TaskVersions) {
    for (const edit of this.archive.edits ?? []) {
      if (edit.status !== 'applied' || !edit.recheck) continue;
      const before = canonicalMathJson(edit.recheck);
      for (const result of edit.recheck.tasks) {
        if (['removed', 'superseded'].includes(result.status)) continue;
        const node = nodes.get(result.taskId);
        if (!node || versions.get(result.taskId)?.version !== result.taskDigest) {
          result.status = 'superseded';
          continue;
        }
        const proof = node.integratedCheck ?? node.proof;
        const fresh = !node.pendingValidation && proof && proof.taskDigest === result.taskDigest && this.checkedDeliveries.has(proof);
        result.status = node.status === 'blocked' ? 'failed' : fresh && node.status === 'integrated' && proof.passed && !proof.conditions?.length ? 'passed' :
          fresh && node.status === 'conditional' ? 'conditional' : 'pending';
        result.reason = node.status === 'blocked' ? node.feedback : undefined;
        if (fresh) result.lastCheck = { commit: proof.commit, sourceDigest: proof.sourceDigest,
          environmentDigest: this.input.state.environmentDigest, passed: proof.passed, conditional: Boolean(proof.conditions?.length),
          receiptIds: proof.verification.results.map(receipt => receipt.receiptId) };
      }
      const statuses = edit.recheck.tasks.map(result => result.status);
      edit.recheck.status = statuses.every(status => status === 'removed') ? 'not-required' :
        statuses.includes('failed') ? 'failed' : statuses.some(status => status === 'pending' || status === 'conditional') ? 'pending' :
        statuses.includes('superseded') ? 'superseded' : 'passed';
      if (before !== canonicalMathJson(edit.recheck)) this.input.emit('edit_recheck_updated', { id: edit.id, recheck: edit.recheck });
    }
  }
  protected inputs() {
    return this.pendingPulse ??= this.readInputs().finally(() => { this.pendingPulse = undefined; });
  }
  /** Serialize input edits while allowing independent proof checks to continue. */
  private async readInputs(): Promise<ReadonlyMap<string, Promise<void>>> {
    if (this.archive.tasks.some(node => node.pendingValidation) || this.archive.edits?.some(edit => edit.status === 'applied' && edit.pendingSync))
      this.schedulePlanSynchronization();
    const cursors = this.archive.cursors ??= {};
    const file = path.join(path.dirname(this.lead.worktree), 'edits.jsonl');
    // Drain queued edits before considering an approval of the resulting plan.
    for (const entry of pendingDeliveryLines(file, cursors, 'edits', () => this.input.save(), 'drain')) {
      this.input.signal.throwIfAborted();
      let id = crypto.randomUUID();
      let record: HumanEditRecord | undefined;
      try {
        if (entry.error) throw new Error(entry.error);
        if (!entry.line?.trim()) continue;
        let edit: any;
        try { edit = JSON.parse(entry.line); }
        catch { throw new Error('math_edit_invalid_json'); }
        if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw new Error('math_edit_invalid');
        if (typeof edit.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(edit.id)) throw new Error('math_edit_invalid_id');
        id = edit.id;
        record = this.archive.edits?.find(previous => previous.id === id);
        if (record && record.status !== 'received') {
          if (record.status === 'applied' && record.pendingSync) {
            this.schedulePlanSynchronization();
            this.input.emit('edit_applied', { id, planVersion: record!.planVersion, affectedTasks: record!.affectedTasks, recheck: record!.recheck });
          }
          continue;
        }
        if (!record) {
          record = { id, status: 'received', receivedAt: Date.now(),
            ...(typeof edit.baseVersion === 'string' ? { baseVersion: bounded(edit.baseVersion, 128) } : {}) };
          (this.archive.edits ??= []).push(record); this.changed();
          this.input.emit('edit_received', { id, baseVersion: record.baseVersion });
        }
        if (edit.baseVersion !== this.archive.planVersion) throw new Error('math_edit_version_conflict');
        await this.input.exclusiveCheck(() => {
          if (edit.baseVersion !== this.archive.planVersion) throw new Error('math_edit_version_conflict');
          return this.acceptPlan(parseCooperationPlan(this.input.state.problem, edit), record);
        });
        for (const [workerId, active] of this.active) {
          if (isStatementAction(active.action)) continue;
          const pending = active.notify(`Human edit ${id} applied at plan version ${this.archive.planVersion}; this does not mean the affected proofs passed. Read the edit's separate recheck results in COOPERATION.json. Superseded assignments must stop; unrelated work continues.`)
            .catch(() => { this.input.emit('notification_deferred', { workerId, editId: id }); });
          this.notifications.add(pending); void pending.finally(() => this.notifications.delete(pending));
        }
        this.input.emit('edit_applied', { id, planVersion: record.planVersion, affectedTasks: record.affectedTasks, recheck: record.recheck });
      } catch (error) {
        this.input.signal.throwIfAborted();
        const reason = error instanceof Error ? error.message : 'math_edit_invalid';
        if (record?.status === 'applied' || !(error instanceof Error) || error.name === 'AbortError' ||
            (entry.error !== reason && !/^math_(?:edit_(?:invalid(?:_json|_id)?|version_conflict)$|plan_[a-z_]+(?:$|:))/u.test(reason)))
          throw error;
        if (record) { record.status = 'rejected'; record.reason = reason; }
        else (this.archive.edits ??= []).push({ id, status: 'rejected', reason, receivedAt: Date.now() });
        this.changed();
        this.input.emit('edit_rejected', { id, reason });
      }
    }
    this.readPlanApprovals(cursors);
    await this.readPlanDelivery(cursors);
    for (const worker of this.input.workers) {
      if (this.deliveryChecks.has(worker.id)) continue;
      const active = this.active.get(worker.id);
      if (active?.action.kind !== 'task') continue;
      const check = this.readWorkerDeliveries(worker, active.action, cursors);
      this.deliveryChecks.set(worker.id, check);
      this.refreshPlanApproval();
      void check.catch(error => {
        this.input.emit('cooperation_poll_failed', { reason: error instanceof Error ? error.message : 'unknown' });
        if (error instanceof VerificationCheckpointError || error instanceof Error && error.message === 'math_verifier_unavailable') { this.failure = error; this.changed(); }
      }).finally(() => {
        if (this.deliveryChecks.get(worker.id) === check) this.deliveryChecks.delete(worker.id);
        this.wake();
      }).catch(() => {});
    }
    return new Map(this.deliveryChecks);
  }
  /** Inspect this dispatch's complete new response using the same validation as publication. */
  protected inspectLeadCheckpointDraft(action: Extract<CooperativeAction, { kind: 'lead' | 'assemble' }>) {
    let response: unknown;
    // A partial write, ordinary mathematical notes or missing file is not a submission to correct.
    try { response = readMathResponse(this.lead.worktree, 'math-plan'); } catch { return; }
    const digest = mathDigest(canonicalMathJson(response));
    if (!this.leadDraftBaselines.has(action)) {
      let baseline: string | null = null;
      try {
        if (git(this.lead.worktree, ['ls-tree', '--name-only', action.seedCommit, '--', 'RESEARCH.md']))
          baseline = mathDigest(canonicalMathJson(parseMathResponse(
            committedSource(this.lead.worktree, action.seedCommit, 'RESEARCH.md'), 'math-plan')));
      } catch { /* An inherited notes-only seed has no control response. */ }
      this.leadDraftBaselines.set(action, baseline);
    }
    if (this.leadDraftBaselines.get(action) === digest) {
      const rejection = this.archive.planRejection;
      // An accepted seed is not a new response. A previously rejected draft still owes its
      // correction in this dispatch, even when the writer has not changed the saved response yet.
      if (!this.leadDecisionObligations(action).any || !rejection || rejection.error !== this.archive.error ||
          rejection.proposalDigest !== this.proposedPlanDigest()) return;
    }
    try {
      const plan = parseLeadPlan(this.input.state.problem, response, this.planPatchBase(), { goalPath: this.goalPathReview() });
      this.preparePlan(plan, action);
    } catch (error) {
      if (error instanceof Error && /^math_plan_/u.test(error.message))
        return { reason: bounded(error.message, 4000) };
      throw error;
    }
    return { reason: undefined };
  }
  /** Human approvals queued by queuePlanApproval; each names the exact plan version it opens dispatch for. */
  private readPlanApprovals(cursors: Record<string, number>) {
    const file = planApprovalLog(path.join(path.dirname(this.lead.worktree), 'state.json'));
    for (const entry of pendingDeliveryLines(file, cursors, 'planApprovals', () => this.input.save(), 'drain')) {
      this.input.signal.throwIfAborted();
      if (!entry.error && !entry.line?.trim()) continue;
      let parsed: PlanApprovalInput | undefined;
      if (entry.line) try { parsed = planApprovalInputSchema.parse(JSON.parse(entry.line)); } catch { /* Report invalid approval below. */ }
      this.applyPlanApproval(parsed, entry.error);
    }
  }
  private applyPlanApproval(approval: PlanApprovalInput | undefined, readError?: string) {
    const record = this.archive.planApproval ??= {};
    if (approval && record.approvedId === approval.id) return;
    const status = planApprovalStatus(this.input.state);
    const reason = readError ?? (!approval ? 'math_plan_approval_invalid' : status === 'not-required' ? 'math_plan_approval_not_required' :
      status === 'approved' ? 'math_plan_approval_already_approved' : status === 'awaiting-plan' ? 'math_plan_approval_plan_unavailable' :
      approval.planVersion !== this.archive.planVersion ? 'math_plan_approval_version_conflict' : undefined);
    if (!approval || reason) {
      const rejection = { id: approval?.id ?? crypto.randomUUID(), reason: reason!, at: Date.now(),
        ...(approval ? { planVersion: approval.planVersion } : {}) };
      record.rejections = [...record.rejections ?? [], rejection].slice(-MAX_PLAN_APPROVAL_REJECTIONS);
      this.input.emit('plan_approval_rejected', rejection);
    } else {
      Object.assign(record, { approvedId: approval.id, approvedVersion: approval.planVersion, approvedAt: Date.now() });
      this.input.emit('plan_approved', { id: approval.id, planVersion: approval.planVersion });
    }
    this.changed();
  }
  private async readPlanDelivery(cursors: Record<string, number>) {
    const active = this.active.get(this.lead.id), action = active?.action;
    if (!action || action.kind !== 'lead') return;
    const target = leadPlanPublicationTarget(action);
    if (!target) return;
    const { file, dispatchNonce: nonce, baseVersion } = target;
    const initial = Boolean(action.initialPlanNonce);
    const code = (reason: string) => `math_${initial ? 'initial_plan' : 'plan_publication'}_${reason}`;
    const key = `${this.lead.id}/${file}`;
    const research = this.input.state.workers?.find(record => record.id === this.lead.id) ?? this.input.state;
    const current = () => this.active.get(this.lead.id) === active && !active.cancelled &&
      !this.stopping && !this.input.signal.aborted && this.current(action);
    const open = () => current() && !this.leadPublication(action) &&
      !(initial && (this.archive.initialPlanPublication || this.archive.tasks.length));
    let advanced = false, feedbackChanged = false;
    const reject = (reason: string, offset: number, checkpoint = false) => {
      this.input.emit(initial ? 'initial_plan_rejected' : 'plan_publication_rejected', { workerId: this.lead.id, file, reason });
      if (checkpoint) {
        const checkpoint = this.currentContextCheckpoint(this.lead, action);
        if (!checkpoint || savedContextCheckpoint(checkpoint.research, this.lead.worktree)) return;
        checkpoint.request.rejection = { file, offset, reason: bounded(reason, 4000) };
      } else {
        if (!open()) return;
        this.archive.planPublicationRejection = { nonce, file, offset, baseVersion, reason: bounded(reason, 4000) };
      }
      feedbackChanged = true;
    };
    try {
      for (const entry of pendingDeliveryLines(path.join(this.lead.worktree, file), cursors, key, () => { advanced = true; })) {
        this.input.signal.throwIfAborted();
        if (entry.error) { reject(entry.error, entry.offset); continue; }
        const line = entry.line;
        if (!line?.trim()) continue;
        let checkpoint = false;
        try {
          const value = parseMathJson(line, code('invalid_json'));
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error(code('invalid') + ': expected a JSON object');
          const response = value as Record<string, unknown>;
          checkpoint = response.kind === 'checkpoint';
          if (checkpoint) {
            await this.input.exclusiveCheck(async () => {
              if (!current()) throw new Error(code('superseded'));
              acceptContextCheckpoint(research, this.lead.worktree, response);
              this.input.emit('context_checkpoint_published', { workerId: this.lead.id, threadId: research.threadId,
                requestId: research.contextCheckpoint?.requestId, notesDigest: research.contextCheckpoint?.publishedNotesDigest });
              this.changed();
            });
            continue;
          }
          const fields: string[] = [];
          if (response.kind !== target.kind) fields.push('kind must be "plan"');
          if (typeof response.baseVersion !== 'string') fields.push('baseVersion must be the current plan version');
          if ((!initial || response.dispatchNonce !== undefined) && response.dispatchNonce !== nonce)
            fields.push('dispatchNonce must match this Lead dispatch');
          if (fields.length) throw new Error(code('invalid') + ': ' + fields.join(', '));
          const eventDigest = mathDigest(line), details = deliveryDetails(response);
          await this.input.exclusiveCheck(async () => {
            if (this.leadPublication(action)?.eventDigest === eventDigest) return;
            if (!open()) throw new Error(code('superseded'));
            if (response.baseVersion !== baseVersion || baseVersion !== this.archive.planVersion)
              throw new Error(code('version_conflict'));
            const plan = parseLeadPlan(this.input.state.problem, response, this.planPatchBase(), { goalPath: this.goalPathReview() });
            await this.acceptPlan(plan, undefined, { action, receipt: { nonce, file,
              offset: entry.offset, eventDigest, baseVersion, acceptedAt: Date.now() } });
            await this.retainGuidanceDecisions(this.lead, action, response.guidanceDecisions);
            this.rememberLeadDecision(action);
            this.changed();
            this.input.emit(initial ? 'initial_plan_published' : 'plan_published', { ...this.archive.planPublication,
              workerId: this.lead.id, summary: details.summary, taskIds: plan.tasks.map(task => task.id) });
          });
        } catch (error) {
          this.input.signal.throwIfAborted();
          if (!(error instanceof Error) || !/^math_(?:initial_plan_|plan_|delivery_invalid)/u.test(error.message)) throw error;
          reject(error.message, entry.offset, checkpoint);
        }
      }
    } finally { if (advanced) { if (feedbackChanged) this.changed(); else this.input.save(); } }
    const rejection = this.archive.planPublicationRejection;
    if (rejection && rejection.nonce === nonce && open() && this.planPublicationNotification !== rejection) {
      this.planPublicationNotification = rejection;
      const pending = Promise.resolve().then(async () => {
        if (this.archive.planPublicationRejection !== rejection || !open()) return;
        await active.notify(leadPlanPublicationFeedback(action, this.archive)! + ' ' + this.leadCheckpointInstruction(action));
      }).catch(() => {
        if (this.planPublicationNotification === rejection) this.planPublicationNotification = undefined;
        this.input.emit('notification_deferred', { workerId: this.lead.id, file, offset: rejection.offset });
      });
      this.notifications.add(pending); void pending.finally(() => this.notifications.delete(pending));
    }
    this.notifyContextCheckpointRejection(this.lead, action);
  }
  private currentContextCheckpoint(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'lead' | 'assemble' | 'task' }>) {
    const active = this.active?.get(worker.id);
    if (!active || active.action !== action || active.cancelled || this.stopping || this.input.signal.aborted ||
        action.kind === 'task' && action.assignment.workerId !== worker.id || !this.current(action)) return;
    const research = this.input.state.workers?.find(record => record.id === worker.id) ?? this.input.state;
    const request = research.contextCheckpoint;
    if (!research.threadId || request?.threadId !== research.threadId || !request.requestId) return;
    return { active, research, request };
  }
  private notifyContextCheckpointRejection(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'lead' | 'assemble' | 'task' }>) {
    const checkpoint = this.currentContextCheckpoint(worker, action), rejection = checkpoint?.request.rejection;
    if (!checkpoint || !rejection || savedContextCheckpoint(checkpoint.research, worker.worktree)) return;
    const file = action.kind === 'task' ? assignmentDeliveryFile(action.assignment) : leadPlanDeliveryFile(action);
    if (!file) return;
    const { active, request } = checkpoint;
    const notified = this.contextCheckpointNotifications ??= new WeakMap<object, object>();
    if (notified.get(rejection) === active) return;
    notified.set(rejection, active);
    const pending = Promise.resolve().then(async () => {
      const current = this.currentContextCheckpoint(worker, action);
      if (current?.active !== active || current.request !== request || request.rejection !== rejection ||
          savedContextCheckpoint(current.research, worker.worktree)) return;
      await active.notify(contextCheckpointRejectionFeedback(contextCheckpointRejection(current.research), file)!);
    }).catch(() => {
      if (notified.get(rejection) === active) notified.delete(rejection);
      this.input.emit('notification_deferred', { workerId: worker.id, file, offset: rejection.offset });
    });
    this.notifications.add(pending); void pending.finally(() => this.notifications.delete(pending));
  }
  private async readWorkerDeliveries(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>, cursors: Record<string, number>) {
    const invalidInput = new Set([...directDeliveryRejections, 'math_delivery_invalid_commit',
      'math_delivery_requires_fixed_proof', 'math_delivery_unfinished_dependencies', 'math_route_blocker_invalid']);
    const research = this.input.state.workers?.find(record => record.id === worker.id) ?? this.input.state;
    const checkpointRejection = research.contextCheckpoint?.rejection;
    let advanced = false;
    const reject = (reason: Error | string, submission: string, checkpoint?: { file: string; offset: number }) => {
      const error = typeof reason === 'string' ? new Error(reason) : reason;
      if (checkpoint) {
        const current = this.currentContextCheckpoint(worker, action);
        if (current && checkpoint.file === assignmentDeliveryFile(action.assignment) &&
            !savedContextCheckpoint(current.research, worker.worktree))
          current.request.rejection = { ...checkpoint, reason: bounded(error.message, 4000) };
      } else this.rejectWorkerDelivery(worker, action, submission, error);
      this.input.emit('delivery_rejected', { workerId: worker.id, reason: error.message });
    };
    try {
      for (const log of [assignmentDeliveryFile(action.assignment), 'DELIVERIES.jsonl']) {
        const scoped = log !== 'DELIVERIES.jsonl', key = scoped ? `${worker.id}/${log}` : worker.id;
        for (const entry of pendingDeliveryLines(path.join(worker.worktree, log), cursors, key, () => { advanced = true; })) {
          this.input.signal.throwIfAborted();
          if (entry.error) reject(entry.error, `${key}:${entry.offset}:${entry.error}`);
          else if (entry.line?.trim()) {
            let value: unknown;
            try { value = JSON.parse(entry.line); }
            catch { reject('math_delivery_invalid_json', entry.line); }
            if (value !== undefined) {
              try { await this.receive(worker, action, value, scoped); }
              catch (error) {
                this.input.signal.throwIfAborted();
                if (!(error instanceof Error) || !invalidInput.has(rejectionCode(error))) throw error;
                reject(error, entry.line, (value as { kind?: unknown })?.kind === 'checkpoint' ? { file: log, offset: entry.offset } : undefined);
              }
            }
          }
        }
      }
    } finally {
      if (advanced) {
        if (research.contextCheckpoint?.rejection !== checkpointRejection) this.changed();
        else this.input.save();
      }
    }
    this.notifyContextCheckpointRejection(worker, action);
    await this.notifyDeliveryReceipts(worker, action);
  }
  private async receive(worker: ResearchWorker, action: Extract<CooperativeAction, { kind: 'task' }>, value: any, scoped = false) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('math_delivery_invalid');
    const assignmentKey = assignmentDeliveryFile(action.assignment);
    const automaticId = scoped ? mathDigest(canonicalMathJson({ file: assignmentKey, value })) : undefined;
    if (scoped) value = { id: automaticId, kind: 'progress', taskId: action.task.id,
      taskDigest: action.assignment.taskDigest, ...value };
    if (value.kind === 'helpers') {
      const declarations = helperNominationsSchema.safeParse(value.declarations);
      if (!scoped || value.taskId !== action.task.id || value.taskDigest !== action.assignment.taskDigest ||
          worker.id !== action.assignment.workerId || isFeasibilityReview(action.task) || isFinalCandidateReview(action.task) ||
          !declarations.success || typeof value.summary !== 'string' || value.summary.length > 3000)
        throw new Error('math_delivery_invalid');
      if (!this.current(action)) return;
      const problem = this.input.state.problem, head = git(worker.worktree, ['rev-parse', 'HEAD']);
      // Freeze the bytes without staging in the writer's index or changing its checkout.
      let commit: string;
      try {
        const files = problem.ownedFiles.map(file => {
          const relative = path.join(problem.projectRelative, file);
          const source = path.join(worker.worktree, relative);
          assertMathCanonicalPath(source);
          return { relative, bytes: readMathFile(source, 4 * 1024 * 1024).bytes };
        });
        commit = await withSolverWorktree(worker.worktree, head, async checkout => {
          for (const { relative, bytes } of files) fs.writeFileSync(path.join(checkout, relative), bytes);
          assertSolverSources(problem, checkout);
          return commitSolverProjection(problem, checkout, 'Freeze standalone helper submission');
        });
      } catch (error) {
        this.input.signal.throwIfAborted();
        this.input.emit('incremental_helpers_rejected', { workerId: worker.id, taskId: action.task.id,
          reason: error instanceof Error ? error.message : 'math_helper_snapshot_failed' });
        return;
      }
      await this.integrateWorkerHelpers(worker, action, commit, declarations.data, value.summary);
      return;
    }
    if (value.kind === 'research') {
      const misplaced = ['mathematicalGap', 'lemmaRequests', 'blockers'].filter(key => Object.hasOwn(value, key));
      if (misplaced.length) throw new ResearchAdmissionError({ status: 'rejected', code: 'math_research_delivery_invalid',
        recovery: 'correct-and-resubmit', issues: misplaced.map(key => ({ path: key,
          message: `Move ${key} inside finding.${key}; research events publish the complete nested finding. Remove the outer field.` })) });
    }
    const details = deliveryDetails(value);
    if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(value.id) ||
        !['progress', 'proof', 'research', 'ready', 'checkpoint'].includes(value.kind) || value.taskId !== action.task.id || value.taskDigest !== action.assignment.taskDigest) throw new Error('math_delivery_invalid');
    await this.retainGuidanceDecisions(worker, action, value.guidanceDecisions);
    if (value.kind === 'checkpoint') {
      if (!scoped || !this.current(action) || worker.id !== action.assignment.workerId) throw new Error('math_delivery_invalid');
      const research = this.input.state.workers?.find(record => record.id === worker.id) ?? this.input.state;
      acceptContextCheckpoint(research, worker.worktree, value);
      this.input.emit('context_checkpoint_published', { workerId: worker.id, threadId: research.threadId,
        requestId: value.requestId, notesDigest: value.notesDigest });
      this.input.save();
      return;
    }
    if (value.kind === 'ready') {
      if (!scoped || advisory(action.task)) throw new Error('math_delivery_invalid');
      // The host freezes the saved sources itself, so a ready event cannot name what to check.
      const named = ['commit', 'targets'].filter(field => value[field] !== undefined);
      if (named.length) throw new ResearchAdmissionError({ status: 'rejected', code: 'math_delivery_invalid',
        issues: named.map(field => ({ path: field, message: `Omit ${field} from a ready event; the host checks the saved sources of the assigned declaration.` })),
        recovery: 'correct-and-resubmit' });
      this.receiveProofReady(worker, action, value.id);
      return;
    }
    // Legacy automatic ids already bind the assignment; unscoped old ids cannot identify a new seed.
    const duplicate = this.archive.deliveries?.find(record => record.producer === worker.id &&
      (record.submissionId === value.id || record.submissionAliases?.includes(value.id)) &&
      record.taskId === action.task.id && record.taskDigest === action.assignment.taskDigest &&
      (record.assignmentKey === assignmentKey || record.assignmentKey === undefined && scoped && value.id === automaticId));
    if (duplicate) {
      const replayed = this.node(action.task.id);
      const resumable = replayed?.assignment === action.assignment && duplicate.status !== 'superseded' &&
        this.proofDeliveryCurrent(replayed) &&
        (duplicate.commit === replayed.proof?.commit || duplicate.commit === replayed.integratedCheck?.commit);
      if (value.kind === 'proof' && duplicate.kind === 'proof' && (this.current(action) || resumable)) {
        await this.settleProofDeliveries(annotations => this.queueIntegration(async () => {
          const node = this.node(action.task.id);
          // Resume the accepted submission, never a changed commit in the replayed line.
          if (node?.assignment === action.assignment && duplicate.status !== 'superseded' &&
              (duplicate.commit === node.proof?.commit || duplicate.commit === node.integratedCheck?.commit)) {
            const annotate = await this.publishProofDelivery(node);
            if (annotate) annotations.push(annotate);
          }
          await this.integrateReadyNow(annotations);
        }));
      }
      return;
    }
    if (!this.current(action)) {
      this.record(worker, action.task, value.kind, 'superseded', details.summary, { ...details, submissionId: value.id, assignmentKey,
        taskDigest: action.assignment.taskDigest, premises: action.task.premises ?? [], dependencies: action.assignment.dependencies ?? [],
        remainingObligations: details.remainingObligations ?? [] });
      return;
    }
    const node = this.node(action.task.id);
    if (value.kind === 'research') {
      if (value.sources !== undefined && value.commit !== undefined)
        throw new ResearchAdmissionError({ status: 'rejected', code: 'math_delivery_invalid',
          issues: [{ path: 'sources', message: 'Use either an explicit source snapshot or a fixed supporting commit, not both.' }],
          recovery: 'correct-and-resubmit' });
      const base = value.commit ?? action.assignment.seedCommit;
      if (typeof base !== 'string' || !/^[a-f0-9]{40,64}$/u.test(base)) throw new Error('math_delivery_invalid_commit');
      const fixed = mathGitResult(worker.worktree, ['merge-base', '--is-ancestor', action.assignment.seedCommit, base], { maxBuffer: 4096 });
      if (fixed.error) throw fixed.error;
      if (fixed.status !== 0) throw new Error('math_delivery_invalid_commit');
      const supportingArtifacts = value.commit ? captureDeliveryArtifacts({ problem: this.input.state.problem,
        worktree: worker.worktree, commit: base, assignment: action.assignment }) : undefined;
      await this.publishResearchFinding(worker, action, base, { kind: 'event', value: value.finding },
        { submissionId: value.id, assignmentKey, ...(supportingArtifacts ? { artifacts: supportingArtifacts } : {}) }, value.sources, value.probes);
      return;
    }
    if (value.kind === 'progress') {
      const searchAssignment = details.searchCheckpoint && this.proofSearchAssignment(action);
      const search = searchAssignment && retainProofSearchCheckpoint({
        ...searchAssignment,
        projectRoot: path.join(worker.worktree, this.input.state.problem.projectRelative),
        runDirectory: path.dirname(this.lead.worktree), reference: details.searchCheckpoint!,
        workerId: worker.id, assignmentKey,
      });
      const latestSearch = search && latestProofSearchRecord(this.archive.proofSearchRecords?.[action.task.id], search);
      if (details.mathematicalGap) bindMathematicalGap(details.mathematicalGap, node.task, this.archive,
        { problemReceiptDigest: this.input.state.problem.receiptDigest, environmentDigest: this.input.state.environmentDigest });
      this.reportBlockers(node.task, value.blockers);
      const remaining = [...new Set([...(value.remainingObligations ?? []),
        ...this.dependencies(node.task).filter(dependency => !['integrated', 'completed'].includes(dependency.status)).map(dependency => dependency.task.id)])] as string[];
      if (value.needsDecision === true) this.wakeLead('progress-decision-requested');
      if (latestSearch) {
        (this.archive.proofSearchRecords ??= {})[action.task.id] = latestSearch;
        this.input.emit('proof_search_checkpoint_saved', { taskId: latestSearch.taskId, taskDigest: latestSearch.taskDigest,
          workerId: worker.id, basisDigest: latestSearch.basisDigest, generation: latestSearch.generation,
          checkpoint: latestSearch.checkpoint, proofAcceptance: 'not-accepted' });
      }
      this.record(worker, node.task, 'progress', remaining.length || node.task.kind === 'sketch' ? 'conditional' : 'advisory', details.summary,
        { ...details, ...(search ? { searchCheckpoint: search.checkpoint } : {}),
          submissionId: value.id, assignmentKey, remainingObligations: remaining });
      return;
    }
    if (advisory(node.task) || typeof value.commit !== 'string' || !/^[a-f0-9]{40,64}$/u.test(value.commit)) throw new Error('math_delivery_requires_fixed_proof');
    if (!taskCanStart(node.task, this.archive.tasks)) throw new Error('math_delivery_unfinished_dependencies');
    this.input.signal.throwIfAborted();
    const fixed = mathGitResult(worker.worktree, ['rev-parse', '--verify', '--quiet', `${value.commit}^{commit}`], { maxBuffer: 4096 });
    if (fixed.error) throw fixed.error;
    if (fixed.status === 1) throw new Error('math_delivery_invalid_commit');
    if (fixed.status !== 0) throw new Error('math_delivery_commit_unavailable');
    const ancestry = mathGitResult(worker.worktree,
      ['merge-base', '--is-ancestor', this.input.state.problem.baseCommit, value.commit], { maxBuffer: 4096 });
    if (ancestry.error) throw ancestry.error;
    if (ancestry.status === 1) throw new Error('math_delivery_invalid_commit');
    if (ancestry.status !== 0) throw new Error('math_delivery_commit_unavailable');
    try {
      await this.publishTaskProof(worker, action, value.commit, details.summary,
        { submissionId: value.id, assignmentKey, evidenceRefs: value.evidenceRefs });
    } catch (error) {
      if (error instanceof Error && /^math_task_(?:missing_declaration|repeated_failed_input)\n/u.test(error.message) && this.current(action)) {
        this.rejected(action, error.message, value.commit); return;
      }
      throw error;
    }
  }
}
