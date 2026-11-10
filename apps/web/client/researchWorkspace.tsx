import { statementConfirmation } from '../presentation';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ResearchBrief, ResearchSearchKind, ResearchSearchResult, ResearchTokenRate, ResearchUsageLedger } from '../researchWorkspaceTypes';
import type { ResearchBookmarkTarget } from '../researchCollectionTypes';
import { workbenchReturn } from '../shared';
import { locale } from '../i18n';
import { formatTokens, readableDuration } from '../presentation';
import { Rich, RichProse } from './richText';
import { CollaborationInbox } from './collaborationFlow';
import { BookmarkControl, CollectionsPanel } from './researchCollections';
import { AssetUpdatesPanel } from './researchReleaseComparison';
import { downloadResearchFile, researchBriefMarkdown } from './researchBriefExport';
import { loadMath } from './mathAssets';
import { briefFontUsage, embedBriefFonts } from './researchBriefFonts';
import { ResearchHistoryReader } from './researchHistory';
import { PersonalDraftsPanel } from './researchPersonal';
import { LibraryTrialHistory } from './researchLibraryTrialHistory';
import { ProductStatusPanel } from './productStatus';
import { base, enc, Empty, ErrorBox, MutationState, nameOf, Panel, State, stamp, tx, useMutation, useResource,
  type Item, type ResearchContext } from './researchShared';

const tabs = {
  inbox: tx('我的待办', 'My inbox'), search: tx('全局搜索', 'Search'), usage: tx('用量账本', 'Usage'),
  brief: tx('研究简报', 'Research briefs'), collections: tx('专题资料夹', 'Collections'),
  drafts: tx('账号草稿', 'Account drafts'), trials: tx('Library 试用', 'Library trials'), help: tx('帮助与版本', 'Help and version'),
} as const;
type Tab = keyof typeof tabs;
const readTab = (): Tab => {
  const value = new URLSearchParams(location.search).get('tab') ?? '';
  return value in tabs ? value as Tab : 'inbox';
};
const kinds: Record<ResearchSearchKind, string> = {
  problem: tx('题目', 'Problems'), conversation: tx('对话', 'Conversations'), lemma: tx('定理与引理', 'Theorems and lemmas'),
  route: tx('研究路线', 'Routes'), library: 'Library',
  history: tx('历史推导与检查', 'Historical reasoning and checks'), decision: tx('讨论与评审', 'Discussions and reviews'), stage: tx('阶段结论', 'Stage conclusions'),
};
export function WorkspacePage({ context }: { context: ResearchContext }) {
  const [tab, setTab] = useState<Tab>(readTab);
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const back = () => setTab(readTab()); window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  useEffect(() => {
    const nav = navigation.current, selected = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !selected) return;
    const bounds = nav.getBoundingClientRect(), current = selected.getBoundingClientRect();
    if (current.left < bounds.left) nav.scrollLeft += current.left - bounds.left;
    else if (current.right > bounds.right) nav.scrollLeft += current.right - bounds.right;
  }, [tab]);
  useEffect(() => { if (location.hash === '#asset-updates') requestAnimationFrame(() => document.getElementById('asset-updates')?.scrollIntoView({ block: 'start' })); }, [tab]);
  const choose = (next: Tab) => {
    const url = new URL(location.href); url.searchParams.set('tab', next); url.hash = '';
    history.pushState(null, '', url); setTab(next);
  };
  const loginParameters = new URLSearchParams(location.search);
  loginParameters.set('returnTo', 'workspace'); loginParameters.set('tab', tab); loginParameters.set('lang', locale);
  return <div class="workspace-page" data-workspace-page>
    <header class="workspace-heading"><div><p class="research-eyebrow">TheoremOS</p><h1>{tx('我的研究空间', 'My research space')}</h1>
      <p>{tx('接着处理待办，找回线索，整理研究结果。', 'Pick up a task, find a lead, or bring your research together.')}</p></div>
      <div class="research-actions"><a class="button" href={`practice.html?lang=${locale}`}>{tx('参与演练', 'Try the practice')}</a><a class="button button-primary" href="./">{tx('开始研究', 'Start research')}</a></div>
    </header>
    <nav ref={navigation} class="workspace-tabs" aria-label={tx('个人研究工具', 'Personal research tools')}>
      {Object.entries(tabs).map(([id, label]) => <a key={id} href={`workspace.html?tab=${id}`} aria-current={tab === id ? 'page' : undefined}
        onClick={event => { if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); choose(id as Tab); }}>{label}</a>)}
    </nav>
    {tab === 'help' ? <ProductStatusPanel /> : !context.session.authenticated ? <Panel title={tx('登录后继续你的研究', 'Sign in to continue your research')}>
      <p>{tx('待办、搜索、用量和资料夹保存在你的账号中。', 'Your inbox, search, usage and collections belong to your account.')}</p>
      <div class="research-actions"><a class="button button-primary" href={`login.html${workbenchReturn(loginParameters.toString())}`}>{tx('登录', 'Sign in')}</a>
        <a href={`practice.html?lang=${locale}`}>{tx('先体验一次完整参与流程', 'Try the participation flow first')}</a></div></Panel>
      : <div class="workspace-content" key={tab}>{tab === 'inbox' ? <><CollaborationInbox context={context} /><AssetUpdatesPanel context={context} /></>
        : tab === 'search' ? <WorkspaceSearch context={context} /> : tab === 'usage' ? <WorkspaceUsage context={context} />
          : tab === 'brief' ? <WorkspaceBrief context={context} /> : tab === 'drafts' ? <PersonalDraftsPanel context={context} /> : tab === 'trials' ? <LibraryTrialHistory context={context} /> : <><SaveIncomingTarget context={context} /><CollectionsPanel context={context} /></>}</div>}
  </div>;
}
function SaveIncomingTarget({ context }: { context: ResearchContext }) {
  const parameters = new URLSearchParams(location.search), runId = parameters.get('saveRun');
  if (!runId) return null;
  const taskId = parameters.get('task'), taskVersion = parameters.get('taskVersion'), commit = parameters.get('commit');
  const projectId = parameters.get('project') ?? undefined;
  const target: ResearchBookmarkTarget = taskId && taskVersion && commit ? { kind: 'task', runId, taskId, taskVersion, commit, ...(projectId ? { projectId } : {}) }
    : { kind: 'run', runId, ...(projectId ? { projectId } : {}) };
  return <Panel title={tx('保存这份研究材料', 'Save this research material')}><p>{taskId ?? runId}</p><BookmarkControl context={context} target={target} /></Panel>;
}

