import { z } from 'zod';
import { isSimpleLeanName } from '../math/leanSyntax';
import type { SolverRunState } from './archive';
import { portfolioRouteIdSchema as routeId, retiredRouteSchema } from './routeControl';
import type { RequestUsageAccounting, UsageAccounting } from './usageBudget';

export const PORTFOLIO_MAX_SECONDS = 86_400;

const profileSchema = z.enum(['structural-symmetry', 'explicit-constructive', 'falsification-obstruction']);
const text = (max: number) => z.string().trim().min(1).max(max);
const probeName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/u);
const timestamp = z.number().int().nonnegative();
export const portfolioFoundationLemmaSchema = z.object({
  id: routeId, proofPath: text(256), theoremName: text(256).refine(isSimpleLeanName),
  type: text(4_000), objective: text(750),
}).strict();
const falsificationEvidence = z.object({
  kind: z.enum(['counterexample', 'obstruction']), claim: text(500), probe: text(1_000), result: text(1_000),
}).strict();
const reportBodySchema = z.object({
  routeId, status: z.enum(['proposed', 'refuted', 'inconclusive']), blueprintSummary: text(1_200),
  keyTransformations: z.array(text(350)).max(6), proposedFoundationLemmas: z.array(portfolioFoundationLemmaSchema).max(6),
  falsificationEvidence: z.array(falsificationEvidence).max(3).default([]),
  obstructions: z.array(text(500)).max(4).default([]), probeRefs: z.array(probeName).max(4).default([]),
}).strict();
const reportSchema = reportBodySchema.extend({ profile: profileSchema });
export type PortfolioScoutReport = z.infer<typeof reportSchema>;

export const portfolioGateSchema = z.object({
  primaryRouteId: routeId.optional(), backupRouteId: routeId.optional(),
  retiredRoutes: z.array(retiredRouteSchema), foundationLemmas: z.array(portfolioFoundationLemmaSchema),
}).strict();
export const portfolioScoutSchema = z.object({
  profile: profileSchema, status: z.enum(['pending', 'running', 'reported', 'failed', 'timed-out']),
  turns: timestamp, reports: z.array(reportSchema).max(3).optional(),
  probes: z.array(z.object({ ref: probeName, digest: z.string().regex(/^[a-f0-9]{64}$/u), text: z.string().max(8192) })).max(12).optional(),
  usage: z.record(z.unknown()).optional(), usageBeforeThread: z.record(z.unknown()).optional(),
  lastInputTokens: timestamp.optional(),
}).strict();
export const portfolioExplorationSchema = z.object({
  phase: z.enum(['exploring', 'completed', 'skipped']),
  durationMs: z.number().int().positive().max(PORTFOLIO_MAX_SECONDS * 1000),
  scouts: z.array(portfolioScoutSchema).max(3), deadlineAt: timestamp.optional(), gate: portfolioGateSchema.optional(),
}).strict();
type PortfolioScout = z.infer<typeof portfolioScoutSchema> & {
  turns: number;
  usageAccounting?: UsageAccounting; requestUsageAccounting?: RequestUsageAccounting;
};
export type PortfolioExploration = Omit<z.infer<typeof portfolioExplorationSchema>, 'scouts'> & { scouts: PortfolioScout[] };

export const portfolioUsageRecords = (state: Pick<SolverRunState, 'portfolioExploration'>) =>
  state.portfolioExploration?.scouts ?? [];
