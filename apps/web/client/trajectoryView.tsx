import { render, type ComponentChildren } from 'preact';
import type { WebContinuation, WebEvent, WebRun } from '../shared';
import type { WebExplainAnswer, WebExplainTurn } from '../explain';
import { diagnostics, summarizeGoals, type ReportDiagnostic } from '../report';
import { formatDuration, readableDuration, stoppedLabel } from '../presentation';
import type { TrajectoryPage, TrajectoryPlan, TrajectoryPlanItem, TrajectoryVersion, TrajectoryVersionDetail } from '../trajectory';
import { buildTrajectory, emptyTrajectory, mergeTrajectory, retryRuns, sameWords, stepTasks, trajectoryTally, trajectoryTaskNames, type RecheckResult, type TrajectoryData,
  type TrajectoryOutcome, type TrajectoryStep } from './trajectory';
import { readableMessage } from './activityReader';
import { taskNames } from './agentRoute';
import { kindLabel as taskKindLabel, tokenText, totalTokens } from './collaborationView';
import { leanMarks, leanMessages, sameLeanFile, type LeanMark, type LeanMarks } from './leanMessages';
import { detailLevel, onDetailLevel, setDetailLevel } from './detailLevel';
import { clockTime, errorText, workerNames, workerPhaseLabel, type WebApi } from './collaborationUi';
import { statusLabels } from './researchProgressView';
import { compareSources, type SourceComparison } from './sourceDiff';
import { DiffRows, fill, renderSection } from './ui/Section';
import { leanLines, leanParts } from './ui/DetailPanel';
import { Icon, Spinner } from './ui/Icon';
import { revealSteps } from './motion';
import { SideViewer } from './ui/SideViewer';
import { localizeText, t } from '../i18n';
import { buildResearchRoadmap } from './researchRoadmap';
import { ResearchRoadmap } from './ui/ResearchRoadmap';

// A running run is re-read at most this often; each read only fetches what changed since the last one.
const pollMs = 1_500;
const limits = { runs: 20, versions: 24, chunks: 50, recent: 150, chips: 12, rows: 12, folds: 400, lane: 600, asks: 20 };
// The server's limits on a question and its thread (apps/web/explain.ts webExplainLimits).
const explainLimits = { question: 2_000, turns: 5 };
const general = new Set<TrajectoryStep['kind']>(['problem', 'proof', 'evaluation', 'stop', 'end', 'live']);
// Within this distance of the bottom the reader is at the latest step, and new steps keep the view there.
const followSlack = 48;
const reviewStatuses = new Set(['accepted', 'changes_requested', 'verified', 'failed', 'superseded', 'conditional']);
const deliveryTitles: Record<string, string> = { review: t('审阅意见'), research: t('研究发现'), progress: t('研究进展'), failure: t('失败报告'),
  backtranslation: t('声明回译'), 'statement-review': t('声明审阅') };
const guidanceStatus: Record<string, [string, Tone]> = { queued: [t('排队中'), 'muted'], delivered: [t('已送达'), 'passed'],
  deferred: [t('暂缓'), 'warning'], failed: [t('失败'), 'failed'] };
const planStatus: Record<string, string> = { paused: t('已暂停'), stopped: t('已停止') };

type Tone = 'passed' | 'failed' | 'warning' | 'running' | 'human' | 'muted' | 'plain';
type StepOf<K extends TrajectoryStep['kind']> = Extract<TrajectoryStep, { kind: K }>;
const outcomeTone = (outcome: TrajectoryOutcome): Tone => outcome === 'passed' ? 'passed' : outcome === 'failed' ? 'failed' : outcome === 'conditional' ? 'warning' : 'running';
function stepTone(step: TrajectoryStep): Tone {
  if (step.kind === 'attempt' || step.kind === 'proof' || step.kind === 'evaluation') return outcomeTone(step.outcome);
  if (step.kind === 'recheck') return step.results.some(result => !result.passed) ? 'failed' : 'passed';
  if (step.kind === 'edit') return step.edit.status === 'rejected' ? 'warning' : 'human';
  if (step.kind === 'guidance') return 'human';
  if (step.kind === 'approval') return step.event.type === 'plan_approved' ? 'human' : 'warning';
  if (step.kind === 'delivery') return step.delivery.status === 'accepted' || step.delivery.status === 'verified' ? 'passed'
    : step.delivery.status === 'changes_requested' ? 'warning' : step.delivery.status === 'failed' ? 'failed' : 'plain';
  if (step.kind === 'notice') return 'muted';
  if (step.kind === 'stop') return step.event.type === 'cancelled' ? 'muted' : 'failed';
  if (step.kind === 'end') return step.status === 'error' ? 'failed' : step.status === 'cancelled' ? 'muted' : 'warning';
  if (step.kind === 'live') return 'running';
  return 'plain';
}
// A failed step is marked by a small red dot alone (drawn in CSS): failing is how proving goes, not an alarm.
const toneIcons: Partial<Record<Tone, string>> = { passed: 'check', warning: 'triangle-alert', human: 'user-round' };
const toneText: Partial<Record<Tone, string>> = { passed: t('通过'), failed: t('未通过'), running: t('进行中') };
const modeLabels: Record<Mode, string> = { code: t('看代码'), diff: t('对比上一版'), feedback: t('看 Lean 反馈'), ask: t('问为什么'), finding: t('展开全文') };
const kindIcons: Partial<Record<TrajectoryStep['kind'], string>> = { problem: 'book-open', plan: 'list-ordered' };
function Marker(props: { step: TrajectoryStep; tone: Tone }) {
  const icon = toneIcons[props.tone] ?? kindIcons[props.step.kind];
  return <span class="trajectory-marker" aria-hidden="true">{props.tone === 'running' ? <span class="pulse-dot" /> : icon ? <Icon name={icon} /> : null}</span>;
}
/** The shape of a few steps while the trajectory is first read. */
const StepsLoading = () => <div class="skeleton-block" aria-busy="true">
  <ol class="skeleton-steps" aria-hidden="true">{[58, 76, 44].map(width => <li key={width}><i class="skeleton-dot" /><i style={{ width: `${width}%` }} /></li>)}</ol>
  <p class="trajectory-loading">{t('正在读取…')}</p></div>;
type Mode = 'code' | 'diff' | 'feedback' | 'ask' | 'finding';
type Panel = { key: string; mode: Mode };
/** One stretch of an Agent's work in the time overview: from taking the task (or finishing its last one) to the check. */
type Block = { start: number; end: number; tone: Tone; key: string; label: string };
type Lane = { id: string; name: string; blocks: Block[] };
type Timeline = { start: number; end: number; lanes: Lane[] };
type Item = { step: TrajectoryStep; key: string; index: number };
type Loaded = { status: 'loading' } | { status: 'ready'; revision: number; detail: TrajectoryVersionDetail } | { status: 'failed'; error: string };
/** Where the key for a question comes from; with none, the panel asks for one and keeps it on this page only. */
export type ExplainKey = { source: 'saved'; ending: string } | { source: 'server' } | { source: 'remembered' } | { source: 'none' };
export type ExplainRequest = { taskId: string; commit: string; question: string; turns: WebExplainTurn[]; apiKey?: string };
/** What a reader may do with a run of their own: start a new run from a version, and ask why a version failed. */
export type OwnRunActions = {
  allowed(run: WebRun): boolean;
  start(run: WebRun, from: WebContinuation): void;
  explain?: { key(run: WebRun): ExplainKey; ask(run: WebRun, request: ExplainRequest, signal: AbortSignal): Promise<WebExplainAnswer> };
};
/** One version's questions and answers, kept on the page; nothing is stored on the server. */
type AskTurn = WebExplainTurn & { truncated?: boolean; usage?: WebExplainAnswer['usage'] };
type AskThread = { turns: AskTurn[]; draft: string; pending?: { question: string; controller: AbortController }; error?: string };
type Built = { key: string; steps: TrajectoryStep[]; keys: string[]; names: Map<string, string> };
type RunState = {
  data: TrajectoryData; loaded: boolean; error?: string; inFlight: boolean; lastFetch: number; fetchedFor?: string; timer?: ReturnType<typeof setTimeout>;
  /** The read in flight, for a caller that needs its result. */ pending?: Promise<void>;
  task: string; all: boolean; folded: boolean; panel?: Panel; versions: Map<string, Loaded>; asks: Map<string, AskThread>; built?: Built;
  /** The open version's code: its lines, the number column (blank rows where Lean's messages sit) and the coloured text. */
  code?: { key: string; lines: string[]; numbers: ComponentChildren[]; gaps: Map<number, number>; parts: ComponentChildren[] };
  comparison?: { key: string; value: SourceComparison };
  /** Steps the reader opened or closed, against the default (open unless passed). */ open: Map<string, boolean>;
  /** While the run goes on: whether new steps keep the view at the bottom, and what it was last pinned to. */
  follow: boolean; pinned?: string; seen: Set<string>;
  /** A stretch of the time overview the steps are limited to, and the block the keyboard is on. */
  window?: { start: number; end: number }; cursor?: string;
  mode: 'roadmap' | 'steps'; mapNode?: string;
};
type Ctx = { run: WebRun; state: RunState; names: Map<string, string>; tasks: Map<string, string>; key: string; index: number;
  lastProof?: TrajectoryStep; proofs: number; candidate: boolean; simple: boolean;
  /** Token use of each task, shown on its latest attempt in the detailed view. */ usage: Map<string, number>;
  /** For an attempt inside its task's run of consecutive attempts: whether it is the last of them. */ retry?: { latest: boolean } };
type Content = { title: ComponentChildren; meta?: string[]; badge?: [string, Tone]; body?: ComponentChildren };

const shortName = (name: string) => name.split('.').at(-1) || name;
/** The Lean output of a version's check (`ids`, its receipts; none means all), failed receipts first, each output once. */
function checkEntries(detail: TrajectoryVersionDetail, ids: readonly string[]) {
  const wanted = new Set(ids), checks = detail.checks.filter(check => !wanted.size || wanted.has(check.id))
    .sort((a, b) => Number(a.record.passed === true) - Number(b.record.passed === true));
  const seen = new Set<string>(), entries: (ReportDiagnostic & { theorem?: string })[] = [];
  for (const check of checks) for (const entry of diagnostics(check.record)) {
    if (seen.has(entry.text)) continue;
    seen.add(entry.text);
    entries.push({ ...entry, ...(typeof check.record.theoremName === 'string' ? { theorem: check.record.theoremName } : {}) });
  }
  return entries;
}
/** Lean's messages on the lines of a version's saved code, from its check's output. */
function versionMarks(detail: TrajectoryVersionDetail, ids: readonly string[]): LeanMarks | undefined {
  const source = detail.source;
  if (!source) return;
  const text = source.source.replace(/\r\n?/gu, '\n'), count = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return leanMarks(checkEntries(detail, ids).map(entry => entry.text), source.file, count);
}
/**
 * The number column beside `count` lines: after a line with messages under it (`gaps`, rows by line), as many blank
 * rows as the messages take, and that line's number marked. Blank rows hold a space, so the column ends on its last row.
 */
function lineNumbers(count: number, gaps: ReadonlyMap<number, number>): ComponentChildren[] {
  const parts: ComponentChildren[] = [];
  let text = '';
  for (let line = 1; line <= count; line++) {
    if (line > 1) text += '\n';
    const rows = gaps.get(line);
    if (rows === undefined) { text += line; continue; }
    parts.push(text, <span key={line} class="trajectory-line-marked">{line}</span>);
    text = '\n '.repeat(rows);
  }
  parts.push(text);
  return parts.filter(part => part !== '');
}
const planName = (item: TrajectoryPlanItem, tasks: Map<string, string>) => item.name ? shortName(item.name) : tasks.get(item.id) ?? item.id;
const toneClass = (tone: Tone) => tone === 'running' || tone === 'passed' || tone === 'failed' || tone === 'warning' ? tone : '';
const elapsed = (ms: number) => `+${formatDuration(Math.max(0, ms))}`;
const time = (value: string | undefined) => value ? Date.parse(value) : Number.NaN;
const live = (run: WebRun) => run.status === 'queued' || run.status === 'running';
const atEnd = (viewport: HTMLElement) => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= followSlack;
const settledStep = (step: TrajectoryStep) => stepTone(step) === 'passed';
const outcomeText = (outcome: TrajectoryOutcome, headline?: string) => outcome === 'passed' ? t('Lean 检查通过')
  : outcome === 'conditional' ? t('有条件通过：依赖的任务还没有证完') : outcome === 'running' ? t('检查中') : headline ? t('未通过：{0}', headline) : t('未通过');

