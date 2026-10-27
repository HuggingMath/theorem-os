import type { WebEvent, WebRun } from '../shared';
import { render } from 'preact';
import { Icon } from './ui/Icon';
import { localizeText, t } from '../i18n';

type ActivityRun = Pick<WebRun, 'id' | 'events'>;
type ReadingAnchor = { sequence: number; offset: number };
function Scaffold() {
  return <>
    <div class="activity-heading"><div><h3>{t('活动记录')}</h3><span id="activity-count" class="field-count" role="status" aria-atomic="true" /></div>
      <div class="activity-actions"><button type="button" id="activity-follow" class="text-button" aria-pressed="true" title={t('跟随最新活动；向下阅读时自动暂停')}><Icon name="refresh-cw" />{t('跟随最新')}</button>
        <button type="button" id="download-activity" class="text-button" title={t('下载当前筛选的活动 JSON')}><Icon name="download" />{t('下载活动')}</button></div></div>
    <div class="activity-filters"><div class="activity-search"><Icon name="search" /><label for="activity-search" class="sr-only">{t('搜索活动内容或事件')}</label>
      <input type="search" id="activity-search" maxLength={256} placeholder={t('搜索活动内容或事件…')} autoComplete="off" spellcheck={false} aria-describedby="activity-count activity-retention" />
      <button type="button" id="clear-activity-search" class="icon-button" aria-label={t('清除活动搜索')} title={t('清除活动搜索')} hidden><Icon name="x" /></button></div>
      <label for="activity-type" class="sr-only">{t('筛选事件类型')}</label><select id="activity-type" aria-label={t('筛选事件类型')} /></div>
    <div class="activity-context"><p id="activity-retention" /><button type="button" id="activity-latest" class="text-button" hidden /></div>
    <p id="activity-reading-notice" class="activity-reading-notice" role="status" hidden>{t('正在阅读的活动已超出保留范围，已定位到仍可查看的记录。')}</p>
    <div class="activity-scroll" tabIndex={0} aria-label={t('活动记录表')}><table class="activity-table"><caption class="sr-only">{t('活动记录，最新在前')}</caption>
      <thead><tr><th scope="col">{t('时间')}</th><th scope="col">{t('事件')}</th><th scope="col">{t('记录')}</th></tr></thead><tbody /></table></div>
    <div class="empty-state activity-empty" role="status" hidden><Icon name="search" /><p /><button type="button" id="clear-activity-filters" class="text-button">{t('清除筛选')}</button></div>
  </>;
}

// One run's local reading state. Event content never becomes markup or leaves the browser.
export class ActivityReader {
  private root?: HTMLElement;
  private identity = '';
  private events: WebEvent[] = [];
  private shown: WebEvent[] = [];
  private query = '';
  private type = '';
  private following = true;
  private seenSequence = 0;
  private anchor?: ReadingAnchor;
  private top = 0;
  private left = 0;
  private restorePending = false;
  private readingLost = false;
  private rows = new Map<number, HTMLTableRowElement>();
  private mounted = new WeakSet<HTMLElement>();

  constructor(private readonly timestamp: (at: string) => string,
    private readonly download: (filename: string, text: string) => void) {}

  update(root?: HTMLElement, run?: ActivityRun) {
    if (root !== this.root && this.root) this.remember();
    if (this.identity !== (run?.id ?? '')) {
      this.identity = run?.id ?? '';
      this.events = []; this.shown = []; this.query = ''; this.type = '';
      this.following = true; this.seenSequence = 0; this.anchor = undefined;
      this.top = this.left = 0; this.restorePending = false; this.readingLost = false;
    }
    if (!root || !run) { this.root = undefined; this.rows.clear(); return; }
    const changedRoot = this.root !== root;
    this.root = root;
    if (!this.mounted.has(root)) { this.mount(root); this.mounted.add(root); }
    if (changedRoot) { this.rows.clear(); this.restorePending = true; }
    // A hidden mobile pane has no useful geometry. Refresh it when it becomes visible.
    if (!root.getClientRects().length) return;
    this.events = run.events;
    this.render();
  }

  remember() {
    if (!this.root?.getClientRects().length) return;
    this.capture();
    this.restorePending = true;
  }

  private get<T extends HTMLElement = HTMLElement>(selector: string) {
    return this.root!.querySelector<T>(selector)!;
  }

