import { useEffect, useRef, useState } from 'preact/hooks';
import type { FrozenResearchConfiguration, ResearchAsset, ResearchAssetPrefill, ResearchAssetPreview, ResearchAssetRelease, ResearchAssetKind, ResearchConfigurationSelection, ResearchLibraryUse, ResearchPublication, ResearchReleaseRef } from '../researchAssetTypes';
import type { ResearcherProfile } from '../researchProjectTypes';
import type { ResearchLibraryDiscovery } from '../researchLibraryDiscoveryTypes';
import type { ResearchLibraryProvenance } from '../researchAssetTypes';
import { AssetEditor, FixedMathSource } from './researchAssetEditor';
import { BookmarkControl } from './researchCollections';
import { AssetFollowControl, ReleaseComparison } from './researchReleaseComparison';
import { LibraryTrial } from './researchLibraryTrial';
import { MathUsageDescription } from './researchMathUsage';
import { InstalledLibraryDirectory, InstalledLibraryModule } from './researchInstalledLibrary';
import { LibraryDiscoveryContext } from './researchLibraryDiscovery';
import { discoverySuggestedTerms, matchLibraryDiscovery } from './researchLibraryDiscoveryModel';
import { rememberLibraryEntry } from './libraryEntry';
import { researchLibraryHref } from './researchLibraryNavigation';
import { RichProse } from './richText';
import { OwnedDrafts, researchEnvironmentStorageKey, researchSelectionStorageKey, webDraftOwner } from './ownedDrafts';
import { loginHref, type WebEnvironment } from '../shared';
import { locale } from '../i18n';
import { api, base, enc, Empty, ErrorBox, errorText, Field, MutationState, nameOf, Panel, personHref, Search, stamp, State, Tags, theoremHref, tx,
  useMutation, useResource, type Item, type Items, type ResearchContext } from './researchShared';

const selectionDrafts = new OwnedDrafts(() => sessionStorage);
const libraryFilterDrafts = new OwnedDrafts(() => sessionStorage);
function rememberedSelection(): ResearchReleaseRef[] {
  try {
    const value: unknown = JSON.parse(selectionDrafts.getItem(researchSelectionStorageKey) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is ResearchReleaseRef => Boolean(item && typeof item === 'object' && typeof item.assetId === 'string' && typeof item.version === 'string')) : [];
  } catch { return []; }
}
function saveSelection(value: ResearchReleaseRef[], environment?: WebEnvironment) {
  try {
    selectionDrafts.setItem(researchSelectionStorageKey, JSON.stringify(value.map(({ assetId, version }) => ({ assetId, version }))));
    if (environment) selectionDrafts.setItem(researchEnvironmentStorageKey, environment);
    else selectionDrafts.removeItem(researchEnvironmentStorageKey);
    return true;
  }
  catch { return false; }
}

type MathematicsCollection = 'lean' | 'shared';
type LibraryView = { type: ResearchAssetKind; collection: MathematicsCollection; mine: boolean;
  query: string; area: string; author: string; environment: string; offset: number };
const viewKey = (view: Pick<LibraryView, 'type' | 'collection' | 'mine'>) => view.type === 'mathematics' && view.collection === 'lean'
  ? 'mathematics:lean' : `${view.type}:shared:${view.mine ? 'mine' : 'browse'}`;
function rememberedLibraryView(key: string, owner: string): LibraryView | undefined {
  try {
    const value: unknown = JSON.parse(libraryFilterDrafts.getItem(`theoremos.research.library.filters.${key}`) ?? 'null');
    if (!value || typeof value !== 'object') return;
    const saved = value as { owner?: unknown; view?: LibraryView };
    if (saved.owner !== owner || !saved.view) return;
    const view = saved.view;
    if (!['mathematics', 'agent', 'skill'].includes(view.type) || !['lean', 'shared'].includes(view.collection)
      || typeof view.mine !== 'boolean' || !['query', 'area', 'author', 'environment'].every(field => typeof view[field as keyof LibraryView] === 'string')
      || !Number.isSafeInteger(view.offset) || view.offset < 0) return;
    return view;
  } catch { return; }
}
function rememberLibraryView(view: LibraryView, owner: string) {
  try {
    const value = JSON.stringify({ owner, view });
    libraryFilterDrafts.setItem(`theoremos.research.library.filters.${viewKey(view)}`, value);
    libraryFilterDrafts.setItem(`theoremos.research.library.filters.type:${view.type}`, value);
  } catch { /* Current filters and URL navigation still work when storage is unavailable. */ }
}
const libraryFilterKeys = ['q', 'type', 'collection', 'area', 'author', 'environment', 'mine', 'offset', 'workbenchChat', 'workbenchRun', 'workbenchEdit', 'lang', 'run', 'project', 'task', 'taskVersion', 'commit'] as const;
function filteredLibraryHref(id?: string, version?: string, filters = new URLSearchParams(location.search)) {
  if (id) return researchLibraryHref({ assetId: id, ...(version ? { version } : {}) }, filters, true);
  const parameters = new URLSearchParams();
  for (const key of libraryFilterKeys) {
    const value = filters.get(key);
    if (value) parameters.set(key, value);
  }
  if (version) parameters.set('version', version);
  return `library.html${parameters.size ? `?${parameters}` : ''}`;
}
function kindDescription(kind: ResearchAssetKind) {
  return kind === 'mathematics' ? tx('浏览可复用的 Lean 模块、数学接口与共享库。', 'Browse reusable Lean modules, mathematical interfaces and shared libraries.')
    : kind === 'agent' ? tx('选择一套研究配置，安排协作与研究规则。', 'Choose a research setup with coordination and research rules.')
    : tx('为研究补充特定情境下的步骤和要求。', 'Add steps and instructions for a particular research situation.');
}

