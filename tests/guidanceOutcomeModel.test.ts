import { describe, expect, it, vi } from 'vitest';
import type { WebGuidanceRecord } from '../apps/web/collaboration';
import type { ResearchFeedback } from '../apps/web/researchProjectTypes';
import type { ResearchOverviewData } from '../apps/web/researchOverviewTypes';
import { findGuidanceFeedback, guidanceOutcome } from '../apps/web/client/guidanceOutcomeModel';
import { loadRunGuidanceFeedback } from '../apps/web/client/runGuidanceFeedback';

const feedback: ResearchFeedback = { id: 'feedback-a', requestId: 'guidance-a', projectId: 'project-a',
  author: { id: 'human', displayName: 'Mathematician' }, kind: 'guidance', text: 'Use the invariant.', visibility: 'members',
  target: { runId: 'run-a', statementVersionId: 'statement-a', observationRef: { sequence: 4, stateDigest: 'digest-a' } },
  delivery: { status: 'delivered' }, decision: { status: 'accepted', reason: 'The invariant removes an unneeded case split.', evidenceRefs: ['edit:edit-a'] },
  execution: { status: 'not-started', taskRefs: [], resultRefs: [] }, revision: 1,
  createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z' };
const guidance: WebGuidanceRecord = { id: 'guidance-a', text: feedback.text, recipient: { kind: 'lead' },
  observationRef: { sequence: 4, stateDigest: 'digest-a' }, status: 'delivered', createdAt: feedback.createdAt, updatedAt: feedback.updatedAt,
  decision: { guidanceId: 'guidance-a', status: 'accepted', reason: 'Use the invariant for the closing lemma.', workerId: 'lead',
    decidedAt: feedback.updatedAt, sourcePlanVersion: 'plan-v1',
    evidenceRefs: [{ kind: 'task', id: 'closing', version: 'closing-v2' }, { kind: 'plan', version: 'plan-v2' }] } };

describe('guidance follow-up from exact recorded references', () => {
  it('matches the project, run, request and statement instead of similar text', () => {
    const key = { projectId: 'project-a', runId: 'run-a', requestId: 'guidance-a', statementVersionId: 'statement-a' };
    expect(findGuidanceFeedback([feedback], key)).toBe(feedback);
    for (const change of [{ projectId: 'project-b' }, { runId: 'run-b' }, { requestId: 'guidance-b' }, { statementVersionId: 'statement-b' }])
      expect(findGuidanceFeedback([feedback], { ...key, ...change })).toBeUndefined();
  });

  it('does not equate acceptance with execution or proof success', () => {
    const result = guidanceOutcome(feedback);
    expect(result.decision?.status).toBe('accepted');
    expect(result.execution?.status).toBe('not-started');
    expect(result.taskRefs).toEqual([]);
    expect(result.evidenceRefs).toEqual(['edit:edit-a']);
  });

  it.each(['declined', 'needs-info', 'not-recorded'] as const)('preserves the recorded %s decision and its reason', status => {
    const reason = status === 'not-recorded' ? undefined : 'This direction needs a finite-dimensional assumption.';
    const result = guidanceOutcome({ ...feedback, decision: { status, reason, evidenceRefs: [] } });
    expect(result.decision?.status).toBe(status);
    expect(result.decision?.reason).toBe(reason);
    expect(result.execution?.status).toBe('not-started');
  });

  it('links only explicit execution task versions and deduplicates identical references', () => {
    const result = guidanceOutcome({ ...feedback, execution: { status: 'completed', planVersion: 'plan-v2',
      taskRefs: [{ id: 'closing', version: 'v1' }, { id: 'closing', version: 'v2' }, { id: 'closing', version: 'v2' }], resultRefs: ['check:a', 'edit:edit-a'] } });
    expect(result.taskRefs).toEqual([{ id: 'closing', version: 'v1' }, { id: 'closing', version: 'v2' }]);
    expect(result.evidenceRefs).toEqual(['edit:edit-a', 'check:a']);
  });

  it('supports a new standalone chat guidance through its actual runtime decision', () => {
    const result = guidanceOutcome(undefined, guidance);
    expect(result.decision?.status).toBe('accepted');
    expect(result.decision?.reason).toBe(guidance.decision?.reason);
    expect(result.execution).toBeUndefined();
    expect(result.taskRefs).toEqual([]);
    expect(result.decisionTaskRefs).toEqual([{ id: 'closing', version: 'closing-v2' }]);
    expect(result.evidenceRefs).toEqual(['task:closing@closing-v2', 'plan:plan-v2']);
  });

  it('does not assign a decision for another command or infer a decision merely from delivery', () => {
    expect(guidanceOutcome(undefined, { ...guidance, decision: { ...guidance.decision!, guidanceId: 'another-command' } }).recorded).toBe(false);
    expect(guidanceOutcome(undefined, { ...guidance, decision: undefined }).recorded).toBe(false);
    expect(guidanceOutcome().recorded).toBe(false);
  });

  it('keeps a project human decision authoritative over an older runtime decision', () => {
    expect(guidanceOutcome({ ...feedback, decision: { status: 'declined', reason: 'Missing hypothesis.', evidenceRefs: [] } }, guidance).decision?.status).toBe('declined');
  });
});

describe('reading guidance for a chat run', () => {
  it('avoids reading unrelated projects and filters same-named tasks in different bindings', async () => {
    const overview = { projects: [{ id: 'project-a', runs: [{ runId: 'run-a', statementVersionId: 'statement-a' }] },
      { id: 'project-b', runs: [{ runId: 'run-b', statementVersionId: 'statement-b' }] }], notifications: [] } as unknown as ResearchOverviewData;
    const request = vi.fn(async (url: string) => url === '/api/research/overview' ? overview : { items: [feedback,
      { ...feedback, id: 'wrong-project', projectId: 'project-b' },
      { ...feedback, id: 'wrong-run', target: { ...feedback.target!, runId: 'run-b' } },
      { ...feedback, id: 'wrong-statement', target: { ...feedback.target!, statementVersionId: 'statement-b' } }] });
    const results = await loadRunGuidanceFeedback('run-a', request as never);
    expect(results).toEqual([feedback]);
    expect(request.mock.calls.map(call => call[0])).toEqual(['/api/research/overview', '/api/research/theorems/project-a/feedback']);
  });

  it('returns no project records for an independent run without performing a delivery or another write', async () => {
    const request = vi.fn(async () => ({ projects: [], notifications: [] }));
    expect(await loadRunGuidanceFeedback('standalone-run', request as never)).toEqual([]);
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/research/overview');
  });

  it('retains a real read failure for the caller instead of presenting an empty successful read', async () => {
    const request = vi.fn(async () => { throw new Error('connection lost'); });
    await expect(loadRunGuidanceFeedback('run-a', request as never)).rejects.toThrow('connection lost');
  });
});
