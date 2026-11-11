import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import type { TheoremKnowledgeBase } from './theoremKnowledge';
import { mathematicalGapSchema } from './mathematicalGapContract';
import { largestFittingPage, splitsSurrogate } from './textPage';
import { knowledgeRelevanceGroups, knowledgeRelevanceTerms, knowledgeRequestBatch, knowledgeTypeExpression } from './theoremKnowledgeSearch';
import { knowledgeResidualViews, splitStatement } from './theoremKnowledgeGoal';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1).max(1_000_000);
const contract = z.object({
  kind: z.enum(['research', 'sketch', 'lemma', 'goal']),
  statement: text,
  statementKind: z.enum(['research-objective', 'closed-task-type', 'source-header']),
  premises: z.array(z.string().max(12_000)).max(128),
}).strict();
const scope = z.object({
  problemId: z.string().min(1), problemReceiptDigest: hash, environmentDigest: z.string().min(1),
  source: contract, dependencies: z.array(contract).max(1024), originalConsumer: contract.optional(),
}).strict();
const provenance = z.object({
  source: z.string().min(1), sourceDigest: hash, runId: z.string().min(1),
  taskId: z.string().min(1), taskDigest: hash, groupId: z.string().min(1),
  deliveryId: z.string().min(1), sourceCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
  findingDigest: hash, notesDigest: hash,
}).strict();
const finding = z.object({
  evidence: z.literal('recorded-advisory-not-replayed'), acceptance: z.literal('not-assessed'),
  conclusion: z.enum(['supporting', 'refuted', 'inconclusive']),
  summary: text, finding: text, notes: text, scope,
  evidenceRefs: z.array(z.string().max(2000)).max(256),
  obstructions: z.array(z.object({ mechanism: z.string().min(1).max(500), scope: z.string().min(1).max(2000),
    evidenceRefs: z.array(z.string().max(2000)).max(256) }).strict()).max(256),
  remainingObligations: z.array(z.string().max(12_000)).max(256),
  /** Exact recorded text only; these conditions do not authorize scheduling or reopening. */
  reconsiderWhen: z.array(z.string().max(12_000)).max(256),
  mathematicalGap: mathematicalGapSchema.optional(),
}).strict();

export const knowledgeRouteFindingSchema = finding.extend({ id: hash, scopeDigest: hash,
  provenance: z.array(provenance).min(1).max(4096) }).strict();
export type KnowledgeRouteContract = z.infer<typeof contract>;
export type KnowledgeRouteFinding = z.infer<typeof knowledgeRouteFindingSchema>;
export type KnowledgeRouteFindingCandidate = z.infer<typeof finding> & { provenance: z.infer<typeof provenance> };

/** Run-local task names never enter the recorded mathematical scope identity. */
export function knowledgeRouteScopeDigest(value: KnowledgeRouteFinding['scope']): string {
  return mathDigest(canonicalMathJson({ ...value,
    dependencies: [...value.dependencies].sort((a, b) => canonicalMathJson(a).localeCompare(canonicalMathJson(b))) }));
}
const identity = (value: Omit<KnowledgeRouteFinding, 'id' | 'provenance'>) => mathDigest(canonicalMathJson(value));

/** Advisory research is kept separate from checked declarations and cannot supply an acceptance receipt. */
export function buildKnowledgeRouteFindings(candidates: readonly KnowledgeRouteFindingCandidate[],
  previous: readonly KnowledgeRouteFinding[] = []): KnowledgeRouteFinding[] {
  validateKnowledgeRouteFindings(previous);
  const entries = new Map(previous.map(item => [item.id, structuredClone(item)]));
  for (const candidate of candidates) {
    const { provenance: origin, ...raw } = candidate;
    const details = finding.parse(raw); provenance.parse(origin);
    const scopeDigest = knowledgeRouteScopeDigest(details.scope), value = { ...details, scopeDigest };
    const id = identity(value), existing = entries.get(id);
    if (existing) {
      if (!existing.provenance.some(item => canonicalMathJson(item) === canonicalMathJson(origin))) existing.provenance.push(origin);
    } else entries.set(id, { ...value, id, provenance: [origin] });
  }
  const result = [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const item of result) item.provenance.sort((a, b) => canonicalMathJson(a).localeCompare(canonicalMathJson(b)));
  validateKnowledgeRouteFindings(result);
  return result;
}

