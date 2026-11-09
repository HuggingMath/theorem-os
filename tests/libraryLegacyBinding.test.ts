import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { canonicalLibraryJson, type LibraryReleaseArtifacts } from '../src/math/libraryRelease';
import { resolveEffectiveLibraryPack } from '../src/math/libraryEffectivePack';
import { legacyLibraryArtifactLimits, resolveLegacyEffectiveLibraryPack, validateLegacyLibraryBinding } from '../src/math/libraryLegacyBinding';
import { bootstrapLeanTask, leanTaskId, readLeanTaskReceipt } from '../src/math/leanTask';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { resolveHostLibrary } from '../src/math/libraryHostConfig';

const root = fileURLToPath(new URL('./fixtures/library-legacy/', import.meta.url));
const encode = (value: unknown) => Buffer.from(canonicalLibraryJson(value) + '\n');
function fixture() {
  const originals = { 'pack.json': fs.readFileSync(path.join(root, 'pack.json')),
    'library.json': fs.readFileSync(path.join(root, 'library.json')), 'verification.json': fs.readFileSync(path.join(root, 'verification.json')) };
  const bytes = fs.readFileSync(path.join(root, 'legacy-library-binding.json'));
  const binding = JSON.parse(bytes.toString());
  const policy = { schema: 'theorem-os.library-task-policy.v1', taskId: 'legacy-test', manifestSha256: mathDigest(bytes),
    environment: binding.environment, runtimeEnvironmentDigest: 'e'.repeat(64), selection: { mode: 'mapped', exclusionKeys: ['FixtureTask'] } };
  return { originals, bytes, binding, policy };
}

describe('host-only legacy binding', () => {
  it.each([{ mode: 'mapped', exclusionKeys: ['FixtureTask'] }, { mode: 'unrestricted' },
    { mode: 'mapped', exclusionKeys: ['EmptyTask'] }])('matches new-release allowed sets for %j, with unknown coverage', selection => {
    const { originals, bytes, policy } = fixture();
    const legacy = resolveLegacyEffectiveLibraryPack(originals, bytes, { ...policy, selection });
    const newRoot = fileURLToPath(new URL('./fixtures/library-release/', import.meta.url));
    const artifacts = Object.fromEntries([...Object.keys(legacyLibraryArtifactLimits), 'declaration-metadata.jsonl', 'search-index-manifest.json']
      .map(name => [name, fs.readFileSync(path.join(newRoot, name))])) as unknown as LibraryReleaseArtifacts;
    const current = resolveEffectiveLibraryPack(artifacts, { ...policy, selection,
      manifestSha256: mathDigest(artifacts['search-index-manifest.json']), environment: JSON.parse(Buffer.from(artifacts['library.json']).toString()).environment });
    expect(legacy.pack).toEqual(current.pack);
    for (const key of ['effectivePackDigest', 'moduleSetSha256', 'declarationSetSha256'] as const)
      expect(legacy.binding[key]).toBe(current.binding[key]);
    expect(legacy.binding.legacyBindingSha256).toBe(mathDigest(bytes));
    expect(legacy.declarations.every(item => item.proof_status === 'unknown' && !item.verification_refs.length)).toBe(true);
    expect(legacy.binding.policySha256).not.toBe(current.binding.policySha256);
  });
  it.each(Object.keys(legacyLibraryArtifactLimits))('binds original %s bytes', name => {
    const { originals, bytes, policy } = fixture();
    originals[name as keyof typeof originals] = Buffer.concat([originals[name as keyof typeof originals], Buffer.from(' ')]);
    expect(() => validateLegacyLibraryBinding(originals, bytes, policy.manifestSha256)).toThrow(/artifact_digest/);
  });
  it('rejects mapping replacement, duplicate keys, and missing source or policy evidence', () => {
    const { originals, bytes, binding, policy } = fixture();
    expect(() => validateLegacyLibraryBinding(originals, Buffer.concat([bytes, Buffer.from(' ')]), policy.manifestSha256)).toThrow(/binding_digest/);
    for (const key of ['source_evidence', 'policy_source']) {
      const modified = { ...binding }; delete modified[key];
      const changed = encode(modified);
      expect(() => validateLegacyLibraryBinding(originals, changed, mathDigest(changed))).toThrow();
    }
    const duplicate = Buffer.from(bytes.toString().replace('{', '{"commit":"duplicate",'));
    expect(() => validateLegacyLibraryBinding(originals, duplicate, mathDigest(duplicate))).toThrow(/duplicate_json_key/);
  });
  it('rejects mismatched policy, source inventory and manufactured normalization even with a new host pin', () => {
    for (const change of [(b: any) => { b.policy_source.contents = '{}'; },
      (b: any) => { b.source_evidence.modules[0].sha256 = 'f'.repeat(64); },
      (b: any) => { b.normalized['verification.json'] = b.normalized['verification.json'].replace('"exit":0', '"exit":1'); },
      (b: any) => { b.normalized['declaration-metadata.jsonl'] = b.normalized['declaration-metadata.jsonl'].replace('unknown', 'kernel_verified'); }]) {
      const { originals, binding } = fixture(); change(binding);
      const bytes = encode(binding);
      expect(() => validateLegacyLibraryBinding(originals, bytes, mathDigest(bytes))).toThrow();
    }
  });
  it('rejects failed original verification even if the migration hashes are refreshed', () => {
    const { originals, binding } = fixture();
    const verification = JSON.parse(originals['verification.json'].toString()); verification.replay.nanoda.exit = 1;
    originals['verification.json'] = encode(verification);
    binding.artifacts['verification.json'] = { bytes: originals['verification.json'].length, sha256: mathDigest(originals['verification.json']) };
    const bytes = encode(binding);
    expect(() => validateLegacyLibraryBinding(originals, bytes, mathDigest(bytes))).toThrow();
  });
});

