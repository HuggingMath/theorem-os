import type { ResearchFeedback, ResearchFeedbackTarget } from '../researchProjectTypes';
import type { WebGuidanceRecord } from '../collaboration';
import { locale } from '../i18n';
import { guidanceOutcome } from './guidanceOutcomeModel';
import { RichProse } from './richText';

const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
export type GuidanceOutcomeProps = { feedback?: ResearchFeedback; guidance?: WebGuidanceRecord;
  onOpenTask?: (target: ResearchFeedbackTarget, task: { id: string; version: string }) => void;
  onOpenRunTask?: (task: { id: string; version: string }) => void };

export function GuidanceOutcome({ feedback, guidance, onOpenTask, onOpenRunTask }: GuidanceOutcomeProps) {
  const outcome = guidanceOutcome(feedback, guidance);
  if (!outcome.recorded) return <p class="guidance-outcome-waiting" data-guidance-outcome="not-recorded">{tx('待观察后续', 'Waiting for follow-up')}</p>;
  const delivery = { 'not-sent': tx('尚未发送', 'Not sent'), queued: tx('排队中', 'Queued'), delivered: tx('已送达', 'Delivered'),
    deferred: tx('暂缓投递', 'Delivery deferred'), failed: tx('投递失败', 'Delivery failed'), unknown: tx('投递待核对', 'Delivery unconfirmed') };
  const decision = { pending: tx('等待判断', 'Awaiting a decision'), accepted: tx('已采纳', 'Accepted'), declined: tx('未采纳', 'Declined'),
    'needs-info': tx('需要补充', 'Needs information'), 'not-recorded': tx('采纳情况暂无记录', 'No adoption decision recorded') };
  const execution = { 'not-started': tx('尚未执行', 'Not started'), running: tx('执行中', 'Executing'), completed: tx('执行已完成', 'Execution completed'),
    failed: tx('执行失败', 'Execution failed'), superseded: tx('已由后续安排接替', 'Superseded') };
  const taskHref = (task: { id: string; version: string }) => `theorems.html?${new URLSearchParams({ id: outcome.projectId!,
    run: outcome.target!.runId, version: outcome.target!.statementVersionId, task: task.id, taskVersion: task.version })}`;
  return <div class="guidance-outcome" data-guidance-outcome={outcome.decision!.status} data-guidance-feedback-id={feedback?.id} data-guidance-record-id={guidance?.id}>
    <ol class="guidance-outcome-stages" aria-label={tx('指导后续进展', 'Guidance follow-up')}>
      <li><span>{tx('投递', 'Delivery')}</span><strong>{delivery[outcome.delivery!.status]}</strong></li>
      <li><span>{tx('判断', 'Decision')}</span><strong>{decision[outcome.decision!.status]}</strong></li>
      <li><span>{tx('执行', 'Execution')}</span><strong>{outcome.execution ? execution[outcome.execution.status] : tx('暂无记录', 'Not recorded')}</strong></li>
    </ol>
    <details class="guidance-outcome-details"><summary>{tx('查看理由与后续记录', 'View the reason and follow-up records')}</summary>
      {outcome.decision!.reason ? <div class="guidance-outcome-reason" translate={false}><RichProse text={outcome.decision!.reason} /></div>
        : <p>{tx('判断理由暂无记录。', 'No decision reason recorded.')}</p>}
      {outcome.decision!.actor && <p>{tx('记录人：', 'Recorded by: ')}{outcome.decision!.actor.displayName}{outcome.decision!.decidedAt && <> · <time dateTime={outcome.decision!.decidedAt}>{new Date(outcome.decision!.decidedAt).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN')}</time></>}</p>}
      {outcome.delivery!.reason && <p>{tx('投递记录：', 'Delivery record: ')}{outcome.delivery!.reason}</p>}
      {outcome.execution?.planVersion && <p>{tx('执行关联计划：', 'Execution plan: ')}<code>{outcome.execution.planVersion}</code></p>}
      {outcome.decision!.sourcePlanVersion && <p>{tx('作出判断时的计划：', 'Plan when decided: ')}<code>{outcome.decision!.sourcePlanVersion}</code></p>}
      {outcome.target && outcome.taskRefs.length > 0 && <ul class="guidance-outcome-tasks">{outcome.taskRefs.map(task => <li key={`${task.id}:${task.version}`}><a href={taskHref(task)}
        onClick={event => { if (!onOpenTask || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpenTask(outcome.target!, task); }}>
        {tx('查看执行节点', 'View execution node')} · {task.id}</a><code>{task.version}</code></li>)}</ul>}
      {outcome.decisionTaskRefs.length > 0 && <ul class="guidance-outcome-tasks">{outcome.decisionTaskRefs.map(task => <li key={`${task.id}:${task.version}`}>
        {onOpenRunTask ? <button type="button" class="text-button" onClick={() => onOpenRunTask(task)}>{tx('查看判断关联节点', 'View a node referenced by the decision')} · {task.id}</button>
          : <span>{tx('判断关联节点', 'Node referenced by the decision')} · {task.id}</span>}<code>{task.version}</code></li>)}</ul>}
      {outcome.evidenceRefs.length > 0 && <div class="guidance-outcome-evidence"><strong>{tx('记录中的结果与证据', 'Recorded results and evidence')}</strong><ul>{outcome.evidenceRefs.map(ref => <li key={ref}><code>{ref}</code></li>)}</ul></div>}
    </details>
  </div>;
}
