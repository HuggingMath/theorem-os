#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFlags, required } from './arguments';
import { readNativeSkillJob, runtimeSkillArguments, nativeComparisonAccepted } from './nativeSkillComparison';
import { createCodexMathSession } from '../../src/runtime/codexSession';
import type { MathAgentSession } from '../../src/runtime/agentSession';
import type { ModelRequestGate } from '../../src/runtime/modelRequest';
import { assertMathAgentSkillsCurrent } from '../../src/runtime/agentSkills';
import { withMathRuntimeLease, writeMathJsonDurable, readMathText, mathDigest } from '../../src/math/mathRuntimeIo';
import { closeMathProcess } from '../../src/math/mathProcess';
import { git, committedSource, solverSourceConstraints } from '../../src/solver/problem';
import { prepareResearchSkill } from '../../src/solver/researchSkill';
import { writeWorkerProject } from '../../src/solver/workerProject';
import { buildCommonResearchGuide } from '../../src/solver/researchGuidance';
import { compileTaskContext, frozenSourceContext } from '../../src/solver/contextCompiler';
import { writeOwnedDeclarationIndex } from '../../src/solver/declarationIndex';
import { buildTokenBudget, beginRequestUsage, modelDispatchAllowed, type RequestUsageAccounting } from '../../src/solver/usageBudget';
import { checkSolverProof, type ProofCheck } from '../../src/solver/modules/evidence';
import { evaluateSolverProof } from '../../src/solver/evaluation';
import { DEFAULT_TACTIC_BATTERY_FAILURE_CACHE_ROOT } from '../../src/solver/tacticBatteryFailureCache';
import { stopProofWriter } from '../../src/solver/proofWriter';

