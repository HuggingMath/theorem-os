export type MathRuntime = Pick<typeof import('katex'), 'render'>;
type MathAssets = { script: string; stylesheet: string };
const mathReady = new Set<(math: MathRuntime) => void>();
let nextMathLoad = 0;
/** Existing formulas can recover when a later request successfully loads the shared assets. */
export function onMathReady(render: (math: MathRuntime) => void): () => void {
  mathReady.add(render);
  return () => { mathReady.delete(render); };
}
declare global {
  interface Window {
    theoremosMath?: MathRuntime;
    theoremosMathAssets?: MathAssets;
    theoremosMathLoading?: Promise<MathRuntime>;
  }
}

/** Archives use relative, versioned assets; workbench pages use the same renderer beside their page bundle. */
export function configureMathAssets(assets: MathAssets) { window.theoremosMathAssets = assets; }

function loadStylesheet(href: string): Promise<void> {
  if (document.querySelector('style[data-theoremos-math-style]')) return Promise.resolve();
  const url = new URL(href, document.baseURI).href;
  const existing = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].find(link => link.href === url);
  if (existing?.sheet) return Promise.resolve();
  // A failed stylesheet link will never fire load or error again.
  existing?.remove();
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => { link.remove(); reject(new Error('math_stylesheet_unavailable')); }, { once: true });
    link.rel = 'stylesheet';
    link.href = href;
    document.head.append(link);
  });
}

function loadRuntime(src: string): Promise<MathRuntime> {
  if (window.theoremosMath) return Promise.resolve(window.theoremosMath);
  return new Promise<MathRuntime>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => { script.remove(); window.theoremosMath ? resolve(window.theoremosMath) : reject(new Error('math_runtime_unavailable')); };
    script.onerror = () => { script.remove(); reject(new Error('math_runtime_unavailable')); };
    document.head.append(script);
  });
}

/** One classic-script request also works from file://; offline reports embed this runtime and its fonts. */
export function loadMath(): Promise<MathRuntime> {
  if (window.theoremosMathLoading) return window.theoremosMathLoading;
  if (Date.now() < nextMathLoad) return Promise.reject(new Error('math_assets_unavailable'));
  const assets = window.theoremosMathAssets ?? { script: 'math.js', stylesheet: 'assets/katex/katex.min.css' };
  const attempt = async () => {
    // Let both requests settle so a retry can reuse whichever asset arrived.
    const [runtime, stylesheet] = await Promise.allSettled([loadRuntime(assets.script), loadStylesheet(assets.stylesheet)]);
    if (runtime.status === 'rejected') throw runtime.reason;
    if (stylesheet.status === 'rejected') throw stylesheet.reason;
    return runtime.value;
  };
  const canRetry = () => !document.hidden && navigator.onLine;
  const loading = attempt().catch(async error => {
    // Link and script errors do not expose HTTP status or Retry-After. Pending formulas share one retry.
    if (!canRetry()) throw error;
    await new Promise<void>(resolve => window.setTimeout(resolve, 5_000));
    if (!canRetry()) throw error;
    return attempt();
  }).then(math => {
    for (const render of [...mathReady]) render(math);
    return math;
  });
  window.theoremosMathLoading = loading.catch(error => {
    window.theoremosMathLoading = undefined;
    // New formulas can appear as the reader scrolls. Do not retry on each mount during a longer outage.
    nextMathLoad = Date.now() + 30_000;
    throw error;
  });
  return window.theoremosMathLoading;
}
