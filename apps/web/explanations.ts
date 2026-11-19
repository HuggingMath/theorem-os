import crypto from 'node:crypto';
import { mathDigest } from '../../src/math/mathRuntimeIo';
import { informalizationRetryLimit } from '../../src/solver/informalization';
import { webExplanationLimits } from './config';
import { explanationDocument, verifyExplanationEvidence } from './explanation';
import { explanationCheckpointBinding } from './explanationCheckpoint';
import type { WebRunner } from './runner';
import type { WebExplanation, WebExplanationLanguage, WebExplanationProgress, WebProvider, WebRun, WorkerExplanationInput,
  WorkerExplanationMessage } from './shared';
import { webExplanationReason } from './shared';
import { WebStorage, WebStorageError } from './storage';
import { isStatementReviewed } from './presentation';

type Job = { owner: string; key: string; run: WebRun; explanation: WebExplanation; input: WorkerExplanationInput;
  controller: AbortController; persistedAt: number; group: string; waitingReview?: boolean };
type ExplanationRequest = { target: string; language: WebExplanationLanguage; apiKey: string; provider: WebProvider;
  model: string; effort: 'low' | 'high' | 'max' };
const active = (explanation: WebExplanation) => explanation.status === 'queued' || explanation.status === 'running';
/** Storage key of one explanation of a run: its target and language. */
export const explanationKey = (target: string, language: WebExplanationLanguage) => mathDigest(`${language}\n${target}`);
const reasonOf = (error: unknown) => error instanceof Error && webExplanationReason.test(error.message) ? error.message : 'explanation_failed';

/** Explanation jobs, one container each. Progress is saved every few seconds; a restart marks unfinished jobs interrupted. */
export class WebExplanations {
  private jobs = new Map<string, Job>();
  private running = 0;
  private closing = false;

  constructor(private readonly runner: WebRunner, private readonly storage: WebStorage,
    private readonly limits: Pick<typeof webExplanationLimits, 'concurrency' | 'queueLimit' | 'perOwner'> = webExplanationLimits,
    private readonly beforeAutomaticStart?: (owner: string) => void) {
    for (const { owner, run } of this.storage.loadRuns())
      for (const { key, explanation } of this.storage.listExplanations(owner, run.id)) if (active(explanation)) {
        const now = new Date().toISOString();
        Object.assign(explanation, { status: 'error', reason: 'explanation_interrupted', updatedAt: now, finishedAt: now });
        delete explanation.queue;
        this.storage.saveExplanation(owner, key, explanation);
      }
  }

