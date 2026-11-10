import { leanScopeCommands, leanScopeNamespace, maskLeanComments, maskLeanCommentsAndStrings,
  updateLeanScopes, type LeanScope } from '../math/leanSyntax';

type SourceRegion = Readonly<{ startOffset: number; endOffset: number }>;
type ProjectionOpen = { namespace: string; command: string; startOffset: number; endOffset: number; local: boolean };

export type ProjectionNotation = {
  startOffset: number;
  bodyOffset: number;
  endOffset: number;
  namespace: string;
  opens: ProjectionOpen[];
  bound: string[];
  tokens: string[];
  alias?: string;
  scopeEnd: number;
  local: boolean;
  scoped: boolean;
};

// These are boundaries only. Unsupported notation syntax is left to the normal Lean check.
const commandHead = /^(?:@\[|#|(?:theorem|lemma|def|abbrev|opaque|instance|example|class|structure|inductive|coinductive|axiom|constant|constants|variable|variables|universe|universes|namespace|section|end|mutual|open|export|include|omit|set_option|attribute|local|scoped|noncomputable|private|protected|public|unsafe|partial|nonrec|meta|syntax|macro|elab|notation|infix|infixl|infixr|prefix|postfix|initialize|builtin_initialize|import|run_cmd)(?![\p{L}\p{M}\p{N}_'.?!]))/u;
const notationHead = /^[ \t]*(?:(local|scoped)[ \t]+)?(notation|infixl|infixr|infix|prefix|postfix)(?![\p{L}\p{M}\p{N}_'.?!])/u;
const name = /[\p{L}_][\p{L}\p{M}\p{N}_'?!]*/gu;

/** Index the notation commands that can outlive declarations removed by a task projection.
 * This does not interpret syntax/macro/elab bodies or grant any proof acceptance. */
export function inspectProjectionNotations(source: string, regions: readonly SourceRegion[]): ProjectionNotation[] {
  const cleaned = maskLeanCommentsAndStrings(source);
  const lines: { start: number; end: number; text: string; indentation: number }[] = [];
  let offset = 0;
  for (const text of cleaned.split(/(?<=\n)/u)) {
    lines.push({ start: offset, end: offset + text.length, text,
      indentation: /^[ \t]*/u.exec(text)![0].length });
    offset += text.length;
  }
  const inside = (at: number) => regions.some(region => at >= region.startOffset && at < region.endOffset);
  const parsed: (Omit<ProjectionNotation, 'namespace' | 'opens' | 'scopeEnd'> & { commandStart: number; localEnd?: number })[] = [];
  let coveredUntil = -1;
  for (const [index, line] of lines.entries()) {
    const header = notationHead.exec(line.text);
    if (!header || line.start < coveredUntil || inside(line.start + header[0].length - header[2]!.length)) continue;
    const commandStart = line.start, keywordEnd = line.start + header[0].length;
    let arrow = -1, endOffset = line.end, valid = true;
    const stack: string[] = [], closing: Record<string, string> = { '(': ')', '[': ']', '{': '}', '⦃': '⦄', '⟨': '⟩', '‹': '›' };
    for (let next = index; next < lines.length; next++) {
      const current = lines[next]!, text = current.text;
      if (next > index && text.trim() && !stack.length && current.indentation <= line.indentation) {
        if (!commandHead.test(text.trimStart())) valid = false;
        break;
      }
      for (let cursor = next === index ? header[0].length : 0; cursor < text.length; cursor++) {
        const token = text[cursor]!;
        if (closing[token]) stack.push(closing[token]!);
        else if (')]}⦄⟩›'.includes(token)) {
          if (stack.pop() !== token) { valid = false; break; }
        } else if (!stack.length && arrow < 0 && token === '=' && text[cursor + 1] === '>') {
          arrow = current.start + cursor; cursor++;
        }
      }
      if (!valid) break;
      endOffset = current.end;
    }
    if (!valid || stack.length || arrow < 0 || !maskLeanComments(source.slice(arrow + 2, endOffset)).trim()) continue;
    const inSuffix = /\bin\s*$/u.test(cleaned.slice(arrow + 2, endOffset));
    const nextDeclaration = inSuffix ? regions.find(region => region.startOffset >= endOffset &&
      !cleaned.slice(endOffset, region.startOffset).trim()) : undefined;
    // A command-local notation must not become a binding throughout the enclosing section.
    // Other `... in` consumers remain unsupported until their full command extent is known.
    if (inSuffix && !nextDeclaration) continue;
    let lhs = cleaned.slice(keywordEnd, arrow)
      .replace(/\(\s*(?:name|priority)\s*:=\s*[^()]*\)/gu, match => ' '.repeat(match.length))
      .replace(/:\s*(?:[0-9]+|max|arg|lead|min)(?![\p{L}\p{M}\p{N}_'.?!])/gu, match => ' '.repeat(match.length));
    const bound = header[2] === 'notation' ? [...lhs.matchAll(name)].map(match => match[0]) : [];
    if (header[2] === 'notation') lhs = lhs.replace(name, match => ' '.repeat(match.length));
    if (lhs.trim()) continue;
    const quoted = maskLeanComments(source.slice(keywordEnd, arrow));
    const tokens: string[] = [];
    let unsupportedLiteral = false;
    for (let cursor = 0; cursor < quoted.length; cursor++) {
      if (quoted[cursor] !== '"') continue;
      const start = ++cursor;
      while (cursor < quoted.length && quoted[cursor] !== '"' && quoted[cursor] !== '\\') cursor++;
      // Escaped syntax tokens need Lean's string decoder. Keep their original command untouched.
      if (quoted[cursor] !== '"') { unsupportedLiteral = true; break; }
      const token = quoted.slice(start, cursor).trim();
      if (token) tokens.push(token);
    }
    if (unsupportedLiteral) continue;
    const literal = tokens.length === 1 ? tokens[0]! : '';
    const alias = /^[\p{L}_][\p{L}\p{M}\p{N}_'?!]*$/u.test(literal) ? literal : undefined;
    let startLine = index;
    for (;;) {
      let previous = startLine - 1;
      while (previous >= 0 && !lines[previous]!.text.trim()) previous--;
      if (previous < 0 || inside(lines[previous]!.start) ||
          !/^[ \t]*(?:open|set_option)\b[^\n]*\bin[ \t]*\r?\n?$/u.test(lines[previous]!.text)) break;
      startLine = previous;
    }
    parsed.push({ startOffset: lines[startLine]!.start, commandStart, bodyOffset: arrow + 2, endOffset,
      bound: [...new Set(bound)], tokens, alias, local: header[1] === 'local' || inSuffix,
      scoped: header[1] === 'scoped', localEnd: nextDeclaration?.endOffset });
    coveredUntil = endOffset;
  }
  if (!parsed.length) return [];

  const commands = [...leanScopeCommands(cleaned)].filter(command => !inside(command.index) &&
    !parsed.some(notation => command.index >= notation.commandStart && command.index < notation.endOffset));
  const scopes: LeanScope[] = [];
  type Frame = { opens: ProjectionOpen[]; endOffset: number };
  const frames: Frame[] = [{ opens: [], endOffset: source.length }];
  let localOpens: ProjectionOpen[] = [], commandIndex = 0;
  const apply = (current: typeof commands[number]) => {
    const kind = current[1]!, argument = current[2]?.trim() ?? '';
    if (kind === 'namespace' || kind === 'section' || kind === 'mutual') frames.push({ opens: [], endOffset: source.length });
    else if (kind === 'end' && frames.length > 1) frames.pop()!.endOffset = current.index;
    else if (kind === 'open' && !/^scoped\b/u.test(argument)) {
      const local = /\s+in\s*$/u.test(argument);
      const entry = { namespace: leanScopeNamespace(scopes), command: local ? argument.replace(/\s+in\s*$/u, '') : argument,
        startOffset: current.index, endOffset: current.index + current[0].length, local };
      if (local) localOpens.push(entry); else frames.at(-1)!.opens.push(entry);
    }
    updateLeanScopes(scopes, kind, argument);
  };
  const markers: { offset: number; notation?: typeof parsed[number] }[] = [...regions.map(region => ({ offset: region.startOffset })),
    ...parsed.map(notation => ({ offset: notation.commandStart, notation }))].sort((a, b) => a.offset - b.offset);
  const result: { notation: ProjectionNotation; frame: Frame }[] = [];
  for (const marker of markers) {
    while (commands[commandIndex] && commands[commandIndex]!.index < marker.offset) apply(commands[commandIndex++]!);
    if (marker.notation) {
      const { commandStart: _commandStart, localEnd: _localEnd, ...notation } = marker.notation;
      result.push({ notation: { ...notation, namespace: leanScopeNamespace(scopes),
        opens: [...frames.flatMap(frame => frame.opens), ...localOpens], scopeEnd: marker.notation.localEnd ?? source.length }, frame: frames.at(-1)! });
    }
    localOpens = [];
  }
  while (commands[commandIndex]) apply(commands[commandIndex++]!);
  return result.map(({ notation, frame }) => ({ ...notation, scopeEnd: notation.local ? Math.min(notation.scopeEnd, frame.endOffset) : source.length }));
}
