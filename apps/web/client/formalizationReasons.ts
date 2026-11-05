import { t } from '../i18n';

/** What a formalization stop code means for the reader; an unknown code keeps a generic sentence and is shown as the diagnostic. */
export function formalizationReasonText(reason: string): string {
  const reasons: Record<string, string> = {
    formalization_time_limit: t('已达到时间上限，尚未完成形式化。'),
    formalization_token_limit: t('已用完本次 Token 预算，尚未完成形式化。'),
    math_total_token_limit: t('已用完本次 Token 预算，尚未完成形式化。'),
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
