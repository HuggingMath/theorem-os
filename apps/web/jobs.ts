import crypto from 'node:crypto';
import type { WebConfig } from './config';
import type { WebRunner } from './runner';
import type { WebEvent, WebEventDetails, WebProvider, WebRun, WebRunInput, WorkerInput, WorkerMessage } from './shared';
import { isProgressEvent, parseWebFailure, webAgentActionLimits, webLimits } from './shared';
import { recordWebModuleEvent, sanitizeWebEventDetails } from './moduleTelemetry';
import type { WebCommand, WebCommandResult, WebObservation } from './collaboration';
import { canonicalMathJson } from '../../src/math/mathRuntimeIo';
import { WebStorage, type WebCreation } from './storage';
import { WebKnowledgeService } from './knowledgeService';
import { freezeModuleConfiguration } from './moduleRegistry';
import { WebStorageError } from './storage';
import { isAcceptedRun, isStatementReviewed } from './presentation';

type Job = { owner: string; run: WebRun; input: WebRunInput; provider: WebProvider; controller: AbortController;
  formalization?: WorkerInput['formalization'];
  compiledFormalization?: WorkerInput['compiledFormalization'];
  researchConfiguration?: WorkerInput['researchConfiguration'];
  continuation?: WorkerInput['continuation'] };
const terminal = (run: WebRun) => ['completed', 'cancelled', 'error'].includes(run.status);
const clean = <T>(value: T, key: string): T => JSON.parse(key ? JSON.stringify(value).replaceAll(
  JSON.stringify(key).slice(1, -1), '[REDACTED]') : JSON.stringify(value));

export class WebJobs {
  private jobs = new Map<string, Job>();
  private creations = new Map<string, WebCreation & { runId: string }>();
  private running = 0;
  private closing = false;
  private closeError?: unknown;
  private commands = new Map<string, { digest: string; promise: Promise<WebCommandResult> }>();
  private readonly versionId = crypto.randomUUID();
  private revisions = new Map<string, number>();
  private listeners = new Map<string, Set<(version: string) => void>>();
  private pendingNotifications = new Set<string>();
  /** Runs whose action count changed since they were last saved; see actionsChanged. */
  private pendingActions = new Map<string, ReturnType<typeof setTimeout>>();
  readonly storage: WebStorage;
  readonly knowledge: WebKnowledgeService;
  private readonly onAccepted?: (owner: string) => void;
  private readonly onFinished?: (owner: string, run: WebRun) => void;
  private readonly onPlanWaiting?: (owner: string, run: WebRun) => void;
  private readonly onProofAccepted?: (owner: string, run: WebRun, credentials: { apiKey: string; provider: WebProvider }) => void;
  private readonly onStatementReview?: (owner: string, run: WebRun) => void;
  constructor(private readonly runner: WebRunner, private readonly config: Pick<WebConfig, 'concurrency' | 'queueLimit'>,
    options: { storage?: WebStorage; knowledge?: WebKnowledgeService; onAccepted?: (owner: string) => void;
      onFinished?: (owner: string, run: WebRun) => void; onPlanWaiting?: (owner: string, run: WebRun) => void;
      onProofAccepted?: WebJobs['onProofAccepted']; onStatementReview?: WebJobs['onStatementReview'] } = {}) {
    this.onAccepted = options.onAccepted;
    this.onFinished = options.onFinished;
    this.onPlanWaiting = options.onPlanWaiting;
    this.onProofAccepted = options.onProofAccepted;
    this.onStatementReview = options.onStatementReview;
    this.storage = options.storage ?? new WebStorage();
    this.knowledge = options.knowledge ?? new WebKnowledgeService(this.storage);
    for (const { owner, run, creation } of this.storage.loadRuns()) {
      if (creation) this.creations.set(JSON.stringify([owner, creation.requestId]), { ...creation, runId: run.id });
      const provider: WebProvider = { id: run.providerId, name: run.providerId, baseUrl: '' };
      this.jobs.set(run.id, { owner, run, provider, input: { ...run, apiKey: '' }, controller: new AbortController() });
      if (!terminal(run)) {
        run.status = 'error'; run.phase = 'interrupted'; run.finishedAt = new Date().toISOString();
        run.error = '服务已重启；保留最后观测与已有证据。本次运行未恢复执行。';
        run.failure = { kind: 'interrupted' };
        delete run.queue;
        this.event(run, 'interrupted', run.error);
      } else if (run.phase === 'interrupted' && !run.failure) run.failure = { kind: 'interrupted' };
    }
  }

