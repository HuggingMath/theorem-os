import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { canonicalLibraryJson, validateLibraryRelease, type LibraryReleaseArtifacts } from '../src/math/libraryRelease';
import { resolveEffectiveLibraryPack, type LibraryTaskPolicy } from '../src/math/libraryEffectivePack';

const root = fileURLToPath(new URL('./fixtures/library-release/', import.meta.url));
const names = ['pack.json', 'library.json', 'verification.json', 'declaration-metadata.jsonl', 'search-index-manifest.json'] as const;
function fixture(): Record<typeof names[number], Buffer> {
  return Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(root, name))])) as Record<typeof names[number], Buffer>;
}
const json = (value: unknown) => Buffer.from(canonicalLibraryJson(value) + '\n');
const parse = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString('utf8'));
const manifestDigest = (artifacts: LibraryReleaseArtifacts) => mathDigest(artifacts['search-index-manifest.json']);
function rebind(artifacts: ReturnType<typeof fixture>) {
  const manifest = parse(artifacts['search-index-manifest.json']);
  for (const name of names.slice(0, -1)) manifest.artifacts[name] = { bytes: artifacts[name].length, sha256: mathDigest(artifacts[name]) };
  artifacts['search-index-manifest.json'] = json(manifest);
}
function policy(artifacts: LibraryReleaseArtifacts, selection: LibraryTaskPolicy['selection'] = { mode: 'mapped', exclusionKeys: ['FixtureTask'] }): LibraryTaskPolicy {
  return { schema: 'theorem-os.library-task-policy.v1', taskId: 'host-task-123', manifestSha256: manifestDigest(artifacts),
    environment: parse(artifacts['library.json']).environment, runtimeEnvironmentDigest: 'e'.repeat(64), selection };
}

