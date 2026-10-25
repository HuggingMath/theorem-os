import { z } from 'zod';
import { formalizationEvaluationInputDigest, formalizationEvaluationLeanSource, type FormalizationEvaluationReviewerInput } from './formalizationEvaluation';
import { formalizationTranslationSchema, type FormalizationTranslation } from './formalization';
import { getStructuredFormalizationReviewOutputSchema } from './formalizationRoleContract';
import { parseLeanStatementContexts } from './leanStatementContext';
import { leanStatementContextProtocolSchema, type LeanStatementContextProtocol } from './leanStatementSemantic';
import { canonicalMathJson, mathDigest } from './mathRuntimeIo';
import { eraseFormalizationProofs } from './formalizationSource';
import { fidelityPolicySchema } from './formalizationFidelity';
import { structuredReviewDigest,
  type ReviewEnvironmentContext, type ReviewStatementObservation, type StructuredReviewInput, type StructuredSemanticReview,
} from './formalizationSemanticReview';
export * from './formalizationSemanticReview';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1).max(16_000).refine(value => value.trim().length > 0);
const caseId = z.string().regex(/^case_[a-f0-9]{64}$/u);
const environment = z.enum(['auto', 'standard', 'mathlib', 'mathlib-4.8']);
export const structuredReviewConfigurationSchema = z.discriminatedUnion('execution', [
  z.object({ execution: z.literal('replay'), protocol: z.literal('v2'), replayFile: text, environment,
    contextProtocol: leanStatementContextProtocolSchema.optional(), fidelityPolicy: fidelityPolicySchema.optional() }).strict(),
  z.object({ execution: z.literal('model'), protocol: z.literal('v2'), model: text, effort: text,
    profile: text, executable: text, buildManifestRef: text, environment,
    contextProtocol: leanStatementContextProtocolSchema.optional(), fidelityPolicy: fidelityPolicySchema.optional() }).strict(),
]);
export type StructuredReviewConfiguration = z.infer<typeof structuredReviewConfigurationSchema>;
export const structuredReviewReplaySchema = z.object({
  schema: z.literal('theorem-os.formalization-review-replay.v2'), bundleDigest: hash,
  observations: z.array(z.unknown()).max(50_000),
  roles: z.array(z.object({ caseId, role: z.enum(['primary', 'backtranslate', 'recheck']), output: z.unknown() }).strict()).max(150_000),
}).strict();
export function assertReviewStatementObservation(input: FormalizationEvaluationReviewerInput,
  environment: ReviewEnvironmentContext, value: unknown, contextProtocol?: LeanStatementContextProtocol): ReviewStatementObservation {
  const observation = z.object({ schema: z.literal('theorem-os.formalization-review-observation.v2'),
    caseId, inputDigest: hash, sourceSha256: hash, environment: z.unknown(),
    status: z.enum(['elaborated', 'unavailable']), snapshot: z.unknown(), snapshotDigest: hash.nullable(),
    diagnostics: z.string().max(16_000) }).strict().parse(value) as ReviewStatementObservation;
  if (observation.caseId !== input.caseId || observation.inputDigest !== formalizationEvaluationInputDigest(input) ||
      structuredReviewDigest(observation.environment) !== structuredReviewDigest(environment))
    throw new Error('formalization_review_observation_identity_mismatch');
  if (observation.status === 'unavailable') {
    if (observation.snapshot !== null || observation.snapshotDigest !== null || !observation.diagnostics.trim())
      throw new Error('formalization_review_observation_invalid');
    return observation;
  }
  const snapshot = observation.snapshot;
  if (environment.compatibility !== 'matched' || !snapshot || snapshot.schema !== 'theorem-os.formalization-snapshot.v1' ||
      snapshot.environment !== environment.environment || snapshot.environmentDigest !== environment.environmentDigest ||
      snapshot.source !== eraseFormalizationProofs(formalizationEvaluationLeanSource(input)) ||
      snapshot.sourceSha256 !== mathDigest(snapshot.source) || observation.sourceSha256 !== snapshot.sourceSha256 ||
      observation.snapshotDigest !== structuredReviewDigest(snapshot) || !Array.isArray(snapshot.targets) || !snapshot.targets.length)
    throw new Error('formalization_review_observation_invalid');
  const names = snapshot.targets.map(target => target.name);
  if (new Set(names).size !== names.length || snapshot.targets.some(target => !hash.safeParse(target.declarationHash).success))
    throw new Error('formalization_review_observation_invalid');
  const contexts = parseLeanStatementContexts(JSON.stringify(snapshot.targets.map(target =>
    ({ id: target.name, context: target.context }))), names);
  if ([...contexts.values()].some(context => !context.bindings))
    throw new Error('formalization_review_observation_missing_bindings');
  if (contextProtocol && [...contexts.values()].some(context => !context.semantic))
    throw new Error('formalization_review_observation_missing_semantic_context');
  if (contextProtocol === 'kernel-v2' && [...contexts.values()].some(context => !context.structures))
    throw new Error('formalization_review_observation_missing_structure_context');
  return observation;
}

export function structuredReviewInput(input: FormalizationEvaluationReviewerInput,
  observation: ReviewStatementObservation, translation: FormalizationTranslation | null = null,
  fidelityPolicy?: 'task-preserving-v1'): StructuredReviewInput {
  return { schema: 'theorem-os.formalization-review-input.v2', role: translation ? 'recheck' : 'primary',
    caseId: input.caseId, baseInputDigest: formalizationEvaluationInputDigest(input),
    original: input.original, header: input.header, candidate: input.candidate, observation, translation,
    ...(fidelityPolicy ? { fidelityPolicy } : {}) };
}

export function structuredReviewOutputSchema(input: StructuredReviewInput) {
  return getStructuredFormalizationReviewOutputSchema(input);
}

/** Routing uses the candidate and its review, never labels, references or known benchmark IDs. */
export function structuredReviewRecheckReasons(input: StructuredReviewInput, review: StructuredSemanticReview): string[] {
  const reasons = new Set<string>();
  if (review.verdict === 'unknown') reasons.add('unresolved-review');
  if (review.verdict === 'changes_requested') reasons.add('proposed-rejection');
  if (review.correspondences.some(item => item.sourceReadings.length)) reasons.add('source-ambiguity');
  if (review.correspondences.some(item => item.relation === 'equivalent')) reasons.add('equivalence-conversion');
  if (review.checks.quantifierScope !== 'faithful') reasons.add('quantifier-scope');
  if (review.checks.instanceCoherence !== 'faithful') reasons.add('instance-coherence');
  for (const target of input.observation.snapshot?.targets ?? []) {
    if (target.context.omitted.length) reasons.add('incomplete-definition-export');
    const binders = target.context.bindings?.binders ?? [];
    if (binders.some(binder => /∀|\bExists\b/u.test(binder.type))) reasons.add('nested-quantifiers');
    const instances = binders.filter(binder => binder.kind === 'instanceImplicit');
    if (instances.some((left, index) => instances.slice(index + 1).some(right =>
      left.dependencies.some(id => right.dependencies.includes(id))))) reasons.add('multiple-structures-on-carrier');
  }
  return [...reasons].sort();
}

export function assertReviewBacktranslation(observation: ReviewStatementObservation, value: unknown): FormalizationTranslation {
  const translation = formalizationTranslationSchema.parse(value);
  if (translation.snapshotDigest !== observation.snapshotDigest ||
      canonicalMathJson(translation.targets.map(target => target.name).sort()) !==
      canonicalMathJson(observation.snapshot!.targets.map(target => target.name).sort()))
    throw new Error('formalization_review_translation_identity_mismatch');
  return translation;
}
