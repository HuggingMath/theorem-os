import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { animateEntrance } from '../motion';
import { Icon, Spinner } from './Icon';

export type HeaderStage = { label: string; state: 'done' | 'active' | 'stopped' | 'error' | 'pending' | 'skipped'; clock: string };
export type RunHeaderProps = {
  title: string; id: string; environment: string; updated: string; error: string;
  status: { key: string; label: string; tone: string; symbol: string };
  stages: HeaderStage[]; elapsed: string; tabs: readonly (readonly [string, string])[]; tab: string;
  active: boolean; cancelling: boolean; deleting: boolean; connected: boolean; download?: string;
};

function StatusBadge({ status }: { status: RunHeaderProps['status'] }) {
  const ref = useRef<HTMLSpanElement>(null), shown = useRef(status.key);
  useEffect(() => {
    if (shown.current === status.key) return;
    shown.current = status.key;
    animateEntrance(ref.current!, 'status');
  }, [status.key]);
  return <span ref={ref} class={`badge ${status.tone}`} data-status={status.key}><Icon name={status.symbol} />{status.label}</span>;
}

const stageSymbol = { done: 'check', error: 'x', active: '', stopped: 'square', pending: '', skipped: '' } as const;
function StageTrack({ stages, elapsed }: { stages: HeaderStage[]; elapsed: string }) {
  return <section class="artifact-progress" aria-label="实时运行进度">
    <ol class="artifact-stages">{stages.map(stage => <li key={stage.label} class={stage.state} data-stage={stage.state} aria-current={stage.state === 'active' ? 'step' : undefined}>
      <span class="stage-marker" aria-hidden="true">{stageSymbol[stage.state] && <Icon name={stageSymbol[stage.state]} />}</span>
      <span class="stage-copy"><span class="stage-label">{stage.label}</span><span class="stage-clock mono">{stage.clock}</span></span>
    </li>)}</ol>
    <span class="artifact-elapsed"><span>总用时</span><span class="mono" data-header-clock title="总用时">{elapsed}</span></span>
  </section>;
}

function Tabs({ tabs, tab }: { tabs: RunHeaderProps['tabs']; tab: string }) {
  const list = useRef<HTMLDivElement>(null), bar = useRef<HTMLSpanElement>(null), placed = useRef(false);
  useLayoutEffect(() => {
    const root = list.current!, indicator = bar.current!;
    const place = () => {
      const selected = root.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!selected?.offsetWidth) return;
      indicator.style.width = `${selected.offsetWidth}px`;
      indicator.style.transform = `translateX(${selected.offsetLeft}px)`;
      // The first measurement only positions the indicator; later tab changes slide it.
      if (!placed.current) requestAnimationFrame(() => { indicator.dataset.ready = 'true'; });
      placed.current = true;
      // Scroll only the tab strip; scrollIntoView would also move the surrounding panes.
      if (selected.offsetLeft < root.scrollLeft) root.scrollLeft = selected.offsetLeft;
      else if (selected.offsetLeft + selected.offsetWidth > root.scrollLeft + root.clientWidth) root.scrollLeft = selected.offsetLeft + selected.offsetWidth - root.clientWidth;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(root);
    return () => observer.disconnect();
  }, [tab]);
  return <div ref={list} class="detail-tabs" role="tablist" aria-label="运行详情视图">
    {tabs.map(([id, label]) => <button key={id} type="button" role="tab" id={`detail-tab-${id}`} data-detail-tab={id} aria-controls="detail-panel"
      aria-selected={id === tab} tabIndex={id === tab ? 0 : -1}>{label}</button>)}
    <span ref={bar} class="detail-tab-indicator" aria-hidden="true" />
  </div>;
}

function Actions(props: RunHeaderProps) {
  return <div class="detail-actions">
    <button type="button" class="icon-button" data-action="reuse-run" aria-label="复用任务配置" title="复用任务配置"><Icon name="copy-plus" /></button>
    {props.active
      ? <button key="cancel" type="button" class="button button-danger" data-action="cancel" disabled={props.cancelling || !props.connected}>
        {props.cancelling ? <Spinner /> : <Icon name="square" />}{props.cancelling ? '正在取消' : '取消运行'}</button>
      : <button key="delete" type="button" class="icon-button danger" data-action="delete-run" aria-label="删除运行记录" title="删除运行记录"
        disabled={!props.connected || props.deleting}><Icon name="trash-2" /></button>}
    {props.download && <a class="icon-button" href={props.download} download title="下载运行档案 JSON" aria-label="下载运行档案 JSON"><Icon name="download" /></a>}
  </div>;
}

function RunHeader(props: RunHeaderProps) {
  return <>
    <header class="detail-heading">
      <div class="detail-heading-text">
        <h2>{props.title}</h2>
        <div class="detail-statusline">
          <StatusBadge status={props.status} />
          <span class="detail-identifier"><code>{props.id}</code>
            <button type="button" class="icon-button" data-action="copy-id" aria-label="复制运行 ID" title="复制运行 ID"><Icon name="copy" /></button></span>
          <span class="run-environment">{props.environment}</span><span class="updated-at">{props.updated}</span>
        </div>
      </div>
      <Actions {...props} />
    </header>
    <StageTrack stages={props.stages} elapsed={props.elapsed} />
    <div class="inline-error" data-detail-error role="alert" hidden={!props.error}>{props.error}</div>
    <Tabs tabs={props.tabs} tab={props.tab} />
  </>;
}

export function renderRunHeader(root: HTMLElement, props: RunHeaderProps) { render(<RunHeader {...props} />, root); }
export function unmountRunHeader(root: HTMLElement) { render(null, root); }
