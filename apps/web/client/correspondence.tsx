import { webFormalizationRelationRank, type WebExplanationSpan, type WebFormalizationCorrespondence } from '../shared';
import { t } from '../i18n';
import { coversAll, quotePieces, quoteRange, wholeQuotes, type QuotePiece } from './explainText';
import { Rich, type RichLink } from './richText';
import { Icon } from './ui/Icon';

/**
 * How the original problem and a Lean statement correspond, as the formalization reviewers recorded it; shared by the
 * explanation page's 「原题」 card and the formalization comparison page. Every mark and item carries
 * data-action="correspondence" and data-correspondence, indices into the list separated by spaces (a pair carries its
 * own), which the page handles through fragmentLadder.
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
 * problem when a finer fragment is found, since a mark over everything would cover the others; those still count as
 * around every piece. A fragment inside another underlines its own words and the outer one the rest (see quotePieces).
 */
export function originalPieces(original: string, correspondences: readonly WebFormalizationCorrespondence[]): QuotePiece[] {
  const whole = wholeQuotes(original, correspondences.map(item => item.originalStart === null ? null : item.original));
  return quotePieces(original, correspondences.map((item, index) => item.originalStart === null || item.originalEnd === null ? null
    : { start: item.originalStart, end: item.originalEnd, placed: item.lean.length > 0, hidden: whole.has(index) }));
}

/**
 * The original problem with the fragments the reviewers matched marked; pointing at one marks its Lean, and pointing
 * again steps out to the longer fragments around it (data-wider, one list of pairs per step, separated by `;`). The text
 * the pairs in `active` quote is tinted.
 */
export function OriginalText(props: { original: string; correspondences: readonly WebFormalizationCorrespondence[]; active?: ReadonlySet<number> }) {
  const links: RichLink[] = originalPieces(props.original, props.correspondences).map(piece => {
    const items = piece.quotes.map(index => props.correspondences[index]!);
    const weakest = items.reduce((a, b) => webFormalizationRelationRank[b.relation] > webFormalizationRelationRank[a.relation] ? b : a);
    const titles = [...new Set(items.map(item => `${aspectLabels[item.aspect]} · ${relationLabels[item.relation]}`))];
    if (piece.wider.length) titles.push(t('再点一次，选中包含它的更长片段'));
    return { start: piece.start, end: piece.end, attributes: { 'data-action': 'correspondence', 'data-correspondence': piece.quotes.join(' '),
      ...piece.wider.length ? { 'data-wider': piece.wider.map(level => level.join(' ')).join(';') } : {} },
    className: `is-${weakest.relation}${piece.quotes.some(index => props.active?.has(index)) ? ' is-active' : ''}`, title: titles.join('\n') };
  });
  const marks = [...props.active ?? []].flatMap(index => {
    const item = props.correspondences[index], range = item && item.originalStart !== null && item.originalEnd !== null
      ? quoteRange(props.original, item.originalStart, item.originalEnd) : undefined;
    return range ? [range] : [];
  });
  return <p class="explain-rich formal-original"><Rich text={props.original} links={links} marks={marks} /></p>;
}
/** The correspondences a mark or pair stands for: a mark carries every pair quoting its text. */
const correspondenceIndices = (element: HTMLElement) =>
  (element.dataset.correspondence ?? '').split(' ').filter(Boolean).map(Number);
/** What successive clicks on a mark or pair choose: its own pairs, then those of each longer fragment around it. */
const fragmentLevels = (element: HTMLElement): number[][] => [correspondenceIndices(element),
  ...(element.dataset.wider ?? '').split(';').filter(Boolean).map(level => level.split(' ').map(Number))];
const levelKey = (element: HTMLElement) => `${element.dataset.correspondence ?? ''}|${element.dataset.wider ?? ''}`;
/**
 * The steps a page has taken out from one fragment: a click on a fragment of the same text as the last click takes the
 * next longer fragment (wrapping round to its own pairs), any other click starts again.
 */
