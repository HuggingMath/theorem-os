import type { WebRun } from './shared';
import { t } from './i18n';
import { isAcceptedRun } from './presentation';

export type ReportTone = 'passed' | 'failed' | 'warning' | 'muted';
export type ReportDiagnostic = { label: string; text: string; truncated: boolean };
export type ReportTarget = {
  name: string;
  status: string;
  tone: ReportTone;
  sorryCount?: number;
  admitCount?: number;
  diagnostics: ReportDiagnostic[];
};
export type ReportCheck = {
  id: 'candidate' | 'evaluation';
  label: string;
  status: string;
  tone: ReportTone;
  method?: string;
  reason?: string;
  targets: ReportTarget[];
  omittedTargets: number;
};
export type ReportSummary = {
  reason?: string;
  checks: ReportCheck[];
  metrics: { label: string; value: string }[];
  identity: { label: string; value: string }[];
};

const maximumText = 4_000;
const maximumTargets = 64;
type Status = Pick<ReportTarget, 'status' | 'tone'>;
const targetStatuses = new Map<string, Status>([
  ['kernel_verified', { status: t('Lean 内核通过'), tone: 'passed' }],
  ['failed', { status: t('检查未通过'), tone: 'failed' }],
  ['blocked', { status: t('检查受阻'), tone: 'warning' }],
  ['unavailable', { status: t('检查不可用'), tone: 'warning' }],
]);
const evaluationStatuses = new Map<string, Status>([
  ['passed', { status: t('验收阶段通过'), tone: 'passed' }],
  ['failed', { status: t('验收阶段未通过'), tone: 'failed' }],
  ['error', { status: t('验收阶段错误'), tone: 'failed' }],
  ['skipped', { status: t('已跳过'), tone: 'muted' }],
]);
const evaluationMethods = new Map<string, string>([
  ['host-lean-kernel-all-targets', t('Lean 内核 · 全部目标')],
  ['external-command', t('外部命令')],
  ['official-comparator', t('官方比较器')],
]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, maximumText) : undefined;
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function status(value: string | undefined, labels: ReadonlyMap<string, Status>): Status {
  return value ? labels.get(value) ?? { status: value, tone: 'muted' }
    : { status: t('未提供状态'), tone: 'muted' };
}

function diagnostics(row: Record<string, unknown>): ReportDiagnostic[] {
  const result: ReportDiagnostic[] = [];
  const seen = new Set<string>();
  for (const [key, label] of [['error', t('错误')], ['stdoutPreview', t('标准输出')], ['stderrPreview', t('标准错误')]]) {
    const raw = row[key];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push({ label, text: value.slice(0, maximumText), truncated: value.length > maximumText });
  }
  return result;
}

function targets(value: unknown): Pick<ReportCheck, 'targets' | 'omittedTargets'> {
  const result: ReportTarget[] = [];
  let omittedTargets = 0;
  if (!Array.isArray(value)) return { targets: result, omittedTargets };
  for (const item of value) {
    const row = object(item);
    if (!row) continue;
    const name = text(row.theoremName), rawStatus = text(row.status);
    const sorryCount = nonnegativeInteger(row.sorryCount), admitCount = nonnegativeInteger(row.admitCount);
    const messages = diagnostics(row);
    if (!name && !rawStatus && sorryCount === undefined && admitCount === undefined && !messages.length) continue;
    if (result.length === maximumTargets) { omittedTargets++; continue; }
    result.push({ name: name ?? t('未命名目标'), ...status(rawStatus, targetStatuses),
      ...(sorryCount !== undefined ? { sorryCount } : {}),
      ...(admitCount !== undefined ? { admitCount } : {}), diagnostics: messages });
  }
  return { targets: result, omittedTargets };
}