  counts() {
    const queued = [...this.jobs.values()].filter(job => job.run.status === 'queued');
    const oldestQueuedAt = queued.map(job => job.run.createdAt).sort()[0];
    return { running: this.running, queued: queued.length, ...(oldestQueuedAt ? { oldestQueuedAt } : {}) };
  }
  list(owner: string): WebRun[] {
    return [...this.jobs.values()].filter(job => job.owner === owner).map(job => job.run).reverse();
  }
  get(owner: string, id: string): WebRun | undefined {
    const job = this.jobs.get(id);
    return job?.owner === owner ? job.run : undefined;
  }
  version(owner: string): string {
    const identity = `${this.versionId}/${owner}/${this.revisions.get(owner) ?? 0}`;
    return `"${crypto.createHash('sha256').update(identity).digest('hex')}"`;
  }
  subscribe(owner: string, listener: (version: string) => void): () => void {
    let listeners = this.listeners.get(owner);
    if (!listeners) this.listeners.set(owner, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.listeners.get(owner) === listeners) this.listeners.delete(owner);
    };
  }
  private creation(input: WebRunInput, provider: WebProvider, requestId: string): WebCreation {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(requestId)) throw new WebStorageError(400, '提交请求标识无效。');
    const { apiKey: _key, ...visible } = input;
    return { schema: 'theorem-os.web-creation.v1', requestId, digest: crypto.createHash('sha256').update(canonicalMathJson({
      input: { ...visible, environment: input.environment ?? 'standard' }, provider: { id: provider.id, baseUrl: provider.baseUrl },
    })).digest('hex') };
  }
  replay(owner: string, input: WebRunInput, provider: WebProvider, requestId?: string, legacyEnvironmentOmitted = false): WebRun | undefined {
    if (!requestId) return;
    const expected = this.creation(input, provider, requestId);
    const stored = this.creations.get(JSON.stringify([owner, requestId]));
    const previous = stored ?? this.storage.deletedCreation(owner, requestId);
    if (!previous) return;
    // Older HTTP clients could omit the environment when its default was standard.
    // Match that frozen identity only on a replay; new submissions keep the current default.
    if (previous.digest !== expected.digest && (!legacyEnvironmentOmitted ||
        previous.digest !== this.creation({ ...input, environment: 'standard' }, provider, requestId).digest))
      throw new WebStorageError(409, '同一提交请求不能使用不同的题目或配置。');
    const run = stored && this.get(owner, stored.runId);
    if (!run) throw new WebStorageError(410, '这次提交对应的运行已删除，请发起新研究。');
    return run;
  }
  /** The source goes only to the worker; its exact host-resolved identity stays with the visible run. */
  create(owner: string, input: WebRunInput, provider: WebProvider, continuation?: WorkerInput['continuation'], requestId?: string,
    formalization?: { evidence?: unknown; compiled?: unknown; provenance: NonNullable<WebRun['formalization']> },
    researchConfiguration?: WorkerInput['researchConfiguration']): WebRun {
    const previous = this.replay(owner, input, provider, requestId);
    if (previous) return previous;
    if (this.closing) throw new Error('服务正在停止，请稍后重试。');
    const count = (status: string) => [...this.jobs.values()].filter(job => job.run.status === status).length;
    const active = count('running'), waiting = count('queued');
    if (active + waiting >= this.config.queueLimit)
      throw new Error(`运行队列已满：${active} 个任务正在运行，${waiting} 个在排队。草稿已保留，请等几分钟后再提交。`);
    if (this.list(owner).length >= webLimits.maxRuns)
      throw new Error(`已达到 ${webLimits.maxRuns} 条运行记录的上限。请先下载需要的档案，删除已结束的记录后重试。`);
    const now = new Date().toISOString();
    const pinnedDigest = input.knowledgeDigest === undefined
      ? continuation ? this.get(owner, continuation.runId)?.knowledgeDigest : this.knowledge.latestReusableCatalog(owner)?.digest
      : input.knowledgeDigest ?? undefined;
    if (pinnedDigest && !this.knowledge.getCatalog(owner, pinnedDigest))
      throw new WebStorageError(404, '所选知识目录不存在或不属于当前会话。');
    const pinnedInput: WebRunInput = { ...input, environment: input.environment ?? 'standard',
      autoExplain: input.autoExplain ?? true, explanationLanguage: input.explanationLanguage ?? 'zh' };
    if (researchConfiguration) pinnedInput.modulePlan = structuredClone(researchConfiguration.modulePlan);
    if (pinnedDigest) pinnedInput.knowledgeDigest = pinnedDigest;
    else delete pinnedInput.knowledgeDigest;
    const { apiKey, knowledgeDigest: _selectedKnowledgeDigest, ...visible } = pinnedInput;
    const environment = input.environment ?? 'standard';
    const run: WebRun = { ...clean(visible, apiKey), ...(pinnedDigest ? { knowledgeDigest: pinnedDigest } : {}),
      environment, id: crypto.randomUUID(),
      title: '', status: 'queued',
      phase: 'queued', createdAt: now, updatedAt: now, timings: {}, events: [], modules: {} };
    if (input.continueFrom && continuation) run.continueFrom = clean({ ...input.continueFrom,
      ...(continuation.taskVersion ? { taskVersion: continuation.taskVersion } : {}),
      ...(continuation.sourceDigest ? { sourceDigest: continuation.sourceDigest } : {}),
      ...(continuation.environmentDigest ? { environmentDigest: continuation.environmentDigest } : {}), file: continuation.file }, apiKey);
    if (formalization) run.formalization = formalization.provenance;
    if (researchConfiguration) run.researchConfiguration = structuredClone(researchConfiguration);
    run.title = (formalization?.provenance.original.trim() || run.task).split('\n')[0].slice(0, 60) || 'Lean 研究';
    run.moduleConfiguration = freezeModuleConfiguration(run.modulePlan, run.coordination, run.workers);
    const creation = requestId ? this.creation(input, provider, requestId) : undefined;
    this.event(run, 'queued', '任务已进入队列');
    // Persist the identity and initial run atomically before a worker can be queued.
    this.storage.saveRun(owner, run, creation);
    if (creation) this.creations.set(JSON.stringify([owner, requestId]), { ...creation, runId: run.id });
    this.jobs.set(run.id, { owner, input: pinnedInput, provider, run, controller: new AbortController(),
      ...(researchConfiguration ? { researchConfiguration: structuredClone(researchConfiguration) } : {}),
      ...(formalization ? { formalization: formalization.evidence } : {}),
      ...(formalization?.compiled ? { compiledFormalization: formalization.compiled } : {}),
      ...(continuation ? { continuation } : {}) });
    this.reindex();
    queueMicrotask(() => this.pump());
    return run;
  }
  /** Review updates only the Web provenance; the solver's frozen task and Lean receipt never change. */
  reviewFormalization(owner: string, id: string, candidateDigest: string,
    confirmation: NonNullable<WebRun['formalization']>['confirmation'],
    approved?: { evidenceSha256: string; confirmedAt: string; sourceSha256: string; environment: WebRun['environment'] }) {
    const job = this.jobs.get(id), provenance = job?.run.formalization;
    if (!job || job.owner !== owner || !provenance || provenance.candidateDigest !== candidateDigest) return;
    const reviewed = isStatementReviewed(job.run);
    if (confirmation === 'interrupted' && provenance.confirmation !== 'pending') return;
    if (approved && !['automatic', 'manual'].includes(confirmation ?? '')) throw new Error('formalization_binding_changed');
    if (approved && (crypto.createHash('sha256').update(job.run.source).digest('hex') !== approved.sourceSha256 ||
        job.run.environment !== approved.environment)) throw new Error('formalization_binding_changed');
    Object.assign(provenance, { confirmation }, approved ? { evidenceSha256: approved.evidenceSha256, confirmedAt: approved.confirmedAt } : {});
    try { this.onStatementReview?.(owner, job.run); } catch { /* Explanation failures never change proof acceptance. */ }
    const message = confirmation === 'automatic' ? '后台审核通过，已关联同一份固定 Lean 陈述。'
      : confirmation === 'rejected' ? '后台审核要求修改陈述，已停止旧候选的证明。'
        : confirmation === 'superseded' ? '陈述已更新，旧候选的证明与新版本分开保留。'
          : '原题含义审核已停止；现有代码与 Lean 验收结果保留。';
    this.event(job.run, 'statement_review_updated', message);
    if (!['automatic', 'manual', 'pending'].includes(confirmation ?? '')) this.cancel(owner, id);
    if (approved && !reviewed && isAcceptedRun(job.run)) {
      this.onAccepted?.(owner);
      this.onFinished?.(owner, job.run);
    }
  }
  cancel(owner: string, id: string): WebRun | undefined {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) return undefined;
    if (!terminal(job.run)) {
      const queued = job.run.status === 'queued';
      job.run.status = 'cancelled'; job.run.phase = 'cancelled'; job.run.finishedAt = new Date().toISOString();
      delete job.run.queue;
      try { this.event(job.run, 'cancelled', '运行已取消'); }
      finally {
        job.controller.abort();
        job.input.apiKey = ''; delete job.continuation; delete job.formalization; delete job.compiledFormalization;
        if (queued) this.reindex();
      }
    }
    return job.run;
  }
  remove(owner: string, id: string): 'deleted' | 'active' | 'missing' {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) return 'missing';
    if (!terminal(job.run)) return 'active';
    this.storage.deleteRun(owner, id);
    this.jobs.delete(id);
    this.changed(owner);
    return 'deleted';
  }
  forget(owner: string) {
    let removed = false;
    let failure: unknown;
    for (const [id, job] of this.jobs) if (job.owner === owner) {
      // Detach before abort: final worker observations must not write a deleted owner's records.
      this.jobs.delete(id);
      if (!terminal(job.run)) { job.run.status = 'cancelled'; job.run.phase = 'cancelled'; job.run.finishedAt = new Date().toISOString(); }
      job.controller.abort();
      job.input.apiKey = ''; delete job.continuation; delete job.formalization; delete job.compiledFormalization;
      removed = true;
      try { this.storage.deleteRun(owner, id); }
      catch (error) { failure ??= error; }
    }
    if (removed) { this.reindex(); this.changed(owner); }
    if (failure) throw failure;
  }
  async close() {
    this.closing = true;
    this.closeError = undefined;
    for (const timer of this.pendingActions.values()) clearTimeout(timer);
    this.pendingActions.clear();
    for (const job of this.jobs.values()) {
      try { this.cancel(job.owner, job.run.id); }
      catch (error) { this.closeError ??= error; }
    }
    while (this.running) await new Promise(resolve => setTimeout(resolve, 25));
    this.jobs.clear();
    this.listeners.clear();
    if (this.closeError) throw this.closeError;
  }
  private persist(run: WebRun) {
    const job = this.jobs.get(run.id);
    const pending = this.pendingActions.get(run.id);
    if (pending) { clearTimeout(pending); this.pendingActions.delete(run.id); }
    if (job) { this.storage.saveRun(job.owner, run); this.changed(job.owner); }
  }
  /**
   * An Agent acts several times a second, and each save tells every open page to reload its run list; the action
   * itself is already stored, so the run with its new count is saved at most every two seconds, or with its next event.
   */
  private actionsChanged(run: WebRun) {
    if (this.pendingActions.has(run.id)) return;
    const timer = setTimeout(() => {
      this.pendingActions.delete(run.id);
      const job = this.jobs.get(run.id);
      if (job?.run !== run) return;
      try { this.persist(run); }
      catch { run.error = '运行状态未能保存；服务恢复后请重新查看。'; this.changed(job.owner); }
    }, 2_000);
    timer.unref?.();
    this.pendingActions.set(run.id, timer);
  }
  private changed(owner: string) {
    this.revisions.set(owner, (this.revisions.get(owner) ?? 0) + 1);
    if (!this.listeners.has(owner) || this.pendingNotifications.has(owner)) return;
    this.pendingNotifications.add(owner);
    queueMicrotask(() => {
      this.pendingNotifications.delete(owner);
      const version = this.version(owner);
      for (const listener of this.listeners.get(owner) ?? []) listener(version);
    });
  }
  private libraryRestart(job: Job, message: Extract<WorkerMessage, { type: 'library_restart' }>) {
    const current = job.run.solverAttempt ?? (job.run.observation && {
      solverRunId: job.run.observation.solverRunId, round: 0, sequence: job.run.observation.sequence });
    if (!current || current.solverRunId !== message.previousSolverRunId ||
        message.solverRunId === message.previousSolverRunId || !Number.isSafeInteger(message.round) ||
        message.round <= current.round) return;
    job.run.solverAttempt = { solverRunId: message.solverRunId, round: message.round, sequence: current.sequence };
    delete job.run.observation;
    this.persist(job.run);
  }
  private observe(job: Job, observation: WebObservation) {
    const current = job.run.solverAttempt ?? (job.run.observation && {
      solverRunId: job.run.observation.solverRunId, round: 0, sequence: job.run.observation.sequence });
    if (observation.webRunId !== job.run.id || observation.snapshot.runId !== observation.solverRunId ||
        current && (current.solverRunId !== observation.solverRunId || current.sequence >= observation.sequence)) return;
    job.run.solverAttempt = { solverRunId: observation.solverRunId, round: current?.round ?? 0, sequence: observation.sequence };
    job.run.observation = observation;
    job.run.updatedAt = observation.observedAt;
    this.persist(job.run);
  }
  guidance(owner: string, runId: string, id: string) {
    const run = this.get(owner, runId);
    return run?.observation?.guidance.find(item => item.id === id) ?? this.storage.getCommand(owner, runId, id)?.guidance;
  }
  /** Resolve a saved command against observed host receipts without sending or changing anything. */
  commandReceipt(owner: string, runId: string, id: string): WebCommandResult | undefined {
    const run = this.get(owner, runId);
    if (!run) return;
    const stored = this.storage.getCommand(owner, runId, id);
    if (!stored) return;
    const saved = run.observation ? { ...stored, observation: run.observation } : stored;
    const guidance = run.observation?.guidance.find(item => item.id === id);
    if (guidance) return { ...saved, status: guidance.status, reason: guidance.reason, guidance };
    const edit = run.observation?.inspection.edits.find(item => item.id === id);
    if (edit) return { ...saved, status: edit.status, reason: edit.reason,
      baseVersion: edit.baseVersion ?? saved.baseVersion, planVersion: edit.planVersion,
      affectedTaskIds: edit.affectedTasks ?? saved.affectedTaskIds, edit };
    // An approval is settled once the running solver records it as the approval, or rejects it.
    const approval = run.observation?.inspection.planApproval;
    if (approval?.approvedId === id) return { ...saved, status: 'approved', reason: undefined, planVersion: approval.approvedVersion };
    const rejected = approval?.rejections.find(item => item.id === id);
    if (rejected) return { ...saved, status: 'rejected', reason: rejected.reason, planVersion: rejected.planVersion ?? saved.planVersion };
    return saved;
  }
  async command(owner: string, runId: string, command: Exclude<WebCommand, { type: 'capture' }>): Promise<WebCommandResult> {
    const job = this.jobs.get(runId);
    if (!job || job.owner !== owner) throw new Error('运行不存在或不属于当前会话。');
    const id = command.type === 'guidance' ? command.guidance.id : command.type === 'guidance-withdraw' ? command.id
      : command.type === 'plan-approval' ? command.approval.id : command.proposal.id;
    const key = `${runId}/${command.type === 'edit-preview' ? 'preview/' : ''}${id}`;
    const digest = crypto.createHash('sha256').update(canonicalMathJson(command)).digest('hex');
    const previous = this.commandReceipt(owner, runId, id);
    if (command.type !== 'edit-preview' && previous) {
      if (previous.commandDigest !== digest) throw new Error('命令 ID 已用于另一份内容，请使用新的 ID。');
      return previous;
    }
    if (terminal(job.run) || job.run.status !== 'running') throw new Error('仅可干预正在执行且已建立计划的运行。');
    if (!this.runner.command) throw new Error('当前运行器未提供人工介入通道。');
    const pending = this.commands.get(key);
    if (pending) {
      if (pending.digest !== digest) throw new Error('命令 ID 已用于另一份内容，请使用新的 ID。');
      return pending.promise;
    }
    // The worker clears its input credential on exit, while an already sent command may still be returning.
    const apiKey = job.input.apiKey;
    const run = async (): Promise<WebCommandResult> => {
      try {
        const receipt = clean(await this.runner.command!(runId, command), apiKey);
        if (this.jobs.get(runId) !== job) throw new WebStorageError(404, '运行不存在或不属于当前会话。');
        if (receipt.id !== id) throw new Error('命令回执身份不匹配。');
        if (command.type === 'edit-preview') receipt.commandDigest = crypto.createHash('sha256')
          .update(canonicalMathJson({ type: 'edit', proposal: command.proposal })).digest('hex');
        if (receipt.observation) this.observe(job, receipt.observation);
        if (job.run.observation) receipt.observation = job.run.observation;
        if (command.type !== 'edit-preview') {
          this.storage.saveCommand(owner, runId, id, { ...receipt, commandDigest: digest });
          try {
            if (command.type === 'plan-approval') {
              if (receipt.status === 'queued') this.event(job.run, 'plan_approval_queued', '计划批准已提交；运行确认后 Agent 才开始工作，未生效会另行记录。');
            } else if (command.type === 'guidance-withdraw') {
              if (receipt.status === 'withdrawn') this.event(job.run, 'guidance_withdrawn', '一条尚未送达的数学指导已撤回，Agent 不会收到它。');
            } else this.event(job.run, command.type === 'guidance' ? 'guidance_queued' : 'human_edit_queued',
              command.type === 'guidance' ? '数学指导已提交；投递和采纳结果另行记录。' : '计划修改已提交；应用与证明重查结果另行记录。');
          } catch { job.run.error = '运行状态未能保存；服务恢复后请重新查看。'; this.changed(owner); }
        }
        return command.type === 'edit-preview' ? receipt : this.commandReceipt(owner, runId, id) ?? receipt;
      } catch (error) {
        // Deleted runs/accounts must stay deleted even when a transport fails after removal.
        if (this.jobs.get(runId) !== job) throw new WebStorageError(404, '运行不存在或不属于当前会话。');
        const reason = clean(error instanceof Error ? error.message : '命令回执暂不可用。', apiKey);
        if (command.type === 'edit-preview') throw new Error(reason);
        const receipt = { id, status: 'unknown', reason, commandDigest: digest,
          ...(job.run.observation ? { observation: job.run.observation } : {}) };
        this.storage.saveCommand(owner, runId, id, receipt);
        return this.commandReceipt(owner, runId, id) ?? receipt;
      } finally { this.commands.delete(key); }
    };
    const promise = run();
    this.commands.set(key, { digest, promise });
    return promise;
  }
  async archive(owner: string, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new Error('运行不存在或不属于当前会话。');
    if (!terminal(job.run) && this.runner.command) {
      const apiKey = job.input.apiKey;
      const capture = clean(await this.runner.command(id, { type: 'capture' }), apiKey);
      if (this.jobs.get(id) !== job) throw new WebStorageError(404, '运行不存在或不属于当前会话。');
      if (capture.observation) this.observe(job, capture.observation);
      if (capture.catalog) job.run.knowledgeCatalogDigest = this.knowledge.importCatalog(owner, capture.catalog).digest;
    }
    const archive = this.storage.archiveRun(owner, job.run, job.run.knowledgeCatalogDigest);
    job.run.archives ??= [];
    if (!job.run.archives.some(item => item.id === archive.id)) job.run.archives.push(archive);
    this.persist(job.run);
    return archive;
  }
  private event(run: WebRun, type: string, message: string, rawDetails?: WebEventDetails) {
    const sequence = (run.events.at(-1)?.sequence ?? 0) + 1;
    run.updatedAt = new Date().toISOString();
    const timing = type === 'preparing' ? 'preparing' : type === 'solve_started' ? 'solving'
      : type === 'evaluation_started' ? 'evaluating' : undefined;
    // Keep phase boundaries even after the bounded activity log has rotated.
    if (timing) (run.timings ??= {})[timing] ??= run.updatedAt;
    const details = sanitizeWebEventDetails(rawDetails);
    if (isProgressEvent(type, details)) run.progressAt = run.updatedAt;
    const event: WebEvent = { sequence, at: run.updatedAt, type, message: message.slice(0, 2_000), ...(details ? { details } : {}) };
    recordWebModuleEvent(run, event);
    run.events.push(event);
    if (run.events.length > 200) run.events.shift();
    this.persist(run);
  }
  private pump() {
    while (!this.closing && this.running < this.config.concurrency) {
      const job = [...this.jobs.values()].find(item => item.run.status === 'queued');
      if (!job) break;
      this.running++; job.run.status = 'running'; job.run.phase = 'preparing';
      delete job.run.queue;
      void this.execute(job).finally(() => { this.running--; this.pump(); });
    }
    this.reindex();
  }
  /** Queue positions are global and first-in first-out; only counts are shown, never other owners' runs. */
  private reindex() {
    const queued = [...this.jobs.values()].filter(job => job.run.status === 'queued');
    queued.forEach((job, index) => {
      const queue = { position: index + 1, ahead: index, running: this.running, slots: this.config.concurrency };
      const previous = job.run.queue;
      if (previous && Object.entries(queue).every(([key, value]) => previous[key as keyof typeof queue] === value)) return;
      job.run.queue = queue;
      this.changed(job.owner);
    });
  }
  private async execute(job: Job) {
    const key = job.input.apiKey;
    let messageError: unknown;
    const handle = (raw: WorkerMessage) => {
      if (messageError || this.jobs.get(job.run.id) !== job || terminal(job.run) && !['observation', 'catalog'].includes(raw.type)) return;
      try {
        const message = clean(raw, key);
        if (message.type === 'progress') {
          job.run.phase = message.event;
          this.event(job.run, message.event, message.message, message.details);
          // The solver asks once per run, when its first plan is accepted; the owner may be away from the page.
          if (message.event === 'plan_approval_requested')
            try { this.onPlanWaiting?.(job.owner, job.run); } catch { /* Telling the owner never changes the run. */ }
        } else if (message.type === 'action') {
          // Kept apart from the 200-event activity log; past the per-run limit only the count grows.
          const tally = job.run.actions ??= { count: 0 };
          if (tally.count >= webAgentActionLimits.perRun) tally.dropped = (tally.dropped ?? 0) + 1;
          else {
            tally.count++;
            this.storage.saveAction(job.owner, job.run.id, { ...message.action, sequence: tally.count, at: new Date().toISOString() });
          }
          this.actionsChanged(job.run);
        } else if (message.type === 'artifact') {
          if (job.run.result) return;
          job.run.artifact = message.artifact;
          job.run.updatedAt = new Date().toISOString();
          this.persist(job.run);
        } else if (message.type === 'library_restart') {
          this.libraryRestart(job, message);
        } else if (message.type === 'observation') {
          this.observe(job, message.observation);
        } else if (message.type === 'catalog') {
          try { job.run.knowledgeCatalogDigest = this.knowledge.importCatalog(job.owner, message.catalog).digest; this.persist(job.run); }
          catch { this.event(job.run, 'archive_failed', '本次知识材料未能保存；已有证明验收状态不变。'); }
        } else if (message.type === 'result') {
          job.run.result = message.result;
          const failure = parseWebFailure(message.result.report.failure);
          if (failure) job.run.failure = failure;
          job.run.phase = message.result.status;
          job.run.updatedAt = new Date().toISOString();
          this.persist(job.run);
        } else if (message.type === 'error') {
          job.run.error = message.message;
          job.run.failure = message.failure ?? { kind: 'environment' };
          job.run.updatedAt = new Date().toISOString();
          this.persist(job.run);
        }
      } catch (error) { messageError = error; job.controller.abort(); }
    };
    try {
      this.event(job.run, 'preparing', '正在准备独立运行环境');
      // Project provenance remains on the visible run; preserve the input object whose key is cleared on cancellation and completion.
      delete job.input.budgetOrigin;
      delete job.input.libraryProposalOrigin;
      await this.runner.run({ id: job.run.id, input: job.input, provider: job.provider,
        ...(job.researchConfiguration ? { researchConfiguration: job.researchConfiguration } : {}),
        ...(job.formalization ? { formalization: job.formalization } : {}),
        ...(job.compiledFormalization ? { compiledFormalization: job.compiledFormalization } : {}),
        ...(job.input.knowledgeDigest ? { knowledgeCatalog: this.knowledge.getCatalog(job.owner, job.input.knowledgeDigest) } : {}),
        ...(job.continuation ? { continuation: job.continuation } : {}) }, handle, job.controller.signal);
      if (messageError) throw messageError;
      if (!terminal(job.run)) {
        if (!job.run.result) throw new Error(job.run.error || '没有收到运行结果。');
        job.run.status = job.run.result.status === 'runtime_error' ? 'error' : 'completed';
        const accepted = job.run.result.status === 'evaluated_passed';
        // Transfer credentials only to the explanation queue, before the solver releases them. The queue saves its
        // initial records before the finished notification; proof acceptance never depends on explanation success.
        if (accepted) try { this.onProofAccepted?.(job.owner, job.run, { apiKey: job.input.apiKey, provider: job.provider }); }
        catch { this.event(job.run, 'explanation_queue_failed', '证明已验收，自动讲解未能保存；请稍后重试。'); }
        const acceptance = !job.run.formalization ? '完整原题通过独立 Lean 验收'
          : !isStatementReviewed(job.run) ? '候选 Lean 陈述通过独立验收；原题含义尚未审核通过。'
          : job.run.formalization.confirmation === 'manual' ? 'Lean 陈述通过独立 Lean 验收；原题含义已由你确认。Lean 验收不能替代自然语言原意核对。'
            : job.run.formalization.confirmation === 'automatic' ? 'Lean 陈述通过独立 Lean 验收；原题含义仅经模型审核，未经人工确认。Lean 验收不能替代自然语言原意核对。'
              : 'Lean 陈述通过独立 Lean 验收；原题含义未记录确认方式，请核对 Lean 陈述。Lean 验收不能替代自然语言原意核对。';
        this.event(job.run, 'finished', accepted ? acceptance : '运行结束，请查看验收状态');
        if (accepted && isStatementReviewed(job.run)) this.onAccepted?.(job.owner);
      }
    } catch (error) {
      if (!terminal(job.run)) {
        job.run.status = 'error'; job.run.phase = 'error';
        const failure = messageError ?? error;
        job.run.error = clean(failure instanceof Error ? failure.message : '运行失败。', key);
        job.run.failure ??= { kind: 'environment' };
        try { this.event(job.run, 'error', job.run.error); }
        catch { /* The final save retries below, after credentials are released. */ }
      }
    } finally {
      job.input.apiKey = '';
      delete job.continuation;
      delete job.formalization;
      delete job.compiledFormalization;
      job.run.finishedAt ??= new Date().toISOString();
      try { this.persist(job.run); }
      catch (error) {
        if (this.closing) this.closeError ??= error;
        else { job.run.error = '运行状态未能保存；服务恢复后请重新查看。'; job.run.failure ??= { kind: 'environment' }; }
      }
      try { this.onFinished?.(job.owner, job.run); } catch { /* Telling the owner never changes the run. */ }
    }
  }
}
