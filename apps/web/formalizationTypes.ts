import { webAgentActionLimits, type WebAgentActionBody, type WebAgentLeanCheck, type WebEnvironment, type WebFormalizationReport, type WebProvider, type WebWorkerProvider } from './shared';
import type { LeanStatementContextProtocol } from '../../src/math/leanStatementSemantic';
import type { FormalizationAuditResult } from '../../src/math/formalizationAuditProtocol';

export const webFormalizationLimits = Object.freeze({ maxOriginalBytes: 32_768, maxRunSeconds: 1800, maxTotalTokens: 2_000_000,
  maxRounds: 3, maxPlanningRounds: 2, reviewers: 2, concurrency: 1, queueLimit: 8, perOwner: 2, recordsPerOwner: 20 });
/** Each 0 means unlimited. Execution time includes planning/revisions and excludes human approval waits. */
export type WebResearchBudget = { maxRunSeconds: number; maxTurns: number; maxTotalTokens: number };
export const webFormalizationDefaults = Object.freeze({ maxRunSeconds: 0, maxTotalTokens: 0,
  research: Object.freeze({ maxRunSeconds: 0, maxTurns: 0, maxTotalTokens: 0 }) });
export const webFormalizationPhases = ['queued', 'preparing', 'planning', 'generating', 'compiling', 'translating', 'reviewing', 'finishing'] as const;
export type WebFormalizationProgress = { phase: typeof webFormalizationPhases[number]; round?: number; tokens?: number; updatedAt?: string };
export type WebFormalizationBackgroundReview = {
  status: 'queued' | 'running' | 'approved' | 'changes_requested' | 'unknown' | 'error' | 'cancelled' | 'interrupted';
  evidenceSha256: string; sourceSha256: string; queuedAt: string; startedAt?: string; finishedAt?: string;
  tokens?: number; reason?: string; result?: FormalizationAuditResult;
};
export type WebFormalization = {
  id: string; original: string; environment: WebEnvironment; model: string; effort: 'low' | 'high' | 'max';
  status: 'queued' | 'running' | 'review' | 'confirmed' | 'exhausted' | 'cancelled' | 'error';
  createdAt: string; updatedAt: string; finishedAt?: string; confirmedAt?: string; reason?: string;
  progress?: WebFormalizationProgress; report?: WebFormalizationReport;
  /** Live waiting position, projected on reads; never persisted as execution authority. */
  queue?: { position: number; ahead: number; running: number; slots: number };
  compiled?: { digest: string; source: string; sourceSha256: string; round: number };
  /** How many process records are stored (read them from /activity) and how many arrived past the limit. */
  activity?: { count: number; dropped?: number };
  /** Authorizes proof research after formalization, with an optional manual statement and plan review. */
  workflow?: 'solve'; humanReview?: boolean; confirmation?: 'automatic' | 'manual'; runId?: string; researchError?: string;
  /** Absent on older records; new generations bind the exact submitted budgets and provider. */
  providerId?: string; maxRunSeconds?: number; maxTotalTokens?: number; maxRounds?: number; maxPlanningRounds?: number; research?: WebResearchBudget;
  /** Frozen proof effort; older records inherit their formalization effort. */
  researchEffort?: 'low' | 'high' | 'max';
  autoExplain?: boolean;
  explanationLanguage?: 'zh' | 'en';
  /** Absent on legacy kernel-v2 records; new generations freeze their context export protocol. */
  contextProtocol?: LeanStatementContextProtocol;
  /** Frozen on new direct generations; absent on independently reviewed legacy records. */
  reviewMode?: 'direct';
  /** Advisory review of the frozen compiled statement; never gates confirmation or proof research. */
  backgroundReview?: WebFormalizationBackgroundReview;
};
export type WebFormalizationCapabilities = { available: boolean; reason?: 'provider' | 'runtime'; providerId?: string;
  model: string; key: 'required' | 'saved' | 'server'; limits: typeof webFormalizationLimits;
  providers?: (WebProvider & { defaultModel: string; key: 'required' | 'saved' | 'server'; keyUrl?: string })[];
  defaults?: typeof webFormalizationDefaults };
