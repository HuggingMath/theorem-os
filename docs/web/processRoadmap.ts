import type { ArchiveIndexRecord, ArchiveProcess } from './types';
import type { Locale } from './site';
import { layoutTaskGraph } from '../../apps/web/client/taskGraphLayout';
import { archiveRoadmapTaskLabel } from './roadmapLabels';

type Run = ArchiveProcess['runs'][number];
export interface ArchiveRoadmapNode {
  id: string;
  kind: 'problem' | 'plan' | 'task' | 'check' | 'review' | 'acceptance' | 'end';
  title: string;
  status: string;
  taskId?: string;
  stepId?: string;
  checkIds: string[];
  deliveryIds: string[];
}
export interface ArchiveRoadmap {
  nodes: ArchiveRoadmapNode[];
  edges: { from: string; to: string; kind: 'dependency' | 'flow' }[];
}
const text = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const glyph = (name: string) => `<i data-lucide="${name}"></i>`;
export const roadmapTone = (status: string) => ['integrated', 'completed', 'verified', 'accepted', 'passed', 'kernel_verified', 'evaluated_passed'].includes(status)
  ? 'passed' : ['blocked', 'failed', 'changes_requested', 'limit_reached', 'evaluated_failed', 'runtime_error'].includes(status) ? 'attention' : 'neutral';

/** Solid arrows are exactly the recorded task dependencies. Dotted arrows describe research stages. */
export function buildArchiveRoadmap(record: ArchiveIndexRecord, run: Run, locale: Locale): ArchiveRoadmap {
  const known = new Set(run.tasks.map(task => task.id));
  // Records outlive task-plan revisions; keep their original identities accessible from the problem.
  const nodes: ArchiveRoadmapNode[] = [{ id: 'problem', kind: 'problem', title: text(locale, '原题', 'Original problem'), status: '',
    checkIds: (run.checks ?? []).filter(check => check.scope === 'task' && !known.has(check.taskId ?? '')).map(check => check.id),
    deliveryIds: (run.deliveries ?? []).filter(delivery => delivery.kind !== 'review' && !known.has(delivery.taskId ?? '')).map(delivery => delivery.id) }];
  const edges: ArchiveRoadmap['edges'] = [];
  const edits = run.events.filter(event => event.kind === 'plan-edit');
  if (edits.length) {
    nodes.push({ id: 'plan', kind: 'plan', title: text(locale, '拆分与调整', 'Plan and revisions'), status: '',
      stepId: `event:${run.events.indexOf(edits.at(-1)!)}`, checkIds: [], deliveryIds: [] });
    edges.push({ from: 'problem', to: 'plan', kind: 'flow' });
  }
  for (const task of run.tasks) {
    const checks = (run.checks ?? []).filter(check => check.scope === 'task' && check.taskId === task.id);
    const deliveries = (run.deliveries ?? []).filter(delivery => delivery.taskId === task.id);
    const latest = [...checks.map(check => ({ at: check.at, id: `check:${check.id}` })),
      ...deliveries.map(delivery => ({ at: delivery.at, id: `delivery:${delivery.id}` }))].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    nodes.push({ id: `task:${task.id}`, kind: 'task', taskId: task.id, title: archiveRoadmapTaskLabel(task, locale),
      status: task.status, stepId: latest?.id, checkIds: checks.map(check => check.id), deliveryIds: deliveries.map(delivery => delivery.id) });
    for (const dependency of task.dependencies) if (known.has(dependency)) edges.push({ from: `task:${dependency}`, to: `task:${task.id}`, kind: 'dependency' });
    if (!task.dependencies.some(dependency => known.has(dependency))) edges.push({ from: edits.length ? 'plan' : 'problem', to: `task:${task.id}`, kind: 'flow' });
  }
  const milestones: (ArchiveRoadmapNode & { at: string })[] = [];
  const checks = (run.checks ?? []).filter(check => check.scope === 'original').sort((a, b) => a.at.localeCompare(b.at));
  if (checks.length) milestones.push({ id: 'original', kind: 'check', title: text(locale, '完整原题检查', 'Check the original problem'),
    at: checks.at(-1)!.at, status: checks.at(-1)!.status, stepId: `check:${checks.at(-1)!.id}`,
    checkIds: checks.map(check => check.id), deliveryIds: [] });
  const reviews = (run.deliveries ?? []).filter(delivery => delivery.kind === 'review').sort((a, b) => a.at.localeCompare(b.at));
  if (reviews.length || run.review) milestones.push({ id: 'review', kind: 'review', title: text(locale, '审阅与修订', 'Review and revisions'),
    at: reviews.at(-1)?.at ?? run.finishedAt ?? '', status: run.review?.status ?? reviews.at(-1)?.status ?? '',
    stepId: reviews.length ? `delivery:${reviews.at(-1)!.id}` : undefined, checkIds: [], deliveryIds: reviews.map(review => review.id) });
  milestones.sort((a, b) => a.at.localeCompare(b.at));
  nodes.push(...milestones);
  const accepted = record.campaign?.runId === run.runId;
  nodes.push({ id: accepted ? 'acceptance' : 'end', kind: accepted ? 'acceptance' : 'end',
    title: accepted ? text(locale, '完整原题通过', 'Original problem accepted') : text(locale, '本轮结果', 'Run outcome'),
    status: accepted ? 'evaluated_passed' : run.resultStatus ?? run.phase, stepId: accepted ? 'acceptance' : run.finishedAt ? 'end' : undefined,
    checkIds: [], deliveryIds: [] });
  const ending = [...milestones.map(node => node.id), accepted ? 'acceptance' : 'end'];
  // Only explicitly integrated branches join the whole-problem stage. Blocked and pending branches remain visible ends.
  const integrated = new Set(run.tasks.filter(task => task.status === 'integrated').map(task => task.id));
  const integratedTips = run.tasks.filter(task => integrated.has(task.id)
    && !run.tasks.some(other => integrated.has(other.id) && other.dependencies.includes(task.id)));
  for (const task of integratedTips) edges.push({ from: `task:${task.id}`, to: ending[0]!, kind: 'flow' });
  if (!run.tasks.length) edges.push({ from: edits.length ? 'plan' : 'problem', to: ending[0]!, kind: 'flow' });
  for (let i = 1; i < ending.length; i++) edges.push({ from: ending[i - 1]!, to: ending[i]!, kind: 'flow' });
  return { nodes, edges };
}

