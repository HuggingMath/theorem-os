type ReadingView = { root: HTMLElement; dispose: () => void };
let current: ReadingView | undefined;

/** Keep the proof outline and its real dependencies in sync with ordinary page reading. */
export function mountProofReading(): void {
  const found = document.querySelector<HTMLElement>('[data-proof-walkthrough]');
  if (current?.root === found) return;
  current?.dispose(); current = undefined;
  if (!found) return;
  const root: HTMLElement = found;

  const panel = root.querySelector<HTMLDetailsElement>('.proof-route-panel')!;
  const summary = panel.querySelector<HTMLElement>('summary')!;
  const map = panel.querySelector<HTMLElement>('.proof-route-map')!;
  const nodes = panel.querySelector<HTMLElement>('.proof-route-nodes')!;
  const svg = map.querySelector<SVGSVGElement>('.proof-route-edges')!;
  const buttons = [...panel.querySelectorAll<HTMLButtonElement>('[data-proof-route-step]')];
  const sections = [...root.querySelectorAll<HTMLElement>('[data-proof-derivation]')];
  const edges = [...map.querySelectorAll<SVGPathElement>('[data-proof-edge]')];
  const byId = new Map(buttons.map(button => [button.dataset.proofRouteStep!, button]));
  const narrow = matchMedia('(max-width: 1100px)');
  const abort = new AbortController();
  const options = { signal: abort.signal };
  let selected = '', frame = 0;

  function revealSelection() {
    if (!panel.open || !selected) return;
    const box = map.getBoundingClientRect(), node = byId.get(selected)!.getBoundingClientRect();
    if (node.top < box.top || node.bottom > box.bottom)
      map.scrollTop += node.top - box.top - (map.clientHeight - node.height) / 2;
  }

  function draw() {
    if (!panel.open || !map.clientWidth) return;
    const box = map.getBoundingClientRect();
    const legend = map.querySelector<HTMLElement>('.proof-route-legend');
    const height = Math.ceil(nodes.offsetHeight + (legend?.offsetHeight ?? 0) + 20);
    svg.setAttribute('viewBox', '0 0 ' + map.clientWidth + ' ' + height);
    svg.setAttribute('width', String(map.clientWidth)); svg.setAttribute('height', String(height));
    edges.forEach((edge, index) => {
      const from = byId.get(edge.dataset.from!)!.getBoundingClientRect();
      const to = byId.get(edge.dataset.to!)!.getBoundingClientRect();
      const x = from.left - box.left - 3;
      const y1 = from.top - box.top + from.height / 2 + map.scrollTop;
      const y2 = to.top - box.top + to.height / 2 + map.scrollTop;
      const lane = Math.max(3, x - 16 - (index % 8) * 4);
      edge.setAttribute('d', 'M' + x + ' ' + y1 + ' C' + lane + ' ' + y1 + ',' + lane + ' ' + y2 + ',' + x + ' ' + y2);
    });
  }

  function select(index: number) {
    const button = buttons[index];
    if (!button) return;
    const id = button.dataset.proofRouteStep!;
    if (id === selected) return;
    selected = id; root.dataset.proofActive = id;
    const inputs = new Set(edges.filter(edge => edge.dataset.to === id).map(edge => edge.dataset.from));
    const outputs = new Set(edges.filter(edge => edge.dataset.from === id).map(edge => edge.dataset.to));
    for (const node of buttons) {
      const nodeId = node.dataset.proofRouteStep;
      if (nodeId === id) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
      node.dataset.proofRelation = nodeId === id ? 'current' : inputs.has(nodeId) ? 'input' : outputs.has(nodeId) ? 'output' : 'other';
    }
    for (const edge of edges) edge.dataset.proofRelation = edge.dataset.to === id ? 'input' : edge.dataset.from === id ? 'output' : 'other';
    for (const section of sections) section.classList.toggle('is-reading', section.dataset.proofDerivation === id);
    root.querySelectorAll<HTMLElement>('[data-proof-overview-steps]').forEach(stage => {
      if (stage.dataset.proofOverviewSteps!.split(' ').includes(id)) stage.setAttribute('aria-current', 'step');
      else stage.removeAttribute('aria-current');
    });
    root.querySelectorAll('[data-proof-reading-count]').forEach(node => { node.textContent = button.dataset.proofRouteNumber + ' / ' + String(buttons.length).padStart(2, '0'); });
    root.querySelectorAll('[data-proof-reading-title]').forEach(node => { node.textContent = button.dataset.proofRouteTitle!; });
    const previous = root.querySelector<HTMLButtonElement>('[data-proof-reader="previous"]')!;
    previous.disabled = index === 0;
    previous.dataset.globalScroll = buttons[index - 1]?.dataset.globalScroll ?? '';
    const next = root.querySelector<HTMLButtonElement>('[data-proof-reader="next"]')!;
    next.dataset.globalScroll = buttons[index + 1]?.dataset.globalScroll ?? 'global-review';
    next.setAttribute('aria-label', index === buttons.length - 1 ? next.dataset.acceptanceLabel! : next.dataset.nextLabel!);
    revealSelection();
  }

  function update() {
    frame = 0;
    if (!root!.isConnected) return;
    const stages = root!.closest('.global-workflow')!.querySelector<HTMLElement>('.global-workflow-stages')!;
    const top = parseFloat(getComputedStyle(stages).top) + stages.getBoundingClientRect().height + 1;
    const reader = narrow.matches ? summary : root!.querySelector<HTMLElement>('.proof-reading-bar')!;
    root!.style.setProperty('--proof-reader-top', top + 'px');
    root!.style.setProperty('--proof-heading-clearance', (top + reader.getBoundingClientRect().height + 20) + 'px');
    const threshold = parseFloat(getComputedStyle(sections[0]).scrollMarginTop) + 6;
    let index = 0;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].getBoundingClientRect().top <= threshold) index = i; else break;
    }
    select(index); draw();
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(update); }
  function size() { panel.open = !narrow.matches; summary.setAttribute('aria-expanded', String(panel.open)); schedule(); }

  root.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLElement>('[data-global-scroll]');
    if (!target?.dataset.globalScroll?.startsWith('proof-derivation-')) return;
    const id = target.dataset.globalScroll.slice('proof-derivation-'.length);
    select(buttons.findIndex(button => button.dataset.proofRouteStep === id));
    if (narrow.matches) panel.open = false;
  }, options);
  panel.addEventListener('toggle', () => { summary.setAttribute('aria-expanded', String(panel.open)); revealSelection(); schedule(); }, options);
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && narrow.matches && panel.open) {
      event.preventDefault(); panel.open = false; summary.focus({ preventScroll: true }); return;
    }
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-proof-route-step]');
    if (!button || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = buttons.indexOf(button);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    buttons[next].focus();
  }, options);
  window.addEventListener('scroll', schedule, { ...options, passive: true });
  window.addEventListener('resize', schedule, options);
  narrow.addEventListener('change', size, options);
  const resize = new ResizeObserver(schedule);
  resize.observe(nodes); sections.forEach(section => resize.observe(section));
  select(0); size();
  void document.fonts.ready.then(() => { if (!abort.signal.aborted) schedule(); });
  current = { root, dispose: () => { abort.abort(); resize.disconnect(); cancelAnimationFrame(frame); } };
}
