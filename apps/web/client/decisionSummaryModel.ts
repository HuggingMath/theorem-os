import type { WebCommandResult, WebPlan, WebPlanTask } from '../collaboration';

export type DecisionImpact = { receipt: WebCommandResult; current: boolean };
export type DecisionReason = { text: string; source: string };
export type PlanTaskChange = {
  taskId: string; kind: 'added' | 'removed' | 'changed'; fields: (keyof WebPlanTask)[];
  before?: WebPlanTask; after?: WebPlanTask;
};
export type PlanDecisionSummary = {
  version: string; goals: WebPlanTask[]; supportTasks: WebPlanTask[]; entryTasks: WebPlanTask[];
  dependencies: number; routes: NonNullable<WebPlan['proofRoutes']>;
  comparison?: { version: string; changes: PlanTaskChange[]; routesChanged: boolean; groupsChanged: boolean };
  impact?: { status: 'preview' | 'received' | 'applied' | 'rejected' | 'unknown' | 'stale'; affectedTaskIds?: string[];
    recheck?: NonNullable<WebCommandResult['edit']>['recheck'] };
  reason?: DecisionReason;
};

const taskFields: (keyof WebPlanTask)[] = ['kind', 'objective', 'dependsOn', 'proofPath', 'theoremName', 'type', 'groupId',
  'sharing', 'status', 'ownerId', 'premises', 'conditional', 'statementReview', 'informalStatement', 'informalProof',
  'citations', 'consumerGoalIds', 'reviewScope', 'declaration'];

/** The advanced JSON editor can hold an incomplete draft between keystrokes. */
export function hasPlanSummaryContent(plan: WebPlan): boolean {
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
  return Array.isArray(plan.tasks) && plan.tasks.every(task => task && typeof task.id === 'string'
    && typeof task.objective === 'string' && ['goal', 'lemma', 'research', 'sketch'].includes(task.kind) && strings(task.dependsOn)
    && ['theoremName', 'informalStatement', 'type'].every(field => task[field as keyof WebPlanTask] === undefined || typeof task[field as keyof WebPlanTask] === 'string'))
    && (plan.groups === undefined || Array.isArray(plan.groups) && plan.groups.every(group => group && typeof group.id === 'string'))
    && (plan.proofRoutes === undefined || Array.isArray(plan.proofRoutes) && plan.proofRoutes.every(route => route && typeof route.id === 'string'
      && typeof route.closingTaskId === 'string' && typeof route.targetTaskId === 'string' && strings(route.prerequisiteTaskIds)));
}

function fieldValue(task: WebPlanTask, field: keyof WebPlanTask): string {
  const value = task[field];
  // AND dependencies and goal consumers are sets; reordering them does not change the plan.
  return JSON.stringify((field === 'dependsOn' || field === 'consumerGoalIds') && Array.isArray(value)
    ? [...value].sort() : value ?? null);
}

function routes(plan: WebPlan): string {
  return JSON.stringify([...(plan.proofRoutes ?? [])].sort((a, b) => a.id.localeCompare(b.id)).map(route =>
    ({ id: route.id, targetTaskId: route.targetTaskId, closingTaskId: route.closingTaskId,
      prerequisiteTaskIds: [...route.prerequisiteTaskIds].sort() })));
}

function groups(plan: WebPlan): string {
  return JSON.stringify([...(plan.groups ?? [])].sort((a, b) => a.id.localeCompare(b.id)).map(group =>
    ({ id: group.id, objective: group.objective, status: group.status, engineerId: group.engineerId ?? null,
      maxTurns: group.maxTurns ?? null, maxConcurrent: group.maxConcurrent ?? null })));
}

/** Describe the actual plan and recorded preview, without guessing why a Lead chose them. */
export function summarizePlanDecision(plan: WebPlan, previousPlan?: WebPlan | null, impact?: DecisionImpact,
  reason?: DecisionReason): PlanDecisionSummary {
  const summary: PlanDecisionSummary = { version: plan.baseVersion,
    goals: plan.tasks.filter(task => task.kind === 'goal'), supportTasks: plan.tasks.filter(task => task.kind !== 'goal'),
    entryTasks: plan.tasks.filter(task => task.dependsOn.length === 0),
    dependencies: plan.tasks.reduce((count, task) => count + new Set(task.dependsOn).size, 0),
    routes: plan.proofRoutes ?? [], ...(reason?.text.trim() ? { reason } : {}) };
  if (previousPlan) {
    const before = new Map(previousPlan.tasks.map(task => [task.id, task]));
    const after = new Map(plan.tasks.map(task => [task.id, task]));
    const changes: PlanTaskChange[] = [];
    for (const task of plan.tasks) {
      const original = before.get(task.id);
      if (!original) changes.push({ taskId: task.id, kind: 'added', fields: [], after: task });
      else {
        const fields = taskFields.filter(field => fieldValue(original, field) !== fieldValue(task, field));
        if (fields.length) changes.push({ taskId: task.id, kind: 'changed', fields, before: original, after: task });
      }
    }
    for (const task of previousPlan.tasks) if (!after.has(task.id)) changes.push({ taskId: task.id, kind: 'removed', fields: [], before: task });
    summary.comparison = { version: previousPlan.baseVersion, changes,
      routesChanged: routes(plan) !== routes(previousPlan), groupsChanged: groups(plan) !== groups(previousPlan) };
  }
  if (impact) {
    const { receipt } = impact;
    if (!impact.current || receipt.baseVersion && receipt.baseVersion !== plan.baseVersion) summary.impact = { status: 'stale' };
    else {
      const status = ['validated', 'previewed', 'ready'].includes(receipt.status) ? 'preview'
        : receipt.status === 'applied' ? 'applied' : receipt.status === 'received' ? 'received'
          : receipt.status === 'rejected' ? 'rejected' : 'unknown';
      summary.impact = { status, ...(receipt.affectedTaskIds ? { affectedTaskIds: [...new Set(receipt.affectedTaskIds)] } : {}),
        ...(receipt.edit?.recheck ? { recheck: receipt.edit.recheck } : {}) };
    }
  }
  return summary;
}
