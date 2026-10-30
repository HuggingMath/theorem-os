import crypto from 'node:crypto';
import { mathDigest } from '../../src/math/mathRuntimeIo';
import { webExplanationLimits } from './config';
import { explanationDocument, verifyExplanationEvidence } from './explanation';
import type { WebRunner } from './runner';
import type { WebExplanation, WebExplanationLanguage, WebExplanationProgress, WebProvider, WebRun, WorkerExplanationInput,
  WorkerExplanationMessage } from './shared';
import { webExplanationReason } from './shared';
import { WebStorage, WebStorageError } from './storage';

type Job = { owner: string; key: string; run: WebRun; explanation: WebExplanation; input: WorkerExplanationInput;
  controller: AbortController; persistedAt: number };
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
    private readonly limits: Pick<typeof webExplanationLimits, 'concurrency' | 'queueLimit' | 'perOwner'> = webExplanationLimits) {
    for (const { owner, run } of this.storage.loadRuns())
      for (const { key, explanation } of this.storage.listExplanations(owner, run.id)) if (active(explanation)) {
        const now = new Date().toISOString();
        Object.assign(explanation, { status: 'error', reason: 'explanation_interrupted', updatedAt: now, finishedAt: now });
        delete explanation.queue;
        this.storage.saveExplanation(owner, key, explanation);
      }
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
  create(owner: string, run: WebRun, request: { target: string; language: WebExplanationLanguage; apiKey: string; provider: WebProvider;
    model: string; effort: 'low' | 'high' | 'max' }): WebExplanation {
    if (this.closing) throw new WebStorageError(503, '服务正在停止，请稍后重试。');
    const key = explanationKey(request.target, request.language), id = this.id(owner, run.id, key);
    const existing = this.jobs.get(id)?.explanation ?? this.storage.getExplanation(owner, run.id, key);
    if (existing && active(existing)) throw new WebStorageError(409, '这份讲解正在生成。');
    if (existing?.status === 'approved') throw new WebStorageError(409, '这份讲解已经生成；如需重新生成，请先删除它。');
    const jobs = [...this.jobs.values()];
    if (jobs.length >= this.limits.queueLimit) throw new WebStorageError(429, `讲解队列已满：${jobs.length} 份正在生成或排队，请稍后再试。`);
    if (jobs.filter(job => job.owner === owner).length >= this.limits.perOwner)
      throw new WebStorageError(429, `每个账号最多同时生成 ${this.limits.perOwner} 份讲解，请等其中一份结束。`);
    // A failed or cancelled attempt is replaced by the new one; it never had evidence.
    if (existing) this.storage.deleteExplanation(owner, run.id, key);
    const now = new Date().toISOString();
    const explanation: WebExplanation = { id: crypto.randomUUID(), runId: run.id, target: request.target, language: request.language,
      status: 'queued', createdAt: now, updatedAt: now, model: request.model, effort: request.effort,
      maxRunSeconds: webExplanationLimits.maxRunSeconds, maxTotalTokens: webExplanationLimits.maxTotalTokens,
      progress: { phase: 'queued', updatedAt: now } };
    const input: WorkerExplanationInput = { id: explanation.id, proof: run.result!.proof, target: request.target, language: request.language,
      environment: run.environment, model: request.model, effort: request.effort, apiKey: request.apiKey, provider: request.provider,
      maxRunSeconds: explanation.maxRunSeconds, maxTotalTokens: explanation.maxTotalTokens,
      maxRoundsPerBatch: webExplanationLimits.maxRoundsPerBatch, auditors: webExplanationLimits.auditors };
    const job: Job = { owner, key, run, explanation, input, controller: new AbortController(), persistedAt: 0 };
    this.jobs.set(id, job);
    this.persist(job, true);
    queueMicrotask(() => this.pump());
    return this.view(job);
  }
  cancel(owner: string, runId: string, target: string, language: WebExplanationLanguage): WebExplanation | undefined {
    const job = this.jobs.get(this.id(owner, runId, explanationKey(target, language)));
    if (!job) return this.storage.getExplanation(owner, runId, explanationKey(target, language));
    this.finish(job, { status: 'cancelled' });
    this.release(job);
    job.controller.abort();
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
    for (const job of [...this.jobs.values()]) {
      this.finish(job, { status: 'error', reason: 'explanation_interrupted' });
      this.release(job); job.controller.abort();
    }
    while (this.running) await new Promise(resolve => setTimeout(resolve, 25));
  }

  private id(owner: string, runId: string, key: string) { return `${mathDigest(owner)}/${runId}/${key}`; }
  private current(job: Job) { return this.jobs.get(this.id(job.owner, job.run.id, job.key)) === job; }
  private release(job: Job) {
    if (this.current(job)) this.jobs.delete(this.id(job.owner, job.run.id, job.key));
    job.input.apiKey = '';
  }
  /** Queue positions count every explanation generating or waiting before this one, across owners; never who they are. */
  private view(job: Job): WebExplanation {
    if (job.explanation.status !== 'queued') return job.explanation;
    const queued = [...this.jobs.values()].filter(item => item.explanation.status === 'queued');
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
      const job = [...this.jobs.values()].find(item => item.explanation.status === 'queued');
      if (!job) break;
      this.running++;
      const now = new Date().toISOString();
      Object.assign(job.explanation, { status: 'running', updatedAt: now, progress: { phase: 'preparing', updatedAt: now } });
      this.persist(job, true);
      void this.execute(job).finally(() => { this.running--; this.pump(); });
    }
  }
  private async execute(job: Job) {
    let result: Extract<WorkerExplanationMessage, { type: 'result' }> | undefined;
    const handle = (message: WorkerExplanationMessage) => {
      if (!this.current(job) || !active(job.explanation)) return;
      if (message.type === 'result') { result = message; return; }
      const previous = job.explanation.progress, now = new Date().toISOString();
      const progress: WebExplanationProgress = { ...previous, ...message.progress, updatedAt: now };
      job.explanation.progress = progress; job.explanation.updatedAt = now;
      this.persist(job, previous?.phase !== progress.phase || previous?.approvedBatches !== progress.approvedBatches);
    };
    try {
      if (!this.runner.explain) throw new Error('explanation_runtime_unavailable');
      await this.runner.explain(job.input, handle, job.controller.signal);
      if (!this.current(job) || !active(job.explanation)) return;
      if (!result) throw new Error('explanation_worker_no_result');
      if (result.status !== 'approved') { this.finish(job, { status: result.status, reason: result.reason }); return; }
      const binding = { proof: job.input.proof, target: job.input.target, language: job.input.language, environment: job.input.environment };
      const { evidence } = verifyExplanationEvidence(result.evidence, binding);
      // The projection must work before approval; its document is not stored, read() projects it again.
      explanationDocument(evidence, binding.proof);
      this.storage.saveExplanationEvidence(job.owner, job.run.id, job.key, evidence);
      this.finish(job, { status: 'approved' });
    } catch (error) {
      this.finish(job, { status: 'error', reason: reasonOf(error) });
    } finally {
      this.release(job);
    }
  }
}
