import { useLayoutEffect, useRef } from 'preact/hooks';
import { loadMath } from '../mathAssets';

/** Closing punctuation can travel with an inline formula without becoming part of its TeX source. */
export const inlineMathPunctuation = (text: string) => /^[,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u2026'"\p{Pe}\p{Pf}]+/u.exec(text)?.[0] ?? '';

/** Render DOM through KaTeX, retaining the original formula for copying and failed/incomplete input. */
export function MathFormula(props: { source: string; display?: boolean; fallback?: string; complete?: boolean; className?: string; suffix?: string }) {
  const element = useRef<HTMLSpanElement>(null);
  const { source, display = false, fallback = source, complete = true, suffix = '' } = props;
  useLayoutEffect(() => {
    const host = element.current!;
    let disposed = false;
    host.textContent = fallback + suffix; host.classList.add('math-source'); host.dataset.mathState = complete ? 'loading' : 'pending';
    if (complete) void loadMath().then(math => {
      if (disposed) return;
      try {
        math.render(source, host, { displayMode: display, throwOnError: true, trust: false,
          strict: 'ignore', maxSize: 20, maxExpand: 1000, output: 'htmlAndMathml' });
        if (suffix) {
          const bases = host.querySelectorAll('.katex-html > .katex-base');
          (bases.item(bases.length - 1) ?? host).append(suffix);
        }
        host.classList.remove('math-source'); host.dataset.mathState = 'ready';
      } catch { host.textContent = fallback + suffix; host.dataset.mathState = 'source'; }
    }, () => { if (!disposed) host.dataset.mathState = 'source'; });
    return () => { disposed = true; };
  }, [source, display, fallback, complete, suffix]);
  return <span ref={element} class={`math${display ? ' math-display' : ''}${props.className ? ` ${props.className}` : ''}`}
    title={source} translate={false} />;
}
