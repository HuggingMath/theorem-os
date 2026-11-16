#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseFlags, required } from './arguments';
import { bootstrapImo2026Problem, IMO2026_SUPPORTED_PROBLEMS, IMO2026_SOURCE_COMMIT } from '../../src/math/imo2026Adapter';
import { bootstrapPutnamBenchProblem, readPutnamBenchProblem, PUTNAM_BENCH_SOURCE_COMMIT,
  PUTNAM_BENCH_REPOSITORY_URL } from '../../src/math/putnamBench';
import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { bootstrapLeanTask, LEAN_TASK_SOURCE_MAX_BYTES } from '../../src/math/leanTask';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { mathDigest, canonicalMathJson, readMathText, writeMathJsonDurable } from '../../src/math/mathRuntimeIo';
import { prepareSolverRuntimeEnvironment } from '../../src/solver/environment';
import { readSolverProblem } from '../../src/solver/problem';
import { readRunInspection, runInspectionSnapshot } from '../../src/solver/inspection';
import { runMathBatch } from './runMathBatch';
import { configuredSolverModules, solverMethodDigest, type SolverModules } from '../../src/solver/modules';
import { configurableSolverModules } from '../../src/solver/modules/custom';
import { moduleExperimentSchema, describeModuleExperiment, moduleExperimentPairs, type ModuleExperiment } from './moduleExperiment';
import { proofReceiptsMatch, type ProofCheck } from '../../src/solver/modules/evidence';
import type { SolverRunState } from '../../src/solver/archive';
import { researchFailureCategory } from '../../src/solver/modules/search';
import { summarizeKnowledgeFunnel } from '../../src/solver/knowledgeFunnel';
import { buildTokenBudget, reportedTotalTokens } from '../../src/solver/usageBudget';
import { MAX_RESEARCH_WORKERS } from '../../src/solver/modules/organization';
import { DEEPSEEK_PROVIDER, deepSeekProfileDigest, expectedDeepSeekProfileDigest, prepareDeepSeekProfile,
  validateDeepSeekModel, selectedDeepSeekProfile } from '../../src/runtime/deepseek';
import { WESTLAKE_PROVIDER, westlakeProfileDigest, expectedWestlakeProfileDigest, prepareWestlakeProfile,
  validateWestlakeModel, selectedWestlakeProfile } from '../../src/runtime/westlake';
import { SUB2API_PROVIDER, sub2apiProfileDigest, expectedSub2apiProfileDigest, prepareSub2apiProfile,
  validateSub2apiModel, selectedSub2apiProfile } from '../../src/runtime/sub2api';
import { assertExperimentKnowledge, experimentKnowledgeMode, freezeExperimentKnowledge,
  type ExperimentKnowledge } from './experimentKnowledge';
import { readMathAgentSkill } from '../../src/runtime/codexSkills';
import { researchSkillIdentity, type ResearchSkillIdentity } from '../../src/solver/researchSkill';
import { assertResearchHarnessCurrent, bindResearchHarness, projectResearchHarnessProfile, researchHarness,
  type ResearchHarnessIdentity } from '../../src/runtime/researchHarness';
import { readCliConfiguration } from '../../src/runtime/cliConfiguration';

const providerProfiles = {
  deepseek: { metadata: DEEPSEEK_PROVIDER, validate: validateDeepSeekModel, prepare: prepareDeepSeekProfile,
    digest: deepSeekProfileDigest, expectedDigest: expectedDeepSeekProfileDigest },
  westlake: { metadata: WESTLAKE_PROVIDER, validate: validateWestlakeModel, prepare: prepareWestlakeProfile,
    digest: westlakeProfileDigest, expectedDigest: expectedWestlakeProfileDigest },
  sub2api: { metadata: SUB2API_PROVIDER, validate: validateSub2apiModel, prepare: prepareSub2apiProfile,
    digest: sub2apiProfileDigest, expectedDigest: expectedSub2apiProfileDigest },
};
type PreparedProvider = keyof typeof providerProfiles;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arms = ['single', 'independent', 'cooperative'] as const;
const skillArms = ['skill', 'independent', 'cooperative'] as const;
type Job = { arm: string; repetition: number; launch: string; launchDigest: string; output: string;
  receiptDigest: string; methodDigest: string; modulePlan?: string; modulePlanDigest?: string;
  codexProfile?: string; codexProfileDigest?: string; researchSkill?: ResearchSkillIdentity;
  commonResearchSkill?: ResearchSkillIdentity; agentHarness?: ResearchHarnessIdentity };
type Plan = {
  schema: 'deepscientist.math.comparison.v1'; problem: string; sourceCommit: string;
  dataset?: 'imo2026' | 'putnambench' | 'lean-task';
  sourceCommitKind?: 'input-sha256';
  sourceProblem?: { repositoryUrl: string; sourceRelativePath: string; sourceSha256: string;
    toolchain: string; mathlibRevision: string; environmentDigest: string };
  leanTask?: { sourceRelativePath: 'source.lean'; sourceSha256: string; environment: 'standard';
    toolchain: string; environmentDigest: string };
  taskDigest: string; buildDigest: string; environmentDigest: string;
  configuration: { model: string; effort: string; method: string; scheduler: string; workers: number; repetitions?: number;
    maxTurns: number; maxRunSeconds: number; maxTurnSeconds: number; maxTotalTokens?: number;
    evaluatorTimeoutSeconds?: number; provider?: PreparedProvider };
  agentHarness?: ResearchHarnessIdentity;
  moduleExperiment?: ModuleExperiment;
  skillBaseline?: ResearchSkillIdentity;
  commonResearchSkill?: ResearchSkillIdentity;
  commonProviderProfile?: { profile: string; digest: string };
  knowledge?: ExperimentKnowledge;
  knowledgeTargetNames?: string[];
  jobs: Job[];
};
const json = (file: string) => JSON.parse(readMathText(file));
const writeNew = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const environmentDigest = () => prepareSolverRuntimeEnvironment().environmentDigest;

function harnessMethodDigest(modules: SolverModules, coordination: 'cooperative' | 'independent',
  harness?: ResearchHarnessIdentity): string {
  const selected = harness && harness.id !== 'codex' ? { ...modules,
    M1: { ...modules.M1, version: modules.M1.version + ':' + harness.id + ':v1' } } : modules;
  return solverMethodDigest(selected, coordination);
}

