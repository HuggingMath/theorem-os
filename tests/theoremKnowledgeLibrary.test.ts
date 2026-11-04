import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { LIBRARY_PACK_SCHEMA, parseLibraryPack } from '../src/math/libraryPacks';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { getKnowledgeTheorem, searchTheoremKnowledge } from '../src/solver/theoremKnowledge';
import { prepareLibraryKnowledge } from '../src/solver/theoremKnowledgeLibrary';
import { readKnowledgeCatalog } from '../src/solver/theoremKnowledgeStore';
import { temporaryDirectory } from './helpers/files';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const rootDirectory = () => { const root = temporaryDirectory('library-knowledge-'); roots.push(root); return root; };
const baseFile = 'Submission/Library/Shared/Base.lean', consumerFile = 'Submission/Library/Shared/Consumer.lean';
const modules = {
  [baseFile]: '/-- General reusable arithmetic. -/\nnamespace Frozen\ndef twice (n : Nat) : Nat := n + n\ntheorem twice_zero : twice 0 = 0 := rfl\nend Frozen\n',
  [consumerFile]: ['import Submission.Library.Shared.Base', 'namespace Frozen', 'section', 'variable (n : Nat)',
    'theorem twice_self : twice n = n + n := rfl', 'end', 'namespace Nested', 'theorem twice_zero : twice 0 = 0 := rfl',
    'end Nested', 'instance fixtureInhabited : Inhabited Nat := ⟨0⟩', 'end Frozen', ''].join('\n'),
};
const source = '-- protected problem content must never enter the library catalog\nnamespace User\ntheorem target : True := by sorry\nend User\n';
function fixture(withLibrary = true, librarySources: Record<string, string> = modules) {
  const root = rootDirectory();
  const libraryPack = parseLibraryPack({ schema: LIBRARY_PACK_SCHEMA,
    modules: Object.entries(librarySources).map(([file, text]) => ({ file, source: text,
      origin: { kind: 'upstream', repository: 'fixture-library', commit: 'a'.repeat(40), file: 'Library.lean' } })) });
  const receipt = bootstrapLeanTask(path.join(root, 'workspace'), { source, task: 'Prove User.target.',
    ...(withLibrary ? { libraryPack } : {}) });
  return { root, receipt, output: path.join(root, 'knowledge', 'catalog.json') };
}
function replaceFrozen(file: string, text: string) {
  fs.chmodSync(file, 0o600); fs.writeFileSync(file, text); fs.chmodSync(file, 0o400);
}

