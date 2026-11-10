import { useRef } from 'preact/hooks';
import type { WebPlan, WebPlanTask } from '../collaboration';
import { locale } from '../i18n';
import { Rich, RichProse } from './richText';
import { hasPlanSummaryContent, summarizePlanDecision, type DecisionImpact, type DecisionReason, type PlanTaskChange } from './decisionSummaryModel';

const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
const taskName = (task: WebPlanTask | undefined, id: string) => task?.theoremName || id;
const fieldNames: Partial<Record<keyof WebPlanTask, string>> = {
  kind: tx('类型', 'type'), objective: tx('目标', 'objective'), dependsOn: tx('前置依赖', 'dependencies'), proofPath: tx('证明文件', 'proof file'),
  theoremName: tx('声明名称', 'declaration'), type: tx('Lean 类型', 'Lean type'), groupId: tx('分组', 'group'), sharing: tx('共享范围', 'sharing'),
  status: tx('调度状态', 'scheduling'), ownerId: tx('负责人', 'owner'), premises: tx('前提', 'premises'), conditional: tx('条件检查', 'conditional checks'),
  statementReview: tx('陈述审核', 'statement review'), informalStatement: tx('数学陈述', 'mathematical statement'), informalProof: tx('证明思路', 'proof outline'),
  citations: tx('引用', 'citations'), consumerGoalIds: tx('关联目标', 'linked goals'), reviewScope: tx('审核范围', 'review scope'), declaration: tx('声明种类', 'declaration kind'),
};

/** Retain the last plan actually viewed in this scope, so a revision has a concrete comparison. */
export function usePreviousDecisionPlan(plan: WebPlan | null | undefined, scope: string): WebPlan | undefined {
  const viewed = useRef<{ scope: string; current?: WebPlan; previous?: WebPlan }>({ scope });
  if (viewed.current.scope !== scope) viewed.current = { scope };
  if (plan && viewed.current.current?.baseVersion !== plan.baseVersion) {
    viewed.current.previous = viewed.current.current;
    viewed.current.current = structuredClone(plan);
  }
  return viewed.current.previous;
}

export type DecisionSummaryProps = {
  plan: WebPlan | null | undefined; previousPlan?: WebPlan | null; expectedVersion?: string;
  impact?: DecisionImpact; reason?: DecisionReason; mode?: 'approval' | 'edit'; onOpenTask?: (taskId: string) => void;
};

