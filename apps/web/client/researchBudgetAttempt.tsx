import { useEffect, useState } from 'preact/hooks';
import type { WebRun } from '../shared';
import type { ResearchProjectDetail } from '../researchProjectTypes';
import { api, enc, ErrorBox, MutationState, tx, useMutation, type Item } from './researchShared';
import { budgetAttemptState } from './researchBudgetAttemptModel';

export type ResearchBudgetAttemptProps = { run: WebRun; request: typeof api };
export function ResearchBudgetAttempt({ run, request }: ResearchBudgetAttemptProps) {
  const origin = run.budgetOrigin!;
  const [project, setProject] = useState<ResearchProjectDetail>(), [error, setError] = useState(''), [retry, setRetry] = useState(0), [confirmed, setConfirmed] = useState(false);
  const action = useMutation(request), endpoint = `/api/research/theorems/${enc(origin.projectId)}`;
  useEffect(() => {
    let live = true; const controller = new AbortController(); setError(''); setConfirmed(false);
    void request<Item<ResearchProjectDetail>>(endpoint, { signal: controller.signal }).then(result => { if (live) setProject(result.item); }, cause => {
      if (live && !controller.signal.aborted) { setProject(undefined); setError(cause instanceof Error ? cause.message : String(cause)); }
    });
    return () => { live = false; controller.abort(); };
  }, [endpoint, retry, request]);
  const state = project && budgetAttemptState(run, project);
  const projectHref = `theorems.html?${new URLSearchParams({ id: origin.projectId, ...(state?.versionId ? { version: state.versionId } : {}), ...(state?.kind === 'attached' ? { run: run.id } : {}) })}`;
  const budgetHref = `problem.html?${new URLSearchParams({ run: state?.kind === 'attached' ? run.id : origin.runId, project: origin.projectId, tab: 'outcomes' })}`;
  return <section class="research-budget-attempt" data-budget-attempt-origin data-budget-project-revision={project?.revision} data-budget-project-attached={state?.kind === 'attached' ? 'true' : 'false'}>
    <h3>{tx('来自项目预算的新尝试', 'New attempt from a project budget')}{project ? ` · ${project.title}` : ''}</h3>
    {state?.kind === 'attached' ? <p role="status">{tx('已关联到项目。本次用量已计入项目累计；后续记录也会随运行更新。', 'Attached to the project. This run is included in project totals, which will update as the run progresses.')}</p>
      : <p data-budget-attempt-personal>{tx('本次目前是个人运行，尚未计入项目累计。确认关联后，原题、路线、检查、成果和用量将对项目成员可见。', 'This is currently a personal run and is not included in project totals. Attaching it shares its statement, route, checks, outcomes and usage with project members.')}</p>}
    <ErrorBox message={error} />
    {!project && !error && <p role="status">{tx('正在读取来源项目…', 'Loading the source project…')}</p>}
    {state?.kind === 'ready' && <><p>{tx('默认仅项目成员可见，不授予指导、修改计划、批准或提交证明的操作权限。', 'Visibility is limited to project members. Guidance, plan edits, approval and proof submission stay disabled for collaborators.')}</p>
      <label class="research-check"><input type="checkbox" data-budget-attach-confirm checked={confirmed} disabled={action.busy} onChange={event => setConfirmed(event.currentTarget.checked)} /><span>{tx('我已核对原题版本和共享范围，将本次运行关联到来源项目', 'I reviewed the statement version and sharing scope and want to attach this run to the source project')}</span></label>
      <button type="button" class="button" data-budget-attach-run disabled={!confirmed || action.busy} onClick={() => {
        if (!confirmed || action.busy) return;
        void action.run<Item<ResearchProjectDetail>>('POST', `${endpoint}/runs`, { runId: run.id, statementVersionId: state.versionId, expectedRevision: project!.revision,
          exposure: 'members', grants: { guidance: false, edit: false, approve: false, proof: false } }, result => { setProject(result.item); setConfirmed(false); });
      }}>{action.busy ? tx('正在关联…', 'Attaching…') : tx('确认关联并计入项目', 'Confirm attachment and include in project totals')}</button><MutationState action={action} /></>}
    {state?.kind === 'read-only' && <p>{tx('当前账号没有关联运行的权限。你可以保留个人尝试，并在项目中核对协作权限。', 'This account cannot attach runs. You can keep this personal attempt and review your collaboration permissions in the project.')}</p>}
    {state?.kind === 'checking-environment' && <p role="status">{tx('本次证明环境尚在准备，记录环境版本后即可核对关联。', 'The proof environment is still being prepared. Attachment will be available once its version is recorded.')}</p>}
    {(state?.kind === 'unavailable' || state?.kind === 'different-statement') && <p>{tx('来源陈述已不可用或与本次原题不同。请在项目中核对陈述版本后再关联。', 'The source statement is unavailable or differs from this run. Review the statement version in the project before attaching it.')}</p>}
    <div class="research-actions"><a href={projectHref}>{tx('查看来源项目与陈述', 'View source project and statement')}</a>{project && <a href={budgetHref}>{tx('查看项目累计与预算', 'View project totals and budget')}</a>}
      {state?.kind !== 'attached' && <button type="button" class="text-button" data-budget-attach-refresh disabled={action.busy} onClick={() => { action.reset(); setRetry(value => value + 1); }}>{tx('重新核对项目', 'Review the project again')}</button>}</div>
  </section>;
}
