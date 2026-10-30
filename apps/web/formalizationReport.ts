import { formalizationDigest, type FormalizationEvidence } from '../../src/math/formalization';
import { count, findWithin, lineEnds, offsetSpans, type SourceOffsets } from '../../src/math/informalizationAlignment';
import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from '../../src/math/leanSource';
import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { maskLeanComments } from '../../src/math/leanSyntax';
import { webFormalizationAspects, type WebExplanationSpan, type WebFormalizationCorrespondence, type WebFormalizationReport } from './shared';

/** Spans (lines from 1, UTF-16 columns) of `text[start, end)` in a whole file. */
export const fileSpans = (text: string, place: SourceOffsets): WebExplanationSpan[] =>
  offsetSpans(text, place.start, place.end).map(span => ({ ...span, line: span.line + 1 }));

/**
 * Where a Lean file states the named declarations (every one when `names` is absent): a theorem's header up to its `:=`,
 * a definition's or instance's whole text. Offsets with CRLF read as LF.
 */
export function declarationRegions(source: string, names?: ReadonlySet<string>): SourceOffsets[] {
  const masked = maskLeanComments(lineEnds(source)), regions = inspectLeanDeclarationRegions(masked);
  return inspectScopedLeanDeclarations(masked).flatMap((item, index) => {
    const region = regions[index]!;
    if (names && !names.has(item.qualifiedName)) return [];
    const header = masked.slice(region.bodyOffset - 2, region.bodyOffset) === ':=' ? region.bodyOffset - 2 : region.bodyOffset;
    return [{ start: item.startOffset, end: item.kind === 'theorem' ? header : region.endOffset }];
  });
}
/** Qualified names of the declarations a Lean file states. */
export const declarationNames = (source: string) =>
  new Set(inspectScopedLeanDeclarations(maskLeanComments(lineEnds(source))).map(item => item.qualifiedName));

type Review = { reviewer: string; review: FormalizationEvidence['review'] };
const reviewsOf = (evidence: FormalizationEvidence): Review[] => evidence.workflow
  ? evidence.workflow.reviews.map(item => ({ reviewer: item.reviewerId, review: item.review }))
  : [{ reviewer: 'reviewer', review: evidence.review }];
const relationRank = { direct: 0, equivalent: 1, unresolved: 2, mismatch: 3 } as const;
const position = (value: number | null) => value ?? Number.MAX_SAFE_INTEGER;

/**
 * The structured reviews' fragment correspondences, one per distinct (aspect, original, Lean) triple with the weakest
 * relation any reviewer gave it, and where its Lean fragment is written inside `regions` of `source` (comments skipped).
 */
export function formalizationCorrespondences(evidence: FormalizationEvidence, source: string,
  regions: readonly SourceOffsets[]): WebFormalizationCorrespondence[] {
  const text = lineEnds(source), masked = maskLeanComments(text), original = evidence.request.statement;
  const merged = new Map<string, WebFormalizationCorrespondence>();
  for (const { review } of reviewsOf(evidence)) {
    if (!('correspondences' in review)) continue;
    for (const item of review.correspondences) {
      const key = JSON.stringify([item.aspect, item.originalFragment, item.candidateFragment]), found = merged.get(key);
      const explanation = item.explanation.trim();
      if (found) {
        found.reviewers++;
        if (relationRank[item.relation] > relationRank[found.relation]) found.relation = item.relation;
        if (explanation && !found.explanations.includes(explanation)) found.explanations.push(explanation);
        continue;
      }
      const at = original.indexOf(item.originalFragment), place = findWithin(masked, item.candidateFragment, regions);
      merged.set(key, { aspect: item.aspect, relation: item.relation, original: item.originalFragment,
        originalStart: at < 0 ? null : at, originalEnd: at < 0 ? null : at + item.originalFragment.length,
        leanText: item.candidateFragment, lean: place ? fileSpans(text, place) : [], reviewers: 1,
        explanations: explanation ? [explanation] : [] });
    }
  }
  const order = (aspect: string) => webFormalizationAspects.indexOf(aspect as typeof webFormalizationAspects[number]);
  return [...merged.values()].sort((a, b) => order(a.aspect) - order(b.aspect) || position(a.originalStart) - position(b.originalStart));
}

