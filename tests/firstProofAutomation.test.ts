import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstProof, firstProofInventory, summarizeFirstProof } from '../scripts/mathematics/firstProof';
import { FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE, bootstrapFirstProofProblem, firstProofFormalizationInputDigest,
  firstProofFormalizationTargets, importFirstProofFormalization, readFirstProofCatalog, readFirstProofFormalization,
  type FirstProofFormalizationManifest, type FirstProofProblem } from '../src/math/firstProof';
import { formalizationDigest, formalizationInputDigest, formalizationReviewInput,
  type FormalizationEvidence } from '../src/math/formalization';
import type { FormalizationPlan } from '../src/math/formalizationPlan';
import { defaultFormalizationWorkflow, distinctFormalizationModelConfigurations,
  formalizationModelConfigurationDigest } from '../src/math/formalizationWorkflow';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { semanticReviewFixture, structureContextFixture, syntheticElaboration } from './helpers/formalizationFixture';

const { readArtifact, assertEvidence } = vi.hoisted(() => ({ readArtifact: vi.fn(), assertEvidence: vi.fn() }));
// Unit tests below start at the generic evidence validation boundary. All purported model sessions,
// compilations and approvals are synthetic in disposable directories, never benchmark results.
// Generic real compilation/evidence checks are covered by their own integration tests.
vi.mock('../src/math/formalization', async original => ({
  ...await original<typeof import('../src/math/formalization')>(),
  readFormalizationArtifact: readArtifact, assertFormalizationEvidence: assertEvidence,
}));
vi.mock('../src/math/mathBuildManifest', () => ({ readMathBuildManifest: (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) }));

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/first-proof/batch3');
const catalog = readFirstProofCatalog(sourceRoot), problem = catalog.problems[0]!;
const source = 'namespace SyntheticAutomationFixture\n'
  + 'theorem identity (n : Nat) : n + 0 = n := by sorry\nend SyntheticAutomationFixture\n';
