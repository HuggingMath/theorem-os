import type { ResearchFeedback, ResearchFeedbackTarget } from '../researchProjectTypes';
import type { WebGuidanceRecord } from '../collaboration';

export type GuidanceFeedbackKey = { projectId: string; runId: string; requestId: string; statementVersionId?: string };
export type GuidanceOutcomeModel = {
  recorded: boolean; delivery?: ResearchFeedback['delivery']; decision?: ResearchFeedback['decision'];
  execution?: ResearchFeedback['execution']; target?: ResearchFeedbackTarget; projectId?: string;
  taskRefs: { id: string; version: string }[]; decisionTaskRefs: { id: string; version: string }[]; evidenceRefs: string[];
};

/** A matching phrase or task name is insufficient: guidance belongs to an exact project, run, and request. */
export function findGuidanceFeedback(records: readonly ResearchFeedback[], key: GuidanceFeedbackKey): ResearchFeedback | undefined {
  return records.find(item => item.kind === 'guidance' && item.projectId === key.projectId && item.target?.runId === key.runId
    && (item.requestId === key.requestId || item.id === key.requestId)
    && (!key.statementVersionId || item.target.statementVersionId === key.statementVersionId));
}

export function guidanceOutcome(feedback?: ResearchFeedback, guidance?: WebGuidanceRecord): GuidanceOutcomeModel {
  if (!feedback || feedback.kind !== 'guidance') {
    const decision = guidance?.decision;
    if (!guidance || !decision || decision.guidanceId !== guidance.id) return { recorded: false, taskRefs: [], decisionTaskRefs: [], evidenceRefs: [] };
    const taskRefs = decision.evidenceRefs.filter(ref => ref.kind === 'task').map(ref => ({ id: ref.id, version: ref.version }));
    const unique = new Map(taskRefs.map(task => [`${task.id}\u0000${task.version}`, task]));
    return { recorded: true, delivery: { status: guidance.status, reason: guidance.reason },
      decision: { status: decision.status, reason: decision.reason, actor: { id: decision.workerId, displayName: decision.workerId, kind: 'agent' },
        decidedAt: decision.decidedAt, evidenceRefs: [], sourceTaskRef: decision.sourceTaskRef, sourcePlanVersion: decision.sourcePlanVersion },
      taskRefs: [], decisionTaskRefs: [...unique.values()], evidenceRefs: decision.evidenceRefs.map(ref => ref.kind === 'task'
        ? `task:${ref.id}@${ref.version}` : ref.kind === 'edit' ? `edit:${ref.id}` : `plan:${ref.version}`) };
  }
  const unique = new Map(feedback.execution.taskRefs.map(task => [`${task.id}\u0000${task.version}`, task]));
  return { recorded: true, projectId: feedback.projectId, target: feedback.target,
    delivery: feedback.delivery, decision: feedback.decision, execution: feedback.execution,
    taskRefs: [...unique.values()], decisionTaskRefs: [], evidenceRefs: [...new Set([...feedback.decision.evidenceRefs, ...feedback.execution.resultRefs])] };
}
