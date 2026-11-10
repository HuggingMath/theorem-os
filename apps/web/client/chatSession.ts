import type { WebConversation, WebConversationMessage, WebConversationRequest, WebConversationSummary } from '../conversationTypes';
import type { WebGuidanceInput } from '../collaboration';
import { webFormalizationDefaults, webFormalizationLimits, type WebFormalization, type WebFormalizationCapabilities } from '../formalizationTypes';
import type { WebRun, WebSavedKey, WebSession } from '../shared';
import { locale, localizeMessage, t } from '../i18n';
import { researchExamples } from '../problemExamples';
import { renderChatComposer, renderChatHistory, renderChatOriginal, renderChatThread, type ChatBudgets, type ChatProvider } from './ui/ChatWorkspace';
import { renderLiveWorkspace } from './ui/LiveWorkspace';
import { ChatReadingPosition } from './chatReadingPosition';
import type { AgentActivity } from './agentActivity';
import type { FormalizationActivityStore } from './formalizationActivityStore';
import { buildSolveProcess, type SolveProcess } from './solveProcess';
import { nextSteps, summarizeGoals } from '../report';
import type { ChatArtifactKind } from './chatArtifactNavigation';
import { clockTime } from './collaborationUi';
import type { PlanApprovalProps } from './ui/RunHeader';
import { decodeChatDraft, encodeChatDraft, type ChatDraft, type ChatDraftSettings, type ChatPendingMessage } from './chatDraft';
import { SubmissionIdentity } from './submissionIdentity';
import { retainLatestRun } from './runSnapshot';
import { statementTemplate } from './productFlow';
import { loadRunGuidanceFeedback } from './runGuidanceFeedback';
import type { ResearchFeedback } from '../researchProjectTypes';

const running = (item?: { status: string }) => item?.status === 'queued' || item?.status === 'running';
const reason = (error: unknown) => localizeMessage(error instanceof Error ? error.message : String(error));
type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
type Options = {
  request: Request;
  draftScope: string;
  keyRequired(providerId: string): boolean;
  session(): WebSession | undefined;
  runs(): readonly WebRun[];
  onOpenRun(id: string): void;
  connected(): boolean;
  onSelection(run?: WebRun): void;
  /** A conversation was opened or replaced; one without a run still names the page. */
  onConversation(): void;
  /** `attached` names the conversation of a run already on screen, which the reader may still be browsing to from the history. */
  onNavigate(id: string, mode: 'push' | 'replace', attached?: boolean): void;
  onArtifact(kind: ChatArtifactKind, target?: { taskId?: string; messageId?: string }, auto?: boolean): void;
  onShare(run: WebRun): void;
  onRecover(run: WebRun, action: string, button: HTMLButtonElement): void;
  onKeysChanged(keys: WebSavedKey[]): void;
  onSample(): void;
  onHistory(): void;
  /** What the formalization and the Agents of this conversation did; both are owner-only reads, so a sample run has none. */
  agentActivity: AgentActivity;
  formalizationActivity: FormalizationActivityStore;
  onLean(): void;
  onGuidance(run: WebRun): void;
  planApproval(run: WebRun): PlanApprovalProps | undefined;
  onApprovePlan(run: WebRun): void;
  onPlan(run: WebRun, edit: boolean): void;
  onCancelRun(run: WebRun): void;
  isSample(run: WebRun): boolean;
};

/** Owns the conversation and its draft. Proof tasks remain independent server jobs. */
export class ChatSession {
  private conversation?: WebConversation;
  private summaries: WebConversationSummary[] = [];
  private historyLoaded = false;
  private historyFailed = false;
  private historyRevision = 0;
  private run?: WebRun;
  private formalization?: WebFormalization;
  private capabilities?: WebFormalizationCapabilities;
  private formalizations: WebFormalization[] = [];
  private capabilitiesRevision = 0;
  private draft = '';
  private environment: 'standard' | 'mathlib' = 'mathlib';
  private effort: 'low' | 'high' | 'max' = 'max';
  private participation: 'guided' | 'automatic' = 'guided';
  private apiKey = '';
  private keyBusy = false;
  private keyNotice = '';
  private providerId = '';
  private model = '';
  private budgets: ChatBudgets = structuredClone(webFormalizationDefaults);
  private hasDraftSettings = false;
  private connection?: { status: 'available' | 'unknown' | 'error'; message: string };
  private checkingConnection = false;
  private connectionRevision = 0;
  private startingResearch = false;
  private loading = false;
  private submitting = false;
  private error = '';
  // A failed read shows until a later read succeeds; a failed send, stop or guidance keeps `error` until the next action.
  private readError = '';
  private guidanceMode = false;
  private guidanceRunId = '';
  private guidanceTarget = '';
  private guidanceVersion?: string;
  private pendingGuidance?: WebGuidanceInput;
  private pendingMessage?: ChatPendingMessage;
  private messageErrorId = '';
  private generation = 0;
  private ownerRevision = 0;
  private readRevision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing = false;
  private lastTaskRefresh = 0;
  private lastListRefresh = 0;
  private attachRunId = '';
  private seed?: WebFormalization;
  private currentId = new URLSearchParams(location.search).get('chat') ?? '';
  private readonly drafts = new Map<string, ChatDraft>();
  private readonly submissionIdentity: SubmissionIdentity;
  private readonly thread = document.querySelector<HTMLElement>('#research-chat-thread')!;
  private readonly composer = document.querySelector<HTMLElement>('#natural-research')!;
  private readonly list = document.querySelector<HTMLElement>('#chat-history-list')!;
  private readonly originalPanel = document.querySelector<HTMLElement>('#chat-original-panel')!;
  private readonly livePanel = document.querySelector<HTMLElement>('#chat-live-panel')!;
  private readonly reading: ChatReadingPosition;
  /** A wide screen has room for the live workspace beside the conversation; a phone shows the checklist only. */
  private readonly wide = matchMedia('(min-width: 1101px)');
  /** The tasks whose live workspace opened by itself, so a redraw does not reopen one the reader closed. */
  private readonly liveShown = new Set<string>();
  /** The check the reader picked in each task's live workspace; without one it follows the latest. */
  private readonly liveSelected = new Map<string, string>();
  private solveCache?: { key: string; process: SolveProcess };
  private liveFrame = false;
  private lastActionPoll = 0;
  private guidanceFeedback = { runId: '', records: [] as ResearchFeedback[], loading: false, error: '', readAt: 0 };

