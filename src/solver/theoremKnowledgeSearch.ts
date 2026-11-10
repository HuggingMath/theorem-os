import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { maskLeanCommentsAndStrings } from '../math/leanSyntax';
import { knowledgeGoalSurfaceShape, knowledgeResidualViews, splitStatement } from './theoremKnowledgeGoal';
import type { TheoremKnowledgeBase, TheoremKnowledgeEntry } from './theoremKnowledge';
import { createKnowledgeRelationIndex, type KnowledgeRelation } from './theoremKnowledgeRelations';

export type KnowledgeSearchOptions = {
  goal?: string; limit?: number; problemId?: string; environmentDigest?: string; problemReceiptDigest?: string;
  /** Display diversity only; declaration identities and contextual versions remain separate. */
  displayGrouping?: 'exact-interface';
  /** Select distinct source modules before applying the result limit; keep each module's best declaration. */
  resultGrouping?: 'module';
};
export type KnowledgeSearchRequest = { query: string; goal?: string };
type KnowledgeSearchBase = Pick<TheoremKnowledgeBase, 'entries' | 'evidence'> & Partial<Pick<TheoremKnowledgeBase, 'contexts'>>;
type PreferenceMatch = 'match' | 'different' | 'unknown' | 'not-requested';
const boilerplate = new Set(['submission', 'helpers', 'helper', 'theorem', 'lemma', 'def', 'abbrev', 'opaque',
  'by', 'fun', 'type', 'prop', 'sort', 'forall', 'exists', 'let', 'in', 'have', 'show',
  'the', 'a', 'an', 'to', 'from', 'of', 'for', 'with', 'this', 'that', 'and', 'or', 'is',
  'it', 'its', 'their', 'they', 'them', 'our', 'your', 'which', 'whose', 'where',
  'be', 'been', 'being', 'are', 'was', 'were', 'has', 'had', 'does', 'did',
  'would', 'should', 'could', 'will', 'please', 'find', 'need', 'want', 'looking']);
