/** Shared research projections. Account IDs, owner keys and model connections never belong in these types. */
import type { WebCommand, WebGuidanceInput, WebPlanProposal, WebTaskSource } from './collaboration';
import type { WebEnvironment, WebPrecheckDiagnostic, WebRunStatus } from './shared';
import type { ResearchLibraryCandidateAttachment } from './researchLibraryTrialTypes';

export type ResearchVisibility = 'private' | 'members' | 'public';
export type ResearchMemberRole = 'collaborator' | 'reader';
export type ResearchAuthor = { id: string; displayName: string };
export type ResearcherProfile = ResearchAuthor & {
  fields: string[]; bio: string; links: string[]; visibility: 'private' | 'public';
  revision: number; createdAt: string; updatedAt: string;
  following?: boolean;
};
/** A directory preview contains only research already visible to the current viewer. */
export type ResearcherDirectoryProfile = ResearcherProfile & { research?: {
  projectCount: number; contributionCount: number;
  latestProject?: { id: string; title: string; updatedAt: string };
  latestContribution?: Pick<ResearchContribution, 'summary' | 'createdAt' | 'projectId' | 'assetId' | 'assetVersion' | 'runId'>;
} };
export type ResearchMutation = { requestId: string; expectedRevision?: number };
export type ResearchProfileInput = ResearchMutation & {
  displayName: string; fields?: string[]; bio?: string; links?: string[]; visibility?: 'private' | 'public';
};
export type ResearchProjectInput = ResearchMutation & {
  title: string; description?: string; fields?: string[]; visibility?: ResearchVisibility;
  candidateDeliveryPolicy?: 'direct' | 'reviewed';
};
export type ResearchProjectUpdate = ResearchMutation & Partial<Omit<ResearchProjectInput, keyof ResearchMutation>>;
export type ResearchStatementInput = ResearchMutation & {
  statement: string; source: string; environment: WebEnvironment; assumptions?: string[];
  targets?: { theoremName: string; proofPath: string }[]; environmentDigest?: string;
  formalizationId?: string; confirmation?: { confirmed: boolean; note?: string };
};
export type ResearchStatementVersion = Omit<ResearchStatementInput, keyof ResearchMutation> & {
  id: string; author: ResearchAuthor; sourceDigest: string; createdAt: string;
};
export type ResearchRunGrants = { guidance: boolean; edit: boolean; approve: boolean; proof: boolean };
export type ResearchRunPermission = 'read' | keyof ResearchRunGrants;
export type ResearchRunBindingInput = ResearchMutation & {
  runId: string; statementVersionId: string; exposure?: 'members' | 'public'; grants?: Partial<ResearchRunGrants>;
};
export type ResearchRunBinding = {
  runId: string; statementVersionId: string; owner: ResearchAuthor; exposure: 'members' | 'public';
  grants: ResearchRunGrants; createdAt: string; status: WebRunStatus; title: string;
  permissions: ResearchRunGrants & { read: boolean; manage: boolean };
};
export type ResearchFeedbackTarget = {
  runId: string; statementVersionId: string;
  observationRef: { sequence: number; stateDigest: string }; taskRef?: { id: string; version: string };
};
export type ResearchIssueSource = { issueId: string; issueRevision: number; resolutionAt: string; proposalId?: string; reviewedTaskRef?: { id: string; version: string } };
export type ResearchReviewComment = { id: string; author: ResearchAuthor; text: string; createdAt: string };
export type ResearchCandidateRevisionInput = { feedbackId: string; expectedRevision: number; responses: { commentId: string; text: string }[] };
type FeedbackBase = ResearchMutation & { text: string; visibility?: 'members' | 'public'; sourceFeedbackId?: string; issueSource?: ResearchIssueSource };
export type ResearchFeedbackInput = FeedbackBase & (
  | { kind: 'discussion'; statementVersionId?: string }
  | { kind: 'guidance'; target: ResearchFeedbackTarget; recipient: WebGuidanceInput['recipient'] }
  | { kind: 'plan-edit' | 'route-control'; target: ResearchFeedbackTarget; proposal: Omit<WebPlanProposal, 'id'> }
  | { kind: 'plan-approval'; target: ResearchFeedbackTarget; planVersion: string }
  | { kind: 'proof-submission'; target: ResearchFeedbackTarget; source: string;
      base: { commit: string; sourceDigest: string; environmentDigest: string; file: string };
      revisionOf?: ResearchCandidateRevisionInput; libraryTrialId?: string; libraryTrialDigest?: string; shareLibraryTrial?: boolean }
);
export type ResearchFeedbackDecisionInput = ResearchMutation & {
  status: 'accepted' | 'declined' | 'needs-info'; reason: string;
  evidenceRefs?: string[]; planVersion?: string; taskRefs?: { id: string; version: string }[];
};
export type ResearchFeedback = {
  id: string; requestId: string; projectId: string; author: ResearchAuthor;
  kind: ResearchFeedbackInput['kind']; text: string; visibility: 'members' | 'public';
  sourceFeedbackId?: string;
  issueSource?: ResearchIssueSource & { title: string; resolution: { text: string; author: ResearchAuthor };
    proposal?: { id: string; text: string; author: ResearchAuthor }; originalTarget?: ResearchFeedbackTarget };
  review?: { reviewer: ResearchAuthor; assignedBy: ResearchAuthor; assignedAt: string };
  reviewHistory?: { action: 'claim' | 'assign' | 'resubmit'; actor: ResearchAuthor; reviewer?: ResearchAuthor; text?: string; createdAt: string }[];
  decisionHistory?: ResearchFeedback['decision'][];
  reviewComments?: ResearchReviewComment[];
  candidateDelivery?: { policy: 'direct' | 'reviewed'; status: 'checking' | 'awaiting-review' | 'approved' | 'dispatched' | 'withdrawn';
    approvedBy?: ResearchAuthor; approvedAt?: string };
  candidateRevision?: { parentFeedbackId: string; parentRevision: number; rootFeedbackId: string; number: number;
    responses: { commentId: string; text: string }[];
    parentSnapshot: { source: string; base: Extract<ResearchFeedbackInput, { kind: 'proof-submission' }>['base'];
      target: ResearchFeedbackTarget; proofCheck?: ResearchProofResult; decision: ResearchFeedback['decision']; comments: ResearchReviewComment[] } };
  supersededBy?: string;
  continuation?: ResearchWorkContinuation;
  reviewContinuation?: ResearchWorkContinuation;
  /** Non-members can revisit their own private discussion while the project remains readable. */
  authorReadable?: boolean;
  statementVersionId?: string; target?: ResearchFeedbackTarget;
  /** Typed payload retained for review and stable command retries. It contains no owner or connection. */
  payload?: Omit<Extract<ResearchFeedbackInput, { kind: 'guidance' }>, keyof FeedbackBase | 'kind' | 'target'>
    | { proposal: Omit<WebPlanProposal, 'id'> } | { planVersion: string }
    | { source: string; base: { commit: string; sourceDigest: string; environmentDigest: string; file: string }; libraryTrial?: ResearchLibraryCandidateAttachment };
  delivery: { status: 'not-sent' | 'queued' | 'delivered' | 'deferred' | 'failed' | 'unknown';
    commandId?: string; reason?: string };
  decision: { status: 'pending' | 'accepted' | 'declined' | 'needs-info' | 'not-recorded';
    actor?: ResearchAuthor & { kind: 'human' | 'agent' }; reason?: string; evidenceRefs: string[];
    decidedAt?: string; sourceTaskRef?: { id: string; version: string }; sourcePlanVersion?: string };
  execution: { status: 'not-started' | 'running' | 'completed' | 'failed' | 'superseded';
    planVersion?: string; taskRefs: { id: string; version: string }[]; resultRefs: string[] };
  proofCheck?: ResearchProofResult;
  revision: number; createdAt: string; updatedAt: string;
};
export type ResearchContribution = {
  id: string; author: ResearchAuthor; projectId?: string; kind: string; summary: string;
  feedbackId?: string; statementVersionId?: string; runId?: string; evidenceRefs: string[]; createdAt: string;
  assetId?: string; assetVersion?: string;
};
export type ResearchActivity = {
  id: string; sequence: number; projectId?: string; actor: ResearchAuthor; type: string; summary: string;
  feedbackId?: string; statementVersionId?: string; runId?: string; createdAt: string;
  assetId?: string; assetVersion?: string;
};
export type ResearchProjectSummary = {
  id: string; title: string; description: string; fields: string[]; visibility: ResearchVisibility;
  owner: ResearchAuthor; members: { researcherId: string; role: ResearchMemberRole }[];
  currentStatementVersionId?: string; revision: number; createdAt: string; updatedAt: string;
  permissions: { manage: boolean; edit: boolean; discuss: boolean; member: boolean };
  following?: boolean;
  candidateDeliveryPolicy?: 'direct' | 'reviewed';
};
export type ResearchProjectDetail = ResearchProjectSummary & {
  versions: ResearchStatementVersion[]; runs: ResearchRunBinding[]; feedback: ResearchFeedback[];
  activity: ResearchActivity[]; contributions: ResearchContribution[];
  assignments: ResearchHumanAssignment[];
};
export type ResearchQuery = { q?: string; field?: string; author?: string; offset?: number; limit?: number; after?: number };
export type ResearchPage<T> = { items: T[]; total: number; nextOffset?: number };
/** Field choices come from all profiles visible to this viewer, before directory filters and pagination. */
export type ResearcherDirectory = ResearchPage<ResearcherDirectoryProfile> & { fields: string[] };
export type ResearchNotification = ResearchActivity & { read: boolean };
export type ResearchCommand = Exclude<WebCommand, { type: 'capture' }>;
export type ResearchProofResult = {
  status: 'checked' | 'failed' | 'superseded'; sourceDigest: string; environmentDigest: string;
  receiptId: string; reason?: string;
};
export type ResearchCandidateCheckReceipt = {
  schema: 'theorem-os.research-candidate-check.v1'; sourceDigest: string;
  base: Extract<ResearchFeedbackInput, { kind: 'proof-submission' }>['base']; target: ResearchFeedbackTarget;
  environment: WebEnvironment; passed: boolean; diagnostics: WebPrecheckDiagnostic[];
  declaration?: { name: string; expectedType?: string }; scope: 'task-declaration'; remainingOriginalSorries: number;
  dependencies: { file: string; digest: string }[]; reason?: string; checkedAt: string;
};
export type ResearchCandidateReview = {
  feedbackId: string; source: string; sourceDigest: string; target: ResearchFeedbackTarget;
  base: Extract<ResearchFeedbackInput, { kind: 'proof-submission' }>['base'];
  baseline: WebTaskSource | null;
  check: { receiptId: string; receipt: ResearchCandidateCheckReceipt } | null;
};
export type ResearchHumanAssignment = {
  id: string; author: ResearchAuthor; target: ResearchFeedbackTarget; status: 'claimed' | 'released' | 'submitted';
  feedbackId?: string; createdAt: string; updatedAt: string;
  continuation?: ResearchWorkContinuation;
};
export type ResearchWorkContinuation = { action: 'continue' | 'end'; actor: ResearchAuthor; text: string; createdAt: string;
  target?: ResearchFeedbackTarget; recordId?: string; feedbackId?: string };
export type ResearchWorkImpactItem = { id: string; kind: 'claim' | 'candidate' | 'review' | 'handoff'; recordId: string;
  revision: number; author: ResearchAuthor; target: ResearchFeedbackTarget; currentTarget?: ResearchFeedbackTarget;
  reason: 'task-changed' | 'task-removed' | 'source-changed' | 'planned-change'; canContinue: boolean; canEnd: boolean;
  continuation?: ResearchWorkContinuation; source?: string; currentSource?: WebTaskSource; comments?: ResearchReviewComment[] };
export type ResearchWorkImpact = { projectId: string; runId: string; planVersion?: string; items: ResearchWorkImpactItem[] };
