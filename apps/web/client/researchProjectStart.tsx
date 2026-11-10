import { useState } from 'preact/hooks';
import type { ResearchProblem } from '../researchProblemTypes';
import type { ResearchProjectDetail } from '../researchProjectTypes';
import { Field, MutationState, base, enc, tx, useMutation, type Item } from './researchShared';
import { RichProse } from './richText';

export function ProjectFromProblem({ problem, onCreated }: { problem: ResearchProblem; onCreated(projectId: string): void }) {
  const [title, setTitle] = useState(problem.brief.title.slice(0, 200)), [confirmed, setConfirmed] = useState(false), action = useMutation();
  if (problem.project) return null;
  return <details class="problem-project-start" data-project-from-problem><summary>{tx('从这道题创建协作项目', 'Create a project from this problem')}</summary>
    <p>{tx('带入原题和这次运行的路线、检查与成果。项目先仅自己可见，创建后可邀请同行；个人笔记与预算继续保留在自己的账号。',
      'Bring the original problem, this run, its route, checks and outcomes. The project starts private. Invite colleagues afterwards; personal notes and budgets stay in your account.')}</p>
    <form class="research-form" onSubmit={event => { event.preventDefault(); if (!confirmed) return;
      void action.run<Item<ResearchProjectDetail>>('POST', `${base}/workspace/problem/${enc(problem.brief.selectedRunId)}/project`, { title: title.trim(), confirmed: true }, result => onCreated(result.item.id)); }}>
      <Field label={tx('项目名称', 'Project name')} value={title} onInput={setTitle} required maxLength={200} />
      <RichProse text={problem.brief.statement} /><details><summary>{tx('核对原题源码', 'Review the original source')}</summary><pre class="research-block-code"><code>{problem.brief.leanStatement}</code></pre></details>
      <label class="research-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.currentTarget.checked)} />{tx('我已核对原题和运行，可以建立私有项目', 'I reviewed the problem and run and want to create a private project')}</label>
      <MutationState action={action} /><button class="button" type="submit" disabled={action.busy || !confirmed}>{tx('创建项目并继续', 'Create project and continue')}</button>
    </form>
  </details>;
}
