import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { canonicalMathJson, mathDigest, readMathText, syncMathDirectory, writeMathFrozen, writeMathJsonDurable } from './mathRuntimeIo';
import { assertMathCanonicalPath } from './paths';
import { getLeanTaskEnvironment } from './leanTaskEnvironment';
import { bootstrapLeanTask, readLeanTaskReceipt } from './leanTask';
import { eraseFormalizationProofs, formalizationTargets } from './formalizationSource';
import { leanStatementContextCommands, leanStatementStructuresSchema, parseLeanStatementContexts } from './leanStatementContext';
import { LEAN_STATEMENT_CONTEXT_PROTOCOL, leanStatementContextProtocolSchema, leanStatementSemanticSchema } from './leanStatementSemantic';
import { formalizationRetrievalConfigurationSchema, formalizationRetrievalSchema, prepareFormalizationRetrieval,
  assertFormalizationRetrieval, type FormalizationRetrievalSource } from './formalizationRetrieval';
import { LAKE_CONFIGURATION_FILES } from './mathConstructionSources';
import { formalizationPlanSchema, assertFormalizationPlan, assertFormalizationPlanReady, assertFormalizationPlanCandidate } from './formalizationPlan';
import { formalizationWorkflowSchema, assertFormalizationWorkflow, formalizationModelConfigurationDigest,
  distinctFormalizationModelConfigurations } from './formalizationWorkflow';
import { formalizationReferenceResultSchema, assertFormalizationReferenceResult } from './formalizationReference';
import { assertStructuredSemanticReview, resolveReviewEnvironment,
  persistedStructuredSemanticReviewSchema,
  type ReviewStatementSnapshot, type StructuredReviewInput } from './formalizationSemanticReview';
import { fidelityPolicySchema, fidelityReferenceInput } from './formalizationFidelity';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1).max(32_000).refine(value => value.trim().length > 0);
const original = z.string().min(1).max(256 * 1024).refine(value => value.trim().length > 0 &&
  Buffer.byteLength(value, 'utf8') <= 256 * 1024 && Buffer.from(value, 'utf8').toString('utf8') === value &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value));
const target = z.object({ name: text, declarationHash: hash }).strict();
// Zero removes the corresponding execution limit; positive values preserve legacy bounded requests.
const executionLimit = z.number().int().safe().nonnegative();
export const formalizationNotesSchema = z.object({
  coverage: z.array(z.object({ originalText: text, targetNames: z.array(text).min(1).max(256), explanation: text }).strict()).min(1).max(256),
  assumptions: z.array(text).max(256), assumptionsExplanation: text, definitionsExplanation: text,
}).strict();
export const formalizationCandidateSchema = formalizationNotesSchema.extend({ source: z.string().min(1).max(128 * 1024) }).strict();
const generationInputSchema = z.object({
  problemId: text, statement: original, environment: z.enum(['standard', 'mathlib']), toolchain: text,
  round: z.number().int().positive(), feedback: z.string().max(16_000).optional(),
  previousCandidate: formalizationCandidateSchema.optional(),
  plan: formalizationPlanSchema.optional(), planDigest: hash.optional(),
  retrieval: formalizationRetrievalSchema.optional(),
}).strict();
export const formalizationPlanningInputSchema = z.object({
  problemId: text, statement: original, environment: z.enum(['standard', 'mathlib']), toolchain: text,
  round: z.number().int().positive(), planningRound: z.number().int().positive(), feedback: z.string().max(16_000).optional(),
}).strict();
export const formalizationRequestSchema = z.object({
  schema: z.enum(['theorem-os.formalization-request.v1', 'theorem-os.formalization-request.v2', 'theorem-os.formalization-request.v3']), problemId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
  statement: original, statementSha256: hash, environment: z.enum(['standard', 'mathlib']), environmentDigest: hash,
  execution: z.enum(['model', 'replay']), model: text, effort: text, profile: text, executable: text,
  buildManifestRef: text, buildDigest: hash, maxRounds: executionLimit,
  maxRunSeconds: executionLimit, maxTurnSeconds: executionLimit,
  maxCompileSeconds: executionLimit, maxTotalTokens: executionLimit,
  workflow: formalizationWorkflowSchema.optional(),
  contextProtocol: leanStatementContextProtocolSchema.optional(),
  fidelityPolicy: fidelityPolicySchema.optional(),
  retrieval: formalizationRetrievalConfigurationSchema.optional(),
}).strict();
export type FormalizationRequest = z.infer<typeof formalizationRequestSchema>;
export type FormalizationCandidate = z.infer<typeof formalizationCandidateSchema>;

