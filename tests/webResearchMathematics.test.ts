import { describe, expect, it } from 'vitest';
import { WebStorage } from '../apps/web/storage';
import { WebKnowledgeService } from '../apps/web/knowledgeService';
import { WebJobs } from '../apps/web/jobs';
import { researchMathematics } from '../apps/web/researchMathematics';
import type { WebObservation } from '../apps/web/collaboration';
import type { WebRun } from '../apps/web/shared';
import type { WebRunner } from '../apps/web/runner';
import { buildTheoremKnowledge, type KnowledgeCandidate, type KnowledgeProvenance } from '../src/solver/theoremKnowledge';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { LIBRARY_PACK_SCHEMA, type LibraryPack } from '../src/math/libraryPacks';
import { defaultResearchModulePlan } from '../src/solver/modules/policy';

const owner = 'account:disposable-math-review', at = '2026-11-09T10:00:00.000Z';
const sourceCommit = 'a'.repeat(40), checkedCommit = 'b'.repeat(40);
const standardDigest = getLeanTaskEnvironment('standard').dependencyDigest;
const runner: WebRunner = {
  readiness: async () => ({ ready: true, message: 'Unused fixture' }),
  run: async () => { throw new Error('This test must not start a worker.'); },
};
function candidate(name: string, file: string, files: Record<string, string>, provenance: Partial<KnowledgeProvenance> = {}): KnowledgeCandidate {
  return { name, file, type: 'True', typeKind: 'source-header', kind: 'lemma', description: '', premises: [],
    dependencies: { statement: [], proof: [], tasks: [], coverage: 'unavailable' }, files,
    provenance: { kind: 'solver-check', problemId: 'fixture', source: 'state.json', sourceDigest: mathDigest(canonicalMathJson(files)),
      sourceCommit, checkedCommit, runId: 'solver-fixture', taskId: 'target', environmentDigest: standardDigest,
      receiptIds: ['fixture-receipt'], ...provenance } };
}
function observation(id: string, source: string, digest: string, environmentDigest = standardDigest): WebObservation {
  const snapshot = { schema: 'fixture', runId: 'solver-fixture', stateDigest: mathDigest('observation'), resultDigest: null };
  return { schema: 'theorem-os.web-observation.v1', webRunId: id, solverRunId: snapshot.runId, observedAt: at, sequence: 1,
    evidence: 'recorded-not-replayed', acceptance: 'not-assessed', snapshot,
    inspection: { schema: 'fixture', runId: snapshot.runId, snapshot, evidence: 'recorded', phase: 'research',
      problem: { id: 'target', statement: 'True', formalStatement: 'True', assumptions: [],
        targets: [{ theoremName: 'target', proofPath: 'Main.lean' }] },
      configuration: { model: 'fixture', effort: 'low', workers: 1, coordination: 'cooperative', buildDigest: environmentDigest, environmentDigest },
      turns: 1, scheduling: { evidence: 'recorded', observedWorkers: 1, working: 0, proofAssignments: 0,
        preparing: 0, stopping: 0, idle: 1, stopped: 0 },
      knowledge: { status: 'recorded', evidence: 'recorded', attribution: 'recorded', retrievalCoverage: 'complete', droppedRetrievals: 0,
        retrievals: [], originalUses: [], uses: [] }, tokenBudget: {}, continuation: {},
      mathematics: { snapshot: { schema: 'fixture', evidence: 'recorded', acceptance: 'not-assessed', digest: mathDigest('math'),
        obligations: [], goals: [], blockers: [], routes: [], advisory: [] }, recentChanges: [], retainedChangeLimit: 10 },
      progress: { checkedProofTasks: 1, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: [] },
      groups: [], tasks: [], workers: [], statementReviews: [], edits: [] }, plan: null,
    sources: [{ taskId: 'target', taskVersion: 'task-v1', commit: sourceCommit, sourceDigest: digest, environmentDigest,
      file: 'Main.lean', source, scope: 'owned-file' }], checks: [], guidance: [], coverage: { sources: 'recorded', checks: 'recorded' } };
}
function run(id: string, changes: Partial<WebRun> = {}): WebRun {
  return { id, title: 'Disposable mathematics fixture', status: 'completed', phase: 'completed', createdAt: at, updatedAt: at,
    providerId: 'fixture', model: 'fixture', effort: 'low', environment: 'standard', source: 'theorem target : True := by sorry',
    task: 'Prove True', maxTurns: 1, maxRunSeconds: 30, workers: 1, coordination: 'cooperative', events: [], ...changes };
}
function setup() {
  const storage = new WebStorage(), knowledge = new WebKnowledgeService(storage);
  const resolver = () => researchMathematics(storage, knowledge,
    new WebJobs(runner, { concurrency: 1, queueLimit: 2 }, { storage, knowledge }), runner);
  return { storage, knowledge, resolver };
}

