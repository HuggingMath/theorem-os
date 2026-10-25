import { render } from 'preact';
import { Icon, Spinner } from './Icon';

export type MonitorStage = 'done' | 'active' | 'stopped' | 'error' | 'pending' | 'skipped';
export type MonitorItem = {
  id: string; title: string; description: string; tone: string; symbol: string;
  current: boolean; cancelling: boolean; active: boolean; stages: MonitorStage[];
};

// Rows stay keyed by run id: polling must keep their nodes, focus and horizontal scroll.
function MonitorRow({ item }: { item: MonitorItem }) {
  return <div class="run-monitor-entry" data-monitor-id={item.id} data-tone={item.tone} data-active={String(item.active)}>
    <button type="button" class="run-monitor-open" data-monitor-run-id={item.id} aria-current={item.current} title={`${item.title} · ${item.description}`}>
      <span class="run-monitor-icon" aria-hidden="true">{item.cancelling ? <Spinner /> : <Icon name={item.symbol} />}</span>
      <span class="run-monitor-copy"><span class="run-monitor-title">{item.title}</span><span class="run-monitor-state">{item.description}</span></span>
      <span class="run-monitor-stages" aria-hidden="true">{item.stages.map((stage, index) => <i key={index} data-stage={stage} />)}</span>
      <Icon name="arrow-up-right" />
    </button>
    <button type="button" class="icon-button run-monitor-dismiss" data-dismiss-run-notice={item.id} hidden={item.active}
      title={`忽略结束提醒：${item.title}`} aria-label={`忽略结束提醒：${item.title}`}><Icon name="x" /></button>
  </div>;
}

export function renderRunMonitor(list: HTMLElement, items: readonly MonitorItem[]) {
  render(<>{items.map(item => <MonitorRow key={item.id} item={item} />)}</>, list);
}
