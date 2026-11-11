import { archiveSolutionRoutes } from './archiveSolutionRoute';
import { mountSolutionRoute } from '../../apps/web/solutionRouteView';
import type { ArchiveSolutionRuntime } from './solutionRouteClient';
import { typesetProse } from '../../apps/web/client/typesetProse';

const modes = new Map<string, string>();
const runtime: ArchiveSolutionRuntime = {
  typeset: typesetProse,
  mount(root, record, process, runId, locale) {
    const run = process.runs.find(item => item.runId === runId);
    const models = archiveSolutionRoutes(record, process, run, locale);
    if (!models.length) { root.textContent = locale === 'en' ? 'No proof source or research record was saved.' : '没有保存证明源码或研究记录。'; return { destroy() {} }; }
    const key = `${record.id}/${runId}/${locale}`;
    const saved = models.findIndex(model => model.id === modes.get(key));
    let active = saved >= 0 ? saved : Math.max(0, models.findIndex(model => model.basis === 'explanation'));
    const navigation = document.createElement('div'); navigation.className = 'solution-route-modes';
    const graph = document.createElement('div'); root.replaceChildren(navigation, graph);
    const controller = mountSolutionRoute(graph, models[active], { onOpen(target) {
      let action: unknown; try { action = JSON.parse(target); } catch { return; }
      root.dispatchEvent(new CustomEvent('theoremos-solution-open', { bubbles: true, detail: action }));
    } });
    const abort = new AbortController();
    models.forEach((model, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.solutionMode = model.basis;
      button.textContent = model.basis === 'recorded' ? locale === 'en' ? 'Solution route' : '解题路线'
        : model.basis === 'explanation' ? locale === 'en' ? 'Derivation' : '证明推导' : locale === 'en' ? 'Proof structure' : '证明结构';
      button.setAttribute('aria-pressed', String(index === active));
      button.addEventListener('click', () => {
        active = index; modes.set(key, model.id); controller.update(model);
        for (const child of navigation.querySelectorAll('button')) child.setAttribute('aria-pressed', String(child === button));
      }, { signal: abort.signal });
      navigation.append(button);
    });
    if (models.length === 1) navigation.hidden = true;
    return { destroy() { abort.abort(); controller.destroy(); } };
  },
};
window.theoremosSolutionRoutes = runtime;
