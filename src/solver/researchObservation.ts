import fs from 'node:fs';
import path from 'node:path';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { canonicalMathJson, mathDigest, readMathText } from '../math/mathRuntimeIo';
import { MAX_DELIVERY_LINE_BYTES, MAX_RESEARCH_NOTES_BYTES } from './deliveries';
import { prepareResearchDelivery, ResearchAdmissionError, type ResearchAdmissionScope } from './researchAdmission';
import { researchPublicationNotes } from './researchPublication';
import { assignmentDeliveryFile, taskVersion, type TaskAssignment, type TaskRecord } from './tasks';

/** Shell-side preflight and one append; the host independently admits, snapshots and scopes the event. */
export function queueResearchObservation(input: {
  worktree: string; finding: unknown; probes?: readonly string[]; snapshotSources?: boolean;
}) {
  const worktree = path.resolve(input.worktree);
  assertMathCanonicalPath(worktree);
  const local = (file: string) => {
    const resolved = path.resolve(worktree, file);
    if (!isMathPathWithin(worktree, resolved) || resolved === worktree) throw new Error('math_observation_path_outside_worktree');
    assertMathCanonicalPath(resolved);
    return resolved;
  };
  const context = JSON.parse(readMathText(local('COOPERATION.json'), 32_000_000));
  const delivery = context.researchDelivery as {
    assignment: TaskAssignment; problemReceiptDigest: string; environmentDigest: string;
    projectRelative: string; ownedFiles: string[];
  } | undefined;
  if (!delivery?.assignment || !delivery.problemReceiptDigest || !delivery.environmentDigest || !Array.isArray(context.tasks))
    throw new Error('math_observation_no_current_assignment');
  const source = (context.tasks as TaskRecord[]).find(node => node.task.id === delivery.assignment.taskId);
  if (!source || taskVersion(source.task) !== delivery.assignment.taskDigest)
    throw new Error('math_observation_assignment_changed');
  const scope: ResearchAdmissionScope = { source: source.task, assignment: delivery.assignment,
    identity: { problemReceiptDigest: delivery.problemReceiptDigest, environmentDigest: delivery.environmentDigest },
    tasks: context.tasks, deliveries: context.deliveries, ...(context.nextChecks ? { nextChecks: context.nextChecks } : {}),
    ...(context.proofSearchRecords ? { proofSearchRecords: context.proofSearchRecords } : {}) };
  const admission = prepareResearchDelivery({ kind: 'event', value: input.finding }, scope);
  if (admission.status === 'rejected') throw new ResearchAdmissionError(admission);
  const probes = input.probes?.map(file => ({ source: path.relative(worktree, local(file)),
    code: readMathText(local(file), MAX_RESEARCH_NOTES_BYTES) }));
  researchPublicationNotes(admission.finding, probes);
  let sources: Record<string, string> | undefined;
  if (input.snapshotSources) {
    if (!Array.isArray(delivery.ownedFiles) || typeof delivery.projectRelative !== 'string')
      throw new Error('math_observation_source_context_missing');
    sources = Object.fromEntries(delivery.ownedFiles.map(file => [file,
      readMathText(local(path.join(delivery.projectRelative, file)), MAX_RESEARCH_NOTES_BYTES)]));
    if (Object.values(sources).reduce((bytes, source) => bytes + Buffer.byteLength(source), 0) > MAX_RESEARCH_NOTES_BYTES)
      throw new Error('math_observation_sources_too_large');
  }
  const value = { kind: 'research', finding: admission.finding, ...(probes ? { probes } : {}), ...(sources ? { sources } : {}) };
  const file = assignmentDeliveryFile(delivery.assignment), output = local(file);
  const line = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(line) > MAX_DELIVERY_LINE_BYTES) throw new Error('math_observation_too_large');
  const fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { status: 'queued', authority: 'advisory-unverified',
    submissionId: mathDigest(canonicalMathJson({ file, value })), file,
    taskId: delivery.assignment.taskId, taskDigest: delivery.assignment.taskDigest,
    retainedProbes: probes?.length ?? 0, snapshotSources: Boolean(sources),
    receipt: 'Read the host deliveryReceipts in COOPERATION.json; queued is not host acceptance.' };
}
