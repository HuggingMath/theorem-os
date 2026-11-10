import { useState } from 'preact/hooks';
import type { ResearchAsset } from '../researchAssetTypes';
import type { ResearchAssetFollows, ResearchAssetUpdate } from '../researchCollectionTypes';
import type { ResearchReleaseChange, ResearchReleaseComparison } from '../researchReleaseComparison';
import { Rich, RichProse } from './richText';
import { compareSources } from './sourceDiff';
import { base, enc, Empty, ErrorBox, libraryHref, MutationState, Panel, tx, useMutation, useResource, type Item, type ResearchContext } from './researchShared';

const comparisonHref = (update: ResearchAssetUpdate) => `${libraryHref(update.assetId, update.toVersion)}&${new URLSearchParams({ compareFrom: update.fromVersion, compareTo: update.toVersion })}#release-comparison`;
export function AssetUpdatesPanel({ context }: { context: ResearchContext }) {
  const data = useResource<ResearchAssetFollows>(context.session.authenticated ? `${base}/asset-follows` : undefined, 15_000), action = useMutation();
  if (!context.session.authenticated) return null;
  return <Panel title={tx('关注成果的新版本', 'New releases you follow')} id="asset-updates">
    <ErrorBox message={data.error} />{data.error && <button class="text-button" type="button" onClick={data.refresh}>{tx('重新读取', 'Try again')}</button>}
    {data.data?.updates.map(update => <article class="research-event" key={`${update.assetId}:${update.digest}`}><a href={comparisonHref(update)}><Rich text={update.title} /> · {update.fromVersion} → {update.toVersion}</a>
      {update.releaseNotes && <RichProse text={update.releaseNotes} />}<div class="research-actions"><a class="text-button" href={comparisonHref(update)}>{tx('查看版本差异', 'Compare releases')}</a>
        <button type="button" class="text-button" disabled={action.busy} onClick={() => void action.run('POST', `${base}/asset-follows/${enc(update.assetId)}`, { following: true, readVersion: update.toVersion }, data.refresh)}>{tx('标为已读', 'Mark as read')}</button></div>
    </article>)}
    {data.data && !data.data.updates.length && <Empty>{data.data.items.length ? tx('关注成果暂时没有未读更新。', 'No unread releases from the assets you follow.') : tx('在 Library 版本页关注成果，新版本会显示在这里。', 'Follow an asset in Library to see new releases here.')}</Empty>}
    <MutationState action={action} />{Boolean(data.data?.items.length) && <details><summary>{tx('管理关注', 'Manage followed assets')}</summary>{data.data!.items.map(item => <div class="research-actions" key={item.assetId}>
      {item.available ? <a href={libraryHref(item.assetId)}><Rich text={item.title ?? ''} /></a> : <span>{tx('成果已不可访问', 'Asset is unavailable')}</span>}
      <button class="text-button" type="button" disabled={action.busy} onClick={() => void action.run('POST', `${base}/asset-follows/${enc(item.assetId)}`, { following: false }, data.refresh)}>{tx('取消关注', 'Unfollow')}</button></div>)}</details>}
  </Panel>;
}
export function AssetFollowControl({ context, assetId, version }: { context: ResearchContext; assetId: string; version: string }) {
  const data = useResource<ResearchAssetFollows>(context.session.authenticated ? `${base}/asset-follows` : undefined), action = useMutation();
  const followed = data.data?.items.some(item => item.assetId === assetId) ?? false;
  if (!context.session.authenticated) return null;
  return <div class="research-asset-follow"><button type="button" class="text-button" disabled={!data.data || action.busy} aria-pressed={followed}
    onClick={() => void action.run('POST', `${base}/asset-follows/${enc(assetId)}`, { following: !followed, version }, data.refresh)}>
    {followed ? tx('已关注新版本', 'Following new releases') : tx('关注新版本', 'Follow new releases')}</button><MutationState action={action} /><ErrorBox message={data.error} />
    {data.error && <button type="button" class="text-button" onClick={data.refresh}>{tx('重新读取关注状态', 'Reload follow status')}</button>}</div>;
}

