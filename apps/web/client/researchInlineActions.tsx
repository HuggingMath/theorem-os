import { useEffect, useRef, useState } from 'preact/hooks';
import type { WebObservation } from '../collaboration';
import type { WebRun } from '../shared';
import type { ResearchFeedback, ResearchFeedbackTarget, ResearchProjectDetail, ResearchRunBinding } from '../researchProjectTypes';
import type { ResearchProblem } from '../researchProblemTypes';
import type { ResearchBriefTask } from '../researchWorkspaceTypes';
import { RichProse } from './richText';
import { base, enc, ErrorBox, Field, MutationState, theoremHref, tx, useMutation, useResource, type Item, type ResearchContext } from './researchShared';
import { FeedbackWorkspace, type FeedbackFocus } from './researchFeedback';
import { ProofSubmission } from './researchTheorems';
import { ProjectPlanApproval } from './researchPlanApproval';
import { InlinePersonalApproval } from './researchPersonalApproval';
import { ResearchAnnotations } from './researchAnnotations';
import { ResearchDraftPicker } from './researchDrafts';
import { useResearchInputDraft } from './researchInputDraft';
import type { ResearchDraftValues } from '../researchPersonalTypes';
import { usePersonalGuidance } from './usePersonalGuidance';
import './researchInlineActions.css';

