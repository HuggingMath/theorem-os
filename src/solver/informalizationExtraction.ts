import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getLeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { bindLeanPackages, prepareLeanDiagnosticOverrides, runLeanDiagnostics } from '../math/leanDiagnostics';
import { renderLeanDiagnosticMessage } from '../math/leanDiagnosticMessages';
import { checkResolvedLeanToolchainReadiness } from '../math/leanToolchainReadiness';
import { MATH_PROOF_ENVIRONMENT_ENV, prepareMathProofEnvironment } from '../math/mathProofEnvironment';
import { resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { canonicalMathJson, readMathText, writeMathFrozen } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import { resolveMathematicsLakePackagesCache } from '../math/verifier';
import { informalizationExtractionQuery, informalizationOutline, type InformalizationOutline } from '../math/informalizationExtraction';
import type { InformalizationRequest, InformalizationSource } from '../math/informalization';

const frozenJson = (file: string, value: unknown) => writeMathFrozen(file, canonicalMathJson(value) + '\n');
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const QUERY_FILE = 'TheoremOSInformalizationQuery.lean';

/**
 * Compile the frozen proof modules in a fresh project of the pinned environment, then
 * read their elaborated declarations with a host query. The proof modules compile in
 * a first pass, before the nonce-bearing query exists; the query pass reuses them.
 */
export async function extractInformalizationOutline(directory: string, request: InformalizationRequest,
  sources: readonly InformalizationSource[], options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number;
    nonce?: string }): Promise<InformalizationOutline> {
  options.signal?.throwIfAborted();
  directory = path.resolve(directory); assertMathCanonicalPath(directory);
  if (fs.existsSync(directory)) throw new Error('informalization_extraction_directory_exists');
  const config = getLeanTaskEnvironment(request.environment);
  const deadlineAt = options.timeoutMs === 0 ? Infinity : Date.now() + options.timeoutMs;
  const remaining = () => {
    options.signal?.throwIfAborted();
    const value = deadlineAt - Date.now();
    if (value <= 0) throw new Error('informalization_extraction_timeout');
    return value;
  };
  const nonce = options.nonce ?? crypto.randomBytes(16).toString('hex');
  const project = path.join(directory, 'project');
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  for (const [file, contents] of Object.entries(config.files)) writeMathFrozen(path.join(project, file), contents);
  for (const source of sources) {
    if (Object.hasOwn(config.files, source.file) || source.file === QUERY_FILE) throw new Error('informalization_source_name_reserved');
    fs.mkdirSync(path.dirname(path.join(project, source.file)), { recursive: true, mode: 0o700 });
    writeMathFrozen(path.join(project, source.file), source.text);
  }
  const { query, resultFile } = informalizationExtractionQuery({ nonce, rootModule: request.rootModule,
    modules: sources.map(source => source.module), target: request.target });
  const rootFile = sources.at(-1)!.file;
  let proofEnvironment: Awaited<ReturnType<typeof prepareMathProofEnvironment>> | undefined;
  try {
    let env = resolveMathematicsRuntimeEnvironment(options.env ?? process.env);
    const readiness = checkResolvedLeanToolchainReadiness({ projectRoot: project, env, timeoutMs: Math.min(10_000, remaining()) });
    if (readiness.status !== 'ready') throw new Error('informalization_lean_toolchain_unavailable: ' + readiness.diagnostics);
    const packages = resolveMathematicsLakePackagesCache(project, env);
    const manifest = JSON.parse(config.files['lake-manifest.json']) as { packages: unknown[] };
    if (!packages && manifest.packages.length) throw new Error('informalization_lake_packages_unavailable');
    if (packages) {
      bindLeanPackages(project, packages);
      proofEnvironment = await prepareMathProofEnvironment(project, packages, { env, signal: options.signal,
        deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : undefined });
      env = { ...env, [MATH_PROOF_ENVIRONMENT_ENV]: proofEnvironment.environmentValue };
      prepareLeanDiagnosticOverrides(project);
    }
    const compile = async (file: string, stage: string) => {
      const diagnostics = await runLeanDiagnostics({ projectRoot: project, files: [file], env, signal: options.signal,
        timeoutMs: remaining(), outputLimit: 200_000 });
      frozenJson(path.join(directory, stage + '-diagnostics.json'), diagnostics);
      options.signal?.throwIfAborted();
      if (diagnostics.timedOut) throw new Error('informalization_extraction_timeout');
      if (diagnostics.exitCode !== 0) {
        const failed = diagnostics.phases.find(phase => phase.exitCode !== 0)?.file ?? file;
        const detail = diagnostics.firstBlocking ? renderLeanDiagnosticMessage(diagnostics.firstBlocking) :
          diagnostics.stderr || diagnostics.stdout || 'Lean did not finish.';
        throw new Error((failed === QUERY_FILE ? 'informalization_extraction_failed: ' :
          `informalization_proof_does_not_compile: ${failed}: `) + detail.slice(0, 4000));
      }
    };
    await compile(rootFile, 'proof');
    writeMathFrozen(path.join(project, QUERY_FILE), query);
    await compile(QUERY_FILE, 'query');
  } finally {
    await proofEnvironment?.dispose();
  }
  const file = path.join(project, resultFile); assertMathCanonicalPath(file);
  if (!fs.existsSync(file)) throw new Error('informalization_extraction_failed: the query wrote no result');
  let outline: InformalizationOutline;
  try { outline = informalizationOutline(JSON.parse(readMathText(file, 64_000_000)), { nonce, target: request.target, sources }); }
  catch (cause) {
    const message = errorText(cause);
    throw /^informalization_(?:proof|declaration)_/u.test(message) ? cause : new Error('informalization_extraction_failed: ' + message);
  }
  frozenJson(path.join(directory, 'outline.json'), outline);
  return outline;
}
