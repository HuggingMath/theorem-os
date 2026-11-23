import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import type { CooperativeResearch } from '../src/solver/cooperation';
import { readInstalledLibrarySnapshot } from '../src/solver/installedLibraryContext';
import { committedSource, commitSolverSources, readSolverProblem, withSolverWorktree } from '../src/solver/problem';
import { applyTaskChanges, createTaskSourceProjector } from '../src/solver/cooperativeProof';
import { taskVersion, type CooperativeTask } from '../src/solver/tasks';
import { cooperativeResearch, workerAccess, workerDeliveryModules } from './helpers/cooperation';
import { temporaryDirectory } from './helpers/files';
import { leadWorker, peerWorker, solverState } from './helpers/solver';
import { verifiedBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), createSession: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify,
  resolveMathematicsLakePackagesCache: () => undefined,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));

const roots: string[] = [];
const instances: { controller: AbortController; cooperative: CooperativeResearch }[] = [];
afterEach(async () => {
  for (const { controller, cooperative } of instances.splice(0)) { controller.abort(); await cooperative.stop(); }
  expect(host.createSession).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('conditional consumer with an older library import context', () => {
  it('checks the exact old candidate, records generated imports, and independently integrates after its producer', async () => {
    const directory = temporaryDirectory('solver-conditional-library-imports-'); roots.push(directory);
    const module = 'Submission.Library.Bounds';
    const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), {
      source: 'namespace Original\ntheorem target : True := by sorry\nend Original\n', task: 'Prove the original target.',
      libraryPack: { schema: LIBRARY_PACK_SCHEMA, modules: [{ file: 'Submission/Library/Bounds.lean',
        source: 'namespace Frozen\ndef value : Nat := 0\nend Frozen\n',
        origin: { kind: 'upstream', repository: 'fixture', commit: 'a'.repeat(40), file: 'Bounds.lean' } }] },
    });
    const { workspaceRoot: workspace } = receipt;
    const problem = readSolverProblem(workspace, receipt.activeProblemPath);
    const example = { directory, workspace, receipt, problem };
    const workers = [leadWorker(problem, workspace), peerWorker(example, 'researcher'),
      peerWorker(example, 'engineer', { role: 'engineer' })];
    const tasks: CooperativeTask[] = [
      { id: 'producer', kind: 'lemma', objective: 'Prove the library interface.', theoremName: 'Original.producer',
        proofPath: 'Submission.lean', type: 'Frozen.value = 0', dependsOn: [], revision: 0, ownerId: 'researcher' },
      { id: 'consumer', kind: 'goal', objective: 'Prove the original target.', theoremName: 'Original.target',
        proofPath: 'Submission.lean', dependsOn: ['producer'], conditional: true, revision: 0, ownerId: 'engineer' },
    ];
    fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), '```math-plan\n' + JSON.stringify({ tasks }) + '\n```');
    const state = solverState(problem, workspace, { runId: 'conditional-library-fixture', phase: 'running',
      cooperation: { canonicalCommit: problem.baseCommit, tasks: [] } });
    const projections: { theorem: string; source: string }[] = [];
    host.createSession.mockReset().mockImplementation(() => { throw new Error('fixture_real_models_forbidden'); });
    host.verify.mockReset().mockImplementation(async (request: MathematicsVerifierBatchRequest) => {
      const source = fs.readFileSync(path.join(request.projectRoot, 'Submission.lean'), 'utf8');
      for (const item of request.items) projections.push({ theorem: item.theoremName, source });
      if (source.includes('Frozen.value') && !source.includes(`import ${module}`))
        throw new Error('fixture_missing_conditional_library_import');
      return verifiedBatch(request, { sessionId: 'conditional-library-fixture' });
    });
    const controller = new AbortController();
    const access = workerAccess(workers, directory);
    const library = readInstalledLibrarySnapshot(problem, state.environmentDigest);
    for (const grant of access.values()) grant.installedLibrary = library;
    const cooperative = cooperativeResearch({ state, workers, access, modules: workerDeliveryModules,
      retrievalRoot: directory, signal: controller.signal });
    instances.push({ controller, cooperative });
    await cooperative.restore();
    const budget = { maxTurns: Infinity, remainingMs: Infinity };
    const producer = await cooperative.next(workers[1], budget);
    const consumer = await cooperative.next(workers[2], budget);
    if (producer?.kind !== 'task' || consumer?.kind !== 'task') throw new Error('fixture_missing_task');
    expect(producer.task.id).toBe('producer'); expect(consumer.task.id).toBe('consumer');
    expect(cooperative.started(workers[1], producer)).toBe(true);
    expect(cooperative.started(workers[2], consumer)).toBe(true);
    const node = (id: string) => state.cooperation!.tasks.find(item => item.task.id === id)!;

    fs.writeFileSync(path.join(workers[1].worktree, problem.projectRelative, 'Submission.lean'),
      `import ${module}\nnamespace Original\ntheorem producer : Frozen.value = 0 := by rfl\n` +
      'theorem target : True := by sorry\nend Original\n');
    await cooperative.deliver(workers[1], producer, commitSolverSources(problem, workers[1].worktree));
    expect(node('producer').status).toBe('integrated');

    const oldCandidate = 'namespace Original\ntheorem target : True := by trivial\nend Original\n';
    fs.writeFileSync(path.join(workers[2].worktree, problem.projectRelative, 'Submission.lean'), oldCandidate);
    const commit = commitSolverSources(problem, workers[2].worktree);
    await cooperative.deliver(workers[2], consumer, commit);
    const proof = node('consumer').proof!;
    expect(node('consumer').status).toBe('integrated');
    expect(proof.commit).toBe(commit);
    expect(proof.seedCommit).toBe(consumer.assignment.seedCommit);
    expect(proof.conditions).toEqual([{ taskId: 'producer', taskDigest: taskVersion(producer.task) }]);
    expect(proof.imports).toEqual([{ file: 'Submission.lean', module }]);
    const projected = createTaskSourceProjector(problem, workers[2].worktree, commit)(consumer.task, [], [producer.task]);
    expect(projections.some(item => item.theorem === 'Original.target' && item.source === projected.get('Submission.lean'))).toBe(true);
    const conditionalType = /^theorem target : theorem_os_conditional_type% (.+) :=$/mu.exec(projected.get('Submission.lean')!);
    expect(conditionalType).not.toBeNull();
    expect(JSON.parse(JSON.parse(conditionalType![1]!))).toEqual({
      declaration: 'theorem target : True := by trivial\n',
      dependencies: [{ theoremName: 'Original.producer', type: 'Frozen.value = 0' }],
    });
    expect(node('consumer').integratedCheck).toMatchObject({ passed: true });
    expect(node('consumer').integratedCheck!.conditions).toBeUndefined();
    expect(committedSource(workspace, state.cooperation!.canonicalCommit!, `${problem.projectRelative}/Submission.lean`))
      .toContain(`import ${module}`);
    expect(committedSource(workspace, commit, `${problem.projectRelative}/Submission.lean`)).toBe(oldCandidate);
    await withSolverWorktree(workspace, consumer.assignment.seedCommit, async checkout => {
      applyTaskChanges(problem, checkout, proof.changes, proof.imports);
      const merged = fs.readFileSync(path.join(checkout, problem.projectRelative, 'Submission.lean'), 'utf8');
      expect(merged).toContain(`import ${module}`);
      expect(merged).toContain('theorem target : True := by trivial');
    });
  });
});