describe('host release validation and effective pack', () => {
  it('accepts Python-generated exact bytes and keeps kernel and human-review claims separate', () => {
    const artifacts = fixture(), release = validateLibraryRelease(artifacts, manifestDigest(artifacts));
    expect(release.pack.modules).toHaveLength(5);
    expect(release.declarations).toHaveLength(5);
    expect(release.declarations.every(item => item.proof_status === 'kernel_verified' && item.human_review.grade === null)).toBe(true);
    expect(release.pack.modules[0]!.source).toContain('import Submission.Library.TheoremOS.Fixture.B');
    expect(release.pack.modules[0]!.source).toContain('namespace TheoremOS.Fixture');
  });

  it('uses Unicode code-point order and lexical integer-shaped keys for set hashes', () => {
    expect(canonicalLibraryJson({ '\u{10000}': 1, '\ue000': 2, '2': 3, '10': 4 })).toBe('{"10":4,"2":3,"\ue000":2,"\u{10000}":1}');
  });

  it.each(names)('rejects replacement bytes in %s', name => {
    const artifacts = fixture(), digest = manifestDigest(artifacts);
    artifacts[name] = Buffer.concat([artifacts[name], Buffer.from(' ')]);
    expect(() => validateLibraryRelease(artifacts, digest)).toThrow(/digest_mismatch/);
  });

  it('rejects missing host pin, missing artifacts and unresolved policies', () => {
    const artifacts = fixture();
    expect(() => validateLibraryRelease(artifacts, '0'.repeat(64))).toThrow(/manifest_digest/);
    expect(() => validateLibraryRelease({ ...artifacts, 'pack.json': undefined } as unknown as LibraryReleaseArtifacts,
      manifestDigest(artifacts))).toThrow(/artifact_size/);
    expect(() => resolveEffectiveLibraryPack(artifacts, { ...policy(artifacts), selection: undefined })).toThrow();
    expect(() => resolveEffectiveLibraryPack(artifacts, policy(artifacts, { mode: 'mapped', exclusionKeys: ['UnknownTask'] }))).toThrow(/unresolved/);
  });

  it('excludes A → B → C transitively, retaining independent D and its background E', () => {
    const artifacts = fixture(), effective = resolveEffectiveLibraryPack(artifacts, policy(artifacts));
    expect(effective.modules.map(item => item.file)).toEqual(['Submission/Library/TheoremOS/Fixture/D.lean', 'Submission/Library/TheoremOS/Fixture/E.lean']);
    expect(effective.pack!.modules.map(item => item.file)).toEqual(effective.modules.map(item => item.file));
    expect(effective.declarations.map(item => item.name)).toEqual(['TheoremOS.Fixture.d', 'TheoremOS.Fixture.e']);
    expect(JSON.stringify(effective)).not.toContain('TheoremOS.Fixture.c');
    expect(JSON.stringify(effective)).not.toContain('Fixture/C.lean');
  });

  it('requires explicit unrestricted selection and binds policy/task/environment separately from the allowed set', () => {
    const artifacts = fixture(), unrestricted = policy(artifacts, { mode: 'unrestricted' });
    const all = resolveEffectiveLibraryPack(artifacts, unrestricted);
    expect(all.modules).toHaveLength(5);
    const mapped = resolveEffectiveLibraryPack(artifacts, policy(artifacts, { mode: 'mapped', exclusionKeys: ['EmptyTask'] }));
    expect(mapped.binding.effectivePackDigest).toBe(all.binding.effectivePackDigest);
    expect(mapped.binding.policySha256).not.toBe(all.binding.policySha256);
    const other = resolveEffectiveLibraryPack(artifacts, { ...unrestricted, taskId: 'other' });
    expect(other.binding.policySha256).not.toBe(all.binding.policySha256);
    expect(() => resolveEffectiveLibraryPack(artifacts, { ...unrestricted, environment: { ...unrestricted.environment,
      lake_manifest_sha256: 'f'.repeat(64) } })).toThrow(/environment_mismatch/);
  });

  it('canonicalizes equivalent exclusion-key sets and handles an empty allowed set', () => {
    const artifacts = fixture();
    const first = resolveEffectiveLibraryPack(artifacts, policy(artifacts, { mode: 'mapped', exclusionKeys: ['FixtureTask', 'EmptyTask', 'FixtureTask'] }));
    const second = resolveEffectiveLibraryPack(artifacts, policy(artifacts, { mode: 'mapped', exclusionKeys: ['EmptyTask', 'FixtureTask'] }));
    expect(first).toEqual(second);
    const library = parse(artifacts['library.json']);
    library.exclusions.FixtureTask.push('TheoremOS/Fixture/E.lean');
    artifacts['library.json'] = json(library);
    const manifest = parse(artifacts['search-index-manifest.json']);
    manifest.exclusions_sha256 = mathDigest(canonicalLibraryJson(library.exclusions));
    artifacts['search-index-manifest.json'] = json(manifest); rebind(artifacts);
    const empty = resolveEffectiveLibraryPack(artifacts, policy(artifacts));
    expect(empty.pack).toBeNull(); expect(empty.modules).toEqual([]); expect(empty.declarations).toEqual([]);
  });

  it('rejects source binding, import, exclusion and declaration identity corruption even with a new trusted pin', () => {
    for (const change of [
      (v: any) => { v.modules[0].source_sha256 = 'f'.repeat(64); },
      (v: any) => { v.modules[0].imports = []; },
      (v: any) => { v.modules[0].declarations = ['forged']; },
      (v: any) => { v.exclusions.FixtureTask = ['TheoremOS/Missing.lean']; },
    ]) {
      const artifacts = fixture(), library = parse(artifacts['library.json']); change(library);
      artifacts['library.json'] = json(library); rebind(artifacts);
      expect(() => validateLibraryRelease(artifacts, manifestDigest(artifacts))).toThrow();
    }
  });

  it('rejects unsuccessful kernels, wrong coverage, failed controls and nonpermitted axioms with fresh byte hashes', () => {
    for (const change of [
      (v: any) => { v.replay.nanoda.exit = 1; },
      (v: any) => { v.replay.leanchecker.exit = 1; },
      (v: any) => { v.replay.export.exit = 1; },
      (v: any) => { v.replay.selfTest.leanchecker.rejected = false; },
      (v: any) => { v.replay.nanoda.permittedAxioms.push('sorryAx'); },
      (v: any) => { delete v.replay.coverage.tools.nanoda; },
      (v: any) => { v.replay.coverage.modules[1].source_sha256 = 'f'.repeat(64); },
      (v: any) => { v.replay.coverage.declarations[0].module = 'TheoremOS'; },
    ]) {
      const artifacts = fixture(), verification = parse(artifacts['verification.json']); change(verification);
      artifacts['verification.json'] = json(verification); rebind(artifacts);
      expect(() => validateLibraryRelease(artifacts, manifestDigest(artifacts))).toThrow();
    }
  });

  it('counts without declaration coverage remain unknown and cannot assert verified', () => {
    const artifacts = fixture(), verification = parse(artifacts['verification.json']);
    delete verification.replay.coverage;
    artifacts['verification.json'] = json(verification); rebind(artifacts);
    expect(() => validateLibraryRelease(artifacts, manifestDigest(artifacts))).toThrow(/proof_evidence/);
    const rows = artifacts['declaration-metadata.jsonl'].toString().trimEnd().split('\n').map(line => JSON.parse(line));
    for (const row of rows) { row.proof_status = 'unknown'; row.kernel_kind = null; row.verification_refs = []; }
    artifacts['declaration-metadata.jsonl'] = Buffer.concat(rows.map(json)); rebind(artifacts);
    expect(validateLibraryRelease(artifacts, manifestDigest(artifacts)).declarations.every(item => item.proof_status === 'unknown')).toBe(true);
  });

  it('rejects forged human review and duplicate JSON keys', () => {
    const artifacts = fixture(), rows = artifacts['declaration-metadata.jsonl'].toString().trimEnd().split('\n').map(line => JSON.parse(line));
    rows[0].human_review.grade = 'A';
    artifacts['declaration-metadata.jsonl'] = Buffer.concat(rows.map(json)); rebind(artifacts);
    expect(() => validateLibraryRelease(artifacts, manifestDigest(artifacts))).toThrow();
    const duplicate = fixture();
    duplicate['library.json'] = Buffer.from(duplicate['library.json'].toString().replace('{', '{"commit":"duplicate",'));
    rebind(duplicate);
    expect(() => validateLibraryRelease(duplicate, manifestDigest(duplicate))).toThrow(/duplicate_json_key/);
  });
});

