import crypto from 'node:crypto';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { committedSource, commitSolverSources, withSolverWorktree } from './problem';
import { solverProofFeedback } from './feedback';
import { taskDependenciesReady } from './modules/search';
import { applyTaskChanges, checkTaskProof, checkTaskProofs, createTaskSourceProjector, isAttributedTaskProof, type TaskProof } from './cooperativeProof';
import { hasDeterministicLeanFailure, hasLeanResourceLimitFailure } from './proofReuse';
import { proofReferencesUnchanged } from './proofReferences';
import { attributeTaskReferences } from './taskReferenceAttribution';
import { hasTaskConnectionCheck } from './taskConnections';
import { assignmentDeliveryFile, assumableLemma, taskGroup, taskReferenceDependencies, hasTaskAcceptance, type CooperativeTask, type TaskAssignment, type TaskRecord } from './tasks';
import { digest, taskSourceRejections, integrationRejections, rejectionCode, bounded } from './cooperationShared';
import { CooperationTaskProofs, type ProofDeliveryAnnotation, type ProofDeliveryState } from './cooperationTaskProofs';
import { reusableFreshConditionalCheck } from './freshContinuationChecks';
import type { ResearchWorker } from './modules/organization';
import { VerifierFailureError } from './verifierFailure';
import { IncrementalHelperRejection, landVerifiedHelpers, type HelperNomination } from './incrementalHelpers';

const recheckBatchFallbacks = new Set([...taskSourceRejections, 'math_task_batch_projection_mismatch', 'math_task_missing_declaration',
  'math_task_batch_resource_limit']);
const integrationBatchFallbacks = new Set([...taskSourceRejections, 'math_task_integration_conflict', 'math_task_integration_missing_context',
  'math_task_integration_missing_declaration', 'math_task_batch_projection_mismatch', 'math_task_batch_resource_limit']);
function verifierFailure(stage: string, proof?: TaskProof, task?: CooperativeTask) {
  return new VerifierFailureError({ stage, taskId: task?.id, taskDigest: proof?.taskDigest,
    sourceCommit: proof?.commit, seedCommit: proof?.seedCommit, projectionMode: proof?.projectionMode ?? 'full',
    conditions: proof?.conditions, verification: proof?.verification });
}
/** A changed check identity leaves no usable verifier result; aborts and unlisted failures propagate. */
function expectedRejection(error: unknown, expected: ReadonlySet<string>): Error {
  if (error instanceof Error && rejectionCode(error) === 'math_task_check_identity_changed')
    throw new Error('math_verifier_unavailable', { cause: error });
  if (!(error instanceof Error) || error.name === 'AbortError' || !expected.has(rejectionCode(error))) throw error;
  return error;
}

