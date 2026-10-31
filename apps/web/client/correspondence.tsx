import { webFormalizationRelationRank, type WebExplanationSpan, type WebFormalizationCorrespondence } from '../shared';
import { t } from '../i18n';
import { coversAll, quotePieces, wholeQuotes, type QuotePiece } from './explainText';
import { Rich, type RichLink } from './richText';
import { Icon } from './ui/Icon';

/**
 * How the original problem and a Lean statement correspond, as the formalization reviewers recorded it; shared by the
 * explanation page's 「原题」 card and the formalization comparison page. Every mark and item carries
 * data-action="correspondence" and data-correspondence, indices into the list separated by spaces (a pair carries its
 * own; see correspondenceIndices), which the page handles.
 */
export const aspectLabels: Record<WebFormalizationCorrespondence['aspect'], string> = {
  domains: t('对象与取值范围'), assumptions: t('假设'), conclusions: t('结论'), definitions: t('定义'),
  quantifierScope: t('量词范围'), instanceCoherence: t('类型类实例'),
};
export const relationLabels: Record<WebFormalizationCorrespondence['relation'], string> = {
  direct: t('直接对应'), equivalent: t('等价改写'), mismatch: t('不一致'), unresolved: t('未能判定'),
};
const relationTone: Record<WebFormalizationCorrespondence['relation'], string> = {
  direct: 'passed', equivalent: 'passed', mismatch: 'failed', unresolved: 'warning',
};

/**
 * Where the original is underlined, one run per piece: the correspondences found in it, less any quoting the whole
 * problem when a finer fragment is found, since a mark over everything would cover the others. A fragment inside
 * another underlines its own words and the outer one the rest (see quotePieces).
 */
export function originalPieces(original: string, correspondences: readonly WebFormalizationCorrespondence[]): QuotePiece[] {
  const whole = wholeQuotes(original, correspondences.map(item => item.originalStart === null ? null : item.original));
  return quotePieces(original, correspondences.map((item, index) => item.originalStart === null || item.originalEnd === null ||
    whole.has(index) ? null : { start: item.originalStart, end: item.originalEnd, placed: item.lean.length > 0 }));
}

/**
 * The original problem with the fragments the reviewers matched marked; pointing at one marks its Lean. A fragment
 * standing for a pair in `active` is shown as chosen.
 */
export function OriginalText(props: { original: string; correspondences: readonly WebFormalizationCorrespondence[]; active?: ReadonlySet<number> }) {
  const links: RichLink[] = originalPieces(props.original, props.correspondences).map(piece => {
    const items = piece.quotes.map(index => props.correspondences[index]!);
    const weakest = items.reduce((a, b) => webFormalizationRelationRank[b.relation] > webFormalizationRelationRank[a.relation] ? b : a);
    const titles = [...new Set(items.map(item => `${aspectLabels[item.aspect]} · ${relationLabels[item.relation]}`))];
    return { start: piece.start, end: piece.end, attributes: { 'data-action': 'correspondence', 'data-correspondence': piece.quotes.join(' ') },
      className: `is-${weakest.relation}${piece.quotes.some(index => props.active?.has(index)) ? ' is-active' : ''}`, title: titles.join('\n') };
  });
  return <p class="explain-rich formal-original"><Rich text={props.original} links={links} /></p>;
}
/** The correspondences a mark or pair stands for: a mark carries every pair quoting its text. */
export const correspondenceIndices = (element: HTMLElement) =>
  (element.dataset.correspondence ?? '').split(' ').filter(Boolean).map(Number);
/** Where their Lean is written, each place once, in file order. */
export function correspondenceSpans(correspondences: readonly WebFormalizationCorrespondence[], indices: readonly number[]): WebExplanationSpan[] {
  const spans = new Map<string, WebExplanationSpan>();
  for (const index of indices) for (const span of correspondences[index]?.lean ?? []) spans.set(`${span.line}:${span.start}:${span.end}`, span);
  return [...spans.values()].sort((a, b) => a.line - b.line || a.start - b.start);
}