const card = { width: 232, height: 116, columnGap: 72, rowGap: 24, lane: 14, margin: 30 };
function arrange(model: ArchiveRoadmap) {
  const tasks = model.nodes.filter(node => node.kind === 'task');
  const graph = layoutTaskGraph(tasks.map(node => node.id), model.edges.filter(edge => edge.kind === 'dependency').map(edge => ({ ...edge, kind: 'and' })),
    { width: card.width, cardHeight: card.height, columnGap: card.columnGap, rowGap: card.rowGap, lane: card.lane, margin: card.margin });
  const before = model.nodes.filter(node => node.kind === 'problem' || node.kind === 'plan');
  const after = model.nodes.filter(node => !['problem', 'plan', 'task'].includes(node.kind));
  const height = Math.max(graph.height, before.length * 160 + 50, after.length * 160 + 50);
  const positions = new Map<string, { x: number; y: number }>();
  const taskLeft = before.length ? card.width + card.columnGap : 0;
  for (const [id, position] of graph.positions) positions.set(id, { x: position.x + taskLeft, y: position.y + (height - graph.height) / 2 });
  const stack = (nodes: ArchiveRoadmapNode[], x: number) => nodes.forEach((node, index) => positions.set(node.id, {
    x, y: (height - (nodes.length * (card.height + 44) - 44)) / 2 + index * (card.height + 44),
  }));
  stack(before, card.margin);
  const right = tasks.length ? taskLeft + graph.width + card.columnGap : card.width + card.columnGap + card.margin;
  stack(after, right);
  const dependencyPaths = new Map(graph.paths.map(path => [`${path.edge.from}\0${path.edge.to}`, path.d]));
  const paths = model.edges.map(edge => {
    const a = positions.get(edge.from)!, b = positions.get(edge.to)!;
    if (edge.kind === 'dependency') return { edge, d: dependencyPaths.get(`${edge.from}\0${edge.to}`)!, shiftX: taskLeft, shiftY: (height - graph.height) / 2 };
    const vertical = a.x === b.x;
    const x1 = a.x + (vertical ? card.width / 2 : card.width), y1 = a.y + (vertical ? card.height : card.height / 2);
    const x2 = b.x + (vertical ? card.width / 2 : 0), y2 = b.y + (vertical ? 0 : card.height / 2);
    return { edge, d: vertical ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} C${x1 + 40} ${y1},${x2 - 40} ${y2},${x2} ${y2}`, shiftX: 0, shiftY: 0 };
  });
  return { positions, paths, width: right + card.width + card.margin, height };
}
export function renderArchiveRoadmap(model: ArchiveRoadmap, run: Run, selected: string, locale: Locale, inspectorId: string | null = 'process-map-inspector'): string {
  const layout = arrange(model);
  const related = new Set<string>();
  if (selected && selected !== 'problem') {
    related.add(selected);
    const visit = (id: string, direction: 'from' | 'to') => {
      for (const edge of model.edges) if (edge[direction] === id) {
        const other = edge[direction === 'from' ? 'to' : 'from'];
        if (!related.has(other)) { related.add(other); visit(other, direction); }
      }
    };
    visit(selected, 'to'); visit(selected, 'from');
  }
  const names = { problem: text(locale, '起点', 'Starting point'), plan: text(locale, '研究计划', 'Research plan'), task: text(locale, '引理 / 任务', 'Lemma / task'),
    check: text(locale, '整题验证', 'Whole-problem check'), review: text(locale, '审阅', 'Review'), acceptance: text(locale, '本地独立验收', 'Independent acceptance'), end: text(locale, '运行终点', 'Run outcome') };
  const iconNames = { problem: 'book-open', plan: 'git-branch', task: 'file-code-2', check: 'file-check-2', review: 'message-circle', acceptance: 'shield-check', end: 'clock' };
  const status = (node: ArchiveRoadmapNode) => node.status === 'integrated' ? text(locale, '已集成', 'Integrated')
    : node.status === 'blocked' ? text(locale, '受阻', 'Blocked') : node.status === 'pending' ? text(locale, '待完成', 'Pending')
      : roadmapTone(node.status) === 'passed' ? text(locale, '已通过', 'Passed') : roadmapTone(node.status) === 'attention' ? text(locale, '未通过', 'Not passed') : text(locale, '研究中', 'In progress');
  return `<section class="process-roadmap" aria-label="${text(locale, '解题路线图', 'Proof roadmap')}">
    <div class="process-map-legend"><span><b class="map-line"></b>${text(locale, '引理依赖', 'Lemma dependency')}</span><span><b class="map-line flow"></b>${text(locale, '研究流程', 'Research flow')}</span><span><b class="map-dot passed"></b>${text(locale, '已集成 / 通过', 'Integrated / passed')}</span><span><b class="map-dot attention"></b>${text(locale, '受阻 / 未通过', 'Blocked / failed')}</span></div>
    <div class="process-map-shell"><div class="process-map-viewport" tabindex="0" role="region" aria-label="${text(locale, '可缩放、拖动的解题路线图', 'Zoomable, pannable proof roadmap')}" data-map-key="${html(run.runId)}" data-map-width="${layout.width}" data-map-height="${layout.height}" data-map-selected="${html(selected)}">
      <div class="process-map-space"><div class="process-map-canvas">
        <svg class="process-map-edges" width="${layout.width}" height="${layout.height}" aria-hidden="true"><defs><marker id="map-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 1 L7 4 L1 7" fill="none" stroke="currentColor"/></marker></defs>
          ${layout.paths.map(({ edge, d, shiftX, shiftY }) => `<path data-map-edge data-from="${html(edge.from)}" data-to="${html(edge.to)}" data-kind="${edge.kind}" class="${related.size && !(related.has(edge.from) && related.has(edge.to)) ? 'is-muted' : ''}" d="${d}" transform="translate(${shiftX} ${shiftY})" marker-end="url(#map-arrow)"/>`).join('')}</svg>
        ${model.nodes.map(node => {
          const point = layout.positions.get(node.id)!;
          const failed = node.checkIds.filter(id => run.checks?.some(check => check.id === id && check.status === 'failed')).length;
          const returned = node.deliveryIds.filter(id => run.deliveries?.some(delivery => delivery.id === id && delivery.status === 'changes_requested')).length;
          const detail = node.kind === 'task' ? `${node.checkIds.length} ${text(locale, '检查', 'checks')} · ${node.deliveryIds.length} ${text(locale, '交付', 'deliveries')}`
            : node.kind === 'problem' ? text(locale, '固定原题与目标声明', 'Fixed statement and targets')
              : node.kind === 'plan' ? text(locale, `${run.tasks.length} 项任务 · ${run.events.filter(event => event.kind === 'plan-edit').length} 次调整`, `${run.tasks.length} tasks · ${run.events.filter(event => event.kind === 'plan-edit').length} revisions`)
                : node.kind === 'check' ? text(locale, `${node.checkIds.length} 次原题检查`, `${node.checkIds.length} original checks`)
                  : node.kind === 'review' ? text(locale, `${node.deliveryIds.length} 条审阅记录`, `${node.deliveryIds.length} saved reviews`)
                    : node.kind === 'acceptance' ? text(locale, '完整证明与验收回执', 'Final proof and acceptance receipt') : text(locale, '查看本轮结果', 'Inspect this run’s outcome');
          return `<button type="button" class="process-map-node ${related.size && !related.has(node.id) ? 'is-muted' : ''}" data-process-node="${html(node.id)}" data-node-kind="${node.kind}" data-tone="${roadmapTone(node.status)}" data-map-x="${point.x}" data-map-y="${point.y}" title="${html(node.title)}" aria-pressed="${node.id === selected}"${inspectorId ? ` aria-controls="${html(inspectorId)}"` : ''}><span class="process-map-node-kind">${glyph(iconNames[node.kind])}${names[node.kind]}${node.status ? `<em>${status(node)}</em>` : ''}</span><strong>${html(node.title)}</strong><span class="process-map-node-note">${failed || returned ? `<b>${text(locale, failed ? `${failed} 次检查未通过` : `${returned} 次退回修改`, failed ? `${failed} failed checks` : `${returned} changes requested`)}</b>` : html(detail)}</span></button>`;
        }).join('')}
      </div></div>
    </div><div class="process-map-controls" role="group" aria-label="${text(locale, '路线图缩放', 'Roadmap zoom')}"><button data-map-zoom="out" aria-label="${text(locale, '缩小路线图', 'Zoom out')}">−</button><output class="process-map-scale">100%</output><button data-map-zoom="in" aria-label="${text(locale, '放大路线图', 'Zoom in')}">+</button><span></span><button data-map-zoom="fit">${text(locale, '全图', 'Fit')}</button><button data-map-zoom="actual">100%</button></div></div>
  </section>`;
}

type View = { element: HTMLElement; key: string; selected: string; scale: number; left: number; top: number; dispose: () => void };
let current: View | undefined;
/** Native scrolling also supports touch. Pointer dragging and explicit zoom are confined to this canvas. */
export function mountArchiveRoadmap(): void {
  const viewport = document.querySelector<HTMLElement>('.process-map-viewport');
  if (current?.element === viewport) return;
  const previous = current;
  previous?.dispose(); current = undefined;
  if (!viewport) return;
  const space = viewport.querySelector<HTMLElement>('.process-map-space')!;
  const canvas = viewport.querySelector<HTMLElement>('.process-map-canvas')!;
  const shell = viewport.closest<HTMLElement>('.process-map-shell')!;
  const width = Number(viewport.dataset.mapWidth), height = Number(viewport.dataset.mapHeight), key = viewport.dataset.mapKey!;
  // The workbench's script policy disallows inline style attributes. Position through the CSSOM after mounting.
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  for (const node of canvas.querySelectorAll<HTMLElement>('[data-process-node]')) {
    node.style.left = `${node.dataset.mapX}px`; node.style.top = `${node.dataset.mapY}px`;
  }
  const same = previous?.key === key;
  const initial = Math.max(innerWidth < 701 ? .8 : .65, Math.min(1, (viewport.clientWidth - 24) / width));
  const selected = viewport.dataset.mapSelected ?? '';
  const view: View = { element: viewport, key, selected, scale: same ? previous.scale : initial, left: 0, top: 0, dispose: () => {} };
  const abort = new AbortController(), options = { signal: abort.signal };
  const resize = () => { canvas.style.transform = `scale(${view.scale})`; space.style.width = `${width * view.scale}px`; space.style.height = `${height * view.scale}px`;
    shell.querySelector('output')!.textContent = `${Math.round(view.scale * 100)}%`; viewport.dataset.mapScale = String(view.scale); };
  resize();
  if (same) { viewport.scrollLeft = previous.left; viewport.scrollTop = previous.top; }
  else viewport.scrollTop = Math.max(0, (height * view.scale - viewport.clientHeight) / 2);
  if (selected !== 'problem' && (!same || previous.selected !== selected)) {
    const node = [...canvas.querySelectorAll<HTMLElement>('[data-process-node]')].find(node => node.dataset.processNode === selected);
    if (node) { viewport.scrollLeft = (parseFloat(node.style.left) + card.width / 2) * view.scale - viewport.clientWidth / 2;
      viewport.scrollTop = (parseFloat(node.style.top) + card.height / 2) * view.scale - viewport.clientHeight / 2; }
  }
  const save = () => { view.left = viewport.scrollLeft; view.top = viewport.scrollTop; };
  save(); viewport.addEventListener('scroll', save, options);
  shell.addEventListener('click', event => {
    const control = (event.target as Element).closest<HTMLElement>('[data-map-zoom]');
    if (!control) return;
    const x = (viewport.scrollLeft + viewport.clientWidth / 2) / view.scale, y = (viewport.scrollTop + viewport.clientHeight / 2) / view.scale;
    view.scale = control.dataset.mapZoom === 'fit' ? Math.max(.15, Math.min(1, (viewport.clientWidth - 30) / width, (viewport.clientHeight - 30) / height))
      : control.dataset.mapZoom === 'actual' ? 1 : Math.max(.15, Math.min(1.8, view.scale * (control.dataset.mapZoom === 'in' ? 1.2 : 1 / 1.2)));
    resize(); viewport.scrollLeft = x * view.scale - viewport.clientWidth / 2; viewport.scrollTop = y * view.scale - viewport.clientHeight / 2;
    if (control.dataset.mapZoom === 'fit') { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
    save();
  }, options);
  let drag: { id: number; x: number; y: number; left: number; top: number } | undefined;
  viewport.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch' || event.button !== 0 || (event.target as Element).closest('button')) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId); viewport.classList.add('is-dragging');
  }, options);
  viewport.addEventListener('pointermove', event => { if (drag) { viewport.scrollLeft = drag.left - event.clientX + drag.x; viewport.scrollTop = drag.top - event.clientY + drag.y; } }, options);
  const release = () => { drag = undefined; viewport.classList.remove('is-dragging'); };
  viewport.addEventListener('pointerup', release, options); viewport.addEventListener('pointercancel', release, options);
  viewport.addEventListener('keydown', event => {
    if (event.target !== viewport) return;
    const movement: Record<string, [number, number]> = { ArrowLeft: [-100, 0], ArrowRight: [100, 0], ArrowUp: [0, -100], ArrowDown: [0, 100] };
    const delta = movement[event.key]; if (delta) { event.preventDefault(); viewport.scrollBy(...delta); }
  }, options);
  // A keyboard-focused node must be reachable even when the diagram is wider than the viewport.
  viewport.addEventListener('focusin', event => {
    const node = (event.target as Element).closest<HTMLElement>('[data-process-node]');
    if (node) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, options);
  view.dispose = () => abort.abort(); current = view;
}
