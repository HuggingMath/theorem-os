import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readMathBuildManifest } from '../math/mathBuildManifest';
import { bindLeanPackages } from '../math/leanDiagnostics';
import { MATH_PROOF_ENVIRONMENT_ENV, MATH_PROOF_ENVIRONMENT_SANDBOX_ENV, prepareMathProofEnvironment } from '../math/mathProofEnvironment';
import { DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT } from '../math/mathProofEnvironmentCache';
import { assertMathCanonicalPath, repositoryRelativePath } from '../math/paths';
import { canonicalMathJson, mathDigest, readMathFile, readMathJson, withMathRuntimeLease, writeMathJsonDurable, type MathLease } from '../math/mathRuntimeIo';
import { resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { resolveMathematicsLakePackagesCache } from '../math/verifier';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from './archive';
import { checkTaskProofs, createTaskSourceProjector, isAttributedTaskProof, ownedSourceDigest, projectedGoalInputs, type TaskProof, type TaskProofRequest } from './cooperativeProof';
import { rejectionCode, taskSourceRejections } from './cooperationShared';
import { freezeContinuationInput, readContinuationSnapshot, type ContinuationManifest } from './continuationInput';
import { readRunInspection } from './inspection';
import type { DeliveryRecord } from './deliveries';
import { researchRecordSchema, researchSourceDigest, restoreResearch } from './researchRecords';
import { researchSourceTasks, scopedResearchSources, type ResearchSourceTask } from './researchSources';
import { researchSourceKinds, researchSourceUseSchema } from './researchReferences';
import { proofSearchCheckpointReferenceSchema } from './proofSearchRecords';
import { mathematicalGapSchema } from './mathematicalGaps';
import { checkOutcomeSchema, nextCheckRecordSchema, nextCheckScopeSchema } from './nextCheckContract';
import { goalProgressStateSchema, resetGoalProgressClock } from './goalProgress';
import { assessTaskResponsibility, researchWorkerCanNode, researchWorkerCanTask } from './modules/organization';
import { CAPACITY_EXPLORATION_FOCUSES, currentCapacityExploration, plannedTaskRecords, type CapacityExploration } from './capacityExploration';
import { assertSolverSources, committedSource, commitSolverSources, git, readSolverProblem, withSolverWorktree, type SolverProblem } from './problem';
import { assignmentDeliveryFile, assumableLemma, isAdvisoryTask, isDefinitionTask, isFinalCandidateReview, parseCooperationPlan, taskGroup, taskVersion, type CooperativeTask, type TaskAssignment, type TaskRecord } from './tasks';
import { proofReadyRecord, proofReadyRecordSchema } from './proofReady';
import { automaticTaskConnection, createTaskConnectionCheck } from './taskConnections';
import { setTaskStatus } from './taskLifecycle';
import { taskDependencyRecords } from './modules/search';
import { hasDeterministicLeanFailure } from './proofReuse';
import { captureDeliveryArtifacts } from './deliveryArtifacts';
import { researchCheckpointInputDigest, researchCheckpointLocalInputDigest, researchCheckpointOutputDigest,
  UNCHANGED_RESEARCH_CHECKPOINT, type ResearchCheckpoint } from './researchCheckpoints';
import { recordRouteBlockers, validateBlockerProposals } from './routeControl';

const hash = z.string().regex(/^[a-f0-9]{64}$/u), oid = z.string().regex(/^[a-f0-9]{40,64}$/u);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u);
const seedBatchFallbacks = new Set([...taskSourceRejections, 'math_task_batch_projection_mismatch',
  'math_task_missing_declaration', 'math_task_condition_version_invalid']);
const maxSeedBatchSize = 32;
// This project permits undefined at the type level. Materialize validated required
// fields so Zod's optional-property inference does not weaken the runtime contract.
const capacityMarker = z.object({ schema: z.literal('theorem-os.capacity-exploration.v1'),
  targetTaskId: id, targetTaskDigest: hash, inputDigest: hash, focus: z.enum(CAPACITY_EXPLORATION_FOCUSES),
  workerId: id, taskDigest: hash, environmentDigest: hash, problemReceiptDigest: hash }).strict()
  .transform((value): CapacityExploration => ({ schema: value.schema, targetTaskId: value.targetTaskId,
    targetTaskDigest: value.targetTaskDigest, inputDigest: value.inputDigest, focus: value.focus,
    workerId: value.workerId, taskDigest: value.taskDigest, environmentDigest: value.environmentDigest,
    problemReceiptDigest: value.problemReceiptDigest }));
const capacityInput = z.object({ inputDigest: hash, focus: z.enum(CAPACITY_EXPLORATION_FOCUSES),
  targetTaskId: id, taskId: id }).strict().transform(value => ({ inputDigest: value.inputDigest,
    focus: value.focus, targetTaskId: value.targetTaskId, taskId: value.taskId }));
const capacityRecord = z.object({
  task: z.object({ id, kind: z.literal('research'), objective: z.string().min(1), dependsOn: z.array(id),
    revision: z.number().int().nonnegative() }).passthrough(),
  capacityExploration: capacityMarker,
  status: z.enum(['pending', 'running', 'blocked', 'conditional', 'delivered', 'integrated', 'completed']),
  finding: z.string().optional(), archived: z.literal(true).optional(),
}).strict().refine(value => taskVersion(value.task as CooperativeTask) === value.capacityExploration.taskDigest,
  'Capacity exploration task identity changed');
const capacitySource = z.object({ records: z.array(capacityRecord),
  inputs: z.array(capacityInput).optional(),
  notes: z.array(z.object({ taskId: id, taskDigest: hash, deliveryId: z.string().min(1), commit: oid,
    notes: z.string() }).strict()),
}).strict();
type CapacityRecord = z.infer<typeof capacityRecord>;
const handoffTask = z.object({ id, kind: z.enum(['research', 'sketch', 'lemma', 'goal']),
  objective: z.string().min(1), dependsOn: z.array(id), revision: z.number().int().nonnegative(),
  proofPath: z.string().optional(), theoremName: z.string().optional(), type: z.string().optional(),
  groupId: id.optional(), sharing: z.enum(['group', 'problem']).optional(), status: z.enum(['active', 'paused', 'stopped']).optional(),
  ownerId: id.optional(), preferredOwnerId: id.optional(), researchSource: z.enum(researchSourceKinds).optional(),
  consumerGoalIds: z.array(id).optional(),
  premises: z.array(z.string()).optional(), conditional: z.boolean().optional(),
  statementReview: z.boolean().optional(), informalStatement: z.string().optional(),
  informalProof: z.string().optional(), citations: z.array(z.string()).optional(),
  reviewScope: z.enum(['final-candidate', 'feasibility']).optional(), declaration: z.literal('definition').optional(),
  family: z.object({ lo: z.number().int().nonnegative(), hi: z.number().int().nonnegative(),
    chunk: z.number().int().positive(), predicate: z.string() }).strict().transform(value => ({ lo: value.lo, hi: value.hi,
    chunk: value.chunk, predicate: value.predicate })).optional(), familyMember: id.optional(),
}).strict().transform((value): CooperativeTask => ({ ...value, id: value.id, kind: value.kind,
  objective: value.objective, dependsOn: value.dependsOn, revision: value.revision }));
const continuableResearch = (task: CooperativeTask) => isAdvisoryTask(task) && !task.reviewScope && !isFinalCandidateReview(task);
const nextCheckSource = z.object({ records: z.array(nextCheckRecordSchema),
  tasks: z.array(z.object({ task: handoffTask, nextCheckId: hash,
    status: z.enum(['pending', 'running', 'blocked', 'conditional', 'delivered', 'integrated', 'completed']),
    finding: z.string().optional() }).strict()),
}).strict().refine(value => value.tasks.every(node => value.records.some(record => record.id === node.nextCheckId &&
  record.taskId === node.task.id && record.taskDigest === taskVersion(node.task))), 'Scoped check task identity changed');
const legacyCompletedResearchRecord = z.object({ task: handoffTask.refine(continuableResearch, 'Completion requires ordinary advisory research'),
  inputDigest: hash, finding: z.string().optional(), archived: z.literal(true).optional() }).strict();
const immutableCompletedResearchRecord = z.object({ task: handoffTask.refine(continuableResearch, 'Completion requires ordinary advisory research'),
  record: researchRecordSchema, finding: z.string().optional(), archived: z.literal(true).optional() }).strict();
const unboundCompletedResearchRecord = z.object({ task: handoffTask.refine(continuableResearch, 'Completion requires ordinary advisory research'),
  finding: z.string().optional(), archived: z.literal(true) }).strict();
const completedResearchRecord = z.union([immutableCompletedResearchRecord, legacyCompletedResearchRecord, unboundCompletedResearchRecord]);
type CompletedResearchRecord = z.infer<typeof completedResearchRecord>;
const handoffReference = z.object({ taskId: id, taskDigest: hash }).strict()
  .transform(value => ({ taskId: value.taskId, taskDigest: value.taskDigest }));
const frozenCandidate = z.object({ taskId: id, taskDigest: hash, workerId: id,
  readyId: z.string().min(1), submissionId: z.string().min(1), assignmentKey: z.string().min(1),
  seedCommit: oid, snapshotCommit: oid, sourceDigest: hash, environmentDigest: hash, problemReceiptDigest: hash,
  dependencies: z.array(handoffReference), sources: z.record(z.string()), seedSources: z.record(z.string()),
}).strict();
const researchDelivery = z.object({ id: z.string().min(1), producer: id, taskId: id, taskDigest: hash,
  groupId: id.optional(), kind: z.literal('research'), status: z.enum(['advisory', 'superseded']),
  statement: z.string(), premises: z.array(z.string()), dependencies: z.array(handoffReference),
  remainingObligations: z.array(z.string()), summary: z.string(), evidenceRefs: z.array(z.string()),
  createdAt: z.number().int().nonnegative(), commit: oid.optional(), sourceDigest: z.string().optional(),
  finding: z.string().optional(), findingDigest: hash.optional(),
  researchRecord: researchRecordSchema.optional(), mathematicalGap: mathematicalGapSchema.optional(),
  checkOutcome: checkOutcomeSchema.optional(), checkOutcomeScope: nextCheckScopeSchema.optional(),
  sourceUses: z.array(researchSourceUseSchema).max(32).optional(),
  searchCheckpoint: proofSearchCheckpointReferenceSchema.optional(),
  mathematicalGapScope: z.object({ problemReceiptDigest: hash, environmentDigest: hash,
    source: handoffTask, consumer: handoffTask, dependencies: z.array(handoffReference) }).strict()
    .transform(value => ({ ...value, problemReceiptDigest: value.problemReceiptDigest,
      environmentDigest: value.environmentDigest, source: value.source, consumer: value.consumer,
      dependencies: value.dependencies })).optional(),
  lemmaRequests: z.array(handoffTask.refine(task => task.kind === 'lemma' && Boolean(task.type?.trim()) &&
    Boolean(task.proofPath) && Boolean(task.theoremName), 'Handoff requires an exact typed lemma')).optional(),
}).strict().transform((value): DeliveryRecord => ({ ...value, id: value.id, producer: value.producer,
  taskId: value.taskId, taskDigest: value.taskDigest, kind: value.kind, status: value.status,
  statement: value.statement, premises: value.premises, dependencies: value.dependencies,
  remainingObligations: value.remainingObligations, summary: value.summary, evidenceRefs: value.evidenceRefs,
  createdAt: value.createdAt, lemmaRequests: value.lemmaRequests }));
const researchProofInput = z.object({ passed: z.boolean(), taskDigest: hash,
  conditions: z.array(handoffReference).optional() }).strict()
  .transform(value => ({ ...value, passed: value.passed, taskDigest: value.taskDigest }));
const researchTaskInput = z.object({ task: handoffTask,
  status: z.enum(['pending', 'running', 'blocked', 'conditional', 'delivered', 'integrated', 'completed']),
  finding: z.string().optional(), proof: researchProofInput.optional(), integratedCheck: researchProofInput.optional(),
  visibleDependencies: z.array(id), sourceDependencies: z.array(id), sourceHelpers: z.array(z.string()),
}).strict().transform((value): ResearchSourceTask => ({ ...value, task: value.task, status: value.status,
  visibleDependencies: value.visibleDependencies, sourceDependencies: value.sourceDependencies, sourceHelpers: value.sourceHelpers }));
const researchContext = z.object({ environmentDigest: hash, problemReceiptDigest: hash,
  tasks: z.array(researchTaskInput), deliveries: z.array(researchDelivery) }).strict();
