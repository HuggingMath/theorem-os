import { useEffect, useRef, useState } from 'preact/hooks';
import type { WebObservation } from '../collaboration';
import type { WebRun } from '../shared';
import type { ResearchFeedbackTarget, ResearchProjectDetail, ResearchRunBinding } from '../researchProjectTypes';
import type { ResearchProblem } from '../researchProblemTypes';
import type { ResearchBriefTask } from '../researchWorkspaceTypes';
import { RichProse } from './richText';
import { base, enc, ErrorBox, MutationState, theoremHref, tx, useMutation, useResource, type ResearchContext } from './researchShared';
import { FeedbackWorkspace, type FeedbackFocus } from './researchFeedback';
import { ProofSubmission } from './researchTheorems';
import { ProjectPlanApproval } from './researchPlanApproval';
import { InlinePersonalApproval } from './researchPersonalApproval';
import { ResearchAnnotations } from './researchAnnotations';
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
    <button type="button" class="button" data-inline-open onClick={() => drawer.current?.showModal()}>{task ? tx('处理这一步：候选与批注', 'Work on this step: candidates and comments') : tx('审阅路线并参与决定', 'Review the route and take action')}</button>
    <dialog ref={drawer} class="research-inline-drawer" data-inline-drawer aria-label={task ? tx('在这一步参与研究', 'Work on this step') : tx('审阅路线并参与决定', 'Review the route and take action')} onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.currentTarget.close(); } }}>
    <header><h3>{task ? tx('就在这一步参与研究', 'Work on this step here') : tx('审阅当前路线并参与决定', 'Review the route and take action')}</h3><button type="button" class="text-button" data-inline-close onClick={() => drawer.current?.close()}>{tx('关闭', 'Close')}</button></header>
    {task && <div class="research-inline-context" data-inline-math-context>{[
      [tx('要证明什么', 'Statement'), task.statement || task.objective], [tx('所用前提', 'Premises'), task.premises.join('\n')], [tx('怎样推出', 'Derivation'), task.derivation],
    ].map(([title, text]) => text && <section key={title}><h5>{title}</h5><RichProse text={text} /></section>)}<code>{task.version.slice(0, 12)}</code></div>}
    <ErrorBox message={resource.error} />{resource.error && <button type="button" class="text-button" onClick={resource.refresh}>{tx('重新核对可用操作', 'Reload available actions')}</button>}
    {!observation && !resource.error && <p role="status">{tx('正在读取当前任务与操作权限…', 'Loading the current task and available actions…')}</p>}
    {observation && run && <>
      {task && !current && <p class="research-status" data-inline-historical>{tx('当前显示的是历史任务版本。可以批注原文；认领和候选请使用当前任务版本。', 'This is a historical task version. You can annotate its original text. Use the current task version for claims and candidates.')}</p>}
      {project && binding ? <>
        <InlineProjectClaim project={project} binding={binding} observation={observation} task={current ? task : undefined} selfId={selfId} refresh={changed} />
        <ProjectPlanApproval project={project} binding={{ ...binding, status: run.status }} observation={observation} selfId={selfId} refresh={changed} />
      </> : !project && run.nativeTeamCapacity && run.planApproval && <InlinePersonalApproval key={`${selfId}:${run.id}`} owner={selfId} run={run} observation={observation} root={root} refresh={changed} />}
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
