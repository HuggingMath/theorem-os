import type { WebEnvironment, WebFormalizationReport, WebProvider } from './shared';

// maxTotalTokens 0 sets no token budget: the time limit and rounds bound a generation.
export const webFormalizationLimits = Object.freeze({ maxOriginalBytes: 32_768, maxRunSeconds: 1800, maxTotalTokens: 0,
  maxRounds: 3, maxPlanningRounds: 2, reviewers: 2, concurrency: 1, queueLimit: 8, perOwner: 1, recordsPerOwner: 20 });
export const webFormalizationPhases = ['queued', 'preparing', 'planning', 'generating', 'compiling', 'translating', 'reviewing', 'finishing'] as const;
export type WebFormalizationProgress = { phase: typeof webFormalizationPhases[number]; round?: number; tokens?: number; updatedAt?: string };
export type WebFormalization = {
  id: string; original: string; environment: WebEnvironment; model: string; effort: 'low' | 'high' | 'max';
  status: 'queued' | 'running' | 'review' | 'confirmed' | 'exhausted' | 'cancelled' | 'error';
  createdAt: string; updatedAt: string; finishedAt?: string; confirmedAt?: string; reason?: string;
  progress?: WebFormalizationProgress; report?: WebFormalizationReport;
  /** Explicit authorization to formalize and then start proof research automatically. */
  workflow?: 'solve'; confirmation?: 'automatic' | 'manual'; runId?: string; researchError?: string;
};
export type WebFormalizationCapabilities = { available: boolean; reason?: 'provider' | 'runtime'; providerId?: string;
  model: string; key: 'required' | 'saved' | 'server'; limits: typeof webFormalizationLimits };
export type WebFormalizationRequest = { original: string; environment: WebEnvironment; apiKey: string; effort: 'low' | 'high' | 'max'; solve?: boolean };
export type WorkerFormalizationInput = Omit<WebFormalizationRequest, 'solve'> & { id: string; model: string; provider: WebProvider;
  maxRunSeconds: number; maxTotalTokens: number; maxRounds: number; maxPlanningRounds: number; reviewers: number };
export type WorkerFormalizationMessage = { type: 'progress'; progress: WebFormalizationProgress }
  | { type: 'result'; status: 'approved'; evidence: unknown }
  | { type: 'result'; status: 'exhausted' | 'error'; reason: string };
/** Generations before 2026-11-05 ran under a 200,000-token budget; their evidence stays valid. */
export const webFormalizationTokenBudgets: readonly number[] = [webFormalizationLimits.maxTotalTokens, 200_000];
export const webFormalizationReason = /^(?:formalization|math|lean_task)_[a-z0-9_]{1,100}$/u;
