import { useEffect, useRef, useState } from 'preact/hooks';
import type { FrozenResearchConfiguration, ResearchAsset, ResearchAssetPreview, ResearchAssetRelease, ResearchConfigurationSelection, ResearchLibraryUse, ResearchPublication, ResearchReleaseRef } from '../researchAssetTypes';
import type { ResearcherProfile } from '../researchProjectTypes';
import { AssetEditor } from './researchAssetEditor';
import { RichProse } from './richText';
import { OwnedDrafts, researchEnvironmentStorageKey, researchSelectionStorageKey, webDraftOwner } from './ownedDrafts';
import type { WebEnvironment } from '../shared';
import { api, base, enc, Empty, ErrorBox, errorText, Field, libraryHref, MutationState, nameOf, Panel, personHref, Search, stamp, State, Tags, theoremHref, tx,
  useMutation, useResource, type Item, type Items, type ResearchContext } from './researchShared';

const selectionDrafts = new OwnedDrafts(() => sessionStorage);
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

export function LibraryPage({ context }: { context: ResearchContext }) {
  selectionDrafts.bind(webDraftOwner(context.web));
  const parameters = new URLSearchParams(location.search), selected = parameters.get('entry') ?? '';
  const [query, setQuery] = useState(''), [type, setType] = useState('mathematics'), [area, setArea] = useState(''), [author, setAuthor] = useState(''), [environment, setEnvironment] = useState(''), [mine, setMine] = useState(parameters.get('mine') === '1'),
    [creating, setCreating] = useState(context.session.authenticated && parameters.get('create') === '1'), [selection, setSelection] = useState<ResearchReleaseRef[]>(rememberedSelection), [storageError, setStorageError] = useState('');
  const [creatorMounted, setCreatorMounted] = useState(creating);
  const directory = useResource<Items<ResearchAsset>>(`${base}/library?q=${enc(query)}&type=${enc(type)}&area=${enc(area)}&author=${enc(author)}${mine ? '&mine=1' : ''}`);
  const detail = useResource<Item<ResearchAsset>>(selected ? `${base}/library/${enc(selected)}` : undefined);
  useEffect(() => { if (detail.data) setType(detail.data.item.type); }, [detail.data?.item.id]);
  const items = directory.data?.items.filter(item => type !== 'mathematics' || !environment || item.release?.mathematics?.environment === environment) ?? [];
  const choose = (ref: ResearchReleaseRef) => {
    const next = selection.some(item => item.assetId === ref.assetId && item.version === ref.version) ? selection.filter(item => item.assetId !== ref.assetId || item.version !== ref.version) : [...selection.filter(item => item.assetId !== ref.assetId), ref];
    setSelection(next); setStorageError(saveSelection(next) ? '' : tx('浏览器未能保存配置选择，请逐项带入工作台。', 'The browser could not save the selection. Open each asset in the workbench individually.'));
  };
  const clear = () => { setSelection([]); saveSelection([]); };
  return <><div class="research-heading"><div><span class="research-eyebrow">TheoremOS / Library</span><h1>{tx('共享成果与研究方法', 'Shared mathematics and research methods')}</h1>
    <p>{tx('发布可检查的数学成果，保存自己的 Agent 和 Skill，并选择固定版本用于新研究。', 'Publish verifiable mathematics, create agents and skills, and choose fixed versions for new research.')}</p></div>
    <div class="research-heading-actions">{context.session.authenticated ? <button class="button button-primary" type="button" onClick={() => { setCreatorMounted(true); setCreating(value => !value); }} aria-expanded={creating}>{creating ? tx('收起创建表单', 'Close creator') : tx('创建成果 / 工具', 'Create an asset')}</button>
      : <a class="button" href="login.html">{tx('登录后创建成果', 'Sign in to create an asset')}</a>}</div></div>
    {creatorMounted && <div hidden={!creating}><Panel title={tx('创建草稿', 'Create a draft')} note={tx('先保存到个人空间；确认内容、许可证与可见范围后再发布。', 'Save it in your space, then review the content, license and visibility before publishing.')}>
      <AssetEditor context={context} onSaved={asset => location.assign(libraryHref(asset.id))} /></Panel></div>}
    <div class="research-layout" data-selected={Boolean(selected)}><aside class="research-sidebar"><Panel title={tx('浏览 Library', 'Explore Library')}>
      <div class="research-tabs" aria-label={tx('内容类型', 'Content type')}>{(['mathematics', 'agent', 'skill'] as const).map(value => <button key={value} type="button" aria-pressed={type === value} onClick={() => setType(value)}>{nameOf(value)}</button>)}</div>
      <div class="research-form"><Search label={tx('关键词或 Lean 名称', 'Keyword or Lean name')} onSearch={setQuery} /><Field label={tx('按研究领域筛选', 'Filter by research field')} value={area} onInput={setArea} />
        <Field label={tx('按作者 ID 筛选', 'Filter by author ID')} value={author} onInput={setAuthor} />
        {type === 'mathematics' && <label>{tx('按证明环境筛选', 'Filter by proof environment')}<select value={environment} onChange={event => setEnvironment(event.currentTarget.value)}><option value="">{tx('全部环境', 'All environments')}</option><option value="mathlib">mathlib</option><option value="standard">Lean standard</option></select></label>}
        <label class="research-check"><input type="checkbox" checked={mine} onChange={event => setMine(event.currentTarget.checked)} />{tx('我的草稿与发布', 'My drafts and releases')}</label></div>
      <ErrorBox message={directory.error} /><ul class="research-list">{items.map(asset => <li key={asset.id}><a class="research-list-item" href={libraryHref(asset.id)} aria-current={selected === asset.id ? 'true' : undefined}>
        <span class="research-item-title">{asset.name}</span><span class="research-item-meta"><span>{asset.area || nameOf(asset.type)}</span><span>{asset.release?.version ?? tx('草稿', 'Draft')}</span><State value={asset.visibility} /></span></a></li>)}</ul>
      {directory.data && !items.length && <Empty>{mine ? tx('还没有此类资产。创建草稿后会显示在这里。', 'No assets of this type yet. Create a draft to begin.') : tx('暂无匹配的公开版本。', 'No matching public releases.')}</Empty>}
    </Panel><Panel title={tx('固定版本复用', 'Reuse a fixed version')}><p class="research-description">{tx('将版本加入选择后，可检查组合是否兼容，再带入工作台。研究启动前还会固定完整依赖。', 'Add versions to your selection, check their compatibility and open them in the workbench. Dependencies are frozen before research starts.')}</p></Panel></aside>
      <div class="research-content"><ErrorBox message={detail.error} />{detail.data ? <Asset key={selected} asset={detail.data.item} context={context} refresh={detail.refresh} selection={selection} choose={choose} />
        : <Panel title={selected ? tx('正在读取资产…', 'Loading asset…') : tx('选择一项成果或工具', 'Choose mathematics or a research tool')}><Empty>{tx('浏览数学成果、Agent 和 Skill，查看来源与版本，或创建自己的私有草稿。', 'Browse mathematics, agents and skills, inspect their sources and versions, or create a private draft.')}</Empty></Panel>}</div></div>
    <ErrorBox message={storageError} />{selection.length > 0 && <Selection selection={selection} remove={choose} clear={clear} assets={directory.data?.items ?? []} />}
  </>;
}

