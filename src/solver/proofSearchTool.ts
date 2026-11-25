import fs from 'node:fs';
import path from 'node:path';
import { assertMathCanonicalPath } from '../math/paths';
import { mathDigest, readMathText } from '../math/mathRuntimeIo';
import { proofSearchRequestSchema, searchLeanBranches, type SearchCheckpointReference } from '../math/leanProofSearch';
import { proofSearchCheckForAssignment, proofSearchRecordMatches } from './proofSearchRecords';
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
  const check = proofSearchCheckForAssignment(delivery.assignment, checks, identity);
  const { taskId, taskDigest } = check?.scope.target ?? delivery.assignment;
  const target = { taskId, taskDigest };
  const task = tasks.find(node => node.task.id === target.taskId)?.task;
  if (!task || taskVersion(task) !== target.taskDigest) throw new Error('proof_search_assignment_changed');
  if (task.kind !== 'lemma' || task.declaration || task.conditional || !task.type || !task.proofPath || !task.theoremName)
    throw new Error('proof_search_unsupported_target: materialize a plain helper lemma with its closed task type');
  if (!delivery.ownedFiles.includes(task.proofPath) || requested.file && requested.file !== task.proofPath ||
      requested.theoremName && requested.theoremName !== task.theoremName) throw new Error('proof_search_target_outside_assignment');
  const scope = { ...identity, ...target };
  const projected = context.proofSearchRecords?.[target.taskId], basis = check?.scope.executionBasisDigest;
  const seed = check?.proofSearchSeed;
  const record = proofSearchRecordMatches(projected, scope) && (!check || projected.history === check.id ||
    basis && (!seed || projected.checkpoint.digest === seed.checkpoint.digest)) ? projected : undefined;
  if (basis && record?.basisDigest !== basis)
    throw new Error('proof_search_stale_next_check_basis');
  return { worktree, project, task, scope, record, assignment: delivery.assignment,
    history: check?.id, independentSearch: Boolean(check?.scope.executionBasisDigest) };
}

export async function runProofSearchTool(input: { projectRoot: string; request: unknown;
  file?: string; theoremName?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv }) {
  const context = proofSearchToolContext(input.projectRoot, input);
  const constraints = path.join(context.project, '.lake/source-constraints.json');
  if (fs.existsSync(constraints)) assertSolverProjectSources(JSON.parse(readMathText(constraints)) as SolverSourceConstraints, context.project);
  const request = proofSearchRequestSchema.parse(input.request);
  const assignmentKey = assignmentDeliveryFile(context.assignment);
  const implicitResume = !request.resume && context.record;
  if (implicitResume && !context.independentSearch) request.resume = implicitResume.checkpoint;
  const queueCheckpoint = (reference: SearchCheckpointReference) => {
    const event = { kind: 'progress', id: reference.digest,
      summary: 'Saved advisory proof-search state; candidate proofs require independent verification.',
      searchCheckpoint: reference };
    const line = JSON.stringify(event) + '\n';
    if (Buffer.byteLength(line) > MAX_DELIVERY_LINE_BYTES) throw new Error('proof_search_delivery_too_large');
    const output = path.join(context.worktree, assignmentKey); assertMathCanonicalPath(output);
    const descriptor = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(descriptor, line); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  };
  const result = await searchLeanBranches({ projectRoot: context.project, file: context.task.proofPath!,
    theoremName: context.task.theoremName!, type: context.task.type!, scope: context.scope, request,
    history: context.history,
    restartStaleImplicitResume: Boolean(implicitResume && !context.independentSearch),
    ...(context.independentSearch && context.record ? { retainedInput: {
      basisDigest: context.record.basisDigest, checkpoint: context.record.checkpoint, assignmentKey } } : {}),
    signal: input.signal, env: input.env, onCheckpoint: queueCheckpoint });
  return { ...result, taskId: context.scope.taskId, taskDigest: context.scope.taskDigest,
    requestDigest: mathDigest(JSON.stringify(request)) };
}
