import { describe, expect, it } from 'vitest';
import { ResearchDraftStore, type ResearchDraftScope } from '../apps/web/client/researchDraftStore';
import { discussionDraftMatches, type DiscussionDraft } from '../apps/web/client/researchDiscussionDraft';

function fixture() {
  const values = new Map<string, string>();
  return { values, store: new ResearchDraftStore({ get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }) };
}
const scope: ResearchDraftScope = { owner: 'alice', projectId: 'project-a', kind: 'candidate', runId: 'run-a', statementVersionId: 'statement-a', taskId: 'goal', taskVersion: 'v1', commit: 'commit-a' };
describe('owner-isolated human drafts', () => {
  it('restores the exact frozen baseline and separates owners, projects, commits and task versions', () => {
    const { store, values } = fixture(), value = { source: 'edited source', baseSource: { source: 'old baseline', commit: 'commit-a' }, baseObservation: { sequence: 1, stateDigest: 'old-digest' } };
    store.save(scope, value, 'Alice draft');
    store.save({ ...scope, owner: 'bob' }, { source: 'private Bob source' }, 'Bob draft');
    store.save({ ...scope, projectId: 'project-b' }, { source: 'another project' }, 'Project B');
    store.save({ ...scope, taskVersion: 'v2', commit: 'commit-b' }, { source: 'next source' }, 'Next baseline');
    expect(values.size).toBe(4);
    const drafts = store.list<typeof value>('alice', 'project-a', 'candidate'); expect(drafts).toHaveLength(2);
    expect(drafts.find(item => item.scope.commit === 'commit-a')?.value).toEqual(value);
    expect(JSON.stringify(drafts)).not.toContain('private Bob source'); expect(JSON.stringify(drafts)).not.toContain('another project');
    store.remove(scope); expect(store.list('bob', 'project-a', 'candidate')).toHaveLength(1);
  });
  it('does not discard newer edits when an earlier request succeeds', () => {
    const { store } = fixture(), submitted = store.save(scope, { source: 'submitted' }, 'Submitted');
    store.save(scope, { source: 'new edits during request' }, 'New work'); store.removeIfUnchanged(submitted);
    expect(store.list<{ source: string }>('alice', 'project-a', 'candidate')[0].value.source).toBe('new edits during request');
    const current = store.list('alice', 'project-a', 'candidate')[0]; store.removeIfUnchanged(current); expect(store.list('alice', 'project-a', 'candidate')).toEqual([]);
  });
  it('isolates issue replies by exact revision and reports storage failures', () => {
    const { store } = fixture();
    store.save({ ...scope, kind: 'issue-reply', issueId: 'issue-1', issueRevision: 2 }, { text: 'original reply' }, 'Original');
    store.save({ ...scope, kind: 'issue-reply', issueId: 'issue-1', issueRevision: 3 }, { text: 'new revision' }, 'New');
    expect(store.list('alice', 'project-a', 'issue-reply')).toHaveLength(2);
    const blocked = new ResearchDraftStore({ length: 0, key: () => null, getItem: () => null, setItem: () => { throw new Error('Quota exceeded'); }, removeItem: () => {} });
    expect(() => blocked.save(scope, { source: 'work' }, 'Draft')).toThrow('Quota exceeded');
  });
  it('restores discussion content and visibility for its account and exact statement while preserving other versions', () => {
    const { store, values } = fixture();
    const discussionScope: ResearchDraftScope = { owner: 'alice', projectId: 'project-a', kind: 'discussion', statementVersionId: 'statement-a' };
    const value: DiscussionDraft = { text: 'Explain the missing induction step', visibility: 'public', baseline: { statementVersionId: 'statement-a', sourceDigest: 'digest-a' } };
    const submitted = store.save(discussionScope, value, value.text);
    store.save({ ...discussionScope, statementVersionId: 'statement-b' }, { ...value, text: 'A different statement', baseline: { statementVersionId: 'statement-b', sourceDigest: 'digest-b' } }, 'Version B');
    store.save({ ...discussionScope, owner: 'bob' }, { ...value, text: 'Bob private discussion', visibility: 'members' }, 'Bob');
    store.save({ ...discussionScope, projectId: 'project-b' }, { ...value, text: 'Another project' }, 'Project B');
    const reloaded = new ResearchDraftStore({ get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } });
    const drafts = reloaded.list<DiscussionDraft>('alice', 'project-a', 'discussion');
    expect(drafts).toHaveLength(2); expect(drafts.find(item => item.scope.statementVersionId === 'statement-a')?.value).toEqual(value);
    expect(JSON.stringify(drafts)).not.toContain('Bob private discussion'); expect(JSON.stringify(drafts)).not.toContain('Another project');
    reloaded.removeIfUnchanged(submitted); expect(reloaded.list('alice', 'project-a', 'discussion')).toHaveLength(1);
    expect(reloaded.list('bob', 'project-a', 'discussion')).toHaveLength(1);
  });
  it('requires explicit review when a restored discussion uses a changed statement or source', () => {
    const draft: DiscussionDraft = { text: 'Preserved reasoning', visibility: 'members', baseline: { statementVersionId: 'v1', sourceDigest: 'source-1' } };
    expect(discussionDraftMatches(draft, { statementVersionId: 'v1', sourceDigest: 'source-1' })).toBe(true);
    expect(discussionDraftMatches(draft, { statementVersionId: 'v2', sourceDigest: 'source-1' })).toBe(false);
    expect(discussionDraftMatches(draft, { statementVersionId: 'v1', sourceDigest: 'source-2' })).toBe(false);
    expect(discussionDraftMatches(draft, {})).toBe(false);
    const reviewed = { ...draft, baseline: { statementVersionId: 'v2', sourceDigest: 'source-2' } };
    expect(discussionDraftMatches(reviewed, { statementVersionId: 'v2', sourceDigest: 'source-2' })).toBe(true); expect(reviewed.text).toBe(draft.text);
  });
});
