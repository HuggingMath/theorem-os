import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { LAKE_CONFIGURATION_FILES } from './mathConstructionSources';
import { bindLeanPackages, prepareLeanDiagnosticOverrides, runLeanDiagnostics } from './leanDiagnostics';
import { renderLeanDiagnosticMessage } from './leanDiagnosticMessages';
import { leanLibrarySymbolCommands } from './leanLibrarySymbolsProgram';
import { leanDiagnosticEnvironmentIdentity } from './leanResidualGoals';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from './leanTaskEnvironment';
import { checkResolvedLeanToolchainReadiness } from './leanToolchainReadiness';
import { MATH_PROOF_ENVIRONMENT_ENV, prepareMathProofEnvironment } from './mathProofEnvironment';
import { resolveMathematicsRuntimeEnvironment } from './mathRuntimeEnvironment';
import { canonicalMathJson, mathDigest, readMathText, writeMathFrozen } from './mathRuntimeIo';
import { assertMathCanonicalPath } from './paths';
import { resolveMathematicsLakePackagesCache } from './verifier';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const name = z.string().min(1).refine(value => Buffer.from(value, 'utf8').toString('utf8') === value);
const fullType = z.string().refine(value => value.trim().length > 0 && !value.includes('⋯'));
const symbol = z.discriminatedUnion('exists', [
  z.object({ name, exists: z.literal(false) }).strict(),
  z.object({ name, exists: z.literal(true), module: z.string(),
    kind: z.enum(['definition', 'theorem', 'opaque', 'axiom', 'inductive', 'constructor', 'recursor', 'quotient']),
    class: z.boolean(), structure: z.boolean(), type: fullType,
    fields: z.array(z.object({ name, type: fullType }).strict()),
  }).strict(),
]);

export const leanLibrarySymbolsSchema = z.object({
  schema: z.literal('theorem-os.lean-library-symbols.v1'), authority: z.literal('advisory-lean-process'),
  environment: z.enum(['standard', 'mathlib', 'mathlib-4.8']), environmentDigest: digest,
  toolchain: z.string().min(1), mathlibRevision: z.string().regex(/^[a-f0-9]{40}$/u).nullable(),
  querySha256: digest, symbolsSha256: digest,
  observation: z.object({ sourceDigest: digest, environmentDigest: digest, toolIdentity: digest }).strict(),
  symbols: z.array(symbol),
}).strict();
export type LeanLibrarySymbols = z.infer<typeof leanLibrarySymbolsSchema>;

/** Validates advisory payload binding; matching hashes do not authenticate a proof or a library. */
export function assertLeanLibrarySymbols(environment: LeanTaskEnvironment, names: readonly string[], value: unknown): LeanLibrarySymbols {
  const parsed = leanLibrarySymbolsSchema.safeParse(value);
  if (!parsed.success) throw new Error('lean_library_symbols_invalid');
  const result = parsed.data, config = getLeanTaskEnvironment(environment);
  if (result.environment !== environment || result.environmentDigest !== config.dependencyDigest ||
      result.toolchain !== config.toolchain || result.mathlibRevision !== (config.mathlibRevision ?? null))
    throw new Error('lean_library_symbols_environment_changed');
  if (result.querySha256 !== mathDigest(leanLibrarySymbolCommands(names, environment)))
    throw new Error('lean_library_symbols_query_changed');
  if (result.symbols.length !== names.length || result.symbols.some((item, index) => item.name !== names[index]))
    throw new Error('lean_library_symbols_names_changed');
  if (result.symbolsSha256 !== mathDigest(canonicalMathJson(result.symbols)))
    throw new Error('lean_library_symbols_results_changed');
  if (result.symbols.some(item => item.exists && ((!item.structure && item.fields.length > 0) ||
      new Set(item.fields.map(field => field.name)).size !== item.fields.length)))
    throw new Error('lean_library_symbols_fields_invalid');
  return result;
}

type LookupOptions = { env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number; proofEnvironmentCacheRoot?: string };
const queryFile = 'LibrarySymbols.lean';
const frozenJson = (file: string, value: unknown) => writeMathFrozen(file, canonicalMathJson(value) + '\n');
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

const referenceSchema = z.object({ path: z.string(), digest, sourceDigest: digest, environmentDigest: digest,
  captureComplete: z.literal(true) });
const sourceFileSchema = z.object({ file: z.string(), digest });
const latestSchema = z.object({ schema: z.literal('theoremos.lean-diagnostics-latest.v1'),
  authority: z.literal('advisory-lean-process'), sourceDigest: digest, environmentDigest: digest, toolIdentity: digest,
  requestedFiles: z.array(z.string()), configuration: z.array(z.object({ file: z.string(), digest: digest.nullable() })),
  sourceFiles: z.array(sourceFileSchema), exitCode: z.literal(0), timedOut: z.literal(false), aborted: z.literal(false),
  diagnosticArtifacts: z.array(referenceSchema).length(1) });
