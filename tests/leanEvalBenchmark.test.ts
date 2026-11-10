import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { historicalLeanEvalManifest, leanEvalBenchmarkCommit, LEAN_EVAL_4341_COMMIT, LEAN_EVAL_4341_PROFILE,
  readHistoricalLeanEvalInputs } from '../src/math/leanEvalBenchmark';
import { LEAN_EVAL_BENCHMARK_COMMIT } from '../src/math/leanEvalCatalogAdapter';
import { libraryDependencyLockDigest } from '../src/math/libraryHostConfig';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { writeMathJsonDurable } from '../src/math/mathRuntimeIo';

// Unmodified public blobs from leanprover/lean-eval at 4ae7061fe4b0b70dcb7fe24fdee067b68636226b.
const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/lean-eval-4.34.1/${name}`, import.meta.url), 'utf8');
const lock = fixture('root-lock.json'), lakefile = fixture('pascal.toml'), toolchain = 'leanprover/lean4:v4.34.1\n';

describe('explicit historical Lean-Eval environment', () => {
  it('preserves the current default and requires benchmark mode for the allowlisted history', () => {
    expect(leanEvalBenchmarkCommit()).toBe(LEAN_EVAL_BENCHMARK_COMMIT);
    expect(leanEvalBenchmarkCommit(undefined, 'benchmark')).toBe(LEAN_EVAL_BENCHMARK_COMMIT);
    expect(leanEvalBenchmarkCommit(LEAN_EVAL_4341_PROFILE, 'benchmark')).toBe(LEAN_EVAL_4341_COMMIT);
    expect(() => leanEvalBenchmarkCommit('arbitrary-commit', 'benchmark')).toThrow(/profile_unknown/);
    expect(() => leanEvalBenchmarkCommit(LEAN_EVAL_4341_PROFILE)).toThrow(/benchmark_mode_required/);
    expect(() => leanEvalBenchmarkCommit(LEAN_EVAL_4341_PROFILE, 'official')).toThrow(/benchmark_mode_required/);
  });

  it('retains all nine package identities and exactly matches the fixed release environment', () => {
    const derived = historicalLeanEvalManifest(lock, lakefile, toolchain);
    const parsed = JSON.parse(derived);
    expect(parsed.name).toBe('pascal');
    expect(parsed.packages).toEqual(JSON.parse(lock).packages.filter((p: { name: string }) => p.name !== '«lean-eval-generator»'));
    expect(parsed.packages).toHaveLength(9);
    expect(libraryDependencyLockDigest(Buffer.from(derived))).toBe(libraryDependencyLockDigest(
      Buffer.from(getLeanTaskEnvironment('openai-math').files['lake-manifest.json']!)));
  });

  it('matches the exact durable manifest bytes used by bootstrap and receipt recovery', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-lock-'));
    try {
      const expected = historicalLeanEvalManifest(lock, lakefile, toolchain), file = path.join(directory, 'lake-manifest.json');
      const manifest = JSON.parse(expected);
      writeMathJsonDurable(file, { ...manifest, version: manifest.version ?? manifest.schemaVersion ?? '1.2.0',
        name: 'pascal', lakeDir: '.lake', packagesDir: '.lake/packages' });
      expect(fs.readFileSync(file, 'utf8')).toBe(expected);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([lock + ' ', lock.replace('77373a53', '00000000'), lock.replace('d13f23b7', '00000000')])(
    'rejects any change to original root bytes', changed => {
      expect(() => historicalLeanEvalManifest(changed, lakefile, toolchain)).toThrow(/root_lock_changed/);
    });

  it.each([
    lakefile + '\n[[require]]\nname = "extra"\npath = "../extra"\n',
    lakefile.replace('rev = "d13f23b723b8a846827a245b89c10fc7d3f11612"', 'rev = "main"'),
    lakefile.replace('name = "mathlib"', 'name = "lean-eval-generator"'),
    lakefile.replace('[[require]]', '[[require]]\npath = "../mathlib"'),
  ])('rejects generated projects requiring a different dependency closure', changed => {
    expect(() => historicalLeanEvalManifest(lock, changed, toolchain)).toThrow(/project_dependencies_changed/);
  });

  it('rejects another toolchain, commit, or unsafe project before reading its Git objects', () => {
    expect(() => historicalLeanEvalManifest(lock, lakefile, 'leanprover/lean4:v4.35.0-rc3')).toThrow(/toolchain_changed/);
    expect(() => readHistoricalLeanEvalInputs('/not-read', '0'.repeat(40), 'generated/pascal')).toThrow(/source_identity_changed/);
    expect(() => readHistoricalLeanEvalInputs('/not-read', LEAN_EVAL_4341_COMMIT, '../pascal')).toThrow(/source_identity_changed/);
  });
});