export function LibraryPage({ context }: { context: ResearchContext }) {
  const filterOwner = webDraftOwner(context.web);
  selectionDrafts.bind(filterOwner);
  libraryFilterDrafts.bind(filterOwner);
  const parameters = new URLSearchParams(location.search), selected = parameters.get('entry') ?? '', fromRun = parameters.get('fromRun'),
    installedFile = parameters.get('source') === 'installed' ? parameters.get('module') ?? '' : '', catalogDigest = parameters.get('catalogDigest') ?? '';
  const initialOffset = Number(parameters.get('offset') ?? 0), initialCollection = parameters.get('collection');
  const hasTarget = ['run', 'task', 'taskVersion', 'commit'].every(key => parameters.has(key));
  const targetParameters = new URLSearchParams();
  for (const name of ['run', 'project', 'task', 'taskVersion', 'commit']) if (parameters.has(name)) targetParameters.set(name, parameters.get(name)!);
  const discovery = useResource<Item<ResearchLibraryDiscovery>>(hasTarget && context.session.authenticated ? `${base}/library-discovery?${targetParameters}` : undefined);
  const target = discovery.data?.item;
  const legacyOpenAI = initialCollection === 'openai' && !selected && !parameters.get('module');
  useEffect(() => {
    if (!legacyOpenAI) return;
    const next = new URL('theorems.html', location.href); next.searchParams.set('collection', 'solved');
    if (parameters.get('q')) next.searchParams.set('q', parameters.get('q')!);
    if (parameters.get('area')) next.searchParams.set('field', parameters.get('area')!);
    location.replace(next.href);
  }, [legacyOpenAI]);
  const initialType = parameters.get('type'), hasDirectoryType = useRef(parameters.has('type'));
  const [query, setQuery] = useState(parameters.get('q') ?? ''), [type, setType] = useState<ResearchAssetKind>(initialType === 'agent' || initialType === 'skill' ? initialType : 'mathematics'),
    [area, setArea] = useState(parameters.get('area') ?? ''), [author, setAuthor] = useState(parameters.get('author') ?? ''), [environment, setEnvironment] = useState(parameters.get('environment') === 'all' ? '' : parameters.get('environment') ?? (hasTarget ? 'target' : '')), [mine, setMine] = useState(parameters.get('mine') === '1'),
    [creating, setCreating] = useState(context.session.authenticated && (parameters.get('create') === '1' || fromRun !== null)), [selection, setSelection] = useState<ResearchReleaseRef[]>(rememberedSelection), [storageError, setStorageError] = useState('');
  const [creatorMounted, setCreatorMounted] = useState(creating), [searchReset, setSearchReset] = useState(0), [offset, setOffset] = useState(Number.isSafeInteger(initialOffset) && initialOffset > 0 ? initialOffset : 0),
    [collection, setCollection] = useState<MathematicsCollection>(installedFile ? 'lean' : selected || initialCollection === 'shared' || hasTarget && !initialCollection ? 'shared' : 'lean');
  const showingAssets = Boolean(selected) || type !== 'mathematics' || collection === 'shared', ownView = mine && showingAssets;
  const actualEnvironment = environment === 'target' ? target?.environment ?? '' : environment;
  const directory = useResource<Items<ResearchAsset>>(!legacyOpenAI && showingAssets ? `${base}/library?q=${enc(hasTarget && type === 'mathematics' ? '' : query)}&type=${enc(type)}&area=${enc(area)}&author=${enc(author)}${type === 'mathematics' && actualEnvironment ? `&environment=${enc(actualEnvironment)}` : ''}${mine ? '&mine=1' : ''}` : undefined);
  const detail = useResource<Item<ResearchAsset>>(selected ? `${base}/library/${enc(selected)}` : undefined);
  useEffect(() => { if (!hasDirectoryType.current && detail.data) setType(detail.data.item.type); }, [detail.data?.item.id]);
  const filters = new URLSearchParams({ type });
  for (const key of ['workbenchChat', 'workbenchRun', 'workbenchEdit', 'lang', 'run', 'project', 'task', 'taskVersion', 'commit']) if (parameters.has(key)) filters.set(key, parameters.get(key)!);
  if (type === 'mathematics') filters.set('collection', collection);
  if (query) filters.set('q', query);
  if (area) filters.set('area', area);
  if (author) filters.set('author', author);
  if (environment) filters.set('environment', environment);
  else if (hasTarget) filters.set('environment', 'all');
  if (mine) filters.set('mine', '1');
  if (offset) filters.set('offset', String(offset));
  const filterQuery = filters.toString();
  const currentView: LibraryView = { type, collection, mine, query, area, author, environment, offset };
  useEffect(() => {
    if (legacyOpenAI) return;
    const next = new URL(location.href), currentFilters = new URLSearchParams(filterQuery);
    for (const key of libraryFilterKeys) {
      const value = currentFilters.get(key);
      if (value) next.searchParams.set(key, value); else next.searchParams.delete(key);
    }
    history.replaceState(null, '', next);
    rememberLibraryView(currentView, filterOwner);
  }, [filterQuery, legacyOpenAI]);
  const candidates = directory.data?.items.filter(item => type !== 'mathematics' || !actualEnvironment || item.release?.mathematics?.environment === actualEnvironment) ?? [];
  const terms = query.trim() ? query.trim().split(/\s+/u).slice(0, 10) : target ? discoverySuggestedTerms(target) : [];
  const matches = target && type === 'mathematics' ? candidates.map(asset => matchLibraryDiscovery(asset, target, terms))
    .filter(match => !query.trim() || match.terms.length).sort((a, b) => b.score - a.score || b.asset.updatedAt.localeCompare(a.asset.updatedAt)) : undefined;
  const items = matches?.map(match => match.asset) ?? candidates;
  const search = (value: string) => { setQuery(value); setOffset(0); setSearchReset(current => current + 1); };
  const viewFor = (nextType: ResearchAssetKind, nextCollection: MathematicsCollection, nextMine: boolean) => {
    const target = { type: nextType, collection: nextCollection, mine: nextMine };
    if (viewKey(target) === viewKey(currentView)) return currentView;
    return rememberedLibraryView(viewKey(target), filterOwner) ?? { ...target, query: '', area: '', author: '', environment: '', offset: 0 };
  };
  const applyView = (view: LibraryView) => {
    if (viewKey(view) === viewKey(currentView)) return;
    rememberLibraryView(currentView, filterOwner);
    setType(view.type); setCollection(view.collection); setMine(view.mine); setQuery(view.query); setArea(view.area);
    setAuthor(view.author); setEnvironment(view.environment); setOffset(view.offset); setCreating(false); setSearchReset(value => value + 1);
  };
  const changeCollection = (value: MathematicsCollection, owned = false) => applyView(viewFor(type, value, owned));
  const typeView = (value: ResearchAssetKind) => value === type ? currentView
    : rememberedLibraryView(`type:${value}`, filterOwner) ?? viewFor(value, value === 'mathematics' ? 'lean' : 'shared', false);
  const viewHref = (view: LibraryView) => {
    const next = new URLSearchParams({ type: view.type });
    if (view.type === 'mathematics') next.set('collection', view.collection);
    if (view.mine) next.set('mine', '1');
    for (const key of ['area', 'author', 'environment'] as const) if (view[key]) next.set(key, view[key]);
    if (view.query) next.set('q', view.query);
    if (view.offset) next.set('offset', String(view.offset));
    for (const key of ['workbenchChat', 'workbenchRun', 'workbenchEdit', 'lang', 'run', 'project', 'task', 'taskVersion', 'commit']) if (filters.has(key)) next.set(key, filters.get(key)!);
    return filteredLibraryHref(undefined, undefined, next);
  };
  const scopeHref = (value: 'lean' | 'shared' | 'mine') => {
    return viewHref(viewFor(type, value === 'lean' ? 'lean' : 'shared', value === 'mine'));
  };
  const choose = (ref: ResearchReleaseRef) => {
    const next = selection.some(item => item.assetId === ref.assetId && item.version === ref.version) ? selection.filter(item => item.assetId !== ref.assetId || item.version !== ref.version) : [...selection.filter(item => item.assetId !== ref.assetId), ref];
    setSelection(next); setStorageError(saveSelection(next) ? '' : tx('浏览器未能保存配置选择，请逐项带入工作台。', 'The browser could not save the selection. Open each asset in the workbench individually.'));
  };
  const clear = () => { setSelection([]); saveSelection([]); };
  const createAddress = new URL(location.href); createAddress.searchParams.set('create', '1'); createAddress.hash = 'new-asset';
  if (legacyOpenAI) return <p class="research-status" role="status">{tx('正在打开定理页的已解决题目…', 'Opening solved problems on the theorems page…')}</p>;
  return <div class={`research-library-page${installedFile ? ' research-library-module-page' : ''}`}><div class="research-heading research-library-heading"><div><h1>{tx('数学库', 'Library')}</h1>
    <p>{tx('查找可复用的模块、接口和研究工具。', 'Find reusable modules, interfaces and research tools.')}</p></div>
    <div class="research-heading-actions">{context.session.authenticated ? <button class="button button-primary" type="button" onClick={() => { setCreatorMounted(true); setCreating(value => !value); }} aria-expanded={creating}>{creating ? tx('收起创建表单', 'Close creator') : tx('创建成果 / 工具', 'Create an asset')}</button>
      : <a class="button" href={loginHref(createAddress.pathname + createAddress.search + createAddress.hash)}>{tx('登录后创建成果', 'Sign in to create an asset')}</a>}</div></div>
    {target && <LibraryDiscoveryContext target={target} query={query} chooseQuery={search} />}
    {hasTarget && !context.session.authenticated && <Panel title={tx('为所选步骤找引理', 'Find a lemma for the selected step')}><p>{tx('登录后读取这个步骤的目标和前提，继续寻找可用成果。', 'Sign in to read this step’s goal and premises and continue finding useful results.')}</p>
      <a class="button" data-library-discovery-login href={loginHref(location.pathname + location.search + location.hash)}>{tx('登录并回到这一步', 'Sign in and return to this step')}</a></Panel>}
    {hasTarget && context.session.authenticated && !target && <Panel title={tx('正在定位研究步骤', 'Locating the research step')}><ErrorBox message={discovery.error} />
      {discovery.loading && <p role="status">{tx('正在读取目标、前提与证明环境…', 'Loading the goal, premises and proof environment…')}</p>}
      {discovery.error && <div class="research-actions"><button class="button" type="button" onClick={discovery.refresh}>{tx('重新读取这一步', 'Reload this step')}</button>
        <a class="button" href={`problem.html?${new URLSearchParams({ ...Object.fromEntries(targetParameters), tab: 'route' })}`}>{tx('回到题目核对', 'Return to the problem')}</a></div>}</Panel>}
    {context.session.authenticated && <div class="research-actions"><a class="text-button" href="workspace.html?tab=collections">{tx('我的资料夹', 'My collections')}</a><a class="text-button" href="workspace.html?tab=inbox#asset-updates">{tx('关注更新', 'Release updates')}</a></div>}
    <div class="research-library-controls">
      <nav class="research-section-nav research-directory-grid research-library-type-tabs" aria-label={tx('内容类型', 'Content type')}>{(['mathematics', 'agent', 'skill'] as const).map(value => {
        const label = value === 'mathematics' ? tx('数学库', 'Math libraries') : nameOf(value);
        return selected || installedFile ? <a key={value} href={viewHref(typeView(value))} aria-current={type === value ? 'page' : undefined}>{label}</a>
          : <button key={value} type="button" aria-pressed={type === value} onClick={() => applyView(typeView(value))}>{label}</button>;
      })}</nav>
      <nav class="research-section-nav research-library-collections" aria-label={type === 'mathematics' ? tx('数学内容来源', 'Mathematics collections') : tx('Library 入口', 'Library sections')}>
        {type === 'mathematics' ? <>{(['lean', 'shared'] as const).map(value => selected || installedFile
          ? <a key={value} data-library-collection={value} href={scopeHref(value)} aria-current={collection === value && !mine ? 'page' : undefined}>{value === 'lean' ? tx('Lean 库', 'Lean library') : tx('共享数学库', 'Shared libraries')}</a>
          : <button key={value} type="button" data-library-collection={value} aria-pressed={collection === value && (value === 'lean' || !mine)} onClick={() => changeCollection(value)}>{value === 'lean' ? tx('Lean 库', 'Lean library') : tx('共享数学库', 'Shared libraries')}</button>)}</>
          : selected ? <a href={scopeHref('shared')}>{tx('浏览资源', 'Browse resources')}</a>
          : <button type="button" aria-pressed={!mine} onClick={() => changeCollection('shared')}>{tx('浏览资源', 'Browse resources')}</button>}
        {selected || installedFile ? <a href={scopeHref('mine')} aria-current={ownView ? 'page' : undefined}>{tx('我的资源', 'My resources')}</a>
          : <button type="button" aria-pressed={ownView} onClick={() => changeCollection('shared', true)}>{tx('我的资源', 'My resources')}</button>}
        {!creating && selection.length > 0 && <a href="#research-library-selection">{tx('配置选择', 'Selection')} ({selection.length})</a>}
      </nav>
    </div>
    {creatorMounted && <div hidden={!creating} class="research-page-section"><Panel id="new-asset" title={tx('创建草稿', 'Create a draft')} note={tx('先保存到个人空间；确认内容、许可证与可见范围后再发布。', 'Save it in your space, then review the content, license and visibility before publishing.')}>
      {fromRun !== null ? <RunAssetCreator context={context} runId={fromRun} parameters={parameters} onSaved={(asset, newerInput) => { directory.refresh(); if (!newerInput) location.assign(filteredLibraryHref(asset.id)); }} /> : <AssetEditor context={context} onSaved={(asset, newerInput) => {
        directory.refresh();
        if (!newerInput) {
          const savedFilters = new URLSearchParams(filters); savedFilters.set('type', asset.type); savedFilters.set('mine', '1');
          location.assign(filteredLibraryHref(asset.id, undefined, savedFilters));
        }
      }} />}</Panel></div>}
    <div hidden={creating}>{installedFile ? <InstalledLibraryModule key={`${installedFile}:${catalogDigest}`} file={installedFile} catalogDigest={catalogDigest} filters={filters} /> : selected ? <div class="research-content">
      <nav class="research-breadcrumb" aria-label={tx('返回目录', 'Back to directory')}><a href={filteredLibraryHref(undefined, undefined, filters)}>← {tx('返回目录', 'Back to directory')}</a><span>{nameOf(type)}{mine ? ` · ${tx('我的资源', 'My resources')}` : ''}</span></nav>
      <ErrorBox message={detail.error} />{detail.data ? <Asset key={selected} asset={detail.data.item} context={context} refresh={detail.refresh} selection={selection} choose={choose} />
        : <Panel title={detail.loading ? tx('正在读取资源…', 'Loading resource…') : tx('资源暂不可查看', 'Resource unavailable')}><Empty>{detail.loading ? tx('正在读取内容与版本。', 'Loading contents and versions.') : tx('可返回目录选择其他资源，或重试读取。', 'Return to the directory to choose another resource, or reload this one.')}</Empty>
          {!detail.loading && <button class="button" type="button" onClick={detail.refresh}>{tx('重新读取资源', 'Reload resource')}</button>}</Panel>}
    </div> : <div class="research-library-browser">
      {showingAssets && <div class="research-library-section-title"><h2>{type === 'mathematics' ? mine ? tx('我的数学库', 'My libraries') : tx('共享数学库', 'Shared libraries') : `${nameOf(type)}${tx('目录', ' directory')}`}</h2>
        <p>{kindDescription(type)}</p></div>}
      <div class="research-library-searchbar"><Search key={`${type === 'mathematics' ? collection : type}:${searchReset}`} initial={query} label={target && showingAssets ? tx('筛选任一关键词；空格分隔', 'Match any keyword; separate with spaces') : tx('关键词或 Lean 名称', 'Keyword or Lean name')} onSearch={value => { setQuery(value); setOffset(0); }} />
        {type !== 'mathematics' && <Field label={tx('研究领域', 'Research field')} value={area} onInput={value => { setArea(value); setOffset(0); }} placeholder={tx('输入领域', 'Enter a field')} />}
        <details class="research-library-filters" open={Boolean(author || environment)}><summary>{tx('更多筛选', 'More filters')}</summary><div class="research-form research-form-row">
          {type === 'mathematics' && <Field label={tx('研究领域', 'Research field')} value={area} onInput={value => { setArea(value); setOffset(0); }} placeholder={tx('输入领域', 'Enter a field')} />}
          {showingAssets && <Field label={tx('按作者 ID 筛选', 'Filter by author ID')} value={author} onInput={setAuthor} />}
          {type === 'mathematics' && <label>{tx('按证明环境筛选', 'Filter by proof environment')}<select data-library-environment value={environment} onChange={event => { setEnvironment(event.currentTarget.value); setOffset(0); }}>{hasTarget && <option value="target">{tx('与当前步骤相同的环境', 'Same environment as this step')}</option>}<option value="">{tx('全部环境', 'All environments')}</option><option value="mathlib">mathlib</option><option value="standard">Lean standard</option></select></label>}
        </div></details>
      </div>
      {type === 'mathematics' && collection === 'lean' ? <InstalledLibraryDirectory query={query} area={area} environment={actualEnvironment} offset={offset} onOffset={setOffset} onArea={value => { setArea(value); setOffset(0); }} onReset={() => {
        setQuery(''); setArea(''); setAuthor(''); setEnvironment(''); setOffset(0); setSearchReset(value => value + 1);
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.research-library-searchbar input[type="search"]')?.focus());
      }} onQuery={value => {
        setQuery(value); setArea(''); setAuthor(''); setEnvironment(''); setOffset(0); setSearchReset(previous => previous + 1);
      }} filters={filters} />
        : <><ErrorBox message={directory.error} />{directory.error && <button class="button" type="button" onClick={directory.refresh}>{tx('重新读取共享成果', 'Reload shared resources')}</button>}
          {directory.loading && <p class="research-status" role="status">{tx('正在读取目录…', 'Loading directory…')}</p>}
          {directory.data && <p class="research-status" role="status">{items.length} {tx('项资源', 'resources')}{mine ? ` · ${tx('包含自己的草稿与发布版本', 'Includes your drafts and releases')}` : ''}</p>}
          <div class="research-directory-grid">{items.map(asset => <DirectoryAsset key={asset.id} asset={asset} mine={mine} recommended={asset.type === 'mathematics' && Boolean(actualEnvironment)} href={filteredLibraryHref(asset.id, asset.release?.version, filters)} match={matches?.find(item => item.asset.id === asset.id)} />)}</div>
          {directory.data && !items.length && <Empty>{mine ? tx('还没有匹配的个人资源。可以创建草稿，或调整筛选。', 'No matching resources of your own. Create a draft or change the filters.')
            : tx('暂无匹配的共享成果，请调整关键词或领域。', 'No matching shared resources. Try another keyword or field.')}</Empty>}
          {target && query.trim() && <button class="text-button" type="button" onClick={() => search('')}>{tx('清空检索词，查看环境内全部成果', 'Clear keywords and show all results in this environment')}</button>}
        </>}
      {showingAssets && <p class="research-field-note">{tx('加入配置选择后可检查依赖与环境，再带入工作台。新研究启动前会固定完整版本和依赖。', 'Add fixed versions to your selection, check their dependencies and environment, then open the workbench. Versions and dependencies are frozen before research starts.')}</p>}
    </div>}

    <ErrorBox message={storageError} />{selection.length > 0 && <Selection selection={selection} remove={choose} clear={clear} assets={directory.data?.items ?? []} authenticated={context.session.authenticated} />}</div>
  </div>;
}

