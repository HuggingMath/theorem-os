import { useEffect, useRef, useState } from 'preact/hooks';
import type { WebCommandResult, WebObservation, WebPlan } from '../collaboration';
import type { ResearchIssue } from '../researchCollaborationTypes';
import type { ResearchFeedback, ResearchProjectDetail } from '../researchProjectTypes';
import type { WebRun } from '../shared';
import { RichProse } from './richText';
import { ResearchWorkImpactView } from './researchWorkImpact';
import { issueExecutionAttemptFromFeedback, issueExecutionCanRetry, issueExecutionContextMatches, readIssueExecutionAttempt, readIssueExecutionDraft, removeIssueExecutionAttempt, removeIssueExecutionDraft, saveIssueExecutionAttempt, saveIssueExecutionDraft, type IssueExecutionAttempt, type IssueExecutionContext, type IssueExecutionDraft, type IssueExecutionInput } from './researchIssueExecutionDraft';
import { api, base, enc, ErrorBox, errorText, Field, nameOf, ResearchHttpError, tx, useResource, type Item, type Items } from './researchShared';

type Prepared = IssueExecutionAttempt & { planVersion?: string; receipt?: WebCommandResult };
const knownDelivery = (record: ResearchFeedback) => ['queued', 'delivered', 'deferred', 'failed'].includes(record.delivery.status);

