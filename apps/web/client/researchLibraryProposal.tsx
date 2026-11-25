import { useEffect, useRef, useState } from 'preact/hooks';
import { localizeMessage } from '../i18n';
import type { ResearchLibraryTrial, ResearchLibraryProposalTarget, ResearchLibraryTrialHistory } from '../researchLibraryTrialTypes';
import type { ResearchFeedback } from '../researchProjectTypes';
import { base, enc, ErrorBox, Field, MutationState, theoremHref, tx, useMutation, useResource, type Item, type Items } from './researchShared';
import { readLibraryProposalDraft, writeLibraryProposalDraft, type LibraryProposalDraft } from './researchLibraryProposalDraft';

export function PersonalTrialAttempt({ trial, history }: { trial: ResearchLibraryTrial; history?: ResearchLibraryTrialHistory }) {
  const data = useResource<Item<ResearchLibraryTrialHistory>>(!history && trial.status === 'passed' ? `${base}/library-trials/${enc(trial.id)}/history` : undefined);
  const eligibility = history ?? data.data?.item;
  return <div class="research-personal-trial-attempt" data-personal-trial-attempt>
    <ErrorBox message={data.error} />{data.error && <button type="button" class="text-button" onClick={data.refresh}>{tx('重新读取后续操作', 'Reload next steps')}</button>}
    {eligibility?.personalAttemptReason && <p class="research-status">{localizeMessage(eligibility.personalAttemptReason)}</p>}
    {eligibility?.personalAttempt && <><p>{tx('把这份候选和固定库带入你的新研究草稿，核对配置后再开始。', 'Bring this candidate and fixed library into your new research draft. Review the configuration before starting.')}</p>
      <a class="button" data-prepare-personal-trial href={`./?${new URLSearchParams({ libraryTrial: trial.id, trialDigest: trial.digest })}`}>{tx('准备个人新尝试', 'Prepare a personal attempt')}</a></>}
  </div>;
}

