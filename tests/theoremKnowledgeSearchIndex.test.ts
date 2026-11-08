import { describe, expect, it } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { TheoremKnowledgeBase, TheoremKnowledgeEntry } from '../src/solver/theoremKnowledge';
import { createTheoremKnowledgeSearchIndex, searchTheoremKnowledgeRequests,
  type KnowledgeSearchOptions, type KnowledgeSearchRequest } from '../src/solver/theoremKnowledgeSearch';

const environment = mathDigest('environment'), context = mathDigest('context'), receipt = mathDigest('receipt');
const goal = '∀ (q : ℕ) [NeZero q] (χ : DirichletCharacter ℂ q), χ.IsPrimitive → ‖χ.rootNumber‖ = 1';
function entry(name: string, type = 'Opaque', extra: Partial<TheoremKnowledgeEntry> = {}): TheoremKnowledgeEntry {
  return { id: mathDigest(name + type), name, file: 'Library.lean', type, typeKind: 'closed-task-type', kind: 'lemma',
    description: '', premises: [], declaration: `theorem ${name} : ${type} := by exact fixture`,
    contextDigest: context, environmentDigest: environment,
    dependencies: { statement: [], proof: [], tasks: [], coverage: 'recorded' },
    provenance: [{ kind: 'frozen-library-pack', problemId: 'fixture', source: 'fixture', sourceDigest: mathDigest('source'),
      receiptIds: [], environmentDigest: environment }], ...extra };
}
type Base = Pick<TheoremKnowledgeBase, 'entries' | 'evidence' | 'contexts'>;
const catalog = (entries: TheoremKnowledgeEntry[]): Base => ({ entries, evidence: 'recorded-not-replayed',
  contexts: Object.fromEntries([...new Set(entries.map(item => item.contextDigest))]
    .map(digest => [digest, { 'Library.lean': mathDigest(digest) }])) });
const reference = (item: TheoremKnowledgeEntry) => ({ file: item.file, name: item.name });
function compare(base: Base, requests: readonly KnowledgeSearchRequest[], options: KnowledgeSearchOptions = {}) {
  const index = createTheoremKnowledgeSearchIndex(base, options);
  const actual = index.search(requests, options);
  expect(actual).toEqual(searchTheoremKnowledgeRequests(base, requests, options));
  return actual;
}

