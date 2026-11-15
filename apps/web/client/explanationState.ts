import type { WebExplanationOverview } from '../shared';
import { t } from '../i18n';

const reasons: Record<string, string> = {
  informalization_rounds_exhausted: t('审核多轮仍未通过，已停止。可以重新生成；同一份证明换一次写作也可能通过。'),
  explanation_token_limit: t('Token 用量达到上限，已停止。'), informalization_token_limit: t('Token 用量达到上限，已停止。'),
  informalization_time_limit: t('生成时间达到上限，已停止。'), explanation_timeout: t('生成时间达到上限，已停止。'),
  explanation_usage_unavailable: t('模型服务没有返回 Token 用量，无法控制上限，已停止。'),
  explanation_interrupted: t('服务重启，生成被中断，请重新生成。'),
  explanation_evidence_mismatch: t('生成结果与这次运行的证明不一致，没有保存。'), explanation_evidence_invalid: t('生成结果没有通过完整性检查，没有保存。'),
  informalization_proof_does_not_compile: t('讲解环境中证明没有通过编译。'), informalization_proof_incomplete: t('证明依赖 sorry，无法讲解。'),
  informalization_proof_assumes_axiom: t('证明中声明了 axiom，无法讲解。'),
  explanation_runtime_unavailable: t('讲解运行环境不可用，请稍后重试。'), explanation_container_failed: t('讲解运行环境异常退出，请稍后重试。'),
  explanation_worker_exited: t('讲解运行环境异常退出，请稍后重试。'), explanation_worker_no_result: t('讲解运行环境异常退出，请稍后重试。'),
  explanation_gateway_unavailable: t('无法连接模型服务，请稍后重试。'), explanation_provider_unsupported: t('证明讲解目前只支持 Sub2API 模型服务。'),
  explanation_input_too_large: t('证明太大，无法生成讲解。'), explanation_output_too_large: t('讲解结果太大，没有保存。'),
  explanation_queue_full: t('讲解队列已满，可稍后重新生成。'),
  explanation_quota_exhausted: t('讲解额度已用完，可在额度恢复后重新生成。'),
  explanation_key_required: t('缺少可用的 API Key，请补充后生成讲解。'),
  explanation_statement_unreviewed: t('原题含义审核尚未通过，暂未生成讲解。'),
  explanation_service_unavailable: t('当前服务不提供证明讲解。'),
  explanation_account_unavailable: t('当前账户不可用，暂未生成讲解。'),
};
export const explanationReasonText = (reason?: string) => reason && reasons[reason] ? reasons[reason] : t('生成失败，可以重新生成。');

const unavailable: Record<string, string> = {
  sample: t('示例运行只读，不能生成讲解。'), not_accepted: t('只有通过独立验收的运行可以生成讲解。'),
  provider: t('证明讲解目前只支持 Sub2API 模型服务。'), model: t('证明讲解目前只支持 deepseek-flash 模型。'), runtime: t('当前服务不提供证明讲解。'),
};
export const explanationUnavailableText = (reason: Extract<WebExplanationOverview['generation'], { available: false }>['reason']) => unavailable[reason];
