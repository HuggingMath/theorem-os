import type { InformalizationUnit } from './informalizationExtraction';

/**
 * Where an explanation's Lean quotations are in a declaration's source. The host's checks, the auditors' recorded goals
 * and the explanation page all place text with these functions, so they agree on what a step quotes and links.
 * Offsets are UTF-16 indexes into the declaration's source with CRLF read as LF, end exclusive.
 */
export type SourceOffsets = { start: number; end: number };
export const lineEnds = (value: string) => value.replaceAll('\r\n', '\n');

/** The host's excerpt match (whitespace runs collapse, ends trimmed), with each kept character's raw offset. */
export function collapsed(value: string): { text: string; offsets: number[] } {
  let text = '';
  const offsets: number[] = [];
  let space = false;
  for (const match of value.matchAll(/\s+|[^\s]+/gu)) {
    if (/^\s/u.test(match[0])) { space = text.length > 0; continue; }
    if (space) { text += ' '; offsets.push(match.index!); space = false; }
    for (let index = 0; index < match[0].length; index++) offsets.push(match.index! + index);
    text += match[0];
  }
  return { text, offsets };
}

/**
 * Where each step's excerpts are in the declaration's source, matched with whitespace runs collapsed. Steps are placed
 * in order: an excerpt is looked for after the previous step's first match, then from the start, so a repeated tactic
 * lands on the occurrence that follows the steps before it.
 */
export function placeExcerpts(source: string, steps: readonly (readonly string[])[]): { places: SourceOffsets[][]; ambiguous: number } {
  const { text, offsets } = collapsed(source);
  let cursor = 0, ambiguous = 0;
  const places = steps.map(excerpts => {
    let first = Number.POSITIVE_INFINITY;
    const found = excerpts.flatMap(excerpt => {
      const value = collapsed(excerpt).text, earliest = value ? text.indexOf(value) : -1;
      if (earliest < 0) return [];
      if (text.indexOf(value, earliest + 1) >= 0) ambiguous++;
      const after = text.indexOf(value, cursor), start = after >= 0 ? after : earliest;
      first = Math.min(first, start);
      return [{ start: offsets[start]!, end: offsets[start + value.length - 1]! + 1 }];
    });
    if (first < Number.POSITIVE_INFINITY) cursor = first + 1;
    return found;
  });
  return { places, ambiguous };
}

/** The first occurrence of `value` (whitespace collapsed) that lies inside one of `regions`; undefined when none does. */
export function findWithin(source: string, value: string, regions: readonly SourceOffsets[]): SourceOffsets | undefined {
  const { text, offsets } = collapsed(source), needle = collapsed(value).text;
  if (!needle) return undefined;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const start = offsets[at]!, end = offsets[at + needle.length - 1]! + 1;
    if (regions.some(region => start >= region.start && end <= region.end)) return { start, end };
  }
  return undefined;
}

export const identifierChar = /[\p{L}\p{N}_'!?₀-ₜᵢ-ᵪ]/u;
export const lineStart = (text: string, index: number) => text.lastIndexOf('\n', index - 1) + 1;
const lineEnd = (text: string, index: number) => { const end = text.indexOf('\n', index); return end < 0 ? text.length : end; };
/** Newlines in `value` before offset `end`. */
export const count = (value: string, end: number) => {
  let lines = 0;
  for (let index = value.indexOf('\n'); index >= 0 && index < end; index = value.indexOf('\n', index + 1)) lines++;
  return lines;
};

/** The source with comments and string and character literals blanked (newlines kept), so offsets are the source's. */
export function codeOnly(source: string): string {
  const chars = source.split('');
  const blank = (from: number, to: number) => { for (let index = from; index < to; index++) if (chars[index] !== '\n') chars[index] = ' '; };
  for (let index = 0; index < source.length;) {
    let end = index + 1;
    if (source.startsWith('--', index)) end = lineEnd(source, index);
    else if (source.startsWith('/-', index)) {
      let depth = 1;
      for (end = index + 2; end < source.length && depth;) {
        if (source.startsWith('/-', end)) { depth++; end += 2; } else if (source.startsWith('-/', end)) { depth--; end += 2; } else end++;
      }
    } else if (source[index] === '"') {
      while (end < source.length && source[end] !== '"') end += source[end] === '\\' ? 2 : 1;
      end = Math.min(source.length, end + 1);
    } else if (source[index] === "'" && !identifierChar.test(source[index - 1] ?? ' ')) {
      const literal = /^'(?:\\.|[^\\'\n])'/u.exec(source.slice(index, index + 4));
      if (literal) end = index + literal[0].length;
    }
    if (end > index + 1) blank(index, end);
    index = end;
  }
  return chars.join('');
}
/**
 * Where a theorem's signature ends in its code: the first `:=` or `where` outside brackets, or a `|` that starts a line
 * of match arms. -1 when there is none, as for an axiom; a `:=` inside a `let` in the statement would end it early.
 */
