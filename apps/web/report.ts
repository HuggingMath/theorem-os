import type { WebRun } from './shared';
import { t } from './i18n';
import { failureGuide, isAcceptedRun, planGated, type RecoveryAction } from './presentation';

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
  /** Acceptance did not run at all. */
  skipped?: boolean;
  targets: ReportTarget[];
  omittedTargets: number;
};
export type ReportSummary = {
  reason?: string;
  checks: ReportCheck[];
  metrics: { label: string; value: string }[];
  identity: { label: string; value: string }[];
  library?: {
    id: string; revision: string; catalogDigest: string; installedModules: number; installationRounds: number;
    coverage: 'available' | 'partial' | 'unknown'; referenceCount?: number;
    references: { name: string; file: string; sourceDigest: string }[]; omittedReferences: number;
  };
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

function librarySummary(run: WebRun, value: unknown): ReportSummary['library'] {
  const usage = object(value), library = object(usage?.library), proof = object(usage?.proof);
  const id = text(library?.id), revision = text(library?.revision), catalogDigest = text(library?.catalogDigest);
  const installedModules = nonnegativeInteger(usage?.installedModules), installationRounds = nonnegativeInteger(usage?.installationRounds);
  if (usage?.schema !== 'theorem-os.web-library-usage.v1' || !id || !revision || !catalogDigest ||
      !/^[a-f0-9]{64}$/u.test(catalogDigest) || installedModules === undefined || installationRounds === undefined) return;
  const covered = nonnegativeInteger(proof?.coveredTargets), targets = nonnegativeInteger(proof?.targetCount);
  const referenceCount = nonnegativeInteger(proof?.referenceCount);
  const coverage = isAcceptedRun(run) && proof?.scope === 'independently-accepted-original-proofs' &&
    covered !== undefined && targets !== undefined && covered > 0 && covered <= targets
    ? proof.coverage === 'available' && covered === targets && referenceCount !== undefined ? 'available' as const :
      proof.coverage === 'partial' && covered < targets ? 'partial' as const : 'unknown' as const : 'unknown' as const;
  const references = coverage !== 'unknown' && Array.isArray(proof?.references) ? proof.references.slice(0, 64).flatMap(value => {
    const entry = object(value), name = text(entry?.name), file = text(entry?.file), sourceDigest = text(entry?.sourceDigest);
    return name && file && sourceDigest && /^[a-f0-9]{64}$/u.test(sourceDigest) ? [{ name, file, sourceDigest }] : [];
  }) : [];
  return { id, revision, catalogDigest, installedModules, installationRounds, coverage,
    ...(coverage === 'available' ? { referenceCount } : {}), references,
    omittedReferences: coverage === 'available' ? Math.max(0, referenceCount! - references.length) :
      coverage === 'partial' ? nonnegativeInteger(proof?.omittedReferences) ?? 0 : 0 };
}

function status(value: string | undefined, labels: ReadonlyMap<string, Status>): Status {
  return value ? labels.get(value) ?? { status: value, tone: 'muted' }
    : { status: t('未提供状态'), tone: 'muted' };
}

// Delimiters the Lean checker prints around its own #check, #print axioms and reference queries.
const checkMarker = /^(?:DEEPSCIENTIST_(?:DECL|AXIOMS)_(?:BEGIN|END)_[0-9a-f]{16}|DS_(?:DECL_REFERENCES|PROOF_DEPENDENCIES)_[0-9a-f]{32}:.*)$/u;
/** Lean output as a reader sees it: the checker's own delimiter lines removed, declarations and axioms kept. */
export function withoutCheckMarkers(output: string): string {
  return output.split('\n').filter(line => !checkMarker.test(line.trim())).join('\n').trim();
}

/** The error and Lean output of one check row, checker delimiters removed and each text capped. */
export function diagnostics(row: Record<string, unknown>): ReportDiagnostic[] {
  const result: ReportDiagnostic[] = [];
  const seen = new Set<string>();
  for (const [key, label] of [['error', t('错误')], ['stdoutPreview', t('标准输出')], ['stderrPreview', t('标准错误')]]) {
    const raw = row[key];
    const value = typeof raw !== 'string' ? '' : key === 'error' ? raw.trim() : withoutCheckMarkers(raw);
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
    checks.push({ id: 'evaluation', label: t('独立验收'), ...evaluationState, ...(evaluationStatus === 'skipped' ? { skipped: true } : {}),
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
  const library = librarySummary(run, report?.libraryUsage);
  return { ...(reason ? { reason } : {}), checks, metrics, identity, ...(library ? { library } : {}) };
}

/** Lean's three classical axioms; anything else in a target's closure deserves a reader's attention. */
export const standardAxioms: ReadonlySet<string> = new Set(['propext', 'Classical.choice', 'Quot.sound']);
export type GoalState = 'proved' | 'checked' | 'conditional' | 'working' | 'planned' | 'open';
export type GoalSubgoal = { id: string; name: string; state: GoalState };
export type GoalRow = {
  name: string; state: GoalState; status: string; tone: ReportTone | 'running'; taskId?: string;
  /** Unproved subgoals this goal still rests on, by theorem name. */ waiting: string[];
  /** The Lean axioms the accepted check recorded for this target; absent until a check records them. */
  axioms?: string[]; nonstandardAxioms?: string[];
  subgoals: GoalSubgoal[]; omittedSubgoals: number;
};
export type GoalChecklist = { goals: GoalRow[]; omitted: number; proved: number; checked: number; conditional: number; open: number };

const maximumGoals = 64, maximumSubgoals = 32;
export const goalStates: Record<GoalState, Pick<GoalRow, 'status' | 'tone'>> = {
  proved: { status: t('已证明'), tone: 'passed' }, checked: { status: t('Lean 已检查'), tone: 'passed' }, conditional: { status: t('有条件'), tone: 'warning' },
  working: { status: t('证明中'), tone: 'running' }, planned: { status: t('等计划批准'), tone: 'muted' },
  open: { status: t('未解决'), tone: 'failed' },
};
const stringList = (value: unknown) => Array.isArray(value)
  ? value.flatMap(item => typeof item === 'string' ? [item] : typeof object(item)?.name === 'string' ? [object(item)!.name as string] : []) : [];

/**
 * One row per original target: proved, conditional on named open subgoals, or unsolved, with the axioms its final
 * check recorded. The independent acceptance decides first; the solver's recorded goal frontier explains the rest.
 */
export function summarizeGoals(run: WebRun): GoalChecklist | undefined {
  const inspection = run.observation?.inspection;
  const report = object(object(run.result)?.report), evaluator = object(report?.evaluator);
  const rows = (value: unknown) => Array.isArray(value) ? value.map(object).filter(row => text(row?.theoremName)) as Record<string, unknown>[] : [];
  const evaluated = new Map(rows(object(object(evaluator?.verification)?.verification)?.results).map(row => [row.theoremName as string, row]));
  const tasks = inspection?.tasks ?? [], byId = new Map(tasks.map(task => [task.id, task]));
  const goalTasks = tasks.filter(task => task.kind === 'goal');
  const frontiers = new Map((inspection?.mathematics?.snapshot.goals ?? []).map(goal => [goal.taskId, goal]));
  const names = [...new Set([...(inspection?.problem.targets ?? []).map(target => target.theoremName), ...evaluated.keys(),
    ...goalTasks.flatMap(task => task.theorem ? [task.theorem] : [])])];
  if (!names.length) return;
  // Until the owner approves the plan no Agent works on any goal, so an open goal waits rather than being proved.
  const accepted = isAcceptedRun(run), active = run.status === 'queued' || run.status === 'running';
  const underway: GoalState = planGated(run) ? 'planned' : 'working';
  const name = (id: string) => byId.get(id)?.theorem ?? id;
  const proved = (id: string) => byId.get(id)?.proof.status === 'checked';
  const taskState = (task: typeof tasks[number]): GoalState => task.proof.status === 'checked' ? 'proved'
    : task.proof.status === 'conditional' ? 'conditional' : active && task.control === 'active' && task.status !== 'blocked' ? underway : 'open';
  const goals = names.slice(0, maximumGoals).map((theorem): GoalRow => {
    const task = goalTasks.find(item => item.theorem === theorem), frontier = task && frontiers.get(task.id), row = evaluated.get(theorem);
    const conditional = task?.proof.status === 'conditional';
    // Proved means the independent acceptance says so; a goal the solver's own Lean check closed is only checked.
    const state: GoalState = accepted || row?.status === 'kernel_verified' ? 'proved' : !row && frontier?.closed ? 'checked'
      : conditional ? 'conditional' : active && !row ? underway : 'open';
    const waiting = state === 'proved' || state === 'checked' || !task ? [] : [...new Set([...(task.proof.conditions ?? []).map(item => item.taskId),
      ...(frontier?.frontier ?? []).map(item => item.taskId), ...(frontier?.missingDependencies ?? [])])]
      .filter(id => id !== task.id && !proved(id)).map(name);
    // Axioms describe an accepted proof: a failed check's list says nothing about the target.
    const axioms = state === 'proved' && row && Array.isArray(row.axioms) ? stringList(row.axioms) : undefined;
    // Planned lemmas below this goal, in plan order; stopped routes are no longer part of its proof.
    const below = new Set<string>(), visit = (id: string) => {
      for (const next of byId.get(id)?.plannedDependencies ?? []) if (!below.has(next)) { below.add(next); visit(next); }
    };
    if (task) visit(task.id);
    const subgoals = tasks.filter(item => below.has(item.id) && item.kind === 'lemma' && item.control !== 'stopped')
      .map(item => ({ id: item.id, name: name(item.id), state: taskState(item) }));
    return { name: theorem, state, ...goalStates[state], ...(task ? { taskId: task.id } : {}), waiting,
      ...(axioms ? { axioms, nonstandardAxioms: axioms.filter(item => !standardAxioms.has(item)) } : {}),
      subgoals: subgoals.slice(0, maximumSubgoals), omittedSubgoals: Math.max(0, subgoals.length - maximumSubgoals) };
  });
  const count = (state: GoalState) => goals.filter(goal => goal.state === state).length;
  return { goals, omitted: names.length - goals.length, proved: count('proved'), checked: count('checked'), conditional: count('conditional'),
    open: count('open') + count('working') + count('planned') };
}

export type GoalGroup = { id: 'underway' | 'open' | 'checked' | 'proved'; label: string; goals: GoalRow[]; folded: boolean };
const goalGroupOf: Record<GoalState, GoalGroup['id']> = { working: 'underway', planned: 'underway', open: 'open', conditional: 'open', checked: 'checked', proved: 'proved' };
/**
 * A long goal list read by status: what is still being proved, what is unsolved (conditional ones too), then what is
 * done. Finished groups start folded while anything is unfinished; problem order is kept inside each group.
 * Short lists, or lists in a single state, stay flat.
 */
export function groupGoals(goals: readonly GoalRow[]): GoalGroup[] | undefined {
  const ids = new Set(goals.map(goal => goalGroupOf[goal.state]));
  if (goals.length < 4 || ids.size < 2) return;
  const unfinished = ids.has('underway') || ids.has('open');
  const underwayLabel = goals.some(goal => goal.state === 'working') ? t('证明中') : t('等计划批准');
  const labels: Record<GoalGroup['id'], string> = { underway: underwayLabel, open: t('未解决'), checked: t('Lean 已检查'), proved: t('已证明') };
  return (['underway', 'open', 'checked', 'proved'] as const).filter(id => ids.has(id)).map(id => ({ id, label: labels[id],
    goals: goals.filter(goal => goalGroupOf[goal.state] === id), folded: unfinished && (id === 'checked' || id === 'proved') }));
}

/**
 * What to do after a run ended without an accepted proof, at most three buttons and none of them a model call: start
 * again from the code its own Lean check passed, read why the latest failed check failed, and the failure's own
 * recovery (or a plain rerun when there is none). `tasks` names the goals or tasks each step acts on.
 */
export type NextStep = { id: 'continue-checked' | 'ask-failed'; label: string; tasks: string[] } | (RecoveryAction & { tasks?: undefined });
export function nextSteps(run: WebRun, goals?: GoalChecklist): NextStep[] {
  if (run.status === 'queued' || run.status === 'running' || isAcceptedRun(run)) return [];
  const checked = (goals?.goals ?? []).filter(goal => goal.state === 'checked' && goal.taskId).map(goal => goal.taskId!);
  const tasks = run.observation?.inspection.tasks ?? [];
  const failed = tasks.filter(task => task.proof.status === 'failed' && task.control !== 'stopped')
    .sort((a, b) => Number(b.kind === 'goal') - Number(a.kind === 'goal')).map(task => task.id);
  const recovery = failureGuide(run)?.actions.filter(action => action.id !== 'report') ?? [{ id: 'retry', label: t('复用配置重新研究') } as RecoveryAction];
  return [...checked.length ? [{ id: 'continue-checked' as const, label: t('从已检查的代码继续'), tasks: checked }] : [],
    ...failed.length ? [{ id: 'ask-failed' as const, label: t('问为什么没通过'), tasks: failed }] : [], ...recovery].slice(0, 3);
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
