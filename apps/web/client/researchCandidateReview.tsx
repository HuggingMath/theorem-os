import { useMemo, useState } from 'preact/hooks';
import type { ResearchCandidateReview, ResearchFeedback } from '../researchProjectTypes';
import { localizeMessage } from '../i18n';
import { compareSources } from './sourceDiff';
import { DiffRows } from './ui/Section';
import { base, enc, Empty, ErrorBox, stamp, tx, useResource, type Item } from './researchShared';

export function CandidateReview({ projectId, feedback }: { projectId: string; feedback: ResearchFeedback }) {
  const [opened, setOpened] = useState(false), [mode, setMode] = useState<'candidate' | 'baseline' | 'diff' | 'check'>('candidate');
  const review = useResource<Item<ResearchCandidateReview>>(opened
    ? `${base}/theorems/${enc(projectId)}/feedback/${enc(feedback.id)}/candidate-review?check=${enc(feedback.proofCheck?.receiptId ?? '')}` : undefined);
  const payload = feedback.payload && 'source' in feedback.payload ? feedback.payload : undefined;
  const saved = review.data?.item, baseline = saved?.baseline, check = saved?.check;
  const comparison = useMemo(() => baseline && payload ? compareSources(baseline.source, payload.source) : undefined, [baseline?.source, payload?.source]);
  if (!payload) return null;
  return <details class="research-candidate-review" data-candidate-review onToggle={event => { if (event.currentTarget.open) setOpened(true); }}>
    <summary>{tx('审阅候选证明', 'Review candidate proof')}</summary>
    {opened && <>
      <p class="research-field-note">{tx('这里保留本次提交的源码与基准。候选检查、采纳和完整原题验收分别记录。', 'This is the submitted source and its fixed baseline. Candidate checking, adoption and full proof acceptance are recorded separately.')}</p>
      <div class="research-tabs" role="group" aria-label={tx('候选证明视图', 'Candidate proof view')}>
        <button type="button" aria-pressed={mode === 'candidate'} onClick={() => setMode('candidate')}>{tx('候选源码', 'Candidate source')}</button>
        <button type="button" aria-pressed={mode === 'baseline'} onClick={() => setMode('baseline')}>{tx('提交基准', 'Submission baseline')}</button>
        <button type="button" aria-pressed={mode === 'diff'} onClick={() => setMode('diff')}>{tx('差异对比', 'Compare changes')}</button>
        <button type="button" aria-pressed={mode === 'check'} onClick={() => setMode('check')}>{tx('检查回执', 'Check receipt')}</button>
      </div>
      <p class="research-status">{payload.base.file} · {tx('基准提交', 'Baseline commit')} <code>{payload.base.commit.slice(0, 12)}</code></p>
      <details><summary>{tx('提交与基准的完整身份', 'Full submission and baseline identity')}</summary><dl class="research-facts">
        <div><dt>{tx('任务版本', 'Task version')}</dt><dd>{feedback.target?.taskRef?.id} · {feedback.target?.taskRef?.version}</dd></div>
        <div><dt>{tx('原观测', 'Original observation')}</dt><dd>#{feedback.target?.observationRef.sequence} · {feedback.target?.observationRef.stateDigest}</dd></div>
        <div><dt>{tx('文件', 'File')}</dt><dd>{payload.base.file}</dd></div>
        <div><dt>{tx('基准提交', 'Baseline commit')}</dt><dd>{payload.base.commit}</dd></div>
        <div><dt>{tx('基准源码摘要', 'Baseline source digest')}</dt><dd>{payload.base.sourceDigest}</dd></div>
        <div><dt>{tx('环境摘要', 'Environment digest')}</dt><dd>{payload.base.environmentDigest}</dd></div>
        {saved && <div><dt>{tx('候选源码摘要', 'Candidate source digest')}</dt><dd>{saved.sourceDigest}</dd></div>}
      </dl></details>
      {mode === 'candidate' && <pre class="research-block-code" tabIndex={0} data-candidate-source aria-label={tx('本次提交的候选源码', 'Submitted candidate source')}>{payload.source}</pre>}
      {mode === 'baseline' && (baseline ? <><pre class="research-block-code" tabIndex={0} data-candidate-baseline aria-label={tx('本次提交的基准源码', 'Submitted baseline source')}>{baseline.source}</pre>
        {baseline.dependencySources?.length ? <details><summary>{tx('基准依赖源码', 'Baseline dependency sources')}</summary>{baseline.dependencySources.map(file => <div key={file.file}><h3>{file.file}</h3><pre class="research-block-code" tabIndex={0}>{file.source}</pre></div>)}</details> : null}</>
        : review.loading ? <p role="status">{tx('正在读取提交基准…', 'Loading the submission baseline…')}</p>
          : <Empty>{tx('未找到与本次提交完全匹配的基准源码，保留上方的原始身份。', 'The exact baseline source is unavailable. Its original identity is retained above.')}</Empty>)}
      {mode === 'diff' && (comparison?.status === 'ready' ? <>
        <p class="research-status">{tx(`新增 ${comparison.added} 行 · 删除 ${comparison.removed} 行`, `${comparison.added} lines added · ${comparison.removed} lines removed`)}
          {comparison.omittedLines > 0 && <> · {tx(`另有 ${comparison.omittedLines} 行未展示，可分别查看完整源码`, `${comparison.omittedLines} more lines omitted; open either complete source`)}</>}</p>
        <div class="collab-source-diff" tabIndex={0} data-candidate-diff aria-label={tx('候选与提交基准的差异', 'Changes from the submitted baseline')}><table class="diff-table">
          <thead><tr><th scope="col">{tx('基准', 'Baseline')}</th><th scope="col">{tx('候选', 'Candidate')}</th><th scope="col">{tx('源码', 'Source')}</th></tr></thead>
          <tbody><DiffRows rows={comparison.rows} /></tbody></table></div></>
        : <Empty>{review.loading ? tx('正在读取差异…', 'Loading changes…') : comparison?.status === 'identical'
          ? tx('候选与基准内容相同。', 'The candidate and baseline are identical.')
          : tx('逐行差异暂不可用，可分别查看候选源码与提交基准。', 'A line comparison is unavailable. Open the candidate source and submission baseline separately.')}</Empty>)}
      {mode === 'check' && (check ? <div data-candidate-check>
        <p class="research-status">{check.receipt.passed ? tx('此候选声明已通过独立检查', 'This candidate declaration passed its independent check') : tx('此候选未通过独立检查', 'This candidate did not pass its independent check')} · {stamp(check.receipt.checkedAt)}</p>
        <dl class="research-facts"><div><dt>{tx('检查声明', 'Checked declaration')}</dt><dd>{check.receipt.declaration?.name ?? tx('未进入声明检查', 'Declaration check was not reached')}</dd></div>
          <div><dt>{tx('回执摘要', 'Receipt digest')}</dt><dd>{check.receiptId}</dd></div>
          <div><dt>{tx('检查范围', 'Check scope')}</dt><dd>{tx('本次提交的任务声明', 'The submitted task declaration')}</dd></div></dl>
        {check.receipt.reason && <p>{localizeMessage(check.receipt.reason)}</p>}
        {check.receipt.diagnostics.length > 0 && <ul>{check.receipt.diagnostics.map((item, index) => <li key={index}>{item.line}:{item.column} · {item.severity} · {item.message ?? item.code}</li>)}</ul>}
        <details><summary>{tx('完整检查回执', 'Complete check receipt')}</summary><pre class="research-block-code" tabIndex={0} data-candidate-check-receipt>{JSON.stringify(check.receipt, null, 2)}</pre></details>
      </div> : <Empty>{review.loading ? tx('正在读取检查回执…', 'Loading the check receipt…') : feedback.proofCheck
        ? tx('完整检查回执暂不可用，原检查状态与摘要保留在反馈中。', 'The complete check receipt is unavailable. Its recorded status and digest remain in the feedback.')
        : tx('候选检查尚未完成。', 'The candidate check has not completed.')}</Empty>)}
      <ErrorBox message={review.error} />
      {review.error && <button class="text-button" type="button" disabled={review.loading} onClick={review.refresh}>{tx('重新读取审阅资料', 'Reload review material')}</button>}
    </>}
  </details>;
}
