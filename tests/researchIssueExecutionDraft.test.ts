import { describe, expect, it } from 'vitest';
import type { WebObservation } from '../apps/web/collaboration';
import type { ResearchIssue } from '../apps/web/researchCollaborationTypes';
import type { ResearchFeedback } from '../apps/web/researchProjectTypes';
import { issueExecutionAttemptFromFeedback, issueExecutionCanRetry, issueExecutionContextMatches, issueExecutionKey,
  readIssueExecutionAttempt, readIssueExecutionDraft, removeIssueExecutionAttempt, removeIssueExecutionDraft,
  saveIssueExecutionAttempt, saveIssueExecutionDraft, type IssueExecutionAttempt, type IssueExecutionDraft } from '../apps/web/client/researchIssueExecutionDraft';
import { completeIssueReply, type IssueReplyDraft } from '../apps/web/client/researchIssueReplyDraft';

const scope = { owner: 'alice', projectId: 'project', issueId: 'issue' };
const target = { runId: 'run', statementVersionId: 'statement', observationRef: { sequence: 2, stateDigest: 'saved-state' }, taskRef: { id: 'goal', version: 'v1' } };
const draft = (): IssueExecutionDraft => ({ mode: 'plan-edit', runId: 'run', taskId: 'goal', text: 'Explain and construct the witness.',
  objective: 'Show why this witness solves the target.', dependencies: 'lemma-a, lemma-b', editedTask: 'goal',
  context: { issueRevision: 4, resolutionAt: 'resolved-at', target, planVersion: 'plan-v1' } });
const attempt = (): IssueExecutionAttempt => ({ input: { requestId: 'original-request', kind: 'guidance', text: 'Use this witness exactly once.',
  recipient: { kind: 'task', id: 'goal' }, target, visibility: 'members', issueSource: { issueId: 'issue', issueRevision: 4, resolutionAt: 'resolved-at' } }, draft: draft() });
const issue = { id: 'issue', revision: 4, status: 'resolved', resolution: { createdAt: 'resolved-at' } } as ResearchIssue;
const observation = { webRunId: 'run', inspection: { planVersion: 'plan-v1', tasks: [{ id: 'goal', version: 'v1' }] } } as WebObservation;
function fixture() {
  const values = new Map<string, string>();
  return { values, storage: { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } };
}

