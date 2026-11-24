import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon';
import { locale, otherLocale, t } from '../../i18n';
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
const tx = (zh: string, en: string) => locale === 'en' ? en : zh;

function Topbar(props: TopbarProps) {
  const { live } = props;
  const menu = useRef<HTMLDetailsElement>(null), [open, setOpen] = useState(false);
  const close = (focus = false) => {
    setOpen(false);
    if (menu.current) menu.current.open = false;
    if (focus) menu.current?.querySelector('summary')?.focus({ preventScroll: true });
  };
  const choose = (action: () => void) => { close(true); action(); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const parameters = new URLSearchParams(location.search);
  const linkedChat = new URL(props.libraryHref ?? 'library.html', location.href).searchParams.get('workbenchChat');
  if (linkedChat) parameters.set('workbenchChat', linkedChat);
  const navigation = researchNavigation(parameters.toString(), 'workbench');
  const links = [
    { href: navigation.workspace, label: t('我的研究') },
    { href: navigation.theorems, label: t('定理') },
    { href: navigation.people, label: t('数学家') },
    { href: navigation.library, label: t('数学库'), library: true },
  ];
  return <>
    <a id="workbench-home" class="brand" href={navigation.workbench} aria-label={t('回到首页')} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); props.onHome();
    }}><img src="assets/mark.svg" alt="" width="26" height="26" /><span>Theorem<span class="brand-os">OS</span></span></a>
    <nav class="topbar-primary" aria-label={tx('题目', 'Problems')}>
      <button type="button" id="topbar-draft" class="topbar-control topbar-new" aria-label={tx('新建题目', 'New problem')} onClick={props.onDraft}><Icon name="square-pen" /><span>{tx('新建', 'New')}</span></button>
      {props.history.docked
        ? <button type="button" id="open-history" class="topbar-control" aria-controls="history-sidebar" aria-expanded={props.history.expanded}
          aria-label={props.history.expanded ? t('收起研究记录') : t('展开研究记录')} title={t('研究记录')} onClick={props.onHistory}><Icon name="panel-left" /><span>{tx('历史', 'History')}</span></button>
        : <button type="button" id="open-history" class="topbar-control" aria-haspopup="dialog" aria-label={t('打开研究记录')} title={t('研究记录')} onClick={props.onHistory}><Icon name="panel-left" /><span>{tx('历史', 'History')}</span></button>}
    </nav>
    <div class="topbar-statuses" hidden={!live && props.connection.tone === 'ready'}>
      {live && <button type="button" class="live-pill" data-tone={live.tone} onClick={props.onLive} title={[live.label, live.detail].filter(Boolean).join(' · ')} aria-label={t('查看进行中的研究：{0}', live.label)}>
        <span class="live-pill-dot" aria-hidden="true" /><span class="live-pill-label">{live.label}</span>
        <span class="live-pill-detail mono">{live.detail}</span>
      </button>}
      <span id="connection-status" class={`connection-status ${props.connection.tone}`} hidden={props.connection.tone === 'ready'} role="status" title={props.connection.label}><span class="status-dot" />{props.connection.label}</span>
    </div>
    <button type="button" class="topbar-control topbar-command" onClick={props.onPalette} title={`${t('打开命令面板')} (${props.mac ? '⌘K' : 'Ctrl K'})`}
      aria-haspopup="dialog" aria-keyshortcuts={props.mac ? 'Meta+K' : 'Control+K'}><Icon name="search" /><span>{tx('搜索', 'Search')}</span><kbd aria-hidden="true">{props.mac ? '⌘K' : 'Ctrl K'}</kbd></button>
    <details class="navigation-menu" data-navigation-menu ref={menu} open={open}
      onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      onFocusOut={event => { if (!menu.current?.contains(event.relatedTarget as Node)) close(); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } }}>
      <summary data-navigation-toggle aria-controls="workbench-navigation-panel"><Icon name="ellipsis" /><span>{tx('菜单', 'Menu')}</span></summary>
      <div id="workbench-navigation-panel" class="navigation-panel" data-navigation-panel>
        <nav class="navigation-links research-space-links" aria-label={t('研究空间')} onClick={() => close()}>{links.map(link => <a key={link.href} href={link.href} data-workbench-library={link.library || undefined}>{link.label}</a>)}
          <a id="open-classics" href={classicLibraryUrl} target="_blank" rel="noopener">{t('经典题库')} <Icon name="arrow-up-right" /></a>
        </nav>
        <div class="navigation-actions">
          <button type="button" class="palette-trigger navigation-item" onClick={() => choose(props.onPalette)} aria-label={t('打开命令面板')} title={`${t('打开命令面板')} (${props.mac ? '⌘K' : 'Ctrl K'})`}
            aria-haspopup="dialog" aria-keyshortcuts={props.mac ? 'Meta+K' : 'Control+K'}><Icon name="search" /><span>{tx('搜索与快捷操作', 'Search and commands')}</span><kbd>{props.mac ? '⌘K' : 'Ctrl K'}</kbd></button>
          <button type="button" id="open-settings" class="navigation-item" title={t('研究配置')} aria-haspopup="dialog" disabled={props.settingsDisabled} onClick={() => choose(props.onSettings)}>
            <Icon name="sliders-horizontal" /><span>{t('研究配置')}<small id="current-model">{props.model}</small></span>
          </button>
          <button type="button" id="open-glossary" class="navigation-item" title={t('术语说明')} aria-haspopup="dialog" onClick={() => choose(props.onGlossary)}><Icon name="circle-help" /><span>{t('术语说明')}</span></button>
          <button type="button" id="locale-switch" class="navigation-item locale-switch" lang={otherLocale.lang} translate={false} title={otherLocale.title} onClick={() => choose(props.onLocale)}>
            <Icon name="languages" /><span>{otherLocale.label}</span>
          </button>
          {props.account && <button type="button" id="open-account" class="navigation-item" title={props.account} aria-label={t('账号：{0}', props.account)} aria-haspopup="dialog" onClick={() => choose(props.onAccount)}>
            <Icon name="user-round" /><span>{tx('账号', 'Account')}<small>{props.account}</small></span>
          </button>}
        </div>
      </div>
    </details>
  </>;
}

export function renderTopbar(root: HTMLElement, props: TopbarProps) { render(<Topbar {...props} />, root); }
