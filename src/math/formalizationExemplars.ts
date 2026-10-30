import path from 'node:path';
import { z } from 'zod';
import { mathDigest, readMathText } from './mathRuntimeIo';
import { assertMathCanonicalPath } from './paths';

/**
 * Frozen few-shot exemplars for planning and generation.
 *
 * The official ProofNet protocol formalizes each test statement with a few
 * (natural language, Lean) pairs drawn from its validation split. Lean states one
 * mathematical claim in many equally faithful shapes, and a reference checker can
 * only link the shape the corpus authors chose, so the nearest pairs from the same
 * corpus are the cheapest evidence of which shape that is.
 *
 * Selection is lexical and deterministic, happens once at preparation, and the
 * chosen pairs are frozen into the request: a resumed run sees the same bytes, and
 * the request digest binds them. Reviewers never receive exemplars; fidelity is
 * still judged against the original statement only.
 */

export const FORMALIZATION_EXEMPLAR_ALGORITHM = 'tfidf-cosine-v1';
const MAX_ITEMS = 32;
const MAX_CORPUS = 10_000;

const id = z.string().min(1).max(256);
const statement = z.string().min(1).max(16_000).refine(value => value.trim().length > 0);
const lean = z.string().min(1).max(32_000).refine(value => value.trim().length > 0);
export const formalizationExemplarSchema = z.object({ id, statement, lean }).strict();
export type FormalizationExemplar = z.infer<typeof formalizationExemplarSchema>;
export const formalizationExemplarCorpusSchema = z.object({
  schema: z.literal('theorem-os.formalization-exemplar-corpus.v1'),
  provenance: z.string().min(1).max(4_000),
  items: z.array(formalizationExemplarSchema).min(1).max(MAX_CORPUS),
}).strict().superRefine((corpus, context) => {
  if (new Set(corpus.items.map(item => item.id)).size !== corpus.items.length)
    context.addIssue({ code: 'custom', message: 'Exemplar corpus ids must be unique.' });
});
export type FormalizationExemplarCorpus = z.infer<typeof formalizationExemplarCorpusSchema>;
export const formalizationExemplarsSchema = z.object({
  schema: z.literal('theorem-os.formalization-exemplars.v1'),
  algorithm: z.literal(FORMALIZATION_EXEMPLAR_ALGORITHM),
  corpusSha256: z.string().regex(/^[a-f0-9]{64}$/u), corpusSize: z.number().int().positive(),
  provenance: z.string().min(1).max(4_000),
  excludedIds: z.array(id).max(MAX_CORPUS),
  items: z.array(formalizationExemplarSchema.extend({ score: z.number().min(0).max(1) }).strict()).min(1).max(MAX_ITEMS),
}).strict();
export type FormalizationExemplars = z.infer<typeof formalizationExemplarsSchema>;
export type FormalizationExemplarSource = { corpusFile: string; count: number; excludeIds?: string[] };

/** TeX commands and words of two or more letters; single-letter variable names carry no topic. */
function tokens(text: string): string[] {
  return (text.match(/\\[A-Za-z]+|[A-Za-z]{2,}|[0-9]+/gu) ?? []).map(token => token.toLowerCase());
}