export const formalizationTranslationSchema = z.object({
  snapshotDigest: hash, mathematics: text, assumptions: z.array(text).max(256), definitions: z.array(text).max(256),
  targets: z.array(z.object({ name: text, mathematics: text }).strict()).min(1).max(256),
}).strict();
export const formalizationReviewSchema = z.object({
  inputDigest: hash, snapshotDigest: hash, translationDigest: hash,
  verdict: z.enum(['approved', 'changes_requested', 'unknown']), summary: text,
  checks: z.object({ equivalent: z.boolean(), complete: z.boolean(), assumptions: z.boolean(), definitions: z.boolean() }).strict(),
  issues: z.array(text).max(256),
}).strict();
export type FormalizationTranslation = z.infer<typeof formalizationTranslationSchema>;
export type FormalizationReview = z.infer<typeof formalizationReviewSchema>;
const evidenceReviewSchema = z.union([formalizationReviewSchema, persistedStructuredSemanticReviewSchema]);

const contextSchema = z.object({
  type: text, constants: z.array(z.object({ name: z.string(), module: z.string(), type: z.string(), definition: z.string().optional() }).strict()).max(256),
  omitted: z.array(z.string()).max(257),
  references: z.object({ statement: z.array(z.object({ name: z.string(), file: z.string() }).strict()), proof: z.array(z.unknown()).length(0) }).strict().optional(),
  bindings: z.object({
    binders: z.array(z.object({ id: text, name: text, type: text,
      kind: z.enum(['explicit', 'implicit', 'strictImplicit', 'instanceImplicit']), dependencies: z.array(text).max(256),
    }).strict()).max(256),
    conclusion: text, conclusionDependencies: z.array(text).max(256),
  }).strict().optional(),
  semantic: leanStatementSemanticSchema.optional(),
  structures: leanStatementStructuresSchema.optional(),
}).strict();
export const formalizationSnapshotSchema = z.object({
  schema: z.literal('theorem-os.formalization-snapshot.v1'), source: z.string().min(1).max(128 * 1024),
  sourceSha256: hash, environment: z.enum(['standard', 'mathlib']), environmentDigest: hash,
  targets: z.array(target.extend({ context: contextSchema }).strict()).min(1).max(256),
}).strict();
const sessionSchema = z.object({
  role: z.enum(['plan', 'generate', 'backtranslate', 'compare']), threadId: text, turnId: text,
  status: z.enum(['completed', 'submitted']), completionReason: z.literal('validated-output').optional(),
  inputDigest: hash, outputDigest: hash, model: text, effort: text,
  usage: z.record(z.unknown()),
  reviewerId: z.string().optional(), configurationDigest: hash.optional(),
}).strict().superRefine((session, context) => {
  if (session.status === 'submitted' && session.completionReason !== 'validated-output')
    context.addIssue({ code: 'custom', message: 'Submitted formalization sessions require validated-output completion.' });
});
const workflowEvidenceSchema = z.object({
  schema: z.enum(['theorem-os.formalization-workflow-evidence.v2', 'theorem-os.formalization-workflow-evidence.v3']),
  plan: z.object({ input: formalizationPlanningInputSchema, output: formalizationPlanSchema, digest: hash }).strict(),
  reviews: z.array(z.object({ reviewerId: text, review: evidenceReviewSchema,
    correspondence: formalizationReferenceResultSchema.optional() }).strict()).min(1).max(5),
  reviewAgreement: z.literal('unanimous'), distinctModelConfigurations: z.number().int().positive(),
  profileDigest: hash,
  selectionPolicy: z.literal('first-unanimously-approved'),
  reference: formalizationReferenceResultSchema.optional(),
}).strict();
export const formalizationEvidenceSchema = z.object({
  schema: z.enum(['theorem-os.formalization-evidence.v1', 'theorem-os.formalization-evidence.v2', 'theorem-os.formalization-evidence.v3']), status: z.literal('approved'),
  authority: z.literal('model'), method: z.literal('independent-backtranslation-and-comparison'),
  execution: z.enum(['model', 'replay']), modelInvoked: z.boolean(), proofVerified: z.literal(false),
  request: formalizationRequestSchema, requestDigest: hash, candidate: formalizationCandidateSchema, inputDigest: hash,
  generation: z.object({ input: generationInputSchema, output: formalizationCandidateSchema }).strict(),
  sourceSha256: hash, targets: z.array(target).min(1).max(256),
  snapshot: formalizationSnapshotSchema, snapshotDigest: hash,
  compilation: z.object({
    exitCode: z.literal(0), timedOut: z.literal(false), sourceSha256: hash,
    environmentDigest: hash, diagnostics: z.record(z.unknown()),
  }).strict(),
  translation: formalizationTranslationSchema, translationDigest: hash, review: evidenceReviewSchema,
  sessions: z.array(sessionSchema).min(3).max(8), approvedAt: z.string().datetime(), round: z.number().int().positive(),
  workflow: workflowEvidenceSchema.optional(),
}).strict();
export type FormalizationEvidence = z.infer<typeof formalizationEvidenceSchema>;

