import { parseCooperationPlan } from './tasks';
import { assertPlanTaskTypeContracts } from './taskTypeContract';
import { limitMathOutput } from '../math/mathProcess';
import { type SolverProblem } from './problem';
import { type ProofCheck } from './modules/evidence';
import { readMathResponse as block, type DeliveryRecord } from './deliveries';
import { type TaskProof } from './cooperativeProof';
import { type StatementReview } from './statementReview';
import { type DeliveryArtifactManifest } from './deliveryArtifacts';
import { type BlockerBasis, type RouteBlocker } from './routeControl';
import { type ProofRoute } from './proofRoutes';
import { type ObligationSnapshot, type ObligationProgressReceipt } from './obligationProgress';
import { type TaskConsumerProjection } from './taskConsumers';
import { type ParallelQuestion } from './taskQuestions';
import { mathematicalGaps } from './mathematicalGaps';
import type { NextCheckRecord, NextCheckDecision } from './nextCheckContract';
import { parseNextCheckDecisions } from './nextChecks';
import type { DeliveryReceipt } from './deliveryReceipts';
import type { ProofReadyRecord } from './proofReady';
import type { ProofImportRecord } from './proofImportRecord';
import type { ProofSearchRecord } from './proofSearchRecords';
import type { ResearchRecord } from './researchRecords';
import type { ResearchCheckpoint } from './researchCheckpoints';
import type { ResearchDecision } from './researchDecisions';
import type { ContextCheckpointRejection } from './contextCheckpoint';
import type { HumanGuidanceRecord } from './humanGuidance';
import { expandPlanPatch, isPlanPatch, liftNestedPlanPatch, type PlanPatchBase } from './planPatch';
import { applyGoalPathDecisions, type GoalPathDecisions } from './goalPathDecisions';
import type { GoalPathReview } from './goalPathReview';
import { parseGoalProgressDecision, type GoalProgressDecision, type GoalProgressState } from './goalProgress';
import { leadPlanDeliveryFile, taskVersion, type CooperativeTask, type RouteRecord, type TaskRecord, type CooperativeAction } from './tasks';

export const digest = taskVersion;
/** Derived from stored task and failure records; the marker is never a separate acceptance state. */
export const taskSourceRejections = new Set(['math_task_source_outside_scope', 'math_task_ambiguous_declaration',
  'math_task_existing_declaration_removed', 'math_task_existing_declaration_changed', 'math_task_requires_theorem',
  'math_task_requires_definition',
  'math_task_helper_is_original_declaration', 'math_task_conditional_header_unsupported',
  'math_original_declaration_changed', 'math_original_context_changed', 'math_local_module_import_cycle',
  'math_trusted_source_changed', 'math_source_outside_ownership']);
export const integrationRejections = new Set([...taskSourceRejections, 'math_task_condition_version_invalid',
  'math_task_type_invalid',
  'math_task_delivery_no_longer_checks', 'math_task_dependency_invalidated', 'math_task_merged_proof_failed',
  'math_task_integration_conflict', 'math_task_integration_missing_context', 'math_task_integration_missing_declaration',
  'math_task_missing_declaration', 'math_task_check_identity_changed']);
export const directDeliveryRejections = new Set([...taskSourceRejections, 'math_task_missing_declaration', 'math_task_repeated_failed_input',
  'math_task_type_invalid',
  'math_task_check_identity_changed',
  'math_research_delivery_invalid', 'math_research_delivery_unchanged', 'math_research_lemma_requests_invalid',
  'math_delivery_invalid', 'math_response_invalid', 'math_math-result_missing_or_too_large', 'math_math-result_requires_one_block',
  'math_delivery_artifact_not_regular_file', 'math_delivery_artifact_too_large', 'math_delivery_artifact_invalid_commit',
  'math_delivery_artifact_path_invalid', 'math_delivery_artifact_claim_invalid', 'math_delivery_artifact_required', 'math_route_blocker_invalid',
  'math_proof_search_checkpoint_invalid', 'math_proof_search_checkpoint_scope_changed', 'math_proof_search_checkpoint_unavailable']);
