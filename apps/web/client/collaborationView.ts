import type { WebRun } from '../shared';
import type { WebObservation, WebTaskSource, WebCheckReceipt, WebArchive } from '../collaboration';
import { isAcceptedRun } from '../presentation';
import { createElement, errorText, escapeHtml as h, patchSection, codeBlock, detailBlock, factList, type WebApi } from './collaborationUi';
import { TaskPlanEditor } from './taskPlanEditor';
import { KnowledgeView } from './knowledgeView';
import { TaskSourceComparison, taskSourceKey } from './taskSourceComparison';
import { GuidanceComposer } from './guidanceComposer';
import { recordedTask, ResearchProgressView, taskCheckKey } from './researchProgressView';
import { MathematicalChangesView } from './mathematicalChangesView';
import { ReviewView } from './reviewView';
import { CollaborationNavigation } from './collaborationNavigation';

type Task = WebObservation['inspection']['tasks'][number];
type TaskView = 'graph' | 'list';
type ScrollPosition = { top: number; left: number };
type ViewState = { element: HTMLElement; selectedTask: string; selectedVersion?: string; route: string; observation?: WebObservation; loading: boolean; observationError?: string; knowledge: KnowledgeView; guidance: GuidanceComposer; progress: ResearchProgressView; changes: MathematicalChangesView; reviews: ReviewView; navigation: CollaborationNavigation; guidanceReturnTask?: { id: string; version: string }; taskPositions: Record<TaskView, ScrollPosition>; taskListReturn?: { taskId: string; viewport: ScrollPosition; list: ScrollPosition }; archiveBusy: boolean; active: boolean; artifactRequest: number; sourceComparison?: TaskSourceComparison; scrollTop: number; scrollLeft: number; viewport?: HTMLElement; archives: WebArchive[]; taskRenderFrame?: number; taskSearchComposing: boolean; renderKey?: string };
const kindLabel: Record<string,string> = { research: '研究', sketch: '草图', lemma: '引理', goal: '原始目标' };
const statusLabel: Record<string,string> = { pending: '待调度', running: '进行中', blocked: '受阻', conditional: '有条件结果', delivered: '已交付', integrated: '已集成', completed: '已完成', none: '尚无证明', checked: '已记录检查', stale: '旧版本证据', unverified: '未验证', active: '继续', paused: '暂停', stopped: '停止', queued: '排队中', deliveredGuidance: '已送达', deferred: '暂缓', failed: '失败' };
const label = (value: string) => statusLabel[value] ?? value;
const taskState = (task: Task) => task.control === 'active' ? task.status : task.control;
const taskStates = ['pending', 'running', 'blocked', 'conditional', 'delivered', 'integrated', 'completed', 'paused', 'stopped'];
const dependencyClosure = (ids: readonly string[], tasks: readonly Task[]) => {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const selected = new Set(ids);
  const visit = (id: string) => { const task = byId.get(id); for (const dependency of task?.plannedDependencies ?? []) if (!selected.has(dependency)) { selected.add(dependency); visit(dependency); } };
  ids.forEach(visit); return selected;
};

