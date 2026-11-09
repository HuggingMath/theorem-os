import { z } from 'zod';
import { createHash } from 'node:crypto';
import { isAllowedMathProofSource } from '../../src/math/mathProofSourcePolicy';
import type { WebGuidanceInput, WebPlanApprovalInput, WebPlanProposal } from './collaboration';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const version = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const taskRef = z.object({ id, version }).strict();
const candidate = z.object({
  source: z.string().min(1).max(128 * 1024).refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 128 * 1024 &&
    Buffer.from(value, 'utf8').toString('utf8') === value),
  file: z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f\\]/u.test(value) && isAllowedMathProofSource(value)),
  sourceDigest: hash, baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  baseSourceDigest: hash, environmentDigest: hash, taskRef,
}).strict().refine(value => createHash('sha256').update(value.source).digest('hex') === value.sourceDigest,
  '候选源码摘要与 UTF-8 内容不一致。');
export const webGuidanceSchema = z.object({
  id,
  recipient: z.object({ kind: z.enum(['lead', 'task', 'worker']), id: id.optional() }).strict()
    .refine(value => value.kind === 'lead' || Boolean(value.id), '接收对象不能为空。'),
  taskRef: taskRef.optional(), candidate: candidate.optional(),
  text: z.string().trim().min(1).max(4000).refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 12000),
  observationRef: z.object({ sequence: z.number().int().positive(), stateDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
}).strict().refine(value => !value.candidate || value.recipient.kind === 'task' && value.taskRef !== undefined && value.taskRef.id === value.recipient.id &&
  value.taskRef.id === value.candidate.taskRef.id && value.taskRef.version === value.candidate.taskRef.version,
  '候选证明必须绑定接收任务的精确版本。').transform(value => value as WebGuidanceInput);

/** The runtime parses complete mathematical contracts and validates ownership and dependency cycles. */
export const webPlanProposalSchema = z.object({
  schema: z.literal('deepscientist.math.plan-edit.v1'), id, baseVersion: version,
  tasks: z.array(z.record(z.unknown())).min(1).max(512),
  groups: z.array(z.record(z.unknown())).max(128).optional(),
  proofRoutes: z.array(z.record(z.unknown())).max(256).optional(),
}).strict().transform(value => value as WebPlanProposal);

/** Approves one exact plan version; the runtime rejects it when the plan changed first. */
export const webPlanApprovalSchema = z.object({ id, planVersion: version }).strict().transform(value => value as WebPlanApprovalInput);
