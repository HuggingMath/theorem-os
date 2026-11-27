import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import type { SolverRunState } from './archive';
import type { TaskProof } from './cooperativeProof';
import { committedSource, git, type SolverProblem } from './problem';
import { researchCheckpointOutputDigest, type ResearchCheckpoint } from './researchCheckpoints';
import { isAdvisoryTask, isFinalCandidateReview, taskVersion, type CooperativeTask, type TaskRecord } from './tasks';

export type ContinuationSeedOptions = {
  sourceRun: string; run: string; root: string; buildManifest: string; signal: AbortSignal; timeoutMs?: number;
  onProgress?: (event: string, details: Record<string, unknown>) => void;
  lease?: import('../math/mathRuntimeIo').MathLease; preparedEnvironment?: NodeJS.ProcessEnv; deferChecks?: boolean;
  onSeeded?: (state: SolverRunState, freshChecks: TaskProof[]) => void;
};

export type ContinuationSeedReport = {
  schema: 'theorem-os.continuation-seed.v1'; sourceRunId: string; runId: string; sourceStateFile: string;
  stateFile: string; sourceDigest: string; snapshotDigest?: string; canonicalCommit?: string;
  stage: 'frozen' | 'installing' | 'awaiting-checks' | 'checking' | 'complete' | 'interrupted'; sourcesInstalled?: boolean;
  candidates: string[]; checked: string[]; failed: string[]; error?: string;
  evidence: 'advisory-sources-require-recheck' | 'fresh-helper-receipts';
};

const sourcePolicy = (problem: SolverProblem) => ({ workspace: problem.workspace, projectRelative: problem.projectRelative,
  baseCommit: problem.baseCommit, receiptDigest: problem.receiptDigest, contract: problem.contract, targets: problem.targets,
  ownedFiles: problem.ownedFiles, trustedFiles: problem.trustedFiles, declarations: problem.declarations,
  sourceStructure: problem.sourceStructure, sourceImports: problem.sourceImports, frozenFiles: problem.frozenFiles });
export const continuationSourcePolicyDigest = (problem: SolverProblem) => mathDigest(canonicalMathJson(sourcePolicy(problem)));

/**
 * Owned files that a re-bootstrapped destination adds to the source problem, e.g. certificate or theory slots.
 * Undefined unless both are the same mathematical problem: equal contract, targets and trusted files, and every
 * source-owned file keeps its frozen declarations, context, imports and library bytes. Added files start at the destination baseline.
 */
export function continuationOwnershipExtension(source: SolverProblem, destination: SolverProblem): string[] | undefined {
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
const continuableResearch = (task: CooperativeTask) => isAdvisoryTask(task) && !task.reviewScope && !isFinalCandidateReview(task);
const ordinaryCheckpointTask = (node: TaskRecord) => continuableResearch(node.task) && !node.capacityExploration && !node.nextCheckId;
const pausedResearchCheckpoint = (node: TaskRecord, checkpoint?: ResearchCheckpoint) => ordinaryCheckpointTask(node) &&
  checkpoint?.paused && checkpoint.taskDigest === taskVersion(node.task) && node.status === 'blocked' &&
  node.feedback?.startsWith('math_research_checkpoint_unchanged');


/** Read archived task snapshots as advisory material for a new continuation. */
export function captureContinuationTaskDrafts(state: SolverRunState, stateFile: string) {
  const cooperation = state.cooperation;
  if (!cooperation) return [];
  const origin = { runId: state.runId, stateFile, environmentDigest: state.environmentDigest,
    problemReceiptDigest: state.problem.receiptDigest, sourcePolicyDigest: continuationSourcePolicyDigest(state.problem) };
  return Object.entries(cooperation.researchDrafts ?? {}).map(([taskId, snapshot]) => {
    const node = cooperation.tasks.find(node => node.task.id === taskId);
    const task = node?.task && taskVersion(node.task) === snapshot.taskDigest ? node.task :
      cooperation.history?.find(record => record.task.id === taskId && taskVersion(record.task) === snapshot.taskDigest)?.task;
    const assignment = node?.assignment;
    const checkpoint = cooperation.researchCheckpoints?.[taskId];
    const current = node && taskVersion(node.task) === snapshot.taskDigest &&
      (['pending', 'running'].includes(node.status) || pausedResearchCheckpoint(node, checkpoint) &&
        checkpoint!.outputDigest === snapshot.outputDigest) &&
      assignment?.taskDigest === snapshot.taskDigest && assignment.workerId === snapshot.workerId &&
      assignment.assignmentId === snapshot.assignmentId && assignment.seedCommit === snapshot.seedCommit &&
      assignment.canonicalCommit === snapshot.canonicalCommit &&
      snapshot.outputDigest === researchCheckpointOutputDigest(state.problem, state.worktree, snapshot.commit) &&
      snapshot.artifacts.problemReceiptDigest === state.problem.receiptDigest && snapshot.artifacts.taskId === taskId &&
      snapshot.artifacts.taskDigest === snapshot.taskDigest && snapshot.artifacts.seedCommit === snapshot.seedCommit &&
      snapshot.artifacts.commit === snapshot.commit;
    return { taskId, taskDigest: snapshot.taskDigest, workerId: snapshot.workerId,
      assignmentId: snapshot.assignmentId, seedCommit: snapshot.seedCommit,
      canonicalCommit: snapshot.canonicalCommit, commit: snapshot.commit, outputDigest: snapshot.outputDigest,
      handoffNotesDigest: snapshot.handoffNotesDigest, feasibilityInputDigest: snapshot.feasibilityInputDigest,
      task, suspended: snapshot.suspended, ...(current ? {} : { archived: true }),
      sources: Object.fromEntries(state.problem.ownedFiles.map(file => [file,
        committedSource(state.worktree, snapshot.commit, `${state.problem.projectRelative}/${file}`)])),
      notes: git(state.worktree, ['ls-tree', '--format=%(objectname)', snapshot.commit, '--', 'RESEARCH.md'])
        ? committedSource(state.worktree, snapshot.commit, 'RESEARCH.md') : null,
      source: origin };
  });
}
