import { useEffect, useState } from 'preact/hooks';
import type { ResearchCollaborationInbox } from '../researchCollaborationTypes';
import type { WebApi } from './collaborationUi';
import { base, ErrorBox, errorText, tx } from './researchShared';

export function CollaborationMessageSummary({ request }: { request: WebApi }) {
  const [data, setData] = useState<ResearchCollaborationInbox>(), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined, skipped = false;
    const controller = new AbortController(); setData(undefined);
    const schedule = (delay = 30_000) => {
      clearTimeout(timer);
      if (live && !document.hidden) timer = setTimeout(() => void read(), delay);
      else if (live) skipped = true;
    };
    const read = async () => {
      skipped = false;
      try { const result = await request<ResearchCollaborationInbox>(`${base}/collaboration/inbox`, { signal: controller.signal }); if (live) { setData(result); setError(''); } }
      catch (cause) { if (live && !controller.signal.aborted) setError(errorText(cause)); }
      schedule();
    };
    const visible = () => { if (live && !document.hidden && skipped) void read(); };
    document.addEventListener('visibilitychange', visible);
    void read();
    return () => { live = false; controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [request, revision]);
  return <div class="collaboration-message-summary" data-inbox-summary>
    <ErrorBox message={error} />{error && <button class="text-button" type="button" onClick={() => setRevision(value => value + 1)}>{tx('重新读取消息', 'Reload messages')}</button>}
    {!data && !error && <p role="status">{tx('正在读取待办与消息…', 'Loading decisions and messages…')}</p>}
    {data && <><div>{(['decision', 'reply', 'progress'] as const).map(category => <a key={category} href={`workspace.html?tab=inbox&inbox=${category}#collaboration-inbox`}>
      <strong>{data.counts[category]}</strong><span>{category === 'decision' ? tx('待决定', 'Decisions') : category === 'reply' ? tx('待回复', 'Replies') : tx('未读进展', 'Unread progress')}</span></a>)}</div>
      <a class="research-inline-link" href="workspace.html?tab=inbox&inbox=unread#collaboration-inbox">{tx(`查看全部消息 · ${data.unread} 条未读`, `All messages · ${data.unread} unread`)}</a></>}
  </div>;
}