/**
 * Each matched pair: aspect, relation, both fragments, how many reviewers gave it, and their explanations, folded. An
 * original fragment that is the whole problem, shown just above, is named instead of repeated, and so is a Lean fragment
 * that is the whole `statement` file, shown beside it.
 */
export function Correspondences(props: { original: string; statement?: string; correspondences: readonly WebFormalizationCorrespondence[];
  active?: ReadonlySet<number> }) {
  const leanLabel = (item: WebFormalizationCorrespondence) =>
    props.statement !== undefined && coversAll(props.statement, item.leanText) ? t('整份 Lean 陈述') : item.leanText;
  return <ol class="formal-correspondences">{props.correspondences.map((item, index) => <li key={index} data-item={index}
    class={`formal-correspondence${props.active?.has(index) ? ' is-active' : ''}`}>
    <div class="formal-correspondence-head">
      <span class="formal-aspect">{aspectLabels[item.aspect]}</span>
      <span class={`badge ${relationTone[item.relation]}`}>{relationLabels[item.relation]}</span>
      {item.reviewers > 1 && <span class="formal-reviewers">{t('{0} 个审核模型', item.reviewers)}</span>}
    </div>
    <div class="formal-pair">
      <span class="formal-pair-label">{t('原题')}</span>{coversAll(props.original, item.original)
        ? <span class="formal-whole">{t('整段原题')}</span> : <span class="explain-rich"><Rich text={item.original} /></span>}
      <span class="formal-pair-label">Lean</span>
      <span>{item.lean.length
        ? <button type="button" class="formal-lean" data-action="correspondence" data-correspondence={index} title={t('在 Lean 中标出')}
          translate={false}>{leanLabel(item)}</button>
        : <code class="formal-lean is-unplaced" translate={false} title={t('Lean 源码里没有原样写出这一段；审核模型可能引用了 Lean 展开后的类型')}>{leanLabel(item)}</code>}</span>
    </div>
    {item.explanations.length > 0 && <details class="explain-reviews"><summary>{t('审核说明 ({0})', item.explanations.length)}</summary>
      <ul>{item.explanations.map((note, noteIndex) => <li key={noteIndex} class="explain-rich"><Rich text={note} /></li>)}</ul></details>}
  </li>)}</ol>;
}

/**
 * The explanation page's 「原题」 card: the original problem, and the reviewed correspondences folded below it; `active`
 * are the pairs the reader last chose here.
 */
export function ProblemCard(props: { problemId: string; original: string; correspondences: readonly WebFormalizationCorrespondence[];
  active?: ReadonlySet<number> }) {
  const located = originalPieces(props.original, props.correspondences).length > 0;
  return <section class="explain-section formal-problem" aria-labelledby="explain-problem-heading">
    <header class="explain-section-head">
      <div class="explain-section-meta"><span class="badge">{t('形式化')}</span><code translate={false}>{props.problemId}</code></div>
      <h3 id="explain-problem-heading">{t('原题')}</h3>
    </header>
    <OriginalText original={props.original} correspondences={props.correspondences} active={props.active} />
    <p class="formal-note"><Icon name="shield-check" /><span>{located
      ? t('主定理的陈述来自一份通过审核的形式化，审核模型逐项对照过原题和 Lean 陈述。点原文中划线的片段，标出对应的 Lean。')
      : t('主定理的陈述来自一份通过审核的形式化，审核模型逐项对照过原题和 Lean 陈述。')}</span></p>
    {props.correspondences.length > 0 && <details class="explain-reviews formal-problem-details">
      <summary>{t('原题与 Lean 陈述的对照 ({0})', props.correspondences.length)}</summary>
      <Correspondences original={props.original} correspondences={props.correspondences} active={props.active} /></details>}
  </section>;
}