/** What a step is, independent of its place in the list, so an open panel stays with its step as the list grows. */
function stepKey(step: TrajectoryStep) {
  const tail = (value: string | number | undefined) => String(value ?? '').replace(/[^\w.-]/gu, '_');
  if (step.kind === 'attempt') return `attempt-${tail(step.taskId)}-${tail(step.ref?.version.commit ?? step.at)}-${step.reused ? 'r' : 'c'}`;
  if (step.kind === 'proof') return `proof-${tail(step.ref?.version.commit ?? step.at)}-${step.assembled ? 'a' : 'd'}`;
  if (step.kind === 'plan') return `plan-${step.plan.observation}`;
  if (step.kind === 'edit') return `edit-${tail(step.edit.id)}`;
  if (step.kind === 'guidance') return `guidance-${tail(step.guidance.id)}`;
  if (step.kind === 'delivery') return `delivery-${tail(step.delivery.id)}`;
  if (step.kind === 'notice' || step.kind === 'stop' || step.kind === 'approval') return `${step.kind}-${step.event.sequence}`;
  return `${step.kind}-${tail(step.at)}`;
}

/** A few names inline, the rest counted; each keeps its full name on hover. */
function Chips(props: { ids: readonly string[]; label: (id: string) => string; full?: (id: string) => string }) {
  const shown = props.ids.slice(0, limits.chips), rest = props.ids.length - shown.length;
  return <span class="trajectory-chips">{shown.map(id => <code key={id} class="trajectory-chip" title={props.full?.(id) ?? id}>{props.label(id)}</code>)}
    {rest > 0 && <span class="trajectory-more">{t('另 {0} 个', rest)}</span>}</span>;
}
/** Where the original targets stood when the run stopped, the result tab's checklist in one line per state. */
function EndGoals({ run }: { run: WebRun }) {
  const goals = summarizeGoals(run)?.goals ?? [];
  const names = (states: readonly string[]) => goals.filter(goal => states.includes(goal.state)).map(goal => goal.name);
  const rows = ([[t('已通过 Lean 检查 {0}'), names(['proved', 'checked']), 'passed'], [t('有条件成立 {0}'), names(['conditional']), 'warning'],
    [t('仍未解决 {0}'), names(['open', 'working', 'planned']), '']] as const).filter(([, ids]) => ids.length);
  if (!rows.length) return null;
  return <>{rows.map(([label, ids, tone]) => <p key={label} class={`trajectory-result ${tone}`} data-end-goals={tone || 'open'}>
    {fill(label, <Chips ids={ids} label={shortName} />)}</p>)}</>;
}
/**
 * The finished run's account under its steps: time, Lean checks, attempts and tasks, then in 详细 one line per Agent on
 * what it did (简洁 leaves out who). It counts the whole run, whatever the task filter or time window shows.
 */
function Tally(props: { run: WebRun; steps: readonly TrajectoryStep[]; data: TrajectoryData; names: Map<string, string>; tasks: Map<string, string>;
  order: readonly string[]; simple: boolean }) {
  const { run } = props, tally = trajectoryTally(props.steps, props.data);
  if (!tally.checks && !tally.attempts) return null;
  const took = time(run.finishedAt) - time(run.createdAt), planned = run.observation?.inspection.tasks.length ?? props.order.length;
  const line = [Number.isFinite(took) ? t('用时 {0}', readableDuration(took)) : '',
    tally.partial ? t('Lean 检查至少 {0} 次', tally.checks) : t('Lean 检查 {0} 次', tally.checks),
    tally.partial ? t('尝试至少 {0} 次', tally.attempts) : t('尝试 {0} 次', tally.attempts),
    planned ? t('任务 {0} 个', planned) : ''].filter(Boolean).join(' · ');
  const rows = props.simple ? [] : tally.agents.map(agent => {
    const parts: ComponentChildren[] = [];
    if (agent.plans) parts.push(t('写了 {0} 版计划', agent.plans));
    if (agent.tasks.length) parts.push(fill(t('做了 {0}'), <Chips ids={agent.tasks} label={id => props.tasks.get(id) ?? id} />),
      t('通过 {0} 个', agent.passed), ...(agent.conditional ? [t('有条件通过 {0} 个', agent.conditional)] : []), t('尝试 {0} 次', agent.attempts));
    if (agent.proofs) parts.push(t('交了 {0} 份完整证明，通过 {1} 份', agent.proofs, agent.provedProofs));
    if (agent.assembled) parts.push(t('组装完整证明 {0} 次', agent.assembled));
    if (agent.reports) parts.push(t('提交 {0} 份报告', agent.reports));
    return parts.length ? <li key={agent.id} data-tally-agent={agent.id}><strong>{props.names.get(agent.id) ?? agent.id}</strong>{' '}
      {parts.flatMap((part, index) => [...index ? [' · '] : [], <span key={index} class="trajectory-tally-part">{part}</span>])}</li> : null;
  }).filter(Boolean);
  return <section class="trajectory-tally" data-trajectory-tally aria-labelledby="trajectory-tally-heading">
    <h4 id="trajectory-tally-heading">{t('全程合计')}</h4>
    <p class="trajectory-tally-line" data-tally-line>{line}</p>
    {rows.length > 0 && <ul class="trajectory-tally-agents">{rows}</ul>}
  </section>;
}
/** The first rows, then the rest folded. */
function Limited(props: { rows: ComponentChildren[]; detailKey: string; class: string }) {
  const shown = props.rows.slice(0, limits.rows), rest = props.rows.slice(limits.rows);
  return <>
    <ul class={props.class}>{shown}</ul>
    {rest.length > 0 && <details class="trajectory-rest" data-detail-key={props.detailKey}><summary>{t('另 {0} 项', rest.length)}</summary><ul class={props.class}>{rest}</ul></details>}
  </>;
}
function PlanItems(props: { items: readonly TrajectoryPlanItem[]; tasks: Map<string, string>; detailKey: string }) {
  const name = (id: string) => props.tasks.get(id) ?? id;
  const rows = props.items.map(item => <li key={item.id}>
    <div class="trajectory-plan-line"><span class="trajectory-kind">{taskKindLabel[item.kind] ?? item.kind}</span>
      <code title={item.name ?? item.id}>{planName(item, props.tasks)}</code>
      {item.dependsOn.length > 0 && <span class="trajectory-dependency">{fill(t('依赖 {0}'), <Chips ids={item.dependsOn} label={name} />)}</span>}
      {item.status && planStatus[item.status] && <span class="badge warning">{planStatus[item.status]}</span>}</div>
    {item.objective && <p class="trajectory-objective">{localizeText(item.objective)}</p>}
  </li>);
  return <Limited rows={rows} detailKey={props.detailKey} class="trajectory-plan" />;
}

/** What one observed revision changed in a task, in the plan's own terms. */
function changes(before: TrajectoryPlanItem, after: TrajectoryPlanItem, tasks: Map<string, string>): ComponentChildren[] {
  const name = (id: string) => tasks.get(id) ?? id, parts: ComponentChildren[] = [];
  if (before.dependsOn.join('\n') !== after.dependsOn.join('\n')) parts.push(after.dependsOn.length
    ? fill(t('改为依赖 {0}'), <Chips ids={after.dependsOn} label={name} />) : t('不再依赖其他任务'));
  if ((before.status ?? 'active') !== (after.status ?? 'active')) parts.push(planStatus[after.status ?? ''] ?? t('恢复'));
  if (before.kind !== after.kind) parts.push(t('改为{0}', taskKindLabel[after.kind] ?? after.kind));
  if (before.objective !== after.objective) {
    const same = sameWords(before.objective, after.objective);
    parts.push(same === 'whole' ? t('目标仅改了空白') : same === 'shown' ? t('目标显示部分仅改了空白') : t('改写目标'));
  }
  return parts.length ? parts : [t('调整细节')];
}
function PlanDiff(props: { plan: TrajectoryPlan; tasks: Map<string, string>; detailKey: string }) {
  const { plan, tasks } = props, name = (id: string) => tasks.get(id) ?? id;
  const row = (key: string, label: string, item: TrajectoryPlanItem, parts: ComponentChildren[], objective?: string) => <li key={key}>
    <div class="trajectory-plan-line"><span class="trajectory-kind">{label}</span><code title={item.name ?? item.id}>{planName(item, tasks)}</code>
      {parts.map((part, index) => <span key={index} class="trajectory-change">{part}</span>)}</div>
    {objective && <p class="trajectory-objective">{localizeText(objective)}</p>}
  </li>;
  const rows = [
    ...plan.added.map(item => row(`added-${item.id}`, t('新增'), item, item.dependsOn.length ? [fill(t('依赖 {0}'), <Chips ids={item.dependsOn} label={name} />)] : [], item.objective)),
    ...plan.changed.map(({ before, after }) => row(`changed-${after.id}`, t('修改'), after, changes(before, after, tasks),
      sameWords(before.objective, after.objective) ? undefined : after.objective)),
    ...plan.removed.map(item => row(`removed-${item.id}`, t('已移除'), item, [])),
  ];
  return <>
    {rows.length > 0 && <Limited rows={rows} detailKey={props.detailKey} class="trajectory-plan" />}
    {plan.omitted > 0 && <p class="trajectory-note">{t('另有 {0} 处调整未列出', plan.omitted)}</p>}
  </>;
}

function Rechecks(props: { results: readonly RecheckResult[]; tasks: Map<string, string> }) {
  return <ul class="trajectory-rechecks">{props.results.map(result => {
    const tone = result.passed ? result.conditional ? 'warning' : 'passed' : 'failed';
    return <li key={result.taskId} class={tone}>{result.passed ? <Icon name="check" /> : <span class="trajectory-dot" aria-hidden="true" />}<code>{props.tasks.get(result.taskId) ?? result.taskId}</code>
      <span>{result.passed ? result.conditional ? t('有条件通过') : t('通过') : result.ref?.check?.headline ? t('未通过：{0}', result.ref.check.headline) : t('未通过')}</span></li>;
  })}</ul>;
}
/**
 * The 简洁 reading: no notices and no reused checks, and a task's failed attempts folded into the attempt after them,
 * whose number still says how many tries it took and whose comparison is with the version before it. A task whose
 * latest attempt failed keeps that one.
 */
function simplify(items: readonly Item[]): Item[] {
  const later = new Set<string>(), kept: Item[] = [];
  for (let position = items.length - 1; position >= 0; position--) {
    const item = items[position]!, step = item.step;
    if (step.kind === 'notice') continue;
    if (step.kind === 'attempt') {
      if (step.reused) continue;
      if (step.outcome === 'failed' && later.has(step.taskId)) continue;
      later.add(step.taskId);
    }
    kept.push(item);
  }
  return kept.reverse();
}

