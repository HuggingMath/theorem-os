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
import { attachInformalizationGoals, informalizationExtractionQuery, informalizationGoalsQuery, informalizationOutline,
  type InformalizationGoalsResult, type InformalizationOutline } from '../math/informalizationExtraction';
import type { InformalizationRequest, InformalizationSource } from '../math/informalization';

const frozenJson = (file: string, value: unknown) => writeMathFrozen(file, canonicalMathJson(value) + '\n');
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const QUERY_FILE = 'TheoremOSInformalizationQuery.lean';
const goalsQueryFile = (index: number) => `TheoremOSInformalizationGoals${index}.lean`;
const RESERVED = /^TheoremOSInformalization(?:Query|Goals\d+)\.lean$/u;
/** The goals pass is advisory: each file gets at most this long, and a failure leaves the outline without goals. */
const GOALS_TIMEOUT_MS = 30 * 60_000;

/**
 * Compile the frozen proof modules in a fresh project of the pinned environment, then
 * read their elaborated declarations with a host query. The proof modules compile in
 * a first pass, before the nonce-bearing query exists; the query pass reuses them.
 * A last pass elaborates each proof file again for the goals before and after its tactics.
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
    if (Object.hasOwn(config.files, source.file) || RESERVED.test(source.file)) throw new Error('informalization_source_name_reserved');
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
    const file = path.join(project, resultFile); assertMathCanonicalPath(file);
    if (!fs.existsSync(file)) throw new Error('informalization_extraction_failed: the query wrote no result');
    let outline: InformalizationOutline;
    try { outline = informalizationOutline(JSON.parse(readMathText(file, 64_000_000)), { nonce, target: request.target, sources }); }
    catch (cause) {
      const message = errorText(cause);
      throw /^informalization_(?:proof|declaration)_/u.test(message) ? cause : new Error('informalization_extraction_failed: ' + message);
    }
    const goals = async (source: InformalizationSource, index: number): Promise<InformalizationGoalsResult> => {
      const failed = (reason: string) => ({ module: source.module, failure: [...reason].slice(0, 2000).join('') });
      const timeoutMs = Math.min(GOALS_TIMEOUT_MS, deadlineAt - Date.now());
      if (timeoutMs < 1000) return failed('informalization_goals_timeout');
      try {
        const { query: text, resultFile: report } = informalizationGoalsQuery({ nonce, module: source.module, file: source.file, index });
        writeMathFrozen(path.join(project, goalsQueryFile(index)), text);
        const diagnostics = await runLeanDiagnostics({ projectRoot: project, files: [goalsQueryFile(index)], env, signal: options.signal,
          timeoutMs, outputLimit: 200_000 });
        frozenJson(path.join(directory, `goals-${index}-diagnostics.json`), diagnostics);
        options.signal?.throwIfAborted();
        if (diagnostics.timedOut) return failed('informalization_goals_timeout');
        if (diagnostics.exitCode !== 0) return failed('informalization_goals_failed: ' + (diagnostics.firstBlocking ?
          renderLeanDiagnosticMessage(diagnostics.firstBlocking) : diagnostics.stderr || diagnostics.stdout || 'Lean did not finish.'));
        const written = path.join(project, report); assertMathCanonicalPath(written);
        if (!fs.existsSync(written)) return failed('informalization_goals_failed: the query wrote no result');
        return { module: source.module, report: JSON.parse(readMathText(written, 64_000_000)) };
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        return failed('informalization_goals_failed: ' + errorText(cause));
      }
    };
    const results: InformalizationGoalsResult[] = [];
    for (const [index, source] of sources.entries()) results.push(await goals(source, index));
    outline = attachInformalizationGoals(outline, results, { nonce, sources });
    frozenJson(path.join(directory, 'outline.json'), outline);
    return outline;
  } finally {
    await proofEnvironment?.dispose();
  }
}
