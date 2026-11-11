import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eraseFormalizationProofs } from '../math/formalizationSource';
import { refutationQuery, refutationSentinelHealthy, refutationVerdict, type FormalizationRefutationProbe,
  type RefutationVerdict } from '../math/formalizationRefutation';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { bindLeanPackages, prepareLeanDiagnosticOverrides, runLeanDiagnostics } from '../math/leanDiagnostics';
import { checkResolvedLeanToolchainReadiness } from '../math/leanToolchainReadiness';
import { MATH_PROOF_ENVIRONMENT_ENV, prepareMathProofEnvironment } from '../math/mathProofEnvironment';
import { DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT } from '../math/mathProofEnvironmentCache';
import { resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { canonicalMathJson, mathDigest, readMathText, writeMathFrozen } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import { resolveMathematicsLakePackagesCache } from '../math/verifier';
import { selectFormalizationLibraryPack, type FormalizationLibrary } from '../math/formalizationLibrary';
import { installLibraryPack } from '../math/libraryPacks';

export type FormalizationRefutationCheck = {
  schema: 'theorem-os.formalization-refutation-check.v1';
  status: 'checked' | 'unavailable';
  sourceSha256: string;
  probes: (FormalizationRefutationProbe & RefutationVerdict)[];
  timedOut: boolean;
};

const frozenJson = (file: string, value: unknown) => writeMathFrozen(file, canonicalMathJson(value) + '\n');

/**
 * Elaborate refuter proofs against the erased candidate in a fresh project. The result
 * can only reject a candidate; `unavailable` (timeout before the harness ran) rejects nothing.
 */
export async function checkFormalizationRefutations(directory: string, source: string, environment: LeanTaskEnvironment,
  probes: readonly FormalizationRefutationProbe[], options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number;
    nonce?: string; library?: FormalizationLibrary }): Promise<FormalizationRefutationCheck> {
  options.signal?.throwIfAborted();
  directory = path.resolve(directory);
  assertMathCanonicalPath(directory);
  if (fs.existsSync(directory)) throw new Error('Formalization refutation needs a fresh directory.');
  source = eraseFormalizationProofs(source);
  const config = getLeanTaskEnvironment(environment), deadlineAt = Date.now() + options.timeoutMs;
  const remaining = () => Math.max(1, deadlineAt - Date.now());
  const nonce = options.nonce ?? crypto.randomBytes(16).toString('hex');
  const project = path.join(directory, 'project');
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  for (const [file, contents] of Object.entries(config.files)) writeMathFrozen(path.join(project, file), contents);
  const libraryPack = options.library ? selectFormalizationLibraryPack(options.library, source) : undefined;
  if (libraryPack) installLibraryPack(project, libraryPack, { trustedFiles: Object.keys(config.files),
    solverOwnedFiles: ['Formalization.lean', 'FormalizationRefutation.lean'] });
  writeMathFrozen(path.join(project, 'Formalization.lean'), source);
  const { query, sentinelFile, resultFiles } = refutationQuery('Formalization', probes, nonce);
  const queryFile = 'FormalizationRefutation.lean';
  writeMathFrozen(path.join(project, queryFile), query);
  let proofEnvironment: Awaited<ReturnType<typeof prepareMathProofEnvironment>> | undefined;
  let diagnostics: Awaited<ReturnType<typeof runLeanDiagnostics>>;
  try {
    let env = resolveMathematicsRuntimeEnvironment(options.env);
    const readiness = checkResolvedLeanToolchainReadiness({ projectRoot: project, env, timeoutMs: Math.min(10_000, remaining()) });
    if (readiness.status !== 'ready') throw new Error('formalization_refutation_harness_failed: Lean toolchain unavailable: ' + readiness.diagnostics);
    const packages = resolveMathematicsLakePackagesCache(project, env);
    const manifest = JSON.parse(config.files['lake-manifest.json']) as { packages: unknown[] };
    if (!packages && manifest.packages.length) throw new Error('formalization_refutation_harness_failed: Lake packages unavailable');
    if (packages) {
      bindLeanPackages(project, packages);
      proofEnvironment = await prepareMathProofEnvironment(project, packages, { env, signal: options.signal, deadlineAt,
        cacheRoot: DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT });
      env = { ...env, [MATH_PROOF_ENVIRONMENT_ENV]: proofEnvironment.environmentValue };
      prepareLeanDiagnosticOverrides(project);
    }
    diagnostics = await runLeanDiagnostics({ projectRoot: project, files: [queryFile], env, signal: options.signal,
      timeoutMs: remaining(), outputLimit: 200_000 });
  } finally {
    await proofEnvironment?.dispose();
  }
  options.signal?.throwIfAborted();
  const read = (relative: string) => {
    const file = path.join(project, relative);
    assertMathCanonicalPath(file);
    return fs.existsSync(file) ? readMathText(file, 1_000_000) : undefined;
  };
  const sentinel = read(sentinelFile);
  const timedOut = Boolean(diagnostics.timedOut);
  frozenJson(path.join(directory, 'diagnostics.json'), diagnostics);
  if (!refutationSentinelHealthy(sentinel, nonce)) {
    // A timeout can end Lean before it reaches the harness; anything else means the harness is broken.
    if (sentinel === undefined && timedOut) {
      const result: FormalizationRefutationCheck = { schema: 'theorem-os.formalization-refutation-check.v1', status: 'unavailable',
        sourceSha256: mathDigest(source), probes: probes.map(probe => ({ ...probe, status: 'not-refuted', reason: 'timed out' })), timedOut };
      frozenJson(path.join(directory, 'refutation.json'), result);
      return result;
    }
    throw new Error('formalization_refutation_harness_failed: sentinel probe ' + (sentinel === undefined ? 'missing' : 'invalid') +
      '\nRefutation diagnostics: ' + directory);
  }
  const result: FormalizationRefutationCheck = { schema: 'theorem-os.formalization-refutation-check.v1', status: 'checked',
    sourceSha256: mathDigest(source), timedOut,
    probes: probes.map((probe, index) => ({ ...probe, ...refutationVerdict(read(resultFiles[index]!), nonce, String(index)) })) };
  frozenJson(path.join(directory, 'refutation.json'), result);
  return result;
}
