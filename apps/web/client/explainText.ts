import type { WebExplanationDocument, WebExplanationLines, WebExplanationSection } from '../shared';
import { leanTokens, type LeanToken } from './sourceText';

/**
 * Pure helpers for the explanation page (explain.html): the proof split into highlighted lines, the mapping between
 * Lean lines and explanation steps, and source-preserving prose segments for the shared math renderer.
 * Nothing here touches the DOM, so model text can only ever reach the page as text nodes.
 */
export type LeanSegment = { text: string; kind?: LeanToken['kind'] };

/** One entry per line of the proof file (line 1 first), each split at the highlighting tokens that cross it. */
export function leanLines(source: string): LeanSegment[][] {
  const text = source.replaceAll('\r\n', '\n'), lines: LeanSegment[][] = [[]];
  const push = (from: number, to: number, kind?: LeanToken['kind']) => {
    let start = from;
    while (start < to) {
      const newline = text.indexOf('\n', start), end = newline < 0 || newline >= to ? to : newline;
      if (end > start) lines.at(-1)!.push(kind ? { text: text.slice(start, end), kind } : { text: text.slice(start, end) });
      if (end < to) lines.push([]);
      start = end + 1;
    }
  };
  let offset = 0;
  for (const token of leanTokens(text)) {
    push(offset, token.start);
    push(token.start, token.end, token.kind);
    offset = token.end;
  }
  push(offset, text.length);
  // A final newline ends the last line rather than starting an empty one.
  if (lines.length > 1 && !lines.at(-1)!.length && text.endsWith('\n')) lines.pop();
  return lines;
}

/** A declaration (`step` absent), its statement (the signature's lines), or one of its steps. */
export type StepRef = { section: number; step?: number; statement?: true };
const span = (lines: readonly WebExplanationLines[]) => lines.reduce((sum, item) => sum + item.end - item.start + 1, 0);
const within = (lines: readonly WebExplanationLines[], line: number) => lines.some(item => line >= item.start && line <= item.end);
const sectionAt = (document: WebExplanationDocument, line: number) =>
  document.sections.findIndex(section => line >= section.lines.start && line <= section.lines.end);
function tightestStep(section: WebExplanationSection, line: number): number | undefined {
  let best: { index: number; size: number } | undefined;
  section.steps.forEach((step, index) => {
    if (!within(step.lines, line)) return;
    const size = span(step.lines);
    if (!best || size < best.size) best = { index, size };
  });
  return best?.index;
}

/**
 * What a Lean line belongs to: the step whose quoted lines contain it most tightly; else, for a proof line no step
 * quotes, the declaration; else, on the signature, the statement; else the declaration.
 */
export function stepAtLine(document: WebExplanationDocument, line: number): StepRef | undefined {
  const index = sectionAt(document, line);
  if (index < 0) return undefined;
  const section = document.sections[index]!, step = tightestStep(section, line);
  if (step !== undefined) return { section: index, step };
  if (!section.unexplained.includes(line) && within([section.signature], line)) return { section: index, statement: true };
  return { section: index };
}

/** The Lean lines a reference points at: a step's quoted lines (the declaration when it quotes none), or the signature. */
export function refLines(document: WebExplanationDocument, ref: StepRef): WebExplanationLines[] {
  const section = document.sections[ref.section];
  if (!section) return [];
  if (ref.statement) return [section.signature];
  const lines = ref.step === undefined ? [] : section.steps[ref.step]?.lines ?? [];
  return lines.length ? lines : [section.lines];
}

/**
 * The line range a prose anchor stands for while the panes scroll together: a step its first quoted line to its last,
 * a section's heading and statement its signature, up to the first line a step quotes.
 */
export function anchorSpan(document: WebExplanationDocument, ref: StepRef): WebExplanationLines {
  const section = document.sections[ref.section]!;
  if (ref.step !== undefined) {
    const lines = section.steps[ref.step]?.lines ?? [];
    return lines.length ? { start: lines[0]!.start, end: lines.at(-1)!.end } : section.lines;
  }
  const first = section.steps.flatMap(step => step.lines).reduce((min, item) => Math.min(min, item.start), Number.POSITIVE_INFINITY);
  const { start, end } = section.signature;
  return { start, end: Math.max(start, Math.min(end, first - 1)) };
}

