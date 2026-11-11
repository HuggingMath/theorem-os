import type { WorkerFormalizationAuditInput } from './formalizationAuditTypes';
import crypto from 'node:crypto';
import { assertFormalizationCompiledCandidate, assertFormalizationEvidence, formalizationCompiledCandidate,
  formalizationCompiledCandidateDigest, formalizationCompiledCandidateSchema, formalizationDigest, formalizationEvidenceSchema,
  type FormalizationCompiledCandidate, type FormalizationEvidence, type FormalizationRequest } from '../../src/math/formalization';
import { assertFormalizationAuditResult } from '../../src/math/formalizationAudit';
import { reportedTotalTokens } from '../../src/solver/usageBudget';
import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { LEAN_STATEMENT_CONTEXT_PROTOCOL } from '../../src/math/leanStatementSemantic';
import { webLimits } from './config';
import { formalizationReport } from './formalizationReport';
import { webFormalizationActivityLimits, webFormalizationDefaults, webFormalizationLimits, webFormalizationReason, webFormalizationTokenBudgets, type WebFormalization,
  type WebFormalizationActivity, type WebFormalizationRequest, type WorkerFormalizationInput, type WorkerFormalizationMessage,
  type WorkerFormalizationAuditMessage } from './formalizationTypes';
import type { WebRunner } from './runner';
import type { WebProvider } from './shared';
import { WebStorage, WebStorageError, type WebCreation } from './storage';

type Record = { owner: string; formalization: WebFormalization; evidenceSha256?: string; provider?: WebProvider; creation?: WebCreation };
type Job = { record: Record; input: WorkerFormalizationInput; controller: AbortController; persistedAt: number };
type AuditJob = { record: Record; input: WorkerFormalizationAuditInput; controller: AbortController; deadline?: number };
type StartResearch = (owner: string, formalization: WebFormalization, evidence: FormalizationEvidence, input: WorkerFormalizationInput) => string;
type BackgroundResearch = {
  start(owner: string, formalization: WebFormalization, compiled: FormalizationCompiledCandidate, input: WorkerFormalizationInput): string;
  update(owner: string, runId: string, digest: string, confirmation: 'automatic' | 'rejected' | 'interrupted' | 'superseded',
    approved?: { evidenceSha256: string; confirmedAt: string; sourceSha256: string; environment: WebFormalization['environment'] }): void;
};
const active = (value: WebFormalization) => value.status === 'queued' || value.status === 'running';
const reviewing = (value: WebFormalization) => value.backgroundReview?.status === 'queued' || value.backgroundReview?.status === 'running';
const readableContextProtocols: readonly string[] = ['kernel-v2', LEAN_STATEMENT_CONTEXT_PROTOCOL];
const reasonOf = (error: unknown) => {
  if (!(error instanceof Error)) return 'formalization_failed';
  if (error.message.startsWith('formalization_coverage_invalid:')) return 'formalization_coverage_invalid';
  return webFormalizationReason.test(error.message) ? error.message : 'formalization_failed';
};
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
  verifyWebFormalizationRequest(evidence.request, formalization);
  if (evidence.execution !== 'model' || !evidence.modelInvoked ||
      (formalization.reviewMode === 'direct') !== (evidence.schema === 'theorem-os.formalization-evidence.v4'))
    throw new Error('formalization_binding_mismatch');
  return evidence;
}
export function verifyWebCompiledCandidate(value: unknown, formalization: WebFormalization): FormalizationCompiledCandidate {
  const compiled = formalizationCompiledCandidateSchema.parse(value);
  if (Buffer.byteLength(compiled.candidate.source) > webLimits.maxSourceBytes) throw new Error('formalization_source_too_large');
  assertFormalizationCompiledCandidate(compiled);
  verifyWebFormalizationRequest(compiled.request, formalization);
  return compiled;
}
function verifyWebFormalizationRequest(request: FormalizationRequest, formalization: WebFormalization): void {
  const workflow = request.workflow;
  const contextProtocol = formalization.contextProtocol ?? 'kernel-v2';
  if (request.schema !== 'theorem-os.formalization-request.v3' || request.contextProtocol !== contextProtocol ||
    !readableContextProtocols.includes(contextProtocol) ||
    request.reviewMode !== formalization.reviewMode || request.problemId !== formalization.id || request.statement !== formalization.original ||
    request.statementSha256 !== mathDigest(formalization.original) || request.environment !== formalization.environment ||
    request.environmentDigest !== getLeanTaskEnvironment(formalization.environment).dependencyDigest ||
    request.model !== formalization.model || request.effort !== formalization.effort ||
    request.execution !== 'model' ||
    request.maxRounds !== (formalization.maxRounds ?? 3) || request.maxRunSeconds !== (formalization.maxRunSeconds ?? 1800) ||
    (formalization.maxTotalTokens === undefined ? !webFormalizationTokenBudgets.includes(request.maxTotalTokens)
      : request.maxTotalTokens !== formalization.maxTotalTokens))
    throw new Error('formalization_binding_mismatch');
  if (formalization.reviewMode !== 'direct' && (request.fidelityPolicy !== 'task-preserving-v2' || !workflow ||
      workflow.maxPlanningRounds !== (formalization.maxPlanningRounds ?? 2) || workflow.reviewers.length !== webFormalizationLimits.reviewers ||
      [workflow.planner, workflow.backtranslator, ...workflow.reviewers].some(role => role.model !== request.model ||
        role.effort !== request.effort || role.profile !== request.profile || role.executable !== request.executable)))
    throw new Error('formalization_binding_mismatch');
}