function DirectoryAsset({ asset, mine, href, recommended, match }: { asset: ResearchAsset; mine: boolean; href: string; recommended: boolean; match?: ReturnType<typeof matchLibraryDiscovery> }) {
  const personalDraft = mine && asset.editable, shown = personalDraft ? asset : asset.release ?? asset, release = asset.release,
    content = personalDraft ? asset.draft ?? release?.content : release?.content ?? asset.draft;
  const details = !personalDraft && release?.mathematics ? [release.mathematics.environment, `${release.mathematics.declarations.length} ${tx('条数学声明', 'declarations')}`]
    : content && 'modulePlan' in content ? [content.environment ?? tx('工作台默认环境', 'Workbench environment'), `${content.modulePlan.custom.length} ${tx('条研究规则', 'research rules')}`]
    : content && 'instructions' in content ? [...content.slots, `${content.steps.length} ${tx('个步骤', 'steps')}`]
    : content && 'source' in content ? [content.source.kind === 'run' ? tx('研究运行来源', 'Research-run source') : tx('知识目录来源', 'Knowledge-catalog source')] : [];
  return <article class="research-directory-card">{personalDraft && <span class="research-eyebrow">{tx('个人草稿', 'Personal draft')}</span>}<a class="research-card-heading" href={href}>{shown.name}</a>
    <div class="research-card-description"><RichProse text={shown.description || tx('作者尚未补充用途说明。', 'The author has not added a description.')} /></div>
    <div class="research-item-meta"><span>{shown.area || tx('未标注领域', 'No field specified')}</span>{!personalDraft && <span data-library-recommended-release={recommended ? release?.version : undefined}>{release ? `${recommended ? tx('推荐 ', 'Recommended ') : ''}${release.version}` : tx('尚无可选版本', 'No selectable release')}</span>}<State value={shown.visibility} /></div>
    {details.length > 0 && <Tags values={details} />}
    {match && <div class="research-library-match" data-library-match={asset.id}>
      <span>{match.sameEnvironment ? tx('证明环境相同', 'Same proof environment') : tx('证明环境不同', 'Different proof environment')}</span>
      {match.terms.length ? <span>{tx('文字匹配：', 'Matching terms: ')}{match.terms.join(' · ')}</span> : <span>{tx('未找到目标词重合', 'No shared goal terms')}</span>}
      {!!match.declarations.length && <span>{tx('相关声明：', 'Matching declarations: ')}{match.declarations.slice(0, 3).join(' · ')}</span>}
    </div>}
    <p class="research-status">{release ? personalDraft ? <>{tx('已发布版本：', 'Published version: ')}<a href={href}>{release.name} · {release.version}</a></>
      : tx('已发布固定版本，可查看内容与依赖。', 'A fixed version is published. View its contents and dependencies.')
      : asset.releases.length ? tx('已有版本均已撤回，当前无可选版本。', 'Previous versions are withdrawn. No version is currently selectable.')
      : tx('尚未发布，草稿不能用于新研究。', 'Unpublished. Drafts cannot be used in new research.')}</p>
  </article>;
}

