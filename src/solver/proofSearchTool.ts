import fs from 'node:fs';
import path from 'node:path';
import { assertMathCanonicalPath } from '../math/paths';
import { mathDigest, readMathText } from '../math/mathRuntimeIo';
import { proofSearchRequestSchema, searchLeanBranches, type SearchCheckpointReference } from '../math/leanProofSearch';
import { proofSearchRecordMatches, proofSearchTargetForAssignment } from './proofSearchRecords';
import { currentNextCheck } from './nextChecks';
import { assignmentDeliveryFile, taskVersion, type TaskAssignment, type TaskRecord } from './tasks';
import { assertSolverProjectSources, type SolverSourceConstraints } from './problem';
import { MAX_DELIVERY_LINE_BYTES } from './deliveries';

/** Read the host-published assignment; a request may choose tactics, never its own task or environment identity. */
export function proofSearchToolContext(projectRoot: string, requested: { file?: string; theoremName?: string } = {}) {
  const project = fs.realpathSync(projectRoot);
  let worktree = project;
  while (!fs.existsSync(path.join(worktree, 'COOPERATION.json'))) {
    const parent = path.dirname(worktree); if (parent === worktree) throw new Error('proof_search_no_current_assignment');
    worktree = parent;
  }
  assertMathCanonicalPath(path.join(worktree, 'COOPERATION.json'));
  const context = JSON.parse(readMathText(path.join(worktree, 'COOPERATION.json'), 32_000_000));
  const delivery = context.researchDelivery as { assignment: TaskAssignment; projectRelative: string;
    ownedFiles: string[]; problemReceiptDigest: string; environmentDigest: string } | undefined;
  if (!delivery?.assignment || !Array.isArray(context.tasks) || !Array.isArray(delivery.ownedFiles) ||
      typeof delivery.projectRelative !== 'string' || path.resolve(worktree, delivery.projectRelative) !== project)
    throw new Error('proof_search_no_current_assignment');
  const tasks = context.tasks as TaskRecord[], owner = tasks.find(node => node.task.id === delivery.assignment.taskId);
  if (!owner || taskVersion(owner.task) !== delivery.assignment.taskDigest) throw new Error('proof_search_assignment_changed');
  const identity = { problemReceiptDigest: delivery.problemReceiptDigest, environmentDigest: delivery.environmentDigest };
  const checks = (context.nextChecks ?? []).filter(record => currentNextCheck(record, context, identity));
  const target = proofSearchTargetForAssignment(delivery.assignment, checks, identity);
  const task = tasks.find(node => node.task.id === target.taskId)?.task;
  if (!task || taskVersion(task) !== target.taskDigest) throw new Error('proof_search_assignment_changed');
  if (task.kind !== 'lemma' || task.declaration || task.conditional || !task.type || !task.proofPath || !task.theoremName)
    throw new Error('proof_search_unsupported_target: materialize a plain helper lemma with its closed task type');
  if (!delivery.ownedFiles.includes(task.proofPath) || requested.file && requested.file !== task.proofPath ||
      requested.theoremName && requested.theoremName !== task.theoremName) throw new Error('proof_search_target_outside_assignment');
  const scope = { ...identity, ...target }, saved = context.proofSearchRecords?.[target.taskId];
  const record = proofSearchRecordMatches(saved, scope) ? saved : undefined;
  const check = checks.find(item => item.taskId === owner.task.id);
  if (check?.scope.executionBasisDigest && record?.basisDigest !== check.scope.executionBasisDigest)
    throw new Error('proof_search_stale_next_check_basis');
  return { worktree, project, task, scope, record, assignment: delivery.assignment,
    independentSearch: Boolean(check?.check.execution?.kind === 'proof-search' && check.scope.executionBasisDigest &&
      target.taskId !== owner.task.id) };
}

export async function runProofSearchTool(input: { projectRoot: string; request: unknown;
  file?: string; theoremName?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv }) {
  const context = proofSearchToolContext(input.projectRoot, input);
  const constraints = path.join(context.project, '.lake/source-constraints.json');
  if (fs.existsSync(constraints)) assertSolverProjectSources(JSON.parse(readMathText(constraints)) as SolverSourceConstraints, context.project);
  const request = proofSearchRequestSchema.parse(input.request);
  if (!request.resume && context.record) request.resume = context.record.checkpoint;
  const queueCheckpoint = (reference: SearchCheckpointReference) => {
    const event = { kind: 'progress', id: reference.digest,
      summary: 'Saved advisory proof-search state; candidate proofs require independent verification.',
      searchCheckpoint: reference };
    const line = JSON.stringify(event) + '\n';
    if (Buffer.byteLength(line) > MAX_DELIVERY_LINE_BYTES) throw new Error('proof_search_delivery_too_large');
    const output = path.join(context.worktree, assignmentDeliveryFile(context.assignment)); assertMathCanonicalPath(output);
    const descriptor = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(descriptor, line); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  };
  const result = await searchLeanBranches({ projectRoot: context.project, file: context.task.proofPath!,
    theoremName: context.task.theoremName!, type: context.task.type!, scope: context.scope, request,
    ...(context.independentSearch && context.record ? { retainedInput: {
      basisDigest: context.record.basisDigest, checkpointDigest: context.record.checkpoint.digest } } : {}),
    signal: input.signal, env: input.env, onCheckpoint: queueCheckpoint });
  return { ...result, taskId: context.scope.taskId, taskDigest: context.scope.taskDigest,
    requestDigest: mathDigest(JSON.stringify(request)) };
}
