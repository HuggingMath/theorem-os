import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { inspectLeanDeclarationRegions, startsLeanSourceCommand } from '../math/leanSource';
import { isSimpleLeanName, maskLeanCommentsAndStrings } from '../math/leanSyntax';
import { declarationStartWithDoc, ownedSourceDigest } from './cooperativeProof';
import { deliveryInputFields } from './cooperationShared';
import { MAX_RESEARCH_NOTES_BYTES, type DeliveryRecord } from './deliveries';
import { mathematicalGapVisible } from './mathematicalGaps';
import { taskDependencyRecords } from './modules/search';
import { captureObligationSnapshot } from './obligationProgress';
import { committedSource, git, type SolverProblem } from './problem';
import { checkpointCandidate, type CheckpointCandidate } from './researchEvidence';
import { captureResearchBasis } from './researchRecords';
import { researchSourceTasks, scopedResearchSources } from './researchSources';
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

function scopedProgressEvidence(record: DeliveryRecord) {
  const { summary: _summary, ...fields } = deliveryInputFields(record);
  const artifactDigest = record.artifacts?.artifacts.length ? checkpointCandidate('', record.artifacts).digest : undefined;
  if (!artifactDigest && !fields.evidenceRefs.length && !fields.findingDigest && !fields.lemmaRequests?.length &&
      !fields.mathematicalGap && !fields.checkOutcome && !fields.sourceUses?.length && !fields.searchCheckpoint) return;
  return { ...fields, artifactDigest };
}

