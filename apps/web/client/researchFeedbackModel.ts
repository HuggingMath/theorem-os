import type { ResearchFeedback } from '../researchProjectTypes';

export type FeedbackScope = 'all' | 'run' | 'task';
export type FeedbackStatus = 'all' | 'attention' | 'pending' | 'accepted' | 'executing' | 'completed';
export type FeedbackTask = { runId: string; taskId: string; taskVersion: string };

/** These are recorded associations, rather than task ids inferred from the feedback text. */
export function feedbackTaskRefs(feedback: ResearchFeedback) {
  const refs = [...(feedback.target?.taskRef ? [feedback.target.taskRef] : []), ...feedback.execution.taskRefs];
  return refs.filter((ref, index) => refs.findIndex(item => item.id === ref.id && item.version === ref.version) === index);
}

export function feedbackNeedsAttention(feedback: ResearchFeedback) {
  if (feedback.supersededBy || feedback.continuation?.action === 'end' || feedback.candidateDelivery?.status === 'withdrawn') return false;
  return ['failed', 'deferred', 'unknown'].includes(feedback.delivery.status)
    || ['pending', 'not-recorded', 'needs-info'].includes(feedback.decision.status)
    || feedback.execution.status === 'failed' || feedback.proofCheck?.status === 'failed';
}

export function matchesFeedbackScope(feedback: ResearchFeedback, scope: FeedbackScope, runId?: string, task?: FeedbackTask) {
  if (scope === 'all') return true;
  if (!runId || feedback.target?.runId !== runId) return false;
  if (scope === 'run') return true;
  return task?.runId === runId && feedbackTaskRefs(feedback).some(ref => ref.id === task.taskId && ref.version === task.taskVersion);
}

export function matchesFeedbackStatus(feedback: ResearchFeedback, status: FeedbackStatus) {
  switch (status) {
    case 'attention': return feedbackNeedsAttention(feedback);
    case 'pending': return !feedback.supersededBy && feedback.continuation?.action !== 'end' && feedback.candidateDelivery?.status !== 'withdrawn'
      && ['pending', 'not-recorded'].includes(feedback.decision.status);
    case 'accepted': return feedback.decision.status === 'accepted';
    case 'executing': return feedback.execution.status === 'running';
    case 'completed': return feedback.execution.status === 'completed';
    default: return true;
  }
}

export function matchesFeedbackQuery(feedback: ResearchFeedback, query: string) {
  const text = query.trim().toLocaleLowerCase();
  return !text || [feedback.text, feedback.author.displayName, feedback.decision.reason, feedback.delivery.reason,
    ...feedbackTaskRefs(feedback).flatMap(ref => [ref.id, ref.version]), ...feedback.decision.evidenceRefs,
    ...feedback.execution.resultRefs].join('\n').toLocaleLowerCase().includes(text);
}

export function taskFeedbackAnnotations(feedback: readonly ResearchFeedback[], runId: string) {
  const counts = new Map<string, { taskId: string; taskVersion: string; total: number; attention: number }>();
  for (const item of feedback) {
    if (item.target?.runId !== runId) continue;
    for (const task of feedbackTaskRefs(item)) {
      const key = JSON.stringify([task.id, task.version]);
      const value = counts.get(key) ?? { taskId: task.id, taskVersion: task.version, total: 0, attention: 0 };
      value.total++; if (feedbackNeedsAttention(item)) value.attention++;
      counts.set(key, value);
    }
  }
  return [...counts.values()];
}
