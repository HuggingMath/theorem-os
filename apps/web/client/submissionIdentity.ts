import { submissionStorageKey } from './ownedDrafts';
type Identity = { requestId: string; digest: string };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)])) : value;
async function digestOf(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
/** An uncertain POST keeps its identity through retries and refreshes; credentials are never retained here. */
export class SubmissionIdentity {
  private pending?: Identity;
  private generation = 0;
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly storageKey = submissionStorageKey) {}
  private restore() {
    if (!this.pending) try {
      const saved = JSON.parse(this.storage.getItem(this.storageKey) ?? 'null');
      if (saved && /^[a-f0-9-]{36}$/u.test(saved.requestId) && /^[a-f0-9]{64}$/u.test(saved.digest)) this.pending = saved;
    } catch { /* Keep an in-memory identity if persistence is unavailable. */ }
  }
  get unresolved() { this.restore(); return Boolean(this.pending); }
  async prepare<T extends { apiKey: string; saveKey?: boolean; requestId?: string }>(input: T): Promise<string> {
    const generation = this.generation;
    const { apiKey: _key, saveKey: _save, requestId: _id, ...visible } = input;
    const digest = await digestOf(canonical(visible));
    if (generation !== this.generation) throw new Error('Submission identity changed');
    this.restore();
    // Preserve uncertain Lean submissions made before identities used canonical object ordering.
    const previous = this.pending;
    const matches = previous?.digest === digest || Boolean(previous && previous.digest === await digestOf(visible));
    if (generation !== this.generation) throw new Error('Submission identity changed');
    this.pending = { requestId: matches ? previous!.requestId : crypto.randomUUID(), digest };
    try { this.storage.setItem(this.storageKey, JSON.stringify(this.pending)); } catch { /* Same-page retries remain safe. */ }
    return this.pending.requestId;
  }
  clear(requestId?: string) {
    if (requestId && this.pending?.requestId !== requestId) return;
    this.generation++;
    this.pending = undefined;
    try { this.storage.removeItem(this.storageKey); } catch { /* Storage is optional. */ }
  }
}
