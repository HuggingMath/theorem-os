import { webLimits, webPreparationSeconds, type WebEffort, type WebFailureKind, type WebRun } from './shared';
import { locale, localeTag, localizeMessage, localizeText, t } from './i18n';

export const isAcceptedRun = (run: WebRun) => run.status === 'completed' && run.result?.status === 'evaluated_passed';
/** Acceptance proves the frozen Lean statement; natural-language meaning has its own confirmation. */
export const acceptedTitle = (run: Pick<WebRun, 'formalization'>) => run.formalization ? t('Lean 陈述证明通过') : t('完整原题通过');
export const acceptedDescription = (run: Pick<WebRun, 'formalization'>) => run.formalization
  ? t('冻结的 Lean 陈述已通过独立验收；原文与陈述的对应关系见形式化审核。')
  : t('目标声明没有改动，没有 sorry 或额外公理，Lean 内核在隔离环境中确认通过。');
export function statementConfirmation(confirmation: 'automatic' | 'manual' | undefined, shared = false): string {
  if (confirmation === 'manual') return shared ? t('原题含义：分享者已确认 Lean 陈述。') : t('原题含义：你已确认 Lean 陈述。');
  return confirmation === 'automatic' ? t('原题含义：模型审核通过，未经人工确认。') : t('原题含义：未记录确认方式，请核对 Lean 陈述。');
}
export const isRejectedRun = (run: WebRun) => ['evaluated_failed', 'evaluated_rejected'].includes(run.result?.status ?? '');
/** A run that ended on an error or on a classified failure the user has to act on; running out of time or usage is an expected end. */
export const isFaultedRun = (run: WebRun) => run.status === 'error'
  || run.status === 'completed' && !isAcceptedRun(run) && Boolean(run.failure) && !['budget', 'time_limit'].includes(run.failure!.kind);
/** The proof environment was not ready within its own preparation time, so solving never began; older records name it only in the report. */
const preparationStopped = (run: WebRun) => (run.failure?.reason ?? run.result?.report.reason) === 'math_preparation_stopped';
export type StopCause = 'preparation' | 'time' | 'budget' | 'turns' | 'routes';
/** Which limit ended a run that reached no acceptance verdict, if the run recorded one. */
export function stopCause(run: WebRun): StopCause | undefined {
  const stop = typeof run.result?.report.stopReason === 'string' ? run.result.report.stopReason : undefined;
  if (run.result && preparationStopped(run)) return 'preparation';
  if (run.failure?.kind === 'time_limit' || stop === 'math_run_stopped' || !run.failure && run.result?.status === 'limit_reached') return 'time';
  if (run.failure?.kind === 'budget') return 'budget';
  if (stop === 'math_turn_limit_reached') return 'turns';
  if (stop === 'math_research_routes_exhausted') return 'routes';
}
const stopLabels: Record<StopCause, string> = { preparation: t('环境准备超时'), time: t('解题时间用完'), budget: t('用量到达上限'), turns: t('研究轮次用完'), routes: t('研究路线用尽') };
/** Why a run that reached no acceptance verdict stopped, said in a few words for its badges; the result page explains it. */
export function stoppedLabel(run: WebRun): string {
  const cause = stopCause(run);
  return cause ? stopLabels[cause] : t('运行结束');
}
const endedSummaries: Record<StopCause, string> = {
  preparation: t('研究已结束：证明环境没有在准备时限内就绪，解题没有开始。'),
  time: t('研究已结束：解题时间用完，没有得到通过验收的完整证明。'), budget: t('研究已结束：用量到达上限，没有得到通过验收的完整证明。'),
  turns: t('研究已结束：研究轮次用完，没有得到通过验收的完整证明。'), routes: t('研究已结束：研究路线用尽，没有得到通过验收的完整证明。'),
};
/** One line for an ended run under its route map: accepted, rejected at acceptance, or why it stopped before a verdict. */
export function endedSummary(run: WebRun): string {
  if (isAcceptedRun(run)) return run.formalization ? t('研究已结束，Lean 陈述已通过验收。') : t('研究已结束，原题已通过验收。');
  if (isRejectedRun(run)) return t('研究已结束，候选证明没有通过验收。');
  if (run.status === 'cancelled') return t('研究已取消，没有得到通过验收的完整证明。');
  if (run.status === 'error') return t('运行出错后中止，没有得到通过验收的完整证明。');
  const cause = stopCause(run);
  return cause ? endedSummaries[cause] : t('研究已结束，没有得到通过验收的完整证明。');
}
export const effortLabels: Record<WebEffort, string> = { low: t('低'), medium: t('中'), high: t('高'), xhigh: t('很高'), max: t('最高') };
/** A full local date and time, e.g. 2026年10月26日 14:05. Unparseable input is shown as is. */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(localeTag, { year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false }).format(date) : value;
}

