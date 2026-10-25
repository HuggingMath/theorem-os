import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mathBuildFile, mathBuildSource, MATH_RUNTIME_BUNDLES } from '../../src/math/mathBuildManifest';
import { canonicalMathJson, mathDigest, writeMathJsonDurable } from '../../src/math/mathRuntimeIo';
import { formalizationDigest, type FormalizationCandidate } from '../../src/math/formalization';
import { eraseFormalizationProofs, formalizationTargets } from '../../src/math/formalizationSource';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { LAKE_CONFIGURATION_FILES } from '../../src/math/mathConstructionSources';
import { leanStatementContextCommands } from '../../src/math/leanStatementContext';
import type { LeanStatementSemantic } from '../../src/math/leanStatementSemantic';
import { STRUCTURED_REVIEW_EVIDENCE_VERSION, structuredReviewAspects, structuredReviewDigest,
  type StructuredReviewInput, type StructuredSemanticReview } from '../../src/math/formalizationReviewV2';

// Synthetic compiler/session evidence for disposable contract tests only, never real benchmark evidence.
export const fixtureStatement = 'For every natural number n, prove n + 0 = n.';
export function candidateFixture(statement = fixtureStatement): FormalizationCandidate {
  return { source: 'theorem addition (n : Nat) : n + 0 = n := by sorry\n',
    coverage: [{ originalText: statement, targetNames: ['addition'], explanation: 'Synthetic test target.' }],
    assumptions: [], assumptionsExplanation: 'Natural-number domain.', definitionsExplanation: 'Standard addition.' };
}

export function buildFixture(directory: string) {
  const root = path.join(directory, 'source'), bundleRoot = path.join(root, 'out/main');
  fs.mkdirSync(bundleRoot, { recursive: true });
  const inputs = { 'bun.lock': '', 'package.json': '{}', 'tsconfig.json': '{}',
    'extraction.json': JSON.stringify({ schema: 'deepscientist.math.extraction.v1', sourceCommit: '1'.repeat(40) }),
    'scripts/build.ts': '', 'bin/math.ts': '', 'scripts/mathematics/searchLean.ts': '' };
  for (const [name, value] of Object.entries(inputs)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), value);
  }
  for (const name of MATH_RUNTIME_BUNDLES) fs.writeFileSync(path.join(bundleRoot, name), '// synthetic test bundle\n');
  const manifest = path.join(directory, 'build.json');
  writeMathJsonDurable(manifest, { schema: 'deepscientist.math.build-manifest.v1', buildId: crypto.randomUUID(),
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), source: mathBuildSource(root), bundleRoot,
    bundles: MATH_RUNTIME_BUNDLES.map(name => mathBuildFile(path.join(bundleRoot, name))) }, 0o400);
  return { root, manifest };
}

export function semanticReviewFixture(input: StructuredReviewInput,
  verdict: StructuredSemanticReview['verdict'] = 'approved', summary = 'Faithful test statement.',
  mismatchAspect: typeof structuredReviewAspects[number] = 'domains'): StructuredSemanticReview {
  return { schema: 'theorem-os.formalization-semantic-review.v2', caseId: input.caseId,
    inputDigest: structuredReviewDigest(input), evidenceVersion: STRUCTURED_REVIEW_EVIDENCE_VERSION, verdict, summary,
    checks: { domains: 'faithful', assumptions: 'faithful', conclusions: 'faithful', definitions: 'faithful',
      quantifierScope: 'faithful', instanceCoherence: 'faithful',
      ...(verdict === 'approved' ? {} : { [mismatchAspect]: verdict === 'unknown' ? 'uncertain' : 'mismatch' }) },
    correspondences: structuredReviewAspects.map(aspect => {
      const changed = aspect === mismatchAspect && verdict !== 'approved';
      return { aspect, originalFragment: input.original, candidateFragment: input.candidate,
        relation: changed ? verdict === 'unknown' ? 'unresolved' : 'mismatch' : 'direct',
        explanation: changed ? summary : 'Synthetic faithful correspondence for this contract test.',
        forwardArgument: '', reverseArgument: '', sourceReadings: [],
        mismatchEvidence: changed && verdict === 'changes_requested' ? { sourceClaim: input.original,
          candidateClaim: input.candidate, separationArgument: 'Synthetic review mismatch used only to exercise revision handling.' } : null };
    }) };
}