export const formalizationDigest = (value: unknown): string => mathDigest(canonicalMathJson(value));
export const formalizationInputDigest = (request: FormalizationRequest, candidate: FormalizationCandidate): string =>
  formalizationDigest({ requestDigest: formalizationDigest(request), candidate });

/** Only the source, host observation and blind translation cross the shared semantic review seam. */
export function formalizationReviewInput(request: FormalizationRequest, candidate: FormalizationCandidate,
  snapshot: z.infer<typeof formalizationSnapshotSchema>, translation: FormalizationTranslation,
  reviewer: { reviewerId?: string; planDigest?: string } = {}): StructuredReviewInput {
  const inputDigest = formalizationInputDigest(request, candidate), caseId = 'case_' + inputDigest;
  const environment = getLeanTaskEnvironment(request.environment);
  return { schema: 'theorem-os.formalization-review-input.v2', role: 'recheck', caseId, baseInputDigest: inputDigest,
    original: request.statement, header: '', candidate: candidate.source,
    observation: { schema: 'theorem-os.formalization-review-observation.v2', caseId, inputDigest,
      sourceSha256: snapshot.sourceSha256,
      environment: resolveReviewEnvironment({ sourceToolchain: environment.toolchain,
        ...(environment.mathlibRevision ? { sourceMathlibRevision: environment.mathlibRevision } : {}) }, request.environment),
      status: 'elaborated', snapshot: snapshot as ReviewStatementSnapshot,
      snapshotDigest: formalizationDigest(snapshot), diagnostics: '' },
    translation, ...reviewer, ...(request.fidelityPolicy ? { fidelityPolicy: request.fidelityPolicy } : {}) };
}

export function assertFormalizationCandidate(request: FormalizationRequest, candidate: FormalizationCandidate): { name: string; declarationHash: string }[] {
  const targets = formalizationTargets(candidate.source), names = new Set(targets.map(item => item.name)), covered = new Set<string>();
  for (const item of candidate.coverage) {
    if (!request.statement.includes(item.originalText) || item.targetNames.some(name => !names.has(name)))
      throw new Error('formalization_coverage_invalid');
    item.targetNames.forEach(name => covered.add(name));
  }
  if (covered.size !== names.size) throw new Error('formalization_coverage_invalid');
  return targets;
}

export function prepareFormalization(directory: string, input: Omit<FormalizationRequest,
  'schema' | 'statementSha256' | 'environmentDigest' | 'buildDigest' | 'retrieval'> &
  { retrieval?: FormalizationRetrievalSource }): FormalizationRequest {
  directory = path.resolve(directory); assertMathCanonicalPath(directory);
  if (fs.existsSync(directory)) throw new Error('formalization_directory_exists');
  const { retrieval: retrievalSource, ...base } = input;
  const retrieval = retrievalSource ? prepareFormalizationRetrieval(retrievalSource, input.environment) : undefined;
  const request = formalizationRequestSchema.parse({ ...base, schema: 'theorem-os.formalization-request.v3',
    contextProtocol: input.contextProtocol ?? LEAN_STATEMENT_CONTEXT_PROTOCOL,
    ...(retrieval ? { retrieval: retrieval.configuration } : {}),
    statementSha256: mathDigest(input.statement), environmentDigest: getLeanTaskEnvironment(input.environment).dependencyDigest,
    buildDigest: mathDigest(readMathText(input.buildManifestRef, 8_000_000)) });
  assertRequestWorkflow(request);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (retrieval) writeMathFrozen(path.join(directory, 'retrieval-corpus.json'), retrieval.corpusText);
  writeMathJsonDurable(path.join(directory, 'request.json'), request, 0o400);
  return request;
}

