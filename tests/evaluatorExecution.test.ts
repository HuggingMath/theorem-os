import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MathematicsSandboxCommandResult } from '../src/math/verifier';
import { evaluateSolverProof, evaluatorExecutionFailure } from '../src/solver/evaluation';
import type { ProofCheck } from '../src/solver/modules/evidence';
import type { SolverProblem } from '../src/solver/problem';

const host = vi.hoisted(() => ({ run: vi.fn(), check: vi.fn(), git: vi.fn(), official: vi.fn() }));
vi.mock('../src/math/verifier', () => ({ runMathematicsSandboxedCommand: host.run }));
vi.mock('../src/solver/modules/evidence', () => ({ checkSolverProof: host.check }));
vi.mock('../src/solver/problem', () => ({ git: host.git,
  withSolverWorktree: (_workspace: string, _commit: string, run: (checkout: string) => Promise<unknown>) => run('/fixture/snapshot') }));
vi.mock('../src/math/leanEvalBootstrap', () => ({ runPersistedLeanEvalOfficialGate: host.official }));

const commandResult = (changes: Partial<MathematicsSandboxCommandResult> = {}): MathematicsSandboxCommandResult => ({
  started: true, exitCode: 1, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 1,
  ...changes,
});
const receipt = { passed: true, commit: 'candidate', sourceDigest: 'source', verification: {} } as ProofCheck;
const problem = { kind: 'lean-task', workspace: '/fixture/main', projectRelative: 'generated/problem', baseCommit: 'base' } as SolverProblem;
const evaluate = (input = problem) => evaluateSolverProof(input, receipt, {},
  new AbortController().signal, { command: 'original-comparator comparator.json', timeoutMs: Infinity });

beforeEach(() => {
  vi.clearAllMocks();
  host.git.mockImplementation((_workspace, args) => args[0] === 'rev-parse' ? 'base' : '');
  host.check.mockResolvedValue(receipt);
});

describe('external evaluator execution failures', () => {
  it.each([
    { started: false }, { exitCode: null }, { signal: 'SIGABRT' as const },
    { exitCode: 126 }, { exitCode: 127 }, { aborted: true },
  ])('keeps execution failure %j separate from mathematical rejection', async changes => {
    const result = commandResult(changes);
    host.run.mockResolvedValue(result);
    expect(await evaluate()).toEqual({ status: 'error', reason: 'math_evaluator_environment_unavailable',
      method: 'external-command', official: false, result });
    expect(host.check).toHaveBeenCalledOnce();
  });

  it.each([
    'libc++abi: terminating due to uncaught exception of type lean::exception: failed to create thread: Resource temporarily unavailable\nuncaught exception: Child exited with 134\n',
    "uncaught exception: process 'landrun' exited with code 1\nstderr:\ncould not execute external process 'lean'\n",
    "fatal: unable to access 'https://github.com/leanprover-community/mathlib4.git/': Could not resolve host: github.com\n",
    "cp: cannot create regular file '.lake/build/fixture': Read-only file system\n",
  ])('recognizes a fixed infrastructure diagnostic without accepting the submission', async stderr => {
    const result = commandResult({ stderr }); host.run.mockResolvedValue(result);
    expect(await evaluate()).toMatchObject({ status: 'error', reason: 'math_evaluator_environment_unavailable', result });
  });

  it.each([
    "uncaught exception: Illegal axiom detected: 'sorryAx'\n",
    'The types of the theorems do not match.\n',
    'Submission.lean:3:1: error: unsolved goals\n',
    'Submission.lean:5:1: error: failed to create thread: Resource temporarily unavailable\n',
    'arbitrary failure mentioning Read-only file system\n',
    'an unknown comparator rejection\n',
  ])('preserves a mathematical or unknown comparator exit as failed', async stderr => {
    const result = commandResult({ stderr }); host.run.mockResolvedValue(result);
    expect(await evaluate()).toEqual({ status: 'failed', method: 'external-command', official: false, result });
  });

  it('does not reinterpret compiler diagnostic text on a successful command', async () => {
    const result = commandResult({ exitCode: 0, stderr: "could not execute external process 'lean'\n" });
    host.run.mockResolvedValue(result);
    expect(await evaluate()).toEqual({ status: 'passed', method: 'external-command', official: false, result });
  });

  it('retains timeout identity and the entire original process result', async () => {
    const result = commandResult({ timedOut: true }); host.run.mockResolvedValue(result);
    expect(await evaluate()).toEqual({ status: 'error', reason: 'math_evaluation_timeout',
      method: 'external-command', official: false, result });
  });

  it('does not dispatch the external comparator when the integrated proof differs', async () => {
    host.check.mockResolvedValue({ ...receipt, sourceDigest: 'changed' });
    await expect(evaluate()).rejects.toThrow('math_integrated_proof_mismatch');
    expect(host.run).not.toHaveBeenCalled();
  });

  it('applies the same failure distinction to the official gate', async () => {
    const comparison = { status: 'failed', ...commandResult(),
      stderrPreview: "could not execute external process 'lean'\n" };
    host.official.mockResolvedValue({ comparison });
    const value = await evaluateSolverProof({ ...problem, kind: 'lean-eval', sourceRepository: '/fixture/source' },
      receipt, {}, new AbortController().signal, { timeoutMs: Infinity });
    expect(value).toEqual({ status: 'error', reason: 'math_evaluator_environment_unavailable',
      method: 'official-comparator', official: true, comparison });
    expect(host.run).not.toHaveBeenCalled();
  });

  it('keeps a signal or an unstarted command from passing even when exitCode is zero', () => {
    expect(evaluatorExecutionFailure(commandResult({ exitCode: 0, signal: 'SIGTERM' })))
      .toBe('math_evaluator_environment_unavailable');
    expect(evaluatorExecutionFailure(commandResult({ exitCode: 0, started: false })))
      .toBe('math_evaluator_environment_unavailable');
  });
});