  private mount(root: HTMLElement) {
    // The scaffold is rendered once; the reader then updates its nodes and keyed rows in place.
    root.textContent = '';
    render(<Scaffold />, root);
    root.addEventListener('input', event => {
      if ((event.target as HTMLElement).id !== 'activity-search') return;
      this.query = (event.target as HTMLInputElement).value;
      this.changeFilters();
    });
    root.addEventListener('change', event => {
      if ((event.target as HTMLElement).id !== 'activity-type') return;
      this.type = (event.target as HTMLSelectElement).value;
      this.changeFilters();
    });
    root.addEventListener('click', event => {
      const id = (event.target as Element).closest('button')?.id;
      if (id === 'clear-activity-search' || id === 'clear-activity-filters') {
        this.query = '';
        if (id === 'clear-activity-filters') this.type = '';
        this.changeFilters(); this.get('#activity-search').focus({ preventScroll: true });
      }
      if (id === 'activity-follow') {
        this.following = !this.following;
        this.seenSequence = this.events.at(-1)?.sequence ?? 0;
        if (this.following) this.returnToLatest(); else this.renderControls();
      }
      if (id === 'activity-latest') this.returnToLatest();
      if (id === 'download-activity' && this.shown.length) this.export();
    });
    this.get('.activity-scroll').addEventListener('scroll', () => {
      if (!this.root?.getClientRects().length) return;
      if (this.following && this.get('.activity-scroll').scrollTop > 24) {
        this.following = false;
        this.seenSequence = this.events.at(-1)?.sequence ?? 0;
        this.renderControls();
      }
      this.capture();
    }, { passive: true });
  }

  private changeFilters() {
    this.anchor = undefined; this.top = this.left = 0;
    this.restorePending = true; this.readingLost = false;
    this.seenSequence = this.events.at(-1)?.sequence ?? 0;
    this.render(true);
  }

  private returnToLatest() {
    this.following = true; this.readingLost = false;
    this.seenSequence = this.events.at(-1)?.sequence ?? 0;
    this.get('.activity-scroll').scrollTo({ top: 0, left: this.left, behavior: 'instant' });
    this.capture(); this.renderControls();
  }