export function readFormalizationRequest(directory: string): FormalizationRequest {
  assertMathCanonicalPath(path.resolve(directory, 'request.json'));
  const request = formalizationRequestSchema.parse(JSON.parse(readMathText(path.join(directory, 'request.json'), 2_000_000)));
  assertRequestWorkflow(request);
  if (mathDigest(request.statement) !== request.statementSha256 ||
      getLeanTaskEnvironment(request.environment).dependencyDigest !== request.environmentDigest)
    throw new Error('formalization_request_identity_changed');
  return request;
}

function assertRequestWorkflow(request: FormalizationRequest): void {
  if (request.fidelityPolicy && (request.schema !== 'theorem-os.formalization-request.v3' || !request.workflow))
    throw new Error('formalization_fidelity_requires_planned_v3');
  if (request.retrieval && (request.schema !== 'theorem-os.formalization-request.v3' || !request.workflow || request.environment !== 'mathlib'))
    throw new Error('formalization_retrieval_requires_planned_mathlib_v3');
  if (request.retrieval) {
    const environment = getLeanTaskEnvironment(request.environment);
    if (request.retrieval.environmentDigest !== request.environmentDigest || request.retrieval.toolchain !== environment.toolchain ||
        request.retrieval.mathlibRevision !== environment.mathlibRevision)
      throw new Error('formalization_retrieval_environment_mismatch');
  }
  if (request.schema !== 'theorem-os.formalization-request.v3' && request.contextProtocol !== undefined)
    throw new Error('formalization_request_context_protocol_version_mismatch');
  if (request.schema !== 'theorem-os.formalization-request.v3' &&
      (request.schema === 'theorem-os.formalization-request.v2') !== Boolean(request.workflow))
    throw new Error('formalization_request_workflow_version_mismatch');
  if (request.workflow) assertFormalizationWorkflow(request.workflow);
}

