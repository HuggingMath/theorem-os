import type { WebObservation } from '../collaboration';
import { render } from 'preact';
import { createElement, observedTime } from './collaborationUi';
import { t } from '../i18n';

const sections = [
  ['overview', t('进展'), '.collab-research-overview'], ['tasks', t('任务'), '.collab-layout'],
  ['reviews', t('原意与 Lean'), '.collab-reviews'], ['changes', t('变化'), '.collab-math-changes'],
  ['agents', 'Agent', '.collab-agents'], ['deliveries', t('交付'), '.collab-deliveries'],
  ['guidance', t('指导'), '.collab-guidance'], ['records', t('记录'), '[data-collab-records]'],
  ['knowledge', t('知识'), '.collab-knowledge'],
] as const;
export type CollaborationSection = typeof sections[number][0];
type Position = { node: HTMLElement; top: number; left: number; key?: string };
type Origin = { section: CollaborationSection; top: number; left: number; positions: Position[]; focus?: HTMLElement; focusKey?: string };

/** Navigation changes reading position only in the mounted research pane. */
export class CollaborationNavigation {
  readonly element = createElement('nav', 'collab-navigation');
  private viewport?: HTMLElement;
  private current: CollaborationSection = 'overview';
  private origin?: Origin;
  private frame?: number;
  private returnButton: HTMLButtonElement;
  private onScroll = () => {
    if (this.frame === undefined) this.frame = requestAnimationFrame(() => { this.frame = undefined; this.track(); });
  };

