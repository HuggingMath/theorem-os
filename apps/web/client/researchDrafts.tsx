import { useEffect, useRef, useState } from 'preact/hooks';
import { ResearchDraftStore, researchDraftKey, type ResearchDraft, type ResearchDraftScope } from './researchDraftStore';
import type { ResearchAccountDraft, ResearchAccountDraftResult } from '../researchPersonalTypes';
import { api, base, enc, ErrorBox, errorText, stamp, tx } from './researchShared';

export function useResearchDrafts<T>(owner: string, projectId: string, kind: ResearchDraftScope['kind']) {
  const [items, setItems] = useState<ResearchDraft<T>[]>([]), [error, setError] = useState('');
  const current = useRef<ResearchDraft<T>>();
  const [memory, setMemory] = useState<ResearchDraft<T>>();
  const [account, setAccount] = useState(false), [remote, setRemote] = useState<ResearchAccountDraft[]>([]), [remoteError, setRemoteError] = useState('');
  const [remoteBusy, setRemoteBusy] = useState(false), [notice, setNotice] = useState('');
  const remoteLock = useRef(false), generation = useRef(0);
  const seenRevisions = useRef(new Map<string, number>()), pending = useRef<{ signature: string; body: object }>();
  const store = () => new ResearchDraftStore(localStorage);
  const reload = () => {
    try { setItems(owner ? store().list<T>(owner, projectId, kind) : []); setError(''); }
    catch { setError(tx('无法读取本机草稿，请检查浏览器存储设置。', 'Local drafts could not be read. Check your browser storage settings.')); }
  };
  const reloadAccount = async () => {
    const epoch = generation.current;
    try {
      const value = await api<{ account: boolean; items: ResearchAccountDraft[] }>(`${base}/personal/drafts?${new URLSearchParams({ projectId, kind })}`);
      if (epoch !== generation.current) return;
      setAccount(value.account); setRemote(value.items); setRemoteError('');
      value.items.forEach(item => seenRevisions.current.set(researchDraftKey(item.scope), item.revision));
    } catch (cause) { if (epoch === generation.current) setRemoteError(errorText(cause)); }
  };
  useEffect(() => {
    generation.current++; current.current = undefined; setMemory(undefined); seenRevisions.current.clear(); pending.current = undefined; setRemote([]); setNotice(''); setRemoteBusy(false); reload();
    if (owner) void reloadAccount();
    const storageChanged = () => reload(); window.addEventListener('storage', storageChanged);
    return () => { generation.current++; window.removeEventListener('storage', storageChanged); };
  }, [owner, projectId, kind]);
  return {
    items: memory && !items.some(item => researchDraftKey(item.scope) === researchDraftKey(memory.scope) && item.updatedAt === memory.updatedAt) ? [memory, ...items] : items,
    error, owner, projectId, kind, account, remote, remoteError, remoteBusy, notice, reloadAccount,
    save(scope: Omit<ResearchDraftScope, 'owner' | 'projectId' | 'kind'>, value: T, summary: string) {
      if (!owner) return;
      const revisionOf = value && typeof value === 'object' && 'revisionOf' in value ? value.revisionOf as { feedbackId?: string } | undefined : undefined;
      const target = { ...scope, owner, projectId, kind, ...(kind === 'candidate' && revisionOf?.feedbackId ? { sourceFeedbackId: revisionOf.feedbackId } : {}) };
      const local = [current.current, ...items].find(item => item && researchDraftKey(item.scope) === researchDraftKey(target));
      const accountRevision = local ? local.accountRevision ?? 0 : seenRevisions.current.get(researchDraftKey(target)) ?? 0;
      const draft: ResearchDraft<T> = { schema: 'theorem-os.human-draft.v1', scope: target, value, summary, updatedAt: new Date().toISOString(), accountRevision };
      current.current = draft; setMemory(draft);
      try { current.current = store().save(target, value, summary, accountRevision); setMemory(current.current); reload(); }
      catch { setError(tx('本机草稿未保存，请保留当前页面或复制内容。', 'This draft was not saved locally. Keep the page open or copy your work.')); }
    },
    restore(item: ResearchDraft<T>) { current.current = item; },
    async saveAccount(item: ResearchDraft<T>) {
      if (remoteLock.current || !account) return;
      remoteLock.current = true; setRemoteBusy(true); setRemoteError(''); setNotice('');
      const epoch = generation.current;
      try {
        const { owner: _owner, localRevision: _local, ...scope } = item.scope;
        const revisionOf = item.value && typeof item.value === 'object' && 'revisionOf' in item.value ? item.value.revisionOf as { feedbackId?: string } | undefined : undefined;
        if (scope.kind === 'candidate' && revisionOf?.feedbackId) scope.sourceFeedbackId = revisionOf.feedbackId;
        const signature = JSON.stringify([scope, item.value, item.summary, item.updatedAt]);
        if (pending.current?.signature !== signature) {
          let deviceId: string;
          try { deviceId = localStorage.getItem('theoremos:research-draft-device') ?? crypto.randomUUID(); localStorage.setItem('theoremos:research-draft-device', deviceId); }
          catch { deviceId = crypto.randomUUID(); }
          pending.current = { signature, body: { requestId: crypto.randomUUID(), expectedRevision: item.accountRevision ?? 0,
            scope, value: item.value, summary: item.summary.slice(0, 200), deviceId, deviceName: /Mobile|Android|iPhone|iPad/u.test(navigator.userAgent)
              ? tx('手机 / 平板', 'Phone / tablet') : tx('电脑浏览器', 'Desktop browser'), clientUpdatedAt: item.updatedAt } };
        }
        const response = await api<{ item: ResearchAccountDraftResult<T> }>(`${base}/personal/drafts`, { method: 'POST', body: JSON.stringify(pending.current.body) });
        pending.current = undefined; if (epoch !== generation.current) return;
        seenRevisions.current.set(researchDraftKey(response.item.draft.scope), response.item.draft.revision);
        const savedRevision = response.item.version.revision;
        if (current.current?.updatedAt === item.updatedAt) current.current = { ...current.current, accountRevision: savedRevision };
        setMemory(previous => previous?.updatedAt === item.updatedAt ? { ...previous, accountRevision: savedRevision } : previous);
        try { const marked = store().markAccountRevision(item, savedRevision); if (marked) { if (current.current?.updatedAt === item.updatedAt) current.current = marked; setMemory(marked); reload(); } } catch { /* The cloud version remains saved when local storage is unavailable. */ }
        setNotice(response.item.conflict || response.item.draft.revision !== savedRevision ? tx('另一台设备已有更新，两份版本都已保留。可分别恢复核对。', 'Another device saved an update. Both versions are preserved; restore either one to compare.')
          : tx('已保存到账号。', 'Saved to your account.'));
        await reloadAccount();
      } catch (cause) { if (epoch === generation.current) setRemoteError(errorText(cause)); }
      finally { remoteLock.current = false; if (epoch === generation.current) setRemoteBusy(false); }
    },
    async restoreAccount(id: string, versionId: string): Promise<ResearchDraft<T> | undefined> {
      if (remoteLock.current) return;
      remoteLock.current = true; setRemoteBusy(true); setRemoteError(''); const epoch = generation.current;
      try {
        const { item } = await api<{ item: ResearchAccountDraftResult<T> }>(`${base}/personal/drafts/${enc(id)}?version=${enc(versionId)}`);
        if (epoch !== generation.current || item.draft.scope.owner !== owner || item.draft.scope.projectId !== projectId || item.draft.scope.kind !== kind) return;
        const draft: ResearchDraft<T> = { schema: 'theorem-os.human-draft.v1', scope: item.draft.scope, value: item.version.value,
          summary: item.version.summary, updatedAt: item.version.clientUpdatedAt, accountRevision: item.draft.revision };
        try { current.current = store().restore(draft); reload(); }
        catch { current.current = draft; setError(tx('本机备份不可用；账号版本仍保留，请保留当前页面。', 'A local backup is unavailable. The account version is retained; keep this page open.')); }
        setMemory(current.current); seenRevisions.current.set(researchDraftKey(item.draft.scope), item.draft.revision);
        return draft;
      } catch (cause) { if (epoch === generation.current) setRemoteError(errorText(cause)); }
      finally { remoteLock.current = false; if (epoch === generation.current) setRemoteBusy(false); }
    },
    current: () => current.current,
    remove(item: ResearchDraft<T>, unchanged = false) {
      try {
        if (unchanged) store().removeIfUnchanged(item); else store().remove(item.scope);
        if (current.current && researchDraftKey(current.current.scope) === researchDraftKey(item.scope) && current.current.updatedAt === item.updatedAt) current.current = undefined;
        setMemory(previous => previous && researchDraftKey(previous.scope) === researchDraftKey(item.scope) && previous.updatedAt === item.updatedAt ? undefined : previous);
        reload();
      } catch { setError(tx('未能删除本机草稿，请重试。', 'The local draft could not be removed. Try again.')); }
    },
  };
}

