import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MathematicsVerifierBatchRequest, MathematicsVerifierBatchResult } from '../src/math/verifier';
import type { SolverRunState } from '../src/solver/archive';
import type { CooperativeResearch } from '../src/solver/cooperation';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { committedSource, commitSolverSources, type SolverProblem } from '../src/solver/problem';
import { assignmentDeliveryFile, taskVersion, type CooperativeAction, type CooperativeTask } from '../src/solver/tasks';
import { deferred } from './helpers/async';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';
import { failedBatch, verifiedBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), createSession: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify,
  formalVerificationToolIdentity: () => undefined,
  resolveMathematicsLakePackagesCache: () => undefined,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));

const verified = (request: MathematicsVerifierBatchRequest) =>
  verifiedBatch(request, { sessionId: 'integration-concurrency-fixture', checks: true });
const settled = (request: MathematicsVerifierBatchRequest, status: 'failed' | 'unavailable' | 'blocked'): MathematicsVerifierBatchResult => {
  const batch = verified(request);
  return status === 'failed' ? failedBatch(batch, { stdoutPreview: () => 'Submission.lean:3:1: error: Fixture merged proof failure.' })
    : { ...batch, status, results: batch.results.map(item => ({ ...item, status, error: 'Fixture merged check failure.' })) };
};
type TaskAction = Extract<CooperativeAction, { kind: 'task' }>;
type Failure = 'abort' | 'storage' | 'unavailable';
type EarlierTurn = 'transport-only' | 'consumed-repair';

