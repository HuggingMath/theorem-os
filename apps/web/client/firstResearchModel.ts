import type { WebQuotaView } from '../shared';

export type FirstResearchBudget = { maxRunSeconds: number; maxTotalTokens: number;
  research: { maxRunSeconds: number; maxTotalTokens: number; maxTurns: number } };
export type FirstResearchPreset = 'trial' | 'standard';

/** Presets keep tokens unlimited and fit deployment time/turn limits; choosing one never starts work. */
export function firstResearchBudget(preset: FirstResearchPreset, limits: FirstResearchBudget): FirstResearchBudget {
  const wanted = preset === 'trial'
    ? { maxRunSeconds: 120, research: { maxRunSeconds: 120, maxTurns: 3 } }
    : { maxRunSeconds: 600, research: { maxRunSeconds: 300, maxTurns: 5 } };
  const minutes = (wanted: number, cap: number) => Math.max(60, Math.min(wanted, Math.floor(cap / 60) * 60));
  return { maxRunSeconds: minutes(wanted.maxRunSeconds, limits.maxRunSeconds), maxTotalTokens: 0,
    research: { maxRunSeconds: minutes(wanted.research.maxRunSeconds, limits.research.maxRunSeconds),
      maxTotalTokens: 0,
      maxTurns: Math.min(wanted.research.maxTurns, limits.research.maxTurns) } };
}

export function firstResearchRemaining(quota: WebQuotaView | undefined) {
  if (!quota) return undefined;
  return { formalizations: Math.max(0, quota.formalizations.limit - quota.formalizations.used),
    research: Math.max(0, quota.runs.limit - quota.runs.used), endsAt: quota.windowEndsAt };
}
