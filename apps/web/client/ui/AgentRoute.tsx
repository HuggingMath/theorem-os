import { render } from 'preact';
import type { AgentRoute, RouteStep } from '../agentRoute';
import { Spinner } from './Icon';
import { t } from '../../i18n';

export type AgentRouteProps = {
  /** `name` is what the reader calls the Agent (its role); the id stays in the tooltip. */
  routes: readonly (AgentRoute & { name?: string })[];
  /** Short theorem names of the plan's tasks, shown instead of task ids. */ tasks: ReadonlyMap<string, string>;
  /** The last step of each Agent is live while the run is. */ running: boolean;
  /** An ended run's one-line outcome (see endedSummary) under the lanes, with a link to its report. */ ended?: string;
  /** Proof tasks in the Lead's plan; zero means the run was solved without splitting. */ planned: number;
  /** Where the plan's dependency graph is: below the map in the collaboration tab, or in that tab when the map stands alone. */ graph?: 'below' | 'elsewhere';
  time: (at: string) => string;
};

// A long run keeps its newest steps on screen; the full sequence stays in the activity tab.
const shownSteps = 12;
const stepLabel = (step: RouteStep, tasks: AgentRouteProps['tasks']) => {
  const task = step.taskId && tasks.get(step.taskId) ? ` ${tasks.get(step.taskId)}` : '';
  switch (step.kind) {
    case 'read': return step.taskId ? t('接任务{0}', task) : t('读题');
    case 'write': return step.reviewing ? t('审阅候选') : step.count > 1 ? t('写证明 ×{0}', step.count) : t('写证明');
    case 'check': return step.count > 1 ? t('Lean 检查 ×{0}', step.count) : t('Lean 检查');
    case 'deliver': return t('交付{0}', task);
    case 'accept': return t('独立验收');
    case 'stop': return t('会话停止');
  }
};
const outcomeLabel = { passed: t('通过'), failed: t('未通过') } as const;
const nameOf = (route: AgentRouteProps['routes'][number]) => route.name ?? route.workerId;

function Lane({ route, running, tasks, time }: { route: AgentRouteProps['routes'][number]; running: boolean; tasks: AgentRouteProps['tasks']; time: AgentRouteProps['time'] }) {
  const hidden = Math.max(0, route.steps.length - shownSteps), steps = route.steps.slice(hidden);
  const live = running && !['deliver', 'stop'].includes(steps.at(-1)!.kind) && !steps.at(-1)!.outcome;
  return <li class="agent-route-lane" data-worker-id={route.workerId}>
    <span class="agent-route-who" title={route.workerId}><span class="collab-agent-dot" aria-hidden="true" />{nameOf(route)}</span>
    <ol class="agent-route-steps" aria-label={t('{0} 的路线', nameOf(route))}>
      {hidden > 0 && <li class="agent-route-step agent-route-more">{t('更早 {0} 步', hidden)}</li>}
      {steps.map((step, index) => {
        const current = live && index === steps.length - 1;
        return <li key={`${step.kind}-${step.at}`} class="agent-route-step" data-kind={step.kind} data-outcome={step.outcome} data-current={current || undefined}
          title={time(step.at)}>
          <span class="agent-route-label">{current ? <Spinner /> : <span class="agent-route-mark" aria-hidden="true" />}{stepLabel(step, tasks)}
            {step.outcome && <span class="agent-route-outcome">{outcomeLabel[step.outcome]}</span>}</span>
        </li>;
      })}
    </ol>
  </li>;
}

function AgentRouteMap(props: AgentRouteProps) {
  const { routes } = props;
  const summary = !routes.length ? (props.running ? t('Agent 开始工作后，这里按时间画出每个 Agent 走过的步骤。') : t('这次运行没有记录 Agent 步骤。'))
    : props.planned ? props.graph === 'elsewhere' ? t('研究计划有 {0} 个任务，依赖关系见「协作」。', props.planned) : t('研究计划有 {0} 个任务，下方显示它们之间的依赖关系。', props.planned)
    : routes.length === 1 ? t('{0} 独自处理整道题，没有拆分任务。', nameOf(routes[0])) : t('{0} 个 Agent 参与，没有拆分任务。', routes.length);
  return <>
    <p class="collab-help agent-route-summary">{summary}</p>
    {routes.length > 0 && <ol class="agent-route-lanes">{routes.map(route => <Lane key={route.workerId} route={route} running={props.running} tasks={props.tasks} time={props.time} />)}</ol>}
    {props.ended && <p class="collab-now-ended">{props.ended}
      <button type="button" class="text-button" data-collab-open-report>{t('查看报告')}</button></p>}
  </>;
}

/** Who did what, in order: one lane per Agent built from the recorded progress events, so a run without a task plan still has a route. */
export function renderAgentRoute(root: HTMLElement, props: AgentRouteProps) {
  render(<AgentRouteMap {...props} />, root);
}
