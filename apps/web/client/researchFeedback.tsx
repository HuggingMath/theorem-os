import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ResearchFeedback, ResearchFeedbackTarget, ResearchProjectDetail } from '../researchProjectTypes';
import { RichProse } from './richText';
import { DiscussionGuidance } from './researchDiscussionGuidance';
import { feedbackNeedsAttention, matchesFeedbackQuery, matchesFeedbackScope, matchesFeedbackStatus,
  type FeedbackScope, type FeedbackStatus, type FeedbackTask } from './researchFeedbackModel';
import { base, enc, Empty, Field, MutationState, nameOf, personHref, stamp, State, Tags, theoremHref, tx, useMutation, lines, type Item } from './researchShared';

type TaskRef = { id: string; version: string };
export type OpenFeedbackTask = (target: ResearchFeedbackTarget, task: TaskRef) => void;
export type FeedbackFocus = { id: string; request: number };
const statuses: [FeedbackStatus, string, string][] = [
  ['all', '全部状态', 'All statuses'], ['attention', '需要关注', 'Needs attention'], ['pending', '等待判断', 'Awaiting a decision'],
  ['accepted', '已采纳', 'Accepted'], ['executing', '执行中', 'Executing'], ['completed', '执行已完成', 'Execution completed'],
];

export function TaskFeedbackContext({ project, runId, task, onBrowse }: {
  project: ResearchProjectDetail; runId: string; task?: FeedbackTask; onBrowse: () => void;
}) {
  const related = project.feedback.filter(item => matchesFeedbackScope(item, 'task', runId, task));
  return <div class="research-feedback-context" data-feedback-task-context>
    <div><span class="research-field-note">{tx('当前查看的节点', 'Node being viewed')}</span>
      <strong>{task ? task.taskId : tx('选择路线中的节点', 'Select a node in the route')}</strong>
      {task && <span class="research-feedback-version" title={task.taskVersion}>{task.taskVersion}</span>}</div>
    <div><span class="research-status">{tx(`${related.length} 条关联反馈 · ${related.filter(feedbackNeedsAttention).length} 条需要关注`, `${related.length} linked feedback · ${related.filter(feedbackNeedsAttention).length} need attention`)}</span>
      <button type="button" class="text-button" disabled={!task} onClick={onBrowse}>{tx('查看此节点反馈', 'View feedback for this node')}</button></div>
  </div>;
}

