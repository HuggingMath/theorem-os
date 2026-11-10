/** Personal research tools use the same visibility rules as their source records. */
export type ResearchSearchKind = 'problem' | 'conversation' | 'lemma' | 'route' | 'library';
export type ResearchSearchHit = {
  id: string; kind: ResearchSearchKind; title: string; excerpt: string; href: string;
  context: string; updatedAt: string; version?: string;
};
export type ResearchSearchResult = { query: string; items: ResearchSearchHit[]; total: number;
  counts: Record<ResearchSearchKind, number>; nextOffset?: number };
export type ResearchTokenRate = { providerId: string; model: string; currency: 'CNY' | 'USD'; perMillion: number };
export type ResearchUsageEntry = {
  id: string; stage: 'formalization' | 'proof' | 'explanation'; title: string; href: string; status: string;
  model: string; providerId?: string; tokens: number | null; tokenLimit?: number; startedAt: string;
  durationMs: number | null; shared: boolean; estimate?: { amount: number; currency: 'CNY' | 'USD'; perMillion: number };
};
export type ResearchUsageGroup = {
  id: string; title: string; href: string; updatedAt: string; entries: ResearchUsageEntry[];
  knownTokens: number; missingEntries: number; attempts: number; acceptedAttempts: number;
};
export type ResearchUsageLedger = { groups: ResearchUsageGroup[]; rates: ResearchTokenRate[];
  knownTokens: number; missingEntries: number; entryCount: number;
  estimates: { currency: 'CNY' | 'USD'; amount: number; entries: number }[]; unpricedEntries: number };
export type ResearchBriefTask = {
  id: string; version: string; title: string; kind: string; objective: string; statement?: string; derivation?: string;
  dependsOn: string[]; premises: string[]; status: string; proofStatus: string; finding?: string;
  feedback?: string; commit?: string; sourceDigest?: string; environmentDigest?: string;
  checks: { id: string; passed: boolean }[]; href: string;
  agents?: { id: string; role?: string; basis: 'owner' | 'assignment' }[];
};
export type ResearchDecisionSnapshot = {
  sequence: number; stateDigest: string; planVersion?: string; tasks: ResearchBriefTask[];
};
export type ResearchBriefDecision = {
  id: string; text: string; kind?: 'plan-approval' | 'plan-edit'; delivery: string; decision: string;
  reason?: string; evidenceRefs: string[]; execution?: string;
  taskRefs?: { id: string; version: string; relation: 'target' | 'reference' | 'execution' | 'plan' }[];
  beforePlanVersion?: string; planVersion?: string; resultRefs?: string[];
  before?: ResearchDecisionSnapshot; after?: ResearchDecisionSnapshot;
};
export type ResearchBrief = {
  schema: 'theorem-os.research-brief.v1'; generatedAt: string; title: string; statement: string; leanStatement: string;
  sourceDigest: string; environment: string; environmentDigest?: string;
  formalization?: { id: string; confirmation?: 'automatic' | 'manual'; reviewMode?: 'direct'; evidenceDigest: string };
  attempts: { id: string; title: string; status: string; accepted: boolean; createdAt: string; href: string;
    failure?: string; sourceDigest: string; failedChecks: number; tasks: number }[];
  selectedRunId: string; runHref: string; accepted: boolean; status: string;
  tasks: ResearchBriefTask[];
  routes: { id: string; prerequisites: string[]; closingTaskId: string; targetTaskId: string }[];
  decisions: ResearchBriefDecision[];
  planApproval?: { status: string; planVersion?: string };
  blockers?: { id: string; taskId: string; taskVersion: string; mechanism: string; status: string; evidenceRefs: string[] }[];
  acceptance: { status: string; checks: { id: string; taskId: string; version: string; passed: boolean }[] };
  outcomes: { title: string; href: string; detail: string }[];
  usage: { knownTokens: number; missingEntries: number; entries: ResearchUsageEntry[] };
};