export function summarizeReport(run: WebRun): ReportSummary {
  const record = object(run), result = object(record?.result), report = object(result?.report);
  const candidate = object(report?.candidateCheck), evaluator = object(report?.evaluator);
  const finalCheck = object(evaluator?.verification), finalBatch = object(finalCheck?.verification);
  const candidateTargets = targets(candidate?.results), evaluationTargets = targets(finalBatch?.results);
  const candidatePassed = typeof candidate?.passed === 'boolean' ? candidate.passed
    : typeof report?.solver_ready_receipt_valid === 'boolean' ? report.solver_ready_receipt_valid : undefined;
  const candidateStatus = text(candidate?.status), evaluationStatus = text(evaluator?.status);
  const method = text(evaluator?.method), evaluationReason = text(evaluator?.reason);
  const evaluationTimedOut = evaluator?.timedOut === true;
  const checks: ReportCheck[] = [];
  if (candidatePassed !== undefined || candidateStatus || candidateTargets.targets.length) {
    checks.push({ id: 'candidate', label: t('候选检查'),
      ...(candidatePassed === undefined ? status(candidateStatus, targetStatuses)
        : { status: candidatePassed ? t('候选检查通过') : t('候选检查未通过'), tone: candidatePassed ? 'passed' : 'failed' }),
      ...candidateTargets });
  }
  if (evaluationStatus || method || evaluationReason || evaluationTimedOut || evaluationTargets.targets.length) {
    const evaluationState: Status = evaluationTimedOut ? { status: t('验收超时'), tone: 'failed' }
      : status(evaluationStatus, evaluationStatuses);
    checks.push({ id: 'evaluation', label: t('独立验收'), ...evaluationState,
      ...(method ? { method: evaluationMethods.get(method) ?? method } : {}),
      ...(evaluationReason ? { reason: evaluationReason } : {}), ...evaluationTargets });
  }
  const metrics: ReportSummary['metrics'] = [];
  const turns = nonnegativeInteger(report?.turns), solveWallMs = nonnegative(report?.solveWallMs);
  const totalTokens = nonnegativeInteger(object(report?.usage)?.totalTokens);
  if (turns !== undefined) metrics.push({ label: t('研究轮次'), value: String(turns) });
  if (solveWallMs !== undefined) metrics.push({ label: t('求解耗时'), value: t('{0} 秒', solveWallMs / 1_000) });
  if (totalTokens !== undefined) metrics.push({ label: t('总 Token'), value: String(totalTokens) });
  const environment = object(report?.environment);
  const identity: ReportSummary['identity'] = [];
  for (const [label, value] of [
    [t('求解运行 ID'), report?.runId], [t('题目 ID'), report?.problemId], [t('候选提交'), report?.solution_commit],
    [t('验收提交'), finalCheck?.commit], [t('验收源码摘要'), finalCheck?.sourceDigest],
    [t('Lean 工具链'), environment?.toolchain], [t('依赖摘要'), environment?.dependencyDigest],
    [t('Mathlib 版本'), environment?.mathlibRevision],
  ]) {
    const content = text(value);
    if (content) identity.push({ label: String(label), value: content });
  }
  const reason = text(report?.reason) ?? text(record?.error);
  return { ...(reason ? { reason } : {}), checks, metrics, identity };
}

export type StuckTask = {
  id: string; kind: string; status: string; tone: ReportTone; theorem?: string; type?: string; attempts: number;
  failure?: string; feedback?: string; blockers: string[]; goal: boolean;
};
export type StuckSummary = { tasks: StuckTask[]; omitted: number; openGoals: number; checked: number; conditional: number; open: number };

const maximumStuck = 8;
const taskStatuses = new Map<string, Status>([
  ['pending', { status: t('待调度'), tone: 'muted' }], ['running', { status: t('进行中'), tone: 'warning' }],
  ['blocked', { status: t('受阻'), tone: 'failed' }], ['conditional', { status: t('有条件结果'), tone: 'warning' }],
  ['delivered', { status: t('已交付'), tone: 'warning' }], ['paused', { status: t('暂停'), tone: 'muted' }],
  ['stopped', { status: t('停止'), tone: 'muted' }],
]);
const failureCategories = new Map([['proof', t('最近一次证明未通过 Lean 检查')], ['environment', t('最近一次检查因环境原因未能完成')]]);

/** Where an unaccepted run stopped: the open goals' frontier first, then any other open proof task. */
export function summarizeStuck(run: WebRun): StuckSummary | undefined {
  const inspection = run.observation?.inspection;
  if (!inspection || isAcceptedRun(run) || !['completed', 'cancelled', 'error'].includes(run.status)) return;
  const byId = new Map(inspection.tasks.map(task => [task.id, task]));
  const order: string[] = [], goals = new Set<string>();
  const add = (id: string) => { if (byId.has(id) && !order.includes(id)) order.push(id); };
  for (const goal of inspection.mathematics?.snapshot.goals ?? []) {
    if (goal.closed) continue;
    goals.add(goal.taskId);
    for (const item of goal.frontier) add(item.taskId);
    if (!goal.frontier.length) add(goal.taskId);
  }
  for (const id of inspection.progress.openProofTasks) if (byId.get(id)?.kind !== 'goal') add(id);
  if (!order.length) return;
  const blockers = new Map<string, string[]>();
  for (const blocker of inspection.mathematics?.snapshot.blockers ?? [])
    if (['open', 'reopened'].includes(blocker.status) && blocker.mechanism)
      blockers.set(blocker.taskId, [...new Set([...blockers.get(blocker.taskId) ?? [], blocker.mechanism.slice(0, 400)])]);
  const tasks = order.slice(0, maximumStuck).map(id => {
    const task = byId.get(id)!, state = task.control === 'active' ? task.status : task.control;
    const feedback = text(task.feedback)?.slice(0, 600);
    return { id, kind: task.kind, ...status(state, taskStatuses), attempts: task.attempts, goal: goals.has(id) || task.kind === 'goal',
      ...(task.theorem ? { theorem: task.theorem } : {}), ...(task.type ? { type: task.type.slice(0, maximumText) } : {}),
      ...(task.proof.failureCategory ? { failure: failureCategories.get(task.proof.failureCategory) ?? task.proof.failureCategory } : {}),
      ...(feedback ? { feedback } : {}), blockers: (blockers.get(id) ?? []).slice(0, 3) };
  });
  return { tasks, omitted: order.length - tasks.length, openGoals: goals.size, checked: inspection.progress.checkedProofTasks,
    conditional: inspection.progress.conditionalProofTasks, open: inspection.progress.openProofTasks.length };
}
