import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { readInstalledLibrarySnapshot } from '../src/solver/installedLibraryContext';
import { commitSolverSources, git, readSolverProblem } from '../src/solver/problem';
import { taskVersion, type CooperativeAction, type CooperativeTask } from '../src/solver/tasks';
import { cooperativeResearch, workerAccess } from './helpers/cooperation';
import { temporaryDirectory } from './helpers/files';
import { leadWorker, solverState } from './helpers/solver';
import { verifiedBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), createSession: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(), checkManyFormalVerifications: host.verify,
  formalVerificationToolIdentity: () => undefined, resolveMathematicsLakePackagesCache: () => undefined,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));

it('retains installed-only proof use in a cooperative delivery and its persisted state', async () => {
  const directory = temporaryDirectory('installed-library-use-'), workspace = path.join(directory, 'workspace');
  const file = 'Submission/Library/Fixture/Facts.lean';
  const reference = { name: 'Frozen.fact', file };
  const source = 'namespace Current\ntheorem goal : True := by sorry\nend Current\n';
  const receipt = bootstrapLeanTask(workspace, { source, task: 'Prove the goal using the installed library.', libraryPack: {
    schema: LIBRARY_PACK_SCHEMA, modules: [{ file, source: 'namespace Frozen\ntheorem fact : True := True.intro\nend Frozen\n',
      origin: { kind: 'upstream', repository: 'offline-fixture', commit: 'a'.repeat(40), file: 'Facts.lean' } }],
  } });
  const problem = readSolverProblem(workspace, receipt.activeProblemPath);
  const authorWorktree = path.join(directory, 'author');
  git(workspace, ['worktree', 'add', '--quiet', '--detach', authorWorktree, problem.baseCommit]);
  const workers = [leadWorker(problem, workspace), { ...leadWorker(problem, authorWorktree, 'author'), role: 'researcher' as const }];
  const task: CooperativeTask = { id: 'helper', kind: 'lemma', theoremName: 'Current.helper', proofPath: 'Submission.lean',
    type: 'True', objective: 'Use the installed fact.', dependsOn: [], revision: 0 };
  const action: Extract<CooperativeAction, { kind: 'task' }> = { kind: 'task', task,
    assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: workers[1].id,
      seedCommit: problem.baseCommit, assignmentId: 'installed-use', dependencies: [] } };
  const state = solverState(problem, workspace, { runId: 'installed-use', phase: 'running', cooperation: {
    canonicalCommit: problem.baseCommit,
    groups: [{ group: { id: 'main', objective: 'Prove the original.', status: 'active', revision: 0 }, turns: 0 }],
    tasks: [{ task, assignment: action.assignment, status: 'running', attempts: 1 }, {
      task: { ...problem.targets[0], id: 'goal', kind: 'goal', objective: 'Prove the original.', revision: 0,
        dependsOn: [], status: 'paused' }, status: 'pending', attempts: 0,
    }],
  } });
  const access = workerAccess(workers, directory);
  for (const value of access.values()) value.installedLibrary = readInstalledLibrarySnapshot(problem, state.environmentDigest);
  const events: { event: string; details?: Record<string, unknown> }[] = [];
  host.createSession.mockReset().mockImplementation(() => { throw new Error('fixture_real_models_forbidden'); });
  host.verify.mockReset().mockImplementation(async (request: MathematicsVerifierBatchRequest) => {
    const batch = verifiedBatch(request, { sessionId: 'installed-use', checks: true });
    return { ...batch, results: batch.results.map(result => ({ ...result,
      declarationReferences: { statement: [], proof: result.theoremName === task.theoremName ? [reference] : [] } })) };
  });
  const cooperative = cooperativeResearch({ state, workers, retrievalRoot: directory, access,
    emit: (event, details) => events.push({ event, details }) });
  try {
    state.cooperation!.planVersion = (cooperative as any).planVersion();
    fs.writeFileSync(path.join(workers[1].worktree, problem.projectRelative, 'Submission.lean'),
      'import Submission.Library.Fixture.Facts\n' + source.replace('theorem goal',
        'theorem helper : True := by exact Frozen.fact\ntheorem goal'));
    const commit = commitSolverSources(problem, workers[1].worktree);

    await cooperative.deliver(workers[1], action, commit);

    const delivery = state.cooperation!.deliveries?.find(delivery => delivery.kind === 'proof');
    expect(delivery).toMatchObject({ status: 'verified', taskId: task.id, knowledgeUses: [{ source: 'installed-library',
      declaration: reference, attribution: 'host-observed-reference', status: 'checked-reference',
      catalogDigest: access.get(workers[1].id)!.installedLibrary!.digest }] });
    expect(events.filter(item => item.event === 'knowledge_use_observed')).toHaveLength(1);
    const saved = path.join(directory, 'state.json');
    writeSolverRunState(saved, state);
    expect(readSolverRunState(saved).cooperation!.deliveries![0].knowledgeUses).toEqual(delivery!.knowledgeUses);
    expect(state.knowledgeDigest).toBeUndefined();
    expect(host.createSession).not.toHaveBeenCalled();
  } finally {
    await cooperative.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
