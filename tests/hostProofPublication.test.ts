import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import type { CooperativeResearch } from '../src/solver/cooperation';
import { RETRY_DISPATCH } from '../src/solver/cooperationShared';
import { directSolverModules } from '../src/solver/modules';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { commitSolverSources, committedSource, readSolverProblem } from '../src/solver/problem';
import { hasTaskAcceptance, taskVersion, type CooperativeAction } from '../src/solver/tasks';
import { deferred } from './helpers/async';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, peerWorker, solverState } from './helpers/solver';
import { failedBatch, verifiedBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), createSession: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({ ...await importOriginal<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify,
  formalVerificationToolIdentity: () => 'host-publication-fixture-tools',
  resolveMathematicsLakePackagesCache: () => undefined,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));

const budget = { maxTurns: Infinity, remainingMs: Infinity };
// Thorp has a complete canonical helper inside a section with universes, and its
// advisory type projection defers that scope. Two other workers occupy its group.
const original = 'namespace OAI\nnoncomputable section\nuniverse u\nnamespace Thorp.Current\n' +
  'theorem first_reciprocal_main : True := by sorry\nend Thorp.Current\nend\nend OAI\n';
const helper = 'theorem exceptionalFirst_le_reciprocalFirst : (∀ n : Nat, n = n) ∧ (∀ n : Nat, n = n) := by\n' +
  '  constructor <;> intro n <;> rfl\n';
const fixtures: ReturnType<typeof fixture>[] = [];
const verified = (request: MathematicsVerifierBatchRequest) => verifiedBatch(request, { sessionId: 'host-publication-fixture' });

function fixture(maxConcurrent = 3) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-proof-publication-')));
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { source: original, task: 'Prove the original target.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const project = path.join(receipt.workspaceRoot, problem.projectRelative);
  fs.writeFileSync(path.join(project, 'Submission.lean'), original.replace('theorem first_reciprocal_main', helper + 'theorem first_reciprocal_main'));
  const canonical = commitSolverSources(problem, receipt.workspaceRoot);
  const example = { directory, workspace: receipt.workspaceRoot, receipt: undefined!, problem };
  const lead = leadWorker(problem, receipt.workspaceRoot);
  const prover = peerWorker(example, 'researcher-2', { commit: canonical });
  const other = Array.from({ length: maxConcurrent - 1 }, (_, index) =>
    peerWorker(example, `busy-${index}`, { commit: canonical }));
  const workers: ResearchWorker[] = [lead, prover, ...other];
  const tasks = [{ id: 'exceptional_le', kind: 'lemma', objective: 'Prove the canonical conjunct helper.',
    dependsOn: [], revision: 0, proofPath: 'Submission.lean',
    theoremName: 'OAI.Thorp.Current.exceptionalFirst_le_reciprocalFirst', type: '(∀ n : Nat, n = n) ∧ (∀ n : Nat, n = n)' },
    { id: 'goal', kind: 'goal', objective: 'Assemble the original theorem.', dependsOn: ['exceptional_le'], revision: 0,
      proofPath: 'Submission.lean', theoremName: 'OAI.Thorp.Current.first_reciprocal_main', ownerId: 'missing-engineer' },
    ...other.map(worker => ({ id: worker.id, kind: 'research', objective: `Independent ${worker.id} work.`,
      dependsOn: [], revision: 0 }))] as const;
  const state = solverState(problem, receipt.workspaceRoot, { runId: 'host-publication-fixture', phase: 'running',
    workers: workers.map(worker => ({ ...worker, phase: 'running', turns: 0 })),
    cooperation: { canonicalCommit: canonical, tasks: tasks.map(task => ({ task,
      status: task.kind === 'research' ? 'running' : 'pending', attempts: task.kind === 'research' ? 1 : 0,
      ...(task.kind === 'research' ? { assignment: { taskId: task.id, taskDigest: taskVersion(task),
        workerId: task.id, seedCommit: canonical } } : {}) })),
      groups: [{ group: { id: 'main', objective: 'Close the original target.', status: 'active', revision: 0, maxConcurrent }, turns: 0 }] } });
  const environmentFile = path.join(directory, 'environment.json'); fs.writeFileSync(environmentFile, '');
  const environment = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: environmentFile };
  const controller = new AbortController(), events: { event: string; details: Record<string, unknown> }[] = [];
  host.verify.mockReset().mockImplementation(async request => verified(request));
  host.createSession.mockReset().mockImplementation(() => { throw new Error('fixture_real_models_forbidden'); });
  const cooperative = cooperativeResearch({ state, workers, retrievalRoot: directory,
    signal: controller.signal, access: new Map(workers.map(worker => [worker.id, { environment, retrievalRoot: directory }])),
    emit: (event, details) => events.push({ event, details }),
    modules: { ...directSolverModules, M2: { ...directSolverModules.M2, closeTask: undefined } } });
  const node = state.cooperation!.tasks[0]!;
  (cooperative as any).changed();
  const f = { directory, problem, state, cooperative, controller, prover, lead, node, events, canonical,
    dispatch: () => (cooperative as any).nextPeer(prover, budget, true) as Promise<CooperativeAction | typeof RETRY_DISPATCH | undefined> };
  fixtures.push(f); return f;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.controller.abort(); await f.cooperative.stop(); fs.rmSync(f.directory, { recursive: true, force: true });
  }
  expect(host.createSession).not.toHaveBeenCalled(); vi.restoreAllMocks();
});

