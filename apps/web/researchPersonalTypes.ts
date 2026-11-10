import type { WebTaskSource } from './collaboration';
import type { ResearchFeedbackTarget } from './researchProjectTypes';

export type ResearchDraftKind = 'candidate' | 'discussion' | 'issue' | 'issue-reply';
export type ResearchDraftScope = {
  owner: string; projectId: string; kind: ResearchDraftKind; statementVersionId?: string;
  runId?: string; taskId?: string; taskVersion?: string; commit?: string; issueId?: string; issueRevision?: number; sourceFeedbackId?: string;
};
export type ResearchAccountDraftScope = Omit<ResearchDraftScope, 'owner'>;
export type ResearchDraftValues = {
  candidate: { source: string; text: string; edited: boolean; needsReview: boolean; baseSource: WebTaskSource;
    baseObservation: { sequence: number; stateDigest: string };
    revisionOf?: { feedbackId: string; expectedRevision: number; responses: { commentId: string; text: string }[] } };
  discussion: { text: string; visibility: 'members' | 'public'; baseline: { statementVersionId?: string; sourceDigest?: string } };
  issue: { title: string; text: string; target?: ResearchFeedbackTarget; sourceFeedbackId?: string; statementVersionId?: string };
  'issue-reply': { text: string; kind: string; replyTo: string; proposalId: string; feedbackId: string; revision: number };
};
export type ResearchAccountDraftVersionInfo = {
  id: string; revision: number; baseRevision: number; conflict: boolean; summary: string;
  deviceId: string; deviceName: string; clientUpdatedAt: string; savedAt: string;
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
