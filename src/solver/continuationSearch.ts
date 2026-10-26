import { continuationAttachmentKinds, readContinuationContents, readContinuationSnapshot,
  type ContinuationAttachmentKind, type ContinuationSnapshot } from './continuationInput';
import type { ContextSection } from './contextCompiler';
import type { CooperativeAction } from './tasks';
import type { SolverProblem } from './problem';
import { splitsSurrogate } from './textPage';

/**
 * Lexical passage search over frozen continuation text. Passages are paragraph-aligned UTF-16 ranges that
 * `continuation read` returns exactly; ranking is advisory reading guidance, never proof evidence.
 */
const passageTarget = 1200, passageMax = 4000, snippetLength = 400, snippetLead = 120;
const maxQueryBytes = 4000, maxQueryTerms = 512, maxIndexes = 2;
const autoHits = 4, autoSectionBytes = 6000;
const k1 = 1.2, lengthWeight = 0.75;
const stopwords = new Set(['an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'is', 'it', 'its',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'we', 'were', 'which', 'with']);
const wordPattern = /(?<han>\p{Script=Han}+)|[\p{L}\p{N}\p{M}]+/gu;
const splitPattern = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u;

type Passage = Readonly<{ id: string; kind: ContinuationAttachmentKind; evidence: string; sha256: string; start: number; end: number; length: number }>;
type ReferenceIndex = Readonly<{ passages: readonly Passage[]; texts: ReadonlyMap<string, string>;
  /** Flat [passage, frequency] pairs per term. */
  postings: ReadonlyMap<string, readonly number[]>; averageLength: number }>;

/** Lowercase NFKC words and camel/number parts of length >= 2 (or a digit); Han runs become character bigrams. */
export function referenceTerms(text: string, start = 0, end = text.length): { term: string; offset: number }[] {
  const terms: { term: string; offset: number }[] = [];
  const add = (term: string, offset: number) => {
    if ((term.length >= 2 || /^\p{N}$/u.test(term)) && !stopwords.has(term)) terms.push({ term, offset });
  };
  for (const match of text.slice(start, end).matchAll(wordPattern)) {
    const offset = start + match.index;
    if (match.groups?.han) {
      const characters = [...match[0]];
      if (characters.length === 1) terms.push({ term: characters[0]!, offset });
      for (let index = 0, position = offset; index + 1 < characters.length; position += characters[index]!.length, index++)
        terms.push({ term: characters[index]! + characters[index + 1]!, offset: position });
      continue;
    }
    const whole = match[0].normalize('NFKC').toLowerCase();
    add(whole, offset);
    const parts = match[0].split(splitPattern);
    if (parts.length > 1) for (let index = 0, position = offset; index < parts.length; position += parts[index]!.length, index++) {
      const part = parts[index]!.normalize('NFKC').toLowerCase();
      if (part !== whole) add(part, position);
    }
  }
  return terms;
}

/** Paragraph-aligned ranges covering `text`; an overlong paragraph is cut at a line end, a space, or a code point. */
export function referencePassages(text: string): { start: number; end: number }[] {
  const boundaries = [...text.matchAll(/\n[ \t\r]*\n\s*/gu)].map(match => match.index + match[0].length);
  const ranges: { start: number; end: number }[] = [];
  const emit = (start: number, end: number) => {
    while (end - start > passageMax) {
      const window = text.slice(start + passageTarget, start + passageMax);
      const local = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
      let cut = local >= 0 ? start + passageTarget + local + 1 : start + passageMax;
      if (splitsSurrogate(text, cut)) cut--;
      ranges.push({ start, end: cut }); start = cut;
    }
    if (end > start) ranges.push({ start, end });
  };
  let start = 0, previous = 0;
  for (const boundary of [...boundaries, text.length]) {
    if (boundary - start > passageTarget && previous > start) { emit(start, previous); start = previous; }
    if (boundary - start >= passageTarget || boundary === text.length) { emit(start, boundary); start = boundary; }
    previous = boundary;
  }
  return ranges;
}

const indexes = new Map<string, ReferenceIndex>();

/** Built from verified frozen bodies once per snapshot digest and kind set; callers verify the snapshot itself. */
function referenceIndex(snapshot: ContinuationSnapshot, kinds: readonly ContinuationAttachmentKind[]): ReferenceIndex {
  const key = `${snapshot.digest}:${kinds.join(',')}`, cached = indexes.get(key);
  if (cached) return cached;
  const { contents } = readContinuationContents(snapshot.file, snapshot.digest, snapshot.manifest);
  const passages: Passage[] = [], postings = new Map<string, number[]>(), texts = new Map<string, string>();
  let total = 0;
  for (const item of snapshot.manifest.attachments.filter(item => kinds.includes(item.kind))) {
    const text = contents.get(item.sha256)!;
    texts.set(item.sha256, text);
    for (const range of referencePassages(text)) {
      const counts = new Map<string, number>(), terms = referenceTerms(text, range.start, range.end);
      if (!terms.length) continue;
      for (const { term } of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
      for (const [term, count] of counts) {
        const list = postings.get(term);
        if (list) list.push(passages.length, count); else postings.set(term, [passages.length, count]);
      }
      passages.push({ id: item.id, kind: item.kind, evidence: item.provenance.evidence, sha256: item.sha256, ...range, length: terms.length });
      total += terms.length;
    }
  }
  const index = { passages, texts, postings, averageLength: passages.length ? total / passages.length : 0 };
  if (indexes.size >= maxIndexes) indexes.delete(indexes.keys().next().value!);
  indexes.set(key, index);
  return index;
}

/** BM25 (k1 = 1.2, b = 0.75); equal scores keep manifest attachment order, then offset order. */
function rank(index: ReferenceIndex, terms: readonly string[], limit: number) {
  const scores = new Map<number, number>(), matched = new Map<number, string[]>(), count = index.passages.length;
  for (const term of terms) {
    const list = index.postings.get(term);
    if (!list) continue;
    const documents = list.length / 2, idf = Math.log(1 + (count - documents + 0.5) / (documents + 0.5));
    for (let position = 0; position < list.length; position += 2) {
      const passage = list[position]!, frequency = list[position + 1]!;
      const norm = 1 - lengthWeight + lengthWeight * index.passages[passage]!.length / index.averageLength;
      scores.set(passage, (scores.get(passage) ?? 0) + idf * frequency * (k1 + 1) / (frequency + k1 * norm));
      const names = matched.get(passage);
      if (names) names.push(term); else matched.set(passage, [term]);
    }
  }
  return [...scores].sort(([left, a], [right, b]) => b - a || left - right).slice(0, limit)
    .map(([passage, score]) => ({ passage: index.passages[passage]!, score: Math.round(score * 1e6) / 1e6, terms: matched.get(passage)! }));
}

/** A bounded excerpt around the first matched term; offsets stay on code-point boundaries. */
function snippet(index: ReferenceIndex, passage: Passage, terms: readonly string[]) {
  const text = index.texts.get(passage.sha256)!, wanted = new Set(terms);
  const first = referenceTerms(text, passage.start, passage.end).find(item => wanted.has(item.term))?.offset ?? passage.start;
  let start = Math.max(passage.start, Math.min(first - snippetLead, passage.end - snippetLength));
  let end = Math.min(passage.end, start + snippetLength);
  if (splitsSurrogate(text, start)) start++;
  if (splitsSurrogate(text, end)) end--;
  return { startOffset: start, endOffset: end, text: text.slice(start, end) };
}

function queryTerms(query: string) {
  const unique = [...new Set(referenceTerms(query).map(item => item.term))];
  return { terms: unique.slice(0, maxQueryTerms), truncated: unique.length > maxQueryTerms };
}

function selectedKinds(kinds: readonly string[] | undefined): ContinuationAttachmentKind[] {
  if (kinds?.some(kind => !(continuationAttachmentKinds as readonly string[]).includes(kind)))
    throw new Error('math_continuation_search_options_invalid');
  return continuationAttachmentKinds.filter(kind => !kinds?.length || kinds.includes(kind));
}

export type ContinuationSearchOptions = { limit?: number; kinds?: readonly string[]; maxBytes?: number };

/** `continuation search`: verifies the frozen snapshot, then ranks passages of the selected kinds. */
export function searchContinuation(file: string, expectedDigest: string, query: string, options: ContinuationSearchOptions = {}) {
  const { limit = 8, maxBytes = 16000 } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16000 ||
      typeof query !== 'string' || !query.trim() || Buffer.byteLength(query) > maxQueryBytes)
    throw new Error('math_continuation_search_options_invalid');
  const kinds = selectedKinds(options.kinds), snapshot = readContinuationSnapshot(file, expectedDigest);
  const index = referenceIndex(snapshot, kinds), parsed = queryTerms(query);
  const hits = rank(index, parsed.terms, limit).map(({ passage, score, terms }) => ({ id: passage.id, kind: passage.kind,
    evidence: passage.evidence, startOffset: passage.start, endOffset: passage.end, score, matchedTerms: terms,
    snippet: snippet(index, passage, terms) }));
  const packet = (count: number) => ({ schema: 'theorem-os.continuation-search.v1' as const,
    authority: 'advisory-continuation' as const, proofAcceptance: 'not-assessed' as const,
    taskDigest: snapshot.manifest.taskDigest, problemReceiptDigest: snapshot.manifest.problemReceiptDigest, snapshotDigest: snapshot.digest,
    ranking: 'bm25-lexical' as const, offsetEncoding: 'utf16-code-unit' as const, endOffsetExclusive: true as const,
    kinds, passages: index.passages.length, queryTerms: parsed.terms, ...(parsed.truncated ? { queryTruncated: true } : {}),
    hits: hits.slice(0, count), ...(count < hits.length ? { omittedHits: hits.length - count } : {}) });
  for (let count = hits.length; count >= 0; count--) {
    const value = packet(count);
    if (Buffer.byteLength(JSON.stringify(value)) + 1 <= maxBytes) return value;
  }
  throw new Error('math_continuation_search_budget_too_small');
}

const shellArgument = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/**
 * Optional prompt section: the top reference passages for `query`, with exact read commands. Only `reference`
 * attachments are searched automatically. The caller has already verified `snapshot`.
 */
export function continuationReferenceSection(snapshot: ContinuationSnapshot, command: string, query: string): ContextSection | undefined {
  if (!snapshot.manifest.attachments.some(item => item.kind === 'reference')) return undefined;
  const index = referenceIndex(snapshot, ['reference']), parsed = queryTerms(query);
  const hits = rank(index, parsed.terms, autoHits).map(({ passage, score, terms }) => ({ id: passage.id, evidence: passage.evidence,
    startOffset: passage.start, endOffset: passage.end, score, matchedTerms: terms.slice(0, 12),
    snippet: snippet(index, passage, terms),
    readCommand: `${command} continuation read --snapshot ${shellArgument(snapshot.file)} --sha256 ${shellArgument(snapshot.digest)} --id ${shellArgument(passage.id)} --offset ${passage.start} --max-bytes 16000` }));
  if (!hits.length) return undefined;
  const text = (count: number) => 'Reference passages ranked for this assignment (advisory reading; lexical BM25 over attached reference texts, not proof acceptance). ' +
    'Read a passage from its startOffset before relying on it; the text may use other notation or hypotheses than the original statement, which stays authoritative. ' +
    'Search other wording with the continuation searchCommand.\n' + JSON.stringify({ schema: 'theorem-os.continuation-references.v1',
      snapshotDigest: snapshot.digest, ranking: 'bm25-lexical', offsetEncoding: 'utf16-code-unit',
      queryTerms: parsed.terms.length, hits: hits.slice(0, count) });
  let count = hits.length;
  while (count > 1 && Buffer.byteLength(text(count)) > autoSectionBytes) count--;
  return { id: `continuation-references:${snapshot.digest}`, kind: 'continuation', text: text(count), priority: 7 };
}

/** Mathematical text of the current responsibility; reviews and assembly receive no automatic references. */
export function referenceQuery(problem: SolverProblem, taskText: string, action?: CooperativeAction): string | undefined {
  if (action?.kind === 'task') return [action.task.objective, action.task.informalStatement, action.task.theoremName, action.task.type]
    .filter(Boolean).join('\n');
  if (action && action.kind !== 'lead') return undefined;
  return [taskText, ...problem.targets.map(target => target.theoremName)].join('\n');
}
