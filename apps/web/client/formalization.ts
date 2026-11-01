import type { WebExplanationLines, WebExplanationSpan, WebFormalizationReport } from '../shared';
import { mountLocaleSwitch, t } from '../i18n';
import { wholeQuotes } from './explainText';
import { renderFormalization } from './formalizationView';
import { correspondenceSpans, fragmentLadder } from './correspondence';
import { buildLeanRows, highlightSpans, reportData, spanScrollLeft } from './leanPane';

/**
 * The formalization comparison page (formalize --phase report): the approved Lean statement on the left, the original
 * problem and what its reviewers matched on the right. Choosing a matched fragment marks its Lean; choosing a Lean line
 * finds the correspondences written on it. Offline only: the payload is embedded and nothing is fetched.
 */
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
mountLocaleSwitch($<HTMLButtonElement>('#locale-switch'));
const report = reportData<WebFormalizationReport>();
const hosts = { toolbar: $('#formal-toolbar'), chosen: $('#formal-chosen'), prose: $('#formal-prose') };
const leanScroll = $('#formal-lean'), proseScroll = $('#formal-prose');
const state = { pane: 'prose' as 'lean' | 'prose', active: new Set<number>(), pinned: [] as WebExplanationSpan[] };
let rows: HTMLElement[] = [];
/** Correspondences whose Lean is the whole statement while others mark less; they are not underlined or found by line. */
const wholeLean = report ? wholeQuotes(report.statement, report.correspondences.map(item => item.lean.length ? item.leanText : null)) : new Set<number>();

const linesOf = (spans: readonly WebExplanationSpan[]): WebExplanationLines[] => spans.map(span => ({ start: span.line, end: span.line }));
const marked = new Map<string, HTMLElement[]>();
function mark(kind: 'active' | 'hover', lines: readonly WebExplanationLines[]) {
  for (const row of marked.get(kind) ?? []) row.classList.remove(`is-${kind}`);
  const chosen: HTMLElement[] = [];
  for (const item of lines) for (let line = Math.max(1, item.start); line <= Math.min(rows.length, item.end); line++) chosen.push(rows[line - 1]!);
  for (const row of chosen) row.classList.add(`is-${kind}`);
  marked.set(kind, chosen);
}
/** Marks the spans being pointed at; with none, those of the correspondence last chosen. */
function point(spans: readonly WebExplanationSpan[] | undefined) {
  const shown = spans ?? state.pinned;
  mark('hover', linesOf(shown));
  highlightSpans('explain-use', rows, shown);
}
function draw() {
  if (!report) return;
  const step = ladder.step();
  renderFormalization(hosts, { report, pane: state.pane, active: state.active, ...step ? { step } : {} });
  $('#formal-split').dataset.pane = state.pane;
}
const narrow = () => matchMedia('(max-width: 900px)').matches;
const smooth = () => matchMedia('(prefers-reduced-motion: no-preference)').matches ? 'smooth' as const : 'auto' as const;
const offsetIn = (scroll: HTMLElement, element: HTMLElement) => element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
function reveal(scroll: HTMLElement, element: HTMLElement | undefined | null, share = 3, left?: number) {
  if (element) scroll.scrollTo({ top: Math.max(0, offsetIn(scroll, element) - scroll.clientHeight / share), left, behavior: smooth() });
}
// How far out the last clicks on one 原题 fragment have stepped.
const ladder = fragmentLadder();
const spansOf = (element: HTMLElement) => correspondenceSpans(report?.correspondences ?? [], ladder.shown(element));
/**
 * Correspondences (a pair, every pair of one original fragment, or of a longer fragment around it): their Lean is marked
 * and brought into view, across to the first fragment; with no Lean in the source, the first is shown in the list.
 */
function choose(indices: readonly number[]) {
  const spans = correspondenceSpans(report?.correspondences ?? [], indices);
  state.active = new Set(indices); state.pinned = spans;
  if (narrow()) state.pane = spans.length ? 'lean' : 'prose';
  draw(); point(undefined); mark('active', linesOf(spans));
  requestAnimationFrame(() => spans.length ? reveal(leanScroll, rows[spans[0]!.line - 1], 3, spanScrollLeft(leanScroll, rows, spans[0]))
    : reveal(proseScroll, proseScroll.querySelector<HTMLElement>(`[data-item="${indices[0]}"]`), 4));
}
/**
 * A Lean line: the correspondences whose Lean is written on it are marked in the list, the first brought into view.
 * Those quoting the whole statement count only on a line that no finer fragment reaches.
 */
