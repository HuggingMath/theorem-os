import { h, render } from 'preact';
import { proseSegments, type ProseSegment } from './explainText';
import { Rich } from './richText';

const excluded = 'pre, code, textarea, script, style, svg, math, .math, .katex, [data-solution-route], [data-typeset-prose]';
const containsMath = (segments: readonly ProseSegment[]): boolean => segments.some(segment =>
  segment.kind === 'math' || segment.kind === 'display'
  || (segment.kind === 'strong' && containsMath(proseSegments(segment.text))));

/** Typeset prose in existing markup without replacing elements, controls, or their event listeners. */
export function typesetProse(root: HTMLElement): void {
  const document = root.ownerDocument, walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest(excluded) && containsMath(proseSegments(node.textContent ?? ''))) texts.push(node as Text);
  }
  for (const node of texts) {
    const wrapper = document.createElement('span');
    wrapper.dataset.typesetProse = '';
    render(h(Rich, { text: node.data }), wrapper);
    node.replaceWith(wrapper);
  }
}
