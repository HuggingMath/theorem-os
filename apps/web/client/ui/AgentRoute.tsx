import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { webAgentActionLimits, type WebAgentAction, type WebEvent, type WebRun } from '../../shared';
import type { AgentActivity } from '../agentActivity';
import type { AgentRoute, RouteItem, RouteStep } from '../agentRoute';
import { readableDuration } from '../../presentation';
import { Icon, Spinner } from './Icon';
import { localizeText, t } from '../../i18n';

type Lane = AgentRoute & { name?: string };
export type AgentRouteProps = {
  /** Lanes drawn as given; the component preview has no server. With `source` the lanes come from its store. */ routes?: readonly Lane[];
  /** The run, read with every event and Agent action the store has, which it keeps reading while the run is live. */
  source?: { store: AgentActivity; run: WebRun; lead?: string };
  /** What the reader calls each Agent (its role); the id stays in the tooltip. */ names?: ReadonlyMap<string, string>;
  /** Short theorem names of the plan's tasks, shown instead of task ids. */ tasks: ReadonlyMap<string, string>;
  /** The last step of each Agent is live while the run is. */ running: boolean;
  /** An ended run's one-line outcome (see endedSummary) under the lanes, with a link to its report. */ ended?: string;
  /** Proof tasks in the Lead's plan; zero means the run was solved without splitting. */ planned: number;
  /** Where the plan's dependency graph is: below the map in the collaboration tab, or in that tab when the map stands alone. */ graph?: 'below' | 'elsewhere';
  time: (at: string) => string;
};

// A long lane shows its newest steps; the earlier ones are one click away.
const shownSteps = 24;
const stepLabel = (step: RouteStep, tasks: AgentRouteProps['tasks']) => {
  const task = step.taskId && tasks.get(step.taskId) ? ` ${tasks.get(step.taskId)}` : '';
  switch (step.kind) {
    case 'read': return step.reviewing ? t('接审阅') : step.taskId ? step.again ? t('重新接任务{0}', task) : t('接任务{0}', task) : t('读题');
    case 'write': return step.reviewing ? t('审阅候选') : step.planning ? t('制定计划') : step.count > 1 ? t('写证明 ×{0}', step.count) : t('写证明');
    case 'check': return step.count > 1 ? t('Lean 检查 ×{0}', step.count) : t('Lean 检查');
    case 'deliver': return t('交付{0}', task);
    case 'accept': return t('独立验收');
    case 'stop': return t('会话停止');
  }
};
const outcomeLabel = { passed: t('通过'), failed: t('未通过') } as const;
const nameOf = (route: Lane) => route.name ?? route.workerId;
const stepKey = (step: RouteStep) => `${step.kind}@${step.at}`;
const actionsOf = (step: RouteStep) => step.items.filter((item): item is Extract<RouteItem, { type: 'action' }> => item.type === 'action').map(item => item.action);
/** Whether a lane's last step is still going: the run is live and the Agent has neither delivered, stopped nor been judged. */
const isLive = (lane: Lane, running: boolean) => {
  const last = lane.steps.at(-1)!;
  return running && !['deliver', 'stop'].includes(last.kind) && !last.outcome;
};

/** The kinds a reader filters a step by. */
type Group = 'think' | 'look' | 'edit' | 'lean' | 'run' | 'say' | 'host';
const groups: [Group, string][] = [['think', t('思考')], ['look', t('查看')], ['edit', t('修改')], ['lean', 'Lean'], ['run', t('命令')],
  ['say', t('说明')], ['host', t('平台')]];
