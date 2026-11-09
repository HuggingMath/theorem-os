import type { SolutionRoute, SolutionRouteEdge, SolutionRouteNode } from './solutionRoute';
import { h, render } from 'preact';
import { Rich, RichProse } from './client/richText';

type Options = { onSelect?: (id: string) => void; onOpen?: (target: string) => void };
type Memory = { selected: string; zoom: number; left: number; top: number; all: boolean; opened: Set<string>; query: string; reading: boolean };
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
        boxes.set(item.node.id, { x: 30 + rank * 298 + inset, y, width: 238 - inset, height: 180 }); y += 206;
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
  let state = memory(initial);
  const signal = new AbortController();
  const word = (zh: string, en: string) => model.locale === 'en' ? en : zh;
  const detailScroller = () => {
    const workspace = root.querySelector<HTMLElement>('.solution-route-workspace');
    return expanded && workspace && getComputedStyle(workspace).overflowY === 'auto'
      ? workspace : root.querySelector<HTMLElement>('[data-solution-inspector]');
  };
  const nodesById = () => new Map(model.nodes.map(node => [node.id, node]));
  const related = (id: string, incoming: boolean) => model.edges.filter(edge => incoming ? edge.to === id : edge.from === id)
    .map(edge => ({ edge, node: model.nodes.find(node => node.id === (incoming ? edge.from : edge.to))! })).filter(item => item.node);
  const edgeName = (edge: SolutionRouteEdge) => edge.kind === 'dependency' ? word('依赖', 'Dependency')
    : edge.kind === 'reference' ? word('源码引用', 'Source reference') : edge.kind === 'sequence' ? word('记录顺序', 'Recorded order')
      : edge.kind === 'decision' ? word('决策', 'Decision') : edge.kind === 'integration' ? word('接入结果', 'Contributes to result') : word('依据记录', 'Recorded evidence');
  function memory(next: SolutionRoute): Memory {
    let saved = memories.get(next.id);
    if (!saved) { saved = { selected: next.initial ?? next.nodes[0]?.id ?? '', zoom: 1, left: 0, top: 0, all: false, opened: new Set(), query: '', reading: false }; memories.set(next.id, saved); }
    return saved;
  }
  function shown() {
    const query = state.query.trim().toLocaleLowerCase();
    const byId = nodesById();
    if (!query) return model.nodes.filter(node => {
      if (state.all) return true;
      const visited = new Set<string>();
      let current = node;
      while (current.parentId && byId.has(current.parentId)) {
        if (!state.opened.has(current.parentId) || visited.has(current.parentId)) return false;
        visited.add(current.parentId); current = byId.get(current.parentId)!;
      }
      return true;
    });
    const matches = model.nodes.filter(node => [node.title, node.summary, ...(node.sections ?? []).map(section => section.text)]
      .some(value => value?.toLocaleLowerCase().includes(query)));
    const ids = new Set(matches.map(node => node.id));
    for (const node of matches) {
      let parent = node.parentId;
      while (parent && byId.has(parent) && !ids.has(parent)) { ids.add(parent); parent = byId.get(parent)!.parentId; }
    }
    return model.nodes.filter(node => ids.has(node.id));
  }
  function inspector() {
    const node = nodesById().get(state.selected) ?? model.nodes[0];
    if (!node) return '';
    const relation = (incoming: boolean) => {
      const items = related(node.id, incoming).filter(item => item.edge.kind !== 'evidence' || !item.node.parentId);
      if (!items.length) return '';
      return `<section class="solution-route-relations"><h5>${incoming ? word('这一步从哪里来', 'What this step uses') : word('接下来到哪里', 'What follows')}</h5>${items.map(({ edge, node: other }) => `<button type="button" data-solution-select="${html(other.id)}"><span>${edgeName(edge)}</span>${html(other.title)} ${incoming ? '↑' : '→'}</button>`).join('')}</section>`;
    };
    const children = model.nodes.filter(item => item.parentId === node.id);
    const source = node.source;
    const sections = (node.sections ?? []).filter(section => section.text.trim());
    const summary = node.summary && !sections.some(section => !section.code && section.text.trim() === node.summary!.trim()) ? node.summary : '';
    return `<header class="solution-route-detail-heading"><p>${kindNames[model.locale][node.kind]}<span data-status="${node.status}">${statusNames[model.locale][node.status]}</span></p><h4 tabindex="-1" data-solution-heading="${html(node.id)}" data-solution-prose>${html(node.title)}</h4>
      ${!state.reading ? `<button type="button" class="solution-route-read" data-solution-view="read">${word('展开阅读', 'Read in full')} ↗</button>` : ''}</header>
      ${summary ? `<div class="solution-route-summary" data-solution-prose="block">${html(summary)}</div>` : ''}
      ${node.at ? `<time>${html(node.at)}</time>` : ''}
      ${state.reading && sections.length > 2 ? `<nav class="solution-route-contents" aria-label="${word('这一步的内容', 'Contents of this step')}">${sections.map((section, index) => `<button type="button" data-solution-section="${index}"><span>${String(index + 1).padStart(2, '0')}</span>${html(section.title)}</button>`).join('')}</nav>` : ''}
      ${relation(true)}
      ${sections.map((section, index) => `<section class="solution-route-section"><h5 tabindex="-1" data-solution-section-heading="${index}"><span class="solution-route-section-number">${String(index + 1).padStart(2, '0')}</span>${html(section.title)}</h5>${section.code ? `<pre tabindex="0"><code>${html(section.text)}</code></pre>` : `<div data-solution-prose="block">${html(section.text)}</div>`}</section>`).join('')}
      ${source ? `<details class="solution-route-source"><summary>${html(source.name)}${source.line ? `:${source.line}${source.endLine && source.endLine !== source.line ? `–${source.endLine}` : ''}` : ''}</summary>${source.sha256 ? `<p>SHA-256 <code>${html(source.sha256)}</code></p>` : ''}${source.commit ? `<p>commit <code>${html(source.commit)}</code></p>` : ''}</details>` : ''}
      ${children.length ? `<section class="solution-route-records"><h5>${word('这一步的完整记录', 'Every record for this step')} <span>${children.length}</span></h5><button type="button" class="solution-route-children" data-solution-children="${html(node.id)}" aria-expanded="${state.all || state.opened.has(node.id)}">${state.all || state.opened.has(node.id) ? word('收起这些步骤', 'Collapse these steps') : word('在图中展开这些步骤', 'Expand these steps in the graph')}</button><ol>${children.map(child => `<li><button type="button" data-solution-select="${html(child.id)}" data-status="${child.status}"><span>${kindNames[model.locale][child.kind]} · ${statusNames[model.locale][child.status]}</span><strong data-solution-prose>${html(child.title)}</strong>${child.summary ? `<span class="solution-route-record-preview" data-solution-prose>${html(child.summary)}</span>` : ''}</button></li>`).join('')}</ol></section>` : ''}
      ${relation(false)}
      ${node.action ? `<button type="button" class="solution-route-open" data-solution-open="${html(node.id)}">${html(node.action.label)} ↗</button>` : ''}`;
  }
  function draw() {
    if (destroyed) return;
    const visible = shown(), layout = solutionRouteLayout(model, visible), ids = new Set(visible.map(node => node.id));
    const adjacent = new Set([state.selected, ...model.edges.filter(edge => edge.from === state.selected || edge.to === state.selected).flatMap(edge => [edge.from, edge.to])]);
    root.classList.add('solution-route'); root.dataset.solutionRouteId = model.id; root.dataset.solutionRouteBasis = model.basis;
    root.dataset.solutionExpanded = String(expanded); root.dataset.solutionReading = String(state.reading);
    if (expanded) { root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', model.title); }
    else { root.removeAttribute('role'); root.removeAttribute('aria-modal'); root.removeAttribute('aria-label'); }
    root.innerHTML = `<header class="solution-route-heading"><div><h3>${html(model.title)}</h3><p>${model.basis === 'source' ? word('证明声明与源码引用', 'Proof declarations and source references') : model.basis === 'explanation' ? word('推导步骤与所用结论', 'Derivation steps and the results they use') : word('任务依赖、推导、尝试与验收', 'Tasks, reasoning, attempts and acceptance')}</p></div><span data-solution-count>${state.reading ? model.nodes.length : `${visible.length} / ${model.nodes.length}`} ${state.reading ? word('步骤', 'steps') : word('节点', 'nodes')}</span></header>
      <div class="solution-route-tools"><label class="solution-route-search"><span class="sr-only">${word('查找路线中的步骤', 'Find a route step')}</span><input type="search" data-solution-search placeholder="${word('查找目标、引理或推导', 'Find a goal, lemma or derivation')}" value="${html(state.query)}"></label>
        ${model.nodes.some(node => node.parentId) ? `<button type="button" data-solution-all aria-pressed="${state.all || state.opened.size > 0}">${state.all || state.opened.size ? word('收起步骤', 'Collapse steps') : word('展开全部步骤', 'Expand every step')}</button>` : ''}
        <div class="solution-route-view-controls" role="group" aria-label="${word('阅读方式', 'Reading view')}"><button type="button" data-solution-view="map" aria-pressed="${!state.reading}">${word('路线图', 'Route map')}</button><button type="button" data-solution-view="read" aria-pressed="${state.reading}">${word('阅读推导', 'Read reasoning')}</button></div>
        ${state.reading ? `<label class="solution-route-step-picker"><span>${word('当前步骤', 'Current step')}</span><select data-solution-reader-select aria-label="${word('跳转到路线中的步骤', 'Jump to a route step')}">${model.nodes.map((node, index) => `<option value="${html(node.id)}"${node.id === state.selected ? ' selected' : ''}>${String(index + 1).padStart(2, '0')} · ${html(node.title)}</option>`).join('')}</select><span>${model.nodes.findIndex(node => node.id === state.selected) + 1} / ${model.nodes.length}</span></label>` : ''}
        <div role="group" aria-label="${word('路线图缩放', 'Route zoom')}"><button type="button" data-solution-zoom="out" aria-label="${word('缩小', 'Zoom out')}">−</button><button type="button" data-solution-zoom="reset" aria-label="${word('恢复原始大小', 'Reset zoom')}"><output>${Math.round(state.zoom * 100)}%</output></button><button type="button" data-solution-zoom="in" aria-label="${word('放大', 'Zoom in')}">＋</button><button type="button" data-solution-zoom="fit">${word('查看全图', 'Fit route')}</button><button type="button" data-solution-expand aria-expanded="${expanded}">${expanded ? word('收起画布', 'Close canvas') : word('展开画布', 'Expand canvas')}</button></div></div>
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
        return `<button type="button" class="solution-route-node" data-solution-node="${html(node.id)}" data-roadmap-node="${html(node.id)}" data-status="${node.status}" data-connected="${adjacent.has(node.id)}" aria-pressed="${node.id === state.selected}"><span class="solution-route-node-meta"><span>${String(index + 1).padStart(2, '0')} · ${kindNames[model.locale][node.kind]}</span><span>${statusNames[model.locale][node.status]}</span></span><strong data-solution-prose>${html(node.title)}</strong>${node.summary ? `<span class="solution-route-node-summary" data-solution-prose>${html(node.summary)}</span>` : ''}</button>`;
      }).join('')}</div></div>${!visible.length ? `<p class="solution-route-empty">${word('没有匹配的步骤。换一个关键词，或清空搜索。', 'No matching steps. Try another term or clear the search.')}</p>` : ''}</div>
      <aside class="solution-route-detail" data-solution-inspector aria-label="${word('路线步骤详情', 'Route step details')}" aria-live="polite">${inspector()}</aside></div>
      <footer class="solution-route-footer"><span>${word('实线：依赖或流程 · 虚线：依据或源码引用', 'Solid: dependencies or flow · Dashed: evidence or source references')}</span>${model.partial ? `<span>${word('当前记录尚未全部读取', 'Some records have not been loaded')}</span>` : ''}<div><button type="button" data-solution-step="previous">← ${word('上一步', 'Previous')}</button><button type="button" data-solution-step="next">${word('下一步', 'Next')} →</button></div></footer>`;
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
    const left = button.offsetLeft * state.zoom, top = button.offsetTop * state.zoom;
    const right = left + button.offsetWidth * state.zoom, bottom = top + button.offsetHeight * state.zoom;
    if (left < viewport.scrollLeft) viewport.scrollLeft = left;
    else if (right > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = right - viewport.clientWidth;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom - viewport.clientHeight;
    state.left = viewport.scrollLeft; state.top = viewport.scrollTop;
  }
  function expand(value: boolean) {
    if (value === expanded) return;
    expanded = value;
    if (expanded) { previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    else document.body.style.overflow = previousOverflow;
    draw(); root.querySelector<HTMLButtonElement>('[data-solution-expand]')?.focus({ preventScroll: true });
  }
  function reading(value: boolean) {
    if (value === state.reading) return;
    state.reading = value; draw();
    if (value) root.querySelector<HTMLElement>('[data-solution-heading]')?.focus({ preventScroll: true });
    else {
      revealSearchResult();
      root.querySelector<HTMLElement>('[data-solution-node][aria-pressed="true"]')?.focus({ preventScroll: true });
    }
    if (!expanded) root.querySelector<HTMLElement>('.solution-route-tools')?.scrollIntoView({ block: value ? 'start' : 'nearest' });
  }
  root.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLElement>('button'); if (!target || !root.contains(target)) return;
    if (target.dataset.solutionNode || target.dataset.solutionSelect) { select(target.dataset.solutionNode ?? target.dataset.solutionSelect!, true); return; }
    if (target.dataset.solutionView) { reading(target.dataset.solutionView === 'read'); return; }
    if (target.dataset.solutionSection) {
      const heading = root.querySelector<HTMLElement>(`[data-solution-section-heading="${target.dataset.solutionSection}"]`);
      heading?.focus({ preventScroll: true }); heading?.scrollIntoView({ block: 'start', inline: 'nearest' }); return;
    }
    if (target.dataset.solutionOpen) { const action = nodesById().get(target.dataset.solutionOpen)?.action; if (action) options.onOpen?.(action.target); return; }
    if (target.hasAttribute('data-solution-all')) {
      state.all = !state.all && state.opened.size === 0; state.opened.clear(); draw();
      root.querySelector<HTMLButtonElement>('[data-solution-all]')?.focus({ preventScroll: true }); return;
    }
    if (target.dataset.solutionChildren) {
      const id = target.dataset.solutionChildren;
      if (state.all) { state.all = false; state.opened = new Set(model.nodes.flatMap(node => node.parentId ? [node.parentId] : [])); }
      if (state.opened.has(id)) state.opened.delete(id); else state.opened.add(id);
      draw(); root.querySelector<HTMLButtonElement>('[data-solution-children]')?.focus({ preventScroll: true }); return;
    }
    if (target.hasAttribute('data-solution-expand')) { expand(!expanded); return; }
    const zoom = target.dataset.solutionZoom;
    if (zoom) {
      const viewport = root.querySelector<HTMLElement>('.solution-route-viewport')!, layout = solutionRouteLayout(model, shown());
      const center = { x: (viewport.scrollLeft + viewport.clientWidth / 2) / state.zoom, y: (viewport.scrollTop + viewport.clientHeight / 2) / state.zoom };
      state.zoom = zoom === 'fit' ? Math.max(.00001, Math.min(1, (viewport.clientWidth - 10) / layout.width, (viewport.clientHeight - 10) / layout.height))
        : Math.max(.1, Math.min(2, zoom === 'reset' ? 1 : state.zoom + (zoom === 'in' ? .1 : -.1)));
      state.left = zoom === 'fit' ? 0 : Math.max(0, center.x * state.zoom - viewport.clientWidth / 2);
      state.top = zoom === 'fit' ? 0 : Math.max(0, center.y * state.zoom - viewport.clientHeight / 2);
      draw(); root.querySelector<HTMLButtonElement>(`[data-solution-zoom="${zoom}"]`)?.focus({ preventScroll: true }); return;
    }
    if (target.dataset.solutionStep) {
      const nodes = state.reading ? model.nodes : shown(), at = nodes.findIndex(node => node.id === state.selected);
      select(nodes[Math.max(0, Math.min(nodes.length - 1, at + (target.dataset.solutionStep === 'next' ? 1 : -1)))]?.id ?? '', true);
    }
  }, { signal: signal.signal });
  root.addEventListener('change', event => {
    const input = event.target as HTMLSelectElement;
    if (!input.matches('[data-solution-reader-select]')) return;
    select(input.value, true); root.querySelector<HTMLElement>('[data-solution-reader-select]')?.focus({ preventScroll: true });
  }, { signal: signal.signal });
  root.addEventListener('input', event => {
    const input = event.target as HTMLInputElement; if (!input.matches('[data-solution-search]')) return;
    const selection = { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
    state.query = input.value; state.left = 0; state.top = 0; draw();
    if (state.query.trim()) revealSearchResult();
    const next = root.querySelector<HTMLInputElement>('[data-solution-search]')!; next.focus({ preventScroll: true });
    next.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
  }, { signal: signal.signal });
  root.addEventListener('scroll', event => {
    const viewport = event.target as HTMLElement;
    if (!viewport.classList?.contains('solution-route-viewport')) return;
    state.left = viewport.scrollLeft; state.top = viewport.scrollTop;
  }, { capture: true, signal: signal.signal });
  root.addEventListener('keydown', event => {
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
  return {
    select,
    update(next: SolutionRoute) {
      if (destroyed) return;
      const previous = model, previousInitial = lastInitial;
      model = next; lastInitial = next.initial;
      if (previous.id !== next.id) state = memory(next);
      if (next.initial !== previousInitial && next.initial && next.nodes.some(node => node.id === next.initial)) state.selected = next.initial;
      if (!next.nodes.some(node => node.id === state.selected)) state.selected = next.initial ?? next.nodes[0]?.id ?? '';
      const active = root.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
      const focus = active?.dataset.solutionNode, searchFocused = active?.matches('[data-solution-search]');
      const controlAttribute = active?.getAttributeNames().find(name => name.startsWith('data-solution-'));
      const controlValue = controlAttribute ? active!.getAttribute(controlAttribute) : undefined;
      const viewportFocused = active?.classList.contains('solution-route-viewport');
      const codeIndex = active?.tagName === 'PRE' ? [...root.querySelectorAll('pre')].indexOf(active as HTMLPreElement) : -1;
      const openDetails = [...root.querySelectorAll('details')].map(details => details.open);
      const input = searchFocused ? active as HTMLInputElement : undefined;
      const selection = input ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : undefined;
      const detailTop = detailScroller()?.scrollTop ?? 0;
      draw();
      root.querySelectorAll('details').forEach((details, index) => { details.open = openDetails[index] ?? false; });
      if (focus) [...root.querySelectorAll<HTMLButtonElement>('[data-solution-node]')].find(button => button.dataset.solutionNode === focus)?.focus({ preventScroll: true });
      else if (controlAttribute) [...root.querySelectorAll<HTMLElement>(`[${controlAttribute}]`)].find(button => button.getAttribute(controlAttribute) === controlValue)?.focus({ preventScroll: true });
      else if (viewportFocused) root.querySelector<HTMLElement>('.solution-route-viewport')?.focus({ preventScroll: true });
      else if (codeIndex >= 0) root.querySelectorAll<HTMLPreElement>('pre')[codeIndex]?.focus({ preventScroll: true });
      else if (active?.tagName === 'SUMMARY') root.querySelector<HTMLElement>('.solution-route-source > summary')?.focus({ preventScroll: true });
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
}
