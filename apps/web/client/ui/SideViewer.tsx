import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { Icon } from './Icon';
import { revealViewer } from '../motion';
import { t } from '../../i18n';

/** Below this width of its host the viewer covers the screen; at or above it, it is a column beside the host's content. */
export const sideViewerWidth = 940;
export type ViewerMode = { id: string; label: string; current: boolean; select: () => void };
export type SideViewerProps = {
  id: string; title: ComponentChildren; subtitle?: string; modes?: ViewerMode[]; actions?: ComponentChildren;
  /** Restores focus to the control that opened the viewer. */ focusKey: string;
  onClose: () => void; children: ComponentChildren;
};

/**
 * Code, a comparison or Lean's feedback next to what it belongs to: a sticky column of the nearest [data-viewer-host]
 * when that is wide enough, else a full-screen dialog. One dialog element serves both, opened with show() or
 * showModal(); as a dialog the browser gives it Esc, the backdrop and the focus trap, as a column Esc in the host closes it.
 */
export function SideViewer(props: SideViewerProps) {
  const ref = useRef<HTMLDialogElement>(null), close = useRef(props.onClose);
  close.current = props.onClose;
  useLayoutEffect(() => {
    const dialog = ref.current!, host = dialog.closest<HTMLElement>('[data-viewer-host]') ?? dialog.parentElement!;
    const scroller = host.closest<HTMLElement>('.detail-panel');
    const place = () => {
      if (!dialog.isConnected) return;
      const side = host.clientWidth >= sideViewerWidth;
      if (dialog.open && dialog.matches(':modal') === side) dialog.close();
      if (!dialog.open) { if (side) dialog.show(); else dialog.showModal(); }
      // A column is as tall as the scrolling panel it sits in, less that panel's own padding.
      if (side && scroller) {
        const style = getComputedStyle(scroller);
        dialog.style.setProperty('--viewer-height', `${scroller.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)}px`);
      }
    };
    place();
    // Only opening moves it; switching between a column and a dialog as the host resizes does not.
    if (dialog.open) {
      const modal = dialog.matches(':modal');
      if (!modal) dialog.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      revealViewer(dialog, modal);
    }
    const observer = new ResizeObserver(place);
    observer.observe(host);
    if (scroller) observer.observe(scroller);
    const cancel = (event: Event) => { event.preventDefault(); close.current(); };
    // Beside the content, focus may be on the opener or anywhere in the host; Esc there closes the column too.
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && dialog.open && !dialog.matches(':modal')) { event.preventDefault(); close.current(); }
    };
    dialog.addEventListener('cancel', cancel);
    host.addEventListener('keydown', escape);
    return () => {
      observer.disconnect();
      dialog.removeEventListener('cancel', cancel);
      host.removeEventListener('keydown', escape);
      if (dialog.open) dialog.close();
    };
  }, []);
  const heading = `${props.id}-heading`;
  return <dialog ref={ref} id={props.id} class="side-viewer" aria-labelledby={heading}>
    <header class="side-viewer-heading">
      <div class="side-viewer-title"><h4 id={heading}>{props.title}</h4>{props.subtitle && <p>{props.subtitle}</p>}</div>
      {props.actions}
      <button type="button" class="icon-button" data-focus-key={`${props.focusKey}-close`} aria-label={t('关闭')} title={t('关闭（Esc）')}
        onClick={() => props.onClose()}><Icon name="x" /></button>
    </header>
    {props.modes && props.modes.length > 1 && <div class="source-switch side-viewer-modes" role="group" aria-label={t('查看内容')}>
      {props.modes.map(mode => <button key={mode.id} type="button" aria-pressed={mode.current} data-viewer-mode={mode.id}
        data-focus-key={`${props.focusKey}-viewer-${mode.id}`} onClick={mode.select}>{mode.label}</button>)}</div>}
    <div class="side-viewer-body">{props.children}</div>
  </dialog>;
}