const artifactSchema = z.object({ schema: z.literal('theoremos.lean-diagnostics.v1'), authority: z.literal('advisory-lean-process'),
  sourceDigest: digest, environmentDigest: digest, toolIdentity: digest, sourceCurrent: z.literal(true),
  file: z.literal(queryFile), sourceFiles: z.array(sourceFileSchema), exitCode: z.literal(0),
  timedOut: z.literal(false), aborted: z.literal(false), captureComplete: z.literal(true),
  stdout: z.string(), stderr: z.string(), stdoutSha256: digest, stderrSha256: digest });

/** One fresh, pinned Lean process answers the entire exact-name batch. Failures never become empty hints. */
export async function lookupLeanLibrarySymbols(directory: string, names: readonly string[], environment: LeanTaskEnvironment,
  options: LookupOptions): Promise<LeanLibrarySymbols> {
  options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0)
    throw new Error('lean_library_symbols_timeout_invalid');
  const config = getLeanTaskEnvironment(environment), query = leanLibrarySymbolCommands(names, environment);
  const querySha256 = mathDigest(query);
  directory = path.resolve(directory);
  assertMathCanonicalPath(directory);
  if (fs.existsSync(directory)) throw new Error('Lean library symbol lookup needs a fresh directory.');
  const deadlineAt = options.timeoutMs === 0 ? Infinity : Date.now() + options.timeoutMs;
  const remaining = () => {
    options.signal?.throwIfAborted();
    const value = deadlineAt - Date.now();
    if (value <= 0) throw new Error('lean_library_symbols_timeout');
    return value;
  };
  const project = path.join(directory, 'project');
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  for (const [file, contents] of Object.entries(config.files)) writeMathFrozen(path.join(project, file), contents);
  writeMathFrozen(path.join(project, queryFile), query);
  frozenJson(path.join(directory, 'query.json'), { schema: 'theorem-os.lean-library-symbol-query.v1', names: [...names],
    environment, environmentDigest: config.dependencyDigest, toolchain: config.toolchain,
    mathlibRevision: config.mathlibRevision ?? null, querySha256 });
  let proofEnvironment: Awaited<ReturnType<typeof prepareMathProofEnvironment>> | undefined;
  let diagnostics: Awaited<ReturnType<typeof runLeanDiagnostics>> | undefined;
  try {
    try {
      let env = resolveMathematicsRuntimeEnvironment(options.env);
      const readiness = checkResolvedLeanToolchainReadiness({ projectRoot: project, env, timeoutMs: Math.min(10_000, remaining()) });
      frozenJson(path.join(directory, 'toolchain-readiness.json'), readiness);
      if (readiness.status !== 'ready') throw new Error('lean_library_symbols_toolchain_unavailable: ' + readiness.diagnostics);
      const packages = resolveMathematicsLakePackagesCache(project, env);
      if (!packages && (JSON.parse(config.files['lake-manifest.json']) as { packages: unknown[] }).packages.length)
        throw new Error('lean_library_symbols_lake_packages_unavailable');
      if (packages) {
        bindLeanPackages(project, packages);
        proofEnvironment = await prepareMathProofEnvironment(project, packages, { env, signal: options.signal,
          deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : undefined, cacheRoot: options.proofEnvironmentCacheRoot });
        env = { ...env, [MATH_PROOF_ENVIRONMENT_ENV]: proofEnvironment.environmentValue };
        prepareLeanDiagnosticOverrides(project);
      }
      const identity = leanDiagnosticEnvironmentIdentity(project, env);
      if (!identity.toolIdentity) throw new Error('lean_library_symbols_tool_identity_unavailable');
      const configuration = LAKE_CONFIGURATION_FILES.map(file => ({ file,
        digest: fs.existsSync(path.join(project, file)) ? mathDigest(readMathText(path.join(project, file))) : null }));
      const sourceFiles = [{ file: queryFile, digest: querySha256 }];
      const sourceDigest = mathDigest(JSON.stringify([configuration.map(item => item.digest ?? ''),
        sourceFiles.map(item => [item.file, item.digest])]));
      diagnostics = await runLeanDiagnostics({ projectRoot: project, files: [queryFile], env, signal: options.signal,
        timeoutMs: remaining(), outputLimit: 1_000_000 });
      frozenJson(path.join(directory, 'diagnostics.json'), diagnostics);
      if (diagnostics.exitCode !== 0 || diagnostics.timedOut || ('aborted' in diagnostics && diagnostics.aborted)) {
        const detail = diagnostics.firstBlocking ? renderLeanDiagnosticMessage(diagnostics.firstBlocking) :
          [diagnostics.stdout, diagnostics.stderr].filter(Boolean).join('\n') || 'Lean did not finish.';
        throw new Error('lean_library_symbols_diagnostics_failed: ' + detail);
      }
      remaining();
      const latestText = readMathText(path.join(project, '.lake/lean-diagnostics-latest.json'));
      writeMathFrozen(path.join(directory, 'diagnostics-latest.json'), latestText);
      const parsedLatest = latestSchema.safeParse(JSON.parse(latestText));
      if (!parsedLatest.success) throw new Error('lean_library_symbols_diagnostic_receipt_invalid');
      const latest = parsedLatest.data;
      if (latest.sourceDigest !== sourceDigest || latest.environmentDigest !== identity.environmentDigest ||
          latest.toolIdentity !== identity.toolIdentity || diagnostics.sourceDigest !== sourceDigest ||
          diagnostics.environmentDigest !== identity.environmentDigest || canonicalMathJson(latest.configuration) !== canonicalMathJson(configuration) ||
          canonicalMathJson(latest.sourceFiles) !== canonicalMathJson(sourceFiles) ||
          canonicalMathJson(latest.requestedFiles) !== canonicalMathJson([queryFile]) ||
          canonicalMathJson(latest.diagnosticArtifacts) !== canonicalMathJson(diagnostics.diagnosticArtifacts))
        throw new Error('lean_library_symbols_diagnostic_receipt_changed');
      const reference = latest.diagnosticArtifacts[0];
      if (reference.path !== `.lake/diagnostic-artifacts/${reference.digest}.json` || reference.sourceDigest !== sourceDigest ||
          reference.environmentDigest !== identity.environmentDigest)
        throw new Error('lean_library_symbols_diagnostic_receipt_invalid');
      const artifactText = readMathText(path.join(project, reference.path));
      if (mathDigest(artifactText) !== reference.digest) throw new Error('lean_library_symbols_diagnostic_artifact_changed');
      fs.mkdirSync(path.join(directory, 'diagnostic-artifacts'), { mode: 0o700 });
      writeMathFrozen(path.join(directory, 'diagnostic-artifacts', `${reference.digest}.json`), artifactText);
      const parsedArtifact = artifactSchema.safeParse(JSON.parse(artifactText));
      if (!parsedArtifact.success) throw new Error('lean_library_symbols_diagnostic_artifact_invalid');
      const artifact = parsedArtifact.data;
      if (artifact.sourceDigest !== sourceDigest || artifact.environmentDigest !== identity.environmentDigest ||
          artifact.toolIdentity !== identity.toolIdentity || canonicalMathJson(artifact.sourceFiles) !== canonicalMathJson(sourceFiles) ||
          mathDigest(artifact.stdout) !== artifact.stdoutSha256 || mathDigest(artifact.stderr) !== artifact.stderrSha256)
        throw new Error('lean_library_symbols_diagnostic_artifact_invalid');
      if (readMathText(path.join(project, queryFile)) !== query ||
          Object.entries(config.files).some(([file, contents]) => readMathText(path.join(project, file)) !== contents) ||
          configuration.some(item => (fs.existsSync(path.join(project, item.file)) ? mathDigest(readMathText(path.join(project, item.file))) : null) !== item.digest) ||
          canonicalMathJson(leanDiagnosticEnvironmentIdentity(project, env)) !== canonicalMathJson(identity))
        throw new Error('lean_library_symbols_execution_changed');
      const symbols = JSON.parse(readMathText(path.join(project, '.lake/library-symbols.json')));
      const result = assertLeanLibrarySymbols(environment, names, {
        schema: 'theorem-os.lean-library-symbols.v1', authority: 'advisory-lean-process',
        environment, environmentDigest: config.dependencyDigest, toolchain: config.toolchain, mathlibRevision: config.mathlibRevision ?? null,
        querySha256, symbolsSha256: mathDigest(canonicalMathJson(symbols)),
        observation: { sourceDigest, environmentDigest: identity.environmentDigest, toolIdentity: identity.toolIdentity }, symbols,
      });
      // Keep the validated export immutable even though Lean originally wrote the process output.
      fs.chmodSync(path.join(project, '.lake/library-symbols.json'), 0o400);
      frozenJson(path.join(directory, 'library-symbols.json'), result);
      return result;
    } finally { await proofEnvironment?.dispose(); }
  } catch (cause) {
    frozenJson(path.join(directory, 'failure.json'), { schema: 'theorem-os.lean-library-symbol-failure.v1',
      authority: 'advisory-lean-process', querySha256, environment, environmentDigest: config.dependencyDigest,
      error: errorText(cause), diagnostics });
    throw new Error(`${errorText(cause)}\nLibrary symbol diagnostics: ${directory}`, { cause });
  }
}
