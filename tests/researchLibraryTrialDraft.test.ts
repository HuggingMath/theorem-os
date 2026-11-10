import { describe, expect, it } from 'vitest';
import { libraryTrialDraftKey, readLibraryTrialDraft, writeLibraryTrialDraft,
  type LibraryTrialDraft, type LibraryTrialDraftScope } from '../apps/web/client/researchLibraryTrialDraft';

const scope: LibraryTrialDraftScope = { owner: 'alice', assetId: 'addition', releaseDigest: 'release-a', trialId: 'candidate-a',
  target: { runId: 'run-a', taskId: 'goal', taskVersion: 'v1', commit: 'commit-a', sourceDigest: 'source-a', environmentDigest: 'environment-a', file: 'Main.lean' } };
const draft: LibraryTrialDraft = { declaration: 'Shared.zero', proof: 'by\n  exact Shared.zero n', argumentNotes: 'n is the target natural number', missingPremises: 'Verify the ambient order' };
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('Library trial editing drafts', () => {
  it('recovers revisions for their exact owner, release, candidate and frozen task without sharing another scope', () => {
    const local = storage(); writeLibraryTrialDraft(local, scope, draft);
    expect(readLibraryTrialDraft(local, scope)).toEqual(draft);
    for (const other of [{ ...scope, owner: 'bob' }, { ...scope, assetId: 'another-library' }, { ...scope, releaseDigest: 'release-b' },
      { ...scope, trialId: 'candidate-b' }, ...Object.keys(scope.target).map(key => ({ ...scope, target: { ...scope.target, [key]: 'changed' } })),
      { ...scope, target: { ...scope.target, projectId: 'another-project' } }]) {
      expect(readLibraryTrialDraft(local, other)).toBeUndefined();
    }
    const revised = { ...draft, proof: 'by\n  simpa using Shared.zero n', argumentNotes: 'Revised derivation' };
    writeLibraryTrialDraft(local, scope, revised);
    expect(readLibraryTrialDraft(local, scope)).toEqual(revised);
  });
  it('stores editable fields without restoring candidate checks or human confirmation', () => {
    const local = storage();
    writeLibraryTrialDraft(local, scope, { ...draft, confirmed: true, receipt: { passed: true } } as LibraryTrialDraft);
    expect(JSON.stringify([...local.values.values()])).not.toContain('confirmed');
    expect(JSON.stringify([...local.values.values()])).not.toContain('receipt');
    local.values.set(libraryTrialDraftKey(scope), JSON.stringify({ schema: 'theorem-os.library-trial-draft.v1', value: { ...draft, confirmed: true } }));
    expect(readLibraryTrialDraft(local, scope)).toEqual(draft);
  });
  it('reports unreadable or unsaved drafts so the editor can preserve work and show recovery actions', () => {
    const local = storage(); local.values.set(libraryTrialDraftKey(scope), '{broken');
    expect(() => readLibraryTrialDraft(local, scope)).toThrow();
    local.values.set(libraryTrialDraftKey(scope), JSON.stringify({ schema: 'theorem-os.library-trial-draft.v1', value: { proof: 3 } }));
    expect(() => readLibraryTrialDraft(local, scope)).toThrow('Invalid trial draft fields');
    expect(() => writeLibraryTrialDraft({ getItem: () => null, setItem: () => { throw new Error('Quota exceeded'); } }, scope, draft)).toThrow('Quota exceeded');
  });
});
