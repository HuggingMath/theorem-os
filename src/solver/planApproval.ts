import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { SolverRunState } from './archive';
import { pendingDeliveryLines } from './deliveries';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import type { TaskRecord } from './tasks';

/**
 * A run started with --plan-approval holds every worker after its first accepted plan until a human approves
 * the exact plan version they read. The approval opens dispatch only; it never accepts a proof or changes the plan.
 */
export type PlanApprovalRecord = {
  requestedAt?: number; requestedVersion?: string;
  approvedId?: string; approvedVersion?: string; approvedAt?: number;
  rejections?: { id: string; reason: string; planVersion?: string; at: number }[];
  /** Lead guidance dispatched for revision while the plan waited; dispatch is not a handling decision. */
  guidanceIds?: string[];
  /** When the latest such revision turn was dispatched. */
  revisionAt?: number;
};
export type PlanApprovalStatus = 'not-required' | 'awaiting-plan' | 'pending' | 'approved';
export const planApprovalInputSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u),
  planVersion: z.string().min(1).max(128) }).strict();
export type PlanApprovalInput = z.infer<typeof planApprovalInputSchema>;
export const planApprovalLog = (stateFile: string) => path.join(path.dirname(stateFile), 'plan-approvals.jsonl');
export const MAX_PLAN_APPROVAL_REJECTIONS = 16;

export function planApprovalStatus(state: Pick<SolverRunState, 'planApproval' | 'cooperation'>): PlanApprovalStatus {
  if (!state.planApproval) return 'not-required';
  if (state.cooperation?.planApproval?.approvedAt !== undefined) return 'approved';
  return state.cooperation?.tasks.length ? 'pending' : 'awaiting-plan';
}

/** What the workbench shows: whether dispatch waits for a person, and which version they would approve. */
export function planApprovalInspection(state: SolverRunState) {
  const status = planApprovalStatus(state), record = state.cooperation?.planApproval;
  return { required: Boolean(state.planApproval), status, planVersion: state.cooperation?.planVersion,
    ...(record?.requestedAt !== undefined ? { requestedAt: record.requestedAt } : {}),
    ...(record?.approvedAt !== undefined ? { approvedId: record.approvedId, approvedVersion: record.approvedVersion,
      approvedAt: record.approvedAt } : {}),
    rejections: record?.rejections ?? [],
    // Only a turn dispatched for the owner's note counts; the Lead turn that published the plan may still be running.
    leadRevising: status === 'pending' && record?.revisionAt !== undefined && Boolean(state.workers?.some(worker =>
      worker.role === 'lead' && worker.scheduling?.status === 'working' && worker.scheduling.action === 'lead' &&
      worker.scheduling.since >= record.revisionAt!)) };
}

/** Both kinds of Lead consume the same approval log and persist the result before advancing its cursor. */
export function drainPlanApprovals(state: SolverRunState, stateFile: string, signal: AbortSignal, save: () => void,
  emit: (event: string, details: Record<string, unknown>) => void, changed = save) {
  const archive = state.cooperation;
  if (!archive) return;
  for (const entry of pendingDeliveryLines(planApprovalLog(stateFile), archive.cursors ??= {}, 'planApprovals', save, 'drain')) {
    signal.throwIfAborted();
    if (!entry.error && !entry.line?.trim()) continue;
    let approval: PlanApprovalInput | undefined;
    if (entry.line) try { approval = planApprovalInputSchema.parse(JSON.parse(entry.line)); } catch { /* Invalid logged entry. */ }
    const record = archive.planApproval ??= {};
    if (approval && record.approvedId === approval.id) continue;
    const status = planApprovalStatus(state);
    const reason = entry.error ?? (!approval ? 'math_plan_approval_invalid' : status === 'not-required' ? 'math_plan_approval_not_required' :
      status === 'approved' ? 'math_plan_approval_already_approved' : status === 'awaiting-plan' ? 'math_plan_approval_plan_unavailable' :
      approval.planVersion !== archive.planVersion ? 'math_plan_approval_version_conflict' : undefined);
    if (!approval || reason) {
      const rejection = { id: approval?.id ?? crypto.randomUUID(), reason: reason!, at: Date.now(),
        ...(approval ? { planVersion: approval.planVersion } : {}) };
      record.rejections = [...record.rejections ?? [], rejection].slice(-MAX_PLAN_APPROVAL_REJECTIONS);
      changed();
      emit('plan_approval_rejected', rejection);
    } else {
      Object.assign(record, { approvedId: approval.id, approvedVersion: approval.planVersion, approvedAt: Date.now() });
      changed();
      emit('plan_approved', { id: approval.id, planVersion: approval.planVersion });
    }
  }
}

export const nativePlanApprovalSchema = z.object({
  operation: z.literal('publish_plan'),
  goals: z.array(z.object({ theoremName: z.string().trim().min(1).max(512),
    objective: z.string().trim().min(1).max(2000) }).strict()).min(1),
  investigations: z.array(z.string().trim().min(1).max(2000)).max(32).optional(),
}).strict();

export function nativeApprovalPlanBrief(tasks: readonly TaskRecord[]) {
  return canonicalMathJson(tasks.map(({ task }) => ({
    objective: task.objective, ...(task.theoremName ? { theoremName: task.theoremName } : {}),
  })));
}

export function publishNativeApprovalPlan(state: SolverRunState, plan: z.infer<typeof nativePlanApprovalSchema>,
  save: () => void, emit: (event: string, details: Record<string, unknown>) => void) {
  const goals = new Map(plan.goals.map(goal => [goal.theoremName, goal.objective]));
  if (goals.size !== plan.goals.length || goals.size !== state.problem.targets.length ||
      state.problem.targets.some(target => !goals.has(target.theoremName)))
    throw new Error('math_team_plan_targets_mismatch: Supply exactly one objective for each frozen original target, using its full theorem name.');
  const tasks: TaskRecord[] = [
    ...state.problem.targets.map((target, index): TaskRecord => ({ status: 'pending', attempts: 0,
      task: { id: 'goal_' + (index + 1), kind: 'goal', theoremName: target.theoremName, proofPath: target.proofPath,
        objective: goals.get(target.theoremName)!, dependsOn: [], revision: 1 } })),
    ...(plan.investigations ?? []).map((objective, index): TaskRecord => ({ status: 'pending', attempts: 0,
      task: { id: 'research_' + (index + 1), kind: 'research', objective, dependsOn: [], revision: 1 } })),
  ];
  if (Buffer.byteLength(nativeApprovalPlanBrief(tasks)) > 24 * 1024)
    throw new Error('math_team_plan_too_large: Keep the complete plan below 24 KiB so it fits in a resumed Lead context.');
  const planVersion = mathDigest(canonicalMathJson({ receipt: state.problem.receiptDigest, tasks }));
  const status = planApprovalStatus(state);
  if (status === 'pending' && state.cooperation?.planVersion === planVersion)
    return { ok: true, status, planVersion };
  if (status !== 'awaiting-plan') throw new Error('math_team_plan_already_published');
  // Reuse the workbench's plan projection while Codex retains all decisions about assignments.
  state.cooperation = { tasks, planVersion, planApproval: { requestedAt: Date.now(), requestedVersion: planVersion } };
  save();
  emit('plan_approval_requested', { planVersion });
  return { ok: true, status: 'pending', planVersion,
    hint: 'The host is waiting for approval. Return from this turn. Continue on the next turn after the host confirms approval.' };
}
