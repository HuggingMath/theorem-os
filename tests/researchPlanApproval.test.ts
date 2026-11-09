import { describe, expect, it } from 'vitest';
import type { WebPlanApproval } from '../apps/web/collaboration';
import type { ResearchRunBinding } from '../apps/web/researchProjectTypes';
import { canApproveProjectPlan } from '../apps/web/client/researchPlanApproval';

const binding: Pick<ResearchRunBinding, 'status' | 'permissions'> = { status: 'running',
  permissions: { read: true, manage: false, guidance: true, edit: true, approve: true, proof: false } };
const plan: WebPlanApproval = { required: true, status: 'pending', planVersion: 'plan-v1', rejections: [], leadRevising: false };

describe('project plan approval submission', () => {
  it('allows an explicit approval of the current waiting plan', () => {
    expect(canApproveProjectPlan(binding, plan)).toBe(true);
  });

  it('holds both fresh and recovered requests while the Lead revises', () => {
    const revising = { ...plan, leadRevising: true };
    expect(canApproveProjectPlan(binding, revising)).toBe(false);
    expect(canApproveProjectPlan(binding, plan)).toBe(true);
  });

  it('makes the revised plan available only after the Lead finishes revising', () => {
    const revised = { ...plan, planVersion: 'plan-v2' };
    expect(canApproveProjectPlan(binding, { ...revised, leadRevising: true })).toBe(false);
    expect(canApproveProjectPlan(binding, revised)).toBe(true);
    expect(plan.planVersion).toBe('plan-v1');
  });

  it('stops submissions after approval permission is revoked', () => {
    const revoked = { ...binding, permissions: { ...binding.permissions, approve: false } };
    expect(canApproveProjectPlan(revoked, plan)).toBe(false);
  });

  it.each(['queued', 'completed', 'error', 'cancelled'] as const)('does not submit against a %s run', status => {
    expect(canApproveProjectPlan({ ...binding, status }, plan)).toBe(false);
  });

  it.each(['not-required', 'awaiting-plan', 'approved'] as const)('does not submit while plan approval is %s', status => {
    expect(canApproveProjectPlan(binding, { ...plan, status })).toBe(false);
  });

  it('waits for a concrete plan and version before accepting either request type', () => {
    expect(canApproveProjectPlan(binding, undefined)).toBe(false);
    expect(canApproveProjectPlan(binding, { ...plan, planVersion: undefined })).toBe(false);
    expect(canApproveProjectPlan(binding, { ...plan, planVersion: '' })).toBe(false);
  });
});
