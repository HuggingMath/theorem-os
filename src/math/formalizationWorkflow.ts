import { z } from 'zod';
import { agentHarnessIdentitySchema } from './agentHarnessIdentity';
import { canonicalMathJson, mathDigest } from './mathRuntimeIo';
import { formalizationTargets } from './formalizationSource';

const text = z.string().min(1).max(32_000).refine(value => value.trim().length > 0);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u);
export const formalizationModelConfigurationSchema = z.object({
  model: text, effort: text, profile: text, executable: text, agentHarness: agentHarnessIdentitySchema.optional(),
}).strict();
export type FormalizationModelConfiguration = z.infer<typeof formalizationModelConfigurationSchema>;
export const formalizationReviewConfigurationSchema = z.object({
  planner: formalizationModelConfigurationSchema,
  backtranslator: formalizationModelConfigurationSchema,
  reviewers: z.array(formalizationModelConfigurationSchema.extend({ id }).strict()).min(1).max(5),
}).strict();
export const formalizationWorkflowSchema = formalizationReviewConfigurationSchema.extend({
  schema: z.literal('theorem-os.formalization-workflow.v2'),
  maxPlanningRounds: z.number().int().safe().nonnegative(),
  reviewPolicy: z.literal('all-approve'),
  candidateSelection: z.literal('first-unanimously-approved'),
  reviewScheduling: z.literal('parallel').optional(),
  reference: z.object({
    source: z.string().min(1).max(128 * 1024), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    provenance: text,
    pairs: z.array(z.object({ candidateTarget: text, referenceTarget: text }).strict()).min(1).max(16),
    maxSeconds: z.number().int().safe().nonnegative(),
  }).strict().optional(),
}).strict();
export type FormalizationWorkflow = z.infer<typeof formalizationWorkflowSchema>;

export function defaultFormalizationWorkflow(author: FormalizationModelConfiguration): FormalizationWorkflow {
  return { schema: 'theorem-os.formalization-workflow.v2', planner: { ...author }, backtranslator: { ...author },
    reviewers: [{ ...author, id: 'reviewer-1' }, { ...author, id: 'reviewer-2' }],
    maxPlanningRounds: 0, reviewPolicy: 'all-approve', candidateSelection: 'first-unanimously-approved' };
}

export function assertFormalizationWorkflow(workflow: FormalizationWorkflow): void {
  formalizationWorkflowSchema.parse(workflow);
  if (new Set(workflow.reviewers.map(item => item.id)).size !== workflow.reviewers.length)
    throw new Error('formalization_reviewer_id_duplicate');
  if (workflow.reference) {
    const reference = workflow.reference;
    const targets = formalizationTargets(reference.source).map(item => item.name).sort();
    if (reference.sourceSha256 !== mathDigest(reference.source) ||
        new Set(reference.pairs.map(item => item.candidateTarget)).size !== reference.pairs.length ||
        new Set(reference.pairs.map(item => item.referenceTarget)).size !== reference.pairs.length ||
        canonicalMathJson(reference.pairs.map(item => item.referenceTarget).sort()) !== canonicalMathJson(targets))
      throw new Error('formalization_reference_configuration_invalid');
  }
}

export function formalizationModelConfigurations(author: FormalizationModelConfiguration, workflow?: FormalizationWorkflow) {
  return workflow ? [author, workflow.planner, workflow.backtranslator, ...workflow.reviewers] : [author];
}

// This counts configurations, not statistically independent models or model families.
export function distinctFormalizationModelConfigurations(author: FormalizationModelConfiguration, workflow: FormalizationWorkflow): number {
  return new Set(formalizationModelConfigurations(author, workflow).map(item =>
    canonicalMathJson({ model: item.model, effort: item.effort, profile: item.profile, executable: item.executable,
      ...(item.agentHarness ? { agentHarness: item.agentHarness } : {}) }))).size;
}

export function formalizationModelConfigurationDigest(config: FormalizationModelConfiguration): string {
  return mathDigest(canonicalMathJson({ model: config.model, effort: config.effort, profile: config.profile, executable: config.executable,
    ...(config.agentHarness ? { agentHarness: config.agentHarness } : {}) }));
}
