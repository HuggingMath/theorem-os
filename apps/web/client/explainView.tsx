import { Component, render } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { WebExplanation, WebExplanationDocument, WebExplanationGoals, WebExplanationLines, WebExplanationLink, WebExplanationOverview, WebExplanationPhase,
  WebExplanationSection, WebExplanationUse } from '../shared';
import { effortLabels, formatDuration, formatTokens } from '../presentation';
import { t } from '../i18n';
import { explanationEstimate, type StepRef } from './explainText';
import { explanationModelRequestFailuresText, explanationReasonText, explanationUnavailableText } from './explanationState';
import { ChosenBar, ProblemCard, type FragmentStep } from './correspondence';
import { LeanName, Rich, type RichLink } from './richText';
import { Icon, Spinner } from './ui/Icon';
import { fill } from './ui/Section';
import { explanationSolutionRoute } from './explainSolutionRoute';
import { SolutionRouteGraph } from './ui/SolutionRouteGraph';

/** What explain.ts draws from; every button carries a data-action that explain.ts handles. */
export type ExplainView = {
  overview: WebExplanationOverview; target: string; language: 'zh' | 'en'; pane: 'lean' | 'prose'; sync: boolean;
  compare: boolean;
  explanation?: WebExplanation; document?: WebExplanationDocument; documentError?: string; active?: StepRef;
  /** A Lean proof line the reader chose that no step quotes. */ gap?: number;
  /** The 原题 pairs the reader last chose (a fragment or a pair in its list). */ chosen?: ReadonlySet<number>;
  /** Where the last click on a 原题 fragment or pair stands, shown above the Lean on a phone. */ step?: FragmentStep;
  dialog?: 'generate' | 'cancel' | 'delete' | 'contents'; busy: boolean; error?: string; now: number;
  /** An offline report: the Markdown is a blob URL, and nothing can be generated or deleted. */ report?: { href: string; filename: string };
  /** A jump has a previous reading position to return to. */ canReturn?: boolean;
  /** Which declaration was in view when the contents dialog opened. */ readingSection?: number;
  onRouteOpen?: (target: string) => void;
  /** `outline` shows each declaration's statement only; `opened` are the sections whose steps the reader unfolded. */
  detail?: 'outline' | 'steps'; opened?: ReadonlySet<number>;
  /** The route node a link named or the reader chose, and where a choice is reported. */
  node?: string; onRouteSelect?: (id: string) => void;
  /** The optional graph stays mounted while the reader follows the prose. */
  routeOpen?: boolean; onRouteToggle?: (open: boolean) => void;
};

const kinds: Record<WebExplanationSection['kind'], string> = { theorem: t('引理'), definition: t('定义'), instance: t('实例'), opaque: t('定义'),
  axiom: t('公理'), inductive: t('归纳类型'), structure: t('结构'), class: t('类型类') };
const hours = (seconds: number) => seconds === 0 ? t('不限') : seconds >= 3600 ? t('约 {0} 小时', (seconds / 3600).toFixed(1)) : t('约 {0} 分钟', Math.max(1, Math.round(seconds / 60)));
export const linesLabel = (lines: readonly WebExplanationLines[]) =>
  t('第 {0} 行', lines.map(item => item.start === item.end ? String(item.start) : `${item.start}–${item.end}`).join(', '));
const Fact = (props: { label: string; value: string; mono?: boolean; wide?: boolean }) => <div class={props.wide ? 'explain-fact-wide' : undefined}><dt>{props.label}</dt><dd class={props.mono ? 'mono' : undefined}>{props.value}</dd></div>;

