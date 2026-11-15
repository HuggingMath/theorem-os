import {
  createIcons, ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, BookOpen, ChevronDown, ChevronUp, CircleAlert, Copy, CopyPlus, CornerDownLeft, Cpu,
  Download, ExternalLink, Eye, FileCode2, FolderOpen, GitBranch, IndentDecrease, IndentIncrease, ListOrdered, Link2, Link2Off, Maximize2, MessageSquare, Monitor, Moon, Network, PanelRight, Paperclip,
  LogOut, Plus, RefreshCw, RotateCcw, Save, Search, ShieldCheck, SlidersHorizontal, Square, SquarePen, Sun, Trash2, TriangleAlert, Undo2, Upload, X,
} from 'lucide';
import type { WebAdminOverview, WebContinuation, WebCoordination, WebEffort, WebEnvironment, WebPrecheck, WebPrecheckDiagnostic, WebProofOutline, WebRun, WebRunRequest, WebSavedKey, WebSession } from '../shared';
import { loginHref } from '../shared';
import { webTaskEnvironment } from '../environment';
import { ResearchSelection } from './researchSelection';
import type { ResearchLibraryAttemptPreparation, ResearchLibraryPersonalAttemptPreparation } from '../researchLibraryTrialTypes';
import { consumeResearchEntry, readResearchEntry } from './researchEntry';
import { openFrozenTask } from './frozenTaskView';
import { renderResearchBudgetDraft } from './researchBudgetDraft';
import { renderResearchStartCost } from './researchStartCost';
import type { WebExplainAnswer } from '../explain';
import type { WebFormalization } from '../formalizationTypes';
import type { WebShareLink } from '../shareTypes';
import type { SharedProofPreparation, SharedProofReading } from '../sharedProofTypes';
import { acceptedTitle, acceptedVerdict, isStatementReviewed, statementConfirmation } from '../presentation';
import { checkReason, effortLabels, failureGuide, formatDuration, formatTokens, isAcceptedRun, isFaultedRun, isRejectedRun, planAwaitingApproval, planGated, readableDuration, readableMetric, reportReason, resultDescription, runProgress, runTokens, stalledMinutes, stoppedLabel, usageEstimate, type RecoveryAction } from '../presentation';
import { nextSteps, summarizeGoals, summarizeReport, summarizeStuck } from '../report';
import { filterRuns, ownerFirst, type RunFilter } from './history';
import { looksLikeLeanSource, readLeanFile } from './sourceFile';
import { sourceIndentEdit, type IndentDirection } from './sourceIndent';
import type { SourceSelection } from './sourceText';
import { EditorNavigation, revealOffset } from './editorNavigation';
import { diagnosticText, renderSourceCheck, SourceCheck, sourceOffset } from './sourceCheck';
import { EditorReview } from './editorReview';
import { decodeTaskDraft, editableTaskDraft, encodeTaskDraft, readTaskDraftFile, taskDraftStorageKey, type TaskDraft } from './draft';
import { compareSources, type SourceComparison } from './sourceDiff';
import { submissionFields, submissionIssues, tokenCap, type SubmissionField, type SubmissionIssue } from './submission';
import { SourceReader } from './sourceReader';
import { readableMessage, type ActivityReader } from './activityReader';
import type { ModuleView, ModuleViewInput } from './moduleView';
import { ModulePlanEditor } from './modulePlanEditor';
import type { CollaborationView } from './collaborationView';
import type { CollaborationSection } from './collaborationNavigation';
import type { TrajectoryView, ExplainKey } from './trajectoryView';
import { RunUpdates } from './runUpdates';
import { retainLatestRun } from './runSnapshot';
import type { WebCommandResult, WebObservation } from '../collaboration';
import { ServerModulePlans } from './serverModulePlans';
import { ModulePlanLibrary, modulePlanLibraryStorageKey } from './modulePlanLibrary';
import { ModulePlanLibraryView } from './modulePlanLibraryView';
import type { ResearchModuleSlot } from '../../../src/solver/modules/policy';
import { draftOwnerStorageKey, OwnedDrafts, researchEntryStorageKey, webDraftOwner } from './ownedDrafts';
import { SubmissionIdentity } from './submissionIdentity';
import { DraftRecovery, type ReplacementReason } from './draftRecovery';
import { animateEntrance, arriveRow, finishHiddenMotion, finishMotion, glideSelection, revealTheme, selectionBox } from './motion';
import { renderTopbar } from './ui/Topbar';
import { renderRunMonitor as drawRunMonitor, type MonitorItem } from './ui/RunMonitor';
import { renderRunHeader as drawRunHeader, unmountRunHeader, type RunHeaderProps } from './ui/RunHeader';
import { ChatSession } from './chatSession';
import { leanProblemDraft, renderProblemDraftPanel } from './problemDrafts';
import { clearProblemDraftTabMemory, captureProblemDraftSubmission, completeProblemDraftSubmission, resetProblemDraftBinding, syncProblemDraftSubmissions } from './problemDraftLifecycle';
import type { ProblemDraftValue } from '../problemDraftTypes';
import { ChatArtifactNavigation, chatArtifactLine, chatArtifactTask, type ChatArtifactKind, type ChatArtifactTarget } from './chatArtifactNavigation';
import { createCommandPalette, type PaletteCommand } from './ui/CommandPalette';
import { renderFacts, renderGlyph, renderGlyphLabel, renderHistoryEmpty, renderHistoryGroup, renderHistoryRow } from './ui/Controls';
import { renderConnecting, renderDraftPreview as drawDraftPreview } from './ui/DraftPreview';
import { renderOptions } from './ui/Section';
import type { CompareProps, OutlineState, ReportPanelProps, ResultPanelProps, SourcePanelProps } from './ui/DetailPanel';
import { leanFileName, leanOutline, writtenNames, type LeanHeading } from './leanOutline';
import { renderConversation as drawConversation } from './ui/Conversation';
import type { renderAgentRoute as RenderAgentRoute, unmountAgentRoute as UnmountAgentRoute } from './ui/AgentRoute';
import { agentRoutes, taskNames } from './agentRoute';
import { AgentActivity } from './agentActivity';
import { FormalizationActivityStore } from './formalizationActivityStore';
import { clockTime, commandId, workerNames } from './collaborationUi';
import { documentTitle, finishedSince, newlyFinished, newlyWaiting, notifyStorageKey, readResume, saveResume, waitsForOwner } from './runAwareness';
import { browserNotificationState, notifyRunEvent } from './browserRunNotifications';
import { forgetKey, hasRememberedKey, rememberKey, rememberedKey } from './keyMemory';
import { applyTheme, followThemeChanges, readThemePreference, resolveTheme, saveThemePreference, type ThemePreference } from './themePreference';
import { installTermHints, renderGlossary } from './termHints';
import { renderAdminPanel } from './ui/AdminPanel';
import { feedbackUrl, localizeSiteLinks } from './feedback';
import type { TermId } from './glossary';
import { locale, localeTag, localizeMessage, localizeText, otherLocale, sentences, switchLocale, t } from '../i18n';
import { tx } from './researchShared';
import { historyStorageKey, markHistoryCollapsed, readHistoryCollapsed } from './historyPreference';
import { detailLevel, onDetailLevel } from './detailLevel';
import { classicLibraryUrl } from './classicLibrary';
import { loadClassicPreparation, readClassicId } from './classicPreparation';
import { renderContinuationPreview } from './productFlowView';
import { relatedResearchRuns, type ContinuationPreview } from './productFlow';
import type { InstalledLibraryDetail } from '../installedLibraryTypes';
import { libraryReferenceKeys, readLibraryReference } from './installedLibraryReference';
import { readEditedProblemId } from './chatDraft';
import { clearResearchProblemDraft, loadResearchProblemDraft, readResearchProblemDraft, researchProblemDraftKeys } from './researchProblemDraft';
import { renderResearchProblemDraft } from './ui/ResearchProblemDraft';
import { checkPersonalApproval, completePersonalApprovalReview, observedPersonalApproval, personalApprovalNeedsReview, personalApprovalSettled, readPersonalApproval, removePersonalApproval, requirePersonalApprovalReview, savePersonalApproval, type PersonalApprovalAttempt } from './personalApprovalStore';

const iconSet = { ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, BookOpen, ChevronDown, ChevronUp, CircleAlert, Copy, CopyPlus, CornerDownLeft, Cpu,
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
type DetailTab = 'result' | 'trajectory' | 'collaboration' | 'source' | 'events' | 'modules';
// The module plan is opened from the run menu; it joins the tabs only while it is the open one.
const baseTabs = [['result', t('结果')], ['trajectory', t('路线图')], ['collaboration', t('协作')], ['source', t('源码')], ['events', t('活动')]] as const;
const detailTabs = (): readonly (readonly [DetailTab, string])[] => state.tab === 'modules' ? [...baseTabs, ['modules', t('模块方案')]] : baseTabs;
type PersonalApprovalView = { pending?: PersonalApprovalAttempt; receipt?: WebCommandResult; busy: boolean; checked: boolean;
  error?: string; storageError?: boolean; reviewRequired?: boolean; reviewedVersion?: string };
let personalApprovalIdentity: { session: WebSession; loading: boolean; owner?: string; error?: string } | undefined;
const state = {
  session: undefined as WebSession | undefined,
  runs: [] as WebRun[], selectedId: '', selectedRun: undefined as WebRun | undefined,
  query: '', filter: 'all' as RunFilter,
  tab: 'result' as DetailTab, sourceView: 'proof' as 'proof' | 'input' | 'diff', submitting: false, cancelling: new Set<string>(),
  draftView: 'source' as 'source' | 'modules',
  foldUnchanged: true, diffChange: 0,
  reportMode: 'summary' as 'summary' | 'json', deleting: new Set<string>(),
  /** UI state only; unresolved approval identities are shared with the route page in owner/run storage. */
  approving: new Map<string, PersonalApprovalView>(),
  /** The run whose 完整源码 is open beside its result. */ proofViewer: '',
  /** 对比代码 open beside a run's result: the run, and the later run compared with it. */ compare: undefined as { runId: string; laterId: string } | undefined,
  detailError: '', listGeneration: 0, runsEtag: '',
  listSignature: '', panelSignature: '',
  connected: false, refreshing: false, connectionEpoch: 0,
  /** The connection failed since the page loaded; until then, not being connected only means it is still connecting. */
  lost: false,
  composing: false, conversationSignature: '',
  finishedRuns: new Set<string>(),
  /** Runs that ended while the tab was hidden; shown in the tab title until the tab is visible again. */
  unseenRuns: new Set<string>(), resumed: false,
  /** The read-only sample run, fetched when first opened; it is never part of runs. */
  sample: undefined as WebRun | undefined,
};
const entryStorageKey = researchEntryStorageKey;
const productEntrySearch = location.search, productEntry = readResearchEntry(productEntrySearch);
const productTarget = new URLSearchParams(productEntrySearch);
const problemDraftId = productTarget.get('accountDraft'), problemDraftVersion = productTarget.get('draftVersion');
let problemDraftTarget = problemDraftId && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(problemDraftId)
  ? { id: problemDraftId, ...(problemDraftVersion && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(problemDraftVersion) ? { version: problemDraftVersion } : {}) } : undefined;
let productEntryHandled = false;
let libraryProposalHandled = false;
let libraryTrialHandled = false;
let budgetDraftHandled = false;
let sharedDraftHandled = false;
let recoveryEntryHandled = false;
function withAddressLanguage(search: string) {
  const language = new URLSearchParams(location.search).get('lang');
  const parameters = new URLSearchParams(search);
  if (language === 'zh' || language === 'en') parameters.set('lang', language);
  if (!search && problemDraftTarget) { parameters.set('accountDraft', problemDraftTarget.id); if (problemDraftTarget.version) parameters.set('draftVersion', problemDraftTarget.version); }
  const classic = readClassicId(new URLSearchParams(location.search)) ?? draftClassicOrigin?.id;
  if (classic && !parameters.has('run') && !parameters.has('chat') && !parameters.has('editProblem')) parameters.set('fromClassic', classic);
  return parameters.size ? `?${parameters}` : '';
}
let researchEntry: 'natural' | 'lean' = 'natural';
// Fresh visits begin with a problem; same-owner drafts can resume their selected editor after loading.
document.body.dataset.entry = researchEntry;
let naturalPage: Promise<void> | undefined;
let chatWorkspace: ChatSession | undefined;
let linkedLibraryReference = readLibraryReference(new URLSearchParams(location.search));
let linkedProblemDraft = readResearchProblemDraft(new URLSearchParams(location.search));
let problemDraftRevision = 0;
const chatArtifacts = new ChatArtifactNavigation(element('#research-chat-thread'));
const chatArtifactIdentity = () => chatWorkspace?.id || currentRun()?.id || 'home';
const outputWideQuery = window.matchMedia('(min-width:1101px)');
function syncOutputCloseLabel() {
  element('#close-research-output').textContent = !outputWideQuery.matches || document.body.dataset.resultsExpanded === 'true'
    ? t('返回对话') : t('收起面板');
}
function placeInputMode() {
  const mode = currentRun() ? 'natural' : researchEntry;
  element('#research-input-mode').hidden = mode === 'natural';
  element('#open-natural-language').setAttribute('aria-pressed', String(mode === 'natural'));
  element('#entry-lean').setAttribute('aria-pressed', String(mode === 'lean'));
}
function chooseEntry(mode: 'natural' | 'lean') {
  closeSettings(false);
  document.body.dataset.draftPreview = 'false';
  element('#open-draft-preview').setAttribute('aria-expanded', 'false');
  researchEntry = mode; document.body.dataset.entry = mode;
  element('#open-natural-language').setAttribute('aria-pressed', String(mode === 'natural'));
  element('#entry-lean').setAttribute('aria-pressed', String(mode === 'lean'));
  placeInputMode();
  try { ownedDrafts.setItem(entryStorageKey, mode); } catch { /* Keep the choice for this page. */ }
  syncNaturalResearch();
  renderRuntime(); renderPreparation(); renderShell();
}
async function loadNaturalResearch() {
  chatWorkspace = new ChatSession({
    request: api,
    session: () => state.session,
    runs: () => state.runs,
    onOpenRun: id => selectRun(id),
    connected: () => state.connected,
    draftScope: state.session ? ownerOfSession(state.session) : '',
    problemDraftTarget: () => problemDraftTarget,
    onRestoreProblemDraft: restoreProblemDraft,
    keyRequired: providerId => !state.session?.account?.serverKeys?.includes(providerId) && !state.session?.account?.savedKeys?.some(key => key.providerId === providerId),
    onNavigate: (id, mode, attached, editedProblem) => {
      chatArtifacts.clear();
      researchEntry = 'natural'; document.body.dataset.entry = 'natural'; placeInputMode();
      if (linkedLibraryReference && (mode === 'push' || linkedLibraryReference.chat !== id)) linkedLibraryReference = undefined;
      if (linkedProblemDraft && (mode === 'push' || id)) dismissProblemDraft();
      const parameters = new URLSearchParams(id ? { chat: id } : {});
      if (editedProblem) parameters.set('editProblem', editedProblem);
      if (linkedLibraryReference && linkedLibraryReference.chat === id) {
        parameters.set('libraryModule', linkedLibraryReference.file);
        parameters.set('libraryCatalog', linkedLibraryReference.catalogDigest);
        parameters.set('libraryDeclaration', linkedLibraryReference.declaration);
        if (linkedLibraryReference.editedProblem) parameters.set('editProblem', linkedLibraryReference.editedProblem);
      }
      if (linkedProblemDraft) {
        const original = new URLSearchParams(location.search);
        for (const key of researchProblemDraftKeys) if (original.has(key)) parameters.set(key, original.get(key)!);
      }
      const search = withAddressLanguage(parameters.size ? `?${parameters}` : '');
      if (location.search !== search) history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', location.pathname + search);
      // The live workspace belongs to the task, not to one of its stages: a task moving from its statement to its proof keeps it open.
      if (!id || document.body.dataset.chatArtifact !== 'live') { document.body.dataset.chatArtifact = ''; document.body.dataset.outputOpen = 'false'; }
      // Arrow keys in the phone history open each run in turn; its conversation arriving must not close the list.
      if (!attached) closeHistoryDialog();
    },
    onSelection: received => {
      const run = received && retainLatestRun(received, state.runs.find(item => item.id === received.id));
      const changed = currentRun()?.id !== run?.id;
      // A known run is refreshed where it stands, so the history keeps its order; a new one joins at the top.
      if (run) state.runs = state.runs.some(item => item.id === run.id) ? state.runs.map(item => item.id === run.id ? run : item) : [run, ...state.runs];
      state.composing = !run; state.selectedId = run?.id ?? ''; state.selectedRun = run;
      if (changed) { chatArtifacts.clear(); state.tab = 'result'; state.panelSignature = ''; }
      renderRunList(); renderDetail(changed); renderShell();
      // The live workspace follows whichever task the conversation shows; switching tasks redraws it in place.
      if (changed && document.body.dataset.chatArtifact !== 'live') setMobileView('compose');
    },
    onConversation: renderShell,
    onArtifact: openChatArtifact,
    onShare: run => void openSharing(run),
    onRecover: recoverRun,
    onKeysChanged: keys => { if (state.session?.account) state.session.account.savedKeys = keys; providerAddress(); },
    onSample: () => void openSample(),
    onHistory: openHistory,
    agentActivity, formalizationActivity,
    onLean: () => { chooseEntry('lean'); startDraft(); },
    onGuidance: (run, text?: string, taskId?: string) => openGuidance(run, text, undefined, taskId),
    planApproval: approvalProps,
    onApprovePlan: run => void approvePlan(run),
    onPlan: async (run, edit) => {
      await openChatArtifact('plan');
      if (currentRun()?.id !== run.id || document.body.dataset.chatArtifact !== 'plan') return;
      if (edit && !collaborationView?.editPlan(run.id)) element('#detail-tab-collaboration').focus({ preventScroll: true });
    },
    onCancelRun: openCancellation,
    isSample,
  });
  if (linkedProblemDraft) chatWorkspace.home(false);
  await chatWorkspace.start(linkedProblemDraft ? undefined : currentRun());
  if (linkedProblemDraft) void showProblemDraft();
  const reference = linkedLibraryReference, workspace = chatWorkspace, session = state.session;
  if (reference && reference.chat === workspace.id && reference.editedProblem === workspace.editingProblem) {
    try {
      const { item } = await api<{ item: InstalledLibraryDetail }>(`/api/research/library/installed/module?${new URLSearchParams({ file: reference.file, catalogDigest: reference.catalogDigest })}`);
      const { libraryReference } = await import('./installedLibraryReferenceValue');
      if (!sameSession(session) || workspace !== chatWorkspace || workspace.id !== reference.chat || workspace.editingProblem !== reference.editedProblem) return;
      if (!workspace.includeLibraryReference(libraryReference(item, reference.declaration))) throw new Error(t('暂时无法加入引用，原有输入已保留。请重新打开此接口。'));
      linkedLibraryReference = undefined;
      const next = new URL(location.href);
      for (const key of libraryReferenceKeys) next.searchParams.delete(key);
      history.replaceState(null, '', next);
      toast(t('已加入数学库参考，可继续补充题目或发送。'));
    } catch (error) {
      if (sameSession(session) && workspace === chatWorkspace && workspace.id === reference.chat && workspace.editingProblem === reference.editedProblem)
        workspace.libraryReferenceFailed(t('引用数学库失败：{0}', message(error)));
    }
  }
}
function dismissProblemDraft() {
  linkedProblemDraft = undefined; problemDraftRevision++;
  renderResearchProblemDraft(element('#research-problem-draft'));
  const next = new URL(location.href); clearResearchProblemDraft(next.searchParams);
  history.replaceState(null, '', next);
}
async function showProblemDraft() {
  const reference = linkedProblemDraft, workspace = chatWorkspace, session = state.session;
  if (!reference || !workspace || workspace.id) return;
  const revision = ++problemDraftRevision;
  const current = () => revision === problemDraftRevision && linkedProblemDraft === reference && workspace === chatWorkspace && !workspace.id && sameSession(session);
  const common = { onDismiss: dismissProblemDraft, onRetry: () => void showProblemDraft(), onInclude: () => {}, onAppend: () => {} };
  renderResearchProblemDraft(element('#research-problem-draft'), { ...common, loading: true });
  try {
    const candidate = await loadResearchProblemDraft(reference, { json: api, currentHref: location.href, locale, text: async url => {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: readController.signal });
      if (!response.ok) throw new Error(t('读取原题失败，请重试。'));
      return response.text();
    } });
    if (!current()) return;
    const include = (independent: boolean) => {
      if (!current()) return;
      if (!workspace.includeProblemDraft(candidate.text, candidate.environment, independent ? candidate.draftId : undefined)) { toast(t('暂时无法加入原题，现有草稿已保留。')); return; }
      dismissProblemDraft(); toast(independent ? t('已打开独立研究草稿，可修改后发送。') : t('原题已追加到首页草稿，可修改后发送。'));
    };
    renderResearchProblemDraft(element('#research-problem-draft'), { ...common, candidate, onInclude: () => include(true), onAppend: () => include(false) });
  } catch (error) {
    if (current()) renderResearchProblemDraft(element('#research-problem-draft'), { ...common, error: message(error) });
  }
}
async function openChatArtifact(kind: ChatArtifactKind, target?: ChatArtifactTarget, auto = false) {
  const run = currentRun(), task = chatArtifactTask(run, target?.taskId);
  // The live workspace is there for a formalization too, before any run exists.
  if (kind !== 'original' && kind !== 'live' && !run) return;
  if (kind !== 'original' && kind !== 'live' && target?.taskId && !task) { toast(t('任务合同未保留')); return; }
  // The task opening its own workspace is not a place the reader came from; coming back still returns to their last one.
  if (!auto) chatArtifacts.remember(chatArtifactIdentity(), kind, target);
  document.body.dataset.chatArtifact = kind;
  document.body.dataset.outputOpen = 'true';
  syncOutputCloseLabel();
  if (kind === 'original') { element('#close-research-output').focus({ preventScroll: true }); return; }
  // The live workspace replaces the run detail for the time it is open, on any screen size.
  if (kind === 'live') { if (!auto) element('#close-research-output').focus({ preventScroll: true }); return; }
  state.tab = kind === 'result' ? 'result' : kind === 'roadmap' ? 'trajectory' : kind === 'plan' ? 'collaboration' : 'source'; state.sourceView = 'proof';
  setMobileView('runs'); renderDetail(true);
  if (kind === 'plan' || task && kind === 'roadmap') {
    await loadRunViews();
    if (currentRun()?.id !== run!.id || document.body.dataset.chatArtifact !== kind) return;
  }
  if (kind === 'plan') { collaborationView?.showSection(run!.id, 'tasks'); return; }
  if (task && kind === 'roadmap') {
    element('#detail-tab-trajectory').focus({ preventScroll: true });
    void trajectoryView?.showTask(run!.id, task.id);
    return;
  }
  if (task && kind === 'source') { openTaskSource(run!, task.id); return; }
  element(`#detail-tab-${state.tab}`).focus({ preventScroll: true });
}
async function openTaskSource(run: WebRun, taskId: string) {
  const task = chatArtifactTask(run, taskId);
  if (!task) return;
  document.body.dataset.chatArtifact = 'source';
  state.proofViewer = ''; state.compare = undefined; state.sourceView = 'proof';
  const line = chatArtifactLine(run, taskId, candidateSource(run));
  state.tab = line === undefined ? 'collaboration' : 'source';
  const tab = state.tab;
  setMobileView('runs'); renderDetail(true);
  await loadRunViews();
  if (currentRun()?.id !== run.id || state.tab !== tab || document.body.dataset.chatArtifact !== 'source') return;
  if (line !== undefined) { sourceReader.goToLine(line); return; }
  // A lemma may only have its own recorded file before integration into the candidate.
  if (collaborationView?.showTask(run.id, taskId)) {
    document.querySelector<HTMLButtonElement>(`[data-collab-source="${CSS.escape(taskId)}"][data-source-version="${CSS.escape(task.version)}"]`)?.click();
  }
}
function syncNaturalResearch() {
  const run = currentRun();
  const showing = Boolean(run) || researchEntry === 'natural';
  element('#research-conversation-panel').hidden = !showing;
  placeInputMode();
  if (showing && state.session && !naturalPage) naturalPage = Promise.resolve().then(loadNaturalResearch);
  if (run && chatWorkspace && chatWorkspace.runId !== run.id) void chatWorkspace.openRun(run);
}
async function openNaturalResearch(reset = false) {
  if (state.submitting) return;
  closeHistoryDialog();
  if (reset && state.session) resetProblemDraftBinding(ownerOfSession(state.session), 'lean');
  chooseEntry('natural'); startDraft();
  await naturalPage;
  chatWorkspace?.home(reset);
  chatWorkspace?.focus();
}
const baseTitle = document.title;
// A link from the completion mail or the address bar (/?run=<id>) opens that run, also after the login page sends the reader back.
// The address then follows the open run (syncAddress), so it can be bookmarked and Back returns to the run before.
const runIdPattern = /^[a-f0-9-]{1,36}$/u;
const linkedRun = new URLSearchParams(location.search).get('run');
// The sample has an address of its own (/?sample), so Back from a run returns to it and a reload keeps it open.
const sampleAddress = '?sample';
const initialAddress = new URLSearchParams(location.search); initialAddress.delete('lang');
let sampleLink = initialAddress.size === 1 && initialAddress.get('sample') === '';
let formalizationLink = new URLSearchParams(location.search).get('formalization');
// When the session ends, the login page keeps the run or conversation open now (login.html?run=<id>, ?chat=<id>) and
// returns to it.
const loginAddress = () => loginHref(location.pathname + location.search + location.hash);
// The root address opens a new problem; explicit run and sample links still open their records.
state.composing = !!linkedProblemDraft || !linkedRun && !sampleLink;
if (linkedRun !== null && runIdPattern.test(linkedRun))
  saveResume(() => localStorage, { selectedId: linkedRun, seenAt: readResume(() => localStorage)?.seenAt ?? new Date().toISOString() });
