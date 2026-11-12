import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { assertInformalizationEvidence, informalizationOutputRoute, informalizationSectionSummary, informalizationStepGoalsOptions,
  type InformalizationEvidence } from '../../src/math/informalization';
import { incidentalLibraryName, leanSourceSlice, type InformalizationUnit } from '../../src/math/informalizationExtraction';
import { codeOnly, count, findWithin, identifierChar, lineEnds, lineStart, offsetSpans, placeExcerpts, signatureEnd,
  statementRegion, stepGoals, type SourceOffsets as Offsets } from '../../src/math/informalizationAlignment';
import { formalizationDigest, type FormalizationEvidence } from '../../src/math/formalization';
import { mathDigest } from '../../src/math/mathRuntimeIo';
import { reportedTotalTokens } from '../../src/solver/usageBudget';
import { declarationNames, declarationRegions, formalizationCorrespondences } from './formalizationReport';
import type { WebEnvironment, WebExplanationDocument, WebExplanationLanguage, WebExplanationLines, WebExplanationLink,
  WebExplanationUse } from './shared';

// What `native_decide` leaves in a term: the kernel trusts the compiler's evaluation.
const COMPILED = new Set(['Lean.ofReduceBool', 'Lean.ofReduceNat', 'Lean.trustCompiler', 'Lean.reduceBool', 'Lean.reduceNat']);

/** What an explanation must be about: one target of one accepted proof, in one language and environment. */
export type WebExplanationBinding = { proof: string; target: string; language: WebExplanationLanguage; environment: WebEnvironment };