const leanCommand = /\b(?:check-lean|search-lean)\b|\blake\s+(?:env\s+lean|build|exe)\b|(?:^|[\s;&|(])lean\s/u;
const groupOf = (item: RouteItem): Group => {
  if (item.type === 'event') return 'host';
  const action = item.action;
  switch (action.kind) {
    case 'reasoning': case 'plan': case 'compaction': return 'think';
    case 'message': return 'say';
    case 'edit': return 'edit';
    case 'search': return 'look';
    case 'tool': return action.tool === 'view_image' ? 'look' : 'run';
    case 'command': return leanCommand.test(action.command ?? '') ? 'lean' : action.intents?.length ? 'look' : 'run';
  }
};

const base = (file: string) => file.split('/').filter(Boolean).at(-1) ?? file;
const firstLine = (text: string, limit = 90) => {
  const line = (text.split('\n').find(value => value.trim()) ?? '').replace(/\*\*/gu, '').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};
type DiffLine = { kind: 'add' | 'del' | 'hunk' | 'same' | 'meta'; text: string };
/** A change's diff as lines; an added or deleted file may come as its bare text. */
function diffLines(change: { change: string; diff?: string }): DiffLine[] {
  const lines = (change.diff ?? '').replace(/\n$/u, '').split('\n');
  const unified = lines.some(line => line.startsWith('@@'));
  if (!unified && change.change !== 'update' && !lines.every(line => /^[+-]/u.test(line)))
    return lines.map(text => ({ kind: change.change === 'add' ? 'add' : 'del', text }));
  let started = !unified;
  return lines.map(text => {
    if (text.startsWith('@@')) { started = true; return { kind: 'hunk', text }; }
    if (!started) return { kind: 'meta', text };
    return { kind: text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : 'same', text: text.slice(1) };
  });
}
const diffStat = (changes: NonNullable<WebAgentAction['changes']>) => {
  let added = 0, removed = 0;
  for (const change of changes) for (const line of diffLines(change)) { if (line.kind === 'add') added++; else if (line.kind === 'del') removed++; }
  return added || removed ? `+${added} −${removed}` : '';
};

type Outcome = { text: string; tone: 'passed' | 'failed' | 'muted' };
type Summary = { icon: string; label: string; code?: string; outcome?: Outcome };
/** One action as a row title: what the Agent did, the file or query it did it on, and how it came out. */
function summarize(action: WebAgentAction): Summary {
  switch (action.kind) {
    case 'reasoning': return { icon: 'brain', label: action.text ? t('思考：{0}', firstLine(action.text)) : t('思考') };
    case 'message': return { icon: 'message-square-text', label: action.text ? t('说明：{0}', firstLine(action.text)) : t('说明') };
    case 'plan': return { icon: 'list-checks', label: t('更新待办') };
    case 'compaction': return { icon: 'archive', label: t('压缩了上下文，较早的对话已归纳') };
    case 'search': return { icon: 'globe', label: t('网页搜索'), code: action.query ?? action.url };
    case 'tool': return action.tool === 'view_image' ? { icon: 'image', label: t('查看图片'), code: action.arguments }
      : { icon: 'wrench', label: t('调用工具'), code: action.tool };
    case 'edit': {
      const changes = action.changes ?? [], stat = diffStat(changes), only = changes.length === 1 && !action.omittedChanges ? changes[0] : undefined;
      const outcome = stat ? { text: stat, tone: 'muted' as const } : undefined;
      if (!only) return { icon: 'file-pen', label: t('修改 {0} 个文件', changes.length + (action.omittedChanges ?? 0)), code: changes.map(change => base(change.path)).join(' '), outcome };
      if (only.movedTo) return { icon: 'file-pen', label: t('移动文件'), code: `${base(only.path)} → ${base(only.movedTo)}`, outcome };
      return { icon: only.change === 'add' ? 'file-plus' : only.change === 'delete' ? 'file-minus' : 'file-pen',
        label: only.change === 'add' ? t('新建') : only.change === 'delete' ? t('删除') : t('修改'), code: base(only.path), outcome };
    }
    case 'command': return summarizeCommand(action);
  }
}
function summarizeCommand(action: WebAgentAction): Summary {
  const command = action.command ?? '';
  if (/\bcheck-lean\b/u.test(command)) {
    const file = /--file\s+'?([^\s']+)/u.exec(command)?.[1], lean = action.lean;
    const errors = lean?.messages.filter(message => message.severity === 'error').length ?? 0;
    const sorry = lean?.messages.some(message => /\bsorry\b/u.test(message.text));
    const outcome: Outcome | undefined = action.status === 'running' ? undefined
      : lean?.timedOut ? { text: t('超时'), tone: 'failed' }
      : lean?.passed ? { text: sorry ? t('没有错误，但用了 sorry') : t('没有错误'), tone: sorry ? 'muted' : 'passed' }
      : errors ? { text: t('{0} 个错误', `${errors}${lean?.omittedMessages ? '+' : ''}`), tone: 'failed' }
      : action.status === 'failed' || lean ? { text: t('未通过'), tone: 'failed' } : undefined;
    return { icon: 'shield-check', label: t('Lean 检查'), code: file ? base(file) : undefined, outcome };
  }
  if (/\bsearch-lean\b/u.test(command)) {
    const queries = [...command.matchAll(/--query\s+(?:'([^']*)'|"([^"]*)"|(\S+))/gu)].map(match => match[1] ?? match[2] ?? match[3]!);
    const total = action.found?.reduce((sum, item) => sum + item.total, 0);
    return { icon: 'book-open', label: t('检索 Mathlib'), code: queries.join(' · ') || undefined,
      outcome: total !== undefined ? { text: t('{0} 条结果', total), tone: 'muted' } : undefined };
  }
  if (leanCommand.test(command)) return { icon: 'shield-check', label: t('运行 Lean'), code: firstLine(command, 120) };
  const intents = action.intents ?? [];
  if (intents.length) {
    const type = intents[0]!.type;
    const targets = [...new Set(intents.map(intent => intent.type === 'search' ? intent.query ?? '' : base(intent.path ?? '.')).filter(Boolean))];
    return { icon: type === 'read' ? 'file-search' : type === 'list' ? 'folder-open' : 'search',
      label: type === 'read' ? t('读取') : type === 'list' ? t('列出目录') : t('搜索代码'), code: targets.join(' · ') || firstLine(command, 120) };
  }
  return { icon: 'terminal', label: t('运行命令'), code: firstLine(command, 120) };
}
/** How an action ended, when its title does not already say. */
function endState(action: WebAgentAction, running: boolean): Outcome | undefined {
  if (action.status === 'declined') return { text: t('被拒绝'), tone: 'muted' };
  if (action.status === 'running') return running ? undefined : { text: t('未结束'), tone: 'muted' };
  if (action.status === 'failed') return action.exitCode ? { text: t('退出码 {0}', action.exitCode), tone: 'failed' } : { text: t('失败'), tone: 'failed' };
  return undefined;
}
/** A host event as one line inside an Agent's step; the step already names the Agent. */
const eventText = (event: WebEvent) => {
  const message = localizeText(event.message), worker = event.details?.workerId;
  return worker && message.endsWith(` · ${worker}`) ? message.slice(0, -worker.length - 3) : message;
};
const eventOutcome = (event: WebEvent): Outcome | undefined => {
  const details = event.details;
  if (event.type === 'evaluation_finished') return details?.status === 'passed' ? { text: t('通过'), tone: 'passed' } : { text: t('未通过'), tone: 'failed' };
  if (typeof details?.passed === 'boolean') return details.passed ? { text: t('通过'), tone: 'passed' } : { text: t('未通过'), tone: 'failed' };
  return undefined;
};
const itemKey = (item: RouteItem) => item.type === 'event' ? `e:${item.event.sequence}` : `a:${item.action.workerId}:${item.action.itemId}`;
const itemAt = (item: RouteItem) => item.type === 'event' ? item.event.at : item.action.at;
const eventDetail = (event: WebEvent) => eventText(event).split('\n').slice(1).join('\n').trim();
const textBody = (action: WebAgentAction) => Boolean(action.text && action.text.trim() !== firstLine(action.text));
/** Whether a row opens to more than its title. */
function hasBody(item: RouteItem) {
  if (item.type === 'event') return Boolean(eventDetail(item.event));
  const action = item.action;
  switch (action.kind) {
    case 'command': return true;
    case 'edit': return Boolean(action.changes?.length || action.omittedChanges);
    case 'reasoning': case 'message': return textBody(action);
    case 'plan': return Boolean(action.text);
    case 'search': return Boolean(action.url && action.query);
    case 'tool': return Boolean(action.arguments && action.tool !== 'view_image');
    case 'compaction': return false;
  }
}
const Note = ({ children }: { children: string }) => <p class="route-item-note">{children}</p>;
function Diff({ change }: { change: NonNullable<WebAgentAction['changes']>[number] }) {
  if (!change.diff) return change.clipped ? <Note>{t('这个文件在平台目录中，不显示内容。')}</Note> : null;
  return <pre class="route-diff" tabIndex={0} aria-label={t('{0} 的改动', base(change.path))}>
    {diffLines(change).map((line, index) => <span key={index} class="route-diff-line" data-line={line.kind}>{line.text || ' '}{'\n'}</span>)}
  </pre>;
}
function ActionBody({ action }: { action: WebAgentAction }) {
  switch (action.kind) {
    case 'command': return <>
      <pre class="route-command"><code>{action.command}</code></pre>
      {action.lean && <div class="route-lean">
        {action.lean.messages.length ? <ul>{action.lean.messages.map((message, index) => <li key={index} data-severity={message.severity}>
          <span class="route-lean-where">{message.severity === 'error' ? t('错误') : message.severity === 'warning' ? t('警告') : t('信息')}
            {message.line !== undefined && ` · ${message.file ? base(message.file) : ''}:${message.line}${message.column !== undefined ? `:${message.column}` : ''}`}</span>
          <pre>{message.text}</pre></li>)}</ul>
          : <Note>{action.lean.passed ? t('Lean 没有报告任何消息。') : action.lean.timedOut ? t('Lean 在时限内没有检查完。') : t('Lean 没有给出具体消息。')}</Note>}
        {action.lean.omittedMessages ? <Note>{t('另有 {0} 条消息没有显示。', action.lean.omittedMessages)}</Note> : null}
      </div>}
      {action.found && <ul class="route-found">{action.found.map((query, index) => <li key={index}>
        <span class="route-found-query">{query.query}</span><span class="route-found-total">{t('{0} 条结果', query.total)}</span>
        {query.names.length > 0 && <span class="route-found-names">{query.names.map(name => <code key={name}>{name}</code>)}</span>}</li>)}</ul>}
      {action.output && <pre class="route-output" tabIndex={0} aria-label={t('命令输出')}>{action.output}</pre>}
      {action.withheld && <Note>{t('这条命令读到了平台自己的文件，输出不显示。')}</Note>}
      {action.outputClipped && <Note>{t('输出较长，只显示开头和结尾。')}</Note>}
      {!action.output && !action.lean && !action.found && !action.withheld && action.status !== 'running' && <Note>{t('没有输出。')}</Note>}
    </>;
    case 'edit': return <>
      {(action.changes ?? []).map((change, index) => <div key={index} class="route-change">
        <p class="route-change-path"><code>{change.path}</code>{change.movedTo && <> → <code>{change.movedTo}</code></>}
          <span>{change.change === 'add' ? t('新建') : change.change === 'delete' ? t('删除') : change.movedTo ? t('移动') : t('修改')}</span></p>
        <Diff change={change} />
        {change.clipped && change.diff && <Note>{t('改动较长，后面的部分没有显示。')}</Note>}
      </div>)}
      {action.omittedChanges ? <Note>{t('另有 {0} 个文件的改动没有显示。', action.omittedChanges)}</Note> : null}
    </>;
    case 'reasoning': case 'message': case 'plan': return <>
      <div class="route-text">{action.text}</div>
      {action.textClipped && <Note>{t('内容较长，后面的部分没有显示。')}</Note>}
    </>;
    case 'search': return <p class="route-link"><code>{action.url}</code></p>;
    case 'tool': return <pre class="route-command"><code>{action.arguments}</code></pre>;
    case 'compaction': return null;
  }
}

