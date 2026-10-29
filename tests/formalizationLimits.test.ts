import { describe, expect, it } from 'vitest';
import { assertFormalizationEvidence, formalizationDigest, formalizationInputDigest,
  formalizationRequestSchema, type FormalizationEvidence } from '../src/math/formalization';
import { defaultFormalizationWorkflow, formalizationModelConfigurationDigest, formalizationWorkflowSchema } from '../src/math/formalizationWorkflow';
import type { FormalizationPlan } from '../src/math/formalizationPlan';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { candidateFixture, fixtureStatement, syntheticElaboration } from './helpers/formalizationFixture';

// These are disposable contract objects with synthetic compilation evidence. No model or Lean
// process runs, and accepting these objects is never reported as measured formalization quality.
const author = { model: 'preset-limit-contract', effort: 'none', profile: '/preset', executable: '/no-model' };
const limits = { maxRounds: 0, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0 };
const limitNames = Object.keys(limits) as (keyof typeof limits)[];
function request(overrides = {}) {
  return formalizationRequestSchema.parse({ schema: 'theorem-os.formalization-request.v1', problemId: 'limit_contract',
    statement: fixtureStatement, statementSha256: mathDigest(fixtureStatement), environment: 'standard',
    environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest,
    execution: 'replay', ...author, buildManifestRef: '/synthetic-build.json', buildDigest: 'a'.repeat(64),
    ...limits, ...overrides });
}
function evidenceFixture(maxRounds: number, round: number, planning?: { limit: number; round: number }): FormalizationEvidence {
  const workflow = planning ? { ...defaultFormalizationWorkflow(author), maxPlanningRounds: planning.limit } : undefined;
  const r = request({ maxRounds, ...(workflow ? { schema: 'theorem-os.formalization-request.v2', workflow } : {}) });
  const rawCandidate = candidateFixture(), elaborated = syntheticElaboration(rawCandidate.source);
  const candidate = { ...rawCandidate, source: elaborated.source };
  const inputDigest = formalizationInputDigest(r, candidate), snapshotDigest = elaborated.snapshotDigest;
  const translation = { snapshotDigest, mathematics: 'For every natural n, n + 0 = n.', assumptions: [], definitions: [],
    targets: [{ name: 'addition', mathematics: 'For every natural n, n + 0 = n.' }] };
  const translationDigest = formalizationDigest(translation);
  const review = { inputDigest, snapshotDigest, translationDigest, verdict: 'approved' as const,
    summary: 'Synthetic contract judgment only.', checks: { equivalent: true, complete: true, assumptions: true, definitions: true }, issues: [] };
  const plan: FormalizationPlan = { schema: 'theorem-os.formalization-plan.v1', taskKind: 'prove',
    spans: [{ id: 'source', start: 0, end: fixtureStatement.length, text: fixtureStatement }],
    objects: [{ id: 'natural', spanIds: ['source'], description: 'A natural number.', leanType: 'Nat' }],
    assumptions: [], definitions: [], unresolved: [], conclusions: [{ id: 'identity', spanIds: ['source'],
      mathematics: 'For every natural n, n + 0 = n.', targetNames: ['addition'], assumptionIds: [] }] };
  const planDigest = formalizationDigest(plan);
  const planInput = { problemId: r.problemId, statement: r.statement, environment: r.environment,
    toolchain: getLeanTaskEnvironment(r.environment).toolchain, round, planningRound: planning?.round ?? 1 };
  const generationInput = { problemId: r.problemId, statement: r.statement, environment: r.environment,
    toolchain: getLeanTaskEnvironment(r.environment).toolchain, round, ...(workflow ? { plan, planDigest } : {}) };
  const session = (role: 'plan' | 'generate' | 'backtranslate' | 'compare', index: number,
    sessionInput: string, output: string, reviewerId?: string) => ({ role, threadId: 'synthetic-thread-' + index,
    turnId: 'synthetic-turn-' + index, status: 'completed' as const, inputDigest: sessionInput, outputDigest: output,
    model: author.model, effort: author.effort, usage: {},
    ...(workflow ? { configurationDigest: formalizationModelConfigurationDigest(author), ...(reviewerId ? { reviewerId } : {}) } : {}) });
  const sessions = workflow ? [
    session('plan', 0, formalizationDigest(planInput), planDigest),
    session('generate', 1, formalizationDigest(generationInput), formalizationDigest(candidate)),
    session('backtranslate', 2, snapshotDigest, translationDigest),
    ...workflow.reviewers.map((reviewer, index) => session('compare', index + 3,
      formalizationDigest({ inputDigest, snapshotDigest, translationDigest, planDigest, reviewerId: reviewer.id }),
      formalizationDigest(review), reviewer.id)),
  ] : [session('generate', 0, formalizationDigest(generationInput), formalizationDigest(candidate)),
    session('backtranslate', 1, snapshotDigest, translationDigest),
    session('compare', 2, formalizationDigest({ inputDigest, snapshotDigest, translationDigest }), formalizationDigest(review))];
  return { schema: workflow ? 'theorem-os.formalization-evidence.v2' : 'theorem-os.formalization-evidence.v1',
    status: 'approved', authority: 'model', method: 'independent-backtranslation-and-comparison', execution: 'replay',
    modelInvoked: false, proofVerified: false, request: r, requestDigest: formalizationDigest(r), candidate, inputDigest,
    generation: { input: generationInput, output: candidate }, sourceSha256: elaborated.sourceSha256,
    targets: elaborated.targets, snapshot: elaborated.snapshot, snapshotDigest, compilation: elaborated.compilation,
    translation, translationDigest, review, sessions, approvedAt: '2026-10-23T00:00:00Z', round,
    ...(workflow ? { workflow: { schema: 'theorem-os.formalization-workflow-evidence.v2',
      plan: { input: planInput, output: plan, digest: planDigest },
      reviews: workflow.reviewers.map(reviewer => ({ reviewerId: reviewer.id, review })),
      reviewAgreement: 'unanimous', distinctModelConfigurations: 1, profileDigest: 'b'.repeat(64),
      selectionPolicy: 'first-unanimously-approved' } } : {}) } as FormalizationEvidence;
}