const notifyState = browserNotificationState;
function announceRun(run: WebRun, kind: 'finished' | 'waiting', label: string) {
  if (!state.session) return;
  const owner = ownerOfSession(state.session);
  void notifyRunEvent({ owner, run, kind, title: `TheoremOS · ${label}`, body: `${run.title}\n${resultDescription(run)}`,
    current: () => Boolean(state.session && ownerOfSession(state.session) === owner),
    activate: () => { selectRun(run.id); setMobileView('runs'); },
  });
}
function announceFinished(run: WebRun) {
  if (!document.hidden) return;
  state.unseenRuns.add(run.id);
  announceRun(run, 'finished', status(run).label);
}
/** Nothing in a run with 先审计划 starts until its owner approves the plan, so its owner hears about it at once. */
function announceWaiting(run: WebRun) {
  if (!document.hidden) { if (run.id !== state.selectedId) toast(t('「{0}」的研究计划等你批准', run.title)); return; }
  announceRun(run, 'waiting', t('研究计划等你批准'));
}
async function toggleNotifications() {
  const current = notifyState();
  if (current === 'unsupported') { toast(t('这个浏览器不支持桌面通知')); return; }
  if (current === 'blocked') { toast(t('浏览器已阻止本站通知，请在地址栏的网站设置中允许')); return; }
  const remember = (value: string) => { try { localStorage.setItem(notifyStorageKey, value); } catch { /* Preference lasts for this page only. */ } };
  if (current === 'on') { remember('off'); toast(t('已关闭完成通知')); renderPanel(true); return; }
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') { toast(t('没有获得通知权限，结束时只会在标签页标题上提示')); renderPanel(true); return; }
  remember('on');
  toast(t('研究结束或计划等你批准时会发送桌面通知'));
  renderPanel(true);
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
/** The active run the cancel confirmation names; confirming acts on this id even if the selection moved meanwhile. */
let cancellationTarget: { id: string; title: string; csrfToken: string } | undefined;
let sharing: { id: string; link?: WebShareLink | null; busy: boolean } | undefined;
let submissionSequence = 0;
let draftReady = false;
let draftDirty = false;
let draftRevision = 0;
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let latestDraft: TaskDraft | undefined;
let replacingDraft = false;
let restoringDraft = false;
const ownedDrafts = new OwnedDrafts(() => sessionStorage);
const submissionIdentity = new SubmissionIdentity(ownedDrafts);
const draftRecovery = new DraftRecovery(() => ownedDrafts);
const problemDraftHost = document.createElement('div');
problemDraftHost.id = 'lean-problem-drafts'; problemDraftHost.hidden = true;
element('#run-form').after(problemDraftHost);
const ownerOfSession = webDraftOwner;
function clearOwnedDrafts() {
  state.approving.clear(); personalApprovalIdentity = undefined;
  document.querySelector('[data-library-proposal-start]')?.remove(); libraryProposalHandled = false;
  problemDraftRevision++; renderResearchProblemDraft(element('#research-problem-draft'));
  document.querySelector('[data-library-trial-start]')?.remove(); libraryTrialHandled = false;
  document.querySelector('[data-budget-attempt-start]')?.remove(); budgetDraftHandled = false;
  document.querySelector('[data-shared-proof-start]')?.remove(); sharedDraftHandled = false;
  document.querySelector('[data-shared-proof-origin]')?.remove(); draftSharedProofOrigin = undefined; sharedProofOriginRead = undefined;
  document.querySelector('[data-classic-origin]')?.remove(); draftClassicOrigin = undefined;
  document.querySelector('[data-library-proposal-origin]')?.remove(); draftLibraryProposalOrigin = undefined;
  libraryProposalOriginRead = undefined;
  recoveryEntryHandled = false;
  budgetDraftOrigin = undefined;
  chatWorkspace?.bindOwner('');
  renderProblemDraftPanel(problemDraftHost); problemDraftHost.hidden = true;
  researchSelection.reset();
  collaborationView?.clearPlanDrafts();
  submissionSequence++;
  draftReady = false; draftDirty = false; clearTimeout(draftTimer);
  latestDraft = undefined; pendingImport = undefined; taskImportSequence++;
  draftContinuation = undefined; submissionIdentity.clear(); draftRecovery.clear(); ownedDrafts.clear();
  forgetRememberedKey(); clearProblemDraftTabMemory();
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('theorem-os.natural-research-draft.v1:') || key.startsWith('theorem-os.chat-draft.') || key.startsWith('theorem-os.chat-submission.')
        || key.startsWith('theorem-os.chat-reading.') || key.startsWith('theorem-os.problem-draft.') || key.startsWith('theorem-os.problem-draft-pending.') || key === entryStorageKey) sessionStorage.removeItem(key);
    }
  } catch { /* In-memory drafts are also cleared when browser storage is unavailable. */ }
}

let taskImportSequence = 0;
let pendingImport: { draft: TaskDraft; revision: number } | undefined;
let sourceComparison: { runId: string; before: string; after: string; folded: boolean; result: SourceComparison } | undefined;
/** 对比代码 between a run and a later one, kept while their code and the folding stay the same. */
let runComparison: { before: string; after: string; folded: boolean; result: SourceComparison } | undefined;
let proofHeadings: { source: string; headings: LeanHeading[] } | undefined;
/** The declarations of the proof the result tab shows, read once per proof. */
function headingsOf(source: string) {
  if (proofHeadings?.source !== source) proofHeadings = { source, headings: leanOutline(source) };
  return proofHeadings.headings;
}
let draftPreviewSignature = '';
let draftSourceExpanded = false;
/** The recorded version the next run starts from (「从这一版继续」); one submission uses it. */
let draftContinuation: WebContinuation | undefined;
let continuationPreview: ContinuationPreview | undefined;
let budgetDraftOrigin: { runId: string; projectId?: string; source: string; environment: WebEnvironment } | undefined;
let draftSharedProofOrigin: TaskDraft['sharedProofOrigin'];
let draftClassicOrigin: TaskDraft['classicOrigin'];
let draftLibraryProposalOrigin: TaskDraft['libraryProposalOrigin'];
let sharedProofOriginRead: { key: string; status: 'loading' | 'available' | 'unavailable' } | undefined;
let libraryProposalOriginRead: { key: string; status: 'loading' | 'available' | 'unavailable' } | undefined;
let draftFormalization: (NonNullable<TaskDraft['formalization']> & { source: string; environment: WebEnvironment; original?: string }) | undefined;
let moduleSettingsPolicy: string | undefined;
let settingsWorkspaceReturn: { focus?: HTMLElement; preview?: boolean } | undefined;
const sourceReader = new SourceReader(() => {
  if (!currentRun() && !draftSourceExpanded) { draftSourceExpanded = true; renderDraftPreview(); }
});
let activityReader: ActivityReader | undefined;
let moduleView: ModuleView | undefined;
let renderDetailPanel: typeof import('./ui/DetailPanel').renderDetailPanel | undefined;
let renderAgentRoute: typeof RenderAgentRoute | undefined, unmountAgentRoute: typeof UnmountAgentRoute | undefined;
const modulePlanEditor = new ModulePlanEditor(element('#module-plan'), icons, () => draftChanged());
// Each run's events and Agent actions for the route maps of the result and collaboration tabs, read once for both.
const agentActivity = new AgentActivity(url => api(url));
const formalizationActivity = new FormalizationActivityStore(url => api(url));
let collaborationView: CollaborationView | undefined;
let trajectoryView: TrajectoryView | undefined;
let runViewsLoading: Promise<void> | undefined;
let runViewsError = '';
function loadRunViews() {
  return runViewsLoading ??= import('./runViews').then(views => {
    activityReader = new views.ActivityReader(at => timestamp(at, true), (filename, text) => download(filename, text, 'application/json'));
    moduleView = new views.ModuleView(); renderDetailPanel = views.renderDetailPanel;
    renderAgentRoute = views.renderAgentRoute; unmountAgentRoute = views.unmountAgentRoute;
    collaborationView = new views.CollaborationView(api, receiveRunObservation, () => {
      state.tab = 'result'; renderDetail(true);
      document.querySelector('#detail-panel .result-report')?.scrollIntoView({ block: 'start', behavior: 'instant' });
      document.getElementById('detail-tab-result')?.focus({ preventScroll: true });
    }, agentActivity);
    // The trajectory's line "+" adds that line to the run's guidance draft, addressed to the attempt's task, in 协作.
    trajectoryView = new views.TrajectoryView(api, (run, text, taskId) => openGuidance(run, text, t('代码行已加入本地指导草稿，尚未发送'), taskId),
      { allowed: run => !isSample(run), start: (run, from) => reuseRun(run, 'retry', from), explain: { key: explainKey,
        // A model answers in its own time; the server gives up after three minutes.
        ask: (run, request, signal) => api<WebExplainAnswer>(`/api/runs/${encodeURIComponent(run.id)}/explain`, { method: 'POST', signal, timeoutMs: 200_000,
          body: JSON.stringify(explainKey(run).source === 'remembered' ? { ...request, apiKey: rememberedKey(keyStorage, run.providerId, providerUrl(run.providerId)) } : request) }) } });
    runViewsError = '';
    draftPreviewSignature = '';
    renderDetail(true);
  }).catch(error => { runViewsError = message(error); renderDetail(true); });
}
function renderRunViewsLoading(panel: HTMLElement) {
  panel.replaceChildren();
  if (runViewsError) {
    const error = document.createElement('p'); error.className = 'inline-error'; error.setAttribute('role', 'alert'); error.textContent = runViewsError;
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button'; retry.textContent = t('重试');
    retry.addEventListener('click', () => location.reload());
    panel.append(error, retry);
  } else { renderConnecting(panel); void loadRunViews(); }
}
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
const checkScope = crypto.randomUUID();
const sourceCheck = new SourceCheck({
  input: () => ({ environment: field('environment').value as WebEnvironment, source: field('source').value,
    ...(researchSelection.value() ? { researchSelection: researchSelection.value() } : {}) }),
  enabled: () => Boolean(researchEntry === 'lean' && state.session?.precheck && state.connected && state.session.runtime.ready
    && new TextEncoder().encode(field('source').value).length <= state.session.limits.maxSourceBytes),
  post: async (input, signal) => (await api<{ precheck: WebPrecheck }>('/api/precheck',
    { method: 'POST', body: JSON.stringify({ ...input, checkScope, ...(researchSelection.value() ? { researchSelection: researchSelection.value() } : {}) }), signal, timeoutMs: 120_000 })).precheck,
  message: error => message(error),
  render: () => { renderSourceCheckView(); renderPreparation(); },
});
const researchSelection = new ResearchSelection(api, () => { draftChanged(); saveDraft(); }, ownedDrafts);
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
/** Focuses the inline statement with the reported range selected and in view. */
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
const conversationScroll = { top: 0 };
const historyQuery = window.matchMedia('(max-width:850px)');
// A touch screen's keyboard covers half the page: focus moves into a text field only when the reader is about to type.
const touchQuery = window.matchMedia('(pointer: coarse)');
let historyCriteria = '';
/** Runs that reached the list since it was last drawn (submitted here, or by another tab); they unfold into it. */
const arrivals = new Set<string>();
let historyReading: { top: number; anchors: Array<{ id: string; offset: number }> } = { top: 0, anchors: [] };