/** Each Agent's attempts, plans and whole proofs as blocks on one time axis, from its steps and the assignments. */
function timeline(items: readonly Item[], events: readonly WebEvent[], run: WebRun, order: readonly string[],
  names: Map<string, string>, tasks: Map<string, string>, now: number): Timeline | undefined {
  const assigned = new Map<string, number[]>();
  for (const event of events) if (event.type === 'task_assigned' && event.details?.workerId) {
    const list = assigned.get(event.details.workerId) ?? [];
    list.push(Date.parse(event.at)); assigned.set(event.details.workerId, list);
  }
  const start = Math.min(time(run.createdAt), ...items.map(item => item.step.at).filter(Number.isFinite));
  const end = live(run) ? Math.max(now, ...items.map(item => item.step.at)) : time(run.finishedAt) || Math.max(...items.map(item => item.step.at));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  const lanes = new Map<string, Block[]>(), last = new Map<string, number>();
  let prior = start;
  const add = (workerId: string, at: number, block: Omit<Block, 'start' | 'end'>) => {
    // A block starts when its Agent last took a task; without one (the Lead assembling, replanning) at the step it
    // answers, taken as the one just before it. Never before the Agent's previous block ended.
    const previous = last.get(workerId) ?? start;
    const taken = (assigned.get(workerId) ?? []).findLast(value => value <= at && value >= previous);
    const blocks = lanes.get(workerId) ?? [];
    blocks.push({ ...block, start: taken ?? Math.min(at, Math.max(previous, prior)), end: at }); lanes.set(workerId, blocks); last.set(workerId, at);
  };
  for (const { step, key } of items) {
    if (step.kind === 'attempt' && step.workerId && !step.reused)
      add(step.workerId, step.at, { key, tone: outcomeTone(step.outcome), label: tasks.get(step.taskId) ?? step.taskId });
    else if (step.kind === 'proof' && step.workerId)
      add(step.workerId, step.at, { key, tone: outcomeTone(step.outcome), label: step.assembled ? t('组装完整证明') : t('完整证明') });
    else if (step.kind === 'plan' && step.workerId)
      add(step.workerId, step.at, { key, tone: 'plain', label: step.first ? t('拟定计划') : t('调整计划') });
    else if (step.kind === 'live') for (const worker of step.workers)
      add(worker.id, end, { key, tone: 'running', label: worker.task ? tasks.get(worker.task) ?? worker.task : workerPhaseLabel(worker.phase) ?? worker.phase });
    if (Number.isFinite(step.at)) prior = Math.max(prior, step.at);
  }
  const ids = [...order.filter(id => lanes.has(id)), ...[...lanes.keys()].filter(id => !order.includes(id))];
  return { start, end, lanes: ids.map(id => ({ id, name: names.get(id) ?? id, blocks: lanes.get(id)!.slice(-limits.lane) })) };
}

/**
 * The 「轨迹」 tab: the run as mathematical steps, from reading the problem to the final acceptance. Pages come from the
 * server's trajectory index (only what changed since the last read); a version's code and Lean feedback are fetched
 * when a step's panel opens.
 */
/** A model's answer as text: fenced blocks become code, `code` and **bold** spans are kept, nothing is read as HTML. */
function Answer(props: { text: string }) {
  const blocks: ComponentChildren[] = [], lines = props.text.replace(/\r\n?/gu, '\n').split('\n');
  let prose: string[] = [], code: string[] | undefined;
  const inline = (text: string) => text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/u).map((part, index) =>
    index % 2 ? part.startsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : <strong key={index}>{part.slice(2, -2)}</strong> : part);
  const paragraphs = () => {
    for (const paragraph of prose.join('\n').split(/\n{2,}/u)) {
      const text = paragraph.replace(/^#{1,6}\s+/gmu, '').trim();
      if (text) blocks.push(<p key={blocks.length}>{inline(text)}</p>);
    }
    prose = [];
  };
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      if (code) { blocks.push(<pre key={blocks.length} class="trajectory-ask-code" tabIndex={0}>{leanParts(code.join('\n'))}</pre>); code = undefined; }
      else { paragraphs(); code = []; }
    } else if (code) code.push(line); else prose.push(line);
  }
  if (code) blocks.push(<pre key={blocks.length} class="trajectory-ask-code" tabIndex={0}>{leanParts(code.join('\n'))}</pre>);
  paragraphs();
  return <div class="trajectory-ask-answer">{blocks}</div>;
}
function AskReply(props: { turn: { question: string; answer: string; truncated?: boolean; usage?: WebExplainAnswer['usage'] } }) {
  const usage = props.turn.usage, tokens = usage?.totalTokens ?? (usage?.inputTokens !== undefined && usage.outputTokens !== undefined
    ? usage.inputTokens + usage.outputTokens : undefined);
  const note = [props.turn.truncated && t('回答过长，只显示前一部分'), tokens !== undefined && t('约 {0} Token', tokenText(tokens)),
    t('这是解释，没有经过 Lean 检查')].filter(Boolean).join(' · ');
  return <li class="trajectory-ask-turn">
    <p class="trajectory-ask-question">{props.turn.question}</p>
    <Answer text={props.turn.answer} />
    <p class="trajectory-note">{note}</p>
  </li>;
}

export class TrajectoryView {
  private states = new Map<string, RunState>();
  private root?: HTMLElement;
  private run?: WebRun;
  /** Result-page overview shares this reader and its per-run cache with the dedicated roadmap tab. */
  private overviewAction?: (nodeId: string) => void;
  private viewport?: HTMLElement;
  private lastTop = 0;
  /** The steps last drawn, and where: which of them are new to a reader following the run. */
  private drawn?: { root: HTMLElement; run: string; keys: Set<string>; data?: string };
  /** A key typed in the ask panel, by provider, for the next questions on this page; never stored. */
  private readonly typedKeys = new Map<string, string>();
  /** The step the result tab asked for, shown once the run's trajectory is read: a task's checked code, or why the latest failed check failed. */
  private wanted?: { runId: string; target: 'checked' | 'failed'; taskIds: readonly string[] };

  /**
   * `guide` opens the run's guidance draft with `text` in it, addressed to `taskId` when given. For runs `own.allowed`
   * accepts (not the sample), `own.start` opens a new draft that starts from a recorded version and `own.explain`
   * answers questions about a failed one.
   */
  constructor(private readonly api: WebApi, private readonly guide?: (run: WebRun, text: string, taskId?: string) => void,
    private readonly own?: OwnRunActions) {
    onDetailLevel(() => this.render());
  }

  /** Shows `run` in `root`; without them the view stops drawing but keeps each run's trajectory for the next visit. */
  update(root?: HTMLElement, run?: WebRun, overviewAction?: (nodeId: string) => void) {
    // The panel drops a tab's host without unmounting what was drawn into it; its effects (the viewer's observers) end here.
    if (this.root && this.root !== root) render(null, this.root);
    // A request for a step is for the view it was made in.
    if (this.wanted && this.wanted.runId !== run?.id) this.wanted = undefined;
    this.overviewAction = overviewAction;
    if (!root || !run) { this.root = undefined; this.run = undefined; return; }
    // A fresh host (another tab, another run) starts again at the latest step while the run goes on.
    if (this.root !== root || this.run?.id !== run.id) { const state = this.state(run.id); state.pinned = undefined; state.follow = true; }
    this.root = root; this.run = run;
    this.watch(root);
    this.schedule(run);
    this.render();
  }

  /** A result-page node opens this same run and its saved details in the roadmap tab. */
  showNode(runId: string, nodeId: string) {
    if (this.run?.id !== runId) return;
    const state = this.state(runId);
    state.mode = 'roadmap'; state.mapNode = nodeId; state.panel = undefined;
    const built = this.built(this.run, state), tasks = new Map([...taskNames(this.run.observation?.inspection.tasks ?? []), ...built.names]);
    const node = buildResearchRoadmap({ data: state.data, steps: built.steps, status: this.run.status, tasks,
      taskDetails: this.run.observation?.inspection.tasks, originalSource: this.run.source }).nodes.find(item => item.id === nodeId);
    const index = node?.stepIndexes.at(-1);
    if (index !== undefined && built.keys[index]) state.open.set(built.keys[index]!, true);
    this.render();
  }

  /** A chat task link opens the recorded node after the first trajectory read, then brings it into view. */
  async showTask(runId: string, taskId: string): Promise<boolean> {
    if (this.run?.id !== runId || !this.run.observation?.inspection.tasks.some(task => task.id === taskId)) return false;
    const root = this.root, state = this.state(runId);
    if (!state.loaded) await this.fetch(runId);
    if (this.run?.id !== runId || this.root !== root || !root?.isConnected) return false;
    this.showNode(runId, `task:${taskId}`);
    const node = root.querySelector<HTMLElement>(`[data-roadmap-node="task:${CSS.escape(taskId)}"]`);
    if (!node) return false;
    node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    node.focus({ preventScroll: true });
    return true;
  }

  /**
   * Opens a step of the run the view is showing. `checked`: the code of the latest attempt of `taskIds` that passed its
   * Lean check, for a goal the run checked but did not get accepted. `failed`: the latest failed check of those tasks,
   * at 问为什么 when it can be asked, else at Lean's feedback. Without a matching step the steps are limited to the first task.
   */
  showStep(runId: string, target: 'checked' | 'failed', taskIds: readonly string[]) {
    if (this.run?.id !== runId || !taskIds.length) return;
    this.wanted = { runId, target, taskIds };
    this.render();
  }
  private settleWanted(run: WebRun, state: RunState) {
    const wanted = this.wanted;
    if (!wanted || wanted.runId !== run.id || !state.loaded || state.inFlight || state.fetchedFor !== this.mark(run)) return;
    this.wanted = undefined;
    state.mode = 'steps';
    const outcome = wanted.target === 'checked' ? 'passed' : 'failed';
    const built = this.built(run, state), index = built.steps.findLastIndex(step => step.kind === 'attempt' && wanted.taskIds.includes(step.taskId)
      && step.outcome === outcome && !step.reused);
    const step = built.steps[index];
    if (!step) { state.task = wanted.taskIds[0]!; state.all = false; state.follow = false; return; }
    const key = built.keys[index]!, modes = this.modes(step, run);
    const mode = (wanted.target === 'checked' ? ['code'] as const : ['ask', 'feedback', 'code'] as const).find(item => modes.includes(item));
    if (mode) state.panel = { key, mode };
    queueMicrotask(() => {
      this.reveal(key);
      if (mode === 'ask') this.root?.querySelector<HTMLElement>('#trajectory-viewer [data-ask-question]')?.focus({ preventScroll: true });
    });
  }

  /**
   * The latest version of `taskIds` that passed its own Lean check and whose code was saved, as a new run's starting
   * point, reading the run's trajectory first when the view has not; undefined when none was saved.
   */
  async checkedContinuation(run: WebRun, taskIds: readonly string[]): Promise<WebContinuation | undefined> {
    const state = this.state(run.id);
    if (state.pending) await state.pending;
    if (!state.loaded || state.fetchedFor !== this.mark(run)) await this.fetch(run.id, run);
    if (state.error) throw new Error(state.error);
    const built = this.built(run, state), names = new Map([...taskNames(run.observation?.inspection.tasks ?? []), ...built.names]);
    const step = built.steps.findLast((item): item is StepOf<'attempt'> => item.kind === 'attempt' && taskIds.includes(item.taskId)
      && item.outcome === 'passed' && !item.reused && item.ref?.version.source !== undefined);
    const version = step?.ref?.version;
    if (!step || !version) return;
    const label = `${names.get(step.taskId) ?? step.taskId} · ${t('第 {0} 次', step.number)}`;
    return { runId: run.id, taskId: version.taskId, commit: version.commit, label: label.slice(0, 200) };
  }

  /** Scrolling up while the run goes on stops following the latest step; scrolling back to the bottom resumes it. */
  private watch(root: HTMLElement) {
    const viewport = root.closest<HTMLElement>('.detail-panel') ?? root;
    if (this.viewport === viewport) return;
    this.viewport = viewport; this.lastTop = viewport.scrollTop;
    viewport.addEventListener('scroll', () => {
      const top = viewport.scrollTop, up = top < this.lastTop - 1;
      this.lastTop = top;
      const run = this.run;
      if (!run || !live(run) || !this.root || !viewport.contains(this.root) || this.overviewAction || this.state(run.id).mode === 'roadmap') return;
      const state = this.state(run.id), follow = atEnd(viewport) || state.follow && !up;
      if (follow === state.follow) return;
      state.follow = follow;
      if (follow) state.pinned = undefined;
      this.render();
    }, { passive: true });
  }

  private state(id: string) {
    let state = this.states.get(id);
    if (state) { this.states.delete(id); this.states.set(id, state); return state; }
    state = { data: emptyTrajectory(), loaded: false, inFlight: false, lastFetch: 0, task: '', all: false, folded: true, versions: new Map(),
      asks: new Map(), open: new Map(), follow: true, seen: new Set(), mode: 'roadmap' };
    this.states.set(id, state);
    for (const [old, item] of this.states) { if (this.states.size <= limits.runs) break; clearTimeout(item.timer); this.states.delete(old); }
    return state;
  }

