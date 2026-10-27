import {
  createIcons, ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronUp, CircleAlert, Copy, CopyPlus, CornerDownLeft, Cpu,
  Download, ExternalLink, Eye, FileCode2, FolderOpen, GitBranch, IndentDecrease, IndentIncrease, ListOrdered, Link2, Link2Off, Maximize2, MessageSquare, Monitor, Moon, Network, PanelRight, Paperclip,
  LogOut, Plus, RefreshCw, RotateCcw, Save, Search, ShieldCheck, SlidersHorizontal, Square, SquarePen, Sun, Trash2, TriangleAlert, Undo2, Upload, X,
} from 'lucide';
import type { WebCoordination, WebEffort, WebEnvironment, WebPrecheck, WebPrecheckDiagnostic, WebProofOutline, WebRun, WebRunInput, WebSession } from '../shared';
import type { WebShareLink } from '../share';
import { effortLabels, failureGuide, formatDuration, formatTokens, isAcceptedRun, resultDescription, runProgress, usageEstimate, type RecoveryAction } from '../presentation';
import { summarizeReport, summarizeStuck } from '../report';
import { filterRuns, type RunFilter } from './history';
import { readLeanFile } from './sourceFile';
import { sourceIndentEdit, type IndentDirection } from './sourceIndent';
import type { SourceSelection } from './sourceText';
import { EditorNavigation, revealOffset } from './editorNavigation';
import { diagnosticText, renderSourceCheck, SourceCheck, sourceOffset } from './sourceCheck';
import { EditorReview } from './editorReview';
import { decodeTaskDraft, encodeTaskDraft, readTaskDraftFile, taskDraftStorageKey, type TaskDraft } from './draft';
import { compareSources, type SourceComparison } from './sourceDiff';
import { submissionFields, submissionIssues, tokenCap, type SubmissionField, type SubmissionIssue } from './submission';
import { SourceReader } from './sourceReader';
import { ActivityReader } from './activityReader';
import { ModuleView, type ModuleViewInput } from './moduleView';
import { ModulePlanEditor } from './modulePlanEditor';
import { CollaborationView } from './collaborationView';
import { RunUpdates } from './runUpdates';
import type { WebObservation } from '../collaboration';
import { ServerModulePlans } from './serverModulePlans';
import { ModulePlanLibrary, modulePlanLibraryStorageKey } from './modulePlanLibrary';
import { ModulePlanLibraryView } from './modulePlanLibraryView';
import type { ResearchModuleSlot } from '../../../src/solver/modules/policy';
import { DraftRecovery, type ReplacementReason } from './draftRecovery';
import { animateEntrance, finishHiddenMotion, finishMotion } from './motion';
import { renderTopbar } from './ui/Topbar';
import { renderRunMonitor as drawRunMonitor, type MonitorItem } from './ui/RunMonitor';
import { renderRunHeader as drawRunHeader, unmountRunHeader } from './ui/RunHeader';
import { createCommandPalette, type PaletteCommand } from './ui/CommandPalette';
import { renderRunOverview, unmountRunOverview, type RunOverviewProps } from './ui/RunOverview';
import { renderFacts, renderGlyph, renderGlyphLabel, renderHistoryEmpty, renderHistoryRow } from './ui/Controls';
import { renderConnecting, renderDraftPreview as drawDraftPreview } from './ui/DraftPreview';
import { renderOptions } from './ui/Section';
import { renderDetailPanel, type Banner, type OutlineState, type ReportPanelProps, type SourcePanelProps } from './ui/DetailPanel';
import { renderConversation as drawConversation } from './ui/Conversation';
import { workerPhaseLabel } from './collaborationUi';
import { documentTitle, finishedSince, newlyFinished, notifyStorageKey, readResume, saveResume } from './runAwareness';
import { forgetKey, hasRememberedKey, rememberKey, rememberedKey } from './keyMemory';
import { applyTheme, followThemeChanges, readThemePreference, saveThemePreference, type ThemePreference } from './themePreference';
import { installTermHints, renderGlossary } from './termHints';
import { feedbackUrl, localizeSiteLinks } from './feedback';
import type { TermId } from './glossary';
import { localeTag, localizeText, otherLocale, switchLocale, t } from '../i18n';

const iconSet = { ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronUp, CircleAlert, Copy, CopyPlus, CornerDownLeft, Cpu,
  Download, ExternalLink, Eye, FileCode2, FolderOpen, GitBranch, IndentDecrease, IndentIncrease, ListOrdered, Link2, Link2Off, Maximize2, MessageSquare, Monitor, Moon, Network, PanelRight, Paperclip,
  LogOut, Plus, RefreshCw, RotateCcw, Save, Search, ShieldCheck, SlidersHorizontal, Square, SquarePen, Sun, Trash2, TriangleAlert, Undo2, Upload, X };
function icons(root: Element | Document | DocumentFragment = document) {
  createIcons({ icons: iconSet, root, attrs: { 'aria-hidden': 'true' } });
  root.querySelectorAll('svg[data-lucide]').forEach(svg => svg.removeAttribute('data-lucide'));
}
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing workbench element: ${selector}`);
  return result;
}
function patchText(target: Element, value: string) {
  if (target.textContent !== value) target.textContent = value;
}
const field = (id: string) => element<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#${id}`);
const activeRun = (run: WebRun) => run.status === 'queued' || run.status === 'running';
const passed = isAcceptedRun;
const timestamp = (value: string, timeOnly = false) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(localeTag, timeOnly
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
};
const byteSize = (text: string) => new TextEncoder().encode(text).length;
const byteLabel = (bytes: number) => bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
type DetailTab = 'collaboration' | 'overview' | 'source' | 'modules' | 'report' | 'events';
const detailTabs = [['collaboration', t('研究协作')], ['source', t('Lean 源码')], ['modules', t('模块')], ['overview', t('概览')], ['report', t('报告')], ['events', t('活动')]] as const;
const state = {
  session: undefined as WebSession | undefined,
  runs: [] as WebRun[], selectedId: '', selectedRun: undefined as WebRun | undefined,
  query: '', filter: 'all' as RunFilter,
  tab: 'collaboration' as DetailTab, sourceView: 'proof' as 'proof' | 'input' | 'diff', submitting: false, cancelling: new Set<string>(),
  draftView: 'source' as 'source' | 'modules',
  foldUnchanged: true, diffChange: 0,
  reportMode: 'summary' as 'summary' | 'json', deleting: new Set<string>(),
  detailError: '', listGeneration: 0, runsEtag: '',
  listSignature: '', panelSignature: '',
  connected: false, refreshing: false, connectionEpoch: 0,
  composing: false, conversationSignature: '', conversationRunId: '',
  finishedRuns: new Set<string>(),
  /** Runs that ended while the tab was hidden; shown in the tab title until the tab is visible again. */
  unseenRuns: new Set<string>(), resumed: false,
  /** The read-only sample run, fetched when first opened; it is never part of runs. */
  sample: undefined as WebRun | undefined,
};
const baseTitle = document.title;
const notificationsSupported = () => typeof Notification === 'function';
const notifyWanted = () => { try { return localStorage.getItem(notifyStorageKey) === 'on'; } catch { return false; } };
function notifyState(): 'on' | 'off' | 'blocked' | 'unsupported' {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return notifyWanted() && Notification.permission === 'granted' ? 'on' : 'off';
}
function announceFinished(run: WebRun) {
  if (!document.hidden) return;
  state.unseenRuns.add(run.id);
  if (notifyState() !== 'on') return;
  const notice = new Notification(`TheoremOS · ${status(run).label}`, { body: `${run.title}\n${resultDescription(run)}`, tag: run.id });
  notice.onclick = () => { window.focus(); selectRun(run.id); setMobileView('compose'); notice.close(); };
}
async function toggleNotifications() {
  const current = notifyState();
  if (current === 'unsupported') { toast(t('这个浏览器不支持桌面通知')); return; }
  if (current === 'blocked') { toast(t('浏览器已阻止本站通知，请在地址栏的网站设置中允许')); return; }
  const remember = (value: string) => { try { localStorage.setItem(notifyStorageKey, value); } catch { /* Preference lasts for this page only. */ } };
  if (current === 'on') { remember('off'); toast(t('已关闭完成通知')); renderConversation(); return; }
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') { toast(t('没有获得通知权限，结束时只会在标签页标题上提示')); renderConversation(); return; }
  remember('on');
  toast(t('研究结束时会发送桌面通知'));
  renderConversation();
}
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let connectionRequest: Promise<void> | undefined;
let liveRefreshPending = false;
let readController = new AbortController();
let pageActive = true;
let sourceRevision = 0;
let editorRevision = 0;
let editorInitialSource = '';
let editorOpenedFromPreview = false;
let editorClosePosition: { start: number; end: number; direction: 'forward' | 'backward' | 'none'; top: number; left: number } | undefined;
let deletionTarget: { id: string; title: string; csrfToken: string } | undefined;
let sharing: { id: string; link?: WebShareLink | null; busy: boolean } | undefined;
let draftReady = false;
let draftDirty = false;
let draftRevision = 0;
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let latestDraft: TaskDraft | undefined;
let replacingDraft = false;
const draftRecovery = new DraftRecovery(() => sessionStorage);
let taskImportSequence = 0;
let pendingImport: { draft: TaskDraft; revision: number } | undefined;
let sourceComparison: { runId: string; before: string; after: string; folded: boolean; result: SourceComparison } | undefined;
let draftPreviewSignature = '';
let draftSourceExpanded = false;
let moduleSettingsPolicy: string | undefined;
let settingsWorkspaceReturn: { focus?: HTMLElement } | undefined;
const sourceReader = new SourceReader(() => {
  if (!currentRun() && !draftSourceExpanded) { draftSourceExpanded = true; renderDraftPreview(); }
});
const activityReader = new ActivityReader(at => timestamp(at, true),
  (filename, text) => download(filename, text, 'application/json'));
const moduleView = new ModuleView();
const modulePlanEditor = new ModulePlanEditor(element('#module-plan'), icons, () => draftChanged());
const collaborationView = new CollaborationView(api, receiveRunObservation, () => {
  state.tab = 'report'; renderDetail(true); document.getElementById('detail-tab-report')?.focus({ preventScroll: true });
});
const runUpdates = new RunUpdates(version => {
  if (pageActive && state.connected && !document.hidden && version !== state.runsEtag) requestRunsRefresh();
}, schedulePoll);
const serverModulePlans = new ServerModulePlans(element('#module-plan'), api, () => modulePlanEditor.value(),
  plan => modulePlanEditor.setValue(plan), () => draftChanged());
const modulePlanLibrary = new ModulePlanLibraryView(element('#module-plan-library'), new ModulePlanLibrary(() => localStorage),
  () => modulePlanEditor.value(), plan => { modulePlanEditor.setValue(plan); draftChanged(); });
const editorNavigation = new EditorNavigation(element<HTMLDialogElement>('#source-editor'), updateEditorPosition,
  updateEditorCount, () => state.session?.limits.maxSourceBytes ?? 0);
const editorReview = new EditorReview(element<HTMLDialogElement>('#source-editor'), () => editorNavigation.close(),
  updateEditorPosition, position => editorNavigation.locate(position));
const validationShown = new Set<SubmissionField>();
const sourceCheck = new SourceCheck({
  input: () => ({ environment: field('environment').value as WebEnvironment, source: field('source').value }),
  enabled: () => Boolean(state.session?.precheck && state.connected && state.session.runtime.ready
    && new TextEncoder().encode(field('source').value).length <= state.session.limits.maxSourceBytes),
  post: async (input, signal) => (await api<{ precheck: WebPrecheck }>('/api/precheck',
    { method: 'POST', body: JSON.stringify(input), signal, timeoutMs: 120_000 })).precheck,
  superseded: error => error instanceof ApiError && error.status === 409,
  message: error => message(error),
  render: () => { renderSourceCheckView(); renderPreparation(); },
});
function renderSourceCheckView() {
  renderSourceCheck(element('#source-check'), element('#source-check-status'), {
    check: sourceCheck, onJump: jumpToSourceDiagnostic, onRecheck: () => { void sourceCheck.run(); },
    onOpen: () => {
      const first = sourceCheck.blocking();
      if (first) { jumpToSourceDiagnostic(first); return; }
      openSettings('source');
      element('#source-check').scrollIntoView({ block: 'nearest', behavior: 'instant' });
    },
  });
}
/** Opens the statement in settings with the reported range selected and in view. */
function jumpToSourceDiagnostic(diagnostic: WebPrecheckDiagnostic) {
  openSettings('source');
  const editor = element<HTMLTextAreaElement>('#source');
  if (!editor.matches(':focus')) return;
  const start = sourceOffset(editor.value, diagnostic.line, diagnostic.column);
  const end = diagnostic.endLine === undefined ? start
    : Math.max(start, sourceOffset(editor.value, diagnostic.endLine, diagnostic.endColumn ?? 0));
  editor.setSelectionRange(start, end);
  revealOffset(editor, start);
  editor.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}