/** One native task. The sibling executor runs the ordinary Skill solver after the same frozen preflight. */
export async function runNativeSkillBaseline(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, ['contract', 'contract-sha256', 'workspace', 'output']);
  const workspace = required(flags, 'workspace'), output = path.resolve(required(flags, 'output'));
  const contractFile = required(flags, 'contract'), contractDigest = required(flags, 'contract-sha256');
  const { job, prepared, problem, launchDigest, comparisonDigest } = readNativeSkillJob(contractFile, contractDigest, workspace, output);
  const invocationFile = `${output}.comparison.json`;
  if (fs.existsSync(output) || fs.existsSync(`${output}.runtime/state.json`) || fs.existsSync(invocationFile))
    throw new Error('native_comparison_attempt_already_started');
  const controller = new AbortController(), abort = () => controller.abort();
  process.on('SIGTERM', abort); process.on('SIGINT', abort);
  let exitCode: number | undefined, executionError: string | undefined;
  const startedAt = Date.now();
  const invocation = () => writeMathJsonDurable(invocationFile, { schema: 'theorem-os.native-skill-invocation.v1',
    arm: job.arm, contractDigest, launchDigest, comparisonDigest, startedAt, status: exitCode !== undefined ? 'finished' : executionError ? 'failed' : 'running',
    ...(exitCode !== undefined || executionError ? { finishedAt: Date.now() } : {}), exitCode, error: executionError,
    stateDigest: fs.existsSync(`${output}.runtime/state.json`) ? mathDigest(fs.readFileSync(`${output}.runtime/state.json`)) : null,
    resultDigest: fs.existsSync(output) ? mathDigest(fs.readFileSync(output)) : null });
  invocation();
  try {
    if (job.arm === 'runtime-skill') {
      // No replacement research loop: execute exactly the existing bundled Skill runtime.
      const child = spawn(process.execPath, runtimeSkillArguments(job), { cwd: job.root,
        env: { ...process.env, CODEX_HOME: job.harness.profile, DEEPSCIENTIST_MATH_ENV_FILE: job.environmentFile },
        detached: process.platform !== 'win32', stdio: 'inherit' });
      const stop = () => { void closeMathProcess(child); };
      controller.signal.addEventListener('abort', stop, { once: true });
      try { return exitCode = await new Promise<number>(resolve => {
        child.once('error', () => resolve(1)); child.once('close', code => resolve(code ?? 1));
      }); } finally { controller.signal.removeEventListener('abort', stop); }
    }
    const directory = `${output}.runtime`; fs.mkdirSync(directory, { mode: 0o700 });
    return exitCode = await withMathRuntimeLease({ lockPath: path.join(directory, 'run.lock'), flockExecutable: '/usr/bin/flock',
      signal: controller.signal }, async lease => {
      const worktree = path.join(directory, 'worktree');
      git(job.workspace, ['worktree', 'add', '--quiet', '--detach', worktree, job.initialCommit]);
      const project = path.join(worktree, problem.projectRelative);
      fs.mkdirSync(path.join(project, '.lake'), { recursive: true });
      writeWorkerProject(worktree, problem.projectRelative);
      writeMathJsonDurable(path.join(project, '.lake/source-constraints.json'), solverSourceConstraints(problem), 0o400);
      const skill = prepareResearchSkill(job.root, worktree, job.skill, problem);
      writeOwnedDeclarationIndex(problem, worktree);
      const guide = buildCommonResearchGuide(problem, { root: job.root, worktree,
        environment: prepared.environment, mathTools: prepared.mathTools, corpusFile: prepared.corpusFile,
        retrievalRoot: prepared.corpus?.projectSubdirectory ? worktree : project }, job.environmentDigest);
      const instructions = guide.instructions + '\nExecution and delivery protocol:\n' +
        'Execute this single native research task. Save source and RESEARCH.md, stop writing and return at a natural delivery point. ' +
        'The independent checker runs after this invocation; it does not send corrective turns or consume helper requests during this task.';
      const frozenContexts = Object.fromEntries(problem.ownedFiles.filter(file => file.endsWith('.lean')).map(file =>
        [file, frozenSourceContext(problem, file, committedSource(worktree, problem.baseCommit, path.posix.join(problem.projectRelative, file)))]));
      const context = compileTaskContext({ problem, instructions, taskText: readMathText(job.taskFile),
        frozenContexts, environmentDigest: job.environmentDigest });
      const record: { turns: number; usage?: Record<string, unknown>; requestUsageAccounting: RequestUsageAccounting;
        writerStopUnconfirmed?: { at: number; reason: string } } = {
        turns: 0, requestUsageAccounting: { startedRequests: 0, reportedRequests: 0, pendingRequests: 0, incomplete: false } };
      const runId = randomUUID();
      let session: MathAgentSession | undefined, threadId: string | undefined, turnId: string | undefined;
      let writerStopped = false, status = 'not-started', error: string | undefined;
      let check: ProofCheck | undefined, evaluation: Record<string, unknown> | undefined;
      const budget = () => buildTokenBudget(job.maxTotalTokens, [record], job.enforcement);
      const save = () => { lease.assertOwned(); writeMathJsonDurable(path.join(directory, 'state.json'), {
        schema: 'theorem-os.native-skill-state.v1', runId, contractDigest, threadId, turnId, status,
        writerStopped, ...record, tokenBudget: budget(), check, evaluation, error,
      }); };
      const emit = (event: string, details: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, at: Date.now(), runId, ...details }));
      const requestGate: ModelRequestGate = identity => {
        const current = budget();
        if (!modelDispatchAllowed(current)) return { allowed: false, reason: current.reason! };
        if (lease.signal.aborted) return { allowed: false, reason: 'math_model_request_stopped' };
        const settle = beginRequestUsage(record, { ...identity, requestId: identity?.requestId ?? randomUUID(), runId,
          sessionId: threadId });
        save();
        return { allowed: true, settle: receipt => { settle(receipt); save(); } };
      };
      save();
      try {
        session = await createCodexMathSession({ executable: job.harness.executable, profile: job.harness.profile,
          workspace: worktree, model: job.model, effort: job.effort, instructions, skills: [skill],
          hiddenRoots: [DEFAULT_TACTIC_BATTERY_FAILURE_CACHE_ROOT], proofProjectRoot: project,
          environment: { ...prepared.environment, DEEPSCIENTIST_MATH_WORKER_ID: 'solver',
            DEEPSCIENTIST_MATH_WORKER_WORKTREE: worktree }, signal: lease.signal, requestGate,
          onUsage: () => { /* Native totals are observational; only relay request receipts are charged. */ },
          onUsageIncomplete: () => { record.requestUsageAccounting.incomplete = true; save(); },
          onActivity: activity => emit('native_activity', activity),
        });
        threadId = session.threadId;
        if (session.usageSource !== 'upstream-requests') throw new Error('native_comparison_request_accounting_unavailable');
        save();
        emit('context_dispatched', { messageDigest: mathDigest(context.message), messageBytes: Buffer.byteLength(context.message),
          manifest: context.manifest });
        record.turns = 1; status = await session.run(context.message, randomUUID(), worktree, id => {
          turnId = id; status = 'running'; save(); emit('turn_started', { threadId, turnId });
        });
      } catch (cause) {
        status = 'failed'; error = cause instanceof Error && /^math_|^native_comparison_/u.test(cause.message)
          ? cause.message : 'native_comparison_execution_failed';
      } finally {
        if (session) {
          try {
            await stopProofWriter({ session, record, workerId: 'solver', close: () => session!.close(), save,
              deferred: reason => emit('writer_stop_unconfirmed', { reason }) });
            writerStopped = true;
          } catch { status = 'failed'; error ??= 'native_comparison_writer_stop_failed'; }
        }
        if (record.requestUsageAccounting.pendingRequests || !record.requestUsageAccounting.startedRequests)
          record.requestUsageAccounting.incomplete = true;
        save();
      }
      if (!writerStopped) { status = 'failed'; error ??= 'native_comparison_writer_stop_unconfirmed'; }
      else if (!lease.signal.aborted) {
        try {
          readNativeSkillJob(contractFile, contractDigest, workspace, output, 'report');
          assertMathAgentSkillsCurrent([skill]);
          emit('proof_check_started');
          check = await checkSolverProof(problem, worktree, prepared.environment, lease.signal, undefined, Infinity);
          emit('proof_checked', { commit: check.commit, passed: check.passed });
          if (check.passed) evaluation = await evaluateSolverProof(problem, check, prepared.environment,
            lease.signal, { timeoutMs: Infinity });
        } catch (cause) {
          error = cause instanceof Error && /^math_/u.test(cause.message) ? cause.message : 'native_comparison_verifier_unavailable';
        }
      }
      const accepted = writerStopped && nativeComparisonAccepted(problem, check, evaluation);
      const tokenBudget = budget();
      save();
      writeMathJsonDurable(output, { schema: 'theorem-os.native-skill-result.v1', arm: job.arm, runId, contractDigest,
        status: error ? 'runtime_error' : accepted ? 'evaluated_passed' : check?.passed === false ? 'incomplete' : status,
        executionStatus: status,
        accepted, writerStopped, threadId, turnId, ...record, tokenBudget,
        totalTokens: tokenBudget.usageComplete ? tokenBudget.reportedTotalTokens : null,
        check, evaluator: evaluation, error, wallMs: Date.now() - startedAt,
        baseline: 'native-app-server-single-task-with-shared-adapter-not-default-codex-exec' });
      return error ? 1 : accepted ? 0 : 4;
    });
  } catch (cause) {
    executionError = cause instanceof Error && /^(?:math_|native_comparison_)/u.test(cause.message)
      ? cause.message : 'native_comparison_execution_failed';
    throw cause;
  } finally {
    process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort); invocation();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNativeSkillBaseline(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof Error ? error.message : 'native_comparison_failed'); process.exitCode = 1;
  });
}
