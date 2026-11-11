import fs from 'node:fs';
import path from 'node:path';
import { eraseFormalizationProofs, formalizationTargets } from '../math/formalizationSource';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { bindLeanPackages, prepareLeanDiagnosticOverrides, runLeanDiagnostics } from '../math/leanDiagnostics';
import { renderLeanDiagnosticMessage } from '../math/leanDiagnosticMessages';
import { leanStatementContextCommands, parseLeanStatementContexts } from '../math/leanStatementContext';
import { checkResolvedLeanToolchainReadiness } from '../math/leanToolchainReadiness';
import { MATH_PROOF_ENVIRONMENT_ENV, prepareMathProofEnvironment } from '../math/mathProofEnvironment';
import { DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT } from '../math/mathProofEnvironmentCache';
import { resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { canonicalMathJson, mathDigest, readMathFile, readMathText, writeMathFrozen } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import { resolveMathematicsLakePackagesCache } from '../math/verifier';
import { selectFormalizationLibraryPack, type FormalizationLibrary } from '../math/formalizationLibrary';
import { installLibraryPack } from '../math/libraryPacks';

type ElaborationOptions = {
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  proofEnvironmentCacheRoot?: string;
  library?: FormalizationLibrary;
  /** Export explicit elaborated terms and the top-level binder dependency graph. */
  detailedContext?: boolean;
  /** Export raw/kernel types and the local definition meaning closure. */
  semanticContext?: boolean;
  /** Include direct fields and parent projections for statement structure constants. */
  structureContext?: boolean;
  /** kernel-v3: record imported structure overflow as omitted instead of failing the export. */
  boundedLibraryContext?: boolean;
};

export type FormalizationElaboration = {
  source: string;
  sourceSha256: string;
  environmentDigest: string;
  targets: { name: string; declarationHash: string }[];
  snapshot: object;
  snapshotDigest: string;
  compilation: {
    exitCode: 0;
    timedOut: false;
    sourceSha256: string;
    environmentDigest: string;
    diagnostics: unknown;
  };
};

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const frozenJson = (file: string, value: unknown) => writeMathFrozen(file, canonicalMathJson(value) + '\n');

/** Compile only host-erased declarations. Neither this process nor its output is proof acceptance. */
export async function elaborateFormalization(directory: string, source: string, environment: LeanTaskEnvironment,
  options: ElaborationOptions): Promise<FormalizationElaboration> {
  options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0)
    throw new Error('formalization_elaboration_timeout_invalid');
  directory = path.resolve(directory);
  assertMathCanonicalPath(directory);
  if (fs.existsSync(directory)) throw new Error('Formalization elaboration needs a fresh directory.');
  const config = getLeanTaskEnvironment(environment);
  // No generated proof or comment is allowed into compilation or the blind snapshot.
  source = eraseFormalizationProofs(source);
  const targets = formalizationTargets(source);
  const sourceSha256 = mathDigest(source);
  const deadlineAt = options.timeoutMs === 0 ? Infinity : Date.now() + options.timeoutMs;
  const remaining = () => {
    options.signal?.throwIfAborted();
    const value = deadlineAt - Date.now();
    if (value <= 0) throw new Error('formalization_elaboration_timeout');
    return value;
  };
  const project = path.join(directory, 'project');
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  for (const [file, contents] of Object.entries(config.files)) writeMathFrozen(path.join(project, file), contents);
  const libraryPack = options.library ? selectFormalizationLibraryPack(options.library, source) : undefined;
  const libraryFiles = libraryPack ? installLibraryPack(project, libraryPack, { trustedFiles: Object.keys(config.files),
    solverOwnedFiles: ['Formalization.lean', 'FormalizationContext.lean'] }) : {};
  writeMathFrozen(path.join(project, 'Formalization.lean'), source);
  const queryFile = 'FormalizationContext.lean', contextFile = '.lake/formalization-context.json';
  const query = 'import Lean\nimport Formalization\n' + leanStatementContextCommands(
    targets.map(target => ({ id: target.name, name: target.name })),
    [{ module: 'Formalization', file: 'Formalization.lean' }], contextFile,
    { detailedContext: options.detailedContext, semanticContext: options.semanticContext,
      structureContext: options.structureContext,
      ...(options.boundedLibraryContext === true ? { boundedLibraryContext: true } : {}) }) + '\n';
  writeMathFrozen(path.join(project, queryFile), query);
  let proofEnvironment: Awaited<ReturnType<typeof prepareMathProofEnvironment>> | undefined;
  let diagnostics: Awaited<ReturnType<typeof runLeanDiagnostics>> | undefined;
  try {
    let compiled: FormalizationElaboration;
    try {
      let env = resolveMathematicsRuntimeEnvironment(options.env);
      const readiness = checkResolvedLeanToolchainReadiness({ projectRoot: project, env, timeoutMs: Math.min(10_000, remaining()) });
      frozenJson(path.join(directory, 'toolchain-readiness.json'), readiness);
      if (readiness.status !== 'ready') throw new Error('formalization_lean_toolchain_unavailable: ' + readiness.diagnostics);
      const packages = resolveMathematicsLakePackagesCache(project, env);
      const manifest = JSON.parse(config.files['lake-manifest.json']) as { packages: unknown[] };
      if (!packages && manifest.packages.length) throw new Error('formalization_lake_packages_unavailable');
      if (packages) {
        bindLeanPackages(project, packages);
        // Reuse the language roles' private image; preparation still verifies and
        // mounts an independent sealed copy for this compilation.
        proofEnvironment = await prepareMathProofEnvironment(project, packages, { env, signal: options.signal,
          deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : undefined,
          cacheRoot: options.proofEnvironmentCacheRoot ?? DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT });
        env = { ...env, [MATH_PROOF_ENVIRONMENT_ENV]: proofEnvironment.environmentValue };
        prepareLeanDiagnosticOverrides(project);
      }
      diagnostics = await runLeanDiagnostics({ projectRoot: project, files: [queryFile], env, signal: options.signal,
        timeoutMs: remaining(), outputLimit: 1_000_000 });
      frozenJson(path.join(directory, 'diagnostics.json'), diagnostics);
      if (diagnostics.exitCode !== 0 || diagnostics.timedOut || ('aborted' in diagnostics && diagnostics.aborted) || options.signal?.aborted) {
        const detail = diagnostics.firstBlocking ? renderLeanDiagnosticMessage(diagnostics.firstBlocking) :
          diagnostics.stderr || diagnostics.stdout || 'Lean did not finish elaborating the declarations.';
        throw new Error('formalization_elaboration_failed: ' + detail.slice(0, 2000));
      }
      const latest = JSON.parse(readMathText(path.join(project, '.lake/lean-diagnostics-latest.json'), 4_000_000));
      if (latest.schema !== 'theoremos.lean-diagnostics-latest.v1' || latest.authority !== 'advisory-lean-process' ||
          latest.sourceDigest !== diagnostics.sourceDigest || latest.environmentDigest !== diagnostics.environmentDigest ||
          !/^[a-f0-9]{64}$/u.test(latest.toolIdentity ?? '') || latest.exitCode !== 0 || latest.timedOut || latest.aborted ||
          !Array.isArray(latest.sourceFiles) || !latest.sourceFiles.some((file: { file?: string; digest?: string }) =>
            file.file === 'Formalization.lean' && file.digest === sourceSha256) ||
          !diagnostics.diagnosticArtifacts?.length)
        throw new Error('formalization_compilation_evidence_invalid');
      const artifactRecords: { digest: string; text: string }[] = [];
      let artifactBytes = 0;
      const artifacts = diagnostics.diagnosticArtifacts.map(reference => {
        if (!/^[a-f0-9]{64}$/u.test(reference.digest) || reference.path !== `.lake/diagnostic-artifacts/${reference.digest}.json` ||
            reference.sourceDigest !== diagnostics!.sourceDigest || reference.environmentDigest !== diagnostics!.environmentDigest ||
            reference.captureComplete !== true) throw new Error('formalization_compilation_evidence_incomplete');
        const file = path.join(project, reference.path);
        assertMathCanonicalPath(file);
        const bytes = readMathFile(file, 32_000_000).bytes;
        if (mathDigest(bytes) !== reference.digest) throw new Error('formalization_compilation_evidence_changed');
        const artifact = JSON.parse(bytes.toString('utf8'));
        if (artifact.schema !== 'theoremos.lean-diagnostics.v1' || artifact.authority !== 'advisory-lean-process' ||
            artifact.sourceDigest !== diagnostics!.sourceDigest || artifact.environmentDigest !== diagnostics!.environmentDigest ||
            artifact.toolIdentity !== latest.toolIdentity || artifact.sourceCurrent !== true || artifact.exitCode !== 0 ||
            artifact.timedOut || artifact.aborted || artifact.captureComplete !== true ||
            canonicalMathJson(artifact.sourceFiles) !== canonicalMathJson(latest.sourceFiles) ||
            mathDigest(artifact.stdout) !== artifact.stdoutSha256 || mathDigest(artifact.stderr) !== artifact.stderrSha256)
          throw new Error('formalization_compilation_evidence_invalid');
        artifactBytes += bytes.length;
        if (artifactBytes > 8_000_000) throw new Error('formalization_compilation_evidence_incomplete');
        artifactRecords.push({ digest: reference.digest, text: bytes.toString('utf8') });
        const relative = `compilation-artifacts/${reference.digest}.json`;
        fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true, mode: 0o700 });
        writeMathFrozen(path.join(directory, relative), bytes.toString('utf8'));
        return { ...reference, path: relative };
      });
      if (readMathText(path.join(project, 'Formalization.lean')) !== source || readMathText(path.join(project, queryFile)) !== query ||
          Object.entries(libraryFiles).some(([file, digest]) => mathDigest(readMathText(path.join(project, file))) !== digest) ||
          Object.entries(config.files).some(([file, contents]) => readMathText(path.join(project, file)) !== contents))
        throw new Error('formalization_compilation_source_changed');
      const contextPath = path.join(project, contextFile);
      assertMathCanonicalPath(contextPath);
      const contextText = readMathText(contextPath, 4_000_000);
      const contexts = parseLeanStatementContexts(contextText, targets.map(target => target.name), options);
      if ((options.detailedContext === true || options.structureContext === true) && [...contexts.values()].some(context => !context.bindings))
        throw new Error('formalization_detailed_context_missing');
      if ((options.semanticContext === true || options.structureContext === true) && [...contexts.values()].some(context => !context.semantic))
        throw new Error('formalization_semantic_context_missing');
      if (options.structureContext === true && [...contexts.values()].some(context => !context.structures))
        throw new Error('formalization_structure_context_missing');
      const snapshot = { schema: 'theorem-os.formalization-snapshot.v1', source, sourceSha256,
        environment, environmentDigest: config.dependencyDigest,
        targets: targets.map(target => ({ ...target, context: contexts.get(target.name)! })) };
      const evidence = { ...diagnostics, ...(libraryPack ? { libraryPack } : {}),
        toolIdentity: latest.toolIdentity, latest, diagnosticArtifacts: artifacts, artifactRecords,
        contextExport: { path: contextFile, digest: mathDigest(contextText), text: contextText } };
      if (Buffer.byteLength(canonicalMathJson(evidence)) > 8_000_000) throw new Error('formalization_compilation_evidence_incomplete');
      compiled = { source, sourceSha256, environmentDigest: config.dependencyDigest, targets, snapshot,
        snapshotDigest: mathDigest(canonicalMathJson(snapshot)),
        compilation: { exitCode: 0, timedOut: false, sourceSha256,
          environmentDigest: diagnostics.environmentDigest, diagnostics: evidence } };
    } finally {
      await proofEnvironment?.dispose();
    }
    frozenJson(path.join(directory, 'elaboration.json'), compiled);
    return compiled;
  } catch (cause) {
    frozenJson(path.join(directory, 'failure.json'), { schema: 'theorem-os.formalization-elaboration-failure.v1',
      authority: 'advisory-lean-process', sourceSha256, environment, environmentDigest: config.dependencyDigest,
      error: errorText(cause), diagnostics });
    throw new Error(`${errorText(cause)}\nElaboration diagnostics: ${directory}`, { cause });
  }
}