const savedTaskDraft = z.object({ taskId: id, taskDigest: hash, workerId: id,
  assignmentId: z.string().optional(), seedCommit: oid, canonicalCommit: oid.optional(), commit: oid,
  outputDigest: hash, task: handoffTask.optional(), suspended: z.boolean().optional(), archived: z.literal(true).optional(),
  sources: z.record(z.string()), notes: z.string().nullable(),
  source: z.object({ runId: z.string(), stateFile: z.string(), environmentDigest: hash,
    problemReceiptDigest: hash, sourcePolicyDigest: hash }).strict(),
}).strict();
type SavedTaskDraft = z.infer<typeof savedTaskDraft>;
const savedResearchCheckpoint = z.object({ taskId: id, workerId: id,
  checkpoint: z.object({ taskDigest: hash, inputDigest: hash, outputDigest: hash,
    count: z.number().int().positive(), localInputDigest: hash.optional(), candidateOutputDigest: hash.optional(),
    unchangedEvidenceCount: z.number().int().positive().optional(),
    candidateStatus: z.enum(['structured-candidate', 'unclassified-draft']).optional(), paused: z.boolean().optional(),
  }).strict().transform((value): ResearchCheckpoint => ({ ...value, taskDigest: value.taskDigest,
    inputDigest: value.inputDigest, outputDigest: value.outputDigest, count: value.count })),
  source: savedTaskDraft.shape.source,
}).strict();
type SavedResearchCheckpoint = z.infer<typeof savedResearchCheckpoint>;
const sourceSchema = z.object({
  schema: z.literal('theorem-os.continuation-seed-source.v1'), capturedAt: z.number().int().nonnegative(),
  taskDigest: hash, problemReceiptDigest: hash, sourcePolicyDigest: hash,
  destination: z.object({ runId: z.string(), stateFile: z.string(), buildDigest: hash,
    methodDigest: z.string().optional(), environmentDigest: hash }).strict(),
  source: z.object({ runId: z.string(), stateFile: z.string(), stateDigest: hash, buildDigest: z.string(),
    methodDigest: z.string().optional(), canonicalCommit: oid, planVersion: z.string().optional() }).strict(),
  plan: z.unknown(), initialPlanning: z.literal(true).optional(), candidateIds: z.array(id), canonicalSources: z.record(z.string()),
  conditionalCandidates: z.array(z.object({ taskId: id, taskDigest: hash, commit: z.string(), seedCommit: z.string(),
    conditions: z.array(handoffReference).nonempty(), dependencies: z.array(handoffReference),
    sources: z.record(z.string()).optional(), seedSources: z.record(z.string()).optional(), captureError: z.string().optional() }).strict()).optional(),
  frozenCandidates: z.array(frozenCandidate).optional(),
  taskDrafts: z.array(savedTaskDraft).optional(),
  researchCheckpoints: z.array(savedResearchCheckpoint).optional(),
  workers: z.array(z.object({ id, role: z.string(), headBefore: oid, headAfter: oid,
    sources: z.record(z.string()), notes: z.string().nullable(), assignment: z.unknown().optional() }).strict()),
  history: z.unknown(),
  capacityExplorations: capacitySource.optional(),
  nextChecks: nextCheckSource.optional(),
  goalProgress: goalProgressStateSchema.optional(),
  completedResearch: z.array(completedResearchRecord).optional(),
  researchContext: researchContext.optional(),
  ownershipExtension: z.object({ sourceReceiptDigest: hash, sourcePolicyDigest: hash,
    addedFiles: z.array(z.string()) }).strict().optional(),
}).strict();
type SeedSource = z.infer<typeof sourceSchema>;

export type ContinuationSeedReport = {
  schema: 'theorem-os.continuation-seed.v1'; sourceRunId: string; runId: string; sourceStateFile: string;
  stateFile: string; sourceDigest: string; snapshotDigest?: string; canonicalCommit?: string;
  stage: 'frozen' | 'installing' | 'checking' | 'complete' | 'interrupted'; sourcesInstalled?: boolean;
  candidates: string[]; checked: string[]; failed: string[]; error?: string;
  evidence: 'advisory-sources-require-recheck' | 'fresh-helper-receipts';
};

const sourcePolicy = (problem: SolverProblem) => ({ workspace: problem.workspace, projectRelative: problem.projectRelative,
  baseCommit: problem.baseCommit, receiptDigest: problem.receiptDigest, contract: problem.contract, targets: problem.targets,
  ownedFiles: problem.ownedFiles, trustedFiles: problem.trustedFiles, declarations: problem.declarations,
  sourceStructure: problem.sourceStructure, sourceImports: problem.sourceImports, frozenFiles: problem.frozenFiles });
const policyDigest = (problem: SolverProblem) => mathDigest(canonicalMathJson(sourcePolicy(problem)));

/**
 * Owned files that a re-bootstrapped destination adds to the source problem, e.g. certificate or theory slots.
 * Undefined unless both are the same mathematical problem: equal contract, targets and trusted files, and every
 * source-owned file keeps its frozen declarations, context, imports and library bytes. Added files start at the destination baseline.
 */
function ownershipExtension(source: SolverProblem, destination: SolverProblem): string[] | undefined {
  const frozen = (problem: SolverProblem, file: string) => canonicalMathJson([problem.declarations[file] ?? null,
    problem.sourceStructure[file] ?? null, problem.sourceImports?.[file] ?? null, problem.frozenFiles?.[file] ?? null]);
  if (source.kind !== destination.kind || source.projectRelative !== destination.projectRelative ||
      canonicalMathJson([source.contract, source.targets, source.trustedFiles]) !==
        canonicalMathJson([destination.contract, destination.targets, destination.trustedFiles]) ||
      source.ownedFiles.some(file => !destination.ownedFiles.includes(file) || frozen(source, file) !== frozen(destination, file)))
    return undefined;
  const added = destination.ownedFiles.filter(file => !source.ownedFiles.includes(file));
  return added.length ? added : undefined;
}
const commonDirectory = (worktree: string) => git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

function textFile(file: string) {
  assertMathCanonicalPath(file);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readMathFile(file, 16_000_000).bytes);
}

function assertPrepared(state: SolverRunState, stateFile: string, seeded: boolean) {
  const directory = path.dirname(stateFile);
  if (state.phase !== 'prepared' || state.turns !== 0 || state.solveStartedAt !== undefined ||
      state.solveFinishedAt !== undefined || state.threadId || state.previousThreadIds?.length || state.check ||
      state.candidate || state.winningWorker || state.lastActivity || state.lastFailure || state.lastContextManifest ||
      state.usage || state.usageBeforeThread || state.usageAccounting || state.requestUsageAccounting ||
      state.failures?.length || Object.values(state.dispatchCounts ?? {}).some(value => value !== 0) ||
      state.coordination !== 'cooperative' || !state.workers?.length || state.workerCount !== state.workers.length ||
      state.worktree !== path.join(directory, 'worktree') || state.workers[0].id !== 'solver' ||
      state.workers[0].role !== 'lead' || state.workers.some((worker, index) =>
        worker.worktree !== path.join(directory, index ? `worktree-${index + 1}` : 'worktree') ||
        worker.phase !== 'prepared' || worker.turns !== 0 || worker.threadId || worker.previousThreadIds?.length ||
        worker.sessionTaskId || worker.sessionTaskVersion || worker.sessionAssignmentId || worker.sessionRole || worker.sessionGroupId ||
        worker.sessionStatementReview || worker.lastActivity || worker.lastFailure || worker.lastContextManifest || worker.check || worker.candidate ||
        worker.usage || worker.usageBeforeThread || worker.usageAccounting || worker.requestUsageAccounting || worker.failures?.length ||
        Object.values(worker.dispatchCounts ?? {}).some(value => value !== 0)) ||
      (!seeded && (state.cooperation !== undefined || state.continuationDigest !== undefined)))
    throw new Error('math_continuation_seed_requires_fresh_prepared_run');
  assertMathCanonicalPath(directory);
  const stat = fs.statSync(directory);
  if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))
    throw new Error('math_state_directory_not_private');
  for (const worker of state.workers) assertMathCanonicalPath(worker.worktree);
  if (!repositoryRelativePath(state.problem.projectRelative) ||
      state.problem.ownedFiles.some(file => !repositoryRelativePath(file))) throw new Error('math_continuation_seed_invalid_source_path');
  const current = readSolverProblem(state.problem.workspace, state.problem.activeProblemPath);
  if (policyDigest(current) !== policyDigest(state.problem)) throw new Error('math_continuation_seed_source_policy_changed');
}

function validatePlan(state: SolverRunState, value: unknown) {
  const plan = parseCooperationPlan(state.problem, value);
  for (const task of plan.tasks) if (task.ownerId && !state.workers!.some(worker => worker.id === task.ownerId &&
    researchWorkerCanTask(worker, task)))
    throw new Error('math_plan_task_owner_unavailable');
  for (const group of plan.groups) if (group.engineerId &&
    !state.workers!.some(worker => worker.id === group.engineerId && worker.role === 'engineer'))
    throw new Error('math_plan_group_engineer_unavailable');
  return plan;
}

// An interrupted first plan has no accepted graph to replay. Keep that absence
// explicit so normal cooperation asks the Lead for its first accepted plan.
const emptyInitialPlan = z.object({ tasks: z.array(z.never()).length(0), groups: z.array(z.never()).length(0) }).strict()
  .transform(value => ({ tasks: value.tasks, groups: value.groups }));
function validateSeedPlan(state: SolverRunState, source: SeedSource): ReturnType<typeof validatePlan> {
  if (!source.initialPlanning) return validatePlan(state, source.plan);
  if (source.candidateIds.length || source.conditionalCandidates?.length || source.frozenCandidates?.length || source.capacityExplorations ||
      source.completedResearch || source.researchContext || source.nextChecks || source.taskDrafts?.length)
    throw new Error('math_continuation_seed_initial_plan_invalid');
  return emptyInitialPlan.parse(source.plan);
}

function initialPlanningOnly(state: SolverRunState) {
  const cooperation = state.cooperation!;
  const noStartedTurns = state.turns === 0 && state.workers!.every(worker => worker.turns === 0 && !worker.threadId &&
    !worker.previousThreadIds?.length && !worker.usageAccounting?.startedTurns) &&
    !state.threadId && !state.previousThreadIds?.length && !state.usageAccounting?.startedTurns;
  const onlyPlanning = (record: Pick<SolverRunState, 'turns' | 'dispatchCounts'>) =>
    record.dispatchCounts?.planning === record.turns && Object.entries(record.dispatchCounts)
      .every(([kind, turns]) => kind === 'planning' || turns === 0);
  const lead = state.workers![0];
  const startedLead = state.turns > 0 && onlyPlanning(state) && lead.id === 'solver' && lead.role === 'lead' &&
    lead.turns === state.turns && onlyPlanning(lead) && lead.sessionRole === 'lead' &&
    !lead.sessionTaskId && !lead.sessionTaskVersion && !lead.sessionAssignmentId && !lead.sessionGroupId &&
    !lead.sessionStatementReview && !lead.check?.passed && (!lead.candidate || lead.candidate.status === 'failed') &&
    state.workers!.slice(1).every(worker => worker.turns === 0 && !worker.threadId &&
      !worker.previousThreadIds?.length && !worker.usageAccounting?.startedTurns && !worker.requestUsageAccounting?.startedRequests &&
      Object.values(worker.dispatchCounts ?? {}).every(turns => turns === 0) && !worker.check && !worker.candidate &&
      !worker.sessionTaskId && !worker.sessionAssignmentId && !worker.sessionTaskVersion && !worker.sessionGroupId) &&
    cooperation.planVersion === mathDigest(canonicalMathJson({ tasks: [], groups: cooperation.groups?.map(route => route.group) }));
  // preserveLeadDraft records this bookkeeping when the first plan is rejected. It
  // carries no task or proof authority and must not make an absent graph look accepted.
  const savedInitialDraftsOnly = startedLead && (cooperation.deliveries ?? []).every(delivery =>
    delivery.producer === lead.id && delivery.kind === 'progress' && delivery.status === 'advisory' &&
    delivery.commit === cooperation.canonicalCommit && delivery.summary.startsWith('Saved Lead draft pending integration:') &&
    delivery.statement === state.problem.contract.formalStatement &&
    canonicalMathJson(delivery.premises) === canonicalMathJson(state.problem.contract.assumptions) &&
    !delivery.taskId && !delivery.taskDigest && !delivery.groupId && !delivery.dependencies?.length &&
    !delivery.remainingObligations?.length && !delivery.evidence && !delivery.evidenceRefs?.length &&
    !delivery.artifacts && !delivery.actualReferences && !delivery.researchRecord && !delivery.lemmaRequests?.length);
  return (noStartedTurns || startedLead) && !state.check && !state.candidate && !state.winningWorker && !state.continuationDigest &&
    cooperation.canonicalCommit === state.problem.baseCommit && !cooperation.tasks.length &&
    !cooperation.groups?.length && !cooperation.proofRoutes?.length && !cooperation.history?.length &&
    (!cooperation.deliveries?.length || savedInitialDraftsOnly) && !cooperation.initialPlanPublication && !cooperation.planPublication &&
    !cooperation.initialPlanFallback && !cooperation.planEdited && !cooperation.edits?.length &&
    !cooperation.planApproval && !cooperation.statementReviews?.length && !cooperation.proofReadyRecords?.length &&
    !cooperation.proofImports?.length && !cooperation.deliveryReceipts?.length &&
    !cooperation.capacityExplorationInputs?.length;
}