/** These checks bind host observations; they do not turn a model's semantic judgment into a mathematical proof. */
export function assertFormalizationEvidence(evidence: FormalizationEvidence): void {
  const e = formalizationEvidenceSchema.parse(evidence), r = e.request;
  assertRequestWorkflow(r);
  if (Boolean(r.retrieval) !== Boolean(e.generation.input.retrieval)) throw new Error('formalization_retrieval_input_mismatch');
  if (r.retrieval) {
    if (!e.generation.input.plan) throw new Error('formalization_retrieval_input_mismatch');
    assertFormalizationRetrieval(r.retrieval, e.generation.input.plan, e.generation.input.retrieval!);
  }
  const structured = r.schema === 'theorem-os.formalization-request.v3';
  if (r.contextProtocol === 'kernel-v2' && e.snapshot.targets.some(item => !item.context.structures))
    throw new Error('formalization_context_missing_structures');
  if ((e.schema === 'theorem-os.formalization-evidence.v3') !== structured ||
      !structured && (e.schema === 'theorem-os.formalization-evidence.v2') !== Boolean(r.workflow) ||
      Boolean(e.workflow) !== Boolean(r.workflow) || e.workflow && e.workflow.schema !== (structured ?
        'theorem-os.formalization-workflow-evidence.v3' : 'theorem-os.formalization-workflow-evidence.v2'))
    throw new Error('formalization_evidence_workflow_version_mismatch');
  if (e.requestDigest !== formalizationDigest(r) || r.statementSha256 !== mathDigest(r.statement) ||
      r.environmentDigest !== getLeanTaskEnvironment(r.environment).dependencyDigest ||
      e.execution !== r.execution || e.modelInvoked !== (r.execution === 'model') ||
      e.inputDigest !== formalizationInputDigest(r, e.candidate) || r.maxRounds > 0 && e.round > r.maxRounds)
    throw new Error('formalization_evidence_input_mismatch');
  const targets = assertFormalizationCandidate(r, e.candidate);
  if (e.sourceSha256 !== mathDigest(e.candidate.source) || e.snapshot.source !== e.candidate.source ||
      e.snapshot.sourceSha256 !== e.sourceSha256 || e.snapshot.environment !== r.environment ||
      e.snapshot.environmentDigest !== r.environmentDigest || e.snapshotDigest !== formalizationDigest(e.snapshot) ||
      canonicalMathJson(e.targets) !== canonicalMathJson(targets) ||
      canonicalMathJson(e.snapshot.targets.map(({ context: _context, ...item }) => item)) !== canonicalMathJson(targets) ||
      e.snapshot.targets.some(item => item.context.omitted.length > 0) ||
      e.compilation.sourceSha256 !== e.sourceSha256 || e.compilation.diagnostics.exitCode !== 0 ||
      e.compilation.diagnostics.timedOut !== false ||
      e.compilation.diagnostics.environmentDigest !== e.compilation.environmentDigest)
    throw new Error('formalization_evidence_compilation_mismatch');
  assertCompilationEvidence(e);
  const names = targets.map(item => item.name).sort();
  if (e.translation.snapshotDigest !== e.snapshotDigest || e.translationDigest !== formalizationDigest(e.translation) ||
      canonicalMathJson(e.translation.targets.map(item => item.name).sort()) !== canonicalMathJson(names))
    throw new Error('formalization_evidence_review_mismatch');
  const reviewInputDigest = assertEvidenceReview(e, e.review, r.workflow ?
    { planDigest: e.workflow!.plan.digest, reviewerId: r.workflow.reviewers[0]!.id } : undefined);
  if (!r.workflow && (canonicalMathJson(e.sessions.map(item => item.role)) !== canonicalMathJson(['generate', 'backtranslate', 'compare']) ||
      new Set(e.sessions.map(item => item.threadId)).size !== 3 ||
      e.sessions.some(item => item.model !== r.model || item.effort !== r.effort) ||
      e.generation.input.problemId !== r.problemId || e.generation.input.statement !== r.statement ||
      e.generation.input.environment !== r.environment || e.generation.input.toolchain !== getLeanTaskEnvironment(r.environment).toolchain ||
      e.generation.input.round !== e.round || e.sessions[0]!.inputDigest !== formalizationDigest(e.generation.input) ||
      e.sessions[0]!.outputDigest !== formalizationDigest(e.generation.output) ||
      canonicalMathJson({ ...e.generation.output, source: eraseFormalizationProofs(e.generation.output.source) }) !== canonicalMathJson(e.candidate) ||
      eraseFormalizationProofs(e.candidate.source) !== e.candidate.source ||
      e.sessions[1]!.inputDigest !== e.snapshotDigest || e.sessions[1]!.outputDigest !== e.translationDigest ||
      e.sessions[2]!.inputDigest !== reviewInputDigest ||
      e.sessions[2]!.outputDigest !== formalizationDigest(e.review) || e.generation.input.plan !== undefined ||
      e.generation.input.planDigest !== undefined || e.sessions.some(item => item.reviewerId !== undefined || item.configurationDigest !== undefined)))
    throw new Error('formalization_evidence_session_mismatch');
  if (r.workflow) assertWorkflowEvidence(e);
}

function assertEvidenceReview(e: FormalizationEvidence, value: FormalizationEvidence['review'],
  reviewer?: { reviewerId: string; planDigest: string }): string {
  if (e.request.schema === 'theorem-os.formalization-request.v3') {
    const input = formalizationReviewInput(e.request, e.candidate, e.snapshot, e.translation, reviewer);
    const review = assertStructuredSemanticReview(input, value);
    if (review.verdict !== 'approved') throw new Error('formalization_evidence_review_mismatch');
    return formalizationDigest(input);
  }
  const review = formalizationReviewSchema.parse(value);
  if (review.inputDigest !== e.inputDigest || review.snapshotDigest !== e.snapshotDigest ||
      review.translationDigest !== e.translationDigest || review.verdict !== 'approved' ||
      review.issues.length || Object.values(review.checks).some(value => !value))
    throw new Error('formalization_evidence_review_mismatch');
  return formalizationDigest({ inputDigest: e.inputDigest, snapshotDigest: e.snapshotDigest,
    translationDigest: e.translationDigest, ...reviewer });
}

