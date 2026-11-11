import { describe, expect, it } from 'vitest';
import { compareResearchReleases } from '../apps/web/researchReleaseComparison';
import type { ResearchAssetRelease, ResearchCheckedMathExample } from '../apps/web/researchAssetTypes';

function release(): ResearchAssetRelease {
  return { schema: 'theorem-os.research-asset-release.v1', assetId: 'fixture-asset', type: 'mathematics', authorId: 'fixture-author',
    version: 'v1', digest: 'a'.repeat(64), name: 'Addition', description: 'A checked lemma', area: 'algebra', license: 'MIT', visibility: 'public',
    content: { source: { kind: 'run', runId: 'fixture-run' } }, createdAt: '2026-11-10T00:00:00Z',
    dependencies: [{ assetId: 'base', version: 'v1', digest: 'b'.repeat(64) }], mathematics: {
      environment: 'standard', environmentDigest: 'e'.repeat(64), packDigest: 'c'.repeat(64), receiptRefs: ['fixture-check'],
      source: { kind: 'run', runId: 'fixture-run' },
      declarations: [{ name: 'add_zero', type: '(n : Nat) : n + 0 = n', file: 'Submission/Library/One.lean' }],
      pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'Submission/Library/One.lean', source: 'theorem add_zero := by simp',
        origin: { kind: 'run', runId: 'fixture-run', commit: '1'.repeat(40), file: 'Main.lean' } }],
        requires: [{ file: 'Foundation.lean', digest: 'd'.repeat(64) }] } } };
}
function example(id = 'addition'): ResearchCheckedMathExample {
  return { id, title: 'Use the addition identity', declaration: 'add_zero', type: '∀ n : Nat, n + 0 = n',
    proof: 'by\n  intro n\n  exact add_zero n', argumentNotes: 'Pass the natural number n.', source: 'fixed example source', sourceDigest: 'f'.repeat(64),
    check: { receiptId: '1'.repeat(64), receipt: { schema: 'theorem-os.research-library-example-check.v1', exampleId: id, declaration: 'add_zero',
      sourceDigest: 'f'.repeat(64), libraryPackDigest: 'c'.repeat(64), environment: 'standard', environmentDigest: 'e'.repeat(64),
      checkedDeclaration: 'FixtureExample', passed: true, exitCode: 0, timedOut: false, diagnostics: [], checkedAt: '2026-11-10T00:00:00Z' } } };
}
function withUsage() {
  const value = release(); value.mathematics!.usage = { conditions: 'For $n \\in \\mathbb{N}$.', result: 'Conclude $n + 0 = n$.', examples: [example()] };
  return value;
}
describe('fixed Library release comparisons', () => {
  it('distinguishes declarations, fixed dependencies, environment, sources and authored metadata', () => {
    const before = release(), after = structuredClone(before); after.version = 'v2'; after.releaseNotes = 'Strengthened the result';
    after.mathematics!.declarations[0].type = '(n : Nat) : 0 + n = n';
    after.mathematics!.declarations.push({ name: 'new_lemma', type: 'True', file: 'Submission/Library/One.lean' });
    after.dependencies[0].version = 'v2'; after.mathematics!.pack.requires![0].digest = 'f'.repeat(64);
    after.mathematics!.environmentDigest = 'f'.repeat(64); after.mathematics!.pack.modules[0].source = 'theorem add_zero := by omega';
    after.license = 'Apache-2.0';
    const difference = compareResearchReleases(before, after);
    expect(difference.declarations).toEqual([{ name: 'add_zero', kind: 'changed', before: '(n : Nat) : n + 0 = n', after: '(n : Nat) : 0 + n = n' },
      { name: 'new_lemma', kind: 'added', after: 'True' }]);
    expect(difference.dependencies.map(item => item.name)).toEqual(['base', 'module: Foundation.lean']);
    expect(difference.environment.changed).toBe(true); expect(difference.content).toHaveLength(1);
    expect(difference.metadata.map(item => item.name)).toEqual(['license']); expect(difference.releaseNotes).toBe(after.releaseNotes);
    expect(before.mathematics!.pack.modules[0].source).toBe('theorem add_zero := by simp');
  });
  it('ignores declaration path relocation while preserving every module sharing an original filename', () => {
    const before = release(), after = structuredClone(before);
    after.mathematics!.declarations[0].file = 'Submission/Library/Renamed.lean';
    expect(compareResearchReleases(before, after).declarations).toEqual([]);
    const extra = structuredClone(before.mathematics!.pack.modules[0]); extra.file = 'Submission/Library/Two.lean'; extra.source = 'theorem second := by trivial';
    before.mathematics!.pack.modules.push(extra); after.mathematics!.pack.modules.push(structuredClone(extra));
    after.mathematics!.pack.modules[0].source = 'theorem first_changed := by trivial';
    const difference = compareResearchReleases(before, after);
    expect(difference.content).toHaveLength(1); expect(difference.content[0].before).toBe('theorem add_zero := by simp');
    expect(difference.content[0].after).toContain('first_changed');
  });
  it('rejects cross-asset comparisons and reports unchanged releases without invented changes', () => {
    const before = release(), identical = structuredClone(before); identical.version = 'v2'; identical.createdAt = '2026-11-10T02:00:00Z';
    expect(compareResearchReleases(before, identical)).toMatchObject({ declarations: [], dependencies: [], content: [], metadata: [], environment: { changed: false } });
    expect(() => compareResearchReleases(before, { ...identical, assetId: 'another-asset' })).toThrow(/same asset/u);
  });
  it('keeps every dependency when a release includes two versions of the same asset', () => {
    const before = release(); before.dependencies.push({ assetId: 'base', version: 'v2', digest: 'c'.repeat(64) });
    const after = structuredClone(before); after.dependencies[0].digest = 'd'.repeat(64);
    const difference = compareResearchReleases(before, after);
    expect(difference.dependencies).toEqual([{ name: 'base@v1', kind: 'changed',
      before: `v1\n${'b'.repeat(64)}`, after: `v1\n${'d'.repeat(64)}` }]);
  });
  it('reports changed applicability and result descriptions even when mathematical source is unchanged', () => {
    const before = withUsage(), after = structuredClone(before); after.version = 'v2';
    after.mathematics!.usage!.conditions = 'First locate the $n + 0$ subexpression.';
    after.mathematics!.usage!.result = 'This gives $n + 0 = n$, not the reversed addition order.';
    const difference = compareResearchReleases(before, after);
    expect(difference).toMatchObject({ content: [], declarations: [], dependencies: [], metadata: [], environment: { changed: false } });
    expect(difference.usage).toEqual(['conditions', 'result'].map(field => ({ name: field, field, kind: 'changed',
      before: before.mathematics!.usage![field as 'conditions' | 'result'], after: after.mathematics!.usage![field as 'conditions' | 'result'] })));
    expect(before.mathematics!.usage!.conditions).toBe('For $n \\in \\mathbb{N}$.');
  });
  it.each(['title', 'declaration', 'type', 'proof', 'argumentNotes'] as const)('compares the authored example %s by example identity', field => {
    const before = withUsage(), after = structuredClone(before); after.version = 'v2';
    after.mathematics!.usage!.examples[0][field] = `Updated ${field}`;
    const difference = compareResearchReleases(before, after);
    expect(difference.content).toEqual([]);
    expect(difference.usage).toEqual([{ name: `examples.addition.${field}`, field, exampleId: 'addition',
      exampleTitle: after.mathematics!.usage!.examples[0].title, kind: 'changed', before: example()[field], after: `Updated ${field}` }]);
  });
  it('reports added and removed examples and explicitly cleared descriptions', () => {
    const before = withUsage(), after = structuredClone(before); after.version = 'v2';
    after.mathematics!.usage!.examples = [example('new-identity')]; after.mathematics!.usage!.conditions = '';
    const difference = compareResearchReleases(before, after);
    expect(difference.usage.filter(item => item.exampleId === 'addition')).toHaveLength(5);
    expect(difference.usage.filter(item => item.exampleId === 'addition').every(item => item.kind === 'removed')).toBe(true);
    expect(difference.usage.filter(item => item.exampleId === 'new-identity')).toHaveLength(5);
    expect(difference.usage.filter(item => item.exampleId === 'new-identity').every(item => item.kind === 'added')).toBe(true);
    expect(difference.usage.find(item => item.field === 'conditions')).toEqual({ name: 'conditions', field: 'conditions', kind: 'removed', before: before.mathematics!.usage!.conditions });
    delete after.mathematics!.usage;
    expect(compareResearchReleases(before, after).usage).toHaveLength(7);
  });
  it('ignores example ordering and receipt-only updates while preserving authored usage', () => {
    const before = withUsage(); before.mathematics!.usage!.examples.push(example('second'));
    const after = structuredClone(before); after.version = 'v2'; after.mathematics!.usage!.examples.reverse();
    for (const item of after.mathematics!.usage!.examples) {
      item.check.receiptId = '2'.repeat(64); item.check.receipt.checkedAt = '2026-11-11T00:00:00Z'; item.sourceDigest = '3'.repeat(64);
    }
    expect(compareResearchReleases(before, after).usage).toEqual([]);
    const blank = release(), empty = structuredClone(blank); empty.mathematics!.usage = { conditions: '', result: '', examples: [] };
    expect(compareResearchReleases(blank, empty).usage).toEqual([]);
  });
});
