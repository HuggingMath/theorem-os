import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ResearchRoadmap as Roadmap, RoadmapNode, RoadmapEdge } from '../researchRoadmap';
import { localizeText, t } from '../../i18n';
import { Icon } from './Icon';

type Box = { x: number; y: number; width: number; height: number; rowTop?: number; rowBottom?: number };
const card = { width: 352, support: 256, column: 432, gutter: 80, gap: 56, noteGap: 24, margin: 40 };
const icons: Record<RoadmapNode['kind'], string> = { problem: 'book-open', plan: 'git-branch', task: 'file-code-2',
  guidance: 'user-round', proof: 'git-compare', review: 'eye', evaluation: 'shield-check', end: 'square' };
const taskKind = (node: RoadmapNode) => node.taskKind === 'goal' ? t('原始目标') : node.taskKind === 'lemma' ? t('引理')
  : node.taskKind === 'research' ? t('研究') : node.taskKind === 'sketch' ? t('证明草图') : t('数学任务');
const title = (node: RoadmapNode) => node.theoremName ?? (node.taskKind === 'research' ? t('研究') : node.title);

/** Keep real task ranks; independent siblings may share two columns, with every branch connected explicitly. */
function arrange(model: Roadmap, heights: Readonly<Record<string, number>>, compact: boolean) {
  const positions = new Map<string, Box>(), tasks = model.nodes.filter(node => node.kind === 'task');
  const hints = model.nodes.filter(node => node.kind === 'guidance');
  const ending = model.nodes.filter(node => ['proof', 'review', 'evaluation', 'end'].includes(node.kind));
  const left = model.nodes.filter(node => node.kind === 'problem' || node.kind === 'plan');
  const height = (node: RoadmapNode) => heights[node.id] ?? (node.kind === 'task' ? 250 : node.kind === 'guidance' ? 200 : 136);
  const notes = new Map<string, RoadmapNode[]>();
  for (const hint of hints) {
    const target = model.edges.find(edge => edge.kind === 'guidance' && edge.from === hint.id)?.to;
    if (target) notes.set(target, [...(notes.get(target) ?? []), hint]);
    else left.push(hint);
  }
  const noteHeight = (node: RoadmapNode) => (notes.get(node.id) ?? []).reduce((sum, hint) => sum + height(hint) + card.noteGap, 0);
  const stackHeight = (nodes: RoadmapNode[]) => nodes.reduce((sum, node) => sum + noteHeight(node) + height(node), 0)
    + Math.max(0, nodes.length - 1) * card.gap;
  const place = (node: RoadmapNode, x: number, y: number, width: number) => positions.set(node.id, { x, y, width, height: height(node) });
  const placeWithNotes = (node: RoadmapNode, x: number, y: number, width: number) => {
    let noteY = y - noteHeight(node);
    for (const hint of notes.get(node.id) ?? []) { place(hint, x, noteY, width); noteY += height(hint) + card.noteGap; }
    place(node, x, y, width);
  };
  const ranks = new Map<string, number>();
  const rank = (id: string, visiting = new Set<string>()): number => {
    if (ranks.has(id)) return ranks.get(id)!;
    if (visiting.has(id)) return 0;
    const next = new Set(visiting).add(id), parents = model.edges.filter(edge => edge.kind === 'dependency' && edge.to === id);
    const value = parents.length ? Math.max(...parents.map(edge => rank(edge.from, next) + 1)) : 0;
    ranks.set(id, value); return value;
  };
  tasks.forEach(node => rank(node.id));
  const groups = [...new Set(ranks.values())].sort((a, b) => a - b).map(value => {
    const members = tasks.filter(node => ranks.get(node.id) === value), columns = members.length >= 4 ? 2 : 1;
    const rows = Array.from({ length: Math.ceil(members.length / columns) }, (_, index) => {
      const row = members.slice(index * columns, (index + 1) * columns);
      return { notes: Math.max(...row.map(noteHeight)), body: Math.max(...row.map(height)) };
    });
    return { members, columns, rows, height: rows.reduce((sum, row) => sum + row.notes + row.body, 0)
      + Math.max(0, rows.length - 1) * card.gap };
  });
  const taskColumns = Math.max(1, groups.reduce((sum, group) => sum + group.columns, 0));
  const taskX = card.margin + card.support + card.gutter, endingX = taskX + taskColumns * card.column, top = 104;
  const mainHeight = Math.max(240, stackHeight(left), stackHeight(ending), ...groups.map(group => group.height));
  const stack = (nodes: RoadmapNode[], x: number) => {
    let y = compact ? top : top + (mainHeight - stackHeight(nodes)) / 2;
    for (const node of nodes) {
      y += noteHeight(node); placeWithNotes(node, x, y, card.support); y += height(node) + card.gap;
    }
  };
  stack(left, card.margin); stack(ending, endingX);
  let column = 0;
  for (const group of groups) {
    let y = compact ? top : top + (mainHeight - group.height) / 2;
    group.rows.forEach((size, row) => {
      group.members.slice(row * group.columns, (row + 1) * group.columns).forEach((node, index) => {
        placeWithNotes(node, taskX + card.column * (column + index), y + size.notes, card.width);
        const box = positions.get(node.id)!;
        box.rowTop = y; box.rowBottom = y + size.notes + size.body;
      });
      y += size.notes + size.body + card.gap;
    });
    column += group.columns;
  }
  return { positions, width: endingX + card.support + card.margin, height: top + mainHeight + card.margin,
    stages: [{ x: card.margin, width: card.support, label: t('原题与计划') },
      { x: taskX, width: taskColumns * card.column - card.gutter, label: t('数学任务') },
      { x: endingX, width: card.support, label: t('证明与验收') }] };
}

