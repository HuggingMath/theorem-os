import { useState } from 'preact/hooks';
import { locale } from '../i18n';
import type { ResearchIssue } from '../researchCollaborationTypes';
import type { ResearchStageConclusion, ResearchStageReference } from '../researchProblemTypes';
import type { ResearchProjectDetail } from '../researchProjectTypes';
import { Rich, RichProse } from './richText';
import { problemSolutionRoute, problemOutcomeLabel } from './researchProblemModel';
import { SolutionRouteGraph } from './ui/SolutionRouteGraph';
import { base, enc, Field, MutationState, personHref, stamp, tx, useMutation, type Item } from './researchShared';

const issueHref = (projectId: string, runId: string, issueId: string) => `problem.html?${new URLSearchParams({ project: projectId, run: runId, tab: 'discussion' })}#issue-${issueId}`;

export function StageProjectReference({ stage, project, references = [], refresh }: {
  stage: ResearchStageConclusion; project?: ResearchProjectDetail; references?: ResearchIssue[]; refresh?(): void;
}) {
  const [title, setTitle] = useState(stage.title), [text, setText] = useState(tx('请基于这份阶段结论讨论下一步。', 'Discuss the next step using this stage conclusion.'));
  const [saved, setSaved] = useState<ResearchIssue>(), action = useMutation();
  if (!project?.permissions.edit) return null;
  const existing = saved ?? references.find(issue => issue.stageReference?.stageId === stage.id);
  return <div class="research-stage-reference-control" data-stage-reference-control={stage.id}>
    {existing ? <p role="status"><a data-stage-reference-link href={issueHref(project.id, stage.snapshot.selectedRunId, existing.id)}>{tx('继续讨论这份阶段结论', 'Continue the discussion of this conclusion')}</a></p>
      : <details><summary>{tx('引用到项目议题', 'Reference in a project issue')}</summary>
        <p>{tx('将这份结论、作者和定稿时的路线与检查版本加入项目议题，项目成员可见。', 'Add this conclusion, its author, and the saved route and check versions to an issue visible to project members.')}</p>
        <form class="research-form" onSubmit={event => { event.preventDefault(); void action.run<Item<ResearchIssue>>('POST', `${base}/workspace/problem/${enc(stage.snapshot.selectedRunId)}/stages/${enc(stage.id)}/reference`,
          { projectId: project.id, title, text }, result => { setSaved(result.item); refresh?.(); }); }}>
          <Field label={tx('议题名称', 'Issue title')} value={title} onInput={setTitle} required maxLength={200} />
          <Field label={tx('希望共同讨论什么', 'What should the project discuss?')} value={text} onInput={setText} required multiline maxLength={4000} />
          <div class="collaboration-resolution"><strong><Rich text={stage.title} /></strong><RichProse text={stage.conclusion} />
            <p>{tx('引用证据', 'Referenced evidence')}: <code>{stage.evidenceDigest.slice(0, 16)}</code> · {stage.snapshot.tasks.length} {tx('个路线节点', 'route nodes')}</p></div>
          <button type="submit" class="button" data-stage-reference-submit disabled={action.busy}>{tx('创建项目议题并引用', 'Create issue with this reference')}</button><MutationState action={action} />
        </form>
      </details>}
  </div>;
}

export function SharedStageReference({ reference }: { reference: ResearchStageReference }) {
  const snapshot = reference.snapshot;
  return <section class="collaboration-stage-reference" data-shared-stage-reference={reference.stageId}>
    <header><h5>{tx('引用的阶段结论', 'Referenced stage conclusion')}</h5><p><a href={personHref(reference.author.id)}>{reference.author.displayName}</a> · <time dateTime={reference.createdAt}>{stamp(reference.createdAt)}</time></p></header>
    <h5><Rich text={reference.title} /></h5>
    {([[tx('已确认的结论', 'Confirmed conclusion'), reference.conclusion], [tx('适用条件与边界', 'Conditions and boundaries'), reference.boundaries],
      [tx('未解决的问题', 'Unresolved questions'), reference.unresolved], [tx('下一步', 'Next step'), reference.next]] as const).map(([label, text]) => text && <section key={label}><h6>{label}</h6><RichProse text={text} /></section>)}
    <details data-stage-reference-evidence><summary>{tx('定稿时的路线与证据', 'Frozen route and evidence')}</summary>
      <p><code>{reference.evidenceDigest}</code></p><RichProse text={snapshot.statement} />
      <p>{tx('定稿时的独立验收', 'Acceptance recorded at that stage')}: {problemOutcomeLabel(snapshot.acceptance.status, locale)}</p>
      <SolutionRouteGraph model={{ ...problemSolutionRoute(snapshot, locale), id: `stage-reference:${reference.stageId}` }} onOpen={id => { const task = snapshot.tasks.find(item => item.id === id); if (task) location.assign(task.href); }} />
      {snapshot.tasks.map(task => <p key={task.id}><Rich text={task.title} /> · <code>{task.version}</code>{task.checks.map(check => <span key={check.id}> · {check.passed ? tx('检查通过', 'Check passed') : tx('检查未过', 'Check failed')} <code>{check.id}</code></span>)}</p>)}
      <a href={snapshot.runHref}>{tx('查看所引用的运行', 'Open the referenced run')}</a>
    </details>
  </section>;
}
