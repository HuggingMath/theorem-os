import { describe, expect, it } from 'vitest';
import { firstResearchRemaining } from '../apps/web/client/firstResearchModel';
import { webFormalizationDefaults } from '../apps/web/formalizationTypes';

describe('first research preparation', () => {
  it('starts every new workbench solve with no budget limit', () => {
    expect(webFormalizationDefaults).toEqual({ maxRunSeconds: 0, maxTotalTokens: 0,
      research: { maxRunSeconds: 0, maxTotalTokens: 0, maxTurns: 0 } });
  });
  it('does not imply unlimited capacity when no quota exists, and clamps exhausted capacity to zero', () => {
    expect(firstResearchRemaining(undefined)).toBeUndefined();
    expect(firstResearchRemaining({ windowHours: 24, windowEndsAt: '2026-11-11T00:00:00.000Z',
      formalizations: { used: 2, limit: 5 }, runs: { used: 7, limit: 5 }, explanations: { used: 0, limit: 1 } })).toEqual({
      formalizations: 3, research: 0, endsAt: '2026-11-11T00:00:00.000Z' });
  });
});