type Memory = {
  selected?: { workerId: string; at: string; kind: string };
  /** While the run is live, the open step moves to its lane's newest step. */ follow: boolean;
  filter?: Group; expanded: Set<string>; open: Set<string>;
  /** The step chip that takes Tab (one per map). */ focus?: string;
  /** Scroll the inspector into view after this render. */ reveal?: boolean;
};
// Per run, so leaving a tab or another run and coming back finds the same step open.
const memories = new Map<string, Memory>();
const memoryOf = (runId: string) => {
  let memory = memories.get(runId);
  if (!memory) { memory = { follow: false, expanded: new Set(), open: new Set() }; memories.set(runId, memory); }
  return memory;
};
type Context = {
  memory: Memory; tasks: AgentRouteProps['tasks']; time: AgentRouteProps['time']; running: boolean; recorded: boolean;
  refresh: () => void; select: (lane: Lane, index: number, options?: { toggle?: boolean }) => void; close: () => void; focus?: string;
};

function ItemRow({ item, ctx }: { item: RouteItem; ctx: Context }) {
  const key = itemKey(item), open = ctx.memory.open.has(key), body = hasBody(item), at = itemAt(item);
  let head;
  if (item.type === 'event') {
    const outcome = eventOutcome(item.event);
    head = <><span class="route-item-icon" data-group="host"><Icon name="server" /></span>
      <span class="route-item-title"><span class="route-item-label">{firstLine(eventText(item.event), 160)}</span></span>
      <span class="route-item-meta">{outcome && <span class="route-item-outcome" data-tone={outcome.tone}>{outcome.text}</span>}<time>{ctx.time(at)}</time></span></>;
  } else {
    const action = item.action, summary = summarize(action), outcome = summary.outcome ?? endState(action, ctx.running);
    head = <><span class="route-item-icon" data-group={groupOf(item)}>{action.status === 'running' && ctx.running ? <Spinner /> : <Icon name={summary.icon} />}</span>
      <span class="route-item-title"><span class="route-item-label">{summary.label}</span>{summary.code && <code>{summary.code}</code>}</span>
      <span class="route-item-meta">{outcome && <span class="route-item-outcome" data-tone={outcome.tone}>{outcome.text}</span>}
        {action.durationMs !== undefined && action.durationMs >= 1_000 && <span>{readableDuration(action.durationMs)}</span>}<time>{ctx.time(at)}</time></span></>;
  }
  const kind = item.type === 'event' ? 'event' : item.action.kind;
  if (!body) return <li class="route-item" data-kind={kind}><div class="route-item-head">{head}</div></li>;
  return <li class="route-item" data-kind={kind}>
    <details open={open} onToggle={event => {
      const now = (event.currentTarget as HTMLDetailsElement).open;
      if (now === ctx.memory.open.has(key)) return;
      if (now) ctx.memory.open.add(key); else ctx.memory.open.delete(key);
      ctx.refresh();
    }}>
      <summary class="route-item-head">{head}</summary>
      {open && <div class="route-item-body">{item.type === 'event' ? <div class="route-text">{eventDetail(item.event)}</div> : <ActionBody action={item.action} />}</div>}
    </details>
  </li>;
}
/** The open step: every event and action in it, oldest first. `live` is whether the lane is still going. */
function Inspector({ lane, index, live, ctx }: { lane: Lane; index: number; live: boolean; ctx: Context }) {
  const step = lane.steps[index]!, memory = ctx.memory, list = useRef<HTMLOListElement>(null);
  const stick = useRef(true), shown = useRef('');
  const counts = new Map<Group, number>();
  for (const item of step.items) counts.set(groupOf(item), (counts.get(groupOf(item)) ?? 0) + 1);
  const filter = memory.filter, items = filter ? step.items.filter(item => groupOf(item) === filter) : step.items;
  const actions = step.items.filter(item => item.type === 'action').length, events = step.items.length - actions;
  const withBody = items.filter(hasBody), allOpen = withBody.length > 0 && withBody.every(item => memory.open.has(itemKey(item)));
  const following = live && memory.follow && index === lane.steps.length - 1;
  const end = step.items.length ? itemAt(step.items.at(-1)!) : step.at;
  // A newly opened step starts at its top; the live one stays at its newest row while the reader is there.
  useLayoutEffect(() => {
    const element = list.current, key = `${lane.workerId}|${stepKey(step)}`;
    if (!element) return;
    if (shown.current !== key) { shown.current = key; stick.current = following; element.scrollTop = following ? element.scrollHeight : 0; }
    else if (following && stick.current) element.scrollTop = element.scrollHeight;
  });
  const id = `route-inspector-${lane.workerId}`;
  return <section class="route-inspector" id={id} aria-labelledby={`${id}-title`} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); ctx.close(); }
  }}>
    <header class="route-inspector-head">
      <div class="route-inspector-heading">
        <h4 id={`${id}-title`}>{`${nameOf(lane)} · ${stepLabel(step, ctx.tasks)}`}</h4>
        <p class="route-inspector-meta">{step.at === end ? ctx.time(step.at) : `${ctx.time(step.at)} – ${ctx.time(end)}`}
          {' · '}{actions ? t('{0} 个动作', actions) : t('没有 Agent 动作')}{events ? ` · ${t('{0} 条平台记录', events)}` : ''}</p>
      </div>
      <div class="route-inspector-tools">
        {live && <button type="button" class="text-button" aria-pressed={following} title={t('打开这个 Agent 的最新一步，并跟着它往下走')}
          onClick={() => { if (following) { memory.follow = false; ctx.refresh(); } else ctx.select(lane, lane.steps.length - 1); }}>
          <Icon name="locate-fixed" />{t('跟随最新')}</button>}
        {withBody.length > 0 && <button type="button" class="text-button" onClick={() => {
          for (const item of withBody) { if (allOpen) memory.open.delete(itemKey(item)); else memory.open.add(itemKey(item)); }
          ctx.refresh();
        }}>{allOpen ? t('全部收起') : t('全部展开')}</button>}
        <button type="button" class="icon-button" aria-label={t('上一步')} title={t('上一步')} disabled={index === 0}
          onClick={() => ctx.select(lane, index - 1)}><Icon name="chevron-left" /></button>
        <button type="button" class="icon-button" aria-label={t('下一步')} title={t('下一步')} disabled={index === lane.steps.length - 1}
          onClick={() => ctx.select(lane, index + 1)}><Icon name="chevron-right" /></button>
        <button type="button" class="icon-button" aria-label={t('关闭')} title={t('关闭（Esc）')} onClick={ctx.close}><Icon name="x" /></button>
      </div>
    </header>
    {counts.size > 1 && <div class="route-filters" role="group" aria-label={t('按类型筛选')}>
      <button type="button" class="route-filter" aria-pressed={!filter} onClick={() => { memory.filter = undefined; ctx.refresh(); }}>{t('全部')}<span>{step.items.length}</span></button>
      {groups.filter(([group]) => counts.has(group) || group === filter).map(([group, label]) =>
        <button key={group} type="button" class="route-filter" data-group={group} aria-pressed={filter === group}
          onClick={() => { memory.filter = filter === group ? undefined : group; ctx.refresh(); }}>{label}<span>{counts.get(group) ?? 0}</span></button>)}
    </div>}
    {items.length ? <ol class="route-items" ref={list} tabIndex={0} aria-label={t('{0} 这一步做的事', nameOf(lane))}
      onScroll={event => { const element = event.currentTarget; stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24; }}>
      {items.map(item => <ItemRow key={itemKey(item)} item={item} ctx={ctx} />)}
    </ol> : <p class="route-item-note">{t('这一步没有这类记录。')}
      <button type="button" class="text-button" onClick={() => { memory.filter = undefined; ctx.refresh(); }}>{t('显示全部')}</button></p>}
    {step.superseded && <p class="route-item-note">{t('研究计划随后调整，这一步所做的任务分配被新版本取代，成果没有用上。')}</p>}
    {step.again && <p class="route-item-note">{t('计划调整后，这个任务按新版本重新分给了 {0}。', nameOf(lane))}</p>}
    {!actions && <p class="route-item-note">{!ctx.recorded ? t('这次运行没有记录 Agent 的具体动作，只有平台记录。')
      : live && index === lane.steps.length - 1 ? t('Agent 的动作会在发生时出现在这里。') : t('这一步是平台的记录，Agent 没有在其中动作。')}</p>}
  </section>;
}

