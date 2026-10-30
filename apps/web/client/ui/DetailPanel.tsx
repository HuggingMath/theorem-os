import { Fragment, render, type ComponentChildren } from 'preact';
import type { WebProofOutline, WebProofOutlineDeclaration } from '../../shared';
import type { ReportCheck, ReportDiagnostic, ReportSummary, ReportTarget, StuckSummary, StuckTask } from '../../report';
import type { SourceComparison } from '../sourceDiff';
import { Icon, Spinner } from './Icon';
import { DiffRows, fill } from './Section';
import { t } from '../../i18n';

export type Banner = { tone: string; symbol: string; title: string; description: string };
export type OutlineState = { status: 'loading' } | { status: 'ready'; outline: WebProofOutline } | { status: 'failed'; error: string };
export type SourcePanelProps = {
  hasProof: boolean; proofLabel: string; view: 'proof' | 'input' | 'diff'; showingProof: boolean; verified: boolean; status: string; tone: string;
  /** Who captured an unaccepted candidate, or the size of the shown source. */ origin: string;
  diff?: { comparison: SourceComparison; folded: boolean; accepted: boolean };
};
export type ReportPanelProps =
  | { kind: 'empty'; active: boolean }
  | { kind: 'error'; banner: Banner; error: string }
  | { kind: 'json'; report: unknown }
  | { kind: 'summary'; banner: Banner; summary: ReportSummary; stuck?: StuckSummary; accepted: boolean;
    outline?: { state?: OutlineState; kitUrl: string; mathlib: boolean; explainRun?: string } };
/** The run detail tab. Imperative views own their workspace host; the source text and diff navigation are filled in after rendering. */
export type DetailView = { tab: 'source'; source: SourcePanelProps } | { tab: 'report'; report: ReportPanelProps }
  | { tab: 'events' | 'modules' | 'collaboration' | 'overview' };

const hosts = { events: 'activity-workspace', modules: 'module-workspace', collaboration: 'collaboration-workspace', overview: 'overview-workspace' };
export function renderDetailPanel(panel: HTMLElement, view: DetailView) {
  // Keyed by tab so switching tabs mounts fresh nodes instead of reusing another tab's workspace host.
  render(<DetailPanel key={view.tab} {...view} />, panel);
}
function DetailPanel(view: DetailView) {
  if (view.tab === 'source') return <SourcePanel {...view.source} />;
  if (view.tab === 'report') return <ReportPanel {...view.report} />;
  return <div class={hosts[view.tab]} />;
}

