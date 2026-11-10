import { useEffect, useRef, useState } from 'preact/hooks';
import { ResearchDraftStore, researchDraftKey, type ResearchDraft, type ResearchDraftScope } from './researchDraftStore';
import { ErrorBox, stamp, tx } from './researchShared';

export function useResearchDrafts<T>(owner: string, projectId: string, kind: ResearchDraftScope['kind']) {
  const [items, setItems] = useState<ResearchDraft<T>[]>([]), [error, setError] = useState('');
  const current = useRef<ResearchDraft<T>>();
  const store = () => new ResearchDraftStore(localStorage);
  const reload = () => {
    try { setItems(owner ? store().list<T>(owner, projectId, kind) : []); setError(''); }
    catch { setError(tx('无法读取本机草稿，请检查浏览器存储设置。', 'Local drafts could not be read. Check your browser storage settings.')); }
  };
  useEffect(() => { current.current = undefined; reload(); }, [owner, projectId, kind]);
  return {
    items, error,
    save(scope: Omit<ResearchDraftScope, 'owner' | 'projectId' | 'kind'>, value: T, summary: string) {
      if (!owner) return;
      try { current.current = store().save({ ...scope, owner, projectId, kind }, value, summary); reload(); }
      catch { setError(tx('本机草稿未保存，请保留当前页面或复制内容。', 'This draft was not saved locally. Keep the page open or copy your work.')); }
    },
    restore(item: ResearchDraft<T>) { current.current = item; },
    current: () => current.current,
    remove(item: ResearchDraft<T>, unchanged = false) {
      try {
        if (unchanged) store().removeIfUnchanged(item); else store().remove(item.scope);
        if (current.current && researchDraftKey(current.current.scope) === researchDraftKey(item.scope) && current.current.updatedAt === item.updatedAt) current.current = undefined;
        reload();
      } catch { setError(tx('未能删除本机草稿，请重试。', 'The local draft could not be removed. Try again.')); }
    },
  };
}

export function ResearchDraftPicker<T>({ drafts, onRestore, filter = () => true }: {
  drafts: ReturnType<typeof useResearchDrafts<T>>; onRestore(item: ResearchDraft<T>): void; filter?(item: ResearchDraft<T>): boolean;
}) {
  const items = drafts.items.filter(filter);
  return <div data-human-drafts><ErrorBox message={drafts.error} />{items.length > 0 && <details><summary>{tx(`本机草稿 · ${items.length}`, `Local drafts · ${items.length}`)}</summary>
    {items.map(item => <div class="collaboration-draft" key={researchDraftKey(item.scope)}><span>{item.summary} · {stamp(item.updatedAt)}</span>
      {item.scope.taskVersion && <code>{item.scope.taskId} · {item.scope.taskVersion} · {item.scope.commit?.slice(0, 12)}</code>}
      <div class="research-actions"><button class="button" type="button" data-restore-draft onClick={() => { drafts.restore(item); onRestore(item); }}>{tx('恢复草稿', 'Restore draft')}</button>
        <button class="text-button" type="button" data-discard-draft onClick={() => drafts.remove(item)}>{tx('丢弃草稿', 'Discard draft')}</button></div></div>)}</details>}</div>;
}
