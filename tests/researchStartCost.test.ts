import { describe, expect, it } from 'vitest';
import { estimateResearchCost, parseResearchRate } from '../apps/web/client/researchCostModel';

describe('upfront research cost planning', () => {
  it('keeps an unknown rate distinct from an explicitly free rate', () => {
    for (const input of ['', ' ', '-1', 'Infinity', 'not a rate', '1000001']) expect(parseResearchRate(input)).toBeUndefined();
    expect(parseResearchRate('0')).toBe(0);
    expect(parseResearchRate('0.25')).toBe(0.25);
  });
  it('estimates the statement and proof limits separately in the chosen currency', () => {
    expect(estimateResearchCost([{ kind: 'formalization', tokens: 60_000 }, { kind: 'proof', tokens: 200_000 }], { perMillion: 10, currency: 'USD' }))
      .toEqual({ currency: 'USD', items: [{ kind: 'formalization', tokens: 60_000, amount: 0.6 }, { kind: 'proof', tokens: 200_000, amount: 2 }], total: 2.6 });
    expect(estimateResearchCost([{ kind: 'proof', tokens: 500_000 }], { perMillion: 0, currency: 'CNY' })?.total).toBe(0);
  });
  it('does not display an amount for missing or invalid execution limits', () => {
    for (const tokens of [0, -1, 1.5, NaN, Infinity]) expect(estimateResearchCost([{ kind: 'proof', tokens }], { perMillion: 10, currency: 'CNY' })).toBeUndefined();
  });
});