function capturedCapacityRecords(state: SolverRunState): CapacityRecord[] {
  const records = new Map<string, CapacityRecord>();
  const add = (node: Partial<Pick<TaskRecord, 'task' | 'capacityExploration' | 'status' | 'finding'>>, archived = false) => {
    if (!node.capacityExploration) return;
    const record = capacityRecord.parse({ task: node.task, capacityExploration: node.capacityExploration,
      status: node.status ?? 'blocked', ...(node.finding === undefined ? {} : { finding: node.finding }),
      ...(archived ? { archived: true } : {}) });
    records.set(canonicalMathJson([record.task.id, record.capacityExploration]), record);
  };
  for (const item of state.cooperation?.history ?? []) add(item, true);
  for (const node of state.cooperation?.tasks ?? []) add(node);
  return [...records.values()];
}

function capturedCompletedResearch(state: SolverRunState,
  previous: readonly CompletedResearchRecord[] = []): CompletedResearchRecord[] {
  const key = (record: CompletedResearchRecord) => 'record' in record ? `record:${record.record.id}` :
    canonicalMathJson(['legacy', taskVersion(record.task), 'inputDigest' in record ? record.inputDigest : null, record.finding ?? null]);
  const records = new Map<string, CompletedResearchRecord>(previous.map(record => [key(record), { ...record, archived: true }]));
  for (const node of state.cooperation!.history ?? []) if (continuableResearch(node.task) && node.researchCompletion) {
    const record = immutableCompletedResearchRecord.parse({ task: node.task, finding: node.finding,
      record: node.researchCompletion, archived: true });
    records.set(key(record), record);
  }
  for (const node of plannedTaskRecords(state.cooperation!.tasks)) {
    if (!continuableResearch(node.task) || node.status !== 'completed') continue;
    // A completion's inputs are fixed when it is published, never reconstructed
    // from newer canonical sources or guessed from equal finding text.
    const record = node.researchCompletion ? immutableCompletedResearchRecord.parse({ task: node.task, finding: node.finding,
      record: node.researchCompletion }) : unboundCompletedResearchRecord.parse({ task: node.task, finding: node.finding, archived: true });
    records.set(key(record), record);
  }
  return [...records.values()];
}

function currentCompletedResearch(source: SeedSource, state: SolverRunState, tasks: readonly CooperativeTask[],
  checkedTasks?: readonly TaskRecord[], deliveries?: readonly DeliveryRecord[]) {
  const context = source.researchContext;
  if (!context) return new Map<string, z.infer<typeof immutableCompletedResearchRecord>>();
  const view = { problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest,
    retrievalDigest: state.retrievalDigest, knowledgeDigest: state.knowledgeDigest,
    tasks: context.tasks, deliveries: context.deliveries };
  const sourceDigest = (task: CooperativeTask) => researchSourceDigest(scopedResearchSources(state.problem, task,
    source.canonicalSources, context.tasks));
  const current = new Map<string, z.infer<typeof immutableCompletedResearchRecord>>();
  for (const record of source.completedResearch ?? []) {
    const task = tasks.find(task => task.id === record.task.id);
    if (record.archived || !('record' in record) || !task ||
        restoreResearch(record.record, task, { ...view, sourceDigest: sourceDigest(task) }, record.finding).status !== 'completed') continue;
    current.set(task.id, record);
  }
  if (checkedTasks) {
    // Rechecks may invalidate a previously passing dependency. Remove affected
    // completions and their dependent findings until the advisory view is stable.
    let changed: boolean;
    do {
      changed = false;
      const checkedView = { ...view, deliveries: deliveries ?? context.deliveries,
        tasks: checkedTasks.map(node => continuableResearch(node.task) && !node.capacityExploration ?
          { ...node, status: current.has(node.task.id) ? 'completed' as const : 'pending' as const,
            finding: current.get(node.task.id)?.finding } : node) };
      for (const [id, record] of current) if (restoreResearch(record.record,
        tasks.find(task => task.id === id)!, { ...checkedView,
          sourceDigest: sourceDigest(tasks.find(task => task.id === id)!) }, record.finding).status !== 'completed') {
        current.delete(id); changed = true;
      }
    } while (changed);
  }
  return current;
}

function completedResearchHistory(source: SeedSource,
  current: ReturnType<typeof currentCompletedResearch> = new Map()) {
  return (source.completedResearch ?? []).filter(record => current.get(record.task.id) !== record)
    .map(record => ({ task: record.task, status: 'completed', finding: record.finding,
      ...('record' in record ? { researchCompletion: record.record } : {}) }));
}

function capacityOrigin(records: readonly CapacityRecord[]) {
  return records.map(({ task, capacityExploration, finding }) => ({ task, capacityExploration,
    ...(finding === undefined ? {} : { finding }) })).sort((left, right) =>
    canonicalMathJson(left).localeCompare(canonicalMathJson(right)));
}

function archivedCapacity(record: CapacityRecord) {
  return { task: record.task as CooperativeTask, capacityExploration: record.capacityExploration,
    status: record.status, producer: record.capacityExploration.workerId,
    ...(record.finding === undefined ? {} : { finding: record.finding }) };
}

function advisoryResearchDelivery(delivery: DeliveryRecord): DeliveryRecord {
  // Publication provenance is useful; old proof evidence, references, artifacts,
  // assignment keys and acceptance statuses are never replayed into the new host.
  return researchDelivery.parse({ id: delivery.id, producer: delivery.producer, taskId: delivery.taskId,
    taskDigest: delivery.taskDigest, groupId: delivery.groupId, kind: 'research',
    status: delivery.status === 'superseded' ? 'superseded' : 'advisory', statement: delivery.statement,
    premises: delivery.premises, dependencies: delivery.dependencies, remainingObligations: delivery.remainingObligations,
    summary: delivery.summary, evidenceRefs: delivery.evidenceRefs, createdAt: delivery.createdAt,
    commit: delivery.commit, sourceDigest: delivery.sourceDigest, finding: delivery.finding,
    findingDigest: delivery.findingDigest, researchRecord: delivery.researchRecord,
    mathematicalGap: delivery.mathematicalGap, mathematicalGapScope: delivery.mathematicalGapScope,
    checkOutcome: delivery.checkOutcome, checkOutcomeScope: delivery.checkOutcomeScope,
    sourceUses: delivery.sourceUses, searchCheckpoint: delivery.searchCheckpoint,
    lemmaRequests: delivery.lemmaRequests });
}

function capturedResearchContext(state: SolverRunState): z.infer<typeof researchContext> {
  return researchContext.parse({ environmentDigest: state.environmentDigest, problemReceiptDigest: state.problem.receiptDigest,
    tasks: researchSourceTasks(state.cooperation!.tasks).map(node => ({ ...node,
      proof: node.proof?.taskDigest ? node.proof : undefined,
      integratedCheck: node.integratedCheck?.taskDigest ? node.integratedCheck : undefined })),
    deliveries: (state.cooperation!.deliveries ?? []).filter(delivery => delivery.kind === 'research' &&
      delivery.taskId && delivery.taskDigest).map(advisoryResearchDelivery) });
}

function restoredResearchDeliveries(source: SeedSource, state: SolverRunState): DeliveryRecord[] {
  const nodes = new Map(state.cooperation!.tasks.map(node => [node.task.id, node.task]));
  const deliveries = new Map((source.researchContext?.deliveries ?? []).map(delivery => {
    const task = nodes.get(delivery.taskId!);
    const current = source.researchContext!.environmentDigest === state.environmentDigest &&
      source.researchContext!.problemReceiptDigest === state.problem.receiptDigest && task &&
      taskVersion(task) === delivery.taskDigest && delivery.dependencies.every(input =>
        nodes.has(input.taskId) && taskVersion(nodes.get(input.taskId)!) === input.taskDigest);
    return [delivery.id, { ...delivery, status: current ? delivery.status : 'superseded' as const }];
  }));
  return [...deliveries.values()];
}

const draftOutputDigest = researchCheckpointOutputDigest;
const ordinaryCheckpointTask = (node: TaskRecord) => continuableResearch(node.task) && !node.capacityExploration && !node.nextCheckId;
const pausedResearchCheckpoint = (node: TaskRecord, checkpoint?: ResearchCheckpoint) => ordinaryCheckpointTask(node) &&
  checkpoint?.paused && checkpoint.taskDigest === taskVersion(node.task) && node.status === 'blocked' &&
  node.feedback?.startsWith('math_research_checkpoint_unchanged');

function capturedTaskDrafts(state: SolverRunState, stateFile: string, previous: readonly SavedTaskDraft[] = []) {
  const key = (draft: SavedTaskDraft) => canonicalMathJson([draft.source, draft.taskId, draft.taskDigest,
    draft.workerId, draft.seedCommit, draft.canonicalCommit ?? null, draft.commit]);
  const drafts = new Map<string, SavedTaskDraft>(previous.map(draft => [key(draft), { ...draft, archived: true }]));
  const origin = { runId: state.runId, stateFile, environmentDigest: state.environmentDigest,
    problemReceiptDigest: state.problem.receiptDigest, sourcePolicyDigest: policyDigest(state.problem) };
  for (const [taskId, snapshot] of Object.entries(state.cooperation!.researchDrafts ?? {})) {
    const node = state.cooperation!.tasks.find(node => node.task.id === taskId);
    const task = node?.task && taskVersion(node.task) === snapshot.taskDigest ? node.task :
      state.cooperation!.history?.find(record => record.task.id === taskId && taskVersion(record.task) === snapshot.taskDigest)?.task;
    const assignment = node?.assignment;
    const checkpoint = state.cooperation!.researchCheckpoints?.[taskId];
    const current = node && taskVersion(node.task) === snapshot.taskDigest &&
      (['pending', 'running'].includes(node.status) || pausedResearchCheckpoint(node, checkpoint) &&
        checkpoint!.outputDigest === snapshot.outputDigest) &&
      assignment?.taskDigest === snapshot.taskDigest && assignment.workerId === snapshot.workerId &&
      assignment.assignmentId === snapshot.assignmentId && assignment.seedCommit === snapshot.seedCommit &&
      assignment.canonicalCommit === snapshot.canonicalCommit &&
      snapshot.outputDigest === draftOutputDigest(state.problem, state.worktree, snapshot.commit) &&
      snapshot.artifacts.problemReceiptDigest === state.problem.receiptDigest && snapshot.artifacts.taskId === taskId &&
      snapshot.artifacts.taskDigest === snapshot.taskDigest && snapshot.artifacts.seedCommit === snapshot.seedCommit &&
      snapshot.artifacts.commit === snapshot.commit;
    const prior = previous.find(draft => !draft.archived && draft.taskId === taskId && draft.taskDigest === snapshot.taskDigest &&
      draft.workerId === snapshot.workerId && draft.seedCommit === snapshot.seedCommit &&
      draft.canonicalCommit === snapshot.canonicalCommit && draft.commit === snapshot.commit &&
      draft.outputDigest === snapshot.outputDigest && draft.source.environmentDigest === origin.environmentDigest &&
      draft.source.problemReceiptDigest === origin.problemReceiptDigest && draft.source.sourcePolicyDigest === origin.sourcePolicyDigest);
    const draft = savedTaskDraft.parse({ taskId, taskDigest: snapshot.taskDigest, workerId: snapshot.workerId,
      assignmentId: prior?.assignmentId ?? snapshot.assignmentId, seedCommit: snapshot.seedCommit,
      canonicalCommit: snapshot.canonicalCommit, commit: snapshot.commit, outputDigest: snapshot.outputDigest,
      task, suspended: snapshot.suspended, ...(current ? {} : { archived: true }),
      sources: Object.fromEntries(state.problem.ownedFiles.map(file => [file,
        committedSource(state.worktree, snapshot.commit, `${state.problem.projectRelative}/${file}`)])),
      notes: git(state.worktree, ['ls-tree', '--format=%(objectname)', snapshot.commit, '--', 'RESEARCH.md'])
        ? committedSource(state.worktree, snapshot.commit, 'RESEARCH.md') : null,
      source: prior?.source ?? origin });
    drafts.set(key(draft), draft);
  }
  return [...drafts.values()];
}

function capturedResearchCheckpoints(state: SolverRunState, stateFile: string, drafts: readonly SavedTaskDraft[]) {
  const checkpoints: SavedResearchCheckpoint[] = [];
  for (const [taskId, checkpoint] of Object.entries(state.cooperation!.researchCheckpoints ?? {})) {
    const node = state.cooperation!.tasks.find(node => node.task.id === taskId);
    const draft = drafts.find(draft => !draft.archived && draft.taskId === taskId &&
      draft.taskDigest === checkpoint.taskDigest && draft.outputDigest === checkpoint.outputDigest &&
      draft.workerId === node?.assignment?.workerId);
    if (!node || !ordinaryCheckpointTask(node) || taskVersion(node.task) !== checkpoint.taskDigest || !draft ||
        !(['pending', 'running'].includes(node.status) || pausedResearchCheckpoint(node, checkpoint))) continue;
    const { blockerId: _oldBlocker, ...scheduling } = checkpoint;
    checkpoints.push(savedResearchCheckpoint.parse({ taskId, workerId: draft.workerId, checkpoint: scheduling,
      source: { runId: state.runId, stateFile, environmentDigest: state.environmentDigest,
        problemReceiptDigest: state.problem.receiptDigest, sourcePolicyDigest: policyDigest(state.problem) } }));
  }
  return checkpoints;
}

