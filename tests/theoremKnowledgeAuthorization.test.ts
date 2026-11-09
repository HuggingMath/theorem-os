import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask, leanTaskId } from '../src/math/leanTask';
import { mathDigest, canonicalMathJson } from '../src/math/mathRuntimeIo';
import { writeLibraryHostFixture } from './helpers/libraryHostFixture';
import { prepareLibraryKnowledge } from '../src/solver/theoremKnowledgeLibrary';
import { buildAuthorizedLibraryKnowledge, readAuthorizedKnowledgeCatalog } from '../src/solver/theoremKnowledgeAuthorization';
import { copyKnowledgeSnapshot, readKnowledgeCatalog, writePackedKnowledge } from '../src/solver/theoremKnowledgeStore';
import { getKnowledgeTheorem, searchTheoremKnowledge, theoremKnowledgeStats } from '../src/solver/theoremKnowledge';
import { getKnowledgeMetadata } from '../src/solver/theoremKnowledgeMetadata';

describe('installed Library knowledge authorization', () => {
  let root: string;
  const source = 'import Mathlib\ntheorem knowledge_goal : True := by sorry\n';
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-auth-'))); });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
  function fixture() {
    const host = writeLibraryHostFixture(root, [{ taskId: leanTaskId(source), selection: { mode: 'mapped', exclusionKeys: ['FixtureTask'] } }]);
    vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', host.configPath);
    const workspace = path.join(root, 'task');
    const receipt = bootstrapLeanTask(workspace, { source, task: 'prove', environment: 'openai-math' });
    const file = path.join(root, 'knowledge.json');
    const result = prepareLibraryKnowledge(workspace, file);
    if (!result.enabled) throw new Error('expected enabled');
    return { ...host, workspace, receipt, file, result };
  }
  it('indexes exactly the installed set, carries release evidence, and exposes only authorized details and sources', () => {
    const f = fixture(), loaded = readAuthorizedKnowledgeCatalog(f.file, f.workspace);
    expect(loaded.base.entries.map(item => item.name).sort()).toEqual(['TheoremOS.Fixture.d', 'TheoremOS.Fixture.e']);
    expect(loaded.base.libraryAuthorization!.binding).toEqual(f.receipt.libraryBinding);
    expect(theoremKnowledgeStats(loaded.base).entries).toBe(2);
    expect(searchTheoremKnowledge(loaded.base, 'TheoremOS.Fixture.c').hits.every(item => item.name !== 'TheoremOS.Fixture.c')).toBe(true);
    const entry = loaded.base.entries[0]!;
    expect(entry.libraryMetadata!.proof_status).toBe('kernel_verified');
    expect(getKnowledgeMetadata(loaded.base, entry.id).fields.libraryMetadata.value).toEqual(entry.libraryMetadata);
    expect(getKnowledgeTheorem(loaded.base, entry.id).libraryMetadata).toEqual(entry.libraryMetadata);
    expect(() => getKnowledgeTheorem(loaded.base, entry.id, 'Submission/Library/TheoremOS/Fixture/C.lean')).toThrow(/source_not_found/);
    expect(canonicalMathJson(loaded.base)).not.toContain('TheoremOS.Fixture.c');
    expect(canonicalMathJson(loaded.base)).not.toContain('knowledge_goal');
    expect(prepareLibraryKnowledge(f.workspace, f.file)).toEqual(f.result);
  });
  it.each(['stateFiles', 'autoLibraryBuilds'] as const)('rejects %s before reading historical content or producing any output', key => {
    const f = fixture(), output = path.join(root, 'rejected.json');
    expect(() => prepareLibraryKnowledge(f.workspace, output, { [key]: [path.join(root, 'nonexistent-secret')] })).toThrow(/history_unauthorized/);
    expect(fs.existsSync(output)).toBe(false); expect(fs.existsSync(output + '.objects')).toBe(false);
  });
  it('rechecks policy and configuration on every read, including after a cached successful search', () => {
    const f = fixture(), loaded = readAuthorizedKnowledgeCatalog(f.file, f.workspace);
    searchTheoremKnowledge(loaded.base, 'Fixture');
    fs.appendFileSync(f.configPath, ' ');
    expect(() => readAuthorizedKnowledgeCatalog(f.file, f.workspace)).toThrow(/binding_changed/);
    expect(() => prepareLibraryKnowledge(f.workspace, f.file)).toThrow(/binding_changed/);
  });
  it('rejects another task receipt, removed host configuration and changed installed sources', () => {
    const f = fixture(), other = path.join(root, 'other');
    bootstrapLeanTask(other, { source, task: 'prove', environment: 'openai-math' });
    expect(() => readAuthorizedKnowledgeCatalog(f.file, other)).toThrow(/authorization_mismatch/);
    vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', undefined);
    expect(() => readAuthorizedKnowledgeCatalog(f.file, f.workspace)).toThrow();
    vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', f.configPath);
    fs.appendFileSync(path.join(f.receipt.projectRoot, Object.keys(f.receipt.libraryPack!.files)[0]!), '\n');
    expect(() => readAuthorizedKnowledgeCatalog(f.file, f.workspace)).toThrow();
  });
  it('rejects forged descriptions, provenance and proof status even when catalog hashes are regenerated', () => {
    const f = fixture();
    for (const change of [(base: any) => { base.libraryAuthorization.binding.policySha256 = '0'.repeat(64); },
      (base: any) => { base.entries[0].provenance[0].source = 'forged secret'; },
      (base: any) => { base.entries[0].description = 'excluded proof in free text'; },
      (base: any) => { base.entries[0].libraryMetadata.proof_status = 'unknown'; },
      (base: any) => { delete base.libraryAuthorization; }]) {
      const base = structuredClone(buildAuthorizedLibraryKnowledge(f.workspace).base); change(base);
      for (const entry of base.entries) {
        const { id: _id, provenance: _provenance, ...identity } = entry;
        entry.id = mathDigest(canonicalMathJson(identity));
      }
      const target = path.join(root, `forged-${Math.random()}.json`);
      writePackedKnowledge(target, base);
      expect(() => readAuthorizedKnowledgeCatalog(target, f.workspace)).toThrow(/authorization_mismatch/);
    }
  });
  it('rejects additional unreferenced source blobs and verifies source contents on every read', () => {
    const f = fixture(), base = structuredClone(buildAuthorizedLibraryKnowledge(f.workspace).base);
    base.sources[mathDigest('secret excluded proof')] = 'secret excluded proof';
    const target = path.join(root, 'extra.json'); writePackedKnowledge(target, base);
    expect(() => readAuthorizedKnowledgeCatalog(target, f.workspace)).toThrow(/authorization_mismatch/);
    const loaded = readAuthorizedKnowledgeCatalog(f.file, f.workspace), digest = Object.keys(loaded.base.sources)[0]!;
    const object = path.join(f.file + '.objects', digest), bytes = fs.readFileSync(object);
    fs.chmodSync(object, 0o600); fs.writeFileSync(object, Buffer.alloc(bytes.length, 32)); fs.chmodSync(object, 0o400);
    expect(() => readAuthorizedKnowledgeCatalog(f.file, f.workspace)).toThrow(/source_changed/);
  });
  it('preserves authorization in worker copies and validates their current objects', () => {
    const f = fixture(), loaded = readAuthorizedKnowledgeCatalog(f.file, f.workspace), copy = path.join(root, 'worker/catalog.json');
    copyKnowledgeSnapshot(loaded, f.file, copy);
    expect(readAuthorizedKnowledgeCatalog(copy, f.workspace, undefined, loaded.digest).base).toEqual(loaded.base);
    expect(readKnowledgeCatalog(copy).base.libraryAuthorization).toEqual(loaded.base.libraryAuthorization);
  });
  it('publishes a bound empty catalog when policy excludes every module', () => {
    const f = fixture();
    const libraryFile = path.join(f.config.releaseDirectory, 'library.json');
    const manifestFile = path.join(f.config.releaseDirectory, 'search-index-manifest.json');
    const library = JSON.parse(fs.readFileSync(libraryFile, 'utf8')), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    library.exclusions.FixtureTask = library.modules.map((item: any) => item.source_file);
    fs.writeFileSync(libraryFile, canonicalMathJson(library));
    manifest.artifacts['library.json'] = { sha256: mathDigest(fs.readFileSync(libraryFile)), bytes: fs.statSync(libraryFile).size };
    manifest.exclusions_sha256 = mathDigest(canonicalMathJson(library.exclusions));
    fs.writeFileSync(manifestFile, canonicalMathJson(manifest));
    fs.writeFileSync(f.configPath, canonicalMathJson({ ...f.config, manifestSha256: mathDigest(fs.readFileSync(manifestFile)) }));
    const workspace = path.join(root, 'empty'); bootstrapLeanTask(workspace, { source, task: 'prove', environment: 'openai-math' });
    const file = path.join(root, 'empty.json'), result = prepareLibraryKnowledge(workspace, file);
    expect(result).toMatchObject({ enabled: true, entries: 0, libraryModules: 0 });
    const loaded = readAuthorizedKnowledgeCatalog(file, workspace);
    expect(loaded.base.entries).toEqual([]); expect(loaded.base.sources).toEqual({});
    expect(loaded.base.libraryAuthorization).toBeDefined();
  });
  it('keeps legacy declaration coverage unknown in the authorized catalog', () => {
    const releaseDirectory = path.join(root, 'legacy');
    fs.cpSync(path.resolve('tests/fixtures/library-legacy'), releaseDirectory, { recursive: true });
    const configPath = path.join(root, 'host.json');
    fs.writeFileSync(configPath, canonicalMathJson({ schema: 'theorem-os.library-host-config.v1', format: 'legacy', releaseDirectory,
      sourceLakeManifest: path.join(releaseDirectory, 'lake-manifest.json'),
      manifestSha256: mathDigest(fs.readFileSync(path.join(releaseDirectory, 'legacy-library-binding.json'))),
      tasks: [{ taskId: leanTaskId(source), selection: { mode: 'mapped', exclusionKeys: ['FixtureTask'] } }] }));
    vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', configPath);
    const workspace = path.join(root, 'legacy-task'); bootstrapLeanTask(workspace, { source, task: 'prove', environment: 'openai-math' });
    const file = path.join(root, 'legacy.json'); prepareLibraryKnowledge(workspace, file);
    const loaded = readAuthorizedKnowledgeCatalog(file, workspace);
    expect(loaded.base.entries).toHaveLength(2);
    expect(loaded.base.entries.every(item => item.libraryMetadata?.proof_status === 'unknown')).toBe(true);
  });
  it('host CLI requires a workspace and rejects archive build/pack paths', () => {
    const f = fixture();
    const cli = (...args: string[]) => spawnSync('bun', ['scripts/mathematics/theoremKnowledge.ts', ...args], { encoding: 'utf8', timeout: 30000 });
    const success = cli('stats', '--catalog', f.file, '--workspace', f.workspace);
    expect(success.status, success.stderr).toBe(0); expect(JSON.parse(success.stdout).entries).toBe(2);
    expect(cli('stats', '--catalog', f.file).stderr).toContain('--workspace is required');
    expect(cli('pack', '--catalog', f.file, '--output', path.join(root, 'packed.json')).stderr).toContain('history_unauthorized');
    expect(cli('build', '--state', '/missing', '--output', '/missing').stderr).toContain('history_unauthorized');
  });
});
