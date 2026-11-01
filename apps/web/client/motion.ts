import { gsap } from 'gsap';

/** Entrances fast at first and settling long, the way a page turns rather than a slide. */
export const easeExpo = 'cubic-bezier(.16,1,.3,1)';
const easeReel = 'cubic-bezier(.19,1,.22,1)';
const easeSpring = 'cubic-bezier(.34,1.56,.64,1)';
type MotionKind = 'workspace' | 'panel' | 'dialog' | 'status' | 'count' | 'steps' | 'seal' | 'viewer' | 'glide' | 'row';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
/** The motion running on each marked target: how to end it at once, back to the element's own styles. */
const active = new Map<HTMLElement, () => void>();
let pageActive = true;
/** The theme change spreading over the page, if one is. */
let themeReveal: ViewTransition | undefined;

function finish(target: HTMLElement) {
  const stop = active.get(target);
  active.delete(target);
  stop?.();
  delete target.dataset.motion;
}
const allowed = (target: Element) => pageActive && !document.hidden && !reducedMotion.matches && target.getClientRects().length > 0;

export function finishMotion(root?: Element) {
  if (!root) themeReveal?.skipTransition();
  for (const target of active.keys()) if (!root || root === target || root.contains(target)) finish(target);
  for (const animation of document.getAnimations()) {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    if (animation instanceof CSSAnimation || animation instanceof CSSTransition || !target) continue;
    if (!root || root === target || root.contains(target)) animation.finish();
  }
}

export function finishHiddenMotion() {
  for (const target of active.keys()) if (!target.isConnected || !target.getClientRects().length) finish(target);
}

/**
 * Marks `target` for the whole lifetime of `animations` (Web Animations, often on its children or pseudo-elements);
 * finishing early cancels them, so nothing is left part-way or held by a fill. `cleanup` undoes what the caller set.
 */
function track(target: HTMLElement, kind: MotionKind, animations: Animation[], cleanup?: () => void) {
  const stop = () => { for (const animation of animations) animation.cancel(); cleanup?.(); };
  target.dataset.motion = kind;
  active.set(target, stop);
  void Promise.all(animations.map(animation => animation.finished)).then(() => { if (active.get(target) === stop) finish(target); }, () => undefined);
}

/**
 * Workspaces and panels rise into place; a dialog settles from slightly smaller, and the history drawer wipes open from its edge.
 * With `sections`, a panel's first result sections follow it one after another.
 */
export function animateEntrance(target: HTMLElement, kind: 'workspace' | 'panel' | 'dialog', sections = false) {
  finish(target);
  if (!allowed(target)) return;
  target.dataset.motion = kind;
  // Revert the context on completion as well as interruption so original inline styles survive.
  const context = gsap.context(() => {
    const timeline = gsap.timeline({ onComplete: () => finish(target) });
    if (kind === 'dialog' && target.classList.contains('history-dialog')) {
      timeline.fromTo(target, { opacity: .6, clipPath: 'inset(0% 100% 0% 0%)' }, { opacity: 1, clipPath: 'inset(0% 0% 0% 0%)', duration: .46, ease: 'expo.out' });
    } else if (kind === 'dialog') timeline.fromTo(target, { opacity: 0, scale: .97 }, { opacity: 1, scale: 1, duration: .32, ease: 'expo.out' });
    else timeline.fromTo(target, { opacity: .35, y: kind === 'panel' ? 8 : 0 }, { opacity: 1, y: 0, duration: kind === 'panel' ? .4 : .24, ease: 'expo.out' });
    // Code is never among the sections.
    const parts = kind === 'panel' && sections ? panelParts(target) : [];
    if (parts.length) timeline.fromTo(parts, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: .5, ease: 'expo.out', stagger: .055 }, .04);
  });
  active.set(target, () => context.revert());
}
/** The result document's sections that start in view; those further down are already in place when the reader gets there. */
function panelParts(panel: HTMLElement) {
  const bottom = panel.getBoundingClientRect().bottom;
  return [...panel.querySelectorAll<HTMLElement>('.result-document>section')].filter(section => section.getBoundingClientRect().top < bottom).slice(0, 6);
}
/**
 * A status badge whose words changed: the old phrase lifts away blurred while the new one rises in, and the pill eases
 * to its new width. Both phrases are drawn by the label's pseudo-elements, so its text is the new status throughout.
 * `from` is what the badge said and how wide it was; with the same words only the icon settles in.
 */
