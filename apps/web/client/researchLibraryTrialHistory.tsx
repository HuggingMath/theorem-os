import { useEffect, useState } from 'preact/hooks';
import type { ResearchLibraryTrialHistory as History, ResearchLibraryTrialHistoryItem as HistoryItem } from '../researchLibraryTrialTypes';
import { PersonalTrialAttempt } from './researchLibraryProposal';
import { Rich, RichProse } from './richText';
import { base, enc, Empty, ErrorBox, Panel, stamp, tx, useResource, type Item, type ResearchContext } from './researchShared';

const label = (status: HistoryItem['status']) => ({ prepared: tx('待检查', 'Prepared'), checking: tx('检查中', 'Checking'),
  passed: tx('局部检查通过', 'Local check passed'), failed: tx('检查未通过', 'Check failed') })[status];
export function LibraryTrialHistory({ context, runId, assetId }: { context?: ResearchContext; runId?: string; assetId?: string }) {
  const query = new URLSearchParams(location.search), [status, setStatus] = useState(''), [offset, setOffset] = useState(0), [selected, setSelected] = useState(query.get('trial') ?? '');
  const run = runId ?? query.get('run') ?? undefined, asset = assetId ?? query.get('asset') ?? undefined;
  const parameters = new URLSearchParams({ offset: String(offset), ...(run ? { run } : {}), ...(asset ? { asset } : {}), ...(status ? { status } : {}) });
  const data = useResource<{ items: HistoryItem[]; total: number; nextOffset?: number }>(`${base}/library-trials?${parameters}`, 10_000);
  useEffect(() => { setOffset(0); }, [run, asset, status]);
  useEffect(() => { const back = () => setSelected(new URLSearchParams(location.search).get('trial') ?? ''); window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back); }, []);
  const choose = (id: string) => { setSelected(id); const url = new URL(location.href); url.searchParams.set('trial', id); history.pushState(null, '', url); };
  if (context && !context.session.authenticated) return null;
  return <Panel title={tx('我的数学库试用', 'My Library trials')}>
    <p>{tx('找回保存的候选、参数和检查回执。局部检查结果独立于原题验收。', 'Find saved candidates, arguments and check receipts. Local checks are separate from acceptance of the original problem.')}</p>
    <label>{tx('试用状态', 'Trial status')}<select data-trial-history-filter value={status} onChange={event => setStatus(event.currentTarget.value)}>
      <option value="">{tx('全部试用', 'All trials')}</option>{(['prepared', 'checking', 'passed', 'failed'] as const).map(value => <option value={value} key={value}>{label(value)}</option>)}</select></label>
    <ErrorBox message={data.error} />{data.error && <button class="button" type="button" onClick={data.refresh}>{tx('重新读取试用记录', 'Reload trial history')}</button>}
    {data.loading && !data.data && <p role="status">{tx('正在读取试用记录…', 'Loading trial history…')}</p>}
    {data.data && <><p>{tx(`共 ${data.data.total} 次试用`, `${data.data.total} trials`)}</p>
      {!data.data.items.length && <Empty>{tx('没有符合条件的试用记录。', 'No trials match these filters.')}</Empty>}
      {data.data.items.map(item => <article class="research-event" key={item.id} data-trial-history-item={item.id}>
        <h4><Rich text={item.runTitle} /> · <Rich text={item.taskTitle} /></h4><p><code>{item.declaration}</code> · {item.release.version} · {stamp(item.createdAt)}</p>
        <p>{label(item.status)}{!item.current ? ` · ${tx('历史版本', 'Historical version')}` : ''}</p>
        <button class="button" type="button" data-open-trial-history onClick={() => choose(item.id)}>{tx('查看固定候选与回执', 'Read fixed candidate and receipt')}</button>
      </article>)}
      <div class="research-actions">{offset > 0 && <button class="text-button" type="button" onClick={() => setOffset(Math.max(0, offset - 30))}>{tx('上一页', 'Previous')}</button>}
        {data.data.nextOffset !== undefined && <button class="text-button" type="button" onClick={() => setOffset(data.data!.nextOffset!)}>{tx('下一页', 'Next')}</button>}</div></>}
    {selected && <LibraryTrialHistoryReader key={selected} id={selected} />}
  </Panel>;
}

