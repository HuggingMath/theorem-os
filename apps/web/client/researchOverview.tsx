import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { WebRun } from '../shared';
import type { WebFormalization } from '../formalizationTypes';
import type { WebConversationSummary } from '../conversationTypes';
import type { ResearchOverviewData } from '../researchOverviewTypes';
import { failureGuide, isAcceptedRun, resultDescription, runProgress, stoppedLabel } from '../presentation';
import { summarizeGoals, summarizeStuck } from '../report';
import type { WebApi } from './collaborationUi';
import { locale } from '../i18n';
import { Rich, RichProse } from './richText';
import { buildResearchOverview, overviewProjectHref, type ResearchOverviewAction } from './researchOverviewModel';

export type ResearchOverviewProps = {
  owner: string; runs: readonly WebRun[]; conversations: readonly WebConversationSummary[]; formalizations: readonly WebFormalization[];
  request: WebApi; onOpenRun(id: string): void; onOpenConversation(id: string): void;
};
const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
const actionLabel = (kind: ResearchOverviewAction['kind']) => ({ statement: tx('确认题意', 'Review statement'), research: tx('继续研究', 'Continue research'), plan: tx('审阅计划', 'Review plan'),
  feedback: tx('处理反馈', 'Review feedback'), update: tx('查看更新', 'View update') })[kind];