export function rollStatus(badge: HTMLElement, from: { label: string; width: number }) {
  finish(badge);
  const label = badge.querySelector<HTMLElement>('.badge-label');
  if (!allowed(badge) || !label) return;
  if (label.textContent === from.label) { popStatus(badge); return; }
  label.dataset.rollFrom = from.label; label.dataset.rollTo = label.textContent ?? '';
  badge.dataset.rolling = '';
  const timing = { duration: 620, easing: easeExpo, fill: 'forwards' as const };
  const animations = [
    label.animate([{ opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }, { opacity: 0, transform: 'translateY(-72%)', filter: 'blur(5px)' }], { ...timing, pseudoElement: '::after' }),
    label.animate([{ opacity: 0, transform: 'translateY(72%)', filter: 'blur(5px)' }, { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }], { ...timing, pseudoElement: '::before' }),
  ];
  if (from.width > 0 && Math.abs(from.width - badge.offsetWidth) > .5) {
    animations.push(badge.animate([{ width: `${from.width}px` }, { width: `${badge.offsetWidth}px` }], { duration: 550, easing: easeExpo }));
  }
  const icon = badge.querySelector('svg');
  if (icon) animations.push(icon.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 480, delay: 90, easing: easeSpring, fill: 'backwards' }));
  track(badge, 'status', animations, () => { delete badge.dataset.rolling; delete label.dataset.rollFrom; delete label.dataset.rollTo; });
}
function popStatus(badge: HTMLElement) {
  const icon = badge.querySelector('svg');
  if (icon) track(badge, 'status', [icon.animate([{ opacity: .4, transform: 'scale(.7)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 460, easing: easeSpring })]);
}

/** A count whose digits changed: each changed digit runs a reel up to its new value, the later digits a little longer. */
export function rollDigits(ticker: HTMLElement, cells: readonly { cell: HTMLElement; from: number; to: number }[]) {
  finish(ticker);
  if (!cells.length || !allowed(ticker)) return;
  const row = cells[0]!.cell.getBoundingClientRect().height;
  if (!row) return;
  const animations = cells.map(({ cell, from, to }, index) => {
    cell.dataset.rolling = '';
    return cell.animate([{ transform: `translateY(${-from * row}px)`, filter: 'blur(2.5px)' }, { transform: `translateY(${-to * row}px)`, filter: 'blur(0)' }],
      { duration: 900 + index * 140, easing: easeReel, fill: 'forwards', pseudoElement: '::before' });
  });
  track(ticker, 'count', animations, () => { for (const { cell } of cells) delete cell.dataset.rolling; });
}

/**
 * Steps entering the trajectory. `arrived`: new steps of a run being followed rise in with a quick blur, and their
 * marker springs. Otherwise the first draw cascades top to bottom. Only steps inside `viewport` move.
 */
export function revealSteps(host: HTMLElement, steps: readonly HTMLElement[], viewport: Element | undefined, arrived: boolean) {
  finish(host);
  if (!steps.length || !allowed(host)) return;
  const bounds = (viewport ?? host).getBoundingClientRect();
  const shown = steps.filter(step => { const box = step.getBoundingClientRect(); return box.bottom > bounds.top && box.top < bounds.bottom; }).slice(arrived ? -4 : 0, arrived ? undefined : 14);
  if (!shown.length) return;
  const animations: Animation[] = [];
  for (const [index, step] of shown.entries()) {
    const delay = arrived ? index * 70 : index * 38;
    animations.push(step.animate(arrived
      ? [{ opacity: 0, transform: 'translateY(10px)', filter: 'blur(3px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }]
      : [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: arrived ? 520 : 460, delay, easing: easeExpo, fill: 'backwards' }));
    const marker = arrived ? step.querySelector(':scope>.trajectory-marker') : null;
    if (marker) animations.push(marker.animate([{ transform: 'scale(.5)' }, { transform: 'scale(1)' }], { duration: 560, delay: delay + 60, easing: easeSpring, fill: 'backwards' }));
  }
  track(host, 'steps', animations);
}

/** The verdict reached while the reader watches: the mark springs in, and a passed one rings once and draws its check. */
export function sealVerdict(mark: HTMLElement, passed: boolean) {
  finish(mark);
  if (!allowed(mark)) return;
  const animations = [mark.animate([{ transform: 'scale(.55)', opacity: .3 }, { transform: 'scale(1)', opacity: 1 }], { duration: 640, easing: easeSpring })];
  let ring: HTMLElement | undefined;
  if (passed) {
    ring = document.createElement('span');
    ring.className = 'result-verdict-ring'; ring.setAttribute('aria-hidden', 'true');
    mark.append(ring);
    animations.push(ring.animate([{ opacity: .7, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(2.1)' }], { duration: 900, delay: 160, easing: easeExpo, fill: 'both' }));
    for (const [index, path] of mark.querySelectorAll<SVGGeometryElement>('svg>*').entries()) {
      const length = path.getTotalLength?.() ?? 0;
      if (!length) continue;
      animations.push(path.animate([{ strokeDasharray: `${length}`, strokeDashoffset: length }, { strokeDasharray: `${length}`, strokeDashoffset: 0 }],
        { duration: 520, delay: 140 + index * 160, easing: easeExpo, fill: 'backwards' }));
    }
  }
  track(mark, 'seal', animations, () => ring?.remove());
}

/** A side viewer opening: beside the content it wipes open from the content's edge; full-screen it settles into place. */
export function revealViewer(viewer: HTMLElement, modal: boolean) {
  finish(viewer);
  if (!allowed(viewer)) return;
  track(viewer, 'viewer', [viewer.animate(modal
    ? [{ opacity: 0, transform: 'scale(.98)' }, { opacity: 1, transform: 'none' }]
    : [{ opacity: 0, clipPath: 'inset(0 0 0 100% round 14px)' }, { opacity: 1, clipPath: 'inset(0 0 0 0 round 14px)' }], { duration: modal ? 320 : 440, easing: easeExpo })]);
}
type Box = { left: number; top: number; width: number; height: number };
const boxOf = (row: HTMLElement): Box => ({ left: row.offsetLeft, top: row.offsetTop, width: row.offsetWidth, height: row.offsetHeight });
/**
 * The history's selection moved: a card slides from the row chosen before to the one chosen now, the way the tab
 * underline does, and the new row takes it over when it lands. `from` was measured before the list changed; a slide
 * still under way starts from where its card is.
 */
export function glideSelection(list: HTMLElement, from: Box, to: HTMLElement) {
  let start = from;
  if (active.has(list)) {
    const style = getComputedStyle(list, '::before'), [left = 0, top = 0] = style.translate.split(' ').map(parseFloat);
    if (parseFloat(style.width) > 0) start = { left, top, width: parseFloat(style.width), height: parseFloat(style.height) };
  }
  finish(list);
  if (!allowed(to)) return;
  const end = boxOf(to);
  if (Math.abs(end.top - start.top) < 1 && Math.abs(end.left - start.left) < 1) return;
  list.dataset.gliding = '';
  const frame = (box: Box) => ({ width: `${box.width}px`, height: `${box.height}px`, translate: `${box.left}px ${box.top}px` });
  track(list, 'glide', [list.animate([frame(start), frame(end)], { duration: 380, easing: easeExpo, fill: 'both', pseudoElement: '::before' })],
    () => { delete list.dataset.gliding; });
}
export const selectionBox = (row: HTMLElement | null | undefined) => row?.getClientRects().length ? boxOf(row) : undefined;

/** A record that has just arrived opens its place in the list and keeps a clay wash for a moment, then settles. */
export function arriveRow(item: HTMLElement) {
  finish(item);
  const row = item.querySelector<HTMLElement>('.run-row');
  if (!row || !allowed(item)) return;
  const style = getComputedStyle(row), wash = getComputedStyle(document.documentElement).getPropertyValue('--accent-soft').trim();
  track(item, 'row', [
    item.animate([{ height: '0px', opacity: 0, overflow: 'clip' }, { height: `${item.offsetHeight}px`, opacity: 1, overflow: 'clip' }], { duration: 420, easing: easeExpo }),
    row.animate([{ backgroundColor: wash, offset: 0 }, { backgroundColor: wash, offset: .35 }, { backgroundColor: style.backgroundColor }], { duration: 1500, easing: 'ease-out' }),
  ]);
}

/**
 * A theme chosen by the reader spreads over the old one in a circle from (x, y), like ink taking to paper. `apply`
 * changes the theme; without view transitions, or with reduced motion, it simply runs.
 */
export function revealTheme(apply: () => void, x: number, y: number) {
  const root = document.documentElement;
  if (!document.startViewTransition || !pageActive || document.hidden || reducedMotion.matches) { apply(); return; }
  themeReveal?.skipTransition();
  root.dataset.themeReveal = '';
  const transition = themeReveal = document.startViewTransition(apply);
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  void transition.ready.then(() => {
    root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 620, easing: easeExpo, pseudoElement: '::view-transition-new(root)' });
  }, () => undefined);
  void transition.finished.finally(() => {
    if (themeReveal !== transition) return;
    themeReveal = undefined; delete root.dataset.themeReveal;
  }).catch(() => undefined);
}

/** Grow a freshly shown task graph: cards appear column by column, then each edge draws from its source. */
export function revealGraph(graph: HTMLElement) {
  if (!allowed(graph)) return;
  const cards = [...graph.querySelectorAll<HTMLElement>('[data-collab-task]')];
  const columns = [...new Set(cards.map(card => card.offsetLeft))].sort((a, b) => a - b);
  const column = new Map(columns.map((left, index) => [left, index]));
  const step = Math.min(90, 520 / Math.max(1, columns.length));
  const delay = new Map<string, number>();
  for (const card of cards) {
    const at = column.get(card.offsetLeft)! * step + Math.min(120, card.offsetTop / 12);
    delay.set(card.dataset.collabTask!, at);
    card.animate([{ opacity: 0, transform: 'translateY(6px) scale(.98)' }, { opacity: 1, transform: 'none' }],
      { duration: 420, delay: at, easing: easeExpo, fill: 'backwards' });
  }
  for (const path of graph.querySelectorAll<SVGPathElement>('.collab-edges path')) {
    const length = path.getTotalLength();
    path.animate([{ strokeDasharray: `${length} ${length}`, strokeDashoffset: length }, { strokeDasharray: `${length} ${length}`, strokeDashoffset: 0 }],
      { duration: 520, delay: (delay.get(path.dataset.from!) ?? 0) + 220, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'backwards' });
  }
}

reducedMotion.addEventListener('change', () => finishMotion());
document.addEventListener('visibilitychange', () => { if (document.hidden) finishMotion(); });
window.addEventListener('pagehide', () => { pageActive = false; finishMotion(); });
window.addEventListener('pageshow', () => { pageActive = true; });