/** Where the prose follows Lean line `exact` (fractional) while the panes scroll together: an anchor and how far through it. */
export function proseAt(document: WebExplanationDocument, exact: number): { ref: StepRef; fraction: number } | undefined {
  const line = Math.floor(exact), index = sectionAt(document, line);
  if (index < 0) {
    const next = document.sections.findIndex(section => section.lines.start > line);
    if (next >= 0) return { ref: { section: next }, fraction: 0 };
    return document.sections.length ? { ref: { section: document.sections.length - 1 }, fraction: 1 } : undefined;
  }
  const section = document.sections[index]!, step = tightestStep(section, line);
  const through = (lines: WebExplanationLines) => Math.min(1, Math.max(0, (exact - lines.start) / (lines.end - lines.start + 1)));
  if (step !== undefined) return { ref: { section: index, step }, fraction: through(anchorSpan(document, { section: index, step })) };
  // A body line no step quotes keeps in view, read to its end, the step that quoted a line most recently before it.
  let before: { step: number; end: number } | undefined;
  section.steps.forEach((item, stepIndex) => {
    const end = item.lines.reduce((max, range) => range.end < line ? Math.max(max, range.end) : max, 0);
    if (end && (!before || end >= before.end)) before = { step: stepIndex, end };
  });
  if (before && !within([section.signature], line)) return { ref: { section: index, step: before.step }, fraction: 1 };
  return { ref: { section: index }, fraction: through(anchorSpan(document, { section: index })) };
}

/** A Lean line's margin mark: its step (numbered on the first line of a run), the statement, or a proof line no step quotes. */
export type GutterMark = { kind: 'step'; step: number; first: boolean } | { kind: 'statement' | 'unexplained'; first: boolean };
export function leanGutter(document: WebExplanationDocument): Map<number, GutterMark> {
  const marks = new Map<number, GutterMark>();
  for (const section of document.sections) {
    const unexplained = new Set(section.unexplained);
    let previous = '';
    for (let line = section.lines.start; line <= section.lines.end; line++) {
      const step = tightestStep(section, line);
      const kind = step !== undefined ? 'step' : unexplained.has(line) ? 'unexplained' : within([section.signature], line) ? 'statement' : undefined;
      const key = kind === 'step' ? `step ${step}` : kind ?? '';
      if (kind === 'step') marks.set(line, { kind, step: step!, first: key !== previous });
      else if (kind) marks.set(line, { kind, first: key !== previous });
      previous = key;
    }
  }
  return marks;
}

