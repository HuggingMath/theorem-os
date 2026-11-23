import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../i18n';
import type { SolveProcess } from '../solveProcess';
import { chatReadingReveal } from '../chatReadingPosition';
import { detailLevel, onDetailLevel, setDetailLevel, type DetailLevel } from '../detailLevel';
import { condenseThinking, thinkingEntryMatch, type ThinkingEntry, type ThinkingMatch, type ThinkingStep } from '../thinkingProcess';
import { ActionBody, firstLine, ItemRow, LeanReport, summarize, type ItemContext } from './AgentRoute';
import { ChatCodeBlock, ChatMessageContent } from './ChatMessageContent';
import { ToneMark } from './SolveProcess';
import { Icon, Spinner } from './Icon';

type Reading = { all?: boolean; following: boolean; top: number; anchor?: { id: string; detail?: boolean; offset: number } };
type Search = { query: string; reading: Reading; selected?: string };
type Memory = Reading & { open?: boolean; level?: DetailLevel; details: boolean; known: Set<string>; unread: Set<string>; items: Set<string>; checks: Map<string, boolean>;
  groups: Map<string, boolean>; versions: Set<string>; view: 'all' | 'explanations'; search?: Search; searchReturn?: { search: Search; reading: Reading; view: 'all' | 'explanations' } };
const memories = new Map<string, Memory>();
const memoryOf = (key: string) => {
  let memory = memories.get(key);
  if (!memory) memories.set(key, memory = { details: detailLevel() === 'full', known: new Set(), unread: new Set(), items: new Set(), checks: new Map(), groups: new Map(),
    versions: new Set(), view: 'all', following: true, top: 0 });
  return memory;
};
const previewOf = (entry?: ThinkingEntry) => !entry ? '' : entry.kind === 'summary' ? firstLine(entry.text, 140)
  : entry.kind === 'check' ? entry.check.label : entry.kind === 'work' ? firstLine(entry.text || entry.label, 140) : summarize(entry.action).label;

