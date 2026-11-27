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

const card = { width: 296, height: 168, columnGap: 140, rowGap: 44, lane: 18, margin: 48 };
/**
 * A whole-map scale below this turns 17px titles into unreadable pixels. The stacked list carries the same nodes,
 * dependencies and ordinals in reading order, so it is what a reader gets instead of a thumbnail.
 */
const readableFloor = () => innerWidth < 701 ? .6 : .45;
let preferredMode: 'graph' | 'list' | undefined;
/** Until the reader chooses, a narrow screen opens the list: a 3000px-wide graph is nine screens of panning. */
export const roadmapMode = (): 'graph' | 'list' => preferredMode ?? (typeof innerWidth === 'number' && innerWidth < 701 ? 'list' : 'graph');
export const setRoadmapMode = (mode: 'graph' | 'list') => { preferredMode = mode; };

/** Split task dependencies into direct (Hasse) covering edges and transitive shortcuts so long skip-layer cables do not bloat the layout. */
function splitTransitiveEdges(nodeIds: readonly string[], edges: readonly { from: string; to: string; kind: 'and' }[]) {
  const unique: { from: string; to: string; kind: 'and' }[] = [];
  const seen = new Set<string>();
  const inputs = new Map<string, string[]>(nodeIds.map(id => [id, []]));
  const outputs = new Map<string, string[]>(nodeIds.map(id => [id, []]));
  for (const edge of edges) {
    const key = `${edge.from}\0${edge.to}`;
    if (edge.from === edge.to || seen.has(key) || !inputs.has(edge.from) || !inputs.has(edge.to)) continue;
    seen.add(key); unique.push(edge);
    inputs.get(edge.to)!.push(edge.from);
    outputs.get(edge.from)!.push(edge.to);
  }
  const depth = new Map<string, number>(), visiting = new Set<string>();
  const rank = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = inputs.get(id)!.reduce((max, from) => Math.max(max, rank(from) + 1), 0);
    visiting.delete(id); depth.set(id, value); return value;
  };
  for (const id of nodeIds) rank(id);
  const isTransitive = (from: string, to: string) => {
    const fromRank = depth.get(from) ?? 0, toRank = depth.get(to) ?? 0;
    if (toRank <= fromRank + 1) return false;
    const visited = new Set<string>();
    const stack = (outputs.get(from) ?? []).filter(next => next !== to && (depth.get(next) ?? 0) > fromRank && (depth.get(next) ?? 0) <= toRank);
    while (stack.length) {
      const current = stack.pop()!;
      if (current === to) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const curRank = depth.get(current) ?? 0;
      for (const next of outputs.get(current) ?? []) {
        const nextRank = depth.get(next) ?? 0;
        if (nextRank > curRank && nextRank <= toRank) stack.push(next);
      }
    }
    return false;
  };
  const direct: { from: string; to: string; kind: 'and' }[] = [];
  const transitive = new Set<string>();
  for (const edge of unique) {
    if (isTransitive(edge.from, edge.to)) transitive.add(`${edge.from}\0${edge.to}`);
    else direct.push(edge);
  }
  return { direct, transitive };
}

