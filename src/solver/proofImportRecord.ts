import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/u);
export const proofImportRequestSchema = z.object({
  schema: z.literal('theorem-os.proof-fragment.v1'),
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u), runId: z.string(),
  baseVersion: z.string().min(1), taskId: z.string(), taskDigest: hash,
  proofPath: z.string(), theoremName: z.string(), seedCommit: commit,
  problemReceiptDigest: z.string(), environmentDigest: z.string(),
  fragment: z.string().min(1), fragmentSha256: hash,
}).strict();
export type ProofImportRequest = z.infer<typeof proofImportRequestSchema>;

/** Import progress is separate from the proof-ready record and its independent Lean receipts. */
export const proofImportRecordSchema = z.object({
  id: z.string(), requestDigest: hash, taskId: z.string(), taskDigest: hash, fragmentSha256: hash,
  status: z.enum(['received', 'frozen', 'checked', 'failed', 'rejected', 'superseded']),
  receivedAt: z.number().int().nonnegative(), workerId: z.string().optional(), assignmentKey: z.string().optional(),
  snapshotCommit: commit.optional(), readyId: z.string().optional(), reason: z.string().optional(),
}).strict();
export type ProofImportRecord = z.infer<typeof proofImportRecordSchema>;
