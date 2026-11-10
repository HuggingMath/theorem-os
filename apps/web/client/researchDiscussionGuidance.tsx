import { useEffect, useRef, useState } from 'preact/hooks';
import type { WebObservation } from '../collaboration';
import type { WebRun } from '../shared';
import type { ResearchFeedback, ResearchFeedbackInput, ResearchProjectDetail } from '../researchProjectTypes';
import { taskNames } from './agentRoute';
import { api, base, enc, ErrorBox, errorText, nameOf, personHref, ResearchHttpError, tx, useResource, type Item, type Items } from './researchShared';

type Guidance = Extract<ResearchFeedbackInput, { kind: 'guidance' }>;
type Pending = { input: Guidance; draftRevision: number; missing: boolean };
const confirmed = (record: ResearchFeedback) => ['queued', 'delivered', 'deferred', 'failed'].includes(record.delivery.status);

/** A retry owns its original source, target and request ID, separately from the editable draft. */
export function DiscussionGuidance({ project, source, selfId, initialRunId, refresh, onRevealFeedback }: {
  project: ResearchProjectDetail; source: ResearchFeedback; selfId: string; initialRunId?: string;
  refresh: () => void; onRevealFeedback: (id: string) => void;
}) {
  const available = project.runs.filter(run => run.permissions.guidance && run.status === 'running');
  const [runId, setRunId] = useState(() => available.find(run => run.runId === initialRunId)?.runId ?? available[0]?.runId ?? '');
  const [recipient, setRecipient] = useState('lead'), [taskRef, setTaskRef] = useState<{ id: string; version: string }>();
  const [text, setText] = useState(source.text), [visibility, setVisibility] = useState<'members' | 'public'>('members');
  const [pending, setPendingState] = useState<Pending>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const pendingRef = useRef<Pending>(), lock = useRef(false), draftRevision = useRef(0);
  const run = project.runs.find(item => item.runId === runId);
  const resource = useResource<{ run?: WebRun; observation: WebObservation | null }>(run?.permissions.guidance
    ? `${base}/theorems/${enc(project.id)}/runs/${enc(runId)}/observation` : undefined, 5000);
  const observation = resource.data?.observation?.webRunId === runId ? resource.data.observation : undefined;
  const tasks = observation?.inspection.tasks ?? [], names = taskNames(tasks);
  const taskId = recipient.startsWith('task:') ? recipient.slice(5) : undefined;
  const task = tasks.find(item => item.id === taskId);
  const canPublish = source.visibility === 'public' && project.visibility === 'public' && run?.exposure === 'public';
  const effectiveVisibility = canPublish ? visibility : 'members';
  const active = run?.permissions.guidance && run.status === 'running' && resource.data?.run?.status === 'running';
  const taskIssue = taskId && (!task ? tx('原任务已移除，请重新选择接收方。', 'The task was removed. Choose a recipient again.')
    : taskRef?.id !== task.id || taskRef.version !== task.version ? tx('任务版本已变化；草稿已保留，请核对后确认当前版本。', 'The task version changed. Your draft is preserved; review it and confirm the current version.') : '');
  const setPending = (next: Pending | undefined) => { pendingRef.current = next; setPendingState(next); };
  const resolve = (attempt: Pending, record: ResearchFeedback) => {
    if (pendingRef.current !== attempt) return;
    setError('');
    setNotice(tx(`指导已记录 · ${nameOf(record.delivery.status)}。可在关联指导中查看采纳与执行。`, `Guidance recorded · ${nameOf(record.delivery.status)}. See linked guidance for decisions and execution.`));
    if (confirmed(record)) {
      setPending(undefined);
      if (record.delivery.status !== 'failed' && draftRevision.current === attempt.draftRevision) { setText(''); draftRevision.current++; }
    } else {
      const next = { ...attempt, missing: record.delivery.status === 'not-sent' };
      setPending(next);
      setNotice(tx('原指导已保存，投递结果尚待核对。请继续查询原记录；当前草稿已保留。', 'The original guidance was saved; delivery is still unconfirmed. Check the original record. Your draft is preserved.'));
    }
    refresh();
  };
  useEffect(() => {
    const attempt = pendingRef.current;
    const record = attempt && project.feedback.find(item => item.requestId === attempt.input.requestId && item.author.id === selfId && item.sourceFeedbackId === source.id);
    if (attempt && record && confirmed(record)) resolve(attempt, record);
  }, [project.feedback]);
  async function readResult(attempt: Pending) {
    try {
      const { items } = await api<Items<ResearchFeedback>>(`${base}/theorems/${enc(project.id)}/feedback`);
      if (pendingRef.current !== attempt) return undefined;
      const record = items.find(item => item.requestId === attempt.input.requestId && item.author.id === selfId && item.sourceFeedbackId === source.id);
      if (record) { resolve(attempt, record); return record.delivery.status === 'not-sent' ? 'not-sent' : 'recorded'; }
      setPending({ ...attempt, missing: true });
      setNotice(tx('尚未找到原提交。重试会保留原请求、来源、内容及目标版本。当前草稿已保留。', 'The original submission was not found. Retrying keeps its request, source, text and target version. Your current draft is preserved.'));
      return 'missing';
    } catch (cause) {
      if (pendingRef.current === attempt) { setPending({ ...attempt, missing: false }); setError(errorText(cause)); }
      return undefined;
    }
  }
  async function post(attempt: Pending) {
    try {
      const { item } = await api<Item<ResearchFeedback>>(`${base}/theorems/${enc(project.id)}/feedback`, { method: 'POST', body: JSON.stringify(attempt.input) });
      resolve(attempt, item);
    } catch (cause) {
      if (pendingRef.current !== attempt) return;
      setError(errorText(cause));
      // Even an HTTP rejection can follow a saved feedback record. Read before allowing a new request.
      const result = await readResult(attempt);
      if (cause instanceof ResearchHttpError && cause.status >= 400 && cause.status < 500 && result === 'missing'
        && pendingRef.current?.input.requestId === attempt.input.requestId) {
        setPending(undefined);
        setNotice(tx('原提交已被拒绝且未保存，草稿已保留。请核对后再投递。', 'The original submission was rejected and was not saved. Your draft is preserved. Review it before sending again.'));
        resource.refresh(); refresh();
      }
    }
  }
  async function send() {
    if (lock.current || pendingRef.current || !active || !observation || resource.error || taskIssue || !text.trim() || text.length > 4000) return;
    const attempt: Pending = { input: { requestId: crypto.randomUUID(), kind: 'guidance', sourceFeedbackId: source.id,
      text, visibility: effectiveVisibility, recipient: taskId ? { kind: 'task', id: taskId } : { kind: 'lead' },
      target: { runId, statementVersionId: run!.statementVersionId,
        observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest },
        ...(taskId && taskRef ? { taskRef: { ...taskRef } } : {}) } }, draftRevision: draftRevision.current, missing: false };
    lock.current = true; setBusy(true); setError(''); setNotice(''); setPending(attempt);
    try { await post(attempt); } finally { lock.current = false; setBusy(false); }
  }
  async function recover(retry: boolean) {
    const attempt = pendingRef.current;
    if (lock.current || !attempt) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const missing = await readResult(attempt), current = pendingRef.current;
      if (retry && (missing === 'missing' || missing === 'not-sent') && current?.input.requestId === attempt.input.requestId) {
        const original = { ...current, missing: false }; setPending(original); await post(original);
      }
    } finally { lock.current = false; setBusy(false); }
  }
  const chooseRecipient = (value: string) => {
    setRecipient(value); const selected = tasks.find(item => `task:${item.id}` === value);
    setTaskRef(selected ? { id: selected.id, version: selected.version } : undefined); draftRevision.current++;
  };
  return <form class="research-form research-discussion-guidance" data-discussion-guidance-form onSubmit={event => { event.preventDefault(); void send(); }}>
    <p class="research-status">{tx('原建议作者：', 'Original author: ')}<a href={personHref(source.author.id)}>{source.author.displayName}</a>
      {' · '}{tx('投递后保留原始讨论及投递人，采纳与执行另行记录。', 'The original discussion and sender remain linked. Decisions and execution are recorded separately.')}</p>
    <div class="research-form-row">
      <label>{tx('投递到研究运行', 'Forward to research run')}<select data-forward-run value={runId} onChange={event => {
        setRunId(event.currentTarget.value); setRecipient('lead'); setTaskRef(undefined); draftRevision.current++;
      }}>
        {!available.some(item => item.runId === runId) && <option value={runId} disabled>{run?.title ?? tx('原运行不可用，请重新选择', 'Original run unavailable; choose again')}</option>}
        {available.map(item => <option key={item.runId} value={item.runId}>{item.title} · {item.runId.slice(0, 8)}</option>)}
      </select></label>
      <label>{tx('指导接收方', 'Guidance recipient')}<select data-forward-recipient value={recipient} onChange={event => chooseRecipient(event.currentTarget.value)}>
        <option value="lead">Lead</option>{tasks.map(item => <option key={item.id} value={`task:${item.id}`}>{names.get(item.id) ?? item.id}</option>)}
        {taskId && !task && <option value={recipient} disabled>{taskId} · {tx('不可用', 'Unavailable')}</option>}
      </select></label>
    </div>
    {run && <p class="research-field-note">{tx('陈述版本：', 'Statement version: ')}<code>{run.statementVersionId}</code></p>}
    {taskRef && <p class="research-field-note">{tx('草稿任务版本：', 'Draft task version: ')}<code>{taskRef.id} · {taskRef.version}</code></p>}
    {taskIssue && <div class="research-forward-version" data-forward-version-issue><p class="research-status" role="status">{taskIssue}</p>
      {task && <><p class="research-field-note">{tx('当前任务版本：', 'Current task version: ')}<code>{task.version}</code> · {task.objective}</p>
        <button type="button" class="button" data-forward-confirm-version onClick={() => chooseRecipient(recipient)}>{tx('确认当前任务版本', 'Confirm current task version')}</button></>}
    </div>}
    <label>{tx('运行指导内容', 'Run guidance text')}<textarea data-forward-text value={text} rows={4} required maxLength={4000}
      onInput={event => { setText(event.currentTarget.value); draftRevision.current++; }} />
      <span class="research-field-note">{text.length} / 4000 · {tx('可补充说明；原始建议保持不变。', 'Add context as needed. The original suggestion is retained.')}</span></label>
    <label>{tx('指导可见范围', 'Guidance visibility')}<select data-forward-visibility value={effectiveVisibility} onChange={event => { setVisibility(event.currentTarget.value as 'members' | 'public'); draftRevision.current++; }}>
      <option value="members">{tx('项目成员', 'Project members')}</option>{canPublish && <option value="public">{tx('公开', 'Public')}</option>}
    </select>{source.visibility === 'members' && <span class="research-field-note">{tx('原建议仅成员可见，转投指导也仅成员可见。', 'The original suggestion and forwarded guidance are visible to members only.')}</span>}</label>
    <ErrorBox message={resource.error ?? error} />
    {!active && <p class="research-status">{tx('请选择有指导权限且正在运行的研究；草稿已保留。', 'Choose a running research session you can guide. Your draft is preserved.')}</p>}
    {active && !observation && <p class="research-status">{tx('正在读取所选运行的观测。', 'Loading the selected run observation.')}</p>}
    {notice && <p class="research-status" role="status" data-forward-notice>{notice}</p>}
    {pending && <div class="research-forward-pending" data-forward-pending>
      <p class="research-status">{tx('正在核对原提交，期间可继续编辑草稿。', 'Checking the original submission. You can keep editing your draft.')}</p>
      <details><summary>{tx('待核对的原指导', 'Original guidance awaiting confirmation')}</summary><p class="research-description">{pending.input.text}</p>
        <p class="research-field-note">{pending.input.target.runId} · {pending.input.target.taskRef ? `${pending.input.target.taskRef.id} · ${pending.input.target.taskRef.version}` : 'Lead'} · {pending.input.requestId}</p></details>
      <div class="research-actions"><button type="button" class="button" data-forward-receipt disabled={busy} onClick={() => void recover(false)}>{tx('核对原指导记录', 'Check original guidance')}</button>
        {pending.missing && <button type="button" class="button" data-forward-retry disabled={busy} onClick={() => void recover(true)}>{tx('重试原提交', 'Retry original submission')}</button>}</div>
    </div>}
    <button type="submit" class="button" disabled={busy || Boolean(pending) || !active || !observation || Boolean(resource.error || taskIssue) || !text.trim() || text.length > 4000} aria-busy={busy}>
      {busy ? tx('正在投递…', 'Sending…') : tx('发送运行指导', 'Send run guidance')}</button>
    <button type="button" class="text-button" onClick={() => onRevealFeedback(source.id)}>{tx('查看原始讨论', 'View original discussion')}</button>
  </form>;
}
