import { createContext, Fragment, render, type ComponentChildren } from 'preact';
import { useContext, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import type { WebProofOutline, WebProofOutlineDeclaration } from '../../shared';
import { goalStates, groupGoals, type GoalChecklist, type GoalRow, type GoalState, type ReportCheck, type ReportDiagnostic, type ReportSummary, type ReportTarget, type StuckSummary, type StuckTask } from '../../report';
import type { SourceComparison } from '../sourceDiff';
import { headingLine, type LeanHeading } from '../leanOutline';
import { sealVerdict } from '../motion';
import { leanLineTokens, leanTokens } from '../sourceText';
import { Icon } from './Icon';
import { DiffRows, fill } from './Section';
import { SideViewer } from './SideViewer';
import { TermHint } from './TermHint';
import { shownLines } from '../../presentation';
import { Rich } from '../richText';
import { t } from '../../i18n';
import type { WebRun, WebSession } from '../../shared';
import type { NextStep } from '../../report';
import { RecoveryChoices, RunResearchComparison } from '../productFlowView';

export type Banner = { tone: string; symbol: string; title: string; description: string };
export type OutlineState = { status: 'loading' } | { status: 'ready'; outline: WebProofOutline } | { status: 'failed'; error: string };
export type SourcePanelProps = {
  hasProof: boolean; proofLabel: string; view: 'proof' | 'input' | 'diff'; showingProof: boolean; verified: boolean; status: string; tone: string;
  /** The accepted proof's explanation, including read-only sample runs. */ explainRun?: string;
  /** Which Agent wrote an unaccepted candidate. */ origin?: string;
  diff?: { comparison: SourceComparison; folded: boolean; accepted: boolean };
};
/** The acceptance report inside the result tab; the verdict above it already states the outcome. */
export type ReportPanelProps =
  | { kind: 'empty'; active: boolean }
  | { kind: 'error'; error: string }
  | { kind: 'json'; report: unknown }
  | { kind: 'summary'; summary: ReportSummary & { /** A reason code with no wording of its own, kept folded for a feedback report. */ diagnostic?: string }; stuck?: StuckSummary; accepted: boolean;
    outline?: { state?: OutlineState; kitUrl: string; mathlib: boolean; /** The proof's declarations, so each name opens its line. */ headings: readonly LeanHeading[];
      /** An accepted run's id, so each target links to its explanation page. */ explainRun?: string } };
/** The result tab: the verdict, the proof, who did what, the acceptance report, then the task and its configuration. */
type ResultFact = { label: string; value: string; mono: boolean };
export type ResultPanelProps = {
  verdict: Banner & { /** The run it is about: a verdict reached while its reader watches is sealed, one shown later is not. */ run: string; active: boolean; candidate: boolean;
    meaning?: string;
    /** The newest progress message while the run is active. */ latest?: { at: string; time: string; message: string };
    /** While Agents work: the page can be closed, and how the reader hears the run has ended. */ away?: string };
  /** Next steps for a run that ended without an accepted proof (report.ts nextSteps). */ recovery: NextStep[];
  recoveryContext?: { run: WebRun; limits?: WebSession['limits'] };
  saveLibrary?: string;
  /** Desktop notification preference, offered while the run is active. */ notify?: 'on' | 'off' | 'blocked' | 'unsupported';
  /** Prefilled feedback form for failures on our side, which the visitor cannot fix by changing the run. */ feedback?: string;
  /** The accepted proof or the newest candidate; absent until an Agent captures one. */
  /** `rejected`: the independent acceptance checked this candidate and it failed, rather than never reaching it. */
  proof?: { source: string; verified: boolean; rejected?: boolean; explainRun?: string };
  /** 完整源码 opened beside the result (or over it on a narrow screen). */ viewer?: { onClose: () => void };
  /** One row per original target: proved, conditional or unsolved, and what it rests on. */ goals?: GoalChecklist;
  active: boolean; report: ReportPanelProps;
  /** Whether there is a route to draw: a run that ended before any Agent step or plan has no route map at all. */ route: boolean;
  /** Runs started later from a version of this one, oldest first, each with its own status. */
  later?: { id: string; label: string; status: { label: string; tone: string; symbol: string }; createdAt: string; time: string;
    /** Both runs have code, so the later one can be compared with this one. */ comparable: boolean }[];
  /** 对比代码 open beside the result: how a later run's code differs from this run's. */ compare?: CompareProps;
  /** What a reader asks first (environment, model, when); `config` is the rest of the run's settings, folded. */
  task: string; facts: ResultFact[]; config: ResultFact[];
  /** A declaration's name as the Lean file writes it (leanOutline writtenNames), so a namespace is not repeated on every row. */
  written: (name: string) => string;
};
export type CompareProps = { id: string; label: string; comparison?: SourceComparison; research?: { before: WebRun; after: WebRun }; folded: boolean; onClose: () => void };
/** The run detail tab. Imperative views own their workspace host; the source text and diff navigation are filled in after rendering. */
export type DetailView = { tab: 'source'; source: SourcePanelProps } | { tab: 'result'; result: ResultPanelProps }
  | { tab: 'events' | 'modules' | 'collaboration' | 'trajectory' };

const hosts = { events: 'activity-workspace', modules: 'module-workspace', collaboration: 'collaboration-workspace', trajectory: 'trajectory-workspace' };
export function renderDetailPanel(panel: HTMLElement, view: DetailView) {
  // Keyed by tab so switching tabs mounts fresh nodes instead of reusing another tab's workspace host.
  render(<DetailPanel key={view.tab} {...view} />, panel);
}
function DetailPanel(view: DetailView) {
  if (view.tab === 'source') return <SourcePanel {...view.source} />;
  if (view.tab === 'result') return <ResultPanel {...view.result} />;
  return <div class={hosts[view.tab]} />;
}

function SourcePanel(props: SourcePanelProps) {
  const copyLabel = t('复制{0}', props.showingProof ? props.proofLabel : t('原始题目'));
  const switchButton = (view: SourcePanelProps['view'], label: string) => <button type="button" data-source-view={view} aria-pressed={props.view === view}>{label}</button>;
  return <>
    <div class="panel-topline source-topline">
      {props.hasProof ? <div class="source-switch" role="group" aria-label={t('源码版本')}>{switchButton('proof', props.proofLabel)}{switchButton('input', t('原始题目'))}{switchButton('diff', t('差异对比'))}</div> : <h3>Submission.lean</h3>}
      <div class="source-actions">{props.explainRun && <ExplanationLink run={props.explainRun} />}<button type="button" class="icon-button" data-action="copy-source" aria-label={copyLabel} title={copyLabel}><Icon name="copy" /></button>
        {props.showingProof && <button type="button" class="icon-button" data-action="download-proof" aria-label={t('下载 Lean')} title={t('下载 Lean')}><Icon name="download" /></button>}</div>
    </div>
    <div class={`source-status ${props.tone}`}>
      <span><Icon name={props.verified && props.showingProof ? 'circle-check' : props.showingProof ? 'file-code-2' : 'clock-3'} />{props.status}</span>{props.origin && <span class="source-origin">{props.origin}</span>}
    </div>
    {/* The keys keep the code view's nodes, which SourceReader decorates, apart from the diff table. */}
    {props.diff ? <SourceDiff key="diff" {...props.diff} proofLabel={props.proofLabel} />
      : <Fragment key="code"><div class="source-reader" /><div class="code-scroll source-code-grid" tabIndex={0} aria-label={t('Lean 源码')}><pre class="source-line-numbers" aria-hidden="true" /><pre class="source-code"><code /></pre></div></Fragment>}
  </>;
}

function SourceDiff(props: { comparison: SourceComparison; folded: boolean; accepted: boolean; proofLabel: string }) {
  const { comparison } = props;
  const heading = <div class="diff-heading"><span>{t('原始题目')}</span><Icon name="arrow-right" /><span>{props.proofLabel}</span></div>;
  if (comparison.status === 'identical') return <>{heading}<div class="empty-state diff-identical" role="status"><Icon name="check-check" /><p>{comparison.lineEndingsChanged ? t('仅换行格式不同') : t('源码内容相同')}</p></div></>;
  if (comparison.status === 'unavailable') return <>{heading}<div class="empty-state diff-unavailable" role="status"><Icon name="file-code-2" /><p>{t('差异过多，无法生成对比')}</p></div></>;
  // The previous/next buttons, the position and the current change are set by the caller's diff navigation.
  return <>{heading}
    <div class="diff-toolbar"><div class="diff-counts"><span class="diff-count-added" aria-label={t('新增 {0} 行', comparison.added)}>+{comparison.added}</span><span class="diff-count-removed" aria-label={t('删除 {0} 行', comparison.removed)}>-{comparison.removed}</span></div>
      <label class="diff-toggle"><input type="checkbox" id="diff-changes-only" checked={props.folded} /><span>{t('折叠未改动')}</span></label>
      <div class="diff-navigation"><button type="button" class="icon-button" data-action="diff-prev" title={t('上一处更改')} aria-label={t('上一处更改')}><Icon name="chevron-up" /></button><span id="diff-position" class="mono" aria-live="polite" /><button type="button" class="icon-button" data-action="diff-next" title={t('下一处更改')} aria-label={t('下一处更改')}><Icon name="chevron-down" /></button></div>
      <span class="diff-scroll-hint" role="note"><Icon name="arrow-left-right" /><span>{t('长行可左右滑动查看')}</span></span></div>
    <div class="diff-scroll" tabIndex={0} aria-label={t('源码差异对比')}><table class="diff-table"><caption class="sr-only">{t('原始题目与{0}的逐行差异', props.proofLabel)}</caption>
      <thead><tr><th scope="col">{t('原始')}</th><th scope="col">{props.accepted ? t('验收') : t('候选')}</th><th scope="col">{t('源码')}</th></tr></thead><tbody><DiffRows rows={comparison.rows} /></tbody></table></div>
    {comparison.omittedLines > 0 && <p class="diff-truncated" role="status">{t('另有 {0} 行未展示', comparison.omittedLines)}</p>}</>;
}

const Fact = (props: { label: string; value: string }) => <div><dt>{props.label}</dt><dd class="mono">{props.value}</dd></div>;
const FactList = (props: { facts: ResultFact[] }) => <dl class="facts">{props.facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd class={fact.mono ? 'mono' : undefined}>{fact.value}</dd></div>)}</dl>;