export function DecisionSummary({ plan, previousPlan, expectedVersion, impact, reason, mode = 'approval', onOpenTask }: DecisionSummaryProps) {
  if (!plan || expectedVersion && plan.baseVersion !== expectedVersion) return <p class="decision-summary-empty" data-decision-summary-waiting>
    {tx('正在读取此版本的计划。', 'Loading this version of the plan.')}</p>;
  if (!hasPlanSummaryContent(plan)) return <p class="decision-summary-empty" data-decision-summary-incomplete>{tx('补全任务与依赖后，可查看计划摘要。', 'Complete the tasks and dependencies to review the plan summary.')}</p>;
  const summary = summarizePlanDecision(plan, previousPlan, impact, reason), comparison = summary.comparison;
  const changed = comparison?.changes.filter(change => change.kind === 'changed').length ?? 0;
  const added = comparison?.changes.filter(change => change.kind === 'added').length ?? 0;
  const removed = comparison?.changes.filter(change => change.kind === 'removed').length ?? 0;
  const task = (id: string, fallback?: WebPlanTask) => {
    const current = plan.tasks.find(item => item.id === id), item = current ?? fallback;
    return onOpenTask && current ? <button class="text-button" type="button" onClick={() => onOpenTask(id)}>{taskName(item, id)}</button>
      : <code>{taskName(item, id)}</code>;
  };
  const changeLabel = (change: PlanTaskChange) => change.kind === 'added' ? tx('新增', 'Added') : change.kind === 'removed' ? tx('移除', 'Removed') : tx('调整', 'Changed');
  const impactLabels = { preview: tx('预览影响', 'Previewed impact'), received: tx('等待应用', 'Awaiting application'),
    applied: tx('计划已应用', 'Plan applied'), rejected: tx('调整未应用', 'Change rejected'), unknown: tx('应用情况待核对', 'Application unconfirmed'),
    stale: tx('草稿已变化，请重新预览影响。', 'The draft changed. Preview its impact again.') };
  return <section class="decision-summary" data-decision-summary data-plan-version={plan.baseVersion}>
    <div class="decision-summary-heading"><strong>{mode === 'edit' ? tx('这次调整', 'This change') : tx('计划要点', 'Plan at a glance')}</strong>
      <span>{tx(`${summary.goals.length} 个目标 · ${summary.supportTasks.length} 个子任务`, `${summary.goals.length} goals · ${summary.supportTasks.length} subtasks`)}</span></div>
    {summary.goals.slice(0, 2).map(goal => <div class="decision-summary-goal" key={goal.id} translate={false}><Rich text={goal.informalStatement || goal.objective || goal.type || goal.id} /></div>)}
    {summary.entryTasks.length > 0 && summary.supportTasks.length > 0 && <p class="decision-summary-entry">{tx('从这里展开：', 'Start from: ')}
      {summary.entryTasks.slice(0, 2).map((entry, index) => <span key={entry.id}>{index ? ' · ' : ''}<Rich text={entry.informalStatement || entry.objective || entry.id} /></span>)}
      {summary.entryTasks.length > 2 && tx(`等 ${summary.entryTasks.length} 个起点`, ` and ${summary.entryTasks.length - 2} more starting points`)}</p>}
    {comparison && <p class="decision-summary-change" data-decision-summary-changes>{comparison.changes.length || comparison.routesChanged || comparison.groupsChanged
      ? tx(`新增 ${added} · 调整 ${changed} · 移除 ${removed}${comparison.routesChanged ? tx(' · 路线有变化', ' · routes changed') : ''}${comparison.groupsChanged ? tx(' · 分工有变化', ' · assignments changed') : ''}`,
        `${added} added · ${changed} changed · ${removed} removed${comparison.routesChanged ? ' · routes changed' : ''}${comparison.groupsChanged ? ' · assignments changed' : ''}`)
      : tx('与对照版本的任务和路线一致。', 'Tasks and routes match the comparison version.')}</p>}
    {summary.impact && <p class="decision-summary-impact" data-decision-impact={summary.impact.status}>{impactLabels[summary.impact.status]}
      {summary.impact.affectedTaskIds && tx(` · 涉及 ${summary.impact.affectedTaskIds.length} 个任务`, ` · ${summary.impact.affectedTaskIds.length} tasks affected`)}</p>}
    <details class="decision-summary-details" data-decision-summary-details data-detail-key="decision-summary"><summary>{tx('查看任务衔接与调整详情', 'Review task connections and changes')}</summary>
      <dl class="decision-summary-facts"><div><dt>{tx('计划版本', 'Plan version')}</dt><dd><code>{plan.baseVersion}</code></dd></div>
        {comparison && <div><dt>{tx('对照版本', 'Compared with')}</dt><dd><code>{comparison.version}</code></dd></div>}
        <div><dt>{tx('调整理由', 'Reason for this plan')}</dt><dd>{summary.reason ? <><RichProse text={summary.reason.text} /><span>{summary.reason.source}</span></> : tx('暂无记录', 'Not recorded')}</dd></div></dl>
      <ol class="decision-summary-tasks">{plan.tasks.map(item => <li key={item.id}><div>{task(item.id)}<span>{item.kind === 'goal' ? tx('原始目标', 'Original goal') : item.kind === 'lemma' ? tx('引理', 'Lemma') : item.kind === 'research' ? tx('研究', 'Research') : tx('证明草图', 'Proof sketch')}</span></div>
        <div translate={false}><Rich text={item.informalStatement || item.objective || item.id} /></div>
        <p>{item.dependsOn.length ? tx('先完成：', 'Depends on: ') : tx('无前置依赖', 'No prerequisites')}{item.dependsOn.map((id, index) => <span key={id}>{index ? ' + ' : ''}{task(id)}</span>)}</p></li>)}</ol>
      {summary.routes.length > 0 && <div class="decision-summary-routes"><strong>{tx('可选证明路线', 'Alternative proof routes')}</strong>{summary.routes.map(route => <p key={route.id}><code>{route.id}</code><span> · </span>
        {route.prerequisiteTaskIds.map((id, index) => <span key={id}>{index ? ' + ' : ''}{task(id)}</span>)}{route.prerequisiteTaskIds.length ? ' → ' : ''}{task(route.closingTaskId)}{' → '}{task(route.targetTaskId)}</p>)}</div>}
      {comparison && comparison.changes.length > 0 && <ul class="decision-summary-diff">{comparison.changes.map(change => <li key={change.taskId}><strong>{changeLabel(change)} </strong>{task(change.taskId, change.before)}
        {change.fields.length > 0 && <span> · {change.fields.map(field => fieldNames[field] ?? field).join(tx('、', ', '))}</span>}
        {change.fields.includes('dependsOn') && <p>{tx('前置依赖：', 'Dependencies: ')}<code>{change.before?.dependsOn.join(' + ') || '∅'}</code>{' → '}<code>{change.after?.dependsOn.join(' + ') || '∅'}</code></p>}</li>)}</ul>}
      {summary.impact?.affectedTaskIds && <p>{tx('预览或应用回执中的关联任务：', 'Tasks named by the preview or application receipt: ')}{summary.impact.affectedTaskIds.length ? summary.impact.affectedTaskIds.map((id, index) => <span key={id}>{index ? ' · ' : ''}{task(id)}</span>) : tx('无', 'None')}</p>}
      {summary.impact?.recheck && <div class="decision-summary-recheck" data-decision-recheck><strong>{tx('重新检查记录', 'Recheck record')} · {summary.impact.recheck.status}</strong>
        <ul>{summary.impact.recheck.tasks.map(item => <li key={`${item.taskId}:${item.taskDigest}`}>{task(item.taskId)} · <code>{item.taskDigest}</code> · {item.status}{item.reason && <p>{item.reason}</p>}</li>)}</ul></div>}
    </details>
  </section>;
}