function RunAssetCreator({ context, runId, parameters, onSaved }: { context: ResearchContext; runId: string; parameters: URLSearchParams; onSaved: (asset: ResearchAsset, newerInput: boolean) => void }) {
  const [url] = useState(() => {
    const query = new URLSearchParams({ run: runId });
    for (const name of ['task', 'taskVersion', 'commit']) if (parameters.has(name)) query.set(name, parameters.get(name)!);
    return `${base}/library/from-run?${query}`;
  });
  const result = useResource<Item<ResearchAssetPrefill>>(url);
  return <div data-library-run-creator>
    {result.loading && !result.data && <p class="research-status" role="status">{tx('正在读取这份证明的来源与检查记录…', 'Loading this proof’s source and check records…')}</p>}
    <ErrorBox message={result.error} />{result.error && <div class="research-actions"><button type="button" class="button" onClick={result.refresh}>{tx('重新读取成果来源', 'Retry loading source')}</button>
      <a class="text-button" href={`./?run=${enc(runId)}`}>{tx('返回研究结果', 'Return to research result')}</a></div>}
    {result.data && <AssetEditor key={url} context={context} prefill={result.data.item} onSaved={onSaved} />}
  </div>;
}

function Asset({ asset, context, refresh, selection, choose }: { asset: ResearchAsset; context: ResearchContext; refresh: () => void; selection: ResearchReleaseRef[]; choose: (ref: ResearchReleaseRef) => void }) {
  const author = useResource<Item<ResearcherProfile>>(`${base}/people/${enc(asset.authorId)}`);
  const [version, setVersion] = useState(new URLSearchParams(location.search).get('version') ?? asset.release?.version ?? (asset.editable ? asset.releases.at(-1)?.version : '') ?? ''), [editing, setEditing] = useState(false),
    [editorKey, setEditorKey] = useState(0), [publicationId, setPublicationId] = useState(() => {
      try { return sessionStorage.getItem(`theoremos.research.publication.${asset.id}`) ?? ''; } catch { return ''; }
    });
  const [editorMounted, setEditorMounted] = useState(false);
  const [loadedDraft, setLoadedDraft] = useState<ResearchAsset>(), [loadingDraft, setLoadingDraft] = useState(false), [draftError, setDraftError] = useState('');
  const draftLock = useRef(false), editorAsset = loadedDraft && loadedDraft.revision > asset.revision ? loadedDraft : asset;
  const loadDraft = async () => {
    if (draftLock.current) return;
    draftLock.current = true; setLoadingDraft(true); setDraftError('');
    try {
      const { item } = await api<Item<ResearchAsset>>(`${base}/library/${enc(asset.id)}`);
      setLoadedDraft(item); setEditorKey(value => value + 1); refresh();
    } catch (cause) { setDraftError(errorText(cause)); }
    finally { draftLock.current = false; setLoadingDraft(false); }
  };
  const releaseResult = useResource<Item<ResearchAssetRelease>>(version ? `${base}/library/${enc(asset.id)}/releases/${enc(version)}` : undefined);
  const unavailable = [401, 403, 404].includes(releaseResult.errorStatus ?? 0);
  const release = unavailable ? undefined : releaseResult.data?.item ?? (asset.release?.version === version ? asset.release : undefined);
  const [forkVersions, setForkVersions] = useState<string[]>([]);
  useEffect(() => {
    if (release) setForkVersions(previous => previous.includes(release.version) ? previous : [...previous, release.version]);
  }, [release?.version]);
  const forPublication = (publication: ResearchPublication) => {
    setPublicationId(publication.id);
    try { sessionStorage.setItem(`theoremos.research.publication.${asset.id}`, publication.id); } catch { /* The publication remains visible in this page. */ }
  };
  const published = (publication: ResearchPublication) => { refresh(); if (publication.release) setVersion(publication.release.version); };
  const useVersion = (selectedVersion = release?.version) => {
    if (!selectedVersion) return;
    const ref = { assetId: asset.id, version: selectedVersion }, next = [...selection.filter(item => item.assetId !== asset.id), ref];
    const parameters = new URLSearchParams({ researchAsset: ref.assetId, researchVersion: ref.version, lang: locale });
    try {
      if (!context.session.authenticated) parameters.set('libraryReturn', rememberLibraryEntry(next));
      else if (!saveSelection(next)) throw new Error('selection_storage_unavailable');
      location.assign(`./?${parameters}`);
    } catch { setDraftError(tx('未能保存成果选择，请登录后在这个版本页重试。', 'Could not save the selection. Sign in and try again from this release.')); }
  };
  const shown = release ?? asset.release ?? asset, shownTime = release?.createdAt ?? asset.release?.createdAt ?? asset.updatedAt;
  const withdrawn = Boolean(asset.releases.find(item => item.version === version)?.withdrawn);
  return <><Panel title={shown.name}>
    <div class="research-item-meta"><span>{nameOf(asset.type)}</span><a href={personHref(asset.authorId)}>{author.data?.item.displayName ?? asset.authorId}</a><State value={shown.visibility} /><span>{shown.area}</span><time dateTime={shownTime}>{stamp(shownTime)}</time></div>
    <div class="research-description"><RichProse text={shown.description || tx('暂无用途说明。', 'No description yet.')} /></div>
    <details><summary>{tx('来源与资产身份', 'Source and asset identity')}</summary><dl class="research-facts"><div><dt>{tx('资产 ID', 'Asset ID')}</dt><dd>{asset.id}</dd></div>{asset.derivedFrom && <div><dt>{tx('派生来源', 'Derived from')}</dt><dd><a href={filteredLibraryHref(asset.derivedFrom.assetId, asset.derivedFrom.version)}>{asset.derivedFrom.assetId}@{asset.derivedFrom.version}</a></dd></div>}</dl></details>
  </Panel>
    <Panel title={tx('已发布版本', 'Published versions')}>
      {asset.releases.length > 0 ? <label class="research-field">{tx('查看固定版本', 'View a fixed version')}<select value={version} onChange={event => {
        setVersion(event.currentTarget.value); const next = new URL(location.href); next.searchParams.set('version', event.currentTarget.value); history.replaceState(null, '', next);
      }}>{asset.releases.filter(item => !item.withdrawn || asset.editable).map(item => <option key={item.version} value={item.version}>{item.version} · {item.license} · {stamp(item.createdAt)}{item.withdrawn ? ` · ${tx('已撤回', 'Withdrawn')}` : ''}</option>)}</select></label>
      : <Empty>{tx('尚无已发布版本。', 'No published versions yet.')}</Empty>}
      <ErrorBox message={releaseResult.error} />{releaseResult.error && <button class="text-button" type="button" onClick={releaseResult.refresh}>{tx('重新读取版本', 'Reload release')}</button>}
      <ErrorBox message={draftError} />{release && <><div class="research-item-meta"><span>{release.license}</span><State value={release.visibility} /><time dateTime={release.createdAt}>{stamp(release.createdAt)}</time></div>
        {withdrawn && <p class="research-status">{tx('此版本已撤回，不能加入新的研究配置。', 'This version is withdrawn and cannot be added to a new research configuration.')}</p>}
        <div class="research-actions"><button class="button button-primary" type="button" disabled={withdrawn} onClick={() => useVersion()}>{tx('用于新研究', 'Use in new research')}</button>
          <button class="button" type="button" disabled={withdrawn} aria-pressed={selection.some(ref => ref.assetId === asset.id && ref.version === release.version)} onClick={() => choose({ assetId: asset.id, version: release.version })}>
            {selection.some(ref => ref.assetId === asset.id && ref.version === release.version) ? tx('已加入配置选择', 'In configuration selection') : tx('加入配置选择', 'Add to configuration')}</button>
          <a class="button" href={`${base}/library/${enc(asset.id)}/releases/${enc(release.version)}?download=1`} download>{tx('下载版本', 'Download release')}</a></div>
        <p class="research-field-note">{tx('带入工作台只准备研究配置，由你确认后启动。', 'Opening the workbench prepares a configuration. You choose when to start research.')}</p>
        <ReleaseContent release={release} /><details><summary>{tx('查看固定版本身份', 'View fixed release identity')}</summary><dl class="research-facts"><div><dt>{tx('版本', 'Version')}</dt><dd>{release.version}</dd></div><div><dt>{tx('内容摘要', 'Content digest')}</dt><dd>{release.digest}</dd></div></dl></details>
        <div class="research-actions"><BookmarkControl key={`${asset.id}:${release.version}`} context={context} target={{ kind: 'release', assetId: asset.id, version: release.version, digest: release.digest }} />
          <AssetFollowControl context={context} assetId={asset.id} version={release.version} /></div>
        {release.releaseNotes && <><h3>{tx('作者更新说明', 'Author’s release notes')}</h3><RichProse text={release.releaseNotes} /></>}
        <LibraryTrial key={`trial:${asset.id}:${release.digest}`} release={release} context={context} />
        <ReleaseComparison key={`${asset.id}:${release.version}`} asset={asset} selectedVersion={release.version} useVersion={useVersion} />
        {asset.editable && <Withdraw asset={asset} version={release.version} refresh={() => { refresh(); releaseResult.refresh(); }} />}
      </>}
      {forkVersions.map(forkVersion => <div key={forkVersion} hidden={release?.version !== forkVersion || withdrawn}>
        <Fork asset={asset} version={forkVersion} />
      </div>)}
    </Panel>
    {asset.editable && <Panel title={tx('个人草稿', 'Personal draft')} note={tx('草稿用于继续编辑；上方固定版本保留发布时的内容。', 'Continue editing the draft here. Fixed versions above retain their published contents.')} actions={<button type="button" class="button" onClick={() => { setEditorMounted(true); setEditing(value => !value); }} aria-expanded={editing}>{editing ? tx('收起编辑器', 'Close editor') : tx('编辑草稿', 'Edit draft')}</button>}>
      <p class="research-item-title">{asset.name}</p><div class="research-description"><RichProse text={asset.description || tx('暂无用途说明。', 'No description yet.')} /></div>
      <div class="research-item-meta"><State value={asset.visibility} /><span>{asset.area}</span><time dateTime={asset.updatedAt}>{stamp(asset.updatedAt)}</time></div>
      {!asset.release && <p class="research-status">{tx('发布检查完成后，才能作为固定版本使用。', 'Publish and complete validation before using this as a fixed version.')}</p>}
    </Panel>}
    {editorMounted && <div hidden={!editing}><Panel title={tx('编辑草稿', 'Edit draft')} actions={<button class="text-button" type="button" disabled={loadingDraft} onClick={() => void loadDraft()}>{tx('载入最新草稿', 'Load latest draft')}</button>}>
      <ErrorBox message={draftError} /><AssetEditor key={editorKey} asset={editorAsset} context={context} disabled={loadingDraft}
        onSaved={item => { setLoadedDraft(item); refresh(); }} /></Panel></div>}
    {asset.editable && <Panel title={tx('发布固定版本', 'Publish a fixed version')} note={tx('发布前请审阅草稿；只有你选择公开的版本会进入共享目录。', 'Review the draft before publishing. Only versions you make public appear in the shared directory.')}>
      <Publish asset={asset} onPublication={forPublication} />{publicationId && <Publication key={publicationId} id={publicationId} completed={published} />}
    </Panel>}
  </>;
}