describe('mathematics publication resolves actual saved source contracts', () => {
  it('recovers the exact reachable owned-file closure before a completed knowledge catalog exists', async () => {
    const { storage, resolver } = setup();
    const main = 'import Dependency\ntheorem target : True := by exact helper\n', dependency = 'lemma helper : True := by trivial\n';
    const saved = observation('web-fixture', main, mathDigest('complete owned snapshot'));
    saved.sources[0].dependencySources = [{ file: 'Dependency.lean', source: dependency },
      { file: 'Unrelated.lean', source: 'lemma private_note : True := by trivial\n' }];
    storage.saveRun(owner, run('web-fixture', { observation: saved }));
    const resolved = await resolver().resolve(owner, { kind: 'run', runId: 'web-fixture', taskId: 'target', commit: sourceCommit });
    expect(resolved.pack.modules).toHaveLength(2);
    expect(resolved.pack.modules.some(module => module.source === dependency)).toBe(true);
    expect(JSON.stringify(resolved.pack)).not.toContain('private_note');
    expect(resolved.pack.modules.every(module => module.origin.commit === sourceCommit)).toBe(true);
  });

  it('retains each knowledge entry source commit and originating run when merging declarations', async () => {
    const { knowledge, resolver } = setup();
    const first = candidate('first', 'First.lean', { 'First.lean': 'lemma first : True := by trivial\n' },
      { runId: 'solver-first', sourceCommit: '1'.repeat(40), checkedCommit: '3'.repeat(40) });
    const second = candidate('second', 'Second.lean', { 'Second.lean': 'lemma second : True := by trivial\n' },
      { runId: 'solver-second', sourceCommit: '2'.repeat(40), checkedCommit: '4'.repeat(40) });
    const catalog = knowledge.importCatalog(owner, buildTheoremKnowledge([first, second]));
    const entries = knowledge.getCatalog(owner, catalog.digest)!.entries;
    const resolved = await resolver().resolve(owner, { kind: 'knowledge', catalogDigest: catalog.digest, entryIds: entries.map(entry => entry.id) });
    expect(resolved.pack.modules.find(module => module.origin.file === 'First.lean')?.origin)
      .toMatchObject({ runId: 'solver-first', commit: '1'.repeat(40), file: 'First.lean' });
    expect(resolved.pack.modules.find(module => module.origin.file === 'Second.lean')?.origin)
      .toMatchObject({ runId: 'solver-second', commit: '2'.repeat(40), file: 'Second.lean' });
    expect(resolved.declarations.map(item => item.name).sort()).toEqual(['first', 'second']);
  });

  it('uses the exact catalog context for an aggregate source digest and keeps frozen dependency origins', async () => {
    const { storage, knowledge, resolver } = setup();
    const main = 'import Dependency\nimport Submission.Library.Frozen\ntheorem target : True := by exact helper\n';
    const dependency = 'lemma helper : True := by trivial\n', frozen = 'lemma frozen_helper : True := by trivial\n';
    const files = { 'Main.lean': main, 'Dependency.lean': dependency, 'Submission/Library/Frozen.lean': frozen,
      'Unrelated.lean': 'lemma private_note : True := by trivial\n' };
    const digest = mathDigest(canonicalMathJson([['Main.lean', mathDigest(main)], ['Dependency.lean', mathDigest(dependency)]]));
    expect(digest).not.toBe(mathDigest(main));
    const catalog = knowledge.importCatalog(owner, buildTheoremKnowledge([candidate('target', 'Main.lean', files)]));
    const origin: LibraryPack['modules'][number]['origin'] = { kind: 'upstream', repository: 'https://example.org/frozen',
      commit: 'f'.repeat(40), file: 'Frozen.lean' };
    const libraryPack: LibraryPack = { schema: LIBRARY_PACK_SCHEMA, modules: [{ file: 'Submission/Library/Frozen.lean', source: frozen, origin }] };
    storage.saveRun(owner, run('web-fixture', { observation: observation('web-fixture', main, digest), knowledgeCatalogDigest: catalog.digest,
      researchConfiguration: { schema: 'theorem-os.research-configuration.v1', environment: 'standard', modulePlan: defaultResearchModulePlan(),
        preferences: {}, skills: [], libraries: [], libraryPack, digest: mathDigest('configuration') } }));
    const resolved = await resolver().resolve(owner, { kind: 'run', runId: 'web-fixture', taskId: 'target', commit: sourceCommit });
    expect(resolved.pack.modules).toHaveLength(3);
    const importedDependency = resolved.pack.modules.find(module => module.source === dependency)!;
    expect(resolved.pack.modules.find(module => module.origin.file === 'Main.lean')?.source)
      .toContain(`import ${importedDependency.file.slice(0, -5).replaceAll('/', '.')}`);
    expect(resolved.pack.modules.find(module => module.file === 'Submission/Library/Frozen.lean')?.origin).toEqual(origin);
    expect(JSON.stringify(resolved.pack)).not.toContain('private_note');
  });

  it.each(['observation', 'attempt'] as const)('resolves a native environment digest through the %s solver ID', async source => {
    const { storage, knowledge, resolver } = setup();
    const nativeDigest = mathDigest('actual compiler and dependency tree');
    const text = 'lemma helper : True := by trivial\n';
    const catalog = knowledge.importCatalog(owner, buildTheoremKnowledge([
      candidate('helper', 'Helper.lean', { 'Helper.lean': text }, { environmentDigest: nativeDigest }),
    ]));
    storage.saveRun(owner, run('web-fixture', { environment: 'mathlib', ...(source === 'observation'
      ? { observation: observation('web-fixture', text, mathDigest(text), nativeDigest) }
      : { solverAttempt: { solverRunId: 'solver-fixture', round: 0, sequence: 1 } }) }));
    const resolved = await resolver().resolve(owner, { kind: 'knowledge', catalogDigest: catalog.digest,
      entryIds: knowledge.getCatalog(owner, catalog.digest)!.entries.map(entry => entry.id) });
    expect(resolved.environment).toBe('mathlib');
    expect(resolved.environmentDigest).toBe(getLeanTaskEnvironment('mathlib').dependencyDigest);
    expect(resolved.pack.modules[0]!.origin).toMatchObject({ environmentDigest: getLeanTaskEnvironment('mathlib').dependencyDigest });
  });
});
