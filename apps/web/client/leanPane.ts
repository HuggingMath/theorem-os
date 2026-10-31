import type { WebExplanationSpan } from '../shared';
import { leanLines } from './explainText';

/**
 * The Lean pane shared by the explanation and formalization pages: one row per line (number, margin mark, highlighted
 * text), built once; pages change only row classes and text-range highlights.
 */
export function buildLeanRows(source: string): HTMLElement[] {
  return leanLines(source).map((segments, index) => {
    const row = document.createElement('div'), number = document.createElement('span'), gutter = document.createElement('span'),
      text = document.createElement('span');
    row.className = 'lean-row'; row.dataset.line = String(index + 1);
    number.className = 'lean-line-number'; number.textContent = String(index + 1); number.setAttribute('aria-hidden', 'true');
    gutter.className = 'lean-mark'; gutter.setAttribute('aria-hidden', 'true');
    text.className = 'lean-text';
    for (const segment of segments) {
      if (!segment.kind) { text.append(segment.text); continue; }
      const token = document.createElement('span');
      token.className = `lean-tok-${segment.kind}`; token.textContent = segment.text;
      text.append(token);
    }
    row.append(number, gutter, text);
    return row;
  });
}

/** A span's text as a DOM range inside its row, for CSS highlights. */
export function spanRange(rows: readonly HTMLElement[], span: WebExplanationSpan): Range | undefined {
  const text = rows[span.line - 1]?.children[2];
  if (!text) return undefined;
  const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT), range = document.createRange();
  let offset = 0, started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent!.length;
    if (!started && span.start < offset + length) { range.setStart(node, span.start - offset); started = true; }
    if (started && span.end <= offset + length) { range.setEnd(node, span.end - offset); return range; }
    offset += length;
  }
  return undefined;
}

export const canHighlight = () => typeof CSS !== 'undefined' && Boolean(CSS.highlights) && typeof Highlight !== 'undefined';

/**
 * The horizontal scroll of the Lean pane `scroll` that shows `span` beside the sticky line numbers: unchanged when it is
 * in view, else the nearest that shows all of it, or its start when it is wider than the pane. Without a span, 0.
 */
export function spanScrollLeft(scroll: HTMLElement, rows: readonly HTMLElement[], span: WebExplanationSpan | undefined): number {
  const range = span && spanRange(rows, span), gutter = rows[0]?.children[1];
  if (!range || !gutter) return 0;
  const box = range.getBoundingClientRect(), pane = scroll.getBoundingClientRect(), room = 16;
  const left = gutter.getBoundingClientRect().right + room, right = pane.left + scroll.clientWidth - room;
  if (box.left >= left && box.right <= right) return scroll.scrollLeft;
  const target = box.left < left || box.width > right - left ? left : right - box.width;
  return Math.max(0, scroll.scrollLeft + box.left - target);
}
/** Highlights the spans' text under `name`, or clears it. */
export function highlightSpans(name: string, rows: readonly HTMLElement[], spans: readonly WebExplanationSpan[]) {
  if (!canHighlight()) return;
  const ranges = spans.flatMap(span => { const range = spanRange(rows, span); return range ? [range] : []; });
  if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges)); else CSS.highlights.delete(name);
}

/** The embedded payload of an offline report page, or undefined on the served page. */
export function reportData<T>(): T | undefined {
  const element = document.getElementById('report-data');
  return element?.textContent ? JSON.parse(element.textContent) as T : undefined;
}
