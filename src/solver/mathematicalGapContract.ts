import { z } from 'zod';
import { knowledgeApplicationReportSchema } from './knowledgeUsageContract';
import { proofSearchCheckpointReferenceSchema } from './proofSearchRecords';

const text = z.string().trim().min(1).max(12000);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const taskId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u);
/** Readable tool inputs only. The host never executes a command from a mathematical report. */
export const nextCheckExecutionSchema = z.discriminatedUnion('kind', [
  knowledgeApplicationReportSchema.pick({ expectedType: true, expression: true, context: true })
    .extend({ kind: z.literal('application') }).strict(),
  z.object({ kind: z.literal('proof-search'), taskId, taskDigest: hash,
    checkpoint: proofSearchCheckpointReferenceSchema.optional(),
    basis: hash.optional(), node: hash.optional(),
  }).strict(),
]);
export type NextCheckExecution = z.infer<typeof nextCheckExecutionSchema>;
/** A bounded investigation of one missing inference; never a claimed proof or difficulty score. */
export const nextCheckSchema = z.object({
  action: z.enum(['feasibility', 'apply-lemma', 'construction-check']),
  objective: z.string().trim().min(1).max(2000),
  expectedEvidence: z.string().trim().min(1).max(2000),
  targetTaskId: taskId.optional(),
  execution: nextCheckExecutionSchema.optional(),
}).strict();
export type NextCheck = z.infer<typeof nextCheckSchema>;
/** A mathematical report, never an inferred equivalence, difficulty score or acceptance. */
export const mathematicalGapSchema = z.object({
  consumer: z.object({ taskId: z.string().min(1), taskDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  previousDeliveryId: z.string().min(1).optional(),
  previousGap: text, reduced: text, remaining: text, evidenceScope: text,
  reconsiderWhen: z.array(text).max(32),
  nextCheck: nextCheckSchema.optional(),
}).strict();
export type MathematicalGap = z.infer<typeof mathematicalGapSchema>;
