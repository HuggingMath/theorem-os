import { useEffect, useRef, useState } from 'preact/hooks';
import type { WebRun } from '../shared';
import { locale, t } from '../i18n';
import { resultDescription, runProgress } from '../presentation';
import { webDraftOwner } from './ownedDrafts';
import { documentTitle, newlyFinished, newlyWaiting, waitsForOwner } from './runAwareness';
import { notifyRunEvent } from './browserRunNotifications';
import { useResource, type ResearchContext } from './researchShared';

/** Continue the workbench's opted-in reminders while reading any signed-in research page. */
export function ResearchRunNotifications({ context, title }: { context: ResearchContext; title: string }) {
  const owner = webDraftOwner(context.web);
  const runs = useResource<{ runs: WebRun[] }>(context.session.authenticated ? '/api/runs' : undefined, 15_000);
  const previous = useRef<WebRun[]>([]), unseen = useRef(new Set<string>()), live = useRef(true);
  const [seenRevision, setSeenRevision] = useState(0);
  useEffect(() => {
    live.current = true;
    const visible = () => { if (!document.hidden) { unseen.current.clear(); setSeenRevision(value => value + 1); runs.refresh(); } };
    document.addEventListener('visibilitychange', visible);
    return () => { live.current = false; document.removeEventListener('visibilitychange', visible); document.title = title; };
  }, [owner, title]);
  useEffect(() => {
    const current = runs.data?.runs;
    if (!current) return;
    const finished = newlyFinished(previous.current, current), waiting = newlyWaiting(previous.current, current);
    previous.current = current;
    for (const [kind, events] of [['finished', finished], ['waiting', waiting]] as const) {
      for (const run of events) {
        if (document.hidden && kind === 'finished') unseen.current.add(run.id);
        void notifyRunEvent({ owner, run, kind,
          title: `TheoremOS · ${kind === 'waiting' ? t('研究计划等你批准') : runProgress(run).phaseLabel}`,
          body: `${run.title}\n${resultDescription(run)}`, current: () => live.current,
          activate: () => location.assign(`problem.html?${new URLSearchParams({ run: run.id, tab: 'overview', lang: locale })}`),
        });
      }
    }
    const active = current.filter(run => run.status === 'queued' || run.status === 'running');
    document.title = documentTitle(title, active.length, unseen.current.size, current.filter(waitsForOwner).length);
  }, [runs.data, owner, title, seenRevision]);
  return null;
}