const recoveryIcons: Record<string, string> = { 'continue-checked': 'git-branch-plus', 'ask-failed': 'message-circle-question', retry: 'refresh-cw', key: 'key-round', budget: 'clock-3', tokens: 'gauge', turns: 'list', workers: 'users', source: 'square-pen', task: 'square-pen' };
const notifyLabels = { on: t('结束时通知我 · 已开启'), off: t('结束时通知我'), blocked: t('通知已被浏览器阻止'), unsupported: '' };
// The result tab previews the start of the proof; the source tab reads the whole file.
const previewLines = 80;

function ExplanationLink(props: { run: string }) {
  return <a class="text-button" data-proof-explanation href={`explain.html?${new URLSearchParams({ run: props.run })}`} target="_blank" rel="noopener">
    <Icon name="book-open" />{t('Lean → 自然语言')}</a>;
}

const Written = createContext((name: string) => name);
/** A Lean name the way the file writes it; the full name stays in the tooltip. */
function LeanName(props: { name: string }) {
  const shown = useContext(Written)(props.name);
  return <code translate={false} title={shown === props.name ? undefined : props.name}>{shown}</code>;
}
function ResultPanel(props: ResultPanelProps) {
  return <Written.Provider value={props.written}><div class="result-layout" data-viewer-host>
    <ResultDocument {...props} />
    {props.viewer && props.proof ? <ProofViewer {...props.proof} onClose={props.viewer.onClose} /> : props.compare && <CompareViewer key={props.compare.id} {...props.compare} />}
  </div></Written.Provider>;
}
/** The runs continued from this one, so the original says what became of the problem; each opens its run. */
function Later(props: { runs: NonNullable<ResultPanelProps['later']>; comparing?: string }) {
  return <section class="result-section result-later" aria-labelledby="result-later-heading" data-result-later>
    <div class="result-section-heading"><h3 id="result-later-heading"><Icon name="git-branch" />{t('历次研究')}<span class="count">{props.runs.length}</span></h3></div>
    <ul class="result-later-list">{props.runs.map(run => <li key={run.id}>
      <button type="button" class="result-later-row" data-action="open-continued" data-run-id={run.id}>
        <span class="result-later-label" translate={false}>{run.label}</span>
        <span class={`badge ${run.status.tone}`}><Icon name={run.status.symbol} />{run.status.label}</span>
        <time dateTime={run.createdAt}>{run.time}</time>
      </button>
      {run.comparable && <button type="button" class="text-button result-later-compare" data-action="compare-continued" data-run-id={run.id}
        aria-pressed={props.comparing === run.id} aria-controls={props.comparing === run.id ? 'result-compare' : undefined}
        title={t('比较两次研究的进展与代码')}><Icon name="git-compare" />{t('比较研究')}</button>}</li>)}</ul>
  </section>;
}
/** While the run works the mark breathes; when it ends in front of the reader, the outcome is sealed into it. */
function VerdictMark(props: { run: string; active: boolean; symbol: string; tone: string }) {
  const ref = useRef<HTMLSpanElement>(null), shown = useRef({ run: props.run, active: props.active });
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = { run: props.run, active: props.active };
    if (before.run === props.run && before.active && !props.active) sealVerdict(ref.current!, props.tone === 'passed');
  }, [props.run, props.active]);
  return <span ref={ref} class="result-verdict-mark" aria-hidden="true">{props.active ? <span class="pulse-dot" /> : <Icon name={props.symbol} />}</span>;
}
function ResultDocument(props: ResultPanelProps) {
  const { verdict } = props;
  return <div class="result-document">
    <section class={`result-verdict ${verdict.tone}`} aria-labelledby="result-verdict-heading">
      <VerdictMark run={verdict.run} active={verdict.active} symbol={verdict.symbol} tone={verdict.tone} />
      <div class="result-verdict-copy">
        <h3 id="result-verdict-heading">{verdict.title}</h3><p>{verdict.description}<TermHint id="acceptance" /></p>
        {verdict.meaning && <p class="chat-statement-verdict" data-statement-verdict>{verdict.meaning} {t('Lean 验收证明的是这份陈述，不能替代对自然语言原意的核对。')}</p>}
        {verdict.latest && <p class="result-latest"><time dateTime={verdict.latest.at}>{verdict.latest.time}</time><span>{verdict.latest.message}</span></p>}
        {verdict.candidate && <span class="candidate-notice">{t('候选源码已更新 · 尚未验收')}</span>}
        {verdict.away && <p class="result-away" data-result-away>{verdict.away}</p>}
        {(props.recovery.length > 0 || props.notify && props.notify !== 'unsupported' || props.feedback) && <div class="result-verdict-actions">
          {!props.recoveryContext && props.recovery.map(action => <button key={action.id} type="button" class="button recovery-action" data-action="recover" data-recovery={action.id}>
            <Icon name={recoveryIcons[action.id] ?? 'refresh-cw'} />{action.label}</button>)}
          {props.notify && props.notify !== 'unsupported' && <button type="button" class="text-button" data-action="notify" aria-pressed={props.notify === 'on'}>
            <Icon name={props.notify === 'on' ? 'bell-ring' : props.notify === 'blocked' ? 'bell-off' : 'bell'} />{notifyLabels[props.notify]}</button>}
          {props.feedback && <a class="text-button" href={props.feedback} target="_blank" rel="noopener noreferrer" data-feedback-link><Icon name="message-square" />{t('反馈问题')}</a>}
        </div>}
      </div>
    </section>
    {props.recoveryContext && <RecoveryChoices {...props.recoveryContext} steps={props.recovery} />}
    {props.saveLibrary && <a class="button" data-save-library href={props.saveLibrary}>{t('保存到我的 Library')}</a>}
    {/* 下一步: what is still open. */}
    {props.goals && <Goals {...props.goals} active={props.active} />}
    {/* 证据: only blocks that carry something; a run without a proof is already said by the verdict. */}
    {props.proof && <ProofPreview {...props.proof} open={Boolean(props.viewer)} />}
    {props.route && <section class="result-section result-route" aria-labelledby="result-route-heading">
      <div class="result-section-heading"><h3 id="result-route-heading">{t('Agent 路线图')}</h3>
        <button type="button" class="text-button" data-action="show-agents">{t('研究协作')}<Icon name="arrow-up-right" /></button></div>
      <div data-result-roadmap />
      <details class="result-agent-actions"><summary>{t('Agent 操作明细')}</summary><div class="agent-route" data-result-route /></details>
    </section>}
    <ReportPanel {...props.report} />
    {props.later && <Later runs={props.later} comparing={props.compare?.id} />}
    {/* The task stays readable; how it was run is background and stays folded. */}
    <section class="result-section result-task">
      <div class="result-task-copy"><h3>{t('研究任务')}</h3><p class="task-content" translate={false}>{/\$\$[\s\S]+?\$\$|\$(?:[^$\n]|\\\$)+\$|\\\(|\\\[/.test(props.task) ? <Rich text={props.task} /> : props.task}</p></div>
      <details class="target-diagnostics result-config"><summary>{t('执行配置')}</summary>
        <FactList facts={props.facts} />{props.config.length > 0 && <FactList facts={props.config} />}</details>
    </section>
  </div>;
}

const goalIcons: Record<GoalState, string> = { proved: 'circle-check', checked: 'check', conditional: 'circle-dot', working: 'circle-dashed', planned: 'clock-3', open: 'circle' };
/** The checklist a mathematician reads first: each original target, whether it is proved, and what it still rests on. */
function Goals(props: GoalChecklist & { active: boolean }) {
  const counts = ([['proved', props.proved ? t('已证明 {0}', props.proved) : ''], ['checked', props.checked ? t('Lean 已检查 {0}', props.checked) : ''],
    ['conditional', props.conditional ? t('有条件 {0}', props.conditional) : ''],
    ['open', props.open ? props.active ? t('未完成 {0}', props.open) : t('未解决 {0}', props.open) : '']] as const).filter(([, text]) => text);
  const groups = groupGoals(props.goals), bar = props.goals.length > 1;
  return <section class="result-section result-goals" aria-labelledby="result-goals-heading">
    <div class="result-section-heading"><h3 id="result-goals-heading">{t('目标清单')}</h3>
      <span class={`report-method${bar ? ' goal-legend' : ''}`} data-goal-counts>{counts.map(([state, text], index) =>
        <Fragment key={state}>{index > 0 && ' · '}<span data-goal-count={state}>{text}</span></Fragment>)}</span></div>
    {bar && <GoalBar {...props} />}
    {props.checked > 0 && !props.active && <p class="report-method" data-goal-unaccepted>{t('「Lean 已检查」的目标在运行中通过了 Lean 检查，但完整原题还没有通过独立验收，所以不算已证明。')}</p>}
    {groups ? <div class="goal-groups">{groups.map(group => <details key={group.id} class="goal-group" data-goal-group={group.id} open={!group.folded}>
      <summary><Icon name="chevron-right" /><span>{group.label}</span><span class="field-count">{group.goals.length}</span></summary>
      <ul class="goal-list">{group.goals.map(goal => <GoalItem key={goal.name} {...goal} />)}</ul></details>)}</div>
      : <ul class="goal-list">{props.goals.map(goal => <GoalItem key={goal.name} {...goal} />)}</ul>}
    {props.omitted > 0 && <p class="report-method">{t('另有 {0} 个目标，见协作页任务图', props.omitted)}</p>}
  </section>;
}
/** The checklist as one thin bar: proved, then Lean-checked, then conditional; the rest of the track is unfinished. */
function GoalBar(props: GoalChecklist & { active: boolean }) {
  const total = props.proved + props.checked + props.conditional + props.open;
  const share = (count: number) => `${(count / total) * 100}%`;
  return <div class={`goal-bar${props.active ? '' : ' ended'}`} aria-hidden="true">
    {(['proved', 'checked', 'conditional'] as const).map(state => props[state] > 0 && <span key={state} data-goal-segment={state} style={{ width: share(props[state]) }} />)}
  </div>;
}
function GoalItem(goal: GoalRow) {
  const nonstandard = goal.nonstandardAxioms ?? [];
  const provedSubgoals = goal.subgoals.filter(item => item.state === 'proved').length;
  return <li class="goal-row" data-goal-state={goal.state}>
    <span class={`goal-mark ${goal.tone}`} aria-hidden="true"><Icon name={goalIcons[goal.state]} /></span>
    <div class="goal-copy">
      <div class="item-heading"><LeanName name={goal.name} /><span class={`badge ${goal.tone}`}>{goal.status}</span></div>
      {goal.waiting.length > 0 && <p class="goal-detail" data-goal-waiting>{fill(goal.state === 'conditional' ? t('前提尚未证明：{0}') : t('还差这些子目标：{0}'), <Names names={goal.waiting} />)}</p>}
      {goal.axioms && <p class="goal-detail" data-goal-axioms>{goal.axioms.length ? fill(t('依赖公理：{0}'), <Names names={goal.axioms} />) : t('不依赖任何公理')}
        {nonstandard.length > 0 && <> <span class="outline-warning">{fill(t('{0} 不在 Lean 的三个标准公理之内，请逐一核对'), <Names names={nonstandard} />)}</span></>}</p>}
      {goal.subgoals.length > 0 && <details class="target-diagnostics goal-subgoals"><summary>{t('子目标 {0} 个 · 已证明 {1} 个', goal.subgoals.length + goal.omittedSubgoals, provedSubgoals)}</summary>
        <ul>{goal.subgoals.map(item => <li key={item.id} data-goal-state={item.state}><span class={`goal-mark ${goalStates[item.state].tone}`} aria-hidden="true"><Icon name={goalIcons[item.state]} /></span>
          <LeanName name={item.name} /><span class="goal-subgoal-status">{goalStates[item.state].status}</span></li>)}</ul>
        {goal.omittedSubgoals > 0 && <p class="report-method">{t('另有 {0} 个子目标，见协作页任务图', goal.omittedSubgoals)}</p>}</details>}
      {/* A goal the run's own Lean check closed has code to read even though the run was not accepted; open goals are read in collaboration. */}
      {goal.state === 'checked' && goal.taskId ? <button type="button" class="report-detail-link" data-action="show-checked-code" data-task-id={goal.taskId}>{fill(t('{0}查看通过检查的代码'), <Icon name="file-code-2" />)}</button>
        : goal.state !== 'proved' && goal.taskId && <button type="button" class="report-detail-link" data-action="inspect-task" data-task-id={goal.taskId}>{fill(t('{0}在协作中查看'), <Icon name="network" />)}</button>}
    </div>
  </li>;
}

/** Lean text as coloured spans, the way the source tab colours it. */
export function leanParts(text: string): ComponentChildren[] {
  const parts: ComponentChildren[] = [];
  let offset = 0;
  for (const token of leanTokens(text)) {
    if (token.start > offset) parts.push(text.slice(offset, token.start));
    parts.push(<span class={`lean-${token.kind}`}>{text.slice(token.start, token.end)}</span>);
    offset = token.end;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}
/**
 * Lean text as coloured spans, one `.lean-line` per line with the line breaks between them, so a `.lean-wrap` block can
 * number the lines itself and wrap them on a phone instead of running off the screen. With `below`, each line carries
 * its number, and what `below` has for a line (such as Lean's messages about it) follows that line, which is marked.
 */
export function leanLines(text: string, below?: ReadonlyMap<number, ComponentChildren>): ComponentChildren[] {
  const rows: ComponentChildren[] = [];
  let marked = false;
  for (const [index, line] of leanLineTokens(text).entries()) {
    const parts: ComponentChildren[] = [];
    let offset = line.start;
    for (const token of line.tokens) {
      if (token.start > offset) parts.push(text.slice(offset, token.start));
      parts.push(<span key={token.start} class={`lean-${token.kind}`}>{text.slice(token.start, token.end)}</span>);
      offset = token.end;
    }
    if (offset < line.end) parts.push(text.slice(offset, line.end));
    // A marked line and what follows it are blocks, which end their own rows.
    if (index && !marked) rows.push('\n');
    const after = below?.get(index + 1);
    marked = after !== undefined;
    rows.push(<span key={index} class="lean-line" data-line={below ? index + 1 : undefined} data-marked={marked || undefined}>{parts}</span>);
    if (marked) rows.push(after);
  }
  // A final line break stays in the text, so copying the code keeps it.
  if (text.endsWith('\n') && !marked) rows.push('\n');
  return rows;
}

/** The first lines of the proof, coloured like the source tab, which keeps the whole file and its search. */
function ProofPreview(props: NonNullable<ResultPanelProps['proof']> & { open: boolean }) {
  const preview = useMemo(() => {
    const lines = shownLines(props.source);
    const shown = lines.slice(0, previewLines).join('\n');
    return { shown, omitted: lines.length - Math.min(lines.length, previewLines), numbers: Array.from({ length: Math.min(lines.length, previewLines) }, (_, index) => index + 1).join('\n') };
  }, [props.source]);
  const parts = useMemo(() => leanLines(preview.shown), [preview.shown]);
  const label = props.verified ? t('验收证明') : t('候选源码');
  return <section class={`result-section result-proof ${props.verified ? 'verified' : 'candidate'}`} aria-labelledby="result-proof-heading">
    <div class="result-section-heading">
      <h3 id="result-proof-heading"><Icon name={props.verified ? 'circle-check' : 'file-code-2'} />{label}{!props.verified && (props.rejected ? <span class="badge failed">{t('验收未通过')}</span> : <span class="badge warning">{t('尚未验收')}</span>)}</h3>
      <div class="result-proof-actions">
        {props.explainRun && <ExplanationLink run={props.explainRun} />}
        <button type="button" class="icon-button" data-action="copy-proof" aria-label={t('复制{0}', label)} title={t('复制{0}', label)}><Icon name="copy" /></button>
        <button type="button" class="icon-button" data-action="download-proof" aria-label={t('下载 Lean')} title={t('下载 Lean')}><Icon name="download" /></button>
        <button type="button" class="text-button" data-action="view-proof" aria-controls={props.open ? 'result-viewer' : undefined} aria-expanded={props.open}>
          {t('完整源码')}<Icon name="panel-right" /></button>
      </div>
    </div>
    <div class="code-scroll result-proof-code lean-wrap" tabIndex={0} aria-label={label}>
      <pre class="source-line-numbers" aria-hidden="true">{preview.numbers}</pre><pre class="result-proof-text" translate={false}><code>{parts}</code></pre>
    </div>
    {preview.omitted > 0 && <p class="result-note">{t('另有 {0} 行，在「源码」中查看完整文件', preview.omitted)}</p>}
  </section>;
}

/** The whole proof file, numbered and coloured; searching, jumping to a line and the comparison stay in the source tab. */
function ProofViewer(props: NonNullable<ResultPanelProps['proof']> & { onClose: () => void }) {
  const view = useMemo(() => {
    const text = props.source.replace(/\r\n?/g, '\n'), lines = shownLines(text).length;
    return { lines, numbers: Array.from({ length: lines }, (_, index) => index + 1).join('\n'), parts: leanLines(text) };
  }, [props.source]);
  const label = props.verified ? t('验收证明') : t('候选源码');
  return <SideViewer id="result-viewer" title={label} subtitle={t('{0} 行', view.lines)} focusKey="result-viewer" onClose={props.onClose}
    actions={<><button type="button" class="icon-button" data-action="copy-proof" aria-label={t('复制{0}', label)} title={t('复制{0}', label)}><Icon name="copy" /></button>
      <button type="button" class="text-button" data-action="open-source">{t('在源码页搜索')}<Icon name="arrow-up-right" /></button></>}>
    <div class="code-scroll result-proof-code result-viewer-code lean-wrap" tabIndex={0} aria-label={label}>
      <pre class="source-line-numbers" aria-hidden="true">{view.numbers}</pre><pre class="result-proof-text" translate={false}><code>{view.parts}</code></pre>
    </div>
  </SideViewer>;
}

/** 对比代码: what a run continued from this one changed, line by line, beside the result. */
function CompareViewer(props: CompareProps) {
  const { comparison } = props;
  const body = !comparison ? <p class="trajectory-note">{t('有一版的代码没有保存，无法对比')}</p> : comparison.status === 'identical' ? <p class="trajectory-note">{comparison.lineEndingsChanged ? t('仅换行格式不同') : t('两次运行的代码相同')}</p>
    : comparison.status === 'unavailable' ? <p class="trajectory-note">{t('差异过多，无法生成对比')}</p>
      : <><div class="diff-toolbar"><div class="diff-counts"><span class="diff-count-added" aria-label={t('新增 {0} 行', comparison.added)}>+{comparison.added}</span><span class="diff-count-removed" aria-label={t('删除 {0} 行', comparison.removed)}>-{comparison.removed}</span></div>
        <label class="diff-toggle"><input type="checkbox" data-action="compare-folded" checked={props.folded} /><span>{t('折叠未改动')}</span></label></div>
        <div class="trajectory-diff result-compare-diff" tabIndex={0} aria-label={t('两次运行代码的差异')}><table class="diff-table">
          <caption class="sr-only">{t('这次运行与「{0}」的逐行差异', props.label)}</caption>
          <thead><tr><th scope="col">{t('这次')}</th><th scope="col">{t('对照研究')}</th><th scope="col">{t('源码')}</th></tr></thead>
          <tbody><DiffRows rows={comparison.rows} /></tbody></table></div>
        {comparison.omittedLines > 0 && <p class="diff-truncated" role="status">{t('另有 {0} 行未展示', comparison.omittedLines)}</p>}</>;
  return <SideViewer id="result-compare" title={t('比较研究')} subtitle={t('与「{0}」的研究记录对照', props.label)} focusKey="result-compare" onClose={props.onClose}
    actions={<button type="button" class="text-button" data-action="open-continued" data-run-id={props.id}>{t('打开那次运行')}<Icon name="arrow-up-right" /></button>}>
    {props.research && <RunResearchComparison {...props.research} />}<details open={!props.research}><summary>{t('对比代码')}</summary>{body}</details></SideViewer>;
}

function ReportPanel(props: ReportPanelProps) {
  // No report is no section: the verdict above already says how the run stands.
  if (props.kind === 'empty') return null;
  // The verdict above explains the failure; the worker's own text is kept folded for a feedback report.
  if (props.kind === 'error') return <section class="result-section result-diagnostics"><details class="target-diagnostics"><summary>{t('运行诊断')}</summary>
    <pre class="diagnostic-output" tabIndex={0}>{props.error}</pre></details></section>;
  const mode = (view: 'summary' | 'json', label: string) => <button type="button" data-report-view={view} aria-pressed={props.kind === view}>{label}</button>;
  const heading = <div class="result-section-heading report-topline"><h3 id="result-report-heading">{t('验收报告')}</h3>
    <div class="source-switch" role="group" aria-label={t('报告视图')}>{mode('summary', t('验收摘要'))}{mode('json', t('原始数据'))}</div>
    <div class="report-actions"><button type="button" class="icon-button" data-action="copy-report" aria-label={t('复制报告 JSON')} title={t('复制报告 JSON')}><Icon name="copy" /></button>
      <button type="button" class="icon-button" data-action="download-report" aria-label={t('下载报告')} title={t('下载报告')}><Icon name="download" /></button></div></div>;
  if (props.kind === 'json') return <section class="result-section result-report" aria-labelledby="result-report-heading">{heading}
    <pre class="code-scroll report" tabIndex={0} aria-label={t('结果报告 JSON')}><code>{JSON.stringify(props.report, null, 2)}</code></pre></section>;
  const { summary } = props;
  return <section class="result-section result-report" aria-labelledby="result-report-heading">{heading}<div class="report-summary">
    {summary.reason && <section class="report-section report-reason"><h3>{t('运行说明')}</h3><p>{summary.reason}</p></section>}
    {props.stuck && <Stuck {...props.stuck} />}
    {props.outline && <section class="report-section report-outline" aria-labelledby="report-outline-heading"><div class="report-check-heading"><h3 id="report-outline-heading">{props.accepted ? t('证明结构') : t('候选证明结构')}</h3></div>
      <div class="outline-body" aria-live="polite"><Outline {...props.outline} /></div></section>}
    {summary.checks.map(check => <Check key={check.id} {...check} />)}
    {summary.diagnostic && <details class="target-diagnostics report-diagnostic"><summary>{t('运行诊断')}</summary>
      <pre class="diagnostic-output" tabIndex={0}>{summary.diagnostic}</pre></details>}
    {/* Usage, library provenance, commits and digests let someone reproduce the check; they stay folded for everyone else. */}
    {(summary.metrics.length > 0 || summary.library || summary.identity.length > 0) && <details class="target-diagnostics report-more" data-report-more>
      <summary>{t('运行数据与凭据')}</summary>
      {summary.metrics.length > 0 && <dl class="report-metrics">{summary.metrics.map(item => <Fact key={item.label} {...item} />)}</dl>}
      {summary.library && <section class="report-section report-library" data-report-library>
        <h3>{t('库调用')}</h3><p><code>{summary.library.id}</code> · {summary.library.revision}</p>
        <dl class="report-metrics">
          <Fact label={t('装入模块')} value={String(summary.library.installedModules)} />
          <Fact label={t('按需补装轮次')} value={String(summary.library.installationRounds)} />
          <Fact label={t('已记录证明引用')} value={summary.library.referenceCount === undefined ? summary.library.coverage === 'partial' ? t('记录不完整') : t('未记录') : String(summary.library.referenceCount)} />
        </dl>
        {summary.library.coverage === 'unknown' ? <p class="result-note">{t('尚无独立验收的库引用记录。')}</p> :
          summary.library.coverage === 'partial' ? <p class="result-note">{t('部分目标缺少引用记录，以下为已记录引用。')}</p> :
            summary.library.referenceCount === 0 ? <p class="result-note">{t('独立验收的证明未引用该库的公开声明。')}</p> : null}
        {summary.library.references.length > 0 && <details class="target-diagnostics"><summary>{t('查看引用的公开声明')}</summary>
          <ul>{summary.library.references.map(reference => <li key={reference.name}><code title={reference.sourceDigest}>{reference.name}</code><br /><code>{reference.file}</code></li>)}</ul>
          {summary.library.omittedReferences > 0 && <p class="result-note">{t('另有 {0} 条引用未在此展开。', summary.library.omittedReferences)}</p>}
        </details>}
        <details class="target-diagnostics"><summary>{t('库版本凭据')}</summary><code>{summary.library.catalogDigest}</code></details>
      </section>}
      {summary.identity.length > 0 && <section class="report-section report-credentials"><h3>{t('验收凭据')}</h3>
        <dl class="facts report-identity">{summary.identity.map(item => <Fact key={item.label} {...item} />)}</dl></section>}
    </details>}
  </div></section>;
}

function Check(check: ReportCheck) {
  const list = <ul class="verification-targets">{check.targets.map((target, index) => <Target key={`${index}:${target.name}`} {...target} />)}</ul>;
  // A clean pass repeats the heading's status once per target, so the list folds behind one line; anything else stays open to read.
  const clean = check.targets.every(target => target.tone === 'passed' && !target.sorryCount && !target.admitCount);
  // The candidate check and the acceptance both fold the same line; the heading tells a keyboard or screen reader which one this is.
  const heading = `report-check-${check.id}`;
  return <section class="report-section" data-check-stage={check.id}><div class="report-check-heading"><h3 id={heading}>{check.label}</h3><span class={`badge ${check.tone}`}>{check.status}</span></div>
    {check.method && <p class="report-method">{check.method}</p>}{check.reason && <p class={check.skipped ? 'report-method' : 'report-reason-text'}>{check.reason}</p>}
    {check.targets.length > 0 && (clean ? <details class="target-diagnostics check-targets"><summary aria-describedby={heading}>{check.targets.length === 1 ? t('目标已通过') : t('{0} 个目标都已通过', check.targets.length)}</summary>{list}</details> : list)}
    {check.omittedTargets > 0 && <p class="report-method">{t('另有 {0} 个目标，详见原始报告', check.omittedTargets)}</p>}</section>;
}
function Target(target: ReportTarget) {
  // Only a placeholder left in the proof is worth a number; zero is what the status already says.
  const counts = [target.sorryCount ? `sorry ${target.sorryCount}` : '', target.admitCount ? `admit ${target.admitCount}` : ''].filter(Boolean).join(' · ');
  return <li class="verification-target"><div class="target-heading"><LeanName name={target.name} /><span class={`badge ${target.tone}`}>{target.status}</span></div>
    {counts && <p class="target-counts mono">{counts}</p>}
    {/* Open only on first render, so a live update keeps what the reader expanded or collapsed. */}
    {target.diagnostics.length > 0 && <details class="target-diagnostics" open={target.tone === 'failed'}><summary>{t('诊断记录')} <span class="field-count">{target.diagnostics.length}</span></summary>
      {target.diagnostics.map((diagnostic, index) => <Diagnostic key={index} {...diagnostic} />)}</details>}</li>;
}
function Diagnostic(diagnostic: ReportDiagnostic) {
  return <div class="diagnostic-entry"><h4>{diagnostic.label}</h4><pre class="diagnostic-output" tabIndex={0}>{diagnostic.text}</pre>
    {diagnostic.truncated && <p class="diagnostic-limit"><span>{t('仅显示前 4000 字符')}</span><button type="button" class="report-detail-link" data-report-view="json">{fill(t('{0}查看原始报告'), <Icon name="file-json-2" />)}</button></p>}</div>;
}

function Stuck(stuck: StuckSummary) {
  const progress = [t('已检查 {0} 个', stuck.checked), stuck.conditional ? t('有条件 {0} 个', stuck.conditional) : '', t('未完成 {0} 个', stuck.open)].filter(Boolean).join(' · ');
  return <section class="report-section report-stuck" aria-labelledby="report-stuck-heading"><div class="report-check-heading"><h3 id="report-stuck-heading">{t('卡在哪里')}</h3><span class="report-method">{progress}</span></div>
    <p class="report-method">{stuck.openGoals ? t('原题目标尚未闭合；下面是它当前依赖的、还没有通过检查的子目标。') : t('下面这些子目标还没有通过 Lean 检查。')}</p>
    <ul class="stuck-tasks">{stuck.tasks.map(task => <StuckItem key={task.id} {...task} />)}</ul>
    {stuck.omitted > 0 && <p class="report-method">{t('另有 {0} 个未完成子目标，见协作页任务图', stuck.omitted)}</p>}</section>;
}
function StuckItem(task: StuckTask) {
  return <li class="stuck-task"><div class="item-heading"><span class="stuck-name">{task.goal && <span class="stuck-kind">{t('原题目标')}</span>}{task.theorem ? <LeanName name={task.theorem} /> : <code translate={false}>{task.id}</code>}</span><span class={`badge ${task.tone}`}>{task.status}</span></div>
    {task.type && <pre class="stuck-type" translate={false}>{task.type}</pre>}
    <p class="stuck-facts">{[task.attempts ? t('已尝试 {0} 次', task.attempts) : t('还没有尝试'), task.failure].filter(Boolean).join(' · ')}</p>
    {task.blockers.length > 0 && <ul class="stuck-blockers">{task.blockers.map((text, index) => <li key={index}><Icon name="triangle-alert" /><span>{text}</span></li>)}</ul>}
    {task.feedback && <details class="target-diagnostics"><summary>{t('最近反馈')}</summary><pre class="diagnostic-output" tabIndex={0}>{task.feedback}</pre></details>}
    <button type="button" class="report-detail-link" data-action="inspect-task" data-task-id={task.id}>{fill(t('{0}在协作中查看'), <Icon name="network" />)}</button></li>;
}

function Outline(props: { state?: OutlineState; kitUrl: string; mathlib: boolean; headings: readonly LeanHeading[]; explainRun?: string }) {
  const { state } = props;
  if (!state || state.status === 'loading') return <div class="skeleton-block" aria-busy="true"><span class="skeleton-lines" aria-hidden="true">{[48, 72, 60].map(width => <i key={width} style={{ width: `${width}%` }} />)}</span>
    <p class="report-method">{t('正在整理证明结构…')}</p></div>;
  if (state.status === 'failed') return <><p class="report-reason-text">{state.error}</p><button type="button" class="report-detail-link" data-action="retry-outline">{fill(t('{0}重新整理'), <Icon name="rotate-ccw" />)}</button></>;
  const { outline } = state, targets = outline.declarations.filter(item => item.role === 'target'), helpers = outline.declarations.filter(item => item.role === 'helper');
  if (!targets.length) return <p class="report-method">{t('候选证明中没有找到原题的目标定理，无法整理结构或生成复核包。')}</p>;
  return <>
    <p class="report-method">{helpers.length ? t('{0} 个原题目标，求解过程新增了 {1} 个辅助声明。', targets.length, helpers.length) : t('{0} 个原题目标，没有新增辅助声明。', targets.length)}
      {outline.references === 'unrecorded' && helpers.length > 0 && ` ${t('这次运行没有记录引用关系，未标出各目标用到哪些辅助声明。')}`}</p>
    <h4 class="outline-heading">{t('原题目标')}</h4><ul class="verification-targets">{targets.map(item => <Declaration key={item.name} item={item} line={headingLine(props.headings, item.name)} explainRun={props.explainRun} />)}</ul>
    {helpers.length > 0 && <><h4 class="outline-heading">{t('新增辅助声明')}</h4><ul class="verification-targets">{helpers.map(item => <Declaration key={item.name} item={item} line={headingLine(props.headings, item.name)} />)}</ul></>}
    {outline.omitted > 0 && <p class="report-method">{t('另有 {0} 个声明未列出', outline.omitted)}</p>}
    <div class="local-check"><a class="button" href={props.kitUrl} download>{fill(t('{0}下载本地复核包'), <Icon name="download" />)}</a>
      <span class="report-method">{t('包含原题、证明、固定版本的 Lean 工程文件和公理检查脚本。')}</span></div>
    <LocalCheckGuide mathlib={props.mathlib} />
  </>;
}
function Names(props: { names: string[] }) {
  return <>{props.names.map((name, index) => <Fragment key={index}>{index > 0 && t('、')}<LeanName name={name} /></Fragment>)}</>;
}
/** A declaration of the proof; where its line is known, its name opens the source tab there (the line number is in the tooltip). */
function Declaration({ item, line, explainRun }: { item: WebProofOutlineDeclaration; line?: number; explainRun?: string }) {
  const nonstandard = item.nonstandardAxioms ?? [];
  const kind = item.kind === 'definition' ? t('定义') : item.kind === 'instance' ? t('实例') : t('引理');
  const name = <LeanName name={item.name} />;
  return <li class="outline-item"><div class="item-heading">{line ? <button type="button" class="outline-jump" data-action="jump-declaration" data-line={line}
    title={t('在源码中查看（第 {0} 行）', line)}>{name}<Icon name="arrow-up-right" /></button> : name}
    {item.role === 'target' ? nonstandard.length > 0 && <span class="badge warning">{t('含非标准公理')}</span> : <span class="badge muted">{kind}</span>}</div>
    <pre class="stuck-type" translate={false}>{item.type}{item.typeTruncated ? '\n…' : ''}</pre>
    {item.role === 'target' ? <>
      {item.uses && <p class="outline-uses">{item.uses.length ? fill(t('用到：{0}'), <Names names={item.uses} />) : t('直接证明，没有用到新增的辅助声明')}</p>}
      {item.axioms && <p class="outline-uses">{item.axioms.length ? fill(t('依赖公理：{0}'), <Names names={item.axioms} />) : t('不依赖任何公理')}
        {nonstandard.length > 0 && <> <span class="outline-warning">{fill(t('{0} 不在 Lean 的三个标准公理之内，请逐一核对'), <Names names={nonstandard} />)}</span></>}</p>}
      {/* A separate page, so the run stays open here while an explanation is read or generated. */}
      {explainRun && <a class="report-detail-link" href={`explain.html?${new URLSearchParams({ run: explainRun, target: item.name })}`} target="_blank" rel="noopener">
        {fill(t('{0}证明讲解：Lean 与自然语言对照'), <Icon name="book-open" />)}</a>}
    </> : item.usedBy && <p class="outline-uses">{item.usedBy.length ? fill(t('被 {0} 用到'), <Names names={item.usedBy} />) : t('没有被任何目标用到')}</p>}</li>;
}
function LocalCheckGuide(props: { mathlib: boolean }) {
  const command = (text: string) => <code translate={false}>{text}</code>;
  const steps = [t('安装 Lean 版本管理器 elan；压缩包里的 lean-toolchain 会自动选用同一 Lean 版本。'),
    props.mathlib ? fill(t('在解压目录运行 {0}，下载预编译的 Mathlib。'), command('lake exe cache get')) : t('标准库环境不需要下载依赖。'),
    fill(t('运行 {0}：没有 error 即 Lean 内核接受了全部证明。'), command('lake build Submission')),
    fill(t('运行 {0}：每个目标只应依赖 propext、Classical.choice、Quot.sound；出现 sorryAx 说明证明不完整。'), command('lake env lean Check.lean')),
    t('比较 Original.lean 与 Submission.lean：目标定理的陈述应保持不变。')];
  return <details class="target-diagnostics local-check-guide"><summary>{t('如何在自己的电脑上复核')}</summary><ol class="local-check-steps">{steps.map((step, index) => <li key={index}>{step}</li>)}</ol></details>;
}
