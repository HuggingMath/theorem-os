export type MathRuntime = Pick<typeof import('katex'), 'render'>;
type MathAssets = { script: string; stylesheet: string };
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
  return new Promise((resolve, reject) => {
    const link = existing ?? document.createElement('link');
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => { if (!existing) link.remove(); reject(new Error('math_stylesheet_unavailable')); }, { once: true });
    if (!existing) { link.rel = 'stylesheet'; link.href = href; document.head.append(link); }
  });
}

/** One classic-script request also works from file://; offline reports embed this runtime and its fonts. */
export function loadMath(): Promise<MathRuntime> {
  if (window.theoremosMathLoading) return window.theoremosMathLoading;
  const assets = window.theoremosMathAssets ?? { script: 'math.js', stylesheet: 'assets/katex/katex.min.css' };
  const runtime = window.theoremosMath ? Promise.resolve(window.theoremosMath) : new Promise<MathRuntime>((resolve, reject) => {
    const script = document.createElement('script'); script.src = assets.script;
    script.onload = () => { script.remove(); window.theoremosMath ? resolve(window.theoremosMath) : reject(new Error('math_runtime_unavailable')); };
    script.onerror = () => { script.remove(); reject(new Error('math_runtime_unavailable')); };
    document.head.append(script);
  });
  const loading = Promise.all([runtime, loadStylesheet(assets.stylesheet)]).then(([math]) => math);
  window.theoremosMathLoading = loading.catch(error => { window.theoremosMathLoading = undefined; throw error; });
  return window.theoremosMathLoading;
}
