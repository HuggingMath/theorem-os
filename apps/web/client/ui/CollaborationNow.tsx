import { render } from 'preact';
import { t } from '../../i18n';

/** `name` is the Agent's role name and `taskName` the task's theorem; the ids stay in tooltips. */
export type NowWorker = { id: string; name: string; phase: string; task?: string; taskName?: string; objective?: string };
export type NowState = { ended?: { accepted: boolean }; waiting?: string; working: readonly NowWorker[]; others: number };

/** The simple layer's answer to "what is happening": working Agents and their tasks, or a research wait. An ended run says its result in the route map instead. */
export function renderCollaborationNow(root: HTMLElement, state: NowState) {
  render(<>
    {state.waiting !== undefined && <div class="collab-now-waiting"><strong>{t('研究正在等待新的数学输入')}</strong>
      {state.waiting && <p>{state.waiting}</p>}<p class="collab-help">{t('可以在下方提供指导，补充思路或换一条路线。')}</p></div>}
    {state.working.length ? <ul class="collab-now-list">{state.working.map(worker => <li key={worker.id} class="collab-now-worker">
      <span class="collab-now-who" title={worker.id}><span class="collab-agent-dot" aria-hidden="true" />{worker.name}<small>{worker.phase}</small></span>
      {worker.task ? <span class="collab-now-task"><button type="button" class="text-button" data-collab-task={worker.task} data-focus-key={`now-task-${worker.id}`}
        aria-label={t('查看任务 {0}', worker.taskName ?? worker.task)}>{worker.taskName ?? worker.task} →</button>{worker.objective && <span class="collab-now-objective">{worker.objective}</span>}</span>
        : <span class="collab-agent-idle">{t('未分配')}</span>}
    </li>)}</ul> : !state.ended && <p class="collab-help">{t('现在没有 Agent 在工作。')}</p>}
    {!state.ended && state.others > 0 && <p class="collab-help">{t('另有 {0} 个 Agent 空闲、准备中或已停止。', state.others)}</p>}
  </>, root);
}
