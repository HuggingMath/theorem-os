import type { ResearchFeedbackTarget } from '../researchProjectTypes';
export type HandoffDraftScope = { owner: string; projectId: string; runId: string; taskId: string };
export type HandoffDraft = { target: ResearchFeedbackTarget; recipientId: string; note: string; members: string; revision: string };
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const handoffDraftKey = (scope: HandoffDraftScope) => `theoremos:handoff-draft:v1:${encodeURIComponent(JSON.stringify([scope.owner, scope.projectId, scope.runId, scope.taskId]))}`;
export function readHandoffDraft(storage: DraftStorage, scope: HandoffDraftScope): HandoffDraft | undefined {
  const raw = storage.getItem(handoffDraftKey(scope)); if (raw === null) return;
  const draft = JSON.parse(raw) as HandoffDraft | null;
  if (!draft || typeof draft.note !== 'string' || typeof draft.recipientId !== 'string' || typeof draft.members !== 'string' || typeof draft.revision !== 'string'
    || draft.target?.runId !== scope.runId || draft.target.taskRef?.id !== scope.taskId || !draft.target.taskRef.version || !draft.target.statementVersionId) throw new Error('Invalid handoff draft');
  return draft;
}
export function saveHandoffDraft(storage: DraftStorage, scope: HandoffDraftScope, draft: HandoffDraft) { storage.setItem(handoffDraftKey(scope), JSON.stringify(draft)); }
export function removeHandoffDraft(storage: DraftStorage, scope: HandoffDraftScope, submitted: HandoffDraft) {
  if (storage.getItem(handoffDraftKey(scope)) === JSON.stringify(submitted)) storage.removeItem(handoffDraftKey(scope));
}
export function handoffDraftNeedsReview(draft: HandoffDraft, target: ResearchFeedbackTarget, members: string) {
  return draft.target.runId !== target.runId || draft.target.statementVersionId !== target.statementVersionId
    || draft.target.taskRef?.id !== target.taskRef?.id || draft.target.taskRef?.version !== target.taskRef?.version || draft.members !== members;
}