function ReleaseContent({ release }: { release: ResearchAssetRelease }) {
  const provenance = useResource<Item<ResearchLibraryProvenance>>(release.mathematics?.source.kind === 'run'
    ? `${base}/library/${enc(release.assetId)}/releases/${enc(release.version)}/source` : undefined);
  if (release.type === 'mathematics' && release.mathematics) {
    const math = release.mathematics;
    return <><MathUsageDescription usage={math.usage} />{math.source.kind === 'run' && <FixedMathSource source={math.source} provenance={provenance.data?.item} />}
      <ErrorBox message={provenance.error} />{provenance.error && <button class="text-button" type="button" onClick={provenance.refresh}>{tx('重新核对来源访问权限', 'Recheck source access')}</button>}
      <h3>{tx('数学声明', 'Mathematical declarations')}</h3>{math.declarations.map(declaration => <article class="research-event" key={`${declaration.file}:${declaration.name}`}>
      <span class="research-item-title">{declaration.name}</span><pre class="research-block-code">{declaration.type}</pre><span class="research-item-meta">{declaration.file}</span></article>)}
      <dl class="research-facts"><div><dt>{tx('环境', 'Environment')}</dt><dd>{math.environment}</dd></div><div><dt>{tx('环境摘要', 'Environment digest')}</dt><dd>{math.environmentDigest}</dd></div><div><dt>{tx('库摘要', 'Pack digest')}</dt><dd>{math.packDigest}</dd></div></dl>
      {Boolean(math.sourceReceiptRefs?.length) && <><h3>{tx('来源检查回执', 'Source check receipts')}</h3><Tags values={math.sourceReceiptRefs!} /></>}
      <h3>{tx('检查证据', 'Check evidence')}</h3><div class="research-actions">{math.receiptRefs.map(ref => <a class="research-inline-link" key={ref} href={`${base}/library/${enc(release.assetId)}/releases/${enc(release.version)}/checks/${enc(ref)}`} target="_blank" rel="noopener noreferrer">{ref}</a>)}</div><details><summary>{tx('查看完整源码与来源', 'View complete source and provenance')}</summary>
        {math.pack.modules.map(module => <div key={module.file}><h3>{module.file}</h3><pre class="research-block-code">{module.source}</pre><pre class="research-block-code">{JSON.stringify(module.origin, null, 2)}</pre></div>)}</details>
      <p class="research-field-note">{tx('此版本已通过发布检查。在新题目中使用时会重新检查；完整原题仍需独立验收。', 'This version passed publication checks. Reuse checks it again; the complete new problem still requires independent acceptance.')}</p><ActualUses release={release} /></>;
  }
  if ('instructions' in release.content) {
    const skill = release.content;
    return <><h3>{tx('适用情境与要求', 'When to use and instructions')}</h3><div class="research-description"><RichProse text={skill.instructions} /></div>
      <h3>{tx('执行步骤', 'Steps')}</h3>{skill.steps.length ? <ol>{skill.steps.map((step, index) => <li key={index}><RichProse text={step} /></li>)}</ol> : <Empty>{tx('未单列执行步骤。', 'No separate steps listed.')}</Empty>}
      <div class="research-split"><div><h3>{tx('输入', 'Inputs')}</h3><Tags values={skill.inputs} /></div><div><h3>{tx('产物', 'Outputs')}</h3><Tags values={skill.outputs} /></div></div>
      <h3>{tx('适用组件与角色', 'Components and roles')}</h3><Tags values={[...skill.slots, ...skill.roles, skill.mode]} /><Dependencies refs={release.dependencies} />
      {skill.examples.length > 0 && <><h3>{tx('示例', 'Examples')}</h3>{skill.examples.map((example, index) => <div class="research-description" key={index}><RichProse text={example} /></div>)}</>}
    </>;
  }
  if ('modulePlan' in release.content) {
    const agent = release.content;
    return <><h3>{tx('研究配置', 'Research configuration')}</h3><dl class="research-facts"><div><dt>{tx('环境', 'Environment')}</dt><dd>{agent.environment ?? tx('沿用工作台', 'Workbench default')}</dd></div>
      <div><dt>{tx('模型要求', 'Model requirements')}</dt><dd>{[agent.providerId, agent.model, agent.effort].filter(Boolean).join(' · ') || tx('沿用工作台设置', 'Workbench settings')}</dd></div>
      <div><dt>{tx('Agent 数量', 'Workers')}</dt><dd>{agent.workers ?? tx('沿用工作台', 'Workbench default')}</dd></div><div><dt>{tx('调度 / 上下文', 'Scheduling / context')}</dt><dd>{agent.modulePlan.scheduler} / {agent.modulePlan.context}</dd></div></dl>
      {agent.modulePlan.custom.map(module => <article key={module.id} class="research-event"><span class="research-item-title">{module.name}</span><div class="research-item-meta"><span>{module.slot} · {module.mode}</span><span>{module.enabled ? tx('已启用', 'Enabled') : tx('已停用', 'Disabled')}</span></div><div class="research-description"><RichProse text={module.instructions} /></div></article>)}
      <Dependencies refs={[...agent.skills, ...agent.libraries]} /></>;
  }
  return <Empty>{tx('此版本尚无可展示的检查产物。', 'No check artifacts to display for this version.')}</Empty>;
}

