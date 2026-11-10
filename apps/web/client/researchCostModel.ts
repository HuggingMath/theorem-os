import type { ResearchTokenRate } from '../researchWorkspaceTypes';

export type ResearchCostStage = { kind: 'formalization' | 'proof'; tokens: number };
export function parseResearchRate(value: string): number | undefined {
  if (!value.trim()) return;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1_000_000 ? rate : undefined;
}
/** A planning estimate at the configured token limits; never a provider billing cap. */
export function estimateResearchCost(stages: readonly ResearchCostStage[], rate: Pick<ResearchTokenRate, 'currency' | 'perMillion'>) {
  if (!Number.isFinite(rate.perMillion) || rate.perMillion < 0 || stages.some(stage => !Number.isSafeInteger(stage.tokens) || stage.tokens <= 0)) return;
  const items = stages.map(stage => ({ ...stage, amount: stage.tokens / 1_000_000 * rate.perMillion }));
  return { currency: rate.currency, items, total: items.reduce((sum, item) => sum + item.amount, 0) };
}
