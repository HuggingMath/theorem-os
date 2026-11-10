import { describe, expect, it } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { LeanResidualGoal } from '../src/math/leanResidualGoals';
import { knowledgeContextSections, type KnowledgeContextSnapshot } from '../src/solver/knowledgeContext';
import type { SolverProblem } from '../src/solver/problem';
import type { TheoremKnowledgeEntry } from '../src/solver/theoremKnowledge';
import { createKnowledgeRelationIndex } from '../src/solver/theoremKnowledgeRelations';
import { searchTheoremKnowledge, searchTheoremKnowledgeRequests } from '../src/solver/theoremKnowledgeSearch';
import { taskVersion, type CooperativeTask } from '../src/solver/tasks';

const environment = mathDigest('environment'), context = mathDigest('context'), receipt = mathDigest('receipt');
function entry(name: string, overrides: Partial<TheoremKnowledgeEntry> = {}): TheoremKnowledgeEntry {
  return { id: mathDigest(name), name, file: 'Library.lean', type: 'Opaque', typeKind: 'closed-task-type', kind: 'lemma',
    description: '', premises: [], declaration: `theorem ${name} : Opaque := by exact fixture`,
    contextDigest: context, environmentDigest: environment,
    dependencies: { statement: [], proof: [], tasks: [], coverage: 'recorded' },
    provenance: [{ kind: 'solver-check', problemId: 'fixture', source: 'fixture', sourceDigest: mathDigest('source'),
      receiptIds: [], environmentDigest: environment }], ...overrides };
}
const reference = (item: TheoremKnowledgeEntry) => ({ file: item.file, name: item.name });
const catalog = (entries: TheoremKnowledgeEntry[]): KnowledgeContextSnapshot['base'] => ({ entries,
  evidence: 'recorded-not-replayed', contexts: Object.fromEntries([...new Set(entries.map(item => item.contextDigest))]
    .map(digest => [digest, { 'Library.lean': mathDigest(digest) }])) });
const goal = 'Wanted';
function retrievalFixture() {
  const bridge = entry('Hidden.bridge'), seed = entry('Visible.seed', { type: goal,
    dependencies: { statement: [], proof: [reference(bridge)], tasks: [], coverage: 'unavailable' } });
  const alternatives = Array.from({ length: 6 }, (_, index) => entry(`Visible.choice${index}`, { type: `Premise${index} → Wanted` }));
  return { seed, bridge, base: catalog([seed, bridge, ...alternatives]) };
}
const options = { goal, limit: 12, displayGrouping: 'exact-interface' as const, environmentDigest: environment };
const task: CooperativeTask = { id: 'consumer', kind: 'lemma', objective: 'Prove the assigned target', revision: 0,
  dependsOn: [], type: goal, theoremName: 'Current.consumer', proofPath: 'Submission.lean' };
const problem = { contract: { formalStatement: 'fixture' }, receiptDigest: receipt, targets: [], declarations: {} } as unknown as SolverProblem;
function sections(base: KnowledgeContextSnapshot['base'], residualGoals?: LeanResidualGoal[]) {
  return knowledgeContextSections({ problem, environmentDigest: environment, knowledge: { digest: mathDigest('catalog'), base },
    action: { kind: 'task', task } as never, residualGoals });
}
const packet = (section: ReturnType<typeof sections>[number]) => JSON.parse(section.text.slice(section.text.indexOf('\n') + 1));
function residual(goalText: string): LeanResidualGoal {
  return { authority: 'advisory-lean-process', consumer: { taskId: task.id, taskDigest: taskVersion(task),
    theoremName: task.theoremName!, proofPath: task.proofPath! }, goalText,
    sourceDigest: mathDigest('current-source'), environmentDigest: environment, toolIdentity: mathDigest('tool'),
    artifact: { path: '.lake/fixture.json', digest: mathDigest('artifact') }, file: task.proofPath!, line: 1, column: 0 };
}