function WorkspaceSearch({ context }: { context: ResearchContext }) {
  const parameters = new URLSearchParams(location.search);
  const [draft, setDraft] = useState(parameters.get('q') ?? ''), [query, setQuery] = useState(draft);
  const initialKind = parameters.get('kind') ?? '';
  const [kind, setKind] = useState<ResearchSearchKind | ''>(initialKind in kinds ? initialKind as ResearchSearchKind : ''), [offset, setOffset] = useState(0);
  const data = useResource<ResearchSearchResult>(query ? `${base}/workspace/search?${new URLSearchParams({ q: query, kind, offset: String(offset) })}` : undefined);
  const record = parameters.get('record');
  const historyId = parameters.get('history');
  const saved = useResource<Item<{ name: string; type: string; description: string; declaration: string; premises: string[] }>>(record ? `${base}/workspace/knowledge/${enc(record)}` : undefined);
  const submit = () => {
    const value = draft.trim(); setOffset(0); setQuery(value);
    const url = new URL(location.href); if (value) url.searchParams.set('q', value); else url.searchParams.delete('q');
    url.searchParams.delete('record'); url.searchParams.delete('history'); history.replaceState(null, '', url); data.refresh();
  };
  const chooseKind = (next: ResearchSearchKind | '') => {
    setKind(next); setOffset(0); const url = new URL(location.href);
    if (next) url.searchParams.set('kind', next); else url.searchParams.delete('kind');
    history.replaceState(null, '', url);
  };
  return <>{historyId && <ResearchHistoryReader id={historyId} context={context} />}<Panel title={tx('搜索研究记录', 'Search your research')} note={tx('查找题目、对话、历史推导、评审意见、阶段结论和 Library。', 'Find problems, conversations, historical reasoning, reviews, stage conclusions and Library releases.')}>
    <form class="workspace-search" role="search" onSubmit={event => { event.preventDefault(); submit(); }}>
      <label class="sr-only" htmlFor="workspace-query">{tx('关键词', 'Keywords')}</label><input id="workspace-query" type="search" value={draft} maxLength={128}
        placeholder={tx('输入定理名、推导中的一句话或一个数学概念', 'A theorem name, a phrase from a derivation, or a mathematical concept')}
        onInput={event => setDraft(event.currentTarget.value)} /><button class="button button-primary" type="submit">{tx('搜索', 'Search')}</button>
    </form>
    <div class="workspace-filters" role="group" aria-label={tx('结果类型', 'Result type')}>
      <button type="button" class="text-button" aria-pressed={!kind} onClick={() => chooseKind('')}>{tx('全部', 'All')}</button>
      {Object.entries(kinds).map(([id, label]) => <button type="button" key={id} class="text-button" aria-pressed={kind === id}
        onClick={() => chooseKind(id as ResearchSearchKind)}>{label}{data.data ? ` (${data.data.counts[id as ResearchSearchKind]})` : ''}</button>)}
    </div>
    <ErrorBox message={data.error} />{data.error && <button type="button" class="button" onClick={data.refresh}>{tx('重新读取', 'Try again')}</button>}
    {data.loading && <p role="status">{tx('正在查找…', 'Searching…')}</p>}
    {data.data && <><p class="workspace-result-count" role="status">{tx(`找到 ${data.data.total} 条记录`, `${data.data.total} results`)}{offset ? ` · ${offset + 1}–${offset + data.data.items.length}` : ''}</p>
      <div class="workspace-results">{data.data.items.map(item => <article key={item.id} class="workspace-result">
        <div class="workspace-result-meta"><span>{kinds[item.kind]}</span><span><Rich text={item.context} /></span>{item.updatedAt && <time dateTime={item.updatedAt}>{stamp(item.updatedAt)}</time>}</div>
        <h3><a href={item.href}><Rich text={item.title} /></a></h3><RichProse text={item.excerpt} />
        {item.version && <details><summary>{tx('版本', 'Version')}</summary><code>{item.version}</code></details>}
      </article>)}</div>
      {!data.data.items.length && <Empty>{tx('没有找到匹配记录，试试更短的关键词或其他结果类型。', 'No matches. Try a shorter phrase or another result type.')}</Empty>}
      <div class="research-actions">{offset > 0 && <button class="button" type="button" onClick={() => setOffset(Math.max(0, offset - 40))}>{tx('上一页', 'Previous')}</button>}
        {data.data.nextOffset !== undefined && <button class="button" type="button" onClick={() => setOffset(data.data!.nextOffset!)}>{tx('下一页', 'Next')}</button>}</div>
    </>}
    {!query && <Empty>{tx('输入关键词，从你有权查看的记录中查找。', 'Enter a query to search the records you can access.')}</Empty>}
    <ErrorBox message={saved.error} />{saved.data && <section class="workspace-saved-lemma"><h3>{saved.data.item.name}</h3><RichProse text={saved.data.item.description} />
      <RichProse text={saved.data.item.type} /><pre><code>{saved.data.item.declaration}</code></pre></section>}
  </Panel></>;
}

