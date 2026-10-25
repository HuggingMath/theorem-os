/**
 * Layered layout for the cooperative task graph.
 *
 * Columns follow dependency depth; rows are not a grid. Each column is ordered to reduce edge crossings, then every
 * card settles toward the height of the tasks it connects to while keeping a minimum gap. Edges that skip columns pass
 * through reserved lanes between cards instead of over them, and each card spreads its edges over separate ports.
 * Tasks with no edges at all are packed into a grid below the graph, so they do not stretch its first column.
 */
export type GraphEdge = { from: string; to: string; kind: 'and' | 'or' };
export type GraphLayout = {
  positions: Map<string, { x: number; y: number }>;
  paths: { edge: GraphEdge; d: string }[];
  width: number; height: number;
  /** Top of the grid of unconnected tasks, when the graph has both connected and unconnected tasks. */
  independentTop?: number;
};
export type GraphMetrics = { width: number; cardHeight: number; columnGap: number; rowGap: number; lane: number; margin: number };

export const graphMetrics: GraphMetrics = { width: 218, cardHeight: 104, columnGap: 84, rowGap: 22, lane: 14, margin: 20 };
/** Large plans drop the objective and owner lines from graph cards; the inspector and list keep them. */
export const compactGraphMetrics: GraphMetrics = { width: 184, cardHeight: 54, columnGap: 64, rowGap: 12, lane: 10, margin: 16 };
export const compactGraphTasks = 30;
/** Height reserved above the grid of unconnected tasks for its caption. */
export const independentCaption = 28;

type Slot = { id: string; layer: number; real: boolean; up: number[]; down: number[]; y: number };

export function layoutTaskGraph(ids: readonly string[], edges: readonly GraphEdge[], metrics: GraphMetrics = graphMetrics): GraphLayout {
  const known = new Set(ids), seen = new Set<string>();
  const unique = edges.filter(edge => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to
    && !seen.has(`${edge.from}\0${edge.to}`) && seen.add(`${edge.from}\0${edge.to}`));
  const linked = new Set(unique.flatMap(edge => [edge.from, edge.to]));
  const connected = ids.filter(id => linked.has(id)), independent = ids.filter(id => !linked.has(id));
  if (!independent.length) return layoutConnected(connected, unique, metrics);
  // Unconnected tasks share one grid; with no columns to align to, aim for a landscape block.
  const pitch = metrics.width + metrics.rowGap;
  if (!connected.length) {
    const columns = Math.max(1, Math.min(independent.length, Math.ceil(Math.sqrt(independent.length * 0.67))));
    const { positions, width, height } = grid(independent, columns, metrics.margin, metrics);
    return { positions, paths: [], width, height };
  }
  const graph = layoutConnected(connected, unique, metrics);
  const columns = Math.max(1, Math.min(independent.length, Math.floor((graph.width - 2 * metrics.margin + metrics.rowGap) / pitch)));
  const independentTop = graph.height + metrics.rowGap - metrics.margin;
  const block = grid(independent, columns, independentTop + independentCaption, metrics);
  for (const [id, point] of block.positions) graph.positions.set(id, point);
  return { ...graph, width: Math.max(graph.width, block.width), height: block.height, independentTop };
}

function grid(ids: readonly string[], columns: number, top: number, metrics: GraphMetrics) {
  const positions = new Map(ids.map((id, index) => [id, { x: metrics.margin + (index % columns) * (metrics.width + metrics.rowGap),
    y: top + Math.floor(index / columns) * (metrics.cardHeight + metrics.rowGap) }]));
  const rows = Math.ceil(ids.length / columns);
  return { positions, width: Math.max(330, 2 * metrics.margin + columns * metrics.width + (columns - 1) * metrics.rowGap),
    height: Math.max(160, top + rows * metrics.cardHeight + (rows - 1) * metrics.rowGap + metrics.margin) };
}