function assertWorkflowEvidence(e: FormalizationEvidence): void {
  const r = e.request, w = r.workflow!, observed = e.workflow!;
  const fail = () => { throw new Error('formalization_workflow_evidence_invalid'); };
  assertFormalizationPlan(r.statement, observed.plan.output);
  assertFormalizationPlanReady(observed.plan.output);
  assertFormalizationPlanCandidate(observed.plan.output, e.candidate.source, e.candidate.coverage);
  const planInput = observed.plan.input;
  const { model, effort, profile, executable } = r;
  const author = { model, effort, profile, executable };
  const configs = [w.planner, author, w.backtranslator, ...w.reviewers];
  if (observed.plan.digest !== formalizationDigest(observed.plan.output) ||
      planInput.problemId !== r.problemId || planInput.statement !== r.statement || planInput.environment !== r.environment ||
      planInput.toolchain !== getLeanTaskEnvironment(r.environment).toolchain || planInput.round !== e.round ||
      w.maxPlanningRounds > 0 && planInput.planningRound > w.maxPlanningRounds ||
      e.generation.input.problemId !== r.problemId || e.generation.input.statement !== r.statement ||
      e.generation.input.environment !== r.environment || e.generation.input.toolchain !== planInput.toolchain ||
      e.generation.input.round !== e.round || e.generation.input.planDigest !== observed.plan.digest ||
      canonicalMathJson(e.generation.input.plan) !== canonicalMathJson(observed.plan.output) ||
      canonicalMathJson({ ...e.generation.output, source: eraseFormalizationProofs(e.generation.output.source) }) !== canonicalMathJson(e.candidate) ||
      eraseFormalizationProofs(e.candidate.source) !== e.candidate.source ||
      observed.distinctModelConfigurations !== distinctFormalizationModelConfigurations(author, w) ||
      observed.reviews.length !== w.reviewers.length ||
      canonicalMathJson(observed.reviews.map(item => item.reviewerId)) !== canonicalMathJson(w.reviewers.map(item => item.id)) ||
      canonicalMathJson(e.review) !== canonicalMathJson(observed.reviews[0]!.review) ||
      e.sessions.length !== 3 + w.reviewers.length ||
      canonicalMathJson(e.sessions.map(item => item.role)) !== canonicalMathJson(['plan', 'generate', 'backtranslate', ...w.reviewers.map(() => 'compare')]) ||
      new Set(e.sessions.map(item => item.threadId)).size !== e.sessions.length ||
      e.sessions.some((item, index) => item.model !== configs[index]!.model || item.effort !== configs[index]!.effort ||
        item.configurationDigest !== formalizationModelConfigurationDigest(configs[index]!) ||
        item.reviewerId !== (index >= 3 ? w.reviewers[index - 3]!.id : undefined)) ||
      e.sessions[0]!.inputDigest !== formalizationDigest(planInput) || e.sessions[0]!.outputDigest !== observed.plan.digest ||
      e.sessions[1]!.inputDigest !== formalizationDigest(e.generation.input) || e.sessions[1]!.outputDigest !== formalizationDigest(e.generation.output) ||
      e.sessions[2]!.inputDigest !== e.snapshotDigest || e.sessions[2]!.outputDigest !== e.translationDigest) return fail();
  for (let index = 0; index < observed.reviews.length; index++) {
    const { reviewerId, review, correspondence } = observed.reviews[index]!;
    let inputDigest: string;
    try { inputDigest = assertEvidenceReview(e, review, { planDigest: observed.plan.digest, reviewerId }); }
    catch { return fail(); }
    if (e.sessions[index + 3]!.inputDigest !== inputDigest ||
        e.sessions[index + 3]!.outputDigest !== formalizationDigest(review)) return fail();
    if (r.fidelityPolicy) {
      if (!('fidelity' in review) || !review.fidelity || !correspondence) return fail();
      assertFormalizationReferenceResult(fidelityReferenceInput(e.snapshot as ReviewStatementSnapshot, review.fidelity), correspondence);
      if (correspondence.status !== 'established') return fail();
    } else if (correspondence) return fail();
  }
  if (Boolean(w.reference) !== Boolean(observed.reference)) return fail();
  if (w.reference && observed.reference) {
    assertFormalizationReferenceResult({ candidateSource: e.candidate.source, referenceSource: w.reference.source,
      environment: r.environment, pairs: w.reference.pairs }, observed.reference);
    if (observed.reference.status !== 'established') return fail();
  }
}

