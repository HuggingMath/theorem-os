export type DiscussionDraft = {
  text: string; visibility: 'members' | 'public';
  baseline: { statementVersionId?: string; sourceDigest?: string };
};
export function discussionDraftMatches(draft: DiscussionDraft, baseline: DiscussionDraft['baseline']) {
  return draft.baseline.statementVersionId === baseline.statementVersionId && draft.baseline.sourceDigest === baseline.sourceDigest;
}