/** `message` is what the reader sees; `reason` keeps the server's own text for checks such as sessionFailure. */
class ApiError extends Error {
  constructor(readonly reason: string, readonly status: number) { super(localizeMessage(reason)); }
}
type ApiInit = RequestInit & { timeoutMs?: number };
const sameSession = (session: WebSession | undefined) => session?.draftOwner === state.session?.draftOwner && session?.csrfToken === state.session?.csrfToken;
let keyChangeSession: WebSession | undefined, keyChangeTail: Promise<void> = Promise.resolve();
function api<T>(url: string, init?: ApiInit): Promise<T>;
function api<T>(url: string, init: ApiInit, etag: (value: string | null) => void): Promise<T | undefined>;
async function api<T>(url: string, { timeoutMs = 15_000, ...init }: ApiInit = {}, etag?: (value: string | null) => void): Promise<T | undefined> {
  const requestSession = state.session, requestOwner = requestSession?.draftOwner;
  // Both input modes update the same saved-key metadata. Send their changes in order, including runs
  // whose response carries that metadata, so a slow deletion cannot replace a later saved key.
  const keyChange = Boolean(requestSession?.account?.keyVault && (
    url.startsWith('/api/auth/keys/') && (init.method === 'PUT' || init.method === 'DELETE')
    || url === '/api/runs' && init.method === 'POST'));
  let finishKeyChange: (() => void) | undefined;
  if (keyChange) {
    if (!sameSession(keyChangeSession)) { keyChangeSession = requestSession; keyChangeTail = Promise.resolve(); }
    const previous = keyChangeTail;
    keyChangeTail = new Promise<void>(resolve => { finishKeyChange = resolve; });
    await previous;
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error(t('请求超时，请重新连接'))), timeoutMs);
  const signals = [timeout.signal];
  if (!init.method || init.method === 'GET') signals.push(readController.signal);
  if (init.signal) signals.push(init.signal);
  try {
    // A queued change still belongs to the identity that requested it, even after another tab logs in.
    if (keyChange && !sameSession(requestSession)) throw new ApiError(t('会话校验失败，请刷新页面。'), 401);
    // fetch rejects with a TypeError when the server cannot be reached; its text ("Failed to fetch") means nothing to a reader.
    const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any(signals),
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.method && init.method !== 'GET' ? { 'X-CSRF-Token': state.session?.csrfToken ?? '' } : {}), ...init.headers } })
      .catch((error: unknown) => { throw error instanceof TypeError ? new Error(t('无法连接服务器')) : error; });
    const responseOwner = response.headers.get('X-Theoremos-Owner');
    if (!url.startsWith('/api/session') && responseOwner && state.session?.draftOwner && responseOwner !== state.session.draftOwner) {
      if (requestOwner === state.session.draftOwner) { clearOwnedDrafts(); state.submitting = false; void initialize(); }
      throw new ApiError(t('会话校验失败，请刷新页面。'), 401);
    }
    if (etag && response.status === 304) { etag(response.headers.get('ETag')); return; }
    const payload: unknown = await response.json().catch(error => {
      if (timeout.signal.aborted) throw timeout.signal.reason;
      if (!response.ok) return undefined;
      throw error;
    });
    // The headers may have arrived before another tab's login; a slow body still belongs to its original session.
    if (!url.startsWith('/api/session') && !sameSession(requestSession)) throw new ApiError(t('会话校验失败，请刷新页面。'), 401);
    if (!response.ok) {
      if (response.status === 428) { saveDraft(); draftReady = false; forgetKey(keyStorage); location.replace(loginAddress()); }
      const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error : response.status === 429 ? t('请求太频繁，请稍后再试。') : t('请求失败 ({0})', response.status);
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
    finishKeyChange?.();
  }
}
const message = (error: unknown) => error instanceof Error ? error.message : t('请求失败，请重试');
/** A manual popover, shown again each time so it lands in the top layer above any open dialog instead of under its backdrop. */
function toast(text: string) {
  const target = element('#toast'), layered = 'showPopover' in target;
  if (layered && target.matches(':popover-open')) target.hidePopover();
  target.textContent = text; target.hidden = false;
  if (layered) target.showPopover();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (layered && target.matches(':popover-open')) target.hidePopover(); target.hidden = true; }, 3000);
}
function setGlobalNotice(text: string) {
  element('#global-notice-text').textContent = text;
  element('#global-notice').hidden = !text;
}
function setMobileView(view: 'compose' | 'runs', focus = false) {
  const changed = document.body.dataset.mobileView !== view;
  // Both panels belong to the task the conversation shows, so a task's own redraw keeps them; leaving the panel view
  // for the conversation closes them. A task still switching between its own stages does not.
  const panel = view === 'compose' && changed
    ? '' : document.body.dataset.chatArtifact;
  document.body.dataset.chatArtifact = panel;
  document.body.dataset.outputOpen = String(panel === 'live' || panel === 'original' || (view === 'runs' && Boolean(currentRun())));
  syncOutputCloseLabel();
  rememberConversationScroll();
  if (changed) { activityReader?.remember(); moduleView?.update(); }
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
    animateEntrance(element(view === 'compose' ? currentRun() ? '#research-conversation-panel' : '.composer' : '#runs-panel'), 'workspace');
  }
}
/** Focuses the first usable control in the order given (not the page's order, where the top bar comes first). */
function focusFirst(selectors: readonly string[]) {
  for (const selector of selectors) {
    const control = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(item => item.getClientRects().length && !item.matches(':disabled'));
    if (control) { control.focus({ preventScroll: true }); return; }
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
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-settings-section]')].filter(button => !button.hidden);
  let current = buttons[0];
  if (content.scrollTop > 4) {
    for (const button of buttons) {
      if (element(`#${button.dataset.settingsSection}`).getBoundingClientRect().top <= top + 88) current = button;
    }
    if (content.scrollHeight - content.clientHeight - content.scrollTop < 8) current = buttons.at(-1)!;
  }
  for (const button of buttons) {
    if (button === current) button.setAttribute('aria-current', 'location');
    else button.removeAttribute('aria-current');
  }
}
function openSettings(focusId?: string) {
  if (!state.session || state.submitting) return;
  if (researchEntry === 'natural' || currentRun() && !focusId) {
    if (currentRun() || chatWorkspace?.id) setMobileView('compose');
    // The statement may still be waiting for its owner, with a conversation but no proof run yet.
    void (naturalPage ?? openNaturalResearch()).then(() => {
      const settings = document.querySelector<HTMLDetailsElement>('#formalize-settings');
      if (settings) settings.open = true;
      const key = document.querySelector<HTMLElement>('#formalize-key');
      key?.focus(); key?.scrollIntoView({ block: 'center' });
    });
    return;
  }
  if (focusId && ['source', 'environment', 'template'].includes(focusId)) {
    closeSettings(false);
    chooseEntry('lean');
    startDraft();
    const options = field(focusId).closest('details');
    if (options) options.open = true;
    field(focusId).focus();
    field(focusId).scrollIntoView({ block: 'nearest', behavior: 'instant' });
    return;
  }
  // The configuration belongs to the next research, so it opens on the new-research page.
  if (currentRun()) startDraft();
  const dialog = element<HTMLDialogElement>('#run-settings');
  // The preview replaces the composer that holds this dialog, so it closes first (otherwise the modal opens unseen) and
  // comes back when the dialog closes.
  const preview = document.body.dataset.draftPreview === 'true';
  if (preview) {
    document.body.dataset.draftPreview = 'false';
    element('#open-draft-preview').setAttribute('aria-expanded', 'false');
  }
  modulePlanLibrary.refresh();
  void serverModulePlans.refresh();
  if (!dialog.open && (preview || document.body.dataset.mobileView === 'runs')) {
    settingsWorkspaceReturn = { focus: document.activeElement instanceof HTMLElement ? document.activeElement : undefined, preview };
    setMobileView('compose');
  }
  showDialog(dialog);
  if (focusId) {
    // The field's section starts at the top of the pane, so the end of the section above does not show over it.
    const control = element(`#${focusId}`), section = control.closest<HTMLElement>('.settings-content .form-section');
    section?.scrollIntoView({ block: 'start', behavior: 'instant' });
    control.focus({ preventScroll: Boolean(section) });
    const pane = element('.settings-content').getBoundingClientRect(), box = control.getBoundingClientRect();
    if (box.bottom > pane.bottom) control.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
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
const recordsFull = () => Boolean(state.session && state.runs.length >= state.session.limits.maxRuns);
let readinessFull = false;
function renderPreparation(issues?: SubmissionIssue[]) {
  element('#submission-readiness').hidden = researchEntry !== 'lean';
  if (researchEntry !== 'lean') { clearValidation(); return; }
  issues ??= currentSubmissionIssues();
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
  // The first connection is still reading the records after the session arrived: that is loading, not a lost connection.
  const pending = !state.session || !state.connected && !state.lost;
  const offline = !pending && !state.connected;
  const environmentReady = Boolean(state.session?.runtime.ready && state.session.providers.length);
  // An empty task nobody has tried to submit yet (a fresh page, or right after a submission) is the next step, not a fault.
  const composing = issue?.field === 'task' && !validationShown.has('task') && !field('task').value.trim();
  // At the record limit the server refuses any new run, so that comes before the draft's own gaps.
  const full = readinessFull = recordsFull();
  const phase = state.submitting ? 'submitting' : pending ? 'pending' : offline || !environmentReady ? 'offline'
    : full ? 'full' : composing ? 'compose' : issue ? 'missing' : 'ready';
  const target = element('#submission-readiness');
  if (target.dataset.state !== phase) target.dataset.state = phase;
  // A Key nobody has been asked for yet is the next step, as an empty task is: one quiet line, the storage notes stay in the settings.
  const firstKey = phase === 'missing' && issue?.field === 'api-key' && !validationShown.has('api-key');
  target.toggleAttribute('data-quiet', firstKey);
  // Ready says what the run will work on; a statement Lean already accepts without sorry leaves the Agents nothing to prove.
  const checked = phase === 'ready' ? sourceCheck.current() : undefined, settled = checked?.status === 'complete';
  target.toggleAttribute('data-settled', settled);
  patchText(element('#readiness-title'), state.submitting ? t('正在提交研究') : pending ? t('正在读取提交配置')
    : offline ? t('连接中断，草稿可继续编辑') : !environmentReady ? t('运行环境未就绪')
      : full ? t('研究记录已满 {0} 条', state.session?.limits.maxRuns) : composing ? t('写下研究任务') : firstKey ? t('连接模型后即可提交')
        : issue?.message ?? (settled ? t('原题里没有 sorry')
        : checked?.status === 'ready' ? t('可以提交 · {0} 处 sorry 待证明', checked.sorries) : t('可以提交')));
  patchText(element('#readiness-detail'), state.submitting ? t('请稍候，提交结果将在对话中显示。') : pending ? state.session ? '' : t('连接后可编辑研究任务。')
    // Offline, the notice at the top already says the draft is kept.
    : offline ? '' : !environmentReady ? t('环境恢复后可提交，当前草稿会保留。')
      : full ? t('删除一条已结束的记录后才能提交新的研究；需要的档案请先下载。草稿会保留。')
      : firstKey ? '' : issue?.field === 'api-key' ? (state.session?.account?.keyVault ? t('勾选「保存到我的账号」后，下次不用再填。') : t('每次提交后清空，不随草稿保存；可在设置里选择在此标签页记住。'))
        : issue?.field === 'task' ? t('说明要证明的目标与约束。')
          : issue?.check ? t('原题需要先能编译；点「查看错误」定位到出错位置。')
          : issue?.field === 'source' ? t('添加原始 Lean 题目，可打开「预览」查看。')
            : issue ? t('补全配置后即可提交当前题目。') : settled ? t('提交只会验收现有证明；要让 Agent 研究，把待证部分写成 sorry。') : '');
  patchText(element('#readiness-action'), full ? t('整理研究记录') : issue?.check ? t('查看错误') : issue ? labels[issue.field] : settled ? t('编辑源码') : t('查看配置'));
  element('#readiness-detail').hidden = !element('#readiness-detail').textContent;
  renderGlyph(element('#readiness-icon'), state.submitting ? 'spinner' : phase === 'ready' && !settled ? 'circle-check' : phase === 'compose' ? 'square-pen' : firstKey ? 'key-round' : 'circle-alert');
  const action = element<HTMLButtonElement>('#prepare-run');
  if (action.disabled !== (pending || state.submitting)) action.disabled = pending || state.submitting;
  renderBudgetEstimate();
}
/** Time and turns are hard stops; tokens are estimated from this account's finished runs on the same model. */
function renderBudgetEstimate() {
  const turns = Number(field('max-turns').value), seconds = Number(field('max-seconds').value), model = field('model').value.trim();
  if (!Number.isSafeInteger(turns) || turns < 0 || !Number.isSafeInteger(seconds) || seconds < 0) { patchText(element('#budget-estimate'), ''); return; }
  const cap = state.session ? tokenCap(field('max-tokens').value, state.session.limits.maxTotalTokens) : undefined;
  const estimate = turns ? usageEstimate(state.runs, model, turns) : undefined;
  const limits = t('解题时间：{0}；研究轮次：{1}。', seconds ? t('{0} 分钟', Math.ceil(seconds / 60)) : t('不限'), turns || t('不限'));
  const target = element('#budget-estimate');
  target.title = estimate ? t('根据最近 {0} 次 {1} 运行，预计约 {2} Token。', estimate.samples, model, formatTokens(estimate.ceiling)) : '';
  patchText(target, sentences(limits, cap ? t('按已报告用量在 {0} Token 停止，在途请求可能超额；不代表金额封顶。', formatTokens(cap)) : ''));
}
function focusProofInstructions(preventScroll = false) {
  element<HTMLDetailsElement>('#proof-instructions').open = true;
  field('task').focus({ preventScroll });
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
  if (issue.field === 'task') { closeSettings(false); setMobileView('compose'); element<HTMLDetailsElement>('#proof-instructions').open = true; }
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
  element('#draft-continuation').hidden = !draftContinuation;
  if (draftContinuation) patchText(element('#draft-continuation-label'), t('从「{0}」继续', draftContinuation.label));
  element('#settings-continuation').hidden = !draftContinuation;
  if (draftContinuation) patchText(element('#settings-continuation'), t('带入成果：{0}。原题保持不变，新运行仍需重新通过 Lean 检查与独立验收。', draftContinuation.label));
  const origin = draftContinuation && state.runs.find(run => run.id === draftContinuation!.runId);
  const context: ContinuationPreview | undefined = continuationPreview ? { ...continuationPreview, from: draftContinuation }
    : origin ? { title: origin.title, runId: origin.id, from: draftContinuation, originalSeconds: origin.maxRunSeconds, originalTurns: origin.maxTurns, originalTokens: origin.maxTotalTokens } : undefined;
  renderContinuationPreview(element('#research-continuation-preview'), context, { seconds: Number(field('max-seconds').value), turns: Number(field('max-turns').value), tokens: Number(field('max-tokens').value) * 10_000 || undefined });
  const budgetOrigin = budgetDraftOrigin ?? (origin && !isSample(origin) ? { runId: origin.id, source: origin.source, environment: origin.environment } : undefined);
  const matchingBudgetOrigin = budgetOrigin && budgetOrigin.source === field('source').value && budgetOrigin.environment === field('environment').value ? budgetOrigin : undefined;
  const budgetTokens = state.session ? tokenCap(field('max-tokens').value, state.session.limits.maxTotalTokens) : undefined;
  renderResearchBudgetDraft(element('#research-budget-draft'), matchingBudgetOrigin
    ? { runId: matchingBudgetOrigin.runId, projectId: matchingBudgetOrigin.projectId, tokens: budgetTokens ?? 0, providerId: field('provider').value, model: field('model').value.trim() } : undefined, api,
    matchingBudgetOrigin?.projectId ? () => {
      if (state.submitting) return;
      budgetDraftOrigin = { runId: matchingBudgetOrigin.runId, source: field('source').value, environment: field('environment').value as WebEnvironment };
      draftChanged(); saveDraft();
    } : undefined);
  renderResearchStartCost(element('#research-run-cost'), state.session && !matchingBudgetOrigin ? { owner: ownerOfSession(state.session), account: Boolean(state.session.account),
    request: api, providerId: field('provider').value, model: field('model').value.trim(), stages: [{ kind: 'proof', tokens: budgetTokens ?? 0 }], locked: state.submitting,
    onSetTokenLimit: () => openSettings('max-tokens') } : undefined);
  element('#draft-formalization').hidden = !draftFormalization;
  element('#confirmed-original').hidden = !draftFormalization;
  element('#creation-mode').textContent = draftFormalization ? t('已确认的自然语言原题') : t('已有 Lean 原题');
  element('#confirmed-original-text').textContent = draftFormalization?.original ?? t('正在加载…');
  if (draftFormalization) element<HTMLAnchorElement>('#draft-formalization-link').href = `formalize.html?id=${encodeURIComponent(draftFormalization.id)}`;
  renderPreparation();
  renderTemplateSelection();
  renderShell();
}
async function loadConfirmedOriginal() {
  const binding = draftFormalization;
  if (!binding) return;
  try {
    const { formalization } = await api<{ formalization: WebFormalization }>(`/api/formalizations/${encodeURIComponent(binding.id)}`);
    if (draftFormalization !== binding) return;
    if (formalization.status !== 'confirmed' || formalization.report?.evidenceSha256 !== binding.evidenceSha256
      || formalization.report.statement !== binding.source || formalization.environment !== binding.environment) return;
    binding.original = formalization.original;
    renderComposerSummary();
  } catch (error) {
    if (draftFormalization === binding) element('#confirmed-original-text').textContent = message(error);
  }
}
function rememberConversationScroll() {
  const scroll = element('#conversation-scroll');
  // Hidden panes report zero geometry; keep their last visible reading state.
  if (scroll.clientHeight) conversationScroll.top = scroll.scrollTop;
}
function restoreConversationScroll() {
  const scroll = element('#conversation-scroll');
  if (scroll.clientHeight) scroll.scrollTop = conversationScroll.top;
}
/** The new-research page: the sample, the first-run steps and the example statements above the composer. */
function renderConversation() {
  renderComposerSummary();
  renderAnnouncement();
  const signature = JSON.stringify([state.session?.templates, state.session?.sample, state.connected, state.runs.length > 0]);
  if (signature === state.conversationSignature) return;
  state.conversationSignature = signature;
  rememberConversationScroll();
  drawConversation(element('#conversation'), {
    templates: (state.session?.templates ?? []).map(template => ({ id: template.id, name: template.name, environment: environmentName(template.environment) })),
    ...(state.session?.sample ? { sample: { title: state.session.sample.title } } : {}),
    firstRun: Boolean(state.session) && !state.runs.length,
  });
  renderTemplateSelection();
  restoreConversationScroll();
}
/** Screen readers hear the selected run's state and, while it works, its newest step. */
function renderAnnouncement() {
  const run = currentRun();
  const announcement = run ? t('{0}。{1}', status(run).label, activeRun(run) ? localizeText(run.events.at(-1)?.message ?? '') : resultDescription(run)) : '';
  patchText(element('#conversation-announcement'), announcement);
}
/** Where a provider's requests go, in a reader's terms: a public service by its host (the full address in the tooltip); the server's own gateway is not an address anyone can use. */
function providerAddress() {
  const address = element('#provider-address'), baseUrl = state.session?.providers.find(provider => provider.id === field('provider').value)?.baseUrl;
  // The server only accepts absolute HTTPS addresses or its own gateway (config.ts).
  const host = baseUrl ? new URL(baseUrl).hostname : '', gateway = host === 'host.docker.internal';
  address.textContent = !baseUrl ? '' : gateway ? t('经工作台服务器转发') : host;
  address.title = baseUrl && !gateway ? baseUrl : '';
  restoreKey();
  // A key this account saved, or for an admin one the server holds, lets the field stay empty.
  const account = state.session?.account, providerId = field('provider').value, key = element<HTMLInputElement>('#api-key');
  const saved = account?.savedKeys?.find(item => item.providerId === providerId), held = !saved && Boolean(account?.serverKeys?.includes(providerId));
  key.required = !saved && !held;
  key.placeholder = saved ? t('已保存 ····{0}，留空即使用', saved.ending) : held ? t('留空使用服务器保存的 Key') : '';
  element('#server-key-note').hidden = !held;
  const savedNote = element('#saved-key-note');
  savedNote.hidden = !saved; savedNote.textContent = saved ? t('已保存 Key · 末四位 {0}', saved.ending) : '';
  // With an account that can save keys, the tab-only memory gives way to saving on the server.
  const vault = Boolean(account?.keyVault);
  element('#key-save-row').hidden = !vault; element('#key-save-note').hidden = !vault; element('#delete-saved-key').hidden = !saved;
  element('#key-memory-row').hidden = vault; element('#key-memory-note').hidden = vault;
  key.setAttribute('aria-describedby', ['credential-note', ...(saved ? ['saved-key-note'] : []), ...(held ? ['server-key-note'] : []),
    ...(vault ? ['key-save-note'] : []), 'api-key-validation'].join(' '));
}
/** The key a question about `run` would use, in the order the server takes them: typed, then saved, then the server's. */
function explainKey(run: WebRun): ExplainKey {
  const account = state.session?.account, saved = account?.savedKeys?.find(item => item.providerId === run.providerId);
  if (saved) return { source: 'saved', ending: saved.ending };
  if (account?.serverKeys?.includes(run.providerId)) return { source: 'server' };
  return rememberedKey(keyStorage, run.providerId, providerUrl(run.providerId)) ? { source: 'remembered' } : { source: 'none' };
}
function providerUrl(id: string) { return state.session?.providers.find(provider => provider.id === id)?.baseUrl ?? ''; }
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
  if (state.session?.account?.keyVault) remember.checked = false;
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
const environmentName = (id: WebEnvironment | string) => environmentInfo(id)?.name ?? (id === webTaskEnvironment ? t('TheoremOS 数学环境') : t('Lean 标准库'));
const leanVersion = (toolchain: string) => toolchain.replace(/^leanprover\/lean4:/, '');
function updateEnvironment() {
  const environment = environmentInfo(field('environment').value);
  const details = element('#environment-details');
  // What the environment offers; its exact versions are for reproducing a run, so they stay in the tooltip and the run's 全部配置.
  details.textContent = environment ? localizeText(environment.description) : t('请选择证明环境');
  details.title = environment
    ? `${localizeText(environment.description)} · Lean ${leanVersion(environment.toolchain)}${environment.mathlibRevision ? ` · Mathlib ${environment.mathlibRevision}` : ''}`
    : t('请选择证明环境');
  details.setAttribute('aria-label', details.title);
}
function renderTemplates(preferred = '', useFirst = false) {
  const templates = state.session?.templates.filter(template => template.environment === field('environment').value) ?? [];
  renderOptions(element<HTMLSelectElement>('#template'), [...templates.map(template => [template.id, template.name] as const), ['', t('自定义 Lean')]],
    templates.some(template => template.id === preferred) ? preferred : useFirst ? templates[0]?.id ?? '' : '');
}
/** Sizes only matter near the limit; below it the counter stays empty. */
const nearLimit = (count: number, limit?: number) => Boolean(limit && count >= limit * .8);
function updateCounts() {
  for (const [id, limit] of [['source', state.session?.limits.maxSourceBytes], ['task', state.session?.limits.maxTaskBytes]] as const) {
    const count = byteSize(field(id).value);
    const target = element(`#${id}-count`);
    target.textContent = nearLimit(count, limit) ? `${byteLabel(count)} / ${byteLabel(limit!)}` : '';
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
  const knowledgeDigest = serverModulePlans.knowledgeDigest();
  const skillMode = field('research-mode').value === 'skill';
  return { providerId: field('provider').value, model: field('model').value,
    effort: field('effort').value as WebEffort, environment: field('environment').value as WebEnvironment,
    source: field('source').value, task: field('task').value, templateId: field('template').value,
    maxTurns: field('max-turns').value, maxRunSeconds: field('max-seconds').value, workers: field('workers').value,
    ...(field('max-tokens').value ? { maxTotalTokens: field('max-tokens').value } : {}),
    coordination: element<HTMLInputElement>('input[name="coordination"]:checked').value as WebCoordination,
    ...(skillMode ? { researchMode: 'skill' as const, skillLoading: field('skill-loading').value as 'native' | 'file' } : {}),
    ...(element<HTMLInputElement>('#plan-approval').checked ? { planApproval: true as const } : {}),
    ...(knowledgeDigest !== undefined ? { knowledgeDigest } : {}),
    ...(!skillMode && (modulePlan.custom.length || modulePlan.scheduler !== 'plan' || modulePlan.context !== 'full') ? { modulePlan } : {}),
    ...(draftContinuation ? { continueFrom: draftContinuation } : {}),
    ...(budgetDraftOrigin && budgetDraftOrigin.source === field('source').value && budgetDraftOrigin.environment === field('environment').value
      ? { problemBudget: { runId: budgetDraftOrigin.runId, ...(budgetDraftOrigin.projectId ? { projectId: budgetDraftOrigin.projectId } : {}) } } : {}),
    ...(draftFormalization ? { formalization: { id: draftFormalization.id, evidenceSha256: draftFormalization.evidenceSha256 } } : {}),
    ...(draftSharedProofOrigin ? { sharedProofOrigin: { ...draftSharedProofOrigin } } : {}),
    ...(draftClassicOrigin ? { classicOrigin: { ...draftClassicOrigin } } : {}),
    ...(draftLibraryProposalOrigin ? { libraryProposalOrigin: { ...draftLibraryProposalOrigin } } : {}) };
}
function selectedProblemLibraries() {
  const selection = researchSelection.value();
  return [...(selection?.agent ? [selection.agent] : []), ...(selection?.skills ?? []), ...(selection?.libraries ?? [])];
}
function renderAccountProblemDraft() {
  const session = state.session;
  const show = Boolean(session && draftReady && researchEntry === 'lean' && state.composing && !currentRun());
  problemDraftHost.hidden = !show;
  renderProblemDraftPanel(problemDraftHost, show && session ? {
    owner: ownerOfSession(session), account: Boolean(session.account), value: leanProblemDraft(captureDraft(), selectedProblemLibraries()),
    locked: state.submitting || submissionIdentity.unresolved, request: api, target: problemDraftTarget, onRestore: restoreProblemDraft,
  } : undefined);
}
async function restoreProblemDraft(value: ProblemDraftValue, beforeApply: () => void) {
  if (!state.session || state.submitting) throw new Error(t('编辑器尚未就绪，请重新选择恢复。'));
  const owner = ownerOfSession(state.session), revision = draftRevision, entry = researchEntry;
  const original = JSON.stringify(chatWorkspace?.problemDraft());
  if (value.mode === 'lean') value = { ...value, draft: editableTaskDraft(value.draft, submissionIdentity.unresolved, value.libraries?.length ? value.draft.environment : undefined) };
  const selected = value.mode === 'lean' && value.libraries?.length ? await researchSelection.prepare(value.libraries, value.draft.environment) : undefined;
  if (value.mode === 'natural') { if (!naturalPage) naturalPage = Promise.resolve().then(loadNaturalResearch); await naturalPage; }
  if (!state.session || ownerOfSession(state.session) !== owner || state.submitting || currentRun() || draftRevision !== revision || researchEntry !== entry
    || original !== undefined && original !== JSON.stringify(chatWorkspace?.problemDraft())) throw new Error(t('读取期间原题已修改，请重新选择恢复。'));
  beforeApply();
  problemDraftTarget = undefined; productTarget.delete('accountDraft'); productTarget.delete('draftVersion');
  const address = new URL(location.href); address.searchParams.delete('accountDraft'); address.searchParams.delete('draftVersion'); history.replaceState(null, '', address);
  formalizationLink = null;
  if (value.mode === 'natural') {
    chooseEntry('natural'); startDraft(false, 'replace'); chatWorkspace!.restoreProblemDraft(value);
  } else {
    replaceDraft('import', () => applyTaskDraft(value.draft, selected?.configuration.environment));
    if (selected) researchSelection.adopt(selected); else researchSelection.clear();
    chooseEntry('lean'); startDraft(false, 'replace'); draftChanged(); saveDraft(); renderDraftRecovery();
    field('source').focus({ preventScroll: true });
  }
  renderAccountProblemDraft();
}
function setDraftStatus(text: string, warning = false) {
  element('#draft-status').textContent = text;
  element('#draft-status').classList.toggle('warning', warning);
}
function renderDraftRecovery() {
  const recovery = draftRecovery.current;
  element('#draft-recovery').hidden = !recovery;
  for (const id of ['restore-draft', 'restore-draft-settings']) {
    const button = element<HTMLButtonElement>(`#${id}`);
    button.hidden = !recovery;
    button.disabled = state.submitting || restoringDraft;
  }
  if (!recovery) return;
  const labels: Record<ReplacementReason, string> = {
    template: t('已切换示例'), reset: t('已重置草稿'), reuse: t('已复用任务'), import: t('已载入任务文件'),
    source: t('已导入 Lean 文件'), edit: t('已应用源码编辑'), paste: t('粘贴的 Lean 代码已设为原始题目'),
  };
  patchText(element('#draft-recovery-text'), labels[recovery.reason]);
  element('#draft-recovery-local').hidden = recovery.persisted;
}
function replaceDraft(reason: ReplacementReason, change: () => void) {
  const before = latestDraft ?? captureDraft();
  const libraries = selectedProblemLibraries();
  const track = draftReady && !replacingDraft;
  const nested = replacingDraft;
  replacingDraft = true;
  // Another problem or a fresh draft no longer continues the version; editing the statement or reusing a run keeps its own.
  if (reason !== 'edit' && reason !== 'reuse') draftContinuation = undefined;
  if (reason !== 'edit' && reason !== 'reuse') continuationPreview = undefined;
  if (reason !== 'edit' && reason !== 'reuse') budgetDraftOrigin = undefined;
  if (reason !== 'edit') draftFormalization = undefined;
  if (reason !== 'edit') { draftSharedProofOrigin = undefined; renderSharedProofOrigin(); }
  if (reason !== 'edit') { draftLibraryProposalOrigin = undefined; renderLibraryProposalOrigin(); }
  if (reason !== 'edit') {
    const clearAddress = draftReady || Boolean(draftClassicOrigin);
    draftClassicOrigin = undefined; document.querySelector('[data-classic-origin]')?.remove();
    if (clearAddress) { const address = new URL(location.href); address.searchParams.delete('fromClassic'); history.replaceState(null, '', address); }
  }
  try { change(); } finally { replacingDraft = nested; }
  if (track) {
    draftRecovery.remember(before, captureDraft(), reason, libraries);
    renderDraftRecovery();
  }
}
async function recoverDraft() {
  const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
  const recovery = draftRecovery.current;
  if (!recovery || !state.session || state.submitting || restoringDraft) return;
  const owner = ownerOfSession(state.session), revision = draftRevision, identity = JSON.stringify(recovery);
  const selectedId = state.selectedId, composing = state.composing, librariesBefore = JSON.stringify(selectedProblemLibraries());
  const fromSettings = element<HTMLDialogElement>('#run-settings').open;
  restoringDraft = true; renderDraftRecovery();
  try {
    const draft = editableTaskDraft(recovery.draft, submissionIdentity.unresolved, recovery.libraries?.length ? recovery.draft.environment : undefined);
    const selected = recovery.libraries?.length ? await researchSelection.prepare(recovery.libraries, draft.environment) : undefined;
    if (!state.session || ownerOfSession(state.session) !== owner || state.submitting || draftRevision !== revision
      || selectedId !== state.selectedId || composing !== state.composing || librariesBefore !== JSON.stringify(selectedProblemLibraries())
      || identity !== JSON.stringify(draftRecovery.current)) {
      toast(tx('核对依赖期间草稿已变化，请重新选择撤销。', 'The draft changed while checking its dependencies. Choose Undo again.')); return;
    }
    draftRecovery.clear();
    document.querySelector('[data-classic-origin]')?.remove();
    const address = new URL(location.href); address.searchParams.delete('fromClassic'); history.replaceState(null, '', address);
    applyTaskDraft(draft, selected?.configuration.environment);
    if (recovery.libraries) { if (selected) researchSelection.adopt(selected); else researchSelection.clear(); }
    startDraft(); draftChanged(); saveDraft();
    if (fromSettings) openSettings('source');
    else focusProofInstructions(true);
    toast(t('已恢复替换前的草稿，请重新填写 API Key'));
  } catch (error) {
    toast(tx('暂时无法恢复固定依赖，两份草稿均已保留，请重新撤销。', 'Could not restore the fixed dependencies. Your drafts are preserved; retry Undo. ') + message(error));
  } finally { restoringDraft = false; renderDraftRecovery(); }
}
/** 先审计划 holds the Agents after the Lead's plan, so it needs a Lead and at least one other Agent. */
const planApprovalAvailable = () => element<HTMLInputElement>('input[name="coordination"]:checked').value === 'cooperative' && Number(field('workers').value) >= 2;
function syncResearchMode() {
  const skill = field('research-mode').value === 'skill';
  if (skill) {
    field('workers').value = '1';
    element<HTMLInputElement>('input[name="coordination"][value="independent"]').checked = true;
    element<HTMLInputElement>('#plan-approval').checked = false;
  }
  field('workers').disabled = skill;
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="coordination"]')) radio.disabled = skill;
  element('#research-mode-note').hidden = !skill;
  element('#skill-loading-field').hidden = !skill;
  element('.plan-approval-option').hidden = skill;
  element('#module-plan').hidden = skill;
  element('[data-settings-section="module-plan"]').hidden = skill;
}
function draftChanged(persist = true) {
  syncResearchMode();
  if (draftFormalization && (field('source').value !== draftFormalization.source || field('environment').value !== draftFormalization.environment)) {
    draftFormalization = undefined; draftContinuation = undefined;
    toast(t('原题或环境已修改，当前草稿已转为普通 Lean 题目。'));
  }
  element<HTMLInputElement>('#plan-approval').disabled = !planApprovalAvailable();
  latestDraft = captureDraft();
  modulePlanLibrary.sync();
  draftRevision++;
  renderImportState();
  sourceCheck.schedule();
  renderSourceCheckView();
  renderComposerSummary();
  renderDraftPreview();
  renderAccountProblemDraft();
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
    ownedDrafts.setItem(taskDraftStorageKey, encodeTaskDraft(captureDraft()));
    draftDirty = false;
    setDraftStatus(t('草稿已存于此标签页'));
  } catch {
    // Avoid restoring an older draft after the latest edits could not be saved.
    try { ownedDrafts.removeItem(taskDraftStorageKey); } catch { /* Storage can be unavailable. */ }
    setDraftStatus(t('草稿未保存'), true);
  }
}
function applyTaskDraft(draft: TaskDraft, fixedEnvironment?: WebEnvironment) {
  draft = editableTaskDraft(draft, submissionIdentity.unresolved, fixedEnvironment);
  continuationPreview = undefined;
  draftSharedProofOrigin = draft.sharedProofOrigin ? { ...draft.sharedProofOrigin } : undefined;
  draftClassicOrigin = draft.classicOrigin ? { ...draft.classicOrigin } : undefined;
  draftLibraryProposalOrigin = draft.libraryProposalOrigin ? { ...draft.libraryProposalOrigin } : undefined;
  renderLibraryProposalOrigin();
  if (draftClassicOrigin) showClassicOrigin();
  renderSharedProofOrigin();
  budgetDraftOrigin = draft.problemBudget ? { ...draft.problemBudget, source: draft.source, environment: draft.environment } : undefined;
  modulePlanLibrary.resetSelection();
  clearValidation();
  draftSourceExpanded = false;
  field('provider').value = state.session?.providers.some(provider => provider.id === draft.providerId) ? draft.providerId : '';
  field('environment').value = draft.environment;
  renderTemplates();
  for (const [id, value] of Object.entries({ model: draft.model, effort: draft.effort, source: draft.source, task: draft.task,
    'max-turns': draft.maxTurns === '0' ? '' : draft.maxTurns, 'max-seconds': draft.maxRunSeconds === '0' ? '' : draft.maxRunSeconds,
    workers: draft.workers, 'max-tokens': draft.maxTotalTokens === '0' ? '' : draft.maxTotalTokens ?? '' })) field(id).value = value;
  const template = state.session?.templates.find(template => template.id === draft.templateId
    && template.environment === draft.environment && template.source === field('source').value && template.task === field('task').value);
  field('template').value = template?.id ?? '';
  element<HTMLInputElement>(`input[name="coordination"][value="${draft.coordination}"]`).checked = true;
  field('research-mode').value = draft.researchMode ?? 'legacy';
  field('skill-loading').value = draft.skillLoading ?? 'native';
  element<HTMLInputElement>('#plan-approval').checked = Boolean(draft.planApproval);
  modulePlanEditor.setValue(draft.modulePlan);
  serverModulePlans.setKnowledgeDigest(draft.knowledgeDigest);
  draftContinuation = draft.continueFrom;
  draftFormalization = draft.formalization ? { ...draft.formalization, source: draft.source, environment: draft.environment } : undefined;
  void loadConfirmedOriginal();
  field('api-key').value = '';
  element<HTMLInputElement>('#api-key').type = 'password';
  updateKeyToggle(); providerAddress(); updateEnvironment(); sourceChanged();
  element('#form-error').hidden = true;
  element('#draft-error').hidden = true;
}
function restoreDraft(): boolean {
  let stored: string | null;
  try { stored = ownedDrafts.getItem(taskDraftStorageKey); }
  catch { setDraftStatus(t('草稿保存不可用'), true); return false; }
  if (!stored) return false;
  try {
    applyTaskDraft(decodeTaskDraft(JSON.parse(stored)));
    setDraftStatus(t('已恢复草稿'));
    return true;
  } catch {
    try { ownedDrafts.removeItem(taskDraftStorageKey); } catch { /* Storage can be unavailable. */ }
    setDraftStatus(t('草稿未恢复'), true);
    return false;
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
    const draft = editableTaskDraft(await readTaskDraftFile(file), submissionIdentity.unresolved);
    if (sequence !== taskImportSequence) return;
    if (revision !== draftRevision || state.submitting) { toast(t('草稿已变化，未导入文件')); return; }
    pendingImport = { draft, revision };
    element('#import-filename').textContent = file.name;
    const provider = state.session?.providers.find(provider => provider.id === draft.providerId);
    const plan = draft.modulePlan;
    const schedulerLabels = { plan: t('按研究计划'), 'critical-path': t('优先关键路径'), continuation: t('延续证明前沿') };
    const planSummary = [schedulerLabels[plan?.scheduler ?? 'plan'], plan?.context === 'essential' ? t('精简研究上下文') : t('完整研究上下文'),
      t('启用 {0} / {1} 条自定义规则', plan?.custom.filter(rule => rule.enabled).length ?? 0, plan?.custom.length ?? 0)].join(' · ');
    renderFacts(element('#import-facts'), [[t('证明环境'), environmentName(draft.environment)],
      [t('服务商'), provider?.name ?? t('{0} · 当前不可用', draft.providerId || t('未选择'))], [t('模型'), draft.model || t('未填写'), true],
      [t('推理强度'), effortLabels[draft.effort] ?? draft.effort], [t('轮次上限'), Number(draft.maxTurns) ? draft.maxTurns : t('不限')],
      [t('解题预算 / 秒'), Number(draft.maxRunSeconds) ? draft.maxRunSeconds : t('不限')], [t('Agent 数量'), draft.workers || t('未填写')],
      [t('用量上限 / 万 Token'), Number(draft.maxTotalTokens) ? draft.maxTotalTokens! : t('不限')], [t('模块方案'), planSummary],
      [t('协作模式'), draft.coordination === 'cooperative' ? t('任务协作') : t('独立并行')],
      ...(draft.planApproval ? [[t('先审计划'), t('开启')] as [string, string]] : [])]);
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
      'max-turns': session.defaults.maxTurns || '', 'max-seconds': session.defaults.maxRunSeconds || '', workers: session.defaults.workers, 'max-tokens': '' })) field(id).value = String(value);
    element<HTMLInputElement>(`input[name="coordination"][value="${session.defaults.coordination}"]`).checked = true;
    field('provider').value = session.providers[0]?.id ?? '';
    field('environment').value = session.defaults.environment;
    renderTemplates();
    field('source').value = ''; field('task').value = t('保留原题声明，补全 Lean 证明并通过独立验收。');
    element<HTMLDetailsElement>('#proof-instructions').open = false;
    sourceChanged(); providerAddress(); updateEnvironment();
    element('#form-error').hidden = true;
    element('#draft-error').hidden = true;
    draftReady = wasReady;
    if (wasReady) {
      try { ownedDrafts.removeItem(taskDraftStorageKey); setDraftStatus(t('草稿已重置')); }
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
  const lines = t('{0} 行', source.split(/\r\n|\r|\n/).length);
  target.textContent = nearLimit(size, limit) ? `${lines} · ${byteLabel(size)} / ${byteLabel(limit!)}` : lines;
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
  element('#runtime-note').textContent = !state.connected ? state.lost ? t('连接恢复后可提交') : t('正在检查环境') : session
    ? !session.providers.length ? t('未配置可用服务商') : localizeText(session.runtime.message) || (ready ? t('环境就绪') : t('环境未就绪'))
    : t('等待连接');
  element<HTMLButtonElement>('#submit-run').disabled = !ready || state.submitting || researchEntry !== 'lean';
  renderGlyph(element('#submit-run'), state.submitting ? 'spinner' : 'arrow-up');
  element('#submit-run').setAttribute('aria-label', state.submitting ? t('正在提交') : t('发送研究任务'));
  element('#submit-run').setAttribute('title', state.submitting ? t('正在提交') : touchQuery.matches ? t('发送研究任务') : t('发送研究任务（Enter；Shift+Enter 换行）'));
  element<HTMLButtonElement>('#settings-submit').disabled = !ready || state.submitting;
  element<HTMLButtonElement>('#settings-submit').disabled ||= researchEntry !== 'lean';
  element('#settings-submit').hidden = researchEntry !== 'lean';
  element<HTMLFieldSetElement>('#form-fields').disabled = !session || state.submitting;
  element<HTMLFieldSetElement>('#inline-problem-fields').disabled = !session || state.submitting || researchEntry !== 'lean';
  element<HTMLButtonElement>('#reset-form').disabled = !session || state.submitting;
  element<HTMLButtonElement>('#import-task').disabled = !session || state.submitting;
  element<HTMLButtonElement>('#export-draft').disabled = !session || state.submitting;
  element<HTMLButtonElement>('#new-research').disabled = !session || state.submitting;
  renderDraftRecovery();
  renderRunMonitor();
  renderImportState();
  renderDeleteState();
  renderCancelState();
  renderConversation();
  if (state.draftView === 'modules') renderDraftPreview();
  // Connecting (or losing the connection) starts or stops the statement check.
  sourceCheck.schedule();
}
function status(run: WebRun) {
  if (passed(run)) return { label: acceptedTitle(run), tone: 'passed', symbol: 'circle-check' };
  if (run.status === 'queued') return { label: run.queue ? t('排队中 · 第 {0} 位', run.queue.position) : t('排队中'), tone: '', symbol: 'clock-3' };
  if (run.status === 'running') return planAwaitingApproval(run) ? { label: runProgress(run).phaseLabel, tone: 'warning', symbol: 'list-ordered' }
    : { label: runProgress(run).phaseLabel, tone: 'running', symbol: 'refresh-cw' };
  if (run.status === 'cancelled') return { label: t('已取消'), tone: '', symbol: 'square' };
  if (run.status === 'error') return { label: t('运行错误'), tone: 'failed', symbol: 'circle-alert' };
  // A stopped budget is an expected end; other classified failures need the user to act.
  if (isFaultedRun(run)) return { label: t('运行失败'), tone: 'failed', symbol: 'circle-alert' };
  if (isRejectedRun(run)) return { label: t('验收未通过'), tone: 'failed', symbol: 'circle-alert' };
  return { label: stoppedLabel(run), tone: 'warning', symbol: 'clock-3' };
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
  // One entry that is the run on screen repeats its status line; the strip appears once there is something else to watch.
  root.hidden = !runs.length || runs.length === 1 && runs[0]!.id === state.selectedId;
  root.dataset.stale = String(!state.connected);
  patchText(element('#run-monitor-summary'), [active ? t('{0} 项进行中', active) : '', finished ? t('{0} 项已结束', finished) : ''].filter(Boolean).join('\n'));
  const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : undefined;
  const left = list.scrollLeft;
  drawRunMonitor(list, runs.map((run): MonitorItem => {
    const value = status(run), cancelling = activeRun(run) && state.cancelling.has(run.id), stalled = stalledMinutes(run);
    const label = cancelling ? t('正在取消') : stalled !== undefined ? t('{0} 分钟无新增通过检查或结果集成', stalled) : value.label;
    return { id: run.id, title: run.title, description: state.connected ? label : t('待同步 · {0}', label),
      tone: stalled !== undefined && !cancelling ? 'warning' : value.tone, symbol: stalled !== undefined && !cancelling ? 'hourglass' : value.symbol,
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
  chatWorkspace?.updateOverview();
  // The readiness line warns at the record limit, so it follows the record count too.
  if (recordsFull() !== readinessFull) renderPreparation();
  // Plans waiting for the owner's approval stand in their own group above the rest; nothing in them runs until approved.
  const groups = ownerFirst(filterRuns(state.runs, state.query, state.filter)), runs = [...groups.waiting, ...groups.others];
  const filtered = Boolean(state.query.trim() || state.filter !== 'all');
  const criteria = JSON.stringify([state.query, state.filter]);
  const signature = JSON.stringify([state.selectedId, criteria, groups.waiting.length, runs.map(run => [run.id, run.title, run.model, run.createdAt, environmentName(run.environment), status(run)])]);
  patchText(element('#run-count'), filtered ? `${runs.length}/${state.runs.length}` : String(state.runs.length));
  element('#clear-run-search').hidden = !state.query;
  // With no records at all there is nothing to search or filter; a search that matches nothing keeps its tools.
  element('.history-tools').hidden = !state.runs.length && !filtered;
  // The phone list repeats model and environment under every title; when every run used the same pair it says nothing.
  element('#run-list').toggleAttribute('data-uniform', new Set(state.runs.map(run => `${run.model}\n${run.environment}`)).size <= 1);
  if (!force && signature === state.listSignature) return;
  state.listSignature = signature;
  const list = element('#run-list'), sameCriteria = criteria === historyCriteria;
  if (sameCriteria) rememberHistoryScroll();
  else historyReading = { top: 0, anchors: [] };
  historyCriteria = criteria;
  // Where the selection was, so it can slide to the row chosen now; a changed search or filter moves every row instead.
  const chosen = sameCriteria ? list.querySelector<HTMLElement>(':scope > [data-history-id] > .run-row.selected') : null;
  const chosenBox = selectionBox(chosen), chosenId = chosen?.dataset.runId;
  const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : undefined;
  const rows = new Map(Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-history-id]'), row => [row.dataset.historyId!, row]));
  const focusedIndex = Array.from(rows.keys()).indexOf(focused?.dataset.runId ?? '');
  const ids = new Set(runs.map(run => run.id));
  const headed = groups.waiting.length > 0;
  const headings = new Map(Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-history-group]'), row => [row.dataset.historyGroup!, row]));
  for (const child of Array.from(list.children)) {
    const row = child as HTMLElement;
    if (row.hasAttribute('data-history-group') ? !headed || row.dataset.historyGroup === 'others' && !groups.others.length
      : !ids.has(row.dataset.historyId ?? '') && (runs.length || !row.hasAttribute('data-history-empty'))) row.remove();
  }
  let cursor = list.firstElementChild;
  const heading = (group: 'waiting' | 'others', label: string, count?: number) => {
    let row = headings.get(group);
    if (!row) { row = document.createElement('div'); row.className = 'history-group'; row.dataset.historyGroup = group; row.setAttribute('aria-hidden', 'true'); }
    renderHistoryGroup(row, label, count);
    if (row !== cursor) list.insertBefore(row, cursor);
    cursor = row.nextElementSibling;
  };
  const tabbable = runs.some(run => run.id === state.selectedId) ? state.selectedId : runs[0]?.id;
  for (const run of runs) {
    // The headings only repeat what each row's badge says, so screen readers keep the plain list of runs.
    if (headed && run === groups.waiting[0]) heading('waiting', t('等你处理'), groups.waiting.length);
    if (headed && run === groups.others[0]) heading('others', t('其他运行'));
    let row = rows.get(run.id);
    if (!row) {
      row = document.createElement('div'); row.setAttribute('role', 'listitem'); row.dataset.historyId = run.id;
      rows.set(run.id, row);
    }
    const value = status(run);
    renderHistoryRow(row, { id: run.id, title: run.title, model: run.model, environment: environmentName(run.environment), selected: run.id === state.selectedId,
      tabbable: run.id === tabbable, tone: value.tone, symbol: value.symbol, label: value.label, createdAt: run.createdAt, time: timestamp(run.createdAt) });
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
  // A record that just arrived unfolds into a list read from its top; further down, rows stay where the reader left them.
  const unfolding = sameCriteria && list.scrollTop === 0 ? runs.filter(run => arrivals.has(run.id)) : [];
  arrivals.clear();
  for (const run of unfolding) arriveRow(rows.get(run.id)!);
  const selected = rows.get(state.selectedId)?.querySelector<HTMLElement>('.run-row');
  if (chosenBox && chosenId !== state.selectedId && selected && !unfolding.length) glideSelection(list, chosenBox, selected);
  if (focused && document.activeElement !== focused && list.getClientRects().length) {
    const fallback = rows.get(runs[Math.min(Math.max(focusedIndex, 0), runs.length - 1)]?.id ?? '')?.querySelector<HTMLButtonElement>('button');
    (focused.isConnected ? focused : fallback ?? field('run-search')).focus({ preventScroll: true });
  }
}
/** The runs the history lists, in its order: the group waiting for the owner first, so arrow keys follow the rows. */
const visibleRuns = () => { const { waiting, others } = ownerFirst(filterRuns(state.runs, state.query, state.filter)); return [...waiting, ...others]; };
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
/** A run keeps going on the server; say so, and how its end reaches the reader (the account's mail, else this list). */
const awayNote = () => state.session?.account && state.session.account.completionEmail !== false
  ? t('可以关闭页面，运行会在服务器上继续；结束后会发邮件到 {0}。', state.session.account.email)
  : t('可以关闭页面，运行会在服务器上继续；结束后回到研究记录查看结果。');
function resultTitle(run: WebRun) {
  const guide = failureGuide(run);
  if (guide) return guide.title;
  return passed(run) ? run.formalization ? acceptedTitle(run) : t('完整原题已通过独立验收')
    : activeRun(run) ? run.status === 'queued' ? t('任务已排队') : planGated(run) ? t('证明尚未开始') : t('研究正在运行')
      : run.status === 'cancelled' ? t('运行已取消')
        : run.status === 'error' ? t('运行发生错误')
          : isRejectedRun(run) ? t('完整原题验收未通过') : t('运行已结束，完整原题尚未验收通过');
}
/** The result tab of one run: verdict, proof, route, report, then the task and how it was run. */
function resultProps(run: WebRun): ResultPanelProps {
  const progress = runProgress(run), value = status(run), working = activeRun(run), guide = failureGuide(run);
  const acceptance = passed(run) && !guide ? acceptedVerdict(run) : undefined;
  const provider = state.session?.providers.find(item => item.id === run.providerId);
  const environment = environmentInfo(run.environment);
  const item = (label: string, value: unknown, mono = false) => ({ label, value: String(value), mono });
  const latest = working ? run.events.at(-1) : undefined;
  const proof = candidateSource(run), goals = summarizeGoals(run), approval = planAwaitingApproval(run), later = relatedResearchRuns(state.runs, run);
  const compare = compareProps(run, later);
  return {
    // The plan waiting on its owner has nothing running: no spinner, unless the Lead is revising it from their note.
    verdict: { run: run.id, tone: value.tone, symbol: value.symbol, title: resultTitle(run), description: acceptance?.description ?? resultDescription(run),
      ...(run.formalization ? { meaning: acceptance?.meaning ?? statementConfirmation(run.formalization.confirmation, false, run.formalization.reviewMode) } : {}),
      active: working && (!approval || approval.leadRevising), candidate: Boolean(run.artifact && working),
      ...(latest ? { latest: { at: latest.at, time: timestamp(latest.at, true), message: readableMessage(latest, workerNames(run.observation?.inspection.workers)) } } : {}),
      ...(run.status === 'running' && !planGated(run) && !isSample(run) ? { away: awayNote() } : {}) },
    recovery: isSample(run) ? [] : nextSteps(run, goals), ...(!isSample(run) ? { recoveryContext: { run, limits: state.session?.limits } } : {}), ...(working ? { notify: notifyState() } : {}),
    ...(!isSample(run) && passed(run) ? { saveLibrary: `library.html?${new URLSearchParams({ create: '1', fromRun: run.id })}` } : {}),
    ...(['environment', 'unknown', 'interrupted'].includes(guide?.kind ?? '') ? { feedback: feedbackUrl({ failure: guide!.kind }) } : {}),
    ...(proof ? { proof: { source: proof, verified: Boolean(run.result?.proof && passed(run)), rejected: isRejectedRun(run),
      ...(passed(run) && isStatementReviewed(run) && run.result?.proof ? { explainRun: run.id } : {}) } } : {}), ...(goals ? { goals } : {}),
    ...(proof && state.proofViewer === run.id ? { viewer: { onClose: closeProofViewer } } : {}),
    ...(later.length ? { later: later.map(item => ({ id: item.id, label: item.continueFrom?.label ?? item.title, status: status(item), createdAt: item.createdAt, time: timestamp(item.createdAt),
      comparable: true })) } : {}),
    ...(compare ? { compare } : {}),
    active: working, report: reportProps(run), task: run.formalization?.original ?? run.task,
    // Helpers are declared in the proof, the original targets in both; before a proof exists the problem names them.
    written: writtenNames(headingsOf(run.result?.proof ?? proof ?? run.source)),
    route: detailLevel() === 'full' && (working || (run.observation?.inspection.tasks.length ?? 0) > 0 || Boolean(run.actions?.count) || agentRoutes(run.events).length > 0),
    facts: [item(t('证明环境'), environmentName(run.environment)), item(t('模型'), run.model, true),
      run.finishedAt ? item(t('结束时间'), timestamp(run.finishedAt)) : item(t('创建时间'), timestamp(run.createdAt))],
    // Versions, limits and budgets matter for reproducing the run, not for reading its result.
    config: [item(t('服务商'), provider?.name ?? (isSample(run) ? t('离线示例') : run.providerId)), item(t('推理强度'), effortLabels[run.effort] ?? run.effort),
      ...(run.researchMode === 'skill' ? [item(t('研究方式'), t('单研究者 · 项目技能')), item(t('技能加载'), run.skillLoading === 'file' ? t('读取固定文件') : t('原生加载')),
        ...(run.researchSkill ? [item(t('技能版本'), run.researchSkill.digest, true)] : [])] : []),
      item(t('协作模式'), run.coordination === 'cooperative' ? t('任务协作') : t('独立并行')), item(t('Agent 数量'), run.workers),
      ...(run.planApproval ? [item(t('先审计划'), t('开启'))] : []),
      item(t('轮次上限'), run.maxTurns || t('不限')), item(t('解题预算'), run.maxRunSeconds ? readableDuration(run.maxRunSeconds * 1000) : t('不限')),
      item(t('用量上限'), run.maxTotalTokens ? `${formatTokens(run.maxTotalTokens)} Token` : t('不限')),
      ...(!working && progress.solvingElapsed !== null ? [item(t('研究用时'), readableDuration(progress.solvingElapsed))] : []),
      ...(run.finishedAt ? [item(t('创建时间'), timestamp(run.createdAt))] : []),
      ...(environment ? [item(t('Lean 版本'), environment.toolchain, true)] : []),
      ...(environment?.mathlibRevision ? [item(t('Mathlib 版本'), environment.mathlibRevision, true)] : [])],
  };
}
/** 对比代码 for the later run the reader opened beside this one's result, while both still have code. */
function compareProps(run: WebRun, later: readonly WebRun[]): CompareProps | undefined {
  const other = state.compare?.runId === run.id ? later.find(item => item.id === state.compare!.laterId) : undefined;
  const before = candidateSource(run), after = other ? candidateSource(other) : '';
  if (!other) return;
  if (before && after && (runComparison?.before !== before || runComparison.after !== after || runComparison.folded !== state.foldUnchanged))
    runComparison = { before, after, folded: state.foldUnchanged, result: compareSources(before, after, state.foldUnchanged) };
  return { id: other.id, label: other.continueFrom?.label ?? other.title, ...(before && after ? { comparison: runComparison!.result } : {}), research: { before: run, after: other }, folded: state.foldUnchanged, onClose: closeCompare };
}
function closeCompare() {
  const id = state.compare?.laterId;
  state.compare = undefined; renderPanel(true);
  if (id) document.querySelector<HTMLElement>(`#detail-panel [data-action="compare-continued"][data-run-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}
let resultRouteHost: HTMLElement | undefined;
/** The result's recorded roadmap shares its reader with the dedicated tab; the Agent action lanes open on demand. */
function renderResultRoute(run: WebRun) {
  const roadmapHost = document.querySelector<HTMLElement>('#detail-panel [data-result-roadmap]');
  if (roadmapHost) trajectoryView?.update(roadmapHost, run, nodeId => {
    state.tab = 'trajectory'; renderDetail(true); trajectoryView?.showNode(run.id, nodeId);
  });
  else trajectoryView?.update();
  const host = document.querySelector<HTMLElement>('#detail-panel [data-result-route]') ?? undefined;
  // A replaced host takes its map with it; unmounting stops that map's reading.
  if (resultRouteHost && resultRouteHost !== host) unmountAgentRoute?.(resultRouteHost);
  resultRouteHost = host;
  if (!host) return;
  const details = host.closest<HTMLDetailsElement>('details')!;
  const draw = () => {
    if (!details.open) { unmountAgentRoute?.(host); return; }
    const inspection = run.observation?.inspection;
    renderAgentRoute?.(host, { source: { store: agentActivity, run, lead: inspection?.workers.find(worker => worker.role === 'lead')?.id },
      names: workerNames(inspection?.workers), running: run.status === 'running',
      tasks: taskNames(inspection?.tasks ?? []), planned: inspection?.tasks.length ?? 0, graph: 'elsewhere', time: clockTime });
  };
  details.ontoggle = draw;
  draw();
}
let stallSignature = '';
function updateClocks() {
  if (document.hidden) return;
  // A run can become stuck without any new data; the monitor follows each minute that passes.
  const stalls = state.runs.filter(activeRun).map(run => `${run.id}:${stalledMinutes(run) ?? ''}`).join('|');
  if (stalls !== stallSignature) { stallSignature = stalls; renderRunMonitor(); }
  const run = currentRun();
  if (!run || !activeRun(run)) return;
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
  const author = showingProof && !run.result?.proof ? run.artifact?.workerId : undefined;
  const props: SourcePanelProps = { hasProof, proofLabel, view: state.sourceView, showingProof, verified,
    ...(verified && isStatementReviewed(run) ? { explainRun: run.id } : {}),
    status: showingProof ? verified ? run.formalization ? acceptedTitle(run) : t('完整原题已通过验收') : isRejectedRun(run) ? t('候选 · 验收未通过') : t('候选 · 尚未验收通过') : activeRun(run) && !hasProof ? t('原始题目 · 等待候选') : t('原始题目'),
    tone: showingProof ? verified ? 'verified' : 'candidate' : '',
    ...(author ? { origin: t('来自 {0}', workerNames(run.observation?.inspection.workers).get(author) ?? author) } : {}) };
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
    sourceComparison = { runId: run.id, before, after, folded: state.foldUnchanged, result: compareSources(before, after, state.foldUnchanged, false) };
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
  if (!run.result) return run.error ? { kind: 'error', error: localizeMessage(run.error) } : { kind: 'empty', active: activeRun(run) };
  const stuck = summarizeStuck(run);
  const summary = summarizeReport(run), reason = reportReason(summary.reason);
  // A run stopped before any check (a refused Key, say) has nothing to summarize; the verdict says why, the raw report stays folded.
  if (!reason.text && !reason.code && !stuck && !summary.checks.length && !summary.metrics.length && !summary.identity.length && !summary.library && !run.result.proof)
    return { kind: 'error', error: JSON.stringify(run.result.report, null, 2) };
  if (state.reportMode === 'json') return { kind: 'json', report: run.result.report };
  return { kind: 'summary', summary: { ...(reason.text ? { reason: reason.text } : {}), ...(reason.code ? { diagnostic: reason.code } : {}),
    checks: summary.checks.map(check => { const why = checkReason(check); return { ...check, ...(why ? { reason: why } : {}) }; }),
    metrics: summary.metrics.map(readableMetric), identity: summary.identity, ...(summary.library ? { library: summary.library } : {}) }, accepted: passed(run), ...(stuck ? { stuck } : {}),
    ...(run.result.proof ? { outline: { state: outlines.get(run.id), kitUrl: `/api/runs/${encodeURIComponent(run.id)}/verification-kit`, headings: headingsOf(run.result.proof),
      mathlib: Boolean(environmentInfo(run.environment)?.mathlibRevision ?? run.environment === 'mathlib'),
      ...(isAcceptedRun(run) && isStatementReviewed(run) ? { explainRun: run.id } : {}) } } : {}) };
}
const outlines = new Map<string, OutlineState>();
/** Starts loading the proof outline; the report re-renders when it arrives. Returns whether a request started. */
function loadOutline(run: WebRun, retry = false) {
  if (!run.result?.proof || outlines.has(run.id) && !retry) return false;
  outlines.set(run.id, { status: 'loading' });
  void api<{ outline: WebProofOutline }>(`/api/runs/${encodeURIComponent(run.id)}/outline`)
    .then(({ outline }) => { outlines.set(run.id, { status: 'ready', outline }); })
    .catch(error => { outlines.set(run.id, { status: 'failed', error: t('证明结构整理失败：{0}', message(error)) }); })
    .finally(() => { if (currentRun()?.id === run.id && state.tab === 'result') renderPanel(true); });
  return true;
}
function renderPanel(force = false) {
  const run = currentRun();
  if (!run || !document.querySelector('#detail-panel')) return;
  if (!collaborationView || !trajectoryView) {
    renderRunViewsLoading(element('#detail-panel'));
    return;
  }
  if (state.tab === 'result' && state.reportMode === 'summary') loadOutline(run);
  const content = state.tab === 'source' ? sourceContent(run) : undefined;
  const signature = JSON.stringify([run.id, state.tab, content ? [state.foldUnchanged, content.source, content.props]
    : state.tab === 'result' ? [state.reportMode, detailLevel(), run, outlines.get(run.id), notifyState(), state.proofViewer === run.id,
      relatedResearchRuns(state.runs, run).map(item => [item.id, item.updatedAt, status(item), Boolean(candidateSource(item))]),
      state.compare?.runId === run.id ? [state.compare.laterId, state.foldUnchanged, candidateSource(state.runs.find(item => item.id === state.compare!.laterId) ?? run)] : ''] : state.tab === 'events' ? run.events
      : state.tab === 'modules' ? [run, state.connected] : run]);
  if (!force && signature === state.panelSignature) {
    if (state.tab === 'collaboration') collaborationView?.update(document.querySelector<HTMLElement>('.collaboration-workspace') ?? undefined, run, state.connected, isSample(run));
    if (state.tab === 'trajectory') trajectoryView?.update(document.querySelector<HTMLElement>('.trajectory-workspace') ?? undefined, run);
    return;
  }
  state.panelSignature = signature;
  const panel = element('#detail-panel');
  const navigating = panel.dataset.renderRunId === run.id && (panel.dataset.tab !== state.tab
    || state.tab === 'source' && panel.dataset.renderSourceView !== state.sourceView
    || state.tab === 'result' && panel.dataset.renderReportMode !== state.reportMode);
  if (navigating) finishMotion(panel);
  const samePanel = panel.dataset.renderRunId === run.id && panel.dataset.tab === state.tab;
  // Switching the report between summary and JSON keeps the reader at the report, further down the result tab.
  const switchingReport = samePanel && state.tab === 'result' && panel.dataset.renderReportMode !== state.reportMode;
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
  if (!samePanel || state.tab !== 'events') activityReader?.update(undefined, run);
  if (!samePanel || state.tab !== 'modules') moduleView?.update(undefined, moduleInput(run));
  if (!samePanel || state.tab !== 'collaboration') collaborationView?.update();
  if (!samePanel || state.tab !== 'trajectory' && state.tab !== 'result') trajectoryView?.update();
  const tab = state.tab;
  renderDetailPanel!(panel, content ? { tab: 'source', source: content.diff ? { ...content.props, diff: sourceDiff(run) } : content.props }
    : tab === 'result' ? { tab, result: resultProps(run) } : { tab: tab as Exclude<DetailTab, 'source' | 'result'> });
  if (content && !content.diff) {
    patchText(panel.querySelector('.source-line-numbers')!, content.numbers);
    patchText(panel.querySelector('.source-code code')!, content.source);
  }
  panel.dataset.renderRunId = run.id; panel.dataset.tab = state.tab;
  panel.dataset.renderSourceView = state.sourceView;
  panel.dataset.renderReportMode = state.reportMode;
  if (switchingTab) { panel.scrollTop = 0; panel.scrollLeft = 0; }
  if (switchingReport) panel.querySelector('.result-report')?.scrollIntoView({ block: 'start', behavior: 'instant' });
  const scroll = panel.querySelector<HTMLElement>('.code-scroll,.activity-scroll,.diff-scroll');
  if (scroll && state.tab !== 'events') { scroll.scrollTop = scrollTop; scroll.scrollLeft = scrollLeft; }
  if (samePanel && action) panel.querySelector<HTMLElement>(`[data-action="${action}"]`)?.focus({ preventScroll: true });
  else if (samePanel && sourceMode) panel.querySelector<HTMLElement>(`[data-source-view="${sourceMode}"]`)?.focus({ preventScroll: true });
  else if (sameView && reportMode) panel.querySelector<HTMLElement>(`[data-report-view="${reportMode}"]`)?.focus({ preventScroll: true });
  else if (sameView && focused === previousScroll) scroll?.focus({ preventScroll: true });
  else if (samePanel && focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  if (state.tab === 'collaboration') collaborationView?.update(panel.querySelector<HTMLElement>('.collaboration-workspace')!, run, state.connected, isSample(run));
  if (state.tab === 'events') activityReader?.update(panel.querySelector<HTMLElement>('.activity-workspace')!, run, workerNames(run.observation?.inspection.workers));
  if (state.tab === 'trajectory') trajectoryView?.update(panel.querySelector<HTMLElement>('.trajectory-workspace')!, run);
  if (state.tab === 'modules') moduleView?.update(panel.querySelector<HTMLElement>('.module-workspace')!, moduleInput(run));
  if (state.tab === 'result') renderResultRoute(run);
  updateDiffNavigation(0, !sameView);
  // Only on arriving at the result tab: switching the report keeps the reader where they were.
  if (navigating) animateEntrance(panel, 'panel', switchingTab);
  updateSourceReader();
}
onDetailLevel(() => { if (state.tab === 'result') renderPanel(true); });
function moduleInput(run?: WebRun): ModuleViewInput {
  return { id: run?.id ?? 'draft', run, model: run?.model ?? field('model').value,
    researchMode: run ? run.researchMode : field('research-mode').value as 'legacy' | 'skill',
    workers: run?.workers ?? Number(field('workers').value),
    coordination: run?.coordination ?? element<HTMLInputElement>('input[name="coordination"]:checked').value as WebCoordination,
    environment: environmentName(run?.environment ?? field('environment').value), connected: state.connected,
    editable: !run && Boolean(state.session) && !state.submitting,
    modulePlan: run ? run.modulePlan : captureDraft().modulePlan };
}
function renderDraftPreview(force = false) {
  if (currentRun() || !state.session || opening()) return;
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
    ['budget', t('解题预算'), Number(field('max-seconds').value) === 0 ? t('不限') : numericLabel('max-seconds', value => readableDuration(value * 1000)), false],
    ['workers', t('Agent 数量'), numericLabel('workers', value => t('{0} 个 Agent', value)), false],
  ] as const;
  const title = template?.name ?? t('自定义研究');
  const signature = JSON.stringify([title, source, task, facts, draftSourceExpanded, state.draftView, state.connected,
    element<HTMLInputElement>('input[name="coordination"]:checked').value, captureDraft().modulePlan,
    field('research-mode').value, field('skill-loading').value, state.submitting]);
  if (!force && signature === draftPreviewSignature && document.querySelector('#draft-preview')) return;
  draftPreviewSignature = signature;
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const shown = draftSourceExpanded && byteSize(source) <= state.session.limits.maxSourceBytes ? lines : lines.slice(0, 160);
  if (!detail.querySelector('#draft-preview')) {
    moduleView?.update();
    finishMotion(detail);
    unmountRunHeader(detail);
    detail.textContent = '';
  }
  const truncated = lines.length > shown.length;
  drawDraftPreview(detail, { title, facts, truncated, task: task || t('未填写'), view: state.draftView,
    size: t('{0} 行', truncated ? t('前 {0} / {1}', shown.length, lines.length) : lines.length) });
  patchText(detail.querySelector('.preview-line-numbers')!, shown.map((_, index) => index + 1).join('\n'));
  patchText(detail.querySelector('#draft-preview-code code')!, shown.join('\n'));
  const showingModules = state.draftView === 'modules';
  if (showingModules && !moduleView) renderRunViewsLoading(detail.querySelector<HTMLElement>('.module-workspace')!);
  if (!showingModules) moduleView?.update(undefined, moduleInput());
  if (showingModules) moduleView?.update(detail.querySelector<HTMLElement>('.module-workspace')!, moduleInput());
  updateSourceReader();
}
/**
 * Until the first records arrive the page does not know whether it opens a run (it does whenever the account has one)
 * or the new-research page, so it keeps the run layout's connecting card instead of showing the composer for a moment.
 * A failed connection, or the reader starting a draft, settles it on the new-research page.
 */
function opening() { return !state.resumed && !state.lost && !state.composing || sampleLink && !state.lost; }
let viewSettled = false;
/** A selected run fills the workspace as one document; without one the workspace is the new-research page. */
function syncView() {
  const waiting = opening(), view = currentRun() || waiting ? 'run' : 'draft';
  const run = currentRun();
  element('#mobile-compose').setAttribute('aria-controls', run ? 'research-conversation-panel' : 'compose-panel');
  element('#mobile-compose').textContent = run ? t('原题与进展') : t('编写');
  element('#mobile-runs').textContent = run ? t('研究成果') : t('预览');
  // The page starts on the run layout; when it settles on the new-research page, a phone shows the composer.
  const settling = !waiting && !viewSettled;
  if (settling) viewSettled = true;
  if (document.body.dataset.view === view) { syncNaturalResearch(); return; }
  rememberConversationScroll();
  document.body.dataset.view = view;
  syncNaturalResearch();
  if (view === 'run') setMobileView('compose');
  if (view === 'draft' && settling) setMobileView('compose');
  restoreConversationScroll();
}
function renderDetail(force = false) {
  syncView(); syncAddress();
  renderConversation();
  const run = currentRun();
  const conversation = element('#research-conversation-panel');
  conversation.hidden = !run && researchEntry !== 'natural';
  if (sourceComparison && sourceComparison.runId !== run?.id) sourceComparison = undefined;
  if (!run) {
    collaborationView?.update();
    trajectoryView?.update();
    activityReader?.update();
    state.panelSignature = '';
    if (state.session && !opening()) renderDraftPreview();
    else if (!element('#run-detail').querySelector(':scope > .detail-connecting')) {
      const detail = element('#run-detail');
      unmountRunHeader(detail); detail.textContent = '';
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
    collaborationView?.update();
    moduleView?.update();
    finishMotion(detail);
    unmountRunHeader(detail);
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
  chatWorkspace?.observe(run);
  drawRunHeader(element('#run-detail'), {
    title: run.title, id: run.id, updated: run.updatedAt, error: state.detailError,
    status: { key: `${run.status}:${run.phase}:${value.label}`, ...value },
    stages: progress.steps.map(step => ({ label: step.label, state: step.state, clock: step.elapsed === null ? '' : formatDuration(step.elapsed),
      ...(step.id === 'solving' && run.maxRunSeconds > 0 ? { budget: formatDuration(run.maxRunSeconds * 1000) } : {}) })),
    elapsed: formatDuration(progress.elapsed), tabs: detailTabs(), tab: state.tab,
    active: activeRun(run), cancelling, deleting: state.deleting.has(run.id), connected: state.connected,
    download: run.result || !activeRun(run) ? downloadUrl(run.id) : undefined, shareable: !isSample(run) && isAcceptedRun(run) && isStatementReviewed(run) && Boolean(run.result?.proof),
    sample: isSample(run), guidanceAvailable: run.researchMode !== 'skill', ...(stalledMinutes(run) !== undefined ? { stalled: stalledMinutes(run)! } : {}),
    ...(run.formalizationId ? { formalizationId: run.formalizationId } : {}),
    ...(run.budgetOrigin && !isSample(run) ? { budgetAttempt: { run, request: api } } : {}),
    ...(run.libraryProposalOrigin && !isSample(run) ? { libraryProposalAttempt: { run, request: api } } : {}),
    // The sample's Agents were offline scripts; its recorded token counts would read as a real cost.
    ...(!isSample(run) && runTokens(run) ? { tokens: { used: formatTokens(runTokens(run)!), ...(run.maxTotalTokens ? { cap: formatTokens(run.maxTotalTokens) } : {}) } } : {}),
    ...(approvalProps(run) ? { approval: approvalProps(run)! } : {}),
    ...(run.continueFrom ? { continuation: { label: run.continueFrom.label,
      ...(state.runs.some(item => item.id === run.continueFrom!.runId) ? { runId: run.continueFrom.runId } : {}) } } : {}),
  });
}
const approvalErrors: Record<string, string> = {
  math_plan_approval_version_conflict: t('批准没有生效：你批准之前计划又改过了。请看一遍新的计划再批准。'),
  math_plan_approval_plan_unavailable: t('批准没有生效：计划还没有拟好。'),
  math_plan_approval_already_approved: t('这份计划已经批准过了。'),
  math_plan_approval_run_inactive: t('批准没有生效：运行已经结束。'),
  math_plan_approval_limit: t('批准没有生效：这次运行的批准次数已用完。'),
};
const approvalError = (reason?: string) => approvalErrors[reason ?? ''] ?? t('批准没有生效，请刷新后再试。');
/** Research pages already use this stable identity for their saved approvals, including anonymous sessions. */
function personalApprovalOwner() {
  const session = state.session;
  if (!session) return;
  if (personalApprovalIdentity?.session !== session && (!personalApprovalIdentity || !sameSession(personalApprovalIdentity.session))) {
    const identity = { session, loading: true } as NonNullable<typeof personalApprovalIdentity>;
    personalApprovalIdentity = identity;
    void api<{ authenticated: boolean; researcherId: string | null }>('/api/research/session').then(result => {
      if (personalApprovalIdentity !== identity || !sameSession(session)) return;
      if (!result.authenticated || !result.researcherId) throw new Error(tx('请重新登录后核对原批准。', 'Sign in again to check the original approval.'));
      identity.owner = result.researcherId;
    }).catch(cause => {
      if (personalApprovalIdentity === identity && sameSession(session)) identity.error = message(cause);
    }).finally(() => { if (personalApprovalIdentity === identity && sameSession(session)) { identity.loading = false; renderDetail(); } });
  }
  return personalApprovalIdentity;
}
const approvalViewKey = (owner: string, runId: string) => JSON.stringify([owner, runId]);
function resolvePersonalApproval(owner: string, run: WebRun, view: PersonalApprovalView, attempt: PersonalApprovalAttempt, receipt: WebCommandResult) {
  if (view.pending?.id !== attempt.id) return;
  const settled = personalApprovalSettled(attempt, receipt);
  view.receipt = receipt;
  if (settled) {
    if (receipt.status !== 'approved') requirePersonalApprovalReview(localStorage, owner, run.id);
    removePersonalApproval(localStorage, owner, run.id, attempt.id); view.pending = undefined;
    view.reviewRequired = receipt.status !== 'approved'; view.reviewedVersion = undefined;
    view.error = receipt.status === 'approved' ? undefined : approvalError(receipt.reason);
  } else view.error = receipt.status === 'unknown'
    ? tx('原批准结果尚未确认，请先核对这次决定。', 'The original approval is unconfirmed. Check its result before submitting another decision.')
    : undefined;
}
function personalApprovalView(owner: string, run: WebRun) {
  const key = approvalViewKey(owner, run.id);
  let view = state.approving.get(key);
  if (!view) { view = { busy: false, checked: false }; state.approving.set(key, view); }
  try {
    const original = readPersonalApproval(localStorage, owner, run.id);
    view.reviewRequired = personalApprovalNeedsReview(localStorage, owner, run.id);
    if (original && original.id !== view.pending?.id) {
      view.pending = original; view.receipt = undefined; view.checked = false; view.error = undefined; view.reviewedVersion = undefined;
    }
    view.storageError = false;
    if (view.pending) {
      const receipt = observedPersonalApproval(view.pending, run.observation);
      if (receipt) resolvePersonalApproval(owner, run, view, view.pending, receipt);
    }
  } catch {
    view.storageError = true; view.error = tx('无法读取原批准记录，请恢复浏览器存储后重新核对。', 'The original approval record could not be read. Restore browser storage and check again.');
  }
  if (view.pending && !view.checked && !view.busy && !view.storageError) {
    view.checked = true;
    queueMicrotask(() => { void checkWorkbenchApproval(run, false); });
  }
  return view;
}
/** Both entry points retain the same original command, even when the current plan has moved on. */
async function checkWorkbenchApproval(run: WebRun, retry = true) {
  const identity = personalApprovalOwner();
  if (!identity?.owner) { if (identity && !identity.loading) { personalApprovalIdentity = undefined; personalApprovalOwner(); renderDetail(); } return; }
  const owner = identity.owner, session = state.session;
  const view = personalApprovalView(owner, run), attempt = view.pending;
  if (view.busy || view.storageError || !attempt) { renderDetail(); return; }
  view.busy = true; view.error = undefined; renderDetail();
  try {
    const current = currentRun()?.id === run.id ? currentRun()! : run, pending = planAwaitingApproval(current);
    const receipt = await checkPersonalApproval({ root: `/api/runs/${encodeURIComponent(run.id)}`, attempt, request: api, retry,
      currentPlanVersion: state.connected && pending && !pending.leadRevising && current.observation?.plan?.baseVersion === pending.planVersion ? pending.planVersion : undefined,
      missing: cause => cause instanceof ApiError && cause.status === 404 });
    if (!sameSession(session) || personalApprovalIdentity !== identity) return;
    if (receipt) {
      resolvePersonalApproval(owner, current, view, attempt, receipt);
      if (receipt.observation) receiveRunObservation(receipt.observation);
    } else view.error = tx('暂未找到原批准回执；原请求和计划版本仍已保留。', 'The original receipt is not available yet. Its request and plan version are retained.');
  } catch (cause) { if (sameSession(session) && personalApprovalIdentity === identity) view.error = message(cause); }
  finally { view.busy = false; if (sameSession(session) && personalApprovalIdentity === identity) renderDetail(); }
}
/** The banner also stays available to reconcile an older decision after the current plan changes. */
function approvalProps(run: WebRun): RunHeaderProps['approval'] {
  if (run.researchMode === 'skill') return;
  const approval = planAwaitingApproval(run), observation = run.observation;
  if (!observation || isSample(run) || !approval && !run.planApproval && !observation.inspection.planApproval?.required) return;
  const identity = personalApprovalOwner(), view = identity?.owner ? personalApprovalView(identity.owner, run) : undefined;
  if (!approval && !view?.pending) return;
  const needsReview = Boolean(view?.reviewRequired || view?.reviewedVersion && view.reviewedVersion !== approval?.planVersion);
  const error = identity?.error ?? view?.error;
  return { tasks: observation.inspection.tasks.length, revising: approval?.leadRevising ?? false,
    busy: !identity?.owner || Boolean(view?.pending || view?.storageError || needsReview || view?.busy), checking: identity?.loading || view?.busy,
    reviewable: Boolean(approval && observation.plan && observation.plan.baseVersion === approval.planVersion && observation.plan.baseVersion === observation.inspection.planVersion),
    ...(error ? { error } : {}), ...(view?.pending ? { original: { ...view.pending, ...(view.receipt ? { status: view.receipt.status } : {}) } } : {}),
    ...(view?.pending || view?.storageError || identity?.error ? { onCheck: () => { void checkWorkbenchApproval(run); } } : {}),
    ...(needsReview && !view?.pending && !view?.storageError && approval ? { onReviewCurrent: () => {
      try { completePersonalApprovalReview(localStorage, identity!.owner!, run.id); view!.reviewRequired = false; view!.reviewedVersion = approval.planVersion; view!.error = undefined; }
      catch { view!.storageError = true; view!.error = tx('未能保存核对结果，请恢复浏览器存储后再试。', 'Your review could not be saved. Restore browser storage and check again.'); }
      renderDetail();
    } } : {}) };
}
/** Persist before sending; a failed response can only be reconciled under this original identity. */
async function approvePlan(run: WebRun) {
  const identity = personalApprovalOwner(), owner = identity?.owner, session = state.session;
  if (!owner) return;
  const pending = planAwaitingApproval(run), planVersion = run.observation?.inspection.planVersion, view = personalApprovalView(owner, run);
  if (!state.connected || !pending || pending.leadRevising || !planVersion || view.busy || view.pending || view.storageError || view.reviewRequired
    || view.reviewedVersion && view.reviewedVersion !== planVersion || run.observation?.plan?.baseVersion !== planVersion || pending.planVersion !== planVersion) return;
  const attempt = { id: commandId(), planVersion };
  try { savePersonalApproval(localStorage, owner, run.id, attempt); }
  catch { view.storageError = true; view.error = tx('无法保存批准记录，本次尚未发送。请恢复浏览器存储后再试。', 'The approval record could not be saved, so nothing was sent. Restore browser storage and try again.'); renderDetail(); return; }
  view.pending = attempt; view.checked = true; view.busy = true; view.error = undefined; view.receipt = undefined; renderDetail();
  try {
    const { receipt } = await api<{ receipt: WebCommandResult }>(`/api/runs/${encodeURIComponent(run.id)}/plan-approval`, { method: 'POST', body: JSON.stringify(attempt) });
    if (!sameSession(session) || personalApprovalIdentity !== identity) return;
    resolvePersonalApproval(owner, run, view, attempt, receipt);
    if (receipt.observation) receiveRunObservation(receipt.observation);
    if (receipt.status === 'queued') toast(t('批准已提交，运行确认后 Agent 就开始工作'));
  } catch (cause) { if (sameSession(session) && personalApprovalIdentity === identity) view.error = message(cause); }
  finally { view.busy = false; if (sameSession(session) && personalApprovalIdentity === identity) renderDetail(); }
}
/** Opens the guidance composer in the collaboration tab, optionally with a line of text added to its draft. */
function closeProofViewer() {
  state.proofViewer = ''; renderPanel(true);
  document.querySelector<HTMLElement>('#detail-panel [data-action="view-proof"]')?.focus({ preventScroll: true });
}
function openGuidance(run: WebRun, text?: string, notice?: string, taskId?: string) {
  state.tab = 'collaboration'; setMobileView('runs'); renderDetail(true);
  if (!collaborationView?.guide(run.id, text, notice, taskId)) element('#detail-tab-collaboration').focus({ preventScroll: true });
}
function openCollaborationSection(run: WebRun, section: CollaborationSection, taskId?: string) {
  state.tab = 'collaboration'; setMobileView('runs'); renderDetail(true);
  const shown = section === 'reviews' ? collaborationView?.showStatementReview(run.id, taskId) : collaborationView?.showSection(run.id, section);
  if (!shown) element('#detail-tab-collaboration').focus({ preventScroll: true });
}
/** How the next address change is recorded: a run the reader chose adds a history entry, anything automatic replaces it. */
let addressMode: 'push' | 'replace' = 'replace';
function syncAddress() {
  const mode = addressMode; addressMode = 'replace';
  // Until the first list arrives the selection is not known yet, and a ?run= or ?sample link must survive until it is.
  if (!state.resumed || sampleLink || formalizationLink || linkedLibraryReference || linkedProblemDraft || chatWorkspace?.id || chatWorkspace?.editingProblem
    || (new URLSearchParams(location.search).has('chat') || readEditedProblemId(new URLSearchParams(location.search))) && !chatWorkspace) return;
  const run = currentRun(), search = withAddressLanguage(!run ? '' : isSample(run) ? sampleAddress : `?run=${encodeURIComponent(run.id)}`);
  if (location.search === search) return;
  history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', location.pathname + search + location.hash);
}
function selectRun(id: string, closeHistory = true, address: 'push' | 'replace' = 'push') {
  if (!state.runs.some(run => run.id === id)) return;
  // Opened deliberately (not browsed with the arrow keys or Back), another run's document is set down in place of the last.
  const switching = address === 'push' && (id !== state.selectedId || state.composing);
  addressMode = address;
  state.composing = false;
  state.selectedId = id; state.selectedRun = state.runs.find(run => run.id === id);
  saveResume(() => localStorage, { selectedId: id, seenAt: new Date().toISOString() });
  state.tab = 'result'; state.sourceView = 'proof'; state.reportMode = 'summary'; state.detailError = ''; state.panelSignature = '';
  state.diffChange = 0; state.compare = undefined;
  renderRunList(); renderDetail(true);
  if (closeHistory) closeHistoryDialog();
  if (switching) setMobileView('compose');
  // Phones move between their own views.
  if (switching && !historyQuery.matches) animateEntrance(element('#run-detail'), 'panel', true);
}
/** The server names templates, environments and the sample in Chinese; known names are shown in the interface language. */
function localizeSession(session: WebSession): WebSession {
  return { ...session,
    environments: session.environments.map(environment => ({ ...environment, name: localizeText(environment.name), description: localizeText(environment.description) })),
    templates: session.templates.map(template => ({ ...template, name: localizeText(template.name), task: localizeText(template.task) })),
    ...(session.sample ? { sample: { ...session.sample, title: localizeText(session.sample.title) } } : {}) };
}
/** Opens the recorded sample run; it needs no API key and does not change the saved position in the user's own runs. */
async function openSample(address: 'push' | 'replace' = 'push') {
  const sample = state.session?.sample;
  if (!sample) return;
  if (!state.sample) {
    const before = [state.selectedId, state.composing];
    try {
      const run = (await api<{ run: WebRun }>(`/api/runs/${encodeURIComponent(sample.id)}`))?.run;
      state.sample = run && { ...run, title: localizeText(run.title), task: localizeText(run.task), model: localizeText(run.model) };
    }
    catch (error) { toast(t('无法打开示例运行：{0}', message(error))); return; }
    // An address the page followed by itself gives way to whatever the reader opened meanwhile.
    if (!state.sample || address === 'replace' && (before[0] !== state.selectedId || before[1] !== state.composing)) return;
  }
  state.composing = false; addressMode = address;
  state.selectedId = sample.id; state.selectedRun = state.sample;
  state.tab = 'result'; state.sourceView = 'proof'; state.reportMode = 'summary'; state.detailError = ''; state.panelSignature = '';
  state.diffChange = 0; state.compare = undefined;
  renderRunList(); renderDetail(true); renderShell();
  closeHistoryDialog(); setMobileView('compose');
}
function startDraft(reset = false, address: 'push' | 'replace' = 'push') {
  chatWorkspace?.home(false);
  const leaving = !state.composing;
  state.composing = true; addressMode = address;
  state.selectedId = ''; state.selectedRun = undefined;
  state.tab = 'source'; state.sourceView = 'proof'; state.detailError = '';
  state.draftView = 'source';
  document.body.dataset.draftPreview = 'false';
  element('#open-draft-preview').setAttribute('aria-expanded', 'false');
  moduleView?.update(undefined, moduleInput());
  state.panelSignature = ''; draftPreviewSignature = '';
  if (reset) { if (state.session) resetProblemDraftBinding(ownerOfSession(state.session), 'lean'); submissionIdentity.clear(); resetForm(); }
  renderRunList(); renderDetail(true); setMobileView('compose');
  if (leaving && !historyQuery.matches) animateEntrance(element('.workspace'), 'workspace');
}
async function openFormalizedDraft(id: string) {
  const revision = draftRevision;
  try {
    const { formalization } = await api<{ formalization: WebFormalization }>(`/api/formalizations/${encodeURIComponent(id)}`);
    if (formalization.status !== 'confirmed' || !formalization.report) throw new Error(t('请先审阅并确认这份形式化原题。'));
    if (draftRevision !== revision) throw new Error(t('草稿已变化，未载入形式化原题。请从形式化页面重新打开。'));
    const report = formalization.report;
    const draft: TaskDraft = { ...captureDraft(), source: report.statement, environment: report.environment, templateId: '',
      problemBudget: undefined, sharedProofOrigin: undefined, classicOrigin: undefined, libraryProposalOrigin: undefined,
      task: t('证明已确认原题中的全部目标，保留所有定义、假设与声明。'),
      formalization: { id: formalization.id, evidenceSha256: report.evidenceSha256 } };
    delete draft.continueFrom;
    replaceDraft('import', () => applyTaskDraft(draft));
    chooseEntry('lean');
    formalizationLink = null;
    startDraft(false, 'replace'); saveDraft(); renderDraftRecovery();
    toast(t('已载入确认后的 Lean 原题，配置模型后即可开始证明。'));
  } catch (error) {
    formalizationLink = null;
    toast(message(error));
  }
}
async function openLibraryProposalDraft() {
  const feedbackId = productTarget.get('libraryProposal'), projectId = productTarget.get('project');
  if (libraryProposalHandled || !feedbackId || !projectId || !/^[A-Za-z0-9_-]{1,128}$/u.test(feedbackId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(projectId)) return;
  libraryProposalHandled = true;
  const panel = document.createElement('aside'); panel.className = 'composer-research-selection'; panel.dataset.libraryProposalStart = '';
  const notice = document.createElement('p'); notice.setAttribute('role', 'status');
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button'; retry.hidden = true;
  retry.textContent = t('重新准备候选草稿'); retry.dataset.retryLibraryProposal = '';
  const back = document.createElement('a'); back.href = `theorems.html?id=${encodeURIComponent(projectId)}#feedback-${encodeURIComponent(feedbackId)}`;
  back.textContent = t('查看已评审的任务提案'); panel.append(notice, retry, back); element('#run-form').prepend(panel);
  const prepare = async () => {
    if (!state.session || state.submitting) return;
    const owner = ownerOfSession(state.session), revision = draftRevision;
    retry.disabled = true; retry.hidden = true; notice.textContent = t('正在准备候选与固定库版本…');
    try {
      const { item } = await api<{ item: ResearchLibraryAttemptPreparation }>(`/api/research/theorems/${encodeURIComponent(projectId)}/library-proposals/${encodeURIComponent(feedbackId)}/prepare`);
      const selected = await researchSelection.prepare(item.refs, item.environment);
      if (!state.session || ownerOfSession(state.session) !== owner || draftRevision !== revision || state.submitting)
        throw new Error(t('草稿已变化，未载入候选。请核对后重新准备。'));
      const draft: TaskDraft = { ...captureDraft(), source: item.source, task: item.task, environment: item.environment,
        templateId: '', modulePlan: item.modulePlan, formalization: undefined, continueFrom: undefined, problemBudget: undefined,
        sharedProofOrigin: undefined, classicOrigin: undefined,
        libraryProposalOrigin: { projectId, feedbackId, trialDigest: item.trialDigest } };
      const contentIssue = submissionIssues(draft, field('api-key').value, state.session).find(issue => issue.field === 'source' || issue.field === 'task');
      if (contentIssue) throw new Error(contentIssue.message);
      replaceDraft('reuse', () => applyTaskDraft(draft, selected.configuration.environment));
      researchSelection.adopt(selected);
      chooseEntry('lean'); startDraft(false, 'replace'); draftChanged(); saveDraft(); renderDraftRecovery();
      notice.textContent = t('候选与固定库版本已载入。核对源码、模型和预算后即可开始研究。');
      panel.dataset.libraryProposalReady = 'true';
      panel.remove();
    } catch (error) { notice.textContent = message(error); retry.hidden = false; }
    finally { retry.disabled = false; }
  };
  retry.addEventListener('click', () => void prepare());
  await prepare();
}
function renderLibraryProposalOrigin() {
  let panel = document.querySelector<HTMLElement>('[data-library-proposal-origin]');
  const origin = draftLibraryProposalOrigin;
  if (!origin) { panel?.remove(); libraryProposalOriginRead = undefined; return; }
  const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
  if (!panel) {
    panel = document.createElement('aside'); panel.className = 'composer-research-selection'; panel.dataset.libraryProposalOrigin = '';
    element('#run-form').prepend(panel);
  }
  const key = JSON.stringify([state.session && ownerOfSession(state.session), origin]);
  if (libraryProposalOriginRead?.key !== key) {
    const read = libraryProposalOriginRead = { key, status: 'loading' };
    void api<{ item: ResearchLibraryAttemptPreparation }>(`/api/research/theorems/${encodeURIComponent(origin.projectId)}/library-proposals/${encodeURIComponent(origin.feedbackId)}/prepare`)
      .then(({ item }) => {
        if (libraryProposalOriginRead !== read) return;
        libraryProposalOriginRead = { key, status: item.trialDigest === origin.trialDigest ? 'available' : 'unavailable' }; renderLibraryProposalOrigin();
      }).catch(() => {
        if (libraryProposalOriginRead !== read) return;
        libraryProposalOriginRead = { key, status: 'unavailable' }; renderLibraryProposalOrigin();
      });
  }
  panel.replaceChildren(); panel.dataset.libraryProposalOriginStatus = libraryProposalOriginRead.status;
  panel.dataset.libraryProposalReady = String(libraryProposalOriginRead.status === 'available');
  const text = document.createElement('p');
  text.textContent = tx('来自已评审的 Library 候选。草稿可继续修改，新尝试会重新检查。', 'Prepared from a reviewed Library candidate. You can edit this draft; the new attempt will be checked again.'); panel.append(text);
  if (libraryProposalOriginRead.status === 'available') {
    const back = document.createElement('a'); back.href = `theorems.html?id=${encodeURIComponent(origin.projectId)}#feedback-${encodeURIComponent(origin.feedbackId)}`;
    back.textContent = tx('查看来源提案', 'View the source proposal'); panel.append(back);
  } else {
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    status.textContent = libraryProposalOriginRead.status === 'loading' ? tx('正在核对提案来源…', 'Checking the source proposal…')
      : tx('暂时无法打开来源提案，草稿已保留。重试核对后再提交，或另起个人研究。', 'The source proposal is unavailable. Your draft is preserved. Retry the check before submitting, or start an independent personal study.'); panel.append(status);
    if (libraryProposalOriginRead.status === 'unavailable') {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'text-button'; retry.dataset.retryLibraryProposalOrigin = '';
      retry.textContent = tx('重新核对提案来源', 'Check the source proposal again');
      retry.addEventListener('click', () => { libraryProposalOriginRead = undefined; renderLibraryProposalOrigin(); }); panel.append(retry);
    }
  }
  const detach = document.createElement('button'); detach.type = 'button'; detach.className = 'text-button'; detach.dataset.detachLibraryProposalOrigin = '';
  detach.textContent = tx('另起独立个人研究', 'Start an independent personal study');
  detach.addEventListener('click', () => { if (state.submitting) return; draftLibraryProposalOrigin = undefined; renderLibraryProposalOrigin(); draftChanged(); saveDraft(); }); panel.append(detach);
}
function renderSharedProofOrigin() {
  let panel = document.querySelector<HTMLElement>('[data-shared-proof-origin]');
  const origin = draftSharedProofOrigin;
  if (!origin) { panel?.remove(); sharedProofOriginRead = undefined; return; }
  const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
  if (!panel) {
    panel = document.createElement('aside'); panel.className = 'composer-research-selection';
    panel.dataset.sharedProofOrigin = ''; element('#run-form').prepend(panel);
  }
  const notice = document.createElement('p');
  notice.textContent = t('已载入「{0}」的原题。核对模型与预算后开始自己的研究，结果会重新检查。', origin.title);
  const key = JSON.stringify([state.session && ownerOfSession(state.session), origin.readingId, origin.digest]);
  if (sharedProofOriginRead?.key !== key) {
    const reading = sharedProofOriginRead = { key, status: 'loading' };
    void api<{ item: SharedProofReading }>(`/api/research/shared-proofs/${encodeURIComponent(origin.readingId)}`).then(({ item }) => {
      if (sharedProofOriginRead !== reading) return;
      sharedProofOriginRead = { key, status: item.digest === origin.digest ? 'available' : 'unavailable' }; renderSharedProofOrigin();
    }).catch(() => {
      if (sharedProofOriginRead !== reading) return;
      sharedProofOriginRead = { key, status: 'unavailable' }; renderSharedProofOrigin();
    });
  }
  panel.replaceChildren(notice);
  panel.dataset.sharedProofReady = String(sharedProofOriginRead.status !== 'loading');
  panel.dataset.sharedProofStatus = sharedProofOriginRead.status;
  if (sharedProofOriginRead.status === 'available') {
    const source = document.createElement('a'); source.href = `share.html?${new URLSearchParams({ reading: origin.readingId, lang: locale })}`;
    source.textContent = t('查看来源证明'); panel.append(source);
  } else {
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    status.textContent = sharedProofOriginRead.status === 'loading' ? tx('正在核对来源证明…', 'Checking the source proof…')
      : tx('暂时无法打开来源证明，已保存的原题仍可继续编辑。', 'The source proof is unavailable. You can continue editing your saved problem.');
    panel.append(status);
    if (sharedProofOriginRead.status === 'unavailable') {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'text-button'; retry.dataset.retrySharedProofOrigin = '';
      retry.textContent = tx('重新核对来源', 'Check the source again'); retry.addEventListener('click', () => { sharedProofOriginRead = undefined; renderSharedProofOrigin(); }); panel.append(retry);
    }
  }
}
async function openSharedProofDraft() {
  const id = productTarget.get('sharedDraft');
  if (sharedDraftHandled || !id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)) return;
  sharedDraftHandled = true;
  const panel = document.createElement('aside'); panel.className = 'composer-research-selection'; panel.dataset.sharedProofStart = '';
  const notice = document.createElement('p'); notice.setAttribute('role', 'status');
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button'; retry.hidden = true;
  retry.textContent = t('重新读取分享研究草稿');
  panel.append(notice, retry); element('#run-form').prepend(panel);
  const prepare = async () => {
    if (!state.session || state.submitting) return;
    const owner = ownerOfSession(state.session), revision = draftRevision;
    retry.disabled = true; retry.hidden = true; notice.textContent = t('正在读取分享的原题…');
    try {
      const { item } = await api<{ item: SharedProofPreparation }>(`/api/research/shared-proofs/preparations/${encodeURIComponent(id)}`);
      if (!state.session || ownerOfSession(state.session) !== owner || draftRevision !== revision || state.submitting)
        throw new Error(t('草稿已变化，未载入分享原题。请核对后重新读取。'));
      const draft: TaskDraft = { ...captureDraft(), source: item.source, task: item.task, environment: item.environment,
        templateId: '', modulePlan: undefined, knowledgeDigest: undefined, formalization: undefined, continueFrom: undefined, problemBudget: undefined,
        libraryProposalOrigin: undefined, classicOrigin: undefined,
        sharedProofOrigin: { readingId: item.origin.readingId, title: item.origin.title, digest: item.origin.digest } };
      const contentIssue = submissionIssues(draft, field('api-key').value, state.session).find(issue => issue.field === 'source' || issue.field === 'task');
      if (contentIssue) throw new Error(contentIssue.message);
      replaceDraft('reuse', () => applyTaskDraft(draft)); researchSelection.clear(); formalizationLink = null;
      chooseEntry('lean'); startDraft(false, 'replace'); draftChanged(); saveDraft(); renderDraftRecovery();
      panel.remove();
      // A refresh restores the edited draft; it must not import the original a second time.
      const cleaned = new URL(location.href); cleaned.searchParams.delete('sharedDraft'); history.replaceState(null, '', cleaned);
    } catch (error) { notice.textContent = message(error); retry.hidden = false; }
    finally { retry.disabled = false; }
  };
  retry.addEventListener('click', () => void prepare()); await prepare();
}
function showClassicOrigin() {
  const id = readClassicId(new URLSearchParams(location.search)) ?? draftClassicOrigin?.id;
  if (!id || !state.session) return;
  const existing = document.querySelector<HTMLElement>('[data-classic-origin]');
  if (existing?.dataset.classicOrigin === id) return;
  existing?.remove();
  const owner = ownerOfSession(state.session), tx = (zh: string, en: string) => locale === 'en' ? en : zh;
  const panel = document.createElement('aside'); panel.className = 'composer-research-selection'; panel.dataset.classicOrigin = '';
  panel.dataset.classicOrigin = id;
  const heading = document.createElement('strong'); heading.textContent = draftClassicOrigin?.id === id ? draftClassicOrigin.title : tx('从经典题开始研究', 'Start research from a classic problem');
  const text = document.createElement('p'); text.setAttribute('role', 'status'); text.textContent = tx('正在读取原题…', 'Loading the original problem…');
  const back = document.createElement('a'); back.href = `classics/${locale === 'en' ? 'en/' : ''}archive.html#${new URLSearchParams({ proof: id, tab: 'process' })}`;
  back.textContent = t('返回来源题目');
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'text-button'; retry.hidden = true;
  retry.textContent = tx('重新读取原题', 'Load the original problem again');
  panel.append(heading, text, back, retry); element('.workbench').before(panel);
  const load = async () => {
    retry.hidden = true; retry.disabled = true;
    try {
      const prepared = await loadClassicPreparation(id, locale);
      if (!panel.isConnected || !state.session || ownerOfSession(state.session) !== owner) return;
      heading.textContent = prepared.origin.title;
      const applied = draftClassicOrigin?.id === id;
      panel.dataset.classicReady = String(applied);
      text.textContent = applied ? tx('原题草稿已保留。核对模型与预算后开始研究。', 'Your problem draft is saved. Review the model and budget before starting research.') : prepared.summary;
      const preview = document.createElement('details'); preview.dataset.classicPreview = '';
      const summary = document.createElement('summary'); summary.textContent = tx('预览原题与 Lean 声明', 'Preview the original problem and Lean statements');
      const source = document.createElement('pre'); source.className = 'classic-preparation-source'; source.textContent = prepared.source;
      const note = document.createElement('p'); note.textContent = tx('载入后可编辑，当前 Lean 草稿可撤销恢复。', 'You can edit after loading. Your current Lean draft can be restored with Undo.');
      const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'button'; confirm.dataset.classicConfirm = '';
      confirm.textContent = applied ? tx('重新载入原题草稿', 'Reload the original problem into a draft') : tx('载入原题草稿', 'Load the original problem into a draft');
      confirm.addEventListener('click', () => {
        if (!state.session || ownerOfSession(state.session) !== owner || state.submitting) return;
        const draft: TaskDraft = { ...captureDraft(), source: prepared.source, task: prepared.task, environment: 'mathlib',
          templateId: '', modulePlan: undefined, knowledgeDigest: undefined, formalization: undefined, continueFrom: undefined,
          problemBudget: undefined, sharedProofOrigin: undefined, libraryProposalOrigin: undefined, classicOrigin: prepared.origin };
        replaceDraft('reuse', () => applyTaskDraft(draft)); researchSelection.clear(); formalizationLink = null;
        chooseEntry('lean'); startDraft(false, 'replace'); draftChanged(); saveDraft(); renderDraftRecovery();
      });
      preview.append(summary, source, note, confirm); panel.append(preview);
    } catch (error) {
      if (panel.isConnected) { text.textContent = message(error); retry.hidden = false; }
    } finally { retry.disabled = false; }
  };
  retry.addEventListener('click', () => void load()); void load();
}
async function openRecoveryEntry() {
  const id = productTarget.get('run'), action = productTarget.get('recovery');
  if (recoveryEntryHandled || !id || !action || !/^(?:continue-checked|ask-failed|key|retry|budget|tokens|turns|workers|source|task)$/u.test(action)) return;
  await naturalPage;
  const run = currentRun();
  if (!run || run.id !== id || isSample(run) || !state.runs.some(item => item.id === id)) return;
  recoveryEntryHandled = true;
  const cleaned = new URL(location.href); cleaned.searchParams.delete('recovery'); history.replaceState(null, '', cleaned);
  if (!nextSteps(run, summarizeGoals(run)).some(item => item.id === action)) { toast(t('研究状态已更新，请查看当前可用的后续操作。')); return; }
  const button = document.createElement('button'); await recoverRun(run, action, button);
}
async function openLibraryPersonalAttemptDraft() {
  const trialId = productTarget.get('libraryTrial'), digest = productTarget.get('trialDigest');
  if (libraryTrialHandled || !trialId || !/^[A-Za-z0-9_-]{1,128}$/u.test(trialId) || !digest || !/^[a-f0-9]{64}$/u.test(digest)) return;
  libraryTrialHandled = true;
  const panel = document.createElement('aside'); panel.className = 'composer-research-selection'; panel.dataset.libraryTrialStart = '';
  const notice = document.createElement('p'); notice.setAttribute('role', 'status');
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button'; retry.hidden = true;
  retry.textContent = t('重新准备试用草稿'); retry.dataset.retryLibraryTrial = '';
  const back = document.createElement('a'); back.href = `workspace.html?tab=trials&trial=${encodeURIComponent(trialId)}`;
  back.textContent = t('查看这次试用的固定记录'); panel.append(notice, retry, back); element('#run-form').prepend(panel);
  const prepare = async () => {
    if (!state.session || state.submitting) return;
    const owner = ownerOfSession(state.session), revision = draftRevision;
    retry.disabled = true; retry.hidden = true; notice.textContent = t('正在准备候选与固定库版本…');
    try {
      const { item } = await api<{ item: ResearchLibraryPersonalAttemptPreparation }>(`/api/research/library-trials/${encodeURIComponent(trialId)}/prepare-attempt?digest=${encodeURIComponent(digest)}`);
      const selected = await researchSelection.prepare(item.refs, item.environment);
      if (!state.session || ownerOfSession(state.session) !== owner || draftRevision !== revision || state.submitting)
        throw new Error(t('草稿已变化，未载入候选。请核对后重新准备。'));
      const draft: TaskDraft = { ...captureDraft(), source: item.source, task: item.task, environment: item.environment,
        templateId: '', modulePlan: item.modulePlan, formalization: undefined, continueFrom: undefined, problemBudget: undefined,
        libraryProposalOrigin: undefined, sharedProofOrigin: undefined, classicOrigin: undefined };
      const contentIssue = submissionIssues(draft, field('api-key').value, state.session).find(issue => issue.field === 'source' || issue.field === 'task');
      if (contentIssue) throw new Error(contentIssue.message);
      replaceDraft('reuse', () => applyTaskDraft(draft, selected.configuration.environment));
      researchSelection.adopt(selected); formalizationLink = null;
      chooseEntry('lean'); startDraft(false, 'replace'); draftChanged(); saveDraft(); renderDraftRecovery();
      notice.textContent = t('候选与固定库已载入新尝试草稿。核对模型和预算后，再发送研究任务；原题验收会重新进行。');
      panel.dataset.libraryTrialReady = 'true';
    } catch (error) { notice.textContent = message(error); retry.hidden = false; }
    finally { retry.disabled = false; }
  };
  retry.addEventListener('click', () => void prepare()); await prepare();
}
async function openBudgetAttemptDraft() {
  const runId = productTarget.get('budgetRun'), projectId = productTarget.get('project') ?? undefined, tokens = Number(productTarget.get('budgetTokens'));
  if (budgetDraftHandled || !runId || !runIdPattern.test(runId) || !Number.isSafeInteger(tokens) || tokens < 10_000 || tokens > 1e12) return;
  budgetDraftHandled = true;
  const panel = document.createElement('aside'); panel.className = 'composer-research-selection'; panel.dataset.budgetAttemptStart = '';
  const notice = document.createElement('p'); notice.setAttribute('role', 'status');
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button'; retry.hidden = true;
  retry.textContent = t('重新准备预算草稿'); panel.append(notice, retry); element('#run-form').prepend(panel);
  const prepare = async () => {
    if (!state.session || state.submitting) return;
    const owner = ownerOfSession(state.session), revision = draftRevision;
    retry.disabled = true; retry.hidden = true; notice.textContent = t('正在读取原题与预算…');
    try {
      if (tokens > state.session.limits.maxTotalTokens) throw new Error(t('规划的 Token 超过本次运行上限，请返回题目页调整。'));
      await api(`/api/research/workspace/problem/${encodeURIComponent(runId)}/budget${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`);
      let run: WebRun, own = true;
      try { run = (await api<{ run: WebRun }>(`/api/runs/${encodeURIComponent(runId)}`)).run; }
      catch (error) {
        if (!projectId || !(error instanceof ApiError) || ![403, 404].includes(error.status)) throw error;
        own = false;
        const result = await api<{ run?: WebRun }>(`/api/research/theorems/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`);
        if (!result.run) throw new Error(t('研究记录不存在或不属于当前会话。'));
        run = { ...result.run, formalization: undefined, formalizationId: undefined };
      }
      const configuration = own ? run.researchConfiguration : undefined;
      const refs = configuration ? [configuration.agent?.ref, ...configuration.skills.map(item => item.ref), ...configuration.libraries.map(item => item.ref)].filter(item => item !== undefined) : [];
      const selected = refs.length ? await researchSelection.prepare(refs, run.environment) : undefined;
      if (!state.session || ownerOfSession(state.session) !== owner || draftRevision !== revision || state.submitting)
        throw new Error(t('草稿已变化，未载入预算规划。请核对后重新准备。'));
      const issue = submissionIssues({ ...captureDraft(), source: run.source, task: run.task }, '', state.session).find(issue => issue.field === 'source' || issue.field === 'task');
      if (issue) throw new Error(issue.message);
      applyReusedRun(run);
      if (selected) researchSelection.adopt(selected); else researchSelection.clear();
      budgetDraftOrigin = { runId, projectId, source: run.source, environment: run.environment };
      field('max-tokens').value = String(tokens / 10_000);
      draftChanged(); saveDraft(); renderDraftRecovery();
      notice.textContent = projectId ? t('已将项目原题准备为个人尝试。核对模型、Library 和预算后可开始，随后可将新运行关联到项目。')
        : t('已准备原题、执行配置与本次预算。核对后即可发送研究任务。');
      panel.dataset.budgetAttemptReady = 'true';
    } catch (error) { notice.textContent = message(error); retry.hidden = false; }
    finally { retry.disabled = false; }
  };
  retry.addEventListener('click', () => void prepare()); await prepare();
}
const currentConnection = (epoch: number) => pageActive && epoch === state.connectionEpoch;
const sessionFailure = (error: unknown) => error instanceof ApiError
  && (error.status === 401 || error.status === 403 && error.reason.includes('会话校验'));
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
  state.connected = false; state.lost = true;
  runUpdates.stop();
  liveRefreshPending = false;
  setGlobalNotice(text);
  element('#runs-error').textContent = t('连接中断，记录可能不是最新状态');
  element('#runs-error').hidden = false;
  renderRuntime(); renderDetail();
}
function receiveRunObservation(observation: WebObservation) {
  const previous = state.runs.find(run => run.id === observation.webRunId);
  const solverRunId = previous?.solverAttempt?.solverRunId ?? previous?.observation?.solverRunId;
  if (!previous || solverRunId && solverRunId !== observation.solverRunId ||
    previous.solverAttempt && observation.sequence < previous.solverAttempt.sequence ||
    previous.observation && previous.observation.sequence >= observation.sequence) return;
  const run = { ...previous, observation,
    updatedAt: previous.updatedAt > observation.observedAt ? previous.updatedAt : observation.observedAt };
  state.runs = state.runs.map(item => item.id === run.id ? run : item);
  if (state.selectedId === run.id) state.selectedRun = run;
  // This observation may be the first to show the plan waiting; the next list read compares against it.
  for (const waiting of newlyWaiting([previous], [run])) announceWaiting(waiting);
  renderRunList(); renderDetail();
}
/** `listed` is the list the session reply carried (first connection); without it the list is read, as a 304 when unchanged. */
async function refreshRuns(epoch: number, force = false, listed?: WebSession['runs']) {
  const generation = ++state.listGeneration;
  let etag: string | null = listed?.version ?? null;
  const result = listed ?? await api<{ runs: WebRun[] }>('/api/runs', {
    headers: !force && state.runsEtag ? { 'If-None-Match': state.runsEtag } : {},
  }, value => { etag = value; });
  if (generation !== state.listGeneration || !currentConnection(epoch)) return;
  state.runsEtag = etag ?? '';
  element('#runs-error').hidden = true;
  if (!result) return;
  const previous = state.runs;
  const byId = new Map(previous.map(run => [run.id, run]));
  state.runs = result.runs.map(run => retainLatestRun(run, byId.get(run.id))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // The first list is the history as it stands; only later ones bring arrivals.
  if (state.resumed) for (const run of state.runs) if (!byId.has(run.id)) arrivals.add(run.id);
  const resume = state.resumed ? undefined : readResume(() => localStorage);
  if (!state.resumed && !state.composing && !state.selectedId && resume && state.runs.some(run => run.id === resume.selectedId)) {
    state.selectedId = resume.selectedId;
    state.tab = 'result'; state.sourceView = 'proof'; state.reportMode = 'summary'; state.panelSignature = '';
  }
  if (!state.composing && !sampleSelected() && (!state.selectedId || !state.runs.some(run => run.id === state.selectedId))) {
    state.selectedId = state.runs[0]?.id ?? '';
    state.tab = 'result'; state.sourceView = 'proof'; state.reportMode = 'summary'; state.panelSignature = '';
  }
  state.selectedRun = sampleSelected() ? state.sample : state.runs.find(run => run.id === state.selectedId);
  // A run deleted elsewhere, or whose DELETE response was lost, leaves the list here.
  if (chatWorkspace?.runId && byId.has(chatWorkspace.runId)) leaveDeletedChat(chatWorkspace.runId);
  rememberFinishedRuns(previous);
  for (const run of newlyFinished(previous, state.runs)) announceFinished(run);
  for (const run of newlyWaiting(previous, state.runs)) announceWaiting(run);
  if (!state.resumed) {
    state.resumed = true;
    const away = resume ? finishedSince(state.runs, resume.seenAt) : [];
    for (const run of away) if (run.id !== state.selectedId) state.finishedRuns.add(run.id);
    // A ?run= address for a record this account does not have (deleted, or someone else's) opens the latest one instead.
    if (linkedRun && !state.runs.some(run => run.id === linkedRun)) toast(t('没有找到链接里的研究记录'));
    else if (away.length) toast(away.length === 1 ? t('离开期间「{0}」已结束', away[0].title) : t('离开期间有 {0} 项研究已结束', away.length));
    // Until the sample has loaded, the page shows the run below it and keeps the sample's address.
    if (sampleLink && state.session?.sample) void openSample('replace').finally(() => { sampleLink = false; renderDetail(); });
    else sampleLink = false;
  }
  // Nothing to resume until the account has a run; an empty history leaves storage untouched.
  // The sample is not a run to come back to; keep the last real selection but still record when the user was here.
  if (state.runs.length) saveResume(() => localStorage, { selectedId: sampleSelected() ? readResume(() => localStorage)?.selectedId ?? state.runs[0].id : state.selectedId, seenAt: new Date().toISOString() });
  state.detailError = '';
  element('#runs-error').hidden = true;
  renderRunList(); renderDetail(); renderDeleteState(); renderCancelState(); renderBudgetEstimate();
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
      // The first connection takes the run list in the session reply, one round trip instead of two. A reconnect may bring
      // another session (and account), and reads the list itself, as a 304 when nothing changed.
      const { runs: listed, ...reply } = await api<WebSession>(state.session ? '/api/session' : '/api/session?runs');
      const session = localizeSession(reply);
      if (!currentConnection(epoch)) return;
      if (session.auth === 'email' && (!session.account || session.termsRequired)) {
        saveDraft(); draftReady = false; forgetKey(keyStorage);
        location.replace(loginAddress()); return;
      }
      const ownerChanged = Boolean(state.session && ownerOfSession(state.session) !== ownerOfSession(session));
      const firstLoad = !state.session || ownerChanged;
      let storedOwnerChanged = false;
      if (!state.session) {
        try { storedOwnerChanged = sessionStorage.getItem(draftOwnerStorageKey) !== ownerOfSession(session); }
        catch { /* Unavailable storage cannot restore a previous owner's draft. */ }
        // Only the signed-in account's former email scope identifies an owner; old anonymous keys are unbound.
        if (session.account && !storedOwnerChanged) try {
          const previous = session.account.email, owner = ownerOfSession(session);
          for (const key of Object.keys(sessionStorage)) {
            const prefix = ['theorem-os.chat-draft.', 'theorem-os.chat-reading.'].find(value => key.startsWith(`${value}${previous}.`));
            const target = prefix ? `${prefix}${owner}.${key.slice(`${prefix}${previous}.`.length)}`
              : key === `theorem-os.chat-submission.v1.${previous}` ? `theorem-os.chat-submission.v1.${owner}` : undefined;
            if (target && target !== key) {
              if (sessionStorage.getItem(target) === null) sessionStorage.setItem(target, sessionStorage.getItem(key)!);
              sessionStorage.removeItem(key);
            }
          }
        } catch { /* The current owner can still start without browser storage. */ }
      }
      if (ownerChanged || storedOwnerChanged) { clearOwnedDrafts(); state.submitting = false; }
      ownedDrafts.bind(ownerOfSession(session));
      if (state.session && state.session.csrfToken !== session.csrfToken) {
        state.runs = []; state.selectedId = ''; state.selectedRun = undefined;
        state.finishedRuns.clear(); state.cancelling.clear();
        state.detailError = ''; state.panelSignature = '';
        renderRunList(); renderDetail();
        if (!ownerChanged) toast(t('会话已更新，未提交内容已保留'));
      }
      state.session = session;
      if (session.account) void syncProblemDraftSubmissions(ownerOfSession(session), api);
      chatWorkspace?.bindOwner(ownerOfSession(session));
      if (ownerChanged && linkedProblemDraft) void naturalPage?.then(() => showProblemDraft());
      const previousProvider = field('provider').value;
      const providers = session.providers.map(provider => [provider.id, provider.name] as const);
      const keepProvider = session.providers.some(provider => provider.id === previousProvider);
      // The first load starts on the first provider, as the browser would for fresh options.
      renderOptions(element<HTMLSelectElement>('#provider'), providers.length ? providers : [['', t('无可用服务商')]],
        firstLoad ? providers[0]?.[0] ?? '' : keepProvider ? previousProvider : '');
      const previousEnvironment = field('environment').value;
      renderOptions(element<HTMLSelectElement>('#environment'), session.environments.map(environment => [environment.id, environment.name] as const),
        session.environments.some(environment => environment.id === previousEnvironment) ? previousEnvironment : session.defaults.environment);
      // Keep the legacy option addressable for restored evidence, without offering it for new tasks.
      for (const option of element<HTMLSelectElement>('#environment').options) option.hidden = option.value !== webTaskEnvironment;
      renderTemplates(field('template').value);
      element<HTMLInputElement>('#max-turns').max = String(session.limits.maxTurns);
      element<HTMLInputElement>('#max-seconds').max = String(session.limits.maxRunSeconds);
      element<HTMLInputElement>('#workers').max = String(session.limits.maxWorkers);
      let restoredTaskDraft = false, resumeLeanDraft = false;
      if (firstLoad) { resetForm(); restoredTaskDraft = restoreDraft(); draftReady = true; draftRecovery.load(); renderDraftRecovery(); }
      if (restoredTaskDraft) {
        try { resumeLeanDraft = ownedDrafts.getItem(entryStorageKey) === 'lean'; } catch { /* Unavailable storage keeps the normal entry. */ }
      }
      providerAddress(); updateEnvironment(); updateCounts(); renderRuntime();
      await refreshRuns(epoch, false, listed);
      if (!currentConnection(epoch)) return;
      state.connected = true; state.lost = false;
      if (formalizationLink) await openFormalizedDraft(formalizationLink);
      await researchSelection.load((configuration, imports) => {
        field('environment').value = configuration.environment;
        const preferences = configuration.preferences;
        // A restored attempt already contains the user's execution choices, including Agent preference overrides.
        const keepSettings = restoredTaskDraft && !productTarget.has('researchAsset') && !productTarget.has('libraryReturn');
        if (!keepSettings) {
          if (preferences.providerId && session.providers.some(provider => provider.id === preferences.providerId)) field('provider').value = preferences.providerId;
          if (preferences.model) field('model').value = preferences.model;
          if (preferences.effort) field('effort').value = preferences.effort;
          if (preferences.workers) field('workers').value = String(preferences.workers);
          if (preferences.coordination) element<HTMLInputElement>(`input[name="coordination"][value="${preferences.coordination}"]`).checked = true;
          if (configuration.agent) modulePlanEditor.setValue(undefined);
        }
        if (!draftFormalization && imports.length) {
          const source = field('source').value;
          const additions = [...new Set(imports)].filter(name => !source.split('\n').some(line => line.trim() === `import ${name}`));
          if (additions.length) field('source').value = additions.map(name => `import ${name}`).join('\n') + '\n' + source;
        }
        providerAddress(); updateEnvironment(); updateCounts();
      }, field('environment').value as WebEnvironment, () => {
        // Restoring Library choices prepares the composer without replacing an open research or conversation.
        if (!state.composing || chatWorkspace?.id || new URLSearchParams(location.search).has('chat')) return;
        chooseEntry('lean'); startDraft(false, 'replace');
      });
      await openLibraryProposalDraft();
      await openLibraryPersonalAttemptDraft();
      await openBudgetAttemptDraft();
      await openSharedProofDraft();
      showClassicOrigin();
      await openRecoveryEntry();
      if (!productEntryHandled) {
        productEntryHandled = true;
        if (productEntry) {
          await naturalPage;
          consumeResearchEntry(productEntrySearch, session.templates, {
            statement: draft => { chooseEntry('natural'); startDraft(false, 'replace'); chatWorkspace?.prepareOriginal(draft.statement, draft.environment); },
            lean: draft => { chooseEntry('lean'); startDraft(false, 'replace'); field('environment').value = draft.environment;
              renderTemplates(draft.template); applyTemplate(draft.template); updateEnvironment(); updateCounts(); saveDraft(); },
          });
          const cleaned = new URL(location.href); for (const key of ['entry', 'template', 'environment']) cleaned.searchParams.delete(key);
          cleaned.searchParams.set('lang', productEntry.language); history.replaceState(null, '', cleaned);
        } else if (productTarget.has('message') || productTarget.has('view') || productTarget.has('task')) {
          await naturalPage;
          const chat = productTarget.get('chat'), messageId = productTarget.get('message');
          if (chat && messageId && chatWorkspace?.id === chat) chatWorkspace.revealMessage(messageId);
          const run = currentRun(), taskId = productTarget.get('task'), version = productTarget.get('taskVersion'), commit = productTarget.get('commit');
          if (run && run.id === productTarget.get('run')) {
            if (taskId && version && commit) openFrozenTask(api, run.id, { taskId, version, commit });
            else if (taskId && (!version || run.observation?.inspection.tasks.some(task => task.id === taskId && task.version === version))) openChatArtifact('roadmap', { taskId });
            else if (taskId) toast(t('此任务版本已更新，可从资料夹打开保存的源码。'));
            else openChatArtifact(productTarget.get('view') === 'source' ? 'source' : 'roadmap');
          }
        }
      }
      if (firstLoad && (budgetDraftOrigin || draftSharedProofOrigin || draftClassicOrigin || resumeLeanDraft) && state.composing && !productEntry && !problemDraftTarget
        && !readResearchProblemDraft(productTarget) && !readLibraryReference(productTarget) && !readEditedProblemId(productTarget)
        && (!productTarget.has('fromClassic') || draftClassicOrigin?.id === readClassicId(productTarget)) && !productTarget.has('chat') && !linkedRun) {
        await naturalPage;
        if (!currentConnection(epoch)) return;
        chooseEntry('lean');
      }
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
  const classicPanel = document.querySelector<HTMLElement>('[data-classic-origin]');
  if (classicPanel) classicPanel.hidden = !state.composing || Boolean(currentRun());
  renderAccountProblemDraft();
  const session = state.session, ready = Boolean(state.connected && session?.runtime.ready && session.providers.length);
  const run = currentRun(), running = state.runs.filter(activeRun);
  const named = run?.title ?? (researchEntry === 'natural' ? chatWorkspace?.selected?.title : undefined);
  const title = documentTitle(baseTitle, running.length, state.unseenRuns.size, running.filter(waitsForOwner).length, named);
  if (document.title !== title) document.title = title;
  // The open run already says where it is in its own status line; the pill points at research running elsewhere.
  const elsewhere = running.filter(item => item.id !== run?.id);
  const live = elsewhere.length ? { label: t('{0} 项研究进行中', elsewhere.length), detail: '', tone: 'running', count: elsewhere.length } : undefined;
  renderTopbar(element('#topbar'), {
    model: researchEntry === 'natural' && !run ? t('默认版配置') : field('model').value || t('模型配置'), mac, live,
    libraryHref: chatWorkspace?.id ? `library.html?${new URLSearchParams({ workbenchChat: chatWorkspace.id })}`
      : chatWorkspace?.editingProblem ? `library.html?${new URLSearchParams({ workbenchEdit: chatWorkspace.editingProblem })}` : 'library.html',
    history: { docked: historyDocked(), expanded: !historyCollapsed() },
    connection: { tone: ready ? 'ready' : 'offline', label: !state.connected ? connectionRequest ? t('连接中') : t('连接中断') : ready ? t('环境就绪') : t('环境未就绪') },
    settingsDisabled: !session || state.submitting, account: session?.account?.email, onAccount: openAccount,
    onHistory: toggleHistory, onHome: () => { void openNaturalResearch(); }, onDraft: openDraft, onSettings: () => openSettings(), onPalette: () => palette.open(), onGlossary: () => openGlossary(), onLocale: changeLocale,
    onLive: () => {
      const target = state.runs.filter(item => activeRun(item) && item.id !== run?.id).at(-1);
      if (!target) return;
      if (target.id !== state.selectedId) selectRun(target.id);
      // The status line opens the run's own detail, so whatever the conversation was showing steps aside.
      document.body.dataset.chatArtifact = '';
      setMobileView('runs');
      element(`#detail-tab-${state.tab}`).focus({ preventScroll: true });
    },
  });
}
/** Switching reloads the page; the draft is saved first, as on any page exit. The API key is never kept. */
function changeLocale() { saveDraft(); switchLocale(otherLocale.locale); }
function openAccount() {
  element('#account-email').textContent = state.session?.account?.email ?? '';
  // The allowance is only sent for signed-in accounts that are not admins; anything else leaves the line out.
  const quota = state.session?.quota, quotaLine = element('#account-quota');
  quotaLine.hidden = !quota;
  quotaLine.textContent = quota ? t('本窗口还可开始 {0} 次研究、{1} 次形式化、{2} 份讲解；额度会在窗口结束后恢复。',
    Math.max(0, quota.runs.limit - quota.runs.used), Math.max(0, quota.formalizations.limit - quota.formalizations.used),
    Math.max(0, quota.explanations.limit - quota.explanations.used)) : '';
  element<HTMLInputElement>('#completion-email').checked = state.session?.account?.completionEmail !== false;
  element('#open-admin').hidden = !state.session?.account?.admin;
  const account = state.session?.account, recentCode = account?.passwordResetAllowed;
  element('#account-current-wrap').hidden = !account?.passwordSet || Boolean(recentCode);
  element('#account-password-note').textContent = recentCode ? t('刚通过邮箱验证，可在 10 分钟内设置或重设密码。')
    : account?.passwordSet ? t('输入当前密码和至少 12 位的新密码。忘记密码请用邮箱验证码重新登录。')
      : t('请用邮箱验证码重新登录，在 10 分钟内设置至少 12 位的密码。');
  element<HTMLButtonElement>('#save-password').textContent = account?.passwordSet ? t('修改密码') : t('设置密码');
  for (const id of ['account-current-password', 'account-new-password', 'account-repeat-password']) field(id).value = '';
  element('#account-password-error').hidden = true;
  field('account-confirm').value = ''; element<HTMLButtonElement>('#delete-account').disabled = true;
  element('#account-error').hidden = true;
  showDialog(element<HTMLDialogElement>('#account-dialog'));
}
/** The allowlist and beta totals; the server refuses every admin route to other accounts. */
const admin: { overview?: WebAdminOverview; error?: string; busy?: string } = {};
function renderAdmin() {
  renderAdminPanel(element('#admin-content'), { ...admin, onAdd: email => changeAllowlist('POST', email),
    onRemove: email => void changeAllowlist('DELETE', email), onSuspend: (email, suspended) => void changeSuspended(email, suspended) });
}
async function changeSuspended(email: string, suspended: boolean) {
  admin.busy = email; admin.error = undefined; renderAdmin();
  try {
    admin.overview = await api<WebAdminOverview>('/api/admin/accounts', { method: 'PATCH', body: JSON.stringify({ email, suspended }) });
    toast(suspended ? t('账号已暂停') : t('账号已恢复'));
  }
  catch (error) { admin.error = message(error); }
  finally { admin.busy = undefined; renderAdmin(); }
}
async function openAdmin() {
  const dialog = element<HTMLDialogElement>('#account-dialog');
  if (dialog.open) dialog.close();
  admin.error = undefined; renderAdmin();
  showDialog(element<HTMLDialogElement>('#admin-dialog'));
  try { admin.overview = await api<WebAdminOverview>('/api/admin/overview'); }
  catch (error) { admin.error = message(error); }
  renderAdmin();
}
async function changeCompletionEmail(input: HTMLInputElement) {
  const wanted = input.checked, session = state.session;
  input.disabled = true;
  try {
    await api('/api/auth/account', { method: 'PATCH', body: JSON.stringify({ completionEmail: wanted }) });
    if (!sameSession(session)) return;
    if (state.session?.account) state.session.account.completionEmail = wanted;
    toast(wanted ? t('研究结束时会发邮件到登录邮箱') : t('已关闭结束邮件'));
  } catch (error) { if (sameSession(session)) { input.checked = !wanted; toast(message(error)); } }
  finally { input.disabled = false; }
}
async function changePassword(event: Event) {
  event.preventDefault();
  const error = element('#account-password-error'), button = element<HTMLButtonElement>('#save-password');
  const password = field('account-new-password').value, repeat = field('account-repeat-password').value, session = state.session;
  error.hidden = true;
  if (password.length < 12 || new TextEncoder().encode(password).length > 256) {
    error.textContent = t('密码至少 12 位且不超过 256 字节。'); error.hidden = false; return;
  }
  if (password !== repeat) { error.textContent = t('两次输入的密码不一致。'); error.hidden = false; return; }
  button.disabled = true;
  try {
    await api('/api/auth/password', { method: 'PATCH', body: JSON.stringify({ password,
      currentPassword: field('account-current-password').value }) });
    if (!sameSession(session)) return;
    if (state.session?.account) { state.session.account.passwordSet = true; state.session.account.passwordResetAllowed = false; }
    element('#account-current-wrap').hidden = false;
    element('#account-password-note').textContent = t('输入当前密码和至少 12 位的新密码。忘记密码请用邮箱验证码重新登录。');
    button.textContent = t('修改密码');
    toast(t('密码已更新；其他设备需要重新登录'));
  } catch (cause) { if (sameSession(session)) { error.textContent = message(cause); error.hidden = false; } }
  finally {
    if (sameSession(session)) for (const id of ['account-current-password', 'account-new-password', 'account-repeat-password']) field(id).value = '';
    button.disabled = false;
  }
}
async function changeAllowlist(method: 'POST' | 'DELETE', email: string): Promise<boolean> {
  admin.busy = email; admin.error = undefined; renderAdmin();
  try {
    admin.overview = await api<WebAdminOverview>('/api/admin/allowlist', { method, body: JSON.stringify({ email }) });
    toast(method === 'POST' ? t('已加入白名单') : t('已移出白名单'));
    return true;
  } catch (error) { admin.error = message(error); return false; }
  finally { admin.busy = undefined; renderAdmin(); }
}
async function leaveAccount(request: () => Promise<unknown>, button: HTMLButtonElement) {
  const session = state.session;
  button.disabled = true; element('#account-error').hidden = true;
  try {
    await request();
    if (!sameSession(session)) return;
    try { localStorage.setItem('theorem-os.web-account-left.v1', JSON.stringify({ owner: state.session && ownerOfSession(state.session), nonce: crypto.randomUUID() })); } catch { /* Other tabs also detect session changes on their next request. */ }
    clearOwnedDrafts();
    location.replace('login.html');
  }
  catch (error) {
    if (!sameSession(session)) return;
    element('#account-error').textContent = message(error); element('#account-error').hidden = false;
    button.disabled = false;
  }
  finally { if (!sameSession(session)) button.disabled = false; }
}
/** The theme itself is applied by theme.js before the first paint; this page only offers the choice. */
const themeLabels: Record<ThemePreference, string> = { system: t('跟随系统'), light: t('浅色'), dark: t('深色') };
function showThemeChoice() {
  const preference = readThemePreference();
  document.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach(input => { input.checked = input.value === preference; });
}
/** Where the reader last chose something: the pointer, or the control a key was pressed in (the palette's search for its commands). */
let chosenAt: { x: number; y: number } | Element | null = null;
document.addEventListener('pointerdown', event => { chosenAt = { x: event.clientX, y: event.clientY }; }, { capture: true, passive: true });
// Measured only when a theme is chosen, so typing costs no layout.
document.addEventListener('keydown', event => { chosenAt = event.target instanceof Element ? event.target : null; }, { capture: true, passive: true });
function chooseTheme(preference: ThemePreference) {
  if (!saveThemePreference(() => localStorage, preference)) toast(t('浏览器不允许保存，外观只在此页面生效'));
  if (resolveTheme(preference, matchMedia('(prefers-color-scheme: dark)').matches) === document.documentElement.dataset.theme) applyTheme(preference);
  else {
    const box = chosenAt instanceof Element && chosenAt !== document.body ? chosenAt.getBoundingClientRect() : undefined;
    const origin = chosenAt && !(chosenAt instanceof Element) ? chosenAt
      : box?.width ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 };
    revealTheme(() => applyTheme(preference), origin.x, origin.y);
  }
  showThemeChoice();
}
followThemeChanges(showThemeChoice);
showThemeChoice();
document.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach(input => input.addEventListener('change', () => chooseTheme(input.value as ThemePreference)));
element('#completion-email').addEventListener('change', event => void changeCompletionEmail(event.currentTarget as HTMLInputElement));
element('#account-password-form').addEventListener('submit', event => void changePassword(event));
function openGlossary(id?: TermId) {
  const dialog = element<HTMLDialogElement>('#glossary-dialog');
  renderGlossary(dialog, id);
  showDialog(dialog);
}
installTermHints(openGlossary);
/** Wide screens keep the history docked beside the workspace; narrow ones open the same list as a dialog. */
function historyDocked() { return !historyQuery.matches; }
function historyCollapsed() { return document.body.dataset.historyCollapsed === 'true'; }
function placeHistory() {
  const history = element('.run-history'), docked = historyDocked();
  const host = element(docked ? '#history-sidebar' : '#history-dialog');
  if (history.parentElement === host) return;
  rememberHistoryScroll();
  if (docked && element<HTMLDialogElement>('#history-dialog').open) element<HTMLDialogElement>('#history-dialog').close();
  host.append(history);
  restoreHistoryScroll();
}
let historyFolding: ReturnType<typeof setTimeout> | undefined;
function setHistoryCollapsed(collapsed: boolean) {
  // Marks the change so the column folds over 320 ms (app.css) rather than at once; a first paint never animates.
  document.body.dataset.historyFolding = ''; clearTimeout(historyFolding);
  historyFolding = setTimeout(() => { delete document.body.dataset.historyFolding; }, 400);
  if (!collapsed) document.body.removeAttribute('data-history-collapsed'); else document.body.dataset.historyCollapsed = 'true';
  markHistoryCollapsed(collapsed);
  try { localStorage.setItem(historyStorageKey, String(collapsed)); } catch { /* The choice lasts for this page only. */ }
  renderShell();
  if (!collapsed) restoreHistoryScroll();
}
function toggleHistory() {
  if (!historyDocked()) { openHistory(); return; }
  setHistoryCollapsed(!historyCollapsed());
}
function openHistory() {
  if (historyDocked()) { if (historyCollapsed()) setHistoryCollapsed(false); }
  else showDialog(element<HTMLDialogElement>('#history-dialog'));
  restoreHistoryScroll();
  if (!touchQuery.matches && state.runs.length) field('run-search').focus();
}
/** An explicit new research starts with an empty natural-language input. */
function openDraft() {
  void openNaturalResearch(true);
}
function paletteCommands(): PaletteCommand[] {
  const run = currentRun(), click = (selector: string) => () => element(selector).click();
  const usable = (selector: string) => !element<HTMLButtonElement>(selector).disabled && !element(selector).hidden;
  const commands: PaletteCommand[] = [
    { id: 'open-draft', group: t('操作'), label: t('新建研究'), icon: 'square-pen', keywords: t('new draft 草稿 新研究'), run: openDraft },
    { id: 'open-history', group: t('操作'), label: t('打开研究记录'), icon: 'panel-left', keywords: 'history runs', run: openHistory },
    { id: 'open-settings', group: t('操作'), label: t('研究配置'), hint: field('model').value, icon: 'sliders-horizontal', keywords: t('settings model provider api key 模型 服务商 密钥 预算 轮次'), run: click('#open-settings') },
  ].filter(command => usable(`#${command.id}`));
  const preference = readThemePreference(), themeIcons: Record<ThemePreference, string> = { system: 'sun-moon', light: 'sun', dark: 'moon' };
  for (const option of ['system', 'light', 'dark'] as const) if (option !== preference)
    commands.push({ id: `theme-${option}`, group: t('外观'), label: t('外观：{0}', themeLabels[option]), icon: themeIcons[option],
      keywords: t('theme appearance dark light 外观 主题 深色 浅色 夜间'), run: () => chooseTheme(option) });
  commands.push({ id: 'switch-locale', group: t('帮助'), label: otherLocale.label, lang: otherLocale.lang, hint: otherLocale.title, icon: 'languages', keywords: 'language locale english chinese 语言 中文 英文', run: changeLocale });
  commands.push({ id: 'open-glossary', group: t('帮助'), label: t('术语说明'), icon: 'book-open', keywords: t('glossary help 术语 帮助'), run: () => openGlossary() });
  commands.push({ id: 'open-workspace', group: t('操作'), label: t('我的研究'), icon: 'folder-open', keywords: t('inbox todo search usage brief collections 待办 搜索 用量 简报 收藏 资料夹'), run: () => location.assign('workspace.html') });
  commands.push({ id: 'search-research', group: t('操作'), label: t('搜索全部研究记录'), icon: 'search', keywords: t('search all conversations lemmas routes 全局搜索 对话 引理 路线'), run: () => location.assign('workspace.html?tab=search') });
  commands.push({ id: 'open-classics', group: t('帮助'), label: t('经典题库'), hint: t('所有账户共享，无需 API Key'), icon: 'book-open',
    keywords: 'classic problems proofs solutions archive library 经典 题库 数学 解答 过程',
    run: () => { window.open(classicLibraryUrl, '_blank', 'noopener'); } });
  if (state.session?.account?.admin) commands.push({ id: 'open-admin', group: t('操作'), label: t('管理'), hint: t('白名单与内测漏斗'), icon: 'shield-check',
    keywords: t('admin allowlist manage 管理 白名单 账号'), run: () => void openAdmin() });
  commands.push({ id: 'open-guide', group: t('帮助'), label: t('使用说明'), icon: 'circle-help', keywords: t('guide help manual how 使用 说明 教程 帮助'),
    run: () => { window.open('guide.html', '_blank', 'noopener'); } });
  commands.push({ id: 'open-language-guide', group: t('帮助'), label: t('Lean 与自然语言'), hint: t('原意对照、证明讲解与形式化说明'), icon: 'languages',
    keywords: 'formalization translation natural language 形式化 转换 回译 自然语言', run: () => { window.open('guide.html#language', '_blank', 'noopener'); } });
  commands.push({ id: 'open-formalization', group: t('操作'), label: t('自然语言 / TeX → Lean'), hint: t('先形式化原题，再开始证明'), icon: 'languages',
    keywords: 'formalize formalization natural language tex 形式化 转换 自然语言 原题', run: () => { saveDraft(); void openNaturalResearch(); } });
  commands.push({ id: 'send-feedback', group: t('帮助'), label: t('反馈问题或建议'), hint: t('在官网填写，确认后发布到 GitHub'), icon: 'message-square',
    keywords: t('feedback bug report issue 反馈 问题 建议'), run: () => { window.open(feedbackUrl(), '_blank', 'noopener'); } });
  if (state.session?.sample && !sampleSelected()) commands.push({ id: 'open-sample', group: t('帮助'), label: t('查看示例运行'), hint: t('无需 API Key'), icon: 'eye', keywords: t('sample demo example 示例'), run: () => void openSample() });
  // What the open run's own buttons do, under the same conditions, so 下载 or 分享 finds them from any tab.
  if (run) {
    const proof = candidateSource(run), verified = Boolean(run.result?.proof && passed(run)), sample = isSample(run);
    const proofLabel = verified ? t('验收证明') : t('候选源码');
    const actions: (PaletteCommand | false)[] = [
      { id: 'run-statement-review', group: t('当前研究'), label: t('原意与 Lean'), hint: t('数学原意、Lean 声明与独立回译'), icon: 'languages',
        keywords: 'statement review translation intent 原意 声明 审阅 回译 转换 自然语言', run: () => openCollaborationSection(run, 'reviews') },
      verified && { id: 'run-explanation', group: t('当前研究'), label: t('Lean → 自然语言'), hint: t('按步骤阅读验收证明'), icon: 'book-open',
        keywords: 'explain proof natural language 讲解 解释 证明 转换 自然语言', run: () => { window.open(`explain.html?run=${encodeURIComponent(run.id)}`, '_blank', 'noopener'); } },
      { id: 'run-knowledge', group: t('当前研究'), label: t('知识检索'), icon: 'search', keywords: 'knowledge search library 知识 检索 知识库', run: () => openCollaborationSection(run, 'knowledge') },
      { id: 'run-records', group: t('当前研究'), label: t('归档记录'), icon: 'archive', keywords: 'archive records 归档 记录', run: () => openCollaborationSection(run, 'records') },
      run.researchMode !== 'skill' && { id: 'run-guidance-history', group: t('当前研究'), label: t('指导记录'), icon: 'message-square', keywords: 'guidance feedback history 指导 历史 人工', run: () => openCollaborationSection(run, 'guidance') },
      Boolean(proof) && { id: 'run-copy-proof', group: t('当前研究'), label: t('复制{0}', proofLabel), icon: 'copy', keywords: t('copy proof lean 复制 证明 源码'),
        run: () => void copyText(proof, verified ? t('验收证明已复制') : t('候选源码已复制')) },
      Boolean(proof) && { id: 'run-download-proof', group: t('当前研究'), label: t('下载 Lean'), hint: proofFileName(run), icon: 'download', keywords: t('download proof lean file 下载 证明 文件'),
        run: () => download(proofFileName(run), proof, 'text/plain;charset=utf-8') },
      !sample && verified && state.connected && { id: 'run-share', group: t('当前研究'), label: t('分享研究成果'), icon: 'share-2', keywords: t('share link public 分享 链接'),
        run: () => void openSharing(run) },
      Boolean(state.session) && !state.submitting && { id: 'run-reuse', group: t('当前研究'), label: sample ? t('用这道题开始研究') : t('复用任务配置'), icon: 'copy-plus',
        keywords: t('reuse retry again rerun 复用 再试 重新 配置'), run: () => reuseRun(run) },
      Boolean(run.result || !activeRun(run)) && { id: 'run-download-archive', group: t('当前研究'), label: t('下载完整研究归档'), icon: 'download', keywords: t('download archive zip run 下载 档案 记录'),
        run: () => { const link = document.createElement('a'); link.href = downloadUrl(run.id); link.download = ''; document.body.append(link); link.click(); link.remove(); } },
      !sample && activeRun(run) && state.connected && !state.cancelling.has(run.id) && { id: 'run-cancel', group: t('当前研究'), label: t('取消运行'), icon: 'square',
        keywords: t('cancel stop 取消 停止'), run: () => openCancellation(run) },
      !sample && !activeRun(run) && state.connected && !state.deleting.has(run.id) && { id: 'run-delete', group: t('当前研究'), label: t('删除运行记录'), icon: 'trash-2',
        keywords: t('delete remove 删除 记录'), run: () => openDeletion(run) },
    ];
    for (const action of actions) if (action) commands.push(action);
  }
  const tabIcons: Record<DetailTab, string> = { result: 'circle-check', trajectory: 'route', collaboration: 'network', source: 'file-code-2', events: 'activity', modules: 'blocks' };
  const paletteTabs: readonly (readonly [DetailTab, string])[] = [...baseTabs, ['modules', t('模块方案')]];
  // What each view holds, so 报告 or json finds the result view.
  const tabKeywords: Record<DetailTab, string> = { result: t('result report verdict json 报告 验收报告 验收 证明'),
    trajectory: 'roadmap trajectory steps timeline route 研究路线图 轨迹 步骤 过程 路线', collaboration: 'collaboration agents plan tasks dependencies reviews 协作 计划 任务 分工 依赖 审阅 Agent',
    source: t('source code lean diff 源码 代码 对比'), events: t('events activity log 活动 日志 事件'), modules: t('modules plan 模块 方案') };
  if (run) for (const [tab, label] of paletteTabs) commands.push({ id: `tab-${tab}`, group: t('当前研究'), label, hint: tab === state.tab ? t('当前视图') : undefined, icon: tabIcons[tab],
    keywords: `${tab} ${tabKeywords[tab]}`, run: () => { state.tab = tab; setMobileView('runs'); renderDetail(true); element(`#detail-tab-${tab}`).focus({ preventScroll: true }); } });
  for (const item of state.runs.toReversed().slice(0, 30)) {
    const value = status(item);
    // The theorem names find a run by its problem (fermat_little), whatever language the task is written in.
    const theorems = leanOutline(item.source).filter(heading => heading.kind === 'theorem').map(heading => heading.name);
    commands.push({ id: `run-${item.id}`, group: t('研究记录'), label: item.title, hint: value.label, icon: value.symbol,
      keywords: [item.task, ...theorems, item.id, item.model].join(' '),
      run: () => { selectRun(item.id); setMobileView('runs'); element(`#detail-tab-${state.tab}`).focus({ preventScroll: true }); } });
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
  if (researchEntry !== 'lean') { void openNaturalResearch(); return; }
  const session = state.session;
  if (!session || !state.connected || state.submitting || !session.runtime.ready || !session.providers.length) return;
  const errorBox = element('#form-error'); errorBox.hidden = true;
  const epoch = state.connectionEpoch;
  const returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : field('task');
  const submission = ++submissionSequence;
  let sent = false, failed = false;
  const issues = currentSubmissionIssues();
  if (issues.length) {
    for (const issue of issues) validationShown.add(issue.field);
    focusSubmissionIssue(issues[0]);
    return;
  }
  try {
    let capturedDraft = editableTaskDraft(captureDraft(), submissionIdentity.unresolved, researchSelection.environment());
    if (field('environment').value !== capturedDraft.environment) {
      field('environment').value = capturedDraft.environment; renderTemplates(); updateEnvironment();
      capturedDraft = captureDraft();
    }
    const accountDraft = session.account ? captureProblemDraftSubmission(ownerOfSession(session), leanProblemDraft(capturedDraft, selectedProblemLibraries())) : undefined;
    const input: WebRunRequest = {
      providerId: field('provider').value, apiKey: field('api-key').value.trim(), model: field('model').value.trim(),
      effort: field('effort').value as WebEffort, environment: field('environment').value as WebEnvironment,
      source: field('source').value, task: field('task').value,
      maxTurns: Number(field('max-turns').value), maxRunSeconds: Number(field('max-seconds').value),
      ...(tokenCap(field('max-tokens').value, session.limits.maxTotalTokens) ? { maxTotalTokens: tokenCap(field('max-tokens').value, session.limits.maxTotalTokens) } : {}),
      workers: Number(field('workers').value),
      coordination: element<HTMLInputElement>('input[name="coordination"]:checked').value as WebCoordination,
      ...(capturedDraft.researchMode ? { researchMode: capturedDraft.researchMode, skillLoading: capturedDraft.skillLoading } : {}),
      ...(element<HTMLInputElement>('#plan-approval').checked && planApprovalAvailable() ? { planApproval: true } : {}),
      ...(capturedDraft.modulePlan ? { modulePlan: capturedDraft.modulePlan } : {}),
      ...(capturedDraft.knowledgeDigest !== undefined ? { knowledgeDigest: capturedDraft.knowledgeDigest } : {}),
      ...(draftContinuation ? { continueFrom: draftContinuation } : {}),
      ...(capturedDraft.problemBudget?.projectId ? { budgetOrigin: { runId: capturedDraft.problemBudget.runId, projectId: capturedDraft.problemBudget.projectId } } : {}),
      ...(capturedDraft.libraryProposalOrigin ? { libraryProposalOrigin: capturedDraft.libraryProposalOrigin } : {}),
      ...(draftFormalization ? { formalizationId: draftFormalization.id } : {}),
      ...(researchSelection.value() ? { researchSelection: researchSelection.value() } : {}),
    };
    const saveKey = Boolean(session.account?.keyVault && input.apiKey && element<HTMLInputElement>('#save-key').checked);
    if (saveKey) input.saveKey = true;
    syncKeyMemory();
    closeSettings(false);
    state.submitting = true; renderRuntime();
    input.requestId = await submissionIdentity.prepare(input);
    if (!currentConnection(epoch)) return;
    saveDraft();
    sent = true;
    // A run arriving through the list before this response must not replace the page that will report the outcome.
    state.composing = true;
    modulePlanEditor.clearDeleted();
    modulePlanLibrary.clearUndo();
    draftRecovery.clear(); renderDraftRecovery();
    const result = await api<{ run: WebRun; savedKeys?: WebSavedKey[]; keySaveFailed?: boolean }>('/api/runs', { method: 'POST', body: JSON.stringify(input) });
    if (!currentConnection(epoch)) {
      toast(t('研究已提交，连接已变化，请核对运行记录'));
      void poll(); return;
    }
    const draftArchived = await completeProblemDraftSubmission(accountDraft, { kind: 'run', id: result.run.id }, api);
    if (!currentConnection(epoch)) { void poll(); return; }
    const run = state.runs.find(item => item.id === result.run.id) ?? result.run;
    if (result.savedKeys && currentConnection(epoch) && state.session?.account) state.session.account.savedKeys = result.savedKeys;
    field('api-key').value = '';
    clearValidation();
    element<HTMLInputElement>('#api-key').type = 'password'; updateKeyToggle(); providerAddress();
    state.listGeneration++;
    if (!state.runs.some(item => item.id === run.id)) arrivals.add(run.id);
    state.runs = [run, ...state.runs.filter(item => item.id !== run.id)];
    state.composing = false;
    state.selectedId = run.id; state.selectedRun = run; state.tab = 'result'; state.sourceView = 'proof'; state.reportMode = 'summary'; state.detailError = '';
    addressMode = 'push'; clearFilters();
    field('task').value = ''; draftContinuation = undefined; draftFormalization = undefined; updateCounts(); draftChanged();
    // Persist the consumed draft before dropping its retry identity, including immediate reloads.
    saveDraft(); submissionIdentity.clear(input.requestId);
    state.panelSignature = ''; renderRunList(); renderDetail(true); setMobileView('compose');
    chatWorkspace?.useRunKey(run.id, input.apiKey);
    schedulePoll();
    requestRunsRefresh();
    toast(!draftArchived ? t('研究已提交，草稿归档待同步。') : result.keySaveFailed ? t('研究已提交，Key 未能保存，请在设置中重试保存。')
      : saveKey ? t('研究已提交，Key 已保存到你的账号') : t('研究已提交'));
  } catch (error) {
    if (submission !== submissionSequence) return;
    const key = field('api-key').value.trim();
    const uncertain = sent && (!(error instanceof ApiError) || error.status >= 500);
    const text = uncertain ? t('提交结果尚未确认，请先核对运行记录后再决定是否重新提交。') : message(error);
    errorBox.textContent = key ? text.split(key).join(t('[已隐藏]')) : text;
    errorBox.hidden = false;
    if (sent && currentConnection(epoch) && (uncertain || sessionFailure(error))) {
      disconnected(t('连接需要恢复，未提交内容已保留。'));
      void initialize();
    }
    failed = true;
  } finally {
    if (submission !== submissionSequence) return;
    state.submitting = false; renderRuntime();
    // The form was disabled while the request ran, which drops focus to the page; after a refusal it goes back where the reader was.
    // A send from the settings dialog left with the dialog, so the task takes it then.
    if (failed && document.activeElement === document.body) {
      returnFocus.focus({ preventScroll: true });
      if (document.activeElement === document.body) focusProofInstructions(true);
    }
  }
});
const runById = (id: string) => state.selectedRun?.id === id ? state.selectedRun : state.runs.find(run => run.id === id);
function renderCancelState() {
  if (!cancellationTarget) return;
  const run = runById(cancellationTarget.id);
  const notice = cancellationTarget.csrfToken !== state.session?.csrfToken ? t('会话已变化，请关闭对话框。')
    : !state.connected ? t('连接中断，恢复后可取消。')
      : !run ? t('记录已不存在。') : !activeRun(run) ? t('这次研究已经结束，无需取消。') : '';
  if (run && activeRun(run)) element('#cancel-run-description').textContent = run.status === 'queued'
    ? t('任务还在排队，取消后不会开始，也不会调用模型。之后可以用「复用任务配置」重新提交。')
    : t('Agent 会立即停止，这道题不会完成验收。已通过 Lean 检查的代码、解题轨迹和活动日志都会保留，之后可以从已检查的代码继续。');
  element('#cancel-run-notice').textContent = notice;
  element('#cancel-run-notice').hidden = !notice;
  element<HTMLButtonElement>('#confirm-cancel-run').disabled = Boolean(notice) || Boolean(run && state.cancelling.has(run.id));
}
function openCancellation(run: WebRun) {
  if (!state.connected || !state.session || isSample(run) || !activeRun(run) || state.cancelling.has(run.id)) return;
  cancellationTarget = { id: run.id, title: run.title, csrfToken: state.session.csrfToken };
  element('#cancel-run-title').textContent = run.title;
  renderCancelState();
  showDialog(element<HTMLDialogElement>('#cancel-run-dialog'));
  element('#keep-running').focus();
}
async function cancelRun(id: string) {
  const run = runById(id);
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
    const updated = retainLatestRun(result.run, state.runs[index]);
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
/** The chat of a deleted run has nothing left to show; with no other run to move on to, it returns to a new problem. */
function leaveDeletedChat(id: string | undefined) {
  if (id && chatWorkspace?.runId === id && !state.selectedRun && !state.runs.some(run => run.id === id)) chatWorkspace.home(true);
}
function removeLocalRun(id: string) {
  const index = visibleRuns().findIndex(run => run.id === id);
  state.listGeneration++;
  state.runs = state.runs.filter(run => run.id !== id);
  if (state.selectedId === id) {
    const visible = visibleRuns();
    state.selectedId = visible[Math.min(Math.max(index, 0), visible.length - 1)]?.id ?? state.runs[0]?.id ?? '';
    state.tab = 'result'; state.sourceView = 'proof'; state.reportMode = 'summary'; state.detailError = ''; state.panelSignature = '';
  }
  state.selectedRun = state.runs.find(run => run.id === state.selectedId);
  leaveDeletedChat(id);
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
  const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
  const scopes = element('#share-dialog').querySelectorAll<HTMLElement>('.share-scope');
  const list = (host: HTMLElement | undefined, items: string[]) => {
    if (host) host.replaceChildren(...items.map(text => { const item = document.createElement('li'); item.textContent = text; return item; }));
  };
  list(scopes[0], [tx('原题、适用条件、Lean 陈述与验收证明', 'The problem, assumptions, Lean statement and accepted proof'),
    tx('已保存的任务、推导思路和对应版本源码；已审核的逐步讲解（如有）', 'Recorded tasks, reasoning and source versions; approved step-by-step explanations, when available'),
    tx('陈述确认与形式化对应关系、独立验收凭据', 'Statement confirmation, formalization correspondences and acceptance evidence'),
    tx('模型名称、Agent 数量、耗时与 Token 用量', 'Model name, agent count, elapsed time and token usage')]);
  list(scopes[1], [tx('API Key、模型服务地址与账号邮箱', 'API keys, provider addresses and account email'),
    tx('原始运行日志、Agent 对话与未公开的协作讨论', 'Raw runtime logs, agent conversations and unpublished collaboration discussions')]);
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
// A downloaded proof is named after the theorem it proves (the first one the problem left open), not the run's ID.
const proofFileName = (run: WebRun) => leanFileName(run.source);
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
  retry: 'api-key', key: 'api-key', budget: 'max-seconds', tokens: 'max-tokens', turns: 'max-turns', workers: 'workers', source: 'source', task: 'task' };
/** 提高: twice the run's own limit, up to what a run may ask for. */
const raised = (value: number, highest: number) => Math.min(highest, Math.max(1, value) * 2);
async function recoverRun(run: WebRun, action: string, button: HTMLButtonElement) {
  const step = nextSteps(run, summarizeGoals(run)).find(item => item.id === action);
  if (step?.id === 'continue-checked') await continueChecked(run, step.tasks, button);
  else if (step?.id === 'ask-failed') {
    openChatArtifact('roadmap');
    trajectoryView?.showStep(run.id, 'failed', step.tasks);
    if (!document.activeElement?.closest('.trajectory-workspace')) element('#detail-tab-trajectory').focus({ preventScroll: true });
  } else if (action in recoveryFields) reuseRun(run, action as keyof typeof recoveryFields);
}
/** Loads `run`'s problem and settings into a new draft; with `from`, the new run also starts from that recorded version. */
/** 从已检查的代码继续: a new draft from the latest code the run's own Lean check passed, read from its trajectory. */
async function continueChecked(run: WebRun, taskIds: readonly string[], button: HTMLButtonElement) {
  if (button.disabled || state.submitting) return;
  button.disabled = true;
  try {
    const from = await trajectoryView?.checkedContinuation(run, taskIds);
    if (state.selectedId !== run.id) return;
    if (!from) { toast(t('已检查版本的源码没有保存，无法带入成果。请在路线图中查看已有记录。')); return; }
    await reuseRun(run, 'retry', from);
  } catch (error) {
    toast(t('读取已检查的代码失败：{0}', message(error)));
  } finally { button.disabled = false; }
}
async function reuseRun(run: WebRun, recovery: Exclude<RecoveryAction['id'], 'report'> = 'retry', from?: WebContinuation) {
  const session = state.session;
  if (!session || state.submitting) return;
  const owner = ownerOfSession(session), revision = draftRevision, selectedId = state.selectedId;
  try {
    const configuration = run.researchConfiguration;
    const refs = configuration ? [configuration.agent?.ref, ...configuration.skills.map(item => item.ref), ...configuration.libraries.map(item => item.ref)]
      .filter(item => item !== undefined) : [];
    // Check the exact versions before replacing another draft. Missing dependencies keep the original run open.
    const selected = refs.length ? await researchSelection.prepare(refs, run.environment) : undefined;
    if (!state.session || ownerOfSession(state.session) !== owner || state.submitting || revision !== draftRevision || selectedId !== state.selectedId) return;
    applyReusedRun(run, recovery, from);
    if (selected) researchSelection.adopt(selected); else researchSelection.clear();
    draftChanged(); saveDraft();
  } catch (error) { toast(message(error)); }
}
function applyReusedRun(run: WebRun, recovery: Exclude<RecoveryAction['id'], 'report'> = 'retry', from?: WebContinuation) {
  const session = state.session;
  if (!session || state.submitting) return;
  chooseEntry('lean');
  if (recovery === 'key') forgetRememberedKey();
  replaceDraft('reuse', () => {
    budgetDraftOrigin = isSample(run) ? undefined : { ...(run.budgetOrigin ?? { runId: run.id }), source: run.source, environment: run.environment };
    draftLibraryProposalOrigin = run.libraryProposalOrigin ? { ...run.libraryProposalOrigin } : undefined;
    renderLibraryProposalOrigin();
    draftContinuation = from;
    continuationPreview = { title: run.title, runId: run.id, from, originalSeconds: run.maxRunSeconds, originalTurns: run.maxTurns, originalTokens: run.maxTotalTokens };
    draftFormalization = isStatementReviewed(run) && run.formalization?.evidenceSha256 ? { id: run.formalization.id, evidenceSha256: run.formalization.evidenceSha256,
      source: run.source, environment: run.environment, original: run.formalization.original } : undefined;
    clearValidation();
    // The sample's agent was a script, so its provider and model are no choice to copy; the visitor keeps their own.
    const connection = isSample(run) ? {} : { model: run.model, effort: run.effort };
    if (!isSample(run)) field('provider').value = session.providers.some(provider => provider.id === run.providerId) ? run.providerId : '';
    field('environment').value = run.environment;
    renderTemplates();
    for (const [id, value] of Object.entries({ ...connection, source: run.source, task: run.task,
      'max-turns': run.maxTurns || '', 'max-seconds': run.maxRunSeconds || '', workers: run.workers,
      'max-tokens': run.maxTotalTokens ? run.maxTotalTokens / 10_000 : '' })) field(id).value = String(value);
    // 提高解题预算 / 提高轮次上限 open with the limit already doubled (up to the highest allowed); the field stays open to change it.
    const limit = recovery === 'budget' ? { id: 'max-seconds', value: run.maxRunSeconds, highest: session.limits.maxRunSeconds, say: (value: number) => readableDuration(value * 1000) }
      : recovery === 'turns' ? { id: 'max-turns', value: run.maxTurns, highest: session.limits.maxTurns, say: String } : undefined;
    const raise = limit && limit.value > 0 && limit.value < limit.highest ? { ...limit, to: raised(limit.value, limit.highest) } : undefined;
    if (raise) field(raise.id).value = String(raise.to);
    element<HTMLInputElement>(`input[name="coordination"][value="${run.coordination}"]`).checked = true;
    field('research-mode').value = run.researchMode ?? 'legacy';
    field('skill-loading').value = run.skillLoading ?? 'native';
    element<HTMLInputElement>('#plan-approval').checked = Boolean(run.planApproval);
    modulePlanLibrary.resetSelection(); modulePlanEditor.setValue(run.modulePlan);
    serverModulePlans.setKnowledgeDigest(run.knowledgeDigest);
    field('api-key').value = '';
    element<HTMLInputElement>('#api-key').type = 'password';
    updateKeyToggle(); providerAddress(); updateEnvironment(); sourceChanged();
    element('#form-error').hidden = true;
    startDraft();
    if (recovery === 'task') {
      // The task is in the composer, outside the settings dialog: put the caret at its end to add to it.
      element<HTMLDetailsElement>('#proof-instructions').open = true;
      const task = element<HTMLTextAreaElement>('#task');
      task.focus(); task.setSelectionRange(task.value.length, task.value.length);
      toast(t('已载入原始题目与执行配置；在研究任务里补充思路，再输入 API Key 提交'));
      return;
    }
    openSettings(recoveryFields[recovery]);
    toast(from ? t('已载入原始题目、执行配置和「{0}」的代码，请输入 API Key', from.label)
      : raise ? recovery === 'budget' ? t('已载入原始配置，并把解题预算从 {0} 提高到 {1}；请输入 API Key', raise.say(raise.value), raise.say(raise.to))
        : t('已载入原始配置，并把轮次上限从 {0} 提高到 {1}；请输入 API Key', raise.value, raise.to)
        : recovery === 'retry' || recovery === 'key' ? t('已载入原始题目与执行配置，请输入 API Key') : t('已载入原始配置，修改后请重新输入 API Key'));
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
    if (currentRun()) { state.tab = moduleDestination === 'report' ? 'result' : moduleDestination; renderDetail(true); element(`#detail-tab-${state.tab}`).focus({ preventScroll: true }); }
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
  // Every entry in the run menu acts once; the menu closes behind it.
  const menu = target.closest<HTMLDetailsElement>('[data-run-menu]');
  if (menu && target !== menu) menu.open = false;
  if (target.dataset.action === 'cancel') openCancellation(run);
  if (target.dataset.action === 'delete-run') openDeletion(run);
  if (target.dataset.action === 'share-run') void openSharing(run);
  if (target.dataset.action === 'copy-id') void copyText(run.id, t('运行 ID 已复制'));
  if (target.dataset.action === 'copy-source') void copyText(displayedSource(run), t('Lean 源码已复制'));
  if (target.dataset.action === 'copy-proof' && candidateSource(run))
    void copyText(candidateSource(run), run.result?.proof && passed(run) ? t('验收证明已复制') : t('候选源码已复制'));
  if (target.dataset.action === 'notify') void toggleNotifications();
  if (target.dataset.action === 'recover') {
    if (target.dataset.recovery) recoverRun(run, target.dataset.recovery, target as HTMLButtonElement);
    return;
  }
  if (target.dataset.action === 'show-modules' || target.dataset.action === 'open-source') {
    state.proofViewer = ''; state.compare = undefined;
    state.tab = target.dataset.action === 'show-modules' ? 'modules' : 'source';
    if (state.tab === 'source') state.sourceView = candidateSource(run) ? 'proof' : 'input';
    renderDetail(true); element(`#detail-tab-${state.tab}`).focus({ preventScroll: true }); return;
  }
  if (target.dataset.action === 'copy-report' && run.result) void copyText(JSON.stringify(run.result.report, null, 2), t('报告 JSON 已复制'));
  if (target.dataset.action === 'reuse-run') reuseRun(run);
  if (target.dataset.action === 'open-continued' && target.dataset.runId) { selectRun(target.dataset.runId); return; }
  if (target.dataset.action === 'show-events' || target.dataset.action === 'show-agents') {
    state.tab = target.dataset.action === 'show-events' ? 'events' : 'collaboration';
    renderDetail(true); element(`#detail-tab-${state.tab}`).focus({ preventScroll: true }); return;
  }
  if (target.dataset.action === 'retry-outline' && loadOutline(run, true)) renderPanel(true);
  if (target.dataset.action === 'view-proof') {
    if (state.proofViewer === run.id) { closeProofViewer(); return; }
    // One viewer at a time beside the result.
    state.proofViewer = run.id; state.compare = undefined; renderPanel(true); return;
  }
  if (target.dataset.action === 'compare-continued' && target.dataset.runId) {
    if (state.compare?.runId === run.id && state.compare.laterId === target.dataset.runId) { closeCompare(); return; }
    state.compare = { runId: run.id, laterId: target.dataset.runId }; state.proofViewer = ''; renderPanel(true); return;
  }
  // A declaration in the proof structure opens the source tab at its line.
  if (target.dataset.action === 'jump-declaration' && target.dataset.line && candidateSource(run)) {
    state.proofViewer = ''; state.compare = undefined; state.tab = 'source'; state.sourceView = 'proof';
    renderDetail(true); sourceReader.goToLine(Number(target.dataset.line)); return;
  }
  if (target.dataset.action === 'guide-run') { openGuidance(run); return; }
  if (target.dataset.action === 'approve-plan') { void approvePlan(run); return; }
  if (target.dataset.action === 'show-plan' || target.dataset.action === 'edit-plan' || target.dataset.action === 'guide-lead') {
    state.tab = 'collaboration'; renderDetail(true);
    const shown = target.dataset.action === 'edit-plan' ? collaborationView?.editPlan(run.id)
      : target.dataset.action === 'guide-lead' ? collaborationView?.guideLead(run.id) : false;
    if (!shown) element('#detail-tab-collaboration').focus({ preventScroll: true });
    return;
  }
  if (target.dataset.action === 'show-checked-code' && target.dataset.taskId) {
    state.tab = 'trajectory'; renderDetail(true);
    trajectoryView?.showStep(run.id, 'checked', [target.dataset.taskId]);
    // The step takes focus once the trajectory is read; until then the tab holds it.
    if (!document.activeElement?.closest('.trajectory-workspace')) element('#detail-tab-trajectory').focus({ preventScroll: true });
    return;
  }
  if (target.dataset.action === 'inspect-task' && target.dataset.taskId) {
    state.tab = 'collaboration'; renderDetail(true);
    if (!collaborationView?.showTask(run.id, target.dataset.taskId)) element('#detail-tab-collaboration').focus({ preventScroll: true });
    return;
  }
  if (target.dataset.action === 'show-task-source' && target.dataset.taskId) {
    openTaskSource(run, target.dataset.taskId); return;
  }
  if (target.dataset.action === 'show-statement-review' && target.dataset.taskId) {
    openCollaborationSection(run, 'reviews', target.dataset.taskId); return;
  }
  if (target.dataset.action === 'guide-task' && target.dataset.taskId) {
    if (!isSample(run) && run.status === 'running' && state.connected && run.observation?.inspection.tasks.some(task => task.id === target.dataset.taskId))
      openGuidance(run, undefined, undefined, target.dataset.taskId);
    return;
  }
  if (target.dataset.action === 'diff-prev') updateDiffNavigation(-1);
  if (target.dataset.action === 'diff-next') updateDiffNavigation(1);
  if (target.dataset.action === 'download-proof' && candidateSource(run)) download(proofFileName(run), candidateSource(run), 'text/plain;charset=utf-8');
  if (target.dataset.action === 'download-report' && run.result) download(`${run.id}-report.json`, JSON.stringify(run.result.report, null, 2) + '\n', 'application/json');
});
element('#run-detail').addEventListener('change', event => {
  if ((event.target as HTMLElement).dataset.action === 'compare-folded') {
    state.foldUnchanged = (event.target as HTMLInputElement).checked; renderPanel(true); return;
  }
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
  setMobileView('runs');
  element(`#detail-tab-${state.tab}`).focus({ preventScroll: true });
});
document.querySelectorAll<HTMLButtonElement>('button[data-mobile-view]').forEach(button => button.addEventListener('click', () => setMobileView(button.dataset.mobileView as 'compose' | 'runs')));
document.addEventListener('keydown', event => {
  if (sourceReader.handleKeydown(event)) return;
  const target = event.target as HTMLElement;
  if (target.matches('[data-detail-tab]') && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const tabs: DetailTab[] = detailTabs().map(([tab]) => tab);
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
    selectRun(runs[next].id, false, 'replace');
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-run-id]')).find(button => button.dataset.runId === state.selectedId)?.focus();
  }
});
field('provider').addEventListener('change', providerAddress);
element('#remember-key').addEventListener('change', syncKeyMemory);
field('api-key').addEventListener('input', () => { if (element<HTMLInputElement>('#remember-key').checked) syncKeyMemory(); });
element('#forget-key').addEventListener('click', () => { forgetRememberedKey(); field('api-key').focus(); toast(t('已清除此标签页记住的 API Key')); });
element('#delete-saved-key').addEventListener('click', async () => {
  const providerId = field('provider').value;
  try {
    const result = await api<{ savedKeys: WebSavedKey[] }>(`/api/auth/keys/${encodeURIComponent(providerId)}`, { method: 'DELETE' });
    if (state.session?.account) state.session.account.savedKeys = result.savedKeys;
    providerAddress(); field('api-key').focus(); toast(t('已删除保存的 API Key'));
  } catch (error) { toast(message(error)); }
});
field('environment').addEventListener('change', () => {
  sourceRevision++;
  const usingTemplate = Boolean(field('template').value);
  renderTemplates('', usingTemplate);
  if (usingTemplate) applyTemplate(field('template').value);
  updateEnvironment();
});
field('template').addEventListener('change', () => applyTemplate(field('template').value));
for (const container of ['#run-form', '#inline-problem-fields'])
for (const type of ['input', 'change']) element(container).addEventListener(type, event => {
  const target = event.target as HTMLElement;
  if (target.closest('#module-plan-library, [data-start-cost]')) return;
  // Selects emit input before change; preserve the previous environment and template until replacement finishes.
  if (type === 'input' && ['environment', 'template'].includes(target.id)) return;
  if (target.id !== 'source') draftChanged(target.id !== 'api-key');
});
// A number out of range says so when the reader leaves the field, not only after 开始研究 behind the dialog.
for (const id of ['max-turns', 'max-seconds', 'workers', 'max-tokens'] as const) field(id).addEventListener('change', () => {
  validationShown.add(id); renderPreparation();
});
window.addEventListener('storage', event => {
  if (event.key === modulePlanLibraryStorageKey || event.key === null) modulePlanLibrary.refresh();
});
for (const id of ['source', 'task']) field(id).addEventListener('input', () => {
  field('template').value = '';
  if (id === 'source') sourceChanged(); else updateCounts();
});
element('#import-source').addEventListener('click', () => element<HTMLInputElement>('#source-file').click());
element<HTMLInputElement>('#source-file').addEventListener('change', event => {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  input.value = '';
  if (file) void loadSourceFile(file);
});
/** A chosen or dropped .lean file becomes the original problem; a wrong file is explained beside the inline source. */
async function loadSourceFile(file: File) {
  if (!state.session || state.submitting) return;
  const revision = ++sourceRevision;
  element('#source-error').hidden = true;
  try {
    const source = await readLeanFile(file, state.session.limits.maxSourceBytes);
    if (revision !== sourceRevision || state.submitting) { toast(t('草稿已变化，未导入文件')); return; }
    replaceDraft('source', () => setCustomSource(source));
    chooseEntry('lean'); setMobileView('compose');
    field('source').focus();
    toast(t('Lean 文件已载入'));
  } catch (error) {
    if (revision !== sourceRevision) return;
    element('#source-error').textContent = message(error); element('#source-error').hidden = false;
    if (researchEntry === 'natural') toast(message(error));
    else openSettings('source');
  }
}
// The browser opens a file dropped anywhere it is not handled, in place of the workbench and its draft; here it is the
// same as attaching it. A page-wide hint shows while a file is held over the page; dragover repeats every few hundred
// milliseconds while the pointer is still, so the timer only clears it once the drag has ended without a drop.
let fileDragTimer: ReturnType<typeof setTimeout> | undefined;
const draggingFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'));
function endFileDrag() { clearTimeout(fileDragTimer); document.body.removeAttribute('data-file-drag'); }
// Another dialog (the source editor with its own edits, a confirmation) keeps the draft as it is.
const fileDropBlocked = () => !state.session || state.submitting
  || [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].some(dialog => dialog.id !== 'run-settings');
document.addEventListener('dragover', event => {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  const blocked = fileDropBlocked();
  event.dataTransfer!.dropEffect = blocked ? 'none' : 'copy';
  if (!blocked) document.body.dataset.fileDrag = 'true';
  clearTimeout(fileDragTimer); fileDragTimer = setTimeout(endFileDrag, 1000);
});
document.addEventListener('dragleave', event => { if (!event.relatedTarget) endFileDrag(); });
document.addEventListener('drop', event => {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  endFileDrag();
  const file = event.dataTransfer!.files[0];
  if (!file || fileDropBlocked()) return;
  if (!state.composing) startDraft();
  void loadSourceFile(file);
});
// A whole Lean file pasted into the task is the problem, not a description of it: it replaces the original problem, with
// the usual undo, the same as an imported file (a template's task gives way to the generic one).
element<HTMLTextAreaElement>('#task').addEventListener('paste', event => {
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (!state.session || state.submitting || !looksLikeLeanSource(text) || byteSize(text) > state.session.limits.maxSourceBytes) return;
  event.preventDefault();
  replaceDraft('paste', () => setCustomSource(text.replace(/\r\n?/gu, '\n')));
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
element('#confirm-cancel-run').addEventListener('click', () => {
  const target = cancellationTarget;
  if (!target || target.csrfToken !== state.session?.csrfToken) { renderCancelState(); return; }
  element<HTMLDialogElement>('#cancel-run-dialog').close();
  void cancelRun(target.id);
});
for (const id of ['keep-running', 'close-cancel-run']) element(`#${id}`).addEventListener('click', () => element<HTMLDialogElement>('#cancel-run-dialog').close());
element('#cancel-run-dialog').addEventListener('close', () => {
  cancellationTarget = undefined;
  const active = document.activeElement;
  if (document.querySelector('dialog[open]') || (active && active !== document.body && !element('#cancel-run-dialog').contains(active))) return;
  // The stop button is disabled while the request runs, so focus falls back to the run menu.
  focusFirst(['.detail-actions [data-action="cancel"]', '[data-run-menu]>summary', '#open-draft', '#open-history']);
});
for (const id of ['cancel-delete', 'close-delete']) element(`#${id}`).addEventListener('click', () => {
  if (!deletionTarget || !state.deleting.has(deletionTarget.id)) element<HTMLDialogElement>('#delete-run-dialog').close();
});
element('#delete-run-dialog').addEventListener('cancel', event => {
  if (deletionTarget && state.deleting.has(deletionTarget.id)) event.preventDefault();
});
element('#delete-run-dialog').addEventListener('close', () => {
  const dialog = element<HTMLDialogElement>('#delete-run-dialog');
  if (dialog.open) return;
  const kept = Boolean(deletionTarget && state.runs.some(run => run.id === deletionTarget!.id));
  deletionTarget = undefined;
  const active = document.activeElement;
  if (document.querySelector('dialog[open]') || (active && active !== document.body && !dialog.contains(active))) return;
  // A kept run returns to its menu; a deleted one moves on to the run now selected in its place, so the next can be read or deleted straight away.
  focusFirst(kept ? ['[data-run-menu]>summary', '#run-list [aria-pressed="true"]', '#open-draft', '#open-history']
    : ['#run-list [aria-pressed="true"]', '[data-run-menu]>summary', '#open-draft', '#open-history']);
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
element('#clear-continuation').addEventListener('click', () => {
  draftContinuation = undefined; draftChanged();
  focusProofInstructions(true);
  toast(t('新运行不再从这一版继续'));
});
element('#dismiss-draft-recovery').addEventListener('click', () => {
  draftRecovery.clear(); renderDraftRecovery(); focusProofInstructions(true);
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
  const readiness = element('#submission-readiness');
  if (readiness.dataset.state === 'full') { openHistory(); return; }
  const issue = currentSubmissionIssues()[0];
  // An empty task or a Key nobody has been asked for yet is the next step, not a fault: the field opens without an error under it.
  if (readiness.dataset.state === 'compose') { closeSettings(false); setMobileView('compose'); focusProofInstructions(); }
  else if (issue?.field === 'api-key' && readiness.hasAttribute('data-quiet')) openSettings('api-key');
  else if (issue) focusSubmissionIssue(issue);
  else if (readiness.hasAttribute('data-settled')) openEditor();
  else openSettings();
});
for (const id of ['close-settings', 'apply-settings']) element(`#${id}`).addEventListener('click', () => closeSettings());
element('#run-settings').addEventListener('close', () => {
  renderComposerSummary();
  const policy = moduleSettingsPolicy; moduleSettingsPolicy = undefined;
  const workspace = settingsWorkspaceReturn; settingsWorkspaceReturn = undefined;
  if (!state.submitting && (workspace || policy && !currentRun() && state.draftView === 'modules')) {
    if (workspace?.preview && !currentRun()) {
      document.body.dataset.draftPreview = 'true';
      element('#open-draft-preview').setAttribute('aria-expanded', 'true');
    }
    setMobileView('runs');
    if (workspace?.preview && !currentRun()) renderDraftPreview(true);
    if (workspace?.focus?.getClientRects().length) workspace.focus.focus({ preventScroll: true });
  }
  if (policy && !currentRun() && !state.submitting && state.draftView === 'modules') moduleView?.focusPolicy(policy);
});
element('#run-settings').addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
});
element('#close-history').addEventListener('click', closeHistoryDialog);
element('#open-draft').addEventListener('click', openDraft);
// The run menu closes on a click elsewhere and on Escape, like the browser's own menus.
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('[data-run-menu][open]')) if (!menu.contains(event.target as Node)) menu.open = false;
});
document.addEventListener('keydown', event => {
  const menu = event.target instanceof Element ? event.target.closest<HTMLDetailsElement>('[data-run-menu][open]') : null;
  if (event.key !== 'Escape' || !menu) return;
  event.preventDefault(); menu.open = false; menu.querySelector('summary')?.focus();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || !historyDocked() || historyCollapsed()) return;
  const active = document.activeElement;
  if (!active || !element('#history-sidebar').contains(active)
    || document.querySelector('dialog[open], [data-run-menu][open], [data-navigation-menu][open]')) return;
  // A search field uses its first Escape to clear its query; an empty search returns to the workspace.
  if (active instanceof HTMLInputElement && active.type === 'search' && active.value) return;
  event.preventDefault();
  setHistoryCollapsed(true);
  element('#open-history').focus({ preventScroll: true });
});
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
element('#new-research').addEventListener('click', () => { startDraft(true); void openNaturalResearch(true); });
element('#open-research-examples').addEventListener('click', () => {
  const panel = element('#research-examples-panel');
  panel.hidden = !panel.hidden;
  element('#open-research-examples').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) panel.scrollIntoView({ block: 'start' });
});
element('#open-draft-preview').addEventListener('click', () => {
  document.body.dataset.draftPreview = 'true';
  element('#open-draft-preview').setAttribute('aria-expanded', 'true');
  setMobileView('runs'); renderDraftPreview(true);
  element('#close-draft-preview').focus();
});
outputWideQuery.addEventListener('change', syncOutputCloseLabel);
syncOutputCloseLabel();
element('#expand-research-output').addEventListener('click', () => {
  const expanded = document.body.dataset.resultsExpanded !== 'true';
  document.body.dataset.resultsExpanded = String(expanded);
  element('#expand-research-output').setAttribute('aria-pressed', String(expanded));
  element('#expand-research-output').textContent = expanded ? t('恢复分栏') : t('展开成果');
  syncOutputCloseLabel();
});
element('#close-research-output').addEventListener('click', () => {
  document.body.dataset.resultsExpanded = 'false';
  document.body.dataset.chatArtifact = '';
  element('#expand-research-output').setAttribute('aria-pressed', 'false');
  element('#expand-research-output').textContent = t('展开成果');
  setMobileView('compose');
  if (!chatArtifacts.restore(chatArtifactIdentity())) document.querySelector<HTMLElement>('#formalize-original')?.focus({ preventScroll: true });
});
element('#close-draft-preview').addEventListener('click', () => {
  document.body.dataset.draftPreview = 'false';
  element('#open-draft-preview').setAttribute('aria-expanded', 'false');
  setMobileView('compose'); element('#open-draft-preview').focus();
});
element('#open-natural-language').addEventListener('click', () => { void openNaturalResearch(); });
element('#entry-lean').addEventListener('click', () => { if (!state.submitting) { chooseEntry('lean'); startDraft(); } });
element('#open-formalization').addEventListener('click', event => { event.preventDefault(); void openNaturalResearch(); });
element('#change-natural-problem').addEventListener('click', async () => {
  const original = draftFormalization?.original;
  await openNaturalResearch();
  if (original !== undefined) chatWorkspace?.fillOriginal(original);
});
element('#task-as-original').addEventListener('click', async () => {
  const original = field('task').value;
  if (!original.trim() || state.submitting) return;
  await openNaturalResearch();
  chatWorkspace?.fillOriginal(original);
});
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== window || event.data?.type !== 'theoremos:formalization-confirmed'
    || typeof event.data.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(event.data.id) || state.submitting) return;
  void openFormalizedDraft(event.data.id);
});
element('#edit-draft-source').addEventListener('click', () => openEditor());
element('#attach-source').addEventListener('click', () => element<HTMLInputElement>('#source-file').click());
element('#conversation').addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLElement>('[data-chat-template],[data-chat-action]');
  if (!target) return;
  const template = state.session?.templates.find(item => item.id === target.dataset.chatTemplate);
  if (template) {
    field('environment').value = template.environment;
    renderTemplates(template.id); applyTemplate(template.id); updateEnvironment();
    if (!touchQuery.matches) focusProofInstructions();
    return;
  }
  if (target.dataset.chatAction === 'sample') { void openSample(); return; }
  if (target.dataset.chatAction === 'glossary') openGlossary();
});
// Enter sends from a hardware keyboard; a phone keyboard has no Shift, so there its Enter starts a new line and the button sends.
element<HTMLTextAreaElement>('#task').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.altKey && !touchQuery.matches) {
    event.preventDefault();
    if (!element<HTMLButtonElement>('#submit-run').disabled) element<HTMLFormElement>('#run-form').requestSubmit(element<HTMLButtonElement>('#submit-run'));
  }
});
function resizePane(value: number, persist = false, width = element('.workspace').getBoundingClientRect().width) {
  if (width <= 850) return;
  // The same minimums as the .workspace grid: 300px for the composer, 300px plus the resizer for the preview.
  const minimum = Math.max(28, 300 / width * 100), maximum = Math.min(60, (width - 307) / width * 100);
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
historyQuery.addEventListener('change', () => {
  placeHistory(); renderShell();
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
// Back and Forward open the run the address names, or the new-research page; they never add entries themselves.
window.addEventListener('popstate', () => {
  if (!state.resumed || state.submitting) return;
  const parameters = new URLSearchParams(location.search); parameters.delete('lang');
  const chatId = parameters.get('chat');
  const editedProblem = readEditedProblemId(parameters);
  if (chatId) {
    chooseEntry('natural');
    void naturalPage?.then(() => chatWorkspace?.open(chatId, 'replace'));
    return;
  }
  if (editedProblem) {
    chooseEntry('natural');
    void naturalPage?.then(() => chatWorkspace?.openEditedProblem(editedProblem, undefined, 'replace'));
    return;
  }
  const id = parameters.get('run') ?? '';
  if (id && runIdPattern.test(id) && state.runs.some(run => run.id === id)) {
    if (id !== state.selectedId || state.composing) { selectRun(id, true, 'replace'); setMobileView('runs'); }
  } else if (parameters.size === 1 && parameters.get('sample') === '' && state.session?.sample) { if (!sampleSelected()) void openSample('replace'); }
  else if (!id && !parameters.size) {
    chooseEntry('natural'); startDraft(false, 'replace');
    void naturalPage?.then(() => {
      const currentAddress = new URLSearchParams(location.search); currentAddress.delete('lang');
      if (!currentRun() && !currentAddress.size) chatWorkspace?.home(false);
    });
  }
  else renderDetail();
});
window.addEventListener('storage', event => {
  if (event.key !== 'theorem-os.web-account-left.v1' || !event.newValue || !state.session) return;
  try {
    if (JSON.parse(event.newValue).owner !== ownerOfSession(state.session)) return;
    clearOwnedDrafts(); location.replace('login.html');
  } catch { /* Ignore invalid notifications. */ }
});
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
element('#open-admin').addEventListener('click', () => void openAdmin());
element('#close-admin').addEventListener('click', () => element<HTMLDialogElement>('#admin-dialog').close());
element('#close-glossary').addEventListener('click', () => element<HTMLDialogElement>('#glossary-dialog').close());
element('#logout').addEventListener('click', event => void leaveAccount(() => api('/api/auth/logout', { method: 'POST', body: '{}' }), event.currentTarget as HTMLButtonElement));
field('account-confirm').addEventListener('input', () => {
  element<HTMLButtonElement>('#delete-account').disabled = field('account-confirm').value.trim().toLowerCase() !== state.session?.account?.email;
});
element('#delete-account').addEventListener('click', event => void leaveAccount(() => api('/api/auth/account',
  { method: 'DELETE', body: JSON.stringify({ email: field('account-confirm').value.trim() }) }), event.currentTarget as HTMLButtonElement));
if (readHistoryCollapsed(() => localStorage)) document.body.dataset.historyCollapsed = 'true';
placeHistory();
icons();
localizeSiteLinks();
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => { if (!dialog.open) finishMotion(dialog); }));
void initialize();
