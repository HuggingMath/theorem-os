import { useEffect, useRef, useState } from 'preact/hooks';
import type { WebCommandResult, WebObservation } from '../collaboration';
import type { WebRun } from '../shared';
import { DecisionSummary } from './decisionSummary';
import { api, enc, ErrorBox, errorText, ResearchHttpError, tx } from './researchShared';
import { readPersonalApproval, removePersonalApproval, savePersonalApproval, type PersonalApprovalAttempt } from './personalApprovalStore';

export function InlinePersonalApproval({ owner, run, observation, root, refresh }: { owner: string; run: WebRun; observation: WebObservation; root: string; refresh(): void }) {
  const [initial] = useState(() => {
    try { return { pending: readPersonalApproval(localStorage, owner, run.id), error: '' }; }
    catch { return { pending: undefined, error: tx('无法读取原批准记录。请恢复浏览器存储后刷新，再核对批准结果。', 'The original approval record could not be read. Restore browser storage and reload to check its result.') }; }
  });
  const [pending, setPendingState] = useState(initial.pending), pendingRef = useRef(initial.pending), lock = useRef(false);
  const [busy, setBusy] = useState(Boolean(initial.pending)), [error, setError] = useState(initial.error), [confirmed, setConfirmed] = useState('');
  const [receipt, setReceipt] = useState<WebCommandResult>(), [submitted, setSubmitted] = useState<PersonalApprovalAttempt | undefined>(initial.pending);
  const approval = observation.inspection.planApproval;
  const canApprove = run.status === 'running' && approval?.status === 'pending' && !approval.leadRevising && observation.plan?.baseVersion === approval.planVersion;
  const setPending = (attempt?: PersonalApprovalAttempt) => { pendingRef.current = attempt; setPendingState(attempt); };
  const resolve = (attempt: PersonalApprovalAttempt, result: WebCommandResult) => {
    if (pendingRef.current?.id !== attempt.id) return;
    if (result.id !== attempt.id) throw new Error(tx('批准回执与原提交不一致，请重新核对。', 'The approval receipt does not match the original submission. Check it again.'));
    setReceipt(result); setSubmitted(attempt);
    if (['approved', 'rejected', 'failed'].includes(result.status)) {
      removePersonalApproval(localStorage, owner, run.id, attempt.id); setPending(undefined); setConfirmed('');
      if (result.status !== 'approved') setError(result.reason ?? tx('原批准未生效，请重新核对计划。', 'The original approval failed. Review the plan again.'));
    }
  };
  const check = async (retry = false) => {
    const attempt = pendingRef.current;
    if (lock.current || !attempt) return;
    lock.current = true; setBusy(true); setError('');
    try {
      let result: WebCommandResult;
      try { result = (await api<{ receipt: WebCommandResult }>(`${root}/commands/${enc(attempt.id)}`)).receipt; }
      catch (cause) {
        if (!(cause instanceof ResearchHttpError && cause.status === 404)) throw cause;
        // Reloads only reconcile. A user retry may resend the same command for the same reviewed plan.
        if (!retry || !canApprove || approval?.planVersion !== attempt.planVersion) {
          setReceipt(undefined); setError(tx('暂未找到原批准回执；原请求和计划版本仍已保留。', 'The original receipt is not available yet. Its request and plan version are retained.')); return;
        }
        result = (await api<{ receipt: WebCommandResult }>(`${root}/plan-approval`, { method: 'POST', body: JSON.stringify(attempt) })).receipt;
      }
      resolve(attempt, result); refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { lock.current = false; setBusy(false); }
  };
  useEffect(() => { if (initial.pending) void check(); }, []);
  useEffect(() => {
    const attempt = pendingRef.current;
    if (!attempt) return;
    const rejected = approval?.rejections.find(item => item.id === attempt.id);
    try {
      if (approval?.approvedId === attempt.id) resolve(attempt, { id: attempt.id, status: 'approved', planVersion: approval.approvedVersion });
      else if (rejected) resolve(attempt, { id: attempt.id, status: 'rejected', reason: rejected.reason, planVersion: rejected.planVersion });
    } catch (cause) { setError(errorText(cause)); }
  }, [approval]);
  const submit = async () => {
    if (lock.current || pendingRef.current || initial.error || !owner || !canApprove || confirmed !== approval?.planVersion) return;
    const attempt = { id: crypto.randomUUID(), planVersion: approval.planVersion! };
    lock.current = true; setBusy(true); setError(''); setReceipt(undefined);
    try {
      // Persist before sending so leaving this page cannot turn an unknown result into a second command.
      savePersonalApproval(localStorage, owner, run.id, attempt); setPending(attempt); setSubmitted(attempt);
      resolve(attempt, (await api<{ receipt: WebCommandResult }>(`${root}/plan-approval`, { method: 'POST', body: JSON.stringify(attempt) })).receipt); refresh();
    } catch (cause) { setError(pendingRef.current ? errorText(cause) : tx('无法保存批准记录，本次尚未发送。请恢复浏览器存储后再试。', 'The approval record could not be saved, so nothing was sent. Restore browser storage and try again.')); }
    finally { lock.current = false; setBusy(false); }
  };
  if (approval?.status !== 'pending' && !pending) return null;
  const recorded = submitted?.planVersion === approval?.planVersion && receipt && !['unknown', 'failed', 'rejected'].includes(receipt.status);
  return <section data-inline-personal-approval data-approval-request-id={pending?.id}><h4>{tx('研究计划等待你决定', 'The research plan awaits your decision')}</h4>
    <DecisionSummary plan={observation.plan} expectedVersion={approval?.planVersion} />
    {approval?.leadRevising && <p role="status">{tx('正在按意见修改计划，请等新版本准备好后再核对。', 'The plan is being revised. Review the new version when it is ready.')}</p>}
    {pending && <p data-personal-approval-original>{tx('原批准版本：', 'Original approval version: ')}<code>{pending.planVersion}</code></p>}
    {pending && pending.planVersion !== approval?.planVersion && <p role="status">{tx('当前计划已有变化。这里继续核对原批准，不会批准新版本。', 'The current plan has changed. This checks the original approval and does not approve the new version.')}</p>}
    <label class="research-check"><input type="checkbox" data-inline-confirm-plan disabled={Boolean(pending) || busy} checked={confirmed === approval?.planVersion} onChange={event => setConfirmed(event.currentTarget.checked ? approval?.planVersion ?? '' : '')} />{tx('已核对这些任务、前提和依赖', 'I reviewed these tasks, premises and dependencies')}</label>
    <button type="button" class="button" data-inline-approve-plan disabled={busy || Boolean(pending) || Boolean(initial.error) || !owner || recorded || !canApprove || confirmed !== approval?.planVersion} onClick={() => void submit()}>{recorded ? tx('批准已记录，等待运行确认', 'Approval recorded; awaiting run confirmation') : tx('批准此计划并继续', 'Approve this plan and continue')}</button>
    <ErrorBox message={error} />
    {pending && <p role="status">{receipt && ['queued', 'delivered', 'deferred'].includes(receipt.status)
      ? tx('批准已记录，等待运行确认。', 'Approval recorded. Waiting for the run to confirm it.')
      : tx('原批准结果尚待核对，当前计划不会替换原提交。', 'The original approval is unconfirmed. Its submitted version is retained.')} <button type="button" class="button" data-inline-retry-command disabled={busy} onClick={() => void check(true)}>{tx('核对并重试原提交', 'Check and retry the original submission')}</button></p>}
    {receipt && <p role="status" data-inline-command-status={receipt.status}>{tx('运行回执', 'Run receipt')}: {receipt.status}{receipt.reason ? ` · ${receipt.reason}` : ''}</p>}
  </section>;
}