describe('host proof publication in the final group slot', () => {
  it.each([1, 3])('integrates a checked canonical helper despite deferred type scope at capacity %i', async capacity => {
    const f = fixture(capacity);
    expect(f.state.cooperation!.groups![0].busy).toBe(capacity - 1);
    expect(await f.dispatch()).toBe(RETRY_DISPATCH);
    expect(f.node.typePreflight).toMatchObject({ status: 'deferred', reason: 'declaration-scope-not-reproducible' });
    expect(f.node.status).toBe('integrated');
    expect(f.node.integratedCheck?.passed).toBe(true);
    expect(hasTaskAcceptance(f.node.integratedCheck!)).toBe(true);
    expect(f.node.attempts).toBe(0);
    expect(f.events.filter(item => item.event === 'task_canonical_probe')).toHaveLength(1);
    expect(f.events.filter(item => item.event === 'task_type_preflight')).toHaveLength(1);
    expect(f.state.cooperation!.deliveries).toContainEqual(expect.objectContaining({ taskId: 'exceptional_le', kind: 'proof', status: 'verified' }));
    expect(committedSource(f.lead.worktree, f.state.cooperation!.canonicalCommit!,
      `${f.problem.projectRelative}/Submission.lean`)).toContain(helper);
    expect(f.state.workers!.find(worker => worker.id === f.prover.id)?.scheduling?.status).toBe('idle');
    expect(f.state.cooperation!.groups![0].busy).toBe(capacity - 1);
  });

  it('continues to an ordinary task when the deferred-scope canonical proof fails its independent check', async () => {
    const f = fixture();
    host.verify.mockImplementation(async request => failedBatch(verified(request), {
      stdoutPreview: () => 'Submission.lean:1:1: error: unsolved goals', goalsRemaining: 1 }));
    const action = await f.dispatch();
    expect(action).toMatchObject({ kind: 'task', task: { id: 'exceptional_le' },
      assignment: { canonicalProbe: { proofAcceptance: 'not-accepted', verificationStatus: 'failed' } } });
    expect(f.node.status).toBe('running');
    expect(f.node.proof).toBeUndefined(); expect(f.node.integratedCheck).toBeUndefined();
    expect(f.state.cooperation!.failedTaskInputs ?? []).toEqual([]);
  });

  it.each(['paused-group', 'changed-task'] as const)('still rejects a prepared proof for a %s at publication', async invalidation => {
    const f = fixture(), exclusive = (f.cooperative as any).input.exclusiveCheck;
    (f.cooperative as any).input.exclusiveCheck = async (operation: () => Promise<unknown>) => {
      if ((f.cooperative as any).proofPublications.size) {
        if (invalidation === 'paused-group') f.state.cooperation!.groups![0].group = {
          ...f.state.cooperation!.groups![0].group, status: 'paused' };
        else f.node.task = { ...f.node.task, revision: 1 };
        (f.cooperative as any).changed();
      }
      return exclusive(operation);
    };
    expect(await f.dispatch()).toBe(RETRY_DISPATCH);
    expect(f.node.status).toBe('pending');
    expect(f.node.proof).toBeUndefined(); expect(f.node.assignment).toBeUndefined();
    expect(f.state.cooperation!.canonicalCommit).toBe(f.canonical);
  });

  it('drains a preparing canonical proof on stop without retrying or claiming a stale assignment', async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    host.verify.mockImplementationOnce(async request => { entered.resolve(); await release.promise; return verified(request); });
    const dispatch = f.dispatch(); await entered.promise;
    const stop = f.cooperative.stop(); release.resolve();
    expect(await dispatch).toBe(RETRY_DISPATCH); await stop;
    expect(f.node.status).toBe('pending');
    expect(f.node.assignment).toBeUndefined(); expect(f.node.proof).toBeUndefined();
    expect((f.cooperative as any).preparingTaskTypes.size).toBe(0);
    expect((f.cooperative as any).proofPublications.size).toBe(0);
  });
});
