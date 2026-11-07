import { webFormalizationActivityLimits, type WebFormalization, type WebFormalizationActivity } from '../formalizationTypes';

type Api = <T>(url: string) => Promise<T>;
type Entry = { item: WebFormalization; entries: WebFormalizationActivity[]; dropped: number; version: number; busy: boolean; failed?: string; retryAt?: number };

/**
 * What a formalization did, read from /activity after the last entry seen: each role's session actions, the Lean
 * compilations and the feedback between rounds. Owner-only, like a run's Agent actions.
 */
export class FormalizationActivityStore {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(id: string) => void>();
  constructor(private api: Api) {}

  subscribe(listener: (id: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  /** Reads the entries `item` counts that are not read yet. */
  sync(item: WebFormalization) {
    let entry = this.entries.get(item.id);
    if (!entry) { entry = { item, entries: [], dropped: 0, version: 0, busy: false }; this.entries.set(item.id, entry); }
    entry.item = item;
    const seen = entry.entries.at(-1)?.sequence ?? 0;
    if (entry.busy || (entry.retryAt && Date.now() < entry.retryAt) || (item.activity?.count ?? 0) <= seen) return;
    entry.busy = true;
    const current = entry;
    void this.load(current).then(() => { current.failed = undefined; current.retryAt = undefined; },
      (error: unknown) => { current.failed = error instanceof Error ? error.message : String(error); current.retryAt = Date.now() + 10_000; })
      .finally(() => { current.busy = false; current.version++; this.changed(item.id); });
  }
  retry(item: WebFormalization) {
    const entry = this.entries.get(item.id);
    if (entry) entry.retryAt = undefined;
    this.sync(item);
  }
  activity(id: string): readonly WebFormalizationActivity[] { return this.entries.get(id)?.entries ?? []; }
  state(id: string) {
    const entry = this.entries.get(id);
    return { loading: Boolean(entry?.busy), failed: entry?.failed, dropped: entry?.dropped ?? 0, version: entry?.version ?? 0 };
  }

  private async load(entry: Entry) {
    const id = encodeURIComponent(entry.item.id);
    for (let pages = 0; pages < 20; pages++) {
      const seen = entry.entries.at(-1)?.sequence ?? 0;
      const page = await this.api<{ activity: WebFormalizationActivity[]; dropped: number }>(`/api/formalizations/${id}/activity?after=${seen}`);
      const fresh = page.activity.filter(item => item.sequence > seen);
      entry.dropped = page.dropped;
      if (!fresh.length) break;
      entry.entries.push(...fresh);
      entry.version++; this.changed(entry.item.id);
      if (fresh.length < webFormalizationActivityLimits.page) break;
    }
  }
  private changed(id: string) { for (const listener of this.listeners) listener(id); }
}
