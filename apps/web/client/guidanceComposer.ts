import type { WebCommandResult, WebGuidanceInput, WebGuidanceRecord, WebObservation } from '../collaboration';
import { codeBlock, commandId, createElement, errorText, escapeHtml as h, factList, patchSection, type WebApi } from './collaborationUi';

type PendingGuidance = { input: WebGuidanceInput; draftRevision: number; missing: boolean };
const responseStatus = (error: unknown) => error && typeof error === 'object' && 'status' in error ? error.status : undefined;
const statusLabel: Record<string, string> = { queued: '排队中', deferred: '暂缓', delivered: '已送达', failed: '失败', rejected: '已拒绝', unknown: '结果尚未确认' };

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
  private text: HTMLTextAreaElement;
  private kind: HTMLSelectElement;
  private target: HTMLSelectElement;
  private notice: HTMLElement;
  private count: HTMLElement;
  private availability: HTMLElement;

  constructor(private api: WebApi, private runId: string, private observed: (observation: WebObservation) => void) {
    this.element.innerHTML = `<div class="collab-section-heading"><h3>提供指导</h3></div><form data-collab-guidance-form>
      <div class="collab-guidance-target"><label>接收方<select data-guidance-kind><option value="lead">Lead</option><option value="task">任务</option><option value="worker">Agent</option></select></label><label>目标<select data-guidance-target disabled><option value="">Lead</option></select></label></div>
      <div data-guidance-context></div><label class="sr-only" for="guidance-${h(runId)}">指导内容</label><textarea id="guidance-${h(runId)}" data-guidance-text rows="3" maxlength="4000" aria-describedby="guidance-count-${h(runId)} guidance-availability-${h(runId)}" placeholder="补充思路、指出问题或引用知识；修改任务合同请使用计划编辑器。"></textarea>
      <div class="collab-guidance-meta"><p id="guidance-count-${h(runId)}" data-guidance-count class="collab-help">0 / 4000</p><p id="guidance-availability-${h(runId)}" data-guidance-availability class="collab-help"></p></div>
      <div class="collab-form-footer"><p data-guidance-notice class="collab-help" role="status"></p><button type="submit" class="button button-primary">发送指导</button></div>
      <div data-guidance-pending></div><div class="collab-guidance-recovery"><button type="button" class="button" data-guidance-receipt-refresh hidden>核对指导回执</button><button type="button" class="button" data-guidance-retry hidden>重试原提交</button></div>
      </form><div data-collab-guidance-records></div>`;
    this.text = this.element.querySelector('[data-guidance-text]')!;
    this.kind = this.element.querySelector('[data-guidance-kind]')!;
    this.target = this.element.querySelector('[data-guidance-target]')!;
    this.notice = this.element.querySelector('[data-guidance-notice]')!;
    this.count = this.element.querySelector('[data-guidance-count]')!;
    this.availability = this.element.querySelector('[data-guidance-availability]')!;
    this.text.addEventListener('input', () => { this.draftRevision++; this.updateCount(); });
    this.kind.addEventListener('change', () => { this.renderTargets(''); this.selectTarget(); });
    this.target.addEventListener('change', () => this.selectTarget());
    this.element.addEventListener('click', event => {
      if ((event.target as Element).closest('[data-guidance-confirm-version]')) { this.selectTarget(); this.focus(); }
    });
    this.element.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); void this.send(); });
    this.element.querySelector('[data-guidance-receipt-refresh]')!.addEventListener('click', () => void this.recover(false));
    this.element.querySelector('[data-guidance-retry]')!.addEventListener('click', () => void this.recover(true));
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
    this.kind.value = kind; this.renderTargets(id); this.selectTarget(); this.focus();
  }

  focus() { this.text.focus({ preventScroll: true }); }

  appendReference(text: string, notice = '知识引用已加入本地指导草稿，尚未发送') {
    const next = `${this.text.value}${this.text.value ? '\n\n' : ''}${text}`;
    if (next.length > this.text.maxLength) {
      this.notice.textContent = `指导最多 ${this.text.maxLength} 字符，引用未加入；请缩短草稿后重试。`;
      this.focus(); return false;
    }
    this.text.value = next;
    this.draftRevision++; this.updateCount(); this.focus();
    this.notice.textContent = notice;
    return true;
  }

  private updateCount() { this.count.textContent = `${this.text.value.length} / ${this.text.maxLength}`; }

  private selectTarget() {
    const task = this.kind.value === 'task' ? this.observation?.inspection.tasks.find(task => task.id === this.target.value) : undefined;
    this.taskRef = task ? { id: task.id, version: task.version } : undefined;
    this.draftRevision++; this.render();
  }

  private renderTargets(value = this.target.value) {
    const entries = this.kind.value === 'task' ? this.observation?.inspection.tasks.map(task => [task.id, `${task.id} · 任务`]) :
      this.kind.value === 'worker' ? this.observation?.inspection.workers.map(worker => [worker.id, `${worker.id} · ${worker.role}`]) : [['', 'Lead']];
    const options = [...(entries ?? [])];
    if (value && !options.some(([id]) => id === value)) options.push([value, `${value} · 已移除`]);
    const markup = options.map(([id, name]) => `<option value="${h(id)}">${h(name)}</option>`).join('');
    if (this.target.dataset.options !== markup) { this.target.innerHTML = markup; this.target.dataset.options = markup; }
    this.target.value = options.some(([id]) => id === value) ? value : options[0]?.[0] ?? '';
    this.target.disabled = this.kind.value === 'lead';
  }

  private targetIssue() {
    if (this.kind.value === 'task') {
      const task = this.observation?.inspection.tasks.find(task => task.id === this.target.value);
      if (!task) return '原任务已移除，请明确选择接收指导的任务。';
      if (this.taskRef?.id !== task.id || this.taskRef.version !== task.version) return '任务版本已变化，请核对指导内容，再确认当前任务版本。';
    }
    if (this.kind.value === 'worker' && !this.observation?.inspection.workers.some(worker => worker.id === this.target.value)) return '原 Agent 已移除，请明确选择接收方。';
    return undefined;
  }

  private render() {
    const issue = this.targetIssue(), task = this.kind.value === 'task' ? this.observation?.inspection.tasks.find(task => task.id === this.target.value) : undefined;
    patchSection(this.element.querySelector('[data-guidance-context]')!, this.kind.value === 'task' ? `${factList([
      ['任务', this.target.value], ['草稿任务版本', this.taskRef?.version], ['当前任务版本', task?.version],
    ])}${issue ? `<p class="collab-notice">${h(issue)}</p>${task ? '<button type="button" class="button" data-guidance-confirm-version data-focus-key="guidance-version">确认当前任务版本</button>' : ''}` : ''}` :
      issue ? `<p class="collab-notice">${h(issue)}</p>` : '');
    const pending = this.pending;
    patchSection(this.element.querySelector('[data-guidance-pending]')!, pending ? `<p class="collab-notice">指导 ${h(pending.input.id)} 的结果尚未确认，请先核对原提交。继续编辑的草稿会保留。${pending.missing ? '尚未找到回执；重试将保留原 ID、目标版本与内容。' : ''}</p><details class="collab-detail" data-detail-key="pending-guidance"><summary>待核对的原指导</summary>${codeBlock(pending.input)}</details>` : '');
    const check = this.element.querySelector<HTMLButtonElement>('[data-guidance-receipt-refresh]')!;
    const retry = this.element.querySelector<HTMLButtonElement>('[data-guidance-retry]')!;
    check.hidden = !pending; check.disabled = !this.connected || this.busy;
    retry.hidden = !pending?.missing; retry.disabled = !this.connected || !this.active || this.busy;
    const submit = this.element.querySelector<HTMLButtonElement>('[type="submit"]')!;
    submit.disabled = !this.connected || !this.active || !this.observation || this.busy || Boolean(pending || issue);
    submit.textContent = this.busy ? '发送中…' : '发送指导';
    submit.setAttribute('aria-busy', String(this.busy));
    this.updateCount();
    this.availability.textContent = this.busy ? '正在处理本次提交，请稍候。' :
      pending ? '请先核对原提交的回执；当前草稿会保留。' :
      !this.connected ? '连接恢复后才能发送指导；草稿会保留。' :
      !this.active ? '运行尚未开始或已结束，暂时无法发送指导。' :
      !this.observation ? '正在等待当前运行的观察记录，收到后即可发送。' :
      issue ?? '指导会发送给所选接收方；收到回执后可查看投递状态。';
    patchSection(this.element.querySelector('[data-collab-guidance-records]')!, [...this.records.values()].map(record => `<article class="collab-guidance-record"><div><strong>${h(record.recipient.kind)} ${h(record.recipient.id)}</strong><span class="badge">${h(statusLabel[record.status])}</span></div><p>${h(record.text)}</p><small>${h(record.id)} · ${h(record.updatedAt)}${record.deliveredTo?.length ? ` · 接收 ${h(record.deliveredTo.join(', '))}` : ''}</small>${record.taskRef ? `<p class="collab-help">任务 ${h(record.taskRef.id)} · 版本 ${h(record.taskRef.version)}</p>` : ''}<p class="collab-help">依据观察 #${record.observationRef.sequence} · ${h(record.observationRef.stateDigest)}</p>${record.reason ? `<p class="collab-help">${h(record.reason)}</p>` : ''}</article>`).join(''));
  }

  private remember(record: WebGuidanceRecord) {
    const old = this.records.get(record.id);
    if (old && (old.updatedAt > record.updatedAt || (old.status === 'delivered' || old.status === 'failed') && record.status !== old.status)) return;
    this.records.set(record.id, record);
  }

  private resolve(receipt: WebCommandResult) {
    const pending = this.pending;
    if (!pending || receipt.id !== pending.input.id || receipt.guidance && receipt.guidance.id !== pending.input.id) throw new Error('指导回执身份不匹配');
    if (receipt.guidance) this.remember(receipt.guidance);
    const record = this.records.get(receipt.id), status = record?.status ?? receipt.status, reason = record?.reason ?? receipt.reason;
    this.notice.textContent = `回执 ${receipt.id} · ${statusLabel[status] ?? status}${reason ? ` · ${reason}` : ''}`;
    if (['queued', 'delivered', 'deferred', 'failed', 'rejected'].includes(status)) {
      this.pending = undefined;
      if (['queued', 'delivered', 'deferred'].includes(status) && this.draftRevision === pending.draftRevision) { this.text.value = ''; this.draftRevision++; this.updateCount(); }
    } else { pending.missing = false; this.notice.textContent += '；指导草稿已保留'; }
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
      this.notice.textContent = pending.missing ? '尚未找到原指导回执，草稿已保留。' : `回执核对失败：${errorText(error)}；原提交与草稿已保留`;
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
        this.pending = undefined; this.notice.textContent = `${errorText(error)}；指导未提交，草稿已保留`;
      } else { this.notice.textContent = errorText(error); await this.readReceipt(pending); }
    }
  }

  private async send() {
    if (this.busy || this.pending || !this.active || !this.connected || !this.observation || this.targetIssue()) return;
    if (!this.text.value.trim()) { this.notice.textContent = '请填写指导内容'; return; }
    const kind = this.kind.value as WebGuidanceInput['recipient']['kind'];
    const pending: PendingGuidance = { input: {
      id: commandId(), recipient: { kind, ...(kind === 'lead' ? {} : { id: this.target.value }) },
      ...(kind === 'task' && this.taskRef ? { taskRef: { ...this.taskRef } } : {}), text: this.text.value,
      observationRef: { sequence: this.observation.sequence, stateDigest: this.observation.snapshot.stateDigest },
    }, draftRevision: this.draftRevision, missing: false };
    this.pending = pending; this.busy = true; this.notice.textContent = '正在提交指导'; this.render();
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