/** The target, explanation language, and reading layout. */
function Toolbar(view: ExplainView) {
  const { targets } = view.overview;
  const language = (value: 'zh' | 'en', label: string) => <button type="button" data-action="language" data-language={value} aria-pressed={view.language === value}>{label}</button>;
  const pane = (value: 'lean' | 'prose', label: string) => <button type="button" data-action="pane" data-pane={value} aria-pressed={view.pane === value}>{label}</button>;
  return <>
    {(targets.length > 1 || !view.document) && <div class="explain-target">{targets.length > 1
      ? <><label for="explain-target-select">{t('目标定理')}</label><select id="explain-target-select" translate={false} value={view.target}>
        {targets.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></>
      : <><span class="explain-target-label">{t('目标定理')}</span><code translate={false}><LeanName name={view.target} /></code></>}</div>}
    {!view.report && <div class="source-switch explain-language-switch" role="group" aria-label={t('讲解语言')}>{language('zh', t('中文'))}{language('en', t('英文'))}</div>}
    {view.document && <div class="source-switch explain-layout-switch" role="group" aria-label={t('阅读布局')}>
      <button type="button" data-action="layout" data-layout="read" aria-pressed={!view.compare}>{t('单栏阅读')}</button>
      <button type="button" data-action="layout" data-layout="compare" aria-pressed={view.compare}>{t('Lean 对照')}</button>
    </div>}
    <div class="source-switch explain-pane-switch" role="group" aria-label={t('显示的一侧')}>{pane('lean', 'Lean')}{pane('prose', t('讲解'))}</div>
  </>;
}

/** The saved document's reading controls and actions. */
function ProseHead(view: ExplainView) {
  const approved = view.explanation?.status === 'approved';
  const canDelete = view.explanation && !view.report && !['queued', 'running'].includes(view.explanation.status);
  if (!view.document && !approved && !canDelete) return null;
  const query = new URLSearchParams({ target: view.target, language: view.language }).toString();
  return (
    <div class="explain-head-actions">
      {view.canReturn && <button type="button" class="text-button explain-return" data-action="return"
        aria-label={t('返回阅读位置')} title={t('回到跳转前的位置，和浏览器的后退一样')}>
        <Icon name="arrow-left" /><span>{t('返回阅读位置')}</span></button>}
      {view.document && <div class="source-switch explain-detail-switch" role="group" aria-label={t('讲解详略')}>
        <button type="button" data-action="detail" data-detail="outline" aria-pressed={view.detail === 'outline'}>{t('概要')}</button>
        <button type="button" data-action="detail" data-detail="steps" aria-pressed={view.detail !== 'outline'}>{t('逐步')}</button></div>}
      {view.document && <label class="explain-sync"><input type="checkbox" id="explain-sync" checked={view.sync} /><span>{t('同步滚动')}</span></label>}
      {view.document && view.document.sections.length > 1 && <button type="button" class="icon-button explain-contents-button" data-action="contents"
        aria-haspopup="dialog" aria-label={t('证明目录')} title={t('证明目录')}><Icon name="list" /><span>{t('证明目录')}</span></button>}
      {view.report ? <a class="icon-button" href={view.report.href} download={view.report.filename}
        aria-label={t('下载 Markdown')} title={t('下载 Markdown')}><Icon name="download" /></a>
        : approved && <a class="icon-button" href={`/api/runs/${encodeURIComponent(view.overview.run.id)}/explanations/markdown?${query}`} download
        aria-label={t('下载 Markdown')} title={t('下载 Markdown')}><Icon name="download" /></a>}
      {canDelete &&
        <button type="button" class="icon-button" data-action="delete" aria-label={t('删除讲解')} title={t('删除讲解')}><Icon name="trash-2" /></button>}
    </div>
  );
}

/** The right pane: what can be generated, the progress of a generation, why it stopped, or the explanation itself. */
function Prose(view: ExplainView) {
  const { generation } = view.overview, explanation = view.explanation;
  const declarations = view.overview.targets.find(item => item.name === view.target)?.declarations ?? 1;
  if (explanation?.status === 'approved') {
    if (view.document) return <DocumentView document={view.document} proof={view.overview.run.proof} runId={view.overview.run.id}
      active={view.active} gap={view.gap} chosen={view.chosen} onRouteOpen={view.onRouteOpen} outline={view.detail === 'outline'} opened={view.opened} node={view.node} onRouteSelect={view.onRouteSelect}
      routeOpen={view.routeOpen} onRouteToggle={view.onRouteToggle} />;
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
      <h2>{t('还没有这份讲解')}</h2>
      <p>{t('模型从 Lean 证明出发写出自然语言证明：每个声明一节，每一步注明它对应的 Lean 行与用到的引理，再由独立的审核模型逐步对照 Lean 检查。')}</p></>}
    <p class="explain-estimate">{t('预计{0}，约 {1} Token。', hours(estimate.seconds), formatTokens(estimate.tokens))}</p>
    <button type="button" class="button button-primary" data-action="generate">{fill(explanation ? t('{0}重新生成') : t('{0}生成讲解'), <Icon name={explanation ? 'rotate-ccw' : 'play'} />)}</button>
  </div>;
}

const phaseTitle: Record<WebExplanationPhase, string> = {
  waiting_review: t('等待原题含义审核'), queued: t('排队等待生成'), preparing: t('正在准备 Lean 环境'),
  extracting: t('正在提取证明结构'), writing: t('正在撰写讲解'), auditing: t('正在逐步审核'),
  revising: t('按审核意见修改'), retrying: t('模型调用失败，正在重试'), finishing: t('正在整理讲解'),
};
const phaseDescription: Partial<Record<WebExplanationPhase, string>> = {
  waiting_review: t('原题含义审核通过后会自动安排讲解。'),
  auditing: t('审核模型正在逐步对照讲解和 Lean 证明。'),
  retrying: t('正在重新连接模型服务。可以稍后回来看结果。'),
};
function ProgressView({ explanation, now }: { explanation: WebExplanation; now: number }) {
  const progress = explanation.progress, phase = progress?.phase ?? (explanation.status === 'queued' ? 'queued' : 'preparing');
  const elapsed = now - Date.parse(explanation.createdAt);
  const batches = progress?.batches ?? 0, approved = progress?.approvedBatches ?? 0;
  const hasFailures = (progress?.modelRequestFailures ?? 0) > 0;
  const phaseIcon = phase === 'retrying' ? 'rotate-ccw' : explanation.status === 'queued' ? 'clock-3' : undefined;
  return <div class="explain-card explain-progress">
    <div class="explain-progress-heading" role="status">
      <span class="explain-progress-icon" aria-hidden="true">{phaseIcon ? <Icon name={phaseIcon} /> : <Spinner />}</span>
      <div><h2>{phaseTitle[phase]}</h2><p>{phaseDescription[phase] ?? t('生成在服务器上进行，可以关闭页面，稍后回来查看。')}</p></div>
    </div>
    {batches > 0 && <div class="explain-batch-progress">
      <div><label for="explain-batches">{t('已通过批次')}</label><span class="mono">{approved} / {batches}</span></div>
      <progress id="explain-batches" value={approved} max={batches} />
    </div>}
    <dl class="facts explain-facts explain-progress-facts">
      <Fact label={t('已用时间')} value={formatDuration(elapsed)} mono />
      {explanation.queue && <Fact label={t('排队位置')} value={t('前面 {0} 份', explanation.queue.ahead)} />}
      {progress?.round !== undefined && <Fact label={t('审核轮次')} value={t('第 {0} 轮', progress.round)} />}
      {hasFailures && <Fact label={t('模型请求失败次数')} value={String(progress?.modelRequestFailures)} mono />}
    </dl>
    <div class="explain-progress-actions">
      <details class="explain-disclosure">
        <summary>{t('用量与上限')}</summary>
        <dl class="facts explain-facts">
          <Fact label={t('Token 用量')} value={`${formatTokens(progress?.tokens ?? 0)} / ${explanation.maxTotalTokens ? formatTokens(explanation.maxTotalTokens) : t('不限')}`} mono />
          <Fact label={t('时间上限')} value={hours(explanation.maxRunSeconds)} />
        </dl>
      </details>
      <button type="button" class="button button-danger" data-action="cancel">{fill(t('{0}停止生成'), <Icon name="square" />)}</button>
    </div>
  </div>;
}
function StoppedView({ explanation }: { explanation: WebExplanation }) {
  const cancelled = explanation.status === 'cancelled';
  const needsReview = explanation.reason === 'explanation_statement_unreviewed';
  const modelRequestFailures = explanationModelRequestFailuresText(explanation.progress?.modelRequestFailures);
  return <div class={`result-banner ${cancelled ? 'warning' : 'failed'}`}><Icon name={cancelled ? 'square' : 'circle-alert'} />
    <div><h2>{needsReview ? t('暂未生成讲解') : cancelled ? t('已停止生成') : explanation.status === 'exhausted' ? t('讲解没有完成') : t('生成失败')}</h2>
      <p>{cancelled && !explanation.reason ? t('已用的 Token 不会退回。') : explanationReasonText(explanation.reason)}</p>
      {modelRequestFailures && <p>{modelRequestFailures}</p>}</div></div>;
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
function DocumentView({ document, proof, runId, active, gap, chosen, onRouteOpen, outline, opened, node, onRouteSelect, routeOpen, onRouteToggle }: { document: WebExplanationDocument; proof: string; runId: string;
  active?: StepRef; gap?: number; chosen?: ReadonlySet<number>; onRouteOpen?: (target: string) => void; outline?: boolean; opened?: ReadonlySet<number>;
  node?: string; onRouteSelect?: (id: string) => void; routeOpen?: boolean; onRouteToggle?: (open: boolean) => void }) {
  const [graphMounted, setGraphMounted] = useState(false);
  const loadGraph = Boolean(routeOpen || graphMounted);
  const route = useMemo(() => loadGraph ? explanationSolutionRoute(document, proof, `${runId}:explanation:${document.target}:${document.language}`) : undefined,
    [loadGraph, document, proof, runId]);
  let owned = ownedBy.get(document);
  if (!owned) ownedBy.set(document, owned = new Map(document.sections.map((section, index) => [section.name, index])));
  const mainline = (document.route ?? []).flatMap(stage => {
    const sections: number[] = [];
    for (const name of new Set(stage.declarations)) {
      const index = owned.get(name);
      if (index !== undefined) sections.push(index);
    }
    return sections.length && stage.claim.trim() ? [{ claim: stage.claim, sections }] : [];
  });
  const overview = document.overview.trim();
  const targetIndex = document.sections.findIndex(section => section.target);
  const target = document.sections[targetIndex];
  return <article class="explain-document container" lang={document.language === 'en' ? 'en' : 'zh-CN'}>
    {target && <header class="explain-lead">
      <h1 class="explain-lead-title"><Rich text={target.title || target.name} /></h1>
      <p class="explain-rich explain-lead-statement"><Rich text={target.statement} /></p>
      <button type="button" class="button explain-lead-jump" data-action="proof-jump" data-target={targetIndex}>
        {t('读主定理证明')}<Icon name="arrow-down" />
      </button>
    </header>}
    {mainline.length > 0 ? <section class="explain-overview explain-mainline-section" aria-labelledby="explain-mainline-heading">
      <h2 id="explain-mainline-heading">{t('证明主线')}</h2>
      <ol class="explain-mainline">{mainline.map((stage, index) => {
        const links = <ul class="explain-mainline-links">{stage.sections.map(section => {
          const declaration = document.sections[section]!;
          return <li key={declaration.name}><button type="button" class="text-button" data-action="mainline-jump"
            data-stage={index} data-target={section}><span><Rich text={declaration.title || declaration.name} /></span><Icon name="arrow-down" /></button></li>;
        })}</ul>;
        return <li key={index}>
          <p class="explain-rich explain-mainline-claim"><Rich text={stage.claim} /></p>
          {stage.sections.length > 3 ? <details class="explain-mainline-declarations">
            <summary>{t('相关声明（{0}）', stage.sections.length)}</summary>{links}
          </details> : links}
        </li>;
      })}</ol>
    </section> : overview && <section class="explain-overview">
      <h2>{t('证明思路')}</h2><p class="explain-rich"><Rich text={document.overview} /></p>
    </section>}
    <div class="explain-reading-options">
      {mainline.length > 0 && overview && <details class="explain-overview-detail explain-disclosure">
        <summary><Icon name="book-open" />{t('思路概述')}</summary><p class="explain-rich"><Rich text={document.overview} /></p>
      </details>}
      <details class="explain-route explain-disclosure" data-explain-route open={routeOpen} onToggle={event => {
        const open = event.currentTarget.open;
        if (open) setGraphMounted(true);
        onRouteToggle?.(open);
      }}>
        <summary><Icon name="git-branch" />{t('依赖图')}</summary>
        {route && <SolutionRouteGraph model={route} onOpen={onRouteOpen} selection={node} onSelect={onRouteSelect} />}
      </details>
      <details class="explain-reviews explain-provenance explain-disclosure">
        <summary><Icon name="shield-check" />{t('讲解来源与审阅')}</summary>
        <p>{t('Lean 已检查证明。讲解由模型撰写，{0} 个审核模型逐步对照 Lean 核对，未经人工审阅。', document.auditors)}</p>
        {linkedDocument(document) && <p>{t('讲解中划虚线的短语各对应一段 Lean，点它标出那段 Lean；审核模型核对过每一对。')}</p>}
        <DocumentFacts document={document} />
      </details>
    </div>
    {document.problem && <ProblemCard {...document.problem} active={chosen} />}
    {document.sections.map((section, index) => <CachedSection key={section.name} section={section} index={index}
      total={document.sections.length} next={document.sections[index + 1]} owned={owned} folded={!!outline && !opened?.has(index)}
      active={active?.section === index ? active : undefined} gap={active?.section === index ? gap : undefined} />)}
  </article>;
}
type SectionProps = { section: WebExplanationSection; index: number; total: number; next?: WebExplanationSection;
  owned: Map<string, number>; active?: StepRef; gap?: number; folded?: boolean };
/**
 * A section drawn again only when its props change: a click changes the active step, so a long proof redraws the
 * section it leaves and the one it reaches, not all of them.
 */
class CachedSection extends Component<SectionProps> {
  override shouldComponentUpdate(next: SectionProps) {
    const { section, index, total, next: following, owned, active, gap, folded } = this.props;
    return next.folded !== folded || next.section !== section || next.index !== index || next.owned !== owned || next.gap !== gap
      || next.total !== total || next.next !== following
      || next.active?.section !== active?.section || next.active?.step !== active?.step || next.active?.statement !== active?.statement;
  }
  override render() { return <SectionView {...this.props} />; }
}
function SectionView(props: SectionProps) {
  const { section, index, total, next, active } = props;
  const whole = active && active.step === undefined && !active.statement;
  const summary = props.folded && !active?.statement ? section.summary : undefined;
  // A theorem's statement explains its signature; any other declaration's statement explains all of it.
  const split = section.signature.start !== section.lines.start || section.signature.end !== section.lines.end;
  const statement = <>
    <p class="explain-rich explain-statement"><Rich text={section.statement}
      links={richLinks(section.statementLinks, { 'data-section': index, 'data-statement': '' })} /></p>
    {split && <div class="explain-step-meta">
      <button type="button" class="explain-lines" data-action="lines" data-section={index} data-statement="" title={t('在 Lean 中定位定理的陈述')}>
        {t('陈述 · {0}', linesLabel([section.signature]))}</button></div>}
  </>;
  return <section class={`explain-section${section.target ? ' is-target' : ''}${whole ? ' is-active' : ''}`}
    data-reading-section={index} aria-labelledby={`explain-section-${index}`}>
    <div class={`explain-statement-block${active?.statement ? ' is-active' : ''}`} data-anchor={index}>
      <header class="explain-section-head">
        <h2 id={`explain-section-${index}`} tabIndex={-1}><Rich text={section.title || section.name} /></h2>
        {total > 1 && <span class="explain-section-position"><span aria-hidden="true">{index + 1} / {total}</span>
          <span class="sr-only">{t('第 {0} 节，共 {1} 节', index + 1, total)}</span></span>}
        <div class="explain-section-meta">
          <span class="explain-section-kind">{section.target ? t('主定理') : kinds[section.kind]}</span>
          <code translate={false}><LeanName name={section.name} /></code>
          <button type="button" class="explain-lines" data-action="lines" data-section={index} title={t('在 Lean 中定位')}>{linesLabel([section.lines])}</button></div>
      </header>
      {summary ? <p class="explain-rich explain-summary"><Rich text={summary} /></p>
        : section.target ? <details class="explain-reviews explain-statement-details">
          <summary>{t('定理陈述')}</summary>
          <div class="explain-evidence-body">
            {statement}
            <ReviewNotes notes={section.statementReviews} label />
          </div>
        </details> : <>{statement}<ProofEvidence notes={section.statementReviews} /></>}
    </div>
    {props.gap !== undefined && <p class="explain-gap-note" role="status"><Icon name="circle-help" />
      <span>{t('第 {0} 行没有单独的讲解步骤。可对照本声明的前后推导和 Lean 源码；现有记录无法确认这一行是否已被充分解释。', props.gap)}</span></p>}
    {props.folded && (section.steps.length > 0 || section.summary) && <button type="button" class="text-button explain-unfold" data-action="unfold" data-section={index}>
      {section.steps.length ? fill(t('{0}展开 {1} 步'), <Icon name="chevron-down" />, String(section.steps.length)) : fill(t('{0}展开完整陈述'), <Icon name="chevron-down" />)}</button>}
    {!props.folded && section.steps.length > 0 && <ol class="explain-steps">{section.steps.map((step, stepIndex) =>
      <li key={stepIndex} class={active?.step === stepIndex ? 'is-active' : undefined} data-anchor={index} data-step={stepIndex}>
        <p class="explain-rich"><Rich text={step.text} links={richLinks(step.links, { 'data-section': index, 'data-step': stepIndex })} /></p>
        <div class="explain-step-meta">
          <button type="button" class="explain-lines" data-action="lines" data-section={index} data-step={stepIndex} title={t('在 Lean 中定位')}>
            {step.lines.length ? linesLabel(step.lines) : t('整个声明')}</button>
          {step.uses.length > 0 && <Uses uses={step.uses} owned={props.owned} section={index} step={stepIndex} />}
        </div>
        <ProofEvidence notes={step.reviews} goals={step.goals} checked={step.goalsChecked} />
      </li>)}</ol>}
    {!props.folded && next && <button type="button" class="explain-section-next" data-action="section-next" data-section={index} data-target={index + 1}>
      <span class="explain-next-label">{t('下一节')}</span>
      <span class="explain-next-title"><Rich text={next.title || next.name} /></span>
      <Icon name="arrow-down" />
    </button>}
  </section>;
}
/** Lean's goals around the quoted tactics. `checked` auditors compared the step with them. */
function Goals({ goals, checked }: { goals: WebExplanationGoals; checked?: number }) {
  const state = (items: string[], total: number) => total === 0 ? <p class="explain-goal-none">{t('没有剩余目标')}</p> : <>
    {items.map((goal, index) => <pre key={index} class="explain-goal" tabIndex={0} translate={false}>{goal}</pre>)}
    {total > items.length && <p class="explain-goal-none">{t('另有 {0} 个目标没有显示', total - items.length)}</p>}</>;
  return <div class="explain-goals"><p class="explain-evidence-label">{t('Lean 目标 · {0}', linesLabel([goals.lines]))}
    {checked ? <span class="explain-goal-checked" title={t('审核模型把这一步的讲解和这些目标逐个对照过，判断一致')}>
      {fill(t('{0}{1} 个审核模型对照过'), <Icon name="check" />, String(checked))}</span> : null}</p>
    <p class="explain-goal-label">{t('之前')}</p>{state(goals.before, goals.beforeCount)}
    <p class="explain-goal-label">{t('之后')}</p>{state(goals.after, goals.afterCount)}</div>;
}
function ReviewNotes({ notes, label }: { notes: string[]; label?: boolean }) {
  if (!notes.length) return null;
  return <div class="explain-review-notes">
    {label && <p class="explain-evidence-label">{t('审核说明')}</p>}
    <ul>{notes.map((note, index) => <li key={index} class="explain-rich"><Rich text={note} /></li>)}</ul>
  </div>;
}
/** Keep one disclosure per step. Goals and auditor notes are shown together when available. */
function ProofEvidence({ notes, goals, checked }: { notes: string[]; goals?: WebExplanationGoals; checked?: number }) {
  if (!notes.length && !goals) return null;
  return <details class="explain-reviews">
    <summary>{goals ? t('核对这一步') : t('审核说明')}</summary>
    <div class="explain-evidence-body">
      {goals && <Goals goals={goals} checked={checked} />}
      <ReviewNotes notes={notes} label={Boolean(goals)} />
    </div>
  </details>;
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
function DocumentFacts({ document }: { document: WebExplanationDocument }) {
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
  return <dl class="facts explain-facts">{items.map(([label, value, mono, wide]) => <Fact key={label} label={label} value={value} mono={mono} wide={wide} />)}</dl>;
}

/** The side list follows the order of the proof. The search dialog puts the main theorem first. */
export function renderContentsRail(host: HTMLElement, document?: WebExplanationDocument) {
  const show = document && document.sections.length > 1;
  host.hidden = !show;
  render(show ? <>
    <p id="explain-rail-heading" class="explain-rail-heading">{t('证明章节')}</p>
    <ol class="explain-rail-list" role="list">
      {document.sections.map((section, index) => <li key={section.name}>
        <button type="button" data-action="contents-rail-jump" data-target={index}>
          <span class="explain-rail-number" aria-hidden="true">{index + 1}</span>
          <span class="explain-rail-title" lang={document.language === 'zh' ? 'zh-CN' : 'en'}><Rich text={section.title || section.name} /></span>
          {section.target && <span class="explain-rail-target">{t('主定理')}</span>}
        </button>
      </li>)}
    </ol>
  </> : null, host);
}

function ProofContents({ document, selected }: { document: WebExplanationDocument; selected?: number }) {
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const searchLabel = t('标题或 Lean 名称');
  const entries = document.sections.map((section, index) => ({ section, index })).filter(({ section }) =>
    section.title.toLowerCase().includes(query) || section.name.toLowerCase().includes(query));
  const groups = [
    { label: t('主定理'), entries: entries.filter(({ section }) => section.target) },
    { label: t('辅助声明'), entries: entries.filter(({ section }) => !section.target) },
  ];
  return <div class="explain-contents">
    <header class="confirm-heading">
      <h2 id="explain-dialog-heading">{t('证明目录')}</h2>
      <button type="button" class="icon-button" data-action="close-dialog" aria-label={t('关闭')} title={t('关闭')}><Icon name="x" /></button>
    </header>
    <label class="explain-contents-search">
      <Icon name="search" /><span class="sr-only">{searchLabel}</span>
      <input type="search" value={search} placeholder={searchLabel}
        onInput={event => setSearch(event.currentTarget.value)} />
    </label>
    <div class="explain-contents-list">
      {!entries.length && <p class="explain-contents-empty" role="status">{t('没有匹配的声明')}</p>}
      {groups.map(group => group.entries.length > 0 && <section key={group.label}>
        <h3>{group.label}</h3>
        <ul>{group.entries.map(({ section, index }) => <li key={section.name}>
          <button type="button" data-action="contents-jump" data-target={index} aria-current={index === selected ? 'location' : undefined}>
            <span class="explain-contents-number" aria-hidden="true">{index + 1}</span>
            <span class="explain-contents-entry" lang={document.language === 'zh' ? 'zh-CN' : 'en'}>
              <span><Rich text={section.title || section.name} /></span>
              {section.title && section.title !== section.name && <code translate={false}><LeanName name={section.name} /></code>}
            </span>
            {index === selected ? <span class="explain-contents-current">{t('正在读')}</span> : <Icon name="chevron-right" />}
          </button>
        </li>)}</ul>
      </section>)}
    </div>
  </div>;
}

/** Reading navigation and the generate, stop and delete confirmations. */
function Dialog(view: ExplainView) {
  if (view.dialog === 'contents' && view.document) return <ProofContents document={view.document} selected={view.readingSection} />;
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
          <Fact label={t('上限')} value={t('{0} · {1} Token', hours(generation.maxRunSeconds), generation.maxTotalTokens ? formatTokens(generation.maxTotalTokens) : t('不限'))} />
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
