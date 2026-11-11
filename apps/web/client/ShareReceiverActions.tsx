import { useEffect, useRef, useState } from 'preact/hooks';
import { locale, localizeMessage } from '../i18n';
import type { WebSession } from '../shared';
import type { WebShareSnapshot } from '../shareTypes';
import type { ResearchCollection } from '../researchCollectionTypes';
import type { SharedProofPreparation, SharedProofReading } from '../sharedProofTypes';
import { Rich } from './richText';
import { shareLoginLink } from './shareContinuation';

const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
type Mode = 'bookmark' | 'prepare';
type Pending = { signature: string; body: Record<string, unknown> };
export function ShareReceiverActions({ share, token, readingId }: { share: WebShareSnapshot; token?: string; readingId?: string }) {
  const [mode, setMode] = useState<Mode>(), [session, setSession] = useState<WebSession>(), [login, setLogin] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [collections, setCollections] = useState<ResearchCollection[]>([]);
  const [selected, setSelected] = useState(''), [title, setTitle] = useState(''), [note, setNote] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [sharedId, setSharedId] = useState(readingId), [noteEdited, setNoteEdited] = useState(false);
  const [saved, setSaved] = useState<string>();
  const registerId = useRef(crypto.randomUUID()), preparationId = useRef(crypto.randomUUID());
  const registered = useRef<Pick<SharedProofReading, 'id' | 'digest'>>();
  const createPending = useRef<Pending>(), savePending = useRef<Pending>(), lock = useRef(false);
  const noteDrafts = useRef(new Map<string, string>());
  const failure = (cause: unknown) => setError(cause instanceof TypeError ? tx('暂时无法连接服务，请重试。', 'Could not connect to the service. Please retry.')
    : cause instanceof Error ? localizeMessage(cause.message) : tx('操作未完成，请重试。', 'The action did not finish. Please retry.'));
  async function request<T>(url: string, web?: WebSession, body?: unknown): Promise<T> {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': web!.csrfToken }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || tx('操作未完成，请重试。', 'The action did not finish. Please retry.'));
    return data as T;
  }
  async function begin(next: Mode) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMode(next); setError(''); setLogin(''); setSaved(undefined);
    try {
      const web = await request<WebSession>('/api/session'); setSession(web);
      if (web.auth === 'email' && (!web.account || web.termsRequired)) {
        setLogin(shareLoginLink({ token, readingId, action: next, language: locale })); return;
      }
      if (next === 'bookmark') {
        const result = await request<{ items: ResearchCollection[] }>('/api/research/collections', web);
        let id = readingId ?? registered.current?.id;
        if (!id && token && result.items.some(collection => collection.items.some(item => item.target.kind === 'share'))) {
          const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
          const tokenDigest = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
          const existing = await request<{ item?: Pick<SharedProofReading, 'id' | 'digest'> }>(`/api/research/shared-proofs?${new URLSearchParams({ tokenDigest })}`, web);
          if (existing.item) { registered.current = existing.item; id = existing.item.id; }
        }
        const collection = result.items.find(item => item.id === selected)
          ?? result.items.find(collection => collection.items.some(item => item.target.kind === 'share' && item.target.shareId === id)) ?? result.items[0];
        const nextId = selected === 'new' ? 'new' : collection?.id ?? 'new';
        setSharedId(id); setCollections(result.items); setSelected(nextId);
        setNote(noteDrafts.current.get(nextId) ?? (nextId === collection?.id ? collection.items.find(item => item.target.kind === 'share' && item.target.shareId === id)?.note : undefined) ?? '');
        setNoteEdited(noteDrafts.current.has(nextId));
      }
    } catch (cause) { failure(cause); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => {
    const action = new URLSearchParams(location.search).get('action');
    if (action === 'bookmark' || action === 'prepare') void begin(action);
  }, []);
  const existingBookmark = collections.find(item => item.id === selected)?.items.find(item => item.target.kind === 'share' && item.target.shareId === sharedId);
  const chooseCollection = (id: string) => {
    setSelected(id); setSaved(undefined); setNoteEdited(noteDrafts.current.has(id));
    setNote(noteDrafts.current.get(id) ?? collections.find(item => item.id === id)?.items.find(item => item.target.kind === 'share' && item.target.shareId === sharedId)?.note ?? '');
  };
  const pending = (ref: { current?: Pending }, value: Record<string, unknown>, scope = '') => {
    const signature = JSON.stringify([scope, value]);
    if (ref.current?.signature !== signature) ref.current = { signature, body: { ...value, requestId: crypto.randomUUID() } };
    return ref.current.body;
  };
  async function reference(web: WebSession) {
    // Reuse the exact reference for a lost-response retry. The write endpoints still check live access;
    // a completed, explicitly copied draft can then be recovered even if the source share was revoked.
    if (registered.current) return registered.current;
    const response = readingId ? await request<{ item: SharedProofReading }>(`/api/research/shared-proofs/${encodeURIComponent(readingId)}`, web)
      : await request<{ item: SharedProofReading }>('/api/research/shared-proofs', web, { token, requestId: registerId.current });
    registered.current = { id: response.item.id, digest: response.item.digest };
    return registered.current;
  }
  async function saveBookmark() {
    if (!session || lock.current || login) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const reading = await reference(session);
      let collection = collections.find(item => item.id === selected);
      if (selected === 'new' || !collections.length) {
        const result = await request<{ item: ResearchCollection }>('/api/research/collections', session, pending(createPending, { title: title.trim() }));
        collection = result.item; setCollections(previous => [...previous.filter(item => item.id !== collection!.id), collection!]); setSelected(collection.id);
        if (noteDrafts.current.has('new')) { noteDrafts.current.set(collection.id, noteDrafts.current.get('new')!); noteDrafts.current.delete('new'); }
      }
      if (!collection) throw new Error(tx('请重新读取资料夹后选择。', 'Reload and choose a collection.'));
      const result = await request<{ item: ResearchCollection }>(`/api/research/collections/${encodeURIComponent(collection.id)}/items`, session,
        pending(savePending, { expectedRevision: collection.revision, target: { kind: 'share', shareId: reading.id }, ...(noteEdited ? { note } : {}) }, collection.id));
      setSharedId(reading.id); setCollections(previous => previous.map(item => item.id === result.item.id ? result.item : item)); setSaved(result.item.id);
      noteDrafts.current.delete(result.item.id);
      setNote(result.item.items.find(item => item.target.kind === 'share' && item.target.shareId === reading.id)?.note ?? ''); setNoteEdited(false);
    } catch (cause) { failure(cause); }
    finally { lock.current = false; setBusy(false); }
  }
  async function prepare() {
    if (!session || !confirmed || lock.current || login) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const reading = await reference(session);
      const { item } = await request<{ item: SharedProofPreparation }>(`/api/research/shared-proofs/${encodeURIComponent(reading.id)}/prepare`, session,
        { requestId: preparationId.current, expectedDigest: reading.digest, confirmed: true });
      location.assign(`./?${new URLSearchParams({ sharedDraft: item.id, lang: locale })}`);
    } catch (cause) { failure(cause); lock.current = false; setBusy(false); }
  }
  return <section class="share-receiver" data-share-receiver aria-labelledby="share-receiver-heading">
    <h2 id="share-receiver-heading">{tx('接着做什么', 'Continue from this proof')}</h2>
    <div class="share-receiver-buttons"><button type="button" class="button" data-share-bookmark disabled={busy} onClick={() => void begin('bookmark')}>{tx('收藏到我的资料夹', 'Save to my collection')}</button>
      <button type="button" class="button" data-share-prepare disabled={busy} onClick={() => void begin('prepare')}>{tx('从原题准备我的研究', 'Prepare my research from the problem')}</button></div>
    {busy && <p role="status">{tx('正在读取…', 'Loading…')}</p>}
    {error && <p class="field-error" role="alert">{error}</p>}
    {mode && login && <p>{tx('登录后会回到这份分享，再由你确认保存或准备草稿。', 'Sign in to return to this proof and confirm saving or preparing a draft.')} <a class="button" data-share-signin href={login}>{tx('登录并继续', 'Sign in and continue')}</a></p>}
    {mode && session && !login && !(session.auth === 'email' && (!session.account || session.termsRequired)) && <>
      {mode === 'bookmark' ? <form class="share-receiver-form" onSubmit={event => { event.preventDefault(); void saveBookmark(); }}>
        <p>{tx('收藏保存的是原分享的链接。分享者停止分享后，资料夹会标记为不可访问，你的私人备注仍保留。', 'A bookmark keeps a link to the original share. If sharing stops, it becomes unavailable; your private note remains.')}</p>
        {!!collections.length && <label>{tx('资料夹', 'Collection')}<select data-share-collection disabled={busy} value={selected} onChange={event => chooseCollection(event.currentTarget.value)}>
          {collections.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}<option value="new">{tx('新建资料夹', 'New collection')}</option></select></label>}
        {(selected === 'new' || !collections.length) && <label>{tx('资料夹名称', 'Collection name')}<input data-share-collection-title value={title} required maxLength={120} onInput={event => setTitle(event.currentTarget.value)} /></label>}
        {existingBookmark && <p data-share-existing-bookmark role="status">{tx('已收藏在这个资料夹中。', 'Already saved in this collection.')}</p>}
        <label>{tx('私人备注（可选）', 'Private note (optional)')}<textarea data-share-bookmark-note disabled={busy} rows={2} maxLength={4000} value={note} onInput={event => { const value = event.currentTarget.value; noteDrafts.current.set(selected, value); setNote(value); setNoteEdited(true); setSaved(undefined); }} /></label>
        <div class="share-receiver-buttons"><button type="submit" class="button button-primary" data-share-save-bookmark disabled={busy || Boolean(saved)}>{saved ? tx('已收藏', 'Saved') : tx('保存收藏', 'Save bookmark')}</button>
          <button type="button" class="text-button" disabled={busy} onClick={() => void begin('bookmark')}>{tx('刷新资料夹', 'Refresh collections')}</button>
          {saved && <a class="text-button" data-share-saved-collection href={`workspace.html?${new URLSearchParams({ tab: 'collections', collection: saved })}`}>{tx('打开我的资料夹', 'Open my collection')}</a>}</div>
      </form> : <div class="share-receiver-form" data-share-preparation-preview>
        <p><Rich text={share.title} /></p><p>{tx('证明环境：', 'Proof environment: ')}{share.environment === 'mathlib' ? 'Mathlib' : tx('Lean 标准库', 'Lean standard library')}</p>
        <details><summary>{tx('查看将复制的原题源码', 'Preview the original source to copy')}</summary><pre><code>{share.source}</code></pre></details>
        <p>{tx('只复制公开的原题、研究任务和环境；模型、预算由你设置。新尝试需要重新检查与验收。', 'Copy the public problem, task and environment. Choose your own model and budget. Your new attempt needs its own checks and acceptance.')}</p>
        <label class="share-receiver-confirm"><input type="checkbox" data-share-confirm-copy checked={confirmed} onChange={event => setConfirmed(event.currentTarget.checked)} />
          <span>{tx('将原题复制为我的私人草稿；原分享停止后，这份副本仍保留。', 'Keep a private copy of the original problem, even if the original share is later revoked.')}</span></label>
        <button type="button" class="button button-primary" data-share-confirm-prepare disabled={busy || !confirmed} onClick={() => void prepare()}>{tx('准备草稿，前往工作台', 'Prepare draft and open workbench')}</button>
      </div>}
    </>}
  </section>;
}
