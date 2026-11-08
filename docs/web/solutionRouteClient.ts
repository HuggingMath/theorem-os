import version from 'virtual:solution-route';
import { rootOf, type Locale } from './site';
import type { ArchiveIndexRecord, ArchiveProcess } from './types';

export interface ArchiveSolutionRuntime {
  mount(root: HTMLElement, record: ArchiveIndexRecord, process: ArchiveProcess, runId: string, locale: Locale): { destroy(): void };
}
declare global { interface Window { theoremosSolutionRoutes?: ArchiveSolutionRuntime } }
let request: Promise<ArchiveSolutionRuntime> | undefined;
let current: { root: HTMLElement; abort: AbortController; controller?: { destroy(): void } } | undefined;

function load(locale: Locale) {
  if (window.theoremosSolutionRoutes) return Promise.resolve(window.theoremosSolutionRoutes);
  if (!request) request = new Promise<ArchiveSolutionRuntime>((resolve, reject) => {
    const script = document.createElement('script'); script.src = `${rootOf(locale)}data/solution-route.js?v=${version}`;
    script.onload = () => { script.remove(); if (window.theoremosSolutionRoutes) resolve(window.theoremosSolutionRoutes); else { request = undefined; reject(new Error('Missing route controls')); } };
    script.onerror = () => { script.remove(); request = undefined; reject(new Error('Route controls unavailable')); };
    document.head.append(script);
  });
  return request;
}

/** A single lazy renderer serves any imported problem and any selected historical run. */
export async function mountArchiveSolutionRoutes(record: ArchiveIndexRecord, process: ArchiveProcess, locale: Locale): Promise<void> {
  const root = document.querySelector<HTMLElement>('[data-solution-route-record]');
  if (current?.root === root) return;
  current?.abort.abort(); current?.controller?.destroy(); current = undefined;
  if (!root || root.dataset.solutionRouteRecord !== record.id) return;
  const instance = { root, abort: new AbortController(), controller: undefined as { destroy(): void } | undefined }; current = instance;
  const bind = async () => {
    root.dataset.solutionRouteState = 'loading'; root.setAttribute('aria-busy', 'true');
    root.innerHTML = `<p class="solution-route-loading">${locale === 'en' ? 'Loading the solution route…' : '正在读取解题路线…'}</p>`;
    try {
      const runtime = await load(locale); if (instance.abort.signal.aborted || !root.isConnected) return;
      instance.controller = runtime.mount(root, record, process, root.dataset.solutionRouteRun ?? '', locale);
      root.dataset.solutionRouteState = 'ready'; root.removeAttribute('aria-busy');
    } catch {
      if (instance.abort.signal.aborted) return;
      root.dataset.solutionRouteState = 'failed'; root.removeAttribute('aria-busy'); root.innerHTML = '';
      const retry = document.createElement('button'); retry.type = 'button'; retry.dataset.solutionRetry = '';
      retry.textContent = locale === 'en' ? 'Reload the solution route' : '重新加载解题路线';
      retry.addEventListener('click', () => void bind(), { signal: instance.abort.signal }); root.append(retry);
    }
  };
  await bind();
}