const stages = { formalization: tx('形式化', 'Formalization'), proof: tx('证明研究', 'Proof research'), explanation: tx('证明讲解', 'Proof explanation') } as const;
export const evidenceStatus = (status: string) => ({ accepted: tx('验收通过', 'Accepted'), confirmed: tx('已确认', 'Confirmed'),
  approved: tx('审核通过', 'Approved'), checked: tx('检查通过', 'Checked'), applied: tx('已应用', 'Applied'), recorded: tx('已记录', 'Recorded'),
  goal: tx('原题目标', 'Original goal'), lemma: tx('辅助引理', 'Helper lemma'), research: tx('研究任务', 'Research task'), sketch: tx('证明思路', 'Proof sketch'),
  evaluated_passed: tx('完整原题验收通过', 'Full problem accepted'), limit_reached: tx('达到预算后结束', 'Stopped at the budget limit'),
  evaluated_failed: tx('验收未通过', 'Acceptance failed'), evaluated_rejected: tx('验收未通过', 'Acceptance failed'),
} as Record<string, string>)[status] ?? nameOf(status);
function EvidenceState({ value }: { value: string }) { return <span class="research-state" data-state={value}>{evidenceStatus(value)}</span>; }
function WorkspaceUsage({ context }: { context: ResearchContext }) {
  const data = useResource<ResearchUsageLedger>(`${base}/workspace/usage`, 15_000);
  const [filter, setFilter] = useState(new URLSearchParams(location.search).get('run') ?? '');
  return <><Panel title={tx('整道题的用量', 'Usage across the whole problem')}
    note={tx('形式化、历次证明和讲解分别记账。同一道题的共享运行只计一次。', 'Formalization, proof attempts and explanations are counted separately. Shared runs are counted once.')}>
    <ErrorBox message={data.error} />{data.error && <button type="button" class="button" onClick={data.refresh}>{tx('重新读取', 'Try again')}</button>}
    {data.loading && <p role="status">{tx('正在汇总…', 'Loading usage…')}</p>}
    {data.data && <><div class="workspace-metrics"><div><strong>{formatTokens(data.data.knownTokens)}</strong><span>{tx('已记录 Token', 'Recorded tokens')}</span></div>
      <div><strong>{data.data.entryCount}</strong><span>{tx('阶段记录', 'Stage records')}</span></div><div><strong>{data.data.missingEntries}</strong><span>{tx('尚无用量记录', 'Usage unavailable')}</span></div></div>
      {data.data.estimates.length > 0 && <p class="workspace-estimate">{tx('按你填写的单价估算', 'Estimate using your rates')}: {data.data.estimates.map(item => `${item.currency} ${item.amount.toFixed(4)}`).join(' · ')}
        {` · ${data.data.unpricedEntries} ${tx('条记录未计价', 'unpriced records')}`}</p>}
      <p class="research-field-note">{tx('缺失用量不计为 0。金额使用你填写的综合单价估算，供应商账单以实际计费为准。共享运行只展示证明阶段用量。',
        'Missing usage is not zero. Cost uses the blended rate you enter; your provider’s bill is authoritative. Shared runs include proof-stage usage only.')}</p>
      <label class="workspace-select">{tx('题目', 'Problem')}<select value={filter} onChange={event => setFilter(event.currentTarget.value)}><option value="">{tx('全部题目', 'All problems')}</option>
        {data.data.groups.map(group => <option key={group.id} value={group.id}>{group.title}</option>)}</select></label>
      {data.data.groups.filter(group => !filter || group.id === filter || group.entries.some(entry => entry.id === `proof:${filter}`)).map(group => <section class="workspace-usage-group" key={group.id}>
        <header><h3><a href={group.href}><Rich text={group.title} /></a></h3><p>{formatTokens(group.knownTokens)} Token · {group.attempts} {tx('次证明研究', 'proof attempts')} · {group.acceptedAttempts} {tx('次验收通过', 'accepted')}</p></header>
        <div class="workspace-table-scroll" tabIndex={0} aria-label={tx('分阶段用量', 'Usage by stage')}><table class="workspace-table"><thead><tr>
          {[tx('阶段', 'Stage'), tx('模型', 'Model'), 'Token', tx('记录时长', 'Elapsed time'), tx('状态', 'Status'), tx('金额估算', 'Estimated cost')].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{group.entries.map(entry => <tr key={entry.id}><td><a href={entry.href}>{stages[entry.stage]}</a>{entry.shared && <small>{tx('共享记录', 'Shared record')}</small>}<small>{stamp(entry.startedAt)}</small></td>
            <td>{entry.model}{entry.providerId && <small>{entry.providerId}</small>}</td><td>{entry.tokens === null ? tx('未记录', 'Unavailable') : formatTokens(entry.tokens)}
              {entry.tokenLimit && <small>{tx('上限', 'Limit')} {formatTokens(entry.tokenLimit)}</small>}</td><td>{entry.durationMs === null ? '—' : readableDuration(entry.durationMs)}</td>
            <td><EvidenceState value={entry.status} /></td><td>{entry.estimate ? `≈ ${entry.estimate.currency} ${entry.estimate.amount.toFixed(4)}` : '—'}</td></tr>)}</tbody></table></div>
      </section>)}
      {!data.data.groups.length && <Empty>{tx('开始一次研究后，用量会随记录更新。', 'Usage will appear after you start a research task.')}</Empty>}
    </>}
  </Panel>{data.data && <UsageRates ledger={data.data} context={context} onSave={data.refresh} />}</>;
}
function UsageRates({ ledger, context, onSave }: { ledger: ResearchUsageLedger; context: ResearchContext; onSave(): void }) {
  const entries = ledger.groups.flatMap(group => group.entries), models = [...new Map(entries.filter(entry => entry.providerId)
    .map(entry => [`${entry.providerId}/${entry.model}`, { providerId: entry.providerId!, model: entry.model }])).values()];
  const [selected, setSelected] = useState(0), [rate, setRate] = useState(''), [currency, setCurrency] = useState<'CNY' | 'USD'>('CNY');
  const action = useMutation(), model = models[selected];
  const saved = ledger.rates.find(rate => rate.providerId === model?.providerId && rate.model === model.model);
  return <Panel title={tx('模型单价', 'Model rates')}><details><summary>{tx('填写综合单价，查看金额估算', 'Enter a blended rate to estimate cost')}</summary>
    {models.length ? <form class="research-form" onSubmit={event => { event.preventDefault(); if (model) void action.run<Item<ResearchTokenRate>>('PUT', `${base}/workspace/rates`,
      { ...model, currency, perMillion: Number(rate) }, () => { setRate(''); onSave(); }); }}>
      <label>{tx('模型与服务商', 'Model and provider')}<select value={selected} onChange={event => { setSelected(Number(event.currentTarget.value)); setRate(''); }}>
        {models.map((model, index) => <option key={`${model.providerId}/${model.model}`} value={index}>{model.model} · {model.providerId}</option>)}</select></label>
      {saved && <p>{tx('已保存', 'Saved')}: {saved.currency} {saved.perMillion} / {tx('百万 Token', 'million tokens')}</p>}
      <div class="research-form-row"><label>{tx('每百万 Token 综合单价', 'Blended price per million tokens')}<input type="number" step="any" min="0" max="1000000" value={rate} onInput={event => setRate(event.currentTarget.value)} required /></label>
        <label>{tx('币种', 'Currency')}<select value={currency} onChange={event => setCurrency(event.currentTarget.value as 'CNY' | 'USD')}><option value="CNY">CNY</option><option value="USD">USD</option></select></label></div>
      <button class="button" type="submit" disabled={action.busy || !context.session.authenticated || !rate || !Number.isFinite(Number(rate)) || Number(rate) < 0}>{tx('保存单价', 'Save rate')}</button><MutationState action={action} />
    </form> : <Empty>{tx('有模型用量记录后，可以填写单价。', 'Rates can be set once a model appears in your records.')}</Empty>}
  </details></Panel>;
}

function WorkspaceBrief({ context }: { context: ResearchContext }) {
  const params = new URLSearchParams(location.search), [selected, setSelected] = useState(params.get('run') ?? ''), [projectId, setProjectId] = useState(params.get('project') ?? '');
  const ledger = useResource<ResearchUsageLedger>(`${base}/workspace/usage`);
  const options = ledger.data?.groups.flatMap(group => group.entries.filter(entry => entry.stage === 'proof').map(entry => ({ entry, group }))) ?? [];
  const data = useResource<Item<ResearchBrief>>(selected ? `${base}/workspace/brief/${enc(selected)}${projectId ? `?project=${enc(projectId)}` : ''}` : undefined);
  const choose = (runId: string) => {
    const href = options.find(option => option.entry.id === `proof:${runId}`)?.entry.href;
    const project = href?.startsWith('theorems.html') ? new URL(href, location.href).searchParams.get('id') ?? '' : '';
    setSelected(runId); setProjectId(project);
    const url = new URL(location.href); url.searchParams.set('run', runId); if (project) url.searchParams.set('project', project); else url.searchParams.delete('project');
    history.replaceState(null, '', url);
  };
  return <><Panel title={tx('研究简报', 'Research briefs')} note={tx('把问题、历次尝试、证明路线和人工决定整理成一份可交付的记录。', 'Bring the problem, attempts, proof route and human decisions into one deliverable.')}>
    <ErrorBox message={ledger.error} />{ledger.error && <button class="button" type="button" onClick={ledger.refresh}>{tx('重新读取', 'Try again')}</button>}
    {options.length > 0 && <label class="workspace-select">{tx('选择研究记录', 'Choose a research run')}<select value={selected} onChange={event => choose(event.currentTarget.value)}>
      <option value="">{tx('选择一次研究…', 'Choose a run…')}</option>{options.map(({ entry }) => <option key={entry.id} value={entry.id.slice(6)}>{entry.title} · {evidenceStatus(entry.status)} · {stamp(entry.startedAt)}</option>)}</select></label>}
    {!ledger.loading && !options.length && !selected && <Empty>{tx('你自己的或项目中的研究记录会显示在这里。', 'Your own and your projects’ research records will appear here.')}</Empty>}
    {!selected && options.length > 0 && <Empty>{tx('选择一次研究，即可预览和导出简报。', 'Choose a run to preview and export its brief.')}</Empty>}
    {data.loading && <p role="status">{tx('正在整理研究记录…', 'Preparing the brief…')}</p>}<ErrorBox message={data.error} />
    {data.error && <button class="button" type="button" onClick={data.refresh}>{tx('重新读取', 'Try again')}</button>}
  </Panel>{data.data && <BriefPreview brief={data.data.item} context={context} />}</>;
}

export function BriefPreview({ brief, context }: { brief: ResearchBrief; context: ResearchContext }) {
  const article = useRef<HTMLElement>(null), [error, setError] = useState(''), [exporting, setExporting] = useState(false);
  const exportHtml = async () => {
    if (exporting) return; setExporting(true); setError('');
    try {
      await loadMath();
      // Let already-mounted Rich formulas finish rendering before taking the standalone document.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const sheets = await Promise.all(['app.css', 'research.css', 'assets/katex/katex.min.css'].map(async href => {
        const response = await fetch(href); if (!response.ok) throw new Error(tx('导出样式未能读取，请重试。', 'Export styles could not be loaded. Please retry.'));
        return { css: await response.text(), url: new URL(href, location.href).href };
      }));
      const copy = article.current!.cloneNode(true) as HTMLElement; copy.querySelectorAll('[data-brief-controls],details.research-bookmark-control').forEach(element => element.remove());
      copy.querySelectorAll('details').forEach(details => details.open = true);
      copy.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => anchor.href = new URL(anchor.getAttribute('href')!, location.href).href);
      const preview = document.createElement('div');
      preview.className = 'research-page'; preview.setAttribute('aria-hidden', 'true');
      Object.assign(preview.style, { position: 'fixed', left: '-10000px', top: '0', width: `${article.current!.getBoundingClientRect().width}px`, pointerEvents: 'none' });
      preview.append(copy); document.body.append(preview);
      let embedded: string[];
      try {
        embedded = await embedBriefFonts(sheets, briefFontUsage(copy), async url => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(tx('导出字体未能读取，请重试。', 'Export fonts could not be loaded. Please retry.'));
          const blob = await response.blob();
          return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(new Blob([blob], { type: 'font/woff2' }));
          });
        });
      } finally { preview.remove(); }
      const documentCopy = document.implementation.createHTMLDocument(brief.title); documentCopy.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
      const charset = documentCopy.createElement('meta'); charset.setAttribute('charset', 'utf-8'); documentCopy.head.prepend(charset);
      const meta = documentCopy.createElement('meta'); meta.name = 'viewport'; meta.content = 'width=device-width, initial-scale=1'; documentCopy.head.append(meta);
      const style = documentCopy.createElement('style'); style.textContent = embedded.join('\n')
        + '\nbody{display:block;margin:0;padding:40px;background:#fff;color:#222}.workspace-brief{max-width:920px;margin:auto}.topbar{display:none}@media(max-width:700px){body{padding:16px}}@media print{body{padding:0}}';
      documentCopy.head.append(style); documentCopy.body.className = 'research-page'; documentCopy.body.append(documentCopy.importNode(copy, true));
      downloadResearchFile(`theoremos-brief-${brief.selectedRunId}.html`, `<!doctype html>\n${documentCopy.documentElement.outerHTML}`, 'text/html;charset=utf-8');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setExporting(false); }
  };
  const taskName = (id: string) => brief.tasks.find(task => task.id === id)?.title ?? id;
  return <article ref={article} class="workspace-brief" data-research-brief>
    <div class="workspace-brief-controls research-actions" data-brief-controls><button class="button" type="button" onClick={() => downloadResearchFile(`theoremos-brief-${brief.selectedRunId}.md`, researchBriefMarkdown(brief, locale, location.origin), 'text/markdown;charset=utf-8')}>Markdown</button>
      <button class="button" type="button" onClick={() => void exportHtml()} disabled={exporting}>{exporting ? tx('正在导出…', 'Exporting…') : 'HTML'}</button>
      <button class="button" type="button" onClick={() => window.print()}>{tx('打印 / 存为 PDF', 'Print / Save as PDF')}</button><a href={brief.runHref}>{tx('回到研究', 'Open research')}</a>
      <a href={`problem.html?${new URLSearchParams({ run: brief.selectedRunId, ...(new URL(brief.runHref, location.href).searchParams.get('id') ? { project: new URL(brief.runHref, location.href).searchParams.get('id')! } : {}) })}`}>{tx('题目工作区', 'Problem workspace')}</a>
      <BookmarkControl context={context} target={{ kind: 'run', runId: brief.selectedRunId, ...(new URL(brief.runHref, location.href).searchParams.get('id') ? { projectId: new URL(brief.runHref, location.href).searchParams.get('id')! } : {}) }} /></div>
    <ErrorBox message={error} />
    <header class="workspace-brief-heading"><p class="research-eyebrow">TheoremOS · {tx('研究简报', 'Research brief')}</p><h2><Rich text={brief.title} /></h2>
      <p>{stamp(brief.generatedAt)} · {brief.environment}</p><span class="research-state" data-state={brief.accepted ? 'accepted' : 'pending'}>{brief.accepted ? brief.formalization ? tx('Lean 陈述证明通过', 'Lean statement accepted') : tx('完整原题验收通过', 'Full problem accepted') : tx('尚未通过完整原题验收', 'Full problem not accepted')}</span></header>
    <section><h3>{tx('问题', 'Problem')}</h3><RichProse text={brief.statement} />
      <details><summary>{tx('冻结的 Lean 陈述', 'Frozen Lean statement')}</summary><pre><code>{brief.leanStatement}</code></pre></details>
      {brief.formalization && <p>{statementConfirmation(brief.formalization.confirmation, false, brief.formalization.reviewMode)}</p>}
      <details><summary>{tx('冻结身份', 'Frozen identities')}</summary><dl><dt>{tx('原题源码摘要', 'Original source digest')}</dt><dd><code>{brief.sourceDigest}</code></dd>
        {brief.environmentDigest && <><dt>{tx('环境摘要', 'Environment digest')}</dt><dd><code>{brief.environmentDigest}</code></dd></>}
        {brief.formalization && <><dt>{tx('形式化证据', 'Formalization evidence')}</dt><dd><code>{brief.formalization.evidenceDigest}</code></dd></>}</dl></details>
    </section>
    <section><h3>{tx('历次尝试', 'Research attempts')}</h3><ol class="workspace-attempts">{brief.attempts.map(attempt => <li key={attempt.id}>
      <a href={attempt.href}><Rich text={attempt.title} /></a><span>{attempt.accepted ? tx('验收通过', 'Accepted') : evidenceStatus(attempt.status)}</span><time dateTime={attempt.createdAt}>{stamp(attempt.createdAt)}</time>
      {attempt.failure && <p>{tx('停止原因', 'Stop reason')}: {attempt.failure}</p>}</li>)}</ol></section>
    <section><h3>{tx('证明路线与推导', 'Proof routes and derivations')}</h3>
      {brief.routes.map(route => <div key={route.id} class="workspace-route"><strong>{route.id}</strong><p>{route.prerequisites.map(taskName).join(' + ') || '∅'} → {taskName(route.closingTaskId)} → {taskName(route.targetTaskId)}</p></div>)}
      {!brief.tasks.length && <Empty>{tx('这次研究没有保存任务路线。', 'No task route was saved for this run.')}</Empty>}
      <ol class="workspace-brief-steps">{brief.tasks.map(task => <li key={`${task.id}:${task.version}`} id={`brief-task-${task.id}`}>
        <h4><a href={task.href}><Rich text={task.title} /></a></h4><p class="workspace-step-state">{evidenceStatus(task.kind)} · {evidenceStatus(task.proofStatus)}</p>
        <RichProse text={task.objective} />{task.statement && task.statement !== task.objective && <RichProse text={task.statement} />}
        {task.dependsOn.length > 0 && <p>{tx('接在这些步骤之后', 'Depends on')}: {task.dependsOn.map((id, index) => <span key={id}>{index > 0 && ' · '}<a href={`#brief-task-${enc(id)}`}><Rich text={taskName(id)} /></a></span>)}</p>}
        {task.premises.length > 0 && <p>{tx('前提', 'Premises')}: <Rich text={task.premises.join('; ')} /></p>}
        {task.derivation && <div class="workspace-derivation"><h5>{tx('怎样推出', 'Derivation')}</h5><RichProse text={task.derivation} /></div>}
        {task.finding && <><h5>{tx('研究结论', 'Finding')}</h5><RichProse text={task.finding} /></>}
        {task.feedback && <><h5>{tx('反馈', 'Feedback')}</h5><RichProse text={task.feedback} /></>}
        <details><summary>{tx('版本与检查', 'Version and checks')} · {task.checks.length}</summary><code>{task.version}</code>{task.commit && <p><code>{task.commit}</code></p>}
          {task.checks.map(check => <p key={check.id}>{check.passed ? tx('任务检查通过', 'Task check passed') : tx('任务检查未通过', 'Task check failed')} · <code>{check.id}</code></p>)}</details>
      </li>)}</ol>
    </section>
    <section><h3>{tx('人工决定与处理', 'Human decisions and responses')}</h3>{!brief.decisions.length && <p>{tx('本次研究没有保存人工决定。', 'No human decision was recorded for this run.')}</p>}
      {brief.decisions.map(decision => <div class="workspace-decision" key={decision.id}><RichProse text={decision.kind === 'plan-edit' ? tx('计划修改', 'Plan edit') : decision.kind === 'plan-approval' ? tx('批准研究计划', 'Plan approval') : decision.text} /><p>{tx('投递', 'Delivery')}: <EvidenceState value={decision.delivery} /> · {tx('决定', 'Decision')}: <EvidenceState value={decision.decision} />
        {decision.execution && <> · {tx('执行', 'Execution')}: <State value={decision.execution} /></>}</p>{decision.reason && <RichProse text={decision.reason} />}
        {decision.evidenceRefs.length > 0 && <details><summary>{tx('依据', 'Evidence')}</summary>{decision.evidenceRefs.map(ref => <p key={ref}><code>{ref}</code></p>)}</details>}</div>)}
    </section>
    <section><h3>{tx('独立验收', 'Independent acceptance')}</h3><p>{brief.accepted && brief.formalization ? tx('Lean 陈述证明通过', 'Lean statement accepted') : evidenceStatus(brief.acceptance.status)}</p>
      <p>{tx('任务检查与完整原题的验收分别记录。', 'Task checks and full problem acceptance are recorded separately.')}</p>
      <details><summary>{tx('全部任务检查', 'All task checks')} · {brief.acceptance.checks.length}</summary>{brief.acceptance.checks.map(check => <p key={check.id}><code>{check.taskId}</code> · {check.passed ? tx('通过', 'Passed') : tx('未通过', 'Failed')} · <code>{check.id}</code></p>)}</details>
    </section>
    <section><h3>{tx('用量与成果', 'Usage and outcomes')}</h3><p>{formatTokens(brief.usage.knownTokens)} {tx('已记录 Token', 'recorded tokens')} · {brief.usage.missingEntries} {tx('条记录缺少用量', 'records without usage')}</p>
      {brief.outcomes.map(outcome => <p key={outcome.href}><a href={outcome.href}><Rich text={outcome.title} /></a><br /><code>{outcome.detail}</code></p>)}
      {!brief.outcomes.length && <p>{tx('尚未关联已发布成果。', 'No published outcome is linked yet.')}</p>}
    </section>
  </article>;
}