/** Time and tokens scaled linearly by declarations from one measured run, capped by the limits. */
export function explanationEstimate(declarations: number, reference: { declarations: number; seconds: number; tokens: number },
  limits: { maxRunSeconds: number; maxTotalTokens: number }) {
  const scale = Math.max(1, declarations) / Math.max(1, reference.declarations);
  return { seconds: Math.min(limits.maxRunSeconds || Infinity, Math.round(reference.seconds * scale)),
    tokens: Math.min(limits.maxTotalTokens || Infinity, Math.round(reference.tokens * scale)) };
}
/** Prose split at code, bold, delimited mathematics and unambiguous mathematical expressions in older records. */
export type ProseSegment = { kind: 'text' | 'code' | 'strong' | 'math' | 'display'; text: string };
const delimiters = [['$$', '$$', 'display'], ['\\[', '\\]', 'display'], ['\\(', '\\)', 'math'], ['$', '$', 'math']] as const;
function closing(text: string, close: string, from: number) {
  for (let index = from; index < text.length; index++) {
    if (text.startsWith(close, index)) return index;
    if (text[index] === '\\') index++;
  }
  return -1;
}
// Bare expressions have no Markdown boundaries. Limit words to mathematical functions and the named Greek variables
// used in the saved research records, so a following English sentence cannot become part of the formula.
const mathWords = new Set('sin cos tan cot sec csc sinh cosh tanh log ln exp lim sup inf max min det dim ker gcd lcm arg Pr mod conj area rank tr diag card alpha beta gamma delta epsilon theta lambda lam mu nu xi pi rho sigma tau phi psi omega TV'.split(' '));
const mathCommand = /^(?:frac|dfrac|tfrac|binom|sqrt|sum|prod|coprod|int|iint|iiint|oint|lim|limits|nolimits|left|right|big|Big|bigg|Bigg|mathbb|mathcal|mathscr|mathfrak|mathrm|mathbf|mathit|mathsf|mathtt|text|operatorname|overline|underline|overbrace|underbrace|hat|widehat|bar|vec|dot|ddot|tilde|widetilde|substack|boxed|infty|partial|nabla|forall|exists|in|notin|subset|subseteq|supset|supseteq|cup|cap|setminus|le|leq|ge|geq|ne|neq|equiv|approx|sim|simeq|cong|propto|times|cdot|div|pm|mp|to|mapsto|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|Leftrightarrow|alpha|beta|gamma|delta|epsilon|varepsilon|theta|vartheta|lambda|mu|nu|xi|pi|rho|sigma|tau|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Phi|Psi|Omega|sin|cos|tan|log|ln|exp|max|min|sup|inf|det|dim|ker|quad|qquad|ldots|cdots|dots)$/u;
const mathLetter = /[\p{Script=Greek}\u2102-\u2149\u{1d400}-\u{1d7ff}]/u;
const unicodeScript = /[\u00b2\u00b3\u00b9\u1d2c-\u1d6a\u2070-\u209f]/u;
const mathOperator = /[\u2200-\u22ff\u27c0-\u27ef\u2190-\u21d4\u00b1\u00d7\u00f7\u00b7\u2212]/u;
const bigOperator = /[∑∏∐∫∬∭∮⋃⋂√]/u;
const mathConstant = /[∞∅⊤⊥]/u;
/** A lexical candidate, including rejected candidates so their suffix cannot be mistaken for a separate formula. */
function bareMath(text: string, start: number): { end: number; math: boolean } | undefined {
  const previous = text[start - 1] ?? '';
  if (/[A-Za-z0-9_./\\@:^]/u.test(previous) || mathLetter.test(previous) || unicodeScript.test(previous)) return;
  const first = String.fromCodePoint(text.codePointAt(start)!);
  if (!/[A-Za-z0-9\\([|+-]/u.test(first) && !mathLetter.test(first) && !mathOperator.test(first)) return;
  let index = start, clear = false, operand = false, unsafe = false, tex = false, scriptable = false;
  let last: 'operand' | 'operator' | 'command' | 'script' | 'open' | 'close' = 'open';
  const brackets: string[] = [];
  while (index < text.length) {
    const character = String.fromCodePoint(text.codePointAt(index)!);
    if (/[A-Za-z]/u.test(character)) {
      const word = /^[A-Za-z]+/u.exec(text.slice(index))![0];
      if (word.length > 1 && !mathWords.has(word) && !brackets.includes('}')) {
        if (index === start) index += word.length;
        break;
      }
      index += word.length; operand = scriptable = true; last = 'operand'; continue;
    }
    if (/[0-9]/u.test(character) || mathLetter.test(character) || mathConstant.test(character)) {
      index += character.length; operand = scriptable = true; last = 'operand'; continue;
    }
    if (unicodeScript.test(character)) {
      if (!scriptable) unsafe = true;
      clear = true; index += character.length; last = 'operand'; continue;
    }
    if (character === '\\') {
      const command = /^\\([A-Za-z]+)/u.exec(text.slice(index));
      if (!command || !mathCommand.test(command[1]!)) break;
      index += command[0].length; clear = tex = scriptable = true; last = 'command'; continue;
    }
    if (character === '_' || character === '^') {
      if (!scriptable) unsafe = true;
      const next = text[index + 1];
      if (next === '{') { clear = true; index++; last = 'script'; continue; }
      // TeX takes one token after an unbraced script. Never silently turn `_children` into just `_c`, or `^(a+b)` into `^(`.
      const script = /^[A-Za-z0-9]+/u.exec(text.slice(index + 1))?.[0];
      if (script) {
        // In E_qX the subscript is q and X is the next factor, exactly as TeX reads it; `_children` stays ambiguous.
        const followedByFactor = /^[a-z][A-Z]$/u.test(script);
        if (script.length !== 1 && !followedByFactor) unsafe = true;
        index += followedByFactor ? 2 : script.length + 1; operand = scriptable = true; last = 'operand'; continue;
      }
      if (next === '\\') { index++; last = 'script'; continue; }
      unsafe = true; index++; last = 'script'; continue;
    }
    if ('([{'.includes(character)) {
      // Ordinary set/indicator braces need explicit TeX escapes; treating them as groups would hide their visible braces.
      if (character === '{' && last !== 'script' && last !== 'command' && !(tex && last === 'close') && !brackets.includes('}')) unsafe = true;
      brackets.push(character === '(' ? ')' : character === '[' ? ']' : '}');
      index++; scriptable = false; last = 'open'; continue;
    }
    if (')]}'.includes(character)) {
      if (brackets.at(-1) !== character) break;
      brackets.pop(); index++; operand = scriptable = true; last = 'close'; continue;
    }
    if (/\s/u.test(character)) {
      if (character === '\n' || character === '\r') break;
      const next = text.slice(index).match(/^\s*(\S)/u)?.[1];
      if (!next) break;
      const word = text.slice(index).match(/^\s*([A-Za-z]+)/u)?.[1];
      if (!brackets.length && word && word.length > 1 && !mathWords.has(word)) break;
      if (!brackets.length && !/[A-Za-z0-9\\(+*/=<>|^_-]/u.test(next) && !mathLetter.test(next) && !unicodeScript.test(next) && !mathOperator.test(next)) break;
      index++; continue;
    }
    if (character === '.' && /[0-9]/u.test(text[index - 1] ?? '') && /[0-9]/u.test(text[index + 1] ?? '')) { index++; continue; }
    if (character === '|' || character === '′' || character === "'") { index++; continue; }
    if (brackets.length && /[,;:&]/u.test(character)) { index++; scriptable = false; last = 'operator'; continue; }
    if (/[+*/=<>-]/u.test(character) || mathOperator.test(character)) {
      if (mathOperator.test(character)) clear = true;
      index += character.length; scriptable = bigOperator.test(character); last = 'operator'; continue;
    }
    if (tex && brackets.includes('}') && !/[$`]/u.test(character)) { index += character.length; operand = scriptable = true; last = 'operand'; continue; }
    break;
  }
  while (index > start && /\s/u.test(text[index - 1]!)) index--;
  if (index === start) return;
  // A filename suffix belongs to the original identifier/path, even when its basename contains a braced script.
  if (/^\.[A-Za-z][A-Za-z0-9]*/u.test(text.slice(index))) unsafe = true;
  return { end: index, math: clear && operand && !unsafe && !brackets.length && last !== 'operator' && last !== 'script' };
}
/** A piece of prose as written, `[start, end)` in the raw text: one character of text, or a whole code, bold or formula. */
type ProseAtom = { kind: ProseSegment['kind']; start: number; end: number; text: string };
function proseAtoms(text: string): ProseAtom[] {
  const atoms: ProseAtom[] = [];
  const fence = /`+/y;
  let index = 0, unclosedMath = false;
  while (index < text.length) {
    const start = index;
    if (text.startsWith('\\$', index)) { atoms.push({ kind: 'text', start, end: index += 2, text: '$' }); continue; }
    fence.lastIndex = index;
    const ticks = fence.exec(text)?.[0];
    if (ticks) {
      const end = text.indexOf(ticks, index + ticks.length);
      index = end > 0 ? end + ticks.length : index + ticks.length;
      atoms.push(end > 0 ? { kind: 'code', start, end: index, text: text.slice(start + ticks.length, end).trim() } : { kind: 'text', start, end: index, text: ticks });
      continue;
    }
    if (text.startsWith('**', index)) {
      const end = text.indexOf('**', index + 2);
      if (end > index + 2) { atoms.push({ kind: 'strong', start, end: index = end + 2, text: text.slice(start + 2, end) }); continue; }
    }
    const delimiter = !unclosedMath && delimiters.find(([open]) => text.startsWith(open, index));
    if (delimiter) {
      const [open, close, kind] = delimiter, end = closing(text, close, index + open.length);
      if (end > index + open.length) { atoms.push({ kind, start, end: index = end + close.length, text: text.slice(start + open.length, end) }); continue; }
      // An unfinished explicit formula remains source text, including any commands/scripts it contains.
      unclosedMath = true;
    }
    const bare = !unclosedMath && bareMath(text, index);
    if (bare) {
      if (bare.math) { atoms.push({ kind: 'math', start, end: index = bare.end, text: text.slice(start, bare.end) }); continue; }
      while (index < bare.end) atoms.push({ kind: 'text', start: index, end: ++index, text: text[index - 1]! });
      continue;
    }
    atoms.push({ kind: 'text', start, end: ++index, text: text[start]! });
  }
  return atoms;
}
function joinAtoms(atoms: readonly ProseAtom[]): ProseSegment[] {
  const segments: ProseSegment[] = [];
  for (const atom of atoms) {
    const last = segments.at(-1);
    if (atom.kind === 'text' && last?.kind === 'text') last.text += atom.text;
    else if (atom.text) segments.push({ kind: atom.kind, text: atom.text });
  }
  return segments;
}
export const proseSegments = (text: string): ProseSegment[] => joinAtoms(proseAtoms(text));

/**
 * Prose segments grouped by the linked phrase they belong to (`link` indexes the links given), unlinked runs between;
 * `marked` when the run lies in a marked range.
 */
export type ProseRun = { segments: ProseSegment[]; link?: number; marked?: true };
/**
 * Splits prose at linked phrases (UTF-16 offsets into the raw text, end exclusive). A phrase that cuts into a formula,
 * inline code or bold text takes all of it, so a formula is never drawn in pieces; a phrase overlapping an earlier
 * one (in start order) is dropped. Runs are also split where `marks` (ranges that may overlap anything) begin and end;
 * a formula touched by a mark is marked whole.
 */
export function linkedProse(text: string, links: readonly { start: number; end: number }[],
  marks: readonly { start: number; end: number }[] = []): ProseRun[] {
  const atoms = proseAtoms(text);
  const spans = links.map((link, index) => {
    const touched = link.end > link.start ? atoms.filter(atom => atom.start < link.end && atom.end > link.start) : [];
    return touched.length ? { index, start: touched[0]!.start, end: touched.at(-1)!.end } : undefined;
  }).filter((item): item is { index: number; start: number; end: number } => Boolean(item))
    .sort((a, b) => a.start - b.start || a.index - b.index);
  const kept: typeof spans = [];
  for (const item of spans) if (!kept.some(other => item.start < other.end && item.end > other.start)) kept.push(item);
  const runs: { atoms: ProseAtom[]; link?: number; marked: boolean }[] = [];
  for (const atom of atoms) {
    const link = kept.find(item => atom.start >= item.start && atom.end <= item.end)?.index, last = runs.at(-1);
    const marked = marks.some(range => atom.start < range.end && atom.end > range.start);
    if (last && last.link === link && last.marked === marked) last.atoms.push(atom);
    else runs.push(link === undefined ? { atoms: [atom], marked } : { atoms: [atom], link, marked });
  }
  return runs.flatMap(run => {
    const segments = joinAtoms(run.atoms);
    if (!segments.length) return [];
    return [{ segments, ...run.link === undefined ? {} : { link: run.link }, ...run.marked ? { marked: true as const } : {} }];
  });
}

const collapse = (text: string) => text.replace(/\s+/gu, ' ').trim();
/** Whether `quote` is all of `whole`, up to spacing, with nothing but spaces and punctuation left outside it. */
export function coversAll(whole: string, quote: string): boolean {
  const text = collapse(whole), part = collapse(quote), at = text.indexOf(part);
  return at >= 0 && !/[^\s\p{P}]/u.test(text.slice(0, at) + text.slice(at + part.length));
}
/**
 * Which quotes cover all of `whole` (nothing but spaces and punctuation outside them), when some other quote marks a
 * smaller part. A reviewer quoting the whole problem or the whole Lean file says nothing about where its Lean is, and
 * marking it would cover every finer fragment; `null` is a quote that is not placed in `whole`.
 */
export function wholeQuotes(whole: string, quotes: readonly (string | null)[]): Set<number> {
  const found = quotes.map(quote => quote !== null && coversAll(whole, quote));
  if (!quotes.some((quote, index) => quote !== null && !found[index])) return new Set();
  return new Set(found.flatMap((value, index) => value ? [index] : []));
}

/**
 * A run of text to underline for quote `quote` (UTF-16 offsets, end exclusive); `quotes` is it, every other quote of the
 * same text and the shorter quotes there whose counterpart was not found, which one click on the run finds together, and
 * `wider` the other quotes around that text, each list one text, shortest first, which further clicks step out to.
 */
export type QuotePiece = { start: number; end: number; quote: number; quotes: number[]; wider: number[][] };
// Latin and CJK sentence punctuation, written as escapes so the source holds no interface text.
const EDGE = /[\s.,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u3001]/u;
/** Ranges of `text` moved onto whole formulas, inline code and bold text, less spaces and sentence punctuation at their ends. */
function snapper(text: string) {
  const atoms = proseAtoms(text), bounds = new Set(atoms.flatMap(atom => [atom.start, atom.end]));
  // Every range stays on atom boundaries, so linkedProse draws the pieces as given.
  const trim = (start: number, end: number) => {
    while (start < end && EDGE.test(text[start]!) && bounds.has(start + 1)) start++;
    while (end > start && EDGE.test(text[end - 1]!) && bounds.has(end - 1)) end--;
    return { start, end };
  };
  const snap = (start: number, end: number) => {
    const touched = atoms.filter(atom => atom.start < end && atom.end > start);
    if (!touched.length) return undefined;
    const range = trim(touched[0]!.start, touched.at(-1)!.end);
    return range.end > range.start ? range : undefined;
  };
  return { trim, snap };
}
/** The text a quote of `text` covers, as quotePieces counts it. */
export const quoteRange = (text: string, start: number, end: number) => snapper(text).snap(start, end);
/**
 * Where to underline quotes of one text, each a range or `null`, and `placed` when its counterpart was found. Each word
 * goes to the shortest quote around it whose counterpart was found, else the shortest, so a click finds the most specific
 * quote of those words, also where two quotes cross; a shorter quote there whose counterpart was not found goes with it,
 * so the click still marks a counterpart and lists both. Quotes differing only by spaces or sentence punctuation at their ends are one, drawn for the first whose
 * counterpart was found and carrying the others in `quotes`. A `hidden` quote is never drawn but counts as around the
 * quotes inside it. Like linkedProse, a quote that cuts into a formula, inline code or bold text takes all of it.
 * Underlines leave out spaces and sentence punctuation at their ends, and a remainder of only spaces and punctuation, or
 * a word of one or two letters left between finer quotes, is not underlined; clicking a finer quote again reaches it.
 */
// A word left between finer quotes this short ("a", "if", "is") is too narrow to tap; an East Asian character counts twice.
const tiny = (words: string) => [...words.replace(/[\s$]/gu, '')]
  .reduce((sum, char) => sum + (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char) ? 2 : 1), 0) <= 2;
export function quotePieces(text: string,
  quotes: readonly ({ start: number; end: number; placed: boolean; hidden?: boolean } | null)[]): QuotePiece[] {
  const atoms = proseAtoms(text), { trim, snap } = snapper(text);
  // Quotes of one text (as snapped) are one group, drawn when one of them is and placed when a drawn one is.
  type Group = { start: number; end: number; members: number[]; shown: boolean; placed: boolean };
  const groups: Group[] = [];
  quotes.forEach((quote, index) => {
    const range = quote && snap(quote.start, quote.end);
    if (!range) return;
    let group = groups.find(item => item.start === range.start && item.end === range.end);
    if (!group) groups.push(group = { ...range, members: [], shown: false, placed: false });
    group.members.push(index);
    if (!quote.hidden) { group.shown = true; group.placed ||= quote.placed; }
  });
  groups.sort((a, b) => a.end - a.start - (b.end - b.start) || a.start - b.start);
  const lead = (group: Group) => group.members.find(index => quotes[index]!.placed && !quotes[index]!.hidden)
    ?? group.members.find(index => !quotes[index]!.hidden) ?? group.members[0]!;
  const listed = (group: Group) => { const first = lead(group); return [first, ...group.members.filter(index => index !== first)]; };
  // Runs of atoms with the same owner, the shortest drawn group around them that is placed (else the shortest drawn),
  // each with the shorter unplaced groups inside it, which add pairs to a click but no Lean.
  const runs: { start: number; end: number; owner: Group; merged: Set<Group> }[] = [];
  for (const atom of atoms) {
    const around = groups.filter(group => group.shown && group.start <= atom.start && atom.end <= group.end);
    const owner = around.find(group => group.placed) ?? around[0];
    if (!owner) continue;
    const merged = around.slice(0, around.indexOf(owner)), last = runs.at(-1);
    if (last && last.end === atom.start && last.owner === owner) { last.end = atom.end; for (const group of merged) last.merged.add(group); }
    else runs.push({ start: atom.start, end: atom.end, owner, merged: new Set(merged) });
  }
  return runs.flatMap(run => {
    const merged = groups.filter(group => run.merged.has(group)), own = new Set([run.owner, ...merged]);
    const piece = trim(run.start, run.end), words = text.slice(piece.start, piece.end);
    const finer = groups.some(group => group.shown && !own.has(group) && run.owner.start <= group.start && group.end <= run.owner.end &&
      group.end - group.start < run.owner.end - run.owner.start);
    if (piece.end <= piece.start || !/[^\s\p{P}]/u.test(words) || finer && tiny(words)) return [];
    const wider = groups.filter(group => !own.has(group) && group.start <= piece.start && piece.end <= group.end).map(group => group.members);
    return [{ ...piece, quote: lead(run.owner), quotes: [run.owner, ...merged].flatMap(listed), wider }];
  });
}