describe('formalization unlimited execution contract', () => {
  it('defaults planning to zero and accepts zero for every execution limit', () => {
    expect(defaultFormalizationWorkflow(author).maxPlanningRounds).toBe(0);
    expect(request()).toMatchObject(limits);
    expect(formalizationWorkflowSchema.parse(defaultFormalizationWorkflow(author)).maxPlanningRounds).toBe(0);
  });

  it('retains explicit positive legacy limits and accepts safe values above the previous bounds', () => {
    expect(request({ maxRounds: 3, maxRunSeconds: 1800, maxTurnSeconds: 180, maxCompileSeconds: 180, maxTotalTokens: 8000 }))
      .toMatchObject({ maxRounds: 3, maxRunSeconds: 1800, maxTurnSeconds: 180, maxCompileSeconds: 180, maxTotalTokens: 8000 });
    for (const name of limitNames) expect(request({ [name]: Number.MAX_SAFE_INTEGER })[name]).toBe(Number.MAX_SAFE_INTEGER);
    const workflow = defaultFormalizationWorkflow(author);
    expect(formalizationWorkflowSchema.parse({ ...workflow, maxPlanningRounds: 6 }).maxPlanningRounds).toBe(6);
    expect(formalizationWorkflowSchema.parse({ ...workflow, maxPlanningRounds: Number.MAX_SAFE_INTEGER }).maxPlanningRounds)
      .toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])('rejects unsafe or negative execution limit %s', value => {
    for (const name of limitNames) expect(() => request({ [name]: value })).toThrow();
    expect(() => formalizationWorkflowSchema.parse({ ...defaultFormalizationWorkflow(author), maxPlanningRounds: value })).toThrow();
  });

  it('treats an optional reference time limit as the same nonnegative safe-integer contract', () => {
    const workflow = defaultFormalizationWorkflow(author), source = 'theorem gold (n : Nat) : n + 0 = n := by sorry\n';
    const reference = { source, sourceSha256: mathDigest(source), provenance: 'Synthetic reference only.',
      pairs: [{ candidateTarget: 'addition', referenceTarget: 'gold' }], maxSeconds: 0 };
    for (const maxSeconds of [0, 60, 3601, Number.MAX_SAFE_INTEGER])
      expect(formalizationWorkflowSchema.parse({ ...workflow, reference: { ...reference, maxSeconds } }).reference.maxSeconds).toBe(maxSeconds);
    for (const maxSeconds of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => formalizationWorkflowSchema.parse({ ...workflow, reference: { ...reference, maxSeconds } })).toThrow();
  });

  it('accepts approved evidence after many rounds when the candidate round limit is zero', () => {
    expect(() => assertFormalizationEvidence(evidenceFixture(0, 100))).not.toThrow();
  });

  it('accepts a host-validated output submission while preserving legacy natural completion', () => {
    const legacy = evidenceFixture(0, 1);
    expect(() => assertFormalizationEvidence(legacy)).not.toThrow();
    const submitted = structuredClone(legacy);
    for (const session of submitted.sessions) {
      session.status = 'submitted'; session.completionReason = 'validated-output';
    }
    expect(() => assertFormalizationEvidence(submitted)).not.toThrow();
    delete submitted.sessions[0].completionReason;
    expect(() => assertFormalizationEvidence(submitted)).toThrow();
    submitted.sessions[0].completionReason = 'validated-output';
    for (const status of ['failed', 'checkpoint']) {
      const invalid = structuredClone(submitted) as any;
      invalid.sessions[0].status = status;
      expect(() => assertFormalizationEvidence(invalid)).toThrow();
    }
  });

  it('continues enforcing a positive candidate-round limit on approved evidence', () => {
    expect(() => assertFormalizationEvidence(evidenceFixture(2, 2))).not.toThrow();
    expect(() => assertFormalizationEvidence(evidenceFixture(2, 3))).toThrow('formalization_evidence_input_mismatch');
  });

  it('accepts many planning attempts only when the planning limit is zero', () => {
    expect(() => assertFormalizationEvidence(evidenceFixture(0, 100, { limit: 0, round: 100 }))).not.toThrow();
    expect(() => assertFormalizationEvidence(evidenceFixture(2, 2, { limit: 2, round: 2 }))).not.toThrow();
    expect(() => assertFormalizationEvidence(evidenceFixture(2, 2, { limit: 2, round: 3 })))
      .toThrow('formalization_workflow_evidence_invalid');
  });
});
