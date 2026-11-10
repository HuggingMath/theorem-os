import fs from 'node:fs';
import path from 'node:path';
import { assertFormalizationReferenceResult, formalizationIdentityReferenceFiles, formalizationReferenceFiles, formalizationReferenceInputSchema,
  FORMALIZATION_REFERENCE_QUERY, FORMALIZATION_REFERENCE_REPORT, type FormalizationReferenceInput,
  type FormalizationReferenceResult, type CurrentFormalizationReferenceResult } from '../math/formalizationReference';
import { bindLeanPackages, prepareLeanDiagnosticOverrides, runLeanDiagnostics } from '../math/leanDiagnostics';
import { getLeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { checkResolvedLeanToolchainReadiness } from '../math/leanToolchainReadiness';
import { MATH_PROOF_ENVIRONMENT_ENV, prepareMathProofEnvironment } from '../math/mathProofEnvironment';
import { DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT } from '../math/mathProofEnvironmentCache';
import { resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { canonicalMathJson, mathDigest, readMathFile, readMathText, writeMathFrozen } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import { resolveMathematicsLakePackagesCache } from '../math/verifier';

type ReferenceOptions = { env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number; proofEnvironmentCacheRoot?: string };
type ReferenceExecution = { deadlineAt: number; proofEnvironment?: Awaited<ReturnType<typeof prepareMathProofEnvironment>> };
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const frozenJson = (file: string, value: unknown) => writeMathFrozen(file, canonicalMathJson(value) + '\n');

/**
 * Conservative structural/representation correspondence, not a natural-language fidelity claim.
 * No input theorem proof is compiled and no source theorem is admitted. The only hypothesis
 * in a generated comparison proof is the explicit opposite-proposition argument.
 */
export async function compareFormalizationReference(directory: string, input: FormalizationReferenceInput,
  options: ReferenceOptions): Promise<FormalizationReferenceResult> {
  input = formalizationReferenceInputSchema.parse(input);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0)
    throw new Error('formalization_reference_timeout_invalid');
  directory = path.resolve(directory);
  assertMathCanonicalPath(directory);
  if (fs.existsSync(directory)) throw new Error('Formalization reference comparison needs a fresh directory.');
  const execution: ReferenceExecution = { deadlineAt: options.timeoutMs === 0 ? Infinity : Date.now() + options.timeoutMs };
  let result: FormalizationReferenceResult;
  try {
    if (input.purpose !== 'task-fidelity-v2') return await referenceAttempt(directory, input, options, execution, false);
    // Reject a malformed mapping before creating even the parent attempt directory.
    try { formalizationIdentityReferenceFiles(input); } catch (cause) {
      if (errorText(cause) === 'reference_target_mapping_incomplete') throw cause;
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    result = await referenceAttempt(path.join(directory, 'identity'), input, options, execution, true);
    // Every target must pass the same strict check. A fallback is a complete new
    // comparison with its own files and receipts, sharing only the total deadline
    // and the already checked, identically configured dependency environment.
    if (result.status !== 'established' && !options.signal?.aborted &&
        result.reason !== 'formalization_reference_aborted' && Date.now() < execution.deadlineAt)
      result = await referenceAttempt(path.join(directory, 'correspondence'), input, options, execution, false);
  } finally { await execution.proofEnvironment?.dispose(); }
  frozenJson(path.join(directory, 'comparison.json'), result);
  return result;
}

async function referenceAttempt(directory: string, input: FormalizationReferenceInput, options: ReferenceOptions,
  execution: ReferenceExecution, identityOnly: boolean): Promise<FormalizationReferenceResult> {
  // A malformed target mapping is a caller error, not an unsupported source.
  let files: Record<string, string> | undefined, preparationError: unknown;
  try { files = identityOnly ? formalizationIdentityReferenceFiles(input) : formalizationReferenceFiles(input); } catch (cause) {
    if (errorText(cause) === 'reference_target_mapping_incomplete') throw cause;
    preparationError = cause;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const config = getLeanTaskEnvironment(input.environment), deadlineAt = execution.deadlineAt;
  const remaining = () => {
    options.signal?.throwIfAborted();
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error('formalization_reference_timeout');
    return remainingMs;
  };
  const unknownPairs = (reason: string) => input.pairs.map(pair => ({ ...pair,
    candidateToReference: { status: 'not-established' as const, reason },
    referenceToCandidate: { status: 'not-established' as const, reason } }));
  let result: CurrentFormalizationReferenceResult = {
    ...(identityOnly ? {
      schema: 'theoremos.formalization-reference.v7' as const, method: 'definitional-identity-v1' as const,
    } : input.purpose === 'task-fidelity-v2' ? {
      schema: 'theoremos.formalization-reference.v6' as const, method: 'cardinality-correspondence-v7' as const,
    } : {
      schema: 'theoremos.formalization-reference.v4' as const, method: 'cardinality-correspondence-v5' as const,
    }),
    authority: 'advisory-lean-process', status: 'not-established', check: 'unavailable', proofVerified: false,
    semanticEquivalenceClaimed: false, modelInvoked: false, inputDigest: mathDigest(canonicalMathJson(input)),
    candidateSourceSha256: mathDigest(input.candidateSource), referenceSourceSha256: mathDigest(input.referenceSource),
    environment: input.environment, environmentDigest: config.dependencyDigest,
    limits: { timeoutMs: options.timeoutMs, maxPairs: 16, maxHeartbeats: 100000 },
    pairs: unknownPairs('not-run'), files: [],
  };
  try {
    if (!files) { result.check = 'unsupported'; throw preparationError; }
    result.files = Object.entries(files).map(([file, text]) => ({ file, text, sha256: mathDigest(text) }));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project, { mode: 0o700 });
    for (const [file, contents] of Object.entries(files)) writeMathFrozen(path.join(project, file), contents);
    let env = resolveMathematicsRuntimeEnvironment(options.env);
    const readiness = checkResolvedLeanToolchainReadiness({ projectRoot: project, env, timeoutMs: Math.min(10000, remaining()) });
    frozenJson(path.join(directory, 'toolchain-readiness.json'), readiness);
    if (readiness.status !== 'ready') throw new Error('formalization_reference_toolchain_unavailable');
    const packages = resolveMathematicsLakePackagesCache(project, env);
    const manifest = JSON.parse(config.files['lake-manifest.json']) as { packages: unknown[] };
    if (!packages && manifest.packages.length) throw new Error('formalization_reference_packages_unavailable');
    if (packages) {
      bindLeanPackages(project, packages);
      execution.proofEnvironment ??= await prepareMathProofEnvironment(project, packages, { env, signal: options.signal,
        deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : undefined,
        cacheRoot: options.proofEnvironmentCacheRoot ?? DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT });
      env = { ...env, [MATH_PROOF_ENVIRONMENT_ENV]: execution.proofEnvironment.environmentValue };
      prepareLeanDiagnosticOverrides(project);
    }
    const diagnostics = await runLeanDiagnostics({ projectRoot: project, files: [FORMALIZATION_REFERENCE_QUERY],
      env, signal: options.signal, timeoutMs: remaining(), outputLimit: 1000000 });
    frozenJson(path.join(directory, 'diagnostics.json'), diagnostics);
    if (diagnostics.timedOut) throw new Error('formalization_reference_timeout');
    if ('aborted' in diagnostics && diagnostics.aborted || options.signal?.aborted) throw new Error('formalization_reference_aborted');
    if (diagnostics.exitCode !== 0) throw new Error('formalization_reference_compilation_failed');
    if (!diagnostics.diagnosticArtifacts?.length) throw new Error('formalization_reference_evidence_missing');
    const latest = JSON.parse(readMathText(path.join(project, '.lake/lean-diagnostics-latest.json'), 4000000));
    const artifacts = diagnostics.diagnosticArtifacts.map(reference => {
      if (!/^[a-f0-9]{64}$/u.test(reference.digest) || reference.path !== `.lake/diagnostic-artifacts/${reference.digest}.json`)
        throw new Error('formalization_reference_evidence_invalid');
      const artifactFile = path.join(project, reference.path);
      assertMathCanonicalPath(artifactFile);
      const text = readMathFile(artifactFile, 4000000).bytes.toString('utf8');
      if (mathDigest(text) !== reference.digest) throw new Error('formalization_reference_evidence_changed');
      return { digest: reference.digest, text };
    });
    if (result.files.some(file => readMathText(path.join(project, file.file), 300000) !== file.text))
      throw new Error('formalization_reference_source_changed');
    const reportFile = path.join(project, FORMALIZATION_REFERENCE_REPORT);
    assertMathCanonicalPath(reportFile);
    const reportText = readMathText(reportFile, 1000000), report = JSON.parse(reportText);
    result.evidence = { toolIdentity: latest.toolIdentity, sourceDigest: diagnostics.sourceDigest,
      environmentDigest: diagnostics.environmentDigest, latest, artifacts, reportText, reportSha256: mathDigest(reportText) };
    result.pairs = report.pairs.map((pair: Record<string, unknown>) => ({ candidateTarget: pair.candidateTarget,
      referenceTarget: pair.referenceTarget, candidateToReference: pair.candidateToReference,
      referenceToCandidate: pair.referenceToCandidate }));
    result.check = 'completed';
    result.status = result.pairs.every(pair => pair.candidateToReference.status === 'established' &&
      pair.referenceToCandidate.status === 'established') ? 'established' : 'not-established';
    assertFormalizationReferenceResult(input, result);
    for (const artifact of artifacts) {
      const target = path.join(directory, 'compilation-artifacts', artifact.digest + '.json');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeMathFrozen(target, artifact.text);
    }
  } catch (cause) {
    const reason = errorText(cause).slice(0, 1000) || 'formalization_reference_not_established';
    result = { ...result, status: 'not-established', check: files ? 'unavailable' : 'unsupported',
      pairs: unknownPairs(reason), reason, evidence: undefined };
  }
  assertFormalizationReferenceResult(input, result);
  frozenJson(path.join(directory, 'comparison.json'), result);
  return result;
}