export function fragmentLadder() {
  let last: { key: string; level: number } | undefined;
  return {
    /** The pairs a click on `element` chooses. */
    climb(element: HTMLElement): number[] {
      const levels = fragmentLevels(element), key = levelKey(element);
      const level = last?.key === key ? (last.level + 1) % levels.length : 0;
      last = { key, level };
      return levels[level]!;
    },
    /** The pairs `element` stands for now: the step last chosen from it, or its own pairs. */
    shown(element: HTMLElement): number[] {
      const levels = fragmentLevels(element);
      return levels[last?.key === levelKey(element) ? last.level : 0] ?? levels[0]!;
    },
    reset() { last = undefined; },
  };
}
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
      <div>{item.lean.length
        ? <button type="button" class="formal-lean" data-action="correspondence" data-correspondence={index} title={t('在 Lean 中标出')}
          translate={false}>{leanLabel(item)}</button>
        : <Unplaced text={leanLabel(item)} />}</div>
    </div>
    {item.explanations.length > 0 && <details class="explain-reviews"><summary>{t('审核说明 ({0})', item.explanations.length)}</summary>
      <ul>{item.explanations.map((note, noteIndex) => <li key={noteIndex} class="explain-rich"><Rich text={note} /></li>)}</ul></details>}
  </li>)}</ol>;
}

// A Lean fragment not written in the source is often an elaborated type of many lines; past this it is folded.
const FOLD_CHARS = 160, FOLD_LINES = 3, PREVIEW_CHARS = 80;
/**
 * A Lean fragment the source does not write: shown as quoted, saying so in words (a title is not seen on a phone), and
 * folded to its first line when long.
 */
function Unplaced(props: { text: string }) {
  const why = t('Lean 源码里没有原样写出这一段；审核模型可能引用了 Lean 展开后的类型');
  const lines = props.text.trim().split('\n'), folded = props.text.length > FOLD_CHARS || lines.length > FOLD_LINES;
  const code = <code class={`formal-lean is-unplaced${folded || lines.length > 1 ? ' is-block' : ''}`} translate={false} title={why}>{props.text}</code>;
  const note = <span class="formal-unplaced-note" title={why}>{t('源码里没有原样写出')}</span>;
  if (!folded) return <>{code}{note}</>;
  const first = lines[0]!.trim(), preview = first.length > PREVIEW_CHARS || lines.length > 1 ? `${first.slice(0, PREVIEW_CHARS).trimEnd()} …` : first;
  return <details class="formal-unplaced">
    <summary><code class="formal-lean is-preview" translate={false}>{preview}</code>{note}
      <span class="formal-unplaced-toggle"><span class="is-closed">{t('展开')}</span><span class="is-open">{t('收起')}</span></span></summary>
    {code}
  </details>;
}

/**
 * The explanation page's 「原题」 card: the original problem, and the reviewed correspondences folded below it; `active`
 * are the pairs the reader last chose here.
 */
export function ProblemCard(props: { problemId: string; original: string; correspondences: readonly WebFormalizationCorrespondence[];
  active?: ReadonlySet<number> }) {
  const pieces = originalPieces(props.original, props.correspondences), wider = pieces.some(piece => piece.wider.length);
  return <section class="explain-section formal-problem" aria-labelledby="explain-problem-heading">
    <header class="explain-section-head">
      <div class="explain-section-meta"><span class="badge">{t('形式化')}</span><code translate={false}>{props.problemId}</code></div>
      <h3 id="explain-problem-heading">{t('原题')}</h3>
    </header>
    <OriginalText original={props.original} correspondences={props.correspondences} active={props.active} />
    <p class="formal-note"><Icon name="shield-check" /><span>{!pieces.length
      ? t('主定理的陈述来自一份通过审核的形式化，审核模型逐项对照过原题和 Lean 陈述。')
      : wider ? t('主定理的陈述来自一份通过审核的形式化，审核模型逐项对照过原题和 Lean 陈述。点原文中划线的片段，标出对应的 Lean；再点一次，选中包含它的更长片段。')
        : t('主定理的陈述来自一份通过审核的形式化，审核模型逐项对照过原题和 Lean 陈述。点原文中划线的片段，标出对应的 Lean。')}</span></p>
    {props.correspondences.length > 0 && <details class="explain-reviews formal-problem-details">
      <summary>{t('原题与 Lean 陈述的对照 ({0})', props.correspondences.length)}</summary>
      <Correspondences original={props.original} correspondences={props.correspondences} active={props.active} /></details>}
  </section>;
}
