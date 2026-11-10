import type { WebQuotaView } from '../shared';

export type FirstResearchBudget = { maxRunSeconds: number; maxTotalTokens: number;
  research: { maxRunSeconds: number; maxTotalTokens: number; maxTurns: number } };
export type FirstResearchPreset = 'trial' | 'standard';

/** Presets keep time and tokens unlimited; choosing one never starts work. */
export function firstResearchBudget(preset: FirstResearchPreset, limits: FirstResearchBudget): FirstResearchBudget {
  const maxTurns = preset === 'trial' ? 3 : 5;
  return { maxRunSeconds: 0, maxTotalTokens: 0,
    research: { maxRunSeconds: 0, maxTotalTokens: 0,
      maxTurns: Math.min(maxTurns, limits.research.maxTurns) } };
}

export function firstResearchRemaining(quota: WebQuotaView | undefined) {
  if (!quota) return undefined;
  return { formalizations: Math.max(0, quota.formalizations.limit - quota.formalizations.used),
    research: Math.max(0, quota.runs.limit - quota.runs.used), endsAt: quota.windowEndsAt };
}
