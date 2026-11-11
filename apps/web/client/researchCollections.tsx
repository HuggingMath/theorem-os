import { useEffect, useRef, useState } from 'preact/hooks';
import type { ResearchBookmark, ResearchBookmarkTarget, ResearchCollection, ResearchCollectionPreparation } from '../researchCollectionTypes';
import { Rich, RichProse } from './richText';
import { OwnedDrafts, researchEnvironmentStorageKey, researchSelectionStorageKey, webDraftOwner } from './ownedDrafts';
import { locale } from '../i18n';
import { base, enc, Empty, ErrorBox, Field, MutationState, Panel, tx, useMutation, useResource, type Item, type Items, type ResearchContext } from './researchShared';

const bookmarkIdentity = (target: ResearchBookmarkTarget) => JSON.stringify(Object.entries(target)
  .filter(([key, value]) => value !== undefined && !(target.kind === 'release' && key === 'digest')).sort(([a], [b]) => a.localeCompare(b)));

export function BookmarkControl(props: { target: ResearchBookmarkTarget; context: ResearchContext }) {
  const target = props.target, login = target.kind === 'release'
    ? `login.html?${new URLSearchParams({ returnTo: 'library', entry: target.assetId, version: target.version, action: 'bookmark', lang: locale })}` : 'login.html';
  return props.context.session.authenticated ? <BookmarkForm key={JSON.stringify(props.target)} {...props} />
    : <a class="text-button" href={login}>{tx('登录后收藏', 'Sign in to save')}</a>;
}
function BookmarkForm({ target }: { target: ResearchBookmarkTarget; context: ResearchContext }) {
  const parameters = new URLSearchParams(location.search), requested = target.kind === 'release' && parameters.get('action') === 'bookmark'
    && parameters.get('entry') === target.assetId && parameters.get('version') === target.version;
  const [open, setOpen] = useState(requested), [collectionId, setCollectionId] = useState(''), [title, setTitle] = useState('');
  const [created, setCreated] = useState<ResearchCollection>(), [saved, setSaved] = useState(false), [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const control = useRef<HTMLDetailsElement>(null), returnFocused = useRef(false);
  const collections = useResource<Items<ResearchCollection>>(open ? `${base}/collections` : undefined);
  const create = useMutation(), save = useMutation(), items = [...(collections.data?.items ?? []).map(item => created?.id === item.id && created.revision > item.revision ? created : item),
    ...(created && !collections.data?.items.some(item => item.id === created.id) ? [created] : [])];
  const selectedId = collectionId || items[0]?.id || 'new', selectedCollection = items.find(item => item.id === selectedId);
  const existingBookmark = selectedCollection?.items.find(item => bookmarkIdentity(item.target) === bookmarkIdentity(target));
  const noteEdited = Object.hasOwn(noteDrafts, selectedId), note = noteEdited ? noteDrafts[selectedId] : existingBookmark?.note ?? '';
  useEffect(() => {
    if (collections.data && !collectionId) setCollectionId(items[0]?.id ?? 'new');
    if (created && collections.data?.items.some(item => item.id === created.id && item.revision >= created.revision)) setCreated(undefined);
  }, [collections.data, collectionId, created]);
  useEffect(() => {
    if (!requested || !open || !collections.data || returnFocused.current || !control.current) return;
    returnFocused.current = true;
    control.current.scrollIntoView({ block: 'center' });
    control.current.querySelector<HTMLElement>('select, input, textarea')?.focus({ preventScroll: true });
  }, [requested, open, collections.data]);
  const submit = async () => {
    let collection = selectedCollection;
    if (selectedId === 'new') {
      const result = await create.run<Item<ResearchCollection>>('POST', `${base}/collections`, { title: title.trim() });
      if (!result) return;
      collection = result.item; setCreated(collection); setCollectionId(collection.id); collections.refresh();
      const id = collection.id;
      setNoteDrafts(current => {
        if (!Object.hasOwn(current, 'new')) return current;
        const { new: draft, ...rest } = current; return { ...rest, [id]: draft };
      });
    }
    if (!collection) return;
    const id = collection.id;
    await save.run<Item<ResearchCollection>>('POST', `${base}/collections/${enc(id)}/items`, { expectedRevision: collection.revision, target, ...(noteEdited ? { note } : {}) }, result => {
      setCreated(result.item);
      setNoteDrafts(current => { const next = { ...current }; delete next[id]; return next; });
      setSaved(true); collections.refresh();
      if (requested) { const address = new URL(location.href); address.searchParams.delete('action'); history.replaceState(null, '', address); }
    });
  };
  return <details ref={control} class="research-bookmark-control" open={open} onToggle={event => setOpen(event.currentTarget.open)} data-bookmark-control>
    <summary>{saved ? tx('已收藏', 'Saved') : tx('收藏到资料夹', 'Save to a collection')}</summary>
    {open && <form class="research-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <ErrorBox message={collections.error} />{collections.error && <button class="text-button" type="button" onClick={collections.refresh}>{tx('重新读取', 'Try again')}</button>}
      {collections.loading && !collections.data ? <p role="status">{tx('正在读取资料夹…', 'Loading collections…')}</p> : collections.data && <fieldset class="research-bookmark-fields" disabled={create.busy || save.busy}>
        {items.length > 0 && <label>{tx('资料夹', 'Collection')}<select value={selectedId} onChange={event => { setCollectionId(event.currentTarget.value); setSaved(false); save.setMessage(''); save.setError(''); }}>
          {items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}<option value="new">{tx('新建资料夹', 'New collection')}</option></select></label>}
        {selectedId === 'new' && <Field label={tx('资料夹名称', 'Collection name')} value={title} onInput={setTitle} required maxLength={120} />}
        <Field label={tx('私人备注（可选）', 'Private note (optional)')} value={note} onInput={value => { setNoteDrafts(current => ({ ...current, [selectedId]: value })); setSaved(false); }} multiline rows={2} maxLength={4000} />
        <MutationState action={create} /><MutationState action={save} />
        {save.error && <button class="text-button" type="button" onClick={collections.refresh}>{tx('重新读取资料夹后重试', 'Reload collections and try again')}</button>}
        {saved && <p class="research-status" role="status">{tx('已保存到你的资料夹。', 'Saved to your collection.')}</p>}
        <div class="research-actions"><button class="button" type="submit" disabled={create.busy || save.busy}>{tx('保存收藏', 'Save bookmark')}</button>
          <a class="text-button" href="workspace.html?tab=collections">{tx('管理资料夹', 'Manage collections')}</a></div>
      </fieldset>}
    </form>}
  </details>;
}

export function CollectionsPanel({ context }: { context: ResearchContext }) {
  const data = useResource<Items<ResearchCollection>>(context.session.authenticated ? `${base}/collections` : undefined, 15_000);
  const [selected, setSelected] = useState(new URLSearchParams(location.search).get('collection') ?? ''), [title, setTitle] = useState('');
  const [created, setCreated] = useState<ResearchCollection>(), [deleted, setDeleted] = useState('');
  const items = [...(data.data?.items ?? []), ...(created && !data.data?.items.some(item => item.id === created.id) ? [created] : [])];
  const create = useMutation(), collection = deleted ? undefined : selected ? items.find(item => item.id === selected) : items[0];
  const choose = (id: string, replace = false) => {
    const address = new URL(location.href); address.searchParams.set('collection', id);
    if (address.href !== location.href) history[replace ? 'replaceState' : 'pushState'](null, '', address);
    setSelected(id); setDeleted('');
  };
  useEffect(() => {
    const back = () => { setSelected(new URLSearchParams(location.search).get('collection') ?? ''); setDeleted(''); };
    window.addEventListener('popstate', back); return () => window.removeEventListener('popstate', back);
  }, []);
  useEffect(() => { if (!selected && collection) choose(collection.id, true); }, [selected, collection?.id]);
  useEffect(() => { if (created && data.data?.items.some(item => item.id === created.id)) setCreated(undefined); }, [created, data.data]);
  if (!context.session.authenticated) return <Panel title={tx('专题资料夹', 'Research collections')}><a href="login.html">{tx('登录后整理收藏与私人备注', 'Sign in to organize bookmarks and private notes')}</a></Panel>;
  return <Panel id="research-collections" title={tx('专题资料夹', 'Research collections')} note={tx('将题目、精确任务版本和成果放在一起。备注仅自己可见。', 'Keep problems, exact task versions and releases together. Notes stay private.')}>
    <ErrorBox message={data.error} />{data.error && <button class="text-button" type="button" onClick={data.refresh}>{tx('重新读取', 'Try again')}</button>}
    <form class="research-form" onSubmit={event => { event.preventDefault(); const submitted = title; void create.run<Item<ResearchCollection>>('POST', `${base}/collections`, { title: title.trim() }, result => {
      setCreated(result.item); choose(result.item.id); data.refresh(); setTitle(current => current === submitted ? '' : current);
    }); }}><div class="research-form-row"><Field label={tx('新资料夹名称', 'New collection name')} value={title} onInput={setTitle} required maxLength={120} />
      <button class="button" type="submit" disabled={create.busy}>{tx('新建资料夹', 'New collection')}</button></div><MutationState action={create} /></form>
    {deleted && <p class="research-status" role="status" data-collection-deleted>{tx('已删除资料夹：', 'Collection deleted: ')}{deleted}</p>}
    {data.data && selected && !collection && !deleted && <p role="status" data-collection-unavailable>{tx('这份资料夹已删除或不属于当前账号。请从下面选择其他资料夹，或新建资料夹。', 'This collection was deleted or does not belong to this account. Choose another collection below or create one.')}</p>}
    {data.data && !items.length && !selected && <Empty>{tx('在题目、任务或 Library 成果旁选择「收藏到资料夹」即可整理材料。', 'Choose “Save to a collection” beside a problem, task or Library release to start collecting material.')}</Empty>}
    {items.length > 0 && <label>{tx('打开资料夹', 'Open collection')}<select value={collection?.id ?? ''} onChange={event => choose(event.currentTarget.value)}>
      {!collection && <option value="" disabled>{tx('选择另一份资料夹', 'Choose another collection')}</option>}
      {items.map(item => <option key={item.id} value={item.id}>{item.title} ({item.items.length})</option>)}</select></label>}
    {collection && <CollectionDetail key={collection.id} collection={collection} context={context} refresh={data.refresh}
      onDeleted={() => { setDeleted(collection.title); setCreated(undefined); data.refresh(); }} />}
  </Panel>;
}

function CollectionDetail({ collection, context, refresh, onDeleted }: { collection: ResearchCollection; context: ResearchContext; refresh(): void; onDeleted(): void }) {
  const [selected, setSelected] = useState<string[]>([]), [name, setName] = useState(collection.title), [description, setDescription] = useState(collection.description);
  const [deletion, setDeletion] = useState<{ revision: number; title: string; count: number; notes: number }>();
  const previous = useRef({ name: collection.title, description: collection.description });
  const action = useMutation(), prepare = useMutation();
  useEffect(() => {
    const old = previous.current;
    setName(current => current === old.name ? collection.title : current);
    setDescription(current => current === old.description ? collection.description : current);
    previous.current = { name: collection.title, description: collection.description };
    setSelected(current => current.filter(id => collection.items.some(item => item.id === id && item.available && item.assetType === 'mathematics')));
  }, [collection.title, collection.description, collection.revision, collection.items]);
  const open = () => void prepare.run<Item<ResearchCollectionPreparation>>('POST', `${base}/collections/${enc(collection.id)}/prepare`, {
    expectedRevision: collection.revision, itemIds: selected,
  }, result => {
    try {
      const drafts = new OwnedDrafts(() => sessionStorage); drafts.bind(webDraftOwner(context.web));
      drafts.setItem(researchSelectionStorageKey, JSON.stringify(result.item.refs)); drafts.setItem(researchEnvironmentStorageKey, result.item.configuration.environment);
      const first = result.item.refs[0]; location.assign(`./?researchAsset=${enc(first.assetId)}&researchVersion=${enc(first.version)}`);
    } catch { prepare.setError(tx('浏览器未能保存配置选择，请从成果版本页逐项带入工作台。', 'The browser could not save the selection. Open each release in the workbench individually.')); }
  });
  return <section data-collection-id={collection.id}>
    <h3><Rich text={collection.title} /></h3>{collection.description && <RichProse text={collection.description} />}
    <details><summary>{tx('编辑资料夹', 'Edit collection')}</summary><form class="research-form" onSubmit={event => { event.preventDefault(); void action.run('PATCH', `${base}/collections/${enc(collection.id)}`,
      { expectedRevision: collection.revision, title: name, description }, refresh); }}>
      <Field label={tx('资料夹名称', 'Collection name')} value={name} onInput={setName} required maxLength={120} /><Field label={tx('说明', 'Description')} value={description} onInput={setDescription} multiline maxLength={2000} />
      <MutationState action={action} /><div class="research-actions"><button class="button" disabled={action.busy}>{tx('保存资料夹', 'Save collection')}</button>
        <button class="text-button" type="button" disabled={action.busy} aria-expanded={Boolean(deletion)} onClick={() => setDeletion({ revision: collection.revision, title: collection.title,
          count: collection.items.length, notes: collection.items.filter(item => item.note.trim()).length })}>{tx('删除资料夹', 'Delete collection')}</button></div>
      {deletion && <section class="research-event" data-collection-delete-confirm aria-label={tx('确认删除资料夹', 'Confirm collection deletion')}>
        <p><strong>{tx('将删除资料夹：', 'Delete collection: ')}{deletion.title}</strong></p>
        <p>{tx('收藏数量：', 'Bookmarks: ')}{deletion.count} · {tx('含私人备注：', 'With private notes: ')}{deletion.notes}</p>
        <p>{tx('其中的收藏与私人备注会一并删除，无法撤销。原成果和研究记录不受影响。', 'Its bookmarks and private notes will be deleted and cannot be undone. Original assets and research records stay unchanged.')}</p>
        {deletion.revision !== collection.revision && <p role="status">{tx('资料夹有更新，请取消后重新核对。', 'The collection changed. Cancel and review it again.')}</p>}
        <div class="research-actions"><button class="button" type="button" disabled={action.busy} onClick={() => setDeletion(undefined)}>{tx('取消', 'Cancel')}</button>
          <button class="text-button" type="button" disabled={action.busy || deletion.revision !== collection.revision} onClick={() => void action.run('DELETE', `${base}/collections/${enc(collection.id)}`, { expectedRevision: deletion.revision }, onDeleted)}>{tx('确认删除资料夹与备注', 'Delete collection and notes')}</button></div>
      </section>}
    </form></details>
    {!collection.items.length && <Empty>{tx('这个资料夹还没有收藏。', 'This collection has no bookmarks yet.')}</Empty>}
    {collection.items.map(item => <BookmarkItem key={item.id} item={item} collection={collection} refresh={refresh} selected={selected.includes(item.id)} select={checked => setSelected(previous => checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} />)}
    {collection.items.some(item => item.available && item.assetType === 'mathematics') && <div class="research-actions"><button class="button" type="button" disabled={!selected.length || prepare.busy} onClick={open}>
      {prepare.busy ? tx('正在检查固定版本…', 'Checking fixed versions…') : tx('用选中的数学成果准备研究', 'Prepare research with selected mathematics')}</button></div>}
    <MutationState action={prepare} />
    {(action.error || prepare.error) && <button class="text-button" type="button" onClick={refresh}>{tx('读取最新内容后重试', 'Refresh and try again')}</button>}
  </section>;
}
function BookmarkItem({ item, collection, refresh, selected, select }: { item: ResearchBookmark; collection: ResearchCollection; refresh(): void; selected: boolean; select(checked: boolean): void }) {
  const [note, setNote] = useState(item.note), [savedNote, setSavedNote] = useState(item.note), action = useMutation();
  const previousNote = useRef(item.note);
  useEffect(() => {
    const old = previousNote.current;
    setNote(current => current === old ? item.note : current);
    setSavedNote(item.note); previousNote.current = item.note;
  }, [item.note]);
  const target = item.target;
  return <article class="research-event" data-bookmark-id={item.id}>
    <div class="research-actions">{item.available && item.assetType === 'mathematics' && <label class="research-bookmark-choice"><input type="checkbox" checked={selected} aria-label={tx('选择此数学成果', 'Select this mathematics release')} onChange={event => select(event.currentTarget.checked)} /></label>}
      {item.available ? <a href={item.href}><Rich text={item.title ?? ''} /></a> : <strong>{tx('原内容已不可访问', 'Original content is unavailable')}</strong>}
      <span class="research-item-meta">{target.kind === 'release' ? target.version : target.kind === 'task' ? `${target.taskVersion.slice(0, 12)} · ${target.commit.slice(0, 12)}`
        : target.kind === 'theorem' ? target.statementVersionId?.slice(0, 12) : target.kind === 'share' ? tx('分享的证明', 'Shared proof') : tx('研究记录', 'Research run')}</span></div>
    {savedNote && <RichProse text={savedNote} />}
    <details><summary>{tx('编辑私人备注与收藏', 'Edit private note and bookmark')}</summary><form class="research-form" onSubmit={event => { event.preventDefault(); const submitted = note;
      void action.run('PATCH', `${base}/collections/${enc(collection.id)}/items/${enc(item.id)}`, { expectedRevision: collection.revision, note }, () => { setSavedNote(submitted); refresh(); }); }}>
      <Field label={tx('私人备注', 'Private note')} value={note} onInput={setNote} multiline rows={2} maxLength={4000} /><MutationState action={action} />
      {action.error && <button class="text-button" type="button" onClick={refresh}>{tx('读取最新内容后重试', 'Refresh and try again')}</button>}
      <div class="research-actions"><button class="button" disabled={action.busy}>{tx('保存备注', 'Save note')}</button><button class="text-button" type="button" disabled={action.busy}
        onClick={() => void action.run('DELETE', `${base}/collections/${enc(collection.id)}/items/${enc(item.id)}`, { expectedRevision: collection.revision }, refresh)}>{tx('移除收藏', 'Remove bookmark')}</button></div>
    </form></details>
  </article>;
}
