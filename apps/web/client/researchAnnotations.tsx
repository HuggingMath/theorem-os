import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ResearchAnnotationAnchor, ResearchAnnotationPage, ResearchAnnotationView } from '../researchProjectTypes';
import type { ResearchDraftValues } from '../researchPersonalTypes';
import { RichProse } from './richText';
import { base, enc, ErrorBox, Field, MutationState, stamp, tx, useMutation, useResource, type Item } from './researchShared';
import { ResearchDraftPicker } from './researchDrafts';
import { useResearchInputDraft } from './researchInputDraft';
import './researchInlineActions.css';

const fieldName = (field: string) => ({ objective: tx('任务目标', 'Objective'), statement: tx('数学陈述', 'Statement'), premises: tx('前提', 'Premises'),
  derivation: tx('推导', 'Derivation'), finding: tx('结论', 'Finding'), feedback: tx('尚待解决', 'Open feedback') })[field] ?? field;

export function AnnotationAnchorSummary({ anchor }: { anchor?: ResearchAnnotationAnchor }) {
  if (!anchor) return null;
  return <div class="research-annotation-anchor" data-annotation-anchor-kind={anchor.kind}>
    <p>{anchor.kind === 'source' ? `${anchor.file} · ${tx(`第 ${anchor.startLine}–${anchor.endLine} 行`, `lines ${anchor.startLine}–${anchor.endLine}`)}` : fieldName(anchor.field)}
      {' · '}<code>{(anchor.kind === 'source' ? anchor.sourceDigest : anchor.fieldDigest).slice(0, 12)}</code></p>
    {anchor.kind === 'source' ? <pre class="research-block-code">{anchor.quote}</pre> : <blockquote><RichProse text={anchor.quote} /></blockquote>}
  </div>;
}

