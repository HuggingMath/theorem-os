import { z } from 'zod';
import { knowledgeApplicationCheckSchema, knowledgeApplicationReportSchema } from './knowledgeUsageContract';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);

/** Historical application inputs are advice to inspect and select, never a current KnowledgeUse or receipt. */
export const knowledgeApplicationHintSchema = z.object({
  schema: z.literal('theorem-os.knowledge-application-hint.v1'),
  evidence: z.literal('recorded-not-replayed'), requiresFreshCheck: z.literal(true),
  proofAcceptance: z.literal('not-assessed'), consumerCoverage: z.literal('not-assessed'),
  scope: z.object({ challengeDigest: hash, originalTaskDigest: hash, environmentDigest: hash,
    problemReceiptDigest: hash }).strict(),
  origin: z.object({ kind: z.literal('auto-library-build'), directory: z.string().min(1).max(4096),
    buildId: z.string().uuid(), requestDigest: hash, stateDigest: hash, recordDigest: hash }).strict(),
  declaration: z.object({ name: z.string().min(1).max(1000), file: z.string().min(1).max(1000), sourceDigest: hash }).strict(),
  application: knowledgeApplicationReportSchema,
  historicalCheck: knowledgeApplicationCheckSchema,
}).strict();

export type KnowledgeApplicationHint = z.infer<typeof knowledgeApplicationHintSchema>;