/** Sharing is a separate user action after the private scratch check. */
export function LibraryTrialProposal({ trial, owner }: { trial: ResearchLibraryTrial; owner: string }) {
  const scope = { owner, trialId: trial.id, trialDigest: trial.digest };
  const [initial] = useState(() => { try { return { draft: readLibraryProposalDraft(sessionStorage, scope), failed: false }; }
    catch { return { draft: undefined, failed: true }; } });
  const [open, setOpen] = useState(false), [draft, setDraft] = useState<LibraryProposalDraft>(initial.draft ?? {
    projectId: new URLSearchParams(location.search).get('project') ?? '', texts: {},
  });
  const latest = useRef(draft); latest.current = draft;
  const [draftFailed, setDraftFailed] = useState(initial.failed), [edited, setEdited] = useState(false);
  const [shared, setShared] = useState(''), [submitted, setSubmitted] = useState<ResearchFeedback>();
  const targets = useResource<Items<ResearchLibraryProposalTarget>>(open ? `${base}/library-trials/${enc(trial.id)}/proposal-targets` : undefined);
  const action = useMutation(), projectId = draft.projectId || targets.data?.items[0]?.projectId || '';
  const target = targets.data?.items.find(item => item.projectId === projectId), text = draft.texts[projectId] ?? '';
  const persist = (next: LibraryProposalDraft) => {
    latest.current = next; setDraft(next); setShared('');
    try { writeLibraryProposalDraft(sessionStorage, scope, next); setDraftFailed(false); }
    catch { setDraftFailed(true); }
  };
  useEffect(() => { if (!draft.projectId && projectId) persist({ ...latest.current, projectId }); }, [projectId]);
  const identity = JSON.stringify([trial.digest, target, text]), confirmed = shared === identity;
  return <details class="research-trial-proposal" open={open} onToggle={event => setOpen(event.currentTarget.open)} data-library-trial-proposal>
    <summary>{tx('整理为任务提案', 'Propose this candidate to the project')}</summary>
    <p>{tx('把这份已检查的候选交给项目评审，保留目标、成果版本、参数说明和回执。', 'Send this checked candidate for project review, with its goal, release, argument notes and receipt.')}</p>
    <ErrorBox message={targets.error} />{targets.error && <button type="button" class="text-button" onClick={targets.refresh}>{tx('重新读取可提案项目', 'Reload eligible projects')}</button>}
    {targets.loading && <p role="status">{tx('正在核对任务所在项目及候选权限…', 'Checking projects and candidate permissions…')}</p>}
    {targets.data && !targets.data.items.length && <p>{tx('当前任务尚未关联有候选权限的项目。先将这次研究关联到项目，再回来提交提案。', 'This task is not linked to a project where you can submit candidates. Link this run to a project, then return to propose it.')}</p>}
    {(target || projectId) && !submitted && <form class="research-form" data-library-proposal-form onSubmit={event => {
      event.preventDefault(); if (!target || !confirmed || !text.trim()) return;
      const submittedProject = projectId, submittedText = text;
      void action.run<Item<ResearchFeedback>>('POST', `${base}/theorems/${enc(target.projectId)}/feedback`, {
        kind: 'proof-submission', target: target.target, text, source: trial.source, visibility: 'members',
        base: { commit: trial.target.ref.commit, sourceDigest: trial.target.ref.sourceDigest,
          environmentDigest: trial.target.ref.environmentDigest, file: trial.target.ref.file },
        libraryTrialId: trial.id, libraryTrialDigest: trial.digest, shareLibraryTrial: true,
      }, result => {
        const current = latest.current;
        if (current.texts[submittedProject] === submittedText) persist({ ...current, texts: { ...current.texts, [submittedProject]: '' } });
        setSubmitted(result.item); setShared('');
      });
    }}>
      <fieldset class="research-form" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} disabled={action.busy}>
      <label>{tx('提交到项目', 'Project')}<select value={projectId} data-library-proposal-project onChange={event => { persist({ ...latest.current, projectId: event.currentTarget.value }); setEdited(true); }}>
        {[...new Set([projectId, ...Object.keys(draft.texts)])].filter(id => id && !targets.data?.items.some(item => item.projectId === id)).map(id =>
          <option key={id} value={id}>{tx('已保存草稿 · 项目当前不可用', 'Saved draft · project unavailable')} · {id.slice(-8)}</option>)}
        {targets.data?.items.map(item => <option key={item.projectId} value={item.projectId}>{item.title}</option>)}</select></label>
      {!target && targets.data && <p role="status">{tx('说明仍保留。请重新核对项目权限并选择可提交的项目；切换后可返回查看原项目草稿。', 'Your explanation is retained. Review project access and choose an eligible project. Each project keeps its own draft.')}</p>}
      <p class="research-status">{trial.target.taskTitle} · {trial.target.ref.taskVersion.slice(0, 12)} · {trial.target.ref.commit.slice(0, 12)}</p>
      {target?.requiresNewAttempt && <p>{tx('这份候选将在新尝试中使用。评审批准后可带入完整源码与固定库，由你确认启动。', 'This candidate will be used in a new attempt. After review approval, load its complete source and fixed library, then choose when to start it.')}</p>}
      <Field label={tx('提案说明', 'Proposal explanation')} value={text} onInput={value => { persist({ projectId, texts: { ...latest.current.texts, [projectId]: value } }); setEdited(true); }} multiline rows={3} required maxLength={8000}
        placeholder={tx('说明这一步如何推进当前目标，以及评审需要关注的参数或前提。', 'Explain how this advances the goal and which arguments or premises need review.')} />
      {!draftFailed && (initial.draft || edited) && <p class="research-status" data-library-proposal-draft-saved>{initial.draft && !edited
        ? tx('已恢复这份候选的项目与说明。核对当前目标后，请重新确认共享。', 'The project and explanation for this candidate are restored. Review the current goal and confirm sharing again.')
        : tx('项目与说明已暂存在此标签页。', 'The project and explanation are saved in this tab.')}</p>}
      <ErrorBox message={draftFailed ? tx('提案草稿尚未保存。请保留当前页面并重试。', 'The proposal draft has not been saved. Keep this page open and retry.') : undefined} />
      {draftFailed && <button type="button" class="text-button" onClick={() => persist(latest.current)}>{tx('重试保存草稿', 'Retry saving the draft')}</button>}
      <label class="research-check"><input type="checkbox" checked={confirmed} disabled={!target} data-library-proposal-share onChange={event => setShared(event.currentTarget.checked ? identity : '')} />
        {tx('同意将候选与依赖源码、参数与前提说明、固定成果和检查回执共享给这个项目的成员', 'Share the candidate and dependency source, argument and premise notes, fixed release and check receipt with this project’s members')}</label>
      <button type="submit" class="button" disabled={!target || !confirmed || !text.trim()} data-library-proposal-submit>{action.busy ? tx('正在提交并核对候选…', 'Submitting and checking the candidate…') : tx('提交候选供评审', 'Submit candidate for review')}</button>
      </fieldset>
    </form>}
    <MutationState action={action} />
    {submitted && <p role="status" data-library-proposal-created={submitted.id}>{tx('候选提案已保存，可继续查看检查与人工评审。', 'The candidate proposal is saved. Continue with its check and human review.')} <a class="research-inline-link" href={theoremHref(submitted.projectId, submitted.target?.runId, { statementVersionId: submitted.target?.statementVersionId, taskRef: submitted.target?.taskRef, feedbackId: submitted.id })}>{tx('打开任务提案', 'Open the task proposal')}</a></p>}
  </details>;
}
