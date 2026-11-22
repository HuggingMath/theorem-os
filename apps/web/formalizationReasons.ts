import type { WebFormalizationProgress } from './formalizationTypes';
import { t } from './i18n';

export function formalizationPhaseText(phase: WebFormalizationProgress['phase'] | undefined, translate = t): string {
  switch (phase) {
    case 'queued': return translate('等待开始');
    case 'preparing': return translate('准备证明环境');
    case 'planning': return translate('理解题目与定义');
    case 'generating': return translate('生成 Lean 陈述');
    case 'compiling': return translate('检查 Lean 陈述');
    case 'translating': return translate('核对自然语言与 Lean');
    case 'reviewing': return translate('审核原题一致性');
    case 'finishing': return translate('整理形式化结果');
    default: return translate('形式化');
  }
}

/** What a formalization stop code means for the reader; an unknown code keeps a generic sentence and is shown as the diagnostic. */
export function formalizationReasonText(reason: string, tOverride = t): string {
  const reasons: Record<string, string> = {
    formalization_time_limit: '已达到时间上限，尚未完成形式化。',
    formalization_token_limit: '已用完本次 Token 预算，尚未完成形式化。',
    math_total_token_limit: '已用完本次 Token 预算，尚未完成形式化。',
    math_model_usage_unavailable: '模型服务没有返回 Token 用量，无法控制上限，已停止。',
    formalization_rounds_exhausted: '已达到写作轮次上限，尚未得到一致通过的陈述。',
    formalization_runtime_unavailable: '形式化运行环境暂不可用，请稍后重试。',
    formalization_interrupted: '服务中断，形式化未完成。',
    formalization_source_too_large: '生成的 Lean 陈述过长，请拆分原题后重新生成。',
    formalization_role_isolation_failed: '未能准备独立审核环境，请稍后重试。',
    formalization_isolation_failed: '未能准备独立审核环境，请稍后重试。',
    formalization_role_incomplete: '负责这一阶段的模型没有交回完整结果，形式化因此停止。',
    formalization_research_interrupted: '服务中断，Lean 陈述已通过检查，但证明研究未启动。',
    formalization_research_queue_failed: 'Lean 陈述已通过检查，但证明队列已满或不可用，证明研究未启动。',
  };
  const key = reason.split(':')[0];
  return tOverride(Object.hasOwn(reasons, key) ? reasons[key] : '本次生成未完成。');
}

export function formalizationNextStep(reason: string): string {
  if (['formalization_token_limit', 'math_total_token_limit', 'formalization_time_limit'].includes(reason))
    return t('先核对本次用量和预算；如需再试，可重新发送原题。不会自动重试，也不会自动增加预算。');
  if (['formalization_research_queue_failed', 'formalization_research_interrupted'].includes(reason))
    return t('保留这份陈述，点击「继续证明」重新进入证明队列。');
  if (['formalization_runtime_unavailable', 'formalization_interrupted', 'formalization_role_isolation_failed', 'formalization_isolation_failed'].includes(reason))
    return t('待服务恢复后可重新发送原题；持续失败时请提供错误代码联系管理员。不会自动重试。');
  if (['formalization_source_too_large', 'formalization_rounds_exhausted'].includes(reason))
    return t('检查题目范围与表述后重新发送；不会自动重试。');
  return t('可重新发送原题。若多次失败，请提供错误代码。');
}