  private capture() {
    const scroll = this.get('.activity-scroll');
    this.top = scroll.scrollTop; this.left = scroll.scrollLeft;
    if (scroll.hidden) return;
    const frame = scroll.getBoundingClientRect();
    const headerBottom = this.get('thead th').getBoundingClientRect().bottom;
    const row = Array.from(this.get('tbody').children).find(row => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > headerBottom + 1 && bounds.top < frame.bottom;
    }) as HTMLTableRowElement | undefined;
    this.anchor = row ? { sequence: Number(row.dataset.sequence), offset: row.getBoundingClientRect().top - frame.top } : undefined;
  }

  private render(reset = false) {
    if (!this.restorePending && !reset) this.capture();
    const anchor = this.anchor;
    const query = this.query.trim().toLowerCase();
    this.shown = this.events.filter(event => (!this.type || event.type === this.type)
      && (!query || `${event.type}\n${event.message}\n${localizeText(event.message)}`.toLowerCase().includes(query))).reverse();
    const retained = new Set(this.events.map(event => event.sequence));
    for (const [sequence, row] of this.rows) {
      if (!retained.has(sequence)) { row.remove(); this.rows.delete(sequence); }
    }
    const visible = new Set(this.shown.map(event => event.sequence));
    for (const [sequence, row] of this.rows) if (!visible.has(sequence)) row.remove();
    const body = this.get<HTMLTableSectionElement>('tbody');
    let cursor = body.firstElementChild;
    for (const event of this.shown) {
      let row = this.rows.get(event.sequence);
      if (!row) {
        row = document.createElement('tr'); row.dataset.sequence = String(event.sequence);
        const time = document.createElement('td'), type = document.createElement('td');
        time.append(document.createElement('time')); type.className = 'mono';
        row.append(time, type, document.createElement('td'));
        this.rows.set(event.sequence, row);
      }
      const time = row.querySelector('time')!;
      time.dateTime = event.at; row.cells[0]!.title = event.at;
      this.text(time, this.timestamp(event.at));
      this.text(row.cells[1]!, event.type); this.text(row.cells[2]!, localizeText(event.message));
      if (row.cells[1]!.title !== event.type) row.cells[1]!.title = event.type;
      if (row === cursor) cursor = cursor.nextElementSibling;
      else body.insertBefore(row, cursor);
    }
    if (this.following) this.seenSequence = this.events.at(-1)?.sequence ?? 0;
    if (!this.following && anchor && !retained.has(anchor.sequence) && !reset) this.readingLost = true;
    this.renderControls();
    const scroll = this.get('.activity-scroll');
    scroll.hidden = !this.shown.length;
    if (this.following || reset) scroll.scrollTop = 0;
    else if (anchor) {
      const row = this.rows.get(anchor.sequence);
      const target = row?.parentElement === body ? row
        : this.rows.get((this.shown.find(event => event.sequence < anchor.sequence) ?? this.shown.at(-1))?.sequence ?? -1);
      if (target) scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset;
      else scroll.scrollTop = this.top;
    } else scroll.scrollTop = this.top;
    scroll.scrollLeft = this.left;
    this.restorePending = false;
    this.capture();
  }

  private text(target: Element, value: string) {
    if (target.textContent !== value) target.textContent = value;
  }

  private renderControls() {
    const input = this.get<HTMLInputElement>('#activity-search');
    if (input.value !== this.query) input.value = this.query;
    this.get('#clear-activity-search').hidden = !this.query;
    const types = new Map<string, number>();
    for (const event of this.events) types.set(event.type, (types.get(event.type) ?? 0) + 1);
    if (this.type && !types.has(this.type)) types.set(this.type, 0);
    const select = this.get<HTMLSelectElement>('#activity-type');
    const options = [['', t('全部事件')], ...Array.from(types).sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => [type, `${type} (${count})`])];
    for (const option of Array.from(select.options)) if (!options.some(([value]) => value === option.value)) option.remove();
    for (const [value, label] of options) {
      let option = Array.from(select.options).find(option => option.value === value);
      if (!option) { option = document.createElement('option'); option.value = value; select.append(option); }
      this.text(option, label!);
    }
    if (select.value !== this.type) select.value = this.type;
    const filtered = Boolean(this.query.trim() || this.type);
    this.text(this.get('#activity-count'), filtered ? t('{0} / {1} 条', this.shown.length, this.events.length) : t('{0} 条', this.events.length));
    this.get('#activity-follow').setAttribute('aria-pressed', String(this.following));
    this.get('#activity-follow').title = this.following ? t('正在跟随最新活动；向下阅读时自动暂停') : t('跟随已暂停，点击返回最新活动');
    const unread = this.shown.filter(event => event.sequence > this.seenSequence).length;
    const latest = this.get('#activity-latest');
    latest.hidden = this.following || !this.shown.length;
    this.text(latest, unread ? t('返回最新 · {0} 条新活动', unread) : t('返回最新'));
    this.text(this.get('#activity-retention'), (this.events[0]?.sequence ?? 1) > 1
      ? t('最新在前 · 仅保留最近 200 条，更早活动已移出') : t('最新在前 · 最多保留 200 条活动'));
    const notice = this.get('#activity-reading-notice');
    notice.hidden = !this.readingLost;
    this.text(notice, this.shown.length ? t('正在阅读的活动已超出保留范围，已定位到仍可查看的记录。')
      : t('正在阅读的活动已超出保留范围；可清除筛选查看仍保留的记录。'));
    this.get<HTMLButtonElement>('#download-activity').disabled = !this.shown.length;
    const empty = this.get('.activity-empty');
    empty.hidden = Boolean(this.shown.length);
    this.text(empty.querySelector('p')!, filtered ? t('没有匹配的活动') : t('暂无活动记录'));
    this.get('#clear-activity-filters').hidden = !filtered;
  }

  private export() {
    const snapshot = { format: 'theoremos-activity', version: 1, runId: this.identity, exportedAt: new Date().toISOString(),
      order: 'newest-first', filters: { query: this.query, type: this.type || null },
      retention: { limit: 200, retainedCount: this.events.length, firstSequence: this.events[0]?.sequence ?? null,
        lastSequence: this.events.at(-1)?.sequence ?? null, earlierEventsOmitted: (this.events[0]?.sequence ?? 1) > 1 },
      matchedCount: this.shown.length,
      events: this.shown.map(({ sequence, at, type, message }) => ({ sequence, at, type, message })) };
    this.download(`${this.identity}-activity.json`, JSON.stringify(snapshot, null, 2) + '\n');
  }
}
