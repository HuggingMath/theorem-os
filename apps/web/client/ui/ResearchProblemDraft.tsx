import { render } from 'preact';
import { useState } from 'preact/hooks';
import { t } from '../../i18n';
import type { ResearchProblemDraft } from '../researchProblemDraft';
import { ChatMessageContent } from './ChatMessageContent';

type Props = { loading?: boolean; candidate?: ResearchProblemDraft; error?: string; onInclude(): void; onDismiss(): void; onRetry(): void };
function ResearchProblemDraftView(props: Props) {
  const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState(false);
  const { candidate } = props;
  return <section class="chat-problem-draft" data-problem-draft-candidate aria-labelledby="problem-draft-heading" aria-busy={props.loading}>
    <h2 id="problem-draft-heading">{t('从这道题开始研究')}</h2>
    {props.loading && <p role="status">{t('正在读取固定版本的原题…')}</p>}
    {props.error && <div class="chat-error" role="alert"><p>{props.error}</p><button type="button" class="text-button" onClick={props.onRetry}>{t('重试')}</button></div>}
    {candidate && <>
      <h3 translate={false}>{candidate.title}</h3>
      <ChatMessageContent text={candidate.statement} />
      <p class="chat-problem-draft-help">{t('加入后可在输入框中修改题目，再由你发送。现有草稿会保留。')}</p>
      {!candidate.sourceIncluded && <p class="chat-problem-draft-help">{t('完整 Lean 原题超过输入框容量，将加入题目说明、全部目标和固定来源。完整源码可在下方展开或复制。')}</p>}
      <a href={candidate.sourceUrl} target="_blank" rel="noopener">{t('查看题目来源')}</a>
      <details class="chat-problem-draft-source"><summary>{t('完整 Lean 原题与版本')}</summary>
        <p class="chat-problem-draft-digest" translate={false}>SHA-256: {candidate.sourceDigest}</p>
        <button type="button" class="text-button" data-problem-draft-copy onClick={() => {
          setCopyError(false); void (navigator.clipboard?.writeText(candidate.source) ?? Promise.reject()).then(() => setCopied(true), () => setCopyError(true));
        }}>{copied ? t('代码已复制') : t('复制代码')}</button>
        {copyError && <p role="status">{t('复制失败，请选择代码复制。')}</p>}
        <pre data-problem-draft-source tabIndex={0} translate={false}><code>{candidate.source}</code></pre>
      </details>
    </>}
    <div class="chat-task-actions">
      {candidate && <button type="button" class="button button-primary" data-problem-draft-include onClick={props.onInclude}>{t('加入草稿')}</button>}
      <button type="button" class="text-button" data-problem-draft-dismiss onClick={props.onDismiss}>{t('暂不加入')}</button>
    </div>
  </section>;
}
export function renderResearchProblemDraft(root: HTMLElement, props?: Props) { render(props ? <ResearchProblemDraftView {...props} /> : null, root); }
