import { describe, expect, it } from 'vitest';
import type { ResearchFeedback } from '../apps/web/researchProjectTypes';
import { feedbackNeedsAttention, matchesFeedbackQuery, matchesFeedbackScope, matchesFeedbackStatus,
  taskFeedbackAnnotations } from '../apps/web/client/researchFeedbackModel';

function feedback(overrides: Partial<ResearchFeedback> = {}): ResearchFeedback {
  return { id: 'advice', requestId: 'request', projectId: 'project', author: { id: 'mathematician', displayName: 'Emmy Noether' },
    kind: 'guidance', text: 'Use the invariant before changing the route.', visibility: 'members',
    target: { runId: 'run-a', statementVersionId: 'statement-a', observationRef: { sequence: 4, stateDigest: 'digest' }, taskRef: { id: 'lemma', version: 'v1' } },
    delivery: { status: 'delivered' }, decision: { status: 'pending', evidenceRefs: [] }, execution: { status: 'not-started', taskRefs: [], resultRefs: [] },
    revision: 1, createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', ...overrides };
}

describe('research feedback scope and route annotations', () => {
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
});
