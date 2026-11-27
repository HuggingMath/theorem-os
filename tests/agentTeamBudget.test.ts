import { describe, expect, it } from 'vitest';
import { projectAgentTeamBudget, type AgentTeamBudgetInput } from '../src/solver/agentTeamBudget';
import { attributeTaskUsage, beginRequestUsage, buildTokenBudget, initializeRequestUsageAccounting,
  type RequestUsageAccounting } from '../src/solver/usageBudget';

function observedBudget(tokens: number, limit = 1000) {
  return buildTokenBudget(limit, [{ turns: 1, usage: { totalTokens: tokens },
    usageAccounting: { startedTurns: 1, reportedTurns: 1, pending: false, incomplete: false } }]);
}

function input(overrides: Partial<AgentTeamBudgetInput> = {}): AgentTeamBudgetInput {
  return { tokenBudget: observedBudget(100), maxTurns: 10, turns: 2,
    leadReserve: { tokens: 100, turns: 1 }, task: { id: 'helper', budget: { tokens: 200, turns: 3 }, turns: 1 },
    taskUsage: { helper: { totalTokens: 50 } }, ...overrides };
}

describe('Agent team historical budget inspection', () => {
  it('subtracts Lead reserves from the observed global remainder without charging them as consumption', () => {
    const source = input(), before = JSON.stringify(source);
    expect(projectAgentTeamBudget(source)).toMatchObject({
      enforcement: 'provider-observed-request-admission', tokenBudget: source.tokenBudget, maxTurns: 10, turns: 2,
      reportedTotalTokens: 100, usageComplete: true, leadReserve: { tokens: 100, turns: 1 },
      remaining: { tokens: 900, turns: 8 }, childRemaining: { tokens: 800, turns: 7 },
      task: { id: 'helper', budget: { tokens: 200, turns: 3 }, used: { tokens: 50, turns: 1 },
        remaining: { tokens: 150, turns: 2 } },
    });
    expect(JSON.stringify(source)).toBe(before);
  });

  it('retains one task allowance and its real receipt usage across yield, save and resume', () => {
    const research = { turns: 0, usage: undefined as Record<string, unknown> | undefined,
      requestUsageAccounting: undefined as RequestUsageAccounting | undefined };
    initializeRequestUsageAccounting(research);
    const state: { taskUsage?: Record<string, Record<string, number>> } = {};
    const task = { id: 'helper', budget: { tokens: 70, turns: 2 }, turns: 0 };
    for (const [index, totalTokens] of [30, 40].entries()) {
      task.turns++;
      const before = research.usage;
      const settle = beginRequestUsage(research, { requestId: 'request-' + index, taskId: task.id });
      settle({ complete: true, outcome: 'completed', usage: { inputTokens: totalTokens - 5, outputTokens: 5, totalTokens } });
      attributeTaskUsage(state, task.id, before, research.usage);
    }
    const restored: AgentTeamBudgetInput = JSON.parse(JSON.stringify(input({ task, taskUsage: state.taskUsage })));
    expect(projectAgentTeamBudget(restored).task).toMatchObject({ used: { tokens: 70, turns: 2 }, remaining: { tokens: 0, turns: 0 } });
    expect(research.requestUsageAccounting!.receipts!.map(receipt => receipt.status)).toEqual(['reported', 'reported']);
    expect(state.taskUsage).toEqual({ helper: { inputTokens: 60, outputTokens: 10, totalTokens: 70 } });
  });

  it('uses total input plus output tokens once, excluding cached and reasoning subsets', () => {
    const source = input({ task: { id: 'helper', budget: { tokens: 100 }, turns: 1 },
      taskUsage: { helper: { inputTokens: 80, outputTokens: 20, cachedInputTokens: 60, reasoningOutputTokens: 15 } } });
    expect(projectAgentTeamBudget(source).task!.used.tokens).toBe(100);
    expect(projectAgentTeamBudget({ ...source, taskUsage: { helper: { totalTokens: 90, inputTokens: 80, outputTokens: 20 } } })
      .task!.used.tokens).toBe(90);
  });

  it('allows pending receipts but preserves missing settled usage when the global run is unlimited', () => {
    const research = { turns: 0, requestUsageAccounting: undefined as RequestUsageAccounting | undefined };
    initializeRequestUsageAccounting(research);
    const settle = beginRequestUsage(research, { requestId: 'still-pending', taskId: 'helper' });
    const pending = input({ tokenBudget: buildTokenBudget(0, [research]),
      task: { id: 'helper', budget: { tokens: 50 }, turns: 1 }, taskUsage: {} });
    expect(pending.tokenBudget.usageComplete).toBe(false);
    settle({ complete: false, outcome: 'interrupted', missingReason: 'resumed-without-receipt' });
    const missing = { ...pending, tokenBudget: buildTokenBudget(0, [research]), taskUsageUnavailable: true };
    expect(missing.tokenBudget.status).toBe('unlimited');
    expect(projectAgentTeamBudget(missing).task!.usageUnavailable).toBe(true);
    expect(research.requestUsageAccounting!.receipts).toHaveLength(1);
    expect(research.requestUsageAccounting!.receipts![0]!.status).toBe('missing');
  });

  it('keeps malformed or incomplete task token totals unknown instead of resetting the task allowance', () => {
    const source = input({ taskUsage: { helper: { inputTokens: 20 } } });
    expect(projectAgentTeamBudget(source).task).toMatchObject({ used: { tokens: null }, remaining: { tokens: null }, usageUnavailable: true });
  });

  it('keeps saved local caps and reserves inactive when the run allowance is unlimited', () => {
    const source = input({ tokenBudget: observedBudget(5000, 0), maxTurns: Infinity,
      leadReserve: { tokens: 1000, turns: 5 }, task: { id: 'helper', turns: 500, budget: { tokens: 1, turns: 1 } },
      taskUsage: { helper: { totalTokens: 5000 } }, taskUsageUnavailable: true });
    expect(projectAgentTeamBudget(source)).toMatchObject({ maxTurns: null, remaining: { tokens: null, turns: null },
      leadReserve: { tokens: 0, turns: 0 }, childRemaining: { tokens: null, turns: null },
      task: { budget: {}, remaining: { tokens: null, turns: null } } });
  });
});