describe('task integration with concurrent host control', () => {
  let directory: string, workspace: string, problem: SolverProblem, state: SolverRunState;
  let workers: ResearchWorker[], cooperative: CooperativeResearch, controller: AbortController, action: TaskAction;
  let exclusive: <T>(check: () => Promise<T>) => Promise<T>, lockHeld: boolean;
  let pending: Promise<unknown>[], releases: (() => void)[];
  let events: { event: string; details?: Record<string, unknown> }[];

  const node = () => state.cooperation!.tasks.find(item => item.task.id === action.task.id)!;
  const records = () => state.cooperation!.deliveries ?? [];
  const canonicalSource = () => committedSource(workspace, state.cooperation!.canonicalCommit!,
    `${problem.projectRelative}/Submission.lean`);
  const track = <T,>(promise: Promise<T>) => {
    pending.push(promise); void promise.catch(() => {}); return promise;
  };
  const writeLemma = (worker: ResearchWorker, declaration: string) => {
    const file = path.join(worker.worktree, problem.projectRelative, 'Submission.lean');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('theorem add_zero', declaration + '\ntheorem add_zero'));
    return commitSolverSources(problem, worker.worktree);
  };
  const gateCheck = (call: number) => {
    const entered = deferred<MathematicsVerifierBatchRequest>(), result = deferred<MathematicsVerifierBatchResult>();
    let request: MathematicsVerifierBatchRequest | undefined, heldAtEntry: boolean | undefined, count = 0;
    host.verify.mockImplementation(async (input: MathematicsVerifierBatchRequest) => {
      if (++count !== call) return verified(input);
      request = input; heldAtEntry = lockHeld; entered.resolve(input); return result.promise;
    });
    const release = () => { if (request) result.resolve(verified(request)); };
    releases.push(release);
    return { entered: entered.promise, release, fail: (error: unknown) => result.reject(error),
      finish: (status: 'kernel_verified' | 'failed' | 'unavailable') => result.resolve(status === 'kernel_verified'
        ? verified(request!) : settled(request!, status)), heldAtEntry: () => heldAtEntry };
  };
  const edit = (id: string, change: (task: CooperativeTask) => CooperativeTask, group = (value: object): object => value) => {
    fs.appendFileSync(path.join(directory, 'edits.jsonl'), JSON.stringify({ id, baseVersion: state.cooperation!.planVersion,
      tasks: state.cooperation!.tasks.map(item => change(item.task)), groups: state.cooperation!.groups!.map(item => group(item.group)),
    }) + '\n');
    return track(cooperative.pulse(workers[0].id));
  };
  const expectNoMathematicalFailure = () => {
    expect(records().filter(record => record.kind === 'failure' || record.status === 'failed')).toEqual([]);
    expect(state.cooperation!.failedTaskInputs ?? []).toEqual([]);
    expect(state.cooperation!.blockers ?? []).toEqual([]);
    expect(events.filter(item => item.event === 'delivery_rejected')).toEqual([]);
  };
  const startNextAuthorTurn = async () => {
    const next = await cooperative.next(workers[1], { maxTurns: Infinity, remainingMs: Infinity });
    if (next?.kind !== 'task') throw new Error('fixture_expected_resumed_task');
    expect(next.assignment).toBe(action.assignment);
    expect(cooperative.started(workers[1], next)).toBe(true);
    action = next;
  };
  const startSecondTurn = async (earlier: EarlierTurn) => {
    if (earlier === 'transport-only') {
      await cooperative.deliver(workers[1], action, problem.baseCommit, true, 'request-failure');
      expect(node().sourceRepair).toBeUndefined();
      expect(records()).toEqual([]);
    } else {
      cooperative.rejected(action, 'math_original_context_changed');
      expect(node().sourceRepair?.pending).toBe(true);
    }
    expect(node().status).toBe('pending');
    expect(state.cooperation!.failedTaskInputs ?? []).toEqual([]);
    await startNextAuthorTurn();
    expect(node()).toMatchObject({ status: 'running', attempts: 2 });
    if (earlier === 'consumed-repair') expect(node().sourceRepair?.pending).toBe(false);
    expect(host.verify).not.toHaveBeenCalled();
  };
  const expectUnacceptedSourceRejection = (commit: string) => {
    const rejected = records().filter(record => record.commit === commit);
    expect(rejected.length).toBeGreaterThan(0);
    for (const record of rejected) {
      expect(record).toMatchObject({ kind: 'failure', status: 'failed' });
      expect(record.evidence).toBeUndefined();
      expect(record.actualReferences).toBeUndefined();
    }
    for (const event of events.filter(item => item.event === 'delivery_published' && item.details?.commit === commit)) {
      expect(event.details).toMatchObject({ kind: 'failure', status: 'failed' });
      expect(event.details?.receiptIds).toBeUndefined();
    }
  };
  const finishRepairBudget = async (earlier: EarlierTurn, commit: string) => {
    expect(state.cooperation!.failedTaskInputs).toHaveLength(1);
    const failure = state.cooperation!.failedTaskInputs![0];
    if (earlier === 'transport-only') {
      expect(failure.repair?.pending).toBe(true);
      const checked = host.verify.mock.calls.length;
      await startNextAuthorTurn();
      expect(failure.repair?.pending).toBe(false);
      await (cooperative as any).receive(workers[1], action,
        { id: 'same-input-after-local-repair', kind: 'proof', commit, summary: 'The target is still missing.' }, true);
      expect(host.verify).toHaveBeenCalledTimes(checked);
    } else {
      expect(node().sourceRepair?.pending).toBe(false);
      expect(failure.repair).toBeUndefined();
    }
    expect(node().status).toBe('blocked');
    expect(events.filter(item => item.event === 'task_repair_requested')).toHaveLength(1);
    expectUnacceptedSourceRejection(commit);
  };

  beforeEach(() => {
    host.verify.mockReset().mockImplementation(async request => verified(request));
    host.createSession.mockReset().mockImplementation(() => { throw new Error('fixture_real_models_forbidden'); });
    const example = localExample('solver-integration-concurrency-');
    ({ directory, workspace, problem } = example);
    workers = [leadWorker(problem, workspace), ...['author', 'independent'].map(id => peerWorker(example, id))];
    const task: CooperativeTask = { id: 'integration', kind: 'lemma', objective: 'Prove a reusable integration lemma.',
      theoremName: 'Tutorial.integration_lemma', proofPath: 'Submission.lean', type: 'True', dependsOn: [], revision: 0 };
    action = { kind: 'task', task, assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: workers[1].id,
      seedCommit: problem.baseCommit, assignmentId: 'integration-dispatch', dependencies: [] } };
    state = solverState(problem, workspace, { runId: 'integration-concurrency-fixture', phase: 'running', failures: [],
      cooperation: { canonicalCommit: problem.baseCommit,
        groups: [{ group: { id: 'main', objective: 'Prove the original problem.', status: 'active', revision: 0 }, turns: 0 }],
        tasks: [{ task, assignment: action.assignment, status: 'running', attempts: 1 }, ...problem.targets.map((target, index) => ({
          task: { id: `goal_${index}`, kind: 'goal' as const, objective: `Prove ${target.theoremName}.`,
            theoremName: target.theoremName, proofPath: target.proofPath, dependsOn: [], revision: 0, status: 'paused' as const },
          status: 'pending' as const, attempts: 0,
        }))] } });
    events = []; pending = []; releases = []; lockHeld = false; controller = new AbortController();
    let queue = Promise.resolve();
    exclusive = async check => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>(resolve => { release = resolve; });
      await previous; lockHeld = true;
      try { return await check(); } finally { lockHeld = false; release(); }
    };
    cooperative = cooperativeResearch({ state, workers, retrievalRoot: directory, signal: controller.signal,
      emit: (event, details) => events.push({ event, details }), exclusiveCheck: check => exclusive(check) });
    state.cooperation!.planVersion = (cooperative as any).planVersion();
  });
  afterEach(async () => {
    for (const release of releases) release();
    controller.abort(); await Promise.allSettled(pending); await cooperative.stop();
    expect(host.createSession).not.toHaveBeenCalled();
    vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(['unavailable', 'blocked'] as const)
  ('keeps an earlier passing delivery when a later candidate returns %s', async outcome => {
    const firstCommit = writeLemma(workers[1], 'lemma integration_lemma : True := by trivial');
    const gate = gateCheck(2), first = track(cooperative.deliver(workers[1], action, firstCommit));
    await gate.entered;
    const accepted = node().proof;
    expect(node()).toMatchObject({ status: 'delivered', proof: { passed: true, commit: firstCommit } });
    const file = path.join(workers[1].worktree, problem.projectRelative, 'Submission.lean');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
      'lemma integration_lemma : True := by trivial', 'lemma integration_lemma : True := by exact True.intro'));
    const laterCommit = commitSolverSources(problem, workers[1].worktree);
    host.verify.mockImplementation(async request => settled(request, outcome));

    await expect(track(cooperative.deliver(workers[1], action, laterCommit))).rejects.toThrow('math_verifier_unavailable');

    expect(node().proof).toBe(accepted);
    expect(node()).toMatchObject({ status: 'delivered', proof: { passed: true, commit: firstCommit } });
    expectNoMathematicalFailure();
    host.verify.mockImplementation(async request => verified(request));
    gate.release(); await first;

    expect(node().proof).toBe(accepted);
    expect(node()).toMatchObject({ status: 'integrated', proof: { passed: true, commit: firstCommit }, integratedCheck: { passed: true } });
    expect(canonicalSource()).toContain('lemma integration_lemma : True := by trivial');
    expect(records().filter(record => record.kind === 'proof')).toMatchObject([{ status: 'verified', commit: node().integratedCheck!.commit }]);
    expect(records().some(record => record.commit === laterCommit)).toBe(false);
    expectNoMathematicalFailure();
  });

  it.each(['transport-only', 'consumed-repair'] as const)
  ('does not publish an obsolete successful proof as failed after another submission is rejected (earlier: %s)', async earlier => {
    await startSecondTurn(earlier);
    const declaration = 'lemma integration_lemma : True := by trivial';
    const firstCommit = writeLemma(workers[1], declaration);
    const gate = gateCheck(2), first = track(cooperative.deliver(workers[1], action, firstCommit));
    await gate.entered;
    const accepted = node().proof;
    expect(accepted?.passed).toBe(true);
    const file = path.join(workers[1].worktree, problem.projectRelative, 'Submission.lean');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(declaration + '\n', ''));
    const laterCommit = commitSolverSources(problem, workers[1].worktree);

    await (cooperative as any).receive(workers[1], action,
      { id: 'later-missing-target', kind: 'proof', commit: laterCommit, summary: 'The new candidate is ready.' }, true);

    expect(node().status).toBe(earlier === 'consumed-repair' ? 'blocked' : 'pending');
    expect(node().proof).toBe(accepted);
    expect(state.cooperation!.failedTaskInputs).toEqual([expect.objectContaining({
      taskId: action.task.id, targetDigest: 'declaration-count:0', feedback: expect.stringContaining('math_task_missing_declaration'),
    })]);
    const failure = records().find(record => record.kind === 'failure' && record.commit === laterCommit);
    expect(failure).toMatchObject({ status: 'failed', summary: expect.stringContaining('math_task_missing_declaration') });
    expectUnacceptedSourceRejection(laterCommit);
    gate.release(); await first;

    expect(node().proof).toBe(accepted);
    expect(node().integratedCheck).toBeUndefined();
    expect(state.cooperation!.canonicalCommit).toBe(problem.baseCommit);
    expect(records().filter(record => record.kind === 'proof')).toEqual([]);
    expect(events.filter(item => item.event === 'task_integrated')).toEqual([]);
    expect(records()).toContain(failure);
    expect(state.cooperation!.failedTaskInputs).toHaveLength(1);
    await (cooperative as any).publishProofDelivery(node());
    expect(records().filter(record => record.kind === 'proof')).toEqual([]);
    await finishRepairBudget(earlier, laterCommit);
    expect(node().integratedCheck).toBeUndefined();
    expect(records().filter(record => record.kind === 'proof')).toEqual([]);
  });

  it.each(['transport-only', 'consumed-repair'] as const)
  ('does not reuse a later rejection when publication waits after a successful integration (earlier: %s)', async earlier => {
    await startSecondTurn(earlier);
    const declaration = 'lemma integration_lemma : True := by trivial';
    const firstCommit = writeLemma(workers[1], declaration);
    const entered = deferred(), released = deferred();
    releases.push(() => released.resolve());
    const publish = (cooperative as any).publishProofDelivery.bind(cooperative);
    vi.spyOn(cooperative as any, 'publishProofDelivery').mockImplementationOnce(async (...args: unknown[]) => {
      entered.resolve(); await released.promise;
      return publish(...args);
    });
    const first = track(cooperative.deliver(workers[1], action, firstCommit));
    await entered.promise;
    expect(node()).toMatchObject({ status: 'integrated', proof: { passed: true, commit: firstCommit }, integratedCheck: { passed: true } });
    const accepted = node().proof, integrated = node().integratedCheck, canonical = state.cooperation!.canonicalCommit;
    const file = path.join(workers[1].worktree, problem.projectRelative, 'Submission.lean');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(declaration + '\n', ''));
    const laterCommit = commitSolverSources(problem, workers[1].worktree);

    await (cooperative as any).receive(workers[1], action,
      { id: 'missing-target-before-publication', kind: 'proof', commit: laterCommit, summary: 'The new candidate is ready.' }, true);

    expect(node().status).toBe(earlier === 'consumed-repair' ? 'blocked' : 'pending');
    expect(node().proof).toBe(accepted);
    expectUnacceptedSourceRejection(laterCommit);
    released.resolve(); await first;

    expect(state.cooperation!.canonicalCommit).toBe(canonical);
    expect(node().integratedCheck).toBe(integrated);
    expect(canonicalSource()).toContain(declaration);
    expect(records().filter(record => record.kind === 'proof' && record.commit === firstCommit)).toEqual([]);
    expect(records().filter(record => record.kind === 'failure' && record.commit === laterCommit)).toMatchObject([
      { status: 'failed', commit: laterCommit, summary: expect.stringContaining('math_task_missing_declaration') },
    ]);
    await finishRepairBudget(earlier, laterCommit);
    expect(state.cooperation!.canonicalCommit).toBe(canonical);
    expect(node().integratedCheck).toBe(integrated);
    expect(records().filter(record => record.kind === 'proof')).toEqual([]);
    expect(events.filter(item => item.event === 'task_integrated')).toHaveLength(1);
  });

  it.each(['transport-only', 'consumed-repair'] as const)
  ('keeps a merged failure distinct from a later source rejection during publication (earlier: %s)', async earlier => {
    await startSecondTurn(earlier);
    const declaration = 'lemma integration_lemma : True := by trivial';
    const firstCommit = writeLemma(workers[1], declaration);
    const gate = gateCheck(2), first = track(cooperative.deliver(workers[1], action, firstCommit));
    await gate.entered;
    const entered = deferred(), released = deferred();
    releases.push(() => released.resolve());
    const publish = (cooperative as any).publishProofDelivery.bind(cooperative);
    vi.spyOn(cooperative as any, 'publishProofDelivery').mockImplementationOnce(async (...args: unknown[]) => {
      entered.resolve(); await released.promise;
      return publish(...args);
    });
    gate.finish('failed'); await entered.promise;
    const accepted = node().proof, mergedFailure = node().integratedCheck;
    expect(node()).toMatchObject({ status: 'blocked', proof: { passed: true, commit: firstCommit },
      integratedCheck: { passed: false }, feedback: expect.stringContaining('math_task_merged_proof_failed') });
    const file = path.join(workers[1].worktree, problem.projectRelative, 'Submission.lean');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(declaration + '\n', ''));
    const laterCommit = commitSolverSources(problem, workers[1].worktree);

    await (cooperative as any).receive(workers[1], action,
      { id: 'missing-target-after-merged-failure', kind: 'proof', commit: laterCommit, summary: 'The new candidate is ready.' }, true);

    expect(node().feedback).toContain('math_task_missing_declaration');
    expect(node().status).toBe(earlier === 'consumed-repair' ? 'blocked' : 'pending');
    expect(node().proof).toBe(accepted);
    expect(node().integratedCheck).toBe(mergedFailure);
    expectUnacceptedSourceRejection(laterCommit);
    released.resolve(); await first;

    const proofFailures = () => records().filter(record => record.kind === 'proof' && record.commit === firstCommit);
    if (earlier === 'consumed-repair') {
      expect(proofFailures()).toMatchObject([{ status: 'failed', summary: expect.stringContaining('math_task_merged_proof_failed') }]);
      expect(proofFailures()[0].summary).toContain('Fixture merged proof failure.');
      expect(proofFailures()[0].summary).not.toContain('math_task_missing_declaration');
      expect(proofFailures()[0].evidence?.verification.targetCommit).toBe(accepted!.verification.targetCommit);
      expect(proofFailures()[0].evidence?.verification.results).toEqual(
        accepted!.verification.results.map(({ receiptId }) => ({ receiptId })));
    } else expect(proofFailures()).toEqual([]);
    const failures = [...proofFailures()];
    expect(records().filter(record => record.kind === 'failure' && record.commit === laterCommit)).toMatchObject([
      { status: 'failed', commit: laterCommit, summary: expect.stringContaining('math_task_missing_declaration') },
    ]);
    expect(state.cooperation!.failedTaskInputs).toHaveLength(1);
    expect(state.cooperation!.canonicalCommit).toBe(problem.baseCommit);

    await (cooperative as any).publishProofDelivery(node());
    expect(proofFailures()).toEqual(failures);
    await finishRepairBudget(earlier, laterCommit);
    await (cooperative as any).publishProofDelivery(node());
    expect(proofFailures()).toEqual(failures);
    expect(node().proof).toBe(accepted);
    expect(node().integratedCheck).toBe(mergedFailure);
    expect(records().some(record => record.kind === 'proof' && record.status === 'verified')).toBe(false);
    expect(events.filter(item => item.event === 'task_integrated')).toEqual([]);
    expect(state.cooperation!.canonicalCommit).toBe(problem.baseCommit);
  });

  it.each([
    { change: 'pause', verdict: 'kernel_verified' }, { change: 'pause', verdict: 'failed' },
    { change: 'revise', verdict: 'kernel_verified' }, { change: 'revise', verdict: 'failed' },
  ] as const)('applies a $change edit before the pending merged $verdict check finishes and discards its stale result', async ({ change, verdict }) => {
    const commit = writeLemma(workers[1], 'lemma integration_lemma : True := by trivial');
    const gate = gateCheck(2), delivery = track(cooperative.deliver(workers[1], action, commit));
    await gate.entered;
    expect(node()).toMatchObject({ status: 'delivered', proof: { passed: true, commit } });
    const checked = node().proof;

    let applied = false;
    const pulse = edit('control-during-merge', task => task.id !== action.task.id ? task : change === 'pause'
      ? { ...task, status: 'paused' } : { ...task, revision: task.revision + 1, type: 'True ∧ True' });
    void pulse.then(() => { applied = true; });
    await vi.waitFor(() => {
      expect(state.cooperation!.edits).toContainEqual(expect.objectContaining({ id: 'control-during-merge', status: 'applied' }));
      expect(applied).toBe(true);
    });
    expect(gate.heldAtEntry()).toBe(false);
    expect(cooperative.current(action)).toBe(false);
    expect(state.cooperation!.canonicalCommit).toBe(problem.baseCommit);
    const current = node(), snapshot = JSON.parse(JSON.stringify(current));

    gate.finish(verdict); await delivery;

    expect(node()).toBe(current);
    expect(node()).toEqual(snapshot);
    expect(node().integratedCheck).toBeUndefined();
    if (change === 'pause') expect(node().proof).toBe(checked);
    else expect(node().proof).toBeUndefined();
    expect(state.cooperation!.canonicalCommit).toBe(problem.baseCommit);
    expect(canonicalSource()).not.toContain('lemma integration_lemma');
    expect(records().filter(record => record.kind === 'proof' && ['verified', 'failed'].includes(record.status))).toEqual([]);
    expect(events.filter(item => item.event === 'task_integrated')).toEqual([]);
    expectNoMathematicalFailure();
  });

  it.each(['maxConcurrent', 'maxTurns'] as const)
  ('rechecks a delivered proof after a concurrent group %s control change without publishing a failure', async control => {
    const commit = writeLemma(workers[1], 'lemma integration_lemma : True := by trivial');
    const gate = gateCheck(2), delivery = track(cooperative.deliver(workers[1], action, commit));
    await gate.entered;
    const delivered = node(), checked = delivered.proof;
    const editId = `group-${control}-during-merge`;
    let applied = false;
    const pulse = edit(editId, task => task, group => ({ ...group, [control]: 2 }));
    void pulse.then(() => { applied = true; });
    await vi.waitFor(() => {
      expect(state.cooperation!.edits).toContainEqual(expect.objectContaining({ id: editId, status: 'applied' }));
      expect(applied).toBe(true);
    });
    expect(gate.heldAtEntry()).toBe(false);
    expect(cooperative.current(action)).toBe(true);
    expect(node()).toBe(delivered);
    expect(node().proof).toBe(checked);
    expect(state.cooperation!.canonicalCommit).toBe(problem.baseCommit);
    expectNoMathematicalFailure();

    gate.release(); await delivery;

    expect(node()).toMatchObject({ status: 'integrated', integratedCheck: { passed: true } });
    expect(node().proof).toBe(checked);
    expect(canonicalSource()).toContain('lemma integration_lemma : True := by trivial');
    expect(host.verify).toHaveBeenCalledTimes(3);
    expect(records().filter(record => record.kind === 'proof')).toMatchObject([
      { taskId: action.task.id, status: 'verified', commit: node().integratedCheck!.commit },
    ]);
    expect(events.filter(item => item.event === 'task_integrated')).toHaveLength(1);
    expect(events.find(item => item.event === 'task_integrated')?.details).toMatchObject({
      taskId: action.task.id, taskDigest: action.assignment.taskDigest, workerId: action.assignment.workerId,
      assignmentKey: assignmentDeliveryFile(action.assignment), seedCommit: action.assignment.seedCommit,
      commit: node().integratedCheck!.commit, sourceDigest: node().integratedCheck!.sourceDigest,
      receiptIds: node().integratedCheck!.verification.results.map(result => result.receiptId),
    });
    expectNoMathematicalFailure();
  });

  it('remerges and rechecks after canonical advancement without losing an independent declaration', async () => {
    const commit = writeLemma(workers[1], 'lemma integration_lemma : True := by trivial');
    const gate = gateCheck(2), delivery = track(cooperative.deliver(workers[1], action, commit));
    const originalMerged = await gate.entered;
    // This independent source checkpoint is not represented as a checked task or accepted proof.
    const independent = writeLemma(workers[2], 'lemma independent_lemma : True := by trivial');
    let advanced = false;
    const advance = track(exclusive(async () => {
      state.cooperation!.canonicalCommit = independent; (cooperative as any).changed(); advanced = true;
    }));
    await vi.waitFor(() => expect(advanced).toBe(true)); await advance;
    expect(gate.heldAtEntry()).toBe(false);
    expect(canonicalSource()).toContain('lemma independent_lemma : True := by trivial');

    gate.release(); await delivery;

    expect(node()).toMatchObject({ status: 'integrated', integratedCheck: { passed: true } });
    expect(state.cooperation!.canonicalCommit).not.toBe(independent);
    expect(canonicalSource()).toContain('lemma integration_lemma : True := by trivial');
    expect(canonicalSource()).toContain('lemma independent_lemma : True := by trivial');
    expect(host.verify).toHaveBeenCalledTimes(3);
    expect(host.verify.mock.calls[2][0].targetCommit).not.toBe(originalMerged.targetCommit);
    expect(records().filter(record => record.kind === 'proof')).toMatchObject([
      { taskId: action.task.id, status: 'verified', commit: node().integratedCheck!.commit },
    ]);
    expectNoMathematicalFailure();
  });

  it('shares an in-flight exact proof delivery so concurrent duplicates do not repeat verification', async () => {
    const commit = writeLemma(workers[1], 'lemma integration_lemma : True := by trivial');
    const gate = gateCheck(1), first = track(cooperative.deliver(workers[1], action, commit));
    await gate.entered;
    const duplicate = track(cooperative.deliver(workers[1], action, commit));
    await Promise.resolve(); await Promise.resolve();
    expect(host.verify).toHaveBeenCalledTimes(1);

    gate.release(); await Promise.all([first, duplicate]);
    await cooperative.deliver(workers[1], action, commit);

    expect(node()).toMatchObject({ status: 'integrated', proof: { passed: true, commit }, integratedCheck: { passed: true } });
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(records().filter(record => record.kind === 'proof')).toMatchObject([
      { taskId: action.task.id, status: 'verified', commit: node().integratedCheck!.commit },
    ]);
    expect(events.filter(item => item.event === 'task_integrated')).toHaveLength(1);
    expectNoMathematicalFailure();
  });

  it('records a worker waiting on the real canonical integration queue and clears it on entry', async () => {
    state.workers = workers.map(worker => ({ id: worker.id, role: worker.role, worktree: worker.worktree,
      phase: 'running', turns: 0 }));
    const held = deferred(), release = () => held.resolve(); releases.push(release);
    const first = track((cooperative as any).queueIntegration(() => held.promise));
    const commit = writeLemma(workers[1], 'lemma integration_lemma : True := by trivial');
    const delivery = track(cooperative.deliver(workers[1], action, commit));
    const worker = state.workers[1];
    await vi.waitFor(() => expect(worker.scheduling?.wait).toMatchObject({ stage: 'integration-queue',
      candidates: [{ taskId: action.task.id, reason: 'integration-queue' }] }));
    expect(node()).toMatchObject({ status: 'delivered', proof: { passed: true } });
    expect(state.cooperation!.canonicalCommit).toBe(problem.baseCommit);
    release(); await Promise.all([first, delivery]);
    expect(worker.scheduling?.wait).toBeUndefined();
    expect(node()).toMatchObject({ status: 'integrated', integratedCheck: { passed: true } });
    expect(events.some(item => item.event === 'dispatch_wait_ended' && item.details?.stage === 'integration-queue')).toBe(true);
  });

  it.each(['abort', 'storage', 'unavailable'] as const)
  ('retains the checked delivery after a merged %s fault and retries only integration', async (failure: Failure) => {
    const commit = writeLemma(workers[1], 'lemma integration_lemma : True := by trivial');
    const gate = gateCheck(2), delivery = track(cooperative.deliver(workers[1], action, commit));
    await gate.entered;
    const checked = node().proof;
    const error = failure === 'abort' ? new DOMException('Merged check interrupted.', 'AbortError') :
      failure === 'storage' ? Object.assign(new Error('Transient integration storage failure.'), { code: 'EIO' }) :
        new Error('math_verifier_unavailable');
    if (failure === 'unavailable') gate.finish('unavailable');
    else gate.fail(error);

    await expect(delivery).rejects.toMatchObject({ name: error.name, message: error.message });

    expect(node()).toMatchObject({ status: 'delivered', proof: { passed: true, commit } });
    expect(node().proof).toBe(checked);
    expect(node().integratedCheck).toBeUndefined();
    expect(state.cooperation!.canonicalCommit).toBe(problem.baseCommit);
    expect(records()).toEqual([]);
    expectNoMathematicalFailure();

    await cooperative.deliver(workers[1], action, commit);

    expect(node()).toMatchObject({ status: 'integrated', integratedCheck: { passed: true } });
    expect(node().proof).toBe(checked);
    expect(host.verify).toHaveBeenCalledTimes(3);
    expect(records().filter(record => record.kind === 'proof')).toMatchObject([{ status: 'verified', commit: node().integratedCheck!.commit }]);
    expectNoMathematicalFailure();
  });
});
