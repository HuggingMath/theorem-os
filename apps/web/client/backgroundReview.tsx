import type { WebFormalization } from '../formalizationTypes';
import { t } from '../i18n';

export type BackgroundReviewState = NonNullable<WebFormalization['backgroundReview']>;

/** Background work keeps polling alive without making generation or proof actions busy. */
export const backgroundReviewPending = (review?: BackgroundReviewState): boolean =>
  review?.status === 'queued' || review?.status === 'running';

export function backgroundReviewLabel(review: BackgroundReviewState): string {
  const labels: Record<BackgroundReviewState['status'], string> = {
    queued: t('后台审核排队中'), running: t('后台审核中'), approved: t('后台审核通过'),
    changes_requested: t('后台审核：需修改'), unknown: t('后台审核：不确定'), error: t('后台审核失败'),
    cancelled: t('后台审核已取消'), interrupted: t('后台审核已中断'),
  };
  return labels[review.status];
}

const aspectLabels: Record<string, string> = {
  domains: t('对象与取值范围'), assumptions: t('假设'), conclusions: t('结论'), definitions: t('用到的定义'),
  quantifierScope: t('量词范围'), instanceCoherence: t('类型类实例'),
};
const tone = (status: BackgroundReviewState['status']) => status === 'approved' ? 'passed'
  : status === 'changes_requested' || status === 'error' ? 'failed' : 'warning';
function reasonText(reason: string) {
  if (['formalization_time_limit', 'formalization_audit_time_limit', 'formalization_timeout'].includes(reason))
    return t('后台审核已达到设置的时间上限。');
  if (['formalization_token_limit', 'formalization_audit_token_limit', 'math_total_token_limit'].includes(reason))
    return t('后台审核已用完设置的 Token 预算。');
  if (reason === 'formalization_audit_queue_full') return t('后台审核队列已满，已编译代码仍可使用。');
  return t('后台审核未完成，已编译代码仍可使用。');
}

/** One independent review of the frozen statement; it never replaces compiler evidence. */
export function BackgroundReview({ review, compact = false }: { review?: BackgroundReviewState; compact?: boolean }) {
  if (!review) return null;
  const result = review.result?.review;
  const status = <p role="status" aria-live="polite" aria-atomic="true" class="background-review-status">
    <strong class={`badge ${tone(review.status)}`}>{backgroundReviewLabel(review)}</strong></p>;
  if (compact) return <div class="background-review" data-background-review={review.status}>
    {status}{backgroundReviewPending(review) && <p>{t('代码已可使用，审核在后台同步进行。')}</p>}
    {review.reason && <p>{reasonText(review.reason)}</p>}
    {result?.summary && <p translate={false}>{result.summary}</p>}
  </div>;
  return <section class="explain-section background-review" data-background-review={review.status}>
    <header class="explain-section-head"><h3>{t('后台单次审核')}</h3>{status}
      <p class="formal-lead">{t('一个独立会话核对原题与已编译的 Lean 陈述，代码下载和证明可继续使用。')}</p></header>
    {result?.summary && <p class="explain-rich" translate={false}>{result.summary}</p>}
    {review.reason && <p class="formal-note">{reasonText(review.reason)}</p>}
    {result && <>
      <ul class="formal-checks">{Object.entries(result.checks).map(([aspect, value]) => <li key={aspect}>
        <span>{aspectLabels[aspect] ?? aspect}</span><span class={`badge ${value ? 'passed' : 'failed'}`}>{value ? t('通过') : t('未通过')}</span>
      </li>)}</ul>
      {result.issues.map((issue, index) => <article class="formal-item" key={index} data-background-review-issue={issue.aspect}>
        <h4>{aspectLabels[issue.aspect] ?? issue.aspect}</h4>
        <p class="formal-label">{t('原题片段')}</p><blockquote translate={false}>{issue.originalFragment}</blockquote>
        <p class="formal-label">{t('Lean 片段')}</p><pre tabIndex={0} translate={false}><code>{issue.leanFragment}</code></pre>
        <p class="explain-rich" translate={false}>{issue.explanation}</p>
      </article>)}
    </>}
  </section>;
}