function assertCompilationEvidence(e: FormalizationEvidence): void {
  const diagnostics = e.compilation.diagnostics, latest = diagnostics.latest as Record<string, unknown> | undefined;
  const config = getLeanTaskEnvironment(e.request.environment);
  const query = 'import Lean\nimport Formalization\n' + leanStatementContextCommands(
    e.targets.map(item => ({ id: item.name, name: item.name })), [{ module: 'Formalization', file: 'Formalization.lean' }],
    '.lake/formalization-context.json', e.request.schema === 'theorem-os.formalization-request.v3' ?
      { detailedContext: true, ...(e.request.contextProtocol ? { semanticContext: true } : {}),
        ...(e.request.contextProtocol === 'kernel-v2' ? { structureContext: true } : {}) } : undefined) + '\n';
  const records = diagnostics.artifactRecords as { digest: string; text: string }[] | undefined;
  const references = diagnostics.diagnosticArtifacts as { digest: string; sourceDigest: string; environmentDigest: string; captureComplete: boolean }[] | undefined;
  const sourceFiles = latest?.sourceFiles as { file: string; digest: string }[] | undefined;
  const configuration = latest?.configuration as { file: string; digest: string | null }[] | undefined;
  const fail = () => { throw new Error('formalization_compilation_evidence_invalid'); };
  if (!latest || latest.schema !== 'theoremos.lean-diagnostics-latest.v1' || latest.authority !== 'advisory-lean-process' ||
      latest.exitCode !== 0 || latest.timedOut !== false || latest.aborted !== false ||
      latest.sourceDigest !== diagnostics.sourceDigest || latest.environmentDigest !== e.compilation.environmentDigest ||
      latest.toolIdentity !== diagnostics.toolIdentity || !hash.safeParse(diagnostics.toolIdentity).success ||
      !Array.isArray(configuration) || configuration.length !== LAKE_CONFIGURATION_FILES.length ||
      configuration.some((item, index) => item.file !== LAKE_CONFIGURATION_FILES[index] ||
        (item.file === '.lake/package-overrides.json' && e.request.environment === 'mathlib' ? !hash.safeParse(item.digest).success :
          item.digest !== (config.files[item.file] ? mathDigest(config.files[item.file]!) : null))) ||
      !sourceFiles || sourceFiles.length !== 2 ||
      sourceFiles.find(item => item.file === 'Formalization.lean')?.digest !== e.sourceSha256 ||
      sourceFiles.find(item => item.file === 'FormalizationContext.lean')?.digest !== mathDigest(query) ||
      diagnostics.sourceDigest !== mathDigest(JSON.stringify([configuration.map(item => item.digest ?? ''),
        sourceFiles.map(item => [item.file, item.digest])])) ||
      !Array.isArray(records) || !records.length || !Array.isArray(references) || records.length !== references.length ||
      new Set(records.map(item => item.digest)).size !== records.length) return fail();
  for (const record of records) {
    if (typeof record.text !== 'string' || mathDigest(record.text) !== record.digest) return fail();
    const reference = references.find(item => item.digest === record.digest);
    const artifact = JSON.parse(record.text) as Record<string, unknown>;
    if (!reference || reference.captureComplete !== true || reference.sourceDigest !== diagnostics.sourceDigest ||
        reference.environmentDigest !== e.compilation.environmentDigest || artifact.schema !== 'theoremos.lean-diagnostics.v1' ||
        artifact.authority !== 'advisory-lean-process' || artifact.sourceCurrent !== true || artifact.exitCode !== 0 ||
        artifact.timedOut !== false || artifact.aborted !== false || artifact.captureComplete !== true ||
        artifact.sourceDigest !== diagnostics.sourceDigest || artifact.environmentDigest !== e.compilation.environmentDigest ||
        artifact.toolIdentity !== diagnostics.toolIdentity || canonicalMathJson(artifact.sourceFiles) !== canonicalMathJson(sourceFiles) ||
        typeof artifact.stdout !== 'string' || typeof artifact.stderr !== 'string' ||
        mathDigest(artifact.stdout) !== artifact.stdoutSha256 || mathDigest(artifact.stderr) !== artifact.stderrSha256) return fail();
  }
  const exported = diagnostics.contextExport as { path: string; digest: string; text: string } | undefined;
  if (!exported || exported.path !== '.lake/formalization-context.json' || typeof exported.text !== 'string' ||
      mathDigest(exported.text) !== exported.digest) return fail();
  const contexts = parseLeanStatementContexts(exported.text, e.targets.map(item => item.name));
  if (e.request.schema === 'theorem-os.formalization-request.v3' && [...contexts.values()].some(context => !context.bindings)) return fail();
  if (e.request.contextProtocol && [...contexts.values()].some(context => !context.semantic)) return fail();
  if (e.request.contextProtocol === 'kernel-v2' && [...contexts.values()].some(context => !context.structures))
    throw new Error('formalization_context_missing_structures');
  if (e.snapshot.targets.some(item => canonicalMathJson(item.context) !== canonicalMathJson(contexts.get(item.name)))) return fail();
}

