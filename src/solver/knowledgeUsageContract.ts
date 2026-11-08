import { z } from 'zod';

/** Shared records for HTTP and solver consumers; importing them never loads the solver. */
const text = z.string().trim().min(1).max(12000);
const notes = z.array(text).max(32).optional();
export const knowledgeApplicationReportSchema = z.object({
  expression: text, expectedType: text,
  context: z.object({ file: z.string().min(1).max(1000), declaration: z.string().min(1).max(1000) }).strict(),
  arguments: z.array(z.object({ parameter: text, value: text }).strict()).max(32).optional(),
  additionalPremises: notes, typeclassIssues: notes, adaptationSteps: notes, remainingGoals: notes, reconsiderWhen: notes,
}).strict();
export const knowledgeApplicationCheckSchema = z.object({
  status: z.enum(['elaborated', 'failed', 'unavailable']), reason: z.string(),
  authority: z.literal('advisory-application-elaboration'), proofAcceptance: z.literal('not-assessed'),
  consumerCoverage: z.literal('not-assessed'), commit: z.string(), environmentDigest: z.string(),
  sourceSnapshotDigest: z.string().optional(), projectionDigest: z.string().optional(),
  reuseEnvironmentDigest: z.string().optional(),
  diagnosticEnvironmentDigest: z.string().optional(), toolIdentity: z.string().optional(),
  files: z.array(z.object({ file: z.string(), digest: z.string() })).optional(),
  artifact: z.object({ path: z.string(), digest: z.string() }).optional(),
  elaboratedType: z.string().optional(), selectedDeclarationUsed: z.boolean().optional(),
  diagnostic: z.string().max(8000).optional(), reused: z.boolean().optional(),
});
export type KnowledgeApplicationCheck = z.infer<typeof knowledgeApplicationCheckSchema>;
export const knowledgeUseSchema = z.object({
  /** Older records without a source refer to the separately pinned historical catalog. */
  source: z.enum(['catalog', 'installed-library']).optional(),
  id: z.string(), catalogDigest: z.string(), consumer: z.object({ taskId: z.string(), taskDigest: z.string() }),
  declaration: z.object({ name: z.string(), file: z.string() }), status: z.enum(['reported-attempt', 'checked-reference']),
  attribution: z.enum(['model-reported-origin', 'host-observed-reference']),
  catalogDeclarationMatch: z.boolean().optional(),
  checkedCommit: z.string().optional(), checkedSourceDigest: z.string().optional(),
  application: knowledgeApplicationReportSchema.extend({ check: knowledgeApplicationCheckSchema.optional() }).optional(),
});
export type KnowledgeUse = Readonly<z.infer<typeof knowledgeUseSchema>>;
