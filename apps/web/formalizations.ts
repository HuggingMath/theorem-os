import crypto from 'node:crypto';
import { assertFormalizationEvidence, formalizationDigest, formalizationEvidenceSchema, type FormalizationEvidence } from '../../src/math/formalization';
import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { mathDigest } from '../../src/math/mathRuntimeIo';
import { webLimits } from './config';
import { formalizationReport } from './formalizationReport';
import { webFormalizationActivityLimits, webFormalizationDefaults, webFormalizationLimits, webFormalizationReason, webFormalizationTokenBudgets, type WebFormalization,
  type WebFormalizationActivity, type WebFormalizationRequest, type WorkerFormalizationInput, type WorkerFormalizationMessage } from './formalizationTypes';
import type { WebRunner } from './runner';
import type { WebProvider } from './shared';
import { WebStorage, WebStorageError } from './storage';

type Record = { owner: string; formalization: WebFormalization; evidenceSha256?: string; provider?: WebProvider };
type Job = { record: Record; input: WorkerFormalizationInput; controller: AbortController; persistedAt: number };
type StartResearch = (owner: string, formalization: WebFormalization, evidence: FormalizationEvidence, input: WorkerFormalizationInput) => string;
const active = (value: WebFormalization) => value.status === 'queued' || value.status === 'running';
const reasonOf = (error: unknown) => error instanceof Error && webFormalizationReason.test(error.message) ? error.message : 'formalization_failed';
const directory = (owner: string) => ['owners', mathDigest(owner), 'formalizations'];
const recordPath = (owner: string, id: string) => {
  if (!/^[a-f0-9-]{36}$/u.test(id)) throw new WebStorageError(404, '形式化任务不存在。');
  return [...directory(owner), id];
};

/** Bound evidence is checked on generation, reading, confirmation and handoff to research. */
export function verifyWebFormalizationEvidence(value: unknown, formalization: WebFormalization): FormalizationEvidence {
  const evidence = formalizationEvidenceSchema.parse(value);
  if (Buffer.byteLength(evidence.candidate.source) > webLimits.maxSourceBytes) throw new Error('formalization_source_too_large');
  assertFormalizationEvidence(evidence);
  const request = evidence.request, workflow = request.workflow;
  if (request.schema !== 'theorem-os.formalization-request.v3' || request.contextProtocol !== 'kernel-v2' ||
    request.fidelityPolicy !== 'task-preserving-v2' || request.problemId !== formalization.id || request.statement !== formalization.original ||
    request.statementSha256 !== mathDigest(formalization.original) || request.environment !== formalization.environment ||
    request.environmentDigest !== getLeanTaskEnvironment(formalization.environment).dependencyDigest ||
    request.model !== formalization.model || request.effort !== formalization.effort ||
    request.execution !== 'model' || evidence.execution !== 'model' || !evidence.modelInvoked ||
    request.maxRounds !== webFormalizationLimits.maxRounds || request.maxRunSeconds !== (formalization.maxRunSeconds ?? 1800) ||
    (formalization.maxTotalTokens === undefined ? !webFormalizationTokenBudgets.includes(request.maxTotalTokens)
      : request.maxTotalTokens !== formalization.maxTotalTokens) || !workflow ||
    workflow.maxPlanningRounds !== webFormalizationLimits.maxPlanningRounds || workflow.reviewers.length !== webFormalizationLimits.reviewers ||
    [workflow.planner, workflow.backtranslator, ...workflow.reviewers].some(role => role.model !== request.model ||
      role.effort !== request.effort || role.profile !== request.profile || role.executable !== request.executable))
    throw new Error('formalization_binding_mismatch');
  return evidence;
}

