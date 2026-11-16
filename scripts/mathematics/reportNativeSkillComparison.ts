#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, required } from './arguments';
import { nativeComparisonAccepted, readNativeSkillJob } from './nativeSkillComparison';
import { canonicalMathJson, mathDigest, readMathJson } from '../../src/math/mathRuntimeIo';
import { readRunInspection } from '../../src/solver/inspection';
import { solverProofIsCurrent, type ProofCheck } from '../../src/solver/modules/evidence';
import { buildTokenBudget } from '../../src/solver/usageBudget';

/** Stored observations only: retain both planned rows, including missing results and unknown cost. */
export function reportNativeSkillComparison(directory: string) {
  const file = path.join(path.resolve(directory), 'comparison.json');
  const plan = readMathJson(file) as { schema: string; jobs: { arm: string; contract: string; contractDigest: string;
    launchDigest: string; workspace: string; output: string }[] };
  if (plan.schema !== 'theorem-os.native-skill-comparison.v1' || plan.jobs.length !== 2 ||
      new Set(plan.jobs.map(job => job.arm)).size !== 2) throw new Error('native_comparison_plan_invalid');
  const comparisonDigest = mathDigest(fs.readFileSync(file));
  const rows = (['native-skill', 'runtime-skill'] as const).map(arm => {
    const planned = plan.jobs.find(job => job.arm === arm);
    const row = { arm, output: planned?.output ?? null, outcome: 'not-started', mathematicallyAccepted: null as boolean | null,
      totalTokens: null as number | null, wallMs: null as number | null, turns: null as number | null,
      frozenInputsValid: false, outcomeComparable: false, costComparable: false, error: undefined as string | undefined };
    try {
      if (!planned) throw new Error('native_comparison_plan_invalid');
      const { job, problem, launchDigest } = readNativeSkillJob(planned.contract, planned.contractDigest, planned.workspace, planned.output, 'report');
      row.frozenInputsValid = true;
      const invocationFile = `${job.output}.comparison.json`;
      if (!fs.existsSync(invocationFile)) {
        if (fs.existsSync(job.output)) throw new Error('native_comparison_invocation_missing');
        readNativeSkillJob(planned.contract, planned.contractDigest, planned.workspace, planned.output);
        return row;
      }
      const invocation = readMathJson(invocationFile) as Record<string, unknown>;
      if (invocation.schema !== 'theorem-os.native-skill-invocation.v1' || invocation.arm !== arm ||
          invocation.contractDigest !== planned.contractDigest || invocation.launchDigest !== launchDigest ||
          invocation.comparisonDigest !== comparisonDigest) throw new Error('native_comparison_invocation_changed');
      row.outcome = String(invocation.status);
      if (typeof invocation.finishedAt === 'number' && typeof invocation.startedAt === 'number') row.wallMs = invocation.finishedAt - invocation.startedAt;
      if (!fs.existsSync(job.output)) { row.error = typeof invocation.error === 'string' ? invocation.error : undefined; return row; }
      if (invocation.status !== 'finished' || invocation.resultDigest !== mathDigest(fs.readFileSync(job.output)) ||
          invocation.stateDigest !== mathDigest(fs.readFileSync(`${job.output}.runtime/state.json`)))
        throw new Error('native_comparison_observation_changed');
      const result = readMathJson(job.output) as Record<string, any>;
      let check: ProofCheck | undefined, worktree: string, records: Parameters<typeof buildTokenBudget>[1];
      let writerStopped: boolean;
      if (arm === 'native-skill') {
        if (result.schema !== 'theorem-os.native-skill-result.v1' || result.arm !== arm || result.contractDigest !== planned.contractDigest)
          throw new Error('native_comparison_result_changed');
        check = result.check; worktree = `${job.output}.runtime/worktree`; records = [result as any]; writerStopped = result.writerStopped === true;
        row.turns = result.turns;
      } else {
        const { state } = readRunInspection(job.output);
        if (state.problem.receiptDigest !== problem.receiptDigest || state.taskDigest !== job.taskDigest || state.buildDigest !== job.buildDigest ||
            state.environmentDigest !== job.environmentDigest || state.model !== job.model || state.effort !== job.effort ||
            state.providerProfileDigest !== job.providerProfileDigest || state.researchMode !== 'skill' || state.workerCount !== 1 ||
            canonicalMathJson(state.agentHarness) !== canonicalMathJson(job.harness) ||
            canonicalMathJson(state.researchSkill) !== canonicalMathJson(job.skill) || canonicalMathJson(state.commonResearchSkill) !== canonicalMathJson(job.skill) ||
            state.tokenBudget?.maxTotalTokens !== job.maxTotalTokens) throw new Error('native_comparison_runtime_identity_changed');
        check = state.check; worktree = state.worktree; records = state.workers ?? [state];
        writerStopped = !state.writerStopUnconfirmed; row.turns = records.reduce((sum, record) => sum + record.turns, 0);
      }
      const accepted = writerStopped && nativeComparisonAccepted(problem, check, result.evaluator);
      if (accepted && (!solverProofIsCurrent(problem, worktree, check!) || !solverProofIsCurrent(problem, problem.workspace, check!)))
        throw new Error('native_comparison_proof_changed');
      row.outcome = String(result.status); row.mathematicallyAccepted = accepted; row.outcomeComparable = true;
      row.error = typeof result.error === 'string' ? result.error : typeof result.reason === 'string' ? result.reason : undefined;
      const budget = buildTokenBudget(job.maxTotalTokens, records, job.enforcement);
      row.costComparable = budget.usageComplete && records.some(record => (record.requestUsageAccounting?.startedRequests ?? 0) > 0);
      row.totalTokens = row.costComparable ? budget.reportedTotalTokens : null;
    } catch (cause) {
      row.outcome = 'invalid'; row.outcomeComparable = false; row.costComparable = false; row.mathematicallyAccepted = null; row.totalTokens = null;
      row.error = cause instanceof Error && /^(?:math_|native_comparison_)/u.test(cause.message) ? cause.message : 'native_comparison_observation_unavailable';
    }
    return row;
  });
  return { schema: 'theorem-os.native-skill-report.v1', comparisonDigest, plannedArms: 2, modelBenefitMeasured: false, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const flags = parseFlags(process.argv.slice(2), ['directory']); console.log(JSON.stringify(reportNativeSkillComparison(required(flags, 'directory')), null, 2)); }
  catch (cause) { console.error(cause instanceof Error ? cause.message : 'native_comparison_report_failed'); process.exitCode = 1; }
}