const aliases: Readonly<Record<string, string>> = {
  'ℝ≥0∞': 'ENNReal', 'ℝ≥0': 'NNReal', 'ℝ': 'Real', 'ℕ': 'Nat', 'ℤ': 'Int', 'ℚ': 'Rat', 'ℂ': 'Complex',
  '∀': 'forall ', '∃': 'exists ', '↔': ' iff ', '<->': ' iff ', '→': ' arrow ', '->': ' arrow ',
  '¬': ' not ', '∧': ' and ', '∨': ' or ', '≤': ' le ', '<=': ' le ', '≥': ' ge ', '>=': ' ge ',
  '≠': ' ne ', '!=': ' ne ', '∈': ' mem ', '∑': ' sum ', '∏': ' prod ',
};
const leanText = (value: string) => (/--|\/-|"/u.test(value) ? maskLeanCommentsAndStrings(value) : value)
  .replace(/\b_root_\./gu, '').replace(/ℝ≥0∞|ℝ≥0|[ℝℕℤℚℂ∀∃↔→¬∧∨≤≥≠∈∑∏]|<->|->|<=|>=|!=/gu, match => aliases[match]!);
const canonical = (value: string) => leanText(value).toLowerCase().replace(/\s+/gu, '');
const termAliases = new Map([['pderiv', ['partial', 'derivative', 'derivatives']]]);

function terms(value: string, binders = false): string[] {
  return textTerms(leanText(value), binders);
}

function textTerms(text: string, binders: boolean): string[] {
  const bound = new Set<string>();
  if (binders) {
    for (const match of text.matchAll(/(?:[([{]|\bforall\b|\bexists\b|^|\n)\s*([\p{L}_][\p{L}\p{M}\p{N}_' \t]*?)\s*:/gu))
      for (const name of match[1]!.trim().split(/\s+/u)) bound.add(name);
  }
  const result = new Set<string>();
  for (const match of text.matchAll(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_'.]*/gu)) {
    for (const segment of match[0].split('.').filter(part => !bound.has(part))) {
      const pieces = segment.replace(/([a-z])([A-Z])/gu, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2').split(/[_\s]+/u);
      for (const token of [...pieces, ...(pieces.length > 1 && !segment.includes('_') ? [segment] : [])]) {
        const lower = token.toLowerCase();
        if (lower && !boilerplate.has(lower) && (lower.length > 1 || /[\p{N}]|[^\x00-\x7f]/u.test(lower))) {
          result.add(lower);
          for (const alias of termAliases.get(lower) ?? []) result.add(alias);
        }
      }
    }
  }
  return [...result];
}

export function knowledgeTypeExpression(item: Pick<TheoremKnowledgeEntry, 'type' | 'typeKind'>): string {
  if (item.typeKind !== 'source-header') return item.type;
  const header = item.type.replace(/^(?:(?:theorem|lemma|def|abbrev|opaque)\s+)?[\p{L}_][\p{L}\p{M}\p{N}_'.]*\s*/u, '');
  let depth = 0;
  for (let index = 0; index < header.length; index++) {
    const character = header[index]!;
    if ('([{'.includes(character)) depth++;
    else if (')]}'.includes(character)) depth--;
    else if (character === ':' && depth === 0) {
      const binders = header.slice(0, index).trim(), body = header.slice(index + 1).trim();
      return binders ? `forall ${binders}, ${body}` : body;
    }
  }
  return item.type;
}

function goalTarget(value: string): string {
  const views = knowledgeResidualViews(value);
  return views.length === 1 ? views[0]!.target : views.map(view => view.target).join('\n');
}

/** Premises remain in the full goal score; its primary terms describe the conclusion being proved. */
function conclusion(value: string): string {
  const shape = splitStatement(value);
  return shape ? shape.conclusion.replace(/\b_b\d+\b/gu, '') : value;
}

function goalShape(value: string) {
  const views = knowledgeResidualViews(value);
  return views.length === 1 ? knowledgeGoalSurfaceShape(views[0]!.goal) : undefined;
}

/** A retrieval hint may be useful to a model without warranting an automatic theorem application. */
export function knowledgeApplicationRelevant(item: TheoremKnowledgeEntry, goal: string): boolean {
  const type = knowledgeTypeExpression(item), normalizedGoal = canonical(goalTarget(goal)), normalizedType = canonical(type);
  if (normalizedGoal && (normalizedGoal === normalizedType ||
      normalizedGoal.length >= 8 && normalizedType.endsWith(normalizedGoal))) return true;
  const surface = goalShape(goal);
  if (surface !== undefined && surface === knowledgeGoalSurfaceShape(type)) return true;
  // Reuse the ranker's conclusion terms and name/type fields. Built-in arithmetic normal forms can
  // differ definitionally (`n = n` versus `n + 0 = n`, or `n + 1` versus `Nat.succ n`).
  const arithmetic = new Set(['nat', 'int', 'rat', 'real', 'complex', 'ennreal', 'nnreal', 'succ', 'pred']);
  const required = terms(conclusion(goalTarget(goal)), true)
    .filter(term => !/^\p{N}+$/u.test(term) && !arithmetic.has(term));
  const available = new Set([...terms(item.name), ...terms(conclusion(type), true)]);
  return required.every(term => available.has(term));
}

export function knowledgeSearchGroup(item: TheoremKnowledgeEntry): string {
  return mathDigest(canonicalMathJson({ name: item.name, type: item.type, typeKind: item.typeKind, declaration: item.declaration }));
}

const knowledgeInterfaceGroup = (item: TheoremKnowledgeEntry): string =>
  mathDigest(canonicalMathJson({ name: item.name, type: item.type, typeKind: item.typeKind }));

function preference(requested: string | undefined, recorded: readonly (string | undefined)[]): PreferenceMatch {
  if (requested === undefined) return 'not-requested';
  const known = recorded.filter((value): value is string => Boolean(value));
  return known.includes(requested) ? 'match' : known.length ? 'different' : 'unknown';
}

export function knowledgeVersionSummary(item: TheoremKnowledgeEntry, options: KnowledgeSearchOptions = {}) {
  return { id: item.id, contextDigest: item.contextDigest, environmentDigest: item.environmentDigest,
    problemIds: [...new Set(item.provenance.map(origin => origin.problemId))].sort(),
    sourceKinds: [...new Set(item.provenance.map(origin => origin.kind))].sort(),
    problemReceiptDigests: [...new Set(item.provenance.map(origin => origin.problemReceiptDigest).filter(Boolean))].sort(),
    premisesCount: item.premises.length, premisesDigest: mathDigest(canonicalMathJson(item.premises)),
    dependenciesDigest: mathDigest(canonicalMathJson(item.dependencies)),
    dependencyCoverage: item.dependencies.coverage,
    environmentMatch: preference(options.environmentDigest, [item.environmentDigest, ...item.provenance.map(origin => origin.environmentDigest)]),
    problemReceiptMatch: preference(options.problemReceiptDigest, item.provenance.map(origin => origin.problemReceiptDigest)),
  };
}

function versionPreference(item: TheoremKnowledgeEntry, options: KnowledgeSearchOptions): number[] {
  const receiptMatch = preference(options.problemReceiptDigest, item.provenance.map(origin => origin.problemReceiptDigest)),
    environmentMatch = preference(options.environmentDigest, [item.environmentDigest, ...item.provenance.map(origin => origin.environmentDigest)]),
    labels = [receiptMatch, environmentMatch];
  return [labels.filter(label => label === 'match').length, -labels.filter(label => label === 'different').length,
    receiptMatch === 'match' ? 1 : 0, environmentMatch === 'match' ? 1 : 0];
}

function validateQuery(query: string, options: KnowledgeSearchOptions): void {
  const limit = options.limit ?? 10, goal = options.goal ?? '';
  if (typeof query !== 'string' || typeof goal !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 32 ||
      Buffer.byteLength(query) > 4000 || Buffer.byteLength(goal) > 16000 || (!query.trim() && !goal.trim()) ||
      (options.displayGrouping !== undefined && options.displayGrouping !== 'exact-interface') ||
      (options.resultGrouping !== undefined && options.resultGrouping !== 'module') ||
      [options.environmentDigest, options.problemReceiptDigest].some(value => value !== undefined &&
        (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 256))) throw new Error('math_knowledge_invalid_query');
}

function prepareSearch(base: KnowledgeSearchBase, options: Omit<KnowledgeSearchOptions, 'goal'>,
  relevant: ReadonlySet<string> | undefined, includeSurfaceShapes: boolean) {
  const texts = new Map<string, string>(), plainTerms = new Map<string, Set<string>>(), boundTerms = new Map<string, Set<string>>();
  const text = (value: string) => {
    let result = texts.get(value);
    if (result === undefined) { result = leanText(value); texts.set(value, result); }
    return result;
  };
  const field = (value: string, binders = false) => {
    const cache = binders ? boundTerms : plainTerms;
    let result = cache.get(value);
    if (!result) { result = new Set(textTerms(text(value), binders)); cache.set(value, result); }
    return result;
  };
  const documents = base.entries.filter(item => !options.problemId || item.provenance.some(origin => origin.problemId === options.problemId))
    .map(item => {
      const type = knowledgeTypeExpression(item), group = knowledgeSearchGroup(item);
      return { item, group, corpusGroup: options.displayGrouping === 'exact-interface'
        ? knowledgeInterfaceGroup(item) : group, fields: [field(item.name), field(type, true),
        field([...item.dependencies.statement, ...item.dependencies.proof].map(reference => reference.name).join(' ')),
        field(item.description), field(item.provenance.map(origin => origin.problemId).join(' '))],
        conclusionTerms: field(conclusion(type), true),
        normalizedType: text(type).toLowerCase().replace(/\s+/gu, ''), surfaceShape: includeSurfaceShapes ? knowledgeGoalSurfaceShape(type) : undefined };
    });
  const groupsByToken = new Map<string, Set<string>>();
  for (const document of documents) {
    for (const field of document.fields) for (const token of field) {
      if (relevant && !relevant.has(token)) continue;
      let groups = groupsByToken.get(token);
      if (!groups) { groups = new Set(); groupsByToken.set(token, groups); }
      groups.add(document.corpusGroup);
    }
  }
  const byId = new Map(documents.map(document => [document.item.id, document]));
  const byGroup = new Map<string, typeof documents>();
  for (const document of documents) {
    const group = byGroup.get(document.corpusGroup);
    if (group) group.push(document);
    else byGroup.set(document.corpusGroup, [document]);
  }
  return { documents, byId, byGroup, relations: createKnowledgeRelationIndex(base),
    groupCount: new Set(documents.map(document => document.corpusGroup)).size,
    frequencies: new Map([...groupsByToken].map(([token, groups]) => [token, groups.size])) };
}

type PreparedDocument = ReturnType<typeof prepareSearch>['documents'][number];
type DocumentLookup = (input: { primary: readonly string[]; goalOnly: boolean; normalizedGoal: string;
  goalSurface: string | undefined; identifier: string; nameQuery: boolean }) => readonly PreparedDocument[];

/** Copy metadata once; a caller's later edits and archived source objects never enter this index. */
export function createTheoremKnowledgeSearchIndex(base: KnowledgeSearchBase,
  options: Pick<KnowledgeSearchOptions, 'displayGrouping' | 'problemId'> = {}) {
  const fixed = { displayGrouping: options.displayGrouping, problemId: options.problemId };
  validateQuery('index', fixed);
  const snapshot = structuredClone({ entries: base.entries, evidence: base.evidence, contexts: base.contexts });
  const prepared = prepareSearch(snapshot, fixed, undefined, true);
  const postings = new Map<string, PreparedDocument[]>(), mainPostings = new Map<string, PreparedDocument[]>(),
    names = new Map<string, PreparedDocument[]>(), types = new Map<string, PreparedDocument[]>(),
    shapes = new Map<string, PreparedDocument[]>();
  const add = (index: Map<string, PreparedDocument[]>, key: string, document: PreparedDocument) => {
    const rows = index.get(key);
    if (rows) rows.push(document);
    else index.set(key, [document]);
  };
  for (const document of prepared.documents) {
    for (const token of new Set(document.fields.flatMap(field => [...field]))) add(postings, token, document);
    for (const token of new Set([...document.fields[0]!, ...document.fields[1]!])) add(mainPostings, token, document);
    const parts = document.item.name.replace(/^_root_\./u, '').toLowerCase().split('.');
    for (let start = 0; start < parts.length; start++) add(names, parts.slice(start).join('.'), document);
    add(types, document.normalizedType, document);
    if (document.surfaceShape !== undefined) add(shapes, document.surfaceShape, document);
  }
  const lookup: DocumentLookup = ({ primary, goalOnly, normalizedGoal, goalSurface, identifier, nameQuery }) => {
    const selected = new Set<PreparedDocument>();
    const include = (rows: readonly PreparedDocument[] | undefined) => rows?.forEach(row => selected.add(row));
    for (const token of primary) include((goalOnly ? mainPostings : postings).get(token));
    if (goalOnly) {
      if (normalizedGoal) include(types.get(normalizedGoal));
      if (goalSurface !== undefined) include(shapes.get(goalSurface));
      // Suffix matching is part of the existing API; retain it even for goals without searchable words.
      if (normalizedGoal.length >= 8) for (const document of prepared.documents)
        if (document.normalizedType.endsWith(normalizedGoal)) selected.add(document);
    } else if (nameQuery) include(names.get(identifier));
    return [...selected];
  };
  return {
    search(requests: readonly KnowledgeSearchRequest[],
      options: Pick<KnowledgeSearchOptions, 'limit' | 'environmentDigest' | 'problemReceiptDigest' | 'resultGrouping'> = {}) {
      const selectedOptions = { ...options, ...fixed };
      return knowledgeRequestBatch(requests, (query, goal) => validateQuery(query, { ...selectedOptions, goal }), () =>
        (query, goal) => searchPrepared(prepared, snapshot.evidence, query, { ...selectedOptions, goal },
          goal ? goalShape(goal) : undefined, lookup));
    },
  };
}

/** Lexical and goal-shape ranking is advisory; matching metadata never establishes applicability. */
export function searchTheoremKnowledge(base: KnowledgeSearchBase, query: string, options: KnowledgeSearchOptions = {}) {
  return searchTheoremKnowledgeBatch(base, [query], options)[0]!;
}

/** Preparation belongs to this call, so later calls always observe current entry metadata. */
export function searchTheoremKnowledgeBatch(base: KnowledgeSearchBase, queries: readonly string[], options: KnowledgeSearchOptions = {}) {
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > 8) throw new Error('math_knowledge_invalid_query');
  return searchTheoremKnowledgeRequests(base, queries.map(query => ({ query, goal: options.goal })), options);
}

/** Validate 1..8 requests before preparation; repeated requests share one result but receive independent copies. */
export function knowledgeRequestBatch<T>(requests: readonly { query: string; goal?: string }[], validate: (query: string, goal?: string) => void,
  prepare: () => (query: string, goal?: string) => T): T[] {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 8) throw new Error('math_knowledge_invalid_query');
  for (const request of requests) {
    if (!request || typeof request !== 'object') throw new Error('math_knowledge_invalid_query');
    validate(request.query, request.goal);
  }
  const search = prepare(), results = new Map<string, T>();
  return requests.map(({ query, goal }) => {
    const key = canonicalMathJson([query, goal ?? '']), cached = results.get(key);
    if (cached) return structuredClone(cached);
    const result = search(query, goal);
    results.set(key, result);
    return result;
  });
}

/** Share corpus preparation while keeping each consumer's goal and ranking independent. */
export function searchTheoremKnowledgeRequests(base: KnowledgeSearchBase, requests: readonly KnowledgeSearchRequest[],
  options: Omit<KnowledgeSearchOptions, 'goal'> = {}) {
  return knowledgeRequestBatch(requests, (query, goal) => validateQuery(query, { ...options, goal }), () => {
    const relevant = new Set<string>(), goalSurfaces = new Map<string, string | undefined>();
    for (const request of requests) {
      const { query } = request, goal = request.goal ?? '';
      for (const term of terms(goal, true)) relevant.add(term);
      for (const term of terms(query.trim() ? query : conclusion(goalTarget(goal)), !query.trim())) relevant.add(term);
      if (!goalSurfaces.has(goal)) goalSurfaces.set(goal, goal ? goalShape(goal) : undefined);
    }
    const prepared = prepareSearch(base, options, relevant, [...goalSurfaces.values()].some(Boolean));
    return (query, goal) => searchPrepared(prepared, base.evidence, query, { ...options, goal }, goalSurfaces.get(goal ?? ''));
  });
}

function searchPrepared(prepared: ReturnType<typeof prepareSearch>, evidence: KnowledgeSearchBase['evidence'], query: string,
  options: KnowledgeSearchOptions, goalSurface: string | undefined, lookup?: DocumentLookup, focusConclusion = true) {
  const limit = options.limit ?? 10, goal = options.goal ?? '', { documents, groupCount, frequencies } = prepared;
  const goalOnly = !query.trim(), focused = goalOnly && focusConclusion;
  const primary = terms(goalOnly ? focused ? conclusion(goalTarget(goal)) : goalTarget(goal) : query, goalOnly),
    goalTerms = terms(goal, true), normalizedGoal = canonical(goalTarget(goal));
  const identifier = query.trim().replace(/^_root_\./u, '').toLowerCase();
  const nameQuery = /^[\p{L}_][\p{L}\p{M}\p{N}_'.]*$/u.test(identifier);
  const relevant = [...new Set([...primary, ...goalTerms])];
  const idf = new Map(relevant.map(term => [term, 1 + Math.log((groupCount + 1) /
    (1 + (frequencies.get(term) ?? 0)))]));
  const primaryWeight = primary.reduce((sum, term) => sum + idf.get(term)!, 0);
  const assess = (document: PreparedDocument) => {
    const { item, fields } = document, normalizedName = item.name.replace(/^_root_\./u, '').toLowerCase();
    const nameScore = !goalOnly && nameQuery ? normalizedName === identifier ? 5000 :
      normalizedName.split('.').at(-1) === identifier ? 4500 : normalizedName.endsWith(`.${identifier}`) ? 4700 : 0 : 0;
    const matched = primary.filter(term => fields.some(field => field.has(term)));
    const typeTerms = focused ? document.conclusionTerms : fields[1]!;
    const main = primary.filter(term => fields[0]!.has(term) || typeTerms.has(term));
    const dependencies = primary.filter(term => fields[2]!.has(term));
    const exactGoal = Boolean(normalizedGoal && normalizedGoal === document.normalizedType),
      trailingGoal = Boolean(normalizedGoal.length >= 8 && document.normalizedType.endsWith(normalizedGoal)),
      surfaceMatch = goalSurface !== undefined && goalSurface === document.surfaceShape;
    const eligible = goalOnly ? Boolean(main.length || primary.some(term => fields[1]!.has(term)) ||
      exactGoal || trailingGoal || surfaceMatch) : Boolean(nameScore || matched.length);
    const coverage = primaryWeight ? main.reduce((sum, term) => sum + idf.get(term)!, 0) / primaryWeight : 0;
    let score = nameScore;
    for (const term of primary) {
      const significance = idf.get(term)!;
      score += significance * ((fields[0]!.has(term) ? focused ? 1 : 8 : 0) + (typeTerms.has(term) ? 5 : 0)) * (0.1 + coverage * coverage);
      score += significance * ((fields[2]!.has(term) ? 1 : 0) + (fields[3]!.has(term) ? 0.15 : 0) + (fields[4]!.has(term) ? 0.05 : 0));
    }
    score += 100 * coverage * coverage;
    if (normalizedGoal) {
      let goalScore = exactGoal ? 3000 : surfaceMatch ? 2000 : trailingGoal ? 1000 : 0;
      const denominator = goalTerms.reduce((sum, term) => sum + idf.get(term)!, 0);
      const covered = goalTerms.reduce((sum, term) => sum + (fields[1]!.has(term) ? idf.get(term)! : 0), 0);
      if (denominator) goalScore += 80 * (covered / denominator) ** 2;
      score += goalScore * (goalOnly || main.length || nameScore ? 1 : dependencies.length ? 0.1 : 0.01);
    }
    const tier = goalOnly ? 1 : nameScore ? 4 : main.length ? 3 : dependencies.length ? 2 : matched.length ? 1 : 0;
    const exactMatch: 'name' | 'type' | undefined = nameScore ? 'name' : exactGoal ? 'type' : undefined;
    return { ...document, score, tier, matched, eligible: eligible && score > 0, exactMatch };
  };
  const assessed = (lookup ? lookup({ primary, goalOnly, normalizedGoal, goalSurface, identifier, nameQuery }) : documents).map(assess);
  // A general theorem can still apply by definitional reduction even when its conclusion has no searchable terms.
  if (focused && !assessed.some(hit => hit.eligible))
    return searchPrepared(prepared, evidence, query, options, goalSurface, lookup, false);
  const compareRelevance = (left: typeof assessed[number], right: typeof assessed[number]) =>
    right.tier - left.tier || right.score - left.score || left.item.id.localeCompare(right.item.id);
  const scored = assessed.filter(hit => hit.eligible).sort(compareRelevance);
  type Group = { key: string; groupScore: number; declarations: Map<string, typeof scored> };
  const groupRows = (rows: typeof scored) => {
    const groups = new Map<string, Group>();
    for (const hit of rows) {
      let group = groups.get(hit.corpusGroup);
      if (!group) { group = { key: hit.corpusGroup, groupScore: hit.score, declarations: new Map() }; groups.set(hit.corpusGroup, group); }
      const versions = group.declarations.get(hit.group);
      if (versions) versions.push(hit);
      else group.declarations.set(hit.group, [hit]);
    }
    return groups;
  };
  const groups = groupRows(scored);
  const compareVersions = (left: typeof scored[number], right: typeof scored[number]) => {
    const a = versionPreference(left.item, options), b = versionPreference(right.item, options);
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return b[index]! - a[index]!;
    return right.tier - left.tier || right.score - left.score || left.item.id.localeCompare(right.item.id);
  };
  const selectVersion = (group: Group) => {
    const declarations = [...group.declarations.values()];
    for (const versions of declarations) versions.sort(compareVersions);
    declarations.sort((left, right) => compareVersions(left[0]!, right[0]!));
    const versions = declarations[0]!;
    return { group, declarations, versions, row: versions[0]!, relation: undefined as KnowledgeRelation | undefined };
  };
  const moduleKey = (item: TheoremKnowledgeEntry) => `${item.contextDigest}:${item.file}`;
  const lexical: ReturnType<typeof selectVersion>[] = [], selectedModules = new Set<string>();
  for (const group of groups.values()) {
    const selected = selectVersion(group), module = moduleKey(selected.row.item);
    if (options.resultGrouping === 'module' && selectedModules.has(module)) continue;
    lexical.push(selected); selectedModules.add(module);
    if (lexical.length === limit) break;
  }
  // Seeds are concrete versions, chosen before graph expansion. No name-only or cross-context joins.
  const seedIds = lexical.slice(0, 3).map(hit => hit.row.item.id), expansion = prepared.relations.expand(seedIds, 12);
  const relatedGroups = new Set(expansion.relations.flatMap(relation => {
    const row = prepared.byId.get(relation.entryId); return row ? [row.corpusGroup] : [];
  }));
  const relationGroups = groupRows([...relatedGroups].flatMap(group => prepared.byGroup.get(group) ?? []).map(assess).sort(compareRelevance));
  const related = [...relationGroups.values()].flatMap(group => {
    const selected = lexical.find(hit => hit.group.key === group.key) ?? selectVersion(group);
    // Interface grouping can choose a different contextual version. Its edge must also exist.
    const relation = expansion.relations.find(item => item.entryId === selected.row.item.id);
    const sameModule = options.resultGrouping === 'module' && lexical.find(hit =>
      moduleKey(hit.row.item) === moduleKey(selected.row.item) && hit.row.item.id !== selected.row.item.id);
    return relation && !sameModule ? [{ ...selected, relation }] : [];
  }).sort((left, right) => compareRelevance(left.row, right.row));
  const supplement = related[0];
  let selected = lexical;
  if (supplement) {
    const prior = lexical.findIndex(hit => hit.row.item.id === supplement.row.item.id);
    const lastExact = lexical.findLastIndex(hit => hit.row.exactMatch !== undefined);
    const insertion = Math.max(Math.min(2, lexical.length), lastExact + 1);
    // Preserve the first lexical alternatives and all exact hits; use at most one relation slot.
    selected = lexical.filter(hit => hit.row.item.id !== supplement.row.item.id);
    selected.splice(prior >= 0 && prior < insertion ? prior : insertion, 0, supplement);
    selected = selected.slice(0, limit);
  }
  const recalledRows = selected.filter(hit => hit.relation).flatMap(hit => [...hit.group.declarations.values()].flat());
  const matchedRows = [...new Map([...scored, ...recalledRows].map(row => [row.item.id, row])).values()];
  const matchedGroups = groupRows(matchedRows);
  const declarationCount = [...matchedGroups.values()].reduce((count, group) => count + group.declarations.size, 0);
  return { schema: 'theorem-os.theorem-knowledge-search.v1', evidence, requiresFreshCheck: true,
    preferenceEvidence: 'recorded-metadata-not-applicability', total: declarationCount,
    totalVersions: matchedRows.length,
    ...(options.resultGrouping ? { resultGrouping: options.resultGrouping,
      totalModules: new Set(matchedRows.map(row => moduleKey(row.item))).size } : {}),
    ...(options.displayGrouping ? { displayGrouping: options.displayGrouping, totalInterfaces: matchedGroups.size } : {}),
    relationSearch: { referenceSemantics: 'local-transitive-closure' as const, seedIds,
      considered: expansion.relations.length, unresolved: expansion.unresolved, truncated: expansion.truncated },
    hits: selected.map(({ group, declarations, versions, row, relation }) => {
      const { item, matched, exactMatch } = row, summary = knowledgeVersionSummary(item, options);
      return { id: item.id, name: item.name, kind: item.kind, typeKind: item.typeKind,
        consumers: { command: 'knowledge consumers', id: item.id },
        typePreview: item.type.slice(0, 800), typeTruncated: item.type.length > 800, description: item.description.slice(0, 500),
        problemIds: summary.problemIds, sourceKinds: summary.sourceKinds, dependencyCoverage: item.dependencies.coverage,
        score: group.groupScore, matched, ...(exactMatch ? { exactMatch } : {}), ...(relation ? { relation } : {}),
        environmentMatch: summary.environmentMatch, problemReceiptMatch: summary.problemReceiptMatch,
        ...(options.displayGrouping ? { declarationVariantCount: declarations.length } : {}),
        versionCount: versions.length, versions: versions.slice(0, 8).map(version => knowledgeVersionSummary(version.item, options)),
        versionsTruncated: versions.length > 8 };
    }) };
}
