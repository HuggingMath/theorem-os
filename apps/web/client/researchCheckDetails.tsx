import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ResearchJourneyCheck, ResearchObservationRef } from '../researchJourneyTypes';
import { diagnostics } from '../report';
import { checkReason, shownLines } from '../presentation';
import { localizeMessage } from '../i18n';
import { leanMessages, sameLeanFile } from './leanMessages';
import { compareSources } from './sourceDiff';
import { DiffRows } from './ui/Section';
import { base, enc, ErrorBox, tx, useResource, type Item } from './researchShared';

export function ResearchCheckDetails({ runId, projectId, checkId, observation, close }: {
  runId: string; projectId?: string; checkId: string; observation?: ResearchObservationRef; close?(): void;
}) {
  const query = new URLSearchParams({ check: checkId, ...(projectId ? { project: projectId } : {}),
    ...(observation ? { at: String(observation.sequence), atState: observation.stateDigest } : {}) });
  const resource = useResource<Item<ResearchJourneyCheck>>(`${base}/workspace/problem/${enc(runId)}/journey/check?${query}`), data = resource.data?.item;
  const [view, setView] = useState<'diagnostics' | 'source' | 'diff'>('diagnostics'), [file, setFile] = useState(''), [line, setLine] = useState(0);
  const [sourceVersion, setSourceVersion] = useState<'checked' | 'previous'>('checked');
  const sourceRoot = useRef<HTMLDivElement>(null);
  useEffect(() => { setView('diagnostics'); setFile(''); setLine(0); setSourceVersion('checked'); }, [runId, checkId, observation?.sequence, observation?.stateDigest]);
  useEffect(() => {
    if (view !== 'source' || !line) return;
    const target = sourceRoot.current?.querySelector<HTMLElement>(`[data-check-source-line="${line}"]`);
    target?.scrollIntoView({ block: 'nearest' }); target?.focus({ preventScroll: true });
  }, [view, file, line]);
  const checkedFiles = data?.source ? [{ file: data.source.source.file, source: data.source.source.source }, ...(data.source.source.dependencySources ?? [])] : [];
  const displayedSource = sourceVersion === 'previous' ? data?.previous : data?.source;
  const files = displayedSource ? [{ file: displayedSource.source.file, source: displayedSource.source.source }, ...(displayedSource.source.dependencySources ?? [])] : [];
  const selectedFile = files.find(item => item.file === file) ?? files[0];
  const output = useMemo(() => data ? diagnostics(data.receipt.record) : [], [data]);
  const messages = useMemo(() => [...new Map(output.flatMap(item => leanMessages(item.text)).map(item => [`${item.file}:${item.line}:${item.column}:${item.text}`, item])).values()], [output]);
  const comparison = useMemo(() => data?.source && data.previous ? compareSources(data.previous.source.source, data.source.source.source) : undefined, [data]);
  const reason = data && checkReason({ ...(data.receipt.record.skipped === true ? { skipped: true } : {}),
    ...(typeof data.receipt.record.reason === 'string' ? { reason: data.receipt.record.reason } : {}) });
  return <section class="research-check-reader" data-research-check={checkId}>
    <header><h3>{tx('检查与修正线索', 'Check and repair details')}</h3>{close && <button type="button" class="text-button" onClick={close}>{tx('关闭检查详情', 'Close check details')}</button>}</header>
    <ErrorBox message={resource.error} />{resource.error && <button type="button" class="button" onClick={resource.refresh}>{tx('重新读取', 'Try again')}</button>}
    {!data && !resource.error && <p role="status">{tx('正在读取这份检查的固定源码与诊断…', 'Loading the source and diagnostics for this exact check…')}</p>}
    {data && <><p class="research-check-outcome" data-check-passed={data.receipt.record.passed === true}>{data.receipt.record.passed === true ? tx('这一任务版本检查通过', 'This task version passed its check') : tx('这一任务版本检查未通过', 'This task version did not pass its check')}{reason && <> · {localizeMessage(reason)}</>}</p>
      <p class="research-check-version">{tx('任务版本', 'Task version')} <code>{data.receipt.taskVersion.slice(0, 12)}</code> · Commit <code>{data.receipt.commit.slice(0, 12)}</code></p>
      <div class="research-actions" role="group" aria-label={tx('检查阅读方式', 'Check reading mode')}>
        <button type="button" class="button" aria-pressed={view === 'diagnostics'} onClick={() => setView('diagnostics')}>{tx('诊断说明', 'Diagnostics')}</button>
        {data.source && <button type="button" class="button" data-check-open-source aria-pressed={view === 'source'} onClick={() => { setSourceVersion('checked'); setView('source'); }}>{tx('查看对应源码', 'Read checked source')}</button>}
        {data.previous && <button type="button" class="button" data-check-open-diff aria-pressed={view === 'diff'} onClick={() => setView('diff')}>{tx('对比前一保存版本', 'Compare previous saved version')}</button>}
      </div>
      {view === 'diagnostics' && <div data-check-diagnostics>
        {messages.map((message, index) => {
          const target = checkedFiles.find(item => sameLeanFile(message.file, item.file));
          const readable = target && message.line >= 1 && message.line <= shownLines(target.source).length;
          return <article key={index} class="research-check-message" data-severity={message.severity}>
            <h4>{message.severity === 'error' ? tx('错误', 'Error') : message.severity === 'warning' ? tx('警告', 'Warning') : tx('说明', 'Information')}</h4>
            <pre><code>{message.text}</code></pre>
            {readable ? <button type="button" class="text-button" data-check-source-location onClick={() => { setSourceVersion('checked'); setFile(target.file); setLine(message.line); setView('source'); }}>{target.file}:{message.line}:{message.column} →</button>
              : <p>{message.file}:{message.line}:{message.column} · {tx('这份回执未保存该位置的可读源码', 'Readable source for this location was not saved with this receipt')}</p>}
          </article>;
        })}
        {!messages.length && output.map((item, index) => <section key={index}><h4>{localizeMessage(item.label)}</h4><pre><code>{item.text}</code></pre>{item.truncated && <p>{tx('这里只展示了部分输出。', 'Only part of the output is shown here.')}</p>}</section>)}
        {!output.length && <p>{data.receipt.record.passed === true ? tx('回执未另附诊断正文。检查通过只适用于上方的任务与源码版本。', 'The receipt has no additional diagnostic output. The passing result applies only to this task and source version.')
          : tx('这份回执没有保存可读错误正文。可以核对源码和完整回执，再决定怎样修改。', 'No readable error output was saved. Review the source and full receipt before deciding what to change.')}</p>}
        {messages.length > 0 && <details><summary>{tx('完整诊断输出', 'Full diagnostic output')}</summary>{output.map((item, index) => <section key={index}><h4>{localizeMessage(item.label)}</h4><pre><code>{item.text}</code></pre></section>)}</details>}
      </div>}
      {view === 'source' && selectedFile && <div ref={sourceRoot} data-check-source>
        {data.previous && <label>{tx('保存版本', 'Saved version')}<select data-check-source-version value={sourceVersion} onChange={event => { setSourceVersion(event.currentTarget.value as 'checked' | 'previous'); setFile(''); setLine(0); }}><option value="checked">{tx('本次受检源码', 'Source checked this time')}</option><option value="previous">{tx('前一保存版本', 'Previous saved source')}</option></select></label>}
        {files.length > 1 && <label>{tx('源码文件', 'Source file')}<select value={selectedFile.file} onChange={event => { setFile(event.currentTarget.value); setLine(0); }}>{files.map(item => <option key={item.file} value={item.file}>{item.file}</option>)}</select></label>}
        <p>{selectedFile.file} · <code>{displayedSource?.ref.commit.slice(0, 12)}</code></p><ol class="research-check-source-lines">{shownLines(selectedFile.source).map((text, index) => <li key={index} data-check-source-line={index + 1} tabIndex={-1} aria-current={line === index + 1 ? 'location' : undefined}><span aria-hidden="true">{index + 1}</span><code>{text || ' '}</code></li>)}</ol>
      </div>}
      {view === 'diff' && comparison && <section data-check-diff><p>{tx('比较同一环境下此前保存的源码与本次受检源码；差异本身不说明修改原因。', 'Compares the preceding saved source in the same environment with the checked source. Differences alone do not establish why a change was made.')}</p>
        <p><code>{data.previous?.ref.commit.slice(0, 12)}</code> → <code>{data.receipt.commit.slice(0, 12)}</code></p>
        {comparison.status === 'identical' ? <p>{tx('两份源码内容相同。', 'The two source texts are identical.')}</p> : comparison.status === 'unavailable' ? <p>{tx('这两份源码较长，无法在此生成行对比。可分别查看保存版本。', 'These sources are too large for an inline comparison. Read the saved versions separately.')}</p>
          : <><p>{tx(`新增 ${comparison.added} 行，移除 ${comparison.removed} 行。`, `${comparison.added} lines added, ${comparison.removed} lines removed.`)}</p><div class="research-check-diff-scroll"><table class="source-diff"><thead><tr><th>{tx('之前', 'Before')}</th><th>{tx('本次', 'This version')}</th><th>{tx('源码变化', 'Source changes')}</th></tr></thead><tbody><DiffRows rows={comparison.rows} /></tbody></table></div>{comparison.omittedLines > 0 && <p>{tx('较长的差异已截取，完整源码见上方入口。', 'The long diff is truncated. Use the source view for the full text.')}</p>}</>}</section>}
      {!data.source && <p>{tx('未找到与此回执完全对应的固定源码。仍可阅读已保存的诊断与回执。', 'No frozen source exactly matches this receipt. Its saved diagnostics and receipt remain readable.')}</p>}
      <details class="research-check-raw"><summary>{tx('完整检查回执', 'Full check receipt')}</summary><pre><code>{JSON.stringify(data.receipt, null, 2)}</code></pre></details>
    </>}
  </section>;
}
