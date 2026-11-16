import { webSkillWithoutCooperation } from '../researchMode';
import type { WebRun } from '../shared';
import type { WebObservation, WebTaskSource, WebCheckReceipt, WebArchive } from '../collaboration';
import { endedSummary, formatTokens, isAcceptedRun, isRejectedRun } from '../presentation';
import { Fragment, render, type ComponentChildren, type VNode } from 'preact';
import { clockTime, createElement, errorText, observedTime, coverageLabel, roleLabel, schedulingLabel, workerNames, workerPhaseLabel, dispatchWaitLabel, editStatusLabel, type WebApi } from './collaborationUi';
import { TaskPlanEditor } from './taskPlanEditor';
import { KnowledgeView } from './knowledgeView';
import { TaskSourceComparison, taskSourceKey } from './taskSourceComparison';
import { GuidanceComposer } from './guidanceComposer';
import { recordedTask, ResearchProgressView, taskCheckKey } from './researchProgressView';
import { MathematicalChangesView } from './mathematicalChangesView';
import { ReviewView } from './reviewView';
import { CollaborationNavigation, type CollaborationSection } from './collaborationNavigation';
import { detailLevel, onDetailLevel, setDetailLevel, type DetailLevel } from './detailLevel';
import { compactGraphMetrics, compactGraphTasks, graphMetrics, layoutTaskGraph, type GraphEdge, type GraphLayout } from './taskGraphLayout';
import { renderTaskGraph, renderTaskList, type TaskCard } from './ui/TaskBoard';
import { revealGraph } from './motion';
import { renderAgentCards } from './ui/AgentCards';
import { renderCollaborationNow } from './ui/CollaborationNow';
import { taskNames } from './agentRoute';
import { AgentActivity } from './agentActivity';
import { renderAgentRoute } from './ui/AgentRoute';
import { renderProgressSummary, type Meter } from './ui/ProgressSummary';
import { renderTaskInspector } from './ui/TaskInspector';
import { CollaborationSurface } from './ui/CollaborationSurface';
import { Code, Detail, Facts, Host, renderOptions, renderSection } from './ui/Section';
import { locale, localizeText, t } from '../i18n';

type Task = WebObservation['inspection']['tasks'][number];
export type CollaborationTaskSelection = Readonly<{ runId: string; taskId: string; taskVersion: string }>;
type TaskView = 'graph' | 'list';
type ScrollPosition = { top: number; left: number };
// Low enough for "fit" to show a large compact plan whole; card text is then a status overview.
const minGraphZoom = 0.3;
type ViewState = { element: HTMLElement; selectedTask: string; selectedVersion?: string; route: string; solverAttempt?: WebRun['solverAttempt']; observation?: WebObservation; loading: boolean; observationError?: string; knowledge: KnowledgeView; guidance: GuidanceComposer; progress: ResearchProgressView; changes: MathematicalChangesView; reviews: ReviewView; navigation: CollaborationNavigation; guidanceReturnTask?: { id: string; version: string }; taskPositions: Record<TaskView, ScrollPosition>; taskListReturn?: { taskId: string; viewport: ScrollPosition; list: ScrollPosition }; archiveBusy: boolean; active: boolean; artifactRequest: number; sourceComparison?: TaskSourceComparison; scrollTop: number; scrollLeft: number; viewport?: HTMLElement; archives: WebArchive[]; taskRenderFrame?: number; taskSearchComposing: boolean; renderKey?: string; routeKey?: string; graphZoom: number; graphLayout?: { key: string; layout: GraphLayout } };
export const kindLabel: Record<string,string> = { research: t('研究'), sketch: t('草图'), lemma: t('引理'), goal: t('原始目标') };
/** One status line for a run without a collaboration observation; the sections below need one to show anything. */
function unobservedText(run: WebRun) {
  if (run.status === 'queued') return t('任务排队中。开始运行后，这里显示 Agent 的任务计划和进展。');
  if (run.status === 'running') return t('正在等待运行时任务计划。已有运行产物仍可从 Lean 源码和报告查看。');
  return isAcceptedRun(run) ? t('这次运行没有留下协作观察记录。完整原题已通过独立 Lean 验收，证明和验收记录见 Lean 源码与报告。')
    : t('这次运行没有留下协作观察记录。已有的源码、报告和活动可在 Lean 源码、报告与活动中查看。');
}
const statusLabel: Record<string,string> = { pending: t('待调度'), running: t('进行中'), blocked: t('受阻'), conditional: t('有条件结果'), delivered: t('已交付'), integrated: t('已集成'), completed: t('已完成'), none: t('尚无证明'), checked: t('已记录检查'), stale: t('旧版本证据'), unverified: t('未验证'), active: t('继续'), paused: t('暂停'), stopped: t('停止'), queued: t('排队中'), deliveredGuidance: t('已送达'), deferred: t('暂缓'), failed: t('失败') };
const label = (value: string) => statusLabel[value] ?? value;
const routeConnectionLabel: Record<string,string> = { 'closed-by-original-check': t('已由原题检查连通'), 'awaiting-original-check': t('等待原题检查连通') };
const taskState = (task: Task) => task.control === 'active' ? task.status : task.control;
const usageCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
// Same rule as the runtime budget: cached input and reasoning output are subsets of input and output.
export const totalTokens = (usage?: Record<string, number>) => usageCount(usage?.totalTokens) ??
  (usageCount(usage?.inputTokens) !== undefined && usageCount(usage?.outputTokens) !== undefined ? usage!.inputTokens + usage!.outputTokens : undefined);
/** Chinese reads 万/亿 as the header does; English keeps the finer K/M a task card needs. */
export const tokenText = (value: number) => locale !== 'en' ? formatTokens(value)
  : value >= 1e6 ? `${(value / 1e6).toFixed(value >= 1e8 ? 0 : value >= 1e7 ? 1 : 2)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}K` : String(value);
