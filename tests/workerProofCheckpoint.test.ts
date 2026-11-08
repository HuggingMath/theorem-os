import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { localExample, leadWorker, peerWorker, solverState } from './helpers/solver';
import { receiptBatch } from './helpers/verifier';
import { commitSolverSources } from '../src/solver/problem';
import { ownedSourceDigest } from '../src/solver/cooperativeProof';
import { proofReadyRecord } from '../src/solver/proofReady';
import { taskVersion, parseCooperationPlan, type TaskAssignment } from '../src/solver/tasks';
import { directSolverModules } from '../src/solver/modules';
import { runResearchWorkers } from '../src/solver/research';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { withVerificationCheckpoints, VerificationCheckpointError } from '../src/solver/verificationCheckpoint';
import { deferred } from './helpers/async';

const host = vi.hoisted(() => ({ verify: vi.fn(), open: vi.fn() }));
vi.mock('../src/math/verifier', async original => ({ ...await original<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, formalVerificationToolIdentity: () => 'checkpoint-fixture',
  resolveMathematicsLakePackagesCache: () => undefined }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.open }));

let directory: string;
afterEach(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

function frozenProofFixture() {
  host.open.mockReset(); host.verify.mockReset();
  const example = localExample('worker-proof-checkpoint-', 'lead'); directory = example.directory;
  const lead = leadWorker(example.problem, example.workspace), peer = peerWorker(example, 'engineer', { role: 'engineer' });
  const sourceFile = path.join(peer.worktree, example.problem.projectRelative, 'Submission.lean');
  fs.writeFileSync(sourceFile, fs.readFileSync(sourceFile, 'utf8').replace('by sorry', 'by rfl'));
  const commit = commitSolverSources(example.problem, peer.worktree);
  const plan = parseCooperationPlan(example.problem, { tasks: example.problem.targets.map((target, index) => ({
    id: `goal_${index}`, kind: 'goal', objective: 'Prove the original goal.', proofPath: target.proofPath,
    theoremName: target.theoremName, ownerId: peer.id,
  })) });
  const task = plan.tasks[0]!;
  const assignment: TaskAssignment = { taskId: task.id, taskDigest: taskVersion(task), workerId: peer.id,
    seedCommit: example.problem.baseCommit, assignmentId: 'frozen-assignment' };
  const ready = { ...proofReadyRecord({ assignment, workerId: peer.id, submissionId: 'saved-ready',
    environmentDigest: 'environment', problemReceiptDigest: example.problem.receiptDigest, now: 1 }),
    status: 'frozen' as const, snapshotCommit: commit, sourceDigest: ownedSourceDigest(example.problem, peer.worktree, commit), frozenAt: 2 };
  let state = solverState(example.problem, example.workspace, { runId: 'same-frozen-run', phase: 'running', workerCount: 2,
    workers: [lead, peer].map(worker => ({ ...worker, phase: 'running', turns: 0 })),
    cooperation: { canonicalCommit: example.problem.baseCommit, planVersion: 'fixture-plan', planEdited: true,
      groups: plan.groups.map(group => ({ group, turns: 0 })), leadWakes: { requested: 0, consumed: 0, settled: 0 },
      tasks: plan.tasks.map(item => ({ task: item, status: 'pending', attempts: 1,
        ...(item === task ? { assignment } : {}) })), proofReadyRecords: [ready] } });
  const file = path.join(directory, 'state.json'), environmentFile = path.join(directory, 'math.env'); fs.writeFileSync(environmentFile, '');
  const access = new Map([lead, peer].map(worker => [worker.id, { environment: {
    PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: environmentFile }, retrievalRoot: directory }]));
  host.open.mockImplementation(() => { throw new Error('unexpected_model_writer'); });
  const execute = (signal: AbortSignal, emit: (event: string) => void = () => {}) => withVerificationCheckpoints({
    environmentDigest: state.environmentDigest, problemReceiptDigest: state.problem.receiptDigest,
    checkpoints: state.verificationCheckpoints ??= [], save: () => writeSolverRunState(file, state), emit,
  }, () => runResearchWorkers({ state, workers: [lead, peer], access, modules: { ...directSolverModules,
    M2: { ...directSolverModules.M2, closeTask: undefined } }, root: directory, buildFile: 'unused', taskText: 'Prove the goals.',
    executable: 'unused', profile: 'unused', signal, deadline: Infinity, maxTurns: Infinity,
    maxTurnMs: Infinity, maxTotalTokens: 0, proofTimeoutMs: 1000, save: () => writeSolverRunState(file, state), emit }));
  return { commit, execute, get state() { return state; }, reload() { state = readSolverRunState(file); } };
}

const timedOut = (request: Parameters<typeof receiptBatch>[0]) => {
  const batch = receiptBatch(request, { sessionId: 'timeout', receiptId: i => `timeout-${i}` });
  return { ...batch, status: 'blocked' as const, results: batch.results.map(item => ({ ...item,
    status: 'blocked' as const, error: 'Lean verification timed out.' })) };
};

it('checkpoints and restores a frozen cooperative proof before any new model writer starts', async () => {
  const f = frozenProofFixture();
  host.verify.mockImplementation(async request => timedOut(request));
  const failure = await f.execute(new AbortController().signal).catch(error => error);
  expect(failure).toBeInstanceOf(VerificationCheckpointError);
  f.reload();
  expect(f.state.cooperation!.proofReadyRecords![0]).toMatchObject({ status: 'frozen', snapshotCommit: f.commit });
  expect(f.state.cooperation!.tasks[0]!.status).toBe('pending'); expect(host.open).not.toHaveBeenCalled();
  host.verify.mockImplementation(async request => receiptBatch(request, { sessionId: 'resumed', receiptId: i => `resumed-${i}` }));
  const resumed = new AbortController();
  await expect(f.execute(resumed.signal, event => { if (event === 'proof_ready_checked') resumed.abort(); })).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.state.runId).toBe('same-frozen-run');
  expect(f.state.cooperation!.proofReadyRecords![0]).toMatchObject({ status: 'checked', snapshotCommit: f.commit });
  expect(host.open).not.toHaveBeenCalled();
  expect(host.verify.mock.calls[0]![0].timeoutMs).toBe(1000);
  expect(host.verify.mock.calls[1]![0].timeoutMs).toBe(2000);
});