export const rejectionCode = (error: Error) => error.message.split(/[\n:]/u, 1)[0];
/** Source-contract failures need a local correction before a mathematical route decision. */
export const taskSourceRepairRejections = new Set(['math_task_existing_declaration_removed', 'math_task_existing_declaration_changed',
  'math_original_declaration_changed', 'math_original_context_changed']);
export function isTaskSourceRepairFeedback(feedback: string): boolean {
  const sourceCode = /^Host rejected the edited source before committing or checking it in Lean\.\nFile: [^\n]+\nError: ([^\n]+)\n/u.exec(feedback)?.[1];
  return taskSourceRepairRejections.has(sourceCode ?? feedback.split(/[\n:]/u, 1)[0]);
}

export type ReviewRecord = { commit: string; sourceDigest: string; status: 'pending' | 'running' | 'accepted' | 'changes_requested';
  workerId?: string; assignmentId?: string; summary?: string };
export type HumanEditRecord = { id: string; status: 'received' | 'applied' | 'rejected'; reason?: string;
  receivedAt?: number; appliedAt?: number; baseVersion?: string; planVersion?: string; affectedTasks?: string[]; pendingSync?: boolean;
  recheck?: { status: 'pending' | 'passed' | 'failed' | 'not-required' | 'superseded';
    tasks: { taskId: string; taskDigest: string; status: 'pending' | 'conditional' | 'passed' | 'failed' | 'removed' | 'superseded'; reason?: string;
      lastCheck?: { commit: string; sourceDigest: string; environmentDigest: string; passed: boolean; conditional: boolean; receiptIds: string[] } }[] } };
export type PlanPublication = { nonce: string; file: string; offset: number; eventDigest: string;
  baseVersion: string; planVersion: string; acceptedAt: number; finalized?: boolean };
export type InitialPlanPublication = PlanPublication;
export type PlanPublicationRejection = { nonce: string; file: string; offset: number; baseVersion: string; reason: string };
export type FailedTaskInput = { id: string; taskId: string; taskDigest: string; inputDigest: string; basis: BlockerBasis;
  attemptFingerprint?: string; relatedFailureIds?: string[];
  sourceDigest: string; targetDigest: string; seedSourceDigest: string; seedTargetDigest: string;
  canonicalSourceDigest: string; canonicalTargetDigest: string; feedback: string;
  repair?: { taskId: string; taskDigest: string; workerId: string; pending: boolean; startedAttempt?: number } };
