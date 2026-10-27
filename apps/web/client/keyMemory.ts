/**
 * Opt-in memory of one API Key for the current tab. It lives in sessionStorage, so closing the tab clears it, and it only
 * answers for the provider and address it was entered for; a key typed for one endpoint is never offered to another.
 */
export const keyMemoryStorageKey = 'theorem-os.web-api-key.v1';
type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
// Reading window.sessionStorage itself throws where storage is blocked.
type StorageSource = () => KeyStorage;
type Remembered = { providerId: string; baseUrl: string; apiKey: string };

function read(storage: StorageSource): Remembered | undefined {
  try {
    const value = JSON.parse(storage().getItem(keyMemoryStorageKey) ?? 'null');
    return value && typeof value.providerId === 'string' && typeof value.baseUrl === 'string' && typeof value.apiKey === 'string' && value.apiKey
      ? { providerId: value.providerId, baseUrl: value.baseUrl, apiKey: value.apiKey } : undefined;
  } catch { return undefined; }
}

export function rememberedKey(storage: StorageSource, providerId: string, baseUrl: string) {
  const value = read(storage);
  return value && value.providerId === providerId && value.baseUrl === baseUrl ? value.apiKey : undefined;
}
export const hasRememberedKey = (storage: StorageSource) => Boolean(read(storage));

/** False when the tab cannot store it; the key then lasts until the next submission, as before. */
export function rememberKey(storage: StorageSource, value: Remembered) {
  try { storage().setItem(keyMemoryStorageKey, JSON.stringify(value)); return true; }
  catch { return false; }
}
export function forgetKey(storage: StorageSource) {
  try { storage().removeItem(keyMemoryStorageKey); } catch { /* Nothing was stored. */ }
}