describe('legacy ordinary task installation and recovery', () => {
  let temporary: string | undefined;
  afterEach(() => { vi.unstubAllEnvs(); if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });
  function setup() {
    temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-host-')));
    const releaseDirectory = path.join(temporary, 'release'); fs.cpSync(root, releaseDirectory, { recursive: true });
    const source = 'import Mathlib\ntheorem legacy_goal : True := by sorry\n';
    const configPath = path.join(temporary, 'host.json'), workspace = path.join(temporary, 'solver');
    const config = { schema: 'theorem-os.library-host-config.v1', format: 'legacy', releaseDirectory,
      manifestSha256: mathDigest(fixture().bytes), sourceLakeManifest: path.join(releaseDirectory, 'lake-manifest.json'),
      tasks: [{ taskId: leanTaskId(source), selection: { mode: 'mapped', exclusionKeys: ['FixtureTask'] } }] };
    fs.writeFileSync(configPath, encode(config)); vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', configPath);
    return { config, configPath, workspace, source, releaseDirectory };
  }
  it('uses the shared task/receipt flow without exposing full legacy artifacts and rejects changed binding', () => {
    const { workspace, source, releaseDirectory } = setup();
    const receipt = bootstrapLeanTask(workspace, { source, task: 'prove', environment: 'openai-math' });
    expect(Object.keys(receipt.libraryPack!.files)).toHaveLength(2);
    expect(receipt.libraryBinding!.legacyBindingSha256).toBe(mathDigest(fixture().bytes));
    expect(fs.existsSync(path.join(workspace, 'legacy-library-binding.json'))).toBe(false);
    expect(readLeanTaskReceipt(receipt.activeProblemPath)).toEqual(receipt);
    fs.appendFileSync(path.join(releaseDirectory, 'legacy-library-binding.json'), ' ');
    expect(() => readLeanTaskReceipt(receipt.activeProblemPath)).toThrow(/binding_digest/);
  });
  it('rejects raw-pack bypass, unmapped task, bad dependency lock and unsupported format', () => {
    const { workspace, source, config, configPath } = setup();
    expect(() => bootstrapLeanTask(workspace, { source, task: 'prove', environment: 'openai-math', libraryPack: {} as never })).toThrow(/sources_conflict/);
    const environment = getLeanTaskEnvironment('openai-math');
    const target = { toolchain: environment.toolchain, lakeManifest: environment.files['lake-manifest.json']!, runtimeEnvironmentDigest: environment.dependencyDigest };
    expect(() => resolveHostLibrary({ taskId: 'missing' }, target, workspace)).toThrow(/unmapped/);
    fs.appendFileSync(config.sourceLakeManifest, ' ');
    expect(() => bootstrapLeanTask(workspace, { source, task: 'prove', environment: 'openai-math' })).toThrow(/dependency_mismatch/);
    fs.writeFileSync(configPath, encode({ ...config, format: 'other' }));
    expect(() => resolveHostLibrary({ taskId: leanTaskId(source) }, target, workspace)).toThrow();
    expect(fs.existsSync(workspace)).toBe(false);
  });
});
