import { useLayoutEffect, useRef } from 'preact/hooks';
import { loadMath, onMathReady, type MathRuntime } from '../mathAssets';

/** Closing punctuation can travel with an inline formula without becoming part of its TeX source. */
export const inlineMathPunctuation = (text: string) => /^[,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u2026'"\p{Pe}\p{Pf}]+/u.exec(text)?.[0] ?? '';

const readingObservers = new WeakMap<Element, IntersectionObserver>();
const pendingFormulas = new WeakMap<Element, () => void>();
/** One observer per conversation scroller. Keep the source in the document until its formula is near the reader. */
function nearReadingArea(host: HTMLElement, root: Element, start: () => void) {
  let observer = readingObservers.get(root);
  if (!observer) {
    const readingObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const start = pendingFormulas.get(entry.target);
        pendingFormulas.delete(entry.target);
        readingObserver.unobserve(entry.target);
        start?.();
      }
    }, { root, rootMargin: '320px 0px' });
    readingObservers.set(root, readingObserver);
    observer = readingObserver;
  }
  pendingFormulas.set(host, start);
  observer.observe(host);
  return () => { pendingFormulas.delete(host); observer.unobserve(host); };
}

/** Render DOM through KaTeX, retaining the original formula for copying and failed/incomplete input. */
export function MathFormula(props: { source: string; display?: boolean; fallback?: string; complete?: boolean; className?: string; suffix?: string; readingArea?: Element }) {
  const element = useRef<HTMLSpanElement>(null);
  const { source, display = false, fallback = source, complete = true, suffix = '', readingArea } = props;
  useLayoutEffect(() => {
    const host = element.current!;
    let disposed = false;
    let stopWaiting: (() => void) | undefined;
    host.textContent = fallback + suffix; host.classList.add('math-source'); host.dataset.mathState = complete ? 'source' : 'pending';
    const render = (math: MathRuntime) => {
      if (disposed) return;
      stopWaiting?.();
      try {
        math.render(source, host, { displayMode: display, throwOnError: true, trust: false,
          strict: 'ignore', maxSize: 20, maxExpand: 1000, output: 'htmlAndMathml' });
        if (suffix) {
          const bases = host.querySelectorAll('.katex-html > .katex-base');
          (bases.item(bases.length - 1) ?? host).append(suffix);
        }
        host.classList.remove('math-source'); host.dataset.mathState = 'ready';
      } catch { host.textContent = fallback + suffix; host.dataset.mathState = 'source'; }
    };
    const start = () => {
      host.dataset.mathState = 'loading';
      void loadMath().then(render, () => {
        if (disposed) return;
        host.dataset.mathState = 'source';
        stopWaiting = onMathReady(render);
      });
    };
    let stopObserving: (() => void) | undefined;
    if (complete) {
      if (readingArea && typeof IntersectionObserver === 'function') stopObserving = nearReadingArea(host, readingArea, start);
      else start();
    }
    return () => { disposed = true; stopObserving?.(); stopWaiting?.(); };
  }, [source, display, fallback, complete, suffix, readingArea]);
  return <span ref={element} class={`math${display ? ' math-display' : ''}${props.className ? ` ${props.className}` : ''}`}
    title={source} translate={false} />;
}