describe('scoped recorded-relation recall', () => {
  it('recalls a theorem with no goal overlap and preserves the exact type hit and lexical pool', () => {
    const { base, seed, bridge } = retrievalFixture();
    const result = searchTheoremKnowledge(base, '', options);
    expect(result.hits[0]).toMatchObject({ id: seed.id, exactMatch: 'type' });
    expect(result.hits).toHaveLength(8);
    expect(result.hits.find(hit => hit.id === bridge.id)).toMatchObject({ matched: [], relation: {
      seedId: seed.id, entryId: bridge.id, direction: 'dependency', kind: 'proof', coverage: 'unavailable',
      referenceSemantics: 'local-transitive-closure',
    } });
    expect(result.hits.filter(hit => hit.relation)).toHaveLength(1);
    expect(result.requiresFreshCheck).toBe(true);
  });

  it('inverts existing references without treating their transitive closure as a direct proof step', () => {
    const seed = entry('Visible.seed', { type: goal }), consumer = entry('Hidden.consumer', {
      dependencies: { statement: [reference(seed)], proof: [], tasks: [], coverage: 'recorded' } });
    const result = searchTheoremKnowledge(catalog([seed, consumer]), '', options);
    expect(result.hits.find(hit => hit.id === consumer.id)?.relation).toMatchObject({
      seedId: seed.id, direction: 'consumer', kind: 'statement', referenceSemantics: 'local-transitive-closure',
    });
  });

  it('preserves a qualified-name hit and does not join two unknown environments', () => {
    const { base, seed, bridge } = retrievalFixture();
    const named = searchTheoremKnowledge(base, seed.name, { ...options, goal: undefined, limit: 3 });
    expect(named.hits[0]).toMatchObject({ id: seed.id, exactMatch: 'name' });
    seed.environmentDigest = undefined; bridge.environmentDigest = undefined;
    const unknown = searchTheoremKnowledge(base, '', options);
    expect(unknown.hits.some(hit => hit.id === bridge.id)).toBe(false);
    expect(unknown.relationSearch.unresolved.some(item => item.resolution === 'unknown-environment')).toBe(true);
  });

  it.each(['different-context', 'different-environment', 'unknown-environment'])('does not join %s', change => {
    const { base, bridge } = retrievalFixture();
    if (change === 'different-context') bridge.contextDigest = mathDigest('elsewhere');
    if (change === 'different-environment') bridge.environmentDigest = mathDigest('another-environment');
    if (change === 'unknown-environment') bridge.environmentDigest = undefined;
    expect(searchTheoremKnowledge(base, '', options).hits.some(hit => hit.id === bridge.id)).toBe(false);
  });

  it('retains missing, unindexed and ambiguous reference reasons without fabricating target nodes', () => {
    const duplicate = entry('Ambiguous'), alias = entry('Ambiguous', { id: mathDigest('ambiguous-version'), type: 'OtherType' });
    const seed = entry('Visible.seed', { type: goal, dependencies: { statement: [], proof: [
      { file: 'Missing.lean', name: 'Missing' }, { file: 'Library.lean', name: 'NotIndexed' }, reference(duplicate),
    ], tasks: [], coverage: 'recorded' } });
    const result = searchTheoremKnowledge(catalog([seed, duplicate, alias]), '', options);
    expect(result.hits.map(hit => hit.id)).toEqual([seed.id]);
    expect(result.relationSearch.unresolved.map(item => item.resolution)).toEqual(['missing-source', 'source-available', 'ambiguous']);
  });

  it('chooses the seed version before expanding and rechecks the selected candidate version', () => {
    const bridge = entry('Hidden.bridge'), oldSeed = entry('Visible.seed', { id: mathDigest('old-seed'), type: goal,
      dependencies: { statement: [], proof: [reference(bridge)], tasks: [], coverage: 'recorded' } });
    const newSeed = entry('Visible.seed', { id: mathDigest('new-seed'), type: goal, contextDigest: mathDigest('new-context'),
      provenance: [{ ...oldSeed.provenance[0], problemReceiptDigest: receipt }] });
    const selectedSeed = searchTheoremKnowledge(catalog([oldSeed, newSeed, bridge]), '', { ...options, problemReceiptDigest: receipt });
    expect(selectedSeed.hits[0].id).toBe(newSeed.id);
    expect(selectedSeed.hits.some(hit => hit.id === bridge.id)).toBe(false);

    const preferredBridge = entry('Hidden.bridge', { id: mathDigest('preferred-bridge'), contextDigest: mathDigest('new-context'),
      provenance: [{ ...bridge.provenance[0], problemReceiptDigest: receipt }] });
    const selectedCandidate = searchTheoremKnowledge(catalog([oldSeed, bridge, preferredBridge]), '', { ...options, problemReceiptDigest: receipt });
    expect(selectedCandidate.relationSearch.considered).toBe(1);
    expect(selectedCandidate.hits.map(hit => hit.id)).toEqual([oldSeed.id]);
  });

  it('checks ambiguity against the full catalog before filtering by problem', () => {
    const { base, bridge } = retrievalFixture();
    base.entries.push(entry(bridge.name, { id: mathDigest('other-problem'), type: 'OtherType',
      provenance: [{ ...bridge.provenance[0], problemId: 'another-problem' }] }));
    const result = searchTheoremKnowledge(base, '', { ...options, problemId: 'fixture' });
    expect(result.hits.some(hit => hit.id === bridge.id)).toBe(false);
    expect(result.relationSearch.unresolved.some(item => item.resolution === 'ambiguous')).toBe(true);
  });

  it('keeps lexical hits identical when metadata is missing or there are no qualifying edges', () => {
    const { base } = retrievalFixture();
    base.entries.forEach(item => { item.dependencies = { statement: [], proof: [], tasks: [], coverage: 'unavailable' }; });
    const withMetadata = searchTheoremKnowledge(base, '', options);
    const withoutMetadata = searchTheoremKnowledge({ entries: base.entries, evidence: base.evidence }, '', options);
    expect(withMetadata.hits).toEqual(withoutMetadata.hits);
    expect(withMetadata.hits).toHaveLength(7);
    expect(withMetadata.hits.some(hit => hit.relation)).toBe(false);
  });

  it('bounds graph expansion and preserves independent results for repeated requests', () => {
    const targets = Array.from({ length: 20 }, (_, index) => entry(`Hidden.target${index}`));
    const seed = entry('Visible.seed', { type: goal, dependencies: { statement: [], proof: targets.map(reference), tasks: [], coverage: 'recorded' } });
    const base = catalog([seed, ...targets]);
    const expansion = createKnowledgeRelationIndex(base).expand([seed.id], 12);
    expect(expansion.relations).toHaveLength(12); expect(expansion.truncated).toBe(true);
    const results = searchTheoremKnowledgeRequests(base, [{ query: '', goal }, { query: '', goal }], options);
    expect(results[0]).toEqual(results[1]);
    results[0].hits[0].matched.push('changed');
    expect(results[1].hits[0].matched).not.toContain('changed');
  });
});

