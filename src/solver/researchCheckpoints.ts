import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { ownedSourceDigest } from './cooperativeProof';
import { deliveryInputFields } from './cooperationShared';
import type { DeliveryRecord } from './deliveries';
import { mathematicalGapVisible } from './mathematicalGaps';
import { taskDependencyRecords } from './modules/search';
import { captureObligationSnapshot } from './obligationProgress';
import { git, type SolverProblem } from './problem';
import type { CheckpointCandidate } from './researchEvidence';
import { routeBlockerBasis } from './routeControl';
import { taskGroup, taskVersion, type CooperativeTask, type TaskRecord } from './tasks';

export type ResearchCheckpoint = {
  taskDigest: string; inputDigest: string; outputDigest: string; count: number;
  localInputDigest?: string; candidateOutputDigest?: string; unchangedEvidenceCount?: number;
  candidateStatus?: CheckpointCandidate['status']; paused?: boolean; blockerId?: string;
  /** Scheduling backoff follows this task's saved work, even when its worker changes responsibilities. */
  advisoryCheckpoint?: { scope: string; noProgressStreak: number; contentDigest?: string; inputDigest?: string };
};

export const UNCHANGED_RESEARCH_CHECKPOINT = 'math_research_checkpoint_unchanged: The same checkpoint has no new saved notes, draft, or task input across repeated recoveries. Wait for new input or revise the investigation.';

type CheckpointInput = {
  task: CooperativeTask; workerId: string; tasks: readonly TaskRecord[]; deliveries: readonly DeliveryRecord[];
  environmentDigest: string; problemReceiptDigest: string;
};

function visibleDeliveries(input: CheckpointInput) {
  const versions = new Map(input.tasks.map(({ task }) => [task.id, { task, version: taskVersion(task) }]));
  return input.deliveries.filter(record => {
    if (record.producer === input.workerId || record.status === 'superseded' ||
        !mathematicalGapVisible(record, input, input.task) || !record.taskId) return false;
    const node = versions.get(record.taskId);
    return node && node.version === record.taskDigest && record.dependencies.every(reference =>
      versions.get(reference.taskId)?.version === reference.taskDigest) &&
      (taskGroup(node.task) === taskGroup(input.task) || node.task.sharing !== 'group');
  });
}

/** Keep scheduling identity identical during live recovery and cold continuation. */
export function researchCheckpointLocalInputDigest(input: CheckpointInput) {
  const dependencies = taskDependencyRecords(input.task, input.tasks);
  const relevant = new Set([input.task.id, ...dependencies.map(node => node.task.id)]);
  const deliveries = [...new Set(visibleDeliveries(input).filter(record => relevant.has(record.taskId ?? '') ||
    record.dependencies.some(reference => reference.taskId === input.task.id)).map(record => canonicalMathJson({
    ...deliveryInputFields(record), findingDigest: record.findingDigest,
  })))].sort();
  return mathDigest(canonicalMathJson({ taskDigest: taskVersion(input.task),
    basis: routeBlockerBasis(input.task, input.tasks, input.environmentDigest, input.problemReceiptDigest),
    dependencies: captureObligationSnapshot(dependencies, { environmentDigest: input.environmentDigest }).digest,
    deliveries }));
}

export function researchCheckpointInputDigest(input: CheckpointInput & {
  problem: SolverProblem; worktree: string; canonicalCommit: string;
}) {
  const deliveries = [...new Set(visibleDeliveries(input).map(record => canonicalMathJson(deliveryInputFields(record))))].sort();
  return mathDigest(canonicalMathJson({ taskDigest: taskVersion(input.task), environmentDigest: input.environmentDigest,
    problemReceiptDigest: input.problemReceiptDigest,
    sourceDigest: ownedSourceDigest(input.problem, input.worktree, input.canonicalCommit),
    dependencies: captureObligationSnapshot(taskDependencyRecords(input.task, input.tasks),
      { environmentDigest: input.environmentDigest }).digest, deliveries }));
}

export const researchCheckpointOutputDigest = (problem: SolverProblem, worktree: string, commit: string) =>
  mathDigest(canonicalMathJson({ sourceDigest: ownedSourceDigest(problem, worktree, commit),
    notesBlob: git(worktree, ['ls-tree', '--format=%(objectname)', commit, '--', 'RESEARCH.md']) }));