function assertSkillBaseline(plan: Plan, checkFiles: boolean): void {
  const skill = plan.skillBaseline;
  if (plan.commonResearchSkill && canonicalMathJson(plan.commonResearchSkill) !== canonicalMathJson(skill ?? null))
    throw new Error('comparison_common_guidance_identity_mismatch');
  if (plan.jobs.some(job => canonicalMathJson(job.commonResearchSkill ?? null) !== canonicalMathJson(plan.commonResearchSkill ?? null)))
    throw new Error('comparison_common_guidance_identity_mismatch');
  if (plan.commonResearchSkill && !plan.configuration.provider && !plan.commonProviderProfile && !plan.agentHarness)
    throw new Error('comparison_common_provider_identity_missing');
  if (plan.commonProviderProfile && (!plan.commonResearchSkill || plan.configuration.provider))
    throw new Error('comparison_common_provider_identity_mismatch');
  if (plan.commonProviderProfile && checkFiles && canonicalMathJson(currentProviderProfile(plan.commonProviderProfile.profile)) !==
      canonicalMathJson(plan.commonProviderProfile)) throw new Error('comparison_common_provider_changed');
  if (!skill) {
    if (plan.jobs.some(job => job.researchSkill)) throw new Error('comparison_skill_identity_mismatch');
    return;
  }
  if (plan.moduleExperiment || plan.configuration.method !== 'direct' || plan.configuration.scheduler !== 'plan' ||
      skill.name !== 'theoremos-research' || !/^[a-f0-9]{64}$/u.test(skill.digest) || !['native', 'file'].includes(skill.loading))
    throw new Error('comparison_skill_configuration_mismatch');
  const repetitions = plan.configuration.repetitions;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error('comparison_skill_repetitions_missing');
  const expected = comparisonOrder(repetitions, skillArms);
  if (plan.jobs.length !== expected.length || plan.jobs.some((job, index) => job.arm !== expected[index].arm ||
      job.repetition !== expected[index].repetition || canonicalMathJson(job.researchSkill ?? null) !==
        canonicalMathJson(job.arm === 'skill' ? skill : null))) throw new Error('comparison_skill_plan_identity_mismatch');
  if (checkFiles && canonicalMathJson(researchSkillIdentity(readMathAgentSkill(
    path.join(root, 'skills/theoremos-research/SKILL.md'), skill.loading))) !== canonicalMathJson(skill))
    throw new Error('comparison_skill_changed');
}

function assertComparisonHarnesses(plan: Plan, checkFiles: boolean): void {
  if (!plan.agentHarness) {
    if (plan.jobs.some(job => job.agentHarness)) throw new Error('comparison_harness_identity_mismatch');
    return;
  }
  if (plan.configuration.provider || plan.commonProviderProfile) throw new Error('comparison_harness_provider_conflict');
  const expected = plan.agentHarness;
  if (checkFiles) assertResearchHarnessCurrent(expected, process.env, plan.configuration.model);
  for (const job of plan.jobs) {
    if (!job.agentHarness || canonicalMathJson({ ...job.agentHarness, profile: expected.profile }) !== canonicalMathJson(expected) ||
        job.agentHarness.profile !== path.join(path.dirname(job.launch), 'harness'))
      throw new Error('comparison_harness_identity_mismatch');
    if (checkFiles) assertResearchHarnessCurrent(job.agentHarness, process.env, plan.configuration.model);
  }
}

function currentProviderProfile(profile = process.env.CODEX_HOME || path.join(os.homedir(), '.config/deepscientist/math-sol-codex')) {
  const selected = selectedDeepSeekProfile(profile) ?? selectedSub2apiProfile(profile) ?? selectedWestlakeProfile(profile);
  if (!selected) throw new Error('comparison_common_provider_unverified');
  return { profile: selected.profile, digest: selected.digest };
}

/** Rotate arm order between repetitions; repetition labels are not provider sampling seeds. */
export function comparisonOrder(repetitions: number, names: readonly string[] = arms): { arm: string; repetition: number }[] {
  return Array.from({ length: repetitions }, (_, index) => names.map((_, offset) => ({
    arm: names[(index + offset) % names.length], repetition: index + 1 }))).flat();
}

/** Preserve every planned attempt, including missing results and unavailable token counters. */
export function comparisonTotals(rows: { arm: string; accepted: boolean; totalTokens: number | null }[], names: readonly string[] = arms) {
  return names.map(arm => {
    const runs = rows.filter(row => row.arm === arm);
    return { arm, planned: runs.length, accepted: runs.filter(row => row.accepted).length,
      acceptanceRate: runs.length ? runs.filter(row => row.accepted).length / runs.length : null,
      reportedTokens: runs.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0),
      missingTokenRuns: runs.filter(row => row.totalTokens === null).length };
  });
}

function experimentDefinitions(plan: Plan) {
  if (!plan.moduleExperiment) return;
  const experiment = moduleExperimentSchema.parse(plan.moduleExperiment);
  if (plan.configuration.method !== 'direct' || plan.configuration.scheduler !== 'plan' ||
      !Number.isSafeInteger(plan.configuration.workers) || plan.configuration.workers < 3 ||
      plan.configuration.workers > MAX_RESEARCH_WORKERS) throw new Error('comparison_module_configuration_mismatch');
  const variants = describeModuleExperiment(experiment, plan.configuration.workers);
  const repetitions = plan.configuration.repetitions;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error('comparison_module_repetitions_missing');
  const expected = comparisonOrder(repetitions, variants.map(variant => variant.id));
  if (plan.jobs.length !== expected.length || plan.jobs.some((job, index) =>
    job.arm !== expected[index].arm || job.repetition !== expected[index].repetition ||
    job.methodDigest !== harnessMethodDigest(configurableSolverModules(
      variants.find(variant => variant.id === job.arm)!.plan, 'cooperative', plan.configuration.workers),
      'cooperative', plan.agentHarness) || !job.modulePlan || !job.modulePlanDigest))
    throw new Error('comparison_module_plan_identity_mismatch');
  return { experiment, variants };
}

function assertProviderProfiles(plan: Plan, checkFiles: boolean): void {
  if (!plan.configuration.provider) return;
  const provider = Object.hasOwn(providerProfiles, plan.configuration.provider) ? providerProfiles[plan.configuration.provider] : undefined;
  if (!provider) throw new Error('comparison_provider_invalid');
  for (const job of plan.jobs) {
    if (!job.codexProfile || !job.codexProfileDigest || job.codexProfile !== path.join(path.dirname(job.launch), 'codex') ||
        job.codexProfileDigest !== provider.expectedDigest(job.codexProfile, plan.configuration.model, plan.configuration.effort))
      throw new Error('comparison_provider_profile_identity_mismatch');
    if (checkFiles && provider.digest(job.codexProfile) !== job.codexProfileDigest)
      throw new Error('comparison_provider_profile_changed');
  }
}