export function signatureEnd(code: string): number {
  let depth = 0;
  for (let index = 0; index < code.length; index++) {
    const char = code[index]!;
    if ('([{⦃⟨'.includes(char)) depth++;
    else if (')]}⦄⟩'.includes(char)) depth = Math.max(0, depth - 1);
    else if (depth) continue;
    else if (code.startsWith(':=', index)) return index;
    else if (code.startsWith('where', index) && !identifierChar.test(code[index - 1] ?? ' ') && !identifierChar.test(code[index + 5] ?? ' ')) return index;
    else if (char === '|' && !code.slice(lineStart(code, index), index).trim() && code.slice(index, lineEnd(code, index)).includes('=>')) return index;
  }
  return -1;
}
/** What a section's statement explains: a theorem's signature, or the whole of any other declaration (or of an axiom). */
export function statementRegion(unit: Pick<InformalizationUnit, 'kind' | 'source'>): SourceOffsets {
  const source = lineEnds(unit.source), split = unit.kind === 'theorem' ? signatureEnd(codeOnly(source)) : -1;
  return { start: 0, end: split < 0 ? source.length : split };
}

/**
 * Goals before the first and after the last of the outermost tactics a step quotes, as Lean printed them (at most 4 per
 * state; the counts give all). An empty `after` means those tactics closed their goal. `lines` are the tactics' lines.
 */
export type InformalizationStepGoals = { before: string[]; beforeCount: number; after: string[]; afterCount: number;
  lines: { start: number; end: number } };
/**
 * `blockHeads` (lean-phrase-alignment-v2 and unaligned pages): a step that quotes only the head of a block tactic
 * (`induction n with`, `have h : P := by`, `classical`) gets as `after` what the head leaves to the tactics inside it,
 * then the goals after the block, and the head's lines. Without it (lean-phrase-alignment-v1, which its auditors saw)
 * such a step gets the whole block's goals, so a block that closes its goal reads as if the head had closed it.
 */
export type StepGoalsOptions = { blockHeads: boolean };
/**
 * Goals around the tactics a step quotes: the outermost recorded tactics inside its placed excerpts, or, when the excerpts
 * are part of one tactic (the first line of a `have … := by`), the smallest tactic they overlap.
 */