function termFrequencies(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/**
 * The `count` corpus pairs nearest to `statement` by TF-IDF cosine over the
 * natural-language statements, ties broken by corpus order.
 *
 * Explicitly excluded ids and any pair whose statement equals the request's are
 * never eligible, so a corpus that contains the problem itself cannot hand the
 * planner its own reference.
 */
export function selectFormalizationExemplars(corpus: FormalizationExemplarCorpus, statement: string,
  count: number, excludeIds: readonly string[] = []): { excludedIds: string[]; items: FormalizationExemplars['items'] } {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_ITEMS) throw new Error('formalization_exemplar_count_invalid');
  const known = new Set(corpus.items.map(item => item.id));
  const unknown = excludeIds.filter(item => !known.has(item));
  if (unknown.length) throw new Error('formalization_exemplar_exclusion_unknown:' + unknown.join(','));
  const excluded = new Set(excludeIds);
  for (const item of corpus.items) if (item.statement.trim() === statement.trim()) excluded.add(item.id);
  const eligible = corpus.items.filter(item => !excluded.has(item.id));
  if (eligible.length < count) throw new Error('formalization_exemplar_corpus_too_small');
  const documents = eligible.map(item => termFrequencies(item.statement));
  const frequency = new Map<string, number>();
  for (const document of documents) for (const token of document.keys()) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const weigh = (counts: Map<string, number>) => {
    const vector = new Map<string, number>();
    let norm = 0;
    for (const [token, value] of counts) {
      const weight = (1 + Math.log(value)) * (Math.log((eligible.length + 1) / ((frequency.get(token) ?? 0) + 1)) + 1);
      vector.set(token, weight); norm += weight * weight;
    }
    return { vector, norm: Math.sqrt(norm) };
  };
  const query = weigh(termFrequencies(statement));
  const scored = eligible.map((item, index) => {
    const document = weigh(documents[index]);
    let dot = 0;
    for (const [token, weight] of query.vector) dot += weight * (document.vector.get(token) ?? 0);
    const cosine = query.norm && document.norm ? dot / (query.norm * document.norm) : 0;
    return { item, index, score: Math.min(1, Math.max(0, Math.round(cosine * 1e6) / 1e6)) };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return { excludedIds: corpus.items.filter(item => excluded.has(item.id)).map(item => item.id),
    items: scored.slice(0, count).map(({ item, score }) => ({ ...item, score })) };
}

/** Read a corpus file and freeze the selected pairs with the corpus identity. */
export function prepareFormalizationExemplars(source: FormalizationExemplarSource, statement: string): FormalizationExemplars {
  const file = path.resolve(source.corpusFile); assertMathCanonicalPath(file);
  const text = readMathText(file, 64_000_000), corpus = formalizationExemplarCorpusSchema.parse(JSON.parse(text));
  const selected = selectFormalizationExemplars(corpus, statement, source.count, source.excludeIds ?? []);
  return formalizationExemplarsSchema.parse({ schema: 'theorem-os.formalization-exemplars.v1',
    algorithm: FORMALIZATION_EXEMPLAR_ALGORITHM, corpusSha256: mathDigest(text), corpusSize: corpus.items.length,
    provenance: corpus.provenance, ...selected });
}

/** What a role sees: the pairs only, without scores or corpus bookkeeping. */
export function formalizationExemplarInput(exemplars: FormalizationExemplars): FormalizationExemplar[] {
  return exemplars.items.map(({ id, statement, lean }) => ({ id, statement, lean }));
}

/** Appended to the planner and author protocols when a request froze exemplars. */
export const formalizationExemplarInstructions = [
  'INPUT.exemplars contains solved formalizations of other problems from the same corpus, chosen by textual similarity to this problem. They are not this problem and are not evidence about its content.',
  'Use them only as evidence of the corpus conventions for writing the same kind of mathematics: how carriers, finiteness and cardinality, primes, subobjects, families, quotients, polynomials and quantifiers are written, and which library names, binder styles and statement shapes are used.',
  'When the source admits several faithful Lean shapes, prefer the shape these exemplars use for the same kind of claim. Never let an exemplar add, drop, weaken or strengthen any hypothesis or conclusion of this problem; fidelity to INPUT.statement always decides.',
  'Exemplars were written against an older Mathlib and rely on the open namespaces in their own header. Check every name you take from them in the pinned environment and qualify it in your file.',
  'When the source assumes that an object is unique and then refers to it, bind that object and state its uniqueness as a separate hypothesis (∀ y, P y → y = x) rather than assuming ∃! x, P x. This is the same assumption, in the shape reference formalizations use, and does not apply to conclusions that assert uniqueness.',
  'A prime the source calls a prime, prime number or prime integer, and never allows to be negative, is a natural number: bind (p : ℕ) with its primality hypothesis and cast p where an integer, rational or ring element is needed, rather than binding p : ℤ. This is the conventional reading of "prime integer" and the shape reference formalizations use.',
].join('\n');
