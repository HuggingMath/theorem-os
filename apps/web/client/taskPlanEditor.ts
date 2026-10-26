import type { WebObservation, WebPlanProposal, WebCommandResult, WebPlanTask, WebPlanGroup } from '../collaboration';
import { commandId, createElement, errorText, escapeHtml as h, jsonText, patchSection, codeBlock, editStatusLabel, type WebApi } from './collaborationUi';
import { t } from '../i18n';

type PlanDraft = { text: string; receipt?: WebCommandResult; previewText?: string; error?: string; notice?: string; submitted?: boolean;
  busy?: boolean; observation?: WebObservation; comparison?: WebObservation['plan']; pending?: { proposal: WebPlanProposal; missing?: boolean } };
const responseStatus = (error: unknown) => error && typeof error === 'object' && 'status' in error ? error.status : undefined;

/** A local full-plan proposal survives polling, tab switches, and version conflicts. */
export class TaskPlanEditor {
  private dialog = createElement('dialog', 'collab-plan-dialog');
  private drafts = new Map<string, PlanDraft>();
  private runId = '';
  private observation?: WebObservation;
  private taskId = '';
  private groupId = '';
  private routeId = '';
  private advanced: HTMLTextAreaElement;
  constructor(private api: WebApi, private observed: (observation: WebObservation) => void) {
    this.dialog.setAttribute('aria-label', t('编辑完整研究计划'));
    this.dialog.innerHTML = `<header class="collab-dialog-heading"><div><span class="collab-eyebrow">${t('研究计划')}</span><h2>${t('调整下一步工作')}</h2></div><button type="button" class="icon-button" data-plan-close aria-label="${t('关闭计划编辑器')}">×</button></header>
      <div class="collab-plan-content"><p class="collab-help">${t('计划包含全部任务与路线。提交应用后，受影响证明的重新检查会单独报告。')}</p><div data-plan-versions></div>
      <div class="collab-plan-common"><label class="collab-span-all">${t('任务')}<select data-plan-task aria-label="${t('编辑的任务')}"></select></label><label>${t('任务类型')}<select data-plan-kind aria-label="${t('任务类型')}"><option value="research">${t('研究')}</option><option value="sketch">${t('证明草图')}</option><option value="lemma">${t('引理')}</option><option value="goal" disabled>${t('原始目标')}</option></select></label><label>${t('负责人')}<select data-plan-owner aria-label="${t('任务负责人')}"></select></label><label>${t('调度状态')}<select data-plan-status aria-label="${t('任务调度状态')}"><option value="active">${t('继续')}</option><option value="paused">${t('暂停')}</option><option value="stopped">${t('停止')}</option></select></label>
      <label class="collab-span-all">${t('目标')}<textarea data-plan-objective rows="2" aria-label="${t('任务目标')}"></textarea></label><label class="collab-span-all">${t('AND 前置任务（逗号分隔）')}<input data-plan-dependencies aria-label="${t('任务前置依赖')}"></label>
      <label class="collab-span-all" data-plan-formal-type>${t('精确 Lean 类型')}<textarea data-plan-type rows="3" class="mono" spellcheck="false" aria-label="${t('任务精确类型')}" placeholder="${t('填写闭合的 Lean 类型')}"></textarea></label></div>
      <p class="collab-help" data-plan-task-note></p>
      <details class="collab-detail" data-plan-contract><summary>${t('前提、证明位置与共享范围')}</summary><div class="collab-plan-fields">
        <label class="collab-span-all">${t('前提（每行一条）')}<textarea data-plan-premises rows="3" aria-label="${t('任务前提')}"></textarea></label>
        <label>${t('任务分组')}<select data-plan-task-group aria-label="${t('任务分组')}"></select></label><label>${t('共享范围')}<select data-plan-sharing aria-label="${t('任务共享范围')}"><option value="">${t('运行时默认')}</option><option value="group">${t('本组')}</option><option value="problem">${t('整个问题')}</option></select></label>
        <label data-plan-proof-location>${t('Lean 文件')}<input data-plan-proof-path aria-label="${t('任务 Lean 文件')}" placeholder="Submission.lean"></label><label data-plan-proof-location>${t('声明名称')}<input data-plan-theorem aria-label="${t('任务声明名称')}" spellcheck="false"></label>
        <label class="collab-plan-check" data-plan-formal-option><input type="checkbox" data-plan-conditional>${t('允许记录有条件结果')}</label>
      </div></details>
      <div class="collab-plan-actions"><label>${t('新任务类型')}<select data-plan-new-kind aria-label="${t('新任务类型')}"><option value="lemma">${t('引理')}</option><option value="research">${t('研究')}</option><option value="sketch">${t('证明草图')}</option></select></label><button type="button" class="button" data-plan-add>${t('新增任务')}</button><button type="button" class="button" data-plan-remove-task>${t('删除所选任务')}</button></div>
      <details class="collab-detail" data-plan-routes open><summary>${t('OR 证明路线')}</summary><p class="collab-help">${t('同一目标的多条路线择一；单条路线内的前提全部满足。前提须已在收尾引理的 AND 依赖中，原题仍需独立检查。')}</p><label class="collab-plan-picker">${t('路线')}<select data-plan-route aria-label="${t('编辑的证明路线')}"></select></label><div class="collab-plan-fields" data-plan-route-fields>
        <label>${t('原始目标')}<select data-plan-route-target aria-label="${t('路线原始目标')}"></select></label><label>${t('收尾引理')}<select data-plan-route-closing aria-label="${t('路线收尾引理')}"></select></label>
        <label class="collab-span-all">${t('路线前提 AND（逗号分隔）')}<input data-plan-route-prerequisites aria-label="${t('路线前提引理')}"></label></div><div class="collab-plan-actions"><button type="button" class="button" data-plan-add-route>${t('新增路线')}</button><button type="button" class="button" data-plan-remove-route>${t('删除所选路线')}</button></div></details>
      <details class="collab-detail" data-plan-groups><summary>${t('任务分组与 Engineer')}</summary><label class="collab-plan-picker">${t('分组')}<select data-plan-group aria-label="${t('编辑的任务分组')}"></select></label><div class="collab-plan-fields" data-plan-group-fields>
        <label class="collab-span-all">${t('组目标')}<textarea data-plan-group-objective rows="2" aria-label="${t('分组目标')}"></textarea></label><label>Engineer<select data-plan-group-engineer aria-label="${t('分组 Engineer')}"></select></label>
        <label>${t('组调度状态')}<select data-plan-group-status aria-label="${t('分组调度状态')}"><option value="active">${t('继续')}</option><option value="paused">${t('暂停')}</option><option value="stopped">${t('停止')}</option></select></label>
        <label>${t('轮次上限')}<input type="number" min="0" step="1" data-plan-group-max-turns aria-label="${t('分组轮次上限')}" placeholder="${t('运行时默认')}"></label><label>${t('并发上限')}<input type="number" min="1" step="1" data-plan-group-max-concurrent aria-label="${t('分组并发上限')}" placeholder="${t('运行时默认')}"></label></div><p class="collab-help" data-plan-group-members></p><p class="collab-help" data-plan-responsibility-note></p><div class="collab-plan-actions"><button type="button" class="button" data-plan-add-group>${t('新增分组')}</button><button type="button" class="button" data-plan-remove-group>${t('删除所选分组')}</button></div></details>
      <details class="collab-detail" data-plan-advanced><summary>${t('高级：完整计划 JSON')}</summary><label class="sr-only" for="collab-plan-json">${t('完整计划 JSON')}</label><textarea id="collab-plan-json" class="collab-plan-json mono" spellcheck="false"></textarea></details>
      <div data-plan-comparison></div><div data-plan-receipt role="status" aria-live="polite"></div></div>
      <footer class="collab-dialog-footer"><button type="button" class="button" data-plan-receipt-refresh hidden>${t('核对提交回执')}</button><button type="button" class="button" data-plan-retry hidden>${t('重试原提交')}</button><button type="button" class="button" data-plan-current>${t('读取最新计划')}</button><button type="button" class="button" data-plan-rebase>${t('以最新版本重新预览')}</button><button type="button" class="button" data-plan-preview>${t('预览影响')}</button><button type="button" class="button button-primary" data-plan-apply disabled>${t('提交计划')}</button></footer>`;
    this.advanced = this.dialog.querySelector<HTMLTextAreaElement>('#collab-plan-json')!;
    document.body.append(this.dialog);
    this.dialog.querySelector('[data-plan-close]')!.addEventListener('click', () => this.dialog.close());
    this.advanced.addEventListener('input', () => { this.saveText(); this.renderStatus(); });
    this.advanced.addEventListener('change', () => this.renderCommon());
    this.dialog.querySelector('[data-plan-task]')!.addEventListener('change', event => { this.taskId = (event.target as HTMLSelectElement).value; this.renderCommon(); });
    for (const field of ['kind', 'owner', 'status', 'objective', 'dependencies', 'type', 'proof-path', 'theorem', 'premises', 'task-group', 'sharing', 'conditional']) this.dialog.querySelector(`[data-plan-${field}]`)!.addEventListener('input', () => this.editCommon(field));
    this.dialog.querySelector('[data-plan-add]')!.addEventListener('click', () => this.addTask());
    this.dialog.querySelector('[data-plan-remove-task]')!.addEventListener('click', () => this.removeTask());
    this.dialog.querySelector('[data-plan-route]')!.addEventListener('change', event => { this.routeId = (event.target as HTMLSelectElement).value; this.renderCommon(); });
    this.dialog.querySelector('[data-plan-group]')!.addEventListener('change', event => { this.groupId = (event.target as HTMLSelectElement).value; this.renderCommon(); });
    for (const field of ['target', 'closing', 'prerequisites']) this.control(`route-${field}`).addEventListener('input', () => this.editRoute(field));
    for (const field of ['objective', 'engineer', 'status', 'max-turns', 'max-concurrent']) this.control(`group-${field}`).addEventListener('input', () => this.editGroup(field));
    this.dialog.querySelector('[data-plan-add-route]')!.addEventListener('click', () => this.addRoute());
    this.dialog.querySelector('[data-plan-remove-route]')!.addEventListener('click', () => this.removeRoute());
    this.dialog.querySelector('[data-plan-add-group]')!.addEventListener('click', () => this.addGroup());
    this.dialog.querySelector('[data-plan-remove-group]')!.addEventListener('click', () => this.removeGroup());
    this.dialog.querySelector('[data-plan-current]')!.addEventListener('click', () => void this.readLatest(false));
    this.dialog.querySelector('[data-plan-rebase]')!.addEventListener('click', () => void this.readLatest(true));
    this.dialog.querySelector('[data-plan-preview]')!.addEventListener('click', () => void this.submit(false));
    this.dialog.querySelector('[data-plan-apply]')!.addEventListener('click', () => void this.submit(true));
    this.dialog.querySelector('[data-plan-receipt-refresh]')!.addEventListener('click', () => void this.recover(false));
    this.dialog.querySelector('[data-plan-retry]')!.addEventListener('click', () => void this.recover(true));
  }
  update(observation: WebObservation) {
    const draft = this.drafts.get(observation.webRunId);
    if (!draft || draft.observation && (observation.solverRunId !== draft.observation.solverRunId
      || observation.sequence < draft.observation.sequence)) return;
    draft.observation = observation;
    if (observation.webRunId === this.runId) this.observation = observation;
    const id = draft.pending?.proposal.id ?? draft.receipt?.id;
    const edit = observation.inspection.edits.find(edit => edit.id === id);
    if (edit) {
      const pending = draft.pending;
      draft.receipt = this.observedReceipt(draft, draft.receipt?.id === edit.id ? draft.receipt : { id: edit.id, status: 'unknown' });
      draft.pending = undefined;
      if (pending) {
        draft.error = undefined;
        draft.notice = t('提交回执不代表证明已重新检查，请在计划记录中查看应用状态与重新检查结果。');
      }
    }
    if (observation.webRunId === this.runId && this.dialog.open) {
      if (edit) this.renderStatus(); else this.renderVersions();
    }
  }
  open(runId: string, observation: WebObservation, taskId: string) {
    if (!observation.plan) return;
    this.runId = runId; this.taskId = taskId;
    if (!this.drafts.has(runId)) this.drafts.set(runId, { text: jsonText({ ...observation.plan, id: commandId() }) });
    this.update(observation);
    this.observation = this.draft().observation;
    this.advanced.value = this.draft().text;
    this.renderCommon(); this.renderVersions(); this.renderStatus();
    if (!this.dialog.open) this.dialog.showModal();
  }
  private draft() { return this.drafts.get(this.runId)!; }
  private parse(): WebPlanProposal {
    const value = JSON.parse(this.advanced.value) as WebPlanProposal;
    if (!value || !Array.isArray(value.tasks) || typeof value.baseVersion !== 'string' || !value.baseVersion || value.schema !== 'deepscientist.math.plan-edit.v1') throw new Error(t('需要含 baseVersion 的完整研究计划'));
    if (typeof value.id !== 'string' || !value.id) throw new Error(t('完整计划需要保留命令 id'));
    return value;
  }
  private saveText() {
    const draft = this.draft();
    if (draft.submitted) {
      try { const value = JSON.parse(this.advanced.value); value.id = commandId(); this.advanced.value = jsonText(value); } catch { /* Keep invalid local text editable. */ }
      draft.submitted = false;
    }
    draft.text = this.advanced.value; draft.previewText = undefined; draft.receipt = undefined; draft.error = undefined; draft.notice = undefined;
  }
  private setPlan(plan: WebPlanProposal) { this.advanced.value = jsonText(plan); this.saveText(); }
  private options(field: string, entries: readonly { id: string; label?: string }[], value: string, empty?: string) {
    const picker = this.control(field) as HTMLSelectElement;
    const retained = value && !entries.some(entry => entry.id === value) ? `<option value="${h(value)}">${t('{0} · 当前保留', h(value))}</option>` : '';
    const markup = (empty === undefined ? '' : `<option value="">${h(empty)}</option>`) + entries.map(entry => `<option value="${h(entry.id)}">${h(entry.label ?? entry.id)}</option>`).join('') + retained;
    if (picker.dataset.options !== markup) { picker.innerHTML = markup; picker.dataset.options = markup; }
    picker.value = value;
  }
  private groups(plan: WebPlanProposal): WebPlanGroup[] {
    return plan.groups?.length ? plan.groups : [{ id: 'main', objective: 'Prove the original problem', status: 'active', revision: 0 }];
  }
  private renderOwners(task: WebPlanTask) {
    const eligible = this.observation?.inspection.workers.filter(worker => worker.role === 'researcher' || worker.role === 'engineer' || worker.role === 'prover' && task.kind === 'lemma' && Boolean(task.type?.trim())) ?? [];
    this.options('owner', eligible.map(worker => ({ id: worker.id, label: `${worker.id} · ${worker.role}` })), task.ownerId ?? '', t('自动分配'));
  }
  private renderCommon() {
    try {
      const plan = this.parse();
      if (!plan.tasks.some(task => task.id === this.taskId)) this.taskId = plan.tasks[0]?.id ?? '';
      this.options('task', plan.tasks.map(task => ({ id: task.id, label: `${task.id} · ${task.kind}` })), this.taskId);
      const task = plan.tasks.find(task => task.id === this.taskId);
      if (task) {
        this.renderOwners(task);
        this.control('kind').value = task.kind;
        this.control('status').value = task.status ?? 'active'; this.control('objective').value = task.objective;
        this.control('dependencies').value = task.dependsOn.join(', ');
        this.control('type').value = task.kind === 'goal' ? this.observation?.inspection.tasks.find(item => item.id === task.id)?.type ?? task.type ?? '' : task.type ?? '';
        this.control('premises').value = (task.premises ?? []).join('\n');
        this.control('proof-path').value = task.proofPath ?? ''; this.control('theorem').value = task.theoremName ?? '';
        this.options('task-group', this.groups(plan), task.groupId ?? 'main');
        this.control('sharing').value = task.sharing ?? '';
        (this.control('conditional') as HTMLInputElement).checked = task.conditional ?? false;
      }
      this.renderGroups(plan); this.renderRoutes(plan); this.renderStatus();
    } catch (error) { this.draft().error = errorText(error); this.renderStatus(); }
  }
  private control(field: string) { return this.dialog.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-plan-${field}]`)!; }
  private editCommon(field: string) {
    try {
      const plan = this.parse(), index = plan.tasks.findIndex(task => task.id === this.taskId);
      const task = plan.tasks[index]; if (!task) return;
      const next = { ...task };
      if (field === 'kind') {
        if (task.kind === 'goal') return;
        next.kind = this.control(field).value as WebPlanTask['kind'];
        if (next.kind === 'research' || next.kind === 'sketch') {
          delete next.type; delete next.proofPath; delete next.theoremName; delete next.conditional; delete next.statementReview;
          delete next.declaration;
        } else {
          delete next.reviewScope;
          next.proofPath ??= plan.tasks.find(item => item.proofPath)?.proofPath ?? this.observation?.inspection.problem.targets[0]?.proofPath;
          next.theoremName ??= next.id; next.type ??= '';
        }
      }
      else if (field === 'owner') { next.ownerId = this.control(field).value || undefined; }
      else if (field === 'status') next.status = this.control(field).value as 'active' | 'paused' | 'stopped';
      else if (field === 'objective') next.objective = this.control(field).value;
      else if (field === 'dependencies') next.dependsOn = this.control(field).value.split(/[，,\s]+/u).filter(Boolean);
      else if (field === 'type') next.type = this.control(field).value || undefined;
      else if (field === 'proof-path') next.proofPath = this.control(field).value || undefined;
      else if (field === 'theorem') next.theoremName = this.control(field).value || undefined;
      else if (field === 'premises') next.premises = this.control(field).value.split(/\r?\n/u).filter(line => line.trim());
      else if (field === 'task-group') next.groupId = this.control(field).value;
      else if (field === 'sharing') next.sharing = this.control(field).value as WebPlanTask['sharing'] || undefined;
      else if (field === 'conditional') next.conditional = (this.control(field) as HTMLInputElement).checked;
      plan.tasks[index] = next; this.setPlan(plan); this.renderStatus();
      if (field === 'kind') this.renderCommon();
      else if (['type', 'task-group', 'sharing', 'owner'].includes(field)) { this.renderOwners(next); this.renderGroups(plan); this.renderRoutes(plan); }
    } catch (error) { this.draft().error = errorText(error); this.renderStatus(); }
  }
  private addTask() {
    try {
      const plan = this.parse(), kind = this.control('new-kind').value as 'lemma' | 'research' | 'sketch';
      let number = plan.tasks.length + 1;
      while (plan.tasks.some(task => task.id === `human_${kind}_${number}`)) number++;
      const id = `human_${kind}_${number}`;
      plan.tasks.push({ id, kind, objective: kind === 'lemma' ? t('填写引理目标') : t('填写研究目标'), dependsOn: [], revision: 0,
        groupId: this.groups(plan)[0].id,
        ...(kind === 'lemma' ? { theoremName: id, proofPath: plan.tasks.find(task => task.proofPath)?.proofPath ?? 'Submission.lean', type: '' } : {}) });
      this.taskId = id; this.setPlan(plan); this.renderCommon(); this.renderStatus();
    } catch (error) { this.draft().error = errorText(error); this.renderStatus(); }
  }
  private removeTask() {
    try {
      const plan = this.parse(), task = plan.tasks.find(task => task.id === this.taskId);
      if (!task || task.kind === 'goal') throw new Error(t('原始目标须保留，不能从计划中删除。'));
      const consumers = plan.tasks.filter(item => item.dependsOn.includes(task.id)).map(item => item.id);
      const routes = plan.proofRoutes?.filter(route => route.targetTaskId === task.id || route.closingTaskId === task.id || route.prerequisiteTaskIds.includes(task.id)).map(route => route.id) ?? [];
      if (consumers.length || routes.length) throw new Error(t('请先调整引用此任务的{0}{1}，再删除。', consumers.length ? t('任务：{0}', consumers.join(', ')) : '', routes.length ? t(' 路线：{0}', routes.join(', ')) : ''));
      plan.tasks = plan.tasks.filter(item => item.id !== task.id); this.setPlan(plan); this.renderCommon();
    } catch (error) { this.draft().error = errorText(error); this.renderStatus(); }
  }
  private renderGroups(plan: WebPlanProposal) {
    const groups = this.groups(plan);
    if (!groups.some(group => group.id === this.groupId)) this.groupId = groups[0].id;
    this.options('group', groups, this.groupId);
    const group = groups.find(group => group.id === this.groupId)!;
    this.control('group-objective').value = group.objective;
    this.control('group-status').value = group.status;
    this.options('group-engineer', (this.observation?.inspection.workers ?? []).filter(worker => worker.role === 'engineer'), group.engineerId ?? '', t('自动分配'));
    this.control('group-max-turns').value = group.maxTurns === undefined ? '' : String(group.maxTurns);
    this.control('group-max-concurrent').value = group.maxConcurrent === undefined ? '' : String(group.maxConcurrent);
    this.dialog.querySelector('[data-plan-group-members]')!.textContent = t('组内任务：{0}', plan.tasks.filter(task => (task.groupId ?? 'main') === group.id).map(task => task.id).join(', ') || t('无'));
    const conflicts = plan.tasks.filter(task => task.kind === 'goal' && task.ownerId && groups.find(group => group.id === (task.groupId ?? 'main'))?.engineerId && task.ownerId !== groups.find(group => group.id === (task.groupId ?? 'main'))?.engineerId);
    this.dialog.querySelector('[data-plan-responsibility-note]')!.textContent = conflicts.length ? t('请核对原始目标的分工：{0} 的负责人和组 Engineer 不同，无法同时满足调度要求。', conflicts.map(task => task.id).join(', ')) : '';
  }
  private editGroup(field: string) {
    try {
      const plan = this.parse(); plan.groups = this.groups(plan).map(group => ({ ...group }));
      const group = plan.groups.find(group => group.id === this.groupId)!;
      const value = this.control(`group-${field}`).value;
      if (field === 'objective') group.objective = value;
      else if (field === 'engineer') group.engineerId = value || undefined;
      else if (field === 'status') group.status = value as WebPlanGroup['status'];
      else {
        const number = value === '' ? undefined : Number(value);
        if (number !== undefined && (!Number.isSafeInteger(number) || number < (field === 'max-turns' ? 0 : 1))) throw new Error(field === 'max-turns' ? t('轮次上限须为非负整数。') : t('并发上限须为正整数。'));
        if (field === 'max-turns') group.maxTurns = number;
        else group.maxConcurrent = number;
      }
      this.setPlan(plan); this.renderStatus();
      if (field === 'engineer') this.renderGroups(plan);
    } catch (error) { this.draft().error = errorText(error); this.renderStatus(); }
  }
  private addGroup() {
    try {
      const plan = this.parse(); plan.groups = [...this.groups(plan)]; let number = 1;
      while (plan.groups.some(group => group.id === `human_group_${number}`)) number++;
      this.groupId = `human_group_${number}`;
      plan.groups.push({ id: this.groupId, objective: t('填写组目标'), status: 'active', revision: 0 });
      this.setPlan(plan); this.renderCommon();
    } catch (error) { this.draft().error = errorText(error); this.renderStatus(); }
  }
  private removeGroup() {
    try {
      const plan = this.parse(), groups = this.groups(plan), members = plan.tasks.filter(task => (task.groupId ?? 'main') === this.groupId);
      if (members.length) throw new Error(t('请先迁移组内任务：{0}，再删除分组。', members.map(task => task.id).join(', ')));
      if (groups.length < 2) throw new Error(t('计划至少需要保留一个任务分组。'));
      plan.groups = groups.filter(group => group.id !== this.groupId); this.setPlan(plan); this.renderCommon();
    } catch (error) { this.draft().error = errorText(error); this.renderStatus(); }
  }
  private renderRoutes(plan: WebPlanProposal) {
    const routes = plan.proofRoutes ?? [];
    if (!routes.some(route => route.id === this.routeId)) this.routeId = routes[0]?.id ?? '';
    this.options('route', routes, this.routeId, routes.length ? undefined : t('尚无替代路线'));
    const route = routes.find(route => route.id === this.routeId);
    this.options('route-target', plan.tasks.filter(task => task.kind === 'goal'), route?.targetTaskId ?? '', t('选择原始目标'));
    this.options('route-closing', plan.tasks.filter(task => task.kind === 'lemma' && task.type?.trim()), route?.closingTaskId ?? '', t('选择有精确类型的引理'));
    this.control('route-prerequisites').value = route?.prerequisiteTaskIds.join(', ') ?? '';
  }
  private editRoute(field: string) {
    try {
      const plan = this.parse(), route = plan.proofRoutes?.find(route => route.id === this.routeId); if (!route) return;
      const value = this.control(`route-${field}`).value;
      if (field === 'target') route.targetTaskId = value;
      else if (field === 'closing') route.closingTaskId = value;
      else route.prerequisiteTaskIds = value.split(/[，,\s]+/u).filter(Boolean);
      this.setPlan(plan); this.renderStatus();
    } catch (error) { this.draft().error = errorText(error); this.renderStatus(); }
  }
  private addRoute() {
    try {
      const plan = this.parse(), routes = plan.proofRoutes ?? [];
      const pair = plan.tasks.filter(task => task.kind === 'goal').flatMap(target => plan.tasks.filter(task => task.kind === 'lemma' && task.type?.trim()).map(closing => ({ target, closing }))).find(({ target, closing }) => !routes.some(route => route.targetTaskId === target.id && route.closingTaskId === closing.id));
      if (!pair) throw new Error(t('请先新增带精确 Lean 类型的引理，或选择尚未使用该收尾引理的原始目标，再建立路线。'));
      let number = 1; while (routes.some(route => route.id === `human_route_${number}`)) number++;
      this.routeId = `human_route_${number}`;
      plan.proofRoutes = [...routes, { id: this.routeId, targetTaskId: pair.target.id, closingTaskId: pair.closing.id, prerequisiteTaskIds: [] }];
      this.setPlan(plan); this.renderCommon();
    } catch (error) { this.draft().error = errorText(error); this.renderStatus(); }
  }
  private removeRoute() {
    try {
      const plan = this.parse(); plan.proofRoutes = (plan.proofRoutes ?? []).filter(route => route.id !== this.routeId);
      this.setPlan(plan); this.renderCommon();
    } catch (error) { this.draft().error = errorText(error); this.renderStatus(); }
  }
  private renderVersions() {
    let base = t('JSON 待修正'); try { base = this.parse().baseVersion; } catch { /* Shown beside the editor. */ }
    const latest = this.observation?.plan?.baseVersion;
    patchSection(this.dialog.querySelector('[data-plan-versions]')!, `<div class="collab-plan-version"><span>${t('草稿基于')} <code>${h(base)}</code></span><span>${t('当前')} <code>${h(latest ?? t('未记录'))}</code></span>${latest && latest !== base ? `<strong>${t('版本已变化 · 本地修改已保留')}</strong>` : ''}</div>`);
  }
  private renderStatus() {
    const draft = this.draft(), receipt = draft.receipt;
    patchSection(this.dialog.querySelector('[data-plan-receipt]')!, `${draft.error ? `<p class="collab-error">${h(draft.error)}</p>` : ''}${draft.notice ? `<p class="collab-help">${h(draft.notice)}</p>` : ''}${draft.pending ? `<p class="collab-notice">${t('提交 {0} 的结果尚未确认，请先核对原命令回执。当前草稿已保留。{1}', h(draft.pending.proposal.id), draft.pending.missing ? t('尚未找到回执；可重试原提交，重试会保留原命令内容和 ID。') : '')}</p><details class="collab-detail"><summary>${t('待核对的原提交')}</summary>${codeBlock(draft.pending.proposal)}</details>` : ''}${receipt ? `<p class="collab-notice">${t('回执 {0} · {1}{2}', h(receipt.id), h(editStatusLabel(receipt.status)), receipt.reason ? ` · ${h(receipt.reason)}` : '')}</p>${receipt.changes ? codeBlock(receipt.changes) : ''}${receipt.affectedTaskIds?.length ? `<p>${t('受影响任务：{0}', h(receipt.affectedTaskIds.join(', ')))}</p>` : ''}${receipt.edit?.recheck ? `<div data-plan-recheck><p>${h(editStatusLabel(receipt.edit.recheck.status))}</p><details class="collab-detail" data-detail-key="plan-recheck"><summary>${t('各任务重新检查记录')}</summary>${codeBlock(receipt.edit.recheck)}</details></div>` : ''}` : ''}`);
    patchSection(this.dialog.querySelector('[data-plan-comparison]')!, draft.comparison ? `<details class="collab-detail" open><summary>${t('当前服务器计划 · 本地草稿保留')}</summary>${codeBlock(draft.comparison)}</details>` : '');
    for (const control of this.dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input,textarea,select,button:not([data-plan-close])')) control.disabled = Boolean(draft.busy);
    let plan: WebPlanProposal | undefined;
    try { plan = this.parse(); } catch { /* Invalid JSON stays editable; stale form controls must not overwrite it. */ }
    if (!plan) for (const control of this.dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('.collab-plan-content input,.collab-plan-content select,.collab-plan-content textarea:not(#collab-plan-json),.collab-plan-content button')) control.disabled = true;
    const task = plan?.tasks.find(task => task?.id === this.taskId), formal = task?.kind === 'lemma' || task?.kind === 'goal';
    this.control('kind').disabled ||= task?.kind === 'goal' || !task;
    this.dialog.querySelector<HTMLButtonElement>('[data-plan-remove-task]')!.disabled ||= task?.kind === 'goal' || !task;
    for (const field of ['type', 'proof-path', 'theorem']) this.control(field).disabled ||= !formal || task?.kind === 'goal';
    this.control('conditional').disabled ||= !formal;
    this.dialog.querySelector<HTMLElement>('[data-plan-formal-type]')!.hidden = Boolean(task && !formal);
    for (const node of this.dialog.querySelectorAll<HTMLElement>('[data-plan-proof-location],[data-plan-formal-option]')) node.hidden = Boolean(task && !formal);
    this.dialog.querySelector('[data-plan-task-note]')!.textContent = task?.kind === 'goal' ? t('原始目标的类型、文件和声明名称固定；任务依赖与调度仍可调整。') : formal ? t('切换为研究或草图时，会清除本任务的证明位置、类型与证明专用选项。') : t('研究和草图产生提示性发现；切换为引理后需补充精确类型和证明位置。');
    const hasRoute = Boolean(plan?.proofRoutes?.some(route => route.id === this.routeId));
    for (const control of this.dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-plan-route-fields] input,[data-plan-route-fields] select')) control.disabled ||= !hasRoute;
    this.dialog.querySelector<HTMLButtonElement>('[data-plan-remove-route]')!.disabled ||= !hasRoute;
    const invalidField = Boolean(this.dialog.querySelector('input:invalid'));
    this.dialog.querySelector<HTMLButtonElement>('[data-plan-preview]')!.disabled ||= !plan || invalidField;
    this.dialog.querySelector<HTMLButtonElement>('[data-plan-apply]')!.disabled = Boolean(draft.busy || draft.pending || !plan || invalidField) || !receipt || draft.previewText !== draft.text || !['validated', 'previewed', 'ready'].includes(receipt.status);
    this.dialog.querySelector<HTMLButtonElement>('[data-plan-receipt-refresh]')!.hidden = !draft.pending;
    this.dialog.querySelector<HTMLButtonElement>('[data-plan-retry]')!.hidden = !draft.pending?.missing;
    this.renderVersions();
  }
  private receive(runId: string, observation: WebObservation) {
    if (observation.webRunId !== runId) return;
    this.update(observation);
    this.observed(observation);
  }
  private async readLatest(rebase: boolean) {
    const runId = this.runId, draft = this.draft(); if (draft.busy) return;
    let proposal: WebPlanProposal | undefined; draft.busy = true; this.renderStatus();
    try {
      if (rebase) proposal = this.parse();
      const { observation } = await this.api<{ observation: WebObservation | null }>(`/api/runs/${encodeURIComponent(runId)}/observation`);
      if (!observation?.plan) throw new Error(t('尚无可用研究计划'));
      this.receive(runId, observation);
      const latest = this.runId === runId ? this.observation! : observation;
      draft.comparison = latest.plan;
      if (proposal) {
        proposal.baseVersion = latest.plan!.baseVersion; proposal.id = commandId();
        draft.text = jsonText(proposal); draft.previewText = undefined; draft.receipt = undefined; draft.error = undefined; draft.submitted = false;
        if (this.runId === runId) { this.advanced.value = draft.text; this.renderCommon(); }
      }
    } catch (error) { draft.error = errorText(error); proposal = undefined; }
    finally { draft.busy = false; if (this.runId === runId) this.renderStatus(); }
    if (proposal) await this.requestPlan(runId, draft, proposal, false);
  }
  private async submit(apply: boolean) {
    const draft = this.draft(); if (draft.busy || apply && draft.pending) return;
    try {
      const proposal = this.parse();
      await this.requestPlan(this.runId, draft, proposal, apply);
    } catch (error) { draft.error = errorText(error); draft.previewText = undefined; this.renderStatus(); }
  }
  private recordReceipt(runId: string, draft: PlanDraft, receipt: WebCommandResult) {
    if (draft.pending && receipt.id !== draft.pending.proposal.id) throw new Error(t('命令回执身份不匹配'));
    if (receipt.observation) this.receive(runId, receipt.observation);
    draft.receipt = this.observedReceipt(draft, receipt); draft.error = undefined;
    if (draft.receipt.status !== 'unknown') draft.pending = undefined;
    else if (draft.pending) draft.pending.missing = false;
    draft.notice = t('提交回执不代表证明已重新检查，请在计划记录中查看应用状态与重新检查结果。');
  }
  private observedReceipt(draft: PlanDraft, receipt: WebCommandResult): WebCommandResult {
    const edit = draft.observation?.inspection.edits.find(edit => edit.id === receipt.id)
      ?? (draft.receipt?.id === receipt.id ? draft.receipt.edit : undefined) ?? receipt.edit;
    return edit ? { ...receipt, status: edit.status, reason: edit.reason, edit,
      baseVersion: edit.baseVersion ?? receipt.baseVersion, planVersion: edit.planVersion,
      affectedTaskIds: edit.affectedTasks ?? receipt.affectedTaskIds } : receipt;
  }
  private async requestPlan(runId: string, draft: PlanDraft, proposal: WebPlanProposal, apply: boolean) {
    const submittedText = draft.text; draft.busy = true; draft.error = undefined; draft.notice = undefined;
    const pending = apply ? { proposal: structuredClone(proposal) } : undefined;
    if (apply) { draft.submitted = true; draft.pending = pending; }
    if (this.runId === runId) this.renderStatus();
    try {
      const { receipt } = await this.api<{ receipt: WebCommandResult }>(`/api/runs/${encodeURIComponent(runId)}/edits${apply ? '' : '/preview'}`, { method: 'POST', body: JSON.stringify(proposal) });
      if (receipt.id !== proposal.id) throw new Error(t('命令回执身份不匹配'));
      if (apply) this.recordReceipt(runId, draft, receipt);
      else { if (receipt.observation) this.receive(runId, receipt.observation); draft.receipt = this.observedReceipt(draft, receipt); }
      draft.previewText = apply ? undefined : submittedText;
      if (apply && draft.pending) await this.readReceipt(runId, draft);
    } catch (error) {
      if (apply && draft.pending !== pending && draft.receipt?.id === proposal.id && draft.receipt.edit) return;
      draft.error = errorText(error); draft.previewText = undefined;
      const status = responseStatus(error);
      if (apply && typeof status === 'number' && status >= 400 && status < 500) draft.pending = undefined;
      else if (apply && draft.pending) await this.readReceipt(runId, draft);
    } finally { draft.busy = false; if (this.runId === runId) this.renderStatus(); }
  }
  private async readReceipt(runId: string, draft: PlanDraft) {
    const pending = draft.pending; if (!pending) return;
    try {
      const { receipt } = await this.api<{ receipt: WebCommandResult }>(`/api/runs/${encodeURIComponent(runId)}/commands/${encodeURIComponent(pending.proposal.id)}`);
      if (draft.pending !== pending) return true;
      this.recordReceipt(runId, draft, receipt); return true;
    } catch (error) {
      if (draft.pending !== pending) return true;
      pending.missing = responseStatus(error) === 404;
      draft.error = errorText(error); return false;
    }
  }
  private async recover(retryMissing: boolean) {
    const runId = this.runId, draft = this.draft(); if (draft.busy || !draft.pending) return;
    const proposal = draft.pending.proposal; draft.busy = true; this.renderStatus();
    let retry = false;
    try { const found = await this.readReceipt(runId, draft); retry = retryMissing && !found && Boolean(draft.pending?.missing); }
    finally { draft.busy = false; if (this.runId === runId) this.renderStatus(); }
    if (retry) await this.requestPlan(runId, draft, proposal, true);
  }
}
