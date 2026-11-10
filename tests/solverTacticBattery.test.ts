import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_EXAMPLE_STATEMENT } from '../src/math/localExample';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import { parseCooperationPlan, type CooperativeResearch } from '../src/solver/cooperation';
import { directSolverModules } from '../src/solver/modules';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { committedSource, commitSolverSources, git } from '../src/solver/problem';
import type { SolverRunState } from '../src/solver/archive';
import { tacticBatteryProof, vacuityProbeProof } from '../src/solver/tacticBattery';
import { hasTaskAcceptance, taskVersion } from '../src/solver/tasks';
import { TaskTypePreflightCache } from '../src/solver/taskTypePreflight';
import { deferred } from './helpers/async';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';
import { failedBatch, verifiedBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), model: vi.fn(), lean: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, formalVerificationToolIdentity: () => 'battery-fixture-tools',
}));
vi.mock('../src/math/mathProofEnvironment', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathProofEnvironment')>(), resolveMathProofEnvironment: () => undefined,
}));
vi.mock('../src/math/leanTypeDiagnostics', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/leanTypeDiagnostics')>(), checkLeanType: host.lean,
}));

describe('host tactic battery before model dispatch', () => {
  let directory: string, state: SolverRunState, workers: ResearchWorker[], cooperative: CooperativeResearch;
  let controller: AbortController, allowed: boolean, emit: ReturnType<typeof vi.fn>;
  const budget = { maxTurns: Infinity, remainingMs: Infinity };
  const node = () => state.cooperation!.tasks.find(item => item.task.id === 'helper')!;
  const next = () => cooperative.next(workers[1], budget);
  const verified = (request: MathematicsVerifierBatchRequest) => verifiedBatch(request, { sessionId: 'battery-fixture', checks: true });
  const leanResult = (status: 'elaborated' | 'failed') => ({ status, timedOut: false, constants: status === 'elaborated' ? ['True.intro'] : undefined,
    artifact: { path: '.lake/type-diagnostics/fixture/manifest.json', digest: 'b'.repeat(64) } });
  // The vacuity probe after a closed battery fails by default: the fixture helper has no hypotheses.
  const probe = (input: { expression: string }) => input.expression === vacuityProbeProof(false);
  const events = () => emit.mock.calls.filter(call => call[0] === 'task_tactic_battery').map(call => call[1]);
  const canonical = () => committedSource(workers[0].worktree, state.cooperation!.canonicalCommit!,
    `${state.problem.projectRelative}/Submission.lean`);
  const noDelivery = () => {
    expect(state.cooperation!.deliveries ?? []).toEqual([]);
    expect(state.cooperation!.failedTaskInputs ?? []).toEqual([]);
    expect(node().proof).toBeUndefined(); expect(node().attempts).toBe(0);
    expect(canonical()).toBe(LOCAL_EXAMPLE_STATEMENT);
  };

  beforeEach(() => {
    host.verify.mockReset().mockImplementation(async request => verified(request));
    host.model.mockReset().mockImplementation(() => { throw new Error('fixture_models_forbidden'); });
    host.lean.mockReset().mockImplementation(async input => leanResult(probe(input) ? 'failed' : 'elaborated'));
    const example = localExample('solver-tactic-battery-'), { workspace, problem } = example;
    directory = example.directory;
    workers = [leadWorker(problem, workspace), peerWorker(example, 'proof')];
    const plan = parseCooperationPlan(problem, { tasks: [
      { id: 'helper', kind: 'lemma', objective: 'Prove exact helper', theoremName: 'Tutorial.helper',
        proofPath: 'Submission.lean', type: 'True', ownerId: 'proof' },
      { id: 'followup', kind: 'research', objective: 'Observe dependency readiness', dependsOn: ['helper'], ownerId: 'proof' },
      ...problem.targets.map((target, index) => ({ id: `goal_${index}`, kind: 'goal', objective: 'Original goal',
        theoremName: target.theoremName, proofPath: target.proofPath, status: 'paused' })),
    ], groups: [{ id: 'main', objective: 'Original problem', status: 'active', maxConcurrent: 1 }] });
    state = solverState(problem, workspace, { runId: 'battery-fixture', phase: 'running',
      cooperation: { canonicalCommit: problem.baseCommit, groups: plan.groups.map(group => ({ group, turns: 0 })),
        tasks: plan.tasks.map(task => ({ task, attempts: 0, status: 'pending' })) } });
    fs.writeFileSync(path.join(workers[0].worktree, state.problem.projectRelative, 'Submission.lean'), LOCAL_EXAMPLE_STATEMENT);
    state.cooperation!.canonicalCommit = commitSolverSources(state.problem, workers[0].worktree);
    const envFile = path.join(directory, 'math.env'); fs.writeFileSync(envFile, '');
    const environment = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: envFile };
    controller = new AbortController(); allowed = true; emit = vi.fn();
    cooperative = cooperativeResearch({ state, workers, retrievalRoot: directory, signal: controller.signal, emit,
      access: new Map(workers.map(worker => [worker.id, { environment, retrievalRoot: directory }])),
      modelDispatchAllowed: () => allowed,
      modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open: host.model, execute: host.model } } });
    vi.spyOn(TaskTypePreflightCache.prototype, 'check').mockImplementation(async input => ({ current: () => !input.signal?.aborted,
      result: { taskDigest: taskVersion(input.task), inputDigest: 'fixture', evidence: 'advisory-type-elaboration',
        proofAcceptance: 'not-assessed', status: 'elaborated', reason: 'fixture', context: 'Tutorial.add_zero', type: 'True' } }));
  });
  afterEach(async () => {
    controller.abort(); await cooperative.stop();
    expect(host.model).not.toHaveBeenCalled();
    vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });

  it('integrates a battery-closed helper through the ordinary kernel check without a model turn', async () => {
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'followup' } });
    expect(host.lean).toHaveBeenCalledTimes(2);
    expect(host.lean.mock.calls[0][0]).toMatchObject({ context: 'Tutorial.add_zero', type: 'True', expression: tacticBatteryProof(false) });
    expect(host.lean.mock.calls[1][0]).toMatchObject({ context: 'Tutorial.add_zero', type: 'True', expression: vacuityProbeProof(false) });
    expect(node()).toMatchObject({ status: 'integrated', attempts: 0, proof: { passed: true }, integratedCheck: { passed: true } });
    // The complete-source merge preserves the checked projection, so integration reuses its exact receipt.
    expect(host.verify).toHaveBeenCalledOnce();
    expect(host.verify.mock.calls.map(call => call[1].expectedDeclarationType)).toEqual(['True']);
    expect(node().integratedCheck!.verification).toEqual(node().proof!.verification);
    expect(node().integratedCheck!.commit).toBe(state.cooperation!.canonicalCommit);
    expect(node().integratedCheck!.taskDigest).toBe(taskVersion(node().task));
    expect(hasTaskAcceptance(node().integratedCheck!)).toBe(true);
    expect(canonical()).toContain(`theorem helper : True\n  := ${tacticBatteryProof(false)}\n`);
    for (const original of ['theorem add_zero (n : Nat) : n + 0 = n := by sorry', 'theorem zero_add (n : Nat) : 0 + n = n := by sorry'])
      expect(canonical()).toContain(original);
    expect(state.turns).toBe(0); expect(state.cooperation!.groups![0].turns).toBe(0);
    expect(state.cooperation!.deliveries).toContainEqual(expect.objectContaining({ taskId: 'helper', kind: 'proof', status: 'verified' }));
    expect(events()).toEqual([expect.objectContaining({ taskId: 'helper', workerId: 'proof', status: 'closed',
      reason: 'battery-closed-erased-type', passed: true, verificationStatus: 'kernel_verified', commit: expect.any(String) })]);
    expect(events()[0]).not.toHaveProperty('vacuous');
    expect(state.cooperation!.deliveries!.find(item => item.taskId === 'helper')!.summary).not.toContain('vacuity');
  });

  it('still integrates a vacuous battery-closed helper but tells the Lead its hypotheses derive False', async () => {
    host.lean.mockImplementation(async () => leanResult('elaborated'));
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'followup' } });
    expect(node()).toMatchObject({ status: 'integrated', attempts: 0, proof: { passed: true } });
    expect(events()).toEqual([expect.objectContaining({ status: 'closed', passed: true, vacuous: true })]);
    expect(state.cooperation!.deliveries!.find(item => item.taskId === 'helper')!.summary)
      .toContain('Host vacuity probe: its hypotheses alone derive False');
  });

  it.each(['crashed', 'admitted'] as const)('does not report vacuity from a %s probe', async outcome => {
    host.lean.mockImplementation(async input => {
      if (!probe(input)) return leanResult('elaborated');
      if (outcome === 'crashed') throw new Error('fixture_probe_crashed');
      return { ...leanResult('elaborated'), constants: ['sorryAx'] };
    });
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'followup' } });
    expect(node().status).toBe('integrated'); expect(events()[0]).not.toHaveProperty('vacuous');
  });

  it('falls through to normal model work after a failed battery and does not retry the same contract', async () => {
    host.lean.mockImplementation(async () => leanResult('failed'));
    const first = await next();
    expect(first).toMatchObject({ kind: 'task', task: { id: 'helper' } });
    if (first?.kind !== 'task') throw new Error('expected_task_assignment');
    expect(git(workers[1].worktree, ['rev-parse', 'HEAD'])).toBe(first.assignment.seedCommit);
    expect(events()).toEqual([expect.objectContaining({ status: 'failed', reason: 'battery-did-not-close' })]);
    expect(host.verify).not.toHaveBeenCalled(); noDelivery();
    cooperative.release(workers[1], first);
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'helper' } });
    expect(host.lean).toHaveBeenCalledOnce(); expect(events()).toHaveLength(1);
  });

  it('reports a host failure-cache hit without creating proof evidence or reusing an old artifact', async () => {
    vi.spyOn(directSolverModules.M2, 'closeTask').mockResolvedValue({ status: 'failed', reason: 'battery-did-not-close-reused',
      evidence: 'advisory-tactic-battery', proofAcceptance: 'not-accepted', cacheHit: true, cacheKey: 'a'.repeat(64),
      originDiagnosticDigest: 'b'.repeat(64) });
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'helper' } });
    expect(events()).toEqual([expect.objectContaining({ status: 'failed', cacheHit: true, cacheKey: 'a'.repeat(64),
      originDiagnosticDigest: 'b'.repeat(64) })]);
    expect(events()[0]).not.toHaveProperty('artifact'); expect(host.lean).not.toHaveBeenCalled();
    expect(host.verify).not.toHaveBeenCalled(); noDelivery();
  });

  it('returns model work without failure memory when the kernel rejects the battery candidate', async () => {
    host.verify.mockImplementationOnce(async request => failedBatch(verified(request),
      { stdoutPreview: () => 'Submission.lean:3:1: error: unsolved goals' }));
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'helper' } });
    expect(events()).toEqual([expect.objectContaining({ status: 'closed', passed: false, verificationStatus: 'failed' })]);
    expect(node().status).toBe('running'); noDelivery();
  });

  it('keeps the contract eligible when the attempt is superseded while Lean runs', async () => {
    const entered = deferred<void>(), release = deferred<void>();
    host.lean.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return leanResult('failed'); });
    const pending = next(); await entered.promise;
    allowed = false; cooperative.modelBudgetChanged(); release.resolve();
    expect(await pending).toBeUndefined(); expect(events()).toEqual([]);
    expect(node()).toMatchObject({ status: 'pending' }); expect(node().assignment).toBeUndefined();
    allowed = true;
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'followup' } });
    expect(host.lean.mock.calls.filter(call => !probe(call[0]))).toHaveLength(2); expect(node().status).toBe('integrated');
  });

  it.each(['conditional', 'saved-assignment', 'no-context', 'disabled'] as const)('does not run the battery for %s work', async kind => {
    if (kind === 'conditional') node().task = { ...node().task, conditional: true };
    if (kind === 'saved-assignment') node().assignment = { taskId: 'helper', taskDigest: taskVersion(node().task),
      workerId: workers[1].id, seedCommit: state.cooperation!.canonicalCommit!, assignmentId: 'saved' };
    if (kind === 'no-context') vi.mocked(TaskTypePreflightCache.prototype.check).mockImplementation(async input => ({ current: () => true,
      result: { taskDigest: taskVersion(input.task), inputDigest: 'fixture', evidence: 'advisory-type-elaboration',
        proofAcceptance: 'not-assessed', status: 'elaborated', reason: 'fixture' } }));
    if (kind === 'disabled') (cooperative as any).input.modules.M2 = { ...directSolverModules.M2, closeTask: undefined };
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'helper' } });
    expect(host.lean).not.toHaveBeenCalled(); expect(events()).toEqual([]); noDelivery();
  });
});