/** Credentials live only in queued inputs. Ended records belong to the session/account directory. */
export class WebFormalizations {
  private jobs = new Map<string, Job>();
  private running = 0;
  private closing = false;
  constructor(private readonly runner: WebRunner, private readonly storage: WebStorage,
    private readonly limits: Pick<typeof webFormalizationLimits, 'concurrency' | 'queueLimit' | 'perOwner' | 'recordsPerOwner'> = webFormalizationLimits,
    private readonly startResearch?: StartResearch) {
    for (const owner of storage.listRecords(['owners'])) for (const id of storage.listRecords(['owners', owner, 'formalizations'])) {
      const stored = storage.getRecord<Record>(['owners', owner, 'formalizations', id, 'record.json']);
      if (stored && active(stored.formalization)) {
        const now = new Date().toISOString();
        Object.assign(stored.formalization, { status: 'error', reason: 'formalization_interrupted', updatedAt: now, finishedAt: now });
        // The count is saved every few seconds; the stored entries are what it counted.
        const saved = storage.listRecords(['owners', owner, 'formalizations', id, 'activity']).filter(file => /^\d+\.json$/u.test(file)).length;
        if (saved > (stored.formalization.activity?.count ?? 0)) stored.formalization.activity = { ...stored.formalization.activity, count: saved };
        this.save(stored);
      }
      if (stored?.formalization.workflow === 'solve' && stored.formalization.status === 'confirmed'
        && !stored.formalization.runId && !stored.formalization.researchError) {
        stored.formalization.researchError = 'formalization_research_interrupted'; this.save(stored);
      }
    }
  }
  list(owner: string): WebFormalization[] {
    return this.storage.listRecords(directory(owner)).map(id => this.record(owner, id)!.formalization)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  counts() {
    const queued = [...this.jobs.values()].filter(job => job.record.formalization.status === 'queued');
    const oldestQueuedAt = queued.map(job => job.record.formalization.createdAt).sort()[0];
    return { running: this.running, queued: queued.length, ...(oldestQueuedAt ? { oldestQueuedAt } : {}) };
  }
  private record(owner: string, id: string): Record | undefined {
    return this.jobs.get(this.key(owner, id))?.record ?? this.storage.getRecord<Record>([...recordPath(owner, id), 'record.json']);
  }
  private required(owner: string, id: string) {
    const record = this.record(owner, id);
    if (!record || record.owner !== owner) throw new WebStorageError(404, '形式化任务不存在或不属于当前会话。');
    return record;
  }
  private evidence(record: Record) {
    try {
      const evidence = verifyWebFormalizationEvidence(this.storage.getRecord([...recordPath(record.owner, record.formalization.id), 'evidence.json']), record.formalization);
      if (formalizationDigest(evidence) !== record.evidenceSha256) throw new Error('formalization_evidence_changed');
      return evidence;
    } catch { throw new WebStorageError(409, '形式化证据无效或已改变，请重新生成。'); }
  }
  read(owner: string, id: string): WebFormalization {
    const record = this.required(owner, id), value = record.formalization;
    return value.status === 'review' || value.status === 'confirmed' ? { ...value, report: formalizationReport(this.evidence(record)) } : value;
  }
  /** What the formalization did after `after`, oldest first; only its owner reads it. */
  activity(owner: string, id: string, after: number) {
    const record = this.required(owner, id);
    return { activity: this.storage.listRecordsAfter<WebFormalizationActivity>([...recordPath(owner, id), 'activity'], after, webFormalizationActivityLimits.page),
      count: record.formalization.activity?.count ?? 0, dropped: record.formalization.activity?.dropped ?? 0 };
  }
  confirm(owner: string, id: string, sha256: string): WebFormalization {
    const record = this.required(owner, id);
    if (!['review', 'confirmed'].includes(record.formalization.status)) throw new WebStorageError(409, '请等待形式化完成并核对原意。');
    const evidence = this.evidence(record);
    if (sha256 !== formalizationDigest(evidence)) throw new WebStorageError(409, '确认内容已改变，请刷新并重新核对。');
    if (record.formalization.status !== 'confirmed') {
      const now = new Date().toISOString();
      Object.assign(record.formalization, { status: 'confirmed', confirmation: 'manual', confirmedAt: now, updatedAt: now });
      this.save(record);
    }
    return { ...record.formalization, report: formalizationReport(evidence) };
  }
  confirmed(owner: string, id: string): { formalization: WebFormalization; evidence: FormalizationEvidence } {
    const record = this.required(owner, id);
    if (record.formalization.status !== 'confirmed') throw new WebStorageError(409, '请先确认原题与 Lean 声明的对应关系。');
    const evidence = this.evidence(record);
    return { formalization: { ...record.formalization, report: formalizationReport(evidence) }, evidence };
  }
  /** Reuses the frozen statement after queue rejection or restart; it never calls the formalizer again. */
  retryResearch(owner: string, id: string, provider: WebProvider, apiKey: string): WebFormalization {
    const record = this.required(owner, id), item = record.formalization;
    if (item.runId) return this.read(owner, id);
    if (this.closing || !this.startResearch) throw new WebStorageError(503, '自动证明运行环境尚未就绪。');
    if (item.status !== 'confirmed' || item.workflow !== 'solve') throw new WebStorageError(409, '请先完成原题形式化与审核。');
    if (provider.id !== (item.providerId ?? 'sub2api') || record.provider && record.provider.baseUrl !== provider.baseUrl)
      throw new WebStorageError(409, '模型服务地址已改变，请创建新任务。');
    const evidence = this.evidence(record);
    const input: WorkerFormalizationInput = { id, original: item.original, environment: item.environment, model: item.model,
      effort: item.effort, apiKey, provider, maxRunSeconds: item.maxRunSeconds ?? 1800,
      maxTotalTokens: item.maxTotalTokens ?? evidence.request.maxTotalTokens,
      maxRounds: webFormalizationLimits.maxRounds, maxPlanningRounds: webFormalizationLimits.maxPlanningRounds, reviewers: webFormalizationLimits.reviewers };
    try {
      item.runId = this.startResearch(owner, item, evidence, input);
      delete item.researchError; item.updatedAt = new Date().toISOString(); this.save(record);
      return this.read(owner, id);
    } catch (error) {
      if (!item.runId) { item.researchError = 'formalization_research_queue_failed'; this.save(record); }
      throw error;
    } finally { input.apiKey = ''; }
  }
  create(owner: string, request: WebFormalizationRequest, provider: WebProvider, model: string): WebFormalization {
    if (this.closing) throw new WebStorageError(503, '服务正在停止，请稍后重试。');
    if (request.solve && !this.startResearch) throw new WebStorageError(503, '自动证明运行环境尚未就绪。');
    if (this.jobs.size >= this.limits.queueLimit) throw new WebStorageError(429, '形式化队列已满，请稍后重试。');
    if ([...this.jobs.values()].filter(job => job.record.owner === owner).length >= this.limits.perOwner)
      throw new WebStorageError(429, '已有形式化任务正在进行，请等待结束。');
    if (this.list(owner).length >= this.limits.recordsPerOwner) throw new WebStorageError(429, '形式化记录已满，请先删除不需要的记录。');
    const now = new Date().toISOString(), id = crypto.randomUUID();
    const formalization: WebFormalization = { id, original: request.original, environment: request.environment, model, providerId: provider.id,
      maxRunSeconds: request.maxRunSeconds ?? webFormalizationDefaults.maxRunSeconds,
      maxTotalTokens: request.maxTotalTokens ?? webFormalizationDefaults.maxTotalTokens,
      research: { ...webFormalizationDefaults.research, ...request.research },
      effort: request.effort, status: 'queued', createdAt: now, updatedAt: now, progress: { phase: 'queued', updatedAt: now },
      ...(request.solve ? { workflow: 'solve' } : {}) };
    const input: WorkerFormalizationInput = { original: request.original, environment: request.environment, effort: request.effort,
      apiKey: request.apiKey, id, model, provider, maxRunSeconds: formalization.maxRunSeconds!,
      maxTotalTokens: formalization.maxTotalTokens!, maxRounds: webFormalizationLimits.maxRounds,
      maxPlanningRounds: webFormalizationLimits.maxPlanningRounds, reviewers: webFormalizationLimits.reviewers };
    const job: Job = { record: { owner, formalization, provider: { ...provider } }, input, controller: new AbortController(), persistedAt: 0 };
    this.jobs.set(this.key(owner, id), job); this.persist(job, true);
    queueMicrotask(() => this.pump());
    return formalization;
  }
  cancel(owner: string, id: string): WebFormalization {
    const record = this.required(owner, id), job = this.jobs.get(this.key(owner, id));
    if (job) { this.finish(job, 'cancelled'); this.release(job); job.controller.abort(); this.pump(); }
    return record.formalization;
  }
  remove(owner: string, id: string) {
    const record = this.required(owner, id);
    if (active(record.formalization)) throw new WebStorageError(409, '请先取消进行中的形式化任务。');
    this.storage.deleteRecord(recordPath(owner, id));
  }
  forget(owner: string) {
    for (const job of [...this.jobs.values()]) if (job.record.owner === owner) { this.release(job); job.controller.abort(); }
  }
  async close() {
    this.closing = true;
    for (const job of [...this.jobs.values()]) { this.finish(job, 'error', 'formalization_interrupted'); this.release(job); job.controller.abort(); }
    while (this.running) await new Promise(resolve => setTimeout(resolve, 25));
  }
  private key(owner: string, id: string) { return `${mathDigest(owner)}/${id}`; }
  private current(job: Job) { return this.jobs.get(this.key(job.record.owner, job.record.formalization.id)) === job; }
  private save(record: Record) { this.storage.saveRecord([...recordPath(record.owner, record.formalization.id), 'record.json'], record); }
  private release(job: Job) { if (this.current(job)) this.jobs.delete(this.key(job.record.owner, job.record.formalization.id)); job.input.apiKey = ''; }
  private persist(job: Job, force = false) {
    if (!this.current(job) || !force && Date.now() - job.persistedAt < 5_000) return;
    job.persistedAt = Date.now(); this.save(job.record);
  }
  private finish(job: Job, status: WebFormalization['status'], reason?: string) {
    if (!this.current(job) || !active(job.record.formalization)) return;
    const now = new Date().toISOString();
    Object.assign(job.record.formalization, { status, updatedAt: now, finishedAt: now, ...(reason ? { reason } : {}) });
    this.persist(job, true);
  }
  private pump() {
    while (!this.closing && this.running < this.limits.concurrency) {
      const job = [...this.jobs.values()].find(item => item.record.formalization.status === 'queued');
      if (!job) break;
      this.running++;
      Object.assign(job.record.formalization, { status: 'running', progress: { phase: 'preparing', updatedAt: new Date().toISOString() } });
      this.persist(job, true);
      void this.execute(job).finally(() => { this.running--; this.pump(); });
    }
  }
  private async execute(job: Job) {
    let result: Extract<WorkerFormalizationMessage, { type: 'result' }> | undefined;
    try {
      if (!this.runner.formalize) throw new Error('formalization_runtime_unavailable');
      await this.runner.formalize(job.input, message => {
        if (!this.current(job) || !active(job.record.formalization)) return;
        if (message.type === 'result') { result = message; return; }
        if (message.type === 'activity') {
          // Past the per-record limit only the count grows, as with a run's actions.
          const tally = job.record.formalization.activity ??= { count: 0 };
          if (tally.count >= webFormalizationActivityLimits.perRecord) tally.dropped = (tally.dropped ?? 0) + 1;
          else {
            tally.count++;
            this.storage.saveRecord([...recordPath(job.record.owner, job.record.formalization.id), 'activity', `${tally.count}.json`],
              { ...message.activity, sequence: tally.count, at: new Date().toISOString() } satisfies WebFormalizationActivity, true);
          }
          this.persist(job);
          return;
        }
        const previous = job.record.formalization.progress, now = new Date().toISOString();
        job.record.formalization.progress = { ...message.progress, updatedAt: now }; job.record.formalization.updatedAt = now;
        this.persist(job, previous?.phase !== message.progress.phase);
      }, job.controller.signal);
      if (!this.current(job) || !active(job.record.formalization)) return;
      if (!result) throw new Error('formalization_worker_no_result');
      if (result.status !== 'approved') { this.finish(job, result.status, webFormalizationReason.test(result.reason) ? result.reason : 'formalization_failed'); return; }
      const evidence = verifyWebFormalizationEvidence(result.evidence, job.record.formalization);
      formalizationReport(evidence);
      this.storage.saveRecord([...recordPath(job.record.owner, job.record.formalization.id), 'evidence.json'], evidence, true);
      job.record.evidenceSha256 = formalizationDigest(evidence);
      if (job.record.formalization.workflow === 'solve') {
        Object.assign(job.record.formalization, { confirmation: 'automatic', confirmedAt: new Date().toISOString() });
        this.finish(job, 'confirmed');
        try { job.record.formalization.runId = this.startResearch!(job.record.owner, job.record.formalization, evidence, job.input); }
        catch { job.record.formalization.researchError = 'formalization_research_queue_failed'; }
        this.persist(job, true);
      } else this.finish(job, 'review');
    } catch (error) { this.finish(job, 'error', reasonOf(error)); }
    finally { this.release(job); }
  }
}
