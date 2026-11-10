import { useRef, useState } from 'preact/hooks';
import type { WebCommandResult, WebObservation, WebPlan } from '../collaboration';
import type { ResearchIssue } from '../researchCollaborationTypes';
import type { ResearchFeedback, ResearchFeedbackInput, ResearchProjectDetail } from '../researchProjectTypes';
import type { WebRun } from '../shared';
import { RichProse } from './richText';
import { ResearchWorkImpactView } from './researchWorkImpact';
import { api, base, enc, ErrorBox, errorText, Field, nameOf, ResearchHttpError, tx, useResource, type Item, type Items } from './researchShared';

type ExecutionInput = Extract<ResearchFeedbackInput, { kind: 'guidance' | 'plan-edit' | 'route-control' }>;
type Prepared = { input: ExecutionInput; planVersion?: string; receipt?: WebCommandResult };
const knownDelivery = (record: ResearchFeedback) => ['queued', 'delivered', 'deferred', 'failed'].includes(record.delivery.status);

/** An issue decision becomes an ordinary, version-bound feedback command only after an explicit confirmation. */
export function IssueExecution({ issue, project, selfId, refresh, onRevealFeedback }: {
  issue: ResearchIssue; project: ResearchProjectDetail; selfId: string; refresh(): void; onRevealFeedback(id: string): void;
}) {
  const [mode, setMode] = useState<'guidance' | 'plan-edit'>('guidance');
  const [runId, setRun] = useState(issue.target?.runId ?? project.runs.find(run => run.status === 'running' && run.permissions.guidance && (!issue.statementVersionId || run.statementVersionId === issue.statementVersionId))?.runId ?? '');
  const [taskId, setTask] = useState(issue.target?.taskRef?.id ?? ''), [text, setText] = useState(issue.resolution?.text ?? '');
  const [objective, setObjective] = useState(''), [dependencies, setDependencies] = useState(''), [editedTask, setEditedTask] = useState('');
  const [prepared, setPrepared] = useState<Prepared>(), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPendingState] = useState<ExecutionInput>(), [saved, setSaved] = useState<ResearchFeedback>();
  const [reviewedTask, setReviewedTask] = useState('');
  const pendingRef = useRef<ExecutionInput>(), lock = useRef(false), draftGeneration = useRef(0);
  const permission = mode === 'guidance' ? 'guidance' : 'edit';
  const runs = project.runs.filter(run => run.permissions[permission] && run.status === 'running' && (!issue.statementVersionId || run.statementVersionId === issue.statementVersionId) && (!issue.target || run.runId === issue.target.runId));
  const binding = runs.find(run => run.runId === runId);
  const resource = useResource<{ run?: WebRun; observation: WebObservation | null }>(binding ? `${base}/theorems/${enc(project.id)}/runs/${enc(runId)}/observation` : undefined, 5000);
  const observation = resource.data?.observation?.webRunId === runId ? resource.data.observation : undefined;
  const tasks = observation?.inspection.tasks ?? [], task = tasks.find(task => task.id === taskId);
  const planTask = observation?.plan?.tasks.find(task => task.id === taskId);
  const changedTaskVersion = Boolean(issue.target?.taskRef && task && task.version !== issue.target.taskRef.version);
  const targetStale = Boolean(issue.target?.taskRef && (!task || changedTaskVersion && reviewedTask !== JSON.stringify([task.id, task.version])));
  const active = Boolean(binding && resource.data?.run?.status === 'running' && observation && !resource.error && !targetStale);
  const origin = { issueId: issue.id, issueRevision: issue.revision, resolutionAt: issue.resolution!.createdAt, ...(issue.resolution?.proposalId ? { proposalId: issue.resolution.proposalId } : {}),
    ...(changedTaskVersion && !targetStale && task ? { reviewedTaskRef: { id: task.id, version: task.version } } : {}) };
  const linked = project.feedback.filter(item => item.issueSource?.issueId === issue.id);
  const invalidate = () => { draftGeneration.current++; setPrepared(undefined); setConfirmed(false); setError(''); };
  const setPending = (value?: ExecutionInput) => { pendingRef.current = value; setPendingState(value); };
  const resolve = (record: ResearchFeedback) => {
    setSaved(record); setError(''); if (knownDelivery(record)) { setPending(undefined); setPrepared(undefined); setConfirmed(false); }
    refresh();
  };
  async function findOriginal(input: ExecutionInput) {
    const result = await api<Items<ResearchFeedback>>(`${base}/theorems/${enc(project.id)}/feedback`);
    return result.items.find(item => item.requestId === input.requestId && item.author.id === selfId && item.issueSource?.issueId === issue.id);
  }
  async function post(input: ExecutionInput) {
    try { const result = await api<Item<ResearchFeedback>>(`${base}/theorems/${enc(project.id)}/feedback`, { method: 'POST', body: JSON.stringify(input) }); resolve(result.item); }
    catch (cause) {
      setError(errorText(cause));
      try {
        const record = await findOriginal(input);
        if (record) resolve(record);
        else if (cause instanceof ResearchHttpError && cause.status < 500) setPending(undefined);
      } catch { /* Keep the exact request available until its saved result can be checked. */ }
    }
  }
  async function prepare() {
    if (lock.current || !active || !observation || !binding || !text.trim() || text.length > 4000 || mode === 'plan-edit' && !planTask) return;
    lock.current = true; setBusy(true); setError(''); setConfirmed(false); const generation = draftGeneration.current;
    try {
      const target = { runId, statementVersionId: binding.statementVersionId, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest }, ...(task ? { taskRef: { id: task.id, version: task.version } } : {}) };
      if (mode === 'guidance') setPrepared({ input: { requestId: crypto.randomUUID(), kind: 'guidance', text, visibility: 'members', issueSource: origin, target, recipient: task ? { kind: 'task', id: task.id } : { kind: 'lead' } } });
      else {
        const current = observation.plan;
        if (!current || !planTask) return;
        const changed = editedTask === taskId;
        const proposal: WebPlan = { ...current, schema: 'deepscientist.math.plan-edit.v1', baseVersion: observation.inspection.planVersion ?? current.baseVersion,
          tasks: current.tasks.map(task => task.id === taskId ? { ...task, objective: changed ? objective : task.objective,
            dependsOn: changed ? [...new Set(dependencies.split(/[,\n]/u).map(item => item.trim()).filter(Boolean))] : task.dependsOn, revision: task.revision + 1 } : task) };
        const id = crypto.randomUUID();
        const preview = await api<{ receipt: WebCommandResult }>(`${base}/theorems/${enc(project.id)}/runs/${enc(runId)}/edits/preview`, { method: 'POST', body: JSON.stringify({ ...proposal, id }) });
        if (generation !== draftGeneration.current) return;
        if (!['validated', 'previewed', 'ready'].includes(preview.receipt.status)) { setError(preview.receipt.reason ?? tx('计划预览未通过，请检查任务和依赖。', 'The plan preview did not pass. Check the task and dependencies.')); return; }
        setPrepared({ input: { requestId: crypto.randomUUID(), kind: 'plan-edit', text, visibility: 'members', issueSource: origin, target, proposal }, planVersion: proposal.baseVersion, receipt: preview.receipt });
      }
    } catch (cause) { setError(errorText(cause)); }
    finally { lock.current = false; setBusy(false); }
  }
  const preparedStale = Boolean(prepared && (prepared.input.issueSource?.issueRevision !== issue.revision || prepared.planVersion && prepared.planVersion !== observation?.inspection.planVersion
    || prepared.input.target.taskRef && !tasks.some(task => task.id === prepared.input.target.taskRef!.id && task.version === prepared.input.target.taskRef!.version)));
  async function send() {
    if (lock.current || pendingRef.current || !prepared || !confirmed || preparedStale || !active) return;
    lock.current = true; setBusy(true); setPending(prepared.input);
    try { await post(prepared.input); } finally { lock.current = false; setBusy(false); }
  }
  async function recover(retry: boolean) {
    const input = pendingRef.current;
    if (lock.current || !input) return;
    lock.current = true; setBusy(true); setError('');
    try { const record = await findOriginal(input); if (record) resolve(record); if (retry && (!record || record.delivery.status === 'not-sent')) await post(input); }
    catch (cause) { setError(errorText(cause)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div class="collaboration-issue-execution" data-issue-execution>
    {linked.map(item => <p key={item.id}><a href={`#feedback-${item.id}`} onClick={event => { event.preventDefault(); onRevealFeedback(item.id); }}>{tx('查看此议题的执行反馈', 'View execution feedback from this issue')}</a> · {nameOf(item.delivery.status)} · {nameOf(item.execution.status)}</p>)}
    <details><summary>{tx('将决议转为执行', 'Turn the resolution into action')}</summary><form class="research-form" onSubmit={event => { event.preventDefault(); void prepare(); }}>
      <label>{tx('执行方式', 'Action')}<select data-issue-execution-kind value={mode} disabled={busy || Boolean(pending)} onChange={event => { setMode(event.currentTarget.value as typeof mode); invalidate(); }}><option value="guidance">{tx('准备运行指导', 'Prepare run guidance')}</option><option value="plan-edit">{tx('准备计划调整', 'Prepare a plan change')}</option></select></label>
      <label>{tx('目标运行', 'Target run')}<select value={runId} required disabled={busy || Boolean(pending) || Boolean(issue.target)} onChange={event => { setRun(event.currentTarget.value); setTask(''); setEditedTask(''); invalidate(); }}><option value="">{tx('选择运行', 'Choose a run')}</option>{runs.map(run => <option key={run.runId} value={run.runId}>{run.title}</option>)}</select></label>
      <label>{tx('目标任务', 'Target task')}<select data-issue-execution-task value={taskId} required={mode === 'plan-edit'} disabled={busy || Boolean(pending) || Boolean(issue.target?.taskRef)} onChange={event => { setTask(event.currentTarget.value); setEditedTask(''); invalidate(); }}><option value="">Lead</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.theorem || task.id} · {task.version.slice(0, 12)}</option>)}</select></label>
      {targetStale && <div role="status"><p>{tx('原任务版本已改变，请核对决议是否适用于当前任务。', 'The original task version changed. Review whether this resolution applies to the current task.')}</p>{task && <><RichProse text={task.objective} /><code>{task.version}</code><button type="button" class="button" data-confirm-issue-task-version onClick={() => { setReviewedTask(JSON.stringify([task.id, task.version])); invalidate(); }}>{tx('已核对，使用这个任务版本', 'Reviewed; use this task version')}</button></>}</div>}
      {issue.target?.taskRef && <code>{issue.target.taskRef.id} · {issue.target.taskRef.version}</code>}
      <Field label={tx('执行说明', 'Execution instructions')} value={text} onInput={value => { setText(value); invalidate(); }} multiline required maxLength={4000} />
      {mode === 'plan-edit' && planTask && <><Field label={tx('任务目标', 'Task objective')} value={editedTask === taskId ? objective : planTask.objective} onInput={value => { if (editedTask !== taskId) setDependencies(planTask.dependsOn.join(', ')); setEditedTask(taskId); setObjective(value); invalidate(); }} multiline required />
        <Field label={tx('前置任务，用逗号分隔', 'Prerequisite task IDs, separated by commas')} value={editedTask === taskId ? dependencies : planTask.dependsOn.join(', ')} onInput={value => { if (editedTask !== taskId) setObjective(planTask.objective); setEditedTask(taskId); setDependencies(value); invalidate(); }} /></>}
      <button type="submit" class="button" data-prepare-issue-execution disabled={busy || Boolean(pending) || !active || mode === 'plan-edit' && !planTask}>{mode === 'guidance' ? tx('核对待发送指导', 'Review guidance before sending') : tx('预览计划影响', 'Preview plan impact')}</button>
    </form>
    {prepared && <div class="collaboration-resolution" data-issue-execution-preview><strong>{tx('待确认的执行内容', 'Action awaiting confirmation')}</strong><p>{prepared.input.target.runId} · {prepared.input.target.taskRef ? `${prepared.input.target.taskRef.id} · ${prepared.input.target.taskRef.version}` : 'Lead'}</p><RichProse text={prepared.input.text} />
      {'proposal' in prepared.input && <details><summary>{tx('完整计划与依赖', 'Complete plan and dependencies')}</summary><pre class="research-block-code">{JSON.stringify(prepared.input.proposal, null, 2)}</pre></details>}
      {prepared.receipt && <p>{tx('受影响任务：', 'Affected tasks: ')}{prepared.receipt.affectedTaskIds?.join(' · ') || tx('见计划预览', 'See plan preview')}</p>}
      {prepared.receipt && binding && <ResearchWorkImpactView project={project} binding={binding} refresh={refresh} onRevealFeedback={onRevealFeedback} plannedTaskIds={prepared.receipt.affectedTaskIds ?? []} />}
      {preparedStale && <p role="status">{tx('决议、任务或计划已有更新，请重新预览。', 'The resolution, task or plan changed. Preview it again.')}</p>}
      <label class="research-check"><input type="checkbox" data-confirm-issue-execution checked={confirmed} disabled={busy || Boolean(pending)} onChange={event => setConfirmed(event.currentTarget.checked)} />{tx('已核对决议、目标和执行内容', 'I reviewed the resolution, target and action')}</label>
      <button type="button" class="button" data-send-issue-execution disabled={busy || Boolean(pending) || !confirmed || preparedStale || !active} onClick={() => void send()}>{tx('确认执行', 'Confirm action')}</button></div>}
    {pending && <div role="status" data-issue-execution-pending><p>{tx('原提交的投递结果尚待核对。', 'The original submission is awaiting a confirmed delivery result.')}</p><button class="button" type="button" disabled={busy} onClick={() => void recover(false)}>{tx('查询原记录', 'Check original record')}</button><button class="text-button" type="button" disabled={busy} onClick={() => void recover(true)}>{tx('核对并重试原提交', 'Check and retry original submission')}</button></div>}
    {saved && <p role="status">{tx('执行反馈已保存：', 'Execution feedback saved: ')}{nameOf(saved.delivery.status)} <button class="text-button" type="button" onClick={() => onRevealFeedback(saved.id)}>{tx('查看后续采纳与执行', 'View decisions and execution')}</button></p>}
    <ErrorBox message={error || resource.error} />{!binding && <p>{tx('没有与此决议对应且有权限操作的运行。', 'No authorized running session matches this resolution.')}</p>}
    </details>
  </div>;
}