function Asset({ asset, context, refresh, selection, choose }: { asset: ResearchAsset; context: ResearchContext; refresh: () => void; selection: ResearchReleaseRef[]; choose: (ref: ResearchReleaseRef) => void }) {
  const author = useResource<Item<ResearcherProfile>>(`${base}/people/${enc(asset.authorId)}`);
  const [version, setVersion] = useState(new URLSearchParams(location.search).get('version') ?? asset.release?.version ?? ''), [editing, setEditing] = useState(false),
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
  const forPublication = (publication: ResearchPublication) => {
    setPublicationId(publication.id);
    try { sessionStorage.setItem(`theoremos.research.publication.${asset.id}`, publication.id); } catch { /* The publication remains visible in this page. */ }
  };
  const published = (publication: ResearchPublication) => { refresh(); if (publication.release) setVersion(publication.release.version); };
  const useVersion = () => {
    if (!release) return;
    const ref = { assetId: asset.id, version: release.version }, next = [...selection.filter(item => item.assetId !== asset.id), ref];
    saveSelection(next); location.assign(`./?researchAsset=${enc(ref.assetId)}&researchVersion=${enc(ref.version)}`);
  };
  return <><Panel title={asset.name} actions={asset.editable && <button type="button" class="button" onClick={() => { setEditorMounted(true); setEditing(value => !value); }} aria-expanded={editing}>{editing ? tx('收起编辑器', 'Close editor') : tx('编辑草稿', 'Edit draft')}</button>}>
    <div class="research-item-meta"><span>{nameOf(asset.type)}</span><a href={personHref(asset.authorId)}>{author.data?.item.displayName ?? asset.authorId}</a><State value={asset.visibility} /><span>{asset.area}</span><time dateTime={asset.updatedAt}>{stamp(asset.updatedAt)}</time></div>
    <div class="research-description"><RichProse text={asset.description || tx('暂无用途说明。', 'No description yet.')} /></div>
    <dl class="research-facts"><div><dt>{tx('资产 ID', 'Asset ID')}</dt><dd>{asset.id}</dd></div>{asset.derivedFrom && <div><dt>{tx('派生来源', 'Derived from')}</dt><dd><a href={libraryHref(asset.derivedFrom.assetId, asset.derivedFrom.version)}>{asset.derivedFrom.assetId}@{asset.derivedFrom.version}</a></dd></div>}</dl>
    {asset.editable && !asset.release && <p class="research-status">{tx('当前为个人草稿。发布检查完成后，才能作为固定版本使用。', 'This is a draft. Publish and complete validation before using it as a fixed version.')}</p>}
  </Panel>{editorMounted && <div hidden={!editing}><Panel title={tx('编辑草稿', 'Edit draft')} actions={<button class="text-button" type="button" disabled={loadingDraft} onClick={() => void loadDraft()}>{tx('载入最新草稿', 'Load latest draft')}</button>}>
    <ErrorBox message={draftError} /><AssetEditor key={editorKey} asset={editorAsset} context={context} disabled={loadingDraft}
      onSaved={item => { setLoadedDraft(item); refresh(); }} /></Panel></div>}
    {asset.editable && <Panel title={tx('发布固定版本', 'Publish a fixed version')} note={tx('发布前请审阅草稿；只有你选择公开的版本会进入共享目录。', 'Review the draft before publishing. Only versions you make public appear in the shared directory.')}>
      <Publish asset={asset} onPublication={forPublication} />{publicationId && <Publication key={publicationId} id={publicationId} completed={published} />}
    </Panel>}
    <Panel title={tx('已发布版本', 'Published versions')}>
      {asset.releases.length > 0 ? <label class="research-field">{tx('查看固定版本', 'View a fixed version')}<select value={version} onChange={event => {
        setVersion(event.currentTarget.value); const next = new URL(location.href); next.searchParams.set('version', event.currentTarget.value); history.replaceState(null, '', next);
      }}>{asset.releases.filter(item => !item.withdrawn || asset.editable).map(item => <option key={item.version} value={item.version}>{item.version} · {item.license} · {stamp(item.createdAt)}{item.withdrawn ? ` · ${tx('已撤回', 'Withdrawn')}` : ''}</option>)}</select></label>
      : <Empty>{tx('尚无已发布版本。', 'No published versions yet.')}</Empty>}
      <ErrorBox message={releaseResult.error} />{releaseResult.error && <button class="text-button" type="button" onClick={releaseResult.refresh}>{tx('重新读取版本', 'Reload release')}</button>}
      {release && <><div class="research-item-meta"><span>{release.license}</span><State value={release.visibility} /><time dateTime={release.createdAt}>{stamp(release.createdAt)}</time></div>
        <ReleaseContent release={release} /><h3>{tx('固定身份', 'Fixed identity')}</h3><dl class="research-facts"><div><dt>{tx('版本', 'Version')}</dt><dd>{release.version}</dd></div><div><dt>{tx('内容摘要', 'Content digest')}</dt><dd>{release.digest}</dd></div></dl>
        <div class="research-actions"><button class="button" type="button" aria-pressed={selection.some(ref => ref.assetId === asset.id && ref.version === release.version)} onClick={() => choose({ assetId: asset.id, version: release.version })}>
          {selection.some(ref => ref.assetId === asset.id && ref.version === release.version) ? tx('已加入配置选择', 'In configuration selection') : tx('加入配置选择', 'Add to configuration')}</button>
          <button class="button button-primary" type="button" onClick={useVersion}>{tx('用于新研究', 'Use in new research')}</button>
          <a class="button" href={`${base}/library/${enc(asset.id)}/releases/${enc(release.version)}?download=1`} download>{tx('下载版本', 'Download release')}</a></div>
        <p class="research-field-note">{tx('带入工作台只准备研究配置，由你确认后启动。', 'Opening the workbench prepares a configuration. You choose when to start research.')}</p>
        <Fork asset={asset} version={release.version} />{asset.editable && <Withdraw asset={asset} version={release.version} refresh={() => { refresh(); releaseResult.refresh(); }} />}
      </>}
    </Panel></>;
}