function ActualUses({ release }: { release: ResearchAssetRelease }) {
  const [open, setOpen] = useState(false);
  const uses = useResource<Items<ResearchLibraryUse>>(
    open ? `${base}/library/${enc(release.assetId)}/releases/${enc(release.version)}/uses` : undefined);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{tx('查看已检查的实际引用', 'View checked uses')}</summary><ErrorBox message={uses.error} />
    {uses.data?.items.map((use, index) => {
      const original = use.scope === 'original-proof', identity = original ? use.commit : use.taskVersion;
      const href = use.projectId ? `${theoremHref(use.projectId, use.runId)}${original ? '' : `&task=${enc(use.taskId)}`}` : `./?run=${enc(use.runId)}`;
      return <article class="research-event" key={`${use.runId}:${identity}:${index}`}><a href={href}>
        {use.theorem ?? (!original ? use.taskId : '')} · {identity.slice(0, 12)}</a>
        <p class="research-status">{original ? tx('原题已通过独立验收', 'Original problem independently verified') : <>{tx('该任务的证明状态：', 'Task proof status: ')}<State value={use.proofStatus} /></>}</p>
        {use.references?.length > 0 && <Tags values={use.references.map(reference => reference.name)} />}<Tags values={use.checkRefs} /></article>;
    })}
    {uses.data && !uses.data.items.length && <Empty>{tx('当前可见范围内尚无通过检查的实际引用记录。', 'No checked uses within your visible research yet.')}</Empty>}
  </details>;
}