/** Lines (1-based in the proof file) a declaration covers; a range ending at column 0 ends on the line before. */
export function unitLines(unit: Pick<InformalizationUnit, 'range'>): WebExplanationLines {
  const { line, endLine, endColumn } = unit.range;
  return { start: line, end: endLine > line && endColumn === 0 ? endLine - 1 : endLine };
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
 * its signature and each step to the lines it quotes; cited names and linked phrases to where they are written; auditor
 * explanations. `proof` is the verified proof file, read for the columns of names on a declaration's first line.
 * `formalization` is the verified formalization the evidence records, when it records one.
 */
export function explanationDocument(evidence: InformalizationEvidence, proof: string,
  formalization?: FormalizationEvidence): WebExplanationDocument {
  if (Boolean(formalization) !== Boolean(evidence.formalization) ||
      formalization && formalizationDigest(formalization) !== evidence.formalization!.evidenceSha256)
    throw new Error('explanation_formalization_mismatch');
  const written = new Map(evidence.batches.flatMap(batch => batch.writer.sections.map(section => [section.declaration, { section, batch }] as const)));
  const fileLines = lineEnds(proof).split('\n');
  const target = evidence.outline.units.at(-1)!;
  const units = [...evidence.outline.units].sort((a, b) => a.range.line - b.range.line || a.range.column - b.range.column);
  const totals = evidence.sessions.map(session => reportedTotalTokens(session.usage)).filter((value): value is number => value !== null);
  const auditedGoals = informalizationStepGoalsOptions(evidence.alignment);
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
    // A phrase's offsets in its prose and its Lean's place in the file; the host checked both when the batch was accepted.
    const linked = (prose: string, links: readonly { text: string; lean: string }[] | undefined, regions: readonly Offsets[]) =>
      (links ?? []).flatMap((link): WebExplanationLink[] => {
        const start = prose.indexOf(link.text), place = findWithin(source, link.lean, regions);
        if (start < 0 || !place) return [];
        return [{ start, end: start + link.text.length, lean: offsetSpans(source, place.start, place.end).map(span => ({
          line: unit.range.line + span.line, start: span.start + (span.line ? 0 : firstColumn), end: span.end + (span.line ? 0 : firstColumn) })) }];
      });
    const audits = batch.audits.map(audit => audit.output.sections.find(item => item.declaration === unit.name));
    const reviews = (pick: (audit: NonNullable<typeof audits[number]>) => string | undefined) =>
      audits.flatMap(audit => { const text = audit && pick(audit)?.trim(); return text ? [text] : []; });
    const steps = section.proof.map((step, index) => {
      // The page shows the current goals; auditors of an older alignment saw other goals for some steps, which they did not check.
      const goals = stepGoals(unit, source, places[index]!), audited = stepGoals(unit, source, places[index]!, auditedGoals);
      const links = linked(step.text, 'links' in step ? step.links : undefined, places[index]!);
      const goalsChecked = evidence.alignment && goals && JSON.stringify(audited) === JSON.stringify(goals) ? audits.filter(audit => {
        const verdict = audit?.steps[index];
        return verdict && 'goals' in verdict && verdict.goals === 'consistent';
      }).length : 0;
      return { text: step.text, lines: placedLines(unit, source, places[index]!),
        uses: step.uses.map(name => {
          const found = locateUse(code, name, places[index]!);
          return { name, place: found.place, spans: found.offsets.slice(0, 24).map(at => {
            const { line, column } = position(at);
            return { line, start: column, end: column + found.length };
          }) };
        }),
        reviews: reviews(audit => audit.steps[index]?.explanation), ...goals ? { goals } : {},
        ...links.length ? { links } : {}, ...goalsChecked ? { goalsChecked } : {} };
    });
    const summary = informalizationSectionSummary(section);
    const computed = unit.kind !== 'theorem' ? undefined : unit.external.some(name => COMPILED.has(name)) ? 'compiled' as const
      : unit.external.includes('of_decide_eq_true') ? 'kernel' as const : undefined;
    const statementLinks = linked(section.statement, 'statementLinks' in section ? section.statementLinks : undefined, [statementRegion(unit)]);
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
      unexplained, statementReviews: reviews(audit => audit.statement.explanation), steps,
      ...statementLinks.length ? { statementLinks } : {}, ...summary ? { summary } : {}, ...computed ? { computed } : {} };
  });
  // The formalization's statement declarations, where the proof keeps them (the host checked it keeps every one).
  const problem = formalization && { problemId: formalization.request.problemId, original: formalization.request.statement,
    correspondences: formalizationCorrespondences(formalization, proof,
      declarationRegions(proof, declarationNames(formalization.candidate.source))) };
  const route = informalizationOutputRoute(evidence.batches.at(-1)!.writer);
  // Library declarations by how many of the proof's declarations use them; tactic and metaprogramming internals are left out.
  const theorems = new Set(evidence.outline.library.flatMap(item => item.kind === 'theorem' ? [item.name] : [])), users = new Map<string, string[]>();
  for (const unit of units) for (const name of unit.external)
    if (theorems.has(name) && !incidentalLibraryName(name) && name !== 'of_decide_eq_true') users.set(name, [...users.get(name) ?? [], unit.name]);
  const library = [...users].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).slice(0, 200).map(([name, usedBy]) => ({ name, usedBy }));
  return { schema: 'theorem-os.web-explanation.v1', target: evidence.target, language: evidence.language,
    toolchain: evidence.toolchain, mathlibRevision: evidence.mathlibRevision,
    overview: evidence.batches.at(-1)!.writer.overview!, axioms: evidence.outline.axioms, sections,
    metrics: { declarations: evidence.metrics.declarations, steps: evidence.metrics.steps, citations: evidence.metrics.citations,
      excerptCoverage: evidence.metrics.excerptCoverage, proofLines, explainedLines, ambiguousExcerpts },
    model: evidence.writer.model, effort: evidence.writer.effort, auditors: evidence.auditors.length,
    rounds: evidence.batches.reduce((sum, batch) => sum + batch.rounds, 0),
    tokens: totals.length ? totals.reduce((sum, value) => sum + value, 0) : null,
    ...evidence.alignment ? { alignment: evidence.alignment } : {}, ...problem ? { problem } : {},
    ...route ? { route } : {}, library };
}

export function explanationMarkdownFilename(runId: string, target: string, language: WebExplanationLanguage): string {
  const name = target.replace(/[^A-Za-z0-9_.-]+/gu, '_').replace(/^[._]+|[._]+$/gu, '').slice(0, 80) || 'theorem';
  return `theoremos-${runId.slice(0, 8)}-${name}-${language}.md`;
}
