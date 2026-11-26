import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { git } from '../src/solver/problem';
import { runSolver } from '../src/solver/run';
import { VerificationCheckpointError } from '../src/solver/verificationCheckpoint';

const host = vi.hoisted(() => ({ evaluate: vi.fn(), research: vi.fn(), prepare: vi.fn() }));
vi.mock('../src/math/mathBuildManifest', () => ({ readMathBuildManifest: vi.fn() }));
vi.mock('../src/math/leanDiagnostics', async original => ({
  ...await original<typeof import('../src/math/leanDiagnostics')>(),
  runLeanDiagnostics: host.prepare,
}));
vi.mock('../src/math/leanToolchainReadiness', () => ({ checkResolvedLeanToolchainReadiness: () => ({ status: 'ready' }) }));
vi.mock('../src/runtime/codexConnectivity', () => ({ checkCodexProviderConnectivity: async () => ({ status: 'reachable' }) }));
vi.mock('../src/math/verifier', async original => ({
  ...await original<typeof import('../src/math/verifier')>(), resolveMathematicsLakePackagesCache: () => undefined,
}));
vi.mock('../src/solver/research', () => ({ runResearchWorkers: host.research }));
vi.mock('../src/solver/evaluation', () => ({ evaluateSolverProof: host.evaluate }));

describe('evaluator failure attribution in persisted run results', () => {
  let directory: string, output: string, args: string[];
  beforeEach(() => {
    vi.clearAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => {});
    host.prepare.mockReset().mockResolvedValue({ exitCode: 0, timedOut: false, phases: [] });
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaluator-run-')));
    const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), {
      source: 'theorem fixture : True := by sorry\n', task: 'Prove the fixture.',
    });
    const task = path.join(directory, 'task.md'), build = path.join(directory, 'build.json');
    fs.writeFileSync(task, 'Prove the fixture.'); fs.writeFileSync(build, '{}');
    output = path.join(directory, 'result.json');
    args = ['--workspace', receipt.workspaceRoot, '--task-file', task, '--build-manifest', build, '--output', output,
      '--workers', '1', '--max-run-seconds', '0', '--max-turns', '0', '--max-turn-seconds', '0', '--evaluator-timeout-seconds', '0',
      '--no-explanations'];
    // This fixture tests persistence and dispatch only. It grants no Lean or model evidence.
    host.research.mockImplementation(async ({ state }) => {
      const check = { passed: true, commit: git(state.worktree, ['rev-parse', 'HEAD']), sourceDigest: 'fixture', verification: {} };
      state.check = check; state.winningWorker = 'solver';
      return { worktree: state.worktree, check };
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(directory, { recursive: true, force: true }); });

  it('permits unlimited preparation past an hour without arming an overflowing timer or dispatching a model', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    host.prepare.mockImplementation(async ({ timeoutMs, signal }) => {
      expect(timeoutMs).toBe(Infinity);
      await vi.advanceTimersByTimeAsync(3_600_001);
      expect(signal.aborted).toBe(false);
      return { exitCode: 0, timedOut: false, phases: [] };
    });
    expect(await runSolver([...args, '--prepare-timeout-seconds', '0', '--startup-only'], directory)).toBe(0);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'prepared', startup_only: true });
    expect(timers.mock.calls.every(([, milliseconds]) => milliseconds === undefined || Number.isFinite(milliseconds))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(host.research).not.toHaveBeenCalled();
    expect(host.evaluate).not.toHaveBeenCalled();
  });

  it.each([1, 2_147_484])('interrupts preparation at its explicit %s-second deadline', async seconds => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let observed: { timeoutMs: number; abortedBeforeDeadline: boolean; abortedAtDeadline: boolean } | undefined;
    host.prepare.mockImplementation(async ({ timeoutMs, signal }) => {
      await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
      const abortedBeforeDeadline = signal.aborted;
      await vi.advanceTimersByTimeAsync(1);
      observed = { timeoutMs, abortedBeforeDeadline, abortedAtDeadline: signal.aborted };
      signal.throwIfAborted();
      throw new Error('fixture_finite_preparation_should_abort');
    });
    expect(await runSolver([...args, '--prepare-timeout-seconds', String(seconds), '--startup-only'], directory)).toBe(4);
    expect(observed).toEqual({ timeoutMs: seconds * 1000, abortedBeforeDeadline: false, abortedAtDeadline: true });
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'limit_reached', reason: 'math_preparation_stopped' });
    expect(vi.getTimerCount()).toBe(0);
    expect(host.research).not.toHaveBeenCalled();
    expect(host.evaluate).not.toHaveBeenCalled();
  });

  it.each(['math_evaluator_environment_unavailable', 'math_evaluation_timeout'])(
    'persists %s at the top level so the controller cannot treat it as an unsolved proof', async reason => {
      host.evaluate.mockResolvedValue({ status: 'error', reason, method: 'external-command', result: { exitCode: 1 } });
      expect(await runSolver(args, directory)).toBe(1);
      expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'runtime_error', reason,
        completion_signal_valid: false, evaluator: { status: 'error', reason } });
      expect(host.research).toHaveBeenCalledOnce();
    });

  it('retains a mathematical evaluator rejection as evaluated_failed', async () => {
    host.evaluate.mockResolvedValue({ status: 'failed', method: 'external-command', result: { exitCode: 1 } });
    expect(await runSolver(args, directory)).toBe(2);
    const result = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(result).toMatchObject({ status: 'evaluated_failed', completion_signal_valid: false,
      evaluator: { status: 'failed', result: { exitCode: 1 } } });
    expect(result).not.toHaveProperty('reason');
  });

  it('separates proof deadlines from unlimited solving and persists a resumable verification result', async () => {
    host.research.mockImplementation(async ({ state, proofTimeoutMs }) => {
      expect(proofTimeoutMs).toBe(1800_000);
      const checkpoint = { key: 'a'.repeat(64), timeoutMs: proofTimeoutMs, attempts: 1, at: Date.now(),
        targetCommit: git(state.worktree, ['rev-parse', 'HEAD']), receiptIds: [] };
      state.verificationCheckpoints = [checkpoint];
      throw new VerificationCheckpointError(checkpoint);
    });
    expect(await runSolver([...args, '--proof-timeout-seconds', '1800'], directory)).toBe(4);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'limit_reached', reason: 'math_verification_checkpoint',
      evaluator: { status: 'skipped' } });
    const state = JSON.parse(fs.readFileSync(output + '.runtime/state.json', 'utf8'));
    expect(state.verificationCheckpoints).toHaveLength(1); expect(state.error).toBeUndefined();
    expect(host.evaluate).not.toHaveBeenCalled();
  });
});
