import { useMemo } from 'preact/hooks';
import type { ResearchFeedback } from '../researchProjectTypes';
import { compareSources } from './sourceDiff';
import { DiffRows } from './ui/Section';
import { RichProse } from './richText';
import { nameOf, stamp, tx } from './researchShared';

export function CandidateHistory({ feedback, onReveal }: { feedback: ResearchFeedback; onReveal(id: string): void }) {
  const revision = feedback.candidateRevision, payload = feedback.payload && 'source' in feedback.payload ? feedback.payload : undefined;
  const diff = useMemo(() => revision && payload ? compareSources(revision.parentSnapshot.source, payload.source) : undefined, [revision, payload?.source]);
  if (!revision || !payload) return null;
  const parent = revision.parentSnapshot;
  return <details class="candidate-revision-history" data-candidate-revision={revision.number}><summary>{tx(`候选第 ${revision.number} 版 · 查看上一版与修改回应`, `Candidate revision ${revision.number} · compare and review responses`)}</summary>
    <button class="text-button" type="button" onClick={() => onReveal(revision.parentFeedbackId)}>{tx('打开上一版完整记录', 'Open the full previous revision')}</button>
    <p>{tx('上一版检查：', 'Previous check: ')}{nameOf(parent.proofCheck?.status ?? 'not-started')} · {tx('上一版评审：', 'Previous decision: ')}{nameOf(parent.decision.status)} · {stamp(parent.decision.decidedAt ?? '')}</p>
    {parent.decision.reason && <RichProse text={parent.decision.reason} />}
    <details><summary>{tx('冻结的上一版源码', 'Frozen source of the previous revision')}</summary><pre class="research-block-code">{parent.source}</pre></details>
    {diff?.status === 'ready' ? <div class="collab-source-diff" tabIndex={0} data-candidate-revision-diff><table class="diff-table"><thead><tr><th>{tx('上一版', 'Previous')}</th><th>{tx('这一版', 'Current')}</th><th>{tx('源码', 'Source')}</th></tr></thead><tbody><DiffRows rows={diff.rows} /></tbody></table></div>
      : diff?.status === 'identical' ? <p>{tx('两版源码相同；补充说明和评审回应保留在下方。', 'The source is unchanged. Additional explanation and review responses are retained below.')}</p>
      : <p>{tx('这份源码暂时无法生成差异，可打开两版完整源码核对。', 'A source comparison is unavailable. Open both complete versions to compare them.')}</p>}
    {parent.comments.map(comment => <div class="candidate-review-response" key={comment.id}><strong>{comment.author.displayName}</strong><RichProse text={comment.text} /><p>{tx('作者回应', 'Author response')}</p><RichProse text={revision.responses.find(item => item.commentId === comment.id)?.text ?? ''} /></div>)}
  </details>;
}
