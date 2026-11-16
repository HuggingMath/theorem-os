import { z } from 'zod';
import type { SolverWorkerState } from './archive';
import type { HarnessProcessIdentity } from '../runtime/harnessProcess';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
export const writerProcessSchema = z.object({ schema: z.literal('theorem-os.harness-process-identity.v1'),
  pid: z.number().int().positive(), startTime: z.string(), bootId: z.string(), pidNamespace: z.string() }).strict();
const declaration = z.object({ file: z.string(), name: z.string(), type: z.string(),
  description: z.string().optional(), premises: z.array(z.string()).optional() }).strict();
export const agentTeamAllowanceSchema = z.object({ tokens: z.number().int().positive().safe().optional(),
  turns: z.number().int().positive().safe().optional() }).strict();
export const agentTeamReserveSchema = z.object({ tokens: z.number().int().nonnegative().safe().optional(),
  turns: z.number().int().nonnegative().safe().optional() }).strict();
const task = z.object({ id: z.string(), message: z.string(), seedCommit: z.string().optional(),
  status: z.enum(['queued', 'running', 'paused', 'completed', 'interrupted', 'failed', 'cancelled']),
  sequence: z.number().int().positive().optional(), createdAt: z.number().optional(),
  budget: agentTeamAllowanceSchema.optional(), turns: z.number().int().nonnegative().optional(),
  pauseRequested: z.object({ at: z.number(), kind: z.enum(['handoff', 'budget']), reason: z.string() }).strict().optional(),
  pausedAt: z.number().optional(), lastStartedAt: z.number().optional(),
  startedAt: z.number().optional(), finishedAt: z.number().optional(),
  declarations: z.array(declaration).optional(), summary: z.string().optional(), deliveryId: z.string().optional(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/u).optional(),
  researchArtifactId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  cancelRequested: z.object({ at: z.number(), reason: z.string().optional(), replacementTaskId: z.string().optional() }).strict().optional(),
  error: z.string().optional() }).strict();
export const agentTeamStateSchema = z.object({ schema: z.literal('theorem-os.agent-team.v1'),
  leadReserve: agentTeamReserveSchema.optional(),
  hostLimits: z.object({ maxTurns: z.number().int().nonnegative().nullable(), maxTotalTokens: z.number().int().nonnegative() }).strict().optional(),
  researchState: z.object({ revision: z.number().int().positive(), summary: z.string().max(16000), publishedAt: z.number() }).strict().optional(),
  researchArtifacts: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/u), agentId: identifier,
    taskId: z.string(), commit: z.string().regex(/^[a-f0-9]{40,64}$/u), path: z.string() }).strict()).optional(),
  workers: z.array(z.object({ id: identifier, role: z.literal('researcher'), worktree: z.string(),
    phase: z.enum(['prepared', 'running', 'checking', 'evaluating', 'finished']), turns: z.number().int().nonnegative(),
    status: z.enum(['preparing', 'idle', 'running', 'paused', 'interrupted', 'stopped', 'failed']),
    activity: z.enum(['preparing', 'idle', 'running', 'stopping', 'checking', 'integrating', 'paused']).optional(),
    dispatchResearchRevision: z.number().int().positive().optional(),
    threadId: z.string().optional(), seedCommit: z.string(), tasks: z.array(task),
    pendingSourceBase: z.string().regex(/^[a-f0-9]{40,64}$/u).optional(),
    pendingPeerDeliveries: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).optional(),
    writerProcess: writerProcessSchema.optional(),
    cursor: z.number().int().nonnegative(), pendingDelivery: z.object({ taskId: z.string(),
      seedCommit: z.string(), declarations: z.array(declaration), commit: z.string().optional(),
      sourceDigest: z.string().optional() }).strict().optional(),
    writerStopUnconfirmed: z.object({ at: z.number(), reason: z.string() }).strict().optional(),
  }).passthrough()),
  events: z.array(z.object({ sequence: z.number().int().positive(), from: z.string(), to: z.string(),
    kind: z.enum(['message', 'completed', 'delivery', 'failed', 'interrupted', 'adopted', 'research-updated', 'cancelled', 'paused', 'resumed', 'budget-updated']),
    at: z.number(), text: z.string(), taskId: z.string().optional(), deliveryId: z.string().optional(),
    sourceTaskId: z.string().optional(), relatedTaskId: z.string().optional(), dispatchResearchRevision: z.number().int().positive().optional(),
    researchArtifactId: z.string().optional(), researchRevision: z.number().int().positive().optional() }).strict()),
  deliveries: z.array(z.object({ id: z.string(), agentId: identifier, taskId: z.string(), path: z.string() }).strict()),
  adoptions: z.array(z.object({ id: z.string(), deliveryId: z.string(), targetId: z.string(),
    status: z.enum(['queued', 'integrating', 'completed', 'failed']), expectedCommit: z.string().optional(),
    commit: z.string().optional(), error: z.string().optional() }).strict()),
  operations: z.array(z.object({ key: z.string(), digest: z.string(), result: z.unknown() }).strict()),
}).strict();

type Stored = z.infer<typeof agentTeamStateSchema>;
export type AgentTeamWorker = Stored['workers'][number] & SolverWorkerState & {
  writerProcess?: HarnessProcessIdentity;
};
export type AgentTeamState = Omit<Stored, 'workers'> & { workers: AgentTeamWorker[] };
export type AgentTeamTask = Stored['workers'][number]['tasks'][number];