function assertDataset(plan: Plan): void {
  if (plan.dataset === undefined) {
    if (plan.sourceProblem || plan.leanTask || plan.sourceCommitKind ||
        plan.sourceCommit === PUTNAM_BENCH_SOURCE_COMMIT || /^putnam_/u.test(plan.problem))
      throw new Error('comparison_dataset_invalid');
    return;
  }
  if (plan.dataset === 'imo2026') {
    if (!IMO2026_SUPPORTED_PROBLEMS.includes(plan.problem as typeof IMO2026_SUPPORTED_PROBLEMS[number]) ||
        plan.sourceCommit !== IMO2026_SOURCE_COMMIT || plan.sourceProblem !== undefined || plan.leanTask || plan.sourceCommitKind)
      throw new Error('comparison_imo_source_identity_mismatch');
    return;
  }
  if (plan.dataset === 'lean-task') {
    const source = plan.leanTask, environment = getLeanTaskEnvironment('standard');
    if (plan.sourceProblem || plan.sourceCommitKind !== 'input-sha256' || !source ||
        source.sourceRelativePath !== 'source.lean' || !/^[a-f0-9]{64}$/u.test(source.sourceSha256) ||
        plan.sourceCommit !== source.sourceSha256 || source.environment !== 'standard' ||
        source.toolchain !== environment.toolchain || source.environmentDigest !== environment.dependencyDigest)
      throw new Error('comparison_lean_task_source_identity_mismatch');
    return;
  }
  if (plan.dataset !== 'putnambench') throw new Error('comparison_dataset_invalid');
  const source = plan.sourceProblem, environment = getLeanTaskEnvironment('mathlib');
  if (plan.leanTask || plan.sourceCommitKind || !/^putnam_[0-9]{4}_[ab][1-6]$/u.test(plan.problem) || plan.sourceCommit !== PUTNAM_BENCH_SOURCE_COMMIT ||
      source?.repositoryUrl !== PUTNAM_BENCH_REPOSITORY_URL ||
      source.sourceRelativePath !== `lean4/src/${plan.problem}.lean` || !/^[a-f0-9]{64}$/u.test(source.sourceSha256) ||
      source.toolchain !== environment.toolchain || source.mathlibRevision !== environment.mathlibRevision ||
      source.environmentDigest !== environment.dependencyDigest)
    throw new Error('comparison_putnam_source_identity_mismatch');
}

function assertLeanTaskSnapshot(directory: string, plan: Plan): void {
  if (plan.dataset === 'lean-task' && mathDigest(readMathText(path.join(directory, plan.leanTask!.sourceRelativePath),
      LEAN_TASK_SOURCE_MAX_BYTES)) !== plan.leanTask!.sourceSha256)
    throw new Error('comparison_lean_task_source_changed');
}

function recordedLocalAcceptance(state: SolverRunState, result?: Record<string, unknown>) {
  const evaluator = result?.evaluator as { status?: string; method?: string; official?: boolean; verification?: ProofCheck } | undefined;
  return state.phase === 'finished' && result?.status === 'evaluated_passed' && result.completion_signal_valid === true &&
    result.solver_ready_receipt_valid === true && state.check?.passed === true &&
    result.solution_commit === state.check.commit && evaluator?.status === 'passed' &&
    evaluator.method === 'host-lean-kernel-all-targets' && evaluator.official === false &&
    evaluator.verification?.passed === true && evaluator.verification.commit === state.check.commit &&
    evaluator.verification.sourceDigest === state.check.sourceDigest && state.problem.targets.length > 0 &&
    proofReceiptsMatch(evaluator.verification.verification, state.check.commit, state.problem.targets.map(target => ({
      proofPath: target.proofPath, theoremName: target.theoremName, expectedSourceDeclarationHash: target.declarationHash,
      statementHash: state.problem.contract.statementHash, leanStatementHash: state.problem.contract.leanStatementHash, claim: 'statement' })));
}

function observedRunUsage(state: SolverRunState) {
  const workers = state.workers ?? [{ id: 'solver', ...state }];
  const missingUsageWorkers = workers.filter(worker => {
    const requests = worker.requestUsageAccounting;
    const attempted = requests ? requests.startedRequests > 0 || requests.incomplete
      : worker.turns > 0 || Boolean(worker.error);
    return attempted && reportedTotalTokens(worker.usage) === null;
  }).map(worker => worker.id);
  const maxTotalTokens = state.tokenBudget?.maxTotalTokens ?? 0;
  // Historical observations use the run's actual allowance, never the planned allowance.
  const tokenBudget = state.tokenBudget ? buildTokenBudget(maxTotalTokens, workers, state.tokenBudget.enforcement) : null;
  const usageComplete = workers.length === (state.workerCount ?? 1) && missingUsageWorkers.length === 0 &&
    (tokenBudget ? tokenBudget.usageComplete : reportedTotalTokens(state.usage) !== null);
  const reportedTokens = tokenBudget ? tokenBudget.reportedTotalTokens : reportedTotalTokens(state.usage);
  return { turns: state.turns, dispatchCounts: state.dispatchCounts, usage: state.usage, tokenBudget,
    workerCount: state.workerCount ?? 1, observedWorkerCount: workers.length,
    missingUsageWorkers, usageComplete, reportedTotalTokens: reportedTokens,
    totalTokens: usageComplete ? reportedTokens : null };
}