/** Saved bytes and the effective current inputs must agree before restoring a scheduling pause. */
function currentResearchCheckpoints(source: SeedSource, state: SolverRunState) {
  const checkpoints = new Map<string, SavedResearchCheckpoint>();
  if (source.ownershipExtension || !state.cooperation) return checkpoints;
  const cooperation = state.cooperation;
  for (const saved of source.researchCheckpoints ?? []) {
    const node = cooperation.tasks.find(node => node.task.id === saved.taskId);
    const draft = cooperation.researchDrafts?.[saved.taskId], checkpoint = saved.checkpoint;
    if (!node || !ordinaryCheckpointTask(node) || !['pending', 'blocked'].includes(node.status) ||
        taskVersion(node.task) !== checkpoint.taskDigest || node.assignment?.workerId !== saved.workerId ||
        !draft || draft.taskDigest !== checkpoint.taskDigest || draft.workerId !== saved.workerId ||
        draft.assignmentId !== node.assignment.assignmentId || draft.outputDigest !== checkpoint.outputDigest ||
        saved.source.environmentDigest !== state.environmentDigest ||
        saved.source.problemReceiptDigest !== state.problem.receiptDigest ||
        saved.source.sourcePolicyDigest !== policyDigest(state.problem)) continue;
    const input = { task: node.task, workerId: saved.workerId, tasks: cooperation.tasks, deliveries: cooperation.deliveries ?? [],
      environmentDigest: state.environmentDigest, problemReceiptDigest: state.problem.receiptDigest };
    const sameInput = checkpoint.localInputDigest
      ? checkpoint.localInputDigest === researchCheckpointLocalInputDigest(input)
      : checkpoint.inputDigest === researchCheckpointInputDigest({ ...input, problem: state.problem,
        worktree: state.worktree, canonicalCommit: cooperation.canonicalCommit! });
    if (sameInput) checkpoints.set(saved.taskId, saved);
  }
  return checkpoints;
}

function taskDraftAssignment(draft: SavedTaskDraft, task: CooperativeTask,
  tasks: readonly TaskRecord[], state: SolverRunState): TaskAssignment {
  const assignment: TaskAssignment = { taskId: draft.taskId, taskDigest: draft.taskDigest, workerId: draft.workerId,
    seedCommit: draft.seedCommit, canonicalCommit: draft.canonicalCommit,
    assignmentId: mathDigest(canonicalMathJson({ runId: state.runId, draft: { source: draft.source,
      taskId: draft.taskId, taskDigest: draft.taskDigest, workerId: draft.workerId,
      assignmentId: draft.assignmentId, seedCommit: draft.seedCommit, commit: draft.commit } })),
    groupId: taskGroup(task), dependencies: taskDependencyRecords(task, tasks)
      .map(node => ({ taskId: node.task.id, taskDigest: taskVersion(node.task) })) };
  if (automaticTaskConnection(task, tasks, state.cooperation!.groups))
    assignment.connectionCheck = createTaskConnectionCheck(task, assignment, tasks,
      { environmentDigest: state.environmentDigest, problemReceiptDigest: state.problem.receiptDigest },
      input => committedSource(state.worktree, draft.seedCommit, `${state.problem.projectRelative}/${input.proofPath}`));
  return assignment;
}

function restorableTaskDraft(draft: SavedTaskDraft, node: TaskRecord, state: SolverRunState) {
  const worker = state.workers!.find(worker => worker.id === draft.workerId);
  return !draft.archived && (node.status === 'pending' ||
    pausedResearchCheckpoint(node, state.cooperation!.researchCheckpoints?.[node.task.id])) && !node.alternativeRoutes?.length &&
    draft.taskId === node.task.id && draft.taskDigest === taskVersion(node.task) &&
    draft.source.environmentDigest === state.environmentDigest && draft.source.problemReceiptDigest === state.problem.receiptDigest &&
    draft.source.sourcePolicyDigest === policyDigest(state.problem) && worker &&
    assessTaskResponsibility({ ...node, assignment: undefined }, worker,
      { tasks: state.cooperation!.tasks, groups: state.cooperation!.groups }).kind === 'matches';
}

function frozenTaskAssignment(candidate: z.infer<typeof frozenCandidate>, task: CooperativeTask,
  identity: { runId: string; sourceRunId: string; canonicalCommit: string }): TaskAssignment {
  return { taskId: candidate.taskId, taskDigest: candidate.taskDigest, workerId: candidate.workerId,
    seedCommit: candidate.seedCommit, canonicalCommit: identity.canonicalCommit,
    assignmentId: mathDigest(canonicalMathJson({ runId: identity.runId, sourceRunId: identity.sourceRunId,
      readyId: candidate.readyId, snapshotCommit: candidate.snapshotCommit })),
    groupId: taskGroup(task), dependencies: candidate.dependencies };
}