/** Route-local controls keep the displayed mathematical contract beside every human action. */
export function ResearchInlineActions({ problem, task, context, refresh, onTask, focusAnnotationId }: { problem: ResearchProblem; task?: ResearchBriefTask; context: ResearchContext; refresh(): void;
  onTask?(target: ResearchFeedbackTarget, task: { id: string; version: string }): void; focusAnnotationId?: string }) {
  const project = problem.project, runId = problem.brief.selectedRunId, binding = project?.runs.find(binding => binding.runId === runId);
  const root = project ? `${base}/theorems/${enc(project.id)}/runs/${enc(runId)}` : `/api/runs/${enc(runId)}`;
  const resource = useResource<{ run?: WebRun; observation?: WebObservation | null }>(context.session.authenticated && (!project || project.permissions.member) ? `${root}${project ? '/observation' : ''}` : undefined, 5000);
  const run = resource.data?.run, observation = resource.data?.observation ?? run?.observation;
  const changed = () => { resource.refresh(); refresh(); };
  const current = observation?.inspection.tasks.find(item => item.id === task?.id && item.version === task.version);
  const [focus, setFocus] = useState<FeedbackFocus>(), [openedCandidate, setOpenedCandidate] = useState(false), [showFeedback, setShowFeedback] = useState(false);
  const [annotationScope, setAnnotationScope] = useState<'project' | 'private'>('project');
  const drawer = useRef<HTMLDialogElement>(null);
  const selfId = context.session.researcherId ?? '';
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if ((focusAnnotationId || query.has('accountDraft')) && drawer.current && !drawer.current.open) drawer.current.showModal();
    if (query.get('feedback') && (focusAnnotationId || query.has('accountDraft'))) {
      setFocus(previous => ({ id: query.get('feedback')!, request: (previous?.request ?? 0) + 1 })); setShowFeedback(true);
    }
  }, [focusAnnotationId]);
  if (project && !project.permissions.member) return null;
  return <section class="research-inline-actions" data-research-inline-actions>
    <button type="button" class="button" data-inline-open onClick={() => drawer.current?.showModal()}>{task ? tx('处理这一步：指导、候选与批注', 'Work on this step: guidance, candidates and comments') : tx('审阅路线并参与决定', 'Review the route and take action')}</button>
    <dialog ref={drawer} class="research-inline-drawer" data-inline-drawer aria-label={task ? tx('在这一步参与研究', 'Work on this step') : tx('审阅路线并参与决定', 'Review the route and take action')} onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.currentTarget.close(); } }}>
    <header><h3>{task ? tx('就在这一步参与研究', 'Work on this step here') : tx('审阅当前路线并参与决定', 'Review the route and take action')}</h3><button type="button" class="text-button" data-inline-close onClick={() => drawer.current?.close()}>{tx('关闭', 'Close')}</button></header>
    {task && <div class="research-inline-context" data-inline-math-context>{[
      [tx('要证明什么', 'Statement'), task.statement || task.objective], [tx('所用前提', 'Premises'), task.premises.join('\n')], [tx('怎样推出', 'Derivation'), task.derivation],
    ].map(([title, text]) => text && <section key={title}><h5>{title}</h5><RichProse text={text} /></section>)}<code>{task.version.slice(0, 12)}</code></div>}
    <ErrorBox message={resource.error} />{resource.error && <button type="button" class="text-button" onClick={resource.refresh}>{tx('重新核对可用操作', 'Reload available actions')}</button>}
    {!observation && !resource.error && <p role="status">{tx('正在读取当前任务与操作权限…', 'Loading the current task and available actions…')}</p>}
    {observation && run && <>
      {task && !current && <p class="research-status" data-inline-historical>{tx('当前显示的是历史任务版本。可以批注原文；运行指导、认领和候选请使用当前任务版本。', 'This is a historical task version. You can annotate its original text. Use the current task version for guidance, claims and candidates.')}</p>}
      {project && binding ? <>
        <InlineProjectClaim project={project} binding={binding} observation={observation} task={current ? task : undefined} selfId={selfId} refresh={changed} />
        <ProjectPlanApproval project={project} binding={{ ...binding, status: run.status }} observation={observation} selfId={selfId} refresh={changed} />
      </> : !project && <InlinePersonalApproval key={`${selfId}:${run.id}`} owner={selfId} run={run} observation={observation} root={root} refresh={changed} />}
      {(!project || ((!task || current) && binding?.permissions.guidance && run.status === 'running')) && <InlineGuidance key={`${selfId}:${project?.id ?? ''}:${run.id}:${task?.id ?? ''}:${task?.version ?? ''}`} canSend={run.status === 'running' && (!task || Boolean(current))} running={run.status === 'running'} selfId={selfId} project={project} binding={binding} observation={observation} task={task} root={root} refresh={changed}
        onSaved={id => { setFocus(previous => ({ id, request: (previous?.request ?? 0) + 1 })); setShowFeedback(true); }} />}
      {project && binding && task && current && binding.permissions.proof && run.status === 'running' && <>
        <button class="button" type="button" data-inline-candidate onClick={() => setOpenedCandidate(value => !value)} aria-expanded={openedCandidate}>{tx('在这里编写候选证明', 'Write a candidate proof here')}</button>
        {openedCandidate && <ProofSubmission project={project} projectId={project.id} selfId={selfId} binding={binding} observation={observation} refresh={changed}
          requested={{ target: { runId, statementVersionId: binding.statementVersionId, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest }, taskRef: { id: task.id, version: task.version } }, serial: 1 }}
          onSaved={id => { setShowFeedback(true); setFocus(previous => ({ id, request: (previous?.request ?? 0) + 1 })); }} />}
      </>}
    </>}
    {task && <>{project && binding?.permissions.manage && <label>{tx('批注可见范围', 'Annotation visibility')}<select data-inline-annotation-scope value={annotationScope} onChange={event => setAnnotationScope(event.currentTarget.value as typeof annotationScope)}><option value="project">{tx('项目成员', 'Project members')}</option><option value="private">{tx('我的私有批注', 'My private comments')}</option></select></label>}
      <ResearchAnnotations key={project && annotationScope === 'project' ? project.id : 'personal'} runId={runId} projectId={annotationScope === 'project' ? project?.id : undefined} task={task} commit={task.commit} selfId={selfId} refresh={changed} focusAnnotationId={focusAnnotationId} /></>}
    {project && <details open={showFeedback} onToggle={event => setShowFeedback(event.currentTarget.open)}><summary>{tx('在此审阅对应提交与决定', 'Review related submissions and decisions here')}</summary>
      <FeedbackWorkspace project={project} selfId={selfId} runId={runId} task={task ? { runId, taskId: task.id, taskVersion: task.version } : undefined} initialScope={task ? 'task' : 'run'} refresh={changed} browseTask={0} focus={focus} focusAnnotationId={focusAnnotationId}
        onRevealFeedback={id => setFocus(previous => ({ id, request: (previous?.request ?? 0) + 1 }))} onOpenTask={(target, task) => {
          drawer.current?.close();
          if (onTask) { onTask(target, task); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-inline-open]')?.focus()); }
          else location.assign(theoremHref(project.id, target.runId, { statementVersionId: target.statementVersionId, taskRef: task }));
        }}
        onOpenStatement={versionId => location.assign(`${theoremHref(project.id, undefined, { statementVersionId: versionId })}#statement-versions`)} />
    </details>}
    </dialog>
  </section>;
}