let chatWidth = 40;
const conversationScroll = { top: 0, following: true };
let historyCriteria = '';
let historyReading: { top: number; anchors: Array<{ id: string; offset: number }> } = { top: 0, anchors: [] };

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
type ApiInit = RequestInit & { timeoutMs?: number };
function api<T>(url: string, init?: ApiInit): Promise<T>;
function api<T>(url: string, init: ApiInit, etag: (value: string | null) => void): Promise<T | undefined>;
async function api<T>(url: string, { timeoutMs = 15_000, ...init }: ApiInit = {}, etag?: (value: string | null) => void): Promise<T | undefined> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error(t('请求超时，请重新连接'))), timeoutMs);
  const signals = [timeout.signal];
  if (!init.method || init.method === 'GET') signals.push(readController.signal);
  if (init.signal) signals.push(init.signal);
  try {
    const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any(signals),
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.method && init.method !== 'GET' ? { 'X-CSRF-Token': state.session?.csrfToken ?? '' } : {}), ...init.headers } });
    if (etag && response.status === 304) { etag(response.headers.get('ETag')); return; }
    const payload: unknown = await response.json().catch(error => {
      if (timeout.signal.aborted) throw timeout.signal.reason;
      if (!response.ok) return undefined;
      throw error;
    });
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error : t('请求失败 ({0})', response.status);
      throw new ApiError(message, response.status);
    }
    if (payload === undefined) throw new Error(t('服务器返回了无法读取的响应'));
    etag?.(response.headers.get('ETag'));
    return payload as T;
  } catch (error) {
    if (timeout.signal.aborted) throw timeout.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const message = (error: unknown) => error instanceof Error ? error.message : t('请求失败，请重试');
function toast(text: string) {
  const target = element('#toast');
  target.textContent = text; target.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { target.hidden = true; }, 3000);
}
function setGlobalNotice(text: string) {
  element('#global-notice-text').textContent = text;
  element('#global-notice').hidden = !text;
}
function setMobileView(view: 'compose' | 'runs', focus = false) {
  rememberConversationScroll();
  const changed = document.body.dataset.mobileView !== view;
  if (changed) { activityReader.remember(); moduleView.update(); }
  document.body.dataset.mobileView = view;
  finishHiddenMotion();
  document.querySelectorAll<HTMLButtonElement>('button[data-mobile-view]').forEach(button => {
    const selected = button.dataset.mobileView === view;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  });
  if (view === 'runs') {
    renderDraftPreview(true);
    if (state.tab === 'events' || state.tab === 'modules') renderPanel(true);
    const list = element('#run-list');
    const selected = list.querySelector<HTMLElement>('.run-row.selected');
    if (selected && list.scrollWidth > list.clientWidth) {
      const bounds = list.getBoundingClientRect(), row = selected.getBoundingClientRect();
      if (row.left < bounds.left) list.scrollLeft += row.left - bounds.left;
      else if (row.right > bounds.right) list.scrollLeft += row.right - bounds.right;
    }
  }
  restoreConversationScroll();
  if (changed && window.matchMedia('(max-width:850px)').matches) {
    animateEntrance(element(view === 'compose' ? '.composer' : '#runs-panel'), 'workspace');
  }
}
function showDialog(dialog: HTMLDialogElement) {
  if (dialog.open) return;
  dialog.showModal();
  animateEntrance(dialog, 'dialog');
}
function syncSettingsNavigation() {
  const content = element('.settings-content');
  const top = content.getBoundingClientRect().top;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-settings-section]')];
  let current = buttons[0];
  for (const button of buttons) {
    if (element(`#${button.dataset.settingsSection}`).getBoundingClientRect().top <= top + 48) current = button;
  }
  if (content.scrollTop > 0 && content.scrollHeight - content.clientHeight - content.scrollTop < 8) current = buttons.at(-1)!;
  for (const button of buttons) {
    if (button === current) button.setAttribute('aria-current', 'location');
    else button.removeAttribute('aria-current');
  }
}
function openSettings(focusId?: string) {
  if (!state.session || state.submitting) return;
  modulePlanLibrary.refresh();
  void serverModulePlans.refresh();
  const dialog = element<HTMLDialogElement>('#run-settings');
  if (!dialog.open && document.body.dataset.mobileView === 'runs') {
    settingsWorkspaceReturn = { focus: document.activeElement instanceof HTMLElement ? document.activeElement : undefined };
    setMobileView('compose');
  }
  showDialog(dialog);
  if (focusId) element(`#${focusId}`).focus();
  syncSettingsNavigation();
}
function closeSettings(restoreWorkspace = true) {
  if (!restoreWorkspace) { moduleSettingsPolicy = undefined; settingsWorkspaceReturn = undefined; }
  element<HTMLDialogElement>('#run-settings').close();
}
function clearValidation() {
  validationShown.clear();
  modulePlanEditor.showError();
  for (const id of submissionFields) {
    field(id).setCustomValidity('');
    field(id).removeAttribute('aria-invalid');
    element(`#${id}-validation`).hidden = true;
  }
}
function currentSubmissionIssues(): SubmissionIssue[] {
  if (!state.session) return [];
  const issues = submissionIssues(captureDraft(), field('api-key').value, state.session);
  const blocking = sourceCheck.blocking();
  // A failed compile is the source field's issue, in the source field's place, unless the field already has one.
  if (!blocking || issues.some(issue => issue.field === 'source')) return issues;
  const after = submissionFields.indexOf('source');
  const index = issues.findIndex(issue => issue.field !== 'module-plan' && submissionFields.indexOf(issue.field) > after);
  const issue: SubmissionIssue = { field: 'source', check: true,
    message: t('原题第 {0} 行：{1}', blocking.line, diagnosticText(blocking).split('\n')[0].slice(0, 160)) };
  issues.splice(index < 0 ? issues.length : index, 0, issue);
  return issues;
}
function renderPreparation(issues = currentSubmissionIssues()) {
  for (const id of submissionFields) {
    const issue = issues.find(issue => issue.field === id);
    const visible = Boolean(issue && validationShown.has(id));
    const control = field(id), error = element(`#${id}-validation`);
    control.setCustomValidity(issue?.message ?? '');
    if (visible && control.getAttribute('aria-invalid') !== 'true') control.setAttribute('aria-invalid', 'true');
    else if (!visible && control.hasAttribute('aria-invalid')) control.removeAttribute('aria-invalid');
    patchText(error, visible ? issue!.message : '');
    if (error.hidden === visible) error.hidden = !visible;
  }
  const moduleIssue = issues.find(issue => issue.field === 'module-plan');
  modulePlanEditor.showError(validationShown.has('module-plan') ? moduleIssue?.message : undefined);
  const issue = issues[0];
  const labels: Record<SubmissionField, string> = {
    provider: t('选择服务商'), environment: t('选择环境'), source: t('编辑源码'), task: t('填写任务'), model: t('填写模型'),
    'api-key': t('填写 API Key'), 'max-turns': t('调整轮次'), 'max-seconds': t('调整预算'), workers: t('调整 Agent'), 'max-tokens': t('调整用量上限'), 'module-plan': t('检查模块方案'),
  };
  const pending = !state.session;
  const offline = !pending && !state.connected;
  const environmentReady = Boolean(state.session?.runtime.ready && state.session.providers.length);
  const phase = state.submitting ? 'submitting' : pending ? 'pending' : offline || !environmentReady ? 'offline' : issue ? 'missing' : 'ready';
  const target = element('#submission-readiness');
  if (target.dataset.state !== phase) target.dataset.state = phase;
  patchText(element('#readiness-title'), state.submitting ? t('正在提交研究') : pending ? t('正在读取提交配置')
    : offline ? t('连接中断，草稿可继续编辑') : !environmentReady ? t('运行环境未就绪')
      : issue?.message ?? t('提交配置已填写'));
  patchText(element('#readiness-detail'), state.submitting ? t('请稍候，提交结果将在对话中显示。') : pending ? t('连接后可编辑研究任务。')
    : offline || !environmentReady ? t('环境恢复后可提交，当前草稿会保留。')
      : issue?.field === 'api-key' ? t('每次提交后清空，不随草稿保存；可在设置里选择在此标签页记住。')
        : issue?.field === 'task' ? t('说明要证明的目标与约束。')
          : issue?.check ? t('原题需要先能编译；点击右侧定位到出错位置。')
          : issue?.field === 'source' ? t('添加原始 Lean 题目，右侧可预览。')
            : issue ? t('补全配置后即可提交当前题目。') : t('Key 与模型可用性将在提交时确认。'));
  patchText(element('#readiness-action'), issue?.check ? t('查看错误') : issue ? labels[issue.field] : t('查看配置'));
  renderGlyph(element('#readiness-icon'), state.submitting ? 'spinner' : phase === 'ready' ? 'circle-check' : 'circle-alert');
  const action = element<HTMLButtonElement>('#prepare-run');
  if (action.disabled !== (pending || state.submitting)) action.disabled = pending || state.submitting;
  renderBudgetEstimate();
}
/** Time and turns are hard stops; tokens are estimated from this account's finished runs on the same model. */
function renderBudgetEstimate() {
  const turns = Number(field('max-turns').value), seconds = Number(field('max-seconds').value), model = field('model').value.trim();
  if (!Number.isSafeInteger(turns) || turns < 1 || !Number.isSafeInteger(seconds) || seconds < 30) { patchText(element('#budget-estimate'), ''); return; }
  const cap = state.session ? tokenCap(field('max-tokens').value, state.session.limits.maxTotalTokens) : undefined;
  const estimate = usageEstimate(state.runs, model, turns);
  const limits = t('最长约 {0} 分钟，全部 Agent 合计最多 {1} 轮模型调用。', Math.ceil(seconds / 60), turns);
  const usage = estimate ? t('按你最近 {0} 次 {1} 运行的平均每轮 {2} Token，本次约 {3} Token 以内。', estimate.samples, model, formatTokens(estimate.perTurn), formatTokens(estimate.ceiling))
    : t('还没有这个模型的用量记录，费用按服务商实际计费。');
  patchText(element('#budget-estimate'), `${limits}${usage}${cap ? t('达到 {0} Token 后停止新的调用。', formatTokens(cap)) : ''}`);
}
function focusSubmissionIssue(issue: SubmissionIssue) {
  validationShown.add(issue.field);
  renderPreparation();
  const diagnostic = issue.check && sourceCheck.blocking();
  if (diagnostic) { jumpToSourceDiagnostic(diagnostic); return; }
  if (issue.field === 'module-plan') {
    openSettings('module-plan'); modulePlanEditor.validate();
    element('#module-plan-error').scrollIntoView({ block: 'nearest', behavior: 'instant' });
    return;
  }
  if (issue.field === 'task') { closeSettings(false); setMobileView('compose'); }
  else openSettings(issue.field);
  field(issue.field).focus();
  // Focus alone can leave the explanation underneath the fixed settings footer.
  if (issue.field !== 'task') element(`#${issue.field}-validation`).scrollIntoView({ block: 'nearest', behavior: 'instant' });
}
function renderTemplateSelection() {
  document.querySelectorAll<HTMLButtonElement>('[data-chat-template]').forEach(button => {
    const selected = String(button.dataset.chatTemplate === field('template').value);
    if (button.getAttribute('aria-pressed') !== selected) button.setAttribute('aria-pressed', selected);
  });
}
function renderComposerSummary() {
  patchText(element('#composer-environment'), environmentName(field('environment').value));
  patchText(element('#attached-lines'), t('{0} 行', field('source').value.split(/\r\n|\r|\n/).length));
  const stop = element<HTMLButtonElement>('#stop-research');
  const run = currentRun();
  const cancelling = Boolean(run && state.cancelling.has(run.id));
  stop.hidden = !run || !activeRun(run);
  stop.disabled = !state.connected || cancelling;
  stop.title = cancelling ? t('正在取消') : t('取消运行');
  stop.setAttribute('aria-label', stop.title);
  stop.setAttribute('aria-busy', String(cancelling));
  renderGlyph(stop, cancelling ? 'spinner' : 'square');
  const back = element<HTMLButtonElement>('#return-to-draft');
  back.hidden = !run;
  back.disabled = state.submitting;
  renderPreparation();
  renderTemplateSelection();
  renderShell();
}
function rememberConversationScroll() {
  const scroll = element('#conversation-scroll');
  // Hidden mobile panes report zero geometry; keep their last visible reading state.
  if (!scroll.clientHeight) return;
  conversationScroll.top = scroll.scrollTop;
  conversationScroll.following = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
}
function updateLatestMessage() {
  rememberConversationScroll();
  element('#latest-message').hidden = !currentRun() || conversationScroll.following;
}
function restoreConversationScroll() {
  const scroll = element('#conversation-scroll');
  // Only a run follows its newest event; the welcome is read from the top.
  if (scroll.clientHeight) scroll.scrollTop = conversationScroll.following && currentRun() ? scroll.scrollHeight : conversationScroll.top;
  updateLatestMessage();
}
function renderConversation() {
  renderComposerSummary();
  const run = currentRun();
  const signature = JSON.stringify(run ? [run.id, run.task, run.status, run.phase, run.events, run.result?.status, run.error, run.failure, run.queue, Boolean(run.artifact), notifyState()]
    : [state.session?.templates, state.session?.sample, state.connected, state.runs.length > 0]);
  if (signature === state.conversationSignature) return;
  state.conversationSignature = signature;
  rememberConversationScroll();
  const newConversation = state.conversationRunId !== (run?.id ?? '');
  state.conversationRunId = run?.id ?? '';
  if (newConversation) { conversationScroll.top = 0; conversationScroll.following = true; }
  const thread = element('#conversation');
  const entrances: Array<{ target: HTMLElement; kind: 'message' | 'event' }> = [];
  const events = run ? run.events.filter((event, index, all) => index === 0 || event.message !== all[index - 1].message || event.type !== all[index - 1].type) : [];
  const rendered = () => Array.from(thread.querySelectorAll<HTMLElement>('.timeline-event'));
  const previous = new Set(rendered().map(row => row.dataset.sequence));
  const freshThread = Boolean(run) && (newConversation || !thread.querySelector('.chat-message.user'));
  if (!run || freshThread) finishMotion(thread);
  else {
    const kept = new Set(events.map(event => String(event.sequence)));
    for (const row of rendered()) if (!kept.has(row.dataset.sequence!)) finishMotion(row);
  }
  const working = Boolean(run && activeRun(run)), value = run ? status(run) : undefined;
  drawConversation(thread, {
    templates: (state.session?.templates ?? []).map(template => ({ id: template.id, name: template.name, environment: environmentName(template.environment) })),
    ...(state.session?.sample ? { sample: { title: state.session.sample.title } } : {}),
    firstRun: Boolean(state.session) && !state.runs.length,
    ...(run && value ? { run: { id: run.id, task: run.task, environment: environmentName(run.environment), model: run.model, working,
      events: events.map(event => ({ sequence: event.sequence, at: event.at, time: timestamp(event.at, true), message: localizeText(event.message) })),
      result: { tone: value.tone, symbol: value.symbol, label: failureGuide(run)?.title ?? value.label, description: resultDescription(run), candidate: Boolean(run.artifact && working) },
      ...(failureGuide(run) ? { recovery: failureGuide(run)!.actions } : {}), ...(working ? { notify: notifyState() } : {}),
      ...(['environment', 'unknown', 'interrupted'].includes(failureGuide(run)?.kind ?? '') ? { feedback: feedbackUrl({ failure: failureGuide(run)!.kind }) } : {}) } } : {}),
  });
  if (freshThread) thread.querySelectorAll<HTMLElement>('.chat-message').forEach(target => entrances.push({ target, kind: 'message' }));
  if (run && !newConversation && conversationScroll.following) {
    const recent = new Set(events.slice(-3).map(event => String(event.sequence)));
    for (const row of rendered()) if (recent.has(row.dataset.sequence!) && !previous.has(row.dataset.sequence)) entrances.push({ target: row, kind: 'event' });
  }
  const announcement = run ? t('{0}。{1}', status(run).label, activeRun(run) ? localizeText(run.events.at(-1)?.message ?? '') : resultDescription(run)) : '';
  const live = element('#conversation-announcement');
  if (live.textContent !== announcement) live.textContent = announcement;
  renderTemplateSelection();
  restoreConversationScroll();
  for (const { target, kind } of entrances) animateEntrance(target, kind);
}
function providerAddress() {
  element('#provider-address').textContent = state.session?.providers.find(provider => provider.id === field('provider').value)?.baseUrl ?? '';
  restoreKey();
}
// The key is cleared after every submission and on leaving; with "remember" on, this tab hands it back for the same provider address.
const keyStorage = () => sessionStorage;
const keyTarget = () => ({ providerId: field('provider').value, baseUrl: state.session?.providers.find(provider => provider.id === field('provider').value)?.baseUrl ?? '' });
let restoredKey = '';
function restoreKey() {
  const target = keyTarget(), key = rememberedKey(keyStorage, target.providerId, target.baseUrl) ?? '';
  // A key the reader typed stays, with their choice of the box; only an empty field or one we filled is replaced.
  if (!field('api-key').value || field('api-key').value === restoredKey) {
    field('api-key').value = key; restoredKey = key;
    element<HTMLInputElement>('#remember-key').checked = Boolean(key);
  } else restoredKey = '';
  element('#forget-key').hidden = !hasRememberedKey(keyStorage);
}
// While "remember" is on, the stored key follows the field; an emptied field or an unticked box forgets it.
function syncKeyMemory() {
  const key = field('api-key').value.trim(), remember = element<HTMLInputElement>('#remember-key');
  if (remember.checked && key && !rememberKey(keyStorage, { ...keyTarget(), apiKey: key })) {
    remember.checked = false; toast(t('浏览器不允许保存，Key 只保留到这次提交'));
  }
  if (remember.checked && key) restoredKey = key; else { forgetKey(keyStorage); restoredKey = ''; }
  element('#forget-key').hidden = !hasRememberedKey(keyStorage);
}
function forgetRememberedKey() {
  forgetKey(keyStorage);
  if (field('api-key').value === restoredKey) field('api-key').value = '';
  restoredKey = ''; element<HTMLInputElement>('#remember-key').checked = false; element('#forget-key').hidden = true;
}
const environmentInfo = (id: WebEnvironment | string) => state.session?.environments.find(environment => environment.id === id);
const environmentName = (id: WebEnvironment | string) => environmentInfo(id)?.name ?? (id === 'mathlib' ? 'Mathlib' : t('Lean 标准库'));
const leanVersion = (toolchain: string) => toolchain.replace(/^leanprover\/lean4:/, '');
function updateEnvironment() {
  const environment = environmentInfo(field('environment').value);
  element('#lean-scope').textContent = environment ? leanVersion(environment.toolchain) : '';
  const details = element('#environment-details');
  details.textContent = environment
    ? `Lean ${leanVersion(environment.toolchain)}${environment.mathlibRevision ? ` · Mathlib ${environment.mathlibRevision.slice(0, 8)}` : t(' · 标准库')}`
    : t('请选择证明环境');
  details.title = environment
    ? `${environment.description} · Lean ${leanVersion(environment.toolchain)}${environment.mathlibRevision ? ` · Mathlib ${environment.mathlibRevision}` : ''}`
    : t('请选择证明环境');
  details.setAttribute('aria-label', details.title);
}
function renderTemplates(preferred = '', useFirst = false) {
  const templates = state.session?.templates.filter(template => template.environment === field('environment').value) ?? [];
  renderOptions(element<HTMLSelectElement>('#template'), [...templates.map(template => [template.id, template.name] as const), ['', t('自定义 Lean')]],
    templates.some(template => template.id === preferred) ? preferred : useFirst ? templates[0]?.id ?? '' : '');
}
function updateCounts() {
  for (const [id, limit] of [['source', state.session?.limits.maxSourceBytes], ['task', state.session?.limits.maxTaskBytes]] as const) {
    const count = byteSize(field(id).value);
    const target = element(`#${id}-count`);
    target.textContent = limit ? `${byteLabel(count)} / ${byteLabel(limit)}` : byteLabel(count);
    target.classList.toggle('over-limit', Boolean(limit && count > limit));
  }
  element('#source-lines').textContent = t('{0} 行', field('source').value.split(/\r\n|\r|\n/).length);
}
function sourceChanged() {
  sourceRevision++;
  element('#source-error').hidden = true;
  updateCounts();
  if (currentRun()) startDraft();
  draftChanged();
}
function captureDraft(): TaskDraft {
  const modulePlan = modulePlanEditor.value();
  return { providerId: field('provider').value, model: field('model').value,
    effort: field('effort').value as WebEffort, environment: field('environment').value as WebEnvironment,
    source: field('source').value, task: field('task').value, templateId: field('template').value,
    maxTurns: field('max-turns').value, maxRunSeconds: field('max-seconds').value, workers: field('workers').value,
    ...(field('max-tokens').value ? { maxTotalTokens: field('max-tokens').value } : {}),
    coordination: element<HTMLInputElement>('input[name="coordination"]:checked').value as WebCoordination,
    ...(serverModulePlans.knowledgeDigest() ? { knowledgeDigest: serverModulePlans.knowledgeDigest() } : {}),
    ...(modulePlan.custom.length || modulePlan.scheduler !== 'plan' || modulePlan.context !== 'full' ? { modulePlan } : {}) };
}
function setDraftStatus(text: string, warning = false) {
  element('#draft-status').textContent = text;
  element('#draft-status').classList.toggle('warning', warning);
}
function renderDraftRecovery() {
  const recovery = draftRecovery.current;
  element('#draft-recovery').hidden = !recovery;
  const button = element<HTMLButtonElement>('#restore-draft-settings');
  button.hidden = !recovery;
  button.disabled = state.submitting;
  if (!recovery) return;
  const labels: Record<ReplacementReason, string> = {
    template: t('已切换示例'), reset: t('已重置草稿'), reuse: t('已复用任务'), import: t('已载入任务文件'),
    source: t('已导入 Lean 文件'), edit: t('已应用源码编辑'),
  };
  patchText(element('#draft-recovery-text'), labels[recovery.reason]);
  element('#draft-recovery-local').hidden = recovery.persisted;
}
function replaceDraft(reason: ReplacementReason, change: () => void) {
  const before = latestDraft ?? captureDraft();
  const track = draftReady && !replacingDraft;
  const nested = replacingDraft;
  replacingDraft = true;
  try { change(); } finally { replacingDraft = nested; }
  if (track) {
    draftRecovery.remember(before, captureDraft(), reason);
    renderDraftRecovery();
  }
}
function recoverDraft() {
  const recovery = draftRecovery.current;
  if (!recovery || !state.session || state.submitting) return;
  const fromSettings = element<HTMLDialogElement>('#run-settings').open;
  draftRecovery.clear();
  applyTaskDraft(recovery.draft);
  startDraft(); saveDraft(); renderDraftRecovery();
  if (fromSettings) {
    field('source').focus();
    field('source').scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
  else field('task').focus({ preventScroll: true });
  toast(t('已恢复替换前的草稿，请重新填写 API Key'));
}
function draftChanged(persist = true) {
  latestDraft = captureDraft();
  modulePlanLibrary.sync();
  draftRevision++;
  renderImportState();
  sourceCheck.schedule();
  renderSourceCheckView();
  renderComposerSummary();
  renderDraftPreview();
  if (!draftReady || !persist) return;
  draftDirty = true;
  setDraftStatus(t('草稿待保存'));
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 250);
}
function saveDraft() {
  clearTimeout(draftTimer);
  if (!draftReady || !draftDirty) return;
  try {
    sessionStorage.setItem(taskDraftStorageKey, encodeTaskDraft(captureDraft()));
    draftDirty = false;
    setDraftStatus(t('草稿已保存'));
  } catch {
    // Avoid restoring an older draft after the latest edits could not be saved.
    try { sessionStorage.removeItem(taskDraftStorageKey); } catch { /* Storage can be unavailable. */ }
    setDraftStatus(t('草稿未保存'), true);
  }
}
function applyTaskDraft(draft: TaskDraft) {
  modulePlanLibrary.resetSelection();
  clearValidation();
  draftSourceExpanded = false;
  field('provider').value = state.session?.providers.some(provider => provider.id === draft.providerId) ? draft.providerId : '';
  field('environment').value = draft.environment;
  renderTemplates();
  for (const [id, value] of Object.entries({ model: draft.model, effort: draft.effort, source: draft.source, task: draft.task,
    'max-turns': draft.maxTurns, 'max-seconds': draft.maxRunSeconds, workers: draft.workers, 'max-tokens': draft.maxTotalTokens ?? '' })) field(id).value = value;
  const template = state.session?.templates.find(template => template.id === draft.templateId
    && template.environment === draft.environment && template.source === field('source').value && template.task === field('task').value);
  field('template').value = template?.id ?? '';
  element<HTMLInputElement>(`input[name="coordination"][value="${draft.coordination}"]`).checked = true;
  modulePlanEditor.setValue(draft.modulePlan);
  serverModulePlans.setKnowledgeDigest(draft.knowledgeDigest);
  field('api-key').value = '';
  element<HTMLInputElement>('#api-key').type = 'password';
  updateKeyToggle(); providerAddress(); updateEnvironment(); sourceChanged();
  element('#form-error').hidden = true;
  element('#draft-error').hidden = true;
}
function restoreDraft() {
  let stored: string | null;
  try { stored = sessionStorage.getItem(taskDraftStorageKey); }
  catch { setDraftStatus(t('草稿保存不可用'), true); return; }
  if (!stored) return;
  try {
    applyTaskDraft(decodeTaskDraft(JSON.parse(stored)));
    setDraftStatus(t('已恢复草稿'));
  } catch {
    try { sessionStorage.removeItem(taskDraftStorageKey); } catch { /* Storage can be unavailable. */ }
    setDraftStatus(t('草稿未恢复'), true);
  }
}
function renderImportState() {
  if (!pendingImport) return;
  const notice = pendingImport.revision !== draftRevision ? t('草稿已变化，请重新选择文件。')
    : state.submitting ? t('正在提交任务，请稍后再载入。') : '';
  element('#import-notice').textContent = notice;
  element('#import-notice').hidden = !notice;
  element<HTMLButtonElement>('#confirm-import').disabled = Boolean(notice) || !state.session;
}
async function importTaskFile(file: File) {
  if (!state.session || state.submitting) return;
  const sequence = ++taskImportSequence, revision = draftRevision;
  element('#draft-error').hidden = true;
  try {
    const draft = await readTaskDraftFile(file);
    if (sequence !== taskImportSequence) return;
    if (revision !== draftRevision || state.submitting) { toast(t('草稿已变化，未导入文件')); return; }
    pendingImport = { draft, revision };
    element('#import-filename').textContent = file.name;
    const provider = state.session?.providers.find(provider => provider.id === draft.providerId);
    renderFacts(element('#import-facts'), [[t('证明环境'), environmentName(draft.environment)],
      [t('服务商'), provider?.name ?? t('{0} · 当前不可用', draft.providerId || t('未选择'))], [t('模型'), draft.model || t('未填写'), true],
      [t('推理强度'), effortLabels[draft.effort] ?? draft.effort], [t('轮次上限'), draft.maxTurns || t('未填写')],
      [t('解题预算 / 秒'), draft.maxRunSeconds || t('未填写')], [t('Agent 数量'), draft.workers || t('未填写')],
      [t('协作模式'), draft.coordination === 'cooperative' ? t('任务协作') : t('独立并行')]]);
    element('#import-task-preview').textContent = draft.task || t('未填写');
    element('#import-source-preview').textContent = draft.source || t('未填写');
    renderImportState();
    const dialog = element<HTMLDialogElement>('#import-task-dialog');
    showDialog(dialog);
    element('#cancel-import').focus();
  } catch (error) {
    if (sequence !== taskImportSequence || revision !== draftRevision) return;
    element('#draft-error').textContent = message(error);
    element('#draft-error').hidden = false;
  }
}
function applyTemplate(id: string) {
  const template = state.session?.templates.find(item => item.id === id && item.environment === field('environment').value);
  replaceDraft('template', () => {
    if (template) { field('source').value = template.source; field('task').value = template.task; }
    sourceChanged();
  });
}
function resetForm() {
  const session = state.session;
  if (!session || state.submitting) return;
  replaceDraft('reset', () => {
    clearValidation();
    draftSourceExpanded = false;
    const wasReady = draftReady;
    draftReady = false;
    clearTimeout(draftTimer); draftDirty = false;
    element<HTMLFormElement>('#run-form').reset();
    modulePlanLibrary.resetSelection(); modulePlanEditor.setValue(); serverModulePlans.setKnowledgeDigest();
    field('api-key').value = '';
    element<HTMLInputElement>('#api-key').type = 'password';
    updateKeyToggle();
    for (const [id, value] of Object.entries({ model: session.defaults.model, effort: session.defaults.effort,
      'max-turns': session.defaults.maxTurns, 'max-seconds': session.defaults.maxRunSeconds, workers: session.defaults.workers, 'max-tokens': '' })) field(id).value = String(value);
    element<HTMLInputElement>(`input[name="coordination"][value="${session.defaults.coordination}"]`).checked = true;
    field('provider').value = session.providers[0]?.id ?? '';
    field('environment').value = session.defaults.environment;
    renderTemplates('', true);
    field('source').value = ''; field('task').value = '';
    applyTemplate(field('template').value); providerAddress(); updateEnvironment();
    element('#form-error').hidden = true;
    element('#draft-error').hidden = true;
    draftReady = wasReady;
    if (wasReady) {
      try { sessionStorage.removeItem(taskDraftStorageKey); setDraftStatus(t('草稿已重置')); }
      catch { setDraftStatus(t('草稿保存不可用'), true); }
    }
  });
}
function setCustomSource(source: string) {
  if (field('template').value) field('task').value = t('保留原题声明，补全 Lean 证明并通过独立验收。');
  field('template').value = '';
  field('source').value = source;
  sourceChanged();
}
function updateEditorCount() {
  const source = field('expanded-source').value;
  const size = byteSize(source), limit = state.session?.limits.maxSourceBytes;
  const target = element('#editor-count');
  target.textContent = t('{0} 行 · {1}{2}', source.split(/\r\n|\r|\n/).length, byteLabel(size), limit ? ` / ${byteLabel(limit)}` : '');
  target.classList.toggle('over-limit', Boolean(limit && size > limit));
  const modified = source !== editorInitialSource;
  const changeStatus = element('#editor-change-status');
  patchText(changeStatus, modified ? t('修改尚未应用') : t('未修改'));
  changeStatus.classList.toggle('modified', modified);
  editorNavigation.updateSource();
  editorReview.updateSource();
  updateEditorPosition();
}
function updateEditorPosition() {
  const editor = element<HTMLTextAreaElement>('#expanded-source');
  const caret = editor.selectionDirection === 'backward' ? editor.selectionStart : editor.selectionEnd;
  const prefix = editor.value.slice(0, caret);
  const line = prefix.split('\n').length;
  const column = Array.from(prefix.slice(prefix.lastIndexOf('\n') + 1)).length + 1;
  const position = t('第 {0} 行 · 第 {1} 列', line, column), target = element('#editor-position');
  patchText(target, position);
  if (target.title !== position) target.title = position;
  editorNavigation.updateSelection();
}
function indentEditor(direction: IndentDirection) {
  if (!element<HTMLDialogElement>('#source-editor').open) return;
  const editor = element<HTMLTextAreaElement>('#expanded-source');
  const { value, selectionStart, selectionEnd, selectionDirection, scrollTop, scrollLeft } = editor;
  const edit = sourceIndentEdit(value, selectionStart, selectionEnd, direction);
  editor.focus({ preventScroll: true });
  if (edit) {
    editor.setSelectionRange(edit.from, edit.to);
    // Use the browser's edit transaction to retain native undo and redo.
    try { document.execCommand('insertText', false, edit.text); } catch {}
    const applied = editor.value === value.slice(0, edit.from) + edit.text + value.slice(edit.to);
    editor.setSelectionRange(applied ? edit.selectionStart : selectionStart, applied ? edit.selectionEnd : selectionEnd, selectionDirection);
    const error = element('#editor-error');
    error.hidden = applied;
    if (!applied) error.textContent = t('未能调整缩进，请直接编辑源码');
    updateEditorCount();
  }
  editor.scrollTop = scrollTop; editor.scrollLeft = scrollLeft;
  updateEditorPosition();
}
function openEditor(location?: { source: string; position: SourceSelection }) {
  const dialog = element<HTMLDialogElement>('#source-editor');
  if (!state.session || state.submitting || dialog.open) return;
  editorOpenedFromPreview = Boolean(location || document.activeElement?.closest('#draft-preview'));
  // Keep the settings dialog underneath so native modal focus returns to its caller.
  editorRevision = sourceRevision;
  const source = field('source').value;
  // A new native buffer keeps multiline undo transactions from an earlier opening out of this editor.
  const previous = element<HTMLTextAreaElement>('#expanded-source');
  const editor = previous.cloneNode(false) as HTMLTextAreaElement;
  editor.value = source;
  previous.replaceWith(editor);
  editorInitialSource = editor.value;
  editorClosePosition = undefined;
  editorNavigation.reset(editor);
  editorReview.reset(editor, editorInitialSource);
  editor.setSelectionRange(0, 0);
  const environment = environmentInfo(field('environment').value);
  element('#editor-environment').textContent = environment ? `${environment.name} · ${leanVersion(environment.toolchain)}` : '';
  element('#editor-error').hidden = true;
  updateEditorCount();
  showDialog(dialog);
  editor.focus();
  editor.scrollTop = 0; editor.scrollLeft = 0;
  if (location?.source === source) editorNavigation.locate(location.position);
}
function requestEditorClose() {
  const dialog = element<HTMLDialogElement>('#source-editor');
  const confirmation = element<HTMLDialogElement>('#editor-discard-dialog');
  if (!dialog.open || confirmation.open) return;
  editorReview.close();
  const editor = element<HTMLTextAreaElement>('#expanded-source');
  if (editor.value === editorInitialSource) { dialog.close(); return; }
  editorClosePosition = { start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection,
    top: editor.scrollTop, left: editor.scrollLeft };
  showDialog(confirmation);
  element('#keep-editing').focus();
}
function keepEditing() {
  const confirmation = element<HTMLDialogElement>('#editor-discard-dialog');
  if (!confirmation.open) return;
  confirmation.close();
  const position = editorClosePosition;
  editorClosePosition = undefined;
  if (!element<HTMLDialogElement>('#source-editor').open) return;
  editorReview.close();
  const editor = element<HTMLTextAreaElement>('#expanded-source');
  editor.focus({ preventScroll: true });
  if (position) {
    editor.setSelectionRange(position.start, position.end, position.direction);
    editor.scrollTop = position.top; editor.scrollLeft = position.left;
  }
  updateEditorPosition();
}
function discardEditorChanges() {
  element<HTMLDialogElement>('#editor-discard-dialog').close();
  editorClosePosition = undefined;
  element<HTMLDialogElement>('#source-editor').close();
}
function applyEditor() {
  const source = field('expanded-source').value;
  const error = !source.trim() ? t('Lean 源码不能为空')
    : source.includes('\0') ? t('源码包含无效字符')
      : byteSize(source) > (state.session?.limits.maxSourceBytes ?? 0) ? t('Lean 源码超出允许大小')
        : editorRevision !== sourceRevision ? t('原始草稿已变化，请重新打开编辑器后修改') : '';
  element('#editor-error').textContent = error;
  element('#editor-error').hidden = !error;
  if (error) { editorReview.close(); return; }
  editorReview.close();
  if (source !== field('source').value) replaceDraft('edit', () => setCustomSource(source));
  element<HTMLDialogElement>('#source-editor').close();
}
function updateKeyToggle() {
  const visible = element<HTMLInputElement>('#api-key').type === 'text';
  const button = element('#toggle-key');
  button.setAttribute('aria-label', visible ? t('隐藏 API Key') : t('显示 API Key'));
  button.setAttribute('title', visible ? t('隐藏 API Key') : t('显示 API Key'));
  button.setAttribute('aria-pressed', String(visible));
  renderGlyph(button, visible ? 'eye-off' : 'eye');
}
function renderRuntime() {
  const session = state.session;
  const ready = Boolean(state.connected && session?.runtime.ready && session.providers.length);
  element('#runtime-note').textContent = !state.connected ? t('连接恢复后可提交') : session
    ? !session.providers.length ? t('未配置可用服务商') : localizeText(session.runtime.message) || (ready ? t('环境就绪') : t('环境未就绪'))
    : t('等待连接');
  element<HTMLButtonElement>('#submit-run').disabled = !ready || state.submitting;
  renderGlyph(element('#submit-run'), state.submitting ? 'spinner' : 'arrow-up');
  element('#submit-run').setAttribute('aria-label', state.submitting ? t('正在提交') : t('发送研究任务'));
  element<HTMLButtonElement>('#settings-submit').disabled = !ready || state.submitting;
  element<HTMLFieldSetElement>('#form-fields').disabled = !session || state.submitting;
  element<HTMLButtonElement>('#reset-form').disabled = !session || state.submitting;
  element<HTMLButtonElement>('#import-task').disabled = !session || state.submitting;
  element<HTMLButtonElement>('#export-draft').disabled = !session || state.submitting;
  element<HTMLButtonElement>('#new-research').disabled = !session || state.submitting;
  renderDraftRecovery();
  renderRunMonitor();
  renderImportState();
  renderDeleteState();
  renderConversation();
  if (state.draftView === 'modules') renderDraftPreview();
  // Connecting (or losing the connection) starts or stops the statement check.
  sourceCheck.schedule();
}
function status(run: WebRun) {
  if (passed(run)) return { label: t('完整原题通过'), tone: 'passed', symbol: 'circle-check' };
  if (run.status === 'queued') return { label: run.queue ? t('排队中 · 第 {0} 位', run.queue.position) : t('排队中'), tone: '', symbol: 'clock-3' };
  if (run.status === 'running') return { label: runProgress(run).phaseLabel, tone: 'running', symbol: 'refresh-cw' };
  if (run.status === 'cancelled') return { label: t('已取消'), tone: '', symbol: 'square' };
  if (run.status === 'error') return { label: t('运行错误'), tone: 'failed', symbol: 'circle-alert' };
  // A stopped budget is an expected end; other classified failures need the user to act.
  if (run.failure && !['budget', 'time_limit'].includes(run.failure.kind)) return { label: t('运行失败'), tone: 'failed', symbol: 'circle-alert' };
  if (['evaluated_failed', 'evaluated_rejected'].includes(run.result?.status ?? '')) return { label: t('验收未通过'), tone: 'failed', symbol: 'circle-alert' };
  return { label: t('运行结束'), tone: 'warning', symbol: 'clock-3' };
}
function rememberFinishedRuns(previous: readonly WebRun[]) {
  const active = new Set(previous.filter(activeRun).map(run => run.id));
  for (const run of state.runs) {
    if (active.has(run.id) && !activeRun(run) && run.id !== state.selectedId) state.finishedRuns.add(run.id);
  }
}
function renderRunMonitor() {
  const root = element('#run-monitor'), list = element('#run-monitor-list');
  const available = new Set(state.runs.map(run => run.id));
  for (const id of state.finishedRuns) if (!available.has(id) || id === state.selectedId) state.finishedRuns.delete(id);
  const runs = state.runs.filter(run => activeRun(run) || state.finishedRuns.has(run.id)).toReversed();
  const active = runs.filter(activeRun).length, finished = runs.length - active;
  root.hidden = !runs.length;
  root.dataset.stale = String(!state.connected);
  patchText(element('#run-monitor-summary'), [active ? t('{0} 项进行中', active) : '', finished ? t('{0} 项已结束', finished) : ''].filter(Boolean).join('\n'));
  const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : undefined;
  const left = list.scrollLeft;
  drawRunMonitor(list, runs.map((run): MonitorItem => {
    const value = status(run), cancelling = activeRun(run) && state.cancelling.has(run.id);
    const label = cancelling ? t('正在取消') : value.label;
    return { id: run.id, title: run.title, description: state.connected ? label : t('待同步 · {0}', label), tone: value.tone, symbol: value.symbol,
      current: run.id === state.selectedId, cancelling, active: activeRun(run), stages: runProgress(run).steps.map(step => step.state) };
  }));
  list.scrollLeft = left;
  if (focused && !focused.isConnected && !document.querySelector('dialog[open]')) element('#open-history').focus({ preventScroll: true });
  renderShell();
}
function rememberHistoryScroll() {
  const list = element('#run-list');
  if (!list.getClientRects().length) return;
  const top = list.getBoundingClientRect().top + list.clientTop;
  const rows = Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-history-id]'), row => {
    const bounds = row.getBoundingClientRect();
    return { id: row.dataset.historyId!, offset: bounds.top - top, bottom: bounds.bottom - top };
  });
  const firstVisible = rows.findIndex(row => row.bottom > 0);
  // Keep a surviving row at its previous offset when entries above it change.
  const ordered = firstVisible < 0 ? rows.toReversed() : [...rows.slice(firstVisible), ...rows.slice(0, firstVisible).reverse()];
  historyReading = { top: list.scrollTop, anchors: ordered.map(({ id, offset }) => ({ id, offset })) };
}
function restoreHistoryScroll() {
  const list = element('#run-list');
  if (!list.getClientRects().length) return;
  const rows = new Map(Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-history-id]'), row => [row.dataset.historyId, row]));
  const anchor = historyReading.anchors.find(anchor => rows.has(anchor.id));
  if (historyReading.top && anchor) {
    const top = list.getBoundingClientRect().top + list.clientTop;
    list.scrollTop += rows.get(anchor.id)!.getBoundingClientRect().top - top - anchor.offset;
  } else list.scrollTop = historyReading.top;
  rememberHistoryScroll();
}
function closeHistoryDialog() {
  rememberHistoryScroll();
  element<HTMLDialogElement>('#history-dialog').close();
}
function renderRunList(force = false) {
  renderRunMonitor();
  const runs = visibleRuns();
  const filtered = Boolean(state.query.trim() || state.filter !== 'all');
  const criteria = JSON.stringify([state.query, state.filter]);
  const signature = JSON.stringify([state.selectedId, criteria, runs.map(run => [run.id, run.title, run.model, run.createdAt, environmentName(run.environment), status(run)])]);
  patchText(element('#run-count'), filtered ? `${runs.length}/${state.runs.length}` : String(state.runs.length));
  patchText(element('#mobile-run-count'), String(state.runs.length));
  element('#clear-run-search').hidden = !state.query;
  if (!force && signature === state.listSignature) return;
  state.listSignature = signature;
  if (criteria === historyCriteria) rememberHistoryScroll();
  else historyReading = { top: 0, anchors: [] };
  historyCriteria = criteria;
  const list = element('#run-list');
  const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : undefined;
  const rows = new Map(Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-history-id]'), row => [row.dataset.historyId!, row]));
  const focusedIndex = Array.from(rows.keys()).indexOf(focused?.dataset.runId ?? '');
  const ids = new Set(runs.map(run => run.id));
  for (const child of Array.from(list.children)) {
    const row = child as HTMLElement;
    if (!ids.has(row.dataset.historyId ?? '') && (runs.length || !row.hasAttribute('data-history-empty'))) row.remove();
  }
  let cursor = list.firstElementChild;
  for (const run of runs) {
    let row = rows.get(run.id);
    if (!row) {
      row = document.createElement('div'); row.setAttribute('role', 'listitem'); row.dataset.historyId = run.id;
      rows.set(run.id, row);
    }
    const value = status(run);
    renderHistoryRow(row, { id: run.id, title: run.title, model: run.model, environment: environmentName(run.environment), selected: run.id === state.selectedId,
      tone: value.tone, symbol: value.symbol, label: value.label, createdAt: run.createdAt, time: timestamp(run.createdAt) });
    if (row !== cursor) list.insertBefore(row, cursor);
    cursor = row.nextElementSibling;
  }
  if (!runs.length) {
    let empty = list.querySelector<HTMLElement>('[data-history-empty]');
    if (!empty) {
      empty = document.createElement('div'); empty.className = 'empty-state compact';
      empty.dataset.historyEmpty = ''; empty.setAttribute('role', 'status'); list.append(empty);
    }
    renderHistoryEmpty(empty, filtered);
  }
  restoreHistoryScroll();
  if (focused && document.activeElement !== focused && list.getClientRects().length) {
    const fallback = rows.get(runs[Math.min(Math.max(focusedIndex, 0), runs.length - 1)]?.id ?? '')?.querySelector<HTMLButtonElement>('button');
    (focused.isConnected ? focused : fallback ?? field('run-search')).focus({ preventScroll: true });
  }
}
const visibleRuns = () => filterRuns(state.runs, state.query, state.filter);
function clearFilters() {
  state.query = ''; state.filter = 'all';
  field('run-search').value = ''; field('run-filter').value = 'all';
  renderRunList();
}
const isSample = (run?: WebRun) => Boolean(run && run.id === state.session?.sample?.id);
const sampleSelected = () => Boolean(state.selectedId && state.selectedId === state.session?.sample?.id);
const currentRun = () => state.selectedRun?.id === state.selectedId ? state.selectedRun
  : sampleSelected() ? state.sample : state.runs.find(run => run.id === state.selectedId);
