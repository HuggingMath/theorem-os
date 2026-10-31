import { render } from 'preact';
import { Icon } from './Icon';
import { otherLocale, t } from '../../i18n';
import { siteHome } from '../feedback';

export type TopbarLive = { label: string; detail: string; tone: string; count: number };
export type TopbarProps = {
  model: string;
  /** Desktop docks the history beside the run; narrow screens open it as a dialog. */ history: { docked: boolean; expanded: boolean };
  connection: { tone: 'ready' | 'offline'; label: string }; settingsDisabled: boolean;
  live?: TopbarLive; mac: boolean; account?: string;
  onHistory(): void; onDraft(): void; onSettings(): void; onPalette(): void; onLive(): void; onAccount(): void; onGlossary(): void; onLocale(): void;
};

function Topbar(props: TopbarProps) {
  const { live } = props;
  return <>
    {props.history.docked
      ? <button type="button" id="open-history" class="icon-button" aria-controls="history-sidebar" aria-expanded={props.history.expanded}
        aria-label={props.history.expanded ? t('收起研究记录') : t('展开研究记录')} title={props.history.expanded ? t('收起研究记录') : t('展开研究记录')} onClick={props.onHistory}><Icon name="panel-left" /></button>
      : <button type="button" id="open-history" class="icon-button" aria-haspopup="dialog" aria-label={t('打开研究记录')} title={t('研究记录')} onClick={props.onHistory}><Icon name="panel-left" /></button>}
    {/* The collapsed sidebar hides its own 新建研究 button, so the bar keeps one. */}
    {props.history.docked && !props.history.expanded && <button type="button" id="topbar-draft" class="icon-button" aria-label={t('新建研究')} title={t('新建研究')} onClick={props.onDraft}><Icon name="square-pen" /></button>}
    <a class="brand" href={siteHome} aria-label={t('TheoremOS 官网')}><img src="assets/mark.svg" alt="" width="26" height="26" /><span>Theorem<span class="brand-os">OS</span></span></a>
    {live && <button type="button" class="live-pill" data-tone={live.tone} onClick={props.onLive} title={`${live.label} · ${live.detail}`} aria-label={t('查看进行中的研究：{0}', live.label)}>
      <span class="live-pill-dot" aria-hidden="true" /><span class="live-pill-label">{live.label}</span>
      <span class="live-pill-detail mono">{live.detail}</span>
    </button>}
    <div class="topbar-actions">
      <button type="button" class="palette-trigger" onClick={props.onPalette} aria-label={t('打开命令面板')} aria-haspopup="dialog" aria-keyshortcuts={props.mac ? 'Meta+K' : 'Control+K'}>
        <Icon name="search" /><span>{t('跳转或执行')}</span><kbd>{props.mac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <button type="button" id="open-settings" class="model-menu" title={t('研究配置')} aria-haspopup="dialog" disabled={props.settingsDisabled} onClick={props.onSettings}>
        <Icon name="sliders-horizontal" /><span id="current-model">{props.model}</span><Icon name="chevron-down" />
      </button>
      <button type="button" id="open-glossary" class="icon-button" title={t('术语说明')} aria-label={t('术语说明')} aria-haspopup="dialog" onClick={props.onGlossary}><Icon name="circle-help" /></button>
      <button type="button" id="locale-switch" class="locale-switch topbar-locale" lang={otherLocale.lang} translate={false} title={otherLocale.title} onClick={props.onLocale}>
        <Icon name="languages" /><span class="locale-switch-label">{otherLocale.label}</span>
      </button>
      <span id="connection-status" class={`connection-status ${props.connection.tone}`} role="status" title={props.connection.label}><span class="status-dot" />{props.connection.label}</span>
      {props.account && <button type="button" id="open-account" class="account-trigger" title={props.account} aria-label={t('账号：{0}', props.account)} aria-haspopup="dialog" onClick={props.onAccount}>
        <Icon name="user-round" /><span>{props.account}</span>
      </button>}
    </div>
  </>;
}

export function renderTopbar(root: HTMLElement, props: TopbarProps) { render(<Topbar {...props} />, root); }