export function validateKnowledgeRouteFindings(entries: readonly KnowledgeRouteFinding[]): void {
  const ids = new Set<string>();
  for (const value of entries) {
    const parsed = knowledgeRouteFindingSchema.safeParse(value);
    if (!parsed.success) throw new Error('math_knowledge_finding_schema_invalid');
    const { id, provenance: origins, ...details } = parsed.data;
    if (ids.has(id) || identity(details) !== id || knowledgeRouteScopeDigest(details.scope) !== details.scopeDigest)
      throw new Error('math_knowledge_finding_identity_changed');
    if (origins.some(origin => origin.findingDigest !== mathDigest(details.finding) || origin.notesDigest !== mathDigest(details.notes)))
      throw new Error('math_knowledge_finding_source_changed');
    ids.add(id);
  }
}

type SearchBase = Pick<TheoremKnowledgeBase, 'routeFindings'>;
export type KnowledgeRouteFindingSearchOptions = {
  goal?: string; limit?: number; problemId?: string; environmentDigest?: string; problemReceiptDigest?: string;
  /** Automatic context admission only; manual searches retain their broad lexical recall. */
  requireMathematicalRelevance?: boolean;
};
export type KnowledgeRouteFindingSearchRequest = { query: string; goal?: string };
const lexicalTerms = (value: string) => [...new Set(value.toLowerCase().match(/[\p{L}\p{N}_']{2,}/gu) ?? [])];
const preview = (value: string, max: number) => value.length <= max ? value : value.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…';
// Stand-alone workflow words and broad mathematical qualifiers cannot be independent topic
// anchors. Keep compound identifiers intact (FixedPoint, UpperBound, IsTestFunction), and
// leave manual lexical recall unchanged.
const genericFindingWords = new Set(['fixed', 'proposed', 'data', 'application', 'applications', 'scratch', 'tmp',
  'deliverable', 'deliverables', 'harness', 'probe', 'probes', 'docstring', 'docstrings', 'header', 'headers', 'generated',
  'host', 'module', 'modules', 'problem', 'cross', 'jsonl', 'never', 'declarations', 'id', 'each', 'intended',
  'inference', 'material', 'premise', 'identify', 'giving', 'supply', 'write', 'over', 'consistent', 'reproduce',
  'reproduces', 'construction', 'construct', 'sufficient', 'validate', 'valid', 'constant', 'constants',
  'bound', 'bounds', 'upper', 'lower', 'estimate', 'estimates', 'identity', 'identities', 'range', 'set', 'below', 'above']);
const findingRelevanceText = (value: string) => value.replace(/[\p{L}_][\p{L}\p{M}\p{N}_']*/gu,
  name => genericFindingWords.has(name.toLowerCase()) ? ' ' : name);

/** Carrier declarations and instance assumptions do not identify a finding's mathematical subject. */
function statementSubject(value: string): string {
  const shape = splitStatement(value);
  return shape ? [...shape.parts.filter(part => !part.binder).map(part => part.key), shape.conclusion].join('\n') : value;
}

function validateFindingQuery(query: string, options: KnowledgeRouteFindingSearchOptions) {
  const limit = options.limit ?? 10;
  if (typeof query !== 'string' || Buffer.byteLength(query) > 4000 ||
      (options.goal !== undefined && (typeof options.goal !== 'string' || Buffer.byteLength(options.goal) > 16000)) ||
      (!query.trim() && !options.goal?.trim()) || !Number.isSafeInteger(limit) || limit < 1 || limit > 32 ||
      [options.problemId, options.environmentDigest, options.problemReceiptDigest].some(value => value !== undefined &&
        (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 256)))
    throw new Error('math_knowledge_invalid_query');
}

function prepareFindingSearch(base: SearchBase, options: Omit<KnowledgeRouteFindingSearchOptions, 'goal'>) {
  const documents = (base.routeFindings ?? []).filter(item => !options.problemId || item.scope.problemId === options.problemId)
    .map(item => {
      const contracts = [item.scope.source, ...item.scope.dependencies, ...(item.scope.originalConsumer ? [item.scope.originalConsumer] : [])];
      const statements = contracts.map(contract => contract.statement), summary = item.summary;
      const subjects = contracts.map((contract, index) => contract.statementKind === 'research-objective' ? statements[index]! :
        statementSubject(knowledgeTypeExpression({ type: statements[index]!, typeKind: contract.statementKind })));
      const scope = new Set(knowledgeRelevanceTerms(findingRelevanceText(subjects.join('\n')), true));
      return { item, statements, scope, summary: new Set(knowledgeRelevanceTerms(findingRelevanceText(summary))),
        lexical: new Set(lexicalTerms([...statements, summary].join('\n'))) };
    });
  const frequencies = new Map<string, number>();
  for (const document of documents) for (const term of new Set([...document.scope, ...document.summary]))
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  return { documents, frequencies };
}

/** Retrieval can recall a renamed task, but text matches never establish equivalent hypotheses or invalidate a route. */
export function searchKnowledgeRouteFindings(base: SearchBase, query: string,
  options: KnowledgeRouteFindingSearchOptions = {}) {
  return searchKnowledgeRouteFindingRequests(base, [{ query, goal: options.goal }], options)[0]!;
}

/** Share text preparation for this call only; exact goals, ranking and result objects remain separate. */
export function searchKnowledgeRouteFindingRequests(base: SearchBase, requests: readonly KnowledgeRouteFindingSearchRequest[],
  options: Omit<KnowledgeRouteFindingSearchOptions, 'goal'> = {}) {
  return knowledgeRequestBatch(requests, (query, goal) => validateFindingQuery(query, { ...options, goal }), () => {
    const prepared = prepareFindingSearch(base, options);
    return (query, goal) => searchPreparedFindings(prepared, query, { ...options, goal });
  });
}

function searchPreparedFindings(prepared: ReturnType<typeof prepareFindingSearch>, query: string,
  options: KnowledgeRouteFindingSearchOptions) {
  const limit = options.limit ?? 10;
  const text = query + '\n' + (options.goal ?? '');
  const subject = findingRelevanceText(query + '\n' + (options.goal ? knowledgeResidualViews(options.goal)
    .map(view => statementSubject(view.goal)).join('\n') : ''));
  const inputs = options.requireMathematicalRelevance ? knowledgeRelevanceTerms(subject, !query.trim()) : lexicalTerms(text);
  const groups = options.requireMathematicalRelevance ? knowledgeRelevanceGroups(subject, !query.trim()) : [];
  const weight = (term: string) => 1 + Math.log((prepared.documents.length + 1) / (1 + (prepared.frequencies.get(term) ?? 0)));
  const inputWeight = inputs.reduce((sum, term) => sum + weight(term), 0);
  const coverage = (matches: readonly string[]) => inputWeight ? matches.reduce((sum, term) => sum + weight(term), 0) / inputWeight : 0;
  const hits = prepared.documents.flatMap(({ item, statements, scope, summary, lexical }) => {
    const scoped = inputs.filter(value => scope.has(value));
    const matched = inputs.filter(value => options.requireMathematicalRelevance ? scope.has(value) || summary.has(value) : lexical.has(value));
    const exactStatement = Boolean(options.goal && statements.includes(options.goal));
    // Long notes must not enter a bounded packet merely because they share work instructions
    // or a carrier type. Exact historical contracts and focused one-word searches remain available.
    const minimum = Math.min(groups.length, query.trim() && groups.length >= 8 ? 3 : 2),
      scopedGroups = groups.filter(group => group.every(term => scope.has(term))),
      matchedGroups = groups.filter(group => group.every(term => scope.has(term) || summary.has(term)));
    if (!exactStatement && (options.requireMathematicalRelevance ? !minimum || scopedGroups.length < minimum &&
        (matchedGroups.length < minimum || coverage(matched) < 0.5) : !matched.length)) return [];
    const environmentMatch = options.environmentDigest === undefined ? 'unknown' :
      item.scope.environmentDigest === options.environmentDigest ? 'match' : 'different';
    const problemReceiptMatch = options.problemReceiptDigest === undefined ? 'unknown' :
      item.scope.problemReceiptDigest === options.problemReceiptDigest ? 'match' : 'different';
    return [{ id: item.id, scopeDigest: item.scopeDigest, conclusion: item.conclusion, summary: preview(item.summary, 1200),
      problemId: item.scope.problemId, environmentMatch, problemReceiptMatch,
      statementMatch: exactStatement ? 'exact-recorded-text' as const : 'lexical-only' as const,
      scopeMatch: exactStatement && environmentMatch === 'match' && problemReceiptMatch === 'match'
        ? 'statement-and-recorded-environment' as const : 'not-established' as const,
      evidence: item.evidence, acceptance: item.acceptance,
      score: (options.requireMathematicalRelevance ? 80 * coverage(scoped) ** 2 + 20 * coverage(matched) ** 2 : matched.length) +
        (exactStatement ? 1000 : 0),
      matched, requiresScopeReview: true as const,
      readWith: { command: 'knowledge finding', id: item.id } }];
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { schema: 'theorem-os.knowledge-route-search.v1' as const, evidence: 'recorded-advisory-not-replayed' as const,
    acceptance: 'not-assessed' as const, advisoryOnly: true as const, total: hits.length, hits: hits.slice(0, limit) };
}

/** The complete note and exact input contracts remain available without installing historical proof sources. */
export function getKnowledgeRouteFinding(base: SearchBase, id: string) {
  const entry = base.routeFindings?.find(item => item.id === id);
  if (!entry) throw new Error('math_knowledge_finding_not_found');
  validateKnowledgeRouteFindings([entry]);
  return { schema: 'theorem-os.knowledge-route-finding.v1' as const, advisoryOnly: true as const,
    reuse: 'Review the exact assumptions, evidence and reconsideration conditions. A recorded refutation does not refute the original theorem or authorize parking a task. Recheck local Lean claims in the current environment.',
    ...entry };
}

/** Exact JSON pages keep long arguments readable without silently dropping their assumptions or evidence. */
export function getKnowledgeRouteFindingPage(base: SearchBase, id: string,
  options: { startOffset?: number; maxBytes?: number } = {}) {
  const { startOffset: begin = 0, maxBytes = 16000 } = options;
  if (!Number.isSafeInteger(begin) || begin < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 65536)
    throw new Error('math_knowledge_finding_options_invalid');
  const entry = getKnowledgeRouteFinding(base, id), source = canonicalMathJson(entry);
  if (begin > source.length || splitsSurrogate(source, begin)) throw new Error('math_knowledge_finding_position_invalid');
  const sha256 = mathDigest(source), bytes = Buffer.byteLength(source);
  const packet = (end: number) => ({ schema: 'theorem-os.knowledge-route-finding-page.v1' as const, id: entry.id,
    scopeDigest: entry.scopeDigest, evidence: entry.evidence, acceptance: entry.acceptance, advisoryOnly: true as const,
    sha256, bytes, offsetEncoding: 'utf16-code-unit' as const, endOffsetExclusive: true as const,
    display: { startOffset: begin, endOffset: end, bytes: Buffer.byteLength(source.slice(begin, end)) },
    text: source.slice(begin, end), truncated: end < source.length, ...(end < source.length ? { nextOffset: end } : {}) });
  return largestFittingPage(source, begin, source.length, maxBytes, packet, 'math_knowledge_finding_budget_too_small', true);
}
