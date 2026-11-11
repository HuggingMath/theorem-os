export type IssueReplyDraft = { text: string; kind: string; replyTo: string; proposalId: string; feedbackId: string; revision: number };

/** A saved reply owns its entire snapshot, including the reply target. */
export function completeIssueReply(current: IssueReplyDraft, submitted: IssueReplyDraft, revision: number): IssueReplyDraft {
  return JSON.stringify(current) === JSON.stringify(submitted)
    ? { ...current, text: '', replyTo: '', revision }
    : { ...current, revision };
}
