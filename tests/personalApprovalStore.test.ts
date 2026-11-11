import { describe, expect, it } from 'vitest';
import { checkPersonalApproval, completePersonalApprovalReview, observedPersonalApproval, personalApprovalNeedsReview, personalApprovalSettled, personalApprovalKey, readPersonalApproval, removePersonalApproval, requirePersonalApprovalReview, savePersonalApproval } from '../apps/web/client/personalApprovalStore';
import type { WebObservation } from '../apps/web/collaboration';
import { discussionDraftMatches, type DiscussionDraft } from '../apps/web/client/researchDiscussionDraft';
import { discussionContextHref } from '../apps/web/client/researchDiscussionContext';

function fixture() {
  const values = new Map<string, string>();
  return { values, storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } };
}
describe('personal approval recovery and saved discussion identity', () => {
  it('restores the original request and plan across storage readers while isolating account and run', () => {
    const { storage } = fixture(), original = { id: 'original-command', planVersion: 'original-plan' };
    savePersonalApproval(storage, 'alice', 'run-a', original);
    expect(readPersonalApproval(storage, 'alice', 'run-a')).toEqual(original);
    expect(readPersonalApproval(storage, 'bob', 'run-a')).toBeUndefined(); expect(readPersonalApproval(storage, 'alice', 'run-b')).toBeUndefined();
    savePersonalApproval(storage, 'alice', 'run-a', { id: 'later-command', planVersion: 'later-plan' });
    removePersonalApproval(storage, 'alice', 'run-a', original.id);
    expect(readPersonalApproval(storage, 'alice', 'run-a')?.id).toBe('later-command');
    removePersonalApproval(storage, 'alice', 'run-a', 'later-command'); expect(readPersonalApproval(storage, 'alice', 'run-a')).toBeUndefined();
  });
  it('surfaces unavailable or damaged storage instead of treating an unresolved command as absent', () => {
    const { storage, values } = fixture(); values.set(personalApprovalKey('alice', 'run-a'), '{broken');
    expect(() => readPersonalApproval(storage, 'alice', 'run-a')).toThrow();
    values.set(personalApprovalKey('alice', 'run-a'), JSON.stringify({ id: 'original-command' }));
    expect(() => readPersonalApproval(storage, 'alice', 'run-a')).toThrow('Invalid saved approval identity');
    expect(() => savePersonalApproval({ ...storage, setItem: () => { throw new Error('Storage unavailable'); } }, 'alice', 'run-a', { id: 'id', planVersion: 'v1' })).toThrow('Storage unavailable');
  });
  it('keeps an unknown receipt under its original ID without sending again', async () => {
    const calls: string[] = [], attempt = { id: 'original', planVersion: 'v1' };
    const receipt = await checkPersonalApproval({ root: '/api/runs/run-a', attempt, retry: true, currentPlanVersion: 'v1', missing: () => false,
      request: async url => { calls.push(url); return { receipt: { id: 'original', status: 'unknown' } }; } });
    expect(calls).toEqual(['/api/runs/run-a/commands/original']);
    expect(personalApprovalSettled(attempt, receipt!)).toBe(false);
    expect(() => personalApprovalSettled(attempt, { id: 'different', status: 'approved' })).toThrow('does not match');
  });
  it('only retries a missing receipt explicitly and for the same reviewed version', async () => {
    const attempt = { id: 'original', planVersion: 'v1' }, missing = new Error('404'), sent: unknown[] = [];
    const request = async (_url: string, init?: RequestInit) => { if (!init) throw missing; sent.push(JSON.parse(init.body as string)); return { receipt: { id: attempt.id, status: 'queued' } }; };
    for (const [retry, currentPlanVersion] of [[false, 'v1'], [true, 'v2'], [true, undefined]] as const) {
      expect(await checkPersonalApproval({ root: '/run', attempt, retry, currentPlanVersion, request, missing: cause => cause === missing })).toBeUndefined();
    }
    expect(sent).toEqual([]);
    await checkPersonalApproval({ root: '/run', attempt, retry: true, currentPlanVersion: 'v1', request, missing: cause => cause === missing });
    expect(sent).toEqual([attempt]);
    await expect(checkPersonalApproval({ root: '/run', attempt, retry: true, currentPlanVersion: 'v1', request, missing: () => false })).rejects.toBe(missing);
    expect(sent).toHaveLength(1);
  });
  it('settles only the original decision from explicit runner evidence', () => {
    const attempt = { id: 'original', planVersion: 'v1' };
    const observation = { inspection: { planApproval: { approvedId: 'another', rejections: [] } } } as unknown as WebObservation;
    expect(observedPersonalApproval(attempt, observation)).toBeUndefined();
    observation.inspection.planApproval!.rejections = [{ id: 'original', planVersion: 'v1', reason: 'math_plan_approval_version_conflict', at: 1 }];
    expect(observedPersonalApproval(attempt, observation)).toEqual({ id: 'original', planVersion: 'v1', status: 'rejected', reason: 'math_plan_approval_version_conflict' });
    expect(personalApprovalSettled(attempt, observedPersonalApproval(attempt, observation)!)).toBe(true);
  });
  it('retains required review after a rejection across readers without sharing it with another owner or run', () => {
    const { storage } = fixture();
    requirePersonalApprovalReview(storage, 'alice', 'run-a');
    expect(personalApprovalNeedsReview(storage, 'alice', 'run-a')).toBe(true);
    expect(personalApprovalNeedsReview(storage, 'bob', 'run-a')).toBe(false);
    expect(personalApprovalNeedsReview(storage, 'alice', 'run-b')).toBe(false);
    completePersonalApprovalReview(storage, 'alice', 'run-a');
    expect(personalApprovalNeedsReview(storage, 'alice', 'run-a')).toBe(false);
  });
  it('keeps the discussion route and draft bound to the complete saved historical context', () => {
    const context = { runId: 'run-a', statementVersionId: 'statement-a', observationRef: { sequence: 2, stateDigest: 'digest-a' }, taskRef: { id: 'lemma', version: 'v1' }, commit: 'commit-a' };
    const value: DiscussionDraft = { text: 'Explain the transition', visibility: 'members', baseline: { statementVersionId: 'statement-a', sourceDigest: 'source-a', context } };
    const href = new URL(discussionContextHref('project-a', context), 'http://localhost/');
    expect(Object.fromEntries(href.searchParams)).toEqual({ project: 'project-a', run: 'run-a', tab: 'route', task: 'lemma', taskVersion: 'v1', at: '2', atState: 'digest-a', commit: 'commit-a' });
    expect(discussionDraftMatches(value, structuredClone(value.baseline))).toBe(true);
    for (const next of [{ ...context, runId: 'run-b' }, { ...context, commit: 'commit-b' }, { ...context, taskRef: { id: 'lemma', version: 'v2' } },
      { ...context, observationRef: { sequence: 3, stateDigest: 'digest-a' } }, { ...context, observationRef: { sequence: 2, stateDigest: 'digest-b' } }]) {
      expect(discussionDraftMatches(value, { ...value.baseline, context: next })).toBe(false);
    }
  });
});
