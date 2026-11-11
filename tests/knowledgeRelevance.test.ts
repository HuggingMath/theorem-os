import { describe, expect, it } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { installedLibraryRetrievals } from '../src/solver/installedLibraryContext';
import { knowledgeContextSections, type KnowledgeContextSnapshot } from '../src/solver/knowledgeContext';
import { prepareLibraryApplication } from '../src/solver/libraryApplication';
import type { SolverProblem } from '../src/solver/problem';
import { taskVersion, type CooperativeAction, type CooperativeTask } from '../src/solver/tasks';
import type { TheoremKnowledgeEntry } from '../src/solver/theoremKnowledge';
import { buildKnowledgeRouteFindings, searchKnowledgeRouteFindings, type KnowledgeRouteFinding } from '../src/solver/theoremKnowledgeFindings';
import { knowledgeApplicationRelevant, searchTheoremKnowledge } from '../src/solver/theoremKnowledgeSearch';

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

function finding(statement: string, summary: string,
  statementKind: 'research-objective' | 'closed-task-type' | 'source-header' = 'research-objective') {
  const notes = 'Recorded reasoning is advisory and must be reviewed in the current setting.';
  return buildKnowledgeRouteFindings([{ evidence: 'recorded-advisory-not-replayed', acceptance: 'not-assessed',
    conclusion: 'refuted', summary, finding: summary, notes,
    scope: { problemId: 'another-problem', problemReceiptDigest: mathDigest('another-problem'), environmentDigest,
      source: { kind: statementKind === 'research-objective' ? 'research' : 'lemma', statementKind, statement, premises: [] }, dependencies: [] },
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

  it('does not apply a norm bound because a namespace and conversion contain fragments of the goal predicates', async () => {
    const support = { ...entry('TheoremOS.RepresentationTheory.IsUnitaryRepresentation.opNorm_le_one',
      'opNorm_le_one (hρ : IsUnitaryRepresentation ρ) (g : G) : ‖LinearMap.toContinuousLinearMap (ρ g)‖ ≤ 1'),
      typeKind: 'source-header' as const };
    // The real time-continuity failure shared Continuous only inside toContinuousLinearMap,
    // and unitary only inside IsUnitaryRepresentation. Neither is the candidate's conclusion.
    const goal = '∀ {H : Type*} [NormedAddCommGroup H] [InnerProductSpace ℂ H] [CompleteSpace H] ' +
      '(D : SpectralCalculus H) {I : Set ℝ}, IsCompact I → ∀ {h : H}, ' +
      'D.HasSpectralSupport I h → Continuous (fun t : ℝ => D.unitary t h)';
    const f = consumer(goal), knowledge = snapshot([support]);
    expect(knowledgeApplicationRelevant(support, goal)).toBe(false);
    expect(searchTheoremKnowledge(knowledge.base, support.name).hits[0]!.id).toBe(support.id);
    const [retrieval] = installedLibraryRetrievals({ ...f, library: knowledge, forApplication: true });
    expect(retrieval!.relevantCandidateIds ?? retrieval!.searchCandidateIds).toEqual([]);
    expect(await prepareLibraryApplication({ ...f, library: knowledge, worktree: '/unused-relevance-fixture',
      seedCommit: f.problem.baseCommit })).toMatchObject({ status: 'skipped', reason: 'no-matching-installed-theorem', candidates: [] });
    // A worker's explicit named request still authorizes a bounded application check.
    expect(installedLibraryRetrievals({ ...f, library: knowledge, forApplication: true,
      taskText: `Use ${support.name}.` })[0]!.candidateIds).toEqual([support.id]);
  });

  it('matches whole conclusion predicates while retaining renamed lambda binders and genuine continuity lemmas', () => {
    const goal = '∀ (D : SpectralCalculus H) (h : H), Continuous (fun time : ℝ => D.unitary time h)';
    const usable = entry('Saved.continuous_orbit',
      '∀ (D : SpectralCalculus H) (h : H), HasControl D → Continuous (fun parameter : ℝ => D.unitary parameter h)');
    const premiseOnly = entry('Saved.Continuous.unitary_norm',
      '∀ (D : SpectralCalculus H) (h : H), Continuous (fun time : ℝ => D.unitary time h) → ‖h‖ ≤ 1');
    expect(knowledgeApplicationRelevant(usable, goal)).toBe(true);
    expect(knowledgeApplicationRelevant(premiseOnly, goal)).toBe(false);
    expect(knowledgeApplicationRelevant(entry('Saved.IsCompact.use', 'IsCompactlyGeneratedSpace X'), 'IsCompact X')).toBe(false);
    expect(knowledgeApplicationRelevant(entry('Saved.bound', 'tight_bound_extended x'), 'tight_bound x')).toBe(false);
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

  it('keeps carrier typeclasses out of automatic findings without hiding exact contracts or mathematical class goals', () => {
    const assumptions = '∀ {H : Type*} [NormedAddCommGroup H] [InnerProductSpace ℂ H] [CompleteSpace H] ';
    const goal = assumptions + '(D : SpectralCalculus H) {I J : Set ℝ} {h k : H}, ' +
      'D.HasSpectralSupport I h → D.HasSpectralSupport J k → D.HasSpectralSupport (I ∪ J) (h + k)';
    const noise = finding(assumptions + '(A : H →L[ℂ] H), spectrum ℂ A ⊆ numericalClosure A',
      'The spectrum inclusion draft is still missing a numerical-range estimate. ' + 'Archived detail. '.repeat(100), 'closed-task-type');
    const exact = finding(goal, 'The spectral support addition step needs a uniform spectral estimate.', 'closed-task-type');
    const utility = entry('Saved.band_add', goal), knowledge = snapshot([utility], [noise]);
    const f = consumer(goal), [section] = knowledgeContextSections({ ...f, knowledge });
    expect(section!.knowledge.routeFindingIds).toEqual([]);
    expect(section!.knowledge.candidateIds).toEqual([utility.id]);
    expect(packet(section!.text).omittedForBytes).toBe(0);
    expect(searchKnowledgeRouteFindings(knowledge.base, 'NormedAddCommGroup InnerProductSpace CompleteSpace').hits)
      .toContainEqual(expect.objectContaining({ id: noise.id }));
    expect(searchKnowledgeRouteFindings(snapshot([], [noise, exact]).base, '',
      { goal, requireMathematicalRelevance: true }).hits.map(hit => hit.id)).toEqual([exact.id]);
    const classGoal = '∀ (E : Type*) [NormedAddCommGroup E], CompleteSpace E';
    const completion = finding('∀ (X : Type*) [NormedAddCommGroup X], CompleteSpace X',
      'Completeness follows from the Cauchy construction.', 'closed-task-type');
    expect(searchKnowledgeRouteFindings(snapshot([], [completion]).base, '',
      { goal: classGoal, requireMathematicalRelevance: true }).hits[0]!.id).toBe(completion.id);
  });

  it.each([
    {
      query: 'Identify the variance tail mechanism for fixed B from the exact second-moment count. ' +
        'Group assignments by Hamming distance, validate the proposed tail bound against scaling data, ' +
        'and deliver exact closed Lean statements whose application closes the consumer.',
      statement: 'Capacity decomposition: keep the consumer fixed. Publish proposed exact closed Lean types with ' +
        'existing input dependencies in this group. Explain their application to the consumer and record the data.',
      summary: 'A sheet-flow decomposition remains unproved; the closed node types and fixed data are recorded.',
      relevant: 'The variance second-moment tail estimate does not yet control Hamming-distance correlations.',
      manual: 'fixed proposed data closed application',
    },
    {
      query: 'Reconstruct the geodesic Hessian route from GeodesicConstantSpeedAC and SecondDerivativeIntegral. ' +
        'Use a scratch harness under .scratch/tmp, record the discriminating test and deliverable, ' +
        'then locate Gamma-calculus / test-function-density material and the remaining inference.',
      statement: 'Determine optimal-transport existence. Deliverable: a Lean-checked statement in a scratch file ' +
        'under .scratch/tmp about densityMeasure. Report the discriminating test on an identity optimal map.',
      summary: 'The optimal map existence layer still lacks a minimizer for density measures.',
      relevant: 'Geodesic Hessian reconstruction still requires Gamma-calculus and test-function-density arguments.',
      manual: 'scratch tmp deliverable test density',
    },
  ])('rejects workflow overlap while preserving substantive negative findings: $manual', test => {
    const unrelated = finding(test.statement, test.summary), relevant = finding(test.relevant, test.relevant);
    const knowledge = snapshot([], [unrelated, relevant]);
    expect(searchKnowledgeRouteFindings(knowledge.base, test.manual).hits)
      .toContainEqual(expect.objectContaining({ id: unrelated.id }));
    const selected = searchKnowledgeRouteFindings(knowledge.base, test.query, { requireMathematicalRelevance: true });
    expect(selected.hits.map(hit => hit.id)).toEqual([relevant.id]);
    expect(selected.hits[0]!.conclusion).toBe('refuted');
  });

  it('preserves mathematical compound identifiers containing workflow words', () => {
    const goal = '∀ (d : SheetData), HasFixedPoint d → IsTestFunction (density d)';
    const relevant = finding('∀ (data : SheetData), HasFixedPoint data → IsTestFunction (density data)',
      'The SheetData fixed-point reduction still requires an IsTestFunction proof.', 'closed-task-type');
    expect(searchKnowledgeRouteFindings(snapshot([], [relevant]).base, '',
      { goal, requireMathematicalRelevance: true }).hits[0]!.id).toBe(relevant.id);
  });
});
