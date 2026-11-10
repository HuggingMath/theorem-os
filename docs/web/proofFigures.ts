export interface ProofFigureRuntime { mount(root: HTMLElement, signal: AbortSignal): void }
declare global { interface Window { theoremosProofFigures?: ProofFigureRuntime } }

let request: Promise<ProofFigureRuntime> | undefined;
let current: { root: HTMLElement; abort: AbortController } | undefined;

function loadRuntime(url: string): Promise<ProofFigureRuntime> {
  if (window.theoremosProofFigures) return Promise.resolve(window.theoremosProofFigures);
  if (!request) request = new Promise<ProofFigureRuntime>((resolve, reject) => {
    const script = document.createElement('script'); script.src = url;
    script.onload = () => {
      script.remove();
      if (window.theoremosProofFigures) resolve(window.theoremosProofFigures);
      else { request = undefined; reject(new Error('Missing mathematical figures')); }
    };
    script.onerror = () => { script.remove(); request = undefined; reject(new Error('Mathematical figures unavailable')); };
    document.head.append(script);
  });
  return request;
}

/** The drawings arrive with the selected record; controls load only for an illustrated proof. */
export function mountProofFigures(url: string): void {
  const root = document.querySelector<HTMLElement>('[data-proof-walkthrough]');
  if (current?.root === root) return;
  current?.abort.abort(); current = undefined;
  if (!root || !root.querySelector('[data-proof-figure]')) return;
  const abort = new AbortController();
  const figures = [...root.querySelectorAll<HTMLElement>('[data-proof-figure]')];
  function bind() {
    root!.dataset.proofFiguresState = 'loading';
    figures.forEach(figure => { figure.setAttribute('aria-busy', 'true'); figure.querySelector('[data-proof-figure-retry]')?.remove(); });
    void loadRuntime(url).then(runtime => {
      if (abort.signal.aborted) return;
      runtime.mount(root!, abort.signal); root!.dataset.proofFiguresState = 'ready';
      figures.forEach(figure => figure.removeAttribute('aria-busy'));
    }).catch(() => {
      if (abort.signal.aborted) return;
      root!.dataset.proofFiguresState = 'failed';
      figures.forEach(figure => {
        figure.removeAttribute('aria-busy');
        const retry = document.createElement('button'); retry.type = 'button'; retry.dataset.proofFigureRetry = '';
        retry.textContent = figure.dataset.locale === 'en' ? 'Retry interactive controls' : '重新加载图示交互';
        retry.addEventListener('click', bind, { signal: abort.signal }); figure.append(retry);
      });
    });
  }
  current = { root, abort }; bind();
}
