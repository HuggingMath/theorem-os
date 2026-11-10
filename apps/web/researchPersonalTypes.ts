import type { WebTaskSource } from './collaboration';
import type { ResearchAnnotationAnchor, ResearchFeedbackTarget, ResearchDiscussionContext } from './researchProjectTypes';
import type { ProblemDraftValue } from './problemDraftTypes';

export type ResearchDraftKind = 'candidate' | 'discussion' | 'issue' | 'issue-reply' | 'guidance' | 'annotation' | 'annotation-reply' | 'review' | 'problem';
export type ResearchDraftScope = {
  owner: string; projectId?: string; kind: ResearchDraftKind; statementVersionId?: string;
  runId?: string; taskId?: string; taskVersion?: string; commit?: string; issueId?: string; issueRevision?: number; sourceFeedbackId?: string;
  threadId?: string; purpose?: 'comment' | 'resubmit' | 'decision'; draftKey?: string;
};
export type ResearchDecisionDraft = { text: string; status: '' | 'accepted' | 'declined' | 'needs-info'; evidence: string; planVersion: string; revision: number };
export type ResearchAccountDraftScope = Omit<ResearchDraftScope, 'owner'>;
export type ResearchDraftValues = {
  problem: ProblemDraftValue;
  candidate: { source: string; text: string; edited: boolean; needsReview: boolean; baseSource: WebTaskSource;
    baseObservation: { sequence: number; stateDigest: string };
    revisionOf?: { feedbackId: string; expectedRevision: number; responses: { commentId: string; text: string }[] } };
  discussion: { text: string; visibility: 'members' | 'public'; baseline: { statementVersionId?: string; sourceDigest?: string; context?: ResearchDiscussionContext } };
  issue: { title: string; text: string; target?: ResearchFeedbackTarget; sourceFeedbackId?: string; statementVersionId?: string };
  'issue-reply': { text: string; kind: string; replyTo: string; proposalId: string; feedbackId: string; revision: number };
  guidance: { text: string; planVersion?: string; observationRef: { sequence: number; stateDigest: string } };
  annotation: { text: string; anchor?: ResearchAnnotationAnchor; observationRef: { sequence: number; stateDigest: string } };
  'annotation-reply': { text: string };
  review: { text: string } | ResearchDecisionDraft;
};
export type ResearchDraftSubmission = { kind: 'feedback' | 'issue' | 'issue-reply' | 'guidance' | 'annotation' | 'annotation-reply' | 'review' | 'formalization' | 'run'; id: string; href?: string };
export type ResearchAccountDraftVersionInfo = {
  id: string; revision: number; baseRevision: number; conflict: boolean; summary: string;
  deviceId: string; deviceName: string; clientUpdatedAt: string; savedAt: string;
  status?: 'open' | 'submitted' | 'discarded'; completedAt?: string; submission?: ResearchDraftSubmission;
};
export type ResearchAccountDraftVersion<T = unknown> = ResearchAccountDraftVersionInfo & { value: T };
export type ResearchAccountDraft = { id: string; scope: ResearchDraftScope; revision: number; versions: ResearchAccountDraftVersionInfo[] };
export type ResearchAccountDraftResult<T = unknown> = { draft: ResearchAccountDraft; version: ResearchAccountDraftVersion<T>; conflict: boolean };
export type ResearchPersonalTarget = { runId?: string; projectId?: string };
export type ResearchPersonalProblem = {
  key: string; target: ResearchPersonalTarget; revision: number; pinned: boolean; status: 'active' | 'parked' | 'archived';
  tags: string[]; nextNote: string; updatedAt?: string;
};
export type ResearchPersonalProblemList = { items: ResearchPersonalProblem[] };
