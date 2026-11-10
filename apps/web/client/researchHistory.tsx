import type { ResearchHistoryRecord } from '../researchWorkspaceTypes';
import { Rich, RichProse } from './richText';
import { ProblemTaskEvidence } from './researchProblemEvidenceView';
import { BriefPreview } from './researchWorkspace';
import { base, enc, ErrorBox, Panel, stamp, tx, useResource, type Item, type ResearchContext } from './researchShared';

export function ResearchHistoryReader({ id, context }: { id: string; context: ResearchContext }) {
  const data = useResource<Item<ResearchHistoryRecord>>(`${base}/workspace/history/${enc(id)}`), record = data.data?.item;
  return <Panel title={tx('保存的历史证据', 'Saved historical evidence')}>
    <ErrorBox message={data.error} />{data.error && <button class="button" type="button" onClick={data.refresh}>{tx('重新读取', 'Try again')}</button>}
    {data.loading && <p role="status">{tx('正在读取这个版本…', 'Loading this version…')}</p>}
    {record && <article data-research-history={record.id}>
      <p><Rich text={record.context} /> · {stamp(record.updatedAt)}</p><h3><Rich text={record.title} /></h3>
      {record.observationRef && <p>{tx('保存的观察', 'Saved observation')} {record.observationRef.sequence} · <code>{record.observationRef.stateDigest.slice(0, 16)}</code></p>}
      {record.task ? <ProblemTaskEvidence task={record.task} tasks={[record.task]} /> : <RichProse text={record.text} />}
      {record.check && <section data-history-check><h4>{tx('当时保存的检查回执', 'Check receipt saved at this point')}</h4><p>{record.check.record.passed === true ? tx('检查通过', 'Check passed') : tx('检查未通过', 'Check failed')}</p><pre class="research-block-code" tabIndex={0}><code>{JSON.stringify(record.check, null, 2)}</code></pre></section>}
      {record.source && <details open data-history-source><summary>{tx('当时保存的源码', 'Source saved at this point')} · {record.source.file}</summary>
        <p>Commit: <code>{record.source.commit}</code></p><p>SHA-256: <code>{record.source.digest}</code></p><pre class="research-block-code"><code>{record.source.text}</code></pre>
      </details>}
      {record.snapshot && <details><summary>{tx('定稿时的完整研究记录', 'Complete research record at the time of the conclusion')}</summary><BriefPreview brief={record.snapshot} context={context} /></details>}
      {record.originHref && <a class="button" href={record.originHref}>{tx('打开讨论与处理记录', 'Open discussion and decision records')}</a>}
    </article>}
  </Panel>;
}
