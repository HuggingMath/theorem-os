import { describe, expect, it } from 'vitest';
import { libraryProposalDraftKey, readLibraryProposalDraft, writeLibraryProposalDraft } from '../apps/web/client/researchLibraryProposalDraft';
import { libraryProposalAttemptState } from '../apps/web/client/researchLibraryProposalAttemptModel';
import { researchLibraryProposalOriginSchema } from '../apps/web/researchLibraryProposalOrigin';
import { loadWebSample } from '../apps/web/sample';
import type { ResearchProjectDetail } from '../apps/web/researchProjectTypes';

const scope = { owner: 'account:alice', trialId: 'trial-a', trialDigest: 'a'.repeat(64) };
const origin = { projectId: 'project-a', feedbackId: 'feedback-a', trialDigest: scope.trialDigest };
function memory() { const items = new Map<string, string>(); return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, items }; }
function state() {
  const run = structuredClone(loadWebSample()!.run); run.libraryProposalOrigin = origin;
  const project = { id: origin.projectId, permissions: { edit: true }, runs: [], versions: [], feedback: [{ id: origin.feedbackId,
    target: { runId: 'original', statementVersionId: 'original-version' }, payload: { libraryTrial: { trial: { digest: scope.trialDigest } } } }] } as unknown as ResearchProjectDetail;
  return { run, project };
}
describe('Library proposal private draft continuity', () => {
  it('restores the selected project and separate explanations without persisting consent', () => {
    const storage = memory(), value = { projectId: 'second-project', texts: { 'first-project': 'Check n and its premise', 'second-project': 'Use the fixed lemma here' } };
    writeLibraryProposalDraft(storage, scope, value); expect(readLibraryProposalDraft(storage, scope)).toEqual(value);
    const stored = JSON.parse(storage.items.get(libraryProposalDraftKey(scope))!);
    expect(Object.keys(stored.value)).toEqual(['projectId', 'texts']);
  });
  it('isolates accounts, trials and fixed candidate digests, including older persisted drafts', () => {
    const storage = memory(); writeLibraryProposalDraft(storage, scope, { projectId: 'project-a', texts: { 'project-a': 'Keep my explanation' } });
    for (const other of [{ ...scope, owner: 'account:bob' }, { ...scope, trialId: 'trial-b' }, { ...scope, trialDigest: 'b'.repeat(64) }])
      expect(readLibraryProposalDraft(storage, other)).toBeUndefined();
    expect(readLibraryProposalDraft(storage, scope)?.texts['project-a']).toBe('Keep my explanation');
  });
  it('preserves an explicitly empty explanation and reports invalid stored data', () => {
    const storage = memory(); writeLibraryProposalDraft(storage, scope, { projectId: 'project-a', texts: { 'project-a': '' } });
    expect(readLibraryProposalDraft(storage, scope)?.texts['project-a']).toBe('');
    storage.setItem(libraryProposalDraftKey(scope), '{'); expect(() => readLibraryProposalDraft(storage, scope)).toThrow();
  });
});
describe('Library proposal origin and attachment planning', () => {
  it('accepts a fixed source reference only in its exact input shape', () => {
    expect(researchLibraryProposalOriginSchema.parse(origin)).toEqual(origin);
    expect(researchLibraryProposalOriginSchema.safeParse({ ...origin, approved: true }).success).toBe(false);
    expect(researchLibraryProposalOriginSchema.safeParse({ ...origin, trialDigest: 'stale' }).success).toBe(false);
  });
  it('requires an explicit new statement version for edited source and reuses a matching version', () => {
    const { run, project } = state(); expect(libraryProposalAttemptState(run, project).kind).toBe('new-version');
    project.versions.push({ id: 'same-source', source: run.source, environment: run.environment } as ResearchProjectDetail['versions'][number]);
    expect(libraryProposalAttemptState(run, project)).toMatchObject({ kind: 'ready', versionId: 'same-source' });
    run.source += '\n-- deliberately edited'; expect(libraryProposalAttemptState(run, project).kind).toBe('new-version');
  });
  it('keeps unavailable evidence and missing permission from becoming attachment approval', () => {
    const { run, project } = state(); project.permissions.edit = false;
    expect(libraryProposalAttemptState(run, project).kind).toBe('read-only');
    project.feedback = []; expect(libraryProposalAttemptState(run, project).kind).toBe('source-unavailable');
  });
  it('follows an existing exact run binding rather than creating another statement', () => {
    const { run, project } = state(); project.runs.push({ runId: run.id, statementVersionId: 'attached-version' } as ResearchProjectDetail['runs'][number]);
    expect(libraryProposalAttemptState(run, project)).toMatchObject({ kind: 'attached', versionId: 'attached-version' });
  });
});