function WorkVersions({ entry, memory, refresh }: {
  entry: Extract<ThinkingEntry, { kind: 'work' }>; memory: Memory; refresh(): void;
}) {
  const [copied, setCopied] = useState(''), [failed, setFailed] = useState(false);
  const fields = [
    ...(entry.task?.version ? [{ key: 'task', label: t('任务版本'), value: entry.task.version }] : []),
    ...(entry.candidate ? [{ key: 'commit', label: t('提交版本'), value: entry.candidate.commit },
      { key: 'source', label: t('源码摘要'), value: entry.candidate.sourceDigest }] : []),
  ];
  useEffect(() => { setCopied(''); setFailed(false); }, [entry.task?.version, entry.candidate?.commit, entry.candidate?.sourceDigest]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(''), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const task = entry.task && <><code translate={false}>{entry.task.id}</code>
    <span>{entry.task.relationship === 'current' ? t('当前任务版本') : entry.task.relationship === 'historical' ? t('历史任务版本') : t('任务版本未确认')}</span>
    {entry.task.version && <code title={entry.task.version} translate={false}>{entry.task.version.slice(0, 10)}</code>}</>;
  if (!fields.length) return task ? <p class="thinking-work-ref">{task}</p> : null;
  const open = memory.versions.has(entry.id);
  return <details class="thinking-version" data-thinking-version={entry.id} open={open} onToggle={event => {
    const now = event.currentTarget.open;
    if (now === memory.versions.has(entry.id)) return;
    if (now) memory.versions.add(entry.id); else memory.versions.delete(entry.id);
    refresh();
  }}>
    <summary class="thinking-work-ref" aria-label={entry.task ? t('查看任务 {0} 的完整版本', entry.task.id) : t('查看候选的完整版本')}>
      {task}
      {entry.candidate && <><span>{t('审阅的候选版本')}</span><code translate={false}
        title={`${entry.candidate.commit}\n${entry.candidate.sourceDigest}`}>{entry.candidate.commit.slice(0, 10)} · {entry.candidate.sourceDigest.slice(0, 10)}</code></>}
      <Icon name="chevron-down" />
    </summary>
    {open && <dl class="thinking-version-fields">{fields.map(field => <div key={field.key} data-thinking-version-field={field.key}>
      <dt>{field.label}<button type="button" class="text-button" data-thinking-version-copy={field.key}
        aria-label={copied === field.key ? t('{0}已复制', field.label) : t('复制{0}', field.label)}
        onClick={async () => {
          try { await navigator.clipboard.writeText(field.value); setCopied(field.key); setFailed(false); }
          catch { setCopied(''); setFailed(true); }
        }}><Icon name={copied === field.key ? 'check' : 'copy'} />{copied === field.key ? t('已复制') : t('复制')}</button></dt>
      <dd><code translate={false}>{field.value}</code></dd>
    </div>)}</dl>}
    <span class="sr-only" role="status">{copied ? t('{0}已复制', fields.find(field => field.key === copied)?.label ?? '') : ''}</span>
    {failed && open && <p class="thinking-version-error" role="status">{t('复制失败，请选择版本文本复制。')}</p>}
  </details>;
}

/** What Lean objected to first, for a failed check that stays folded to one line. */
function firstError(check: Extract<ThinkingEntry, { kind: 'check' }>['check']) {
  const message = check.lean?.firstBlocking ?? check.lean?.messages.find(item => item.severity === 'error');
  const text = firstLine(message?.text ?? check.text ?? '', 140);
  return text ? { text, ...(message?.line !== undefined ? { line: message.line } : {}) } : undefined;
}

function Entry({ entry, ctx, memory, onCheck, match, onContext, onQuestion, selected, simple }: {
  entry: ThinkingEntry; ctx: ItemContext; memory: Memory; onCheck?: (id: string) => void; match?: ThinkingMatch; onContext?(): void;
  onQuestion?(entry: ThinkingStep): void; selected: boolean; simple: boolean;
}) {
  const selection = { 'data-thinking-selected': selected ? 'true' : undefined, 'aria-current': selected ? 'true' as const : undefined };
  // 简洁 keeps the question on the record's own line, shown when the reader points at or focuses the record.
  const question = onQuestion && (entry.kind === 'summary' || entry.kind === 'work') && (simple
    ? <button type="button" class="icon-button thinking-question-icon" data-thinking-question={entry.id} aria-label={t('追问这一步')}
      title={t('将这一步引用到讨论草稿')} onClick={() => onQuestion(entry)}><Icon name="message-circle-question" /></button>
    : <button type="button" class="text-button thinking-question" data-thinking-question={entry.id} title={t('将这一步引用到讨论草稿')}
      onClick={() => onQuestion(entry)}>{t('追问这一步')}<Icon name="arrow-up-right" /></button>);
  const time = entry.kind !== 'action' && <time dateTime={entry.at}>{entry.kind === 'work' && entry.observed ? t('记录更新于 {0}', ctx.time(entry.at)) : ctx.time(entry.at)}</time>;
  const found = match && <div class="thinking-match" data-thinking-match>
    <p translate={false}>{match.before}<mark>{match.match}</mark>{match.after}</p>
    <button type="button" class="text-button" data-thinking-context={entry.id} onClick={onContext}>{t('查看前后记录')}<Icon name="arrow-up-right" /></button>
  </div>;
  const meta = simple ? found : <><div class="thinking-entry-meta">{entry.who && <span class="thinking-role">{entry.who}</span>}{time}</div>{found}</>;
  // 简洁 puts who, what, its state and when on one line.
  const head = (label?: string, status?: string) => <div class="thinking-head">
    {entry.who && <span class="thinking-role">{entry.who}</span>}{label && <strong>{label}</strong>}
    {status && <span class="thinking-head-status">{status}</span>}<span class="thinking-head-end">{question}{time}</span></div>;
  if (entry.kind === 'summary') return <li class="thinking-summary" data-thinking-entry={entry.id} data-thinking-kind="summary" {...selection}>
    {meta}{simple && head()}
    <ChatMessageContent text={entry.text} />
    {entry.clipped && <p class="route-item-note">{t('内容较长，后面的部分没有显示。')}</p>}
    {!simple && question}
  </li>;
  if (entry.kind === 'action') return <li data-thinking-entry={entry.id} data-thinking-kind="action" {...selection}>
    {meta}
    <ol class="route-items"><ItemRow item={{ type: 'action', action: entry.action }} ctx={ctx} detailId={entry.id} /></ol>
  </li>;
  if (entry.kind === 'work') {
    const open = memory.checks.get(entry.id) ?? memory.details;
    return <li class="thinking-work" data-thinking-entry={entry.id} data-thinking-kind="work" data-thinking-work={entry.category} data-thinking-task={entry.task?.id} {...selection}>
      {meta}
      {simple ? head(entry.label, entry.status) : <div class="thinking-work-head"><strong>{entry.label}</strong>{entry.status && <span>{entry.status}</span>}</div>}
      {entry.text && <ChatMessageContent text={entry.text} />}
      {!simple && <WorkVersions entry={entry} memory={memory} refresh={ctx.refresh} />}
      {entry.sections.length > 0 && <details open={open} data-thinking-detail={entry.id} onToggle={event => {
        const now = (event.currentTarget as HTMLDetailsElement).open;
        if (now === (memory.checks.get(entry.id) ?? memory.details)) return;
        memory.checks.set(entry.id, now); ctx.refresh();
      }}>
        <summary>{t('详细说明')}<Icon name="chevron-down" /></summary>
        {open && <div class="thinking-work-sections">{entry.sections.map((section, index) => <section key={index}>
          {section.code ? <ChatCodeBlock text={section.text} language="lean" label={section.label} preview={false} />
            : <><h5>{section.label}</h5><ChatMessageContent text={section.text} /></>}
        </section>)}</div>}
      </details>}
      {!simple && question}
    </li>;
  }
  const { check, action } = entry, open = memory.checks.get(entry.id) ?? memory.details;
  const stopped = check.state === 'running' && !ctx.running || check.state === 'failed' && !check.lean && !check.text;
  const tone = stopped ? 'stopped' : check.state === 'running' ? 'active' : check.state === 'passed' ? 'done' : 'failed';
  const line = <><ToneMark tone={tone} /><span>{check.label}</span>
    <span class="thinking-check-state">{stopped ? t('未完成') : check.state === 'running' ? t('检查中…') : check.state === 'passed' ? t('通过') : t('未通过')}</span>
    {simple && time}<Icon name="chevron-down" /></>;
  // Folded, a failed check still says what Lean objected to first; the file and the full report open with it.
  const brief = simple && !open && tone === 'failed' ? firstError(check) : undefined;
  return <li class="thinking-check" data-thinking-entry={entry.id} data-thinking-kind="check" data-tone={tone} {...selection}>
    {meta}
    <details open={open} data-thinking-detail={entry.id} onToggle={event => {
      const now = (event.currentTarget as HTMLDetailsElement).open;
      if (now === (memory.checks.get(entry.id) ?? memory.details)) return;
      memory.checks.set(entry.id, now); ctx.refresh();
    }}>
      <summary class="thinking-check-head">{line}</summary>
      {open && <div class="thinking-check-body route-item-body">
        {onCheck && <button type="button" class="text-button thinking-check-link" data-thinking-check={check.id} onClick={() => onCheck(check.id)}>
          {t('在工作区查看这次检查')}<Icon name="arrow-up-right" /></button>}
        {action && <ActionBody action={action} />}
        {check.lean && !action?.lean && <LeanReport lean={check.lean} />}
        {check.text && check.text !== action?.output && <pre class="solve-feedback" tabIndex={0} aria-label={t('反馈全文')} translate={false}>{check.text}</pre>}
        {!check.lean && !check.text && !action && <p class="route-item-note">{stopped ? t('这次检查没有返回结果。')
          : check.state === 'running' ? t('等待 Lean 返回检查结果。') : t('Lean 没有报告任何消息。')}</p>}
        {check.source !== undefined && <div class="thinking-source">
          <ChatCodeBlock text={check.source} language="lean" label={check.file ?? 'Submission.lean'} preview={false} />
          {check.sourceClipped && <p class="route-item-note">{t('文件较长，后面的部分没有保存。')}</p>}
        </div>}
      </div>}
    </details>
    {brief && <p class="thinking-check-brief" data-thinking-check-brief>{brief.line !== undefined && <span>{t('第 {0} 行出错', brief.line)}</span>}
      <code translate={false}>{brief.text}</code></p>}
  </li>;
}

type ActionEntry = Extract<ThinkingEntry, { kind: 'action' }>;
/** 简洁 only: tool actions between two explanations or checks as one line, opening to each action. */
function ActionGroup({ id, actions, ctx, memory }: { id: string; actions: ActionEntry[]; ctx: ItemContext; memory: Memory }) {
  // Folded unless the reader opened everything, or was sent to one of its actions from a search result.
  const initial = memory.details || actions.some(entry => memory.items.has(entry.id));
  const open = memory.groups.get(id) ?? initial, latest = summarize(actions.at(-1)!.action);
  const running = ctx.running && actions.some(entry => entry.action.status === 'running');
  return <li class="thinking-group" data-thinking-entry={id} data-thinking-kind="actions">
    <details open={open} data-thinking-detail={id} onToggle={event => {
      const now = (event.currentTarget as HTMLDetailsElement).open;
      if (now === (memory.groups.get(id) ?? initial)) return;
      memory.groups.set(id, now); ctx.refresh();
    }}>
      <summary class="thinking-group-head"><span class="route-item-icon">{running ? <Spinner /> : <Icon name="wrench" />}</span>
        <span class="thinking-group-count">{t('{0} 项工具操作', actions.length)}</span>
        <span class="thinking-group-latest">{latest.label}{latest.code && <> <code translate={false}>{latest.code}</code></>}</span><Icon name="chevron-down" /></summary>
      {open && <ol class="route-items">{actions.map(entry => <ItemRow key={entry.id} item={{ type: 'action', action: entry.action }} ctx={ctx} detailId={entry.id} />)}</ol>}
    </details>
  </li>;
}

function RecordOptions({ count, level, expand }: { count: number; level: DetailLevel; expand(value: boolean): void }) {
  const [open, setOpen] = useState(false), menu = useRef<HTMLDetailsElement>(null);
  const close = (focus = false) => {
    setOpen(false); if (focus) menu.current?.querySelector('summary')?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <details class="thinking-options" data-thinking-options ref={menu} open={open}
    onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } }}>
    <summary aria-label={t('记录选项')} title={t('记录选项')}><Icon name="ellipsis" /></summary>
    <div class="thinking-options-menu">
      <p>{t('{0} 条记录', count)}</p>
      <div class="collab-detail-toggle thinking-detail-toggle" role="group" aria-label={t('信息详略')} title={t('简洁和详细对对话、协作与轨迹同时生效')}>
        {(['simple', 'full'] as const).map(value => <button key={value} type="button" data-thinking-level={value} aria-pressed={level === value}
          onClick={() => { setDetailLevel(value); close(true); }}>{value === 'simple' ? t('简洁') : t('详细')}</button>)}</div>
      <button type="button" data-thinking-expand-all onClick={() => { expand(true); close(true); }}>{t('展开全部')}</button>
      <button type="button" data-thinking-collapse-all onClick={() => { expand(false); close(true); }}>{t('收起详情')}</button>
    </div>
  </details>;
}