export const runStages = [
  { id: 'queued', label: t('排队'), events: ['queued'] },
  { id: 'preparing', label: t('准备环境'), events: ['preparing', 'dependency_check', 'proof_environment', 'library_index', 'ready', 'preparation_finished', 'preparation_failed'] },
  { id: 'solving', label: t('构造证明'), events: ['solve_started', 'turn_started', 'worker_activity', 'turn_checkpoint', 'turn_failed', 'turn_retry', 'proof_check_started', 'proof_checked', 'candidate_selected', 'lemma_checked', 'assembly_started', 'source_rejected', 'worker_failed'] },
  { id: 'evaluating', label: t('独立验收'), events: ['evaluation_started', 'evaluation_finished'] },
] as const;

type StepState = 'done' | 'active' | 'stopped' | 'error' | 'pending' | 'skipped';
const milliseconds = (from: string | undefined, to: number) => {
  const start = Date.parse(from ?? '');
  return Number.isFinite(start) && Number.isFinite(to) ? Math.max(0, to - start) : null;
};

export function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--:--';
  const seconds = Math.floor(Math.max(0, value) / 1000);
  const parts = [Math.floor(seconds / 60) % 60, seconds % 60];
  if (seconds >= 3600) parts.unshift(Math.floor(seconds / 3600));
  return parts.map(part => String(part).padStart(2, '0')).join(':');
}
/** A finished duration as a reader says it: 26 秒, 6 分 18 秒, 1 小时 5 分. */
export function readableDuration(value: number): string {
  const seconds = Math.floor(Math.max(0, value) / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  if (seconds < 60) return t('{0} 秒', seconds);
  if (minutes < 60) return seconds % 60 ? t('{0} 分 {1} 秒', minutes, seconds % 60) : t('{0} 分钟', minutes);
  return minutes % 60 ? t('{0} 小时 {1} 分', hours, minutes % 60) : t('{0} 小时', hours);
}
/**
 * A report metric in the reader's units: the solve time stored as raw seconds, the token total as 万/亿 (K/M).
 * Snapshots keep the labels and values in Chinese, so the label is localized before it is recognized.
 */
export function readableMetric(item: { label: string; value: string }) {
  const label = localizeText(item.label), number = Number.parseFloat(item.value);
  if (!Number.isFinite(number)) return { label, value: item.value };
  if (label === t('求解耗时')) return { label, value: readableDuration(number * 1000) };
  if (label === t('总 Token')) return { label, value: formatTokens(number) };
  return { label, value: item.value };
}

export function runProgress(run: WebRun, now = Date.now()) {
  const terminal = run.status !== 'queued' && run.status !== 'running';
  const end = terminal ? Date.parse(run.finishedAt ?? run.updatedAt) : now;
  const starts = runStages.map(stage => stage.id === 'queued' ? run.createdAt
    : run.timings?.[stage.id] ?? run.events.find(event => (stage.events as readonly string[]).includes(event.type))?.at);
  let index = run.status === 'queued' ? 0 : run.status === 'running' ? 1 : 0;
  if (run.status !== 'queued') {
    for (let position = 1; position < runStages.length; position++) {
      if (starts[position] || (runStages[position].events as readonly string[]).includes(run.phase)) index = position;
    }
    if (run.result?.status.startsWith('evaluated_')) index = 3;
  }
  const accepted = isAcceptedRun(run);
  const failed = run.status === 'error' || isRejectedRun(run);
  const steps = runStages.map((stage, position) => {
    const next = starts.slice(position + 1).find(Boolean);
    const state: StepState = position < index ? 'done' : position > index ? terminal ? 'skipped' : 'pending'
      : terminal ? accepted ? 'done' : failed ? 'error' : 'stopped' : 'active';
    const elapsed = position > index ? null : milliseconds(starts[position], next ? Date.parse(next) : end);
    return { ...stage, state, elapsed };
  });
  const phaseLabel = run.status === 'queued' ? t('等待运行')
    : run.status === 'cancelled' ? t('已取消')
      : run.status === 'error' ? t('运行错误')
        : terminal ? accepted ? t('验收通过') : failed ? t('验收未通过') : t('研究已结束')
          : run.phase === 'proof_check_started' ? t('检查候选证明')
            : index === 2 && run.observation?.inspection.planApproval?.status === 'pending'
              ? run.observation.inspection.planApproval.leadRevising ? t('Lead 正在改计划') : t('等你批准计划') : runStages[index].label;
  return { index, steps, phaseLabel, terminal, elapsed: milliseconds(run.createdAt, end), solvingElapsed: steps[2].elapsed };
}

/** The plan of a run started with 先审计划 that waits for its owner; nothing runs until they approve it. */
export function planAwaitingApproval(run: WebRun) {
  const approval = run.observation?.inspection.planApproval;
  return run.status === 'running' && approval?.status === 'pending' ? approval : undefined;
}
/** Whether dispatch still waits on the owner: the plan is being drafted, revised or read, and no Agent proves anything yet. */
export function planGated(run: WebRun) {
  const approval = run.observation?.inspection.planApproval;
  return run.status === 'running' && Boolean(approval?.required) && approval?.status !== 'approved';
}
/** How long a run counts as stuck: this many minutes of solving without a passing check or an integrated result. */
export const stallMinutes = 10;
/**
 * Whole minutes the solving stage has gone without progress (see isProgressEvent), once that reaches stallMinutes.
 * Waiting for the owner to approve the plan is not a stall, and the count restarts when they approve it.
 */
export function stalledMinutes(run: WebRun, now = Date.now()): number | undefined {
  if (run.status !== 'running' || runProgress(run, now).index !== 2 || planGated(run)) return;
  const approval = run.observation?.inspection.planApproval;
  const since = Math.max(...[run.timings?.solving, run.progressAt].map(value => Date.parse(value ?? '')).filter(Number.isFinite),
    approval?.approvedAt ?? -Infinity);
  if (!Number.isFinite(since)) return;
  const minutes = Math.floor((now - since) / 60_000);
  return minutes >= stallMinutes ? minutes : undefined;
}

/** Recovery opens a copy of the run's settings at the field to change (the task in the composer); the API key is always re-entered. */
export type RecoveryAction = { id: 'retry' | 'key' | 'budget' | 'tokens' | 'turns' | 'workers' | 'source' | 'task' | 'report'; label: string };
export type FailureGuide = { title: string; detail: string; actions: RecoveryAction[]; kind?: WebFailureKind };
const retry: RecoveryAction = { id: 'retry', label: t('重新运行') };
const report: RecoveryAction = { id: 'report', label: t('查看报告') };
const guides: Record<WebFailureKind, FailureGuide> = {
  authentication: { title: t('API Key 未通过认证'), detail: t('服务商拒绝了这个 API Key。请确认密钥属于所选服务商、没有过期且有模型权限，然后换一个密钥重新运行。'),
    actions: [{ id: 'key', label: t('更换 API Key') }] },
  rate_limit: { title: t('服务商限制了请求'), detail: t('账户额度不足，或同时发出的请求超过了服务商的并发上限。请检查余额和并发配额，减少 Agent 数量，或稍后再试。'),
    actions: [{ id: 'workers', label: t('减少 Agent 数量') }, retry] },
  network: { title: t('模型服务连接失败'), detail: t('多次重试后仍无法连上模型服务，或请求超时。已检查的成果保存在报告中。请确认服务商状态后重新运行。'),
    actions: [retry, report] },
  budget: { title: t('已达到模型用量上限'), detail: t('本次运行的模型用量已到上限，后续调用已停止。已检查的成果保存在报告中。'),
    actions: [{ id: 'tokens', label: t('调整用量上限') }, report] },
  time_limit: { title: t('已达到解题时间预算'), detail: t('运行在解题预算内没有完成，已检查的成果保存在报告中。可以提高解题预算后重新运行。'),
    actions: [{ id: 'budget', label: t('提高解题预算') }, report] },
  environment: { title: t('运行环境出错'), detail: t('隔离运行环境没有正常完成，与题目和 API Key 无关。请重新运行；如果再次出现，请点「反馈问题」告诉我们，并附上运行档案。'),
    actions: [retry, report] },
  source: { title: t('Lean 原题无法载入'), detail: t('原题没有通过载入检查。请确认源码能在所选证明环境中编译，且每个目标定理都保留了原始声明。'),
    actions: [{ id: 'source', label: t('修改原题') }] },
  protocol: { title: t('Agent 返回了无效结果'), detail: t('模型多次返回了格式无效的结果。可以换一个模型或提高推理强度后重新运行。'),
    actions: [retry, report] },
  interrupted: { title: t('服务重启，运行已中断'), detail: t('服务在运行期间重启，本次运行没有恢复执行。已有的观测与证据已保留，可以重新运行。'),
    actions: [retry, report] },
  unknown: { title: t('运行没有完成'), detail: t('运行在得到验收结果前停止了。报告中保留了已有记录，可以重新运行。'),
    actions: [retry, report] },
};
const reasonDetails: Record<string, string> = {
  math_model_usage_unavailable: t('服务商没有返回完整的用量回执，为避免超出用量上限，后续调用已停止。已检查的成果保存在报告中。'),
};
/** The solve budget ran out: say how long it was, and offer a longer one only while the run is below the highest allowed. */
function timeGuide(run: WebRun): FailureGuide {
  const seconds = run.maxRunSeconds;
  if (!(seconds > 0)) return { ...guides.time_limit, kind: 'time_limit' };
  if (seconds < webLimits.maxRunSeconds) return { ...guides.time_limit, kind: 'time_limit',
    detail: t('{0}的解题预算用完时，还没有得到通过验收的完整证明。已检查的成果保存在报告中，可以提高解题预算后重新运行。', readableDuration(seconds * 1000)) };
  return { ...guides.time_limit, kind: 'time_limit', actions: [{ id: 'task', label: t('补充研究任务') }, report],
    detail: t('{0}的解题预算（已是上限）用完时，还没有得到通过验收的完整证明。已检查的成果保存在报告中。可以在研究任务里补充证明思路，或换一个模型后重新运行。', readableDuration(seconds * 1000)) };
}
/**
 * The environment had its own fixed preparation time, apart from the solve budget, and solving never began. The
 * guide is filed under `environment` so the result page offers feedback; the run itself still counts as an expected stop.
 */
function preparationGuide(run: WebRun): FailureGuide {
  const minutes = readableDuration((webPreparationSeconds[run.environment] ?? webPreparationSeconds.mathlib) * 1000);
  return { kind: 'environment', title: t('证明环境准备超时'), actions: [retry, report],
    detail: t('准备证明环境超过了 {0}的准备时限，解题没有开始。准备时限是固定的，和解题预算无关，提高解题预算不会改变它。Mathlib 环境第一次准备较慢，可以直接重新运行；反复出现时请点「反馈问题」。', minutes) };
}

/** What went wrong and how to recover, for runs that ended without an accepted proof or a rejected candidate. */
export function failureGuide(run: WebRun): FailureGuide | undefined {
  if (run.status === 'queued' || run.status === 'running' || run.status === 'cancelled' || isAcceptedRun(run)) return;
  const kind = run.failure?.kind ?? (run.phase === 'interrupted' ? 'interrupted' : run.status === 'error' ? 'unknown'
    : run.result?.status === 'limit_reached' ? 'time_limit' : undefined);
  if (kind) {
    if (kind === 'time_limit' && preparationStopped(run)) return preparationGuide(run);
    const guide = kind === 'time_limit' ? timeGuide(run) : guides[kind], detail = run.failure?.reason && reasonDetails[run.failure.reason];
    // A stop before approval can include planning/revision work, or a historical run whose wait used its old budget.
    const unapproved = kind === 'time_limit' && run.observation?.inspection.planApproval?.status === 'pending'
      && t('这次运行在计划批准前结束，已保存的计划与研究材料仍可查看。');
    const text = unapproved || detail;
    return { ...guide, kind, ...(text ? { detail: text } : {}) };
  }
  if (run.result?.status === 'incomplete') {
    const stop = run.result.report.stopReason;
    if (stop === 'math_turn_limit_reached') return { title: t('研究轮次已用完'), detail: t('Agent 用完了全部研究轮次，还没有得到完整证明。已检查的成果保存在报告中。可以提高轮次上限、增加 Agent，或在任务说明里补充思路。'),
      actions: [run.maxTurns < webLimits.maxTurns ? { id: 'turns', label: t('提高轮次上限') } : { id: 'task', label: t('补充研究任务') }, report] };
    if (stop === 'math_research_routes_exhausted') return { title: t('没有可以继续的研究路线'), detail: t('轮次还有剩余，但计划中的研究路线都已停滞或用尽。已检查的成果保存在报告中。可以在任务说明里补充思路，或换一个模型后重新运行。'),
      actions: [retry, report] };
    if (stop === 'math_run_stopped') return timeGuide(run);
    return { title: t('没有得到完整证明'), detail: t('Agent 用完了轮次，或没有可以继续的研究路线。已检查的成果保存在报告中。可以提高轮次上限、增加 Agent，或在任务说明里补充思路。'),
      actions: [{ id: 'turns', label: t('提高轮次上限') }, report] };
  }
}

const reportedTokens = (usage: unknown) => {
  const value = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
  const count = (key: string) => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0 ? value[key] as number : undefined;
  const total = count('totalTokens'), input = count('inputTokens'), output = count('outputTokens');
  return total ?? (input !== undefined && output !== undefined ? input + output : undefined);
};
/** Lines a reader sees in read-only code: a final newline ends the last line instead of numbering an empty one after it. */
export function shownLines(source: string): string[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  return lines.length > 1 && lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}
/** Tokens in the reader's units; Chinese keeps one decimal below 100 万, so a task's 6.4 万 is not read as 6 万. */
export const formatTokens = (value: number) => locale === 'en'
  ? value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e4 ? `${Math.round(value / 1e3)}K` : String(value)
  : value >= 1e8 ? `${(value / 1e8).toFixed(1)} 亿` : value >= 1e6 ? `${Math.round(value / 1e4)} 万`
    : value >= 1e4 ? `${Number((value / 1e4).toFixed(1))} 万` : String(value);
/** Tokens the whole run used, every Agent's turns included: as its report states once it has one, else the latest observation. */
export const runTokens = (run: WebRun) => reportedTokens(run.result?.report?.usage) ?? reportedTokens(run.observation?.inspection.usage);

// Stop codes the verdict at the top of the result already explains in words.
const explainedStops = new Set(['math_run_stopped', 'math_preparation_stopped', 'math_total_token_limit', 'math_model_usage_unavailable', 'math_turn_limit_reached']);
const checkReasons: Record<string, string> = {
  proof_incomplete: t('没有通过 Lean 检查的完整候选证明，所以没有进行独立验收。'),
  math_evaluation_timeout: t('独立验收没有在时限内完成。'),
};
/**
 * The report's own reason, for its summary: a sentence a reader can use, or a code kept folded as a diagnostic.
 * Stop codes the verdict already explains are left out; free text from the run is shown as written.
 */
export function reportReason(reason: string | undefined): { text?: string; code?: string } {
  if (!reason || explainedStops.has(reason)) return {};
  if (checkReasons[reason]) return { text: checkReasons[reason] };
  return /^[a-z][a-z0-9_]*$/u.test(reason) ? { code: reason } : { text: reason };
}
/** Why an acceptance check has no result, in words: nothing complete was ready to check, or it ran out of time. */
export function checkReason(check: { skipped?: boolean; reason?: string }): string | undefined {
  if (check.reason) return checkReasons[check.reason] ?? check.reason;
  return check.skipped ? t('运行在独立验收之前停止，没有进行独立验收。') : undefined;
}

/** Expected ceiling from this account's own finished runs on the same model; turns are shared by all Agents. */
export function usageEstimate(runs: readonly WebRun[], model: string, maxTurns: number) {
  let tokens = 0, turns = 0, samples = 0;
  for (const run of runs) {
    const report = run.result?.report, used = reportedTokens(report?.usage), count = report?.turns;
    if (run.model !== model || used === undefined || typeof count !== 'number' || count < 1) continue;
    tokens += used; turns += count; samples++;
  }
  return samples ? { perTurn: Math.round(tokens / turns), ceiling: Math.round(tokens / turns * maxTurns), samples } : undefined;
}

export function queueDescription(run: WebRun): string {
  const queue = run.queue;
  if (!queue) return t('等待可用的运行环境。');
  const slots = t('{0}/{1} 个运行位正在使用', queue.running, queue.slots);
  return queue.ahead ? t('前面还有 {0} 个任务，{1}。轮到后自动开始，可以关闭页面。', queue.ahead, slots)
    : queue.running < queue.slots ? t('下一个开始运行。') : t('排在第 1 位，{0}，有任务结束后自动开始。可以关闭页面。', slots);
}

export function resultDescription(run: WebRun): string {
  const guide = failureGuide(run);
  if (guide) return guide.detail;
  if (run.error) return localizeMessage(run.error);
  if (run.status === 'cancelled') return t('任务已停止。');
  if (run.status === 'queued') return queueDescription(run);
  if (run.status === 'running') {
    const stage = runProgress(run).index;
    if (stage === 1) return t('{0}准备中，解题尚未开始；解题预算从构造证明开始计时。', run.environment === 'mathlib' ? t('Mathlib 依赖') : t('Lean 环境'));
    if (stage === 3) return t('正在独立验证完整原题。');
    const approval = planAwaitingApproval(run);
    if (approval) return approval.leadRevising ? t('Lead 正在按你的留言修改研究计划，改完后再请你批准。')
      : t('Lead 已经拟好研究计划，等你批准后 Agent 才开始工作。');
    if (run.observation?.inspection.planApproval?.status === 'awaiting-plan') return t('Lead 正在拟定研究计划，拟好后会请你批准。');
    return t('正在构造与检查候选证明。');
  }
  if (isAcceptedRun(run)) return run.formalization ? acceptedDescription(run) : t('完整原题通过独立 Lean 验收。');
  if (run.result?.status === 'evaluated_failed') return t('候选证明未通过独立 Lean 验收。');
  if (run.result?.status === 'evaluated_rejected') return t('候选未满足验收约束，详情见报告。');
  if (run.status === 'error') return t('运行环境或模型会话发生错误。');
  return t('本次研究尚未得到通过完整原题验收的证明。');
}
