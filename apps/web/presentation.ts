import type { WebEffort, WebFailureKind, WebRun } from './shared';

export const isAcceptedRun = (run: WebRun) => run.status === 'completed' && run.result?.status === 'evaluated_passed';
export const effortLabels: Record<WebEffort, string> = { low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };
/** A full local date and time, e.g. 2026年10月26日 14:05. Unparseable input is shown as is. */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false }).format(date) : value;
}

export const runStages = [
  { id: 'queued', label: '排队', events: ['queued'] },
  { id: 'preparing', label: '准备环境', events: ['preparing', 'dependency_check', 'proof_environment', 'library_index', 'ready', 'preparation_finished', 'preparation_failed'] },
  { id: 'solving', label: '构造证明', events: ['solve_started', 'turn_started', 'worker_activity', 'turn_checkpoint', 'turn_failed', 'turn_retry', 'proof_check_started', 'proof_checked', 'candidate_selected', 'lemma_checked', 'assembly_started', 'source_rejected', 'worker_failed'] },
  { id: 'evaluating', label: '独立验收', events: ['evaluation_started', 'evaluation_finished'] },
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
  const failed = run.status === 'error' || ['evaluated_failed', 'evaluated_rejected'].includes(run.result?.status ?? '');
  const steps = runStages.map((stage, position) => {
    const next = starts.slice(position + 1).find(Boolean);
    const state: StepState = position < index ? 'done' : position > index ? terminal ? 'skipped' : 'pending'
      : terminal ? accepted ? 'done' : failed ? 'error' : 'stopped' : 'active';
    const elapsed = position > index ? null : milliseconds(starts[position], next ? Date.parse(next) : end);
    return { ...stage, state, elapsed };
  });
  const phaseLabel = run.status === 'queued' ? '等待运行'
    : run.status === 'cancelled' ? '已取消'
      : run.status === 'error' ? '运行错误'
        : terminal ? accepted ? '验收通过' : failed ? '验收未通过' : '研究已结束'
          : run.phase === 'proof_check_started' ? '检查候选证明' : runStages[index].label;
  return { index, steps, phaseLabel, terminal, elapsed: milliseconds(run.createdAt, end), solvingElapsed: steps[2].elapsed };
}

/** Recovery opens a copy of the run's settings at the field to change; the API key is always re-entered. */
export type RecoveryAction = { id: 'retry' | 'key' | 'budget' | 'tokens' | 'turns' | 'workers' | 'source' | 'report'; label: string };
export type FailureGuide = { title: string; detail: string; actions: RecoveryAction[] };
const retry: RecoveryAction = { id: 'retry', label: '重新运行' };
const report: RecoveryAction = { id: 'report', label: '查看报告' };
const guides: Record<WebFailureKind, FailureGuide> = {
  authentication: { title: 'API Key 未通过认证', detail: '服务商拒绝了这个 API Key。请确认密钥属于所选服务商、没有过期且有模型权限，然后换一个密钥重新运行。',
    actions: [{ id: 'key', label: '更换 API Key' }] },
  rate_limit: { title: '服务商限制了请求', detail: '账户额度不足，或同时发出的请求超过了服务商的并发上限。请检查余额和并发配额，减少 Agent 数量，或稍后再试。',
    actions: [{ id: 'workers', label: '减少 Agent 数量' }, retry] },
  network: { title: '模型服务连接失败', detail: '多次重试后仍无法连上模型服务，或请求超时。已检查的成果保存在报告中。请确认服务商状态后重新运行。',
    actions: [retry, report] },
  budget: { title: '已达到模型用量上限', detail: '本次运行的模型用量已到上限，后续调用已停止。已检查的成果保存在报告中。',
    actions: [{ id: 'tokens', label: '调整用量上限' }, report] },
  time_limit: { title: '已达到解题时间预算', detail: '运行在解题预算内没有完成，已检查的成果保存在报告中。可以提高解题预算后重新运行。',
    actions: [{ id: 'budget', label: '提高解题预算' }, report] },
  environment: { title: '运行环境出错', detail: '隔离运行环境没有正常完成，与题目和 API Key 无关。请重新运行；如果再次出现，请联系我们并附上运行档案。',
    actions: [retry, report] },
  source: { title: 'Lean 原题无法载入', detail: '原题没有通过载入检查。请确认源码能在所选证明环境中编译，且每个目标定理都保留了原始声明。',
    actions: [{ id: 'source', label: '修改原题' }] },
  protocol: { title: 'Agent 返回了无效结果', detail: '模型多次返回了格式无效的结果。可以换一个模型或提高推理强度后重新运行。',
    actions: [retry, report] },
  interrupted: { title: '服务重启，运行已中断', detail: '服务在运行期间重启，本次运行没有恢复执行。已有的观测与证据已保留，可以重新运行。',
    actions: [retry, report] },
  unknown: { title: '运行没有完成', detail: '运行在得到验收结果前停止了。报告中保留了已有记录，可以重新运行。',
    actions: [retry, report] },
};
const reasonDetails: Record<string, string> = {
  math_model_usage_unavailable: '服务商没有返回完整的用量回执，为避免超出用量上限，后续调用已停止。已检查的成果保存在报告中。',
  math_preparation_stopped: '准备证明环境时用完了预算，解题尚未开始。Mathlib 环境首次准备较慢，可以提高解题预算后重新运行。',
};

