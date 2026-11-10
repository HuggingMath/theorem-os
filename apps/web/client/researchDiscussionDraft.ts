import type { ResearchDiscussionContext } from '../researchProjectTypes';

export type DiscussionDraft = {
  text: string; visibility: 'members' | 'public';
  baseline: { statementVersionId?: string; sourceDigest?: string; context?: ResearchDiscussionContext };
};
export const discussionContextKey = (context?: ResearchDiscussionContext) => context ? JSON.stringify([context.runId, context.statementVersionId,
  context.observationRef.sequence, context.observationRef.stateDigest, context.taskRef.id, context.taskRef.version, context.commit ?? '']) : '';
export function discussionDraftMatches(draft: DiscussionDraft, baseline: DiscussionDraft['baseline']) {
  return draft.baseline.statementVersionId === baseline.statementVersionId && draft.baseline.sourceDigest === baseline.sourceDigest
    && discussionContextKey(draft.baseline.context) === discussionContextKey(baseline.context);
}