function layoutConnected(ids: readonly string[], unique: readonly GraphEdge[], metrics: GraphMetrics): GraphLayout {
  const inputs = new Map(ids.map(id => [id, [] as string[]])), outputs = new Map(ids.map(id => [id, [] as string[]]));
  for (const edge of unique) { inputs.get(edge.to)!.push(edge.from); outputs.get(edge.from)!.push(edge.to); }

  // Longest path from sources; a dependency cycle is cut where the walk re-enters a task.
  const layer = new Map<string, number>(), visiting = new Set<string>();
  const depth = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = inputs.get(id)!.reduce((max, from) => Math.max(max, depth(from) + 1), 0);
    visiting.delete(id); layer.set(id, value); return value;
  };
  ids.forEach(depth);
  // Pull a task with no inputs next to its earliest consumer so its edges do not cross the whole graph.
  for (const id of ids) {
    if (inputs.get(id)!.length || !outputs.get(id)!.length) continue;
    const next = Math.min(...outputs.get(id)!.map(to => layer.get(to)!));
    if (next - 1 > layer.get(id)!) layer.set(id, next - 1);
  }

  // Slots: real cards plus one lane per intermediate column for edges that skip columns.
  const slots: Slot[] = ids.map(id => ({ id, layer: layer.get(id)!, real: true, up: [], down: [], y: 0 }));
  const slotOf = new Map(ids.map((id, index) => [id, index]));
  const chains = new Map<GraphEdge, number[]>();
  for (const edge of unique) {
    const from = slotOf.get(edge.from)!, to = slotOf.get(edge.to)!;
    if (slots[to]!.layer <= slots[from]!.layer) continue; // cut cycle edge, drawn as a plain curve
    const chain = [from];
    for (let column = slots[from]!.layer + 1; column < slots[to]!.layer; column++) {
      chain.push(slots.length); slots.push({ id: `${edge.from}->${edge.to}@${column}`, layer: column, real: false, up: [], down: [], y: 0 });
    }
    chain.push(to);
    for (let index = 1; index < chain.length; index++) { slots[chain[index]!]!.up.push(chain[index - 1]!); slots[chain[index - 1]!]!.down.push(chain[index]!); }
    chains.set(edge, chain);
  }

  const columns: number[][] = [];
  slots.forEach((slot, index) => (columns[slot.layer] ??= []).push(index));
  for (let column = 0; column < columns.length; column++) columns[column] ??= [];
  const order = orderColumns(slots, columns);

  // Vertical placement: start stacked, then let each slot settle toward its neighbours under a minimum separation.
  const size = (slot: Slot) => slot.real ? metrics.cardHeight : metrics.lane;
  const separation = (a: Slot, b: Slot) => size(a) / 2 + size(b) / 2 + (a.real && b.real ? metrics.rowGap : metrics.rowGap / 2);
  for (const column of order) {
    let y = 0;
    column.forEach((index, position) => { if (position) y += separation(slots[column[position - 1]!]!, slots[index]!); slots[index]!.y = y; });
  }
  const passes: ('up' | 'down' | 'both')[] = ['up', 'down', 'up', 'down', 'up', 'down', 'both', 'both'];
  for (const pass of passes) {
    const sweep = pass === 'down' ? [...order].reverse() : order;
    for (const column of sweep) {
      const desired = column.map(index => {
        const slot = slots[index]!;
        const neighbours = pass === 'up' ? slot.up : pass === 'down' ? slot.down : [...slot.up, ...slot.down];
        return neighbours.length ? neighbours.reduce((sum, other) => sum + slots[other]!.y, 0) / neighbours.length : slot.y;
      });
      const weights = column.map(index => slots[index]!.real ? 2 : 1);
      const placed = separate(desired, weights, column.slice(1).map((index, position) => separation(slots[column[position]!]!, slots[index]!)));
      column.forEach((index, position) => { slots[index]!.y = placed[position]!; });
    }
  }
  const top = Math.min(...slots.map(slot => slot.y - size(slot) / 2), 0);
  for (const slot of slots) slot.y += metrics.margin - top;

  const pitch = metrics.width + metrics.columnGap;
  const left = (column: number) => metrics.margin + column * pitch;
  const positions = new Map(ids.map(id => { const slot = slots[slotOf.get(id)!]!; return [id, { x: left(slot.layer), y: Math.round(slot.y - metrics.cardHeight / 2) }]; }));

  // Ports: spread each card's outgoing and incoming edges over its middle band, ordered by the other end's height.
  const portY = new Map<string, number>();
  const spread = (slot: number, ends: { key: string; y: number }[]) => {
    ends.sort((a, b) => a.y - b.y);
    const step = Math.min(14, (metrics.cardHeight * 0.6) / Math.max(1, ends.length - 1));
    ends.forEach((end, index) => portY.set(end.key, slots[slot]!.y + (index - (ends.length - 1) / 2) * step));
  };
  for (const [index, slot] of slots.entries()) {
    if (!slot.real) continue;
    const out = [...chains].filter(([, chain]) => chain[0] === index).map(([edge, chain]) => ({ key: `out:${edge.from}\0${edge.to}`, y: slots[chain[1]!]!.y }));
    const into = [...chains].filter(([, chain]) => chain.at(-1) === index).map(([edge, chain]) => ({ key: `in:${edge.from}\0${edge.to}`, y: slots[chain.at(-2)!]!.y }));
    spread(index, out); spread(index, into);
  }

  const round = (value: number) => Math.round(value * 10) / 10;
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const bend = Math.max(24, (x2 - x1) / 2);
    return ` C ${round(x1 + bend)} ${round(y1)}, ${round(x2 - bend)} ${round(y2)}, ${round(x2)} ${round(y2)}`;
  };
  const paths = unique.map(edge => {
    const chain = chains.get(edge);
    if (!chain) {
      const a = positions.get(edge.from)!, b = positions.get(edge.to)!;
      const x = a.x + metrics.width, y = a.y + metrics.cardHeight / 2, ey = b.y + metrics.cardHeight / 2;
      return { edge, d: `M ${x} ${round(y)} C ${x + 60} ${round(y)}, ${b.x - 60} ${round(ey)}, ${b.x} ${round(ey)}` };
    }
    const key = `${edge.from}\0${edge.to}`;
    let x = left(slots[chain[0]!]!.layer) + metrics.width, y = portY.get(`out:${key}`)!;
    let d = `M ${round(x)} ${round(y)}`;
    for (const index of chain.slice(1, -1)) {
      const lane = slots[index]!, start = left(lane.layer);
      d += curve(x, y, start, lane.y) + ` L ${round(start + metrics.width)} ${round(lane.y)}`;
      x = start + metrics.width; y = lane.y;
    }
    const end = left(slots[chain.at(-1)!]!.layer);
    return { edge, d: d + curve(x, y, end, portY.get(`in:${key}`)!) };
  });

  const width = Math.max(330, ...[...positions.values()].map(point => point.x + metrics.width + metrics.margin));
  const height = Math.max(160, ...slots.map(slot => slot.y + size(slot) / 2 + metrics.margin));
  return { positions, paths, width: Math.round(width), height: Math.round(height) };
}

