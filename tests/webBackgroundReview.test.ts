import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, it } from 'vitest';
import { BackgroundReview, backgroundReviewLabel, backgroundReviewPending, type BackgroundReviewState } from '../apps/web/client/backgroundReview';
import { formalize } from '../apps/web/i18n/formalize';

const statuses: BackgroundReviewState['status'][] = [
  'queued', 'running', 'approved', 'changes_requested', 'unknown', 'error', 'cancelled', 'interrupted',
];
const review = (status: BackgroundReviewState['status'], result?: BackgroundReviewState['result']): BackgroundReviewState => ({
  status, evidenceSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), queuedAt: '2026-11-09T04:00:00Z', ...(result ? { result } : {}),
});
const result: NonNullable<BackgroundReviewState['result']> = {
  schema: 'theorem-os.formalization-audit.v1', evidenceSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64),
  snapshotDigest: 'c'.repeat(64), originalSha256: 'd'.repeat(64), environmentDigest: 'e'.repeat(64),
  model: 'test-model', effort: 'max', startedAt: '2026-11-09T04:00:01Z', finishedAt: '2026-11-09T04:00:02Z',
  session: { threadId: 'independent-review-fixture', turnId: 'review-turn', status: 'completed',
    inputDigest: 'f'.repeat(64), outputDigest: '0'.repeat(64), usage: {} },
  review: { verdict: 'changes_requested', summary: 'The statement omits the characteristic-zero assumption.',
    checks: { domains: true, assumptions: false, conclusions: true, definitions: true,
      quantifierScope: true, instanceCoherence: true },
    issues: [{ aspect: 'assumptions', originalFragment: 'Let K have characteristic 0.', leanFragment: 'variable (K : Type*) [Field K]',
      explanation: 'The Lean statement also permits fields of positive characteristic.' }] },
};

/** Inspect the Preact output without a browser or a server/model fixture. */
function nodes(children: ComponentChildren): VNode[] {
  if (Array.isArray(children)) return children.flatMap(nodes);
  if (children === null || children === undefined || typeof children !== 'object') return [];
  const node = children as VNode<{ children?: ComponentChildren }>;
  return [node, ...nodes(node.props.children)];
}
function text(children: ComponentChildren): string {
  if (Array.isArray(children)) return children.map(text).join(' ');
  if (children === null || children === undefined || typeof children === 'boolean') return '';
  if (typeof children !== 'object') return String(children);
  return text((children as VNode<{ children?: ComponentChildren }>).props.children);
}

describe('background formalization review UI', () => {
  it('keeps polling only queued or running reviews', () => {
    expect(backgroundReviewPending()).toBe(false);
    expect(statuses.filter(status => backgroundReviewPending(review(status)))).toEqual(['queued', 'running']);
  });

  it('updates a compact running snapshot with a later request for changes', () => {
    const running = BackgroundReview({ review: review('running'), compact: true });
    const changed = BackgroundReview({ review: review('changes_requested', result), compact: true });
    expect(running?.props['data-background-review']).toBe('running');
    expect(text(running)).toContain('后台审核中');
    expect(text(running)).toContain('代码已可使用，审核在后台同步进行。');
    expect(changed?.props['data-background-review']).toBe('changes_requested');
    expect(text(changed)).toContain('后台审核：需修改');
    expect(text(changed)).toContain(result.review.summary);
    expect(text(changed)).not.toContain('后台审核中');
    expect(text(changed)).not.toContain('审核在后台同步进行');
    expect(nodes(changed).some(node => node.type === 'button')).toBe(false);
  });

  it('shows all six checks and the cited problem and Lean fragments in the single review', () => {
    const rendered = BackgroundReview({ review: review('changes_requested', result) });
    const output = text(rendered);
    expect(output).toContain('后台单次审核');
    expect(output).toContain('代码下载和证明可继续使用');
    const checks = nodes(rendered).filter(node => node.type === 'li');
    expect(checks).toHaveLength(6);
    expect(checks.map(text)).toContain('假设 未通过');
    expect(checks.filter(node => text(node).endsWith(' 未通过'))).toHaveLength(1);
    expect(checks.filter(node => text(node).endsWith(' 通过'))).toHaveLength(5);
    expect(output).toContain(result.review.issues[0]!.originalFragment);
    expect(output).toContain(result.review.issues[0]!.leanFragment);
    expect(output).toContain(result.review.issues[0]!.explanation);
    expect(output).not.toContain('回译');
    expect(nodes(rendered).filter(node => node.type === 'pre')).toHaveLength(1);
  });

  it('provides distinct localized labels for every state and omits absent reviews', () => {
    const labels = statuses.map(status => backgroundReviewLabel(review(status)));
    expect(new Set(labels).size).toBe(statuses.length);
    expect(labels.every(label => Boolean(formalize[label]))).toBe(true);
    expect(BackgroundReview({})).toBeNull();
  });

  it('explains failures without displaying internal error codes', () => {
    for (const [reason, explanation] of [
      ['formalization_audit_session_incomplete', '后台审核未完成，已编译代码仍可使用。'],
      ['formalization_time_limit', '后台审核已达到设置的时间上限。'],
      ['formalization_token_limit', '后台审核已用完设置的 Token 预算。'],
    ]) {
      const output = text(BackgroundReview({ review: { ...review('error'), reason } }));
      expect(output).toContain(explanation); expect(output).not.toContain(reason);
    }
  });
});
