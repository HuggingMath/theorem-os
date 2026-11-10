import type { WebExplanationDocument, WebExplanationLines, WebExplanationSection } from '../shared';
import { leanTokens, type LeanToken } from './sourceText';

/**
 * Pure helpers for the explanation page (explain.html): the proof split into highlighted lines, the mapping between
 * Lean lines and explanation steps, and a small TeX reader for the `$…$` mathematics the writer is asked to use.
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
/** Prose split at inline code, bold, and `$…$`, `$$…$$`, `\(…\)`, `\[…\]` mathematics. */
export type ProseSegment = { kind: 'text' | 'code' | 'strong' | 'math' | 'display'; text: string };
const delimiters = [['$$', '$$', 'display'], ['\\[', '\\]', 'display'], ['\\(', '\\)', 'math'], ['$', '$', 'math']] as const;
function closing(text: string, close: string, from: number) {
  for (let index = from; index < text.length; index++) {
    if (text.startsWith(close, index)) return index;
    if (text[index] === '\\') index++;
  }
  return -1;
}
/** A piece of prose as written, `[start, end)` in the raw text: one character of text, or a whole code, bold or formula. */
type ProseAtom = { kind: ProseSegment['kind']; start: number; end: number; text: string };
function proseAtoms(text: string): ProseAtom[] {
  const atoms: ProseAtom[] = [];
  const fence = /`+/y;
  let index = 0;
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
    const delimiter = delimiters.find(([open]) => text.startsWith(open, index));
    if (delimiter) {
      const [open, close, kind] = delimiter, end = closing(text, close, index + open.length);
      if (end > index + open.length) { atoms.push({ kind, start, end: index = end + close.length, text: text.slice(start + open.length, end) }); continue; }
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
/** A parsed `$…$` formula; the page renders it with plain elements and falls back to the source text on anything odd. */
export type MathStyle = 'text' | 'roman' | 'italic' | 'bold';
export type MathNode =
  | { type: 'text'; text: string; style?: MathStyle; role?: 'op' | 'punct' | 'big' | 'fn' }
  | { type: 'row'; children: MathNode[]; style?: MathStyle }
  | { type: 'script'; base: MathNode; sup?: MathNode; sub?: MathNode }
  | { type: 'frac'; top: MathNode; bottom: MathNode; bar: boolean }
  | { type: 'sqrt'; body: MathNode; index?: MathNode }
  | { type: 'accent'; body: MathNode; mark: string }
  | { type: 'line'; body: MathNode; position: 'over' | 'under' }
  | { type: 'stack'; base: MathNode; note: MathNode; position: 'over' | 'under' }
  | { type: 'table'; rows: MathNode[][]; open: string; close: string; align: 'center' | 'left' | 'pairs' };

const table = (spec: string) => new Map(spec.trim().split(/\s+/u).map(pair => { const at = pair.indexOf(':'); return [pair.slice(0, at), pair.slice(at + 1)] as [string, string]; }));
const greek = table(`alpha:α beta:β gamma:γ delta:δ epsilon:ϵ varepsilon:ε zeta:ζ eta:η theta:θ vartheta:ϑ iota:ι kappa:κ lambda:λ mu:μ
  nu:ν xi:ξ pi:π varpi:ϖ rho:ρ varrho:ϱ sigma:σ varsigma:ς tau:τ upsilon:υ phi:ϕ varphi:φ chi:χ psi:ψ omega:ω
  Gamma:Γ Delta:Δ Theta:Θ Lambda:Λ Xi:Ξ Pi:Π Sigma:Σ Upsilon:Υ Phi:Φ Psi:Ψ Omega:Ω`);
const ordinary = table(`infty:∞ emptyset:∅ varnothing:∅ nabla:∇ partial:∂ forall:∀ exists:∃ nexists:∄ neg:¬ lnot:¬ top:⊤ bot:⊥
  ell:ℓ hbar:ℏ aleph:ℵ Re:ℜ Im:ℑ wp:℘ prime:′ angle:∠ triangle:△ square:□ Box:□ checkmark:✓ dagger:† ddagger:‡ star:⋆
  ldots:… dots:… cdots:⋯ vdots:⋮ ddots:⋱ dotsc:… dotsb:⋯ langle:⟨ rangle:⟩ lceil:⌈ rceil:⌉ lfloor:⌊ rfloor:⌋ lvert:| rvert:|
  vert:| lVert:‖ rVert:‖ Vert:‖ lbrace:{ rbrace:} backslash:∖ S:§ P:¶ circ:∘ bullet:∙ diamond:⋄ ast:∗ colon:: natural:♮`);
const operators = table(`pm:± mp:∓ times:× div:÷ cdot:⋅ ast:∗ cup:∪ cap:∩ setminus:∖ smallsetminus:∖ wedge:∧ land:∧ vee:∨ lor:∨
  oplus:⊕ ominus:⊖ otimes:⊗ odot:⊙ uplus:⊎ sqcup:⊔ sqcap:⊓ amalg:⨿ triangleleft:◁ triangleright:▷
  le:≤ leq:≤ ge:≥ geq:≥ leqslant:⩽ geqslant:⩾ ne:≠ neq:≠ lt:< gt:> ll:≪ gg:≫ equiv:≡ approx:≈ cong:≅ sim:∼ simeq:≃ propto:∝
  doteq:≐ in:∈ notin:∉ ni:∋ subset:⊂ supset:⊃ subseteq:⊆ supseteq:⊇ subsetneq:⊊ supsetneq:⊋ sqsubseteq:⊑ mid:∣ nmid:∤
  parallel:∥ perp:⊥ vdash:⊢ dashv:⊣ models:⊨ prec:≺ succ:≻ preceq:⪯ succeq:⪰ to:→ gets:← rightarrow:→ leftarrow:←
  Rightarrow:⇒ Leftarrow:⇐ leftrightarrow:↔ Leftrightarrow:⇔ implies:⟹ impliedby:⟸ iff:⟺ mapsto:↦ longmapsto:⟼
  longrightarrow:⟶ longleftarrow:⟵ Longrightarrow:⟹ Longleftarrow:⟸ longleftrightarrow:⟷ Longleftrightarrow:⟺ hookrightarrow:↪
  twoheadrightarrow:↠ uparrow:↑ downarrow:↓ nearrow:↗ searrow:↘ coloneqq:≔ eqqcolon:≕ triangleq:≜ defeq:≝ lhd:⊲ rhd:⊳ unlhd:⊴ unrhd:⊵`);
const big = table(`sum:∑ prod:∏ coprod:∐ int:∫ iint:∬ iiint:∭ oint:∮ bigcup:⋃ bigcap:⋂ bigoplus:⨁ bigotimes:⨂ bigodot:⨀
  bigvee:⋁ bigwedge:⋀ biguplus:⨄ bigsqcup:⨆`);
const functions = new Set(`sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth log ln lg exp lim sup inf max min det dim ker
  deg gcd lcm hom arg Pr mod`.split(/\s+/u));
const negated = table(`=:≠ in:∉ subset:⊄ subseteq:⊈ supset:⊅ supseteq:⊉ equiv:≢ le:≰ leq:≰ ge:≱ geq:≱ <:≮ >:≯ sim:≁ approx:≉
  cong:≇ mid:∤ exists:∄ parallel:∦ vdash:⊬ models:⊭`);
const accents = new Map(Object.entries({ hat: '\u0302', widehat: '\u0302', tilde: '\u0303', widetilde: '\u0303', bar: '\u0304',
  vec: '\u20d7', dot: '\u0307', ddot: '\u0308', check: '\u030c', breve: '\u0306', acute: '\u0301', grave: '\u0300', mathring: '\u030a' }));
// Written as escapes: the spacing characters are invisible and `\s` would split them.
const spaces = new Map(Object.entries({ quad: '\u2003', qquad: '\u2003\u2003', enspace: '\u2002', thinspace: '\u2009',
  medspace: '\u205f', thickspace: '\u2004', space: ' ', ' ': ' ', ',': '\u2009', ':': '\u205f', '>': '\u205f', ';': '\u2004', '!': '' }));
const controls = new Map(Object.entries({ '{': '{', '}': '}', '%': '%', '&': '&', '#': '#', '_': '_', '$': '$', '|': '‖' }));
const operatorText = new Set('+−=<>±∓×÷⋅∗∪∩∖∧∨⊕⊗≤≥≠≡≈≅∼≃∝∈∉∋⊂⊃⊆⊇⊊⊋∣∤∥⊢⊨→←⇒⇐↔⇔⟹⟸⟺↦⟶⟷↪↠≔∘'.split(''));
const environments: Record<string, { open: string; close: string; align: 'center' | 'left' | 'pairs' }> = {
  matrix: { open: '', close: '', align: 'center' }, smallmatrix: { open: '', close: '', align: 'center' },
  pmatrix: { open: '(', close: ')', align: 'center' }, bmatrix: { open: '[', close: ']', align: 'center' },
  Bmatrix: { open: '{', close: '}', align: 'center' }, vmatrix: { open: '|', close: '|', align: 'center' },
  Vmatrix: { open: '‖', close: '‖', align: 'center' }, cases: { open: '{', close: '', align: 'left' },
  dcases: { open: '{', close: '', align: 'left' }, array: { open: '', close: '', align: 'center' },
  aligned: { open: '', close: '', align: 'pairs' }, align: { open: '', close: '', align: 'pairs' }, 'align*': { open: '', close: '', align: 'pairs' },
  alignedat: { open: '', close: '', align: 'pairs' }, split: { open: '', close: '', align: 'pairs' }, gathered: { open: '', close: '', align: 'center' },
  gather: { open: '', close: '', align: 'center' }, 'gather*': { open: '', close: '', align: 'center' }, eqnarray: { open: '', close: '', align: 'pairs' },
};
const alphabets: Record<string, { upper: number; lower?: number; digit?: number; except?: Record<string, string> }> = {
  bb: { upper: 0x1d538, lower: 0x1d552, digit: 0x1d7d8, except: { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' } },
  cal: { upper: 0x1d49c, except: { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ' } },
  frak: { upper: 0x1d504, lower: 0x1d51e, except: { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' } },
};
const fonts: Record<string, string> = { mathbb: 'bb', mathbbm: 'bb', Bbb: 'bb', mathcal: 'cal', mathscr: 'cal', mathfrak: 'frak' };
function letters(text: string, name: string) {
  const alphabet = alphabets[name]!;
  return [...text].map(character => {
    if (alphabet.except?.[character]) return alphabet.except[character];
    const code = character.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(alphabet.upper + code - 65);
    if (code >= 97 && code <= 122 && alphabet.lower) return String.fromCodePoint(alphabet.lower + code - 97);
    if (code >= 48 && code <= 57 && alphabet.digit) return String.fromCodePoint(alphabet.digit + code - 48);
    return character;
  }).join('');
}
type Stop = '}' | ']' | 'cell';
class TexParser {
  index = 0;
  /** Open groups and arguments, `\\text` math included, so a deep formula fails here rather than in the renderer. */
  private nesting: number;
  constructor(readonly source: string, nesting = 0) { this.nesting = nesting; }
  private enter() { if (++this.nesting > 48) throw new Error('math_too_deep'); }
  private peek(text: string) { return this.source.startsWith(text, this.index); }
  private skipSpace() { while (/\s/u.test(this.source[this.index] ?? '')) this.index++; }
  private name() {
    const match = /^[A-Za-z]+/u.exec(this.source.slice(this.index, this.index + 40));
    if (!match) { this.index++; return this.source[this.index - 1] ?? ''; }
    this.index += match[0].length;
    let name = match[0];
    if (name === 'operatorname' && this.source[this.index] === '*') { this.index++; name += '*'; }
    this.skipSpace();
    return name;
  }
  /** Nodes up to the stop (not consumed); a cell stop also ends at `&`, `\\` and `\end`. */
  list(stop?: Stop): MathNode[] {
    this.enter();
    const nodes: MathNode[] = [];
    while (this.index < this.source.length) {
      const character = this.source[this.index]!;
      if (stop === '}' && character === '}' || stop === ']' && character === ']') break;
      if (stop === 'cell' && (character === '&' || this.peek('\\\\') || this.peek('\\end'))) break;
      if (character === '^' || character === '_') {
        this.index++;
        this.attach(nodes, character === '^' ? 'sup' : 'sub', this.argument());
        continue;
      }
      if (character === "'") {
        let primes = '';
        while (this.source[this.index] === "'") { primes += '′'; this.index++; }
        this.attach(nodes, 'sup', { type: 'text', text: primes, style: 'roman' });
        continue;
      }
      nodes.push(...this.atom());
    }
    this.nesting--;
    return nodes;
  }
  private attach(nodes: MathNode[], slot: 'sup' | 'sub', value: MathNode) {
    const last = nodes.at(-1);
    if (last?.type === 'script' && !last[slot]) { last[slot] = value; return; }
    const script: MathNode = { type: 'script', base: last && last.type !== 'script' ? nodes.pop()! : { type: 'text', text: '' } };
    script[slot] = value;
    nodes.push(script);
  }
  /** A braced group, one command, or one character, as TeX reads a script or macro argument. */
  argument(): MathNode {
    this.enter();
    this.skipSpace();
    const nodes = this.source[this.index] === '{' ? [this.group()] : this.source[this.index] === '\\' ? this.atom() : this.character(true);
    this.nesting--;
    return nodes.length === 1 ? nodes[0]! : { type: 'row', children: nodes };
  }
  private group(): MathNode {
    this.index++;
    const children = this.list('}');
    if (this.source[this.index] !== '}') throw new Error('math_group_open');
    this.index++;
    return { type: 'row', children };
  }
  private optional(): MathNode | undefined {
    this.skipSpace();
    if (this.source[this.index] !== '[') return undefined;
    this.index++;
    const children = this.list(']');
    if (this.source[this.index] !== ']') throw new Error('math_option_open');
    this.index++;
    return { type: 'row', children };
  }
  /** A group's source text, for commands whose argument is text rather than mathematics. */
  private raw(): string {
    this.skipSpace();
    if (this.source[this.index] !== '{') {
      const start = this.index;
      if (this.source[this.index] === '\\') { this.index++; this.name(); } else this.index += this.codePointLength();
      return this.source.slice(start, this.index);
    }
    let depth = 0;
    const start = this.index + 1;
    for (; this.index < this.source.length; this.index++) {
      const character = this.source[this.index];
      if (character === '\\') { this.index++; continue; }
      if (character === '{') depth++;
      if (character === '}' && --depth === 0) { this.index++; return this.source.slice(start, this.index - 1); }
    }
    throw new Error('math_group_open');
  }
  private codePointLength() { return (this.source.codePointAt(this.index) ?? 0) > 0xffff ? 2 : 1; }
  /** A letter or digit run (one character when reading an argument), or a symbol. */
  private character(single = false): MathNode[] {
    const rest = this.source.slice(this.index, this.index + 200);
    const run = single ? undefined : /^(?:[A-Za-zα-ωΑ-Ω]+|\d+(?:\.\d+)?)/u.exec(rest)?.[0];
    const text = run ?? String.fromCodePoint(this.source.codePointAt(this.index)!);
    this.index += text.length;
    if (/^[A-Za-zα-ωΑ-Ω]+$/u.test(text)) return [{ type: 'text', text, style: 'italic' }];
    if (/^[\d.]+$/u.test(text)) return [{ type: 'text', text, style: 'roman' }];
    if (/\s/u.test(text) || text === '&') return [];
    if (text === '{') { this.index--; return [this.group()]; }
    if (text === '}') throw new Error('math_group_close');
    if (text === '~') return [{ type: 'text', text: ' ' }];
    if (text === '-') return [{ type: 'text', text: '−', role: 'op' }];
    if (text === '*') return [{ type: 'text', text: '∗', role: 'op' }];
    if (text === ',' || text === ';') return [{ type: 'text', text, role: 'punct' }];
    if (text === ':') return [{ type: 'text', text, role: 'op' }];
    if (operatorText.has(text)) return [{ type: 'text', text, role: 'op' }];
    return [{ type: 'text', text, style: /\p{Script=Han}/u.test(text) ? 'text' : 'roman' }];
  }
  private atom(): MathNode[] {
    if (this.source[this.index] !== '\\') return this.character();
    if (this.peek('\\\\')) { this.index += 2; if (this.source[this.index] === '[') this.optional(); return []; }
    this.index++;
    const name = this.name();
    const roman = (text: string, role?: 'fn' | 'big' | 'op'): MathNode[] => [{ type: 'text', text, style: 'roman', ...(role ? { role } : {}) }];
    if (spaces.has(name)) return spaces.get(name) ? [{ type: 'text', text: spaces.get(name)! }] : [];
    if (controls.has(name)) return roman(controls.get(name)!);
    if (greek.has(name)) return [{ type: 'text', text: greek.get(name)!, style: /^[A-Z]/u.test(name) ? 'roman' : 'italic' }];
    if (operators.has(name)) return roman(operators.get(name)!, 'op');
    if (ordinary.has(name)) return roman(ordinary.get(name)!);
    if (big.has(name)) return roman(big.get(name)!, 'big');
    if (functions.has(name)) return roman(name, 'fn');
    if (name === 'liminf' || name === 'limsup') return roman(`lim ${name.slice(3)}`, 'fn');
    if (name === 'operatorname' || name === 'operatorname*') return roman(plainTex(this.raw()), 'fn');
    if (['text', 'textrm', 'textnormal', 'textup', 'mbox', 'hbox', 'textsf', 'texttt'].includes(name)) return [this.text(this.raw(), 'text')];
    if (['textit', 'emph', 'textsl'].includes(name)) return [this.text(this.raw(), 'italic')];
    if (name === 'textbf') return [this.text(this.raw(), 'bold')];
    if (['mathrm', 'mathsf', 'mathtt', 'mathup'].includes(name)) return [{ type: 'row', children: [this.argument()], style: 'roman' }];
    if (['mathit', 'mathnormal'].includes(name)) return [{ type: 'row', children: [this.argument()], style: 'italic' }];
    if (['mathbf', 'boldsymbol', 'bm', 'pmb'].includes(name)) return [{ type: 'row', children: [this.argument()], style: 'bold' }];
    if (fonts[name]) return roman(letters(plainTex(this.raw()), fonts[name]!));
    if (['frac', 'dfrac', 'tfrac', 'cfrac'].includes(name)) return [{ type: 'frac', top: this.argument(), bottom: this.argument(), bar: true }];
    if (['binom', 'dbinom', 'tbinom'].includes(name))
      return [{ type: 'row', children: [...roman('('), { type: 'frac', top: this.argument(), bottom: this.argument(), bar: false }, ...roman(')')] }];
    if (name === 'sqrt') { const index = this.optional(); return [{ type: 'sqrt', body: this.argument(), ...(index ? { index } : {}) }]; }
    if (accents.has(name)) {
      const argument = this.argument(), body = argument.type === 'row' && argument.children.length === 1 ? argument.children[0]! : argument;
      return [body.type === 'text' && [...body.text].length === 1 ? { ...body, text: body.text + accents.get(name)! } : { type: 'accent', body, mark: accents.get(name)! }];
    }
    if (name === 'overline' || name === 'underline') return [{ type: 'line', body: this.argument(), position: name === 'overline' ? 'over' : 'under' }];
    if (name === 'overbrace' || name === 'underbrace') return [{ type: 'line', body: this.argument(), position: name === 'overbrace' ? 'over' : 'under' }];
    if (name === 'overset' || name === 'stackrel' || name === 'underset') {
      const note = this.argument();
      return [{ type: 'stack', note, base: this.argument(), position: name === 'underset' ? 'under' : 'over' }];
    }
    if (name === 'not') {
      this.skipSpace();
      const start = this.index;
      let next = this.source[this.index++] ?? '';
      if (next === '\\') next = this.name();
      if (negated.has(next)) return roman(negated.get(next)!, 'op');
      this.index = start;
      const [node] = this.atom();
      return node?.type === 'text' ? [{ ...node, text: `${node.text}\u0338` }] : node ? [node, { type: 'text', text: '\u0338' }] : [];
    }
    if (['left', 'right', 'middle', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr', 'bigm', 'Bigm'].includes(name)) {
      this.skipSpace();
      if (this.source[this.index] === '.') this.index++;
      return [];
    }
    if (['displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits', 'nonumber', 'notag', 'qedhere', 'allowbreak'].includes(name)) return [];
    if (['label', 'tag', 'phantom', 'hphantom', 'vphantom', 'hspace', 'vspace', 'kern', 'mkern', 'hskip'].includes(name)) { this.raw(); return []; }
    if (name === 'pmod') return [{ type: 'row', children: [...roman(' ('), ...roman('mod', 'fn'), this.argument(), ...roman(')')] }];
    if (name === 'bmod') return roman('mod', 'op');
    if (name === 'mathop' || name === 'boxed' || name === 'mathclap' || name === 'substack') return [this.argument()];
    if (name === 'begin') return [this.environment()];
    if (name === 'end') { this.raw(); return []; }
    return roman(`\\${name}`);
  }
  /** `\text{…}` content: words in the text font, with any `$…$` inside read as mathematics again. */
  private text(source: string, style: MathStyle): MathNode {
    const children = source.split(/(?<!\\)\$/u).map((piece, index): MathNode => index % 2
      ? { type: 'row', children: new TexParser(piece, this.nesting + 1).list() }
      : { type: 'text', text: plainTex(piece), style });
    return children.length === 1 ? children[0]! : { type: 'row', children, style };
  }
  private environment(): MathNode {
    const name = plainTex(this.raw()).trim(), shape = environments[name] ?? { open: '', close: '', align: 'center' as const };
    if (name === 'array' || name === 'alignedat') this.raw();
    const rows: MathNode[][] = [[]];
    for (;;) {
      const cell = this.list('cell');
      rows.at(-1)!.push(cell.length === 1 ? cell[0]! : { type: 'row', children: cell });
      if (this.index >= this.source.length) throw new Error('math_environment_open');
      if (this.source[this.index] === '&') { this.index++; continue; }
      if (this.peek('\\\\')) {
        this.index += 2;
        if (this.source[this.index] === '[') this.optional();
        rows.push([]);
        continue;
      }
      this.index += '\\end'.length;
      if (plainTex(this.raw()).trim() !== name) throw new Error('math_environment_mismatch');
      break;
    }
    const last = rows.at(-1)!;
    if (rows.length > 1 && last.length === 1 && last[0]!.type === 'row' && !last[0]!.children.length) rows.pop();
    return { type: 'table', rows, open: shape.open, close: shape.close, align: shape.align };
  }
}

/** Source text with symbol commands replaced, for `\text{…}` and font arguments. */
function plainTex(source: string): string {
  // A control word swallows the spaces after it; a control symbol such as `\,` does not.
  return source.replace(/\\(?:([A-Za-z]+)\s*|(.))/gu, (match, word: string | undefined, symbol: string | undefined) => {
    const name = word ?? symbol!;
    return greek.get(name) ?? ordinary.get(name) ?? operators.get(name) ?? controls.get(name) ?? spaces.get(name) ?? (name === '\\' ? ' ' : match);
  }).replace(/[{}]/gu, '').replaceAll('~', ' ');
}

/** The formula as nodes, or undefined when it does not parse; the caller then shows the source as written. */
export function parseMath(source: string): MathNode | undefined {
  if (source.length > 4000) return undefined;
  try {
    const parser = new TexParser(source), children = parser.list();
    return parser.index >= source.length ? { type: 'row', children } : undefined;
  } catch { return undefined; }
}
const openBrackets = new Set('([{⟨⌈⌊'), closeBrackets = new Set(')]}⟩⌉⌋');
/**
 * Where an inline formula may wrap, as TeX lets it: after a relation, an operator or a comma outside brackets, between
 * two operands (so not after a leading sign or inside `:=`). The top-level nodes of `formula`, cut into pieces at those
 * places; one piece when there are none.
 */
export function mathPieces(formula: MathNode): MathNode[][] {
  const nodes = formula.type === 'row' ? formula.children : [formula], pieces: MathNode[][] = [[]];
  const role = (node: MathNode | undefined) => node?.type === 'text' ? node.role : undefined;
  const breaks = (node: MathNode | undefined) => role(node) === 'op' || role(node) === 'punct';
  // A bracket is plain text, or the base of the scripts after it, as in `(a + b)^2`.
  const bracket = (node: MathNode) => { const base = node.type === 'script' ? node.base : node; return base.type === 'text' && !base.role ? base.text : ''; };
  let depth = 0;
  nodes.forEach((node, index) => {
    pieces.at(-1)!.push(node);
    depth = Math.max(0, depth + (openBrackets.has(bracket(node)) ? 1 : closeBrackets.has(bracket(node)) ? -1 : 0));
    const before = nodes[index - 1], after = nodes[index + 1];
    if (depth === 0 && breaks(node) && before && !breaks(before) && after && !breaks(after)) pieces.push([]);
  });
  return pieces;
}
