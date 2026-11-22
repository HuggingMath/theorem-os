import type { Page } from 'playwright';

/**
 * How a proof page (explain.html or formalization.html) lays out for printing, measured under print media at the
 * viewport's width: boxes that would still scroll or clip (the root and body included, which Chromium unclips for print
 * when either is visible but other engines may not), the panes from top to bottom, whether the Lean starts a new page,
 * how the Lean wraps and how many lines line `line` takes, any proof line past the page's right edge, the controls still
 * shown, and the page's background colour. Restores screen media afterwards.
 */
export async function printLayout(page: Page, line = 1) {
  await page.emulateMedia({ media: 'print' });
  const layout = await page.evaluate(line => {
    const shown = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    const clipped = [...document.querySelectorAll<HTMLElement>('.explain-scroll, .explain-goal')].filter(shown)
      .filter(box => getComputedStyle(box).overflowY !== 'visible' || box.scrollHeight > box.clientHeight + 1).map(box => box.id || box.className);
    for (const root of [document.documentElement, document.body]) if (getComputedStyle(root).overflowY !== 'visible') clipped.push(root.tagName.toLowerCase());
    const panes = [...document.querySelectorAll<HTMLElement>('.explain-pane')].filter(shown)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .map(pane => pane.classList.contains('explain-pane-lean') ? 'lean' : 'prose');
    const lean = document.querySelector<HTMLElement>('.explain-pane-lean')!, edge = document.documentElement.clientWidth;
    const text = document.querySelector(`.lean-row[data-line="${line}"] .lean-text`), range = document.createRange();
    if (text) range.selectNodeContents(text);
    const lines = text ? new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size : 0;
    const wide = [...document.querySelectorAll('.lean-text')].filter(item => item.getBoundingClientRect().right > edge + 1).length;
    const controls = [...document.querySelectorAll('#locale-switch, #explain-back, .source-switch, .explain-sync, .explain-head-actions a, '
      + '[data-action="delete"], .explain-section-next, .explain-contents-rail, .formal-unplaced-toggle, .toast, dialog')].filter(shown).map(item => item.id || item.className || item.tagName);
    const wrap = text ? getComputedStyle(text).whiteSpace : '';
    return { clipped, panes, leanBreak: getComputedStyle(lean).breakBefore, wrap, lines, wide, controls,
      paper: getComputedStyle(document.body).backgroundColor };
  }, line);
  await page.emulateMedia({ media: null });
  return layout;
}

/** The number of pages the page prints to, from Chromium's PDF of it. */
export async function printedPages(page: Page): Promise<number> {
  const pdf = (await page.pdf({ margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } })).toString('latin1');
  return (pdf.match(/\/Type\s*\/Page(?!s)/gu) ?? []).length;
}
