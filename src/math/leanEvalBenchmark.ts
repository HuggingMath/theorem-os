/** Explicit historical benchmark support; the default campaign pin is unchanged. */
import { parse as parseToml } from 'smol-toml';
import { LEAN_EVAL_BENCHMARK_COMMIT } from './leanEvalCatalogAdapter';
import { canonicalMathJson, mathDigest } from './mathRuntimeIo';
import { mathGitBytes } from './mathGit';

export const LEAN_EVAL_4341_PROFILE = 'lean-eval-4.34.1-v1' as const;
export const LEAN_EVAL_4341_COMMIT = '4ae7061fe4b0b70dcb7fe24fdee067b68636226b';
export const LEAN_EVAL_4341_ROOT_LOCK_SHA256 = 'c3c219aedffad64d63d9571dc48f598274eb0eff5e137d51fc911e5d81922e8c';
export const LEAN_EVAL_HISTORICAL_CREDITS = 'historical-benchmark:no-live-credits';
const mathlib = 'd13f23b723b8a846827a245b89c10fc7d3f11612';

export function leanEvalBenchmarkCommit(profile?: string, mode?: 'official' | 'benchmark'): string {
  if (profile === undefined) return LEAN_EVAL_BENCHMARK_COMMIT;
  if (profile !== LEAN_EVAL_4341_PROFILE) throw new Error('lean_eval_benchmark_profile_unknown');
  if (mode !== 'benchmark') throw new Error('lean_eval_historical_benchmark_mode_required');
  return LEAN_EVAL_4341_COMMIT;
}

/** Project the one pinned generator lock to a generated Mathlib-only task.
 * This is not a general dependency-pruning API: all root bytes are pinned. */
export function historicalLeanEvalManifest(rootLock: string, lakefile: string, toolchain: string): string {
  if (mathDigest(rootLock) !== LEAN_EVAL_4341_ROOT_LOCK_SHA256)
    throw new Error('lean_eval_historical_root_lock_changed');
  if (toolchain.trim() !== 'leanprover/lean4:v4.34.1') throw new Error('lean_eval_historical_toolchain_changed');
  const config = parseToml(lakefile);
  const requirements = config.require;
  if (typeof config.name !== 'string' || !/^[A-Za-z0-9_.-]+$/u.test(config.name) ||
      !Array.isArray(requirements) || requirements.length !== 1)
    throw new Error('lean_eval_historical_project_dependencies_changed');
  const requirement = requirements[0] as Record<string, unknown>;
  if (!requirement || Object.keys(requirement).sort().join() !== 'git,name,rev' ||
      requirement.name !== 'mathlib' || requirement.git !== 'https://github.com/leanprover-community/mathlib4.git' ||
      requirement.rev !== mathlib) throw new Error('lean_eval_historical_project_dependencies_changed');
  const manifest = JSON.parse(rootLock);
  // The exact root hash above authenticates both the omitted build tool and all retained revisions.
  const packages = manifest.packages.filter((item: { name: string }) => item.name !== '«lean-eval-generator»');
  return canonicalMathJson({ ...manifest, packages, name: config.name, lakeDir: '.lake', packagesDir: '.lake/packages' });
}

export function readHistoricalLeanEvalInputs(root: string, commit: string, project: string) {
  if (commit !== LEAN_EVAL_4341_COMMIT || !/^generated\/[A-Za-z0-9_.-]+$/u.test(project))
    throw new Error('lean_eval_historical_source_identity_changed');
  const read = (file: string) => mathGitBytes(root, ['--no-replace-objects', 'show', `${commit}:${file}`],
    { maxBuffer: 2 * 1024 * 1024, timeout: 30_000 }).toString('utf8');
  const conflicting = mathGitBytes(root, ['--no-replace-objects', 'ls-tree', '--name-only', commit, '--',
    `${project}/lake-manifest.json`, `${project}/lakefile.lean`], { maxBuffer: 4096, timeout: 30_000 }).toString().trim();
  if (conflicting) throw new Error('lean_eval_historical_project_configuration_changed');
  const lakefile = read(`${project}/lakefile.toml`), toolchain = read(`${project}/lean-toolchain`);
  const manifest = historicalLeanEvalManifest(read('lake-manifest.json'), lakefile, toolchain);
  if (JSON.parse(manifest).name !== project.slice('generated/'.length))
    throw new Error('lean_eval_historical_project_identity_changed');
  return { lakefile, toolchain, manifest };
}