const roots: string[] = [];
function temporaryDirectory() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'first-proof-automation-unit-')));
  roots.push(directory); return directory;
}
function evidenceFixture(selected: FirstProofProblem = problem): FormalizationEvidence {
  const environmentDigest = getLeanTaskEnvironment('standard').dependencyDigest;
  const request: FormalizationEvidence['request'] = { schema: 'theorem-os.formalization-request.v1', problemId: selected.id,
    statement: selected.source, statementSha256: selected.sourceSha256, environment: 'standard', environmentDigest,
    execution: 'model', model: 'synthetic-no-provider', effort: 'max', profile: '/synthetic/not-a-profile', executable: 'not-a-model',
    buildManifestRef: '/synthetic/not-a-build', buildDigest: 'a'.repeat(64), maxRounds: 1,
    maxRunSeconds: 60, maxTurnSeconds: 30, maxCompileSeconds: 30, maxTotalTokens: 0 };
  const targets = firstProofFormalizationTargets(source), sourceSha256 = mathDigest(source);
  const candidate = { source, coverage: [{ originalText: selected.source.slice(0, 80), targetNames: targets.map(target => target.name),
    explanation: 'Synthetic unit fixture only; not a formalization of the official problem.' }], assumptions: [],
    assumptionsExplanation: 'No hypotheses in the synthetic fixture.', definitionsExplanation: 'No custom fixture definitions.' };
  const snapshot: FormalizationEvidence['snapshot'] = { schema: 'theorem-os.formalization-snapshot.v1', source, sourceSha256,
    environment: 'standard', environmentDigest, targets: targets.map(target => ({ ...target,
      context: { type: '∀ (n : Nat), n + 0 = n', constants: [], omitted: [] } })) };
  const snapshotDigest = formalizationDigest(snapshot), inputDigest = formalizationInputDigest(request, candidate);
  const translation = { snapshotDigest, mathematics: 'Synthetic identity fixture.', assumptions: [], definitions: [],
    targets: targets.map(target => ({ name: target.name, mathematics: 'Synthetic natural-number identity.' })) };
  const translationDigest = formalizationDigest(translation);
  const review = { inputDigest, snapshotDigest, translationDigest, verdict: 'approved' as const,
    summary: 'Synthetic downstream unit fixture; no actual mathematical review was performed.',
    checks: { equivalent: true, complete: true, assumptions: true, definitions: true }, issues: [] };
  const generation: FormalizationEvidence['generation'] = { input: { problemId: request.problemId,
    statement: request.statement, environment: request.environment,
    toolchain: getLeanTaskEnvironment(request.environment).toolchain, round: 1 }, output: structuredClone(candidate) };
  const sessions: FormalizationEvidence['sessions'] = ['generate', 'backtranslate', 'compare'].map((role, index) => ({
    role: role as 'generate' | 'backtranslate' | 'compare', threadId: `synthetic-distinct-${index}`, turnId: `synthetic-turn-${index}`,
    status: 'completed', inputDigest: index === 1 ? snapshotDigest : index === 2 ?
      formalizationDigest({ inputDigest, snapshotDigest, translationDigest }) : formalizationDigest(generation.input),
    outputDigest: index === 1 ? translationDigest : index === 2 ? formalizationDigest(review) : formalizationDigest(generation.output),
    model: request.model, effort: request.effort, usage: {},
  }));
  return { schema: 'theorem-os.formalization-evidence.v1', status: 'approved', authority: 'model',
    method: 'independent-backtranslation-and-comparison', execution: 'model', modelInvoked: true, proofVerified: false,
    request, requestDigest: formalizationDigest(request), candidate, generation, inputDigest, sourceSha256, targets, snapshot, snapshotDigest,
    compilation: { exitCode: 0, timedOut: false, sourceSha256, environmentDigest: 'b'.repeat(64), diagnostics: {
      exitCode: 0, timedOut: false, environmentDigest: 'b'.repeat(64), syntheticBoundaryFixture: true } },
    translation, translationDigest, review, sessions, approvedAt: '2026-10-22T00:00:00Z', round: 1 };
}
function importedFixture() {
  const directory = temporaryDirectory(), formalizations = path.join(directory, 'formalizations'), evidence = evidenceFixture();
  readArtifact.mockReturnValue(evidence);
  const imported = importFirstProofFormalization(path.join(directory, 'generic-artifact'), formalizations, problem);
  if (imported.status === 'missing') throw new Error('Fixture import unexpectedly missing.');
  return { directory, formalizations, imported, evidence, file: path.join(imported.directory, 'formalization.json') };
}
function saveManifest(file: string, manifest: FirstProofFormalizationManifest) {
  if (manifest.review) {
    manifest.review.inputDigest = firstProofFormalizationInputDigest(manifest);
    manifest.reviewDigest = mathDigest(canonicalMathJson(manifest.review));
  }
  fs.chmodSync(file, 0o600); fs.writeFileSync(file, canonicalMathJson(manifest));
}
function boundEvidenceFixture(execution: 'model' | 'replay' = 'model') {
  const evidence = evidenceFixture(), elaboration = syntheticElaboration(evidence.candidate.source);
  evidence.request.execution = execution; evidence.execution = execution; evidence.modelInvoked = execution === 'model';
  evidence.requestDigest = formalizationDigest(evidence.request);
  evidence.candidate.source = elaboration.source;
  evidence.sourceSha256 = elaboration.sourceSha256; evidence.targets = elaboration.targets;
  evidence.snapshot = elaboration.snapshot; evidence.snapshotDigest = elaboration.snapshotDigest;
  evidence.compilation = elaboration.compilation;
  evidence.inputDigest = formalizationInputDigest(evidence.request, evidence.candidate);
  evidence.translation.snapshotDigest = evidence.snapshotDigest;
  evidence.translationDigest = formalizationDigest(evidence.translation);
  evidence.review = { ...evidence.review, inputDigest: evidence.inputDigest, snapshotDigest: evidence.snapshotDigest,
    translationDigest: evidence.translationDigest };
  evidence.sessions[0]!.inputDigest = formalizationDigest(evidence.generation.input);
  evidence.sessions[0]!.outputDigest = formalizationDigest(evidence.generation.output);
  evidence.sessions[1]!.inputDigest = evidence.snapshotDigest;
  evidence.sessions[1]!.outputDigest = evidence.translationDigest;
  evidence.sessions[2]!.inputDigest = formalizationDigest({ inputDigest: evidence.inputDigest,
    snapshotDigest: evidence.snapshotDigest, translationDigest: evidence.translationDigest });
  evidence.sessions[2]!.outputDigest = formalizationDigest(evidence.review);
  return evidence;
}
function boundWorkflowEvidenceFixture(): FormalizationEvidence {
  const evidence = boundEvidenceFixture(), request = evidence.request;
  const author = { model: request.model, effort: request.effort, profile: request.profile, executable: request.executable };
  const workflow = defaultFormalizationWorkflow(author);
  workflow.planner.model = 'synthetic-planner'; workflow.backtranslator.model = 'synthetic-backtranslator';
  workflow.reviewers = [{ ...author, id: 'judge-alpha', model: 'synthetic-judge-a' },
    { ...author, id: 'judge-beta', model: 'synthetic-judge-b' }];
  // These source-bound records exercise the adapter contract only. In particular, this synthetic
  // prove plan is not a classification or formalization of the official First Proof decision task.
  const quote = request.statement.slice(0, 80);
  const plan: FormalizationPlan = { schema: 'theorem-os.formalization-plan.v1', taskKind: 'prove',
    spans: [{ id: 'fixture-source', start: 0, end: quote.length, text: quote }], objects: [], assumptions: [],
    conclusions: [{ id: 'fixture-conclusion', spanIds: ['fixture-source'], targetNames: evidence.targets.map(target => target.name),
      assumptionIds: [], mathematics: 'Synthetic contract fixture only; no mathematical review of the official problem.' }],
    definitions: [], unresolved: [] };
  const planInput = { problemId: request.problemId, statement: request.statement, environment: request.environment,
    toolchain: getLeanTaskEnvironment(request.environment).toolchain, round: 1, planningRound: 1 };
  const planDigest = formalizationDigest(plan);
  request.schema = 'theorem-os.formalization-request.v2'; request.workflow = workflow;
  evidence.schema = 'theorem-os.formalization-evidence.v2'; evidence.requestDigest = formalizationDigest(request);
  evidence.generation.input = { ...evidence.generation.input, plan, planDigest };
  evidence.inputDigest = formalizationInputDigest(request, evidence.candidate);
  evidence.review = { ...evidence.review, inputDigest: evidence.inputDigest };
  const reviews = workflow.reviewers.map((reviewer, index) => ({ reviewerId: reviewer.id,
    review: { ...structuredClone(evidence.review), summary: index === 0 ? evidence.review.summary :
      'Secondary synthetic test reviewer; no actual mathematical review was performed.' } }));
  evidence.workflow = { schema: 'theorem-os.formalization-workflow-evidence.v2',
    plan: { input: planInput, output: plan, digest: planDigest }, reviews, reviewAgreement: 'unanimous',
    distinctModelConfigurations: distinctFormalizationModelConfigurations(author, workflow),
    profileDigest: mathDigest('Synthetic profile identity for adapter contract tests only.'),
    selectionPolicy: 'first-unanimously-approved' };
  const configs = [workflow.planner, author, workflow.backtranslator, ...workflow.reviewers];
  const digests = [
    { input: formalizationDigest(planInput), output: planDigest },
    { input: formalizationDigest(evidence.generation.input), output: formalizationDigest(evidence.generation.output) },
    { input: evidence.snapshotDigest, output: evidence.translationDigest },
    ...reviews.map(({ reviewerId, review }) => ({ input: formalizationDigest({ inputDigest: evidence.inputDigest,
      snapshotDigest: evidence.snapshotDigest, translationDigest: evidence.translationDigest, planDigest, reviewerId }),
    output: formalizationDigest(review) })),
  ];
  evidence.sessions = configs.map((config, index) => ({
    role: index === 0 ? 'plan' : index === 1 ? 'generate' : index === 2 ? 'backtranslate' : 'compare',
    threadId: `synthetic-v2-distinct-${index}`, turnId: `synthetic-v2-turn-${index}`, status: 'completed',
    inputDigest: digests[index]!.input, outputDigest: digests[index]!.output, model: config.model, effort: config.effort,
    configurationDigest: formalizationModelConfigurationDigest(config), usage: {},
    ...(index >= 3 ? { reviewerId: workflow.reviewers[index - 3]!.id } : {}),
  }));
  return evidence;
}
function boundKernelWorkflowEvidenceFixture(contextProtocol: 'kernel-v1' | 'kernel-v2' = 'kernel-v1'): FormalizationEvidence {
  const evidence = boundWorkflowEvidenceFixture();
  evidence.request.schema = 'theorem-os.formalization-request.v3'; evidence.request.contextProtocol = contextProtocol;
  evidence.schema = 'theorem-os.formalization-evidence.v3';
  evidence.workflow!.schema = 'theorem-os.formalization-workflow-evidence.v3';
  const elaboration = syntheticElaboration(evidence.candidate.source, evidence.request.environment,
    { detailedContext: true, semanticContext: true, ...(contextProtocol === 'kernel-v2' ? { structureContext: true } : {}) });
  evidence.candidate.source = elaboration.source;
  evidence.sourceSha256 = elaboration.sourceSha256; evidence.targets = elaboration.targets;
  evidence.snapshot = elaboration.snapshot; evidence.snapshotDigest = elaboration.snapshotDigest;
  evidence.compilation = elaboration.compilation;
  evidence.requestDigest = formalizationDigest(evidence.request);
  evidence.inputDigest = formalizationInputDigest(evidence.request, evidence.candidate);
  evidence.translation.snapshotDigest = evidence.snapshotDigest;
  evidence.translationDigest = formalizationDigest(evidence.translation);
  evidence.sessions[2]!.inputDigest = evidence.snapshotDigest;
  evidence.sessions[2]!.outputDigest = evidence.translationDigest;
  evidence.workflow!.reviews = evidence.request.workflow!.reviewers.map((reviewer, index) => {
    const input = formalizationReviewInput(evidence.request, evidence.candidate, evidence.snapshot, evidence.translation,
      { reviewerId: reviewer.id, planDigest: evidence.workflow!.plan.digest });
    const review = semanticReviewFixture(input, 'approved',
      'Synthetic v3 reviewer ' + index + '; no actual mathematical review was performed.');
    review.correspondences[0]!.candidateFragment = 'True';
    evidence.sessions[index + 3]!.inputDigest = formalizationDigest(input);
    evidence.sessions[index + 3]!.outputDigest = formalizationDigest(review);
    return { reviewerId: reviewer.id, review };
  });
  evidence.review = evidence.workflow!.reviews[0]!.review;
  return evidence;
}
async function invoke(args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try { const code = await firstProof(args); return { code, report: JSON.parse(String(log.mock.calls.at(-1)?.[0])) }; }
  finally { log.mockRestore(); }
}
beforeEach(() => { readArtifact.mockReset(); assertEvidence.mockReset(); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('First Proof automatic formalization import boundary', () => {
  it('round-trips synthetic v3 structured evidence and rejects a substituted secondary reviewer fragment', async () => {
    // Purely synthetic adapter evidence; this is not a formalization or benchmark result for First Proof.
    const actual = await vi.importActual<typeof import('../src/math/formalization')>('../src/math/formalization');
    readArtifact.mockImplementation(actual.readFormalizationArtifact);
    assertEvidence.mockImplementation(actual.assertFormalizationEvidence);
    const directory = temporaryDirectory(), evidence = boundKernelWorkflowEvidenceFixture();
    const artifact = actual.writeFormalizationArtifact(directory, evidence);
    const portable = actual.readFormalizationArtifact(artifact);
    expect(portable).toEqual(evidence);
    expect(portable.snapshot.targets[0]!.context.bindings!.conclusionDependencies).toEqual(['b0']);
    expect(portable.request.contextProtocol).toBe('kernel-v1');
    expect(portable.snapshot.targets[0]!.context.semantic).toEqual(evidence.snapshot.targets[0]!.context.semantic);
    const formalizations = path.join(directory, 'formalizations');
    const imported = importFirstProofFormalization(artifact, formalizations, problem);
    if (imported.status === 'missing') throw new Error('Fixture import unexpectedly missing.');
    expect(imported.manifest.review!.reviewer).toBe('judge-alpha (synthetic-judge-a), judge-beta (synthetic-judge-b)');
    expect(readFirstProofFormalization(formalizations, problem).status).toBe('approved');
    const file = path.join(imported.directory, FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE);
    const stored: FormalizationEvidence = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(stored).toEqual(portable);
    const unchangedRootReview = canonicalMathJson(stored.review);
    const secondary = stored.workflow!.reviews[1]!.review;
    if (!('correspondences' in secondary)) throw new Error('Expected a structured v3 secondary review.');
    secondary.correspondences[0]!.originalFragment = 'Fabricated quotation absent from the synthetic fixture source.';
    stored.sessions[4]!.outputDigest = formalizationDigest(secondary);
    expect(canonicalMathJson(stored.review)).toBe(unchangedRootReview);
    const genericEvidenceFile = path.join(artifact, 'evidence.json');
    fs.chmodSync(genericEvidenceFile, 0o600); fs.writeFileSync(genericEvidenceFile, canonicalMathJson(stored));
    expect(() => actual.readFormalizationArtifact(artifact)).toThrow('formalization_workflow_evidence_invalid');
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, canonicalMathJson(stored));
    imported.manifest.automation!.evidenceDigest = formalizationDigest(stored);
    saveManifest(path.join(imported.directory, 'formalization.json'), imported.manifest);
    expect(() => readFirstProofFormalization(formalizations, problem)).toThrow('formalization_workflow_evidence_invalid');
  });

  it.each(['fragment', 'record'] as const)('rejects substituted kernel %s after imported evidence and session digests are recomputed', async defect => {
    const actual = await vi.importActual<typeof import('../src/math/formalization')>('../src/math/formalization');
    readArtifact.mockImplementation(actual.readFormalizationArtifact);
    assertEvidence.mockImplementation(actual.assertFormalizationEvidence);
    const directory = temporaryDirectory(), evidence = boundKernelWorkflowEvidenceFixture();
    const artifact = actual.writeFormalizationArtifact(directory, evidence), formalizations = path.join(directory, 'formalizations');
    const imported = importFirstProofFormalization(artifact, formalizations, problem);
    if (imported.status === 'missing') throw new Error('Fixture import unexpectedly missing.');
    const file = path.join(imported.directory, FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE);
    const stored: FormalizationEvidence = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (defect === 'fragment') {
      const review = stored.workflow!.reviews[1]!.review;
      if (!('correspondences' in review)) throw new Error('Expected a structured secondary review.');
      review.correspondences[0]!.candidateFragment = 'False';
      stored.sessions[4]!.outputDigest = formalizationDigest(review);
    } else {
      stored.snapshot.targets[0]!.context.semantic!.rawType = 'False';
      stored.snapshotDigest = formalizationDigest(stored.snapshot);
      stored.translation.snapshotDigest = stored.snapshotDigest;
      stored.translationDigest = formalizationDigest(stored.translation);
      stored.sessions[2]!.inputDigest = stored.snapshotDigest; stored.sessions[2]!.outputDigest = stored.translationDigest;
      for (const [index, entry] of stored.workflow!.reviews.entries()) {
        const input = formalizationReviewInput(stored.request, stored.candidate, stored.snapshot, stored.translation,
          { reviewerId: entry.reviewerId, planDigest: stored.workflow!.plan.digest });
        entry.review.inputDigest = formalizationDigest(input);
        stored.sessions[index + 3]!.inputDigest = formalizationDigest(input);
        stored.sessions[index + 3]!.outputDigest = formalizationDigest(entry.review);
      }
      stored.review = structuredClone(stored.workflow!.reviews[0]!.review);
    }
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, canonicalMathJson(stored));
    imported.manifest.automation!.evidenceDigest = formalizationDigest(stored);
    saveManifest(path.join(imported.directory, 'formalization.json'), imported.manifest);
    expect(() => readFirstProofFormalization(formalizations, problem)).toThrow(defect === 'fragment'
      ? 'formalization_workflow_evidence_invalid' : 'formalization_compilation_evidence_invalid');
  });

  it('round-trips kernel-v2 structure evidence and rejects substituted imported fields after downstream hashes are recomputed', async () => {
    const actual = await vi.importActual<typeof import('../src/math/formalization')>('../src/math/formalization');
    readArtifact.mockImplementation(actual.readFormalizationArtifact);
    assertEvidence.mockImplementation(actual.assertFormalizationEvidence);
    const directory = temporaryDirectory(), evidence = boundKernelWorkflowEvidenceFixture('kernel-v2');
    const artifact = actual.writeFormalizationArtifact(directory, evidence), formalizations = path.join(directory, 'formalizations');
    const imported = importFirstProofFormalization(artifact, formalizations, problem);
    if (imported.status === 'missing') throw new Error('Fixture import unexpectedly missing.');
    const file = path.join(imported.directory, FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE);
    const original: FormalizationEvidence = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(original.request.contextProtocol).toBe('kernel-v2');
    expect(original.snapshot.targets[0].context.structures).toEqual({ schema: 'theorem-os.lean-statement-structures.v1', entries: [] });
    expect(readFirstProofFormalization(formalizations, problem).status).toBe('approved');
    for (const defect of ['missing', 'field'] as const) {
      const stored = structuredClone(original);
      if (defect === 'missing') delete stored.snapshot.targets[0].context.structures;
      else {
        stored.snapshot.targets[0].context.structures = structureContextFixture();
        stored.snapshot.targets[0].context.constants.push({ name: 'OfNat', module: 'Init.Prelude', type: '(α : Type u) → Nat → Type u' });
      }
      stored.snapshotDigest = formalizationDigest(stored.snapshot);
      stored.translation.snapshotDigest = stored.snapshotDigest;
      stored.translationDigest = formalizationDigest(stored.translation);
      stored.sessions[2].inputDigest = stored.snapshotDigest; stored.sessions[2].outputDigest = stored.translationDigest;
      for (const [index, entry] of stored.workflow!.reviews.entries()) {
        const input = formalizationReviewInput(stored.request, stored.candidate, stored.snapshot, stored.translation,
          { reviewerId: entry.reviewerId, planDigest: stored.workflow!.plan.digest });
        entry.review.inputDigest = formalizationDigest(input);
        stored.sessions[index + 3].inputDigest = formalizationDigest(input);
        stored.sessions[index + 3].outputDigest = formalizationDigest(entry.review);
      }
      stored.review = structuredClone(stored.workflow!.reviews[0].review);
      fs.chmodSync(file, 0o600); fs.writeFileSync(file, canonicalMathJson(stored));
      imported.manifest.automation!.evidenceDigest = formalizationDigest(stored);
      saveManifest(path.join(imported.directory, 'formalization.json'), imported.manifest);
      expect(() => readFirstProofFormalization(formalizations, problem)).toThrow(defect === 'missing'
        ? 'formalization_context_missing_structures' : 'formalization_compilation_evidence_invalid');
    }
  });

  it('round-trips portable v2 workflow evidence and checks every imported reviewer', async () => {
    const actual = await vi.importActual<typeof import('../src/math/formalization')>('../src/math/formalization');
    readArtifact.mockImplementation(actual.readFormalizationArtifact);
    assertEvidence.mockImplementation(actual.assertFormalizationEvidence);
    const directory = temporaryDirectory(), evidence = boundWorkflowEvidenceFixture();
    const artifact = actual.writeFormalizationArtifact(directory, evidence);
    const portable = actual.readFormalizationArtifact(artifact);
    expect(portable).toEqual(evidence);
    const formalizations = path.join(directory, 'formalizations');
    const imported = importFirstProofFormalization(artifact, formalizations, problem);
    if (imported.status === 'missing') throw new Error('Fixture import unexpectedly missing.');
    expect(imported.manifest.review!.reviewer).toBe('judge-alpha (synthetic-judge-a), judge-beta (synthetic-judge-b)');
    expect(imported.manifest.review!.reviewer).not.toContain(evidence.request.model);
    expect(readFirstProofFormalization(formalizations, problem).status).toBe('approved');
    const file = path.join(imported.directory, FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE);
    const stored: FormalizationEvidence = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(stored).toEqual(portable);
    expect(stored.workflow!.plan).toEqual(evidence.workflow!.plan);
    expect(stored.request.workflow!.reviewers.map(reviewer => reviewer.model)).toEqual(['synthetic-judge-a', 'synthetic-judge-b']);

    const unchangedRootReview = canonicalMathJson(stored.review);
    stored.workflow!.reviews[1]!.review.checks.complete = false;
    stored.sessions[4]!.outputDigest = formalizationDigest(stored.workflow!.reviews[1]!.review);
    expect(canonicalMathJson(stored.review)).toBe(unchangedRootReview);
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, canonicalMathJson(stored));
    imported.manifest.automation!.evidenceDigest = formalizationDigest(stored);
    saveManifest(path.join(imported.directory, 'formalization.json'), imported.manifest);
    expect(() => readFirstProofFormalization(formalizations, problem)).toThrow('formalization_workflow_evidence_invalid');
  });

  it('round-trips through the real portable evidence validator and detects damaged compiler artifacts', async () => {
    const actual = await vi.importActual<typeof import('../src/math/formalization')>('../src/math/formalization');
    readArtifact.mockImplementation(actual.readFormalizationArtifact);
    assertEvidence.mockImplementation(actual.assertFormalizationEvidence);
    const directory = temporaryDirectory(), evidence = boundEvidenceFixture();
    const artifact = actual.writeFormalizationArtifact(directory, evidence);
    const formalizations = path.join(directory, 'formalizations');
    const imported = importFirstProofFormalization(artifact, formalizations, problem);
    if (imported.status === 'missing') throw new Error('Fixture import unexpectedly missing.');
    expect(imported.manifest.review!.authority).toBe('model');
    expect(readFirstProofFormalization(formalizations, problem).status).toBe('approved');
    const file = path.join(imported.directory, FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE);
    (evidence.compilation.diagnostics.artifactRecords as { text: string }[])[0]!.text += '\n';
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, canonicalMathJson(evidence));
    imported.manifest.automation!.evidenceDigest = formalizationDigest(evidence);
    saveManifest(path.join(imported.directory, 'formalization.json'), imported.manifest);
    expect(() => readFirstProofFormalization(formalizations, problem)).toThrow('formalization_compilation_evidence_invalid');
  });

  it('rejects an otherwise complete replay artifact through the real generic validation path', async () => {
    const actual = await vi.importActual<typeof import('../src/math/formalization')>('../src/math/formalization');
    readArtifact.mockImplementation(actual.readFormalizationArtifact);
    assertEvidence.mockImplementation(actual.assertFormalizationEvidence);
    const directory = temporaryDirectory(), artifact = actual.writeFormalizationArtifact(directory, boundEvidenceFixture('replay'));
    expect(() => importFirstProofFormalization(artifact, path.join(directory, 'formalizations'), problem))
      .toThrow('first_proof_formalization_model_execution_required');
    expect(fs.existsSync(path.join(directory, 'formalizations'))).toBe(false);
  });

  it('records model authority and binds the canonical evidence digest into review inputs', () => {
    const fixture = importedFixture();
    expect(fixture.imported.manifest.review).toMatchObject({ authority: 'model', reviewer: fixture.evidence.request.model,
      summary: fixture.evidence.review.summary, verdict: 'approved' });
    const text = fs.readFileSync(path.join(fixture.imported.directory, FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE), 'utf8');
    expect(text).toBe(canonicalMathJson(fixture.evidence));
    expect(fixture.imported.manifest.automation!.evidenceDigest).toBe(mathDigest(text));
    expect(fixture.imported.manifest.review!.inputDigest).toBe(firstProofFormalizationInputDigest(fixture.imported.manifest));
    expect(assertEvidence).toHaveBeenCalled();
    expect(firstProofInventory(catalog, fixture.formalizations).problems[0]).toMatchObject({ ready: true, reviewAuthority: 'model' });
    expect(() => importFirstProofFormalization('not-needed', fixture.formalizations, problem)).toThrow('already exists');
  });

  it.each(['original', 'problemId'] as const)('rejects a generic artifact with a different %s without creating output', field => {
    const directory = temporaryDirectory(), evidence = evidenceFixture();
    if (field === 'original') evidence.request.statement += '\n';
    else evidence.request.problemId = catalog.problems[1]!.id;
    readArtifact.mockReturnValue(evidence);
    const formalizations = path.join(directory, 'formalizations');
    expect(() => importFirstProofFormalization('generic-artifact', formalizations, problem))
      .toThrow('first_proof_formalization_automation_problem_mismatch');
    expect(fs.existsSync(formalizations)).toBe(false);
  });

  it.each(['replay', 'not-invoked'] as const)('refuses %s evidence as a model First Proof review', kind => {
    const directory = temporaryDirectory(), evidence = evidenceFixture();
    evidence.modelInvoked = false;
    if (kind === 'replay') { evidence.execution = 'replay'; evidence.request.execution = 'replay'; }
    readArtifact.mockReturnValue(evidence);
    expect(() => importFirstProofFormalization('generic-artifact', path.join(directory, 'formalizations'), problem))
      .toThrow('first_proof_formalization_model_execution_required');
    expect(fs.existsSync(path.join(directory, 'formalizations'))).toBe(false);
  });

  it('retains the existing rejection for raw model approval without automation evidence', () => {
    const fixture = importedFixture();
    const manifest = fixture.imported.manifest;
    delete manifest.automation; saveManifest(fixture.file, manifest);
    expect(() => readFirstProofFormalization(fixture.formalizations, problem)).toThrow('first_proof_formalization_human_review_required');
  });

  it.each(['notes', 'authority', 'reviewer'] as const)('detects a changed %s even after local review digests are recomputed', field => {
    const fixture = importedFixture(), manifest = fixture.imported.manifest;
    if (field === 'notes') manifest.definitionsExplanation += ' Changed after the model review.';
    if (field === 'authority') manifest.review!.authority = 'human';
    if (field === 'reviewer') manifest.review!.reviewer = 'a different model';
    saveManifest(fixture.file, manifest);
    expect(() => readFirstProofFormalization(fixture.formalizations, problem)).toThrow(field === 'notes'
      ? 'first_proof_formalization_automation_input_mismatch' : 'first_proof_formalization_automation_review_mismatch');
  });

  it('rejects missing or changed evidence and includes its digest in the review binding', () => {
    const fixture = importedFixture(), file = path.join(fixture.imported.directory, FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE);
    fs.chmodSync(file, 0o600); fs.appendFileSync(file, '\n');
    expect(() => readFirstProofFormalization(fixture.formalizations, problem)).toThrow('first_proof_formalization_automation_digest_mismatch');
    fs.unlinkSync(file);
    expect(() => readFirstProofFormalization(fixture.formalizations, problem)).toThrow();
    fixture.imported.manifest.automation!.evidenceDigest = '0'.repeat(64);
    fs.chmodSync(fixture.file, 0o600); fs.writeFileSync(fixture.file, canonicalMathJson(fixture.imported.manifest));
    expect(() => readFirstProofFormalization(fixture.formalizations, problem)).toThrow('first_proof_formalization_review_input_mismatch');
  });

  it('exposes an offline CLI import and keeps model-reviewed historical case evidence independent', async () => {
    const directory = temporaryDirectory(), formalizations = path.join(directory, 'formalizations');
    readArtifact.mockReturnValue(evidenceFixture());
    const result = await invoke(['--phase', 'import', '--problem', problem.id, '--artifact', path.join(directory, 'artifact'),
      '--formalizations-root', formalizations]);
    expect(result).toMatchObject({ code: 0, report: { status: 'approved', reviewAuthority: 'model', invokesModel: false, proofVerified: false } });
    const build = path.join(directory, 'build.json'); fs.writeFileSync(build, '{}');
    const campaign = path.join(directory, 'campaign');
    const prepared = await invoke(['--phase', 'prepare', '--problem', problem.id, '--formalizations-root', formalizations,
      '--directory', campaign, '--build-manifest', build]);
    const snapshot = path.join(path.dirname(prepared.report.caseFile), 'formalization', problem.id, FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE);
    expect(fs.existsSync(snapshot)).toBe(true);
    fs.rmSync(formalizations, { recursive: true });
    const summary = summarizeFirstProof(campaign, catalog, formalizations);
    expect(summary.runs[0]).toMatchObject({ status: 'not_started', validCase: true, attempted: false });
    expect(summary.invalidRecords).toBe(0);
    expect(fs.readFileSync(path.join(path.dirname(prepared.report.caseFile), 'task.md'), 'utf8')).toContain('Model review SHA256:');
  });

  it('uses the bound model review label in the native task and keeps all original targets', () => {
    const fixture = importedFixture();
    const receipt = bootstrapFirstProofProblem({ sourceRoot, formalizationsRoot: fixture.formalizations,
      problemId: problem.id, workspaceRoot: path.join(fixture.directory, 'workspace') });
    expect(receipt.contract.informalStatement).toContain('model-reviewed');
    expect(receipt.contract.informalStatement).toContain('Model review SHA256:');
    expect(receipt.contract.informalStatement).not.toContain('Human review SHA256:');
    expect(receipt.publicObligations).toEqual(fixture.imported.manifest.targets);
  });
});
