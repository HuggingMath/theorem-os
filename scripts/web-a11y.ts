import type { Page } from 'playwright';

/**
 * Static accessibility rules checked in the page, over visible elements only: every control has a name, labels and
 * ARIA references point at real elements, ids are unique, there is no positive tabindex, no control nests inside
 * another, nothing focusable hides inside aria-hidden, and tabs carry their selection. Returns one line per violation.
 */
export type AuditOptions = { scope?: string; uniqueIds?: boolean; references?: boolean };

export function audit(page: Page, options: AuditOptions = {}): Promise<string[]> {
  return page.evaluate(({ scope, uniqueIds, references }) => {
    const root = scope ? document.querySelector(scope) : document.body;
    if (!root) return [`scope ${scope} is missing`];
    const problems: string[] = [];
    const describe = (element: Element) => {
      const id = element.id ? `#${element.id}` : '';
      const hooks = [...element.attributes].filter(attribute => attribute.name.startsWith('data-')).slice(0, 2).map(attribute => `[${attribute.name}${attribute.value ? `="${attribute.value.slice(0, 40)}"` : ''}]`).join('');
      const text = (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 40);
      return `<${element.tagName.toLowerCase()}${id}${hooks}${element.className && typeof element.className === 'string' ? `.${element.className.trim().split(/\s+/u).join('.')}` : ''}>${text ? ` "${text}"` : ''}`;
    };
    const visible = (element: Element) => {
      if (element.closest('[hidden],dialog:not([open]),[inert]')) return false;
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && (box.width > 0 || box.height > 0);
    };
    // Visible text, skipping aria-hidden subtrees; images contribute their alt text.
    const text = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (!(node instanceof Element) || node.getAttribute('aria-hidden') === 'true') return '';
      if (node instanceof HTMLImageElement) return node.alt;
      if (node instanceof HTMLElement && getComputedStyle(node).display === 'none') return '';
      return [...node.childNodes].map(text).join('');
    };
    const named = (element: Element) => {
      const labelled = element.getAttribute('aria-labelledby');
      if (labelled) return labelled.split(/\s+/u).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
      const label = element.getAttribute('aria-label');
      if (label) return label;
      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
        if (element instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(element.type)) return element.value;
        const labels = [...(element.labels ?? [])].map(text).join(' ');
        return labels || element.title || ('placeholder' in element ? element.placeholder : '');
      }
      return text(element) || element.getAttribute('title') || '';
    };
    const controls = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab],[role=link],[role=checkbox],[role=switch],[role=option],[role=menuitem],[tabindex]:not([tabindex="-1"])';
    const all = [...root.querySelectorAll(controls)].filter(visible);
    for (const element of all) {
      if (!named(element).trim()) problems.push(`no accessible name: ${describe(element)}`);
      const tabIndex = Number(element.getAttribute('tabindex'));
      if (tabIndex > 0) problems.push(`positive tabindex: ${describe(element)}`);
      const outer = element.parentElement?.closest('a[href],button,[role=button],[role=tab],[role=link]');
      if (outer && !element.matches('[tabindex]:not(a,button,input,select,textarea,summary,[role])') && root.contains(outer)) problems.push(`control inside control: ${describe(element)} in ${describe(outer)}`);
      const hiddenAncestor = element.closest('[aria-hidden="true"]');
      if (hiddenAncestor && !element.matches('[tabindex="-1"]')) problems.push(`focusable inside aria-hidden: ${describe(element)}`);
      if (element.getAttribute('role') === 'tab' && !element.hasAttribute('aria-selected')) problems.push(`tab without aria-selected: ${describe(element)}`);
    }
    for (const image of root.querySelectorAll('img')) if (!image.hasAttribute('alt')) problems.push(`img without alt: ${describe(image)}`);
    for (const svg of root.querySelectorAll('svg')) if (visible(svg) && !svg.closest('[aria-hidden="true"]') && !svg.getAttribute('aria-label') && !svg.getAttribute('role'))
      problems.push(`svg neither hidden nor named: ${describe(svg.parentElement ?? svg)}`);
    if (references) {
      for (const element of root.querySelectorAll('[aria-controls],[aria-labelledby],[aria-describedby],[aria-owns],label[for]'))
        for (const attribute of ['aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns', 'for']) {
          const value = element.getAttribute(attribute);
          if (value) for (const id of value.split(/\s+/u)) if (id && !document.getElementById(id)) problems.push(`${attribute} points at missing #${id}: ${describe(element)}`);
        }
    }
    if (uniqueIds) {
      const seen = new Map<string, number>();
      for (const element of document.querySelectorAll('[id]')) seen.set(element.id, (seen.get(element.id) ?? 0) + 1);
      for (const [id, count] of seen) if (count > 1) problems.push(`duplicate id #${id} ×${count}`);
    }
    return [...new Set(problems)];
  }, { scope: options.scope, uniqueIds: options.uniqueIds ?? true, references: options.references ?? true });
}

/** Presses Tab up to `limit` times and records each focus stop: whether it is visible and shows a focus indicator. */
export async function tabStops(page: Page, limit: number) {
  const stops: { name: string; visible: boolean; indicated: boolean }[] = [];
  for (let index = 0; index < limit; index++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return undefined;
      const box = element.getBoundingClientRect();
      const hasIndicator = (node: Element) => {
        const style = getComputedStyle(node);
        return (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none';
      };
      // Search fields draw their visible :focus-within ring on the wrapping label.
      const label = element.closest('label');
      const indicated = hasIndicator(element) || Boolean(label?.matches(':focus-within') && hasIndicator(label));
      const name = element.getAttribute('aria-label') || (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 40) || element.id || element.tagName;
      return { name: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''} ${name}`, visible: box.width > 0 && box.height > 0, indicated };
    });
    if (!stop) break;
    stops.push(stop);
  }
  return stops;
}
