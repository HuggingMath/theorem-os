export type LibraryProposalDraftScope = { owner: string; trialId: string; trialDigest: string };
export type LibraryProposalDraft = { projectId: string; texts: Record<string, string> };
const schema = 'theorem-os.library-proposal-draft.v1';
export const libraryProposalDraftKey = (scope: LibraryProposalDraftScope) => `${schema}:${encodeURIComponent(JSON.stringify([
  scope.owner, scope.trialId, scope.trialDigest,
]))}`;
type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Explanations are private, per project and fixed candidate. Sharing consent is never stored. */
export function readLibraryProposalDraft(storage: DraftStorage, scope: LibraryProposalDraftScope): LibraryProposalDraft | undefined {
  const raw = storage.getItem(libraryProposalDraftKey(scope));
  if (raw === null) return;
  const item: unknown = JSON.parse(raw);
  if (!item || typeof item !== 'object' || !('schema' in item) || item.schema !== schema || !('value' in item)
    || !item.value || typeof item.value !== 'object') throw new Error('Invalid Library proposal draft');
  const value = item.value;
  if (!('projectId' in value) || typeof value.projectId !== 'string' || !('texts' in value)
    || !value.texts || typeof value.texts !== 'object' || Array.isArray(value.texts)) throw new Error('Invalid Library proposal draft');
  const texts = Object.fromEntries(Object.entries(value.texts).filter(([id, text]) => /^[A-Za-z0-9_-]{1,128}$/u.test(id)
    && typeof text === 'string' && text.length <= 8000));
  return { projectId: value.projectId, texts };
}
export function writeLibraryProposalDraft(storage: DraftStorage, scope: LibraryProposalDraftScope, value: LibraryProposalDraft) {
  storage.setItem(libraryProposalDraftKey(scope), JSON.stringify({ schema, value }));
}
