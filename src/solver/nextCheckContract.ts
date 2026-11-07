import { z } from 'zod';
import { nextCheckSchema } from './mathematicalGapContract';
import { knowledgeApplicationReportSchema } from './knowledgeUsageContract';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().trim().min(1).max(2000);
const reference = z.object({ taskId: z.string().min(1), taskDigest: hash }).strict();
export const checkOutcomeSchema = z.object({
  checkId: hash, conclusion: z.enum(['supporting', 'refuted', 'inconclusive']),
  summary: text, evidenceRefs: z.array(z.string().trim().min(1).max(2000)).max(32),
}).strict();
export type CheckOutcome = z.infer<typeof checkOutcomeSchema>;
export const nextCheckScopeSchema = z.object({
  problemReceiptDigest: z.string().min(1), environmentDigest: z.string().min(1),
  parent: reference, target: reference, consumer: reference, dependencies: z.array(reference),
  gapScopeDigest: hash, sourceCommit: z.string().min(1).optional(), sourceDigest: z.string().min(1).optional(),
  /** Host-bound declaration and adopted search basis; absent on legacy text investigations. */
  executionContext: knowledgeApplicationReportSchema.shape.context.optional(),
  executionBasisDigest: hash.optional(),
}).strict();
export type NextCheckScope = z.infer<typeof nextCheckScopeSchema>;
export const nextCheckDecisionSchema = z.object({
  checkId: hash, outcomeDeliveryId: z.string().min(1),
  action: z.enum(['continue', 'revise', 'stop']), reason: text,
}).strict();
export type NextCheckDecision = z.infer<typeof nextCheckDecisionSchema>;
export const nextCheckRecordSchema = z.object({
  id: hash, gapDeliveryId: z.string().min(1), taskId: z.string().min(1), taskDigest: hash,
  check: nextCheckSchema, scope: nextCheckScopeSchema,
  status: z.enum(['pending', 'awaiting-decision', 'decided', 'stale']),
  createdAt: z.number().int().nonnegative(),
  outcome: checkOutcomeSchema.extend({ deliveryId: z.string().min(1), commit: z.string().optional() }).strict().optional(),
  decision: nextCheckDecisionSchema.extend({ at: z.number().int().nonnegative(), planVersion: z.string().optional() }).strict().optional(),
}).strict();
export type NextCheckRecord = z.infer<typeof nextCheckRecordSchema>;
