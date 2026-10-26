import { termGroups, terms, type TermId } from './glossary';
import { t } from '../i18n';

/**
 * One delegated toggletip for every [data-term] button, whether Preact or a string renderer drew it.
 * Focus stays on the button; the text is announced through a live region, and Escape or a click elsewhere closes it.
 */
export function installTermHints(openGlossary: (id?: TermId) => void) {
  const tip = document.createElement('div');
  tip.className = 'term-tip'; tip.id = 'term-tip';
  // Browsers without the Popover API still show the tip, only not above a modal dialog's backdrop.
  const popover = typeof tip.showPopover === 'function';
  if (popover) tip.popover = 'manual'; else tip.hidden = true;
  const name = document.createElement('strong'), text = document.createElement('p'), more = document.createElement('button');
  more.type = 'button'; more.className = 'text-button'; more.textContent = t('全部术语');
  tip.append(name, text, more);
  const live = document.createElement('p');
  live.className = 'sr-only'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
  document.body.append(tip, live);
  let owner: HTMLButtonElement | undefined;

  const close = () => {
    if (!owner) return;
    owner.setAttribute('aria-expanded', 'false'); owner = undefined;
    if (!popover) tip.hidden = true; else if (tip.matches(':popover-open')) tip.hidePopover();
    live.textContent = '';
  };
  const place = (button: HTMLButtonElement) => {
    // A modal dialog makes everything outside it inert, so the tip lives in the dialog and shows in the top layer above it.
    const host = button.closest('dialog') ?? document.body;
    if (tip.parentElement !== host) host.append(tip, live);
    const box = button.getBoundingClientRect(), margin = 8;
    if (!popover) tip.hidden = false; else if (!tip.matches(':popover-open')) tip.showPopover();
    const width = tip.offsetWidth, height = tip.offsetHeight;
    const left = Math.min(Math.max(margin, box.left + box.width / 2 - width / 2), innerWidth - width - margin);
    const below = box.bottom + margin + height <= innerHeight;
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? box.bottom + margin : Math.max(margin, box.top - margin - height)}px`;
  };
  const open = (button: HTMLButtonElement) => {
    const id = button.dataset.term as TermId, term = terms[id];
    if (!term) return;
    if (owner === button) { close(); return; }
    close();
    owner = button; button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-controls', tip.id);
    name.textContent = term.name; text.textContent = term.short; more.dataset.glossaryTerm = id;
    place(button);
    live.textContent = t('{0}：{1}', term.name, term.short);
  };

  document.addEventListener('click', event => {
    const target = event.target as Element;
    const button = target.closest<HTMLButtonElement>('button[data-term]');
    if (button) { event.preventDefault(); event.stopPropagation(); open(button); return; }
    if (!tip.contains(target)) close();
  }, true);
  more.addEventListener('click', () => { const id = more.dataset.glossaryTerm as TermId; close(); openGlossary(id); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !owner) return;
    // Escape closes only the tip, not the dialog around it.
    const button = owner; close(); button.focus(); event.preventDefault(); event.stopPropagation();
  }, true);
  // Re-renders restore scroll positions, so scrolling moves the tip with its button; it closes once the button is gone or off screen.
  const follow = () => {
    if (!owner) return;
    const box = owner.getBoundingClientRect();
    if (!owner.isConnected || !box.width || box.bottom < 0 || box.top > innerHeight) { close(); return; }
    place(owner);
  };
  addEventListener('resize', follow);
  document.addEventListener('scroll', event => { if (!tip.contains(event.target as Node)) follow(); }, true);
}

/** The glossary dialog lists every term by group; opening it at a term scrolls to and highlights that entry. */
export function renderGlossary(dialog: HTMLDialogElement, focus?: TermId) {
  const body = dialog.querySelector<HTMLElement>('[data-glossary-body]')!;
  if (!body.childElementCount) {
    for (const group of termGroups) {
      const section = document.createElement('section'), heading = document.createElement('h3'), list = document.createElement('dl');
      heading.textContent = group.title; section.append(heading, list);
      for (const id of group.terms) {
        const term = terms[id], row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
        row.id = `term-${id}`; row.tabIndex = -1; dt.textContent = term.name;
        const short = document.createElement('p'); short.textContent = term.short; dd.append(short);
        if (term.detail) { const detail = document.createElement('p'); detail.className = 'term-detail'; detail.textContent = term.detail; dd.append(detail); }
        row.append(dt, dd); list.append(row);
      }
      body.append(section);
    }
  }
  body.querySelectorAll('[data-current]').forEach(row => row.removeAttribute('data-current'));
  if (!focus) return;
  const row = body.querySelector<HTMLElement>(`#term-${focus}`)!;
  row.dataset.current = 'true';
  requestAnimationFrame(() => { row.scrollIntoView({ block: 'nearest' }); row.focus({ preventScroll: true }); });
}