export function stepGoals(unit: Pick<InformalizationUnit, 'range' | 'goals'>, source: string,
  places: readonly SourceOffsets[], options: StepGoalsOptions = { blockHeads: true }): InformalizationStepGoals | undefined {
  if (!unit.goals?.tactics.length || !places.length) return undefined;
  const lines = source.split('\n'), starts: number[] = [];
  let at = 0;
  for (const line of lines) { starts.push(at); at += line.length + 1; }
  // Tactic positions are proof-file lines and codepoint columns; the source's first line starts at the unit's column.
  const offset = (line: number, column: number) => {
    const index = line - unit.range.line, text = lines[index];
    if (text === undefined) return source.length;
    return starts[index]! + [...text].slice(0, Math.max(0, column - (index ? 0 : unit.range.column))).join('').length;
  };
  const tactics = unit.goals.tactics.map(item => ({ item, start: offset(item.range.line, item.range.column),
    end: offset(item.range.endLine, item.range.endColumn) }));
  const inside = tactics.filter(tactic => tactic.end > tactic.start &&
    places.some(place => tactic.start >= place.start && tactic.end <= place.end));
  let chosen = inside.filter(tactic => !inside.some(other => other !== tactic && other.start <= tactic.start && other.end >= tactic.end &&
    other.end - other.start > tactic.end - tactic.start));
  if (!chosen.length) {
    const overlapping = tactics.filter(tactic => places.some(place => tactic.start < place.end && place.start < tactic.end));
    chosen = overlapping.toSorted((a, b) => a.end - a.start - (b.end - b.start)).slice(0, 1);
    const head = chosen.length && options.blockHeads && !unit.goals.truncated ? blockHead(chosen[0]!, tactics, places) : undefined;
    if (head) return { before: chosen[0]!.item.before, beforeCount: chosen[0]!.item.beforeCount, after: head.after,
      afterCount: head.afterCount, lines: { start: chosen[0]!.item.range.line, end: unit.range.line + count(source, head.end - 1) } };
  }
  if (!chosen.length) return undefined;
  chosen.sort((a, b) => a.start - b.start);
  const first = chosen[0]!.item, last = chosen.at(-1)!.item;
  return { before: first.before, beforeCount: first.beforeCount, after: last.after, afterCount: last.afterCount,
    lines: { start: first.range.line, end: Math.max(...chosen.map(tactic => tactic.item.range.endLine)) } };
}
type PlacedTactic = { item: NonNullable<InformalizationUnit['goals']>['tactics'][number]; start: number; end: number };
/**
 * When the excerpts quote `block` from its start and none of the tactics inside it (`stepGoals` chose the block as the
 * smallest tactic they overlap): the goals its head leaves to those tactics, in order, followed by the goals after the
 * block, and where the quotation ends. Each alternative (`| zero =>`, or the body of `have … := by`) starts with the
 * first inner tactic met while no inner goal is open; a bullet or a later tactic of the same alternative works on goals
 * still open. Undefined unless every inner goal closes, as Lean requires.
 */
function blockHead(block: PlacedTactic, tactics: readonly PlacedTactic[], places: readonly SourceOffsets[]) {
  const quoted = places.filter(place => place.start < block.end && block.start < place.end);
  if (!quoted.some(place => block.start >= place.start && block.start < place.end)) return undefined;
  const inner = tactics.filter(tactic => tactic !== block && tactic.start >= block.start && tactic.end <= block.end &&
    tactic.end - tactic.start < block.end - block.start);
  const outermost = inner.filter(tactic => !inner.some(other => other !== tactic && other.start <= tactic.start &&
    other.end >= tactic.end && other.end - other.start > tactic.end - tactic.start)).toSorted((a, b) => a.start - b.start);
  if (!outermost.length) return undefined;
  const opened: { goals: string[]; count: number }[] = [];
  let open = 0;
  for (const tactic of outermost) {
    if (!open) opened.push({ goals: tactic.item.before, count: tactic.item.beforeCount });
    open += tactic.item.afterCount - (open ? tactic.item.beforeCount : 0);
    if (open < 0) return undefined;
  }
  if (open) return undefined;
  // A state Lean printed in part lists 4 goals, so the first 4 of the concatenation are still the first 4 in order.
  return { after: [...opened.flatMap(state => state.goals), ...block.item.after].slice(0, 4),
    afterCount: opened.reduce((sum, state) => sum + state.count, 0) + block.item.afterCount,
    end: Math.min(Math.max(...quoted.map(place => place.end)), block.end) };
}
/** Each step's recorded goals (null when none apply), as the explanation page shows them; `steps` are their Lean excerpts. */
export function sectionStepGoals(unit: Pick<InformalizationUnit, 'range' | 'goals' | 'source'>,
  steps: readonly (readonly string[])[], options?: StepGoalsOptions): (InformalizationStepGoals | null)[] {
  const source = lineEnds(unit.source), { places } = placeExcerpts(source, steps);
  return places.map(place => stepGoals(unit, source, place, options) ?? null);
}

/** Per-line pieces of `text[start, end)` with the whitespace at their edges trimmed; lines from 0, UTF-16 columns. */
export function offsetSpans(text: string, start: number, end: number): { line: number; start: number; end: number }[] {
  const spans: { line: number; start: number; end: number }[] = [];
  for (let at = start; at < end;) {
    const newline = text.indexOf('\n', at), stop = newline < 0 || newline >= end ? end : newline;
    let from = at, to = stop;
    while (from < to && /\s/u.test(text[from]!)) from++;
    while (to > from && /\s/u.test(text[to - 1]!)) to--;
    if (to > from) { const first = lineStart(text, from); spans.push({ line: count(text, from), start: from - first, end: to - first }); }
    at = stop + 1;
  }
  return spans;
}
