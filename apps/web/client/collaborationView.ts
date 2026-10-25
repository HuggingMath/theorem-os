import type { WebRun } from '../shared';
import type { WebObservation, WebTaskSource, WebCheckReceipt, WebArchive } from '../collaboration';
import { isAcceptedRun } from '../presentation';
import { createElement, errorText, escapeHtml as h, patchSection, codeBlock, detailBlock, factList, observedTime, coverageLabel, type WebApi } from './collaborationUi';
import { TaskPlanEditor } from './taskPlanEditor';
import { KnowledgeView } from './knowledgeView';
import { TaskSourceComparison, taskSourceKey } from './taskSourceComparison';
import { GuidanceComposer } from './guidanceComposer';
import { recordedTask, ResearchProgressView, taskCheckKey } from './researchProgressView';
import { MathematicalChangesView } from './mathematicalChangesView';
import { ReviewView } from './reviewView';
import { CollaborationNavigation } from './collaborationNavigation';
import { compactGraphMetrics, compactGraphTasks, graphMetrics, layoutTaskGraph, type GraphEdge, type GraphLayout } from './taskGraphLayout';
import { renderTaskGraph, renderTaskList, type TaskCard } from './ui/TaskBoard';
import { renderAgentCards } from './ui/AgentCards';
import { renderProgressSummary, type Meter } from './ui/ProgressSummary';
import { renderTaskInspector } from './ui/TaskInspector';