const downloadUrl = (id: string) => `/api/runs/${encodeURIComponent(id)}/download`;
function resultTitle(run: WebRun) {
  const guide = failureGuide(run);
  if (guide) return guide.title;
  return passed(run) ? t('完整原题已通过独立验收')
    : activeRun(run) ? run.status === 'queued' ? t('任务已排队') : t('研究正在运行')
      : run.status === 'cancelled' ? t('运行已取消')
        : run.status === 'error' ? t('运行发生错误')
          : ['evaluated_failed', 'evaluated_rejected'].includes(run.result?.status ?? '') ? t('完整原题验收未通过') : t('运行已结束，完整原题尚未验收通过');
}
function banner(run: WebRun): Banner {
  const value = status(run);
  return { tone: value.tone, symbol: value.symbol, title: resultTitle(run), description: resultDescription(run) };
}
const stepLabels = { done: t('已完成'), active: t('进行中'), stopped: t('已停止'), error: t('未通过'), pending: t('等待中'), skipped: t('未执行') };
function overviewProps(run: WebRun): RunOverviewProps {
  const progress = runProgress(run), value = status(run);
  const provider = state.session?.providers.find(item => item.id === run.providerId);
  const environment = environmentInfo(run.environment);
  const total = Math.max(1, progress.elapsed ?? 0);
  const item = (label: string, value: unknown, mono = false) => ({ label, value: String(value), mono });
  return {
    runId: run.id, active: activeRun(run), tone: value.tone, symbol: value.symbol, title: resultTitle(run), description: resultDescription(run),
    phaseLabel: progress.phaseLabel, elapsed: formatDuration(progress.elapsed),
    solving: progress.solvingElapsed === null ? t('尚未开始') : formatDuration(progress.solvingElapsed),
    budget: formatDuration(run.maxRunSeconds * 1000), budgetUsed: (progress.solvingElapsed ?? 0) / (run.maxRunSeconds * 1000),
    steps: progress.steps.map(step => ({ label: step.label, state: step.state, stateLabel: stepLabels[step.state], clock: formatDuration(step.elapsed),
      share: step.elapsed === null ? 0 : Math.min(1, step.elapsed / total) })),
    downloads: { proof: Boolean(run.result?.proof), report: Boolean(run.result) },
    task: run.task,
    facts: [item(t('证明环境'), environmentName(run.environment)), ...(environment ? [item(t('Lean 版本'), environment.toolchain, true)] : []),
      ...(environment?.mathlibRevision ? [item(t('Mathlib 版本'), environment.mathlibRevision, true)] : []), item(t('服务商'), provider?.name ?? (isSample(run) ? t('离线示例') : run.providerId)),
      item(t('模型'), run.model, true), item(t('推理强度'), effortLabels[run.effort] ?? run.effort), item(t('协作模式'), run.coordination === 'cooperative' ? t('任务协作') : t('独立并行')),
      item(t('Agent 数量'), run.workers), item(t('轮次上限'), run.maxTurns), item(t('解题预算'), t('{0} 秒', run.maxRunSeconds)),
      item(t('用量上限'), run.maxTotalTokens ? `${formatTokens(run.maxTotalTokens)} Token` : t('不限')), item(t('创建时间'), timestamp(run.createdAt)),
      ...(run.finishedAt ? [item(t('结束时间'), timestamp(run.finishedAt))] : [])],
    agents: (activeRun(run) ? run.observation?.inspection.workers ?? [] : []).map(worker => ({ id: worker.id, state: worker.scheduling?.status ?? 'unknown', phase: workerPhaseLabel(worker.phase) ?? t('未记录'),
      ...(worker.task ? { task: worker.task } : {}) })),
    events: run.events.slice(-6).reverse().map(event => ({ sequence: event.sequence, at: event.at, time: timestamp(event.at, true), type: event.type, message: localizeText(event.message) })),
    eventCount: run.events.length,
  };
}
function renderOverview(run: WebRun) {
  const root = document.querySelector<HTMLElement>('#detail-panel .overview-workspace');
  if (root) renderRunOverview(root, overviewProps(run));
}
function updateClocks() {
  const run = currentRun();
  if (!run || document.hidden || !activeRun(run)) return;
  if (state.tab === 'overview') renderOverview(run);
  renderRunHeader(run); renderShell();
}
const candidateSource = (run: WebRun) => run.result?.proof || run.artifact?.source || '';
const displayedSource = (run: WebRun) => state.sourceView !== 'input' && candidateSource(run) ? candidateSource(run) : run.source;
function sourceContent(run: WebRun) {
  const hasProof = Boolean(candidateSource(run));
  const showingProof = hasProof && state.sourceView !== 'input';
  const verified = Boolean(run.result?.proof && passed(run));
  const proofLabel = verified ? t('验收证明') : t('候选源码');
  const source = displayedSource(run);
  const lineCount = source.split(/\r\n|\r|\n/).length;
  const props: SourcePanelProps = { hasProof, proofLabel, view: state.sourceView, showingProof, verified,
    status: showingProof ? verified ? t('完整原题已通过验收') : t('候选 · 尚未验收通过') : activeRun(run) && !hasProof ? t('原始题目 · 等待候选') : t('原始题目'),
    tone: showingProof ? verified ? 'verified' : 'candidate' : '',
    origin: showingProof && !run.result?.proof && run.artifact ? `${run.artifact.workerId} · ${timestamp(run.artifact.capturedAt, true)}` : t('{0} 行 · {1}', lineCount, byteLabel(byteSize(source))) };
  return { props, diff: hasProof && state.sourceView === 'diff', source: source.replace(/\r\n?/g, '\n'),
    numbers: Array.from({ length: lineCount }, (_, index) => index + 1).join('\n') };
}
function updateSourceReader() {
  const run = currentRun();
  if (!run && state.draftView === 'modules') { sourceReader.update(); return; }
  const editableSource = !run ? field('source').value : undefined;
  const code = document.querySelector<HTMLElement>(run ? '#detail-panel .source-code code' : '#draft-preview-code code');
  const scroll = document.querySelector<HTMLElement>(run ? '#detail-panel .source-code-grid' : '.draft-source-scroll');
  const toolbar = document.querySelector<HTMLElement>('#run-detail .source-reader');
  sourceReader.update(code && scroll && toolbar ? { id: run?.id ?? 'draft', code, scroll, toolbar,
    ...(editableSource === undefined ? {} : { edit: { source: editableSource,
      open: (position: SourceSelection) => openEditor({ source: editableSource, position }) } }),
    ...(!run && document.querySelector('.preview-source-heading>span[data-truncated]')
      ? { scope: t('仅查看当前预览的前 160 行；缩小源码至允许大小后可查看完整文件。') } : {}) } : undefined);
}
function sourceDiff(run: WebRun): SourcePanelProps['diff'] {
  const before = run.source, after = candidateSource(run);
  const sourceChanged = sourceComparison?.runId !== run.id || sourceComparison.before !== before || sourceComparison.after !== after;
  if (sourceChanged || sourceComparison?.folded !== state.foldUnchanged) {
    sourceComparison = { runId: run.id, before, after, folded: state.foldUnchanged, result: compareSources(before, after, state.foldUnchanged) };
    if (sourceChanged) state.diffChange = 0;
  }
  return { comparison: sourceComparison!.result, folded: state.foldUnchanged, accepted: passed(run) };
}
function updateDiffNavigation(move = 0, align = false) {
  const scroll = document.querySelector<HTMLElement>('#detail-panel .diff-scroll');
  if (!scroll) return;
  const changes = Array.from(scroll.querySelectorAll<HTMLElement>('[data-change-start]'));
  state.diffChange = Math.max(0, Math.min(state.diffChange + move, changes.length - 1));
  element<HTMLButtonElement>('[data-action="diff-prev"]').disabled = !changes.length || state.diffChange === 0;
  element<HTMLButtonElement>('[data-action="diff-next"]').disabled = state.diffChange >= changes.length - 1;
  element('#diff-position').textContent = `${changes.length ? state.diffChange + 1 : 0}/${changes.length}`;
  changes.forEach((row, index) => row.classList.toggle('diff-change-current', index === state.diffChange));
  if ((move || align) && changes[state.diffChange]) {
    const headerHeight = scroll.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    scroll.scrollTop += changes[state.diffChange].getBoundingClientRect().top - scroll.getBoundingClientRect().top - headerHeight;
  }
}
function reportProps(run: WebRun): ReportPanelProps {
  if (!run.result) return run.error ? { kind: 'error', banner: banner(run), error: run.error } : { kind: 'empty', active: activeRun(run) };
  if (state.reportMode === 'json') return { kind: 'json', report: run.result.report };
  const stuck = summarizeStuck(run);
  return { kind: 'summary', banner: banner(run), summary: summarizeReport(run), accepted: passed(run), ...(stuck ? { stuck } : {}),
    ...(run.result.proof ? { outline: { state: outlines.get(run.id), kitUrl: `/api/runs/${encodeURIComponent(run.id)}/verification-kit`,
      mathlib: Boolean(environmentInfo(run.environment)?.mathlibRevision ?? run.environment === 'mathlib') } } : {}) };
}
const outlines = new Map<string, OutlineState>();
/** Starts loading the proof outline; the report re-renders when it arrives. Returns whether a request started. */
function loadOutline(run: WebRun, retry = false) {
  if (!run.result?.proof || outlines.has(run.id) && !retry) return false;
  outlines.set(run.id, { status: 'loading' });
  void api<{ outline: WebProofOutline }>(`/api/runs/${encodeURIComponent(run.id)}/outline`)
    .then(({ outline }) => { outlines.set(run.id, { status: 'ready', outline }); })
    .catch(error => { outlines.set(run.id, { status: 'failed', error: t('证明结构整理失败：{0}', message(error)) }); })
    .finally(() => { if (currentRun()?.id === run.id && state.tab === 'report') renderPanel(true); });
  return true;
}
function renderPanel(force = false) {
  const run = currentRun();
  if (!run || !document.querySelector('#detail-panel')) return;
  if (state.tab === 'report' && state.reportMode === 'summary') loadOutline(run);
  const content = state.tab === 'source' ? sourceContent(run) : undefined;
  const signature = JSON.stringify([run.id, state.tab, content ? [state.foldUnchanged, content.source, content.props]
    : state.tab === 'report' ? [state.reportMode, run.status, run.error, run.result, run.observation?.sequence, outlines.get(run.id)] : state.tab === 'events' ? run.events
      : state.tab === 'modules' ? [run, state.connected] : run]);
  if (!force && signature === state.panelSignature) {
    if (state.tab === 'collaboration') collaborationView.update(document.querySelector<HTMLElement>('.collaboration-workspace') ?? undefined, run, state.connected, isSample(run));
    return;
  }
  state.panelSignature = signature;
  const panel = element('#detail-panel');
  const navigating = panel.dataset.renderRunId === run.id && (panel.dataset.tab !== state.tab
    || state.tab === 'source' && panel.dataset.renderSourceView !== state.sourceView
    || state.tab === 'report' && panel.dataset.renderReportMode !== state.reportMode);
  if (navigating) finishMotion(panel);
  const samePanel = panel.dataset.renderRunId === run.id && panel.dataset.tab === state.tab;
  const switchingReport = samePanel && state.tab === 'report' && panel.dataset.renderReportMode !== state.reportMode;
  // A tab opens at its top; the collaboration view restores its own reading position below.
  const switchingTab = panel.dataset.renderRunId === run.id && panel.dataset.tab !== state.tab;
  const sameView = samePanel && (state.tab !== 'source' || panel.dataset.renderSourceView === state.sourceView);
  const previousScroll = panel.querySelector('.code-scroll,.activity-scroll,.diff-scroll');
  const scrollTop = sameView ? previousScroll?.scrollTop ?? 0 : 0;
  const scrollLeft = sameView ? previousScroll?.scrollLeft ?? 0 : 0;
  const focused = document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)
    ? document.activeElement : undefined;
  const action = focused?.dataset.action;
  const sourceMode = focused?.dataset.sourceView;
  const reportMode = focused?.dataset.reportView;
  const focusId = focused?.id;
  // Each tab mounts its own tree, so a workspace host is only reused within the same tab of the same run.
  if (!samePanel || state.tab !== 'events') activityReader.update(undefined, run);
  if (!samePanel || state.tab !== 'modules') moduleView.update(undefined, moduleInput(run));
  if (!samePanel || state.tab !== 'collaboration') collaborationView.update();
  if (!samePanel || state.tab !== 'overview') unmountRunOverview(panel);
  const tab = state.tab;
  renderDetailPanel(panel, content ? { tab: 'source', source: content.diff ? { ...content.props, diff: sourceDiff(run) } : content.props }
    : tab === 'report' ? { tab, report: reportProps(run) } : { tab: tab as Exclude<DetailTab, 'source' | 'report'> });
  if (content && !content.diff) {
    patchText(panel.querySelector('.source-line-numbers')!, content.numbers);
    patchText(panel.querySelector('.source-code code')!, content.source);
  }
  panel.dataset.renderRunId = run.id; panel.dataset.tab = state.tab;
  panel.dataset.renderSourceView = state.sourceView;
  panel.dataset.renderReportMode = state.reportMode;
  if (switchingReport || switchingTab) { panel.scrollTop = 0; panel.scrollLeft = 0; }
  const scroll = panel.querySelector<HTMLElement>('.code-scroll,.activity-scroll,.diff-scroll');
  if (scroll && state.tab !== 'events') { scroll.scrollTop = scrollTop; scroll.scrollLeft = scrollLeft; }
  if (samePanel && action) panel.querySelector<HTMLElement>(`[data-action="${action}"]`)?.focus({ preventScroll: true });
  else if (samePanel && sourceMode) panel.querySelector<HTMLElement>(`[data-source-view="${sourceMode}"]`)?.focus({ preventScroll: true });
  else if (sameView && reportMode) panel.querySelector<HTMLElement>(`[data-report-view="${reportMode}"]`)?.focus({ preventScroll: true });
  else if (sameView && focused === previousScroll) scroll?.focus({ preventScroll: true });
  else if (samePanel && focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  if (state.tab === 'collaboration') collaborationView.update(panel.querySelector<HTMLElement>('.collaboration-workspace')!, run, state.connected, isSample(run));
  if (state.tab === 'events') activityReader.update(panel.querySelector<HTMLElement>('.activity-workspace')!, run);
  if (state.tab === 'modules') moduleView.update(panel.querySelector<HTMLElement>('.module-workspace')!, moduleInput(run));
  if (state.tab === 'overview') renderOverview(run);
  updateDiffNavigation(0, !sameView);
  if (navigating) animateEntrance(panel, 'panel');
  updateSourceReader();
}
function moduleInput(run?: WebRun): ModuleViewInput {
  return { id: run?.id ?? 'draft', run, model: run?.model ?? field('model').value,
    workers: run?.workers ?? Number(field('workers').value),
    coordination: run?.coordination ?? element<HTMLInputElement>('input[name="coordination"]:checked').value as WebCoordination,
    environment: environmentName(run?.environment ?? field('environment').value), connected: state.connected,
    editable: !run && Boolean(state.session) && !state.submitting,
    modulePlan: run ? run.modulePlan : captureDraft().modulePlan };
}
function renderDraftPreview(force = false) {
  if (currentRun() || !state.session) return;
  const detail = element('#run-detail');
  // Hidden panes cannot restore scroll offsets; refresh them when they become visible.
  if (!detail.getClientRects().length) return;
  const source = field('source').value, task = field('task').value;
  const template = state.session.templates.find(item => item.id === field('template').value && item.environment === field('environment').value);
  const environment = environmentInfo(field('environment').value);
  const numericLabel = (id: string, label: (value: number) => string) => {
    const value = Number(field(id).value);
    return field(id).value && Number.isSafeInteger(value) && value > 0 ? label(value) : t('未设置');
  };
  const facts = [
    ['environment', t('证明环境'), environment?.name ?? t('未选择'), false],
    ['model', t('模型'), field('model').value || t('未设置'), true],
    ['budget', t('解题预算'), numericLabel('max-seconds', value => t('{0} 秒', value)), true],
    ['workers', t('Agent 数量'), numericLabel('workers', value => t('{0} 个 Agent', value)), true],
  ] as const;
  const title = template?.name ?? t('自定义研究');
  const signature = JSON.stringify([title, source, task, facts, draftSourceExpanded, state.draftView, state.connected,
    element<HTMLInputElement>('input[name="coordination"]:checked').value, captureDraft().modulePlan, state.submitting]);
  if (!force && signature === draftPreviewSignature && document.querySelector('#draft-preview')) return;
  draftPreviewSignature = signature;
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const shown = draftSourceExpanded && byteSize(source) <= state.session.limits.maxSourceBytes ? lines : lines.slice(0, 160);
  if (!detail.querySelector('#draft-preview')) {
    moduleView.update();
    finishMotion(detail);
    unmountRunOverview(detail); unmountRunHeader(detail);
    detail.textContent = '';
  }
  const truncated = lines.length > shown.length;
  drawDraftPreview(detail, { title, facts, truncated, task: task || t('未填写'), view: state.draftView,
    size: t('{0} 行 · {1}', truncated ? t('前 {0} / {1}', shown.length, lines.length) : lines.length, byteLabel(byteSize(source))) });
  patchText(detail.querySelector('.preview-line-numbers')!, shown.map((_, index) => index + 1).join('\n'));
  patchText(detail.querySelector('#draft-preview-code code')!, shown.join('\n'));
  const showingModules = state.draftView === 'modules';
  if (!showingModules) moduleView.update(undefined, moduleInput());
  if (showingModules) moduleView.update(detail.querySelector<HTMLElement>('.module-workspace')!, moduleInput());
  updateSourceReader();
}
function renderDetail(force = false) {
  renderConversation();
  const run = currentRun();
  if (sourceComparison && sourceComparison.runId !== run?.id) sourceComparison = undefined;
  if (!run) {
    collaborationView.update();
    activityReader.update();
    state.panelSignature = '';
    if (state.session) renderDraftPreview();
    else {
      const detail = element('#run-detail');
      unmountRunOverview(detail); unmountRunHeader(detail); detail.textContent = '';
      renderConnecting(detail); sourceReader.update();
    }
    return;
  }
  const detail = element('#run-detail');
  const focused = document.activeElement instanceof HTMLElement && detail.contains(document.activeElement)
    ? document.activeElement : undefined;
  const focusId = focused?.id;
  const focusAction = focused?.dataset.action;
  const newDetail = detail.dataset.renderRunId !== run.id || !detail.querySelector('#detail-panel');
  if (newDetail) {
    collaborationView.update();
    moduleView.update();
    finishMotion(detail);
    unmountRunOverview(detail); unmountRunHeader(detail);
    detail.textContent = '';
    renderRunHeader(run);
    const panel = document.createElement('div');
    panel.className = 'detail-panel'; panel.id = 'detail-panel'; panel.setAttribute('role', 'tabpanel'); panel.tabIndex = 0;
    detail.append(panel);
    detail.dataset.renderRunId = run.id;
    state.panelSignature = '';
  } else renderRunHeader(run);
  element('#detail-panel').setAttribute('aria-labelledby', `detail-tab-${state.tab}`);
  renderPanel(force);
  if (focused?.isConnected) focused.focus({ preventScroll: true });
  else if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  else if (focusAction) detail.querySelector<HTMLElement>(`[data-action="${focusAction}"]`)?.focus({ preventScroll: true });
}
function renderRunHeader(run: WebRun) {
  const value = status(run), progress = runProgress(run), cancelling = state.cancelling.has(run.id);
  drawRunHeader(element('#run-detail'), {
    title: run.title, id: run.id, environment: environmentName(run.environment), updated: t('更新 {0}', timestamp(run.updatedAt)), error: state.detailError,
    status: { key: `${run.status}:${run.phase}:${value.label}`, ...value },
    stages: progress.steps.map(step => ({ label: step.label, state: step.state, clock: step.elapsed === null ? '' : formatDuration(step.elapsed) })),
    elapsed: formatDuration(progress.elapsed), tabs: detailTabs, tab: state.tab,
    active: activeRun(run), cancelling, deleting: state.deleting.has(run.id), connected: state.connected,
    download: run.result || !activeRun(run) ? downloadUrl(run.id) : undefined, shareable: !isSample(run) && isAcceptedRun(run) && Boolean(run.result?.proof),
    sample: isSample(run),
  });
}
function selectRun(id: string, closeHistory = true) {
  if (!state.runs.some(run => run.id === id)) return;
  state.composing = false;
  state.selectedId = id; state.selectedRun = state.runs.find(run => run.id === id);
  saveResume(() => localStorage, { selectedId: id, seenAt: new Date().toISOString() });
  state.tab = 'collaboration'; state.sourceView = 'proof'; state.reportMode = 'summary'; state.detailError = ''; state.panelSignature = '';
  state.diffChange = 0;
  renderRunList(); renderDetail(true);
  if (closeHistory) closeHistoryDialog();
}
/** The server names templates, environments and the sample in Chinese; known names are shown in the interface language. */
function localizeSession(session: WebSession): WebSession {
  return { ...session,
    environments: session.environments.map(environment => ({ ...environment, name: localizeText(environment.name), description: localizeText(environment.description) })),
    templates: session.templates.map(template => ({ ...template, name: localizeText(template.name), task: localizeText(template.task) })),
    ...(session.sample ? { sample: { ...session.sample, title: localizeText(session.sample.title) } } : {}) };
}
/** Opens the recorded sample run; it needs no API key and does not change the saved position in the user's own runs. */
async function openSample() {
  const sample = state.session?.sample;
  if (!sample) return;
  if (!state.sample) {
    try {
      const run = (await api<{ run: WebRun }>(`/api/runs/${encodeURIComponent(sample.id)}`))?.run;
      state.sample = run && { ...run, title: localizeText(run.title), task: localizeText(run.task), model: localizeText(run.model) };
    }
    catch (error) { toast(t('无法打开示例运行：{0}', message(error))); return; }
    if (!state.sample) return;
  }
  state.composing = false;
  state.selectedId = sample.id; state.selectedRun = state.sample;
  state.tab = 'overview'; state.sourceView = 'proof'; state.reportMode = 'summary'; state.detailError = ''; state.panelSignature = '';
  state.diffChange = 0;
  renderRunList(); renderDetail(true); renderShell();
  closeHistoryDialog(); setMobileView('runs');
}
function startDraft(reset = false) {
  state.composing = true;
  state.selectedId = ''; state.selectedRun = undefined;
  state.tab = 'source'; state.sourceView = 'proof'; state.detailError = '';
  state.draftView = 'source';
  moduleView.update(undefined, moduleInput());
  state.panelSignature = ''; draftPreviewSignature = '';
  if (reset) resetForm();
  renderRunList(); renderDetail(true); setMobileView('compose');
}
const currentConnection = (epoch: number) => pageActive && epoch === state.connectionEpoch;
const sessionFailure = (error: unknown) => error instanceof ApiError
  && (error.status === 401 || error.status === 403 && error.message.includes('会话校验'));