  counts() {
    const queued = [...this.jobs.values()].filter(job => job.explanation.status === 'queued');
    const oldestQueuedAt = queued.map(job => job.explanation.createdAt).sort()[0];
    return { running: this.running, queued: queued.length, ...(oldestQueuedAt ? { oldestQueuedAt } : {}) };
  }
  /** The run's explanations without their documents, newest state first from memory. */
  list(owner: string, runId: string): WebExplanation[] {
    return this.storage.listExplanations(owner, runId).map(({ key, explanation }) => {
      const job = this.jobs.get(this.id(owner, runId, key));
      const { document: _, ...summary } = job ? this.view(job) : explanation;
      return summary;
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  get(owner: string, runId: string, target: string, language: WebExplanationLanguage): WebExplanation | undefined {
    const key = explanationKey(target, language), job = this.jobs.get(this.id(owner, runId, key));
    if (job) return this.view(job);
    const stored = this.storage.getExplanation(owner, runId, key);
    if (!stored) return undefined;
    const { document: _, ...explanation } = stored;
    return explanation;
  }
  /**
   * One explanation for the page. An approved one carries its document, projected from the stored evidence after it is
   * verified again against the run's proof, so a change to the projection reaches old explanations without rewriting them.
   */
  read(owner: string, run: WebRun, target: string, language: WebExplanationLanguage): WebExplanation | undefined {
    const explanation = this.get(owner, run.id, target, language);
    if (explanation?.status !== 'approved' || !run.result) return explanation;
    const binding = { proof: run.result.proof, target, language, environment: run.environment };
    try {
      const { evidence } = verifyExplanationEvidence(this.storage.getExplanationEvidence(owner, run.id, explanationKey(target, language)), binding);
      return { ...explanation, document: explanationDocument(evidence, binding.proof) };
    } catch (error) {
      return { ...explanation, reason: reasonOf(error) };
    }
  }
  /** True while any explanation of the run is queued or generating; such a run cannot be deleted. */
  active(owner: string, runId: string): boolean {
    return [...this.jobs.values()].some(job => job.owner === owner && job.run.id === runId);
  }
  create(owner: string, run: WebRun, request: ExplanationRequest): WebExplanation {
    return this.enqueue(owner, run, request);
  }
  /** One solve reserves one admission slot; all original targets are saved now and execute in sequence. Credentials
   * stay only in these live inputs, including when the same frozen statement is still being reviewed. */
  createAutomatic(owner: string, run: WebRun, request: Omit<ExplanationRequest, 'target'> & { targets: string[] }): WebExplanation[] {
    const targets = [...new Set(request.targets)].filter(target => !this.get(owner, run.id, target, request.language));
    if (!targets.length) return this.list(owner, run.id);
    let failure: string | undefined;
    try { this.capacity(owner); }
    catch (error) { if (!(error instanceof WebStorageError)) throw error; failure = 'explanation_queue_full'; }
    if (!request.apiKey) failure = 'explanation_key_required';
    if (!isStatementReviewed(run) && run.formalization?.confirmation !== 'pending') failure = 'explanation_statement_unreviewed';
    for (const target of targets) {
      this.enqueue(owner, run, { ...request, target }, { automatic: true, failure });
    }
    return this.list(owner, run.id);
  }
  /** Statement review may finish after Lean acceptance. It releases the existing queue, without resubmitting work. */
  review(owner: string, run: WebRun) {
    const reviewed = isStatementReviewed(run);
    for (const job of [...this.jobs.values()]) {
      if (job.owner !== owner || job.run.id !== run.id || !job.explanation.automatic) continue;
      if (reviewed && job.waitingReview) {
        delete job.waitingReview;
        const now = new Date().toISOString();
        job.explanation.progress = { phase: 'queued', updatedAt: now }; job.explanation.updatedAt = now;
        this.persist(job, true);
      } else if (!reviewed && run.formalization?.confirmation !== 'pending') {
        try { this.finish(job, { status: 'cancelled', reason: 'explanation_statement_unreviewed' }); }
        finally { this.release(job); job.controller.abort(); }
      }
    }
    queueMicrotask(() => this.pump());
  }
  private capacity(owner: string) {
    if (this.closing) throw new WebStorageError(503, '服务正在停止，请稍后重试。');
    const jobs = [...this.jobs.values()];
    const groups = new Set(jobs.map(job => job.group));
    if (groups.size >= this.limits.queueLimit) throw new WebStorageError(429, `讲解队列已满：${groups.size} 项正在生成或排队，请稍后再试。`);
    if (new Set(jobs.filter(job => job.owner === owner).map(job => job.group)).size >= this.limits.perOwner)
      throw new WebStorageError(429, `每个账号最多同时生成 ${this.limits.perOwner} 项讲解，请等其中一项结束。`);
  }
  private enqueue(owner: string, run: WebRun, request: ExplanationRequest, automatic?: { automatic: true; failure?: string }): WebExplanation {
    const key = explanationKey(request.target, request.language), id = this.id(owner, run.id, key);
    const existingJob = this.jobs.get(id);
    const existing = existingJob?.explanation ?? this.storage.getExplanation(owner, run.id, key);
    if (existingJob && active(existingJob.explanation)) throw new WebStorageError(409, '这份讲解正在生成。');
    if (existing?.status === 'approved') throw new WebStorageError(409, '这份讲解已经生成；如需重新生成，请先删除它。');
    if (!automatic) this.capacity(owner);
    // A failed final save can leave orphaned evidence. A usable checkpoint survives an explicit retry.
    if (existing) this.storage.deleteExplanationEvidence(owner, run.id, key);
    const now = new Date().toISOString();
    const waitingReview = automatic && !isStatementReviewed(run);
    const explanation: WebExplanation = { id: crypto.randomUUID(), runId: run.id, target: request.target, language: request.language,
      status: 'queued', createdAt: now, updatedAt: now, model: request.model, effort: request.effort,
      ...(automatic ? { automatic: true } : {}),
      maxRunSeconds: webExplanationLimits.maxRunSeconds, maxTotalTokens: webExplanationLimits.maxTotalTokens,
      progress: { phase: waitingReview ? 'waiting_review' : 'queued', updatedAt: now } };
    if (automatic?.failure) {
      Object.assign(explanation, { status: 'error', reason: automatic.failure, finishedAt: now });
      delete explanation.progress;
      this.storage.saveExplanation(owner, key, explanation);
      return explanation;
    }
    const input: WorkerExplanationInput = { id: explanation.id, proof: run.result!.proof, target: request.target, language: request.language,
      environment: run.environment, model: request.model, effort: request.effort, apiKey: request.apiKey, provider: request.provider,
      maxRunSeconds: explanation.maxRunSeconds, maxTotalTokens: explanation.maxTotalTokens,
      maxRoundsPerBatch: webExplanationLimits.maxRoundsPerBatch, auditors: webExplanationLimits.auditors };
    const job: Job = { owner, key, run, explanation, input, controller: new AbortController(), persistedAt: 0,
      group: automatic ? this.id(owner, run.id, 'automatic') : id, ...(waitingReview ? { waitingReview: true } : {}) };
    this.jobs.set(id, job);
    try { this.persist(job, true); }
    catch (error) { this.release(job); throw error; }
    queueMicrotask(() => this.pump());
    return this.view(job);
  }
  cancel(owner: string, runId: string, target: string, language: WebExplanationLanguage): WebExplanation | undefined {
    const job = this.jobs.get(this.id(owner, runId, explanationKey(target, language)));
    if (!job) return this.storage.getExplanation(owner, runId, explanationKey(target, language));
    try { this.finish(job, { status: 'cancelled' }); }
    finally { this.release(job); job.controller.abort(); }
    return job.explanation;
  }
  /** Deletes a finished explanation and its evidence; a queued or generating one must be cancelled first. */
  remove(owner: string, runId: string, target: string, language: WebExplanationLanguage): 'deleted' | 'active' | 'missing' {
    const key = explanationKey(target, language);
    if (this.jobs.has(this.id(owner, runId, key))) return 'active';
    if (!this.storage.getExplanation(owner, runId, key)) return 'missing';
    this.storage.deleteExplanation(owner, runId, key);
    return 'deleted';
  }
  /** Stops the owner's jobs before their records are deleted, so nothing is written afterwards. */
  forget(owner: string) {
    for (const job of [...this.jobs.values()]) if (job.owner === owner) { this.release(job); job.controller.abort(); }
  }
  async close() {
    this.closing = true;
    let failure: unknown;
    for (const job of [...this.jobs.values()]) {
      try { this.finish(job, { status: 'error', reason: 'explanation_interrupted' }); }
      catch (error) { failure ??= error; }
      finally { this.release(job); job.controller.abort(); }
    }
    while (this.running) await new Promise(resolve => setTimeout(resolve, 25));
    if (failure) throw failure;
  }

  private id(owner: string, runId: string, key: string) { return `${mathDigest(owner)}/${runId}/${key}`; }
  private current(job: Job) { return this.jobs.get(this.id(job.owner, job.run.id, job.key)) === job; }
  private release(job: Job) {
    if (this.current(job)) this.jobs.delete(this.id(job.owner, job.run.id, job.key));
    job.input.apiKey = '';
    delete job.input.checkpoint;
  }
  /** Queue positions count every explanation generating or waiting before this one, across owners; never who they are. */
  private view(job: Job): WebExplanation {
    if (job.explanation.status !== 'queued' || job.waitingReview) return job.explanation;
    const queued = [...this.jobs.values()].filter(item => item.explanation.status === 'queued' && !item.waitingReview);
    const index = queued.indexOf(job);
    return { ...job.explanation, queue: { position: index + 1, ahead: this.running + index } };
  }
  private persist(job: Job, force = false) {
    if (!this.current(job)) return;
    const now = Date.now();
    if (!force && now - job.persistedAt < 5_000) return;
    job.persistedAt = now;
    this.storage.saveExplanation(job.owner, job.key, job.explanation);
  }
  private finish(job: Job, outcome: Pick<WebExplanation, 'status'> & Partial<Pick<WebExplanation, 'reason'>>) {
    if (!active(job.explanation) || !this.current(job)) return;
    const now = new Date().toISOString();
    Object.assign(job.explanation, outcome, { updatedAt: now, finishedAt: now });
    if (outcome.status === 'approved') delete job.explanation.progress;
    this.persist(job, true);
  }
  private pump() {
    while (!this.closing && this.running < this.limits.concurrency) {
      const jobs = [...this.jobs.values()];
      const job = jobs.find(item => item.explanation.status === 'queued' && !item.waitingReview
        && !jobs.some(other => other.group === item.group && other.explanation.status === 'running'));
      if (!job) break;
      this.running++;
      const now = new Date().toISOString();
      Object.assign(job.explanation, { status: 'running', updatedAt: now, progress: { phase: 'preparing', updatedAt: now } });
      void this.execute(job).finally(() => { this.running--; this.pump(); });
    }
  }
  private async execute(job: Job) {
    let result: Extract<WorkerExplanationMessage, { type: 'result' }> | undefined;
    let messageError: unknown;
    const handle = (message: WorkerExplanationMessage) => {
      if (messageError || !this.current(job) || !active(job.explanation)) return;
      try {
        if (message.type === 'result') { result = message; return; }
        const previous = job.explanation.progress, now = new Date().toISOString();
        const progress: WebExplanationProgress = { ...previous, ...message.progress, updatedAt: now };
        job.explanation.progress = progress; job.explanation.updatedAt = now;
        this.persist(job, previous?.phase !== progress.phase || previous?.approvedBatches !== progress.approvedBatches ||
          previous?.modelRequestFailures !== progress.modelRequestFailures);
      } catch (error) { messageError = error; job.controller.abort(); }
    };
    try {
      this.persist(job, true);
      if (!this.runner.explain) throw new Error('explanation_runtime_unavailable');
      if (job.explanation.automatic) this.beforeAutomaticStart?.(job.owner);
      const checkpointBinding = explanationCheckpointBinding(job.input);
      const saved = this.storage.getExplanationCheckpoint(job.owner, job.run.id, job.key);
      if (saved?.binding === checkpointBinding) job.input.checkpoint = saved.checkpoint;
      else if (saved) this.storage.deleteExplanationCheckpoint(job.owner, job.run.id, job.key);
      await this.runner.explain(job.input, handle, job.controller.signal);
      if (messageError) throw messageError;
      if (!this.current(job) || !active(job.explanation)) return;
      if (!result) throw new Error('explanation_worker_no_result');
      if (result.status !== 'approved') {
        if (result.status === 'error' && result.reason === informalizationRetryLimit && result.checkpoint) {
          this.storage.saveExplanationCheckpoint(job.owner, job.run.id, job.key, { binding: checkpointBinding, checkpoint: result.checkpoint });
        } else if (job.input.checkpoint && (result.status === 'exhausted' ||
          result.reason === 'informalization_audit_invalid' || result.reason === 'informalization_checkpoint_changed')) {
          this.storage.deleteExplanationCheckpoint(job.owner, job.run.id, job.key);
        }
        this.finish(job, { status: result.status, reason: result.reason });
        return;
      }
      const binding = { proof: job.input.proof, target: job.input.target, language: job.input.language, environment: job.input.environment };
      const { evidence } = verifyExplanationEvidence(result.evidence, binding);
      // The projection must work before approval; its document is not stored, read() projects it again.
      explanationDocument(evidence, binding.proof);
      this.storage.saveExplanationEvidence(job.owner, job.run.id, job.key, evidence);
      this.finish(job, { status: 'approved' });
      if (job.input.checkpoint) this.storage.deleteExplanationCheckpoint(job.owner, job.run.id, job.key);
    } catch (error) {
      try { this.finish(job, { status: 'error', reason: reasonOf(messageError ?? error) }); }
      catch { /* A failed final save is interrupted on restart or replaced on explicit retry. */ }
    } finally {
      this.release(job);
    }
  }
}