describe('knowledge pool and display limits', () => {
  it('records a larger retrieval pool while displaying at most three candidates and one relation', () => {
    const { base, seed, bridge } = retrievalFixture(), output = sections(base), visible = packet(output[0]);
    expect(output[0].knowledge.searchCandidateIds).toHaveLength(8);
    expect(visible).toMatchObject({ candidateLimit: 3, poolLimit: 12, requiresFreshCheck: true });
    expect(visible.candidates).toHaveLength(3);
    expect(visible.candidates[0].id).toBe(seed.id);
    expect(visible.candidates.find((item: { id: string }) => item.id === bridge.id)?.relation.seedId).toBe(seed.id);
    expect(Buffer.byteLength(output[0].text)).toBeLessThanOrEqual(4096);
  });

  it('protects all exact type hits before allocating a relation slot', () => {
    const { base, bridge } = retrievalFixture();
    base.entries.push(entry('Visible.exactOne', { type: goal }), entry('Visible.exactTwo', { type: goal }));
    const visible = packet(sections(base)[0]);
    expect(visible.candidates).toHaveLength(3);
    expect(visible.candidates.every((item: { exactMatch?: string }) => item.exactMatch === 'type')).toBe(true);
    expect(visible.candidates.some((item: { id: string }) => item.id === bridge.id)).toBe(false);
  });

  it('preserves one first candidate per residual case ahead of relationship alternatives', () => {
    const bridges = Array.from({ length: 3 }, (_, index) => entry(`Hidden.bridge${index}`));
    const seeds = bridges.map((bridge, index) => entry(`Visible.seed${index}`, { type: ['Alpha', 'Beta', 'Gamma'][index],
      dependencies: { statement: [], proof: [reference(bridge)], tasks: [], coverage: 'recorded' } }));
    const output = sections(catalog([...seeds, ...bridges]), [residual('case a\n⊢ Alpha\ncase b\n⊢ Beta\ncase c\n⊢ Gamma')]);
    expect(new Set(output[0].knowledge.candidateIds)).toEqual(new Set(seeds.map(seed => seed.id)));
    expect(output[0].knowledge.residualSearches?.filter(search => search.searched)).toHaveLength(3);
    expect(Buffer.byteLength(output[0].text)).toBeLessThanOrEqual(4096);
  });

  it('keeps eight requests and the byte bound even with more cases and long Unicode types', () => {
    const entries = Array.from({ length: 10 }, (_, index) => entry(`Visible.case${index}`, { type: `Target${index}` }));
    const text = entries.map((_, index) => `case branch${index}\n⊢ Target${index}`).join('\n');
    const output = sections(catalog(entries), [residual(text)]);
    expect(output[0].knowledge.residualSearches?.filter(search => search.searched)).toHaveLength(8);
    expect(output[0].knowledge.residualSearches?.filter(search => !search.searched)).toHaveLength(2);
    expect(output[0].knowledge.candidateIds.length).toBeLessThanOrEqual(3);
    expect(Buffer.byteLength(output[0].text)).toBeLessThanOrEqual(4096);
    const long = catalog(Array.from({ length: 5 }, (_, index) => entry(`Visible.long${index}`, { type: `Wanted → ${'长'.repeat(900)}${index}` })));
    for (const section of sections(long)) expect(Buffer.byteLength(section.text)).toBeLessThanOrEqual(4096);
  });
});
