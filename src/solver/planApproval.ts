import path from 'node:path';
import { z } from 'zod';
import type { SolverRunState } from './archive';

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
