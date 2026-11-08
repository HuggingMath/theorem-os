import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { triangleMatching } from '../docs/web/proofTriangleFigure';
import { coveringCase, coveringPlotPoint, coveringRegions, type CoverCorner } from '../docs/web/proofCoverFigure';
import { convexMassModel } from '../docs/web/proofConvexFigure';
import { separationModel } from '../docs/web/proofSeparationFigure';
import { snakyFigureModel, snakyForkModel, type SnakyCell } from '../docs/web/proofSnakyFigure';
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

describe('the mass-one section of the matching convex hull', () => {
  it('preserves the lower bound and reaches the section only at μ=0 for every slider state', () => {
    for (let i = 0; i <= 100; i++) {
      const mu = i / 100, state = convexMassModel(mu);
      expect(state.mu).toBe(mu);
      expect(state.oneWeight).toBeGreaterThanOrEqual(0);
      expect(state.threeWeight).toBeGreaterThanOrEqual(0);
      expect(state.oneWeight + state.threeWeight).toBeCloseTo(1, 14);
      expect(state.oneWeight).toBeCloseTo((100 - i) / 100, 14);
      expect(state.threeWeight).toBe(mu);
      expect(state.mass).toBeCloseTo((100 - i + 3 * i) / 100, 14);
      expect(state.excess).toBeCloseTo((100 - i + 3 * i - 100) / 100, 14);
      expect(state.mass).toBeGreaterThanOrEqual(1);
      expect(state.mass).toBeLessThanOrEqual(3);
      expect(state.excess).toBeGreaterThanOrEqual(0);
      expect(state.onSection).toBe(i === 0);
    }
  });

  it('agrees with independent finite weighted sums, including zero weights and either absent group', () => {
    // Group arbitrary finite families after summing integer numerators, independently
    // of the two-group model. All-one families cover graphs with no mass-three generator.
    for (let length = 1; length <= 17; length++) for (let seed = 0; seed < 11; seed++) for (let mode = 0; mode < 3; mode++) {
      const generators = Array.from({ length }, (_, index) => ({
        mass: mode === 0 ? 1 : mode === 1 ? 3 : (index + seed) % 3 === 0 ? 3 : 1,
        weight: (index * 7 + seed * 3) % 13,
      }));
      const total = generators.reduce((sum, item) => sum + item.weight, 0);
      if (total === 0) continue;
      const massNumerator = generators.reduce((sum, item) => sum + item.mass * item.weight, 0);
      const oneNumerator = generators.filter(item => item.mass === 1).reduce((sum, item) => sum + item.weight, 0);
      const threeNumerator = generators.filter(item => item.mass === 3).reduce((sum, item) => sum + item.weight, 0);
      const excessNumerator = generators.reduce((sum, item) => sum + (item.mass - 1) * item.weight, 0);
      expect(oneNumerator + threeNumerator).toBe(total);
      expect(excessNumerator).toBe(massNumerator - total);
      const state = convexMassModel(threeNumerator / total);
      expect(state.oneWeight).toBeCloseTo(oneNumerator / total, 14);
      expect(state.threeWeight).toBeCloseTo(threeNumerator / total, 14);
      expect(state.mass).toBeCloseTo(massNumerator / total, 14);
      expect(state.excess).toBeCloseTo(excessNumerator / total, 14);
      const allPositiveTermsHaveMassOne = generators.every(item => item.weight === 0 || item.mass === 1);
      expect(state.onSection).toBe(allPositiveTermsHaveMassOne);
      expect(state.onSection).toBe(massNumerator === total);
    }
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

describe('the two final distance contradictions for the seven-color construction', () => {
  it('bounds a shared-center path below the required unit distance', () => {
    const state = separationModel('shared');
    // The cell's triple boundary attains the covering radius in physical coordinates.
    const radiusSquared = distanceSquared(physicalPoint(1 / 3, 1 / 3), physicalPoint(0, 0));
    expect(radiusSquared).toBeCloseTo(3 / 16, 14);
    expect(state.kind).toBe('shared');
    expect(state.radius).toBeCloseTo(Math.sqrt(radiusSquared), 14);
    expect(state.radius).toBeCloseTo(3 / (4 * Math.sqrt(3)), 14);
    expect(state.segments).toHaveLength(2);
    for (const segment of state.segments) expect(segment).toBeCloseTo(Math.sqrt(radiusSquared), 14);
    expect(state.upper).toBeCloseTo(state.segments.reduce((sum, segment) => sum + segment, 0), 14);
    expect(state.upper ** 2).toBeCloseTo(3 / 4, 14);
    expect(state.lower).toBe(1);
    expect(state.upper).toBeLessThan(state.lower);
    expect(state.gap).toBeCloseTo((1 - 3 / 4) / (state.lower + state.upper), 14);
    expect(state.gap).toBeGreaterThan(0);
  });

  it('uses the attained same-color lattice bound 63/16 above the path bound 1+√3/2', () => {
    const state = separationModel('distinct');
    const norms: number[] = [];
    for (let p = -14; p <= 14; p++) for (let q = -14; q <= 14; q++) {
      if ((p === 0 && q === 0) || (p - 2 * q) % 7 !== 0) continue;
      const norm = p * p + p * q + q * q;
      expect(norm).toBeGreaterThanOrEqual(7);
      norms.push(norm);
    }
    expect(Math.min(...norms)).toBe(7);
    // (-1,3) has the same color as (0,0), and its exact norm is 7.
    expect((-1 - 2 * 3) % 7 === 0).toBe(true);
    expect((-1) ** 2 + (-1) * 3 + 3 ** 2).toBe(7);
    const attainedSquared = distanceSquared(physicalPoint(-1, 3), physicalPoint(0, 0));
    expect(attainedSquared).toBeCloseTo(63 / 16, 14);
    expect(state.kind).toBe('distinct');
    expect(state.lower ** 2).toBeCloseTo(attainedSquared, 14);
    expect(state.radius ** 2).toBeCloseTo(3 / 16, 14);
    expect(state.segments).toEqual([state.radius, 1, state.radius]);
    expect(state.upper).toBeCloseTo(state.segments.reduce((sum, segment) => sum + segment, 0), 14);
    expect(state.upper).toBeCloseTo(1 + Math.sqrt(3) / 2, 14);
    expect(state.upper ** 2).toBeCloseTo(7 / 4 + Math.sqrt(3), 14);
    // 63/16 − (1+√3/2)² = 35/16 − √3 > 0:
    // both terms are positive and 35²−3·16²=457>0, using exact integers.
    expect(35 ** 2 - 3 * 16 ** 2).toBeGreaterThan(0);
    const squaredGap = 35 / 16 - Math.sqrt(3);
    expect(state.lower ** 2 - state.upper ** 2).toBeCloseTo(squaredGap, 14);
    expect(state.gap).toBeCloseTo(squaredGap / (state.lower + state.upper), 14);
    expect(state.lower).toBeGreaterThan(state.upper);
    expect(state.gap).toBeGreaterThan(0);
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

describe('Snaky certificate entry 7 with two children', () => {
  const source = fs.readFileSync(path.join(root, 'research/openai-math/SnakyCertificate/Submission.lean'), 'utf8');
  const cells = (text: string): SnakyCell[] => [...text.matchAll(/\((-?\d+),\s*(-?\d+)\)/gu)]
    .map(match => [Number(match[1]), Number(match[2])]);
  function acceptedRow(index: number) {
    const declaration = source.match(new RegExp('^def mr_' + index + ' : RowData := by\\n[\\s\\S]*?exact ⟨\\(\\[(.*?)\\] : List Cell\\)\\.toFinset, \\(\\[(.*?)\\] : List Cell\\)\\.toFinset, (\\d+)⟩', 'mu'));
    expect(declaration, 'accepted explicit row ' + index).not.toBeNull();
    return { required: cells(declaration![1]), envelope: cells(declaration![2]), height: Number(declaration![3]) };
  }
  const translated = (points: readonly SnakyCell[], [dx, dy]: SnakyCell): SnakyCell[] => points.map(([x, y]) => [x + dx, y + dy]);

  it('uses the accepted entry_7 terms and the exact row 4 and row 6 placements', () => {
    const walkthrough = proofWalkthroughs.find(item => item.recordId === 'openai_snaky_certificate')!;
    expect(createHash('sha256').update(source).digest('hex')).toBe(walkthrough.proofSha256);
    const declaration = source.match(/^def entry_7 : Entry := ⟨7, \[(.+)\]⟩$/mu)?.[1];
    expect(declaration).toBeDefined();
    const terms = [...declaration!.matchAll(/⟨(\d+),\s*(\d+),\s*(\d+),\s*(\d+)⟩/gu)]
      .map(match => match.slice(1).map(Number));
    expect(terms).toEqual([[4, 0, 3, 4], [6, 0, 5, 4]]);
    for (const stage of ['child4', 'child6', 'combine', 'fork'] as const) {
      const model = snakyForkModel(stage);
      expect(model.stage).toBe(stage);
      for (const [index, child] of [model.child4, model.child6].entries()) {
        const [rowIndex, orientation, xDigit, yDigit] = terms[index];
        const reference = acceptedRow(rowIndex), shift: SnakyCell = [xDigit - 4, yDigit - 4];
        expect(orientation).toBe(0);
        expect(child.child).toBe(rowIndex);
        expect(child.shift).toEqual(shift);
        expect(sortedCells(child.source.required)).toEqual(sortedCells(reference.required));
        expect(sortedCells(child.source.envelope)).toEqual(sortedCells(reference.envelope));
        expect(child.source.height).toBe(reference.height);
        expect(sortedCells(child.required)).toEqual(sortedCells(translated(reference.required, shift)));
        expect(sortedCells(child.envelope)).toEqual(sortedCells(translated(reference.envelope, shift)));
        expect(child.height).toBe(reference.height);
      }
    }
  });

  it('matches the accepted A₇, H₇ and height, retaining all three envelope-only cells', () => {
    const row4 = acceptedRow(4), row6 = acceptedRow(6), row7 = acceptedRow(7);
    const a4 = new Set(sortedCells(translated(row4.required, [-1, 0]))), a6 = new Set(sortedCells(translated(row6.required, [1, 0])));
    const h4 = new Set(sortedCells(translated(row4.envelope, [-1, 0]))), h6 = new Set(sortedCells(translated(row6.envelope, [1, 0])));
    const unionA = [...new Set([...a4, ...a6])].sort(), unionH = [...new Set([...h4, ...h6])].sort();
    const commonH = [...h4].filter(cell => h6.has(cell)).sort();
    expect(unionA).toEqual(['-1,-1', '-2,-1', '-3,-1', '-4,-1', '0,-1', '0,0']);
    expect(commonH).toEqual(['-1,-1', '-2,-1', '-3,-1', '0,0']);
    expect(unionH).toEqual(sortedCells(row7.envelope));
    expect([...new Set([...unionA, ...commonH])].filter(cell => cell !== '0,0').sort()).toEqual(sortedCells(row7.required));
    expect(row7.height).toBe(3);
    for (const stage of ['child4', 'child6', 'combine', 'fork'] as const) {
      const model = snakyForkModel(stage);
      expect(sortedCells(model.unionRequired)).toEqual(unionA);
      expect(sortedCells(model.unionEnvelope)).toEqual(unionH);
      expect(sortedCells(model.commonEnvelope)).toEqual(commonH);
      expect(sortedCells(model.parent.required)).toEqual(sortedCells(row7.required));
      expect(sortedCells(model.parent.envelope)).toEqual(sortedCells(row7.envelope));
      expect(model.parent.height).toBe(row7.height);
      expect(model.addedRequired).toEqual([]);
      expect(sortedCells(model.removedRequired)).toEqual(['0,0']);
      const required = new Set(sortedCells(model.parent.required));
      const envelopeOnly = sortedCells(model.parent.envelope).filter(cell => !required.has(cell));
      expect(model.parent.required).toHaveLength(5);
      expect(model.parent.envelope).toHaveLength(8);
      expect(envelopeOnly).toEqual(['-1,0', '0,0', '1,0']);
    }
  });
});

it('attaches the six figures only to their corresponding accepted mathematical steps', () => {
  const attached = proofWalkthroughs.flatMap(walkthrough => walkthrough.steps.filter(step => step.figure)
    .map(step => [walkthrough.recordId, step.id, step.figure]));
  expect(attached).toEqual([
    ['openai_triangle_face', 'count-the-three-tips', 'triangle-matchings'],
    ['openai_triangle_face', 'take-the-slice-of-the-hull', 'convex-mass-section'],
    ['openai_plane_coloring', 'cover-with-four-corner-candidates', 'four-corner-cover'],
    ['openai_plane_coloring', 'exclude-distinct-centers-and-finish', 'color-separation'],
    ['openai_snaky_certificate', 'reconstruct-the-fork', 'snaky'],
    ['openai_snaky_certificate', 'reconstruct-two-children', 'snaky-fork'],
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