function Dependencies({ refs }: { refs: ResearchReleaseRef[] }) {
  return <><h3>{tx('固定依赖', 'Fixed dependencies')}</h3>{refs.length ? <ul class="research-list">{refs.map(ref => <li key={`${ref.assetId}@${ref.version}`}><a class="research-list-item" href={filteredLibraryHref(ref.assetId, ref.version)}>
    <span class="research-item-title">{ref.assetId}@{ref.version}</span>{ref.digest && <span class="research-item-meta">{ref.digest}</span>}</a></li>)}</ul> : <p class="research-status">{tx('无额外发布依赖。', 'No additional release dependencies.')}</p>}</>;
}

function Publish({ asset, onPublication }: { asset: ResearchAsset; onPublication: (publication: ResearchPublication) => void }) {
  const [version, setVersion] = useState(`v${asset.releases.length + 1}`), [license, setLicense] = useState(''), [releaseNotes, setReleaseNotes] = useState(''), [visibility, setVisibility] = useState('private'), [reviewed, setReviewed] = useState(''), action = useMutation();
  const [preview, setPreview] = useState<ResearchAssetPreview>(), [previewBusy, setPreviewBusy] = useState(false), [previewError, setPreviewError] = useState('');
  const previewLock = useRef(false);
  const ready = Boolean(preview?.previewDigest && preview.revision === asset.revision && !previewBusy && !previewError);
  const reviewIdentity = JSON.stringify([preview?.previewDigest, asset.revision, version, license, visibility, releaseNotes]), confirmed = ready && reviewed === reviewIdentity;
  const loadPreview = async () => {
    if (previewLock.current) return;
    previewLock.current = true; setPreviewBusy(true); setPreviewError(''); setReviewed(''); setPreview(undefined);
    try {
      const { item } = await api<Item<ResearchAssetPreview>>(`${base}/library/${enc(asset.id)}/preview?revision=${asset.revision}`);
      setPreview(item);
    } catch (cause) { setPreviewError(errorText(cause)); }
    finally { previewLock.current = false; setPreviewBusy(false); }
  };
  return <form class="research-form" onSubmit={event => { event.preventDefault(); if (!confirmed || !preview) return; setReviewed(''); void action.run<Item<ResearchPublication>>('POST', `${base}/library/${enc(asset.id)}/publish`,
    { expectedRevision: asset.revision, previewDigest: preview.previewDigest, version, license: license.trim(), visibility, releaseNotes }, result => onPublication(result.item)); }}>
    <button type="button" class="button" disabled={previewBusy || action.busy} onClick={() => void loadPreview()}>{tx('预览将公开的内容', 'Preview release contents')}</button>
    <ErrorBox message={previewError} />{previewBusy && <p class="research-status" role="status">{tx('正在准备完整内容与依赖…', 'Preparing contents and dependencies…')}</p>}
    {preview && <DraftPreview preview={preview} />}
    <div class="research-form-row"><Field label={tx('版本号', 'Version')} value={version} onInput={setVersion} required placeholder="v1" />
      <Field label={tx('许可证', 'License')} value={license} onInput={setLicense} required placeholder="MIT / Apache-2.0 / CC-BY-4.0" /></div>
    <Field label={tx('此版本的更新说明（可选）', 'Release notes (optional)')} value={releaseNotes} onInput={setReleaseNotes} multiline rows={3} maxLength={4000} />
    <label>{tx('发布范围', 'Release visibility')}<select value={visibility} onChange={event => setVisibility(event.currentTarget.value)}><option value="private">{tx('仅自己使用', 'Private')}</option><option value="public">{tx('公开分享', 'Public')}</option></select></label>
    <CheckReview checked={confirmed} disabled={!ready || action.busy} change={checked => setReviewed(checked ? reviewIdentity : '')} /><MutationState action={action} />
    {action.canRetry && <button class="button" type="button" onClick={() => void action.retry<Item<ResearchPublication>>(result => onPublication(result.item))}>{tx('恢复上次已审阅的发布', 'Recover the previously reviewed publication')}</button>}
    <button class="button" type="submit" disabled={action.busy || !confirmed}>{action.busy ? tx('正在提交…', 'Submitting…') : tx('发布并检查', 'Publish and validate')}</button>
  </form>;
}
function DraftPreview({ preview }: { preview: ResearchAssetPreview }) {
  return <section class="research-draft-preview" aria-label={tx('发布内容预览', 'Release preview')}><h3>{preview.name}</h3>
    {preview.mathematics ? <><p class="research-status">{tx('证明环境：', 'Environment: ')}{preview.mathematics.environment}</p>
      <MathUsageDescription usage={preview.mathematicsUsage} />
      {Boolean(preview.mathematicsUsage?.examples.length) && <section data-math-examples-preview><h3>{tx('调用示例 · 发布时检查', 'Invocation examples · checked on publication')}</h3>{preview.mathematicsUsage!.examples.map(example => <details key={example.id} open>
        <summary>{example.title}</summary><p><code>{example.declaration}</code></p><pre class="research-block-code">{example.type}</pre>
        {example.argumentNotes && <RichProse text={example.argumentNotes} />}<pre class="research-block-code">{example.proof}</pre>
      </details>)}</section>}
      {preview.mathematics.declarations.map(declaration => <div key={`${declaration.file}:${declaration.name}`}><h3>{declaration.name}</h3><pre class="research-block-code">{declaration.type}</pre></div>)}
      {preview.mathematics.pack.modules.map(module => <details key={module.file} open><summary>{module.file}</summary><pre class="research-block-code">{module.source}</pre></details>)}
      {Boolean(preview.mathematics.sourceReceiptRefs?.length) && <><h3>{tx('来源检查回执', 'Source check receipts')}</h3><Tags values={preview.mathematics.sourceReceiptRefs!} /></>}
      <p class="research-field-note">{tx('以上包含打包的依赖源码；发布时会进行独立检查。', 'This preview includes packaged dependencies. Publishing runs independent checks.')}</p></>
      : <pre class="research-block-code">{JSON.stringify(preview.content, null, 2)}</pre>}
  </section>;
}
function CheckReview({ checked, disabled, change }: { checked: boolean; disabled: boolean; change: (value: boolean) => void }) {
  return <label class="research-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => change(event.currentTarget.checked)} />{tx('我已审阅保存的草稿及发布范围', 'I reviewed the saved draft and release visibility')}</label>;
}
function Publication({ id, completed }: { id: string; completed: (publication: ResearchPublication) => void }) {
  const [polling, setPolling] = useState(true), called = useRef(false), onCompleted = useRef(completed); onCompleted.current = completed;
  const result = useResource<Item<ResearchPublication>>(`${base}/publications/${enc(id)}`, polling ? 1800 : 0);
  useEffect(() => {
    const item = result.data?.item;
    if (!item || !['completed', 'failed'].includes(item.status)) return;
    setPolling(false);
    if (item.status === 'completed' && !called.current) { called.current = true; onCompleted.current(item); }
  }, [result.data?.item.status]);
  return <div class="research-publication" role="status"><ErrorBox message={result.error} />{result.data && <><p>{tx('发布状态：', 'Publication: ')}<State value={result.data.item.status} /></p>
    {result.data.item.reason && <ErrorBox message={result.data.item.reason} />}{result.data.item.release && <a href={filteredLibraryHref(result.data.item.release.assetId, result.data.item.release.version)}>{tx('查看发布版本', 'View release')}</a>}</>}</div>;
}