export function FeedbackWorkspace({ project, selfId, runId, task, refresh, onOpenTask, focus, browseTask, onRevealFeedback, children }: {
  selfId: string;
  project: ResearchProjectDetail; runId?: string; task?: FeedbackTask; refresh: () => void; onOpenTask: OpenFeedbackTask;
  focus?: FeedbackFocus; browseTask: number; onRevealFeedback: (id: string) => void; children?: ComponentChildren;
}) {
  const [scope, setScope] = useState<FeedbackScope>('all'), [status, setStatus] = useState<FeedbackStatus>('all'), [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null), focused = useRef(''), browsed = useRef(browseTask);
  const currentTask = task?.runId === runId ? task : undefined;
  const scoped = project.feedback.filter(item => matchesFeedbackScope(item, scope, runId, currentTask));
  const visible = scoped.filter(item => matchesFeedbackStatus(item, status) && matchesFeedbackQuery(item, query));
  const visibleIds = new Set(visible.map(item => item.id));
  useEffect(() => {
    if (browsed.current === browseTask) return;
    browsed.current = browseTask; setScope('task'); setStatus('all'); setQuery('');
    root.current?.scrollIntoView({ block: 'start' });
    root.current?.querySelector<HTMLSelectElement>('[data-feedback-scope]')?.focus({ preventScroll: true });
  }, [browseTask]);
  useEffect(() => {
    const id = focus?.id ?? project.feedback.find(item => location.hash === `#feedback-${enc(item.id)}`)?.id;
    const key = JSON.stringify([id, focus?.request]);
    if (!id || focused.current === key || !project.feedback.some(item => item.id === id)) return;
    focused.current = key; setScope('all'); setStatus('all'); setQuery('');
    const frame = requestAnimationFrame(() => {
      const row = document.getElementById(`feedback-${id}`);
      row?.scrollIntoView({ block: 'start' }); row?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, project.feedback]);
  return <div ref={root} data-research-feedback-workspace>
    <div class="research-feedback-filters">
      <label>{tx('反馈范围', 'Feedback scope')}<select data-feedback-scope value={scope} onChange={event => setScope(event.currentTarget.value as FeedbackScope)}>
        <option value="all">{tx('整个定理', 'Entire theorem')}</option><option value="run" disabled={!runId}>{tx('当前运行', 'Current run')}</option>
        <option value="task" disabled={!currentTask}>{tx('当前节点版本', 'Current node version')}</option></select></label>
      <label>{tx('处理状态', 'Processing status')}<select data-feedback-status value={status} onChange={event => setStatus(event.currentTarget.value as FeedbackStatus)}>
        {statuses.map(([value, zh, en]) => <option key={value} value={value}>{tx(zh, en)}</option>)}</select></label>
      <label>{tx('搜索反馈与证据', 'Search feedback and evidence')}<input data-feedback-search type="search" value={query} maxLength={200}
        onInput={event => setQuery(event.currentTarget.value)} placeholder={tx('作者、建议、节点或证据', 'Author, suggestion, node or evidence')} /></label>
    </div>
    <div class="research-feedback-summary" data-feedback-summary aria-label={tx('反馈处理概览', 'Feedback overview')}>
      {statuses.filter(([value]) => ['attention', 'pending', 'executing', 'completed'].includes(value)).map(([value, zh, en]) =>
        <button type="button" key={value} aria-pressed={status === value} onClick={() => setStatus(status === value ? 'all' : value)}>
          <strong>{scoped.filter(item => matchesFeedbackStatus(item, value)).length}</strong><span>{tx(zh, en)}</span></button>)}
    </div>
    <p class="research-status" role="status" aria-live="polite">{tx(`显示 ${visible.length} / ${scoped.length} 条反馈`, `Showing ${visible.length} of ${scoped.length} feedback`)}
      {scope === 'task' && currentTask && <> · {currentTask.taskId} · <code>{currentTask.taskVersion}</code></>}</p>
    {children}
    {project.feedback.slice().reverse().map(feedback => <Feedback key={feedback.id} feedback={feedback} project={project} refresh={refresh}
      selfId={selfId} runId={runId} hidden={!visibleIds.has(feedback.id)} onOpenTask={onOpenTask} onRevealFeedback={onRevealFeedback} />)}
    {!visible.length && <Empty>{project.feedback.length ? tx('当前范围和条件下没有反馈。', 'No feedback matches this scope and filters.') : tx('尚无讨论或干预记录。', 'No discussion or intervention records yet.')}</Empty>}
  </div>;
}

function TaskLink({ projectId, target, task, execution, onOpenTask }: {
  projectId: string; target: ResearchFeedbackTarget; task: TaskRef; execution?: boolean; onOpenTask: OpenFeedbackTask;
}) {
  return <span class="research-feedback-task-link"><a class="research-inline-link" href={theoremHref(projectId, target.runId, { statementVersionId: target.statementVersionId, taskRef: task })}
    onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpenTask(target, task); }}>
    {execution ? tx('查看执行节点', 'View execution node') : tx('查看对应节点', 'View corresponding node')}
    </a>{execution && <span> · {task.id} · {task.version.slice(0, 12)}</span>}</span>;
}