function path(edge: RoadmapEdge, positions: ReadonlyMap<string, Box>) {
  const from = positions.get(edge.from), to = positions.get(edge.to);
  if (!from || !to) return '';
  if (edge.kind === 'guidance') {
    if (from.x === to.x) {
      const x = from.x + from.width / 2;
      return `M${x},${from.y + from.height} V${to.y}`;
    }
    const x1 = from.x + from.width / 2, y1 = from.y + from.height;
    const x2 = to.x + to.width, y2 = to.y + to.height / 2, rail = x2 + 20;
    return `M${x1},${y1} V${y1 + 12} H${rail} V${y2} H${x2}`;
  }
  if ((edge.kind === 'integration' || edge.kind === 'assignment') && to.x - from.x > from.width + card.gutter + 1) {
    const x2 = to.x, y2 = to.y + to.height / 2;
    const boxes = [...positions.values()];
    const clear = (y: number, left: number, right: number) => boxes.every(box =>
      box.x >= right || box.x + box.width <= left || y < box.y - 8 || y > box.y + box.height + 8);
    if (edge.kind === 'integration') {
      const x1 = from.x + from.width / 2, y1 = from.y + from.height, railY = (from.rowBottom ?? y1) + 14;
      if (clear(railY, x1, x2 - 20)) return `M${x1},${y1} V${railY} H${x2 - 20} V${y2} H${x2}`;
      const side = from.x + from.width, bottom = Math.max(...boxes.map(box => box.y + box.height)) + 14;
      return `M${side},${from.y + from.height / 2} H${side + 20} V${bottom} H${x2 - 20} V${y2} H${x2}`;
    }
    const x1 = from.x + from.width, y1 = from.y + from.height / 2, nearby = (to.rowTop ?? to.y) - 14;
    const railY = clear(nearby, x1 + 28, x2 - 20) ? nearby : Math.min(...boxes.map(box => box.y)) - 14;
    return `M${x1},${y1} H${x1 + 28} V${railY} H${x2 - 20} V${y2} H${x2}`;
  }
  if (from.x === to.x) {
    const x = from.x + from.width / 2;
    return `M${x},${from.y + from.height} L${x},${to.y}`;
  }
  const x1 = from.x + from.width, y1 = from.y + from.height / 2;
  const x2 = to.x, y2 = to.y + to.height / 2, bend = Math.max(24, (x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
}

const status = (node: RoadmapNode) => node.status === 'passed' ? node.kind === 'evaluation' ? t('验收通过') : t('通过')
  : node.status === 'failed' ? t('未通过') : node.status === 'running' ? t('进行中') : node.status === 'conditional' ? t('有条件通过')
  : node.status === 'human' ? node.kind === 'guidance' ? t('已送达') : node.detail || t('等待中')
  : node.kind === 'task' && node.detail ? localizeText(node.detail) : node.status === 'pending' ? t('等待中') : t('已记录');

export function ResearchRoadmap(props: { model: Roadmap; names: ReadonlyMap<string, string>; selected?: string; onSelect(id: string): void }) {
  const { model, names, selected, onSelect } = props;
  const viewport = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null), expandButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number }>(), scroll = useRef({ left: 0, top: 0 });
  const [zoom, setZoom] = useState(1), [available, setAvailable] = useState(0), [expanded, setExpanded] = useState(false);
  const [heights, setHeights] = useState<Record<string, number>>({}), wasExpanded = useRef(false);
  const layout = arrange(model, heights, (available || window.innerWidth) <= 640);
  const nodeIds = model.nodes.map(node => node.id).join('\0');
  const scale = (value: number) => setZoom(Math.max(.35, Math.min(2, value)));
  const fit = () => {
    const element = viewport.current!;
    scale(Math.min((element.clientWidth - 12) / layout.width, (element.clientHeight - 12) / layout.height)); element.scrollTo(0, 0);
  };
  const expand = () => {
    const element = viewport.current!;
    scroll.current = { left: element.scrollLeft, top: element.scrollTop }; setExpanded(!expanded);
  };
  useLayoutEffect(() => {
    if (expanded) dialog.current!.showModal();
    else if (dialog.current!.open) dialog.current!.close();
    viewport.current?.scrollTo(scroll.current.left, scroll.current.top);
    if (!expanded && wasExpanded.current) expandButton.current?.focus({ preventScroll: true });
    wasExpanded.current = expanded;
  }, [expanded]);
  useLayoutEffect(() => {
    const element = viewport.current!;
    const observer = new ResizeObserver(entries => {
      const measured: Record<string, number> = {};
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (target === element) setAvailable(element.clientWidth);
        else if (target.dataset.roadmapNode) measured[target.dataset.roadmapNode] = target.offsetHeight;
      }
      if (Object.keys(measured).length) setHeights(previous =>
        Object.keys(measured).some(id => previous[id] !== measured[id]) ? { ...previous, ...measured } : previous);
    });
    observer.observe(element);
    for (const node of element.querySelectorAll('.roadmap-node')) observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, nodeIds]);
  const connected = new Set(model.edges.filter(edge => edge.from === selected || edge.to === selected).flatMap(edge => [edge.from, edge.to]));
  const tasks = model.nodes.filter(node => node.kind === 'task');
  const checks = tasks.reduce((sum, node) => sum + (node.attempts?.length ?? 0), 0);
  const keyboard = (event: KeyboardEvent, node: RoadmapNode) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const here = layout.positions.get(node.id)!;
    const candidates = model.nodes.filter(other => {
      const point = layout.positions.get(other.id)!;
      return event.key === 'ArrowLeft' ? point.x < here.x : event.key === 'ArrowRight' ? point.x > here.x
        : event.key === 'ArrowUp' ? point.y < here.y : point.y > here.y;
    }).sort((a, b) => {
      const distance = (id: string) => { const point = layout.positions.get(id)!; return Math.abs(point.x - here.x) + Math.abs(point.y - here.y); };
      return distance(a.id) - distance(b.id);
    });
    const next = event.key === 'Home' ? model.nodes[0] : event.key === 'End' ? model.nodes.at(-1) : candidates[0];
    if (!next) return;
    event.preventDefault(); viewport.current?.querySelector<HTMLElement>(`[data-roadmap-node="${CSS.escape(next.id)}"]`)?.focus();
  };
  const content = <section class="research-roadmap" aria-label={t('协作路线图')} data-expanded={expanded || undefined}>
    <div class="roadmap-toolbar">
      <p><Icon name="git-branch" /><span>{t('{0} 个任务 · {1} 次尝试', tasks.length, checks)}</span></p>
      <div class="roadmap-zoom" role="group" aria-label={t('路线图缩放')}>
        <button type="button" class="icon-button" aria-label={t('缩小')} disabled={zoom <= .35} onClick={() => scale(zoom - .1)}><Icon name="minus" /></button>
        <button type="button" class="roadmap-zoom-reset" aria-label={t('恢复 100%')} title={t('恢复 100%')} onClick={() => scale(1)}>
          <output aria-label={t('缩放比例')}>{Math.round(zoom * 100)}%</output></button>
        <button type="button" class="icon-button" aria-label={t('放大')} disabled={zoom >= 2} onClick={() => scale(zoom + .1)}><Icon name="plus" /></button>
        <button type="button" class="text-button" onClick={fit}>{t('适应画布')}</button>
        <button type="button" class="roadmap-expand" ref={expandButton} aria-expanded={expanded} onClick={expand}>
          <Icon name={expanded ? 'minimize-2' : 'maximize-2'} />{expanded ? t('收起画布') : t('展开画布')}</button>
      </div>
    </div>
    <div class="roadmap-viewport" ref={viewport} tabIndex={0} aria-label={t('协作路线图，可滚动或拖动平移')}
      onPointerDown={event => {
        if (event.button !== 0 || event.pointerType === 'touch' || (event.target as Element).closest('button')) return;
        const element = event.currentTarget;
        drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
        element.setPointerCapture(event.pointerId); element.dataset.dragging = 'true';
      }} onPointerMove={event => {
        if (!drag.current) return;
        event.currentTarget.scrollLeft = drag.current.left - event.clientX + drag.current.x;
        event.currentTarget.scrollTop = drag.current.top - event.clientY + drag.current.y;
      }} onPointerUp={event => { drag.current = undefined; delete event.currentTarget.dataset.dragging; }}
      onPointerCancel={event => { drag.current = undefined; delete event.currentTarget.dataset.dragging; }}>
      <div class="roadmap-space" style={{ width: Math.max(available - 2, layout.width * zoom), height: layout.height * zoom }}>
        <div class="roadmap-canvas" style={{ left: Math.max(0, (available - 2 - layout.width * zoom) / 2),
          width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
          {layout.stages.map((stage, index) => <div key={stage.label} class="roadmap-stage" style={{ left: stage.x, width: stage.width }}>
            <span>{String(index + 1).padStart(2, '0')}</span><strong>{stage.label}</strong>
          </div>)}
          <svg class="roadmap-connectors" width={layout.width} height={layout.height} aria-hidden="true">
            <defs><marker id="roadmap-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M1 1L7 4L1 7" fill="none" stroke="context-stroke" stroke-width="1.5" /></marker></defs>
            {model.edges.map(edge => <path key={edge.id} d={path(edge, layout.positions)} data-edge-kind={edge.kind}
              data-active={edge.active} data-highlighted={selected && (edge.from === selected || edge.to === selected) || undefined}
              marker-end="url(#roadmap-arrow)" />)}
          </svg>
          {model.nodes.map(node => {
            const point = layout.positions.get(node.id)!, attempts = node.attempts ?? [];
            const dependencies = model.edges.filter(edge => edge.kind === 'dependency' && edge.to === node.id)
              .map(edge => model.nodes.find(other => other.id === edge.from)?.title).filter(Boolean);
            const statement = node.statement && localizeText(node.statement);
            const objective = node.objective && node.objective !== node.statement ? localizeText(node.objective) : undefined;
            const guidance = node.guidanceText && localizeText(node.guidanceText);
            const summary = !node.type && !statement ? objective : undefined;
            const owner = node.kind === 'review' ? node.detail : node.workerId ? names.get(node.workerId) ?? node.workerId
              : node.kind === 'evaluation' ? t('Lean 内核') : undefined;
            const detail = node.kind === 'plan' ? node.detail
              : node.kind === 'task' && !node.type && !statement && !summary && node.detail !== status(node) ? node.detail : undefined;
            const state = <span class="roadmap-status">{node.status === 'passed' ? <Icon name="check" /> : node.status === 'failed' ? <Icon name="x" />
              : node.status === 'running' ? <span class="pulse-dot" /> : <span class="roadmap-status-dot" />}{status(node)}</span>;
            return <button key={node.id} type="button" class="roadmap-node" data-roadmap-node={node.id} data-node-kind={node.kind}
              data-task-kind={node.taskKind} data-status={node.status} data-connected={connected.has(node.id) || undefined}
              aria-pressed={selected === node.id} style={{ left: point.x, top: point.y, width: point.width }}
              title={[title(node), node.type, statement, objective, guidance, node.detail].filter(Boolean).join('\n')}
              onClick={() => { if (expanded) setExpanded(false); onSelect(node.id); }} onKeyDown={event => keyboard(event, node)}>
              <span class="roadmap-node-heading">
                <span class="roadmap-node-meta">{node.kind === 'task' && node.taskKind !== 'research'
                  ? <span class="roadmap-task-kind">{taskKind(node)}</span>
                  : <Icon name={node.taskKind === 'research' ? 'file-search' : icons[node.kind]} />}
                  {node.kind === 'task' && state}</span>
                <strong>{title(node)}</strong>
              </span>
              {(statement || node.type || summary || guidance || dependencies.length > 0 || detail) && <span class="roadmap-node-content">
                {statement && <span class="roadmap-node-statement">{statement}</span>}
                {node.type && <code class="roadmap-node-type">{node.type}</code>}
                {summary && <span class="roadmap-node-objective">{summary}</span>}
                {guidance && <span class="roadmap-guidance-text">{guidance}</span>}
                {dependencies.length > 0 && <span class="roadmap-dependencies"><Icon name="git-branch" />{t('先完成')} {dependencies.join(' · ')}</span>}
                {detail && <span class="roadmap-node-detail">{detail}</span>}
              </span>}
              <span class="roadmap-node-footer">
                <span class="roadmap-node-owner">{owner}</span>
                {attempts.length > 0 && <span class="roadmap-attempts" data-single={attempts.length === 1 || undefined} aria-label={t('{0} 次尝试', attempts.length)}>
                  {attempts.length > 4 && <span class="roadmap-attempt-more">+{attempts.length - 4}</span>}
                  {attempts.slice(-4).map((attempt, index) => <span key={attempt.stepIndex} class="roadmap-attempt" data-outcome={attempt.outcome}
                    title={t('第 {0} 次 · {1}', attempt.number, attempt.outcome === 'passed' ? t('通过') : attempt.outcome === 'failed' ? t('未通过')
                      : attempt.outcome === 'conditional' ? t('有条件通过') : t('检查中'))}>
                    {index > 0 && <span class="roadmap-attempt-link" aria-hidden="true">→</span>}
                    <span>{attempts.length === 1 ? t('{0} 次尝试', 1) : <>{attempt.number}<Icon name={attempt.outcome === 'passed' ? 'check' : attempt.outcome === 'failed' ? 'x' : 'circle-dashed'} /></>}</span>
                  </span>)}
                </span>}
                {node.kind !== 'task' && state}
              </span>
            </button>;
          })}
        </div>
      </div>
    </div>
    <div class="roadmap-legend"><span><i class="roadmap-legend-flow" />{t('任务分工与成果集成')}</span>
      <span><i class="roadmap-legend-guidance" />{t('人的指导')}</span>
      {model.edges.some(edge => edge.kind === 'dependency') && <span><i class="roadmap-legend-dependency" />{t('计划依赖')}</span>}
      <span class="roadmap-hint">{t('点击节点查看详情 · 拖动平移')}</span></div>
    {model.partial && <p class="trajectory-note">{t('部分早期记录已超出保留范围，路线图仅展示已保存的过程。')}</p>}
  </section>;
  return <div class="roadmap-host" data-expanded={expanded || undefined}>
    {!expanded && content}
    <dialog class="roadmap-dialog" ref={dialog} aria-label={t('协作路线图')} onClose={() => setExpanded(false)}>{expanded && content}</dialog>
  </div>;
}
