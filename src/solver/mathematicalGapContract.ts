import { z } from 'zod';

const text = z.string().trim().min(1).max(12000);
/** A mathematical report, never an inferred equivalence, difficulty score or acceptance. */
export const mathematicalGapSchema = z.object({
  consumer: z.object({ taskId: z.string().min(1), taskDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  previousDeliveryId: z.string().min(1).optional(),
  previousGap: text, reduced: text, remaining: text, evidenceScope: text,
  reconsiderWhen: z.array(text).max(32),
}).strict();
export type MathematicalGap = z.infer<typeof mathematicalGapSchema>;