describe('issue action editing and original request recovery', () => {
  it('restores the complete editing draft and fixed context while isolating owner, project and issue', () => {
    const { storage } = fixture(), value = draft(); saveIssueExecutionDraft(storage, scope, value);
    expect(readIssueExecutionDraft(storage, scope)).toEqual(value);
    for (const other of [{ ...scope, owner: 'bob' }, { ...scope, projectId: 'another' }, { ...scope, issueId: 'another' }])
      expect(readIssueExecutionDraft(storage, other)).toBeUndefined();
    expect(issueExecutionContextMatches(value.context!, { ...value.context!, target: { ...target, observationRef: { sequence: 3, stateDigest: 'new-observation' } } })).toBe(true);
    for (const changed of [{ ...value.context!, issueRevision: 5 }, { ...value.context!, planVersion: 'plan-v2' },
      { ...value.context!, target: { ...target, taskRef: { id: 'goal', version: 'v2' } } }, { ...value.context!, target: { ...target, statementVersionId: 'different' } }])
      expect(issueExecutionContextMatches(value.context!, changed)).toBe(false);
    expect(readIssueExecutionDraft(storage, scope)?.context?.target.taskRef?.version).toBe('v1');
  });
  it('retains original command identity separately from later human editing', () => {
    const { storage } = fixture(), original = attempt(); saveIssueExecutionAttempt(storage, scope, original);
    const newer = { ...draft(), text: 'New argument typed while delivery is pending.' }; saveIssueExecutionDraft(storage, scope, newer);
    expect(readIssueExecutionAttempt(storage, scope)).toEqual(original);
    expect(readIssueExecutionAttempt(storage, { ...scope, owner: 'bob' })).toBeUndefined();
    removeIssueExecutionDraft(storage, scope, original.draft!);
    expect(readIssueExecutionDraft(storage, scope)).toEqual(newer);
    removeIssueExecutionAttempt(storage, scope, original.input.requestId);
    expect(readIssueExecutionAttempt(storage, scope)).toBeUndefined();
    expect(readIssueExecutionDraft(storage, scope)).toEqual(newer);
  });
  it('does not let a delayed receipt delete a newer pending request or draft', () => {
    const { storage } = fixture(), original = attempt(), next = { ...attempt(), input: { ...attempt().input, requestId: 'next-request' } };
    saveIssueExecutionAttempt(storage, scope, next); removeIssueExecutionAttempt(storage, scope, original.input.requestId);
    expect(readIssueExecutionAttempt(storage, scope)?.input.requestId).toBe('next-request');
    saveIssueExecutionDraft(storage, scope, draft()); removeIssueExecutionDraft(storage, scope, draft());
    expect(readIssueExecutionDraft(storage, scope)).toBeUndefined();
  });
  it('allows retry only against the same active resolution, run, task and plan', () => {
    expect(issueExecutionCanRetry(attempt(), issue, observation, true)).toBe(true);
    expect(issueExecutionCanRetry(attempt(), issue, observation, false)).toBe(false);
    expect(issueExecutionCanRetry(attempt(), { ...issue, revision: 5 }, observation, true)).toBe(false);
    expect(issueExecutionCanRetry(attempt(), { ...issue, status: 'open' }, observation, true)).toBe(false);
    expect(issueExecutionCanRetry(attempt(), issue, { ...observation, webRunId: 'another' }, true)).toBe(false);
    expect(issueExecutionCanRetry(attempt(), issue, { ...observation, inspection: { ...observation.inspection, tasks: [{ id: 'goal', version: 'v2' }] } } as WebObservation, true)).toBe(false);
    const plan: IssueExecutionAttempt = { input: { ...attempt().input, kind: 'plan-edit', proposal: { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [] } } };
    expect(issueExecutionCanRetry(plan, issue, observation, true)).toBe(true);
    expect(issueExecutionCanRetry(plan, issue, { ...observation, inspection: { ...observation.inspection, planVersion: 'plan-v2' } }, true)).toBe(false);
  });
  it('recovers a legacy unknown server record using the exact original input and no projection-only fields', () => {
    const original = attempt().input;
    const record = { ...original, id: 'feedback', requestId: original.requestId, delivery: { status: 'unknown' }, payload: { recipient: { kind: 'task', id: 'goal' } },
      issueSource: { ...original.issueSource, title: 'Issue title', resolution: { text: 'Resolution' } } } as ResearchFeedback;
    expect(issueExecutionAttemptFromFeedback(record)).toEqual({ input: original });
    expect(issueExecutionAttemptFromFeedback({ ...record, delivery: { status: 'delivered' } })).toBeUndefined();
  });
  it('surfaces unavailable or damaged storage instead of treating an unconfirmed action as absent', () => {
    const { storage, values } = fixture(); values.set(issueExecutionKey(scope, 'pending'), '{broken'); expect(() => readIssueExecutionAttempt(storage, scope)).toThrow();
    values.set(issueExecutionKey(scope, 'pending'), JSON.stringify({ ...attempt(), input: { ...attempt().input, issueSource: { ...attempt().input.issueSource, issueId: 'another' } } }));
    expect(() => readIssueExecutionAttempt(storage, scope)).toThrow('Invalid saved issue execution identity');
    values.set(issueExecutionKey(scope, 'draft'), JSON.stringify({ ...draft(), runId: 'different-run' })); expect(() => readIssueExecutionDraft(storage, scope)).toThrow();
    expect(() => saveIssueExecutionAttempt({ ...storage, setItem() { throw new Error('unavailable'); } }, scope, attempt())).toThrow('unavailable');
  });
});

describe('issue contribution completion', () => {
  const reply = (): IssueReplyDraft => ({ text: 'Reply to A', kind: 'comment', replyTo: 'proposal-a', proposalId: '', feedbackId: '', revision: 2 });
  it('clears only an unchanged submitted snapshot', () => {
    expect(completeIssueReply(reply(), reply(), 3)).toEqual({ ...reply(), text: '', replyTo: '', revision: 3 });
  });
  it('preserves the complete later reply, including a different target with the same body', () => {
    for (const newer of [{ ...reply(), text: 'New argument for B', replyTo: 'proposal-b' }, { ...reply(), replyTo: 'proposal-b' },
      { ...reply(), kind: 'proposal', feedbackId: 'feedback-b', proposalId: 'proposal-b' }])
      expect(completeIssueReply(newer, reply(), 3)).toEqual({ ...newer, revision: 3 });
  });
});