export function comparisonReport(directory: string, plan: Plan) {
  assertDataset(plan);
  assertLeanTaskSnapshot(directory, plan);
  assertSkillBaseline(plan, false);
  assertComparisonHarnesses(plan, false);
  const knowledge = assertExperimentKnowledge(directory, plan.knowledge, plan.problem, plan.knowledgeTargetNames ?? [plan.problem]);
  const { experiment, variants } = experimentDefinitions(plan) ?? {};
  assertProviderProfiles(plan, false);
  const batchFile = path.join(directory, 'batch.json');
  const batch = fs.existsSync(batchFile) ? json(batchFile) : undefined;
  const rows = plan.jobs.map(job => {
    const execution = batch?.jobs?.find((item: { launch: string }) => item.launch === job.launch);
    let status = 'missing', accepted = false, turns: number | null = null, usage: Record<string, unknown> | undefined;
    let dispatchCounts: SolverRunState['dispatchCounts'];
    let solveWallMs: number | null = null;
    let error: string | undefined;
    let workerErrors: { id: string; error: string; category?: ReturnType<typeof researchFailureCategory> }[] = [];
    let missingUsageWorkers: string[] = [];
    let tokenBudget: SolverRunState['tokenBudget'] | null = null;
    let sourceSnapshot: ReturnType<typeof runInspectionSnapshot> | null = null;
    let comparisonIdentityMatches: boolean | null = null;
    let knowledgeFunnel: ReturnType<typeof summarizeKnowledgeFunnel> | null = null;
    let observedUsage: ReturnType<typeof observedRunUsage> | null = null;
    let observedEnvironmentDigest: string | null = null;
    let currentObservation: { runId: string; phase: SolverRunState['phase']; status: string; turns: number;
      localAcceptanceEvidenceMatches: boolean; model: string; effort: string; maxTotalTokens: number;
      solutionCommit: unknown } | null = null;
    let usageComplete = false;
    const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    const tokens = reportedTotalTokens;
    try {
      const { state, result } = readRunInspection(job.output);
      sourceSnapshot = runInspectionSnapshot(state, result);
      currentObservation = { runId: state.runId, phase: state.phase,
        status: state.phase !== 'finished' ? 'unfinished' : String(result?.status ?? 'missing'), turns: state.turns,
        localAcceptanceEvidenceMatches: recordedLocalAcceptance(state, result), model: state.model, effort: state.effort,
        maxTotalTokens: state.tokenBudget?.maxTotalTokens ?? 0, solutionCommit: result?.solution_commit ?? null };
      observedUsage = observedRunUsage(state);
      observedEnvironmentDigest = state.environmentDigest;
      comparisonIdentityMatches = false;
      if (plan.configuration.provider && providerProfiles[plan.configuration.provider].digest(job.codexProfile!) !== job.codexProfileDigest)
        throw new Error('comparison_provider_profile_changed');
      if (plan.commonProviderProfile && canonicalMathJson(currentProviderProfile(plan.commonProviderProfile.profile)) !==
          canonicalMathJson(plan.commonProviderProfile)) throw new Error('comparison_common_provider_changed');
      if (plan.dataset === 'putnambench' && (state.problem.kind !== 'lean-task' ||
          mathDigest(state.problem.contract.formalStatement) !== plan.sourceProblem!.sourceSha256))
        throw new Error('comparison_putnam_source_identity_mismatch');
      if (plan.dataset === 'lean-task' && (state.problem.kind !== 'lean-task' ||
          mathDigest(state.problem.contract.formalStatement) !== plan.leanTask!.sourceSha256))
        throw new Error('comparison_lean_task_source_identity_mismatch');
      if (plan.configuration.provider && (state.providerProfile !== fs.realpathSync(job.codexProfile!) ||
          state.providerProfileDigest !== job.codexProfileDigest)) throw new Error('comparison_provider_identity_mismatch');
      if (plan.commonProviderProfile && (state.providerProfile !== plan.commonProviderProfile.profile ||
          state.providerProfileDigest !== plan.commonProviderProfile.digest)) throw new Error('comparison_common_provider_identity_mismatch');
      if (canonicalMathJson(state.agentHarness ?? null) !== canonicalMathJson(job.agentHarness ?? null))
        throw new Error('comparison_harness_identity_mismatch');
      const expectedWorkers = !experiment && ['single', 'skill'].includes(job.arm) ? 1 : plan.configuration.workers;
      const coordination = experiment || job.arm === 'cooperative' ? 'cooperative' : 'independent';
      if (state.problem.receiptDigest !== job.receiptDigest || state.taskDigest !== plan.taskDigest ||
          state.buildDigest !== plan.buildDigest || state.environmentDigest !== plan.environmentDigest || state.methodDigest !== job.methodDigest ||
          state.knowledgeDigest !== plan.knowledge?.digest ||
          state.evaluatorDigest !== mathDigest('host-default') ||
          state.model !== plan.configuration.model || state.effort !== plan.configuration.effort ||
          (state.workerCount ?? 1) !== expectedWorkers ||
          (state.coordination ?? 'cooperative') !== coordination)
        throw new Error('comparison_run_identity_mismatch');
      if ((state.researchMode ?? 'legacy') !== (job.researchSkill ? 'skill' : 'legacy') ||
          canonicalMathJson(state.researchSkill ?? null) !== canonicalMathJson(job.researchSkill ?? null))
        throw new Error('comparison_skill_identity_mismatch');
      if (canonicalMathJson(state.commonResearchSkill ?? null) !== canonicalMathJson(job.commonResearchSkill ?? null))
        throw new Error('comparison_common_guidance_identity_mismatch');
      const maxTotalTokens = plan.configuration.maxTotalTokens ?? 0;
      if ((state.tokenBudget?.maxTotalTokens ?? 0) !== maxTotalTokens)
        throw new Error('comparison_token_budget_mismatch');
      comparisonIdentityMatches = true;
      ({ turns, usage, dispatchCounts, missingUsageWorkers, tokenBudget, usageComplete } = observedUsage);
      if (numeric(state.solveStartedAt) && numeric(state.solveFinishedAt) && state.solveFinishedAt >= state.solveStartedAt)
        solveWallMs = state.solveFinishedAt - state.solveStartedAt;
      workerErrors = (state.workers ?? []).flatMap(worker => worker.error ? [{ id: worker.id, error: worker.error,
        category: researchFailureCategory(worker.error) }] : []);
      status = state.phase !== 'finished' ? 'unfinished' : String(result?.status ?? 'missing');
      accepted = currentObservation.localAcceptanceEvidenceMatches;
      error = typeof result?.reason === 'string' ? result.reason : undefined;
      if (status === 'evaluated_passed' && !accepted) error = 'comparison_acceptance_evidence_incomplete';
      if (state.knowledgeDigest) knowledgeFunnel = summarizeKnowledgeFunnel(state, { mode: plan.knowledge?.mode });
    } catch (cause) {
      status = fs.existsSync(`${job.output}.runtime/state.json`) || fs.existsSync(job.output) ? 'invalid' : 'missing';
      usageComplete = false;
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const totalTokens = usageComplete ? tokenBudget ? tokenBudget.reportedTotalTokens : tokens(usage) : null;
    const overrunTokens = tokenBudget?.overrunTokens ?? (totalTokens === null ? null :
      plan.configuration.maxTotalTokens ? Math.max(0, totalTokens - plan.configuration.maxTotalTokens) : 0);
    const elapsed = execution?.startedAt && execution?.finishedAt
      ? Date.parse(execution.finishedAt) - Date.parse(execution.startedAt) : NaN;
    return { arm: job.arm, repetition: job.repetition, status, accepted, turns, dispatches: turns, dispatchCounts, solveWallMs,
      ...(job.researchSkill ? { researchSkill: job.researchSkill } : {}),
      ...(job.commonResearchSkill ? { commonResearchSkill: job.commonResearchSkill } : {}),
      sourceSnapshot, comparisonIdentityMatches, currentObservation, knowledgeFunnel,
      ...(comparisonIdentityMatches === false && observedUsage ? { historicalObservation: {
        comparisonEligible: false, identityError: error,
        expectedEnvironmentDigest: plan.environmentDigest, observedEnvironmentDigest,
        status: currentObservation!.status, ...observedUsage } } : {}),
      totalTokens, usageComplete, overrunTokens, tokenBudget, missingUsageWorkers, usage, workerErrors, error,
      failureCategory: researchFailureCategory(error),
      wallMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
      batchStatus: execution?.status ?? null, signal: execution?.signal ?? null, batchError: execution?.error ?? null,
      exitCode: execution?.exitCode ?? null, result: job.output, log: execution?.log };
  });
  const enforcements = new Set(rows.map(row => row.tokenBudget?.enforcement ?? 'unknown'));
  const report = { schema: 'deepscientist.math.comparison-report.v1', evidence: 'recorded-not-replayed',
    generatedAt: Date.now(), sourcePlanDigest: mathDigest(canonicalMathJson(plan)),
    sourceBatchDigest: mathDigest(canonicalMathJson(batch ?? null)),
    problem: plan.problem, configuration: plan.configuration, official: false,
    ...(plan.dataset ? { dataset: plan.dataset, sourceProblem: plan.sourceProblem } : {}),
    ...(plan.leanTask ? { leanTask: plan.leanTask, sourceCommitKind: plan.sourceCommitKind } : {}),
    comparisonKind: experiment ? 'module-plan' : plan.commonResearchSkill ? 'research-strategy' : plan.skillBaseline ? 'system-mode' : 'coordination',
    ...(plan.skillBaseline ? { skillBaseline: plan.skillBaseline,
      ...(plan.commonResearchSkill ? { commonResearchSkill: plan.commonResearchSkill } : {}),
      guidanceComparison: plan.commonResearchSkill ? { commonGuidanceFrozen: true, strategyIsolation: true,
        isolationScope: 'shared-mathematical-guidance-with-host-policy-as-treatment',
        protocolDifferencesCounted: true, capabilities: 'same-frozen-runtime-and-tools-not-provider-certified',
        note: 'Every planned arm is configured to load the identical pinned mathematical skill and shared method/tool context. Differences are host research/coordination policy, assignment facts and delivery protocols; their cost is part of the treatment. Native child delegation is disabled. Runtime identity checks do not replace provider execution evidence or establish an efficiency gain.' }
        : { commonGuidanceFrozen: false, strategyIsolation: false,
          note: 'The skill researcher and legacy coordination arms receive different research instructions and protocols. This compares complete system modes under shared model, tool, environment and total-token settings; it does not isolate a coordination algorithm. A strategy experiment still requires equal frozen mathematical guidance and matched capability checks.' } } : {}),
    ...(plan.configuration.provider ? { provider: providerProfiles[plan.configuration.provider].metadata } : {}),
    ...(plan.commonProviderProfile ? { commonProviderProfile: plan.commonProviderProfile } : {}),
    ...(plan.agentHarness ? { agentHarness: plan.agentHarness } : {}),
    sourceCommit: plan.sourceCommit, taskDigest: plan.taskDigest, buildDigest: plan.buildDigest, environmentDigest: plan.environmentDigest,
    ...(knowledge ? { knowledge: knowledge.observation } : {}),
    ...(experiment ? { moduleExperiment: { baseline: experiment.baseline, variants },
      pairedComparisons: moduleExperimentPairs(experiment, rows) } : {}),
    tokenAccounting: 'provider-reported-all-roles',
    tokenBudgetEnforcement: enforcements.size === 1 ? [...enforcements][0] : 'mixed',
    budgetNote: 'Each run records whether the shared allowance gates dispatches or upstream requests. In-flight work may exceed it; missing usage prevents complete token or cost comparisons.',
    totals: comparisonTotals(rows, variants?.map(variant => variant.id) ?? (plan.skillBaseline ? skillArms : undefined)), runs: rows };
  return { ...report, reportHash: mathDigest(canonicalMathJson(report)) };
}

/** Compare a saved report with current stored observations without rewriting either. */
export function comparisonReportFreshness(directory: string, plan: Plan, saved: Record<string, unknown>) {
  const current = comparisonReport(directory, plan);
  const rawRows = Array.isArray(saved.runs) ? saved.runs : [];
  const savedRows = rawRows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
  const { reportHash, ...body } = saved;
  const invalid = saved.schema !== current.schema || savedRows.length !== rawRows.length ||
    typeof reportHash === 'string' && reportHash !== mathDigest(canonicalMathJson(body));
  const bound = typeof reportHash === 'string' && typeof saved.sourcePlanDigest === 'string' && typeof saved.sourceBatchDigest === 'string' &&
    savedRows.every(row => Object.hasOwn(row, 'sourceSnapshot'));
  const rows = current.runs.map(row => {
    const previous = savedRows.find(item => item.arm === row.arm && item.repetition === row.repetition && item.result === row.result);
    const changed = previous && (canonicalMathJson(previous.sourceSnapshot) !== canonicalMathJson(row.sourceSnapshot) ||
      previous.status !== row.status || previous.error !== row.error || previous.accepted !== row.accepted ||
      canonicalMathJson(previous.knowledgeFunnel ?? null) !== canonicalMathJson(row.knowledgeFunnel));
    const freshness = invalid ? 'invalid' : !bound || !previous ? 'unknown' : changed ? 'stale' :
      row.sourceSnapshot === null && row.status === 'invalid' ? 'unknown' : 'current';
    return { arm: row.arm, repetition: row.repetition, result: row.result, freshness,
      previous: previous ? { status: previous.status, accepted: previous.accepted, sourceSnapshot: previous.sourceSnapshot } : null,
      current: { status: row.status, accepted: row.accepted, error: row.error,
        comparisonIdentityMatches: row.comparisonIdentityMatches, observation: row.currentObservation, sourceSnapshot: row.sourceSnapshot } };
  });
  const freshness = invalid ? 'invalid' : !bound ? 'unknown' :
    saved.sourcePlanDigest !== current.sourcePlanDigest || saved.sourceBatchDigest !== current.sourceBatchDigest ||
    savedRows.length !== rows.length || rows.some(row => row.freshness === 'stale') ? 'stale' :
    rows.some(row => row.freshness === 'unknown') ? 'unknown' : 'current';
  return { schema: 'theoremos.comparison-report-freshness.v1', evidence: 'recorded-not-replayed',
    checkedAt: Date.now(), freshness, savedGeneratedAt: saved.generatedAt ?? null,
    note: 'A continuation may change the stored observation or budget. It is not counted as a solve under different frozen comparison inputs.', runs: rows };
}

/** Retain the previous evidence before replacing the latest report after a continuation. */
export function writeComparisonReport(file: string, report: unknown) {
  if (fs.existsSync(file)) {
    const previousText = readMathText(file), previous = JSON.parse(previousText) as Record<string, unknown>;
    const evidence = (value: unknown) => {
      const { generatedAt: _at, reportHash: _hash, ...body } = value as Record<string, unknown>;
      return canonicalMathJson(body);
    };
    if (evidence(previous) !== evidence(report)) {
      const history = `${file}.history`;
      fs.mkdirSync(history, { recursive: true, mode: 0o700 });
      const snapshot = path.join(history, `${mathDigest(previousText)}.json`);
      try { fs.writeFileSync(snapshot, previousText, { flag: 'wx', mode: 0o400 }); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST' || readMathText(snapshot) !== previousText) throw cause;
      }
    }
  }
  writeMathJsonDurable(file, report);
}

export async function compareMathRuns(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, ['phase', 'directory', 'repo', 'problem', 'task-file', 'build-manifest',
    'repetitions', 'model', 'effort', 'method', 'scheduler', 'workers', 'max-turns', 'max-run-seconds', 'max-turn-seconds',
    'max-total-tokens', 'evaluator-timeout-seconds', 'proof-environment-cache-dir', 'module-experiment', 'provider', 'dataset',
    'knowledge-base', 'knowledge-mode', 'skill-baseline', 'common-research-skill', 'source-file',
    'harness', 'harness-profile', 'harness-executable']);
  if (flags.has('help')) {
    console.log('Usage: theorem-os compare --phase prepare|run|report|check-report --directory DIR\n'
      + 'prepare also requires --problem ID --task-file FILE --build-manifest FILE\n'
      + '--dataset imo2026|putnambench requires --repo PINNED_REPO (default: imo2026).\n'
      + '--dataset lean-task requires --source-file FILE; freezes its bytes in the standard Lean environment.\n'
      + 'Optional: --repetitions 1 --workers 4 --model deepseek-flash --effort high --method direct --scheduler plan|critical-path|continuation\n'
      + `          --workers accepts 2..${MAX_RESEARCH_WORKERS}; default 4\n`
      + '          --max-turns 200 --max-run-seconds 1800 --max-turn-seconds 180 --max-total-tokens 0 --evaluator-timeout-seconds 1800\n'
      + '          --proof-environment-cache-dir HOST_PRIVATE_DIR\n'
      + '          --knowledge-base FILE [--knowledge-mode transfer|recovery] (frozen snapshot; default transfer rejects recorded target material)\n'
      + '          --skill-baseline native|file (replace the single arm with the pinned skill mode; requires scheduler plan and no module experiment)\n'
      + '          --common-research-skill native|file (all arms use one pinned skill and common mathematical guidance; implies the skill baseline)\n'
      + `          --module-experiment FILE (compare module plans with 3 to ${MAX_RESEARCH_WORKERS} cooperative workers instead of coordination arms)\n`
      + '          --provider profile|sub2api|deepseek|westlake (private per-attempt profiles; Sub2API deepseek-flash/high)\n'
      + '          --harness codex|claude-code|opencode|cli --harness-profile CONFIG_TEMPLATE --harness-executable COMMAND\n'
      + '          Explicit harnesses use a fresh configuration-only profile per attempt; sessions and credential stores are not copied. Supply --model and compatible Skill loading.\n'
      + 'prepare never invokes a model. run executes every planned attempt sequentially. Every arm receives the same token allowance.\n'
      + '--skill-baseline alone compares system modes with different guidance; --common-research-skill freezes guidance and compares host policies and protocols.\n'
      + 'Prepared identities alone are not provider execution evidence or evidence of a speedup.\n'
      + 'check-report reads a saved report and its current observations without rewriting files; older unbound reports have unknown freshness.\n'
      + 'Use 0 to disable a limit. All solving and evaluator limits may be zero for an unlimited experiment.\n'
      + '--max-turns caps dispatches. Token caps use provider reports, allow in-flight overrun, and do not guarantee equal cost.');
    return 0;
  }
  const phase = required(flags, 'phase');
  if (!['prepare', 'run', 'report', 'check-report'].includes(phase)) throw new Error('invalid --phase');
  const directory = path.resolve(required(flags, 'directory'));
  const planFile = path.join(directory, 'comparison.json');
  for (const name of ['harness', 'harness-profile', 'harness-executable']) if (phase !== 'prepare' && flags.has(name))
    throw new Error(`--${name} is frozen during prepare; run and report use comparison.json`);
  if (phase !== 'prepare' && flags.has('module-experiment'))
    throw new Error('--module-experiment is frozen during prepare; run and report use comparison.json');
  if (phase !== 'prepare' && flags.has('skill-baseline'))
    throw new Error('--skill-baseline is frozen during prepare; run and report use comparison.json');
  if (phase !== 'prepare' && flags.has('common-research-skill'))
    throw new Error('--common-research-skill is frozen during prepare; run and report use comparison.json');
  if (phase !== 'prepare' && flags.has('provider'))
    throw new Error('--provider is frozen during prepare; run and report use comparison.json');
  if (phase !== 'prepare' && flags.has('dataset'))
    throw new Error('--dataset is frozen during prepare; run and report use comparison.json');
  if (phase !== 'prepare' && flags.has('source-file'))
    throw new Error('--source-file is frozen during prepare; run and report use comparison.json');
  if (phase !== 'prepare' && flags.has('evaluator-timeout-seconds'))
    throw new Error('--evaluator-timeout-seconds is frozen during prepare; run and report use comparison.json');
  if (phase !== 'prepare' && (flags.has('knowledge-base') || flags.has('knowledge-mode')))
    throw new Error('--knowledge-base and --knowledge-mode are frozen during prepare; run and report use comparison.json');
  if (phase === 'prepare') {
    const knowledgeMode = experimentKnowledgeMode(flags);
    const number = (key: string, fallback: number, allowZero = false) => {
      const value = Number(flags.get(key) ?? fallback);
      if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`invalid --${key}`);
      return value;
    };
    const repetitions = number('repetitions', 1), workers = number('workers', 4);
    if (workers < 2 || workers > MAX_RESEARCH_WORKERS)
      throw new Error(`--workers must be an integer from 2 to ${MAX_RESEARCH_WORKERS}`);
    const method = flags.get('method') ?? 'direct', scheduler = flags.get('scheduler') ?? 'plan';
    if (method !== 'direct' || !['plan', 'critical-path', 'continuation'].includes(scheduler)) throw new Error('invalid method or scheduler');
    const commonLoading = flags.get('common-research-skill');
    if (commonLoading !== undefined && !['native', 'file'].includes(commonLoading)) throw new Error('invalid --common-research-skill');
    if (commonLoading && flags.has('skill-baseline') && flags.get('skill-baseline') !== commonLoading)
      throw new Error('--common-research-skill must match --skill-baseline');
    const skillLoading = flags.get('skill-baseline') ?? commonLoading;
    if (skillLoading !== undefined && !['native', 'file'].includes(skillLoading)) throw new Error('invalid --skill-baseline');
    if (skillLoading && (scheduler !== 'plan' || flags.has('module-experiment')))
      throw new Error('--skill-baseline requires --scheduler plan and no --module-experiment');
    const skillBaseline = skillLoading ? researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md'),
      skillLoading as 'native' | 'file')) : undefined;
    const experiment = flags.has('module-experiment')
      ? moduleExperimentSchema.parse(json(required(flags, 'module-experiment'))) : undefined;
    if (experiment && (scheduler !== 'plan' || workers < 3))
      throw new Error(`module experiments require --scheduler plan and 3 to ${MAX_RESEARCH_WORKERS} cooperative workers`);
    const variants = experiment ? describeModuleExperiment(experiment, workers) : undefined;
    const provider = flags.get('provider') ?? 'profile';
    if (provider !== 'profile' && !Object.hasOwn(providerProfiles, provider)) throw new Error('invalid --provider');
    const preparedProvider = provider === 'profile' ? undefined : provider as PreparedProvider;
    const profileApi = preparedProvider ? providerProfiles[preparedProvider] : undefined;
    const explicitHarness = ['harness', 'harness-profile', 'harness-executable'].some(name => flags.has(name));
    const selectedHarness = explicitHarness ? researchHarness(flags.get('harness') ?? 'codex') : undefined;
    if (selectedHarness && preparedProvider) throw new Error('comparison_harness_provider_conflict');
    if (selectedHarness && !flags.has('model')) throw new Error('--model is required for an explicit --harness');
    if (selectedHarness && !flags.has('harness-profile')) throw new Error('--harness-profile is required for an explicit --harness');
    if (selectedHarness && !selectedHarness.nativeSkills && skillBaseline?.loading === 'native')
      throw new Error('math_harness_native_skill_loading_unsupported');
    const commonProviderProfile = commonLoading && !profileApi && !selectedHarness ? currentProviderProfile() : undefined;
    const model = flags.get('model') ?? profileApi?.metadata.defaultModel ?? 'deepseek-flash';
    const effort = flags.get('effort') ?? profileApi?.metadata.defaultEffort ?? 'high';
    const template = selectedHarness ? fs.realpathSync(required(flags, 'harness-profile')) : undefined;
    const cli = selectedHarness?.id === 'cli' ? readCliConfiguration(template!) : undefined;
    if (cli && !cli.efforts.includes(effort)) throw new Error('math_cli_effort_unsupported');
    const agentHarness = selectedHarness ? bindResearchHarness(selectedHarness.id,
      flags.get('harness-executable') ?? cli?.executable ?? (selectedHarness.id === 'codex' ? 'codex' : selectedHarness.id === 'claude-code' ? 'claude' : 'opencode'),
      template!, process.env, model) : undefined;
    profileApi?.validate(model, effort);
    const configuration: Plan['configuration'] = { model, effort, method, scheduler,
      ...(preparedProvider ? { provider: preparedProvider } : {}),
      workers, repetitions, maxTurns: number('max-turns', 200, true), maxRunSeconds: number('max-run-seconds', 1800, true),
      maxTurnSeconds: number('max-turn-seconds', 180, true), maxTotalTokens: number('max-total-tokens', 0, true),
      evaluatorTimeoutSeconds: number('evaluator-timeout-seconds', 1800, true) };
    const problem = required(flags, 'problem');
    const dataset = flags.get('dataset') ?? 'imo2026';
    if (dataset !== 'imo2026' && dataset !== 'putnambench' && dataset !== 'lean-task') throw new Error('invalid --dataset');
    if (dataset !== 'lean-task' && flags.has('source-file')) throw new Error('--source-file requires --dataset lean-task');
    if (dataset === 'lean-task' && flags.has('repo')) throw new Error('--repo does not apply to --dataset lean-task');
    const repositoryRoot = dataset === 'lean-task' ? undefined : fs.realpathSync(required(flags, 'repo'));
    const source = dataset === 'lean-task' ? readMathText(required(flags, 'source-file'), LEAN_TASK_SOURCE_MAX_BYTES) : undefined;
    const leanEnvironment = source === undefined ? undefined : getLeanTaskEnvironment('standard');
    const putnam = dataset === 'putnambench' ? readPutnamBenchProblem(repositoryRoot!, problem) : undefined;
    if (dataset === 'imo2026' && !IMO2026_SUPPORTED_PROBLEMS.includes(problem as typeof IMO2026_SUPPORTED_PROBLEMS[number]))
      throw new Error('unsupported IMO problem');
    const putnamEnvironment = putnam ? getLeanTaskEnvironment('mathlib') : undefined;
    const build = fs.realpathSync(required(flags, 'build-manifest'));
    const proofCache = flags.has('proof-environment-cache-dir') ? path.resolve(required(flags, 'proof-environment-cache-dir')) : undefined;
    readMathBuildManifest(build, root, path.join(root, 'out/main'));
    const task = readMathText(required(flags, 'task-file'));
    if (!task.trim()) throw new Error('empty task');
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    const canonical = path.join(fs.realpathSync(path.dirname(directory)), path.basename(directory));
    for (const source of [root, ...(repositoryRoot ? [repositoryRoot] : [])]) if (canonical === source || canonical.startsWith(source + path.sep))
      throw new Error('comparison directory must be outside source checkouts');
    fs.mkdirSync(directory, { mode: 0o700 });
    const knowledge = flags.has('knowledge-base')
      ? freezeExperimentKnowledge(directory, required(flags, 'knowledge-base'), knowledgeMode) : undefined;
    assertExperimentKnowledge(directory, knowledge, problem, [problem]);
    const taskFile = path.join(directory, 'task.md');
    fs.writeFileSync(taskFile, task, { flag: 'wx', mode: 0o400 });
    if (source !== undefined) fs.writeFileSync(path.join(directory, 'source.lean'), source, { flag: 'wx', mode: 0o400 });
    const plan: Plan = { schema: 'deepscientist.math.comparison.v1', problem, dataset,
      sourceCommit: source !== undefined ? mathDigest(source) : putnam ? PUTNAM_BENCH_SOURCE_COMMIT : IMO2026_SOURCE_COMMIT,
      ...(source !== undefined ? { sourceCommitKind: 'input-sha256', leanTask: { sourceRelativePath: 'source.lean',
        sourceSha256: mathDigest(source), environment: 'standard', toolchain: leanEnvironment!.toolchain,
        environmentDigest: leanEnvironment!.dependencyDigest } } as const : {}),
      ...(putnam ? { sourceProblem: { repositoryUrl: PUTNAM_BENCH_REPOSITORY_URL,
        sourceRelativePath: putnam.sourceRelativePath, sourceSha256: putnam.sourceSha256,
        toolchain: putnamEnvironment!.toolchain, mathlibRevision: putnamEnvironment!.mathlibRevision!,
        environmentDigest: putnamEnvironment!.dependencyDigest } } : {}),
      taskDigest: mathDigest(task), buildDigest: mathDigest(fs.readFileSync(build)), environmentDigest: environmentDigest(), configuration,
      ...(knowledge ? { knowledge } : {}),
      ...(skillBaseline ? { skillBaseline } : {}),
      ...(commonLoading ? { commonResearchSkill: skillBaseline } : {}),
      ...(commonProviderProfile ? { commonProviderProfile } : {}),
      ...(agentHarness ? { agentHarness } : {}),
      ...(experiment ? { moduleExperiment: experiment } : {}), jobs: [] };
    for (const item of comparisonOrder(repetitions, variants?.map(variant => variant.id) ?? (skillBaseline ? skillArms : undefined))) {
      const jobRoot = path.join(directory, `${item.repetition}-${item.arm}`);
      fs.mkdirSync(jobRoot, { mode: 0o700 });
      const workspace = path.join(jobRoot, 'workspace'), output = path.join(jobRoot, 'result.json');
      if (source !== undefined) bootstrapLeanTask(workspace, { source, task, environment: 'standard' });
      else if (putnam) bootstrapPutnamBenchProblem({ repositoryRoot: repositoryRoot!, problemId: problem, workspaceRoot: workspace });
      else await bootstrapImo2026Problem({ repositoryRoot: repositoryRoot!, problemId: problem as typeof IMO2026_SUPPORTED_PROBLEMS[number], workspaceRoot: workspace });
      const receipt = readSolverProblem(workspace, path.join(workspace, 'active-problem.json'));
      if (knowledge && !plan.knowledgeTargetNames) {
        plan.knowledgeTargetNames = [...new Set([problem, ...(receipt.targets?.map(target => target.theoremName) ?? [])])];
        assertExperimentKnowledge(directory, knowledge, problem, plan.knowledgeTargetNames);
      }
      const variant = variants?.find(variant => variant.id === item.arm);
      const modulePlan = variant ? path.join(jobRoot, 'module-plan.json') : undefined;
      if (modulePlan) { writeNew(modulePlan, variant!.plan); fs.chmodSync(modulePlan, 0o400); }
      const codexProfile = profileApi ? path.join(jobRoot, 'codex') : undefined;
      const codexProfileDigest = codexProfile ? profileApi!.prepare(codexProfile, model, effort) : undefined;
      const jobHarness = agentHarness && projectResearchHarnessProfile(agentHarness, path.join(jobRoot, 'harness'), process.env, model);
      const coordination = experiment || item.arm === 'cooperative' ? 'cooperative' : 'independent';
      const researchSkill = item.arm === 'skill' ? skillBaseline : undefined;
      const launch = path.join(jobRoot, 'launch.json');
      writeNew(launch, { cwd: root, ...(codexProfile ? { codexHome: codexProfile }
        : commonProviderProfile ? { codexHome: commonProviderProfile.profile } : {}),
        ...(researchSkill ? { researchSkill } : {}),
        ...(plan.commonResearchSkill ? { commonResearchSkill: plan.commonResearchSkill } : {}),
        ...(process.env.DEEPSCIENTIST_MATH_ENV_FILE ? { envFile: path.resolve(process.env.DEEPSCIENTIST_MATH_ENV_FILE) } : {}),
        args: [process.execPath, path.join(root, 'bin/math.ts'), 'run', '--workspace', workspace, '--task-file', taskFile,
          '--output', output, '--build-manifest', build, '--model', configuration.model, '--effort', configuration.effort,
          ...(jobHarness ? ['--harness', jobHarness.id, '--harness-profile', jobHarness.profile, '--harness-executable', jobHarness.executable,
            ...(!researchSkill ? ['--research-mode', 'legacy'] : [])] : []),
          '--method', method, '--scheduler', scheduler, '--workers', String(!experiment && ['single', 'skill'].includes(item.arm) ? 1 : workers),
          '--coordination', coordination, ...(modulePlan ? ['--module-plan', modulePlan] : []),
          ...(researchSkill ? ['--research-mode', 'skill', '--skill-loading', researchSkill.loading] : []),
          ...(plan.commonResearchSkill ? ['--common-research-skill', plan.commonResearchSkill.loading] : []),
          '--max-turns', String(configuration.maxTurns), '--max-run-seconds', String(configuration.maxRunSeconds),
          '--max-turn-seconds', String(configuration.maxTurnSeconds), '--max-total-tokens', String(configuration.maxTotalTokens),
          '--evaluator-timeout-seconds', String(configuration.evaluatorTimeoutSeconds),
          ...(knowledge ? ['--knowledge-base', knowledge.file] : []),
          ...(proofCache ? ['--proof-environment-cache-dir', proofCache] : [])] });
      plan.jobs.push({ ...item, launch, launchDigest: mathDigest(fs.readFileSync(launch)), output, receiptDigest: receipt.receiptDigest,
        methodDigest: harnessMethodDigest(variant ? configurableSolverModules(variant.plan, coordination, workers)
          : configuredSolverModules(method, scheduler), coordination, jobHarness),
        ...(jobHarness ? { agentHarness: jobHarness } : {}),
        ...(modulePlan ? { modulePlan, modulePlanDigest: mathDigest(fs.readFileSync(modulePlan)) } : {}),
        ...(researchSkill ? { researchSkill } : {}),
        ...(plan.commonResearchSkill ? { commonResearchSkill: plan.commonResearchSkill } : {}),
        ...(codexProfile ? { codexProfile, codexProfileDigest } : {}) });
    }
    writeNew(planFile, plan);
    console.log(JSON.stringify({ planFile, jobs: plan.jobs.length, status: 'prepared', invokesModel: false }));
    return 0;
  }
  const plan = json(planFile) as Plan;
  if (plan.schema !== 'deepscientist.math.comparison.v1' || !Array.isArray(plan.jobs) || !plan.jobs.length)
    throw new Error('invalid comparison plan');
  assertDataset(plan);
  assertLeanTaskSnapshot(directory, plan);
  assertSkillBaseline(plan, phase === 'run');
  assertComparisonHarnesses(plan, phase === 'run');
  experimentDefinitions(plan);
  assertExperimentKnowledge(directory, plan.knowledge, plan.problem, plan.knowledgeTargetNames ?? [plan.problem]);
  if (phase === 'check-report') {
    const reportFile = path.join(directory, 'report.json');
    console.log(JSON.stringify({ reportFile, ...comparisonReportFreshness(directory, plan, json(reportFile)) }));
    return 0;
  }
  let code = 0;
  if (phase === 'run') {
    assertProviderProfiles(plan, true);
    if (environmentDigest() !== plan.environmentDigest) throw new Error('comparison_environment_changed');
    if (mathDigest(readMathText(path.join(directory, 'task.md'))) !== plan.taskDigest) throw new Error('comparison_task_changed');
    for (const job of plan.jobs) {
      if (mathDigest(fs.readFileSync(job.launch)) !== job.launchDigest) throw new Error('comparison_launch_changed');
      if (job.modulePlan && mathDigest(fs.readFileSync(job.modulePlan)) !== job.modulePlanDigest)
        throw new Error('comparison_module_plan_changed');
      if (plan.dataset === 'putnambench' || plan.dataset === 'lean-task') {
        const workspace = path.join(path.dirname(job.launch), 'workspace');
        const receipt = readSolverProblem(workspace, path.join(workspace, 'active-problem.json'));
        if (receipt.receiptDigest !== job.receiptDigest || receipt.kind !== 'lean-task' ||
            mathDigest(receipt.contract.formalStatement) !== (plan.leanTask?.sourceSha256 ?? plan.sourceProblem!.sourceSha256))
          throw new Error(plan.dataset === 'lean-task' ? 'comparison_lean_task_source_identity_mismatch'
            : 'comparison_putnam_source_identity_mismatch');
      }
    }
    code = await runMathBatch([...plan.jobs.flatMap(job => ['--launch', job.launch]), '--concurrency', '1', '--output', path.join(directory, 'batch.json')]);
  }
  const reportFile = path.join(directory, 'report.json');
  const report = comparisonReport(directory, plan);
  writeComparisonReport(reportFile, report);
  console.log(JSON.stringify({ reportFile, totals: report.totals }));
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  compareMathRuns(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  });
}
