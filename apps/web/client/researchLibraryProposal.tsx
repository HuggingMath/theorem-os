import { useState } from 'preact/hooks';
import type { ResearchLibraryTrial, ResearchLibraryProposalTarget } from '../researchLibraryTrialTypes';
import type { ResearchFeedback } from '../researchProjectTypes';
import { base, enc, ErrorBox, Field, MutationState, theoremHref, tx, useMutation, useResource, type Item, type Items } from './researchShared';

/** Sharing is a separate user action after the private scratch check. */
export function LibraryTrialProposal({ trial }: { trial: ResearchLibraryTrial }) {
  const [open, setOpen] = useState(false), [projectId, setProjectId] = useState(new URLSearchParams(location.search).get('project') ?? '');
  const [text, setText] = useState(''), [shared, setShared] = useState(''), [submitted, setSubmitted] = useState<ResearchFeedback>();
  const targets = useResource<Items<ResearchLibraryProposalTarget>>(open ? `${base}/library-trials/${enc(trial.id)}/proposal-targets` : undefined);
  const action = useMutation(), target = targets.data?.items.find(item => item.projectId === projectId) ?? targets.data?.items[0];
  const identity = JSON.stringify([trial.digest, target, text]), confirmed = shared === identity;
  const saved = (result: Item<ResearchFeedback>) => { setSubmitted(result.item); setShared(''); };
  return <details class="research-trial-proposal" open={open} onToggle={event => setOpen(event.currentTarget.open)} data-library-trial-proposal>
    <summary>{tx('整理为任务提案', 'Propose this candidate to the project')}</summary>
    <p>{tx('把这份已检查的候选交给项目评审，保留目标、成果版本、参数说明和回执。', 'Send this checked candidate for project review, with its goal, release, argument notes and receipt.')}</p>
    <ErrorBox message={targets.error} />{targets.error && <button type="button" class="text-button" onClick={targets.refresh}>{tx('重新读取可提案项目', 'Reload eligible projects')}</button>}
    {targets.loading && <p role="status">{tx('正在核对任务所在项目及候选权限…', 'Checking projects and candidate permissions…')}</p>}
    {targets.data && !targets.data.items.length && <p>{tx('当前任务尚未关联有候选权限的项目。先将这次研究关联到项目，再回来提交提案。', 'This task is not linked to a project where you can submit candidates. Link this run to a project, then return to propose it.')}</p>}
    {target && !submitted && <form class="research-form" data-library-proposal-form onSubmit={event => {
      event.preventDefault(); if (!confirmed || !text.trim()) return;
      void action.run<Item<ResearchFeedback>>('POST', `${base}/theorems/${enc(target.projectId)}/feedback`, {
        kind: 'proof-submission', target: target.target, text, source: trial.source, visibility: 'members',
        base: { commit: trial.target.ref.commit, sourceDigest: trial.target.ref.sourceDigest,
          environmentDigest: trial.target.ref.environmentDigest, file: trial.target.ref.file },
        libraryTrialId: trial.id, libraryTrialDigest: trial.digest, shareLibraryTrial: true,
      }, saved);
    }}>
      <label>{tx('提交到项目', 'Project')}<select value={target.projectId} disabled={action.busy} data-library-proposal-project onChange={event => { setProjectId(event.currentTarget.value); setShared(''); }}>
        {targets.data?.items.map(item => <option key={item.projectId} value={item.projectId}>{item.title}</option>)}</select></label>
      <p class="research-status">{trial.target.taskTitle} · {trial.target.ref.taskVersion.slice(0, 12)} · {trial.target.ref.commit.slice(0, 12)}</p>
      {target.requiresNewAttempt && <p>{tx('这份候选将在新尝试中使用。评审批准后可带入完整源码与固定库，由你确认启动。', 'This candidate will be used in a new attempt. After review approval, load its complete source and fixed library, then choose when to start it.')}</p>}
      <Field label={tx('提案说明', 'Proposal explanation')} value={text} onInput={value => { setText(value); setShared(''); }} multiline rows={3} required maxLength={8000}
        placeholder={tx('说明这一步如何推进当前目标，以及评审需要关注的参数或前提。', 'Explain how this advances the goal and which arguments or premises need review.')} />
      <label class="research-check"><input type="checkbox" checked={confirmed} disabled={action.busy} data-library-proposal-share onChange={event => setShared(event.currentTarget.checked ? identity : '')} />
        {tx('同意将候选与依赖源码、参数与前提说明、固定成果和检查回执共享给这个项目的成员', 'Share the candidate and dependency source, argument and premise notes, fixed release and check receipt with this project’s members')}</label>
      <button type="submit" class="button" disabled={action.busy || !confirmed || !text.trim()} data-library-proposal-submit>{action.busy ? tx('正在提交并核对候选…', 'Submitting and checking the candidate…') : tx('提交候选供评审', 'Submit candidate for review')}</button>
    </form>}
    <MutationState action={action} />
    {submitted && <p role="status" data-library-proposal-created={submitted.id}>{tx('候选提案已保存，可继续查看检查与人工评审。', 'The candidate proposal is saved. Continue with its check and human review.')} <a class="research-inline-link" href={theoremHref(submitted.projectId, submitted.target?.runId, { statementVersionId: submitted.target?.statementVersionId, taskRef: submitted.target?.taskRef, feedbackId: submitted.id })}>{tx('打开任务提案', 'Open the task proposal')}</a></p>}
  </details>;
}
