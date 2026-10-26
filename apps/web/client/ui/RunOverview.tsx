import { render } from 'preact';
import { useRef } from 'preact/hooks';
import { Icon, Spinner } from './Icon';
import { TermHint } from './TermHint';

export type OverviewStep = { label: string; state: string; stateLabel: string; clock: string; share: number };
export type OverviewEvent = { sequence: number; at: string; time: string; type: string; message: string };
export type OverviewAgent = { id: string; state: string; phase: string; task?: string };
export type RunOverviewProps = {
  runId: string; active: boolean; tone: string; symbol: string; title: string; description: string; phaseLabel: string;
  elapsed: string; solving: string; budget: string; budgetUsed: number; steps: OverviewStep[];
  downloads: { proof: boolean; report: boolean };
  task: string; facts: { label: string; value: string; mono: boolean }[];
  agents: OverviewAgent[]; events: OverviewEvent[]; eventCount: number;
};

function Marker({ step, index }: { step: OverviewStep; index: number }) {
  return <span class="step-marker" aria-hidden="true">
    {step.state === 'done' ? <Icon name="check" /> : step.state === 'active' ? <Spinner /> : step.state === 'error' ? <Icon name="x" /> : String(index + 1).padStart(2, '0')}
  </span>;
}

// Only events that arrive while this overview is mounted get the entrance highlight. The class stays
// until the next batch so clock re-renders do not cut the animation short.
function useFreshEvents(runId: string, events: OverviewEvent[]) {
  const seen = useRef<{ runId: string; latest: number; above: number }>();
  const latest = events[0]?.sequence ?? 0;
  if (seen.current?.runId !== runId) seen.current = { runId, latest, above: latest };
  else if (seen.current.latest !== latest) seen.current = { runId, latest, above: seen.current.latest };
  const above = seen.current.above;
  return (sequence: number) => sequence > above;
}

function RunOverview(props: RunOverviewProps) {
  const fresh = useFreshEvents(props.runId, props.events);
  const budgetTone = props.budgetUsed >= 1 ? 'over' : props.budgetUsed >= .8 ? 'warning' : '';
  return <>
    {props.active
      ? <div class={`result-banner live-banner ${props.tone}`}><span class="live-banner-dot" aria-hidden="true" /><div><h3>{props.title}</h3><p>{props.description}</p></div></div>
      : <div class={`result-banner ${props.tone}`}><Icon name={props.symbol} /><div><h3>{props.title}</h3><p>{props.description}</p></div></div>}
    <section class="run-progress" aria-label="运行进度">
      <div class="progress-summary"><div><span class="progress-caption">运行进度</span><h3>{props.phaseLabel}</h3></div>
        <div class="elapsed-summary"><span>总用时</span><strong class="mono" data-total-clock>{props.elapsed}</strong></div></div>
      <ol class="progress-steps">{props.steps.map((step, index) =>
        <li key={step.label} class={`progress-step ${step.state}`} aria-current={step.state === 'active' ? 'step' : undefined}>
          <Marker step={step} index={index} /><span class="step-label">{step.label}{step.label === '独立验收' && <TermHint id="acceptance" />}</span><span class="step-state">{step.stateLabel}</span>
          <span class="step-duration mono" data-stage-clock={index}>{step.clock}</span>
          <span class="step-share" aria-hidden="true"><i style={{ width: `${Math.round(step.share * 100)}%` }} /></span>
        </li>)}</ol>
      <div class={`progress-budget ${budgetTone}`}>
        <div class="budget-meter" role="meter" aria-label="研究用时占解题预算" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(props.budgetUsed * 100))}>
          <i style={{ width: `${Math.min(100, props.budgetUsed * 100)}%` }} /></div>
        <Icon name="clock-3" /><span>解题预算 <strong class="mono">{props.budget}</strong></span><span>研究用时 <strong class="mono" data-solving-clock>{props.solving}</strong></span>
      </div>
    </section>
    {(props.downloads.proof || props.downloads.report) && <div class="result-toolbar">
      {props.downloads.proof && <button type="button" class="button" data-action="download-proof"><Icon name="file-code-2" />下载 Lean</button>}
      {props.downloads.report && <button type="button" class="button" data-action="download-report"><Icon name="file-json-2" />下载报告</button>}
    </div>}
    <div class="overview-live">
      <section class="overview-section overview-feed">
        <div class="overview-section-heading"><h3>最近活动 <span class="field-count">{props.eventCount}</span></h3>
          {props.eventCount > 0 && <button type="button" class="text-button" data-action="show-events">全部活动<Icon name="arrow-up-right" /></button>}</div>
        {props.events.length ? <ol class="overview-events">{props.events.map(event =>
          <li key={event.sequence} class={fresh(event.sequence) ? 'fresh' : undefined}>
            <time dateTime={event.at} title={event.at}>{event.time}</time><span class="overview-event-type mono">{event.type}</span><span class="overview-event-text">{event.message}</span>
          </li>)}</ol> : <p class="task-content">暂无活动记录</p>}
      </section>
      {props.agents.length > 0 && <section class="overview-section overview-agents">
        <div class="overview-section-heading"><h3>Agent <span class="field-count">{props.agents.length}</span></h3>
          <button type="button" class="text-button" data-action="show-agents">研究协作<Icon name="arrow-up-right" /></button></div>
        <ul>{props.agents.map(agent => <li key={agent.id} data-agent-state={agent.state}>
          <span class="overview-agent-dot" aria-hidden="true" /><strong class="mono">{agent.id}</strong><span>{agent.phase}</span>
          <span class="overview-agent-task mono">{agent.task ?? '未分配'}</span></li>)}</ul>
      </section>}
    </div>
    <div class="overview-section"><h3>研究任务</h3><p class="task-content">{props.task}</p></div>
    <div class="overview-section"><div class="term-heading"><h3>执行配置</h3><TermHint id="budget" /></div><dl class="facts">{props.facts.map(fact =>
      <div key={fact.label}><dt>{fact.label}</dt><dd class={fact.mono ? 'mono' : undefined}>{fact.value}</dd></div>)}</dl></div>
  </>;
}

export function renderRunOverview(root: HTMLElement, props: RunOverviewProps) {
  render(<RunOverview {...props} />, root);
}
export function unmountRunOverview(root: ParentNode) {
  const host = root.querySelector<HTMLElement>('.overview-workspace');
  if (host) render(null, host);
}
