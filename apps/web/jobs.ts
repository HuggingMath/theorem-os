import crypto from 'node:crypto';
import type { WebConfig } from './config';
import type { WebRunner } from './runner';
import type { WebEvent, WebEventDetails, WebProvider, WebRun, WebRunInput, WorkerMessage } from './shared';
import { parseWebFailure } from './shared';
import { recordWebModuleEvent, sanitizeWebEventDetails } from './moduleTelemetry';
import type { WebCommand, WebCommandResult, WebObservation } from './collaboration';
import { canonicalMathJson } from '../../src/math/mathRuntimeIo';
import { WebStorage } from './storage';
import { WebKnowledgeService } from './knowledgeService';
import { freezeModuleConfiguration } from './moduleRegistry';
import { WebStorageError } from './storage';

type Job = { owner: string; run: WebRun; input: WebRunInput; provider: WebProvider; controller: AbortController };
const terminal = (run: WebRun) => ['completed', 'cancelled', 'error'].includes(run.status);
const clean = <T>(value: T, key: string): T => JSON.parse(key ? JSON.stringify(value).replaceAll(
  JSON.stringify(key).slice(1, -1), '[REDACTED]') : JSON.stringify(value));

export class WebJobs {
  private jobs = new Map<string, Job>();
  private running = 0;
  private closing = false;
  private commands = new Map<string, { digest: string; promise: Promise<WebCommandResult> }>();
  private readonly versionId = crypto.randomUUID();
  private revisions = new Map<string, number>();
  private listeners = new Map<string, Set<(version: string) => void>>();
  private pendingNotifications = new Set<string>();
  readonly storage: WebStorage;
  readonly knowledge: WebKnowledgeService;
  private readonly onAccepted?: (owner: string) => void;
  private readonly onFinished?: (owner: string, run: WebRun) => void;
  constructor(private readonly runner: WebRunner, private readonly config: Pick<WebConfig, 'concurrency' | 'queueLimit'>,
    options: { storage?: WebStorage; knowledge?: WebKnowledgeService; onAccepted?: (owner: string) => void;
      onFinished?: (owner: string, run: WebRun) => void } = {}) {
    this.onAccepted = options.onAccepted;
    this.onFinished = options.onFinished;
    this.storage = options.storage ?? new WebStorage();
    this.knowledge = options.knowledge ?? new WebKnowledgeService(this.storage);
    for (const { owner, run } of this.storage.loadRuns()) {
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
  create(owner: string, input: WebRunInput, provider: WebProvider): WebRun {
    if (this.closing) throw new Error('服务正在停止，请稍后重试。');
    const count = (status: string) => [...this.jobs.values()].filter(job => job.run.status === status).length;
    const active = count('running'), waiting = count('queued');
    if (active + waiting >= this.config.queueLimit)
      throw new Error(`运行队列已满：${active} 个任务正在运行，${waiting} 个在排队。草稿已保留，请等几分钟后再提交。`);
    if (this.list(owner).length >= 20) throw new Error('已达到 20 条运行记录的上限。请先下载需要的档案，删除已结束的记录后重试。');
    const now = new Date().toISOString();
    const { apiKey, ...visible } = input;
    const environment = input.environment ?? 'standard';
    if (input.knowledgeDigest && !this.knowledge.getCatalog(owner, input.knowledgeDigest))
      throw new WebStorageError(404, '所选知识目录不存在或不属于当前会话。');
    const run: WebRun = { ...clean(visible, apiKey), environment, id: crypto.randomUUID(),
      title: '', status: 'queued',
      phase: 'queued', createdAt: now, updatedAt: now, timings: {}, events: [], modules: {} };
    run.title = run.task.split('\n')[0].slice(0, 60) || 'Lean 研究';
    run.moduleConfiguration = freezeModuleConfiguration(run.modulePlan, run.coordination, run.workers);
    this.jobs.set(run.id, { owner, input: { ...input, environment }, provider, run, controller: new AbortController() });
    this.event(run, 'queued', '任务已进入队列');
    this.reindex();
    queueMicrotask(() => this.pump());
    return run;
  }
  cancel(owner: string, id: string): WebRun | undefined {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) return undefined;
    if (!terminal(job.run)) {
      const queued = job.run.status === 'queued';
      job.run.status = 'cancelled'; job.run.phase = 'cancelled'; job.run.finishedAt = new Date().toISOString();
      delete job.run.queue;
      this.event(job.run, 'cancelled', '运行已取消');
      job.controller.abort();
      if (queued) { job.input.apiKey = ''; this.reindex(); }
    }
    return job.run;
  }
  remove(owner: string, id: string): 'deleted' | 'active' | 'missing' {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) return 'missing';
    if (!terminal(job.run)) return 'active';
    this.jobs.delete(id);
    this.storage.deleteRun(owner, id);
    this.changed(owner);
    return 'deleted';
  }
  forget(owner: string) {
    let removed = false;
    for (const [id, job] of this.jobs) if (job.owner === owner) {
      this.cancel(owner, id); this.jobs.delete(id); this.storage.deleteRun(owner, id);
      removed = true;
    }
    if (removed) this.changed(owner);
  }
  async close() {
    this.closing = true;
    for (const job of this.jobs.values()) this.cancel(job.owner, job.run.id);
    while (this.running) await new Promise(resolve => setTimeout(resolve, 25));
    this.jobs.clear();
    this.listeners.clear();
  }
  private persist(run: WebRun) {
    const job = this.jobs.get(run.id);
    if (job) { this.storage.saveRun(job.owner, run); this.changed(job.owner); }
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
  private observe(job: Job, observation: WebObservation) {
    if (observation.webRunId !== job.run.id || observation.snapshot.runId !== observation.solverRunId ||
        job.run.observation && (job.run.observation.solverRunId !== observation.solverRunId ||
          job.run.observation.sequence >= observation.sequence)) return;
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
    return saved;
  }
  async command(owner: string, runId: string, command: Exclude<WebCommand, { type: 'capture' }>): Promise<WebCommandResult> {
    const job = this.jobs.get(runId);
    if (!job || job.owner !== owner) throw new Error('运行不存在或不属于当前会话。');
    const id = command.type === 'guidance' ? command.guidance.id : command.proposal.id;
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
    const run = async (): Promise<WebCommandResult> => {
      try {
        const receipt = clean(await this.runner.command!(runId, command), job.input.apiKey);
        if (receipt.id !== id) throw new Error('命令回执身份不匹配。');
        if (command.type === 'edit-preview') receipt.commandDigest = crypto.createHash('sha256')
          .update(canonicalMathJson({ type: 'edit', proposal: command.proposal })).digest('hex');
        if (receipt.observation) this.observe(job, receipt.observation);
        if (job.run.observation) receipt.observation = job.run.observation;
        if (command.type !== 'edit-preview') {
          this.storage.saveCommand(owner, runId, id, { ...receipt, commandDigest: digest });
          this.event(job.run, command.type === 'guidance' ? 'guidance_queued' : 'human_edit_queued',
            command.type === 'guidance' ? '数学指导已提交；投递和采纳结果另行记录。' : '计划修改已提交；应用与证明重查结果另行记录。');
        }
        return command.type === 'edit-preview' ? receipt : this.commandReceipt(owner, runId, id) ?? receipt;
      } catch (error) {
        const reason = clean(error instanceof Error ? error.message : '命令回执暂不可用。', job.input.apiKey);
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
      const capture = clean(await this.runner.command(id, { type: 'capture' }), job.input.apiKey);
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
      this.event(job.run, 'preparing', '正在准备独立运行环境');
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
    const handle = (raw: WorkerMessage) => {
      if (this.jobs.get(job.run.id) !== job || terminal(job.run) && !['observation', 'catalog'].includes(raw.type)) return;
      const message = clean(raw, key);
      if (message.type === 'progress') {
        job.run.phase = message.event;
        this.event(job.run, message.event, message.message, message.details);
      } else if (message.type === 'artifact') {
        if (job.run.result) return;
        job.run.artifact = message.artifact;
        job.run.updatedAt = new Date().toISOString();
        this.persist(job.run);
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
    };
    try {
      await this.runner.run({ id: job.run.id, input: job.input, provider: job.provider,
        ...(job.input.knowledgeDigest ? { knowledgeCatalog: this.knowledge.getCatalog(job.owner, job.input.knowledgeDigest) } : {}) }, handle, job.controller.signal);
      if (!terminal(job.run)) {
        if (!job.run.result) throw new Error(job.run.error || '没有收到运行结果。');
        job.run.status = job.run.result.status === 'runtime_error' ? 'error' : 'completed';
        const accepted = job.run.result.status === 'evaluated_passed';
        this.event(job.run, 'finished', accepted ? '完整原题通过独立 Lean 验收' : '运行结束，请查看验收状态');
        if (accepted) this.onAccepted?.(job.owner);
      }
    } catch (error) {
      if (!terminal(job.run)) {
        job.run.status = 'error'; job.run.phase = 'error';
        job.run.error = clean(error instanceof Error ? error.message : '运行失败。', key);
        job.run.failure ??= { kind: 'environment' };
        this.event(job.run, 'error', job.run.error);
      }
    } finally {
      job.input.apiKey = '';
      job.run.finishedAt ??= new Date().toISOString();
      this.persist(job.run);
      try { this.onFinished?.(job.owner, job.run); } catch { /* Telling the owner never changes the run. */ }
    }
  }
}
