import { render } from 'preact';
import type { WebFormalizationReport } from '../shared';
import { effortLabels, formatDateTime } from '../presentation';
import { t } from '../i18n';
import { ChosenBar, Correspondences, OriginalText, originalPieces, type FragmentStep } from './correspondence';
import { LeanName, Rich } from './richText';
import { Icon } from './ui/Icon';

/** What formalization.ts draws from; correspondence marks and items carry data-action="correspondence". */
export type FormalizationView = { report: WebFormalizationReport; pane: 'lean' | 'prose'; active: ReadonlySet<number>; step?: FragmentStep; confirmed?: boolean };

const checkLabels: Record<string, string> = {
  domains: t('对象与取值范围'), assumptions: t('假设'), conclusions: t('结论'), definitions: t('用到的定义'),
  quantifierScope: t('量词范围'), instanceCoherence: t('类型类实例'), equivalent: t('与原题等价'), complete: t('完整'),
};
const valueLabels: Record<string, string> = { faithful: t('一致'), mismatch: t('不一致'), uncertain: t('不确定'), true: t('通过'), false: t('未通过') };
const verdictLabels: Record<string, string> = { approved: t('通过'), changes_requested: t('要求修改'), unknown: t('无法判断') };
const valueTone = (value: string) => value === 'faithful' || value === 'true' ? 'passed' : value === 'mismatch' || value === 'false' ? 'failed' : 'warning';
const Fact = (props: { label: string; value: string; mono?: boolean; wide?: boolean }) => <div class={props.wide ? 'explain-fact-wide' : undefined}><dt>{props.label}</dt><dd class={props.mono ? 'mono' : undefined}>{props.value}</dd></div>;
const Quotes = ({ quotes }: { quotes: readonly string[] }) => quotes.length ? <ul class="formal-quotes">
  {quotes.map((quote, index) => <li key={index} class="explain-rich"><Rich text={quote} /></li>)}</ul> : null;

function Toolbar({ report, pane }: FormalizationView) {
  const button = (value: 'lean' | 'prose', label: string) => <button type="button" data-action="pane" data-pane={value} aria-pressed={pane === value}>{label}</button>;
  return <>
    <div class="explain-target"><span class="explain-target-label">{report.targets.length > 1 ? t('目标定理 ({0})', report.targets.length) : t('目标定理')}</span>
      {report.targets.map(item => <code key={item.name} translate={false}><LeanName name={item.name} /></code>)}</div>
    <div class="source-switch explain-pane-switch" role="group" aria-label={t('显示的一侧')}>{button('lean', 'Lean')}{button('prose', t('原题'))}</div>
  </>;
}

