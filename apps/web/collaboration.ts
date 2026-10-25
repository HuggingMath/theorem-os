/** Browser projection of a saved runtime observation, never a proof acceptance signal. */
export type WebPlanTask = {
  id: string; kind: 'research' | 'sketch' | 'lemma' | 'goal'; objective: string;
  dependsOn: readonly string[]; revision: number; proofPath?: string; theoremName?: string; type?: string;
  groupId?: string; sharing?: 'group' | 'problem'; status?: 'active' | 'paused' | 'stopped'; ownerId?: string;
  premises?: readonly string[]; conditional?: boolean; statementReview?: boolean; informalStatement?: string;
  reviewScope?: 'final-candidate' | 'feasibility';
};
export type WebPlanGroup = { id: string; objective: string; status: 'active' | 'paused' | 'stopped'; revision: number;
  engineerId?: string; maxTurns?: number; maxConcurrent?: number };
export type WebProofRoute = { id: string; targetTaskId: string; prerequisiteTaskIds: readonly string[]; closingTaskId: string };
export type WebPlan = { schema: string; baseVersion: string; tasks: WebPlanTask[]; groups?: WebPlanGroup[]; proofRoutes?: WebProofRoute[] };
export type WebPlanProposal = WebPlan & { id: string };
export type WebTaskReference = { taskId: string; taskDigest: string };
export type WebStatementReview = {
  taskId: string; version: string; status: string; intendedStatement: string; leanStatement: string;
  id?: string; snapshotDigest?: string; environmentDigest?: string; commit?: string;
  premises?: readonly string[]; dependencies?: WebTaskReference[]; workerId?: string; assignmentId?: string;
  translation?: unknown; summary?: string;
};
export type WebProofReferences = {
  sourceCommit: string; environmentDigest: string; contextDigest: string; root: { name: string; file: string };
  inputs: { file: string; name?: string; digest: string }[]; tasks?: WebTaskReference[];
  statement: { name: string; file: string }[]; proof: { name: string; file: string }[];
};
export type WebInspectedTask = {
  id: string; kind: WebPlanTask['kind']; objective: string; group: string; status: string; control: string;
  owner?: string; version: string; theorem?: string; type?: string; informalStatement?: string;
  premises: readonly string[]; plannedDependencies: readonly string[]; attempts: number;
  proof: { status: string; failureCategory?: string; commit?: string; sourceDigest?: string;
    conditions?: WebTaskReference[]; receiptIds?: string[]; actualReferences?: WebProofReferences };
  feedback?: string; feedbackCategory?: string; finding?: string; parkedBy: string[]; parkedRoutes: Record<string, string[]>;
};
export type WebHumanEdit = {
  id: string; status: 'received' | 'applied' | 'rejected'; reason?: string; receivedAt?: number; appliedAt?: number;
  baseVersion?: string; planVersion?: string; affectedTasks?: string[]; pendingSync?: boolean;
  recheck?: { status: string; tasks: { taskId: string; taskDigest: string; status: string; reason?: string;
    lastCheck?: { commit: string; sourceDigest: string; environmentDigest: string; passed: boolean; conditional: boolean; receiptIds: string[] } }[] };
};
export type WebInspectedWorker = {
  id: string; role: string; sessionRole?: string; phase: string; turns: number; task?: string;
  scheduling?: { status: string; since: number; action?: string; taskId?: string };
  dispatchWait: { status: string; observation?: unknown }; usage?: Record<string, unknown>;
  lastActivity?: { event: string; at: number; itemType?: string };
  lastFailure?: { reason: string; at: number; category: string }; recovery?: { phase: string; reason: string; category: string;
    cycles: number; nextRetryAt: number; waitedMs?: number };
  context?: unknown; failures?: { signature: string; sourceDigest: string; attempts: number }[]; error?: string; failureCategory?: string;
};
export type WebRouteObservation = {
  routeId: string; targetTaskId: string; prerequisiteTaskIds: readonly string[]; remainingPrerequisiteTaskIds: string[];
  closingTaskId: string; closingStatus: string; ready: boolean; targetStatus: string; connection: string;
  referenceCoverageMissing: string[]; parkedBy: string[];
};
export type WebRecordedObligation = {
  taskId: string; taskDigest: string; kind: string; groupId: string; recordedProof: string; closed: boolean;
  conditions: WebTaskReference[]; referenceCoverage: string; evidenceDigest?: string;
};
export type WebGoalFrontier = {
  taskId: string; taskDigest: string; closed: boolean; frontier: { taskId: string; taskDigest: string | null }[];
  missingDependencies: string[]; routeCombination?: string; alternatives?: { routeId: string;
    frontier: { taskId: string; taskDigest: string | null }[]; missingDependencies: string[]; parkedBy: string[] }[];
};
export type WebRecordedBlocker = {
  id: string; taskId: string; taskDigest: string; groupId: string; mechanism: string; scope: string;
  routeId?: string; evidenceStatus: string; status: string; evidenceRefs?: readonly string[]; reopenOn: unknown;
  basis?: unknown; reopenedReason?: string;
};
export type WebRecordedAdvisory = { taskId: string; taskDigest: string; kind: string; completed: boolean; findingDigest?: string };
type WebChange<T> = { before: T; after: T };
export type WebMathematicalChange = {
  schema: 'theoremos.obligation-progress.v1'; evidence: 'recorded-not-replayed'; acceptance: 'not-assessed';
  kind: 'baseline' | 'transition'; at: number; beforeDigest?: string; afterDigest: string; environmentChanged: boolean;
  obligations: { new: WebRecordedObligation[]; closed: WebChange<WebRecordedObligation>[]; reopened: WebChange<WebRecordedObligation>[];
    removed: WebRecordedObligation[]; changed: WebChange<WebRecordedObligation>[] };
  goalFrontiers: { goalId: string; before?: WebGoalFrontier; after?: WebGoalFrontier }[];
  blockers: { new: WebRecordedBlocker[]; parked: WebChange<WebRecordedBlocker>[]; reopened: WebChange<WebRecordedBlocker>[];
    superseded: WebChange<WebRecordedBlocker>[]; removed: WebRecordedBlocker[]; changed: WebChange<WebRecordedBlocker>[] };
  routes: { routeId: string; before?: WebRouteObservation; after?: WebRouteObservation }[];
  advisory: { proposed: WebRecordedAdvisory[]; completed: WebChange<WebRecordedAdvisory>[]; reopened: WebChange<WebRecordedAdvisory>[];
    removed: WebRecordedAdvisory[]; changed: WebChange<WebRecordedAdvisory>[] };
};
export type WebInspection = {
  schema: string; runId: string; snapshot: { schema: string; runId: string; stateDigest: string; resultDigest: string | null };
  evidence: string; phase: string; recordedOutcome?: unknown; evaluator?: { status: unknown; method: unknown; official: unknown };
  problem: { id: string; statement: string; formalStatement: string; assumptions: readonly string[];
    targets: readonly { proofPath: string; theoremName: string; declarationHash?: string }[] };
  configuration: { model: string; effort: string; workers: number; coordination: string;
    modules?: { id: string; versions: Record<string, string> }; buildDigest: string; environmentDigest: string;
    methodDigest?: string; knowledgeDigest?: string };
  turns: number; usage?: Record<string, unknown>; planVersion?: string;
  scheduling: { evidence: string; observedWorkers: number; working: number; proofAssignments: number;
    preparing: number; stopping: number; idle: number; stopped: number; capacityRefill?: unknown };
  knowledge: { status: string; catalogDigest?: string; evidence: string; attribution: string;
    retrievalCoverage: string; droppedRetrievals: number; retrievals: unknown[]; originalUses: unknown[]; uses: unknown[] };
  tokenBudget: unknown; continuation: unknown;
  mathematics: { snapshot: { schema: string; evidence: string; acceptance: string; digest: string; environmentDigest?: string;
    obligations: WebRecordedObligation[]; goals: WebGoalFrontier[]; blockers: WebRecordedBlocker[];
    routes: WebRouteObservation[]; advisory: unknown[] };
    recentChanges: WebMathematicalChange[]; retainedChangeLimit: number };
  progress: { checkedProofTasks: number; conditionalProofTasks: number; completedResearchTasks: number; openProofTasks: string[] };
  waiting?: { reason: string; taskIds: string[]; goalIds: string[]; inputDigest: string; investigation?: unknown };
  groups: { group: WebPlanGroup; turns: number; busy?: number }[]; tasks: WebInspectedTask[]; workers: WebInspectedWorker[];
  statementReviews: WebStatementReview[];
  review?: { commit: string; sourceDigest: string; status: string; workerId?: string; assignmentId?: string; summary?: string };
  edits: WebHumanEdit[]; error?: string; failureCategory?: string;
};
export type WebDelivery = {
  id: string; producer: string; taskId?: string; taskDigest?: string; kind: string; status: string;
  statement: string; premises: readonly string[]; dependencies: WebTaskReference[]; remainingObligations: readonly string[];
  summary: string; evidenceRefs: readonly string[]; createdAt: number; commit?: string; sourceDigest?: string; finding?: string;
  evidence?: { passed: boolean; verification: { status: string; targetCommit: string; results: { receiptId: string }[] } };
};
export type WebTaskSource = {
  taskId: string; taskVersion: string; commit: string; sourceDigest: string;
  environmentDigest: string; file: string; source: string; scope: 'owned-file';
};
export type WebCheckReceipt = {
  id: string; taskId: string; taskVersion: string; commit: string;
  sourceDigest: string; environmentDigest: string; record: Record<string, unknown>;
};
export type WebGuidanceInput = {
  id: string;
  recipient: { kind: 'lead' | 'task' | 'worker'; id?: string };
  taskRef?: { id: string; version: string };
  text: string;
  observationRef: { sequence: number; stateDigest: string };
};
export type WebGuidanceRecord = WebGuidanceInput & {
  status: 'queued' | 'delivered' | 'deferred' | 'failed';
  createdAt: string; updatedAt: string; deliveredTo?: string[]; reason?: string;
};
export type WebObservation = {
  schema: 'theorem-os.web-observation.v1';
  webRunId: string; solverRunId: string; observedAt: string; sequence: number;
  evidence: 'recorded-not-replayed'; acceptance: 'not-assessed';
  snapshot: WebInspection['snapshot']; inspection: WebInspection;
  plan: WebPlan | null;
  sources: WebTaskSource[]; checks: WebCheckReceipt[]; guidance: WebGuidanceRecord[];
  deliveries?: WebDelivery[];
  history?: WebInspection['tasks'];
  coverage: { sources: 'recorded' | 'partial'; checks: 'recorded' | 'partial' };
};
export type WebCommand =
  | { type: 'edit-preview' | 'edit'; proposal: WebPlanProposal }
  | { type: 'guidance'; guidance: WebGuidanceInput }
  | { type: 'capture' };
export type WebCommandResult = {
  id: string; status: string; baseVersion?: string; planVersion?: string; reason?: string;
  commandDigest?: string;
  affectedTaskIds?: string[];
  changes?: { taskId: string; fields: string[] }[];
  guidance?: WebGuidanceRecord;
  edit?: WebHumanEdit;
  observation?: WebObservation;
  catalog?: unknown;
};
export type WebArchive = {
  id: string; runId: string; createdAt: string; digest: string;
  evidence: 'recorded-not-replayed'; requiresFreshCheck: true;
  sources: number; checks: number; catalogDigest?: string;
  coverage: { events: 'complete' | 'partial'; sources: 'recorded' | 'partial'; checks: 'recorded' | 'partial' };
};