function invalidateReads() {
  runUpdates.stop();
  liveRefreshPending = false;
  state.connectionEpoch++;
  state.listGeneration++;
  state.runsEtag = '';
  readController.abort();
  readController = new AbortController();
  state.refreshing = false;
}
function disconnected(text: string) {
  state.connected = false;
  runUpdates.stop();
  liveRefreshPending = false;
  setGlobalNotice(text);
  element('#runs-error').textContent = t('连接中断，记录可能不是最新状态');
  element('#runs-error').hidden = false;
  renderRuntime(); renderDetail();
}
function retainLatestObservation(run: WebRun, previous?: WebRun): WebRun {
  const observation = previous?.observation;
  if (!observation || run.observation && run.observation.solverRunId === observation.solverRunId
    && run.observation.sequence > observation.sequence) return run;
  return { ...run, observation, updatedAt: run.updatedAt > previous.updatedAt ? run.updatedAt : previous.updatedAt };
}
function receiveRunObservation(observation: WebObservation) {
  const previous = state.runs.find(run => run.id === observation.webRunId);
  if (!previous || previous.observation && (previous.observation.solverRunId !== observation.solverRunId
    || previous.observation.sequence >= observation.sequence)) return;
  const run = { ...previous, observation,
    updatedAt: previous.updatedAt > observation.observedAt ? previous.updatedAt : observation.observedAt };
  state.runs = state.runs.map(item => item.id === run.id ? run : item);
  if (state.selectedId === run.id) state.selectedRun = run;
  renderRunList(); renderDetail();
}
async function refreshRuns(epoch: number, force = false) {
  const generation = ++state.listGeneration;
  let etag: string | null = null;
  const result = await api<{ runs: WebRun[] }>('/api/runs', {
    headers: !force && state.runsEtag ? { 'If-None-Match': state.runsEtag } : {},
  }, value => { etag = value; });
  if (generation !== state.listGeneration || !currentConnection(epoch)) return;
  state.runsEtag = etag ?? '';
  element('#runs-error').hidden = true;
  if (!result) return;
  const previous = state.runs;
  const byId = new Map(previous.map(run => [run.id, run]));
  state.runs = result.runs.map(run => retainLatestObservation(run, byId.get(run.id))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const resume = state.resumed ? undefined : readResume(() => localStorage);
  if (!state.resumed && !state.composing && !state.selectedId && resume && state.runs.some(run => run.id === resume.selectedId)) {
    state.selectedId = resume.selectedId;
    state.tab = 'collaboration'; state.sourceView = 'proof'; state.reportMode = 'summary'; state.panelSignature = '';
  }
  if (!state.composing && !sampleSelected() && (!state.selectedId || !state.runs.some(run => run.id === state.selectedId))) {
    state.selectedId = state.runs[0]?.id ?? '';
    state.tab = 'collaboration'; state.sourceView = 'proof'; state.reportMode = 'summary'; state.panelSignature = '';
  }
  state.selectedRun = sampleSelected() ? state.sample : state.runs.find(run => run.id === state.selectedId);
  rememberFinishedRuns(previous);
  for (const run of newlyFinished(previous, state.runs)) announceFinished(run);
  if (!state.resumed) {
    state.resumed = true;
    const away = resume ? finishedSince(state.runs, resume.seenAt) : [];
    for (const run of away) if (run.id !== state.selectedId) state.finishedRuns.add(run.id);
    if (away.length) toast(away.length === 1 ? t('离开期间「{0}」已结束', away[0].title) : t('离开期间有 {0} 项研究已结束', away.length));
  }
  // Nothing to resume until the account has a run; an empty history leaves storage untouched.
  // The sample is not a run to come back to; keep the last real selection but still record when the user was here.
  if (state.runs.length) saveResume(() => localStorage, { selectedId: sampleSelected() ? readResume(() => localStorage)?.selectedId ?? state.runs[0].id : state.selectedId, seenAt: new Date().toISOString() });
  state.detailError = '';
  element('#runs-error').hidden = true;
  renderRunList(); renderDetail(); renderDeleteState(); renderBudgetEstimate();
}
async function poll(force = false) {
  if (!pageActive) return;
  if (connectionRequest) return connectionRequest;
  if (!state.connected) return initialize();
  if (state.refreshing) return;
  const epoch = state.connectionEpoch;
  liveRefreshPending = false;
  state.refreshing = true;
  element<HTMLButtonElement>('#refresh-runs').disabled = true;
  try { await refreshRuns(epoch, force); }
  catch (error) {
    if (!currentConnection(epoch)) return;
    disconnected(t('{0}。未提交内容已保留。', message(error)));
    if (sessionFailure(error)) await initialize();
  } finally {
    if (currentConnection(epoch)) state.refreshing = false;
    element<HTMLButtonElement>('#refresh-runs').disabled = !pageActive || Boolean(connectionRequest) || state.refreshing;
    if (currentConnection(epoch) && state.connected && !document.hidden && liveRefreshPending) void poll();
  }
}
function requestRunsRefresh() {
  liveRefreshPending = true;
  void poll();
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!pageActive) return;
  // A hidden tab keeps a slow poll while runs are active, so their end still reaches the title and notifications.
  const active = state.connected && state.runs.some(activeRun);
  pollTimer = setTimeout(async () => {
    if (!document.hidden || active) await poll();
    if (pageActive) schedulePoll();
  }, document.hidden ? active ? 15_000 : 30_000 : runUpdates.connected ? 30_000 : active ? 1800 : 5000);
}
function initialize(): Promise<void> {
  if (connectionRequest) return connectionRequest;
  if (!pageActive) return Promise.resolve();
  invalidateReads();
  const epoch = state.connectionEpoch;
  state.connected = false;
  element<HTMLButtonElement>('#retry-connection').disabled = true;
  element<HTMLButtonElement>('#refresh-runs').disabled = true;
  connectionRequest = (async () => {
    try {
      if (!navigator.onLine) throw new Error(t('网络已断开'));
      const session = localizeSession(await api<WebSession>('/api/session'));
      if (!currentConnection(epoch)) return;
      if (session.auth === 'email' && !session.account) { saveDraft(); forgetKey(keyStorage); location.replace('login.html'); return; }
      const firstLoad = !state.session;
      if (state.session && state.session.account?.email !== session.account?.email) forgetRememberedKey();
      if (state.session && state.session.csrfToken !== session.csrfToken) {
        state.runs = []; state.selectedId = ''; state.selectedRun = undefined;
        state.finishedRuns.clear(); state.cancelling.clear();
        state.detailError = ''; state.panelSignature = '';
        renderRunList(); renderDetail();
        toast(t('会话已更新，未提交内容已保留'));
      }
      state.session = session;
      const previousProvider = field('provider').value;
      const providers = session.providers.map(provider => [provider.id, provider.name] as const);
      const keepProvider = session.providers.some(provider => provider.id === previousProvider);
      // The first load starts on the first provider, as the browser would for fresh options.
      renderOptions(element<HTMLSelectElement>('#provider'), providers.length ? providers : [['', t('无可用服务商')]],
        firstLoad ? providers[0]?.[0] ?? '' : keepProvider ? previousProvider : '');
      const previousEnvironment = field('environment').value;
      renderOptions(element<HTMLSelectElement>('#environment'), session.environments.map(environment => [environment.id, environment.name] as const),
        session.environments.some(environment => environment.id === previousEnvironment) ? previousEnvironment : session.defaults.environment);
      renderTemplates(field('template').value);
      element<HTMLInputElement>('#max-turns').max = String(session.limits.maxTurns);
      element<HTMLInputElement>('#max-seconds').max = String(session.limits.maxRunSeconds);
      element<HTMLInputElement>('#workers').max = String(session.limits.maxWorkers);
      if (firstLoad) { resetForm(); restoreDraft(); draftReady = true; draftRecovery.load(); renderDraftRecovery(); }
      providerAddress(); updateEnvironment(); updateCounts(); renderRuntime();
      await refreshRuns(epoch);
      if (!currentConnection(epoch)) return;
      state.connected = true;
      setGlobalNotice(session.runtime.ready && session.providers.length ? '' : localizeText(session.runtime.message) || t('运行环境未就绪'));
    } catch (error) {
      if (currentConnection(epoch)) {
        disconnected(t('{0}。未提交内容已保留。', message(error)));
        if (!state.session) renderRunList(true);
      }
    }
  })().finally(() => {
    connectionRequest = undefined;
    element<HTMLButtonElement>('#retry-connection').disabled = !pageActive;
    element<HTMLButtonElement>('#refresh-runs').disabled = !pageActive;
    renderRuntime(); renderDetail();
    if (pageActive && !clockTimer) clockTimer = setInterval(updateClocks, 1000);
    if (pageActive && state.connected && !document.hidden) runUpdates.start();
    schedulePoll();
  });
  renderRuntime(); renderDetail();
  return connectionRequest;
}
const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
function renderShell() {
  const session = state.session, ready = Boolean(state.connected && session?.runtime.ready && session.providers.length);
  const run = currentRun(), running = state.runs.filter(activeRun);
  const title = documentTitle(baseTitle, running.length, state.unseenRuns.size);
  if (document.title !== title) document.title = title;
  const live = run && activeRun(run)
    ? { label: state.cancelling.has(run.id) ? t('正在取消') : status(run).label, detail: formatDuration(runProgress(run).elapsed), tone: status(run).tone, count: running.length }
    : running.length ? { label: t('{0} 项研究进行中', running.length), detail: '', tone: 'running', count: running.length } : undefined;
  renderTopbar(element('#topbar'), {
    title: run?.title ?? t('新研究'), model: field('model').value || t('模型配置'), mac, live,
    connection: { tone: ready ? 'ready' : 'offline', label: !state.connected ? connectionRequest ? t('连接中') : t('连接中断') : ready ? t('环境就绪') : t('环境未就绪') },
    settingsDisabled: !session || state.submitting, account: session?.account?.email, onAccount: openAccount,
    onHistory: openHistory, onSettings: () => openSettings(), onPalette: () => palette.open(), onGlossary: () => openGlossary(), onLocale: changeLocale,
    onLive: () => {
      const target = run && activeRun(run) ? run : state.runs.filter(activeRun).at(-1);
      if (!target) return;
      if (target.id !== state.selectedId) selectRun(target.id);
      setMobileView('runs');
      element(`#detail-tab-${state.tab}`).focus({ preventScroll: true });
    },
  });
}
/** Switching reloads the page; the draft is saved first, as on any page exit. The API key is never kept. */
function changeLocale() { saveDraft(); switchLocale(otherLocale.locale); }
function openAccount() {
  element('#account-email').textContent = state.session?.account?.email ?? '';
  field('account-confirm').value = ''; element<HTMLButtonElement>('#delete-account').disabled = true;
  element('#account-error').hidden = true;
  showDialog(element<HTMLDialogElement>('#account-dialog'));
}
async function leaveAccount(request: () => Promise<unknown>, button: HTMLButtonElement) {
  button.disabled = true; element('#account-error').hidden = true;
  try { await request(); saveDraft(); forgetKey(keyStorage); location.replace('login.html'); }
  catch (error) {
    element('#account-error').textContent = message(error); element('#account-error').hidden = false;
    button.disabled = false;
  }
}
/** The theme itself is applied by theme.js before the first paint; this page only offers the choice. */
const themeLabels: Record<ThemePreference, string> = { system: t('跟随系统'), light: t('浅色'), dark: t('深色') };
function showThemeChoice() {
  const preference = readThemePreference(localStorage);
  document.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach(input => { input.checked = input.value === preference; });
}
function chooseTheme(preference: ThemePreference) {
  if (!saveThemePreference(localStorage, preference)) toast(t('浏览器不允许保存，外观只在此页面生效'));
  applyTheme(preference); showThemeChoice();
}
followThemeChanges(showThemeChoice);
showThemeChoice();
document.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach(input => input.addEventListener('change', () => chooseTheme(input.value as ThemePreference)));
function openGlossary(id?: TermId) {
  const dialog = element<HTMLDialogElement>('#glossary-dialog');
  renderGlossary(dialog, id);
  showDialog(dialog);
}
installTermHints(openGlossary);
function openHistory() {
  showDialog(element<HTMLDialogElement>('#history-dialog'));
  restoreHistoryScroll();
  field('run-search').focus();
}
function paletteCommands(): PaletteCommand[] {
  const run = currentRun(), click = (selector: string) => () => element(selector).click();
  const usable = (selector: string) => !element<HTMLButtonElement>(selector).disabled && !element(selector).hidden;
  const commands: PaletteCommand[] = [
    { id: 'new-research', group: t('操作'), label: t('新研究'), icon: 'square-pen', keywords: t('new draft 草稿'), run: click('#new-research') },
    { id: 'open-history', group: t('操作'), label: t('打开研究记录'), icon: 'panel-left', keywords: 'history runs', run: openHistory },
    { id: 'open-settings', group: t('操作'), label: t('研究配置'), hint: field('model').value, icon: 'sliders-horizontal', keywords: t('settings model 模型'), run: click('#open-settings') },
    { id: 'return-to-draft', group: t('操作'), label: t('返回未提交草稿'), icon: 'arrow-left', keywords: 'draft back', run: click('#return-to-draft') },
  ].filter(command => usable(`#${command.id}`));
  commands.push({ id: 'switch-locale', group: t('帮助'), label: otherLocale.label, lang: otherLocale.lang, hint: otherLocale.title, icon: 'languages', keywords: 'language locale english chinese 语言 中文 英文', run: changeLocale });
  const preference = readThemePreference(localStorage), themeIcons: Record<ThemePreference, string> = { system: 'sun-moon', light: 'sun', dark: 'moon' };
  for (const option of ['system', 'light', 'dark'] as const) if (option !== preference)
    commands.push({ id: `theme-${option}`, group: t('外观'), label: t('外观：{0}', themeLabels[option]), icon: themeIcons[option],
      keywords: t('theme appearance dark light 外观 主题 深色 浅色 夜间'), run: () => chooseTheme(option) });
  commands.push({ id: 'open-glossary', group: t('帮助'), label: t('术语说明'), icon: 'book-open', keywords: t('glossary help 术语 帮助'), run: () => openGlossary() });
  commands.push({ id: 'send-feedback', group: t('帮助'), label: t('反馈问题或建议'), hint: t('在官网填写，确认后发布到 GitHub'), icon: 'message-square',
    keywords: t('feedback bug report issue 反馈 问题 建议'), run: () => { window.open(feedbackUrl(), '_blank', 'noopener'); } });
  if (state.session?.sample && !sampleSelected()) commands.push({ id: 'open-sample', group: t('帮助'), label: t('查看示例运行'), hint: t('无需 API Key'), icon: 'eye', keywords: t('sample demo example 示例'), run: () => void openSample() });
  const tabIcons: Record<DetailTab, string> = { collaboration: 'network', source: 'file-code-2', modules: 'blocks', overview: 'gauge', report: 'file-json-2', events: 'activity' };
  if (run) for (const [tab, label] of detailTabs) commands.push({ id: `tab-${tab}`, group: t('当前研究'), label, hint: tab === state.tab ? t('当前视图') : undefined, icon: tabIcons[tab],
    keywords: tab, run: () => { state.tab = tab; setMobileView('runs'); renderDetail(true); element(`#detail-tab-${tab}`).focus({ preventScroll: true }); } });
  for (const item of state.runs.toReversed().slice(0, 30)) {
    const value = status(item);
    commands.push({ id: `run-${item.id}`, group: t('研究记录'), label: item.title, hint: value.label, icon: value.symbol, keywords: `${item.id} ${item.model}`,
      run: () => { selectRun(item.id); setMobileView('runs'); } });
  }
  return commands;
}
const palette = createCommandPalette(paletteCommands);
renderShell();
document.addEventListener('keydown', event => {
  if (event.key.toLowerCase() !== 'k' || !(mac ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing) return;
  if (document.querySelector('dialog[open]')) return;
  event.preventDefault(); palette.open();
}, true);
element<HTMLFormElement>('#run-form').addEventListener('submit', async event => {
  event.preventDefault();
  const session = state.session;
  if (!session || !state.connected || state.submitting || !session.runtime.ready || !session.providers.length) return;
  const errorBox = element('#form-error'); errorBox.hidden = true;
  const epoch = state.connectionEpoch;
  let sent = false;
  const issues = currentSubmissionIssues();
  if (issues.length) {
    for (const issue of issues) validationShown.add(issue.field);
    focusSubmissionIssue(issues[0]);
    return;
  }
  try {
    const input: WebRunInput = {
      providerId: field('provider').value, apiKey: field('api-key').value.trim(), model: field('model').value.trim(),
      effort: field('effort').value as WebEffort, environment: field('environment').value as WebEnvironment,
      source: field('source').value, task: field('task').value,
      maxTurns: Number(field('max-turns').value), maxRunSeconds: Number(field('max-seconds').value),
      ...(tokenCap(field('max-tokens').value, session.limits.maxTotalTokens) ? { maxTotalTokens: tokenCap(field('max-tokens').value, session.limits.maxTotalTokens) } : {}),
      workers: Number(field('workers').value),
      coordination: element<HTMLInputElement>('input[name="coordination"]:checked').value as WebCoordination,
      ...(captureDraft().modulePlan ? { modulePlan: captureDraft().modulePlan } : {}),
      ...(captureDraft().knowledgeDigest ? { knowledgeDigest: captureDraft().knowledgeDigest } : {}),
    };
    syncKeyMemory();
    closeSettings(false);
    state.submitting = true; renderRuntime();
    sent = true;
    modulePlanEditor.clearDeleted();
    modulePlanLibrary.clearUndo();
    draftRecovery.clear(); renderDraftRecovery();
    const result = await api<{ run: WebRun }>('/api/runs', { method: 'POST', body: JSON.stringify(input) });
    const run = state.runs.find(item => item.id === result.run.id) ?? result.run;
    field('api-key').value = '';
    clearValidation();
    element<HTMLInputElement>('#api-key').type = 'password'; updateKeyToggle(); restoreKey();
    if (!currentConnection(epoch)) {
      toast(t('研究已提交，连接已变化，请核对运行记录'));
      void poll(); return;
    }
    state.listGeneration++;
    state.runs = [run, ...state.runs.filter(item => item.id !== run.id)];
    state.composing = false;
    state.selectedId = run.id; state.selectedRun = run; state.tab = 'collaboration'; state.sourceView = 'proof'; state.reportMode = 'summary'; state.detailError = '';
    clearFilters();
    field('task').value = ''; updateCounts(); draftChanged();
    state.panelSignature = ''; renderRunList(); renderDetail(true); setMobileView('compose');
    schedulePoll();
    requestRunsRefresh();
    toast(t('研究已提交'));
  } catch (error) {
    const key = field('api-key').value.trim();
    const uncertain = sent && (!(error instanceof ApiError) || error.status >= 500);
    const text = uncertain ? t('提交结果尚未确认，请先核对运行记录后再决定是否重新提交。') : message(error);
    errorBox.textContent = key ? text.split(key).join(t('[已隐藏]')) : text;
    errorBox.hidden = false;
    if (sent && currentConnection(epoch) && (uncertain || sessionFailure(error))) {
      disconnected(t('连接需要恢复，未提交内容已保留。'));
      void initialize();
    }
  } finally { state.submitting = false; renderRuntime(); }
});
async function cancelRun() {
  const run = currentRun();
  if (!state.connected || !run || !activeRun(run) || state.cancelling.has(run.id)) return;
  const epoch = state.connectionEpoch;
  const sessionToken = state.session?.csrfToken;
  const confirmed = () => state.session?.csrfToken === sessionToken
    ? state.runs.find(item => item.id === run.id && !activeRun(item)) : undefined;
  const showConfirmed = (latest: WebRun) => toast(latest.status === 'cancelled' ? t('运行已取消') : t('研究已结束'));
  state.cancelling.add(run.id); renderRunMonitor(); renderDetail();
  try {
    const result = await api<{ run: WebRun }>(`/api/runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST' });
    const latest = confirmed();
    if (latest) { showConfirmed(latest); return; }
    if (!currentConnection(epoch)) { toast(t('取消请求已送达，请核对运行记录')); void poll(); return; }
    state.listGeneration++;
    const previous = state.runs.slice();
    const index = state.runs.findIndex(item => item.id === run.id);
    const updated = retainLatestObservation(result.run, state.runs[index]);
    if (index >= 0) state.runs[index] = updated;
    if (state.selectedId === run.id) state.selectedRun = updated;
    rememberFinishedRuns(previous);
    requestRunsRefresh();
    toast(t('已请求取消运行'));
  } catch (error) {
    if (state.session?.csrfToken !== sessionToken) return;
    // A newer GET may already have confirmed the terminal state while the POST response was delayed.
    const latest = confirmed();
    if (latest) { showConfirmed(latest); return; }
    const uncertain = !(error instanceof ApiError) || error.status >= 500;
    if (currentConnection(epoch)) {
      if (state.selectedId === run.id) state.detailError = uncertain ? t('取消结果尚未确认，请核对最新运行状态。') : message(error);
      if (uncertain || sessionFailure(error)) {
        disconnected(t('连接需要恢复，请核对取消结果。')); void initialize();
      }
    }
    toast(uncertain ? t('取消结果尚未确认') : t('取消失败：{0}', message(error)));
  } finally { state.cancelling.delete(run.id); renderRunList(); renderDetail(); }
}
function renderDeleteState() {
  if (!deletionTarget) return;
  const busy = state.deleting.has(deletionTarget.id);
  const run = state.runs.find(run => run.id === deletionTarget!.id);
  const sameSession = deletionTarget.csrfToken === state.session?.csrfToken;
  const notice = !sameSession ? t('会话已变化，请关闭对话框。')
    : !state.connected ? t('连接中断，恢复后可删除。')
      : !run ? t('记录已不存在。') : activeRun(run) ? t('任务尚未结束，不能删除。') : '';
  element('#delete-notice').textContent = notice;
  element('#delete-notice').hidden = !notice;
  element<HTMLButtonElement>('#confirm-delete').disabled = busy || Boolean(notice);
  element<HTMLButtonElement>('#cancel-delete').disabled = busy;
  element<HTMLButtonElement>('#close-delete').disabled = busy;
  renderGlyphLabel(element('#confirm-delete'), busy ? 'spinner' : 'trash-2', busy ? t('正在删除') : t('删除记录'));
}
function openDeletion(run: WebRun) {
  if (!state.connected || !state.session || activeRun(run) || state.deleting.has(run.id)) return;
  deletionTarget = { id: run.id, title: run.title, csrfToken: state.session.csrfToken };
  element('#delete-title').textContent = run.title;
  element('#delete-error').hidden = true;
  const archive = element<HTMLAnchorElement>('#delete-download');
  archive.hidden = false; archive.href = downloadUrl(run.id);
  renderDeleteState();
  showDialog(element<HTMLDialogElement>('#delete-run-dialog'));
  element('#cancel-delete').focus();
}
function removeLocalRun(id: string) {
  const index = visibleRuns().findIndex(run => run.id === id);
  state.listGeneration++;
  state.runs = state.runs.filter(run => run.id !== id);
  if (state.selectedId === id) {
    const visible = visibleRuns();
    state.selectedId = visible[Math.min(Math.max(index, 0), visible.length - 1)]?.id ?? state.runs[0]?.id ?? '';
    state.tab = 'collaboration'; state.sourceView = 'proof'; state.reportMode = 'summary'; state.detailError = ''; state.panelSignature = '';
  }
  state.selectedRun = state.runs.find(run => run.id === state.selectedId);
  renderRunList(); renderDetail();
  requestRunsRefresh();
  if (document.body.dataset.mobileView === 'runs') setMobileView('runs');
}
async function deleteRun() {
  const target = deletionTarget;
  if (!target || !state.connected || target.csrfToken !== state.session?.csrfToken || state.deleting.has(target.id)) return;
  const run = state.runs.find(run => run.id === target.id);
  if (!run || activeRun(run)) { renderDeleteState(); return; }
  const epoch = state.connectionEpoch;
  state.deleting.add(target.id);
  element('#delete-error').hidden = true;
  renderDeleteState(); renderDetail();
  try {
    await api<{ deletedId: string }>(`/api/runs/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
    if (currentConnection(epoch)) removeLocalRun(target.id);
    else void poll();
    element<HTMLDialogElement>('#delete-run-dialog').close();
    toast(t('运行记录已删除'));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && currentConnection(epoch)) {
      removeLocalRun(target.id);
      element<HTMLDialogElement>('#delete-run-dialog').close();
      toast(t('记录已不存在'));
    } else {
      const uncertain = !(error instanceof ApiError) || error.status >= 500;
      element('#delete-error').textContent = uncertain ? t('删除结果尚未确认，请核对历史记录。') : message(error);
      element('#delete-error').hidden = false;
      if (currentConnection(epoch)) {
        if (uncertain || sessionFailure(error)) {
          disconnected(t('连接需要恢复，请核对删除结果。')); void initialize();
        } else void poll();
      }
    }
  } finally {
    state.deleting.delete(target.id); renderDeleteState(); renderRunList(); renderDetail();
  }
}
/** The share link is the owner's choice per accepted run; the dialog lists what it exposes before creating it. */
function renderShareState(error = '') {
  if (!sharing) return;
  const link = sharing.link, loading = link === undefined;
  element('#share-link-row').hidden = !link;
  element<HTMLInputElement>('#share-url').value = link?.url ?? '';
  const open = element<HTMLAnchorElement>('#open-share');
  open.hidden = !link; if (link) open.href = link.url;
  element('#stop-share').hidden = !link;
  element('#create-share').hidden = Boolean(link);
  element<HTMLButtonElement>('#create-share').disabled = sharing.busy || loading || !state.connected;
  element<HTMLButtonElement>('#stop-share').disabled = sharing.busy || !state.connected;
  const notice = loading ? t('正在读取分享状态…') : link ? t('已于 {0} 创建。停止分享后，这个链接立即失效。', timestamp(link.createdAt)) : '';
  element('#share-notice').textContent = notice; element('#share-notice').hidden = !notice;
  element('#share-error').textContent = error; element('#share-error').hidden = !error;
}
async function openSharing(run: WebRun) {
  if (!state.connected || !isAcceptedRun(run)) return;
  sharing = { id: run.id, busy: false };
  element('#share-run-title').textContent = run.title;
  renderShareState();
  showDialog(element<HTMLDialogElement>('#share-dialog'));
  try {
    const { share } = await api<{ share: WebShareLink | null }>(`/api/runs/${encodeURIComponent(run.id)}/share`);
    if (sharing?.id !== run.id) return;
    sharing.link = share; renderShareState();
  } catch (error) {
    if (sharing?.id === run.id) { sharing.link = null; renderShareState(t('无法读取分享状态：{0}', message(error))); }
  }
  (sharing?.link ? element('#copy-share') : element('#create-share')).focus();
}
async function changeSharing(method: 'POST' | 'DELETE') {
  const target = sharing;
  if (!target || target.busy) return;
  target.busy = true; renderShareState();
  try {
    const { share } = await api<{ share: WebShareLink | null }>(`/api/runs/${encodeURIComponent(target.id)}/share`, { method });
    if (sharing !== target) return;
    target.link = share; target.busy = false; renderShareState();
    if (share) { element<HTMLInputElement>('#share-url').select(); toast(t('分享链接已创建')); element('#copy-share').focus(); }
    else { toast(t('已停止分享，原链接已失效')); element('#create-share').focus(); }
  } catch (error) {
    if (sharing === target) { target.busy = false; renderShareState(message(error)); }
  }
}
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copyText(text: string, success: string) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error(t('剪贴板不可用'));
    await navigator.clipboard.writeText(text); toast(success);
  } catch { toast(t('无法访问剪贴板')); }
}
const recoveryFields: Record<Exclude<RecoveryAction['id'], 'report'>, string> = {
  retry: 'api-key', key: 'api-key', budget: 'max-seconds', tokens: 'max-tokens', turns: 'max-turns', workers: 'workers', source: 'source' };