/** The right pane: the original with its matched fragments, each correspondence, the blind back-translation, plan and reviews. */
function Report({ report, active, confirmed }: FormalizationView) {
  const pieces = originalPieces(report.original, report.correspondences);
  const located = pieces.some(piece => report.correspondences[piece.quote]!.lean.length), wider = pieces.some(piece => piece.wider.length);
  return <article class="explain-document">
    <p class="explain-notice"><Icon name="triangle-alert" />
      <span>{confirmed ? t('你已确认此陈述作为研究原题。证明仍需独立验收。') : t('这份 Lean 陈述由模型写出。另一个模型只看 Lean，把它译回数学；{0} 个审核模型拿原题逐项对照 Lean 陈述和这份回译后才通过，未经人工审阅。Lean 只检查了陈述能编译，没有检查它是否忠实于原题。', report.reviews.length)}</span></p>
    <section class="explain-section formal-problem" aria-labelledby="formal-original-heading">
      <header class="explain-section-head"><div class="explain-section-meta"><code translate={false}><LeanName name={report.problemId} /></code></div>
        <h3 id="formal-original-heading">{t('原题')}</h3></header>
      <OriginalText original={report.original} correspondences={report.correspondences} active={active} />
      {located && <p class="formal-note"><Icon name="locate-fixed" /><span>{wider
        ? t('点原文中划线的片段，标出审核模型认定与它对应的 Lean，再点一次，选中包含它的更长片段；点 Lean 的一行，找出写在这一行的对照。')
        : t('点原文中划线的片段，标出审核模型认定与它对应的 Lean；点 Lean 的一行，找出写在这一行的对照。')}</span></p>}
    </section>
    {report.correspondences.length > 0 && <section class="explain-section" aria-labelledby="formal-correspondence-heading">
      <header class="explain-section-head"><h3 id="formal-correspondence-heading">{t('原题与 Lean 陈述的对照 ({0})', report.correspondences.length)}</h3></header>
      <Correspondences original={report.original} statement={report.statement} correspondences={report.correspondences} active={active} /></section>}
    <Backtranslation report={report} />
    {report.plan && <Plan plan={report.plan} />}
    {report.coverage.length > 0 && <Coverage report={report} />}
    {report.reviews.map((review, index) => <Review key={index} review={review} position={index} />)}
    <Footer report={report} />
  </article>;
}
/** What another model read from the Lean statement alone; it saw neither the original nor the writing model's notes. */
function Backtranslation({ report }: { report: WebFormalizationReport }) {
  const { backtranslation: back } = report;
  return <section class="explain-section" aria-labelledby="formal-back-heading">
    <header class="explain-section-head"><h3 id="formal-back-heading">{t('盲回译')}</h3>
      <p class="formal-lead">{t('另一个模型只看 Lean 陈述（看不到原题，也看不到写作模型的说明），写出这份陈述说的数学；审核模型拿它和原题对照。')}</p></header>
    <p class="explain-rich"><Rich text={back.mathematics} /></p>
    {back.targets.map(item => <div key={item.name} class="formal-item"><code translate={false}><LeanName name={item.name} /></code>
      <p class="explain-rich"><Rich text={item.mathematics} /></p></div>)}
    {back.assumptions.length > 0 && <><p class="formal-label">{t('假设')}</p>
      <ul class="formal-list">{back.assumptions.map((item, index) => <li key={index} class="explain-rich"><Rich text={item} /></li>)}</ul></>}
    {back.definitions.length > 0 && <><p class="formal-label">{t('用到的定义')}</p>
      <ul class="formal-list">{back.definitions.map((item, index) => <li key={index} class="explain-rich"><Rich text={item} /></li>)}</ul></>}
  </section>;
}
/** The plan written from the original before any Lean: what must be stated, each item with the source text it cites. */
function Plan({ plan }: { plan: NonNullable<WebFormalizationReport['plan']> }) {
  const group = (label: string, items: readonly { text: string; detail?: string; quotes: readonly string[] }[]) => items.length > 0 && <>
    <p class="formal-label">{label}</p>
    <ul class="formal-list">{items.map((item, index) => <li key={index}><span class="explain-rich"><Rich text={item.text} /></span>
      {item.detail && <code class="formal-detail" translate={false}>{item.detail}</code>}<Quotes quotes={item.quotes} /></li>)}</ul></>;
  return <section class="explain-section" aria-labelledby="formal-plan-heading">
    <header class="explain-section-head"><h3 id="formal-plan-heading">{t('形式化计划')}</h3>
      <p class="formal-lead">{t('写 Lean 之前，规划模型从原题列出要陈述的结论、假设和定义，每项引用原文。')}</p></header>
    {group(t('结论'), plan.conclusions.map(item => ({ text: item.mathematics, detail: item.targets.join(', '), quotes: item.quotes })))}
    {group(t('假设'), plan.assumptions.map(item => ({ text: item.mathematics, quotes: item.quotes })))}
    {group(t('用到的定义'), plan.definitions.map(item => ({ text: item.mathematics, detail: item.names.join(', '), quotes: item.quotes })))}
    {group(t('未能确定'), plan.unresolved.map(item => ({ text: item.description, quotes: item.quotes })))}
  </section>;
}
/** Where the writing model says each part of the original is stated. */
function Coverage({ report }: { report: WebFormalizationReport }) {
  return <section class="explain-section" aria-labelledby="formal-coverage-heading">
    <header class="explain-section-head"><h3 id="formal-coverage-heading">{t('原文覆盖')}</h3>
      <p class="formal-lead">{t('写作模型逐段说明原文由哪个定理陈述；审核模型看不到这些说明。')}</p></header>
    <ul class="formal-list">{report.coverage.map((item, index) => <li key={index}>
      <blockquote class="formal-quote explain-rich"><Rich text={item.original} /></blockquote>
      {item.targets.length > 0 && <code class="formal-detail" translate={false}>{item.targets.join(', ')}</code>}
      <p class="explain-rich"><Rich text={item.explanation} /></p></li>)}</ul>
  </section>;
}
function Review({ review, position }: { review: WebFormalizationReport['reviews'][number]; position: number }) {
  return <section class="explain-section" aria-labelledby={`formal-review-${position}`}>
    <header class="explain-section-head"><div class="explain-section-meta"><span class={`badge ${review.verdict === 'approved' ? 'passed' : 'warning'}`}>
      {verdictLabels[review.verdict] ?? review.verdict}</span><code translate={false}>{review.reviewer}</code></div>
      <h3 id={`formal-review-${position}`}>{t('审核 {0}', position + 1)}</h3></header>
    <p class="explain-rich"><Rich text={review.summary} /></p>
    <ul class="formal-checks">{review.checks.map(check => <li key={check.name}><span>{checkLabels[check.name] ?? check.name}</span>
      <span class={`badge ${valueTone(check.value)}`}>{valueLabels[check.value] ?? check.value}</span></li>)}</ul>
    {review.issues.length > 0 && <ul class="formal-list">{review.issues.map((issue, index) => <li key={index} class="explain-rich"><Rich text={issue} /></li>)}</ul>}
    {review.fidelity && review.fidelity.length > 0 && <details class="explain-reviews"><summary>{t('逐个定理对照原题 ({0})', review.fidelity.length)}</summary>
      <ul>{review.fidelity.map((item, index) => <li key={index}><code translate={false}><LeanName name={item.target} /></code>
        <p class="explain-rich"><span class="formal-pair-label">{t('原题')}</span> <Rich text={item.sourceClaim} /></p>
        <p class="explain-rich"><span class="formal-pair-label">Lean</span> <Rich text={item.candidateClaim} /></p></li>)}</ul></details>}
  </section>;
}
function Footer({ report }: { report: WebFormalizationReport }) {
  const items: [string, string, boolean?, boolean?][] = [
    [t('题目'), report.problemId, true], [t('环境'), report.environment === 'mathlib' ? 'Mathlib' : t('标准库'), false],
    [t('模型'), report.model, true], [t('推理强度'), effortLabels[report.effort as keyof typeof effortLabels] ?? report.effort],
    [t('写作轮次'), String(report.rounds)], [t('通过时间'), formatDateTime(report.approvedAt)],
    [t('Lean 工具链'), report.toolchain, true, true],
    ...report.mathlibRevision ? [[t('Mathlib 版本'), report.mathlibRevision, true, true] as [string, string, boolean, boolean]] : [],
    [t('证据摘要'), report.evidenceSha256, true, true],
  ];
  return <dl class="facts explain-facts explain-footer">{items.map(([label, value, mono, wide]) => <Fact key={label} label={label} value={value} mono={mono} wide={wide} />)}</dl>;
}

export function renderFormalization(hosts: { toolbar: HTMLElement; chosen: HTMLElement; prose: HTMLElement }, view: FormalizationView) {
  render(<Toolbar {...view} />, hosts.toolbar);
  render(view.step ? <ChosenBar original={view.report.original} correspondences={view.report.correspondences} step={view.step} /> : null, hosts.chosen);
  render(<Report {...view} />, hosts.prose);
}