export type WebFormalizationRequest = { original: string; environment: WebEnvironment; apiKey: string; effort: 'low' | 'high' | 'max'; solve?: boolean; humanReview?: boolean;
  autoExplain?: boolean; explanationLanguage?: 'zh' | 'en';
  requestId?: string; providerId?: string; model?: string; researchEffort?: 'low' | 'high' | 'max'; maxRunSeconds?: number; maxTotalTokens?: number; research?: Partial<WebResearchBudget> };
export type WorkerFormalizationInput = Omit<WebFormalizationRequest, 'solve' | 'humanReview' | 'requestId' | 'providerId' | 'research' | 'researchEffort' | 'autoExplain' | 'explanationLanguage'> & { id: string; model: string; provider: WebWorkerProvider;
  maxRunSeconds: number; maxTotalTokens: number; maxRounds: number; maxPlanningRounds: number; reviewers: number;
  contextProtocol?: LeanStatementContextProtocol; reviewMode?: 'direct'; outputDelivery?: 'native-schema' | 'file' };
export type WorkerFormalizationAuditMessage = { type: 'audit-progress'; tokens: number }
  | { type: 'audit-result'; result: FormalizationAuditResult }
  | { type: 'audit-error'; reason: string };
/**
 * The roles of one formalization round (src/solver/formalization.ts): plan reads the problem, generate writes the Lean
 * statement, the host compiles it, backtranslate reads it back blind, and each reviewer compares (compare); refute is an
 * optional falsifier.
 */
export const webFormalizationRoles = ['plan', 'generate', 'backtranslate', 'compare', 'refute'] as const;
export type WebFormalizationRole = typeof webFormalizationRoles[number];
/**
 * What a role handed in, cut to what a reader checks: a review's verdict and the discrepancies it named, a plan's
 * conclusions and open questions, a back-translation's reading. Model-written text, masked like Agent actions.
 */
export type WebFormalizationRoleSummary = {
  verdict?: 'approved' | 'changes_requested' | 'unknown'; taskKind?: string; text?: string;
  sections: { kind: 'conclusions' | 'assumptions' | 'definitions' | 'unresolved' | 'targets' | 'issues'; items: string[]; omitted?: number }[];
};
/**
 * One step of a formalization as its owner may see it. `workerId` names the role's lane (`r1-plan-1`, `r2-compare-reviewer-1`);
 * compile steps carry the erased statement the host compiled and what Lean reported; revision and stop carry the host's
 * feedback, which quotes Lean and the reviewers.
 */
export type WebFormalizationStep = { round: number } & (
  | { step: 'role'; workerId: string; role: WebFormalizationRole; slot: string;
    state: 'started' | 'finished' | 'failed'; summary?: WebFormalizationRoleSummary; /** Why it failed, a code. */ reason?: string }
  | { step: 'compile'; state: 'started' | 'passed' | 'failed'; source?: string; sourceClipped?: boolean; targets?: string[];
    lean?: WebAgentLeanCheck; text?: string }
  | { step: 'revision'; stage: 'plan' | 'round'; text: string; textClipped?: boolean }
  | { step: 'approved' }
  | { step: 'stopped'; reason: string; text?: string; textClipped?: boolean });
export type WebFormalizationActivityBody = { type: 'action'; action: WebAgentActionBody } | { type: 'step'; step: WebFormalizationStep };
/** `sequence` and `at` are the server's; an action reads as a run's (WebAgentAction) with the entry's. */
export type WebFormalizationActivity = WebFormalizationActivityBody & { sequence: number; at: string };
export const webFormalizationActivityLimits = Object.freeze({ perRecord: 3_000, page: 500, summaryText: 32_768, summaryItems: 12,
  summaryItem: 2_000, feedback: 6_000, source: 32_768, targets: 64, encoded: webAgentActionLimits.encoded + 256 * 1024 });
export type WorkerFormalizationMessage = { type: 'progress'; progress: WebFormalizationProgress }
  | { type: 'compiled'; candidate: unknown }
  | { type: 'activity'; activity: WebFormalizationActivityBody }
  | { type: 'result'; status: 'approved'; evidence: unknown }
  | { type: 'result'; status: 'exhausted' | 'error'; reason: string };
/** Generations before 2026-11-05 ran under a 200,000-token budget; their evidence stays valid. */
export const webFormalizationTokenBudgets: readonly number[] = [0, 200_000];
export const webFormalizationReason = /^(?:formalization|math|lean_task)_[a-z0-9_]{1,100}$/u;
