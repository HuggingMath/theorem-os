import { describe, expect, it } from 'vitest';
import { firstResearchBudget, firstResearchRemaining } from '../apps/web/client/firstResearchModel';
import { webFormalizationDefaults } from '../apps/web/formalizationTypes';

describe('first research preparation', () => {
  it('keeps time and tokens unlimited under small deployment caps while fitting turns', () => {
    const limits = { maxRunSeconds: 90, maxTotalTokens: 10_000, research: { maxRunSeconds: 150, maxTotalTokens: 20_000, maxTurns: 2 } };
    for (const preset of ['trial', 'standard'] as const) expect(firstResearchBudget(preset, limits)).toEqual({ maxRunSeconds: 0, maxTotalTokens: 0,
      research: { maxRunSeconds: 0, maxTotalTokens: 0, maxTurns: 2 } });
  });
  it.each([
    ['trial', 3],
    ['standard', 5],
  ] as const)('offers the %s preset with unlimited time and tokens and its existing turns', (preset, maxTurns) => {
    expect(firstResearchBudget(preset, { maxRunSeconds: 1800, maxTotalTokens: 2_000_000,
      research: { maxRunSeconds: 900, maxTotalTokens: 2_000_000, maxTurns: 20 } })).toEqual({ maxRunSeconds: 0, maxTotalTokens: 0,
      research: { maxRunSeconds: 0, maxTotalTokens: 0, maxTurns } });
    expect(webFormalizationDefaults).toMatchObject({ maxRunSeconds: 0, maxTotalTokens: 0, research: { maxRunSeconds: 0, maxTotalTokens: 0, maxTurns: 0 } });
  });
  it('does not imply unlimited capacity when no quota exists, and clamps exhausted capacity to zero', () => {
    expect(firstResearchRemaining(undefined)).toBeUndefined();
    expect(firstResearchRemaining({ windowHours: 24, windowEndsAt: '2026-11-11T00:00:00.000Z',
      formalizations: { used: 2, limit: 5 }, runs: { used: 7, limit: 5 }, explanations: { used: 0, limit: 1 } })).toEqual({
      formalizations: 3, research: 0, endsAt: '2026-11-11T00:00:00.000Z' });
  });
});
