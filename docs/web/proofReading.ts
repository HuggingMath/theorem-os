import { archiveReadingReturn, readProofReadingPosition } from './proofReadingLocation';

type ReadingView = { root: HTMLElement; dispose: () => void };
let current: ReadingView | undefined;
let locationView: (ReadingView & { reveal: () => boolean; href: (anchor: string) => string }) | undefined;

/** Restore a shared position only within the same accepted proof. */
export function revealProofReadingLocation(): boolean { return locationView?.reveal() ?? false; }
export function proofReadingLink(anchor?: string): string { return anchor && locationView ? locationView.href(anchor) : location.href; }

function mountReadingLocation(ready: Promise<void>) {
  const root = document.querySelector<HTMLElement>('[data-proof-solution]');
  if (locationView?.root === root) return;
  locationView?.dispose(); locationView = undefined;
  if (!root) return;
  const sections = [...root.querySelectorAll<HTMLElement>('[data-proof-derivation], [data-proof-source-declaration], [id^="proof-source-helper-"]')];
  const byId = new Map(sections.map(section => [section.id, section]));
  const proofId = root.dataset.proofSolution!, proofSha = root.dataset.proofSolutionSha!;
  const parameters = new URLSearchParams(location.hash.slice(1));
  const position = parameters.get('proof') === proofId ? readProofReadingPosition(parameters) : undefined;
  const requested = position?.proofSha === proofSha ? byId.get(position.anchor) : undefined;
  const abort = new AbortController(), options = { signal: abort.signal };
  const definitionOrigins = new Map<string, { section: HTMLElement; trigger: HTMLElement; x: number; y: number }>();
  let restoring = Boolean(requested), selected = '', frame = 0, ignoreScrollUntil = 0;

  function updateResearchLink() {
    const reading = new URL(location.href), parameters = new URLSearchParams(reading.hash.slice(1));
    parameters.set('proof', proofId); parameters.set('tab', 'reading'); reading.hash = parameters.toString();
    for (const link of root!.querySelectorAll<HTMLAnchorElement>('[data-proof-start-research], [data-proof-position-research]')) {
      const sourceLocation = new URL(reading.href), parameters = new URLSearchParams(sourceLocation.hash.slice(1));
      if (link.dataset.proofPositionResearch) {
        parameters.set('reading', link.dataset.proofPositionResearch); parameters.set('readingSha', proofSha);
        sourceLocation.hash = parameters.toString();
      }
      const source = archiveReadingReturn(sourceLocation.href, proofId, location.href, proofSha);
      const destination = new URL(link.href);
      if (source) destination.searchParams.set('archiveReading', source);
      else destination.searchParams.delete('archiveReading');
      link.href = destination.href;
    }
  }

  function remember(section: HTMLElement) {
    if (restoring || selected === section.id || !root!.isConnected) return;
    const url = new URL(location.href), parameters = new URLSearchParams(url.hash.slice(1));
    if (parameters.get('proof') !== proofId || parameters.get('tab') !== 'reading') return;
    selected = section.id;
    parameters.set('reading', section.id); parameters.set('readingSha', proofSha);
    url.hash = parameters.toString(); history.replaceState(null, '', url);
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a.lang-link')) link.hash = url.hash;
    updateResearchLink();
  }

  function update() {
    frame = 0;
    if (restoring || performance.now() < ignoreScrollUntil || !root!.isConnected) return;
    let active: HTMLElement | undefined;
    for (const section of sections) {
      if (!section.getClientRects().length) continue;
      const threshold = (parseFloat(getComputedStyle(section).scrollMarginTop) || 0) + 6;
      if (section.getBoundingClientRect().top <= threshold) active = section;
      else break;
    }
    if (active) remember(active);
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(update); }

  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  function reveal(finish = true) {
    if (!requested || !root!.isConnected) return false;
    for (let parent: HTMLElement | null = requested; parent && parent !== root; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    requested.scrollIntoView({ block: 'start' });
    requested.querySelector<HTMLElement>('h5, summary')?.focus({ preventScroll: true });
    const url = new URL(location.href), currentParams = new URLSearchParams(url.hash.slice(1));
    if (currentParams.get('proof') === proofId && currentParams.get('tab') === 'reading') {
      currentParams.set('reading', requested.id); currentParams.set('readingSha', proofSha);
      url.hash = currentParams.toString(); history.replaceState(null, '', url);
      for (const link of document.querySelectorAll<HTMLAnchorElement>('a.lang-link')) link.hash = url.hash;
      updateResearchLink();
    }
    if (finish) {
      clearTimeout(revealTimer);
      revealTimer = setTimeout(() => {
        if (abort.signal.aborted || !requested || !root!.isConnected) return;
        const heading = requested.querySelector<HTMLElement>('h5, summary');
        const bounds = heading?.getBoundingClientRect();
        if (bounds && (bounds.top < 0 || bounds.top >= innerHeight)) requested.scrollIntoView({ block: 'start' });
        if (heading && document.activeElement !== heading) heading.focus({ preventScroll: true });
        restoring = false; ignoreScrollUntil = performance.now() + 220; remember(requested);
      }, 60);
    }
    return true;
  }

  if (!requested && parameters.get('proof') === proofId && (parameters.has('reading') || parameters.has('readingSha'))) {
    parameters.delete('reading'); parameters.delete('readingSha');
    const url = new URL(location.href); url.hash = parameters.toString(); history.replaceState(null, '', url);
  }
  root.addEventListener('click', event => {
    const back = (event.target as Element).closest<HTMLElement>('[data-proof-definition-return]');
    if (back) {
      const origin = definitionOrigins.get(back.dataset.proofDefinitionReturn!);
      if (origin?.trigger.isConnected) {
        for (let parent: HTMLElement | null = origin.trigger; parent && parent !== root; parent = parent.parentElement)
          if (parent instanceof HTMLDetailsElement) parent.open = true;
        origin.trigger.focus({ preventScroll: true });
        window.scrollTo({ left: origin.x, top: origin.y, behavior: 'instant' });
        restoring = false; remember(origin.section);
      }
      return;
    }
    const target = (event.target as Element).closest<HTMLElement>('[data-global-scroll]');
    const section = target?.dataset.globalScroll && byId.get(target.dataset.globalScroll);
    if (section) {
      if (target?.hasAttribute('data-proof-definition-jump')) {
        const origin = target.closest<HTMLElement>('[data-proof-source-declaration]');
        if (origin) {
          definitionOrigins.set(section.id, { section: origin, trigger: target, x: scrollX, y: scrollY });
          const back = section.querySelector<HTMLButtonElement>('[data-proof-definition-return]');
          if (back) back.hidden = false;
        }
      }
      restoring = false; ignoreScrollUntil = performance.now() + 220; remember(section);
      const keepRemembered = () => {
        selected = section.id;
        const url = new URL(location.href), currentParams = new URLSearchParams(url.hash.slice(1));
        if (currentParams.get('proof') === proofId && currentParams.get('tab') === 'reading' && currentParams.get('reading') !== section.id) {
          currentParams.set('reading', section.id); currentParams.set('readingSha', proofSha);
          url.hash = currentParams.toString(); history.replaceState(null, '', url);
          for (const link of document.querySelectorAll<HTMLAnchorElement>('a.lang-link')) link.hash = url.hash;
          updateResearchLink();
        }
      };
      requestAnimationFrame(() => requestAnimationFrame(keepRemembered));
    }
  }, options);
  window.addEventListener('scroll', schedule, { ...options, passive: true });
  window.addEventListener('resize', schedule, options);
  const resize = new ResizeObserver(schedule); sections.forEach(section => resize.observe(section));
  updateResearchLink();
  void Promise.all([ready, document.fonts.ready]).then(() => {
    if (abort.signal.aborted) return;
    requestAnimationFrame(() => {
      if (abort.signal.aborted) return;
      if (!reveal(false)) { schedule(); return; }
      requestAnimationFrame(() => { if (!abort.signal.aborted) reveal(true); });
    });
  });
  locationView = { root, reveal, href: anchor => {
    if (!byId.has(anchor)) return location.href;
    const url = new URL(location.href), parameters = new URLSearchParams(url.hash.slice(1));
    parameters.set('reading', anchor); parameters.set('readingSha', proofSha); url.hash = parameters.toString();
    return url.href;
  }, dispose: () => { clearTimeout(revealTimer); abort.abort(); resize.disconnect(); cancelAnimationFrame(frame); } };
}

/** Keep the proof outline and its real dependencies in sync with ordinary page reading. */
export function mountProofReading(ready = Promise.resolve()): void {
  const found = document.querySelector<HTMLElement>('[data-proof-walkthrough]');
  if (!found || current?.root !== found) {
    current?.dispose(); current = undefined;
  }
  if (!found) { mountReadingLocation(ready); return; }
  if (current?.root === found) { mountReadingLocation(ready); return; }
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
    const stages = root!.closest('.global-workflow')?.querySelector<HTMLElement>('.global-workflow-stages');
    const top = stages ? parseFloat(getComputedStyle(stages).top) + stages.getBoundingClientRect().height + 1 : 12;
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
    // Let the page consume the clicked target before selection updates the reader buttons.
    schedule();
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
  select(0);
  panel.open = !narrow.matches; summary.setAttribute('aria-expanded', String(panel.open));
  update();
  mountReadingLocation(ready);
  void Promise.all([ready, document.fonts.ready]).then(() => { if (!abort.signal.aborted) schedule(); });
  current = { root, dispose: () => { abort.abort(); resize.disconnect(); cancelAnimationFrame(frame); } };
}
