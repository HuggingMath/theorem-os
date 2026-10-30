import type { WebCommandResult, WebGuidanceInput, WebGuidanceRecord, WebObservation } from '../collaboration';
import { commandId, createElement, errorText, observedTime, recipientLabel, workerNames, type WebApi } from './collaborationUi';
import { taskNames } from './agentRoute';
import { Code, Facts, renderSection } from './ui/Section';
import { TermHint } from './ui/TermHint';
import { localizeText, t } from '../i18n';

type PendingGuidance = { input: WebGuidanceInput; draftRevision: number; missing: boolean };
type Kind = WebGuidanceInput['recipient']['kind'];
const responseStatus = (error: unknown) => error && typeof error === 'object' && 'status' in error ? error.status : undefined;
const statusLabel: Record<string, string> = { queued: t('排队中'), deferred: t('暂缓'), delivered: t('已送达'), failed: t('失败'), rejected: t('已拒绝'), unknown: t('结果尚未确认') };
const maxLength = 4000;

/** Each research keeps its editable draft separate from the exact command awaiting a receipt. */
export class GuidanceComposer {
  readonly element = createElement('section', 'collab-guidance');
  private observation?: WebObservation;
  private records = new Map<string, WebGuidanceRecord>();
  private taskRef?: WebGuidanceInput['taskRef'];
  private pending?: PendingGuidance;
  private draftRevision = 0;
  private busy = false;
  private active = false;
  private connected = false;
  private text = '';
  private kind: Kind = 'lead';
  private target = '';
  private targets: [string, string][] = [['', 'Lead']];
  private notice = '';

  constructor(private api: WebApi, private runId: string, private observed: (observation: WebObservation) => void) {
    this.render();
  }

  update(observation: WebObservation | undefined, active: boolean, connected: boolean) {
    this.active = active; this.connected = connected;
    if (observation?.webRunId === this.runId && (!this.observation || observation.sequence >= this.observation.sequence)) {
      this.observation = observation;
      for (const record of observation.guidance) this.remember(record);
      const record = this.pending && this.records.get(this.pending.input.id);
      if (record) this.resolve({ id: record.id, status: record.status, guidance: record });
    }
    this.renderTargets(); this.render();
  }

  guide(kind: 'task' | 'worker', id: string) {
    this.kind = kind; this.renderTargets(id); this.selectTarget(); this.focus();
  }

  /** Address the draft to the Lead, the one Agent that can revise the plan. */
  guideLead() { this.kind = 'lead'; this.renderTargets(''); this.selectTarget(); this.focus(); }

  focus() { this.element.querySelector<HTMLTextAreaElement>('[data-guidance-text]')!.focus({ preventScroll: true }); }

  appendReference(text: string, notice = t('知识引用已加入本地指导草稿，尚未发送')) {
    const next = `${this.text}${this.text ? '\n\n' : ''}${text}`;
    if (next.length > maxLength) {
      this.notice = t('指导最多 {0} 字符，引用未加入；请缩短草稿后重试。', maxLength);
      this.render(); this.focus(); return false;
    }
    this.text = next; this.draftRevision++; this.notice = notice;
    this.render(); this.focus();
    return true;
  }

  private selectTarget() {
    const task = this.kind === 'task' ? this.observation?.inspection.tasks.find(task => task.id === this.target) : undefined;
    this.taskRef = task ? { id: task.id, version: task.version } : undefined;
    this.draftRevision++; this.render();
  }

  /** Tasks by their theorem and Agents by their role, the way the rest of 协作 names them; ids stay in the option values. */
  private name(kind: Kind, id: string) {
    const inspection = this.observation?.inspection;
    return (kind === 'task' ? taskNames(inspection?.tasks ?? []) : kind === 'worker' ? workerNames(inspection?.workers) : new Map<string, string>()).get(id) ?? id;
  }

  /** Recipients for the chosen kind; a chosen recipient that disappeared stays visible as removed rather than silently switching. */
  private renderTargets(value = this.target) {
    const entries = this.kind === 'task' ? this.observation?.inspection.tasks.map(task => [task.id, this.name('task', task.id)] as [string, string]) :
      this.kind === 'worker' ? this.observation?.inspection.workers.map(worker => [worker.id, this.name('worker', worker.id)] as [string, string]) : [['', 'Lead'] as [string, string]];
    const options = [...(entries ?? [])];
    if (value && !options.some(([id]) => id === value)) options.push([value, t('{0} · 已移除', value)]);
    this.targets = options;
    this.target = options.some(([id]) => id === value) ? value : options[0]?.[0] ?? '';
  }

