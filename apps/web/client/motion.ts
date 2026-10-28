import { gsap } from 'gsap';

type MotionKind = 'workspace' | 'panel' | 'status' | 'dialog';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const active = new Map<HTMLElement, gsap.Context>();
let pageActive = true;

function finish(target: HTMLElement) {
  const context = active.get(target);
  active.delete(target);
  context?.revert();
  delete target.dataset.motion;
}

export function finishMotion(root?: Element) {
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

export function animateEntrance(target: HTMLElement, kind: MotionKind) {
  finish(target);
  if (!pageActive || document.hidden || reducedMotion.matches || !target.getClientRects().length) return;
  const stationary = kind === 'workspace' || kind === 'dialog' || kind === 'status';
  target.dataset.motion = kind;
  // Revert the context on completion as well as interruption so original inline styles survive.
  const context = gsap.context(() => {
    gsap.fromTo(target, { opacity: kind === 'status' ? .55 : .35, y: stationary ? 0 : 5 }, {
      opacity: 1, y: 0, duration: .18, ease: 'power2.out',
      onComplete: () => finish(target),
    });
  });
  active.set(target, context);
}

/** Grow a freshly shown task graph: cards appear column by column, then each edge draws from its source. */
export function revealGraph(graph: HTMLElement) {
  if (!pageActive || document.hidden || reducedMotion.matches || !graph.getClientRects().length) return;
  const cards = [...graph.querySelectorAll<HTMLElement>('[data-collab-task]')];
  const columns = [...new Set(cards.map(card => card.offsetLeft))].sort((a, b) => a - b);
  const column = new Map(columns.map((left, index) => [left, index]));
  const step = Math.min(90, 520 / Math.max(1, columns.length));
  const delay = new Map<string, number>();
  for (const card of cards) {
    const at = column.get(card.offsetLeft)! * step + Math.min(120, card.offsetTop / 12);
    delay.set(card.dataset.collabTask!, at);
    card.animate([{ opacity: 0, transform: 'translateY(6px) scale(.98)' }, { opacity: 1, transform: 'none' }],
      { duration: 420, delay: at, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' });
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
