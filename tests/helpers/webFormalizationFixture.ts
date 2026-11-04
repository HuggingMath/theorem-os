import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { formalizationDigest, formalizationInputDigest, formalizationRequestSchema, formalizationReviewInput, type FormalizationEvidence } from '../../src/math/formalization';
import { defaultFormalizationWorkflow, formalizationModelConfigurationDigest } from '../../src/math/formalizationWorkflow';
import type { FormalizationPlan } from '../../src/math/formalizationPlan';
import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { mathDigest } from '../../src/math/mathRuntimeIo';
import { fidelityReferenceInput } from '../../src/math/formalizationFidelity';
import { assertFormalizationReferenceResult } from '../../src/math/formalizationReference';
import type { WorkerFormalizationInput } from '../../apps/web/formalizationTypes';
import { candidateFixture, semanticReviewFixture, syntheticElaboration } from './formalizationFixture';

export const webFormalizationStatement = 'For every natural number n, prove n + 1 = 1 + n.';
// Compilation and model receipts below are synthetic contract data. The saved guarded correspondence
// receipt was generated locally on 2026-11-02 with Lean 4.33.0 and no model. Tests replay it unchanged.
export function webFormalizationEvidence(input: WorkerFormalizationInput): FormalizationEvidence {
  const round = 1, author = { model: input.model, effort: input.effort, profile: '/synthetic', executable: '/no-model' };
  const workflow = { ...defaultFormalizationWorkflow(author), maxPlanningRounds: input.maxPlanningRounds, reviewScheduling: 'parallel' as const };
  const r = formalizationRequestSchema.parse({ schema: 'theorem-os.formalization-request.v3', problemId: input.id,
    statement: input.original, statementSha256: mathDigest(input.original), environment: input.environment,
    environmentDigest: getLeanTaskEnvironment(input.environment).dependencyDigest, execution: 'model', ...author,
    buildManifestRef: '/synthetic-build.json', buildDigest: 'a'.repeat(64), maxRounds: input.maxRounds, maxRunSeconds: input.maxRunSeconds,
    maxTotalTokens: input.maxTotalTokens, maxTurnSeconds: 0, maxCompileSeconds: 0, workflow,
    fidelityPolicy: 'task-preserving-v2', contextProtocol: 'kernel-v2' });
  const rawCandidate = { ...candidateFixture(input.original), source: 'theorem addition (n : Nat) : n + 1 = 1 + n := by sorry\n' };
  const elaborated = syntheticElaboration(rawCandidate.source, 'standard', { detailedContext: true, semanticContext: true, structureContext: true });
  const candidate = { ...rawCandidate, source: elaborated.source };
  const inputDigest = formalizationInputDigest(r, candidate), snapshotDigest = elaborated.snapshotDigest;
  const translation = { snapshotDigest, mathematics: input.original, assumptions: [], definitions: [],
    targets: [{ name: 'addition', mathematics: input.original }] };
  const translationDigest = formalizationDigest(translation);
  const plan: FormalizationPlan = { schema: 'theorem-os.formalization-plan.v1', taskKind: 'prove',
    spans: [{ id: 'source', start: 0, end: input.original.length, text: input.original }],
    objects: [{ id: 'natural', spanIds: ['source'], description: 'A natural number.', leanType: 'Nat' }],
    assumptions: [], definitions: [], unresolved: [], conclusions: [{ id: 'identity', spanIds: ['source'],
      mathematics: input.original, targetNames: ['addition'], assumptionIds: [] }] };
  const planDigest = formalizationDigest(plan);
  const planInput = { problemId: r.problemId, statement: r.statement, environment: r.environment,
    toolchain: getLeanTaskEnvironment(r.environment).toolchain, round, planningRound: 1 };
  const generationInput = { problemId: r.problemId, statement: r.statement, environment: r.environment,
    toolchain: getLeanTaskEnvironment(r.environment).toolchain, round, plan, planDigest };
  const saved = JSON.parse(gunzipSync(fs.readFileSync(new URL('../fixtures/web-formalization-fidelity-v2.json.gz', import.meta.url))).toString());
  const reviews = workflow.reviewers.map(({ id }) => {
    const reviewInput = formalizationReviewInput(r, candidate, elaborated.snapshot, translation, { reviewerId: id, planDigest });
    const review = semanticReviewFixture(reviewInput);
    review.fidelity = { policy: 'task-preserving-v2', targets: elaborated.snapshot.targets.map(target => ({
      targetName: target.name, originalFragment: input.original, sourceClaim: input.original, candidateClaim: input.original,
      hypothesisScope: 'The natural-number domain.', quantifierOrder: 'Universally quantified n.',
      binderIds: target.context.bindings!.binders.map(binder => binder.id), conclusionDependencies: target.context.bindings!.conclusionDependencies,
    })), sourceContract: { source: candidate.source, pairs: [{ candidateTarget: 'addition', referenceTarget: 'addition' }] } };
    const expected = fidelityReferenceInput(elaborated.snapshot, review.fidelity);
    if (formalizationDigest(saved.input) !== formalizationDigest(expected)) throw new Error('fixture_reference_input_changed');
    assertFormalizationReferenceResult(expected, saved.result);
    return { reviewerId: id, review, correspondence: saved.result, inputDigest: formalizationDigest(reviewInput) };
  });
  const session = (role: 'plan' | 'generate' | 'backtranslate' | 'compare', index: number,
    sessionInput: string, output: string, reviewerId?: string) => ({ role, threadId: 'synthetic-thread-' + index,
    turnId: 'synthetic-turn-' + index, status: 'completed' as const, inputDigest: sessionInput, outputDigest: output,
    model: author.model, effort: author.effort, usage: {}, configurationDigest: formalizationModelConfigurationDigest(author),
    ...(reviewerId ? { reviewerId } : {}) });
  return { schema: 'theorem-os.formalization-evidence.v3', status: 'approved', authority: 'model',
    method: 'independent-backtranslation-and-comparison', execution: 'model', modelInvoked: true, proofVerified: false,
    request: r, requestDigest: formalizationDigest(r), candidate, inputDigest, generation: { input: generationInput, output: candidate },
    sourceSha256: elaborated.sourceSha256, targets: elaborated.targets, snapshot: elaborated.snapshot, snapshotDigest,
    compilation: elaborated.compilation, translation, translationDigest, review: reviews[0].review,
    sessions: [session('plan', 0, formalizationDigest(planInput), planDigest),
      session('generate', 1, formalizationDigest(generationInput), formalizationDigest(candidate)),
      session('backtranslate', 2, snapshotDigest, translationDigest),
      ...reviews.map((review, index) => session('compare', index + 3, review.inputDigest, formalizationDigest(review.review), review.reviewerId))],
    approvedAt: '2026-11-02T00:00:00Z', round, workflow: { schema: 'theorem-os.formalization-workflow-evidence.v3',
      plan: { input: planInput, output: plan, digest: planDigest }, reviews: reviews.map(({ inputDigest: _, ...review }) => review),
      reviewAgreement: 'unanimous', distinctModelConfigurations: 1, profileDigest: 'b'.repeat(64), selectionPolicy: 'first-unanimously-approved' } };
}
