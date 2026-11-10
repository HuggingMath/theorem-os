import { t } from '../i18n';

/** What a formalization stop code means for the reader; an unknown code keeps a generic sentence and is shown as the diagnostic. */
export function formalizationReasonText(reason: string): string {
  const reasons: Record<string, string> = {
    formalization_time_limit: t('已达到时间上限，尚未完成形式化。'),
    formalization_token_limit: t('已用完本次 Token 预算，尚未完成形式化。'),
    math_total_token_limit: t('已用完本次 Token 预算，尚未完成形式化。'),
    math_model_usage_unavailable: t('模型服务没有返回 Token 用量，无法控制上限，已停止。'),
    formalization_rounds_exhausted: t('已达到写作轮次上限，尚未得到一致通过的陈述。'),
    formalization_runtime_unavailable: t('形式化运行环境暂不可用，请稍后重试。'),
    formalization_interrupted: t('服务中断，形式化未完成。'),
    formalization_source_too_large: t('生成的 Lean 陈述过长，请拆分原题后重新生成。'),
    formalization_role_isolation_failed: t('未能准备独立审核环境，请稍后重试。'),
    formalization_isolation_failed: t('未能准备独立审核环境，请稍后重试。'),
    formalization_research_interrupted: t('服务中断，Lean 陈述已通过检查，但证明研究未启动。'),
    formalization_research_queue_failed: t('Lean 陈述已通过检查，但证明队列已满或不可用，证明研究未启动。'),
  };
  return reasons[reason] ?? t('本次生成未完成。');
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
  return t('查看错误代码和保留成果，确认原因后再决定是否重新发送；不会自动重试。');
}