  private targetIssue() {
    if (this.kind === 'task') {
      const task = this.observation?.inspection.tasks.find(task => task.id === this.target);
      if (!task) return t('原任务已移除，请明确选择接收指导的任务。');
      if (this.taskRef?.id !== task.id || this.taskRef.version !== task.version) return t('任务版本已变化，请核对指导内容，再确认当前任务版本。');
    }
    if (this.kind === 'worker' && !this.observation?.inspection.workers.some(worker => worker.id === this.target)) return t('原 Agent 已移除，请明确选择接收方。');
    return undefined;
  }
  private context(issue: string | undefined) {
    const task = this.kind === 'task' ? this.observation?.inspection.tasks.find(task => task.id === this.target) : undefined;
    const notice = issue && <p class="collab-notice">{issue}</p>;
    // The versions matter only once the task changed under the draft; until then the task's name is enough.
    if (this.kind !== 'task' || !issue) return notice;
    return <><Facts facts={[[t('任务'), this.name('task', this.target)], [t('草稿任务版本'), this.taskRef?.version], [t('当前任务版本'), task?.version]]} />
      {notice}{task && <button type="button" class="button" data-guidance-confirm-version data-focus-key="guidance-version" onClick={() => { this.selectTarget(); this.focus(); }}>{t('确认当前任务版本')}</button>}</>;
  }

  private availability(issue: string | undefined) {
    return this.busy ? t('正在处理本次提交，请稍候。') :
      this.pending ? t('请先核对原提交的回执；当前草稿会保留。') :
      !this.connected ? t('连接恢复后才能发送指导；草稿会保留。') :
      !this.active ? t('运行尚未开始或已结束，暂时无法发送指导。') :
      !this.observation ? t('正在等待当前运行的观察记录，收到后即可发送。') :
      issue ?? t('指导会发送给所选接收方；收到回执后可查看投递状态。');
  }

  private record(record: WebGuidanceRecord) {
    // Ids, the task version and the observation it was written against stay in the tooltip for whoever needs them.
    const trace = [record.id, record.taskRef && t('任务 {0} · 版本 {1}', record.taskRef.id, record.taskRef.version),
      t('依据观察 #{0} · {1}', record.observationRef.sequence, record.observationRef.stateDigest)].filter(Boolean).join('\n');
    const recipient = record.recipient.kind === 'lead' ? 'Lead' : `${recipientLabel(record.recipient.kind)} ${this.name(record.recipient.kind, record.recipient.id ?? '')}`;
    return <article key={record.id} class="collab-guidance-record" title={trace}>
      <div><strong>{recipient}</strong><span class="badge">{statusLabel[record.status]}</span></div>
      <p>{localizeText(record.text)}</p>
      <small>{observedTime(record.updatedAt)}{record.deliveredTo?.length ? t(' · 接收 {0}', record.deliveredTo.map(id => this.name('worker', id)).join(', ')) : ''}</small>
      {record.reason && <p class="collab-help">{record.reason}</p>}
    </article>;
  }

