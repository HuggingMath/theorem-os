import { render } from 'preact';
import { Icon } from './Icon';

export type TopbarLive = { label: string; detail: string; tone: string; count: number };
export type TopbarProps = {
  title: string; model: string; connection: { tone: 'ready' | 'offline'; label: string }; settingsDisabled: boolean;
  live?: TopbarLive; mac: boolean; account?: string;
  onHistory(): void; onSettings(): void; onPalette(): void; onLive(): void; onAccount(): void;
};

function Topbar(props: TopbarProps) {
  const { live } = props;
  return <>
    <button type="button" id="open-history" class="icon-button" aria-label="打开研究记录" title="研究记录" onClick={props.onHistory}><Icon name="panel-left" /></button>
    <a class="brand" href="https://likc1606.github.io/theorem-os/" aria-label="TheoremOS 官网"><img src="assets/mark.svg" alt="" width="26" height="26" /><span>Theorem<span class="brand-os">OS</span></span></a>
    <span class="topbar-divider" aria-hidden="true" />
    <span id="workspace-title" class="workspace-name">{props.title}</span>
    {live && <button type="button" class="live-pill" data-tone={live.tone} onClick={props.onLive} title={`${live.label} · ${live.detail}`} aria-label={`查看进行中的研究：${live.label}`}>
      <span class="live-pill-dot" aria-hidden="true" /><span class="live-pill-label">{live.label}</span>
      <span class="live-pill-detail mono">{live.detail}</span>
    </button>}
    <div class="topbar-actions">
      <button type="button" class="palette-trigger" onClick={props.onPalette} aria-label="打开命令面板" aria-haspopup="dialog" aria-keyshortcuts={props.mac ? 'Meta+K' : 'Control+K'}>
        <Icon name="search" /><span>跳转或执行</span><kbd>{props.mac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <button type="button" id="open-settings" class="model-menu" title="研究配置" aria-haspopup="dialog" disabled={props.settingsDisabled} onClick={props.onSettings}>
        <Icon name="sliders-horizontal" /><span id="current-model">{props.model}</span><Icon name="chevron-down" />
      </button>
      <span id="connection-status" class={`connection-status ${props.connection.tone}`} role="status"><span class="status-dot" />{props.connection.label}</span>
      {props.account && <button type="button" id="open-account" class="account-trigger" title={props.account} aria-label={`账号：${props.account}`} aria-haspopup="dialog" onClick={props.onAccount}>
        <Icon name="user-round" /><span>{props.account}</span>
      </button>}
    </div>
  </>;
}

export function renderTopbar(root: HTMLElement, props: TopbarProps) { render(<Topbar {...props} />, root); }
