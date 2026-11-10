import { Component, render } from 'preact';
import { useMemo } from 'preact/hooks';
import type { WebExplanation, WebExplanationDocument, WebExplanationGoals, WebExplanationLines, WebExplanationLink, WebExplanationOverview,
  WebExplanationSection, WebExplanationUse } from '../shared';
import { effortLabels, formatDuration, formatTokens } from '../presentation';
import { t } from '../i18n';
import { explanationEstimate, type StepRef } from './explainText';
import { explanationReasonText, explanationUnavailableText } from './explanationState';
import { ChosenBar, ProblemCard, type FragmentStep } from './correspondence';
import { LeanName, Rich, type RichLink } from './richText';
import { Icon, Spinner } from './ui/Icon';
import { fill } from './ui/Section';
import { explanationSolutionRoute } from './explainSolutionRoute';
import { SolutionRouteGraph } from './ui/SolutionRouteGraph';

/** What explain.ts draws from; every button carries a data-action that explain.ts handles. */
export type ExplainView = {
  overview: WebExplanationOverview; target: string; language: 'zh' | 'en'; pane: 'lean' | 'prose'; sync: boolean;
  explanation?: WebExplanation; document?: WebExplanationDocument; documentError?: string; active?: StepRef;
  /** A Lean proof line the reader chose that no step quotes. */ gap?: number;
  /** The 原题 pairs the reader last chose (a fragment or a pair in its list). */ chosen?: ReadonlySet<number>;
  /** Where the last click on a 原题 fragment or pair stands, shown above the Lean on a phone. */ step?: FragmentStep;
  dialog?: 'generate' | 'cancel' | 'delete'; busy: boolean; error?: string; now: number;
  /** An offline report: the Markdown is a blob URL, and nothing can be generated or deleted. */ report?: { href: string; filename: string };
  /** The reader followed a cited lemma and can go back to where they cited it. */ canReturn?: boolean;
  onRouteOpen?: (target: string) => void;
};

const kinds: Record<WebExplanationSection['kind'], string> = { theorem: t('引理'), definition: t('定义'), instance: t('实例'), opaque: t('定义'),
  axiom: t('公理'), inductive: t('归纳类型'), structure: t('结构'), class: t('类型类') };
const hours = (seconds: number) => seconds >= 3600 ? t('约 {0} 小时', (seconds / 3600).toFixed(1)) : t('约 {0} 分钟', Math.max(1, Math.round(seconds / 60)));
export const linesLabel = (lines: readonly WebExplanationLines[]) =>
  t('第 {0} 行', lines.map(item => item.start === item.end ? String(item.start) : `${item.start}–${item.end}`).join(', '));
const Fact = (props: { label: string; value: string; mono?: boolean; wide?: boolean }) => <div class={props.wide ? 'explain-fact-wide' : undefined}><dt>{props.label}</dt><dd class={props.mono ? 'mono' : undefined}>{props.value}</dd></div>;

