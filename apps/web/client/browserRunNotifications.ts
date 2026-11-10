import type { WebRun } from '../shared';
import { notifyStorageKey } from './runAwareness';

export type RunNoticeKind = 'finished' | 'waiting';
export function browserNotificationState(): 'on' | 'off' | 'blocked' | 'unsupported' {
  if (typeof Notification !== 'function') return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  try { return Notification.permission === 'granted' && localStorage.getItem(notifyStorageKey) === 'on' ? 'on' : 'off'; }
  catch { return 'off'; }
}

export function runNoticeIdentity(owner: string, run: WebRun, kind: RunNoticeKind) {
  return {
    key: `theorem-os.web-run-notice.v1:${encodeURIComponent(owner)}:${run.id}:${kind}`,
    revision: kind === 'finished' ? `${run.status}:${run.finishedAt ?? run.updatedAt}`
      : run.observation?.inspection.planApproval?.planVersion ?? run.updatedAt,
  };
}

const shown = new Map<string, string>();
/** Both workbench and research pages share one delivery record for the same account and run event. */
export async function notifyRunEvent(input: {
  owner: string; run: WebRun; kind: RunNoticeKind; title: string; body: string;
  activate(): void; current(): boolean;
}): Promise<boolean> {
  const { key, revision } = runNoticeIdentity(input.owner, input.run, input.kind);
  const deliver = () => {
    if (!input.current() || !document.hidden || browserNotificationState() !== 'on') return false;
    if (shown.get(key) === revision) return false;
    try { if (localStorage.getItem(key) === revision) return false; } catch { /* The in-page record still prevents repeats. */ }
    try {
      const notice = new Notification(input.title, { body: input.body, tag: `${key}:${revision}` });
      notice.onclick = () => { if (input.current()) { window.focus(); input.activate(); } notice.close(); };
      shown.set(key, revision);
      try { localStorage.setItem(key, revision); } catch { /* Some browsers disallow persistent storage. */ }
      return true;
    } catch { return false; } // A browser that cannot display notifications still gets the title indicator.
  };
  // Serialize simultaneous transitions in two open tabs; older hosts keep the shared record and notification tag.
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(key, deliver);
  return deliver();
}
