import { useState } from 'preact/hooks';
import type { ResearchFeedback, ResearchProjectDetail, ResearchRunBinding, ResearchWorkImpact, ResearchWorkImpactItem } from '../researchProjectTypes';
import { RichProse } from './richText';
import { base, enc, ErrorBox, Field, MutationState, stamp, theoremHref, tx, useMutation, useResource } from './researchShared';
import './researchCandidateContinuity.css';

export function ResearchWorkImpactView({ project, binding, refresh, onRevealFeedback, plannedTaskIds }: {
  project: ResearchProjectDetail; binding: ResearchRunBinding; refresh(): void; onRevealFeedback(id: string): void; plannedTaskIds?: string[];
}) {
  const preview = plannedTaskIds !== undefined;
  const resource = useResource<ResearchWorkImpact>(project.permissions.member ? `${base}/theorems/${enc(project.id)}/runs/${enc(binding.runId)}/work-impact${preview ? `?taskIds=${enc(plannedTaskIds.join(','))}` : ''}` : undefined, preview ? undefined : 10000);
  if (!project.permissions.member) return null;
  return <section class="research-work-impact" id={preview ? undefined : 'work-impact'} data-work-impact={preview ? 'preview' : 'current'}><h3>{preview ? tx('这次调整会影响哪些人工工作', 'Human work affected by this change') : tx('人工工作接续', 'Continue human work after changes')}</h3>
    {!resource.data && !resource.error && <p role="status">{tx('正在核对任务版本与人工工作…', 'Checking task versions against human work…')}</p>}
    {resource.data?.items.map(item => <WorkImpactItem key={item.id} item={item} projectId={project.id} preview={preview} onSaved={feedback => { resource.refresh(); refresh(); if (feedback) onRevealFeedback(feedback.id); }} />)}
    {resource.data && !resource.data.items.length && <p>{tx('当前没有需要接续的旧版本工作。', 'No work from an older version needs to be continued.')}</p>}
    <ErrorBox message={resource.error} />{resource.error && <button class="text-button" type="button" onClick={resource.refresh}>{tx('重新核对影响', 'Check the impact again')}</button>}
  </section>;
}