function SourcePanel(props: SourcePanelProps) {
  const copyLabel = t('复制{0}', props.showingProof ? props.proofLabel : t('原始题目'));
  const switchButton = (view: SourcePanelProps['view'], label: string) => <button type="button" data-source-view={view} aria-pressed={props.view === view}>{label}</button>;
  return <>
    <div class="panel-topline source-topline">
      {props.hasProof ? <div class="source-switch" role="group" aria-label={t('源码版本')}>{switchButton('proof', props.proofLabel)}{switchButton('input', t('原始题目'))}{switchButton('diff', t('差异对比'))}</div> : <h3>Submission.lean</h3>}
      <div class="source-actions"><button type="button" class="icon-button" data-action="copy-source" aria-label={copyLabel} title={copyLabel}><Icon name="copy" /></button>
        {props.showingProof && <button type="button" class="icon-button" data-action="download-proof" aria-label={t('下载 Lean')} title={t('下载 Lean')}><Icon name="download" /></button>}</div>
    </div>
    <div class={`source-status ${props.tone}`}>
      <span><Icon name={props.verified && props.showingProof ? 'circle-check' : props.showingProof ? 'file-code-2' : 'clock-3'} />{props.status}</span><span class="mono">{props.origin}</span>
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

function ResultBanner(props: Banner) {
  return <div class={`result-banner ${props.tone}`}><Icon name={props.symbol} /><div><h3>{props.title}</h3><p>{props.description}</p></div></div>;
}
const Fact = (props: { label: string; value: string }) => <div><dt>{props.label}</dt><dd class="mono">{props.value}</dd></div>;
const Section = (props: { title: string; children: ComponentChildren }) => <section class="report-section"><h3>{props.title}</h3>{props.children}</section>;

function ReportPanel(props: ReportPanelProps) {
  if (props.kind === 'empty') return <div class="empty-state"><Icon name="file-json-2" /><p>{props.active ? t('结果报告尚未生成') : t('暂无结果报告')}</p></div>;
  if (props.kind === 'error') return <><ResultBanner {...props.banner} /><Section title={t('运行诊断')}><pre class="diagnostic-output" tabIndex={0}>{props.error}</pre></Section></>;
  const mode = (view: 'summary' | 'json', label: string) => <button type="button" data-report-view={view} aria-pressed={props.kind === view}>{label}</button>;
  const toolbar = <div class="panel-topline report-topline"><div class="source-switch" role="group" aria-label={t('报告视图')}>{mode('summary', t('验收摘要'))}{mode('json', 'JSON')}</div>
    <div class="report-actions"><button type="button" class="icon-button" data-action="copy-report" aria-label={t('复制报告 JSON')} title={t('复制报告 JSON')}><Icon name="copy" /></button>
      <button type="button" class="button" data-action="download-report">{fill(t('{0}下载报告'), <Icon name="download" />)}</button></div></div>;
  if (props.kind === 'json') return <>{toolbar}<pre class="code-scroll report" tabIndex={0} aria-label={t('结果报告 JSON')}><code>{JSON.stringify(props.report, null, 2)}</code></pre></>;
  const { summary } = props;
  return <>{toolbar}<div class="report-summary"><ResultBanner {...props.banner} />
    {summary.reason && <section class="report-section report-reason"><h3>{t('运行说明')}</h3><p>{summary.reason}</p></section>}
    {props.stuck && <Stuck {...props.stuck} />}
    {summary.metrics.length > 0 && <dl class="report-metrics">{summary.metrics.map(item => <Fact key={item.label} {...item} />)}</dl>}
    {props.outline && <section class="report-section report-outline" aria-labelledby="report-outline-heading"><div class="report-check-heading"><h3 id="report-outline-heading">{props.accepted ? t('证明结构') : t('候选证明结构')}</h3></div>
      <div class="outline-body" aria-live="polite"><Outline {...props.outline} /></div></section>}
    {summary.checks.length ? summary.checks.map(check => <Check key={check.id} {...check} />) : <div class="empty-state compact"><p>{t('暂无结构化验收记录')}</p></div>}
    {summary.identity.length > 0 && <Section title={t('验收凭据')}><dl class="facts report-identity">{summary.identity.map(item => <Fact key={item.label} {...item} />)}</dl></Section>}
  </div></>;
}

function Check(check: ReportCheck) {
  return <section class="report-section" data-check-stage={check.id}><div class="report-check-heading"><h3>{check.label}</h3><span class={`badge ${check.tone}`}>{check.status}</span></div>
    {check.method && <p class="report-method">{check.method}</p>}{check.reason && <p class="report-reason-text">{check.reason}</p>}
    {check.targets.length > 0 && <ul class="verification-targets">{check.targets.map((target, index) => <Target key={`${index}:${target.name}`} {...target} />)}</ul>}
    {check.omittedTargets > 0 && <p class="report-method">{t('另有 {0} 个目标，详见原始报告', check.omittedTargets)}</p>}</section>;
}
function Target(target: ReportTarget) {
  const counts = [target.sorryCount === undefined ? '' : `sorry ${target.sorryCount}`, target.admitCount === undefined ? '' : `admit ${target.admitCount}`].filter(Boolean).join(' · ');
  return <li class="verification-target"><div class="target-heading"><code>{target.name}</code><span class={`badge ${target.tone}`}>{target.status}</span></div>
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
  return <li class="stuck-task"><div class="item-heading"><span class="stuck-name">{task.goal && <span class="stuck-kind">{t('原题目标')}</span>}<code translate={false}>{task.theorem ?? task.id}</code></span><span class={`badge ${task.tone}`}>{task.status}</span></div>
    {task.type && <pre class="stuck-type" translate={false}>{task.type}</pre>}
    <p class="stuck-facts">{[t('已尝试 {0} 次', task.attempts), task.failure].filter(Boolean).join(' · ')}</p>
    {task.blockers.length > 0 && <ul class="stuck-blockers">{task.blockers.map((text, index) => <li key={index}><Icon name="triangle-alert" /><span>{text}</span></li>)}</ul>}
    {task.feedback && <details class="target-diagnostics"><summary>{t('最近反馈')}</summary><pre class="diagnostic-output" tabIndex={0}>{task.feedback}</pre></details>}
    <button type="button" class="report-detail-link" data-action="inspect-task" data-task-id={task.id}>{fill(t('{0}在协作中查看'), <Icon name="network" />)}</button></li>;
}

function Outline(props: { state?: OutlineState; kitUrl: string; mathlib: boolean; explainRun?: string }) {
  const { state } = props;
  if (!state || state.status === 'loading') return <p class="report-method"><Spinner />{t('正在整理证明结构…')}</p>;
  if (state.status === 'failed') return <><p class="report-reason-text">{state.error}</p><button type="button" class="report-detail-link" data-action="retry-outline">{fill(t('{0}重新整理'), <Icon name="rotate-ccw" />)}</button></>;
  const { outline } = state, targets = outline.declarations.filter(item => item.role === 'target'), helpers = outline.declarations.filter(item => item.role === 'helper');
  if (!targets.length) return <p class="report-method">{t('候选证明中没有找到原题的目标定理，无法整理结构或生成复核包。')}</p>;
  return <>
    <p class="report-method">{helpers.length ? t('{0} 个原题目标，求解过程新增了 {1} 个辅助声明。', targets.length, helpers.length) : t('{0} 个原题目标，没有新增辅助声明。', targets.length)}
      {outline.references === 'unrecorded' && helpers.length > 0 && ` ${t('这次运行没有记录引用关系，未标出各目标用到哪些辅助声明。')}`}</p>
    <h4 class="outline-heading">{t('原题目标')}</h4><ul class="verification-targets">{targets.map(item => <Declaration key={item.name} item={item} explainRun={props.explainRun} />)}</ul>
    {helpers.length > 0 && <><h4 class="outline-heading">{t('新增辅助声明')}</h4><ul class="verification-targets">{helpers.map(item => <Declaration key={item.name} item={item} />)}</ul></>}
    {outline.omitted > 0 && <p class="report-method">{t('另有 {0} 个声明未列出', outline.omitted)}</p>}
    <div class="local-check"><a class="button" href={props.kitUrl} download>{fill(t('{0}下载本地复核包'), <Icon name="download" />)}</a>
      <span class="report-method">{t('包含原题、证明、固定版本的 Lean 工程文件和公理检查脚本。')}</span></div>
    <LocalCheckGuide mathlib={props.mathlib} />
  </>;
}
function Names(props: { names: string[] }) {
  return <>{props.names.map((name, index) => <Fragment key={index}>{index > 0 && t('、')}<code translate={false}>{name}</code></Fragment>)}</>;
}
function Declaration({ item, explainRun }: { item: WebProofOutlineDeclaration; explainRun?: string }) {
  const nonstandard = item.nonstandardAxioms ?? [];
  const kind = item.kind === 'definition' ? t('定义') : item.kind === 'instance' ? t('实例') : t('引理');
  return <li class="outline-item"><div class="item-heading"><code translate={false}>{item.name}</code>
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
