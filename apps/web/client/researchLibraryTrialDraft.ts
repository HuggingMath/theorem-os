import type { ResearchLibraryTrialTargetRef } from '../researchLibraryTrialTypes';

export type LibraryTrialDraft = { declaration: string; proof: string; argumentNotes: string; missingPremises: string };
export type LibraryTrialDraftScope = { owner: string; assetId: string; releaseDigest: string; trialId: string; target: ResearchLibraryTrialTargetRef };
type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const libraryTrialTargetKey = (ref: ResearchLibraryTrialTargetRef) => JSON.stringify([ref.runId, ref.projectId ?? '', ref.taskId, ref.taskVersion,
  ref.commit, ref.sourceDigest, ref.environmentDigest, ref.file]);
export const libraryTrialDraftKey = (scope: LibraryTrialDraftScope) => 'theorem-os.library-trial-draft.v1:' + encodeURIComponent(JSON.stringify([
  scope.owner, scope.assetId, scope.releaseDigest, scope.trialId, libraryTrialTargetKey(scope.target),
]));

/** A draft contains editable fields only; checks, confirmations and source receipts stay with the prepared candidate. */
export function readLibraryTrialDraft(storage: DraftStorage, scope: LibraryTrialDraftScope): LibraryTrialDraft | undefined {
  const raw = storage.getItem(libraryTrialDraftKey(scope));
  if (raw === null) return;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !('schema' in value) || value.schema !== 'theorem-os.library-trial-draft.v1'
    || !('value' in value) || !value.value || typeof value.value !== 'object') throw new Error('Invalid trial draft');
  const fields = value.value;
  if (!('declaration' in fields) || typeof fields.declaration !== 'string' || !('proof' in fields) || typeof fields.proof !== 'string'
    || !('argumentNotes' in fields) || typeof fields.argumentNotes !== 'string' || !('missingPremises' in fields) || typeof fields.missingPremises !== 'string')
    throw new Error('Invalid trial draft fields');
  return { declaration: fields.declaration, proof: fields.proof, argumentNotes: fields.argumentNotes, missingPremises: fields.missingPremises };
}
export function writeLibraryTrialDraft(storage: DraftStorage, scope: LibraryTrialDraftScope, value: LibraryTrialDraft) {
  storage.setItem(libraryTrialDraftKey(scope), JSON.stringify({ schema: 'theorem-os.library-trial-draft.v1', value: {
    declaration: value.declaration, proof: value.proof, argumentNotes: value.argumentNotes, missingPremises: value.missingPremises,
  } }));
}