/** Credentials live only in queued inputs. Ended records belong to the session/account directory. */
export class WebFormalizations {
  private jobs = new Map<string, Job>();
  private running = 0;
  private auditJobs = new Map<string, AuditJob>();
  private auditsRunning = 0;
  private closing = false;
  constructor(private readonly runner: WebRunner, private readonly storage: WebStorage,
    private readonly limits: Pick<typeof webFormalizationLimits, 'concurrency' | 'queueLimit' | 'perOwner' | 'recordsPerOwner'> = webFormalizationLimits,
    private readonly startResearch?: StartResearch, private readonly backgroundResearch?: BackgroundResearch) {
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
      if (stored && ['error', 'cancelled', 'exhausted'].includes(stored.formalization.status)) this.updateResearch(stored, 'interrupted');
      if (stored?.formalization.workflow === 'solve' && !stored.formalization.humanReview && stored.formalization.status === 'confirmed'
        && !stored.formalization.runId && !stored.formalization.researchError) {
        stored.formalization.researchError = 'formalization_research_interrupted'; this.save(stored);
      }
      if (stored && reviewing(stored.formalization)) {
        Object.assign(stored.formalization.backgroundReview!, { status: 'interrupted',
          reason: 'formalization_audit_interrupted', finishedAt: new Date().toISOString() });
        this.save(stored);
      }
    }
  }
  list(owner: string): WebFormalization[] {
    // A crash before the first atomic record rename may leave only the task directory and a temporary file.
    return this.storage.listRecords(directory(owner)).flatMap(id => {
      const record = this.record(owner, id);
      return record ? [this.view(record.formalization)] : [];
    })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  counts() {
    const queued = [...this.jobs.values()].filter(job => job.record.formalization.status === 'queued');
    const auditQueued = [...this.auditJobs.values()].filter(job => job.record.formalization.backgroundReview?.status === 'queued');
    const oldestQueuedAt = [...queued.map(job => job.record.formalization.createdAt),
      ...auditQueued.map(job => job.record.formalization.backgroundReview!.queuedAt)].sort()[0];
    return { running: this.running + this.auditsRunning, queued: queued.length + auditQueued.length,
      ...(oldestQueuedAt ? { oldestQueuedAt } : {}) };
  }
  private view(value: WebFormalization): WebFormalization {
    if (value.status !== 'queued') return value;
    const waiting = [...this.jobs.values()].filter(job => job.record.formalization.status === 'queued');
    const index = waiting.findIndex(job => job.record.formalization.id === value.id);
    return index < 0 ? value : { ...value, queue: { position: index + 1, ahead: index,
      running: this.running, slots: this.limits.concurrency } };
  }
  private record(owner: string, id: string): Record | undefined {
    return this.jobs.get(this.key(owner, id))?.record ?? this.auditJobs.get(this.key(owner, id))?.record
      ?? this.storage.getRecord<Record>([...recordPath(owner, id), 'record.json']);
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
    if (value.compiled) this.compiled(record);
    return value.status === 'review' || value.status === 'confirmed' ? this.withReport(record) : this.view(value);
  }
  private withReport(record: Record) {
    const evidence = this.evidence(record), value = record.formalization;
    let backgroundReview = value.backgroundReview;
    if (backgroundReview?.result) {
      try {
        if (evidence.schema !== 'theorem-os.formalization-evidence.v4') throw new Error('formalization_audit_binding_mismatch');
        assertFormalizationAuditResult(evidence, backgroundReview.result);
        if (backgroundReview.evidenceSha256 !== record.evidenceSha256 || backgroundReview.sourceSha256 !== evidence.sourceSha256 ||
            backgroundReview.status !== backgroundReview.result.review.verdict || backgroundReview.result.model !== value.model ||
            backgroundReview.result.effort !== value.effort || formalizationDigest(backgroundReview.result) !== formalizationDigest(
              this.storage.getRecord([...recordPath(record.owner, value.id), 'audit.json'])))
          throw new Error('formalization_audit_binding_mismatch');
      } catch {
        backgroundReview = { ...backgroundReview, status: 'error', reason: 'formalization_audit_evidence_changed' };
        delete backgroundReview.result;
      }
    }
    return { ...value, ...(backgroundReview ? { backgroundReview } : {}),
      report: { ...formalizationReport(evidence), ...(backgroundReview ? { backgroundReview } : {}) } };
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
    return this.withReport(record);
  }
  confirmed(owner: string, id: string): { formalization: WebFormalization; evidence: FormalizationEvidence } {
    const record = this.required(owner, id);
    if (record.formalization.status !== 'confirmed') throw new WebStorageError(409, '请先确认原题与 Lean 声明的对应关系。');
    const evidence = this.evidence(record);
    return { formalization: this.withReport(record), evidence };
  }
  /** Starts or retries research from confirmed frozen evidence; it never calls the formalizer again. */
  retryResearch(owner: string, id: string, provider: WebProvider, apiKey: string): WebFormalization {
    const record = this.required(owner, id), item = record.formalization;
    if (item.runId) return this.read(owner, id);
    if (this.closing || !this.startResearch) throw new WebStorageError(503, '自动证明运行环境尚未就绪。');
    if (item.status !== 'confirmed' || item.workflow !== 'solve') throw new WebStorageError(409, '请先完成原题形式化。');
    if (provider.id !== (item.providerId ?? 'sub2api') || record.provider && record.provider.baseUrl !== provider.baseUrl)
      throw new WebStorageError(409, '模型服务地址已改变，请创建新任务。');
    const evidence = this.evidence(record);
    const input: WorkerFormalizationInput = { id, original: item.original, environment: item.environment, model: item.model,
      effort: item.effort, apiKey, provider, maxRunSeconds: item.maxRunSeconds ?? 1800,
      contextProtocol: evidence.request.contextProtocol,
      ...(item.reviewMode ? { reviewMode: item.reviewMode } : {}),
      maxTotalTokens: item.maxTotalTokens ?? evidence.request.maxTotalTokens,
      maxRounds: item.maxRounds ?? evidence.request.maxRounds,
      maxPlanningRounds: item.maxPlanningRounds ?? evidence.request.workflow?.maxPlanningRounds ?? 0,
      reviewers: webFormalizationLimits.reviewers };
    try {
      item.runId = this.startResearch(owner, item, evidence, input);
      delete item.researchError; item.updatedAt = new Date().toISOString(); this.save(record);
      return this.read(owner, id);
    } catch (error) {
      if (!item.runId) { item.researchError = 'formalization_research_queue_failed'; this.save(record); }
      throw error;
    } finally { input.apiKey = ''; }
  }
  private creation(request: WebFormalizationRequest, provider: WebProvider, model: string): WebCreation | undefined {
    if (!request.requestId) return;
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(request.requestId)) throw new WebStorageError(400, '提交请求标识无效。');
    return { schema: 'theorem-os.web-creation.v1', requestId: request.requestId, digest: mathDigest(canonicalMathJson({
      original: request.original, environment: request.environment, effort: request.effort, model,
      ...(request.researchEffort && request.researchEffort !== request.effort ? { researchEffort: request.researchEffort } : {}),
      provider: { id: provider.id, baseUrl: provider.baseUrl }, solve: Boolean(request.solve), humanReview: Boolean(request.humanReview),
      maxRunSeconds: request.maxRunSeconds ?? webFormalizationDefaults.maxRunSeconds,
      maxTotalTokens: request.maxTotalTokens ?? webFormalizationDefaults.maxTotalTokens,
      research: { ...webFormalizationDefaults.research, ...request.research },
    })) };
  }
  /** A receipt can be recovered before readiness, credentials, queue or quota admission. */
  replay(owner: string, request: WebFormalizationRequest, provider: WebProvider, model: string): WebFormalization | undefined {
    const expected = this.creation(request, provider, model);
    if (!expected) return;
    const record = this.storage.listRecords(directory(owner)).map(id => this.record(owner, id))
      .find(item => item?.owner === owner && item.creation?.requestId === expected.requestId);
    const previous = record?.creation ?? this.storage.getRecord<WebCreation>(['owners', mathDigest(owner), 'deleted-formalization-requests', `${mathDigest(expected.requestId)}.json`]);
    if (!previous) return;
    if (previous.digest !== expected.digest) throw new WebStorageError(409, '同一提交请求不能使用不同的题目或配置。');
    if (!record) throw new WebStorageError(410, '这次提交对应的形式化已删除，请发起新研究。');
    return this.read(owner, record.formalization.id);
  }
  create(owner: string, request: WebFormalizationRequest, provider: WebProvider, model: string): WebFormalization {
    const previous = this.replay(owner, request, provider, model);
    if (previous) return previous;
    if (this.closing) throw new WebStorageError(503, '服务正在停止，请稍后重试。');
    if (request.humanReview && !request.solve) throw new WebStorageError(400, '人工审核模式需要启用证明研究。');
    if (request.solve && !this.startResearch) throw new WebStorageError(503, '自动证明运行环境尚未就绪。');
    if (this.jobs.size >= this.limits.queueLimit) throw new WebStorageError(429, '形式化队列已满，请稍后重试。');
    if ([...this.jobs.values()].filter(job => job.record.owner === owner).length >= this.limits.perOwner)
      throw new WebStorageError(429, '当前账号的形式化队列已满，请等待已有任务结束。');
    if (this.list(owner).length >= this.limits.recordsPerOwner) throw new WebStorageError(429, '形式化记录已满，请先删除不需要的记录。');
    const now = new Date().toISOString(), id = crypto.randomUUID();
    const formalization: WebFormalization = { id, original: request.original, environment: request.environment, model, providerId: provider.id,
      contextProtocol: LEAN_STATEMENT_CONTEXT_PROTOCOL,
      reviewMode: 'direct',
      maxRunSeconds: request.maxRunSeconds ?? webFormalizationDefaults.maxRunSeconds,
      maxTotalTokens: request.maxTotalTokens ?? webFormalizationDefaults.maxTotalTokens,
      maxRounds: 0, maxPlanningRounds: 0,
      research: { ...webFormalizationDefaults.research, ...request.research },
      researchEffort: request.researchEffort ?? request.effort,
      effort: request.effort, status: 'queued', createdAt: now, updatedAt: now, progress: { phase: 'queued', updatedAt: now },
      ...(request.solve ? { workflow: 'solve' } : {}), ...(request.humanReview ? { humanReview: true } : {}) };
    const input: WorkerFormalizationInput = { original: request.original, environment: request.environment, effort: request.effort,
      contextProtocol: formalization.contextProtocol,
      reviewMode: formalization.reviewMode,
      apiKey: request.apiKey, id, model, provider, maxRunSeconds: formalization.maxRunSeconds!,
      maxTotalTokens: formalization.maxTotalTokens!, maxRounds: formalization.maxRounds!,
      maxPlanningRounds: formalization.maxPlanningRounds!, reviewers: webFormalizationLimits.reviewers };
    const creation = this.creation(request, provider, model);
    const job: Job = { record: { owner, formalization, provider: { ...provider }, ...(creation ? { creation } : {}) }, input, controller: new AbortController(), persistedAt: 0 };
    this.jobs.set(this.key(owner, id), job);
    try { this.persist(job, true); }
    catch (error) { this.release(job); throw error; }
    queueMicrotask(() => this.pump());
    return this.view(formalization);
  }
  cancel(owner: string, id: string): WebFormalization {
    const record = this.required(owner, id), job = this.jobs.get(this.key(owner, id));
    if (job) {
      try { this.finish(job, 'cancelled'); }
      finally { this.release(job); job.controller.abort(); this.pump(); }
    } else if (active(record.formalization)) {
      // A failed terminal save can leave an active record after its worker has already stopped.
      const now = new Date().toISOString();
      Object.assign(record.formalization, { status: 'cancelled', updatedAt: now, finishedAt: now });
      this.save(record);
    }
    const audit = this.auditJobs.get(this.key(owner, id));
    if (audit) this.stopAudit(audit, 'cancelled');
    return record.formalization;
  }
  remove(owner: string, id: string) {
    const record = this.required(owner, id);
    if (active(record.formalization)) throw new WebStorageError(409, '请先取消进行中的形式化任务。');
    if (record.creation) this.storage.saveRecord(['owners', mathDigest(owner), 'deleted-formalization-requests', `${mathDigest(record.creation.requestId)}.json`], record.creation, true);
    const audit = this.auditJobs.get(this.key(owner, id));
    if (audit) this.stopAudit(audit, 'cancelled');
    this.storage.deleteRecord(recordPath(owner, id));
  }
  forget(owner: string) {
    for (const job of [...this.jobs.values()]) if (job.record.owner === owner) { this.release(job); job.controller.abort(); }
    for (const job of [...this.auditJobs.values()]) if (job.record.owner === owner) this.stopAudit(job, 'cancelled');
  }
  async close() {
    this.closing = true;
    let failure: unknown;
    for (const job of [...this.jobs.values()]) {
      try { this.finish(job, 'error', 'formalization_interrupted'); }
      catch (error) { failure ??= error; }
      finally { this.release(job); job.controller.abort(); }
    }
    for (const job of [...this.auditJobs.values()]) {
      try { this.stopAudit(job, 'interrupted', 'formalization_audit_interrupted'); }
      catch (error) { failure ??= error; }
    }
    while (this.running || this.auditsRunning) await new Promise(resolve => setTimeout(resolve, 25));
    if (failure) throw failure;
  }
  private key(owner: string, id: string) { return `${mathDigest(owner)}/${id}`; }
  private compiled(record: Record) {
    const metadata = record.formalization.compiled;
    if (!metadata) return;
    const candidate = verifyWebCompiledCandidate(this.storage.getRecord([
      ...recordPath(record.owner, record.formalization.id), 'compiled', `${metadata.digest}.json`]), record.formalization);
    if (formalizationCompiledCandidateDigest(candidate) !== metadata.digest || metadata.source !== candidate.candidate.source ||
        metadata.sourceSha256 !== candidate.sourceSha256) throw new Error('formalization_binding_mismatch');
    return candidate;
  }
  private updateResearch(record: Record, confirmation: Parameters<BackgroundResearch['update']>[3],
    approved?: Parameters<BackgroundResearch['update']>[4]) {
    const item = record.formalization;
    if (item.runId && item.compiled) this.backgroundResearch?.update(record.owner, item.runId, item.compiled.digest, confirmation, approved);
  }
  private publishCompiled(job: Job, value: unknown) {
    const candidate = verifyWebCompiledCandidate(value, job.record.formalization);
    const digest = formalizationCompiledCandidateDigest(candidate), item = job.record.formalization;
    if (item.compiled?.digest !== digest) {
      this.updateResearch(job.record, 'superseded');
      delete item.runId; delete item.researchError;
      this.storage.saveRecord([...recordPath(job.record.owner, item.id), 'compiled', `${digest}.json`], candidate, true);
      item.compiled = { digest, source: candidate.candidate.source, sourceSha256: candidate.sourceSha256, round: candidate.round };
      this.persist(job, true);
    } else this.compiled(job.record);
    if (item.workflow === 'solve' && !item.humanReview && !item.runId && this.backgroundResearch) {
      try { item.runId = this.backgroundResearch.start(job.record.owner, item, candidate, job.input); delete item.researchError; }
      catch { item.researchError = 'formalization_research_queue_failed'; }
      this.persist(job, true);
    }
  }
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
    if (['cancelled', 'error', 'exhausted'].includes(status)) this.updateResearch(job.record, 'interrupted');
  }
  private queueAudit(job: Job, evidence: FormalizationEvidence) {
    if (evidence.schema !== 'theorem-os.formalization-evidence.v4') return;
    const value = job.record.formalization, now = new Date().toISOString();
    value.backgroundReview = { status: 'queued', evidenceSha256: formalizationDigest(evidence),
      sourceSha256: evidence.sourceSha256, queuedAt: now, tokens: 0 };
    const fail = (reason: string) => {
      Object.assign(value.backgroundReview!, { status: 'error', reason, finishedAt: now }); this.save(job.record);
    };
    if (!this.runner.auditFormalization) { fail('formalization_audit_runtime_unavailable'); return; }
    if (this.auditJobs.size >= this.limits.queueLimit) { fail('formalization_audit_queue_full'); return; }
    const usage = evidence.sessions.map(session => reportedTotalTokens(session.usage));
    if (job.input.maxTotalTokens > 0 && usage.some(tokens => tokens === null)) {
      fail('formalization_usage_missing'); return;
    }
    const used = Math.max(value.progress?.tokens ?? 0, usage.reduce<number>((sum, tokens) => sum + (tokens ?? 0), 0));
    const maxTotalTokens = job.input.maxTotalTokens > 0 ? job.input.maxTotalTokens - used : 0;
    if (job.input.maxTotalTokens > 0 && maxTotalTokens <= 0) { fail('formalization_token_limit'); return; }
    const deadline = job.input.maxRunSeconds > 0 ? Date.parse(value.createdAt) + job.input.maxRunSeconds * 1_000 : undefined;
    if (deadline !== undefined && deadline <= Date.now()) { fail('formalization_time_limit'); return; }
    const input: WorkerFormalizationAuditInput = { operation: 'audit', id: value.id, original: value.original,
      environment: value.environment, model: value.model, effort: value.effort, provider: job.input.provider,
      apiKey: job.input.apiKey, evidence, maxTotalTokens, maxRunSeconds: 0 };
    this.auditJobs.set(this.key(job.record.owner, value.id), { record: job.record, input, controller: new AbortController(), deadline });
    this.save(job.record);
    queueMicrotask(() => this.pumpAudits());
  }
  private currentAudit(job: AuditJob) {
    return this.auditJobs.get(this.key(job.record.owner, job.record.formalization.id)) === job;
  }
  private releaseAudit(job: AuditJob) {
    if (this.currentAudit(job)) this.auditJobs.delete(this.key(job.record.owner, job.record.formalization.id));
    job.input.apiKey = '';
  }
  private stopAudit(job: AuditJob, status: 'error' | 'cancelled' | 'interrupted', reason?: string) {
    if (!this.currentAudit(job)) return;
    const now = new Date().toISOString();
    Object.assign(job.record.formalization.backgroundReview!, { status, finishedAt: now, ...(reason ? { reason } : {}) });
    job.record.formalization.updatedAt = now;
    try { this.save(job.record); }
    finally { this.releaseAudit(job); job.controller.abort(); queueMicrotask(() => this.pumpAudits()); }
  }
  private pumpAudits() {
    // Review has its own slot. It cannot occupy a generation slot or hold up proof handoff.
    while (!this.closing && this.auditsRunning < 1) {
      const job = [...this.auditJobs.values()].find(value => value.record.formalization.backgroundReview?.status === 'queued');
      if (!job) break;
      if (job.deadline !== undefined && job.deadline <= Date.now()) {
        this.stopAudit(job, 'error', 'formalization_time_limit'); continue;
      }
      const now = new Date().toISOString();
      Object.assign(job.record.formalization.backgroundReview!, { status: 'running', startedAt: now });
      job.record.formalization.updatedAt = now; this.save(job.record);
      this.auditsRunning++;
      void this.executeAudit(job).finally(() => { this.auditsRunning--; this.pumpAudits(); });
    }
  }
  private async executeAudit(job: AuditJob) {
    let result: Extract<WorkerFormalizationAuditMessage, { type: 'audit-result' | 'audit-error' }> | undefined;
    const timer = job.deadline === undefined ? undefined : setTimeout(() => this.stopAudit(job, 'error', 'formalization_time_limit'),
      Math.max(0, job.deadline - Date.now()));
    if (job.deadline !== undefined) job.input.maxRunSeconds = Math.max(1, Math.ceil((job.deadline - Date.now()) / 1_000));
    try {
      await this.runner.auditFormalization!(job.input, message => {
        if (!this.currentAudit(job)) return;
        if (message.type !== 'audit-progress') { result ??= message; return; }
        job.record.formalization.backgroundReview!.tokens = message.tokens;
        job.record.formalization.updatedAt = new Date().toISOString(); this.save(job.record);
      }, job.controller.signal);
      if (!this.currentAudit(job)) return;
      if (!result) throw new Error('formalization_audit_no_result');
      if (result.type === 'audit-error') throw new Error(result.reason);
      // Audit failure never invalidates the compiled artifact or an already running proof.
      const evidence = this.evidence(job.record);
      if (evidence.schema !== 'theorem-os.formalization-evidence.v4') throw new Error('formalization_audit_binding_mismatch');
      assertFormalizationAuditResult(evidence, result.result);
      if (result.result.model !== job.input.model || result.result.effort !== job.input.effort)
        throw new Error('formalization_audit_binding_mismatch');
      const now = new Date().toISOString();
      this.storage.saveRecord([...recordPath(job.record.owner, job.record.formalization.id), 'audit.json'], result.result, true);
      Object.assign(job.record.formalization.backgroundReview!, { status: result.result.review.verdict, result: result.result, finishedAt: now });
      job.record.formalization.updatedAt = now;
      this.save(job.record);
    } catch (error) {
      if (this.currentAudit(job)) this.stopAudit(job, 'error', reasonOf(error));
    } finally { clearTimeout(timer); this.releaseAudit(job); }
  }
  private pump() {
    while (!this.closing && this.running < this.limits.concurrency) {
      const job = [...this.jobs.values()].find(item => item.record.formalization.status === 'queued');
      if (!job) break;
      this.running++;
      Object.assign(job.record.formalization, { status: 'running', progress: { phase: 'preparing', updatedAt: new Date().toISOString() } });
      void this.execute(job).finally(() => { this.running--; this.pump(); });
    }
  }
  private async execute(job: Job) {
    let result: Extract<WorkerFormalizationMessage, { type: 'result' }> | undefined;
    let messageError: unknown;
    try {
      this.persist(job, true);
      if (!this.runner.formalize) throw new Error('formalization_runtime_unavailable');
      await this.runner.formalize(job.input, message => {
        if (messageError || !this.current(job) || !active(job.record.formalization)) return;
        try {
          if (message.type === 'result') { result = message; return; }
          if (message.type === 'compiled') { this.publishCompiled(job, message.candidate); return; }
          if (message.type === 'activity') {
            if (message.activity.type === 'step' && message.activity.step.step === 'revision' &&
                message.activity.step.stage === 'round' && message.activity.step.text.startsWith('formalization_semantic_changes_requested:'))
              this.updateResearch(job.record, 'rejected');
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
        } catch (error) { messageError = error; job.controller.abort(); }
      }, job.controller.signal);
      if (messageError) throw messageError;
      if (!this.current(job) || !active(job.record.formalization)) return;
      if (!result) throw new Error('formalization_worker_no_result');
      if (result.status !== 'approved') { this.finish(job, result.status, webFormalizationReason.test(result.reason) ? result.reason : 'formalization_failed'); return; }
      const evidence = verifyWebFormalizationEvidence(result.evidence, job.record.formalization);
      if (job.record.formalization.compiled && formalizationCompiledCandidateDigest(formalizationCompiledCandidate(evidence)) !==
          job.record.formalization.compiled.digest) throw new Error('formalization_candidate_changed_after_compilation');
      formalizationReport(evidence);
      this.storage.saveRecord([...recordPath(job.record.owner, job.record.formalization.id), 'evidence.json'], evidence, true);
      job.record.evidenceSha256 = formalizationDigest(evidence);
      if (job.record.formalization.workflow === 'solve' && !job.record.formalization.humanReview) {
        Object.assign(job.record.formalization, { confirmation: 'automatic', confirmedAt: new Date().toISOString() });
        if (job.record.formalization.runId && job.record.formalization.compiled) {
          this.updateResearch(job.record, 'automatic', { evidenceSha256: job.record.evidenceSha256,
            confirmedAt: job.record.formalization.confirmedAt!, sourceSha256: evidence.sourceSha256, environment: evidence.request.environment });
        }
        this.finish(job, 'confirmed');
        try {
          job.record.formalization.runId ??= this.startResearch!(job.record.owner, job.record.formalization, evidence, job.input);
          delete job.record.formalization.researchError;
        }
        catch { job.record.formalization.researchError = 'formalization_research_queue_failed'; }
        this.persist(job, true);
      } else this.finish(job, 'review');
      this.queueAudit(job, evidence);
    } catch (error) {
      try { this.finish(job, 'error', reasonOf(messageError ?? error)); }
      catch { /* A failed final save is interrupted on restart; the worker still releases its slot and key. */ }
    }
    finally { this.release(job); }
  }
}