  constructor(private readonly options: Options) {
    this.submissionIdentity = new SubmissionIdentity({
      getItem: key => options.draftScope ? sessionStorage.getItem(`${key}.${options.draftScope}`) : null,
      setItem: (key, value) => { if (options.draftScope) sessionStorage.setItem(`${key}.${options.draftScope}`, value); },
      removeItem: key => { if (options.draftScope) sessionStorage.removeItem(`${key}.${options.draftScope}`); },
    }, 'theorem-os.chat-submission.v1');
    this.reading = new ChatReadingPosition(this.thread, document.querySelector<HTMLButtonElement>('[data-chat-latest]')!, options.draftScope);
    this.reading.select(this.currentId);
    this.draft = this.restoredDraft(this.currentId || 'home');
    this.draw();
    // A read of what the task did redraws the process where it stands; it never starts one by itself.
    options.agentActivity.subscribe(id => { if (id === this.run?.id) this.redraw(); });
    options.formalizationActivity.subscribe(id => { if (id === (this.formalization ?? this.seed)?.id) this.redraw(); });
    this.wide.addEventListener('change', () => this.draw());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void this.refresh(); });
    window.addEventListener('online', () => void this.refresh());
    window.addEventListener('pagehide', () => { this.rememberDraft(); this.apiKey = ''; clearTimeout(this.timer); });
    window.addEventListener('pageshow', event => { if (event.persisted) void this.refresh(); });
  }
  get id() { return this.currentId; }
  get runId() { return this.conversation?.runId ?? this.run?.id; }
  get selected() { return this.conversation; }
  updateOverview() { if (!this.conversation && !this.run) this.draw(); }
  /** An empty scope revokes the current owner while the workbench reconnects. */
  bindOwner(scope: string) {
    if (scope === this.options.draftScope) return;
    const previous = this.options.draftScope;
    this.ownerRevision++; this.readRevision++; this.historyRevision++; this.capabilitiesRevision++;
    clearTimeout(this.timer); this.refreshing = false;
    this.home(true);
    this.drafts.clear(); this.options.draftScope = scope; this.reading.bind(scope);
    try {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith(`theorem-os.chat-draft.${previous}.`) || key.startsWith(`theorem-os.chat-reading.${previous}.`)) sessionStorage.removeItem(key);
      }
    } catch { /* In-memory ownership also resets when storage is unavailable. */ }
    this.summaries = []; this.historyLoaded = false; this.historyFailed = false;
    this.capabilities = undefined; this.formalizations = []; this.providerId = ''; this.model = '';
    this.environment = 'mathlib'; this.effort = 'max'; this.participation = 'guided'; this.budgets = structuredClone(webFormalizationDefaults); this.hasDraftSettings = false;
    this.keyBusy = false; this.guidanceVersion = undefined;
    this.lastTaskRefresh = 0; this.lastListRefresh = 0; this.lastActionPoll = 0;
    this.liveShown.clear(); this.liveSelected.clear(); this.solveCache = undefined;
    this.guidanceFeedback = { runId: '', records: [], loading: false, error: '', readAt: 0 };
    this.draft = scope ? this.restoredDraft('home') : '';
    this.options.onNavigate('', 'replace'); this.options.onSelection(); this.draw();
    if (scope) void this.start();
  }
  private post<T>(url: string, body?: unknown) {
    return this.options.request<T>(url, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async start(run?: WebRun) {
    const owner = this.ownerRevision;
    const route = this.currentId;
    const initial = this.loadCapabilities();
    if (route) await this.open(route, 'replace');
    else if (run) await this.openRun(run);
    await initial;
    if (owner !== this.ownerRevision) return;
    await this.refreshHistory();
    if (owner === this.ownerRevision) this.schedule();
  }
  private async loadCapabilities() {
    const revision = ++this.capabilitiesRevision;
    try {
      const data = await this.options.request<{ formalizations: WebFormalization[]; generation: WebFormalizationCapabilities }>('/api/formalizations');
      if (revision !== this.capabilitiesRevision) return;
      this.capabilities = data.generation; this.formalizations = data.formalizations;
      if (!this.providerId) {
        this.providerId = data.generation.providerId ?? data.generation.providers?.[0]?.id ?? this.options.session()?.providers[0]?.id ?? '';
        if (!this.model) this.model = data.generation.model;
        if (!this.hasDraftSettings && data.generation.defaults) this.budgets = structuredClone(data.generation.defaults);
      }
      // A conversation that failed to open keeps its own error.
      if (!this.currentId || this.conversation) this.readError = '';
      this.draw();
    } catch (error) { if (revision === this.capabilitiesRevision) { this.readError = reason(error); this.draw(); } }
  }
  private rememberDraft() {
    // Samples and a run whose conversation is still attaching do not own the home draft.
    if (!this.options.draftScope || this.run && !this.conversation) return;
    const id = this.currentId || 'home';
    const settings: ChatDraftSettings = { providerId: this.providerId, model: this.model, environment: this.environment,
      effort: this.effort, participation: this.participation, ...structuredClone(this.budgets) };
    const draft: ChatDraft = { text: this.draft, settings,
      ...(this.guidanceMode && this.guidanceRunId ? { guidance: { runId: this.guidanceRunId,
        ...(this.guidanceTarget && this.guidanceVersion ? { taskRef: { id: this.guidanceTarget, version: this.guidanceVersion } } : {}) } } : {}),
      ...(this.pendingMessage ? { pendingMessage: { ...this.pendingMessage } } : {}) };
    this.drafts.set(id, draft); this.hasDraftSettings = true;
    try { sessionStorage.setItem(`theorem-os.chat-draft.${this.options.draftScope}.${id}`, encodeChatDraft(draft)); } catch { /* In-memory draft remains. */ }
  }
  private restoredDraft(id: string) {
    let draft = this.drafts.get(id);
    if (!draft) try {
      const raw = sessionStorage.getItem(`theorem-os.chat-draft.${this.options.draftScope}.${id}`);
      if (raw !== null) draft = decodeChatDraft(raw);
    } catch { /* In-memory drafts remain available. */ }
    if (draft?.settings) {
      const { providerId, model, environment, effort, participation, maxRunSeconds, maxTotalTokens, research } = draft.settings;
      Object.assign(this, { providerId, model, environment, effort, participation });
      this.budgets = { maxRunSeconds, maxTotalTokens, research: { ...research } }; this.hasDraftSettings = true;
    }
    this.guidanceMode = Boolean(draft?.guidance);
    this.guidanceRunId = draft?.guidance?.runId ?? '';
    this.guidanceTarget = draft?.guidance?.taskRef?.id ?? '';
    this.guidanceVersion = draft?.guidance?.taskRef?.version;
    this.pendingMessage = draft?.pendingMessage ? { ...draft.pendingMessage } : undefined;
    this.messageErrorId = '';
    return draft?.text ?? '';
  }
  private providers(): ChatProvider[] {
    const providers = this.capabilities?.providers ?? (this.options.session()?.providers ?? []).map(provider => ({ ...provider,
      defaultModel: provider.id === this.capabilities?.providerId ? this.capabilities.model : '',
      key: this.options.keyRequired(provider.id) ? 'required' as const : 'saved' as const }));
    const account = this.options.session()?.account;
    return account ? providers.map(provider => ({ ...provider, key: account.savedKeys?.some(key => key.providerId === provider.id) ? 'saved'
      : account.serverKeys?.includes(provider.id) ? 'server' : 'required' })) : providers;
  }
  private async manageKey(method: 'PUT' | 'DELETE') {
    if (this.keyBusy || !this.options.session()?.account?.keyVault) return;
    const providerId = this.activeProviderId(), key = this.apiKey, generation = this.generation;
    if (method === 'PUT' && !key.trim()) return;
    const owner = this.options.session()?.draftOwner, ownerRevision = this.ownerRevision;
    this.keyBusy = true; this.keyNotice = ''; this.draw();
    try {
      const { savedKeys } = await this.options.request<{ savedKeys: WebSavedKey[] }>(`/api/auth/keys/${encodeURIComponent(providerId)}`,
        { method, ...(method === 'PUT' ? { body: JSON.stringify({ apiKey: key.trim() }) } : {}) });
      if (ownerRevision !== this.ownerRevision || this.options.session()?.draftOwner !== owner) return;
      this.options.onKeysChanged(savedKeys);
      if (generation === this.generation && providerId === this.activeProviderId()) {
        if (this.apiKey === key) this.apiKey = '';
        this.keyNotice = method === 'PUT' ? t('Key 已保存到你的账号') : t('已删除账号中保存的 Key');
        this.clearConnection();
      }
    } catch (error) {
      if (generation === this.generation && providerId === this.activeProviderId()) this.keyNotice = reason(error);
    } finally { if (ownerRevision === this.ownerRevision) { this.keyBusy = false; this.draw(); } }
  }
  private activeProviderId() { return this.run?.providerId ?? this.formalization?.providerId ?? this.providerId; }
  private activeModel() { return this.run?.model ?? this.formalization?.model ?? this.model; }
  private clearConnection() { this.connectionRevision++; this.connection = undefined; this.checkingConnection = false; }
  private async checkConnection() {
    if (this.checkingConnection) return;
    const revision = ++this.connectionRevision;
    this.checkingConnection = true; this.connection = undefined; this.draw();
    try {
      const result = await this.post<{ status: 'available' | 'unknown'; message: string }>(`/api/providers/${encodeURIComponent(this.activeProviderId())}/check`,
        { apiKey: this.apiKey, model: this.activeModel() });
      if (revision === this.connectionRevision) this.connection = { ...result, message: reason(result.message) };
    } catch (error) { if (revision === this.connectionRevision) this.connection = { status: 'error', message: reason(error) }; }
    finally { if (revision === this.connectionRevision) { this.checkingConnection = false; this.draw(); } }
  }
  private async startResearch(confirmStatement = false) {
    const item = this.formalization;
    if (!item || item.runId || this.startingResearch || (item.status !== 'confirmed'
      && !(confirmStatement && item.humanReview && item.status === 'review' && item.report))) return;
    if (!this.apiKey && this.options.keyRequired(this.activeProviderId())) {
      this.error = t('请在设置中填写 API Key 后发送。'); this.draw();
      const settings = this.composer.querySelector<HTMLDetailsElement>('#formalize-settings');
      if (settings) settings.open = true;
      this.composer.querySelector<HTMLInputElement>('#formalize-key')?.focus();
      return;
    }
    const generation = this.generation;
    this.readRevision++; this.startingResearch = true; this.error = ''; this.draw();
    try {
      if (item.status === 'review') {
        const { formalization } = await this.post<{ formalization: WebFormalization }>(`/api/formalizations/${item.id}/confirm`,
          { evidenceSha256: item.report!.evidenceSha256 });
        if (generation !== this.generation) return;
        this.formalization = formalization;
        this.formalizations = this.formalizations.map(record => record.id === formalization.id ? formalization : record);
        this.draw();
      }
      const { formalization } = await this.post<{ formalization: WebFormalization }>(`/api/formalizations/${item.id}/research`, { apiKey: this.apiKey });
      if (generation !== this.generation) return;
      this.formalization = formalization;
      this.formalizations = this.formalizations.map(record => record.id === formalization.id ? formalization : record);
      if (this.conversation) {
        const { conversation } = await this.options.request<{ conversation: WebConversation }>(`/api/conversations/${this.currentId}`);
        if (generation !== this.generation) return;
        this.setConversation(conversation); await this.loadTask(generation);
      }
    } catch (error) { if (generation === this.generation) this.error = reason(error); }
    finally { if (generation === this.generation) { this.startingResearch = false; this.draw(); this.schedule(); } }
  }
  home(reset = true) {
    this.reading.select('');
    this.rememberDraft(); this.generation++; this.currentId = ''; this.conversation = undefined;
    this.run = undefined; this.formalization = undefined; this.seed = undefined;
    this.guidanceMode = false; this.guidanceRunId = ''; this.pendingGuidance = undefined; this.guidanceTarget = ''; this.guidanceVersion = undefined;
    this.attachRunId = ''; this.loading = false; this.submitting = false; this.error = ''; this.readError = ''; this.apiKey = ''; this.keyNotice = ''; this.startingResearch = false; this.clearConnection();
    this.draft = reset ? '' : this.restoredDraft('home');
    if (reset) { this.pendingMessage = undefined; this.messageErrorId = ''; }
    if (reset) { this.submissionIdentity.clear(); this.rememberDraft(); }
    document.body.dataset.chatArtifact = '';
    document.body.dataset.outputOpen = 'false';
    this.draw(); this.options.onConversation();
  }
  fillOriginal(original: string) { this.draft = original; this.rememberDraft(); this.draw(); this.focus(); }
  prepareOriginal(original: string, environment: 'standard' | 'mathlib') {
    this.home(false); this.environment = environment; this.fillOriginal(original);
    requestAnimationFrame(() => this.composer.querySelector<HTMLTextAreaElement>('textarea')?.scrollIntoView({ block: 'center', behavior: 'instant' }));
  }
  revealMessage(id: string) {
    const message = this.thread.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    if (!message) return false;
    this.thread.querySelectorAll('.chat-search-target').forEach(element => element.classList.remove('chat-search-target'));
    message.classList.add('chat-search-target'); message.tabIndex = -1;
    message.scrollIntoView({ block: 'center', behavior: 'instant' }); message.focus({ preventScroll: true });
    this.reading.capture(); return true;
  }
  useRunKey(id: string, key: string) { if (this.runId === id) { this.apiKey = key; this.clearConnection(); this.draw(); } }
  focus() { this.composer.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }); }
  private setConversation(conversation: WebConversation) {
    this.reading.select(conversation.id);
    this.conversation = conversation; this.currentId = conversation.id; this.readError = ''; this.options.onConversation();
    const message = this.pendingMessage;
    if (message && conversation.messages.some(item => item.role === 'user' && item.kind === 'text' && item.requestId === message.requestId)) {
      // The receipt can arrive through a refresh after the POST response was lost. Only consume its own draft.
      this.pendingMessage = undefined;
      if (!this.guidanceMode && this.draft === message.text) this.draft = '';
      if (this.messageErrorId === message.requestId) { this.error = ''; this.messageErrorId = ''; }
      this.rememberDraft();
    }
    const pending = this.pendingGuidance;
    const status = pending && conversation.messages.find(message => message.guidance?.input.id === pending.id)?.guidance?.receipt?.status;
    if (pending && status && status !== 'unknown') {
      this.pendingGuidance = undefined; this.error = '';
      if (['queued', 'delivered', 'deferred'].includes(status) && this.draft.trim() === pending.text) {
        this.draft = ''; this.guidanceMode = false; this.rememberDraft();
      }
    }
    this.draw();
  }
  async open(id: string, mode: 'push' | 'replace' = 'push') {
    if (this.currentId === id && this.conversation) { this.options.onNavigate(id, mode); this.focus(); return; }
    this.reading.select(id);
    this.rememberDraft(); const generation = ++this.generation;
    this.currentId = id; this.conversation = undefined; this.run = undefined; this.formalization = undefined;
    this.guidanceMode = false; this.guidanceRunId = ''; this.pendingGuidance = undefined; this.guidanceTarget = ''; this.guidanceVersion = undefined;
    this.seed = undefined; this.attachRunId = '';
    this.loading = true; this.submitting = false; this.error = ''; this.readError = ''; this.apiKey = ''; this.keyNotice = ''; this.startingResearch = false; this.clearConnection();
    this.draft = this.restoredDraft(id);
    this.options.onNavigate(id, mode); this.options.onSelection(); this.draw();
    try {
      const { conversation } = await this.options.request<{ conversation: WebConversation }>(`/api/conversations/${encodeURIComponent(id)}`);
      if (generation !== this.generation) return;
      this.setConversation(conversation);
      await this.loadTask(generation);
    } catch (error) { if (generation === this.generation) this.readError = reason(error); }
    finally { if (generation === this.generation) { this.loading = false; this.draw(); this.schedule(); } }
  }
  async openRun(run: WebRun) {
    if (this.runId === run.id && this.conversation) { this.observe(run); return; }
    if (this.attachRunId === run.id) { this.observe(run); return; }
    this.reading.select('');
    this.rememberDraft(); const generation = ++this.generation, owner = this.ownerRevision;
    this.currentId = ''; this.conversation = undefined; this.run = run; this.formalization = undefined;
    this.guidanceMode = false; this.guidanceRunId = ''; this.pendingGuidance = undefined; this.guidanceTarget = ''; this.guidanceVersion = undefined;
    this.pendingMessage = undefined; this.messageErrorId = '';
    this.seed = undefined; this.attachRunId = run.id;
    this.loading = !this.options.isSample(run); this.error = ''; this.readError = ''; this.draft = ''; this.apiKey = ''; this.keyNotice = ''; this.submitting = false; this.startingResearch = false; this.clearConnection();
    this.draw();
    if (this.options.isSample(run)) return;
    try {
      const { conversation } = await this.post<{ conversation: WebConversation }>('/api/conversations', { runId: run.id });
      if (generation !== this.generation) return;
      this.draft = this.restoredDraft(conversation.id); this.setConversation(conversation);
      this.options.onNavigate(conversation.id, 'replace', true);
      await this.loadTask(generation);
      if (owner === this.ownerRevision) await this.refreshHistory();
    } catch (error) { if (generation === this.generation) this.error = reason(error); }
    finally { if (generation === this.generation) { this.loading = false; this.draw(); this.schedule(); } }
  }
  observe(run: WebRun) {
    if (this.runId !== run.id) return;
    this.run = retainLatestRun(run, this.run); this.draw();
  }
  private async loadTask(generation: number) {
    const conversation = this.conversation, revision = this.readRevision;
    if (!conversation) return;
    this.lastTaskRefresh = Date.now();
    const [formal, run] = await Promise.allSettled([
      conversation.formalizationId ? this.options.request<{ formalization: WebFormalization }>(`/api/formalizations/${conversation.formalizationId}`) : undefined,
      conversation.runId ? this.options.request<{ run: WebRun }>(`/api/runs/${conversation.runId}`) : undefined,
    ]);
    if (generation !== this.generation || revision !== this.readRevision) return;
    const failed = [formal, run].find(result => result.status === 'rejected'
      && !(result.reason && typeof result.reason === 'object' && result.reason.status === 404));
    if (failed?.status === 'rejected') throw failed.reason;
    this.formalization = formal.status === 'fulfilled' ? formal.value?.formalization : undefined;
    if (this.formalization) this.formalizations = [this.formalization, ...this.formalizations.filter(item => item.id !== this.formalization!.id)];
    const received = run.status === 'fulfilled' ? run.value?.run : undefined;
    const next = received && retainLatestRun(received, this.run);
    const hadRun = this.run;
    this.run = next;
    if (next || hadRun) this.options.onSelection(next);
    this.draw();
  }
  async refreshHistory() {
    const revision = ++this.historyRevision;
    try {
      const { conversations } = await this.options.request<{ conversations: WebConversationSummary[] }>('/api/conversations');
      if (revision !== this.historyRevision) return;
      this.summaries = conversations; this.historyLoaded = true; this.historyFailed = false; this.drawHistory(); this.updateOverview();
    } catch {
      // Keep a loaded history on a transient read error; one never loaded says so instead of looking empty.
      if (revision === this.historyRevision && !this.historyLoaded) { this.historyFailed = true; this.drawHistory(); }
    }
  }
  private schedule() {
    clearTimeout(this.timer);
    if (!this.options.draftScope) return;
    const pending = this.conversation?.messages.some(message => message.status === 'pending');
    // A completed formalization can overtake the conversation response that first linked it.
    // Keep refreshing until that conversation has also attached the proof run.
    const unlinkedRun = Boolean(this.formalization?.runId && this.conversation && !this.conversation.runId);
    // Nothing in progress: a slow check, since returning to the tab refreshes at once. A fast idle poll on every open tab
    // reached the site's per-address request limit.
    this.timer = setTimeout(() => void this.refresh(), pending ? 500 : running(this.run) || running(this.formalization) || unlinkedRun ? 1500 : 30_000);
  }
  async refresh() {
    if (!this.options.draftScope) return;
    if (this.refreshing || this.submitting || this.startingResearch || document.hidden) { this.schedule(); return; }
    this.refreshing = true; const generation = this.generation, revision = this.readRevision, owner = this.ownerRevision;
    try {
      if (this.currentId && !this.loading) {
        const { conversation } = await this.options.request<{ conversation: WebConversation }>(`/api/conversations/${this.currentId}`);
        if (generation !== this.generation || revision !== this.readRevision) return;
        const runChanged = conversation.runId !== this.conversation?.runId;
        this.setConversation(conversation);
        if (runChanged || Date.now() - this.lastTaskRefresh >= 1500) await this.loadTask(generation);
      }
      if (generation !== this.generation) return;
      if (Date.now() - this.lastListRefresh >= 6000) {
        this.lastListRefresh = Date.now();
        await this.loadCapabilities();
        if (owner === this.ownerRevision) await this.refreshHistory();
      }
    } catch (error) { if (generation === this.generation && revision === this.readRevision) { this.readError = reason(error); this.draw(); } }
    finally { if (owner === this.ownerRevision) { this.refreshing = false; this.schedule(); } }
  }
  private async submit(retryText?: string, prepareEditedProblem = false) {
    if (!this.options.draftScope) return;
    if (this.guidanceMode && retryText === undefined) { await this.sendGuidance(); return; }
    if (this.loading || this.submitting || !(this.pendingMessage?.text ?? retryText ?? this.draft).trim()) return;
    // A received task can be reattached without starting it again. Editing its original instead needs an explicit choice.
    if (this.seed && retryText === undefined && this.draft !== this.seed.original) { this.draw(); return; }
    const generation = this.generation, owner = this.ownerRevision, seed = this.seed, conversation = this.conversation, key = this.apiKey;
    const message = conversation ? this.pendingMessage ?? { requestId: crypto.randomUUID(), text: retryText ?? this.draft } : undefined;
    const text = seed?.original ?? message?.text ?? retryText ?? this.draft;
    if (conversation?.messages.some(message => message.kind === 'text' && message.status === 'pending')) return;
    this.readRevision++; this.submitting = true; this.error = ''; this.draw();
    try {
      let next: WebConversation;
      let requestId: string | undefined;
      if (conversation) {
        this.pendingMessage = message; this.messageErrorId = ''; this.rememberDraft();
        const input: WebConversationRequest = { text, apiKey: key, requestId: message!.requestId };
        ({ conversation: next } = await this.post<{ conversation: WebConversation }>(`/api/conversations/${conversation.id}/messages`, input));
      } else {
        const settings = { providerId: this.providerId, model: this.model.trim(), environment: this.environment, effort: this.effort, ...this.budgets,
          ...(this.participation === 'guided' ? { humanReview: true } : {}) };
        const input = { original: text, ...settings, apiKey: key, solve: true };
        let formalization = seed;
        if (!formalization) {
          requestId = await this.submissionIdentity.prepare(input);
          if (owner !== this.ownerRevision) return;
          ({ formalization } = await this.post<{ formalization: WebFormalization }>('/api/formalizations', { ...input, requestId }));
          if (owner !== this.ownerRevision) return;
          const createdId = formalization.id;
          this.formalizations = [formalization, ...this.formalizations.filter(item => item.id !== createdId)];
          if (generation === this.generation) this.seed = formalization;
        }
        ({ conversation: next } = await this.post<{ conversation: WebConversation }>('/api/conversations', { formalizationId: formalization.id }));
      }
      if (owner !== this.ownerRevision) return;
      // Persist the originating conversation even if the user has already opened a new one.
      void this.refreshHistory();
      if (generation !== this.generation) return;
      if (requestId) this.submissionIdentity.clear(requestId);
      else if (seed) this.submissionIdentity.clear();
      const editedProblem = Boolean(seed && this.draft !== text);
      if (!conversation && this.draft === text) this.draft = '';
      if (!conversation) this.rememberDraft();
      // Changes made while recovering the old task belong to the next problem, not to that task's discussion.
      if (editedProblem) this.draft = '';
      this.seed = undefined;
      this.setConversation(next); this.rememberDraft();
      this.options.onNavigate(next.id, conversation ? 'replace' : 'push');
      const settings = this.composer.querySelector<HTMLDetailsElement>('#formalize-settings');
      if (settings) settings.open = false;
      await this.loadTask(generation);
      if (generation !== this.generation) return;
      if (prepareEditedProblem && editedProblem) {
        this.home(false); this.options.onNavigate('', 'push'); this.options.onSelection(); this.focus(); this.schedule();
        return;
      }
      this.reading.bottom(); this.focus();
    } catch (error) {
      if (generation === this.generation) {
        this.error = reason(error);
        if (message) {
          this.messageErrorId = message.requestId;
          // A definitive refusal did not accept this send. Let the reader correct its draft or key.
          const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
          if (typeof status === 'number' && status >= 400 && status < 500 && this.pendingMessage?.requestId === message.requestId) {
            this.pendingMessage = undefined; this.messageErrorId = ''; this.rememberDraft();
          }
        }
      }
    }
    finally { if (generation === this.generation) { this.submitting = false; this.draw(); this.schedule(); } }
  }
  private async stop() {
    const id = this.currentId, generation = this.generation;
    if (!id || this.submitting) return;
    this.readRevision++; this.submitting = true; this.draw();
    try {
      const { conversation } = await this.post<{ conversation: WebConversation }>(`/api/conversations/${id}/stop`);
      if (generation === this.generation) this.setConversation(conversation);
    } catch (error) { if (generation === this.generation) this.error = reason(error); }
    finally { if (generation === this.generation) { this.submitting = false; this.draw(); } }
  }
  private beginGuidance(text?: string, taskId = '') {
    this.guidanceMode = true; this.selectGuidanceTarget(taskId);
    if (text !== undefined) this.draft = text;
    this.rememberDraft();
    this.error = ''; this.draw(); this.focus();
  }
  private selectGuidanceTarget(id: string) {
    this.guidanceRunId = this.run?.id ?? '';
    this.guidanceTarget = id;
    this.guidanceVersion = this.run?.observation?.inspection.tasks.find(task => task.id === id)?.version;
  }
  private async sendGuidance(retry?: WebGuidanceInput) {
    const conversation = this.conversation, run = this.run, observation = run?.observation, generation = this.generation, owner = this.ownerRevision;
    if (!conversation || !run || this.submitting) return;
    const input = retry ?? this.pendingGuidance;
    const task = observation?.inspection.tasks.find(item => item.id === this.guidanceTarget);
    if (!input && (!this.draft.trim() || !observation || run.status !== 'running')) return;
    if (!input && this.guidanceRunId !== run.id) {
      this.error = t('指导关联的研究已变化，请重新选择指导对象。'); this.draw(); return;
    }
    if (!input && this.guidanceTarget && (!task || task.version !== this.guidanceVersion)) {
      this.error = t('任务版本已变化，请核对指导内容，再确认当前任务版本。'); this.draw(); return;
    }
    const guidance: WebGuidanceInput = input ?? { id: crypto.randomUUID(), text: this.draft.trim(),
      recipient: task ? { kind: 'task', id: task.id } : { kind: 'lead' },
      ...(task ? { taskRef: { id: task.id, version: task.version } } : {}),
      observationRef: { sequence: observation!.sequence, stateDigest: observation!.snapshot.stateDigest } };
    this.pendingGuidance = guidance; this.readRevision++; this.submitting = true; this.error = ''; this.draw();
    try {
      const { conversation: next } = await this.post<{ conversation: WebConversation }>(`/api/conversations/${conversation.id}/guidance`, guidance);
      if (owner !== this.ownerRevision) return;
      void this.refreshHistory();
      if (generation !== this.generation) return;
      const message = next.messages.find(item => item.guidance?.input.id === guidance.id);
      const status = message?.guidance?.receipt?.status;
      if (status && status !== 'unknown') this.pendingGuidance = undefined;
      if (status && ['queued', 'delivered', 'deferred'].includes(status)) {
        if (this.draft.trim() === guidance.text) this.draft = '';
        this.guidanceMode = false; this.rememberDraft();
      }
      this.setConversation(next); await this.loadTask(generation);
      if (generation === this.generation) this.reading.bottom();
    } catch (error) { if (generation === this.generation) this.error = reason(error); }
    finally { if (generation === this.generation) { this.submitting = false; this.draw(); this.schedule(); } }
  }
  private recoverGuidance(message: WebConversationMessage) { if (message.guidance) void this.sendGuidance(message.guidance.input); }
  private async cancelTask() {
    if (this.run) { this.options.onCancelRun(this.run); return; }
    const id = this.formalization?.id, generation = this.generation;
    if (!id) return;
    this.readRevision++;
    try {
      const { formalization } = await this.post<{ formalization: WebFormalization }>(`/api/formalizations/${id}/cancel`);
      if (generation === this.generation) {
        this.readRevision++; this.capabilitiesRevision++;
        this.formalization = formalization;
        this.formalizations = this.formalizations.map(item => item.id === id ? formalization : item);
        this.draw();
      }
    } catch (error) { if (generation === this.generation) { this.error = reason(error); this.draw(); } }
  }
  private drawHistory() {
    renderChatHistory(this.list, { items: this.summaries, selectedId: this.currentId, onOpen: id => void this.open(id),
      failed: this.historyFailed, onRetry: () => void this.refreshHistory(),
      onRename: (id, title) => this.renameConversation(id, title), onDelete: id => this.deleteConversation(id),
      records: this.formalizations, recordLimit: this.capabilities?.limits.recordsPerOwner ?? webFormalizationLimits.recordsPerOwner,
      onRefreshRecords: () => void this.loadCapabilities(), onDeleteRecord: id => this.deleteRecord(id) });
  }
  private async renameConversation(id: string, title: string) {
    const owner = this.ownerRevision;
    try {
      const { conversation } = await this.options.request<{ conversation: WebConversation }>(`/api/conversations/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify({ title }) });
      if (owner !== this.ownerRevision) return;
      this.historyRevision++;
      this.summaries = this.summaries.map(item => item.id === id ? { ...item, title: conversation.title, updatedAt: conversation.updatedAt } : item);
      if (this.currentId === id && this.conversation) this.setConversation({ ...this.conversation, title: conversation.title });
      this.drawHistory();
    } catch (error) { if (owner === this.ownerRevision) throw new Error(reason(error)); }
  }
  private async deleteConversation(id: string) {
    const owner = this.ownerRevision;
    try {
      try { await this.options.request(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
      catch (error) {
        if (owner !== this.ownerRevision) return;
        // A lost DELETE response is resolved by reading the list before offering another action.
        const { conversations } = await this.options.request<{ conversations: WebConversationSummary[] }>('/api/conversations');
        if (owner !== this.ownerRevision) return;
        this.summaries = conversations;
        if (conversations.some(item => item.id === id)) throw error;
      }
      if (owner !== this.ownerRevision) return;
      this.historyRevision++;
      this.summaries = this.summaries.filter(item => item.id !== id);
      if (this.currentId === id) { this.home(false); this.options.onNavigate('', 'replace'); this.options.onSelection(); }
      this.drafts.delete(id);
      try {
        sessionStorage.removeItem(`theorem-os.chat-draft.${this.options.draftScope}.${id}`);
        sessionStorage.removeItem(`theorem-os.chat-reading.${this.options.draftScope}.${id}`);
      } catch { /* Server deletion does not depend on browser storage. */ }
      this.drawHistory();
    } catch (error) { if (owner === this.ownerRevision) throw new Error(reason(error)); }
  }
  private async deleteRecord(id: string) {
    const owner = this.ownerRevision;
    try {
      try { await this.options.request(`/api/formalizations/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
      catch (error) {
        if (owner !== this.ownerRevision) return;
        const { formalizations } = await this.options.request<{ formalizations: WebFormalization[] }>('/api/formalizations');
        if (owner !== this.ownerRevision) return;
        this.formalizations = formalizations;
        if (formalizations.some(item => item.id === id)) throw error;
      }
      if (owner !== this.ownerRevision) return;
      this.capabilitiesRevision++;
      this.formalizations = this.formalizations.filter(item => item.id !== id);
      if (this.formalization?.id === id) { this.formalization = undefined; this.draw(); }
      this.drawHistory();
    } catch (error) { if (owner === this.ownerRevision) throw new Error(reason(error)); }
  }
  private openRecords() {
    this.options.onHistory();
    const details = this.list.querySelector<HTMLDetailsElement>('#chat-problem-records');
    if (details) { details.open = true; details.querySelector<HTMLElement>('summary')?.focus(); details.scrollIntoView({ block: 'nearest' }); }
  }
  private useExample(id: string) {
    const example = researchExamples.find(item => item.id === id);
    if (example) { this.environment = example.environment; this.fillOriginal(locale === 'en' ? example.originalEn : example.original); }
  }
  private refreshGuidanceFeedback(force = false) {
    const runId = this.run?.id;
    if (!runId || this.options.isSample(this.run!) || !this.conversation?.messages.some(message => message.guidance?.runId === runId)) return;
    if (this.guidanceFeedback.runId === runId && (this.guidanceFeedback.loading || !force && Date.now() - this.guidanceFeedback.readAt < 12_000)) return;
    const owner = this.ownerRevision;
    const state: typeof this.guidanceFeedback = { runId, records: this.guidanceFeedback.runId === runId ? this.guidanceFeedback.records : [], loading: true, error: '', readAt: Date.now() };
    this.guidanceFeedback = state;
    void loadRunGuidanceFeedback(runId, this.options.request).then(records => {
      if (owner === this.ownerRevision && this.guidanceFeedback === state) state.records = records;
    }).catch(error => {
      if (owner === this.ownerRevision && this.guidanceFeedback === state) state.error = reason(error);
    }).finally(() => {
      if (owner === this.ownerRevision && this.guidanceFeedback === state) { state.loading = false; this.draw(); }
    });
  }
  /** One more frame at most: a store notifies once per page it reads, and a keystroke redraws on top of that. */
  private redraw() {
    if (this.liveFrame) return;
    this.liveFrame = true;
    requestAnimationFrame(() => { this.liveFrame = false; this.draw(); });
  }
  /**
   * The task's solving process, rebuilt only when something it reads changed: the run and its events, what the Agents
   * and the formalization did, the selected task's routes. A sample run has no server to read from, so it keeps none.
   */
  private solve(): { process: SolveProcess; loading?: boolean; failed?: boolean; wide: boolean; time: (at: string) => string; onRetry?(): void; onCheck?(id: string): void } | undefined {
    const item = this.formalization ?? this.seed, run = this.run, sample = run && this.options.isSample(run);
    if (!item && !run) return;
    const agents = this.options.agentActivity, roles = this.options.formalizationActivity;
    // Reads what is not read yet; a running task also asks for its newest actions now and then, off the fast poll.
    const poll = run?.status === 'running' && Date.now() - this.lastActionPoll >= 3_000;
    if (item && !sample) roles.sync(item);
    if (run && !sample) { if (poll) this.lastActionPoll = Date.now(); agents.sync(run, poll); }
    const state = item ? roles.state(item.id) : undefined, activity = item && !sample ? roles.activity(item.id) : [];
    const records = run && !sample ? agents.records(run) : { events: run?.events ?? [], actions: [] };
    const routes = run && !sample ? agents.routes(run, run.observation?.inspection.workers.find(worker => worker.role === 'Lead')?.id) : [];
    const key = JSON.stringify([run?.id, run?.status, run?.updatedAt, records.events.length, records.events.at(-1)?.sequence ?? 0,
      records.actions.length, routes.map(route => `${route.workerId}:${route.steps.length}`).join(','),
      item?.id, item?.status, item?.updatedAt, item?.activity?.count ?? 0, activity.length, state?.version ?? 0]);
    if (this.solveCache?.key !== key) this.solveCache = { key, process: buildSolveProcess({
      ...(item ? { formalization: item } : {}), ...(activity.length ? { activity } : {}), ...(state ? { activityDropped: state.dropped } : {}),
      ...(run && !sample ? { run, events: records.events, routes } : {}),
    }) };
    const process = this.solveCache.process;
    const onRetry = () => { if (item && state?.failed) roles.retry(item); if (run && !sample && agents.state(run.id).failed) agents.retry(run); this.draw(); };
    return { process, wide: this.wide.matches, time: clockTime, onRetry,
      ...(state?.loading || (run && !sample && agents.state(run.id).loading) ? { loading: true } : {}),
      ...(state?.failed || (run && !sample && agents.state(run.id).failed) ? { failed: true } : {}),
      ...(this.wide.matches ? { onCheck: (id: string) => this.openCheck(process, id) } : {}) };
  }
  private draw() {
    this.refreshGuidanceFeedback();
    const pending = Boolean(this.conversation?.messages.some(message => message.kind === 'text' && message.status === 'pending'));
    const canDecide = !!this.run && ['queued', 'running'].includes(this.run.status) && this.run.coordination === 'cooperative'
      && this.run.workers > 1 && !this.options.isSample(this.run);
    const canGuide = canDecide && !!this.conversation && this.run?.status === 'running' && !!this.run.observation?.plan;
    const task = this.run?.observation?.inspection.tasks.find(item => item.id === this.guidanceTarget);
    const staleTarget = !!this.guidanceTarget && (!task || task.version !== this.guidanceVersion);
    const guidanceRunChanged = this.guidanceMode && this.guidanceRunId !== this.run?.id;
    const unresolvedGuidance = !!this.pendingGuidance || this.conversation?.messages.some(message => message.kind === 'guidance' && message.status === 'pending');
    const newProblem = !this.conversation && !this.run;
    const editedSubmission = newProblem && !!this.seed && this.draft !== this.seed.original;
    const pendingSubmission = newProblem && this.submissionIdentity.unresolved;
    const busyFormalization = newProblem && !this.seed && !pendingSubmission && this.formalizations.some(item => running(item));
    const unavailable = newProblem && !pendingSubmission && this.capabilities?.available === false;
    document.body.dataset.chatEmpty = String(!this.conversation && !this.run && !this.loading && !this.seed);
    const solve = this.solve();
    // A task that just started opens its workspace once; one the reader closed stays closed until they open it again.
    // A task still waiting for its place only has the checklist: its result panel stays the reader's. The reader's own
    // results panel is never replaced behind their back, so the workspace only opens while the conversation is shown.
    if (solve?.process.active && (solve.process.state === 'formalizing' || solve.process.state === 'proving')
      && solve.wide && document.body.dataset.view !== 'run' && !this.liveShown.has(solve.process.key)
      && !document.body.dataset.chatArtifact && document.body.dataset.outputOpen !== 'true') {
      this.liveShown.add(solve.process.key);
      queueMicrotask(() => { if (this.solve()?.process.key === solve.process.key) this.options.onArtifact('live', undefined, true); });
    }
    renderChatThread(this.thread, {
      conversation: this.conversation, run: this.run, formalization: this.formalization ?? this.seed,
      sample: !!this.run && this.options.isSample(this.run),
      missingTask: !!this.conversation && !this.loading && !this.submitting && !this.readError && !this.formalization && !this.run,
      loading: this.loading, error: this.error || this.readError, ...(solve ? { solve } : {}),
      onConfigure: () => {
        const settings = this.composer.querySelector<HTMLDetailsElement>('#formalize-settings');
        if (settings) settings.open = true;
        this.composer.querySelector<HTMLSelectElement>('#formalize-provider')?.focus();
      },
      onFirstExample: () => this.useExample('add-zero'),
      startGuide: { onTemplate: () => this.fillOriginal(this.draft.trim() ? this.draft : statementTemplate()), onLean: this.options.onLean,
        ready: !!this.activeModel().trim() && (!this.options.keyRequired(this.activeProviderId()) || !!this.apiKey.trim()) },
      overview: { owner: this.options.draftScope, runs: this.options.runs(), conversations: this.summaries, formalizations: this.formalizations,
        request: this.options.request, onOpenRun: this.options.onOpenRun, onOpenConversation: id => void this.open(id) },
      ...(this.options.session()?.sample ? { onSample: this.options.onSample } : {}),
      ...(this.error === t('形式化记录已满，请先删除不需要的记录。') ? { onManageRecords: () => this.openRecords() } : {}),
      onArtifact: (kind, target, auto) => { this.reading.capture(); this.drawOriginal(); this.options.onArtifact(kind, target, auto); },
      ...(this.run && !this.options.isSample(this.run) ? {
        onShare: () => this.options.onShare(this.run!),
        recovery: { steps: nextSteps(this.run, summarizeGoals(this.run)), limits: this.options.session()?.limits,
          onAction: (action: string, button: HTMLButtonElement) => this.options.onRecover(this.run!, action, button) },
      } : {}),
      ...(canGuide ? { onGuidance: (text?: string, taskId?: string) => this.beginGuidance(text, taskId) } : {}),
      ...(canDecide ? { planDecision: { approval: this.options.planApproval(this.run!), connected: this.options.connected(),
        onReview: () => this.options.onPlan(this.run!, false), onEdit: () => this.options.onPlan(this.run!, true),
        onApprove: () => this.options.onApprovePlan(this.run!) } } : {}),
      onGuidanceReceipt: message => this.recoverGuidance(message),
      guidanceFeedback: { ...this.guidanceFeedback, records: this.guidanceFeedback.runId === this.run?.id ? this.guidanceFeedback.records : [],
        onRetry: () => { this.refreshGuidanceFeedback(true); this.draw(); } },
      ...(this.formalization?.humanReview && this.formalization.status === 'review'
        ? { onConfirmStatement: () => void this.startResearch(true), startingResearch: this.startingResearch } : {}),
      ...(this.formalization?.status === 'confirmed' && !this.formalization.runId && (this.formalization.humanReview || this.formalization.researchError)
        ? { onStartResearch: () => void this.startResearch(), startingResearch: this.startingResearch } : {}),
      ...(running(this.formalization) || running(this.run) && !this.options.isSample(this.run!) ? { onCancelTask: () => void this.cancelTask() } : {}),
      onEditProblem: () => {
        const original = this.formalization?.original ?? this.run?.formalization?.original ?? this.conversation?.messages.find(message => message.role === 'user')?.text ?? '';
        this.home(); this.options.onNavigate('', 'push'); this.options.onSelection(); this.fillOriginal(original);
      },
      onRetry: editedSubmission ? undefined : () => {
        if (this.pendingGuidance) void this.sendGuidance(this.pendingGuidance);
        else if (this.pendingMessage && this.conversation) void this.submit(this.pendingMessage.text);
        else if (this.currentId && !this.conversation) { const id = this.currentId; this.currentId = ''; void this.open(id, 'replace'); }
        else if (this.run && !this.conversation) { const run = this.run; this.attachRunId = ''; void this.openRun(run); }
        else if (this.seed) void this.submit(this.seed.original);
        else if (!this.conversation && !this.run && this.submissionIdentity.unresolved) void this.submit();
        else if (this.conversation?.messages.at(-1)?.status === 'error') {
          const last = this.conversation.messages.at(-1)!;
          const question = this.conversation.messages.find(message => message.id === last.replyTo);
          if (question) void this.submit(question.text);
        } else { this.lastListRefresh = 0; void this.refresh(); }
      },
    });
    renderChatComposer(this.composer, {
      input: this.draft, onInput: value => { this.draft = value; this.rememberDraft(); this.draw(); },
      onSubmit: () => void this.submit(), onStop: () => void this.stop(), pending: pending && !this.guidanceMode, submitting: this.submitting,
      disabled: this.loading || Boolean(this.run && this.options.isSample(this.run)) || Boolean(this.currentId && !this.conversation)
        || editedSubmission
        || !this.guidanceMode && !pendingSubmission && !this.pendingMessage && Boolean(this.options.session()?.maintenance)
        || newProblem && ((!this.capabilities?.available && !pendingSubmission) || busyFormalization)
        || this.guidanceMode && (!canGuide || !this.run?.observation || guidanceRunChanged || staleTarget || !!unresolvedGuidance),
      hasConversation: Boolean(this.conversation), newProblem, environment: this.environment, effort: this.effort, apiKey: this.apiKey,
      ...(editedSubmission ? { submissionRecovery: { busy: this.submitting,
        onRecover: () => void this.submit(this.seed!.original),
        onPrepareEdited: () => void this.submit(this.seed!.original, true) } } : {}),
      participation: this.participation, participationLocked: Boolean(this.seed || this.submissionIdentity.unresolved || this.run),
      onParticipation: value => { this.participation = value; this.rememberDraft(); this.draw(); },
      keyRequired: this.guidanceMode || pendingSubmission || this.pendingMessage ? false : this.options.keyRequired(this.activeProviderId()),
      providers: this.providers(), providerId: this.activeProviderId(), model: this.activeModel(),
      onProvider: value => { this.providerId = value; this.model = this.providers().find(item => item.id === value)?.defaultModel ?? ''; this.apiKey = ''; this.keyNotice = ''; this.clearConnection(); this.rememberDraft(); this.draw(); },
      onModel: value => { this.model = value; this.clearConnection(); this.rememberDraft(); this.draw(); },
      quota: this.options.session()?.quota,
      budgets: this.budgets, budgetLimits: { maxRunSeconds: this.capabilities?.limits.maxRunSeconds ?? 1800,
        maxTotalTokens: this.capabilities?.limits.maxTotalTokens || 2_000_000,
        research: { maxRunSeconds: this.options.session()?.limits.maxRunSeconds ?? 900, maxTurns: this.options.session()?.limits.maxTurns ?? 20,
          maxTotalTokens: this.options.session()?.limits.maxTotalTokens ?? 100_000_000 } },
      onBudget: (stage, field, value) => {
        if (stage === 'research') this.budgets = { ...this.budgets, research: { ...this.budgets.research, [field]: value } };
        else if (field !== 'maxTurns') this.budgets = { ...this.budgets, [field]: value };
        this.rememberDraft(); this.draw();
      },
      checkingConnection: this.checkingConnection, connection: this.connection, onCheckConnection: () => void this.checkConnection(),
      ...(this.options.session()?.account?.keyVault ? { keyManagement: { busy: this.keyBusy,
        ending: this.options.session()?.account?.savedKeys?.find(key => key.providerId === this.activeProviderId())?.ending,
        notice: this.keyNotice, onSave: () => void this.manageKey('PUT'), onDelete: () => void this.manageKey('DELETE') } } : {}),
      ...(canGuide ? { onGuidance: () => this.beginGuidance() } : {}),
      ...(this.guidanceMode ? { guidance: { target: this.guidanceTarget,
        targets: (this.run?.observation?.inspection.tasks ?? []).map(item => ({ id: item.id, label: item.theorem || item.objective || item.id })),
        onTarget: (id: string) => { this.selectGuidanceTarget(id); this.rememberDraft(); this.draw(); },
        onCancel: () => { this.guidanceMode = false; this.rememberDraft(); this.draw(); this.focus(); },
        ...(staleTarget && task ? { onConfirmTarget: () => { this.selectGuidanceTarget(task.id); this.error = ''; this.rememberDraft(); this.draw(); } } : {}),
      } } : {}),
      sendStatus: this.guidanceMode ? unresolvedGuidance ? t('先核对上一条研究指导的回执。')
        : guidanceRunChanged ? t('指导关联的研究已变化，请重新选择指导对象。')
        : staleTarget ? t('任务版本已变化，请核对指导内容，再确认当前任务版本。')
          : !canGuide ? t('运行尚未开始或已结束，暂时无法发送指导。')
            : !this.run?.observation ? t('正在等待当前运行的观察记录，收到后即可发送。') : t('指导会交给研究组参考，送达状态会显示在对话中。')
        : this.pendingMessage ? t('上一条问题的发送结果尚未确认，重试会先核对原问题；新输入会保留。')
        : this.options.session()?.maintenance ? t('工作台正在维护，暂不开始新任务或回答；已有记录仍可查看和下载。')
        : busyFormalization ? t("上一道题正在形式化，你可以先写下一条消息。")
        : unavailable ? this.capabilities?.reason === 'provider'
          ? t('当前服务未配置自然语言解题的模型，请联系管理员；也可切换到 Lean 输入。')
          : this.options.session()?.runtime.ready
            ? t('当前服务暂不支持自然语言解题，可切换到 Lean 输入。')
            : t('运行环境暂未就绪，原题会保留；恢复后可继续发送。')
        : newProblem && !this.capabilities ? t("正在连接…") : canGuide ? t('讨论用于交流思路；想调整研究，请切换到「指导研究」。') : undefined,
      onEnvironment: value => { this.environment = value; this.rememberDraft(); this.draw(); }, onEffort: value => { this.effort = value; this.rememberDraft(); this.draw(); },
      onKey: value => { this.apiKey = value; this.keyNotice = ''; this.clearConnection(); this.draw(); },
      onExample: id => this.useExample(id),
      onLean: this.options.onLean,
    });
    this.reading.rendered();
    this.drawHistory(); this.drawOriginal(); this.drawLive(solve);
  }
  private drawOriginal() { renderChatOriginal(this.originalPanel, { formalization: this.formalization, run: this.run }); }
  /** The panel beside the conversation; it keeps the process it was last drawn with while the task did not change. */
  private drawLive(solve: ReturnType<ChatSession['solve']>) {
    const process = solve?.process, run = this.run;
    renderLiveWorkspace(this.livePanel, { process, time: clockTime, onSelect: id => this.selectCheck(process, id),
      ...(run && !this.options.isSample(run) ? { onRoadmap: () => this.options.onArtifact('roadmap') } : {}),
      ...(process && this.liveSelected.has(process.key) ? { selected: this.liveSelected.get(process.key)! } : {}) });
  }
  private selectCheck(process: SolveProcess | undefined, id: string | undefined) {
    if (process) {
      if (id) this.liveSelected.set(process.key, id); else this.liveSelected.delete(process.key);
    }
    this.draw();
  }
  /** A row's Lean check opens beside the conversation, reading from where the reader was. */
  private openCheck(process: SolveProcess, id: string) {
    this.liveSelected.set(process.key, id);
    if (document.body.dataset.chatArtifact !== 'live') { this.reading.capture(); this.options.onArtifact('live'); }
    this.draw();
  }
}