/** What went wrong and how to recover, for runs that ended without an accepted proof or a rejected candidate. */
export function failureGuide(run: WebRun): FailureGuide | undefined {
  if (run.status === 'queued' || run.status === 'running' || run.status === 'cancelled' || isAcceptedRun(run)) return;
  const kind = run.failure?.kind ?? (run.phase === 'interrupted' ? 'interrupted' : run.status === 'error' ? 'unknown'
    : run.result?.status === 'limit_reached' ? 'time_limit' : undefined);
  if (kind) {
    const guide = guides[kind], detail = run.failure?.reason && reasonDetails[run.failure.reason];
    return detail ? { ...guide, detail } : guide;
  }
  if (run.result?.status === 'incomplete') return { title: '没有得到完整证明', detail: 'Agent 用完了轮次，或没有可以继续的研究路线。已检查的成果保存在报告中。可以提高轮次上限、增加 Agent，或在任务说明里补充思路。',
    actions: [{ id: 'turns', label: '提高轮次上限' }, report] };
}

const reportedTokens = (usage: unknown) => {
  const value = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
  const count = (key: string) => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0 ? value[key] as number : undefined;
  const total = count('totalTokens'), input = count('inputTokens'), output = count('outputTokens');
  return total ?? (input !== undefined && output !== undefined ? input + output : undefined);
};
export const formatTokens = (value: number) => value >= 1e8 ? `${(value / 1e8).toFixed(1)} 亿` : value >= 1e4 ? `${Math.round(value / 1e4)} 万` : String(value);

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
  if (!queue) return '等待可用的运行环境。';
  const slots = `${queue.running}/${queue.slots} 个运行位正在使用`;
  return queue.ahead ? `前面还有 ${queue.ahead} 个任务，${slots}。轮到后自动开始，可以关闭页面。`
    : queue.running < queue.slots ? '下一个开始运行。' : `排在第 1 位，${slots}，有任务结束后自动开始。可以关闭页面。`;
}

export function resultDescription(run: WebRun): string {
  const guide = failureGuide(run);
  if (guide) return guide.detail;
  if (run.error) return run.error;
  if (run.status === 'cancelled') return '任务已停止。';
  if (run.status === 'queued') return queueDescription(run);
  if (run.status === 'running') {
    const stage = runProgress(run).index;
    if (stage === 1) return `${run.environment === 'mathlib' ? 'Mathlib 依赖' : 'Lean 环境'}准备中，解题尚未开始。`;
    if (stage === 3) return '正在独立验证完整原题。';
    return '正在构造与检查候选证明。';
  }
  if (isAcceptedRun(run)) return '完整原题通过独立 Lean 验收。';
  if (run.result?.status === 'evaluated_failed') return '候选证明未通过独立 Lean 验收。';
  if (run.result?.status === 'evaluated_rejected') return '候选未满足验收约束，详情见报告。';
  if (run.status === 'error') return '运行环境或模型会话发生错误。';
  return '本次研究尚未得到通过完整原题验收的证明。';
}