/** A readable live log; folding it or scrolling up is the reader's choice across updates. */
export function ThinkingProcess({ process, time, onCheck, onQuestion }: {
  process: SolveProcess; time: (at: string) => string; onCheck?: (id: string) => void;
  onQuestion?(entry: ThinkingStep): void;
}) {
  const [, update] = useState(0), refresh = () => update(value => value + 1);
  useEffect(() => onDetailLevel(() => update(value => value + 1)), []);
  const level = detailLevel(), simple = level === 'simple';
  const memory = memoryOf(process.key), open = memory.open ?? process.active;
  const body = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), controls = useRef<HTMLDivElement>(null);
  const focusContext = useRef(false);
  const applying = useRef(false), focusBody = useRef(false), focusSearch = useRef<'focus' | 'select' | false>(false), searchInput = useRef<HTMLInputElement>(null), frame = useRef(0), bodyId = useId();
  const [overflow, setOverflow] = useState(false);
  // 简洁 keeps one record per task; 详细 lists every saved record.
  const entries = simple ? condenseThinking(process.thinking ?? []) : process.thinking ?? [];
  // Choosing the other reading replaces what was opened one by one under the previous one.
  if (memory.level !== level) {
    if (memory.level) {
      memory.details = !simple; memory.items.clear(); memory.checks.clear(); memory.groups.clear();
      if (!simple) for (const entry of entries) if (entry.kind === 'action') memory.items.add(entry.id);
    }
    memory.level = level;
  }
  const filtered = memory.view === 'all' ? entries : entries.filter(entry => entry.kind === 'summary' || entry.kind === 'work');
  const query = memory.search?.query.trim() ?? '';
  const matches = new Map<string, ThinkingMatch>();
  if (query) for (const entry of filtered) { const match = thinkingEntryMatch(entry, query); if (match) matches.set(entry.id, match); }
  const visible = query ? filtered.filter(entry => matches.has(entry.id)) : filtered;
  const selected = query ? visible.findIndex(entry => entry.id === memory.search?.selected) : -1;
  // 简洁 folds a run of tool actions into one row; a search lists every match on its own.
  type Row = { id: string; entry: ThinkingEntry; actions?: ActionEntry[] };
  const rows: Row[] = [];
  for (const entry of visible) {
    const last = rows.at(-1);
    if (simple && !query && entry.kind === 'action') {
      if (last?.actions) last.actions.push(entry); else rows.push({ id: entry.id, entry, actions: [entry] });
    } else rows.push({ id: entry.id, entry });
  }
  for (const row of rows) if (row.actions && row.actions.length > 1) row.id = `group:${row.id}`;
  const anchored = memory.following || !memory.anchor ? -1
    : rows.findIndex(row => row.id === memory.anchor!.id || row.actions?.some(entry => entry.id === memory.anchor!.id));
  const start = memory.all ? 0 : Math.min(Math.max(0, rows.length - (simple ? 12 : 40)), anchored < 0 ? rows.length : anchored);
  const shown = rows.slice(start), earlier = rows.slice(0, start).reduce((count, row) => count + (row.actions?.length ?? 1), 0);
  const proof = ['proving', 'verifying', 'accepted'].includes(process.state) || entries.some(entry => entry.kind === 'work' || entry.id.startsWith('prove:'));
  for (const entry of entries) if (!memory.known.has(entry.id)) {
    memory.known.add(entry.id);
    if (!memory.following) memory.unread.add(entry.id);
    if (entry.kind === 'action' && memory.details) memory.items.add(entry.id);
    if (entry.kind === 'check' || entry.kind === 'work') memory.checks.set(entry.id, memory.details);
  }
  if (memory.following) memory.unread.clear();
  const newCount = filtered.reduce((count, entry) => count + Number(memory.unread.has(entry.id)), 0);
  const latest = entries.at(-1), preview = previewOf(latest);
  const viewportTop = (node: HTMLElement) => Math.max(node.getBoundingClientRect().top,
    controls.current?.getBoundingClientRect().bottom ?? 0, node.closest('#research-chat-thread')?.getBoundingClientRect().top ?? 0);
  const save = (summary?: HTMLElement) => {
    const node = body.current;
    if (!node) return;
    const top = viewportTop(node);
    const entry = summary?.closest<HTMLElement>('[data-thinking-detail]') ?? [...node.querySelectorAll<HTMLElement>('[data-thinking-entry]')]
      .find(entry => entry.getBoundingClientRect().bottom > top + 1);
    memory.top = node.scrollTop;
    memory.anchor = entry ? { id: entry.dataset.thinkingDetail ?? entry.dataset.thinkingEntry!, ...(summary ? { detail: true } : {}),
      offset: (summary ?? entry).getBoundingClientRect().top - node.getBoundingClientRect().top } : undefined;
  };
  const pause = () => { memory.open = true; memory.following = false; refresh(); };
  const ctx: ItemContext = { memory: { open: memory.items }, time, running: process.active,
    refresh: pause };
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;
    const restore = () => {
      const height = controls.current?.offsetHeight ?? 0;
      node.style.scrollPaddingTop = `${height + 8}px`;
      applying.current = true;
      if (memory.following) node.scrollTop = node.scrollHeight;
      else {
        let anchor = memory.anchor && node.querySelector<HTMLElement>(memory.anchor.detail
          ? `[data-thinking-detail="${CSS.escape(memory.anchor.id)}"] > summary` : `[data-thinking-entry="${CSS.escape(memory.anchor.id)}"]`);
        if (!anchor && memory.anchor) {
          // Some actions have no disclosure body; their row still provides the exact context position.
          const group = shown.find(row => row.actions && row.actions.length > 1 && row.actions.some(entry => entry.id === memory.anchor!.id));
          const index = group?.actions?.findIndex(entry => entry.id === memory.anchor!.id);
          if (group && index !== undefined) anchor = node.querySelector<HTMLElement>(
            `[data-thinking-entry="${CSS.escape(group.id)}"] > details > .route-items > li:nth-child(${index + 1})`);
        }
        if (anchor) node.scrollTop += anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - memory.anchor!.offset;
        else node.scrollTop = memory.top;
      }
      memory.top = node.scrollTop;
      if (focusContext.current) {
        node.style.scrollMarginTop = `${height + 8}px`;
        node.scrollIntoView({ block: 'start' }); focusContext.current = false;
        node.dispatchEvent(new Event(chatReadingReveal, { bubbles: true }));
      }
      if (focusBody.current) { node.focus({ preventScroll: true }); focusBody.current = false; }
      if (focusSearch.current && searchInput.current) {
        searchInput.current.focus({ preventScroll: true });
        if (focusSearch.current === 'select') searchInput.current.select();
        focusSearch.current = false;
      }
      setOverflow(node.scrollHeight - node.clientHeight > 1);
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => { applying.current = false; });
    };
    restore();
    const observer = new ResizeObserver(restore);
    observer.observe(node); if (content.current) observer.observe(content.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current); applying.current = false; };
  });
  const stopSearch = () => {
    if (!memory.search) return;
    Object.assign(memory, memory.search.reading); memory.search = undefined;
  };
  const returnSearch = () => {
    const previous = memory.searchReturn;
    if (!previous) return;
    Object.assign(memory, previous.reading); memory.view = previous.view; memory.search = previous.search;
    memory.searchReturn = undefined; memory.open = true; memory.following = false;
    focusContext.current = true; focusSearch.current = 'focus'; refresh();
  };
  const toggleSearch = () => {
    if (memory.search) { stopSearch(); focusBody.current = true; }
    else if (memory.searchReturn) { returnSearch(); return; }
    else {
      save(); memory.search = { query: '', reading: { all: memory.all, following: memory.following, top: memory.top, anchor: memory.anchor } };
      memory.open = true; memory.following = false; focusSearch.current = 'focus';
    }
    refresh();
  };
  const moveMatch = (direction: -1 | 1) => {
    if (!memory.search || !query || !visible.length) return;
    const index = selected < 0 ? direction === 1 ? 0 : visible.length - 1 : (selected + direction + visible.length) % visible.length;
    const entry = visible[index]!;
    memory.search.selected = entry.id; memory.open = true; memory.following = false;
    memory.anchor = { id: entry.id, offset: 0 }; memory.top = 0;
    focusContext.current = true; refresh();
  };
  const context = (entry: ThinkingEntry) => {
    if (memory.search) {
      save();
      memory.searchReturn = { search: { ...memory.search, selected: entry.id }, view: memory.view,
        reading: { all: memory.all, following: false, top: memory.top, anchor: memory.anchor } };
    }
    stopSearch(); memory.open = true; memory.following = false;
    memory.anchor = { id: entry.id, offset: 0 }; memory.top = 0;
    if (entry.kind === 'action') {
      memory.items.add(entry.id);
      if (simple) {
        // Search renders each action alone; its context may put it back inside a group the reader folded.
        const index = filtered.findIndex(item => item.id === entry.id);
        let first = index;
        while (first > 0 && filtered[first - 1]!.kind === 'action') first--;
        const grouped = first >= 0 && (first < index || filtered[index + 1]?.kind === 'action');
        if (grouped) {
          memory.groups.set(`group:${filtered[first]!.id}`, true);
          // Grouped ItemRow exposes the action through its details, rather than a top-level entry.
          memory.anchor = { id: entry.id, detail: true, offset: 0 };
        }
      }
    }
    if (entry.kind === 'check' || entry.kind === 'work') memory.checks.set(entry.id, true);
    focusBody.current = true; focusContext.current = true; refresh();
  };
  const filter = (view: Memory['view']) => {
    if (memory.search) stopSearch(); else save();
    if (memory.anchor && view === 'explanations') {
      const index = entries.findIndex(entry => entry.id === memory.anchor!.id);
      if (index >= 0 && entries[index]!.kind !== 'summary' && entries[index]!.kind !== 'work') {
        const next = entries.slice(index).find(entry => entry.kind === 'summary' || entry.kind === 'work')
          ?? entries.slice(0, index).reverse().find(entry => entry.kind === 'summary' || entry.kind === 'work');
        memory.anchor = next ? { id: next.id, offset: 0 } : undefined;
      }
    }
    memory.open = true; memory.view = view; refresh();
  };
  const expand = (value: boolean) => {
    save();
    memory.details = value; memory.groups.clear();
    for (const entry of entries) {
      if (entry.kind === 'action') { if (value) memory.items.add(entry.id); else memory.items.delete(entry.id); }
      if (entry.kind === 'check' || entry.kind === 'work') memory.checks.set(entry.id, value);
    }
    memory.open = true; memory.following = false;
    if (value) memory.all = true;
    refresh();
  };
  return <details class="thinking-process" data-thinking-process={process.key} data-active={process.active} data-thinking-following={memory.following} data-detail={level} open={open}
    onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); event.stopPropagation();
        if (!memory.search) toggleSearch();
        focusSearch.current = 'select'; refresh();
      }
    }}
    onToggle={event => {
      const now = (event.currentTarget as HTMLDetailsElement).open;
      if (now === open) return;
      memory.open = now; refresh();
    }}>
    <summary onClick={() => save()}>
      <span class="thinking-title"><Icon name="brain" /><strong>{proof ? process.active ? t('正在解题…') : t('解题思路与进展') : process.active ? t('正在思考…') : t('思考过程')}</strong>
        <Icon name="chevron-down" /></span>
      {preview && !open && <span class="thinking-preview" role="status" aria-live="polite" aria-atomic="true">{preview}</span>}
    </summary>
    {open && <>
      {entries.length > 0 && <div class="thinking-controls" ref={controls}>
        <div class="thinking-filters" role="group" aria-label={t('显示内容')}>
          <button type="button" data-thinking-filter="all" aria-pressed={memory.view === 'all'} aria-controls={bodyId} onClick={() => filter('all')}>{t('全部记录')}</button>
          <button type="button" data-thinking-filter="explanations" aria-pressed={memory.view === 'explanations'} aria-controls={bodyId} onClick={() => filter('explanations')}>{t('解题说明')}</button>
        </div>
        <div class="thinking-tools">
        {!memory.search && !memory.following && (overflow || newCount > 0) && <button type="button" class="text-button thinking-latest" data-thinking-latest aria-controls={bodyId}
          aria-label={newCount ? t('查看最新进展（{0} 条新记录）', newCount) : t('查看最新进展')}
          title={t('恢复自动跟随最新进展')} onClick={() => {
            memory.open = true; memory.following = true; memory.anchor = undefined; memory.searchReturn = undefined; focusBody.current = true; refresh();
          }}><Icon name="arrow-down" /><span class="thinking-latest-label">{t('查看最新进展')}</span>
          {newCount > 0 && <span class="thinking-new-count" data-thinking-new-count aria-hidden="true">{newCount}</span>}</button>}
        {memory.searchReturn && !memory.search ? <button type="button" class="thinking-search-toggle thinking-search-back" data-thinking-search-back
          aria-label={t('返回搜索结果')} title={t('返回搜索结果：{0}', memory.searchReturn.search.query)} aria-controls={bodyId}
          onClick={returnSearch}><Icon name="arrow-left" /><span>{t('返回搜索结果')}</span></button>
          : <button type="button" class="thinking-search-toggle" data-thinking-search-toggle aria-label={t('查找记录')} title={t('查找记录')}
            aria-expanded={!!memory.search} aria-controls={memory.search ? `${bodyId}-search` : undefined} onClick={toggleSearch}><Icon name="search" /></button>}
        <RecordOptions key={process.key} count={visible.length} level={level} expand={expand} />
        </div>
        {memory.search && <div class="thinking-search" id={`${bodyId}-search`}>
          <label class="sr-only" htmlFor={`${bodyId}-query`}>{memory.view === 'all' ? t('查找全部记录') : t('查找解题说明')}</label>
          <input id={`${bodyId}-query`} ref={searchInput} type="search" data-thinking-query value={memory.search.query} autoComplete="off"
            placeholder={memory.view === 'all' ? t('查找全部记录') : t('查找解题说明')} aria-controls={bodyId}
            onInput={event => {
              memory.search!.query = event.currentTarget.value;
              memory.search!.selected = undefined;
              if (event.currentTarget.value.trim()) { memory.anchor = undefined; memory.top = 0; memory.all = false; }
              else Object.assign(memory, memory.search!.reading);
              memory.following = false; refresh();
            }}
            onKeyDown={event => {
              if (event.isComposing || event.keyCode === 229) return;
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); toggleSearch(); }
              else if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault(); event.stopPropagation(); moveMatch(event.shiftKey ? -1 : 1);
              }
            }} />
          <span class="thinking-search-count" data-thinking-search-position={selected < 0 ? undefined : selected + 1}
            role="status" aria-live="polite" aria-atomic="true" aria-label={selected < 0 ? undefined : t('第 {0} / {1} 条匹配', selected + 1, visible.length)}>
            {selected < 0 ? t('{0} 条匹配', visible.length) : `${selected + 1} / ${visible.length}`}</span>
          <button type="button" data-thinking-search-previous disabled={!query || !visible.length} aria-label={t('上一个匹配')}
            title={t('上一个匹配（Shift+Enter）')} aria-controls={bodyId} onClick={() => moveMatch(-1)}><Icon name="chevron-up" /></button>
          <button type="button" data-thinking-search-next disabled={!query || !visible.length} aria-label={t('下一个匹配')}
            title={t('下一个匹配（Enter）')} aria-controls={bodyId} onClick={() => moveMatch(1)}><Icon name="chevron-down" /></button>
          <button type="button" data-thinking-search-close aria-label={t('结束查找，返回原处')} title={t('结束查找，返回原处')}
            onClick={toggleSearch}><Icon name="x" /></button>
        </div>}
      </div>}
      <div class="thinking-body" id={bodyId} ref={body} tabIndex={0} role="region" aria-label={proof ? t('解题说明与操作记录') : t('思考摘要与操作记录')}
        onWheel={() => { applying.current = false; }} onTouchStart={() => { applying.current = false; }}
        onPointerDown={() => { applying.current = false; }} onKeyDown={() => { applying.current = false; }}
        onClickCapture={event => {
          const summary = (event.target as HTMLElement).closest<HTMLElement>('summary');
          if (summary?.parentElement?.hasAttribute('data-thinking-detail')) save(summary);
          else if (summary?.parentElement?.hasAttribute('data-thinking-version')) save();
        }}
        onScroll={() => {
          if (applying.current || !body.current) return;
          const following = !memory.search && body.current.scrollHeight - body.current.clientHeight - body.current.scrollTop < 32;
          if (following) memory.searchReturn = undefined;
          save(); if (following !== memory.following) { memory.open = true; memory.following = following; refresh(); }
        }}>
        <div class="thinking-content" ref={content}>
        {start > 0 && <button type="button" class="text-button thinking-earlier" onClick={() => {
          save(); memory.open = true; memory.following = false; memory.all = true; focusBody.current = true; refresh();
        }}>{t('查看更早的 {0} 条记录', earlier)}</button>}
        {shown.length ? <ol class="thinking-entries">{shown.map(({ id, entry, actions }) => actions && actions.length > 1
          ? <ActionGroup key={id} id={id} actions={actions} ctx={ctx} memory={memory} />
          : <Entry key={id} entry={entry} ctx={ctx} memory={memory} onCheck={onCheck} simple={simple}
            onQuestion={onQuestion ? step => { save(); pause(); onQuestion(step); } : undefined}
            match={matches.get(entry.id)} selected={selected >= 0 && visible[selected]!.id === entry.id} onContext={() => context(entry)} />)}</ol>
          : <p class="thinking-empty">{query ? t('没有匹配记录，请换一个关键词。') : memory.view === 'explanations' && entries.length ? t('还没有解题说明，可切换到全部记录查看工具操作。')
            : process.active ? t('等待模型返回公开摘要，工具操作会在这里持续更新。') : t('这次没有记录公开摘要或工具操作。')}</p>}
      {process.dropped > 0 && <p class="route-item-note thinking-dropped">{t('记录超过保存上限，之后的 {0} 条没有保存。', process.dropped)}</p>}
        </div>
      </div>
    </>}
  </details>;
}