/** Integration of checked task proofs into the canonical commit and their rechecks. */
export abstract class CooperationIntegration extends CooperationTaskProofs {
  protected integrateWorkerHelpers(worker: ResearchWorker, action: Extract<import('./tasks').CooperativeAction, { kind: 'task' }>,
    sourceCommit: string, declarations: HelperNomination[], summary: string) {
    return this.queueIntegration(async () => {
      const current = () => !this.stopping && !this.input.signal.aborted && this.current(action);
      const state = this.input.state;
      const environmentDigest = state.environmentDigest, problemReceiptDigest = state.problem.receiptDigest;
      while (current() && state.environmentDigest === environmentDigest && state.problem.receiptDigest === problemReceiptDigest) {
        const expectedCommit = this.archive.canonicalCommit!;
        const eligible = ({ file, name }: HelperNomination) => worker.ownedFiles.includes(file) &&
          !this.archive.tasks.some(({ task }) => task.proofPath === file && task.theoremName === name);
        let result: Awaited<ReturnType<typeof landVerifiedHelpers>>;
        try {
          result = await landVerifiedHelpers({
            state, sourceWorktree: worker.worktree, sourceCommit, seedCommit: action.assignment.seedCommit,
            worktree: this.lead.worktree, expectedCommit, declarations, allowHelper: eligible,
            env: this.input.access.get(this.lead.id)!.environment, signal: this.input.signal, timeoutMs: this.input.timeoutMs,
          });
        } catch (error) {
          if (!(error instanceof IncrementalHelperRejection)) throw error;
          this.input.emit('incremental_helpers_rejected', { workerId: worker.id, taskId: action.task.id, reason: error.message });
          const active = this.active.get(worker.id);
          if (current() && active?.action === action)
            void active.notify('Helper submission rejected: ' + error.message, { mode: 'advisory' }).catch(() => {});
          return;
        }
        if (!current() || state.environmentDigest !== environmentDigest || state.problem.receiptDigest !== problemReceiptDigest) return;
        if (this.archive.canonicalCommit !== expectedCommit) continue;
        if (!result.helpers.length || !result.helpers.every(helper => eligible({ file: helper.file, name: helper.qualifiedName }))) return;
        this.pin(result.commit);
        this.archive.canonicalCommit = result.commit;
        (this.archive.landedHelpers ??= []).push(...result.helpers);
        this.changed();
        this.input.emit('incremental_helpers_landed', { workerId: worker.id, taskId: action.task.id,
          commit: result.commit, declarations: result.helpers.map(helper => helper.qualifiedName), summary });
        const message = `Verified ${result.helpers.length} canonical helpers at ${result.commit}. Available in the next seeded worktree. ` +
          'Read landedHelpers in COOPERATION.json for the signature index.\n' +
          result.helpers.slice(0, 8).map(helper => `${helper.type.slice(0, 240)} (${helper.file})`).join('\n');
        for (const active of this.active.values()) {
          if (!active.cancelled && this.current(active.action))
            void active.notify(message, { mode: 'advisory' }).catch(() => {});
        }
        return;
      }
    });
  }
  private canonicalCheckAssignment(task: CooperativeTask, seedCommit: string, tasks: readonly TaskRecord[]): TaskAssignment {
    return { taskId: task.id, taskDigest: digest(task), workerId: this.lead.id, seedCommit,
      dependencies: this.dependencies(task, tasks).map(node => ({ taskId: node.task.id, taskDigest: digest(node.task) })) };
  }
  protected queueIntegration<T>(operation: () => Promise<T>, worker?: ResearchWorker, task?: CooperativeTask): Promise<T> {
    const queuedAt = Date.now();
    const waiting = this.integrationQueueDepth++ > 0 && worker && task;
    if (waiting) this.recordDispatchWait(worker, { stage: 'integration-queue', candidateCount: 1, omittedCandidates: 0,
      candidates: [{ taskId: task.id, taskDigest: digest(task), reason: 'integration-queue' }] });
    this.refreshPlanApproval();
    const pending = this.integrationQueue.then(async () => {
      if (waiting) { this.clearDispatchWait(worker, 'selected'); this.changed(); }
      this.input.signal.throwIfAborted();
      this.input.emit('integration_queue_started', { waitedMs: Date.now() - queuedAt });
      return await operation();
    }).finally(() => { this.integrationQueueDepth--; this.wake(); });
    this.integrationQueue = pending.then(() => {}, () => {});
    return pending;
  }
  protected integrateReady() {
    return this.settleProofDeliveries(annotations => this.queueIntegration(() => this.integrateReadyNow(annotations)));
  }
  protected async integrateReadyNow(annotations: ProofDeliveryAnnotation[] = []) {
    for (;;) {
      // A parent can reach canonical acceptance before a later snapshot or publication fails.
      const unpublished = this.archive.tasks.find(item => !this.synchronizationBlocked(item.task) && item.status === 'integrated' && this.proofDeliveryCurrent(item) && item.proof && item.assignment &&
        item.integratedCheck?.passed && item.integratedCheck.taskDigest === digest(item.task) && this.checkedDeliveries.has(item.integratedCheck) &&
        !this.archive.deliveries?.some(record => record.taskId === item.task.id && record.taskDigest === digest(item.task) &&
          record.kind === 'proof' && record.status === 'verified' &&
          (record.commit === item.proof!.commit || record.commit === item.integratedCheck!.commit) &&
          !this.pendingProofDeliveryRecords.has(record)));
      if (unpublished) {
        const receipt = unpublished.integratedCheck, version = digest(unpublished.task);
        const publication = this.proofDeliveryState(unpublished);
        await this.syncPreparedStatements();
        if (this.archive.tasks.includes(unpublished) && unpublished.status === 'integrated' &&
            unpublished.integratedCheck === receipt && digest(unpublished.task) === version) {
          const annotate = await this.publishProofDelivery(unpublished, undefined, publication);
          if (annotate) annotations.push(annotate);
        }
        continue;
      }
      const node = this.archive.tasks.find(item => ['delivered', 'conditional'].includes(item.status) && this.integrationAllowed(item) &&
        taskDependenciesReady(item.task, this.archive.tasks));
      if (!node) return;
      const publication = await this.integrateNow(node);
      if (publication) {
        const annotate = await this.publishProofDelivery(node, undefined, publication);
        if (annotate) annotations.push(annotate);
      }
    }
  }
  protected synchronizationPending() {
    return Boolean(this.planSynchronization || this.preparingStatements || this.archive.tasks.some(node => node.pendingValidation));
  }
  protected candidateSynchronizationBlocked() {
    const required = this.fixedStatementReviewTasks();
    return this.archive.tasks.some(node => (node.task.kind === 'goal' || required?.has(node.task.id)) &&
      this.synchronizationBlocked(node.task));
  }
  protected markPendingValidation(nodes: readonly TaskRecord[], proofs: ReadonlySet<string> = new Set()) {
    for (const node of nodes) node.pendingValidation = { id: crypto.randomUUID(), taskDigest: digest(node.task),
      canonicalCommit: this.archive.canonicalCommit!, environmentDigest: this.input.state.environmentDigest,
      problemReceiptDigest: this.input.state.problem.receiptDigest,
      ...(proofs.has(node.task.id) || node.pendingValidation?.proof ? { proof: true } : {}) };
  }
  protected schedulePlanSynchronization(): Promise<void> {
    if (this.planSynchronization) return this.planSynchronization;
    const pending = this.synchronizePlan();
    this.planSynchronization = pending; this.planSynchronizations.add(pending);
    this.refreshPlanApproval();
    void pending.catch(error => {
      if (!this.input.signal.aborted) { this.failure = error instanceof Error ? error : new Error(String(error)); this.changed(); }
    }).finally(() => {
      this.planSynchronizations.delete(pending);
      if (this.planSynchronization === pending && !this.failure) this.planSynchronization = undefined;
      if (!this.failure && !this.input.signal.aborted && (this.archive.tasks.some(node => node.pendingValidation) ||
          this.archive.edits?.some(edit => edit.status === 'applied' && edit.pendingSync))) this.schedulePlanSynchronization();
      this.wake();
    }).catch(() => {});
    return pending;
  }
  private async synchronizePlan() {
    for (;;) {
      const snapshot = await this.input.exclusiveCheck(async () => {
        const targets = this.archive.tasks.filter(node => node.pendingValidation).map(node => ({ node, validation: node.pendingValidation! }));
        const edits = (this.archive.edits ?? []).filter(edit => edit.status === 'applied' && edit.pendingSync);
        if (!targets.length && !edits.length) return;
        return { canonical: this.archive.canonicalCommit!, environmentDigest: this.input.state.environmentDigest,
          problemReceiptDigest: this.input.state.problem.receiptDigest,
          environment: { ...this.input.access.get(this.lead.id)!.environment }, targets, edits,
          inputs: new Map(this.archive.tasks.map(node => [node.task.id, { node, taskDigest: digest(node.task),
            status: node.status, proof: node.proof, integratedCheck: node.integratedCheck, pendingValidation: node.pendingValidation }])),
          tasks: this.archive.tasks.map(node => ({ ...node, pendingValidation: undefined })) };
      });
      if (!snapshot) return;
      const ids = new Set(snapshot.targets.filter(item => item.validation.proof).map(item => item.node.task.id));
      const fresh = snapshot.targets.some(item => item.validation.proof && item.node.integratedCheck &&
        !this.checkedDeliveries.has(item.node.integratedCheck));
      const current = () => this.archive.canonicalCommit === snapshot.canonical &&
        this.input.state.environmentDigest === snapshot.environmentDigest &&
        this.input.state.problem.receiptDigest === snapshot.problemReceiptDigest &&
        snapshot.targets.every(({ node, validation }) => this.archive.tasks.includes(node) &&
          node.pendingValidation === validation && digest(node.task) === validation.taskDigest);
      const rechecked = await this.recheckIntegrated(snapshot.canonical, !fresh, { tasks: snapshot.tasks, ids,
        environment: snapshot.environment, environmentDigest: snapshot.environmentDigest, current });
      if (rechecked && current()) {
        const statements = this.prepareStatementContexts(snapshot.tasks, snapshot.canonical,
          { environment: snapshot.environment, digest: snapshot.environmentDigest, current }); if (statements) await statements;
      }
      await this.input.exclusiveCheck(async () => {
        this.input.signal.throwIfAborted();
        if (this.archive.canonicalCommit !== snapshot.canonical || this.input.state.environmentDigest !== snapshot.environmentDigest ||
            this.input.state.problem.receiptDigest !== snapshot.problemReceiptDigest) {
          const current = snapshot.targets.filter(({ node, validation }) => this.archive.tasks.includes(node) && node.pendingValidation === validation);
          this.markPendingValidation(current.map(item => item.node), ids);
          this.input.emit('plan_recheck_rebased', { from: snapshot.canonical, to: this.archive.canonicalCommit,
            taskIds: current.map(item => item.node.task.id) });
          this.changed(); return;
        }
        // An obsolete snapshot may still contain old receipts for targets not reached by the recheck.
        if (!rechecked || !current()) return;
        const inputCurrent = (id: string) => {
          const baseline = snapshot.inputs.get(id), current = this.node(id);
          return baseline && current === baseline.node && digest(current.task) === baseline.taskDigest &&
            current.status === baseline.status && current.proof === baseline.proof && current.integratedCheck === baseline.integratedCheck &&
            current.pendingValidation === baseline.pendingValidation;
        };
        const dependencies = new Map(snapshot.targets.map(({ node }) => {
          const checked = snapshot.tasks.find(item => item.task.id === node.task.id)!;
          return [node.task.id, [...new Set([...this.dependencies(checked.task, snapshot.tasks).map(item => item.task.id),
            ...(checked.integratedCheck?.references?.tasks?.map(reference => reference.taskId) ?? [])])]];
        }));
        const publishable = new Set(snapshot.targets.filter(({ node, validation }) => inputCurrent(node.task.id) &&
          node.pendingValidation === validation && digest(node.task) === validation.taskDigest &&
          dependencies.get(node.task.id)!.every(inputCurrent)).map(({ node }) => node.task.id));
        for (;;) {
          const invalid = [...publishable].filter(id => dependencies.get(id)!.some(dependency =>
            snapshot.inputs.get(dependency)?.pendingValidation && !publishable.has(dependency)));
          if (!invalid.length) break;
          for (const id of invalid) publishable.delete(id);
        }
        for (const { node, validation } of snapshot.targets) {
          if (!this.archive.tasks.includes(node) || node.pendingValidation !== validation) continue;
          if (!publishable.has(node.task.id)) { this.markPendingValidation([node], ids); continue; }
          const checked = snapshot.tasks.find(item => item.task.id === node.task.id)!;
          if (ids.has(node.task.id)) {
            node.integratedCheck = checked.integratedCheck; this.moveTask(node, checked.status, 'integrated'); node.feedback = checked.feedback;
            if (node.status === 'blocked') this.wakeLead('integration-blocked');
          }
          delete node.pendingValidation;
        }
        this.syncStatementReviews();
        for (const edit of snapshot.edits) if (!edit.recheck?.tasks.some(result => {
          const current = this.node(result.taskId);
          return current?.pendingValidation && digest(current.task) === result.taskDigest;
        })) edit.pendingSync = undefined;
        this.input.emit('task_contract_sources_revalidated', { taskIds: [...ids].filter(id => !this.node(id)?.pendingValidation) });
        this.changed();
      });
      await this.integrateReady();
    }
  }
  private async recheckIntegrated(canonical: string, changedOnly = false, snapshot?: { tasks: TaskRecord[]; ids: ReadonlySet<string>;
    environment: NodeJS.ProcessEnv; environmentDigest: string; current: () => boolean }) {
    // Persisted receipts and receipts for different sources cannot authorize dependent dispatch.
    const tasks = snapshot?.tasks ?? this.archive.tasks;
    const pending = tasks.filter(node => node.status === 'integrated' && (!snapshot || snapshot.ids.has(node.task.id)));
    const selected = new Set(pending.map(node => node.task.id));
    const checked = new Set<string>();
    const batched = new Map<TaskRecord, { proof: TaskProof; source: string; retainedGoals: string }>();
    const batchAttempted = new Set<TaskRecord>();
    // Phase-local receipts bind the fixed canonical, environment and task version.
    // Restored integrated labels cannot authorize original-goal context.
    const freshGoals = new Map<string, string>();
    const retryable = new Map<TaskRecord, readonly string[]>();
    const retried = new Set<TaskRecord>();
    const availableGoals = (node: TaskRecord) => tasks.filter(item => item.task.kind === 'goal' &&
      item.task.id !== node.task.id && item.status === 'integrated' &&
      freshGoals.get(item.task.id) === digest(item.task));
    const extraGoals = (node: TaskRecord) => {
      const available = availableGoals(node);
      if (retried.has(node) || !available.length) return available.map(item => item.task.theoremName!);
      const inputs = new Set(this.sourceGoalInputs(node.task, tasks, this.lead.worktree, canonical).map(input => input.task.id));
      return available.filter(item => inputs.has(item.task.id)).map(item => item.task.theoremName!);
    };
    const request = (node: TaskRecord) => ({ task: node.task,
      assignment: this.canonicalCheckAssignment(node.task, canonical, tasks),
      retainedGoals: [...new Set([...this.retainedTaskGoals(node.task, tasks, this.lead.worktree, canonical), ...extraGoals(node)])] });
    const prerequisites = new Map(pending.map(node => [node.task.id, [...new Set([
      ...this.dependencies(node.task, tasks).map(item => item.task.id),
      ...this.sourceGoalInputs(node.task, tasks, this.lead.worktree, canonical).map(item => item.task.id) ])]]));
    const ready = (node: TaskRecord) => prerequisites.get(node.task.id)!.every(id => !selected.has(id) ||
      tasks.find(item => item.task.id === id)?.status !== 'integrated' || checked.has(id));
    const projections = new Map<string, string | Error>();
    const projection = (node: TaskRecord, receipt?: TaskProof) => {
      const retainedGoals = request(node).retainedGoals;
      const compact = receipt?.projectionMode === 'compact';
      const preserved = compact ? receipt.changes : [];
      const key = canonicalMathJson({ taskDigest: digest(node.task), retainedGoals, compact, preserved });
      let value = projections.get(key);
      if (value === undefined) {
        try {
          const projector = this.sourceProjector(this.lead.worktree, canonical, compact, preserved);
          value = mathDigest(canonicalMathJson([...projector(node.task, retainedGoals)]));
        } catch (error) { value = error instanceof Error ? error : new Error(String(error)); }
        projections.set(key, value);
      }
      if (value instanceof Error) throw value;
      return value;
    };
    const checkedProjections = new Map<string, string>();
    const reusable = (node: TaskRecord) => {
      const receipt = node.integratedCheck, references = receipt?.references;
      if (!(changedOnly || snapshot) || !receipt?.passed || receipt.conditions?.length ||
          receipt.taskDigest !== digest(node.task) || !this.checkedDeliveries.has(receipt) || !hasTaskAcceptance(receipt) ||
          !references || references.environmentDigest !== (snapshot?.environmentDigest ?? this.input.state.environmentDigest) ||
          !taskDependenciesReady(node.task, tasks)) return false;
      if (taskReferenceDependencies(node) && proofReferencesUnchanged(this.input.state.problem, this.lead.worktree, canonical, references,
          snapshot?.environmentDigest ?? this.input.state.environmentDigest)) return true;
      // Only the process-local acceptance gates above authorize this receipt's mode.
      // A compact receipt must be compared with its compact projection, retaining
      // every changed declaration that was checked with the delivery.
      const commit = receipt.verification.targetCommit;
      if (!commit) return false;
      let checked = checkedProjections.get(commit);
      if (checked === undefined) {
        checked = mathDigest(canonicalMathJson(this.input.state.problem.ownedFiles.map(file => [file,
          committedSource(this.lead.worktree, commit, `${this.input.state.problem.projectRelative}/${file}`)])));
        checkedProjections.set(commit, checked);
      }
      return projection(node, receipt) === checked;
    };
    const progress = { canonicalCommit: canonical, total: pending.length, completed: 0, taskId: undefined as string | undefined };
    const persistProgress = async () => {
      const publish = async () => {
        if (snapshot && !snapshot.current()) return;
        this.archive.recheck = { ...progress }; this.input.save();
      };
      if (snapshot) await this.input.exclusiveCheck(publish);
      else await publish();
    };
    await persistProgress();
    const finish = async (node: TaskRecord, receipt?: TaskProof) => {
      if (!checked.has(node.task.id)) { checked.add(node.task.id); progress.completed++; }
      progress.taskId = undefined;
      if (node.status === 'integrated' && node.task.kind === 'goal' && node.integratedCheck?.passed &&
          !node.integratedCheck.conditions?.length && this.checkedDeliveries.has(node.integratedCheck) &&
          hasTaskAcceptance(node.integratedCheck)) freshGoals.set(node.task.id, digest(node.task));
      this.input.emit('task_recheck_finished', { ...progress, taskId: node.task.id, passed: node.status === 'integrated',
        commit: receipt?.commit, taskDigest: receipt?.taskDigest, ...(snapshot ? { staged: true } : {}) });
      await persistProgress();
    };
    while (pending.length || retryable.size) {
      this.input.signal.throwIfAborted();
      if (snapshot && !snapshot.current()) return false;
      if (!pending.length) {
        for (const [node, previousGoals] of retryable) {
          retryable.delete(node);
          if (retried.has(node) || !availableGoals(node).some(item => !previousGoals.includes(item.task.theoremName!))) continue;
          retried.add(node); pending.push(node);
          this.input.emit('task_recheck_context_retry', { taskId: node.task.id, canonicalCommit: canonical,
            retainedGoals: request(node).retainedGoals, ...(snapshot ? { staged: true } : {}) });
        }
        if (!pending.length) break;
      }
      const index = pending.findIndex(ready);
      if (index < 0) throw new Error('math_plan_dependency_cycle');
      const [node] = pending.splice(index, 1);
      progress.taskId = node.task.id;
      this.input.emit('task_recheck_started', { ...progress }); await persistProgress();
      this.input.signal.throwIfAborted();
      if (snapshot && !snapshot.current()) return false;
      const assignment = this.canonicalCheckAssignment(node.task, canonical, tasks);
      let savedReceipt: TaskProof | undefined;
      try {
        if (reusable(node)) {
          node.feedback = undefined;
          const receipt = node.integratedCheck!;
          this.input.emit('task_check_reused', { taskId: node.task.id, passed: receipt.passed,
            commit: receipt.commit, taskDigest: receipt.taskDigest, canonicalCommit: canonical });
          await finish(node, receipt); continue;
        }
        if (!batchAttempted.has(node) && (this.input.modules.M2.checkTask ?? checkTaskProof) === checkTaskProof) {
          const source = projection(node);
          const group = [node, ...pending.filter(item => {
            if (batchAttempted.has(item) || !ready(item)) return false;
            try { return !reusable(item) && projection(item) === source; } catch { return false; }
          })].slice(0, 32);
          if (group.length > 1) {
            group.forEach(item => batchAttempted.add(item));
            this.input.emit('task_recheck_batch_started', { taskIds: group.map(item => item.task.id) });
            try {
              const requests = group.map(request);
              const proofs = await checkTaskProofs(this.input.state.problem, this.lead.worktree, canonical, requests,
                snapshot?.environment ?? this.input.access.get(this.lead.id)!.environment, this.input.signal, this.input.timeoutMs,
                snapshot?.environmentDigest ?? this.input.state.environmentDigest, this.taskProofCache);
              this.input.signal.throwIfAborted();
              if (proofs.some(proof => hasLeanResourceLimitFailure(proof.verification))) throw new Error('math_task_batch_resource_limit');
              const failed = proofs.find(proof => ['unavailable', 'blocked'].includes(proof.verification.status) || !isAttributedTaskProof(proof));
              if (failed) throw verifierFailure('integrated-batch-recheck', failed);
              if (snapshot && !snapshot.current()) return false;
              group.forEach((item, index) => {
                const proof = proofs[index];
                if (!proof) throw verifierFailure('integrated-batch-missing-receipt', undefined, item.task);
                // A failed shared compilation cannot identify a bad member. Leave
                // failed views to the ordinary single-target compact/full check.
                if (proof.passed) batched.set(item, { proof, source, retainedGoals: canonicalMathJson(requests[index].retainedGoals) });
              });
            } catch (error) {
              this.input.signal.throwIfAborted();
              const rejected = expectedRejection(error, recheckBatchFallbacks);
              if (snapshot && !snapshot.current()) return false;
              this.input.emit('task_recheck_batch_fallback', { taskIds: group.map(item => item.task.id), reason: bounded(rejected.message, 1000) });
            }
          }
        }
        // Earlier batch members can invalidate goals retained by a later member.
        // Recheck its current projection instead of submitting an obsolete receipt.
        const prepared = batched.get(node);
        const checkedProof = prepared && prepared.source === projection(node) &&
          prepared.retainedGoals === canonicalMathJson(request(node).retainedGoals) ? prepared.proof : undefined;
        const beforeGoals = request(node).retainedGoals;
        const receipt = await this.check(node.task, assignment, this.lead.worktree, canonical, [], checkedProof, false, false, tasks,
          snapshot && { environment: snapshot.environment, digest: snapshot.environmentDigest }, extraGoals(node));
        this.input.signal.throwIfAborted();
        if (['unavailable', 'blocked'].includes(receipt.verification.status)) throw verifierFailure('integrated-task-recheck', receipt, node.task);
        if (snapshot && !snapshot.current()) return false;
        savedReceipt = node.integratedCheck = receipt;
        if (!receipt.passed && !retried.has(node) && !receipt.conditions?.length &&
            hasDeterministicLeanFailure(receipt.verification)) retryable.set(node, beforeGoals);
        if (!receipt.passed) { this.moveTask(node, 'blocked', 'invalidated'); node.feedback = solverProofFeedback(receipt); if (!snapshot) this.wakeLead('integration-blocked'); }
        // A kernel-checked original can supply concrete source context even when
        // an earlier helper projection failed. Settle graph readiness after the
        // bounded recovery pass, before this snapshot can be published.
        else { this.moveTask(node, 'integrated', 'integrated'); node.feedback = undefined; }
      } catch (error) {
        this.input.signal.throwIfAborted();
        const rejected = expectedRejection(error, integrationRejections);
        if (snapshot && !snapshot.current()) return false;
        this.moveTask(node, 'blocked', 'invalidated'); node.feedback = rejected.message; if (!snapshot) this.wakeLead('integration-blocked');
      }
      await finish(node, savedReceipt);
    }
    this.input.signal.throwIfAborted();
    if (snapshot && !snapshot.current()) return false;
    // Fresh receipts can reveal inputs absent from the planned graph, including
    // restored receipts that could not authorize an earlier dependency order.
    for (const node of tasks) if (selected.has(node.task.id) && node.status === 'integrated' &&
        !taskDependenciesReady(node.task, tasks)) {
      this.moveTask(node, 'blocked', 'invalidated'); node.feedback = 'math_task_dependency_invalidated';
      if (!snapshot) this.wakeLead('integration-blocked');
      this.input.emit('task_recheck_dependency_invalidated', { ...progress, taskId: node.task.id, ...(snapshot ? { staged: true } : {}) });
    }
    return !snapshot || snapshot.current();
  }
  protected async recheckConditional() {
    for (const node of this.archive.tasks.filter(node => node.status === 'conditional')) {
      const group = this.archive.groups?.find(record => record.group.id === taskGroup(node.task));
      if ((node.task.status ?? 'active') !== 'active' || group && group.group.status !== 'active') continue;
      const saved = node.proof;
      let savedReceipt: TaskProof | undefined;
      this.input.emit('task_conditional_recheck_started', { taskId: node.task.id });
      try {
        if (!(node.task.conditional || node.assignment && hasTaskConnectionCheck(node.task, node.assignment)) ||
            !saved?.passed || saved.taskDigest !== digest(node.task) ||
            !saved.conditions?.length || !node.assignment) throw new Error('math_task_condition_version_invalid');
        const conditions = saved.conditions.map(condition => {
          const input = this.node(condition.taskId);
          if (!input || !assumableLemma(input.task) || digest(input.task) !== condition.taskDigest)
            throw new Error('math_task_condition_version_invalid');
          return input.task;
        });
        const proof = await withSolverWorktree(this.lead.worktree, saved.commit, async checkout => {
          const checked = (this.input.modules.M2.checkTask ?? checkTaskProof) === checkTaskProof &&
            this.input.freshContinuationChecks?.includes(saved) && reusableFreshConditionalCheck(saved, {
            task: node.task, assignment: node.assignment!, conditions,
            retainedGoals: this.retainedTaskGoals(node.task, this.archive.tasks, checkout, saved.commit, conditions),
            environmentDigest: this.input.state.environmentDigest, problemReceiptDigest: this.input.state.problem.receiptDigest,
            environment: this.input.access.get(this.lead.id)!.environment,
          }) ? saved : undefined;
          const proof = await this.check(node.task, node.assignment!, checkout, saved.commit, conditions, checked);
          if (checked) this.input.emit('task_conditional_check_reused', { taskId: node.task.id, commit: proof.commit });
          return proof;
        });
        if (['unavailable', 'blocked'].includes(proof.verification.status)) throw verifierFailure('conditional-task-recheck', proof, node.task);
        savedReceipt = node.proof = proof;
        if (proof.passed) node.feedback = undefined;
        else {
          this.moveTask(node, 'blocked', 'invalidated'); node.feedback = solverProofFeedback(proof); this.wakeLead('conditional-recheck-failed');
        }
      } catch (error) {
        this.input.signal.throwIfAborted();
        node.feedback = expectedRejection(error, integrationRejections).message; this.moveTask(node, 'blocked', 'invalidated'); this.wakeLead('conditional-recheck-failed');
      }
      this.input.emit('task_conditional_recheck_finished', { taskId: node.task.id, passed: node.status === 'conditional',
        commit: savedReceipt?.commit, taskDigest: savedReceipt?.taskDigest });
      this.changed();
    }
  }
  protected integrate(node: TaskRecord) { return this.queueIntegration(() => this.integrateNow(node)); }
  private integrationAllowed(node: TaskRecord) {
    const group = this.archive.groups?.find(record => record.group.id === taskGroup(node.task));
    return !this.synchronizationBlocked(node.task) && !(node.proof?.references?.tasks ?? []).some(reference => {
      const dependency = this.node(reference.taskId);
      return !dependency || dependency.pendingValidation || this.preparingStatementTasks.has(reference.taskId);
    }) && (node.task.status ?? 'active') === 'active' && (!this.archive.groups || group?.group.status === 'active');
  }
  private integrationSnapshot(node: TaskRecord) {
    if (!this.archive.tasks.includes(node) || !['delivered', 'conditional'].includes(node.status) ||
        !node.assignment || !node.proof || !this.integrationAllowed(node)) return;
    const tasks = this.archive.tasks.map(item => ({ ...item }));
    const dependencies = this.dependencies(node.task, tasks);
    const group = this.archive.groups?.find(record => record.group.id === taskGroup(node.task));
    return { node, task: node.task, taskDigest: digest(node.task), assignment: node.assignment, proof: node.proof, status: node.status,
      canonical: this.archive.canonicalCommit!, environmentDigest: this.input.state.environmentDigest,
      problemReceiptDigest: this.input.state.problem.receiptDigest, groupDigest: canonicalMathJson(group?.group ?? null),
      routesDigest: canonicalMathJson({ alternatives: node.alternativeRoutes ?? [], routes: this.archive.proofRoutes ?? [] }), tasks,
      dependencies: dependencies.map(item => ({ id: item.task.id, taskDigest: digest(item.task), status: item.status,
        proof: item.proof, integratedCheck: item.integratedCheck })) };
  }
  private integrationTaskCurrent(snapshot: NonNullable<ReturnType<CooperationIntegration['integrationSnapshot']>>) {
    const { node } = snapshot;
    return this.archive.tasks.includes(node) && node.status === snapshot.status && node.assignment === snapshot.assignment &&
      node.proof === snapshot.proof && digest(node.task) === snapshot.taskDigest && this.integrationAllowed(node) &&
      this.input.state.environmentDigest === snapshot.environmentDigest && this.input.state.problem.receiptDigest === snapshot.problemReceiptDigest &&
      canonicalMathJson({ alternatives: node.alternativeRoutes ?? [], routes: this.archive.proofRoutes ?? [] }) === snapshot.routesDigest &&
      snapshot.dependencies.every(dependency => {
        const current = this.node(dependency.id);
        return current && digest(current.task) === dependency.taskDigest;
      });
  }
  private integrationInputsCurrent(snapshot: NonNullable<ReturnType<CooperationIntegration['integrationSnapshot']>>) {
    const group = this.archive.groups?.find(record => record.group.id === taskGroup(snapshot.task));
    return canonicalMathJson(group?.group ?? null) === snapshot.groupDigest && snapshot.dependencies.every(dependency => {
      const current = this.node(dependency.id);
      return current?.status === dependency.status && current.proof === dependency.proof && current.integratedCheck === dependency.integratedCheck;
    });
  }
  /** Batch only work that is ready now; every target must check the same complete union projection. */
  private async integrateBatch(node: TaskRecord): Promise<'fallback' | 'retry' | ProofDeliveryState> {
    if ((this.input.modules.M2.checkTask ?? checkTaskProof) !== checkTaskProof) return 'fallback';
    const batch = await this.input.exclusiveCheck(async () => {
      const eligible = (item: TaskRecord) => item.task.kind === 'lemma' && item.proof?.passed &&
        this.checkedDeliveries.has(item.proof) && !item.proof.conditions?.length && taskDependenciesReady(item.task, this.archive.tasks);
      const first = eligible(node) && this.integrationSnapshot(node);
      if (!first) return;
      const snapshots = [first], declarations = new Set(first.proof.changes.map(change => `${change.file}\0${change.name}`));
      const uses = (item: typeof first) => new Set([...item.task.dependsOn, ...item.dependencies.map(input => input.id),
        ...(item.proof.references?.tasks ?? []).map(input => input.taskId)]);
      for (const candidate of this.archive.tasks) {
        if (snapshots.length === 32) break;
        if (candidate === node || taskGroup(candidate.task) !== taskGroup(first.task) || !eligible(candidate)) continue;
        const snapshot = this.integrationSnapshot(candidate);
        if (!snapshot || snapshot.proof.changes.some(change => declarations.has(`${change.file}\0${change.name}`)) ||
            snapshots.some(item => uses(item).has(snapshot.task.id) || uses(snapshot).has(item.task.id))) continue;
        snapshots.push({ ...snapshot, tasks: first.tasks });
        snapshot.proof.changes.forEach(change => declarations.add(`${change.file}\0${change.name}`));
      }
      if (snapshots.length < 2) return;
      const graph = canonicalMathJson(this.archive.tasks.map(item => [item.task.id, digest(item.task)]));
      const environment = { ...this.input.access.get(this.lead.id)!.environment };
      const key = mathDigest(canonicalMathJson({ canonical: first.canonical, environment, environmentDigest: first.environmentDigest,
        problemReceiptDigest: first.problemReceiptDigest, graph, group: first.groupDigest,
        inputs: snapshots.map(item => ({ task: item.taskDigest, assignment: item.assignment, proof: item.proof,
          routes: item.routesDigest, dependencies: item.dependencies })) }));
      if (this.rejectedIntegrationBatches.has(key)) return;
      return { snapshots, graph, environment, key };
    });
    if (!batch) return 'fallback';
    const { snapshots, environment } = batch, first = snapshots[0], problem = this.input.state.problem;
    let merged: string | undefined, receipts: TaskProof[] | undefined, fallback: string | undefined;
    try {
      await withSolverWorktree(this.lead.worktree, first.canonical, async checkout => {
        for (const snapshot of snapshots) applyTaskChanges(problem, checkout, snapshot.proof.changes, snapshot.proof.imports);
        merged = commitSolverSources(problem, checkout);
        // New declarations can expose source dependencies absent from the old canonical.
        const requests = snapshots.map(snapshot => ({ task: snapshot.task,
          retainedGoals: this.retainedTaskGoals(snapshot.task, snapshot.tasks, checkout, merged!),
          assignment: this.canonicalCheckAssignment(snapshot.task, merged!, snapshot.tasks) }));
        const projector = createTaskSourceProjector(problem, checkout, merged);
        const projections = requests.map(request => canonicalMathJson([...projector(request.task, request.retainedGoals)]));
        if (projections.some(projection => projection !== projections[0])) {
          fallback = 'math_task_batch_projection_mismatch'; return;
        }
        this.input.emit('task_integration_batch_started', { taskIds: snapshots.map(snapshot => snapshot.task.id), commit: merged });
        const proofs = await checkTaskProofs(problem, checkout, merged, requests, environment, this.input.signal,
          this.input.timeoutMs, first.environmentDigest, this.taskProofCache);
        this.input.signal.throwIfAborted();
        // One merged run exceeding the limit says nothing about each member; integrate them separately.
        if (proofs.some(proof => hasLeanResourceLimitFailure(proof.verification))) {
          fallback = 'math_task_batch_resource_limit'; return;
        }
        const failed = proofs.find(proof => ['unavailable', 'blocked'].includes(proof.verification.status));
        if (failed) throw verifierFailure('task-batch-integration', failed);
        const deterministic = proofs.every(proof => proof.passed || isAttributedTaskProof(proof) && hasDeterministicLeanFailure(proof.verification));
        receipts = [];
        for (const [index, snapshot] of snapshots.entries()) receipts.push(await this.check(snapshot.task, requests[index].assignment,
          checkout, merged, [], proofs[index], false, false, first.tasks,
          { environment, digest: first.environmentDigest }));
        if (receipts.some(receipt => !receipt.passed)) {
          if (!deterministic) throw verifierFailure('task-batch-unattributed', receipts.find(receipt => !receipt.passed));
          fallback = 'math_task_merged_proof_failed';
        } else if (receipts.some(receipt => receipt.references?.tasks?.some(reference =>
          snapshots.some(snapshot => snapshot.task.id === reference.taskId)))) fallback = 'math_task_batch_dependency_changed';
      });
    } catch (error) {
      this.input.signal.throwIfAborted();
      fallback = rejectionCode(expectedRejection(error, integrationBatchFallbacks));
    }
    const result = await this.input.exclusiveCheck(async () => {
      this.input.signal.throwIfAborted();
      if (this.archive.canonicalCommit !== first.canonical || snapshots.some(snapshot =>
        !this.integrationTaskCurrent(snapshot) || !this.integrationInputsCurrent(snapshot)) ||
        canonicalMathJson(this.archive.tasks.map(item => [item.task.id, digest(item.task)])) !== batch.graph) {
        this.input.emit('task_integration_batch_superseded', { taskIds: snapshots.map(snapshot => snapshot.task.id) });
        return 'retry' as const;
      }
      if (fallback) {
        if (this.rejectedIntegrationBatches.size >= 64) this.rejectedIntegrationBatches.delete(this.rejectedIntegrationBatches.values().next().value!);
        this.rejectedIntegrationBatches.add(batch.key);
        this.input.emit('task_integration_batch_fallback', { taskIds: snapshots.map(snapshot => snapshot.task.id), reason: fallback });
        return 'fallback' as const;
      }
      const checkedReceipts = receipts;
      if (!merged || !checkedReceipts || checkedReceipts.length !== snapshots.length) throw new Error('math_task_integration_missing_receipt');
      if (checkedReceipts.some(receipt => receipt.references && canonicalMathJson(receipt.references.tasks) !==
          canonicalMathJson(attributeTaskReferences(receipt.references, this.archive.tasks)))) return 'retry' as const;
      this.archive.canonicalCommit = merged;
      snapshots.forEach((snapshot, index) => {
        snapshot.node.integratedCheck = checkedReceipts[index]; snapshot.node.feedback = undefined;
        this.moveTask(snapshot.node, 'integrated', 'integrated');
      });
      snapshots.forEach((snapshot, index) => this.input.emit('task_integrated', { taskId: snapshot.task.id,
        taskDigest: snapshot.taskDigest, assignmentKey: assignmentDeliveryFile(snapshot.assignment),
        workerId: snapshot.assignment.workerId, seedCommit: snapshot.assignment.seedCommit,
        sourceDigest: checkedReceipts[index].sourceDigest, receiptIds: checkedReceipts[index].verification.results.map(result => result.receiptId),
        groupId: taskGroup(snapshot.task), sharing: snapshot.task.sharing ?? 'problem', commit: merged, batchSize: snapshots.length }));
      this.changed();
      return this.proofDeliveryState(node);
    });
    if (typeof result !== 'string') await this.syncPreparedStatements();
    return result;
  }
  protected async integrateNow(node: TaskRecord) {
    const problem = this.input.state.problem;
    for (;;) {
      const batch = await this.integrateBatch(node);
      if (batch === 'retry') continue;
      if (batch !== 'fallback') return batch;
      const snapshot = await this.input.exclusiveCheck(async () => this.integrationSnapshot(node));
      if (!snapshot) return;
      let submitted = snapshot.proof, receipt: TaskProof | undefined, merged: string | undefined, failure: unknown;
      try {
        await withSolverWorktree(this.lead.worktree, snapshot.canonical, async checkout => {
          const environment = this.input.access.get(this.lead.id)!.environment;
          const check = (commit: string, assignment: TaskAssignment, conditions: readonly CooperativeTask[], checkedWorktree = checkout) =>
            this.check(snapshot.task, assignment, checkedWorktree, commit, conditions, undefined, false, false, snapshot.tasks,
              { environment, digest: snapshot.environmentDigest });
          // Restored JSON needs fresh delivery evidence before its changes can enter a merge.
          if (!this.checkedDeliveries.has(submitted)) {
            const conditions = (submitted.conditions ?? []).map(condition => {
              const dependency = snapshot.tasks.find(item => item.task.id === condition.taskId);
              if (!dependency || digest(dependency.task) !== condition.taskDigest) throw new Error('math_task_condition_version_invalid');
              return dependency.task;
            });
            submitted = await check(submitted.commit, snapshot.assignment, conditions);
          }
          this.input.signal.throwIfAborted();
          if (['unavailable', 'blocked'].includes(submitted.verification.status)) throw verifierFailure('task-integration-delivery', submitted, snapshot.task);
          if (!submitted.passed) throw new Error('math_task_delivery_no_longer_checks');
          if (!taskDependenciesReady(snapshot.task, snapshot.tasks)) throw new Error('math_task_dependency_invalidated');
          const resolvedConditions = (submitted.conditions ?? []).map(condition => {
            const input = snapshot.tasks.find(item => item.task.id === condition.taskId);
            if (!input || !assumableLemma(input.task) || input.status !== 'integrated' ||
                digest(input.task) !== condition.taskDigest) throw new Error('math_task_condition_version_invalid');
            return input.task;
          });
          try {
            applyTaskChanges(problem, checkout, submitted.changes, submitted.imports, resolvedConditions, submitted);
          } catch (conflict) {
            if (!(conflict instanceof Error) || rejectionCode(conflict) !== 'math_task_integration_conflict') throw conflict;
            // A peer may already have proved this exact task with a different body. Preserve
            // its sources and check the untouched canonical, without the delivery's assumptions.
            let existing: TaskProof;
            try {
              existing = await withSolverWorktree(this.lead.worktree, snapshot.canonical, canonicalCheckout =>
                check(snapshot.canonical, this.canonicalCheckAssignment(snapshot.task, snapshot.canonical, snapshot.tasks),
                  [], canonicalCheckout));
            } catch (error) {
              this.input.signal.throwIfAborted();
              expectedRejection(error, integrationRejections);
              throw conflict;
            }
            this.input.signal.throwIfAborted();
            if (['unavailable', 'blocked'].includes(existing.verification.status)) throw verifierFailure('task-integration-conflict', existing, snapshot.task);
            if (!existing.passed) throw conflict;
            receipt = existing; merged = snapshot.canonical;
            return;
          }
          merged = commitSolverSources(problem, checkout);
          receipt = await check(merged, this.canonicalCheckAssignment(snapshot.task, merged, snapshot.tasks), []);
          this.input.signal.throwIfAborted();
          if (['unavailable', 'blocked'].includes(receipt.verification.status)) throw verifierFailure('task-integration-merged', receipt, snapshot.task);
        });
      } catch (error) { failure = error; }
      const result = await this.input.exclusiveCheck(async () => {
        this.input.signal.throwIfAborted();
        if (!this.integrationTaskCurrent(snapshot)) {
          this.input.emit('task_integration_superseded', { taskId: snapshot.task.id, commit: snapshot.proof.commit });
          this.changed(); return 'superseded';
        }
        if (this.archive.canonicalCommit !== snapshot.canonical || !this.integrationInputsCurrent(snapshot)) {
          this.input.emit('task_integration_rebased', { taskId: snapshot.task.id, from: snapshot.canonical,
            to: this.archive.canonicalCommit });
          this.changed(); return 'retry';
        }
        if (submitted.passed) node.proof = submitted;
        if (!failure && receipt && !receipt.passed) {
          node.integratedCheck = receipt; node.feedback = solverProofFeedback(receipt);
          failure = new Error('math_task_merged_proof_failed');
        }
        if (failure) {
          this.changed();
          node.feedback = `${expectedRejection(failure, integrationRejections).message}\n${node.feedback ?? ''}`; this.moveTask(node, 'blocked', 'integrated');
          this.wakeLead('integration-blocked'); this.changed(); return this.proofDeliveryState(node);
        }
        if (!receipt || !merged) throw new Error('math_task_integration_missing_receipt');
        if (receipt.references?.tasks?.some(reference => {
          const current = this.node(reference.taskId);
          return !current || digest(current.task) !== reference.taskDigest;
        })) {
          this.input.emit('task_integration_superseded', { taskId: snapshot.task.id, reason: 'actual-reference-changed' });
          this.changed(); return 'superseded';
        }
        node.integratedCheck = receipt; node.feedback = undefined;
        this.archive.canonicalCommit = merged; this.moveTask(node, 'integrated', 'integrated');
        this.input.emit('task_integrated', { taskId: node.task.id, taskDigest: snapshot.taskDigest,
          assignmentKey: assignmentDeliveryFile(snapshot.assignment), workerId: snapshot.assignment.workerId,
          seedCommit: snapshot.assignment.seedCommit, sourceDigest: receipt.sourceDigest,
          receiptIds: receipt.verification.results.map(result => result.receiptId),
          groupId: taskGroup(node.task), sharing: node.task.sharing ?? 'problem', commit: merged });
        this.changed(); return this.proofDeliveryState(node);
      });
      if (result === 'retry') continue;
      if (typeof result === 'string') return;
      if (result.status === 'integrated') await this.syncPreparedStatements();
      return result;
    }
  }
}
