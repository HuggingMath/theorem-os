import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { assertInformalizationEvidence, type InformalizationEvidence } from '../../src/math/informalization';
import { leanSourceSlice, type InformalizationUnit } from '../../src/math/informalizationExtraction';
import { mathDigest } from '../../src/math/mathRuntimeIo';
import { reportedTotalTokens } from '../../src/solver/usageBudget';
import type { WebEnvironment, WebExplanationDocument, WebExplanationGoals, WebExplanationLanguage, WebExplanationLines,
  WebExplanationUse } from './shared';

/** What an explanation must be about: one target of one accepted proof, in one language and environment. */
export type WebExplanationBinding = { proof: string; target: string; language: WebExplanationLanguage; environment: WebEnvironment };

const lineEnds = (value: string) => value.replaceAll('\r\n', '\n');
/** The host's excerpt match (whitespace runs collapse, ends trimmed), with each kept character's raw offset. */
function collapsed(value: string): { text: string; offsets: number[] } {
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
const count = (value: string, end: number) => {
  let lines = 0;
  for (let index = value.indexOf('\n'); index >= 0 && index < end; index = value.indexOf('\n', index + 1)) lines++;
  return lines;
};

/** Lines (1-based in the proof file) a declaration covers; a range ending at column 0 ends on the line before. */
export function unitLines(unit: Pick<InformalizationUnit, 'range'>): WebExplanationLines {
  const { line, endLine, endColumn } = unit.range;
  return { start: line, end: endLine > line && endColumn === 0 ? endLine - 1 : endLine };
}

type Offsets = { start: number; end: number };
const identifierChar = /[\p{L}\p{N}_'!?₀-ₜᵢ-ᵪ]/u;
const lineStart = (text: string, index: number) => text.lastIndexOf('\n', index - 1) + 1;
const lineEnd = (text: string, index: number) => { const end = text.indexOf('\n', index); return end < 0 ? text.length : end; };

/**
 * Where each step's excerpts are in the declaration's source (raw offsets, end exclusive), matched with whitespace runs
 * collapsed. Steps are placed in order: an excerpt is looked for after the previous step's first match, then from the
 * start, so a repeated tactic lands on the occurrence that follows the steps before it.
 */
function placeExcerpts(source: string, steps: readonly (readonly string[])[]): { places: Offsets[][]; ambiguous: number } {
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
/** Proof-file lines of placed excerpts, sorted, with touching ranges merged. */
function placedLines(unit: Pick<InformalizationUnit, 'range'>, source: string, places: readonly Offsets[]): WebExplanationLines[] {
  const ranges = places.map(place => ({ start: unit.range.line + count(source, place.start), end: unit.range.line + count(source, place.end - 1) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: WebExplanationLines[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
/** Proof-file lines of the first occurrence of each excerpt in the declaration's source, merged. */
export function excerptLines(unit: Pick<InformalizationUnit, 'range' | 'source'>, excerpts: readonly string[]): WebExplanationLines[] {
  const source = lineEnds(unit.source);
  return placedLines(unit, source, placeExcerpts(source, [excerpts]).places[0]!);
}

/** The source with comments and string and character literals blanked (newlines kept), so offsets are the source's. */
function codeOnly(source: string): string {
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
function signatureEnd(code: string): number {
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
/** A line of only keywords and punctuation (`by`, `calc`, `·`, brackets) explains nothing on its own. */
const trivialLine = (code: string) => !code.replace(/:=|\b(?:by|calc|do|fun|show|from|where)\b|[()[\]{}⟨⟩·.,;|=>]/gu, '').trim();

/**
 * Offsets where a cited name is written: the full name, or a shorter form `open` allows. A form preceded by `Ns.` where
 * Ns looks like a namespace (`Nat`, `HPow`) is part of another qualified name; dot notation on `h` or `H` is counted.
 */
function occurrences(code: string, form: string): number[] {
  const found: number[] = [];
  for (let at = code.indexOf(form); at >= 0 && found.length < 64; at = code.indexOf(form, at + 1)) {
    const before = code[at - 1] ?? ' ', after = code[at + form.length] ?? ' ';
    if (identifierChar.test(before) || identifierChar.test(after)) continue;
    if (before === '.') {
      let start = at - 1;
      while (start > 0 && identifierChar.test(code[start - 1]!)) start--;
      if (/^\p{Lu}\p{L}/u.test(code.slice(start, at - 1))) continue;
    }
    found.push(at);
  }
  return found;
}
function locateUse(code: string, name: string, step: readonly Offsets[]): { place: WebExplanationUse['place']; offsets: number[]; length: number } {
  const parts = name.replace(/^_root_\./u, '').split('.');
  const forms = parts.map((_, index) => parts.slice(index).join('.')).filter((form, index) => index === 0 || form.length > 1);
  const inStep = (at: number, length: number) => step.some(place => at >= place.start && at + length <= place.end);
  for (const form of forms) {
    const offsets = occurrences(code, form).filter(at => inStep(at, form.length));
    if (offsets.length) return { place: 'step', offsets, length: form.length };
  }
  for (const form of forms) {
    const offsets = occurrences(code, form);
    if (offsets.length) return { place: 'declaration', offsets, length: form.length };
  }
  return { place: 'implicit', offsets: [], length: 0 };
}
const within = (lines: readonly WebExplanationLines[], line: number) => lines.some(item => line >= item.start && line <= item.end);

/**
 * Goals around the tactics a step quotes: the outermost recorded tactics inside its placed excerpts, or, when the excerpts
 * are part of one tactic (the first line of a `have … := by`), the smallest tactic they overlap. Before is the first
 * one's, after the last one's.
 */
function stepGoals(unit: InformalizationUnit, source: string, places: readonly Offsets[]): WebExplanationGoals | undefined {
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
  }
  if (!chosen.length) return undefined;
  chosen.sort((a, b) => a.start - b.start);
  const first = chosen[0]!.item, last = chosen.at(-1)!.item;
  return { before: first.before, beforeCount: first.beforeCount, after: last.after, afterCount: last.afterCount,
    lines: { start: first.range.line, end: Math.max(...chosen.map(tactic => tactic.item.range.endLine)) } };
}

/** Re-derive the evidence and check it explains exactly this proof; a worker's claims are not trusted. */
export function verifyExplanationEvidence(value: unknown, binding: WebExplanationBinding): { evidence: InformalizationEvidence; markdown: string } {
  let verified: ReturnType<typeof assertInformalizationEvidence>;
  try { verified = assertInformalizationEvidence(value); } catch { throw new Error('explanation_evidence_invalid'); }
  const { evidence } = verified, environment = getLeanTaskEnvironment(binding.environment);
  const [source] = evidence.sources;
  if (evidence.target !== binding.target || evidence.language !== binding.language || evidence.sources.length !== 1 ||
      source!.file !== 'Submission.lean' || source!.module !== 'Submission' || source!.sha256 !== mathDigest(binding.proof) ||
      evidence.toolchain !== environment.toolchain || evidence.mathlibRevision !== (environment.mathlibRevision ?? null))
    throw new Error('explanation_evidence_mismatch');
  // Line numbers on the page come from these ranges, so each quoted source must be the proof's own text there.
  for (const unit of evidence.outline.units) {
    let slice: string;
    try { slice = leanSourceSlice(binding.proof, unit.range); } catch { throw new Error('explanation_evidence_mismatch'); }
    if (unit.module !== 'Submission' || unit.file !== 'Submission.lean' || lineEnds(slice) !== lineEnds(unit.source))
      throw new Error('explanation_evidence_mismatch');
  }
  return verified;
}

/**
 * The page's projection: declarations in file order (the main theorem need not be last); a theorem's statement tied to
 * its signature and each step to the lines it quotes; cited names to where they are written; auditor explanations.
 * `proof` is the verified proof file, read for the columns of names on a declaration's first line.
 */
export function explanationDocument(evidence: InformalizationEvidence, proof: string): WebExplanationDocument {
  const written = new Map(evidence.batches.flatMap(batch => batch.writer.sections.map(section => [section.declaration, { section, batch }] as const)));
  const fileLines = lineEnds(proof).split('\n');
  const target = evidence.outline.units.at(-1)!;
  const units = [...evidence.outline.units].sort((a, b) => a.range.line - b.range.line || a.range.column - b.range.column);
  const totals = evidence.sessions.map(session => reportedTotalTokens(session.usage)).filter((value): value is number => value !== null);
  let proofLines = 0, explainedLines = 0, ambiguousExcerpts = 0;
  const sections = units.map(unit => {
    const { section, batch } = written.get(unit.name)!;
    const source = lineEnds(unit.source), code = codeOnly(source), lines = unitLines(unit);
    const { places, ambiguous } = placeExcerpts(source, section.proof.map(step => step.lean));
    ambiguousExcerpts += ambiguous;
    // A declaration's first line starts at its column; the column is in codepoints, the page's offsets in UTF-16.
    const firstColumn = [...fileLines[unit.range.line - 1] ?? ''].slice(0, unit.range.column).join('').length;
    const position = (at: number) => {
      const line = count(source, at), start = lineStart(source, at);
      return { line: unit.range.line + line, column: at - start + (line ? 0 : firstColumn) };
    };
    const audits = batch.audits.map(audit => audit.output.sections.find(item => item.declaration === unit.name));
    const reviews = (pick: (audit: NonNullable<typeof audits[number]>) => string | undefined) =>
      audits.flatMap(audit => { const text = audit && pick(audit)?.trim(); return text ? [text] : []; });
    const steps = section.proof.map((step, index) => {
      const goals = stepGoals(unit, source, places[index]!);
      return { text: step.text, lines: placedLines(unit, source, places[index]!),
        uses: step.uses.map(name => {
          const found = locateUse(code, name, places[index]!);
          return { name, place: found.place, spans: found.offsets.slice(0, 24).map(at => {
            const { line, column } = position(at);
            return { line, start: column, end: column + found.length };
          }) };
        }),
        reviews: reviews(audit => audit.steps[index]?.explanation), ...goals ? { goals } : {} };
    });
    // A theorem's statement explains its signature and the steps its body; any other declaration is all statement.
    const split = unit.kind === 'theorem' ? signatureEnd(code) : -1;
    const signature = split < 0 ? lines : { start: lines.start, end: position(split).line };
    const unexplained: number[] = [];
    if (split >= 0) {
      const quoted = steps.flatMap(step => step.lines), codeLines = code.split('\n');
      for (let line = signature.end; line <= lines.end; line++) {
        const text = codeLines[line - unit.range.line] ?? '';
        // The signature's last line counts only for code from the `:=` on.
        if (trivialLine(line === signature.end ? text.slice(split - lineStart(code, split)) : text)) continue;
        proofLines++;
        if (within(quoted, line)) explainedLines++; else unexplained.push(line);
      }
    }
    return { name: unit.name, kind: unit.kind, target: unit === target, title: section.title, statement: section.statement, lines, signature,
      unexplained, statementReviews: reviews(audit => audit.statement.explanation), steps };
  });
  return { schema: 'theorem-os.web-explanation.v1', target: evidence.target, language: evidence.language,
    toolchain: evidence.toolchain, mathlibRevision: evidence.mathlibRevision,
    overview: evidence.batches.at(-1)!.writer.overview!, axioms: evidence.outline.axioms, sections,
    metrics: { declarations: evidence.metrics.declarations, steps: evidence.metrics.steps, citations: evidence.metrics.citations,
      excerptCoverage: evidence.metrics.excerptCoverage, proofLines, explainedLines, ambiguousExcerpts },
    model: evidence.writer.model, effort: evidence.writer.effort, auditors: evidence.auditors.length,
    rounds: evidence.batches.reduce((sum, batch) => sum + batch.rounds, 0),
    tokens: totals.length ? totals.reduce((sum, value) => sum + value, 0) : null };
}

export function explanationMarkdownFilename(runId: string, target: string, language: WebExplanationLanguage): string {
  const name = target.replace(/[^A-Za-z0-9_.-]+/gu, '_').replace(/^[._]+|[._]+$/gu, '').slice(0, 80) || 'theorem';
  return `theoremos-${runId.slice(0, 8)}-${name}-${language}.md`;
}
