import path from 'node:path';
import { z } from 'zod';
import { assertMathRetrievalCorpus, searchMathRetrievalCorpusBatch, type MathRetrievalCorpus } from './mathRetrievalCorpus';
import { canonicalMathJson, mathDigest, readMathText } from './mathRuntimeIo';
import { assertMathCanonicalPath } from './paths';
import { getLeanTaskEnvironment } from './leanTaskEnvironment';
import { assertFormalizationPlanReady, type FormalizationPlan } from './formalizationPlan';
import { maskLeanCommentsAndStrings } from './leanSyntax';
import { assertLeanLibrarySymbols, leanLibrarySymbolsSchema, lookupLeanLibrarySymbols, type LeanLibrarySymbols } from './leanLibrarySymbols';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const relativeFile = z.string().min(1).refine(value => value.startsWith('.lake/packages/') &&
  !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..'));
const originSchema = z.object({ kind: z.enum(['object', 'definition']), id: z.string().min(1) }).strict();
const querySchema = z.object({ query: z.string().min(1).refine(value => Buffer.byteLength(value) <= 256),
  origins: z.array(originSchema).min(1), totalMatches: z.number().int().nonnegative(), truncated: z.boolean(),
  resultCount: z.number().int().nonnegative().max(15),
}).strict();
const occurrenceSchema = z.object({ queryIndex: z.number().int().nonnegative(),
  rank: z.number().int().positive().max(15), score: z.number().int().nonnegative() }).strict();
const hintSchema = z.object({
  name: z.string().min(1), qualifiedName: z.string().min(1), kind: z.string().min(1),
  sourceLine: z.number().int().positive(), sourceFile: relativeFile, sourceModule: z.string().min(1),
  sourceSha256: hash, packageName: z.literal('mathlib'), packageRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceHeader: z.string().max(800), headerTruncated: z.boolean(),
  sourceContext: z.string().max(2000), contextTruncated: z.boolean(),
  occurrences: z.array(occurrenceSchema).min(1),
}).strict();

const lexicalConfigurationSchema = z.object({
  schema: z.literal('theorem-os.formalization-retrieval-config.v1'),
  workspace: z.string().min(1).refine(value => path.isAbsolute(value) && path.resolve(value) === value),
  corpusSha256: hash, algorithm: z.literal('installed-lexical-v1-codepoint'),
  environmentDigest: hash, toolchain: z.string().min(1), mathlibRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceFiles: z.number().int().positive(),
}).strict();
const symbolConfigurationSchema = lexicalConfigurationSchema.extend({
  schema: z.literal('theorem-os.formalization-retrieval-config.v2'),
  symbolProtocol: z.literal('lean-exact-names-v1'),
}).strict();
export const formalizationRetrievalConfigurationSchema = z.discriminatedUnion('schema', [
  lexicalConfigurationSchema, symbolConfigurationSchema,
  symbolConfigurationSchema.extend({ schema: z.literal('theorem-os.formalization-retrieval-config.v3'),
    queryProtocol: z.literal('lean-resolved-objects-v1') }).strict(),
]);
export type FormalizationRetrievalConfiguration = z.infer<typeof formalizationRetrievalConfigurationSchema>;
export type FormalizationRetrievalSource = { workspace: string; corpusFile: string; symbolProtocol?: 'lean-exact-names-v1';
  queryProtocol?: 'lean-resolved-objects-v1' };

const lexicalRetrievalSchema = z.object({
  schema: z.literal('theorem-os.formalization-retrieval.v1'),
  algorithm: z.literal('installed-plan-lexical-blend-v1'),
  configurationDigest: hash, corpusSha256: hash, planDigest: hash, environmentDigest: hash,
  queries: z.array(querySchema), hints: z.array(hintSchema),
}).strict();
const symbolQuerySchema = z.object({ name: z.string().min(1), origins: z.array(originSchema).min(1) }).strict();
const symbolRetrievalSchema = lexicalRetrievalSchema.extend({ schema: z.literal('theorem-os.formalization-retrieval.v2'),
  algorithm: z.literal('installed-plan-lexical-symbols-v1'),
  librarySymbolQueries: z.array(symbolQuerySchema), librarySymbols: leanLibrarySymbolsSchema }).strict();
const omittedObjectQuerySchema = symbolQuerySchema.extend({ reason: z.literal('not-in-environment') }).strict();
export const formalizationRetrievalSchema = z.discriminatedUnion('schema', [
  lexicalRetrievalSchema, symbolRetrievalSchema,
  symbolRetrievalSchema.extend({ schema: z.literal('theorem-os.formalization-retrieval.v3'),
    algorithm: z.literal('installed-plan-resolved-objects-v1'),
    omittedObjectQueries: z.array(omittedObjectQuerySchema) }).strict(),
]);
export type FormalizationRetrieval = z.infer<typeof formalizationRetrievalSchema>;
type RetrievalOptions = { directory: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number;
  proofEnvironmentCacheRoot?: string; lookupSymbols?: typeof lookupLeanLibrarySymbols };

/** Validate the same pinned task environment before copying a manifest into a new run. */
export function prepareFormalizationRetrieval(input: FormalizationRetrievalSource, environment: 'standard' | 'mathlib') {
  if (environment !== 'mathlib') throw new Error('formalization_retrieval_requires_mathlib');
  if (input.queryProtocol && !input.symbolProtocol) throw new Error('formalization_retrieval_query_protocol_requires_symbols');
  const workspace = path.resolve(input.workspace), file = path.resolve(input.corpusFile);
  assertMathCanonicalPath(workspace); assertMathCanonicalPath(file);
  const corpusText = readMathText(file), corpus = JSON.parse(corpusText) as MathRetrievalCorpus;
  assertMathRetrievalCorpus(workspace, corpus);
  const config = getLeanTaskEnvironment(environment);
  const project = path.join(workspace, corpus.projectSubdirectory ?? '');
  if (Object.entries(config.files).some(([name, text]) => readMathText(path.join(project, name)) !== text) ||
      canonicalMathJson(corpus.scopes) !== canonicalMathJson(['mathlib']) ||
      corpus.sources.some(source => source.packageName !== 'mathlib' || source.packageRevision !== config.mathlibRevision))
    throw new Error('formalization_retrieval_environment_mismatch');
  return { corpusText, configuration: formalizationRetrievalConfigurationSchema.parse({
    schema: input.queryProtocol ? 'theorem-os.formalization-retrieval-config.v3' :
      input.symbolProtocol ? 'theorem-os.formalization-retrieval-config.v2' : 'theorem-os.formalization-retrieval-config.v1',
    ...(input.symbolProtocol ? { symbolProtocol: input.symbolProtocol } : {}),
    ...(input.queryProtocol ? { queryProtocol: input.queryProtocol } : {}), workspace, corpusSha256: mathDigest(corpusText),
    algorithm: corpus.algorithm, environmentDigest: config.dependencyDigest, toolchain: config.toolchain,
    mathlibRevision: config.mathlibRevision, sourceFiles: corpus.sources.length,
  }) };
}

// Keep each complete token when it fits. Long names are split by Unicode code point,
// so every part remains a legal query for the existing 256-byte lexical interface.
function queryParts(value: string): string[] {
  const parts: string[] = [];
  let part = '';
  for (const character of value) {
    if (Buffer.byteLength(part + character) > 256) { parts.push(part); part = ''; }
    part += character;
  }
  if (part) parts.push(part);
  return parts;
}

function planNameCandidates(plan: FormalizationPlan) {
  const candidates: { name: string; origin: z.infer<typeof originSchema> }[] = [];
  const add = (name: string, origin: z.infer<typeof originSchema>) => candidates.push({ name, origin });
  // Known library names are more specific than individual type words.
  for (const definition of plan.definitions) if (definition.implementation === 'existing')
    for (const name of definition.leanNames) add(name, { kind: 'definition', id: definition.id });
  const ignored = new Set(['Type', 'Prop', 'Sort', 'forall', 'fun', 'let', 'in', 'by']);
  const aliases: Record<string, string> = { 'ℕ': 'Nat', 'ℤ': 'Int', 'ℚ': 'Rat', 'ℝ': 'Real', 'ℂ': 'Complex' };
  for (const object of plan.objects) {
    const type = maskLeanCommentsAndStrings(object.leanType);
    const bound = new Set([...type.matchAll(/(?:[({⦃]|\bforall\s+|∀\s*)([\p{L}\p{N}_'\s]+)\s*:/gu)]
      .flatMap(match => match[1].trim().split(/\s+/u)));
    for (const token of type.match(/[\p{L}_][\p{L}\p{M}\p{N}_'.]*/gu) ?? [])
      if (!ignored.has(token) && !bound.has(token)) add(aliases[token] ?? token, { kind: 'object', id: object.id });
  }
  return candidates;
}

function planQueries(plan: FormalizationPlan, includedNames?: ReadonlySet<string>) {
  const queries: { query: string; origins: z.infer<typeof originSchema>[] }[] = [];
  const byQuery = new Map<string, typeof queries[number]>();
  for (const { name, origin } of planNameCandidates(plan)) {
    if (includedNames && !includedNames.has(name)) continue;
    for (const query of queryParts(name)) {
      if (!/[\p{L}\p{N}]/u.test(query)) continue;
      const key = query.toLowerCase(), existing = byQuery.get(key);
      if (existing) {
        if (!existing.origins.some(item => item.kind === origin.kind && item.id === origin.id)) existing.origins.push(origin);
      } else { const entry = { query, origins: [origin] }; queries.push(entry); byQuery.set(key, entry); }
    }
  }
  return queries;
}

// Explicit plan mappings keep their lexical fallback. Object-only words must
// resolve as constants before they can consume source-search results.
function resolvedObjectQueries(queries: z.infer<typeof symbolQuerySchema>[], symbols: LeanLibrarySymbols) {
  const byName = new Map(symbols.symbols.map(symbol => [symbol.name, symbol]));
  const includedNames = new Set<string>(), omittedObjectQueries: z.infer<typeof omittedObjectQuerySchema>[] = [];
  for (const query of queries) {
    if (query.origins.some(origin => origin.kind === 'definition') || byName.get(query.name)?.exists)
      includedNames.add(query.name);
    else omittedObjectQueries.push({ ...query, reason: 'not-in-environment' });
  }
  return { includedNames, omittedObjectQueries };
}

async function retrievePlanSymbols(plan: FormalizationPlan, options?: RetrievalOptions) {
  if (!options) throw new Error('formalization_retrieval_symbols_options_required');
  options.signal?.throwIfAborted();
  const librarySymbolQueries = planSymbolQueries(plan);
  const librarySymbols = await (options.lookupSymbols ?? lookupLeanLibrarySymbols)(options.directory,
    librarySymbolQueries.map(query => query.name), 'mathlib', options);
  assertLeanLibrarySymbols('mathlib', librarySymbolQueries.map(query => query.name), librarySymbols);
  return { librarySymbolQueries, librarySymbols };
}

// Lean names are case-sensitive and must be queried whole, independently of
// the lexical search interface's case folding and 256-byte query splitting.
function planSymbolQueries(plan: FormalizationPlan) {
  const queries: z.infer<typeof symbolQuerySchema>[] = [], byName = new Map<string, typeof queries[number]>();
  for (const { name, origin } of planNameCandidates(plan)) {
    const existing = byName.get(name);
    if (existing) {
      if (!existing.origins.some(item => item.kind === origin.kind && item.id === origin.id)) existing.origins.push(origin);
    } else { const entry = { name, origins: [origin] }; queries.push(entry); byName.set(name, entry); }
  }
  return queries;
}

/**
 * Assemble verified library hints after planning. All queries run, in batches of
 * eight; the existing searcher's result/byte truncation remains explicit.
 */
export async function retrieveFormalizationPlan(directory: string, configuration: FormalizationRetrievalConfiguration,
  plan: FormalizationPlan, options?: RetrievalOptions): Promise<FormalizationRetrieval> {
  assertFormalizationPlanReady(plan);
  const file = path.join(directory, 'retrieval-corpus.json'); assertMathCanonicalPath(file);
  const text = readMathText(file);
  if (mathDigest(text) !== configuration.corpusSha256) throw new Error('formalization_retrieval_corpus_changed');
  const corpus = JSON.parse(text) as MathRetrievalCorpus;
  let symbols: Awaited<ReturnType<typeof retrievePlanSymbols>> | undefined;
  let selection: ReturnType<typeof resolvedObjectQueries> | undefined;
  if (configuration.schema === 'theorem-os.formalization-retrieval-config.v3') {
    assertMathRetrievalCorpus(configuration.workspace, corpus);
    symbols = await retrievePlanSymbols(plan, options);
    selection = resolvedObjectQueries(symbols.librarySymbolQueries, symbols.librarySymbols);
  }
  const queries = planQueries(plan, selection?.includedNames);
  const lists: ReturnType<typeof searchMathRetrievalCorpusBatch>['queries'] = [];
  if (!queries.length) assertMathRetrievalCorpus(configuration.workspace, corpus);
  for (let offset = 0; offset < queries.length; offset += 8) {
    const batch = searchMathRetrievalCorpusBatch(configuration.workspace, corpus,
      queries.slice(offset, offset + 8).map(item => item.query));
    lists.push(...batch.queries);
  }
  const sourceIdentities = new Map(corpus.sources.map(source => [corpus.packageSourceRoot
    ? path.join(corpus.packageSourceRoot, source.identity.path.slice('.lake/packages/'.length))
    : corpus.projectSubdirectory ? `${corpus.projectSubdirectory}/${source.identity.path}` : source.identity.path, source]));
  const hints: FormalizationRetrieval['hints'] = [], seen = new Map<string, FormalizationRetrieval['hints'][number]>();
  // Adapted from LeanAide PromptBuilder.fromBlend/blended (Apache-2.0),
  // 856babc; changed to preserve provenance and deduplicate after interleaving.
  // See third_party/LeanAide-LICENSE.txt for attribution and full license terms.
  for (let rank = 0; lists.some(list => rank < list.results.length); rank++) {
    for (const [queryIndex, list] of lists.entries()) {
      const match = list.results[rank];
      if (!match) continue;
      const source = sourceIdentities.get(match.sourceFile);
      if (!source) throw new Error('formalization_retrieval_source_unbound');
      const key = `${source.identity.path}\0${match.sourceLine}\0${match.qualifiedName}`;
      const occurrence = { queryIndex, rank: rank + 1, score: match.score };
      const previous = seen.get(key);
      if (previous) { previous.occurrences.push(occurrence); continue; }
      const { score: _score, sourceFile: _file, ...header } = match;
      const hint = { ...header, sourceFile: source.identity.path, sourceSha256: source.identity.sha256,
        packageName: 'mathlib' as const, packageRevision: source.packageRevision!, occurrences: [occurrence] };
      seen.set(key, hint); hints.push(hint);
    }
  }
  const lexical = { schema: 'theorem-os.formalization-retrieval.v1',
    algorithm: 'installed-plan-lexical-blend-v1', configurationDigest: mathDigest(canonicalMathJson(configuration)),
    corpusSha256: configuration.corpusSha256, planDigest: mathDigest(canonicalMathJson(plan)),
    environmentDigest: configuration.environmentDigest,
    queries: queries.map((query, index) => ({ ...query, totalMatches: lists[index]!.totalMatches,
      truncated: lists[index]!.truncated, resultCount: lists[index]!.results.length })), hints };
  let packet: unknown = lexical;
  if (configuration.schema === 'theorem-os.formalization-retrieval-config.v2') {
    symbols = await retrievePlanSymbols(plan, options);
    packet = { ...lexical, schema: 'theorem-os.formalization-retrieval.v2', algorithm: 'installed-plan-lexical-symbols-v1',
      ...symbols };
  } else if (configuration.schema === 'theorem-os.formalization-retrieval-config.v3') {
    packet = { ...lexical, schema: 'theorem-os.formalization-retrieval.v3', algorithm: 'installed-plan-resolved-objects-v1',
      ...symbols, omittedObjectQueries: selection!.omittedObjectQueries };
  }
  const result = formalizationRetrievalSchema.parse(packet);
  assertFormalizationRetrieval(configuration, plan, result);
  return result;
}

/** Offline integrity checks; headers remain lookup hints, never acceptance evidence. */
export function assertFormalizationRetrieval(configuration: FormalizationRetrievalConfiguration,
  plan: FormalizationPlan, value: FormalizationRetrieval): void {
  const fail = () => { throw new Error('formalization_retrieval_input_mismatch'); };
  const parsed = formalizationRetrievalSchema.safeParse(value);
  if (!parsed.success) return fail();
  const result = parsed.data;
  let selection: ReturnType<typeof resolvedObjectQueries> | undefined;
  if (configuration.schema !== 'theorem-os.formalization-retrieval-config.v1') {
    const expected = configuration.schema === 'theorem-os.formalization-retrieval-config.v3'
      ? 'theorem-os.formalization-retrieval.v3' : 'theorem-os.formalization-retrieval.v2';
    if (result.schema === 'theorem-os.formalization-retrieval.v1' || result.schema !== expected ||
        canonicalMathJson(result.librarySymbolQueries) !== canonicalMathJson(planSymbolQueries(plan))) return fail();
    assertLeanLibrarySymbols('mathlib', result.librarySymbolQueries.map(query => query.name), result.librarySymbols);
    if (result.librarySymbols.environmentDigest !== configuration.environmentDigest ||
        result.librarySymbols.toolchain !== configuration.toolchain || result.librarySymbols.mathlibRevision !== configuration.mathlibRevision) return fail();
    if (result.schema === 'theorem-os.formalization-retrieval.v3') {
      selection = resolvedObjectQueries(result.librarySymbolQueries, result.librarySymbols);
      if (canonicalMathJson(result.omittedObjectQueries) !== canonicalMathJson(selection.omittedObjectQueries)) return fail();
    }
  } else if (result.schema !== 'theorem-os.formalization-retrieval.v1') return fail();
  if (result.configurationDigest !== mathDigest(canonicalMathJson(configuration)) ||
      result.corpusSha256 !== configuration.corpusSha256 || result.environmentDigest !== configuration.environmentDigest ||
      result.planDigest !== mathDigest(canonicalMathJson(plan)) ||
      canonicalMathJson(result.queries.map(({ query, origins }) => ({ query, origins }))) !== canonicalMathJson(planQueries(plan, selection?.includedNames))) return fail();
  const seen = new Set<string>(), occurrences = new Map<string, number>();
  const firstPositions: number[] = [];
  for (const hint of result.hints) {
    const key = `${hint.sourceFile}\0${hint.sourceLine}\0${hint.qualifiedName}`;
    if (seen.has(key) || hint.packageRevision !== configuration.mathlibRevision ||
        !hint.sourceFile.startsWith('.lake/packages/mathlib/')) return fail();
    seen.add(key);
    const queryIndexes = new Set<number>();
    for (const occurrence of hint.occurrences) {
      const query = result.queries[occurrence.queryIndex];
      const position = (occurrence.rank - 1) * result.queries.length + occurrence.queryIndex;
      if (!query || occurrence.rank > query.resultCount || queryIndexes.has(occurrence.queryIndex) || occurrences.has(String(position))) return fail();
      queryIndexes.add(occurrence.queryIndex); occurrences.set(String(position), position);
    }
    const positions = hint.occurrences.map(item => (item.rank - 1) * result.queries.length + item.queryIndex);
    if (positions.some((position, index) => index > 0 && position <= positions[index - 1]!)) return fail();
    firstPositions.push(positions[0]!);
  }
  if (firstPositions.some((position, index) => index > 0 && position <= firstPositions[index - 1]!)) return fail();
  for (const [index, query] of result.queries.entries()) {
    if (query.resultCount > query.totalMatches || query.truncated !== (query.resultCount < query.totalMatches)) return fail();
    for (let rank = 1; rank <= query.resultCount; rank++) if (!occurrences.has(String((rank - 1) * result.queries.length + index))) return fail();
  }
}