function ReleaseContent({ release }: { release: ResearchAssetRelease }) {
  if (release.type === 'mathematics' && release.mathematics) {
    const math = release.mathematics;
    return <><h3>{tx('数学声明', 'Mathematical declarations')}</h3>{math.declarations.map(declaration => <article class="research-event" key={`${declaration.file}:${declaration.name}`}>
      <span class="research-item-title">{declaration.name}</span><pre class="research-block-code">{declaration.type}</pre><span class="research-item-meta">{declaration.file}</span></article>)}
      <dl class="research-facts"><div><dt>{tx('环境', 'Environment')}</dt><dd>{math.environment}</dd></div><div><dt>{tx('环境摘要', 'Environment digest')}</dt><dd>{math.environmentDigest}</dd></div><div><dt>{tx('库摘要', 'Pack digest')}</dt><dd>{math.packDigest}</dd></div></dl>
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
  return <><h3>{tx('固定依赖', 'Fixed dependencies')}</h3>{refs.length ? <ul class="research-list">{refs.map(ref => <li key={`${ref.assetId}@${ref.version}`}><a class="research-list-item" href={libraryHref(ref.assetId, ref.version)}>
    <span class="research-item-title">{ref.assetId}@{ref.version}</span>{ref.digest && <span class="research-item-meta">{ref.digest}</span>}</a></li>)}</ul> : <p class="research-status">{tx('无额外发布依赖。', 'No additional release dependencies.')}</p>}</>;
}

function Publish({ asset, onPublication }: { asset: ResearchAsset; onPublication: (publication: ResearchPublication) => void }) {
  const [version, setVersion] = useState(`v${asset.releases.length + 1}`), [license, setLicense] = useState(''), [visibility, setVisibility] = useState('private'), [reviewed, setReviewed] = useState(''), action = useMutation();
  const [preview, setPreview] = useState<ResearchAssetPreview>(), [previewBusy, setPreviewBusy] = useState(false), [previewError, setPreviewError] = useState('');
  const previewLock = useRef(false);
  const ready = Boolean(preview?.previewDigest && preview.revision === asset.revision && !previewBusy && !previewError);
  const reviewIdentity = JSON.stringify([preview?.previewDigest, asset.revision, visibility]), confirmed = ready && reviewed === reviewIdentity;
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
    { expectedRevision: asset.revision, previewDigest: preview.previewDigest, version, license: license.trim(), visibility }, result => onPublication(result.item)); }}>
    <button type="button" class="button" disabled={previewBusy || action.busy} onClick={() => void loadPreview()}>{tx('预览将公开的内容', 'Preview release contents')}</button>
    <ErrorBox message={previewError} />{previewBusy && <p class="research-status" role="status">{tx('正在准备完整内容与依赖…', 'Preparing contents and dependencies…')}</p>}
    {preview && <DraftPreview preview={preview} />}
    <div class="research-form-row"><Field label={tx('版本号', 'Version')} value={version} onInput={setVersion} required placeholder="v1" />
      <Field label={tx('许可证', 'License')} value={license} onInput={setLicense} required placeholder="MIT / Apache-2.0 / CC-BY-4.0" /></div>
    <label>{tx('发布范围', 'Release visibility')}<select value={visibility} onChange={event => setVisibility(event.currentTarget.value)}><option value="private">{tx('仅自己使用', 'Private')}</option><option value="public">{tx('公开分享', 'Public')}</option></select></label>
    <CheckReview checked={confirmed} disabled={!ready || action.busy} change={checked => setReviewed(checked ? reviewIdentity : '')} /><MutationState action={action} /><button class="button" type="submit" disabled={action.busy || !confirmed}>{action.busy ? tx('正在提交…', 'Submitting…') : tx('发布并检查', 'Publish and validate')}</button>
  </form>;
}
function DraftPreview({ preview }: { preview: ResearchAssetPreview }) {
  return <section class="research-draft-preview" aria-label={tx('发布内容预览', 'Release preview')}><h3>{preview.name}</h3>
    {preview.mathematics ? <><p class="research-status">{tx('证明环境：', 'Environment: ')}{preview.mathematics.environment}</p>
      {preview.mathematics.declarations.map(declaration => <div key={`${declaration.file}:${declaration.name}`}><h3>{declaration.name}</h3><pre class="research-block-code">{declaration.type}</pre></div>)}
      {preview.mathematics.pack.modules.map(module => <details key={module.file} open><summary>{module.file}</summary><pre class="research-block-code">{module.source}</pre></details>)}
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
    {result.data.item.reason && <ErrorBox message={result.data.item.reason} />}{result.data.item.release && <a href={libraryHref(result.data.item.release.assetId, result.data.item.release.version)}>{tx('查看发布版本', 'View release')}</a>}</>}</div>;
}

