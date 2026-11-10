import type { WebQuotaView } from '../shared';

export type FirstResearchBudget = { maxRunSeconds: number; maxTotalTokens: number;
  research: { maxRunSeconds: number; maxTotalTokens: number; maxTurns: number } };
export type FirstResearchPreset = 'trial' | 'standard';

/** Presets fit the limits this deployment reports; choosing one never starts work. */
export function firstResearchBudget(preset: FirstResearchPreset, limits: FirstResearchBudget): FirstResearchBudget {
  const wanted = preset === 'trial'
    ? { maxRunSeconds: 120, maxTotalTokens: 60_000, research: { maxRunSeconds: 120, maxTotalTokens: 60_000, maxTurns: 3 } }
    : { maxRunSeconds: 600, maxTotalTokens: 400_000, research: { maxRunSeconds: 300, maxTotalTokens: 200_000, maxTurns: 5 } };
  const minutes = (wanted: number, cap: number) => Math.max(60, Math.min(wanted, Math.floor(cap / 60) * 60));
  return { maxRunSeconds: minutes(wanted.maxRunSeconds, limits.maxRunSeconds), maxTotalTokens: Math.min(wanted.maxTotalTokens, limits.maxTotalTokens),
    research: { maxRunSeconds: minutes(wanted.research.maxRunSeconds, limits.research.maxRunSeconds),
      maxTotalTokens: Math.min(wanted.research.maxTotalTokens, limits.research.maxTotalTokens),
      maxTurns: Math.min(wanted.research.maxTurns, limits.research.maxTurns) } };
}

export function firstResearchRemaining(quota: WebQuotaView | undefined) {
  if (!quota) return undefined;
  return { formalizations: Math.max(0, quota.formalizations.limit - quota.formalizations.used),
    research: Math.max(0, quota.runs.limit - quota.runs.used), endsAt: quota.windowEndsAt };
}
