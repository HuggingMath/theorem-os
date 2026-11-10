import { describe, expect, it } from 'vitest';
import type { ResearchFeedback, ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { canRecordFeedbackDecision, feedbackDecisionStatuses, feedbackNeedsAttention, matchesFeedbackQuery, matchesFeedbackScope, matchesFeedbackStatus,
  taskFeedbackAnnotations } from '../apps/web/client/researchFeedbackModel';

function feedback(overrides: Partial<ResearchFeedback> = {}): ResearchFeedback {
  return { id: 'advice', requestId: 'request', projectId: 'project', author: { id: 'mathematician', displayName: 'Emmy Noether' },
    kind: 'guidance', text: 'Use the invariant before changing the route.', visibility: 'members',
    target: { runId: 'run-a', statementVersionId: 'statement-a', observationRef: { sequence: 4, stateDigest: 'digest' }, taskRef: { id: 'lemma', version: 'v1' } },
    delivery: { status: 'delivered' }, decision: { status: 'pending', evidenceRefs: [] }, execution: { status: 'not-started', taskRefs: [], resultRefs: [] },
    revision: 1, createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', ...overrides };
}

describe('research feedback scope and route annotations', () => {
  it('offers decisions only to authorized reviewers and keeps reviewed candidate authors out of self approval', () => {
    const project = { permissions: { edit: true, manage: true }, runs: [{ runId: 'run-a', permissions: { proof: true, guidance: true } }] } as Pick<ResearchProjectDetail, 'permissions' | 'runs'>;
    const candidate = feedback({ kind: 'proof-submission', candidateDelivery: { policy: 'reviewed', status: 'awaiting-review' } });
    expect(canRecordFeedbackDecision(candidate, project, candidate.author.id)).toBe(true);
    expect(feedbackDecisionStatuses(candidate, candidate.author.id)).toEqual(['declined', 'needs-info']);
    expect(feedbackDecisionStatuses(candidate, 'independent-reviewer')).toEqual(['accepted', 'declined', 'needs-info']);
    expect(canRecordFeedbackDecision(candidate, project, 'independent-reviewer')).toBe(true);
    const assigned = { ...candidate, review: { reviewer: { id: 'assigned-reviewer', displayName: 'Reviewer' }, assignedBy: { id: 'owner', displayName: 'Owner' }, assignedAt: '2026-11-10' } };
    const collaborator = { ...project, permissions: { ...project.permissions, manage: false } };
    expect(canRecordFeedbackDecision(assigned, collaborator, 'unassigned-member')).toBe(false);
    expect(canRecordFeedbackDecision(assigned, collaborator, 'assigned-reviewer')).toBe(true);
    expect(canRecordFeedbackDecision(candidate, { ...project, runs: [{ ...project.runs[0], permissions: { ...project.runs[0].permissions, proof: false } }] }, 'independent-reviewer')).toBe(false);
    expect(canRecordFeedbackDecision(feedback({ kind: 'discussion', target: undefined }), collaborator, 'independent-reviewer')).toBe(true);
  });
  it('keeps identically named tasks in different runs and versions separate', () => {
    const advice = feedback();
    expect(matchesFeedbackScope(advice, 'task', 'run-a', { runId: 'run-a', taskId: 'lemma', taskVersion: 'v1' })).toBe(true);
    expect(matchesFeedbackScope(advice, 'task', 'run-a', { runId: 'run-a', taskId: 'lemma', taskVersion: 'v2' })).toBe(false);
    expect(matchesFeedbackScope(advice, 'task', 'run-b', { runId: 'run-b', taskId: 'lemma', taskVersion: 'v1' })).toBe(false);
    expect(matchesFeedbackScope(advice, 'task', 'run-a', { runId: 'run-b', taskId: 'lemma', taskVersion: 'v1' })).toBe(false);
    expect(matchesFeedbackScope(advice, 'task', 'run-a')).toBe(false);
  });

  it('adds only recorded execution links to another task version without counting duplicate references', () => {
    const advice = feedback({ execution: { status: 'running', taskRefs: [{ id: 'lemma', version: 'v1' }, { id: 'lemma', version: 'v2' }, { id: 'lemma', version: 'v2' }], resultRefs: [] } });
    expect(matchesFeedbackScope(advice, 'task', 'run-a', { runId: 'run-a', taskId: 'lemma', taskVersion: 'v2' })).toBe(true);
    expect(taskFeedbackAnnotations([advice], 'run-a')).toEqual([
      { taskId: 'lemma', taskVersion: 'v1', total: 1, attention: 1 },
      { taskId: 'lemma', taskVersion: 'v2', total: 1, attention: 1 },
    ]);
    expect(taskFeedbackAnnotations([advice], 'run-b')).toEqual([]);
  });

  it('retains standalone discussions in the theorem scope without assigning them to a run', () => {
    const discussion = feedback({ kind: 'discussion', target: undefined });
    expect(matchesFeedbackScope(discussion, 'all')).toBe(true);
    expect(matchesFeedbackScope(discussion, 'run', 'run-a')).toBe(false);
    expect(taskFeedbackAnnotations([discussion], 'run-a')).toEqual([]);
  });

  it('filters saved step discussions by their cited run and version without creating an execution target', () => {
    const discussion = feedback({ kind: 'discussion', target: undefined, discussionContext: { runId: 'run-a', statementVersionId: 'statement-a',
      observationRef: { sequence: 1, stateDigest: 'saved' }, taskRef: { id: 'lemma', version: 'old-version' }, commit: 'old-commit' } });
    expect(matchesFeedbackScope(discussion, 'run', 'run-a')).toBe(true);
    expect(matchesFeedbackScope(discussion, 'task', 'run-a', { runId: 'run-a', taskId: 'lemma', taskVersion: 'old-version' })).toBe(true);
    expect(matchesFeedbackScope(discussion, 'task', 'run-a', { runId: 'run-a', taskId: 'lemma', taskVersion: 'v1' })).toBe(false);
    expect(matchesFeedbackScope(discussion, 'run', 'run-b')).toBe(false);
    expect(taskFeedbackAnnotations([discussion], 'run-a')).toEqual([{ taskId: 'lemma', taskVersion: 'old-version', total: 1, attention: 1 }]);
  });

  it('separates delivery, decision and execution when classifying attention and results', () => {
    const accepted = feedback({ decision: { status: 'accepted', evidenceRefs: [] } });
    expect(matchesFeedbackStatus(accepted, 'accepted')).toBe(true);
    expect(matchesFeedbackStatus(accepted, 'completed')).toBe(false);
    expect(matchesFeedbackStatus(accepted, 'executing')).toBe(false);
    expect(feedbackNeedsAttention(accepted)).toBe(false);
    expect(feedbackNeedsAttention({ ...accepted, delivery: { status: 'unknown' } })).toBe(true);
    expect(feedbackNeedsAttention({ ...accepted, decision: { status: 'needs-info', evidenceRefs: [] } })).toBe(true);
    expect(feedbackNeedsAttention({ ...accepted, execution: { status: 'failed', taskRefs: [], resultRefs: [] } })).toBe(true);
    expect(matchesFeedbackStatus({ ...accepted, execution: { status: 'completed', taskRefs: [], resultRefs: ['check:independent'] } }, 'completed')).toBe(true);
  });

  it('searches the author and recorded evidence without deriving task relationships from prose', () => {
    const advice = feedback({ text: 'Try task goal-v3.', decision: { status: 'accepted', evidenceRefs: ['check:Receipt-A'] } });
    expect(matchesFeedbackQuery(advice, 'NOETHER')).toBe(true);
    expect(matchesFeedbackQuery(advice, 'receipt-a')).toBe(true);
    expect(matchesFeedbackQuery(advice, 'missing evidence')).toBe(false);
    expect(matchesFeedbackScope(advice, 'task', 'run-a', { runId: 'run-a', taskId: 'goal', taskVersion: 'v3' })).toBe(false);
  });
  it('retains obsolete candidate history without counting it as a pending action', () => {
    for (const obsolete of [feedback({ supersededBy: 'candidate-v2' }), feedback({ candidateDelivery: { policy: 'reviewed', status: 'withdrawn' } }),
      feedback({ continuation: { action: 'end', actor: { id: 'author', displayName: 'Author' }, text: 'The contract changed', createdAt: '2026-11-09' } })]) {
      expect(feedbackNeedsAttention(obsolete)).toBe(false); expect(matchesFeedbackStatus(obsolete, 'pending')).toBe(false);
      expect(matchesFeedbackStatus(obsolete, 'all')).toBe(true);
    }
  });
});
