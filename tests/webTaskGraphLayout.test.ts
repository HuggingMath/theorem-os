import { describe, expect, it } from 'vitest';
import { compactGraphMetrics, graphMetrics, independentCaption, layoutTaskGraph, separate, type GraphEdge } from '../apps/web/client/taskGraphLayout';

const and = (from: string, to: string): GraphEdge => ({ from, to, kind: 'and' });
const overlapping = (positions: Map<string, { x: number; y: number }>) => {
  const cards = [...positions.values()];
  return cards.some((a, index) => cards.slice(index + 1).some(b => Math.abs(a.x - b.x) < graphMetrics.width && Math.abs(a.y - b.y) < graphMetrics.cardHeight + graphMetrics.rowGap));
};

describe('task graph layout', () => {
  it('places dependencies in earlier columns without overlapping cards', () => {
    const ids = ['goal', 'a', 'b', 'c', 'd', 'e'];
    const layout = layoutTaskGraph(ids, [and('a', 'goal'), and('b', 'goal'), and('c', 'a'), and('d', 'a'), and('e', 'b')]);
    const x = (id: string) => layout.positions.get(id)!.x;
    expect(x('c')).toBeLessThan(x('a')); expect(x('a')).toBeLessThan(x('goal'));
    expect(overlapping(layout.positions)).toBe(false);
    expect(layout.paths).toHaveLength(5);
    for (const { x, y } of layout.positions.values()) { expect(x + graphMetrics.width).toBeLessThanOrEqual(layout.width); expect(y + graphMetrics.cardHeight).toBeLessThanOrEqual(layout.height); }
  });

  it('pulls a source next to its first consumer and routes long edges through the gaps between cards', () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'early', 'side'];
    const layout = layoutTaskGraph(ids, [and('a1', 'a2'), and('a2', 'a3'), and('a3', 'a4'), and('early', 'a4'), and('a1', 'a4'), and('side', 'a2')]);
    expect(layout.positions.get('early')!.x).toBe(layout.positions.get('a3')!.x);
    const long = layout.paths.find(path => path.edge.from === 'a1' && path.edge.to === 'a4')!;
    expect(long.d.match(/ L /g)).toHaveLength(2);
  });

  it('settles cards near their neighbours instead of a fixed row grid', () => {
    const ids = ['root', 'x', 'y', 'z', 'leaf'];
    const layout = layoutTaskGraph(ids, [and('root', 'x'), and('root', 'y'), and('root', 'z'), and('z', 'leaf')]);
    const y = (id: string) => layout.positions.get(id)!.y;
    expect(Math.abs(y('root') - y('y'))).toBeLessThan(graphMetrics.cardHeight / 2);
    expect(Math.abs(y('leaf') - y('z'))).toBeLessThan(1);
  });

  it('keeps layouts finite for cycles, self references, duplicates and unknown tasks', () => {
    const layout = layoutTaskGraph(['p', 'q', 'r'], [and('p', 'q'), and('q', 'r'), and('r', 'p'), and('p', 'p'), and('p', 'q'), and('missing', 'q')]);
    expect(layout.positions.size).toBe(3);
    expect(layout.paths).toHaveLength(3);
    for (const path of layout.paths) expect(path.d).not.toMatch(/NaN|undefined/);
    expect(overlapping(layout.positions)).toBe(false);
  });

  it('reduces crossings for interleaved dependencies', () => {
    const ids = ['s1', 's2', 's3', 't1', 't2', 't3'];
    const layout = layoutTaskGraph(ids, [and('s1', 't3'), and('s2', 't2'), and('s3', 't1')]);
    const y = (id: string) => layout.positions.get(id)!.y;
    const order = (a: string, b: string) => Math.sign(y(a) - y(b));
    expect(order('s1', 's2')).toBe(order('t3', 't2'));
    expect(order('s2', 's3')).toBe(order('t2', 't1'));
  });

  it('moves unconnected tasks into a grid below the dependency graph', () => {
    const lone = Array.from({ length: 13 }, (_, index) => `lone${index}`);
    const chain = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    const metrics = compactGraphMetrics;
    const layout = layoutTaskGraph([...lone.slice(0, 5), ...chain, ...lone.slice(5)], chain.slice(1).map((id, index) => and(chain[index]!, id)), metrics);
    const graphBottom = Math.max(...chain.map(id => layout.positions.get(id)!.y)) + metrics.cardHeight;
    expect(layout.independentTop).toBeGreaterThanOrEqual(graphBottom);
    const lonePositions = lone.map(id => layout.positions.get(id)!);
    for (const { x, y } of lonePositions) {
      expect(y).toBeGreaterThanOrEqual(layout.independentTop! + independentCaption);
      expect(x + metrics.width).toBeLessThanOrEqual(layout.width); expect(y + metrics.cardHeight).toBeLessThanOrEqual(layout.height);
    }
    expect(new Set(lonePositions.map(({ x }) => x)).size).toBeGreaterThan(1);
    expect(layout.width).toBe(layoutTaskGraph(chain, chain.slice(1).map((id, index) => and(chain[index]!, id)), metrics).width);
    expect(layoutTaskGraph(lone, [], metrics).independentTop).toBeUndefined();
    expect(layoutTaskGraph(chain, [], metrics).paths).toHaveLength(0);
  });
});

describe('separated placement', () => {
  it('returns the desired heights when they already respect the gaps', () => {
    expect(separate([0, 50, 120], [1, 1, 1], [40, 40])).toEqual([0, 50, 120]);
  });
  it('spreads collisions around their weighted centre', () => {
    expect(separate([10, 10], [1, 1], [20])).toEqual([0, 20]);
    expect(separate([0, 0, 0], [1, 1, 1], [10, 10])).toEqual([-10, 0, 10]);
  });
});