  /** `expand` runs before every reveal so a target hidden by the simple layer is laid out before it is measured. */
  constructor(private surface: HTMLElement, runId: string, guide: () => void, private expand: (target: HTMLElement) => void = () => undefined) {
    this.element.setAttribute('aria-label', t('协作区导航'));
    // Rendered once; the navigation then updates counts, the current section and the sync state in place.
    render(<>
      <div class="collab-nav-links">{sections.map(([id, title]) => <button key={id} type="button" data-collab-jump={id} aria-controls={`collab-${id}-${runId}`}><span>{title}</span><small data-collab-nav-count={id} /></button>)}</div>
      <label class="collab-nav-picker"><span class="sr-only">{t('跳转协作区域')}</span><select data-collab-section-picker>{sections.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
      <span class="collab-sync" data-collab-sync /><button type="button" class="button" data-collab-nav-guide>{t('提供指导')}</button>
    </>, this.element);
    for (const [id, , selector] of sections) {
      const section = surface.querySelector<HTMLElement>(selector)!;
      section.id = `collab-${id}-${runId}`; section.dataset.collabSection = id;
      const heading = section.querySelector<HTMLElement>('h3')!;
      heading.tabIndex = -1; heading.setAttribute('data-collab-section-heading', '');
    }
    this.returnButton = createElement('button', 'text-button');
    this.returnButton.type = 'button'; this.returnButton.hidden = true; this.returnButton.setAttribute('data-collab-return', '');
    surface.querySelector('.collab-guidance .collab-section-heading')!.append(this.returnButton);
    this.element.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-collab-jump]');
      if (button) this.go(button.dataset.collabJump as CollaborationSection);
    });
    this.element.querySelector('[data-collab-section-picker]')!.addEventListener('change', event => this.go((event.target as HTMLSelectElement).value as CollaborationSection));
    this.element.querySelector('[data-collab-nav-guide]')!.addEventListener('click', guide);
    this.activate('overview');
  }

  connect(viewport: HTMLElement) {
    if (this.viewport !== viewport) {
      this.disconnect(); this.viewport = viewport;
      viewport.addEventListener('scroll', this.onScroll, { passive: true });
    }
    this.track();
  }
  disconnect() {
    this.viewport?.removeEventListener('scroll', this.onScroll); this.viewport = undefined;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }
  private mounted() { return Boolean(this.viewport?.contains(this.surface)); }
  private section(id: CollaborationSection) { return this.surface.querySelector<HTMLElement>(`[data-collab-section="${id}"]`)!; }

  update(observation: WebObservation | undefined, connected: boolean, archives: number) {
    const counts: Partial<Record<CollaborationSection, number>> = observation ? { tasks: observation.inspection.tasks.length,
      reviews: observation.inspection.statementReviews.length, changes: observation.inspection.mathematics.recentChanges.length,
      agents: observation.inspection.workers.length, deliveries: observation.deliveries?.length, guidance: observation.guidance.length,
      records: observation.inspection.edits.length + archives } : {};
    const picker = this.element.querySelector<HTMLSelectElement>('[data-collab-section-picker]')!;
    for (const [id, title] of sections) {
      const count = counts[id];
      this.element.querySelector(`[data-collab-nav-count="${id}"]`)!.textContent = count === undefined ? '' : String(count);
      picker.querySelector(`option[value="${id}"]`)!.textContent = `${title}${count === undefined ? '' : ` · ${count}`}`;
    }
    const sync = this.element.querySelector<HTMLElement>('[data-collab-sync]')!;
    sync.textContent = connected ? observation ? t('观察 #{0}', observation.sequence) : t('等待观察') : t('连接中断');
    sync.dataset.connected = String(connected);
    sync.title = connected ? observation ? observedTime(observation.observedAt) : t('等待运行时观察') : t('已保留最近观察和当前草稿');
  }

  go(id: CollaborationSection) {
    if (!this.mounted()) return;
    const section = this.section(id);
    const heading = section.querySelector<HTMLElement>('[data-collab-section-heading]')!;
    this.reveal(heading); heading.focus({ preventScroll: true }); this.activate(id);
  }
  reveal(target: HTMLElement) {
    if (!this.mounted()) return;
    this.expand(target);
    // Move an inspector's own scroll first, then position its heading below the sticky navigation.
    for (let parent = target.parentElement; parent && parent !== this.viewport; parent = parent.parentElement) {
      if (parent.scrollHeight > parent.clientHeight && /(auto|scroll)/.test(getComputedStyle(parent).overflowY)) {
        const header = parent.querySelector<HTMLElement>(':scope > .collab-section-heading');
        const inset = header && !header.contains(target) && getComputedStyle(header).position === 'sticky' ? header.offsetHeight : 0;
        parent.scrollTop += target.getBoundingClientRect().top - parent.getBoundingClientRect().top - inset - 10;
      }
    }
    const offset = this.element.getBoundingClientRect().height + 10;
    this.viewport!.scrollTop += target.getBoundingClientRect().top - this.viewport!.getBoundingClientRect().top - offset;
    this.track();
  }

  remember() {
    if (!this.mounted()) return false;
    const focus = document.activeElement instanceof HTMLElement && this.surface.contains(document.activeElement) ? document.activeElement : undefined;
    const id = focus?.closest<HTMLElement>('[data-collab-section]')?.dataset.collabSection as CollaborationSection | undefined;
    const section = id ?? this.current;
    const target = this.section(section);
    // A section hidden by the simple layer has no place to return to.
    if (section === 'guidance' || !target.getClientRects().length) return false;
    const positions = [...target.querySelectorAll<HTMLElement>('*')].filter(node => node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)
      .map(node => ({ node, top: node.scrollTop, left: node.scrollLeft, key: node.dataset.focusKey }));
    this.origin = { section, top: this.viewport!.scrollTop, left: this.viewport!.scrollLeft, positions, focus, focusKey: focus?.dataset.focusKey };
    this.returnButton.textContent = t('返回{0}', sections.find(([id]) => id === section)![1]);
    this.returnButton.hidden = false;
    return true;
  }
  back() {
    if (!this.mounted() || !this.origin) return;
    const origin = this.origin;
    const byKey = (key?: string) => key ? [...this.surface.querySelectorAll<HTMLElement>('[data-focus-key]')].find(node => node.dataset.focusKey === key) : undefined;
    for (const position of origin.positions) {
      const node = this.surface.contains(position.node) ? position.node : byKey(position.key);
      if (node) { node.scrollTop = position.top; node.scrollLeft = position.left; }
    }
    this.viewport!.scrollTop = origin.top; this.viewport!.scrollLeft = origin.left;
    const focus = origin.focus && this.surface.contains(origin.focus) ? origin.focus : byKey(origin.focusKey);
    (focus ?? this.section(origin.section).querySelector<HTMLElement>('[data-collab-section-heading]'))?.focus({ preventScroll: true });
    this.activate(origin.section);
  }

  private activate(id: CollaborationSection) {
    this.current = id;
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('[data-collab-jump]')) {
      if (button.dataset.collabJump === id) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current');
    }
    this.element.querySelector<HTMLSelectElement>('[data-collab-section-picker]')!.value = id;
  }
  private track() {
    if (!this.mounted()) return;
    const top = this.viewport!.getBoundingClientRect().top + this.element.getBoundingClientRect().height + 20;
    let id: CollaborationSection = 'overview';
    for (const [section] of sections) {
      const node = this.section(section);
      if (node.getClientRects().length && node.getBoundingClientRect().top <= top) id = section;
    }
    if (this.viewport!.scrollTop > 0 && this.viewport!.scrollTop + this.viewport!.clientHeight >= this.viewport!.scrollHeight - 2
      && this.section('knowledge').getClientRects().length) id = 'knowledge';
    this.activate(id);
  }
}
