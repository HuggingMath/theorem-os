import { render, type ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { WebFormalization } from '../../formalizationTypes';
import type { WebAgentLeanCheck, WebRun } from '../../shared';
import { t } from '../../i18n';
import { buildProofMap, type ProofMapModel } from '../proofMapModel';
import { checkOutcome, type LiveCheck, type LiveTask, type ProcessTone, type SolveProcess, type SolveState } from '../solveProcess';
import { leanLines } from './DetailPanel';
import { LeanReport, base } from './AgentRoute';
import { Elapsed, ToneMark } from './SolveProcess';
import { Icon, Spinner } from './Icon';
import { ProofMap } from './ProofMap';

export type LiveWorkspaceProps = {
  process?: SolveProcess;
  formalization?: WebFormalization;
  run?: WebRun;
  /** The check the reader picked; without one the panel follows the latest. */ selected?: string;
  time: (at: string) => string;
  onSelect(id: string | undefined): void;
  onRoadmap?(): void;
  /** Opens the full roadmap at one task. */ onTask?(id: string): void;
  /** Addresses a guidance message to one task in the composer; absent while the research takes no guidance. */ onGuide?(taskId: string): void;
  /** Opens the plan editor; absent when the reader cannot change the plan. */ onEditPlan?(): void;
  onOriginal?(): void;
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

function FileActions({ view }: { view: FileView }) {
  const [feedback, setFeedback] = useState<{ view: FileView; kind: 'copied' | 'copy-failed' | 'download-failed' }>();
  // A copy can finish after a stream update or a history selection; its feedback belongs to the file it copied.
  const kind = feedback?.view.source === view.source && feedback.view.file === view.file
    && feedback.view.caption === view.caption && feedback.view.clipped === view.clipped ? feedback.kind : undefined;
  const copyLabel = view.clipped ? t('复制片段') : t('复制代码');
  const downloadLabel = view.clipped ? t('下载片段') : t('下载 Lean');
  async function copy() {
    setFeedback(undefined);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(view.source);
      setFeedback({ view, kind: 'copied' });
    } catch { setFeedback({ view, kind: 'copy-failed' }); }
  }
  function download() {
    setFeedback(undefined);
    try {
      // Use the saved source, not the line-numbered display, which normalizes line endings for Lean's messages.
      const url = URL.createObjectURL(new Blob([view.source], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = view.clipped ? `${base(view.file)}.partial.txt` : base(view.file);
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setFeedback({ view, kind: 'download-failed' }); }
  }
  return <>
    <div class="live-file-actions">
      <button type="button" class="text-button" data-live-copy onClick={() => void copy()} title={`${copyLabel} · ${view.caption}`}>
        <Icon name={kind === 'copied' ? 'check' : 'copy'} /><span class="sr-only">{kind === 'copied' ? t('代码已复制') : copyLabel}</span></button>
      <button type="button" class="text-button" data-live-download onClick={download} title={`${downloadLabel} · ${view.caption}`}>
        <Icon name="download" /><span class="sr-only">{downloadLabel}</span></button>
    </div>
    {kind && <p class="live-file-feedback" role="status" data-error={kind !== 'copied' || undefined}>
      {kind === 'copied' ? t('Lean 源码已复制') : kind === 'copy-failed' ? t('复制失败，请选择代码复制。') : t('下载失败，请重试。')}</p>}
  </>;
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
    {built.marks.lines.size > 1 && <p class="live-marks" data-severity={warning ? 'warning' : 'error'}><Icon name={warning ? 'triangle-alert' : 'circle-alert'} />
      <span>{warning ? t('Lean 警告在') : t('Lean 报错在')}</span>
      {[...built.marks.lines.keys()].slice(0, 8).map(line => <button key={line} type="button" class="text-button" data-live-line={line} onClick={() => jump(line)}>{t('第 {0} 行', line)}</button>)}</p>}
    <div class="live-code" ref={box} tabIndex={0} aria-label={view.file}>
      <pre translate={false}><code>{built.rows}</code></pre>
    </div>
    {view.clipped && <p class="route-item-note">{t('文件较长，后面的部分没有保存。')}</p>}
    {built.marks.elsewhere > 0 && lean && <details class="live-messages"><summary>{t('另有 {0} 条消息对不上这份文件的行', built.marks.elsewhere)}</summary><LeanReport lean={lean} /></details>}
  </>;
}

/** What runs at this moment: one line per working Agent, or the platform's own step. */
function Now({ process, onTask }: { process: SolveProcess; onTask?: (id: string) => void }) {
  if (!process.active || !process.now.length) return null;
  return <section class="live-now" data-live-now aria-labelledby="chat-live-now">
    <h3 id="chat-live-now">{t('正在执行')}</h3>
    <ul>{process.now.map(item => <li key={item.id} data-live-now-item={item.id}>
      <Spinner />{item.who && <strong>{item.who}</strong>}
      <span class="live-now-text">{item.text}{item.code && <> <code translate={false}>{item.code}</code></>}</span>
      {item.task && (onTask ? <button type="button" class="text-button live-now-task" data-live-now-task={item.task.id} translate={false}
        title={t('在路线图中查看这项任务')} onClick={() => onTask(item.task!.id)}>{item.task.label}</button>
        : <span class="live-now-task" translate={false}>{item.task.label}</span>)}
    </li>)}</ul>
  </section>;
}

/** The research plan's tasks, in plan order, with where each one stands. */
function Plan({ process, proofMap, props, hidden }: { process: SolveProcess; proofMap: ProofMapModel; props: LiveWorkspaceProps; hidden: boolean }) {
  const planned = process.tasks.length > 0;
  return <section class="live-plan" data-live-plan id="chat-live-plan-panel" role="tabpanel" aria-labelledby="chat-live-tab-plan" hidden={hidden}>
    <ProofMap key={process.key} model={proofMap} variant="workspace" idPrefix="live-pm" time={props.time} onCheck={id => props.onSelect(id)}
      {...(props.onGuide ? { onGuide: props.onGuide } : {})} {...(props.onTask ? { onTask: props.onTask } : {})}
      {...(props.onEditPlan && planned ? { onEditPlan: props.onEditPlan } : {})} />
  </section>;
}

/** How far the plan is: one segment per task in plan order, then the counts. */
function Progress({ tasks }: { tasks: readonly LiveTask[] }) {
  if (!tasks.length) return null;
  const count = (tone: ProcessTone) => tasks.filter(task => task.tone === tone).length;
  const done = count('done'), running = count('active'), failed = count('failed');
  return <div class="live-progress" data-live-progress>
    <div class="live-progress-bar" aria-hidden="true">{tasks.map(task => <i key={task.id} data-tone={task.tone} title={task.label} />)}</div>
    <p class="live-plan-facts"><span data-live-done>{t('已完成 {0}/{1}', done, tasks.length)}</span>
      {running > 0 && <span>{t('{0} 项进行中', running)}</span>}{failed > 0 && <span data-live-failed>{t('{0} 项未通过', failed)}</span>}</p>
  </div>;
}

type Tab = 'plan' | 'file';
const stateTones: Record<SolveState, ProcessTone> = { queued: 'active', formalizing: 'active', proving: 'active', verifying: 'active',
  review: 'done', accepted: 'done', failed: 'failed', stopped: 'stopped', cancelled: 'stopped' };
const checkTones: Record<LiveCheck['state'], ProcessTone> = { running: 'active', passed: 'done', failed: 'failed' };

/**
 * Beside the chat on a wide screen: how far the plan is and what runs now, then either the route with where each task
 * passed or failed, or the Lean file the task is on with Lean's messages under the lines they are about and every Lean
 * check so far, newest first. The file follows the latest check until the reader picks one.
 */
function LiveWorkspace(props: LiveWorkspaceProps) {
  const { process } = props;
  const proofMap = useMemo(() => process ? buildProofMap({ process,
    ...(props.formalization ? { formalization: props.formalization } : {}), ...(props.run ? { run: props.run } : {}),
  }) : undefined, [process, props.formalization, props.run]);
  if (!process) return <div class="live-workspace"><header class="live-head"><h2 id="chat-live-title">{t('实时工作区')}</h2></header>
    <p class="live-empty">{t('题目开始后，这里显示正在执行的任务、路线图和 Lean 文件。')}</p></div>;
  const checks = process.checks, picked = props.selected ? checks.find(check => check.id === props.selected) : undefined;
  const following = !picked, check = picked ?? checks.at(-1), view = fileView(process, check, props.time);
  const failedChecks = checks.filter(item => item.state === 'failed').length;
  // Messages the file cannot show under its lines are listed above it.
  const listed = check && (check.lean ? !view?.inline && <LeanReport lean={check.lean} />
    : check.text && <pre class="solve-feedback" tabIndex={0} aria-label={t('反馈全文')} translate={false}>{check.text}</pre>);
  // The route and the Lean file take turns in the space below, so neither is squeezed. With a plan the route opens
  // first; picking a Lean check brings its file forward, and the reader's own choice of tab stays for this task.
  const planned = process.tasks.length > 0;
  const [chosen, setChosen] = useState<{ key: string; tab: Tab }>();
  const tab: Tab = chosen?.key === process.key ? chosen.tab : (planned ? 'plan' : 'file');
  const show = (next: Tab) => setChosen({ key: process.key, tab: next });
  const pickedBefore = useRef(props.selected);
  useLayoutEffect(() => {
    if (props.selected && props.selected !== pickedBefore.current) show('file');
    pickedBefore.current = props.selected;
  });
  const latest = checks.at(-1), outcome = latest && latest.state !== 'passed' ? checkOutcome(latest) : undefined;
  const done = process.tasks.filter(task => task.tone === 'done').length;
  return <div class="live-workspace" data-live-tab-shown={tab}>
    <header class="live-head">
      <div class="live-heading"><h2 id="chat-live-title" class="sr-only">{t('实时工作区')}</h2>
        <p class="live-state"><ToneMark tone={stateTones[process.state]} /><span>{process.label}</span>
          {process.startedAt && <Elapsed from={process.startedAt} to={process.endedAt} />}</p></div>
      <div class="live-head-tools">
        {props.onOriginal && <button type="button" class="text-button" data-live-original onClick={props.onOriginal}><Icon name="languages" />{t('原题')}</button>}
        {props.onRoadmap && <button type="button" class="text-button" data-live-roadmap onClick={props.onRoadmap}><Icon name="network" />{t('完整记录')}</button>}
      </div>
    </header>
    <ol class="live-stages" aria-label={t('阶段')}>{process.stages.map(stage => <li key={stage.id} data-live-stage={stage.id} data-tone={stage.tone}
      aria-current={stage.tone === 'active' ? 'step' : undefined}><ToneMark tone={stage.tone} /><span>{stage.label}</span></li>)}</ol>
    <Progress tasks={process.tasks} />
    <Now process={process} {...(props.onTask ? { onTask: props.onTask } : {})} />
    <div class="live-tabs" role="tablist" aria-label={t('实时工作区')}>
      <button type="button" role="tab" id="chat-live-tab-plan" data-live-tab="plan" aria-selected={tab === 'plan'} aria-controls="chat-live-plan-panel"
        onClick={() => show('plan')}>{t('路线图')}{planned && <span class="live-tab-count">{done}/{process.tasks.length}</span>}</button>
      <button type="button" role="tab" id="chat-live-tab-file" data-live-tab="file" aria-selected={tab === 'file'} aria-controls="chat-live-file-panel"
        onClick={() => show('file')}>{t('Lean 文件')}{outcome && <span class="live-tab-outcome" data-tone={outcome.tone}>{outcome.text}</span>}</button>
    </div>
    {proofMap && <Plan key={process.key} process={process} proofMap={proofMap} props={props} hidden={tab !== 'plan'} />}
    <div class="live-file-panel" id="chat-live-file-panel" role="tabpanel" aria-labelledby="chat-live-tab-file" hidden={tab !== 'file'}>
    <section class="live-file" aria-labelledby="chat-live-file">
      {view ? <div class="live-file-toolbar">
        <p class="live-file-head" id="chat-live-file"><Icon name="file-code-2" /><code translate={false}>{view.file}</code><span>{view.caption}</span>
          {view.clipped && <span class="live-excerpt">{t('源码片段')}</span>}</p>
        <FileActions key={`${process.key}\u0000${check?.id ?? 'current'}`} view={view} />
      </div>
        : <p class="live-file-head" id="chat-live-file">{check ? check.label : t('还没有 Lean 文件。')}</p>}
      {view?.note && <p class="route-item-note live-note">{view.note}</p>}
      {listed}
      {view && <Code view={view} lean={check?.lean} />}
    </section>
    <details class="live-checks" aria-labelledby="chat-live-checks">
      <summary><h3 id="chat-live-checks">{t('Lean 检查')} <span>{checks.length}</span></h3>
        {failedChecks > 0 && <span class="live-checks-failed" data-live-checks-failed>{t('{0} 次未通过', failedChecks)}</span>}</summary>
      {checks.length > 0 && <div class="live-checks-tools"><button type="button" class="text-button" aria-pressed={following} title={t('总是显示最新一次检查')}
        onClick={() => props.onSelect(following ? checks.at(-1)!.id : undefined)}><Icon name="locate-fixed" />{t('跟随最新')}</button></div>}
      {checks.length ? <ol>{[...checks].reverse().map(item => {
        const outcome = checkOutcome(item);
        return <li key={item.id}><button type="button" class="live-check" data-live-check={item.id} aria-current={item.id === check?.id || undefined}
          onClick={() => props.onSelect(item.id)}><ToneMark tone={checkTones[item.state]} /><span class="live-check-label">{item.label}</span>
          <span class="route-item-outcome" data-tone={outcome.tone}>{outcome.text}</span><time dateTime={item.at}>{props.time(item.at)}</time></button></li>;
      })}</ol> : <p class="live-empty">{process.active ? t('第一次 Lean 检查后会出现在这里。') : t('这个任务没有记录 Lean 检查。')}</p>}
    </details>
    </div>
  </div>;
}
export function renderLiveWorkspace(root: HTMLElement, props: LiveWorkspaceProps) { render(<LiveWorkspace {...props} />, root); }