/** The target, the explanation language, and on phones which pane is shown. */
function Toolbar(view: ExplainView) {
  const { targets } = view.overview;
  const language = (value: 'zh' | 'en', label: string) => <button type="button" data-action="language" data-language={value} aria-pressed={view.language === value}>{label}</button>;
  const pane = (value: 'lean' | 'prose', label: string) => <button type="button" data-action="pane" data-pane={value} aria-pressed={view.pane === value}>{label}</button>;
  return <>
    <div class="explain-target">{targets.length > 1
      ? <><label for="explain-target-select">{t('目标定理')}</label><select id="explain-target-select" translate={false} value={view.target}>
        {targets.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></>
      : <><span class="explain-target-label">{t('目标定理')}</span><code translate={false}><LeanName name={view.target} /></code></>}</div>
    {!view.report && <div class="source-switch explain-language-switch" role="group" aria-label={t('讲解语言')}>{language('zh', t('中文'))}{language('en', t('英文'))}</div>}
    <div class="source-switch explain-pane-switch" role="group" aria-label={t('显示的一侧')}>{pane('lean', 'Lean')}{pane('prose', t('讲解'))}</div>
  </>;
}

/** The right pane's heading: the way back from a cited lemma, scroll sync and, once approved, download and delete. */
function ProseHead(view: ExplainView) {
  const approved = view.explanation?.status === 'approved';
  const query = new URLSearchParams({ target: view.target, language: view.language }).toString();
  return <>
    <h2 id="explain-prose-heading">{t('自然语言证明')}</h2>
    <div class="explain-head-actions">
      {view.canReturn && <button type="button" class="text-button explain-return" data-action="return" title={t('回到跳转前的位置，和浏览器的后退一样')}>
        {fill(t('{0}回到引用处'), <Icon name="arrow-left" />)}</button>}
      {view.document && <label class="explain-sync"><input type="checkbox" id="explain-sync" checked={view.sync} /><span>{t('同步滚动')}</span></label>}
      {view.report ? <a class="icon-button" href={view.report.href} download={view.report.filename}
        aria-label={t('下载 Markdown')} title={t('下载 Markdown')}><Icon name="download" /></a>
        : approved && <a class="icon-button" href={`/api/runs/${encodeURIComponent(view.overview.run.id)}/explanations/markdown?${query}`} download
        aria-label={t('下载 Markdown')} title={t('下载 Markdown')}><Icon name="download" /></a>}
      {view.explanation && !view.report && !['queued', 'running'].includes(view.explanation.status) &&
        <button type="button" class="icon-button" data-action="delete" aria-label={t('删除讲解')} title={t('删除讲解')}><Icon name="trash-2" /></button>}
    </div>
  </>;
}

/** The right pane: what can be generated, the progress of a generation, why it stopped, or the explanation itself. */
function Prose(view: ExplainView) {
  const { generation } = view.overview, explanation = view.explanation;
  const declarations = view.overview.targets.find(item => item.name === view.target)?.declarations ?? 1;
  if (explanation?.status === 'approved') {
    if (view.document) return <DocumentView document={view.document} proof={view.overview.run.proof} runId={view.overview.run.id}
      active={view.active} gap={view.gap} chosen={view.chosen} onRouteOpen={view.onRouteOpen} />;
    return view.documentError ? <div class="inline-error" role="alert">{view.documentError}</div>
      : <p class="explain-state" role="status"><Spinner />{t('正在读取讲解…')}</p>;
  }
  if (explanation && (explanation.status === 'queued' || explanation.status === 'running')) return <ProgressView explanation={explanation} now={view.now} />;
  if ('reason' in generation) return <div class="explain-card">
    {explanation && <StoppedView explanation={explanation} />}
    <div class="empty-state compact"><Icon name="book-open" /><p>{explanationUnavailableText(generation.reason)}</p></div></div>;
  const estimate = explanationEstimate(declarations, generation.reference, generation);
  return <div class="explain-card">
    {explanation ? <StoppedView explanation={explanation} /> : <>
      <h3>{t('还没有这份讲解')}</h3>
      <p>{t('模型从 Lean 证明出发写出自然语言证明：每个声明一节，每一步注明它对应的 Lean 行与用到的引理，再由独立的审核模型逐步对照 Lean 检查。')}</p></>}
    <p class="explain-estimate">{t('预计{0}，约 {1} Token。', hours(estimate.seconds), formatTokens(estimate.tokens))}</p>
    <button type="button" class="button button-primary" data-action="generate">{fill(explanation ? t('{0}重新生成') : t('{0}生成讲解'), <Icon name={explanation ? 'rotate-ccw' : 'play'} />)}</button>
  </div>;
}

const phases = [
  { id: 'queued', label: t('排队'), phases: ['queued'] }, { id: 'preparing', label: t('准备环境'), phases: ['preparing'] },
  { id: 'extracting', label: t('提取证明结构'), phases: ['extracting'] },
  { id: 'writing', label: t('写作与审核'), phases: ['writing', 'auditing', 'revising', 'retrying'] }, { id: 'finishing', label: t('整理结果'), phases: ['finishing'] },
];
const phaseDetail: Record<string, string> = { writing: t('正在写作'), auditing: t('正在审核'), revising: t('按审核意见修改'), retrying: t('模型调用失败，正在重试') };
function ProgressView({ explanation, now }: { explanation: WebExplanation; now: number }) {
  const progress = explanation.progress, phase = explanation.status === 'queued' ? 'queued' : progress?.phase ?? 'preparing';
  const current = Math.max(0, phases.findIndex(item => item.phases.includes(phase)));
  const elapsed = now - Date.parse(explanation.createdAt);
  return <div class="explain-card explain-progress" aria-live="polite">
    <div class="result-banner running"><Spinner /><div><h3>{explanation.status === 'queued' ? t('排队等待生成') : t('正在生成讲解')}</h3>
      <p>{t('生成在服务器上进行，可以关闭页面，稍后回来查看。')}</p></div></div>
    <ol class="explain-phases">{phases.map((item, index) => <li key={item.id} class={index < current ? 'done' : index === current ? 'active' : undefined}
      aria-current={index === current ? 'step' : undefined}>{index < current ? <Icon name="check" /> : <span class="explain-phase-dot" />}<span>{item.label}</span>
      {index === current && phaseDetail[phase] && <span class="explain-phase-detail">{phaseDetail[phase]}</span>}</li>)}</ol>
    <dl class="facts explain-facts">
      <Fact label={t('已用时间')} value={formatDuration(elapsed)} mono />
      {explanation.queue && <Fact label={t('排队位置')} value={t('前面 {0} 份', explanation.queue.ahead)} />}
      {progress?.batches !== undefined && <Fact label={t('已通过批次')} value={`${progress.approvedBatches ?? 0}/${progress.batches}`} mono />}
      {progress?.round !== undefined && <Fact label={t('审核轮次')} value={t('第 {0} 轮', progress.round)} />}
      <Fact label={t('Token 用量')} value={`${formatTokens(progress?.tokens ?? 0)} / ${formatTokens(explanation.maxTotalTokens)}`} mono />
      <Fact label={t('时间上限')} value={hours(explanation.maxRunSeconds)} />
    </dl>
    <button type="button" class="button button-danger" data-action="cancel">{fill(t('{0}停止生成'), <Icon name="square" />)}</button>
  </div>;
}
function StoppedView({ explanation }: { explanation: WebExplanation }) {
  const cancelled = explanation.status === 'cancelled';
  return <div class={`result-banner ${cancelled ? 'warning' : 'failed'}`}><Icon name={cancelled ? 'square' : 'circle-alert'} />
    <div><h3>{cancelled ? t('已停止生成') : explanation.status === 'exhausted' ? t('讲解没有完成') : t('生成失败')}</h3>
      <p>{cancelled ? t('已用的 Token 不会退回。') : explanationReasonText(explanation.reason)}</p></div></div>;
}

/** The approved explanation: overview, then one section per declaration in file order, each step tied to its Lean lines. */
const linkedDocument = (document: WebExplanationDocument) =>
  document.sections.some(section => section.statementLinks?.length || section.steps.some(step => step.links?.length));
/** A statement's or step's linked phrases, each pointing back at it so explain.ts finds the Lean spans. */
const richLinks = (links: readonly WebExplanationLink[] | undefined, at: Record<`data-${string}`, string | number>): RichLink[] =>
  (links ?? []).map((link, index) => ({ start: link.start, end: link.end, attributes: { 'data-action': 'link', ...at, 'data-link': index },
    title: t('在 Lean 中标出') }));
// Which section explains each declaration, once per document, so a section's props stay the same between draws.
const ownedBy = new WeakMap<WebExplanationDocument, Map<string, number>>();
function DocumentView({ document, proof, runId, active, gap, chosen, onRouteOpen }: { document: WebExplanationDocument; proof: string; runId: string;
  active?: StepRef; gap?: number; chosen?: ReadonlySet<number>; onRouteOpen?: (target: string) => void }) {
  const route = useMemo(() => explanationSolutionRoute(document, proof, `${runId}:explanation:${document.target}:${document.language}`), [document, proof, runId]);
  let owned = ownedBy.get(document);
  if (!owned) ownedBy.set(document, owned = new Map(document.sections.map((section, index) => [section.name, index])));
  return <article class="explain-document" lang={document.language === 'en' ? 'en' : 'zh-CN'}>
    <p class="explain-notice"><Icon name="triangle-alert" />
      <span>{t('这份讲解由模型根据 Lean 证明写成，并由 {0} 个审核模型逐步对照 Lean 检查，未经人工审阅。Lean 只检查了证明本身，没有检查这份讲解。', document.auditors)}</span></p>
    {document.problem && <ProblemCard {...document.problem} active={chosen} />}
    <section class="explain-overview" aria-labelledby="explain-overview-heading"><h3 id="explain-overview-heading">{t('证明思路')}</h3>
      <p class="explain-rich"><Rich text={document.overview} /></p>
      {linkedDocument(document) && <p class="formal-note"><Icon name="locate-fixed" />
        <span>{t('讲解中划虚线的短语各对应一段 Lean，点它标出那段 Lean；审核模型核对过每一对。')}</span></p>}</section>
    <SolutionRouteGraph model={route} onOpen={onRouteOpen} />
    {document.sections.map((section, index) => <CachedSection key={section.name} section={section} index={index} owned={owned}
      active={active?.section === index ? active : undefined} gap={active?.section === index ? gap : undefined} />)}
    <Footer document={document} />
  </article>;
}
type SectionProps = { section: WebExplanationSection; index: number; owned: Map<string, number>; active?: StepRef; gap?: number };
/**
 * A section drawn again only when its props change: a click changes the active step, so a long proof redraws the
 * section it leaves and the one it reaches, not all of them.
 */
class CachedSection extends Component<SectionProps> {
  override shouldComponentUpdate(next: SectionProps) {
    const { section, index, owned, active, gap } = this.props;
    return next.section !== section || next.index !== index || next.owned !== owned || next.gap !== gap
      || next.active?.section !== active?.section || next.active?.step !== active?.step || next.active?.statement !== active?.statement;
  }
  override render() { return <SectionView {...this.props} />; }
}
function SectionView(props: SectionProps) {
  const { section, index, active } = props;
  const whole = active && active.step === undefined && !active.statement;
  // A theorem's statement explains its signature; any other declaration's statement explains all of it.
  const split = section.signature.start !== section.lines.start || section.signature.end !== section.lines.end;
  return <section class={`explain-section${section.target ? ' is-target' : ''}${whole ? ' is-active' : ''}`} aria-labelledby={`explain-section-${index}`}>
    <div class={`explain-statement-block${active?.statement ? ' is-active' : ''}`} data-anchor={index}>
      <header class="explain-section-head">
        <div class="explain-section-meta">{section.target ? <span class="badge passed">{t('主定理')}</span> : <span class="badge">{kinds[section.kind]}</span>}
          <code translate={false}><LeanName name={section.name} /></code>
          <button type="button" class="explain-lines" data-action="lines" data-section={index} title={t('在 Lean 中定位')}>{linesLabel([section.lines])}</button></div>
        <h3 id={`explain-section-${index}`} tabIndex={-1}><Rich text={section.title} /></h3>
      </header>
      <p class="explain-rich explain-statement"><Rich text={section.statement}
        links={richLinks(section.statementLinks, { 'data-section': index, 'data-statement': '' })} /></p>
      {split && <div class="explain-step-meta">
        <button type="button" class="explain-lines" data-action="lines" data-section={index} data-statement="" title={t('在 Lean 中定位定理的陈述')}>
          {t('陈述 · {0}', linesLabel([section.signature]))}</button></div>}
      <Reviews notes={section.statementReviews} />
    </div>
    {props.gap !== undefined && <p class="explain-gap-note" role="status"><Icon name="circle-help" />
      <span>{t('第 {0} 行没有单独的讲解步骤。审核模型检查的是整个声明，有实质证明内容没讲到就不会通过；没有单独一步的行，通常是 intro、rfl 这类记账步骤。', props.gap)}</span></p>}
    {section.steps.length > 0 && <ol class="explain-steps">{section.steps.map((step, stepIndex) =>
      <li key={stepIndex} class={active?.step === stepIndex ? 'is-active' : undefined} data-anchor={index} data-step={stepIndex}>
        <p class="explain-rich"><Rich text={step.text} links={richLinks(step.links, { 'data-section': index, 'data-step': stepIndex })} /></p>
        <div class="explain-step-meta">
          <button type="button" class="explain-lines" data-action="lines" data-section={index} data-step={stepIndex} title={t('在 Lean 中定位')}>
            {step.lines.length ? linesLabel(step.lines) : t('整个声明')}</button>
          {step.uses.length > 0 && <Uses uses={step.uses} owned={props.owned} section={index} step={stepIndex} />}
        </div>
        <Reviews notes={step.reviews} />
        {step.goals && <Goals goals={step.goals} checked={step.goalsChecked} />}
      </li>)}</ol>}
  </section>;
}
/** Lean's goals around the quoted tactics, folded; Lean's text, so never translated. `checked` auditors compared the step with them. */
function Goals({ goals, checked }: { goals: WebExplanationGoals; checked?: number }) {
  const state = (items: string[], total: number) => total === 0 ? <p class="explain-goal-none">{t('没有剩余目标')}</p> : <>
    {items.map((goal, index) => <pre key={index} class="explain-goal" tabIndex={0} translate={false}>{goal}</pre>)}
    {total > items.length && <p class="explain-goal-none">{t('另有 {0} 个目标没有显示', total - items.length)}</p>}</>;
  return <details class="explain-reviews explain-goals"><summary>{fill(t('{0}Lean 目标 · {1}'), <Icon name="locate-fixed" />, linesLabel([goals.lines]))}
    {checked ? <span class="explain-goal-checked" title={t('审核模型把这一步的讲解和这些目标逐个对照过，判断一致')}>
      {fill(t('{0}{1} 个审核模型对照过'), <Icon name="check" />, String(checked))}</span> : null}</summary>
    <p class="explain-goal-label">{t('之前')}</p>{state(goals.before, goals.beforeCount)}
    <p class="explain-goal-label">{t('之后')}</p>{state(goals.after, goals.afterCount)}</details>;
}
/** What the independent auditors wrote about a statement or step, folded. */
function Reviews({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return <details class="explain-reviews"><summary>{fill(t('{0}审核说明 ({1})'), <Icon name="shield-check" />, String(notes.length))}</summary>
    <ul>{notes.map((note, index) => <li key={index} class="explain-rich"><Rich text={note} /></li>)}</ul></details>;
}
const placeNote: Record<WebExplanationUse['place'], string> = {
  step: t('写在这一步引用的 Lean 里'), declaration: t('写在这个声明的其他行里'),
  implicit: t('Lean 源码里没有直接写出这个名字，通过记号或自动化（如 simp）用到'),
};
/** Cited names: owned ones jump to their section; a name written in the Lean is marked there on hover, focus or click. */
function Uses(props: { uses: WebExplanationUse[]; owned: Map<string, number>; section: number; step: number }) {
  return <span class="explain-uses"><span>{t('用到')}</span>{props.uses.map((use, index) => {
    const owned = props.owned.get(use.name), place = `explain-use place-${use.place}${owned === undefined ? ' external' : ''}`;
    const data = { 'data-section': props.section, 'data-step': props.step, 'data-use': index };
    const hint = <span class="sr-only">{t('（{0}）', placeNote[use.place])}</span>;
    if (owned !== undefined) return <button key={use.name} type="button" class={place} data-action="use" {...data} data-target={owned}
      title={`${t('跳到这个声明的讲解')} · ${placeNote[use.place]}`} translate={false}>{use.name}{hint}</button>;
    if (use.spans.length) return <button key={use.name} type="button" class={place} data-action="use-lean" {...data}
      title={`${t('在 Lean 中标出')} · ${placeNote[use.place]}`} translate={false}>{use.name}{hint}</button>;
    return <code key={use.name} class={place} title={placeNote[use.place]} translate={false}>{use.name}{hint}</code>;
  })}</span>;
}
function Footer({ document }: { document: WebExplanationDocument }) {
  // Toolchain and Mathlib revision are long identifiers; they take a whole row instead of breaking inside a column.
  const items: [string, string, boolean?, boolean?][] = [
    [t('声明数'), String(document.metrics.declarations)], [t('步骤数'), String(document.metrics.steps)], [t('引用数'), String(document.metrics.citations)],
    // Lines, not characters: a theorem's signature is explained by its statement, its proof lines by the steps.
    ...document.metrics.proofLines ? [[t('逐步讲到的证明行'), `${document.metrics.explainedLines}/${document.metrics.proofLines}`] as [string, string]] : [],
    ...document.metrics.ambiguousExcerpts ? [[t('重复出现的引用片段'), String(document.metrics.ambiguousExcerpts)] as [string, string]] : [],
    [t('模型'), document.model, true], [t('推理强度'), effortLabels[document.effort as keyof typeof effortLabels] ?? document.effort],
    [t('审核轮次'), String(document.rounds)], [t('Token 用量'), document.tokens === null ? t('未记录') : formatTokens(document.tokens)],
    [t('Lean 工具链'), document.toolchain, true, true],
    ...document.mathlibRevision ? [[t('Mathlib 版本'), document.mathlibRevision, true, true] as [string, string, boolean, boolean]] : [],
    [t('依赖的公理'), document.axioms.length ? document.axioms.join(', ') : t('无'), true],
  ];
  return <dl class="facts explain-facts explain-footer">{items.map(([label, value, mono, wide]) => <Fact key={label} label={label} value={value} mono={mono} wide={wide} />)}</dl>;
}

/** The generate confirmation (estimate, caps, key) and the stop and delete confirmations. */
function Dialog(view: ExplainView) {
  const { generation } = view.overview;
  const header = (title: string) => <header class="confirm-heading"><h2 id="explain-dialog-heading">{title}</h2>
    <button type="button" class="icon-button" data-action="close-dialog" aria-label={t('关闭')} title={t('关闭')}><Icon name="x" /></button></header>;
  const error = view.error && <div class="inline-error" role="alert">{view.error}</div>;
  if (view.dialog === 'generate' && !('reason' in generation)) {
    const declarations = view.overview.targets.find(item => item.name === view.target)?.declarations ?? 1;
    const estimate = explanationEstimate(declarations, generation.reference, generation), { reference } = generation;
    return <form id="explain-generate-form" method="dialog">{header(t('生成证明讲解'))}
      <div class="confirm-content">
        <p class="confirm-title" translate={false}>{view.target}</p>
        <dl class="facts explain-dialog-facts">
          <Fact label={t('讲解语言')} value={view.language === 'zh' ? t('中文') : t('英文')} />
          <Fact label={t('模型')} value={`${generation.model} · ${effortLabels[generation.effort]}`} mono />
          <Fact label={t('预计时间')} value={hours(estimate.seconds)} />
          <Fact label={t('预计 Token')} value={formatTokens(estimate.tokens)} mono />
          <Fact label={t('上限')} value={t('{0} · {1} Token', hours(generation.maxRunSeconds), formatTokens(generation.maxTotalTokens))} />
        </dl>
        <p class="field-note explain-dialog-note">{t('按 {0} 个声明估算：参考运行 {1} 个声明用了{2}和 {3} Token。实际用量取决于证明长度和审核轮数。',
          declarations, reference.declarations, hours(reference.seconds), formatTokens(reference.tokens))}</p>
        {generation.key === 'required' ? <><label for="explain-api-key">API Key</label>
          <input id="explain-api-key" name="apiKey" type="password" autoComplete="off" spellcheck={false} required minLength={8} maxLength={4096} />
          <p class="field-note">{t('只用于这次生成，不会保存。')}</p></>
          : <p class="field-note">{generation.key === 'saved' ? t('使用账号里保存的 API Key。') : t('使用服务提供的 API Key。')}</p>}
        <p class="confirmation-notice">{t('生成在服务器上进行，可以关闭页面。达到上限或中途停止时，已用的 Token 不会退回。')}</p>
        {error}
      </div>
      <footer class="confirm-footer"><button type="button" class="button" data-action="close-dialog">{t('取消')}</button>
        <button type="submit" class="button button-primary" disabled={view.busy}>{view.busy ? <Spinner /> : <Icon name="play" />}<span>{t('开始生成')}</span></button></footer>
    </form>;
  }
  if (view.dialog === 'cancel') return <>{header(t('停止生成讲解？'))}
    <div class="confirm-content"><p class="confirmation-notice">{t('已用的 Token 不会退回；之后重新生成会从头开始。')}</p>{error}</div>
    <footer class="confirm-footer"><button type="button" class="button" data-action="close-dialog">{t('继续生成')}</button>
      <button type="button" class="button button-destructive" data-action="confirm-cancel" disabled={view.busy}><Icon name="square" /><span>{t('停止生成')}</span></button></footer></>;
  if (view.dialog === 'delete') return <>{header(t('删除这份讲解？'))}
    <div class="confirm-content"><p class="confirmation-notice">{t('删除后无法恢复，需要重新生成。需要保留的话，请先下载 Markdown。')}</p>{error}</div>
    <footer class="confirm-footer"><button type="button" class="button" data-action="close-dialog">{t('取消')}</button>
      <button type="button" class="button button-destructive" data-action="confirm-delete" disabled={view.busy}><Icon name="trash-2" /><span>{t('删除讲解')}</span></button></footer></>;
  return null;
}

/** What the marks beside the Lean line numbers mean; shown once an explanation is open. */
function LeanLegend({ document }: { document?: WebExplanationDocument }) {
  if (!document) return null;
  const unexplained = document.sections.reduce((sum, section) => sum + section.unexplained.length, 0);
  return <>
    <span class="explain-legend-item"><span class="lean-mark-sample is-step" aria-hidden="true">1</span>{t('讲解步骤')}</span>
    <span class="explain-legend-item"><span class="lean-mark-sample is-statement" aria-hidden="true" />{t('由陈述讲解')}</span>
    {unexplained > 0 && <span class="explain-legend-item"><span class="lean-mark-sample is-unexplained" aria-hidden="true" />{t('没有单独讲解 ({0} 行)', unexplained)}</span>}
  </>;
}

export function renderExplain(hosts: { toolbar: HTMLElement; head: HTMLElement; prose: HTMLElement; dialog: HTMLElement; legend: HTMLElement;
  chosen: HTMLElement }, view: ExplainView) {
  render(<LeanLegend document={view.document} />, hosts.legend);
  hosts.legend.hidden = !view.document;
  const problem = view.document?.problem;
  render(problem && view.step ? <ChosenBar original={problem.original} correspondences={problem.correspondences} step={view.step} /> : null, hosts.chosen);
  render(<Toolbar {...view} />, hosts.toolbar);
  render(<ProseHead {...view} />, hosts.head);
  render(<Prose {...view} />, hosts.prose);
  render(<Dialog {...view} />, hosts.dialog);
}
