import { mathDigest } from '../../src/math/mathRuntimeIo';
import { inspectScopedLeanDeclarations } from '../../src/math/leanSource';
import { selectLibraryDeclarations } from '../../src/math/libraryPacks';
import type { ResearchAssetPrefill } from './researchAssetTypes';
import type { WebJobs } from './jobs';
import type { WebRun } from './shared';
import { WebStorage, WebStorageError } from './storage';

const fail = (status: number, message: string): never => { throw new WebStorageError(status, message); };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const exactCommit = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export type ResearchRunAssetSelection = { runId: string; taskId?: string; commit?: string; taskVersion?: string };

/** Read the frozen final result, never a task snapshot which happens to be newer. */
export function acceptedRunAsset(run: WebRun): ResearchAssetPrefill {
  const result = run.result, report = result?.report, commit = report?.solution_commit;
  if (run.status !== 'completed' || result?.status !== 'evaluated_passed' || report?.status !== 'evaluated_passed')
    fail(409, '此运行尚未通过完整原题验收，不能保存为完整证明。');
  if (!exactCommit(commit) || !result!.proof.trim()) fail(409, '最终证明或精确源码提交没有完整保存，无法确定成果来源。');
  const evaluator = object(report!.evaluator), check = object(evaluator?.verification), batch = object(check?.verification);
  const rows = Array.isArray(batch?.results) ? batch.results.map(object) : [];
  const sourceDigest = check?.sourceDigest;
  if (evaluator?.status !== 'passed' || evaluator.method !== 'host-lean-kernel-all-targets' || check?.passed !== true ||
      check.commit !== commit || !digest(sourceDigest) || batch?.schema !== 'deepscientist.mathematics.verification-batch/v1' ||
      batch.status !== 'kernel_verified' || batch.targetCommit !== commit || !rows.length || rows.some(row => !row ||
        row.status !== 'kernel_verified' || row.targetCommit !== commit || row.claim !== 'statement' ||
        typeof row.theoremName !== 'string' || typeof row.proofPath !== 'string' || typeof row.receiptId !== 'string' || !row.receiptId))
    fail(409, '完整原题的验收回执不完整或与源码提交不一致，无法固定这个成果。');
  const observed = run.observation, targets = observed?.inspection.problem.targets;
  if (observed && (report!.runId !== observed.solverRunId || report!.problemId !== observed.inspection.problem.id ||
      targets?.length && (rows.length !== targets.length || targets.some((target, index) => {
        const row = rows[index]!;
        return row!.theoremName !== target.theoremName || row!.proofPath !== target.proofPath ||
          Boolean(target.declarationHash && row!.sourceDeclarationHash !== target.declarationHash);
      })))) fail(409, '验收回执对应的原题与当前运行记录不一致。');
  const declarations = inspectScopedLeanDeclarations(result!.proof).filter(item => item.kind === 'theorem')
    .map(item => ({ name: item.qualifiedName, type: item.declarationType, file: 'Submission.lean' }));
  if (!declarations.length || rows.some(row => !declarations.some(item => item.name === row!.theoremName)))
    fail(409, '最终证明中没有保存验收回执所指向的全部定理。');
  const proofDigest = mathDigest(result!.proof);
  const runtimeDigest = observed?.inspection.configuration.environmentDigest;
  const dependencyDigest = object(report!.environment)?.dependencyDigest;
  return { name: run.title.slice(0, 120), description: '完整原题已通过独立 Lean 验收。来源与验收回执随成果保留。',
    source: { kind: 'run', runId: run.id, scope: 'original-proof', commit: commit as string, proofDigest }, environment: run.environment,
    evidence: { scope: 'original-proof', commit: commit as string, file: 'Submission.lean', sourceDigest: sourceDigest as string, proofDigest,
      ...(digest(runtimeDigest) ? { environmentDigest: runtimeDigest } : {}), ...(digest(dependencyDigest) ? { dependencyDigest } : {}),
      checkRefs: rows.map(row => row!.receiptId as string), declarations } };
}