type Task = WebObservation['inspection']['tasks'][number];
type TaskView = 'graph' | 'list';
type ScrollPosition = { top: number; left: number };
// Low enough for "fit" to show a large compact plan whole; card text is then a status overview.
const minGraphZoom = 0.3;
type ViewState = { element: HTMLElement; selectedTask: string; selectedVersion?: string; route: string; observation?: WebObservation; loading: boolean; observationError?: string; knowledge: KnowledgeView; guidance: GuidanceComposer; progress: ResearchProgressView; changes: MathematicalChangesView; reviews: ReviewView; navigation: CollaborationNavigation; guidanceReturnTask?: { id: string; version: string }; taskPositions: Record<TaskView, ScrollPosition>; taskListReturn?: { taskId: string; viewport: ScrollPosition; list: ScrollPosition }; archiveBusy: boolean; active: boolean; artifactRequest: number; sourceComparison?: TaskSourceComparison; scrollTop: number; scrollLeft: number; viewport?: HTMLElement; archives: WebArchive[]; taskRenderFrame?: number; taskSearchComposing: boolean; renderKey?: string; graphZoom: number; graphLayout?: { key: string; layout: GraphLayout } };
const kindLabel: Record<string,string> = { research: '研究', sketch: '草图', lemma: '引理', goal: '原始目标' };
const statusLabel: Record<string,string> = { pending: '待调度', running: '进行中', blocked: '受阻', conditional: '有条件结果', delivered: '已交付', integrated: '已集成', completed: '已完成', none: '尚无证明', checked: '已记录检查', stale: '旧版本证据', unverified: '未验证', active: '继续', paused: '暂停', stopped: '停止', queued: '排队中', deliveredGuidance: '已送达', deferred: '暂缓', failed: '失败' };
const label = (value: string) => statusLabel[value] ?? value;
const routeConnectionLabel: Record<string,string> = { 'closed-by-original-check': '已由原题检查连通', 'awaiting-original-check': '等待原题检查连通' };
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
    element.innerHTML = `<div class="collab-heading"><h2 class="sr-only">研究协作</h2><p data-collab-observation class="collab-help"></p><div class="collab-heading-actions"><button type="button" class="button" data-collab-refresh>刷新观察</button><button type="button" class="button" data-collab-plan disabled>编辑计划</button><button type="button" class="button" data-collab-archive disabled>归档知识</button></div></div><div data-collab-navigation></div><div data-collab-summary></div><p data-collab-status class="collab-help collab-operation-status" role="status"></p>
      <div data-collab-progress></div><div class="collab-layout"><section class="collab-map" data-task-view="graph"><div class="collab-section-heading"><h3>数学任务</h3><div class="collab-task-view" role="group" aria-label="任务显示方式"><button type="button" data-collab-task-view="graph" aria-pressed="true">依赖图</button><button type="button" data-collab-task-view="list" aria-pressed="false">任务列表</button></div></div><div class="collab-map-tools"><label class="sr-only" for="task-search-${h(runId)}">搜索任务、类型或负责人</label><input id="task-search-${h(runId)}" data-collab-task-search type="search" placeholder="搜索任务、类型或负责人"><label class="sr-only" for="route-${h(runId)}">筛选证明路线</label><select id="route-${h(runId)}" data-collab-route><option value="">全部路线</option></select><label class="sr-only" for="task-state-${h(runId)}">筛选任务状态</label><select id="task-state-${h(runId)}" data-collab-task-state><option value="">全部状态</option>${taskStates.map(state => `<option value="${state}">${h(label(state))}</option>`).join('')}</select></div><div class="collab-task-result"><span data-collab-task-count role="status"></span><button type="button" class="text-button" data-collab-task-reset hidden>清除筛选</button></div><div data-collab-task-selection class="collab-task-selection" hidden></div><div data-collab-routes class="collab-route-summary"></div><div data-collab-task-empty class="collab-task-empty" hidden></div><div class="collab-graph-frame"><div class="collab-graph-scroll" tabindex="0" data-focus-key="task-graph-scroll" aria-label="任务依赖图，可滚动、拖动平移和缩放"><div data-collab-graph class="collab-graph"></div></div><div class="collab-graph-legend"><p class="collab-help"><span class="collab-legend-and">AND 前置</span><span class="collab-legend-or">OR 路线</span><span>悬停查看上下游 · 拖动平移 · Ctrl 或 ⌘ 加滚轮缩放</span></p><div class="collab-graph-zoom" role="group" aria-label="依赖图缩放"><button type="button" data-collab-graph-zoom="out" aria-label="缩小">−</button><button type="button" data-collab-graph-zoom="reset" aria-label="恢复 100%" data-collab-graph-zoom-level>100%</button><button type="button" data-collab-graph-zoom="in" aria-label="放大">+</button><button type="button" data-collab-graph-zoom="fit">适应</button></div></div></div><div data-collab-task-list class="collab-task-list" data-focus-key="task-list-scroll" tabindex="0" aria-label="任务列表"></div></section>
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
    const view: ViewState = { element, ...components, selectedTask: '', route: '', loading: false, taskSearchComposing: false, graphZoom: 1,
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
    this.bindGraphViewport(view, element.querySelector<HTMLElement>('.collab-graph-scroll')!);
    element.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button) return;
      if (button.dataset.collabTask) {
        const list = button.closest<HTMLElement>('[data-collab-task-list]');
        if (list && view.viewport) view.taskListReturn = { taskId: button.dataset.collabTask, viewport: { top: view.viewport.scrollTop, left: view.viewport.scrollLeft }, list: { top: list.scrollTop, left: list.scrollLeft } };
        const reveal = Boolean(list || button.closest('.collab-agent,.collab-research-overview,.collab-deliveries,.collab-math-changes,.collab-reviews') || button.closest('.collab-graph') && matchMedia('(max-width:1150px)').matches);
        this.selectTask(view, button.dataset.collabTask, button.dataset.taskVersion, reveal);
      }
      else if (button.dataset.collabTaskView) this.switchTaskView(view, button.dataset.collabTaskView as TaskView);
      else if (button.dataset.collabGraphZoom) this.zoomGraph(view, button.dataset.collabGraphZoom as 'in' | 'out' | 'reset' | 'fit');
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
    if (!observation) { renderProgressSummary(summary); return; }
    const inspection = observation.inspection;
    // Proof tasks split by recorded proof status first, then by scheduling state; checked uses the server's count.
    const proofTasks = inspection.tasks.filter(task => task.kind === 'lemma' || task.kind === 'goal');
    const proofState = (task: Task) => task.proof.status === 'checked' ? 'checked' : task.proof.status === 'conditional' ? 'conditional'
      : ['running', 'delivered', 'integrated'].includes(taskState(task)) ? 'running' : ['blocked', 'paused', 'stopped'].includes(taskState(task)) ? 'blocked' : 'pending';
    const proofCount = (state: string) => proofTasks.filter(task => proofState(task) === state).length;
    const scheduling = inspection.scheduling;
    const meter = (name: string, segments: [string, string, number][]): Meter => ({ name, segments: segments.map(([key, label, count]) => ({ key, label, count })) });
    renderProgressSummary(summary, {
      proof: { checked: inspection.progress.checkedProofTasks, total: proofTasks.length, meter: meter('proof', [['checked', '已检查', inspection.progress.checkedProofTasks],
        ['conditional', '有条件', inspection.progress.conditionalProofTasks], ['running', '进行中', proofCount('running')], ['blocked', '受阻或暂停', proofCount('blocked')], ['pending', '待调度', proofCount('pending')]]) },
      // Same aggregate as the headline; workers outside the recorded dispatch state are shown separately.
      agents: { working: scheduling.working, total: inspection.workers.length, meter: meter('agents', [['working', '工作中', scheduling.working], ['preparing', '准备中', scheduling.preparing],
        ['idle', '空闲', scheduling.idle], ['stopping', '停止中', scheduling.stopping], ['stopped', '已停止', scheduling.stopped],
        ['unscheduled', '未记录调度', Math.max(0, inspection.workers.length - scheduling.observedWorkers)]]) },
      accepted: isAcceptedRun(run), completedResearch: inspection.progress.completedResearchTasks,
    });
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
    patchSection(view.element.querySelector('[data-collab-routes]')!, missingRoute ? `<span>所选路线 ${h(view.route)} 已从当前计划移除，请选择其他路线或清除筛选。</span>` : routes.map(route => `<span><strong>OR ${h(route.id)}</strong>：(${h(route.prerequisiteTaskIds.join(' AND ') || '无额外前置')}) → ${h(route.closingTaskId)} → ${h(route.targetTaskId)}${(() => { const recorded = observation.inspection.mathematics.snapshot.routes.find(item => item.routeId === route.id); return recorded ? ` · ${recorded.ready ? '前置已就绪' : `等待 ${h(recorded.remainingPrerequisiteTaskIds.join(', ') || label(recorded.closingStatus))}`} · ${h(routeConnectionLabel[recorded.connection] ?? `连接 ${recorded.connection}`)}` : ''; })()}</span>`).join('') || '<span>当前计划按任务的 AND 前置依赖推进</span>');
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
      renderTaskList(view.element.querySelector<HTMLElement>('[data-collab-task-list]')!,
        tasks.map(task => ({ ...this.taskCard(view, task), dependencies: `AND 前置：${task.plannedDependencies.join(', ') || '无'}` })));
      return;
    }
    const allTasks = observation.inspection.tasks;
    const taskById = new Map(allTasks.map(task => [task.id, task]));
    const routes = observation.plan?.proofRoutes ?? [];
    const graphEdges: GraphEdge[] = [...allTasks.flatMap(task => task.plannedDependencies.filter(id => taskById.has(id)).map(id => ({ from: id, to: task.id, kind: 'and' as const }))),
      ...routes.filter(route => taskById.has(route.closingTaskId) && taskById.has(route.targetTaskId)).map(route => ({ from: route.closingTaskId, to: route.targetTaskId, kind: 'or' as const }))];
    // Layout covers every task so filtering never moves cards; it is recomputed only when the plan's structure changes.
    const layoutKey = JSON.stringify([allTasks.map(task => task.id), graphEdges.map(edge => [edge.from, edge.to, edge.kind])]);
    const compact = allTasks.length >= compactGraphTasks;
    if (view.graphLayout?.key !== layoutKey) view.graphLayout = { key: layoutKey, layout: layoutTaskGraph(allTasks.map(task => task.id), graphEdges, compact ? compactGraphMetrics : graphMetrics) };
    const { positions, width, height, independentTop } = view.graphLayout.layout;
    const visible = new Set(tasks.map(task => task.id));
    const edges = view.graphLayout.layout.paths.filter(({ edge }) => visible.has(edge.from) && visible.has(edge.to)).map(({ edge, d }) => ({ ...edge, d }));
    const graph = view.element.querySelector<HTMLElement>('[data-collab-graph]')!;
    if (graph.style.width !== `${width}px`) graph.style.width = `${width}px`;
    if (graph.style.height !== `${height}px`) graph.style.height = `${height}px`;
    graph.dataset.density = compact ? 'compact' : 'comfortable';
    this.applyGraphZoom(view);
    renderTaskGraph(graph, { cards: tasks.map(task => this.taskCard(view, task)), edges, positions, width, height, selected: view.selectedTask, compact, independentTop });
  }
  private bindGraphViewport(view: ViewState, pane: HTMLElement) {
    // Dragging empty space pans; cards keep their click behaviour and touch keeps native scrolling.
    let drag: { id: number; x: number; y: number; left: number; top: number } | undefined;
    pane.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'mouse' || event.button !== 0 || (event.target as Element).closest('button')) return;
      if (event.offsetX >= pane.clientWidth || event.offsetY >= pane.clientHeight) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: pane.scrollLeft, top: pane.scrollTop };
      pane.setPointerCapture(event.pointerId); pane.classList.add('panning'); pane.focus({ preventScroll: true }); event.preventDefault();
    });
    pane.addEventListener('pointermove', event => {
      if (drag?.id !== event.pointerId) return;
      pane.scrollLeft = drag.left - (event.clientX - drag.x); pane.scrollTop = drag.top - (event.clientY - drag.y);
    });
    pane.addEventListener('lostpointercapture', () => { drag = undefined; pane.classList.remove('panning'); });
    pane.addEventListener('wheel', event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      this.zoomGraph(view, view.graphZoom * Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015)), { x: event.clientX, y: event.clientY });
    }, { passive: false });
    pane.addEventListener('keydown', event => {
      if (event.target !== pane || event.altKey || event.ctrlKey || event.metaKey) return;
      const action = event.key === '+' || event.key === '=' ? 'in' : event.key === '-' ? 'out' : event.key === '0' ? 'reset' : undefined;
      if (action) { event.preventDefault(); this.zoomGraph(view, action); }
    });
  }
  // The pane's bottom padding keeps the floating legend clear of the last row; fit within what remains.
  private fitZoom(pane: HTMLElement, layout: GraphLayout) {
    const style = getComputedStyle(pane);
    const height = parseFloat(style.maxHeight) - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return Math.min(pane.clientWidth / layout.width, height / layout.height, 1);
  }
  private zoomGraph(view: ViewState, target: number | 'in' | 'out' | 'reset' | 'fit', anchor?: { x: number; y: number }) {
    const pane = view.element.querySelector<HTMLElement>('.collab-graph-scroll')!, layout = view.graphLayout?.layout;
    const previous = view.graphZoom;
    const next = target === 'in' ? previous * 1.2 : target === 'out' ? previous / 1.2 : target === 'reset' ? 1
      : target === 'fit' ? (layout ? this.fitZoom(pane, layout) : 1) : target;
    view.graphZoom = Math.min(1.6, Math.max(minGraphZoom, Math.round(next * 100) / 100));
    // Keep the point under the pointer (or the viewport centre) in place.
    const box = pane.getBoundingClientRect(), x = anchor ? anchor.x - box.left : pane.clientWidth / 2, y = anchor ? anchor.y - box.top : pane.clientHeight / 2;
    const contentX = (pane.scrollLeft + x) / previous, contentY = (pane.scrollTop + y) / previous;
    this.applyGraphZoom(view);
    if (target === 'fit') { pane.scrollLeft = 0; pane.scrollTop = 0; }
    else { pane.scrollLeft = contentX * view.graphZoom - x; pane.scrollTop = contentY * view.graphZoom - y; }
  }
  private applyGraphZoom(view: ViewState) {
    const graph = view.element.querySelector<HTMLElement>('[data-collab-graph]')!, value = view.graphZoom === 1 ? '' : String(view.graphZoom);
    if (graph.style.zoom !== value) graph.style.zoom = value;
    const level = view.element.querySelector<HTMLElement>('[data-collab-graph-zoom-level]')!, text = `${Math.round(view.graphZoom * 100)}%`;
    if (level.textContent !== text) level.textContent = text;
    for (const button of view.element.querySelectorAll<HTMLButtonElement>('[data-collab-graph-zoom="in"],[data-collab-graph-zoom="out"]'))
      button.disabled = button.dataset.collabGraphZoom === 'in' ? view.graphZoom >= 1.6 : view.graphZoom <= minGraphZoom;
  }
  private taskCard(view: ViewState, task: Task): TaskCard {
    const state = taskState(task);
    return { id: task.id, version: task.version, kind: task.kind, kindLabel: kindLabel[task.kind] ?? task.kind, state, stateLabel: label(state), objective: task.objective,
      owner: task.owner ?? '待分配', proof: task.proof.status, proofLabel: label(task.proof.status),
      selected: view.selectedTask === task.id && (!view.selectedVersion || view.selectedVersion === task.version) };
  }
  private updateTaskSelection(view: ViewState) {
    // Graph and list cards are component-rendered; other task links (agents, frontier, deliveries) are toggled here.
    for (const card of view.element.querySelectorAll<HTMLButtonElement>('[data-collab-task]')) {
      if (card.closest('[data-collab-graph],[data-collab-task-list],[data-collab-agents]')) continue;
      const task = view.observation?.inspection.tasks.find(item => item.id === card.dataset.collabTask);
      const selected = Boolean(task && view.selectedTask === task.id && (!view.selectedVersion || view.selectedVersion === task.version));
      card.classList.toggle('selected', selected); card.setAttribute('aria-pressed', String(selected));
    }
    if (view.observation) {
      const tasks = this.visibleTasks(view);
      this.renderTaskCards(view, tasks, this.taskMode(view)); this.renderAgents(view);
      this.renderTaskSelection(view, tasks, view.observation.inspection.tasks);
    }
  }
  private renderInspector(view: ViewState) {
    const observation = view.observation, record = observation && recordedTask(observation, view.selectedTask, view.selectedVersion), task = record?.task;
    const current = observation?.inspection.tasks.find(task => task.id === view.selectedTask);
    const guide = view.element.querySelector<HTMLButtonElement>('[data-collab-guide-task]')!;
    guide.disabled = !task || Boolean(record?.historical);
    const root = view.element.querySelector<HTMLElement>('[data-collab-inspector]')!;
    if (!observation || !task) {
      renderTaskInspector(root, view.selectedVersion ? { mode: 'missing', id: view.selectedTask, version: view.selectedVersion, hasCurrent: Boolean(current) } : { mode: 'empty' });
      return;
    }
    const historical = record!.historical;
    const blockers = observation.inspection.mathematics.snapshot.blockers.filter(blocker => blocker.taskId === task.id && blocker.taskDigest === task.version);
    const sources = observation.sources.filter(source=>source.taskId===task.id && (!historical || source.taskVersion===task.version)), checks = observation.checks.filter(check=>check.taskId===task.id && (!historical || check.taskVersion===task.version));
    const plannedConsumers = observation.inspection.tasks.filter(consumer=>consumer.plannedDependencies.includes(task.id)).map(consumer=>consumer.id);
    const actualConsumers = observation.inspection.tasks.filter(consumer=>consumer.proof.actualReferences?.tasks?.some(reference => reference.taskId === task.id && reference.taskDigest === task.version)).map(consumer=>({taskId:consumer.id,taskVersion:consumer.version,references:consumer.proof.actualReferences}));
    const facts: [string, unknown][] = [
      ...(!historical ? [['负责人',task.owner],['任务状态',`${label(task.status)} / ${label(task.control)}`],['尝试次数',task.attempts]] as [string, unknown][] : []),
      ['记录的证明状态',label(task.proof.status)],['本版本计划依赖 AND',task.plannedDependencies.join(', ')||'无'],
      ...(!historical ? [['计划消费者',plannedConsumers.join(', ')||'无']] as [string, unknown][] : []),
    ];
    const detail = (title: string, value: unknown, id: string) => ({ title, value, id: `${id}-${task.id}-${task.version}` });
    const state = taskState(task);
    renderTaskInspector(root, { mode: 'task', task: {
      id: task.id, version: task.version, kindLabel: kindLabel[task.kind] ?? task.kind, state, stateLabel: label(state), proof: task.proof.status,
      objective: task.objective, historical, ...(current ? { currentVersion: current.version } : {}),
      facts: facts.map(([name, value]) => ({ name, value: String(value ?? '未记录') })), type: task.type ?? '本任务未提供类型',
      details: [detail('前提', task.premises, 'premises'), detail('实际证明引用', task.proof.actualReferences ?? '未记录', 'refs'), detail('实际消费者', actualConsumers, 'consumers'),
        ...(blockers.length ? [detail('数学阻塞', blockers, 'blockers')] : []), ...(task.feedback ? [detail('检查反馈', task.feedback, 'feedback')] : []),
        ...(task.finding ? [detail('研究发现', task.finding, 'finding')] : []),
        ...(task.parkedBy.length ? [detail('路线停放原因', { parkedBy: task.parkedBy, parkedRoutes: task.parkedRoutes }, 'parked')] : [])],
      artifacts: [
        ...sources.map(source => ({ kind: 'source' as const, label: `${source.taskVersion===current?.version?'当前':'历史'}源码 · ${source.file} · ${source.commit.slice(0, 8)}`,
          attributes: { 'data-collab-source': source.taskId, 'data-source-version': source.taskVersion, 'data-source-snapshot': taskSourceKey(source), 'data-focus-key': `source-${taskSourceKey(source)}` } })),
        ...(!sources.some(source=>source.taskVersion===task.version) ? [{ kind: 'source' as const, label: `读取${historical ? '所选历史' : '当前'}版本源码`,
          attributes: { 'data-collab-source': task.id, 'data-source-version': task.version, 'data-focus-key': `source-${task.id}-${task.version}` } }] : []),
        ...checks.map(check => ({ kind: 'check' as const, label: `${check.taskVersion===current?.version?'当前':'历史'}检查 · ${check.id}`,
          attributes: { 'data-collab-check': check.id, 'data-check-identity': taskCheckKey(check), 'data-focus-key': `check-${taskCheckKey(check)}` } })),
      ],
      hasChecks: checks.length > 0,
    } });
  }
  private renderAgents(view: ViewState) {
    const workers = view.observation?.inspection.workers ?? [];
    renderAgentCards(view.element.querySelector<HTMLElement>('[data-collab-agents]')!, workers.map(worker => ({
      id: worker.id, role: `${worker.role} / ${worker.sessionRole ?? '无当前会话'}`, scheduling: worker.scheduling?.status ?? '未记录', schedulingStatus: worker.scheduling?.status ?? 'unknown',
      phase: worker.phase, turns: String(worker.turns), task: worker.task,
      details: [
        ...(worker.dispatchWait.status !== 'unknown' ? [{ title: `等待原因 · ${worker.dispatchWait.status}`, value: worker.dispatchWait, id: `wait-${worker.id}` }] : []),
        ...(worker.lastFailure ? [{ title: '最近故障', value: worker.lastFailure, id: `failure-${worker.id}` }] : []),
        ...(worker.recovery ? [{ title: '恢复状态', value: worker.recovery, id: `recovery-${worker.id}` }] : []),
      ],
    })));
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
    view.element.querySelector('[data-collab-observation]')!.textContent = view.observationError ?? (observation ? `观察 #${observation.sequence} · ${observedTime(observation.observedAt)} · 历史记录未重新运行 Lean · 源码${coverageLabel(observation.coverage.sources)} · 检查${coverageLabel(observation.coverage.checks)}` : '运行尚未生成协作观察，可从源码、报告和活动查看已有材料。');
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