/** Order slots inside each column with barycentre sweeps and adjacent swaps, keeping the order with fewest crossings. */
function orderColumns(slots: Slot[], columns: number[][]) {
  const rank = new Map<number, number>();
  const index = (order: number[][]) => { rank.clear(); for (const column of order) column.forEach((slot, position) => rank.set(slot, position)); };
  const between = (order: number[][], column: number) => {
    const pairs: [number, number][] = [];
    for (const slot of order[column]!) for (const next of slots[slot]!.down) pairs.push([rank.get(slot)!, rank.get(next)!]);
    let total = 0;
    for (let a = 0; a < pairs.length; a++) for (let b = a + 1; b < pairs.length; b++)
      if ((pairs[a]![0] - pairs[b]![0]) * (pairs[a]![1] - pairs[b]![1]) < 0) total++;
    return total;
  };
  const crossings = (order: number[][]) => { index(order); let total = 0; for (let column = 0; column < order.length - 1; column++) total += between(order, column); return total; };
  const reorder = (column: number[], side: 'up' | 'down') => {
    const value = new Map(column.map((slot, position) => {
      const neighbours = slots[slot]![side];
      return [slot, neighbours.length ? neighbours.reduce((sum, other) => sum + rank.get(other)!, 0) / neighbours.length : position] as const;
    }));
    return column.map((slot, position) => ({ slot, position })).sort((a, b) => value.get(a.slot)! - value.get(b.slot)! || a.position - b.position).map(item => item.slot);
  };

  let order = columns.map(column => [...column]);
  let best = order.map(column => [...column]), fewest = crossings(order);
  for (let iteration = 0; iteration < 12 && fewest; iteration++) {
    const downward = iteration % 2 === 0;
    const sequence = downward ? order.map((_, column) => column).slice(1) : order.map((_, column) => column).reverse().slice(1);
    for (const column of sequence) { index(order); order[column] = reorder(order[column]!, downward ? 'up' : 'down'); }
    // Adjacent swaps that remove crossings with either neighbouring column.
    let improved = true;
    for (let round = 0; improved && round < 4; round++) {
      improved = false;
      for (let column = 0; column < order.length; column++) for (let position = 0; position + 1 < order[column]!.length; position++) {
        index(order);
        const local = () => (column ? between(order, column - 1) : 0) + (column + 1 < order.length ? between(order, column) : 0);
        const before = local();
        [order[column]![position], order[column]![position + 1]] = [order[column]![position + 1]!, order[column]![position]!];
        index(order);
        if (local() < before) improved = true;
        else [order[column]![position], order[column]![position + 1]] = [order[column]![position + 1]!, order[column]![position]!];
      }
    }
    const total = crossings(order);
    if (total < fewest) { fewest = total; best = order.map(column => [...column]); }
  }
  return best;
}

/**
 * Closest placement to `desired` (weighted least squares) that keeps the given order with `gaps[i]` between items i
 * and i + 1. Shifting each item by its cumulative gap turns this into isotonic regression, solved by pooling.
 */
export function separate(desired: readonly number[], weights: readonly number[], gaps: readonly number[]) {
  const offset = [0]; for (const gap of gaps) offset.push(offset.at(-1)! + gap);
  const blocks: { value: number; weight: number; count: number }[] = [];
  desired.forEach((value, index) => {
    blocks.push({ value: value - offset[index]!, weight: weights[index]!, count: 1 });
    while (blocks.length > 1 && blocks.at(-2)!.value > blocks.at(-1)!.value) {
      const last = blocks.pop()!, previous = blocks.at(-1)!;
      previous.value = (previous.value * previous.weight + last.value * last.weight) / (previous.weight + last.weight);
      previous.weight += last.weight; previous.count += last.count;
    }
  });
  const placed: number[] = [];
  for (const block of blocks) for (let item = 0; item < block.count; item++) placed.push(block.value + offset[placed.length]!);
  return placed;
}
