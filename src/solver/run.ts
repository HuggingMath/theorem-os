import { readPantographBackend, PANTOGRAPH_DIGEST_ENV } from '../math/pantographSession';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { VerificationCheckpointError, withVerificationCheckpoints } from './verificationCheckpoint';
import { parseArgs } from 'node:util';
import { readMathBuildManifest } from '../math/mathBuildManifest';
import { canonicalMathJson, mathDigest, readMathJson, readMathText, withMathRuntimeLease, writeMathJsonDurable, type MathLease } from '../math/mathRuntimeIo';
import { projectMathematicsRuntimeEnvironment, resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { MATH_TOOLS_ROOT_ENV, MATH_TOOLS_SHA256_ENV, readMathTools } from '../math/mathTools';
import { checkResolvedLeanToolchainReadiness } from '../math/leanToolchainReadiness';
import { prepareMathProofEnvironment, MATH_PROOF_ENVIRONMENT_ENV } from '../math/mathProofEnvironment';
import { DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT } from '../math/mathProofEnvironmentCache';
import { resolveMathematicsLakePackagesCache } from '../math/verifier';
import { bindLeanPackages, prepareLeanDiagnosticOverrides, runLeanDiagnostics } from '../math/leanDiagnostics';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { git, readSolverProblem, assertSolverSources, solverSourceConstraints } from './problem';
import { solverSourceFeedback } from './feedback';
import { assertMathRetrievalCorpus, createMathRetrievalCorpus, type MathRetrievalCorpus } from '../math/mathRetrievalCorpus';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from './archive';
import { directSolverModules, configuredSolverModules, solverModuleConfiguration, solverMethodDigest, type SolverModules } from './modules';
import { configurableSolverModules } from './modules/custom';
import { researchModulePlanSchema, type ResearchModulePlan } from './modules/policy';
import { MAX_RESEARCH_WORKERS, researchWorkers } from './modules/organization';
import { runResearchWorkers, type WorkerAccess } from './research';
import { evaluateSolverProof } from './evaluation';
import { solverProofIsCurrent } from './modules/evidence';
import { checkCodexProviderConnectivity } from '../runtime/codexConnectivity';
import { buildTokenBudget } from './usageBudget';
import { selectedDeepSeekProfile } from '../runtime/deepseek';
import { selectedWestlakeProfile } from '../runtime/westlake';
import { selectedSub2apiProfile } from '../runtime/sub2api';
import { copyKnowledgeSnapshot } from './theoremKnowledgeStore';
import { readAuthorizedKnowledgeCatalog } from './theoremKnowledgeAuthorization';
import { copyContinuationSnapshot, freezeContinuationInput, readContinuationInput, readContinuationSnapshot,
  type ContinuationSnapshot } from './continuationInput';
import { seedSolverContinuation } from './continuationSeed';
import type { TaskProof } from './cooperativeProof';

const runSummary = (state: SolverRunState | undefined) => ({ turns: state?.turns, dispatchCounts: state?.dispatchCounts,
  usage: state?.usage, tokenBudget: state?.tokenBudget, workers: state?.workers?.map(worker => ({ id: worker.id, role: worker.role,
    turns: worker.turns, dispatchCounts: worker.dispatchCounts, usage: worker.usage, error: worker.error })) });

export async function runSolver(args: string[], root: string, customModules?: SolverModules): Promise<number> {
  const { values } = parseArgs({ args, options: {
    workspace: { type: 'string' }, 'receipt-file': { type: 'string' }, 'task-file': { type: 'string' },
    output: { type: 'string' }, 'build-manifest': { type: 'string' }, model: { type: 'string', default: 'deepseek-flash' },
    effort: { type: 'string', default: 'max' }, codex: { type: 'string' }, resume: { type: 'boolean' },
    'max-run-seconds': { type: 'string', default: '1800' }, 'max-turns': { type: 'string', default: '200' },
    'max-total-tokens': { type: 'string', default: '0' },
    'prepare-timeout-seconds': { type: 'string', default: '1800' }, 'max-turn-seconds': { type: 'string', default: '180' },
    'evaluator-command': { type: 'string' }, 'evaluator-timeout-seconds': { type: 'string', default: '1800' },
    'proof-timeout-seconds': { type: 'string', default: '1800' },
    'proof-environment-cache-dir': { type: 'string' }, 'startup-only': { type: 'boolean' }, 'check-statement': { type: 'boolean' },
    help: { type: 'boolean' },
    'knowledge-base': { type: 'string' }, 'continuation-manifest': { type: 'string' },
    'continuation-source-run': { type: 'string' },
    method: { type: 'string', default: 'direct' }, workers: { type: 'string', default: '4' },
    'module-plan': { type: 'string' },
    scheduler: { type: 'string', default: 'plan' }, coordination: { type: 'string', default: 'cooperative' },
    'plan-approval': { type: 'boolean' },
  } });
  if (values.help) {
    console.log(`Usage: theorem-os run --workspace DIR --task-file FILE --output FILE --build-manifest FILE [--receipt-file FILE] [--resume] [--method direct] [--scheduler plan|critical-path|continuation] [--module-plan FILE] [--coordination cooperative|independent] [--workers 1..${MAX_RESEARCH_WORKERS}] [--plan-approval] [--model MODEL --effort LEVEL] [--max-run-seconds N --max-turns N --max-turn-seconds N] [--max-total-tokens N] [--prepare-timeout-seconds N] [--proof-timeout-seconds N] [--evaluator-command CMD --evaluator-timeout-seconds N] [--proof-environment-cache-dir DIR] [--startup-only] [--check-statement]\n--module-plan loads the shared research-module plan JSON; use --scheduler plan.\nUse 0 for --prepare-timeout-seconds, --max-run-seconds, --max-turns, --max-turn-seconds, --proof-timeout-seconds or --evaluator-timeout-seconds to disable that limit. Proof checks default to 1800 seconds independently of the solving budget; an expired check saves a resumable checkpoint and the identical candidate gets more time on its next check.\n--max-total-tokens defaults to 0 (unlimited). A finite value stops new model turns after provider-reported consumption reaches it; in-flight turns finish and may exceed it. Resume retains cumulative usage and the saved allowance unless explicitly changed.`);
    console.log('--knowledge-base FILE attaches an immutable saved-theorem catalog. Resume requires the same catalog digest. Historical knowledge never grants proof acceptance.');
    console.log('--continuation-manifest FILE attaches explicit historical sources and notes without changing the verbatim task file. Resume retains the frozen attachment identity; historical material remains advisory.');
    console.log('--continuation-source-run OLD_RESULT_OR_STATE initializes a new cooperative run from the old run, freshly checks its saved helpers, and starts solving in the same process. Use --resume to retry an interrupted zero-turn initialization; combine with --startup-only to retain a prepared checkpoint.');
    console.log('--check-statement also elaborates the target files at startup (theorem bodies may still be sorry) and fails with math_statement_check_failed on a Lean error; statement-diagnostics.json keeps the messages.');
    console.log('--plan-approval holds every worker after the first accepted plan until a person approves that exact plan version (queuePlanApproval, the web workbench). The Lead takes a revision turn only for Lead guidance written while it waits. Waiting counts toward --max-run-seconds. Requires cooperative coordination and at least 2 workers; resume requires the same setting.');
    console.log('Lead planning and ordinary research first yield a resumable scheduling checkpoint after 120 seconds, with a reminder after 90 seconds. Lead planning keeps 120-second slices; ordinary research backs off to at most 960 seconds. Saved threads and drafts survive resume. Proof turns and total solving budgets are unchanged.');
    return 0;
  }
  const configured = configuredSolverModules(values.method!, values.scheduler!);
  if (customModules && values.scheduler !== 'plan') throw new Error('custom modules cannot combine with --scheduler');
  if (!['cooperative', 'independent'].includes(values.coordination!)) throw new Error('invalid --coordination');
  const coordination = values.coordination as 'cooperative' | 'independent';
  if (values['module-plan'] && (customModules || values.scheduler !== 'plan'))
    throw new Error('--module-plan requires --scheduler plan and no injected modules');
  const modules = values['module-plan']
    ? configurableSolverModules(researchModulePlanSchema.parse(readMathJson(values['module-plan'])) as ResearchModulePlan, coordination, Number(values.workers))
    : customModules ?? configured;
  const required = (key: string): string => {
    const value = values[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--${key} is required`);
    return value;
  };
  const limit = (key: string, unlimited = false): number => {
    const value = Number(required(key));
    if (!Number.isSafeInteger(value) || value < (unlimited ? 0 : 1)) throw new Error(`invalid --${key}`);
    return unlimited && value === 0 ? Infinity : value;
  };
  const maxRunMs = limit('max-run-seconds', true) * 1000;
  const proofTimeoutMs = limit('proof-timeout-seconds', true) * 1000;
  const preparationMs = limit('prepare-timeout-seconds', true) * 1000;
  const maxTurnMs = limit('max-turn-seconds', true) * 1000;
  const maxTurns = limit('max-turns', true);
  let maxTotalTokens = Number(values['max-total-tokens']);
  if (!Number.isSafeInteger(maxTotalTokens) || maxTotalTokens < 0) throw new Error('invalid --max-total-tokens');
  const tokenLimitSpecified = args.some(arg => arg === '--max-total-tokens' || arg.startsWith('--max-total-tokens='));
  const evaluatorMs = limit('evaluator-timeout-seconds', true) * 1000;
  const workerCount = limit('workers');
  if (workerCount > MAX_RESEARCH_WORKERS) throw new Error('invalid --workers');
  if (values['continuation-source-run'] && (coordination !== 'cooperative' || workerCount < 2))
    throw new Error('--continuation-source-run requires cooperative coordination and at least 2 workers');
  const planApproval = values['plan-approval'] === true;
  if (planApproval && (coordination !== 'cooperative' || workerCount < 2))
    throw new Error('--plan-approval requires cooperative coordination and at least 2 workers');
  if (values['continuation-source-run'] && values['continuation-manifest'])
    throw new Error('--continuation-source-run cannot combine with --continuation-manifest');
  const workspace = fs.realpathSync(required('workspace'));
  const output = path.resolve(required('output'));
  assertMathCanonicalPath(output);
  if (isMathPathWithin(workspace, output)) throw new Error('math_output_must_be_outside_solver_workspace');
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const directory = `${output}.runtime`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertMathCanonicalPath(directory);
  const stat = fs.statSync(directory);
  if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('math_state_directory_not_private');
  const stateFile = path.join(directory, 'state.json');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const preparationStarted = Date.now();
  let preparing = true;
  let deadline = Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined = Number.isFinite(preparationMs) ? setTimeout(abort, preparationMs) : undefined;
  let ownedState: SolverRunState | undefined;
  let proofEnvironment: Awaited<ReturnType<typeof prepareMathProofEnvironment>> | undefined;
  let continuationSeeding = false;
  let ownsRun = false;
  let publishedExit: number | undefined;
  const emit = (event: string, details = {}) => console.log(JSON.stringify({ event, at: Date.now(), ...details,
    ...(ownedState ? { runId: ownedState.runId, problemReceiptDigest: ownedState.problem.receiptDigest,
      environmentDigest: ownedState.environmentDigest } : {}) }));
  const disposeProofEnvironment = async () => {
    const environment = proofEnvironment;
    proofEnvironment = undefined;
    await environment?.dispose();
  };
  const runWithLease = async (lease: MathLease): Promise<number> => {
    const execute = async (): Promise<number> => {
      const signal = lease.signal;
      const buildFile = fs.realpathSync(required('build-manifest'));
      const bundleRoot = path.join(root, 'out', 'main');
      readMathBuildManifest(buildFile, root, bundleRoot);
      const task = fs.readFileSync(required('task-file'), 'utf8');
      const problem = readSolverProblem(workspace, values['receipt-file'] || path.join(workspace, 'active-problem.json'));
      if (problem.libraryBinding?.hostConfiguration && (values['continuation-manifest'] || values['continuation-source-run']))
        throw new Error('library_knowledge_history_unauthorized');
      const continuationIdentity = { taskDigest: mathDigest(task), problemReceiptDigest: problem.receiptDigest };
      const continuationInput = values['continuation-manifest']
        ? readContinuationInput(values['continuation-manifest'], continuationIdentity) : undefined;
      let continuation: ContinuationSnapshot | undefined;
      const slots = researchWorkers(path.join(directory, 'worktree'), problem.ownedFiles, workerCount);
      const workers = modules.M5.workers(slots[0].worktree, [...problem.ownedFiles], workerCount);
      if (workers.length !== workerCount || new Set(workers.map(worker => worker.id)).size !== workerCount ||
          workers.some((worker, index) => !/^[a-zA-Z0-9_-]{1,64}$/u.test(worker.id) ||
            worker.worktree !== slots[index].worktree || canonicalMathJson(worker.ownedFiles) !== canonicalMathJson(problem.ownedFiles) ||
            (index === 0 ? worker.id !== 'solver' || worker.role !== 'lead' : !['researcher', 'prover', 'engineer', 'reviewer'].includes(worker.role))))
        throw new Error('math_solver_worker_outside_ownership');
      let env = resolveMathematicsRuntimeEnvironment();
      let corpusFile = env.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS;
      let corpusBytes = corpusFile ? Buffer.from(readMathText(corpusFile), 'utf8') : undefined;
      let corpus = corpusBytes ? JSON.parse(corpusBytes.toString('utf8')) as MathRetrievalCorpus : undefined;
      if (corpusFile) {
        const digest = mathDigest(corpusBytes!);
        if (env.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256 && env.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256 !== digest)
          throw new Error('math_corpus_identity_changed');
        env = { ...env, DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256: digest };
      }
      // The manifest digest joins the environment identity, so resume rejects a changed tool set.
      const mathTools = env[MATH_TOOLS_ROOT_ENV] ? readMathTools(env[MATH_TOOLS_ROOT_ENV]) : undefined;
      if (mathTools) {
        if (env[MATH_TOOLS_SHA256_ENV] && env[MATH_TOOLS_SHA256_ENV] !== mathTools.digest) throw new Error('math_tools_identity_changed');
        env = { ...env, [MATH_TOOLS_SHA256_ENV]: mathTools.digest };
      }
      const proofSearchBackend = readPantographBackend(env);
      if (proofSearchBackend) env = { ...env, [PANTOGRAPH_DIGEST_ENV]: proofSearchBackend.digest };
      const profile = process.env.CODEX_HOME || path.join(os.homedir(), '.config/deepscientist/math-sol-codex');
      const sub2apiProfile = modules.M1.open === directSolverModules.M1.open ? selectedSub2apiProfile(profile) : undefined;
      const westlakeProfile = modules.M1.open === directSolverModules.M1.open && !sub2apiProfile ? selectedWestlakeProfile(profile) : undefined;
      const providerProfile = modules.M1.open === directSolverModules.M1.open
        ? selectedDeepSeekProfile(profile) ?? sub2apiProfile ?? westlakeProfile : undefined;
      const knowledge = values['knowledge-base'] ? readAuthorizedKnowledgeCatalog(values['knowledge-base'], workspace,
        values['receipt-file'] || path.join(workspace, 'active-problem.json')) : undefined;
      const identity = { taskDigest: mathDigest(task), buildDigest: mathDigest(fs.readFileSync(buildFile)),
        providerProfile: providerProfile?.profile, providerProfileDigest: providerProfile?.digest,
        environmentDigest: mathDigest(canonicalMathJson(projectMathematicsRuntimeEnvironment(env))),
        evaluatorDigest: mathDigest(values['evaluator-command'] || 'host-default'), model: values.model!, effort: values.effort!,
        methodDigest: solverMethodDigest(modules, coordination), knowledgeDigest: knowledge?.digest };
      const moduleConfiguration = solverModuleConfiguration(modules);
      let state: SolverRunState;
      let sourceFeedback: string | undefined;
      if (values.resume) {
        state = readSolverRunState(stateFile);
        if (problem.libraryBinding?.hostConfiguration && state.continuationDigest)
          throw new Error('library_knowledge_history_unauthorized');
        if ([state, ...(state.workers ?? [])].some(record => record.writerStopUnconfirmed))
          throw new Error('math_writer_stop_unconfirmed: recover into a new isolated workspace before resuming.');
        if (!tokenLimitSpecified) maxTotalTokens = state.tokenBudget?.maxTotalTokens ?? 0;
        if (!state.methodDigest && modules === directSolverModules && coordination === 'cooperative') state.methodDigest = identity.methodDigest;
        if ((state.coordination ?? 'cooperative') !== coordination) throw new Error('math_resume_coordination_changed');
        if ((state.workerCount ?? 1) !== workerCount) throw new Error('math_resume_worker_count_changed');
        if (Boolean(state.planApproval) !== planApproval) throw new Error('math_resume_plan_approval_changed');
        if (workerCount > 1 && (!state.workers || state.workers.length !== workerCount ||
            state.workers.some((worker, index) => worker.id !== workers[index].id ||
              worker.role !== workers[index].role || worker.worktree !== workers[index].worktree)))
          throw new Error('math_resume_worker_identity_changed');
        if (state.schema !== 'deepscientist.math.solver.v1' || state.problem.workspace !== workspace ||
          state.problem.receiptDigest !== problem.receiptDigest ||
          Object.entries(identity).some(([key, value]) => state[key] !== value) ||
          state.worktree !== path.join(directory, 'worktree')) throw new Error('math_resume_identity_changed');
        if (state.continuationDigest) {
          continuation = readContinuationSnapshot(path.join(directory, 'continuation.json'), state.continuationDigest, continuationIdentity);
          if (continuationInput && continuationInput.digest !== state.continuationDigest)
            throw new Error('math_resume_continuation_changed');
        } else if (continuationInput) throw new Error('math_resume_continuation_changed');
        // Use the current authoritative receipt instead of trusting nested archived source policy.
        state.problem = problem;
        sourceFeedback = solverSourceFeedback(state.problem, state.worktree);
        assertSolverSources(state.problem, workspace);
        if (state.phase === 'finished' && fs.existsSync(output)) {
          const result = readMathJson(output) as { status: string; runId: string; solution_commit: string };
          if (result.status === 'evaluated_passed' || result.status === 'evaluated_failed') {
            const winningWorktree = state.workers?.find(worker => worker.id === state.winningWorker)?.worktree ?? state.worktree;
            assertSolverSources(state.problem, winningWorktree);
            if (!state.check?.passed || result.runId !== state.runId || result.solution_commit !== state.check.commit ||
                !solverProofIsCurrent(state.problem, winningWorktree, state.check) ||
                !solverProofIsCurrent(state.problem, workspace, state.check)) throw new Error('math_resume_completed_proof_changed');
            return result.status === 'evaluated_passed' ? 0 : 2;
          }
        }
      } else {
        if (fs.existsSync(stateFile) || fs.existsSync(output)) throw new Error('math_run_exists_use_resume');
        if (git(workspace, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('math_workspace_has_uncommitted_sources');
        if (continuationInput) continuation = freezeContinuationInput(continuationInput, directory);
        ownsRun = true;
        state = { schema: 'deepscientist.math.solver.v1', runId: crypto.randomUUID(), problem, ...identity,
          ...(continuation ? { continuationDigest: continuation.digest } : {}),
          worktree: path.join(directory, 'worktree'), phase: 'prepared', turns: 0, dispatchCounts: {}, workerCount,
          coordination, ...(planApproval ? { planApproval } : {}), moduleConfiguration, tokenBudget: buildTokenBudget(maxTotalTokens, [],
            westlakeProfile ? 'provider-observed-upstream-request-limit' : undefined) };
        if (workerCount > 1) state.workers = workers
          .map(worker => ({ id: worker.id, role: worker.role, worktree: worker.worktree, phase: 'prepared', turns: 0, dispatchCounts: {} }));
        git(workspace, ['worktree', 'add', '--detach', state.worktree, problem.baseCommit]);
        writeSolverRunState(stateFile, state);
      }
      ownsRun = true;
      ownedState = state;
      state.tokenBudget = buildTokenBudget(maxTotalTokens, state.workers ?? [state], state.tokenBudget?.enforcement);
      const save = () => { lease.assertOwned(); writeSolverRunState(stateFile, state); };
      for (const worker of workers.slice(1)) {
        signal.throwIfAborted();
        if (!fs.existsSync(worker.worktree)) git(workspace, ['worktree', 'add', '--detach', worker.worktree, problem.baseCommit]);
      }
      const prepareProject = (worktree: string) => {
        const project = path.join(worktree, state.problem.projectRelative);
        fs.mkdirSync(path.join(project, '.lake'), { recursive: true });
        writeMathJsonDurable(path.join(project, '.lake/source-constraints.json'), solverSourceConstraints(state.problem), 0o400);
        if (sourcePackages) bindLeanPackages(project, sourcePackages);
        return project;
      };
      const sourceProject = path.join(workspace, problem.projectRelative);
      const sourcePackages = resolveMathematicsLakePackagesCache(sourceProject, env);
      if (!sourcePackages) {
        const manifestFile = path.join(sourceProject, 'lake-manifest.json');
        const manifest = fs.existsSync(manifestFile) ? readMathJson(manifestFile) as { packages?: unknown } : undefined;
        if (Array.isArray(manifest?.packages) && manifest.packages.length) {
          emit('preparation_failed', { workerId: 'solver', diagnostics:
            'No manifest-compatible Lake package cache is configured. Supply a trusted cache with the pinned Git revisions; sandboxed verification never downloads dependencies.' });
          throw new Error('math_lake_packages_unavailable');
        }
      }
      const project = prepareProject(state.worktree);
      if (!values.resume) sourceFeedback = solverSourceFeedback(state.problem, state.worktree);
      if (sourceFeedback) { state.check = undefined; save(); }
      const connectivity = modules.M1.open === directSolverModules.M1.open
        ? await checkCodexProviderConnectivity({ env, signal, profile })
        : { status: 'not-required', diagnostics: 'The custom execution component does not use the built-in Codex provider.' };
      writeMathJsonDurable(path.join(directory, 'provider-connectivity.json'), connectivity);
      if (connectivity.status !== 'reachable' && connectivity.status !== 'not-required') {
        emit('preparation_failed', { workerId: 'solver', diagnostics: connectivity.diagnostics });
        throw new Error('math_codex_provider_unreachable');
      }
      const readiness = checkResolvedLeanToolchainReadiness({ projectRoot: project, env, timeoutMs: 180_000 });
      writeMathJsonDurable(path.join(directory, 'toolchain-readiness.json'), readiness);
      if (readiness.status !== 'ready') {
        emit('preparation_failed', { workerId: 'solver', diagnostics: readiness.diagnostics });
        throw new Error('math_lean_toolchain_unavailable');
      }
      if (sourcePackages) {
        // Model-side path overrides are regenerated after binding the frozen packages.
        // Their worktree-specific paths must not invalidate the preparation cache on resume.
        const overrides = path.join(project, '.lake', 'package-overrides.json');
        assertMathCanonicalPath(overrides);
        fs.rmSync(overrides, { force: true });
        proofEnvironment = await prepareMathProofEnvironment(project, sourcePackages, { env, signal,
          deadlineAt: preparationStarted + preparationMs,
          cacheRoot: values['proof-environment-cache-dir'] || DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT,
          onProgress: phase => emit('proof_environment', { phase }) });
        env = { ...env, [MATH_PROOF_ENVIRONMENT_ENV]: proofEnvironment.environmentValue };
      }
      const checkDependencies = async (workerId: string, projectRoot: string) => {
        if (sourcePackages) prepareLeanDiagnosticOverrides(projectRoot);
        const diagnostics = await runLeanDiagnostics({ projectRoot, files: [...new Set(problem.targets.map(target => target.proofPath))],
          dependenciesOnly: true, excludedFiles: problem.ownedFiles, env, signal,
          timeoutMs: preparationMs - (Date.now() - preparationStarted),
          onProgress: file => emit('dependency_check', { workerId, file }) });
        writeMathJsonDurable(path.join(directory, workerId === 'solver' ? 'preparation-diagnostics.json' : `preparation-${workerId}.json`), diagnostics);
        if (diagnostics.exitCode !== 0 || diagnostics.timedOut) {
          emit('preparation_failed', { workerId, timedOut: diagnostics.timedOut,
            diagnostics: (diagnostics.stderr || diagnostics.stdout || 'Lean dependency check did not finish.').slice(0, 2000) });
          throw new Error('math_lean_dependencies_failed');
        }
        return diagnostics;
      };
      const diagnostics = await checkDependencies('solver', project);
      // Library-pack modules are only advisory until Lean accepts them in this environment, without sorry.
      if (problem.frozenFiles && Object.keys(problem.frozenFiles).length) {
        emit('library_pack_check', { files: Object.keys(problem.frozenFiles).length });
        const library = await runLeanDiagnostics({ projectRoot: project, files: Object.keys(problem.frozenFiles), env, signal,
          timeoutMs: preparationMs - (Date.now() - preparationStarted), onProgress: file => emit('library_pack_check', { file }) });
        writeMathJsonDurable(path.join(directory, 'library-pack-diagnostics.json'), library);
        const sorry = 'messages' in library && library.messages?.find(message => /declaration uses '?sorry'?/u.test(message.message));
        if (library.exitCode !== 0 || library.timedOut || sorry) {
          emit('preparation_failed', { workerId: 'solver', timedOut: library.timedOut, diagnostics: (sorry ? `${sorry.file ?? ''} ${sorry.message}`
            : library.stderr || library.stdout || 'Library-pack check did not finish.').slice(0, 2000) });
          throw new Error('math_library_pack_failed');
        }
      }
      // A generated statement (auto-library spec) must elaborate before any model turn tries to prove it.
      if (values['check-statement']) {
        const statement = await runLeanDiagnostics({ projectRoot: project, files: [...new Set(problem.targets.map(target => target.proofPath))],
          env, signal, timeoutMs: preparationMs - (Date.now() - preparationStarted), onProgress: file => emit('statement_check', { file }) });
        writeMathJsonDurable(path.join(directory, 'statement-diagnostics.json'), statement);
        if (statement.exitCode !== 0 || statement.timedOut) {
          emit('preparation_failed', { workerId: 'solver', timedOut: statement.timedOut,
            diagnostics: (statement.stderr || statement.stdout || 'Statement check did not finish.').slice(0, 2000) });
          throw new Error('math_statement_check_failed');
        }
      }
      let corpusCreated = false;
      if (!corpusFile && sourcePackages && fs.existsSync(path.join(sourcePackages, 'mathlib', 'Mathlib'))) {
        corpusFile = path.join(project, '.lake', 'retrieval-corpus.json');
        if (!fs.existsSync(corpusFile)) {
          if (state.retrievalDigest) throw new Error('math_corpus_identity_changed');
          emit('library_index', { phase: 'creating', package: 'mathlib' });
          corpus = await createMathRetrievalCorpus(project, ['mathlib']);
          corpusCreated = true;
          signal.throwIfAborted();
          writeMathJsonDurable(corpusFile, corpus);
        }
        corpusBytes = Buffer.from(readMathText(corpusFile), 'utf8');
        corpus ??= JSON.parse(corpusBytes.toString('utf8')) as MathRetrievalCorpus;
        const digest = mathDigest(corpusBytes);
        if (state.retrievalDigest && state.retrievalDigest !== digest) throw new Error('math_corpus_identity_changed');
        state.retrievalDigest = digest; save();
        env = { ...env, DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS: corpusFile, DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256: digest };
      }
      const retrievalRoot = corpus?.projectSubdirectory ? state.worktree : project;
      if (corpusFile) {
        if (corpus?.projectSubdirectory && corpus.projectSubdirectory !== state.problem.projectRelative.replaceAll(path.sep, '/'))
          throw new Error('math_corpus_project_mismatch');
        // Creation already verifies every frozen source; persisted inputs need a fresh check.
        if (!corpusCreated) assertMathRetrievalCorpus(retrievalRoot, corpus);
        emit('library_index', { phase: 'ready', sourceFiles: corpus!.sources.length });
      }
      const workerAccess = new Map<string, WorkerAccess>();
      const prepareAccess = (workerId: string, workerRoot: string, workerProject: string, workerCorpus?: string) => {
        const workerContinuation = continuation && copyContinuationSnapshot(continuation, workerProject);
        let knowledgeFile: string | undefined;
        if (knowledge) {
          if (knowledge.base.libraryAuthorization) readAuthorizedKnowledgeCatalog(values['knowledge-base']!, workspace,
            values['receipt-file'] || path.join(workspace, 'active-problem.json'), knowledge.digest);
          knowledgeFile = path.join(workerProject, '.lake', 'theorem-knowledge.json');
          copyKnowledgeSnapshot(knowledge, values['knowledge-base']!, knowledgeFile);
        }
        const environmentFile = path.join(directory, `environment-${workerId}.json`);
        const environment = { ...env, DEEPSCIENTIST_MATH_ENV_FILE: environmentFile,
          DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS: workerCorpus };
        writeMathJsonDurable(environmentFile, projectMathematicsRuntimeEnvironment(environment), 0o400);
        workerAccess.set(workerId, { environment: resolveMathematicsRuntimeEnvironment(environment), corpusFile: workerCorpus,
          retrievalRoot: corpus?.projectSubdirectory ? workerRoot : workerProject,
          ...(mathTools ? { mathTools } : {}),
          ...(workerContinuation ? { continuation: workerContinuation } : {}),
          ...(knowledge ? { knowledgeFile, knowledgeDigest: knowledge.digest,
            ...(knowledge.base.libraryAuthorization ? { assertKnowledgeCurrent: () => {
              readAuthorizedKnowledgeCatalog(knowledgeFile!, workspace,
                values['receipt-file'] || path.join(workspace, 'active-problem.json'), knowledge.digest);
            } } : {}),
            knowledgeSnapshot: { digest: knowledge.digest, base: { entries: knowledge.base.entries, evidence: knowledge.base.evidence,
              contexts: knowledge.base.contexts, routeFindings: knowledge.base.routeFindings } } } : {}) });
      };
      prepareAccess('solver', state.worktree, project, corpusFile);
      const peerPreparation = await Promise.allSettled(workers.slice(1).map(async worker => {
        signal.throwIfAborted();
        const workerProject = prepareProject(worker.worktree);
        const lake = path.join(workerProject, '.lake');
        await checkDependencies(worker.id, workerProject);
        let workerCorpusFile: string | undefined;
        if (corpusFile) {
          workerCorpusFile = path.join(lake, 'retrieval-corpus.json');
          assertMathCanonicalPath(workerCorpusFile);
          if (fs.existsSync(workerCorpusFile)) {
            if (mathDigest(readMathText(workerCorpusFile)) !== env.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256)
              throw new Error('math_corpus_identity_changed');
          } else fs.writeFileSync(workerCorpusFile, corpusBytes!, { mode: 0o400, flag: 'wx' });
        }
        prepareAccess(worker.id, worker.worktree, workerProject, workerCorpusFile);
      }));
      const failedPreparation = peerPreparation.find(result => result.status === 'rejected');
      if (failedPreparation?.status === 'rejected') throw failedPreparation.reason;
      let freshContinuationChecks: readonly TaskProof[] | undefined;
      if (values['continuation-source-run']) {
        save(); continuationSeeding = true;
        await seedSolverContinuation({ sourceRun: values['continuation-source-run'], run: stateFile, root, buildManifest: buildFile,
          signal, lease, preparedEnvironment: env, timeoutMs: maxRunMs === Infinity ? Infinity : Math.max(1, preparationMs - (Date.now() - preparationStarted)),
          onProgress: emit, onSeeded: (seeded, checks) => { state = ownedState = seeded; freshContinuationChecks = checks; } });
        continuationSeeding = false;
        continuation = readContinuationSnapshot(path.join(directory, 'continuation.json'), state.continuationDigest, continuationIdentity);
        for (const worker of workers) {
          const access = workerAccess.get(worker.id)!;
          prepareAccess(worker.id, worker.worktree, path.join(worker.worktree, state.problem.projectRelative), access.corpusFile);
        }
      }
      emit('ready', { runId: state.runId, worktree: state.worktree, workers });
      emit('preparation_finished', { durationMs: Date.now() - preparationStarted, dependencies: diagnostics.phases });
      if (values['startup-only']) {
        writeMathJsonDurable(output, { schema: 'deepscientist.math.run.v2', runId: state.runId,
          problemId: state.problem.contract.problemId, status: 'prepared', startup_only: true,
          evaluator: { status: 'skipped' }, stateFile });
        return 0;
      }
      signal.throwIfAborted();
      clearTimeout(timer);
      preparing = false;
      state.solveStartedAt = Date.now();
      state.solveFinishedAt = undefined;
      deadline = state.solveStartedAt + maxRunMs;
      timer = Number.isFinite(maxRunMs) ? setTimeout(abort, maxRunMs) : undefined;
      emit('solve_started', { budgetMs: maxRunMs, maxTurnMs });
      const winner = await withVerificationCheckpoints({ environmentDigest: state.environmentDigest,
        problemReceiptDigest: state.problem.receiptDigest, checkpoints: state.verificationCheckpoints ??= [], save, emit },
        () => runResearchWorkers({ state, workers, access: workerAccess, modules, root, buildFile, taskText: task,
        executable: values.codex || process.env.DEEPSCIENTIST_MATH_CODEX_EXECUTABLE || 'codex',
        profile,
        signal, deadline, maxTurns, maxTurnMs, maxTotalTokens, proofTimeoutMs,
        freshContinuationChecks, save, emit }));
      clearTimeout(timer);
      timer = undefined;
      state.solveFinishedAt = Date.now();
      let evaluation: Record<string, unknown> = { status: 'skipped', reason: 'proof_incomplete' };
      if (winner?.check.passed) {
        state.phase = 'evaluating'; save();
        readMathBuildManifest(buildFile, root, bundleRoot);
        const evaluationStarted = Date.now();
        emit('evaluation_started', { workerId: state.winningWorker ?? 'solver' });
        evaluation = await evaluateSolverProof(state.problem, winner.worktree, winner.check, env, signal,
          { command: values['evaluator-command'], timeoutMs: evaluatorMs });
        emit('evaluation_finished', { status: evaluation.status, durationMs: Date.now() - evaluationStarted });
      }
      state.phase = 'finished'; save();
      const status = signal.aborted ? 'limit_reached' : evaluation.status === 'passed' ? 'evaluated_passed' : evaluation.status === 'failed' ? 'evaluated_failed' : evaluation.status === 'error' ? 'runtime_error' : state.tokenBudget?.reason ? 'limit_reached' : 'incomplete';
      const result = { schema: 'deepscientist.math.run.v2', runId: state.runId, problemId: state.problem.contract.problemId,
        status, run_outcome: status, solution_commit: state.check?.passed ? state.check.commit : null,
        solver_ready_receipt_valid: state.check?.passed === true, completion_signal_valid: evaluation.status === 'passed',
        evaluator: evaluation, ...runSummary(state),
        ...(status === 'runtime_error' && typeof evaluation.reason === 'string' ? { reason: evaluation.reason } : {}),
        ...(status === 'limit_reached' && state.tokenBudget?.reason ? { reason: state.tokenBudget.reason } : {}),
        solveWallMs: state.solveFinishedAt - state.solveStartedAt, stateFile, winningWorker: state.winningWorker };
      writeMathJsonDurable(output, result);
      emit('finished', { status, output });
      return status === 'evaluated_passed' ? 0 : status === 'evaluated_failed' ? 2 : status === 'runtime_error' ? 1 : 4;
    };
    try {
      const code = await execute();
      await disposeProofEnvironment();
      publishedExit = code;
      return code;
    } catch (error) {
      // Cleanup remains under the run lock; preserve the execution error if cleanup also fails.
      try { await disposeProofEnvironment(); } catch { /* The original failure controls the checkpoint. */ }
      if (!ownsRun) { emit('rejected', { reason: error instanceof Error ? error.message : 'math_runtime_error' }); return 1; }
      lease.assertOwned();
      const checkpoint = error instanceof VerificationCheckpointError;
      const status = controller.signal.aborted || checkpoint ? 'limit_reached' : 'runtime_error';
      // Initialization owns durable progress before its final in-memory handoff.
      if (continuationSeeding) ownedState = readSolverRunState(stateFile);
      if (ownedState) {
        // A zero-turn continuation can retry any preparation step, including
        // snapshot distribution and startup-only output after the seed handoff.
        if (!(preparing && values['continuation-source-run'] && ownedState.phase === 'prepared'))
          ownedState.phase = 'finished';
        if (ownedState.solveStartedAt && !ownedState.solveFinishedAt) ownedState.solveFinishedAt = Date.now();
        ownedState.error = controller.signal.aborted || checkpoint ? undefined : error instanceof Error ? error.message : 'math_runtime_error';
        writeSolverRunState(stateFile, ownedState);
      }
      writeMathJsonDurable(output, { schema: 'deepscientist.math.run.v2', status, run_outcome: status,
        reason: controller.signal.aborted ? preparing ? 'math_preparation_stopped' : 'math_run_stopped' : error instanceof Error ? error.message : 'math_runtime_error',
        runId: ownedState?.runId, problemId: ownedState?.problem.contract.problemId, ...runSummary(ownedState),
        evaluator: { status: 'skipped' }, stateFile });
      publishedExit = controller.signal.aborted || checkpoint ? 4 : 1;
      emit('finished', { status, output });
      return publishedExit;
    }
  };
  try {
    return await withMathRuntimeLease({ lockPath: path.join(directory, 'run.lock'), flockExecutable: '/usr/bin/flock', signal: controller.signal }, runWithLease);
  } catch (error) {
    // The lease has ended. A cancelled operation can already have published its final checkpoint.
    if (publishedExit !== undefined) return publishedExit;
    emit('rejected', { reason: error instanceof Error ? error.message : 'math_runtime_error' });
    return controller.signal.aborted ? 4 : 1;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

