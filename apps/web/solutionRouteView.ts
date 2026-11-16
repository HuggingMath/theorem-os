import type { SolutionRoute, SolutionRouteEdge, SolutionRouteNode, SolutionRouteOrigin, SolutionRouteSection } from './solutionRoute';
import { h, render } from 'preact';
import { Rich, RichProse } from './client/richText';

type Options = { onSelect?: (id: string) => void; onOpen?: (target: string) => void; /** The workbench panel: secondary controls stay folded until the reader asks for them. */ compact?: boolean };
type Memory = { selected: string; zoom: number; left: number; top: number; all: boolean; library: boolean; opened: Set<string>; query: string; reading: boolean; more: boolean; details: Map<string, boolean>;
  /** The zoom came from "fit", so a resized frame fits again while a hand-panned map keeps its place. */ fitted: boolean;
  /** The frame the last fit was computed against, so expanding the canvas can fit again without resizing loops. */ fitWidth: number; fitHeight: number;
  /** The step details column is open beside the map; folding it gives the map the whole panel. */ detail: boolean };
/** The workbench panel is narrow: fitting a wide route there shrinks text past reading, so the map scrolls instead. */
const readableZoom = .75;
type Box = { x: number; y: number; width: number; height: number };
const memories = new Map<string, Memory>();
const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const statusNames = {
  zh: { passed: '已通过', failed: '未通过', running: '进行中', pending: '待完成', conditional: '有条件通过', human: '人类决策', recorded: '已记录' },
  en: { passed: 'Passed', failed: 'Failed', running: 'In progress', pending: 'Pending', conditional: 'Conditional', human: 'Human decision', recorded: 'Recorded' },
};
const kindNames = {
  zh: { problem: '原题', plan: '研究计划', task: '数学任务', finding: '研究推导', attempt: '证明尝试', check: '检查', decision: '人类决策', proof: '完整证明', review: '审阅', acceptance: '独立验收', outcome: '运行结果', declaration: '证明声明', derivation: '推导步骤', group: '源码分组' },
  en: { problem: 'Problem', plan: 'Plan', task: 'Mathematical task', finding: 'Research', attempt: 'Proof attempt', check: 'Check', decision: 'Human decision', proof: 'Complete proof', review: 'Review', acceptance: 'Independent acceptance', outcome: 'Run outcome', declaration: 'Declaration', derivation: 'Derivation step', group: 'Source group' },
};
const originNames: Record<'zh' | 'en', Record<SolutionRouteOrigin, string>> = {
  zh: { target: '主定理', lemma: '本证明的引理', definition: '本证明的定义', computation: '由计算判定', given: '题目给定', library: '库里的结论' },
  en: { target: 'Main theorem', lemma: 'Lemma of this proof', definition: 'Definition of this proof', computation: 'Decided by computation', given: 'Given by the problem', library: 'Library result' },
};
const origins: SolutionRouteOrigin[] = ['target', 'lemma', 'definition', 'computation', 'given', 'library'];
const edgeKinds: SolutionRouteEdge['kind'][] = ['dependency', 'sequence', 'integration', 'decision', 'evidence', 'reference'];

/** A folded record keeps its place at the nearest ancestor that remains in the graph. */
export function visibleSolutionRouteSelection(model: SolutionRoute, visible: readonly SolutionRouteNode[], selected: string): string {
  const ids = new Set(visible.map(node => node.id)), byId = new Map(model.nodes.map(node => [node.id, node]));
  const visited = new Set<string>();
  let id: string | undefined = selected;
  while (id && !visited.has(id)) {
    if (ids.has(id)) return id;
    visited.add(id); id = byId.get(id)?.parentId;
  }
  return visible[0]?.id ?? selected;
}

/** All main nodes keep their dependency ranks; the recorded work expands beneath its owning node. */
export function solutionRouteLayout(model: SolutionRoute, nodes: readonly SolutionRouteNode[]) {
  const present = new Set(nodes.map(node => node.id));
  const main = nodes.filter(node => !node.parentId || !present.has(node.parentId));
  const mainIds = new Set(main.map(node => node.id)), ranks = new Map(main.map(node => [node.id, 0]));
  const outgoing = new Map<string, string[]>(), incoming = new Map(main.map(node => [node.id, 0]));
  const children = new Map<string, SolutionRouteNode[]>();
  for (const node of nodes) if (node.parentId && present.has(node.parentId)) {
    const siblings = children.get(node.parentId) ?? []; siblings.push(node); children.set(node.parentId, siblings);
  }
  for (const edge of model.edges) if (mainIds.has(edge.from) && mainIds.has(edge.to)) {
    const next = outgoing.get(edge.from) ?? []; next.push(edge.to); outgoing.set(edge.from, next);
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
  }
  const queue = main.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor];
    for (const next of outgoing.get(id) ?? []) {
      ranks.set(next, Math.max(ranks.get(next)!, ranks.get(id)! + 1));
      incoming.set(next, incoming.get(next)! - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }
  // Lexical source references can be cyclic. Keep those declarations together rather than inventing an ordering.
  const columns = new Map<number, SolutionRouteNode[]>();
  for (const node of main) {
    const rank = ranks.get(node.id)!, members = columns.get(rank) ?? []; members.push(node); columns.set(rank, members);
  }
  const boxes = new Map<string, Box>();
  for (const [rank, members] of columns) {
    let y = 30;
    for (const node of members) {
      const pending = [{ node, depth: 0 }];
      while (pending.length) {
        const item = pending.pop()!;
        if (boxes.has(item.node.id)) continue;
        const inset = Math.min(42, item.depth * 14);
        boxes.set(item.node.id, { x: 30 + rank * 298 + inset, y, width: 238 - inset, height: 140 }); y += 162;
        for (const child of [...children.get(item.node.id) ?? []].reverse()) pending.push({ node: child, depth: item.depth + 1 });
      }
      y += 20;
    }
  }
  // A nested record can outlive its parent in a bounded trajectory page.
  for (const node of nodes) if (!boxes.has(node.id)) boxes.set(node.id, { x: 30, y: 30 + boxes.size * 206, width: 238, height: 180 });
  return { boxes, width: Math.max(298, ...[...boxes.values()].map(box => box.x + box.width + 30)),
    height: Math.max(180, ...[...boxes.values()].map(box => box.y + box.height + 30)) };
}