/** The comparison page's projection of approved (verified) formalization evidence. */
export function formalizationReport(evidence: FormalizationEvidence): WebFormalizationReport {
  const statement = lineEnds(evidence.candidate.source), environment = getLeanTaskEnvironment(evidence.request.environment);
  const masked = maskLeanComments(statement), regions = inspectLeanDeclarationRegions(masked);
  const declarations = inspectScopedLeanDeclarations(masked), original = evidence.request.statement;
  const targets = evidence.targets.map(target => {
    const index = declarations.findIndex(item => item.qualifiedName === target.name);
    if (index < 0) return { name: target.name, lines: { start: 1, end: count(statement, statement.length) + 1 } };
    const region = regions[index]!, end = statement.slice(0, region.endOffset).trimEnd().length;
    return { name: target.name, lines: { start: count(statement, region.startOffset) + 1, end: count(statement, Math.max(0, end - 1)) + 1 } };
  });
  const plan = evidence.workflow?.plan.output, quotes = (ids: readonly string[]) =>
    ids.flatMap(id => { const span = plan?.spans.find(item => item.id === id); return span ? [span.text] : []; });
  const { translation } = evidence;
  return { schema: 'theorem-os.web-formalization-report.v1', problemId: evidence.request.problemId, original, statement,
    environment: evidence.request.environment, toolchain: environment.toolchain, mathlibRevision: environment.mathlibRevision ?? null,
    targets, correspondences: formalizationCorrespondences(evidence, statement, [{ start: 0, end: statement.length }]),
    backtranslation: { mathematics: translation.mathematics, assumptions: translation.assumptions, definitions: translation.definitions,
      targets: translation.targets.map(item => ({ name: item.name, mathematics: item.mathematics })) },
    coverage: evidence.candidate.coverage.map(item => {
      const at = original.indexOf(item.originalText);
      return { original: item.originalText, originalStart: at < 0 ? null : at, targets: item.targetNames, explanation: item.explanation };
    }),
    ...plan ? { plan: { taskKind: plan.taskKind,
      conclusions: plan.conclusions.map(item => ({ mathematics: item.mathematics, targets: item.targetNames, quotes: quotes(item.spanIds) })),
      assumptions: plan.assumptions.map(item => ({ mathematics: item.mathematics, quotes: quotes(item.spanIds) })),
      definitions: plan.definitions.map(item => ({ mathematics: item.mathematics, names: item.leanNames, quotes: quotes(item.spanIds) })),
      unresolved: plan.unresolved.map(item => ({ description: item.description, quotes: quotes(item.spanIds) })) } } : {},
    reviews: reviewsOf(evidence).map(({ reviewer, review }) => 'correspondences' in review
      ? { reviewer, verdict: review.verdict, summary: review.summary,
        checks: Object.entries(review.checks).map(([name, value]) => ({ name, value })), issues: [],
        ...'fidelity' in review && review.fidelity ? { fidelity: review.fidelity.targets.map(item => ({ target: item.targetName,
          original: item.originalFragment, sourceClaim: item.sourceClaim, candidateClaim: item.candidateClaim })) } : {} }
      : { reviewer, verdict: review.verdict, summary: review.summary,
        checks: Object.entries(review.checks).map(([name, value]) => ({ name, value: String(value) })),
        issues: 'issues' in review ? review.issues : [] }),
    model: evidence.request.model, effort: evidence.request.effort, rounds: evidence.round,
    evidenceSha256: formalizationDigest(evidence), approvedAt: evidence.approvedAt };
}
