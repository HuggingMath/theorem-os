import { Fragment, render } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { compactGraphMetrics, graphMetrics } from '../taskGraphLayout';

export type TaskCard = { id: string; version: string; kind: string; kindLabel: string; state: string; stateLabel: string;
  objective: string; owner: string; proof: string; proofLabel: string; selected: boolean;
  /** Provider-reported tokens of this task's turns; share is relative to the task with the most. */
  tokens?: { label: string; share: number; detail: string } };
export type TaskEdgePath = { from: string; to: string; kind: 'and' | 'or'; d: string };

const settledStates = new Set(['integrated', 'completed']);

function Card({ card, graph, compact, x, y, dimmed, onHover }: { card: TaskCard; graph: boolean; compact?: boolean; x?: number; y?: number; dimmed?: boolean; onHover?: (id: string | undefined) => void }) {
  const leave = onHover && (() => onHover(undefined));
  // A card that reaches a settled state while on screen pulses once; remounts with that state stay still.
  const node = useRef<HTMLButtonElement>(null), previous = useRef(card.state);
  useLayoutEffect(() => {
    const element = node.current!, changed = previous.current !== card.state && settledStates.has(card.state);
    previous.current = card.state;
    if (!changed) return;
    element.dataset.changed = ''; const clear = () => delete element.dataset.changed;
    element.addEventListener('animationend', clear, { once: true });
    const timer = setTimeout(clear, 1200);
    return () => clearTimeout(timer);
  }, [card.state]);
  return <button ref={node} type="button" class={`collab-task${card.selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}`} data-collab-task={card.id} data-focus-key={`${graph ? 'graph' : 'list'}-${card.id}`}
    data-task-state={card.state} data-task-kind={card.kind} data-task-proof={card.proof} aria-pressed={card.selected}
    title={compact ? `${card.id}\n${card.objective}\n${card.owner} · ${card.proofLabel}${card.tokens ? `\nToken ${card.tokens.label}` : ''}` : undefined}
    style={graph ? { left: `${x}px`, top: `${y}px` } : undefined}
    onPointerEnter={onHover && (() => onHover(card.id))} onPointerLeave={leave} onFocus={onHover && (() => onHover(card.id))} onBlur={leave}>
    <span class="collab-task-top"><span>{card.kindLabel}</span><span class="collab-task-state">{card.stateLabel}</span></span>
    <strong>{card.id}</strong><span class="collab-task-objective">{card.objective}</span><small>{card.owner} · {card.proofLabel}</small>
    {card.tokens && <>
      <span class="collab-task-tokens" title={card.tokens.detail ? `Token ${card.tokens.label}：${card.tokens.detail}` : undefined}>{card.tokens.label}</span>
      <span class="collab-task-usage" aria-hidden="true"><span style={{ width: `${Math.max(card.tokens.share * 100, card.tokens.share ? 2 : 0)}%` }} /></span>
    </>}
  </button>;
}

// Upstream prerequisites and downstream consumers of a task, following both AND and OR edges.
function lineage(id: string, edges: readonly TaskEdgePath[]) {
  const nodes = new Set([id]);
  for (const [from, to] of [['to', 'from'], ['from', 'to']] as const) {
    const queue = [id];
    while (queue.length) {
      const current = queue.pop()!;
      for (const edge of edges) if (edge[from] === current && !nodes.has(edge[to])) { nodes.add(edge[to]); queue.push(edge[to]); }
    }
  }
  return nodes;
}

function TaskGraph({ cards, edges, positions, width, height, selected, compact, independentTop }: { cards: readonly TaskCard[]; edges: readonly TaskEdgePath[];
  positions: ReadonlyMap<string, { x: number; y: number }>; width: number; height: number; selected: string; compact?: boolean; independentTop?: number }) {
  const [hovered, setHovered] = useState<string>();
  const focus = hovered && cards.some(card => card.id === hovered) ? hovered : undefined;
  const chain = useMemo(() => focus ? lineage(focus, edges) : undefined, [focus, edges]);
  const related = (edge: TaskEdgePath) => chain ? chain.has(edge.from) && chain.has(edge.to) : edge.from === selected || edge.to === selected;
  const highlighted = edges.some(related);
  return <>
    <svg class={`collab-edges${highlighted ? ' has-selection' : ''}${chain ? ' tracing' : ''}`} aria-hidden="true" width={width} height={height}>
      {edges.map(edge => <path key={`${edge.kind}:${edge.from}>${edge.to}`} class={`${edge.kind === 'or' ? 'collab-or-edge' : 'collab-and-edge'}${related(edge) ? ' related' : ''}`}
        data-from={edge.from} data-to={edge.to} d={edge.d} />)}
    </svg>
    {independentTop !== undefined && <p class="collab-graph-caption" style={{ top: `${independentTop}px`, left: `${(compact ? compactGraphMetrics : graphMetrics).margin}px` }}>独立任务 · 没有前置或后续依赖</p>}
    {cards.map(card => {
      const position = positions.get(card.id)!;
      return <Card key={card.id} card={card} graph compact={compact} x={position.x} y={position.y} dimmed={Boolean(chain && !chain.has(card.id))} onHover={setHovered} />;
    })}
  </>;
}

export function renderTaskGraph(root: HTMLElement, props: Parameters<typeof TaskGraph>[0]) { render(<TaskGraph {...props} />, root); }

export function renderTaskList(root: HTMLElement, cards: readonly (TaskCard & { dependencies: string })[]) {
  render(<>{cards.map(card => <Fragment key={card.id}>
    <Card card={card} graph={false} />
    <p class="collab-list-deps" data-collab-task-dependencies={card.id}>{card.dependencies}</p>
  </Fragment>)}</>, root);
}
