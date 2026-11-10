import type { ResearchFeedback } from '../researchProjectTypes';
export function reviewerMembersHref(projectId: string, feedback: Pick<ResearchFeedback, 'id' | 'target'>) {
  return `theorems.html?${new URLSearchParams({ id: projectId, reviewFeedback: feedback.id, ...(feedback.target ? {
    run: feedback.target.runId, version: feedback.target.statementVersionId,
    ...(feedback.target.taskRef ? { task: feedback.target.taskRef.id, taskVersion: feedback.target.taskRef.version } : {}) } : {}) })}#collaboration-members`;
}