// The ordinary task bootstrap receives policy through a separate host argument, never task JSON.
import os from 'node:os';
import { bootstrapLeanTask, readLeanTaskReceipt } from '../src/math/leanTask';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { canonicalMathProblemStatementPayloads } from '../src/math/contracts';

describe('ordinary task release bootstrap', () => {
  const source = 'import Mathlib\ntheorem user_goal : True := by sorry\n';
  const task = 'Prove the target';
  function hostPolicy(artifacts: LibraryReleaseArtifacts): LibraryTaskPolicy {
    return { ...policy(artifacts), taskId: `lean-task-${mathDigest(canonicalMathProblemStatementPayloads({
      informalStatement: task, formalStatement: source, assumptions: [] }).lean).slice(0, 16)}`,
      runtimeEnvironmentDigest: getLeanTaskEnvironment('openai-math').dependencyDigest };
  }
  it('installs only the effective pack, freezes its binding, and rejects receipt policy tampering on resume', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'effective-library-')));
    try {
      const artifacts = fixture(), receipt = bootstrapLeanTask(path.join(root, 'task'), { source, task, environment: 'openai-math' },
        { artifacts, policy: hostPolicy(artifacts) });
      expect(Object.keys(receipt.libraryPack!.files)).toEqual(['Submission/Library/TheoremOS/Fixture/D.lean', 'Submission/Library/TheoremOS/Fixture/E.lean']);
      expect(fs.existsSync(path.join(receipt.projectRoot, 'Submission/Library/TheoremOS/Fixture/C.lean'))).toBe(false);
      expect(fs.existsSync(path.join(receipt.workspaceRoot, 'library.json'))).toBe(false);
      expect(readLeanTaskReceipt(receipt.activeProblemPath)).toEqual(receipt);
      fs.writeFileSync(receipt.activeProblemPath, JSON.stringify({ ...receipt, libraryBinding: { ...receipt.libraryBinding,
        policySha256: '0'.repeat(64) } }));
      expect(() => readLeanTaskReceipt(receipt.activeProblemPath)).toThrow(/identity_changed/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects a mismatched task or runtime environment before creating files', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'effective-library-')));
    try {
      const artifacts = fixture(), base = hostPolicy(artifacts);
      for (const wrong of [{ ...base, taskId: 'different' }, { ...base, runtimeEnvironmentDigest: '0'.repeat(64) }]) {
        expect(() => bootstrapLeanTask(path.join(root, 'task'), { source, task, environment: 'openai-math' },
          { artifacts, policy: wrong })).toThrow(/binding_mismatch/);
        expect(fs.existsSync(path.join(root, 'task'))).toBe(false);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