/** Keep scheduling identity identical during live recovery and cold continuation. */
export function researchCheckpointLocalInputDigest(input: CheckpointInput, legacyProgress = false) {
  const dependencies = taskDependencyRecords(input.task, input.tasks);
  const relevant = new Set([input.task.id, ...dependencies.map(node => node.task.id)]);
  const scopedCheck = !legacyProgress && input.tasks.some(node => node.task.id === input.task.id && node.nextCheckId);
  const deliveries = [...new Set(visibleDeliveries(input).flatMap(record => {
    if (!relevant.has(record.taskId ?? '') && !record.dependencies.some(reference => reference.taskId === input.task.id)) return [];
    // Keep progress prose visible to workers, but don't treat a handoff summary as new check evidence.
    const fields = scopedCheck && record.kind === 'progress' ? scopedProgressEvidence(record) : deliveryInputFields(record);
    return fields ? [canonicalMathJson(fields)] : [];
  }))].sort();
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

type FeasibilityReviewInput = CheckpointInput & {
  problem: SolverProblem; worktree: string; canonicalCommit: string;
  retrievalDigest?: string; knowledgeDigest?: string;
};

/** Intermediate review notes belong to one reviewer and the exact inspected inputs, never a verdict. */
export function feasibilityReviewInputDigest(input: FeasibilityReviewInput) {
  return mathDigest(canonicalMathJson({ workerId: input.workerId, basis: captureResearchBasis(input.task, {
    problemReceiptDigest: input.problemReceiptDigest, environmentDigest: input.environmentDigest,
    retrievalDigest: input.retrievalDigest, knowledgeDigest: input.knowledgeDigest,
    sourceDigest: ownedSourceDigest(input.problem, input.worktree, input.canonicalCommit),
    tasks: input.tasks, deliveries: input.deliveries,
  }) }));
}

/** Carry provisional notes onto a new seed only for a recognizable, independent source addition. */
export function resumableFeasibilityReviewInput(input: FeasibilityReviewInput,
  saved: { feasibilityInputDigest?: string; canonicalCommit?: string; seedCommit?: string }): string | undefined {
  if (!saved.feasibilityInputDigest) return;
  const current = feasibilityReviewInputDigest(input);
  if (saved.feasibilityInputDigest === current) return current;
  if (!saved.seedCommit || !saved.canonicalCommit || saved.canonicalCommit === input.canonicalCommit) return;
  try {
    // Recompute the saved identity with today's task, evidence and environment.
    // A changed dependency or knowledge input must still start a fresh review.
    if (saved.feasibilityInputDigest !== feasibilityReviewInputDigest({ ...input, canonicalCommit: saved.canonicalCommit })) return;
    const { problem, worktree, task, tasks } = input;
    const sources = (commit: string) => Object.fromEntries(problem.ownedFiles.map(file =>
      [file, committedSource(worktree, commit, `${problem.projectRelative}/${file}`)]));
    const previous = sources(saved.seedCommit);
    const next = scopedResearchSources(problem, task, sources(input.canonicalCommit), researchSourceTasks(tasks));
    const changed = problem.ownedFiles.filter(file => previous[file] !== next[file]);
    if (!changed.length) return current;
    // Without explicit inspection inputs, we cannot distinguish new evidence from
    // an unrelated declaration in the reviewer's visible source.
    if (!task.dependsOn.length) return;
    const dependencies = taskDependencyRecords(task, tasks);
    const ids = new Set(dependencies.map(node => node.task.id));
    const names = new Set([...Object.values(previous),
      canonicalMathJson([task, dependencies.map(node => ({ task: node.task, finding: node.finding })),
        input.deliveries.filter(record => record.taskId && ids.has(record.taskId) && record.status !== 'superseded')])]
      .flatMap(text => text.match(/[\p{L}\p{M}\p{N}_'?!]+/gu) ?? []));
    if (changed.every(file => file.endsWith('.lean') && !Object.hasOwn(problem.frozenFiles ?? {}, file) &&
        onlyNewPlainLemmas(previous[file]!, next[file]!, names))) return current;
  } catch {
    // An unavailable prior seed or an ambiguous source scope cannot establish equivalence.
  }
}

function onlyNewPlainLemmas(before: string, after: string, knownNames: ReadonlySet<string>): boolean {
  let reconstructed = '', cursor = 0;
  const regions = inspectLeanDeclarationRegions(after);
  const visible = maskLeanCommentsAndStrings(after);
  for (const [index, region] of regions.entries()) {
    const start = after.lastIndexOf('\n', region.startOffset - 1) + 1;
    const name = region.name.split('.').at(-1)!;
    if (!isSimpleLeanName(region.name) || knownNames.has(name) ||
        after.slice(start, region.startOffset).trim() ||
        !/^(?:theorem|lemma)\s/u.test(after.slice(region.startOffset, region.bodyOffset)) ||
        declarationStartWithDoc(after, region.startOffset, index ? regions[index - 1]!.endOffset : 0) !== start) continue;
    // Declaration regions are indentation based. Do not erase a following
    // command just because it used greater indentation than the lemma.
    if (visible.slice(region.bodyOffset, region.endOffset).split('\n').slice(1)
      .some(line => startsLeanSourceCommand(line.trimStart()))) continue;
    reconstructed += after.slice(cursor, start);
    cursor = region.endOffset;
  }
  return cursor > 0 && reconstructed + after.slice(cursor) === before;
}

export const researchCheckpointOutputDigest = (problem: SolverProblem, worktree: string, commit: string) =>
  mathDigest(canonicalMathJson({ sourceDigest: ownedSourceDigest(problem, worktree, commit),
    notesBlob: git(worktree, ['ls-tree', '--format=%(objectname)', commit, '--', 'RESEARCH.md']) }));

/** A saved snapshot may contain inherited notes; its existence alone does not attribute them to a task. */
export function committedResearchNotesDigest(worktree: string, commit: string): string | undefined {
  if (!git(worktree, ['ls-tree', '--format=%(objectname)', commit, '--', 'RESEARCH.md'])) return;
  const notes = committedSource(worktree, commit, 'RESEARCH.md');
  return notes.trim() && Buffer.byteLength(notes, 'utf8') <= MAX_RESEARCH_NOTES_BYTES ? mathDigest(notes) : undefined;
}

/** Only a task's own write, a previously attributed snapshot or a current acknowledgment is a handoff. */
export function researchHandoffNotesDigest(notesDigest: string | undefined, seedNotesDigest: string | undefined,
  retainedNotesDigest?: string, acknowledgedNotesDigest?: string): string | undefined {
  return notesDigest && (notesDigest !== seedNotesDigest || notesDigest === retainedNotesDigest ||
    notesDigest === acknowledgedNotesDigest) ? notesDigest : undefined;
}
