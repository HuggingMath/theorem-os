import type { ResearchAuthor, ResearchFeedbackTarget, ResearchMemberRole, ResearchWorkContinuation } from './researchProjectTypes';
import type { ResearchStageReference } from './researchProblemTypes';

export type ResearchInvitation = {
  id: string; projectId: string; kind: 'invitation' | 'application'; author: ResearchAuthor; recipient: ResearchAuthor;
  role: ResearchMemberRole; note: string; status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'joined';
  revision: number; createdAt: string; updatedAt: string;
  /** Read projection of the member's effective role; the original invitation role stays unchanged. */
  currentMemberRole?: ResearchMemberRole;
};
/** The capability is returned only to the project owner; one link admits one colleague. */
export type ResearchInvitationLink = {
  id: string; projectId: string; token: string; author: ResearchAuthor; role: ResearchMemberRole; note: string;
  status: 'pending' | 'accepted' | 'revoked'; revision: number; createdAt: string; updatedAt: string;
  acceptedBy?: ResearchAuthor;
};
export type ResearchInvitationLinkPreview = {
  status: ResearchInvitationLink['status']; available: boolean; canAccept: boolean; member: boolean;
  revision?: number; project?: { id: string; title: string }; author?: ResearchAuthor; role?: ResearchMemberRole; note?: string;
};
export type ResearchHandoff = {
  id: string; projectId: string; author: ResearchAuthor; recipient: ResearchAuthor; target: ResearchFeedbackTarget;
  note: string; feedbackIds: string[]; status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  revision: number; createdAt: string; updatedAt: string;
  continuation?: ResearchWorkContinuation;
};
export type ResearchIssueReply = {
  id: string; author: ResearchAuthor; kind: 'comment' | 'proposal'; text: string; replyTo?: string; feedbackIds: string[]; createdAt: string;
};
export type ResearchIssueResolution = { author: ResearchAuthor; text: string; proposalId?: string; feedbackIds: string[]; createdAt: string; action?: 'resolve' | 'reopen' };
export type ResearchIssue = {
  id: string; projectId: string; author: ResearchAuthor; title: string; text: string; statementVersionId?: string;
  target?: ResearchFeedbackTarget; sourceFeedbackId?: string; status: 'open' | 'resolved'; replies: ResearchIssueReply[];
  stageReference?: ResearchStageReference;
  resolution?: ResearchIssueResolution; resolutionHistory?: ResearchIssueResolution[];
  revision: number; createdAt: string; updatedAt: string;
};
export type ResearchCollaborationState = { invitations: ResearchInvitation[]; handoffs: ResearchHandoff[]; issues: ResearchIssue[];
  invitationLinks?: ResearchInvitationLink[] };
export type ResearchCollaborationView = ResearchCollaborationState & { projectId: string; revision: number };
export type ResearchInboxItem = {
  id: string; kind: 'invitation' | 'application' | 'handoff' | 'claim' | 'review' | 'needs-info' | 'reply' | 'annotation' | 'update';
  category: 'decision' | 'reply' | 'progress';
  projectId: string; projectTitle: string; title: string; text?: string; createdAt: string; href: string;
  read: boolean; processed: boolean; resolved: boolean;
  invitation?: ResearchInvitation; handoff?: ResearchHandoff;
  feedbackId?: string; reviewReassignment?: boolean;
  annotationAction?: 'create' | 'reply' | 'resolve' | 'reopen';
  issueAction?: 'resolve' | 'reopen';
};
export type ResearchCollaborationInbox = { items: ResearchInboxItem[]; unread: number; pending: number;
  counts: Record<ResearchInboxItem['category'], number> };