describe('frozen library knowledge snapshots', () => {
  it('indexes theorem and definition source headers with the complete selected library context and honest provenance', () => {
    const f = fixture(), result = prepareLibraryKnowledge(f.receipt.workspaceRoot, f.output);
    expect(result).toMatchObject({ enabled: true, file: f.output, format: 'v2', entries: 4, libraryModules: 2,
      frozenLibraryPackEntries: 4, solverCheckedEntries: 0, acceptedArchiveEntries: 0, localVerifiedArchiveEntries: 0,
      requiresFreshCheck: true, libraryPackDigest: f.receipt.libraryPack!.digest, skipped: [] });
    if (!result.enabled) throw new Error('expected a library catalog');
    const loaded = readKnowledgeCatalog(result.file, result.sha256), entries = loaded.base.entries;
    expect(entries.map(item => item.name).sort()).toEqual([
      'Frozen.Nested.twice_zero', 'Frozen.twice', 'Frozen.twice_self', 'Frozen.twice_zero',
    ]);
    expect(entries.find(item => item.name === 'Frozen.twice')).toMatchObject({ kind: 'definition', typeKind: 'source-header' });
    expect(entries.find(item => item.name === 'Frozen.twice_self')).toMatchObject({ type: 'twice_self : twice n = n + n',
      typeKind: 'source-header', dependencies: { statement: [], proof: [], tasks: [], coverage: 'unavailable' } });
    const expectedFiles = [...Object.keys(modules), 'lake-manifest.json', 'lakefile.toml', 'lean-toolchain'].sort();
    for (const entry of entries) {
      expect(entry.elaboration).toBeUndefined();
      expect(Object.keys(loaded.base.contexts[entry.contextDigest]).sort()).toEqual(expectedFiles);
      expect(entry.provenance).toEqual([{ kind: 'frozen-library-pack', problemId: f.receipt.contract.problemId,
        source: f.receipt.activeProblemPath, sourceDigest: mathDigest(fs.readFileSync(f.receipt.activeProblemPath)),
        sourceCommit: f.receipt.baseCommit, environmentDigest: f.receipt.environmentDigest,
        problemReceiptDigest: mathDigest(canonicalMathJson(f.receipt)), receiptIds: [] }]);
      expect(getKnowledgeTheorem(loaded.base, entry.id, baseFile).source!.text).toBe(modules[baseFile]);
      expect(getKnowledgeTheorem(loaded.base, entry.id, consumerFile).source!.text).toBe(modules[consumerFile]);
    }
    expect(JSON.stringify(loaded.base)).not.toContain('protected problem content');
    expect(JSON.stringify(loaded.base)).not.toContain('User.target');
    const contextFiles = Object.values(loaded.base.contexts).flatMap(context => Object.keys(context));
    expect(contextFiles).not.toContain('Challenge.lean'); expect(contextFiles).not.toContain('Submission.lean');
    expect(searchTheoremKnowledge(loaded.base, 'twice_self').hits[0]?.name).toBe('Frozen.twice_self');
  });

  it('reads exact seed blobs instead of modified live modules, proof bodies or newly added library files', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.receipt.projectRoot, baseFile), 'def mutableLibraryMarker := 99\n');
    fs.writeFileSync(path.join(f.receipt.projectRoot, 'Submission.lean'), 'theorem mutableProofMarker : True := by trivial\n');
    fs.writeFileSync(path.join(f.receipt.projectRoot, 'Submission/Library/Extra.lean'), 'def unselectedLibraryMarker := 1\n');
    const result = prepareLibraryKnowledge(f.receipt.workspaceRoot, f.output);
    if (!result.enabled) throw new Error('expected a library catalog');
    const base = readKnowledgeCatalog(result.file, result.sha256).base, text = canonicalMathJson(base);
    expect(Object.values(base.sources)).toContain(modules[baseFile]);
    for (const marker of ['mutableLibraryMarker', 'mutableProofMarker', 'unselectedLibraryMarker']) expect(text).not.toContain(marker);
  });

  it('rejects a receipt that no longer matches the frozen seed before writing a catalog', () => {
    const f = fixture(), altered = structuredClone(f.receipt);
    altered.libraryPack!.files[baseFile] = 'b'.repeat(64);
    fs.writeFileSync(f.receipt.activeProblemPath, JSON.stringify(altered));
    expect(() => prepareLibraryKnowledge(f.receipt.workspaceRoot, f.output)).toThrow('lean_task_identity_changed');
    expect(fs.existsSync(f.output)).toBe(false);
    expect(fs.existsSync(f.output + '.objects')).toBe(false);
  });

  it('reuses an identical immutable packed snapshot without rewriting the manifest or its objects', () => {
    const f = fixture(), first = prepareLibraryKnowledge(f.receipt.workspaceRoot, f.output);
    if (!first.enabled) throw new Error('expected a library catalog');
    const loaded = readKnowledgeCatalog(first.file, first.sha256);
    const manifest = JSON.parse(loaded.text);
    expect(manifest.originSha256).toBe(mathDigest(fs.readFileSync(f.receipt.activeProblemPath)));
    const files = [f.output, ...Object.keys(loaded.base.sources).map(digest => path.join(f.output + '.objects', digest))];
    const identities = files.map(file => fs.statSync(file, { bigint: true }));
    expect(prepareLibraryKnowledge(f.receipt.workspaceRoot, f.output)).toEqual(first);
    files.forEach((file, index) => {
      const stat = fs.statSync(file, { bigint: true });
      expect([stat.ino, stat.mtimeNs, stat.ctimeNs]).toEqual([identities[index].ino, identities[index].mtimeNs, identities[index].ctimeNs]);
      expect(Number(stat.mode) & 0o222).toBe(0);
    });
  });

  it('rejects an existing catalog from another frozen origin without overwriting it', () => {
    const first = fixture(), second = fixture();
    prepareLibraryKnowledge(first.receipt.workspaceRoot, first.output);
    const bytes = fs.readFileSync(first.output);
    expect(() => prepareLibraryKnowledge(second.receipt.workspaceRoot, first.output)).toThrow('math_knowledge_identity_changed');
    expect(fs.readFileSync(first.output)).toEqual(bytes);
  });

  it('keeps frozen origin identity even when a library has no indexable declarations', () => {
    const empty = { 'Submission/Library/Shared/Empty.lean': 'import Std\n' };
    const first = fixture(true, empty), second = fixture(true, empty);
    expect(prepareLibraryKnowledge(first.receipt.workspaceRoot, first.output)).toMatchObject({ enabled: true, entries: 0, libraryModules: 1 });
    expect(() => prepareLibraryKnowledge(second.receipt.workspaceRoot, first.output)).toThrow('math_knowledge_identity_changed');
  });

  it('checks existing catalog identity and same-size source corruption on repeated preparation', () => {
    const f = fixture(), result = prepareLibraryKnowledge(f.receipt.workspaceRoot, f.output);
    if (!result.enabled) throw new Error('expected a library catalog');
    const loaded = readKnowledgeCatalog(result.file, result.sha256), digest = mathDigest(modules[baseFile]);
    const blob = path.join(f.output + '.objects', digest);
    replaceFrozen(blob, modules[baseFile].replace('n + n', 'n + 0'));
    expect(() => prepareLibraryKnowledge(f.receipt.workspaceRoot, f.output)).toThrow('math_knowledge_source_changed');
    replaceFrozen(blob, modules[baseFile]);
    const manifest = JSON.parse(loaded.text);
    manifest.originSha256 = '0'.repeat(64);
    replaceFrozen(f.output, canonicalMathJson(manifest) + '\n');
    expect(() => prepareLibraryKnowledge(f.receipt.workspaceRoot, f.output)).toThrow('math_knowledge_identity_changed');
  });

  it('returns disabled without creating output when the receipt has no library pack', () => {
    const f = fixture(false);
    expect(prepareLibraryKnowledge(f.receipt.workspaceRoot, f.output)).toEqual({ enabled: false });
    expect(fs.existsSync(path.dirname(f.output))).toBe(false);
  });

  it.each([false, true])('exposes the same snapshot contract through the CLI (library=%s)', withLibrary => {
    const f = fixture(withLibrary), cli = path.resolve('scripts/mathematics/prepareLibraryKnowledge.ts');
    const result = spawnSync('bun', [cli, '--workspace', f.receipt.workspaceRoot, '--output', f.output],
      { cwd: f.root, encoding: 'utf8', timeout: 30_000 });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject(withLibrary ? { enabled: true, file: f.output, entries: 4, frozenLibraryPackEntries: 4 } : { enabled: false });
    if (withLibrary) expect(readKnowledgeCatalog(parsed.file, parsed.sha256).format).toBe('v2');
    else expect(fs.existsSync(f.output)).toBe(false);
  });
});
