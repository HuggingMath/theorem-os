import fs from 'node:fs';
import path from 'node:path';
import { canonicalMathJson, mathDigest, readMathText, syncMathDirectory, withMathRuntimeLease } from '../math/mathRuntimeIo';
import { inspectLeanDeclarationRegions, inspectLeanSource, inspectScopedLeanDeclarations } from '../math/leanSource';
import { leanScopeCommands, leanScopeNamespace, maskLeanCommentsAndStrings, updateLeanScopes, type LeanScope } from '../math/leanSyntax';
import type { SolverRunState } from './archive';
import type { CooperativeResearch } from './cooperation';
import { applyTaskChanges, declarationStartWithDoc, type DeclarationChange } from './cooperativeProof';
import { readRunInspection } from './inspection';
import type { ResearchWorker } from './modules/organization';
import { committedSource, commitSolverSources } from './problem';
import { proofImportRequestSchema, type ProofImportRequest, type ProofImportRecord } from './proofImportRecord';
import { assignmentDeliveryFile, taskVersion, type CooperativeAction } from './tasks';
import type { WorkerProofLifecycle } from './workerProofLifecycle';

const logName = 'proof-imports.jsonl';
const fragmentLimit = 256 * 1024;
const requestDigest = (request: ProofImportRequest) => mathDigest(canonicalMathJson(request));

function fragmentDeclarations(fragment: string) {
  if (Buffer.byteLength(fragment) > fragmentLimit) throw new Error('math_proof_import_too_large');
  const inspected = inspectLeanSource(fragment), clean = maskLeanCommentsAndStrings(fragment);
  if (inspected.sorryCount || inspected.admitCount || inspected.axioms.length) throw new Error('math_proof_import_incomplete');
  const regions = inspectLeanDeclarationRegions(clean);
  if (!regions.length || new Set(regions.map(region => region.name)).size !== regions.length ||
      regions.some(region => !/^(?:theorem|lemma)\s/u.test(clean.slice(region.startOffset, region.bodyOffset))))
    throw new Error('math_proof_import_requires_lemmas');
  // A fragment supplies declarations, never imports, scopes, options, attributes, commands or elaborators.
  if (/^[ \t]*(?:#|import\b|namespace\b|section\b|end\b|open\b|variable\b|universe\b|set_option\b|attribute\b|export\b|syntax\b|macro\b|elab\b|notation\b|initialize\b|builtin_initialize\b)/mu.test(clean))
    throw new Error('math_proof_import_context_changed');
  let rest = clean;
  for (const region of regions.toReversed()) rest = rest.slice(0, region.startOffset) + rest.slice(region.endOffset);
  if (rest.trim()) throw new Error('math_proof_import_context_changed');
  return inspectLeanDeclarationRegions(fragment);
}

function requests(directory: string): ProofImportRequest[] {
  const file = path.join(directory, logName);
  if (!fs.existsSync(file)) return [];
  const source = readMathText(file, 8 * 1024 * 1024);
  if (source && !source.endsWith('\n')) throw new Error('math_proof_import_incomplete_log');
  return source.split('\n').filter(Boolean).map(line => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error('math_proof_import_invalid'); }
    const request = proofImportRequestSchema.safeParse(parsed);
    if (!request.success) throw new Error('math_proof_import_invalid');
    return request.data;
  });
}