function InlineProjectClaim({ project, binding, observation, task, selfId, refresh }: { project: ResearchProjectDetail; binding: ResearchRunBinding; observation: WebObservation; task?: ResearchBriefTask; selfId: string; refresh(): void }) {
  const action = useMutation();
  if (!task || !project.permissions.edit || binding.status !== 'running') return null;
  const claim = project.assignments.find(item => item.author.id === selfId && item.target.runId === binding.runId && item.target.taskRef?.id === task.id && item.target.taskRef.version === task.version && item.status === 'claimed');
  const target = { runId: binding.runId, statementVersionId: binding.statementVersionId, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest }, taskRef: { id: task.id, version: task.version } };
  return <div class="research-actions"><button class="button" type="button" data-inline-claim disabled={action.busy} onClick={() => void action.run('POST', `${base}/theorems/${enc(project.id)}/assignments`, { target: claim?.target ?? target, status: claim ? 'released' : 'claimed', expectedRevision: project.revision }, refresh)}>
    {claim ? tx('释放我的认领', 'Release my claim') : tx('由我接着处理这一步', 'Claim this step')}</button><MutationState action={action} /></div>;
}

function InlineGuidance({ selfId, project, binding, observation, task, root, refresh, onSaved, canSend, running }: { canSend: boolean; running: boolean; selfId: string; project?: ResearchProjectDetail; binding?: ResearchRunBinding; observation: WebObservation; task?: ResearchBriefTask; root: string; refresh(): void; onSaved(id: string): void }) {
  const runId = binding?.runId ?? observation.webRunId;
  const scope = { runId, ...(binding ? { statementVersionId: binding.statementVersionId } : {}), ...(task ? { taskId: task.id, taskVersion: task.version } : {}) };
  const input = useResearchInputDraft<ResearchDraftValues['guidance']>(selfId, project?.id, 'guidance', scope, { text: '',
    planVersion: observation.inspection.planVersion, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest } });
  const text = input.value.text, [confirmed, setConfirmed] = useState(''), action = useMutation();
  const personal = usePersonalGuidance(selfId, runId, root, observation, running, !project, refresh, (submitted, receipt) => {
    if ((submitted.body.taskRef?.id ?? '') === (task?.id ?? '') && (submitted.body.taskRef?.version ?? '') === (task?.version ?? ''))
      void input.complete(submitted.draft, { kind: 'guidance', id: receipt.id }, submitted.value);
    else if (submitted.draft) void input.drafts.complete(submitted.draft, { kind: 'guidance', id: receipt.id });
  });
  const signature = JSON.stringify([task?.id, task?.version, observation.inspection.planVersion]), checked = confirmed === signature;
  const target: ResearchFeedbackTarget | undefined = binding ? { runId: binding.runId, statementVersionId: binding.statementVersionId, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest }, ...(task ? { taskRef: { id: task.id, version: task.version } } : {}) } : undefined;
  const recipient = task ? { kind: 'task', id: task.id } : { kind: 'lead' }, busy = action.busy || personal.busy;
  return <details data-inline-guidance open={Boolean(text || personal.attempt) || undefined}><summary>{task ? tx('对这一步提供指导', 'Give guidance for this step') : tx('向 Lead 提供路线意见', 'Give route guidance to the Lead')}</summary>
    <ResearchDraftPicker drafts={input.drafts} filter={item => item.scope.runId === runId && (item.scope.taskId ?? '') === (task?.id ?? '') && (item.scope.taskVersion ?? '') === (task?.version ?? '')} onRestore={item => { input.restore(item); setConfirmed(''); action.reset(); }} />
    <form class="research-form" onSubmit={event => { event.preventDefault(); if (!checked || !canSend || personal.attempt || personal.blocked) return; const submitted = input.drafts.current(), value = input.value;
    if (project && target) void action.run<Item<ResearchFeedback>>('POST', `${base}/theorems/${enc(project.id)}/feedback`, { kind: 'guidance', target, recipient, text }, result => { void input.complete(submitted, { kind: 'feedback', id: result.item.id }, value); refresh(); onSaved(result.item.id); });
    else personal.send({ draft: submitted, value, planVersion: observation.inspection.planVersion ?? '', body: { id: crypto.randomUUID(), text, recipient: task ? { kind: 'task', id: task.id } : { kind: 'lead' }, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest }, ...(task ? { taskRef: { id: task.id, version: task.version } } : {}) } });
  }}><p>{tx('指导对象', 'Recipient')}: {task ? `${task.id} · ${task.version.slice(0, 12)}` : 'Lead'}</p>
    <Field label={tx('希望怎样改进这一步或路线', 'How should this step or route improve?')} value={text} onInput={text => input.update({ text, planVersion: observation.inspection.planVersion, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest } })} multiline required maxLength={4000} />
    <label class="research-check"><input type="checkbox" data-inline-confirm-guidance checked={checked} onChange={event => setConfirmed(event.currentTarget.checked ? signature : '')} />{tx('已核对当前命题、前提和指导对象', 'I reviewed the statement, premises and recipient')}</label>
    <button type="submit" class="button" data-inline-send-guidance disabled={busy || !checked || !canSend || Boolean(personal.attempt) || personal.blocked}>{tx('发送这条指导', 'Send this guidance')}</button><MutationState action={action} />
    {!project && <PersonalCommandStatus command={personal} />}
  </form></details>;
}