function LaneView({ lane, laneIndex, from, selected, ctx }: { lane: Lane; laneIndex: number; from: number; selected?: number; ctx: Context }) {
  const memory = ctx.memory, steps = lane.steps, last = steps.at(-1)!, live = isLive(lane, ctx.running), folded = from > 0;
  const running = live ? actionsOf(last).filter(action => action.status === 'running').at(-1) : undefined;
  const now = running && summarize(running);
  const toggleFold = () => { if (memory.expanded.has(lane.workerId)) memory.expanded.delete(lane.workerId); else memory.expanded.add(lane.workerId); ctx.refresh(); };
  return <li class="agent-route-lane" data-worker-id={lane.workerId} data-lane={laneIndex}>
    <span class="agent-route-who" title={lane.workerId}><span class="collab-agent-dot" aria-hidden="true" />{nameOf(lane)}</span>
    <ol class="agent-route-steps" aria-label={t('{0} 的路线', nameOf(lane))}>
      {steps.length > shownSteps && <li class="agent-route-step agent-route-more"><button type="button" class="text-button" onClick={toggleFold}>
        {folded ? t('显示更早的 {0} 步', from) : t('收起更早的步骤')}</button></li>}
      {steps.slice(from).map((step, offset) => {
        const index = from + offset, key = `${lane.workerId}|${stepKey(step)}`, current = live && index === steps.length - 1;
        const count = actionsOf(step).length, open = selected === index;
        return <li key={stepKey(step)} class="agent-route-step" data-kind={step.kind} data-outcome={step.outcome} data-superseded={step.superseded || undefined} data-current={current || undefined}>
          <button type="button" class="agent-route-label" data-route-step={key} tabIndex={ctx.focus === key ? 0 : -1}
            aria-expanded={open} aria-controls={open ? `route-inspector-${lane.workerId}` : undefined} data-selected={open || undefined}
            title={`${ctx.time(step.at)}${count ? ` · ${t('{0} 个动作', count)}` : ''}`}
            onClick={() => ctx.select(lane, index, { toggle: true })} onFocus={() => { memory.focus = key; }}>
            {current ? <Spinner /> : <span class="agent-route-mark" aria-hidden="true" />}{stepLabel(step, ctx.tasks)}
            {step.outcome && <span class="agent-route-outcome">{outcomeLabel[step.outcome]}</span>}
            {step.superseded && <span class="agent-route-outcome agent-route-superseded">{t('已被取代')}</span>}
            {count > 0 && <span class="agent-route-count" aria-hidden="true">{count}</span>}
            {count > 0 && <span class="sr-only">{t('，{0} 个动作', count)}</span>}
          </button>
        </li>;
      })}
    </ol>
    {now && <p class="agent-route-now"><Spinner /><span>{t('正在：{0}', now.code ? `${now.label} ${now.code}` : now.label)}</span></p>}
    {selected !== undefined && <Inspector lane={lane} index={selected} live={live} ctx={ctx} />}
  </li>;
}
function AgentRouteMap(props: AgentRouteProps) {
  const [, setTick] = useState(0);
  const refresh = () => setTick(value => value + 1);
  const source = props.source, runId = source?.run.id ?? '', memory = memoryOf(runId);
  const anchor = useRef<HTMLParagraphElement>(null), lanesRef = useRef<HTMLOListElement>(null), latest = useRef(source);
  latest.current = source;
  useEffect(() => source?.store.subscribe(id => { if (id === runId) refresh(); }), [source?.store, runId]);
  useEffect(() => { if (source) source.store.sync(source.run); });
  // A live run's count of actions is saved only now and then, so its new actions are asked for while the map is on screen.
  useEffect(() => {
    if (!props.running || !source) return;
    const timer = setInterval(() => {
      const current = latest.current;
      if (current && anchor.current?.isConnected && !document.hidden) current.store.sync(current.run, true);
    }, 3_000);
    return () => clearInterval(timer);
  }, [props.running, source?.store, runId]);
  useLayoutEffect(() => {
    if (!memory.reveal) return;
    memory.reveal = false;
    lanesRef.current?.querySelector('.route-inspector')?.scrollIntoView({ block: 'nearest' });
  });

  const lanes: Lane[] = (source ? source.store.routes(source.run, source.lead) : props.routes ?? [])
    .map(route => ({ ...route, name: props.names?.get(route.workerId) ?? (route as Lane).name }));
  const state = source?.store.state(runId);
  // The open step, found again after new events: by its start, or the latest step that began before it.
  let selectedLane = -1, selectedIndex: number | undefined;
  const wanted = memory.selected;
  if (wanted) {
    selectedLane = lanes.findIndex(lane => lane.workerId === wanted.workerId);
    const lane = lanes[selectedLane];
    if (!lane) memory.selected = undefined;
    else {
      if (memory.follow && isLive(lane, props.running)) selectedIndex = lane.steps.length - 1;
      else {
        let found = 0;
        for (let index = 0; index < lane.steps.length; index++) {
          const step = lane.steps[index]!;
          if (step.at === wanted.at && step.kind === wanted.kind) { found = index; break; }
          if (step.at <= wanted.at) found = index;
        }
        selectedIndex = found;
      }
      const step = lane.steps[selectedIndex]!;
      memory.selected = { workerId: lane.workerId, at: step.at, kind: step.kind };
    }
  }
  const folds = lanes.map((lane, index) => lane.steps.length > shownSteps && !memory.expanded.has(lane.workerId)
    && !(index === selectedLane && selectedIndex! < lane.steps.length - shownSteps) ? lane.steps.length - shownSteps : 0);
  const keyOf = (lane: Lane, step: RouteStep) => `${lane.workerId}|${stepKey(step)}`;
  const visible = new Set(lanes.flatMap((lane, index) => lane.steps.slice(folds[index]).map(step => keyOf(lane, step))));
  const selectedKey = selectedIndex !== undefined ? keyOf(lanes[selectedLane]!, lanes[selectedLane]!.steps[selectedIndex]!) : undefined;
  const focus = memory.focus && visible.has(memory.focus) ? memory.focus : selectedKey ?? (lanes[0] ? keyOf(lanes[0], lanes[0].steps[folds[0]!]!) : undefined);

  const chip = (key: string) => lanesRef.current?.querySelector<HTMLElement>(`[data-route-step="${CSS.escape(key)}"]`);
  const close = () => {
    const key = selectedKey;
    memory.selected = undefined; memory.follow = false; memory.reveal = false;
    if (key && lanesRef.current?.contains(document.activeElement)) { memory.focus = key; chip(key)?.focus(); }
    refresh();
  };
  const select: Context['select'] = (lane, index, options = {}) => {
    const step = lane.steps[index];
    if (!step) return;
    const key = keyOf(lane, step);
    if (options.toggle && key === selectedKey) { close(); return; }
    memory.selected = { workerId: lane.workerId, at: step.at, kind: step.kind };
    memory.follow = isLive(lane, props.running) && index === lane.steps.length - 1;
    memory.focus = key; memory.reveal = Boolean(options.toggle);
    refresh();
  };
  // Arrows move along a lane and between lanes, Home and End to a lane's ends; Tab leaves the map from one step.
  const onKeyDown = (event: KeyboardEvent) => {
    const target = (event.target as Element).closest<HTMLElement>('[data-route-step]');
    if (!target || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape'].includes(event.key)) return;
    if (event.key === 'Escape') { if (memory.selected) { event.preventDefault(); close(); } return; }
    event.preventDefault();
    const rows = [...lanesRef.current!.querySelectorAll<HTMLElement>(':scope > .agent-route-lane')]
      .map(lane => [...lane.querySelectorAll<HTMLElement>(':scope > .agent-route-steps [data-route-step]')]);
    const row = rows.findIndex(items => items.includes(target)), column = rows[row]?.indexOf(target) ?? -1;
    if (row < 0) return;
    const next = event.key === 'ArrowLeft' ? rows[row]![column - 1] : event.key === 'ArrowRight' ? rows[row]![column + 1]
      : event.key === 'Home' ? rows[row]![0] : event.key === 'End' ? rows[row]!.at(-1)
      : (lane => lane?.[Math.min(column, lane.length - 1)])(rows[row + (event.key === 'ArrowDown' ? 1 : -1)]);
    if (!next) return;
    memory.focus = next.dataset.routeStep; next.focus(); refresh();
  };

  const total = lanes.reduce((sum, lane) => sum + lane.steps.reduce((count, step) => count + actionsOf(step).length, 0), 0);
  const recorded = total > 0 || Boolean(source?.run.actions?.count);
  const ctx: Context = { memory, tasks: props.tasks, time: props.time, running: props.running, recorded, refresh, select, close, focus };
  const summary = !lanes.length ? (props.running ? t('Agent 开始工作后，这里按时间画出每个 Agent 走过的步骤。') : t('这次运行没有记录 Agent 步骤。'))
    : props.planned === 1 ? props.graph === 'elsewhere' ? t('研究计划只有 1 个任务，详情见「协作」。') : t('研究计划只有 1 个任务，见下方「数学任务」。')
    : props.planned ? props.graph === 'elsewhere' ? t('研究计划有 {0} 个任务，依赖关系见「协作」。', props.planned) : t('研究计划有 {0} 个任务，下方显示它们之间的依赖关系。', props.planned)
    : lanes.length === 1 ? t('{0} 独自处理整道题，没有拆分任务。', nameOf(lanes[0]!)) : t('{0} 个 Agent 参与，没有拆分任务。', lanes.length);
  const hint = !lanes.length ? '' : recorded ? t('点一步，看 Agent 在这一步的思考、命令、改动和 Lean 检查。') : t('点一步，看这一步的平台记录。');
  // While the actions load, the line says so in the hint's place, so the lanes below do not move when they arrive.
  const reading = Boolean(state?.loading && !total && recorded);
  return <>
    <p class="collab-help agent-route-summary" ref={anchor}>{summary}{reading
      ? <> <span class="agent-route-reading" role="status"><Spinner />{t('正在读取 Agent 的动作…')}</span></> : hint && ` ${hint}`}</p>
    {state?.failed && <p class="agent-route-state" role="status">{t('Agent 的动作没有读取成功。')}
      <button type="button" class="text-button" onClick={() => source!.store.retry(source!.run)}>{t('重试')}</button></p>}
    {state?.dropped ? <p class="agent-route-state">{t('这次运行的 Agent 动作超过 {0} 条，之后的 {1} 条没有保存。', webAgentActionLimits.perRun, state.dropped)}</p> : null}
    {lanes.length > 0 && <ol class="agent-route-lanes" ref={lanesRef} onKeyDown={onKeyDown}>{lanes.map((lane, index) =>
      <LaneView key={lane.workerId} lane={lane} laneIndex={index} from={folds[index]!} selected={index === selectedLane ? selectedIndex : undefined} ctx={ctx} />)}</ol>}
    {props.ended && <p class="collab-now-ended">{props.ended}
      <button type="button" class="text-button" data-collab-open-report>{t('查看报告')}</button></p>}
  </>;
}

/**
 * Who did what, in order: one lane per Agent, built from the recorded progress events and the Agents' own actions, so a
 * run without a task plan still has a route. Each step opens to everything recorded in it.
 */
export function renderAgentRoute(root: HTMLElement, props: AgentRouteProps) {
  render(<AgentRouteMap key={props.source?.run.id ?? ''} {...props} />, root);
}
/** Stops a map whose host left the page, with its reading of the run. */
export function unmountAgentRoute(root: HTMLElement) { render(null, root); }
