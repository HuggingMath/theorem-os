import { useEffect, useRef, useState } from 'preact/hooks';
import type { ResearchBookmark, ResearchBookmarkTarget, ResearchCollection, ResearchCollectionPreparation } from '../researchCollectionTypes';
import { Rich, RichProse } from './richText';
import { OwnedDrafts, researchEnvironmentStorageKey, researchSelectionStorageKey, webDraftOwner } from './ownedDrafts';
import { base, enc, Empty, ErrorBox, Field, MutationState, Panel, tx, useMutation, useResource, type Item, type Items, type ResearchContext } from './researchShared';

export function BookmarkControl(props: { target: ResearchBookmarkTarget; context: ResearchContext }) {
  return props.context.session.authenticated ? <BookmarkForm key={JSON.stringify(props.target)} {...props} />
    : <a class="text-button" href="login.html">{tx('登录后收藏', 'Sign in to save')}</a>;
}
function BookmarkForm({ target }: { target: ResearchBookmarkTarget; context: ResearchContext }) {
  const [open, setOpen] = useState(false), [collectionId, setCollectionId] = useState(''), [title, setTitle] = useState(''), [note, setNote] = useState('');
  const [created, setCreated] = useState<ResearchCollection>(), [saved, setSaved] = useState(false), [noteEdited, setNoteEdited] = useState(false);
  const collections = useResource<Items<ResearchCollection>>(open ? `${base}/collections` : undefined);
  const create = useMutation(), save = useMutation(), items = [...(collections.data?.items ?? []), ...(created && !collections.data?.items.some(item => item.id === created.id) ? [created] : [])];
  const submit = async () => {
    let collection = items.find(item => item.id === (collectionId || items[0]?.id));
    if (collectionId === 'new' || !items.length) {
      const result = await create.run<Item<ResearchCollection>>('POST', `${base}/collections`, { title: title.trim() });
      if (!result) return;
      collection = result.item; setCreated(collection); setCollectionId(collection.id); collections.refresh();
    }
    if (!collection) return;
    await save.run<Item<ResearchCollection>>('POST', `${base}/collections/${enc(collection.id)}/items`, { expectedRevision: collection.revision, target, ...(noteEdited ? { note } : {}) }, () => {
      setSaved(true); collections.refresh();
    });
  };
  return <details class="research-bookmark-control" onToggle={event => setOpen(event.currentTarget.open)} data-bookmark-control>
    <summary>{saved ? tx('已收藏', 'Saved') : tx('收藏到资料夹', 'Save to a collection')}</summary>
    {open && <form class="research-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <ErrorBox message={collections.error} />{collections.error && <button class="text-button" type="button" onClick={collections.refresh}>{tx('重新读取', 'Try again')}</button>}
      {collections.loading && !collections.data ? <p role="status">{tx('正在读取资料夹…', 'Loading collections…')}</p> : collections.data && <>
        {items.length > 0 && <label>{tx('资料夹', 'Collection')}<select value={collectionId || items[0]?.id} onChange={event => { setCollectionId(event.currentTarget.value); setSaved(false); }}>
          {items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}<option value="new">{tx('新建资料夹', 'New collection')}</option></select></label>}
        {(collectionId === 'new' || !items.length) && <Field label={tx('资料夹名称', 'Collection name')} value={title} onInput={setTitle} required maxLength={120} />}
        <Field label={tx('私人备注（可选）', 'Private note (optional)')} value={note} onInput={value => { setNote(value); setNoteEdited(true); setSaved(false); }} multiline rows={2} maxLength={4000} />
        <MutationState action={create} /><MutationState action={save} />
        {save.error && <button class="text-button" type="button" onClick={collections.refresh}>{tx('重新读取资料夹后重试', 'Reload collections and try again')}</button>}
        {saved && <p class="research-status" role="status">{tx('已保存到你的资料夹。', 'Saved to your collection.')}</p>}
        <div class="research-actions"><button class="button" type="submit" disabled={create.busy || save.busy}>{tx('保存收藏', 'Save bookmark')}</button>
          <a class="text-button" href="workspace.html?tab=collections">{tx('管理资料夹', 'Manage collections')}</a></div>
      </>}
    </form>}
  </details>;
}

export function CollectionsPanel({ context }: { context: ResearchContext }) {
  const data = useResource<Items<ResearchCollection>>(context.session.authenticated ? `${base}/collections` : undefined, 15_000);
  const [selected, setSelected] = useState(new URLSearchParams(location.search).get('collection') ?? ''), [title, setTitle] = useState('');
  const create = useMutation(), collection = data.data?.items.find(item => item.id === selected) ?? data.data?.items[0];
  if (!context.session.authenticated) return <Panel title={tx('专题资料夹', 'Research collections')}><a href="login.html">{tx('登录后整理收藏与私人备注', 'Sign in to organize bookmarks and private notes')}</a></Panel>;
  return <Panel id="research-collections" title={tx('专题资料夹', 'Research collections')} note={tx('将题目、精确任务版本和成果放在一起。备注仅自己可见。', 'Keep problems, exact task versions and releases together. Notes stay private.')}>
    <ErrorBox message={data.error} />{data.error && <button class="text-button" type="button" onClick={data.refresh}>{tx('重新读取', 'Try again')}</button>}
    <form class="research-form" onSubmit={event => { event.preventDefault(); const submitted = title; void create.run<Item<ResearchCollection>>('POST', `${base}/collections`, { title: title.trim() }, result => {
      setSelected(result.item.id); data.refresh(); setTitle(current => current === submitted ? '' : current);
    }); }}><div class="research-form-row"><Field label={tx('新资料夹名称', 'New collection name')} value={title} onInput={setTitle} required maxLength={120} />
      <button class="button" type="submit" disabled={create.busy}>{tx('新建资料夹', 'New collection')}</button></div><MutationState action={create} /></form>
    {data.data && !data.data.items.length && <Empty>{tx('在题目、任务或 Library 成果旁选择「收藏到资料夹」即可整理材料。', 'Choose “Save to a collection” beside a problem, task or Library release to start collecting material.')}</Empty>}
    {collection && <><label>{tx('打开资料夹', 'Open collection')}<select value={collection.id} onChange={event => setSelected(event.currentTarget.value)}>
      {data.data?.items.map(item => <option key={item.id} value={item.id}>{item.title} ({item.items.length})</option>)}</select></label>
      <CollectionDetail key={collection.id} collection={collection} context={context} refresh={data.refresh} />
    </>}
  </Panel>;
}

function CollectionDetail({ collection, context, refresh }: { collection: ResearchCollection; context: ResearchContext; refresh(): void }) {
  const [selected, setSelected] = useState<string[]>([]), [name, setName] = useState(collection.title), [description, setDescription] = useState(collection.description);
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
        <button class="text-button" type="button" disabled={action.busy} onClick={() => void action.run('DELETE', `${base}/collections/${enc(collection.id)}`, { expectedRevision: collection.revision }, refresh)}>{tx('删除资料夹', 'Delete collection')}</button></div>
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
