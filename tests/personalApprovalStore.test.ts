import { describe, expect, it } from 'vitest';
import { personalApprovalKey, readPersonalApproval, removePersonalApproval, savePersonalApproval } from '../apps/web/client/personalApprovalStore';
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