/** Capture fragment bytes under the same CAS/append lease as human edits; never write the run checkpoint. */
export async function queueProofImport(run: string, input: {
  taskId: string; fragmentFile: string; sha256: string; baseVersion: string; id?: string; beforeTheorem?: string;
}, dryRun = false) {
  const fragment = readMathText(input.fragmentFile, fragmentLimit);
  if (!/^[a-f0-9]{64}$/u.test(input.sha256) || mathDigest(fragment) !== input.sha256)
    throw new Error('math_proof_import_hash_mismatch');
  fragmentDeclarations(fragment);
  const directory = path.dirname(readRunInspection(run).stateFile);
  return withMathRuntimeLease({ lockPath: path.join(directory, 'edits.lock'), flockExecutable: '/usr/bin/flock' }, async lease => {
    const { state } = readRunInspection(run), archive = state.cooperation;
    const node = archive?.tasks.find(node => node.task.id === input.taskId);
    if (!archive?.planVersion || !archive.canonicalCommit) throw new Error('math_proof_import_plan_unavailable');
    if (!node || node.task.kind !== 'lemma' || !node.task.proofPath || !node.task.theoremName ||
        (node.task.status ?? 'active') !== 'active') throw new Error('math_proof_import_task_invalid');
    if (input.beforeTheorem !== undefined) insertionOffset(committedSource(state.worktree, archive.canonicalCommit,
      `${state.problem.projectRelative}/${node.task.proofPath}`), node.task.theoremName, input.beforeTheorem);
    const value = { schema: 'theorem-os.proof-fragment.v1' as const, runId: state.runId,
      baseVersion: input.baseVersion, taskId: node.task.id, taskDigest: taskVersion(node.task),
      proofPath: node.task.proofPath, theoremName: node.task.theoremName, seedCommit: archive.canonicalCommit,
      ...(input.beforeTheorem !== undefined ? { beforeTheorem: input.beforeTheorem } : {}),
      problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest,
      fragment, fragmentSha256: input.sha256 };
    const id = input.id ?? mathDigest(canonicalMathJson({ runId: state.runId, baseVersion: input.baseVersion,
      taskId: input.taskId, fragmentSha256: input.sha256,
      ...(input.beforeTheorem !== undefined ? { beforeTheorem: input.beforeTheorem } : {}) }));
    const parsed = proofImportRequestSchema.safeParse({ ...value, id });
    if (!parsed.success) throw new Error('math_proof_import_invalid');
    const request = parsed.data, queued = requests(directory), previous = queued.find(item => item.id === id);
    if (previous) {
      if (requestDigest(previous) !== requestDigest({ ...request, seedCommit: previous.seedCommit,
        problemReceiptDigest: previous.problemReceiptDigest, environmentDigest: previous.environmentDigest }))
        throw new Error('math_proof_import_id_conflict');
      return { id, status: 'already_queued', taskId: request.taskId, fragmentSha256: request.fragmentSha256 };
    }
    if (archive.proofImports?.some(item => item.id === id)) throw new Error('math_proof_import_id_conflict');
    if (input.baseVersion !== archive.planVersion) throw new Error('math_proof_import_version_conflict');
    if (node.status !== 'pending') throw new Error('math_proof_import_task_busy');
    if (queued.some(item => item.taskId === request.taskId && !archive.proofImports?.some(record =>
      record.id === item.id && !['received', 'frozen'].includes(record.status))))
      throw new Error('math_proof_import_task_queued');
    if (dryRun) return { id, status: 'validated', taskId: request.taskId, fragmentSha256: request.fragmentSha256 };
    const bytes = Buffer.from(JSON.stringify(request) + '\n');
    if (bytes.length > 1024 * 1024) throw new Error('math_proof_import_too_large');
    lease.assertHeld();
    const fd = fs.openSync(path.join(directory, logName), fs.constants.O_CREAT | fs.constants.O_WRONLY |
      fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('math_proof_import_log_invalid');
      let offset = 0;
      while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    syncMathDirectory(directory);
    return { id, status: 'queued', taskId: request.taskId, fragmentSha256: request.fragmentSha256 };
  });
}

/** Choose an existing namespace boundary; importing does not add or alter source context. */
function insertionOffset(source: string, theoremName: string, beforeTheorem?: string): number {
  const namespace = theoremName.includes('.') ? theoremName.slice(0, theoremName.lastIndexOf('.')) : '';
  const declarations = inspectScopedLeanDeclarations(source), regions = inspectLeanDeclarationRegions(source);
  if (beforeTheorem !== undefined) {
    const anchor = declarations.find(declaration => declaration.qualifiedName === beforeTheorem);
    if (!anchor || anchor.namespace !== namespace) throw new Error('math_proof_import_invalid_anchor');
    return declarationStartWithDoc(source, anchor.startOffset);
  }
  const previous = declarations.findLast(declaration => declaration.namespace === namespace);
  if (previous) return regions.find(region => region.startOffset === previous.startOffset)!.endOffset;
  const scopes: LeanScope[] = [];
  let offset = -1;
  for (const command of leanScopeCommands(maskLeanCommentsAndStrings(source))) {
    if (command[1] === 'end' && scopes.at(-1)?.kind !== 'mutual' && leanScopeNamespace(scopes) === namespace) offset = command.index;
    updateLeanScopes(scopes, command[1], command[2]?.trim());
  }
  if (leanScopeNamespace(scopes) === namespace) offset = source.length;
  if (offset < 0) throw new Error('math_proof_import_missing_context');
  return offset;
}

export function proofFragmentChanges(source: string,
  request: Pick<ProofImportRequest, 'fragment' | 'proofPath' | 'theoremName' | 'beforeTheorem'>): {
  changes: DeclarationChange[]; source: string;
} {
  const regions = fragmentDeclarations(request.fragment), existing = inspectLeanDeclarationRegions(source);
  const offset = insertionOffset(source, request.theoremName, request.beforeTheorem), tail = source.slice(offset);
  const text = (value: string, region: typeof regions[number]) => value.slice(
    value.lastIndexOf('\n', region.startOffset - 1) + 1, region.endOffset).trimEnd() + '\n';
  const additions = regions.filter(region => {
    const previous = existing.find(item => item.name.split('.').at(-1) === region.name.split('.').at(-1));
    if (!previous) return true;
    if (previous.name !== region.name || text(source, previous) !== text(request.fragment, region))
      throw new Error('math_proof_import_declaration_conflict');
    return false;
  });
  const added = additions.map(region => text(request.fragment, region)).join('');
  const result = source.slice(0, offset) + added + tail;
  const targets = inspectScopedLeanDeclarations(result).filter(declaration =>
    declaration.qualifiedName === request.theoremName || !request.theoremName.includes('.') && declaration.name === request.theoremName);
  if (targets.length !== 1) throw new Error('math_proof_import_target_missing');
  return { source: result, changes: additions.map(region => ({ file: request.proofPath,
    name: region.name, after: text(request.fragment, region), tail })) };
}

/** Mirror proof-ready progress; imported bytes and old receipts never establish proof acceptance. */
export function syncProofImports(state: SolverRunState): void {
  for (const record of state.cooperation?.proofImports ?? []) {
    const ready = state.cooperation?.proofReadyRecords?.find(ready => ready.id === record.readyId ||
      ready.submissionId === record.id && ready.workerId === record.workerId &&
      ready.assignmentKey === record.assignmentKey && ready.snapshotCommit === record.snapshotCommit);
    if (ready && ['frozen', 'checked', 'failed', 'superseded'].includes(ready.status)) {
      record.readyId = ready.id;
      record.status = ready.status as 'frozen' | 'checked' | 'failed' | 'superseded'; record.reason = ready.reason;
    }
  }
}

/** Consume an import only after normal M3/M5 assignment and before opening a model writer. */
export async function importAssignedProof(input: {
  state: SolverRunState; directory: string; worker: ResearchWorker; action: CooperativeAction | undefined;
  cooperation: CooperativeResearch; lifecycle: Pick<WorkerProofLifecycle, 'resumeFrozen'>;
  close: () => Promise<void>; save: () => void; emit: (event: string, details?: Record<string, unknown>) => void;
}): Promise<boolean> {
  const { state, worker, action, cooperation, save, emit } = input;
  if (action?.kind !== 'task' || action.task.kind !== 'lemma') return false;
  syncProofImports(state);
  const archive = state.cooperation!, records = archive.proofImports ??= [];
  const request = requests(input.directory).find(request => request.taskId === action.task.id &&
    !records.some(record => record.id === request.id && !['received', 'frozen'].includes(record.status)));
  if (!request) return false;
  let record = records.find(record => record.id === request.id);
  if (!record) {
    record = { id: request.id, requestDigest: requestDigest(request), taskId: request.taskId, taskDigest: request.taskDigest,
      fragmentSha256: request.fragmentSha256, status: 'received', receivedAt: Date.now() };
    records.push(record); save();
  }
  const progress = record;
  const finish = (status: ProofImportRecord['status'], reason?: string) => {
    progress.status = status; progress.reason = reason; save();
    emit('proof_import_' + status, { id: request.id, taskId: request.taskId, fragmentSha256: request.fragmentSha256,
      commit: progress.snapshotCommit, reason });
  };
  const current = () => cooperation.current(action) && request.runId === state.runId &&
    request.taskDigest === taskVersion(action.task) && request.proofPath === action.task.proofPath && request.theoremName === action.task.theoremName &&
    request.problemReceiptDigest === state.problem.receiptDigest && request.environmentDigest === state.environmentDigest;
  if (progress.requestDigest !== requestDigest(request) || mathDigest(request.fragment) !== request.fragmentSha256) {
    finish('rejected', 'math_proof_import_hash_mismatch'); return false;
  }
  if (!current() || !progress.snapshotCommit && (request.baseVersion !== archive.planVersion ||
      request.seedCommit !== (action.assignment.canonicalCommit ?? action.assignment.seedCommit))) {
    finish('superseded', 'math_proof_import_basis_changed'); return false;
  }
  await input.close();
  if (!current()) { finish('superseded', 'math_proof_import_assignment_changed'); return true; }
  const assignmentKey = assignmentDeliveryFile(action.assignment);
  if (progress.snapshotCommit && (progress.workerId !== worker.id || progress.assignmentKey !== assignmentKey)) {
    finish('superseded', 'math_proof_import_assignment_changed'); return false;
  }
  if (!progress.snapshotCommit) {
    const file = path.join(worker.worktree, state.problem.projectRelative, request.proofPath);
    const notes = path.join(worker.worktree, 'RESEARCH.md'), original = fs.readFileSync(file, 'utf8');
    const previousNotes = fs.existsSync(notes) ? fs.readFileSync(notes) : undefined;
    let committed = false;
    try {
      const seed = committedSource(worker.worktree, action.assignment.seedCommit, `${state.problem.projectRelative}/${request.proofPath}`);
      const prepared = proofFragmentChanges(seed, request);
      for (const owned of state.problem.ownedFiles) {
        const actual = fs.readFileSync(path.join(worker.worktree, state.problem.projectRelative, owned), 'utf8');
        const before = committedSource(worker.worktree, action.assignment.seedCommit, `${state.problem.projectRelative}/${owned}`);
        if (actual !== before && !(owned === request.proofPath && actual === prepared.source))
          throw new Error('math_proof_import_workspace_changed');
      }
      applyTaskChanges(state.problem, worker.worktree, prepared.changes);
      fs.writeFileSync(notes, `Imported proof fragment ${request.id}\nSHA-256: ${request.fragmentSha256}\n`);
      progress.snapshotCommit = commitSolverSources(state.problem, worker.worktree); committed = true;
      progress.workerId = worker.id; progress.assignmentKey = assignmentKey; save();
    } catch (error) {
      if (committed) throw error;
      fs.writeFileSync(file, original);
      if (previousNotes) fs.writeFileSync(notes, previousNotes); else fs.rmSync(notes, { force: true });
      if (!(error instanceof Error) || !error.message.startsWith('math_')) throw error;
      finish('rejected', error.message); return false;
    }
  }
  const ready = cooperation.freezeImportedProof(worker, action, request.id, progress.snapshotCommit!);
  if (!ready) { finish('superseded', 'math_proof_import_assignment_changed'); return true; }
  progress.readyId = ready.id; finish('frozen');
  await input.lifecycle.resumeFrozen(action);
  syncProofImports(state); save();
  emit('proof_import_completed', { id: request.id, taskId: request.taskId, status: progress.status,
    commit: progress.snapshotCommit, readyId: progress.readyId });
  return true;
}