const primary = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
const date = (value: string) => { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString(locale === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric' }) : value; };
const runLabel = (run: WebRun) => isAcceptedRun(run) ? tx('原题已验收', 'Original problem accepted') : run.status === 'running' ? runProgress(run).phaseLabel
  : run.status === 'queued' ? tx('排队中', 'Queued') : run.status === 'cancelled' ? tx('已取消', 'Cancelled') : run.status === 'error' ? tx('运行错误', 'Run error') : stoppedLabel(run);
function progress(run: WebRun): string {
  const goals = summarizeGoals(run), stuck = summarizeStuck(run)?.tasks[0], guide = failureGuide(run);
  const count = goals ? tx(`${goals.proved + goals.checked}/${goals.goals.length + goals.omitted} 个目标已有证明或检查结果`, `${goals.proved + goals.checked}/${goals.goals.length + goals.omitted} goals have a proof or check result`) : '';
  const blocker = stuck ? `${stuck.theorem || stuck.id}${tx('：', ': ')}${stuck.failure || stuck.blockers[0] || stuck.feedback || stuck.status}` : guide?.title;
  return [count, blocker || resultDescription(run)].filter(Boolean).join(' · ');
}

export function ResearchOverview(props: ResearchOverviewProps) {
  const [research, setResearch] = useState<ResearchOverviewData>(), [error, setError] = useState(''), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<'all' | 'waiting' | 'active' | 'passed'>('all');
  useEffect(() => {
    let live = true; const controller = new AbortController();
    setLoading(true); setError('');
    props.request<ResearchOverviewData>('/api/research/overview', { signal: controller.signal }).then(value => { if (live) setResearch(value); })
      .catch(cause => { if (live && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : tx('研究项目暂时无法读取。', 'Research projects could not be loaded.')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, [props.owner, props.request, revision]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') setRevision(value => value + 1); };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [props.owner]);
  const model = buildResearchOverview({ ...props, research });
  const open = (event: MouseEvent, target: { runId?: string; conversationId?: string }) => {
    if (!primary(event)) return;
    if (target.conversationId) { event.preventDefault(); props.onOpenConversation(target.conversationId); }
    else if (target.runId) { event.preventDefault(); props.onOpenRun(target.runId); }
  };
  const normalized = query.trim().toLocaleLowerCase();
  const cards = model.cards.filter(card => (!normalized || [card.title, card.project?.description, ...card.runs.map(run => `${run.title}\n${run.task}\n${run.source}`), ...card.conversations.map(item => item.title)].join('\n').toLocaleLowerCase().includes(normalized))
    && (filter === 'all' || filter === 'waiting' && card.actions.length > 0 || filter === 'active' && (card.runs.some(run => ['running', 'queued'].includes(run.status)) || card.formalizations.some(record => ['running', 'queued'].includes(record.status)))
      || filter === 'passed' && card.runs.some(isAcceptedRun)));
  return <section class="research-overview" data-research-overview aria-label={tx('我的研究', 'My research')}>
    <header class="research-overview-heading"><div><p>{tx('继续研究', 'Continue your research')}</p><h2>{tx('我的研究', 'My research')}</h2></div>
      <a href="theorems.html" class="text-button">{tx('定理与协作者', 'Theorems and collaborators')} ↗</a></header>
    {model.actions.length > 0 && <section class="research-overview-inbox" data-overview-inbox aria-label={tx('待我处理', 'Needs your attention')}>
      <h3>{tx('待我处理', 'Needs your attention')} <span>{model.actions.length}</span></h3><ul>{model.actions.map(action => <li key={action.id}>
        <a href={action.href} data-overview-action={action.id} onClick={event => open(event, action)}><span>{actionLabel(action.kind)}</span><strong><Rich text={action.title} /></strong><span aria-hidden="true">→</span></a>
      </li>)}</ul></section>}
    {model.cards.length > 0 && <div class="research-overview-tools"><label><span class="sr-only">{tx('搜索我的研究', 'Search my research')}</span><input type="search" data-overview-search value={query}
      placeholder={tx('搜索题目、定理或对话', 'Find a problem, theorem or conversation')} onInput={event => setQuery(event.currentTarget.value)} /></label>
      <div role="group" aria-label={tx('研究状态', 'Research status')}>{(['all', 'waiting', 'active', 'passed'] as const).map(value => <button type="button" key={value}
        aria-pressed={filter === value} data-overview-filter={value} onClick={() => setFilter(value)}>{({ all: tx('全部', 'All'), waiting: tx('待处理', 'Needs attention'), active: tx('进行中', 'Active'), passed: tx('已通过', 'Verified') })[value]}</button>)}</div></div>}
    {error && <p class="research-overview-error" role="alert">{error} <button type="button" class="text-button" onClick={() => setRevision(value => value + 1)}>{tx('重新读取', 'Try again')}</button></p>}
    {loading && !research && <p role="status" class="research-overview-note">{tx('正在读取协作项目…', 'Loading shared projects…')}</p>}
    <div class="research-overview-cards">{cards.map(card => {
      const latest = card.runs[0], conversation = card.conversations[0];
      const projectRun = card.project?.runs[0];
      const action = card.actions[0];
      const target = action ?? (latest ? { runId: latest.id } : conversation ? { conversationId: conversation.id } : {});
      const href = action?.href ?? (latest ? `?run=${encodeURIComponent(latest.id)}` : conversation ? `?chat=${encodeURIComponent(conversation.id)}`
        : card.project ? overviewProjectHref(card.project.id, projectRun?.runId, projectRun?.statementVersionId) : card.formalizations[0] ? `formalize.html?id=${encodeURIComponent(card.formalizations[0].id)}` : './');
      const naturalStatement = card.formalizations[0]?.original ?? latest?.formalization?.original ?? card.project?.versions.at(-1)?.statement;
      const statement = naturalStatement ?? latest?.source;
      return <article class="research-overview-card" key={card.id} data-overview-card={card.id}>
        <div class="research-overview-meta"><span>{card.project ? tx('定理项目', 'Theorem project') : card.runs.length ? tx('研究题目', 'Research problem') : tx('对话与题意', 'Conversation and statement')}</span><time dateTime={card.updatedAt}>{date(card.updatedAt)}</time></div>
        <h3><a href={href} title={card.title} onClick={event => open(event, target)}><Rich text={card.title} /></a></h3>
        <p class="research-overview-summary">{card.project ? `${card.project.versions.length} ${tx('个陈述版本', 'statement versions')} · ${card.project.runs.length} ${tx('次研究', 'research runs')}`
          : `${card.runs.length} ${tx('次研究', 'research runs')} · ${card.conversations.length} ${tx('段对话', 'conversations')}`}</p>
        {latest && <p class="research-overview-progress" data-overview-progress={latest.id}>{progress(latest)}</p>}
        <div class="research-overview-card-actions"><a class="button" href={href} onClick={event => open(event, target)}>{card.actions.length ? tx('继续处理', 'Continue') : tx('打开研究', 'Open research')} →</a>
          {latest && <span data-overview-run-status={latest.id}>{runLabel(latest)}</span>}
          {card.project && latest && <a class="text-button" href={overviewProjectHref(card.project.id)}>{tx('协作与版本', 'Collaboration and versions')}</a>}</div>
        {(card.runs.length > 0 || card.conversations.length > 0 || Boolean(card.project?.runs.length)) && <details><summary>{tx('历次研究与对话', 'Runs and conversations')}</summary><ul class="research-overview-records">
          {card.project?.runs.map(binding => <li key={`bound:${binding.runId}`}><a href={overviewProjectHref(card.project!.id, binding.runId, binding.statementVersionId)}><Rich text={binding.title} /></a><span>{`v${card.project!.versions.findIndex(version => version.id === binding.statementVersionId) + 1}`}</span></li>)}
          {card.runs.filter(run => !card.project?.runs.some(binding => binding.runId === run.id)).map(run => <li key={run.id}><a href={`?run=${encodeURIComponent(run.id)}`} onClick={event => open(event, { runId: run.id })}><Rich text={run.title} /></a><span>{runLabel(run)}</span></li>)}
          {card.conversations.map(item => <li key={item.id}><a href={`?chat=${encodeURIComponent(item.id)}`} onClick={event => open(event, { conversationId: item.id })}><Rich text={item.title} /></a><span>{tx('对话', 'Conversation')}</span></li>)}</ul></details>}
        {statement && <details class="research-overview-statement"><summary>{tx('查看原题', 'Read the original statement')}</summary>{naturalStatement ? <RichProse text={statement} /> : <pre>{statement}</pre>}</details>}
      </article>;
    })}</div>
    {!cards.length && !loading && <p class="research-overview-note">{normalized || filter !== 'all' ? tx('没有匹配的研究。', 'No matching research.') : tx('第一道题的对话、研究和后续版本会保存在这里。', 'Your first problem, research runs and later versions will appear here.')}</p>}
  </section>;
}

export function renderResearchOverview(root: HTMLElement, props: ResearchOverviewProps) { render(<ResearchOverview key={props.owner} {...props} />, root); }