type AnnotationProps = { runId: string; projectId?: string; task: { id: string; version: string }; feedbackId?: string; commit?: string; selfId?: string; refresh?(): void; focusAnnotationId?: string };
export function ResearchAnnotations(props: AnnotationProps) {
  return <ResearchAnnotationsEditor key={JSON.stringify([props.selfId, props.projectId, props.runId, props.task.id, props.task.version, props.feedbackId, props.commit])} {...props} />;
}
function ResearchAnnotationsEditor({ runId, projectId, task, feedbackId, commit, selfId = '', refresh, focusAnnotationId }: AnnotationProps) {
  const endpoint = `${base}/${projectId ? `theorems/${enc(projectId)}/` : ''}runs/${enc(runId)}/annotations`;
  const query = new URLSearchParams({ task: task.id, taskVersion: task.version, ...(feedbackId ? { feedback: feedbackId } : {}), ...(commit ? { commit } : {}) });
  const resource = useResource<ResearchAnnotationPage>(`${endpoint}?${query}`, 10000), data = resource.data;
  const scope = { runId, taskId: task.id, taskVersion: task.version, ...(commit ? { commit } : {}), ...(feedbackId ? { sourceFeedbackId: feedbackId } : {}) };
  const input = useResearchInputDraft<ResearchDraftValues['annotation']>(selfId, projectId, 'annotation', scope, { text: '', observationRef: { sequence: 0, stateDigest: '' } });
  const storedAnchor = input.value.anchor, text = input.value.text;
  const [mode, setMode] = useState<'source' | 'mathematics'>(storedAnchor?.kind ?? 'mathematics'), [fieldChoice, setField] = useState(storedAnchor?.kind === 'mathematics' ? storedAnchor.field : ''),
    [first, setFirst] = useState(storedAnchor?.kind === 'source' ? storedAnchor.startLine : 1), [last, setLast] = useState(storedAnchor?.kind === 'source' ? storedAnchor.endLine : 1);
  const [sourceSelection, setSourceSelection] = useState(storedAnchor?.kind === 'source' ? storedAnchor.sourceDigest : ''), [sourcePage, setSourcePage] = useState(0);
  const [selection, setSelection] = useState<{ digest: string; start: number; end: number } | undefined>(storedAnchor?.kind === 'mathematics' ? { digest: storedAnchor.fieldDigest, start: storedAnchor.startOffset, end: storedAnchor.endOffset } : undefined),
    [opened, setOpened] = useState(Boolean(text)), action = useMutation();
  const root = useRef<HTMLElement>(null), revealed = useRef('');
  const context = data?.context, selectedField = context?.fields.find(field => field.field === fieldChoice) ?? context?.fields[0];
  const lines = useMemo(() => context?.source?.source.split('\n') ?? [], [context?.source?.source]), pageStart = sourcePage < lines.length ? sourcePage : 0;
  const anchor: ResearchAnnotationAnchor | undefined = mode === 'source' && context?.source && sourceSelection === context.source.sourceDigest && first > 0 && last >= first && last <= lines.length
    ? { kind: 'source', file: context.source.file, sourceDigest: context.source.sourceDigest, startLine: first, endLine: last, quote: lines.slice(first - 1, last).join('\n') }
    : mode === 'mathematics' && selectedField && selection?.digest === selectedField.digest && selection.end > selection.start
      ? { kind: 'mathematics', field: selectedField.field, fieldDigest: selectedField.digest, startOffset: selection.start, endOffset: selection.end, quote: selectedField.text.slice(selection.start, selection.end) } : undefined;
  const save = () => { resource.refresh(); refresh?.(); };
  const persist = (value: { text?: string; anchor?: ResearchAnnotationAnchor }) => {
    if (context) input.update({ text, ...(anchor ? { anchor } : {}), ...value, observationRef: context.target.observationRef });
  };
  const restoreAnchor = (restored?: ResearchAnnotationAnchor) => {
    setMode(restored?.kind ?? 'mathematics'); setOpened(true);
    if (restored?.kind === 'source') { setFirst(restored.startLine); setLast(restored.endLine); setSourceSelection(restored.sourceDigest); setSourcePage(Math.floor((restored.startLine - 1) / 240) * 240); }
    else { setField(restored?.field ?? ''); setSelection(restored ? { digest: restored.fieldDigest, start: restored.startOffset, end: restored.endOffset } : undefined); }
  };
  const current = data?.items.filter(item => item.target.taskRef?.version === task.version) ?? [], historical = data?.items.filter(item => item.target.taskRef?.version !== task.version) ?? [];
  useEffect(() => {
    if (!focusAnnotationId || revealed.current === focusAnnotationId || !data?.items.some(item => item.id === focusAnnotationId)) return;
    const thread = root.current?.querySelector<HTMLElement>(`[data-annotation-thread="${CSS.escape(focusAnnotationId)}"]`); if (!thread) return;
    revealed.current = focusAnnotationId;
    let parent = thread.parentElement; while (parent && parent !== root.current) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
    requestAnimationFrame(() => { thread.scrollIntoView({ block: 'center' }); thread.focus({ preventScroll: true }); });
  }, [focusAnnotationId, data]);
  return <section ref={root} class="research-annotations" data-research-annotations>
    <h4>{feedbackId ? tx('对候选的具体片段批注', 'Comments on exact candidate passages') : tx('对这一步的具体片段批注', 'Comments on exact passages in this step')}</h4>
    <ErrorBox message={resource.error} />{resource.error && <button type="button" class="text-button" onClick={resource.refresh}>{tx('重新读取批注', 'Reload annotations')}</button>}
    {!data && !resource.error && <p role="status">{tx('正在读取原文与批注…', 'Loading the original text and annotations…')}</p>}
    {data && !data.items.length && <p class="research-status">{tx('还没有片段批注。可以选中一条公式、推导中的原文或几行源码。', 'No passage comments yet. Select a formula, reasoning passage or source lines.')}</p>}
    {current.map(item => <AnnotationThread key={item.id} item={item} endpoint={endpoint} projectId={projectId} selfId={selfId} refresh={save} />)}
    {historical.length > 0 && <details data-annotations-older><summary>{tx(`历史任务版本的批注 · ${historical.length}`, `Comments on older task versions · ${historical.length}`)}</summary>
      {historical.map(item => <AnnotationThread key={item.id} item={item} endpoint={endpoint} projectId={projectId} selfId={selfId} refresh={save} />)}</details>}
    {data?.permissions.create && context && <details open={opened} onToggle={event => setOpened(event.currentTarget.open)}><summary>{tx('添加精确批注', 'Add a passage comment')}</summary>
      <ResearchDraftPicker drafts={input.drafts} filter={item => item.scope.runId === runId && item.scope.taskId === task.id && item.scope.taskVersion === task.version && (item.scope.commit ?? '') === (commit ?? '') && (item.scope.sourceFeedbackId ?? '') === (feedbackId ?? '')} onRestore={item => { input.restore(item); restoreAnchor(item.value.anchor); action.reset(); }} />
      <form class="research-form" onSubmit={event => { event.preventDefault(); if (!anchor?.quote.trim()) return; const submitted = input.drafts.current(), value = input.value;
        void action.run<Item<ResearchAnnotationView>>('POST', endpoint, { target: { observationRef: context.target.observationRef, taskRef: context.target.taskRef }, anchor, text, ...(feedbackId ? { feedbackId } : {}) }, result => {
          void input.complete(submitted, { kind: 'annotation', id: result.item.id }, value); save();
        }); }}>
        <p class="research-field-note">{tx('批注固定在当前显示的任务版本和原文；后续修订会保留位置并提示过期。', 'The comment stays attached to the displayed task version and original text. Later revisions retain its position and mark it as outdated.')} <code>{task.version.slice(0, 12)}</code></p>
        <div class="research-actions" role="group" aria-label={tx('批注对象', 'Annotation target')}><button type="button" class="button" data-annotation-kind="mathematics" aria-pressed={mode === 'mathematics'} onClick={() => { setMode('mathematics'); persist({ anchor: undefined }); }}>{tx('公式或推导', 'Formula or reasoning')}</button>
          <button type="button" class="button" data-annotation-kind="source" aria-pressed={mode === 'source'} disabled={!context.source} onClick={() => { setMode('source'); persist({ anchor: undefined }); }}>{tx('源码行', 'Source lines')}</button></div>
        {mode === 'mathematics' && <>{selectedField ? <><label>{tx('选择数学字段', 'Choose a mathematics field')}<select data-annotation-field value={selectedField.field} onChange={event => { setField(event.currentTarget.value); setSelection(undefined); persist({ anchor: undefined }); }}>
          {context.fields.map(field => <option key={field.field} value={field.field}>{fieldName(field.field)}</option>)}</select></label><RichProse text={selectedField.text} />
          <label>{tx('在原文中选中需要批注的片段', 'Select the passage in its original text')}<textarea class="research-annotation-original" data-annotation-original readOnly value={selectedField.text} rows={4} onSelect={event => {
            const start = event.currentTarget.selectionStart, end = event.currentTarget.selectionEnd; setSelection({ digest: selectedField.digest, start, end });
            persist({ anchor: { kind: 'mathematics', field: selectedField.field, fieldDigest: selectedField.digest, startOffset: start, endOffset: end, quote: selectedField.text.slice(start, end) } });
          }} /></label>
          <button type="button" class="text-button" data-annotation-whole-field onClick={() => { setSelection({ digest: selectedField.digest, start: 0, end: selectedField.text.length }); persist({ anchor: { kind: 'mathematics', field: selectedField.field, fieldDigest: selectedField.digest, startOffset: 0, endOffset: selectedField.text.length, quote: selectedField.text } }); }}>{tx('批注整个字段', 'Comment on the whole field')}</button></>
          : <p>{tx('这个快照没有可标注的数学文字。', 'This snapshot has no mathematics text to annotate.')}</p>}</>}
        {mode === 'source' && context.source && <><p><code>{context.source.file}</code> · <code>{context.source.sourceDigest.slice(0, 12)}</code></p>
          <div class="research-annotation-lines" role="group" aria-label={tx('选择源码行，按住 Shift 可扩选', 'Choose source lines; hold Shift to extend the range')}>
            {lines.slice(pageStart, pageStart + 240).map((line, offset) => { const index = pageStart + offset; return <button type="button" key={index} data-annotation-line={index + 1} aria-pressed={sourceSelection === context.source!.sourceDigest && index + 1 >= first && index + 1 <= last} onClick={event => {
              const line = index + 1, start = event.shiftKey && sourceSelection === context.source!.sourceDigest ? Math.min(first, line) : line, end = event.shiftKey && sourceSelection === context.source!.sourceDigest ? Math.max(first, line) : line;
              setSourceSelection(context.source!.sourceDigest); setFirst(start); setLast(end); persist({ anchor: { kind: 'source', file: context.source!.file, sourceDigest: context.source!.sourceDigest, startLine: start, endLine: end, quote: lines.slice(start - 1, end).join('\n') } });
            }}><span>{index + 1}</span><code>{line || ' '}</code></button>; })}</div>
          {lines.length > 240 && <div class="research-actions"><button type="button" class="text-button" disabled={pageStart === 0} onClick={() => setSourcePage(Math.max(0, pageStart - 240))}>{tx('前 240 行', 'Previous 240 lines')}</button><span>{pageStart + 1}–{Math.min(lines.length, pageStart + 240)} / {lines.length}</span><button type="button" class="text-button" disabled={pageStart + 240 >= lines.length} onClick={() => setSourcePage(pageStart + 240)}>{tx('后 240 行', 'Next 240 lines')}</button></div>}
          <div class="research-annotation-range"><label>{tx('起始行', 'First line')}<input data-annotation-start type="number" min={1} max={lines.length} value={first} onInput={event => { const start = Number(event.currentTarget.value); setFirst(start); setSourceSelection(context.source!.sourceDigest); persist({ anchor: start > 0 && last >= start ? { kind: 'source', file: context.source!.file, sourceDigest: context.source!.sourceDigest, startLine: start, endLine: last, quote: lines.slice(start - 1, last).join('\n') } : undefined }); }} /></label>
            <label>{tx('结束行', 'Last line')}<input data-annotation-end type="number" min={first} max={Math.min(lines.length, first + 199)} value={last} onInput={event => { const end = Number(event.currentTarget.value); setLast(end); setSourceSelection(context.source!.sourceDigest); persist({ anchor: end >= first ? { kind: 'source', file: context.source!.file, sourceDigest: context.source!.sourceDigest, startLine: first, endLine: end, quote: lines.slice(first - 1, end).join('\n') } : undefined }); }} /></label></div>
          {sourceSelection && sourceSelection !== context.source.sourceDigest && <p role="status">{tx('源码已有更新。批注内容保留，请在新显示的源码中重新选择片段。', 'The source changed. Your comment is retained; select its passage again in the displayed source.')}</p>}</>}
        {anchor?.quote.trim() && <div data-annotation-selection><strong>{tx('所选片段', 'Selected passage')}</strong><AnnotationAnchorSummary anchor={anchor} /></div>}
        <Field label={tx('这一步的疑问或修改建议', 'Question or suggested change for this passage')} value={text} onInput={text => persist({ text })} multiline required maxLength={4000} />
        <button type="submit" class="button" data-save-annotation disabled={action.busy || !anchor?.quote.trim()}>{feedbackId && data.permissions.review ? tx('保存批注并加入逐条评审', 'Save and add to the review comments') : tx('保存片段批注', 'Save passage comment')}</button><MutationState action={action} />
      </form></details>}
  </section>;
}

