import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';

describe('fixed Lean task environments', () => {
  it('preserves the existing standard and Mathlib receipt bindings', () => {
    expect(getLeanTaskEnvironment('standard').dependencyDigest)
      .toBe('8967318f7399ba5ef210a638ccdb0c4b056eb41c80fc871632f34a479500eff2');
    expect(getLeanTaskEnvironment('mathlib').dependencyDigest)
      .toBe('c3ba186edb3024032ca0d87fa85b0eaa4f62c5d71588936132acebc12625c7db');
  });

  it('pins a separate Lean 4.8 environment with its source-era manifest and library layout', () => {
    const environment = getLeanTaskEnvironment('mathlib-4.8');
    const manifest = JSON.parse(environment.files['lake-manifest.json']);
    expect(environment.toolchain).toBe('leanprover/lean4:v4.8.0');
    expect(environment.files['lean-toolchain']).toBe('leanprover/lean4:v4.8.0\n');
    expect(environment.mathlibRevision).toBe('b5eba595428809e96f3ed113bc7ba776c5f801ac');
    expect(environment.packageLibraryDirectory).toBe('.lake/build/lib');
    expect(manifest.version).toBe(7);
    expect(manifest.packages.map((item: { name: string }) => item.name))
      .toEqual(['batteries', 'Qq', 'aesop', 'proofwidgets', 'Cli', 'importGraph', 'mathlib']);
    expect(manifest.packages.every((item: { rev: string }) => /^[0-9a-f]{40}$/u.test(item.rev))).toBe(true);
    expect(manifest.packages.every((item: object) => !('scope' in item))).toBe(true);
    expect(manifest.packages.find((item: { name: string }) => item.name === 'mathlib')).toMatchObject({
      rev: environment.mathlibRevision, inputRev: environment.mathlibRevision, inherited: false,
    });
    expect(parseToml(environment.files['lakefile.toml']).require).toEqual([{
      name: 'mathlib', git: 'https://github.com/leanprover-community/mathlib4.git', rev: environment.mathlibRevision,
    }]);
    expect(environment.dependencyDigest).not.toBe(getLeanTaskEnvironment('mathlib').dependencyDigest);
    const { dependencyDigest, ...bound } = environment;
    expect(dependencyDigest).toBe(mathDigest(canonicalMathJson({
      schema: 'theorem-os.lean-task-environment.v1', ...bound,
    })));
    expect(Object.isFrozen(environment)).toBe(true);
    expect(Object.isFrozen(environment.files)).toBe(true);
  });

  it('does not infer an arbitrary source-version environment', () => {
    expect(() => getLeanTaskEnvironment('mathlib-4.9' as never)).toThrow('lean_task_environment_unavailable');
  });
});
