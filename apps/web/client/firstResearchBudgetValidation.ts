import type { FirstResearchBudget } from './firstResearchModel';

export type FirstResearchBudgetField = 'formalize-minutes' | 'formalize-tokens' | 'research-minutes' | 'research-tokens' | 'research-turns';
export type FirstResearchBudgetIssue = { field: FirstResearchBudgetField; kind: 'minutes' | 'tokens' | 'turns'; maximum: number };

/** Zero keeps the existing unlimited choice; positive limits must fit the same units and bounds used at submission. */
export function firstResearchBudgetIssues(value: FirstResearchBudget, limits: FirstResearchBudget): FirstResearchBudgetIssue[] {
  const fields = [
    { field: 'formalize-minutes', kind: 'minutes', value: value.maxRunSeconds, maximum: limits.maxRunSeconds },
    { field: 'formalize-tokens', kind: 'tokens', value: value.maxTotalTokens, maximum: limits.maxTotalTokens },
    { field: 'research-minutes', kind: 'minutes', value: value.research.maxRunSeconds, maximum: limits.research.maxRunSeconds },
    { field: 'research-tokens', kind: 'tokens', value: value.research.maxTotalTokens, maximum: limits.research.maxTotalTokens },
    { field: 'research-turns', kind: 'turns', value: value.research.maxTurns, maximum: limits.research.maxTurns },
  ] as const;
  return fields.filter(item => !Number.isSafeInteger(item.value) || item.value < 0
    || item.maximum > 0 && item.value > item.maximum
    || item.kind === 'minutes' && item.value % 60 !== 0
    || item.kind === 'tokens' && item.value > 0 && item.value < 10_000)
    .map(({ field, kind, maximum }) => ({ field, kind, maximum }));
}
