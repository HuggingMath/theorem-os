import { describe, expect, it } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { installedLibraryRetrievals } from '../src/solver/installedLibraryContext';
import { knowledgeContextSections, type KnowledgeContextSnapshot } from '../src/solver/knowledgeContext';
import { prepareLibraryApplication } from '../src/solver/libraryApplication';
import type { SolverProblem } from '../src/solver/problem';
import { taskVersion, type CooperativeAction, type CooperativeTask } from '../src/solver/tasks';
import type { TheoremKnowledgeEntry } from '../src/solver/theoremKnowledge';
import { buildKnowledgeRouteFindings, searchKnowledgeRouteFindings, type KnowledgeRouteFinding } from '../src/solver/theoremKnowledgeFindings';
import { searchTheoremKnowledge } from '../src/solver/theoremKnowledgeSearch';

const environmentDigest = mathDigest('relevance-test-environment');
const file = 'Submission/Library/Fixture/Support.lean', fileDigest = mathDigest('frozen-library-source');
function entry(name: string, type: string): TheoremKnowledgeEntry {
  return { id: mathDigest(name + type), contextDigest: mathDigest('context'), name, file, type,
    typeKind: 'closed-task-type', kind: 'lemma', description: '', premises: [],
    declaration: `theorem ${name.split('.').at(-1)} : ${type} := by exact archived_proof`,
    dependencies: { statement: [], proof: [], tasks: [], coverage: 'unavailable' },
    provenance: [{ kind: 'solver-check', problemId: 'another-problem', source: '/archive/state.json',
      sourceDigest: mathDigest('archived-state'), receiptIds: ['historical-receipt'] }] };
}
function snapshot(entries: TheoremKnowledgeEntry[], routeFindings: KnowledgeRouteFinding[] = []): KnowledgeContextSnapshot {
  return { digest: mathDigest('catalog'), base: { entries, routeFindings, evidence: 'recorded-not-replayed',
    contexts: { [mathDigest('context')]: { [file]: fileDigest } } } };
}
function consumer(type: string) {
  const task: CooperativeTask = { id: 'bridge', kind: 'lemma', type, objective: 'Prove the assigned bridge.',
    theoremName: 'Current.bridge', proofPath: 'Submission.lean', revision: 0, dependsOn: [] };
  const action: CooperativeAction = { kind: 'task', task,
    assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: 'fixture', seedCommit: 'a'.repeat(40) } };
  const problem = { projectRelative: 'generated/fixture', baseCommit: 'a'.repeat(40), receiptDigest: mathDigest('current-problem'),
    targets: [], declarations: {}, frozenFiles: { [file]: fileDigest },
    contract: { problemId: 'current-problem', formalStatement: type, informalStatement: 'Prove the assigned bridge.' },
  } as unknown as SolverProblem;
  return { task, action, problem, environmentDigest };
}
const packet = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1));

function finding(statement: string, summary: string) {
  const notes = 'Recorded reasoning is advisory and must be reviewed in the current setting.';
  return buildKnowledgeRouteFindings([{ evidence: 'recorded-advisory-not-replayed', acceptance: 'not-assessed',
    conclusion: 'refuted', summary, finding: summary, notes,
    scope: { problemId: 'another-problem', problemReceiptDigest: mathDigest('another-problem'), environmentDigest,
      source: { kind: 'research', statementKind: 'research-objective', statement, premises: [] }, dependencies: [] },
    evidenceRefs: [], obstructions: [], remainingObligations: ['The original theorem still requires proof.'], reconsiderWhen: [],
    provenance: { source: '/archive/state.json', sourceDigest: mathDigest('archive'), runId: 'historical', taskId: 'investigation',
      taskDigest: mathDigest(statement), groupId: 'main', deliveryId: 'delivery', sourceCommit: 'b'.repeat(40),
      findingDigest: mathDigest(summary), notesDigest: mathDigest(notes) } }])[0]!;
}

