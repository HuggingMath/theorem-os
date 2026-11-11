import { describe, expect, it } from 'vitest';
import { firstResearchBudgetIssues } from '../apps/web/client/firstResearchBudgetValidation';
import type { FirstResearchBudget } from '../apps/web/client/firstResearchModel';

const limits: FirstResearchBudget = { maxRunSeconds: 1800, maxTotalTokens: 2_000_000,
  research: { maxRunSeconds: 900, maxTotalTokens: 100_000_000, maxTurns: 20 } };
const empty = (): FirstResearchBudget => ({ maxRunSeconds: 0, maxTotalTokens: 0,
  research: { maxRunSeconds: 0, maxTotalTokens: 0, maxTurns: 0 } });

describe('first research budget corrections', () => {
  it('keeps blank/unlimited and exact allowed boundaries valid', () => {
    expect(firstResearchBudgetIssues(empty(), limits)).toEqual([]);
    expect(firstResearchBudgetIssues(limits, limits)).toEqual([]);
    const value = empty(); value.maxTotalTokens = 10_000; value.research.maxTotalTokens = 10_000;
    value.maxRunSeconds = 60; value.research.maxRunSeconds = 60; value.research.maxTurns = 1;
    expect(firstResearchBudgetIssues(value, limits)).toEqual([]);
  });
  it('identifies both token fields and their actual bounds instead of a shared invalid flag', () => {
    const value = empty(); value.maxTotalTokens = 9999; value.research.maxTotalTokens = 100_000_001;
    expect(firstResearchBudgetIssues(value, limits)).toEqual([
      { field: 'formalize-tokens', kind: 'tokens', maximum: 2_000_000 },
      { field: 'research-tokens', kind: 'tokens', maximum: 100_000_000 },
    ]);
  });
  it('points fractional minutes, excessive proof time and invalid turns to separate controls', () => {
    const value = empty(); value.maxRunSeconds = 90; value.research.maxRunSeconds = 960; value.research.maxTurns = 1.5;
    expect(firstResearchBudgetIssues(value, limits).map(issue => issue.field)).toEqual(['formalize-minutes', 'research-minutes', 'research-turns']);
    value.maxRunSeconds = 1800; value.research.maxRunSeconds = 900; value.research.maxTurns = 20;
    expect(firstResearchBudgetIssues(value, limits)).toEqual([]);
  });
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects non-budget values (%s)', invalid => {
    const value = empty(); value.research.maxTotalTokens = invalid;
    expect(firstResearchBudgetIssues(value, limits).map(issue => issue.field)).toEqual(['research-tokens']);
  });
  it('treats a zero deployment cap as no maximum while retaining integer and minimum-token rules', () => {
    const uncapped = empty(), value = empty(); value.research.maxTotalTokens = 200_000_000; value.maxRunSeconds = 3600;
    expect(firstResearchBudgetIssues(value, uncapped)).toEqual([]);
    value.maxTotalTokens = 5000;
    expect(firstResearchBudgetIssues(value, uncapped)).toEqual([{ field: 'formalize-tokens', kind: 'tokens', maximum: 0 }]);
  });
});
