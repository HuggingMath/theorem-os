import { describe, expect, it } from 'vitest';
import { personalGuidanceKey, personalGuidanceTargetCurrent, readPersonalGuidance, removePersonalGuidance, savePersonalGuidance, type PersonalGuidanceAttempt } from '../apps/web/client/personalGuidanceStore';
import { handoffDraftKey, handoffDraftNeedsReview, readHandoffDraft, removeHandoffDraft, saveHandoffDraft, type HandoffDraft } from '../apps/web/client/researchHandoffDraft';
import { reviewerMembersHref } from '../apps/web/client/researchReviewerNavigation';
import type { WebObservation } from '../apps/web/collaboration';
const storageFixture = () => {
  const values = new Map<string, string>();
  return { values, storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } };
};
const guidance = (): PersonalGuidanceAttempt => ({ body: { id: 'original', text: 'Preserve this argument', recipient: { kind: 'task', id: 'lemma' }, taskRef: { id: 'lemma', version: 'v1' }, observationRef: { sequence: 3, stateDigest: 'state-3' } }, planVersion: 'plan-1', value: { text: 'Preserve this argument', planVersion: 'plan-1', observationRef: { sequence: 3, stateDigest: 'state-3' } } });
const scope = { owner: 'alice', projectId: 'project', runId: 'run', taskId: 'lemma' };
const handoff = (): HandoffDraft => ({ target: { runId: 'run', statementVersionId: 'statement-1', observationRef: { sequence: 3, stateDigest: 'state-3' }, taskRef: { id: 'lemma', version: 'v1' } }, recipientId: 'bob', note: 'Current result and next step', members: 'bob:collaborator', revision: 'draft-1' });

describe('personal guidance delivery recovery', () => {
  it('preserves the original ID, target, observation and text across readers, isolated by account and run', () => {
    const { storage } = storageFixture(), value = guidance(); savePersonalGuidance(storage, 'alice', 'run', value);
    expect(readPersonalGuidance(storage, 'alice', 'run')).toEqual(value);
    expect(readPersonalGuidance(storage, 'bob', 'run')).toBeUndefined(); expect(readPersonalGuidance(storage, 'alice', 'other')).toBeUndefined();
    savePersonalGuidance(storage, 'alice', 'run', { ...value, body: { ...value.body, id: 'newer' } });
    removePersonalGuidance(storage, 'alice', 'run', value.body.id); expect(readPersonalGuidance(storage, 'alice', 'run')?.body.id).toBe('newer');
    removePersonalGuidance(storage, 'alice', 'run', 'newer'); expect(readPersonalGuidance(storage, 'alice', 'run')).toBeUndefined();
  });
  it('surfaces damaged or unavailable storage rather than allowing another send', () => {
    const { storage, values } = storageFixture(); values.set(personalGuidanceKey('alice', 'run'), '{broken'); expect(() => readPersonalGuidance(storage, 'alice', 'run')).toThrow();
    values.set(personalGuidanceKey('alice', 'run'), JSON.stringify({ ...guidance(), body: { ...guidance().body, taskRef: { id: 'another', version: 'v1' } } })); expect(() => readPersonalGuidance(storage, 'alice', 'run')).toThrow();
    expect(() => savePersonalGuidance({ ...storage, setItem() { throw new Error('unavailable'); } }, 'alice', 'run', guidance())).toThrow('unavailable');
  });
  it('permits retry only while the original plan and task version are active', () => {
    const observation = { inspection: { planVersion: 'plan-1', tasks: [{ id: 'lemma', version: 'v1' }] } } as WebObservation;
    expect(personalGuidanceTargetCurrent(guidance(), observation, true)).toBe(true);
    expect(personalGuidanceTargetCurrent(guidance(), observation, false)).toBe(false);
    expect(personalGuidanceTargetCurrent(guidance(), { ...observation, inspection: { ...observation.inspection, planVersion: 'plan-2' } }, true)).toBe(false);
    expect(personalGuidanceTargetCurrent(guidance(), { ...observation, inspection: { ...observation.inspection, tasks: [] } }, true)).toBe(false);
  });
});
describe('formal handoff drafts', () => {
  it('restores recipient and note without silently rebinding a changed task version or membership', () => {
    const { storage } = storageFixture(), draft = handoff(); saveHandoffDraft(storage, scope, draft);
    expect(readHandoffDraft(storage, scope)).toEqual(draft);
    expect(readHandoffDraft(storage, { ...scope, owner: 'other' })).toBeUndefined(); expect(readHandoffDraft(storage, { ...scope, taskId: 'other' })).toBeUndefined();
    expect(handoffDraftNeedsReview(draft, draft.target, draft.members)).toBe(false);
    expect(handoffDraftNeedsReview(draft, { ...draft.target, taskRef: { id: 'lemma', version: 'v2' } }, draft.members)).toBe(true);
    expect(handoffDraftNeedsReview(draft, draft.target, 'bob:reader')).toBe(true);
    expect(readHandoffDraft(storage, scope)?.target.taskRef?.version).toBe('v1');
  });
  it('a delayed success removes only its exact submitted draft', () => {
    const { storage } = storageFixture(), draft = handoff(); saveHandoffDraft(storage, scope, draft);
    const newer = { ...draft, note: 'New work typed while waiting', revision: 'draft-2' }; saveHandoffDraft(storage, scope, newer);
    removeHandoffDraft(storage, scope, draft); expect(readHandoffDraft(storage, scope)).toEqual(newer);
    removeHandoffDraft(storage, scope, newer); expect(readHandoffDraft(storage, scope)).toBeUndefined();
  });
  it('reports corrupted records instead of losing the stored note', () => {
    const { storage, values } = storageFixture(); values.set(handoffDraftKey(scope), '{broken'); expect(() => readHandoffDraft(storage, scope)).toThrow();
  });
});
it('retains the candidate and exact source context through member navigation', () => {
  const url = new URL(reviewerMembersHref('project', { id: 'candidate', target: handoff().target }), 'http://localhost/');
  expect(Object.fromEntries(url.searchParams)).toEqual({ id: 'project', reviewFeedback: 'candidate', run: 'run', version: 'statement-1', task: 'lemma', taskVersion: 'v1' });
  expect(url.hash).toBe('#collaboration-members');
});