export function LibraryTrialHistoryReader({ id }: { id: string }) {
  const data = useResource<Item<History>>(`${base}/library-trials/${enc(id)}/history`, 10_000), saved = data.data?.item;
  return <section class="research-trial-review" data-trial-history-reader={id}>
    <ErrorBox message={data.error} />{data.error && <button class="text-button" type="button" onClick={data.refresh}>{tx('重新读取固定证据', 'Reload fixed evidence')}</button>}
    {saved && <><h3>{tx('这次试用的固定记录', 'Fixed record of this trial')}</h3><p><Rich text={saved.trial.target.taskTitle} /> · {label(saved.trial.status)}</p>
      {!saved.current && <p class="research-status" data-trial-historical>{tx('目标或成果已有变化。以下保留当时的候选与回执；继续检查或用于新尝试前，需要重新选择当前目标。',
        'The goal or release has changed. This is the candidate and receipt saved at the time. Select the current goal before checking again or preparing a new attempt.')}</p>}
      <dl class="research-facts"><div><dt>{tx('任务版本', 'Task version')}</dt><dd><code>{saved.trial.target.ref.taskVersion}</code></dd></div>
        <div><dt>{tx('源码提交', 'Source commit')}</dt><dd><code>{saved.trial.target.ref.commit}</code></dd></div><div><dt>{tx('成果版本', 'Release')}</dt><dd><code>{saved.trial.release.assetId}@{saved.trial.release.version}</code></dd></div></dl>
      {saved.trial.argumentNotes && <RichProse text={saved.trial.argumentNotes} />}{saved.trial.missingPremises && <RichProse text={saved.trial.missingPremises} />}
      <details open data-trial-frozen-source><summary>{tx('当时保存的完整候选', 'Complete candidate saved at the time')}</summary><pre class="research-block-code"><code>{saved.trial.source}</code></pre></details>
      {saved.trial.check && <details open data-trial-frozen-receipt><summary>{tx('固定检查回执', 'Fixed check receipt')} · {saved.trial.check.receiptId.slice(0, 12)}</summary>
        <p>{stamp(saved.trial.check.receipt.checkedAt)} · {tx('仅检查这个候选目标', 'Checks this candidate goal only')}</p><pre class="research-block-code"><code>{JSON.stringify(saved.trial.check.receipt, null, 2)}</code></pre></details>}
      <details><summary>{tx('当时使用的固定库与依赖', 'Fixed library and dependencies used at the time')}</summary>
        {[...saved.libraryPack.modules, ...saved.dependencySources].map((file, index) => <details key={`${index}:${file.file}`}><summary>{file.file}</summary><pre class="research-block-code"><code>{file.source}</code></pre></details>)}</details>
      <div class="research-actions">{saved.current && <a class="button" data-resume-trial href={`library.html?${new URLSearchParams({ entry: saved.trial.release.assetId, version: saved.trial.release.version, trial: saved.trial.id })}`}>{tx('回到试用编辑器', 'Return to the trial editor')}</a>}
        {!saved.current && <a class="button" data-reprepare-trial href={`library.html?${new URLSearchParams({ entry: saved.trial.release.assetId, version: saved.trial.release.version, run: saved.trial.target.ref.runId, task: saved.trial.target.ref.taskId,
          ...(saved.trial.target.ref.projectId ? { project: saved.trial.target.ref.projectId } : {}) })}`}>{tx('为当前目标准备新的试用', 'Prepare a new trial for the current goal')}</a>}</div>
      <PersonalTrialAttempt trial={saved.trial} history={saved} />
    </>}
  </section>;
}
