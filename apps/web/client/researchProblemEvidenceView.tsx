import type { ResearchBriefDecision, ResearchBriefTask } from '../researchWorkspaceTypes';
import type { ResearchProblem } from '../researchProblemTypes';
import { useState } from 'preact/hooks';
import { Rich, RichProse } from './richText';
import { Empty, tx } from './researchShared';
import { problemAttention, type ProblemAttentionItem } from './researchProblemModel';
import { locale } from '../i18n';

export function ProblemAttention({ problem, selfId, onTask, onFeedback }: { problem: ResearchProblem; selfId?: string;
  onTask(task: NonNullable<ProblemAttentionItem['taskRef']>): void; onFeedback(id: string, task?: ProblemAttentionItem['taskRef']): void }) {
  const items = problemAttention(problem, locale, selfId), [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, 5);
  return <div class="problem-attention" data-problem-attention data-problem-attention-count={items.length}>
    {!items.length && <Empty>{tx('当前记录没有待处理的阻碍、评审或交接。可继续查看完整证明路线。', 'The current record has no pending blockers, reviews or handoffs. Continue with the full proof route.')}</Empty>}
    {visible.map(item => <article key={item.id} data-problem-attention-item={item.id} data-attention-kind={item.kind}>
      <div class="problem-attention-body"><h3><Rich text={item.title} /></h3><RichProse text={item.detail} />
        <p class="problem-responsibility">{tx('当前负责', 'Recorded responsibility')}: {item.owners.length ? item.owners.map((owner, index) => <span key={`${owner.kind}:${owner.id}`}>{index > 0 && ' · '}{owner.kind === 'human'
          ? <a href={`people.html?id=${encodeURIComponent(owner.id)}`}>{owner.name}</a> : owner.name}</span>) : tx('尚未记录', 'Not assigned in this record')}</p>
        {item.taskRef && <p class="problem-attention-version"><code>{item.taskRef.id}</code> · <code title={item.taskRef.version}>{item.taskRef.version.slice(0, 12)}</code></p>}
      </div>
      <div class="problem-attention-action">{item.feedbackId ? <a class="button" href={item.href} onClick={event => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); onFeedback(item.feedbackId!, item.taskRef);
      }}>{item.action} →</a>
        : item.href ? <a class="button" href={item.href}>{item.action} →</a> : item.taskRef && <button type="button" class="button" onClick={() => onTask(item.taskRef!)}>{item.action} →</button>}</div>
    </article>)}
    {items.length > 5 && <button type="button" class="text-button problem-attention-toggle" data-problem-attention-expand aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? tx('收起其余事项', 'Show fewer items') : tx(`查看其余 ${items.length - 5} 项`, `Show ${items.length - 5} more items`)}</button>}
  </div>;
}

export function ProblemTaskEvidence({ task, tasks, missing }: { task?: ResearchBriefTask; tasks: ResearchBriefTask[]; missing?: string }) {
  if (!task) return <p class="research-status" data-problem-task-absent>{missing ?? tx('此记录没有这个任务版本。', 'This record has no matching task version.')}</p>;
  const dependencies = task.dependsOn.map(id => tasks.find(item => item.id === id)?.title ?? id);
  return <article class="problem-task-evidence" data-problem-task-evidence={task.id} data-task-version={task.version}>
    <h4><Rich text={task.title} /></h4>
    {[ [tx('要证明什么', 'Statement'), task.statement || task.objective],
      [tx('所用前提', 'Premises'), task.premises.join('\n')],
      [tx('这一步怎样推出', 'Derivation'), task.derivation],
      [tx('依赖哪些步骤', 'Prerequisites'), dependencies.join('\n')],
      [tx('得到的结论', 'Finding'), task.finding], [tx('尚待解决', 'Open feedback'), task.feedback] ].map(([label, text]) =>
        text && <section key={label}><h5>{label}</h5><RichProse text={text} /></section>)}
    {!task.derivation && <p class="research-status">{tx('这个版本未保存逐步推导。', 'No step-by-step derivation was saved for this version.')}</p>}
    <section><h5>{tx('这一版本的检查', 'Checks for this version')}</h5>{task.checks.length ? task.checks.map(check => <p key={check.id} data-problem-evidence-check={check.id}>
      {check.passed ? tx('任务检查通过', 'Task check passed') : tx('任务检查未通过', 'Task check failed')} · <code>{check.id}</code></p>)
      : <p>{tx('没有匹配这个任务、源码和环境版本的检查回执。', 'No check receipt matches this task, source and environment version.')}</p>}</section>
    <details><summary>{tx('版本与源码', 'Version and source')}</summary><p>{tx('任务版本', 'Task version')}: <code>{task.version}</code></p>
      {task.commit && <p>Commit: <code>{task.commit}</code></p>}{task.sourceDigest && <p>Source: <code>{task.sourceDigest}</code></p>}
      {task.environmentDigest && <p>{tx('环境', 'Environment')}: <code>{task.environmentDigest}</code></p>}</details>
    <a class="text-button" href={task.href}>{tx('打开此任务版本', 'Open this task version')} ↗</a>
  </article>;
}