/** An issue decision becomes an ordinary, version-bound feedback command only after an explicit confirmation. */
export function IssueExecution({ issue, project, selfId, refresh, onRevealFeedback }: {
  issue: ResearchIssue; project: ResearchProjectDetail; selfId: string; refresh(): void; onRevealFeedback(id: string): void;
}) {
  const scope = { owner: selfId, projectId: project.id, issueId: issue.id };
  const initial: IssueExecutionDraft = { mode: 'guidance',
    runId: issue.target?.runId ?? project.runs.find(run => run.status === 'running' && run.permissions.guidance && (!issue.statementVersionId || run.statementVersionId === issue.statementVersionId))?.runId ?? '',
    taskId: issue.target?.taskRef?.id ?? '', text: issue.resolution?.text ?? '', objective: '', dependencies: '', editedTask: '' };
  const [draft, setDraft] = useState(initial), current = useRef(draft); current.current = draft;
  const { mode, runId, taskId, text, objective, dependencies, editedTask } = draft;
  const [prepared, setPrepared] = useState<Prepared>(), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPendingState] = useState<IssueExecutionAttempt>(), [saved, setSaved] = useState<ResearchFeedback>();
  const [loaded, setLoaded] = useState(false), [restored, setRestored] = useState(false), [reviewed, setReviewed] = useState(false), [retryable, setRetryable] = useState(false);
  const [storageError, setStorageError] = useState(''), [draftError, setDraftError] = useState(''), [notice, setNotice] = useState(''), [reviewedTask, setReviewedTask] = useState('');
  const pendingRef = useRef<IssueExecutionAttempt>(), lock = useRef(false), draftGeneration = useRef(0), alive = useRef(true), edited = useRef(false), handled = useRef(new Set<string>());
  const draftUnsaved = useRef(false);
  const permission = mode === 'guidance' ? 'guidance' : 'edit';
  const runs = project.runs.filter(run => run.permissions[permission] && run.status === 'running' && (!issue.statementVersionId || run.statementVersionId === issue.statementVersionId) && (!issue.target || run.runId === issue.target.runId));
  const binding = runs.find(run => run.runId === runId);
  const resource = useResource<{ run?: WebRun; observation: WebObservation | null }>(binding ? `${base}/theorems/${enc(project.id)}/runs/${enc(runId)}/observation` : undefined, 5000);
  const observation = resource.data?.observation?.webRunId === runId ? resource.data.observation : undefined;
  const tasks = observation?.inspection.tasks ?? [], task = tasks.find(task => task.id === taskId);
  const planTask = observation?.plan?.tasks.find(task => task.id === taskId);
  const context: IssueExecutionContext | undefined = binding && observation && (!taskId || task) ? { issueRevision: issue.revision, resolutionAt: issue.resolution!.createdAt,
    target: { runId, statementVersionId: binding.statementVersionId, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest }, ...(task ? { taskRef: { id: task.id, version: task.version } } : {}) },
    ...(observation.inspection.planVersion ? { planVersion: observation.inspection.planVersion } : {}) } : undefined;
  const changedTaskVersion = Boolean(issue.target?.taskRef && task && task.version !== issue.target.taskRef.version);
  const targetStale = Boolean(issue.target?.taskRef && (!task || changedTaskVersion && reviewedTask !== JSON.stringify([task.id, task.version])));
  const needsReview = targetStale || restored && !reviewed || Boolean(draft.context && context && !issueExecutionContextMatches(draft.context, context));
  const active = Boolean(loaded && !storageError && binding && resource.data?.run?.status === 'running' && context && !resource.error && !needsReview);
  const origin = { issueId: issue.id, issueRevision: issue.revision, resolutionAt: issue.resolution!.createdAt, ...(issue.resolution?.proposalId ? { proposalId: issue.resolution.proposalId } : {}),
    ...(changedTaskVersion && !needsReview && task ? { reviewedTaskRef: { id: task.id, version: task.version } } : {}) };
  const linked = project.feedback.filter(item => item.issueSource?.issueId === issue.id);
  const invalidate = () => { draftGeneration.current++; setPrepared(undefined); setConfirmed(false); setError(''); };
  const update = (next: Partial<IssueExecutionDraft>, resetContext = false) => {
    const value = { ...current.current, ...next, context: resetContext ? undefined : next.context ?? current.current.context ?? context };
    current.current = value; edited.current = true; setDraft(value); invalidate();
    try { saveIssueExecutionDraft(localStorage, scope, value); draftUnsaved.current = false; setDraftError(''); }
    catch { draftUnsaved.current = true; setDraftError(tx('执行草稿未能保存在本机，请保留页面或复制内容。', 'The action draft could not be saved locally. Keep this page open or copy its contents.')); }
  };
  const setPending = (value?: IssueExecutionAttempt) => { pendingRef.current = value; if (alive.current) setPendingState(value); };
  const clearAttempt = (attempt: IssueExecutionAttempt) => {
    removeIssueExecutionAttempt(localStorage, scope, attempt.input.requestId);
    handled.current.add(attempt.input.requestId);
    if (pendingRef.current?.input.requestId === attempt.input.requestId) { setPending(undefined); if (alive.current) setRetryable(false); }
  };
  const resolve = (attempt: IssueExecutionAttempt, record: ResearchFeedback) => {
    if (knownDelivery(record)) {
      clearAttempt(attempt);
      if (attempt.draft && record.delivery.status !== 'failed') removeIssueExecutionDraft(localStorage, scope, attempt.draft);
    }
    if (!alive.current) return;
    setSaved(record); setError(''); setRetryable(record.delivery.status === 'not-sent');
    if (knownDelivery(record)) { setPrepared(undefined); setConfirmed(false); setNotice(''); if (JSON.stringify(current.current) === JSON.stringify(attempt.draft)) setRestored(false); }
    else setNotice(tx('原投递结果尚未确认。可查询原记录；结果未明时不会再次投递，也不会创建新请求。', 'The original delivery is unconfirmed. Check its record; an unknown result will not resend it or create a new request.'));
    refresh();
  };
  async function findOriginal(input: IssueExecutionInput) {
    const result = await api<Items<ResearchFeedback>>(`${base}/theorems/${enc(project.id)}/feedback`);
    return result.items.find(item => item.requestId === input.requestId && item.author.id === selfId && item.issueSource?.issueId === issue.id);
  }
  async function post(attempt: IssueExecutionAttempt) {
    try { const result = await api<Item<ResearchFeedback>>(`${base}/theorems/${enc(project.id)}/feedback`, { method: 'POST', body: JSON.stringify(attempt.input) }); resolve(attempt, result.item); }
    catch (cause) {
      if (alive.current) setError(errorText(cause));
      try { const record = await findOriginal(attempt.input); if (record) resolve(attempt, record);
        else if (cause instanceof ResearchHttpError && cause.status < 500) clearAttempt(attempt); }
      catch { /* Preserve the original request until its record can be checked. */ }
    }
  }
  async function recover(retry: boolean) {
    const attempt = pendingRef.current;
    if (lock.current || !attempt) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const record = await findOriginal(attempt.input);
      if (record) resolve(attempt, record);
      else if (alive.current) { setRetryable(true); setNotice(tx('尚未找到原提交。重试会使用相同内容、目标和请求身份。', 'The original submission was not found. Retrying keeps its text, target and request identity.')); }
      if (retry && (!record || record.delivery.status === 'not-sent')) {
        if (!issueExecutionCanRetry(attempt, issue, observation, resource.data?.run?.status === 'running' && Boolean(binding))) {
          setError(tx('原决议、任务或计划版本已变化。请继续查询原记录，草稿会保留。', 'The original resolution, task or plan changed. Keep checking its record; your draft is preserved.')); return;
        }
        await post(attempt);
      }
    } catch (cause) { if (alive.current) setError(errorText(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const initialize = () => {
    try {
      const local = readIssueExecutionDraft(localStorage, scope);
      const original = readIssueExecutionAttempt(localStorage, scope) ?? linked.filter(item => item.author.id === selfId && !handled.current.has(item.requestId)).map(issueExecutionAttemptFromFeedback).find(Boolean);
      if (!edited.current && (local || original?.draft)) { const value = local ?? original!.draft!; current.current = value; setDraft(value); setRestored(true); setReviewed(false); }
      if (original) { saveIssueExecutionAttempt(localStorage, scope, original); setPending(original); }
      setLoaded(true); setStorageError(''); if (original) void recover(false);
    } catch { setStorageError(tx('无法读取待确认执行记录。请恢复浏览器存储后重试，以免重复投递。', 'Pending action records could not be read. Restore browser storage and check again before sending.')); }
  };
  useEffect(() => {
    alive.current = true; initialize();
    const warn = (event: BeforeUnloadEvent) => { if (draftUnsaved.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => { alive.current = false; window.removeEventListener('beforeunload', warn); };
  }, []);
  useEffect(() => {
    if (!loaded || storageError) return;
    const attempt = pendingRef.current, record = attempt && linked.find(item => item.requestId === attempt.input.requestId && item.author.id === selfId);
    if (attempt && record && knownDelivery(record)) {
      try { resolve(attempt, record); } catch (cause) { setStorageError(errorText(cause)); }
    } else if (!attempt) {
      const original = linked.filter(item => item.author.id === selfId && !handled.current.has(item.requestId)).map(issueExecutionAttemptFromFeedback).find(Boolean);
      if (original) { try { saveIssueExecutionAttempt(localStorage, scope, original); setPending(original); void recover(false); } catch (cause) { setStorageError(errorText(cause)); } }
    }
  }, [project.feedback, loaded]);
  async function prepare() {
    if (lock.current || pendingRef.current || !active || !observation || !binding || !context || !text.trim() || text.length > 4000 || mode === 'plan-edit' && !planTask) return;
    lock.current = true; setBusy(true); setError(''); setConfirmed(false); const generation = draftGeneration.current, snapshot = current.current;
    try {
      const target = context.target;
      if (mode === 'guidance') setPrepared({ input: { requestId: crypto.randomUUID(), kind: 'guidance', text, visibility: 'members', issueSource: origin, target, recipient: task ? { kind: 'task', id: task.id } : { kind: 'lead' } }, draft: snapshot });
      else {
        const currentPlan = observation.plan;
        if (!currentPlan || !planTask) return;
        const changed = editedTask === taskId;
        const proposal: WebPlan = { ...currentPlan, schema: 'deepscientist.math.plan-edit.v1', baseVersion: observation.inspection.planVersion ?? currentPlan.baseVersion,
          tasks: currentPlan.tasks.map(task => task.id === taskId ? { ...task, objective: changed ? objective : task.objective,
            dependsOn: changed ? [...new Set(dependencies.split(/[,\n]/u).map(item => item.trim()).filter(Boolean))] : task.dependsOn, revision: task.revision + 1 } : task) };
        const id = crypto.randomUUID();
        const preview = await api<{ receipt: WebCommandResult }>(`${base}/theorems/${enc(project.id)}/runs/${enc(runId)}/edits/preview`, { method: 'POST', body: JSON.stringify({ ...proposal, id }) });
        if (!alive.current || generation !== draftGeneration.current) return;
        if (!['validated', 'previewed', 'ready'].includes(preview.receipt.status)) { setError(preview.receipt.reason ?? tx('计划预览未通过，请检查任务和依赖。', 'The plan preview did not pass. Check the task and dependencies.')); return; }
        setPrepared({ input: { requestId: crypto.randomUUID(), kind: 'plan-edit', text, visibility: 'members', issueSource: origin, target, proposal }, draft: snapshot, planVersion: proposal.baseVersion, receipt: preview.receipt });
      }
    } catch (cause) { if (alive.current) setError(errorText(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const preparedStale = Boolean(prepared && (prepared.input.issueSource?.issueRevision !== issue.revision || prepared.planVersion && prepared.planVersion !== observation?.inspection.planVersion
    || prepared.input.target.taskRef && !tasks.some(task => task.id === prepared.input.target.taskRef!.id && task.version === prepared.input.target.taskRef!.version)));
  async function send() {
    if (lock.current || pendingRef.current || !prepared || !confirmed || preparedStale || !active) return;
    const attempt: IssueExecutionAttempt = { input: prepared.input, draft: prepared.draft };
    try {
      const existing = readIssueExecutionAttempt(localStorage, scope);
      if (existing) { setPending(existing); void recover(false); return; }
      saveIssueExecutionAttempt(localStorage, scope, attempt);
    } catch { setStorageError(tx('原请求记录未能保存在本机，执行尚未投递。恢复浏览器存储后重试。', 'The original request could not be saved locally, so the action was not sent. Restore browser storage and try again.')); return; }
    lock.current = true; setBusy(true); setPending(attempt); setRetryable(false);
    try { await post(attempt); } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <div class="collaboration-issue-execution" data-issue-execution>
    {linked.map(item => <p key={item.id}><a href={`#feedback-${item.id}`} onClick={event => { event.preventDefault(); onRevealFeedback(item.id); }}>{tx('查看此议题的执行反馈', 'View execution feedback from this issue')}</a> · {nameOf(item.delivery.status)} · {nameOf(item.execution.status)}</p>)}
    <details><summary>{tx('将决议转为执行', 'Turn the resolution into action')}</summary><form class="research-form" onSubmit={event => { event.preventDefault(); void prepare(); }}>
      <label>{tx('执行方式', 'Action')}<select data-issue-execution-kind value={mode} disabled={busy || Boolean(pending)} onChange={event => update({ mode: event.currentTarget.value as typeof mode })}><option value="guidance">{tx('准备运行指导', 'Prepare run guidance')}</option><option value="plan-edit">{tx('准备计划调整', 'Prepare a plan change')}</option></select></label>
      <label>{tx('目标运行', 'Target run')}<select value={runId} required disabled={busy || Boolean(pending) || Boolean(issue.target)} onChange={event => { setReviewed(false); update({ runId: event.currentTarget.value, taskId: '', editedTask: '' }, true); }}><option value="">{tx('选择运行', 'Choose a run')}</option>{runs.map(run => <option key={run.runId} value={run.runId}>{run.title}</option>)}</select></label>
      <label>{tx('目标任务', 'Target task')}<select data-issue-execution-task value={taskId} required={mode === 'plan-edit'} disabled={busy || Boolean(pending) || Boolean(issue.target?.taskRef)} onChange={event => { setReviewed(false); update({ taskId: event.currentTarget.value, editedTask: '' }, true); }}><option value="">Lead</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.theorem || task.id} · {task.version.slice(0, 12)}</option>)}</select></label>
      {restored && <p role="status" data-issue-execution-restored>{tx('已恢复本机执行草稿，请重新核对目标和任务版本。', 'Your local action draft is restored. Review its target and task version again.')}</p>}
      {needsReview && <div role="status" data-issue-execution-review><p>{tx('请核对这份草稿是否适用于当前决议、任务和计划版本。', 'Review whether this draft applies to the current resolution, task and plan version.')}</p>
        {draft.context && <p>{tx('草稿任务版本', 'Draft task version')}: <code>{draft.context.target.taskRef?.version ?? 'Lead'}</code></p>}
        {task && <><RichProse text={task.objective} /><code>{task.version}</code></>}
        <button type="button" class="button" data-confirm-issue-task-version disabled={!context || Boolean(pending)} onClick={() => { if (!context) return; setReviewed(true); if (task) setReviewedTask(JSON.stringify([task.id, task.version])); update({ context }); }}>{tx('已核对，使用这个任务版本', 'Reviewed; use this task version')}</button></div>}
      {issue.target?.taskRef && <code>{issue.target.taskRef.id} · {issue.target.taskRef.version}</code>}
      <Field label={tx('执行说明', 'Execution instructions')} value={text} onInput={text => update({ text })} multiline required maxLength={4000} />
      {mode === 'plan-edit' && planTask && <><Field label={tx('任务目标', 'Task objective')} value={editedTask === taskId ? objective : planTask.objective} onInput={objective => update({ objective, editedTask: taskId, ...(editedTask !== taskId ? { dependencies: planTask.dependsOn.join(', ') } : {}) })} multiline required />
        <Field label={tx('前置任务，用逗号分隔', 'Prerequisite task IDs, separated by commas')} value={editedTask === taskId ? dependencies : planTask.dependsOn.join(', ')} onInput={dependencies => update({ dependencies, editedTask: taskId, ...(editedTask !== taskId ? { objective: planTask.objective } : {}) })} /></>}
      <button type="submit" class="button" data-prepare-issue-execution disabled={busy || Boolean(pending) || !active || mode === 'plan-edit' && !planTask}>{mode === 'guidance' ? tx('核对待发送指导', 'Review guidance before sending') : tx('预览计划影响', 'Preview plan impact')}</button>
    </form>
    {prepared && <div class="collaboration-resolution" data-issue-execution-preview><strong>{tx('待确认的执行内容', 'Action awaiting confirmation')}</strong><p>{prepared.input.target.runId} · {prepared.input.target.taskRef ? `${prepared.input.target.taskRef.id} · ${prepared.input.target.taskRef.version}` : 'Lead'}</p><RichProse text={prepared.input.text} />
      {'proposal' in prepared.input && <details><summary>{tx('完整计划与依赖', 'Complete plan and dependencies')}</summary><pre class="research-block-code">{JSON.stringify(prepared.input.proposal, null, 2)}</pre></details>}
      {prepared.receipt && <p>{tx('受影响任务：', 'Affected tasks: ')}{prepared.receipt.affectedTaskIds?.join(' · ') || tx('见计划预览', 'See plan preview')}</p>}
      {prepared.receipt && binding && <ResearchWorkImpactView project={project} selfId={selfId} binding={binding} refresh={refresh} onRevealFeedback={onRevealFeedback} plannedTaskIds={prepared.receipt.affectedTaskIds ?? []} />}
      {preparedStale && <p role="status">{tx('决议、任务或计划已有更新，请重新预览。', 'The resolution, task or plan changed. Preview it again.')}</p>}
      <label class="research-check"><input type="checkbox" data-confirm-issue-execution checked={confirmed} disabled={busy || Boolean(pending)} onChange={event => setConfirmed(event.currentTarget.checked)} />{tx('已核对决议、目标和执行内容', 'I reviewed the resolution, target and action')}</label>
      <button type="button" class="button" data-send-issue-execution disabled={busy || Boolean(pending) || !confirmed || preparedStale || !active} onClick={() => void send()}>{tx('确认执行', 'Confirm action')}</button></div>}
    {notice && <p role="status" data-issue-execution-notice>{notice}</p>}
    {pending && <div role="status" data-issue-execution-pending data-issue-execution-request={pending.input.requestId}><p>{tx('原提交的投递结果尚待核对，暂不能创建新执行。', 'The original delivery is awaiting confirmation. A new action cannot be created yet.')}</p>
      <details><summary>{tx('查看待核对的原执行', 'View the original action')}</summary><RichProse text={pending.input.text} /><p><code>{pending.input.target.runId} · {pending.input.target.taskRef?.id ?? 'Lead'} · {pending.input.target.taskRef?.version} · {pending.input.requestId}</code></p></details>
      <button class="button" type="button" data-query-issue-execution disabled={busy} onClick={() => void recover(false)}>{tx('查询原记录', 'Check original record')}</button>
      {retryable && <button class="text-button" type="button" data-retry-issue-execution disabled={busy || !issueExecutionCanRetry(pending, issue, observation, resource.data?.run?.status === 'running' && Boolean(binding))} onClick={() => void recover(true)}>{tx('核对并重试原提交', 'Check and retry original submission')}</button>}
      {retryable && !issueExecutionCanRetry(pending, issue, observation, resource.data?.run?.status === 'running' && Boolean(binding)) && <p>{tx('原决议、任务或计划版本已变化，请继续查询原记录。', 'The original resolution, task or plan changed. Keep checking its record.')}</p>}
    </div>}
    {saved && <p role="status">{tx('执行反馈已保存：', 'Execution feedback saved: ')}{nameOf(saved.delivery.status)} <button class="text-button" type="button" onClick={() => onRevealFeedback(saved.id)}>{tx('查看后续采纳与执行', 'View decisions and execution')}</button></p>}
    <ErrorBox message={draftError} /><ErrorBox message={storageError} />{storageError && <button class="text-button" type="button" disabled={busy} onClick={initialize}>{tx('重新读取本机执行记录', 'Reload local action records')}</button>}<ErrorBox message={error || resource.error} />{!binding && <p>{tx('没有与此决议对应且有权限操作的运行。', 'No authorized running session matches this resolution.')}</p>}
    </details>
  </div>;
}
