import { webAgentActionLimits, type WebAgentAction, type WebEvent, type WebRun } from '../shared';
import { agentRoutes, mergeAgentActions, type AgentRoute } from './agentRoute';

type Api = <T>(url: string) => Promise<T>;
type Entry = {
  run: WebRun;
  /** Events older than the run's own window, read once from the server, oldest first and without gaps. */ history: WebEvent[];
  /** Every action report read so far, in sequence order. */ actions: WebAgentAction[];
  dropped: number; version: number; busy: boolean; failed?: string; retryAt?: number;
  routes?: { key: string; value: AgentRoute[] };
};
export type AgentActivityState = { loading: boolean; failed?: string; dropped: number; version: number };

/**
 * What each Agent did in a run, for the route map: the run carries its last 200 events, so the older ones are read once
 * from /events, and the Agents' actions are read from /actions after the last one seen. One store serves both views,
 * so a run is read once.
 */
export class AgentActivity {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(runId: string) => void>();
  constructor(private api: Api) {}

  subscribe(listener: (runId: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  /** Reads what `run` does not carry yet; `poll` also asks for new actions of a running run, whose count is saved only now and then. */
  sync(run: WebRun, poll = false) {
    let entry = this.entries.get(run.id);
    if (!entry) { entry = { run, history: [], actions: [], dropped: 0, version: 0, busy: false }; this.entries.set(run.id, entry); }
    entry.run = run;
    if (entry.busy || (entry.retryAt && Date.now() < entry.retryAt) || !this.missing(entry, poll)) return;
    entry.busy = true;
    // A read that ends with something still missing (a record the server cannot read yet) waits before trying again.
    void this.load(entry).then(() => { entry.failed = undefined; entry.retryAt = this.missing(entry, false) ? Date.now() + 5_000 : undefined; },
      (error: unknown) => { entry.failed = error instanceof Error ? error.message : String(error); entry.retryAt = Date.now() + 10_000; })
      .finally(() => { entry.busy = false; entry.version++; this.changed(run.id); });
  }
  /** Tries a failed read again now. */
  retry(run: WebRun) {
    const entry = this.entries.get(run.id);
    if (entry) entry.retryAt = undefined;
    this.sync(run, true);
  }

  state(runId: string): AgentActivityState {
    const entry = this.entries.get(runId);
    return { loading: Boolean(entry?.busy), failed: entry?.failed, dropped: entry?.dropped ?? 0, version: entry?.version ?? 0 };
  }

  /** The route map of `run` with every event and action read so far; computed again only when one of them changed. */
  routes(run: WebRun, lead?: string): AgentRoute[] {
    const entry = this.entries.get(run.id), last = run.events.at(-1)?.sequence ?? 0;
    const key = [entry?.version ?? 0, run.events.length, last, lead ?? ''].join('|');
    if (entry?.routes?.key === key) return entry.routes.value;
    const known = entry?.history.at(-1)?.sequence ?? 0;
    const events = entry?.history.length ? [...entry.history, ...run.events.filter(event => event.sequence > known)] : run.events;
    const value = agentRoutes(events, { actions: mergeAgentActions(entry?.actions ?? []), lead });
    if (entry) entry.routes = { key, value };
    return value;
  }

  private missing(entry: Entry, poll: boolean) {
    const first = entry.run.events[0]?.sequence ?? 1, known = entry.history.at(-1)?.sequence ?? 0;
    const count = entry.run.actions?.count ?? 0, seen = entry.actions.at(-1)?.sequence ?? 0;
    return first > known + 1 || count > seen || (poll && entry.run.status === 'running');
  }
  private async load(entry: Entry) {
    const id = encodeURIComponent(entry.run.id);
    // A long run's earlier events, until they meet the run's window; the window moves on while this reads.
    for (let pages = 0; pages < 400; pages++) {
      const known = entry.history.at(-1)?.sequence ?? 0;
      if ((entry.run.events[0]?.sequence ?? 1) <= known + 1) break;
      const page = await this.api<{ events: WebEvent[] }>(`/api/runs/${id}/events?after=${known}`);
      const fresh = page.events.filter(event => event.sequence > known);
      if (!fresh.length) break;
      entry.history.push(...fresh);
      entry.version++; this.changed(entry.run.id);
    }
    for (let pages = 0; pages < 20; pages++) {
      const seen = entry.actions.at(-1)?.sequence ?? 0;
      const page = await this.api<{ actions: WebAgentAction[]; dropped: number }>(`/api/runs/${id}/actions?after=${seen}`);
      const fresh = page.actions.filter(action => action.sequence > seen);
      entry.dropped = page.dropped;
      if (!fresh.length) break;
      entry.actions.push(...fresh);
      entry.version++; this.changed(entry.run.id);
      if (fresh.length < webAgentActionLimits.page) break;
    }
  }
  private changed(runId: string) { for (const listener of this.listeners) listener(runId); }
}
