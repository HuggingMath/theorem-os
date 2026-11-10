import type { ResearchReleaseRef } from '../researchAssetTypes';
import type { WebEnvironment } from '../shared';

const prefix = 'theorem-os.library-return.';
type Entry = { refs: ResearchReleaseRef[]; environment?: WebEnvironment };
type EntryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const validRef = (value: unknown): value is ResearchReleaseRef => Boolean(value && typeof value === 'object'
  && 'assetId' in value && typeof value.assetId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value.assetId)
  && 'version' in value && typeof value.version === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(value.version)
  && (!('digest' in value) || typeof value.digest === 'string' && /^[a-f0-9]{64}$/u.test(value.digest)));

/** A deliberate anonymous Library choice contains fixed references only, never another owner's draft. */
export function rememberLibraryEntry(refs: ResearchReleaseRef[], environment?: WebEnvironment, storage: EntryStorage = sessionStorage) {
  if (!refs.length || refs.length > 32 || !refs.every(validRef)) throw new Error('library_entry_invalid');
  const nonce = crypto.randomUUID();
  storage.setItem(`${prefix}${nonce}`, JSON.stringify({ refs: refs.map(({ assetId, version, digest }) => ({ assetId, version, ...(digest ? { digest } : {}) })),
    ...(environment ? { environment } : {}) }));
  return nonce;
}

/** Consumed only after the destination account is bound. Unrelated draft storage is never transferred. */
export function takeLibraryEntry(search: string, storage: EntryStorage = sessionStorage): Entry | undefined {
  const nonce = new URLSearchParams(search).get('libraryReturn');
  if (!nonce || !/^[a-f0-9-]{36}$/u.test(nonce)) return;
  const raw = storage.getItem(`${prefix}${nonce}`);
  if (!raw) return;
  const entry: unknown = JSON.parse(raw);
  if (!entry || typeof entry !== 'object' || !('refs' in entry) || !Array.isArray(entry.refs)
    || !entry.refs.length || entry.refs.length > 32 || !entry.refs.every(validRef)
    || 'environment' in entry && entry.environment !== 'standard' && entry.environment !== 'mathlib') return;
  storage.removeItem(`${prefix}${nonce}`);
  return { refs: entry.refs, ...('environment' in entry ? { environment: entry.environment as WebEnvironment } : {}) };
}
