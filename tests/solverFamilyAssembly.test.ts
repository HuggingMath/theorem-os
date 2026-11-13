import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_EXAMPLE_STATEMENT } from '../src/math/localExample';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import { parseCooperationPlan, type CooperativeResearch } from '../src/solver/cooperation';
import { directSolverModules } from '../src/solver/modules';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { committedSource, commitSolverSources } from '../src/solver/problem';
import type { SolverRunState } from '../src/solver/archive';
import { familyAssemblyProof, familyType } from '../src/solver/taskFamilies';
import { taskVersion } from '../src/solver/tasks';
import { TaskTypePreflightCache } from '../src/solver/taskTypePreflight';
import { conditionalExpectedType } from '../src/solver/conditionalProjection';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';
import { failedBatch, verifiedBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), model: vi.fn(), lean: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, formalVerificationToolIdentity: () => 'family-fixture-tools',
}));
vi.mock('../src/math/mathProofEnvironment', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathProofEnvironment')>(), resolveMathProofEnvironment: () => undefined,
}));
vi.mock('../src/math/leanTypeDiagnostics', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/leanTypeDiagnostics')>(), checkLeanType: host.lean,
}));

describe('host family assembly before model dispatch', () => {
  let directory: string, state: SolverRunState, workers: ResearchWorker[], cooperative: CooperativeResearch;
  let controller: AbortController, emit: ReturnType<typeof vi.fn>;
  const budget = { maxTurns: Infinity, remainingMs: Infinity };
  const family = { lo: 0, hi: 7, chunk: 3, predicate: 'Tutorial.Good' };
  const memberIds = ['table_c0', 'table_c1', 'table_c2'];
  const node = (id = 'table') => state.cooperation!.tasks.find(item => item.task.id === id)!;
  const next = () => cooperative.next(workers[1], budget);
  const verified = (request: MathematicsVerifierBatchRequest) => verifiedBatch(request, { sessionId: 'family-fixture', checks: true });
  const events = () => emit.mock.calls.filter(call => call[0] === 'task_family_assembly').map(call => call[1]);
  const canonical = () => committedSource(workers[0].worktree, state.cooperation!.canonicalCommit!,
    `${state.problem.projectRelative}/Submission.lean`);
  const preflight = () => vi.mocked(TaskTypePreflightCache.prototype.check);

  beforeEach(() => {
    host.verify.mockReset().mockImplementation(async request => verified(request));
    host.model.mockReset().mockImplementation(() => { throw new Error('fixture_models_forbidden'); });
    // The battery must not close anything here: a closed member or family would hide the assembly path.
    host.lean.mockReset().mockImplementation(async () => ({ status: 'failed', timedOut: false,
      artifact: { path: '.lake/type-diagnostics/fixture/manifest.json', digest: 'b'.repeat(64) } }));
    const example = localExample('solver-family-assembly-'), { workspace, problem } = example;
    directory = example.directory;
    workers = [leadWorker(problem, workspace), peerWorker(example, 'proof')];
    const plan = parseCooperationPlan(problem, { tasks: [
      { id: 'table', kind: 'lemma', objective: 'Check the residue table', theoremName: 'Tutorial.table',
        proofPath: 'Submission.lean', family, ownerId: 'proof' },
      { id: 'followup', kind: 'research', objective: 'Observe dependency readiness', dependsOn: ['table'], ownerId: 'proof' },
      ...problem.targets.map((target, index) => ({ id: `goal_${index}`, kind: 'goal', objective: 'Original goal',
        theoremName: target.theoremName, proofPath: target.proofPath, status: 'paused' })),
    ], groups: [{ id: 'main', objective: 'Original problem', status: 'active', maxConcurrent: 1 }] });
    // Members wait, so the family is assembled while all of them are unproved.
    const tasks = plan.tasks.map(task => task.familyMember ? { ...task, status: 'paused' as const } : task);
    state = solverState(problem, workspace, { runId: 'family-fixture', phase: 'running',
      cooperation: { canonicalCommit: problem.baseCommit, groups: plan.groups.map(group => ({ group, turns: 0 })),
        tasks: tasks.map(task => ({ task, attempts: 0, status: 'pending' })) } });
    fs.writeFileSync(path.join(workers[0].worktree, state.problem.projectRelative, 'Submission.lean'), LOCAL_EXAMPLE_STATEMENT);
    state.cooperation!.canonicalCommit = commitSolverSources(state.problem, workers[0].worktree);
    const envFile = path.join(directory, 'math.env'); fs.writeFileSync(envFile, '');
    const environment = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: envFile };
    controller = new AbortController(); emit = vi.fn();
    cooperative = cooperativeResearch({ state, workers, retrievalRoot: directory, signal: controller.signal, emit,
      access: new Map(workers.map(worker => [worker.id, { environment, retrievalRoot: directory }])),
      modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open: host.model, execute: host.model } } });
    vi.spyOn(TaskTypePreflightCache.prototype, 'check').mockImplementation(async input => ({ current: () => !input.signal?.aborted,
      result: { taskDigest: taskVersion(input.task), inputDigest: 'fixture', evidence: 'advisory-type-elaboration',
        proofAcceptance: 'not-assessed', status: 'elaborated', reason: 'fixture', context: 'Tutorial.add_zero', type: input.task.type } }));
  });
  afterEach(async () => {
    controller.abort(); await cooperative.stop();
    expect(host.model).not.toHaveBeenCalled();
    vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });

  it('checks the assembled family with every unproved member bound as a hypothesis, before any model turn', async () => {
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'followup' } });
    expect(host.verify).toHaveBeenCalledOnce();
    expect(host.verify.mock.calls[0][1].expectedDeclarationType).toBe(conditionalExpectedType('Tutorial.table',
      familyType(0, 7, 'Tutorial.Good'), memberIds.map((id, index) => ({ theoremName: `Tutorial.${id}`,
        type: familyType(index * 3, Math.min(7, index * 3 + 3), 'Tutorial.Good') }))));
    expect(node()).toMatchObject({ status: 'conditional', attempts: 0, proof: { passed: true,
      conditions: memberIds.map(taskId => ({ taskId, taskDigest: taskVersion(node(taskId).task) })) } });
    expect(events()).toEqual([expect.objectContaining({ taskId: 'table', workerId: 'proof', status: 'committed', reason: 'family-assembled',
      assumedInputs: memberIds, passed: true, verificationStatus: 'kernel_verified', commit: expect.any(String) })]);
    expect(committedSource(workers[1].worktree, events()[0].commit, `${state.problem.projectRelative}/Submission.lean`))
      .toContain(`theorem table : ${familyType(0, 7, 'Tutorial.Good')}\n  := ${familyAssemblyProof('Tutorial.table', family)}\n`);
    expect(state.cooperation!.deliveries).toContainEqual(expect.objectContaining({ taskId: 'table', kind: 'proof', status: 'conditional',
      summary: expect.stringContaining('binds its 3 lemma input(s) as explicit hypotheses') }));
    // The type preflight of a family does not wait for its own members to exist in source.
    expect(preflight().mock.calls.find(call => call[0].task.id === 'table')![0].dependencies).toEqual([]);
    expect(host.lean).not.toHaveBeenCalled(); expect(state.turns).toBe(0);
    expect(canonical()).toBe(LOCAL_EXAMPLE_STATEMENT);
    for (const id of memberIds) expect(node(id)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('falls through to model work when the kernel rejects the assembly, and does not reassemble the same contract', async () => {
    host.verify.mockImplementationOnce(async request => failedBatch(verified(request),
      { stdoutPreview: () => 'Submission.lean:3:1: error: unknown constant' }));
    const first = await next();
    expect(first).toMatchObject({ kind: 'task', task: { id: 'table' } });
    expect(events()).toEqual([expect.objectContaining({ status: 'committed', passed: false, verificationStatus: 'failed' })]);
    expect(state.cooperation!.deliveries ?? []).toEqual([]); expect(node().proof).toBeUndefined();
    if (first?.kind !== 'task') throw new Error('expected_task_assignment');
    cooperative.release(workers[1], first);
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'table' } });
    expect(events()).toHaveLength(1); expect(host.verify).toHaveBeenCalledOnce();
  });

  it.each(['disabled', 'saved-assignment', 'no-context'] as const)('does not assemble for %s work', async kind => {
    if (kind === 'disabled') (cooperative as any).input.modules.M2 = { ...directSolverModules.M2, assembleFamily: undefined };
    if (kind === 'saved-assignment') node().assignment = { taskId: 'table', taskDigest: taskVersion(node().task),
      workerId: workers[1].id, seedCommit: state.cooperation!.canonicalCommit!, assignmentId: 'saved',
      dependencies: memberIds.map(taskId => ({ taskId, taskDigest: taskVersion(node(taskId).task) })) };
    if (kind === 'no-context') preflight().mockImplementation(async input => ({ current: () => true,
      result: { taskDigest: taskVersion(input.task), inputDigest: 'fixture', evidence: 'advisory-type-elaboration',
        proofAcceptance: 'not-assessed', status: 'elaborated', reason: 'fixture' } }));
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'table' } });
    expect(events()).toEqual([]); expect(host.verify).not.toHaveBeenCalled();
  });

  it('leaves an unconditional family waiting for its members', async () => {
    node().task = { ...node().task, conditional: false };
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'followup' } });
    expect(events()).toEqual([]); expect(node()).toMatchObject({ status: 'pending', attempts: 0 });
  });
});