export type CooperationState = { tasks: TaskRecord[]; groups?: RouteRecord[]; canonicalCommit?: string; leadSeedCommit?: string; review?: ReviewRecord; error?: string;
  /** Context-only notes actually delivered to this worker; decisions remain separate from proof state. */
  humanGuidance?: HumanGuidanceRecord[];
  /** Context-only reverse uses, projected from the full archive without expanding execution visibility. */
  consumerInterfaces?: TaskConsumerProjection;
  /** Scoped advisory history, derived from immutable delivery records. */
  mathematicalGaps?: ReturnType<typeof mathematicalGaps>;
  /** Durable scoped investigations and explicit Lead decisions; all outcomes remain advisory. */
  nextChecks?: NextCheckRecord[];
  /** Context-only public in-flight metadata, without expanding task/source visibility. */
  parallelQuestions?: readonly ParallelQuestion[];
  history?: { task: CooperativeTask; producer?: string; proof?: TaskProof; integratedCheck?: ProofCheck; finding?: string;
    researchCompletion?: ResearchRecord }[];
  deliveries?: DeliveryRecord[]; cursors?: Record<string, number>; edits?: HumanEditRecord[];
  researchDecisions?: ResearchDecision[];
  /** Exact research publications shown in this Lead dispatch; later arrivals wait for the next turn. */
  leadResearchInputIds?: string[]; leadResearchInputCount?: number;
  deliveryReceipts?: DeliveryReceipt[];
  proofReadyRecords?: ProofReadyRecord[];
  proofImports?: ProofImportRecord[];
  /** Latest host-retained search checkpoint per task; advisory and independently revalidated on use. */
  proofSearchRecords?: Record<string, ProofSearchRecord>;
  planVersion?: string; planEdited?: boolean; statementReviews?: StatementReview[];
  initialPlanPublication?: InitialPlanPublication;
  /** Last immutable live publication; its dispatch continuation is process-local. */
  planPublication?: PlanPublication;
  /** Latest unresolved live intake error; it does not reject the accepted graph or change scheduling. */
  planPublicationRejection?: PlanPublicationRejection;
  /** Worker-private projection of the current checkpoint request's diagnostic. */
  contextCheckpointRejection?: ContextCheckpointRejection;
  planRejection?: { proposalDigest: string; inputDigest: string; error: string; stalled: boolean };
  lastLeadInputDigest?: string;
  /** Durable Lead wake-ups; a restart re-asks those whose dispatch did not settle. */
  leadWakes?: import('./leadWakes').LeadWakes;
  /** Status changes their named cause does not admit; recorded for diagnosis, never repaired. */
  invalidTaskTransitions?: import('./taskLifecycle').InvalidTaskTransition[];
  /** A saved unfinished Lead turn waits for changed inputs; it is not a completed decision. */
  lastLeadPauseInputDigest?: string;
  /** Human approval of the first accepted plan, when the run requires it (state.planApproval). */
  planApproval?: import('./planApproval').PlanApprovalRecord;
  /**
   * Last wake for peers left without work while others run. Per-peer episodes retain unanswered counts and retry
   * times for each continuous idle wait; aggregate count/workerIds also support older saved states.
   */
  idlePeerWake?: import('./leadInbox').IdlePeerWake;
  /** Inbox basis time of the last Lead turn that decided (accepted or published a plan); undecided turns leave it. */
  leadDecisionBasisAt?: number;
  /**
   * Latest original-goal path stall (no runnable frontier input). `answeredAt` once a Lead turn shown it adopted or declined
   * every presented input, or the stall changed; after MAX_UNANSWERED_GOAL_PATH_TURNS turns that did neither, it is
   * recorded as `ignoredAt` instead. `declined` keeps the Lead's reasons for this stall.
   */
  goalPathStall?: { digest: string; active: boolean; at: number; goalIds: string[]; taskIds: string[]; answeredAt?: number;
    unanswered?: number; ignoredAt?: number; declined?: { taskId: string; reason: string; at: number }[] };
  /** Host observation of started worker time without new checked inputs on each frozen goal's path. */
  goalProgress?: GoalProgressState;
  /** Context-only host review, including candidates bound to fresh source evidence. */
  goalPathReview?: GoalPathReview;
  /** Durable mathematical input/method tombstones, independent of scheduling and plan revisions. */
  capacityExplorationInputs?: { inputDigest: string; focus: import('./capacityExploration').CapacityExplorationFocus;
    targetTaskId: string; taskId: string }[];
  failedTaskInputs?: FailedTaskInput[];
  blockers?: RouteBlocker[];
  proofRoutes?: ProofRoute[];
  progressSnapshot?: ObligationSnapshot;
  progressReceipts?: ObligationProgressReceipt[];
  unchangedResearch?: Record<string, { taskDigest: string; notesBlob: string; count: number }>;
  researchCheckpoints?: Record<string, ResearchCheckpoint>;
  researchDrafts?: Record<string, { taskDigest: string; workerId: string; assignmentId?: string; seedCommit: string; canonicalCommit?: string;
    commit: string; outputDigest: string; artifacts: DeliveryArtifactManifest; suspended?: boolean;
    /** Exact saved notes already attributed to this task; retaining inherited bytes cannot create this marker. */
    handoffNotesDigest?: string }>;
  recheck?: { canonicalCommit: string; total: number; completed: number; taskId?: string };
  initialPlanFallback?: { at: number; reason: string };
  /** What the last started Lead turn saw; the next Lead context reports changes since then. */
  leadInboxBasis?: import('./leadInbox').LeadInboxBasis;
  /** Context-only bounded index of changes since leadInboxBasis. */
  leadInbox?: import('./leadInbox').LeadInbox };
export type TaskVersions = ReadonlyMap<string, { task: CooperativeTask; version: string }>;
export type DispatchBudget = { maxTurns: number; remainingMs: number };
export const RETRY_DISPATCH = Symbol('retry-dispatch');
export type DispatchResult = CooperativeAction | typeof RETRY_DISPATCH | undefined;