function PersonalCommandStatus({ command }: { command: ReturnType<typeof usePersonalGuidance> }) {
  return <><ErrorBox message={command.error} />{command.blocked && <button type="button" class="button" onClick={command.recover}>{tx('重新读取待确认记录', 'Reload pending records')}</button>}
    {command.attempt && <div role="status" data-inline-pending-guidance><p>{tx('这条指导的投递结果尚待确认。刷新后会继续查询原记录。', 'Delivery of this guidance is unconfirmed. Refreshing checks the original record.')}</p>
      <p>{tx('原指导对象', 'Original recipient')}: {command.attempt.body.taskRef ? `${command.attempt.body.taskRef.id} · ${command.attempt.body.taskRef.version}` : 'Lead'}</p><RichProse text={command.attempt.body.text} />
      <button type="button" class="button" data-inline-query-command disabled={command.busy} onClick={() => void command.query()}>{tx('查询原回执', 'Check the original receipt')}</button>
      {command.canRetry ? <button type="button" class="button" data-inline-retry-command disabled={command.busy} onClick={() => void command.retry()}>{tx('核对并重试原提交', 'Check and retry the original submission')}</button>
        : <p>{tx('原路线或任务版本已变化，只能查询原回执。', 'The original route or task version has changed. Only receipt checks are available.')}</p>}
    </div>}
    {command.receipt && <p role="status" data-inline-command-status={command.receipt.status}>{tx('运行回执', 'Run receipt')}: {command.receipt.status}{command.receipt.reason && <> · {command.receipt.reason}</>}</p>}</>;
}
