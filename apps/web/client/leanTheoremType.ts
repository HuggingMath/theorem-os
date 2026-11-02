import { leanScopeCommands, maskLeanCommentsAndStrings } from '../../../src/math/leanSyntax';
import { leanOutline } from './leanOutline';

/** Read the frozen declaration's written parameters and proposition; this is not an elaborated Lean type. */
export function leanTheoremTypeLookup(originalSource: string): (name: string) => string | undefined {
  const source = originalSource.replace(/\r\n?/gu, '\n'), masked = maskLeanCommentsAndStrings(source);
  const headings = leanOutline(source), lines = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') lines.push(index + 1);
  const boundaries = [...headings.map(heading => lines[heading.line - 1]!),
    ...[...leanScopeCommands(masked)].filter(match => /^(?:namespace|section|mutual|end)$/u.test(match[1]!)).map(match => match.index)]
    .sort((a, b) => a - b);
  const theorems = headings.filter(heading => heading.kind === 'theorem');
  return name => {
    const normalized = name.replace(/^_root_\./u, '');
    const qualified = theorems.filter(heading => heading.qualifiedName === normalized);
    const matches = qualified.length ? qualified : theorems.filter(heading => heading.name.replace(/^_root_\./u, '') === normalized);
    if (matches.length !== 1) return undefined;
    const heading = matches[0]!, start = lines[heading.line - 1]!;
    const end = boundaries.find(boundary => boundary > start) ?? source.length;
    const escaped = heading.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const header = new RegExp(`\\b${heading.keyword}[ \\t]+${escaped}`, 'u').exec(masked.slice(start, end));
    if (!header) return undefined;
    const from = start + header.index + header[0].length, delimiters: string[] = [];
    const closing: Record<string, string> = { ')': '(', ']': '[', '}': '{', '⦄': '⦃' };
    let quotedName = false;
    for (let index = from; index < end; index++) {
      const character = masked[index]!;
      if (character === '«') { quotedName = true; continue; }
      if (character === '»') { quotedName = false; continue; }
      if (quotedName) continue;
      if ('([{⦃'.includes(character)) delimiters.push(character);
      else if (closing[character]) { if (delimiters.pop() !== closing[character]) return undefined; }
      else if (!delimiters.length && character === ':' && masked[index + 1] === '=') {
        return source.slice(from, index).trim() || undefined;
      }
    }
    return undefined;
  };
}
