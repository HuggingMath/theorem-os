import { render } from 'preact';
import { Icon } from './Icon';
import { otherLocale, t } from '../../i18n';
import { classicLibraryUrl } from '../classicLibrary';
import { researchNavigation } from '../../shared';

export type TopbarLive = { label: string; detail: string; tone: string; count: number };
export type TopbarProps = {
  model: string;
  /** Desktop docks the history beside the run; narrow screens open it as a dialog. */ history: { docked: boolean; expanded: boolean };
  connection: { tone: 'ready' | 'offline'; label: string }; settingsDisabled: boolean;
  live?: TopbarLive; mac: boolean; account?: string;
  libraryHref?: string;
  onHistory(): void; onHome(): void; onDraft(): void; onSettings(): void; onPalette(): void; onLive(): void; onAccount(): void; onGlossary(): void; onLocale(): void;
};

function Topbar(props: TopbarProps) {
  const { live } = props;
  const parameters = new URLSearchParams(location.search);
  const linkedChat = new URL(props.libraryHref ?? 'library.html', location.href).searchParams.get('workbenchChat');
  if (linkedChat) parameters.set('workbenchChat', linkedChat);
  const navigation = researchNavigation(parameters.toString(), 'workbench');
  const links = [
    { href: navigation.workbench, label: t('工作台'), current: true },
    { href: navigation.workspace, label: t('我的研究') },
    { href: navigation.theorems, label: t('定理') },
    { href: navigation.people, label: t('数学家') },
    { href: navigation.library, label: 'Library', library: true },
  ];
  return <>
    {props.history.docked
      ? <button type="button" id="open-history" class="icon-button" aria-controls="history-sidebar" aria-expanded={props.history.expanded}
        aria-label={props.history.expanded ? t('收起研究记录') : t('展开研究记录')} title={props.history.expanded ? t('收起研究记录') : t('展开研究记录')} onClick={props.onHistory}><Icon name="panel-left" /></button>
      : <button type="button" id="open-history" class="icon-button" aria-haspopup="dialog" aria-label={t('打开研究记录')} title={t('研究记录')} onClick={props.onHistory}><Icon name="panel-left" /></button>}
    <a id="workbench-home" class="brand" href="./" aria-label={t('回到首页')} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); props.onHome();
    }}><img src="assets/mark.svg" alt="" width="26" height="26" /><span>Theorem<span class="brand-os">OS</span></span></a>
    <button type="button" id="topbar-draft" class="icon-button" aria-label={t('新对话')} title={t('新对话')} onClick={props.onDraft}><Icon name="square-pen" /></button>
    {live && <button type="button" class="live-pill" data-tone={live.tone} onClick={props.onLive} title={`${live.label} · ${live.detail}`} aria-label={t('查看进行中的研究：{0}', live.label)}>
      <span class="live-pill-dot" aria-hidden="true" /><span class="live-pill-label">{live.label}</span>
      <span class="live-pill-detail mono">{live.detail}</span>
    </button>}
    <div class="topbar-actions">
      <nav class="research-space-links" aria-label={t('研究空间')}>{links.map(link => <a key={link.href} href={link.href}
        aria-current={link.current ? 'page' : undefined} data-workbench-library={link.library || undefined}>{link.label}</a>)}</nav>
      <details class="research-mobile-navigation" data-research-mobile-navigation>
        <summary class="research-mobile-navigation-toggle" aria-label={t('研究空间')} title={t('研究空间')}><Icon name="list" /><span class="sr-only">{t('研究空间')}</span></summary>
        <nav class="research-mobile-links" aria-label={t('研究空间')}>{links.map(link => <a key={link.href} href={link.href}
          aria-current={link.current ? 'page' : undefined} data-research-mobile-link={link.library ? 'library' : link.current ? 'workbench' : link.href.startsWith('theorems') ? 'theorems' : link.href.startsWith('workspace') ? 'workspace' : 'people'}>{link.label}</a>)}</nav>
      </details>
      <a id="open-classics" class="classics-link" href={classicLibraryUrl} target="_blank" rel="noopener" title={t('经典题库')} aria-label={t('经典题库')}><Icon name="book-open" /><span>{t('经典题库')}</span></a>
      <button type="button" class="palette-trigger icon-button" onClick={props.onPalette} aria-label={t('打开命令面板')} title={`${t('打开命令面板')} (${props.mac ? '⌘K' : 'Ctrl K'})`}
        aria-haspopup="dialog" aria-keyshortcuts={props.mac ? 'Meta+K' : 'Control+K'}><Icon name="search" /></button>
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
