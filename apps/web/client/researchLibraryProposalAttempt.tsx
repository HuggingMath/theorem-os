import { useEffect, useState } from 'preact/hooks';
import type { WebRun } from '../shared';
import type { ResearchProjectDetail } from '../researchProjectTypes';
import { api, enc, ErrorBox, MutationState, theoremHref, tx, useMutation, type Item } from './researchShared';
import { libraryProposalAttemptState } from './researchLibraryProposalAttemptModel';

export type ResearchLibraryProposalAttemptProps = { run: WebRun; request: typeof api };
export function ResearchLibraryProposalAttempt({ run, request }: ResearchLibraryProposalAttemptProps) {
  const origin = run.libraryProposalOrigin!;
  const [project, setProject] = useState<ResearchProjectDetail>(), [error, setError] = useState(''), [retry, setRetry] = useState(0), [confirmed, setConfirmed] = useState(false);
  const endpoint = `/api/research/theorems/${enc(origin.projectId)}`, action = useMutation(request);
  useEffect(() => {
    let live = true; const controller = new AbortController(); setConfirmed(false); setError('');
    void request<Item<ResearchProjectDetail>>(endpoint, { signal: controller.signal }).then(result => { if (live) setProject(result.item); }, cause => {
      if (live && !controller.signal.aborted) { setProject(undefined); setError(cause instanceof Error ? cause.message : String(cause)); }
    });
    return () => { live = false; controller.abort(); };
  }, [endpoint, retry, request]);
  const state = project && libraryProposalAttemptState(run, project), canAttach = state?.kind === 'ready' || state?.kind === 'new-version';
  const feedbackHref = theoremHref(origin.projectId, state?.feedback?.target?.runId, { feedbackId: origin.feedbackId });
  return <section class="research-budget-attempt research-library-proposal-attempt" data-library-proposal-attempt data-library-proposal-attachment={state?.kind}>
    <h3>{tx('从已评审提案开始的新尝试', 'New attempt from a reviewed proposal')}{project ? ` · ${project.title}` : ''}</h3>
    <p>{tx('来源记录指向原提案。你在草稿中的修改属于本次个人尝试，需要重新检查与评审。', 'The source record points to the original proposal. Edits in your draft belong to this personal attempt and need their own checks and review.')}</p>
    {state?.kind === 'attached' ? <p role="status">{tx('已确认关联到项目，成员可从原提案查看这次尝试。完整题目的验收结果以本次独立检查为准。', 'Attached to the project. Members can open this attempt from the original proposal. Full-problem acceptance is determined independently for this run.')}</p>
      : <p data-library-proposal-personal>{tx('本次目前是个人运行。确认关联后，本次源码、路线、检查、成果和用量才会对项目成员可见。', 'This is currently a personal run. Attaching it shares its source, route, checks, outcomes and usage with project members.')}</p>}
    <ErrorBox message={error} />
    {!project && !error && <p role="status">{tx('正在核对来源提案与项目…', 'Checking the source proposal and project…')}</p>}
    {canAttach && <>
      {state.kind === 'new-version' && <p data-library-proposal-new-version>{tx('本次源码与现有陈述不同。关联时会以本次源码创建新的陈述版本，并设为当前版本；原陈述与原提案保留。请先核对本次源码的数学含义。', 'This source differs from existing statements. Attachment will create a statement version from this run and make it current. The original statement and proposal remain available. Review the mathematical meaning of this source first.')}</p>}
      <p>{tx('默认仅项目成员可见，不授予指导、修改计划、批准或提交证明的权限。', 'Visibility is limited to project members. Guidance, plan edits, approval and proof submission remain disabled for collaborators.')}</p>
      <label class="research-check"><input type="checkbox" data-library-proposal-attach-confirm checked={confirmed} disabled={action.busy} onChange={event => setConfirmed(event.currentTarget.checked)} />
        <span>{state.kind === 'new-version' ? tx('我已核对本次源码与共享范围，确认创建陈述版本并关联这次运行', 'I reviewed this source and sharing scope and confirm creating a statement version and attaching this run')
          : tx('我已核对陈述版本与共享范围，确认关联这次运行', 'I reviewed the statement version and sharing scope and confirm attaching this run')}</span></label>
      <button type="button" class="button" data-library-proposal-attach disabled={!confirmed || action.busy} onClick={() => {
        if (!confirmed || !project || !canAttach || action.busy) return;
        void action.run<Item<ResearchProjectDetail>>('POST', `${endpoint}/library-proposals/${enc(origin.feedbackId)}/attempts`, {
          expectedRevision: project.revision, runId: run.id, trialDigest: origin.trialDigest, confirmed: true, createStatementVersion: state.kind === 'new-version',
        }, result => { setProject(result.item); setConfirmed(false); });
      }}>{action.busy ? tx('正在关联…', 'Attaching…') : state.kind === 'new-version' ? tx('创建陈述版本并关联', 'Create statement version and attach') : tx('确认关联到项目', 'Confirm attachment to the project')}</button>
      <MutationState action={action} />
    </>}
    {state?.kind === 'read-only' && <p>{tx('当前账号没有关联运行的权限，可保留个人尝试并在项目中核对协作权限。', 'This account cannot attach runs. Keep the personal attempt and review your collaboration permissions in the project.')}</p>}
    {state?.kind === 'source-unavailable' && <p>{tx('原提案的固定来源当前不可访问。个人运行仍保留，请恢复项目权限后重新核对。', 'The fixed source of the original proposal is unavailable. Your personal run remains saved. Restore project access and check again.')}</p>}
    <div class="research-actions"><a data-library-proposal-feedback href={feedbackHref}>{tx('返回原提案与评审证据', 'Return to the original proposal and review evidence')}</a>
      {state?.kind === 'attached' && <a href={theoremHref(origin.projectId, run.id, { statementVersionId: state.versionId })}>{tx('查看项目中的这次尝试', 'View this attempt in the project')}</a>}
      {state?.kind !== 'attached' && <button class="text-button" type="button" data-library-proposal-attach-refresh disabled={action.busy} onClick={() => { action.reset(); setRetry(value => value + 1); }}>{tx('重新核对项目', 'Review the project again')}</button>}
    </div>
  </section>;
}