export function ReleaseComparison({ asset, selectedVersion, useVersion }: { asset: ResearchAsset; selectedVersion: string; useVersion(version: string): void }) {
  const parameters = new URLSearchParams(location.search), releases = asset.releases.filter(item => !item.withdrawn);
  const [open, setOpen] = useState(parameters.has('compareFrom')), [from, setFrom] = useState(parameters.get('compareFrom') ?? releases.find(item => item.version !== selectedVersion)?.version ?? selectedVersion);
  const [to, setTo] = useState(parameters.get('compareTo') ?? selectedVersion);
  const data = useResource<Item<ResearchReleaseComparison>>(open && from && to ? `${base}/library/${enc(asset.id)}/compare?${new URLSearchParams({ from, to })}` : undefined);
  if (releases.length < 2) return null;
  return <details id="release-comparison" open={open} onToggle={event => setOpen(event.currentTarget.open)} data-release-comparison>
    <summary>{tx('比较发布版本', 'Compare releases')}</summary>
    <div class="research-form research-form-row"><label>{tx('已有版本', 'Earlier version')}<select value={from} onChange={event => setFrom(event.currentTarget.value)}>
      {releases.map(item => <option key={item.version}>{item.version}</option>)}</select></label><label>{tx('对照版本', 'Compare with')}<select value={to} onChange={event => setTo(event.currentTarget.value)}>
      {releases.map(item => <option key={item.version}>{item.version}</option>)}</select></label></div>
    <ErrorBox message={data.error} />{data.error && <button class="text-button" type="button" onClick={data.refresh}>{tx('重新读取差异', 'Retry comparison')}</button>}
    {data.loading && !data.data && <p role="status">{tx('正在读取固定版本差异…', 'Loading fixed release differences…')}</p>}
    {data.data && <><h3>{from} → {to}</h3>{data.data.item.releaseNotes ? <><h4>{tx('作者更新说明', 'Author’s release notes')}</h4><RichProse text={data.data.item.releaseNotes} /></>
      : <p class="research-status">{tx('作者未提供此版本的更新说明。', 'The author did not provide release notes for this version.')}</p>}
      <ChangeGroup title={tx('数学声明', 'Mathematical declarations')} items={data.data.item.declarations} />
      <ChangeGroup title={tx('固定依赖', 'Fixed dependencies')} items={data.data.item.dependencies} />
      <h4>{tx('证明环境', 'Proof environment')}</h4>{data.data.item.environment.changed ? <BeforeAfter before={data.data.item.environment.before ?? tx('未记录', 'Not recorded')} after={data.data.item.environment.after ?? tx('未记录', 'Not recorded')} />
        : <p class="research-status">{tx('环境没有变化。', 'The environment is unchanged.')}</p>}
      <ChangeGroup title={tx('内容与源码', 'Content and source')} items={data.data.item.content} diff />
      <ChangeGroup title={tx('名称、说明与许可证', 'Name, description and license')} items={data.data.item.metadata} />
      <div class="research-actions"><button class="button" type="button" disabled={from === to || data.loading || Boolean(data.error)} onClick={() => useVersion(to)}>{tx('用对照版本准备新研究', 'Prepare new research with this version')}</button></div>
      <p class="research-field-note">{tx('采用这个版本会先带入工作台供你确认。已有研究继续保留原来的固定版本。', 'This prepares a configuration for your review in the workbench. Existing runs retain their original fixed versions.')}</p>
    </>}
  </details>;
}
function BeforeAfter({ before, after }: { before: string; after: string }) {
  return <div class="research-release-before-after"><div><span>{tx('之前', 'Before')}</span><pre class="research-block-code">{before}</pre></div><div><span>{tx('之后', 'After')}</span><pre class="research-block-code">{after}</pre></div></div>;
}
function ChangeGroup({ title, items, diff = false }: { title: string; items: ResearchReleaseChange[]; diff?: boolean }) {
  return <section class="research-release-changes"><h4>{title} <span>{items.length}</span></h4>{!items.length ? <p class="research-status">{tx('没有变化。', 'No changes.')}</p> : items.map(item => {
    const comparison = diff ? compareSources(item.before ?? '', item.after ?? '') : undefined;
    return <details key={item.name}><summary>{({ added: tx('新增', 'Added'), removed: tx('移除', 'Removed'), changed: tx('修改', 'Changed') })[item.kind]} · {item.name}</summary>
      {comparison?.status === 'ready' ? <pre class="research-release-diff" aria-label={tx('逐行内容差异', 'Line changes')}>{comparison.rows.map((row, index) => row.kind === 'gap'
        ? <span key={index}>… {row.count} {tx('行未变化', 'unchanged lines')}{'\n'}</span> : <span key={index} data-change={row.kind}>{row.kind === 'added' ? '+ ' : row.kind === 'removed' ? '− ' : '  '}{row.text}{'\n'}</span>)}</pre>
        : <BeforeAfter before={item.before ?? tx('无', 'None')} after={item.after ?? tx('无', 'None')} />}
      {Boolean(comparison?.omittedLines) && <p class="research-status">{tx('差异较长，请下载两个固定版本查看完整内容。', 'This comparison is long. Download both fixed releases to inspect the complete content.')}</p>}
    </details>;
  })}</section>;
}