function chooseLine(line: number) {
  if (!report) return;
  const on = report.correspondences.flatMap((item, index) => item.lean.some(span => span.line === line) ? [index] : []);
  const finer = on.filter(index => !wholeLean.has(index)), found = finer.length ? finer : on;
  state.active = new Set(found); state.pinned = found.flatMap(index => report.correspondences[index]!.lean); ladder.reset();
  if (narrow() && found.length) state.pane = 'prose';
  draw(); point(undefined); mark('active', [{ start: line, end: line }]);
  if (found.length) requestAnimationFrame(() => reveal(proseScroll, proseScroll.querySelector<HTMLElement>(`[data-item="${found[0]}"]`), 4));
}
const selecting = () => !(getSelection()?.isCollapsed ?? true);
document.addEventListener('click', event => {
  const target = event.target as HTMLElement;
  if (selecting()) return;
  const row = target.closest<HTMLElement>('.lean-row');
  if (row) { chooseLine(Number(row.dataset.line)); return; }
  const action = target.closest<HTMLElement>('[data-action]');
  if (action?.dataset.action === 'correspondence') choose(ladder.climb(action));
  else if (action?.dataset.action === 'wider') { const next = ladder.next(); if (next) choose(next); }
  else if (action?.dataset.action === 'pane') { state.pane = action.dataset.pane === 'lean' ? 'lean' : 'prose'; draw(); }
});
const pointed = (target: HTMLElement) => {
  const item = target.closest<HTMLElement>('[data-action="correspondence"]');
  return item ? spansOf(item) : undefined;
};
proseScroll.addEventListener('mouseover', event => point(pointed(event.target as HTMLElement)));
proseScroll.addEventListener('mouseleave', () => point(undefined));
proseScroll.addEventListener('focusin', event => { const spans = pointed(event.target as HTMLElement); if (spans) point(spans); });
proseScroll.addEventListener('focusout', () => point(undefined));
// Marked fragments are focusable spans (a formula cannot sit in a button); Enter and Space choose them like a click.
proseScroll.addEventListener('keydown', event => {
  const target = event.target as HTMLElement;
  if ((event.key === 'Enter' || event.key === ' ') && target.matches('[role="button"][data-action]')) { event.preventDefault(); target.click(); }
});

/**
 * Target theorems in the margin; every matched Lean fragment underlined, so what the reviewers compared is visible. A
 * quote of the whole statement is left out when finer ones are underlined; it is still marked when chosen.
 */
function paint(data: WebFormalizationReport) {
  const targets = new Set<number>(), matched = new Set<number>();
  const quoted = data.correspondences.filter((_, index) => !wholeLean.has(index));
  for (const item of data.targets) for (let line = item.lines.start; line <= item.lines.end; line++) targets.add(line);
  for (const item of quoted) for (const span of item.lean) matched.add(span.line);
  rows.forEach((row, index) => {
    if (targets.has(index + 1)) (row.children[1] as HTMLElement).className = 'lean-mark is-statement';
    if (matched.has(index + 1)) row.classList.add('is-quoted');
  });
  highlightSpans('formal-matched', rows, quoted.flatMap(item => item.lean));
}
function start() {
  $('#formal-loading').hidden = true;
  if (!report) { $('#formal-missing').hidden = false; return; }
  document.title = `${report.problemId} · ${t('形式化对照')} · TheoremOS`;
  $('#formal-problem-id').textContent = report.problemId;
  rows = buildLeanRows(report.statement);
  const fragment = document.createDocumentFragment();
  fragment.append(...rows);
  $('#formal-lean-code').replaceChildren(fragment);
  $('#formal-lean-count').textContent = t('{0} 行', rows.length);
  paint(report);
  $('#formal-content').hidden = false;
  draw();
}
start();
