import { reportedTotalTokens, type TokenBudget } from './usageBudget';

/** Limits are cumulative across every turn of the same task, including yields and resumes. */
export type AgentTeamAllowance = Readonly<{ tokens?: number; turns?: number }>;
export type AgentTeamBudgetTask = Readonly<{ id: string; budget?: AgentTeamAllowance; turns?: number }>;
export type AgentTeamBudgetInput = Readonly<{
  tokenBudget: TokenBudget;
  maxTurns: number;
  turns: number;
  leadReserve?: AgentTeamAllowance;
  task?: AgentTeamBudgetTask;
  taskUsage?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** A missing settled receipt is different from a request whose receipt is still pending. */
  taskUsageUnavailable?: boolean;
}>;

const remaining = (limit: number | undefined, used: number) =>
  limit === undefined || limit === Infinity ? null : Math.max(0, limit - used);

/**
 * Remaining tokens subtract reported consumption only. Pending provider requests cannot be
 * reserved in tokens before their receipts arrive, so these limits govern request admission,
 * not the size or final cost of an already admitted request.
 *
 * Null global remaining values denote an unlimited dimension; unknown task tokens also
 * remain null. Original receipt completeness stays visible instead of manufacturing usage.
 * With no finite host token or turn allowance, saved local caps and reserves stay historical.
 */
export function projectAgentTeamBudget(input: AgentTeamBudgetInput) {
  const allocationEnabled = input.tokenBudget.maxTotalTokens > 0 || Number.isFinite(input.maxTurns);
  const taskBudget = allocationEnabled ? input.task?.budget : undefined;
  const leadReserve = { tokens: allocationEnabled ? input.leadReserve?.tokens ?? 0 : 0,
    turns: allocationEnabled ? input.leadReserve?.turns ?? 0 : 0 };
  const totalRemaining = {
    tokens: remaining(input.tokenBudget.maxTotalTokens || undefined, input.tokenBudget.reportedTotalTokens ?? 0),
    turns: remaining(input.maxTurns, input.turns),
  };
  const taskUsage = input.task ? input.taskUsage?.[input.task.id] : undefined;
  const taskTokens = taskUsage === undefined ? 0 : reportedTotalTokens(taskUsage);
  const taskTurns = input.task?.turns ?? 0;
  return {
    enforcement: 'provider-observed-request-admission' as const,
    tokenBudget: { ...input.tokenBudget }, maxTurns: Number.isFinite(input.maxTurns) ? input.maxTurns : null, turns: input.turns,
    reportedTotalTokens: input.tokenBudget.reportedTotalTokens,
    usageComplete: input.tokenBudget.usageComplete,
    leadReserve,
    remaining: totalRemaining,
    childRemaining: {
      tokens: totalRemaining.tokens === null ? null : Math.max(0, totalRemaining.tokens - leadReserve.tokens),
      turns: totalRemaining.turns === null ? null : Math.max(0, totalRemaining.turns - leadReserve.turns),
    },
    ...(input.task ? { task: {
      id: input.task.id,
      budget: { ...taskBudget },
      used: { tokens: taskTokens, turns: taskTurns },
      usageUnavailable: Boolean(input.taskUsageUnavailable || taskTokens === null),
      remaining: {
        tokens: taskBudget?.tokens === undefined ? null : taskTokens === null
          ? null : remaining(taskBudget.tokens, taskTokens),
        turns: remaining(taskBudget?.turns, taskTurns),
      },
    } } : {}),
  };
}