function arrange(model: ArchiveRoadmap) {
  const tasks = model.nodes.filter(node => node.kind === 'task');
  const taskIds = tasks.map(node => node.id);
  const rawDependencies = model.edges.filter(edge => edge.kind === 'dependency').map(edge => ({ ...edge, kind: 'and' as const }));
  const { direct, transitive } = splitTransitiveEdges(taskIds, rawDependencies);
  const graph = layoutTaskGraph(taskIds, direct,
    { width: card.width, cardHeight: card.height, columnGap: card.columnGap, rowGap: card.rowGap, lane: card.lane, margin: card.margin });
  const before = model.nodes.filter(node => node.kind === 'problem' || node.kind === 'plan');
  const after = model.nodes.filter(node => !['problem', 'plan', 'task'].includes(node.kind));
  const height = Math.max(graph.height, before.length * (card.height + 52) + 64, after.length * (card.height + 52) + 64);
  const positions = new Map<string, { x: number; y: number }>();
  const taskLeft = before.length ? card.width + card.columnGap : 0;
  for (const [id, position] of graph.positions) positions.set(id, { x: position.x + taskLeft, y: position.y + (height - graph.height) / 2 });
  const stack = (nodes: ArchiveRoadmapNode[], x: number) => nodes.forEach((node, index) => positions.set(node.id, {
    x, y: (height - (nodes.length * (card.height + 52) - 52)) / 2 + index * (card.height + 52),
  }));
  stack(before, card.margin);
  const right = tasks.length ? taskLeft + graph.width + card.columnGap : card.width + card.columnGap + card.margin;
  stack(after, right);
  const dependencyPaths = new Map(graph.paths.map(path => [`${path.edge.from}\0${path.edge.to}`, path.d]));
  const paths = model.edges.map(edge => {
    const a = positions.get(edge.from)!, b = positions.get(edge.to)!;
    const key = `${edge.from}\0${edge.to}`;
    if (edge.kind === 'dependency') {
      const routed = dependencyPaths.get(key);
      if (routed) return { edge, d: routed, shiftX: taskLeft, shiftY: (height - graph.height) / 2, layer: 'direct' as const };
      const x1 = a.x + card.width, y1 = a.y + card.height / 2;
      const x2 = b.x, y2 = b.y + card.height / 2;
      const span = Math.max(54, Math.abs(x2 - x1) * 0.42);
      const arch = (a.y <= b.y ? -1 : 1) * Math.min(84, Math.abs(x2 - x1) * 0.08);
      return { edge, d: `M${x1} ${y1} C${x1 + span} ${y1 + arch},${x2 - span} ${y2 + arch},${x2} ${y2}`, shiftX: 0, shiftY: 0, layer: transitive.has(key) ? 'transitive' as const : 'direct' as const };
    }
    const vertical = a.x === b.x;
    const x1 = a.x + (vertical ? card.width / 2 : card.width), y1 = a.y + (vertical ? card.height : card.height / 2);
    const x2 = b.x + (vertical ? card.width / 2 : 0), y2 = b.y + (vertical ? 0 : card.height / 2);
    return { edge, d: vertical ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} C${x1 + 56} ${y1},${x2 - 56} ${y2},${x2} ${y2}`, shiftX: 0, shiftY: 0, layer: 'direct' as const };
  });
  return { positions, paths, transitiveCount: transitive.size, width: right + card.width + card.margin, height };
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
    check: text(locale, '整题验证', 'Whole-problem check'), review: text(locale, '审阅', 'Review'), acceptance: text(locale, '最终验收', 'Final acceptance'), end: text(locale, '运行终点', 'Run outcome') };
  const iconNames = { problem: 'book-open', plan: 'git-branch', task: 'file-code-2', check: 'file-check-2', review: 'message-circle', acceptance: 'shield-check', end: 'clock' };
  const status = (node: ArchiveRoadmapNode) => node.status === 'integrated' ? text(locale, '已集成', 'Integrated')
    : node.status === 'blocked' ? text(locale, '受阻', 'Blocked') : node.status === 'pending' ? text(locale, '待完成', 'Pending')
      : roadmapTone(node.status) === 'passed' ? text(locale, '已通过', 'Passed') : roadmapTone(node.status) === 'attention' ? text(locale, '未通过', 'Not passed') : text(locale, '研究中', 'In progress');
  const mode = roadmapMode();
  const ordinal = new Map(model.nodes.map((node, index) => [node.id, String(index + 1).padStart(2, '0')]));
  const nodeById = new Map(model.nodes.map(node => [node.id, node]));
  const taskById = new Map(run.tasks.map(task => [task.id, task]));
  // A stacked list has no room for arrows, so every task carries the ordinals it depends on.
  const dependencies = new Map<string, string[]>();
  for (const edge of model.edges) if (edge.kind === 'dependency')
    dependencies.set(edge.to, [...(dependencies.get(edge.to) ?? []), ordinal.get(edge.from) ?? edge.from]);
  const edgeTone = (edge: ArchiveRoadmap['edges'][number]) => {
    const target = nodeById.get(edge.to), source = nodeById.get(edge.from);
    if (target && roadmapTone(target.status) === 'attention') return 'attention';
    if (target?.kind === 'acceptance' || (target && roadmapTone(target.status) === 'passed' && (!source || source.kind === 'problem' || source.kind === 'plan' || roadmapTone(source.status) === 'passed'))) return 'passed';
    return 'neutral';
  };
  return `<section class="process-roadmap" aria-label="${text(locale, '解题路线图', 'Proof roadmap')}" data-map-mode="${mode}" data-map-expanded="false" data-map-focus="all" data-map-edges="direct">
    <div class="process-map-legend"><span><b class="map-line"></b>${text(locale, '直接依赖主干', 'Direct lemma path')}</span><span><b class="map-line attention"></b>${text(locale, '受阻 / 绕行分支', 'Explored / blocked detour')}</span><span><b class="map-line flow"></b>${text(locale, '研究流程', 'Research flow')}</span><span><b class="map-dot passed"></b>${text(locale, '已集成 / 通过', 'Integrated / passed')}</span><span><b class="map-dot attention"></b>${text(locale, '受阻 / 未通过', 'Blocked / failed')}</span><span class="process-map-tip">${text(locale, 'Ctrl+滚轮 / 双击缩放 · 悬停显示完整因果链', 'Ctrl+scroll / double-click to zoom · hover for full dependencies')}</span></div>
    <div class="process-map-bar">
      <div class="process-map-modes" role="group" aria-label="${text(locale, '路线图排布', 'Roadmap layout')}"><button data-map-mode="graph" aria-pressed="${mode === 'graph'}">${glyph('git-branch')}${text(locale, '图示', 'Graph')}</button><button data-map-mode="list" aria-pressed="${mode === 'list'}">${glyph('list-start')}${text(locale, '列表', 'List')}</button></div>
      <div class="process-map-controls" role="group" aria-label="${text(locale, '路线图缩放', 'Roadmap zoom')}">
        <button type="button" data-map-focus aria-pressed="false" title="${text(locale, '突出已集成主干与受阻分支，柔化未完成辅助节点', 'Highlight the integrated proof spine and blocked detours')}">${glyph('sparkles')}${text(locale, '聚焦主干', 'Key path')}</button>
        ${layout.transitiveCount ? `<button type="button" data-map-all-edges aria-pressed="false" title="${text(locale, `默认隐藏 ${layout.transitiveCount} 条跨层传递边以减少连线杂乱；点击可展开全部依赖`, `${layout.transitiveCount} transitive skip-layer edges hidden by default for clarity; click to show all`)}">${text(locale, '全部边', 'All edges')}</button>` : ''}
        <span></span>
        <button type="button" data-map-zoom="out" aria-label="${text(locale, '缩小路线图', 'Zoom out')}">−</button>
        <output class="process-map-scale">100%</output>
        <button type="button" data-map-zoom="in" aria-label="${text(locale, '放大路线图', 'Zoom in')}">+</button>
        <span></span>
        <button type="button" data-map-zoom="actual">100%</button>
        <button type="button" data-map-overview title="${text(locale, '在画布内缩放到完整全览', 'Zoom out to view the whole graph')}">${text(locale, '全景', 'Overview')}</button>
        <button type="button" data-map-zoom="fit">${text(locale, '全图', 'Fit')}</button>
        <span></span>
        <button type="button" class="process-map-expand" data-map-expand aria-expanded="false">${glyph('maximize-2')}<span>${text(locale, '全屏放大', 'Expand')}</span></button>
      </div>
    </div>
    <div class="process-map-shell"><div class="process-map-viewport" tabindex="0" role="region" aria-label="${text(locale, '可缩放、拖动的解题路线图', 'Zoomable, pannable proof roadmap')}" data-map-key="${html(run.runId)}" data-map-width="${layout.width}" data-map-height="${layout.height}" data-map-selected="${html(selected)}">
      <div class="process-map-space"><div class="process-map-canvas" data-has-selection="${related.size > 0}">
        <svg class="process-map-edges" width="${layout.width}" height="${layout.height}" aria-hidden="true"><defs><marker id="map-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 1 L7 4 L1 7" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
          ${layout.paths.map(({ edge, d, shiftX, shiftY, layer }) => `<path data-map-edge data-from="${html(edge.from)}" data-to="${html(edge.to)}" data-kind="${edge.kind}" data-edge-layer="${layer}" data-edge-tone="${edgeTone(edge)}" class="${related.size && !(related.has(edge.from) && related.has(edge.to)) ? 'is-muted' : ''}" d="${d}" transform="translate(${shiftX} ${shiftY})" marker-end="url(#map-arrow)"/>`).join('')}</svg>
        ${model.nodes.map(node => {
          const point = layout.positions.get(node.id)!;
          const task = node.taskId ? taskById.get(node.taskId) : undefined;
          const codeHint = task?.theorem ? (task.theorem.split('.').filter(Boolean).at(-1) ?? task.theorem)
            : node.kind === 'acceptance' ? text(locale, '0 sorry · Lean 内核核验', '0 sorry · kernel verified') : '';
          const failed = node.checkIds.filter(id => run.checks?.some(check => check.id === id && check.status === 'failed')).length;
          const returned = node.deliveryIds.filter(id => run.deliveries?.some(delivery => delivery.id === id && delivery.status === 'changes_requested')).length;
          const detail = node.kind === 'task' ? `${node.checkIds.length} ${text(locale, '检查', 'checks')} · ${node.deliveryIds.length} ${text(locale, '交付', 'deliveries')}`
            : node.kind === 'problem' ? text(locale, '固定原题与目标声明', 'Fixed statement and targets')
              : node.kind === 'plan' ? text(locale, `${run.tasks.length} 项任务 · ${run.events.filter(event => event.kind === 'plan-edit').length} 次调整`, `${run.tasks.length} tasks · ${run.events.filter(event => event.kind === 'plan-edit').length} revisions`)
                : node.kind === 'check' ? text(locale, `${node.checkIds.length} 次原题检查`, `${node.checkIds.length} original checks`)
                  : node.kind === 'review' ? text(locale, `${node.deliveryIds.length} 条审阅记录`, `${node.deliveryIds.length} saved reviews`)
                    : node.kind === 'acceptance' ? text(locale, '完整证明与验收回执', 'Final proof and acceptance receipt') : text(locale, '查看本轮结果', 'Inspect this run’s outcome');
          const needs = dependencies.get(node.id) ?? [];
          return `<button type="button" class="process-map-node ${related.size && !related.has(node.id) ? 'is-muted' : ''}" data-process-node="${html(node.id)}" data-node-kind="${node.kind}" data-tone="${roadmapTone(node.status)}" data-map-x="${point.x}" data-map-y="${point.y}" title="${html(node.title)}" aria-pressed="${node.id === selected}"${inspectorId ? ` aria-controls="${html(inspectorId)}"` : ''}><span class="process-map-node-kind">${glyph(iconNames[node.kind])}<i class="process-map-node-ordinal">${ordinal.get(node.id)}</i>${names[node.kind]}${node.status ? `<em>${status(node)}</em>` : ''}</span><strong>${html(node.title)}</strong>${codeHint ? `<code class="process-map-node-code">${html(codeHint)}</code>` : ''}<span class="process-map-node-note">${needs.length ? `<span class="process-map-node-deps">${text(locale, '依赖 ', 'after ')}${needs.join(' · ')}</span>` : ''}${failed || returned ? `<b>${text(locale, failed ? `${failed} 次检查未通过` : `${returned} 次退回修改`, failed ? `${failed} failed checks` : `${returned} changes requested`)}</b>` : html(detail)}</span></button>`;
        }).join('')}
      </div></div>
    </div></div>
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
  // Toolbar controls live above the shell, so they are found from the section, not from the shell.
  const section = viewport.closest<HTMLElement>('.process-roadmap') ?? viewport.closest<HTMLElement>('.process-map-shell')!;
  const scaleLabel = section.querySelector<HTMLElement>('.process-map-scale')!;
  const width = Number(viewport.dataset.mapWidth), height = Number(viewport.dataset.mapHeight), key = viewport.dataset.mapKey!;
  // The workbench's script policy disallows inline style attributes. Position through the CSSOM after mounting.
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  for (const node of canvas.querySelectorAll<HTMLElement>('[data-process-node]')) {
    node.style.left = `${node.dataset.mapX}px`; node.style.top = `${node.dataset.mapY}px`;
  }
  const grid = () => (section.dataset.mapMode ?? 'graph') === 'list' ? 'list' : 'graph';
  const showMode = (mode: 'graph' | 'list') => {
    for (const button of section.querySelectorAll<HTMLElement>('[data-map-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mapMode === mode));
    section.dataset.mapMode = mode;
  };
  showMode(roadmapMode());
  const same = previous?.key === key;
  const initial = Math.max(innerWidth < 701 ? .85 : 1, Math.min(1, (viewport.clientWidth - 28) / width));
  const selected = viewport.dataset.mapSelected ?? '';
  const view: View = { element: viewport, key, selected, scale: same ? previous.scale : initial, left: 0, top: 0, dispose: () => {} };
  const abort = new AbortController(), options = { signal: abort.signal };
  const localeIsEn = document.documentElement.lang?.toLowerCase().startsWith('en');
  let expanded = false, prevOverflow = '';
  const resize = () => { canvas.style.transform = `scale(${view.scale})`; space.style.width = `${width * view.scale}px`; space.style.height = `${height * view.scale}px`;
    scaleLabel.textContent = `${Math.round(view.scale * 100)}%`; viewport.dataset.mapScale = String(view.scale); };
  const zoomAt = (nextScale: number, anchor?: { x: number; y: number }, minScale = 0.22) => {
    const clamped = Math.max(minScale, Math.min(2.5, Math.round(nextScale * 100) / 100));
    const rect = viewport.getBoundingClientRect();
    const px = anchor ? anchor.x - rect.left : viewport.clientWidth / 2;
    const py = anchor ? anchor.y - rect.top : viewport.clientHeight / 2;
    const cx = (viewport.scrollLeft + px) / view.scale;
    const cy = (viewport.scrollTop + py) / view.scale;
    view.scale = clamped;
    resize();
    viewport.scrollLeft = Math.max(0, cx * view.scale - px);
    viewport.scrollTop = Math.max(0, cy * view.scale - py);
    save();
  };
  const setExpanded = (value: boolean) => {
    if (value === expanded) return;
    expanded = value;
    section.dataset.mapExpanded = String(expanded);
    const btn = section.querySelector<HTMLButtonElement>('[data-map-expand]');
    if (btn) {
      btn.setAttribute('aria-expanded', String(expanded));
      const label = btn.querySelector('span');
      if (label) label.textContent = expanded ? (localeIsEn ? 'Close' : '退出全屏') : (localeIsEn ? 'Expand' : '全屏放大');
    }
    if (expanded) {
      section.setAttribute('role', 'dialog'); section.setAttribute('aria-modal', 'true');
      prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    } else {
      section.removeAttribute('role'); section.removeAttribute('aria-modal');
      document.body.style.overflow = prevOverflow;
    }
    resize();
  };
  resize();
  if (same) { viewport.scrollLeft = previous.left; viewport.scrollTop = previous.top; }
  else {
    const startNode = canvas.querySelector<HTMLElement>('[data-process-node="problem"]');
    if (startNode) {
      viewport.scrollLeft = 0;
      viewport.scrollTop = Math.max(0, (parseFloat(startNode.style.top) + card.height / 2) * view.scale - viewport.clientHeight / 2);
    } else viewport.scrollTop = Math.max(0, (height * view.scale - viewport.clientHeight) / 2);
  }
  if (selected !== 'problem' && (!same || previous.selected !== selected)) {
    const node = [...canvas.querySelectorAll<HTMLElement>('[data-process-node]')].find(node => node.dataset.processNode === selected);
    if (node) { viewport.scrollLeft = (parseFloat(node.style.left) + card.width / 2) * view.scale - viewport.clientWidth / 2;
      viewport.scrollTop = (parseFloat(node.style.top) + card.height / 2) * view.scale - viewport.clientHeight / 2; }
  }
  const save = () => { view.left = viewport.scrollLeft; view.top = viewport.scrollTop; };
  save(); viewport.addEventListener('scroll', save, options);
  // One delegated listener for the section: layout toggles, focus mode, fullscreen and zoom share it.
  section.addEventListener('click', event => {
    const target = event.target as Element;
    // The section itself carries data-map-mode for CSS, so only the buttons may match here.
    const modeButton = target.closest<HTMLElement>('button[data-map-mode]');
    if (modeButton) {
      const mode = modeButton.dataset.mapMode === 'list' ? 'list' : 'graph';
      if (mode === grid()) return;
      save(); setRoadmapMode(mode); showMode(mode);
      if (mode === 'graph') {
        resize(); viewport.scrollLeft = view.left; viewport.scrollTop = view.top;
      } else { setExpanded(false); viewport.scrollLeft = viewport.scrollTop = 0; }
      return;
    }
    const focusButton = target.closest<HTMLButtonElement>('button[data-map-focus]');
    if (focusButton) {
      const next = section.dataset.mapFocus === 'spine' ? 'all' : 'spine';
      section.dataset.mapFocus = next;
      focusButton.setAttribute('aria-pressed', String(next === 'spine'));
      return;
    }
    const edgesButton = target.closest<HTMLButtonElement>('button[data-map-all-edges]');
    if (edgesButton) {
      const next = section.dataset.mapEdges === 'all' ? 'direct' : 'all';
      section.dataset.mapEdges = next;
      edgesButton.setAttribute('aria-pressed', String(next === 'all'));
      return;
    }
    const expandButton = target.closest<HTMLButtonElement>('button[data-map-expand]');
    if (expandButton) {
      if (grid() === 'list') { setRoadmapMode('graph'); showMode('graph'); }
      setExpanded(!expanded);
      return;
    }
    const overviewButton = target.closest<HTMLButtonElement>('button[data-map-overview]');
    if (overviewButton && grid() !== 'list') {
      const whole = Math.min(1, (viewport.clientWidth - 28) / width, (viewport.clientHeight - 28) / height);
      view.scale = Math.max(0.22, Math.round(whole * 100) / 100);
      resize(); viewport.scrollLeft = 0; viewport.scrollTop = 0; save();
      return;
    }
    const control = target.closest<HTMLElement>('[data-map-zoom]');
    if (!control || grid() === 'list') return;
    // Below this the titles stop being words, so a whole-map fit hands over to the list instead of shrinking further.
    const floor = readableFloor();
    const whole = Math.min(1, (viewport.clientWidth - 30) / width, (viewport.clientHeight - 30) / height);
    if (control.dataset.mapZoom === 'fit' && !expanded && whole < floor) {
      save(); setRoadmapMode('list'); showMode('list'); viewport.scrollLeft = viewport.scrollTop = 0;
      return;
    }
    const next = control.dataset.mapZoom === 'fit' ? Math.max(expanded ? 0.22 : floor, whole)
      : control.dataset.mapZoom === 'actual' ? 1 : view.scale * (control.dataset.mapZoom === 'in' ? 1.2 : 1 / 1.2);
    zoomAt(next, undefined, expanded ? 0.22 : floor);
    if (control.dataset.mapZoom === 'fit') { viewport.scrollLeft = 0; viewport.scrollTop = 0; save(); }
  }, options);
  // Pinch / Ctrl+wheel zooms smoothly around the cursor; double-clicking empty canvas zooms in or resets.
  viewport.addEventListener('wheel', event => {
    if (grid() === 'list' || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.002));
    zoomAt(view.scale * factor, { x: event.clientX, y: event.clientY }, 0.22);
  }, { ...options, passive: false });
  viewport.addEventListener('dblclick', event => {
    if (grid() === 'list' || (event.target as Element).closest('button')) return;
    const next = view.scale >= 1.45 ? 1 : Math.min(2.2, view.scale * 1.35);
    zoomAt(next, { x: event.clientX, y: event.clientY }, 0.22);
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
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomAt(view.scale * 1.2, undefined, 0.22); return; }
    if (event.key === '-') { event.preventDefault(); zoomAt(view.scale / 1.2, undefined, 0.22); return; }
    if (event.key === '0') { event.preventDefault(); zoomAt(1, undefined, 0.22); return; }
    const movement: Record<string, [number, number]> = { ArrowLeft: [-100, 0], ArrowRight: [100, 0], ArrowUp: [0, -100], ArrowDown: [0, 100] };
    const delta = movement[event.key]; if (delta) { event.preventDefault(); viewport.scrollBy(...delta); }
  }, options);
  window.addEventListener('keydown', event => {
    if (expanded && event.key === 'Escape') {
      event.preventDefault(); setExpanded(false);
      section.querySelector<HTMLButtonElement>('[data-map-expand]')?.focus({ preventScroll: true });
    }
  }, options);
  // Hovering a node illuminates direct neighbors boldly and transitive ancestors softly, eliminating edge clutter.
  const edgeEls = [...canvas.querySelectorAll<SVGPathElement>('path[data-map-edge]')];
  const nodeEls = [...canvas.querySelectorAll<HTMLElement>('[data-process-node]')];
  const adjacency = edgeEls.map(el => ({ el, from: el.dataset.from ?? '', to: el.dataset.to ?? '' }));
  const clearHover = () => {
    delete canvas.dataset.mapHover;
    for (const el of nodeEls) { el.classList.remove('is-hover-hit', 'is-hover-direct'); }
    for (const item of adjacency) { item.el.classList.remove('is-hover-hit', 'is-hover-direct'); }
  };
  const applyHover = (id: string) => {
    if (grid() === 'list') return;
    const hit = new Set<string>([id]);
    const directNodes = new Set<string>([id]);
    for (const edge of adjacency) {
      if (edge.from === id) directNodes.add(edge.to);
      if (edge.to === id) directNodes.add(edge.from);
    }
    const walk = (start: string, dir: 'from' | 'to') => {
      for (const edge of adjacency) if (edge[dir] === start) {
        const next = dir === 'from' ? edge.to : edge.from;
        if (!hit.has(next)) { hit.add(next); walk(next, dir); }
      }
    };
    walk(id, 'to'); walk(id, 'from');
    canvas.dataset.mapHover = 'true';
    for (const el of nodeEls) {
      const nid = el.dataset.processNode ?? '';
      el.classList.toggle('is-hover-hit', hit.has(nid));
      el.classList.toggle('is-hover-direct', directNodes.has(nid));
    }
    for (const item of adjacency) {
      const isDirect = item.from === id || item.to === id;
      item.el.classList.toggle('is-hover-hit', hit.has(item.from) && hit.has(item.to));
      item.el.classList.toggle('is-hover-direct', isDirect);
    }
  };
  canvas.addEventListener('pointerover', event => {
    const hovered = (event.target as Element).closest<HTMLElement>('[data-process-node]');
    if (hovered?.dataset.processNode) applyHover(hovered.dataset.processNode);
  }, options);
  canvas.addEventListener('pointerleave', clearHover, options);
  // A keyboard-focused node must be reachable even when the diagram is wider than the viewport.
  viewport.addEventListener('focusin', event => {
    const node = (event.target as Element).closest<HTMLElement>('[data-process-node]');
    if (node) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, options);
  view.dispose = () => { if (expanded) document.body.style.overflow = prevOverflow; abort.abort(); }; current = view;
}
