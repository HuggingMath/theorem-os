import { z } from 'zod';
import type { WebGuidanceInput, WebPlanProposal } from './collaboration';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const version = z.string().min(1).max(128);
export const webGuidanceSchema = z.object({
  id,
  recipient: z.object({ kind: z.enum(['lead', 'task', 'worker']), id: id.optional() }).strict()
    .refine(value => value.kind === 'lead' || Boolean(value.id), '接收对象不能为空。'),
  taskRef: z.object({ id, version }).strict().optional(),
  text: z.string().trim().min(1).max(4000).refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 12000),
  observationRef: z.object({ sequence: z.number().int().positive(), stateDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
}).strict().transform(value => value as WebGuidanceInput);

/** The runtime parses complete mathematical contracts and validates ownership and dependency cycles. */
export const webPlanProposalSchema = z.object({
  schema: z.literal('deepscientist.math.plan-edit.v1'), id, baseVersion: version,
  tasks: z.array(z.record(z.unknown())).min(1).max(512),
  groups: z.array(z.record(z.unknown())).max(128).optional(),
  proofRoutes: z.array(z.record(z.unknown())).max(256).optional(),
}).strict().transform(value => value as WebPlanProposal);
