import type { WebObservation } from '../collaboration';
import type { ResearchIssue } from '../researchCollaborationTypes';
import type { ResearchFeedback, ResearchFeedbackInput, ResearchFeedbackTarget } from '../researchProjectTypes';

export type IssueExecutionInput = Extract<ResearchFeedbackInput, { kind: 'guidance' }>
  | (Extract<ResearchFeedbackInput, { kind: 'plan-edit' | 'route-control' }> & { kind: 'plan-edit' });
export type IssueExecutionScope = { owner: string; projectId: string; issueId: string };
export type IssueExecutionContext = { issueRevision: number; resolutionAt: string; target: ResearchFeedbackTarget; planVersion?: string };
export type IssueExecutionDraft = {
  mode: 'guidance' | 'plan-edit'; runId: string; taskId: string; text: string;
  objective: string; dependencies: string; editedTask: string; context?: IssueExecutionContext;
};
export type IssueExecutionAttempt = { input: IssueExecutionInput; draft?: IssueExecutionDraft };
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const issueExecutionKey = (scope: IssueExecutionScope, kind: 'draft' | 'pending') =>
  `theoremos:issue-execution-${kind}:v1:${encodeURIComponent(JSON.stringify([scope.owner, scope.projectId, scope.issueId]))}`;
const targetValid = (target: ResearchFeedbackTarget | undefined) => Boolean(target && typeof target.runId === 'string' && target.runId
  && typeof target.statementVersionId === 'string' && target.statementVersionId && Number.isInteger(target.observationRef?.sequence)
  && typeof target.observationRef.stateDigest === 'string' && (!target.taskRef || typeof target.taskRef.id === 'string' && typeof target.taskRef.version === 'string'));
const draftValid = (draft: IssueExecutionDraft | undefined): draft is IssueExecutionDraft => Boolean(draft
  && ['guidance', 'plan-edit'].includes(draft.mode)
  && ['runId', 'taskId', 'text', 'objective', 'dependencies', 'editedTask'].every(key => typeof draft[key as keyof IssueExecutionDraft] === 'string')
  && (!draft.context || Number.isInteger(draft.context.issueRevision) && typeof draft.context.resolutionAt === 'string' && targetValid(draft.context.target)
    && draft.context.target.runId === draft.runId && (draft.context.target.taskRef?.id ?? '') === draft.taskId));

export function readIssueExecutionDraft(storage: DraftStorage, scope: IssueExecutionScope): IssueExecutionDraft | undefined {
  const raw = storage.getItem(issueExecutionKey(scope, 'draft')); if (raw === null) return;
  const draft = JSON.parse(raw) as IssueExecutionDraft;
  if (!draftValid(draft)) throw new Error('Invalid saved issue execution draft');
  return draft;
}
export function saveIssueExecutionDraft(storage: DraftStorage, scope: IssueExecutionScope, draft: IssueExecutionDraft) {
  storage.setItem(issueExecutionKey(scope, 'draft'), JSON.stringify(draft));
}
export function removeIssueExecutionDraft(storage: DraftStorage, scope: IssueExecutionScope, submitted: IssueExecutionDraft) {
  if (storage.getItem(issueExecutionKey(scope, 'draft')) === JSON.stringify(submitted)) storage.removeItem(issueExecutionKey(scope, 'draft'));
}
export function readIssueExecutionAttempt(storage: DraftStorage, scope: IssueExecutionScope): IssueExecutionAttempt | undefined {
  const raw = storage.getItem(issueExecutionKey(scope, 'pending')); if (raw === null) return;
  const attempt = JSON.parse(raw) as IssueExecutionAttempt | null, input = attempt?.input;
  if (!input || !['guidance', 'plan-edit'].includes(input.kind) || typeof input.requestId !== 'string' || !input.requestId
    || typeof input.text !== 'string' || !targetValid(input.target) || input.issueSource?.issueId !== scope.issueId
    || !Number.isInteger(input.issueSource.issueRevision) || typeof input.issueSource.resolutionAt !== 'string'
    || input.kind === 'guidance' && (!['lead', 'task'].includes(input.recipient?.kind)
      || input.recipient.kind === 'task' && input.recipient.id !== input.target.taskRef?.id)
    || input.kind === 'plan-edit' && (!input.proposal || !Array.isArray(input.proposal.tasks) || typeof input.proposal.baseVersion !== 'string')
    || attempt?.draft && !draftValid(attempt.draft)) throw new Error('Invalid saved issue execution identity');
  return attempt!;
}
export function saveIssueExecutionAttempt(storage: DraftStorage, scope: IssueExecutionScope, attempt: IssueExecutionAttempt) {
  storage.setItem(issueExecutionKey(scope, 'pending'), JSON.stringify(attempt));
}
export function removeIssueExecutionAttempt(storage: DraftStorage, scope: IssueExecutionScope, requestId: string) {
  if (readIssueExecutionAttempt(storage, scope)?.input.requestId === requestId) storage.removeItem(issueExecutionKey(scope, 'pending'));
}
export function issueExecutionContextMatches(left: IssueExecutionContext, right: IssueExecutionContext) {
  return left.issueRevision === right.issueRevision && left.resolutionAt === right.resolutionAt && left.planVersion === right.planVersion
    && left.target.runId === right.target.runId && left.target.statementVersionId === right.target.statementVersionId
    && left.target.taskRef?.id === right.target.taskRef?.id && left.target.taskRef?.version === right.target.taskRef?.version;
}
export function issueExecutionCanRetry(attempt: IssueExecutionAttempt, issue: ResearchIssue, observation?: WebObservation, running = false) {
  const { input } = attempt, source = input.issueSource;
  return Boolean(running && observation?.webRunId === input.target.runId && issue.status === 'resolved'
    && source?.issueId === issue.id && source.issueRevision === issue.revision && source.resolutionAt === issue.resolution?.createdAt
    && (!input.target.taskRef || observation.inspection.tasks.some(task => task.id === input.target.taskRef!.id && task.version === input.target.taskRef!.version))
    && (input.kind !== 'plan-edit' || input.proposal.baseVersion === observation.inspection.planVersion));
}
/** Existing unknown records remain recoverable even when created before local attempt persistence. */
export function issueExecutionAttemptFromFeedback(record: ResearchFeedback): IssueExecutionAttempt | undefined {
  if (!record.issueSource || !record.target || !['unknown', 'not-sent'].includes(record.delivery.status)) return;
  const { issueId, issueRevision, resolutionAt, proposalId, reviewedTaskRef } = record.issueSource;
  const common = { requestId: record.requestId, text: record.text, visibility: 'members' as const, target: record.target,
    issueSource: { issueId, issueRevision, resolutionAt, ...(proposalId ? { proposalId } : {}), ...(reviewedTaskRef ? { reviewedTaskRef } : {}) } };
  if (record.kind === 'guidance' && record.payload && 'recipient' in record.payload) return { input: { ...common, kind: 'guidance', recipient: record.payload.recipient } };
  if (record.kind === 'plan-edit' && record.payload && 'proposal' in record.payload) return { input: { ...common, kind: 'plan-edit', proposal: record.payload.proposal } };
}