function Fork({ asset, version }: { asset: ResearchAsset; version: string }) {
  const [name, setName] = useState(''), action = useMutation();
  return <details><summary>{tx('复制到个人空间并修改', 'Fork into my space')}</summary><form class="research-form" onSubmit={event => { event.preventDefault(); void action.run<Item<ResearchAsset>>('POST', `${base}/library/${enc(asset.id)}/fork`,
    { version, ...(name.trim() ? { name: name.trim() } : {}) }, result => location.assign(libraryHref(result.item.id))); }}>
    <Field label={tx('新名称（可选）', 'New name (optional)')} value={name} onInput={setName} maxLength={160} /><MutationState action={action} /><button class="button" type="submit" disabled={action.busy}>{tx('创建私有派生草稿', 'Create private fork')}</button>
  </form></details>;
}
function Withdraw({ asset, version, refresh }: { asset: ResearchAsset; version: string; refresh: () => void }) {
  const action = useMutation();
  return <details><summary>{tx('撤回此版本', 'Withdraw this version')}</summary><p class="research-field-note">{tx('撤回后停止新的公开发现和下载；已经固定到其他研究的副本仍保留。', 'Withdrawal stops new public discovery and downloads. Copies already frozen into research remain available there.')}</p>
    <MutationState action={action} /><button type="button" class="button button-danger" disabled={action.busy || asset.releases.find(item => item.version === version)?.withdrawn}
      onClick={() => void action.run('POST', `${base}/library/${enc(asset.id)}/releases/${enc(version)}/withdraw`, { expectedRevision: asset.revision }, refresh)}>{tx('撤回版本', 'Withdraw release')}</button></details>;
}

