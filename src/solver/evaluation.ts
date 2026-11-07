import { MATH_PROOF_ENVIRONMENT_ENV } from '../math/mathProofEnvironment';
import { runMathematicsSandboxedCommand, type MathematicsSandboxCommandResult } from '../math/verifier';
import { runPersistedLeanEvalOfficialGate } from '../math/leanEvalBootstrap';
import { checkSolverProof, type ProofCheck } from './modules/evidence';
import { git, type SolverProblem } from './problem';

/** Execution failures cannot decide whether a mathematical submission is correct. */
export function evaluatorExecutionFailure(result: Pick<MathematicsSandboxCommandResult,
  'started' | 'exitCode' | 'signal' | 'stderr' | 'timedOut' | 'aborted'>): string | undefined {
  if (result.timedOut) return 'math_evaluation_timeout';
  if (result.aborted || !result.started || result.signal || result.exitCode === null ||
      result.exitCode === 126 || result.exitCode === 127) return 'math_evaluator_environment_unavailable';
  if (result.exitCode === 0) return undefined;
  // These are diagnostics from the process launcher, runtime or Git, rather
  // than Lean's source diagnostics or the comparator's mathematical verdict.
  // Keep the signatures anchored and narrow: arbitrary stderr is not evidence
  // of an unavailable environment, and a normal rejection remains `failed`.
  if (/^libc\+\+abi: [^\n]*failed to create thread: Resource temporarily unavailable\s*$/mu.test(result.stderr) ||
      /^could not execute external process '(?:lean|lake|git|landrun|comparator)'\s*$/mu.test(result.stderr) ||
      /^fatal: unable to access '[^'\n]+': (?:Could not resolve host:|Failed to connect to |Network is unreachable)[^\n]*$/mu.test(result.stderr) ||
      /^(?:cp|mkdir|chmod|rm): [^\n]*: Read-only file system\s*$/mu.test(result.stderr))
    return 'math_evaluator_environment_unavailable';
  return undefined;
}

/** S3: final acceptance stays independent of replaceable research modules. */
export async function evaluateSolverProof(problem: SolverProblem, worktree: string, receipt: ProofCheck,
  env: NodeJS.ProcessEnv, signal: AbortSignal, options: { command?: string; timeoutMs: number }): Promise<Record<string, unknown>> {
  const deadline = Date.now() + options.timeoutMs;
  const controller = new AbortController();
  const expire = () => controller.abort(new Error('math_evaluation_timeout'));
  const evaluationSignal = AbortSignal.any([signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armTimer = () => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) expire();
    else if (Number.isFinite(remainingMs))
      timer = setTimeout(armTimer, Math.min(remainingMs, 2_147_483_647));
  };
  armTimer();
  const assertActive = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) expire();
    evaluationSignal.throwIfAborted();
  };
  try {
    assertActive();
    const currentHead = git(problem.workspace, ['rev-parse', 'HEAD']);
    if (![problem.baseCommit, receipt.commit].includes(currentHead) || git(problem.workspace, ['status', '--porcelain', '--untracked-files=no']))
      throw new Error('math_main_workspace_changed');
    git(problem.workspace, ['merge', '--ff-only', receipt.commit]);
    assertActive();
    const finalCheck = await checkSolverProof(problem, problem.workspace, env, evaluationSignal, undefined, options.timeoutMs);
    assertActive();
    if (!finalCheck.passed || finalCheck.commit !== receipt.commit || finalCheck.sourceDigest !== receipt.sourceDigest)
      throw new Error('math_integrated_proof_mismatch');
    if (options.command) {
      const result = await runMathematicsSandboxedCommand({ checkoutRoot: worktree, projectRelative: problem.projectRelative,
        command: '/bin/sh', args: ['-c', options.command], timeoutMs: options.timeoutMs, env, signal: evaluationSignal });
      assertActive();
      const reason = evaluatorExecutionFailure(result);
      return { status: reason ? 'error' : result.exitCode === 0 ? 'passed' : 'failed',
        ...(reason ? { reason } : {}), method: 'external-command', official: false, result };
    }
    if (problem.kind === 'lean-eval') {
      if (!problem.sourceRepository) throw new Error('math_official_source_missing');
      const { comparison } = await runPersistedLeanEvalOfficialGate({ activeProblemPath: problem.activeProblemPath,
        repositoryRoot: problem.sourceRepository, timeoutMs: options.timeoutMs,
        env: { ...env, [MATH_PROOF_ENVIRONMENT_ENV]: undefined }, signal: evaluationSignal });
      assertActive();
      const reason = evaluatorExecutionFailure({ ...comparison, started: comparison.status !== 'unavailable',
        stderr: comparison.stderrPreview ?? '' });
      return { status: reason || comparison.cleanupError ? 'error' :
        comparison.status === 'official_verified' ? 'passed' : comparison.status === 'failed' ? 'failed' : 'error',
        ...(reason ? { reason } : {}), method: 'official-comparator', official: true, comparison };
    }
    return { status: 'passed', method: 'host-lean-kernel-all-targets', official: false, verification: finalCheck };
  } catch (error) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) expire();
    if (controller.signal.aborted)
      return { status: 'error', reason: 'math_evaluation_timeout', timedOut: true };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