it.each([false, true])('retains the frozen candidate across a cancelled verification and repeated restarts (prior timeout: %s)', async priorTimeout => {
  const f = frozenProofFixture();
  if (priorTimeout) {
    host.verify.mockImplementation(async request => timedOut(request));
    await expect(f.execute(new AbortController().signal)).rejects.toBeInstanceOf(VerificationCheckpointError);
    f.reload();
  }
  const checkpoints = structuredClone(f.state.verificationCheckpoints ?? []);
  const started = deferred();
  host.verify.mockImplementation(async (_request, options) => {
    started.resolve();
    options.signal.throwIfAborted();
    await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort',
      () => reject(new DOMException('Cancelled verification', 'AbortError')), { once: true }));
  });
  const cancelled = new AbortController(), pending = f.execute(cancelled.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await started.promise; cancelled.abort(); await rejected;
  f.reload();
  expect(f.state.verificationCheckpoints ?? []).toEqual(checkpoints);
  expect(f.state.cooperation!.proofReadyRecords![0]).toMatchObject({ status: 'frozen', snapshotCommit: f.commit });
  expect(f.state.cooperation!.tasks[0]!.status).toBe('pending');
  expect(f.state.turns).toBe(0); expect(f.state.check?.passed).not.toBe(true);

  host.verify.mockClear().mockImplementation(async request => timedOut(request));
  for (const expected of priorTimeout ? [2000, 4000] : [1000, 2000]) {
    await expect(f.execute(new AbortController().signal)).rejects.toBeInstanceOf(VerificationCheckpointError);
    f.reload();
    expect(f.state.verificationCheckpoints).toMatchObject([{ timeoutMs: expected }]);
    expect(f.state.cooperation!.proofReadyRecords![0]).toMatchObject({ status: 'frozen', snapshotCommit: f.commit });
    expect(f.state.check?.passed).not.toBe(true);
  }
  const limits = host.verify.mock.calls.map(([request]) => request.timeoutMs);
  expect(limits).toEqual(priorTimeout ? [2000, 4000] : [1000, 2000]);
  host.verify.mockImplementation(async request => receiptBatch(request, { sessionId: 'fresh-after-cancellation', receiptId: i => `fresh-${i}` }));
  const resumed = new AbortController();
  await expect(f.execute(resumed.signal, event => { if (event === 'proof_ready_checked') resumed.abort(); }))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(f.state.cooperation!.proofReadyRecords![0]).toMatchObject({ status: 'checked', snapshotCommit: f.commit,
    receiptIds: ['fresh-0'] });
  expect(f.state.runId).toBe('same-frozen-run'); expect(f.state.turns).toBe(0);
  expect(host.open).not.toHaveBeenCalled();
});
