import { render } from 'preact';

export type Meter = { name: string; segments: { key: string; label: string; count: number }[] };
export type ProgressSummaryProps = {
  proof: { checked: number; total: number; meter: Meter };
  agents: { working: number; total: number; meter: Meter };
  accepted: boolean; completedResearch: number;
};

// Segments stay mounted while their count is non-zero, so width changes animate in place.
function MeterBar({ meter }: { meter: Meter }) {
  const shown = meter.segments.filter(segment => segment.count > 0), total = shown.reduce((sum, segment) => sum + segment.count, 0);
  return <>
    <div class="collab-meter" data-meter={meter.name} aria-hidden="true">
      {shown.map(segment => <span key={segment.key} class={`collab-meter-${segment.key}`} data-count={segment.count} style={{ width: `${(segment.count / total) * 100}%` }} />)}
    </div>
    <ul class="collab-meter-legend">{shown.map(segment => <li key={segment.key} class={`collab-meter-${segment.key}`}>{segment.label} {segment.count}</li>)}</ul>
  </>;
}

function ProgressSummary(props: ProgressSummaryProps) {
  return <div class="collab-metrics">
    <div><span>证明任务</span><strong>{props.proof.checked} / {props.proof.total}</strong><small>已记录检查</small><MeterBar meter={props.proof.meter} /></div>
    <div><span>Agent</span><strong>{props.agents.working} / {props.agents.total}</strong><small>实际工作中</small><MeterBar meter={props.agents.meter} /></div>
    <div><span>最终验收 S3</span><strong class={props.accepted ? 'collab-accepted' : ''}>{props.accepted ? '验收通过' : '尚未验收通过'}</strong>
      <small>以完整报告独立判断</small>{props.completedResearch > 0 && <small>研究任务已完成 {props.completedResearch} 项</small>}</div>
  </div>;
}

/** Without an observation the summary is the page's only status line; `empty` says why. */
export function renderProgressSummary(root: HTMLElement, props: ProgressSummaryProps | { empty: string }) {
  render('empty' in props ? <div class="collab-empty" data-collab-empty>{props.empty}</div> : <ProgressSummary {...props} />, root);
}