  private render() {
    const issue = this.targetIssue(), pending = this.pending, id = this.runId;
    const sendable = this.connected && this.active && this.observation && !this.busy && !pending && !issue;
    renderSection(this.element, <>
      <div class="collab-section-heading"><span class="term-heading"><h3>{t('提供指导')}</h3><TermHint id="guidance" /></span></div>
      <form data-collab-guidance-form onSubmit={event => { event.preventDefault(); void this.send(); }}>
        <div class="collab-guidance-target">
          <label>{t('接收方')}<select data-guidance-kind value={this.kind} onChange={event => { this.kind = event.currentTarget.value as Kind; this.renderTargets(''); this.selectTarget(); }}>
            <option value="lead">Lead</option><option value="task">{t('任务')}</option><option value="worker">Agent</option></select></label>
          <label>{t('目标')}<select data-guidance-target disabled={this.kind === 'lead'} value={this.target} onChange={event => { this.target = event.currentTarget.value; this.selectTarget(); }}>
            {this.targets.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
        </div>
        <div data-guidance-context>{this.context(issue)}</div>
        <label class="sr-only" htmlFor={`guidance-${id}`}>{t('指导内容')}</label>
        <textarea id={`guidance-${id}`} data-guidance-text rows={3} maxLength={maxLength} aria-describedby={`guidance-count-${id} guidance-availability-${id}`} placeholder={t('补充思路、指出问题或引用知识；修改任务合同请使用计划编辑器。')}
          value={this.text} onInput={event => { this.text = event.currentTarget.value; this.draftRevision++; this.render(); }} />
        <div class="collab-guidance-meta"><p id={`guidance-count-${id}`} data-guidance-count class="collab-help">{this.text.length} / {maxLength}</p><p id={`guidance-availability-${id}`} data-guidance-availability class="collab-help">{this.availability(issue)}</p></div>
        <div class="collab-form-footer"><p data-guidance-notice class="collab-help" role="status">{this.notice}</p>
          <button type="submit" class="button button-primary" disabled={!sendable} aria-busy={this.busy}>{this.busy ? t('发送中…') : t('发送指导')}</button></div>
        <div data-guidance-pending>{pending && <>
          <p class="collab-notice">{t('指导 {0} 的结果尚未确认，请先核对原提交。继续编辑的草稿会保留。{1}', pending.input.id, pending.missing ? t('尚未找到回执；重试将保留原 ID、目标版本与内容。') : '')}</p>
          <details class="collab-detail" data-detail-key="pending-guidance"><summary>{t('待核对的原指导')}</summary><Code value={pending.input} /></details></>}</div>
        <div class="collab-guidance-recovery">
          <button type="button" class="button" data-guidance-receipt-refresh hidden={!pending} disabled={!this.connected || this.busy} onClick={() => void this.recover(false)}>{t('核对指导回执')}</button>
          <button type="button" class="button" data-guidance-retry hidden={!pending?.missing} disabled={!this.connected || !this.active || this.busy} onClick={() => void this.recover(true)}>{t('重试原提交')}</button>
        </div>
      </form>
      <div data-collab-guidance-records>{[...this.records.values()].map(record => this.record(record))}</div>
    </>);
  }

  private remember(record: WebGuidanceRecord) {
    const old = this.records.get(record.id);
    if (old && (old.updatedAt > record.updatedAt || (old.status === 'delivered' || old.status === 'failed') && record.status !== old.status)) return;
    this.records.set(record.id, record);
  }

  private resolve(receipt: WebCommandResult) {
    const pending = this.pending;
    if (!pending || receipt.id !== pending.input.id || receipt.guidance && receipt.guidance.id !== pending.input.id) throw new Error(t('指导回执身份不匹配'));
    if (receipt.guidance) this.remember(receipt.guidance);
    const record = this.records.get(receipt.id), status = record?.status ?? receipt.status, reason = record?.reason ?? receipt.reason;
    this.notice = t('回执 {0} · {1}{2}', receipt.id, statusLabel[status] ?? status, reason ? ` · ${reason}` : '');
    if (['queued', 'delivered', 'deferred', 'failed', 'rejected'].includes(status)) {
      this.pending = undefined;
      if (['queued', 'delivered', 'deferred'].includes(status) && this.draftRevision === pending.draftRevision) { this.text = ''; this.draftRevision++; }
    } else { pending.missing = false; this.notice += t('；指导草稿已保留'); }
    this.render();
    if (receipt.observation?.webRunId === this.runId) this.observed(receipt.observation);
  }

  private commandUrl(id: string) { return `/api/runs/${encodeURIComponent(this.runId)}/commands/${encodeURIComponent(id)}`; }

  private async readReceipt(pending: PendingGuidance) {
    pending.missing = false;
    try {
      const { receipt } = await this.api<{ receipt: WebCommandResult }>(this.commandUrl(pending.input.id));
      if (this.pending === pending) this.resolve(receipt);
    } catch (error) {
      if (this.pending !== pending) return;
      pending.missing = responseStatus(error) === 404;
      this.notice = pending.missing ? t('尚未找到原指导回执，草稿已保留。') : t('回执核对失败：{0}；原提交与草稿已保留', errorText(error));
      this.render();
    }
  }

  private async post(pending: PendingGuidance) {
    try {
      const { receipt } = await this.api<{ receipt: WebCommandResult }>(`/api/runs/${encodeURIComponent(this.runId)}/guidance`, { method: 'POST', body: JSON.stringify(pending.input) });
      if (this.pending === pending) this.resolve(receipt);
      if (this.pending === pending) await this.readReceipt(pending);
    } catch (error) {
      if (this.pending !== pending) return;
      const status = responseStatus(error);
      if (typeof status === 'number' && status >= 400 && status < 500) {
        this.pending = undefined; this.notice = t('{0}；指导未提交，草稿已保留', errorText(error)); this.render();
      } else { this.notice = errorText(error); this.render(); await this.readReceipt(pending); }
    }
  }

  private async send() {
    if (this.busy || this.pending || !this.active || !this.connected || !this.observation || this.targetIssue()) return;
    if (!this.text.trim()) { this.notice = t('请填写指导内容'); this.render(); return; }
    const kind = this.kind;
    const pending: PendingGuidance = { input: {
      id: commandId(), recipient: { kind, ...(kind === 'lead' ? {} : { id: this.target }) },
      ...(kind === 'task' && this.taskRef ? { taskRef: { ...this.taskRef } } : {}), text: this.text,
      observationRef: { sequence: this.observation.sequence, stateDigest: this.observation.snapshot.stateDigest },
    }, draftRevision: this.draftRevision, missing: false };
    this.pending = pending; this.busy = true; this.notice = t('正在提交指导'); this.render();
    try { await this.post(pending); }
    finally { this.busy = false; this.render(); }
  }

  private async recover(retry: boolean) {
    const pending = this.pending;
    if (!pending || this.busy || !this.connected) return;
    this.busy = true; this.render();
    try {
      await this.readReceipt(pending);
      if (retry && this.active && this.pending === pending && pending.missing) { pending.missing = false; await this.post(pending); }
    } finally { this.busy = false; this.render(); }
  }
}