export function ProblemDecisionEvidence({ decision, problem, onTask }: { decision: ResearchBriefDecision; problem: ResearchProblem; onTask(id: string): void }) {
  const refs = decision.taskRefs ?? [], ids = [...new Set([...(decision.before?.tasks ?? []).map(task => task.id), ...(decision.after?.tasks ?? []).map(task => task.id)])];
  const [chosen, setChosen] = useState(ids[0] ?? '');
  const taskId = ids.includes(chosen) ? chosen : ids[0] ?? '';
  const labels = { target: tx('投递目标', 'Delivery target'), reference: tx('引用的任务', 'Referenced task'), execution: tx('执行记录关联', 'Execution record'), plan: tx('批准计划内任务', 'Task in approved plan') };
  return <section class="problem-decision-evidence" data-problem-decision-evidence={decision.id}>
    <header><h3>{decision.kind === 'plan-edit' ? tx('人工修改计划', 'Human plan edit') : decision.kind === 'plan-approval' ? tx('人工批准计划', 'Human plan approval') : tx('人工决定与对应路线', 'Human decision and linked route')}</h3>
      {!decision.kind && <RichProse text={decision.text} />}{decision.reason && <RichProse text={decision.reason} />}</header>
    <div class="problem-decision-refs">{refs.map(ref => {
      const current = problem.brief.tasks.find(task => task.id === ref.id && task.version === ref.version);
      const saved = [...(decision.before?.tasks ?? []), ...(decision.after?.tasks ?? [])].find(task => task.id === ref.id && task.version === ref.version);
      return <div key={`${ref.relation}:${ref.id}:${ref.version}`} data-decision-task-ref={ref.id} data-current-version={Boolean(current)}>
        <span>{labels[ref.relation]}</span><strong><Rich text={current?.title ?? saved?.title ?? ref.id} /></strong><code>{ref.version.slice(0, 12)}</code>
        {current ? <button type="button" class="text-button" onClick={() => onTask(ref.id)}>{tx('定位当前路线', 'Locate in current route')} →</button>
          : saved ? <a class="text-button" href={saved.href}>{tx('查看所引用的历史版本', 'Open referenced historical version')} ↗</a>
            : <span>{tx('历史版本未载入', 'Historical version not loaded')}</span>}
      </div>;
    })}</div>
    {!refs.length && <p class="research-status" data-decision-unbound>{tx('这条决定没有保存任务版本关联，当前路线中无法确定受影响的步骤。', 'This decision has no recorded task version links, so affected steps cannot be identified in the current route.')}</p>}
    <h4>{tx('对照决定引用的前后记录', 'Compare the records linked to this decision')}</h4>
    {ids.length > 1 && <label class="research-field">{tx('对照步骤', 'Compare step')}<select data-decision-compare-task value={taskId} onChange={event => setChosen(event.currentTarget.value)}>{ids.map(id => <option key={id} value={id}>{decision.after?.tasks.find(task => task.id === id)?.title ?? decision.before?.tasks.find(task => task.id === id)?.title ?? id}</option>)}</select></label>}
    <div class="problem-evidence-comparison">{(['before', 'after'] as const).map(side => {
      const snapshot = decision[side], title = side === 'before' ? tx('决定的基础记录', 'Decision baseline') : tx('明确关联的结果记录', 'Explicitly linked result');
      return <section key={side} data-decision-snapshot={side}><h4>{title}</h4>{snapshot ? <>
        <p class="problem-snapshot-meta">{tx('记录', 'Observation')} {snapshot.sequence}{snapshot.planVersion && <> · <code>{snapshot.planVersion.slice(0, 12)}</code></>}</p>
        <ProblemTaskEvidence task={snapshot.tasks.find(task => task.id === taskId)} tasks={snapshot.tasks} missing={side === 'before' ? tx('基础记录中没有这个任务。', 'This task is absent from the baseline.') : tx('关联结果中没有这个任务。', 'This task is absent from the linked result.')} />
      </> : <p class="research-status" data-decision-snapshot-missing={side}>{side === 'before' ? tx('未保存能精确对应基础版本的快照。', 'No saved snapshot exactly matches the baseline.') : tx('没有对应任务版本、计划或回执的结果快照，无法展示决定后的推导变化。', 'No result snapshot matches the recorded task version, plan or receipt. Derivation changes after this decision cannot be shown.')}</p>}</section>;
    })}</div>
  </section>;
}
