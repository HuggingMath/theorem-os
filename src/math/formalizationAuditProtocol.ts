import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1).max(32_000).refine(value => value.trim().length > 0);
export const formalizationAuditAspects = ['domains', 'assumptions', 'conclusions', 'definitions', 'quantifierScope', 'instanceCoherence'] as const;
const checksSchema = z.object({ domains: z.boolean(), assumptions: z.boolean(), conclusions: z.boolean(),
  definitions: z.boolean(), quantifierScope: z.boolean(), instanceCoherence: z.boolean() }).strict();
export const formalizationAuditReviewSchema = z.object({
  verdict: z.enum(['approved', 'changes_requested', 'unknown']), summary: text, checks: checksSchema,
  issues: z.array(z.object({ aspect: z.enum(formalizationAuditAspects), originalFragment: text,
    leanFragment: text, explanation: text }).strict()).max(256),
}).strict();
export type FormalizationAuditReview = z.infer<typeof formalizationAuditReviewSchema>;
export const formalizationAuditResultSchema = z.object({
  schema: z.literal('theorem-os.formalization-audit.v1'), evidenceSha256: hash, sourceSha256: hash,
  snapshotDigest: hash, originalSha256: hash, environmentDigest: hash,
  model: text, effort: text, review: formalizationAuditReviewSchema,
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  session: z.object({ threadId: text, turnId: text, status: z.enum(['completed', 'submitted']),
    completionReason: z.literal('validated-output').optional(), inputDigest: hash, outputDigest: hash,
    usage: z.record(z.unknown()) }).strict(),
}).strict();
export type FormalizationAuditResult = z.infer<typeof formalizationAuditResultSchema>;