function reuseRun(run: WebRun, recovery: Exclude<RecoveryAction['id'], 'report'> = 'retry') {
  const session = state.session;
  if (!session || state.submitting) return;
  if (recovery === 'key') forgetRememberedKey();
  replaceDraft('reuse', () => {
    clearValidation();
    // The sample's agent was a script, so its provider and model are no choice to copy; the visitor keeps their own.
    const connection = isSample(run) ? {} : { model: run.model, effort: run.effort };
    if (!isSample(run)) field('provider').value = session.providers.some(provider => provider.id === run.providerId) ? run.providerId : '';
    field('environment').value = run.environment;
    renderTemplates();
    for (const [id, value] of Object.entries({ ...connection, source: run.source, task: run.task,
      'max-turns': run.maxTurns, 'max-seconds': run.maxRunSeconds, workers: run.workers,
      'max-tokens': run.maxTotalTokens ? run.maxTotalTokens / 10_000 : '' })) field(id).value = String(value);
    element<HTMLInputElement>(`input[name="coordination"][value="${run.coordination}"]`).checked = true;
    modulePlanLibrary.resetSelection(); modulePlanEditor.setValue(run.modulePlan);
    serverModulePlans.setKnowledgeDigest(run.knowledgeDigest);
    field('api-key').value = '';
    element<HTMLInputElement>('#api-key').type = 'password';
    updateKeyToggle(); providerAddress(); updateEnvironment(); sourceChanged();
    element('#form-error').hidden = true;
    startDraft();
    openSettings(recoveryFields[recovery]);
    toast(recovery === 'retry' || recovery === 'key' ? t('已载入原始题目与执行配置，请输入 API Key') : t('已载入原始配置，修改后请重新输入 API Key'));
  });
}
element('#run-detail').addEventListener('change', event => {
  const toggle = (event.target as Element).closest<HTMLInputElement>('[data-module-custom-enabled]');
  const id = toggle?.dataset.moduleCustomEnabled;
  if (!toggle || !id) return;
  const run = currentRun();
  if (run || !state.session || state.submitting) {
    toggle.checked = (run ? run.modulePlan : modulePlanEditor.value())?.custom.find(rule => rule.id === id)?.enabled ?? false;
    return;
  }
  if (!modulePlanEditor.setRuleEnabled(id, toggle.checked) || !toggle.checked) return;
  const issue = currentSubmissionIssues().find(issue => issue.field === 'module-plan');
  if (issue) { moduleSettingsPolicy = id; focusSubmissionIssue(issue); }
});
element('#run-detail').addEventListener('click', event => {
  const draftView = (event.target as Element).closest<HTMLElement>('[data-draft-view]')?.dataset.draftView;
  if (!currentRun() && (draftView === 'source' || draftView === 'modules')) {
    state.draftView = draftView; renderDraftPreview(); return;
  }
  const policyEdit = (event.target as Element).closest<HTMLElement>('[data-module-policy-edit]')?.dataset.modulePolicyEdit;
  if (policyEdit) {
    if (!currentRun() && state.session && !state.submitting && modulePlanEditor.value().custom.some(rule => rule.id === policyEdit)) {
      openSettings(); moduleSettingsPolicy = policyEdit; modulePlanEditor.focusRule(policyEdit);
    }
    return;
  }
  const policyAdd = (event.target as Element).closest<HTMLButtonElement>('[data-module-policy-add]');
  if (policyAdd) {
    const slot = policyAdd.dataset.modulePolicyAdd;
    if (!currentRun() && state.session && !state.submitting && !policyAdd.disabled && slot && ['M1', 'M3', 'M4', 'M5'].includes(slot)) {
      openSettings(); moduleSettingsPolicy = modulePlanEditor.addRule(slot as ResearchModuleSlot);
    }
    return;
  }
  const moduleDestination = (event.target as Element).closest<HTMLElement>('[data-module-destination]')?.dataset.moduleDestination;
  if (moduleDestination === 'source' || moduleDestination === 'report' || moduleDestination === 'events') {
    if (currentRun()) { state.tab = moduleDestination; renderDetail(true); element(`#detail-tab-${state.tab}`).focus({ preventScroll: true }); }
    else { state.draftView = 'source'; renderDraftPreview(); element('#draft-tab-source').focus({ preventScroll: true }); }
    return;
  }
  const draftAction = (event.target as Element).closest<HTMLElement>('[data-draft-action]');
  if ((event.target as Element).closest('[data-module-configure]') && !currentRun()) { openSettings('module-plan'); return; }
  if (draftAction?.dataset.draftAction === 'edit') {
    if (currentRun()) return;
    const source = field('source').value, position = sourceReader.editingPosition('draft', source);
    openEditor(position ? { source, position } : undefined); return;
  }
  if (draftAction?.dataset.draftAction === 'settings') { openSettings('environment'); return; }
  const target = (event.target as Element).closest<HTMLElement>('[data-action],button[data-detail-tab],button[data-source-view],button[data-report-view]');
  if (!target) return;
  if (target.dataset.detailTab) {
    state.tab = target.dataset.detailTab as DetailTab;
    renderDetail(true); element(`#detail-tab-${state.tab}`).focus({ preventScroll: true }); return;
  }
  if (target.dataset.sourceView) {
    if (!['proof', 'input', 'diff'].includes(target.dataset.sourceView)) return;
    state.sourceView = target.dataset.sourceView as 'proof' | 'input' | 'diff';
    renderPanel(true); return;
  }
  if (target.dataset.reportView) {
    state.reportMode = target.dataset.reportView as 'summary' | 'json';
    renderPanel(true); return;
  }
  const run = currentRun();
  if (!run) return;
  if (target.dataset.action === 'cancel') void cancelRun();
  if (target.dataset.action === 'delete-run') openDeletion(run);
  if (target.dataset.action === 'share-run') void openSharing(run);
  if (target.dataset.action === 'copy-id') void copyText(run.id, t('运行 ID 已复制'));
  if (target.dataset.action === 'copy-source') void copyText(displayedSource(run), t('Lean 源码已复制'));
  if (target.dataset.action === 'copy-report' && run.result) void copyText(JSON.stringify(run.result.report, null, 2), t('报告 JSON 已复制'));
  if (target.dataset.action === 'reuse-run') reuseRun(run);
  if (target.dataset.action === 'show-events' || target.dataset.action === 'show-agents') {
    state.tab = target.dataset.action === 'show-events' ? 'events' : 'collaboration';
    renderDetail(true); element(`#detail-tab-${state.tab}`).focus({ preventScroll: true }); return;
  }
  if (target.dataset.action === 'retry-outline' && loadOutline(run, true)) renderPanel(true);
  if (target.dataset.action === 'inspect-task' && target.dataset.taskId) {
    state.tab = 'collaboration'; renderDetail(true);
    if (!collaborationView.showTask(run.id, target.dataset.taskId)) element('#detail-tab-collaboration').focus({ preventScroll: true });
    return;
  }
  if (target.dataset.action === 'diff-prev') updateDiffNavigation(-1);
  if (target.dataset.action === 'diff-next') updateDiffNavigation(1);
  if (target.dataset.action === 'download-proof' && candidateSource(run)) download(`${run.id}-Submission.lean`, candidateSource(run), 'text/plain;charset=utf-8');
  if (target.dataset.action === 'download-report' && run.result) download(`${run.id}-report.json`, JSON.stringify(run.result.report, null, 2) + '\n', 'application/json');
});
element('#run-detail').addEventListener('change', event => {
  if ((event.target as HTMLElement).id !== 'diff-changes-only') return;
  state.foldUnchanged = (event.target as HTMLInputElement).checked;
  renderPanel(true); updateDiffNavigation(0, true);
});
element('#run-list').addEventListener('click', event => {
  if ((event.target as Element).closest('[data-clear-filters]')) { clearFilters(); field('run-search').focus(); return; }
  const button = (event.target as Element).closest<HTMLElement>('[data-run-id]');
  if (button?.dataset.runId) selectRun(button.dataset.runId);
});
element('#run-monitor-list').addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLElement>('[data-monitor-run-id],[data-dismiss-run-notice]');
  const dismissed = target?.dataset.dismissRunNotice;
  if (dismissed) { state.finishedRuns.delete(dismissed); renderRunMonitor(); return; }
  const run = state.runs.find(run => run.id === target?.dataset.monitorRunId);
  if (!run) return;
  selectRun(run.id);
  if (!activeRun(run)) { state.tab = 'report'; renderDetail(true); }
  setMobileView('runs');
  element(`#detail-tab-${state.tab}`).focus({ preventScroll: true });
});
document.querySelectorAll<HTMLButtonElement>('button[data-mobile-view]').forEach(button => button.addEventListener('click', () => setMobileView(button.dataset.mobileView as 'compose' | 'runs')));
document.addEventListener('keydown', event => {
  if (sourceReader.handleKeydown(event)) return;
  const target = event.target as HTMLElement;
  if (target.matches('[data-detail-tab]') && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const tabs: DetailTab[] = detailTabs.map(([tab]) => tab);
    const index = tabs.indexOf(state.tab);
    state.tab = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)! : tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    renderDetail(true); element(`#detail-tab-${state.tab}`).focus({ preventScroll: true });
  }
  if (target.matches('[data-draft-view]') && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    state.draftView = event.key === 'Home' ? 'source' : event.key === 'End' ? 'modules' : state.draftView === 'source' ? 'modules' : 'source';
    renderDraftPreview(); element(`#draft-tab-${state.draftView}`).focus({ preventScroll: true });
  }
  if (target.matches('button[data-mobile-view]') && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); setMobileView(event.key === 'Home' ? 'compose' : event.key === 'End' ? 'runs' : target.dataset.mobileView === 'compose' ? 'runs' : 'compose', true);
  }
  const runs = visibleRuns();
  if (target.matches('[data-run-id]') && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && runs.length) {
    event.preventDefault();
    const index = runs.findIndex(run => run.id === target.dataset.runId);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? runs.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : runs.length - 1)) % runs.length;
    selectRun(runs[next].id, false);
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-run-id]')).find(button => button.dataset.runId === state.selectedId)?.focus();
  }
});
field('provider').addEventListener('change', providerAddress);
element('#remember-key').addEventListener('change', syncKeyMemory);
field('api-key').addEventListener('input', () => { if (element<HTMLInputElement>('#remember-key').checked) syncKeyMemory(); });
element('#forget-key').addEventListener('click', () => { forgetRememberedKey(); field('api-key').focus(); toast(t('已清除此标签页记住的 API Key')); });
field('environment').addEventListener('change', () => {
  sourceRevision++;
  const usingTemplate = Boolean(field('template').value);
  renderTemplates('', usingTemplate);
  if (usingTemplate) applyTemplate(field('template').value);
  updateEnvironment();
});
field('template').addEventListener('change', () => applyTemplate(field('template').value));
for (const type of ['input', 'change']) element('#run-form').addEventListener(type, event => {
  const target = event.target as HTMLElement;
  if (target.closest('#module-plan-library')) return;
  // Selects emit input before change; preserve the previous environment and template until replacement finishes.
  if (type === 'input' && ['environment', 'template'].includes(target.id)) return;
  if (target.id !== 'source') draftChanged(target.id !== 'api-key');
});
window.addEventListener('storage', event => {
  if (event.key === modulePlanLibraryStorageKey || event.key === null) modulePlanLibrary.refresh();
});
for (const id of ['source', 'task']) field(id).addEventListener('input', () => {
  field('template').value = '';
  if (id === 'source') sourceChanged(); else updateCounts();
});
element('#import-source').addEventListener('click', () => element<HTMLInputElement>('#source-file').click());
element<HTMLInputElement>('#source-file').addEventListener('change', async event => {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  input.value = '';
  if (!file || !state.session || state.submitting) return;
  const revision = ++sourceRevision;
  element('#source-error').hidden = true;
  try {
    const source = await readLeanFile(file, state.session.limits.maxSourceBytes);
    if (revision !== sourceRevision || state.submitting) { toast(t('草稿已变化，未导入文件')); return; }
    replaceDraft('source', () => setCustomSource(source));
    toast(t('Lean 文件已载入'));
  } catch (error) {
    if (revision !== sourceRevision) return;
    element('#source-error').textContent = message(error); element('#source-error').hidden = false;
    openSettings('source');
  }
});
element('#expand-source').addEventListener('click', () => openEditor());
element('#import-task').addEventListener('click', () => element<HTMLInputElement>('#task-file').click());
element<HTMLInputElement>('#task-file').addEventListener('change', event => {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  input.value = '';
  if (file) void importTaskFile(file);
});
element('#export-draft').addEventListener('click', () => {
  if (!state.session || state.submitting) return;
  element('#draft-error').hidden = true;
  try { download('theoremos-draft.json', encodeTaskDraft(captureDraft()), 'application/json'); }
  catch (error) { element('#draft-error').textContent = message(error); element('#draft-error').hidden = false; }
});
for (const id of ['cancel-import', 'close-import']) element(`#${id}`).addEventListener('click', () => element<HTMLDialogElement>('#import-task-dialog').close());
element('#import-task-dialog').addEventListener('close', () => {
  if (element<HTMLDialogElement>('#import-task-dialog').open) return;
  pendingImport = undefined;
});
element('#confirm-import').addEventListener('click', () => {
  const target = pendingImport;
  if (!target || !state.session || state.submitting || target.revision !== draftRevision) { renderImportState(); return; }
  replaceDraft('import', () => { applyTaskDraft(target.draft); saveDraft(); });
  element<HTMLDialogElement>('#import-task-dialog').close();
  startDraft(); openSettings('api-key');
  toast(t('研究任务已载入'));
});
for (const id of ['close-editor', 'cancel-editor']) element(`#${id}`).addEventListener('click', requestEditorClose);
element('#source-editor').addEventListener('cancel', event => {
  event.preventDefault();
  if (!editorReview.close() && !editorNavigation.close()) requestEditorClose();
});
element('#source-editor').addEventListener('close', () => {
  const dialog = element<HTMLDialogElement>('#source-editor');
  if (dialog.open) return;
  const fromPreview = editorOpenedFromPreview;
  editorOpenedFromPreview = false;
  editorClosePosition = undefined;
  element<HTMLDialogElement>('#editor-discard-dialog').close();
  const active = document.activeElement;
  if (!fromPreview || document.querySelector('dialog[open]')
    || (active && active !== document.body && !dialog.contains(active))) return;
  // Applying a source change hides the location entry that opened this dialog.
  const fallback = document.querySelector<HTMLElement>('#draft-preview [data-draft-action="edit"]');
  if (fallback?.getClientRects().length) fallback.focus({ preventScroll: true });
});
for (const id of ['close-editor-discard', 'keep-editing']) element(`#${id}`).addEventListener('click', keepEditing);
element('#editor-discard-dialog').addEventListener('cancel', event => { event.preventDefault(); keepEditing(); });
element('#discard-editor-changes').addEventListener('click', discardEditorChanges);
element('#apply-editor').addEventListener('click', applyEditor);
element('#editor-indent').addEventListener('click', () => indentEditor('indent'));
element('#editor-outdent').addEventListener('click', () => indentEditor('outdent'));
element('#source-editor').addEventListener('keydown', event => {
  if (event.target !== field('expanded-source') || event.isComposing || !(event.ctrlKey || event.metaKey)
    || event.altKey || event.shiftKey || !['[', ']'].includes(event.key)) return;
  event.preventDefault(); indentEditor(event.key === ']' ? 'indent' : 'outdent');
});
document.addEventListener('selectionchange', () => {
  if (element<HTMLDialogElement>('#source-editor').open && document.activeElement === field('expanded-source')) updateEditorPosition();
});
element('#create-share').addEventListener('click', () => void changeSharing('POST'));
element('#stop-share').addEventListener('click', () => void changeSharing('DELETE'));
element('#copy-share').addEventListener('click', () => { if (sharing?.link) void copyText(sharing.link.url, t('分享链接已复制')); });
element('#close-share').addEventListener('click', () => element<HTMLDialogElement>('#share-dialog').close());
element('#share-dialog').addEventListener('close', () => {
  sharing = undefined;
  if (!document.querySelector('dialog[open]')) document.querySelector<HTMLElement>('[data-action="share-run"]')?.focus({ preventScroll: true });
});
element('#confirm-delete').addEventListener('click', () => void deleteRun());
for (const id of ['cancel-delete', 'close-delete']) element(`#${id}`).addEventListener('click', () => {
  if (!deletionTarget || !state.deleting.has(deletionTarget.id)) element<HTMLDialogElement>('#delete-run-dialog').close();
});
element('#delete-run-dialog').addEventListener('cancel', event => {
  if (deletionTarget && state.deleting.has(deletionTarget.id)) event.preventDefault();
});
element('#delete-run-dialog').addEventListener('close', () => {
  const dialog = element<HTMLDialogElement>('#delete-run-dialog');
  if (dialog.open) return;
  deletionTarget = undefined;
  const active = document.activeElement;
  if (document.querySelector('dialog[open]') || (active && active !== document.body && !dialog.contains(active))) return;
  const focus = Array.from(document.querySelectorAll<HTMLElement>('[data-action="delete-run"],#new-research,#open-history'))
    .find(control => control.getClientRects().length && !control.matches(':disabled'));
  focus?.focus({ preventScroll: true });
});
element('#source-editor').addEventListener('input', event => {
  if (event.target !== field('expanded-source')) return;
  element('#editor-error').hidden = true; updateEditorCount();
});
field('run-search').addEventListener('input', () => { state.query = field('run-search').value; renderRunList(); });
field('run-filter').addEventListener('change', () => { state.filter = field('run-filter').value as RunFilter; renderRunList(); });
element('#clear-run-search').addEventListener('click', () => { state.query = ''; field('run-search').value = ''; renderRunList(); field('run-search').focus(); });
element('#toggle-key').addEventListener('click', () => {
  const key = element<HTMLInputElement>('#api-key'); key.type = key.type === 'password' ? 'text' : 'password'; updateKeyToggle();
});
element('#reset-form').addEventListener('click', resetForm);
for (const id of ['restore-draft', 'restore-draft-settings']) element(`#${id}`).addEventListener('click', recoverDraft);
element('#dismiss-draft-recovery').addEventListener('click', () => {
  draftRecovery.clear(); renderDraftRecovery(); field('task').focus({ preventScroll: true });
});
element('#retry-connection').addEventListener('click', () => void initialize());
element('#refresh-runs').addEventListener('click', () => void poll(true));
element('#composer-settings').addEventListener('click', () => openSettings());
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-settings-section]')) {
  button.addEventListener('click', () => {
    const section = element(`#${button.dataset.settingsSection}`);
    section.focus({ preventScroll: true });
    section.scrollIntoView({ block: 'start', behavior: 'instant' });
    syncSettingsNavigation();
  });
}
let settingsScrollFrame = 0;
element('.settings-content').addEventListener('scroll', () => {
  if (settingsScrollFrame) return;
  settingsScrollFrame = requestAnimationFrame(() => { settingsScrollFrame = 0; syncSettingsNavigation(); });
}, { passive: true });
element('#prepare-run').addEventListener('click', () => {
  if (!state.session || state.submitting) return;
  const issue = currentSubmissionIssues()[0];
  if (issue) focusSubmissionIssue(issue); else openSettings();
});
for (const id of ['close-settings', 'apply-settings']) element(`#${id}`).addEventListener('click', () => closeSettings());
element('#run-settings').addEventListener('close', () => {
  renderComposerSummary();
  const policy = moduleSettingsPolicy; moduleSettingsPolicy = undefined;
  const workspace = settingsWorkspaceReturn; settingsWorkspaceReturn = undefined;
  if (!state.submitting && (workspace || policy && !currentRun() && state.draftView === 'modules')) {
    setMobileView('runs');
    if (workspace?.focus?.getClientRects().length) workspace.focus.focus({ preventScroll: true });
  }
  if (policy && !currentRun() && !state.submitting && state.draftView === 'modules') moduleView.focusPolicy(policy);
});
element('#run-settings').addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
});
element('#close-history').addEventListener('click', closeHistoryDialog);
element('#history-dialog').addEventListener('cancel', rememberHistoryScroll);
element('#run-list').addEventListener('scroll', rememberHistoryScroll, { passive: true });
for (const id of ['run-settings', 'history-dialog']) element(`#${id}`).addEventListener('click', event => {
  const dialog = event.currentTarget as HTMLDialogElement;
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
    if (dialog.id === 'history-dialog') closeHistoryDialog(); else dialog.close();
  }
});
element('#new-research').addEventListener('click', () => { startDraft(true); field('task').focus(); });
element('#return-to-draft').addEventListener('click', () => {
  if (state.submitting) return;
  startDraft(); field('task').focus({ preventScroll: true });
});
element('#edit-draft-source').addEventListener('click', () => openEditor());
element('#attach-source').addEventListener('click', () => element<HTMLInputElement>('#source-file').click());
element('#stop-research').addEventListener('click', () => void cancelRun());
element('#conversation-scroll').addEventListener('scroll', updateLatestMessage, { passive: true });
element('#latest-message').addEventListener('click', () => {
  const scroll = element('#conversation-scroll');
  scroll.scrollTo({ top: scroll.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  updateLatestMessage();
});
element('#conversation').addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLElement>('[data-chat-template],[data-chat-action]');
  if (!target) return;
  const template = state.session?.templates.find(item => item.id === target.dataset.chatTemplate);
  if (template) {
    field('environment').value = template.environment;
    renderTemplates(template.id); applyTemplate(template.id); updateEnvironment();
    field('task').focus(); return;
  }
  if (target.dataset.chatAction === 'reuse') { const run = currentRun(); if (run) reuseRun(run); return; }
  if (target.dataset.chatAction === 'notify') { void toggleNotifications(); return; }
  if (target.dataset.chatAction === 'sample') { void openSample(); return; }
  if (target.dataset.chatAction === 'glossary') { openGlossary(); return; }
  if (target.dataset.chatAction === 'recover') {
    const run = currentRun(), action = target.dataset.recovery as RecoveryAction['id'];
    if (run && action in recoveryFields) reuseRun(run, action as keyof typeof recoveryFields);
    return;
  }
  if (['source', 'report', 'events'].includes(target.dataset.chatAction ?? '')) {
    state.tab = target.dataset.chatAction as DetailTab;
    if (state.tab === 'source') state.sourceView = 'input';
    renderDetail(true); setMobileView('runs');
  }
});
element<HTMLTextAreaElement>('#task').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.altKey) {
    event.preventDefault();
    if (!element<HTMLButtonElement>('#submit-run').disabled) element<HTMLFormElement>('#run-form').requestSubmit(element<HTMLButtonElement>('#submit-run'));
  }
});
function resizePane(value: number, persist = false, width = element('.workspace').getBoundingClientRect().width) {
  if (width <= 850) return;
  const minimum = Math.max(28, 340 / width * 100), maximum = Math.min(60, (width - 357) / width * 100);
  chatWidth = Math.min(maximum, Math.max(minimum, value));
  element('.workspace').style.setProperty('--chat-width', `${chatWidth}%`);
  const separator = element('#pane-resizer');
  separator.setAttribute('aria-valuenow', String(chatWidth));
  separator.setAttribute('aria-valuemin', String(minimum));
  separator.setAttribute('aria-valuemax', String(maximum));
  if (persist) { try { sessionStorage.setItem('theoremos-pane-width-v1', String(chatWidth)); } catch { /* Layout remains usable without storage. */ } }
}
let resizing = false;
let resizeBounds: DOMRect | undefined;
let pendingPaneWidth: number | undefined;
let paneResizeFrame = 0;
function flushPaneResize(persist = false) {
  cancelAnimationFrame(paneResizeFrame); paneResizeFrame = 0;
  resizePane(pendingPaneWidth ?? chatWidth, persist, resizeBounds?.width);
  pendingPaneWidth = undefined;
}
element('#pane-resizer').addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  resizeBounds = element('.workspace').getBoundingClientRect();
  resizing = true;
  element('#pane-resizer').setPointerCapture(event.pointerId);
  document.body.classList.add('resizing');
  event.preventDefault();
});
element('#pane-resizer').addEventListener('pointermove', event => {
  if (!resizing || !resizeBounds) return;
  pendingPaneWidth = (event.clientX - resizeBounds.left) / resizeBounds.width * 100;
  if (!paneResizeFrame) paneResizeFrame = requestAnimationFrame(() => flushPaneResize());
});
function finishResizing() {
  if (!resizing) return;
  flushPaneResize(true);
  resizing = false; resizeBounds = undefined; document.body.classList.remove('resizing');
}
element('#pane-resizer').addEventListener('pointerup', finishResizing);
element('#pane-resizer').addEventListener('pointercancel', finishResizing);
element('#pane-resizer').addEventListener('lostpointercapture', finishResizing);
element('#pane-resizer').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  resizePane(event.key === 'Home' ? 28 : event.key === 'End' ? 60 : chatWidth + (event.key === 'ArrowLeft' ? -2 : 2), true);
});
let viewportResizeFrame = 0;
window.addEventListener('resize', () => {
  if (viewportResizeFrame) return;
  viewportResizeFrame = requestAnimationFrame(() => {
    viewportResizeFrame = 0;
    const bounds = element('.workspace').getBoundingClientRect();
    if (resizing) resizeBounds = bounds;
    resizePane(chatWidth, false, bounds.width); renderDraftPreview(); restoreConversationScroll();
    finishHiddenMotion();
  });
});
try {
  const storedWidth = Number(sessionStorage.getItem('theoremos-pane-width-v1'));
  if (Number.isFinite(storedWidth) && storedWidth >= 28 && storedWidth <= 60) chatWidth = storedWidth;
} catch { /* Layout preferences are optional. */ }
resizePane(chatWidth);
window.matchMedia('(max-width:850px)').addEventListener('change', () => {
  renderDraftPreview();
  if (state.tab === 'events') renderPanel(true);
});
document.addEventListener('visibilitychange', () => {
  schedulePoll();
  if (!document.hidden) {
    state.unseenRuns.clear(); renderShell();
    if (pageActive && state.connected) runUpdates.start();
    void poll();
  } else { saveDraft(); runUpdates.stop(); }
});
window.addEventListener('offline', () => {
  invalidateReads(); disconnected(t('网络已断开，未提交内容已保留。')); schedulePoll();
});
async function resumeConnection() {
  await connectionRequest;
  if (pageActive && !state.connected) await initialize();
}
window.addEventListener('online', () => void resumeConnection());
window.addEventListener('pagehide', () => {
  saveDraft();
  pageActive = false; invalidateReads(); state.connected = false;
  clearTimeout(pollTimer); clearInterval(clockTimer); clockTimer = undefined;
  field('api-key').value = ''; element<HTMLInputElement>('#api-key').type = 'password'; updateKeyToggle();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    pageActive = true; field('api-key').value = ''; restoredKey = ''; restoreKey();
    void resumeConnection();
  }
});
element('#close-account').addEventListener('click', () => element<HTMLDialogElement>('#account-dialog').close());
element('#close-glossary').addEventListener('click', () => element<HTMLDialogElement>('#glossary-dialog').close());
element('#logout').addEventListener('click', event => void leaveAccount(() => api('/api/auth/logout', { method: 'POST', body: '{}' }), event.currentTarget as HTMLButtonElement));
field('account-confirm').addEventListener('input', () => {
  element<HTMLButtonElement>('#delete-account').disabled = field('account-confirm').value.trim().toLowerCase() !== state.session?.account?.email;
});
element('#delete-account').addEventListener('click', event => void leaveAccount(() => api('/api/auth/account',
  { method: 'DELETE', body: JSON.stringify({ email: field('account-confirm').value.trim() }) }), event.currentTarget as HTMLButtonElement));
icons();
localizeSiteLinks();
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => { if (!dialog.open) finishMotion(dialog); }));
void initialize();
