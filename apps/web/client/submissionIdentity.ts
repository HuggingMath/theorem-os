import type { WebRunRequest } from '../shared';
import { submissionStorageKey } from './ownedDrafts';
type Identity = { requestId: string; digest: string };
/** An uncertain POST keeps its identity through retries and refreshes; credentials are never retained here. */
export class SubmissionIdentity {
  private pending?: Identity;
  private generation = 0;
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {}
  async prepare(input: WebRunRequest): Promise<string> {
    const generation = this.generation;
    const { apiKey: _key, saveKey: _save, requestId: _id, ...visible } = input;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(visible)));
    if (generation !== this.generation) throw new Error('Submission identity changed');
    const digest = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (!this.pending) try {
      const saved = JSON.parse(this.storage.getItem(submissionStorageKey) ?? 'null');
      if (saved && /^[a-f0-9-]{36}$/u.test(saved.requestId) && /^[a-f0-9]{64}$/u.test(saved.digest)) this.pending = saved;
    } catch { /* Keep an in-memory identity if persistence is unavailable. */ }
    if (this.pending?.digest !== digest) this.pending = { requestId: crypto.randomUUID(), digest };
    try { this.storage.setItem(submissionStorageKey, JSON.stringify(this.pending)); } catch { /* Same-page retries remain safe. */ }
    return this.pending.requestId;
  }
  clear(requestId?: string) {
    if (requestId && this.pending?.requestId !== requestId) return;
    this.generation++;
    this.pending = undefined;
    try { this.storage.removeItem(submissionStorageKey); } catch { /* Storage is optional. */ }
  }
}
