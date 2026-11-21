type Position = { messageId?: string; offset: number; atBottom: boolean };
export const chatReadingReveal = 'chat-reading-reveal';

/** Reading follows a message, so later math layout and expanded code do not move the reader. */
export class ChatReadingPosition {
  private id = '';
  private position: Position = { offset: 0, atBottom: true };
  private applying = false;
  private frame = 0;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private content?: Element;
  private observer: ResizeObserver;
  constructor(private thread: HTMLElement, private latest: HTMLButtonElement, private scope: string) {
    this.observer = new ResizeObserver(() => this.restore());
    thread.addEventListener('scroll', event => {
      if (event.target === thread) {
        if (this.applying) return;
        if (this.measure()) {
          clearTimeout(this.saveTimer);
          this.saveTimer = setTimeout(() => this.save(), 200);
        }
      }
      this.updateButton();
    }, { capture: true, passive: true });
    thread.addEventListener('toggle', () => this.updateButton(), true);
    thread.addEventListener(chatReadingReveal, () => this.revealed());
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) thread.addEventListener(type, () => { this.applying = false; }, { passive: true });
    latest.addEventListener('click', () => this.bottom());
    window.addEventListener('pagehide', () => this.capture());
  }
  private key() { return `theorem-os.chat-reading.${this.scope}.${this.id}`; }
  bind(scope: string) {
    clearTimeout(this.saveTimer); this.saveTimer = undefined;
    this.id = ''; this.scope = scope;
    this.position = { offset: 0, atBottom: true };
    this.updateButton();
  }
  select(id: string) {
    if (id === this.id) return;
    this.capture(); this.id = id;
    this.position = { offset: 0, atBottom: true };
    try {
      const value = JSON.parse(sessionStorage.getItem(this.key()) ?? 'null');
      if (value && typeof value.atBottom === 'boolean' && Number.isFinite(value.offset)
        && (value.messageId === undefined || typeof value.messageId === 'string')) this.position = value;
    } catch { /* No stored reading position. */ }
  }
  capture(atBottom?: boolean) {
    const measured = this.measure(atBottom);
    if (measured || this.saveTimer !== undefined) this.save();
  }
  /** Keep an explicit jump even if the previous reading position was restored in this frame. */
  revealed() {
    this.applying = false;
    this.capture(false);
    this.restore();
  }
  private measure(atBottom?: boolean): boolean {
    const content = this.thread.firstElementChild;
    if (!this.id || this.applying || !this.thread.clientHeight || content?.getAttribute('data-conversation') !== this.id
      || !content.firstElementChild?.hasAttribute('data-message-id')) return false;
    const follow = atBottom ?? this.nearBottom();
    if (follow) { this.position = { offset: 0, atBottom: true }; return true; }
    const top = this.thread.getBoundingClientRect().top;
    // The message articles are direct children in reading order. Only their edges are needed to find the anchor.
    const children = content.children;
    let start = 0, end = children.length;
    while (start < end) {
      const middle = (start + end) >>> 1;
      if (children[middle].getBoundingClientRect().bottom <= top + 1) start = middle + 1;
      else end = middle;
    }
    const node = children.item(start) as HTMLElement | null;
    this.position = node?.dataset.messageId
      ? { messageId: node.dataset.messageId, offset: node.getBoundingClientRect().top - top, atBottom: false }
      : { offset: 0, atBottom: false };
    return true;
  }
  private save() {
    clearTimeout(this.saveTimer); this.saveTimer = undefined;
    if (!this.id) return;
    try { sessionStorage.setItem(this.key(), JSON.stringify(this.position)); } catch { /* The in-memory anchor remains. */ }
  }
  rendered() {
    const content = this.thread.firstElementChild;
    if (content !== this.content) {
      this.observer.disconnect(); this.content = content ?? undefined;
      if (content) this.observer.observe(content);
    }
    this.restore();
  }
  private restore() {
    if (!this.thread.clientHeight || !this.thread.querySelector('[data-message-id]')) { this.updateButton(); return; }
    this.applying = true;
    if (this.position.atBottom) this.thread.scrollTop = this.thread.scrollHeight;
    else if (this.position.messageId) {
      const node = this.thread.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(this.position.messageId)}"]`);
      if (node) this.thread.scrollTop += node.getBoundingClientRect().top - this.thread.getBoundingClientRect().top - this.position.offset;
    }
    this.updateButton(); cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => { this.applying = false; });
  }
  bottom() {
    this.position = { offset: 0, atBottom: true }; this.restore();
    this.save();
  }
  private nearBottom() {
    return this.thread.scrollHeight - this.thread.scrollTop - this.thread.clientHeight < 80;
  }
  private updateButton() {
    if (!this.id || !this.thread.clientHeight || this.nearBottom()) { this.latest.hidden = true; return; }
    const bounds = this.thread.getBoundingClientRect();
    const readingProcess = [...this.thread.querySelectorAll<HTMLElement>('[data-thinking-process][open] .thinking-body')].some(body => {
      const rect = body.getBoundingClientRect();
      return Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top) >= Math.min(80, rect.height);
    });
    this.latest.hidden = readingProcess;
  }
}
