import { describe, expect, it } from 'vitest';
import { solutionRouteLayout, visibleSolutionRouteSelection } from '../apps/web/solutionRouteView';
import type { SolutionRoute, SolutionRouteNode } from '../apps/web/solutionRoute';

const node = (id: string, parentId?: string): SolutionRouteNode => ({ id, kind: 'task', title: id, status: 'recorded', ...(parentId ? { parentId } : {}) });
const route = (nodes: SolutionRouteNode[], edges: SolutionRoute['edges'] = []): SolutionRoute => ({
  schema: 'theoremos.solution-route.v1', id: 'unregistered-layout', title: 'New proof', basis: 'source', locale: 'en', nodes, edges,
});

describe('shared solution route layout', () => {
  it('keeps a folded child on the nearest visible ancestor so previous and next retain their place', () => {
    const model = route([node('problem'), node('before'), node('task'), node('declaration', 'task'), node('step', 'declaration'), node('after')]);
    const partial = model.nodes.filter(item => item.id !== 'step');
    expect(visibleSolutionRouteSelection(model, partial, 'step')).toBe('declaration');
    const collapsed = model.nodes.filter(item => !item.parentId);
    const selected = visibleSolutionRouteSelection(model, collapsed, 'step');
    expect(selected).toBe('task');
    const at = collapsed.findIndex(item => item.id === selected);
    expect(collapsed[at - 1].id).toBe('before');
    expect(collapsed[at + 1].id).toBe('after');
    expect(visibleSolutionRouteSelection(model, collapsed, 'after')).toBe('after');
    expect(visibleSolutionRouteSelection(model, [], 'step')).toBe('step');
  });

  it('keeps parallel branches aligned and nests every proof block under its declaration without overlap', () => {
    const model = route([node('problem'), node('left'), node('right'), node('finish'), node('declaration', 'left'),
      node('proof-a', 'declaration'), node('proof-b', 'declaration'), node('check', 'left')], [
      { from: 'problem', to: 'left', kind: 'dependency' }, { from: 'problem', to: 'right', kind: 'dependency' },
      { from: 'left', to: 'finish', kind: 'dependency' }, { from: 'right', to: 'finish', kind: 'dependency' },
    ]);
    const { boxes } = solutionRouteLayout(model, model.nodes);
    expect(boxes.get('left')!.x).toBe(boxes.get('right')!.x);
    expect(boxes.get('finish')!.x).toBeGreaterThan(boxes.get('left')!.x);
    expect(boxes.get('proof-a')!.x).toBeGreaterThan(boxes.get('declaration')!.x);
    const branch = ['left', 'declaration', 'proof-a', 'proof-b', 'check', 'right'].map(id => boxes.get(id)!);
    for (let index = 1; index < branch.length; index++) expect(branch[index].y).toBeGreaterThanOrEqual(branch[index - 1].y + branch[index - 1].height);
    expect(boxes.size).toBe(model.nodes.length);
  });

  it('handles thousands of declarations, cyclic lexical references and a filtered child without recursion', () => {
    const declarations = Array.from({ length: 4000 }, (_, index) => node(`declaration-${index}`, 'source'));
    const model = route([node('problem'), node('source'), ...declarations], [
      { from: 'problem', to: 'source', kind: 'evidence' },
      ...declarations.map((item, index) => ({ from: item.id, to: declarations[(index + 1) % declarations.length].id, kind: 'reference' as const })),
    ]);
    const full = solutionRouteLayout(model, model.nodes);
    expect(full.boxes.size).toBe(4002);
    expect(full.boxes.get('declaration-3999')!.y).toBeGreaterThan(full.boxes.get('declaration-0')!.y);
    expect(Number.isFinite(full.height)).toBe(true);
    const filtered = solutionRouteLayout(model, [declarations[100]]);
    expect(filtered.boxes.size).toBe(1);
    const cyclic = route([node('a'), node('b')], [{ from: 'a', to: 'b', kind: 'reference' }, { from: 'b', to: 'a', kind: 'reference' }]);
    expect(solutionRouteLayout(cyclic, cyclic.nodes).boxes.get('a')!.x).toBe(solutionRouteLayout(cyclic, cyclic.nodes).boxes.get('b')!.x);
  });
});
