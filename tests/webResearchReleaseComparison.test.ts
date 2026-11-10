import { describe, expect, it } from 'vitest';
import { compareResearchReleases } from '../apps/web/researchReleaseComparison';
import type { ResearchAssetRelease } from '../apps/web/researchAssetTypes';

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
});