const usageDetail = (usage: Record<string, number>) => {
  const input = usageCount(usage.inputTokens), cached = usageCount(usage.cachedInputTokens), output = usageCount(usage.outputTokens);
  return [input !== undefined && t('输入 {0}{1}', tokenText(input), cached ? t('（缓存命中 {0}）', tokenText(cached)) : ''),
    output !== undefined && t('输出 {0}', tokenText(output))].filter(Boolean).join(' · ');
};
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
  private taskSelection?: CollaborationTaskSelection;
  private taskSelectionListeners = new Set<(selection: CollaborationTaskSelection | undefined) => void>();
  private taskFeedback = new Map<string, Map<string, { total: number; attention: number }>>();
  private connected = false;
  private readOnly = false;
  private permissions: { guidance?: boolean; edit?: boolean; approve?: boolean; archive?: boolean } = {};
  private planEditor: TaskPlanEditor;
  // The workbench-wide choice (./detailLevel): new readers start with the simple layer, and opening any expert section keeps it full.
  private detail = detailLevel();
  private stopDetail: () => void;
  constructor(private api: WebApi, private observed: (observation: WebObservation) => void, private openReport: () => void = () => undefined,
    private activity = new AgentActivity(url => api(url))) {
    this.planEditor = new TaskPlanEditor(api, observation => this.receive(observation));
    this.stopDetail = onDetailLevel(level => this.applyLevel(level));
  }
  dispose() {
    this.stopDetail(); this.planEditor.dispose();
    for (const view of this.views.values()) {
      view.navigation.disconnect(); view.artifactRequest++;
      if (view.taskRenderFrame !== undefined) cancelAnimationFrame(view.taskRenderFrame);
      view.element.remove();
    }
    this.views.clear(); this.current = undefined; this.run = undefined;
    this.notifyTaskSelection(); this.taskSelectionListeners.clear(); this.taskFeedback.clear();
  }
  clearPlanDrafts() {
    this.planEditor.dispose();
    this.planEditor = new TaskPlanEditor(this.api, observation => this.receive(observation));
    this.planEditor.updateAccess({ runId: this.run?.id, status: this.run?.status, connected: this.connected, readOnly: this.readOnly, edit: this.permissions.edit });
  }
  /** Optional per-operation grants support a shared running view as well as the finished sample. */
  update(container?: HTMLElement, run?: WebRun, connected = false, readOnly = false,
    permissions: { guidance?: boolean; edit?: boolean; approve?: boolean; archive?: boolean } = {}) {
    this.connected = connected; this.readOnly = readOnly;
    this.permissions = run && webSkillWithoutCooperation(run) ? { ...permissions, guidance: false, edit: false, approve: false } : permissions;
    this.planEditor.updateAccess({ runId: container ? run?.id : undefined, status: run?.status, connected, readOnly, edit: this.permissions.edit });
    if (!container || !run) {
      if (this.current?.viewport?.contains(this.current.element)) { this.current.scrollTop = this.current.viewport.scrollTop; this.current.scrollLeft = this.current.viewport.scrollLeft; this.saveTaskReading(this.current); }
      this.current?.navigation.disconnect();
      this.current = undefined; this.run = undefined; this.notifyTaskSelection(); return;
    }
    let view = this.views.get(run.id);
    const before = view?.solverAttempt ?? (view?.observation && {
      solverRunId: view.observation.solverRunId, round: 0, sequence: view.observation.sequence });
    if (view && before && run.solverAttempt && run.solverAttempt.solverRunId !== before.solverRunId &&
      run.solverAttempt.round > before.round && run.solverAttempt.sequence >= before.sequence) {
      // Sources, reviews and pending editor responses belong to the old frozen problem. Dispose only
      // this run's surface; callbacks on its detached view cannot replace the next round's content.
      view.artifactRequest++; view.navigation.disconnect();
      if (view.taskRenderFrame !== undefined) cancelAnimationFrame(view.taskRenderFrame);
      this.planEditor.retireRun(run.id);
      this.views.delete(run.id); view = undefined;
    }
    if (!view) { view = this.create(run.id); this.views.set(run.id, view); }
    if (run.solverAttempt && (!view.solverAttempt || run.solverAttempt.solverRunId === view.solverAttempt.solverRunId &&
      run.solverAttempt.sequence >= view.solverAttempt.sequence)) view.solverAttempt = run.solverAttempt;
    if (this.current !== view) {
      if (this.current?.viewport?.contains(this.current.element)) this.saveTaskReading(this.current);
      this.current?.navigation.disconnect();
    }
    this.run = run; this.current = view; view.active = run.status === 'running';
    view.element.dataset.researchMode = run.researchMode ?? 'legacy';
    view.element.dataset.withoutCooperation = String(webSkillWithoutCooperation(run));
    view.element.dataset.ended = String(run.status !== 'queued' && run.status !== 'running');
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
    this.renderRoute(view, run);
    this.updateCommands(view);
    if (mounting && view.viewport) {
      const pane = this.taskPane(view, this.taskMode(view)), position = view.taskPositions[this.taskMode(view)];
      pane.scrollTop = position.top; pane.scrollLeft = position.left;
      view.viewport.scrollTop = view.scrollTop; view.viewport.scrollLeft = view.scrollLeft;
    }
    if (view.viewport && (mounting || rendered)) view.navigation.connect(view.viewport);
    this.notifyTaskSelection();
  }
  private runRenderKey(run: WebRun, connected: boolean, archiveCount: number) {
    return [run.id, run.status, run.phase, run.result?.status ?? '', isAcceptedRun(run), run.error ?? '', connected,
      archiveCount, ...((run.archives ?? []).map(archive => `${archive.id}:${archive.digest}`))].join('|');
  }
  private create(runId: string): ViewState {
    const element = createElement('div', 'collab-surface');
    const taskView: TaskView = matchMedia('(max-width:850px)').matches ? 'list' : 'graph';
    // Rendered once: the placeholders below are replaced by section elements or owned by their own renderers.
    render(<CollaborationSurface runId={runId} taskView={taskView} taskStates={taskStates.map(state => [state, label(state)] as const)} />, element);
    const components = {
      guidance: new GuidanceComposer(this.api, runId, observation => this.receive(observation)),
      progress: new ResearchProgressView(runId),
      changes: new MathematicalChangesView(runId, text => this.provideGuidance(view, () => view.guidance.appendReference(text, t('数学变化引用已加入本地指导草稿，尚未发送')))),
      reviews: new ReviewView(runId, text => this.provideGuidance(view, () => view.guidance.appendReference(text, t('审阅引用已加入本地指导草稿，尚未发送')))),
      knowledge: new KnowledgeView(this.api, text => this.provideGuidance(view, () => view.guidance.appendReference(text))),
    };
    element.querySelector('[data-collab-guidance]')!.replaceWith(components.guidance.element);
    element.querySelector('[data-collab-progress]')!.replaceWith(components.progress.overview);
    element.querySelector('[data-collab-deliveries]')!.replaceWith(components.progress.element);
    element.querySelector('[data-collab-math-changes]')!.replaceWith(components.changes.element);
    element.querySelector('[data-collab-reviews]')!.replaceWith(components.reviews.element);
    element.append(components.knowledge.element);
    const view: ViewState = { element, ...components, selectedTask: '', route: '', loading: false, taskSearchComposing: false, graphZoom: 1,
      navigation: new CollaborationNavigation(element, runId, () => this.provideGuidance(view, () => view.guidance.focus()),
        target => { if (this.detail === 'simple' && !target.getClientRects().length) this.setDetail('full'); }),
      taskPositions: { graph: { top: 0, left: 0 }, list: { top: 0, left: 0 } },
      archiveBusy: false, active: false, artifactRequest: 0, scrollTop: 0, scrollLeft: 0, archives: [] };
    element.querySelector('[data-collab-navigation]')!.replaceWith(view.navigation.element);
    this.applyDetail(element);
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
        // The simple layer shows the graph without its inspector, so opening a card there switches to the full layer.
        const reveal = Boolean(list || button.closest('.collab-now,.collab-agent,.collab-research-overview,.collab-deliveries,.collab-math-changes,.collab-reviews')
          || button.closest('.collab-graph') && (matchMedia('(max-width:1150px)').matches || this.detail === 'simple'));
        this.selectTask(view, button.dataset.collabTask, button.dataset.taskVersion, reveal);
      }
      else if (button.dataset.collabDetail) this.setDetail(button.dataset.collabDetail as DetailLevel, button);
      else if (button.hasAttribute('data-collab-open-report')) this.openReport();
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
      else if (button.hasAttribute('data-collab-guide-task')) {
        if (this.canGuideTask(view)) this.provideGuidance(view, () => view.guidance.guide('task', view.selectedTask));
      }
      else if (button.dataset.collabGuideWorker) this.provideGuidance(view, () => view.guidance.guide('worker', button.dataset.collabGuideWorker!));
      else if (button.hasAttribute('data-collab-return')) {
        const task = view.guidanceReturnTask, selected = this.selectedTaskRecord(view)?.task;
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
    if (this.readOnly || this.permissions.guidance === false) return false;
    if (view.navigation.remember()) {
      const task = this.selectedTaskRecord(view)?.task;
      view.guidanceReturnTask = task ? { id: task.id, version: task.version } : undefined;
    }
    const result = action();
    view.navigation.go('guidance'); view.guidance.focus();
    return result !== false;
  }
  private receive(observation: WebObservation, notify = true) {
    const view = this.views.get(observation.webRunId);
    const solverRunId = view?.solverAttempt?.solverRunId ?? view?.observation?.solverRunId;
    if (!view || solverRunId && solverRunId !== observation.solverRunId ||
      view.solverAttempt && observation.sequence < view.solverAttempt.sequence ||
      view.observation && observation.sequence <= view.observation.sequence) return;
    view.observation = observation; view.observationError = undefined; this.planEditor.update(observation);
    if (!view.selectedTask || view.selectedVersion === undefined && !observation.inspection.tasks.some(task => task.id === view.selectedTask)) {
      view.selectedTask = observation.inspection.tasks.find(task => task.kind === 'goal')?.id ?? observation.inspection.tasks[0]?.id ?? '';
      view.selectedVersion = undefined;
      view.artifactRequest++; view.sourceComparison = undefined; this.renderArtifact(view, null);
    }
    if (view.sourceComparison) view.sourceComparison.update(observation.sources, observation.inspection.tasks.find(task => task.id === view.selectedTask)?.version ?? t('当前计划已无此任务'));
    if (this.run?.id === observation.webRunId) {
      this.render(view, this.run);
      view.renderKey = this.runRenderKey(this.run, this.connected, view.archives.length);
    }
    if (notify) { this.notifyTaskSelection(); this.observed(observation); }
  }
  /** Switch every run's surface; a toggle keeps focus on its own button, the footer link hands it to the first expert heading. */
  private setDetail(detail: DetailLevel, origin?: HTMLButtonElement) {
    setDetailLevel(detail);
    if (origin?.closest('.collab-expand')) {
      const heading = this.current?.element.querySelector<HTMLElement>('.collab-map h3');
      if (heading) { heading.tabIndex = -1; this.current!.navigation.reveal(heading); heading.focus({ preventScroll: true }); }
    }
  }
  private applyLevel(detail: DetailLevel) {
    if (this.detail === detail) return;
    this.detail = detail;
    for (const view of this.views.values()) this.applyDetail(view.element);
    const view = this.current;
    if (view?.viewport) view.navigation.connect(view.viewport);
  }
  private applyDetail(element: HTMLElement) {
    element.dataset.detail = this.detail;
    for (const button of element.querySelectorAll<HTMLButtonElement>('.collab-detail-toggle [data-collab-detail]')) button.setAttribute('aria-pressed', String(button.dataset.collabDetail === this.detail));
  }
  /** Bring the guidance composer of the shown run into view and focus it, addressed to `taskId` when the latest observation
   * has that task and with `text` added to its draft; false when that run is not shown. */
  guide(runId: string, text?: string, notice?: string, taskId?: string): boolean {
    const view = this.views.get(runId);
    if (!view || this.current !== view) return false;
    return this.provideGuidance(view, () => {
      if (taskId && view.observation?.inspection.tasks.some(task => task.id === taskId)) view.guidance.guide('task', taskId);
      return text === undefined ? undefined : view.guidance.appendReference(text, notice);
    });
  }
  /** Open an existing collaboration section, expanding its reading layer when needed. */
  showSection(runId: string, section: CollaborationSection): boolean {
    const view = this.views.get(runId);
    if (!view || this.current !== view) return false;
    view.navigation.go(section);
    return true;
  }
  /** Scope declaration comparison to the requested task; an unreviewed task keeps an empty result. */
  showStatementReview(runId: string, taskId?: string): boolean {
    const view = this.views.get(runId);
    if (!view || this.current !== view) return false;
    view.reviews.showForTask(taskId);
    view.navigation.go('reviews');
    return true;
  }
  /** A note to the Lead about its plan, which it may revise before the plan is approved; false when that run is not shown. */
  guideLead(runId: string): boolean {
    const view = this.views.get(runId);
    if (!view || this.current !== view) return false;
    return this.provideGuidance(view, () => view.guidance.guideLead());
  }
  /** Open the plan editor of the shown run, as its 编辑计划 button does; false when that run is not shown or has no plan yet. */
  editPlan(runId: string): boolean {
    const view = this.views.get(runId);
    if (!view || this.current !== view || !view.observation?.plan || this.run && webSkillWithoutCooperation(this.run)) return false;
    this.planEditor.open(runId, view.observation, view.selectedTask);
    return true;
  }
  /** Receive the shown task's exact version immediately and whenever that selection changes. */
  onTaskSelection(listener: (selection: CollaborationTaskSelection | undefined) => void): () => void {
    this.taskSelectionListeners.add(listener);
    listener(this.currentTaskSelection());
    return () => this.taskSelectionListeners.delete(listener);
  }
  private currentTaskSelection(): CollaborationTaskSelection | undefined {
    const view = this.current;
    if (!this.run || !view?.observation || !view.selectedTask) return undefined;
    const taskVersion = view.selectedVersion ?? view.observation.inspection.tasks.find(task => task.id === view.selectedTask)?.version;
    return taskVersion === undefined ? undefined : { runId: this.run.id, taskId: view.selectedTask, taskVersion };
  }
  private notifyTaskSelection() {
    const next = this.currentTaskSelection(), previous = this.taskSelection;
    if (previous?.runId === next?.runId && previous?.taskId === next?.taskId && previous?.taskVersion === next?.taskVersion) return;
    this.taskSelection = next;
    for (const listener of this.taskSelectionListeners) listener(next);
  }
  /** Refresh card counts only when feedback changes; each count belongs to one exact task version. */
  setTaskFeedback(runId: string, feedback: readonly { taskId: string; taskVersion: string; total: number; attention: number }[]): void {
    const next = new Map(feedback.map(item => [JSON.stringify([item.taskId, item.taskVersion]), { total: item.total, attention: item.attention }]));
    const previous = this.taskFeedback.get(runId);
    if (!previous && !next.size || previous?.size === next.size && [...next].every(([key, value]) => {
      const before = previous.get(key);
      return before?.total === value.total && before?.attention === value.attention;
    })) return;
    this.taskFeedback.set(runId, next);
    const view = this.views.get(runId);
    if (!view?.observation) return;
    const mode = this.taskMode(view), pane = this.taskPane(view, mode);
    const top = pane.scrollTop, left = pane.scrollLeft, viewportTop = view.viewport?.scrollTop, viewportLeft = view.viewport?.scrollLeft;
    this.renderTaskCards(view, this.visibleTasks(view), mode);
    pane.scrollTop = top; pane.scrollLeft = left;
    if (view.viewport && viewportTop !== undefined && viewportLeft !== undefined) {
      view.viewport.scrollTop = viewportTop; view.viewport.scrollLeft = viewportLeft;
    }
  }
  /** Open the current task, or an exact version's inspector (including its missing state); false when the run is not shown. */
  showTask(runId: string, taskId: string, version?: string, commit?: string, reveal = true): boolean {
    const view = this.views.get(runId);
    if (!view || this.current !== view || !view.observation || version === undefined && !view.observation.inspection.tasks.some(task => task.id === taskId)) return false;
    this.selectTask(view, taskId, version, reveal);
    if (commit && version) void this.readSource(runId, view, taskId, version, undefined, commit);
    return true;
  }
  private selectedTaskRecord(view: ViewState) {
    const record = view.observation && recordedTask(view.observation, view.selectedTask, view.selectedVersion);
    return view.selectedVersion === undefined || record?.task.version === view.selectedVersion ? record : undefined;
  }
  private canGuideTask(view: ViewState): boolean {
    const record = this.selectedTaskRecord(view);
    return !this.readOnly && this.permissions.guidance !== false && this.connected && view.active &&
      Boolean(record && !record.historical);
  }
  private selectTask(view: ViewState, id: string, version?: string, reveal = false) {
    const changed = view.selectedTask !== id || view.selectedVersion !== version;
    if (changed) {
      view.artifactRequest++; view.sourceComparison = undefined; this.renderArtifact(view, null);
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
    this.notifyTaskSelection();
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
    if (manual) this.setStatus(view, t('正在刷新观察…'));
    this.updateCommands(view);
    try {
      const { observation } = await this.api<{ observation: WebObservation | null }>(`/api/runs/${encodeURIComponent(runId)}/observation`);
      view.observationError = undefined;
      if (observation) this.receive(observation);
      if (manual) this.setStatus(view, observation ? t('观察已刷新 · #{0}', view.observation?.sequence ?? observation.sequence) : t('仍没有协作观察记录。'));
    } catch (error) {
      view.observationError = t('观察读取失败：{0}', errorText(error));
      if (manual) this.setStatus(view, view.observationError);
    }
    finally { view.loading = false; this.updateCommands(view); }
  }
  private render(view: ViewState, run: WebRun) {
    const observation = view.observation;
    const summary = view.element.querySelector<HTMLElement>('[data-collab-summary]')!;
    view.element.dataset.observed = String(Boolean(observation));
    view.element.dataset.tasks = String(Boolean(observation?.inspection.tasks.length));
    this.renderRoute(view, run);
    if (!observation) { renderProgressSummary(summary, { empty: unobservedText(run) }); this.renderFocus(view, run); return; }
    const inspection = observation.inspection;
    // Proof tasks split by recorded proof status first, then by scheduling state; checked uses the server's count.
    const proofTasks = inspection.tasks.filter(task => task.kind === 'lemma' || task.kind === 'goal');
    const proofState = (task: Task) => task.proof.status === 'checked' ? 'checked' : task.proof.status === 'conditional' ? 'conditional'
      : ['running', 'delivered', 'integrated'].includes(taskState(task)) ? 'running' : ['blocked', 'paused', 'stopped'].includes(taskState(task)) ? 'blocked' : 'pending';
    const proofCount = (state: string) => proofTasks.filter(task => proofState(task) === state).length;
    const scheduling = inspection.scheduling;
    const meter = (name: string, segments: [string, string, number][]): Meter => ({ name, segments: segments.map(([key, label, count]) => ({ key, label, count })) });
    renderProgressSummary(summary, {
      proof: { checked: inspection.progress.checkedProofTasks, total: proofTasks.length, meter: meter('proof', [['checked', t('已检查'), inspection.progress.checkedProofTasks],
        ['conditional', t('有条件'), inspection.progress.conditionalProofTasks], ['running', t('进行中'), proofCount('running')], ['blocked', t('受阻或暂停'), proofCount('blocked')], ['pending', t('待调度'), proofCount('pending')]]) },
      // Same aggregate as the headline; workers outside the recorded dispatch state are shown separately.
      agents: { working: scheduling.working, total: inspection.workers.length, meter: meter('agents', [['working', t('工作中'), scheduling.working], ['preparing', t('准备中'), scheduling.preparing],
        ['idle', t('空闲'), scheduling.idle], ['stopping', t('停止中'), scheduling.stopping], ['stopped', t('已停止'), scheduling.stopped],
        ['unscheduled', t('未记录调度'), Math.max(0, inspection.workers.length - scheduling.observedWorkers)]]) },
      accepted: isAcceptedRun(run), rejected: isRejectedRun(run), completedResearch: inspection.progress.completedResearchTasks, ended: run.status !== 'queued' && run.status !== 'running',
    });
    this.renderNow(view, run); this.renderFocus(view, run);
    this.renderTasks(view); this.renderInspector(view); this.renderAgents(view); view.progress.update(observation); view.changes.update(observation); view.reviews.update(observation, run);
    renderSection(view.element.querySelector('[data-collab-edits]')!, inspection.edits.length ? <>{inspection.edits.map(edit => <article key={edit.id} class="collab-edit">
      <strong>{edit.id} · {editStatusLabel(edit.status)}</strong>
      <Facts facts={[[t('基准版本'), edit.baseVersion], [t('应用版本'), edit.planVersion], [t('重新检查'), editStatusLabel(edit.recheck?.status) ?? t('未记录')], [t('影响任务'), edit.affectedTasks?.join(', ')]]} />
      {edit.reason && <p>{edit.reason}</p>}{edit.recheck && <Detail title={t('各任务重新检查记录')} value={edit.recheck} detailKey={`edit-${edit.id}`} />}
    </article>)}</> : <p class="collab-help">{t('尚无人工计划编辑记录')}</p>);
    this.updateKnowledge(view, run);
    this.updateCommands(view);
  }
  /**
   * The simple layer's lead: the statement being proved, how far the proof is, and the one thing it is stuck on.
   * The full layer keeps the same facts in the goal and progress sections, so this block only exists there.
   */
  private renderFocus(view: ViewState, run: WebRun) {
    const root = view.element.querySelector<HTMLElement>('[data-collab-focus]')!;
    const observation = view.observation;
    root.hidden = !observation;
    if (!observation) { renderSection(root, null); return; }
    const inspection = observation.inspection, ended = run.status !== 'queued' && run.status !== 'running';
    // The cards above already count the proof tasks; this block answers only what a reader still asks: where it is stuck.
    const stuck = inspection.tasks.filter(task => (task.kind === 'goal' || task.kind === 'lemma') && ['blocked', 'paused', 'stopped'].includes(taskState(task)));
    const waiting = inspection.waiting?.reason && localizeText(inspection.waiting.reason).trim();
    const blocker = inspection.mathematics.snapshot.blockers.find(item => !['parked', 'superseded'].includes(item.status));
    const stuckBlock = waiting || blocker || stuck.length;
    root.hidden = !stuckBlock && !ended;
    if (!stuckBlock && !ended) { renderSection(root, null); return; }
    renderSection(root, <>
      {stuckBlock ? <div class="collab-focus-stuck" role="group" aria-label={t('卡在哪里')}>
        <strong>{t('卡在哪里')}</strong>
        {waiting && <p>{waiting}</p>}
        {!waiting && blocker && <p><code>{blocker.mechanism}</code>{inspection.tasks.some(task => task.id === blocker.taskId) && <> · <button type="button" class="text-button" data-collab-task={blocker.taskId} data-task-version={blocker.taskDigest}>{taskNames(inspection.tasks).get(blocker.taskId) ?? blocker.taskId}</button></>}</p>}
        {!waiting && !blocker && stuck.length > 0 && <ul class="collab-focus-blocked">{stuck.slice(0, 4).map(task => <li key={task.id}>
          <button type="button" class="text-button" data-collab-task={task.id} data-task-version={task.version}>{taskNames(inspection.tasks).get(task.id) ?? task.id}</button>
          <span>{(task.finding && localizeText(task.finding)) || (task.feedback && localizeText(task.feedback)) || label(taskState(task))}</span></li>)}</ul>}
      </div> : null}
      {ended && <p class="collab-focus-next">{isAcceptedRun(run) ? t('原题已通过；可以归档这次的知识，或在此基础上继续新的题目。')
        : t('这次运行结束时还没有通过验收的完整证明；证据保留在报告与源码中，可以在下方指导、提高预算后重跑，或从已有结果继续。')}</p>}
    </>);
  }
  private updateKnowledge(view: ViewState, run: WebRun) {
    const inspection = view.observation?.inspection; if (!inspection) return;
    const task = this.selectedTaskRecord(view)?.task;
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
    // Tasks are named by the lemma they prove, as on the cards; a task without one keeps its plan id.
    const theorems = taskNames(observation.inspection.tasks), named = (ids: readonly string[]) => ids.map(id => theorems.get(id) ?? id).join(t('、'));
    renderOptions(routeSelect, [['', t('全部路线')], ...(observation.plan?.proofRoutes ?? []).map(route => [route.id, `${route.id} → ${named([route.targetTaskId])}`] as const),
      ...(missingRoute ? [[view.route, t('{0} · 已移除', view.route)] as const] : [])], view.route);
    const count = view.element.querySelector('[data-collab-task-count]')!, countText = t('显示 {0} / {1} 个任务', tasks.length, observation.inspection.tasks.length);
    if (count.textContent !== countText) count.textContent = countText;
    const filtered = Boolean(view.route || view.element.querySelector<HTMLSelectElement>('[data-collab-task-state]')!.value || view.element.querySelector<HTMLInputElement>('[data-collab-task-search]')!.value.trim());
    view.element.querySelector<HTMLButtonElement>('[data-collab-task-reset]')!.hidden = !filtered;
    const empty = view.element.querySelector<HTMLElement>('[data-collab-task-empty]')!;
    empty.hidden = tasks.length > 0;
    renderSection(empty, observation.inspection.tasks.length ? <><strong>{t('没有匹配的任务')}</strong><p>{t('可以调整关键词、路线或状态，或清除筛选查看全部任务。')}</p></>
      : <><strong>{t('尚无数学任务')}</strong><p>{t('运行生成任务计划后会显示在这里。')}</p></>);
    view.element.querySelector<HTMLElement>('.collab-map')!.dataset.taskEmpty = String(!tasks.length);
    this.renderTaskSelection(view, tasks, observation.inspection.tasks);
    // Routes read as a chain of lemma names; a plan without alternative routes needs no line here (the graph shows its dependencies).
    const routeSummary = view.element.querySelector<HTMLElement>('[data-collab-routes]')!;
    routeSummary.hidden = !missingRoute && !routes.length;
    renderSection(routeSummary, missingRoute ? <span>{t('所选路线 {0} 已从当前计划移除，请选择其他路线或清除筛选。', view.route)}</span>
      : routes.length ? <>{routes.map(route => {
        const recorded = observation.inspection.mathematics.snapshot.routes.find(item => item.routeId === route.id);
        const progress = recorded ? ` · ${recorded.ready ? t('前置已就绪') : t('等待 {0}', named(recorded.remainingPrerequisiteTaskIds) || label(recorded.closingStatus))} · ${routeConnectionLabel[recorded.connection] ?? t('连接 {0}', recorded.connection)}` : '';
        const chain = [...(route.prerequisiteTaskIds.length ? [named(route.prerequisiteTaskIds)] : []), named([route.closingTaskId]), named([route.targetTaskId])].join(' → ');
        return <span key={route.id}><strong>{t('路线 {0}', route.id)}</strong>{t('：{0}{1}', chain, progress)}</span>;
      })}</> : null);
    this.renderTaskCards(view, tasks, mode);
  }
  private renderTaskSelection(view: ViewState, tasks: readonly Task[], currentTasks: readonly Task[]) {
    const selectedCurrent = currentTasks.find(task => task.id === view.selectedTask);
    const historical = view.selectedVersion !== undefined && selectedCurrent?.version !== view.selectedVersion;
    const selection = view.element.querySelector<HTMLElement>('[data-collab-task-selection]')!;
    selection.hidden = !view.selectedTask || tasks.some(task => task.id === view.selectedTask && (view.selectedVersion === undefined || task.version === view.selectedVersion));
    renderSection(selection, selection.hidden ? null : <>
      <p>{t('检查器仍在查看')} <strong>{view.selectedTask}</strong>{historical ? <> {t('的历史合同')} <code>{view.selectedVersion}</code>{t('{0}。', '')}</> : t('{0}。', t('，该任务不在当前筛选结果中'))}</p>
      <div><button type="button" class="text-button" data-collab-task-inspect-selected data-focus-key="task-inspect-selected">{t('查看所选合同')}</button>
        {selectedCurrent && !historical && <button type="button" class="text-button" data-collab-task-show-selected data-focus-key="task-show-selected">{t('显示所选任务')}</button>}</div>
    </>);
  }
  private renderTaskCards(view: ViewState, tasks: readonly Task[], mode: TaskView) {
    const observation = view.observation!;
    if (mode === 'list') {
      const theorems = taskNames(observation.inspection.tasks);
      renderTaskList(view.element.querySelector<HTMLElement>('[data-collab-task-list]')!,
        tasks.map(task => ({ ...this.taskCard(view, task, this.peakTokens(observation)), dependencies: task.plannedDependencies.length ? t('需先完成：{0}', task.plannedDependencies.map(id => theorems.get(id) ?? id).join(t('、'))) : '' })));
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
    // A plan without dependencies has no edges to explain and needs no canvas taller than its cards.
    const frame = graph.closest<HTMLElement>('.collab-graph-frame');
    if (frame && frame.dataset.edgeless !== String(!edges.length)) frame.dataset.edgeless = String(!edges.length);
    this.applyGraphZoom(view);
    const peak = this.peakTokens(observation);
    this.renderUsageLegend(view, observation);
    renderTaskGraph(graph, { cards: tasks.map(task => this.taskCard(view, task, peak)), edges, positions, width, height, selected: view.selectedTask, compact, independentTop });
    // Grow the graph once per mounted view, the first time it shows cards.
    if (!graph.dataset.revealed && tasks.length && graph.getClientRects().length) { graph.dataset.revealed = 'true'; revealGraph(graph); }
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
  // A card's footer shares its width with the token count, so a checked proof uses the meter legend's shorter word.
  private taskCard(view: ViewState, task: Task, peak: number): TaskCard {
    const state = taskState(task), tokens = totalTokens(task.usage);
    const owner = task.owner && workerNames(view.observation?.inspection.workers).get(task.owner);
    const feedback = this.taskFeedback.get(view.observation!.webRunId)?.get(JSON.stringify([task.id, task.version]));
    return { id: task.id, version: task.version, kind: task.kind, kindLabel: kindLabel[task.kind] ?? task.kind, state, stateLabel: label(state), objective: localizeText(task.objective),
      name: task.theorem?.split('.').at(-1) || task.id,
      owner: owner || task.owner || t('待分配'), proof: task.proof.status, proofLabel: task.proof.status === 'checked' ? t('已检查') : label(task.proof.status),
      ...(tokens !== undefined ? { tokens: { label: tokenText(tokens), share: peak ? tokens / peak : 0, detail: usageDetail(task.usage!) } } : {}),
      ...(feedback ? { feedback } : {}),
      selected: view.selectedTask === task.id && (view.selectedVersion === undefined || view.selectedVersion === task.version) };
  }
  private peakTokens(observation: WebObservation) {
    return Math.max(0, ...observation.inspection.tasks.map(task => totalTokens(task.usage) ?? 0));
  }
  /** Task totals leave out lead, assembly and review turns, so the legend states both sums. */
  private renderUsageLegend(view: ViewState, observation: WebObservation) {
    const legend = view.element.querySelector<HTMLElement>('[data-collab-usage-legend]')!;
    const tasks = observation.inspection.tasks.map(task => totalTokens(task.usage)).filter((value): value is number => value !== undefined);
    const run = totalTokens(observation.inspection.usage as Record<string, number> | undefined);
    legend.hidden = !tasks.length;
    const totals = tasks.length ? t('任务 {0}{1}', tokenText(tasks.reduce((sum, value) => sum + value, 0)), run !== undefined ? t(' / 运行 {0}', tokenText(run)) : '') : '';
    renderSection(legend, totals ? <><span>{t('Token 色条：相对用量最多的任务')}</span><span>{totals}</span></> : null);
  }
  private updateTaskSelection(view: ViewState) {
    // Graph and list cards are component-rendered; other task links (agents, frontier, deliveries) are toggled here.
    for (const card of view.element.querySelectorAll<HTMLButtonElement>('[data-collab-task]')) {
      if (card.closest('[data-collab-graph],[data-collab-task-list],[data-collab-agents]')) continue;
      const task = view.observation?.inspection.tasks.find(item => item.id === card.dataset.collabTask);
      const selected = Boolean(task && view.selectedTask === task.id && (view.selectedVersion === undefined || view.selectedVersion === task.version));
      card.classList.toggle('selected', selected); card.setAttribute('aria-pressed', String(selected));
    }
    if (view.observation) {
      const tasks = this.visibleTasks(view);
      this.renderTaskCards(view, tasks, this.taskMode(view)); this.renderAgents(view);
      this.renderTaskSelection(view, tasks, view.observation.inspection.tasks);
    }
  }
  private renderInspector(view: ViewState) {
    const observation = view.observation, record = this.selectedTaskRecord(view), task = record?.task;
    const current = observation?.inspection.tasks.find(task => task.id === view.selectedTask);
    const guide = view.element.querySelector<HTMLButtonElement>('[data-collab-guide-task]')!;
    guide.disabled = !this.canGuideTask(view);
    const root = view.element.querySelector<HTMLElement>('[data-collab-inspector]')!;
    if (!observation || !task) {
      renderTaskInspector(root, view.selectedVersion !== undefined ? { mode: 'missing', id: view.selectedTask, version: view.selectedVersion, hasCurrent: Boolean(current) } : { mode: 'empty' });
      return;
    }
    const historical = record!.historical;
    const blockers = observation.inspection.mathematics.snapshot.blockers.filter(blocker => blocker.taskId === task.id && blocker.taskDigest === task.version);
    const sources = observation.sources.filter(source=>source.taskId===task.id && (!historical || source.taskVersion===task.version)), checks = observation.checks.filter(check=>check.taskId===task.id && (!historical || check.taskVersion===task.version));
    const plannedConsumers = observation.inspection.tasks.filter(consumer=>consumer.plannedDependencies.includes(task.id)).map(consumer=>consumer.id);
    const actualConsumers = observation.inspection.tasks.filter(consumer=>consumer.proof.actualReferences?.tasks?.some(reference => reference.taskId === task.id && reference.taskDigest === task.version)).map(consumer=>({taskId:consumer.id,taskVersion:consumer.version,references:consumer.proof.actualReferences}));
    const facts: [string, unknown][] = [
      ...(!historical ? [[t('负责人'),task.owner],[t('任务状态'),`${label(task.status)} / ${label(task.control)}`],[t('尝试次数'),task.attempts]] as [string, unknown][] : []),
      ...(!historical && totalTokens(task.usage) !== undefined ? [[t('Token 用量'),[tokenText(totalTokens(task.usage)!), usageDetail(task.usage!)].filter(Boolean).join(' · ')]] as [string, unknown][] : []),
      [t('记录的证明状态'),label(task.proof.status)],[t('本版本需先完成'),task.plannedDependencies.join(', ')||t('无')],
      ...(!historical ? [[t('计划消费者'),plannedConsumers.join(', ')||t('无')]] as [string, unknown][] : []),
    ];
    const detail = (title: string, value: unknown, id: string) => ({ title, value, id: `${id}-${task.id}-${task.version}` });
    const state = taskState(task);
    renderTaskInspector(root, { mode: 'task', task: {
      id: task.id, version: task.version, kindLabel: kindLabel[task.kind] ?? task.kind, state, stateLabel: label(state), proof: task.proof.status,
      objective: localizeText(task.objective), historical, ...(current ? { currentVersion: current.version } : {}),
      facts: facts.map(([name, value]) => ({ name, value: String(value ?? t('未记录')) })), type: task.type ?? t('本任务未提供类型'),
      details: [detail(t('前提'), task.premises, 'premises'), detail(t('实际证明引用'), task.proof.actualReferences ?? t('未记录'), 'refs'), detail(t('实际消费者'), actualConsumers, 'consumers'),
        ...(blockers.length ? [detail(t('数学阻塞'), blockers, 'blockers')] : []), ...(task.feedback ? [detail(t('检查反馈'), task.feedback, 'feedback')] : []),
        ...(task.finding ? [detail(t('研究发现'), task.finding, 'finding')] : []),
        ...(task.parkedBy.length ? [detail(t('路线停放原因'), { parkedBy: task.parkedBy, parkedRoutes: task.parkedRoutes }, 'parked')] : [])],
      artifacts: [
        ...sources.map(source => ({ kind: 'source' as const, label: t('{0}源码 · {1} · {2}', source.taskVersion===current?.version?t('当前'):t('历史'), source.file, source.commit.slice(0, 8)),
          attributes: { 'data-collab-source': source.taskId, 'data-source-version': source.taskVersion, 'data-source-snapshot': taskSourceKey(source), 'data-focus-key': `source-${taskSourceKey(source)}` } })),
        ...(!sources.some(source=>source.taskVersion===task.version) ? [{ kind: 'source' as const, label: t('读取{0}版本源码', historical ? t('所选历史') : t('当前')),
          attributes: { 'data-collab-source': task.id, 'data-source-version': task.version, 'data-focus-key': `source-${task.id}-${task.version}` } }] : []),
        ...checks.map(check => ({ kind: 'check' as const, label: t('{0}检查 · {1}', check.taskVersion===current?.version?t('当前'):t('历史'), check.id),
          attributes: { 'data-collab-check': check.id, 'data-check-identity': taskCheckKey(check), 'data-focus-key': `check-${taskCheckKey(check)}` } })),
      ],
      hasChecks: checks.length > 0,
    } });
  }
  /** Re-rendered on new events, actions and observations; the key skips polls that changed none. The map reads new actions itself. */
  private renderRoute(view: ViewState, run: WebRun) {
    const observation = view.observation, ended = run.status !== 'queued' && run.status !== 'running';
    const key = [run.events.length, run.events.at(-1)?.sequence, run.actions?.count ?? 0, run.status, ended ? endedSummary(run) : '', observation?.sequence].join('|');
    if (view.routeKey === key) return;
    view.routeKey = key;
    const inspection = observation?.inspection;
    renderAgentRoute(view.element.querySelector<HTMLElement>('[data-agent-route]')!, {
      source: { store: this.activity, run, lead: inspection?.workers.find(worker => worker.role === 'lead')?.id },
      names: workerNames(inspection?.workers), running: run.status === 'running', tasks: taskNames(inspection?.tasks ?? []),
      ...(ended ? { ended: endedSummary(run) } : {}), planned: inspection?.tasks.length ?? 0, time: clockTime,
    });
  }
  private renderNow(view: ViewState, run: WebRun) {
    const inspection = view.observation!.inspection, tasks = new Map(inspection.tasks.map(task => [task.id, task]));
    const working = inspection.workers.filter(worker => worker.scheduling?.status === 'working');
    const names = workerNames(inspection.workers), theorems = taskNames(inspection.tasks);
    renderCollaborationNow(view.element.querySelector<HTMLElement>('[data-collab-now]')!, {
      ended: run.status === 'queued' || run.status === 'running' ? undefined : { accepted: isAcceptedRun(run) },
      waiting: inspection.waiting ? inspection.waiting.reason : undefined,
      working: working.map(worker => ({ id: worker.id, name: names.get(worker.id) ?? worker.id, phase: workerPhaseLabel(worker.phase) ?? t('未记录'),
        task: worker.task, ...(worker.task && theorems.has(worker.task) ? { taskName: theorems.get(worker.task) } : {}),
        objective: worker.task ? localizeText(tasks.get(worker.task)?.objective ?? '') || undefined : undefined })),
      others: inspection.workers.length - working.length,
    });
  }
  private renderAgents(view: ViewState) {
    const workers = view.observation?.inspection.workers ?? [];
    renderAgentCards(view.element.querySelector<HTMLElement>('[data-collab-agents]')!, workers.map(worker => ({
      id: worker.id, role: `${roleLabel(worker.role)} / ${roleLabel(worker.sessionRole) ?? t('无当前会话')}`, scheduling: schedulingLabel(worker.scheduling?.status) ?? t('未记录'), schedulingStatus: worker.scheduling?.status ?? 'unknown',
      phase: workerPhaseLabel(worker.phase) ?? t('未记录'), turns: String(worker.turns), task: worker.task,
      details: [
        ...(worker.dispatchWait.status !== 'unknown' ? [{ title: t('等待原因 · {0}', dispatchWaitLabel(worker.dispatchWait.status)), value: worker.dispatchWait, id: `wait-${worker.id}` }] : []),
        ...(worker.lastFailure ? [{ title: t('最近故障'), value: worker.lastFailure, id: `failure-${worker.id}` }] : []),
        ...(worker.recovery ? [{ title: t('恢复状态'), value: worker.recovery, id: `recovery-${worker.id}` }] : []),
      ],
    })));
  }
  private updateCommands(view: ViewState) {
    const skill = view.element.dataset.withoutCooperation === 'true';
    const refresh = view.element.querySelector<HTMLButtonElement>('[data-collab-refresh]')!;
    refresh.disabled = !this.connected || view.loading;
    refresh.textContent = view.loading ? t('刷新中…') : t('刷新观察'); refresh.setAttribute('aria-busy', String(view.loading));
    view.element.querySelector<HTMLButtonElement>('[data-collab-plan]')!.disabled=this.readOnly||this.permissions.edit===false||!this.connected||!view.active||!view.observation?.plan;
    view.element.querySelector<HTMLButtonElement>('[data-collab-plan]')!.hidden=skill;
    view.guidance.element.hidden=skill;
    const archive = view.element.querySelector<HTMLButtonElement>('[data-collab-archive]')!;
    archive.disabled=!this.connected||!view.observation||view.archiveBusy; archive.hidden=this.readOnly||this.permissions.archive===false;
    archive.textContent = view.archiveBusy ? t('归档中…') : t('归档知识'); archive.setAttribute('aria-busy', String(view.archiveBusy));
    const observation = view.observation;
    const observationText = view.observationError ?? (observation ? t('观察 #{0} · {1} · 历史记录未重新运行 Lean · 源码{2} · 检查{3}', observation.sequence, observedTime(observation.observedAt), coverageLabel(observation.coverage.sources), coverageLabel(observation.coverage.checks)) : '');
    view.element.querySelector('[data-collab-observation]')!.textContent = observationText;
    view.element.querySelector<HTMLElement>('.collab-observation-line')!.hidden = !observationText;
    view.guidance.update(view.observation, view.active&&!this.readOnly&&this.permissions.guidance!==false, this.connected);
    const canGuide=!this.readOnly&&this.permissions.guidance!==false;
    for(const button of view.element.querySelectorAll<HTMLButtonElement>('[data-collab-guide-worker],[data-collab-nav-guide]')) { button.disabled=!canGuide||!this.connected||!view.active; button.hidden=skill; }
    view.element.querySelector<HTMLButtonElement>('[data-collab-guide-task]')!.disabled = !this.canGuideTask(view);
    view.element.querySelector<HTMLButtonElement>('[data-collab-guide-task]')!.hidden = skill;
    view.navigation.update(view.observation, this.connected, view.archives.length);
  }
  /** One artifact at a time; keyed by request, so a new read remounts the heading for focus. */
  private renderArtifact(view: ViewState, artifact: { title: string; body: VNode } | null) {
    renderSection(view.element.querySelector<HTMLElement>('[data-collab-artifact]')!, artifact && <Fragment key={view.artifactRequest}>
      <h4 data-collab-artifact-heading tabIndex={-1}>{artifact.title}</h4><div data-collab-artifact-body>{artifact.body}</div></Fragment>);
  }
  private beginArtifact(view: ViewState, title: string, loading: string) {
    this.renderArtifact(view, { title, body: <p class="collab-help">{loading}</p> });
    const heading = view.element.querySelector<HTMLElement>('[data-collab-artifact-heading]')!;
    if (this.current === view) { view.navigation.reveal(heading); heading.focus({ preventScroll: true }); }
    return (body: VNode) => this.renderArtifact(view, { title, body });
  }
  private async readSource(runId:string,view:ViewState,taskId:string,version:string,snapshotKey?:string,commit?:string) {
    const request=++view.artifactRequest; view.sourceComparison = undefined;
    const show = this.beginArtifact(view, t('源码 · {0}', taskId), t('正在读取版本固定的源码'));
    try {
      const recorded = view.observation?.sources.find(source => source.taskId === taskId && source.taskVersion === version
        && (snapshotKey ? taskSourceKey(source) === snapshotKey : commit ? source.commit === commit : false));
      const source = recorded ?? (await this.api<{source:WebTaskSource}>(`/api/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/source?version=${encodeURIComponent(version)}${commit ? `&commit=${encodeURIComponent(commit)}` : ''}`)).source;
      if(request!==view.artifactRequest)return;
      if (source.taskId !== taskId || source.taskVersion !== version || snapshotKey && taskSourceKey(source) !== snapshotKey || commit && source.commit !== commit) throw new Error(t('读取结果与所选源码快照身份不同，未展示替代材料。'));
      view.sourceComparison = new TaskSourceComparison(source, view.observation?.sources ?? [], view.observation?.inspection.tasks.find(task => task.id === taskId)?.version ?? t('当前计划已无此任务'));
      // A reader who moved on while the source loaded keeps their place.
      const waiting = document.activeElement === view.element.querySelector('[data-collab-artifact-heading]');
      show(<Host node={view.sourceComparison.element} data-task-source-host />);
      // The loaded snapshot adds its identity fields above the code; reveal the code after that layout exists.
      const code = view.sourceComparison.element.querySelector<HTMLElement>('[data-task-source-code]');
      if (code && waiting && this.current === view) { view.navigation.reveal(code); code.focus({ preventScroll: true }); }
    }
    catch(error){if(request!==view.artifactRequest)return;show(<p class="collab-error">{errorText(error)}</p>);}
  }
  private async readCheck(runId:string,view:ViewState,id:string,identity?:string) {
    const request=++view.artifactRequest; view.sourceComparison = undefined;
    const show = this.beginArtifact(view, t('检查回执 · {0}', id), t('正在读取检查回执'));
    try {
      const {check}=await this.api<{check:WebCheckReceipt}>(`/api/runs/${encodeURIComponent(runId)}/checks/${encodeURIComponent(id)}`);
      if(request!==view.artifactRequest)return;
      if(check.id!==id||identity&&taskCheckKey(check)!==identity)throw new Error(t('读取结果与所选检查回执身份不同，未展示替代材料。'));
      show(<><Facts facts={[[t('任务'),check.taskId],[t('任务版本'),check.taskVersion],['commit',check.commit],[t('源码摘要'),check.sourceDigest],[t('环境摘要'),check.environmentDigest]]} /><Code value={check.record} /></>);
    }
    catch(error){if(request!==view.artifactRequest)return;show(<p class="collab-error">{errorText(error)}</p>);}
  }
  private setStatus(view: ViewState, status: ComponentChildren) {
    renderSection(view.element.querySelector<HTMLElement>('[data-collab-status]')!, <>{status}</>);
  }
  private renderArchives(view: ViewState, runId: string) {
    renderSection(view.element.querySelector('[data-collab-archives]')!, view.archives.length ? <>{view.archives.map(archive => <article key={archive.id} class="collab-archive" data-collab-archive-id={archive.id}>
      <div class="collab-section-heading"><strong>{observedTime(archive.createdAt)}</strong>
        <a class="button" data-collab-archive-download href={`/api/runs/${encodeURIComponent(runId)}/archives/${encodeURIComponent(archive.id)}`} download={`theoremos-${runId}-archive.json`}>{t('下载完整研究归档')}</a></div>
      <Facts facts={[[t('归档 ID'),archive.id],[t('摘要'),archive.digest],[t('源码 / 检查'),`${archive.sources} / ${archive.checks}`],[t('知识目录'),archive.catalogDigest ?? t('无')],
        [t('事件覆盖'),archive.coverage.events],[t('源码 / 检查覆盖'),`${archive.coverage.sources} / ${archive.coverage.checks}`],
        [t('观察 / 动作 / 命令覆盖'),`${archive.coverage.observations ?? t('未记录')} / ${archive.coverage.actions ?? t('未记录')} / ${archive.coverage.commands ?? t('未记录')}`]]} />
      <p class="collab-help">{t('历史证据已保存；再次使用需要重新检查。')}</p></article>)}</> : <p class="collab-help">{t('尚无已保存的归档')}</p>);
  }
  private async archive(runId:string,view:ViewState) {
    if(view.archiveBusy)return;view.archiveBusy=true;this.updateCommands(view);
    this.setStatus(view, t('正在保存归档与知识目录…'));
    try {
      const {archive}=await this.api<{archive:WebArchive}>(`/api/runs/${encodeURIComponent(runId)}/archive`,{method:'POST',body:'{}'});
      view.archives = [...view.archives.filter(item => item.id !== archive.id), archive];this.renderArchives(view, runId);
      this.setStatus(view, <>{t('已归档 {0} · {1}{2}；再次使用时需要重新检查', archive.id, archive.digest, archive.catalogDigest?t(' · 知识目录 {0}', archive.catalogDigest):'')} <button type="button" class="text-button" data-collab-show-archive>{t('查看归档')}</button></>);
      await view.knowledge.refreshCatalogs();
    }
    catch(error){this.setStatus(view, errorText(error));}finally{view.archiveBusy=false;this.updateCommands(view);}
  }
}
