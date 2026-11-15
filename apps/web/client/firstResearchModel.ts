import type { WebQuotaView } from '../shared';

export type FirstResearchBudget = { maxRunSeconds: number; maxTotalTokens: number;
  research: { maxRunSeconds: number; maxTotalTokens: number; maxTurns: number } };
export function firstResearchRemaining(quota: WebQuotaView | undefined) {
  if (!quota) return undefined;
  return { formalizations: Math.max(0, quota.formalizations.limit - quota.formalizations.used),
    research: Math.max(0, quota.runs.limit - quota.runs.used), endsAt: quota.windowEndsAt };
}