export function writeFormalizationArtifact(directory: string, evidence: FormalizationEvidence): string {
  assertFormalizationEvidence(evidence);
  const artifact = path.resolve(directory, 'artifact'); assertMathCanonicalPath(artifact);
  if (fs.existsSync(artifact)) throw new Error('formalization_artifact_exists');
  const staging = path.join(path.resolve(directory), '.artifact-' + crypto.randomUUID());
  fs.mkdirSync(staging, { mode: 0o700 });
  writeMathFrozen(path.join(staging, 'Statement.lean'), evidence.candidate.source);
  writeMathFrozen(path.join(staging, 'original.txt'), evidence.request.statement);
  writeMathJsonDurable(path.join(staging, 'evidence.json'), evidence, 0o400);
  readFormalizationArtifact(staging);
  fs.renameSync(staging, artifact);
  syncMathDirectory(path.resolve(directory));
  return artifact;
}

export function readFormalizationArtifact(artifact: string): FormalizationEvidence {
  artifact = path.resolve(artifact);
  for (const name of ['Statement.lean', 'original.txt', 'evidence.json']) assertMathCanonicalPath(path.join(artifact, name));
  const evidence = formalizationEvidenceSchema.parse(JSON.parse(readMathText(path.join(artifact, 'evidence.json'), 16_000_000)));
  assertFormalizationEvidence(evidence);
  if (readMathText(path.join(artifact, 'Statement.lean'), 128 * 1024) !== evidence.candidate.source ||
      readMathText(path.join(artifact, 'original.txt'), 256 * 1024) !== evidence.request.statement)
    throw new Error('formalization_artifact_changed');
  return evidence;
}

/** Creates only a frozen proof task. Proof search and final S3 acceptance remain the native solver's responsibility. */
export function bootstrapFormalizedProblem(directory: string) {
  const artifact = path.join(directory, 'artifact'), evidence = readFormalizationArtifact(artifact);
  const workspace = path.join(directory, 'workspace'), taskFile = path.join(directory, 'task.md');
  const shortTask = 'Prove every frozen target of ' + evidence.request.problemId + '.\nOriginal SHA256: ' +
    evidence.request.statementSha256 + '\nFormalization evidence SHA256: ' + formalizationDigest(evidence) +
    '\nStatement review authority: model. Preserve all definitions, assumptions and target declarations.';
  if (!fs.existsSync(workspace)) {
    const staging = path.join(path.resolve(directory), '.workspace-' + crypto.randomUUID());
    const prepared = bootstrapLeanTask(staging, { source: evidence.candidate.source, task: shortTask, environment: evidence.request.environment });
    writeMathJsonDurable(path.join(staging, 'active-problem.json'), { ...prepared, workspaceRoot: workspace,
      projectRoot: path.join(workspace, 'generated/problem'), activeProblemPath: path.join(workspace, 'active-problem.json') });
    fs.renameSync(staging, workspace);
    syncMathDirectory(path.resolve(directory));
  }
  const receipt = readLeanTaskReceipt(path.join(workspace, 'active-problem.json'));
  if (receipt.contract.formalStatement !== evidence.candidate.source || receipt.contract.informalStatement !== shortTask ||
      receipt.environmentDigest !== evidence.request.environmentDigest)
    throw new Error('formalization_solver_seed_changed');
  const task = shortTask + '\n\nOriginal problem (verbatim):\n\n' + evidence.request.statement + '\n';
  if (fs.existsSync(taskFile)) {
    if (readMathText(taskFile, 300_000) !== task) throw new Error('formalization_solver_task_changed');
  } else {
    const staging = path.join(path.resolve(directory), '.task-' + crypto.randomUUID());
    writeMathFrozen(staging, task);
    fs.renameSync(staging, taskFile);
    syncMathDirectory(path.resolve(directory));
  }
  return { artifact, workspaceRoot: workspace, receiptFile: receipt.activeProblemPath, taskFile,
    runArguments: ['--workspace', workspace, '--receipt-file', receipt.activeProblemPath, '--task-file', taskFile,
      '--build-manifest', evidence.request.buildManifestRef, '--output', path.join(directory, 'result.json')] };
}
