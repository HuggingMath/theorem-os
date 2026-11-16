import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { VerificationCheckpointError, withVerificationCheckpoints } from './verificationCheckpoint';
import { parseArgs } from 'node:util';
import { readMathBuildManifest } from '../math/mathBuildManifest';
import { MathGitError } from '../math/mathGit';
import { canonicalMathJson, mathDigest, readMathJson, readMathText, withMathRuntimeLease, writeMathJsonDurable, type MathLease } from '../math/mathRuntimeIo';
import { projectMathematicsRuntimeEnvironment, resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { checkResolvedLeanToolchainReadiness } from '../math/leanToolchainReadiness';
import { prepareMathProofEnvironment, MATH_PROOF_ENVIRONMENT_ENV } from '../math/mathProofEnvironment';
import { DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT } from '../math/mathProofEnvironmentCache';
import { DEFAULT_LEAN_LIBRARY_CACHE_ROOT } from '../math/leanCompilationCache';
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
import { validateNativeDelegation } from '../runtime/nativeDelegation';
import { evaluateSolverProof } from './evaluation';
import { solverProofIsCurrent } from './modules/evidence';
import { checkCodexProviderConnectivity } from '../runtime/codexConnectivity';
import { buildTokenBudget } from './usageBudget';
import { selectedDeepSeekProfile } from '../runtime/deepseek';
import { selectedWestlakeProfile } from '../runtime/westlake';
import { selectedSub2apiProfile } from '../runtime/sub2api';
import { copyKnowledgeSnapshot } from './theoremKnowledgeStore';
import { readAuthorizedKnowledgeCatalog } from './theoremKnowledgeAuthorization';
import { ExecutionDeadline } from '../runtime/executionDeadline';
import { readInstalledLibrarySnapshot } from './installedLibraryContext';
import { indexKnowledgeContextSnapshot } from './knowledgeContext';
import { assertLibraryCatalogAccess, LibraryInstallationRequested } from './libraryAccess';
import { readLibraryCatalog } from './libraryCatalog';
import { readLeanTaskReceipt } from '../math/leanTask';
import { copyContinuationSnapshot, freezeContinuationInput, readContinuationInput, readContinuationSnapshot,
  type ContinuationSnapshot } from './continuationInput';
import { seedSolverContinuation, seedSingleSolverContinuation } from './continuationSeed';
import type { TaskProof } from './cooperativeProof';
import { verifierFailureDiagnostic } from './verifierFailure';
import { generateSolverExplanations, type SolverExplanations } from './automaticExplanations';
import { readMathAgentSkill } from '../runtime/agentSkills';
import { prepareResearchSkill, researchSkillIdentity } from './researchSkill';
import { prepareSolverRuntimeEnvironment } from './environment';
import { assertResearchHarnessCurrent, bindResearchHarness, researchHarness, researchHarnessEnvironment } from '../runtime/researchHarness';
import { readCliConfiguration } from '../runtime/cliConfiguration';
import { planMathAgentSession } from '../runtime/agentSessionPlan';
import { SingleSolverProofHandoff } from './singleSolverProofHandoff';
import { assertAgentTeamProcessesStopped } from './agentTeam';

const runSummary = (state: SolverRunState | undefined) => {
  const workers = state?.workers ?? (state?.agentTeam ? [
    { ...state, id: 'lead', role: 'lead', turns: state.usageAccounting?.startedTurns ?? 0 }, ...state.agentTeam.workers,
  ] : undefined);
  return { turns: state?.turns, dispatchCounts: state?.dispatchCounts,
    ...(state?.verifierFailure ? { verifierFailure: state.verifierFailure } : {}),
    usage: state?.teamUsage ?? state?.usage, tokenBudget: state?.tokenBudget,
    workers: workers?.map(worker => ({ id: worker.id, role: worker.role, turns: worker.turns,
      dispatchCounts: worker.dispatchCounts, usage: worker.usage, error: worker.error })) };
};

export async function runSolver(args: string[], root: string, customModules?: SolverModules): Promise<number> {
  const { values } = parseArgs({ args, options: {
    workspace: { type: 'string' }, 'receipt-file': { type: 'string' }, 'task-file': { type: 'string' },
    output: { type: 'string' }, 'build-manifest': { type: 'string' }, model: { type: 'string', default: 'deepseek-flash' },
    effort: { type: 'string', default: 'high' }, codex: { type: 'string' }, resume: { type: 'boolean' },
    harness: { type: 'string' }, 'harness-executable': { type: 'string' }, 'harness-profile': { type: 'string' },
    'max-run-seconds': { type: 'string', default: '0' }, 'max-turns': { type: 'string', default: '0' },
    'max-total-tokens': { type: 'string', default: '0' },
    'prepare-timeout-seconds': { type: 'string', default: '0' }, 'max-turn-seconds': { type: 'string', default: '0' },
    'evaluator-command': { type: 'string' }, 'evaluator-timeout-seconds': { type: 'string', default: '0' },
    'proof-timeout-seconds': { type: 'string', default: '0' },
    'no-explanations': { type: 'boolean' }, 'explanation-language': { type: 'string' },
    'proof-environment-cache-dir': { type: 'string' }, 'startup-only': { type: 'boolean' }, 'check-statement': { type: 'boolean' },
    help: { type: 'boolean' },
    'knowledge-base': { type: 'string' }, 'continuation-manifest': { type: 'string' },
    'library-catalog': { type: 'string' }, 'library-catalog-sha256': { type: 'string' },
    'continuation-source-run': { type: 'string' },
    method: { type: 'string', default: 'direct' }, workers: { type: 'string', default: '4' },
    'module-plan': { type: 'string' },
    scheduler: { type: 'string', default: 'plan' }, coordination: { type: 'string', default: 'cooperative' },
    'plan-approval': { type: 'boolean' },
    'research-mode': { type: 'string' }, 'skill-loading': { type: 'string' },
    'common-research-skill': { type: 'string' }, 'skill-delegation': { type: 'string' }, 'skill-max-agents': { type: 'string' },
  } });
  if (values.help) {
    console.log(`Usage: theorem-os run --workspace DIR --task-file FILE --output FILE --build-manifest FILE [--receipt-file FILE] [--resume] [--method direct] [--scheduler plan|critical-path|continuation] [--module-plan FILE] [--coordination cooperative|independent] [--workers 1..${MAX_RESEARCH_WORKERS}] [--plan-approval] [--model MODEL --effort LEVEL] [--max-run-seconds N --max-turns N --max-turn-seconds N] [--max-total-tokens N] [--prepare-timeout-seconds N] [--proof-timeout-seconds N] [--evaluator-command CMD --evaluator-timeout-seconds N] [--proof-environment-cache-dir DIR] [--startup-only] [--check-statement]\n--module-plan loads the shared research-module plan JSON; use --scheduler plan.\nUse 0 for --prepare-timeout-seconds, --max-run-seconds, --max-turns, --max-turn-seconds, --proof-timeout-seconds or --evaluator-timeout-seconds to disable that limit. All time, turn and token limits default to 0 (unlimited). With an explicit proof-check timeout, an expired check saves a resumable checkpoint and the identical candidate gets more time on its next check.\n--max-total-tokens defaults to 0 (unlimited). A finite value stops new model turns after provider-reported consumption reaches it; in-flight turns finish and may exceed it. Resume retains cumulative usage and the saved allowance unless explicitly changed.`);
    console.log('--knowledge-base FILE attaches an immutable saved-theorem catalog. Resume requires the same catalog digest. Historical knowledge never grants proof acceptance.');
    console.log('New proof runs default to --effort high. Resume retains the saved effort when --effort is omitted; an explicit effort must match the frozen run.');
    console.log('Accepted proofs automatically generate audited explanations of every original target. --explanation-language zh|en selects the language (default zh; resume keeps the previous language). --no-explanations skips generation. The result.explanations field records progress and artifact/proof.md paths. Explanation failures preserve proof acceptance and exit code; --resume retries them without solving again. Explanation time and tokens are separate from solving limits.');
    console.log('--library-catalog FILE --library-catalog-sha256 DIGEST enables agent search/get/request against one pinned release. Installation requests end this frozen run for host-controlled continuation.');
    console.log('--continuation-manifest FILE attaches explicit historical sources and notes without changing the verbatim task file. Resume retains the frozen attachment identity; historical material remains advisory.');
    console.log('--continuation-source-run OLD_RESULT_OR_STATE initializes a new cooperative run from the old run, freshly checks its saved helpers, and starts solving in the same process. Use --resume to retry an interrupted zero-turn initialization; combine with --startup-only to retain a prepared checkpoint.');
    console.log('--check-statement also elaborates the target files at startup (theorem bodies may still be sorry) and fails with math_statement_check_failed on a Lean error; statement-diagnostics.json keeps the messages.');
    console.log('--plan-approval holds every worker after the first accepted plan until a person approves that exact plan version (queuePlanApproval, the web workbench). The Lead takes a revision turn only for Lead guidance written while it waits. Waiting counts toward --max-run-seconds. Requires cooperative coordination and at least 2 workers; resume requires the same setting.');
    console.log('Lead planning and ordinary research first yield a resumable scheduling checkpoint after 120 seconds, with a reminder after 90 seconds. Lead planning keeps 120-second slices; ordinary research backs off to at most 960 seconds. Saved threads and drafts survive resume. Proof turns and total solving budgets are unchanged.');
    console.log('--research-mode skill loads pinned research methods in single, independent or cooperative workflows. New Skill runs default to one independent researcher; explicit --workers above 1 defaults to cooperative, and explicit --coordination cooperative defaults to 4 workers. Schedulers, module plans, plan approval and host acceptance retain their existing contracts. --skill-loading native|file selects native skill input or the same frozen file. Resume inherits saved mode, loading, workers and coordination; historical single-only Skill checkpoints retain their original semantics.');
    console.log('--harness codex|claude-code|opencode|cli selects the native agent independently of research method and --model. Additional harnesses default to Skill/file loading, require an explicit --model and dedicated --harness-profile DIR, and support host-managed single, independent and cooperative execution. Explicit legacy mode remains available. --harness-executable overrides the native binary; --codex remains a Codex-only alias. Resume retains the backend, model, executable, profile and session plan; changed executable/configuration bytes require a new run. New backends require Linux bubblewrap. Native turn usage stops subsequent dispatches; it does not enforce individual provider-request admission.');
    console.log('--harness cli runs any configured headless command using DEDICATED_PROFILE/cli.json: argv, stdin/file/argument input, text/JSON/JSONL output, optional exact native session resume and usage fields. Use --harness-profile DIR and an explicit --model; --harness-executable optionally overrides the configured executable. CLIs without reasoning control require explicit --effort none. Commands without native resume receive full context on every turn and continue from saved sources/notes. Missing or partial usage blocks further finite-budget dispatches. See docs/generic-cli.md.');
    console.log('--common-research-skill native|file gives every research worker the same pinned mathematical skill and minimal host contracts for controlled strategy comparisons. Resume retains this identity. --research-mode skill --skill-delegation team --skill-max-agents 3 enables a Codex Lead to organize persistent proof writers through theoremos_team (single host Lead, --workers 1 --coordination independent). --skill-delegation read-only retains bounded native investigations. --skill-max-agents 2..4 includes the Lead. Both modes share the run budget; built-in spawn/fork remains disabled.');
    console.log('Team mode makes an early collaboration decision and exposes remaining run time and turn deadlines to every member. A finite --max-turn-seconds remains a hard ceiling; at 80% the host requests a checkpoint at the next model-request boundary, allowing the current response and tools to finish first. The overall deadline and cancellation remain hard stops; missing usage still blocks finite-budget continuation.');
    return 0;
  }
  const specified = (key: string) => args.some(arg => arg === '--' + key || arg.startsWith('--' + key + '='));
  let savedConfiguration: SolverRunState | undefined;
  if (values.resume && values.output) {
    try { savedConfiguration = readSolverRunState(`${path.resolve(values.output)}.runtime/state.json`); }
    catch { /* The authoritative read under the run lease reports invalid resume state. */ }
  }
  const harness = researchHarness(values.harness ?? savedConfiguration?.agentHarness?.id ?? 'codex');
  if (harness.id !== 'codex' && values.codex) throw new Error('--codex requires --harness codex');
  if (values.codex && values['harness-executable'] && values.codex !== values['harness-executable'])
    throw new Error('conflicting --codex and --harness-executable');
  if (harness.id !== 'codex' && !specified('model') && !savedConfiguration)
    throw new Error('--model is required for --harness ' + harness.id);
  if (savedConfiguration && !specified('model')) values.model = savedConfiguration.model;
  const researchMode = values['research-mode'] ?? savedConfiguration?.researchMode ?? (harness.id === 'codex' ? 'legacy' : 'skill');
  if (!['legacy', 'skill'].includes(researchMode)) throw new Error('invalid --research-mode');
  const skillMode = researchMode === 'skill';
  const skillLoading = values['skill-loading'] ?? savedConfiguration?.researchSkill?.loading ?? (harness.nativeSkills ? 'native' : 'file');
  if (!['native', 'file'].includes(skillLoading) || !skillMode && values['skill-loading']) throw new Error('invalid --skill-loading');
  if (!harness.nativeSkills && skillLoading === 'native') throw new Error('math_harness_native_skill_loading_unsupported');
  const commonLoading = values['common-research-skill'] ?? savedConfiguration?.commonResearchSkill?.loading;
  if (commonLoading && (!['native', 'file'].includes(commonLoading) || skillMode && commonLoading !== skillLoading))
    throw new Error('invalid --common-research-skill');
  const delegationMode = values['skill-delegation'] ?? savedConfiguration?.researchDelegation?.mode;
  if (delegationMode && (!skillMode || !['read-only', 'team'].includes(delegationMode)) || values['skill-max-agents'] && !delegationMode)
    throw new Error('invalid --skill-delegation');
  const maxAgents = Number(values['skill-max-agents'] ?? savedConfiguration?.researchDelegation?.maxAgents ?? 4);
  if (delegationMode && (!Number.isSafeInteger(maxAgents) || maxAgents < 2 || maxAgents > 4)) throw new Error('invalid --skill-max-agents');
  if (delegationMode === 'read-only') validateNativeDelegation({ mode: 'read-only', maxAgents });
  if (delegationMode === 'team' && harness.id !== 'codex') throw new Error('math_team_requires_codex_dynamic_tools');
  const researchDelegation = delegationMode ? { mode: delegationMode as 'read-only' | 'team', maxAgents } : undefined;
  if (skillMode) {
    if (!specified('workers')) values.workers = String(savedConfiguration?.workerCount ??
      (specified('coordination') && values.coordination === 'cooperative' ? 4 : 1));
    if (!specified('coordination')) values.coordination = savedConfiguration?.coordination ??
      (Number(values.workers) > 1 ? 'cooperative' : 'independent');
    if (savedConfiguration && !savedConfiguration.researchSkillWorkflow &&
        (values.workers !== '1' || values.coordination !== 'independent' || values.method !== 'direct' ||
          values.scheduler !== 'plan' || values['module-plan'] || values['plan-approval']))
      throw new Error('math_skill_research_requires_single_independent_direct');
  }
  if (delegationMode === 'team' && (values.workers !== '1' || values.coordination !== 'independent' || values['plan-approval'] || values['module-plan']))
    throw new Error('math_team_requires_single_lead');
  const configured = configuredSolverModules(values.method!, values.scheduler!);
  if (customModules && values.scheduler !== 'plan') throw new Error('custom modules cannot combine with --scheduler');
  if (!['cooperative', 'independent'].includes(values.coordination!)) throw new Error('invalid --coordination');
  const coordination = values.coordination as 'cooperative' | 'independent';
  if (values['module-plan'] && (customModules || values.scheduler !== 'plan'))
    throw new Error('--module-plan requires --scheduler plan and no injected modules');
  const baseModules = values['module-plan']
    ? configurableSolverModules(researchModulePlanSchema.parse(readMathJson(values['module-plan'])) as ResearchModulePlan, coordination, Number(values.workers))
    : customModules ?? configured;
  const modules: SolverModules = harness.id === 'codex' ? baseModules : { ...baseModules,
    M1: { ...baseModules.M1, version: baseModules.M1.version + ':' + harness.id + ':v1',
      open: customModules && customModules.M1.open !== directSolverModules.M1.open ? customModules.M1.open : harness.open } };
  const required = (key: keyof typeof values): string => {
    const value = values[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--${key} is required`);
    return value;
  };
  const limit = (key: keyof typeof values, unlimited = false): number => {
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
  const effortSpecified = args.some(arg => arg === '--effort' || arg.startsWith('--effort='));
  const evaluatorMs = limit('evaluator-timeout-seconds', true) * 1000;
  if (values['explanation-language'] !== undefined && !['zh', 'en'].includes(values['explanation-language']))
    throw new Error('invalid --explanation-language');
  const workerCount = limit('workers');
  if (workerCount > MAX_RESEARCH_WORKERS) throw new Error('invalid --workers');
  const singleSkill = skillMode && workerCount === 1;
  if (values['continuation-source-run'] && !singleSkill && (coordination !== 'cooperative' || workerCount < 2))
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
  let executionClock: ExecutionDeadline | undefined;
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
      const receiptFile = values['receipt-file'] || path.join(workspace, 'active-problem.json');
      const problem = readSolverProblem(workspace, receiptFile);
      const assertHostProblemCurrent = () => {
        if (problem.libraryBinding?.hostConfiguration && readSolverProblem(workspace, receiptFile).receiptDigest !== problem.receiptDigest)
          throw new Error('library_host_binding_changed');
      };
      if (problem.libraryBinding?.hostConfiguration && (values['continuation-manifest'] || values['continuation-source-run']))
        throw new Error('library_knowledge_history_unauthorized');
      if (values['library-catalog'] || values['library-catalog-sha256']) assertLibraryCatalogAccess(problem);
      if (Boolean(values['library-catalog']) !== Boolean(values['library-catalog-sha256'])) throw new Error('math_library_catalog_pin_missing');
      const libraryCatalog = values['library-catalog'] && readLibraryCatalog(values['library-catalog'], values['library-catalog-sha256']);
      if (libraryCatalog && (problem.kind !== 'lean-task' ||
          readLeanTaskReceipt(problem.activeProblemPath).environmentDigest !== libraryCatalog.identity.environmentDigest))
        throw new Error('math_library_catalog_environment_changed');
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
      const profileArgument = values['harness-profile'] ?? savedConfiguration?.agentHarness?.profile;
      if (harness.id !== 'codex' && !profileArgument) throw new Error('--harness-profile is required for --harness ' + harness.id);
      const profile = profileArgument ? fs.realpathSync(profileArgument) :
        process.env.CODEX_HOME || path.join(os.homedir(), '.config/deepscientist/math-sol-codex');
      const cli = harness.id === 'cli' ? readCliConfiguration(profile) : undefined;
      const sourceEnvironment = { ...process.env };
      // Explicit CLI-only inputs, including unusually named credentials, never enter host Lean.
      for (const key of cli?.inheritEnvironment ?? []) delete sourceEnvironment[key];
      const preparedEnvironment = prepareSolverRuntimeEnvironment(sourceEnvironment);
      let { environment: env, corpusFile, corpusBytes, corpus } = preparedEnvironment;
      const { mathTools } = preparedEnvironment;
      const executable = values['harness-executable'] ?? values.codex ?? savedConfiguration?.agentHarness?.executable ??
        (cli?.executable ?? (harness.id === 'codex' ? process.env.DEEPSCIENTIST_MATH_CODEX_EXECUTABLE || 'codex' : harness.id === 'claude-code' ? 'claude' : 'opencode'));
      // Historical Codex checkpoints retain their existing binding; explicit new flags opt into full launch identity.
      const pinHarness = harness.id !== 'codex' || specified('harness-executable') || specified('harness-profile') ||
        Boolean(savedConfiguration?.agentHarness);
      const agentHarness = pinHarness ? bindResearchHarness(harness.id, executable, profile, process.env, values.model) : undefined;
      const harnessEnvironment = harness.id === 'codex' ? undefined : researchHarnessEnvironment(harness.id, process.env,
        { profile, model: values.model! });
      const assertHarnessCurrent = agentHarness ? () => assertResearchHarnessCurrent(agentHarness, harnessEnvironment ?? {}, values.model) : undefined;
      const sub2apiProfile = modules.M1.open === directSolverModules.M1.open ? selectedSub2apiProfile(profile) : undefined;
      const westlakeProfile = modules.M1.open === directSolverModules.M1.open && !sub2apiProfile ? selectedWestlakeProfile(profile) : undefined;
      const providerProfile = modules.M1.open === directSolverModules.M1.open
        ? selectedDeepSeekProfile(profile) ?? sub2apiProfile ?? westlakeProfile : undefined;
      const knowledge = values['knowledge-base'] ? readAuthorizedKnowledgeCatalog(values['knowledge-base'], workspace,
        values['receipt-file'] || path.join(workspace, 'active-problem.json')) : undefined;
      const resumedState = values.resume ? readSolverRunState(stateFile) : undefined;
      if (cli && !cli.efforts.includes(resumedState && !effortSpecified ? resumedState.effort : values.effort!))
        throw new Error('math_cli_effort_unsupported');
      const researchSkill = skillMode ? researchSkillIdentity(readMathAgentSkill(
        path.join(root, 'skills/theoremos-research/SKILL.md'), skillLoading as 'native' | 'file')) : undefined;
      const commonResearchSkill = commonLoading ? researchSkillIdentity(readMathAgentSkill(
        path.join(root, 'skills/theoremos-research/SKILL.md'), commonLoading as 'native' | 'file')) : undefined;
      const skill = researchSkill ?? commonResearchSkill;
      const plannedSession = planMathAgentSession(harness.id, { ...(skill ? { skills: [readMathAgentSkill(
        path.join(root, 'skills/theoremos-research/SKILL.md'), skill.loading)] } : {}),
        ...(workerCount === 1 ? { completedOutput: new SingleSolverProofHandoff(problem, slots[0].worktree, () => {}).output } : {}),
        ...(researchDelegation?.mode === 'read-only' ? { delegation: { ...researchDelegation, mode: 'read-only' as const } } : {}) }, cli);
      const identity = { taskDigest: mathDigest(task), buildDigest: mathDigest(fs.readFileSync(buildFile)),
        providerProfile: providerProfile?.profile, providerProfileDigest: providerProfile?.digest,
        environmentDigest: preparedEnvironment.environmentDigest,
        evaluatorDigest: mathDigest(values['evaluator-command'] || 'host-default'), model: values.model!,
        effort: resumedState && !effortSpecified ? resumedState.effort : values.effort!,
        methodDigest: solverMethodDigest(modules, coordination), knowledgeDigest: knowledge?.digest,
        libraryCatalogDigest: libraryCatalog ? libraryCatalog.identity.catalogDigest : undefined };
      // Generation prepares its own proof environment; do not freeze solver worktree mounts into its resumable identity.
      const explanationEnv = env;
      const explainAccepted = async (state: SolverRunState, result: Record<string, unknown>, worktree: string) => {
        const previous = result.explanations as SolverExplanations | undefined;
        const language = (values['explanation-language'] as 'zh' | 'en' | undefined) ??
          (previous?.language === 'en' ? 'en' : 'zh');
        if (values['no-explanations']) {
          if (!previous) {
            result.explanations = { status: 'disabled', language, directory: path.join(directory, 'explanations', language), targets: [] };
            try { lease.assertOwned(); writeMathJsonDurable(output, result); }
            catch { emit('explanation_failed', { reason: 'automatic_explanation_failed', output }); }
          }
          return;
        }
        clearTimeout(timer); timer = undefined;
        try {
          await disposeProofEnvironment();
          await generateSolverExplanations({ problem: state.problem, worktree, directory, root, buildManifest: buildFile,
            language, writer: { model: state.model, effort: state.effort, profile, executable,
              ...(agentHarness ? { agentHarness } : {}) },
            env: explanationEnv, signal, onEvent: emit,
            onUpdate: summary => { lease.assertOwned(); result.explanations = summary; writeMathJsonDurable(output, result); } });
        } catch {
          // The accepted result was saved first. A generation or persistence error never invalidates that proof.
          const failed = result.explanations as SolverExplanations | undefined;
          if (!failed || failed.status === 'running') {
            result.explanations = { status: signal.aborted ? 'stopped' : 'error', language,
              directory: path.join(directory, 'explanations', language),
              targets: (failed?.targets ?? []).map(target => target.status === 'pending' || target.status === 'running'
                ? { ...target, status: signal.aborted ? 'stopped' : 'error', reason: 'automatic_explanation_failed' } : target) };
            try { lease.assertOwned(); writeMathJsonDurable(output, result); }
            catch { /* Keep the already-persisted accepted proof result. */ }
          }
          emit('explanation_failed', { reason: 'automatic_explanation_failed', output });
        }
      };
      const moduleConfiguration = solverModuleConfiguration(modules);
      let state: SolverRunState;
      let sourceFeedback: string | undefined;
      if (values.resume) {
        state = resumedState!;
        assertAgentTeamProcessesStopped(state);
        if (canonicalMathJson(state.agentHarness ?? null) !== canonicalMathJson(agentHarness ?? null))
          throw new Error('math_resume_harness_identity_changed');
        if ((state.researchMode ?? 'legacy') !== researchMode ||
            canonicalMathJson(state.researchSkill ?? null) !== canonicalMathJson(researchSkill ?? null) ||
            canonicalMathJson(state.commonResearchSkill ?? null) !== canonicalMathJson(commonResearchSkill ?? null) ||
            canonicalMathJson(state.researchDelegation ?? null) !== canonicalMathJson(researchDelegation ?? null))
          throw new Error('math_resume_research_strategy_changed');
        if (state.agentSessionPlan && canonicalMathJson(state.agentSessionPlan) !== canonicalMathJson(plannedSession))
          throw new Error('math_resume_session_plan_changed');
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
          (Object.keys(identity) as (keyof typeof identity)[]).some(key => state[key] !== identity[key]) ||
          state.worktree !== path.join(directory, 'worktree')) throw new Error('math_resume_identity_changed');
        if (state.continuationDigest) {
          continuation = readContinuationSnapshot(path.join(directory, 'continuation.json'), state.continuationDigest, continuationIdentity);
          if (continuationInput && continuationInput.digest !== state.continuationDigest)
            throw new Error('math_resume_continuation_changed');
        } else if (continuationInput) throw new Error('math_resume_continuation_changed');
        // Use the current authoritative receipt instead of trusting nested archived source policy.
        state.problem = problem;
        if (state.researchSkill ?? state.commonResearchSkill) prepareResearchSkill(root, state.worktree,
          (state.researchSkill ?? state.commonResearchSkill)!, problem);
        sourceFeedback = solverSourceFeedback(state.problem, state.worktree);
        assertSolverSources(state.problem, workspace);
        if (state.phase === 'finished' && fs.existsSync(output)) {
          const result = readMathJson(output) as Record<string, unknown> & { status: string; runId: string; solution_commit: string };
          if (result.status === 'evaluated_passed' || result.status === 'evaluated_failed') {
            const winningWorktree = state.workers?.find(worker => worker.id === state.winningWorker)?.worktree ?? state.worktree;
            assertSolverSources(state.problem, winningWorktree);
            if (!state.check?.passed || result.runId !== state.runId || result.solution_commit !== state.check.commit ||
                !solverProofIsCurrent(state.problem, winningWorktree, state.check) ||
                !solverProofIsCurrent(state.problem, workspace, state.check)) throw new Error('math_resume_completed_proof_changed');
            if (result.status === 'evaluated_passed') await explainAccepted(state, result, winningWorktree);
            return result.status === 'evaluated_passed' ? 0 : 2;
          }
        }
      } else {
        if (fs.existsSync(stateFile) || fs.existsSync(output)) throw new Error('math_run_exists_use_resume');
        if (git(workspace, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('math_workspace_has_uncommitted_sources');
        if (continuationInput) continuation = freezeContinuationInput(continuationInput, directory);
        ownsRun = true;
        state = { schema: 'deepscientist.math.solver.v1', runId: crypto.randomUUID(), problem, ...identity,
          ...(agentHarness ? { agentHarness } : {}),
          agentSessionPlan: plannedSession,
          ...(researchSkill ? { researchMode: 'skill', researchSkill, researchSkillWorkflow: 'full' } : {}),
          ...(commonResearchSkill ? { commonResearchSkill } : {}), ...(researchDelegation ? { researchDelegation } : {}),
          ...(continuation ? { continuationDigest: continuation.digest } : {}),
          worktree: path.join(directory, 'worktree'), phase: 'prepared', turns: 0, dispatchCounts: {}, workerCount,
          coordination, ...(planApproval ? { planApproval } : {}), moduleConfiguration, tokenBudget: buildTokenBudget(maxTotalTokens, [],
            westlakeProfile ? 'provider-observed-upstream-request-limit' : undefined) };
        if (workerCount > 1) state.workers = workers
          .map(worker => ({ id: worker.id, role: worker.role, worktree: worker.worktree, phase: 'prepared', turns: 0, dispatchCounts: {} }));
        git(workspace, ['worktree', 'add', '--detach', state.worktree, problem.baseCommit]);
        writeSolverRunState(stateFile, state);
      }
      if (state.researchSkill ?? state.commonResearchSkill) prepareResearchSkill(root, state.worktree,
        (state.researchSkill ?? state.commonResearchSkill)!, problem);
      ownsRun = true;
      ownedState = state;
      state.tokenBudget = buildTokenBudget(maxTotalTokens,
        [...(state.workers ?? [state]), ...(state.agentTeam?.workers ?? [])], state.tokenBudget?.enforcement);
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
      const checkDependencies = async (workerId: string, projectRoot: string,
        timeoutMs = preparationMs - (Date.now() - preparationStarted)) => {
        if (sourcePackages) prepareLeanDiagnosticOverrides(projectRoot);
        const diagnostics = await runLeanDiagnostics({ projectRoot, files: [...new Set(problem.targets.map(target => target.proofPath))],
          dependenciesOnly: true, excludedFiles: problem.ownedFiles, env, signal,
          timeoutMs,
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
          timeoutMs: preparationMs - (Date.now() - preparationStarted), onProgress: file => emit('library_pack_check', { file }),
          sharedLibraryCache: { root: DEFAULT_LEAN_LIBRARY_CACHE_ROOT, files: problem.frozenFiles },
          onSharedCache: (phase, file) => emit('library_pack_cache', { phase, ...(file ? { file } : {}) }) });
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
      assertHostProblemCurrent();
      const installedLibrary = readInstalledLibrarySnapshot(problem, state.environmentDigest);
      const knowledgeSnapshot = knowledge && indexKnowledgeContextSnapshot({ digest: knowledge.digest, base: { entries: knowledge.base.entries,
        evidence: knowledge.base.evidence, contexts: knowledge.base.contexts, routeFindings: knowledge.base.routeFindings } });
      const workerAccess = new Map<string, WorkerAccess>();
      const prepareAccess = (workerId: string, workerRoot: string, workerProject: string, workerCorpus?: string) => {
        const pinnedSkill = (state.researchSkill ?? state.commonResearchSkill) && prepareResearchSkill(root, workerRoot,
          (state.researchSkill ?? state.commonResearchSkill)!, state.problem);
        const workerContinuation = continuation && copyContinuationSnapshot(continuation, workerProject);
        assertHostProblemCurrent();
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
          ...(harnessEnvironment ? { harnessEnvironment } : {}),
          ...(assertHarnessCurrent ? { assertHarnessCurrent } : {}),
          ...(cli ? { nativeContinuity: cli.session.mode !== 'fresh' } : {}),
          ...(pinnedSkill ? { researchSkill: pinnedSkill } : {}),
          ...(state.commonResearchSkill && pinnedSkill ? { commonResearchSkill: pinnedSkill } : {}),
          retrievalRoot: corpus?.projectSubdirectory ? workerRoot : workerProject,
          ...(mathTools ? { mathTools } : {}),
          ...(installedLibrary ? { installedLibrary } : {}),
          ...(libraryCatalog ? { libraryCatalog: { file: path.resolve(values['library-catalog']!), digest: libraryCatalog.identity.catalogDigest } } : {}),
          ...(workerContinuation ? { continuation: workerContinuation } : {}),
          ...(problem.libraryBinding?.hostConfiguration ? { assertKnowledgeCurrent: () => {
            if (knowledge) readAuthorizedKnowledgeCatalog(knowledgeFile!, workspace, receiptFile, knowledge.digest);
            else assertHostProblemCurrent();
          } } : {}),
          ...(knowledge ? { knowledgeFile, knowledgeDigest: knowledge.digest,
            knowledgeSnapshot } : {}) });
      };
      prepareAccess('solver', state.worktree, project, corpusFile);
      const prepareTeamWorker = async (workerId: string, workerWorktree: string): Promise<WorkerAccess> => {
        signal.throwIfAborted();
        const accessId = state.researchDelegation?.mode === 'team' ? 'team-' + workerId : workerId;
        const workerProject = prepareProject(workerWorktree);
        const lake = path.join(workerProject, '.lake');
        await checkDependencies(accessId, workerProject, preparing ? preparationMs - (Date.now() - preparationStarted) :
          Math.min(preparationMs, executionClock!.remainingMs()));
        let workerCorpusFile: string | undefined;
        if (corpusFile) {
          workerCorpusFile = path.join(lake, 'retrieval-corpus.json');
          assertMathCanonicalPath(workerCorpusFile);
          if (fs.existsSync(workerCorpusFile)) {
            if (mathDigest(readMathText(workerCorpusFile)) !== env.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256)
              throw new Error('math_corpus_identity_changed');
          } else fs.writeFileSync(workerCorpusFile, corpusBytes!, { mode: 0o400, flag: 'wx' });
        }
        prepareAccess(accessId, workerWorktree, workerProject, workerCorpusFile);
        return workerAccess.get(accessId)!;
      };
      const peerPreparation = await Promise.allSettled(workers.slice(1).map(worker => prepareTeamWorker(worker.id, worker.worktree)));
      const failedPreparation = peerPreparation.find(result => result.status === 'rejected');
      if (failedPreparation?.status === 'rejected') throw failedPreparation.reason;
      let freshContinuationChecks: readonly TaskProof[] | undefined;
      if (values['continuation-source-run']) {
        save(); continuationSeeding = true;
        await (singleSkill ? seedSingleSolverContinuation : seedSolverContinuation)({ sourceRun: values['continuation-source-run'], run: stateFile, root, buildManifest: buildFile,
          signal, lease, preparedEnvironment: env, timeoutMs: maxRunMs === Infinity ? Infinity : Math.max(1, preparationMs - (Date.now() - preparationStarted)),
          onProgress: emit, onSeeded: (seeded, checks) => { state = ownedState = seeded; freshContinuationChecks = checks; } });
        continuationSeeding = false;
        if (!state.continuationDigest) throw new Error('math_continuation_identity_missing');
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
      state.solveWaitingMs = 0;
      deadline = state.solveStartedAt + maxRunMs;
      timer = undefined;
      executionClock = new ExecutionDeadline(maxRunMs, abort);
      const executionBudget = {
        remainingMs: () => executionClock!.remainingMs(),
        setWaiting: (waiting: boolean) => {
          const previous = executionClock!.waiting;
          executionClock!.setWaiting(waiting);
          state.solveWaitingMs = executionClock!.waitingMs();
          if (previous !== executionClock!.waiting) emit(executionClock!.waiting ? 'plan_approval_wait_started' : 'plan_approval_wait_ended');
        },
      };
      emit('solve_started', { budgetMs: maxRunMs, maxTurnMs });
      const winner = await withVerificationCheckpoints({ environmentDigest: state.environmentDigest,
        problemReceiptDigest: state.problem.receiptDigest, checkpoints: state.verificationCheckpoints ??= [], save, emit },
        () => runResearchWorkers({ state, workers, access: workerAccess, modules, root, buildFile, taskText: task,
        executable: agentHarness?.executable ?? executable,
        profile,
        signal, deadline, executionBudget, maxTurns, maxTurnMs, maxTotalTokens, proofTimeoutMs,
        freshContinuationChecks, prepareTeamWorker, save, emit }));
      clearTimeout(timer);
      timer = undefined;
      executionClock.stop();
      state.solveWaitingMs = executionClock.waitingMs();
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
        solveWallMs: state.solveFinishedAt - state.solveStartedAt, solveExecutionMs: executionClock.executionMs(),
        solveWaitingMs: state.solveWaitingMs, stateFile, winningWorker: state.winningWorker };
      writeMathJsonDurable(output, result);
      if (status === 'evaluated_passed') await explainAccepted(state, result, winner!.worktree);
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
      if (!ownsRun) { emit('rejected', { reason: error instanceof Error ? error.message : 'math_runtime_error',
        ...(error instanceof MathGitError ? { git: error.diagnostic } : {}) }); return 1; }
      lease.assertOwned();
      const checkpoint = error instanceof VerificationCheckpointError;
      const libraryRequest = error instanceof LibraryInstallationRequested ? error : undefined;
      executionClock?.stop();
      const status = controller.signal.aborted || checkpoint ? 'limit_reached' : libraryRequest ? 'library_requested' : 'runtime_error';
      // Initialization owns durable progress before its final in-memory handoff.
      if (continuationSeeding) ownedState = readSolverRunState(stateFile);
      if (ownedState) {
        // A zero-turn continuation can retry any preparation step, including
        // snapshot distribution and startup-only output after the seed handoff.
        if (!(preparing && values['continuation-source-run'] && ownedState.phase === 'prepared'))
          ownedState.phase = 'finished';
        if (ownedState.solveStartedAt && !ownedState.solveFinishedAt) ownedState.solveFinishedAt = Date.now();
        if (executionClock) ownedState.solveWaitingMs = executionClock.waitingMs();
        ownedState.error = controller.signal.aborted || checkpoint || libraryRequest ? undefined : error instanceof Error ? error.message : 'math_runtime_error';
        const verification = verifierFailureDiagnostic(error);
        if (verification) ownedState.verifierFailure = verification;
        writeSolverRunState(stateFile, ownedState);
      }
      writeMathJsonDurable(output, { schema: 'deepscientist.math.run.v2', status, run_outcome: status,
        reason: controller.signal.aborted ? preparing ? 'math_preparation_stopped' : 'math_run_stopped' : error instanceof Error ? error.message : 'math_runtime_error',
        runId: ownedState?.runId, problemId: ownedState?.problem.contract.problemId, ...runSummary(ownedState),
        ...(ownedState?.solveStartedAt && ownedState.solveFinishedAt
          ? { solveWallMs: ownedState.solveFinishedAt - ownedState.solveStartedAt } : {}),
        ...(executionClock ? { solveExecutionMs: executionClock.executionMs(), solveWaitingMs: executionClock.waitingMs() } : {}),
        ...(libraryRequest ? { libraryRequest: { request: libraryRequest.request, worktree: libraryRequest.worktree } } : {}),
        evaluator: { status: 'skipped' }, stateFile });
      publishedExit = controller.signal.aborted || checkpoint ? 4 : 1;
      emit('finished', { status, output, ...(error instanceof MathGitError ? { git: error.diagnostic } : {}) });
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
    executionClock?.stop();
    clearTimeout(timer);
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