function Selection({ selection, remove, clear, assets }: { selection: ResearchReleaseRef[]; remove: (ref: ResearchReleaseRef) => void; clear: () => void; assets: ResearchAsset[] }) {
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
    if (!saveSelection(selection, validated?.environment ?? environment)) { setError(tx('浏览器未能保存组合，请从每个版本的「用于新研究」入口带入。', 'The browser could not save the selection. Use each release’s “Use in new research” action.')); return; }
    const first = selection[0]!; location.assign(`./?researchAsset=${enc(first.assetId)}&researchVersion=${enc(first.version)}`);
  };
  return <section class="research-panel research-selection-panel" aria-label={tx('研究配置选择', 'Research configuration selection')}><h2>{tx('研究配置选择', 'Research configuration selection')} ({selection.length})</h2>
    <ul class="research-list">{selection.map(ref => <li class="research-list-item" key={`${ref.assetId}@${ref.version}`}><div class="research-actions"><a href={libraryHref(ref.assetId, ref.version)}>{assets.find(asset => asset.id === ref.assetId)?.name ?? ref.assetId} · {ref.version}</a>
      <button type="button" class="text-button" disabled={busy} onClick={() => remove(ref)}>{tx('移除', 'Remove')}</button></div></li>)}</ul>
    <div class="research-selection"><div><label class="research-field">{tx('目标环境', 'Target environment')}<select value={environment} disabled={busy} onChange={event => setEnvironment(event.currentTarget.value as WebEnvironment)}><option value="mathlib">mathlib</option><option value="standard">Lean standard</option></select></label>
      <p>{validated ? tx('组合检查通过，版本与依赖已固定。', 'Configuration checked. Versions and dependencies are fixed.') : tx('检查依赖、环境和研究规则后带入工作台。', 'Check dependencies, environment and research rules before opening the workbench.')}</p></div>
      <div class="research-actions"><button class="button" type="button" disabled={busy} onClick={() => void validate()}>{busy ? tx('正在检查…', 'Checking…') : tx('检查组合', 'Check configuration')}</button>
        <button class="button button-primary" type="button" disabled={busy} onClick={open}>{tx('带入工作台', 'Open in workbench')}</button><button type="button" class="text-button" disabled={busy} onClick={clear}>{tx('清空', 'Clear')}</button></div></div>
    <ErrorBox message={error} />{validated && <details><summary>{tx('查看固定配置身份', 'View fixed configuration identity')}</summary><dl class="research-facts"><div><dt>{tx('环境', 'Environment')}</dt><dd>{validated.environment}</dd></div><div><dt>{tx('配置摘要', 'Digest')}</dt><dd>{validated.digest}</dd></div></dl></details>}
  </section>;
}
