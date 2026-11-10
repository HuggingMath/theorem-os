import { describe, expect, it } from 'vitest';
import { firstResearchBudget, firstResearchRemaining } from '../apps/web/client/firstResearchModel';
import { webFormalizationDefaults } from '../apps/web/formalizationTypes';

describe('first research preparation', () => {
  it('fits both budget stages to this deployment, including whole minutes and turn caps', () => {
    const limits = { maxRunSeconds: 90, maxTotalTokens: 10_000, research: { maxRunSeconds: 150, maxTotalTokens: 20_000, maxTurns: 2 } };
    for (const preset of ['trial', 'standard'] as const) expect(firstResearchBudget(preset, limits)).toEqual({ maxRunSeconds: 60, maxTotalTokens: 10_000,
      research: { maxRunSeconds: 120, maxTotalTokens: 20_000, maxTurns: 2 } });
  });
  it('returns the normal service budgets without changing the frozen defaults', () => {
    expect(firstResearchBudget('standard', { maxRunSeconds: 1800, maxTotalTokens: 2_000_000,
      research: { maxRunSeconds: 900, maxTotalTokens: 2_000_000, maxTurns: 20 } })).toEqual(webFormalizationDefaults);
  });
  it('does not imply unlimited capacity when no quota exists, and clamps exhausted capacity to zero', () => {
    expect(firstResearchRemaining(undefined)).toBeUndefined();
    expect(firstResearchRemaining({ windowHours: 24, windowEndsAt: '2026-11-11T00:00:00.000Z',
      formalizations: { used: 2, limit: 5 }, runs: { used: 7, limit: 5 }, explanations: { used: 0, limit: 1 } })).toEqual({
      formalizations: 3, research: 0, endsAt: '2026-11-11T00:00:00.000Z' });
  });
});