function Feedback({ feedback, project, selfId, runId, refresh, hidden, onOpenTask, onRevealFeedback }: {
  selfId: string; runId?: string;
  feedback: ResearchFeedback; project: ResearchProjectDetail; refresh: () => void; hidden: boolean; onOpenTask: OpenFeedbackTask; onRevealFeedback: (id: string) => void;
}) {
  const permission = feedback.kind === 'guidance' ? 'guidance' : feedback.kind === 'plan-approval' ? 'approve' : feedback.kind === 'proof-submission' ? 'proof' : 'edit';
  const canDecide = project.permissions.edit && (!feedback.target || Boolean(project.runs.find(item => item.runId === feedback.target!.runId)?.permissions[permission]));
  const source = feedback.sourceFeedbackId && project.feedback.find(item => item.id === feedback.sourceFeedbackId);
  const forwarded = project.feedback.filter(item => item.sourceFeedbackId === feedback.id);
  const canForward = feedback.kind === 'discussion' && Boolean(selfId) && project.runs.some(run => run.permissions.guidance && run.status === 'running');
  const [opened, setOpened] = useState(false);
  return <article class="research-event research-feedback-event" id={`feedback-${feedback.id}`} tabIndex={-1} hidden={hidden}>
    <div class="research-item-meta">{source && <span>{tx('投递人', 'Forwarded by')}</span>}<a href={personHref(feedback.author.id)}>{feedback.author.displayName}</a><span>{nameOf(feedback.kind)}</span><time dateTime={feedback.createdAt}>{stamp(feedback.createdAt)}</time><State value={feedback.visibility} /></div>
    <div class="research-description"><RichProse text={feedback.text} /></div>
    <ol class="research-feedback-states" aria-label={tx('反馈处理进展', 'Feedback processing progress')}>
      <li><span>{tx('1 · 投递', '1 · Delivery')}</span><State value={feedback.delivery.status} />{feedback.delivery.reason && <span>{feedback.delivery.reason}</span>}</li>
      <li><span>{tx('2 · 采纳判断', '2 · Decision')}</span><State value={feedback.decision.status} />{feedback.decision.reason && <span>{feedback.decision.reason}</span>}
        {feedback.decision.actor && <span>{feedback.decision.actor.displayName} · {feedback.decision.actor.kind === 'agent' ? 'Agent' : tx('数学家', 'Mathematician')}</span>}</li>
      <li><span>{tx('3 · 执行', '3 · Execution')}</span><State value={feedback.execution.status} /></li>
    </ol>
    {feedback.target && <div class="research-item-meta"><a href={theoremHref(project.id, feedback.target.runId, { statementVersionId: feedback.target.statementVersionId })}>{tx('对应运行', 'Related run')}</a>
      <span>{tx('观测', 'Observation')} #{feedback.target.observationRef.sequence}</span>{feedback.target.taskRef && <><span>{feedback.target.taskRef.id} · {feedback.target.taskRef.version.slice(0, 12)}</span>
        <TaskLink projectId={project.id} target={feedback.target} task={feedback.target.taskRef} onOpenTask={onOpenTask} /></>}</div>}
    {source && <div class="research-feedback-source" data-feedback-source><span class="research-field-note">{tx('原建议作者：', 'Original author: ')}<a href={personHref(source.author.id)}>{source.author.displayName}</a></span>
      <a class="research-inline-link" href={`#feedback-${enc(source.id)}`} onClick={event => { event.preventDefault(); onRevealFeedback(source.id); }}>{tx('查看原始建议', 'View original suggestion')}</a>
      <details><summary>{tx('原始建议内容', 'Original suggestion text')}</summary><div class="research-description"><RichProse text={source.text} /></div></details></div>}
    {forwarded.length > 0 && <div class="research-feedback-forwards" data-feedback-forwards><p class="research-field-note">{tx('由此建议转投的指导', 'Guidance forwarded from this suggestion')}</p>
      <ul>{forwarded.map(item => <li key={item.id}><a class="research-inline-link" href={`#feedback-${enc(item.id)}`} onClick={event => { event.preventDefault(); onRevealFeedback(item.id); }}>{tx('查看指导', 'View guidance')}</a>
        <span> · {item.author.displayName} · {project.runs.find(run => run.runId === item.target?.runId)?.title ?? tx('对应运行', 'Related run')} · {item.target?.taskRef?.id ?? 'Lead'} · </span><State value={item.delivery.status} /></li>)}</ul></div>}
    {feedback.execution.planVersion && <p class="research-status">{tx('对应计划：', 'Plan: ')}{feedback.execution.planVersion}</p>}
    {feedback.target && feedback.execution.taskRefs.length > 0 && <div class="research-actions research-feedback-results">{feedback.execution.taskRefs.map(task =>
      <TaskLink key={`${task.id}:${task.version}`} projectId={project.id} target={feedback.target!} task={task} execution onOpenTask={onOpenTask} />)}</div>}
    {feedback.proofCheck && <p class="research-status">{tx('独立候选检查：', 'Independent candidate check: ')}<State value={feedback.proofCheck.status} /> · {feedback.proofCheck.receiptId}{feedback.proofCheck.reason ? ` · ${feedback.proofCheck.reason}` : ''}</p>}
    {(feedback.decision.evidenceRefs.length > 0 || feedback.execution.resultRefs.length > 0) && <details><summary>{tx('结果与证据引用', 'Result and evidence references')}</summary><Tags values={[...new Set([...feedback.decision.evidenceRefs, ...feedback.execution.resultRefs])]} /></details>}
    {canDecide && <details><summary>{tx('记录采纳决定', 'Record an adoption decision')}</summary><Decision projectId={project.id} feedback={feedback} refresh={refresh} /></details>}
    {(canForward || opened) && <details data-forward-discussion onToggle={event => { if (event.currentTarget.open) setOpened(true); }}><summary>{tx('转为运行指导', 'Forward to a run')}</summary>
      {opened && <DiscussionGuidance project={project} source={feedback} selfId={selfId} initialRunId={runId} refresh={refresh} onRevealFeedback={onRevealFeedback} />}</details>}
  </article>;
}

