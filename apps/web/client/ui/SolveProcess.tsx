import { useEffect, useState } from 'preact/hooks';
import type { WebFormalizationRoleSummary } from '../../formalizationTypes';
import { formatDuration } from '../../presentation';
import { t } from '../../i18n';
import type { RouteItem } from '../agentRoute';
import type { ProcessDetail, ProcessRow, ProcessTone, SolveProcess } from '../solveProcess';
import { ItemRow, LeanReport, itemKey, type ItemContext } from './AgentRoute';
import { Icon, Spinner } from './Icon';

/** How long the task has run: ticking while it is live, fixed once it ended. */
export function Elapsed({ from, to }: { from?: string; to?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!from || to) return;
    const timer = setInterval(() => tick(value => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [from, to]);
  if (!from) return null;
  const end = to ? Date.parse(to) : Date.now();
  return <time dateTime={from}>{formatDuration(end - Date.parse(from))}</time>;
}

const toneIcons: Record<Exclude<ProcessTone, 'active'>, string> = { done: 'circle-check', pending: 'circle', failed: 'circle-alert', stopped: 'circle-dashed', skipped: 'minus' };
const toneLabels: Record<ProcessTone, string> = { done: t('已完成'), active: t('进行中'), pending: t('未开始'), failed: t('未通过'), stopped: t('已停止'), skipped: t('已跳过') };
/** A row's state as its mark, with the word for it read out. */
export const ToneMark = ({ tone }: { tone: ProcessTone }) => <span class="solve-mark" data-tone={tone}>
  {tone === 'active' ? <Spinner /> : <Icon name={toneIcons[tone]} />}<span class="sr-only">{toneLabels[tone]}</span></span>;

/** What the reader opened and closed, per task, so polling and coming back find the same rows open. */
type Memory = { open?: boolean; rows: Map<string, boolean>; items: Set<string> };
const memories = new Map<string, Memory>();
const memoryOf = (key: string) => {
  let memory = memories.get(key);
  if (!memory) memories.set(key, memory = { rows: new Map(), items: new Set() });
  return memory;
};
type Ctx = { memory: Memory; refresh: () => void; live: boolean; wide: boolean; time: (at: string) => string; onCheck?: (id: string) => void };

const taskKinds: Record<string, string> = { prove: t('证明题'), decision: t('判断题'), construction: t('构造题') };
const sectionLabels: Record<WebFormalizationRoleSummary['sections'][number]['kind'], string> = { conclusions: t('结论'), assumptions: t('假设'),
  definitions: t('定义'), unresolved: t('待确认'), targets: t('目标'), issues: t('问题') };
function Summary({ summary }: { summary: WebFormalizationRoleSummary }) {
  return <div class="solve-summary">
    {summary.taskKind && <p>{t('题型：{0}', taskKinds[summary.taskKind] ?? summary.taskKind)}</p>}
    {summary.text && <p class="route-text" translate={false}>{summary.text}</p>}
    {summary.sections.map(section => <section key={section.kind}><h5>{sectionLabels[section.kind]}</h5>
      <ul>{section.items.map((item, index) => <li key={index} translate={false}>{item}</li>)}</ul>
      {section.omitted ? <p class="route-item-note">{t('另有 {0} 条没有显示。', section.omitted)}</p> : null}</section>)}
  </div>;
}
// A long session shows its newest actions; the rest stay one click away.
const shownItems = 60;
function Items({ items, ctx }: { items: RouteItem[]; ctx: Ctx }) {
  const [all, setAll] = useState(false);
  if (!items.length) return <p class="route-item-note">{ctx.live ? t('动作会在发生时出现在这里。') : t('没有记录具体动作。')}</p>;
  const shown = all ? items : items.slice(-shownItems), row: ItemContext = { memory: { open: ctx.memory.items }, time: ctx.time, running: ctx.live, refresh: ctx.refresh };
  return <>
    {shown.length < items.length && <p class="route-item-note">{t('更早的 {0} 条记录没有显示。', items.length - shown.length)}
      <button type="button" class="text-button" onClick={() => setAll(true)}>{t('显示全部')}</button></p>}
    <ol class="route-items solve-items">{shown.map(item => <ItemRow key={itemKey(item)} item={item} ctx={row} />)}</ol>
  </>;
}
function Detail({ detail, ctx }: { detail: ProcessDetail; ctx: Ctx }) {
  switch (detail.kind) {
    case 'note': return <p class="route-item-note solve-note">{detail.text}{detail.code && <> <code>{detail.code}</code></>}</p>;
    case 'summary': return <Summary summary={detail.summary} />;
    case 'feedback': return <>
      <pre class="solve-feedback" tabIndex={0} aria-label={t('反馈全文')} translate={false}>{detail.text}</pre>
      {detail.clipped && <p class="route-item-note">{t('内容较长，后面的部分没有显示。')}</p>}
    </>;
    case 'lean': return <LeanReport lean={detail.lean} />;
    case 'source': return <pre class="solve-feedback" tabIndex={0} aria-label={t('Lean 源码')} translate={false}>{detail.source}</pre>;
    case 'items': return <Items items={detail.items} ctx={ctx} />;
  }
}

const rowOpen = (row: ProcessRow, memory: Memory) => memory.rows.get(row.id) ?? Boolean(row.open);
function Row({ row, ctx }: { row: ProcessRow; ctx: Ctx }) {
  const open = rowOpen(row, ctx.memory), expandable = row.details.length > 0 || Boolean(row.rows?.length);
  const toggle = () => { ctx.memory.rows.set(row.id, !open); ctx.refresh(); };
  // A check opens the saved code on every screen; its other records open with the chevron.
  const jump = row.check && ctx.onCheck ? () => ctx.onCheck!(row.check!) : undefined;
  const head = <>
    <ToneMark tone={row.tone} />
    <span class="solve-row-title"><span class="solve-row-label">{row.label}</span>{row.code && <code translate={false}>{row.code}</code>}
      {row.meta && <span class="solve-row-meta">{row.meta}</span>}</span>
    <span class="solve-row-end">{row.outcome && <span class="route-item-outcome" data-tone={row.outcome.tone}>{row.outcome.text}</span>}
      {row.at && <time dateTime={row.at}>{ctx.time(row.at)}</time>}</span>
  </>;
  const id = `solve-row-${row.id.replace(/[^\w-]/gu, '_')}`;
  return <li class="solve-row" data-solve-row={row.id} data-tone={row.tone}>
    <div class="solve-row-line">
      {jump ? <button type="button" class="solve-row-head" data-solve-check={row.check} onClick={jump} title={t('查看这次 Lean 检查与代码')}>{head}</button>
        : expandable ? <button type="button" class="solve-row-head" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>{head}</button>
          : <div class="solve-row-head">{head}</div>}
      {jump && expandable && <button type="button" class="icon-button solve-row-toggle" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={open ? t('收起 {0}', row.label) : t('展开 {0}', row.label)} onClick={toggle}><Icon name={open ? 'chevron-up' : 'chevron-down'} /></button>}
    </div>
    {open && expandable && <div class="solve-row-body" id={id}>
      {row.details.map((detail, index) => <Detail key={index} detail={detail} ctx={ctx} />)}
      {row.rows?.length ? <ol class="solve-rows">{row.rows.map(child => <Row key={child.id} row={child} ctx={ctx} />)}</ol> : null}
    </div>}
  </li>;
}

export type SolveProcessProps = {
  process: SolveProcess; loading?: boolean; failed?: boolean; wide: boolean; time: (at: string) => string;
  onRetry?: () => void; onCheck?: (id: string) => void;
  defaultOpen?: boolean;
};
/**
 * The solving process under the task's status: open while the task runs, one line once it ended. Each stage lists what
 * was done in it; a row opens to the Agent's or role's actions, Lean's messages and the feedback between rounds.
 */
export function SolveProcessView(props: SolveProcessProps) {
  const { process } = props, [, setTick] = useState(0), memory = memoryOf(process.key);
  const refresh = () => setTick(value => value + 1);
  const open = memory.open ?? props.defaultOpen ?? process.active;
  const ctx: Ctx = { memory, refresh, live: process.active, wide: props.wide, time: props.time, ...(props.onCheck ? { onCheck: props.onCheck } : {}) };
  const facts = [process.counts.checks ? t('Lean 检查 {0} 次', process.counts.checks) : '', process.counts.attempts ? t('尝试 {0} 次', process.counts.attempts) : ''].filter(Boolean);
  return <details class="solve-process" data-solve-process={process.key} open={open} onToggle={event => {
    const now = (event.currentTarget as HTMLDetailsElement).open;
    if (now === (memory.open ?? props.defaultOpen ?? process.active)) return;
    memory.open = now; refresh();
  }}>
    <summary><span class="solve-process-title">{t('解题过程')}</span>
      <span class="solve-process-facts">{process.startedAt && <Elapsed from={process.startedAt} to={process.endedAt} />}
        {facts.map(fact => <span key={fact}>{fact}</span>)}</span><Icon name="chevron-down" /></summary>
    {open && <>
      <ol class="solve-stages">{process.stages.map(stage => <li key={stage.id} class="solve-stage" data-stage={stage.id} data-tone={stage.tone}>
        <p class="solve-stage-head"><ToneMark tone={stage.tone} /><strong>{stage.label}</strong>{stage.summary && <span>{stage.summary}</span>}</p>
        {stage.rows.length > 0 && <ol class="solve-rows">{stage.rows.map(row => <Row key={row.id} row={row} ctx={ctx} />)}</ol>}
      </li>)}</ol>
      {props.loading && <p class="route-item-note solve-state" role="status"><Spinner />{t('正在读取过程记录…')}</p>}
      {props.failed && <p class="route-item-note solve-state" role="status">{t('过程记录没有读取成功。')}
        {props.onRetry && <button type="button" class="text-button" onClick={props.onRetry}>{t('重试')}</button>}</p>}
      {process.dropped > 0 && <p class="route-item-note solve-state">{t('记录超过保存上限，之后的 {0} 条没有保存。', process.dropped)}</p>}
    </>}
  </details>;
}