export const bounded = (text: string, bytes: number) => limitMathOutput(text, bytes, 'head');

/** Reuse the saved diagnostic across turns while always targeting the current dispatch. */
export function leadPlanPublicationFeedback(action: CooperativeAction | undefined,
  state: Pick<CooperationState, 'planVersion' | 'planPublicationRejection'>): string | undefined {
  const rejection = state.planPublicationRejection, file = action && leadPlanDeliveryFile(action);
  if (action?.kind !== 'lead' || !file || !rejection || rejection.baseVersion !== state.planVersion) return;
  return 'Host rejected a Lead publication before accepting it:\n' + JSON.stringify(rejection) + '\n' +
    'Correct the reported error and append a new complete JSON event using the current publication target: ' +
    JSON.stringify({ file, kind: 'plan', dispatchNonce: action.initialPlanNonce ?? action.planNonce, baseVersion: action.planVersion }) + '. ' +
    'Preserve the log and use the current assignment protocol; a saved rejection may come from an earlier dispatch. ' +
    'Keep kind:"plan", baseVersion and any dispatchNonce at the top level of the same event as tasks or upsert/remove; ' +
    'a bare plan patch is not a publication event. Only the first valid publication in a dispatch is accepted. This intake feedback grants no proof acceptance.';
}
export const deliveryInputFields = (record: DeliveryRecord) => ({
  taskId: record.taskId, taskDigest: record.taskDigest, kind: record.kind, status: record.status,
  summary: record.summary, evidenceRefs: record.evidenceRefs, dependencies: record.dependencies,
  remainingObligations: record.remainingObligations, lemmaRequests: record.lemmaRequests, findingDigest: record.findingDigest,
  mathematicalGap: record.mathematicalGap, mathematicalGapScope: record.mathematicalGapScope,
  checkOutcome: record.checkOutcome, checkOutcomeScope: record.checkOutcomeScope,
  sourceUses: record.sourceUses, searchCheckpoint: record.searchCheckpoint,
});
export type LeadPlan = ReturnType<typeof parseCooperationPlan> & { fromPatch?: boolean; goalPathDecisions?: GoalPathDecisions;
  goalProgressDecision?: GoalProgressDecision; researchDecisions?: unknown; nextCheckDecisions?: NextCheckDecision[] };
type LeadPlanOptions = Parameters<typeof expandPlanPatch>[2] & { goalPath?: GoalPathReview; restoring?: boolean };
/**
 * Model proposes tasks or a revision of the accepted graph; the host validates coverage, exact targets and an acyclic
 * dependency graph. A revision may answer the current goal-path review, whose mechanical candidates expand first.
 */
export function parseLeadPlan(problem: SolverProblem, value: unknown, base?: PlanPatchBase, options: LeadPlanOptions = {}): LeadPlan {
  const { goalPath, restoring, ...patchOptions } = options;
  const progressDecision = parseGoalProgressDecision(value, restoring);
  const nextCheckDecisions = parseNextCheckDecisions(liftNestedPlanPatch(value));
  const answered = applyGoalPathDecisions(liftNestedPlanPatch(value), goalPath, base);
  const decisions = { ...(answered.decisions ? { goalPathDecisions: answered.decisions } : {}),
    ...(progressDecision ? { goalProgressDecision: progressDecision } : {}),
    ...(value && typeof value === 'object' && 'researchDecisions' in value
      ? { researchDecisions: (value as { researchDecisions: unknown }).researchDecisions } : {}),
    ...(nextCheckDecisions ? { nextCheckDecisions } : {}) };
  const patched = isPlanPatch(answered.value);
  const plan = parseCooperationPlan(problem, isPlanPatch(answered.value) ? expandPlanPatch(answered.value, base, patchOptions) : answered.value);
  assertPlanTaskTypeContracts(plan.tasks, base?.tasks);
  return { ...plan, ...(patched ? { fromPatch: true } : {}), ...decisions };
}
export function readCooperationPlan(problem: SolverProblem, worktree: string, base?: PlanPatchBase, options?: LeadPlanOptions): LeadPlan {
  return parseLeadPlan(problem, block(worktree, 'math-plan'), base, options);
}
