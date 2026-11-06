import type { WebConversation, WebConversationMessage, WebConversationSummary } from '../conversationTypes';
import type { WebGuidanceInput } from '../collaboration';
import type { WebFormalization, WebFormalizationCapabilities } from '../formalizationTypes';
import type { WebRun } from '../shared';
import { locale, localizeMessage, t } from '../i18n';
import { researchExamples } from '../problemExamples';
import { renderChatComposer, renderChatHistory, renderChatOriginal, renderChatThread } from './ui/ChatWorkspace';
import { ChatReadingPosition } from './chatReadingPosition';
import { SubmissionIdentity } from './submissionIdentity';

const running = (item?: { status: string }) => item?.status === 'queued' || item?.status === 'running';
const reason = (error: unknown) => localizeMessage(error instanceof Error ? error.message : String(error));
type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
type Options = {
  request: Request;
  draftScope: string;
  keyRequired(providerId: string): boolean;
  onSelection(run?: WebRun): void;
  /** A conversation was opened or replaced; one without a run still names the page. */
  onConversation(): void;
  /** `attached` names the conversation of a run already on screen, which the reader may still be browsing to from the history. */
  onNavigate(id: string, mode: 'push' | 'replace', attached?: boolean): void;
  onArtifact(kind: 'roadmap' | 'original' | 'source', target?: { taskId?: string; messageId?: string }): void;
  onLean(): void;
  onGuidance(run: WebRun): void;
  onCancelRun(run: WebRun): void;
  isSample(run: WebRun): boolean;
};

/** Owns the conversation and its draft. Proof tasks remain independent server jobs. */
export class ChatSession {
  private conversation?: WebConversation;
  private summaries: WebConversationSummary[] = [];
  private historyLoaded = false;
  private historyFailed = false;
  private run?: WebRun;
  private formalization?: WebFormalization;
  private capabilities?: WebFormalizationCapabilities;
  private formalizations: WebFormalization[] = [];
  private draft = '';
  private environment: 'standard' | 'mathlib' = 'mathlib';
  private effort: 'low' | 'high' | 'max' = 'max';
  private apiKey = '';
  private loading = false;
  private submitting = false;
  private error = '';
  // A failed read shows until a later read succeeds; a failed send, stop or guidance keeps `error` until the next action.
  private readError = '';
  private guidanceMode = false;
  private guidanceTarget = '';
  private guidanceVersion?: string;
  private pendingGuidance?: WebGuidanceInput;
  private generation = 0;
  private readRevision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing = false;
  private lastTaskRefresh = 0;
  private lastListRefresh = 0;
  private attachRunId = '';
  private seed?: WebFormalization;
  private readonly submission: SubmissionIdentity;
  private currentId = new URLSearchParams(location.search).get('chat') ?? '';
  private readonly drafts = new Map<string, string>();
  private readonly thread = document.querySelector<HTMLElement>('#research-chat-thread')!;
  private readonly composer = document.querySelector<HTMLElement>('#natural-research')!;
  private readonly list = document.querySelector<HTMLElement>('#chat-history-list')!;
  private readonly originalPanel = document.querySelector<HTMLElement>('#chat-original-panel')!;
  private readonly reading: ChatReadingPosition;