function WorkImpactItem({ item, projectId, preview, onSaved }: { item: ResearchWorkImpactItem; projectId: string; preview: boolean; onSaved(feedback?: ResearchFeedback): void }) {
  const [source, setSource] = useState(item.source ?? ''), [text, setText] = useState(''), [confirmed, setConfirmed] = useState(''), [responses, setResponses] = useState<Record<string, string>>({}), action = useMutation();
  const signature = JSON.stringify([item.revision, item.currentTarget, item.currentSource?.commit, item.currentSource?.sourceDigest]), checked = confirmed === signature;
  const label = item.kind === 'claim' ? tx('任务认领', 'Task claim') : item.kind === 'candidate' ? tx('候选证明', 'Candidate proof') : item.kind === 'review' ? tx('候选评审', 'Candidate review') : tx('任务交接', 'Task handoff');
  const reason = item.reason === 'task-changed' ? tx('任务版本已改变', 'The task version changed') : item.reason === 'task-removed' ? tx('任务已移除', 'The task was removed')
    : item.reason === 'source-changed' ? tx('源码基准已改变', 'The source baseline changed') : tx('计划调整会影响此任务', 'The plan change affects this task');
  function send(operation: 'continue' | 'end') {
    if (!checked || !text.trim()) return;
    void action.run<{ impact: ResearchWorkImpact; feedback?: ResearchFeedback }>('POST', `${base}/theorems/${enc(projectId)}/work-continuations`, {
      kind: item.kind, recordId: item.recordId, action: operation, text, expectedRevision: item.revision,
      ...(operation === 'continue' && item.currentTarget ? { target: item.currentTarget } : {}),
      ...(operation === 'continue' && item.kind === 'candidate' ? { source, responses: (item.comments ?? []).map(comment => ({ commentId: comment.id, text: responses[comment.id] ?? '' })) } : {}),
    }, result => onSaved(result.feedback));
  }
  return <article class="research-work-impact-item" data-work-impact-item={item.id}><p><strong>{label}</strong> · {item.author.displayName} · {reason}</p>
    <p>{tx('原任务：', 'Original task: ')}<code>{item.target.taskRef?.id} · {item.target.taskRef?.version}</code></p>
    {item.currentTarget?.taskRef && <p>{tx('当前任务：', 'Current task: ')}<code>{item.currentTarget.taskRef.id} · {item.currentTarget.taskRef.version}</code></p>}
    <a href={`${theoremHref(projectId, item.target.runId, { statementVersionId: item.target.statementVersionId, taskRef: item.target.taskRef })}#collaboration-task-workspace`}>{tx('查看原工作上下文', 'Open the original work context')}</a>
    {item.continuation ? <div class="collaboration-resolution" data-work-continuation-history><p>{item.continuation.actor.displayName} · {stamp(item.continuation.createdAt)} · {item.continuation.action === 'end' ? tx('已结束旧工作', 'Older work ended') : tx('已记录接续', 'Continuation recorded')}</p><RichProse text={item.continuation.text} />
      {item.continuation.feedbackId && <a href={`${theoremHref(projectId, item.currentTarget?.runId ?? item.target.runId)}#feedback-${item.continuation.feedbackId}`}>{tx('查看接续后的候选', 'Open the continued candidate')}</a>}</div>
      : !preview && (item.canContinue || item.canEnd) && <details><summary>{tx('核对后处理这项工作', 'Review and handle this work')}</summary><form class="research-form" onSubmit={event => { event.preventDefault(); send('continue'); }}>
        {item.currentSource && <details><summary>{tx('当前源码基准', 'Current source baseline')}</summary><p><code>{item.currentSource.commit}</code></p><pre class="research-block-code">{item.currentSource.source}</pre></details>}
        {item.kind === 'candidate' && item.canContinue && <label>{tx('接续到新基准的候选源码', 'Candidate source for the new baseline')}<textarea data-work-next-source value={source} rows={8} required onInput={event => setSource(event.currentTarget.value)} /></label>}
        {item.kind === 'candidate' && item.comments?.map(comment => <label key={comment.id}><RichProse text={comment.text} /><textarea data-work-review-response={comment.id} required rows={2} maxLength={4000} value={responses[comment.id] ?? ''} onInput={event => setResponses(value => ({ ...value, [comment.id]: event.currentTarget.value }))} /></label>)}
        <Field label={tx('接续或结束的说明', 'Reason for continuing or ending')} value={text} onInput={setText} multiline required maxLength={4000} />
        <label class="work-impact-confirm"><input type="checkbox" data-work-confirm checked={checked} onChange={event => setConfirmed(event.currentTarget.checked ? signature : '')} />{tx('已核对这项旧工作和当前任务', 'I reviewed this older work and the current task')}</label>
        {item.canContinue && <>
          {item.kind === 'review' && <p>{tx('将请原作者提交新版候选；原候选与旧评审保留。', 'The author will be asked to submit a new candidate. The original candidate and review are retained.')}</p>}
          <button class="button" type="submit" data-continue-work disabled={action.busy || !checked}>{item.kind === 'candidate' ? tx('接续为新候选并检查', 'Continue as a new candidate and check') : item.kind === 'review' ? tx('请求新版候选后继续评审', 'Request a new candidate to continue review') : tx('接续当前任务版本', 'Continue with the current task version')}</button></>}
        {item.canEnd && <button class="text-button" type="button" data-end-work disabled={action.busy || !text.trim() || !checked} onClick={() => send('end')}>{tx('结束这项旧工作', 'End this older work')}</button>}
        <MutationState action={action} />
      </form></details>}
  </article>;
}
