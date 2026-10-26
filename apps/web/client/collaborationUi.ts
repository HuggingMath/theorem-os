import { localeTag, t } from '../i18n';
export type WebApi = <T>(url: string, init?: RequestInit) => Promise<T>;
export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));
export const jsonText = (value: unknown) => JSON.stringify(value, null, 2) ?? '—';
export const errorText = (error: unknown) => error instanceof Error ? error.message : t('请求失败，请重试');
export const commandId = () => crypto.randomUUID();
/** Observation timestamps arrive as ISO strings or epoch milliseconds; show local date and time to the second, keep unparseable values verbatim. */
export function observedTime(value: string | number) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(localeTag, { month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hour12: false }).format(date) : String(value);
}
export const coverageLabel = (value: 'recorded' | 'partial') => value === 'recorded' ? t('已完整记录') : t('仅部分记录');
/** Runtime codes shown to readers; an unknown code is shown as is rather than guessed. */
const labels = (table: Record<string, string>) => (value: string | undefined) => value === undefined ? undefined : table[value] ?? value;
export const roleLabel = labels({ lead: 'Lead', researcher: 'Researcher', prover: 'Prover', engineer: 'Engineer', reviewer: 'Reviewer' });
export const schedulingLabel = labels({ working: t('工作中'), preparing: t('准备中'), stopping: t('停止中'), idle: t('空闲'), stopped: t('已停止') });
export const workerPhaseLabel = labels({ prepared: t('已准备'), running: t('研究中'), checking: t('检查中'), evaluating: t('验收中'), finished: t('已结束') });
export const dispatchWaitLabel = labels({ recorded: t('已记录'), stale: t('记录已过期'), unknown: t('未记录') });
export const recipientLabel = labels({ lead: 'Lead', task: t('任务'), worker: 'Agent' });
/** Plan edits, their rechecks and command receipts. */
export const editStatusLabel = labels({ received: t('已接收'), validated: t('已校验'), applied: t('已应用'), rejected: t('已拒绝'), already_queued: t('已在队列中'),
  pending: t('待重新检查'), passed: t('重新检查通过'), failed: t('重新检查未通过'), 'not-required': t('无需重新检查'), superseded: t('已被替代'), unknown: t('结果尚未确认') });
export const coverageStateLabel = labels({ available: t('引用齐全'), missing: t('引用缺失') });
export function createElement<T extends keyof HTMLElementTagNameMap>(tag: T, className = '', markup?: string) {
  const node = document.createElement(tag); node.className = className;
  if (markup !== undefined) node.innerHTML = markup;
  return node;
}