  constructor(private readonly options: Options) {
    this.submission = new SubmissionIdentity(sessionStorage, `theorem-os.chat-submission.${options.draftScope}`);
    try {
      const settings = JSON.parse(sessionStorage.getItem(`theorem-os.chat-settings.${options.draftScope}`) ?? 'null');
      if (settings?.environment === 'standard') this.environment = 'standard';
      if (['low', 'high', 'max'].includes(settings?.effort)) this.effort = settings.effort;
    } catch { /* Defaults remain usable without stored settings. */ }
    this.reading = new ChatReadingPosition(this.thread, document.querySelector<HTMLButtonElement>('[data-chat-latest]')!, options.draftScope);
    this.reading.select(this.currentId);
    this.draft = this.restoredDraft(this.currentId || 'home');
    this.draw();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void this.refresh(); });
    window.addEventListener('online', () => void this.refresh());
    window.addEventListener('pagehide', () => { this.rememberDraft(); this.apiKey = ''; clearTimeout(this.timer); });
    window.addEventListener('pageshow', event => { if (event.persisted) void this.refresh(); });
  }
  get id() { return this.currentId; }
  get runId() { return this.conversation?.runId ?? this.run?.id; }
  get selected() { return this.conversation; }
  private post<T>(url: string, body?: unknown) {
    return this.options.request<T>(url, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async start(run?: WebRun) {
    const route = this.currentId;
    const initial = this.loadCapabilities();
    if (route) await this.open(route, 'replace');
    else if (run) await this.openRun(run);
    await initial;
    await this.refreshHistory();
    this.schedule();
  }
  private async loadCapabilities() {
    try {
      const data = await this.options.request<{ formalizations: WebFormalization[]; generation: WebFormalizationCapabilities }>('/api/formalizations');
      this.capabilities = data.generation; this.formalizations = data.formalizations;
      // A conversation that failed to open keeps its own error.
      if (!this.currentId || this.conversation) this.readError = '';
      this.draw();
    } catch (error) { this.readError = reason(error); this.draw(); }
  }
  private rememberDraft() {
    const id = this.currentId || 'home';
    this.drafts.set(id, this.draft);
    try {
      sessionStorage.setItem(`theorem-os.chat-draft.${this.options.draftScope}.${id}`, this.draft);
      sessionStorage.setItem(`theorem-os.chat-settings.${this.options.draftScope}`, JSON.stringify({ environment: this.environment, effort: this.effort }));
    } catch { /* In-memory draft remains. */ }
  }
  private restoredDraft(id: string) {
    try { return this.drafts.get(id) ?? sessionStorage.getItem(`theorem-os.chat-draft.${this.options.draftScope}.${id}`) ?? ''; } catch { return this.drafts.get(id) ?? ''; }
  }
  home(reset = true) {
    this.reading.select('');
    this.rememberDraft(); this.generation++; this.currentId = ''; this.conversation = undefined;
    this.run = undefined; this.formalization = undefined; this.seed = undefined;
    this.guidanceMode = false; this.pendingGuidance = undefined; this.guidanceTarget = '';
    this.attachRunId = ''; this.loading = false; this.submitting = false; this.error = ''; this.readError = ''; this.apiKey = '';
    this.draft = reset ? '' : this.restoredDraft('home');
    if (reset) { this.submission.clear(); this.drafts.set('home', ''); this.rememberDraft(); }
    document.body.dataset.chatArtifact = '';
    document.body.dataset.outputOpen = 'false';
    this.draw(); this.options.onConversation();
  }
  fillOriginal(original: string) { if (this.draft !== original) { this.seed = undefined; this.submission.clear(); } this.draft = original; this.rememberDraft(); this.draw(); this.focus(); }
  useRunKey(id: string, key: string) { if (this.runId === id) { this.apiKey = key; this.draw(); } }
  focus() { this.composer.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }); }
  private setConversation(conversation: WebConversation) {
    this.reading.select(conversation.id);
    this.conversation = conversation; this.currentId = conversation.id; this.readError = ''; this.options.onConversation();
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
    this.guidanceMode = false; this.pendingGuidance = undefined; this.guidanceTarget = '';
    this.seed = undefined; this.attachRunId = '';
    this.loading = true; this.submitting = false; this.error = ''; this.readError = ''; this.apiKey = '';
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
    this.rememberDraft(); const generation = ++this.generation;
    this.currentId = ''; this.conversation = undefined; this.run = run; this.formalization = undefined;
    this.guidanceMode = false; this.pendingGuidance = undefined; this.guidanceTarget = '';
    this.seed = undefined; this.attachRunId = run.id;
    this.loading = !this.options.isSample(run); this.error = ''; this.readError = ''; this.draft = ''; this.apiKey = ''; this.submitting = false;
    this.draw();
    if (this.options.isSample(run)) return;
    try {
      const { conversation } = await this.post<{ conversation: WebConversation }>('/api/conversations', { runId: run.id });
      if (generation !== this.generation) return;
      this.draft = this.restoredDraft(conversation.id); this.setConversation(conversation);
      this.options.onNavigate(conversation.id, 'replace', true);
      await this.loadTask(generation); await this.refreshHistory();
    } catch (error) { if (generation === this.generation) this.error = reason(error); }
    finally { if (generation === this.generation) { this.loading = false; this.draw(); this.schedule(); } }
  }
  observe(run: WebRun) {
    if (this.runId !== run.id) return;
    this.run = run; this.draw();
  }
  private async loadTask(generation: number) {
    const conversation = this.conversation;
    if (!conversation) return;
    this.lastTaskRefresh = Date.now();
    const [formal, run] = await Promise.allSettled([
      conversation.formalizationId ? this.options.request<{ formalization: WebFormalization }>(`/api/formalizations/${conversation.formalizationId}`) : undefined,
      conversation.runId ? this.options.request<{ run: WebRun }>(`/api/runs/${conversation.runId}`) : undefined,
    ]);
    if (generation !== this.generation) return;
    const failed = [formal, run].find(result => result.status === 'rejected'
      && !(result.reason && typeof result.reason === 'object' && result.reason.status === 404));
    if (failed?.status === 'rejected') throw failed.reason;
    this.formalization = formal.status === 'fulfilled' ? formal.value?.formalization : undefined;
    const next = run.status === 'fulfilled' ? run.value?.run : undefined;
    const hadRun = this.run;
    this.run = next;
    if (next || hadRun) this.options.onSelection(next);
    this.draw();
  }
  async refreshHistory() {
    try {
      const { conversations } = await this.options.request<{ conversations: WebConversationSummary[] }>('/api/conversations');
      this.summaries = conversations; this.historyLoaded = true; this.historyFailed = false; this.drawHistory();
    } catch {
      // Keep a loaded history on a transient read error; one never loaded says so instead of looking empty.
      if (!this.historyLoaded) { this.historyFailed = true; this.drawHistory(); }
    }
  }
  private schedule() {
    clearTimeout(this.timer);
    const pending = this.conversation?.messages.some(message => message.status === 'pending');
    // Nothing in progress: a slow check, since returning to the tab refreshes at once. A fast idle poll on every open tab
    // reached the site's per-address request limit.
    this.timer = setTimeout(() => void this.refresh(), pending ? 500 : running(this.run) || running(this.formalization) ? 1500 : 30_000);
  }
  async refresh() {
    if (this.refreshing || this.submitting || document.hidden) { this.schedule(); return; }
    this.refreshing = true; const generation = this.generation, revision = this.readRevision;
    try {
      if (this.currentId && !this.loading) {
        const { conversation } = await this.options.request<{ conversation: WebConversation }>(`/api/conversations/${this.currentId}`);
        if (generation !== this.generation || revision !== this.readRevision) return;
        const runChanged = conversation.runId !== this.conversation?.runId;
        this.setConversation(conversation);
        if (runChanged || Date.now() - this.lastTaskRefresh >= 1500) await this.loadTask(generation);
      }
      if (Date.now() - this.lastListRefresh >= 6000) {
        this.lastListRefresh = Date.now();
        await this.loadCapabilities(); await this.refreshHistory();
      }
    } catch (error) { if (generation === this.generation) { this.readError = reason(error); this.draw(); } }
    finally { this.refreshing = false; this.schedule(); }
  }
  private async submit(retryText?: string) {
    if (this.guidanceMode && retryText === undefined) { await this.sendGuidance(); return; }
    if (this.loading || this.submitting || !(retryText ?? this.draft).trim()) return;
    const generation = this.generation, text = this.seed?.original ?? retryText ?? this.draft, conversation = this.conversation, key = this.apiKey;
    if (conversation?.messages.some(message => message.kind === 'text' && message.status === 'pending')) return;
    this.readRevision++; this.submitting = true; this.error = ''; this.draw();
    try {
      let next: WebConversation;
      if (conversation) {
        ({ conversation: next } = await this.post<{ conversation: WebConversation }>(`/api/conversations/${conversation.id}/messages`, { text, apiKey: key }));
      } else {
        // The server reconciles the same persisted identity, including after a lost response and reload.
        const input = { original: text, environment: this.environment, effort: this.effort, apiKey: key, solve: true };
        const requestId = await this.submission.prepare(input);
        if (generation !== this.generation) return;
        let formalization = this.seed;
        if (!formalization) {
          ({ formalization } = await this.post<{ formalization: WebFormalization }>('/api/formalizations', { ...input, requestId }));
          if (generation === this.generation) this.seed = formalization;
        }
        ({ conversation: next } = await this.post<{ conversation: WebConversation }>('/api/conversations', { formalizationId: formalization.id }));
        this.submission.clear(requestId);
      }
      // Persist the originating conversation even if the user has already opened a new one.
      void this.refreshHistory();
      if (generation !== this.generation) return;
      if (this.draft === text) this.draft = '';
      if (!conversation) { this.drafts.set('home', ''); try { sessionStorage.removeItem(`theorem-os.chat-draft.${this.options.draftScope}.home`); } catch {} }
      this.seed = undefined;
      this.setConversation(next); this.rememberDraft();
      this.options.onNavigate(next.id, conversation ? 'replace' : 'push');
      const settings = this.composer.querySelector<HTMLDetailsElement>('#formalize-settings');
      if (settings) settings.open = false;
      await this.loadTask(generation);
      this.reading.bottom(); this.focus();
    } catch (error) { if (generation === this.generation) this.error = reason(error); }
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
    if (text !== undefined) { this.draft = text; this.rememberDraft(); }
    this.error = ''; this.draw(); this.focus();
  }
  private selectGuidanceTarget(id: string) {
    this.guidanceTarget = id;
    this.guidanceVersion = this.run?.observation?.inspection.tasks.find(task => task.id === id)?.version;
  }
  private async sendGuidance(retry?: WebGuidanceInput) {
    const conversation = this.conversation, run = this.run, observation = run?.observation, generation = this.generation;
    if (!conversation || !run || this.submitting) return;
    const input = retry ?? this.pendingGuidance;
    const task = observation?.inspection.tasks.find(item => item.id === this.guidanceTarget);
    if (!input && (!this.draft.trim() || !observation || run.status !== 'running')) return;
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
      void this.refreshHistory();
      if (generation !== this.generation) return;
      const message = next.messages.find(item => item.guidance?.input.id === guidance.id);
      const status = message?.guidance?.receipt?.status;
      if (status && status !== 'unknown') this.pendingGuidance = undefined;
      if (status && ['queued', 'delivered', 'deferred'].includes(status)) {
        if (this.draft.trim() === guidance.text) this.draft = '';
        this.guidanceMode = false; this.rememberDraft();
      }
      this.setConversation(next); await this.loadTask(generation); this.reading.bottom();
    } catch (error) { if (generation === this.generation) this.error = reason(error); }
    finally { if (generation === this.generation) { this.submitting = false; this.draw(); this.schedule(); } }
  }
  private recoverGuidance(message: WebConversationMessage) { if (message.guidance) void this.sendGuidance(message.guidance.input); }
  private async cancelTask() {
    if (this.run) { this.options.onCancelRun(this.run); return; }
    const id = this.formalization?.id, generation = this.generation;
    if (!id) return;
    try {
      const { formalization } = await this.post<{ formalization: WebFormalization }>(`/api/formalizations/${id}/cancel`);
      if (generation === this.generation) { this.formalization = formalization; this.draw(); }
    } catch (error) { if (generation === this.generation) { this.error = reason(error); this.draw(); } }
  }
  private drawHistory() {
    renderChatHistory(this.list, { items: this.summaries, selectedId: this.currentId, onOpen: id => void this.open(id),
      failed: this.historyFailed, onRetry: () => void this.refreshHistory() });
  }
  private draw() {
    const pending = Boolean(this.conversation?.messages.some(message => message.kind === 'text' && message.status === 'pending'));
    const canGuide = !!this.conversation && this.run?.status === 'running' && this.run.coordination === 'cooperative' && !this.options.isSample(this.run);
    const task = this.run?.observation?.inspection.tasks.find(item => item.id === this.guidanceTarget);
    const staleTarget = !!this.guidanceTarget && (!task || task.version !== this.guidanceVersion);
    const unresolvedGuidance = !!this.pendingGuidance || this.conversation?.messages.some(message => message.kind === 'guidance' && message.status === 'pending');
    const newProblem = !this.conversation && !this.run;
    const busyFormalization = newProblem && !this.seed && !this.submission.hasPending && !!this.capabilities
      && this.formalizations.filter(item => running(item)).length >= this.capabilities.limits.perOwner;
    document.body.dataset.chatEmpty = String(!this.conversation && !this.run && !this.loading && !this.seed);
    renderChatThread(this.thread, {
      conversation: this.conversation, run: this.run, formalization: this.formalization ?? this.seed,
      loading: this.loading, error: this.error || this.readError,
      onArtifact: (kind, target) => { this.reading.capture(); this.drawOriginal(); this.options.onArtifact(kind, target); },
      ...(canGuide ? { onGuidance: (text?: string, taskId?: string) => this.beginGuidance(text, taskId) } : {}),
      onGuidanceReceipt: message => this.recoverGuidance(message),
      ...(running(this.formalization) || running(this.run) && !this.options.isSample(this.run!) ? { onCancelTask: () => void this.cancelTask() } : {}),
      onEditProblem: () => {
        const original = this.formalization?.original ?? this.run?.formalization?.original ?? '';
        this.home(); this.options.onNavigate('', 'push'); this.options.onSelection(); this.fillOriginal(original);
      },
      onRetry: () => {
        if (this.pendingGuidance) void this.sendGuidance(this.pendingGuidance);
        else if (this.currentId && !this.conversation) { const id = this.currentId; this.currentId = ''; void this.open(id, 'replace'); }
        else if (this.seed || this.submission.hasPending) void this.submit();
        else if (this.run && !this.conversation) { const run = this.run; this.attachRunId = ''; void this.openRun(run); }
        else if (this.conversation?.messages.at(-1)?.status === 'error') {
          const last = this.conversation.messages.at(-1)!;
          const question = this.conversation.messages.find(message => message.id === last.replyTo);
          if (question) void this.submit(question.text);
        } else { this.lastListRefresh = 0; void this.refresh(); }
      },
    });
    renderChatComposer(this.composer, {
      input: this.draft, onInput: value => { if (this.draft !== value) { this.seed = undefined; this.submission.clear(); } this.draft = value; this.rememberDraft(); this.draw(); },
      onSubmit: () => void this.submit(), onStop: () => void this.stop(), pending: pending && !this.guidanceMode, submitting: this.submitting,
      disabled: this.loading || Boolean(this.run && this.options.isSample(this.run)) || Boolean(this.currentId && !this.conversation)
        || newProblem && (!this.capabilities?.available && !this.submission.hasPending || busyFormalization)
        || this.guidanceMode && (!canGuide || !this.run?.observation || staleTarget || !!unresolvedGuidance),
      hasConversation: Boolean(this.conversation), environment: this.environment, effort: this.effort, apiKey: this.apiKey,
      keyRequired: this.guidanceMode || newProblem && this.submission.hasPending ? false : this.run ? this.options.keyRequired(this.run.providerId) : this.capabilities?.key === 'required',
      ...(canGuide ? { onGuidance: () => this.beginGuidance() } : {}),
      ...(this.guidanceMode ? { guidance: { target: this.guidanceTarget,
        targets: (this.run?.observation?.inspection.tasks ?? []).map(item => ({ id: item.id, label: item.theorem || item.objective || item.id })),
        onTarget: (id: string) => { this.selectGuidanceTarget(id); this.draw(); },
        onCancel: () => { this.guidanceMode = false; this.draw(); this.focus(); },
        ...(staleTarget && task ? { onConfirmTarget: () => { this.selectGuidanceTarget(task.id); this.error = ''; this.draw(); } } : {}),
      } } : {}),
      sendStatus: this.guidanceMode ? unresolvedGuidance ? t('先核对上一条证明要求的回执。')
        : staleTarget ? t('任务版本已变化，请核对指导内容，再确认当前任务版本。')
          : !canGuide ? t('运行尚未开始或已结束，暂时无法发送指导。')
            : !this.run?.observation ? t('正在等待当前运行的观察记录，收到后即可发送。') : t('要求将发送给证明任务，投递状态会留在对话中。')
        : busyFormalization ? t("当前账号的形式化队列已满，输入内容会保留。")
        : newProblem && !this.capabilities ? t("正在连接…") : undefined,
      onEnvironment: value => { if (this.environment !== value) { this.seed = undefined; this.submission.clear(); } this.environment = value; this.rememberDraft(); this.draw(); }, onEffort: value => { if (this.effort !== value) { this.seed = undefined; this.submission.clear(); } this.effort = value; this.rememberDraft(); this.draw(); },
      onKey: value => { this.apiKey = value; this.draw(); },
      onExample: id => {
        const example = researchExamples.find(item => item.id === id);
        if (example) { this.seed = undefined; this.submission.clear(); this.environment = example.environment; this.fillOriginal(locale === 'en' ? example.originalEn : example.original); }
      },
      onLean: this.options.onLean,
    });
    this.reading.rendered();
    this.drawHistory(); this.drawOriginal();
  }
  private drawOriginal() { renderChatOriginal(this.originalPanel, { formalization: this.formalization, run: this.run }); }
}