describe('reusable theorem knowledge search index', () => {
  it.each([
    {}, { displayGrouping: 'exact-interface' as const },
    { problemId: 'fixture', environmentDigest: environment, problemReceiptDigest: receipt },
    { displayGrouping: 'exact-interface' as const, problemId: 'fixture',
      environmentDigest: environment, problemReceiptDigest: receipt },
  ])('preserves lexical, goal, version and grouping results: %j', options => {
    const root = entry('Saved.paper_root_number_norm', goal),
      current = entry(root.name, goal, { id: mathDigest('current'), contextDigest: mathDigest('current-context'),
        provenance: [{ ...root.provenance[0]!, problemReceiptDigest: receipt }] }),
      proofVariant = entry(root.name, goal, { id: mathDigest('proof-variant'),
        declaration: 'theorem paper_root_number_norm := by exact alternate_proof' }),
      foreign = entry('Foreign.paper_root_number_norm', goal);
    foreign.provenance[0]!.problemId = 'foreign';
    const base = catalog([root, current, proofVariant, foreign,
      entry('Saved.partial_derivative', 'MvPolynomial.pderiv i f'),
      entry('Saved.description_only', 'Unrelated', { description: 'root number norm' }),
      entry('Saved.dependency_only', 'Unrelated', {
        dependencies: { statement: [{ file: 'Other.lean', name: 'DirichletCharacter.rootNumber' }],
          proof: [], tasks: [], coverage: 'recorded' } }),
      entry('Saved.natural_reflexivity', 'forall (n : Nat), n = n'),
      entry('Saved.source_header', 'lemma Saved.source_header (n : Nat) : n + 0 = n', { typeKind: 'source-header' })]);
    const requests = Object.freeze([
      { query: 'root norm' }, { query: 'paper_root_number_norm' }, { query: '_root_.Saved.paper_root_number_norm' },
      { query: '', goal }, { query: '', goal: 'forall (value : Nat), value = value' },
      { query: '', goal: 'forall (n : Nat), n + 0 = n' },
      { query: 'unavailableproofkeyword', goal }, { query: 'partial derivative' },
    ]);
    compare(base, requests, { ...options, limit: 3 });
  });

  it('keeps exact boilerplate identifiers, namespace tails and suffix goals without searchable words', () => {
    const literal = entry('Saved.its', 'True'), helpers = entry('Saved.Helpers', 'True'),
      suffix = entry('Saved.suffix', 'Guard → a + b + c + d = e'),
      equality = entry('Saved.equality', 'a = b'),
      proposition = entry('Saved.proposition', '∀ (P : Prop), P = P');
    const results = compare(catalog([literal, helpers, suffix, equality, proposition]), [
      { query: 'its' }, { query: 'Helpers' }, { query: 'Saved.its' },
      { query: '', goal: 'a + b + c + d = e' }, { query: '', goal: 'n : Nat\n⊢ a = b' },
      { query: '', goal: '∀ (Q : Prop), Q = Q' },
    ]);
    expect(results.map(result => result.hits[0]?.id)).toEqual([
      literal.id, helpers.id, literal.id, suffix.id, equality.id, proposition.id,
    ]);
  });

  it('shares conclusion ranking and full-type fallback across repeated indexed searches', () => {
    const desired = entry('Saved.isDistribution_row',
      'forall (matrix : Matrix Ω Ω Real) (h : RowStochastic matrix) (row : Ω), IsDistribution (matrix row)');
    const noise = entry('Saved.IsDistribution.pushforward',
      'forall (p : Ω → Real) (hp : IsDistribution p), IsDistribution (map p)');
    const general = entry('Saved.general', 'forall (n : Nat), n = n');
    const base = catalog([noise, desired, general]);
    const requests = [
      { query: '', goal: 'forall (matrix : Matrix Ω Ω Real) (h : RowStochastic matrix) (row : Ω), IsDistribution _' },
      { query: '', goal: 'forall (n : Nat), n + 0 = n' },
    ];
    const result = compare(base, requests, { limit: 3, displayGrouping: 'exact-interface' });
    expect(result.map(row => row.hits[0]?.id)).toEqual([desired.id, general.id]);
    const index = createTheoremKnowledgeSearchIndex(base, { displayGrouping: 'exact-interface' });
    expect(index.search(requests, { limit: 3 })).toEqual(result);
    expect(index.search(requests, { limit: 3 })).toEqual(result);
  });

  it('limits distinct modules after ranking instead of letting one large module fill every slot', () => {
    const crowded = Array.from({ length: 40 }, (_, index) => entry(`Crowded.exact${index}`, 'WantedPredicate', { file: 'Crowded.lean' }));
    const alternatives = Array.from({ length: 4 }, (_, index) => entry(`Alternative.result${index}`, 'Guard → WantedPredicate',
      { file: `Alternative${index}.lean` }));
    const base = catalog([...crowded, ...alternatives]), request = [{ query: '', goal: 'WantedPredicate' }];
    const index = createTheoremKnowledgeSearchIndex(base), ordinary = index.search(request, { limit: 4 })[0]!;
    expect(ordinary.hits.every(hit => crowded.some(item => item.id === hit.id))).toBe(true);
    const result = compare(base, request, { limit: 4, resultGrouping: 'module' })[0]!;
    const files = new Map(base.entries.map(item => [item.id, item.file]));
    expect(new Set(result.hits.map(hit => files.get(hit.id))).size).toBe(4);
    expect(files.get(result.hits[0]!.id)).toBe('Crowded.lean');
    expect(result).toMatchObject({ resultGrouping: 'module', total: 44, totalModules: 5 });
    expect(index.search(request, { limit: 4 })[0]).toEqual(ordinary);
  });

  it('keeps distinct contextual modules and prevents relation recall from duplicating a selected module', () => {
    const seed = entry('Visible.seed', 'Wanted', { file: 'Seed.lean' }),
      sibling = entry('Hidden.sibling', 'Opaque', { file: seed.file }),
      bridge = entry('Hidden.bridge', 'Opaque', { file: 'Bridge.lean' }),
      other = entry('Visible.other', 'Wanted', { file: seed.file, contextDigest: mathDigest('other-module-context') });
    seed.dependencies.proof.push(reference(sibling), reference(bridge));
    const base = catalog([seed, sibling, bridge, other]);
    base.contexts[context] = { [seed.file]: mathDigest('seed'), [bridge.file]: mathDigest('bridge') };
    base.contexts[other.contextDigest] = { [other.file]: mathDigest('other-seed') };
    const result = compare(base, [{ query: '', goal: 'Wanted' }], { limit: 3, resultGrouping: 'module' })[0]!;
    expect(new Set(result.hits.map(hit => hit.id))).toEqual(new Set([seed.id, other.id, bridge.id]));
    expect(result.hits.find(hit => hit.id === bridge.id)?.relation).toBeDefined();
    expect(result.totalModules).toBe(3);
  });

  it.each(['dependency', 'consumer'] as const)('recalls a %s outside lexical postings with every contextual version', direction => {
    const bridge = entry('Hidden.bridge'), seed = entry('Visible.seed', 'Wanted'),
      otherVersion = entry(bridge.name, bridge.type, { id: mathDigest('other-version'), contextDigest: mathDigest('other-context') }),
      proofVariant = entry(bridge.name, bridge.type, { id: mathDigest('other-proof'), contextDigest: mathDigest('other-proof-context'),
        declaration: 'theorem Hidden.bridge : Opaque := alternate' });
    bridge.provenance[0]!.problemReceiptDigest = receipt;
    if (direction === 'dependency') seed.dependencies.proof.push(reference(bridge));
    else bridge.dependencies.statement.push(reference(seed));
    const results = compare(catalog([seed, bridge, otherVersion, proofVariant]), [{ query: '', goal: 'Wanted' }],
      { displayGrouping: 'exact-interface', limit: 12, problemReceiptDigest: receipt });
    const hit = results[0]!.hits.find(item => item.id === bridge.id)!;
    expect(hit).toMatchObject({ matched: [], relation: { direction }, declarationVariantCount: 2, versionCount: 2 });
    expect(new Set(hit.versions.map(version => version.id))).toEqual(new Set([bridge.id, otherVersion.id]));
  });

  it('selects preferred graph versions before accepting an edge and preserves full-base ambiguity', () => {
    const bridge = entry('Hidden.bridge'), seed = entry('Visible.seed', 'Wanted', {
      dependencies: { statement: [], proof: [reference(bridge)], tasks: [], coverage: 'recorded' } }),
      preferred = entry(bridge.name, bridge.type, { id: mathDigest('preferred'), contextDigest: mathDigest('preferred-context'),
        provenance: [{ ...bridge.provenance[0]!, problemReceiptDigest: receipt }] });
    const selected = compare(catalog([seed, bridge, preferred]), [{ query: '', goal: 'Wanted' }],
      { displayGrouping: 'exact-interface', problemReceiptDigest: receipt });
    expect(selected[0]!.relationSearch.considered).toBe(1);
    expect(selected[0]!.hits.map(hit => hit.id)).toEqual([seed.id]);
    const duplicate = entry(bridge.name, 'DifferentType', { provenance: [{ ...bridge.provenance[0]!, problemId: 'foreign' }] });
    const ambiguous = compare(catalog([seed, bridge, duplicate]), [{ query: '', goal: 'Wanted' }], { problemId: 'fixture' });
    expect(ambiguous[0]!.relationSearch.unresolved.some(item => item.resolution === 'ambiguous')).toBe(true);
    expect(ambiguous[0]!.hits.map(hit => hit.id)).toEqual([seed.id]);
  });

  it('isolates entry fields, nested provenance, dependency references and contexts from later caller edits', () => {
    const bridge = entry('Hidden.bridge'), seed = entry('Visible.seed', 'Wanted', {
      dependencies: { statement: [], proof: [reference(bridge)], tasks: [], coverage: 'recorded' } });
    const base = catalog([seed, bridge]), options = { displayGrouping: 'exact-interface' as const, problemId: 'fixture' };
    const index = createTheoremKnowledgeSearchIndex(base, options), requests = [{ query: '', goal: 'Wanted' }];
    const before = index.search(requests);
    seed.type = 'ChangedType'; seed.name = 'Changed.seed'; seed.description = 'changed';
    seed.provenance[0]!.problemId = 'changed'; seed.provenance[0]!.receiptIds.push('changed');
    seed.dependencies.proof[0]!.name = 'Changed.bridge';
    base.contexts[context]!['Library.lean'] = '';
    base.entries.push(entry('New.entry', 'Wanted'));
    options.problemId = 'changed';
    expect(index.search(requests)).toEqual(before);
    expect(searchTheoremKnowledgeRequests(base, requests, { problemId: 'fixture' })).not.toEqual(before);
    const result = index.search(requests);
    result[0]!.hits[0]!.versions[0]!.problemIds.push('caller-result-edit');
    result[0]!.relationSearch.seedIds.push('caller-result-edit');
    expect(index.search(requests)).toEqual(before);
  });

  it('reads original metadata once and never accesses archived source objects', () => {
    const item = entry('Saved.reusable', 'Wanted'), declaration = item.declaration;
    let declarationReads = 0, sourceReads = 0;
    Object.defineProperty(item, 'declaration', { enumerable: true, get: () => { declarationReads++; return declaration; } });
    const base = catalog([item]);
    Object.defineProperty(base, 'sources', { enumerable: true, get: () => { sourceReads++; throw new Error('must not read sources'); } });
    const index = createTheoremKnowledgeSearchIndex(base);
    expect(declarationReads).toBe(1);
    for (let round = 0; round < 4; round++) expect(index.search([{ query: '', goal: 'Wanted' }])[0]!.hits[0]!.id).toBe(item.id);
    expect(declarationReads).toBe(1);
    expect(sourceReads).toBe(0);
  });

  it('keeps repeated selective lookups equal over a large unrelated corpus without rereading entries', () => {
    let reads = 0;
    const rows = Array.from({ length: 4000 }, (_, i) => {
      const item = entry(`Unrelated.area${i}`, `OtherPredicate${i}`), declaration = item.declaration;
      Object.defineProperty(item, 'declaration', { enumerable: true, get: () => { reads++; return declaration; } });
      return item;
    });
    const desired = entry('Saved.target', 'WantedPredicate'), base = catalog([...rows, desired]),
      requests = [{ query: 'WantedPredicate' }, { query: 'Saved.target' }, { query: '', goal: 'WantedPredicate' }];
    const expected = searchTheoremKnowledgeRequests(base, requests), index = createTheoremKnowledgeSearchIndex(base);
    const initialReads = reads;
    for (let round = 0; round < 6; round++) expect(index.search(requests)).toEqual(expected);
    expect(reads).toBe(initialReads);
    expect(expected.every(result => result.hits[0]!.id === desired.id)).toBe(true);
  });

  it('returns independent repeated results and validates every request and preference', () => {
    const index = createTheoremKnowledgeSearchIndex(catalog([entry('Saved.target', 'Wanted')])), request = { query: 'Wanted' };
    const results = index.search([request, request]);
    expect(results[0]).toEqual(results[1]);
    results[0]!.hits[0]!.matched.push('caller-edit');
    expect(results[1]!.hits[0]!.matched).not.toContain('caller-edit');
    expect(index.search([request, { query: 'Wanted', goal: null as unknown as string }])[0])
      .toEqual(index.search([request])[0]);
    for (const requests of [[], Array(9).fill(request), [request, { query: '' }],
      [request, { query: 'x'.repeat(4001) }], [request, { query: '', goal: 'x'.repeat(16001) }], [null]])
      expect(() => index.search(requests as KnowledgeSearchRequest[])).toThrow('math_knowledge_invalid_query');
    for (const options of [{ limit: 0 }, { limit: 33 }, { environmentDigest: '' }, { problemReceiptDigest: 'x'.repeat(257) },
      { resultGrouping: 'file' } as unknown as KnowledgeSearchOptions])
      expect(() => index.search([request], options)).toThrow('math_knowledge_invalid_query');
  });
});
