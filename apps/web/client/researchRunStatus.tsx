import type { ResearchProblem } from '../researchProblemTypes';
import { localizeMessage } from '../i18n';
import { formatDuration } from '../presentation';
import { RichProse } from './richText';
import { tx, stamp } from './researchShared';

export function ProblemRunStatus({ problem, openRoute, reviewPlan }: { problem: ResearchProblem; openRoute(): void; reviewPlan(): void }) {
  const state = problem.runState;
  if (!state) return null;
  const waiting = state.waitingForApproval && !state.revisingPlan;
  return <section class="problem-run-state" data-problem-run-state={state.status} aria-labelledby="problem-run-state-title">
    <header><div><p class="research-eyebrow">{tx('这次尝试', 'This attempt')}</p><h2 id="problem-run-state-title">{localizeMessage(state.title)}</h2></div>
      <span>{tx('已用时', 'Elapsed')} {formatDuration(state.elapsedMs)}</span></header>
    <RichProse text={localizeMessage(state.detail)} />
    {!state.hasTaskRoute && <p class="problem-run-route-note">{state.active ? tx('任务路线还未生成；准备和计划进度会在这里更新。', 'The task route is not ready yet. Preparation and planning progress will update here.')
      : tx('这次尝试结束前没有生成任务路线。可先处理结束原因，再准备新的尝试。', 'This attempt ended before a task route was recorded. Address the reason above before preparing another attempt.')}</p>}
    {state.stalledMinutes !== undefined && <p role="status">{tx(`已有 ${state.stalledMinutes} 分钟没有新的检查通过或结果集成。`, `No new passing check or integrated result in ${state.stalledMinutes} minutes.`)}</p>}
    <div class="research-actions">
      {waiting ? <button type="button" class="button button-primary" data-problem-review-plan onClick={reviewPlan}>{tx('审阅计划并决定', 'Review the plan and decide')}</button>
        : state.actions.length > 0 ? state.actions.map((action, index) => <a key={action.id} class={`button${index === 0 ? ' button-primary' : ''}`} data-problem-recovery={action.id} href={action.href}>{localizeMessage(action.label)}</a>)
          : state.hasTaskRoute ? <button type="button" class="button button-primary" onClick={openRoute}>{tx('查看当前证明路线', 'Read the current proof route')}</button>
            : <a class="button button-primary" href={state.controlsHref}>{tx('查看运行进度', 'View run progress')}</a>}
      {state.active && <a class="button" data-problem-run-controls href={state.controlsHref}>{tx('管理或停止本次运行', 'Manage or stop this run')}</a>}
      {!state.active && state.hasTaskRoute && state.actions.length > 0 && <button type="button" class="text-button" onClick={openRoute}>{tx('先阅读已保存的路线', 'Read the saved route first')}</button>}
    </div>
    <p class="problem-run-updated">{tx('记录更新', 'Record updated')} {stamp(state.updatedAt)}</p>
  </section>;
}
