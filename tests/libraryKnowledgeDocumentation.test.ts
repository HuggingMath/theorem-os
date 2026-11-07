import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAutoLibraryHeader } from '../src/math/autoLibrary';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import { prepareLibraryKnowledge } from '../src/solver/theoremKnowledgeLibrary';
import { readKnowledgeCatalog } from '../src/solver/theoremKnowledgeStore';
import { searchTheoremKnowledge } from '../src/solver/theoremKnowledge';
import { temporaryDirectory } from './helpers/files';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const file = 'Submission/Library/Auto/Bridge.lean';
const lean = 'namespace TheoremOS.Auto.Bridge\ntheorem bridge : True := trivial\nend TheoremOS.Auto.Bridge\n';
const documented = (summary = 'Transfers entropy contraction through finite probability kernels.', remaining = 'Prove the kernel normalization premise.') =>
  withAutoLibraryHeader(lean, { name: 'Bridge', summary, sources: [], application: {
    target: 'Original.entropy_goal', use: 'Use TheoremOS.Auto.Bridge.bridge after supplying the kernel hypotheses.', remaining: [remaining],
  } });

function fixture(source: string, moduleFile = file) {
  const root = temporaryDirectory('library-knowledge-documentation-'); roots.push(root);
  const workspace = path.join(root, 'workspace'), output = path.join(root, 'catalog.json');
  const receipt = bootstrapLeanTask(workspace, { source: 'theorem current_goal : True := by sorry\n', task: 'Prove the current goal.',
    libraryPack: { schema: LIBRARY_PACK_SCHEMA, modules: [{ file: moduleFile, source,
      origin: { kind: 'run', runId: 'fixture-library', commit: 'a'.repeat(40), file: 'Submission.lean' } }] } });
  return { root, workspace, output, receipt };
}

function catalog(input: ReturnType<typeof fixture>) {
  const prepared = prepareLibraryKnowledge(input.workspace, input.output);
  if (!prepared.enabled) throw new Error('Fixture library was not indexed');
  return { prepared, ...readKnowledgeCatalog(prepared.file, prepared.sha256) };
}

describe('frozen auto-library documentation in knowledge retrieval', () => {
  it('finds a declaration by its planned mathematical use while keeping its remaining obligations advisory', () => {
    const input = fixture(documented()), { prepared, base } = catalog(input);
    const result = searchTheoremKnowledge(base, 'entropy contraction');
    expect(result.hits.map(hit => hit.name)).toContain('TheoremOS.Auto.Bridge.bridge');
    const entry = base.entries.find(item => item.name === 'TheoremOS.Auto.Bridge.bridge')!;
    expect(entry.description).toContain('Advisory');
    expect(entry.description).toContain('triggering challenge');
    expect(entry.description).toContain('Original.entropy_goal');
    expect(entry.description).toContain('Remaining: Prove the kernel normalization premise.');
    expect(entry.premises).toEqual([]);
    expect(entry.dependencies.coverage).toBe('unavailable');
    expect(base).toMatchObject({ evidence: 'recorded-not-replayed', requiresFreshCheck: true });
    expect(entry.provenance[0]!.receiptIds).toEqual([]);
    expect(prepareLibraryKnowledge(input.workspace, input.output)).toMatchObject({ sha256: prepared.sha256 });
  });

  it('retains the full remaining-obligation text and points truncated search previews to the frozen source', () => {
    const source = documented('An elementary auxiliary estimate. '.repeat(50), 'Construct the telescope witness before applying this estimate.');
    const input = fixture(source), { base } = catalog(input);
    const result = searchTheoremKnowledge(base, 'telescope witness');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.description).toContain('Search previews may omit remaining obligations');
    expect(result.hits[0]!.description).toContain(file);
    expect(base.entries[0]!.description).toContain('Remaining: Construct the telescope witness before applying this estimate.');
    expect(base.sources[base.contexts[base.entries[0]!.contextDigest]![file]!]).toBe(source);
  });

  it.each([
    { label: 'legacy module without the generated header', source: lean, moduleFile: file },
    { label: 'hand library with a similarly named comment', source: documented(), moduleFile: 'Submission/Library/Fixture/Bridge.lean' },
  ])('preserves the existing description for a $label', ({ source, moduleFile }) => {
    const { base } = catalog(fixture(source, moduleFile));
    expect(base.entries[0]!.description).toBe(`Frozen library declaration from ${moduleFile.slice(0, -5).replaceAll('/', '.')}.`);
  });

  it.each(['same-length', 'changed-length'])('rejects %s tampering with the frozen documentation object', mode => {
    const input = fixture(documented()), { base } = catalog(input), entry = base.entries[0]!;
    const object = path.join(input.output + '.objects', base.contexts[entry.contextDigest]![file]!);
    const source = fs.readFileSync(object, 'utf8');
    fs.chmodSync(object, 0o600);
    fs.writeFileSync(object, mode === 'same-length' ? source.replace('entropy', 'enTropy') : source + '\n');
    fs.chmodSync(object, 0o400);
    expect(() => prepareLibraryKnowledge(input.workspace, input.output)).toThrow('math_knowledge_source_changed');
  });
});
