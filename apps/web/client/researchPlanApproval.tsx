import { useEffect, useRef, useState } from 'preact/hooks';
import type { WebObservation, WebPlanApproval } from '../collaboration';
import type { ResearchFeedback, ResearchFeedbackInput, ResearchProjectDetail, ResearchRunBinding } from '../researchProjectTypes';
import { api, base, enc, ErrorBox, errorText, ResearchHttpError, tx, type Item, type Items } from './researchShared';

type ApprovalInput = Extract<ResearchFeedbackInput, { kind: 'plan-approval' }>;
type Attempt = { input: ApprovalInput; rejected: boolean; retryable: boolean; recorded?: boolean };

export function canApproveProjectPlan(binding: Pick<ResearchRunBinding, 'status' | 'permissions'>, approval: WebPlanApproval | undefined): boolean {
  return Boolean(binding.permissions.approve && binding.status === 'running' && approval?.status === 'pending' &&
    approval.planVersion && !approval.leadRevising);
}

/** The server record survives navigation and retains the exact fields sent by this approval form. */
function savedApproval(project: ResearchProjectDetail, selfId: string, binding: ResearchRunBinding, observation: WebObservation): Attempt | undefined {
  const approval = observation.inspection.planApproval;
  for (const record of [...project.feedback].reverse()) {
    const planVersion = record.payload && 'planVersion' in record.payload ? record.payload.planVersion : undefined;
    if (record.kind !== 'plan-approval' || record.projectId !== project.id || record.author.id !== selfId || !planVersion
      || record.target?.runId !== binding.runId || record.target.statementVersionId !== binding.statementVersionId) continue;
    const samePlan = planVersion === approval?.planVersion;
    if (record.execution.status === 'completed' || approval?.approvedId === record.requestId || approval?.approvedId === record.id
      || samePlan && approval?.status === 'approved') continue;
    const rejected = record.delivery.status === 'failed' || Boolean(approval?.rejections.some(item => item.id === record.requestId || item.id === record.id));
    const unconfirmed = record.delivery.status === 'unknown' || record.delivery.status === 'not-sent';
    if (!samePlan && (rejected || !unconfirmed)) continue;
    return { input: { requestId: record.requestId, kind: 'plan-approval', text: record.text, planVersion,
      target: structuredClone(record.target) }, rejected, retryable: !rejected && record.delivery.status === 'not-sent', recorded: !rejected && !unconfirmed };
  }
}