function Decision({ projectId, feedback, refresh }: { projectId: string; feedback: ResearchFeedback; refresh: () => void }) {
  const [status, setStatus] = useState('accepted'), [reason, setReason] = useState(''), [evidence, setEvidence] = useState(''), [planVersion, setPlanVersion] = useState(''), action = useMutation();
  const [revision, setRevision] = useState(feedback.revision);
  return <form class="research-form" onSubmit={event => { event.preventDefault(); void action.run<Item<ResearchFeedback>>('POST', `${base}/theorems/${enc(projectId)}/feedback/${enc(feedback.id)}/decision`,
    { status, reason, evidenceRefs: lines(evidence), ...(planVersion ? { planVersion } : {}), expectedRevision: revision }, result => { setRevision(result.item.revision); refresh(); }); }}>
    <label>{tx('决定', 'Decision')}<select value={status} onChange={event => setStatus(event.currentTarget.value)}><option value="accepted">{tx('采纳', 'Accept')}</option><option value="declined">{tx('未采纳', 'Decline')}</option><option value="needs-info">{tx('需要补充', 'Needs information')}</option></select></label>
    <Field label={tx('理由', 'Reason')} value={reason} onInput={setReason} multiline required rows={2} /><Field label={tx('关联计划版本（可选）', 'Related plan version (optional)')} value={planVersion} onInput={setPlanVersion} />
    <Field label={tx('证据引用，每行一项', 'Evidence references, one per line')} value={evidence} onInput={setEvidence} multiline rows={2} />
    {revision !== feedback.revision && <p class="research-status">{tx('反馈状态已有更新，你的草稿已保留。', 'Feedback has changed. Your draft is preserved.')} <button type="button" class="text-button" onClick={() => setRevision(feedback.revision)}>{tx('基于最新反馈提交', 'Use latest feedback revision')}</button></p>}
    <MutationState action={action} /><button type="submit" class="button" disabled={action.busy}>{tx('保存决定', 'Save decision')}</button>
  </form>;
}