  /** What the server may have new for: a different mark than the last complete read means read again. */
  private mark(run: WebRun) { return `${run.status}\u0000${run.updatedAt}\u0000${run.events.at(-1)?.sequence ?? 0}\u0000${run.observation?.sequence ?? 0}`; }

  private schedule(run: WebRun) {
    const state = this.state(run.id);
    if (state.inFlight || state.timer || state.fetchedFor === this.mark(run)) return;
    const wait = state.lastFetch + pollMs - Date.now();
    if (wait <= 0) { void this.fetch(run.id); return; }
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.run?.id === run.id) this.schedule(this.run);
    }, wait);
  }

  private fetch(id: string, run = this.run?.id === id ? this.run : undefined) {
    const state = this.state(id);
    return state.pending ??= this.read(id, state, run && this.mark(run));
  }
  private async read(id: string, state: RunState, wanted?: string) {
    state.inFlight = true; state.lastFetch = Date.now();
    let complete = false;
    try {
      for (let chunk = 0; chunk < limits.chunks && !complete; chunk++) {
        const query = new URLSearchParams({ after: String(state.data.cursor), since: String(state.data.revision), ...(state.data.instance ? { instance: state.data.instance } : {}) });
        const { trajectory } = await this.api<{ trajectory: TrajectoryPage }>(`/api/runs/${encodeURIComponent(id)}/trajectory?${query}`);
        state.data = mergeTrajectory(state.data, trajectory);
        state.loaded = true; state.error = undefined;
        complete = !trajectory.more;
        if (!complete && this.states.get(id) === state && this.run?.id === id) this.render();
      }
    } catch (error) {
      state.error = errorText(error);
      // A failed read is retried when the run changes or on request, not in a loop.
      complete = true;
    } finally {
      // Cleared before scheduling, so a read the run's next change asks for is a new one.
      state.inFlight = false; state.pending = undefined;
      if (complete) state.fetchedFor = wanted;
      if (this.run?.id === id) { this.schedule(this.run); this.render(); }
    }
  }
  private render() {
    if (!this.root || !this.run) return;
    const state = this.state(this.run.id);
    this.settleWanted(this.run, state);
    renderSection(this.root, this.view(this.run, state));
    // While following, each new step brings the view to the bottom; a reader's own changes (opening a step) do not.
    const viewport = this.viewport, mark = this.root.querySelector<HTMLElement>('.trajectory-steps')?.dataset.latest;
    if (viewport && !this.overviewAction && state.mode === 'steps' && live(this.run) && state.follow && !state.window && mark && mark !== state.pinned) {
      state.pinned = mark;
      viewport.scrollTop = viewport.scrollHeight;
      this.lastTop = viewport.scrollTop;
    }
    this.cueSteps(state);
  }
  /**
   * The first steps drawn in a host cascade in; after that only steps new to the data move, and only for a reader
   * following a live run. Reading choices (detail, filters, folds, earlier steps) show steps in place. The step in
   * progress changes every moment and never counts as new; a run of attempts that only regrouped old ones does not either.
   */
  private cueSteps(state: RunState) {
    if (state.mode === 'roadmap' || this.overviewAction) return;
    const root = this.root!, run = this.run!, steps = [...root.querySelectorAll<HTMLElement>('.trajectory-step[data-step]')];
    const keys = new Set(steps.filter(step => step.dataset.kind !== 'live').map(step => step.dataset.step!));
    const before = this.drawn, data = state.built?.key;
    const first = !before || before.root !== root || before.run !== run.id || !before.keys.size;
    this.drawn = { root, run: run.id, keys, data };
    if (!keys.size) return;
    if (first) { revealSteps(root, steps, this.viewport, false); return; }
    if (!live(run) || !state.follow || state.window || data === before.data) return;
    const fresh = steps.slice(-20).filter(step => step.dataset.kind !== 'live' && !before.keys.has(step.dataset.step!)
      && [...step.querySelectorAll<HTMLElement>('.trajectory-step[data-step]')].every(inner => !before.keys.has(inner.dataset.step!)));
    const outer = fresh.filter(step => !fresh.some(other => other !== step && other.contains(step)));
    if (outer.length) revealSteps(root, outer, this.viewport, true);
  }

  /** Steps are rebuilt only when the data, the run's status or its live Agents change. */
  private built(run: WebRun, state: RunState): Built {
    const live = run.status === 'running' ? (run.observation?.inspection.workers ?? []).map(worker => ({ id: worker.id, phase: worker.phase, task: worker.task })) : [];
    const key = JSON.stringify([state.data.instance, state.data.revision, state.data.cursor, run.status, run.createdAt, run.finishedAt, live]);
    if (state.built?.key === key) return state.built;
    const steps = buildTrajectory({ data: state.data, status: run.status, createdAt: run.createdAt, finishedAt: run.finishedAt, live });
    const seen = new Map<string, number>();
    const keys = steps.map(step => {
      const base = stepKey(step), count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return count ? `${base}-${count}` : base;
    });
    state.built = { key, steps, keys, names: trajectoryTaskNames(state.data) };
    return state.built;
  }

  private view(run: WebRun, state: RunState) {
    const retry = () => { state.fetchedFor = undefined; state.lastFetch = 0; state.error = undefined; this.update(this.root, this.run, this.overviewAction); };
    const simple = detailLevel() === 'simple';
    // The same 简洁/详细 choice as the collaboration surface (./detailLevel); switching here switches both.
    const level = <div class="collab-detail-toggle trajectory-detail-toggle" role="group" aria-label={t('信息详略')} title={t('简洁和详细对协作与轨迹同时生效')}>
      {(['simple', 'full'] as const).map(value => <button key={value} type="button" aria-pressed={(value === 'simple') === simple} data-trajectory-detail={value}
        data-focus-key={`trajectory-detail-${value}`} onClick={() => setDetailLevel(value)}>{value === 'simple' ? t('简洁') : t('详细')}</button>)}</div>;
    const heading = (summary?: string) => <div class="trajectory-heading"><h3>{state.mode === 'roadmap' ? t('解题路线图') : t('解题轨迹')}</h3>
      {summary && <span class="trajectory-summary">{summary}</span>}
      <div class="trajectory-view-toggle" role="group" aria-label={t('显示方式')}>
        {(['roadmap', 'steps'] as const).map(mode => <button key={mode} type="button" data-trajectory-view={mode}
          aria-pressed={state.mode === mode} onClick={() => { state.mode = mode; state.panel = undefined; state.pinned = undefined; this.render(); }}>
          <Icon name={mode === 'roadmap' ? 'git-branch' : 'list-ordered'} />{mode === 'roadmap' ? t('路线图') : t('事件明细')}</button>)}</div>
      {state.mode === 'steps' && level}</div>;
    const failure = state.error && <p class="trajectory-error" role="status">{t('读取失败：{0}', state.error)}
      <button type="button" class="text-button" data-focus-key="trajectory-retry" onClick={retry}>{t('重试')}</button></p>;
    if (!state.loaded) return <section class="trajectory" aria-busy={!state.error}>{!this.overviewAction && heading()}
      {failure || <StepsLoading />}</section>;

    const built = this.built(run, state), names = workerNames(state.data.context.workers.length ? state.data.context.workers : run.observation?.inspection.workers);
    // The latest observation names tasks the fetched plans do not reach yet, such as the one an Agent just took.
    const tasks = new Map([...taskNames(run.observation?.inspection.tasks ?? []), ...built.names]), order: string[] = [];
    for (const step of built.steps) for (const id of stepTasks(step)) if (!order.includes(id)) order.push(id);
    if (state.task && !order.includes(state.task)) state.task = '';
    const items: Item[] = built.steps.map((step, index) => ({ step, key: built.keys[index]!, index }));
    const readable = simple ? simplify(items) : items, span = state.window;
    const picked = readable.filter(({ step }) => (!state.task || general.has(step.kind) || stepTasks(step).includes(state.task))
      && (!span || step.kind === 'live' || step.at >= span.start && step.at <= span.end));
    const hidden = state.all || span ? 0 : Math.max(0, picked.length - limits.recent), shown = picked.slice(hidden);
    const started = time(run.createdAt), finished = time(run.finishedAt);
    const proofs = built.steps.filter(step => step.kind === 'proof' && !step.assembled).length;
    const lastProof = built.steps.findLast(step => step.kind === 'proof');
    // Token use is per task; it is shown once, on the task's latest attempt.
    const usage = new Map<string, number>();
    if (!simple) {
      const tokens = new Map((run.observation?.inspection.tasks ?? []).map(task => [task.id, totalTokens(task.usage)] as const));
      const done = new Set<string>();
      for (const { step, key } of [...items].reverse()) if (step.kind === 'attempt' && !done.has(step.taskId)) {
        done.add(step.taskId);
        const value = tokens.get(step.taskId);
        if (value !== undefined) usage.set(key, value);
      }
    }
    const ctx = { run, state, names, tasks, lastProof, proofs, candidate: Boolean(run.result?.proof || run.artifact?.source), simple, usage };
    const runTokens = simple ? undefined : totalTokens(run.observation?.inspection.usage as Record<string, number> | undefined);
    const summary = [Number.isFinite(finished - started) ? t('{0} 步 · 用时 {1}', readable.length, readableDuration(finished - started)) : t('{0} 步', readable.length),
      runTokens !== undefined ? t('Token {0}', tokenText(runTokens)) : ''].filter(Boolean).join(' · ');
    const choose = (event: Event) => { state.task = (event.currentTarget as HTMLSelectElement).value; state.all = false; this.render(); };
    // What the bottom of the list is: a new step, or a change in who is working, moves a following view down.
    const counted = picked.filter(item => item.step.kind !== 'live'), tail = shown.at(-1)?.step;
    // New is any step not on the list while it was followed: a later attempt can take the place of a failed one.
    if (!live(run) || state.follow) state.seen = new Set(items.filter(item => item.step.kind !== 'live').map(item => item.key));
    const unseen = counted.filter(item => !state.seen.has(item.key)).length;
    const latest = `${counted.at(-1)?.key ?? ''}\u0000${counted.length}\u0000${tail?.kind === 'live' ? `${tail.workers.map(item => `${item.id}/${item.phase}/${item.task ?? ''}`).join(',')}/${run.events.at(-1)?.sequence ?? ''}` : ''}`;
    const origin = time(run.createdAt), now = built.steps.at(-1);
    // The tasks an Agent is on right now: their runs of attempts stay open.
    const working = new Set(now?.kind === 'live' ? now.workers.flatMap(item => item.task ? [item.task] : []) : []);
    // The account waits for a complete read made after the run ended, so it never counts a run still being read.
    const settled = !live(run) && !state.inFlight && !state.error && state.fetchedFor?.startsWith(`${run.status}\u0000`);
    if (state.mode === 'roadmap' || this.overviewAction) {
      const model = buildResearchRoadmap({ data: state.data, steps: built.steps, status: run.status, tasks,
        taskDetails: run.observation?.inspection.tasks, originalSource: run.source });
      const selected = model.nodes.find(node => node.id === state.mapNode);
      const selectedTask = selected?.taskId && run.observation?.inspection.tasks.find(task => task.id === selected.taskId);
      const details = (selected?.stepIndexes ?? []).map(index => items[index]).filter((item): item is Item => Boolean(item));
      return <div class="trajectory-layout" data-mode="roadmap" data-viewer-host>
        <section class="trajectory trajectory-roadmap">
          {!this.overviewAction && heading()}{failure}
          <ResearchRoadmap key={run.id} model={model} names={names} selected={selected?.id} onSelect={id => {
            if (this.overviewAction) this.overviewAction(id); else this.showNode(run.id, id);
          }} />
          {!this.overviewAction && selected && <section class="roadmap-detail" aria-label={t('节点详情')}>
            <header><div><span>{t('节点详情')}</span><h4>{selected.theoremName ?? selected.title}</h4></div>
              <button type="button" class="icon-button" aria-label={t('关闭节点详情')}
                onClick={() => { state.mapNode = undefined; state.panel = undefined; this.render(); }}><Icon name="x" /></button></header>
            {selected.kind === 'task' && (selected.statement || selected.type || selected.objective) && <div class="roadmap-detail-summary">
              {selected.statement && <p>{localizeText(selected.statement)}</p>}
              {selected.type && <code class="roadmap-node-type">{selected.type}</code>}
              {selected.objective && selected.objective !== selected.statement && <p>{localizeText(selected.objective)}</p>}
            </div>}
            {selectedTask && <div class="roadmap-detail-actions">
              <button type="button" class="button" data-action="show-task-source" data-task-id={selectedTask.id}><Icon name="file-code-2" />{t('Lean 源码')}</button>
              <button type="button" class="button" data-action="inspect-task" data-task-id={selectedTask.id}><Icon name="list-tree" />{t('任务详情')}</button>
              <button type="button" class="button" data-action="show-statement-review" data-task-id={selectedTask.id}><Icon name="languages" />{t('原意与 Lean')}</button>
              {run.status === 'running' && this.own?.allowed(run) && <button type="button" class="button" data-action="guide-task" data-task-id={selectedTask.id}><Icon name="message-square" />{t('指导此任务')}</button>}
            </div>}
            {details.length > 0 ? <ol class="trajectory-steps">{details.map(item => this.step({ ...ctx, key: item.key, index: item.index }, item.step))}</ol>
              : <p class="trajectory-note">{selected.detail || t('这个节点还没有检查记录。')}</p>}
          </section>}
        </section>
        {!this.overviewAction && this.viewer({ ...ctx, key: '', index: -1 }, built)}
      </div>;
    }
    return <div class="trajectory-layout" data-viewer-host>
      <section class="trajectory">
        {heading(summary)}
        {!simple && this.overview(run, state, items, names, tasks)}
        {(order.length > 1 || span) && <div class="trajectory-filters">
          {order.length > 1 && <label class="trajectory-filter"><span>{t('只看')}</span>
            <select data-focus-key="trajectory-task" value={state.task} onChange={choose}>
              <option value="">{t('全部任务')}</option>
              {order.map(id => <option key={id} value={id}>{tasks.get(id) ?? id}</option>)}
            </select></label>}
          {span && <p class="trajectory-window" role="status"><Icon name="clock-3" />
            <span>{t('只看 {0} 到 {1} 之间的步骤', elapsed(span.start - origin), elapsed(span.end - origin))}</span>
            <button type="button" class="text-button" data-focus-key="trajectory-window-clear" onClick={() => this.setWindow(undefined)}>{t('看全部')}</button></p>}
        </div>}
        {failure}
        {hidden > 0 && <button type="button" class="text-button trajectory-earlier" data-focus-key="trajectory-earlier"
          onClick={() => { state.all = true; this.render(); this.root?.querySelector<HTMLElement>('.trajectory-step')?.focus({ preventScroll: true }); }}>
          {t('显示更早的 {0} 步', hidden)}</button>}
        {!hidden && Object.values(state.data.dropped).some(Boolean) && <p class="trajectory-note">{t('这次运行很长，最早的一部分记录超出保留范围，没有显示。')}</p>}
        {shown.length ? <ol class="trajectory-steps" data-latest={latest}>{simple ? shown.map(item => this.step({ ...ctx, key: item.key, index: item.index }, item.step))
          : retryRuns(shown).map(run => run.length > 1 ? this.retries(ctx, run, working) : this.step({ ...ctx, key: run[0]!.key, index: run[0]!.index }, run[0]!.step))}</ol>
          : <p class="trajectory-empty">{span ? t('这段时间里没有步骤。') : live(run) ? t('还没有可显示的步骤，Agent 开始工作后会出现在这里。') : t('这次运行没有记录到解题步骤。')}</p>}
        {settled && <Tally run={run} steps={built.steps} data={state.data} names={names} tasks={tasks} order={order} simple={simple} />}
        {live(run) && !state.follow && shown.length > 0 && <button type="button" class="trajectory-latest" data-focus-key="trajectory-latest" onClick={() => this.latest()}>
          <Icon name="arrow-down" />{unseen ? t('回到最新 · 新增 {0} 步', unseen) : t('回到最新')}</button>}
      </section>
      {this.viewer({ ...ctx, key: '', index: -1 }, built)}
    </div>;
  }
  private step(ctx: Ctx, step: TrajectoryStep) {
    const tone = stepTone(step), content = this.content(ctx, step);
    const at = Number.isFinite(step.at) ? new Date(step.at) : undefined, origin = time(ctx.run.createdAt);
    // Settled steps fold to their title line; running and failed ones stay open. The reader's own choice wins.
    // Inside a run of attempts only the last stays open by default, and only while it has not passed.
    const unsettled = !settledStep(step) && (!ctx.retry || ctx.retry.latest);
    const foldable = Boolean(content.body), open = !foldable || (ctx.state.open.get(ctx.key) ?? unsettled), body = `trajectory-body-${ctx.index}`;
    const title = <>{content.title}{content.meta?.filter(Boolean).map((item, index) => <span key={index} class="trajectory-meta">{item}</span>)}
      {content.badge && <span class={`badge ${toneClass(content.badge[1])}`}>{content.badge[0]}</span>}
      {!open && toneText[tone] && <span class="sr-only">{toneText[tone]}</span>}</>;
    return <li key={ctx.key} class="trajectory-step" data-kind={step.kind} data-tone={tone} data-step={ctx.key} data-open={foldable ? String(open) : undefined} tabIndex={-1}>
      <Marker step={step} tone={tone} />
      <div class="trajectory-main">
        <div class="trajectory-line">
          <h4>{foldable ? <button type="button" class="trajectory-fold" aria-expanded={open} aria-controls={open ? body : undefined}
            data-focus-key={`${ctx.key}-fold`} onClick={() => this.fold(ctx.key, !open)}>{title}<Icon name="chevron-right" /></button> : title}</h4>
          {at && step.kind !== 'live' && <time dateTime={at.toISOString()} title={clockTime(at.toISOString())}>{elapsed(step.at - origin)}</time>}
        </div>
        {open && foldable && <div class="trajectory-body" id={body}>{content.body}</div>}
      </div>
    </li>;
  }
  /**
   * 详细: a task's consecutive attempts as one line, 「zero_add · 第 1–3 次 · 第 3 次通过」, opening to each attempt. The run
   * folds once its last attempt passed, unless an Agent is on the task again; the reader's own choice wins.
   */
  private retries(ctx: Omit<Ctx, 'key' | 'index'>, run: readonly Item[], working: ReadonlySet<string>) {
    const last = run.at(-1)!, step = last.step as StepOf<'attempt'>, first = run[0]!.step as StepOf<'attempt'>, tone = stepTone(step);
    const key = `retry-${run[0]!.key}`, body = `trajectory-body-retry-${run[0]!.index}`;
    const open = ctx.state.open.get(key) ?? (!settledStep(step) || working.has(step.taskId) && live(ctx.run));
    const workers = new Set(run.map(item => (item.step as StepOf<'attempt'>).workerId));
    const worker = !ctx.simple && workers.size === 1 && step.workerId ? ctx.names.get(step.workerId) ?? step.workerId : '';
    const span = first.number === 1 ? t('试了 {0} 次', run.length) : t('第 {0}–{1} 次', first.number, step.number);
    const result = step.outcome === 'passed' ? t('第 {0} 次通过', step.number) : step.outcome === 'conditional' ? t('第 {0} 次有条件通过', step.number)
      : step.outcome === 'running' ? t('第 {0} 次检查中', step.number)
        : run.every(item => (item.step as StepOf<'attempt'>).outcome === 'failed') ? t('都没通过') : t('第 {0} 次没通过', step.number);
    const badge: Content['badge'] = step.integrated ? [t('已集成'), 'passed'] : step.reused ? [t('沿用上次检查'), 'muted'] : undefined;
    const at = Number.isFinite(step.at) ? new Date(step.at) : undefined, origin = time(ctx.run.createdAt);
    const title = <><code class="trajectory-task">{ctx.tasks.get(step.taskId) ?? step.taskId}</code>
      {[worker, span, result].filter(Boolean).map((item, index) => <span key={index} class="trajectory-meta">{item}</span>)}
      {badge && <span class={`badge ${toneClass(badge[1])}`}>{badge[0]}</span>}
      {!open && toneText[tone] && <span class="sr-only">{toneText[tone]}</span>}</>;
    return <li key={key} class="trajectory-step" data-kind="retries" data-tone={tone} data-step={key} data-open={String(open)} data-retries={run.length} tabIndex={-1}>
      <Marker step={step} tone={tone} />
      <div class="trajectory-main">
        <div class="trajectory-line">
          <h4><button type="button" class="trajectory-fold" aria-expanded={open} aria-controls={open ? body : undefined}
            data-focus-key={`${key}-fold`} onClick={() => this.fold(key, !open)}>{title}<Icon name="chevron-right" /></button></h4>
          {at && <time dateTime={at.toISOString()} title={clockTime(at.toISOString())}>{elapsed(step.at - origin)}</time>}
        </div>
        {open && <ol class="trajectory-steps trajectory-retries" id={body}>
          {run.map(item => this.step({ ...ctx, key: item.key, index: item.index, retry: { latest: item === last } }, item.step))}</ol>}
      </div>
    </li>;
  }
  private fold(key: string, open: boolean) {
    if (!this.run) return;
    const map = this.state(this.run.id).open;
    map.delete(key); map.set(key, open);
    for (const old of map.keys()) { if (map.size <= limits.folds) break; map.delete(old); }
    this.render();
  }
  /** 回到最新: follow the run again from its latest step. */
  private latest() {
    if (!this.run) return;
    const state = this.state(this.run.id);
    state.follow = true; state.pinned = undefined; state.window = undefined;
    this.render();
    this.root?.querySelector<HTMLElement>('.trajectory-steps>.trajectory-step:last-child')?.focus({ preventScroll: true });
  }
  private setWindow(window?: { start: number; end: number }) {
    if (!this.run) return;
    const state = this.state(this.run.id);
    state.window = window; state.pinned = undefined;
    this.render();
  }
  /** Shows one step (from the time overview): clears what hides it, opens it and brings it into view. */
  private reveal(key: string) {
    if (!this.run) return;
    const state = this.state(this.run.id), built = state.built, step = built?.steps[built.keys.indexOf(key)];
    if (!step) return;
    state.mode = 'steps';
    if (state.window && (step.at < state.window.start || step.at > state.window.end)) state.window = undefined;
    if (state.task && !general.has(step.kind) && !stepTasks(step).includes(state.task)) state.task = '';
    state.all = true; state.follow = false; state.open.set(key, true);
    // In 详细 the step may sit inside its task's run of attempts, which opens with it.
    if (detailLevel() === 'full') {
      const run = retryRuns(built.steps.map((item, index) => ({ step: item, key: built.keys[index]! }))).find(items => items.length > 1 && items.some(item => item.key === key));
      if (run) state.open.set(`retry-${run[0]!.key}`, true);
    }
    this.render();
    const item = this.root?.querySelector<HTMLElement>(`.trajectory-step[data-step="${CSS.escape(key)}"]`);
    item?.scrollIntoView({ block: 'center' }); item?.focus({ preventScroll: true });
  }

  private content(ctx: Ctx, step: TrajectoryStep): Content {
    const { tasks, names } = ctx, task = (id: string) => tasks.get(id) ?? id;
    const named = (id?: string) => id ? names.get(id) ?? id : undefined, worker = (id?: string) => ctx.simple ? undefined : named(id);
    switch (step.kind) {
      case 'problem': return { title: t('读题'), body: step.targets.length > 0 && <p class="trajectory-result">{fill(t('要证明 {0}'), <Chips ids={step.targets} label={shortName} />)}</p> };
      case 'plan': return { title: step.first ? t('拟定计划') : t('调整计划'), meta: [worker(step.workerId) ?? ''],
        body: step.first ? <PlanItems items={step.plan.added} tasks={tasks} detailKey={`${ctx.key}-plan`} /> : <PlanDiff plan={step.plan} tasks={tasks} detailKey={`${ctx.key}-plan`} /> };
      // Inside its run the task is named once, on the run's line; each attempt is its number and how it went.
      case 'attempt': if (ctx.retry) return { title: t('第 {0} 次', step.number),
        meta: [worker(step.workerId) ?? '', outcomeText(step.outcome, step.ref?.check?.headline), ctx.usage.has(ctx.key) ? t('Token {0}', tokenText(ctx.usage.get(ctx.key)!)) : ''],
        badge: step.integrated ? [t('已集成'), 'passed'] : step.reused ? [t('沿用上次检查'), 'muted'] : undefined,
        body: <>{step.note && <p class="trajectory-quote">{step.note}</p>}{this.actions(ctx, step)}</> };
        return { title: <code class="trajectory-task">{task(step.taskId)}</code>,
        meta: [worker(step.workerId) ?? '', ctx.simple && step.number === 1 ? '' : t('第 {0} 次', step.number),
          ctx.usage.has(ctx.key) ? t('Token {0}', tokenText(ctx.usage.get(ctx.key)!)) : ''],
        badge: step.integrated ? [t('已集成'), 'passed'] : step.reused ? [t('沿用上次检查'), 'muted'] : undefined,
        body: <>{this.outcome(step.outcome, step.ref?.check?.headline)}
          {step.note && <p class="trajectory-quote">{step.note}</p>}
          {this.actions(ctx, step)}</> };
      case 'proof': return { title: step.assembled ? t('组装完整证明') : t('完整证明'),
        meta: [worker(step.workerId) ?? '', !step.assembled && ctx.proofs > 1 ? t('第 {0} 次', step.number) : ''],
        body: <>{this.outcome(step.outcome, step.ref?.check?.headline)}{this.actions(ctx, step)}</> };
      case 'recheck': return { title: t('重新检查'), body: <Rechecks results={step.results} tasks={tasks} /> };
      case 'edit': {
        const rejected = step.edit.status === 'rejected', affected = step.edit.affectedTasks ?? [];
        return { title: rejected ? t('计划修改未被接受') : t('你修改了计划'), body: <>
          {step.plan ? <PlanDiff plan={step.plan} tasks={tasks} detailKey={`${ctx.key}-plan`} />
            : affected.length > 0 && <p class="trajectory-result">{fill(t('涉及 {0}'), <Chips ids={affected} label={task} />)}</p>}
          {step.results.length > 0 && <Rechecks results={step.results} tasks={tasks} />}</> };
      }
      case 'guidance': {
        const recipient = step.guidance.recipient;
        const to = recipient.kind === 'lead' ? named(ctx.state.data.context.workers.find(item => item.role === 'lead')?.id) ?? 'Lead'
          : recipient.kind === 'task' ? task(recipient.id ?? '') : named(recipient.id) ?? 'Agent';
        return { title: t('你的指导'), meta: [`→ ${to}`], badge: guidanceStatus[step.guidance.status],
          body: <p class="trajectory-quote">{localizeText(step.guidance.text)}</p> };
      }
      case 'delivery': {
        const delivery = step.delivery, status = reviewStatuses.has(delivery.status) ? statusLabels[delivery.status] : undefined;
        return { title: deliveryTitles[delivery.kind] ?? delivery.kind, meta: [worker(delivery.producer) ?? '', delivery.taskId ? task(delivery.taskId) : ''],
          badge: status ? [status, stepTone(step)] : undefined, body: <>
            {delivery.summary && <p class="trajectory-quote">{localizeText(delivery.summary)}</p>}
            {this.modes(step, ctx.run).length > 0 && <div class="trajectory-actions">{this.toggle(ctx, 'finding')}</div>}</> };
      }
      case 'evaluation': return { title: t('独立验收完整原题'), body: <p class={`trajectory-result ${outcomeTone(step.outcome)}`}>
        {step.outcome === 'passed' ? t('通过') : step.outcome === 'running' ? t('验收中') : t('未通过')}</p> };
      case 'notice': {
        const id = step.event.details?.taskId;
        return { title: readableMessage(step.event, names), meta: [id ? task(id) : '', step.count > 1 ? `×${step.count}` : ''] };
      }
      case 'approval': return { title: step.event.type === 'plan_approved' ? t('你批准了研究计划，Agent 开始工作')
        : step.event.type === 'plan_approval_requested' ? t('研究计划等你批准') : t('运行结束时研究计划仍未批准') };
      case 'stop': return { title: readableMessage(step.event, names) };
      // A run that ends without an acceptance verdict says why it stopped, as its badge does, and how far its targets got.
      case 'end': return { title: step.status === 'cancelled' ? t('运行已取消') : step.status === 'error' ? t('运行失败') : stoppedLabel(ctx.run),
        body: <EndGoals run={ctx.run} /> };
      // Who is doing what right now: the role names stay in 简洁 too, or the lines read 研究中 / 检查中 with no one doing it.
      // The run's newest progress message leads, as on the result tab: what is happening, not only who is busy.
      case 'live': {
        const latest = ctx.run.events.at(-1), at = latest && time(latest.at);
        return { title: t('进行中'), body: <>
          {latest && <p class="trajectory-live-latest">{Number.isFinite(at) && <time dateTime={latest.at} title={clockTime(latest.at)}>{elapsed(at! - time(ctx.run.createdAt))}</time>}
            <span>{readableMessage(latest, names).split('\n', 1)[0]}</span></p>}
          <ul class="trajectory-live">{step.workers.map(item => <li key={item.id}>
            <span class="trajectory-live-worker">{named(item.id)}</span><span>{workerPhaseLabel(item.phase)}</span>{item.task && <code>{task(item.task)}</code>}</li>)}</ul></> };
      }
    }
  }
  private outcome(outcome: TrajectoryOutcome, headline?: string) {
    return <p class={`trajectory-result ${outcomeTone(outcome)}`}>{outcomeText(outcome, headline)}</p>;
  }

  /**
   * 看代码 / 对比上一版 / 看 Lean 反馈 for an attempt or proof whose version was recorded, each opening the side viewer,
   * and 从这一版继续, which starts a new run from that version's saved code.
   */
  private actions(ctx: Ctx, step: StepOf<'attempt'> | StepOf<'proof'>) {
    const version = step.ref?.version, saved = version?.source !== undefined, own = this.own;
    const label = step.kind === 'attempt' ? `${ctx.tasks.get(step.taskId) ?? step.taskId} · ${t('第 {0} 次', step.number)}`
      : [step.assembled ? t('组装完整证明') : t('完整证明'), ctx.proofs > 1 && !step.assembled ? t('第 {0} 次', step.number) : ''].filter(Boolean).join(' · ');
    const buttons = [
      ...this.modes(step, ctx.run).map(mode => this.toggle(ctx, mode)),
      // Without per-version records, the last whole proof still opens the candidate in the source tab.
      !version && step.kind === 'proof' && ctx.lastProof === step && ctx.candidate
        && <button type="button" class="text-button" data-action="open-source">{t('完整源码')}<Icon name="arrow-up-right" /></button>,
      version && saved && own?.allowed(ctx.run) && <button type="button" class="text-button" data-focus-key={`${ctx.key}-continue`}
        data-trajectory-continue title={t('用这道题开一次新运行，把这一版的代码交给每个 Agent 参考')}
        onClick={() => own.start(ctx.run, { runId: ctx.run.id, taskId: version.taskId, commit: version.commit, label: label.slice(0, 200) })}>
        <Icon name="git-branch-plus" />{t('从这一版继续')}</button>,
    ].filter(Boolean);
    // While the run goes on, a version may simply not be observed yet.
    const missing = step.kind === 'attempt' && !saved && !live(ctx.run);
    if (!buttons.length && !missing) return null;
    return <div class="trajectory-actions">{buttons}{missing && <span class="trajectory-note">{t('这一版的代码没有保存')}</span>}</div>;
  }
  private modes(step: TrajectoryStep, run: WebRun): Mode[] {
    if (step.kind === 'delivery') return step.delivery.finding && step.delivery.finding !== step.delivery.summary ? ['finding'] : [];
    if (step.kind !== 'attempt' && step.kind !== 'proof') return [];
    const version = step.ref?.version, saved = version?.source !== undefined, failed = Boolean(version) && step.outcome === 'failed';
    return [saved && 'code', saved && step.kind === 'attempt' && step.previous?.source !== undefined && 'diff',
      failed && 'feedback', failed && this.asks(run) && 'ask'].filter((mode): mode is Mode => Boolean(mode));
  }
  private asks(run: WebRun) { return Boolean(this.own?.explain && this.own.allowed(run)); }

  private toggle(ctx: Ctx, mode: Mode) {
    const open = ctx.state.panel?.key === ctx.key && ctx.state.panel.mode === mode;
    return <button type="button" class={`text-button${open ? ' active' : ''}`} aria-expanded={open} aria-controls={open ? 'trajectory-viewer' : undefined}
      data-focus-key={`${ctx.key}-${mode}`} data-trajectory-mode={mode}
      onClick={() => { ctx.state.panel = open ? undefined : { key: ctx.key, mode }; this.render(); }}>
      {modeLabels[mode]}<Icon name="panel-right" /></button>;
  }

  /** The open step's code, comparison, feedback or full report, beside the steps or over them on a narrow screen. */
  private viewer(base: Ctx, built: Built) {
    const state = base.state, panel = state.panel;
    if (!panel) return null;
    const index = built.keys.indexOf(panel.key), step = built.steps[index], modes = step ? this.modes(step, base.run) : [];
    if (!step || !modes.length) { state.panel = undefined; return null; }
    if (!modes.includes(panel.mode)) panel.mode = modes[0]!;
    const ctx = { ...base, key: panel.key, index }, origin = time(base.run.createdAt);
    const close = () => {
      state.panel = undefined;
      this.render();
      const opener = this.root?.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(`${panel.key}-${panel.mode}`)}"]`)
        ?? this.root?.querySelector<HTMLElement>(`.trajectory-step[data-step="${CSS.escape(panel.key)}"]`);
      opener?.focus({ preventScroll: true });
    };
    const select = (mode: Mode) => () => { state.panel = { key: panel.key, mode }; this.render(); };
    let title: ComponentChildren, subtitle: string, body: ComponentChildren;
    if (step.kind === 'delivery') {
      title = deliveryTitles[step.delivery.kind] ?? step.delivery.kind;
      subtitle = [step.delivery.taskId ? base.tasks.get(step.delivery.taskId) ?? step.delivery.taskId : '', elapsed(step.at - origin)].filter(Boolean).join(' · ');
      body = <p class="trajectory-finding">{step.delivery.finding}</p>;
    } else if (step.kind === 'attempt' || step.kind === 'proof') {
      const version = step.ref!.version;
      title = step.kind === 'attempt' ? <code class="trajectory-task">{base.tasks.get(step.taskId) ?? step.taskId}</code> : step.assembled ? t('组装完整证明') : t('完整证明');
      subtitle = [step.kind === 'attempt' ? t('第 {0} 次', step.number) : '', outcomeText(step.outcome, step.ref?.check?.headline), elapsed(step.at - origin)].filter(Boolean).join(' · ');
      // A failed step's code carries Lean's messages under their lines.
      const failed = step.outcome === 'failed' ? step.ref?.check?.receiptIds ?? [] : undefined;
      body = panel.mode === 'code' ? this.code(ctx, version, step.kind === 'attempt' ? step.taskId : undefined, failed)
        : panel.mode === 'diff' && step.kind === 'attempt' && step.previous ? this.diff(ctx, step.previous, version)
          : panel.mode === 'ask' ? this.ask(ctx, version)
            : this.feedback(ctx, version, step.ref?.check?.receiptIds ?? [], modes.includes('ask'));
    } else return null;
    return <SideViewer id="trajectory-viewer" title={title} subtitle={subtitle} focusKey={`trajectory-viewer-${panel.key}`} onClose={close}
      modes={modes.map(mode => ({ id: mode, label: modeLabels[mode], current: mode === panel.mode, select: select(mode) }))}>
      <div class="trajectory-panel">{body}</div>
    </SideViewer>;
  }

  /**
   * 详细 only: one lane per Agent with its attempts as blocks at their real times. Dragging across the lanes keeps only
   * the steps in that stretch; clicking a block opens its step; the keyboard moves between blocks and picks one's stretch.
   */
  private overview(run: WebRun, state: RunState, items: readonly Item[], names: Map<string, string>, tasks: Map<string, string>) {
    const workers = (state.data.context.workers.length ? state.data.context.workers : run.observation?.inspection.workers ?? []).map(worker => worker.id);
    const axis = timeline(items, state.data.events, run, workers, names, tasks, Date.now());
    const blocks = axis?.lanes.flatMap(lane => lane.blocks.map(block => ({ ...block, id: `${lane.id}\u0000${block.key}`, lane: lane.name })))
      .sort((a, b) => a.start - b.start || a.end - b.end) ?? [];
    if (!axis || blocks.length < 2) return null;
    const span = axis.end - axis.start, origin = time(run.createdAt);
    const at = (value: number) => `${((value - axis.start) / span) * 100}%`;
    const width = (block: { start: number; end: number }) => `max(3px, ${((block.end - block.start) / span) * 100}%)`;
    const cursor = blocks.find(block => block.id === state.cursor), describe = (block: typeof blocks[number]) =>
      t('{0}：{1}，{2} 到 {3}', block.lane, block.label, elapsed(block.start - origin), elapsed(block.end - origin));
    // A drag shows its stretch at once and applies it on release; a click without movement opens the block's step.
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const lanes = event.currentTarget as HTMLElement, track = lanes.querySelector<HTMLElement>('.trajectory-axis-track')!;
      const brush = lanes.querySelector<HTMLElement>('.trajectory-brush')!, box = track.getBoundingClientRect();
      const ratio = (x: number) => Math.min(1, Math.max(0, (x - box.left) / box.width)), from = ratio(event.clientX), target = event.target as Element;
      let to = from;
      lanes.setPointerCapture(event.pointerId);
      const move = (next: PointerEvent) => {
        to = ratio(next.clientX);
        brush.style.left = `${Math.min(from, to) * 100}%`; brush.style.width = `${Math.abs(to - from) * 100}%`; brush.hidden = false;
      };
      const up = (last: PointerEvent) => {
        lanes.removeEventListener('pointermove', move); lanes.removeEventListener('pointerup', up); lanes.removeEventListener('pointercancel', up);
        brush.hidden = true;
        if (last.type === 'pointercancel') return;
        if (Math.abs(to - from) * box.width < 4) {
          const key = target.closest<HTMLElement>('[data-block]')?.dataset.block;
          if (key) this.reveal(key);
          return;
        }
        this.setWindow({ start: axis.start + Math.min(from, to) * span, end: axis.start + Math.max(from, to) * span });
      };
      lanes.addEventListener('pointermove', move); lanes.addEventListener('pointerup', up); lanes.addEventListener('pointercancel', up);
    };
    const key = (event: KeyboardEvent) => {
      const position = blocks.findIndex(block => block.id === state.cursor);
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const next = blocks[position < 0 ? (event.key === 'ArrowRight' ? 0 : blocks.length - 1)
          : Math.min(blocks.length - 1, Math.max(0, position + (event.key === 'ArrowRight' ? 1 : -1)))]!;
        state.cursor = next.id; this.render();
      } else if (event.key === 'Enter' && position >= 0) {
        event.preventDefault(); this.setWindow({ start: blocks[position]!.start, end: blocks[position]!.end });
      } else if (event.key === 'Escape' && state.window) { event.preventDefault(); event.stopPropagation(); this.setWindow(undefined); }
    };
    return <figure class="trajectory-overview">
      <figcaption><span>{t('时间总览')}</span><span class="trajectory-note">{t('拖动选一段时间只看这段的步骤，点色块打开那一步')}</span></figcaption>
      <div class="trajectory-lanes" role="group" tabIndex={0} aria-label={t('时间总览：按左右方向键逐个选择尝试，回车只看这段时间，Esc 取消')}
        data-focus-key="trajectory-lanes" onPointerDown={down} onKeyDown={key}>
        {axis.lanes.map(lane => <div key={lane.id} class="trajectory-lane">
          <span class="trajectory-lane-name" title={lane.name}>{lane.name}</span>
          <div class="trajectory-lane-track">{lane.blocks.map(block => {
            const id = `${lane.id}\u0000${block.key}`;
            return <span key={id} class={`trajectory-block ${toneClass(block.tone)}${id === state.cursor ? ' cursor' : ''}`} data-block={block.key}
              style={{ left: at(block.start), width: width(block) }} title={describe({ ...block, id, lane: lane.name })} />;
          })}</div>
        </div>)}
        <div class="trajectory-axis"><span /><div class="trajectory-axis-track">
          <time>{elapsed(axis.start - origin)}</time><time>{elapsed(axis.end - origin)}</time></div></div>
        {/* Over the lanes, in their track column: the chosen stretch and the one being dragged. */}
        <div class="trajectory-overlay" aria-hidden="true"><span /><div class="trajectory-overlay-track">
          {state.window && <span key="window" class="trajectory-window-mark" style={{ left: at(state.window.start), width: width(state.window) }} />}
          <span key="brush" class="trajectory-brush" hidden /></div></div>
      </div>
      <p class="sr-only" aria-live="polite">{cursor ? describe(cursor) : ''}</p>
    </figure>;
  }

  /** A version's code and receipts, fetched once and again only when the server has more checks of it. */
  private need(ctx: Ctx, version: TrajectoryVersion): Loaded {
    const versions = ctx.state.versions, key = version.key, cached = versions.get(key);
    if (cached && (cached.status !== 'ready' || cached.revision >= version.revision)) return cached;
    versions.delete(key); versions.set(key, { status: 'loading' });
    for (const old of versions.keys()) { if (versions.size <= limits.versions) break; versions.delete(old); }
    const query = new URLSearchParams({ task: version.taskId, commit: version.commit });
    void this.api<{ version: TrajectoryVersionDetail }>(`/api/runs/${encodeURIComponent(ctx.run.id)}/trajectory/version?${query}`)
      .then(({ version: detail }) => { versions.set(key, { status: 'ready', revision: version.revision, detail }); },
        error => { versions.set(key, { status: 'failed', error: errorText(error) }); })
      .finally(() => { if (this.run?.id === ctx.run.id) this.render(); });
    return { status: 'loading' };
  }
  private pending(ctx: Ctx, loaded: Loaded, version: TrajectoryVersion) {
    if (loaded.status === 'loading') return <div class="skeleton-block" aria-busy="true"><span class="skeleton-code" aria-hidden="true">{[86, 62, 74, 40, 68].map(width => <i key={width} style={{ width: `${width}%` }} />)}</span>
      <p class="trajectory-loading">{t('正在读取…')}</p></div>;
    if (loaded.status === 'failed') return <p class="trajectory-error" role="status">{t('读取失败：{0}', loaded.error)}
      <button type="button" class="text-button" data-focus-key={`${ctx.key}-retry`}
        onClick={() => { ctx.state.versions.delete(version.key); this.render(); }}>{t('重试')}</button></p>;
  }

  /**
   * A version's code with its line numbers. While the run goes on, each number is a button that adds its line to the
   * guidance draft (to `taskId`'s Agent); the numbers are one tab stop, moved through with the arrow keys. A failed
   * step's code (`failed`, the receipts of its check) has Lean's messages under the lines they are about, and above the
   * code a link to each of those lines.
   */
  private code(ctx: Ctx, version: TrajectoryVersion, taskId?: string, failed?: readonly string[]) {
    const loaded = this.need(ctx, version);
    if (loaded.status !== 'ready') return this.pending(ctx, loaded, version);
    const source = loaded.detail.source;
    if (!source) return <p class="trajectory-note">{t('这一版的代码没有保存')}</p>;
    const marks = failed ? versionMarks(loaded.detail, failed) : undefined;
    const signature = marks ? JSON.stringify([...marks.lines]) : '';
    const key = `${version.key}\u0000${source.sourceDigest}\u0000${signature}`;
    if (ctx.state.code?.key !== key) {
      const text = source.source.replace(/\r\n?/gu, '\n'), lines = text.split('\n'), gaps = new Map<number, number>();
      const below = new Map<number, ComponentChildren>();
      for (const [line, items] of marks?.lines ?? []) {
        gaps.set(line, items.reduce((sum, item) => sum + 1 + item.lines.length + (item.more ? 1 : 0), 0));
        below.set(line, this.marks(line, items));
      }
      ctx.state.code = { key, lines, gaps, numbers: lineNumbers(lines.length, gaps), parts: leanLines(text, below) };
    }
    const code = ctx.state.code, guiding = Boolean(this.guide) && ctx.run.status === 'running';
    const add = (line: number) => {
      const text = code.lines[line - 1]!.trim();
      this.guide?.(ctx.run, t('{0} 第 {1} 行：{2}', source.file, line, text.length > 200 ? `${text.slice(0, 200)}…` : text), taskId);
    };
    // Blank lines have nothing to add, so they keep a plain number and the arrow keys pass over them.
    const rove = (event: KeyboardEvent) => {
      const button = event.target as HTMLElement, step = event.key === 'ArrowDown' ? 'nextElementSibling' : event.key === 'ArrowUp' ? 'previousElementSibling' : undefined;
      if (!step) return;
      let next = button[step];
      while (next && !(next instanceof HTMLButtonElement)) next = next[step];
      if (!(next instanceof HTMLElement)) return;
      event.preventDefault(); button.tabIndex = -1; next.tabIndex = 0; next.focus();
    };
    const firstLine = code.lines.findIndex(line => line.trim());
    return <>
      <p class="trajectory-file"><Icon name="file-code-2" /><span>{source.file}</span></p>
      {marks && this.markSummary(ctx, marks)}
      {guiding && <p class="trajectory-note">{t('点行号把这一行加入指导草稿')}</p>}
      {/* Line guidance needs its column of line buttons; otherwise a phone wraps the lines under their own numbers. */}
      <div class={`trajectory-code${guiding ? '' : ' lean-wrap'}`} tabIndex={0} aria-label={source.file}>
        {guiding ? <div class="trajectory-line-numbers trajectory-gutter" role="group" aria-label={t('行号：把一行加入指导')} onKeyDown={rove}>
          {code.lines.flatMap((line, index) => [line.trim() ? <button key={index} type="button" tabIndex={index === firstLine ? 0 : -1} data-line={index + 1}
            data-marked={code.gaps.has(index + 1) || undefined} title={t('把第 {0} 行加入指导', index + 1)} aria-label={t('把第 {0} 行加入指导', index + 1)}
            onClick={() => add(index + 1)}>{index + 1}</button>
            : <span key={index} aria-hidden="true" data-marked={code.gaps.has(index + 1) || undefined}>{index + 1}</span>,
          ...Array.from({ length: code.gaps.get(index + 1) ?? 0 }, (_, row) => <span key={`${index}-${row}`} aria-hidden="true" />)])}</div>
          : <pre class="trajectory-line-numbers" aria-hidden="true">{code.numbers}</pre>}
        <pre class="trajectory-code-text" translate={false}><code>{code.parts}</code></pre>
      </div>
    </>;
  }
  /** Lean's messages about one line, under it in the code; each row is one line high, so the numbers stay beside their lines. */
  private marks(line: number, items: readonly LeanMark[]) {
    return <span key={`marks-${line}`} class="lean-marks" data-marks={line} tabIndex={-1}>{items.map((item, index) => <span key={index} class="lean-mark" data-severity={item.severity}>
      <span class="lean-mark-title"><Icon name={item.severity === 'error' ? 'circle-alert' : 'triangle-alert'} />
        {item.severity === 'error' ? t('第 {0} 行 · Lean 报错', line) : t('第 {0} 行 · Lean 警告', line)}</span>
      {item.lines.map((text, row) => <span key={row} class="lean-mark-row">{text || ' '}</span>)}
      {item.more > 0 && <span class="lean-mark-row lean-mark-more">{t('还有 {0} 行', item.more)} <button type="button" class="text-button"
        data-marks-feedback onClick={() => this.showFeedback()}>{modeLabels.feedback}</button></span>}
    </span>)}</span>;
  }
  /** Above a failed step's code: a link to each line Lean has a message about, and how many errors are about no line of it. */
  private markSummary(ctx: Ctx, marks: LeanMarks) {
    const lines = [...marks.lines.keys()], shown = lines.slice(0, limits.chips), warning = [...marks.lines.values()][0]?.[0]?.severity === 'warning';
    if (!lines.length && !marks.elsewhere) return null;
    return <div class="trajectory-marks-summary" data-marks-summary>
      {lines.length > 0 && <p><Icon name={warning ? 'triangle-alert' : 'circle-alert'} /><span>{warning ? t('Lean 警告在') : t('Lean 报错在')}</span>
        {shown.map(line => <button key={line} type="button" class="text-button" data-marks-line={line} data-focus-key={`${ctx.key}-marks-${line}`}
          onClick={() => this.jump(line)}>{t('第 {0} 行', line)}</button>)}
        {lines.length > shown.length && <span>{t('等 {0} 行', lines.length)}</span>}</p>}
      {marks.elsewhere > 0 && <p class="trajectory-note">{t('另有 {0} 条报错对不上这一版的代码行，在完整反馈里', marks.elsewhere)}
        <button type="button" class="text-button" data-marks-feedback onClick={() => this.showFeedback()}>{modeLabels.feedback}</button></p>}
    </div>;
  }
  /** Brings a line of the open code into view, its messages in focus. */
  private jump(line: number) {
    const viewer = this.root?.querySelector<HTMLElement>('#trajectory-viewer'), target = viewer?.querySelector<HTMLElement>(`.trajectory-code-text [data-line="${line}"]`);
    if (!viewer || !target) return;
    const box = target.closest<HTMLElement>('.trajectory-code'), scroller = target.closest<HTMLElement>('.side-viewer-body');
    if (box) box.scrollLeft = 0;
    // The code scrolls inside the viewer's body, or inside its own box when the body does not.
    for (const area of [box, scroller]) if (area && area.scrollHeight > area.clientHeight + 1) {
      area.scrollTop += target.getBoundingClientRect().top - area.getBoundingClientRect().top - area.clientHeight / 3;
    }
    const focus = target.nextElementSibling instanceof HTMLElement && target.nextElementSibling.dataset.marks ? target.nextElementSibling : box;
    focus?.focus({ preventScroll: true });
  }
  /** From Lean's output to its line in the open step's code. */
  private showLine(line: number) {
    if (!this.run) return;
    const state = this.state(this.run.id);
    if (!state.panel) return;
    state.panel = { key: state.panel.key, mode: 'code' };
    this.render();
    this.jump(line);
  }
  private showFeedback() {
    if (!this.run) return;
    const state = this.state(this.run.id);
    if (!state.panel) return;
    state.panel = { key: state.panel.key, mode: 'feedback' };
    this.render();
  }

  private diff(ctx: Ctx, before: TrajectoryVersion, after: TrajectoryVersion) {
    const old = this.need(ctx, before), current = this.need(ctx, after);
    if (old.status !== 'ready') return this.pending(ctx, old, before);
    if (current.status !== 'ready') return this.pending(ctx, current, after);
    const a = old.detail.source, b = current.detail.source;
    if (!a || !b) return <p class="trajectory-note">{t('有一版的代码没有保存，无法对比')}</p>;
    const key = `${a.sourceDigest}\u0000${b.sourceDigest}\u0000${ctx.state.folded}`;
    if (ctx.state.comparison?.key !== key) ctx.state.comparison = { key, value: compareSources(a.source, b.source, ctx.state.folded) };
    const comparison = ctx.state.comparison.value;
    if (comparison.status === 'identical') return <p class="trajectory-note">{comparison.lineEndingsChanged ? t('仅换行格式不同') : t('源码内容相同')}</p>;
    if (comparison.status === 'unavailable') return <p class="trajectory-note">{t('逐行差异暂不可用')}</p>;
    return <>
      <div class="diff-toolbar"><div class="diff-counts"><span class="diff-count-added">+{comparison.added}</span><span class="diff-count-removed">-{comparison.removed}</span></div>
        <label class="diff-toggle"><input type="checkbox" data-focus-key={`${ctx.key}-fold`} checked={ctx.state.folded}
          onChange={event => { ctx.state.folded = event.currentTarget.checked; this.render(); }} /><span>{t('折叠未改动')}</span></label></div>
      <div class="trajectory-diff" tabIndex={0} aria-label={t('与上一版的差异')}><table class="diff-table">
        <caption class="sr-only">{t('与上一版的差异')}</caption>
        <thead><tr><th scope="col">{t('上一版')}</th><th scope="col">{t('这一版')}</th><th scope="col">{t('源码')}</th></tr></thead>
        <tbody><DiffRows rows={comparison.rows} /></tbody></table></div>
    </>;
  }

  /**
   * The Lean output of the step's check, failed receipts first; identical outputs of several theorems are shown once.
   * Where a message names a line the code view marks, its location is a link to that line.
   */
  private feedback(ctx: Ctx, version: TrajectoryVersion, ids: readonly string[], askable = false) {
    const loaded = this.need(ctx, version);
    if (loaded.status !== 'ready') return this.pending(ctx, loaded, version);
    const entries = checkEntries(loaded.detail, ids), source = loaded.detail.source, marks = source ? versionMarks(loaded.detail, ids) : undefined;
    // Lean's wording is often the hard part; the panel offers to have the run's model explain it.
    const hint = askable && <p class="trajectory-ask-hint"><span>{t('看不懂这段输出？')}</span>
      <button type="button" class="text-button" data-focus-key={`${ctx.key}-ask-hint`} data-trajectory-ask-hint onClick={() => this.openAsk(ctx)}>
        <Icon name="message-circle-question" />{t('问问这一步为什么没通过')}</button></p>;
    if (!entries.length) return <><p class="trajectory-note">{t('没有保存 Lean 输出')}</p>{hint}</>;
    const linked = (text: string) => {
      if (!source || !marks?.lines.size) return text;
      const parts: ComponentChildren[] = [];
      let offset = 0;
      for (const message of leanMessages(text)) {
        if (!sameLeanFile(message.file, source.file) || !marks.lines.has(message.line)) continue;
        parts.push(text.slice(offset, message.start), <button key={message.start} type="button" class="lean-location" data-location-line={message.line}
          title={t('在代码里看第 {0} 行', message.line)} onClick={() => this.showLine(message.line)}>{text.slice(message.start, message.end)}</button>);
        offset = message.end;
      }
      return parts.length ? [...parts, text.slice(offset)] : text;
    };
    return <div class="trajectory-feedback">{entries.map((entry, index) => <div key={index} class="diagnostic-entry">
      <h5>{entry.theorem ? `${entry.label} · ${shortName(entry.theorem)}` : entry.label}</h5>
      <pre class="diagnostic-output" tabIndex={0}>{linked(entry.text)}</pre>
      {entry.truncated && <p class="diagnostic-limit">{t('仅显示前 4000 字符')}</p>}
    </div>)}{hint}</div>;
  }
  /** Switches the open failed step to 问为什么, with the question box in focus. */
  private openAsk(ctx: Ctx) {
    ctx.state.panel = { key: ctx.key, mode: 'ask' };
    this.render();
    this.root?.querySelector<HTMLElement>('#trajectory-viewer [data-ask-question]')?.focus({ preventScroll: true });
  }
  private thread(ctx: Ctx, version: TrajectoryVersion) {
    const asks = ctx.state.asks;
    let thread = asks.get(version.key);
    if (thread) return thread;
    asks.set(version.key, thread = { turns: [], draft: t('这一步为什么没通过？应该怎么改？') });
    for (const [key, old] of asks) { if (asks.size <= limits.asks) break; if (!old.pending) asks.delete(key); }
    return thread;
  }

  /**
   * Questions about a failed version, answered by the run's own model through its provider: each is a call the reader
   * pays for, outside the run's budget, and the run never sees it. The thread stays on this page until it is left;
   * each question carries the last few answers with it.
   */
  private ask(ctx: Ctx, version: TrajectoryVersion) {
    const explain = this.own!.explain!, key = explain.key(ctx.run), thread = this.thread(ctx, version), pending = thread.pending;
    const id = `trajectory-ask-${ctx.index}`;
    const submit = (event: Event) => {
      event.preventDefault();
      if (pending) pending.controller.abort(); else void this.send(ctx, version, thread, event.currentTarget as HTMLFormElement);
    };
    return <div class="trajectory-ask">
      <p class="trajectory-ask-cost"><Icon name="circle-help" />
        <span>{t('每个问题会用这次运行的模型（{0}）调用一次模型服务，按服务商计费，不计入运行预算；回答只作解释，不会改动运行。', ctx.run.model)}</span></p>
      {(thread.turns.length > 0 || pending) && <ol class="trajectory-ask-thread">
        {thread.turns.map((turn, index) => <AskReply key={index} turn={turn} />)}
        {pending && <li key="pending" class="trajectory-ask-turn"><p class="trajectory-ask-question">{pending.question}</p>
          <p class="trajectory-loading" role="status"><Spinner />{t('正在回答…')}</p></li>}
      </ol>}
      {thread.error && <p class="trajectory-error" role="alert">{thread.error}</p>}
      <form class="trajectory-ask-form" onSubmit={submit}>
          <label class="sr-only" htmlFor={`${id}-question`}>{thread.turns.length ? t('继续问') : t('问题')}</label>
          <textarea id={`${id}-question`} data-ask-question data-focus-key={`${ctx.key}-ask-question`} rows={3} maxLength={explainLimits.question}
            placeholder={t('继续问，例如：换成哪个引理？')} value={thread.draft} readOnly={Boolean(pending)}
            onInput={event => { thread.draft = event.currentTarget.value; }}
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          {key.source === 'none' && <label class="trajectory-ask-key"><span>{t('API Key（只用于这些问题，不保存）')}</span>
            <input type="password" data-ask-key data-focus-key={`${ctx.key}-ask-key`} autocomplete="off" spellcheck={false}
              defaultValue={this.typedKeys.get(ctx.run.providerId) ?? ''} onInput={event => { this.typedKeys.set(ctx.run.providerId, event.currentTarget.value.trim()); }} /></label>}
          <div class="trajectory-ask-footer">
            <span class="trajectory-note">{key.source === 'saved' ? t('使用这个账号保存的 Key（末四位 {0}）', key.ending)
              : key.source === 'server' ? t('使用服务器保存的 Key') : key.source === 'remembered' ? t('使用这个标签页记住的 Key') : t('Ctrl / ⌘ + Enter 发送')}</span>
            <button type="submit" class={`button${pending ? '' : ' button-primary'}`} data-ask-submit data-focus-key={`${ctx.key}-ask-submit`}>
              <Icon name={pending ? 'square' : 'send'} />{pending ? t('停止') : t('提问')}</button>
          </div>
        </form>
    </div>;
  }
  private async send(ctx: Ctx, version: TrajectoryVersion, thread: AskThread, form: HTMLFormElement) {
    const explain = this.own?.explain, question = thread.draft.trim(), run = ctx.run;
    if (!explain || !question || thread.pending) return;
    const source = explain.key(run).source, typed = this.typedKeys.get(run.providerId) ?? '';
    if (source === 'none' && !/^[\x21-\x7e]{8,4096}$/u.test(typed)) {
      thread.error = t('请填写这个服务商的 API Key'); this.render();
      form.querySelector<HTMLElement>('[data-ask-key]')?.focus({ preventScroll: true });
      return;
    }
    // The question moves into the thread while it is answered; a stopped or failed one comes back to the box.
    const controller = new AbortController();
    thread.pending = { question, controller }; thread.error = undefined; thread.draft = '';
    this.render();
    try {
      const answer = await explain.ask(run, { taskId: version.taskId, commit: version.commit, question,
        turns: thread.turns.slice(-explainLimits.turns).map(turn => ({ question: turn.question, answer: turn.answer })),
        ...(source === 'none' ? { apiKey: typed } : {}) }, controller.signal);
      thread.turns.push({ question, answer: answer.answer, ...(answer.truncated ? { truncated: true } : {}), ...(answer.usage ? { usage: answer.usage } : {}) });
    } catch (error) {
      if (!controller.signal.aborted) thread.error = errorText(error);
      thread.draft = question;
    } finally {
      thread.pending = undefined;
      if (this.run?.id === run.id) this.render();
    }
  }
}