export class CollaborationView {
  private views = new Map<string, ViewState>();
  private run?: WebRun;
  private current?: ViewState;
  private connected = false;
  private planEditor: TaskPlanEditor;
  constructor(private api: WebApi, private observed: (observation: WebObservation) => void) { this.planEditor = new TaskPlanEditor(api, observation => this.receive(observation)); }
  update(container?: HTMLElement, run?: WebRun, connected = false) {
    this.connected = connected;
    if (!container || !run) {
      if (this.current?.viewport?.contains(this.current.element)) { this.current.scrollTop = this.current.viewport.scrollTop; this.current.scrollLeft = this.current.viewport.scrollLeft; this.saveTaskReading(this.current); }
      this.current?.navigation.disconnect();
      this.current = undefined; this.run = undefined; return;
    }
    let view = this.views.get(run.id);
    if (!view) { view = this.create(run.id); this.views.set(run.id, view); }
    if (this.current !== view) {
      if (this.current?.viewport?.contains(this.current.element)) this.saveTaskReading(this.current);
      this.current?.navigation.disconnect();
    }
    this.run = run; this.current = view; view.active = run.status === 'running';
    view.archives = [...new Map([...view.archives, ...(run.archives ?? [])].map(archive => [archive.id, archive])).values()];
    this.renderArchives(view, run.id);
    const mounting = !container.contains(view.element);
    if (mounting) {
      container.replaceChildren(view.element);
      const viewport = container.closest<HTMLElement>('.detail-panel') ?? container;
      if (view.viewport !== viewport) viewport.addEventListener('scroll', () => { if (viewport.contains(view!.element)) { view!.scrollTop = viewport.scrollTop; view!.scrollLeft = viewport.scrollLeft; } }, { passive: true });
      view.viewport = viewport;
    }
    const renderKey = this.runRenderKey(run, connected, view.archives.length);
    const previousObservation = view.observation;
    let rendered = false;
    if (run.observation && (!previousObservation || run.observation.sequence > previousObservation.sequence)) {
      this.receive(run.observation, false); rendered = true;
    } else if (!view.observation) {
      this.render(view, run); rendered = true;
    } else if (view.renderKey !== renderKey) {
      this.render(view, run); rendered = true;
    }
    view.renderKey = renderKey;
    if (mounting && view.viewport) {
      const pane = this.taskPane(view, this.taskMode(view)), position = view.taskPositions[this.taskMode(view)];
      pane.scrollTop = position.top; pane.scrollLeft = position.left;
      view.viewport.scrollTop = view.scrollTop; view.viewport.scrollLeft = view.scrollLeft;
    }
    if (view.viewport && (mounting || rendered)) view.navigation.connect(view.viewport);
  }
  private runRenderKey(run: WebRun, connected: boolean, archiveCount: number) {
    return [run.id, run.status, run.phase, run.result?.status ?? '', isAcceptedRun(run), run.error ?? '', connected,
      archiveCount, ...((run.archives ?? []).map(archive => `${archive.id}:${archive.digest}`))].join('|');
  }
  private create(runId: string): ViewState {
    const element = createElement('div', 'collab-surface');
    const taskView: TaskView = matchMedia('(max-width:850px)').matches ? 'list' : 'graph';
    element.innerHTML = `<div class="collab-heading"><div><span class="collab-eyebrow">研究协作</span><h2>共同推进证明</h2></div><div class="collab-heading-actions"><button type="button" class="button" data-collab-refresh>刷新观察</button><button type="button" class="button" data-collab-plan disabled>编辑计划</button><button type="button" class="button" data-collab-archive disabled>归档知识</button></div></div><div data-collab-navigation></div><div data-collab-summary></div><p data-collab-observation class="collab-help"></p><p data-collab-status class="collab-help collab-operation-status" role="status"></p>
      <div data-collab-progress></div><div class="collab-layout"><section class="collab-map" data-task-view="graph"><div class="collab-section-heading"><h3>数学任务</h3><div class="collab-task-view" role="group" aria-label="任务显示方式"><button type="button" data-collab-task-view="graph" aria-pressed="true">依赖图</button><button type="button" data-collab-task-view="list" aria-pressed="false">任务列表</button></div></div><div class="collab-map-tools"><label class="sr-only" for="task-search-${h(runId)}">搜索任务、类型或负责人</label><input id="task-search-${h(runId)}" data-collab-task-search type="search" placeholder="搜索任务、类型或负责人"><label class="sr-only" for="route-${h(runId)}">筛选证明路线</label><select id="route-${h(runId)}" data-collab-route><option value="">全部路线</option></select><label class="sr-only" for="task-state-${h(runId)}">筛选任务状态</label><select id="task-state-${h(runId)}" data-collab-task-state><option value="">全部状态</option>${taskStates.map(state => `<option value="${state}">${h(label(state))}</option>`).join('')}</select></div><div class="collab-task-result"><span data-collab-task-count role="status"></span><button type="button" class="text-button" data-collab-task-reset hidden>清除筛选</button></div><div data-collab-task-selection class="collab-task-selection" hidden></div><div data-collab-routes class="collab-route-summary"></div><p class="collab-graph-legend collab-help">实线 AND 前置 · 虚线 OR 路线</p><div data-collab-task-empty class="collab-task-empty" hidden></div><div class="collab-graph-scroll" tabindex="0" data-focus-key="task-graph-scroll" aria-label="任务依赖图，可横向滚动"><div data-collab-graph class="collab-graph"></div></div><div data-collab-task-list class="collab-task-list" data-focus-key="task-list-scroll" tabindex="0" aria-label="任务列表"></div></section>
      <section class="collab-inspector"><div class="collab-section-heading"><h3>任务检查器</h3><div class="collab-inspector-actions"><button type="button" class="text-button" data-collab-back-to-list hidden>返回任务列表</button><button type="button" class="text-button" data-collab-guide-task data-focus-key="guide-task">指导此任务</button></div></div><div data-collab-inspector></div><div data-collab-artifact class="collab-artifact" aria-live="polite"></div></section></div>
      <div data-collab-reviews></div><div data-collab-math-changes></div><section class="collab-agents"><div class="collab-section-heading"><h3>Agent 分工</h3><span class="collab-help">固定角色 / 当前会话角色</span></div><div data-collab-agents class="collab-agent-list"></div></section>
      <div data-collab-deliveries></div><div data-collab-guidance></div>
      <div data-collab-records><section class="collab-edit-records"><div class="collab-section-heading"><h3>计划应用与重新检查</h3></div><div data-collab-edits></div></section><section class="collab-archives"><div class="collab-section-heading"><h3 tabindex="-1" data-collab-archives-heading>归档与知识目录</h3></div><div data-collab-archives></div></section></div>`;
    const components = {
      guidance: new GuidanceComposer(this.api, runId, observation => this.receive(observation)),
      progress: new ResearchProgressView(runId),
      changes: new MathematicalChangesView(runId, text => this.provideGuidance(view, () => view.guidance.appendReference(text, '数学变化引用已加入本地指导草稿，尚未发送'))),
      reviews: new ReviewView(runId, text => this.provideGuidance(view, () => view.guidance.appendReference(text, '审阅引用已加入本地指导草稿，尚未发送'))),
      knowledge: new KnowledgeView(this.api, text => this.provideGuidance(view, () => view.guidance.appendReference(text))),
    };
    element.querySelector('[data-collab-guidance]')!.replaceWith(components.guidance.element);
    element.querySelector('[data-collab-progress]')!.replaceWith(components.progress.overview);
    element.querySelector('[data-collab-deliveries]')!.replaceWith(components.progress.element);
    element.querySelector('[data-collab-math-changes]')!.replaceWith(components.changes.element);
    element.querySelector('[data-collab-reviews]')!.replaceWith(components.reviews.element);
    element.append(components.knowledge.element);
    const view: ViewState = { element, ...components, selectedTask: '', route: '', loading: false, taskSearchComposing: false,
      navigation: new CollaborationNavigation(element, runId, () => this.provideGuidance(view, () => view.guidance.focus())),
      taskPositions: { graph: { top: 0, left: 0 }, list: { top: 0, left: 0 } },
      archiveBusy: false, active: false, artifactRequest: 0, scrollTop: 0, scrollLeft: 0, archives: [] };
    element.querySelector<HTMLElement>('.collab-map')!.dataset.taskView = taskView;
    for (const button of element.querySelectorAll<HTMLButtonElement>('[data-collab-task-view]')) button.setAttribute('aria-pressed', String(button.dataset.collabTaskView === taskView));
    element.querySelector('[data-collab-navigation]')!.replaceWith(view.navigation.element);
    element.querySelector('[data-collab-refresh]')!.addEventListener('click', () => void this.refresh(runId, view, true));
    element.querySelector('[data-collab-plan]')!.addEventListener('click', () => { if (view.observation) this.planEditor.open(runId, view.observation, view.selectedTask); });
    element.querySelector('[data-collab-archive]')!.addEventListener('click', () => void this.archive(runId, view));
    element.querySelector('[data-collab-route]')!.addEventListener('change', event => { view.route = (event.target as HTMLSelectElement).value; this.renderTasks(view); });
    const taskSearch = element.querySelector<HTMLInputElement>('[data-collab-task-search]')!;
    taskSearch.addEventListener('compositionstart', () => { view.taskSearchComposing = true; });
    taskSearch.addEventListener('compositionend', () => { view.taskSearchComposing = false; this.scheduleTaskRender(view); });
    taskSearch.addEventListener('input', () => { if (!view.taskSearchComposing) this.scheduleTaskRender(view); });
    element.querySelector('[data-collab-task-state]')!.addEventListener('change', () => this.renderTasks(view));
    element.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button) return;
      if (button.dataset.collabTask) {
        const list = button.closest<HTMLElement>('[data-collab-task-list]');
        if (list && view.viewport) view.taskListReturn = { taskId: button.dataset.collabTask, viewport: { top: view.viewport.scrollTop, left: view.viewport.scrollLeft }, list: { top: list.scrollTop, left: list.scrollLeft } };
        const reveal = Boolean(list || button.closest('.collab-agent,.collab-research-overview,.collab-deliveries,.collab-math-changes,.collab-reviews') || button.closest('.collab-graph') && matchMedia('(max-width:1150px)').matches);
        this.selectTask(view, button.dataset.collabTask, button.dataset.taskVersion, reveal);
      }
      else if (button.dataset.collabTaskView) this.switchTaskView(view, button.dataset.collabTaskView as TaskView);
      else if (button.hasAttribute('data-collab-task-reset')) { this.resetTaskFilters(view); element.querySelector<HTMLInputElement>('[data-collab-task-search]')!.focus({ preventScroll: true }); }
      else if (button.hasAttribute('data-collab-task-show-selected')) { this.resetTaskFilters(view); this.revealSelectedTask(view); }
      else if (button.hasAttribute('data-collab-task-inspect-selected')) this.selectTask(view, view.selectedTask, view.selectedVersion, true);
      else if (button.hasAttribute('data-collab-back-to-list')) this.backToTaskList(view);
      else if (button.hasAttribute('data-task-current')) this.selectTask(view, view.selectedTask, undefined, true);
      else if (button.dataset.collabDeliveriesWorker) { view.progress.showForWorker(button.dataset.collabDeliveriesWorker); view.navigation.go('deliveries'); }
      else if (button.hasAttribute('data-collab-deliveries-task')) { view.progress.showForTask(view.selectedTask); view.navigation.go('deliveries'); }
      else if (button.hasAttribute('data-collab-changes-task')) { view.changes.showForTask(view.selectedTask); view.navigation.go('changes'); }
      else if (button.hasAttribute('data-collab-reviews-task')) { view.reviews.showForTask(view.selectedTask); view.navigation.go('reviews'); }
      else if (button.hasAttribute('data-collab-guide-task')) this.provideGuidance(view, () => view.guidance.guide('task', view.selectedTask));
      else if (button.dataset.collabGuideWorker) this.provideGuidance(view, () => view.guidance.guide('worker', button.dataset.collabGuideWorker!));
      else if (button.hasAttribute('data-collab-return')) {
        const task = view.guidanceReturnTask, selected = view.observation && recordedTask(view.observation, view.selectedTask, view.selectedVersion)?.task;
        if (task && (selected?.id !== task.id || selected.version !== task.version)) this.selectTask(view, task.id, task.version);
        view.navigation.back();
      } else if (button.hasAttribute('data-collab-show-archive')) {
        const heading = element.querySelector<HTMLElement>('[data-collab-archives-heading]')!;
        view.navigation.reveal(heading); heading.focus({ preventScroll: true });
      }
      else if (button.dataset.collabSource) {
        if (button.closest('.collab-deliveries')) this.selectTask(view, button.dataset.collabSource, button.dataset.sourceVersion, true);
        void this.readSource(runId, view, button.dataset.collabSource, button.dataset.sourceVersion!, button.dataset.sourceSnapshot);
      } else if (button.dataset.collabCheck) {
        const check = view.observation?.checks.find(check => taskCheckKey(check) === button.dataset.checkIdentity);
        if (button.closest('.collab-deliveries') && check) this.selectTask(view, check.taskId, check.taskVersion, true);
        void this.readCheck(runId, view, button.dataset.collabCheck, button.dataset.checkIdentity);
      }
    });
    return view;
  }
  private provideGuidance(view: ViewState, action: () => boolean | void): boolean {
    if (view.navigation.remember()) {
      const task = view.observation && recordedTask(view.observation, view.selectedTask, view.selectedVersion)?.task;
      view.guidanceReturnTask = task ? { id: task.id, version: task.version } : undefined;
    }
    const result = action();
    view.navigation.go('guidance'); view.guidance.focus();
    return result !== false;
  }
  private receive(observation: WebObservation, notify = true) {
    const view = this.views.get(observation.webRunId); if (!view || view.observation &&
      (observation.solverRunId !== view.observation.solverRunId || observation.sequence <= view.observation.sequence)) return;
    view.observation = observation; view.observationError = undefined; this.planEditor.update(observation);
    if (!view.selectedTask || !view.selectedVersion && !observation.inspection.tasks.some(task => task.id === view.selectedTask)) {
      view.selectedTask = observation.inspection.tasks.find(task => task.kind === 'goal')?.id ?? observation.inspection.tasks[0]?.id ?? '';
      view.selectedVersion = undefined;
      view.artifactRequest++; view.sourceComparison = undefined; patchSection(view.element.querySelector('[data-collab-artifact]')!, '');
    }
    if (view.sourceComparison) view.sourceComparison.update(observation.sources, observation.inspection.tasks.find(task => task.id === view.selectedTask)?.version ?? '当前计划已无此任务');
    if (this.run?.id === observation.webRunId) {
      this.render(view, this.run);
      view.renderKey = this.runRenderKey(this.run, this.connected, view.archives.length);
    }
    if (notify) this.observed(observation);
  }
  private selectTask(view: ViewState, id: string, version?: string, reveal = false) {
    const changed = view.selectedTask !== id || view.selectedVersion !== version;
    if (changed) {
      view.artifactRequest++; view.sourceComparison = undefined; patchSection(view.element.querySelector('[data-collab-artifact]')!, '');
    }
    view.selectedTask = id; view.selectedVersion = version;
    this.updateTaskSelection(view); this.renderInspector(view);
    if (changed) view.element.querySelector<HTMLElement>('.collab-inspector')!.scrollTop = 0;
    view.element.querySelector<HTMLButtonElement>('[data-collab-back-to-list]')!.hidden = !view.taskListReturn;
    if (this.run?.id === view.observation?.webRunId) this.updateKnowledge(view, this.run!);
    if (reveal) {
      const heading = view.element.querySelector<HTMLElement>('[data-inspected-task-heading]');
      const controls = view.element.querySelector<HTMLElement>('.collab-inspector > .collab-section-heading')!;
      if (heading) { view.navigation.reveal(controls); heading.focus({ preventScroll: true }); }
    }
  }
  private switchTaskView(view: ViewState, mode: TaskView) {
    const map = view.element.querySelector<HTMLElement>('.collab-map')!, previous = map.dataset.taskView as TaskView;
    view.taskPositions[previous] = { top: this.taskPane(view, previous).scrollTop, left: this.taskPane(view, previous).scrollLeft };
    map.dataset.taskView = mode;
    for (const button of map.querySelectorAll<HTMLButtonElement>('[data-collab-task-view]')) button.setAttribute('aria-pressed', String(button.dataset.collabTaskView === mode));
    this.taskPane(view, mode).scrollTop = view.taskPositions[mode].top; this.taskPane(view, mode).scrollLeft = view.taskPositions[mode].left;
    this.renderTasks(view, mode);
  }
  private taskMode(view: ViewState): TaskView {
    return matchMedia('(max-width:850px)').matches ? 'list' : view.element.querySelector<HTMLElement>('.collab-map')!.dataset.taskView as TaskView;
  }
  private taskPane(view: ViewState, mode: TaskView) {
    return view.element.querySelector<HTMLElement>(mode === 'graph' ? '.collab-graph-scroll' : '[data-collab-task-list]')!;
  }
  private saveTaskReading(view: ViewState) {
    const mode = this.taskMode(view), pane = this.taskPane(view, mode);
    view.taskPositions[mode] = { top: pane.scrollTop, left: pane.scrollLeft };
  }
  private resetTaskFilters(view: ViewState) {
    view.route = '';
    view.element.querySelector<HTMLSelectElement>('[data-collab-route]')!.value = '';
    view.element.querySelector<HTMLSelectElement>('[data-collab-task-state]')!.value = '';
    view.element.querySelector<HTMLInputElement>('[data-collab-task-search]')!.value = '';
    this.renderTasks(view);
  }
  private revealSelectedTask(view: ViewState) {
    const list = matchMedia('(max-width:850px)').matches || view.element.querySelector<HTMLElement>('.collab-map')!.dataset.taskView === 'list';
    const card = [...view.element.querySelectorAll<HTMLElement>(list ? '[data-collab-task-list] [data-collab-task]' : '.collab-graph [data-collab-task]')].find(node => node.dataset.collabTask === view.selectedTask);
    if (card) { view.navigation.reveal(card); card.focus({ preventScroll: true }); }
  }
  private backToTaskList(view: ViewState) {
    const origin = view.taskListReturn; if (!origin || !view.viewport || this.current !== view) return;
    if (!matchMedia('(max-width:850px)').matches && view.element.querySelector<HTMLElement>('.collab-map')!.dataset.taskView !== 'list') this.switchTaskView(view, 'list');
    const list = view.element.querySelector<HTMLElement>('[data-collab-task-list]')!;
    list.scrollTop = origin.list.top; list.scrollLeft = origin.list.left;
    view.viewport.scrollTop = origin.viewport.top; view.viewport.scrollLeft = origin.viewport.left;
    const card = [...list.querySelectorAll<HTMLElement>('[data-collab-task]')].find(node => node.dataset.collabTask === origin.taskId);
    const target = card ?? view.element.querySelector<HTMLInputElement>('[data-collab-task-search]')!;
    if (!card) view.navigation.reveal(target);
    target.focus({ preventScroll: true });
  }
  private async refresh(runId: string, view: ViewState, manual = false) {
    if (view.loading) return; view.loading = true;
    const status = view.element.querySelector('[data-collab-status]')!;
    if (manual) status.textContent = '正在刷新观察…';
    this.updateCommands(view);
    try {
      const { observation } = await this.api<{ observation: WebObservation | null }>(`/api/runs/${encodeURIComponent(runId)}/observation`);
      view.observationError = undefined;
      if (observation) this.receive(observation);
      if (manual) status.textContent = observation ? `观察已刷新 · #${view.observation?.sequence ?? observation.sequence}` : '运行尚未生成协作观察；原始源码、报告与活动可在上方查看。';
    } catch (error) {
      view.observationError = `观察读取失败：${errorText(error)}`;
      if (manual) status.textContent = view.observationError;
    }
    finally { view.loading = false; this.updateCommands(view); }
  }
  private render(view: ViewState, run: WebRun) {
    const observation = view.observation;
    const summary = view.element.querySelector<HTMLElement>('[data-collab-summary]')!;
    if (!observation) { patchSection(summary, '<div class="collab-empty">正在等待运行时任务计划。已有运行产物仍可从源码和报告查看。</div>'); return; }
    const inspection = observation.inspection;
    patchSection(summary, `<div class="collab-metrics"><div><span>证明任务</span><strong>${inspection.progress.checkedProofTasks} / ${inspection.tasks.filter(task => task.kind === 'lemma' || task.kind === 'goal').length}</strong><small>已记录检查</small></div><div><span>Agent</span><strong>${inspection.scheduling.working} / ${inspection.workers.length}</strong><small>实际工作中</small></div><div><span>最终验收 S3</span><strong class="${isAcceptedRun(run) ? 'collab-accepted' : ''}">${isAcceptedRun(run) ? '验收通过' : '尚未验收通过'}</strong><small>以完整报告独立判断</small></div></div>`);
    this.renderTasks(view); this.renderInspector(view); this.renderAgents(view); view.progress.update(observation); view.changes.update(observation); view.reviews.update(observation, run);
    patchSection(view.element.querySelector('[data-collab-edits]')!, inspection.edits.length ? inspection.edits.map(edit => `<article class="collab-edit"><strong>${h(edit.id)} · ${h(edit.status)}</strong>${factList([['基准版本',edit.baseVersion],['应用版本',edit.planVersion],['重新检查',edit.recheck?.status ?? '未记录'],['影响任务',edit.affectedTasks?.join(', ')]])}${edit.reason ? `<p>${h(edit.reason)}</p>` : ''}${edit.recheck ? detailBlock('各任务重新检查记录',edit.recheck,`edit-${edit.id}`) : ''}</article>`).join('') : '<p class="collab-help">尚无人工计划编辑记录</p>');
    this.updateKnowledge(view, run);
    this.updateCommands(view);
  }
  private updateKnowledge(view: ViewState, run: WebRun) {
    const inspection = view.observation?.inspection; if (!inspection) return;
    const task = view.observation && recordedTask(view.observation, view.selectedTask, view.selectedVersion)?.task;
    view.knowledge.update(run.knowledgeDigest ?? inspection.configuration.knowledgeDigest, run.knowledgeCatalogDigest, {
      environmentDigest: inspection.configuration.environmentDigest, problemId: inspection.problem.id,
      ...(task ? { task: { id: task.id, version: task.version, goal: task.type ?? task.objective } } : {}),
    });
  }
  private visibleTasks(view: ViewState) {
    const observation = view.observation; if (!observation) return [];
    const tasks = observation.inspection.tasks, route = observation.plan?.proofRoutes?.find(route => route.id === view.route);
    const ids = route ? dependencyClosure([route.targetTaskId,route.closingTaskId,...route.prerequisiteTaskIds],tasks) : undefined;
    if (view.route && !route) return [];
    const query = view.element.querySelector<HTMLInputElement>('[data-collab-task-search]')!.value.toLocaleLowerCase().trim();
    const state = view.element.querySelector<HTMLSelectElement>('[data-collab-task-state]')!.value;
    return tasks.filter(task => (!ids || ids.has(task.id)) && (!state || taskState(task) === state) && (!query || `${task.id}\n${task.objective}\n${task.type ?? ''}\n${task.owner ?? ''}\n${task.group}`.toLocaleLowerCase().includes(query)));
  }
  private scheduleTaskRender(view: ViewState) {
    if (view.taskRenderFrame !== undefined) return;
    view.taskRenderFrame = requestAnimationFrame(() => {
      view.taskRenderFrame = undefined;
      this.renderTasks(view);
    });
  }
  private renderTasks(view: ViewState, mode = this.taskMode(view)) {
    if (view.taskRenderFrame !== undefined) { cancelAnimationFrame(view.taskRenderFrame); view.taskRenderFrame = undefined; }
    const tasks = this.visibleTasks(view), observation = view.observation; if (!observation) return;
    const routes = (observation.plan?.proofRoutes ?? []).filter(route => !view.route || route.id === view.route);
    const routeSelect = view.element.querySelector<HTMLSelectElement>('[data-collab-route]')!;
    const missingRoute = Boolean(view.route && !routes.length);
    const options = '<option value="">全部路线</option>' + (observation.plan?.proofRoutes ?? []).map(route => `<option value="${h(route.id)}">${h(route.id)} → ${h(route.targetTaskId)}</option>`).join('') + (missingRoute ? `<option value="${h(view.route)}">${h(view.route)} · 已移除</option>` : '');
    if (routeSelect.dataset.options !== options) { routeSelect.innerHTML = options; routeSelect.dataset.options = options; routeSelect.value = view.route; }
    const count = view.element.querySelector('[data-collab-task-count]')!, countText = `显示 ${tasks.length} / ${observation.inspection.tasks.length} 个任务`;
    if (count.textContent !== countText) count.textContent = countText;
    const filtered = Boolean(view.route || view.element.querySelector<HTMLSelectElement>('[data-collab-task-state]')!.value || view.element.querySelector<HTMLInputElement>('[data-collab-task-search]')!.value.trim());
    view.element.querySelector<HTMLButtonElement>('[data-collab-task-reset]')!.hidden = !filtered;
    const empty = view.element.querySelector<HTMLElement>('[data-collab-task-empty]')!;
    empty.hidden = tasks.length > 0;
    patchSection(empty, observation.inspection.tasks.length ? '<strong>没有匹配的任务</strong><p>可以调整关键词、路线或状态，或清除筛选查看全部任务。</p>' : '<strong>尚无数学任务</strong><p>运行生成任务计划后会显示在这里。</p>');
    view.element.querySelector<HTMLElement>('.collab-map')!.dataset.taskEmpty = String(!tasks.length);
    this.renderTaskSelection(view, tasks, observation.inspection.tasks);
    patchSection(view.element.querySelector('[data-collab-routes]')!, missingRoute ? `<span>所选路线 ${h(view.route)} 已从当前计划移除，请选择其他路线或清除筛选。</span>` : routes.map(route => `<span><strong>OR ${h(route.id)}</strong>：(${h(route.prerequisiteTaskIds.join(' AND ') || '无额外前置')}) → ${h(route.closingTaskId)} → ${h(route.targetTaskId)}${(() => { const recorded = observation.inspection.mathematics.snapshot.routes.find(item => item.routeId === route.id); return recorded ? ` · ${recorded.ready ? '前置已就绪' : `等待 ${h(recorded.remainingPrerequisiteTaskIds.join(', ') || recorded.closingStatus)}`} · 连接 ${h(recorded.connection)}` : ''; })()}</span>`).join('') || '<span>当前计划按任务的 AND 前置依赖推进</span>');
    this.renderTaskCards(view, tasks, mode);
  }
  private renderTaskSelection(view: ViewState, tasks: readonly Task[], currentTasks: readonly Task[]) {
    const selectedCurrent = currentTasks.find(task => task.id === view.selectedTask);
    const historical = Boolean(view.selectedVersion && selectedCurrent?.version !== view.selectedVersion);
    const selection = view.element.querySelector<HTMLElement>('[data-collab-task-selection]')!;
    selection.hidden = !view.selectedTask || tasks.some(task => task.id === view.selectedTask && (!view.selectedVersion || task.version === view.selectedVersion));
    patchSection(selection, selection.hidden ? '' : `<p>检查器仍在查看 <strong>${h(view.selectedTask)}</strong>${historical ? ` 的历史合同 <code>${h(view.selectedVersion)}</code>` : '，该任务不在当前筛选结果中'}。</p><div><button type="button" class="text-button" data-collab-task-inspect-selected data-focus-key="task-inspect-selected">查看所选合同</button>${selectedCurrent && !historical ? '<button type="button" class="text-button" data-collab-task-show-selected data-focus-key="task-show-selected">显示所选任务</button>' : ''}</div>`);
  }
  private renderTaskCards(view: ViewState, tasks: readonly Task[], mode: TaskView) {
    const observation = view.observation!;
    if (mode === 'list') {
      const list = view.element.querySelector<HTMLElement>('[data-collab-task-list]')!;
      const byId = new Map([...list.querySelectorAll<HTMLButtonElement>(':scope > [data-collab-task]')].map(card => [card.dataset.collabTask!, card]));
      const retained = new Set(tasks.map(task => task.id));
      for (const [id, card] of byId) if (!retained.has(id)) { card.remove(); list.querySelector(`[data-collab-task-dependencies="${CSS.escape(id)}"]`)?.remove(); }
      let cursor: ChildNode | null = list.firstChild;
      for (const task of tasks) {
        let card = byId.get(task.id);
        if (!card) { card = document.createElement('button'); card.type = 'button'; }
        this.updateTaskCard(view, card, task, false);
        if (card !== cursor) list.insertBefore(card, cursor);
        cursor = card.nextSibling;
        let dependencies = list.querySelector<HTMLElement>(`[data-collab-task-dependencies="${CSS.escape(task.id)}"]`);
        if (!dependencies) { dependencies = createElement('p', 'collab-list-deps'); dependencies.dataset.collabTaskDependencies = task.id; }
        const dependencyText = `AND 前置：${task.plannedDependencies.join(', ') || '无'}`;
        if (dependencies.textContent !== dependencyText) dependencies.textContent = dependencyText;
        if (dependencies !== cursor) list.insertBefore(dependencies, cursor);
        cursor = dependencies.nextSibling;
      }
      return;
    }
    const allTasks = observation.inspection.tasks;
    const taskById = new Map(allTasks.map(task => [task.id, task]));
    const routes = observation.plan?.proofRoutes ?? [];
    const targets = new Map<string, string[]>();
    for (const route of routes) targets.set(route.targetTaskId, [...(targets.get(route.targetTaskId) ?? []), route.closingTaskId]);
    const levels = new Map<string,number>(), visiting = new Set<string>();
    const level = (task: Task): number => {
      if (levels.has(task.id)) return levels.get(task.id)!; if (visiting.has(task.id)) return 0;
      visiting.add(task.id);
      const inputs = [...task.plannedDependencies, ...(targets.get(task.id) ?? [])];
      const depth = inputs.reduce((max,id) => { const dependency = taskById.get(id); return dependency ? Math.max(max,level(dependency)+1) : max; },0);
      visiting.delete(task.id); levels.set(task.id,depth); return depth;
    };
    const positions = new Map<string,{x:number;y:number}>(), counts = new Map<number,number>();
    for (const task of allTasks) { const column = level(task), row = counts.get(column) ?? 0; counts.set(column,row+1); positions.set(task.id,{x:20+column*248,y:20+row*126}); }
    const width = Math.max(330,...[...positions.values()].map(point=>point.x+238)), height = Math.max(160,...[...positions.values()].map(point=>point.y+116));
    const path = (from:string,to:string,alternative:boolean) => { const a=positions.get(from),b=positions.get(to); if(!a||!b)return ''; const x=a.x+218,y=a.y+48,end=b.x,ey=b.y+48; return `<path class="${alternative?'collab-or-edge':'collab-and-edge'}" d="M ${x} ${y} C ${x+40} ${y}, ${end-40} ${ey}, ${end} ${ey}"/>`; };
    const visible = new Set(tasks.map(task => task.id));
    const edges = tasks.flatMap(task=>task.plannedDependencies.filter(id => visible.has(id)).map(id=>path(id,task.id,false))).join('') + routes.filter(route => visible.has(route.closingTaskId) && visible.has(route.targetTaskId)).map(route=>path(route.closingTaskId,route.targetTaskId,true)).join('');
    const graph = view.element.querySelector<HTMLElement>('[data-collab-graph]')!;
    if (graph.style.width !== `${width}px`) graph.style.width = `${width}px`;
    if (graph.style.height !== `${height}px`) graph.style.height = `${height}px`;
    let svg = graph.querySelector<SVGSVGElement>(':scope > svg.collab-edges');
    if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('collab-edges'); svg.setAttribute('aria-hidden', 'true'); graph.prepend(svg); }
    if (svg.getAttribute('width') !== String(width)) svg.setAttribute('width', String(width));
    if (svg.getAttribute('height') !== String(height)) svg.setAttribute('height', String(height));
    if (svg.dataset.markup !== edges) { svg.innerHTML = edges; svg.dataset.markup = edges; }
    const byId = new Map([...graph.querySelectorAll<HTMLButtonElement>(':scope > [data-collab-task]')].map(card => [card.dataset.collabTask!, card]));
    const retained = new Set(tasks.map(task => task.id));
    for (const [id, card] of byId) if (!retained.has(id)) card.remove();
    let cursor: ChildNode | null = svg.nextSibling;
    for (const task of tasks) {
      let card = byId.get(task.id);
      if (!card) { card = document.createElement('button'); card.type = 'button'; }
      this.updateTaskCard(view, card, task, true);
      const position = positions.get(task.id)!;
      if (card.style.left !== `${position.x}px`) card.style.left = `${position.x}px`;
      if (card.style.top !== `${position.y}px`) card.style.top = `${position.y}px`;
      if (card !== cursor) graph.insertBefore(card, cursor);
      cursor = card.nextSibling;
    }
  }
  private updateTaskCard(view: ViewState, card: HTMLButtonElement, task: Task, graph: boolean) {
    const selected = view.selectedTask === task.id && (!view.selectedVersion || view.selectedVersion === task.version);
    const content = `<span class="collab-task-top"><span>${h(kindLabel[task.kind])}</span><span>${h(label(taskState(task)))}</span></span><strong>${h(task.id)}</strong><span class="collab-task-objective">${h(task.objective)}</span><small>${h(task.owner ?? '待分配')} · ${h(label(task.proof.status))}</small>`;
    card.className = `collab-task${selected ? ' selected' : ''}`;
    card.dataset.collabTask = task.id; card.dataset.focusKey = `${graph ? 'graph' : 'list'}-${task.id}`;
    card.setAttribute('aria-pressed', String(selected));
    if (card.dataset.content !== content) { card.innerHTML = content; card.dataset.content = content; }
  }
  private updateTaskSelection(view: ViewState) {
    for (const card of view.element.querySelectorAll<HTMLButtonElement>('[data-collab-task]')) {
      const task = view.observation?.inspection.tasks.find(item => item.id === card.dataset.collabTask);
      const selected = Boolean(task && view.selectedTask === task.id && (!view.selectedVersion || view.selectedVersion === task.version));
      card.classList.toggle('selected', selected); card.setAttribute('aria-pressed', String(selected));
    }
    if (view.observation) this.renderTaskSelection(view, this.visibleTasks(view), view.observation.inspection.tasks);
  }
  private renderInspector(view: ViewState) {
    const observation = view.observation, record = observation && recordedTask(observation, view.selectedTask, view.selectedVersion), task = record?.task;
    const current = observation?.inspection.tasks.find(task => task.id === view.selectedTask);
    const guide = view.element.querySelector<HTMLButtonElement>('[data-collab-guide-task]')!;
    guide.disabled = !task || Boolean(record?.historical);
    if (!observation || !task) { patchSection(view.element.querySelector('[data-collab-inspector]')!, view.selectedVersion ? `<h4 data-inspected-task-heading data-focus-key="inspected-${h(view.selectedTask)}-${h(view.selectedVersion)}" tabindex="-1">${h(view.selectedTask)}</h4><p data-task-history-notice>所选任务合同未保留，不能以当前同名任务替代。</p><code data-inspected-task-version>${h(view.selectedVersion)}</code>${current ? '<button type="button" class="button" data-task-current>查看当前版本</button>' : ''}` : '<p class="collab-help">选择一个任务查看合同与证据</p>'); return; }
    const historical = record!.historical;
    const blockers = observation.inspection.mathematics.snapshot.blockers.filter(blocker => blocker.taskId === task.id && blocker.taskDigest === task.version);
    const sources = observation.sources.filter(source=>source.taskId===task.id && (!historical || source.taskVersion===task.version)), checks = observation.checks.filter(check=>check.taskId===task.id && (!historical || check.taskVersion===task.version));
    const plannedConsumers = observation.inspection.tasks.filter(consumer=>consumer.plannedDependencies.includes(task.id)).map(consumer=>consumer.id);
    const actualConsumers = observation.inspection.tasks.filter(consumer=>consumer.proof.actualReferences?.tasks?.some(reference => reference.taskId === task.id && reference.taskDigest === task.version)).map(consumer=>({taskId:consumer.id,taskVersion:consumer.version,references:consumer.proof.actualReferences}));
    patchSection(view.element.querySelector('[data-collab-inspector]')!, `<h4 data-inspected-task-heading data-focus-key="inspected-${h(task.id)}-${h(task.version)}" tabindex="-1">${h(task.id)} · ${h(kindLabel[task.kind])}</h4>${historical ? `<p class="collab-notice" data-task-history-notice>正在查看历史任务合同。${current ? `当前版本为 ${h(current.version)}` : '当前计划已无此任务'}；旧合同未保存完整调度历史。</p>${current ? '<button type="button" class="button" data-task-current data-focus-key="task-current">查看当前版本</button>' : ''}` : ''}<p>${h(task.objective)}</p><div class="collab-inspected-version"><span>${historical ? '历史任务版本' : '当前任务版本'}</span><code data-inspected-task-version>${h(task.version)}</code></div>${factList([
      ...(!historical ? [['负责人',task.owner],['任务状态',`${label(task.status)} / ${label(task.control)}`],['尝试次数',task.attempts]] as const : []),
      ['记录的证明状态',label(task.proof.status)],['本版本计划依赖 AND',task.plannedDependencies.join(', ')||'无'],
      ...(!historical ? [['计划消费者',plannedConsumers.join(', ')||'无']] as const : []),
    ])}<div class="collab-artifact-links"><button type="button" class="text-button" data-collab-deliveries-task>查看此任务交付</button><button type="button" class="text-button" data-collab-changes-task>查看此任务变化</button><button type="button" class="text-button" data-collab-reviews-task>查看此任务审阅</button></div><h5>精确类型</h5>${codeBlock(task.type??'本任务未提供类型')}${detailBlock('前提',task.premises,`premises-${task.id}-${task.version}`)}${detailBlock('实际证明引用',task.proof.actualReferences??'未记录',`refs-${task.id}-${task.version}`)}${detailBlock('实际消费者',actualConsumers,`consumers-${task.id}-${task.version}`)}${blockers.length?detailBlock('数学阻塞',blockers,`blockers-${task.id}-${task.version}`):''}${task.feedback?detailBlock('检查反馈',task.feedback,`feedback-${task.id}-${task.version}`):''}${task.finding?detailBlock('研究发现',task.finding,`finding-${task.id}-${task.version}`):''}${task.parkedBy.length?detailBlock('路线停放原因',{parkedBy:task.parkedBy,parkedRoutes:task.parkedRoutes},`parked-${task.id}-${task.version}`):''}
      <h5>源码与检查回执</h5><p class="collab-help">每份产物固定到其任务版本、commit 和环境。</p><div class="collab-artifact-links">${sources.map(source=>`<button type="button" class="button" data-collab-source="${h(source.taskId)}" data-source-version="${h(source.taskVersion)}" data-source-snapshot="${h(taskSourceKey(source))}" data-focus-key="source-${h(taskSourceKey(source))}">${source.taskVersion===current?.version?'当前':'历史'}源码 · ${h(source.file)} · ${h(source.commit.slice(0, 8))}</button>`).join('')}${!sources.some(source=>source.taskVersion===task.version)?`<button type="button" class="button" data-collab-source="${h(task.id)}" data-source-version="${h(task.version)}" data-focus-key="source-${h(task.id)}-${h(task.version)}">读取${historical ? '所选历史' : '当前'}版本源码</button>`:''}${checks.map(check=>`<button type="button" class="button" data-collab-check="${h(check.id)}" data-check-identity="${h(taskCheckKey(check))}" data-focus-key="check-${h(taskCheckKey(check))}">${check.taskVersion===current?.version?'当前':'历史'}检查 · ${h(check.id)}</button>`).join('')}</div>${checks.length?'':'<p class="collab-help">尚无已归档检查回执</p>'}`);
  }
  private renderAgents(view: ViewState) {
    const root = view.element.querySelector<HTMLElement>('[data-collab-agents]')!;
    const workers = view.observation?.inspection.workers ?? [];
    const byId = new Map([...root.querySelectorAll<HTMLElement>(':scope > .collab-agent')].map(card => [card.dataset.workerId!, card]));
    const retained = new Set(workers.map(worker => worker.id));
    for (const [id, card] of byId) if (!retained.has(id)) card.remove();
    let cursor: ChildNode | null = root.firstChild;
    for (const worker of workers) {
      let card = byId.get(worker.id);
      if (!card) {
        card = createElement('article', 'collab-agent'); card.dataset.workerId = worker.id;
        card.innerHTML = `<div class="collab-section-heading"><strong>${h(worker.id)}</strong><span class="collab-agent-actions"><button type="button" class="text-button" data-collab-deliveries-worker="${h(worker.id)}" data-focus-key="deliveries-worker-${h(worker.id)}">交付</button><button type="button" class="text-button" data-collab-guide-worker="${h(worker.id)}" data-focus-key="guide-worker-${h(worker.id)}">指导</button></span></div><span class="collab-eyebrow" data-worker-role></span><dl class="collab-facts" data-worker-facts><div><dt>调度</dt><dd data-worker-fact="scheduling"></dd></div><div><dt>会话阶段</dt><dd data-worker-fact="phase"></dd></div><div><dt>轮次</dt><dd data-worker-fact="turns"></dd></div></dl><div class="collab-agent-assignment"><span>当前任务</span><button type="button" class="text-button" data-worker-task></button></div><div data-worker-wait></div><div data-worker-failure></div><div data-worker-recovery></div>`;
      }
      const role = card.querySelector<HTMLElement>('[data-worker-role]')!;
      const roleText = `${worker.role} / ${worker.sessionRole??'无当前会话'}`; if (role.textContent !== roleText) role.textContent = roleText;
      const facts: Record<string, string> = { scheduling: worker.scheduling?.status ?? '未记录', phase: worker.phase, turns: String(worker.turns) };
      for (const [key, value] of Object.entries(facts)) { const node = card.querySelector<HTMLElement>(`[data-worker-fact="${key}"]`)!; if (node.textContent !== value) node.textContent = value; }
      const task = card.querySelector<HTMLButtonElement>('[data-worker-task]')!;
      task.hidden = !worker.task;
      if (worker.task) { task.dataset.collabTask = worker.task; task.dataset.focusKey = `agent-task-${worker.id}`; task.setAttribute('aria-label', `查看任务 ${worker.task}`); const text = `${worker.task} →`; if (task.textContent !== text) task.textContent = text; }
      else { delete task.dataset.collabTask; delete task.dataset.focusKey; task.removeAttribute('aria-label'); if (task.textContent !== '未分配') task.textContent = '未分配'; }
      patchSection(card.querySelector<HTMLElement>('[data-worker-wait]')!, worker.dispatchWait.status !== 'unknown' ? detailBlock(`等待原因 · ${worker.dispatchWait.status}`, worker.dispatchWait, `wait-${worker.id}`) : '');
      patchSection(card.querySelector<HTMLElement>('[data-worker-failure]')!, worker.lastFailure ? detailBlock('最近故障', worker.lastFailure, `failure-${worker.id}`) : '');
      patchSection(card.querySelector<HTMLElement>('[data-worker-recovery]')!, worker.recovery ? detailBlock('恢复状态', worker.recovery, `recovery-${worker.id}`) : '');
      if (card !== cursor) root.insertBefore(card, cursor);
      cursor = card.nextSibling;
    }
    if (!workers.length && !root.querySelector(':scope > .collab-help')) patchSection(root, '<p class="collab-help">尚无 Agent 调度记录</p>');
    else if (workers.length) root.querySelector(':scope > .collab-help')?.remove();
  }
  private updateCommands(view: ViewState) {
    const refresh = view.element.querySelector<HTMLButtonElement>('[data-collab-refresh]')!;
    refresh.disabled = !this.connected || view.loading;
    refresh.textContent = view.loading ? '刷新中…' : '刷新观察'; refresh.setAttribute('aria-busy', String(view.loading));
    view.element.querySelector<HTMLButtonElement>('[data-collab-plan]')!.disabled=!this.connected||!view.active||!view.observation?.plan;
    const archive = view.element.querySelector<HTMLButtonElement>('[data-collab-archive]')!;
    archive.disabled=!this.connected||!view.observation||view.archiveBusy;
    archive.textContent = view.archiveBusy ? '归档中…' : '归档知识'; archive.setAttribute('aria-busy', String(view.archiveBusy));
    const observation = view.observation;
    view.element.querySelector('[data-collab-observation]')!.textContent = view.observationError ?? (observation ? `观察 #${observation.sequence} · ${observation.observedAt} · 历史记录未重新运行 Lean · 源码 ${observation.coverage.sources} / 检查 ${observation.coverage.checks}` : '运行尚未生成协作观察，可从源码、报告和活动查看已有材料。');
    view.guidance.update(view.observation, view.active, this.connected);
    view.navigation.update(view.observation, this.connected, view.archives.length);
  }
  private beginArtifact(view: ViewState, title: string, loading: string) {
    const target = view.element.querySelector<HTMLElement>('[data-collab-artifact]')!;
    patchSection(target, `<h4 data-collab-artifact-heading tabindex="-1">${h(title)}</h4><div data-collab-artifact-body><p class="collab-help">${h(loading)}</p></div>`);
    const heading = target.querySelector<HTMLElement>('[data-collab-artifact-heading]')!;
    if (this.current === view) { view.navigation.reveal(heading); heading.focus({ preventScroll: true }); }
    return target.querySelector<HTMLElement>('[data-collab-artifact-body]')!;
  }
  private async readSource(runId:string,view:ViewState,taskId:string,version:string,snapshotKey?:string) {
    const request=++view.artifactRequest; view.sourceComparison = undefined;
    const target = this.beginArtifact(view, `源码 · ${taskId}`, '正在读取版本固定的源码');
    try {
      const recorded = snapshotKey ? view.observation?.sources.find(source => source.taskId === taskId && source.taskVersion === version && taskSourceKey(source) === snapshotKey) : undefined;
      const source = recorded ?? (await this.api<{source:WebTaskSource}>(`/api/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/source?version=${encodeURIComponent(version)}`)).source;
      if(request!==view.artifactRequest)return;
      if (source.taskId !== taskId || source.taskVersion !== version || snapshotKey && taskSourceKey(source) !== snapshotKey) throw new Error('读取结果与所选源码快照身份不同，未展示替代材料。');
      view.sourceComparison = new TaskSourceComparison(source, view.observation?.sources ?? [], view.observation?.inspection.tasks.find(task => task.id === taskId)?.version ?? '当前计划已无此任务');
      patchSection(target, '<div data-task-source-host></div>'); target.querySelector('[data-task-source-host]')!.replaceChildren(view.sourceComparison.element);
    }
    catch(error){if(request!==view.artifactRequest)return;patchSection(target,`<p class="collab-error">${h(errorText(error))}</p>`);}
  }
  private async readCheck(runId:string,view:ViewState,id:string,identity?:string) {
    const request=++view.artifactRequest; view.sourceComparison = undefined;
    const target = this.beginArtifact(view, `检查回执 · ${id}`, '正在读取检查回执');
    try {const {check}=await this.api<{check:WebCheckReceipt}>(`/api/runs/${encodeURIComponent(runId)}/checks/${encodeURIComponent(id)}`);if(request!==view.artifactRequest)return;if(check.id!==id||identity&&taskCheckKey(check)!==identity)throw new Error('读取结果与所选检查回执身份不同，未展示替代材料。');patchSection(target,`${factList([['任务',check.taskId],['任务版本',check.taskVersion],['commit',check.commit],['源码摘要',check.sourceDigest],['环境摘要',check.environmentDigest]])}${codeBlock(check.record)}`);}
    catch(error){if(request!==view.artifactRequest)return;patchSection(target,`<p class="collab-error">${h(errorText(error))}</p>`);}
  }
  private renderArchives(view: ViewState, runId: string) {
    patchSection(view.element.querySelector('[data-collab-archives]')!, view.archives.length ? view.archives.map(archive => `<article class="collab-archive" data-collab-archive-id="${h(archive.id)}"><div class="collab-section-heading"><strong>${h(archive.createdAt)}</strong><a class="button" data-collab-archive-download href="/api/runs/${encodeURIComponent(runId)}/archives/${encodeURIComponent(archive.id)}" download="theoremos-${h(runId)}-archive.json">下载归档包</a></div>${factList([['归档 ID',archive.id],['摘要',archive.digest],['源码 / 检查',`${archive.sources} / ${archive.checks}`],['知识目录',archive.catalogDigest ?? '无'],['事件覆盖',archive.coverage.events],['源码 / 检查覆盖',`${archive.coverage.sources} / ${archive.coverage.checks}`]])}<p class="collab-help">历史证据已保存；再次使用需要重新检查。</p></article>`).join('') : '<p class="collab-help">尚无已保存的归档</p>');
  }
  private async archive(runId:string,view:ViewState) {
    if(view.archiveBusy)return;view.archiveBusy=true;const status=view.element.querySelector<HTMLElement>('[data-collab-status]')!;this.updateCommands(view);
    status.textContent = '正在保存归档与知识目录…';
    try{const {archive}=await this.api<{archive:WebArchive}>(`/api/runs/${encodeURIComponent(runId)}/archive`,{method:'POST',body:'{}'});view.archives = [...view.archives.filter(item => item.id !== archive.id), archive];this.renderArchives(view, runId);patchSection(status,`已归档 ${h(archive.id)} · ${h(archive.digest)}${archive.catalogDigest?` · 知识目录 ${h(archive.catalogDigest)}`:''}；再次使用时需要重新检查 <button type="button" class="text-button" data-collab-show-archive>查看归档</button>`);await view.knowledge.refreshCatalogs();}
    catch(error){status.textContent=errorText(error);}finally{view.archiveBusy=false;this.updateCommands(view);}
  }
}
