import { describe, expect, it } from 'vitest';
import type { WebPlan } from '../apps/web/collaboration';
import { hasPlanSummaryContent, summarizePlanDecision } from '../apps/web/client/decisionSummaryModel';

const plan: WebPlan = { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [
  { id: 'goal', kind: 'goal', objective: 'Prove the original inequality', theoremName: 'original_goal', dependsOn: ['close'], revision: 0 },
  { id: 'bound', kind: 'lemma', objective: 'Establish the common bound', dependsOn: [], revision: 0 },
  { id: 'close', kind: 'lemma', objective: 'Use the bound to close the original target', dependsOn: ['bound'], revision: 0 },
], proofRoutes: [{ id: 'direct', targetTaskId: 'goal', prerequisiteTaskIds: ['bound'], closingTaskId: 'close' }] };

describe('a plan decision grounded in tasks and preview receipts', () => {
  it('retains the original target, the full dependency chain and route without inventing a rationale', () => {
    const summary = summarizePlanDecision(plan);
    expect(summary.goals.map(task => task.id)).toEqual(['goal']);
    expect(summary.supportTasks.map(task => task.id)).toEqual(['bound', 'close']);
    expect(summary.entryTasks.map(task => task.id)).toEqual(['bound']);
    expect(summary.dependencies).toBe(2);
    expect(summary.routes).toEqual(plan.proofRoutes);
    expect(summary.reason).toBeUndefined();
    expect(summary.impact).toBeUndefined();
  });

  it('distinguishes added, removed and revised tasks and detects a changed route', () => {
    const revised: WebPlan = { ...plan, baseVersion: 'plan-v2', tasks: [plan.tasks[0],
      { ...plan.tasks[2], dependsOn: ['new-bound'] },
      { ...plan.tasks[1], id: 'new-bound', objective: 'Prove a sharper bound' }],
      proofRoutes: [{ ...plan.proofRoutes![0], prerequisiteTaskIds: ['new-bound'] }] };
    const summary = summarizePlanDecision(revised, plan);
    expect(summary.comparison?.changes.map(change => [change.taskId, change.kind, change.fields])).toEqual([
      ['close', 'changed', ['dependsOn']], ['new-bound', 'added', []], ['bound', 'removed', []],
    ]);
    expect(summary.comparison?.routesChanged).toBe(true);
    expect(summary.goals).toEqual([plan.tasks[0]]);
    expect(plan.tasks[2].dependsOn).toEqual(['bound']);
  });

  it('does not report AND dependency ordering or task revision counters as a changed plan', () => {
    const before = { ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ['bound', 'close'] }, ...plan.tasks.slice(1)] };
    const after = { ...before, tasks: [{ ...before.tasks[0], dependsOn: ['close', 'bound'], revision: 9 }, ...before.tasks.slice(1)] };
    expect(summarizePlanDecision(after, before).comparison?.changes).toEqual([]);
  });

  it('reports scheduling and Engineer changes even when the mathematical tasks remain the same', () => {
    const before: WebPlan = { ...plan, groups: [{ id: 'main', objective: 'Complete the proof', status: 'active', revision: 0, engineerId: 'engineer-1' }] };
    const after: WebPlan = { ...before, groups: [{ ...before.groups![0], engineerId: 'engineer-2', status: 'paused' }] };
    const summary = summarizePlanDecision(after, before);
    expect(summary.comparison?.changes).toEqual([]);
    expect(summary.comparison?.groupsChanged).toBe(true);
  });

  it('shows only the tasks actually named by a current preview, without predicting recheck results', () => {
    const summary = summarizePlanDecision(plan, undefined, { current: true, receipt: { id: 'preview', status: 'validated',
      baseVersion: plan.baseVersion, affectedTaskIds: ['close', 'goal', 'goal'] } });
    expect(summary.impact).toEqual({ status: 'preview', affectedTaskIds: ['close', 'goal'] });
  });

  it.each([
    { current: false, baseVersion: 'plan-v1' },
    { current: true, baseVersion: 'unrelated-plan' },
  ])('does not carry stale or differently based impact into the current decision: %o', ({ current, baseVersion }) => {
    expect(summarizePlanDecision(plan, undefined, { current, receipt: { id: 'old', status: 'validated',
      baseVersion, affectedTaskIds: ['unrelated-task'] } }).impact).toEqual({ status: 'stale' });
  });

  it('keeps recorded application and exact recheck evidence separate', () => {
    const recheck = { status: 'pending', tasks: [{ taskId: 'close', taskDigest: 'close-v2', status: 'pending' }] };
    const summary = summarizePlanDecision(plan, undefined, { current: true, receipt: { id: 'edit', status: 'applied',
      edit: { id: 'edit', status: 'applied', recheck } } });
    expect(summary.impact?.status).toBe('applied');
    expect(summary.impact?.recheck).toEqual(recheck);
    expect(summary.impact?.affectedTaskIds).toBeUndefined();
  });

  it('uses an explicitly sourced reason and leaves a blank record absent', () => {
    const reason = { text: 'Retain the common bound and try a direct closing lemma.', source: 'Recorded revision request' };
    expect(summarizePlanDecision(plan, undefined, undefined, reason).reason).toEqual(reason);
    expect(summarizePlanDecision(plan, undefined, undefined, { ...reason, text: '  ' }).reason).toBeUndefined();
  });

  it('allows a complete draft and avoids rendering a partial advanced JSON draft as a real plan', () => {
    expect(hasPlanSummaryContent(plan)).toBe(true);
    expect(hasPlanSummaryContent({ ...plan, tasks: [null] } as unknown as WebPlan)).toBe(false);
    expect(hasPlanSummaryContent({ ...plan, tasks: [{ ...plan.tasks[0], dependsOn: null }] } as unknown as WebPlan)).toBe(false);
    expect(hasPlanSummaryContent({ ...plan, proofRoutes: [null] } as unknown as WebPlan)).toBe(false);
  });
});
