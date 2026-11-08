import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { triangleMatching } from '../docs/web/proofTriangleFigure';
import { coveringCase, coveringPlotPoint, coveringRegions, type CoverCorner } from '../docs/web/proofCoverFigure';
import { snakyFigureModel, type SnakyCell } from '../docs/web/proofSnakyFigure';
import { proofWalkthroughs } from '../docs/web/proofWalkthroughCatalog';
import { campaignRecords } from '../docs/web/campaignCatalog';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
type Point = readonly [number, number];
const tolerance = 1e-12;
const physicalPoint = (p: number, q: number): Point => [3 * p / 4 + 3 * q / 8, 3 * Math.sqrt(3) * q / 8];
const distanceSquared = (a: Point, b: Point) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const corners: Record<CoverCorner, Point> = { '00': [0, 0], '10': [1, 0], '01': [0, 1], '11': [1, 1] };
const sortedCells = (cells: readonly SnakyCell[]) => cells.map(cell => cell.join(',')).sort();

function polygonArea(points: readonly Point[]): number {
  return Math.abs(points.reduce((sum, point, i) => {
    const next = points[(i + 1) % points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
}

function inConvexPolygon(point: Point, polygon: readonly Point[]): boolean {
  const cross = polygon.map((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    return (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  });
  return cross.every(value => value >= -tolerance) || cross.every(value => value <= tolerance);
}

describe('interactive local triangle matchings', () => {
  it('shows exactly the four ways to cover all three tips once, with k+2t=3', () => {
    // Enumerate subsets of the six actual local edges, independently of the display model.
    const localEdges = [[0], [1], [2], [1, 2], [0, 2], [0, 1]];
    const valid: string[] = [];
    for (let mask = 0; mask < 64; mask++) {
      const chosen = localEdges.filter((_, edge) => mask & (1 << edge));
      const degrees = [0, 1, 2].map(tip => chosen.filter(edge => edge.includes(tip)).length);
      if (degrees.every(degree => degree === 1)) valid.push(String(mask));
    }
    const displayed = ([0, 1, 2, 'all'] as const).map(choice => {
      const matching = triangleMatching(choice);
      const selected = [...matching.oldEdges, ...matching.newEdges.map(edge => edge + 3)];
      const degrees = [0, 1, 2].map(tip => selected.filter(edge => localEdges[edge].includes(tip)).length);
      expect(degrees).toEqual([1, 1, 1]);
      expect(matching.coverage).toEqual(degrees);
      expect(matching.k).toBe(matching.oldEdges.length);
      expect(matching.t).toBe(matching.newEdges.length);
      expect(matching.k + 2 * matching.t).toBe(3);
      expect([1, 3]).toContain(matching.k);
      return String(selected.reduce((mask, edge) => mask | (1 << edge), 0));
    });
    expect(displayed.sort()).toEqual(valid.sort());
    expect(new Set(displayed).size).toBe(4);
  });
});

describe('four-corner covering in the triangular lattice', () => {
  it('selects all four cases, including the exact cell corners and triple boundaries', () => {
    for (const [corner, [p, q]] of Object.entries(corners) as [CoverCorner, Point][]) {
      expect(coveringCase(p, q).corner).toBe(corner);
      expect(coveringCase(p, q).distance).toBe(0);
    }
    expect(coveringCase(0.2, 0.1).corner).toBe('00');
    expect(coveringCase(0.8, 0.9).corner).toBe('11');
    expect(coveringCase(0.8, 0.2).corner).toBe('10');
    expect(coveringCase(0.2, 0.8).corner).toBe('01');
    expect(coveringCase(1 / 3, 1 / 3).corner).toBe('00');
    expect(coveringCase(2 / 3, 2 / 3).corner).toBe('11');
    for (const [p, q] of [[1 / 3, 1 / 3], [2 / 3, 2 / 3]] as Point[]) {
      const state = coveringCase(p, q);
      expect(state.quadratic).toBeCloseTo(1 / 3, 14);
      expect(state.distance).toBeCloseTo(Math.sqrt(3) / 4, 14);
    }
  });

  it('switches across the two lower boundaries, their reflection, and the middle diagonal', () => {
    const epsilon = 1e-7;
    expect(coveringCase(0.4 - epsilon, 0.2).corner).toBe('00');
    expect(coveringCase(0.4 + epsilon, 0.2).corner).toBe('10');
    expect(coveringCase(0.2, 0.4 - epsilon).corner).toBe('00');
    expect(coveringCase(0.2, 0.4 + epsilon).corner).toBe('01');
    expect(coveringCase(0.6 + epsilon, 0.8).corner).toBe('11');
    expect(coveringCase(0.6 - epsilon, 0.8).corner).toBe('01');
    expect(coveringCase(0.8, 0.6 + epsilon).corner).toBe('11');
    expect(coveringCase(0.8, 0.6 - epsilon).corner).toBe('10');
    expect(coveringCase(0.5 + epsilon, 0.5).corner).toBe('10');
    expect(coveringCase(0.5 - epsilon, 0.5).corner).toBe('01');
    const diagonal = coveringCase(0.5, 0.5);
    expect(diagonal.quadratic).toBeCloseTo(1 / 4, 14);
    expect(distanceSquared(physicalPoint(0.5, 0.5), physicalPoint(1, 0)))
      .toBeCloseTo(distanceSquared(physicalPoint(0.5, 0.5), physicalPoint(0, 1)), 14);
  });

  it('respects coordinate exchange and central reflection away from equal-distance ties', () => {
    const swapped: Record<CoverCorner, CoverCorner> = { '00': '00', '10': '01', '01': '10', '11': '11' };
    const reflected: Record<CoverCorner, CoverCorner> = { '00': '11', '10': '01', '01': '10', '11': '00' };
    for (const [p, q] of [[0.12, 0.18], [0.82, 0.88], [0.73, 0.23], [0.23, 0.73], [0.49, 0.44]] as Point[]) {
      const state = coveringCase(p, q), swap = coveringCase(q, p), reflection = coveringCase(1 - p, 1 - q);
      expect(swap.corner).toBe(swapped[state.corner]);
      expect(reflection.corner).toBe(reflected[state.corner]);
      expect(swap.quadratic).toBeCloseTo(state.quadratic, 14);
      expect(reflection.quadratic).toBeCloseTo(state.quadratic, 14);
      expect([swap.u, swap.v]).toEqual([state.v, state.u]);
      expect(reflection.u).toBeCloseTo(-state.u, 14);
      expect(reflection.v).toBeCloseTo(-state.v, 14);
    }
  });

  it('covers the complete slider grid, agrees with actual Euclidean distances and chooses a nearest corner', () => {
    const seen = new Set<CoverCorner>();
    for (let i = 0; i <= 100; i++) for (let j = 0; j <= 100; j++) {
      const p = i / 100, q = j / 100, state = coveringCase(p, q);
      const actual = distanceSquared(physicalPoint(p, q), physicalPoint(state.a, state.b));
      const nearest = Math.min(...Object.values(corners).map(([a, b]) =>
        distanceSquared(physicalPoint(p, q), physicalPoint(a, b))));
      expect(state.quadratic, `Q at (${p},${q})`).toBeLessThanOrEqual(1 / 3 + tolerance);
      expect(actual).toBeCloseTo(9 * state.quadratic / 16, 14);
      expect(state.distanceSquared).toBeCloseTo(actual, 14);
      expect(state.distance ** 2).toBeCloseTo(actual, 14);
      expect(state.distance).toBeLessThanOrEqual(state.radius + tolerance);
      expect(state.radius ** 2).toBeCloseTo(3 / 16, 14);
      expect(actual).toBeCloseTo(nearest, 14);
      expect(inConvexPolygon([p, q], coveringRegions[state.corner])).toBe(true);
      seen.add(state.corner);
    }
    expect([...seen].sort()).toEqual(['00', '01', '10', '11']);
  });

  it('draws four polygons with valid vertex bounds and the same geometry as the proof coordinates', () => {
    expect(Object.keys(coveringRegions).sort()).toEqual(['00', '01', '10', '11']);
    expect(Object.values(coveringRegions).reduce((sum, points) => sum + polygonArea(points), 0)).toBeCloseTo(1, 14);
    for (const [corner, vertices] of Object.entries(coveringRegions) as [CoverCorner, Point[]][]) {
      const [a, b] = corners[corner];
      expect(vertices.length).toBeGreaterThanOrEqual(4);
      for (const [p, q] of vertices) {
        expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThanOrEqual(1);
        expect(q).toBeGreaterThanOrEqual(0); expect(q).toBeLessThanOrEqual(1);
        const actual = distanceSquared(physicalPoint(p, q), physicalPoint(a, b));
        expect(16 * actual / 9).toBeLessThanOrEqual(1 / 3 + tolerance);
        const plotDistance = distanceSquared(coveringPlotPoint(p, q), coveringPlotPoint(a, b));
        expect(plotDistance / (592 / 3) ** 2).toBeCloseTo(actual, 14);
      }
    }
    expect(coveringPlotPoint(0, 0)).toEqual([34, 196]);
    // An integer translation changes the actual center, but not the error or bound.
    const state = coveringCase(0.42, 0.28);
    for (const [m, n] of [[-3, 2], [5, -7], [0, 0]] as Point[]) {
      const translated = distanceSquared(physicalPoint(m + state.p, n + state.q), physicalPoint(m + state.a, n + state.b));
      expect(translated).toBeCloseTo(state.distanceSquared, 13);
    }
  });
});

describe('Snaky certificate entry 6', () => {
  it('uses the exact accepted six-cell shape and the encoded child-0 placement', () => {
    const source = fs.readFileSync(path.join(root, 'research/openai-math/SnakyCertificate/Submission.lean'), 'utf8');
    const shapeDeclaration = source.match(/^def snaky : Finset Cell := (.+)$/mu)?.[1];
    expect(shapeDeclaration).toBeDefined();
    const sourceShape = [...shapeDeclaration!.matchAll(/\((-?\d+),\s*(-?\d+)\)/gu)]
      .map(match => [Number(match[1]), Number(match[2])] as SnakyCell);
    expect(sortedCells(sourceShape)).toEqual(['0,0', '1,0', '2,0', '3,0', '3,1', '4,1']);
    const entry = source.match(/^def entry_6 : Entry := ⟨6, \[⟨(\d+), (\d+), (\d+), (\d+)⟩\]⟩$/mu);
    expect(entry?.slice(1).map(Number)).toEqual([0, 0, 0, 3]);

    const base = snakyFigureModel('base');
    expect(sortedCells(base.envelope)).toEqual(sortedCells(sourceShape));
    expect(sortedCells(base.required)).toEqual(['1,0', '2,0', '3,0', '3,1', '4,1']);
    expect(base.gap).toEqual([0, 0]);
    expect(base.height).toBe(1);

    // entry_6 uses orientation 0 and digits (0,3), hence translation (−4,−1).
    const placed = snakyFigureModel('placed');
    expect(sortedCells(placed.envelope)).toEqual(['-1,-1', '-1,0', '-2,-1', '-3,-1', '-4,-1', '0,0']);
    expect(sortedCells(placed.required)).toEqual(['-1,-1', '-1,0', '-2,-1', '-3,-1', '0,0']);
    expect(placed.gap).toEqual([-4, -1]);
    expect(placed.height).toBe(1);
  });

  it('forks the single child by changing the missing cell from (−4,−1) to the parent move, without adding a seventh cell', () => {
    const fork = snakyFigureModel('fork');
    expect(sortedCells(fork.envelope)).toEqual(['-1,-1', '-1,0', '-2,-1', '-3,-1', '-4,-1', '0,0']);
    expect(sortedCells(fork.required)).toEqual(['-1,-1', '-1,0', '-2,-1', '-3,-1', '-4,-1']);
    expect(fork.gap).toEqual([0, 0]);
    expect(fork.parentMove).toEqual([0, 0]);
    expect(fork.height).toBe(2);
    for (const stage of ['base', 'placed', 'fork'] as const) {
      const model = snakyFigureModel(stage);
      const envelope = new Set(sortedCells(model.envelope)), required = new Set(sortedCells(model.required));
      expect(envelope.size).toBe(6); expect(required.size).toBe(5);
      expect([...required].every(cell => envelope.has(cell))).toBe(true);
      expect(envelope.has(model.gap.join(','))).toBe(true);
      expect(required.has(model.gap.join(','))).toBe(false);
      expect([...envelope].filter(cell => !required.has(cell))).toEqual([model.gap.join(',')]);
    }
  });
});

it('attaches the three figures only to their corresponding accepted mathematical steps', () => {
  const attached = proofWalkthroughs.flatMap(walkthrough => walkthrough.steps.filter(step => step.figure)
    .map(step => [walkthrough.recordId, step.id, step.figure]));
  expect(attached).toEqual([
    ['openai_triangle_face', 'count-the-three-tips', 'triangle-matchings'],
    ['openai_plane_coloring', 'cover-with-four-corner-candidates', 'four-corner-cover'],
    ['openai_snaky_certificate', 'reconstruct-the-fork', 'snaky'],
  ]);
  const records = campaignRecords(root).records;
  for (const [recordId] of attached) {
    const record = records.find(item => item.id === recordId)!;
    const walkthrough = record.process!.walkthrough!;
    expect(walkthrough.runId).toBe(record.campaign!.runId);
    expect(walkthrough.proofSha256).toBe(record.campaign!.proofSha256);
    const accepted = record.process!.runs.find(run => run.runId === walkthrough.runId)!;
    expect(accepted.checks!.some(check => check.scope === 'original' && check.status === 'kernel_verified'
      && check.sourceDigest === walkthrough.proofSha256)).toBe(true);
  }
});