function Fork({ asset, version }: { asset: ResearchAsset; version: string }) {
  const [name, setName] = useState(''), action = useMutation();
  return <details><summary>{tx('复制到个人空间并修改', 'Fork into my space')}</summary><form class="research-form" onSubmit={event => { event.preventDefault(); void action.run<Item<ResearchAsset>>('POST', `${base}/library/${enc(asset.id)}/fork`,
    { version, ...(name.trim() ? { name: name.trim() } : {}) }, result => location.assign(filteredLibraryHref(result.item.id))); }}>
    <Field label={tx('新名称（可选）', 'New name (optional)')} value={name} onInput={setName} maxLength={160} /><MutationState action={action} /><button class="button" type="submit" disabled={action.busy}>{tx('创建私有派生草稿', 'Create private fork')}</button>
  </form></details>;
}
function Withdraw({ asset, version, refresh }: { asset: ResearchAsset; version: string; refresh: () => void }) {
  const action = useMutation();
  return <details><summary>{tx('撤回此版本', 'Withdraw this version')}</summary><p class="research-field-note">{tx('撤回后停止新的公开发现和下载；已经固定到其他研究的副本仍保留。', 'Withdrawal stops new public discovery and downloads. Copies already frozen into research remain available there.')}</p>
    <MutationState action={action} /><button type="button" class="button button-danger" disabled={action.busy || asset.releases.find(item => item.version === version)?.withdrawn}
      onClick={() => void action.run('POST', `${base}/library/${enc(asset.id)}/releases/${enc(version)}/withdraw`, { expectedRevision: asset.revision }, refresh)}>{tx('撤回版本', 'Withdraw release')}</button></details>;
}

function Selection({ selection, remove, clear, assets, authenticated }: { selection: ResearchReleaseRef[]; remove: (ref: ResearchReleaseRef) => void; clear: () => void; assets: ResearchAsset[]; authenticated: boolean }) {
  const [environment, setEnvironment] = useState<WebEnvironment>('mathlib'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [validated, setValidated] = useState<FrozenResearchConfiguration>();
  const signature = JSON.stringify([selection, environment]), currentSignature = useRef(signature);
  currentSignature.current = signature;
  useEffect(() => { setValidated(undefined); setError(''); }, [signature]);
  const validate = async () => {
    setBusy(true); setError(''); setValidated(undefined);
    try {
      const releases = await Promise.all(selection.map(ref => api<Item<ResearchAssetRelease>>(`${base}/library/${enc(ref.assetId)}/releases/${enc(ref.version)}`)));
      const config: ResearchConfigurationSelection = { skills: [], libraries: [] };
      for (const { item } of releases) {
        const ref = { assetId: item.assetId, version: item.version, digest: item.digest };
        if (item.type === 'agent') { if (config.agent) throw new Error(tx('一次研究只能选择一个 Agent，请移除多余配置。', 'Choose one agent for a research run. Remove the additional agent.')); config.agent = ref; }
        else if (item.type === 'skill') config.skills!.push(ref); else config.libraries!.push(ref);
      }
      const result = await api<Item<FrozenResearchConfiguration>>(`${base}/configuration`, { method: 'POST', body: JSON.stringify({ environment, selection: config }) });
      if (currentSignature.current === signature) setValidated(result.item);
    } catch (cause) { if (currentSignature.current === signature) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const open = () => {
    const first = selection[0]!, parameters = new URLSearchParams({ researchAsset: first.assetId, researchVersion: first.version, lang: locale });
    try {
      if (!authenticated) parameters.set('libraryReturn', rememberLibraryEntry(selection, validated?.environment ?? environment));
      else if (!saveSelection(selection, validated?.environment ?? environment)) throw new Error('selection_storage_unavailable');
      location.assign(`./?${parameters}`);
    } catch { setError(tx('浏览器未能保存组合，请从每个版本的「用于新研究」入口带入。', 'The browser could not save the selection. Use each release’s “Use in new research” action.')); }
  };
  return <section id="research-library-selection" class="research-panel research-selection-panel" aria-label={tx('研究配置选择', 'Research configuration selection')}><h2>{tx('研究配置选择', 'Research configuration selection')} ({selection.length})</h2>
    <ul class="research-list">{selection.map(ref => <li class="research-list-item" key={`${ref.assetId}@${ref.version}`}><div class="research-actions"><a href={filteredLibraryHref(ref.assetId, ref.version)}>{assets.find(asset => asset.id === ref.assetId)?.name ?? ref.assetId} · {ref.version}</a>
      <button type="button" class="text-button" disabled={busy} onClick={() => remove(ref)}>{tx('移除', 'Remove')}</button></div></li>)}</ul>
    <div class="research-selection"><div><label class="research-field">{tx('目标环境', 'Target environment')}<select value={environment} disabled={busy} onChange={event => setEnvironment(event.currentTarget.value as WebEnvironment)}><option value="mathlib">mathlib</option><option value="standard">Lean standard</option></select></label>
      <p>{validated ? tx('组合检查通过，版本与依赖已固定。', 'Configuration checked. Versions and dependencies are fixed.') : tx('检查依赖、环境和研究规则后带入工作台。', 'Check dependencies, environment and research rules before opening the workbench.')}</p></div>
      <div class="research-actions"><button class="button" type="button" disabled={busy} onClick={() => void validate()}>{busy ? tx('正在检查…', 'Checking…') : tx('检查组合', 'Check configuration')}</button>
        <button class="button button-primary" type="button" disabled={busy} onClick={open}>{tx('带入工作台', 'Open in workbench')}</button><button type="button" class="text-button" disabled={busy} onClick={clear}>{tx('清空', 'Clear')}</button></div></div>
    <ErrorBox message={error} />{validated && <details><summary>{tx('查看固定配置身份', 'View fixed configuration identity')}</summary><dl class="research-facts"><div><dt>{tx('环境', 'Environment')}</dt><dd>{validated.environment}</dd></div><div><dt>{tx('配置摘要', 'Digest')}</dt><dd>{validated.digest}</dd></div></dl></details>}
  </section>;
}