function captureSource(sourceStateFile: string, stateFile: string, state: SolverRunState, sourceLease?: MathLease): SeedSource {
  const archived = readSolverRunState(sourceStateFile);
  const sameProblem = archived.problem.receiptDigest === state.problem.receiptDigest &&
    policyDigest(archived.problem) === policyDigest(state.problem);
  const added = sameProblem ? undefined : ownershipExtension(archived.problem, state.problem);
  if (archived.runId === state.runId || archived.taskDigest !== state.taskDigest || (!sameProblem && !added))
    throw new Error('math_continuation_seed_identity_changed');
  if (!archived.cooperation?.canonicalCommit || !archived.workers?.length)
    throw new Error('math_continuation_seed_source_incomplete');
  const planned = plannedTaskRecords(archived.cooperation.tasks);
  // A smaller destination team cannot staff every historical owner. Ownership is
  // scheduling metadata outside taskVersion, so release only those assignments.
  const staffed = (task: CooperativeTask) => !task.ownerId || state.workers!.some(worker =>
    worker.id === task.ownerId && researchWorkerCanTask(worker, task));
  const initialPlanning = initialPlanningOnly(archived);
  const plan: ReturnType<typeof validatePlan> = initialPlanning ? emptyInitialPlan.parse({ tasks: [], groups: [] }) : validatePlan(state, { tasks: planned.map(({ task }) => {
    if (staffed(task)) return task;
    const { ownerId: _released, ...unowned } = task;
    return unowned;
  }),
    groups: archived.cooperation.groups?.map(record => record.group), proofRoutes: archived.cooperation.proofRoutes });
  if (plan.tasks.some((task, index) => taskVersion(task) !== taskVersion(planned[index].task)))
    throw new Error('math_continuation_seed_task_identity_changed');
  // An extended destination is a new bootstrap workspace, so source commits are read from their own repository.
  const sourceDirectory = path.dirname(sourceStateFile);
  if (archived.worktree !== path.join(sourceDirectory, 'worktree')) throw new Error('math_continuation_seed_repository_changed');
  const common = commonDirectory(archived.worktree);
  if (!added && common !== commonDirectory(state.worktree)) throw new Error('math_continuation_seed_repository_changed');
  for (const [file, expected] of Object.entries(state.problem.trustedFiles))
    if (mathDigest(committedSource(archived.worktree, archived.cooperation.canonicalCommit,
      `${state.problem.projectRelative}/${file}`)) !== expected) throw new Error('math_continuation_seed_source_policy_changed');
  const historicalSources = (commit: string) => Object.fromEntries(state.problem.ownedFiles.map(file => [file,
    added?.includes(file) ? committedSource(state.worktree, state.problem.baseCommit, `${state.problem.projectRelative}/${file}`)
      : committedSource(archived.worktree, commit, `${state.problem.projectRelative}/${file}`)]));
  const canonicalSources = historicalSources(archived.cooperation.canonicalCommit);
  const snapshot = archived.continuationDigest ? readContinuationSnapshot(path.join(sourceDirectory, 'continuation.json'),
    archived.continuationDigest, { taskDigest: archived.taskDigest, problemReceiptDigest: archived.problem.receiptDigest }) : undefined;
  const frozenCandidates: z.infer<typeof frozenCandidate>[] = [];
  const frozenRecords = (archived.cooperation.proofReadyRecords ?? []).filter(record => record.status === 'frozen');
  if (frozenRecords.length) {
    if (!sourceLease) throw new Error('math_continuation_seed_frozen_source_lease_required');
    sourceLease.assertHeld();
    if ([archived, ...archived.workers].some(worker => worker.writerStopUnconfirmed))
      throw new Error('math_continuation_seed_frozen_writer_unconfirmed');
    for (const ready of frozenRecords) {
      if (!proofReadyRecordSchema.safeParse(ready).success) throw new Error('math_continuation_seed_frozen_identity_changed');
      const node = planned.find(node => node.task.id === ready.taskId);
      let assignment = node?.assignment;
      // Timeout recovery can release scheduling assignments while retaining a frozen proof.
      // Only its pinned prior continuation can reconstruct the exact imported assignment.
      const attachment = snapshot?.manifest.attachments.find(item => item.id === `frozen-${ready.taskId}` && item.kind === 'proof-source');
      if (node && !assignment && attachment?.provenance.runId) {
        const bytes = readMathFile(path.join(sourceDirectory, attachment.contentPath), attachment.bytes).bytes;
        if (bytes.length !== attachment.bytes || mathDigest(bytes) !== attachment.sha256)
          throw new Error('math_continuation_content_changed');
        const candidate = frozenCandidate.parse(JSON.parse(bytes.toString('utf8')));
        assignment = frozenTaskAssignment(candidate, node.task, { runId: archived.runId,
          sourceRunId: attachment.provenance.runId, canonicalCommit: archived.cooperation.canonicalCommit });
        const expected = proofReadyRecord({ assignment, workerId: candidate.workerId,
          submissionId: mathDigest(canonicalMathJson({ sourceRunId: attachment.provenance.runId,
            readyId: candidate.readyId, runId: archived.runId })),
          problemReceiptDigest: candidate.problemReceiptDigest, environmentDigest: candidate.environmentDigest,
          now: ready.requestedAt });
        if (attachment.provenance.commit !== candidate.snapshotCommit || candidate.snapshotCommit !== ready.snapshotCommit ||
            candidate.sourceDigest !== ready.sourceDigest || candidate.environmentDigest !== ready.environmentDigest ||
            candidate.problemReceiptDigest !== ready.problemReceiptDigest || expected.id !== ready.id ||
            expected.submissionId !== ready.submissionId)
          throw new Error('math_continuation_seed_frozen_identity_changed');
      }
      const worker = archived.workers.find(worker => worker.id === ready.workerId);
      if (!node || !assignment || !worker || ready.taskDigest !== taskVersion(node.task) ||
          assignment.taskId !== ready.taskId || assignment.taskDigest !== ready.taskDigest ||
          assignment.workerId !== ready.workerId || ready.assignmentKey !== assignmentDeliveryFile(assignment) ||
          ready.seedCommit !== assignment.seedCommit || ready.problemReceiptDigest !== archived.problem.receiptDigest ||
          ready.environmentDigest !== archived.environmentDigest ||
          ready.sourceDigest !== ownedSourceDigest(archived.problem, archived.worktree, ready.snapshotCommit!))
        throw new Error('math_continuation_seed_frozen_identity_changed');
      // Changed scopes and conditional inputs remain advisory drafts. This path only restores an
      // exact ordinary task with the same proof environment, source policy and available worker.
      const destinationTask = plan.tasks.find(task => task.id === node.task.id);
      const destinationWorker = state.workers!.find(worker => worker.id === ready.workerId);
      if (added || !sameProblem || state.environmentDigest !== ready.environmentDigest ||
          !destinationTask || !destinationWorker || taskVersion(destinationTask) !== ready.taskDigest ||
          !['goal', 'lemma'].includes(node.task.kind) || isDefinitionTask(node.task) || node.task.conditional ||
          assignment.connectionCheck || assignment.routeId || node.alternativeRoutes?.length ||
          (node.task.status ?? 'active') !== 'active' || !['pending', 'running'].includes(node.status) ||
          assessTaskResponsibility({ task: destinationTask, status: 'pending', attempts: 0 }, destinationWorker,
            { tasks: plan.tasks.map(task => ({ task, status: 'pending' as const, attempts: 0 })),
              groups: plan.groups.map(group => ({ group, turns: 0 })) }).kind !== 'matches') continue;
      const dependencies = assignment.dependencies ?? [];
      if (dependencies.some(reference => !plan.tasks.some(task => task.id === reference.taskId && taskVersion(task) === reference.taskDigest)))
        throw new Error('math_continuation_seed_frozen_identity_changed');
      if (frozenCandidates.some(candidate => candidate.taskId === ready.taskId || candidate.workerId === ready.workerId))
        throw new Error('math_continuation_seed_frozen_candidate_conflict');
      frozenCandidates.push({ taskId: ready.taskId, taskDigest: ready.taskDigest, workerId: ready.workerId,
        readyId: ready.id, submissionId: ready.submissionId, assignmentKey: ready.assignmentKey,
        seedCommit: ready.seedCommit, snapshotCommit: ready.snapshotCommit!, sourceDigest: ready.sourceDigest!,
        environmentDigest: ready.environmentDigest, problemReceiptDigest: ready.problemReceiptDigest,
        dependencies, sources: historicalSources(ready.snapshotCommit!), seedSources: historicalSources(ready.seedCommit) });
    }
    sourceLease.assertHeld();
  }
  const workers = archived.workers.map((worker, index) => {
    if (!id.safeParse(worker.id).success || worker.worktree !== path.join(sourceDirectory, index ? `worktree-${index + 1}` : 'worktree'))
      throw new Error('math_continuation_seed_worker_path_changed');
    assertMathCanonicalPath(worker.worktree);
    if (commonDirectory(worker.worktree) !== common) throw new Error('math_continuation_seed_repository_changed');
    const headBefore = git(worker.worktree, ['rev-parse', 'HEAD']);
    const sources = Object.fromEntries(archived.problem.ownedFiles.map(file => [file,
      textFile(path.join(worker.worktree, state.problem.projectRelative, file))]));
    const notesFile = path.join(worker.worktree, 'RESEARCH.md');
    const notes = fs.lstatSync(notesFile, { throwIfNoEntry: false }) ? textFile(notesFile) : null;
    const activeTask = archived.cooperation!.tasks.find(node => node.task.id === worker.sessionTaskId && node.assignment?.workerId === worker.id) ??
      archived.cooperation!.tasks.find(node => node.status === 'running' && node.assignment?.workerId === worker.id);
    return { id: worker.id, role: worker.role, headBefore, headAfter: git(worker.worktree, ['rev-parse', 'HEAD']), sources, notes,
      assignment: activeTask?.assignment };
  });
  const proofHistory = (proof: TaskProof | undefined) => proof && ({ commit: proof.commit, taskDigest: proof.taskDigest,
    seedCommit: proof.seedCommit, passed: proof.passed, conditions: proof.conditions,
    receiptIds: proof.verification.results.map(result => result.receiptId).filter(Boolean) });
  const capacities = capturedCapacityRecords(archived);
  let previousCapacity: z.infer<typeof capacitySource> | undefined;
  let previousResearch: CompletedResearchRecord[] | undefined;
  let previousDrafts: SavedTaskDraft[] | undefined;
  if (snapshot) {
    const attachment = snapshot.manifest.attachments.find(item => item.id === 'seed-capacity-explorations');
    if (attachment) {
      const bytes = readMathFile(path.join(sourceDirectory, attachment.contentPath), attachment.bytes).bytes;
      if (bytes.length !== attachment.bytes || mathDigest(bytes) !== attachment.sha256)
        throw new Error('math_continuation_content_changed');
      previousCapacity = capacitySource.parse(JSON.parse(bytes.toString('utf8')));
      const captured = new Set(capacities.map(record => canonicalMathJson([record.task.id, record.capacityExploration])));
      for (const record of previousCapacity.records)
        if (!captured.has(canonicalMathJson([record.task.id, record.capacityExploration]))) capacities.push({ ...record, archived: true });
    }
    const research = snapshot.manifest.attachments.find(item => item.id === 'seed-completed-research');
    if (research) {
      const bytes = readMathFile(path.join(sourceDirectory, research.contentPath), research.bytes).bytes;
      if (bytes.length !== research.bytes || mathDigest(bytes) !== research.sha256)
        throw new Error('math_continuation_content_changed');
      previousResearch = z.array(completedResearchRecord).parse(JSON.parse(bytes.toString('utf8')));
    }
    const drafts = snapshot.manifest.attachments.find(item => item.id === 'seed-task-drafts');
    if (drafts) {
      const bytes = readMathFile(path.join(sourceDirectory, drafts.contentPath), drafts.bytes).bytes;
      if (bytes.length !== drafts.bytes || mathDigest(bytes) !== drafts.sha256)
        throw new Error('math_continuation_content_changed');
      previousDrafts = z.array(savedTaskDraft).parse(JSON.parse(bytes.toString('utf8')));
    }
  }
  const taskDrafts = capturedTaskDrafts(archived, sourceStateFile, previousDrafts);
  const researchCheckpoints = capturedResearchCheckpoints(archived, sourceStateFile, taskDrafts);
  const capacityVersions = new Set(capacities.map(record =>
    canonicalMathJson([record.task.id, record.capacityExploration.taskDigest])));
  const notes = new Map<string, z.infer<typeof capacitySource>['notes'][number]>();
  for (const note of previousCapacity?.notes ?? []) if (capacityVersions.has(canonicalMathJson([note.taskId, note.taskDigest])))
    notes.set(canonicalMathJson([note.taskId, note.taskDigest, note.commit]), note);
  for (const delivery of archived.cooperation.deliveries ?? []) {
    if (delivery.kind !== 'research' || !delivery.commit || !delivery.taskId || !delivery.taskDigest ||
        !capacityVersions.has(canonicalMathJson([delivery.taskId, delivery.taskDigest]))) continue;
    const key = canonicalMathJson([delivery.taskId, delivery.taskDigest, delivery.commit]);
    if (!notes.has(key)) notes.set(key, { taskId: delivery.taskId, taskDigest: delivery.taskDigest,
      deliveryId: delivery.id, commit: delivery.commit,
      notes: committedSource(archived.worktree, delivery.commit, 'RESEARCH.md') });
  }
  const completedResearch = capturedCompletedResearch(archived, previousResearch);
  const context = capturedResearchContext(archived);
  const conditionalCandidates = planned.filter(node => !isAdvisoryTask(node.task) &&
    !(node.proof?.passed && !node.proof.conditions?.length) &&
    !(node.integratedCheck?.passed && !node.integratedCheck.conditions?.length) &&
    (node.proof?.passed && node.proof.conditions?.length || node.integratedCheck?.passed && node.integratedCheck.conditions?.length))
    .map(node => {
      const proof = node.proof?.passed && node.proof.conditions?.length ? node.proof : node.integratedCheck!;
      const evidence = { taskId: node.task.id, taskDigest: proof.taskDigest, commit: proof.commit,
        seedCommit: proof.seedCommit, conditions: proof.conditions!, dependencies: node.assignment?.dependencies ?? [] };
      try {
        if (!oid.safeParse(proof.commit).success || !oid.safeParse(proof.seedCommit).success)
          throw new Error('math_continuation_seed_conditional_commit_invalid');
        return { ...evidence, sources: historicalSources(proof.commit), seedSources: historicalSources(proof.seedCommit) };
      } catch (error) {
        return { ...evidence, captureError: error instanceof Error ? error.message : 'math_task_source_unavailable' };
      }
    });
  const value = { schema: 'theorem-os.continuation-seed-source.v1', capturedAt: Date.now(), taskDigest: state.taskDigest,
    problemReceiptDigest: state.problem.receiptDigest, sourcePolicyDigest: policyDigest(state.problem),
    destination: { runId: state.runId, stateFile, buildDigest: state.buildDigest,
      methodDigest: state.methodDigest, environmentDigest: state.environmentDigest },
    source: { runId: archived.runId, stateFile: sourceStateFile, stateDigest: mathDigest(canonicalMathJson(archived)),
      buildDigest: archived.buildDigest, methodDigest: archived.methodDigest, canonicalCommit: archived.cooperation.canonicalCommit,
      planVersion: archived.cooperation.planVersion },
    plan, ...(initialPlanning ? { initialPlanning: true } : {}), canonicalSources, workers, conditionalCandidates,
    ...(frozenCandidates.length ? { frozenCandidates } : {}),
    ...(taskDrafts.length ? { taskDrafts } : {}),
    ...(researchCheckpoints.length ? { researchCheckpoints } : {}),
    candidateIds: planned.filter(node => !isAdvisoryTask(node.task) &&
      ((node.proof?.passed && !node.proof.conditions?.length) ||
        (node.integratedCheck?.passed && !node.integratedCheck.conditions?.length) ||
        // A prior continuation may have rejected correct canonical sources in a
        // broken projection. Reconsider that attempted contract, never its status.
        (node.integratedCheck?.taskDigest === taskVersion(node.task) && !node.integratedCheck.conditions?.length &&
          hasDeterministicLeanFailure(node.integratedCheck.verification)))).map(node => node.task.id),
    ...(capacities.length || archived.cooperation.capacityExplorationInputs !== undefined ? { capacityExplorations: {
      records: capacities, inputs: archived.cooperation.capacityExplorationInputs, notes: [...notes.values()] } } : {}),
    ...(archived.cooperation.nextChecks?.length ? { nextChecks: { records: archived.cooperation.nextChecks,
      tasks: archived.cooperation.tasks.filter(node => node.nextCheckId).map(node => ({ task: node.task,
        nextCheckId: node.nextCheckId!, status: node.status, ...(node.finding ? { finding: node.finding } : {}) })) } } : {}),
    ...(!added && archived.cooperation.goalProgress ? { goalProgress: archived.cooperation.goalProgress } : {}),
    ...(completedResearch.length ? { completedResearch } : {}),
    ...(completedResearch.length || context.deliveries.length ? { researchContext: context } : {}),
    ...(added ? { ownershipExtension: { sourceReceiptDigest: archived.problem.receiptDigest,
      sourcePolicyDigest: policyDigest(archived.problem), addedFiles: added } } : {}),
    history: { evidence: 'recorded-not-replayed', sourcePhase: archived.phase,
      ...(initialPlanning ? { activity: { turns: archived.turns, dispatchCounts: archived.dispatchCounts,
        usage: archived.usage, usageBeforeThread: archived.usageBeforeThread, usageAccounting: archived.usageAccounting,
        requestUsageAccounting: archived.requestUsageAccounting, tokenBudget: archived.tokenBudget,
        workers: archived.workers.map(worker => ({ id: worker.id, role: worker.role, turns: worker.turns,
          dispatchCounts: worker.dispatchCounts, threadId: worker.threadId, previousThreadIds: worker.previousThreadIds,
          usage: worker.usage, usageBeforeThread: worker.usageBeforeThread, usageAccounting: worker.usageAccounting,
          requestUsageAccounting: worker.requestUsageAccounting })) } } : {}),
      tasks: archived.cooperation.tasks.map(node => ({ taskId: node.task.id, taskDigest: taskVersion(node.task), status: node.status,
        attempts: node.attempts, assignment: node.assignment, finding: node.finding,
        proof: proofHistory(node.proof), integratedCheck: proofHistory(node.integratedCheck) })),
      deliveries: archived.cooperation.deliveries?.map(delivery => initialPlanning ? delivery : ({ id: delivery.id, kind: delivery.kind, status: delivery.status,
        taskId: delivery.taskId, taskDigest: delivery.taskDigest, commit: delivery.commit, producer: delivery.producer,
        summary: delivery.summary, evidenceRefs: delivery.evidenceRefs })),
      history: archived.cooperation.history?.map(record => ({ task: record.task, producer: record.producer, finding: record.finding,
        researchCompletion: record.researchCompletion,
        proof: proofHistory(record.proof), integratedCheck: record.integratedCheck && {
          commit: record.integratedCheck.commit, passed: record.integratedCheck.passed } })) },
  };
  return sourceSchema.parse(value);
}

/** Capture advisory source bytes and history without initializing a run or checking a proof. */
export { captureSource as captureSolverContinuationSource };

