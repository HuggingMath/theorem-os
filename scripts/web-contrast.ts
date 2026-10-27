import type { Page } from 'playwright';

/**
 * WCAG 2 text contrast over visible text in the page: 4.5:1, or 3:1 for large text (24px, or 18.66px at weight 600+).
 * The background is the element's own and its ancestors' background colours composited over the page; elements over a
 * background image are skipped, and so are disabled controls and the logotype, which WCAG exempts. Returns one line per element below
 * the threshold, with its measured ratio.
 */
export function contrastProblems(page: Page, scope?: string): Promise<string[]> {
  return page.evaluate(scope => {
    const root = scope ? document.querySelector(scope) : document.body;
    if (!root) return [`scope ${scope} is missing`];
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    // Any CSS colour (rgb(), color(srgb …), color-mix results) through the canvas; ImageData is straight RGBA.
    const rgba = (value: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = '#000'; context.fillStyle = value; context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r / 255, g / 255, b / 255, a / 255];
    };
    const over = (top: number[], bottom: number[]) => [0, 1, 2].map(index => top[index] * top[3] + bottom[index] * (1 - top[3]));
    const luminance = (color: number[]) => {
      const [r, g, b] = color.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const background = (element: Element): number[] | undefined => {
      const layers: number[][] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== 'none' && !/gradient/u.test(style.backgroundImage)) return undefined;
        const color = rgba(style.backgroundColor);
        if (color[3] > 0) layers.push(color);
        if (color[3] >= 1) break;
      }
      let result = [1, 1, 1];
      for (const layer of layers.reverse()) result = over(layer, result);
      return result;
    };
    const visible = (element: Element) => {
      if (element.closest('[hidden],dialog:not([open]),[inert],[aria-hidden=true]')) return false;
      for (let node: Element | null = element; node; node = node.parentElement) if (Number(getComputedStyle(node).opacity) < 0.99) return false;
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 1 && box.height > 1;
    };
    const problems: string[] = [], seen = new Set<Element>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || seen.has(element) || !(node.textContent ?? '').trim()) continue;
      seen.add(element);
      if (element.closest('script,style,noscript,.sr-only,.skip-link,.brand') || element.closest(':disabled,[aria-disabled=true]') || !visible(element)) continue;
      const style = getComputedStyle(element), back = background(element);
      if (!back) continue;
      const text = rgba(style.color), color = over(text, back);
      const [light, dark] = [luminance(color), luminance(back)].sort((a, b) => b - a);
      const ratio = (light + 0.05) / (dark + 0.05), size = parseFloat(style.fontSize), weight = Number(style.fontWeight);
      const required = size >= 24 || (size >= 18.66 && weight >= 600) ? 3 : 4.5;
      if (ratio + 0.005 < required) {
        const id = element.id ? `#${element.id}` : '', classes = typeof element.className === 'string' && element.className ? `.${element.className.trim().split(/\s+/u).join('.')}` : '';
        problems.push(`${ratio.toFixed(2)} < ${required}: <${element.tagName.toLowerCase()}${id}${classes}> "${(element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 40)}" (${style.color} on ${back.map(channel => Math.round(channel * 255)).join(' ')})`);
      }
    }
    return problems;
  }, scope);
}