describe('automatic mathematical relevance boundaries', () => {
  it('keeps carrier-only raw recall without displaying or automatically applying it', async () => {
    const support = entry('Saved.square_nonnegative', 'forall (x : Real), 0 ≤ x ^ 2');
    const f = consumer('forall (x : Real), SuperpolynomialDecay x'), knowledge = snapshot([support]);
    const raw = searchTheoremKnowledge(knowledge.base, '', { goal: f.task.type });
    expect(raw.hits).toEqual([expect.objectContaining({ id: support.id, lowInformationMatch: true })]);
    const [section] = knowledgeContextSections({ ...f, knowledge });
    expect(section!.knowledge).toMatchObject({ searchCandidateIds: [support.id], relevantCandidateIds: [], candidateIds: [] });
    expect(packet(section!.text).candidates).toEqual([]);
    const [retrieval] = installedLibraryRetrievals({ ...f, library: knowledge, forApplication: true });
    expect(retrieval).toMatchObject({ searchCandidateIds: [support.id], relevantCandidateIds: [], candidateIds: [] });
    expect(await prepareLibraryApplication({ ...f, library: knowledge, worktree: '/unused-relevance-fixture',
      seedCommit: f.problem.baseCommit })).toMatchObject({ status: 'skipped', reason: 'no-matching-installed-theorem', candidates: [] });
  });

  it('retains the ordinary arithmetic reflexivity utility when the target has no specific predicate', () => {
    const utility = entry('Saved.reflexivity', 'forall (n : Nat), n = n');
    const f = consumer('forall (n : Nat), n + 0 = n'), knowledge = snapshot([utility]);
    expect(searchTheoremKnowledge(knowledge.base, '', { goal: f.task.type }).hits)
      .toEqual([expect.objectContaining({ id: utility.id, lowInformationMatch: false })]);
    const [retrieval] = installedLibraryRetrievals({ ...f, library: knowledge, forApplication: true });
    expect(retrieval!.candidateIds).toEqual([utility.id]);
  });

  it('puts an entropy interface before unrelated declarations in an entropy namespace', () => {
    const desired = entry('MatchingEntropy.entropy_closing',
      'forall (p : ProbabilityMass), discreteEntropy p ≤ entropyUpperBound p');
    const noise = Array.from({ length: 14 }, (_, index) => entry(`MatchingEntropy.TriangleFace.cutMass_${index}`,
      'forall (w : Finset Edge), cutMass w = cutMass w'));
    const f = consumer('forall (p : ProbabilityMass) (hp : IsNormalized p), discreteEntropy p ≤ entropyUpperBound p');
    const knowledge = snapshot([...noise, desired]);
    const [section] = knowledgeContextSections({ ...f, knowledge });
    expect(section!.knowledge.candidateIds[0]).toBe(desired.id);
    expect(section!.knowledge.candidateIds.some(id => noise.some(item => item.id === id))).toBe(false);
    expect(packet(section!.text).requiresFreshCheck).toBe(true);
  });

  it('keeps transferable mathematical refutations while excluding shared work instructions', () => {
    const relevant = finding('Investigate covariance concentration and the variance lower bound.',
      'Covariance concentration alone does not imply the variance lower bound.');
    const unrelated = finding('Check the frozen statement and record source evidence for every original task over Real and Finset.',
      'Check the original frozen statements; record evidence and report the source, task and goal.');
    const knowledge = snapshot([], [unrelated, relevant]);
    expect(searchKnowledgeRouteFindings(knowledge.base, 'check frozen statement record evidence').hits)
      .toContainEqual(expect.objectContaining({ id: unrelated.id }));
    const query = 'Investigate covariance concentration and variance lower bounds; check frozen statements and record source evidence.';
    const selected = searchKnowledgeRouteFindings(knowledge.base, query,
      { requireMathematicalRelevance: true, problemReceiptDigest: mathDigest('current-problem') });
    expect(selected.hits).toEqual([expect.objectContaining({ id: relevant.id, conclusion: 'refuted',
      acceptance: 'not-assessed', problemReceiptMatch: 'different', requiresScopeReview: true })]);
    const f = consumer('UnusedTarget');
    const task: CooperativeTask = { id: 'investigate', kind: 'research', objective: query, revision: 0, dependsOn: [] };
    const action: CooperativeAction = { kind: 'task', task, assignment: { taskId: task.id, taskDigest: taskVersion(task),
      workerId: 'fixture', seedCommit: f.problem.baseCommit } };
    const [section] = knowledgeContextSections({ ...f, action, knowledge });
    expect(section!.knowledge.routeFindingIds).toEqual([relevant.id]);
    expect(section!.knowledge.candidateIds).toEqual([]);
    expect(section!.text).not.toContain(unrelated.id);
  });

  it('requires more than two generic mathematical words in a long research objective', () => {
    const relevant = finding('Investigate independent configurations on a circle that are Ramsey.',
      'The circle geometry is available; an independent non-Ramsey certificate remains unproved.');
    const unrelated = finding('Audit independent one dimensional constituents in permutation representations.',
      'The independent dimensional representation calculation still has an obstruction.');
    const knowledge = snapshot([], [relevant, unrelated]);
    const query = 'Investigate spherical quadratically independent configurations, Ramsey criteria, circle geometry, ' +
      'Veronese embeddings and dimensional interpolation through hyperplane traces.';
    expect(searchKnowledgeRouteFindings(knowledge.base, query, { requireMathematicalRelevance: true }).hits)
      .toEqual([expect.objectContaining({ id: relevant.id })]);
    // A focused lookup remains able to find the old representation investigation.
    expect(searchKnowledgeRouteFindings(knowledge.base, 'independent dimensional', { requireMathematicalRelevance: true }).hits)
      .toContainEqual(expect.objectContaining({ id: unrelated.id }));
  });
});
