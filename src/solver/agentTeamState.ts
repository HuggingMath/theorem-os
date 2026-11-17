import { z } from 'zod';
import type { SolverWorkerState } from './archive';
import type { HarnessProcessIdentity } from '../runtime/harnessProcess';
import { agentTeamProfileEvidenceSchema } from './agentTeamProfiles';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
export const writerProcessSchema = z.object({ schema: z.literal('theorem-os.harness-process-identity.v1'),
  pid: z.number().int().positive(), startTime: z.string(), bootId: z.string(), pidNamespace: z.string() }).strict();
const declaration = z.object({ file: z.string(), name: z.string(), type: z.string(),
  description: z.string().optional(), premises: z.array(z.string()).optional() }).strict();
export const agentTeamAllowanceSchema = z.object({ tokens: z.number().int().positive().safe().optional(),
  turns: z.number().int().positive().safe().optional() }).strict();
export const agentTeamReserveSchema = z.object({ tokens: z.number().int().nonnegative().safe().optional(),
  turns: z.number().int().nonnegative().safe().optional() }).strict();
export const agentTeamWorkKindSchema = z.enum(['research', 'proof', 'independent-reconstruction', 'review', 'assembly']);
export const agentTeamKnowledgeUseSchema = z.object({ anchor: z.string().min(1).max(1000),
  application: z.string().min(1).max(16000) }).strict();
const exposure = z.object({ deliveryId: z.string(), agentId: identifier, taskId: z.string(), commit: z.string(),
  kind: z.enum(['inspected', 'adopted']), at: z.string() }).strict();
const task = z.object({ id: z.string(), message: z.string(), seedCommit: z.string().optional(),
  objectiveRevision: z.number().int().positive().optional(), workKind: agentTeamWorkKindSchema.optional(),
  profileEvidence: agentTeamProfileEvidenceSchema.optional(),
  objectiveHistory: z.array(z.object({ revision: z.number().int().positive(), message: z.string(),
    workKind: agentTeamWorkKindSchema.optional(), at: z.number(), reason: z.string(),
    profileEvidence: agentTeamProfileEvidenceSchema.optional() }).strict()).optional(),
  progress: z.array(z.object({ id: z.string(), at: z.number(), objectiveRevision: z.number().int().positive(),
    kind: z.enum(['finding', 'probe', 'blocker', 'route']), summary: z.string(), nextStep: z.string().optional(),
    evidenceRefs: z.array(z.string()).optional(), knowledgeUses: z.array(agentTeamKnowledgeUseSchema.extend({ digest: z.string() })).optional(),
  }).strict()).optional(),
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
  /** Absent retains the historical dynamic-tool team on resume. */
  transport: z.enum(['host-tools', 'native-agent-control']).optional(),
  nativeControl: z.object({ sessionId: z.string(), rootThreadId: z.string(),
    rootAgent: z.record(z.unknown()).optional(), rootConfigSnapshot: z.record(z.unknown()).optional(),
    sequence: z.number().int().nonnegative(),
    mailbox: z.array(z.object({ id: z.string(), threadId: z.string(), author: z.string(), recipient: z.string(),
      message: z.record(z.unknown()).optional(), communication: z.record(z.unknown()).optional(),
      status: z.enum(['queued', 'accepted', 'uncertain']),
      sequence: z.number().int().positive().optional() }).strict()),
  }).strict().optional(),
  completionRequested: z.object({ at: z.number(), summary: z.string() }).strict().optional(),
  leadExposures: z.array(exposure).optional(),
  coordination: z.object({ revision: z.number().int().positive(), at: z.number(),
    decision: z.enum(['delegate', 'defer', 'continue']), reason: z.string().min(1).max(16000),
    nextStep: z.string().min(1).max(16000), startedRequests: z.number().int().nonnegative(),
    eventSequence: z.number().int().nonnegative() }).strict().optional(),
  coordinationPresentation: z.object({ at: z.number(),
    reason: z.enum(['opening', 'deferred-step-complete', 'team-update', 'members-idle']),
    decisionRevision: z.number().int().nonnegative(), eventSequence: z.number().int().nonnegative(),
  }).strict().optional(),
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
    exposures: z.array(exposure).optional(),
    threadId: z.string().optional(), seedCommit: z.string(), tasks: z.array(task),
    native: z.object({ sessionId: z.string(), threadId: z.string(), agentPath: z.string(), parentThreadId: z.string(),
      spawnOperationId: z.string().optional(), spawnRequestDigest: z.string().optional(),
      bootstrap: z.record(z.unknown()), initialInput: z.record(z.unknown()),
      agent: z.record(z.unknown()).optional(), configSnapshot: z.record(z.unknown()).optional(),
      submissionId: z.string().optional(), turnId: z.string().optional(), status: z.unknown().optional(),
      lastOutcome: z.object({ turnId: z.string(), status: z.unknown() }).strict().optional(),
    }).strict().optional(),
    pendingSourceBase: z.string().regex(/^[a-f0-9]{40,64}$/u).optional(),
    pendingPeerDeliveries: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).optional(),
    writerProcess: writerProcessSchema.optional(),
    cursor: z.number().int().nonnegative(), pendingDelivery: z.object({ taskId: z.string(),
      seedCommit: z.string(), declarations: z.array(declaration), commit: z.string().optional(),
      sourceDigest: z.string().optional() }).strict().optional(),
    writerStopUnconfirmed: z.object({ at: z.number(), reason: z.string() }).strict().optional(),
  }).passthrough()),
  events: z.array(z.object({ sequence: z.number().int().positive(), from: z.string(), to: z.string(),
    kind: z.enum(['message', 'completed', 'delivery', 'failed', 'interrupted', 'adopted', 'research-updated', 'cancelled', 'paused', 'resumed', 'budget-updated', 'amended', 'progress']),
    at: z.number(), text: z.string(), taskId: z.string().optional(), deliveryId: z.string().optional(),
    sourceTaskId: z.string().optional(), relatedTaskId: z.string().optional(), dispatchResearchRevision: z.number().int().positive().optional(),
    researchArtifactId: z.string().optional(), researchRevision: z.number().int().positive().optional(),
    objectiveRevision: z.number().int().positive().optional(), progressId: z.string().optional() }).strict()),
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