function freezeSource(source: SeedSource, directory: string) {
  const documents: { id: string; kind: ContinuationManifest['attachments'][number]['kind']; text: string; commit?: null }[] = [
    { id: 'seed-recovery-guide', kind: 'research-notes' as const, text:
      (source.initialPlanning
        ? 'The source published no accepted initial plan. Canonical owned sources, worker drafts and notes were preserved; prior planning turns and usage remain recorded in seed-history. The Lead still owes the first plan covering every original target.\n'
        : 'The canonical owned sources and exact task graph were explicitly initialized in this new run. ') +
      'Historical proof flags, threads and assignments do not authorize work or acceptance. Only freshly checked helpers are integrated; conditional proofs retain their typed obligations.\n' +
      'Per-task saved drafts, including suspended tasks, are preserved in seed-task-drafts with exact sources, missing-versus-empty notes and their original run/commit identities. Compatible drafts resume through the normal task draft restoration; changed task or environment snapshots remain advisory. Inspect draft-WORKER_ID for the current worker workspace as well. Match captured task ids and digests before recovering useful code. Preserve current canonical proofs; recovered drafts still require ordinary typed host checks.\n' +
      'Ordinary research/sketch no-progress counts and pauses are retained in seed-research-checkpoints only while the task, environment, effective inputs and saved task output still match. A pause is scheduling state and never proof acceptance, research completion or mathematical refutation.\n' +
      'The original run may still be progressing. Its canonical sources are pinned to the recorded commit; worker files are individually stable captured bytes, not a globally atomic observation. Repeated initialization uses this same frozen capture.\n' +
      (source.ownershipExtension ? `This run re-bootstraps the same problem with added owned files ${JSON.stringify(source.ownershipExtension.addedFiles)}; ` +
        'they start at their baseline and worker drafts hold only the former owned files. Research findings bound to the former problem receipt are history and their tasks reopen.\n' : '') },
    { id: 'seed-canonical', kind: 'proof-source' as const, text: canonicalMathJson({ sources: source.canonicalSources }) },
    { id: 'seed-task-graph', kind: 'diagnostics' as const, text: canonicalMathJson(source.plan) },
    { id: 'seed-history', kind: 'diagnostics' as const, text: canonicalMathJson({ source: source.source, history: source.history,
      capturedAt: source.capturedAt, capture: 'canonical-commit-and-individually-stable-advisory-worker-files' }) },
    ...source.workers.map(worker => ({ id: `draft-${worker.id}`, kind: 'proof-source' as const, text: canonicalMathJson(worker) })),
    ...(source.conditionalCandidates ?? []).map(candidate => ({ id: `conditional-${candidate.taskId}`, kind: 'proof-source' as const,
      text: canonicalMathJson(candidate) })),
    ...(source.frozenCandidates ?? []).map(candidate => ({ id: `frozen-${candidate.taskId}`, kind: 'proof-source' as const,
      text: canonicalMathJson(candidate), commit: candidate.snapshotCommit })),
    ...(source.capacityExplorations ? [{ id: 'seed-capacity-explorations', kind: 'research-notes' as const,
      text: canonicalMathJson(source.capacityExplorations), commit: null }] : []),
    ...(source.completedResearch ? [{ id: 'seed-completed-research', kind: 'research-notes' as const,
      text: canonicalMathJson(source.completedResearch), commit: null }] : []),
    ...(source.researchContext ? [{ id: 'seed-research-context', kind: 'research-notes' as const,
      text: canonicalMathJson(source.researchContext), commit: null }] : []),
    ...(source.taskDrafts ? [{ id: 'seed-task-drafts', kind: 'proof-source' as const,
      text: canonicalMathJson(source.taskDrafts), commit: null }] : []),
    ...(source.researchCheckpoints ? [{ id: 'seed-research-checkpoints', kind: 'diagnostics' as const,
      text: canonicalMathJson(source.researchCheckpoints), commit: null }] : []),
  ];
  const manifest: ContinuationManifest = { schema: 'theorem-os.continuation-snapshot.v1', taskDigest: source.taskDigest,
    problemReceiptDigest: source.problemReceiptDigest, attachments: documents.map(document => {
      const sha256 = mathDigest(document.text);
      return { id: document.id, kind: document.kind, path: `${document.id}.json`, bytes: Buffer.byteLength(document.text), sha256,
        provenance: { evidence: 'recorded-not-replayed', runId: source.source.runId,
          ...(document.commit === null ? {} : { commit: document.commit ?? source.source.canonicalCommit }),
          source: source.source.stateFile }, contentPath: `continuation/${sha256}.txt` };
    }) };
  return freezeContinuationInput({ manifest, digest: mathDigest(canonicalMathJson(manifest)),
    contents: new Map(documents.map(document => [mathDigest(document.text), document.text])) }, directory);
}