/** Preparing a Library draft has no side effects and cannot start a model or Lean check. */
export function researchAssetFromRun(storage: WebStorage, jobs: WebJobs, owner: string, selection: ResearchRunAssetSelection): ResearchAssetPrefill {
  const run = jobs.get(owner, selection.runId) ?? fail(404, '运行不存在或不属于你。');
  if (!selection.taskId) {
    if (selection.taskVersion) fail(400, '任务版本需要对应的任务 ID。');
    const prefill = acceptedRunAsset(run);
    if (selection.commit && selection.commit !== prefill.evidence.commit) fail(409, '所选提交与完整原题的验收提交不一致。');
    return prefill;
  }
  if (!exactCommit(selection.commit)) fail(400, '保存任务成果需要精确的完整源码提交。');
  const observations = storage.listObservations(owner, run.id).reverse();
  const sources = observations.flatMap(item => item.sources).filter(item => item.taskId === selection.taskId && item.commit === selection.commit
    && (!selection.taskVersion || item.taskVersion === selection.taskVersion));
  if (!selection.taskVersion && new Set(sources.map(item => item.taskVersion)).size > 1) fail(409, '同一提交包含多个任务版本，请明确选择要保存的任务版本。');
  const saved = sources[0] ?? fail(404, '这个任务版本的源码没有保存，不能从其他版本替代。');
  const environmentDigest = saved.environmentDigest;
  if (!digest(environmentDigest) || !digest(saved.sourceDigest)) fail(409, '任务源码的证明环境记录不完整或不一致。');
  const snapshot = observations.find(item => item.sources.some(source => source.taskId === saved.taskId && source.taskVersion === saved.taskVersion
    && source.commit === saved.commit && source.sourceDigest === saved.sourceDigest && source.environmentDigest === saved.environmentDigest)
    && [...item.inspection.tasks, ...(item.history ?? [])].some(task => task.id === saved.taskId && task.version === saved.taskVersion));
  const task = snapshot && [...snapshot.inspection.tasks, ...(snapshot.history ?? [])].find(item => item.id === saved.taskId && item.version === saved.taskVersion);
  const theorem = task?.theorem ?? fail(409, '这个任务版本缺少精确的数学声明记录。');
  const receipts = observations.flatMap(item => item.checks).filter(receipt => receipt.taskId === saved.taskId && receipt.taskVersion === saved.taskVersion
    && receipt.commit === saved.commit && receipt.sourceDigest === saved.sourceDigest && receipt.environmentDigest === saved.environmentDigest
    && receipt.record.passed === true && receipt.record.status === 'kernel_verified' && receipt.record.theoremName === theorem
    && receipt.record.proofPath === saved.file && (receipt.record.conditions === undefined || Array.isArray(receipt.record.conditions) && receipt.record.conditions.length === 0)
    && (() => {
      const verification = object(receipt.record.verification), references = object(receipt.record.references), root = object(references?.root);
      const checkedCommit = verification?.targetCommit;
      if (verification?.schema !== 'deepscientist.mathematics.verification-batch/v1' || verification.status !== 'kernel_verified' ||
          !exactCommit(checkedCommit) || receipt.record.targetCommit !== checkedCommit) return false;
      if (receipt.record.statementHash !== undefined && receipt.record.statementHash !== saved.taskVersion ||
          receipt.record.leanStatementHash !== undefined && receipt.record.leanStatementHash !== saved.taskVersion) return false;
      // Cooperative checks run on an isolated declaration projection. Its commit differs from the owned source commit.
      // The host's captured references bind that projection back to the original bytes, task root and runtime environment.
      const bound = references?.sourceCommit === saved.commit && references.environmentDigest === environmentDigest &&
        root?.file === saved.file && root.name === theorem && references.scope !== 'statement';
      return references ? bound : checkedCommit === saved.commit;
    })());
  if (!receipts.length) fail(409, '这个精确任务版本没有无条件通过的 Lean 检查回执。');
  let selected: string;
  try { selected = selectLibraryDeclarations(saved.source, [theorem]); }
  catch { return fail(409, '无法从该任务源码中确定可保存的数学声明。'); }
  const declarations = inspectScopedLeanDeclarations(selected).filter(item => item.kind === 'theorem')
    .map(item => ({ name: item.qualifiedName, type: item.declarationType, file: saved.file }));
  const dependencyDigest = object(run.result?.report.environment)?.dependencyDigest;
  return { name: theorem.slice(0, 120), description: '已通过 Lean 检查的任务成果；不代表完整原题已经验收。',
    source: { kind: 'run', runId: run.id, taskId: saved.taskId, taskVersion: saved.taskVersion, commit: saved.commit, scope: 'checked-task' }, environment: run.environment,
    evidence: { scope: 'task', commit: saved.commit, taskVersion: saved.taskVersion, file: saved.file,
      sourceDigest: saved.sourceDigest, environmentDigest, ...(digest(dependencyDigest) ? { dependencyDigest } : {}),
      checkRefs: [...new Set(receipts.map(receipt => receipt.id))], declarations } };
}