export function mountSolutionRoute(root: HTMLElement, initial: SolutionRoute, options: Options = {}) {
  let model = initial, lastInitial = initial.initial, destroyed = false;
  let expanded = false, previousOverflow = '';
  let composingSearch: HTMLInputElement | undefined, pendingSearchUpdate: SolutionRoute | undefined;
  let state = memory(initial);
  const signal = new AbortController();
  const word = (zh: string, en: string) => model.locale === 'en' ? en : zh;
  const detailScroller = () => {
    const workspace = root.querySelector<HTMLElement>('.solution-route-workspace');
    if (expanded && workspace && getComputedStyle(workspace).overflowY === 'auto') return workspace;
    const inspector = root.querySelector<HTMLElement>('[data-solution-inspector]');
    if (!inspector || getComputedStyle(inspector).overflowY !== 'visible') return inspector;
    // Inline reading follows the page or workbench pane rather than the detail element.
    for (let parent = inspector.parentElement; parent; parent = parent.parentElement)
      if (/(auto|scroll)/u.test(getComputedStyle(parent).overflowY)) return parent;
    return document.scrollingElement as HTMLElement;
  };
  const detailAnchors = () => [...root.querySelectorAll<HTMLElement>('[data-solution-heading], [data-solution-section-heading], .solution-route-records li')];
  // The visible top of a scroller is also bounded by every clipping ancestor, so a detail pane partly covered by its host still reads the true edge.
  const scrollportTop = (scroller: HTMLElement) => {
    if (scroller === document.scrollingElement) return 0;
    let top = Math.max(0, scroller.getBoundingClientRect().top + scroller.clientTop);
    for (let parent = scroller.parentElement; parent; parent = parent.parentElement)
      if (/(auto|scroll|hidden|clip)/u.test(getComputedStyle(parent).overflowY)) top = Math.max(top, parent.getBoundingClientRect().top + parent.clientTop);
    return top;
  };
  function detailPosition() {
    const scroller = detailScroller();
    if (!scroller) return;
    const top = scrollportTop(scroller), anchors = detailAnchors();
    const index = Math.max(0, anchors.findLastIndex(anchor => anchor.getBoundingClientRect().top <= top));
    return { top: scroller.scrollTop, index, offset: anchors[index] ? anchors[index].getBoundingClientRect().top - top : 0 };
  }
  function restoreDetailPosition(position: ReturnType<typeof detailPosition>) {
    const scroller = detailScroller();
    if (!position || !scroller) return;
    if (!expanded && scroller !== document.scrollingElement) scroller.scrollIntoView({ block: 'nearest' });
    const anchor = detailAnchors()[position.index];
    if (anchor) scroller.scrollTop += anchor.getBoundingClientRect().top - scrollportTop(scroller) - position.offset;
    else scroller.scrollTop = position.top;
  }
  const nodesById = () => new Map(model.nodes.map(node => [node.id, node]));
  const related = (id: string, incoming: boolean) => model.edges.filter(edge => incoming ? edge.to === id : edge.from === id)
    .map(edge => ({ edge, node: model.nodes.find(node => node.id === (incoming ? edge.from : edge.to))! })).filter(item => item.node);
  const edgeName = (edge: SolutionRouteEdge) => edge.kind === 'dependency' ? word('依赖', 'Dependency')
    : edge.kind === 'reference' ? word('源码引用', 'Source reference') : edge.kind === 'sequence' ? word('记录顺序', 'Recorded order')
      : edge.kind === 'decision' ? word('决策', 'Decision') : edge.kind === 'integration' ? word('接入结果', 'Contributes to result') : word('依据记录', 'Recorded evidence');
  function memory(next: SolutionRoute): Memory {
    let saved = memories.get(next.id);
    if (!saved) {
      const selected = next.initial ?? next.nodes[0]?.id ?? '', opened = new Set<string>();
      let parent = next.nodes.find(node => node.id === selected)?.parentId;
      while (parent && !opened.has(parent)) { opened.add(parent); parent = next.nodes.find(node => node.id === parent)?.parentId; }
      saved = { selected, zoom: 1, left: 0, top: 0, all: false, library: false, opened, query: '', reading: false, more: false, details: new Map(),
        fitted: false, fitWidth: 0, fitHeight: 0, detail: false }; memories.set(next.id, saved);
    }
    return saved;
  }
  function shown() {
    const query = state.query.trim().toLocaleLowerCase();
    const byId = nodesById();
    if (!query) return model.nodes.filter(node => {
      // Cited library results stay out of the map until asked for; a selected one is shown.
      if (node.origin === 'library') return state.library || node.id === state.selected;
      if (state.all) return true;
      const visited = new Set<string>();
      let current = node;
      while (current.parentId && byId.has(current.parentId)) {
        if (!state.opened.has(current.parentId) || visited.has(current.parentId)) return false;
        visited.add(current.parentId); current = byId.get(current.parentId)!;
      }
      return true;
    });
    const matches = model.nodes.filter(node => [node.title, node.summary, ...(node.sections ?? []).flatMap(section => [section.text, section.reason])]
      .some(value => value?.toLocaleLowerCase().includes(query)));
    const ids = new Set(matches.map(node => node.id));
    for (const node of matches) {
      let parent = node.parentId;
      while (parent && byId.has(parent) && !ids.has(parent)) { ids.add(parent); parent = byId.get(parent)!.parentId; }
    }
    return model.nodes.filter(node => ids.has(node.id) && (node.origin !== 'library' || state.library || node.id === state.selected));
  }
  function inspector() {
    const node = nodesById().get(state.selected) ?? model.nodes[0];
    if (!node) return '';
    const relation = (incoming: boolean) => {
      const items = related(node.id, incoming).filter(item => item.edge.kind !== 'evidence' || !item.node.parentId);
      if (!items.length) return '';
      const renderRelations = (members: typeof items, title: string) => members.length ? `<section class="solution-route-relations"><h5>${title}</h5>${members.map(({ edge, node: other }) => `<button type="button" data-solution-select="${html(other.id)}"><span>${edgeName(edge)}</span><strong data-solution-prose>${html(other.title)}</strong>${other.summary && other.summary !== other.title ? `<span class="solution-route-relation-preview" data-solution-prose>${html(other.summary)}</span>` : ''} ${incoming ? '↑' : '→'}</button>`).join('')}</section>` : '';
      if (model.basis !== 'explanation') return renderRelations(items, incoming ? word('这一步从哪里来', 'What this step uses') : word('接下来到哪里', 'What follows'));
      const mathematical = items.filter(item => item.edge.kind === 'dependency' || item.edge.kind === 'reference');
      return renderRelations(mathematical, incoming ? word('用到的结论', 'Results used here') : word('本步结论用于', 'Where this result is used'))
        + renderRelations(items.filter(item => item.edge.kind === 'sequence'), word('阅读顺序', 'Reading order'));
    };
    const children = model.nodes.filter(item => item.parentId === node.id);
    const source = node.source;
    const sections = (node.sections ?? []).filter(section => section.text.trim());
    const supporting = (section: SolutionRouteSection) => section.detail || (model.basis === 'explanation' && section.code);
    const sectionContent = (section: SolutionRouteSection, index: number) => `<section class="solution-route-section"><h5 tabindex="-1" data-solution-section-heading="${index}"><span class="solution-route-section-number">${String(index + 1).padStart(2, '0')}</span>${html(section.title)}</h5>${section.code ? `<pre tabindex="0"><code>${html(section.text)}</code></pre>` : `<div data-solution-prose="block">${html(section.text)}</div>`}${section.reason ? `<div class="solution-route-reason" data-solution-prose="block">${html(section.reason)}</div>` : ''}</section>`;
    const evidence = sections.map((section, index) => supporting(section) ? sectionContent(section, index) : '').join('');
    const summary = node.summary && !sections.some(section => !section.code && section.text.trim() === node.summary!.trim()) ? node.summary : '';
    return `<header class="solution-route-detail-heading">${options.compact && !state.reading ? `<button type="button" class="solution-route-detail-close" data-solution-detail-close aria-label="${word('收起步骤详情', 'Close step details')}">×</button>` : ''}<p>${node.origin ? originNames[model.locale][node.origin] : kindNames[model.locale][node.kind]}<span data-status="${node.status}">${statusNames[model.locale][node.status]}</span></p><h4 tabindex="-1" data-solution-heading="${html(node.id)}" data-solution-prose>${html(node.title)}</h4>
      ${!state.reading ? `<button type="button" class="solution-route-read" data-solution-view="read">${word('展开阅读', 'Read in full')} ↗</button>` : ''}</header>
      ${summary ? `<div class="solution-route-summary" data-solution-prose="block">${html(summary)}</div>` : ''}
      ${node.at ? `<time>${html(node.at)}</time>` : ''}
      ${state.reading && sections.filter(section => !supporting(section)).length > 2 ? `<nav class="solution-route-contents" aria-label="${word('这一步的内容', 'Contents of this step')}">${sections.map((section, index) => supporting(section) ? '' : `<button type="button" data-solution-section="${index}"><span>${String(index + 1).padStart(2, '0')}</span>${html(section.title)}</button>`).join('')}</nav>` : ''}
      ${relation(true)}
      ${sections.map((section, index) => supporting(section) ? '' : sectionContent(section, index)).join('')}
      ${evidence ? `<details class="solution-route-evidence" data-solution-details="evidence:${html(node.id)}"${state.details.get(`evidence:${node.id}`) ? ' open' : ''}><summary>${word('证明依据与补充', 'Proof evidence and details')}</summary>${evidence}</details>` : ''}
      ${source ? `<details class="solution-route-source" data-solution-details="source:${html(node.id)}"${state.details.get(`source:${node.id}`) ? ' open' : ''}><summary>${html(source.name)}${source.line ? `:${source.line}${source.endLine && source.endLine !== source.line ? `–${source.endLine}` : ''}` : ''}</summary>${source.sha256 ? `<p>SHA-256 <code>${html(source.sha256)}</code></p>` : ''}${source.commit ? `<p>commit <code>${html(source.commit)}</code></p>` : ''}</details>` : ''}
      ${children.length ? `<section class="solution-route-records"><h5>${word('这一步的完整记录', 'Every record for this step')} <span>${children.length}</span></h5><button type="button" class="solution-route-children" data-solution-children="${html(node.id)}" aria-expanded="${state.all || state.opened.has(node.id)}">${state.all || state.opened.has(node.id) ? word('收起这些步骤', 'Collapse these steps') : word('在图中展开这些步骤', 'Expand these steps in the graph')}</button><ol>${children.map(child => `<li><button type="button" data-solution-select="${html(child.id)}" data-status="${child.status}"><span>${kindNames[model.locale][child.kind]} · ${statusNames[model.locale][child.status]}</span><strong data-solution-prose>${html(child.title)}</strong>${child.summary ? `<span class="solution-route-record-preview" data-solution-prose>${html(child.summary)}</span>` : ''}</button></li>`).join('')}</ol></section>` : ''}
      ${relation(false)}
      ${node.action ? `<button type="button" class="solution-route-open" data-solution-open="${html(node.id)}">${html(node.action.label)} ↗</button>` : ''}`;
  }
  /** The kinds of line and of declaration now on the map, so a reader can tell the proof's own lemmas from computed, given or library facts. */
  function legend(visible: readonly SolutionRouteNode[], ids: ReadonlySet<string>) {
    const lines = edgeKinds.filter(kind => model.edges.some(edge => edge.kind === kind && ids.has(edge.from) && ids.has(edge.to)));
    const present = origins.filter(origin => visible.some(node => node.origin === origin));
    return `<span class="solution-route-legend">${lines.map(kind => `<span><i data-edge="${kind}"></i>${edgeName({ from: '', to: '', kind })}</span>`).join('')}</span>`
      + (present.length ? `<span class="solution-route-legend">${present.map(origin => `<span><i data-origin="${origin}"></i>${originNames[model.locale][origin]}</span>`).join('')}</span>` : '');
  }
  function draw() {
    if (destroyed) return;
    const visible = shown(), layout = solutionRouteLayout(model, visible), ids = new Set(visible.map(node => node.id));
    const adjacent = new Set([state.selected, ...model.edges.filter(edge => edge.from === state.selected || edge.to === state.selected).flatMap(edge => [edge.from, edge.to])]);
    root.classList.add('solution-route'); root.dataset.solutionRouteId = model.id; root.dataset.solutionRouteBasis = model.basis;
    root.dataset.solutionExpanded = String(expanded); root.dataset.solutionReading = String(state.reading);
    root.dataset.solutionCompact = String(Boolean(options.compact)); root.dataset.solutionMore = String(state.more);
    root.dataset.solutionDetail = String(state.detail);
    if (expanded) { root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', model.title); }
    else { root.removeAttribute('role'); root.removeAttribute('aria-modal'); root.removeAttribute('aria-label'); }
    root.innerHTML = `<header class="solution-route-heading"><div><h3 data-solution-prose="inline">${html(model.title)}</h3><p>${model.basis === 'source' ? word('证明声明与源码引用', 'Proof declarations and source references') : model.basis === 'explanation' ? word('推导步骤与所用结论', 'Derivation steps and the results they use') : word('任务依赖、推导、尝试与验收', 'Tasks, reasoning, attempts and acceptance')}</p></div><span data-solution-count>${state.reading ? model.nodes.length : `${visible.length} / ${model.nodes.length}`} ${state.reading ? word('步骤', 'steps') : word('节点', 'nodes')}</span></header>
      ${model.overview?.length ? `<div class="solution-route-overview">${model.overview.filter(section => section.text.trim()).map(section => `<section><h4>${html(section.title)}</h4>${section.code ? `<pre tabindex="0"><code>${html(section.text)}</code></pre>` : `<div data-solution-prose="block">${html(section.text)}</div>`}</section>`).join('')}</div>` : ''}
      ${model.stages?.length ? `<nav class="solution-route-stages" aria-label="${word('证明主线', 'Proof outline')}">${model.stages.map((stage, index) => `<button type="button" data-solution-select="${html(stage.nodeIds[0])}"${stage.nodeIds.includes(state.selected) ? ' aria-current="step"' : ''}><span>${String(index + 1).padStart(2, '0')}</span><strong data-solution-prose>${html(stage.title)}</strong><span data-solution-prose>${html(stage.summary)}</span></button>`).join('')}</nav>` : ''}
      <div class="solution-route-tools">${options.compact ? `<button type="button" class="solution-route-more" data-solution-more aria-pressed="${state.more}" aria-expanded="${state.more}">${state.more ? word('收起选项', 'Fewer options') : word('更多选项', 'More options')}</button>` : ''}<label class="solution-route-search"><span class="sr-only">${word('查找路线中的步骤', 'Find a route step')}</span><input type="search" data-solution-search placeholder="${word('查找目标、引理或推导', 'Find a goal, lemma or derivation')}" value="${html(state.query)}"></label>
        ${model.nodes.some(node => node.parentId) ? `<button type="button" data-solution-all aria-pressed="${state.all || state.opened.size > 0}">${state.all || state.opened.size ? word('收起步骤', 'Collapse steps') : word('展开全部步骤', 'Expand every step')}</button>` : ''}
        ${model.nodes.some(node => node.origin === 'library') ? `<button type="button" data-solution-library aria-pressed="${state.library}">${word('库里的结论', 'Library results')} ${model.nodes.filter(node => node.origin === 'library').length}</button>` : ''}
        <div class="solution-route-view-controls" role="group" aria-label="${word('阅读方式', 'Reading view')}"><button type="button" data-solution-view="map" aria-pressed="${!state.reading}">${word('路线图', 'Route map')}</button><button type="button" data-solution-view="read" aria-pressed="${state.reading}">${word('阅读推导', 'Read reasoning')}</button></div>
        ${state.reading ? `<label class="solution-route-step-picker"><span>${word('当前步骤', 'Current step')}</span><select data-solution-reader-select aria-label="${word('跳转到路线中的步骤', 'Jump to a route step')}">${model.nodes.map((node, index) => `<option value="${html(node.id)}"${node.id === state.selected ? ' selected' : ''}>${String(index + 1).padStart(2, '0')} · ${html(node.title)}</option>`).join('')}</select><span>${model.nodes.findIndex(node => node.id === state.selected) + 1} / ${model.nodes.length}</span></label>` : ''}
        <div role="group" aria-label="${word('路线图缩放', 'Route zoom')}"><button type="button" data-solution-zoom="out" aria-label="${word('缩小', 'Zoom out')}">−</button><button type="button" data-solution-zoom="reset" aria-label="${word('恢复原始大小', 'Reset zoom')}"><output>${Math.round(state.zoom * 100)}%</output></button><button type="button" data-solution-zoom="in" aria-label="${word('放大', 'Zoom in')}">＋</button><button type="button" data-solution-zoom="fit">${word('查看全图', 'Fit route')}</button>${options.compact && !state.reading ? `<button type="button" data-solution-detail-toggle aria-pressed="${state.detail}">${state.detail ? word('只看路线图', 'Map only') : word('打开步骤详情', 'Step details')}</button>` : ''}<button type="button" data-solution-expand aria-expanded="${expanded}">${expanded ? word('收起画布', 'Close canvas') : word('展开画布', 'Expand canvas')}</button></div></div>
      <div class="solution-route-workspace"><div class="solution-route-viewport" tabindex="0" aria-label="${word('交互路线图，可拖动平移并选择步骤', 'Interactive route: drag to pan and select a step')}"><div class="solution-route-scaled"><div class="solution-route-canvas">
      <svg class="solution-route-lines" width="${layout.width}" height="${layout.height}" aria-hidden="true"><defs><marker id="solution-arrow-${html(model.id.replace(/[^a-zA-Z0-9]/gu, ''))}" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7"/></marker></defs>${model.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)).map(edge => {
        const a = layout.boxes.get(edge.from)!, b = layout.boxes.get(edge.to)!;
        const vertical = Math.abs(a.x - b.x) < 30;
        const x1 = vertical ? a.x + a.width / 2 : a.x + a.width, y1 = vertical ? a.y + a.height : a.y + a.height / 2;
        const x2 = vertical ? b.x + b.width / 2 : b.x, y2 = vertical ? b.y : b.y + b.height / 2;
        const bend = Math.max(24, Math.abs(x2 - x1) / 2);
        const d = vertical ? `M${x1} ${y1} C${x1} ${y1 + 20},${x2} ${y2 - 20},${x2} ${y2}` : `M${x1} ${y1} C${x1 + bend} ${y1},${x2 - bend} ${y2},${x2} ${y2}`;
        return `<path d="${d}" data-solution-edge="${edge.kind}" data-from="${html(edge.from)}" data-to="${html(edge.to)}" data-connected="${edge.from === state.selected || edge.to === state.selected}" marker-end="url(#solution-arrow-${html(model.id.replace(/[^a-zA-Z0-9]/gu, ''))})"/>`;
      }).join('')}</svg>${visible.map((node, index) => {
        return `<button type="button" class="solution-route-node" data-solution-node="${html(node.id)}" data-roadmap-node="${html(node.id)}" data-status="${node.status}"${node.origin ? ` data-origin="${node.origin}"` : ''} data-connected="${adjacent.has(node.id)}" aria-pressed="${node.id === state.selected}"><span class="solution-route-node-meta"><span>${String(index + 1).padStart(2, '0')} · ${node.origin ? originNames[model.locale][node.origin] : kindNames[model.locale][node.kind]}</span><span>${statusNames[model.locale][node.status]}</span></span><strong data-solution-prose>${html(node.title)}</strong>${node.summary ? `<span class="solution-route-node-summary" data-solution-prose>${html(node.summary)}</span>` : ''}</button>`;
      }).join('')}</div></div>${!visible.length ? `<p class="solution-route-empty">${word('没有匹配的步骤。换一个关键词，或清空搜索。', 'No matching steps. Try another term or clear the search.')}</p>` : ''}</div>
      <aside class="solution-route-detail" data-solution-inspector aria-label="${word('路线步骤详情', 'Route step details')}" aria-live="polite">${inspector()}</aside></div>
      <footer class="solution-route-footer">${legend(visible, ids)}${model.partial ? `<span>${word('当前记录尚未全部读取', 'Some records have not been loaded')}</span>` : ''}<div><button type="button" data-solution-step="previous">← ${word('上一步', 'Previous')}</button><button type="button" data-solution-step="next">${word('下一步', 'Next')} →</button></div></footer>`;
    // A fitted map follows its frame: opening the drawer, expanding the canvas or resizing the panel fits again.
    const frame = root.querySelector<HTMLElement>('.solution-route-viewport');
    if (frame && state.fitted && !state.reading && state.fitWidth && (frame.clientWidth !== state.fitWidth || frame.clientHeight !== state.fitHeight)) {
      state.fitWidth = frame.clientWidth; state.fitHeight = frame.clientHeight;
      const exact = Math.min(1, (state.fitWidth - 10) / layout.width, (state.fitHeight - 10) / layout.height);
      state.zoom = options.compact && !expanded ? Math.max(readableZoom, exact) : Math.max(.00001, exact);
      state.left = 0; state.top = 0;
      const output = root.querySelector<HTMLElement>('[data-solution-zoom="reset"] output'); if (output) output.textContent = `${Math.round(state.zoom * 100)}%`;
    }
    // Apply layout through CSSOM: the workbench CSP intentionally disallows HTML style attributes.
    const space = root.querySelector<HTMLElement>('.solution-route-scaled')!;
    space.style.width = `${layout.width * state.zoom}px`; space.style.height = `${layout.height * state.zoom}px`;
    const canvas = root.querySelector<HTMLElement>('.solution-route-canvas')!;
    canvas.style.width = `${layout.width}px`; canvas.style.height = `${layout.height}px`; canvas.style.transform = `scale(${state.zoom})`;
    for (const button of root.querySelectorAll<HTMLElement>('[data-solution-node]')) {
      const box = layout.boxes.get(button.dataset.solutionNode!)!;
      button.style.left = `${box.x}px`; button.style.top = `${box.y}px`;
      button.style.width = `${box.width}px`; button.style.height = `${box.height}px`;
    }
    const viewport = root.querySelector<HTMLElement>('.solution-route-viewport')!;
    viewport.scrollLeft = state.left; viewport.scrollTop = state.top;
    for (const element of root.querySelectorAll<HTMLElement>('[data-solution-prose]')) {
      const text = element.textContent ?? '';
      element.replaceChildren();
      render(h(element.dataset.solutionProse === 'block' ? RichProse : Rich, { text }), element);
    }
  }
  function select(id: string, focus = false) {
    const node = nodesById().get(id); if (!node) return;
    state.selected = id;
    if (node.parentId && !state.all) {
      const byId = nodesById(), visited = new Set<string>();
      let parent: string | undefined = node.parentId;
      while (parent && byId.has(parent) && !visited.has(parent)) {
        state.opened.add(parent); visited.add(parent); parent = byId.get(parent)!.parentId;
      }
    }
    if (state.query && !shown().some(item => item.id === id)) state.query = '';
    // Picking a step in the narrow panel is a request to read it: open the details over the map.
    if (options.compact && !state.reading) state.detail = true;
    draw();
    if (state.reading) {
      if (focus) {
        if (expanded) detailScroller()!.scrollTop = 0;
        const heading = root.querySelector<HTMLElement>('[data-solution-heading]');
        heading?.focus({ preventScroll: true });
        root.querySelector<HTMLElement>('[data-solution-inspector]')?.scrollIntoView({ block: 'nearest' });
      }
      options.onSelect?.(id); return;
    }
    const button = [...root.querySelectorAll<HTMLButtonElement>('[data-solution-node]')].find(button => button.dataset.solutionNode === id);
    button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus) button?.focus({ preventScroll: true });
    options.onSelect?.(id);
  }
  function revealSearchResult() {
    const viewport = root.querySelector<HTMLElement>('.solution-route-viewport')!;
    const button = root.querySelector<HTMLElement>('[data-solution-node][aria-pressed="true"]')
      ?? root.querySelector<HTMLElement>('[data-solution-node]');
    if (!button) return;
    // The drawer covers the right edge of the map; keep the chosen step in the part still in view.
    const drawer = root.querySelector<HTMLElement>('.solution-route-detail');
    const covered = options.compact && state.detail && drawer && drawer.getClientRects().length ? drawer.offsetWidth : 0;
    const visible = Math.max(160, viewport.clientWidth - covered);
    const left = button.offsetLeft * state.zoom, top = button.offsetTop * state.zoom;
    const right = left + button.offsetWidth * state.zoom, bottom = top + button.offsetHeight * state.zoom;
    if (left < viewport.scrollLeft) viewport.scrollLeft = left;
    else if (right > viewport.scrollLeft + visible) viewport.scrollLeft = right - visible;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom - viewport.clientHeight;
    state.left = viewport.scrollLeft; state.top = viewport.scrollTop;
  }
  /** Fit the whole route, but never below a size whose node titles can still be read: then the map scrolls instead. */
  function fit(reveal = false) {
    const viewport = root.querySelector<HTMLElement>('.solution-route-viewport');
    if (!viewport) return;
    const layout = solutionRouteLayout(model, shown());
    const exact = Math.min(1, (viewport.clientWidth - 10) / layout.width, (viewport.clientHeight - 10) / layout.height);
    // Only the narrow workbench panel needs the floor; a full-page route has the width to fit every declaration.
    state.zoom = options.compact && !expanded ? Math.max(readableZoom, exact) : Math.max(.00001, exact);
    state.fitWidth = viewport.clientWidth; state.fitHeight = viewport.clientHeight;
    state.left = 0; state.top = 0;
    draw();
    if (reveal && !state.reading) revealSearchResult();
  }
  function expand(value: boolean) {
    if (value === expanded) return;
    const position = detailPosition();
    expanded = value;
    if (expanded) { previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    else document.body.style.overflow = previousOverflow;
    draw(); restoreDetailPosition(position);
    if (!state.reading) revealSearchResult();
    root.querySelector<HTMLButtonElement>('[data-solution-expand]')?.focus({ preventScroll: true });
  }
  function drawVisibleSelection() {
    const previous = state.selected;
    if (!state.reading) state.selected = visibleSolutionRouteSelection(model, shown(), state.selected);
    draw();
    if (!state.reading) revealSearchResult();
    if (previous !== state.selected) options.onSelect?.(state.selected);
  }
  function reading(value: boolean) {
    if (value === state.reading) return;
    state.reading = value; drawVisibleSelection();
    if (value) root.querySelector<HTMLElement>('[data-solution-heading]')?.focus({ preventScroll: true });
    else {
      revealSearchResult();
      root.querySelector<HTMLElement>('[data-solution-node][aria-pressed="true"]')?.focus({ preventScroll: true });
    }
    if (!expanded) root.querySelector<HTMLElement>('.solution-route-tools')?.scrollIntoView({ block: value ? 'start' : 'nearest' });
  }
  root.addEventListener('toggle', event => {
    const details = event.target as HTMLDetailsElement;
    if (root.contains(details) && details.matches('details[data-solution-details]')) state.details.set(details.dataset.solutionDetails!, details.open);
  }, { capture: true, signal: signal.signal });
  root.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLElement>('button'); if (!target || !root.contains(target)) return;
    if (target.dataset.solutionNode || target.dataset.solutionSelect) { select(target.dataset.solutionNode ?? target.dataset.solutionSelect!, true); return; }
    if (target.hasAttribute('data-solution-more')) {
      state.more = !state.more; draw();
      root.querySelector<HTMLButtonElement>('[data-solution-more]')?.focus({ preventScroll: true }); return;
    }
    if (target.dataset.solutionView) { reading(target.dataset.solutionView === 'read'); return; }
    if (target.dataset.solutionSection) {
      const heading = root.querySelector<HTMLElement>(`[data-solution-section-heading="${target.dataset.solutionSection}"]`);
      const details = heading?.closest('details'); if (details) details.open = true;
      heading?.focus({ preventScroll: true }); heading?.scrollIntoView({ block: 'start', inline: 'nearest' }); return;
    }
    if (target.dataset.solutionOpen) {
      const action = nodesById().get(target.dataset.solutionOpen)?.action;
      if (action && options.onOpen) {
        // Evidence lives outside the canvas. Restore its normal layout before opening the reader.
        expand(false); options.onOpen(action.target);
      }
      return;
    }
    if (target.hasAttribute('data-solution-all')) {
      state.all = !state.all && state.opened.size === 0; state.opened.clear(); drawVisibleSelection();
      root.querySelector<HTMLButtonElement>('[data-solution-all]')?.focus({ preventScroll: true }); return;
    }
    if (target.hasAttribute('data-solution-library')) {
      state.library = !state.library; drawVisibleSelection();
      root.querySelector<HTMLButtonElement>('[data-solution-library]')?.focus({ preventScroll: true }); return;
    }
    if (target.dataset.solutionChildren) {
      const id = target.dataset.solutionChildren;
      if (state.all) { state.all = false; state.opened = new Set(model.nodes.flatMap(node => node.parentId ? [node.parentId] : [])); }
      if (state.opened.has(id)) state.opened.delete(id); else state.opened.add(id);
      drawVisibleSelection(); root.querySelector<HTMLButtonElement>('[data-solution-children]')?.focus({ preventScroll: true }); return;
    }
    if (target.hasAttribute('data-solution-expand')) { expand(!expanded); return; }
    if (target.hasAttribute('data-solution-detail-toggle')) {
      state.detail = !state.detail; draw();
      root.querySelector<HTMLButtonElement>('[data-solution-detail-toggle]')?.focus({ preventScroll: true }); return;
    }
    if (target.hasAttribute('data-solution-detail-close')) {
      state.detail = false; draw();
      root.querySelector<HTMLButtonElement>('[data-solution-detail-toggle]')?.focus({ preventScroll: true }); return;
    }
    const zoom = target.dataset.solutionZoom;
    if (zoom) {
      const viewport = root.querySelector<HTMLElement>('.solution-route-viewport')!;
      const center = { x: (viewport.scrollLeft + viewport.clientWidth / 2) / state.zoom, y: (viewport.scrollTop + viewport.clientHeight / 2) / state.zoom };
      if (zoom === 'fit') { state.fitted = true; fit(true); }
      else {
        state.fitted = false;
        state.zoom = Math.max(.1, Math.min(2, zoom === 'reset' ? 1 : state.zoom + (zoom === 'in' ? .1 : -.1)));
        state.left = Math.max(0, center.x * state.zoom - viewport.clientWidth / 2);
        state.top = Math.max(0, center.y * state.zoom - viewport.clientHeight / 2);
        draw();
      }
      root.querySelector<HTMLButtonElement>(`[data-solution-zoom="${zoom}"]`)?.focus({ preventScroll: true }); return;
    }
    if (target.dataset.solutionStep) {
      const nodes = state.reading ? model.nodes : shown();
      const selected = visibleSolutionRouteSelection(model, nodes, state.selected), at = nodes.findIndex(node => node.id === selected);
      select(nodes[Math.max(0, Math.min(nodes.length - 1, at + (target.dataset.solutionStep === 'next' ? 1 : -1)))]?.id ?? '', true);
    }
  }, { signal: signal.signal });
  root.addEventListener('change', event => {
    const input = event.target as HTMLSelectElement;
    if (!input.matches('[data-solution-reader-select]')) return;
    select(input.value, true); root.querySelector<HTMLElement>('[data-solution-reader-select]')?.focus({ preventScroll: true });
  }, { signal: signal.signal });
  function search(input: HTMLInputElement, pending?: SolutionRoute) {
    if (state.query === input.value && !pending) return;
    const selection = { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
    state.query = input.value; state.left = 0; state.top = 0;
    if (pending) controller.update(pending); else draw();
    revealSearchResult();
    const next = root.querySelector<HTMLInputElement>('[data-solution-search]')!; next.focus({ preventScroll: true });
    next.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
  }
  root.addEventListener('compositionstart', event => {
    const input = event.target as HTMLInputElement;
    if (input.matches('[data-solution-search]')) composingSearch = input;
  }, { signal: signal.signal });
  root.addEventListener('compositionend', event => {
    const input = event.target as HTMLInputElement; if (!input.matches('[data-solution-search]')) return;
    const pending = pendingSearchUpdate; composingSearch = undefined; pendingSearchUpdate = undefined;
    search(input, pending);
  }, { signal: signal.signal });
  root.addEventListener('input', event => {
    const input = event.target as HTMLInputElement; if (!input.matches('[data-solution-search]')) return;
    if ((event as InputEvent).isComposing || input === composingSearch) return;
    search(input);
  }, { signal: signal.signal });
  root.addEventListener('scroll', event => {
    const viewport = event.target as HTMLElement;
    if (!viewport.classList?.contains('solution-route-viewport')) return;
    state.left = viewport.scrollLeft; state.top = viewport.scrollTop;
  }, { capture: true, signal: signal.signal });
  root.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (expanded && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); expand(false); return; }
    if (expanded && event.key === 'Tab') {
      const focusable = [...root.querySelectorAll<HTMLElement>('button,input,select,summary,[tabindex="0"]')].filter(element => !element.hasAttribute('disabled') && element.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-solution-node]');
    if (!target || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const visible = shown(), id = target.dataset.solutionNode!;
    const adjacent = related(id, event.key === 'ArrowLeft' || event.key === 'ArrowUp').map(item => item.node).filter(node => visible.some(item => item.id === node.id));
    const index = visible.findIndex(node => node.id === id);
    const next = event.key === 'Home' ? visible[0] : event.key === 'End' ? visible.at(-1)
      : adjacent[0] ?? visible[index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1)];
    if (next) select(next.id, true);
  }, { signal: signal.signal });
  let drag: { x: number; y: number; left: number; top: number; viewport: HTMLElement } | undefined;
  root.addEventListener('pointerdown', event => {
    const viewport = (event.target as Element).closest<HTMLElement>('.solution-route-viewport');
    if (!viewport || event.button !== 0 || event.pointerType === 'touch' || (event.target as Element).closest('button')) return;
    drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, viewport };
    viewport.setPointerCapture(event.pointerId); viewport.dataset.dragging = 'true';
  }, { signal: signal.signal });
  root.addEventListener('pointermove', event => {
    if (!drag) return;
    drag.viewport.scrollLeft = drag.left - event.clientX + drag.x; drag.viewport.scrollTop = drag.top - event.clientY + drag.y;
  }, { signal: signal.signal });
  const stop = () => { if (drag) delete drag.viewport.dataset.dragging; drag = undefined; };
  root.addEventListener('pointerup', stop, { signal: signal.signal }); root.addEventListener('pointercancel', stop, { signal: signal.signal });
  draw();
  const controller = {
    select,
    update(next: SolutionRoute) {
      if (destroyed) return;
      // Keep the native IME composition range intact while the same route refreshes.
      if (composingSearch?.isConnected && next.id === model.id) { pendingSearchUpdate = next; return; }
      composingSearch = undefined; pendingSearchUpdate = undefined;
      const previous = model, previousInitial = lastInitial, previousSelection = state.selected;
      model = next; lastInitial = next.initial;
      if (previous.id !== next.id) state = memory(next);
      // A changed initial navigates within one route; another route restores its own reading position.
      if (previous.id === next.id && next.initial !== previousInitial && next.initial && next.nodes.some(node => node.id === next.initial)) state.selected = next.initial;
      if (!next.nodes.some(node => node.id === state.selected)) state.selected = next.nodes.find(node => node.id === next.initial)?.id ?? next.nodes[0]?.id ?? '';
      const active = root.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
      const focus = active?.dataset.solutionNode, searchFocused = active?.matches('[data-solution-search]');
      const controlAttribute = active?.getAttributeNames().find(name => name.startsWith('data-solution-'));
      const controlValue = controlAttribute ? active!.getAttribute(controlAttribute) : undefined;
      const viewportFocused = active?.classList.contains('solution-route-viewport');
      const codeIndex = active?.tagName === 'PRE' ? [...root.querySelectorAll('pre')].indexOf(active as HTMLPreElement) : -1;
      const openDetails = previous.id === next.id && previousSelection === state.selected
        ? [...root.querySelectorAll('details')].map(details => details.open) : undefined;
      const input = searchFocused ? active as HTMLInputElement : undefined;
      const selection = input ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : undefined;
      const detailTop = detailScroller()?.scrollTop ?? 0;
      draw();
      if (openDetails) root.querySelectorAll('details').forEach((details, index) => { details.open = openDetails[index] ?? false; });
      if (focus) [...root.querySelectorAll<HTMLButtonElement>('[data-solution-node]')].find(button => button.dataset.solutionNode === focus)?.focus({ preventScroll: true });
      else if (controlAttribute) [...root.querySelectorAll<HTMLElement>(`[${controlAttribute}]`)].find(button => button.getAttribute(controlAttribute) === controlValue)?.focus({ preventScroll: true });
      else if (viewportFocused) root.querySelector<HTMLElement>('.solution-route-viewport')?.focus({ preventScroll: true });
      else if (codeIndex >= 0) root.querySelectorAll<HTMLPreElement>('pre')[codeIndex]?.focus({ preventScroll: true });
      else if (active?.tagName === 'SUMMARY') {
        const id = active.parentElement?.dataset.solutionDetails;
        [...root.querySelectorAll<HTMLElement>('details[data-solution-details]')].find(details => details.dataset.solutionDetails === id)?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
      }
      if (searchFocused) {
        const next = root.querySelector<HTMLInputElement>('[data-solution-search]')!; next.focus({ preventScroll: true });
        if (selection) next.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
      }
      detailScroller()!.scrollTop = detailTop;
    },
    destroy() { destroyed = true; signal.abort(); if (expanded) document.body.style.overflow = previousOverflow;
      root.removeAttribute('role'); root.removeAttribute('aria-modal'); root.removeAttribute('aria-label');
      delete root.dataset.solutionExpanded; delete root.dataset.solutionReading; root.innerHTML = ''; },
  };
  return controller;
}
