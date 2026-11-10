/** Fonts used by the exported article, collected after all details are expanded. */
export type BriefFontUsage = { families: string[]; style: string; weight: number; text: string };
export type BriefStyleSheet = { css: string; url: string };
type Face = { block: string; family: string; style: string; low: number; high: number; ranges: string; source: string; sheet: number };
const value = (body: string, name: string) => body.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;}]+)`, 'iu'))?.[1].trim() ?? '';
const unquote = (text: string) => text.trim().replace(/^["']|["']$/gu, '');
function covers(ranges: string, text: string) {
  if (!ranges) return true;
  const spans = ranges.split(',').flatMap(range => {
    const match = range.trim().match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/iu);
    return match ? [[parseInt(match[1].replaceAll('?', '0'), 16), parseInt(match[2] ?? match[1].replaceAll('?', 'F'), 16)]] : [];
  });
  return Array.from(text).some(character => spans.some(([from, to]) => character.codePointAt(0)! >= from && character.codePointAt(0)! <= to));
}

/** Keep one WOFF2 source per used face, including the actual text's Unicode subsets. */
export async function embedBriefFonts(sheets: BriefStyleSheet[], usage: BriefFontUsage[], read: (url: string) => Promise<string>): Promise<string[]> {
  const faces: Face[] = [];
  sheets.forEach((sheet, index) => {
    for (const match of sheet.css.matchAll(/@font-face\s*\{([^}]+)\}/giu)) {
      const body = match[1], weight = value(body, 'font-weight') || '400';
      const weights = weight.split(/\s+/u).map(item => item === 'normal' ? 400 : item === 'bold' ? 700 : Number(item));
      faces.push({ block: match[0], family: unquote(value(body, 'font-family')), style: value(body, 'font-style') || 'normal', low: weights[0], high: weights[1] ?? weights[0],
        ranges: value(body, 'unicode-range'), source: body.match(/url\(([^)]+\.woff2(?:["'])?)\)/iu)?.[1] ?? '', sheet: index });
    }
  });
  const selected = new Set<Face>();
  for (const use of usage) for (const family of use.families) {
    const candidates = faces.filter(face => face.family.toLowerCase() === unquote(family).toLowerCase() && covers(face.ranges, use.text));
    const styles = candidates.some(face => face.style === use.style) ? candidates.filter(face => face.style === use.style) : candidates.filter(face => face.style === 'normal');
    const distance = (face: Face) => Math.max(face.low - use.weight, use.weight - face.high, 0);
    const closest = Math.min(...styles.map(distance));
    for (const face of styles) if (distance(face) === closest) selected.add(face);
  }
  const embedded = new Map<Face, string>(), reads = new Map<string, Promise<string>>();
  await Promise.all([...selected].map(async face => {
    if (!face.source) throw new Error(`Missing WOFF2 source for ${face.family}`);
    const url = new URL(unquote(face.source), sheets[face.sheet].url).href;
    let result = reads.get(url); if (!result) { result = read(url); reads.set(url, result); }
    const data = await result;
    embedded.set(face, face.block.replace(/src\s*:[^;}]+/iu, `src:url("${data}") format("woff2")`));
  }));
  return sheets.map((sheet, index) => sheet.css.replace(/@font-face\s*\{[^}]+\}/giu, block => {
    const face = faces.find(item => item.sheet === index && item.block === block)!;
    return embedded.get(face) ?? '';
  }));
}

export function briefFontUsage(article: HTMLElement): BriefFontUsage[] {
  const grouped = new Map<string, BriefFontUsage>(), walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode, element = node.parentElement, text = node.textContent ?? '';
    if (!element || !text.trim() || element.closest('.katex-mathml,script,style')) continue;
    const style = getComputedStyle(element), signature = `${style.fontFamily}\0${style.fontStyle}\0${style.fontWeight}`;
    const existing = grouped.get(signature);
    if (existing) existing.text += text;
    else grouped.set(signature, { families: style.fontFamily.split(',').map(unquote), style: style.fontStyle, weight: Number(style.fontWeight) || 400, text });
  }
  return [...grouped.values()];
}
