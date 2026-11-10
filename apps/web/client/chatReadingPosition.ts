type Position = { messageId?: string; offset: number; atBottom: boolean };
export const chatReadingReveal = 'chat-reading-reveal';

/** Reading follows a message, so later math layout and expanded code do not move the reader. */
export class ChatReadingPosition {
  private id = '';
  private position: Position = { offset: 0, atBottom: true };
  private applying = false;
  private frame = 0;
  private content?: Element;
  private observer: ResizeObserver;
  constructor(private thread: HTMLElement, private latest: HTMLButtonElement, private scope: string) {
    this.observer = new ResizeObserver(() => this.restore());
    thread.addEventListener('scroll', () => { if (!this.applying) this.capture(); this.updateButton(); }, { passive: true });
    thread.addEventListener('scroll', () => this.updateButton(), { capture: true, passive: true });
    thread.addEventListener('toggle', () => this.updateButton(), true);
    // A deliberate jump inside the log replaces the old outer anchor before later content grows.
    thread.addEventListener(chatReadingReveal, () => { this.applying = false; this.capture(false); this.restore(); });
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) thread.addEventListener(type, () => { this.applying = false; }, { passive: true });
    latest.addEventListener('click', () => this.bottom());
    window.addEventListener('pagehide', () => this.capture());
  }
  private key() { return `theorem-os.chat-reading.${this.scope}.${this.id}`; }
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
    if (!this.id || this.applying || !this.thread.clientHeight || !this.thread.querySelector('[data-message-id]')) return;
    const top = this.thread.getBoundingClientRect().top;
    const node = [...this.thread.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.getBoundingClientRect().bottom > top + 1);
    this.position = { messageId: node?.dataset.messageId, offset: node ? node.getBoundingClientRect().top - top : 0,
      atBottom: atBottom ?? this.thread.scrollHeight - this.thread.scrollTop - this.thread.clientHeight < 80 };
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
    try { sessionStorage.setItem(this.key(), JSON.stringify(this.position)); } catch {}
  }
  private updateButton() {
    const bounds = this.thread.getBoundingClientRect();
    const readingProcess = [...this.thread.querySelectorAll<HTMLElement>('[data-thinking-process][open] .thinking-body')].some(body => {
      const rect = body.getBoundingClientRect();
      return Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top) >= Math.min(80, rect.height);
    });
    this.latest.hidden = readingProcess || !this.id || !this.thread.clientHeight || this.thread.scrollHeight - this.thread.scrollTop - this.thread.clientHeight < 80;
  }
}