export function ProjectPlanApproval({ project, selfId, binding, observation, refresh }: {
  project: ResearchProjectDetail; selfId: string; binding: ResearchRunBinding; observation: WebObservation; refresh: () => void;
}) {
  const approval = observation.inspection.planApproval;
  const [pending, setPendingState] = useState<Attempt | undefined>(() => savedApproval(project, selfId, binding, observation));
  const pendingRef = useRef(pending), lock = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const canApprove = canApproveProjectPlan(binding, approval);
  const setPending = (attempt: Attempt | undefined) => { pendingRef.current = attempt; setPendingState(attempt); };
  const current = (attempt: Attempt) => pendingRef.current?.input.requestId === attempt.input.requestId;
  const resolve = (attempt: Attempt, record: ResearchFeedback) => {
    if (!current(attempt)) return;
    if (record.execution.status === 'completed' || ['queued', 'delivered', 'deferred'].includes(record.delivery.status)) {
      setPending({ ...attempt, recorded: true, rejected: false, retryable: false }); setError(''); setNotice('');
    } else if (record.delivery.status === 'failed') {
      setPending({ ...attempt, rejected: true, retryable: false });
      setError(record.delivery.reason ?? tx('原批准未生效，请重新核对计划。', 'The original approval failed. Review the plan again.'));
    } else setPending({ ...attempt, retryable: record.delivery.status === 'not-sent' });
  };
  useEffect(() => {
    const attempt = pendingRef.current;
    const record = attempt && project.feedback.find(item => item.requestId === attempt.input.requestId && item.author.id === selfId);
    if (attempt && record) resolve(attempt, record);
  }, [project.feedback]);
  useEffect(() => {
    const attempt = pendingRef.current;
    if (!attempt) return;
    const rejection = approval?.rejections.find(item => item.id === attempt.input.requestId);
    if (rejection && !attempt.rejected) {
      setPending({ ...attempt, rejected: true, recorded: false, retryable: false }); setError(rejection.reason);
    } else if (approval?.approvedId === attempt.input.requestId || attempt.recorded && (approval?.status === 'approved' || approval?.planVersion !== attempt.input.planVersion)) {
      setPending(undefined); setNotice('');
    }
  }, [approval, pending?.recorded, pending?.input.requestId]);
  async function readResult(attempt: Attempt, rejected = false) {
    try {
      const { items } = await api<Items<ResearchFeedback>>(`${base}/theorems/${enc(project.id)}/feedback`);
      if (!current(attempt)) return;
      const record = items.find(item => item.requestId === attempt.input.requestId && item.author.id === selfId);
      if (record) resolve(attempt, record);
      else setPending({ ...attempt, rejected, retryable: !rejected });
    } catch (cause) { if (current(attempt)) setError(errorText(cause)); }
  }
  async function post(attempt: Attempt) {
    try {
      const { item } = await api<Item<ResearchFeedback>>(`${base}/theorems/${enc(project.id)}/feedback`, { method: 'POST', body: JSON.stringify(attempt.input) });
      resolve(attempt, item);
    } catch (cause) {
      if (!current(attempt)) return;
      setError(errorText(cause));
      // A request can fail after its feedback was saved. Check that record before allowing a new approval.
      await readResult(attempt, cause instanceof ResearchHttpError && cause.status >= 400 && cause.status < 500);
    }
    refresh();
  }
  async function submit(retry = false) {
    if (lock.current || !canApproveProjectPlan(binding, approval) ||
      retry && !pendingRef.current?.retryable || !retry && pendingRef.current) return;
    const attempt = pendingRef.current ?? { input: { requestId: crypto.randomUUID(), kind: 'plan-approval' as const,
      text: tx('批准已核对的研究计划', 'Approve the reviewed research plan'), planVersion: approval!.planVersion!,
      target: { runId: binding.runId, statementVersionId: binding.statementVersionId,
        observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest } } }, rejected: false, retryable: false };
    lock.current = true; setBusy(true); setError(''); setNotice(''); setPending(attempt);
    try { await post(attempt); } finally { lock.current = false; setBusy(false); }
  }
  async function check() {
    const attempt = pendingRef.current;
    if (lock.current || !attempt) return;
    lock.current = true; setBusy(true); setError('');
    try { await readResult(attempt, attempt.rejected); refresh(); } finally { lock.current = false; setBusy(false); }
  }
  const reviewCurrent = () => {
    if (lock.current || !canApprove) return;
    setPending(undefined); setError(''); setNotice(tx('请核对当前计划，再点击批准。', 'Review the current plan, then choose Approve.'));
  };
  if (approval?.status !== 'pending' && !pending) return null;
  return <div class="research-publication" data-project-plan-approval data-approval-request-id={pending?.input.requestId}>
    <p class="research-status">{tx('等待批准计划：', 'Plan awaiting approval: ')}<code>{approval?.planVersion}</code></p>
    {approval?.leadRevising && <p class="research-status" role="status" data-approval-revising>{tx('正在按你的意见修改计划。完成后，请核对新计划再批准。', 'The plan is being revised from your feedback. Review it when the changes are ready, then approve it.')}</p>}
    {pending && <p class="research-field-note">{tx('原批准版本：', 'Original approval version: ')}<code>{pending.input.planVersion}</code></p>}
    {pending?.rejected ? <><p class="research-status">{tx('原批准未生效。请核对当前计划，再提交新的批准。', 'The original approval failed. Review the current plan before approving it again.')}</p>
      {approval?.status === 'pending' && <button class="button" type="button" disabled={busy || !canApprove} data-approval-review-current onClick={reviewCurrent}>{tx('改为核对当前计划', 'Review the current plan')}</button>}</>
      : pending ? <><p class="research-status">{pending.recorded
        ? tx('批准已记录，等待运行确认。', 'Approval recorded. Waiting for the run to confirm it.')
        : tx('原批准结果尚待核对，当前计划不会替换原提交。', 'The original approval is unconfirmed. Its submitted version is retained.')}</p>
        <button class="button" type="button" disabled={busy} data-approval-check onClick={() => void check()}>{tx('核对原批准记录', 'Check original approval')}</button>
        {pending.retryable && <button class="button" type="button" disabled={busy || !canApprove} data-approval-retry onClick={() => void submit(true)}>{tx('重试原计划批准', 'Retry the original approval')}</button>}</>
        : <button class="button" type="button" disabled={busy || !canApprove} onClick={() => void submit()}>{tx('批准此版本并继续研究', 'Approve this version and continue')}</button>}
    <ErrorBox message={error} />{notice && <p class="research-status" role="status">{notice}</p>}
  </div>;
}