export function semanticContextFixture(): LeanStatementSemantic {
  return { schema: 'theorem-os.lean-statement-semantic.v1', rawType: 'True',
    kernelType: ['const', ['str', null, 'True'], []], localMeaningClosure: [] };
}

export function structureContextFixture() {
  return { schema: 'theorem-os.lean-statement-structures.v1' as const, entries: [{ name: 'OfNat', class: true,
    fields: [{ name: 'OfNat.ofNat', type: '{α : Type u} → (n : Nat) → [OfNat α n] → α' }] }] };
}

export function syntheticElaboration(input: string, environment: LeanTaskEnvironment = 'standard',
  options: { detailedContext?: boolean; semanticContext?: boolean; structureContext?: boolean } = {}) {
  const source = eraseFormalizationProofs(input), sourceSha256 = mathDigest(source), targets = formalizationTargets(source);
  const config = getLeanTaskEnvironment(environment), environmentDigest = 'd'.repeat(64), toolIdentity = 'e'.repeat(64);
  const query = 'import Lean\nimport Formalization\n' + leanStatementContextCommands(
    targets.map(item => ({ id: item.name, name: item.name })), [{ module: 'Formalization', file: 'Formalization.lean' }],
    '.lake/formalization-context.json', { detailedContext: options.detailedContext,
      semanticContext: options.semanticContext, structureContext: options.structureContext }) + '\n';
  const configuration = LAKE_CONFIGURATION_FILES.map(file => ({ file, digest: config.files[file] ? mathDigest(config.files[file]!) : null }));
  const sourceFiles = [{ file: 'Formalization.lean', digest: sourceSha256 }, { file: 'FormalizationContext.lean', digest: mathDigest(query) }];
  const sourceDigest = mathDigest(JSON.stringify([configuration.map(item => item.digest ?? ''), sourceFiles.map(item => [item.file, item.digest])]));
  const artifact = { schema: 'theoremos.lean-diagnostics.v1', authority: 'advisory-lean-process', sourceDigest,
    environmentDigest, toolIdentity, sourceFiles, sourceCurrent: true, exitCode: 0, timedOut: false, aborted: false,
    captureComplete: true, stdout: '', stderr: '', stdoutSha256: mathDigest(''), stderrSha256: mathDigest('') };
  const text = canonicalMathJson(artifact), digest = mathDigest(text);
  const diagnostics = { exitCode: 0, timedOut: false, sourceDigest, environmentDigest, toolIdentity,
    latest: { schema: 'theoremos.lean-diagnostics-latest.v1', authority: 'advisory-lean-process', sourceDigest, environmentDigest,
      toolIdentity, sourceFiles, configuration, exitCode: 0, timedOut: false, aborted: false },
    diagnosticArtifacts: [{ path: 'compilation-artifacts/' + digest + '.json', digest, sourceDigest, environmentDigest, captureComplete: true }],
    artifactRecords: [{ digest, text }], contextExport: undefined as { path: string; digest: string; text: string } | undefined };
  const snapshot = { schema: 'theorem-os.formalization-snapshot.v1' as const, source, sourceSha256,
    environment, environmentDigest: config.dependencyDigest, targets: targets.map(item => ({
      ...item, context: { type: 'forall (n : Nat), n + 0 = n', constants: [], omitted: [],
        ...(options.detailedContext || options.semanticContext || options.structureContext ? { bindings: {
          binders: [{ id: 'b0', name: 'n', type: 'Nat', kind: 'explicit' as const, dependencies: [] }],
          conclusion: 'n + 0 = n', conclusionDependencies: ['b0'],
        } } : {}),
        ...(options.semanticContext || options.structureContext ? { semantic: semanticContextFixture() } : {}),
        ...(options.structureContext ? { structures: { schema: 'theorem-os.lean-statement-structures.v1' as const, entries: [] } } : {}) },
    })) };
  const contextText = canonicalMathJson(snapshot.targets.map(item => ({ id: item.name, context: item.context })));
  diagnostics.contextExport = { path: '.lake/formalization-context.json', digest: mathDigest(contextText), text: contextText };
  return { source, sourceSha256, targets, environmentDigest: config.dependencyDigest,
    snapshot, snapshotDigest: formalizationDigest(snapshot),
    compilation: { exitCode: 0 as const, timedOut: false as const, sourceSha256, environmentDigest, diagnostics } };
}