export function ResearchDraftPicker<T>({ drafts, onRestore, filter = () => true }: {
  drafts: ReturnType<typeof useResearchDrafts<T>>; onRestore(item: ResearchDraft<T>): void; filter?(item: ResearchDraft<T>): boolean;
}) {
  const root = useRef<HTMLDivElement>(null), revealed = useRef('');
  const items = drafts.items.filter(filter);
  const remote = drafts.remote.filter(item => filter({ schema: 'theorem-os.human-draft.v1', scope: item.scope, summary: item.versions[0]?.summary ?? '',
    updatedAt: item.versions[0]?.clientUpdatedAt ?? '', value: (item.scope.kind === 'candidate' && item.scope.sourceFeedbackId ? { revisionOf: { feedbackId: item.scope.sourceFeedbackId } } : {}) as T }));
  const requested = new URLSearchParams(location.search).get('accountDraft'), requestedVersion = new URLSearchParams(location.search).get('draftVersion');
  useEffect(() => {
    if (!requested || !root.current || revealed.current === requested || !remote.some(item => item.id === requested)) return;
    revealed.current = requested;
    const outer = root.current.closest('details'); if (outer) outer.open = true;
    const account = root.current.querySelector<HTMLDetailsElement>('[data-account-drafts]>details'); if (account) account.open = true;
    root.current.scrollIntoView({ block: 'start' });
  }, [requested, remote]);
  return <div ref={root} data-human-drafts><ErrorBox message={drafts.error} />{items.length > 0 && <details><summary>{tx(`本机草稿 · ${items.length}`, `Local drafts · ${items.length}`)}</summary>
    {items.map(item => <div class="collaboration-draft" key={researchDraftKey(item.scope)}><span>{item.summary} · {stamp(item.updatedAt)}</span>
      {item.scope.taskVersion && <code>{item.scope.taskId} · {item.scope.taskVersion} · {item.scope.commit?.slice(0, 12)}</code>}
      <div class="research-actions"><button class="button" type="button" data-restore-draft onClick={() => { drafts.restore(item); onRestore(item); }}>{tx('恢复草稿', 'Restore draft')}</button>
        {drafts.account && <button class="button" type="button" disabled={drafts.remoteBusy} data-save-account-draft onClick={() => void drafts.saveAccount(item)}>{tx('保存到账号', 'Save to account')}</button>}
        <button class="text-button" type="button" data-discard-draft onClick={() => drafts.remove(item)}>{tx('丢弃草稿', 'Discard draft')}</button></div></div>)}</details>}
    <div class="research-account-drafts" data-account-drafts><ErrorBox message={drafts.remoteError} />
      {drafts.notice && <p role="status" data-account-draft-notice>{drafts.notice}</p>}
      {drafts.account && <details onToggle={event => { if (event.currentTarget.open) void drafts.reloadAccount(); }}><summary>{tx(`账号草稿 · ${remote.reduce((sum, item) => sum + item.versions.length, 0)} 个版本`, `Account drafts · ${remote.reduce((sum, item) => sum + item.versions.length, 0)} versions`)}</summary>
        <p class="research-field-note">{tx('由你选择保存和恢复。恢复只带回编辑内容，请核对目标与版本后继续。', 'Choose when to save and restore. Restoring loads the editor; review its goal and version before continuing.')}</p>
        <button type="button" class="text-button" disabled={drafts.remoteBusy} onClick={() => void drafts.reloadAccount()}>{tx('刷新账号版本', 'Refresh account versions')}</button>
        {remote.map(item => <section key={item.id} data-account-draft={item.id}>
          {item.scope.taskId && <p><code>{item.scope.taskId} · {item.scope.taskVersion} · {item.scope.commit?.slice(0, 12)}</code></p>}
          {item.versions.map(version => <div class="collaboration-draft" key={version.id} data-account-draft-version={version.id} data-requested={item.id === requested && (!requestedVersion || requestedVersion === version.id)}><strong>{version.summary}</strong>
            <p>{tx('版本', 'Version')} {version.revision} · {version.deviceName} · {stamp(version.savedAt)}</p>
            <p class="research-field-note">{tx('本机编辑时间：', 'Edited on device: ')}{stamp(version.clientUpdatedAt)}{version.conflict ? ` · ${tx('与其他设备并行保存，两个版本均保留', 'Saved alongside another device’s version; both are preserved')}` : ''}</p>
            <button type="button" class="button" data-restore-account-draft disabled={drafts.remoteBusy} onClick={() => void drafts.restoreAccount(item.id, version.id).then(restored => { if (restored) onRestore(restored); })}>{tx('恢复这个版本', 'Restore this version')}</button>
          </div>)}
        </section>)}
        {!remote.length && <p>{tx('还没有保存到账号的草稿。先编辑内容，再选择「保存到账号」。', 'No account drafts yet. Edit your work, then choose Save to account.')}</p>}
      </details>}
    </div>
  </div>;
}