/** Explicit initialization of a new, idle run. Historical acceptance is never execution authority. */
export async function seedSolverContinuation(options: {
  sourceRun: string; run: string; root: string; buildManifest: string; signal: AbortSignal; timeoutMs?: number;
  onProgress?: (event: string, details: Record<string, unknown>) => void;
  lease?: MathLease; preparedEnvironment?: NodeJS.ProcessEnv;
  onSeeded?: (state: SolverRunState, freshChecks: TaskProof[]) => void;
}): Promise<ContinuationSeedReport> {
  const target = readRunInspection(options.run), sourceStateFile = path.basename(path.resolve(options.sourceRun)) === 'state.json'
    ? path.resolve(options.sourceRun) : `${path.resolve(options.sourceRun)}.runtime/state.json`;
  const stateFile = target.stateFile, directory = path.dirname(stateFile);
  assertMathCanonicalPath(sourceStateFile);
  if (sourceStateFile === stateFile) throw new Error('math_continuation_seed_identity_changed');
  const seedWithLease = async (lease: MathLease): Promise<ContinuationSeedReport> => {
    const state = readRunInspection(options.run).state;
    const sourceFile = path.join(directory, 'continuation-seed-source.json'), reportFile = path.join(directory, 'continuation-seed.json');
    const seeded = Boolean(fs.lstatSync(sourceFile, { throwIfNoEntry: false }));
    assertPrepared(state, stateFile, seeded);
    const buildFile = fs.realpathSync(options.buildManifest);
    readMathBuildManifest(buildFile, options.root, path.join(options.root, 'out', 'main'));
    if (mathDigest(readMathFile(buildFile).bytes) !== state.buildDigest) throw new Error('math_continuation_seed_build_changed');
    let source: SeedSource;
    if (seeded) {
      assertMathCanonicalPath(sourceFile);
      if ((fs.lstatSync(sourceFile).mode & 0o777) !== 0o400) throw new Error('math_continuation_seed_source_not_frozen');
      source = sourceSchema.parse(readMathJson(sourceFile));
    } else {
      const archived = readSolverRunState(sourceStateFile);
      source = archived.cooperation?.proofReadyRecords?.some(record => record.status === 'frozen')
        ? await withMathRuntimeLease({ lockPath: path.join(path.dirname(sourceStateFile), 'run.lock'),
          flockExecutable: '/usr/bin/flock', signal: lease.signal }, async sourceLease =>
          captureSource(sourceStateFile, stateFile, state, sourceLease))
        : captureSource(sourceStateFile, stateFile, state);
    }
    if (source.taskDigest !== state.taskDigest || source.problemReceiptDigest !== state.problem.receiptDigest ||
        source.sourcePolicyDigest !== policyDigest(state.problem) || source.source.stateFile !== sourceStateFile ||
        source.destination.runId !== state.runId || source.destination.stateFile !== stateFile ||
        source.destination.buildDigest !== state.buildDigest || source.destination.methodDigest !== state.methodDigest ||
        source.destination.environmentDigest !== state.environmentDigest ||
        canonicalMathJson(Object.keys(source.canonicalSources).sort()) !== canonicalMathJson([...state.problem.ownedFiles].sort()))
      throw new Error('math_continuation_seed_identity_changed');
    const plan = validateSeedPlan(state, source);
    const conditional = source.conditionalCandidates ?? [];
    const candidateIds = [...source.candidateIds, ...conditional.map(candidate => candidate.taskId)];
    if (new Set(candidateIds).size !== candidateIds.length || candidateIds.some(candidate =>
      !plan.tasks.some(task => task.id === candidate && !isAdvisoryTask(task))) || conditional.some(candidate =>
      !candidate.captureError && (canonicalMathJson(Object.keys(candidate.sources ?? {}).sort()) !==
        canonicalMathJson([...state.problem.ownedFiles].sort()) ||
        canonicalMathJson(Object.keys(candidate.seedSources ?? {}).sort()) !==
          canonicalMathJson([...state.problem.ownedFiles].sort())))) throw new Error('math_continuation_seed_candidates_invalid');
    const planVersion = source.initialPlanning ? undefined : mathDigest(canonicalMathJson(plan));
    const frozenAssignment = (candidate: z.infer<typeof frozenCandidate>, canonicalCommit: string) =>
      frozenTaskAssignment(candidate, plan.tasks.find(task => task.id === candidate.taskId)!,
        { runId: state.runId, sourceRunId: source.source.runId, canonicalCommit });
    const pendingResearch = new Map<string, z.infer<typeof immutableCompletedResearchRecord>>();
    const restoredResearch = state.cooperation ? currentCompletedResearch(source, state, plan.tasks,
      state.cooperation.tasks, restoredResearchDeliveries(source, state)) : pendingResearch;
    const restoredCheckpoints = currentResearchCheckpoints(source, state);
    const matchesCheckpoint = (taskId: string, checkpoint: ResearchCheckpoint) => {
      const saved = restoredCheckpoints.get(taskId);
      const { blockerId: _localBlocker, ...scheduling } = checkpoint;
      return saved && canonicalMathJson(scheduling) === canonicalMathJson(saved.checkpoint);
    };
    const matchesResearch = (node: TaskRecord, records: typeof pendingResearch) => {
      const record = records.get(node.task.id);
      const checkpoint = state.cooperation?.researchCheckpoints?.[node.task.id];
      const paused = checkpoint?.paused && matchesCheckpoint(node.task.id, checkpoint) &&
        node.feedback === UNCHANGED_RESEARCH_CHECKPOINT;
      return node.status === (record ? 'completed' : paused ? 'blocked' : 'pending') && node.finding === record?.finding &&
        canonicalMathJson(node.researchCompletion ?? null) === canonicalMathJson(record?.record ?? null);
    };
    if (seeded && state.cooperation && (state.cooperation.planVersion !== planVersion ||
        canonicalMathJson(plannedTaskRecords(state.cooperation.tasks).map(node => node.task)) !== canonicalMathJson(plan.tasks) ||
        canonicalMathJson(capacityOrigin(capturedCapacityRecords(state))) !==
          canonicalMathJson(capacityOrigin(source.capacityExplorations?.records ?? [])) ||
        canonicalMathJson(state.cooperation.capacityExplorationInputs ?? []) !==
          canonicalMathJson(source.capacityExplorations?.inputs ?? []) ||
        canonicalMathJson(state.cooperation.nextChecks ?? []) !== canonicalMathJson(source.nextChecks?.records ?? []) ||
        source.researchContext && canonicalMathJson(state.cooperation.deliveries ?? []) !==
          canonicalMathJson(restoredResearchDeliveries(source, state)) ||
        (source.completedResearch || source.researchCheckpoints) && ![pendingResearch, restoredResearch].some(records =>
          state.cooperation.tasks.filter(node => isAdvisoryTask(node.task) && !node.capacityExploration && !node.nextCheckId)
            .every(node => matchesResearch(node, records))) ||
        source.researchCheckpoints && Object.entries(state.cooperation.researchCheckpoints ?? [])
          .some(([taskId, checkpoint]) => !matchesCheckpoint(taskId, checkpoint)) ||
        state.cooperation.tasks.some(node => node.assignment && !conditional.some(candidate =>
          candidate.taskId === node.task.id && node.status === 'conditional' &&
          node.assignment!.taskDigest === candidate.taskDigest && node.assignment!.workerId === 'continuation') &&
          !(source.frozenCandidates ?? []).some(candidate => candidate.taskId === node.task.id && node.status === 'pending' &&
            canonicalMathJson(node.assignment) === canonicalMathJson(frozenAssignment(candidate, state.cooperation!.canonicalCommit!))) &&
          !(source.taskDrafts ?? []).some(draft => !source.ownershipExtension && restorableTaskDraft(draft, node, state) &&
            canonicalMathJson(node.assignment) === canonicalMathJson(taskDraftAssignment(draft, node.task,
              state.cooperation!.tasks, state))))))
      throw new Error('math_continuation_seed_destination_changed');
    if (seeded && state.cooperation) {
      const previous = fs.existsSync(reportFile) ? readMathJson(reportFile) as Partial<ContinuationSeedReport> : undefined;
      const head = git(state.worktree, ['rev-parse', 'HEAD']);
      if (![state.problem.baseCommit, state.cooperation.canonicalCommit].includes(head) ||
          (previous?.sourcesInstalled && (head !== state.cooperation.canonicalCommit ||
            git(state.worktree, ['status', '--porcelain', '--untracked-files=no']))))
        throw new Error('math_continuation_seed_destination_changed');
    }
    if (!seeded && (git(state.worktree, ['rev-parse', 'HEAD']) !== state.problem.baseCommit ||
        git(state.worktree, ['status', '--porcelain', '--untracked-files=no']) || fs.existsSync(path.join(state.worktree, 'RESEARCH.md'))))
      throw new Error('math_continuation_seed_destination_changed');
    lease.assertHeld();
    if (!seeded) writeMathJsonDurable(sourceFile, source, 0o400);
    const report: ContinuationSeedReport = { schema: 'theorem-os.continuation-seed.v1', sourceRunId: source.source.runId,
      runId: state.runId, sourceStateFile, stateFile, sourceDigest: mathDigest(canonicalMathJson(source)), stage: 'frozen',
      candidates: candidateIds, checked: [], failed: [], evidence: 'advisory-sources-require-recheck' };
    const saveReport = () => { lease.assertHeld(); writeMathJsonDurable(reportFile, report); };
    const emit = (event: string, details: Record<string, unknown> = {}) => options.onProgress?.(event, details);
    let proofEnvironment: Awaited<ReturnType<typeof prepareMathProofEnvironment>> | undefined;
    try {
      const snapshot = freezeSource(source, directory);
      report.snapshotDigest = snapshot.digest;
      if (state.continuationDigest && state.continuationDigest !== snapshot.digest)
        throw new Error('math_continuation_seed_destination_changed');
      readContinuationSnapshot(snapshot.file, snapshot.digest, { taskDigest: state.taskDigest, problemReceiptDigest: state.problem.receiptDigest });
      saveReport();
      const canonical = await withSolverWorktree(state.worktree, state.problem.baseCommit, async checkout => {
        for (const [file, text] of Object.entries(source.canonicalSources)) {
          const target = path.join(checkout, state.problem.projectRelative, file); assertMathCanonicalPath(target);
          fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text);
        }
        assertSolverSources(state.problem, checkout);
        const commit = commitSolverSources(state.problem, checkout);
        git(state.worktree, ['update-ref', `refs/math/${state.runId}/continuation/source`, commit]);
        return commit;
      });
      lease.signal.throwIfAborted();
      report.canonicalCommit = canonical; report.stage = 'installing'; saveReport();
      const capacities = source.capacityExplorations?.records ?? [];
      const tasks: TaskRecord[] = plan.tasks.map(task => ({ task, attempts: 0,
        status: 'pending',
        ...(plan.proofRoutes?.length ? { alternativeRoutes: plan.proofRoutes.filter(route => route.targetTaskId === task.id) } : {}) }));
      for (const record of capacities.filter(item => !item.archived)) tasks.push({ task: record.task as CooperativeTask,
        capacityExploration: record.capacityExploration, attempts: 0,
        status: record.status === 'completed' ? 'completed' : 'pending',
        ...(record.finding === undefined ? {} : { finding: record.finding }) });
      for (const node of source.nextChecks?.tasks ?? []) tasks.push({ task: node.task, nextCheckId: node.nextCheckId,
        attempts: 0, status: node.status === 'completed' ? 'completed' : node.status === 'blocked' ? 'blocked' : 'pending',
        ...(node.finding ? { finding: node.finding } : {}) });
      state.continuationDigest = snapshot.digest;
      state.cooperation = { tasks, groups: plan.groups.map(group => ({ group, turns: 0 })), proofRoutes: plan.proofRoutes,
        canonicalCommit: canonical, leadSeedCommit: canonical, planVersion, planEdited: !source.initialPlanning,
        ...(source.capacityExplorations?.inputs === undefined ? {} : {
          capacityExplorationInputs: source.capacityExplorations.inputs.map(entry => ({ ...entry })) }),
        ...(source.nextChecks ? { nextChecks: structuredClone(source.nextChecks.records) } : {}),
        ...(source.goalProgress ? { goalProgress: structuredClone(source.goalProgress) } : {}),
        deliveries: [], history: [...capacities.filter(record => record.archived).map(archivedCapacity),
          ...completedResearchHistory(source)], edits: [], cursors: {} };
      state.cooperation.deliveries = restoredResearchDeliveries(source, state);
      resetGoalProgressClock(state.cooperation.goalProgress);
      // Publish pending obligations before installing sources; interruption cannot manufacture acceptance.
      writeSolverRunState(stateFile, state);
      git(state.worktree, ['reset', '--hard', canonical]);
      assertSolverSources(state.problem, state.worktree);
      report.sourcesInstalled = true; saveReport();
      emit('continuation_seed_installed', { sourceRunId: source.source.runId, runId: state.runId, tasks: tasks.length,
        candidates: candidateIds.length, snapshotDigest: snapshot.digest });
      const environmentFile = path.join(directory, 'environment-solver.json');
      assertMathCanonicalPath(environmentFile);
      if ((fs.lstatSync(environmentFile).mode & 0o777) !== 0o400) throw new Error('math_continuation_seed_environment_not_frozen');
      const staticEnv = { ...(options.preparedEnvironment ??
        resolveMathematicsRuntimeEnvironment({ DEEPSCIENTIST_MATH_ENV_FILE: environmentFile })) };
      // Startup-only already disposed its lease. Keep the frozen static identity and
      // authorized cache settings, but never resolve or reuse that temporary descriptor.
      if (!options.preparedEnvironment) {
        delete staticEnv[MATH_PROOF_ENVIRONMENT_ENV];
        delete staticEnv[MATH_PROOF_ENVIRONMENT_SANDBOX_ENV];
      }
      const project = path.join(state.worktree, state.problem.projectRelative);
      const packages = resolveMathematicsLakePackagesCache(project, staticEnv);
      if (!packages) throw new Error('math_lake_packages_unavailable');
      bindLeanPackages(project, packages);
      const overrides = path.join(project, '.lake', 'package-overrides.json');
      assertMathCanonicalPath(overrides);
      fs.rmSync(overrides, { force: true });
      const timeoutMs = options.timeoutMs ?? 180_000;
      if (!options.preparedEnvironment) proofEnvironment = await prepareMathProofEnvironment(project, packages, { env: staticEnv, signal: lease.signal,
        deadlineAt: Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : undefined,
        cacheRoot: DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT,
        onProgress: phase => emit('continuation_seed_proof_environment', { phase }) });
      const env = proofEnvironment ? { ...staticEnv, [MATH_PROOF_ENVIRONMENT_ENV]: proofEnvironment.environmentValue } : staticEnv;
      report.stage = 'checking'; saveReport();
      state.cooperation.recheck = { canonicalCommit: canonical, total: candidateIds.length, completed: 0 };
      writeSolverRunState(stateFile, state);
      const freshChecks: TaskProof[] = [];
      // These receipts belong only to this immutable canonical/environment/task
      // snapshot. Persisted status alone never authorizes a retained original.
      const freshGoals = new Map<string, string>();
      const projectors = new Map<string, ReturnType<typeof createTaskSourceProjector>>();
      const projector = (commit: string) => {
        let project = projectors.get(commit);
        if (!project) {
          project = createTaskSourceProjector(state.problem, state.worktree, commit);
          projectors.set(commit, project);
        }
        return project;
      };
      const sourceDependencies = new Map<string, string[]>();
      for (const taskId of candidateIds) {
        const node = tasks.find(item => item.task.id === taskId)!;
        const inputs = taskDependencyRecords(node.task, tasks).map(item => item.task.id);
        if (!conditional.some(item => item.taskId === taskId)) {
          try {
            inputs.push(...projectedGoalInputs(projector(canonical), node.task, tasks).map(item => item.task.id));
          } catch { /* Candidate preparation publishes its exact projection error below. */ }
        }
        sourceDependencies.set(taskId, [...new Set(inputs)]);
      }
      type Candidate = { node: TaskRecord; sourceCommit: string; request: TaskProofRequest;
        availableGoals: string[]; savedConditional?: (typeof conditional)[number] };
      const prepareCandidate = async (node: TaskRecord, restoreContext = false): Promise<Candidate> => {
        const taskId = node.task.id, savedConditional = conditional.find(candidate => candidate.taskId === taskId);
        let sourceCommit = canonical, assignment = { taskId, taskDigest: taskVersion(node.task),
          workerId: 'continuation', seedCommit: canonical } as NonNullable<TaskRecord['assignment']>;
        let conditions: CooperativeTask[] = [];
        if (savedConditional) {
          if (savedConditional.captureError) throw new Error(savedConditional.captureError);
          if (savedConditional.taskDigest !== taskVersion(node.task) || !savedConditional.sources ||
              !savedConditional.seedSources) throw new Error('math_task_condition_version_invalid');
          const byId = new Map(tasks.map(item => [item.task.id, item.task]));
          const references = (items: readonly { taskId: string; taskDigest: string }[]) => items.map(reference => {
            const task = byId.get(reference.taskId);
            if (!task || taskVersion(task) !== reference.taskDigest) throw new Error('math_task_condition_version_invalid');
            return task;
          });
          conditions = references(savedConditional.conditions);
          const dependencies = references(savedConditional.dependencies);
          if (!conditions.every(task => assumableLemma(task) &&
              dependencies.some(dependency => dependency.id === task.id)) || new Set(conditions.map(task => task.id)).size !== conditions.length)
            throw new Error('math_task_condition_version_invalid');
          const frozen = await withSolverWorktree(state.worktree, state.problem.baseCommit, async checkout => {
            const write = (sources: Record<string, string>) => {
              for (const [file, text] of Object.entries(sources)) {
                const target = path.join(checkout, state.problem.projectRelative, file);
                assertMathCanonicalPath(target); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text);
              }
              return commitSolverSources(state.problem, checkout);
            };
            const seedCommit = write(savedConditional.seedSources!);
            const proofCommit = write(savedConditional.sources!);
            return { seedCommit, proofCommit };
          });
          assignment = { ...assignment, seedCommit: frozen.seedCommit, dependencies: savedConditional.dependencies };
          if (!node.task.conditional) assignment.connectionCheck = createTaskConnectionCheck(node.task, assignment,
            tasks.map(item => conditions.some(condition => condition.id === item.task.id) ? { ...item, status: 'pending' } : item),
            { environmentDigest: state.environmentDigest, problemReceiptDigest: state.problem.receiptDigest },
            task => savedConditional.seedSources![task.proofPath!] ?? '');
          sourceCommit = frozen.proofCommit;
          git(state.worktree, ['update-ref', `refs/math/${state.runId}/continuation/conditional/${taskId}`, sourceCommit]);
        }
        const availableGoals = tasks.filter(item => item.task.id !== taskId && item.task.kind === 'goal' &&
          freshGoals.get(item.task.id) === taskVersion(item.task)).map(item => item.task.id);
        // Historical conditional sources have their own frozen context and binders.
        const retainedGoals = savedConditional ? [] : availableGoals.filter(id => restoreContext ||
          sourceDependencies.get(taskId)!.includes(id)).map(id => tasks.find(item => item.task.id === id)!.task.theoremName!);
        return { node, savedConditional, sourceCommit, availableGoals, request: { task: node.task, retainedGoals, assignment,
          ...(conditions.length ? { conditions } : {}) } };
      };
      const blockCandidate = (node: TaskRecord, error: unknown) => {
        lease.signal.throwIfAborted(); lease.assertHeld();
        setTaskStatus(node, 'blocked', 'reconstructed'); node.integratedCheck = undefined; node.proof = undefined; node.assignment = undefined;
        node.feedback = error instanceof Error ? error.message : 'math_continuation_seed_helper_check_failed';
      };
      const completeCandidate = (node: TaskRecord) => {
        lease.signal.throwIfAborted(); lease.assertHeld();
        const taskId = node.task.id;
        const first = !report.checked.includes(taskId);
        if (first) report.checked.push(taskId);
        report.failed = report.failed.filter(id => id !== taskId);
        if (node.status === 'blocked') report.failed.push(taskId);
        if (node.status === 'integrated') report.evidence = 'fresh-helper-receipts';
        if (first) state.cooperation.recheck.completed++;
        state.cooperation.recheck.taskId = undefined;
        state.cooperation.deliveries = restoredResearchDeliveries(source, state);
        writeSolverRunState(stateFile, state); saveReport();
        emit('continuation_seed_checked', { taskId, passed: node.status === 'integrated' || node.status === 'conditional' });
      };
      const retryable = new Map<string, Candidate>();
      const publishCandidate = (candidate: Candidate, proof: TaskProof) => {
        const { node, savedConditional, sourceCommit, request: { assignment } } = candidate;
        try {
          lease.signal.throwIfAborted(); lease.assertHeld();
          const fresh = proof.passed && isAttributedTaskProof(proof) &&
            proof.taskDigest === taskVersion(node.task) && proof.commit === sourceCommit && proof.seedCommit === assignment.seedCommit &&
            canonicalMathJson(proof.conditions ?? []) === canonicalMathJson(savedConditional?.conditions ?? []) &&
            proof.verification.status === 'kernel_verified' && proof.verification.results.length > 0 &&
            proof.verification.results.every(result => result.status === 'kernel_verified' && typeof result.receiptId === 'string' && result.receiptId);
          for (const commit of [proof.commit, proof.verification.targetCommit]) if (commit) {
            if (!oid.safeParse(commit).success) throw new Error('math_continuation_seed_invalid_receipt_commit');
            git(state.worktree, ['update-ref', `refs/math/${state.runId}/evidence/${commit}`, commit]);
          }
          if (savedConditional) {
            node.proof = proof;
            node.assignment = fresh ? assignment : undefined;
            setTaskStatus(node, fresh ? 'conditional' : 'blocked', 'reconstructed');
          } else {
            node.integratedCheck = proof;
            setTaskStatus(node, fresh ? 'integrated' : 'blocked', 'reconstructed');
            if (fresh) {
              freshChecks.push(proof);
              if (node.task.kind === 'goal') freshGoals.set(node.task.id, taskVersion(node.task));
            } else if (hasDeterministicLeanFailure(proof.verification)) retryable.set(node.task.id, candidate);
          }
          node.feedback = fresh ? undefined : 'math_continuation_seed_helper_not_verified';
        } catch (error) {
          blockCandidate(node, error);
        }
        completeCandidate(node);
      };
      const checkBatch = async (batch: Candidate[]): Promise<void> => {
        lease.signal.throwIfAborted(); lease.assertHeld();
        let proofs: TaskProof[];
        try {
          proofs = await checkTaskProofs(state.problem, state.worktree, batch[0].sourceCommit, batch.map(candidate => candidate.request),
            env, lease.signal, timeoutMs, state.environmentDigest);
        } catch (error) {
          lease.signal.throwIfAborted(); lease.assertHeld();
          if (batch.length > 1 && error instanceof Error && seedBatchFallbacks.has(rejectionCode(error))) {
            for (const candidate of batch) await checkBatch([candidate]);
          } else for (const { node } of batch) { blockCandidate(node, error); completeCandidate(node); }
          return;
        }
        if (batch.length > 1 && proofs.some(proof => !proof.passed && hasDeterministicLeanFailure(proof.verification))) {
          emit('continuation_seed_batch_fallback', { taskIds: batch.map(item => item.node.task.id), reason: 'lean-compilation-failed' });
          for (const candidate of batch) await checkBatch([candidate]);
          return;
        }
        for (const [index, candidate] of batch.entries()) publishCandidate(candidate, proofs[index]);
      };
      const checkWave = async (ids: string[], restoreContext = false) => {
        const groups = new Map<string, Candidate[]>();
        const batches: (Candidate[] | { node: TaskRecord; error: unknown })[] = [];
        for (const taskId of ids) {
          lease.signal.throwIfAborted(); lease.assertHeld();
          const node = tasks.find(node => node.task.id === taskId)!;
          try {
            const candidate = await prepareCandidate(node, restoreContext), { sourceCommit, request } = candidate;
            const projection = projector(sourceCommit)(request.task, request.retainedGoals, request.conditions);
            const key = mathDigest(canonicalMathJson({ sourceCommit, sources: [...projection], retainedGoals: request.retainedGoals,
              conditions: request.conditions?.map(task => ({ taskId: task.id, taskDigest: taskVersion(task) })) ?? [],
              premises: request.task.premises ?? [], environmentDigest: state.environmentDigest, problemReceiptDigest: state.problem.receiptDigest }));
            let group = groups.get(key);
            if (!group || group.length === maxSeedBatchSize) { group = []; groups.set(key, group); batches.push(group); }
            group.push(candidate);
          } catch (error) {
            lease.signal.throwIfAborted(); lease.assertHeld(); batches.push({ node, error });
          }
        }
        for (const batch of batches) {
          lease.signal.throwIfAborted(); lease.assertHeld();
          const nodes = Array.isArray(batch) ? batch.map(candidate => candidate.node) : [batch.node];
          state.cooperation.recheck.taskId = nodes[0].task.id; writeSolverRunState(stateFile, state);
          for (const node of nodes) emit('continuation_seed_check', { taskId: node.task.id, batchSize: nodes.length, restoreContext });
          if (Array.isArray(batch)) await checkBatch(batch);
          else { blockCandidate(batch.node, batch.error); completeCandidate(batch.node); }
        }
      };
      const pending = new Set(candidateIds);
      while (pending.size) {
        const wave = [...pending].filter(id => sourceDependencies.get(id)!.every(input => !pending.has(input)));
        if (!wave.length) {
          for (const id of pending) {
            const node = tasks.find(item => item.task.id === id)!;
            blockCandidate(node, new Error(`math_continuation_seed_dependency_cycle\n${id}: ${sourceDependencies.get(id)!.join(', ')}`));
            completeCandidate(node);
          }
          break;
        }
        await checkWave(wave);
        wave.forEach(id => pending.delete(id));
      }
      // One recovery attempt is allowed only when independently checked originals
      // have added actual context since this candidate's first request.
      for (const [id, candidate] of [...retryable]) {
        if (candidate.savedConditional || ![...freshGoals.keys()].some(goal => goal !== id && !candidate.availableGoals.includes(goal))) continue;
        emit('continuation_seed_context_retry', { taskId: id, canonicalCommit: canonical });
        await checkWave([id], true);
      }
      // Rechecking typed inputs may retire a former investigation. Keep its frozen
      // provenance and tombstone without importing an old assignment or acceptance.
      for (const record of capacities.filter(item => !item.archived)) {
        const index = tasks.findIndex(node => node.task.id === record.task.id), node = tasks[index];
        const owner = state.workers!.find(worker => worker.id === record.capacityExploration.workerId);
        if (node && owner && researchWorkerCanNode(owner, node) && currentCapacityExploration(node, tasks,
          { environmentDigest: state.environmentDigest, problemReceiptDigest: state.problem.receiptDigest })) continue;
        if (index >= 0) tasks.splice(index, 1);
        state.cooperation.history!.push(archivedCapacity(record));
      }
      state.cooperation.deliveries = restoredResearchDeliveries(source, state);
      const completedResearch = currentCompletedResearch(source, state, plan.tasks, tasks, state.cooperation.deliveries);
      for (const node of tasks.filter(node => isAdvisoryTask(node.task) && !node.capacityExploration)) {
        const completion = completedResearch.get(node.task.id);
        setTaskStatus(node, completion ? 'completed' : 'pending', 'reconstructed');
        node.finding = completion?.finding; node.researchCompletion = completion?.record;
      }
      state.cooperation.history = [...state.cooperation.history!.filter(record => 'capacityExploration' in record),
        ...completedResearchHistory(source, completedResearch)];
      // Frozen unfinished deliveries are executable source inputs, never inherited acceptance. Leave
      // them pending for normal WorkerProofLifecycle deadlines rather than checking during cold seeding.
      for (const candidate of source.frozenCandidates ?? []) {
        lease.signal.throwIfAborted(); lease.assertHeld();
        const node = tasks.find(node => node.task.id === candidate.taskId);
        const worker = state.workers!.find(worker => worker.id === candidate.workerId);
        if (!node || !worker || node.status === 'integrated' || node.status === 'conditional') continue;
        const names = [...state.problem.ownedFiles].sort();
        if (source.ownershipExtension || candidate.taskDigest !== taskVersion(node.task) ||
            candidate.problemReceiptDigest !== state.problem.receiptDigest || candidate.environmentDigest !== state.environmentDigest ||
            candidate.dependencies.some(reference => !tasks.some(node => node.task.id === reference.taskId && taskVersion(node.task) === reference.taskDigest)) ||
            canonicalMathJson(Object.keys(candidate.sources).sort()) !== canonicalMathJson(names) ||
            canonicalMathJson(Object.keys(candidate.seedSources).sort()) !== canonicalMathJson(names) ||
            candidate.sourceDigest !== ownedSourceDigest(state.problem, state.worktree, candidate.snapshotCommit) ||
            assessTaskResponsibility({ ...node, assignment: undefined }, worker, { tasks, groups: state.cooperation.groups }).kind !== 'matches')
          throw new Error('math_continuation_seed_frozen_identity_changed');
        for (const [commit, sources] of [[candidate.seedCommit, candidate.seedSources],
          [candidate.snapshotCommit, candidate.sources]] as const) {
          for (const file of state.problem.ownedFiles) if (committedSource(state.worktree, commit,
            `${state.problem.projectRelative}/${file}`) !== sources[file]) throw new Error('math_continuation_seed_frozen_source_changed');
          await withSolverWorktree(state.worktree, commit, async checkout => { assertSolverSources(state.problem, checkout); });
          git(state.worktree, ['update-ref', `refs/math/${state.runId}/continuation/frozen/${candidate.taskId}/${commit}`, commit]);
        }
        const assignment = frozenAssignment(candidate, canonical);
        const ready = proofReadyRecord({ assignment, workerId: worker.id,
          submissionId: mathDigest(canonicalMathJson({ sourceRunId: source.source.runId, readyId: candidate.readyId, runId: state.runId })),
          problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest, now: source.capturedAt });
        Object.assign(ready, { status: 'frozen', frozenAt: source.capturedAt,
          snapshotCommit: candidate.snapshotCommit, sourceDigest: candidate.sourceDigest });
        git(worker.worktree, ['reset', '--hard', candidate.snapshotCommit]);
        assertSolverSources(state.problem, worker.worktree);
        node.assignment = assignment; node.proof = undefined; node.integratedCheck = undefined;
        setTaskStatus(node, 'pending', 'reconstructed');
        (state.cooperation.proofReadyRecords ??= []).push(ready);
        emit('continuation_seed_frozen_pending', { taskId: candidate.taskId, workerId: worker.id, readyId: ready.id,
          sourceRunId: source.source.runId, sourceReadyId: candidate.readyId, snapshotCommit: candidate.snapshotCommit,
          sourceDigest: candidate.sourceDigest, acceptance: 'not-assessed' });
      }
      // A worker's current workspace may belong to a different task. Install the
      // saved task snapshots, not its workspace, for ordinary on-dispatch recovery.
      for (const draft of source.taskDrafts ?? []) {
        const node = tasks.find(node => node.task.id === draft.taskId);
        if (source.ownershipExtension || !node || node.assignment || !restorableTaskDraft(draft, node, state)) continue;
        lease.signal.throwIfAborted(); lease.assertHeld();
        const assignment = taskDraftAssignment(draft, node.task, tasks, state);
        const artifacts = await withSolverWorktree(state.worktree, draft.commit, async checkout => {
          assertSolverSources(state.problem, checkout);
          if (canonicalMathJson(Object.keys(draft.sources).sort()) !== canonicalMathJson([...state.problem.ownedFiles].sort()) ||
              state.problem.ownedFiles.some(file => committedSource(checkout, draft.commit,
                `${state.problem.projectRelative}/${file}`) !== draft.sources[file]) ||
              (git(checkout, ['ls-tree', '--format=%(objectname)', draft.commit, '--', 'RESEARCH.md'])
                ? committedSource(checkout, draft.commit, 'RESEARCH.md') : null) !== draft.notes ||
              draftOutputDigest(state.problem, checkout, draft.commit) !== draft.outputDigest)
            throw new Error('math_continuation_seed_draft_source_changed');
          // Compare the retained canonical basis during normal restoration. A newer
          // canonical keeps precedence; its saved notes and source evidence survive.
          ownedSourceDigest(state.problem, checkout, draft.canonicalCommit ?? draft.seedCommit);
          return captureDeliveryArtifacts({ problem: state.problem, worktree: checkout, commit: draft.commit, assignment });
        });
        for (const commit of new Set([draft.seedCommit, draft.canonicalCommit ?? draft.seedCommit, draft.commit]))
          git(state.worktree, ['update-ref', `refs/math/${state.runId}/continuation/drafts/${draft.taskId}/${commit}`, commit]);
        node.assignment = assignment;
        (state.cooperation.researchDrafts ??= {})[draft.taskId] = { taskDigest: draft.taskDigest, workerId: draft.workerId,
          assignmentId: assignment.assignmentId, seedCommit: draft.seedCommit, canonicalCommit: draft.canonicalCommit,
          commit: draft.commit, outputDigest: draft.outputDigest, artifacts, suspended: true };
        emit('continuation_seed_task_draft_pending', { taskId: draft.taskId, workerId: draft.workerId,
          sourceRunId: draft.source.runId, snapshotCommit: draft.commit, acceptance: 'not-assessed' });
      }
      for (const [taskId, saved] of currentResearchCheckpoints(source, state)) {
        const node = tasks.find(node => node.task.id === taskId)!, checkpoint = { ...saved.checkpoint };
        (state.cooperation.researchCheckpoints ??= {})[taskId] = checkpoint;
        if (checkpoint.paused) {
          const scope = `assigned-local-inference/checkpoint:${mathDigest(canonicalMathJson({
            inputDigest: checkpoint.inputDigest, outputDigest: checkpoint.outputDigest }))}`;
          const [blocker] = recordRouteBlockers(state.cooperation.blockers ??= [],
            validateBlockerProposals([{ mechanism: 'unchanged-research-checkpoint', scope }], node.task, tasks),
            node.task, tasks, state.environmentDigest, state.problem.receiptDigest, source.capturedAt);
          blocker.status = 'parked'; blocker.count = 2; checkpoint.blockerId = blocker.id;
          setTaskStatus(node, 'blocked', 'reconstructed'); node.feedback = UNCHANGED_RESEARCH_CHECKPOINT;
        }
        emit('continuation_seed_research_checkpoint_restored', { taskId, workerId: saved.workerId,
          sourceRunId: saved.source.runId, count: checkpoint.count, paused: Boolean(checkpoint.paused),
          acceptance: 'not-assessed' });
      }
      writeSolverRunState(stateFile, state);
      report.stage = 'complete'; saveReport();
      options.onSeeded?.(state, freshChecks);
      return report;
    } catch (error) {
      report.stage = 'interrupted'; report.error = error instanceof Error ? error.message : 'math_continuation_seed_failed';
      // Already published helper checks are fresh; every unchecked obligation remains pending.
      lease.assertOwned(); writeMathJsonDurable(reportFile, report);
      throw error;
    } finally {
      await proofEnvironment?.dispose();
    }
  };
  return options.lease ? seedWithLease(options.lease) :
    withMathRuntimeLease({ lockPath: path.join(directory, 'run.lock'), flockExecutable: '/usr/bin/flock', signal: options.signal }, seedWithLease);
}
