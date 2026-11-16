import { modelDispatchAllowed, reportedTotalTokens, type TokenBudget } from './usageBudget';

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

export type AgentTeamBudgetStopReason = 'math_total_token_limit' | 'math_model_usage_unavailable' |
  'math_team_total_turn_limit' | 'math_team_lead_token_reserve' | 'math_team_lead_turn_reserve' |
  'math_team_task_token_limit' | 'math_team_task_turn_limit';
export type AgentTeamChildAdmission = Readonly<{ allowed: true }> |
  Readonly<{ allowed: false; reason: AgentTeamBudgetStopReason }>;

const remaining = (limit: number | undefined, used: number) =>
  limit === undefined || limit === Infinity ? null : Math.max(0, limit - used);

/**
 * Remaining tokens subtract reported consumption only. Pending provider requests cannot be
 * reserved in tokens before their receipts arrive, so these limits govern request admission,
 * not the size or final cost of an already admitted request.
 *
 * Null global remaining values denote an unlimited dimension; unknown task tokens also
 * remain null. Original receipt completeness stays visible instead of manufacturing usage.
 */
export function projectAgentTeamBudget(input: AgentTeamBudgetInput) {
  const leadReserve = { tokens: input.leadReserve?.tokens ?? 0, turns: input.leadReserve?.turns ?? 0 };
  const totalRemaining = {
    tokens: remaining(input.tokenBudget.maxTotalTokens || undefined, input.tokenBudget.reportedTotalTokens ?? 0),
    turns: remaining(input.maxTurns, input.turns),
  };
  const taskUsage = input.task ? input.taskUsage?.[input.task.id] : undefined;
  const taskTokens = taskUsage === undefined ? 0 : reportedTotalTokens(taskUsage);
  const taskTurns = input.task?.turns ?? 0;
  return {
    enforcement: 'provider-observed-request-admission' as const,
    tokenBudget: { ...input.tokenBudget }, maxTurns: input.maxTurns, turns: input.turns,
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
      budget: { ...input.task.budget },
      used: { tokens: taskTokens, turns: taskTurns },
      usageUnavailable: Boolean(input.taskUsageUnavailable || taskTokens === null),
      remaining: {
        tokens: input.task.budget?.tokens === undefined ? null : taskTokens === null
          ? null : remaining(input.task.budget.tokens, taskTokens),
        turns: remaining(input.task.budget?.turns, taskTurns),
      },
    } } : {}),
  };
}

/**
 * Call with "turn" before reserving a new child turn and with "request" before each
 * upstream request. The current turn has already consumed its turn allowance at request
 * admission; reaching that turn cap must not prevent the turn's own requests from running.
 * This helper applies only to children. Lead uses the ordinary global allowance.
 */
export function agentTeamChildAdmission(input: AgentTeamBudgetInput,
  stage: 'turn' | 'request' = 'turn'): AgentTeamChildAdmission {
  if (!modelDispatchAllowed(input.tokenBudget)) return { allowed: false,
    reason: input.tokenBudget.status === 'usage-unavailable' ? 'math_model_usage_unavailable' : 'math_total_token_limit' };
  const projection = projectAgentTeamBudget(input);
  const task = projection.task;
  if (stage === 'turn' && projection.remaining.turns !== null && projection.remaining.turns <= 0)
    return { allowed: false, reason: 'math_team_total_turn_limit' };
  if (input.task?.budget?.tokens !== undefined &&
      task?.usageUnavailable)
    return { allowed: false, reason: 'math_model_usage_unavailable' };
  if (task && task.remaining.tokens !== null && task.remaining.tokens <= 0)
    return { allowed: false, reason: 'math_team_task_token_limit' };
  if (projection.childRemaining.tokens !== null && projection.childRemaining.tokens <= 0)
    return { allowed: false, reason: 'math_team_lead_token_reserve' };
  if (stage === 'turn') {
    if (task && task.remaining.turns !== null && task.remaining.turns <= 0)
      return { allowed: false, reason: 'math_team_task_turn_limit' };
    if (projection.childRemaining.turns !== null && projection.childRemaining.turns <= 0)
      return { allowed: false, reason: 'math_team_lead_turn_reserve' };
  }
  return { allowed: true };
}
