import { render, type ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import type { WebAgentLeanCheck } from '../../shared';
import { t } from '../../i18n';
import { checkOutcome, type LiveCheck, type ProcessTone, type SolveProcess, type SolveState } from '../solveProcess';
import { leanLines } from './DetailPanel';
import { LeanReport, base } from './AgentRoute';
import { Elapsed, ToneMark } from './SolveProcess';
import { Icon } from './Icon';

export type LiveWorkspaceProps = {
  process?: SolveProcess;
  /** The check the reader picked; without one the panel follows the latest. */ selected?: string;
  time: (at: string) => string;
  onSelect(id: string | undefined): void;
  onRoadmap?(): void;
};

type Mark = { severity: 'error' | 'warning'; text: string };
/** Lean's errors, or its warnings when there are none, by the line of `file` they are about; `elsewhere` counts the rest. */
function leanMarks(lean: WebAgentLeanCheck | undefined, file: string, count: number) {
  const lines = new Map<number, Mark[]>();
  let elsewhere = 0;
  const errors = lean?.messages.filter(message => message.severity === 'error') ?? [];
  const shown = errors.length ? errors : lean?.messages.filter(message => message.severity === 'warning') ?? [];
  for (const message of shown) {
    const line = message.line;
    if (line === undefined || line < 1 || line > count || (message.file && base(message.file) !== file)) { elsewhere++; continue; }
    const items = lines.get(line) ?? [];
    items.push({ severity: message.severity as Mark['severity'], text: message.text });
    lines.set(line, items);
  }
  return { lines, elsewhere };
}
const markRows = (line: number, items: readonly Mark[]) => <span key={`marks-${line}`} class="lean-marks" data-marks={line}>
  {items.map((item, index) => <span key={index} class="lean-mark" data-severity={item.severity}>
    <span class="lean-mark-title"><Icon name={item.severity === 'error' ? 'circle-alert' : 'triangle-alert'} />
      {item.severity === 'error' ? t('第 {0} 行 · Lean 报错', line) : t('第 {0} 行 · Lean 警告', line)}</span>
    {item.text.split('\n').map((text, row) => <span key={row} class="lean-mark-row">{text || ' '}</span>)}
  </span>)}</span>;

/** What the file view shows for a check: its own file, or the task's current file when the check kept none. */
type FileView = { file: string; source: string; clipped?: boolean; caption: string; note?: string; inline: boolean };
function fileView(process: SolveProcess, check: LiveCheck | undefined, time: (at: string) => string): FileView | undefined {
  const current = process.current;
  const kinds = { statement: t('当前 Lean 陈述'), candidate: t('当前候选'), proof: t('验收证明') };
  const own = current && current.kind === 'candidate' && current.who ? `${kinds.candidate} · ${current.who}` : current ? kinds[current.kind] : '';
  if (check?.source !== undefined) {
    const changed = check.sourceNote === 'changed';
    return { file: check.file ?? 'Submission.lean', source: check.source, ...(check.sourceClipped ? { clipped: true } : {}), inline: !changed,
      caption: `${check.label} · ${time(check.at)}`, ...(changed ? { note: t('这份文件在这次检查之后又改过，Lean 指出的行可能已经移动。') } : {}) };
  }
  if (!current) return;
  return { file: current.file, source: current.source, ...(current.clipped ? { clipped: true } : {}), inline: false,
    caption: current.at ? `${own} · ${time(current.at)}` : own,
    ...(check ? { note: t('这次检查的文件没有单独保存，下面是任务当前的文件。') } : {}) };
}

function Code({ view, lean }: { view: FileView; lean?: WebAgentLeanCheck }) {
  const box = useRef<HTMLDivElement>(null);
  const built = useMemo(() => {
    const text = view.source.replace(/\r\n?/gu, '\n'), count = text.split('\n').length;
    const marks = view.inline ? leanMarks(lean, view.file, count) : { lines: new Map<number, Mark[]>(), elsewhere: 0 };
    // With a map, even an empty one, every line carries its number; a line with marks also has them below it.
    const below = new Map<number, ComponentChildren>([...marks.lines].map(([line, items]) => [line, markRows(line, items)]));
    return { rows: leanLines(text, below), marks };
  }, [view.source, view.file, view.inline, lean]);
  const first = [...built.marks.lines.keys()][0], warning = first !== undefined && built.marks.lines.get(first)![0]!.severity === 'warning';
  const jump = (line: number) => {
    const element = box.current, target = element?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (!element || !target) return;
    element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientHeight / 3;
  };
  // A newly shown check opens at the first line Lean is about; the same check redrawn keeps where the reader is.
  const shown = useRef('');
  useLayoutEffect(() => {
    const key = `${view.caption}\u0000${first ?? ''}`;
    if (shown.current === key) return;
    shown.current = key;
    if (first !== undefined) jump(first); else if (box.current) box.current.scrollTop = 0;
  });
  return <>
    {built.marks.lines.size > 0 && <p class="live-marks" data-severity={warning ? 'warning' : 'error'}><Icon name={warning ? 'triangle-alert' : 'circle-alert'} />
      <span>{warning ? t('Lean 警告在') : t('Lean 报错在')}</span>
      {[...built.marks.lines.keys()].slice(0, 8).map(line => <button key={line} type="button" class="text-button" data-live-line={line} onClick={() => jump(line)}>{t('第 {0} 行', line)}</button>)}</p>}
    <div class="live-code" ref={box} tabIndex={0} aria-label={view.file}>
      <pre translate={false}><code>{built.rows}</code></pre>
    </div>
    {view.clipped && <p class="route-item-note">{t('文件较长，后面的部分没有保存。')}</p>}
    {built.marks.elsewhere > 0 && lean && <details class="live-messages"><summary>{t('另有 {0} 条消息对不上这份文件的行', built.marks.elsewhere)}</summary><LeanReport lean={lean} /></details>}
  </>;
}

const stateTones: Record<SolveState, ProcessTone> = { queued: 'active', formalizing: 'active', proving: 'active', verifying: 'active',
  review: 'done', accepted: 'done', failed: 'failed', stopped: 'stopped', cancelled: 'stopped' };
const checkTones: Record<LiveCheck['state'], ProcessTone> = { running: 'active', passed: 'done', failed: 'failed' };

/**
 * Beside the chat on a wide screen: the Lean file the task is on, with Lean's messages under the lines they are about,
 * and every Lean check so far, newest first. It follows the latest check until the reader picks one.
 */
function LiveWorkspace(props: LiveWorkspaceProps) {
  const { process } = props;
  if (!process) return <div class="live-workspace"><header class="live-head"><h2 id="chat-live-title">{t('实时工作区')}</h2></header>
    <p class="live-empty">{t('题目开始后，这里显示正在写的 Lean 文件和每次检查。')}</p></div>;
  const checks = process.checks, picked = props.selected ? checks.find(check => check.id === props.selected) : undefined;
  const following = !picked, check = picked ?? checks.at(-1), view = fileView(process, check, props.time);
  // Messages the file cannot show under its lines are listed above it.
  const listed = check && (check.lean ? !view?.inline && <LeanReport lean={check.lean} />
    : check.text && <pre class="solve-feedback" tabIndex={0} aria-label={t('反馈全文')} translate={false}>{check.text}</pre>);
  return <div class="live-workspace">
    <header class="live-head">
      <div class="live-heading"><h2 id="chat-live-title">{t('实时工作区')}</h2>
        <p class="live-state"><ToneMark tone={stateTones[process.state]} /><span>{process.label}</span>
          {process.startedAt && <Elapsed from={process.startedAt} to={process.endedAt} />}</p></div>
      {props.onRoadmap && <button type="button" class="text-button" data-live-roadmap onClick={props.onRoadmap}><Icon name="network" />{t('完整记录')}</button>}
    </header>
    <section class="live-file" aria-labelledby="chat-live-file">
      {view ? <p class="live-file-head" id="chat-live-file"><Icon name="file-code-2" /><code translate={false}>{view.file}</code><span>{view.caption}</span></p>
        : <p class="live-file-head" id="chat-live-file">{check ? check.label : t('还没有 Lean 文件。')}</p>}
      {view?.note && <p class="route-item-note live-note">{view.note}</p>}
      {listed}
      {view && <Code view={view} lean={check?.lean} />}
    </section>
    <section class="live-checks" aria-labelledby="chat-live-checks">
      <header><h3 id="chat-live-checks">{t('Lean 检查')} <span>{checks.length}</span></h3>
        {checks.length > 0 && <button type="button" class="text-button" aria-pressed={following} title={t('总是显示最新一次检查')}
          onClick={() => props.onSelect(following ? checks.at(-1)!.id : undefined)}><Icon name="locate-fixed" />{t('跟随最新')}</button>}</header>
      {checks.length ? <ol>{[...checks].reverse().map(item => {
        const outcome = checkOutcome(item);
        return <li key={item.id}><button type="button" class="live-check" data-live-check={item.id} aria-current={item.id === check?.id || undefined}
          onClick={() => props.onSelect(item.id)}><ToneMark tone={checkTones[item.state]} /><span class="live-check-label">{item.label}</span>
          <span class="route-item-outcome" data-tone={outcome.tone}>{outcome.text}</span><time dateTime={item.at}>{props.time(item.at)}</time></button></li>;
      })}</ol> : <p class="live-empty">{process.active ? t('第一次 Lean 检查后会出现在这里。') : t('这个任务没有记录 Lean 检查。')}</p>}
    </section>
  </div>;
}
export function renderLiveWorkspace(root: HTMLElement, props: LiveWorkspaceProps) { render(<LiveWorkspace {...props} />, root); }