function AnnotationThread({ item, endpoint, projectId, selfId, refresh }: { item: ResearchAnnotationView; endpoint: string; projectId?: string; selfId: string; refresh(): void }) {
  const input = useResearchInputDraft(selfId, projectId, 'annotation-reply', { runId: item.target.runId, statementVersionId: item.target.statementVersionId,
    taskId: item.target.taskRef!.id, taskVersion: item.target.taskRef!.version, threadId: item.id, ...(item.feedbackId ? { sourceFeedbackId: item.feedbackId } : {}) }, { text: '' });
  const text = input.value.text, action = useMutation();
  const stale = item.staleReason === 'candidate-revised' ? tx('候选已有新修订', 'The candidate has a newer revision') : item.staleReason === 'task-changed' ? tx('任务版本已改变', 'The task version changed')
    : item.staleReason === 'source-changed' ? tx('当前源码已改变', 'The current source changed') : tx('当前数学原文已改变', 'The current mathematics text changed');
  return <article id={`annotation-${item.id}`} tabIndex={-1} class="research-annotation-thread" data-annotation-thread={item.id} data-annotation-stale={item.stale} data-annotation-status={item.status}>
    <p><strong>{item.author.displayName}</strong> · {stamp(item.createdAt)} · {item.status === 'resolved' ? tx('已解决', 'Resolved') : tx('待回应', 'Open')}</p>
    {item.stale && <p class="research-status" data-annotation-outdated>{stale} · {tx('批注仍指向下方原文，未移到新版本。', 'This comment still refers to the original passage below.')} <code>{item.target.taskRef?.version.slice(0, 12)}</code></p>}
    <AnnotationAnchorSummary anchor={item.anchor} /><RichProse text={item.text} />
    {item.replies.map(reply => <div class="research-annotation-reply" key={reply.id}><p>{reply.author.displayName} · {stamp(reply.createdAt)}</p><RichProse text={reply.text} /></div>)}
    {item.resolution && <p class="research-status">{item.resolution.actor.displayName} · {tx('标记已解决', 'Marked resolved')} · {stamp(item.resolution.createdAt)}{item.resolution.text && <> · {item.resolution.text}</>}</p>}
    {item.canReply && <><ResearchDraftPicker drafts={input.drafts} filter={draft => draft.scope.threadId === item.id && draft.scope.runId === item.target.runId && draft.scope.taskVersion === item.target.taskRef!.version} onRestore={input.restore} />
      <form class="research-form" onSubmit={event => { event.preventDefault(); const submitted = input.drafts.current(), value = input.value; void action.run('POST', `${endpoint}/${enc(item.id)}`, { action: 'reply', text, expectedRevision: item.revision }, () => { void input.complete(submitted, { kind: 'annotation-reply', id: item.id }, value); refresh(); }); }}>
      <Field label={tx('回应这条批注', 'Reply to this comment')} value={text} onInput={text => input.update({ text })} multiline rows={2} required maxLength={4000} /><button type="submit" class="button" data-reply-annotation disabled={action.busy}>{tx('保存回应', 'Save reply')}</button></form></>}
    {item.canResolve && <button class="text-button" type="button" data-resolve-annotation disabled={action.busy} onClick={() => void action.run('POST', `${endpoint}/${enc(item.id)}`, { action: item.status === 'resolved' ? 'reopen' : 'resolve', expectedRevision: item.revision }, refresh)}>{item.status === 'resolved' ? tx('重新打开', 'Reopen') : tx('标记已解决', 'Mark resolved')}</button>}
    <MutationState action={action} />
  </article>;
}
